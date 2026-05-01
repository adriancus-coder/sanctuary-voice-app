const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const helmet = require('helmet');
const compression = require('compression');
const webpush = require('web-push');
const { createHmac, randomUUID, timingSafeEqual } = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const OpenAI = require('openai');
const packageJson = require('./package.json');
const { createLogger } = require('./lib/logger');
const { createJsonDbStore } = require('./lib/db');
const { createTranslationService } = require('./lib/translation');
const { registerAdminRoutes } = require('./routes/admin');
const { registerOrgRoutes } = require('./routes/org');
const { registerEventRoutes } = require('./routes/events');
const { registerSocketHandlers } = require('./socket/handlers');
require('dotenv').config();

const logger = createLogger({ logDir: process.env.LOG_DIR || path.join(__dirname, 'logs') });
const app = express();
const server = http.createServer(app);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }
});

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-nano';
const OPENAI_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
const TRANSCRIBE_RATE_LIMIT_WINDOW_MS = Math.max(1000, Number(process.env.TRANSCRIBE_RATE_LIMIT_WINDOW_MS || 60000) || 60000);
const TRANSCRIBE_RATE_LIMIT_MAX = Math.max(1, Number(process.env.TRANSCRIBE_RATE_LIMIT_MAX || 10) || 10);
const SPEECH_PROVIDER = String(process.env.SPEECH_PROVIDER || 'openai').trim().toLowerCase();
const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY || '';
const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION || '';
const MASTER_ADMIN_PIN = String(process.env.MASTER_ADMIN_PIN || process.env.APP_ADMIN_PIN || '').trim();
const MASTER_MODERATOR_PIN = String(process.env.MASTER_MODERATOR_PIN || process.env.APP_MODERATOR_PIN || '').trim();
const MAIN_OPERATOR_PIN = String(process.env.MAIN_OPERATOR_PIN || process.env.MAIN_OPERATOR_CODE || '').trim();
const TRANSLATION_MONITOR_ENABLED = String(process.env.TRANSLATION_MONITOR_ENABLED || '').trim() === '1';
const PUBLIC_BASE_URL = normalizePublicBaseUrl(process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || 'https://sanctuaryvoice.com');
const ADMIN_APP_BASE_URL = normalizePublicBaseUrl(process.env.ADMIN_APP_BASE_URL || process.env.APP_ADMIN_BASE_URL || '');
const ADMIN_APP_HOSTNAMES = String(process.env.ADMIN_APP_HOSTNAMES || 'app.sanctuaryvoice.com,control.sanctuaryvoice.com,kontrol.sanctuaryvoice.com')
  .split(',')
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);
const DEFAULT_ORG_ID = String(process.env.DEFAULT_ORG_ID || process.env.ORGANIZATION_ID || 'sanctuary-voice').trim() || 'sanctuary-voice';
const DEFAULT_ORG_NAME = String(process.env.DEFAULT_ORG_NAME || process.env.ORGANIZATION_NAME || 'Sanctuary Voice').trim() || 'Sanctuary Voice';
const DEFAULT_ORG_PLAN = String(process.env.DEFAULT_ORG_PLAN || 'internal').trim() || 'internal';
const COMMERCIAL_MODE = ['1', 'true', 'yes'].includes(String(process.env.COMMERCIAL_MODE || '').trim().toLowerCase());
const ADMIN_SESSION_COOKIE = 'sv_admin_session';
const ADMIN_SESSION_PERSISTENT = ['1', 'true', 'yes'].includes(String(process.env.ADMIN_SESSION_PERSISTENT || '').trim().toLowerCase());
const ADMIN_SESSION_MAX_AGE_MS = Math.max(1, Number(process.env.ADMIN_SESSION_MAX_AGE_HOURS || 12) || 12) * 60 * 60 * 1000;
const ADMIN_SESSION_SECRET = String(
  process.env.ADMIN_SESSION_SECRET
  || process.env.SESSION_SECRET
  || OPENAI_API_KEY
  || MASTER_ADMIN_PIN
  || 'sanctuary-voice-dev-session'
).trim();
logger.info('API KEY:', OPENAI_API_KEY ? 'OK' : 'LIPSA');
const client = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const translationService = createTranslationService({ client, logger });
const WEB_PUSH_PUBLIC_KEY = String(process.env.WEB_PUSH_PUBLIC_KEY || '').trim();
const WEB_PUSH_PRIVATE_KEY = String(process.env.WEB_PUSH_PRIVATE_KEY || '').trim();
const WEB_PUSH_SUBJECT = String(process.env.WEB_PUSH_SUBJECT || 'mailto:admin@sanctuaryvoice.com').trim();
const WEB_PUSH_ENABLED = !!(WEB_PUSH_PUBLIC_KEY && WEB_PUSH_PRIVATE_KEY);
if (WEB_PUSH_ENABLED) {
  webpush.setVapidDetails(WEB_PUSH_SUBJECT, WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY);
} else {
  logger.warn('WEB PUSH: disabled, missing WEB_PUSH_PUBLIC_KEY or WEB_PUSH_PRIVATE_KEY.');
}
const CORS_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const CORS_ALLOWED_HEADERS = ['Content-Type', 'Authorization', 'X-Requested-With'];
const ALLOWED_CORS_ORIGINS = buildAllowedCorsOrigins();
const transcribeRateLimits = new Map();
const io = new Server(server, {
  cors: {
    origin: socketCorsOriginValidator,
    methods: CORS_METHODS,
    allowedHeaders: CORS_ALLOWED_HEADERS,
    credentials: true
  }
});
app.use(expressCorsMiddleware);
app.use(compression());
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://aka.ms'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: buildHelmetConnectSources(),
      mediaSrc: ["'self'", 'data:', 'blob:'],
      workerSrc: ["'self'"],
      fontSrc: ["'self'", 'data:']
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true }));
app.get('/admin-login', (req, res) => {
  const nextPath = sanitizeLocalNextPath(req.query.next || '/admin');
  if (shouldRedirectAdminTrafficToApp(req)) {
    return res.redirect(buildAdminAppUrl(`/admin-login?next=${encodeURIComponent(nextPath)}`));
  }
  if (hasValidAdminSession(req)) return res.redirect(nextPath);
  const setupError = COMMERCIAL_MODE && !isAdminLoginConfigured()
    ? 'Admin PIN is not configured. Add MASTER_ADMIN_PIN in Render Environment first.'
    : '';
  res.send(renderAdminLoginPage({ error: setupError, nextPath }));
});
registerAdminRoutes(app, {
  COMMERCIAL_MODE,
  buildAdminAppUrl,
  clearAdminSessionCookie,
  isAdminLoginConfigured,
  isAllowedAdminPin,
  renderAdminLoginPage,
  sanitizeLocalNextPath,
  setAdminSessionCookie,
  shouldRedirectAdminTrafficToApp
});
app.use((req, res, next) => {
  if (req.path === '/admin.html') return requireAdminPage(req, res, next);
  return next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res, next) => {
  if (isAdminAppHost(req)) return res.redirect('/admin');
  return sendLandingPage(req, res, next);
});
app.get('/home', sendLandingPage);
app.get('/admin', requireAdminPage, sendAdminPage);
app.get('/admin.html', requireAdminPage, sendAdminPage);
app.get('/participant', requireEventParam, (req, res) => res.sendFile(path.join(__dirname, 'public', 'participant.html')));
app.get('/participant.html', requireEventParam, (req, res) => res.sendFile(path.join(__dirname, 'public', 'participant.html')));
app.get('/live', requireEventParam, (req, res) => res.sendFile(path.join(__dirname, 'public', 'participant.html')));
app.get('/main-screen', requireEventParam, (req, res) => res.sendFile(path.join(__dirname, 'public', 'translate.html')));
app.get('/translate', requireEventParam, (req, res) => res.sendFile(path.join(__dirname, 'public', 'translate.html')));
app.get('/song', requireEventParam, (req, res) => res.sendFile(path.join(__dirname, 'public', 'translate.html')));
app.get('/remote', (req, res) => res.sendFile(path.join(__dirname, 'public', 'remote.html')));
app.get('/demo-screen', (req, res) => res.sendFile(path.join(__dirname, 'public', 'demo-screen.html')));
app.get('/demo-participant', (req, res) => res.sendFile(path.join(__dirname, 'public', 'demo-participant.html')));
app.get('/operator-dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'operator-dashboard.html')));
app.get('/operator-dashboard.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'operator-dashboard.html')));

const DEFAULT_DATA_DIR = process.env.RENDER ? '/var/data' : path.join(__dirname, 'data');
const DATA_DIR = process.env.DATA_DIR || DEFAULT_DATA_DIR;
const DB_FILE = path.join(DATA_DIR, 'sessions.json');
const DB_BACKUP_RETENTION = 7;
const DB_BACKUP_PATTERN = /^sessions\.backup-\d{4}-\d{2}-\d{2}\.json$/;
logger.info('DATA DIR:', DATA_DIR);

const LANGUAGES = {
  ro: 'Romanian',
  no: 'Norwegian',
  ru: 'Russian',
  uk: 'Ukrainian',
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  pl: 'Polish',
  tr: 'Turkish',
  ar: 'Arabic',
  fa: 'Persian',
  hu: 'Hungarian',
  el: 'Greek'
};

const LANGUAGE_NAMES_RO_LEGACY = {
  ro: 'Română',
  no: 'Norvegiană',
  ru: 'Rusă',
  uk: 'Ucraineană',
  en: 'Engleză',
  es: 'Spaniolă',
  fr: 'Franceză',
  de: 'Germană',
  it: 'Italiană',
  pt: 'Portugheză',
  pl: 'Poloneză',
  tr: 'Turcă',
  ar: 'Arabă',
  fa: 'Persană',
  hu: 'Maghiară',
  el: 'Greacă'
};

const LANGUAGE_NAMES_RO = {
  ro: 'Română',
  no: 'Norvegiană',
  ru: 'Rusă',
  uk: 'Ucraineană',
  en: 'Engleză',
  es: 'Spaniolă',
  fr: 'Franceză',
  de: 'Germană',
  it: 'Italiană',
  pt: 'Portugheză',
  pl: 'Poloneză',
  tr: 'Turcă',
  ar: 'Arabă',
  fa: 'Persană',
  hu: 'Maghiară',
  el: 'Greacă'
};

function ensureDataDir() {
  dbStore.ensureDataDir();
}

function sendAdminPage(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
}

function sendLandingPage(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
}

function getRequestHostname(req) {
  return String(req.get('host') || '').split(':')[0].toLowerCase();
}

function getAdminAppHostname() {
  try {
    return ADMIN_APP_BASE_URL ? new URL(ADMIN_APP_BASE_URL).hostname.toLowerCase() : '';
  } catch (err) {
    return '';
  }
}

function isAdminAppHost(req) {
  const host = getRequestHostname(req);
  if (!host) return false;
  const configuredHost = getAdminAppHostname();
  return Boolean((configuredHost && host === configuredHost) || ADMIN_APP_HOSTNAMES.includes(host));
}

function shouldRedirectAdminTrafficToApp(req) {
  if (!ADMIN_APP_BASE_URL) return false;
  const host = getRequestHostname(req);
  if (!host || isLocalRequestHost(host)) return false;
  return !isAdminAppHost(req);
}

function buildAdminAppUrl(pathname = '/admin') {
  const pathPart = String(pathname || '/admin').startsWith('/') ? String(pathname || '/admin') : `/${pathname}`;
  return ADMIN_APP_BASE_URL ? `${ADMIN_APP_BASE_URL}${pathPart}` : pathPart;
}

function normalizeCorsOrigin(value) {
  const base = normalizePublicBaseUrl(value);
  if (!base) return '';
  try {
    return new URL(base).origin;
  } catch (err) {
    return '';
  }
}

function addCorsOrigin(origins, value) {
  const origin = normalizeCorsOrigin(value);
  if (origin) origins.add(origin);
}

function buildAllowedCorsOrigins() {
  const origins = new Set();
  [
    'https://sanctuaryvoice.com',
    'https://app.sanctuaryvoice.com',
    'https://control.sanctuaryvoice.com',
    'https://kontrol.sanctuaryvoice.com',
    'http://localhost:3000',
    PUBLIC_BASE_URL,
    ADMIN_APP_BASE_URL
  ].forEach((origin) => addCorsOrigin(origins, origin));
  return origins;
}

function isAllowedCorsOrigin(origin = '') {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return ALLOWED_CORS_ORIGINS.has(parsed.origin);
  } catch (err) {
    return false;
  }
}

function socketCorsOriginValidator(origin, callback) {
  if (isAllowedCorsOrigin(origin)) return callback(null, true);
  return callback(new Error('Socket origin not allowed'), false);
}

function appendVaryOrigin(res) {
  const current = String(res.getHeader('Vary') || '').trim();
  if (!current) {
    res.setHeader('Vary', 'Origin');
    return;
  }
  const values = current.split(',').map((value) => value.trim().toLowerCase());
  if (!values.includes('origin')) res.setHeader('Vary', `${current}, Origin`);
}

function expressCorsMiddleware(req, res, next) {
  const origin = String(req.headers.origin || '').trim();
  const allowed = isAllowedCorsOrigin(origin);
  if (allowed && origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', CORS_METHODS.join(', '));
    res.setHeader(
      'Access-Control-Allow-Headers',
      String(req.headers['access-control-request-headers'] || CORS_ALLOWED_HEADERS.join(', '))
    );
    appendVaryOrigin(res);
  }
  if (req.method === 'OPTIONS') {
    if (!allowed) return res.status(403).end();
    return res.status(204).end();
  }
  return next();
}

function buildHelmetConnectSources() {
  return [
    "'self'",
    'ws:',
    'wss:',
    PUBLIC_BASE_URL,
    ADMIN_APP_BASE_URL,
    'http://localhost:*',
    'https://localhost:*',
    'ws://localhost:*',
    'wss://localhost:*',
    'http://127.0.0.1:*',
    'ws://127.0.0.1:*',
    'https://*.cognitive.microsoft.com',
    'wss://*.stt.speech.microsoft.com'
  ].filter(Boolean);
}

function getConfiguredAdminPins() {
  const pins = [
    MASTER_ADMIN_PIN,
    process.env.APP_ADMIN_CODE,
    process.env.ADMIN_CODE
  ].map((value) => String(value || '').trim()).filter(Boolean);
  return Array.from(new Set(pins));
}

function isAdminLoginConfigured() {
  return getConfiguredAdminPins().length > 0;
}

function safeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function isAllowedAdminPin(pin) {
  const suppliedPin = String(pin || '').trim();
  if (!suppliedPin) return false;
  return getConfiguredAdminPins().some((configuredPin) => safeStringEqual(suppliedPin, configuredPin));
}

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  return header.split(';').reduce((cookies, part) => {
    const index = part.indexOf('=');
    if (index === -1) return cookies;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) {
      try {
        cookies[key] = decodeURIComponent(value);
      } catch (err) {
        cookies[key] = value;
      }
    }
    return cookies;
  }, {});
}

