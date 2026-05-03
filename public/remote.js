const socket = io();
const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(window.location.search);
const state = {
  fixedEventId: params.get('event') || '',
  eventId: params.get('event') || '',
  accessCode: params.get('code') || '',
  currentEvent: null,
  availableLanguages: {},
  access: null,
  globalSongLibrary: [],
  glossaryOpen: false,
  liveAudio: {
    running: false,
    stream: null,
    context: null,
    source: null,
    processor: null,
    analyser: null,
    levelFrame: null
  }
};

const remoteProfileLabels = {
  main_screen: 'Main Screen only',
  song_only: 'Song only',
  main_and_song: 'Main Screen + Song',
  full: 'Full operator'
};

function langLabel(code) {
  return state.availableLanguages[code] || String(code || '').toUpperCase();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function setStatus(text) {
  $('remoteStatus').textContent = text;
}

function setLiveAudioStatus(text) {
  const el = $('remoteLiveAudioStatus');
  if (el) el.textContent = text;
}

function formatDateTime(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function can(permission) {
  const permissions = state.access?.permissions || [];
  if (!permissions.length) return true;
  return permissions.includes(permission);
}

function eventCodeOptions(method, payload = {}) {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, code: state.accessCode })
  };
}

async function resolveRemoteEventId() {
  if (state.fixedEventId) return state.fixedEventId;
  try {
    const res = await fetch('/api/events/active');
    const data = await res.json();
    if (data.ok && data.event?.id) return data.event.id;
  } catch (_) {}
  return '';
}

function updateHeader() {
  $('remoteEventName').textContent = state.currentEvent?.name || 'Remote control';
  const displayState = state.currentEvent?.displayState || {};
  const modeLabel = displayState.blackScreen
    ? 'Black screen'
    : ({ auto: 'Live follow', manual: 'Pinned text', song: 'Song' }[displayState.mode] || 'Live follow');
  $('remoteModeBadge').textContent = displayState.sceneLabel || modeLabel;
  $('remoteLanguageBadge').textContent = displayState.blackScreen ? '-' : langLabel(displayState.language || 'no');
  $('remoteSongLabel').textContent = state.currentEvent?.songState?.blockLabels?.[state.currentEvent?.songState?.currentIndex] || 'No active verse';
  const profileBadge = $('remoteAccessProfileBadge');
  if (profileBadge) {
    const profile = state.access?.operator?.profile || '';
    profileBadge.textContent = remoteProfileLabels[profile] || 'Remote operator';
  }
}

function getLatestRemoteEntry() {
  const entries = Array.isArray(state.currentEvent?.transcripts) ? [...state.currentEvent.transcripts] : [];
  entries.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  return entries.length ? entries[entries.length - 1] : null;
}

function getRemoteDisplayLanguage() {
  return state.currentEvent?.displayState?.language || state.currentEvent?.targetLangs?.[0] || 'no';
}

function getRemoteDisplayLanguages() {
  const primary = getRemoteDisplayLanguage();
  const secondary = state.currentEvent?.displayState?.secondaryLanguage || '';
  return secondary && secondary !== primary ? [primary, secondary] : [primary];
}

function getRemoteParticipantLanguage() {
  return state.currentEvent?.participantPreviewLang
    || state.currentEvent?.targetLangs?.[0]
    || getRemoteDisplayLanguage();
}

function getRemoteMainPreviewTextForLanguage(displayLang) {
  const event = state.currentEvent;
  if (!event) return 'Waiting for preview…';
  const displayState = event.displayState || {};
  if (displayState.blackScreen) return 'Black screen';
  if (displayState.mode === 'song') {
    const songState = event.songState || {};
    const sourceLang = songState.sourceLang || event.sourceLang || 'ro';
    if (displayLang === sourceLang) return songState.activeBlock || 'Waiting for song…';
    return songState.translations?.[displayLang] || songState.activeBlock || 'Waiting for song translation…';
  }
  if (displayState.mode === 'manual') {
    const sourceLang = displayState.manualSourceLang || event.sourceLang || 'ro';
    if (displayLang === sourceLang) return displayState.manualSource || 'Pinned text mode';
    return displayState.manualTranslations?.[displayLang] || displayState.manualSource || 'Pinned text mode';
  }
  const latestEntry = getLatestRemoteEntry();
  if (!latestEntry) return 'Waiting for live translation…';
  return latestEntry.translations?.[displayLang] || latestEntry.original || 'Waiting for live translation…';
}

function getRemoteMainPreviewText() {
  const event = state.currentEvent;
  if (!event) return 'Waiting for previewâ€¦';
  if (event.displayState?.blackScreen) return 'Black screen';
  const languages = getRemoteDisplayLanguages();
  if (languages.length === 1) return getRemoteMainPreviewTextForLanguage(languages[0]);
  return languages
    .map((lang) => `${langLabel(lang)}: ${getRemoteMainPreviewTextForLanguage(lang)}`)
    .join('\n\n');
}

function getRemoteParticipantPreviewText() {
  const event = state.currentEvent;
  if (!event) return 'Waiting for participant preview…';
  const participantLang = getRemoteParticipantLanguage();
  if ((event.displayState?.mode || 'auto') === 'song') {
    const songState = event.songState || {};
    const sourceLang = songState.sourceLang || event.sourceLang || 'ro';
    if (participantLang === sourceLang) return songState.activeBlock || 'Waiting for song…';
    return songState.translations?.[participantLang] || songState.activeBlock || 'Waiting for song translation…';
  }
  const latestEntry = getLatestRemoteEntry();
  return latestEntry?.translations?.[participantLang] || latestEntry?.original || 'Waiting for translation…';
}

