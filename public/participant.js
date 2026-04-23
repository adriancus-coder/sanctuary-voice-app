const socket = io();
const $ = (id) => document.getElementById(id);
let availableLanguages = {};
let participantWakeLock = null;
const participantParams = new URLSearchParams(window.location.search);
const LIVE_ENTRY_MIN_DISPLAY_MS = 2600;
const LIVE_ENTRY_MAX_QUEUE = 4;

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

const state = {
  fixedEventId: participantParams.get('event') || '',
  previewMode: participantParams.get('preview') === '1',
  previewCode: participantParams.get('code') || '',
  currentEvent: null,
  currentLanguage: participantParams.get('lang') || 'no',
  currentMode: 'live',
  currentSongState: null,
  lastLiveEntryId: null,
  visibleLiveEntryId: null,
  awaitingFreshLiveEntry: false,
  liveEntryShownAt: 0,
  liveEntryQueue: [],
  liveEntryTimer: null,
  lastSpokenEntryId: null,
  localAudioEnabled: true,
  serverAudioMuted: false,
  languageInitialized: false,
  participantId: getOrCreateParticipantId(),
  compactMode: participantParams.get('compact') === '1' || localStorage.getItem('sanctuary_voice_participant_compact') === '1',
  focusMode: participantParams.get('focus') === '1' || localStorage.getItem('sanctuary_voice_participant_focus') === '1'
};

let publicEvents = [];

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

const HISTORY_MIN_ITEMS = 4;
const HISTORY_MAX_ITEMS = 8;
const HISTORY_CHAR_BUDGET = 900;

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

function getEntryById(entryId) {
  return (state.currentEvent?.transcripts || []).find((x) => x.id === entryId) || null;
}

function getLatestEntry() {
  const entries = sortEntries(state.currentEvent?.transcripts || []);
  return entries.length ? entries[entries.length - 1] : null;
}

function getVisibleLiveEntry() {
  if (state.awaitingFreshLiveEntry) return null;
  return getEntryById(state.visibleLiveEntryId) || getLatestEntry();
}

