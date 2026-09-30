const loginAttempts = new Map();
const LOGIN_RATE_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_RATE_MAX = 15;

function getClientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress
    || 'unknown';
}

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.windowStart >= LOGIN_RATE_WINDOW_MS) {
    loginAttempts.set(ip, { windowStart: now, count: 1 });
    return { allowed: true };
  }
  entry.count += 1;
  if (entry.count > LOGIN_RATE_MAX) {
    return {
      allowed: false,
      retryAfter: Math.ceil((entry.windowStart + LOGIN_RATE_WINDOW_MS - now) / 1000)
    };
  }
  return { allowed: true };
}

function registerAdminRoutes(app, ctx) {
  const {
    COMMERCIAL_MODE,
    buildAdminAppUrl,
    clearAdminSessionCookie,
    isAdminLoginConfigured,
    isAllowedAdminPin,
    renderAdminLoginPage,
    sanitizeLocalNextPath,
    setAdminSessionCookie,
    shouldRedirectAdminTrafficToApp,
    accountsExist,
    emergencyPinActive,
    logger
  } = ctx;

  app.post('/api/admin-login', (req, res) => {
    const pin = String(req.body.pin || req.body.code || '').trim();
    const nextPath = sanitizeLocalNextPath(req.body.next || req.query.next || '/admin');
    if (shouldRedirectAdminTrafficToApp(req)) {
      return res.redirect(307, buildAdminAppUrl(`/api/admin-login?next=${encodeURIComponent(nextPath)}`));
    }
    const rateCheck = checkLoginRateLimit(getClientIp(req));
    if (!rateCheck.allowed) {
      res.setHeader('Retry-After', String(rateCheck.retryAfter));
      return res.status(429).send(renderAdminLoginPage({
        error: 'Too many login attempts. Try again later.',
        nextPath
      }));
    }
    if (!isAdminLoginConfigured()) {
      return res.status(500).send(renderAdminLoginPage({
        error: 'Admin PIN is not configured. Add MASTER_ADMIN_PIN in Render Environment first.',
        nextPath
      }));
    }
    if (!isAllowedAdminPin(pin)) {
      return res.status(403).send(renderAdminLoginPage({ error: 'Invalid admin PIN.', nextPath }));
    }
    // SV-ACCOUNTS-GUARDS — once accounts exist, the PIN is an emergency login
    // valid only for 30 days after setup; after that, accounts only.
    if (accountsExist && accountsExist() && emergencyPinActive && !emergencyPinActive()) {
      return res.status(403).send(renderAdminLoginPage({
        error: 'The admin PIN is disabled. Sign in with your account.',
        nextPath
      }));
    }
    if (accountsExist && accountsExist() && logger) {
      logger.warn('[admin-login] MASTER_ADMIN_PIN used during the 30-day emergency window.');
    }
    loginAttempts.delete(getClientIp(req));
    setAdminSessionCookie(req, res);
    return res.redirect(nextPath);
  });

  app.post('/api/admin-logout', (req, res) => {
    clearAdminSessionCookie(req, res);
    res.json({ ok: true, commercialMode: COMMERCIAL_MODE });
  });
}

module.exports = {
  registerAdminRoutes
};