function renderRemoteSimplePreviews() {
  const mainMeta = $('remoteMainPreviewMeta');
  const participantMeta = $('remoteParticipantPreviewMeta');
  const mainText = $('remoteMainPreviewText');
  const participantText = $('remoteParticipantPreviewText');
  if (!mainText || !participantText) return;
  const event = state.currentEvent;
  if (!event) {
    if (mainMeta) mainMeta.textContent = 'Waiting for event…';
    if (participantMeta) participantMeta.textContent = 'Waiting for event…';
    mainText.textContent = 'Waiting for preview…';
    participantText.textContent = 'Waiting for preview…';
    return;
  }
  const displayState = event.displayState || {};
  const previewLangs = getRemoteDisplayLanguages();
  const previewLang = previewLangs[0];
  const participantLang = getRemoteParticipantLanguage();
  if (mainMeta) {
    mainMeta.textContent = displayState.blackScreen
      ? 'Black screen'
      : `${({ auto: 'Live follow', manual: 'Pinned text', song: 'Song' }[displayState.mode] || 'Live follow')} · ${langLabel(previewLang)}`;
  }
  if (participantMeta) {
    participantMeta.textContent = `Participant language · ${langLabel(participantLang)}`;
  }
  mainText.textContent = getRemoteMainPreviewText();
  participantText.textContent = getRemoteParticipantPreviewText();
}

function getRemoteMainScreenUrl() {
  const code = state.accessCode || '';
  const eventId = state.currentEvent?.id || state.eventId || '';
  if (!eventId) return '';
  const params = new URLSearchParams({ event: eventId });
  if (code) params.set('code', code);
  return `/translate?${params.toString()}`;
}

function openRemoteMainScreen() {
  const url = getRemoteMainScreenUrl();
  if (!url) {
    setStatus('No live event connected yet.');
    return;
  }
  window.open(url, '_blank', 'noopener');
  setStatus('Main screen opened. Move that tab to the projector if needed.');
}

function filterAndSortRemoteLibrary(items = []) {
  const query = ($('remoteSongLibrarySearch')?.value || '').trim().toLowerCase();
  const sortMode = $('remoteSongLibrarySort')?.value || 'az';
  return (Array.isArray(items) ? items : [])
    .filter((item) => String(item.title || '').toLowerCase().includes(query))
    .sort((a, b) => {
      if (sortMode === 'recent') {
        return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
      }
      return String(a.title || '').localeCompare(String(b.title || ''));
    });
}

function renderRemoteSongLibrary() {
  const box = $('remoteSongLibraryList');
  if (!box) return;
  const items = filterAndSortRemoteLibrary(state.globalSongLibrary);
  if (!items.length) {
    box.innerHTML = '<div class="muted">No songs available in church library.</div>';
    return;
  }
  box.innerHTML = items.map((item) => `
    <button class="remote-library-pill" type="button" data-remote-song-library-action="open" data-remote-song-library-id="${item.id}">
      <span>${escapeHtml(item.title || 'Untitled song')}</span>
      <small>${escapeHtml(langLabel(item.sourceLang || state.currentEvent?.sourceLang || 'ro'))}</small>
    </button>
  `).join('');
}

