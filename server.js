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

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'sessions.json');

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
  hu: 'Hungarian'
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
  hu: 'Maghiară'
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
  hu: 'Maghiară'
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function defaultSongState() {
  return {
    title: '',
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
    theme: 'dark',
    language: 'no',
    backgroundPreset: 'none',
    customBackground: '',
    showClock: false,
    clockPosition: 'top-right',
    textSize: 'large',
    screenStyle: 'focus',
    manualSource: '',
    manualTranslations: {},
    updatedAt: null
  };
}

function defaultSongLibrary() {
  return [];
}

function defaultGlobalSongLibrary() {
  return [];
}

function defaultSongHistory() {
  return [];
}

function ensureEventUiState(event) {
  if (!event.displayState || typeof event.displayState !== 'object') {
    event.displayState = defaultDisplayState();
  }
  if (!['dark', 'light'].includes(event.displayState.theme)) {
    event.displayState.theme = 'dark';
  }
  if (!Array.isArray(event.targetLangs) || !event.targetLangs.length) {
    event.targetLangs = ['no', 'en'];
  }
  if (!event.displayState.language || !event.targetLangs.includes(event.displayState.language)) {
    event.displayState.language = event.targetLangs[0] || 'no';
  }
  if (typeof event.displayState.customBackground !== 'string') {
    event.displayState.customBackground = '';
  }
  if (!['none', 'warm', 'sanctuary', 'soft-light'].includes(event.displayState.backgroundPreset)) {
    event.displayState.backgroundPreset = 'none';
  }
  event.displayState.showClock = !!event.displayState.showClock;
  if (!['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(event.displayState.clockPosition)) {
    event.displayState.clockPosition = 'top-right';
  }
  if (!['compact', 'large', 'xlarge'].includes(event.displayState.textSize)) {
    event.displayState.textSize = 'large';
  }
  if (!['focus', 'wide'].includes(event.displayState.screenStyle)) {
    event.displayState.screenStyle = 'focus';
  }
  if (!Array.isArray(event.songLibrary)) {
    event.songLibrary = defaultSongLibrary();
  }
  if (!Array.isArray(event.songHistory)) {
    event.songHistory = defaultSongHistory();
  }
  if (!event.songState || typeof event.songState !== 'object') {
    event.songState = defaultSongState();
  }
  if (!Array.isArray(event.songState.blockLabels)) {
    event.songState.blockLabels = [];
  }
}

function defaultDb() {
  return { events: {}, globalMemory: {}, globalSongLibrary: defaultGlobalSongLibrary(), activeEventId: null };
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
  if (countWords(clean) <= 12 && clean.length <= 120) return [clean];

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
      if (current.length >= 10) {
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
    if (countWords(candidate) <= 12 && candidate.length <= 120) {
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
    if (currentChunk.length >= 2 || nextWords > 16) {
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

function shouldFlushBufferedText(text) {
  const clean = sanitizeTranscriptText(text);
  if (!clean) return false;
  const words = countWords(clean);
  const last = getLastWord(clean);
  if (/[.!?]\s*$/.test(clean) && words >= 2) return true;
  if (/[,;:]\s*$/.test(clean) && words >= 3) return true;
  if (words >= 6 && !BUFFER_CONNECTORS.has(last)) return true;
  if (words >= 9) return true;
  return false;
}

function normalizeEvent(event) {
  return {
    id: event.id,
    name: event.name,
    sourceLang: event.sourceLang || 'ro',
    targetLangs: Array.isArray(event.targetLangs) ? event.targetLangs : ['no', 'en'],
    speed: event.speed || 'balanced',
    adminCode: event.adminCode,
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
    displayState: event.displayState || defaultDisplayState(),
    songLibrary: Array.isArray(event.songLibrary) ? event.songLibrary : [],
    songHistory: Array.isArray(event.songHistory) ? event.songHistory : []
  };
}

function buildDisplayPayload(event) {
  ensureEventUiState(event);
  return {
    mode: event.displayState.mode,
    theme: event.displayState.theme,
    language: event.displayState.language,
    backgroundPreset: event.displayState.backgroundPreset,
    customBackground: event.displayState.customBackground,
    showClock: event.displayState.showClock,
    clockPosition: event.displayState.clockPosition,
    textSize: event.displayState.textSize,
    screenStyle: event.displayState.screenStyle,
    manualSource: event.displayState.manualSource,
    manualTranslations: event.displayState.manualTranslations,
    updatedAt: event.displayState.updatedAt
  };
}

function normalizeLibraryTitle(title) {
  return String(title || '').trim().toLowerCase();
}

function upsertLibraryItem(list, { title, text, labels }, maxItems = 100) {
  const safeTitle = String(title || '').trim();
  const safeText = sanitizeStructuredText(text || '');
  const blocks = splitSongBlocks(safeText);
  const safeLabels = buildBlockLabels(blocks, labels || []);
  const normalizedTitle = normalizeLibraryTitle(safeTitle);
  const existingIndex = list.findIndex((item) => normalizeLibraryTitle(item.title) === normalizedTitle);
  const payload = {
    id: existingIndex >= 0 ? list[existingIndex].id : randomUUID(),
    title: safeTitle,
    text: safeText,
    labels: safeLabels,
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
  const suppliedCode =
    String(req.body?.code || req.query?.code || req.headers['x-admin-code'] || '').trim();

  if (String(event.adminCode || '') !== suppliedCode) {
    res.status(403).json({ ok: false, error: 'Cod Admin invalid.' });
    return false;
  }

  return true;
}

async function createEvent({ name, speed, sourceLang, targetLangs, baseUrl, scheduledAt }) {
  const id = randomUUID();
  const adminCode = `BPMS-ADMIN-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const participantLink = `${baseUrl}/participant?event=${id}`;
  const translateLink = `${baseUrl}/translate?event=${id}`;
  const songLink = `${baseUrl}/song?event=${id}`;
  const qrCodeDataUrl = await QRCode.toDataURL(participantLink);

  const event = {
    id,
    name: name || 'Eveniment nou',
    sourceLang: sourceLang || 'ro',
    targetLangs: targetLangs?.length ? targetLangs : ['no', 'en'],
    speed: speed || 'balanced',
    scheduledAt: scheduledAt || null,
    adminCode,
    participantLink,
    translateLink,
    songLink,
    qrCodeDataUrl,
    transcripts: [],
    glossary: {},
    sourceCorrections: {},
    audioMuted: false,
    audioVolume: 70,
    createdAt: new Date().toISOString(),
    lastTranscriptNorm: '',
    mode: 'live',
    songState: defaultSongState(),
    displayState: { ...defaultDisplayState(), language: (targetLangs?.length ? targetLangs[0] : 'no') },
    songLibrary: defaultSongLibrary(),
    songHistory: defaultSongHistory()
  };

  db.events[id] = event;
  db.activeEventId = id;
  saveDb();
  setImmediate(() => io.emit('active_event_changed', { eventId: id }));
  return normalizeEvent(event);
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


async function buildTranslationsForAllTargets(text, event) {
  const clean = sanitizeStructuredText(text);
  if (!clean) return {};

  const blocks = clean
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);

  const translationPairs = await Promise.all(
    (event.targetLangs || []).map(async (lang) => {
      if (!blocks.length) return [lang, ''];
      const translatedBlocks = await Promise.all(blocks.map((block) => translateText(block, lang, event)));
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

async function translateText(text, langCode, event) {
  const glossary = getGlossaryForLang(langCode, event);
  const cleanText = sanitizeStructuredText(text);
  if (!cleanText) return '';
  if (!client) return `[${langCode}] ${applyGlossary(cleanText, glossary)}`;
  try {
    const response = await client.responses.create({
      model: OPENAI_MODEL,
      input: [
        { role: 'system', content: buildPrompt(LANGUAGES[event.sourceLang] || event.sourceLang, LANGUAGES[langCode] || langCode, event.speed, glossary) },
        { role: 'user', content: cleanText }
      ]
    });
    const translated = sanitizeStructuredText(response.output_text || '');
    if (translated) return translated;
    return applyGlossary(cleanText, glossary);
  } catch (err) {
    console.error(`translate error ${langCode}:`, err?.message || err);
    return `[${langCode}] ${applyGlossary(cleanText, glossary)}`;
  }
}

async function transcribeAudioFile(filePath, event) {
  if (!client) return '';
  const request = {
    file: fs.createReadStream(filePath),
    model: OPENAI_TRANSCRIBE_MODEL,
    response_format: 'json',
    prompt:
      event.sourceLang === 'no'
        ? 'The audio is a Christian sermon in Norwegian. Keep the transcript in Norwegian. Use natural punctuation. Common terms may include Jesus, Kristus, Herren, Den Hellige Ånd, menighet, evangeliet, apostel, nåde, kjærlighet, synd, frelse.'
        : 'The audio is a live sermon. Keep names and punctuation natural.'
  };
  if (event.sourceLang !== 'no') request.language = event.sourceLang || 'ro';
  const result = await client.audio.transcriptions.create(request);
  return String(result?.text || '').trim();
}

async function retranslateEntry(event, entry) {
  const translationPairs = await Promise.all(
    event.targetLangs.map(async (lang) => [lang, await translateText(entry.original, lang, event)])
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

async function publishNewChunk(event, chunk) {
  const cleanChunk = sanitizeTranscriptText(chunk);
  if (!cleanChunk) return null;
  const chunkNormalized = normalizeChunkText(cleanChunk);
  if (!chunkNormalized || chunkNormalized.length < 2) return null;
  const previousEntry = event.transcripts[event.transcripts.length - 1];

  if (previousEntry && previousEntry.participantDirty) {
    previousEntry.participantDirty = false;
    io.to(`event:${event.id}`).emit('transcript_source_updated', {
      entryId: previousEntry.id,
      sourceLang: previousEntry.sourceLang,
      original: previousEntry.original,
      translations: previousEntry.translations
    });
  }

  const translationPairs = await Promise.all(
    event.targetLangs.map(async (lang) => [lang, await translateText(cleanChunk, lang, event)])
  );

  const entry = {
    id: randomUUID(),
    sourceLang: event.sourceLang,
    original: cleanChunk,
    translations: Object.fromEntries(translationPairs),
    createdAt: new Date().toISOString(),
    edited: false
  };

  event.lastTranscriptNorm = chunkNormalized;
  event.transcripts.push(entry);
  if (event.transcripts.length > 300) event.transcripts = event.transcripts.slice(-300);
  ensureEventUiState(event);
  saveDb();
  io.to(`event:${event.id}`).emit('transcript_entry', entry);
  if (event.displayState?.mode === 'auto') {
    io.to(`event:${event.id}`).emit('display_live_entry', entry);
  }
  return entry;
}

async function processText(event, cleanText, { force = false } = {}) {
  const normalized = normalizeChunkText(cleanText);
  if (!normalized || normalized.length < 2) return null;
  if (!force && normalized === event.lastTranscriptNorm) return null;

  const lastEntry = event.transcripts[event.transcripts.length - 1];
  if (shouldAppendToPreviousEntry(lastEntry, cleanText)) {
    const combinedText = sanitizeTranscriptText(`${lastEntry.original} ${cleanText}`);
    const chunks = splitIntoDisplayChunks(combinedText);
    const firstChunk = chunks.shift() || combinedText;
    lastEntry.sourceLang = event.sourceLang;
    lastEntry.original = firstChunk;
    await retranslateEntry(event, lastEntry);
    event.lastTranscriptNorm = normalizeChunkText(firstChunk);
    lastEntry.participantDirty = false;
    saveDb();

    io.to(`event:${event.id}:admins`).emit('transcript_source_updated', {
      entryId: lastEntry.id,
      sourceLang: lastEntry.sourceLang,
      original: lastEntry.original,
      translations: lastEntry.translations
    });
    if (event.displayState?.mode === 'auto') {
      io.to(`event:${event.id}`).emit('display_live_entry', lastEntry);
    }
    io.to(`event:${event.id}`).emit('transcript_source_updated', {
      entryId: lastEntry.id,
      sourceLang: lastEntry.sourceLang,
      original: lastEntry.original,
      translations: lastEntry.translations
    });

    let lastCreatedEntry = lastEntry;
    for (const extraChunk of chunks) {
      const created = await publishNewChunk(event, extraChunk);
      if (created) lastCreatedEntry = created;
    }
    return lastCreatedEntry;
  }

  const chunks = splitIntoDisplayChunks(cleanText);
  let lastCreatedEntry = null;
  for (const chunk of chunks) {
    const created = await publishNewChunk(event, chunk);
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

  if (!force) {
    if (startsLikeContinuation(text) && words < 10) {
      buffered.timer = setTimeout(() => flushSpeechBuffer(eventId, true).catch(console.error), 700);
      speechBuffers.set(eventId, buffered);
      return null;
    }
    if (BUFFER_CONNECTORS.has(last) && words < 10) {
      buffered.timer = setTimeout(() => flushSpeechBuffer(eventId, true).catch(console.error), 700);
      speechBuffers.set(eventId, buffered);
      return null;
    }
  }

  speechBuffers.delete(eventId);
  io.to(`event:${eventId}:admins`).emit('partial_transcript', { text: '' });
  return processText(event, text, { force: true });
}

function queueSpeechText(eventId, text) {
  const clean = sanitizeTranscriptText(text);
  if (!clean) return;

  const prev = speechBuffers.get(eventId) || { text: '', timer: null, startedAt: Date.now() };
  const merged = mergeTranscriptText(prev.text, clean);
  if (prev.timer) clearTimeout(prev.timer);

  const next = { text: merged, timer: null, startedAt: prev.startedAt || Date.now() };
  speechBuffers.set(eventId, next);
  io.to(`event:${eventId}:admins`).emit('partial_transcript', { text: merged });

  const ageMs = Date.now() - next.startedAt;
  const words = countWords(merged);
  if (shouldFlushBufferedText(merged)) {
    flushSpeechBuffer(eventId, false).catch(console.error);
    return;
  }
  if (ageMs > 2800 || words >= 10) {
    flushSpeechBuffer(eventId, true).catch(console.error);
    return;
  }
  next.timer = setTimeout(() => flushSpeechBuffer(eventId, true).catch(console.error), 700);
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

function emitParticipantStats(eventId) {
  if (!eventId) return;
  io.to(`event:${eventId}:admins`).emit('participant_stats', buildParticipantStats(eventId));
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

function buildBlockLabels(blocks, labels = []) {
  return blocks.map((_, index) => {
    const provided = String(labels[index] || '').trim();
    return provided || `Verse ${index + 1}`;
  });
}

async function buildSongTranslations(event, blocks) {
  const allTranslations = [];
  for (const block of blocks) {
    const translationPairs = await Promise.all(
      event.targetLangs.map(async (lang) => [lang, await translateText(block, lang, event)])
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
  songState.updatedAt = new Date().toISOString();
  event.songState = songState;
  event.mode = 'song';
  return true;
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, openaiConfigured: !!OPENAI_API_KEY, model: OPENAI_MODEL, transcribeModel: OPENAI_TRANSCRIBE_MODEL });
});

app.get('/api/languages', (req, res) => {
  res.json({ ok: true, languages: LANGUAGE_NAMES_RO });
});

app.post('/api/events', async (req, res) => {
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
    res.json({ ok: true, event });
  } catch (err) {
    console.error('create event error:', err);
    res.status(500).json({ ok: false, error: 'Nu am putut crea evenimentul.' });
  }
});

app.get('/api/events/active', (req, res) => {
  const activeEventId = db.activeEventId;
  const event = activeEventId ? db.events[activeEventId] : null;
  if (!event) return res.status(404).json({ ok: false, error: 'Nu există eveniment activ.' });
  res.json({ ok: true, event: normalizeEvent(event), languageNames: LANGUAGE_NAMES_RO });
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
  res.json({ ok: true, event: normalizeEvent(event), languageNames: LANGUAGE_NAMES_RO });
});

app.post('/api/events/:id/settings', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventAdmin(req, res, event)) return;
  if (typeof req.body.speed === 'string' && req.body.speed.trim()) event.speed = req.body.speed.trim();
  saveDb();
  res.json({ ok: true, event: normalizeEvent(event) });
});

app.post('/api/events/:id/mode', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventAdmin(req, res, event)) return;
  const mode = String(req.body.mode || 'live').trim();
  if (!['live', 'song'].includes(mode)) return res.status(400).json({ ok: false, error: 'Mod invalid.' });
  event.mode = mode;
  saveDb();
  io.to(`event:${event.id}`).emit('mode_changed', { mode });
  res.json({ ok: true, event: normalizeEvent(event) });
});

app.post('/api/events/:id/activate', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventAdmin(req, res, event)) return;
  db.activeEventId = event.id;
  saveDb();
  io.emit('active_event_changed', { eventId: event.id });
  res.json({ ok: true, event: normalizeEvent(event) });
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
  res.json({ ok: true, event: normalizeEvent(event) });
});

app.post('/api/events/:id/song/load', async (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventAdmin(req, res, event)) return;
  const title = String(req.body.title || '').trim();
  const text = sanitizeStructuredText(req.body.text || '');
  const labels = Array.isArray(req.body.labels) ? req.body.labels : [];
  if (!text) return res.status(400).json({ ok: false, error: 'Text lipsă.' });
  try {
    const blocks = splitSongBlocks(text);
    const allTranslations = await buildSongTranslations(event, blocks);
    event.songState = {
      title,
      blocks,
      blockLabels: buildBlockLabels(blocks, labels),
      currentIndex: blocks.length ? 0 : -1,
      activeBlock: blocks[0] || null,
      translations: allTranslations[0] || {},
      allTranslations,
      updatedAt: new Date().toISOString()
    };
    event.mode = 'song';
    saveDb();
    io.to(`event:${event.id}`).emit('mode_changed', { mode: 'song' });
    io.to(`event:${event.id}`).emit('song_state', event.songState);
    res.json({ ok: true, songState: event.songState, event: normalizeEvent(event) });
  } catch (err) {
    console.error('song load error:', err);
    res.status(500).json({ ok: false, error: 'Nu am putut pregăti song mode.' });
  }
});

app.post('/api/events/:id/song/show/:index', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventAdmin(req, res, event)) return;
  const index = Number(req.params.index);
  if (!setSongIndex(event, index)) return res.status(400).json({ ok: false, error: 'Index invalid.' });
  saveDb();
  io.to(`event:${event.id}`).emit('song_state', event.songState);
  res.json({ ok: true, songState: event.songState });
});

app.post('/api/events/:id/song/labels', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventAdmin(req, res, event)) return;
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
  if (!requireEventAdmin(req, res, event)) return;
  const nextIndex = Number(event.songState?.currentIndex ?? -1) + 1;
  if (!setSongIndex(event, nextIndex)) return res.status(400).json({ ok: false, error: 'Nu mai există bloc următor.' });
  saveDb();
  io.to(`event:${event.id}`).emit('song_state', event.songState);
  res.json({ ok: true, songState: event.songState });
});

app.post('/api/events/:id/song/prev', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventAdmin(req, res, event)) return;
  const prevIndex = Number(event.songState?.currentIndex ?? 0) - 1;
  if (!setSongIndex(event, prevIndex)) return res.status(400).json({ ok: false, error: 'Nu mai există bloc anterior.' });
  saveDb();
  io.to(`event:${event.id}`).emit('song_state', event.songState);
  res.json({ ok: true, songState: event.songState });
});

app.post('/api/events/:id/song/clear', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventAdmin(req, res, event)) return;
  event.songState = defaultSongState();
  event.mode = 'live';
  ensureEventUiState(event);
  event.displayState.mode = 'manual';
  event.displayState.manualSource = '';
  event.displayState.manualTranslations = {};
  event.displayState.updatedAt = new Date().toISOString();
  saveDb();
  io.to(`event:${event.id}`).emit('song_clear');
  io.to(`event:${event.id}`).emit('mode_changed', { mode: 'live' });
  io.to(`event:${event.id}`).emit('display_manual_update', buildDisplayPayload(event));
  res.json({ ok: true, event: normalizeEvent(event) });
});


app.post('/api/events/:id/display/mode', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventAdmin(req, res, event)) return;

  ensureEventUiState(event);

  const mode = String(req.body.mode || '').trim().toLowerCase();
  if (!['auto', 'manual'].includes(mode)) {
    return res.status(400).json({ ok: false, error: 'Mod invalid.' });
  }

  event.displayState.mode = mode;
  event.displayState.updatedAt = new Date().toISOString();
  saveDb();

  io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));

  res.json({ ok: true, displayState: event.displayState });
});

app.post('/api/events/:id/display/theme', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventAdmin(req, res, event)) return;

  ensureEventUiState(event);
  const theme = String(req.body.theme || 'dark').trim();
  if (!['dark', 'light'].includes(theme)) {
    return res.status(400).json({ ok: false, error: 'Tema invalida.' });
  }

  event.displayState.theme = theme;
  event.displayState.updatedAt = new Date().toISOString();
  saveDb();

  io.to(`event:${event.id}`).emit('display_theme_changed', {
    theme: event.displayState.theme,
    updatedAt: event.displayState.updatedAt
  });
  io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));

  res.json({ ok: true, displayState: event.displayState });
});

app.post('/api/events/:id/display/language', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventAdmin(req, res, event)) return;
  ensureEventUiState(event);
  const language = String(req.body.language || '').trim();
  if (!event.targetLangs.includes(language)) {
    return res.status(400).json({ ok: false, error: 'Limba invalida pentru ecran.' });
  }
  event.displayState.language = language;
  event.displayState.updatedAt = new Date().toISOString();
  saveDb();
  io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));
  res.json({ ok: true, displayState: event.displayState });
});

app.post('/api/events/:id/display/settings', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventAdmin(req, res, event)) return;
  ensureEventUiState(event);
  const backgroundPreset = typeof req.body.backgroundPreset === 'string' ? req.body.backgroundPreset.trim() : event.displayState.backgroundPreset;
  const customBackground = typeof req.body.customBackground === 'string' ? req.body.customBackground.trim() : event.displayState.customBackground;
  const showClock = typeof req.body.showClock === 'boolean' ? req.body.showClock : event.displayState.showClock;
  const clockPosition = typeof req.body.clockPosition === 'string' ? req.body.clockPosition.trim() : event.displayState.clockPosition;
  const textSize = typeof req.body.textSize === 'string' ? req.body.textSize.trim() : event.displayState.textSize;
  const screenStyle = typeof req.body.screenStyle === 'string' ? req.body.screenStyle.trim() : event.displayState.screenStyle;
  if (!['none', 'warm', 'sanctuary', 'soft-light'].includes(backgroundPreset)) {
    return res.status(400).json({ ok: false, error: 'Preset fundal invalid.' });
  }
  if (!['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(clockPosition)) {
    return res.status(400).json({ ok: false, error: 'Pozitie ceas invalida.' });
  }
  if (!['compact', 'large', 'xlarge'].includes(textSize)) {
    return res.status(400).json({ ok: false, error: 'Marime text invalida.' });
  }
  if (!['focus', 'wide'].includes(screenStyle)) {
    return res.status(400).json({ ok: false, error: 'Layout ecran invalid.' });
  }
  event.displayState.backgroundPreset = backgroundPreset;
  event.displayState.customBackground = customBackground;
  event.displayState.showClock = !!showClock;
  event.displayState.clockPosition = clockPosition;
  event.displayState.textSize = textSize;
  event.displayState.screenStyle = screenStyle;
  event.displayState.updatedAt = new Date().toISOString();
  saveDb();
  io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));
  res.json({ ok: true, displayState: event.displayState });
});

app.post('/api/events/:id/display/blank', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventAdmin(req, res, event)) return;
  ensureEventUiState(event);
  event.mode = 'live';
  event.displayState.mode = 'manual';
  event.displayState.manualSource = '';
  event.displayState.manualTranslations = {};
  event.displayState.updatedAt = new Date().toISOString();
  saveDb();
  io.to(`event:${event.id}`).emit('mode_changed', { mode: 'live' });
  io.to(`event:${event.id}`).emit('display_manual_update', buildDisplayPayload(event));
  res.json({ ok: true, event: normalizeEvent(event) });
});

app.post('/api/events/:id/display/manual', async (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventAdmin(req, res, event)) return;

  ensureEventUiState(event);

  const text = sanitizeStructuredText(req.body.text || '');
  const title = String(req.body.title || '').trim();

  if (!text) {
    return res.status(400).json({ ok: false, error: 'Text lipsă.' });
  }

  try {
    const translations = await buildTranslationsForAllTargets(text, event);

    const entry = {
      id: randomUUID(),
      sourceLang: event.sourceLang,
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

    event.displayState = {
      ...event.displayState,
      mode: 'manual',
      manualSource: text,
      manualTranslations: translations,
      updatedAt: new Date().toISOString()
    };

    event.mode = 'live';
    pushSongHistory(event, { title: title || 'Pinned text', kind: 'manual', source: text, translations });

    saveDb();

    io.to(`event:${event.id}`).emit('transcript_entry', entry);
    io.to(`event:${event.id}`).emit('display_manual_update', buildDisplayPayload(event));
    io.to(`event:${event.id}`).emit('song_history_updated', {
      songHistory: event.songHistory
    });

    res.json({ ok: true, displayState: event.displayState, songHistory: event.songHistory });
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

  if (!title || !text) {
    return res.status(400).json({ ok: false, error: 'Titlu sau text lipsă.' });
  }

  upsertLibraryItem(event.songLibrary, { title, text, labels }, 100);

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
  const title = String(req.body.title || '').trim();
  const text = sanitizeStructuredText(req.body.text || '');
  const labels = Array.isArray(req.body.labels) ? req.body.labels : [];
  if (!title || !text) {
    return res.status(400).json({ ok: false, error: 'Titlu sau text lipsa.' });
  }
  upsertLibraryItem(db.globalSongLibrary, { title, text, labels }, 500);
  saveDb();
  res.json({ ok: true, globalSongLibrary: db.globalSongLibrary });
});

app.delete('/api/global-song-library/:songId', (req, res) => {
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
  if (!requireEventAdmin(req, res, event)) return;

  const title = String(req.body.title || '').trim();
  const text = sanitizeStructuredText(req.body.text || '');
  const labels = Array.isArray(req.body.labels) ? req.body.labels : [];

  if (!title || !text) {
    return res.status(400).json({ ok: false, error: 'Titlu sau text lipsÄƒ.' });
  }

  upsertLibraryItem(db.globalSongLibrary, { title, text, labels }, 500);
  saveDb();
  res.json({ ok: true, globalSongLibrary: db.globalSongLibrary });
});

app.post('/api/events/:id/global-song-library/:songId/add-to-event', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventAdmin(req, res, event)) return;

  ensureEventUiState(event);
  const item = (db.globalSongLibrary || []).find((entry) => entry.id === req.params.songId);
  if (!item) {
    return res.status(404).json({ ok: false, error: 'Cantarea nu exista in biblioteca generala.' });
  }

  upsertLibraryItem(event.songLibrary, { title: item.title, text: item.text, labels: item.labels || [] }, 100);
  saveDb();
  res.json({ ok: true, songLibrary: event.songLibrary, globalSongLibrary: db.globalSongLibrary });
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
  if (String(req.body.code || '') !== String(event.adminCode || '')) return res.status(403).json({ ok: false, error: 'Cod Admin invalid.' });
  if (!client) return res.status(400).json({ ok: false, error: 'OpenAI nu este configurat.' });
  if (!req.file || !req.file.buffer?.length) return res.status(400).json({ ok: false, error: 'Audio lipsă.' });

  const mimeType = String(req.file.mimetype || 'audio/webm');
  const ext = mimeType.includes('wav') ? 'wav' : mimeType.includes('mp4') || mimeType.includes('m4a') ? 'm4a' : 'webm';
  const tempPath = path.join(os.tmpdir(), `bpms-${randomUUID()}.${ext}`);

  try {
    fs.writeFileSync(tempPath, req.file.buffer);
    const rawTranscript = await transcribeAudioFile(tempPath, event);
    const transcript = applySourceCorrections(sanitizeTranscriptText(rawTranscript), getSourceCorrections(event));
    if (!transcript) return res.json({ ok: true, skipped: true });
    queueSpeechText(event.id, transcript);
    return res.json({ ok: true, text: transcript, buffered: true });
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
    if (role === 'admin' && code !== event.adminCode) return socket.emit('join_error', { message: 'Cod Admin invalid.' });

    cleanupSocketPresence(socket);
    socket.data.eventId = eventId;
    socket.data.role = role || 'participant';
    socket.data.language = language || event.targetLangs[0] || 'no';
    socket.data.participantId = participantId || '';

    socket.join(`event:${eventId}`);
    if (socket.data.role === 'admin') socket.join(`event:${eventId}:admins`);
    if (socket.data.role === 'participant') socket.join(`event:${eventId}:lang:${socket.data.language}`);

    if (socket.data.role === 'participant' && socket.data.participantId) {
      registerParticipantSocket(eventId, socket.data.participantId, socket.data.language, socket.id);
      emitParticipantStats(eventId);
    }
    if (socket.data.role === 'admin') emitParticipantStats(eventId);

    socket.emit('joined_event', { ok: true, role: socket.data.role, event: normalizeEvent(event), languageNames: LANGUAGE_NAMES_RO });
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
    const cleanText = String(text || '').trim();
    if (!cleanText) return;
    try {
      event.mode = 'live';
      await processText(event, cleanText);
    } catch (err) {
      console.error('submit_text error:', err);
      socket.emit('server_error', { message: 'Eroare la traducere.' });
    }
  });

  socket.on('admin_update_source', async ({ eventId, entryId, sourceText }) => {
    const event = db.events[eventId];
    if (!event) return;
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
      saveDb();
      io.to(`event:${eventId}`).emit('transcript_source_updated', {
        entryId,
        sourceLang: entry.sourceLang,
        original: entry.original,
        translations: entry.translations
      });

      ensureEventUiState(event);
      if (event.displayState?.mode === 'auto') {
        io.to(`event:${eventId}`).emit('display_live_entry', entry);
      }
    } catch (err) {
      console.error('admin_update_source error:', err);
      io.to(`event:${eventId}`).emit('entry_refresh_failed', { entryId });
    }
  });

  socket.on('set_audio_state', ({ eventId, audioMuted, audioVolume, code }) => {
    const event = db.events[eventId];
    if (!event || code !== event.adminCode) return;
    if (typeof audioMuted === 'boolean') event.audioMuted = audioMuted;
    if (typeof audioVolume === 'number') event.audioVolume = Math.max(0, Math.min(100, audioVolume));
    saveDb();
    io.to(`event:${eventId}`).emit('audio_state', { audioMuted: event.audioMuted, audioVolume: event.audioVolume });
  });

  socket.on('disconnect', () => {
    cleanupSocketPresence(socket);
  });
});

server.listen(PORT, () => {
  console.log(`BPMS V13 beta user running on ${PORT}`);
});