function getTextForEntry(entry) {
  return entry?.translations?.[state.currentLanguage] || entry?.original || '';
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

function getHistoryEntries() {
  const entries = sortEntries(state.currentEvent?.transcripts || []);
  if (entries.length <= 1) return [];
  const visibleIndex = entries.findIndex((entry) => entry.id === state.visibleLiveEntryId);
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
  if (!publicEvents.length) {
    box.innerHTML = '<div class="muted">No services are listed yet.</div>';
    return;
  }
  box.innerHTML = publicEvents.map((event) => {
    const langs = (event.targetLangs || []).map(langLabel).join(', ') || 'No target languages';
    const live = !!event.isActive;
    return `
      <div class="participant-event-card ${live ? 'is-live' : 'is-waiting'}">
        <div>
          <div class="entry-head">
            <b>${escapeHtml(event.name || 'Service')}</b>
            <span class="status-pill ${live ? 'active' : ''}">${live ? 'Live now' : 'Not live yet'}</span>
          </div>
          <div class="small">${escapeHtml(formatEventDate(event.scheduledAt || event.createdAt))}</div>
          <div class="small">Languages: ${escapeHtml(langs)}</div>
        </div>
        <button class="btn ${live ? 'btn-primary' : 'btn-dark'}" type="button" data-participant-event="${event.id}" ${live ? '' : 'disabled'}>${live ? 'Join' : 'Waiting'}</button>
      </div>
    `;
  }).join('');
}

async function loadParticipantEvents({ joinFixedIfLive = false } = {}) {
  try {
    const res = await fetch('/api/events/public');
    const data = await res.json();
    if (data.languageNames) availableLanguages = data.languageNames;
    renderParticipantEventList(data.events || []);
    if (state.previewMode && state.fixedEventId) {
      await joinParticipantEvent(state.fixedEventId);
      return;
    }
    if (joinFixedIfLive && state.fixedEventId) {
      const fixedEvent = (data.events || []).find((event) => event.id === state.fixedEventId);
      if (fixedEvent?.isActive) {
        await joinParticipantEvent(fixedEvent.id);
        return;
      }
      setStatus('This event is not live yet.');
    } else if (!state.currentEvent) {
      setStatus('Choose a live event.');
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

function renderLiveView({ announce = false } = {}) {
  if (!state.currentEvent) return;
  if (state.currentMode === 'song' && state.currentSongState) {
    const songText = getSongTextForCurrentLanguage(state.currentSongState) || 'Waiting for song translation...';
    $('lastText').textContent = songText;
    renderHistory();
    updateTopMeta();
    return;
  }
  const visibleEntry = getVisibleLiveEntry();
  state.lastLiveEntryId = visibleEntry?.id || null;
  $('lastText').textContent = visibleEntry ? getTextForEntry(visibleEntry) : 'Waiting for translation...';
  renderHistory();
  updateTopMeta();
  if (announce && visibleEntry && visibleEntry.id !== state.lastSpokenEntryId) {
    state.lastSpokenEntryId = visibleEntry.id;
    speakLatestEntry(visibleEntry);
  }
}

function showLiveEntry(entry, { announce = false } = {}) {
  if (!entry) return;
  state.awaitingFreshLiveEntry = false;
  state.visibleLiveEntryId = entry.id;
  state.liveEntryShownAt = Date.now();
  renderLiveView({ announce });
}

function waitForFreshLiveEntry() {
  state.awaitingFreshLiveEntry = true;
  state.visibleLiveEntryId = null;
  state.liveEntryQueue = [];
  if (state.liveEntryTimer) clearTimeout(state.liveEntryTimer);
  state.liveEntryTimer = null;
  state.liveEntryShownAt = Date.now();
}

function scheduleNextLiveEntry() {
  if (state.liveEntryTimer) clearTimeout(state.liveEntryTimer);
  if (state.currentMode === 'song' || !state.liveEntryQueue.length) return;

  const elapsed = Date.now() - (state.liveEntryShownAt || 0);
  const waitMs = Math.max(0, LIVE_ENTRY_MIN_DISPLAY_MS - elapsed);
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
  if (!state.visibleLiveEntryId) {
    showLiveEntry(entry, { announce: true });
    return;
  }
  if (entry.id === state.visibleLiveEntryId || state.liveEntryQueue.some((item) => item.id === entry.id)) return;
  state.liveEntryQueue.push(entry);
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
}

function handleLanguageChange() {
  state.currentLanguage = $('languageSelect').value;
  if (state.currentEvent?.id) {
    socket.emit('participant_language', { eventId: state.currentEvent.id, language: state.currentLanguage });
  }
  renderLiveView({ announce: false });
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

socket.on('joined_event', ({ event, role }) => {
  if (role !== 'participant' && role !== 'participant_preview') return;
  state.currentEvent = event;
  state.currentMode = event.mode || 'live';
  state.currentSongState = event.songState || null;
  state.serverAudioMuted = !!event.audioMuted;
  state.awaitingFreshLiveEntry = false;
  state.liveEntryQueue = [];
  if (state.liveEntryTimer) clearTimeout(state.liveEntryTimer);
  state.liveEntryTimer = null;
  const chooser = $('participantEventChooser');
  if (chooser) chooser.hidden = true;
  syncLanguageOptions(event);
  state.visibleLiveEntryId = getLatestEntry()?.id || null;
  state.liveEntryShownAt = Date.now();
  renderLiveView({ announce: false });
  setParticipantUpdating(false);
  setStatus(state.serverAudioMuted ? 'Audio stopped by admin.' : 'Connected.');
  if (state.previewMode) {
    document.body.classList.add('participant-preview-mode');
    setStatus('Moderator preview.');
  } else {
    enableWakeLock();
  }
});

socket.on('transcript_entry', (entry) => {
  if (!state.currentEvent) return;
  state.currentEvent.transcripts = state.currentEvent.transcripts || [];
  if (!getEntryById(entry.id)) state.currentEvent.transcripts.push(entry);
  setParticipantUpdating(false);
  state.awaitingFreshLiveEntry = false;
  enqueueLiveEntry(entry);
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
  await loadParticipantEvents({ joinFixedIfLive: !!state.fixedEventId });
  if (state.currentEvent && !publicEvents.some((event) => event.id === state.currentEvent.id && event.isActive)) {
    state.currentEvent = null;
    state.currentMode = 'live';
    state.currentSongState = null;
    state.visibleLiveEntryId = null;
    state.liveEntryQueue = [];
    if (state.liveEntryTimer) clearTimeout(state.liveEntryTimer);
    state.liveEntryTimer = null;
    $('participantEventName').textContent = 'Choose a live event';
    $('participantEventMeta').textContent = 'The previous event is no longer live.';
    $('lastText').textContent = 'Waiting for live event...';
    $('history').innerHTML = '';
    const chooser = $('participantEventChooser');
    if (chooser) chooser.hidden = false;
  }
});

socket.on('mode_changed', ({ mode }) => {
  state.currentMode = mode || 'live';
  if (state.currentEvent) state.currentEvent.mode = state.currentMode;
  syncLanguageOptions({ ...state.currentEvent, mode: state.currentMode, songState: state.currentSongState });
  if (mode === 'song') {
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
  state.liveEntryQueue = [];
  if (state.liveEntryTimer) clearTimeout(state.liveEntryTimer);
  state.liveEntryTimer = null;
  syncLanguageOptions({ ...state.currentEvent, mode: 'song', songState });
  renderLiveView({ announce: false });
});

socket.on('song_clear', () => {
  state.currentMode = 'live';
  state.currentSongState = null;
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
  await loadParticipantEvents({ joinFixedIfLive: !!state.fixedEventId });
});

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    await enableWakeLock();
  }
});

window.addEventListener('beforeunload', async () => {
  await disableWakeLock();
});