function renderRemoteSongJumpSelect() {
  const select = $('remoteSongJumpSelect');
  if (!select) return;
  const previousValue = select.value;
  const songState = state.currentEvent?.songState || {};
  const blocks = Array.isArray(songState.blocks) ? songState.blocks : [];
  const labels = Array.isArray(songState.blockLabels) ? songState.blockLabels : [];
  const currentIndex = Number.isInteger(songState.currentIndex) ? songState.currentIndex : -1;
  if (!blocks.length) {
    select.innerHTML = '<option value="">No song sections yet</option>';
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.innerHTML = blocks.map((block, index) => {
    const label = labels[index] || `Verse ${index + 1}`;
    const preview = String(block || '').split('\n').find(Boolean) || '';
    const optionText = `${label}${preview ? ` - ${preview.slice(0, 48)}` : ''}`;
    return `<option value="${index}">${escapeHtml(optionText)}</option>`;
  }).join('');
  if (previousValue !== '' && Number(previousValue) >= 0 && Number(previousValue) < blocks.length) {
    select.value = previousValue;
  } else if (currentIndex >= 0 && currentIndex < blocks.length) {
    select.value = String(currentIndex);
  }
}

function getDisplayLanguageChoicesRemote() {
  const langs = Array.isArray(state.currentEvent?.targetLangs) ? [...state.currentEvent.targetLangs] : [];
  const mode = state.currentEvent?.displayState?.mode || 'auto';
  if (mode === 'song') {
    const sourceLang = String(state.currentEvent?.songState?.sourceLang || state.currentEvent?.sourceLang || '').trim();
    if (sourceLang && !langs.includes(sourceLang)) langs.push(sourceLang);
  }
  if (mode === 'manual') {
    const sourceLang = String(state.currentEvent?.displayState?.manualSourceLang || state.currentEvent?.sourceLang || '').trim();
    if (sourceLang && !langs.includes(sourceLang)) langs.push(sourceLang);
  }
  return langs;
}

function populateRemoteLanguageSelects() {
  const available = Object.entries(state.availableLanguages || {});
  const songLangSelect = $('remoteSongSourceLang');
  const glossaryLangSelect = $('remoteGlossaryLang');
  [songLangSelect, glossaryLangSelect].forEach((select) => {
    if (!select) return;
    const currentValue = select.value;
    select.innerHTML = available.map(([code, label]) => `<option value="${code}">${label}</option>`).join('');
    if (currentValue && state.availableLanguages[currentValue]) {
      select.value = currentValue;
    } else if (state.currentEvent?.sourceLang && state.availableLanguages[state.currentEvent.sourceLang]) {
      select.value = state.currentEvent.sourceLang;
    } else if (available[0]?.[0]) {
      select.value = available[0][0];
    }
  });

  // Display language selects (primary + secondary). Folosim getDisplayLanguageChoicesRemote
  // care include automat sourceLang când mode-ul e 'song' sau 'manual' - util pentru
  // afișarea cântecelor sau pinned text în limba originală.
  const displayLangChoices = getDisplayLanguageChoicesRemote();
  const primarySelect = $('remoteDisplayLanguageSelect');
  const secondarySelect = $('remoteDisplaySecondaryLanguageSelect');
  if (primarySelect) {
    const currentPrimary = state.currentEvent?.displayState?.language || displayLangChoices[0] || '';
    primarySelect.innerHTML = displayLangChoices
      .map((code) => `<option value="${code}">${state.availableLanguages[code] || code.toUpperCase()}</option>`)
      .join('');
    if (currentPrimary && displayLangChoices.includes(currentPrimary)) {
      primarySelect.value = currentPrimary;
    }
  }
  if (secondarySelect) {
    const currentSecondary = state.currentEvent?.displayState?.secondaryLanguage || '';
    secondarySelect.innerHTML = '<option value="">— None —</option>'
      + displayLangChoices
          .map((code) => `<option value="${code}">${state.availableLanguages[code] || code.toUpperCase()}</option>`)
          .join('');
    secondarySelect.value = currentSecondary;
  }
}

function updateRemoteGlossaryMode() {
  const mode = $('remoteGlossaryMode')?.value || 'translation';
  const translationFields = $('remoteTranslationGlossaryFields');
  const sourceFields = $('remoteSourceCorrectionFields');
  const langWrap = $('remoteGlossaryLangWrap');
  if (translationFields) translationFields.style.display = mode === 'translation' ? 'grid' : 'none';
  if (sourceFields) sourceFields.style.display = mode === 'source' ? 'grid' : 'none';
  if (langWrap) langWrap.style.display = mode === 'translation' ? 'block' : 'none';
}

function syncGlossaryToggle() {
  const body = $('remoteGlossaryBody');
  const btn = $('remoteGlossaryToggleBtn');
  if (!body || !btn) return;
  body.hidden = !state.glossaryOpen;
  btn.textContent = state.glossaryOpen ? 'Hide glossary' : 'Open glossary';
}

function downsampleRemoteTo16kPcm(input, inputRate) {
  const outputRate = 16000;
  if (!input?.length) return new ArrayBuffer(0);
  const ratio = inputRate / outputRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Int16Array(outputLength);
  let inputOffset = 0;
  for (let i = 0; i < outputLength; i++) {
    const nextOffset = Math.round((i + 1) * ratio);
    let sum = 0;
    let count = 0;
    for (let j = inputOffset; j < nextOffset && j < input.length; j++) {
      sum += input[j];
      count += 1;
    }
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, count)));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    inputOffset = nextOffset;
  }
  return output.buffer;
}

function renderRemoteLiveAudioState() {
  const startBtn = $('remoteStartLiveAudioBtn');
  const stopBtn = $('remoteStopLiveAudioBtn');
  if (startBtn) {
    startBtn.textContent = state.liveAudio.running ? 'On-Air' : 'Start translation';
    startBtn.classList.toggle('btn-danger', state.liveAudio.running);
    startBtn.classList.toggle('btn-primary', !state.liveAudio.running);
  }
  if (stopBtn) stopBtn.disabled = !state.liveAudio.running;
}

function startRemoteMeterLoop() {
  const meter = $('remoteAudioLevel');
  if (!meter || !state.liveAudio.analyser) return;
  const data = new Uint8Array(state.liveAudio.analyser.fftSize);
  const draw = () => {
    if (!state.liveAudio.analyser) return;
    state.liveAudio.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const normalized = (data[i] - 128) / 128;
      sum += normalized * normalized;
    }
    const rms = Math.sqrt(sum / data.length);
    const db = 20 * Math.log10(Math.max(rms, 0.00001));
    meter.value = Math.max(0, Math.min(100, Math.round(((db + 60) / 60) * 100)));
    state.liveAudio.levelFrame = requestAnimationFrame(draw);
  };
  draw();
}

