const socket = io();
const $ = (id) => document.getElementById(id);
let availableLanguages = {};
let participantWakeLock = null;

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
  hu: 'hu-HU'
};

function langLabel(code) {
  return availableLanguages[code] || code.toUpperCase();
}

function getOrCreateParticipantId() {
  const key = 'bpms_participant_id';
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

const state = {
  fixedEventId: new URLSearchParams(window.location.search).get('event') || '',
  currentEvent: null,
  currentLanguage: 'no',
  currentMode: 'live',
  currentSongState: null,
  lastLiveEntryId: null,
  lastSpokenEntryId: null,
  localAudioEnabled: true,
  serverAudioMuted: false,
  languageInitialized: false,
  participantId: getOrCreateParticipantId()
};

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

const HISTORY_MIN_ITEMS = 4;
const HISTORY_MAX_ITEMS = 8;
const HISTORY_CHAR_BUDGET = 900;

function setStatus(text) {
  $('participantStatus').textContent = text;
}

function setParticipantUpdating(show) {
  $('participantUpdatingBadge').style.display = show ? 'block' : 'none';
}

function sortEntries(entries = []) {
  return [...entries].sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
}

function getEntryById(entryId) {
  return (state.currentEvent?.transcripts || []).find((x) => x.id === entryId) || null;
}

function getLatestEntry() {
  const entries = sortEntries(state.currentEvent?.transcripts || []);
  return entries.length ? entries[entries.length - 1] : null;
}

function getTextForEntry(entry) {
  return entry?.translations?.[state.currentLanguage] || entry?.original || '';
}

function getHistoryEntries() {
  const entries = sortEntries(state.currentEvent?.transcripts || []);
  if (entries.length <= 1) return [];

  const result = [];
  let totalChars = 0;

  for (let i = entries.length - 2; i >= 0; i -= 1) {
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
  const available = Array.from(new Set(event?.targetLangs || []));
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
  }
  if (!available.includes(select.value)) select.value = available[0] || 'en';
  state.currentLanguage = select.value;
}

function updateTopMeta() {
  if (!state.currentEvent) return;
  $('participantEventName').textContent = state.currentEvent.name || 'Live event';
  const sourceName = langLabel(state.currentEvent.sourceLang || 'ro');
  const targetName = langLabel(state.currentLanguage);
  $('participantModeBadge').textContent = state.currentMode === 'song' ? 'Song mode' : 'Live';
  $('participantLanguageBadge').textContent = targetName;
  $('participantEventMeta').textContent = state.currentMode === 'song'
    ? `Song mode · Translation: ${targetName}`
    : `Input: ${sourceName} · Translation: ${targetName}`;
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
    $('history').innerHTML = '<div class="muted">Song mode is active right now.</div>';
    return;
  }
  const entries = getHistoryEntries();
  $('history').innerHTML = entries.length
    ? entries.map((entry) => `<div class="history-item"><div class="history-text">${escapeHtml(getTextForEntry(entry))}</div></div>`).join('')
    : '<div class="muted">No previous text yet.</div>';
}

function renderLiveView({ announce = false } = {}) {
  if (!state.currentEvent) return;
  if (state.currentMode === 'song' && state.currentSongState) {
    const songText = state.currentSongState.translations?.[state.currentLanguage]
      || state.currentSongState.activeBlock
      || 'Waiting for song translation...';
    $('lastText').textContent = songText;
    renderHistory();
    updateTopMeta();
    return;
  }
  const latestEntry = getLatestEntry();
  state.lastLiveEntryId = latestEntry?.id || null;
  $('lastText').textContent = latestEntry ? getTextForEntry(latestEntry) : 'Waiting for translation...';
  renderHistory();
  updateTopMeta();
  if (announce && latestEntry && latestEntry.id !== state.lastSpokenEntryId) {
    state.lastSpokenEntryId = latestEntry.id;
    speakLatestEntry(latestEntry);
  }
}

