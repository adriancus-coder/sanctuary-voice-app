const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const { randomUUID } = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const OpenAI = require('openai');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }
});

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-nano';
const OPENAI_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
const SPEECH_PROVIDER = String(process.env.SPEECH_PROVIDER || 'openai').trim().toLowerCase();
const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY || '';
const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION || '';
const MASTER_ADMIN_PIN = String(process.env.MASTER_ADMIN_PIN || process.env.APP_ADMIN_PIN || '').trim();
const MASTER_MODERATOR_PIN = String(process.env.MASTER_MODERATOR_PIN || process.env.APP_MODERATOR_PIN || '').trim();
const TRANSLATION_MONITOR_ENABLED = String(process.env.TRANSLATION_MONITOR_ENABLED || '').trim() === '1';

console.log('API KEY:', OPENAI_API_KEY ? 'OK' : 'LIPSA');
const client = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/participant', (req, res) => res.sendFile(path.join(__dirname, 'public', 'participant.html')));
app.get('/participant.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'participant.html')));
app.get('/live', (req, res) => res.sendFile(path.join(__dirname, 'public', 'participant.html')));
app.get('/translate', (req, res) => res.sendFile(path.join(__dirname, 'public', 'translate.html')));
app.get('/song', (req, res) => res.sendFile(path.join(__dirname, 'public', 'translate.html')));
app.get('/remote', (req, res) => res.sendFile(path.join(__dirname, 'public', 'remote.html')));

const DEFAULT_DATA_DIR = process.env.RENDER ? '/var/data' : path.join(__dirname, 'data');
const DATA_DIR = process.env.DATA_DIR || DEFAULT_DATA_DIR;
const DB_FILE = path.join(DATA_DIR, 'sessions.json');
console.log('DATA DIR:', DATA_DIR);

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
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
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
    backgroundPreset: 'none',
    customBackground: '',
    showClock: false,
    clockPosition: 'top-right',
    clockScale: 1,
    textSize: 'large',
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
    backgroundPreset: event.displayState.backgroundPreset,
    customBackground: event.displayState.customBackground,
    showClock: !!event.displayState.showClock,
    clockPosition: event.displayState.clockPosition,
    clockScale: event.displayState.clockScale || 1,
    textSize: event.displayState.textSize,
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
  event.displayState = {
    ...event.displayState,
    mode: ['auto', 'manual', 'song'].includes(safe.mode) ? safe.mode : 'auto',
    blackScreen: !!safe.blackScreen,
    theme: ['dark', 'light'].includes(safe.theme) ? safe.theme : 'dark',
    language: allowedDisplayLanguages.includes(safe.language) ? safe.language : (allowedDisplayLanguages[0] || event.targetLangs[0] || 'no'),
    backgroundPreset: ['none', 'warm', 'sanctuary', 'soft-light'].includes(safe.backgroundPreset) ? safe.backgroundPreset : 'none',
    customBackground: typeof safe.customBackground === 'string' ? safe.customBackground : '',
    showClock: !!safe.showClock,
    clockPosition: ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(safe.clockPosition) ? safe.clockPosition : 'top-right',
    clockScale: typeof safe.clockScale === 'number' ? Math.min(1.8, Math.max(0.7, safe.clockScale)) : 1,
    textSize: ['compact', 'large', 'xlarge'].includes(safe.textSize) ? safe.textSize : 'large',
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
  return { events: {}, globalMemory: {}, globalSongLibrary: defaultGlobalSongLibrary(), pinnedTextLibrary: defaultPinnedTextLibrary(), activeEventId: null };
}

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

function loadDb() {
  try {
    ensureDataDir();
    if (!fs.existsSync(DB_FILE)) {
      const initialDb = defaultDb();
      fs.writeFileSync(DB_FILE, JSON.stringify(initialDb, null, 2), 'utf8');
      return initialDb;
    }
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (err) {
    console.error('loadDb error:', err);
    return defaultDb();
  }
}

const db = loadDb();
if (!Array.isArray(db.globalSongLibrary)) {
  db.globalSongLibrary = defaultGlobalSongLibrary();
}
if (!Array.isArray(db.pinnedTextLibrary)) {
  db.pinnedTextLibrary = defaultPinnedTextLibrary();
}

function saveDb() {
  try {
    ensureDataDir();
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error('saveDb error:', err);
  }
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
const AZURE_LIVE_TEXT_TARGET_WORDS = 11;
const AZURE_LIVE_TEXT_MAX_WORDS = 17;
const AZURE_LIVE_TEXT_SOFT_WAIT_MS = 700;
const AZURE_LIVE_TEXT_HARD_WAIT_MS = 2600;

const BUFFER_CONNECTORS = new Set([
  'și', 'si', 'să', 'sa', 'că', 'ca', 'dar', 'iar', 'ori', 'sau',
  'de', 'la', 'în', 'in', 'cu', 'pe', 'din', 'spre', 'pentru',
  'când', 'cand', 'care', 'ce', 'către', 'catre',
  'og', 'at', 'men', 'som', 'i', 'på', 'med', 'til', 'for'
]);

function summarizeEvent(event) {
  return {
    id: event.id,
    name: event.name,
    createdAt: event.createdAt || null,
    scheduledAt: event.scheduledAt || null,
    sourceLang: event.sourceLang || 'ro',
    liveSourceLang: event.liveSourceLang || event.sourceLang || 'ro',
    targetLangs: Array.isArray(event.targetLangs) ? event.targetLangs : [],
    transcriptCount: Array.isArray(event.transcripts) ? event.transcripts.length : 0,
    isActive: db.activeEventId === event.id,
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
  const payload = {
    id: event.id,
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
    isActive: db.activeEventId === event.id,
    mode: event.mode || 'live',
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
    payload.adminCode = event.adminCode;
    payload.screenOperatorCode = event.screenOperatorCode || '';
    payload.remoteControlLink = event.remoteControlLink || '';
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
    backgroundPreset: event.displayState.backgroundPreset,
    customBackground: event.displayState.customBackground,
    showClock: event.displayState.showClock,
    clockPosition: event.displayState.clockPosition,
    clockScale: event.displayState.clockScale || 1,
    textSize: event.displayState.textSize,
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
  const screenStyle = ['focus', 'wide'].includes(input.screenStyle) ? input.screenStyle : 'focus';
  const displayResolution = ['auto', '16-9', '16-10', '4-3'].includes(input.displayResolution) ? input.displayResolution : 'auto';
  return {
    id: input.id || randomUUID(),
    name,
    mode,
    theme,
    language: String(input.language || 'no').trim() || 'no',
    backgroundPreset,
    customBackground: typeof input.customBackground === 'string' ? input.customBackground.trim() : '',
    showClock: !!input.showClock,
    clockPosition,
    clockScale,
    textSize,
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
  return { role: '', permissions: [], operator: null };
}

function requireEventRole(req, res, event, allowedRoles = ['admin']) {
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
  const suppliedCode = getSuppliedEventCode(req);
  if (MASTER_ADMIN_PIN && suppliedCode === MASTER_ADMIN_PIN) return true;
  const appAdminCode = String(process.env.APP_ADMIN_CODE || process.env.ADMIN_CODE || '').trim();
  if (appAdminCode && suppliedCode === appAdminCode) return true;
  const events = Object.values(db.events || {});
  if (!events.length && !appAdminCode) return true;
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

function buildBaseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = req.get('host');
  return `${proto}://${host}`;
}

function ensureEventAccessLinks(event, baseUrl) {
  if (!event.screenOperatorCode) {
    event.screenOperatorCode = `SV-SCREEN-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  }
  event.remoteOperators = normalizeRemoteOperators(event.remoteOperators || []);
  if (baseUrl) {
    event.participantLink = `${baseUrl}/participant`;
    event.translateLink = `${baseUrl}/translate?event=${event.id}`;
    event.songLink = `${baseUrl}/song?event=${event.id}`;
    event.remoteControlLink = `${baseUrl}/remote?event=${event.id}&code=${encodeURIComponent(event.screenOperatorCode)}`;
    event.remoteOperators = event.remoteOperators.map((operator) => ({
      ...operator,
      remoteLink: buildRemoteOperatorLink(baseUrl, event.id, operator)
    }));
  }
}

async function createEvent({ name, speed, sourceLang, targetLangs, baseUrl, scheduledAt }) {
  const id = randomUUID();
  const adminCode = `SV-ADMIN-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const screenOperatorCode = `SV-SCREEN-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const participantLink = `${baseUrl}/participant`;
  const translateLink = `${baseUrl}/translate?event=${id}`;
  const songLink = `${baseUrl}/song?event=${id}`;
  const remoteControlLink = `${baseUrl}/remote?event=${id}&code=${encodeURIComponent(screenOperatorCode)}`;
  const qrCodeDataUrl = await QRCode.toDataURL(participantLink);

  const event = {
    id,
    name: name || 'Eveniment nou',
    sourceLang: sourceLang || 'ro',
    liveSourceLang: sourceLang || 'ro',
    targetLangs: targetLangs?.length ? targetLangs : ['no', 'en'],
    speed: speed || 'balanced',
    scheduledAt: scheduledAt || null,
    adminCode,
    screenOperatorCode,
    remoteOperators: [],
    participantLink,
    translateLink,
    songLink,
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
    songState: defaultSongState(),
    latestDisplayEntry: null,
    displayState: { ...defaultDisplayState(), language: (targetLangs?.length ? targetLangs[0] : 'no') },
    displayStatePrevious: null,
    songLibrary: defaultSongLibrary(),
    songHistory: defaultSongHistory(),
    usageStats: defaultUsageStats()
  };

  db.events[id] = event;
  db.activeEventId = id;
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
  for (const [key, value] of Object.entries(db.globalMemory || {})) {
    const prefix = `${langCode.toUpperCase()}::`;
    if (key.startsWith(prefix)) langMemory[key.slice(prefix.length)] = value;
  }
  return { ...langMemory, ...(event.glossary?.[langCode] || {}) };
}

function getSourceCorrections(event) {
  const corrections = {};
  for (const [key, value] of Object.entries(db.globalMemory || {})) {
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
    const response = await client.responses.create({
      model: OPENAI_MODEL,
      input: [
        { role: 'system', content: buildPrompt(LANGUAGES[sourceLang] || sourceLang, LANGUAGES[langCode] || langCode, event.speed, glossary) },
        { role: 'user', content: cleanText }
      ]
    });
    const translated = sanitizeStructuredText(response.output_text || '');
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
    console.error(`translate error ${langCode}:`, err?.message || err);
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
    const response = await client.responses.create({
      model: OPENAI_MODEL,
      input: [
        {
          role: 'system',
          content: `Detect the language of the text. Return only one ISO code from this list: ${candidates.join(', ')}.`
        },
        { role: 'user', content: sanitizeStructuredText(text).slice(0, 700) }
      ]
    });
    const code = String(response.output_text || '').trim().toLowerCase().replace(/[^a-z]/g, '');
    return candidates.includes(code) ? code : fallback;
  } catch (err) {
    console.error('source language detect error:', err?.message || err);
    return fallback;
  }
}

function getActiveSpeechProvider() {
  if (SPEECH_PROVIDER === 'azure' || SPEECH_PROVIDER === 'azure_sdk') {
    return AZURE_SPEECH_KEY && AZURE_SPEECH_REGION ? 'azure_sdk' : 'openai';
  }
  return 'openai';
}

function getSpeechLocale(code) {
  return ({
    ro: 'ro-RO',
    no: 'nb-NO',
    en: 'en-US',
    ru: 'ru-RU',
    uk: 'uk-UA',
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
  })[code] || 'ro-RO';
}

function loadAzureSpeechSdk() {
  try {
    return require('microsoft-cognitiveservices-speech-sdk');
  } catch (err) {
    console.error('azure speech sdk missing:', err?.message || err);
    return null;
  }
}

async function transcribeAudioFile(filePath, event) {
  if (!client) return { text: '', sourceLang: event.sourceLang || 'ro' };
  const configured = String(event.liveSourceLang || event.sourceLang || 'ro').trim();
  const shouldDetectLanguage = !configured || configured === 'auto';
  const effectiveSourceLang = shouldDetectLanguage ? (event.sourceLang || 'ro') : configured;
  const request = {
    file: fs.createReadStream(filePath),
    model: OPENAI_TRANSCRIBE_MODEL,
    response_format: 'json',
    prompt:
      effectiveSourceLang === 'no'
        ? 'The audio is a Christian sermon in Norwegian. Keep the transcript in Norwegian. Use natural punctuation. Common terms may include Jesus, Kristus, Herren, Den Hellige Ånd, menighet, evangeliet, apostel, nåde, kjærlighet, synd, frelse.'
        : 'The audio is a live church service or sermon. Keep the transcript in the selected source language. Keep names and punctuation natural.'
  };
  if (!shouldDetectLanguage && LANGUAGES[effectiveSourceLang]) request.language = effectiveSourceLang;
  const result = await client.audio.transcriptions.create(request);
  const text = String(result?.text || '').trim();
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
      buffered.timer = setTimeout(() => flushSpeechBuffer(eventId, true).catch(console.error), softWaitMs);
      speechBuffers.set(eventId, buffered);
      return null;
    }
    if (BUFFER_CONNECTORS.has(last) && words < targetWords) {
      buffered.timer = setTimeout(() => flushSpeechBuffer(eventId, true).catch(console.error), softWaitMs);
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
    flushSpeechBuffer(eventId, false).catch(console.error);
    return;
  }
  if (ageMs > hardWaitMs || words >= maxWords) {
    flushSpeechBuffer(eventId, true).catch(console.error);
    return;
  }
  next.timer = setTimeout(() => flushSpeechBuffer(eventId, true).catch(console.error), softWaitMs);
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

function startAzureSpeechSession(socket, event) {
  closeAzureSpeechSession(socket.id);
  const sdk = loadAzureSpeechSdk();
  if (!sdk || !AZURE_SPEECH_KEY || !AZURE_SPEECH_REGION) {
    socket.emit('server_error', { message: 'Azure Speech nu este configurat pe server.' });
    return false;
  }

  const sourceLang = String(event.liveSourceLang || event.sourceLang || 'ro').trim();
  const effectiveSourceLang = sourceLang === 'auto' ? (event.sourceLang || 'ro') : sourceLang;
  const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_SPEECH_KEY, AZURE_SPEECH_REGION);
  speechConfig.speechRecognitionLanguage = getSpeechLocale(effectiveSourceLang);

  const audioFormat = sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
  const pushStream = sdk.AudioInputStream.createPushStream(audioFormat);
  const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
  const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

  recognizer.recognizing = (_, result) => {
    const text = sanitizeTranscriptText(result?.result?.text || '');
    if (text) io.to(`event:${event.id}:admins`).emit('partial_transcript', { text });
  };
  recognizer.recognized = (_, result) => {
    const text = sanitizeTranscriptText(result?.result?.text || '');
    if (text) queueSpeechText(event.id, text, effectiveSourceLang, 'azure_sdk');
  };
  recognizer.canceled = (_, result) => {
    console.error('azure speech canceled:', result?.errorDetails || result?.reason || 'unknown');
    socket.emit('server_error', { message: 'Azure Speech s-a oprit. Verifica setarile Azure.' });
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
      console.error('azure speech start error:', err);
      socket.emit('server_error', { message: 'Nu am putut porni Azure Speech.' });
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
  const match = lines[0].match(/^((?:r|refren|chorus)\s*\d*|\d+)\.\s*(.*)$/i);
  if (!match) return { label: '', text: lines.join('\n') };

  const marker = match[1].replace(/\s+/g, '').toLowerCase();
  const rest = String(match[2] || '').trim();
  const contentLines = rest ? [rest, ...lines.slice(1)] : lines.slice(1);
  const text = contentLines.join('\n').trim();

  if (/^\d+$/.test(marker)) return { label: `Strofa ${marker}`, text };
  if (marker.startsWith('chorus')) {
    const number = marker.replace('chorus', '');
    return { label: number ? `Chorus ${number}` : 'Chorus', text };
  }
  const number = marker.replace(/^r(?:efren)?/, '');
  return { label: number ? `Refren ${number}` : 'Refren', text };
}

function splitSongBlocksWithLabels(text, labels = []) {
  const rawBlocks = splitSongBlocks(text);
  const parsed = rawBlocks.map(parseSongSectionMarker);
  const blocks = parsed.map((item, index) => item.text || rawBlocks[index]).filter(Boolean);
  const blockLabels = blocks.map((_, index) => {
    const provided = String(labels[index] || '').trim();
    return provided || parsed[index]?.label || `Verse ${index + 1}`;
  });
  return { blocks, labels: blockLabels };
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

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    openaiConfigured: !!OPENAI_API_KEY,
    model: OPENAI_MODEL,
    transcribeModel: OPENAI_TRANSCRIBE_MODEL,
    speechProvider: getActiveSpeechProvider(),
    azureSpeechConfigured: !!(AZURE_SPEECH_KEY && AZURE_SPEECH_REGION)
  });
});

app.get('/api/events/:id/azure-token', async (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
  if (!requireEventPermission(req, res, 'main_screen')) return;
  if (!AZURE_SPEECH_KEY || !AZURE_SPEECH_REGION) {
    return res.status(500).json({ ok: false, error: 'Azure Speech nu este configurat.' });
  }
  try {
    const response = await fetch(`https://${AZURE_SPEECH_REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': AZURE_SPEECH_KEY,
        'Content-Length': '0'
      }
    });
    if (!response.ok) {
      return res.status(502).json({ ok: false, error: `Azure token failed: ${response.status}` });
    }
    res.json({ ok: true, token: await response.text(), region: AZURE_SPEECH_REGION });
  } catch (err) {
    console.error('azure token error:', err?.message || err);
    res.status(500).json({ ok: false, error: 'Nu am putut cere token Azure.' });
  }
});

app.get('/api/languages', (req, res) => {
  res.json({ ok: true, languages: LANGUAGE_NAMES_RO });
});

app.get('/api/participant-qr.png', async (req, res) => {
  try {
    const participantUrl = `${buildBaseUrl(req)}/participant`;
    const buffer = await QRCode.toBuffer(participantUrl, { type: 'png', margin: 2, width: 720 });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (err) {
    console.error('participant qr error:', err);
    res.status(500).send('QR error');
  }
});

app.post('/api/events', async (req, res) => {
  if (!requireEventManager(req, res)) return;
  try {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const baseUrl = `${protocol}://${req.get('host')}`;
    const event = await createEvent({
      name: req.body.name,
      speed: req.body.speed,
      sourceLang: req.body.sourceLang || 'ro',
      targetLangs: req.body.targetLangs || ['no', 'en'],
      baseUrl,
      scheduledAt: req.body.scheduledAt || null
    });
    res.json({ ok: true, event: normalizeEvent(event, { includeSecrets: true }) });
  } catch (err) {
    console.error('create event error:', err);
    res.status(500).json({ ok: false, error: 'Nu am putut crea evenimentul.' });
  }
});

app.get('/api/events/active', (req, res) => {
  const activeEventId = db.activeEventId;
  const event = activeEventId ? db.events[activeEventId] : null;
  if (!event) return res.status(404).json({ ok: false, error: 'Nu există eveniment activ.' });
  ensureEventAccessLinks(event, buildBaseUrl(req));
  saveDb();
  res.json({ ok: true, event: normalizeEvent(event), languageNames: LANGUAGE_NAMES_RO });
});

app.get('/api/events/public', (req, res) => {
  const events = Object.values(db.events || {})
    .sort((a, b) => {
      const left = new Date(a.scheduledAt || a.createdAt || 0);
      const right = new Date(b.scheduledAt || b.createdAt || 0);
      return right - left;
    })
    .map((event) => ({
      id: event.id,
      name: event.name,
      scheduledAt: event.scheduledAt || null,
      createdAt: event.createdAt || null,
      sourceLang: event.sourceLang || 'ro',
      targetLangs: Array.isArray(event.targetLangs) ? event.targetLangs : [],
      isActive: db.activeEventId === event.id
    }));
  res.json({ ok: true, events, activeEventId: db.activeEventId || null, languageNames: LANGUAGE_NAMES_RO });
});

app.get('/api/events', (req, res) => {
  const events = Object.values(db.events || {})
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .map(summarizeEvent);
  res.json({ ok: true, events, activeEventId: db.activeEventId || null, languageNames: LANGUAGE_NAMES_RO });
});

app.get('/api/events/:id', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  ensureEventAccessLinks(event, buildBaseUrl(req));
  saveDb();
  const access = resolveEventAccessFromCode(event, getSuppliedEventCode(req));
  res.json({ ok: true, event: normalizeEvent(event, { includeSecrets: access.role === 'admin' }), languageNames: LANGUAGE_NAMES_RO });
});

app.post('/api/events/:id/remote-operators', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
  if (!requireEventPermission(req, res, 'song')) return;
  ensureEventAccessLinks(event, buildBaseUrl(req));
  const name = String(req.body.name || '').trim();
  const profile = normalizeRemoteOperatorProfile(req.body.profile);
  if (!name) return res.status(400).json({ ok: false, error: 'Numele operatorului lipseste.' });
  const operator = {
    id: randomUUID(),
    name,
    profile,
    code: `SV-REMOTE-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
    permissions: getRemoteOperatorPermissions(profile),
    remoteLink: ''
  };
  event.remoteOperators.unshift(operator);
  ensureEventAccessLinks(event, buildBaseUrl(req));
  saveDb();
  res.json({ ok: true, remoteOperators: event.remoteOperators });
});

app.delete('/api/events/:id/remote-operators/:operatorId', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventAdmin(req, res, event)) return;
  event.remoteOperators = normalizeRemoteOperators(event.remoteOperators || []).filter((item) => item.id !== req.params.operatorId);
  saveDb();
  res.json({ ok: true, remoteOperators: event.remoteOperators });
});

app.post('/api/events/:id/settings', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventAdmin(req, res, event)) return;
  if (typeof req.body.speed === 'string' && req.body.speed.trim()) event.speed = req.body.speed.trim();
  if (typeof req.body.sourceLang === 'string') {
    const sourceLang = req.body.sourceLang.trim();
    if (LANGUAGES[sourceLang]) {
      event.sourceLang = sourceLang;
      event.liveSourceLang = sourceLang;
      event.songState = event.songState || defaultSongState();
      event.displayState = event.displayState || defaultDisplayState();
      if (!event.songState?.sourceLang) event.songState.sourceLang = sourceLang;
      if (!event.displayState?.manualSourceLang) event.displayState.manualSourceLang = sourceLang;
    }
  }
  if (typeof req.body.liveSourceLang === 'string') {
    const liveSourceLang = req.body.liveSourceLang.trim();
    event.liveSourceLang = liveSourceLang === 'auto' || LANGUAGES[liveSourceLang] ? liveSourceLang : (event.liveSourceLang || 'auto');
  }
  saveDb();
  res.json({ ok: true, event: normalizeEventForAccess(req, event) });
});

app.post('/api/events/:id/mode', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
  const mode = String(req.body.mode || 'live').trim();
  if (!['live', 'song'].includes(mode)) return res.status(400).json({ ok: false, error: 'Mod invalid.' });
  if (mode === 'song' && !requireEventPermission(req, res, 'song')) return;
  if (mode === 'live' && req.eventRole !== 'admin') {
    const permissions = req.eventAccess?.permissions || [];
    if (!permissions.includes('song') && !permissions.includes('main_screen')) {
      return res.status(403).json({ ok: false, error: 'Operatorul nu are permisiunea pentru aceasta actiune.' });
    }
  }
  ensureEventUiState(event);
  event.mode = mode;
  if (mode === 'live') {
    rememberDisplayState(event);
    event.displayState.mode = 'auto';
    event.displayState.blackScreen = false;
    event.displayState.sceneLabel = '';
    event.displayState.updatedAt = new Date().toISOString();
  }
  saveDb();
  io.to(`event:${event.id}`).emit('mode_changed', { mode });
  if (mode === 'live') {
    io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));
  }
  res.json({ ok: true, event: normalizeEventForAccess(req, event) });
});

app.post('/api/events/:id/activate', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventAdmin(req, res, event)) return;
  db.activeEventId = event.id;
  saveDb();
  io.emit('active_event_changed', { eventId: event.id });
  res.json({ ok: true, event: normalizeEventForAccess(req, event) });
});

app.delete('/api/events/:id', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventAdmin(req, res, event)) return;
  delete db.events[req.params.id];
  speechBuffers.delete(req.params.id);
  participantPresence.delete(req.params.id);
  if (db.activeEventId === req.params.id) {
    const remaining = Object.values(db.events).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    db.activeEventId = remaining[0]?.id || null;
  }
  saveDb();
  io.emit('active_event_changed', { eventId: db.activeEventId || null });
  res.json({ ok: true, activeEventId: db.activeEventId || null });
});

app.post('/api/events/:id/glossary', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventAdmin(req, res, event)) return;
  const source = String(req.body.source || '').trim();
  const target = String(req.body.target || '').trim();
  const permanent = !!req.body.permanent;
  const lang = String(req.body.lang || '').trim();
  if (!source || !target) return res.status(400).json({ ok: false, error: 'Date lipsă.' });
  if (!lang) return res.status(400).json({ ok: false, error: 'Limbă lipsă.' });
  event.glossary[lang] = event.glossary[lang] || {};
  event.glossary[lang][source] = target;
  if (permanent) db.globalMemory[`${lang.toUpperCase()}::${source}`] = target;
  saveDb();
  io.to(`event:${event.id}`).emit('glossary_updated', { source, target, permanent });
  res.json({ ok: true });
});

app.post('/api/events/:id/source-corrections', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventAdmin(req, res, event)) return;
  const heard = String(req.body.heard || '').trim();
  const correct = String(req.body.correct || '').trim();
  const permanent = !!req.body.permanent;
  if (!heard || !correct) return res.status(400).json({ ok: false, error: 'Date lipsă.' });
  event.sourceCorrections = event.sourceCorrections || {};
  event.sourceCorrections[heard] = correct;
  if (permanent) db.globalMemory[`SRC::${heard}`] = correct;
  saveDb();
  io.to(`event:${event.id}`).emit('source_corrections_updated', { heard, correct, permanent });
  res.json({ ok: true });
});

app.post('/api/events/:id/audio', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventAdmin(req, res, event)) return;
  if (typeof req.body.audioMuted === 'boolean') event.audioMuted = req.body.audioMuted;
  if (typeof req.body.audioVolume === 'number') event.audioVolume = Math.max(0, Math.min(100, req.body.audioVolume));
  saveDb();
  io.to(`event:${event.id}`).emit('audio_state', { audioMuted: event.audioMuted, audioVolume: event.audioVolume });
  res.json({ ok: true, event: normalizeEventForAccess(req, event) });
});

app.post('/api/events/:id/song/load', async (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
  if (!requireEventPermission(req, res, 'song')) return;
  const title = String(req.body.title || '').trim();
  const text = sanitizeStructuredText(req.body.text || '');
  const labels = Array.isArray(req.body.labels) ? req.body.labels : [];
  if (!text) return res.status(400).json({ ok: false, error: 'Text lipsă.' });
  try {
    const parsedSong = splitSongBlocksWithLabels(text, labels);
    const blocks = parsedSong.blocks;
    const songSourceLang = String(req.body.sourceLang || event.sourceLang || 'ro').trim() || 'ro';
    const allTranslations = await buildSongTranslations(event, blocks, songSourceLang);
    event.songState = {
      title,
      sourceLang: songSourceLang,
      blocks,
      blockLabels: parsedSong.labels,
      currentIndex: blocks.length ? 0 : -1,
      activeBlock: blocks[0] || null,
      translations: allTranslations[0] || {},
      allTranslations,
      updatedAt: new Date().toISOString()
    };
    event.mode = 'song';
    rememberDisplayState(event);
    ensureEventUiState(event);
    event.displayState.mode = 'song';
    event.displayState.blackScreen = false;
    event.displayState.sceneLabel = '';
    event.displayState.updatedAt = new Date().toISOString();
    recordScreenAction(event, 'song');
    saveDb();
    io.to(`event:${event.id}`).emit('mode_changed', { mode: 'song' });
    io.to(`event:${event.id}`).emit('song_state', event.songState);
    io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));
    emitUsageStats(event.id);
    res.json({ ok: true, songState: event.songState, event: normalizeEventForAccess(req, event) });
  } catch (err) {
    console.error('song load error:', err);
    res.status(500).json({ ok: false, error: 'Nu am putut pregăti Song.' });
  }
});

app.post('/api/events/:id/song/show/:index', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
  if (!requireEventPermission(req, res, 'song')) return;
  const index = Number(req.params.index);
  if (!setSongIndex(event, index)) return res.status(400).json({ ok: false, error: 'Index invalid.' });
  recordScreenAction(event, 'song');
  saveDb();
  io.to(`event:${event.id}`).emit('song_state', event.songState);
  emitUsageStats(event.id);
  res.json({ ok: true, songState: event.songState });
});

app.post('/api/events/:id/song/labels', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
  if (!requireEventPermission(req, res, 'song')) return;
  const labels = Array.isArray(req.body.labels) ? req.body.labels : [];
  const blocks = Array.isArray(event.songState?.blocks) ? event.songState.blocks : [];
  event.songState = event.songState || defaultSongState();
  event.songState.blockLabels = buildBlockLabels(blocks, labels);
  saveDb();
  io.to(`event:${event.id}`).emit('song_state', event.songState);
  res.json({ ok: true, songState: event.songState });
});

app.post('/api/events/:id/song/next', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
  if (!requireEventPermission(req, res, 'song')) return;
  const nextIndex = Number(event.songState?.currentIndex ?? -1) + 1;
  if (!setSongIndex(event, nextIndex)) return res.status(400).json({ ok: false, error: 'Nu mai există bloc următor.' });
  recordScreenAction(event, 'song');
  saveDb();
  io.to(`event:${event.id}`).emit('song_state', event.songState);
  emitUsageStats(event.id);
  res.json({ ok: true, songState: event.songState });
});

app.post('/api/events/:id/song/prev', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
  if (!requireEventPermission(req, res, 'song')) return;
  const prevIndex = Number(event.songState?.currentIndex ?? 0) - 1;
  if (!setSongIndex(event, prevIndex)) return res.status(400).json({ ok: false, error: 'Nu mai există bloc anterior.' });
  saveDb();
  io.to(`event:${event.id}`).emit('song_state', event.songState);
  res.json({ ok: true, songState: event.songState });
});

app.post('/api/events/:id/song/clear', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
  if (!requireEventPermission(req, res, 'song')) return;
  rememberDisplayState(event);
  event.songState = defaultSongState();
  event.mode = 'live';
  ensureEventUiState(event);
  event.latestDisplayEntry = null;
  event.displayState.mode = 'auto';
  event.displayState.blackScreen = false;
  event.displayState.sceneLabel = '';
  event.displayState.updatedAt = new Date().toISOString();
  saveDb();
  io.to(`event:${event.id}`).emit('song_clear');
  io.to(`event:${event.id}`).emit('mode_changed', { mode: 'live' });
  io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));
  res.json({ ok: true, event: normalizeEventForAccess(req, event) });
});


app.post('/api/events/:id/display/mode', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;

  ensureEventUiState(event);

  const mode = String(req.body.mode || '').trim().toLowerCase();
  if (!['auto', 'manual', 'song'].includes(mode)) {
    return res.status(400).json({ ok: false, error: 'Mod invalid.' });
  }
  if (mode === 'song') {
    if (!requireEventPermission(req, res, 'song')) return;
  } else if (!requireEventPermission(req, res, 'main_screen')) return;

  if (mode === 'song' && !event.songState?.activeBlock && !event.songState?.translations) {
    return res.status(400).json({ ok: false, error: 'Nu exista continut activ pentru Song.' });
  }

  rememberDisplayState(event);
  event.displayState.mode = mode;
  event.displayState.blackScreen = false;
  event.displayState.sceneLabel = '';
  event.displayState.updatedAt = new Date().toISOString();
  recordScreenAction(event, 'display');
  saveDb();

  io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));
  emitUsageStats(event.id);

  res.json({ ok: true, displayState: event.displayState, previousState: event.displayStatePrevious || null, event: normalizeEventForAccess(req, event) });
});

app.post('/api/events/:id/display/theme', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
  if (!requireEventPermission(req, res, 'main_screen')) return;

  ensureEventUiState(event);
  const theme = String(req.body.theme || 'dark').trim();
  if (!['dark', 'light'].includes(theme)) {
    return res.status(400).json({ ok: false, error: 'Tema invalida.' });
  }

  rememberDisplayState(event);
  event.displayState.theme = theme;
  event.displayState.sceneLabel = '';
  event.displayState.updatedAt = new Date().toISOString();
  recordScreenAction(event, 'display');
  saveDb();

  io.to(`event:${event.id}`).emit('display_theme_changed', {
    theme: event.displayState.theme,
    updatedAt: event.displayState.updatedAt
  });
  io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));
  emitUsageStats(event.id);

  res.json({ ok: true, displayState: event.displayState, previousState: event.displayStatePrevious || null });
});

app.post('/api/events/:id/display/language', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
  if (!requireEventPermission(req, res, 'main_screen')) return;
  ensureEventUiState(event);
  const language = String(req.body.language || '').trim();
  const allowedDisplayLanguages = getDisplayLanguageChoices(event);
  if (!allowedDisplayLanguages.includes(language)) {
    return res.status(400).json({ ok: false, error: 'Limba invalida pentru ecran.' });
  }
  rememberDisplayState(event);
  event.displayState.language = language;
  event.displayState.sceneLabel = '';
  event.displayState.updatedAt = new Date().toISOString();
  recordScreenAction(event, 'display');
  saveDb();
  io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));
  emitUsageStats(event.id);
  res.json({ ok: true, displayState: event.displayState, previousState: event.displayStatePrevious || null });
});

app.post('/api/events/:id/display/settings', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
  if (!requireEventPermission(req, res, 'main_screen')) return;
  ensureEventUiState(event);
  const backgroundPreset = typeof req.body.backgroundPreset === 'string' ? req.body.backgroundPreset.trim() : event.displayState.backgroundPreset;
  const customBackground = typeof req.body.customBackground === 'string' ? req.body.customBackground.trim() : event.displayState.customBackground;
  const showClock = typeof req.body.showClock === 'boolean' ? req.body.showClock : event.displayState.showClock;
  const clockPosition = typeof req.body.clockPosition === 'string' ? req.body.clockPosition.trim() : event.displayState.clockPosition;
  const clockScale = typeof req.body.clockScale === 'number' ? req.body.clockScale : event.displayState.clockScale;
  const textSize = typeof req.body.textSize === 'string' ? req.body.textSize.trim() : event.displayState.textSize;
  const screenStyle = typeof req.body.screenStyle === 'string' ? req.body.screenStyle.trim() : event.displayState.screenStyle;
  const displayResolution = typeof req.body.displayResolution === 'string' ? req.body.displayResolution.trim() : event.displayState.displayResolution;
  if (!['none', 'warm', 'sanctuary', 'soft-light'].includes(backgroundPreset)) {
    return res.status(400).json({ ok: false, error: 'Preset fundal invalid.' });
  }
  if (!['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(clockPosition)) {
    return res.status(400).json({ ok: false, error: 'Pozitie ceas invalida.' });
  }
  if (typeof clockScale !== 'number' || Number.isNaN(clockScale) || clockScale < 0.7 || clockScale > 1.8) {
    return res.status(400).json({ ok: false, error: 'Marime ceas invalida.' });
  }
  if (!['compact', 'large', 'xlarge'].includes(textSize)) {
    return res.status(400).json({ ok: false, error: 'Marime text invalida.' });
  }
  if (!['focus', 'wide'].includes(screenStyle)) {
    return res.status(400).json({ ok: false, error: 'Layout ecran invalid.' });
  }
  if (!['auto', '16-9', '16-10', '4-3'].includes(displayResolution)) {
    return res.status(400).json({ ok: false, error: 'Rezolutie ecran invalida.' });
  }
  rememberDisplayState(event);
  event.displayState.backgroundPreset = backgroundPreset;
  event.displayState.customBackground = customBackground;
  event.displayState.showClock = !!showClock;
  event.displayState.clockPosition = clockPosition;
  event.displayState.clockScale = clockScale;
  event.displayState.textSize = textSize;
  event.displayState.screenStyle = screenStyle;
  event.displayState.displayResolution = displayResolution;
  event.displayState.sceneLabel = '';
  event.displayState.updatedAt = new Date().toISOString();
  recordScreenAction(event, 'display');
  saveDb();
  io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));
  emitUsageStats(event.id);
  res.json({ ok: true, displayState: event.displayState, previousState: event.displayStatePrevious || null });
});

app.post('/api/events/:id/display/restore-last', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
  if (!requireEventPermission(req, res, 'main_screen')) return;
  ensureEventUiState(event);
  if (!event.displayStatePrevious) {
    return res.status(400).json({ ok: false, error: 'Nu exista o stare anterioara pentru restore.' });
  }
  const currentSnapshot = cloneDisplaySnapshot(event);
  const previousSnapshot = event.displayStatePrevious;
  applyDisplaySnapshot(event, previousSnapshot);
  event.displayStatePrevious = currentSnapshot;
  recordScreenAction(event, 'display');
  saveDb();
  io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));
  emitUsageStats(event.id);
  res.json({ ok: true, displayState: event.displayState, previousState: event.displayStatePrevious || null, event: normalizeEventForAccess(req, event) });
});

app.post('/api/events/:id/display/shortcut', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
  if (!requireEventPermission(req, res, 'main_screen')) return;
  ensureEventUiState(event);

  const shortcutKey = String(req.body.shortcut || '').trim().toLowerCase();
  const shortcut = DISPLAY_SHORTCUTS[shortcutKey];
  if (!shortcut) {
    return res.status(400).json({ ok: false, error: 'Shortcut inexistent.' });
  }

  let mode = shortcut.mode;
  if (mode === 'song' && !event.songState?.activeBlock && !event.songState?.translations) {
    mode = 'auto';
  }
  if (mode === 'manual' && !event.displayState?.manualSource) {
    mode = 'auto';
  }

  rememberDisplayState(event);
  event.displayState.mode = mode;
  event.displayState.blackScreen = false;
  event.displayState.theme = shortcut.theme;
  event.displayState.language = event.targetLangs.includes(String(req.body.language || '').trim())
    ? String(req.body.language || '').trim()
    : (event.displayState.language || event.targetLangs[0] || 'no');
  event.displayState.backgroundPreset = shortcut.backgroundPreset;
  event.displayState.customBackground = shortcut.customBackground;
  event.displayState.showClock = !!shortcut.showClock;
  event.displayState.clockPosition = shortcut.clockPosition;
  event.displayState.textSize = shortcut.textSize;
  event.displayState.screenStyle = shortcut.screenStyle;
  event.displayState.sceneLabel = shortcut.label;
  event.displayState.updatedAt = new Date().toISOString();
  recordScreenAction(event, 'display');
  saveDb();

  io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));
  emitUsageStats(event.id);
  res.json({ ok: true, shortcut: shortcut.label, displayState: event.displayState, previousState: event.displayStatePrevious || null, event: normalizeEventForAccess(req, event) });
});

app.get('/api/events/:id/display-presets', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
  if (!requireEventPermission(req, res, 'main_screen')) return;
  ensureEventUiState(event);
  res.json({ ok: true, presets: event.displayPresets });
});

app.post('/api/events/:id/display-presets', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventAdmin(req, res, event)) return;
  ensureEventUiState(event);

  const preset = normalizeDisplayPreset(req.body || {});
  if (!preset) {
    return res.status(400).json({ ok: false, error: 'Numele presetului lipseste.' });
  }
  if (!event.targetLangs.includes(preset.language)) {
    preset.language = event.targetLangs[0] || 'no';
  }

  const existingIndex = event.displayPresets.findIndex((item) => String(item.name || '').toLowerCase() === preset.name.toLowerCase());
  if (existingIndex >= 0) {
    preset.id = event.displayPresets[existingIndex].id;
    event.displayPresets[existingIndex] = preset;
  } else {
    event.displayPresets.unshift(preset);
  }
  if (event.displayPresets.length > 12) {
    event.displayPresets = event.displayPresets.slice(0, 12);
  }
  saveDb();
  io.to(`event:${event.id}:admins`).emit('display_presets_updated', { presets: event.displayPresets });
  res.json({ ok: true, presets: event.displayPresets });
});

app.post('/api/events/:id/display-presets/:presetId/apply', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
  if (!requireEventPermission(req, res, 'main_screen')) return;
  ensureEventUiState(event);

  const preset = event.displayPresets.find((item) => item.id === req.params.presetId);
  if (!preset) {
    return res.status(404).json({ ok: false, error: 'Preset inexistent.' });
  }
  if (preset.mode === 'song' && !event.songState?.activeBlock && !event.songState?.translations) {
    return res.status(400).json({ ok: false, error: 'Presetul Song are nevoie de continut activ in Song.' });
  }

  rememberDisplayState(event);
  event.displayState.mode = preset.mode;
  event.displayState.blackScreen = false;
  event.displayState.theme = preset.theme;
  {
    const allowedDisplayLanguages = getDisplayLanguageChoices(event, preset.mode);
    event.displayState.language = allowedDisplayLanguages.includes(preset.language) ? preset.language : (allowedDisplayLanguages[0] || event.targetLangs[0] || 'no');
  }
  event.displayState.backgroundPreset = preset.backgroundPreset;
  event.displayState.customBackground = preset.customBackground;
  event.displayState.showClock = !!preset.showClock;
  event.displayState.clockPosition = preset.clockPosition;
  event.displayState.textSize = preset.textSize;
  event.displayState.screenStyle = preset.screenStyle;
  event.displayState.sceneLabel = preset.name;
  event.displayState.updatedAt = new Date().toISOString();
  recordScreenAction(event, 'display');
  saveDb();
  io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));
  emitUsageStats(event.id);
  res.json({ ok: true, displayState: event.displayState, previousState: event.displayStatePrevious || null, presets: event.displayPresets });
});

app.delete('/api/events/:id/display-presets/:presetId', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventAdmin(req, res, event)) return;
  ensureEventUiState(event);
  event.displayPresets = event.displayPresets.filter((item) => item.id !== req.params.presetId);
  saveDb();
  io.to(`event:${event.id}:admins`).emit('display_presets_updated', { presets: event.displayPresets });
  res.json({ ok: true, presets: event.displayPresets });
});

app.post('/api/events/:id/display/blank', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
  if (!requireEventPermission(req, res, 'main_screen')) return;
  ensureEventUiState(event);
  rememberDisplayState(event);
  event.displayState.blackScreen = true;
  event.displayState.sceneLabel = 'Black screen';
  event.displayState.updatedAt = new Date().toISOString();
  recordScreenAction(event, 'display');
  saveDb();
  io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));
  emitUsageStats(event.id);
  res.json({ ok: true, event: normalizeEventForAccess(req, event), previousState: event.displayStatePrevious || null });
});

app.post('/api/events/:id/display/manual', async (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
  if (!requireEventPermission(req, res, 'main_screen')) return;

  ensureEventUiState(event);

  const text = sanitizeStructuredText(req.body.text || '');
  const title = String(req.body.title || '').trim();
  const sourceLang = String(req.body.sourceLang || event.sourceLang || 'ro').trim() || 'ro';

  if (!text) {
    return res.status(400).json({ ok: false, error: 'Text lipsă.' });
  }

  try {
    const translations = await buildTranslationsForAllTargets(text, event, sourceLang);

    const entry = {
      id: randomUUID(),
      sourceLang,
      original: text,
      translations,
      createdAt: new Date().toISOString(),
      edited: false,
      manual: true,
      title: title || ''
    };

    event.transcripts.push(entry);
    if (event.transcripts.length > 300) {
      event.transcripts = event.transcripts.slice(-300);
    }

    rememberDisplayState(event);
    event.displayState = {
      ...event.displayState,
      mode: 'manual',
      blackScreen: false,
      sceneLabel: '',
      manualSource: text,
      manualSourceLang: sourceLang,
      manualTranslations: translations,
      updatedAt: new Date().toISOString()
    };

    event.mode = 'live';
    pushSongHistory(event, { title: title || 'Pinned text', kind: 'manual', source: text, translations });

    recordScreenAction(event, 'manual');
    saveDb();

    io.to(`event:${event.id}`).emit('transcript_entry', entry);
    io.to(`event:${event.id}`).emit('display_manual_update', buildDisplayPayload(event));
    io.to(`event:${event.id}`).emit('song_history_updated', {
      songHistory: event.songHistory
    });
    emitUsageStats(event.id);

    res.json({ ok: true, displayState: event.displayState, previousState: event.displayStatePrevious || null, songHistory: event.songHistory });
  } catch (err) {
    console.error('display manual error:', err);
    res.status(500).json({ ok: false, error: 'Nu am putut trimite textul pe ecran.' });
  }
});

app.post('/api/events/:id/song-library', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventAdmin(req, res, event)) return;

  ensureEventUiState(event);

  const title = String(req.body.title || '').trim();
  const text = sanitizeStructuredText(req.body.text || '');
  const labels = Array.isArray(req.body.labels) ? req.body.labels : [];
  const sourceLang = String(req.body.sourceLang || event.sourceLang || 'ro').trim() || 'ro';

  if (!title || !text) {
    return res.status(400).json({ ok: false, error: 'Titlu sau text lipsă.' });
  }

  upsertLibraryItem(event.songLibrary, { title, text, labels, sourceLang }, 100);

  saveDb();
  res.json({ ok: true, songLibrary: event.songLibrary });
});

app.get('/api/events/:id/song-library', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });

  ensureEventUiState(event);
  res.json({ ok: true, songLibrary: event.songLibrary });
});

app.delete('/api/events/:id/song-library/:songId', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventAdmin(req, res, event)) return;

  ensureEventUiState(event);
  event.songLibrary = event.songLibrary.filter((item) => item.id !== req.params.songId);
  saveDb();

  res.json({ ok: true, songLibrary: event.songLibrary });
});

app.get('/api/global-song-library', (req, res) => {
  res.json({ ok: true, globalSongLibrary: Array.isArray(db.globalSongLibrary) ? db.globalSongLibrary : [] });
});

app.post('/api/global-song-library', (req, res) => {
  if (!requireGlobalLibraryAdmin(req, res)) return;
  const title = String(req.body.title || '').trim();
  const text = sanitizeStructuredText(req.body.text || '');
  const labels = Array.isArray(req.body.labels) ? req.body.labels : [];
  const sourceLang = String(req.body.sourceLang || 'ro').trim() || 'ro';
  if (!title || !text) {
    return res.status(400).json({ ok: false, error: 'Titlu sau text lipsa.' });
  }
  upsertLibraryItem(db.globalSongLibrary, { title, text, labels, sourceLang }, 500);
  saveDb();
  res.json({ ok: true, globalSongLibrary: db.globalSongLibrary });
});

app.get('/api/pinned-text-library', (req, res) => {
  res.json({ ok: true, pinnedTextLibrary: Array.isArray(db.pinnedTextLibrary) ? db.pinnedTextLibrary : [] });
});

app.post('/api/pinned-text-library', (req, res) => {
  if (!requireGlobalLibraryAdmin(req, res)) return;
  const title = String(req.body.title || '').trim();
  const text = sanitizeStructuredText(req.body.text || '');
  const sourceLang = String(req.body.sourceLang || 'ro').trim() || 'ro';
  if (!title || !text) {
    return res.status(400).json({ ok: false, error: 'Titlu sau text lipsa.' });
  }
  upsertLibraryItem(db.pinnedTextLibrary, { title, text, labels: [], sourceLang }, 300);
  saveDb();
  res.json({ ok: true, pinnedTextLibrary: db.pinnedTextLibrary });
});

app.delete('/api/pinned-text-library/:itemId', (req, res) => {
  if (!requireGlobalLibraryAdmin(req, res)) return;
  db.pinnedTextLibrary = (db.pinnedTextLibrary || []).filter((item) => item.id !== req.params.itemId);
  saveDb();
  res.json({ ok: true, pinnedTextLibrary: db.pinnedTextLibrary });
});

app.delete('/api/global-song-library/:songId', (req, res) => {
  if (!requireGlobalLibraryAdmin(req, res)) return;
  db.globalSongLibrary = (db.globalSongLibrary || []).filter((item) => item.id !== req.params.songId);
  saveDb();
  res.json({ ok: true, globalSongLibrary: db.globalSongLibrary });
});

app.get('/api/events/:id/global-song-library', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });

  res.json({ ok: true, globalSongLibrary: Array.isArray(db.globalSongLibrary) ? db.globalSongLibrary : [] });
});

app.post('/api/events/:id/global-song-library', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
  if (!requireEventPermission(req, res, 'song')) return;

  const title = String(req.body.title || '').trim();
  const text = sanitizeStructuredText(req.body.text || '');
  const labels = Array.isArray(req.body.labels) ? req.body.labels : [];
  const sourceLang = String(req.body.sourceLang || event.sourceLang || 'ro').trim() || 'ro';

  if (!title || !text) {
    return res.status(400).json({ ok: false, error: 'Titlu sau text lipsa.' });
  }

  upsertLibraryItem(db.globalSongLibrary, { title, text, labels, sourceLang }, 500);
  saveDb();
  res.json({ ok: true, globalSongLibrary: db.globalSongLibrary });
});

app.post('/api/events/:id/global-song-library/:songId/add-to-event', (req, res) => {
  const adminEvent = db.events[req.params.id];
  if (!adminEvent) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventAdmin(req, res, adminEvent)) return;

  const targetEventId = String(req.body?.targetEventId || req.params.id || '').trim();
  const event = db.events[targetEventId];
  if (!event) {
    return res.status(404).json({ ok: false, error: 'Evenimentul selectat nu exista.' });
  }

  ensureEventUiState(event);
  const item = (db.globalSongLibrary || []).find((entry) => entry.id === req.params.songId);
  if (!item) {
    return res.status(404).json({ ok: false, error: 'Cantarea nu exista in biblioteca generala.' });
  }

  upsertLibraryItem(event.songLibrary, { title: item.title, text: item.text, labels: item.labels || [], sourceLang: item.sourceLang || event.sourceLang || 'ro' }, 100);
  saveDb();
  res.json({ ok: true, targetEvent: summarizeEvent(event), songLibrary: event.songLibrary, globalSongLibrary: db.globalSongLibrary });
});

app.delete('/api/events/:id/global-song-library/:songId', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventAdmin(req, res, event)) return;

  db.globalSongLibrary = (db.globalSongLibrary || []).filter((item) => item.id !== req.params.songId);
  saveDb();
  res.json({ ok: true, globalSongLibrary: db.globalSongLibrary });
});

app.post('/api/events/:id/transcribe', upload.single('audio'), async (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  const access = resolveEventAccessFromCode(event, String(req.body.code || '').trim());
  if (access.role !== 'admin') return res.status(403).json({ ok: false, error: 'Cod Admin invalid.' });
  if (!client) return res.status(400).json({ ok: false, error: 'OpenAI nu este configurat.' });
  if (!req.file || !req.file.buffer?.length) return res.status(400).json({ ok: false, error: 'Audio lipsă.' });

  const mimeType = String(req.file.mimetype || 'audio/webm');
  const ext = mimeType.includes('wav') ? 'wav' : mimeType.includes('mp4') || mimeType.includes('m4a') ? 'm4a' : 'webm';
  const tempPath = path.join(os.tmpdir(), `sanctuary-voice-${randomUUID()}.${ext}`);

  try {
    fs.writeFileSync(tempPath, req.file.buffer);
    const rawTranscript = await transcribeAudioFile(tempPath, event);
    const transcriptText = typeof rawTranscript === 'string' ? rawTranscript : rawTranscript?.text;
    const transcriptSourceLang = typeof rawTranscript === 'object' && rawTranscript?.sourceLang
      ? rawTranscript.sourceLang
      : (event.liveSourceLang || event.sourceLang || 'ro');
    const transcript = applySourceCorrections(sanitizeTranscriptText(transcriptText), getSourceCorrections(event));
    if (!transcript) return res.json({ ok: true, skipped: true });
    queueSpeechText(event.id, transcript, transcriptSourceLang);
    return res.json({ ok: true, text: transcript, sourceLang: transcriptSourceLang, buffered: true });
  } catch (err) {
    console.error('transcribe error:', err?.message || err);
    return res.status(500).json({ ok: false, error: 'Nu am putut transcrie audio.' });
  } finally {
    try { fs.unlinkSync(tempPath); } catch (_) {}
  }
});

io.on('connection', (socket) => {
  socket.on('join_event', ({ eventId, role, code, language, participantId }) => {
    const event = db.events[eventId];
    if (!event) return socket.emit('join_error', { message: 'Evenimentul nu există.' });
    const access = resolveEventAccessFromCode(event, code);
    if (role === 'admin' && access.role !== 'admin') return socket.emit('join_error', { message: 'Cod Admin invalid.' });
    if (role === 'screen' && !['admin', 'screen'].includes(access.role)) return socket.emit('join_error', { message: 'Cod operator invalid.' });
    if (role === 'participant_preview' && !['admin', 'screen'].includes(access.role)) return socket.emit('join_error', { message: 'Cod operator invalid.' });
    if ((role || 'participant') === 'participant' && db.activeEventId !== eventId) {
      return socket.emit('join_error', { message: 'Evenimentul nu este live inca.' });
    }

    cleanupSocketPresence(socket);
    socket.data.eventId = eventId;
    socket.data.role = role || 'participant';
    socket.data.language = language || event.targetLangs[0] || 'no';
    socket.data.participantId = participantId || '';
    socket.data.permissions = socket.data.role === 'admin' ? ['main_screen', 'song', 'glossary'] : (access.permissions || []);

    socket.join(`event:${eventId}`);
    if (socket.data.role === 'admin') socket.join(`event:${eventId}:admins`);
    if (socket.data.role === 'screen') socket.join(`event:${eventId}:screens`);
    if (socket.data.role === 'participant' || socket.data.role === 'participant_preview') socket.join(`event:${eventId}:lang:${socket.data.language}`);

    if (socket.data.role === 'participant' && socket.data.participantId) {
      registerParticipantSocket(eventId, socket.data.participantId, socket.data.language, socket.id);
      recordParticipantJoin(event, socket.data.participantId, socket.data.language);
      saveDb();
      emitParticipantStats(eventId);
    }
    if (socket.data.role === 'admin' || socket.data.role === 'screen') {
      recordOperatorJoin(event, socket.data.role);
      saveDb();
      emitParticipantStats(eventId);
    }

    socket.emit('joined_event', {
      ok: true,
      role: socket.data.role,
      event: normalizeEvent(event, {
        includeSecrets: socket.data.role === 'admin',
        includeControlData: ['admin', 'screen'].includes(socket.data.role)
      }),
      access: socket.data.role === 'screen'
        ? { permissions: access.permissions || [], operator: normalizeSocketOperator(access.operator) }
        : null,
      languageNames: LANGUAGE_NAMES_RO
    });
  });

  socket.on('participant_language', ({ eventId, language }) => {
    const targetEventId = eventId || socket.data.eventId;
    const oldLanguage = socket.data.language;
    if (oldLanguage && targetEventId) socket.leave(`event:${targetEventId}:lang:${oldLanguage}`);
    socket.data.language = language;
    if (targetEventId) socket.join(`event:${targetEventId}:lang:${language}`);
    if (socket.data.role === 'participant' && socket.data.participantId && targetEventId) {
      registerParticipantSocket(targetEventId, socket.data.participantId, language, socket.id);
      emitParticipantStats(targetEventId);
    }
  });

  socket.on('submit_text', async ({ eventId, text }) => {
    const event = db.events[eventId];
    if (!event) return socket.emit('server_error', { message: 'Eveniment inexistent.' });
    if (!socketCanControlEvent(socket, eventId, 'main_screen')) {
      return socket.emit('server_error', { message: 'Nu ai permisiune pentru live text.' });
    }
    const cleanText = String(text || '').trim();
    if (!cleanText) return;
    try {
      event.mode = 'live';
      await processText(event, cleanText);
    } catch (err) {
      console.error('submit_text error:', err);
      recordServerError(event, 'Live submit translation failed.');
      saveDb();
      emitUsageStats(eventId);
      socket.emit('server_error', { message: 'Eroare la traducere.' });
    }
  });

  socket.on('admin_update_source', async ({ eventId, entryId, sourceText }) => {
    const event = db.events[eventId];
    if (!event) return;
    if (!socketCanControlEvent(socket, eventId, 'main_screen')) return;
    const entry = event.transcripts.find((x) => x.id === entryId);
    if (!entry) return;
    const cleanSource = String(sourceText || '').trim();
    if (!cleanSource) return;
    entry.sourceLang = event.sourceLang || 'ro';
    entry.original = cleanSource;
    entry.edited = true;
    io.to(`event:${eventId}`).emit('entry_refreshing', { entryId });
    try {
      await retranslateEntry(event, entry);
      recordTranscriptRefresh(event);
      saveDb();
      io.to(`event:${eventId}`).emit('transcript_source_updated', {
        entryId,
        sourceLang: entry.sourceLang,
        original: entry.original,
        translations: entry.translations
      });

      ensureEventUiState(event);
      emitUsageStats(eventId);
    } catch (err) {
      console.error('admin_update_source error:', err);
      recordServerError(event, 'Source retranslation failed.');
      io.to(`event:${eventId}`).emit('entry_refresh_failed', { entryId });
      saveDb();
      emitUsageStats(eventId);
    }
  });

  socket.on('set_audio_state', ({ eventId, audioMuted, audioVolume }) => {
    const event = db.events[eventId];
    if (!event || !socketCanControlEvent(socket, eventId, 'main_screen')) return;
    if (typeof audioMuted === 'boolean') event.audioMuted = audioMuted;
    if (typeof audioVolume === 'number') event.audioVolume = Math.max(0, Math.min(100, audioVolume));
    saveDb();
    io.to(`event:${eventId}`).emit('audio_state', { audioMuted: event.audioMuted, audioVolume: event.audioVolume });
  });

  socket.on('azure_audio_start', ({ eventId }) => {
    const event = db.events[eventId];
    if (!event || !socketCanControlEvent(socket, eventId, 'main_screen')) {
      return socket.emit('server_error', { message: 'Nu ai permisiune pentru Azure Speech.' });
    }
    if (getActiveSpeechProvider() !== 'azure_sdk') {
      return socket.emit('server_error', { message: 'Azure Speech nu este activ.' });
    }
    event.mode = 'live';
    ensureEventUiState(event);
    event.latestDisplayEntry = null;
    event.displayState.mode = 'auto';
    event.displayState.blackScreen = false;
    event.displayState.sceneLabel = '';
    saveDb();
    io.to(`event:${event.id}`).emit('mode_changed', { mode: 'live' });
    io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));
    startAzureSpeechSession(socket, event);
  });

  socket.on('azure_audio_chunk', ({ eventId, audio }) => {
    const session = azureSpeechSessions.get(socket.id);
    if (!session || session.eventId !== eventId || !socketCanControlEvent(socket, eventId, 'main_screen')) return;
    const buffer = Buffer.from(audio || []);
    if (!buffer.length) return;
    try {
      session.pushStream.write(buffer);
    } catch (err) {
      console.error('azure audio chunk error:', err?.message || err);
      socket.emit('server_error', { message: 'Azure Speech audio stream failed.' });
      closeAzureSpeechSession(socket.id);
    }
  });

  socket.on('azure_audio_stop', ({ eventId }) => {
    const session = azureSpeechSessions.get(socket.id);
    if (session?.eventId === eventId) closeAzureSpeechSession(socket.id);
  });

  socket.on('disconnect', () => {
    closeAzureSpeechSession(socket.id);
    cleanupSocketPresence(socket);
  });
});

server.listen(PORT, () => {
  console.log(`Sanctuary Voice running on ${PORT}`);
});