async function stopRemoteLiveAudio() {
  state.liveAudio.running = false;
  if (state.eventId) socket.emit('azure_audio_stop', { eventId: state.eventId });
  if (state.liveAudio.levelFrame) cancelAnimationFrame(state.liveAudio.levelFrame);
  state.liveAudio.levelFrame = null;
  if (state.liveAudio.source && state.liveAudio.processor) {
    try { state.liveAudio.source.disconnect(state.liveAudio.processor); } catch (_) {}
  }
  if (state.liveAudio.source && state.liveAudio.analyser) {
    try { state.liveAudio.source.disconnect(state.liveAudio.analyser); } catch (_) {}
  }
  if (state.liveAudio.processor) {
    try { state.liveAudio.processor.disconnect(); } catch (_) {}
    state.liveAudio.processor.onaudioprocess = null;
  }
  if (state.liveAudio.stream) {
    state.liveAudio.stream.getTracks().forEach((track) => track.stop());
  }
  if (state.liveAudio.context) {
    await state.liveAudio.context.close().catch(() => {});
  }
  state.liveAudio.stream = null;
  state.liveAudio.context = null;
  state.liveAudio.source = null;
  state.liveAudio.processor = null;
  state.liveAudio.analyser = null;
  if ($('remoteAudioLevel')) $('remoteAudioLevel').value = 0;
  renderRemoteLiveAudioState();
}

async function startRemoteLiveAudio() {
  if (!state.currentEvent || !state.eventId) return setLiveAudioStatus('No live event connected.');
  await stopRemoteLiveAudio();
  try {
    await post(`/api/events/${state.eventId}/mode`, { mode: 'live' });
    state.liveAudio.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 48000,
        sampleSize: 16,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });
    state.liveAudio.context = new (window.AudioContext || window.webkitAudioContext)();
    await state.liveAudio.context.resume();
    state.liveAudio.source = state.liveAudio.context.createMediaStreamSource(state.liveAudio.stream);
    state.liveAudio.analyser = state.liveAudio.context.createAnalyser();
    state.liveAudio.analyser.fftSize = 2048;
    state.liveAudio.processor = state.liveAudio.context.createScriptProcessor(4096, 1, 1);
    state.liveAudio.processor.onaudioprocess = (event) => {
      if (!state.liveAudio.running) return;
      const pcm = downsampleRemoteTo16kPcm(event.inputBuffer.getChannelData(0), state.liveAudio.context.sampleRate);
      if (pcm.byteLength) socket.emit('azure_audio_chunk', { eventId: state.eventId, audio: pcm });
    };
    state.liveAudio.source.connect(state.liveAudio.analyser);
    state.liveAudio.source.connect(state.liveAudio.processor);
    state.liveAudio.processor.connect(state.liveAudio.context.destination);
    state.liveAudio.running = true;
    socket.emit('azure_audio_start', { eventId: state.eventId });
    startRemoteMeterLoop();
    renderRemoteLiveAudioState();
    setLiveAudioStatus('On-Air. Listening from this device.');
    setStatus('Remote translation started.');
  } catch (err) {
    await stopRemoteLiveAudio();
    setLiveAudioStatus(err.message || 'Could not start remote translation.');
    setStatus(err.message || 'Could not start remote translation.');
  }
}

function clearRemoteSongEditor() {
  if ($('remoteSongTitle')) $('remoteSongTitle').value = '';
  if ($('remoteSongText')) $('remoteSongText').value = '';
  if ($('remoteSongSourceLang')) $('remoteSongSourceLang').value = state.currentEvent?.sourceLang || 'ro';
}

function renderQuickLanguages() {
  const box = $('remoteQuickLanguages');
  const langs = getDisplayLanguageChoicesRemote();
  if (!langs.length) {
    box.innerHTML = '<div class="muted">Waiting for event languages...</div>';
    return;
  }
  box.innerHTML = langs.map((lang) => {
    const active = state.currentEvent?.displayState?.language === lang;
    return `<button class="btn ${active ? 'btn-primary' : 'btn-dark'}" type="button" data-remote-language="${lang}">${langLabel(lang)}</button>`;
  }).join('');
}

function renderPresets() {
  const box = $('remotePresetsList');
  if (!box) return;
  const presets = state.currentEvent?.displayPresets || [];
  if (!presets.length) {
    box.innerHTML = '<div class="muted">No presets available.</div>';
    return;
  }
  box.innerHTML = presets.map((preset) => `
    <div class="history-item">
      <div><b>${preset.name}</b></div>
      <div class="actions">
        <button class="btn btn-primary" type="button" data-remote-preset="${preset.id}">Apply</button>
      </div>
    </div>
  `).join('');
}

async function loadRemoteSongLibrary() {
  if (!state.eventId) return;
  try {
    const res = await fetch(`/api/events/${state.eventId}/global-song-library`);
    const data = await res.json();
    state.globalSongLibrary = data.globalSongLibrary || [];
    renderRemoteSongLibrary();
  } catch (_) {
    const box = $('remoteSongLibraryList');
    if (box) box.innerHTML = '<div class="muted">Could not load church library.</div>';
  }
}

