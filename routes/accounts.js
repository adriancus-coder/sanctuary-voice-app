// SV-ACCOUNTS-STORE — auth endpoints (login/logout/me/password) + the
// change-password page. Additive: these run alongside the existing PIN flows;
// the guard cutover that removes PINs is a later commit. Also exports
// requireUser / requireRole for that cutover to use.
const path = require('path');
const crypto = require('crypto');
const accounts = require('../lib/accounts');

const SID_COOKIE = 'sv_sid';

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function registerAccountsRoutes(app, ctx) {
  const { db, saveDb, logger, parseCookies, getCookieSecureFlag } = ctx;
  const publicDir = ctx.publicDir || path.join(__dirname, '..', 'public');
  const masterPin = String(ctx.masterAdminPin || '').trim();
  const defaultOrgId = ctx.defaultOrgId;
  const loginLimiter = accounts.createLoginRateLimiter({ maxFailures: 5, windowMs: 15 * 60 * 1000 });
  const pwLimiter = accounts.createLoginRateLimiter({ maxFailures: 5, windowMs: 15 * 60 * 1000 });

  accounts.ensureStore(db);

  function buildSidCookie(req, value, maxAgeMs) {
    const parts = [`${SID_COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
    if (typeof maxAgeMs === 'number') parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`);
    if (getCookieSecureFlag(req)) parts.push('Secure');
    return parts.join('; ');
  }

  function sessionUser(req) {
    const sid = parseCookies(req)[SID_COOKIE];
    return accounts.getSessionUser(db, sid);
  }

  // --- middleware for the later cutover (exported, not yet applied to pages) ---
  function requireUser(req, res, next) {
    const u = sessionUser(req);
    if (!u) return res.status(401).json({ ok: false, code: 'unauthenticated' });
    req.authUser = u;
    next();
  }
  function requireRole(...roles) {
    return (req, res, next) => {
      const u = sessionUser(req);
      if (!u) return res.status(401).json({ ok: false, code: 'unauthenticated' });
      if (!roles.includes(u.role)) return res.status(403).json({ ok: false, code: 'forbidden' });
      req.authUser = u;
      next();
    };
  }

  // --- endpoints ---
  app.post('/api/auth/login', (req, res) => {
    const ip = clientIp(req);
    const wait = loginLimiter.blocked(ip);
    if (wait) {
      res.setHeader('Retry-After', String(wait));
      return res.status(429).json({ ok: false, code: 'tooManyAttempts', retryAfter: wait });
    }
    const email = accounts.normalizeEmail(req.body && req.body.email);
    const password = String((req.body && req.body.password) || '');
    const remember = !!(req.body && req.body.remember);
    const user = accounts.findUserByEmail(db, email);
    const ok = user
      ? accounts.verifyPassword(password, user.password_hash)
      : (accounts.verifyPassword(password, accounts.DUMMY_HASH), false);
    if (!ok || !user || user.active === false) {
      loginLimiter.fail(ip);
      return res.status(401).json({ ok: false, code: 'invalidLogin' });
    }
    loginLimiter.reset(ip);
    const { id } = accounts.createSession(db, user.id, remember);
    accounts.touchLogin(db, user.id);
    saveDb();
    res.setHeader(
      'Set-Cookie',
      buildSidCookie(req, id, remember ? accounts.REMEMBER_TTL_MS : accounts.SESSION_TTL_MS)
    );
    res.json({ ok: true, user: accounts.publicUser(user) });
  });

  app.post('/api/auth/logout', (req, res) => {
    const sid = parseCookies(req)[SID_COOKIE];
    if (sid) {
      accounts.deleteSession(db, sid);
      saveDb();
    }
    res.setHeader('Set-Cookie', buildSidCookie(req, '', 0));
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    const u = sessionUser(req);
    if (!u) return res.status(401).json({ ok: false, code: 'unauthenticated' });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, user: accounts.publicUser(u) });
  });

  app.post('/api/me/password', (req, res) => {
    const u = sessionUser(req);
    if (!u) return res.status(401).json({ ok: false, code: 'unauthenticated' });
    const key = `user:${u.id}`;
    const wait = pwLimiter.blocked(key);
    if (wait) {
      res.setHeader('Retry-After', String(wait));
      return res.status(429).json({ ok: false, code: 'tooManyAttempts', retryAfter: wait });
    }
    const current = String((req.body && req.body.current) || '');
    const next = String((req.body && req.body.password) || '');
    if (!accounts.verifyPassword(current, u.password_hash)) {
      pwLimiter.fail(key);
      return res.status(403).json({ ok: false, code: 'wrongPassword' });
    }
    if (!accounts.validatePassword(next)) return res.status(400).json({ ok: false, code: 'tooShort' });
    if (next === current) return res.status(400).json({ ok: false, code: 'samePassword' });
    accounts.setPassword(db, u.id, next);
    pwLimiter.reset(key);
    const sid = parseCookies(req)[SID_COOKIE];
    accounts.deleteUserSessions(db, u.id, sid); // sign out other sessions
    saveDb();
    if (logger) logger.info(`[accounts] password changed for ${u.email}`);
    res.json({ ok: true });
  });

  app.get('/change-password', (req, res) => {
    res.sendFile(path.join(publicDir, 'change-password.html'));
  });

  // --- SV-ACCOUNTS-SETUP — first-owner creation, shown only while there are no
  // users. The setup token IS the existing MASTER_ADMIN_PIN, so no new env var. ---
  app.get('/setup', (req, res) => {
    if (accounts.anyUsers(db)) return res.redirect('/');
    res.sendFile(path.join(publicDir, 'setup.html'));
  });

  app.post('/api/setup', (req, res) => {
    if (accounts.anyUsers(db)) return res.status(409).json({ ok: false, code: 'setupDone' });
    if (!masterPin) return res.status(403).json({ ok: false, code: 'setupDisabled' });
    const token = String((req.body && req.body.setupToken) || '').trim();
    if (!safeEqual(token, masterPin)) return res.status(403).json({ ok: false, code: 'setupBadToken' });
    const churchName = String((req.body && req.body.churchName) || '').trim();
    const ownerName = String((req.body && req.body.ownerName) || '').trim();
    const email = accounts.normalizeEmail(req.body && req.body.email);
    const password = String((req.body && req.body.password) || '');
    let owner;
    try {
      owner = accounts.createUser(db, { email, name: ownerName, password, role: 'owner' });
    } catch (err) {
      return res.status(400).json({ ok: false, code: err.code || 'invalid' });
    }
    if (churchName && defaultOrgId && db.organizations && db.organizations[defaultOrgId]) {
      db.organizations[defaultOrgId].name = churchName.slice(0, 120);
    }
    db.accountsSetupAt = new Date().toISOString();
    const { id } = accounts.createSession(db, owner.id, false);
    accounts.touchLogin(db, owner.id);
    saveDb();
    if (logger) logger.info(`[accounts] setup complete; owner ${owner.email} created`);
    res.setHeader('Set-Cookie', buildSidCookie(req, id, accounts.SESSION_TTL_MS));
    res.json({ ok: true, user: accounts.publicUser(owner) });
  });

  return { requireUser, requireRole, sessionUser, SID_COOKIE };
}

module.exports = { registerAccountsRoutes };
