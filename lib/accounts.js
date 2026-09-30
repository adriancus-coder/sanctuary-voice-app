// SV-ACCOUNTS-STORE — user accounts + sessions in the existing JSON store.
// Ported logic (not code) from worship-app's auth: scrypt password hashing,
// opaque session ids, role model, login rate limiting. Everything here is
// additive: it reads/writes db.users[] and db.authSessions[], which default to
// empty arrays, so an existing sessions.json loads unchanged. Until the guard
// cutover, the PIN flows keep working alongside this.
const crypto = require('crypto');

const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d
const MIN_PASSWORD_LENGTH = 10;
const ROLES = ['owner', 'operator', 'presenter', 'leader', 'member'];
const TEAM_ROLES = ['operator', 'presenter', 'leader', 'member']; // never owner
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A stable dummy hash so unknown-email logins cost the same as real ones.
const DUMMY_HASH = (() => {
  const salt = crypto.randomBytes(SALT_BYTES);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync('x', salt, KEY_LENGTH).toString('hex')}`;
})();

function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.scryptSync(String(password), salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    // Still spend the time, to keep timing uniform.
    crypto.scryptSync(String(password), Buffer.from('00', 'hex'), KEY_LENGTH);
    return false;
  }
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const actual = crypto.scryptSync(String(password), salt, KEY_LENGTH);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function genId() {
  return crypto.randomBytes(16).toString('hex');
}
function genSessionId() {
  return crypto.randomBytes(32).toString('hex');
}
function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}
function validatePassword(password) {
  return typeof password === 'string' && password.length >= MIN_PASSWORD_LENGTH;
}

function ensureStore(db) {
  if (!Array.isArray(db.users)) db.users = [];
  if (!Array.isArray(db.authSessions)) db.authSessions = [];
  return db;
}

function anyUsers(db) {
  ensureStore(db);
  return db.users.length > 0;
}
function hasOwner(db) {
  ensureStore(db);
  return db.users.some((u) => u.role === 'owner');
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    active: u.active !== false,
    mustChangePassword: !!u.must_change_password,
  };
}

function findUserByEmail(db, email) {
  ensureStore(db);
  const e = normalizeEmail(email);
  return db.users.find((u) => u.email === e) || null;
}
function findUserById(db, id) {
  ensureStore(db);
  return db.users.find((u) => u.id === id) || null;
}

// Create a user. Throws { code } on validation problems.
function createUser(db, { email, name, password, role, mustChangePassword = false }) {
  ensureStore(db);
  const e = normalizeEmail(email);
  if (!EMAIL_RE.test(e)) throw Object.assign(new Error('bad email'), { code: 'badEmail' });
  if (!name || !String(name).trim()) throw Object.assign(new Error('name required'), { code: 'badName' });
  if (!ROLES.includes(role)) throw Object.assign(new Error('bad role'), { code: 'badRole' });
  if (!validatePassword(password)) throw Object.assign(new Error('weak password'), { code: 'weakPassword' });
  if (findUserByEmail(db, e)) throw Object.assign(new Error('email exists'), { code: 'emailExists' });
  const now = new Date().toISOString();
  const user = {
    id: genId(),
    email: e,
    name: String(name).trim().slice(0, 100),
    password_hash: hashPassword(password),
    role,
    active: true,
    must_change_password: !!mustChangePassword,
    created_at: now,
    last_login_at: null,
  };
  db.users.push(user);
  return user;
}

function setPassword(db, userId, password) {
  const u = findUserById(db, userId);
  if (!u) return false;
  u.password_hash = hashPassword(password);
  u.must_change_password = false;
  return true;
}

// Sessions ---------------------------------------------------------------
function createSession(db, userId, remember) {
  ensureStore(db);
  const id = genSessionId();
  const expiresAt = Date.now() + (remember ? REMEMBER_TTL_MS : SESSION_TTL_MS);
  db.authSessions.push({ id, user_id: userId, expires_at: expiresAt });
  return { id, expiresAt };
}

function getSessionUser(db, sessionId) {
  ensureStore(db);
  if (!sessionId || !/^[0-9a-f]{64}$/.test(sessionId)) return null;
  const s = db.authSessions.find((x) => x.id === sessionId);
  if (!s) return null;
  if (s.expires_at <= Date.now()) return null;
  const u = findUserById(db, s.user_id);
  if (!u || u.active === false) return null;
  return u;
}

function deleteSession(db, sessionId) {
  ensureStore(db);
  const i = db.authSessions.findIndex((x) => x.id === sessionId);
  if (i >= 0) db.authSessions.splice(i, 1);
}

function deleteUserSessions(db, userId, exceptId) {
  ensureStore(db);
  db.authSessions = db.authSessions.filter((x) => x.user_id !== userId || x.id === exceptId);
}

function deleteExpiredSessions(db) {
  ensureStore(db);
  const now = Date.now();
  const before = db.authSessions.length;
  db.authSessions = db.authSessions.filter((x) => x.expires_at > now);
  return before - db.authSessions.length;
}

function touchLogin(db, userId) {
  const u = findUserById(db, userId);
  if (u) u.last_login_at = new Date().toISOString();
}

// Login rate limiter: N failures per window per key (IP). In-memory.
function createLoginRateLimiter({ maxFailures = 5, windowMs = 15 * 60 * 1000 } = {}) {
  const hits = new Map();
  function prune(now) {
    for (const [k, arr] of hits) {
      const kept = arr.filter((t) => now - t < windowMs);
      if (kept.length) hits.set(k, kept);
      else hits.delete(k);
    }
  }
  return {
    blocked(key) {
      const now = Date.now();
      const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
      hits.set(key, arr);
      if (arr.length >= maxFailures) {
        const retryMs = windowMs - (now - arr[0]);
        return Math.max(1, Math.ceil(retryMs / 1000));
      }
      return 0;
    },
    fail(key) {
      const now = Date.now();
      const arr = hits.get(key) || [];
      arr.push(now);
      hits.set(key, arr);
      prune(now);
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

module.exports = {
  ROLES,
  TEAM_ROLES,
  MIN_PASSWORD_LENGTH,
  SESSION_TTL_MS,
  REMEMBER_TTL_MS,
  DUMMY_HASH,
  hashPassword,
  verifyPassword,
  validatePassword,
  normalizeEmail,
  ensureStore,
  anyUsers,
  hasOwner,
  publicUser,
  createUser,
  setPassword,
  findUserByEmail,
  findUserById,
  createSession,
  getSessionUser,
  deleteSession,
  deleteUserSessions,
  deleteExpiredSessions,
  touchLogin,
  createLoginRateLimiter,
};