function refreshRemoteUi() {
  const displayState = state.currentEvent?.displayState || {};
  const activeMode = displayState.blackScreen ? 'blank' : (displayState.mode || 'auto');
  const mainScreenAllowed = can('main_screen');
  const songAllowed = can('song');
  const glossaryAllowed = can('glossary');
  [
    { id: 'remoteLiveBtn', active: activeMode === 'auto', activeClass: 'btn-primary', visible: mainScreenAllowed },
    { id: 'remotePinnedBtn', active: activeMode === 'manual', activeClass: 'btn-primary', visible: mainScreenAllowed },
    { id: 'remoteSongBtn', active: activeMode === 'song', activeClass: 'btn-primary', visible: songAllowed },
    { id: 'remoteBlackBtn', active: activeMode === 'blank', activeClass: 'btn-danger', visible: mainScreenAllowed },
    { id: 'remoteUndoBtn', active: false, activeClass: 'btn-primary', visible: mainScreenAllowed }
  ].forEach(({ id, active, activeClass, visible }) => {
    const btn = $(id);
    if (!btn) return;
    btn.hidden = !visible;
    btn.disabled = !visible;
    btn.classList.remove('btn-primary', 'btn-danger', 'btn-dark');
    btn.classList.add(active ? activeClass : 'btn-dark');
  });
  const quickLanguages = $('remoteQuickLanguages');
  const shortcuts = $('remoteShortcuts');
  const presetsList = $('remotePresetsList');
  const mainScreenPanel = $('remoteMainScreenPanel');
  const songPanel = $('remoteSongJumpBtn')?.closest('.panel');
  const fallbackSongPanel = $('remoteSongJumpSelect')?.closest('.panel');
  const presetsPanel = presetsList?.closest('.panel');
  const songEditorPanel = $('remoteSongEditorPanel');
  const churchLibraryPanel = $('remoteChurchLibraryPanel');
  const glossaryPanel = $('remoteGlossaryPanel');
  const liveAudioPanel = $('remoteLiveAudioPanel');
  const openMainScreenBtn = $('remoteOpenMainScreenBtn');
  if (mainScreenPanel) mainScreenPanel.hidden = !mainScreenAllowed;
  if (liveAudioPanel) liveAudioPanel.hidden = !mainScreenAllowed;
  if (openMainScreenBtn) {
    openMainScreenBtn.hidden = !mainScreenAllowed;
    openMainScreenBtn.disabled = !mainScreenAllowed || !state.eventId;
  }
  if (quickLanguages) quickLanguages.hidden = !mainScreenAllowed;
  if (shortcuts) shortcuts.hidden = !mainScreenAllowed;
  const dualToggle = $('remoteDualLanguageToggle');
  if (dualToggle) {
    dualToggle.checked = !!state.currentEvent?.displayState?.secondaryLanguage;
    dualToggle.disabled = !mainScreenAllowed;
    const wrapper = dualToggle.closest('.info-card');
    if (wrapper) wrapper.hidden = !mainScreenAllowed;
  }
  if (songPanel || fallbackSongPanel) (songPanel || fallbackSongPanel).hidden = !songAllowed;
  if (presetsPanel) presetsPanel.hidden = !mainScreenAllowed;
  if (churchLibraryPanel) churchLibraryPanel.hidden = !songAllowed;
  if (songEditorPanel) songEditorPanel.hidden = !songAllowed;
  if (glossaryPanel) glossaryPanel.hidden = !glossaryAllowed;
  updateHeader();
  populateRemoteLanguageSelects();
  updateRemoteGlossaryMode();
  syncGlossaryToggle();
  renderRemoteSimplePreviews();
  renderRemoteSongJumpSelect();
  renderRemoteSongLibrary();
  renderRemoteLiveAudioState();
  if (mainScreenAllowed) {
    renderQuickLanguages();
    renderPresets();
  }
}

async function post(path, payload = {}) {
  const res = await fetch(path, eventCodeOptions('POST', payload));
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Request failed.');
  if (data.event) state.currentEvent = data.event;
  if (data.displayState && state.currentEvent) {
    state.currentEvent.displayState = data.displayState;
  }
  if (data.presets && state.currentEvent) {
    state.currentEvent.displayPresets = data.presets;
  }
  if (data.songState && state.currentEvent) {
    state.currentEvent.songState = data.songState;
  }
  refreshRemoteUi();
  return data;
}

async function join() {
  const eventId = await resolveRemoteEventId();
  if (!eventId) {
    state.eventId = '';
    state.currentEvent = null;
    refreshRemoteUi();
    setStatus('No live event yet. This permanent remote will connect automatically when an event goes live.');
    return;
  }
  state.eventId = eventId;
  if (!state.accessCode) {
    state.accessCode = (prompt('Enter moderator code or PIN:') || '').trim();
  }
  if (!state.accessCode) {
    setStatus('Missing moderator code or PIN.');
    return;
  }
  socket.emit('join_event', {
    eventId: state.eventId,
    role: 'screen',
    code: state.accessCode
  });
}