function base64urlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function base64urlDecode(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signAdminSession(payload) {
  const body = base64urlEncode(JSON.stringify(payload));
  const signature = createHmac('sha256', ADMIN_SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyAdminSession(token) {
  const rawToken = String(token || '');
  const [body, signature] = rawToken.split('.');
  if (!body || !signature) return null;
  const expectedSignature = createHmac('sha256', ADMIN_SESSION_SECRET).update(body).digest('base64url');
  if (!safeStringEqual(signature, expectedSignature)) return null;
  try {
    const session = JSON.parse(base64urlDecode(body));
    if (session.role !== 'admin') return null;
    if (session.exp && Number(session.exp) < Date.now()) return null;
    if (session.orgId && String(session.orgId) !== DEFAULT_ORG_ID) return null;
    return session;
  } catch (err) {
    return null;
  }
}

function hasValidAdminSession(req) {
  if (!COMMERCIAL_MODE && !isAdminLoginConfigured()) return true;
  const cookies = parseCookies(req);
  return Boolean(verifyAdminSession(cookies[ADMIN_SESSION_COOKIE]));
}

function getCookieSecureFlag(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return Boolean(req.secure || forwardedProto === 'https');
}

function buildAdminSessionCookie(req, value, maxAgeMs = null) {
  const parts = [
    `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (typeof maxAgeMs === 'number') {
    parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`);
  }
  if (getCookieSecureFlag(req)) parts.push('Secure');
  return parts.join('; ');
}

function setAdminSessionCookie(req, res) {
  const now = Date.now();
  const token = signAdminSession({
    role: 'admin',
    orgId: DEFAULT_ORG_ID,
    iat: now,
    exp: now + ADMIN_SESSION_MAX_AGE_MS
  });
  res.setHeader('Set-Cookie', buildAdminSessionCookie(
    req,
    token,
    ADMIN_SESSION_PERSISTENT ? ADMIN_SESSION_MAX_AGE_MS : null
  ));
}

function clearAdminSessionCookie(req, res) {
  res.setHeader('Set-Cookie', buildAdminSessionCookie(req, '', 0));
}

function sanitizeLocalNextPath(value) {
  const nextPath = String(value || '/admin').trim();
  if (!nextPath.startsWith('/') || nextPath.startsWith('//')) return '/admin';
  if (nextPath.startsWith('/api/')) return '/admin';
  return nextPath;
}

function requireAdminPage(req, res, next) {
  if (shouldRedirectAdminTrafficToApp(req)) return res.redirect(buildAdminAppUrl('/admin'));
  if (hasValidAdminSession(req)) return next();
  const nextPath = encodeURIComponent(sanitizeLocalNextPath(req.originalUrl || '/admin'));
  return res.redirect(`/admin-login?next=${nextPath}`);
}

function requireAdminApiSession(req, res) {
  if (hasValidAdminSession(req)) return true;
  res.status(401).json({ ok: false, error: 'Admin login required.' });
  return false;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderNoEventPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sanctuary Voice</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: Georgia, "Times New Roman", serif;
      color: #f8f0e0;
      background: radial-gradient(circle at 50% 12%, rgba(232,196,119,0.12), transparent 28%), #070807;
      text-align: center;
      padding: 32px 16px;
    }
    .eyebrow { letter-spacing: .2em; text-transform: uppercase; color: #e8c477; font: 700 13px/1.4 Arial, sans-serif; margin-bottom: 16px; }
    h1 { margin: 0 0 12px; font-size: clamp(2rem, 5vw, 3rem); }
    p { margin: 0; color: #b9b0a3; font: 18px/1.5 Arial, sans-serif; }
  </style>
</head>
<body>
  <div>
    <div class="eyebrow">Sanctuary Voice</div>
    <h1>No active event</h1>
    <p>Ask the event host for a direct link or QR code to join.</p>
  </div>
</body>
</html>`;
}

function requireEventParam(req, res, next) {
  if (!req.query.event) return res.send(renderNoEventPage());
  return next();
}

function renderAdminLoginPage({ error = '', nextPath = '/admin' } = {}) {
  const errorHtml = error ? `<div class="login-error">${escapeHtml(error)}</div>` : '';
  return `<!doctype html>
<html lang="ro">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sanctuary Voice Admin Login</title>
  <style>
    :root { color-scheme: dark; --gold: #e8c477; --ink: #f8f0e0; --muted: #b9b0a3; --panel: rgba(18, 18, 18, 0.9); }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: Georgia, "Times New Roman", serif;
      color: var(--ink);
      background:
        radial-gradient(circle at 50% 12%, rgba(232, 196, 119, 0.2), transparent 28%),
        radial-gradient(circle at 15% 80%, rgba(38, 101, 82, 0.18), transparent 32%),
        #070807;
    }
    .login-card {
      width: min(92vw, 460px);
      padding: 34px;
      border: 1px solid rgba(232, 196, 119, 0.28);
      border-radius: 28px;
      background: linear-gradient(150deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02)), var(--panel);
      box-shadow: 0 30px 100px rgba(0, 0, 0, 0.55), 0 0 70px rgba(232, 196, 119, 0.16);
    }
    .eyebrow { letter-spacing: 0.2em; text-transform: uppercase; color: var(--gold); font: 700 13px/1.4 Arial, sans-serif; }
    h1 { margin: 12px 0 10px; font-size: clamp(38px, 8vw, 58px); line-height: 0.95; }
    p { margin: 0 0 24px; color: var(--muted); font: 18px/1.45 Arial, sans-serif; }
    label { display: block; margin-bottom: 10px; color: var(--gold); font: 700 13px/1.4 Arial, sans-serif; letter-spacing: 0.12em; text-transform: uppercase; }
    input {
      width: 100%;
      border: 1px solid rgba(232, 196, 119, 0.28);
      border-radius: 16px;
      padding: 16px 18px;
      color: var(--ink);
      background: rgba(255, 255, 255, 0.08);
      font: 600 22px/1.2 Arial, sans-serif;
    }
    button {
      width: 100%;
      margin-top: 18px;
      border: 0;
      border-radius: 999px;
      padding: 16px 18px;
      cursor: pointer;
      color: #1d160b;
      background: linear-gradient(135deg, #f4deb0, #d19a35);
      font: 800 18px/1.2 Arial, sans-serif;
      box-shadow: 0 18px 48px rgba(209, 154, 53, 0.25);
    }
    .login-error {
      margin: 0 0 18px;
      border: 1px solid rgba(255, 117, 117, 0.42);
      border-radius: 14px;
      padding: 12px 14px;
      color: #ffd4d4;
      background: rgba(145, 18, 18, 0.25);
      font: 600 15px/1.4 Arial, sans-serif;
    }
  </style>
</head>
<body>
  <main class="login-card">
    <div class="eyebrow">Sanctuary Voice</div>
    <h1>Admin access</h1>
    <p>Enter the admin PIN to continue to the control center.</p>
    ${errorHtml}
    <form method="post" action="/api/admin-login">
      <input type="hidden" name="next" value="${escapeHtml(nextPath)}">
      <label for="pin">Admin PIN</label>
      <input id="pin" name="pin" type="password" autocomplete="current-password" autofocus required>
      <button type="submit">Open Admin</button>
    </form>
  </main>
</body>
</html>`;
}

function defaultSongState() {
  return {
    title: '',
    sourceLang: 'ro',
    blocks: [],
    blockLabels: [],
    currentIndex: -1,
    activeBlock: null,
    translations: {},
    allTranslations: [],
    updatedAt: null
  };
}


function defaultDisplayState() {
  return {
    mode: 'auto',
    blackScreen: false,
    theme: 'dark',
    language: 'no',
    secondaryLanguage: '',
    backgroundPreset: 'none',
    customBackground: '',
    showClock: false,
    clockPosition: 'top-right',
    clockScale: 1,
    textSize: 'large',
    textScale: 1,
    screenStyle: 'focus',
    displayResolution: 'auto',
    sceneLabel: '',
    manualSource: '',
    manualSourceLang: 'ro',
    manualTranslations: {},
    updatedAt: null
  };
}

function defaultDisplayPresets() {
  return [];
}

function defaultSongLibrary() {
  return [];
}

function defaultGlobalSongLibrary() {
  return [];
}

function defaultPinnedTextLibrary() {
  return [];
}

function normalizeOrgId(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || DEFAULT_ORG_ID;
}

function defaultOrganization(id = DEFAULT_ORG_ID, name = DEFAULT_ORG_NAME) {
  const orgId = normalizeOrgId(id);
  return {
    id: orgId,
    name: String(name || DEFAULT_ORG_NAME).trim() || DEFAULT_ORG_NAME,
    slug: orgId,
    plan: DEFAULT_ORG_PLAN,
    status: 'active',
    createdAt: new Date().toISOString(),
    activeEventId: null,
    globalAccess: {},
    globalMemory: {},
    globalSongLibrary: defaultGlobalSongLibrary(),
    pinnedTextLibrary: defaultPinnedTextLibrary()
  };
}

function defaultSongHistory() {
  return [];
}

function defaultUsageStats() {
  return {
    participantJoinCount: 0,
    uniqueParticipantsEver: 0,
    seenParticipantIds: {},
    transcriptCount: 0,
    transcriptRefreshCount: 0,
    screenChangeCount: 0,
    manualPushCount: 0,
    songControlCount: 0,
    adminJoinCount: 0,
    screenOperatorJoinCount: 0,
    lastTranscriptAt: null,
    lastScreenActionAt: null,
    lastParticipantJoinAt: null,
    lastOperatorJoinAt: null,
    lastOperatorRole: '',
    lastErrorAt: null,
    lastErrorMessage: ''
  };
}

function normalizeDisplayTextScale(value, fallback = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(1.4, Math.max(0.65, Math.round(numeric * 100) / 100));
}

function defaultTranslationMonitor() {
  return {
    lastSpeechReceivedAt: null,
    lastSpeechSourceLang: '',
    lastSpeechProvider: '',
    lastSpeechPreview: '',
    lastBufferedAt: null,
    lastBufferedText: '',
    lastFlushAt: null,
    lastBatchText: '',
    lastBatchSourceLang: '',
    pendingTranslations: 0,
    lastTranslateStartedAt: null,
    lastTranslateFinishedAt: null,
    lastTranslateDurationMs: 0,
    lastTargetLang: '',
    lastCacheHitAt: null,
    lastCacheHitLang: '',
    lastDeliveredAt: null,
    lastDeliveredPreview: '',
    lastDeliveryTargetCount: 0,
    lastErrorAt: null,
    lastErrorMessage: ''
  };
}

function cloneDisplaySnapshot(event) {
  ensureEventUiState(event);
  return {
    mode: event.displayState.mode,
    blackScreen: !!event.displayState.blackScreen,
    theme: event.displayState.theme,
    language: event.displayState.language,
    secondaryLanguage: event.displayState.secondaryLanguage || '',
    backgroundPreset: event.displayState.backgroundPreset,
    customBackground: event.displayState.customBackground,
    showClock: !!event.displayState.showClock,
    clockPosition: event.displayState.clockPosition,
    clockScale: event.displayState.clockScale || 1,
    textSize: event.displayState.textSize,
    textScale: event.displayState.textScale || 1,
    screenStyle: event.displayState.screenStyle,
    displayResolution: event.displayState.displayResolution || 'auto',
    sceneLabel: typeof event.displayState.sceneLabel === 'string' ? event.displayState.sceneLabel : '',
    manualSource: event.displayState.manualSource || '',
    manualSourceLang: event.displayState.manualSourceLang || event.sourceLang || 'ro',
    manualTranslations: { ...(event.displayState.manualTranslations || {}) },
    updatedAt: event.displayState.updatedAt || null
  };
}

function getDisplayLanguageChoices(event, modeOverride = '') {
  const mode = String(modeOverride || event?.displayState?.mode || 'auto').trim();
  const base = Array.isArray(event?.targetLangs) ? [...event.targetLangs] : [];
  if (mode === 'song') {
    const sourceLang = String(event?.songState?.sourceLang || event?.sourceLang || '').trim();
    if (sourceLang && !base.includes(sourceLang)) base.push(sourceLang);
  }
  if (mode === 'manual') {
    const sourceLang = String(event?.displayState?.manualSourceLang || event?.sourceLang || '').trim();
    if (sourceLang && !base.includes(sourceLang)) base.push(sourceLang);
  }
  return base.filter(Boolean);
}

function applyDisplaySnapshot(event, snapshot, updatedAt = new Date().toISOString()) {
  ensureEventUiState(event);
  const safe = snapshot || defaultDisplayState();
  const allowedDisplayLanguages = getDisplayLanguageChoices(event, safe.mode);
  const manualSourceLang = typeof safe.manualSourceLang === 'string' ? safe.manualSourceLang : (event.sourceLang || 'ro');
  if (safe.mode === 'manual' && manualSourceLang && !allowedDisplayLanguages.includes(manualSourceLang)) {
    allowedDisplayLanguages.push(manualSourceLang);
  }
  const primaryLanguage = allowedDisplayLanguages.includes(safe.language)
    ? safe.language
    : (allowedDisplayLanguages[0] || event.targetLangs[0] || 'no');
  event.displayState = {
    ...event.displayState,
    mode: ['auto', 'manual', 'song'].includes(safe.mode) ? safe.mode : 'auto',
    blackScreen: !!safe.blackScreen,
    theme: ['dark', 'light'].includes(safe.theme) ? safe.theme : 'dark',
    language: primaryLanguage,
    secondaryLanguage: allowedDisplayLanguages.includes(safe.secondaryLanguage) && safe.secondaryLanguage !== primaryLanguage ? safe.secondaryLanguage : '',
    backgroundPreset: ['none', 'warm', 'sanctuary', 'soft-light'].includes(safe.backgroundPreset) ? safe.backgroundPreset : 'none',
    customBackground: typeof safe.customBackground === 'string' ? safe.customBackground : '',
    showClock: !!safe.showClock,
    clockPosition: ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(safe.clockPosition) ? safe.clockPosition : 'top-right',
    clockScale: typeof safe.clockScale === 'number' ? Math.min(1.8, Math.max(0.7, safe.clockScale)) : 1,
    textSize: ['compact', 'large', 'xlarge'].includes(safe.textSize) ? safe.textSize : 'large',
    textScale: normalizeDisplayTextScale(safe.textScale, 1),
    screenStyle: ['focus', 'wide'].includes(safe.screenStyle) ? safe.screenStyle : 'focus',
    displayResolution: ['auto', '16-9', '16-10', '4-3'].includes(safe.displayResolution) ? safe.displayResolution : 'auto',
    sceneLabel: typeof safe.sceneLabel === 'string' ? safe.sceneLabel : '',
    manualSource: typeof safe.manualSource === 'string' ? safe.manualSource : '',
    manualSourceLang,
    manualTranslations: typeof safe.manualTranslations === 'object' && safe.manualTranslations ? { ...safe.manualTranslations } : {},
    updatedAt
  };
}

function rememberDisplayState(event) {
  ensureEventUiState(event);
  event.displayStatePrevious = cloneDisplaySnapshot(event);
}

function ensureEventUiState(event) {
  if (typeof event.transcriptionPaused !== 'boolean') {
    event.transcriptionPaused = false;
  }
  if (typeof event.transcriptionOnAir !== 'boolean') {
    event.transcriptionOnAir = false;
  }
  if (!Array.isArray(event.pushSubscriptions)) {
    event.pushSubscriptions = [];
  }
  if (typeof event.audioMuted !== 'boolean') {
    event.audioMuted = true;
  }
  if (!event.displayState || typeof event.displayState !== 'object') {
    event.displayState = defaultDisplayState();
  }
  if (!['dark', 'light'].includes(event.displayState.theme)) {
    event.displayState.theme = 'dark';
  }
  event.displayState.blackScreen = !!event.displayState.blackScreen;
  if (!Array.isArray(event.targetLangs) || !event.targetLangs.length) {
    event.targetLangs = ['no', 'en'];
  }
  if (!event.displayState.language || !event.targetLangs.includes(event.displayState.language)) {
    const allowedDisplayLanguages = getDisplayLanguageChoices(event);
    event.displayState.language = allowedDisplayLanguages.includes(event.displayState.language)
      ? event.displayState.language
      : (allowedDisplayLanguages[0] || event.targetLangs[0] || 'no');
  }
  {
    const allowedDisplayLanguages = getDisplayLanguageChoices(event);
    const secondaryLanguage = String(event.displayState.secondaryLanguage || '').trim();
    event.displayState.secondaryLanguage = allowedDisplayLanguages.includes(secondaryLanguage) && secondaryLanguage !== event.displayState.language
      ? secondaryLanguage
      : '';
  }
  if (typeof event.displayState.customBackground !== 'string') {
    event.displayState.customBackground = '';
  }
  if (typeof event.displayState.manualSourceLang !== 'string' || !event.displayState.manualSourceLang.trim()) {
    event.displayState.manualSourceLang = event.sourceLang || 'ro';
  }
  if (typeof event.liveSourceLang !== 'string' || !event.liveSourceLang.trim()) {
    event.liveSourceLang = event.sourceLang || 'ro';
  }
  if (!['none', 'warm', 'sanctuary', 'soft-light'].includes(event.displayState.backgroundPreset)) {
    event.displayState.backgroundPreset = 'none';
  }
  event.displayState.showClock = !!event.displayState.showClock;
  if (!['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(event.displayState.clockPosition)) {
    event.displayState.clockPosition = 'top-right';
  }
  if (typeof event.displayState.clockScale !== 'number') {
    event.displayState.clockScale = 1;
  }
  event.displayState.clockScale = Math.min(1.8, Math.max(0.7, event.displayState.clockScale));
  if (!['compact', 'large', 'xlarge'].includes(event.displayState.textSize)) {
    event.displayState.textSize = 'large';
  }
  event.displayState.textScale = normalizeDisplayTextScale(event.displayState.textScale, 1);
  if (!['focus', 'wide'].includes(event.displayState.screenStyle)) {
    event.displayState.screenStyle = 'focus';
  }
  if (!['auto', '16-9', '16-10', '4-3'].includes(event.displayState.displayResolution)) {
    event.displayState.displayResolution = 'auto';
  }
  if (typeof event.displayState.sceneLabel !== 'string') {
    event.displayState.sceneLabel = '';
  }
  if (!Array.isArray(event.songLibrary)) {
    event.songLibrary = defaultSongLibrary();
  }
  if (!Array.isArray(event.songHistory)) {
    event.songHistory = defaultSongHistory();
  }
  if (!Array.isArray(event.displayPresets)) {
    event.displayPresets = defaultDisplayPresets();
  }
  if (!event.songState || typeof event.songState !== 'object') {
    event.songState = defaultSongState();
  }
  if (!event.latestDisplayEntry || typeof event.latestDisplayEntry !== 'object') {
    event.latestDisplayEntry = null;
  }
  if (typeof event.songState.sourceLang !== 'string' || !event.songState.sourceLang.trim()) {
    event.songState.sourceLang = event.sourceLang || 'ro';
  }
  if (!Array.isArray(event.remoteOperators)) {
    event.remoteOperators = [];
  }
  event.remoteOperators = normalizeRemoteOperators(event.remoteOperators);
  if (!Array.isArray(event.songState.blockLabels)) {
    event.songState.blockLabels = [];
  }
  if (!event.usageStats || typeof event.usageStats !== 'object') {
    event.usageStats = defaultUsageStats();
  } else {
    event.usageStats = {
      ...defaultUsageStats(),
      ...event.usageStats,
      seenParticipantIds: typeof event.usageStats.seenParticipantIds === 'object' && event.usageStats.seenParticipantIds
        ? { ...event.usageStats.seenParticipantIds }
        : {}
    };
  }
  if (!event.translationMonitor || typeof event.translationMonitor !== 'object') {
    event.translationMonitor = defaultTranslationMonitor();
  } else {
    event.translationMonitor = {
      ...defaultTranslationMonitor(),
      ...event.translationMonitor
    };
  }
  if (event.displayStatePrevious && typeof event.displayStatePrevious === 'object') {
    event.displayStatePrevious = {
      ...defaultDisplayState(),
      ...event.displayStatePrevious,
      sceneLabel: typeof event.displayStatePrevious.sceneLabel === 'string' ? event.displayStatePrevious.sceneLabel : '',
      manualSource: typeof event.displayStatePrevious.manualSource === 'string' ? event.displayStatePrevious.manualSource : '',
      manualTranslations: typeof event.displayStatePrevious.manualTranslations === 'object' && event.displayStatePrevious.manualTranslations
        ? { ...event.displayStatePrevious.manualTranslations }
        : {}
    };
  } else {
    event.displayStatePrevious = null;
  }
}

function defaultDb() {
  return {
    organizations: {
      [DEFAULT_ORG_ID]: defaultOrganization(DEFAULT_ORG_ID, DEFAULT_ORG_NAME)
    },
    activeOrganizationId: DEFAULT_ORG_ID,
    events: {},
    globalMemory: {},
    globalSongLibrary: defaultGlobalSongLibrary(),
    pinnedTextLibrary: defaultPinnedTextLibrary(),
    globalAccess: {},
    activeEventId: null
  };
}

const dbStore = createJsonDbStore({
  dataDir: DATA_DIR,
  fileName: 'sessions.json',
  backupRetention: DB_BACKUP_RETENTION,
  defaultData: defaultDb,
  logger
});

const REMOTE_OPERATOR_PROFILES = {
  main_screen: {
    label: 'Main Screen only',
    permissions: ['main_screen']
  },
  song_only: {
    label: 'Song only',
    permissions: ['song']
  },
  main_and_song: {
    label: 'Main Screen + Song',
    permissions: ['main_screen', 'song']
  },
  full: {
    label: 'Full operator',
    permissions: ['main_screen', 'song']
  }
};

function normalizeRemoteOperatorProfile(profile) {
  const key = String(profile || '').trim().toLowerCase();
  return REMOTE_OPERATOR_PROFILES[key] ? key : 'main_screen';
}

function getRemoteOperatorPermissions(profile) {
  return [...(REMOTE_OPERATOR_PROFILES[normalizeRemoteOperatorProfile(profile)]?.permissions || ['main_screen'])];
}

function buildRemoteOperatorLink(baseUrl, eventId, operator) {
  if (!baseUrl || !eventId || !operator?.code) return '';
  const params = new URLSearchParams({
    event: eventId,
    code: operator.code
  });
  if (operator.id) params.set('operator', operator.id);
  return `${baseUrl}/remote?${params.toString()}`;
}

function normalizeRemoteOperators(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const profile = normalizeRemoteOperatorProfile(item?.profile);
      return {
        id: String(item?.id || randomUUID()),
        name: String(item?.name || '').trim() || 'Operator',
        profile,
        code: String(item?.code || `SV-REMOTE-${Math.random().toString(36).slice(2, 7).toUpperCase()}`).trim(),
        permissions: getRemoteOperatorPermissions(profile),
        remoteLink: String(item?.remoteLink || '').trim()
      };
    });
}

function getDbBackupStamp(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function pruneDbBackups() {
  dbStore.backupOncePerDay();
}

function backupDbOncePerDay() {
  dbStore.backupOncePerDay();
}

function loadDb() {
  return dbStore.load();
}

function ensureOrganization(orgId = DEFAULT_ORG_ID, seed = {}) {
  const id = normalizeOrgId(orgId);
  if (!db.organizations || typeof db.organizations !== 'object') db.organizations = {};
  if (!db.organizations[id]) {
    db.organizations[id] = {
      ...defaultOrganization(id, seed.name || DEFAULT_ORG_NAME),
      ...seed
    };
  }
  const org = db.organizations[id];
  org.id = id;
  org.name = String(org.name || seed.name || DEFAULT_ORG_NAME).trim() || DEFAULT_ORG_NAME;
  org.slug = normalizeOrgId(org.slug || id);
  org.plan = String(org.plan || DEFAULT_ORG_PLAN).trim() || DEFAULT_ORG_PLAN;
  org.status = String(org.status || 'active').trim() || 'active';
  org.createdAt = org.createdAt || new Date().toISOString();
  org.globalAccess = org.globalAccess && typeof org.globalAccess === 'object' ? org.globalAccess : {};
  org.globalMemory = org.globalMemory && typeof org.globalMemory === 'object' ? org.globalMemory : {};
  org.globalSongLibrary = Array.isArray(org.globalSongLibrary) ? org.globalSongLibrary : defaultGlobalSongLibrary();
  org.pinnedTextLibrary = Array.isArray(org.pinnedTextLibrary) ? org.pinnedTextLibrary : defaultPinnedTextLibrary();
  org.activeEventId = org.activeEventId || null;
  return org;
}

function getDefaultOrganization() {
  return ensureOrganization(DEFAULT_ORG_ID, { name: DEFAULT_ORG_NAME });
}

function syncLegacyGlobalsFromDefaultOrg() {
  const org = getDefaultOrganization();
  db.activeOrganizationId = org.id;
  db.globalAccess = org.globalAccess;
  db.globalMemory = org.globalMemory;
  db.globalSongLibrary = org.globalSongLibrary;
  db.pinnedTextLibrary = org.pinnedTextLibrary;
  db.activeEventId = org.activeEventId || null;
}

function ensureCommercialState() {
  if (!db.organizations || typeof db.organizations !== 'object') db.organizations = {};
  const existingLegacy = {
    globalAccess: db.globalAccess && typeof db.globalAccess === 'object' ? db.globalAccess : {},
    globalMemory: db.globalMemory && typeof db.globalMemory === 'object' ? db.globalMemory : {},
    globalSongLibrary: Array.isArray(db.globalSongLibrary) ? db.globalSongLibrary : defaultGlobalSongLibrary(),
    pinnedTextLibrary: Array.isArray(db.pinnedTextLibrary) ? db.pinnedTextLibrary : defaultPinnedTextLibrary(),
    activeEventId: db.activeEventId || null
  };
  const org = ensureOrganization(DEFAULT_ORG_ID, {
    name: DEFAULT_ORG_NAME,
    ...existingLegacy
  });
  org.globalAccess = Object.keys(org.globalAccess || {}).length ? org.globalAccess : existingLegacy.globalAccess;
  org.globalMemory = Object.keys(org.globalMemory || {}).length ? org.globalMemory : existingLegacy.globalMemory;
  org.globalSongLibrary = Array.isArray(org.globalSongLibrary) && org.globalSongLibrary.length
    ? org.globalSongLibrary
    : existingLegacy.globalSongLibrary;
  org.pinnedTextLibrary = Array.isArray(org.pinnedTextLibrary) && org.pinnedTextLibrary.length
    ? org.pinnedTextLibrary
    : existingLegacy.pinnedTextLibrary;
  org.activeEventId = org.activeEventId || existingLegacy.activeEventId || null;

  for (const event of Object.values(db.events || {})) {
    event.organizationId = normalizeOrgId(event.organizationId || org.id);
  }
  syncLegacyGlobalsFromDefaultOrg();
}

const db = loadDb();
ensureCommercialState();
if (!Array.isArray(db.globalSongLibrary)) {
  db.globalSongLibrary = defaultGlobalSongLibrary();
}
if (!Array.isArray(db.pinnedTextLibrary)) {
  db.pinnedTextLibrary = defaultPinnedTextLibrary();
}
if (!db.globalAccess || typeof db.globalAccess !== 'object') {
  db.globalAccess = {};
}
syncLegacyGlobalsFromDefaultOrg();

function saveDb() {
  syncLegacyGlobalsFromDefaultOrg();
  dbStore.save(db);
}

function getOrganizationForEvent(event) {
  return ensureOrganization(event?.organizationId || DEFAULT_ORG_ID);
}

function getEventOrgId(event) {
  return getOrganizationForEvent(event).id;
}

function getActiveEventIdForOrg(orgId = DEFAULT_ORG_ID) {
  return ensureOrganization(orgId).activeEventId || null;
}

function setActiveEventIdForOrg(orgId = DEFAULT_ORG_ID, eventId = null) {
  const org = ensureOrganization(orgId);
  org.activeEventId = eventId || null;
  if (org.id === DEFAULT_ORG_ID) db.activeEventId = org.activeEventId;
  return org.activeEventId;
}

function isEventActive(event) {
  return !!event?.id && getActiveEventIdForOrg(getEventOrgId(event)) === event.id;
}

function getOrganizationEvents(orgId = DEFAULT_ORG_ID) {
  const targetOrgId = normalizeOrgId(orgId);
  return Object.values(db.events || {}).filter((event) => getEventOrgId(event) === targetOrgId);
}

function getOrganizationSongLibrary(orgId = DEFAULT_ORG_ID) {
  return ensureOrganization(orgId).globalSongLibrary;
}

function getOrganizationPinnedTextLibrary(orgId = DEFAULT_ORG_ID) {
  return ensureOrganization(orgId).pinnedTextLibrary;
}

function getOrganizationMemory(eventOrOrgId = DEFAULT_ORG_ID) {
  const orgId = typeof eventOrOrgId === 'string' ? eventOrOrgId : getEventOrgId(eventOrOrgId);
  return ensureOrganization(orgId).globalMemory;
}

function getOrganizationAccess(eventOrOrgId = DEFAULT_ORG_ID) {
  const orgId = typeof eventOrOrgId === 'string' ? eventOrOrgId : getEventOrgId(eventOrOrgId);
  return ensureOrganization(orgId).globalAccess;
}

function buildPublicOrganization(org = getDefaultOrganization()) {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    plan: org.plan,
    status: org.status
  };
}

function buildOrganizationStatus(orgId = DEFAULT_ORG_ID) {
  const org = ensureOrganization(orgId);
  const events = getOrganizationEvents(org.id);
  const activeEventId = getActiveEventIdForOrg(org.id);
  const activeEvent = activeEventId ? db.events[activeEventId] : null;
  const transcriptCount = events.reduce((sum, event) => sum + (Array.isArray(event.transcripts) ? event.transcripts.length : 0), 0);
  return {
    organization: buildPublicOrganization(org),
    commercialMode: COMMERCIAL_MODE,
    activeEventId,
    activeEvent: activeEvent ? summarizeEvent(activeEvent) : null,
    counts: {
      events: events.length,
      transcripts: transcriptCount,
      churchLibrarySongs: Array.isArray(org.globalSongLibrary) ? org.globalSongLibrary.length : 0,
      pinnedTexts: Array.isArray(org.pinnedTextLibrary) ? org.pinnedTextLibrary.length : 0,
      glossaryTerms: Object.keys(org.globalMemory || {}).length
    }
  };
}

const speechBuffers = new Map();
const participantPresence = new Map();
const azureSpeechSessions = new Map();

const LIVE_TEXT_MIN_WORDS = 9;
const LIVE_TEXT_TARGET_WORDS = 16;
const LIVE_TEXT_MAX_WORDS = 22;
const LIVE_TEXT_MAX_CHARS = 190;
const LIVE_TEXT_SOFT_WAIT_MS = 1200;
const LIVE_TEXT_HARD_WAIT_MS = 4200;
const AZURE_LIVE_TEXT_MIN_WORDS = 6;
const AZURE_LIVE_TEXT_TARGET_WORDS = 10;
const AZURE_LIVE_TEXT_MAX_WORDS = 16;
const AZURE_LIVE_TEXT_SOFT_WAIT_MS = 500;
const AZURE_LIVE_TEXT_HARD_WAIT_MS = 2200;

const BUFFER_CONNECTORS = new Set([
  'și', 'si', 'să', 'sa', 'că', 'ca', 'dar', 'iar', 'ori', 'sau',
  'de', 'la', 'în', 'in', 'cu', 'pe', 'din', 'spre', 'pentru',
  'când', 'cand', 'care', 'ce', 'către', 'catre',
  'og', 'at', 'men', 'som', 'i', 'på', 'med', 'til', 'for'
]);

function summarizeEvent(event) {
  const org = getOrganizationForEvent(event);
  ensureEventShortId(event);
  return {
    id: event.id,
    shortId: event.shortId,
    organizationId: org.id,
    organizationName: org.name,
    name: event.name,
    createdAt: event.createdAt || null,
    scheduledAt: event.scheduledAt || null,
    scheduledDate: event.scheduledDate || null,
    scheduledTime: event.scheduledTime || null,
    timezone: event.timezone || null,
    scheduledTimestamp: typeof event.scheduledTimestamp === 'number' ? event.scheduledTimestamp : null,
    sourceLang: event.sourceLang || 'ro',
    liveSourceLang: event.liveSourceLang || event.sourceLang || 'ro',
    targetLangs: Array.isArray(event.targetLangs) ? event.targetLangs : [],
    transcriptCount: Array.isArray(event.transcripts) ? event.transcripts.length : 0,
    isActive: isEventActive(event),
    participantLink: event.participantLink || '',
    translateLink: event.translateLink || '',
    songLink: event.songLink || '',
    qrCodeDataUrl: event.qrCodeDataUrl || '',
    mode: event.mode || 'live'
  };
}

function sanitizeTranscriptText(text) {
  return String(text || '')
    .replace(/…/g, '')
    .replace(/\.\.\.+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}

function sanitizeStructuredText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/…/g, '')
    .replace(/\.\.\.+/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').replace(/\s+([,.!?;:])/g, '$1').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function countWords(text) {
  return sanitizeTranscriptText(text).split(/\s+/).filter(Boolean).length;
}

function getLastWord(text) {
  const words = sanitizeTranscriptText(text).split(/\s+/).filter(Boolean);
  return (words[words.length - 1] || '').toLowerCase();
}

function startsWithLowercase(text) {
  const clean = sanitizeTranscriptText(text);
  if (!clean) return false;
  const first = clean.trim().charAt(0);
  return first === first.toLowerCase() && first !== first.toUpperCase();
}

function startsLikeContinuation(text) {
  const clean = sanitizeTranscriptText(text);
  if (!clean) return false;
  if (startsWithLowercase(clean)) return true;
  return /^(și|si|să|sa|că|ca|dar|iar|ori|sau|de|din|în|in|cu|pe|la|pentru|când|cand|care|ce)\b/i.test(clean);
}

function normalizeChunkText(text) {
  return String(text || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.,!?;:]+$/g, '')
    .toLowerCase();
}

function mergeTranscriptText(prevText, nextText) {
  const prev = sanitizeTranscriptText(prevText);
  const next = sanitizeTranscriptText(nextText);
  if (!prev) return next;
  if (!next) return prev;

  const prevNorm = normalizeChunkText(prev);
  const nextNorm = normalizeChunkText(next);

  if (!prevNorm) return next;
  if (!nextNorm) return prev;
  if (prevNorm === nextNorm) return prev;
  if (nextNorm.startsWith(prevNorm)) return next;
  if (prevNorm.startsWith(nextNorm)) return prev;
  if (prevNorm.endsWith(nextNorm)) return prev;
  if (nextNorm.endsWith(prevNorm)) return next;

  return `${prev} ${next}`.replace(/\s+/g, ' ').trim();
}

function splitLongPiece(piece) {
  const clean = sanitizeTranscriptText(piece);
  if (!clean) return [];
  if (countWords(clean) <= LIVE_TEXT_TARGET_WORDS && clean.length <= LIVE_TEXT_MAX_CHARS) return [clean];

  const softerParts = clean
    .split(/(?<=[,;:])\s+|\s+(?=(?:și|si|dar|iar|ori|sau|og|men|for|som)\b)/i)
    .map((x) => x.trim())
    .filter(Boolean);

  if (softerParts.length === 1) {
    const words = clean.split(/\s+/).filter(Boolean);
    const out = [];
    let current = [];
    for (const word of words) {
      current.push(word);
      if (current.length >= LIVE_TEXT_TARGET_WORDS) {
        out.push(current.join(' ').trim());
        current = [];
      }
    }
    if (current.length) out.push(current.join(' ').trim());
    return out.filter(Boolean);
  }

  const out = [];
  let current = '';
  for (const part of softerParts) {
    const candidate = current ? `${current} ${part}` : part;
    if (countWords(candidate) <= LIVE_TEXT_TARGET_WORDS && candidate.length <= LIVE_TEXT_MAX_CHARS) {
      current = candidate;
    } else {
      if (current) out.push(current.trim());
      current = part;
    }
  }
  if (current) out.push(current.trim());
  return out.filter(Boolean);
}

function splitIntoDisplayChunks(text) {
  const clean = sanitizeTranscriptText(text);
  if (!clean) return [];
  const sentenceUnits = clean.match(/[^.!?]+[.!?]?/g)?.map((x) => x.trim()).filter(Boolean) || [clean];
  const smallPieces = [];

  for (const sentence of sentenceUnits) {
    const commaUnits = sentence.match(/[^,;:]+[,;:]?|[^,;:]+$/g)?.map((x) => x.trim()).filter(Boolean) || [sentence];
    let shortBuffer = '';
    for (const unit of commaUnits) {
      const unitWords = countWords(unit);
      const endsCommaBoundary = /[,;:]\s*$/.test(unit);
      if (endsCommaBoundary && unitWords >= 3) {
        const candidate = shortBuffer ? `${shortBuffer} ${unit}` : unit;
        splitLongPiece(candidate).forEach((piece) => smallPieces.push(piece));
        shortBuffer = '';
        continue;
      }
      const combined = shortBuffer ? `${shortBuffer} ${unit}` : unit;
      if (countWords(combined) < 3 && !/[.!?]\s*$/.test(unit)) {
        shortBuffer = combined;
        continue;
      }
      splitLongPiece(combined).forEach((piece) => smallPieces.push(piece));
      shortBuffer = '';
    }
    if (shortBuffer) splitLongPiece(shortBuffer).forEach((piece) => smallPieces.push(piece));
  }

  const chunks = [];
  let currentChunk = [];
  let currentWords = 0;
  for (const piece of smallPieces) {
    const pieceWords = countWords(piece);
    const nextWords = currentWords + pieceWords;
    if (currentChunk.length >= 2 || nextWords > LIVE_TEXT_MAX_WORDS) {
      if (currentChunk.length) chunks.push(currentChunk.join(' ').trim());
      currentChunk = [piece];
      currentWords = pieceWords;
      continue;
    }
    currentChunk.push(piece);
    currentWords = nextWords;
  }
  if (currentChunk.length) chunks.push(currentChunk.join(' ').trim());
  return chunks.filter(Boolean);
}

function shouldFlushBufferedText(text, options = {}) {
  const clean = sanitizeTranscriptText(text);
  if (!clean) return false;
  const words = countWords(clean);
  const last = getLastWord(clean);
  const minWords = options.minWords || LIVE_TEXT_MIN_WORDS;
  const targetWords = options.targetWords || LIVE_TEXT_TARGET_WORDS;
  const maxWords = options.maxWords || LIVE_TEXT_MAX_WORDS;
  if (/[.!?]\s*$/.test(clean) && words >= minWords) return true;
  if (/[,;:]\s*$/.test(clean) && words >= minWords) return true;
  if (words >= targetWords && !BUFFER_CONNECTORS.has(last)) return true;
  if (words >= maxWords) return true;
  return false;
}

function sanitizeRemoteOperator(operator, includeCode = false) {
  if (!operator) return null;
  return {
    id: operator.id,
    name: operator.name,
    profile: operator.profile,
    permissions: Array.isArray(operator.permissions) ? operator.permissions : getRemoteOperatorPermissions(operator.profile),
    remoteLink: includeCode ? (operator.remoteLink || '') : ''
  };
}

function cloneDisplayEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return {
    ...entry,
    translations: entry.translations ? { ...entry.translations } : {}
  };
}

function normalizeEvent(event, options = {}) {
  const includeSecrets = !!options.includeSecrets;
  const includeControlData = !!options.includeControlData || includeSecrets;
  const org = getOrganizationForEvent(event);
  ensureEventShortId(event);
  const payload = {
    id: event.id,
    shortId: event.shortId,
    organizationId: org.id,
    organization: buildPublicOrganization(org),
    name: event.name,
    sourceLang: event.sourceLang || 'ro',
    liveSourceLang: event.liveSourceLang || event.sourceLang || 'ro',
    targetLangs: Array.isArray(event.targetLangs) ? event.targetLangs : ['no', 'en'],
    speed: event.speed || 'balanced',
    participantLink: event.participantLink,
    translateLink: event.translateLink || '',
    songLink: event.songLink || '',
    qrCodeDataUrl: event.qrCodeDataUrl || '',
    transcripts: Array.isArray(event.transcripts) ? event.transcripts : [],
    glossary: event.glossary || {},
    sourceCorrections: event.sourceCorrections || {},
    audioMuted: !!event.audioMuted,
    audioVolume: typeof event.audioVolume === 'number' ? event.audioVolume : 70,
    createdAt: event.createdAt || new Date().toISOString(),
    scheduledAt: event.scheduledAt || null,
    scheduledDate: event.scheduledDate || null,
    scheduledTime: event.scheduledTime || null,
    timezone: event.timezone || null,
    scheduledTimestamp: typeof event.scheduledTimestamp === 'number' ? event.scheduledTimestamp : null,
    isActive: isEventActive(event),
    mode: event.mode || 'live',
    transcriptionPaused: !!event.transcriptionPaused,
    transcriptionOnAir: !!event.transcriptionOnAir,
    songState: event.songState || defaultSongState(),
    latestDisplayEntry: cloneDisplayEntry(event.latestDisplayEntry),
    displayState: event.displayState || defaultDisplayState(),
    displayStatePrevious: event.displayStatePrevious || null,
    usageStats: buildUsageStats(event.id),
    displayPresets: Array.isArray(event.displayPresets) ? event.displayPresets : [],
    songLibrary: Array.isArray(event.songLibrary) ? event.songLibrary : [],
    songHistory: Array.isArray(event.songHistory) ? event.songHistory : []
  };
  if (includeSecrets) {
    const globalAccess = ensureGlobalAccess('', event);
    payload.adminCode = event.adminCode;
    payload.screenOperatorCode = event.screenOperatorCode || '';
    payload.remoteControlLink = event.remoteControlLink || '';
    payload.mainOperatorCode = globalAccess.mainOperatorCode || '';
    payload.mainOperatorLink = event.mainOperatorLink || '';
    payload.remoteOperators = normalizeRemoteOperators(event.remoteOperators || []);
  }
  return payload;
}

function buildDisplayPayload(event) {
  ensureEventUiState(event);
  return {
    mode: event.displayState.mode,
    blackScreen: !!event.displayState.blackScreen,
    theme: event.displayState.theme,
    language: event.displayState.language,
    secondaryLanguage: event.displayState.secondaryLanguage || '',
    backgroundPreset: event.displayState.backgroundPreset,
    customBackground: event.displayState.customBackground,
    showClock: event.displayState.showClock,
    clockPosition: event.displayState.clockPosition,
    clockScale: event.displayState.clockScale || 1,
    textSize: event.displayState.textSize,
    textScale: event.displayState.textScale || 1,
    screenStyle: event.displayState.screenStyle,
    displayResolution: event.displayState.displayResolution || 'auto',
    sceneLabel: event.displayState.sceneLabel,
    manualSource: event.displayState.manualSource,
    manualSourceLang: event.displayState.manualSourceLang || event.sourceLang || 'ro',
    manualTranslations: event.displayState.manualTranslations,
    updatedAt: event.displayState.updatedAt,
    previousState: event.displayStatePrevious || null,
    presets: Array.isArray(event.displayPresets) ? event.displayPresets : []
  };
}

function normalizeDisplayPreset(input = {}) {
  const name = String(input.name || '').trim();
  if (!name) return null;
  const mode = ['auto', 'manual', 'song'].includes(input.mode) ? input.mode : 'auto';
  const theme = ['dark', 'light'].includes(input.theme) ? input.theme : 'dark';
  const backgroundPreset = ['none', 'warm', 'sanctuary', 'soft-light'].includes(input.backgroundPreset) ? input.backgroundPreset : 'none';
  const clockPosition = ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(input.clockPosition) ? input.clockPosition : 'top-right';
  const clockScale = typeof input.clockScale === 'number' ? Math.min(1.8, Math.max(0.7, input.clockScale)) : 1;
  const textSize = ['compact', 'large', 'xlarge'].includes(input.textSize) ? input.textSize : 'large';
  const textScale = normalizeDisplayTextScale(input.textScale, 1);
  const screenStyle = ['focus', 'wide'].includes(input.screenStyle) ? input.screenStyle : 'focus';
  const displayResolution = ['auto', '16-9', '16-10', '4-3'].includes(input.displayResolution) ? input.displayResolution : 'auto';
  const language = String(input.language || 'no').trim() || 'no';
  const secondaryLanguage = String(input.secondaryLanguage || '').trim();
  return {
    id: input.id || randomUUID(),
    name,
    mode,
    theme,
    language,
    secondaryLanguage: secondaryLanguage && secondaryLanguage !== language ? secondaryLanguage : '',
    backgroundPreset,
    customBackground: typeof input.customBackground === 'string' ? input.customBackground.trim() : '',
    showClock: !!input.showClock,
    clockPosition,
    clockScale,
    textSize,
    textScale,
    screenStyle,
    displayResolution,
    updatedAt: new Date().toISOString()
  };
}

const DISPLAY_SHORTCUTS = {
  welcome: {
    label: 'Welcome',
    mode: 'manual',
    theme: 'light',
    backgroundPreset: 'soft-light',
    customBackground: '',
    showClock: false,
    clockPosition: 'top-right',
    textSize: 'xlarge',
    screenStyle: 'wide'
  },
  worship: {
    label: 'Worship',
    mode: 'song',
    theme: 'dark',
    backgroundPreset: 'sanctuary',
    customBackground: '',
    showClock: false,
    clockPosition: 'top-right',
    textSize: 'xlarge',
    screenStyle: 'focus'
  },
  sermon: {
    label: 'Sermon',
    mode: 'auto',
    theme: 'dark',
    backgroundPreset: 'sanctuary',
    customBackground: '',
    showClock: false,
    clockPosition: 'top-right',
    textSize: 'large',
    screenStyle: 'focus'
  },
  prayer: {
    label: 'Prayer',
    mode: 'manual',
    theme: 'light',
    backgroundPreset: 'warm',
    customBackground: '',
    showClock: false,
    clockPosition: 'top-right',
    textSize: 'large',
    screenStyle: 'focus'
  },
  closing: {
    label: 'Closing',
    mode: 'manual',
    theme: 'light',
    backgroundPreset: 'warm',
    customBackground: '',
    showClock: false,
    clockPosition: 'top-right',
    textSize: 'large',
    screenStyle: 'wide'
  }
};

function normalizeLibraryTitle(title) {
  return String(title || '').trim().toLowerCase();
}

function upsertLibraryItem(list, { title, text, labels, sourceLang }, maxItems = 100) {
  const safeTitle = String(title || '').trim();
  const safeText = sanitizeStructuredText(text || '');
  const parsedSong = splitSongBlocksWithLabels(safeText, labels || []);
  const safeLabels = parsedSong.labels;
  const normalizedTitle = normalizeLibraryTitle(safeTitle);
  const existingIndex = list.findIndex((item) => normalizeLibraryTitle(item.title) === normalizedTitle);
  const payload = {
    id: existingIndex >= 0 ? list[existingIndex].id : randomUUID(),
    title: safeTitle,
    text: safeText,
    labels: safeLabels,
    sourceLang: String(sourceLang || list[existingIndex]?.sourceLang || 'ro').trim() || 'ro',
    updatedAt: new Date().toISOString()
  };

  if (existingIndex >= 0) {
    list[existingIndex] = payload;
  } else {
    list.unshift(payload);
  }

  if (list.length > maxItems) {
    list.splice(maxItems);
  }

  return payload;
}

function requireEventAdmin(req, res, event) {
  return requireEventRole(req, res, event, ['admin']);
}

function getSuppliedEventCode(req) {
  return String(
    req.body?.code
    || req.query?.code
    || req.headers['x-access-code']
    || req.headers['x-screen-code']
    || req.headers['x-admin-code']
    || ''
  ).trim();
}

function resolveEventAccessFromCode(event, code) {
  const suppliedCode = String(code || '').trim();
  if (!suppliedCode) return { role: '', permissions: [], operator: null };
  const globalAccess = ensureGlobalAccess('', event);
  if (MASTER_ADMIN_PIN && suppliedCode === MASTER_ADMIN_PIN) {
    return { role: 'admin', permissions: ['main_screen', 'song'], operator: null };
  }
  if (String(event.adminCode || '') === suppliedCode) {
    return { role: 'admin', permissions: ['main_screen', 'song'], operator: null };
  }
  if (MASTER_MODERATOR_PIN && suppliedCode === MASTER_MODERATOR_PIN) {
    return {
      role: 'screen',
      permissions: ['main_screen', 'song'],
      operator: { id: 'master-moderator', name: 'Master Moderator', profile: 'full', code: suppliedCode }
    };
  }
  if (globalAccess.mainOperatorCode && suppliedCode === globalAccess.mainOperatorCode) {
    return {
      role: 'screen',
      permissions: ['main_screen', 'song'],
      operator: { id: 'main-operator', name: 'Main Operator', profile: 'full', code: suppliedCode, permanent: true }
    };
  }
  if (String(event.screenOperatorCode || '') === suppliedCode) {
    return {
      role: 'screen',
      permissions: ['main_screen', 'song'],
      operator: { id: 'default-screen', name: 'Default operator', profile: 'full', code: suppliedCode }
    };
  }
  const operator = (event.remoteOperators || []).find((item) => String(item.code || '') === suppliedCode);
  if (operator) {
    return {
      role: 'screen',
      permissions: getRemoteOperatorPermissions(operator.profile),
      operator
    };
  }
  const granted = (getOrganizationForEvent(event)?.grantedOperators || [])
    .find((entry) => String(entry?.code || '').trim() === suppliedCode);
  if (granted) {
    return {
      role: 'screen',
      permissions: getRemoteOperatorPermissions(granted.profile),
      operator: {
        id: granted.id || `granted-${suppliedCode}`,
        name: granted.name || 'Operator',
        profile: normalizeRemoteOperatorProfile(granted.profile),
        code: suppliedCode
      }
    };
  }
  return { role: '', permissions: [], operator: null };
}

function requireEventRole(req, res, event, allowedRoles = ['admin']) {
  if (allowedRoles.includes('admin') && hasValidAdminSession(req) && getEventOrgId(event) === DEFAULT_ORG_ID) {
    const access = { role: 'admin', permissions: ['main_screen', 'song'], operator: null };
    req.eventRole = access.role;
    req.eventAccess = access;
    return access.role;
  }
  const access = resolveEventAccessFromCode(event, getSuppliedEventCode(req));
  if (!allowedRoles.includes(access.role)) {
    res.status(403).json({ ok: false, error: 'Cod de acces invalid.' });
    return false;
  }
  req.eventRole = access.role;
  req.eventAccess = access;
  return access.role;
}

function requireEventPermission(req, res, permission) {
  if (req.eventRole === 'admin') return true;
  if ((req.eventAccess?.permissions || []).includes(permission)) return true;
  res.status(403).json({ ok: false, error: 'Operatorul nu are permisiunea pentru aceasta actiune.' });
  return false;
}

function canManageEvents(req) {
  if (hasValidAdminSession(req)) return true;
  const suppliedCode = getSuppliedEventCode(req);
  if (MASTER_ADMIN_PIN && suppliedCode === MASTER_ADMIN_PIN) return true;
  const appAdminCode = String(process.env.APP_ADMIN_CODE || process.env.ADMIN_CODE || '').trim();
  if (appAdminCode && suppliedCode === appAdminCode) return true;
  const events = Object.values(db.events || {});
  if (!events.length && !appAdminCode && !MASTER_ADMIN_PIN && !COMMERCIAL_MODE) return true;
  return events.some((event) => String(event.adminCode || '') === suppliedCode);
}

function requireEventManager(req, res) {
  if (canManageEvents(req)) return true;
  res.status(403).json({ ok: false, error: 'Cod Admin necesar pentru administrarea evenimentelor.' });
  return false;
}

function requireGlobalLibraryAdmin(req, res) {
  if (canManageEvents(req)) return true;
  res.status(403).json({ ok: false, error: 'Cod Admin necesar pentru modificarea bibliotecii.' });
  return false;
}

function normalizeSocketOperator(operator) {
  return operator ? sanitizeRemoteOperator(operator, false) : null;
}

function normalizeEventForAccess(req, event) {
  return normalizeEvent(event, {
    includeSecrets: req.eventRole === 'admin',
    includeControlData: ['admin', 'screen'].includes(req.eventRole)
  });
}

function socketCanControlEvent(socket, eventId, permission = '') {
  if (socket.data.eventId !== eventId) return false;
  if (socket.data.role === 'admin') return true;
  if (socket.data.role !== 'screen') return false;
  if (!permission) return true;
  return (socket.data.permissions || []).includes(permission);
}

function normalizePublicBaseUrl(value) {
  const clean = String(value || '').trim().replace(/\/+$/, '');
  if (!clean) return '';
  if (!/^https?:\/\//i.test(clean)) return `https://${clean}`;
  return clean;
}

function isLocalRequestHost(host = '') {
  const cleanHost = String(host || '').split(':')[0].toLowerCase();
  return cleanHost === 'localhost' || cleanHost === '127.0.0.1' || cleanHost === '::1';
}

function buildRequestBaseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = req.get('host');
  return `${proto}://${host}`;
}

function buildBaseUrl(req) {
  const host = req.get('host') || '';
  if (PUBLIC_BASE_URL && !isLocalRequestHost(host)) return PUBLIC_BASE_URL;
  return buildRequestBaseUrl(req);
}

function ensureEventAccessLinks(event, baseUrl) {
  if (!event.screenOperatorCode) {
    event.screenOperatorCode = `SV-SCREEN-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  }
  ensureEventShortId(event);
  event.remoteOperators = normalizeRemoteOperators(event.remoteOperators || []);
  if (baseUrl) {
    const globalAccess = ensureGlobalAccess(baseUrl, event);
    const newParticipantLink = `${baseUrl}/participant?event=${event.id}`;
    if (event.participantLink !== newParticipantLink) {
      event.participantLink = newParticipantLink;
      QRCode.toDataURL(newParticipantLink).then((dataUrl) => { event.qrCodeDataUrl = dataUrl; }).catch(() => {});
    }
    event.translateLink = `${baseUrl}/translate?event=${event.id}`;
    event.songLink = `${baseUrl}/song?event=${event.id}`;
    event.mainOperatorLink = globalAccess.mainOperatorLink;
    event.remoteControlLink = `${baseUrl}/remote?event=${event.id}&code=${encodeURIComponent(event.screenOperatorCode)}`;
    event.remoteOperators = event.remoteOperators.map((operator) => ({
      ...operator,
      remoteLink: buildRemoteOperatorLink(baseUrl, event.id, operator)
    }));
  }
}

const EVENT_SHORT_ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const EVENT_SHORT_ID_LENGTH = 8;

function generateEventShortId() {
  const events = db.events || {};
  for (let attempt = 0; attempt < 12; attempt += 1) {
    let candidate = '';
    for (let i = 0; i < EVENT_SHORT_ID_LENGTH; i += 1) {
      candidate += EVENT_SHORT_ID_ALPHABET[Math.floor(Math.random() * EVENT_SHORT_ID_ALPHABET.length)];
    }
    const taken = Object.values(events).some((e) => String(e?.shortId || '').toUpperCase() === candidate);
    if (!taken) return candidate;
  }
  return `${Date.now().toString(36).toUpperCase().slice(-8)}`.padStart(8, 'X').slice(-8);
}

function normalizeEventShortIdInput(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function ensureEventShortId(event) {
  if (!event) return null;
  if (typeof event.shortId === 'string' && event.shortId.trim()) {
    const normalized = normalizeEventShortIdInput(event.shortId);
    if (normalized && normalized.length >= 4) {
      if (event.shortId !== normalized) event.shortId = normalized;
      return event.shortId;
    }
  }
  event.shortId = generateEventShortId();
  return event.shortId;
}

function findEventByIdOrShortId(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (db.events[raw]) return db.events[raw];
  const normalized = normalizeEventShortIdInput(raw);
  if (!normalized) return null;
  for (const event of Object.values(db.events || {})) {
    if (event && normalizeEventShortIdInput(event.shortId) === normalized) return event;
  }
  return null;
}

function isValidIanaTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (err) {
    return false;
  }
}

function getTimezoneOffsetMinutes(timeZone, date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric'
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return (asUtc - date.getTime()) / 60000;
}

function zonedTimeToUtcMs(year, month, day, hour, minute, timeZone) {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 2; i += 1) {
    const offset = getTimezoneOffsetMinutes(timeZone, new Date(guess));
    guess = Date.UTC(year, month - 1, day, hour, minute) - offset * 60000;
  }
  return guess;
}

function computeScheduledTimestamp(scheduledDate, scheduledTime, timezone) {
  const dateMatch = String(scheduledDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) return null;
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const timeStr = String(scheduledTime || '00:00').trim();
  const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})/);
  if (!timeMatch) return null;
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const tz = isValidIanaTimezone(timezone) ? timezone : 'UTC';
  const ms = zonedTimeToUtcMs(year, month, day, hour, minute, tz);
  return Number.isFinite(ms) ? ms : null;
}

function deriveScheduledFields({ scheduledDate, scheduledTime, timezone, scheduledAt }) {
  let date = String(scheduledDate || '').trim() || '';
  let time = String(scheduledTime || '').trim() || '';
  let tz = isValidIanaTimezone(timezone) ? String(timezone).trim() : '';
  if ((!date || !time) && scheduledAt) {
    const match = String(scheduledAt).match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/);
    if (match) {
      if (!date) date = match[1];
      if (!time) time = `${match[2]}:${match[3]}`;
    }
  }
  const timestamp = date ? computeScheduledTimestamp(date, time || '00:00', tz || 'UTC') : null;
  const isoAt = timestamp ? new Date(timestamp).toISOString() : (scheduledAt || null);
  return {
    scheduledDate: date || null,
    scheduledTime: time || null,
    timezone: tz || null,
    scheduledTimestamp: timestamp,
    scheduledAt: isoAt
  };
}

async function createEvent({ name, speed, sourceLang, targetLangs, baseUrl, scheduledAt, scheduledDate, scheduledTime, timezone, organizationId = DEFAULT_ORG_ID }) {
  const organization = ensureOrganization(organizationId);
  const id = randomUUID();
  const adminCode = `SV-ADMIN-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const screenOperatorCode = `SV-SCREEN-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const participantLink = `${baseUrl}/participant?event=${id}`;
  const translateLink = `${baseUrl}/translate?event=${id}`;
  const songLink = `${baseUrl}/song?event=${id}`;
  const mainOperatorLink = ensureGlobalAccess(baseUrl, organization.id).mainOperatorLink;
  const remoteControlLink = `${baseUrl}/remote?event=${id}&code=${encodeURIComponent(screenOperatorCode)}`;
  const qrCodeDataUrl = await QRCode.toDataURL(participantLink);

  const scheduling = deriveScheduledFields({ scheduledDate, scheduledTime, timezone, scheduledAt });

  const event = {
    id,
    shortId: generateEventShortId(),
    organizationId: organization.id,
    name: name || 'Eveniment nou',
    sourceLang: sourceLang || 'ro',
    liveSourceLang: sourceLang || 'ro',
    targetLangs: targetLangs?.length ? targetLangs : ['no', 'en'],
    speed: speed || 'balanced',
    scheduledAt: scheduling.scheduledAt,
    scheduledDate: scheduling.scheduledDate,
    scheduledTime: scheduling.scheduledTime,
    timezone: scheduling.timezone,
    scheduledTimestamp: scheduling.scheduledTimestamp,
    adminCode,
    screenOperatorCode,
    remoteOperators: [],
    participantLink,
    translateLink,
    songLink,
    mainOperatorLink,
    remoteControlLink,
    qrCodeDataUrl,
    transcripts: [],
    glossary: {},
    sourceCorrections: {},
    audioMuted: true,
    audioVolume: 70,
    createdAt: new Date().toISOString(),
    lastTranscriptNorm: '',
    mode: 'live',
    transcriptionPaused: false,
    transcriptionOnAir: false,
    pushSubscriptions: [],
    songState: defaultSongState(),
    latestDisplayEntry: null,
    displayState: { ...defaultDisplayState(), language: (targetLangs?.length ? targetLangs[0] : 'no') },
    displayStatePrevious: null,
    songLibrary: defaultSongLibrary(),
    songHistory: defaultSongHistory(),
    usageStats: defaultUsageStats()
  };

  db.events[id] = event;
  setActiveEventIdForOrg(organization.id, id);
  saveDb();
  setImmediate(() => io.emit('active_event_changed', { eventId: id }));
  return event;
}

function applyReplacementMap(text, map) {
  let out = String(text || '');
  const entries = Object.entries(map || {})
    .filter(([key, value]) => key && value)
    .sort((a, b) => b[0].length - a[0].length);
  for (const [key, value] of entries) {
    const safe = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = /[\p{L}\p{N}]/u.test(key)
      ? new RegExp(`(?<![\\p{L}\\p{N}])${safe}(?![\\p{L}\\p{N}])`, 'giu')
      : new RegExp(safe, 'gi');
    out = out.replace(pattern, value);
  }
  return out;
}

const translationCache = new Map();
const TRANSLATION_CACHE_LIMIT = 2000;

function getGlossaryCacheKey(glossary = {}) {
  return Object.entries(glossary || {})
    .filter(([source, target]) => source && target)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([source, target]) => `${source}=>${target}`)
    .join('||');
}

function buildTranslationCacheKey({ text, langCode, sourceLang, speed, glossary }) {
  return [
    String(sourceLang || ''),
    String(langCode || ''),
    String(speed || ''),
    getGlossaryCacheKey(glossary),
    sanitizeStructuredText(text || '')
  ].join('::');
}

function readTranslationCache(key) {
  if (!translationCache.has(key)) return null;
  const value = translationCache.get(key);
  translationCache.delete(key);
  translationCache.set(key, value);
  return value;
}

function writeTranslationCache(key, value) {
  if (!key || !value) return;
  if (translationCache.has(key)) translationCache.delete(key);
  translationCache.set(key, value);
  while (translationCache.size > TRANSLATION_CACHE_LIMIT) {
    const firstKey = translationCache.keys().next().value;
    translationCache.delete(firstKey);
  }
}

function buildAccessCode(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

function ensureGlobalAccess(baseUrl = '', eventOrOrgId = DEFAULT_ORG_ID) {
  const access = getOrganizationAccess(eventOrOrgId);
  const configuredCode = MAIN_OPERATOR_PIN;
  if (configuredCode && access.mainOperatorCode !== configuredCode) {
    access.mainOperatorCode = configuredCode;
  }
  if (!access.mainOperatorCode) {
    access.mainOperatorCode = buildAccessCode('SV-MAIN');
  }
  const mainOperatorCode = String(access.mainOperatorCode || '').trim();
  return {
    mainOperatorCode,
    mainOperatorLink: baseUrl && mainOperatorCode
      ? `${baseUrl}/remote?code=${encodeURIComponent(mainOperatorCode)}`
      : ''
  };
}

function updateTranslationMonitor(event, patch = {}, shouldEmit = true) {
  if (!TRANSLATION_MONITOR_ENABLED) return;
  if (!event) return;
  ensureEventUiState(event);
  event.translationMonitor = {
    ...event.translationMonitor,
    ...patch
  };
  if (shouldEmit && event.id) emitTranslationMonitor(event.id);
}

function getGlossaryForLang(langCode, event) {
  const langMemory = {};
  for (const [key, value] of Object.entries(getOrganizationMemory(event) || {})) {
    const prefix = `${langCode.toUpperCase()}::`;
    if (key.startsWith(prefix)) langMemory[key.slice(prefix.length)] = value;
  }
  return { ...langMemory, ...(event.glossary?.[langCode] || {}) };
}

function getSourceCorrections(event) {
  const corrections = {};
  for (const [key, value] of Object.entries(getOrganizationMemory(event) || {})) {
    const prefix = 'SRC::';
    if (key.startsWith(prefix)) corrections[key.slice(prefix.length)] = value;
  }
  return { ...corrections, ...(event.sourceCorrections || {}) };
}

function applyGlossary(text, glossary) {
  return applyReplacementMap(text, glossary);
}

function applySourceCorrections(text, corrections) {
  return applyReplacementMap(text, corrections);
}

function buildPrompt(sourceLangName, targetLangName, speed, glossary) {
  const speedRules = {
    rapid: 'Translate fast, naturally, and as spoken language.',
    balanced: 'Translate naturally, smoothly, and clearly for live listening.',
    clear: 'Translate carefully and clearly for church live listening. Keep it fluid, not rigid.'
  };

  const glossaryText = Object.entries(glossary || {})
    .filter(([a, b]) => a && b)
    .map(([a, b]) => `- ${a} => ${b}`)
    .join('\n');

  return [
    'You are a live interpreter for church services.',
    `Translate from ${sourceLangName} to ${targetLangName}.`,
    'Return only the translation.',
    'Translate naturally, smoothly, and conversationally.',
    'Do not translate too literally.',
    'Do not use ellipses.',
    speedRules[speed] || speedRules.balanced,
    glossaryText ? `Use these glossary replacements exactly:\n${glossaryText}` : ''
  ].filter(Boolean).join('\n\n');
}


async function buildTranslationsForAllTargets(text, event, sourceLangOverride = '') {
  const clean = sanitizeStructuredText(text);
  if (!clean) return {};

  const blocks = clean
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);

  const translationPairs = await Promise.all(
    (event.targetLangs || []).map(async (lang) => {
      if (!blocks.length) return [lang, ''];
      const translatedBlocks = await Promise.all(blocks.map((block) => translateText(block, lang, event, sourceLangOverride)));
      return [lang, translatedBlocks.join('\n\n').trim()];
    })
  );
  return Object.fromEntries(translationPairs);
}

function pushSongHistory(event, item) {
  ensureEventUiState(event);
  event.songHistory.unshift({
    id: randomUUID(),
    title: String(item.title || '').trim(),
    kind: String(item.kind || 'song').trim(),
    source: sanitizeStructuredText(item.source || ''),
    translations: item.translations || {},
    createdAt: new Date().toISOString()
  });
  if (event.songHistory.length > 50) {
    event.songHistory = event.songHistory.slice(0, 50);
  }
}

async function translateText(text, langCode, event, sourceLangOverride = '') {
  const glossary = getGlossaryForLang(langCode, event);
  const cleanText = sanitizeStructuredText(text);
  const sourceLang = String(sourceLangOverride || event.sourceLang || 'ro').trim() || 'ro';
  if (!cleanText) return '';
  if (langCode === sourceLang) return cleanText;
  const cacheKey = buildTranslationCacheKey({
    text: cleanText,
    langCode,
    sourceLang,
    speed: event.speed,
    glossary
  });
  const cachedTranslation = readTranslationCache(cacheKey);
  if (cachedTranslation) {
    updateTranslationMonitor(event, {
      lastCacheHitAt: new Date().toISOString(),
      lastCacheHitLang: langCode,
      lastTargetLang: langCode
    });
    return cachedTranslation;
  }
  if (!client) {
    updateTranslationMonitor(event, {
      lastTranslateFinishedAt: new Date().toISOString(),
      lastTargetLang: langCode
    });
    return `[${langCode}] ${applyGlossary(cleanText, glossary)}`;
  }
  const startedAt = Date.now();
  updateTranslationMonitor(event, {
    pendingTranslations: Math.max(0, Number(event.translationMonitor?.pendingTranslations || 0)) + 1,
    lastTranslateStartedAt: new Date(startedAt).toISOString(),
    lastTargetLang: langCode,
    lastBatchText: cleanText.slice(0, 220),
    lastBatchSourceLang: sourceLang
  });
  try {
    const translatedText = await translationService.translateWithResponses({
      model: OPENAI_MODEL,
      input: [
        { role: 'system', content: buildPrompt(LANGUAGES[sourceLang] || sourceLang, LANGUAGES[langCode] || langCode, event.speed, glossary) },
        { role: 'user', content: cleanText }
      ]
    });
    const translated = sanitizeStructuredText(translatedText);
    if (translated) {
      writeTranslationCache(cacheKey, translated);
      updateTranslationMonitor(event, {
        pendingTranslations: Math.max(0, Number(event.translationMonitor?.pendingTranslations || 1) - 1),
        lastTranslateFinishedAt: new Date().toISOString(),
        lastTranslateDurationMs: Date.now() - startedAt,
        lastTargetLang: langCode
      });
      return translated;
    }
    const fallback = applyGlossary(cleanText, glossary);
    writeTranslationCache(cacheKey, fallback);
    updateTranslationMonitor(event, {
      pendingTranslations: Math.max(0, Number(event.translationMonitor?.pendingTranslations || 1) - 1),
      lastTranslateFinishedAt: new Date().toISOString(),
      lastTranslateDurationMs: Date.now() - startedAt,
      lastTargetLang: langCode
    });
    return fallback;
  } catch (err) {
    logger.error(`translate error ${langCode}:`, err?.message || err);
    recordServerError(event, `Translate ${langCode} failed.`);
    const fallback = `[${langCode}] ${applyGlossary(cleanText, glossary)}`;
    writeTranslationCache(cacheKey, fallback);
    updateTranslationMonitor(event, {
      pendingTranslations: Math.max(0, Number(event.translationMonitor?.pendingTranslations || 1) - 1),
      lastTranslateFinishedAt: new Date().toISOString(),
      lastTranslateDurationMs: Date.now() - startedAt,
      lastTargetLang: langCode
    });
    return fallback;
  }
}

function detectSourceLangByScript(text) {
  const sample = String(text || '');
  if (/[\u0370-\u03ff]/.test(sample)) return 'el';
  if (/[\u0600-\u06ff]/.test(sample)) return 'ar';
  if (/[\u0400-\u04ff]/.test(sample)) return 'ru';
  if (/[æøåÆØÅ]/.test(sample)) return 'no';
  if (/[ăâîșşțţĂÂÎȘŞȚŢ]/.test(sample)) return 'ro';
  return '';
}

async function detectSourceLanguage(text, event) {
  const configured = String(event.liveSourceLang || 'auto').trim();
  if (configured && configured !== 'auto' && LANGUAGES[configured]) return configured;

  const scriptGuess = detectSourceLangByScript(text);
  if (scriptGuess && LANGUAGES[scriptGuess]) return scriptGuess;

  const fallback = event.sourceLang || 'ro';
  if (!client) return fallback;

  const candidates = Array.from(new Set([
    fallback,
    ...(event.targetLangs || []),
    'ro', 'no', 'en', 'ru', 'uk', 'es', 'fr', 'de', 'it', 'pt', 'pl', 'tr', 'ar', 'fa', 'hu', 'el'
  ].filter((code) => LANGUAGES[code])));

  try {
    const detectedCode = await translationService.translateWithResponses({
      model: OPENAI_MODEL,
      input: [
        {
          role: 'system',
          content: `Detect the language of the text. Return only one ISO code from this list: ${candidates.join(', ')}.`
        },
        { role: 'user', content: sanitizeStructuredText(text).slice(0, 700) }
      ]
    });
    const code = String(detectedCode || '').trim().toLowerCase().replace(/[^a-z]/g, '');
    return candidates.includes(code) ? code : fallback;
  } catch (err) {
    logger.error('source language detect error:', err?.message || err);
    return fallback;
  }
}

function getActiveSpeechProvider() {
  if (SPEECH_PROVIDER === 'azure' || SPEECH_PROVIDER === 'azure_sdk') {
    return AZURE_SPEECH_KEY && AZURE_SPEECH_REGION ? 'azure_sdk' : 'openai';
  }
  return 'openai';
}

const AZURE_SPEECH_LOCALES = {
  ro: 'ro-RO',
  no: 'nb-NO',
  ru: 'ru-RU',
  uk: 'uk-UA',
  en: 'en-US',
  es: 'es-ES',
  fr: 'fr-FR',
  de: 'de-DE',
  it: 'it-IT',
  pt: 'pt-PT',
  pl: 'pl-PL',
  tr: 'tr-TR',
  ar: 'ar-SA',
  fa: 'fa-IR',
  hu: 'hu-HU',
  el: 'el-GR'
};

function getSpeechLocale(code) {
  return AZURE_SPEECH_LOCALES[code] || AZURE_SPEECH_LOCALES.ro;
}

function classifyAzureSpeechError(details = '') {
  const text = String(details || '').toLowerCase();
  if (
    text.includes('401')
    || text.includes('403')
    || text.includes('auth')
    || text.includes('authorization')
    || text.includes('unauthorized')
    || text.includes('forbidden')
    || text.includes('invalid subscription')
    || text.includes('subscription key')
    || text.includes('credential')
  ) {
    return {
      code: 'azure_auth_failed',
      message: 'Azure Speech authentication failed. Switching to OpenAI backup.',
      fallbackToOpenAI: true
    };
  }
  if (text.includes('quota') || text.includes('too many requests') || text.includes('429')) {
    return {
      code: 'azure_quota_exceeded',
      message: 'Azure Speech quota exceeded. Switching to OpenAI backup.',
      fallbackToOpenAI: true
    };
  }
  return {
    code: 'azure_canceled',
    message: 'Azure Speech s-a oprit. Verifica setarile Azure.',
    fallbackToOpenAI: false
  };
}

function loadAzureSpeechSdk() {
  try {
    return require('microsoft-cognitiveservices-speech-sdk');
  } catch (err) {
    logger.error('azure speech sdk missing:', err?.message || err);
    return null;
  }
}

async function transcribeAudioFile(filePath, event) {
  if (!client) return { text: '', sourceLang: event.sourceLang || 'ro' };
  const configured = String(event.liveSourceLang || event.sourceLang || 'ro').trim();
  const shouldDetectLanguage = !configured || configured === 'auto';
  const effectiveSourceLang = shouldDetectLanguage ? (event.sourceLang || 'ro') : configured;
  const request = {
    file: null,
    model: OPENAI_TRANSCRIBE_MODEL,
    response_format: 'json',
    prompt:
      effectiveSourceLang === 'no'
        ? 'The audio is a Christian sermon in Norwegian. Keep the transcript in Norwegian. Use natural punctuation. Common terms may include Jesus, Kristus, Herren, Den Hellige Ånd, menighet, evangeliet, apostel, nåde, kjærlighet, synd, frelse.'
        : 'The audio is a live church service or sermon. Keep the transcript in the selected source language. Keep names and punctuation natural.'
  };
  if (!shouldDetectLanguage && LANGUAGES[effectiveSourceLang]) request.language = effectiveSourceLang;
  const text = await translationService.transcribeAudioFile({
    filePath,
    model: request.model,
    prompt: request.prompt,
    language: request.language
  });
  return {
    text,
    sourceLang: shouldDetectLanguage ? await detectSourceLanguage(text, event) : effectiveSourceLang
  };
}

async function retranslateEntry(event, entry) {
  const sourceLang = entry.sourceLang || event.sourceLang || 'ro';
  const translationPairs = await Promise.all(
    event.targetLangs.map(async (lang) => [lang, await translateText(entry.original, lang, event, sourceLang)])
  );
  entry.translations = Object.fromEntries(translationPairs);
}

function shouldAppendToPreviousEntry(previousEntry, newText) {
  const clean = sanitizeTranscriptText(newText);
  if (!previousEntry || !clean) return false;
  const words = countWords(clean);
  const previousText = sanitizeTranscriptText(previousEntry.original || '');
  const previousLast = getLastWord(previousText);
  const ageMs = Math.abs(Date.now() - new Date(previousEntry.createdAt || Date.now()).getTime());
  if (ageMs > 20000) return false;
  if (startsLikeContinuation(clean)) return true;
  if (BUFFER_CONNECTORS.has(previousLast)) return true;
  if (words <= 5) return true;
  return false;
}

async function publishNewChunk(event, chunk, sourceLangOverride = '') {
  const cleanChunk = sanitizeTranscriptText(chunk);
  if (!cleanChunk) return null;
  const chunkNormalized = normalizeChunkText(cleanChunk);
  if (!chunkNormalized || chunkNormalized.length < 2) return null;

  const sourceLang = sourceLangOverride || event.sourceLang || 'ro';
  const translationPairs = await Promise.all(
    event.targetLangs.map(async (lang) => [lang, await translateText(cleanChunk, lang, event, sourceLang)])
  );

  const entry = {
    id: randomUUID(),
    sourceLang,
    original: cleanChunk,
    translations: Object.fromEntries(translationPairs),
    createdAt: new Date().toISOString(),
    edited: false
  };

  event.lastTranscriptNorm = chunkNormalized;
  event.transcripts.push(entry);
  if (event.transcripts.length > 300) event.transcripts = event.transcripts.slice(-300);
  ensureEventUiState(event);
  recordTranscriptCreated(event);
  updateTranslationMonitor(event, {
    lastDeliveredAt: new Date().toISOString(),
    lastDeliveredPreview: cleanChunk.slice(0, 220),
    lastDeliveryTargetCount: Array.isArray(event.targetLangs) ? event.targetLangs.length : 0
  }, false);
  event.latestDisplayEntry = cloneDisplayEntry(entry);
  saveDb();
  io.to(`event:${event.id}`).emit('transcript_entry', entry);
  if (event.displayState?.mode === 'auto') {
    io.to(`event:${event.id}`).emit('display_live_entry', cloneDisplayEntry(event.latestDisplayEntry));
  }
  emitUsageStats(event.id);
  emitTranslationMonitor(event.id);
  return entry;
}

async function processText(event, cleanText, { force = false, sourceLang = '' } = {}) {
  const normalized = normalizeChunkText(cleanText);
  if (!normalized || normalized.length < 2) return null;
  if (!force && normalized === event.lastTranscriptNorm) return null;
  const entrySourceLang = sourceLang || event.sourceLang || 'ro';

  const lastEntry = event.transcripts[event.transcripts.length - 1];
  if (lastEntry?.sourceLang === entrySourceLang && shouldAppendToPreviousEntry(lastEntry, cleanText)) {
    const combinedText = sanitizeTranscriptText(`${lastEntry.original} ${cleanText}`);
    const chunks = splitIntoDisplayChunks(combinedText);
    const firstChunk = chunks.shift() || combinedText;
    lastEntry.sourceLang = entrySourceLang;
    lastEntry.original = firstChunk;
    await retranslateEntry(event, lastEntry);
    event.lastTranscriptNorm = normalizeChunkText(firstChunk);
    saveDb();

    io.to(`event:${event.id}`).emit('transcript_source_updated', {
      entryId: lastEntry.id,
      sourceLang: lastEntry.sourceLang,
      original: lastEntry.original,
      translations: lastEntry.translations
    });
    updateTranslationMonitor(event, {
      lastDeliveredAt: new Date().toISOString(),
      lastDeliveredPreview: firstChunk.slice(0, 220),
      lastDeliveryTargetCount: Array.isArray(event.targetLangs) ? event.targetLangs.length : 0
    }, false);
    emitTranslationMonitor(event.id);

    let lastCreatedEntry = lastEntry;
    for (const extraChunk of chunks) {
      const created = await publishNewChunk(event, extraChunk, entrySourceLang);
      if (created) lastCreatedEntry = created;
    }
    return lastCreatedEntry;
  }

  const chunks = splitIntoDisplayChunks(cleanText);
  let lastCreatedEntry = null;
  for (const chunk of chunks) {
    const created = await publishNewChunk(event, chunk, entrySourceLang);
    if (created) lastCreatedEntry = created;
  }
  return lastCreatedEntry;
}

async function flushSpeechBuffer(eventId, force = false) {
  const buffered = speechBuffers.get(eventId);
  if (!buffered) return null;
  if (buffered.timer) clearTimeout(buffered.timer);

  const event = db.events[eventId];
  if (!event) {
    speechBuffers.delete(eventId);
    return null;
  }

  const text = sanitizeTranscriptText(buffered.text);
  if (!text) {
    speechBuffers.delete(eventId);
    return null;
  }

  const words = countWords(text);
  const last = getLastWord(text);
  const provider = buffered.provider || getActiveSpeechProvider();
  const targetWords = provider === 'azure_sdk' ? AZURE_LIVE_TEXT_TARGET_WORDS : LIVE_TEXT_TARGET_WORDS;
  const softWaitMs = provider === 'azure_sdk' ? AZURE_LIVE_TEXT_SOFT_WAIT_MS : LIVE_TEXT_SOFT_WAIT_MS;

  if (!force) {
    if (startsLikeContinuation(text) && words < targetWords) {
    buffered.timer = setTimeout(() => flushSpeechBuffer(eventId, true).catch(logger.error), softWaitMs);
      speechBuffers.set(eventId, buffered);
      return null;
    }
    if (BUFFER_CONNECTORS.has(last) && words < targetWords) {
    buffered.timer = setTimeout(() => flushSpeechBuffer(eventId, true).catch(logger.error), softWaitMs);
      speechBuffers.set(eventId, buffered);
      return null;
    }
  }

  speechBuffers.delete(eventId);
  updateTranslationMonitor(event, {
    lastFlushAt: new Date().toISOString(),
    lastBatchText: text.slice(0, 220),
    lastBatchSourceLang: buffered.sourceLang || event.sourceLang || 'ro'
  }, false);
  io.to(`event:${eventId}:admins`).emit('partial_transcript', { text: '' });
  emitTranslationMonitor(eventId);
  return processText(event, text, { force: true, sourceLang: buffered.sourceLang || event.sourceLang || 'ro' });
}

function queueSpeechText(eventId, text, sourceLang = '', provider = getActiveSpeechProvider()) {
  const clean = sanitizeTranscriptText(text);
  if (!clean) return;
  const event = db.events[eventId];

  const prev = speechBuffers.get(eventId) || { text: '', timer: null, startedAt: Date.now(), sourceLang, provider };
  const merged = mergeTranscriptText(prev.text, clean);
  if (prev.timer) clearTimeout(prev.timer);

  const nextProvider = provider || prev.provider || getActiveSpeechProvider();
  const flushOptions = nextProvider === 'azure_sdk'
    ? { minWords: AZURE_LIVE_TEXT_MIN_WORDS, targetWords: AZURE_LIVE_TEXT_TARGET_WORDS, maxWords: AZURE_LIVE_TEXT_MAX_WORDS }
    : {};
  const hardWaitMs = nextProvider === 'azure_sdk' ? AZURE_LIVE_TEXT_HARD_WAIT_MS : LIVE_TEXT_HARD_WAIT_MS;
  const softWaitMs = nextProvider === 'azure_sdk' ? AZURE_LIVE_TEXT_SOFT_WAIT_MS : LIVE_TEXT_SOFT_WAIT_MS;
  const maxWords = nextProvider === 'azure_sdk' ? AZURE_LIVE_TEXT_MAX_WORDS : LIVE_TEXT_MAX_WORDS;
  const next = { text: merged, timer: null, startedAt: prev.startedAt || Date.now(), sourceLang: sourceLang || prev.sourceLang || '', provider: nextProvider };
  speechBuffers.set(eventId, next);
  if (event) {
    updateTranslationMonitor(event, {
      lastSpeechReceivedAt: new Date().toISOString(),
      lastSpeechSourceLang: sourceLang || prev.sourceLang || event.sourceLang || 'ro',
      lastSpeechProvider: nextProvider,
      lastSpeechPreview: clean.slice(0, 220),
      lastBufferedAt: new Date().toISOString(),
      lastBufferedText: merged.slice(0, 220)
    }, false);
  }
  io.to(`event:${eventId}:admins`).emit('partial_transcript', { text: merged });
  emitTranslationMonitor(eventId);

  const ageMs = Date.now() - next.startedAt;
  const words = countWords(merged);
  if (shouldFlushBufferedText(merged, flushOptions)) {
  flushSpeechBuffer(eventId, false).catch(logger.error);
    return;
  }
  if (ageMs > hardWaitMs || words >= maxWords) {
  flushSpeechBuffer(eventId, true).catch(logger.error);
    return;
  }
  next.timer = setTimeout(() => flushSpeechBuffer(eventId, true).catch(logger.error), softWaitMs);
}

function closeAzureSpeechSession(socketId) {
  const session = azureSpeechSessions.get(socketId);
  if (!session) return;
  azureSpeechSessions.delete(socketId);
  try { session.pushStream?.close(); } catch (_) {}
  try {
    session.recognizer?.stopContinuousRecognitionAsync(
      () => session.recognizer?.close?.(),
      () => session.recognizer?.close?.()
    );
  } catch (_) {
    try { session.recognizer?.close?.(); } catch (__) {}
  }
}

function closeAzureSpeechSessionsForEvent(eventId, exceptSocketId = '') {
  for (const [socketId, session] of azureSpeechSessions.entries()) {
    if (session?.eventId === eventId && socketId !== exceptSocketId) {
      closeAzureSpeechSession(socketId);
    }
  }
}

function startAzureSpeechSession(socket, event) {
  closeAzureSpeechSession(socket.id);
  closeAzureSpeechSessionsForEvent(event.id, socket.id);
  const sdk = loadAzureSpeechSdk();
  if (!sdk || !AZURE_SPEECH_KEY || !AZURE_SPEECH_REGION) {
    socket.emit('server_error', { message: 'Azure Speech nu este configurat pe server.' });
    return false;
  }

  const sourceLang = String(event.liveSourceLang || event.sourceLang || 'ro').trim();
  const effectiveSourceLang = sourceLang === 'auto' ? (event.sourceLang || 'ro') : sourceLang;
  const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_SPEECH_KEY, AZURE_SPEECH_REGION);
  speechConfig.speechRecognitionLanguage = getSpeechLocale(effectiveSourceLang);
  speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs, '750');

  const audioFormat = sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
  const pushStream = sdk.AudioInputStream.createPushStream(audioFormat);
  const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
  const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

  recognizer.recognizing = (_, result) => {
    const text = sanitizeTranscriptText(result?.result?.text || '');
    if (text) io.to(`event:${event.id}:admins`).emit('partial_transcript', { text });
  };
  recognizer.recognized = (_, result) => {
    if (result?.result?.reason !== sdk.ResultReason.RecognizedSpeech) return;
    const text = sanitizeTranscriptText(result?.result?.text || '');
    if (text) queueSpeechText(event.id, text, effectiveSourceLang, 'azure_sdk');
  };
  recognizer.canceled = (_, result) => {
    const details = String(result?.errorDetails || result?.reason || 'unknown');
    const classified = classifyAzureSpeechError(details);
    if (classified.code === 'azure_auth_failed') {
      logger.error('AZURE SPEECH AUTH ERROR:', {
        eventId: event.id,
        region: AZURE_SPEECH_REGION,
        locale: getSpeechLocale(effectiveSourceLang),
        details
      });
    } else {
      logger.error('azure speech canceled:', details);
    }
    socket.emit('server_error', {
      provider: 'azure_sdk',
      code: classified.code,
      message: classified.message,
      fallbackToOpenAI: classified.fallbackToOpenAI
    });
    closeAzureSpeechSession(socket.id);
  };
  recognizer.sessionStopped = () => closeAzureSpeechSession(socket.id);

  azureSpeechSessions.set(socket.id, {
    eventId: event.id,
    sourceLang: effectiveSourceLang,
    pushStream,
    recognizer
  });

  recognizer.startContinuousRecognitionAsync(
    () => socket.emit('azure_audio_ready', { ok: true }),
    (err) => {
      const details = err?.message || err;
      const classified = classifyAzureSpeechError(details);
      if (classified.code === 'azure_auth_failed') {
        logger.error('AZURE SPEECH AUTH ERROR:', {
          eventId: event.id,
          region: AZURE_SPEECH_REGION,
          locale: getSpeechLocale(effectiveSourceLang),
          details
        });
      } else {
        logger.error('azure speech start error:', details);
      }
      socket.emit('server_error', {
        provider: 'azure_sdk',
        code: classified.code === 'azure_canceled' ? 'azure_start_failed' : classified.code,
        message: classified.code === 'azure_canceled' ? 'Nu am putut porni Azure Speech.' : classified.message,
        fallbackToOpenAI: classified.code !== 'azure_canceled' || classified.fallbackToOpenAI
      });
      closeAzureSpeechSession(socket.id);
    }
  );
  return true;
}

function getEventPresence(eventId) {
  if (!participantPresence.has(eventId)) participantPresence.set(eventId, new Map());
  return participantPresence.get(eventId);
}

function buildParticipantStats(eventId) {
  const presence = getEventPresence(eventId);
  const uniqueParticipants = Array.from(presence.values());
  const byLanguage = {};
  for (const participant of uniqueParticipants) {
    const lang = participant.language || 'unknown';
    byLanguage[lang] = (byLanguage[lang] || 0) + 1;
  }
  return {
    uniqueCount: uniqueParticipants.length,
    total: uniqueParticipants.length,
    byLanguage,
    languages: Object.entries(byLanguage)
      .map(([lang, count]) => ({ lang, count }))
      .sort((a, b) => b.count - a.count)
  };
}

function buildUsageStats(eventId) {
  const event = db.events[eventId];
  if (!event) return defaultUsageStats();
  ensureEventUiState(event);
  const presenceStats = buildParticipantStats(eventId);
  return {
    ...event.usageStats,
    currentParticipants: presenceStats.uniqueCount,
    currentLanguages: presenceStats.languages,
    transcriptCount: Array.isArray(event.transcripts) ? event.transcripts.length : (event.usageStats.transcriptCount || 0),
    manualHistoryCount: Array.isArray(event.songHistory) ? event.songHistory.filter((item) => (item.kind || 'song') === 'manual').length : 0,
    songHistoryCount: Array.isArray(event.songHistory) ? event.songHistory.filter((item) => (item.kind || 'song') === 'song').length : 0
  };
}

function buildTranslationMonitor(eventId) {
  const event = db.events[eventId];
  if (!event) return defaultTranslationMonitor();
  ensureEventUiState(event);
  const buffered = speechBuffers.get(eventId);
  const bufferedText = sanitizeTranscriptText(buffered?.text || '');
  return {
    ...event.translationMonitor,
    lastBufferedText: bufferedText || event.translationMonitor.lastBufferedText || '',
    queueActive: !!bufferedText,
    queueWords: countWords(bufferedText),
    queueAgeMs: buffered?.startedAt ? Math.max(0, Date.now() - buffered.startedAt) : 0,
    queueProvider: buffered?.provider || event.translationMonitor.lastSpeechProvider || '',
    queueSourceLang: buffered?.sourceLang || event.translationMonitor.lastSpeechSourceLang || ''
  };
}

function emitUsageStats(eventId) {
  if (!eventId) return;
  io.to(`event:${eventId}:admins`).emit('usage_stats', buildUsageStats(eventId));
}

function emitTranslationMonitor(eventId) {
  if (!TRANSLATION_MONITOR_ENABLED) return;
  if (!eventId) return;
  const payload = buildTranslationMonitor(eventId);
  io.to(`event:${eventId}:admins`).emit('translation_monitor', payload);
}

function buildTranscriptionState(event) {
  return {
    eventId: event?.id || '',
    paused: !!event?.transcriptionPaused,
    onAir: !!event?.transcriptionOnAir
  };
}

function emitTranscriptionState(event) {
  if (!event?.id) return;
  io.to(`event:${event.id}`).emit('transcription_state', buildTranscriptionState(event));
}

function normalizePushSubscription(input = {}) {
  const endpoint = String(input.endpoint || '').trim();
  const keys = input.keys && typeof input.keys === 'object' ? input.keys : {};
  const p256dh = String(keys.p256dh || '').trim();
  const auth = String(keys.auth || '').trim();
  if (!endpoint || !p256dh || !auth) return null;
  return { endpoint, keys: { p256dh, auth } };
}

function storePushSubscription(event, subscription, meta = {}) {
  const safeSubscription = normalizePushSubscription(subscription);
  if (!event || !safeSubscription) return false;
  ensureEventUiState(event);
  const now = new Date().toISOString();
  const entry = {
    ...safeSubscription,
    participantId: String(meta.participantId || '').trim(),
    language: String(meta.language || '').trim(),
    updatedAt: now
  };
  const index = event.pushSubscriptions.findIndex((item) => item.endpoint === entry.endpoint);
  if (index >= 0) {
    event.pushSubscriptions[index] = { ...event.pushSubscriptions[index], ...entry };
  } else {
    event.pushSubscriptions.push(entry);
  }
  if (event.pushSubscriptions.length > 1000) {
    event.pushSubscriptions = event.pushSubscriptions.slice(-1000);
  }
  return true;
}

function removePushSubscription(event, endpoint) {
  if (!event || !endpoint || !Array.isArray(event.pushSubscriptions)) return false;
  const before = event.pushSubscriptions.length;
  event.pushSubscriptions = event.pushSubscriptions.filter((item) => item.endpoint !== endpoint);
  return event.pushSubscriptions.length !== before;
}

async function sendOnAirPushNotification(event) {
  if (!WEB_PUSH_ENABLED || !event) return;
  ensureEventUiState(event);
  const subscriptions = [...event.pushSubscriptions];
  if (!subscriptions.length) return;
  const payload = JSON.stringify({
    title: event.name || 'Sanctuary Voice',
    body: 'Serviciul a început — traducerea este live',
    url: event.participantLink || '/participant'
  });
  const staleEndpoints = [];
  await Promise.allSettled(subscriptions.map(async (subscription) => {
    try {
      await webpush.sendNotification(normalizePushSubscription(subscription), payload);
    } catch (err) {
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        staleEndpoints.push(subscription.endpoint);
        return;
      }
      logger.warn('web push failed:', err?.message || err);
    }
  }));
  if (staleEndpoints.length) {
    staleEndpoints.forEach((endpoint) => removePushSubscription(event, endpoint));
    saveDb();
  }
}

function setTranscriptionPaused(event, paused, options = {}) {
  if (!event) return;
  const wasOnAir = !!event.transcriptionOnAir;
  event.transcriptionPaused = !!paused;
  if (options.markOnAir === true) {
    event.transcriptionOnAir = true;
  } else if (options.markOnAir === false || paused) {
    event.transcriptionOnAir = false;
  }
  if (options.save !== false) saveDb();
  if (options.emit !== false) emitTranscriptionState(event);
  if (options.notifyOnAir !== false && event.transcriptionOnAir && !wasOnAir) {
    sendOnAirPushNotification(event).catch((err) => logger.error('web push on-air error:', err?.message || err));
  }
}

function recordParticipantJoin(event, participantId, language) {
  ensureEventUiState(event);
  event.usageStats.participantJoinCount += 1;
  event.usageStats.lastParticipantJoinAt = new Date().toISOString();
  const normalizedId = String(participantId || '').trim();
  if (normalizedId && !event.usageStats.seenParticipantIds[normalizedId]) {
    event.usageStats.seenParticipantIds[normalizedId] = language || 'unknown';
    event.usageStats.uniqueParticipantsEver += 1;
  }
}

function recordOperatorJoin(event, role) {
  ensureEventUiState(event);
  if (role === 'screen') {
    event.usageStats.screenOperatorJoinCount += 1;
  } else if (role === 'admin') {
    event.usageStats.adminJoinCount += 1;
  }
  event.usageStats.lastOperatorJoinAt = new Date().toISOString();
  event.usageStats.lastOperatorRole = role || '';
}

function recordTranscriptCreated(event) {
  ensureEventUiState(event);
  event.usageStats.transcriptCount = Array.isArray(event.transcripts) ? event.transcripts.length : (event.usageStats.transcriptCount + 1);
  event.usageStats.lastTranscriptAt = new Date().toISOString();
}

function recordTranscriptRefresh(event) {
  ensureEventUiState(event);
  event.usageStats.transcriptRefreshCount += 1;
  event.usageStats.lastTranscriptAt = new Date().toISOString();
}

function recordScreenAction(event, kind = 'display') {
  ensureEventUiState(event);
  event.usageStats.screenChangeCount += 1;
  if (kind === 'manual') event.usageStats.manualPushCount += 1;
  if (kind === 'song') event.usageStats.songControlCount += 1;
  event.usageStats.lastScreenActionAt = new Date().toISOString();
}

function recordServerError(event, message) {
  if (!event) return;
  ensureEventUiState(event);
  const now = new Date().toISOString();
  const safeMessage = String(message || '').trim();
  event.usageStats.lastErrorAt = now;
  event.usageStats.lastErrorMessage = safeMessage;
  event.translationMonitor.lastErrorAt = now;
  event.translationMonitor.lastErrorMessage = safeMessage;
}

function emitParticipantStats(eventId) {
  if (!eventId) return;
  io.to(`event:${eventId}:admins`).emit('participant_stats', buildParticipantStats(eventId));
  emitUsageStats(eventId);
}

function registerParticipantSocket(eventId, participantId, language, socketId) {
  if (!eventId || !participantId || !socketId) return;
  const presence = getEventPresence(eventId);
  if (!presence.has(participantId)) {
    presence.set(participantId, { participantId, language: language || 'no', socketIds: new Set() });
  }
  const person = presence.get(participantId);
  person.language = language || person.language || 'no';
  person.socketIds.add(socketId);
}

function unregisterParticipantSocket(eventId, participantId, socketId) {
  if (!eventId || !participantId || !socketId) return;
  const presence = getEventPresence(eventId);
  const person = presence.get(participantId);
  if (!person) return;
  person.socketIds.delete(socketId);
  if (person.socketIds.size === 0) presence.delete(participantId);
  if (presence.size === 0) participantPresence.delete(eventId);
}

function cleanupSocketPresence(socket) {
  const eventId = socket.data?.eventId;
  const participantId = socket.data?.participantId;
  if (socket.data?.role === 'participant' && eventId && participantId) {
    unregisterParticipantSocket(eventId, participantId, socket.id);
    emitParticipantStats(eventId);
  }
}

function splitSongBlocks(text) {
  return String(text || '')
    .split(/\n\s*\n/)
    .map((x) => x.split('\n').map((y) => y.trim()).filter(Boolean).join('\n'))
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseSongSectionMarker(block) {
  const lines = String(block || '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return { label: '', text: '' };
  const match = lines[0].match(/^((?:r|refren|chorus)\s*\d*|\d+)([.:])\s*(.*)$/i);
  if (!match) return { label: '', text: lines.join('\n'), baseText: lines.join('\n'), type: 'verse' };

  const marker = match[1].replace(/\s+/g, '').toLowerCase();
  const delimiter = match[2];
  let rest = String(match[3] || '').trim();
  let inlineNote = '';
  const inlineNoteMatch = rest.match(/^(%[^%]+%)\s*(.*)$/);
  if (inlineNoteMatch) {
    inlineNote = inlineNoteMatch[1].trim();
    rest = String(inlineNoteMatch[2] || '').trim();
  }
  const contentLines = rest ? [rest, ...lines.slice(1)] : lines.slice(1);
  const baseText = contentLines.join('\n').trim();
  const text = inlineNote && baseText ? appendSongInlineNote(baseText, inlineNote) : baseText;

  if (/^\d+$/.test(marker)) return { label: `Strofa ${marker}`, text, baseText, type: 'verse' };
  if (marker.startsWith('chorus')) {
    const number = marker.replace('chorus', '');
    return {
      label: `${number ? `Chorus ${number}` : 'Chorus'}${inlineNote ? ` ${inlineNote}` : ''}`,
      text,
      baseText,
      type: 'chorus',
      inlineNote,
      repeatPreviousChorus: delimiter === ':' && !!inlineNote && !baseText
    };
  }
  const number = marker.replace(/^r(?:efren)?/, '');
  return {
    label: `${number ? `Refren ${number}` : 'Refren'}${inlineNote ? ` ${inlineNote}` : ''}`,
    text,
    baseText,
    type: 'chorus',
    inlineNote,
    repeatPreviousChorus: delimiter === ':' && !!inlineNote && !baseText
  };
}

function appendSongInlineNote(text, note) {
  const safeNote = String(note || '').trim();
  if (!safeNote) return String(text || '').trim();
  const lines = String(text || '').split('\n');
  const index = lines.findIndex((line) => line.trim());
  if (index < 0) return safeNote;
  if (!lines[index].includes(safeNote)) lines[index] = `${lines[index].trim()} ${safeNote}`;
  return lines.join('\n').trim();
}

function splitSongBlocksWithLabels(text, labels = []) {
  const rawBlocks = splitSongBlocks(text);
  const parsed = rawBlocks.map(parseSongSectionMarker);
  let lastChorusBaseText = '';
  const entries = parsed.map((item, index) => {
    let blockText = item.text || rawBlocks[index] || '';
    if (item.repeatPreviousChorus) {
      blockText = lastChorusBaseText ? appendSongInlineNote(lastChorusBaseText, item.inlineNote) : (item.inlineNote || blockText);
    }
    if (item.type === 'chorus' && !item.repeatPreviousChorus && item.baseText) {
      lastChorusBaseText = item.baseText;
    }
    const provided = String(labels[index] || '').trim();
    return { text: String(blockText || '').trim(), label: provided || item.label || `Verse ${index + 1}` };
  }).filter((item) => item.text);
  return {
    blocks: entries.map((item) => item.text),
    labels: entries.map((item) => item.label)
  };
}

function buildBlockLabels(blocks, labels = []) {
  return blocks.map((_, index) => {
    const provided = String(labels[index] || '').trim();
    return provided || `Verse ${index + 1}`;
  });
}

async function buildSongTranslations(event, blocks, songSourceLang = '') {
  const allTranslations = [];
  const normalizedSourceLang = String(songSourceLang || event.sourceLang || 'ro').trim() || 'ro';
  for (const block of blocks) {
    const translationPairs = await Promise.all(
      event.targetLangs.map(async (lang) => [lang, await translateText(block, lang, event, normalizedSourceLang)])
    );
    allTranslations.push(Object.fromEntries(translationPairs));
  }
  return allTranslations;
}

function setSongIndex(event, index) {
  const songState = event.songState || defaultSongState();
  const blocks = Array.isArray(songState.blocks) ? songState.blocks : [];
  const allTranslations = Array.isArray(songState.allTranslations) ? songState.allTranslations : [];
  songState.blockLabels = buildBlockLabels(blocks, songState.blockLabels || []);
  if (!Number.isInteger(index) || index < 0 || index >= blocks.length) return false;
  songState.currentIndex = index;
  songState.activeBlock = blocks[index] || null;
  songState.translations = allTranslations[index] || {};
  songState.sourceLang = songState.sourceLang || event.sourceLang || 'ro';
  songState.updatedAt = new Date().toISOString();
  event.songState = songState;
  event.mode = 'song';
  return true;
}

const operatorLoginAttempts = new Map();
const OPERATOR_LOGIN_RATE_WINDOW_MS = 10 * 60 * 1000;
const OPERATOR_LOGIN_RATE_MAX = 10;

function getOperatorClientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
}

function checkOperatorLoginRateLimit(ip) {
  const now = Date.now();
  const entry = operatorLoginAttempts.get(ip);
  if (!entry || now - entry.windowStart >= OPERATOR_LOGIN_RATE_WINDOW_MS) {
    operatorLoginAttempts.set(ip, { windowStart: now, count: 1 });
    return { allowed: true };
  }
  entry.count += 1;
  if (entry.count > OPERATOR_LOGIN_RATE_MAX) {
    return { allowed: false, retryAfter: Math.ceil((entry.windowStart + OPERATOR_LOGIN_RATE_WINDOW_MS - now) / 1000) };
  }
  return { allowed: true };
}

function getActiveEvents() {
  return Object.values(db.events || {}).filter((event) => isEventActive(event));
}

function isOperatorPinValid(pin) {
  const candidate = String(pin || '').trim();
  if (!candidate) return false;
  if (MAIN_OPERATOR_PIN && candidate === MAIN_OPERATOR_PIN) return true;
  for (const event of Object.values(db.events || {})) {
    const operators = Array.isArray(event.remoteOperators) ? event.remoteOperators : [];
    if (operators.some((operator) => String(operator.code || '').trim() === candidate)) {
      return true;
    }
  }
  for (const org of Object.values(db.organizations || {})) {
    const granted = Array.isArray(org?.grantedOperators) ? org.grantedOperators : [];
    if (granted.some((entry) => String(entry?.code || '').trim() === candidate)) {
      return true;
    }
  }
  return false;
}

function generateOperatorAccessCode() {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    let code = '';
    for (let i = 0; i < 8; i += 1) {
      code += EVENT_SHORT_ID_ALPHABET[Math.floor(Math.random() * EVENT_SHORT_ID_ALPHABET.length)];
    }
    let taken = false;
    for (const org of Object.values(db.organizations || {})) {
      const granted = Array.isArray(org?.grantedOperators) ? org.grantedOperators : [];
      if (granted.some((entry) => String(entry?.code || '').trim() === code)) {
        taken = true;
        break;
      }
    }
    if (!taken) return code;
  }
  return `OP${Date.now().toString(36).toUpperCase().slice(-6)}`.slice(0, 8);
}

const accessRequestRateLimits = new Map();
function checkAccessRequestRateLimit(ip) {
  const now = Date.now();
  const entry = accessRequestRateLimits.get(ip);
  if (!entry || now - entry.windowStart >= 10 * 60 * 1000) {
    accessRequestRateLimits.set(ip, { windowStart: now, count: 1 });
    return { allowed: true };
  }
  entry.count += 1;
  if (entry.count > 5) {
    return { allowed: false, retryAfter: Math.ceil((entry.windowStart + 10 * 60 * 1000 - now) / 1000) };
  }
  return { allowed: true };
}

async function sendAdminAccessRequestNotification(org, request) {
  if (!WEB_PUSH_ENABLED || !org) return;
  const subs = Array.isArray(org.adminPushSubscriptions) ? [...org.adminPushSubscriptions] : [];
  if (!subs.length) return;
  const payload = JSON.stringify({
    title: 'Sanctuary Voice — Access request',
    body: `${request.name || 'Someone'} is requesting operator access.`,
    url: '/admin#access-requests'
  });
  const stale = [];
  await Promise.allSettled(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(normalizePushSubscription(sub), payload);
    } catch (err) {
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        stale.push(sub.endpoint);
        return;
      }
      logger.warn('admin push failed:', err?.message || err);
    }
  }));
  if (stale.length) {
    org.adminPushSubscriptions = (org.adminPushSubscriptions || []).filter((s) => !stale.includes(s.endpoint));
    saveDb();
  }
}

app.post('/api/operator/request-access', (req, res) => {
  const ip = getOperatorClientIp(req);
  const rate = checkAccessRequestRateLimit(ip);
  if (!rate.allowed) {
    return res.status(429).json({ ok: false, error: `Too many requests. Try again in ${rate.retryAfter}s.` });
  }
  const name = String(req.body?.name || '').trim().slice(0, 80);
  const contact = String(req.body?.contact || '').trim().slice(0, 200);
  if (!name) return res.status(400).json({ ok: false, error: 'Name is required.' });
  const org = ensureOrganization(DEFAULT_ORG_ID);
  if (!Array.isArray(org.accessRequests)) org.accessRequests = [];
  const request = {
    id: randomUUID(),
    name,
    contact,
    requestedAt: new Date().toISOString(),
    status: 'pending'
  };
  org.accessRequests.push(request);
  if (org.accessRequests.length > 200) org.accessRequests = org.accessRequests.slice(-200);
  saveDb();
  sendAdminAccessRequestNotification(org, request).catch((err) => logger.error('admin push error:', err?.message || err));
  io.emit('access_request_created', { id: request.id });
  res.json({ ok: true, requestId: request.id });
});

app.get('/api/operator/request-status/:id', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, status: 'unknown' });
  const org = ensureOrganization(DEFAULT_ORG_ID);
  const request = (org.accessRequests || []).find((r) => r.id === id);
  if (!request) return res.status(404).json({ ok: false, status: 'unknown' });
  const payload = { ok: true, status: request.status };
  if (request.status === 'granted' && request.operatorCode) {
    payload.operatorCode = request.operatorCode;
    payload.profile = request.profile || null;
  }
  res.json(payload);
});

app.get('/api/admin/access-requests', (req, res) => {
  if (!hasValidAdminSession(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const org = ensureOrganization(DEFAULT_ORG_ID);
  const requests = Array.isArray(org.accessRequests) ? [...org.accessRequests].reverse() : [];
  const granted = Array.isArray(org.grantedOperators) ? [...org.grantedOperators].reverse() : [];
  const profiles = Object.entries(REMOTE_OPERATOR_PROFILES).map(([key, def]) => ({
    key,
    label: def.label,
    permissions: def.permissions
  }));
  res.json({ ok: true, requests, granted, profiles });
});

app.post('/api/admin/access-requests/:id/grant', (req, res) => {
  if (!hasValidAdminSession(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const org = ensureOrganization(DEFAULT_ORG_ID);
  const request = (org.accessRequests || []).find((r) => r.id === req.params.id);
  if (!request) return res.status(404).json({ ok: false, error: 'Request not found.' });
  if (request.status !== 'pending') return res.status(400).json({ ok: false, error: `Request already ${request.status}.` });
  const profile = normalizeRemoteOperatorProfile(req.body?.profile);
  const code = generateOperatorAccessCode();
  request.status = 'granted';
  request.operatorCode = code;
  request.profile = profile;
  request.grantedAt = new Date().toISOString();
  if (!Array.isArray(org.grantedOperators)) org.grantedOperators = [];
  org.grantedOperators.push({
    id: randomUUID(),
    name: request.name,
    contact: request.contact || '',
    code,
    profile,
    grantedAt: request.grantedAt,
    requestId: request.id
  });
  saveDb();
  res.json({ ok: true, code, profile, request });
});

app.post('/api/admin/access-requests/:id/deny', (req, res) => {
  if (!hasValidAdminSession(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const org = ensureOrganization(DEFAULT_ORG_ID);
  const request = (org.accessRequests || []).find((r) => r.id === req.params.id);
  if (!request) return res.status(404).json({ ok: false, error: 'Request not found.' });
  if (request.status !== 'pending') return res.status(400).json({ ok: false, error: `Request already ${request.status}.` });
  request.status = 'denied';
  request.deniedAt = new Date().toISOString();
  saveDb();
  res.json({ ok: true, request });
});

app.delete('/api/admin/access-requests/:id', (req, res) => {
  if (!hasValidAdminSession(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const org = ensureOrganization(DEFAULT_ORG_ID);
  const before = (org.accessRequests || []).length;
  org.accessRequests = (org.accessRequests || []).filter((r) => r.id !== req.params.id);
  if (org.accessRequests.length !== before) saveDb();
  res.json({ ok: true });
});

app.delete('/api/admin/granted-operators/:code', (req, res) => {
  if (!hasValidAdminSession(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const org = ensureOrganization(DEFAULT_ORG_ID);
  const code = String(req.params.code || '').trim();
  org.grantedOperators = (org.grantedOperators || []).filter((entry) => entry.code !== code);
  saveDb();
  res.json({ ok: true });
});

app.post('/api/admin/push-subscribe', (req, res) => {
  if (!hasValidAdminSession(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  if (!WEB_PUSH_ENABLED) return res.status(503).json({ ok: false, error: 'Push not configured.' });
  const sub = normalizePushSubscription(req.body?.subscription);
  if (!sub) return res.status(400).json({ ok: false, error: 'Invalid subscription.' });
  const org = ensureOrganization(DEFAULT_ORG_ID);
  if (!Array.isArray(org.adminPushSubscriptions)) org.adminPushSubscriptions = [];
  const idx = org.adminPushSubscriptions.findIndex((s) => s.endpoint === sub.endpoint);
  const entry = { ...sub, updatedAt: new Date().toISOString() };
  if (idx >= 0) org.adminPushSubscriptions[idx] = entry;
  else org.adminPushSubscriptions.push(entry);
  saveDb();
  res.json({ ok: true });
});

app.post('/api/operator-login', (req, res) => {
  const ip = getOperatorClientIp(req);
  const rateCheck = checkOperatorLoginRateLimit(ip);
  if (!rateCheck.allowed) {
    return res.status(429).json({ ok: false, error: `Too many attempts. Try again in ${rateCheck.retryAfter}s.` });
  }
  const pin = String(req.body?.pin || '').trim();
  if (!pin) {
    return res.status(400).json({ ok: false, error: 'Operator PIN is required.' });
  }
  if (!isOperatorPinValid(pin)) {
    return res.status(403).json({ ok: false, error: 'Invalid PIN.' });
  }
  operatorLoginAttempts.delete(ip);
  return res.json({ ok: true, operatorCode: pin });
});

function getOperatorCodeFromRequest(req) {
  return String(
    req.body?.operatorCode
    || req.query?.operatorCode
    || req.headers['x-operator-code']
    || ''
  ).trim();
}

app.get('/api/operator/events', (req, res) => {
  const operatorCode = getOperatorCodeFromRequest(req);
  if (!operatorCode || !isOperatorPinValid(operatorCode)) {
    return res.status(401).json({ ok: false, error: 'Operator session expired. Please log in again.' });
  }
  const now = Date.now();
  const events = Object.values(db.events || {})
    .filter((event) => getEventOrgId(event) === DEFAULT_ORG_ID)
    .map((event) => {
      ensureEventShortId(event);
      const isActive = isEventActive(event);
      const ts = typeof event.scheduledTimestamp === 'number' ? event.scheduledTimestamp : null;
      let status = 'past';
      if (isActive) status = 'active';
      else if (ts && ts > now) status = 'scheduled';
      else if (!ts) status = 'unscheduled';
      return {
        id: event.id,
        shortId: event.shortId,
        name: event.name || 'Untitled event',
        date: event.scheduledAt || event.createdAt || null,
        scheduledTimestamp: ts,
        timezone: event.timezone || null,
        sourceLang: event.sourceLang || 'ro',
        isActive,
        status
      };
    })
    .sort((a, b) => {
      const order = { active: 0, scheduled: 1, unscheduled: 2, past: 3 };
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
      const aTs = a.scheduledTimestamp ?? new Date(a.date || 0).getTime();
      const bTs = b.scheduledTimestamp ?? new Date(b.date || 0).getTime();
      if (a.status === 'past') return bTs - aTs;
      return aTs - bTs;
    });
  return res.json({ ok: true, events });
});

app.post('/api/operator/join', (req, res) => {
  const rawId = String(req.body?.eventId || '').trim();
  const operatorCode = String(req.body?.operatorCode || '').trim();
  if (!operatorCode || !isOperatorPinValid(operatorCode)) {
    return res.status(401).json({ ok: false, error: 'Operator session expired. Please log in again.' });
  }
  if (!rawId) {
    return res.status(400).json({ ok: false, error: 'Invalid Event ID' });
  }
  const event = findEventByIdOrShortId(rawId);
  if (!event || !isEventActive(event)) {
    return res.status(404).json({ ok: false, error: 'Invalid Event ID' });
  }
  const access = resolveEventAccessFromCode(event, operatorCode);
  if (access.role !== 'screen') {
    return res.status(403).json({ ok: false, error: 'Invalid Event ID' });
  }
  return res.json({
    ok: true,
    redirectUrl: `/remote?event=${encodeURIComponent(event.id)}&code=${encodeURIComponent(operatorCode)}`
  });
});

registerOrgRoutes(app, {
  AZURE_SPEECH_KEY,
  AZURE_SPEECH_REGION,
  COMMERCIAL_MODE,
  DEFAULT_ORG_ID,
  LANGUAGE_NAMES_RO,
  OPENAI_API_KEY,
  OPENAI_MODEL,
  OPENAI_TRANSCRIBE_MODEL,
  QRCode,
  WEB_PUSH_ENABLED,
  WEB_PUSH_PUBLIC_KEY,
  buildBaseUrl,
  buildOrganizationStatus,
  buildPublicOrganization,
  db,
  dbStore,
  getActiveSpeechProvider,
  getDefaultOrganization,
  isEventActive,
  logger,
  packageJson,
  participantPresence,
  removePushSubscription,
  saveDb,
  storePushSubscription
});

registerEventRoutes(app, {
  AZURE_SPEECH_KEY,
  AZURE_SPEECH_REGION,
  COMMERCIAL_MODE,
  DEFAULT_ORG_ID,
  LANGUAGES,
  LANGUAGE_NAMES_RO,
  TRANSCRIBE_RATE_LIMIT_MAX,
  TRANSCRIBE_RATE_LIMIT_WINDOW_MS,
  applyDisplaySnapshot,
  applySourceCorrections,
  buildBaseUrl,
  buildDisplayPayload,
  buildPublicOrganization,
  buildSongTranslations,
  buildTranslationsForAllTargets,
  client,
  cloneDisplaySnapshot,
  closeAzureSpeechSessionsForEvent,
  createEvent,
  db,
  defaultDisplayState,
  defaultSongState,
  emitTranscriptionState,
  emitUsageStats,
  ensureEventAccessLinks,
  ensureEventUiState,
  getActiveEventIdForOrg,
  getDisplayLanguageChoices,
  getEventOrgId,
  getOrganizationEvents,
  getOrganizationForEvent,
  getOrganizationMemory,
  getOrganizationPinnedTextLibrary,
  getOrganizationSongLibrary,
  getRemoteOperatorPermissions,
  getSourceCorrections,
  getSuppliedEventCode,
  hasValidAdminSession,
  io,
  isAdminLoginConfigured,
  logger,
  normalizeDisplayPreset,
  normalizeDisplayTextScale,
  normalizeEvent,
  normalizeEventForAccess,
  normalizeOrgId,
  normalizeRemoteOperatorProfile,
  normalizeRemoteOperators,
  participantPresence,
  processText,
  pushSongHistory,
  queueSpeechText,
  recordScreenAction,
  rememberDisplayState,
  requireAdminApiSession,
  requireEventAdmin,
  requireEventManager,
  requireEventPermission,
  requireEventRole,
  requireGlobalLibraryAdmin,
  resolveEventAccessFromCode,
  sanitizeStructuredText,
  sanitizeTranscriptText,
  saveDb,
  setActiveEventIdForOrg,
  setSongIndex,
  setTranscriptionPaused,
  speechBuffers,
  splitSongBlocksWithLabels,
  summarizeEvent,
  transcribeAudioFile,
  transcribeRateLimits,
  upload,
  upsertLibraryItem
});

registerSocketHandlers(io, {
  LANGUAGE_NAMES_RO,
  azureSpeechSessions,
  buildDisplayPayload,
  buildPublicOrganization,
  cleanupSocketPresence,
  closeAzureSpeechSession,
  db,
  emitParticipantStats,
  emitTranscriptionState,
  emitUsageStats,
  ensureEventUiState,
  getActiveSpeechProvider,
  getOrganizationForEvent,
  isEventActive,
  logger,
  normalizeEvent,
  normalizeSocketOperator,
  processText,
  recordOperatorJoin,
  recordParticipantJoin,
  recordServerError,
  recordTranscriptRefresh,
  registerParticipantSocket,
  resolveEventAccessFromCode,
  retranslateEntry,
  saveDb,
  setTranscriptionPaused,
  socketCanControlEvent,
  startAzureSpeechSession
});

const httpServer = server.listen(PORT, () => {
  logger.info(`Sanctuary Voice running on ${httpServer.address()?.port || PORT}`);
});

let shutdownStarted = false;

function gracefulShutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  logger.warn(`Graceful shutdown started: ${signal}`);
  const forceTimer = setTimeout(() => {
    logger.error('Graceful shutdown timed out.');
    process.exit(1);
  }, 10000);
  forceTimer.unref?.();

  try {
    for (const socketId of Array.from(azureSpeechSessions.keys())) {
      closeAzureSpeechSession(socketId);
    }
    saveDb();
    io.disconnectSockets(true);
    io.close(() => {
      httpServer.close((err) => {
        if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') {
          logger.warn('HTTP server close warning:', err?.message || err);
        }
        clearTimeout(forceTimer);
        logger.info('Graceful shutdown completed.');
        process.exit(0);
      });
    });
  } catch (err) {
    logger.error('Graceful shutdown error:', err);
    try { saveDb(); } catch (_) {}
    clearTimeout(forceTimer);
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