function updateEntryInState(payload) {
  const entry = getEntryById(payload.entryId);
  if (!entry) return;
  entry.sourceLang = payload.sourceLang;
  entry.original = payload.original;
  entry.translations = payload.translations || {};
  entry.edited = true;
}

function handleLanguageChange() {
  state.currentLanguage = $('languageSelect').value;
  if (state.currentEvent?.id) {
    socket.emit('participant_language', { eventId: state.currentEvent.id, language: state.currentLanguage });
  }
  renderLiveView({ announce: false });
}

async function resolveEventId() {
  if (state.fixedEventId) return state.fixedEventId;
  try {
    const res = await fetch('/api/events/active');
    const data = await res.json();
    if (data.ok && data.event?.id) return data.event.id;
  } catch (_) {}
  return '';
}

async function joinParticipantEvent() {
  const eventId = await resolveEventId();
  if (!eventId) return setStatus('No active event.');
  await enableWakeLock();
  socket.emit('join_event', {
    eventId,
    role: 'participant',
    language: $('languageSelect')?.value || state.currentLanguage,
    participantId: state.participantId
  });
}

socket.on('connect', async () => {
  setStatus('Connecting...');
  await joinParticipantEvent();
});

socket.on('disconnect', () => setStatus('Reconnecting...'));
socket.on('join_error', ({ message }) => setStatus(message || 'Cannot join event.'));

socket.on('joined_event', ({ event, role }) => {
  if (role !== 'participant') return;
  state.currentEvent = event;
  state.currentMode = event.mode || 'live';
  state.currentSongState = event.songState || null;
  state.serverAudioMuted = !!event.audioMuted;
  syncLanguageOptions(event);
  renderLiveView({ announce: false });
  setParticipantUpdating(false);
  setStatus(state.serverAudioMuted ? 'Audio stopped by admin.' : 'Connected.');
  enableWakeLock();
});

socket.on('transcript_entry', (entry) => {
  if (!state.currentEvent) return;
  state.currentEvent.transcripts = state.currentEvent.transcripts || [];
  if (!getEntryById(entry.id)) state.currentEvent.transcripts.push(entry);
  setParticipantUpdating(false);
  renderLiveView({ announce: true });
});

socket.on('transcript_source_updated', (payload) => {
  updateEntryInState(payload);
  setParticipantUpdating(false);
  renderLiveView({ announce: false });
});

socket.on('entry_refreshing', ({ entryId }) => {
  if (entryId && entryId === state.lastLiveEntryId) setParticipantUpdating(true);
});

socket.on('entry_refresh_failed', ({ entryId }) => {
  if (entryId && entryId === state.lastLiveEntryId) setParticipantUpdating(false);
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
  if (!state.fixedEventId) await joinParticipantEvent();
});

socket.on('mode_changed', ({ mode }) => {
  state.currentMode = mode || 'live';
  if (mode === 'song') {
    setStatus('Song mode active on public screen.');
  } else {
    setStatus(state.serverAudioMuted ? 'Audio stopped by admin.' : 'Connected.');
  }
  renderLiveView({ announce: false });
});

socket.on('song_state', (songState) => {
  state.currentMode = 'song';
  state.currentSongState = songState;
  renderLiveView({ announce: false });
});

socket.on('song_clear', () => {
  state.currentMode = 'live';
  state.currentSongState = null;
  renderLiveView({ announce: false });
});

$('languageSelect').addEventListener('change', handleLanguageChange);
$('playAudioBtn').addEventListener('click', () => {
  state.localAudioEnabled = true;
  setStatus(state.serverAudioMuted ? 'Audio stopped by admin.' : 'Audio active.');
  const latestEntry = getLatestEntry();
  if (latestEntry) speakLatestEntry(latestEntry);
});

$('pauseAudioBtn').addEventListener('click', () => {
  state.localAudioEnabled = false;
  stopSpeech();
  setStatus('Local audio paused.');
});

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
});

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    await enableWakeLock();
  }
});

window.addEventListener('beforeunload', async () => {
  await disableWakeLock();
});