socket.on('connect', join);
socket.on('disconnect', () => setStatus('Reconnecting...'));
socket.on('join_error', ({ message }) => setStatus(message || 'Cannot join remote control.'));
socket.on('joined_event', ({ role, event, access }) => {
  if (role !== 'screen') return;
  state.currentEvent = event;
  state.eventId = event?.id || state.eventId;
  state.access = access || null;
  clearRemoteSongEditor();
  refreshRemoteUi();
  loadRemoteSongLibrary();
  setStatus(access?.operator?.name ? `Remote control connected as ${access.operator.name}.` : 'Remote control connected.');
});
socket.on('active_event_changed', async ({ eventId }) => {
  if (state.fixedEventId) return;
  if (state.liveAudio.running) await stopRemoteLiveAudio();
  state.eventId = eventId || '';
  state.currentEvent = null;
  await join();
});
socket.on('azure_audio_ready', () => {
  if (state.liveAudio.running) setLiveAudioStatus('On-Air. Azure Speech connected.');
});
socket.on('server_error', ({ message }) => {
  setLiveAudioStatus(message || 'Server error.');
  setStatus(message || 'Server error.');
});
socket.on('display_mode_changed', (payload) => {
  if (!state.currentEvent) return;
  state.currentEvent.displayState = {
    ...(state.currentEvent.displayState || {}),
    ...payload
  };
  if (Array.isArray(payload.presets)) state.currentEvent.displayPresets = payload.presets;
  refreshRemoteUi();
});
socket.on('display_manual_update', (payload) => {
  if (!state.currentEvent) return;
  state.currentEvent.displayState = {
    ...(state.currentEvent.displayState || {}),
    ...payload
  };
  if (Array.isArray(payload.presets)) state.currentEvent.displayPresets = payload.presets;
  refreshRemoteUi();
});
socket.on('song_state', (songState) => {
  if (!state.currentEvent) return;
  state.currentEvent.songState = songState;
  refreshRemoteUi();
});
socket.on('song_clear', () => {
  if (!state.currentEvent) return;
  state.currentEvent.songState = null;
  refreshRemoteUi();
});
socket.on('display_presets_updated', ({ presets }) => {
  if (!state.currentEvent) return;
  state.currentEvent.displayPresets = presets || [];
  refreshRemoteUi();
});
socket.on('service_ended', (payload) => {
  if (state.currentEvent?.id && payload?.eventId && payload.eventId !== state.currentEvent.id) return;
  setStatus('Serviciu încheiat — participanții au fost notificați.');
});

$('remoteLiveBtn').addEventListener('click', async () => {
  try { await post(`/api/events/${state.eventId}/display/mode`, { mode: 'auto' }); setStatus('Main screen set to live follow.'); } catch (err) { setStatus(err.message); }
});
$('remoteStartLiveAudioBtn')?.addEventListener('click', () => startRemoteLiveAudio());

$('remoteDisplayLanguageSelect')?.addEventListener('change', () => {
  const primary = $('remoteDisplayLanguageSelect').value;
  const secondary = $('remoteDisplaySecondaryLanguageSelect')?.value || '';
  if (primary) setRemoteDisplayLanguage(primary, secondary);
});

$('remoteDisplaySecondaryLanguageSelect')?.addEventListener('change', () => {
  const primary = $('remoteDisplayLanguageSelect')?.value || '';
  const secondary = $('remoteDisplaySecondaryLanguageSelect').value;
  if (primary) setRemoteDisplayLanguage(primary, secondary);
});
$('remoteStopLiveAudioBtn')?.addEventListener('click', () => stopRemoteLiveAudio().then(() => {
  setLiveAudioStatus('Stopped.');
  setStatus('Remote translation stopped.');
}));
$('remotePinnedBtn').addEventListener('click', async () => {
  try { await post(`/api/events/${state.eventId}/display/mode`, { mode: 'manual' }); setStatus('Main screen set to pinned text.'); } catch (err) { setStatus(err.message); }
});
$('remoteSongBtn').addEventListener('click', async () => {
  try { await post(`/api/events/${state.eventId}/display/mode`, { mode: 'song' }); setStatus('Main screen set to Song mode.'); } catch (err) { setStatus(err.message); }
});
$('remoteBlackBtn').addEventListener('click', async () => {
  try { await post(`/api/events/${state.eventId}/display/blank`); setStatus('Main screen set to black screen.'); } catch (err) { setStatus(err.message); }
});
$('remoteUndoBtn').addEventListener('click', async () => {
  try { await post(`/api/events/${state.eventId}/display/restore-last`); setStatus('Restored previous screen state.'); } catch (err) { setStatus(err.message); }
});
$('remoteOpenMainScreenBtn')?.addEventListener('click', openRemoteMainScreen);
$('remotePrevSongBtn')?.addEventListener('click', async () => {
  try { await post(`/api/events/${state.eventId}/song/prev`); setStatus('Moved to previous verse.'); } catch (err) { setStatus(err.message); }
});
$('remoteNextSongBtn')?.addEventListener('click', async () => {
  try { await post(`/api/events/${state.eventId}/song/next`); setStatus('Moved to next verse.'); } catch (err) { setStatus(err.message); }
});
async function showRemoteSelectedSongSection() {
  const index = Number($('remoteSongJumpSelect')?.value);
  if (!Number.isInteger(index)) return;
  try {
    await post(`/api/events/${state.eventId}/song/show/${index}`);
    setStatus('Selected song section sent live.');
  } catch (err) {
    setStatus(err.message);
  }
}

$('remoteSongJumpBtn')?.addEventListener('click', showRemoteSelectedSongSection);
$('remoteSongJumpSelect')?.addEventListener('change', showRemoteSelectedSongSection);

$('remoteQuickLanguages').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-remote-language]');
  if (!btn) return;
  try {
    await post(`/api/events/${state.eventId}/display/language`, { language: btn.getAttribute('data-remote-language') });
    setStatus('Screen language updated.');
  } catch (err) {
    setStatus(err.message);
  }
});

