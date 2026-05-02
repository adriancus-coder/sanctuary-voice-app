const socket = io();
const $ = (id) => document.getElementById(id);
let availableLanguages = {};
let participantWakeLock = null;
const participantParams = new URLSearchParams(window.location.search);
const LIVE_ENTRY_MIN_DISPLAY_MS = 1800;
const LIVE_ENTRY_MAX_DISPLAY_MS = 9000;
const LIVE_ENTRY_MAX_QUEUE = 3;
const LIVE_ENTRY_CATCHUP_MIN_MS = 800;

const voiceLocales = {
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

function langLabel(code) {
  return availableLanguages[code] || code.toUpperCase();
}

function getOrCreateParticipantId() {
  const key = 'sanctuary_voice_participant_id';
  let id = localStorage.getItem(key);
  if (!id) {
    id = window.crypto?.randomUUID?.() || `p_${Math.random().toString(36).slice(2)}_${Date.now()}`;
    localStorage.setItem(key, id);
  }
  return id;
}

function escapeHtml(text) {
  return String(text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const BIBLE_BOOK_NAMES = '(?:Geneza|Exod|Levitic|Numeri|Deuteronom|Iosua|Judec[ăa]tori|Rut|Samuel|[ÎI]mp[ăa]ra[țt]i|Cronici|Ezra|Neemia|Estera|Iov|Psalmi|Psalmul|Proverbe|Eclesiastul|C[âa]ntarea|Isaia|Ieremia|Pl[âa]ngeri|Ezechiel|Daniel|Osea|Ioel|Amos|Obadia|Iona|Mica|Naum|Habacuc|[ȚT]efania|Hagai|Zaharia|Maleahi|Matei|Marcu|Luca|Ioan|Faptele|Romani|Corinteni|Galateni|Efeseni|Filipeni|Coloseni|Tesaloniceni|Timotei|Tit|Filimon|Evrei|Iacov|Petru|Iuda|Apocalipsa|Genesis|Exodus|Leviticus|Numbers|Deuteronomy|Joshua|Judges|Ruth|Kings|Chronicles|Nehemiah|Esther|Job|Psalms|Psalm|Proverbs|Ecclesiastes|Song|Isaiah|Jeremiah|Lamentations|Ezekiel|Hosea|Joel|Amos|Obadiah|Jonah|Micah|Nahum|Habakkuk|Zephaniah|Haggai|Zechariah|Malachi|Matthew|Mark|Luke|John|Acts|Romans|Corinthians|Galatians|Ephesians|Philippians|Colossians|Thessalonians|Timothy|Titus|Philemon|Hebrews|James|Peter|Jude|Revelation)';
const BIBLE_REF_REGEX = new RegExp(`((?:[12]\\s+)?${BIBLE_BOOK_NAMES}\\s+\\d{1,3}:\\d{1,3}(?:[-–]\\d{1,3})?)`, 'g');

function highlightBibleRefs(text) {
  const safe = escapeHtml(text || '');
  return safe.replace(BIBLE_REF_REGEX, '<span class="bible-ref">$1</span>');
}

const state = {
  fixedEventId: participantParams.get('event') || '',
  previewMode: participantParams.get('preview') === '1',
  previewCode: participantParams.get('code') || '',
  currentEvent: null,
  currentLanguage: participantParams.get('lang') || 'no',
  currentMode: 'live',
  currentSongState: null,
  lastLiveEntryId: null,
  visibleLiveEntry: null,
  awaitingFreshLiveEntry: false,
  allowTranscriptFallback: true,
  freshLiveStartedAt: 0,
  freshLiveBlockedEntryIds: new Set(),
  liveEntryShownAt: 0,
  liveEntryQueue: [],
  liveEntryTimer: null,
  recentEntryIds: [],
  lastSpokenEntryId: null,
  localAudioEnabled: true,
  serverAudioMuted: false,
  languageInitialized: false,
  participantId: getOrCreateParticipantId(),
  compactMode: participantParams.get('compact') === '1' || localStorage.getItem('sanctuary_voice_participant_compact') === '1',
  focusMode: participantParams.get('focus') === '1' || localStorage.getItem('sanctuary_voice_participant_focus') === '1'
};

let publicEvents = [];
let pushSubscriptionEventId = '';

if (state.previewMode) {
  document.body.classList.add('participant-preview-mode');
}

function setWakeLockBadge(active) {
  const badge = $('participantWakeLockBadge');
  if (!badge) return;
  badge.style.display = active ? 'inline-flex' : 'none';
}

async function enableWakeLock() {
  try {
    if (!('wakeLock' in navigator)) return;
    if (document.visibilityState !== 'visible') return;
    if (participantWakeLock) return;
    participantWakeLock = await navigator.wakeLock.request('screen');
    setWakeLockBadge(true);
    participantWakeLock.addEventListener('release', () => {
      participantWakeLock = null;
      setWakeLockBadge(false);
    });
  } catch (_) {
    setWakeLockBadge(false);
  }
}

async function disableWakeLock() {
  try {
    if (!participantWakeLock) return;
    await participantWakeLock.release();
    participantWakeLock = null;
  } catch (_) {}
  setWakeLockBadge(false);
}

const HISTORY_MIN_ITEMS = 3;
const HISTORY_MAX_ITEMS = 5;
const HISTORY_CHAR_BUDGET = 560;

function setStatus(text) {
  $('participantStatus').textContent = text;
}

function setParticipantUpdating(show) {
  $('participantUpdatingBadge').style.display = show ? 'block' : 'none';
}

function applyParticipantViewMode() {
  const shell = document.querySelector('.participant-shell');
  if (!shell) return;
  shell.classList.toggle('participant-compact', !!state.compactMode);
  shell.classList.toggle('participant-focus', !!state.focusMode);
  shell.classList.toggle('has-live-event', !!state.currentEvent);
  const compactBtn = $('participantCompactBtn');
  const focusBtn = $('participantFocusBtn');
  if (compactBtn) {
    compactBtn.classList.toggle('btn-primary', !!state.compactMode);
    compactBtn.classList.toggle('btn-dark', !state.compactMode);
    compactBtn.textContent = state.compactMode ? 'Compact on' : 'Compact';
  }
  if (focusBtn) {
    focusBtn.classList.toggle('btn-primary', !!state.focusMode);
    focusBtn.classList.toggle('btn-dark', !state.focusMode);
    focusBtn.textContent = state.focusMode ? 'Focus on' : 'Focus mode';
  }
}

function sortEntries(entries = []) {
  return [...entries].sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
}

function cloneEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return {
    ...entry,
    translations: entry.translations ? { ...entry.translations } : {}
  };
}

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function buildLiveEntrySignature(entry) {
  return JSON.stringify({
    id: entry?.id || '',
    original: entry?.original || '',
    translations: entry?.translations || {}
  });
}

function getEntryById(entryId) {
  return (state.currentEvent?.transcripts || []).find((x) => x.id === entryId) || null;
}
function getLatestEntry() {
  const entries = sortEntries(state.currentEvent?.transcripts || []);
  return entries.length ? entries[entries.length - 1] : null;
}
function getVisibleLiveEntry() {
  if (state.awaitingFreshLiveEntry) return null;
  if (state.visibleLiveEntry) return state.visibleLiveEntry;
  return state.allowTranscriptFallback ? getLatestEntry() : null;
}
function getTextForEntry(entry) {
  return entry?.translations?.[state.currentLanguage] || entry?.original || '';
}

function getEntryTimestamp(entry) {
  const value = entry?.createdAt || entry?.updatedAt || '';
  const parsed = value ? new Date(value).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function isFreshLiveEntry(entry) {
  if (!state.awaitingFreshLiveEntry || !state.freshLiveStartedAt) return true;
  if (entry?.id && state.freshLiveBlockedEntryIds.has(entry.id)) return false;
  const entryTime = getEntryTimestamp(entry);
  if (!entryTime) return true;
  return entryTime >= state.freshLiveStartedAt - 2000;
}

function getSongTextForCurrentLanguage(songState) {
  const sourceLang = songState?.sourceLang || state.currentEvent?.sourceLang || 'ro';
  if (state.currentLanguage === sourceLang) {
    return songState?.activeBlock || '';
  }
  return songState?.translations?.[state.currentLanguage]
    || songState?.activeBlock
    || '';
}

function getLiveEntryDuration(entry) {
  const text = String(getTextForEntry(entry) || '').trim();
  const words = countWords(text);
  const lineCount = Math.max(1, Math.ceil(text.length / 42));
  const readingMs = 1400 + (words * 320) + (lineCount * 360);
  return Math.max(LIVE_ENTRY_MIN_DISPLAY_MS, Math.min(LIVE_ENTRY_MAX_DISPLAY_MS, readingMs));
}

function getHistoryEntries() {
  const entries = sortEntries(state.currentEvent?.transcripts || []);
  if (entries.length <= 1) return [];
  const visibleIndex = entries.findIndex((entry) => entry.id === state.visibleLiveEntry?.id);
  const endIndex = visibleIndex >= 0 ? visibleIndex - 1 : entries.length - 2;

  const result = [];
  let totalChars = 0;

  for (let i = endIndex; i >= 0; i -= 1) {
    const entry = entries[i];
    const text = String(getTextForEntry(entry) || '').trim();
    if (!text) continue;

    const nextChars = totalChars + text.length;
    const canForceAdd = result.length < HISTORY_MIN_ITEMS;
    const canBudgetAdd = result.length < HISTORY_MAX_ITEMS && nextChars <= HISTORY_CHAR_BUDGET;

    if (!canForceAdd && !canBudgetAdd) break;
    result.push(entry);
    totalChars = nextChars;
    if (result.length >= HISTORY_MAX_ITEMS) break;
  }

  return result;
}

function detectPreferredSupportedLanguage(available = []) {
  const candidates = [...(navigator.languages || []), navigator.language].filter(Boolean);
  for (const raw of candidates) {
    const code = String(raw).toLowerCase();
    if ((code.startsWith('nb') || code.startsWith('nn') || code.startsWith('no')) && available.includes('no')) return 'no';
    for (const short of available) {
      if (code.startsWith(short)) return short;
    }
  }
  return available[0] || 'en';
}

function syncLanguageOptions(event) {
  const select = $('languageSelect');
  const previousLanguage = state.currentLanguage || select.value;
  const available = Array.from(new Set([
    ...(event?.targetLangs || []),
    (event?.mode === 'song' ? (event?.songState?.sourceLang || '') : '')
  ].filter(Boolean)));
  select.innerHTML = '';
  available.forEach((code) => {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = langLabel(code);
    select.appendChild(option);
  });
  if (!state.languageInitialized) {
    select.value = detectPreferredSupportedLanguage(available);
    state.languageInitialized = true;
  } else if (available.includes(previousLanguage)) {
    select.value = previousLanguage;
  }
  if (!available.includes(select.value)) select.value = available[0] || 'en';
  state.currentLanguage = select.value;
}

function updateTopMeta() {
  if (!state.currentEvent) return;
  $('participantEventName').textContent = state.currentEvent.name || 'Live event';
  const sourceName = langLabel(state.currentEvent.sourceLang || 'ro');
  const targetName = langLabel(state.currentLanguage);
  $('participantModeBadge').textContent = state.currentMode === 'song' ? 'Song' : 'Live';
  $('participantLanguageBadge').textContent = targetName;
  $('participantEventMeta').textContent = state.currentMode === 'song'
    ? `Song · Output: ${targetName}`
    : `Input: ${sourceName} · Translation: ${targetName}`;
}

function formatEventDate(value) {
  if (!value) return 'Time not set';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Time not set';
  return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function renderParticipantEventList(events = []) {
  const box = $('participantEventList');
  if (!box) return;
  publicEvents = Array.isArray(events) ? events : [];
  const liveEvents = publicEvents.filter((event) => event && event.isActive && !(typeof event.scheduledTimestamp === 'number' && event.scheduledTimestamp > Date.now()));
  if (!liveEvents.length) {
    box.innerHTML = '<div class="muted">No live service right now. The list will refresh automatically when one starts.</div>';
    return;
  }
  box.innerHTML = liveEvents.map((event) => {
    const langs = (event.targetLangs || []).map(langLabel).join(', ') || 'No target languages';
    return `
      <div class="participant-event-card is-live">
        <div>
          <div class="entry-head">
            <b>${escapeHtml(event.name || 'Service')}</b>
            <span class="status-pill active">Live now</span>
          </div>
          <div class="small">${escapeHtml(formatEventDate(event.scheduledAt || event.createdAt))}</div>
          <div class="small">Languages: ${escapeHtml(langs)}</div>
        </div>
        <button class="btn btn-primary" type="button" data-participant-event="${event.id}">Join</button>
      </div>
    `;
  }).join('');
}

let countdownTimer = null;
let countdownEventId = '';

function clearCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
  countdownEventId = '';
  const stage = $('participantCountdownStage');
  if (stage) stage.hidden = true;
  const live = $('participantLiveStage');
  const history = $('participantHistoryPanel');
  const chooser = $('participantEventChooser');
  if (live) live.hidden = false;
  if (history) history.hidden = false;
  if (chooser && !state.currentEvent) chooser.hidden = false;
}

function formatCountdownText(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (days > 0) return `${days}d ${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatEventScheduledFull(event) {
  if (!event?.scheduledTimestamp) return '';
  try {
    const fmt = new Intl.DateTimeFormat([], {
      timeZone: event.timezone || undefined,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    const text = fmt.format(new Date(event.scheduledTimestamp));
    return event.timezone ? `${text} (${event.timezone})` : text;
  } catch (err) {
    return new Date(event.scheduledTimestamp).toLocaleString();
  }
}

function startCountdownForEvent(event) {
  if (!event?.scheduledTimestamp) return clearCountdown();
  countdownEventId = event.id;
  const stage = $('participantCountdownStage');
  const liveStage = $('participantLiveStage');
  const historyPanel = $('participantHistoryPanel');
  const chooser = $('participantEventChooser');
  if (stage) stage.hidden = false;
  if (liveStage) liveStage.hidden = true;
  if (historyPanel) historyPanel.hidden = true;
  if (chooser) chooser.hidden = true;
  $('participantCountdownEventName').textContent = event.name || 'Service';
  $('participantCountdownDate').textContent = formatEventScheduledFull(event);
  $('participantCountdownNote').textContent = '';
  setStatus('Service has not started yet.');

  if (countdownTimer) clearInterval(countdownTimer);
  function tick() {
    const remaining = (event.scheduledTimestamp || 0) - Date.now();
    if (remaining <= 0) {
      $('participantCountdown').textContent = '00:00:00';
      $('participantCountdownNote').textContent = 'Connecting to live translation...';
      if (countdownTimer) clearInterval(countdownTimer);
      countdownTimer = null;
      loadParticipantEvents({ joinFixedIfLive: true }).catch(() => {});
      return;
    }
    $('participantCountdown').textContent = formatCountdownText(remaining);
  }
  tick();
  countdownTimer = setInterval(tick, 1000);
}

function showServiceEnded(event) {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
  countdownEventId = event?.id || '';
  const stage = $('participantCountdownStage');
  const liveStage = $('participantLiveStage');
  const historyPanel = $('participantHistoryPanel');
  if (stage) stage.hidden = false;
  if (liveStage) liveStage.hidden = true;
  if (historyPanel) historyPanel.hidden = true;
  $('participantCountdownEventName').textContent = event?.name || 'Service';
  $('participantCountdownDate').textContent = formatEventScheduledFull(event);
  $('participantCountdown').textContent = '';
  $('participantCountdownNote').textContent = 'This service has ended.';
  setStatus('This service has ended.');
}

function isScheduledInFuture(event) {
  return event && typeof event.scheduledTimestamp === 'number' && event.scheduledTimestamp > Date.now();
}

function isReallyLive(event) {
  return !!(event && event.isActive && !isScheduledInFuture(event));
}

function findNextUpcomingEvent(events) {
  const now = Date.now();
  const upcoming = (events || [])
    .filter((event) => typeof event.scheduledTimestamp === 'number' && event.scheduledTimestamp > now)
    .sort((a, b) => a.scheduledTimestamp - b.scheduledTimestamp);
  return upcoming[0] || null;
}

async function loadParticipantEvents({ joinFixedIfLive = false } = {}) {
  try {
    const res = await fetch('/api/events/public');
    const data = await res.json();
    if (data.languageNames) availableLanguages = data.languageNames;
    const events = data.events || [];
    renderParticipantEventList(events);
    if (state.previewMode && state.fixedEventId) {
      clearCountdown();
      await joinParticipantEvent(state.fixedEventId);
      return;
    }
    if (joinFixedIfLive && state.fixedEventId) {
      const fixedEvent = events.find((event) => event.id === state.fixedEventId);
      if (isScheduledInFuture(fixedEvent)) {
        startCountdownForEvent(fixedEvent);
        return;
      }
      if (isReallyLive(fixedEvent)) {
        clearCountdown();
        await joinParticipantEvent(fixedEvent.id);
        return;
      }
      if (fixedEvent && typeof fixedEvent.scheduledTimestamp === 'number') {
        showServiceEnded(fixedEvent);
        return;
      }
      clearCountdown();
      setStatus('This event is not live yet.');
      return;
    }
    if (!state.currentEvent) {
      const liveEvents = events.filter(isReallyLive);
      if (!liveEvents.length) {
        const next = findNextUpcomingEvent(events);
        if (next) {
          startCountdownForEvent(next);
          return;
        }
      }
      clearCountdown();
      setStatus(liveEvents.length ? 'Choose a live event.' : 'No live service right now.');
    }
  } catch (_) {
    setStatus('Could not load events.');
  }
}

function stopSpeech() {
  try {
    window.speechSynthesis?.cancel();
  } catch (_) {}
}

function getVoiceForCurrentLanguage() {
  const locale = voiceLocales[state.currentLanguage] || 'en-US';
  const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
  const voice = voices.find((v) => (v.lang || '').toLowerCase().startsWith(locale.toLowerCase().split('-')[0]));
  return { locale, voice: voice || null };
}

function speakLatestEntry(entry) {
  if (!entry || !state.localAudioEnabled || state.serverAudioMuted) return;
  const text = String(getTextForEntry(entry) || '').trim();
  if (!text) return;
  stopSpeech();
  try {
    const utter = new SpeechSynthesisUtterance(text);
    const { locale, voice } = getVoiceForCurrentLanguage();
    utter.lang = locale;
    if (voice) utter.voice = voice;
    utter.rate = 1;
    utter.pitch = 1;
    window.speechSynthesis?.speak(utter);
  } catch (_) {}
}

function renderHistory() {
  if (state.currentMode === 'song') {
    $('history').innerHTML = '<div class="muted">Song is active right now.</div>';
    return;
  }
  const entries = getHistoryEntries();
  $('history').innerHTML = entries.length
    ? entries.map((entry) => `<div class="history-item"><div class="history-text">${escapeHtml(getTextForEntry(entry))}</div></div>`).join('')
    : '<div class="muted">No previous text yet.</div>';
}

function rememberRecentEntry(entry) {
  if (!entry?.id) return;
  state.recentEntryIds = state.recentEntryIds.filter((id) => id !== entry.id);
  state.recentEntryIds.push(entry.id);
  if (state.recentEntryIds.length > 10) state.recentEntryIds = state.recentEntryIds.slice(-10);
}

function renderEarlierLines(currentId) {
  const box = $('participantEarlierLines');
  if (!box) return;
  if (state.currentMode === 'song') {
    box.innerHTML = '';
    return;
  }
  const limit = (window.matchMedia && window.matchMedia('(max-width: 379px)').matches) ? 1 : 2;
  const ids = state.recentEntryIds.filter((id) => id !== currentId).slice(-limit);
  if (!ids.length) {
    box.innerHTML = '';
    return;
  }
  const lines = ids.map((id) => getEntryById(id)).filter(Boolean);
  if (!lines.length) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = lines.map((entry, i) => {
    const opacity = (lines.length === 2 && i === 0) ? 0.4 : 0.65;
    const text = getTextForEntry(entry);
    if (!text) return '';
    return `<div class="participant-earlier-line" style="opacity:${opacity}">${highlightBibleRefs(text)}</div>`;
  }).join('');
}

function scrollLiveStageIntoView() {
  setTimeout(() => {
    const stage = document.getElementById('participantLiveStage');
    if (!stage) return;
    try {
      stage.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (_) {
      const top = stage.getBoundingClientRect().top + window.pageYOffset;
      window.scrollTo({ top, behavior: 'smooth' });
    }
  }, 120);
}

function renderLiveView({ announce = false } = {}) {
  if (!state.currentEvent) return;
  if (state.currentMode === 'song' && state.currentSongState) {
    const songText = getSongTextForCurrentLanguage(state.currentSongState) || 'Waiting for song translation...';
    $('lastText').textContent = songText;
    renderEarlierLines(null);
    renderHistory();
    updateTopMeta();
    return;
  }
  const visibleEntry = getVisibleLiveEntry();
  state.lastLiveEntryId = visibleEntry?.id || null;
  if (visibleEntry) {
    $('lastText').innerHTML = highlightBibleRefs(getTextForEntry(visibleEntry));
  } else {
    $('lastText').textContent = 'Waiting for translation...';
  }
  renderEarlierLines(visibleEntry?.id || null);
  renderHistory();
  updateTopMeta();
  if (announce && visibleEntry && visibleEntry.id !== state.lastSpokenEntryId) {
    state.lastSpokenEntryId = visibleEntry.id;
    speakLatestEntry(visibleEntry);
  }
}

function showLiveEntry(entry, { announce = false } = {}) {
  if (!entry) return;
  if (state.visibleLiveEntry && state.visibleLiveEntry.id !== entry.id) {
    rememberRecentEntry(state.visibleLiveEntry);
  }
  state.awaitingFreshLiveEntry = false;
  state.allowTranscriptFallback = false;
  state.freshLiveStartedAt = 0;
  state.freshLiveBlockedEntryIds = new Set();
  state.visibleLiveEntry = cloneEntry(entry);
  state.liveEntryShownAt = Date.now();
  renderLiveView({ announce });
}

function waitForFreshLiveEntry() {
  state.awaitingFreshLiveEntry = true;
  state.allowTranscriptFallback = false;
  state.freshLiveStartedAt = Date.now();
  state.freshLiveBlockedEntryIds = new Set([
    ...(state.currentEvent?.transcripts || []).map((entry) => entry.id).filter(Boolean),
    state.currentEvent?.latestDisplayEntry?.id
  ].filter(Boolean));
  state.visibleLiveEntry = null;
  state.liveEntryQueue = [];
  if (state.liveEntryTimer) clearTimeout(state.liveEntryTimer);
  state.liveEntryTimer = null;
  state.liveEntryShownAt = Date.now();
  renderLiveView({ announce: false });
}

function scheduleNextLiveEntry() {
  if (state.liveEntryTimer) clearTimeout(state.liveEntryTimer);
  if (state.currentMode === 'song' || !state.liveEntryQueue.length) return;

  const elapsed = Date.now() - (state.liveEntryShownAt || 0);
  const currentEntry = getVisibleLiveEntry();
  const baseDuration = currentEntry ? getLiveEntryDuration(currentEntry) : LIVE_ENTRY_MIN_DISPLAY_MS;
  const queueLen = state.liveEntryQueue.length;
  const catchupFactor = queueLen >= 2 ? 0.45 : queueLen === 1 ? 0.7 : 1;
  const targetDuration = queueLen > 0
    ? Math.max(LIVE_ENTRY_CATCHUP_MIN_MS, Math.round(baseDuration * catchupFactor))
    : baseDuration;
  const waitMs = Math.max(0, targetDuration - elapsed);
  state.liveEntryTimer = setTimeout(() => {
    state.liveEntryTimer = null;
    const nextEntry = state.liveEntryQueue.shift();
    showLiveEntry(nextEntry, { announce: true });
    scheduleNextLiveEntry();
  }, waitMs);
}

function enqueueLiveEntry(entry) {
  if (!entry) return;
  if (state.currentMode === 'song') return;
  if (!isFreshLiveEntry(entry)) return;
  const candidate = cloneEntry(entry);
  const candidateSignature = buildLiveEntrySignature(candidate);
  if (!state.visibleLiveEntry) {
    showLiveEntry(candidate, { announce: true });
    return;
  }
  if (candidateSignature === buildLiveEntrySignature(state.visibleLiveEntry)) return;
  if (state.liveEntryQueue.some((item) => buildLiveEntrySignature(item) === candidateSignature)) return;
  state.liveEntryQueue.push(candidate);
  if (state.liveEntryQueue.length > LIVE_ENTRY_MAX_QUEUE) {
    state.liveEntryQueue = state.liveEntryQueue.slice(-LIVE_ENTRY_MAX_QUEUE);
  }
  scheduleNextLiveEntry();
}

function updateEntryInState(payload) {
  const entry = getEntryById(payload.entryId);
  if (!entry) return;
  entry.sourceLang = payload.sourceLang;
  entry.original = payload.original;
  entry.translations = payload.translations || {};
  entry.edited = true;
  if (state.visibleLiveEntry?.id === payload.entryId) {
    state.visibleLiveEntry.sourceLang = payload.sourceLang;
    state.visibleLiveEntry.original = payload.original;
    state.visibleLiveEntry.translations = payload.translations || {};
  }
  state.liveEntryQueue = state.liveEntryQueue.map((item) => (
    item.id === payload.entryId
      ? {
          ...item,
          sourceLang: payload.sourceLang,
          original: payload.original,
          translations: payload.translations || {}
        }
      : item
  ));
}

function getAiNoticeCopy(language) {
  const copies = {
    ro: {
      title: 'Avertizare despre traducerea AI',
      text: 'Acest serviciu folosește traducere AI. Textul poate conține erori, omisiuni sau interpretări greșite ale pasajelor biblice. Te rugăm să urmărești vorbitorul și Scriptura ca sursă de autoritate.',
      button: 'Am înțeles'
    },
    no: {
      title: 'Viktig om AI-oversettelse',
      text: 'Denne tjenesten bruker AI-oversettelse. Teksten kan inneholde feil, utelatelser eller feil tolkning av bibelske tekster. Følg taleren og Skriften som autoritativ kilde.',
      button: 'Jeg forstår'
    },
    en: {
      title: 'AI translation notice',
      text: 'This service uses AI translation. The text may contain errors, omissions, or incorrect interpretations of biblical passages. Please follow the speaker and Scripture as the authoritative source.',
      button: 'I understand'
    },
    ru: {
      title: 'Важное уведомление о переводе AI',
      text: 'Этот сервис использует AI-перевод. Текст может содержать ошибки, пропуски или неверное толкование библейских отрывков. Пожалуйста, ориентируйтесь на говорящего и Писание как на авторитетный источник.',
      button: 'Понятно'
    },
    el: {
      title: 'Σημείωση για μετάφραση AI',
      text: 'Αυτή η υπηρεσία χρησιμοποιεί μετάφραση AI. Το κείμενο μπορεί να περιέχει λάθη, παραλείψεις ή λανθασμένη ερμηνεία βιβλικών αποσπασμάτων. Παρακαλούμε να ακολουθείτε τον ομιλητή και τη Γραφή ως την έγκυρη πηγή.',
      button: 'Κατάλαβα'
    }
  };
  return copies[language] || copies.en;
}

function getAiNoticeKey() {
  return `sanctuary_voice_ai_notice_${state.currentEvent?.id || 'event'}_${state.currentLanguage || 'lang'}`;
}

function showAiNoticeIfNeeded({ force = false } = {}) {
  if (state.previewMode || !state.currentEvent || !state.currentLanguage) return;
  const modal = $('participantAiNotice');
  if (!modal) return;
  if (!force && localStorage.getItem(getAiNoticeKey()) === '1') return;

  const copy = getAiNoticeCopy(state.currentLanguage);
  $('participantAiNoticeTitle').textContent = copy.title;
  $('participantAiNoticeText').textContent = copy.text;
  $('participantAiNoticeOk').textContent = copy.button;
  modal.hidden = false;
  $('participantAiNoticeOk')?.focus();
}

function formatServiceEndedTime(iso) {
  let date = null;
  if (iso) {
    const parsed = new Date(iso);
    if (!Number.isNaN(parsed.getTime())) date = parsed;
  }
  if (!date) date = new Date();
  try {
    return date.toLocaleString(undefined, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch (_) {
    return date.toLocaleString();
  }
}

function showServiceEndedOverlay(endedAt) {
  const overlay = $('participantServiceEnded');
  if (!overlay) return;
  const timeEl = $('participantServiceEndedTime');
  if (timeEl) timeEl.textContent = formatServiceEndedTime(endedAt);
  overlay.hidden = false;
  $('participantServiceEndedClose')?.focus();
}

function hideServiceEndedOverlay() {
  const overlay = $('participantServiceEnded');
  if (overlay) overlay.hidden = true;
}

function acceptAiNotice() {
  localStorage.setItem(getAiNoticeKey(), '1');
  const modal = $('participantAiNotice');
  if (modal) modal.hidden = true;
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = `${base64String}${padding}`.replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

async function subscribeToPushNotifications() {
  if (state.previewMode || !state.currentEvent?.id) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
  if (pushSubscriptionEventId === state.currentEvent.id && Notification.permission === 'granted') return;

  const keyRes = await fetch('/api/push/public-key');
  const keyData = await keyRes.json();
  if (!keyData.enabled || !keyData.publicKey) return;

  if (Notification.permission === 'denied') return;
  const permission = Notification.permission === 'granted'
    ? 'granted'
    : await Notification.requestPermission();
  if (permission !== 'granted') return;

  const registration = await navigator.serviceWorker.register('/push-sw.js');
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing || await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(keyData.publicKey)
  });

  await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventId: state.currentEvent.id,
      participantId: state.participantId,
      language: state.currentLanguage,
      subscription
    })
  });
  pushSubscriptionEventId = state.currentEvent.id;
}

function handleLanguageChange() {
  state.currentLanguage = $('languageSelect').value;
  if (state.currentEvent?.id) {
    socket.emit('participant_language', { eventId: state.currentEvent.id, language: state.currentLanguage });
    subscribeToPushNotifications().catch(() => {});
  }
  renderLiveView({ announce: false });
  showAiNoticeIfNeeded({ force: true });
}

async function joinParticipantEvent(eventId) {
  if (!eventId) return setStatus('Choose a live event.');
  if (!state.previewMode) await enableWakeLock();
  socket.emit('join_event', {
    eventId,
    role: state.previewMode ? 'participant_preview' : 'participant',
    code: state.previewCode,
    language: $('languageSelect')?.value || state.currentLanguage,
    participantId: state.participantId
  });
}

socket.on('connect', async () => {
  setStatus('Connecting...');
  await loadParticipantEvents({ joinFixedIfLive: true });
});

socket.on('disconnect', () => setStatus('Reconnecting...'));
socket.on('join_error', ({ message }) => setStatus(message || 'Cannot join event.'));

function applyTestModeIndicator(event) {
  const badge = $('participantTestBadge');
  if (badge) badge.hidden = !event?.testMode;
  if (event?.testMode && !state.previewMode) {
    const seenKey = `sanctuary_voice_test_notice_${event.id || 'event'}`;
    if (!sessionStorage.getItem(seenKey)) {
      try {
        sessionStorage.setItem(seenKey, '1');
        alert('TEST MODE\n\nThis service is a test, not a real live event. Translations may be incomplete.');
      } catch (_) {}
    }
  }
}

socket.on('joined_event', ({ event, role }) => {
  if (role !== 'participant' && role !== 'participant_preview') return;
  clearCountdown();
  state.currentEvent = event;
  applyTestModeIndicator(event);
  state.currentMode = event.mode || 'live';
  state.currentSongState = event.songState || null;
  state.serverAudioMuted = !!event.audioMuted;
  state.liveEntryQueue = [];
  if (state.liveEntryTimer) clearTimeout(state.liveEntryTimer);
  state.liveEntryTimer = null;
  if (state.currentMode === 'live') {
    waitForFreshLiveEntry();
  } else {
    state.visibleLiveEntry = null;
    state.awaitingFreshLiveEntry = false;
    state.allowTranscriptFallback = false;
  }
  const chooser = $('participantEventChooser');
  if (chooser) chooser.hidden = true;
  syncLanguageOptions(event);
  applyParticipantViewMode();
  renderLiveView({ announce: false });
  setParticipantUpdating(false);
  setStatus(state.serverAudioMuted ? 'Audio stopped by admin.' : 'Connected.');
  if (state.previewMode) {
    document.body.classList.add('participant-preview-mode');
    setStatus('Moderator preview.');
  } else {
    enableWakeLock();
    showAiNoticeIfNeeded();
    subscribeToPushNotifications().catch(() => {});
    scrollLiveStageIntoView();
  }
});
socket.on('transcript_entry', (entry) => {
  if (!state.currentEvent) return;
  state.currentEvent.transcripts = state.currentEvent.transcripts || [];
  if (!getEntryById(entry.id)) state.currentEvent.transcripts.push(entry);
  setParticipantUpdating(false);
  renderHistory();
});

socket.on('display_live_entry', (entry) => {
  if (!state.currentEvent) return;
  setParticipantUpdating(false);
  if (!isFreshLiveEntry(entry)) return;
  state.currentEvent.latestDisplayEntry = cloneEntry(entry);
  enqueueLiveEntry(entry);
});

socket.on('transcript_source_updated', (payload) => {
  updateEntryInState(payload);
  setParticipantUpdating(false);
  renderHistory();
});

socket.on('entry_refreshing', ({ entryId }) => {
  if (entryId && entryId === state.lastLiveEntryId) setParticipantUpdating(true);
});

socket.on('entry_refresh_failed', ({ entryId }) => {
  if (entryId && entryId === state.lastLiveEntryId) setParticipantUpdating(false);
});

socket.on('service_ended', (payload) => {
  if (state.previewMode) return;
  if (state.currentEvent?.id && payload?.eventId && payload.eventId !== state.currentEvent.id) return;
  showServiceEndedOverlay(payload?.endedAt);
});

socket.on('audio_state', ({ audioMuted }) => {
  state.serverAudioMuted = !!audioMuted;
  if (audioMuted) {
    stopSpeech();
    setStatus('Audio stopped by admin.');
  } else {
    setStatus(state.localAudioEnabled ? 'Audio active.' : 'Local audio paused.');
  }
});

socket.on('active_event_changed', async () => {
  await loadParticipantEvents({ joinFixedIfLive: !!state.fixedEventId });
  if (state.currentEvent && !publicEvents.some((event) => event.id === state.currentEvent.id && event.isActive)) {
    state.currentEvent = null;
    state.currentMode = 'live';
    state.currentSongState = null;
    state.visibleLiveEntry = null;
    state.allowTranscriptFallback = false;
    state.awaitingFreshLiveEntry = false;
    state.freshLiveStartedAt = 0;
    state.freshLiveBlockedEntryIds = new Set();
    state.liveEntryQueue = [];
    if (state.liveEntryTimer) clearTimeout(state.liveEntryTimer);
    state.liveEntryTimer = null;
    $('participantEventName').textContent = 'Choose a live event';
    $('participantEventMeta').textContent = 'The previous event is no longer live.';
    $('lastText').textContent = 'Waiting for live event...';
    $('history').innerHTML = '';
    const chooser = $('participantEventChooser');
    if (chooser) chooser.hidden = false;
    applyParticipantViewMode();
  }
});

socket.on('mode_changed', ({ mode }) => {
  state.currentMode = mode || 'live';
  if (state.currentEvent) state.currentEvent.mode = state.currentMode;
  syncLanguageOptions({ ...state.currentEvent, mode: state.currentMode, songState: state.currentSongState });
  if (mode === 'song') {
    state.visibleLiveEntry = null;
    state.awaitingFreshLiveEntry = false;
    state.allowTranscriptFallback = false;
    state.freshLiveStartedAt = 0;
    state.freshLiveBlockedEntryIds = new Set();
    state.liveEntryQueue = [];
    if (state.liveEntryTimer) clearTimeout(state.liveEntryTimer);
    state.liveEntryTimer = null;
    setStatus('Song active on public screen.');
  } else {
    waitForFreshLiveEntry();
    setStatus(state.serverAudioMuted ? 'Audio stopped by admin.' : 'Connected.');
  }
  renderLiveView({ announce: false });
});

socket.on('song_state', (songState) => {
  state.currentMode = 'song';
  state.currentSongState = songState;
  state.visibleLiveEntry = null;
  state.awaitingFreshLiveEntry = false;
  state.allowTranscriptFallback = false;
  state.freshLiveStartedAt = 0;
  state.freshLiveBlockedEntryIds = new Set();
  state.liveEntryQueue = [];
  if (state.liveEntryTimer) clearTimeout(state.liveEntryTimer);
  state.liveEntryTimer = null;
  syncLanguageOptions({ ...state.currentEvent, mode: 'song', songState });
  renderLiveView({ announce: false });
});

socket.on('event_target_langs_changed', ({ eventId, targetLangs }) => {
  if (!state.currentEvent || state.currentEvent.id !== eventId) return;
  if (!Array.isArray(targetLangs)) return;
  state.currentEvent.targetLangs = targetLangs;
  syncLanguageOptions({ ...state.currentEvent, mode: state.currentMode, songState: state.currentSongState });
});

socket.on('transcripts_cleared', ({ eventId }) => {
  if (!state.currentEvent || state.currentEvent.id !== eventId) return;
  state.currentEvent.transcripts = [];
  state.currentEvent.latestDisplayEntry = null;
  state.visibleLiveEntry = null;
  state.liveEntryQueue = [];
  if (state.liveEntryTimer) clearTimeout(state.liveEntryTimer);
  state.liveEntryTimer = null;
  renderLiveView({ announce: false });
  renderHistory();
});

socket.on('song_clear', () => {
  state.currentMode = 'live';
  state.currentSongState = null;
  if (state.currentEvent) state.currentEvent.latestDisplayEntry = null;
  syncLanguageOptions({ ...state.currentEvent, mode: 'live', songState: null });
  waitForFreshLiveEntry();
  renderLiveView({ announce: false });
});

$('languageSelect').addEventListener('change', handleLanguageChange);
$('refreshParticipantEventsBtn').addEventListener('click', () => loadParticipantEvents({ joinFixedIfLive: !!state.fixedEventId }));
$('participantEventList').addEventListener('click', async (event) => {
  const btn = event.target.closest('button[data-participant-event]');
  if (!btn || btn.disabled) return;
  await joinParticipantEvent(btn.getAttribute('data-participant-event'));
});
function applyAudioButtonState() {
  const playBtn = $('playAudioBtn');
  const pauseBtn = $('pauseAudioBtn');
  if (playBtn) {
    playBtn.classList.toggle('btn-primary', !!state.localAudioEnabled);
    playBtn.classList.toggle('btn-dark', !state.localAudioEnabled);
  }
  if (pauseBtn) {
    pauseBtn.classList.toggle('btn-primary', !state.localAudioEnabled);
    pauseBtn.classList.toggle('btn-dark', !!state.localAudioEnabled);
  }
}

$('playAudioBtn').addEventListener('click', () => {
  state.localAudioEnabled = true;
  setStatus(state.serverAudioMuted ? 'Audio stopped by admin.' : 'Audio active.');
  applyAudioButtonState();
  const latestEntry = getLatestEntry();
  if (latestEntry) speakLatestEntry(latestEntry);
});

$('pauseAudioBtn').addEventListener('click', () => {
  state.localAudioEnabled = false;
  stopSpeech();
  setStatus('Local audio paused.');
  applyAudioButtonState();
});

$('participantCompactBtn').addEventListener('click', () => {
  state.compactMode = !state.compactMode;
  localStorage.setItem('sanctuary_voice_participant_compact', state.compactMode ? '1' : '0');
  applyParticipantViewMode();
});

$('participantFocusBtn').addEventListener('click', () => {
  state.focusMode = !state.focusMode;
  localStorage.setItem('sanctuary_voice_participant_focus', state.focusMode ? '1' : '0');
  applyParticipantViewMode();
});

$('participantExitFocusBtn')?.addEventListener('click', () => {
  state.focusMode = false;
  localStorage.setItem('sanctuary_voice_participant_focus', '0');
  applyParticipantViewMode();
});

$('participantAiNoticeOk')?.addEventListener('click', acceptAiNotice);
$('participantServiceEndedClose')?.addEventListener('click', hideServiceEndedOverlay);

window.addEventListener('load', async () => {
  try {
    const res = await fetch('/api/languages');
    const data = await res.json();
    availableLanguages = data.languages || {};
  } catch (_) {}

  try {
    window.speechSynthesis?.getVoices();
    window.speechSynthesis.onvoiceschanged = () => {};
  } catch (_) {}

  await enableWakeLock();
  applyParticipantViewMode();
  applyAudioButtonState();
  await loadParticipantEvents({ joinFixedIfLive: !!state.fixedEventId });
});

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    await enableWakeLock();
  }
});

if ('serviceWorker' in navigator && !state.previewMode) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/push-sw.js').catch(() => {});
  });
}

window.addEventListener('beforeunload', async () => {
  await disableWakeLock();
});
