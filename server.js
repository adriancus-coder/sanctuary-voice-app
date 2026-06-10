// V22.37 — stack trace LIMITAT (1000 pe stivă adâncă putea agrava overflow-ul). Handler-e
// MINIMALE care NU accesează .stack și rulează pe stivă curată (setImmediate) ca să nu mai
// fie ocolite de overflow-ul din promiseRejectHandler.
Error.stackTraceLimit = 30;
process.on('unhandledRejection', (reason) => {
  setImmediate(() => {
    let msg = '';
    try { msg = (reason && reason.message) ? String(reason.message) : String(reason); } catch (_) { msg = '[unstringifiable]'; }
    try { process.stderr.write('[V22.37 unhandledRejection] ' + msg.slice(0, 200) + '\n'); } catch (_) {}
    // SEC-AUDIT-2026-06 C3: also persist to app.log (best-effort). We pass the
    // pre-extracted string, never the Error itself, to keep the V22.37 contract
    // of not touching .stack on a possibly-overflowed stack.
    try { logger.error('[unhandledRejection]', msg.slice(0, 200)); } catch (_) {}
  });
});
process.on('uncaughtException', (err) => {
  setImmediate(() => {
    let msg = '';
    try { msg = (err && err.message) ? String(err.message) : String(err); } catch (_) { msg = '[unstringifiable]'; }
    try { process.stderr.write('[V22.37 uncaughtException] ' + msg.slice(0, 200) + '\n'); } catch (_) {}
    try { logger.error('[uncaughtException]', msg.slice(0, 200)); } catch (_) {}
  });
});

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const helmet = require('helmet');
const compression = require('compression');
const webpush = require('web-push');
const { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const OpenAI = require('openai');
const packageJson = require('./package.json');
const { createLogger } = require('./lib/logger');
const { createJsonDbStore, atomicWriteFileSync } = require('./lib/db');
const { createTranslationService } = require('./lib/translation');
const { installRateLimitGC } = require('./lib/rate-limit-gc');
const { registerAdminRoutes } = require('./routes/admin');
const { registerOrgRoutes } = require('./routes/org');
const { registerEventRoutes } = require('./routes/events');
const { registerSocketHandlers } = require('./socket/handlers');
const { importFromUrl, searchResurseCrestineSongs } = require('./routes/admin-import');
require('dotenv').config();

const SECURE_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const SECURE_CODE_LENGTH = 12;

function generateSecureCode(prefix) {
  const bytes = randomBytes(SECURE_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < SECURE_CODE_LENGTH; i += 1) {
    code += SECURE_CODE_ALPHABET[bytes[i] % SECURE_CODE_ALPHABET.length];
  }
  return prefix ? `${prefix}-${code}` : code;
}

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
// V22.15 — model de calitate folosit la modul „clear" (TRANSLATION MODE = calitate).
// Mai bun pe propoziții lungi/complexe. rapid+balanced rămân pe nano (latență).
const OPENAI_QUALITY_MODEL = process.env.OPENAI_QUALITY_MODEL || 'gpt-4.1-mini';
const OPENAI_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
const TRANSCRIBE_RATE_LIMIT_WINDOW_MS = Math.max(1000, Number(process.env.TRANSCRIBE_RATE_LIMIT_WINDOW_MS || 60000) || 60000);
const TRANSCRIBE_RATE_LIMIT_MAX = Math.max(1, Number(process.env.TRANSCRIBE_RATE_LIMIT_MAX || 120) || 120);
const SPEECH_PROVIDER = String(process.env.SPEECH_PROVIDER || 'openai').trim().toLowerCase();
const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY || '';
const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION || '';
const MASTER_ADMIN_PIN = String(process.env.MASTER_ADMIN_PIN || process.env.APP_ADMIN_PIN || '').trim();
const MASTER_MODERATOR_PIN = String(process.env.MASTER_MODERATOR_PIN || process.env.APP_MODERATOR_PIN || '').trim();
const MAIN_OPERATOR_PIN = String(process.env.MAIN_OPERATOR_PIN || process.env.MAIN_OPERATOR_CODE || '').trim();
// V20.1: Worship role PIN — lets the worship team add library songs to upcoming events.
const WORSHIP_PIN = String(process.env.WORSHIP_PIN || '').trim();
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
const SUMMARY_WEBHOOK_URL = String(process.env.SUMMARY_WEBHOOK_URL || '').trim();
const SUMMARY_RECIPIENT = String(process.env.SUMMARY_RECIPIENT || '').trim();
const AUDIO_ARCHIVE_ENABLED = ['1', 'true', 'yes'].includes(String(process.env.AUDIO_ARCHIVE_ENABLED || '').trim().toLowerCase());
const AUDIO_ARCHIVE_DIR = process.env.AUDIO_ARCHIVE_DIR || path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'audio');
const AUDIO_ARCHIVE_MAX_BYTES_PER_EVENT = Math.max(1024 * 1024, Number(process.env.AUDIO_ARCHIVE_MAX_BYTES_PER_EVENT) || 500 * 1024 * 1024);
const ADMIN_SESSION_COOKIE = 'sv_admin_session';
const ADMIN_SESSION_PERSISTENT = ['1', 'true', 'yes'].includes(String(process.env.ADMIN_SESSION_PERSISTENT || '').trim().toLowerCase());
const ADMIN_SESSION_MAX_AGE_MS = Math.max(1, Number(process.env.ADMIN_SESSION_MAX_AGE_HOURS || 12) || 12) * 60 * 60 * 1000;
let ADMIN_SESSION_SECRET = String(
  process.env.ADMIN_SESSION_SECRET
  || process.env.SESSION_SECRET
  || ''
).trim();
if (!ADMIN_SESSION_SECRET) {
  const isProduction = String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
  if (isProduction || COMMERCIAL_MODE) {
    const reason = isProduction ? 'NODE_ENV=production' : 'COMMERCIAL_MODE=1';
    console.error(`FATAL: ADMIN_SESSION_SECRET is not set. Refusing to start (${reason}).`);
    console.error('Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
    console.error('Then set ADMIN_SESSION_SECRET in your environment (e.g. Render Environment) and restart.');
    process.exit(1);
  }
  ADMIN_SESSION_SECRET = randomBytes(32).toString('base64');
  logger.warn('ADMIN_SESSION_SECRET not set — using an ephemeral random secret. All admin sessions will be invalidated on restart.');
} else if (ADMIN_SESSION_SECRET.length < 32) {
  logger.warn(`ADMIN_SESSION_SECRET is shorter than 32 characters (length=${ADMIN_SESSION_SECRET.length}). Use a stronger secret in production.`);
}
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
function audioArchivePath(eventId) {
  return path.join(AUDIO_ARCHIVE_DIR, `${String(eventId).replace(/[^a-zA-Z0-9-]/g, '')}.webm`);
}

function appendAudioArchiveChunk(event, buffer) {
  if (!AUDIO_ARCHIVE_ENABLED || !event || !buffer || !buffer.length) return;
  setImmediate(() => {
    try {
      if (!fs.existsSync(AUDIO_ARCHIVE_DIR)) fs.mkdirSync(AUDIO_ARCHIVE_DIR, { recursive: true });
      const filePath = audioArchivePath(event.id);
      const currentSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
      if (currentSize >= AUDIO_ARCHIVE_MAX_BYTES_PER_EVENT) return;
      fs.appendFileSync(filePath, buffer);
      if (!event.audioArchive || typeof event.audioArchive !== 'object') event.audioArchive = {};
      event.audioArchive.bytes = currentSize + buffer.length;
      event.audioArchive.chunks = (Number(event.audioArchive.chunks) || 0) + 1;
      event.audioArchive.lastChunkAt = new Date().toISOString();
    } catch (err) {
      logger.warn('audio archive append failed:', err?.message || err);
    }
  });
}

const transcribeRateLimits = new Map();
const transcribeLatencyBuffer = [];
const TRANSCRIBE_LATENCY_BUFFER_SIZE = 30;
function recordTranscribeLatency(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  transcribeLatencyBuffer.push(ms);
  if (transcribeLatencyBuffer.length > TRANSCRIBE_LATENCY_BUFFER_SIZE) {
    transcribeLatencyBuffer.shift();
  }
}
const io = new Server(server, {
  cors: {
    origin: socketCorsOriginValidator,
    methods: CORS_METHODS,
    allowedHeaders: CORS_ALLOWED_HEADERS,
    credentials: true
  },
  maxHttpBufferSize: 256 * 1024,
  pingInterval: 20 * 1000,
  pingTimeout: 25 * 1000,
  connectTimeout: 30 * 1000
});
app.use(expressCorsMiddleware);
app.use(compression());
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      // aka.ms = Microsoft Speech SDK loader
      // csspeechstorage.blob.core.windows.net = resurse auxiliare Microsoft Speech SDK (worker.js, etc.)
      // SEC-AUDIT-2026-06 B2: no 'unsafe-inline' — all page scripts are external
      // files under public/ (landing.js, demo-*.js were extracted for this).
      // styleSrc keeps 'unsafe-inline' for now (inline <style>/style= still used).
      scriptSrc: ["'self'", 'https://aka.ms', 'https://csspeechstorage.blob.core.windows.net'],
      // fonts.googleapis.com = stylesheet-ul Google Fonts (Fraunces, Space Grotesk)
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: buildHelmetConnectSources(),
      mediaSrc: ["'self'", 'data:', 'blob:'],
      workerSrc: ["'self'", 'blob:'],
      // fonts.gstatic.com = fișierele .woff2 ale Google Fonts (servite separat de CSS)
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com']
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
// V21.18 + V21.19: each per-page service worker registers with an explicit
// narrow scope (/worship-view, /remote, /worship) so it doesn't clobber
// push-sw.js (scope /, used by /participant). The Service-Worker-Allowed
// header locks the worker's max scope to that path — declaring intent and
// preventing accidental broader registration. Registered before
// express.static so the static handler still streams the file body.
app.use('/worship-view-sw.js', (req, res, next) => {
  res.setHeader('Service-Worker-Allowed', '/worship-view');
  next();
});
app.use('/remote-sw.js', (req, res, next) => {
  res.setHeader('Service-Worker-Allowed', '/remote');
  next();
});
app.use('/worship-sw.js', (req, res, next) => {
  res.setHeader('Service-Worker-Allowed', '/worship');
  next();
});
// V22.28 — browserele cer /favicon.ico automat; servim icon.svg ca să nu mai dea 404
app.get('/favicon.ico', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.sendFile(path.join(__dirname, 'public', 'icon.svg'));
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res, next) => {
  if (isAdminAppHost(req)) return res.redirect('/admin');
  return sendLandingPage(req, res, next);
});
app.get('/home', sendLandingPage);
app.get('/admin', requireAdminPage, sendAdminPage);
app.get('/admin.html', requireAdminPage, sendAdminPage);
app.get('/participant', (req, res) => res.sendFile(path.join(__dirname, 'public', 'participant.html')));
app.get('/participant.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'participant.html')));
app.get('/live', (req, res) => res.sendFile(path.join(__dirname, 'public', 'participant.html')));
app.get('/main-screen', (req, res) => res.sendFile(path.join(__dirname, 'public', 'translate.html')));
app.get('/translate', (req, res) => res.sendFile(path.join(__dirname, 'public', 'translate.html')));
app.get('/song', (req, res) => res.sendFile(path.join(__dirname, 'public', 'translate.html')));
app.get('/remote', (req, res) => res.sendFile(path.join(__dirname, 'public', 'remote.html')));
app.get('/worship', (req, res) => res.sendFile(path.join(__dirname, 'public', 'worship.html')));
app.get('/worship-view', (req, res) => res.sendFile(path.join(__dirname, 'public', 'worship-view.html')));
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

// HOTFIX V7.1: hoisted to module-constants area (was at line ~1586) so migrateNormalizeContent
// can safely call normalizeTextInput at startup without TDZ ReferenceError. Function declarations
// are hoisted but `const` values are not — they were initialized AFTER the migration call ran.
// See full normalizeTextInput body below for usage / docs.
const ZERO_WIDTH_CHARS = /[​‌‍⁠﻿]/g;
const MOJIBAKE_MAP = Object.freeze({
  // Romanian (most relevant to bug)
  'Ã®': 'î', 'Ã¢': 'â', 'Ã‚': 'Â', 'ÃŽ': 'Î',
  'È™': 'ș', 'È›': 'ț', 'È˜': 'Ș', 'Èš': 'Ț',
  // Norwegian / Scandinavian
  'Ã¥': 'å', 'Ã¦': 'æ', 'Ã¸': 'ø', 'Ã…': 'Å', 'Ã†': 'Æ', 'Ã˜': 'Ø',
  // West-European latin
  'Ã©': 'é', 'Ã¨': 'è', 'Ãª': 'ê', 'Ã«': 'ë',
  'Ã¡': 'á', 'Ã ': 'à', 'Ã­': 'í', 'Ã²': 'ò', 'Ã³': 'ó', 'Ã¶': 'ö',
  'Ã¬': 'ì', 'Ãº': 'ú', 'Ã¹': 'ù', 'Ã¼': 'ü', 'Ã¤': 'ä',
  'ÃŸ': 'ß', 'Ã±': 'ñ',
  // Smart punctuation (mojibake of curly quotes/dashes/ellipsis)
  'â€™': '’', 'â€˜': '‘', 'â€œ': '“', 'â€': '”',
  'â€"': '—', 'â€"': '–', 'â€¦': '…'
});

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

// V11.5: Endonyms — language names written in their own language.
// Used for end-user-facing UI (Main Screen cards in translate.html, Participant phone view).
// Admin UI continues to use LANGUAGE_NAMES_RO (operator-facing in Romanian).
// Keys mirror LANGUAGES exactly (16 codes verified).
const LANGUAGE_ENDONYMS = {
  ro: 'Română',
  no: 'Norsk',
  ru: 'Русский',
  uk: 'Українська',
  en: 'English',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  it: 'Italiano',
  pt: 'Português',
  pl: 'Polski',
  tr: 'Türkçe',
  ar: 'العربية',
  fa: 'فارسی',
  hu: 'Magyar',
  el: 'Ελληνικά'
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
    'wss://*.stt.speech.microsoft.com',
    // Microsoft Speech SDK face fetch/XHR la aceste URL-uri pentru source maps și bundle-uri lazy
    'https://aka.ms',
    'https://csspeechstorage.blob.core.windows.net'
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

// V19: song import/search are reachable by admins, by a logged-in operator
// (operator-PIN session cookie), and by a remote operator authenticated with an
// event access code. The /remote page carries that code in `state.accessCode`
// (not an operator session), so accept a code that resolves to admin/screen.
function requireAdminOrOperatorApiSession(req, res) {
  if (hasValidAdminSession(req)) return true;
  const operatorCode = getOperatorCodeFromCookie(req);
  if (operatorCode && isOperatorPinValid(operatorCode)) return true;
  const suppliedCode = String(req.body?.code || '').trim();
  const eventId = String(req.body?.eventId || '').trim();
  const event = eventId ? db.events[eventId] : null;
  if (event && suppliedCode) {
    const access = resolveEventAccessFromCode(event, suppliedCode);
    if (access.role === 'admin' || access.role === 'screen') return true;
  }
  // V20.3: worship-role sessions may also import/search songs.
  if (tryWorshipSession(req)) return true;
  res.status(401).json({ ok: false, error: 'Admin or operator login required.' });
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
    // V21.27: Main Screen starts black on a fresh event so the projector
    // doesn't show 'Waiting for translation...' placeholder text before
    // anything is live. POST /api/events/:id/display/mode (any mode pick
    // — Live/Song/Manual) auto-clears blackScreen=false (events.js:1115),
    // so the first admin/operator action lights up the screen. Refresh
    // preserves whatever blackScreen ended up at, because
    // ensureEventUiState only initializes displayState when missing.
    blackScreen: true,
    theme: 'dark',
    // V21.27: default display language is Romanian. ensureEventUiState
    // validates this against the event's targetLangs and falls back to
    // the first valid choice when 'ro' isn't available — so this only
    // takes effect when the event actually exposes Romanian on screen.
    language: 'ro',
    secondaryLanguage: '',
    backgroundPreset: 'none',
    customBackground: '',
    // V21.36: new events start with the clock visible at max server-allowed
    // size (server clamp 0.7-1.8 in routes/events.js:1297). Existing events
    // are unaffected — ensureEventUiState only fills clockScale when missing
    // (legacy default 2, still inside its 0.7-2.5 clamp), and existing
    // displayStates persist whatever values were already saved.
    showClock: true,
    clockPosition: 'bottom-right',
    clockScale: 1.8,
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
    audioSeconds: 0,
    tokensTranslation: 0,
    estimatedCostUSD: 0,
    lastTranscriptAt: null,
    lastScreenActionAt: null,
    lastParticipantJoinAt: null,
    lastOperatorJoinAt: null,
    lastOperatorRole: '',
    lastErrorAt: null,
    lastErrorMessage: ''
  };
}

const COST_PER_AUDIO_SECOND = 0.003 / 60;
const COST_PER_TRANSLATION_TOKEN = 0.0000004;

function recomputeEstimatedCost(stats) {
  if (!stats) return 0;
  const audioCost = (Number(stats.audioSeconds) || 0) * COST_PER_AUDIO_SECOND;
  const translationCost = (Number(stats.tokensTranslation) || 0) * COST_PER_TRANSLATION_TOKEN;
  stats.estimatedCostUSD = Math.round((audioCost + translationCost) * 1e6) / 1e6;
  return stats.estimatedCostUSD;
}

// Stats mutations are deferred via setImmediate so they always run AFTER
// the current tick's Socket.IO emits and HTTP responses. They never call
// saveDb() — the new in-memory values ride along on whatever saveDb() the
// regular transcript / song / admin flows already trigger.
function recordTranscribeUsage(event, audioSeconds) {
  if (!event) return;
  const seconds = Math.max(0, Number(audioSeconds) || 0);
  if (!seconds) return;
  setImmediate(() => {
    if (!event.usageStats) event.usageStats = defaultUsageStats();
    event.usageStats.audioSeconds = (Number(event.usageStats.audioSeconds) || 0) + seconds;
    recomputeEstimatedCost(event.usageStats);
  });
}

function recordTranslationUsage(event, tokens) {
  if (!event) return;
  const amount = Math.max(0, Number(tokens) || 0);
  if (!amount) return;
  setImmediate(() => {
    if (!event.usageStats) event.usageStats = defaultUsageStats();
    event.usageStats.tokensTranslation = (Number(event.usageStats.tokensTranslation) || 0) + amount;
    recomputeEstimatedCost(event.usageStats);
  });
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
    lastErrorMessage: '',
    whisperRetries: 0,
    whisperEmptyDrops: 0
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
    clockScale: typeof safe.clockScale === 'number' ? Math.min(2.5, Math.max(0.7, safe.clockScale)) : 2,
    textSize: ['compact', 'large', 'xlarge', 'huge'].includes(safe.textSize) ? safe.textSize : 'large',
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
    event.displayState.clockPosition = 'bottom-right';
  }
  if (typeof event.displayState.clockScale !== 'number') {
    event.displayState.clockScale = 2;
  }
  event.displayState.clockScale = Math.min(2.5, Math.max(0.7, event.displayState.clockScale));
  if (!['compact', 'large', 'xlarge', 'huge'].includes(event.displayState.textSize)) {
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
        code: String(item?.code || generateSecureCode('SV-REMOTE')).trim(),
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
  org.auditLog = Array.isArray(org.auditLog) ? org.auditLog : [];
  org.activeEventId = org.activeEventId || null;
  return org;
}

const AUDIT_LOG_LIMIT = 500;
function recordAudit(orgId, action, details = {}) {
  try {
    const org = ensureOrganization(orgId || DEFAULT_ORG_ID);
    if (!Array.isArray(org.auditLog)) org.auditLog = [];
    org.auditLog.push({
      id: randomUUID(),
      action: String(action || '').trim() || 'unknown',
      at: new Date().toISOString(),
      details: details && typeof details === 'object' ? details : {}
    });
    if (org.auditLog.length > AUDIT_LOG_LIMIT) {
      org.auditLog = org.auditLog.slice(-AUDIT_LOG_LIMIT);
    }
  } catch (err) {
    logger.warn('audit log error:', err?.message || err);
  }
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
// WORSHIP-ROLES-1: listă globală de etichete de rol worship (ex. „Chitară 1", „Voce").
// WORSHIP-ROLES-1B: rolurile devin obiecte {name, code, canLead, canAdmin}; migrare safe.
// WORSHIP-MANAGE-ROLES: a 3-a capabilitate canManageRoles (super-user worship); migrare safe.
if (!Array.isArray(db.worshipRoles)) {
  db.worshipRoles = [];
} else {
  db.worshipRoles = db.worshipRoles.map((r) =>
    (typeof r === 'string')
      ? { name: r, code: '', canLead: false, canAdmin: false, canManageRoles: false, emoji: '' }
      : { name: String(r?.name || ''), code: String(r?.code || ''),
          canLead: !!r?.canLead, canAdmin: !!r?.canAdmin, canManageRoles: !!r?.canManageRoles,
          emoji: String(r?.emoji || '').slice(0, 8) }
  ).filter((r) => r.name);
}
if (!db.globalAccess || typeof db.globalAccess !== 'object') {
  db.globalAccess = {};
}
syncLegacyGlobalsFromDefaultOrg();
backfillPushSubscriptionRoles();
migrateNormalizeContent();

function backfillPushSubscriptionRoles() {
  let changed = 0;
  for (const event of Object.values(db.events || {})) {
    if (!Array.isArray(event.pushSubscriptions)) continue;
    for (const sub of event.pushSubscriptions) {
      if (!sub || typeof sub !== 'object') continue;
      if (!sub.role) {
        sub.role = 'participant';
        changed += 1;
      }
    }
  }
  if (changed > 0) {
    logger.info?.(`Push subscriptions backfilled with role 'participant': ${changed}`);
    try { dbStore.save(db); } catch (_) {}
  }
}

// BUGFIX V7: one-shot migration that normalizes existing content (paste-from-Word legacy with
// mixed sedilla/comma diacritics, mojibake, BOM). Runs at server startup; idempotent via
// `_normalizedAt` marker per item.
//
// STRATEGY DECISION for changed-text songs:
//   We choose (a) WIPE `translationsByHash` rather than (b) intelligent re-hash mapping.
//   Rationale: the whole point of V7 is that the OLD translations were generated from contaminated
//   input — preserving them would also preserve any wrong-language artifacts. A clean re-translate
//   on next "Send to Live" guarantees the OpenAI call sees normalized RO text and produces correct
//   target-language output. One-time cost, only for content that actually changed.
//
// Scope: globalSongLibrary + pinnedTextLibrary. Glossary entries are SKIPPED (low paste risk;
// admins type them directly; complex key-rewrite for changed source words). Org memory SKIPPED
// (mostly auto-generated content from translations, not paste).
function migrateNormalizeContent({ skipBackup = false } = {}) {
  const stats = { songsScanned: 0, songsChanged: 0, songsSkipped: 0,
                  pinnedScanned: 0, pinnedChanged: 0, pinnedSkipped: 0,
                  hashesWiped: 0, backupPath: null };
  let needsSave = false;
  let backupTaken = false;

  const tryBackup = () => {
    if (skipBackup || backupTaken) return;
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(DATA_DIR, `sessions.backup-pre-normalize-${ts}.json`);
      if (fs.existsSync(DB_FILE)) {
        fs.copyFileSync(DB_FILE, backupPath);
        stats.backupPath = backupPath;
        backupTaken = true;
        logger.info(`migrate-normalize: backup created at ${backupPath}`);
      } else {
        logger.info('migrate-normalize: no DB_FILE yet — backup skipped');
      }
    } catch (err) {
      logger.warn('migrate-normalize: backup failed:', err?.message || err);
    }
  };

  const processItem = (item, kind) => {
    if (!item || typeof item !== 'object') return false;
    if (item._normalizedAt) return false;  // already migrated
    let changed = false;

    const originalText = typeof item.text === 'string' ? item.text : '';
    const normalizedText = normalizeTextInput(originalText);
    const titleChanged = typeof item.title === 'string' && normalizeTextInput(item.title) !== item.title;
    const textChanged = normalizedText !== originalText;

    if (textChanged || titleChanged) {
      tryBackup();
      if (textChanged) {
        item._textBeforeNormalize = originalText;
        item.text = normalizedText;
        if (kind === 'song' && item.translationsByHash && typeof item.translationsByHash === 'object') {
          // Strategy (a): wipe — clean re-translate on next Send to Live
          const hashCount = Object.keys(item.translationsByHash).length;
          item._translationsByHashBeforeNormalize = item.translationsByHash;
          item.translationsByHash = {};
          stats.hashesWiped += hashCount;
        }
        changed = true;
      }
      if (titleChanged) {
        item._titleBeforeNormalize = item.title;
        item.title = normalizeTextInput(item.title);
        changed = true;
      }
    }

    item._normalizedAt = new Date().toISOString();
    return changed || true;  // mark either way — even unchanged items get the marker so we don't re-scan
  };

  for (const orgId of Object.keys(db.organizations || {})) {
    const org = db.organizations[orgId];
    if (!org) continue;
    const songs = Array.isArray(org.globalSongLibrary) ? org.globalSongLibrary : [];
    for (const song of songs) {
      stats.songsScanned += 1;
      if (song?._normalizedAt) { stats.songsSkipped += 1; continue; }
      const before = JSON.stringify({ text: song?.text || '', title: song?.title || '' });
      processItem(song, 'song');
      const after = JSON.stringify({ text: song?.text || '', title: song?.title || '' });
      if (before !== after) { stats.songsChanged += 1; needsSave = true; }
      else needsSave = true;  // we set _normalizedAt marker anyway
    }
    const pinned = Array.isArray(org.pinnedTextLibrary) ? org.pinnedTextLibrary : [];
    for (const item of pinned) {
      stats.pinnedScanned += 1;
      if (item?._normalizedAt) { stats.pinnedSkipped += 1; continue; }
      const before = JSON.stringify({ text: item?.text || '', title: item?.title || '' });
      processItem(item, 'pinned');
      const after = JSON.stringify({ text: item?.text || '', title: item?.title || '' });
      if (before !== after) { stats.pinnedChanged += 1; needsSave = true; }
      else needsSave = true;
    }
  }

  if (needsSave) {
    try { dbStore.save(db); } catch (err) { logger.warn('migrate-normalize: save failed:', err?.message || err); }
  }

  logger.info(`migrate-normalize: songs scanned=${stats.songsScanned} changed=${stats.songsChanged} skipped=${stats.songsSkipped} | pinned scanned=${stats.pinnedScanned} changed=${stats.pinnedChanged} skipped=${stats.pinnedSkipped} | hashesWiped=${stats.hashesWiped}`);
  return stats;
}

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
  if (!event?.id) return false;
  // WORSHIP-DRAFT-1: un draft neaprobat NU e niciodată „live" pentru participanți/public.
  // Worship îl poate edita prin isWorshipEditableEvent (scheduled în viitor) — independent.
  if (event.approved === false) return false;
  return getActiveEventIdForOrg(getEventOrgId(event)) === event.id;
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
// Lock per-eveniment ca să nu ruleze două processText în paralel.
// Race-ul pe lastTranscriptNorm și transcripts[] producea pierdere de text
// la predici lungi cu flush-uri concurente.
const processingLocks = new Map();
const participantPresence = new Map();
const azureSpeechSessions = new Map();

// ── Segmentare text live — DOUĂ seturi, per provider (NU redundante) ──────────────
// Setul LIVE_TEXT_* = calea OpenAI (chunked REST). Chunk-uri mai mari (target 9 / max 16)
// fiindcă OpenAI primește felii audio, nu stream continuu.
const LIVE_TEXT_MIN_WORDS = 4;
const LIVE_TEXT_TARGET_WORDS = 9;
const LIVE_TEXT_MAX_WORDS = 16;
const LIVE_TEXT_MAX_CHARS = 160;
const LIVE_TEXT_SOFT_WAIT_MS = 200;
const LIVE_TEXT_HARD_WAIT_MS = 1000;
// Setul AZURE_LIVE_TEXT_* = calea Azure (streaming nativ). Segmente mai mici/rapide
// (target 6 / max 12) fiindcă Azure dă cuvinte continuu cu latență mică.
const AZURE_LIVE_TEXT_MIN_WORDS = 3;
const AZURE_LIVE_TEXT_TARGET_WORDS = 6;
const AZURE_LIVE_TEXT_MAX_WORDS = 12;
const AZURE_LIVE_TEXT_SOFT_WAIT_MS = 150;
const AZURE_LIVE_TEXT_HARD_WAIT_MS = 600;
// LEGACY (V22.12+): folosit DOAR când AZURE_SMOOTH_MODE=false (smooth e acum default ON).
// În smooth mode commitem pe recognized (final), deci partial-flush-ul ăsta nu rulează.
const AZURE_PARTIAL_FLUSH_THRESHOLD = 8;
// V22.0 — Smooth mode: când true, sărim SMART FLUSH V2 (commit doar pe recognized,
// adică pe sfârșit-de-propoziție real de la Azure). Reduce „sare prea repede" și
// scade aglomerarea traducerilor. Default false (no behavior change unless explicit).
// V22.12 — smooth mode DEFAULT ON (commit pe final, fluiditate). Opozabil: doar
// AZURE_SMOOTH_MODE=false explicit revine la legacy partial-flush.
const AZURE_SMOOTH_MODE = String(process.env.AZURE_SMOOTH_MODE || 'true').toLowerCase() !== 'false';
logger.info('[Azure] smooth mode:', AZURE_SMOOTH_MODE ? 'ON (commit only on recognized) [default]' : 'OFF (legacy partial-flush, AZURE_SMOOTH_MODE=false)');

// Conectori clasici - blochează flush la sfârșit (păstrează în buffer pentru context)
// ATENȚIE: scoatem 'și', 'si', 'să', 'sa', 'dar', 'iar' - acum sunt FLUSH_BEFORE triggers
const BUFFER_CONNECTORS = new Set([
  'ca',  // EXCEPȚIE: 'ca' rămâne conector (ca să, ca un)
  'ori', 'sau',
  'de', 'la', 'în', 'in', 'cu', 'pe', 'din', 'spre', 'pentru',
  'când', 'cand', 'care', 'ce', 'către', 'catre',
  'og', 'at', 'men', 'som', 'i', 'på', 'med', 'til', 'for'
]);

// SMART FLUSH V1: cuvinte care DECLANȘEAZĂ flush proactiv în limba română
// FLUSH_BEFORE: cuvântul curent începe propoziție nouă - flush conținut ANTERIOR, păstrează cuvântul
const FLUSH_BEFORE_WORDS = new Set([
  'și', 'si',
  'să', 'sa',
  'dar',
  'iar',
  'așa', 'asa'
]);

// FLUSH_AFTER: cuvântul ÎNCHEIE propoziția curentă - flush propoziția cu acest cuvânt inclus
const FLUSH_AFTER_WORDS = new Set([
  'că',
  'ta', 'mea', 'lui', 'ei', 'noastră', 'noastra', 'voastră', 'voastra', 'lor'
]);

function summarizeEvent(event) {
  const org = getOrganizationForEvent(event);
  ensureEventShortId(event);
  return {
    id: event.id,
    shortId: event.shortId,
    organizationId: org.id,
    organizationName: org.name,
    hidden: !!event.hidden,
    testMode: !!event.testMode,
    // WORSHIP-DRAFT-1: flag-uri pentru admin UI (filtrare „de aprobat")
    worshipDraft: !!event.worshipDraft,
    approved: event.approved !== false,
    createdByWorship: !!event.createdByWorship,
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

// BUGFIX V7: agnostic input normalizer for ALL user-supplied text (paste/save/edit).
// IDEMPOTENT — calling repeatedly produces same result. Steps:
//   1. Strip BOM at start (﻿)
//   2. NFC Unicode normalization (canonical composition: 'a'+combining-diacritic → 'á')
//   3. Mojibake repair (Ã®/È™/â€™ etc. → original chars from double-UTF-8 history)
//   4. Romanian sedilla → modern comma-below (Latin-2 → Unicode 3.0+)
//      THIS IS THE ROOT CAUSE FIX for the "OpenAI returns wrong language" bug:
//      mixed ş (U+015F)/ţ (U+0163) with ș (U+0219)/ț (U+021B) confused gpt-4o-mini
//      and made it interpret RO text as non-RO → returned English instead of Norwegian.
//   5. Strip remaining zero-width chars (U+200B/200C/200D/2060/FEFF)
// NOT done: smart-quote replacement (could change user-facing intent).
// HOTFIX V7.1: ZERO_WIDTH_CHARS + MOJIBAKE_MAP hoisted near LANGUAGES (top of file) to avoid
// TDZ ReferenceError when migrateNormalizeContent runs at startup before this line is reached.
function normalizeTextInput(text) {
  if (text === null || text === undefined) return '';
  let s = String(text);
  if (!s) return '';
  // 1. BOM strip
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  // 2. NFC normalization (canonical composition)
  if (typeof s.normalize === 'function') {
    try { s = s.normalize('NFC'); } catch (_) { /* fall through if engine refuses */ }
  }
  // 3. Mojibake repair (split/join is fast for short strings; avoids regex special-char headaches)
  for (const bad in MOJIBAKE_MAP) {
    if (s.indexOf(bad) !== -1) s = s.split(bad).join(MOJIBAKE_MAP[bad]);
  }
  // 4. Romanian: sedilla (Latin-2) → comma-below (Unicode 3.0+)
  s = s
    .replace(/ş/g, 'ș')  // ş → ș
    .replace(/Ş/g, 'Ș')  // Ş → Ș
    .replace(/ţ/g, 'ț')  // ţ → ț
    .replace(/Ţ/g, 'Ț'); // Ţ → Ț
  // 5. Strip leftover zero-width chars
  s = s.replace(ZERO_WIDTH_CHARS, '');
  return s;
}

function sanitizeStructuredText(text) {
  // BUGFIX V7: normalize encoding + mojibake first, then existing whitespace/punctuation cleanup.
  // Single point of intervention — all save/edit/translate paths flow through this function.
  return normalizeTextInput(text)
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

const BIBLE_REF_OR_TIME_RE = /\b\d{1,3}:\d{1,3}(?:[-–]\d{1,3})?\b/g;

function maskNumericColons(text) {
  const placeholders = [];
  const masked = String(text).replace(BIBLE_REF_OR_TIME_RE, (match) => {
    placeholders.push(match);
    return `__REF${placeholders.length - 1}__`;
  });
  return { masked, placeholders };
}

function unmaskNumericColons(text, placeholders) {
  return String(text).replace(/__REF(\d+)__/g, (_, idx) => placeholders[Number(idx)] || _);
}

const SPLIT_STICKY_WORDS = new Set([
  'și', 'si', 'sau', 'ori', 'dar', 'iar', 'de', 'la', 'pe', 'în', 'in', 'cu',
  'să', 'sa', 'că', 'ca', 'sub', 'din', 'spre', 'prin', 'după', 'dupa',
  'a', 'al', 'ale', 'ai', 'cel', 'cea', 'un', 'o',
  'og', 'i', 'på', 'med', 'til', 'for', 'som', 'at', 'av', 'om'
]);

const SPLIT_PREFER_BEFORE = new Set([
  'care', 'ce', 'cine', 'unde', 'când', 'cand', 'cum', 'pentru', 'dacă', 'daca'
]);

function splitWordsSmart(words) {
  const out = [];
  let i = 0;
  while (i < words.length) {
    const remaining = words.length - i;
    if (remaining <= LIVE_TEXT_TARGET_WORDS + 2) {
      out.push(words.slice(i).join(' ').trim());
      break;
    }
    const idealCut = i + LIVE_TEXT_TARGET_WORDS;
    const minCut = i + Math.max(LIVE_TEXT_MIN_WORDS, 4);
    const maxCut = Math.min(words.length - 2, i + LIVE_TEXT_TARGET_WORDS + 3);
    let bestIdx = idealCut;
    let bestScore = -Infinity;
    const lo = Math.max(minCut, idealCut - 3);
    const hi = Math.min(maxCut, idealCut + 3);
    for (let j = lo; j <= hi; j++) {
      const prevRaw = words[j - 1] || '';
      const prev = prevRaw.toLowerCase().replace(/[.,;:!?]+$/, '');
      const next = (words[j] || '').toLowerCase();
      let score = 0;
      if (/[,;:]$/.test(prevRaw)) score += 5;
      if (SPLIT_PREFER_BEFORE.has(next)) score += 3;
      if (j === idealCut) score += 0.5;
      if (SPLIT_STICKY_WORDS.has(prev)) score -= 6;
      if (score > bestScore) { bestScore = score; bestIdx = j; }
    }
    out.push(words.slice(i, bestIdx).join(' ').trim());
    i = bestIdx;
  }
  return out.filter(Boolean);
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
    return splitWordsSmart(clean.split(/\s+/).filter(Boolean));
  }

  const expanded = [];
  for (const part of softerParts) {
    if (countWords(part) > LIVE_TEXT_TARGET_WORDS + 2) {
      splitWordsSmart(part.split(/\s+/).filter(Boolean)).forEach((p) => expanded.push(p));
    } else {
      expanded.push(part);
    }
  }

  const out = [];
  let current = '';
  for (const part of expanded) {
    const candidate = current ? `${current} ${part}` : part;
    if (countWords(candidate) <= LIVE_TEXT_TARGET_WORDS && candidate.length <= LIVE_TEXT_MAX_CHARS) {
      current = candidate;
    } else {
      if (current && countWords(current) < LIVE_TEXT_MIN_WORDS && countWords(candidate) <= LIVE_TEXT_MAX_WORDS) {
        current = candidate;
        continue;
      }
      if (current) out.push(current.trim());
      current = part;
    }
  }
  if (current) out.push(current.trim());

  if (out.length >= 2 && countWords(out[out.length - 1]) < LIVE_TEXT_MIN_WORDS) {
    const last = out.pop();
    const penult = out.pop();
    const combined = `${penult} ${last}`;
    if (countWords(combined) <= LIVE_TEXT_MAX_WORDS) {
      out.push(combined.trim());
    } else {
      out.push(penult);
      out.push(last);
    }
  }
  return out.filter(Boolean);
}

function splitIntoDisplayChunks(text) {
  const clean = sanitizeTranscriptText(text);
  if (!clean) return [];

  const { masked, placeholders } = maskNumericColons(clean);

  const sentenceUnits = masked.match(/[^.!?]+[.!?]?/g)?.map((x) => x.trim()).filter(Boolean) || [masked];
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

  const merged = [];
  for (const piece of smallPieces) {
    const last = merged[merged.length - 1];
    if (last) {
      const lastWords = countWords(last);
      const pieceWords = countWords(piece);
      const tooSmall = lastWords < LIVE_TEXT_MIN_WORDS || pieceWords < LIVE_TEXT_MIN_WORDS;
      if (tooSmall && lastWords + pieceWords <= LIVE_TEXT_MAX_WORDS) {
        merged[merged.length - 1] = `${last} ${piece}`;
        continue;
      }
    }
    merged.push(piece);
  }

  return merged.map((c) => unmaskNumericColons(c, placeholders)).filter(Boolean);
}

function shouldFlushBufferedText(text, options = {}) {
  const clean = sanitizeTranscriptText(text);
  if (!clean) return false;
  const words = countWords(clean);
  const last = getLastWord(clean);
  const lastLower = String(last || '').toLowerCase();
  const minWords = options.minWords || LIVE_TEXT_MIN_WORDS;
  const targetWords = options.targetWords || LIVE_TEXT_TARGET_WORDS;
  const maxWords = options.maxWords || LIVE_TEXT_MAX_WORDS;

  // 1. Punctuație finală (.!?) → flush dacă min words
  if (/[.!?]\s*$/.test(clean) && words >= minWords) return true;

  // 2. Punctuație medie (,;:) → flush dacă min words
  if (/[,;:]\s*$/.test(clean) && words >= minWords) return true;

  // 3. SMART FLUSH V1 - FLUSH_AFTER: ultimul cuvânt e „că" sau posesiv → flush imediat (cu min words)
  if (FLUSH_AFTER_WORDS.has(lastLower) && words >= minWords) return true;

  // 4. Target words atinse + ultimul cuvânt NU e conector clasic → flush
  if (words >= targetWords && !BUFFER_CONNECTORS.has(lastLower)) return true;

  // 5. Max words override (forțat oricum)
  if (words >= maxWords) return true;

  return false;
}

// TASK 37: Tracker pentru text deja trimis prin partial flush
// Previne dubluri când Azure trimite și `recognized` după un partial flush
const partialFlushTracker = new Map(); // eventId -> { lastFlushedText, timestamp }

// AZURE-WORDCOUNT-FLUSH — segmentarea Azure pe timp (Speech_SegmentationSilenceTimeoutMs) nu e fiabilă în
// SDK-ul JS (limitare cunoscută Microsoft) → frazele se adună. Tăiem proactiv la NR. DE CUVINTE, prag PER MOD.
const WORDCOUNT_FLUSH_BY_MODE = { rapid: 12, balanced: 12, clear: 25, interpret: 25 };
function getWordcountFlushThreshold(speed) {
  return WORDCOUNT_FLUSH_BY_MODE[speed] || WORDCOUNT_FLUSH_BY_MODE.balanced;
}
// Flag per-event: setat DOAR când NOI am tăiat partial-ul la cuvinte în smooth mode. Îl folosim ca
// `recognized` (finalul) să facă delta DOAR atunci (altfel păstrăm commit-ul curat V22.5 neatins).
const wordFlushedEvents = new Set();

function isPartialFlushDuplicate(eventId, newText, windowMs = 3000) {
  const tracker = partialFlushTracker.get(eventId);
  if (!tracker) return false;
  if (Date.now() - tracker.timestamp > windowMs) {
    partialFlushTracker.delete(eventId);
    return false;
  }
  // Dacă noul text începe cu textul deja flush-uit, e probabil duplicat
  const norm = (s) => sanitizeTranscriptText(s || '').toLowerCase().trim();
  const old = norm(tracker.lastFlushedText);
  const fresh = norm(newText);
  if (!old || !fresh) return false;
  return fresh.startsWith(old) || old.startsWith(fresh) || fresh.includes(old.slice(0, 40));
}

function markPartialFlushed(eventId, text) {
  partialFlushTracker.set(eventId, {
    lastFlushedText: text,
    timestamp: Date.now()
  });
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
    hidden: !!event.hidden,
    testMode: !!event.testMode,
    // WORSHIP-DRAFT-1: flag-uri pentru admin UI (filtrare „de aprobat")
    worshipDraft: !!event.worshipDraft,
    approved: event.approved !== false,
    createdByWorship: !!event.createdByWorship,
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
    bibleMode: !!event.bibleMode,
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
  const clockPosition = ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(input.clockPosition) ? input.clockPosition : 'bottom-right';
  const clockScale = typeof input.clockScale === 'number' ? Math.min(2.5, Math.max(0.7, input.clockScale)) : 2;
  const textSize = ['compact', 'large', 'xlarge', 'huge'].includes(input.textSize) ? input.textSize : 'large';
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

// Hash stabil per strofă pentru cache-ul de traduceri din library.
// Folosit ca cheie în translationsByHash, astfel încât editarea unei singure
// strofe invalidează doar acea strofă (hash diferit = cache miss), iar restul
// strofelor neschimbate rămân cached.
function hashBlock(text) {
  return createHash('sha256').update(String(text || '').trim()).digest('hex').slice(0, 16);
}

function upsertLibraryItem(list, { title, text, labels, sourceLang, key, sections, sectionNotes }, maxItems = 100) {
  const safeTitle = String(title || '').trim();
  const safeText = sanitizeStructuredText(text || '');
  const parsedSong = splitSongBlocksWithLabels(safeText, labels || []);
  const safeLabels = parsedSong.labels;
  const normalizedTitle = normalizeLibraryTitle(safeTitle);
  const existingIndex = list.findIndex((item) => normalizeLibraryTitle(item.title) === normalizedTitle);
  const existingItem = existingIndex >= 0 ? list[existingIndex] : null;
  // FIX-KEY-PRESERVE + LIBRARY-KEY-GLOBAL — păstrează key existent la re-edit; dacă apelantul
  // pasează un key (ex. seed din biblioteca globală la songs/add), îl preferă (ca punct de start).
  const resolvedKey = typeof key === 'string' && key
    ? key.slice(0, 12)
    : (typeof existingItem?.key === 'string' ? existingItem.key : '');
  // WORSHIP-SECTIONS-A — păstrează sections existent la re-edit; dacă apelantul pasează,
  // preferă (seed din biblioteca globală la songs/add). Validare: doar verse|chorus|bridge.
  const SECTION_ALLOWED = ['verse', 'chorus', 'bridge'];
  const validateSections = (arr) => Array.isArray(arr)
    ? arr.map((x) => (SECTION_ALLOWED.includes(x) ? x : 'verse'))
    : null;
  const resolvedSections = validateSections(sections)
    || validateSections(existingItem?.sections)
    || [];
  // WORSHIP-NOTES-1 — păstrează note de interpretare per-bloc (paralele cu sections);
  // dacă apelantul pasează (seed din global la songs/add), preferă. Slice 200 chars max.
  const validateNotes = (arr) => Array.isArray(arr)
    ? arr.map((n) => String(n == null ? '' : n).slice(0, 200))
    : null;
  const resolvedSectionNotes = validateNotes(sectionNotes)
    || validateNotes(existingItem?.sectionNotes)
    || [];
  const payload = {
    id: existingItem ? existingItem.id : randomUUID(),
    title: safeTitle,
    text: safeText,
    labels: safeLabels,
    sourceLang: String(sourceLang || existingItem?.sourceLang || 'ro').trim() || 'ro',
    key: resolvedKey,
    sections: resolvedSections,
    sectionNotes: resolvedSectionNotes,
    // Păstrăm cache-ul de traduceri per strofă; per-block hash invalidation
    // ține automat cache-ul valid pentru strofele neschimbate, indiferent dacă
    // alte strofe s-au editat (vor avea hash nou = cache miss controlat).
    translationsByHash: existingItem?.translationsByHash || {},
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
  const cookieCode = getOperatorCodeFromCookie(req);
  if (cookieCode) return cookieCode;
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
  // SEC-AUDIT-2026-06 A2: all code/PIN checks below use safeStringEqual (timingSafeEqual).
  if (MASTER_ADMIN_PIN && safeStringEqual(suppliedCode, MASTER_ADMIN_PIN)) {
    return { role: 'admin', permissions: ['main_screen', 'song'], operator: null };
  }
  if (safeStringEqual(suppliedCode, String(event.adminCode || ''))) {
    return { role: 'admin', permissions: ['main_screen', 'song'], operator: null };
  }
  if (MASTER_MODERATOR_PIN && safeStringEqual(suppliedCode, MASTER_MODERATOR_PIN)) {
    return {
      role: 'screen',
      permissions: ['main_screen', 'song'],
      operator: { id: 'master-moderator', name: 'Master Moderator', profile: 'full', code: suppliedCode }
    };
  }
  if (globalAccess.mainOperatorCode && safeStringEqual(suppliedCode, globalAccess.mainOperatorCode)) {
    return {
      role: 'screen',
      permissions: ['main_screen', 'song'],
      operator: { id: 'main-operator', name: 'Main Operator', profile: 'full', code: suppliedCode, permanent: true }
    };
  }
  if (safeStringEqual(suppliedCode, String(event.screenOperatorCode || ''))) {
    return {
      role: 'screen',
      permissions: ['main_screen', 'song'],
      operator: { id: 'default-screen', name: 'Default operator', profile: 'full', code: suppliedCode }
    };
  }
  const operator = (event.remoteOperators || []).find((item) => safeStringEqual(String(item.code || ''), suppliedCode));
  if (operator) {
    return {
      role: 'screen',
      permissions: getRemoteOperatorPermissions(operator.profile),
      operator
    };
  }
  const granted = (getOrganizationForEvent(event)?.grantedOperators || [])
    .find((entry) => safeStringEqual(String(entry?.code || '').trim(), suppliedCode));
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
  // SEC-AUDIT-2026-06 A2: timing-safe comparisons; an empty supplied code never matches.
  if (MASTER_ADMIN_PIN && safeStringEqual(suppliedCode, MASTER_ADMIN_PIN)) return true;
  const appAdminCode = String(process.env.APP_ADMIN_CODE || process.env.ADMIN_CODE || '').trim();
  if (appAdminCode && safeStringEqual(suppliedCode, appAdminCode)) return true;
  const events = Object.values(db.events || {});
  if (!events.length && !appAdminCode && !MASTER_ADMIN_PIN && !COMMERCIAL_MODE) return true;
  if (!suppliedCode) return false;
  return events.some((event) => safeStringEqual(String(event.adminCode || ''), suppliedCode));
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
    event.screenOperatorCode = generateSecureCode('SV-SCREEN');
  }
  ensureEventShortId(event);
  if ((typeof event.scheduledTimestamp !== 'number') && event.scheduledAt) {
    const scheduling = deriveScheduledFields({
      scheduledAt: event.scheduledAt,
      scheduledDate: event.scheduledDate,
      scheduledTime: event.scheduledTime,
      timezone: event.timezone
    });
    if (scheduling.scheduledTimestamp) {
      event.scheduledTimestamp = scheduling.scheduledTimestamp;
      event.scheduledDate = event.scheduledDate || scheduling.scheduledDate;
      event.scheduledTime = event.scheduledTime || scheduling.scheduledTime;
      event.timezone = event.timezone || scheduling.timezone || 'UTC';
    }
  }
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
    const bytes = randomBytes(EVENT_SHORT_ID_LENGTH);
    let candidate = '';
    for (let i = 0; i < EVENT_SHORT_ID_LENGTH; i += 1) {
      candidate += EVENT_SHORT_ID_ALPHABET[bytes[i] % EVENT_SHORT_ID_ALPHABET.length];
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

async function createEvent({ name, speed, sourceLang, targetLangs, baseUrl, scheduledAt, scheduledDate, scheduledTime, timezone, hidden = false, testMode = false, organizationId = DEFAULT_ORG_ID, worshipDraft = false, approved = true, createdByWorship = false }) {
  const organization = ensureOrganization(organizationId);
  const id = randomUUID();
  const adminCode = generateSecureCode('SV-ADMIN');
  const screenOperatorCode = generateSecureCode('SV-SCREEN');
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
    hidden: !!hidden,
    testMode: !!testMode,
    // WORSHIP-DRAFT-1: draft worship neaprobat — invizibil participanților + nu poate merge live
    worshipDraft: !!worshipDraft,
    approved: approved !== false,
    createdByWorship: !!createdByWorship,
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
    bibleMode: false,
    pushSubscriptions: [],
    songState: defaultSongState(),
    latestDisplayEntry: null,
    // V21.27: prefer 'ro' as display language when it's actually in the
    // event's targetLangs; otherwise fall back to the first targetLang
    // (or 'ro' as last resort — ensureEventUiState then normalizes if
    // needed). blackScreen=true comes from defaultDisplayState().
    displayState: { ...defaultDisplayState(), language: (targetLangs?.includes('ro') ? 'ro' : (targetLangs?.[0] || 'ro')) },
    displayStatePrevious: null,
    songLibrary: defaultSongLibrary(),
    songHistory: defaultSongHistory(),
    usageStats: defaultUsageStats()
  };

  db.events[id] = event;
  // WORSHIP-DRAFT-1: draft-urile NU se auto-activează (admin le aprobă + activează ulterior)
  if (!worshipDraft) {
    setActiveEventIdForOrg(organization.id, id);
  }
  saveDb();
  setImmediate(() => {
    if (!worshipDraft) io.emit('active_event_changed', { eventId: id });
    // V21.18: refresh permanent worship-view subscribers.
    broadcastPermanentWorshipView();
  });
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

function buildTranslationCacheKey({ text, langCode, sourceLang, speed, glossary, context }) {
  return [
    String(sourceLang || ''),
    String(langCode || ''),
    String(speed || ''),
    getGlossaryCacheKey(glossary),
    String(context || ''),
    sanitizeStructuredText(text || '')
  ].join('::');
}

const translationCacheStats = { hits: 0, misses: 0 };
const TRANSLATION_CACHE_FILE = path.join(DATA_DIR, 'translation-cache.json');
let translationCacheDirty = false;
let translationCacheFlushTimer = null;

// BUGFIX V5: append-only log of OpenAI language-mismatch events for investigation
// (max 500 entries, oldest pruned). Helps diagnose what prompt/text triggers the model to drift.
const LANG_MISMATCH_LOG_FILE = path.join(DATA_DIR, 'lang-mismatch-log.json');
const LANG_MISMATCH_LOG_LIMIT = 500;

// V22.35 — log în memorie + flush DEBOUNCED async (nu mai face I/O sincron pe fiecare mismatch)
let langMismatchBuffer = null;
let langMismatchFlushTimer = null;
function flushLangMismatchLog() {
  langMismatchFlushTimer = null;
  if (!langMismatchBuffer) return;
  const toWrite = JSON.stringify(langMismatchBuffer);
  fs.promises.mkdir(DATA_DIR, { recursive: true })
    .then(() => fs.promises.writeFile(LANG_MISMATCH_LOG_FILE, toWrite, 'utf8'))
    .catch((err) => logger.warn('lang-mismatch log write failed:', err?.message || err));
}
function logLangMismatch(entry) {
  try {
    if (langMismatchBuffer === null) {
      langMismatchBuffer = [];
      try {
        if (fs.existsSync(LANG_MISMATCH_LOG_FILE)) {
          const parsed = JSON.parse(fs.readFileSync(LANG_MISMATCH_LOG_FILE, 'utf8'));
          if (Array.isArray(parsed)) langMismatchBuffer = parsed;
        }
      } catch (_) { langMismatchBuffer = []; }
    }
    langMismatchBuffer.push({ ts: new Date().toISOString(), ...entry });
    if (langMismatchBuffer.length > LANG_MISMATCH_LOG_LIMIT) {
      langMismatchBuffer = langMismatchBuffer.slice(-LANG_MISMATCH_LOG_LIMIT);
    }
    if (!langMismatchFlushTimer) {
      langMismatchFlushTimer = setTimeout(flushLangMismatchLog, 3000);
    }
  } catch (err) {
    logger.warn('lang-mismatch log buffer failed:', err?.message || err);
  }
}

function loadPersistentTranslationCache() {
  try {
    if (!fs.existsSync(TRANSLATION_CACHE_FILE)) return;
    const raw = fs.readFileSync(TRANSLATION_CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // BUGFIX V5: dedupe by key BEFORE applying the cache limit — duplicate writes from
      // previous concurrent-server races shouldn't eat into the 2000-entry budget.
      // Last value wins (most recent write is kept), matching Map.set semantics.
      const dedupMap = new Map();
      let duplicates = 0;
      for (const pair of parsed) {
        if (Array.isArray(pair) && pair.length === 2 && pair[0] && pair[1]) {
          const key = String(pair[0]);
          if (dedupMap.has(key)) duplicates += 1;
          dedupMap.set(key, String(pair[1]));
        }
      }
      let loaded = 0;
      for (const [key, value] of dedupMap) {
        translationCache.set(key, value);
        loaded += 1;
        if (translationCache.size >= TRANSLATION_CACHE_LIMIT) break;
      }
      if (duplicates) {
        logger.info(`translation cache: removed ${duplicates} duplicate keys at load`);
        translationCacheDirty = true;
        scheduleTranslationCacheFlush();
      }
      logger.info(`translation cache: restored ${loaded} entries from disk`);
    }
  } catch (err) {
    logger.warn('translation cache load failed:', err?.message || err);
  }
}

function flushPersistentTranslationCache() {
  if (!translationCacheDirty) return;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const entries = Array.from(translationCache.entries()).slice(-TRANSLATION_CACHE_LIMIT);
    // SEC-AUDIT-2026-06 C1: atomic write so a crash can't truncate the cache file.
    atomicWriteFileSync(TRANSLATION_CACHE_FILE, JSON.stringify(entries));
    translationCacheDirty = false;
  } catch (err) {
    logger.warn('translation cache flush failed:', err?.message || err);
  }
}

function scheduleTranslationCacheFlush() {
  if (translationCacheFlushTimer) return;
  translationCacheFlushTimer = setTimeout(() => {
    translationCacheFlushTimer = null;
    flushPersistentTranslationCache();
  }, 60 * 1000);
  if (translationCacheFlushTimer.unref) translationCacheFlushTimer.unref();
}

function readTranslationCache(key) {
  if (!translationCache.has(key)) {
    translationCacheStats.misses += 1;
    return null;
  }
  const value = translationCache.get(key);
  translationCache.delete(key);
  translationCache.set(key, value);
  translationCacheStats.hits += 1;
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
  translationCacheDirty = true;
  scheduleTranslationCacheFlush();
}

function getTranslationCacheSnapshot() {
  const total = translationCacheStats.hits + translationCacheStats.misses;
  return {
    size: translationCache.size,
    limit: TRANSLATION_CACHE_LIMIT,
    hits: translationCacheStats.hits,
    misses: translationCacheStats.misses,
    hitRate: total ? Math.round((translationCacheStats.hits / total) * 1e4) / 100 : 0
  };
}

function buildAccessCode(prefix) {
  return generateSecureCode(prefix);
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
    clear: 'Translate carefully and clearly for church live listening. Keep it fluid, not rigid.',
    // TRANSLATION-MODE-INTERPRET — parafrazare ca interpret uman consecutiv (sens fidel, mai concis)
    interpret: 'Act as a professional consecutive interpreter for a fast speaker. Convey the full MEANING faithfully, but be CONCISE: paraphrase and condense naturally so the listener keeps pace, the way a human interpreter compresses while staying accurate. Drop filler and redundancy, never drop actual content or change the message. Aim for noticeably fewer words than a literal translation.'
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
    'Use natural punctuation, including commas where a fluent sentence needs them.',
    'Only use a question mark if the source is clearly a question; otherwise end with a period.',
    'If the source contains direct vulgar words or crude anatomical terms, use a polite euphemism appropriate for a religious service audience. Keep the meaning intact but soften the wording. This applies only to genuinely crude language; do not over-censor normal words.',
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

// V22.37 — limitează câte traduceri rulează simultan (stiva nu se mai umflă sub val de chunk-uri)
const TRANSLATE_MAX_CONCURRENT = 4;
let translateActive = 0;
const translateWaitQueue = [];
function acquireTranslateSlot() {
  if (translateActive < TRANSLATE_MAX_CONCURRENT) {
    translateActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => translateWaitQueue.push(resolve));
}
function releaseTranslateSlot() {
  translateActive = Math.max(0, translateActive - 1);
  const next = translateWaitQueue.shift();
  if (next) { translateActive++; next(); }
}

async function translateText(text, langCode, event, sourceLangOverride = '', options = {}) {
  const glossary = getGlossaryForLang(langCode, event);
  const cleanText = sanitizeStructuredText(text);
  const sourceLang = String(sourceLangOverride || event.sourceLang || 'ro').trim() || 'ro';
  if (!cleanText) return '';
  if (langCode === sourceLang) return cleanText;
  const contextEntries = Array.isArray(options.contextEntries) ? options.contextEntries : [];
  const usableContext = contextEntries
    .filter((entry) => entry && entry.original && entry.translations && entry.translations[langCode])
    .slice(-2);
  const contextSignature = usableContext.map((entry) => entry.id || `${entry.original}|${entry.translations[langCode]}`).join('|');
  const cacheKey = buildTranslationCacheKey({
    text: cleanText,
    langCode,
    sourceLang,
    speed: event.speed,
    glossary,
    context: contextSignature
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
  const inputMessages = [
    { role: 'system', content: buildPrompt(LANGUAGES[sourceLang] || sourceLang, LANGUAGES[langCode] || langCode, event.speed, glossary) }
  ];
  for (const entry of usableContext) {
    inputMessages.push({ role: 'user', content: entry.original });
    inputMessages.push({ role: 'assistant', content: entry.translations[langCode] });
  }
  inputMessages.push({ role: 'user', content: cleanText });
  // V22.15 — modul „clear" (calitate) → model mai bun; rapid/balanced → nano (rapid).
  // TRANSLATION-MODE-INTERPRET — clear ȘI interpret folosesc modelul de calitate (mini, mai bun la parafrazat)
  const translateModel = (event && (event.speed === 'clear' || event.speed === 'interpret')) ? OPENAI_QUALITY_MODEL : OPENAI_MODEL;
  await acquireTranslateSlot();   // V22.37 — limitează concurența traducerilor
  try {
    const onDelta = typeof options.onDelta === 'function' ? options.onDelta : null;
    const TRANSLATE_TIMEOUT_MS = 8000;
    // V22.32 — timeout care REZOLVĂ cu sentinel (nu reject), ca să nu rămână promisiuni
    // respinse orfan din Promise.race (cauza unhandledRejection → crash → 429 la repornire).
    const TIMEOUT_SENTINEL = Symbol('translate_timeout');
    const abortController = new AbortController();   // V22.34
    let timeoutHandle;
    const timeoutPromise = new Promise((resolve) => {
      timeoutHandle = setTimeout(() => resolve(TIMEOUT_SENTINEL), TRANSLATE_TIMEOUT_MS);
    });
    const translatePromise = onDelta
      ? translationService.translateWithResponsesStreaming({
          model: translateModel,
          input: inputMessages,
          onDelta,
          signal: abortController.signal   // V22.34
        })
      : translationService.translateWithResponsesDetailed({
          model: translateModel,
          input: inputMessages
        });
    // dacă translatePromise pierde race-ul și se respinge ulterior, nu lăsa rejection neprins
    translatePromise.catch(() => {});
    let result;
    try {
      const raced = await Promise.race([translatePromise, timeoutPromise]);
      if (raced === TIMEOUT_SENTINEL) {
        abortController.abort();   // V22.34 — oprește stream-ul orfan
        throw new Error('translate_timeout');
      }
      result = raced;
    } finally {
      clearTimeout(timeoutHandle);
    }
    const translatedText = result.text;
    if (result.tokens) recordTranslationUsage(event, result.tokens);
    let translated = sanitizeStructuredText(translatedText);

    // V22.35 — sursa e mereu setată manual, deci retry-ul „output-ul pare limba sursă?" e inutil
    // și dăunător (furtună de retry pe nume proprii cu diacritice → crash). Păstrăm DOAR logarea
    // (async/debounced) pentru vizibilitate; afișăm întotdeauna traducerea.
    if (translated) {
      const detected = detectLanguage(translated);
      if (detected.lang !== 'unknown' && detected.lang !== langCode && detected.confidence === 'high') {
        const targetLangName = LANGUAGES[langCode] || langCode;
        console.warn(`[LANG_MISMATCH] expected=${langCode} (${targetLangName}) detected=${detected.lang} src="${cleanText.slice(0, 80)}" out="${translated.slice(0, 80)}" (logged, no retry)`);
        logLangMismatch({
          stage: 'observed-no-retry',
          expectedLang: langCode,
          expectedLangName: targetLangName,
          detectedLang: detected.lang,
          detectedConfidence: detected.confidence,
          sourceText: cleanText.slice(0, 300),
          outText: translated.slice(0, 300)
        });
      }
    }

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
    updateTranslationMonitor(event, {
      pendingTranslations: Math.max(0, Number(event.translationMonitor?.pendingTranslations || 1) - 1),
      lastTranslateFinishedAt: new Date().toISOString(),
      lastTargetLang: langCode
    });
    return '';
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
  } finally {
    releaseTranslateSlot();   // V22.37 — eliberează slotul pe TOATE căile (return/throw)
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

// BUGFIX V5: agnostic language detector for short-medium texts (1-300 words).
// Heuristic-based (no extra deps): combines script signals (cyrillic, nordic, romanian, polish, hungarian)
// with word-list scoring for latin-script languages without unique diacritics (en/es/fr/it/pt).
// Returns { lang, confidence: 'low'|'medium'|'high' }. Returns 'unknown' when no clear signal — never
// flags ambiguous text. Designed so adding new languages = extend LANG_DETECT_WORDS or add a script
// regex above the word-list pass; no consumer refactor needed.
const LANG_DETECT_WORDS = {
  en: ['the','and','you','we','our','is','are','to','of','in','for','on','with','that','have','it','this','be','from','will','your'],
  no: ['og','er','vi','ikke','jeg','det','en','et','på','til','av','som','har','i','de','for','men','han','hun','vår','være'],
  es: ['el','la','los','las','que','de','y','en','un','una','es','con','por','para','no','su','se','del','al','tu','nuestro'],
  fr: ['le','la','les','que','de','et','en','un','une','est','dans','pour','avec','nous','vous','sur','ce','je','pas','votre','notre'],
  it: ['il','la','di','che','e','un','una','è','per','con','da','non','sono','noi','voi','ti','si','gli','le','nostro'],
  pt: ['o','a','os','as','que','de','e','um','uma','é','com','para','não','nós','você','seu','sua','do','da','no','na','nosso']
};

function detectLanguage(text) {
  const sample = String(text || '').trim();
  if (sample.length < 15) return { lang: 'unknown', confidence: 'low' };

  // Strong script signals first (high confidence — these characters don't appear elsewhere)
  if (/[؀-ۿ]/.test(sample)) return { lang: 'ar', confidence: 'high' };
  if (/[Ͱ-Ͽ]/.test(sample)) return { lang: 'el', confidence: 'high' };
  if (/[Ѐ-ӿ]/.test(sample)) {
    // Distinguish Ukrainian (has ґєіїҐЄІЇ) from Russian
    if (/[ҐґЄєІіЇї]/.test(sample)) return { lang: 'uk', confidence: 'high' };
    return { lang: 'ru', confidence: 'high' };
  }
  if (/[æøåÆØÅ]/.test(sample)) return { lang: 'no', confidence: 'high' };
  if (/[ăâîșşțţĂÂÎȘŞȚŢ]/.test(sample)) return { lang: 'ro', confidence: 'high' };
  if (/[ąęłńóśźżĄĘŁŃÓŚŹŻ]/.test(sample)) return { lang: 'pl', confidence: 'high' };
  if (/[őűŐŰ]/.test(sample)) return { lang: 'hu', confidence: 'high' };
  // German umlauts can appear in loan words too — medium confidence only
  if (/[äöüÄÖÜß]/.test(sample)) return { lang: 'de', confidence: 'medium' };

  // Word-list pass for latin-script languages without unique diacritics (en/es/fr/it/pt)
  const lower = sample.toLowerCase();
  const words = lower.split(/[^a-zàâçéèêëîïôûùüÿñæœ]+/i).filter((w) => w.length > 0);
  if (words.length < 3) return { lang: 'unknown', confidence: 'low' };

  const scores = {};
  for (const [lang, set] of Object.entries(LANG_DETECT_WORDS)) {
    const setLookup = new Set(set);
    scores[lang] = words.filter((w) => setLookup.has(w)).length;
  }
  let bestLang = 'unknown';
  let bestScore = 0;
  for (const [lang, score] of Object.entries(scores)) {
    if (score > bestScore) { bestScore = score; bestLang = lang; }
  }
  const sorted = Object.values(scores).sort((a, b) => b - a);
  const gap = sorted[0] - (sorted[1] || 0);
  const density = bestScore / words.length;
  if (bestScore >= 3 && density > 0.15 && gap >= 2) return { lang: bestLang, confidence: 'high' };
  if (bestScore >= 2 && density > 0.1) return { lang: bestLang, confidence: 'medium' };
  return { lang: 'unknown', confidence: 'low' };
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

const WHISPER_EMPTY_RETRY_MIN_BYTES = 4000;

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
        : 'The audio is a live church service or sermon. The speaker may quote Scripture verbatim. Keep the transcript in the selected source language. Keep names and punctuation natural.'
  };
  if (!shouldDetectLanguage && LANGUAGES[effectiveSourceLang]) request.language = effectiveSourceLang;

  let fileSize = 0;
  try { fileSize = fs.statSync(filePath).size; } catch (_) {}

  let text = await translationService.transcribeAudioFile({
    filePath,
    model: request.model,
    prompt: request.prompt,
    language: request.language
  });

  if (!String(text || '').trim() && fileSize >= WHISPER_EMPTY_RETRY_MIN_BYTES) {
    logger.info(`whisper empty result on ${fileSize}B audio (event ${event.id}, lang ${effectiveSourceLang}) — retrying once`);
    updateTranslationMonitor(event, {
      whisperRetries: Number(event.translationMonitor?.whisperRetries || 0) + 1
    });
    try {
      const retryText = await translationService.transcribeAudioFile({
        filePath,
        model: request.model,
        prompt: request.prompt,
        language: request.language
      });
      if (String(retryText || '').trim()) {
        text = retryText;
      } else {
        logger.warn(`whisper empty after retry on ${fileSize}B audio (event ${event.id}, lang ${effectiveSourceLang}) — chunk dropped`);
        updateTranslationMonitor(event, {
          whisperEmptyDrops: Number(event.translationMonitor?.whisperEmptyDrops || 0) + 1
        });
      }
    } catch (err) {
      logger.warn(`whisper retry failed (event ${event.id}):`, err?.message || err);
    }
  } else if (!String(text || '').trim()) {
    logger.info(`whisper empty result on ${fileSize}B audio (event ${event.id}) — below retry threshold, skipping retry`);
    updateTranslationMonitor(event, {
      whisperEmptyDrops: Number(event.translationMonitor?.whisperEmptyDrops || 0) + 1
    });
  }

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
  const contextEntries = (Array.isArray(event.transcripts) ? event.transcripts : [])
    .filter((entry) => entry && entry.original && entry.sourceLang === sourceLang)
    .slice(-2);

  const entryId = randomUUID();
  const createdAt = new Date().toISOString();
  const accumulatedTranslations = {};
  const lastEmitAt = new Map();
  const PARTIAL_THROTTLE_MS = 120;

  const emitPartialForLang = (lang, partialText) => {
    if (event.displayState?.mode !== 'auto' && event.mode !== 'live') return;
    const now = Date.now();
    const last = lastEmitAt.get(lang) || 0;
    if (now - last < PARTIAL_THROTTLE_MS) return;
    lastEmitAt.set(lang, now);
    io.to(`event:${event.id}`).emit('display_live_entry_partial', {
      entryId,
      sourceLang,
      original: cleanChunk,
      createdAt,
      translations: { [lang]: partialText }
    });
  };

  const emitLangComplete = (lang, finalText) => {
    if (event.displayState?.mode !== 'auto' && event.mode !== 'live') return;
    accumulatedTranslations[lang] = finalText;
    io.to(`event:${event.id}`).emit('display_live_entry_partial', {
      entryId,
      sourceLang,
      original: cleanChunk,
      createdAt,
      translations: { ...accumulatedTranslations }
    });
  };

  const translationPairs = await Promise.all(
    event.targetLangs.map(async (lang) => {
      const translated = await translateText(cleanChunk, lang, event, sourceLang, {
        contextEntries,
        onDelta: (text) => emitPartialForLang(lang, text)
      });
      emitLangComplete(lang, translated);
      return [lang, translated];
    })
  );

  const entry = {
    id: entryId,
    sourceLang,
    original: cleanChunk,
    translations: Object.fromEntries(translationPairs),
    createdAt,
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
  io.to(`event:${event.id}`).emit('transcript_entry', entry);
  // Emit display_live_entry când:
  //  - Main Screen e pe Live (displayState.mode === 'auto') - cazul vechi
  //  - SAU event-ul (canalul participant) e pe live - chiar dacă Main Screen e Song/Black/Pinned
  // Asta permite participants să primească live text chiar când Main Screen afișează altceva
  // (design intenționat: canale paralele independente).
  if (event.displayState?.mode === 'auto' || event.mode === 'live') {
    io.to(`event:${event.id}`).emit('display_live_entry', cloneDisplayEntry(event.latestDisplayEntry));
  }
  saveDb();
  emitUsageStats(event.id);
  emitTranslationMonitor(event.id);
  return entry;
}

async function processText(event, cleanText, { force = false, sourceLang = '' } = {}) {
  // BUGFIX V7: defensive normalize on Azure speech recognition output.
  // Azure SDK usually returns Unicode 3.0+ (modern RO chars), but applying normalize is idempotent
  // and cheap. Protects against any edge case where mixed encoding leaks into the translation pipeline.
  cleanText = normalizeTextInput(cleanText);

  const lockId = String(event.id);   // V22.38 — ID primitiv stabil (igienă, sugestie Codex)
  if (processingLocks.get(lockId)) {
    // V22.38 — re-queue ASINCRON (setImmediate) ca să nu reintre sincron în lanțul de recursie.
    const reqText = cleanText, reqSrc = sourceLang;
    setImmediate(() => queueSpeechText(lockId, reqText, reqSrc));
    return null;
  }
  processingLocks.set(lockId, true);
  try {
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

      const CHUNK_PUBLISH_DELAY_MS = 400;
      let lastCreatedEntry = lastEntry;
      for (const extraChunk of chunks) {
        await new Promise((r) => setTimeout(r, CHUNK_PUBLISH_DELAY_MS));
        const created = await publishNewChunk(event, extraChunk, entrySourceLang);
        if (created) lastCreatedEntry = created;
      }
      return lastCreatedEntry;
    }

    const CHUNK_PUBLISH_DELAY_MS = 400;
    const chunks = splitIntoDisplayChunks(cleanText);
    let lastCreatedEntry = null;
    let isFirstChunk = true;
    for (const chunk of chunks) {
      if (!isFirstChunk) {
        await new Promise((r) => setTimeout(r, CHUNK_PUBLISH_DELAY_MS));
      }
      isFirstChunk = false;
      const created = await publishNewChunk(event, chunk, entrySourceLang);
      if (created) lastCreatedEntry = created;
    }
    return lastCreatedEntry;
  } finally {
    processingLocks.delete(lockId);
  }
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
  const minWords = provider === 'azure_sdk' ? AZURE_LIVE_TEXT_MIN_WORDS : LIVE_TEXT_MIN_WORDS;
  const softWaitMs = provider === 'azure_sdk' ? AZURE_LIVE_TEXT_SOFT_WAIT_MS : LIVE_TEXT_SOFT_WAIT_MS;

  if (!force) {
    if (startsLikeContinuation(text) && words < minWords) {
      buffered.timer = setTimeout(() => flushSpeechBuffer(eventId, true).catch(logger.error), softWaitMs);
      speechBuffers.set(eventId, buffered);
      return null;
    }
    if (BUFFER_CONNECTORS.has(last) && words < minWords) {
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
  // V22.38 — processText ASINCRON (setImmediate) ca să rupem recursia sincronă cu queueSpeechText.
  const flushSrc = buffered.sourceLang || event.sourceLang || 'ro';
  setImmediate(() => {
    Promise.resolve(processText(event, text, { force: true, sourceLang: flushSrc })).catch(logger.error);
  });
  return null;
}

function queueSpeechText(eventId, text, sourceLang = '', provider = getActiveSpeechProvider()) {
  const clean = sanitizeTranscriptText(text);
  if (!clean) return;
  const event = db.events[eventId];
  if (event?.mode === 'song') return;

  // SMART FLUSH V1: dacă noul text începe cu un cuvânt FLUSH_BEFORE,
  // forțăm flush al buffer-ului ANTERIOR ÎNAINTE să adăugăm noul text
  const newTextWords = String(text || '').trim().split(/\s+/);
  const firstNewWord = String(newTextWords[0] || '').toLowerCase().replace(/[^\p{L}]/gu, '');

  if (FLUSH_BEFORE_WORDS.has(firstNewWord)) {
    const existingBuffer = speechBuffers.get(eventId);
    if (existingBuffer && existingBuffer.text && countWords(existingBuffer.text) >= AZURE_LIVE_TEXT_MIN_WORDS) {
      // V22.38 — flush ASINCRON (setImmediate) ca să NU reintre sincron în
      // flushSpeechBuffer→processText→queueSpeechText→flushSpeechBuffer (recursie → stack overflow).
      setImmediate(() => flushSpeechBuffer(eventId, true).catch(logger.error));
    }
  }

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
  if (!session) return Promise.resolve();
  azureSpeechSessions.delete(socketId);
  logger.info('[AZURE-429-DIAG] session closed', { socketId, remaining: azureSpeechSessions.size });   // V22.29
  // TASK 37: Cleanup partial flush tracker pentru acest event
  if (session.eventId) {
    partialFlushTracker.delete(session.eventId);
    wordFlushedEvents.delete(session.eventId);   // AZURE-WORDCOUNT-FLUSH — evită scurgeri de flag între sesiuni
  }
  try { session.pushStream?.close(); } catch (_) {}
  // V22.25 — așteaptă închiderea COMPLETĂ a recognizer-ului (Azure eliberează conexiunea)
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; try { session.recognizer?.close?.(); } catch (_) {} resolve(); };
    try {
      session.recognizer?.stopContinuousRecognitionAsync(finish, finish);
    } catch (_) { finish(); }
    // siguranță: nu bloca la nesfârșit dacă Azure nu răspunde
    setTimeout(finish, 1500);
  });
}

function closeAzureSpeechSessionsForEvent(eventId, exceptSocketId = '') {
  const tasks = [];
  for (const [socketId, session] of azureSpeechSessions.entries()) {
    if (session?.eventId === eventId && socketId !== exceptSocketId) {
      tasks.push(closeAzureSpeechSession(socketId));
    }
  }
  return Promise.all(tasks);
}

async function startAzureSpeechSession(socket, event) {
  // V22.25 — așteaptă închiderea COMPLETĂ a sesiunilor vechi înainte de a deschide una nouă
  await closeAzureSpeechSession(socket.id);
  await closeAzureSpeechSessionsForEvent(event.id, socket.id);
  await new Promise((r) => setTimeout(r, 250));   // răgaz pentru eliberarea conexiunii Azure
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
  // Dezactivez filtrul de profanitate Azure (default Masked înlocuia cu ***).
  // În servicii religioase, *** apare aproape exclusiv ca FALSE POSITIVE -
  // Azure interpretează silabe similare ("curat", "curiozitate") ca profanitate.
  // Setez Raw pentru text fidel; eventualele cuvinte directe (foarte rare)
  // sunt politicizate de OpenAI prin prompt în limbile țintă.
  try {
    speechConfig.setProfanity(sdk.ProfanityOption.Raw);
  } catch (_) { /* property not supported in this SDK version */ }
  // Translation Mode controlează cât de agresiv segmentează Azure între propoziții:
  //  - rapid: 300ms - latență minimă, propoziții scurte (Q&A, conversație rapidă)
  //  - balanced: 500ms - echilibru între latență și context (default, validat empiric)
  //  - clear: 800ms - mai mult context per propoziție, traducere de calitate
  //  - interpret: 700ms - fraze coerente, context bun pentru condensare ca interpret uman
  // Mode-ul se aplică la pornirea sesiunii. Pentru schimbare mid-Live: Stop + Start.
  const segmentationByMode = {
    rapid: '300',
    balanced: '300',  // SMART FLUSH V2: redus de la 500 pentru vorbire continuă rapidă
    clear: '800',
    interpret: '700'   // TRANSLATION-MODE-INTERPRET — fraze coerente, context bun pt condensare
  };
  const segmentationTimeout = segmentationByMode[event.speed] || segmentationByMode.balanced;
  try {
    speechConfig.setProperty(
      sdk.PropertyId.Speech_SegmentationSilenceTimeoutMs || 'Speech_SegmentationSilenceTimeoutMs',
      segmentationTimeout
    );
  } catch (_) { /* property not supported in this SDK version */ }

  const audioFormat = sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
  const pushStream = sdk.AudioInputStream.createPushStream(audioFormat);
  const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
  const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

  // Tracker pentru cât de mult din partial-ul curent a fost deja trimis
  let lastPartialLength = 0;

  recognizer.recognizing = (_, result) => {
    const text = sanitizeTranscriptText(result?.result?.text || '');
    if (!text) return;

    io.to(`event:${event.id}:admins`).emit('partial_transcript', { text });

    // BIBLE MODE: skip translation (recognition continues for transcript verification)
    const currentEvent = db.events[event.id];
    if (currentEvent?.bibleMode) return;

    // TASK 37: Flush proactiv pe partial dacă text e lung
    // Asta e MARE diferență față de comportamentul vechi care aștepta `recognized`
    const words = countWords(text);

    // V22.0 — în smooth mode, sărim partial-flush; comităm doar pe recognized.
    if (!AZURE_SMOOTH_MODE) {
      // SMART FLUSH V2: Trigger la AZURE_PARTIAL_FLUSH_THRESHOLD (8) ȘI nu e duplicat
      if (words >= AZURE_PARTIAL_FLUSH_THRESHOLD) {
        // Verific cu tracker dacă deja am flush-uit text similar
        if (!isPartialFlushDuplicate(event.id, text)) {
          // Calculez delta - doar partea nouă (după ce am flush-uit ultima oară)
          const tracker = partialFlushTracker.get(event.id);
          let deltaText = text;
          if (tracker && tracker.lastFlushedText) {
            // Dacă noul text începe exact cu vechiul, ia doar partea nouă
            const oldLen = tracker.lastFlushedText.length;
            if (text.length > oldLen && text.startsWith(tracker.lastFlushedText)) {
              deltaText = text.slice(oldLen).trim();
            }
          }

          const deltaWords = countWords(deltaText);
          // Trimite delta DOAR dacă are minim 3 cuvinte (nu propoziții fragmentare)
          if (deltaWords >= AZURE_LIVE_TEXT_MIN_WORDS) {
            markPartialFlushed(event.id, text);
            queueSpeechText(event.id, deltaText, effectiveSourceLang, 'azure_sdk');
          }
        }
      }
    }

    // AZURE-WORDCOUNT-FLUSH — în smooth mode, taie acumularea când Azure nu segmentează la timp.
    // Tăiem după DELTĂ (partea nouă față de ce-am trimis ultima dată), FĂRĂ fereastră de timp:
    // așa frazele lungi se taie în bucăți de ~prag cuvinte, fără să re-trimitem ce-am trimis deja.
    // (NU folosim isPartialFlushDuplicate aici: el ștergea tracker-ul pe fereastra de 3s, iar la
    //  fraze lungi nesegmentate asta făcea delta = textul întreg → re-trimitea acumulatul = dublură.)
    if (AZURE_SMOOTH_MODE) {
      const wcThreshold = getWordcountFlushThreshold(currentEvent?.speed || event.speed);
      const tracker = partialFlushTracker.get(event.id);
      let deltaText = text;
      if (tracker && tracker.lastFlushedText && text.startsWith(tracker.lastFlushedText)) {
        deltaText = text.slice(tracker.lastFlushedText.length).trim();
      }
      // flush DOAR dacă partea NOUĂ a atins pragul (nu textul total)
      if (countWords(deltaText) >= wcThreshold) {
        markPartialFlushed(event.id, text);          // reține TOT textul de până acum (persistent în sesiune)
        wordFlushedEvents.add(event.id);              // recognized va face delta finală (anti-dublare)
        queueSpeechText(event.id, deltaText, effectiveSourceLang, 'azure_sdk');
      }
    }
  };
  recognizer.recognized = (_, result) => {
    if (result?.result?.reason !== sdk.ResultReason.RecognizedSpeech) return;
    const text = sanitizeTranscriptText(result?.result?.text || '');
    if (!text) return;

    // BIBLE MODE: skip translation (recognition continues for transcript verification)
    const currentEventBible = db.events[event.id];
    if (currentEventBible?.bibleMode) {
      logger.info('[BIBLE MODE] Skipping translation:', text.slice(0, 60));
      return;
    }

    // V22.5 — în smooth mode, recognized e o propoziție completă → commit curat (fără delta), ca să nu
    // lipim fragmente la fraze cu început similar (bug-ul vechi TASK 37). EXCEPȚIE (AZURE-WORDCOUNT-FLUSH):
    // dacă NOI am tăiat partial-ul la cuvinte pentru acest event (wordFlushedEvents), fraza completă
    // re-conține bucata deja trimisă → facem delta DOAR atunci (apoi curățăm flag-ul), ca să nu dublăm.
    if (AZURE_SMOOTH_MODE) {
      if (wordFlushedEvents.has(event.id)) {
        wordFlushedEvents.delete(event.id);
        const tracker = partialFlushTracker.get(event.id);
        if (tracker && tracker.lastFlushedText && text.length > tracker.lastFlushedText.length && text.startsWith(tracker.lastFlushedText)) {
          const deltaText = text.slice(tracker.lastFlushedText.length).trim();
          const deltaWords = countWords(deltaText);
          if (deltaWords >= AZURE_LIVE_TEXT_MIN_WORDS) {
            markPartialFlushed(event.id, text);
            queueSpeechText(event.id, deltaText, effectiveSourceLang, 'azure_sdk');
          }
          // delta sub prag sau text care nu începe cu ce-am flush-uit → NU re-trimit (evit dublarea)
          return;
        }
        // nu pot calcula delta sigur (textul nu începe cu lastFlushedText) → commit întreg o singură dată
        markPartialFlushed(event.id, text);
        queueSpeechText(event.id, text, effectiveSourceLang, 'azure_sdk');
        return;
      }
      // cazul normal V22.5 — niciun word-flush → commit curat, NEATINS
      queueSpeechText(event.id, text, effectiveSourceLang, 'azure_sdk');
      return;
    }

    // TASK 37: Verific dacă acest text final a fost deja flush-uit prin partial
    if (isPartialFlushDuplicate(event.id, text)) {
      // Dar poate textul final are info ÎN PLUS față de partial
      const tracker = partialFlushTracker.get(event.id);
      if (tracker && text.length > tracker.lastFlushedText.length && text.startsWith(tracker.lastFlushedText)) {
        const deltaText = text.slice(tracker.lastFlushedText.length).trim();
        const deltaWords = countWords(deltaText);
        if (deltaWords >= AZURE_LIVE_TEXT_MIN_WORDS) {
          markPartialFlushed(event.id, text);
          queueSpeechText(event.id, deltaText, effectiveSourceLang, 'azure_sdk');
        }
      }
      // Altfel, e duplicat complet - skip
      return;
    }

    // Text nou (nu duplicat) - flush normal
    markPartialFlushed(event.id, text);
    queueSpeechText(event.id, text, effectiveSourceLang, 'azure_sdk');
  };
  recognizer.canceled = (_, result) => {
    const details = String(result?.errorDetails || result?.reason || 'unknown');
    const classified = classifyAzureSpeechError(details);
    // V22.29 DIAGNOSTIC — detaliu brut + nr sesiuni active la momentul erorii
    logger.error('[AZURE-429-DIAG] canceled', {
      activeSessions: azureSpeechSessions.size,
      sessionSocketIds: Array.from(azureSpeechSessions.keys()),
      eventId: event.id,
      code: classified.code,
      rawErrorDetails: String(result?.errorDetails || ''),
      rawErrorCode: String(result?.errorCode ?? ''),
      rawReason: String(result?.reason ?? ''),
      region: AZURE_SPEECH_REGION,
      locale: getSpeechLocale(effectiveSourceLang)
    });
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
  // V22.29 DIAGNOSTIC
  logger.info('[AZURE-429-DIAG] session opened', { socketId: socket.id, activeSessions: azureSpeechSessions.size });

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

const PUSH_ALLOWED_ROLES = new Set(['participant', 'admin', 'operator', 'remote']);
function normalizePushRole(role) {
  const value = String(role || '').trim().toLowerCase();
  return PUSH_ALLOWED_ROLES.has(value) ? value : 'participant';
}

function storePushSubscription(event, subscription, meta = {}) {
  const safeSubscription = normalizePushSubscription(subscription);
  if (!event || !safeSubscription) return false;
  ensureEventUiState(event);
  const now = new Date().toISOString();
  const entry = {
    ...safeSubscription,
    role: normalizePushRole(meta.role),
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

  const now = Date.now();
  const lastSent = Number(event.lastOnAirPushSentAt || 0);
  if (lastSent && now - lastSent < 60 * 1000) {
    logger.info?.(`on-air push debounced for event ${event.id} (last sent ${Math.round((now - lastSent) / 1000)}s ago)`);
    return;
  }
  event.lastOnAirPushSentAt = now;

  const org = getOrganizationForEvent(event);
  const adminEndpoints = new Set(
    (org?.adminPushSubscriptions || []).map((s) => s?.endpoint).filter(Boolean)
  );
  const subscriptions = (event.pushSubscriptions || []).filter(
    (sub) => normalizePushRole(sub?.role) === 'participant' && sub?.endpoint && !adminEndpoints.has(sub.endpoint)
  );
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
    if (wasOnAir) event.lastOnAirPushSentAt = 0;
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

async function buildSongTranslations(event, blocks, songSourceLang = '', cache = {}) {
  const allTranslations = [];
  const normalizedSourceLang = String(songSourceLang || event.sourceLang || 'ro').trim() || 'ro';
  const cacheUpdates = {};

  for (const block of blocks) {
    const blockHash = hashBlock(block);
    const cached = cache[blockHash] || {};
    const blockTranslations = {};
    const missingLangs = [];

    for (const lang of event.targetLangs) {
      if (typeof cached[lang] === 'string' && cached[lang]) {
        blockTranslations[lang] = cached[lang];
      } else {
        missingLangs.push(lang);
      }
    }

    if (missingLangs.length > 0) {
      const newTranslations = await Promise.all(
        missingLangs.map(async (lang) => [lang, await translateText(block, lang, event, normalizedSourceLang)])
      );
      for (const [lang, text] of newTranslations) {
        blockTranslations[lang] = text;
      }
      cacheUpdates[blockHash] = { ...cached, ...Object.fromEntries(newTranslations) };
    }

    allTranslations.push(blockTranslations);
  }

  return { allTranslations, cacheUpdates };
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
  // SEC-AUDIT-2026-06 A2: timing-safe comparisons for operator PIN/codes.
  if (MAIN_OPERATOR_PIN && safeStringEqual(candidate, MAIN_OPERATOR_PIN)) return true;
  for (const event of Object.values(db.events || {})) {
    const operators = Array.isArray(event.remoteOperators) ? event.remoteOperators : [];
    if (operators.some((operator) => safeStringEqual(String(operator.code || '').trim(), candidate))) {
      return true;
    }
  }
  for (const org of Object.values(db.organizations || {})) {
    const granted = Array.isArray(org?.grantedOperators) ? org.grantedOperators : [];
    if (granted.some((entry) => safeStringEqual(String(entry?.code || '').trim(), candidate))) {
      return true;
    }
  }
  return false;
}

function generateOperatorAccessCode() {
  const length = 12;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const bytes = randomBytes(length);
    let code = '';
    for (let i = 0; i < length; i += 1) {
      code += EVENT_SHORT_ID_ALPHABET[bytes[i] % EVENT_SHORT_ID_ALPHABET.length];
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
  return `OP${Date.now().toString(36).toUpperCase().slice(-10)}`.padStart(length, 'X').slice(0, length);
}

const accessRequestRateLimits = new Map();

// V11.4: Periodic GC for rate-limit Maps (V10 audit MEDIU)
// Shapes confirmed: both Maps store { windowStart: epoch_ms, count: number } keyed by IP.
// TTL 1h is generous over the 10-min rate-limit window — keeps recent entries for
// observability, drops fully-expired ones to bound memory. Sweep runs every 10 min;
// first sweep happens after the first interval (no boot sweep), so Maps populate first.
installRateLimitGC([
  {
    name: 'accessRequestRateLimits',
    map: accessRequestRateLimits,
    ttlMs: 60 * 60 * 1000,
    getLastSeenAt: (v) => v.windowStart || 0,
  },
  {
    name: 'operatorLoginAttempts',
    map: operatorLoginAttempts,
    ttlMs: 60 * 60 * 1000,
    getLastSeenAt: (v) => v.windowStart || 0,
  },
], { intervalMs: 10 * 60 * 1000, logger });

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
    // SEC-AUDIT-2026-06 A1: secret returned only to the requester; required to poll request-status.
    pollToken: randomUUID(),
    name,
    contact,
    requestedAt: new Date().toISOString(),
    status: 'pending'
  };
  org.accessRequests.push(request);
  if (org.accessRequests.length > 200) org.accessRequests = org.accessRequests.slice(-200);
  saveDb();
  sendAdminAccessRequestNotification(org, request).catch((err) => logger.error('admin push error:', err?.message || err));
  // SEC-AUDIT-2026-06 A1: admins only — a global emit handed the request id to every
  // connected client, who could then poll request-status and steal the operator code.
  io.to('admins').emit('access_request_created', { id: request.id });
  res.json({ ok: true, requestId: request.id, pollToken: request.pollToken });
});

app.get('/api/operator/request-status/:id', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, status: 'unknown' });
  const org = ensureOrganization(DEFAULT_ORG_ID);
  const request = (org.accessRequests || []).find((r) => r.id === id);
  if (!request) return res.status(404).json({ ok: false, status: 'unknown' });
  // SEC-AUDIT-2026-06 A1: only the requester (holder of pollToken) may read the status —
  // the granted payload contains the operator code. Legacy requests without a token are
  // not readable; same 404 shape so the response is not an existence oracle.
  const token = String(req.query.token || '').trim();
  if (!request.pollToken || !token || !safeStringEqual(token, request.pollToken)) {
    return res.status(404).json({ ok: false, status: 'unknown' });
  }
  const payload = { ok: true, status: request.status };
  if (request.status === 'granted' && request.operatorCode) {
    payload.operatorCode = request.operatorCode;
    payload.profile = request.profile || null;
    payload.eventId = request.eventId || null;
    payload.eventName = request.eventName || null;
    if (request.eventId) {
      payload.redirectUrl = `/remote?event=${encodeURIComponent(request.eventId)}&code=${encodeURIComponent(request.operatorCode)}`;
    } else {
      payload.redirectUrl = '/operator-dashboard';
    }
  }
  res.json(payload);
});

// WORSHIP-ROLES-1: editable list of worship roles managed by admin in the Operator Roles tab.
// Global (not per-event). WORSHIP-ROLES-1B: roles are now objects {name, code, canLead, canAdmin}.
// `Member` is the implicit base — canLead/canAdmin are extra capabilities. Code used for login (ETAPA 2).
// WORSHIP-ROLES-SYNC — anunță adminii + worship managers/master că db.worshipRoles s-a schimbat.
// Payload-ul conține codurile rolurilor → emis DOAR la cine ar fi putut deja să le vadă
// (admin via /api/admin/worship-roles; worship doar cu canManageRoles via /api/worship/roles).
function broadcastWorshipRolesChanged() {
  const payload = { roles: Array.isArray(db.worshipRoles) ? db.worshipRoles : [] };
  io.sockets.sockets.forEach((s) => {
    if (!s.data) return;
    const isAdmin = s.data.role === 'admin';
    const isWorshipManager = !!s.data.worshipCanManageRoles || !!s.data.worshipMaster;
    if (isAdmin || isWorshipManager) s.emit('worship:roles_changed', payload);
  });
}
app.get('/api/admin/worship-roles', (req, res) => {
  if (!requireAdminApiSession(req, res)) return;
  return res.json({ ok: true, roles: Array.isArray(db.worshipRoles) ? db.worshipRoles : [] });
});
app.post('/api/admin/worship-roles', (req, res) => {
  if (!requireAdminApiSession(req, res)) return;
  const name = String(req.body?.name || '').trim().slice(0, 40);
  const code = String(req.body?.code || '').trim().slice(0, 40);
  const canLead = !!req.body?.canLead;
  const canAdmin = !!req.body?.canAdmin;
  const canManageRoles = !!req.body?.canManageRoles;   // WORSHIP-MANAGE-ROLES
  const emoji = String(req.body?.emoji || '').trim().slice(0, 8);
  if (!name) return res.status(400).json({ ok: false, error: 'Nume rol gol.' });
  if (!Array.isArray(db.worshipRoles)) db.worshipRoles = [];
  // Cod unic (dacă e dat) — două roluri nu pot folosi același cod, indiferent de nume.
  if (code && db.worshipRoles.some((r) => r.code && r.code === code && r.name.toLowerCase() !== name.toLowerCase())) {
    return res.status(409).json({ ok: false, error: 'Cod deja folosit de alt rol.' });
  }
  const role = { name, code, canLead, canAdmin, canManageRoles, emoji };
  const idx = db.worshipRoles.findIndex((r) => r.name.toLowerCase() === name.toLowerCase());
  if (idx >= 0) db.worshipRoles[idx] = role;   // editare dacă numele există
  else db.worshipRoles.push(role);             // altfel creare
  saveDb();
  broadcastWorshipRolesChanged();   // WORSHIP-ROLES-SYNC
  return res.json({ ok: true, roles: db.worshipRoles });
});
app.delete('/api/admin/worship-roles', (req, res) => {
  if (!requireAdminApiSession(req, res)) return;
  const name = String(req.body?.name || '').trim();
  if (!Array.isArray(db.worshipRoles)) db.worshipRoles = [];
  db.worshipRoles = db.worshipRoles.filter((r) => r.name !== name);
  saveDb();
  broadcastWorshipRolesChanged();   // WORSHIP-ROLES-SYNC
  return res.json({ ok: true, roles: db.worshipRoles });
});

// WORSHIP-MANAGE-ROLES — endpoint-uri worship-facing pentru gestionarea rolurilor.
// Gate server-side: sesiune worship validă + rolul CURENT (din db.worshipRoles) are canManageRoles.
// Verificarea pe rolul CURENT (nu sesiunea de la login) face ca revocarea capabilității să aibă efect imediat.
function requireWorshipManageSession(req, res) {
  const session = requireWorshipApiSession(req, res);
  if (!session) return null;
  // WORSHIP-PIN-MASTER — maestru (PIN global) trece peste verificarea db.worshipRoles.
  if (session.worshipMaster) return session;
  const roleName = session.worshipRole || '';
  if (!roleName) {
    res.status(403).json({ ok: false, error: 'Necesită rol cu gestionare roluri.' });
    return null;
  }
  const roleObj = (Array.isArray(db.worshipRoles) ? db.worshipRoles : []).find((r) => r.name === roleName);
  if (!roleObj || !roleObj.canManageRoles) {
    res.status(403).json({ ok: false, error: 'Rolul tău nu poate gestiona roluri.' });
    return null;
  }
  return session;
}
app.get('/api/worship/roles', (req, res) => {
  if (!requireWorshipManageSession(req, res)) return;
  return res.json({ ok: true, roles: Array.isArray(db.worshipRoles) ? db.worshipRoles : [] });
});
app.post('/api/worship/roles', (req, res) => {
  if (!requireWorshipManageSession(req, res)) return;
  const name = String(req.body?.name || '').trim().slice(0, 40);
  const code = String(req.body?.code || '').trim().slice(0, 40);
  const canLead = !!req.body?.canLead;
  const canAdmin = !!req.body?.canAdmin;
  const canManageRoles = !!req.body?.canManageRoles;
  const emoji = String(req.body?.emoji || '').trim().slice(0, 8);
  if (!name) return res.status(400).json({ ok: false, error: 'Nume rol gol.' });
  if (!Array.isArray(db.worshipRoles)) db.worshipRoles = [];
  if (code && db.worshipRoles.some((r) => r.code && r.code === code && r.name.toLowerCase() !== name.toLowerCase())) {
    return res.status(409).json({ ok: false, error: 'Cod deja folosit de alt rol.' });
  }
  const role = { name, code, canLead, canAdmin, canManageRoles, emoji };
  const idx = db.worshipRoles.findIndex((r) => r.name.toLowerCase() === name.toLowerCase());
  if (idx >= 0) db.worshipRoles[idx] = role;
  else db.worshipRoles.push(role);
  saveDb();
  broadcastWorshipRolesChanged();   // WORSHIP-ROLES-SYNC
  return res.json({ ok: true, roles: db.worshipRoles });
});
app.delete('/api/worship/roles', (req, res) => {
  if (!requireWorshipManageSession(req, res)) return;
  const name = String(req.body?.name || '').trim();
  if (!Array.isArray(db.worshipRoles)) db.worshipRoles = [];
  db.worshipRoles = db.worshipRoles.filter((r) => r.name !== name);
  saveDb();
  broadcastWorshipRolesChanged();   // WORSHIP-ROLES-SYNC
  return res.json({ ok: true, roles: db.worshipRoles });
});

// WORSHIP-MSG-PER-ROLE — endpoint worship-facing pentru mesaj țintit pe rol (sau toți).
// Auth: requireWorshipManageSession (canManageRoles sau PIN-master) — adică cine
// gestionează echipa poate și să-i scrie. Logica de emit e IDENTICĂ cu endpoint-ul
// admin /api/events/:id/worship/role-message — filtrare pe socket.data.worshipRole
// în camera worship:<eventId>.
app.post('/api/worship/role-message', (req, res) => {
  const session = requireWorshipManageSession(req, res);
  if (!session) return;
  const eventId = String(req.body?.eventId || '').trim();
  const event = db.events[eventId];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  const role = String(req.body?.role || '').trim();
  const text = String(req.body?.text || '').trim().slice(0, 200);
  if (!text) return res.status(400).json({ ok: false, error: 'Mesaj gol.' });
  const room = io.sockets.adapter.rooms.get(`worship:${eventId}`);
  const hint = { type: 'admin_msg', text, eventId, ts: Date.now(), role: role || '__all__' };
  let delivered = 0;
  if (room) {
    room.forEach((socketId) => {
      const s = io.sockets.sockets.get(socketId);
      if (!s) return;
      const sRole = s.data?.worshipRole || '';
      if (!role || role === '__all__' || sRole === role) {
        s.emit('worship:hint', hint);
        delivered++;
      }
    });
  }
  logger.info('[worship/role-message worship-side] event=' + eventId + ' role=' + (role || '__all__') + ' delivered=' + delivered);
  return res.json({ ok: true, delivered });
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
        scheduledTimestamp: ts,
        isActive,
        status
      };
    })
    .sort((a, b) => {
      const order = { active: 0, scheduled: 1, unscheduled: 2, past: 3 };
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
      const at = a.scheduledTimestamp || 0;
      const bt = b.scheduledTimestamp || 0;
      return at - bt;
    });
  res.json({ ok: true, requests, granted, profiles, events });
});

app.post('/api/admin/access-requests/:id/grant', (req, res) => {
  if (!hasValidAdminSession(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const org = ensureOrganization(DEFAULT_ORG_ID);
  const request = (org.accessRequests || []).find((r) => r.id === req.params.id);
  if (!request) return res.status(404).json({ ok: false, error: 'Request not found.' });
  if (request.status !== 'pending') return res.status(400).json({ ok: false, error: `Request already ${request.status}.` });
  const profile = normalizeRemoteOperatorProfile(req.body?.profile);
  const requestedEventId = String(req.body?.eventId || '').trim();
  let assignedEvent = null;
  if (requestedEventId) {
    assignedEvent = findEventByIdOrShortId(requestedEventId);
    if (!assignedEvent || getEventOrgId(assignedEvent) !== DEFAULT_ORG_ID) {
      return res.status(400).json({ ok: false, error: 'Selected event not found.' });
    }
  }
  const code = generateOperatorAccessCode();
  request.status = 'granted';
  request.operatorCode = code;
  request.profile = profile;
  request.eventId = assignedEvent ? assignedEvent.id : null;
  request.eventName = assignedEvent ? assignedEvent.name : null;
  request.grantedAt = new Date().toISOString();
  if (!Array.isArray(org.grantedOperators)) org.grantedOperators = [];
  org.grantedOperators.push({
    id: randomUUID(),
    name: request.name,
    contact: request.contact || '',
    code,
    profile,
    eventId: request.eventId,
    eventName: request.eventName,
    grantedAt: request.grantedAt,
    requestId: request.id
  });
  recordAudit(DEFAULT_ORG_ID, 'access_granted', {
    name: request.name,
    profile,
    eventId: request.eventId || null,
    eventName: request.eventName || null
  });
  saveDb();
  res.json({
    ok: true,
    code,
    profile,
    eventId: request.eventId,
    eventName: request.eventName,
    request
  });
});

app.post('/api/admin/access-requests/:id/deny', (req, res) => {
  if (!hasValidAdminSession(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const org = ensureOrganization(DEFAULT_ORG_ID);
  const request = (org.accessRequests || []).find((r) => r.id === req.params.id);
  if (!request) return res.status(404).json({ ok: false, error: 'Request not found.' });
  if (request.status !== 'pending') return res.status(400).json({ ok: false, error: `Request already ${request.status}.` });
  request.status = 'denied';
  request.deniedAt = new Date().toISOString();
  recordAudit(DEFAULT_ORG_ID, 'access_denied', { name: request.name });
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

async function runSelfTestChecks() {
  const checks = [];
  const orgId = DEFAULT_ORG_ID;

  // 1. DB readable
  try {
    const eventsCount = Object.keys(db.events || {}).length;
    checks.push({ name: 'Database', status: 'ok', message: `Loaded ${eventsCount} event(s).` });
  } catch (err) {
    checks.push({ name: 'Database', status: 'fail', message: err?.message || 'DB read failed.' });
  }

  // 2. Active event
  const activeId = getActiveEventIdForOrg(orgId);
  if (activeId && db.events[activeId]) {
    const ev = db.events[activeId];
    checks.push({ name: 'Active event', status: 'ok', message: `${ev.name || 'Event'} (${ev.shortId || ev.id})` });
  } else {
    checks.push({ name: 'Active event', status: 'warn', message: 'No event is currently set as live.' });
  }

  // 3. Connected sockets (rough: count of io clients)
  try {
    const socketsCount = io.sockets.sockets ? io.sockets.sockets.size : 0;
    checks.push({ name: 'Socket.IO', status: 'ok', message: `${socketsCount} connected client(s).` });
  } catch (err) {
    checks.push({ name: 'Socket.IO', status: 'warn', message: 'Could not read socket count.' });
  }

  // 4. Disk space
  try {
    const disk = dbStore.getDiskInfo();
    if (!disk || disk.freeBytes == null) {
      checks.push({ name: 'Disk space', status: 'warn', message: 'Disk info unavailable on this platform.' });
    } else {
      const freeMb = Math.round(disk.freeBytes / (1024 * 1024));
      const totalMb = Math.round(disk.totalBytes / (1024 * 1024));
      const status = freeMb < 200 ? 'fail' : freeMb < 1000 ? 'warn' : 'ok';
      checks.push({ name: 'Disk space', status, message: `${freeMb} MB free of ${totalMb} MB.` });
    }
  } catch (err) {
    checks.push({ name: 'Disk space', status: 'warn', message: err?.message || 'Disk check failed.' });
  }

  // 5. Backup freshness
  try {
    const dataDir = dbStore.dataDir;
    if (dataDir && fs.existsSync(dataDir)) {
      const files = fs.readdirSync(dataDir).filter((f) => /^sessions\.backup-\d{4}-\d{2}-\d{2}\.json$/.test(f));
      if (!files.length) {
        checks.push({ name: 'Backup', status: 'warn', message: 'No daily backup found yet.' });
      } else {
        files.sort();
        const latest = files[files.length - 1];
        const stat = fs.statSync(path.join(dataDir, latest));
        const ageHours = Math.round((Date.now() - stat.mtimeMs) / (1000 * 60 * 60));
        const status = ageHours > 48 ? 'warn' : 'ok';
        checks.push({ name: 'Backup', status, message: `Latest: ${latest} (${ageHours}h ago).` });
      }
    } else {
      checks.push({ name: 'Backup', status: 'warn', message: 'Data directory not yet created.' });
    }
  } catch (err) {
    checks.push({ name: 'Backup', status: 'warn', message: err?.message || 'Backup check failed.' });
  }

  // 6. OpenAI configured + reachable
  if (!OPENAI_API_KEY) {
    checks.push({ name: 'OpenAI', status: 'fail', message: 'OPENAI_API_KEY is not configured.' });
  } else {
    try {
      let selfTestTimeoutHandle;   // V22.37 — clearTimeout ca timeout-ul să nu respingă neprins după ce race-ul s-a decis
      const text = await Promise.race([
        translationService.translateWithResponses({
          model: OPENAI_MODEL,
          input: [
            { role: 'system', content: 'Translate from English to Romanian. Output only the translation, nothing else.' },
            { role: 'user', content: 'Hello' }
          ]
        }),
        new Promise((_, reject) => { selfTestTimeoutHandle = setTimeout(() => reject(new Error('Timed out after 8s')), 8000); })
      ]).finally(() => clearTimeout(selfTestTimeoutHandle));
      const trimmed = String(text || '').trim();
      if (trimmed) {
        checks.push({ name: 'OpenAI translate', status: 'ok', message: `Replied: "${trimmed.slice(0, 60)}".` });
      } else {
        checks.push({ name: 'OpenAI translate', status: 'warn', message: 'API responded but with empty text.' });
      }
    } catch (err) {
      checks.push({ name: 'OpenAI translate', status: 'fail', message: err?.message || 'API call failed.' });
    }
  }

  // 7. Azure speech configured
  if (SPEECH_PROVIDER === 'azure' || SPEECH_PROVIDER === 'azure_sdk') {
    if (AZURE_SPEECH_KEY && AZURE_SPEECH_REGION) {
      checks.push({ name: 'Azure Speech', status: 'ok', message: `Configured (region: ${AZURE_SPEECH_REGION}).` });
    } else {
      checks.push({ name: 'Azure Speech', status: 'fail', message: 'SPEECH_PROVIDER=azure but key or region missing.' });
    }
  } else {
    checks.push({ name: 'Azure Speech', status: 'ok', message: 'Not selected (using OpenAI for STT).' });
  }

  // 8. Web Push
  if (WEB_PUSH_ENABLED) {
    checks.push({ name: 'Web Push', status: 'ok', message: 'VAPID keys configured.' });
  } else {
    checks.push({ name: 'Web Push', status: 'warn', message: 'WEB_PUSH_PUBLIC_KEY / PRIVATE_KEY not set.' });
  }

  // 9. Admin auth configured
  if (isAdminLoginConfigured()) {
    checks.push({ name: 'Admin login', status: 'ok', message: 'MASTER_ADMIN_PIN configured.' });
  } else {
    checks.push({ name: 'Admin login', status: COMMERCIAL_MODE ? 'fail' : 'warn', message: 'MASTER_ADMIN_PIN missing.' });
  }

  // 10. Operator login configured
  if (MAIN_OPERATOR_PIN) {
    checks.push({ name: 'Operator PIN', status: 'ok', message: 'MAIN_OPERATOR_PIN configured.' });
  } else {
    checks.push({ name: 'Operator PIN', status: 'warn', message: 'MAIN_OPERATOR_PIN not set; only granted codes work.' });
  }

  // 11. Transcribe latency (samples from real traffic)
  if (transcribeLatencyBuffer.length === 0) {
    checks.push({ name: 'Transcribe latency', status: 'warn', message: 'No samples yet — start a live recognition session to measure.' });
  } else {
    const sorted = [...transcribeLatencyBuffer].sort((a, b) => a - b);
    const avg = Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    const max = sorted[sorted.length - 1];
    const status = avg > 4000 ? 'fail' : avg > 2000 ? 'warn' : 'ok';
    checks.push({
      name: 'Transcribe latency',
      status,
      message: `${sorted.length} samples · avg ${avg}ms · p95 ${p95}ms · max ${max}ms`
    });
  }

  return checks;
}

app.get('/api/admin/self-test', async (req, res) => {
  if (!hasValidAdminSession(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  try {
    const checks = await runSelfTestChecks();
    const summary = {
      ok: checks.filter((c) => c.status === 'ok').length,
      warn: checks.filter((c) => c.status === 'warn').length,
      fail: checks.filter((c) => c.status === 'fail').length
    };
    res.json({ ok: true, checks, summary, ranAt: new Date().toISOString() });
  } catch (err) {
    logger.error('self-test error:', err?.message || err);
    res.status(500).json({ ok: false, error: 'Self-test failed.' });
  }
});

app.post('/api/events/:id/email-summary', async (req, res) => {
  if (!hasValidAdminSession(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Event not found.' });
  if (!SUMMARY_WEBHOOK_URL) return res.status(503).json({ ok: false, error: 'SUMMARY_WEBHOOK_URL is not configured.' });
  const stats = event.usageStats || {};
  const baseUrl = buildBaseUrl(req);
  const transcriptUrl = `${baseUrl}/api/events/${event.id}/transcript-export`;
  const payload = {
    type: 'service_summary',
    sentAt: new Date().toISOString(),
    recipient: SUMMARY_RECIPIENT || null,
    event: {
      id: event.id,
      shortId: event.shortId || null,
      name: event.name || 'Event',
      scheduledAt: event.scheduledAt || null,
      sourceLang: event.sourceLang || 'ro',
      targetLangs: Array.isArray(event.targetLangs) ? event.targetLangs : []
    },
    stats: {
      transcripts: Array.isArray(event.transcripts) ? event.transcripts.length : 0,
      uniqueParticipants: Number(stats.uniqueParticipantsEver) || 0,
      audioSeconds: Number(stats.audioSeconds) || 0,
      audioHours: Math.round(((Number(stats.audioSeconds) || 0) / 3600) * 100) / 100,
      tokensTranslation: Number(stats.tokensTranslation) || 0,
      estimatedCostUSD: Number(stats.estimatedCostUSD) || 0
    },
    transcriptUrl
  };
  try {
    const response = await fetch(SUMMARY_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      logger.warn('email summary webhook returned non-2xx:', response.status, text.slice(0, 200));
      return res.status(502).json({ ok: false, error: `Webhook responded ${response.status}.` });
    }
    recordAudit(getEventOrgId(event), 'summary_sent', { eventId: event.id, name: event.name, recipient: SUMMARY_RECIPIENT || null });
    saveDb();
    res.json({ ok: true });
  } catch (err) {
    logger.error('email summary error:', err?.message || err);
    res.status(500).json({ ok: false, error: 'Could not deliver summary.' });
  }
});

app.get('/api/admin/audit-log', (req, res) => {
  if (!hasValidAdminSession(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const org = ensureOrganization(DEFAULT_ORG_ID);
  const log = Array.isArray(org.auditLog) ? org.auditLog : [];
  const limit = Math.max(1, Math.min(500, Number(req.query?.limit) || 100));
  const entries = [...log].slice(-limit).reverse();
  res.json({ ok: true, entries });
});

// V16: Import a song from an external URL (resursecrestine.ro Opensong XML)
app.post('/api/songs/import-url', async (req, res) => {
  if (!requireAdminOrOperatorApiSession(req, res)) return;
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ ok: false, error: 'Missing url in request body' });
  }
  try {
    const imported = await importFromUrl(url.trim());
    logger.info(`[import-url] Imported from ${imported.sourceProvider}: "${imported.title}"`);
    return res.json({ ok: true, song: imported });
  } catch (err) {
    logger.warn(`[import-url] Failed: ${err.message}`);
    return res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/songs/search', async (req, res) => {
  if (!requireAdminOrOperatorApiSession(req, res)) return;
  const { query } = req.body || {};
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ ok: false, error: 'Missing query in request body' });
  }
  try {
    const results = await searchResurseCrestineSongs(query.trim());
    logger.info(`[songs/search] query="${query.trim()}" -> ${results.length} results`);
    return res.json({ ok: true, query: query.trim(), results });
  } catch (err) {
    logger.warn(`[songs/search] Failed: ${err.message}`);
    return res.status(400).json({ ok: false, error: err.message });
  }
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

// BUGFIX V5 Layer 4: scan + auto-clean translations the OpenAI model wrote in the wrong language.
// Auth: header `x-main-operator-code` matching globalAccess.mainOperatorCode (same surface as
// operator login). Backs up sessions.json + translation-cache.json BEFORE mutations to
// /var/data/audit-backup-<timestamp>.json. Auto-clean is enabled per task spec; only removes
// high-confidence mismatches (detector returns 'high' AND detected !== expected).
// Returns a JSON report with sample mismatches (capped at 20 per category) for inspection.
app.post('/admin/audit-translations', (req, res) => {
  const supplied = String(req.headers['x-main-operator-code'] || '').trim();
  const orgAccess = getOrganizationAccess(DEFAULT_ORG_ID);
  const expected = String(orgAccess?.mainOperatorCode || '').trim();
  if (!expected || !safeStringEqual(supplied, expected)) {
    return res.status(401).json({ ok: false, error: 'Invalid x-main-operator-code header.' });
  }

  const tsLabel = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(DATA_DIR, `audit-backup-${tsLabel}.json`);
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const backup = {
      ts: new Date().toISOString(),
      sessions: fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : null,
      translationCache: Array.from(translationCache.entries())
    };
    // SEC-AUDIT-2026-06 C1: atomic write so a crash can't truncate the audit backup.
    atomicWriteFileSync(backupPath, JSON.stringify(backup));
  } catch (err) {
    return res.status(500).json({ ok: false, error: `Backup failed: ${err?.message || err}`, backupPath });
  }

  // 1. Global translation cache: key format `srcLang::tgtLang::speed::glossarySig::context::sourceText`
  const cacheReport = { scanned: 0, suspects: 0, removed: 0, mismatches: [] };
  for (const [key, value] of Array.from(translationCache.entries())) {
    cacheReport.scanned += 1;
    const parts = String(key).split('::');
    const tgtLang = parts[1];
    if (!tgtLang || !LANGUAGES[tgtLang]) continue;
    const detected = detectLanguage(value);
    if (detected.lang !== 'unknown' && detected.lang !== tgtLang && detected.confidence === 'high') {
      cacheReport.suspects += 1;
      if (cacheReport.mismatches.length < 20) {
        cacheReport.mismatches.push({
          expectedLang: tgtLang,
          detectedLang: detected.lang,
          keyPreview: key.slice(0, 120),
          valuePreview: String(value).slice(0, 120)
        });
      }
      translationCache.delete(key);
      cacheReport.removed += 1;
    }
  }
  if (cacheReport.removed > 0) {
    translationCacheDirty = true;
    flushPersistentTranslationCache();
  }

  // 2. Per-song library translationsByHash across all orgs
  const libReport = { scanned: 0, suspects: 0, removed: 0, mismatches: [] };
  for (const orgId of Object.keys(db.organizations || {})) {
    const org = db.organizations[orgId];
    const library = Array.isArray(org?.globalSongLibrary) ? org.globalSongLibrary : [];
    for (const song of library) {
      const hashCache = song?.translationsByHash;
      if (!hashCache || typeof hashCache !== 'object') continue;
      for (const blockHash of Object.keys(hashCache)) {
        const blockTranslations = hashCache[blockHash];
        if (!blockTranslations || typeof blockTranslations !== 'object') continue;
        for (const tgtLang of Object.keys(blockTranslations)) {
          if (!LANGUAGES[tgtLang]) continue;
          const value = blockTranslations[tgtLang];
          if (typeof value !== 'string' || !value) continue;
          libReport.scanned += 1;
          const detected = detectLanguage(value);
          if (detected.lang !== 'unknown' && detected.lang !== tgtLang && detected.confidence === 'high') {
            libReport.suspects += 1;
            if (libReport.mismatches.length < 20) {
              libReport.mismatches.push({
                orgId,
                songTitle: song?.title || '(untitled)',
                expectedLang: tgtLang,
                detectedLang: detected.lang,
                valuePreview: String(value).slice(0, 120)
              });
            }
            delete blockTranslations[tgtLang];
            libReport.removed += 1;
          }
        }
      }
    }
  }
  if (libReport.removed > 0) {
    saveDb();
  }

  logger.info(`audit-translations: cache scanned=${cacheReport.scanned} removed=${cacheReport.removed} | library scanned=${libReport.scanned} removed=${libReport.removed} | backup=${backupPath}`);

  res.json({
    ok: true,
    backupPath,
    cacheGlobal: {
      scanned: cacheReport.scanned,
      suspects: cacheReport.suspects,
      removed: cacheReport.removed,
      sample: cacheReport.mismatches
    },
    libraryByHash: {
      scanned: libReport.scanned,
      suspects: libReport.suspects,
      removed: libReport.removed,
      sample: libReport.mismatches
    }
  });
});

// BUGFIX V7: manual re-trigger of normalize migration. Already runs at startup; this is for
// re-running after content imports or for verifying. Same auth pattern as audit-translations.
// Idempotent — items already marked _normalizedAt are skipped.
app.post('/admin/normalize-content', (req, res) => {
  const supplied = String(req.headers['x-main-operator-code'] || '').trim();
  const orgAccess = getOrganizationAccess(DEFAULT_ORG_ID);
  const expected = String(orgAccess?.mainOperatorCode || '').trim();
  if (!expected || !safeStringEqual(supplied, expected)) {
    return res.status(401).json({ ok: false, error: 'Invalid x-main-operator-code header.' });
  }
  try {
    const stats = migrateNormalizeContent({ skipBackup: false });
    res.json({ ok: true, ...stats });
  } catch (err) {
    logger.error('normalize-content endpoint error:', err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

const OPERATOR_SESSION_COOKIE = 'sv_operator_session';
const OPERATOR_SESSION_MAX_AGE_MS = Math.max(1, Number(process.env.OPERATOR_SESSION_MAX_AGE_HOURS || 4) || 4) * 60 * 60 * 1000;

function signOperatorSession(payload) {
  const body = base64urlEncode(JSON.stringify(payload));
  const signature = createHmac('sha256', ADMIN_SESSION_SECRET).update(`op:${body}`).digest('base64url');
  return `${body}.${signature}`;
}

function verifyOperatorSession(token) {
  const rawToken = String(token || '');
  const [body, signature] = rawToken.split('.');
  if (!body || !signature) return null;
  const expectedSignature = createHmac('sha256', ADMIN_SESSION_SECRET).update(`op:${body}`).digest('base64url');
  if (!safeStringEqual(signature, expectedSignature)) return null;
  try {
    const session = JSON.parse(base64urlDecode(body));
    if (session.role !== 'operator') return null;
    if (!session.code || typeof session.code !== 'string') return null;
    if (session.exp && Number(session.exp) < Date.now()) return null;
    return session;
  } catch (err) {
    return null;
  }
}

function buildOperatorSessionCookie(req, value, maxAgeMs = null) {
  const parts = [
    `${OPERATOR_SESSION_COOKIE}=${encodeURIComponent(value)}`,
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

function setOperatorSessionCookie(req, res, operatorCode) {
  const now = Date.now();
  const token = signOperatorSession({
    role: 'operator',
    code: String(operatorCode || ''),
    iat: now,
    exp: now + OPERATOR_SESSION_MAX_AGE_MS
  });
  res.setHeader('Set-Cookie', buildOperatorSessionCookie(req, token, OPERATOR_SESSION_MAX_AGE_MS));
}

function clearOperatorSessionCookie(req, res) {
  res.setHeader('Set-Cookie', buildOperatorSessionCookie(req, '', 0));
}

function getOperatorCodeFromCookie(req) {
  const cookies = parseCookies(req);
  const session = verifyOperatorSession(cookies[OPERATOR_SESSION_COOKIE]);
  if (!session) return '';
  const code = String(session.code || '').trim();
  if (!code || !isOperatorPinValid(code)) return '';
  return code;
}

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
  setOperatorSessionCookie(req, res, pin);
  return res.json({ ok: true, operatorCode: pin });
});

app.post('/api/operator-logout', (req, res) => {
  clearOperatorSessionCookie(req, res);
  return res.json({ ok: true });
});

// === V20.1: Worship role ===
// Lets the worship team log in with WORSHIP_PIN and add church-library songs to
// upcoming events from a rehearsal device. Session is a separate signed cookie
// (HMAC over ADMIN_SESSION_SECRET, namespaced `ws:`) carrying the itemIds added
// in the current session — worship may delete only those.
const WORSHIP_SESSION_COOKIE = 'sv_worship_session';
const WORSHIP_SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8h — a rehearsal length

function signWorshipSession(payload) {
  const body = base64urlEncode(JSON.stringify(payload));
  const signature = createHmac('sha256', ADMIN_SESSION_SECRET).update(`ws:${body}`).digest('base64url');
  return `${body}.${signature}`;
}

function verifyWorshipSession(token) {
  const rawToken = String(token || '');
  const [body, signature] = rawToken.split('.');
  if (!body || !signature) return null;
  const expectedSignature = createHmac('sha256', ADMIN_SESSION_SECRET).update(`ws:${body}`).digest('base64url');
  if (!safeStringEqual(signature, expectedSignature)) return null;
  try {
    const session = JSON.parse(base64urlDecode(body));
    if (session.role !== 'worship') return null;
    if (session.exp && Number(session.exp) < Date.now()) return null;
    if (!Array.isArray(session.addedSongs)) session.addedSongs = [];
    return session;
  } catch (err) {
    return null;
  }
}

function buildWorshipSessionCookie(req, value, maxAgeMs = null) {
  const parts = [
    `${WORSHIP_SESSION_COOKIE}=${encodeURIComponent(value)}`,
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

function setWorshipSessionCookie(req, res, session) {
  res.setHeader('Set-Cookie', buildWorshipSessionCookie(req, signWorshipSession(session), WORSHIP_SESSION_MAX_AGE_MS));
}

function clearWorshipSessionCookie(req, res) {
  res.setHeader('Set-Cookie', buildWorshipSessionCookie(req, '', 0));
}

// Pure check — returns the verified worship session or null, no response/side effects.
function tryWorshipSession(req) {
  if (!WORSHIP_PIN) return null;
  const cookies = parseCookies(req);
  return verifyWorshipSession(cookies[WORSHIP_SESSION_COOKIE]) || null;
}

// Returns the verified worship session, or null after sending an error response.
function requireWorshipApiSession(req, res) {
  if (!WORSHIP_PIN) {
    res.status(503).json({ ok: false, error: 'Worship role not configured on this server.' });
    return null;
  }
  const session = tryWorshipSession(req);
  if (!session) {
    res.status(401).json({ ok: false, error: 'Worship login required.' });
    return null;
  }
  return session;
}

// V21.3: verify a worship session from a Socket.IO handshake cookie (the
// worship master opens a socket for presence + operator-push notifications).
function getWorshipSessionFromSocket(socket) {
  try {
    const cookies = parseCookies({ headers: { cookie: socket?.handshake?.headers?.cookie || '' } });
    return verifyWorshipSession(cookies[WORSHIP_SESSION_COOKIE]) || null;
  } catch (err) {
    return null;
  }
}

// === V21.18: Worship View permanent link — read-only auth via WORSHIP_PIN ===
// Separate from the master `ws:` session (which can mutate setlist/state).
// The view cookie (`wv:` namespace, role `worship_view`) is HMAC-signed but
// grants ZERO control rights — no API endpoint or socket handler accepts a
// `worship_view` session in place of an admin/operator/worship session. It
// only unlocks `/api/worship-view/live` (read) and the
// `worship:view:join_permanent` socket subscription.
const WORSHIP_VIEW_SESSION_COOKIE = 'sv_worship_view';
const WORSHIP_VIEW_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — install + forget

function signWorshipViewSession(payload) {
  const body = base64urlEncode(JSON.stringify(payload));
  const signature = createHmac('sha256', ADMIN_SESSION_SECRET).update(`wv:${body}`).digest('base64url');
  return `${body}.${signature}`;
}

function verifyWorshipViewSession(token) {
  const rawToken = String(token || '');
  const [body, signature] = rawToken.split('.');
  if (!body || !signature) return null;
  const expectedSignature = createHmac('sha256', ADMIN_SESSION_SECRET).update(`wv:${body}`).digest('base64url');
  if (!safeStringEqual(signature, expectedSignature)) return null;
  try {
    const session = JSON.parse(base64urlDecode(body));
    if (session.role !== 'worship_view') return null;
    if (session.exp && Number(session.exp) < Date.now()) return null;
    return session;
  } catch (err) {
    return null;
  }
}

function buildWorshipViewSessionCookie(req, value, maxAgeMs = null) {
  const parts = [
    `${WORSHIP_VIEW_SESSION_COOKIE}=${encodeURIComponent(value)}`,
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

function setWorshipViewSessionCookie(req, res, session) {
  res.setHeader('Set-Cookie', buildWorshipViewSessionCookie(req, signWorshipViewSession(session), WORSHIP_VIEW_MAX_AGE_MS));
}

function clearWorshipViewSessionCookie(req, res) {
  res.setHeader('Set-Cookie', buildWorshipViewSessionCookie(req, '', 0));
}

function tryWorshipViewSession(req) {
  if (!WORSHIP_PIN) return null;
  const cookies = parseCookies(req);
  return verifyWorshipViewSession(cookies[WORSHIP_VIEW_SESSION_COOKIE]) || null;
}

function getWorshipViewSessionFromSocket(socket) {
  try {
    const cookies = parseCookies({ headers: { cookie: socket?.handshake?.headers?.cookie || '' } });
    return verifyWorshipViewSession(cookies[WORSHIP_VIEW_SESSION_COOKIE]) || null;
  } catch (err) {
    return null;
  }
}

// Returns the currently active event of DEFAULT_ORG with worship slots ensured,
// or null if no event is live. Used by the permanent-link view to decide
// between "show lyrics" and the "waiting" screen.
function getActiveWorshipEventForView() {
  const activeId = getActiveEventIdForOrg(DEFAULT_ORG_ID);
  if (!activeId) return null;
  const event = db.events[activeId];
  if (!event || event.hidden) return null;
  ensureWorshipState(event);
  return event;
}

// Push fresh state to permanent-link viewers. Call after the active event
// changes OR after the active event's worship state changes.
function broadcastPermanentWorshipView() {
  const event = getActiveWorshipEventForView();
  if (event) {
    io.to('worship-view:permanent').emit('worship:view:live', buildWorshipStatePayload(event));
  } else {
    io.to('worship-view:permanent').emit('worship:view:offline');
  }
}

// WORSHIP-EDIT-ANY-EVENT — worship poate edita setlist în ORICE eveniment al org-ului
// (viitor + activ + trecut). Restricția de timp a fost eliminată la cererea owner-ului;
// testat în practică: adăugarea în evenimentul activ nu produce modificări vizuale bruște.
// Gardurile hidden + org rămân (nu expunem evenimente ascunse sau din alte org-uri).
function isWorshipEditableEvent(event) {
  if (!event || event.hidden) return false;
  if (getEventOrgId(event) !== DEFAULT_ORG_ID) return false;
  return true;
}

// V21.1: Worship Live Tablet may also control the currently-active event, not
// just upcoming ones — setlist editing now applies to ANY event in the org
// (isWorshipEditableEvent above), so isWorshipAccessibleEvent reduces to it
// + the active-event branch (păstrat pentru continuitate logică).
function isWorshipAccessibleEvent(event) {
  if (!event || event.hidden) return false;
  if (getEventOrgId(event) !== DEFAULT_ORG_ID) return false;
  return isWorshipEditableEvent(event) || isEventActive(event);
}

// V21.1: ensure the worship-live state slots exist on an event. Does not
// overwrite existing values — only initializes missing ones.
function ensureWorshipState(event) {
  if (!event) return event;
  if (!event.worshipState || typeof event.worshipState !== 'object') {
    event.worshipState = {
      currentSongId: null,
      currentVerseIndex: 0,
      // V21.22: master can blank the members' screen at song end. ended=true
      // keeps song/verse for the reverse path but tells worship-view to show
      // its waiting screen.
      ended: false,
      lastUpdatedAt: Date.now(),
      lastUpdatedBy: null,
      masterSessionId: null,
      masterLastSeen: null,
      offlineMode: false
    };
  }
  if (typeof event.worshipState.ended !== 'boolean') event.worshipState.ended = false;
  if (!Array.isArray(event.worshipViewTokens)) event.worshipViewTokens = [];
  if (!Array.isArray(event.worshipSyncRequests)) event.worshipSyncRequests = [];
  return event;
}

// V21.2: shape the worship-live state for broadcast / the worship-view client.
// Includes the current song so members render without a second request.
function buildWorshipStatePayload(event) {
  ensureWorshipState(event);
  const ws = event.worshipState;
  let song = null;
  if (ws.currentSongId) {
    const found = (event.songLibrary || []).find((s) => s && s.id === ws.currentSongId);
    if (found) song = {
      id: found.id,
      title: found.title || '',
      text: found.text || '',
      // WORSHIP-VIEW-KEY-PAYLOAD-FIX — include gama, ca worship-view (QR/link) să o afișeze
      // (în /worship spectatorul citește getLiveSong() direct și avea deja key; aici lipsea).
      key: typeof found.key === 'string' ? found.key : ''
    };
  }
  return {
    eventId: event.id,
    state: {
      currentSongId: ws.currentSongId,
      currentVerseIndex: ws.currentVerseIndex,
      // V21.22: surface the ended flag so worship-view can switch to its
      // waiting screen without dropping the song/verse context.
      ended: !!ws.ended,
      lastUpdatedBy: ws.lastUpdatedBy
    },
    song
  };
}

app.post('/api/auth/worship', (req, res) => {
  const rateCheck = checkOperatorLoginRateLimit(getOperatorClientIp(req));
  if (!rateCheck.allowed) {
    return res.status(429).json({ ok: false, error: `Too many attempts. Try again in ${rateCheck.retryAfter}s.` });
  }
  // WORSHIP-ROLES-2: dacă NU e configurat nici PIN global, nici coduri de rol → 503.
  // Altfel, login-ul merge prin PIN global (păstrat ca plasă de siguranță) SAU prin codul unui rol.
  const roles = Array.isArray(db.worshipRoles) ? db.worshipRoles : [];
  const hasRoleCodes = roles.some((r) => r && r.code);
  if (!WORSHIP_PIN && !hasRoleCodes) {
    logger.warn('[worship/login] Nor WORSHIP_PIN nor role codes configured');
    return res.status(503).json({ ok: false, error: 'Worship role not configured on this server.' });
  }
  const pin = String(req.body?.pin || '').trim();
  let roleInfo = null;   // null = membru de bază
  let isMaster = false;   // WORSHIP-PIN-MASTER — PIN global = cheia de maestru
  let authed = false;
  // (a) PIN global — devine acum cheia de maestru (toate capabilitățile).
  if (WORSHIP_PIN && pin && safeStringEqual(pin, WORSHIP_PIN)) {
    authed = true;
    isMaster = true;
  }
  // (b) cod de rol — dacă nu a trecut PIN-ul, încearcă codurile de rol
  if (!authed && pin) {
    const matched = roles.find((r) => r && r.code && safeStringEqual(pin, r.code));
    if (matched) {
      authed = true;
      roleInfo = { name: matched.name, canLead: !!matched.canLead, canAdmin: !!matched.canAdmin, canManageRoles: !!matched.canManageRoles };
    }
  }
  if (!authed) {
    logger.info('[worship/login] Invalid PIN/code attempt');
    return res.status(401).json({ ok: false, error: 'Invalid PIN.' });
  }
  const now = Date.now();
  // V21.1: sid gives the worship session a stable identity (offline detection
  // and master tracking in later V21 stages key on it).
  // WORSHIP-ROLES-2: salvăm rolul + capabilități în sesiune (null/false = membru de bază).
  // WORSHIP-PIN-MASTER: maestru → toate capabilitățile true, etichetă „Master" pentru badge.
  const session = {
    role: 'worship',
    sid: randomBytes(8).toString('hex'),
    addedSongs: [],
    iat: now,
    exp: now + WORSHIP_SESSION_MAX_AGE_MS,
    worshipMaster: isMaster,
    worshipRole: roleInfo ? roleInfo.name : (isMaster ? 'Master' : ''),
    canLead: roleInfo ? roleInfo.canLead : isMaster,
    canAdmin: roleInfo ? roleInfo.canAdmin : isMaster,
    canManageRoles: roleInfo ? roleInfo.canManageRoles : isMaster
  };
  setWorshipSessionCookie(req, res, session);
  logger.info('[worship/login] Worship session created', isMaster ? '(master via global PIN)' : (roleInfo ? '(role=' + roleInfo.name + ')' : '(base member)'));
  return res.json({ ok: true, role: session.worshipRole, canLead: session.canLead, canAdmin: session.canAdmin, canManageRoles: session.canManageRoles, worshipMaster: session.worshipMaster });
});

app.post('/api/auth/worship/logout', (req, res) => {
  // V21.2: revoke this master's worship-view QR tokens on logout.
  const session = tryWorshipSession(req);
  if (session && session.sid) {
    let dirty = false;
    Object.values(db.events || {}).forEach((event) => {
      if (!Array.isArray(event.worshipViewTokens) || !event.worshipViewTokens.length) return;
      const before = event.worshipViewTokens.length;
      event.worshipViewTokens = event.worshipViewTokens.filter((t) => t && t.masterSessionId !== session.sid);
      if (event.worshipViewTokens.length !== before) dirty = true;
    });
    // V21.20: instant offline propagation on ordered logout. The 60s heartbeat
    // watcher (WORSHIP_OFFLINE_MS) is too slow; emit on the SAME channel as the
    // online path (`worship:master_presence` in the `worship:${eventId}` room)
    // so operators/admins (already listeners — app.js / remote.js) flip to
    // offline immediately.
    Object.values(db.events || {}).forEach((event) => {
      const ws = event && event.worshipState;
      if (!ws || ws.masterSessionId !== session.sid) return;
      ws.offlineMode = true;
      ws.masterSessionId = null;
      dirty = true;
      io.to(`worship:${event.id}`).emit('worship:master_presence', { eventId: event.id, online: false });
      logger.info(`[worship/offline] master logout event=${event.id}`);
    });
    if (dirty) saveDb();
  }
  clearWorshipSessionCookie(req, res);
  return res.json({ ok: true });
});

// V21.18: permanent-link worship view auth. Reuses WORSHIP_PIN; mints a
// long-lived (30 days) read-only cookie under the `wv:` namespace. The cookie
// does not grant any control rights — it only unlocks `/api/worship-view/live`
// and the `worship:view:join_permanent` socket subscription.
app.post('/api/worship-view/auth', (req, res) => {
  const rateCheck = checkOperatorLoginRateLimit(getOperatorClientIp(req));
  if (!rateCheck.allowed) {
    return res.status(429).json({ ok: false, error: `Too many attempts. Try again in ${rateCheck.retryAfter}s.` });
  }
  if (!WORSHIP_PIN) {
    return res.status(503).json({ ok: false, error: 'Worship role not configured on this server.' });
  }
  const pin = String(req.body?.pin || '').trim();
  if (!pin || !safeStringEqual(pin, WORSHIP_PIN)) {
    logger.info('[worship-view/auth] Invalid PIN attempt');
    return res.status(401).json({ ok: false, error: 'PIN invalid.' });
  }
  const now = Date.now();
  const session = { role: 'worship_view', iat: now, exp: now + WORSHIP_VIEW_MAX_AGE_MS };
  setWorshipViewSessionCookie(req, res, session);
  logger.info('[worship-view/auth] View session created');
  return res.json({ ok: true });
});

app.post('/api/worship-view/logout', (req, res) => {
  clearWorshipViewSessionCookie(req, res);
  return res.json({ ok: true });
});

app.get('/api/worship-view/me', (req, res) => {
  if (!WORSHIP_PIN) return res.json({ ok: true, authenticated: false, configured: false });
  const session = tryWorshipViewSession(req);
  return res.json({ ok: true, authenticated: !!session, configured: true });
});

app.get('/api/worship-view/live', (req, res) => {
  if (!WORSHIP_PIN) return res.status(503).json({ ok: false, error: 'Worship role not configured on this server.' });
  const session = tryWorshipViewSession(req);
  if (!session) return res.status(401).json({ ok: false, error: 'Autentificare necesară.' });
  const event = getActiveWorshipEventForView();
  if (!event) return res.json({ ok: true, live: false });
  const payload = buildWorshipStatePayload(event);
  return res.json({ ok: true, live: true, eventId: event.id, eventName: event.name || '', state: payload.state, song: payload.song });
});

// WORSHIP-DRAFT-1: worship creates a draft event (worshipDraft + approved:false, minimal name).
// Invisible to participants until admin approves. Worship can edit it (scheduled future = editable).
// Admin sets the real date/details on approval.
app.post('/api/worship/events/create-draft', async (req, res) => {
  const session = requireWorshipApiSession(req, res);
  if (!session) return;
  try {
    const name = String(req.body?.name || '').trim().slice(0, 120);
    if (!name) return res.status(400).json({ ok: false, error: 'Numele e obligatoriu.' });
    const baseUrl = buildBaseUrl(req);
    const event = await createEvent({
      name, baseUrl,
      organizationId: DEFAULT_ORG_ID,
      worshipDraft: true,
      approved: false,
      createdByWorship: true,
      // Implicit „mâine" → scheduledTimestamp > Date.now() face draft-ul editabil (isWorshipEditableEvent).
      scheduledAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString()
    });
    event.worshipDraftCreatedAt = Date.now();
    saveDb();
    setWorshipSessionCookie(req, res, session);
    logger.info('[worship] draft event created:', event.id, 'name=', name);
    return res.json({ ok: true, eventId: event.id, name });
  } catch (err) {
    logger.error('[worship/create-draft] failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.get('/api/worship/events', (req, res) => {
  const session = requireWorshipApiSession(req, res);
  if (!session) return;
  try {
    // V21.5: ?mode=live returns only the active event (used by the worship
    // header's read-only "Event LIVE" display); ?mode=picker (and the
    // unspecified default for backward compat) returns future + live, with
    // the live event first — used by the per-card "Add to event" picker.
    const mode = String(req.query.mode || 'default');
    const livePredicate = (ev) => isWorshipAccessibleEvent(ev) && isEventActive(ev);
    const predicate = mode === 'live' ? livePredicate : isWorshipAccessibleEvent;
    const events = Object.values(db.events || {})
      .filter(predicate)
      .sort((a, b) => {
        const aA = isEventActive(a);
        const bA = isEventActive(b);
        if (aA !== bA) return aA ? -1 : 1;
        return (a.scheduledTimestamp || 0) - (b.scheduledTimestamp || 0);
      })
      .map((event) => ({
        id: event.id,
        name: event.name || 'Untitled event',
        scheduledAt: event.scheduledAt || null,
        scheduledTimestamp: event.scheduledTimestamp,
        isActive: isEventActive(event),
        songsCount: Array.isArray(event.songLibrary) ? event.songLibrary.length : 0
      }));
    // WORSHIP-ROLES-2: expune capabilitățile sesiunii (FĂRĂ coduri) ca clientul să gate-uiască UI.
    // WORSHIP-ROLES-LIVE: include și emoji-ul rolului (din db.worshipRoles) pentru badge.
    const _roleObj = (Array.isArray(db.worshipRoles) ? db.worshipRoles : []).find((r) => r.name === session.worshipRole);
    const currentUser = {
      role: session.worshipRole || '',
      canLead: !!session.canLead,
      canAdmin: !!session.canAdmin,
      canManageRoles: !!session.canManageRoles,   // WORSHIP-MANAGE-ROLES
      worshipMaster: !!session.worshipMaster,     // WORSHIP-PIN-MASTER
      emoji: _roleObj ? (_roleObj.emoji || '') : ''
    };
    return res.json({ ok: true, events, currentUser });
  } catch (err) {
    logger.error('[worship/events] Failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.get('/api/worship/events/:id', (req, res) => {
  const session = requireWorshipApiSession(req, res);
  if (!session) return;
  try {
    const event = db.events[req.params.id];
    if (!event) {
      return res.status(404).json({ ok: false, error: 'Event not found' });
    }
    if (!isWorshipAccessibleEvent(event)) {
      return res.status(403).json({ ok: false, error: 'Event is not accessible to worship' });
    }
    ensureEventUiState(event);
    ensureWorshipState(event);
    return res.json({
      ok: true,
      // WORSHIP-ROLES-2: capabilitățile sesiunii curente (gate UI client-side)
      // WORSHIP-ROLES-LIVE: include și emoji-ul rolului (din db.worshipRoles) pentru badge.
      currentUser: (() => {
        const _ro = (Array.isArray(db.worshipRoles) ? db.worshipRoles : []).find((r) => r.name === session.worshipRole);
        return {
          role: session.worshipRole || '',
          canLead: !!session.canLead,
          canAdmin: !!session.canAdmin,
          canManageRoles: !!session.canManageRoles,   // WORSHIP-MANAGE-ROLES
          worshipMaster: !!session.worshipMaster,     // WORSHIP-PIN-MASTER
          emoji: _ro ? (_ro.emoji || '') : ''
        };
      })(),
      event: {
        id: event.id,
        name: event.name || 'Untitled event',
        scheduledAt: event.scheduledAt || null,
        scheduledTimestamp: event.scheduledTimestamp,
        // V21.1: editable === setlist may be modified (upcoming only); a live
        // event is accessible (verse control) but not setlist-editable.
        editable: isWorshipEditableEvent(event),
        worshipState: {
          currentSongId: event.worshipState.currentSongId,
          currentVerseIndex: event.worshipState.currentVerseIndex
        },
        songs: (event.songLibrary || []).map((song) => ({
          id: song.id,
          title: song.title || '',
          // V21.1: lyrics are needed by Live mode to render verses.
          text: song.text || '',
          labels: Array.isArray(song.labels) ? song.labels : [],
          // WORSHIP-SONGS: gama (tonalitate) per cântare, editabilă de echipa worship.
          key: typeof song.key === 'string' ? song.key : '',
          // WORSHIP-SECTIONS-A: tipuri secțiune per bloc (verse/chorus/bridge), array paralel.
          sections: Array.isArray(song.sections) ? song.sections : [],
          // WORSHIP-NOTES-1: note de interpretare per-bloc (paralel cu sections).
          sectionNotes: Array.isArray(song.sectionNotes) ? song.sectionNotes : [],
          addedByWorship: session.addedSongs.includes(song.id)
        }))
      }
    });
  } catch (err) {
    logger.error('[worship/event-detail] Failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// WORSHIP-SONG-RECENCY-CHECK — caută dacă o cântare a fost cântată în ultimele N săptămâni
// în alte evenimente ale org-ului (match pe librarySongId SAU titlu, case-insensitive). Folosit
// de client ÎNAINTE de POST /songs/add pentru a afișa un confirm cu datele recente.
const SONG_RECENCY_WEEKS = 4;
app.post('/api/worship/events/:id/songs/check-recency', (req, res) => {
  const session = requireWorshipApiSession(req, res);
  if (!session) return;
  const targetId = req.params.id;
  const event = db.events[targetId];
  if (!event) return res.status(404).json({ ok: false, error: 'Event not found' });
  if (!isWorshipAccessibleEvent(event)) {
    return res.status(403).json({ ok: false, error: 'Cannot modify this event' });
  }
  const librarySongId = String(req.body?.librarySongId || '').trim();
  if (!librarySongId) return res.status(400).json({ ok: false, error: 'Missing librarySongId' });
  const orgId = getEventOrgId(event);
  const library = getOrganizationSongLibrary(orgId) || [];
  const librarySong = library.find((s) => s && s.id === librarySongId);
  const title = librarySong ? String(librarySong.title || '').trim().toLowerCase() : '';
  const now = Date.now();
  const cutoff = now - SONG_RECENCY_WEEKS * 7 * 24 * 3600 * 1000;
  const dates = [];
  Object.values(db.events).forEach((ev) => {
    if (!ev || ev.hidden) return;
    if (getEventOrgId(ev) !== orgId) return;
    if (ev.id === targetId) return;   // nu se compară cu evenimentul curent
    const ts = typeof ev.scheduledTimestamp === 'number' ? ev.scheduledTimestamp : null;
    if (ts === null || ts < cutoff || ts > now) return;   // doar trecut, în fereastră
    const songs = Array.isArray(ev.songLibrary) ? ev.songLibrary : [];
    const has = songs.some((s) => {
      if (!s) return false;
      if (s.id === librarySongId) return true;
      const t = String(s.title || '').trim().toLowerCase();
      return title && t === title;
    });
    if (has) {
      dates.push({
        ts,
        date: ev.scheduledDate || new Date(ts).toISOString().slice(0, 10),
        name: ev.name || ''
      });
    }
  });
  dates.sort((a, b) => b.ts - a.ts);   // recent întâi
  return res.json({ ok: true, found: dates.length > 0, dates, weeks: SONG_RECENCY_WEEKS });
});

app.post('/api/worship/events/:id/songs/add', (req, res) => {
  const session = requireWorshipApiSession(req, res);
  if (!session) return;
  const librarySongId = String(req.body?.librarySongId || '').trim();
  if (!librarySongId) {
    return res.status(400).json({ ok: false, error: 'Missing librarySongId' });
  }
  try {
    const event = db.events[req.params.id];
    if (!event) {
      return res.status(404).json({ ok: false, error: 'Event not found' });
    }
    // V21.5: worship may add songs to the live event during a service (was
    // future-only in V21.1; the new per-card picker exposes future + live).
    if (!isWorshipAccessibleEvent(event)) {
      return res.status(403).json({ ok: false, error: 'Cannot modify this event' });
    }
    const library = getOrganizationSongLibrary(getEventOrgId(event)) || [];
    const librarySong = library.find((song) => song && song.id === librarySongId);
    if (!librarySong) {
      return res.status(404).json({ ok: false, error: 'Song not in library' });
    }
    ensureEventUiState(event);
    const beforeIds = new Set(event.songLibrary.map((song) => song.id));
    const item = upsertLibraryItem(event.songLibrary, {
      title: librarySong.title,
      text: librarySong.text,
      labels: librarySong.labels || [],
      sourceLang: librarySong.sourceLang || event.sourceLang || 'ro',
      // LIBRARY-KEY-GLOBAL — seed key din biblioteca globală (punct de start)
      key: typeof librarySong.key === 'string' ? librarySong.key : '',
      // WORSHIP-SECTIONS-A — seed sections (verse/chorus/bridge per bloc) din global
      sections: Array.isArray(librarySong.sections) ? librarySong.sections : [],
      // WORSHIP-NOTES-1 — seed note de interpretare per-bloc din global
      sectionNotes: Array.isArray(librarySong.sectionNotes) ? librarySong.sectionNotes : []
    }, 100);
    // upsertLibraryItem dedupes by title: it may have overwritten an existing
    // (admin-added) song instead of creating one. Worship may only delete songs
    // it actually created this session, so track the id only when it is new.
    const isNewItem = !beforeIds.has(item.id);
    if (isNewItem) {
      item.addedBy = 'worship';
      item.addedAt = Date.now();
      session.addedSongs.push(item.id);
    }
    saveDb();
    setWorshipSessionCookie(req, res, session);
    // V21.6: live-sync event songLibrary across admin / operator / worship.
    io.to(`event:${event.id}`).to(`worship:${event.id}`).emit('event:songlibrary_changed', {
      eventId: event.id,
      songLibrary: event.songLibrary
    });
    logger.info(`[worship/add-song] event=${event.id} song="${librarySong.title}" itemId=${item.id} new=${isNewItem}`);
    return res.json({ ok: true, itemId: item.id, isNewItem });
  } catch (err) {
    logger.error('[worship/add-song] Failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.delete('/api/worship/events/:id/songs/:itemId', (req, res) => {
  const session = requireWorshipApiSession(req, res);
  if (!session) return;
  const itemId = String(req.params.itemId || '').trim();
  // WORSHIP-PIN-MASTER — maestru poate șterge orice cântare;
  // WORSHIP-PREP-DELETE — cine pregătește programul (canAdmin) la fel; ceilalți doar ce-au adăugat în sesiune.
  // Ștergerea afectează DOAR event.songLibrary (filter mai jos), NU Library globală.
  if (!itemId) {
    return res.status(400).json({ ok: false, error: 'Missing itemId' });
  }
  if (!session.worshipMaster && !session.canAdmin && !session.addedSongs.includes(itemId)) {
    logger.warn(`[worship/delete-song] Forbidden: itemId=${itemId} not addedSongs, not canAdmin/master`);
    return res.status(403).json({ ok: false, error: 'Can only delete songs you added (or you need prep/master rights)' });
  }
  try {
    const event = db.events[req.params.id];
    if (!event) {
      return res.status(404).json({ ok: false, error: 'Event not found' });
    }
    // V21.5: symmetric with songs/add — delete is allowed on live too (only
    // songs the session created, already gated by addedSongs above).
    if (!isWorshipAccessibleEvent(event)) {
      return res.status(403).json({ ok: false, error: 'Cannot modify this event' });
    }
    ensureEventUiState(event);
    const beforeCount = event.songLibrary.length;
    event.songLibrary = event.songLibrary.filter((song) => song && song.id !== itemId);
    if (event.songLibrary.length === beforeCount) {
      return res.status(404).json({ ok: false, error: 'Song not found in event' });
    }
    session.addedSongs = session.addedSongs.filter((id) => id !== itemId);
    saveDb();
    setWorshipSessionCookie(req, res, session);
    // V21.6: live-sync event songLibrary across admin / operator / worship.
    io.to(`event:${event.id}`).to(`worship:${event.id}`).emit('event:songlibrary_changed', {
      eventId: event.id,
      songLibrary: event.songLibrary
    });
    logger.info(`[worship/delete-song] event=${event.id} itemId=${itemId}`);
    return res.json({ ok: true });
  } catch (err) {
    logger.error('[worship/delete-song] Failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// WORSHIP-SONGS: set the key/tonality of a song in the event's setlist. Worship may set
// it on any accessible event (upcoming or live), mirroring songs/add gating. Empty = no key.
app.patch('/api/worship/events/:id/songs/:itemId/key', (req, res) => {
  const session = requireWorshipApiSession(req, res);
  if (!session) return;
  try {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Event not found' });
    if (!isWorshipAccessibleEvent(event)) {
      return res.status(403).json({ ok: false, error: 'Cannot modify this event' });
    }
    ensureEventUiState(event);
    const itemId = String(req.params.itemId || '').trim();
    const song = (event.songLibrary || []).find((s) => s && String(s.id) === itemId);
    if (!song) return res.status(404).json({ ok: false, error: 'Song not found in event' });
    song.key = typeof req.body?.key === 'string' ? req.body.key.trim().slice(0, 12) : '';
    // LIBRARY-KEY-GLOBAL — salvează gama și în biblioteca globală (după title normalizat),
    // ca data viitoare când se adaugă cântarea (songs/add), să vină cu key ca punct de start.
    try {
      const globalLib = getOrganizationSongLibrary(getEventOrgId(event));
      if (Array.isArray(globalLib) && song && song.title) {
        const targetTitle = normalizeLibraryTitle(song.title);
        const globalSong = globalLib.find((g) => g && normalizeLibraryTitle(g.title) === targetTitle);
        if (globalSong) globalSong.key = song.key;
      }
    } catch (e) { logger.warn('[key-global] propagation failed:', e && e.message); }
    saveDb();
    setWorshipSessionCookie(req, res, session);
    // V21.6: live-sync event songLibrary across admin / operator / worship.
    io.to(`event:${event.id}`).to(`worship:${event.id}`).emit('event:songlibrary_changed', {
      eventId: event.id,
      songLibrary: event.songLibrary
    });
    // WORSHIP-KEY-BROADCAST-STATE — trimite și state_change (calea dovedită pt spectator + worship-view),
    // ca schimbarea gamei (inclusiv din Pregătire, fără a schimba strofa) să ajungă instant, nu doar la
    // următoarea strofă. Payload-ul reflectă worshipState curent + song.key nou → clientul KEY-VIA-STATE
    // detectează keyChanged și re-randează fără a strica strofa.
    io.to(`worship:${event.id}`).emit('worship:state_change', buildWorshipStatePayload(event));
    logger.info(`[worship/song-key] event=${event.id} itemId=${itemId} key="${song.key}"`);
    return res.json({ ok: true, song: { id: song.id, key: song.key } });
  } catch (err) {
    logger.error('[worship/song-key] Failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// WORSHIP-SECTIONS-A: set per-block section types (verse/chorus/bridge) on a song, propagated
// to the global library (matched by normalized title). Same gating as /key endpoint.
app.patch('/api/worship/events/:id/songs/:itemId/sections', (req, res) => {
  const session = requireWorshipApiSession(req, res);
  if (!session) return;
  try {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Event not found' });
    if (!isWorshipAccessibleEvent(event)) {
      return res.status(403).json({ ok: false, error: 'Cannot modify this event' });
    }
    ensureEventUiState(event);
    const itemId = String(req.params.itemId || '').trim();
    const song = (event.songLibrary || []).find((s) => s && String(s.id) === itemId);
    if (!song) return res.status(404).json({ ok: false, error: 'Song not found in event' });
    const allowed = new Set(['verse', 'chorus', 'bridge']);
    const sections = Array.isArray(req.body?.sections)
      ? req.body.sections.map((x) => (allowed.has(x) ? x : 'verse'))
      : [];
    song.sections = sections;
    // Propagate to global library (after normalized title) — same pattern as LIBRARY-KEY-GLOBAL.
    try {
      const globalLib = getOrganizationSongLibrary(getEventOrgId(event));
      if (Array.isArray(globalLib) && song.title) {
        const targetTitle = normalizeLibraryTitle(song.title);
        const globalSong = globalLib.find((g) => g && normalizeLibraryTitle(g.title) === targetTitle);
        if (globalSong) globalSong.sections = sections.slice();
      }
    } catch (e) { logger.warn('[sections-global] propagation failed:', e && e.message); }
    saveDb();
    setWorshipSessionCookie(req, res, session);
    io.to(`event:${event.id}`).to(`worship:${event.id}`).emit('event:songlibrary_changed', {
      eventId: event.id,
      songLibrary: event.songLibrary
    });
    logger.info(`[worship/song-sections] event=${event.id} itemId=${itemId} sections=${JSON.stringify(sections)}`);
    return res.json({ ok: true, song: { id: song.id, sections: song.sections } });
  } catch (err) {
    logger.error('[worship/song-sections] Failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// WORSHIP-NOTES-1: set per-block interpretation notes (free text, parallel to sections).
// Same access gating + global propagation pattern as /sections.
app.patch('/api/worship/events/:id/songs/:itemId/section-notes', (req, res) => {
  const session = requireWorshipApiSession(req, res);
  if (!session) return;
  try {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Event not found' });
    if (!isWorshipAccessibleEvent(event)) {
      return res.status(403).json({ ok: false, error: 'Cannot modify this event' });
    }
    ensureEventUiState(event);
    const itemId = String(req.params.itemId || '').trim();
    const song = (event.songLibrary || []).find((s) => s && String(s.id) === itemId);
    if (!song) return res.status(404).json({ ok: false, error: 'Song not found in event' });
    const sectionNotes = Array.isArray(req.body?.sectionNotes)
      ? req.body.sectionNotes.map((n) => String(n == null ? '' : n).slice(0, 200))
      : [];
    song.sectionNotes = sectionNotes;
    // Propagate to global library (after normalized title) — same pattern as sections.
    try {
      const globalLib = getOrganizationSongLibrary(getEventOrgId(event));
      if (Array.isArray(globalLib) && song.title) {
        const targetTitle = normalizeLibraryTitle(song.title);
        const globalSong = globalLib.find((g) => g && normalizeLibraryTitle(g.title) === targetTitle);
        if (globalSong) globalSong.sectionNotes = sectionNotes.slice();
      }
    } catch (e) { logger.warn('[section-notes-global] propagation failed:', e && e.message); }
    saveDb();
    setWorshipSessionCookie(req, res, session);
    io.to(`event:${event.id}`).to(`worship:${event.id}`).emit('event:songlibrary_changed', {
      eventId: event.id,
      songLibrary: event.songLibrary
    });
    logger.info(`[worship/song-section-notes] event=${event.id} itemId=${itemId} count=${sectionNotes.length}`);
    return res.json({ ok: true, song: { id: song.id, sectionNotes: song.sectionNotes } });
  } catch (err) {
    logger.error('[worship/song-section-notes] Failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// WORSHIP-SONGS: reorder the event setlist. Body { order: [id, ...] } — songs are rebuilt
// in that order; any id missing from `order` is kept at the tail (safety). Same gating as add.
app.post('/api/worship/events/:id/songs/reorder', (req, res) => {
  const session = requireWorshipApiSession(req, res);
  if (!session) return;
  try {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Event not found' });
    if (!isWorshipAccessibleEvent(event)) {
      return res.status(403).json({ ok: false, error: 'Cannot modify this event' });
    }
    ensureEventUiState(event);
    const order = Array.isArray(req.body?.order) ? req.body.order.map(String) : [];
    if (!order.length) return res.status(400).json({ ok: false, error: 'No order provided' });
    const songs = Array.isArray(event.songLibrary) ? event.songLibrary : [];
    const byId = new Map(songs.map((s) => [String(s.id), s]));
    const reordered = [];
    for (const id of order) {
      if (byId.has(id)) { reordered.push(byId.get(id)); byId.delete(id); }
    }
    for (const leftover of byId.values()) reordered.push(leftover);
    event.songLibrary = reordered;
    saveDb();
    setWorshipSessionCookie(req, res, session);
    // V21.6: live-sync event songLibrary across admin / operator / worship.
    io.to(`event:${event.id}`).to(`worship:${event.id}`).emit('event:songlibrary_changed', {
      eventId: event.id,
      songLibrary: event.songLibrary
    });
    logger.info(`[worship/song-reorder] event=${event.id} count=${event.songLibrary.length}`);
    return res.json({ ok: true });
  } catch (err) {
    logger.error('[worship/song-reorder] Failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// V21.1: Worship Live Tablet — the worship master updates its own verse state.
// This is independent of the projector (displayState); projector sync arrives
// in a later V21 stage. State is persisted so it survives a reload/restart.
app.post('/api/worship/events/:id/verse', (req, res) => {
  const session = requireWorshipApiSession(req, res);
  if (!session) return;
  try {
    const event = db.events[req.params.id];
    if (!event) {
      return res.status(404).json({ ok: false, error: 'Event not found' });
    }
    if (!isWorshipAccessibleEvent(event)) {
      return res.status(403).json({ ok: false, error: 'Event is not accessible to worship' });
    }
    const songId = req.body?.songId == null ? null : String(req.body.songId).trim() || null;
    const verseIndex = Number(req.body?.verseIndex);
    // V21.22: optional `ended` flag — when true, blanks members' screen but
    // keeps song/verse so the master can step back from END with the left
    // arrow.
    const wantEnded = req.body?.ended === true;
    if (!Number.isInteger(verseIndex) || verseIndex < 0) {
      return res.status(400).json({ ok: false, error: 'Invalid verseIndex' });
    }
    ensureWorshipState(event);
    event.worshipState.currentSongId = songId;
    event.worshipState.currentVerseIndex = verseIndex;
    event.worshipState.ended = wantEnded;
    event.worshipState.lastUpdatedAt = Date.now();
    event.worshipState.lastUpdatedBy = 'worship';
    event.worshipState.masterSessionId = session.sid || null;
    event.worshipState.masterLastSeen = Date.now();
    event.worshipState.offlineMode = false;
    saveDb();
    // V21.2: push the change to connected worship members.
    io.to(`worship:${event.id}`).emit('worship:state_change', buildWorshipStatePayload(event));
    // V21.18: mirror to permanent-link viewers if this is the live event.
    if (isEventActive(event)) broadcastPermanentWorshipView();
    return res.json({
      ok: true,
      worshipState: {
        currentSongId: event.worshipState.currentSongId,
        currentVerseIndex: event.worshipState.currentVerseIndex,
        ended: event.worshipState.ended
      }
    });
  } catch (err) {
    logger.error('[worship/verse] Failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// V21.2: worship master generates a QR share link for read-only members.
// One active link per master session — generating again replaces the old one.
app.post('/api/worship/events/:id/share-qr', async (req, res) => {
  const session = requireWorshipApiSession(req, res);
  if (!session) return;
  try {
    const event = db.events[req.params.id];
    if (!event) {
      return res.status(404).json({ ok: false, error: 'Event not found' });
    }
    if (!isWorshipAccessibleEvent(event)) {
      return res.status(403).json({ ok: false, error: 'Event is not accessible to worship' });
    }
    ensureWorshipState(event);
    const masterSid = session.sid || null;
    event.worshipViewTokens = event.worshipViewTokens.filter((t) => t && t.masterSessionId !== masterSid);
    const token = randomBytes(16).toString('hex');
    event.worshipViewTokens.push({ token, createdAt: Date.now(), masterSessionId: masterSid });
    saveDb();
    const url = `${buildBaseUrl(req)}/worship-view?event=${encodeURIComponent(event.id)}&token=${token}`;
    const qrDataUrl = await QRCode.toDataURL(url, { width: 320, margin: 1 });
    logger.info(`[worship/share-qr] event=${event.id} token issued`);
    return res.json({ ok: true, token, url, qrDataUrl });
  } catch (err) {
    logger.error('[worship/share-qr] Failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// V21.2: read-only worship-view state, authenticated by QR token (no cookie).
app.get('/api/worship-view/:eventId', (req, res) => {
  const token = String(req.query.token || '').trim();
  if (!token) return res.status(401).json({ ok: false, error: 'Missing token' });
  const event = db.events[req.params.eventId];
  if (!event) return res.status(404).json({ ok: false, error: 'Event not found' });
  ensureWorshipState(event);
  if (!event.worshipViewTokens.some((t) => t && t.token === token)) {
    return res.status(401).json({ ok: false, error: 'Invalid or expired link' });
  }
  const payload = buildWorshipStatePayload(event);
  return res.json({ ok: true, eventName: event.name || '', state: payload.state, song: payload.song });
});

// V21.3: worship master asks an operator/admin to mirror its verse onto the
// projector. This stage only surfaces the request; the actual projector move
// is V21.4 — on approve, the operator applies it via the existing Tab Song.
app.post('/api/worship/events/:id/sync-request', (req, res) => {
  const session = requireWorshipApiSession(req, res);
  if (!session) return;
  try {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Event not found' });
    if (!isWorshipAccessibleEvent(event)) {
      return res.status(403).json({ ok: false, error: 'Event is not accessible to worship' });
    }
    ensureWorshipState(event);
    if (!event.worshipState.currentSongId) {
      return res.status(400).json({ ok: false, error: 'Selectează o cântare în Live mode mai întâi.' });
    }
    // Only one pending projector request at a time.
    event.worshipSyncRequests = event.worshipSyncRequests.filter(
      (r) => !(r && r.type === 'worship_to_projector' && r.status === 'pending')
    );
    const request = {
      id: randomBytes(6).toString('hex'),
      type: 'worship_to_projector',
      targetSongId: event.worshipState.currentSongId,
      targetVerseIndex: event.worshipState.currentVerseIndex,
      requestedAt: Date.now(),
      fromRole: 'worship',
      status: 'pending'
    };
    event.worshipSyncRequests.push(request);
    event.worshipSyncRequests = event.worshipSyncRequests.slice(-20);
    saveDb();
    const song = (event.songLibrary || []).find((s) => s && s.id === request.targetSongId);
    io.to(`worship:${event.id}`).emit('worship:sync_request_pending', {
      eventId: event.id,
      request,
      songTitle: song ? (song.title || '') : ''
    });
    return res.json({ ok: true, requestId: request.id });
  } catch (err) {
    logger.error('[worship/sync-request] Failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// V21.3: operator/admin approves or declines a worship -> projector request.
app.post('/api/events/:id/worship/sync-request/:reqId/resolve', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
  if (!requireEventPermission(req, res, 'song')) return;
  ensureWorshipState(event);
  const request = event.worshipSyncRequests.find((r) => r && r.id === req.params.reqId);
  if (!request || request.status !== 'pending') {
    return res.status(404).json({ ok: false, error: 'Cererea nu există sau a fost deja rezolvată.' });
  }
  if (request.type !== 'worship_to_projector') {
    return res.status(400).json({ ok: false, error: 'Tip de cerere greșit.' });
  }
  // V21.9: accept the new `status:'noted'` body — operator acknowledges
  // the request and will move the projector by hand. The legacy
  // `approve:true/false` boolean still works (V21.3 clients) and maps
  // onto status='approved'/'declined'. The broadcast carries BOTH the
  // string status (precise) and the legacy `approved` boolean
  // (backward compat with the existing worship master listener).
  let status;
  if (typeof req.body?.status === 'string' && ['noted', 'approved', 'declined'].includes(req.body.status)) {
    status = req.body.status;
  } else {
    status = req.body && req.body.approve === true ? 'approved' : 'declined';
  }
  request.status = status;
  request.resolvedAt = Date.now();
  saveDb();
  io.to(`worship:${event.id}`).emit('worship:sync_request_resolved', {
    eventId: event.id,
    requestId: request.id,
    status,
    // Legacy field: a "noted" acknowledgment is a positive signal so it
    // maps to approved=true for pre-V21.9 clients (they'll show
    // "aprobat" — close enough; new clients prefer the status field).
    approved: status === 'approved' || status === 'noted'
  });
  return res.json({ ok: true, status });
});

// V21.8: operator/admin pushes a song suggestion to the worship master.
// Verse index is forced to 0 — the verse-model reconciliation between
// projector blocks (marker-aware) and worship verses (blank-line split)
// is deferred to the bridge (V21.x); pushing index 0 is unambiguous and
// useful as-is ("start this song"). The master gets a modal; on accept
// the response endpoint moves worshipState which broadcasts to members
// and the operator's panel via the existing worship:state_change.
// WORSHIP-ROLES-3 — admin trimite un mesaj liber către un rol worship specific (sau „Toți").
// Server iterează socket-urile din camera worship:eventId și filtrează după socket.data.worshipRole.
app.post('/api/events/:id/worship/role-message', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
  const role = String(req.body?.role || '').trim();    // '' sau '__all__' = toți
  const text = String(req.body?.text || '').trim().slice(0, 200);
  if (!text) return res.status(400).json({ ok: false, error: 'Mesaj gol.' });
  const room = io.sockets.adapter.rooms.get(`worship:${event.id}`);
  const hint = { type: 'admin_msg', text, eventId: event.id, ts: Date.now(), role: role || '__all__' };
  let delivered = 0;
  if (room) {
    room.forEach((socketId) => {
      const s = io.sockets.sockets.get(socketId);
      if (!s) return;
      const sRole = s.data?.worshipRole || '';
      if (!role || role === '__all__' || sRole === role) {
        s.emit('worship:hint', hint);
        delivered++;
      }
    });
  }
  logger.info('[worship/role-message] event=' + event.id + ' role=' + (role || '__all__') + ' delivered=' + delivered);
  return res.json({ ok: true, delivered });
});

app.post('/api/events/:id/worship/push', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
  if (!requireEventPermission(req, res, 'song')) return;
  const songId = String(req.body?.songId || '').trim();
  if (!songId) return res.status(400).json({ ok: false, error: 'Lipsește songId.' });
  ensureEventUiState(event);
  const song = (event.songLibrary || []).find((s) => s && s.id === songId);
  if (!song) return res.status(404).json({ ok: false, error: 'Cântarea nu este în event.' });
  ensureWorshipState(event);
  // One pending operator->worship push at a time. The newest replaces
  // any stale pending one — operator can change their mind before the
  // master responds.
  event.worshipSyncRequests = event.worshipSyncRequests.filter(
    (r) => !(r && r.type === 'operator_to_worship' && r.status === 'pending')
  );
  const request = {
    id: randomBytes(6).toString('hex'),
    type: 'operator_to_worship',
    targetSongId: song.id,
    targetVerseIndex: 0,
    requestedAt: Date.now(),
    fromRole: req.eventRole || 'screen',
    status: 'pending'
  };
  event.worshipSyncRequests.push(request);
  event.worshipSyncRequests = event.worshipSyncRequests.slice(-20);
  saveDb();
  io.to(`worship:${event.id}`).emit('worship:operator_push', {
    eventId: event.id,
    request,
    songTitle: song.title || ''
  });
  return res.json({ ok: true, requestId: request.id });
});

// V21.8: worship master accepts or declines an operator_to_worship push.
// On accept, worshipState is moved to the requested song/verse and the
// usual worship:state_change broadcast updates members + the operator's
// awareness panel.
app.post('/api/worship/events/:id/sync-response', (req, res) => {
  const session = requireWorshipApiSession(req, res);
  if (!session) return;
  try {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Event not found' });
    if (!isWorshipAccessibleEvent(event)) {
      return res.status(403).json({ ok: false, error: 'Event is not accessible to worship' });
    }
    ensureWorshipState(event);
    const requestId = String(req.body?.requestId || '').trim();
    const accept = req.body && req.body.accept === true;
    const request = event.worshipSyncRequests.find((r) => r && r.id === requestId);
    if (!request || request.status !== 'pending') {
      return res.status(404).json({ ok: false, error: 'Cererea nu există sau a fost deja rezolvată.' });
    }
    if (request.type !== 'operator_to_worship') {
      return res.status(400).json({ ok: false, error: 'Tip de cerere greșit.' });
    }
    request.status = accept ? 'accepted' : 'declined';
    request.resolvedAt = Date.now();
    if (accept) {
      event.worshipState.currentSongId = request.targetSongId;
      event.worshipState.currentVerseIndex = Number.isInteger(request.targetVerseIndex) ? request.targetVerseIndex : 0;
      // V21.22: accepting an operator push implies leaving END state.
      event.worshipState.ended = false;
      event.worshipState.lastUpdatedAt = Date.now();
      event.worshipState.lastUpdatedBy = 'operator';
      event.worshipState.masterSessionId = session.sid || event.worshipState.masterSessionId;
      event.worshipState.masterLastSeen = Date.now();
      event.worshipState.offlineMode = false;
    }
    saveDb();
    if (accept) {
      io.to(`worship:${event.id}`).emit('worship:state_change', buildWorshipStatePayload(event));
      // V21.18: mirror to permanent-link viewers if this is the live event.
      if (isEventActive(event)) broadcastPermanentWorshipView();
    }
    io.to(`worship:${event.id}`).emit('worship:sync_request_resolved', {
      eventId: event.id,
      requestId: request.id,
      approved: accept
    });
    return res.json({
      ok: true,
      worshipState: {
        currentSongId: event.worshipState.currentSongId,
        currentVerseIndex: event.worshipState.currentVerseIndex
      }
    });
  } catch (err) {
    logger.error('[worship/sync-response] Failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

function getOperatorCodeFromRequest(req) {
  const cookieCode = getOperatorCodeFromCookie(req);
  if (cookieCode) return cookieCode;
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
  const cookieCode = getOperatorCodeFromCookie(req);
  const bodyCode = String(req.body?.operatorCode || '').trim();
  const operatorCode = cookieCode || bodyCode;
  if (!operatorCode || !isOperatorPinValid(operatorCode)) {
    return res.status(401).json({ ok: false, error: 'Operator session expired. Please log in again.' });
  }
  if (!rawId) {
    return res.status(400).json({ ok: false, error: 'Invalid Event ID' });
  }
  const event = findEventByIdOrShortId(rawId);
  if (!event) {
    return res.status(404).json({ ok: false, error: 'Invalid Event ID' });
  }
  const access = resolveEventAccessFromCode(event, operatorCode);
  if (access.role !== 'screen') {
    return res.status(403).json({ ok: false, error: 'Invalid Event ID' });
  }
  if (!cookieCode) {
    setOperatorSessionCookie(req, res, operatorCode);
  }
  return res.json({
    ok: true,
    redirectUrl: `/remote?event=${encodeURIComponent(event.id)}`
  });
});

registerOrgRoutes(app, {
  AZURE_SPEECH_KEY,
  AZURE_SPEECH_REGION,
  COMMERCIAL_MODE,
  DEFAULT_ORG_ID,
  LANGUAGE_NAMES_RO,
  LANGUAGE_ENDONYMS,
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
  AUDIO_ARCHIVE_ENABLED,
  SUMMARY_WEBHOOK_URL,
  SUMMARY_RECIPIENT,
  AZURE_SPEECH_KEY,
  AZURE_SPEECH_REGION,
  COMMERCIAL_MODE,
  DEFAULT_ORG_ID,
  LANGUAGES,
  LANGUAGE_NAMES_RO,
  LANGUAGE_ENDONYMS,
  TRANSCRIBE_RATE_LIMIT_MAX,
  TRANSCRIBE_RATE_LIMIT_WINDOW_MS,
  appendAudioArchiveChunk,
  audioArchivePath,
  applyDisplaySnapshot,
  deriveScheduledFields,   // WORSHIP-RESCHEDULE — folosit de /api/events/:id/reschedule
  applySourceCorrections,
  buildBaseUrl,
  buildBlockLabels,
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
  getDefaultOrganization,
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
  getTranslationCacheSnapshot,
  hasValidAdminSession,
  io,
  isAdminLoginConfigured,
  logger,
  normalizeDisplayPreset,
  normalizeDisplayTextScale,
  normalizeEvent,
  normalizeEventForAccess,
  normalizeLibraryTitle,
  normalizeOrgId,
  normalizeRemoteOperatorProfile,
  normalizeRemoteOperators,
  participantPresence,
  processText,
  pushSongHistory,
  queueSpeechText,
  recordAudit,
  recordScreenAction,
  recordTranscribeLatency,
  recordTranscribeUsage,
  recordTranslationUsage,
  rememberDisplayState,
  requireAdminApiSession,
  requireEventAdmin,
  requireEventManager,
  requireEventPermission,
  requireEventRole,
  requireGlobalLibraryAdmin,
  requireAdminOrOperatorApiSession,   // OPERATOR-PARITY-B
  tryWorshipSession,
  broadcastPermanentWorshipView,
  resolveEventAccessFromCode,
  normalizeTextInput,
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
  LANGUAGE_ENDONYMS,
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
  startAzureSpeechSession,
  ensureWorshipState,
  getWorshipSessionFromSocket,
  isWorshipAccessibleEvent,
  getWorshipViewSessionFromSocket,
  getActiveWorshipEventForView,
  buildWorshipStatePayload
});

async function ensureDefaultEvent() {
  const orgEvents = getOrganizationEvents(DEFAULT_ORG_ID);
  if (orgEvents.length > 0) return;
  try {
    const baseUrl = PUBLIC_BASE_URL || `http://localhost:${PORT}`;
    const event = await createEvent({
      name: 'Default test service',
      sourceLang: 'ro',
      targetLangs: ['no', 'en'],
      baseUrl,
      hidden: true,
      testMode: true,
      organizationId: DEFAULT_ORG_ID
    });
    logger.info('Default test event auto-created (hidden from participants):', event.id, event.shortId);
  } catch (err) {
    logger.error('Could not auto-create default event:', err?.message || err);
  }
}

loadPersistentTranslationCache();

// V21.3: flag a worship event as offline when its master stops sending
// heartbeats (~1 min). WORSHIP_OFFLINE_MS is env-overridable for testing.
const WORSHIP_OFFLINE_MS = Math.max(5000, Number(process.env.WORSHIP_OFFLINE_MS) || 60000);
setInterval(() => {
  const now = Date.now();
  let dirty = false;
  Object.values(db.events || {}).forEach((event) => {
    const ws = event && event.worshipState;
    if (!ws || !ws.masterSessionId || ws.offlineMode) return;
    if (typeof ws.masterLastSeen !== 'number') return;
    if (now - ws.masterLastSeen <= WORSHIP_OFFLINE_MS) return;
    ws.offlineMode = true;
    ws.masterSessionId = null;
    dirty = true;
    io.to(`worship:${event.id}`).emit('worship:master_presence', { eventId: event.id, online: false });
    logger.info(`[worship/offline] master offline for event=${event.id}`);
  });
  if (dirty) saveDb();
}, Math.min(30000, WORSHIP_OFFLINE_MS)).unref();

const httpServer = server.listen(PORT, () => {
  logger.info(`Sanctuary Voice running on ${httpServer.address()?.port || PORT}`);
  ensureDefaultEvent().catch((err) => logger.error('ensureDefaultEvent error:', err?.message || err));
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
    flushPersistentTranslationCache();
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