$('remoteDualLanguageToggle')?.addEventListener('change', async (e) => {
  if (!state.eventId) return;
  const enabled = !!e.target.checked;
  const langs = (state.currentEvent?.targetLangs || []).filter(Boolean);
  const primary = state.currentEvent?.displayState?.language || langs[0] || 'no';
  let secondary = '';
  if (enabled) {
    secondary = state.currentEvent?.displayState?.secondaryLanguage
      || langs.find((l) => l !== primary)
      || '';
    if (!secondary) {
      e.target.checked = false;
      setStatus('Dual display needs at least two target languages.');
      return;
    }
  }
  try {
    await post(`/api/events/${state.eventId}/display/language`, { language: primary, secondaryLanguage: secondary });
    setStatus(enabled ? 'Dual language display enabled.' : 'Single language display.');
  } catch (err) {
    e.target.checked = !enabled;
    setStatus(err.message);
  }
});

$('remoteShortcuts')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-remote-shortcut]');
  if (!btn) return;
  try {
    await post(`/api/events/${state.eventId}/display/shortcut`, {
      shortcut: btn.getAttribute('data-remote-shortcut'),
      language: state.currentEvent?.displayState?.language || 'no'
    });
    setStatus('Service shortcut applied.');
  } catch (err) {
    setStatus(err.message);
  }
});

$('remotePresetsList')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-remote-preset]');
  if (!btn) return;
  try {
    await post(`/api/events/${state.eventId}/display-presets/${btn.getAttribute('data-remote-preset')}/apply`);
    setStatus('Preset applied.');
  } catch (err) {
    setStatus(err.message);
  }
});

$('remoteOpenMainPreviewBtn').addEventListener('click', openRemoteMainScreen);

$('remoteOpenParticipantPreviewBtn').addEventListener('click', () => {
  const displayLang = getRemoteParticipantLanguage();
  const url = state.currentEvent?.id
    ? `/participant?event=${encodeURIComponent(state.currentEvent.id)}&preview=1&compact=1&focus=1&lang=${encodeURIComponent(displayLang)}&code=${encodeURIComponent(state.accessCode)}`
    : '';
  if (url) window.open(url, '_blank');
});

$('remoteOpenBothPreviewsBtn')?.addEventListener('click', () => {
  const mainUrl = state.currentEvent?.translateLink || '';
  const displayLang = getRemoteParticipantLanguage();
  const participantUrl = state.currentEvent?.id
    ? `/participant?event=${encodeURIComponent(state.currentEvent.id)}&preview=1&compact=1&focus=1&lang=${encodeURIComponent(displayLang)}&code=${encodeURIComponent(state.accessCode)}`
    : '';
  if (mainUrl) window.open(mainUrl, '_blank');
  if (participantUrl) window.open(participantUrl, '_blank');
});

$('remoteSongClearBtn').addEventListener('click', () => {
  clearRemoteSongEditor();
  setStatus('Song editor cleared.');
});

async function setRemoteDisplayLanguage(language, secondaryLanguage) {
  if (!state.currentEvent || !state.eventId) {
    setStatus('No event connected.');
    return;
  }
  const safeSecondary = secondaryLanguage && secondaryLanguage !== language ? secondaryLanguage : '';
  try {
    const data = await post(`/api/events/${state.eventId}/display/language`, {
      language,
      secondaryLanguage: safeSecondary
    });
    if (!data.ok) {
      setStatus(data.error || 'Could not change screen language.');
      return;
    }
    if (state.currentEvent) {
      state.currentEvent.displayState = data.displayState || state.currentEvent.displayState;
    }
    refreshRemoteUi();
    setStatus('Main screen language updated.');
  } catch (err) {
    setStatus(err.message || 'Could not change screen language.');
  }
}

async function remoteBackToLiveText() {
  try {
    await post(`/api/events/${state.eventId}/mode`, { mode: 'live', scope: 'participant' });
    setStatus('Participants are back on live text. Main screen unchanged.');
  } catch (err) {
    setStatus(err.message);
  }
}
$('remoteBackToLiveTextBtn')?.addEventListener('click', remoteBackToLiveText);
$('remoteBackToLiveTextNavBtn')?.addEventListener('click', remoteBackToLiveText);
$('remoteSongSaveBtn').addEventListener('click', async () => {
  const title = $('remoteSongTitle')?.value.trim() || '';
  const text = $('remoteSongText')?.value.trim() || '';
  const sourceLang = $('remoteSongSourceLang')?.value || state.currentEvent?.sourceLang || 'ro';
  if (!title || !text) return setStatus('Add title and song text first.');
  try {
    const res = await fetch(`/api/events/${state.eventId}/global-song-library`, eventCodeOptions('POST', { title, text, labels: [], sourceLang }));
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Could not save song.');
    state.globalSongLibrary = data.globalSongLibrary || state.globalSongLibrary;
    clearRemoteSongEditor();
    renderRemoteSongLibrary();
    setStatus('Song saved to church library.');
  } catch (err) {
    setStatus(err.message);
  }
});

$('remoteSongSendBtn').addEventListener('click', async () => {
  const title = $('remoteSongTitle')?.value.trim() || '';
  const text = $('remoteSongText')?.value.trim() || '';
  const sourceLang = $('remoteSongSourceLang')?.value || state.currentEvent?.sourceLang || 'ro';
  if (!text) return setStatus('Add song text first.');
  try {
    const res = await fetch(`/api/events/${state.eventId}/song/load`, eventCodeOptions('POST', { title, text, labels: [], sourceLang }));
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Could not send song.');
    state.currentEvent = data.event || state.currentEvent;
    refreshRemoteUi();
    setStatus('Song loaded and first verse sent live.');
  } catch (err) {
    setStatus(err.message);
  }
});

$('remoteGlossaryMode')?.addEventListener('change', updateRemoteGlossaryMode);
$('remoteGlossaryToggleBtn')?.addEventListener('click', () => {
  state.glossaryOpen = !state.glossaryOpen;
  syncGlossaryToggle();
});

$('remoteSongLibrarySearch').addEventListener('input', renderRemoteSongLibrary);
$('remoteSongLibrarySort').addEventListener('change', renderRemoteSongLibrary);
$('remoteSongLibraryList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-remote-song-library-action]');
  if (!btn) return;
  const item = (state.globalSongLibrary || []).find((entry) => entry.id === btn.getAttribute('data-remote-song-library-id'));
  if (!item) return;
  const action = btn.getAttribute('data-remote-song-library-action');
  if (action === 'open') {
    const current = btn.closest('.remote-library-pill');
    const wasOpen = current?.classList.contains('is-open');
    document.querySelectorAll('.remote-library-pill.is-open').forEach((pill) => {
      if (pill !== current) pill.classList.remove('is-open');
    });
    document.querySelectorAll('.remote-library-actions').forEach((actions) => actions.remove());
    current?.classList.toggle('is-open', !wasOpen);
    if (current && !wasOpen) {
      current.insertAdjacentHTML('afterend', `
        <div class="remote-library-actions" data-library-actions-for="${item.id}">
          <div class="small">${escapeHtml(String(item.text || '').slice(0, 180))}${String(item.text || '').length > 180 ? '...' : ''}</div>
          <div class="button-row compact-row">
            <button class="btn btn-dark" type="button" data-remote-song-library-action="load" data-remote-song-library-id="${item.id}">Load in editor</button>
            <button class="btn btn-primary" type="button" data-remote-song-library-action="send" data-remote-song-library-id="${item.id}">Send first verse</button>
          </div>
        </div>
      `);
    }
    return;
  }
  if (action === 'load') {
    if ($('remoteSongTitle')) $('remoteSongTitle').value = item.title || '';
    if ($('remoteSongText')) $('remoteSongText').value = item.text || '';
    if ($('remoteSongSourceLang')) $('remoteSongSourceLang').value = item.sourceLang || state.currentEvent?.sourceLang || 'ro';
    setStatus('Song loaded into editor.');
    return;
  }
  try {
    const res = await fetch(`/api/events/${state.eventId}/song/load`, eventCodeOptions('POST', {
      title: item.title || '',
      text: item.text || '',
      labels: item.labels || [],
      sourceLang: item.sourceLang || state.currentEvent?.sourceLang || 'ro'
    }));
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Could not send song.');
    state.currentEvent = data.event || state.currentEvent;
    refreshRemoteUi();
    setStatus('Song loaded from church library.');
  } catch (err) {
    setStatus(err.message);
  }
});

$('remoteSaveGlossaryBtn')?.addEventListener('click', async () => {
  const source = $('remoteGlossarySource')?.value.trim() || '';
  const target = $('remoteGlossaryTarget')?.value.trim() || '';
  const lang = $('remoteGlossaryLang')?.value || '';
  const permanent = !!$('remoteGlossaryPermanent')?.checked;
  if (!source || !target || !lang) return setStatus('Complete glossary fields first.');
  try {
    const res = await fetch(`/api/events/${state.eventId}/glossary`, eventCodeOptions('POST', { source, target, lang, permanent }));
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Could not save glossary item.');
    $('remoteGlossarySource').value = '';
    $('remoteGlossaryTarget').value = '';
    setStatus('Glossary item saved.');
  } catch (err) {
    setStatus(err.message);
  }
});

$('remoteSaveSourceCorrectionBtn')?.addEventListener('click', async () => {
  const heard = $('remoteSourceWrong')?.value.trim() || '';
  const correct = $('remoteSourceCorrect')?.value.trim() || '';
  const permanent = !!$('remoteGlossaryPermanent')?.checked;
  if (!heard || !correct) return setStatus('Complete correction fields first.');
  try {
    const res = await fetch(`/api/events/${state.eventId}/source-corrections`, eventCodeOptions('POST', { heard, correct, permanent }));
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Could not save correction.');
    $('remoteSourceWrong').value = '';
    $('remoteSourceCorrect').value = '';
    setStatus('Speech correction saved.');
  } catch (err) {
    setStatus(err.message);
  }
});

window.addEventListener('load', async () => {
  try {
    const res = await fetch('/api/languages');
    const data = await res.json();
    state.availableLanguages = data.languages || {};
  } catch (_) {}
  populateRemoteLanguageSelects();
  updateRemoteGlossaryMode();
  syncGlossaryToggle();
  refreshRemoteUi();
  await join();
});

window.addEventListener('beforeunload', () => {
  if (state.liveAudio.running && state.eventId) {
    socket.emit('azure_audio_stop', { eventId: state.eventId });
  }
});
