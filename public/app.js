const socket = io();
const $ = (id) => document.getElementById(id);

let currentEvent = null;
let currentGlobalSongLibrary = [];
let currentPinnedTextLibrary = [];
let availableEventsList = [];
let currentDisplayPresets = [];
let currentVolume = 70;
let currentMuted = false;
let selectedEntryId = null;
let sourceEditLock = false;
let activeTab = 'events';
let lastManualEnterAt = 0;
let screenWakeLock = null;
window.isRecognitionRunning = false;
let availableLanguages = {};
let publicBaseUrl = 'https://sanctuaryvoice.com';

const AUDIO_GATE_MIN_PEAK = 14;
const AUDIO_GATE_MIN_ACTIVE_FRAMES = 12;
const AUDIO_GATE_MIN_DYNAMIC_RANGE = 5;
const AUDIO_GATE_STRONG_PEAK = 36;
const AUDIO_PROCESSING_STORAGE_KEY = 'sanctuary_voice_audio_processing';
let audioState = {
  stream: null,
  context: null,
  source: null,
  rawAnalyser: null,
  gainNode: null,
  preampNode: null,
  analyser: null,
  destination: null,
  meterFrame: null,
  recorder: null,
  browserRecognizer: null,
  running: false,
  busy: false,
  uploadQueue: [],
  chunks: [],
  chunkTimer: null,
  mimeType: '',
  monitorGainNode: null,
  monitorEnabled: false,
  currentLevel: 0,
  chunkPeakLevel: 0,
  chunkMinLevel: 100,
  chunkActiveFrames: 0,
  lastGateStatusAt: 0,
  speechProvider: 'openai',
  openAiFallbackActive: false,
  azureProcessor: null,
  azureSource: null,
  azureReady: false
};

function langLabel(code) {
  return availableLanguages[code] || code.toUpperCase();
}

function selectedLangs() {
  return Array.from(document.querySelectorAll('#targetLangList input[type="checkbox"][value]:checked')).map((i) => i.value);
}

function setStatus(text) {
  const el = $('recognitionStatus');
  if (el) el.textContent = text;
}

function setPartialTranscript(text = '') {
  const value = text || 'Waiting for full sentence...';
  const compact = $('partialTranscript');
  const large = $('partialTranscriptLarge');
  if (compact) compact.textContent = value;
  if (large) large.textContent = value;
}

function setOnAirState(isOn) {
  const badge = $('onAirBadge');
  if (badge) {
    badge.textContent = isOn ? 'On-Air' : 'Off-Air';
    badge.className = isOn ? 'status-pill active' : 'status-pill';
  }
  const startBtn = $('startRecognitionBtn');
  if (startBtn) {
    startBtn.textContent = isOn ? 'On-Air' : 'Start live';
    startBtn.classList.toggle('btn-danger', !!isOn);
    startBtn.classList.toggle('btn-primary', !isOn);
    startBtn.setAttribute('aria-pressed', isOn ? 'true' : 'false');
  }
}

function notifyTranscriptionPaused(paused) {
  if (!currentEvent?.id) return;
  currentEvent.transcriptionPaused = !!paused;
  socket.emit('set_transcription_state', { eventId: currentEvent.id, paused: !!paused });
}

async function enableScreenWakeLock() {
  try {
    if (!('wakeLock' in navigator)) return;
    if (document.visibilityState !== 'visible') return;
    if (screenWakeLock) return;
    screenWakeLock = await navigator.wakeLock.request('screen');
    screenWakeLock.addEventListener('release', () => { screenWakeLock = null; });
  } catch (_) {}
}

async function disableScreenWakeLock() {
  try {
    if (screenWakeLock) {
      await screenWakeLock.release();
      screenWakeLock = null;
    }
  } catch (_) {}
}

function switchTab(tabName) {
  activeTab = tabName;
  document.querySelectorAll('.nav-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tabName));
  document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `tab-${tabName}`));
  if (tabName === 'transcript') {
    renderTranscriptList();
    requestAnimationFrame(() => {
      document.querySelector('#transcriptList .entry')?.scrollIntoView({ block: 'start' });
    });
  }
}

function relocateMainScreenControls() {
  const modeLabel = $('displayModeLabel');
  const settingsCard = document.querySelector('.main-screen-settings-card');
  const modeMount = $('mainScreenModeMount');
  const settingsMount = $('mainScreenSettingsMount');
  if (modeLabel && modeMount && modeLabel.parentElement !== modeMount) {
    modeMount.replaceWith(modeLabel);
  }
  if (settingsCard && settingsMount && settingsCard.parentElement !== settingsMount) {
    settingsMount.replaceWith(settingsCard);
  }
}

function updateGlossaryMode() {
  const mode = $('glossaryMode')?.value || 'translation';
  $('translationGlossaryFields').style.display = mode === 'translation' ? 'flex' : 'none';
  $('sourceCorrectionFields').style.display = mode === 'source' ? 'flex' : 'none';
}

function escapeHtml(text) {
  return String(text || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function escapeHtmlWithBreaks(text) {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

function formatDateTime(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function displayModeLabel(mode, blackScreen = false) {
  if (blackScreen) return 'Black screen';
  return ({
    auto: 'Live follow',
    manual: 'Pinned text',
    song: 'Song'
  })[mode] || 'Live follow';
}

function displayThemeLabel(theme) {
  return theme === 'light' ? 'Black on white' : 'White on black';
}

function getDisplayLanguagePair(displayState = currentEvent?.displayState || {}) {
  const primary = displayState.language || currentEvent?.targetLangs?.[0] || 'no';
  const secondary = displayState.secondaryLanguage && displayState.secondaryLanguage !== primary
    ? displayState.secondaryLanguage
    : '';
  return secondary ? [primary, secondary] : [primary];
}

function getLatestTranscriptEntry() {
  const entries = Array.isArray(currentEvent?.transcripts) ? [...currentEvent.transcripts] : [];
  entries.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  return entries.length ? entries[entries.length - 1] : null;
}

function getCurrentDisplayPreviewTextForLanguage(language) {
  if (!currentEvent) return '';
  if (currentEvent.displayState?.blackScreen) return 'Main screen is currently black.';
  if (currentEvent.displayState?.mode === 'manual') {
    if (language === (currentEvent.displayState?.manualSourceLang || currentEvent.sourceLang || 'ro')) {
      return currentEvent.displayState?.manualSource || 'Pinned text mode is selected.';
    }
    return currentEvent.displayState?.manualTranslations?.[language]
      || currentEvent.displayState?.manualSource
      || 'Pinned text mode is selected.';
  }
  if (currentEvent.displayState?.mode === 'song') {
    const songSourceLang = currentEvent.songState?.sourceLang || currentEvent.sourceLang || 'ro';
    if (language === songSourceLang) {
      return currentEvent.songState?.activeBlock || 'Song is selected, but no active verse is on screen yet.';
    }
    return currentEvent.songState?.translations?.[language]
      || currentEvent.songState?.activeBlock
      || 'Song is selected, but no active verse is on screen yet.';
  }
  const latestEntry = getLatestTranscriptEntry();
  return latestEntry?.translations?.[language]
    || latestEntry?.original
    || 'Waiting for live translation...';
}

function getCurrentDisplayPreviewText() {
  return getDisplayLanguagePair()
    .map((lang) => `${langLabel(lang)}: ${getCurrentDisplayPreviewTextForLanguage(lang)}`)
    .join('\n\n');
}

function renderDisplayAuditSummary() {
  const sceneEl = $('displayAuditScene');
  if (!sceneEl) return;
  const state = currentEvent?.displayState || {};
  $('displayAuditScene').textContent = state.sceneLabel || displayModeLabel(state.mode, state.blackScreen);
  $('displayAuditLanguage').textContent = state.blackScreen ? '-' : getDisplayLanguagePair(state).map(langLabel).join(' + ');
  $('displayAuditTheme').textContent = displayThemeLabel(state.theme || 'dark');
  $('displayAuditText').textContent = `${state.textSize || 'large'} · ${state.screenStyle || 'focus'}`;
  $('displayAuditSource').textContent = state.blackScreen
    ? 'Black screen'
    : (state.mode === 'manual' ? 'Pinned text' : state.mode === 'song' ? 'Song verse' : 'Live translation');
  $('displayAuditUpdated').textContent = formatDateTime(state.updatedAt);
  $('displayAuditPreview').textContent = getCurrentDisplayPreviewText() || 'Waiting for live content.';
}

function getDisplayLanguageChoicesClient() {
  const langs = Array.isArray(currentEvent?.targetLangs) ? [...currentEvent.targetLangs] : [];
  const mode = currentEvent?.displayState?.mode || 'auto';
  if (mode === 'song') {
    const sourceLang = String(currentEvent?.songState?.sourceLang || currentEvent?.sourceLang || '').trim();
    if (sourceLang && !langs.includes(sourceLang)) langs.push(sourceLang);
  }
  if (mode === 'manual') {
    const sourceLang = String(currentEvent?.displayState?.manualSourceLang || currentEvent?.sourceLang || '').trim();
    if (sourceLang && !langs.includes(sourceLang)) langs.push(sourceLang);
  }
  return langs;
}

function renderQuickLanguageButtons() {
  const box = $('displayLanguageQuickButtons');
  if (!box) return;
  const langs = getDisplayLanguageChoicesClient();
  if (!langs.length) {
    box.innerHTML = '<div class="muted">Open an event to see available languages.</div>';
    return;
  }
  box.innerHTML = langs.map((lang) => {
    const active = currentEvent?.displayState?.language === lang;
    return `<button class="btn ${active ? 'btn-primary' : 'btn-dark'}" type="button" data-quick-language="${lang}">${escapeHtml(langLabel(lang))}</button>`;
  }).join('');
}

function filterAndSortLibrary(items = [], searchId, sortId) {
  const query = ($(searchId)?.value || '').trim().toLowerCase();
  const sortMode = $(sortId)?.value || 'az';
  return (Array.isArray(items) ? items : [])
    .filter((item) => (item.title || '').toLowerCase().includes(query))
    .sort((a, b) => {
      if (sortMode === 'recent') {
        return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
      }
      const titleA = (a.title || '').toLowerCase();
      const titleB = (b.title || '').toLowerCase();
      return sortMode === 'za' ? titleB.localeCompare(titleA) : titleA.localeCompare(titleB);
    });
}

function getTargetEventChoices(selectedId = '') {
  return (availableEventsList || [])
    .map((event) => {
      const selected = event.id === selectedId ? ' selected' : '';
      return `<option value="${event.id}"${selected}>${escapeHtml(event.name || 'Untitled event')}</option>`;
    })
    .join('');
}

const remoteProfileLabels = {
  main_screen: 'Main Screen only',
  song_only: 'Song only',
  main_and_song: 'Main Screen + Song',
  full: 'Full operator'
};

function getCurrentDisplayDraft() {
  const displayLangChoices = getDisplayLanguageChoicesClient();
  return {
    mode: currentEvent?.displayState?.blackScreen ? 'auto' : (currentEvent?.displayState?.mode || 'auto'),
    theme: $('displayThemeSelect')?.value || currentEvent?.displayState?.theme || 'dark',
    language: $('displayLanguageSelect')?.value || currentEvent?.displayState?.language || displayLangChoices[0] || currentEvent?.targetLangs?.[0] || 'no',
    secondaryLanguage: $('displaySecondaryLanguageSelect')?.value || '',
    backgroundPreset: $('displayBackgroundPresetSelect')?.value || currentEvent?.displayState?.backgroundPreset || 'none',
    customBackground: $('displayBackgroundInput')?.value?.trim() || currentEvent?.displayState?.customBackground || '',
    showClock: !!$('displayShowClockBox')?.checked,
    clockPosition: $('displayClockPositionSelect')?.value || currentEvent?.displayState?.clockPosition || 'top-right',
    clockScale: Number($('displayClockScaleInput')?.value || currentEvent?.displayState?.clockScale || 1),
    textSize: $('displayTextSizeSelect')?.value || currentEvent?.displayState?.textSize || 'large',
    textScale: Number($('displayTextScaleInput')?.value || currentEvent?.displayState?.textScale || 1),
    screenStyle: $('displayScreenStyleSelect')?.value || currentEvent?.displayState?.screenStyle || 'focus',
    displayResolution: $('displayResolutionSelect')?.value || currentEvent?.displayState?.displayResolution || 'auto'
  };
}

function renderDisplayPresets(items = []) {
  const box = $('displayPresetsList');
  if (!box) return;
  currentDisplayPresets = Array.isArray(items) ? items : [];
  if (!currentDisplayPresets.length) {
    box.innerHTML = '<div class="muted">No presets saved yet.</div>';
    return;
  }
  box.innerHTML = currentDisplayPresets.map((preset) => `
    <div class="history-item preset-item-card">
      <div class="preset-item-top">
        <div>
          <b>${escapeHtml(preset.name || 'Untitled preset')}</b>
          <div class="small">${escapeHtml((preset.mode || 'auto') === 'manual' ? 'Pinned text' : ((preset.mode || 'auto') === 'song' ? 'Song' : 'Live follow'))} · ${escapeHtml(preset.theme === 'light' ? 'Black on white' : 'White on black')} · ${escapeHtml(langLabel(preset.language || 'no'))}</div>
        </div>
        <div class="actions">
          <button class="btn btn-primary" type="button" data-display-preset-action="apply" data-display-preset-id="${preset.id}">Apply</button>
          <button class="btn btn-dark" type="button" data-display-preset-action="fill" data-display-preset-id="${preset.id}">Load values</button>
          <button type="button" data-display-preset-action="delete" data-display-preset-id="${preset.id}">Delete</button>
        </div>
      </div>
    </div>
  `).join('');
}

function fillDisplayControlsFromPreset(preset) {
  if (!preset) return;
  if ($('displayThemeSelect')) $('displayThemeSelect').value = preset.theme || 'dark';
  if ($('displayLanguageSelect')) $('displayLanguageSelect').value = preset.language || currentEvent?.targetLangs?.[0] || 'no';
  if ($('displaySecondaryLanguageSelect')) $('displaySecondaryLanguageSelect').value = preset.secondaryLanguage || '';
  if ($('displayBackgroundPresetSelect')) $('displayBackgroundPresetSelect').value = preset.backgroundPreset || 'none';
  if ($('displayBackgroundInput')) $('displayBackgroundInput').value = preset.customBackground || '';
  if ($('displayShowClockBox')) $('displayShowClockBox').checked = !!preset.showClock;
  if ($('displayClockPositionSelect')) $('displayClockPositionSelect').value = preset.clockPosition || 'top-right';
  if ($('displayClockScaleInput')) $('displayClockScaleInput').value = String(preset.clockScale || 1);
  if ($('displayTextSizeSelect')) $('displayTextSizeSelect').value = preset.textSize || 'large';
  if ($('displayTextScaleInput')) $('displayTextScaleInput').value = String(preset.textScale || 1);
  if ($('displayTextScaleValue')) $('displayTextScaleValue').textContent = `${Math.round(Number(preset.textScale || 1) * 100)}%`;
  if ($('displayScreenStyleSelect')) $('displayScreenStyleSelect').value = preset.screenStyle || 'focus';
  if ($('displayResolutionSelect')) $('displayResolutionSelect').value = preset.displayResolution || 'auto';
  setStatus(`Loaded preset values from ${preset.name}.`);
}

function renderManualHistory(items = []) {
  const box = $('manualHistoryList');
  if (!box) return;
  const manualItems = (Array.isArray(items) ? items : []).filter((item) => (item.kind || 'song') === 'manual');
  if (!manualItems.length) {
    box.innerHTML = '<div class="muted">No pinned texts yet.</div>';
    return;
  }
  box.innerHTML = manualItems.map((item) => `
    <div class="history-item">
      <div><b>${escapeHtml(item.title || 'Pinned text')}</b></div>
      <div class="small">${escapeHtmlWithBreaks(String(item.source || '').slice(0, 200))}${String(item.source || '').length > 200 ? '...' : ''}</div>
      <div class="actions">
        <button class="btn btn-dark" type="button" data-manual-history-action="load" data-manual-history-id="${item.id}">Load</button>
        <button class="btn btn-primary" type="button" data-manual-history-action="send" data-manual-history-id="${item.id}">Send again</button>
      </div>
    </div>
  `).join('');
}

function renderActiveEventBadge(event) {
  const badge = $('activeEventBadge');
  const opened = $('openedEventBadge');
  if (!badge) return;
  if (!event) {
    badge.textContent = 'No live event';
    badge.className = 'status-pill';
    opened.textContent = 'No event opened';
    $('songModeBadge').textContent = 'Live follow';
    return;
  }
  const extra = event.scheduledAt ? ` · ${formatDateTime(event.scheduledAt)}` : '';
  badge.textContent = event.isActive ? `Live: ${event.name}${extra}` : 'Another event is live';
  badge.className = event.isActive ? 'status-pill active' : 'status-pill';
  opened.textContent = `Opened: ${event.name}${extra}`;
  const isSongMode = event.mode === 'song';
  $('songModeBadge').textContent = isSongMode ? 'Song live' : (event.displayState?.mode === 'manual' ? 'Pinned text live' : 'Live follow');
  $('songModeBadge').className = (isSongMode || event.displayState?.mode === 'manual') ? 'status-pill active' : 'status-pill';
}

function refreshDisplayControls() {
  const modeLabel = $('displayModeLabel');
  const themeSelect = $('displayThemeSelect');
  const languageSelect = $('displayLanguageSelect');
  const secondaryLanguageSelect = $('displaySecondaryLanguageSelect');
  const backgroundPresetSelect = $('displayBackgroundPresetSelect');
  const backgroundInput = $('displayBackgroundInput');
  const showClockBox = $('displayShowClockBox');
  const clockPositionSelect = $('displayClockPositionSelect');
  const clockScaleInput = $('displayClockScaleInput');
  const clockScaleValue = $('displayClockScaleValue');
  const textSizeSelect = $('displayTextSizeSelect');
  const textScaleInput = $('displayTextScaleInput');
  const textScaleValue = $('displayTextScaleValue');
  const screenStyleSelect = $('displayScreenStyleSelect');
  const resolutionSelect = $('displayResolutionSelect');
  const restoreBtn = $('displayRestoreBtn');
  if (modeLabel) {
    const modeText = displayModeLabel(currentEvent?.displayState?.mode, currentEvent?.displayState?.blackScreen);
    const themeText = displayThemeLabel(currentEvent?.displayState?.theme);
    modeLabel.textContent = `Main screen: ${modeText} · Theme: ${themeText}`;
  }
  if (themeSelect) {
    themeSelect.value = currentEvent?.displayState?.theme || 'dark';
  }
  if (languageSelect) {
    const langs = getDisplayLanguageChoicesClient();
    languageSelect.innerHTML = langs.map((lang) => `<option value="${lang}">${escapeHtml(langLabel(lang))}</option>`).join('');
    languageSelect.value = currentEvent?.displayState?.language || langs[0] || 'no';
  }
  if (secondaryLanguageSelect) {
    const langs = getDisplayLanguageChoicesClient();
    const primaryLanguage = languageSelect?.value || currentEvent?.displayState?.language || langs[0] || 'no';
    secondaryLanguageSelect.innerHTML = [
      '<option value="">Single language</option>',
      ...langs
        .filter((lang) => lang !== primaryLanguage)
        .map((lang) => `<option value="${lang}">${escapeHtml(langLabel(lang))}</option>`)
    ].join('');
    const secondaryLanguage = currentEvent?.displayState?.secondaryLanguage || '';
    secondaryLanguageSelect.value = secondaryLanguage && secondaryLanguage !== primaryLanguage ? secondaryLanguage : '';
  }
  if ($('dualLanguageToggle')) {
    $('dualLanguageToggle').checked = !!currentEvent?.displayState?.secondaryLanguage;
  }
  if ($('currentSourceLang')) {
    $('currentSourceLang').value = currentEvent?.sourceLang || 'ro';
  }
  if (backgroundInput) {
    backgroundInput.value = currentEvent?.displayState?.customBackground || '';
  }
  if (backgroundPresetSelect) {
    backgroundPresetSelect.value = currentEvent?.displayState?.backgroundPreset || 'none';
  }
  if (showClockBox) {
    showClockBox.checked = !!currentEvent?.displayState?.showClock;
  }
  if (clockPositionSelect) {
    clockPositionSelect.value = currentEvent?.displayState?.clockPosition || 'top-right';
  }
  if (clockScaleInput) {
    const scale = Number(currentEvent?.displayState?.clockScale || 1);
    clockScaleInput.value = String(Math.min(1.8, Math.max(0.7, scale)));
  }
  if (clockScaleValue) {
    const scale = Number(clockScaleInput?.value || currentEvent?.displayState?.clockScale || 1);
    clockScaleValue.textContent = `${Math.round(scale * 100)}%`;
  }
  if (textSizeSelect) {
    textSizeSelect.value = currentEvent?.displayState?.textSize || 'large';
  }
  if (textScaleInput) {
    const scale = Number(currentEvent?.displayState?.textScale || 1);
    textScaleInput.value = String(Math.min(1.4, Math.max(0.65, scale)));
  }
  if (textScaleValue) {
    const scale = Number(textScaleInput?.value || currentEvent?.displayState?.textScale || 1);
    textScaleValue.textContent = `${Math.round(scale * 100)}%`;
  }
  if (screenStyleSelect) {
    screenStyleSelect.value = currentEvent?.displayState?.screenStyle || 'focus';
  }
  if (resolutionSelect) {
    resolutionSelect.value = currentEvent?.displayState?.displayResolution || 'auto';
  }
  if (restoreBtn) {
    restoreBtn.disabled = !currentEvent?.displayStatePrevious;
  }
  const state = currentEvent?.displayState || {};
  const isBlackScreen = !!state.blackScreen;
  const activeMode = isBlackScreen ? 'blank' : (state.mode || 'auto');
  const modeButtons = [
    { id: 'displayAutoBtn', active: activeMode === 'auto', activeClass: 'btn-primary' },
    { id: 'displayManualBtn', active: activeMode === 'manual', activeClass: 'btn-primary' },
    { id: 'displaySongBtn', active: activeMode === 'song', activeClass: 'btn-primary' },
    { id: 'blankMainScreenBtn', active: activeMode === 'blank', activeClass: 'btn-danger' }
  ];
  modeButtons.forEach(({ id, active, activeClass }) => {
    const btn = $(id);
    if (!btn) return;
    btn.classList.remove('btn-primary', 'btn-danger', 'btn-dark');
    btn.classList.add(active ? activeClass : 'btn-dark');
  });
  renderQuickLanguageButtons();
  renderDisplayAuditSummary();
  renderDisplayPresets(currentEvent?.displayPresets || currentDisplayPresets || []);
}

function getSongEditorLabels() {
  const visibleInputs = Array.from(document.querySelectorAll('[data-song-label-input]'));
  if (!visibleInputs.length) return inferSongLabelsFromText($('songText')?.value || '');
  return visibleInputs.map((input, index) => {
    const value = String(input.value || '').trim();
    return value || `Verse ${index + 1}`;
  });
}

function inferSongLabelsFromText(text) {
  return buildSongEntriesFromTextLocal(text).map((entry, index) => entry.label || `Verse ${index + 1}`);
}

function splitSongBlocksLocal(text) {
  return buildSongEntriesFromTextLocal(text).map((entry) => entry.text);
}

function appendSongInlineNoteLocal(text, note) {
  const safeNote = String(note || '').trim();
  if (!safeNote) return String(text || '').trim();
  const lines = String(text || '').split('\n');
  const index = lines.findIndex((line) => line.trim());
  if (index < 0) return safeNote;
  if (!lines[index].includes(safeNote)) lines[index] = `${lines[index].trim()} ${safeNote}`;
  return lines.join('\n').trim();
}

function parseSongSectionMarkerLocal(block) {
  const lines = String(block || '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return { label: '', text: '', baseText: '', type: 'verse' };
  const match = lines[0].match(/^((?:r|refren|chorus)\s*\d*|\d+)([.:])\s*(.*)$/i);
  if (!match) {
    const text = lines.join('\n');
    return { label: '', text, baseText: text, type: 'verse' };
  }

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
  const text = inlineNote && baseText ? appendSongInlineNoteLocal(baseText, inlineNote) : baseText;

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

function buildSongEntriesFromTextLocal(text) {
  const rawBlocks = String(text || '').split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  let lastChorusBaseText = '';
  return rawBlocks.map((block, index) => {
    const parsed = parseSongSectionMarkerLocal(block);
    let blockText = parsed.text || block;
    if (parsed.repeatPreviousChorus) {
      blockText = lastChorusBaseText ? appendSongInlineNoteLocal(lastChorusBaseText, parsed.inlineNote) : (parsed.inlineNote || blockText);
    }
    if (parsed.type === 'chorus' && !parsed.repeatPreviousChorus && parsed.baseText) {
      lastChorusBaseText = parsed.baseText;
    }
    return { text: String(blockText || '').trim(), label: parsed.label || `Verse ${index + 1}` };
  }).filter((entry) => entry.text);
}

function renderParticipantStats(stats = {}) {
  const uniqueCount = Number(stats.uniqueCount || stats.total || 0);
  const languages = Array.isArray(stats.languages) ? stats.languages : Object.entries(stats.byLanguage || {}).map(([lang, count]) => ({ lang, count }));
  $('participantStatsSummary').textContent = uniqueCount === 1 ? '1 unique participant' : `${uniqueCount} unique participants`;
  $('participantStatsList').innerHTML = languages.length
    ? languages.map((item) => `<div class="history-item">${escapeHtml(langLabel(item.lang))}: ${item.count}</div>`).join('')
    : '<div class="muted">No connected participant.</div>';
}

function renderAudioStateLabel() {
  if ($('audioStateLabel')) $('audioStateLabel').textContent = currentMuted ? 'Global audio off.' : 'Global audio active.';
  if ($('muteGlobalBtn')) $('muteGlobalBtn').textContent = currentMuted ? 'Unmute global' : 'Mute global';
}

function renderUsageStats(stats = {}) {
  $('usageUniqueParticipants').textContent = String(stats.uniqueParticipantsEver || 0);
  $('usageScreenChanges').textContent = String(stats.screenChangeCount || 0);
  $('usageTranscriptCount').textContent = String(stats.transcriptCount || 0);
  const items = [
    `Current participants: ${stats.currentParticipants || 0}`,
    `Manual pushes: ${stats.manualPushCount || 0}`,
    `Song controls: ${stats.songControlCount || 0}`,
    `Transcript refreshes: ${stats.transcriptRefreshCount || 0}`,
    `Admin joins: ${stats.adminJoinCount || 0}`,
    `Screen operator joins: ${stats.screenOperatorJoinCount || 0}`,
    `Last transcript: ${formatDateTime(stats.lastTranscriptAt)}`,
    `Last screen action: ${formatDateTime(stats.lastScreenActionAt)}`,
    `Last participant join: ${formatDateTime(stats.lastParticipantJoinAt)}`,
    `Last issue: ${stats.lastErrorMessage ? `${stats.lastErrorMessage} · ${formatDateTime(stats.lastErrorAt)}` : 'No recent issues'}`
  ];
  $('usageReliabilityList').innerHTML = items.map((item) => `<div class="history-item">${escapeHtml(item)}</div>`).join('');
}

function resetParticipantStats() {
  renderParticipantStats({ uniqueCount: 0, languages: [] });
  renderUsageStats({});
}

function getEntryById(entryId) {
  return (currentEvent?.transcripts || []).find((x) => x.id === entryId) || null;
}

function fillGlossaryLangs(targetLangs = []) {
  const select = $('glossaryLang');
  select.innerHTML = '';
  targetLangs.forEach((lang) => {
    const opt = document.createElement('option');
    opt.value = lang;
    opt.textContent = langLabel(lang);
    select.appendChild(opt);
  });
}

function fillLanguageSelectors() {
  const sourceSelect = $('sourceLang');
  const currentSourceSelect = $('currentSourceLang');
  const songSourceSelect = $('songSourceLang');
  const manualSourceSelect = $('manualSourceLang');
  const targetBox = $('targetLangList');
  sourceSelect.innerHTML = '';
  if (currentSourceSelect) currentSourceSelect.innerHTML = '';
  if (songSourceSelect) songSourceSelect.innerHTML = '';
  if (manualSourceSelect) manualSourceSelect.innerHTML = '';
  targetBox.innerHTML = '';
  Object.entries(availableLanguages).forEach(([code, label]) => {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = label;
    if (code === 'ro') option.selected = true;
    sourceSelect.appendChild(option);
    if (currentSourceSelect) {
      const currentOption = document.createElement('option');
      currentOption.value = code;
      currentOption.textContent = label;
      if (code === 'ro') currentOption.selected = true;
      currentSourceSelect.appendChild(currentOption);
    }
    if (songSourceSelect) {
      const songOption = document.createElement('option');
      songOption.value = code;
      songOption.textContent = label;
      if (code === 'ro') songOption.selected = true;
      songSourceSelect.appendChild(songOption);
    }
    if (manualSourceSelect) {
      const manualOption = document.createElement('option');
      manualOption.value = code;
      manualOption.textContent = label;
      if (code === 'ro') manualOption.selected = true;
      manualSourceSelect.appendChild(manualOption);
    }
    const checked = ['no', 'en'].includes(code);
    const row = document.createElement('label');
    row.className = 'checkbox-item';
    row.innerHTML = `<input type="checkbox" value="${code}" ${checked ? 'checked' : ''}> ${escapeHtml(label)}`;
    targetBox.appendChild(row);
  });
}

function copyField(id, buttonId) {
  const value = ($(id)?.value || '').trim();
  if (!value) return;
  navigator.clipboard.writeText(value).then(() => {
    const btn = $(buttonId);
    const old = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => btn.textContent = old, 1200);
  }).catch(() => setStatus('Copy failed.'));
}

function adminJsonOptions(method, payload = {}) {
  if (!currentEvent?.adminCode) {
    throw new Error('Open or create an event first.');
  }

  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, code: currentEvent.adminCode })
  };
}

function globalJsonOptions(method, payload = {}) {
  const code = currentEvent?.adminCode ? { code: currentEvent.adminCode } : {};
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, ...code })
  };
}

function getStoredAdminCode(eventId = '') {
  if (!eventId) return '';
  try {
    return localStorage.getItem(`sanctuary_admin_code_${eventId}`) || '';
  } catch (_) {
    return '';
  }
}

function rememberAdminCode(event) {
  if (!event?.id || !event.adminCode) return;
  try {
    localStorage.setItem(`sanctuary_admin_code_${event.id}`, event.adminCode);
  } catch (_) {}
}

async function copyTextQuick(text, button) {
  try {
    await navigator.clipboard.writeText(String(text || '').trim());
    const old = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => button.textContent = old, 1200);
  } catch (_) {
    setStatus('Copy failed.');
  }
}

async function copyQrImage() {
  const src = $('qrImage')?.src;
  if (!src) return;
  try {
    if (!navigator.clipboard || !window.ClipboardItem) return;
    const blob = await (await fetch(src)).blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    setStatus('QR copied.');
  } catch (_) {
    setStatus('QR copy failed.');
  }
}

function downloadQrFromImage(imageId, filenamePrefix = 'sanctuary-voice-qr') {
  const src = $(imageId)?.src;
  if (!src) return;
  const a = document.createElement('a');
  a.href = src;
  a.download = `${filenamePrefix}-${Date.now()}.png`;
  a.click();
}

function downloadQr() {
  downloadQrFromImage('qrImage');
}

function downloadPermanentQr() {
  downloadQrFromImage('permanentQrImage', 'sanctuary-voice-permanent-participant-qr');
}

function sanitizeFilenamePart(value, fallback = 'transcript') {
  const clean = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return clean || fallback;
}

function formatTranscriptExportDate(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function buildTranscriptExportText() {
  if (!currentEvent) return '';
  const entries = Array.isArray(currentEvent.transcripts) ? [...currentEvent.transcripts] : [];
  entries.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  const lines = [
    'Sanctuary Voice transcript',
    `Event: ${currentEvent.name || 'Untitled service'}`,
    `Date: ${formatDateTime(currentEvent.scheduledAt || currentEvent.createdAt || new Date().toISOString())}`,
    `Source language: ${langLabel(currentEvent.sourceLang || 'ro')}`,
    `Target languages: ${(currentEvent.targetLangs || []).map(langLabel).join(', ') || '-'}`,
    '',
    '---',
    ''
  ];
  entries.forEach((entry, index) => {
    lines.push(`#${index + 1} - ${formatDateTime(entry.createdAt)}`);
    lines.push(`${langLabel(entry.sourceLang || currentEvent.sourceLang || 'ro')}: ${entry.original || ''}`);
    Object.entries(entry.translations || {}).forEach(([lang, text]) => {
      lines.push(`${lang.toUpperCase()}: ${text || ''}`);
    });
    lines.push('');
  });
  return lines.join('\n');
}

function exportTranscript() {
  if (!currentEvent) return alert('Open or create an event first.');
  const entries = Array.isArray(currentEvent.transcripts) ? currentEvent.transcripts : [];
  if (!entries.length) return alert('No transcript to export yet.');
  const datePart = formatTranscriptExportDate(currentEvent.scheduledAt || currentEvent.createdAt);
  const namePart = sanitizeFilenamePart(currentEvent.name || 'predica');
  const filename = `${namePart}-${datePart}.txt`;
  const blob = new Blob([buildTranscriptExportText()], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setStatus(`Transcript exported: ${filename}`);
}

function hydratePermanentParticipantAccess() {
  const origin = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? window.location.origin
    : publicBaseUrl;
  const link = `${origin.replace(/\/+$/, '')}/participant`;
  if ($('permanentParticipantLink')) $('permanentParticipantLink').value = link;
  if ($('permanentQrImage')) $('permanentQrImage').src = `/api/participant-qr.png?ts=${Date.now()}`;
}

function emailLinkFromField(fieldId, label) {
  const url = $(fieldId)?.value || '';
  if (!url) return setStatus('No link available yet.');
  const recipient = window.prompt(`Email address for ${label}:`);
  if (!recipient) return;
  const subject = encodeURIComponent(`Sanctuary Voice - ${label}`);
  const body = encodeURIComponent(`Hello,\n\nHere is the ${label}:\n${url}\n\nSanctuary Voice`);
  window.location.href = `mailto:${encodeURIComponent(recipient)}?subject=${subject}&body=${body}`;
  setStatus(`Prepared ${label} email.`);
}

function buildScheduledAt() {
  const date = $('eventDate')?.value;
  const time = $('eventTime')?.value;
  if (!date) return null;
  return time ? `${date}T${time}:00` : `${date}T00:00:00`;
}

const COMMON_TIMEZONES = [
  'Europe/Oslo','Europe/Bucharest','Europe/Berlin','Europe/Paris','Europe/Madrid','Europe/Rome','Europe/Amsterdam',
  'Europe/Stockholm','Europe/Copenhagen','Europe/Helsinki','Europe/Warsaw','Europe/Vienna','Europe/Prague',
  'Europe/Budapest','Europe/Athens','Europe/Istanbul','Europe/Moscow','Europe/Kyiv','Europe/London','Europe/Lisbon',
  'Europe/Dublin','UTC','America/New_York','America/Chicago','America/Denver','America/Los_Angeles','America/Toronto',
  'America/Sao_Paulo','Asia/Dubai','Asia/Tehran','Asia/Jerusalem','Asia/Kolkata','Asia/Bangkok','Asia/Singapore',
  'Asia/Hong_Kong','Asia/Tokyo','Asia/Seoul','Australia/Sydney','Pacific/Auckland'
];

function detectBrowserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch (err) {
    return 'UTC';
  }
}

function populateTimezoneSelect() {
  const select = $('eventTimezone');
  if (!select) return;
  const browserTz = detectBrowserTimezone();
  const set = new Set(COMMON_TIMEZONES);
  if (browserTz) set.add(browserTz);
  const list = Array.from(set).sort();
  select.innerHTML = list.map((tz) => `<option value="${tz}">${tz}</option>`).join('');
  select.value = browserTz && set.has(browserTz) ? browserTz : 'UTC';
}

function formatScheduledPreview() {
  const date = $('eventDate')?.value;
  const time = $('eventTime')?.value;
  const tz = $('eventTimezone')?.value || detectBrowserTimezone();
  const previewEl = $('eventScheduledPreview');
  if (!previewEl) return;
  if (!date || !time) {
    previewEl.textContent = 'Choose a date and time to schedule this service.';
    return;
  }
  try {
    const [y, m, d] = date.split('-').map(Number);
    const [hh, mm] = time.split(':').map(Number);
    const fmt = new Intl.DateTimeFormat([], {
      timeZone: tz,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    const sample = new Date(Date.UTC(y, m - 1, d, hh, mm));
    const parts = fmt.formatToParts(sample);
    const text = parts.map((p) => p.value).join('');
    previewEl.textContent = `Event scheduled for: ${text} (${tz})`;
  } catch (err) {
    previewEl.textContent = `Event scheduled for: ${date} ${time} (${tz})`;
  }
}

function bindScheduledPreviewListeners() {
  ['eventDate', 'eventTime', 'eventTimezone'].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener('input', formatScheduledPreview);
    if (el) el.addEventListener('change', formatScheduledPreview);
  });
}

function openInlineEditor(entryId) {
  selectedEntryId = entryId;
  sourceEditLock = true;
  document.querySelectorAll('.entry.active').forEach((el) => el.classList.remove('active'));
  document.querySelectorAll('.inline-editor.open').forEach((el) => el.classList.remove('open'));
  const card = document.querySelector(`[data-entry-id="${entryId}"]`);
  if (!card) return;
  card.classList.add('active');
  const editor = card.querySelector('.inline-editor');
  if (editor) editor.classList.add('open');
  requestAnimationFrame(() => {
    const textarea = card.querySelector('.inline-source');
    if (!textarea) return;
    textarea.focus();
    textarea.selectionStart = textarea.value.length;
    textarea.selectionEnd = textarea.value.length;
  });
}

function closeInlineEditors() {
  document.querySelectorAll('.entry.active').forEach((el) => el.classList.remove('active'));
  document.querySelectorAll('.inline-editor.open').forEach((el) => el.classList.remove('open'));
  selectedEntryId = null;
  sourceEditLock = false;
}

function renderEntry(entry) {
  const list = $('transcriptList');
  if (!list || !entry) return;
  const div = document.createElement('div');
  div.className = 'entry';
  div.dataset.entryId = entry.id;
  const editedBadge = entry.edited ? '<div class="mini-badge">Edited</div>' : '';
  const sourceLabel = langLabel(entry.sourceLang);
  const translations = Object.entries(entry.translations || {}).map(([lang, text]) => `<div class="trans" data-lang="${lang}"><b>${lang.toUpperCase()}:</b> ${escapeHtml(text)}</div>`).join('');
  div.innerHTML = `
    <div class="entry-meta">${formatDateTime(entry.createdAt)}</div>
    <div class="entry-head">
      <div class="orig"><b>${sourceLabel}:</b> ${escapeHtml(entry.original)}</div>
      <div class="button-row compact"><button class="btn btn-dark entry-copy-btn" type="button">Copy</button>${editedBadge}</div>
    </div>
    ${translations}
    <div class="inline-editor">
      <div class="muted">Edit source and retranslate all languages</div>
      <textarea class="inline-source">${escapeHtml(entry.original)}</textarea>
      <div class="button-row compact">
        <button class="btn btn-primary inline-save" type="button">Retranslate</button>
        <button class="btn btn-dark inline-close" type="button">Close</button>
      </div>
    </div>`;
  div.addEventListener('click', (e) => { if (!e.target.closest('button') && !e.target.closest('textarea')) openInlineEditor(entry.id); });
  div.querySelector('.entry-copy-btn').addEventListener('click', (e) => { e.stopPropagation(); copyTextQuick(entry.original, e.currentTarget); });
  div.querySelector('.inline-save').addEventListener('click', (e) => { e.stopPropagation(); saveInlineSource(entry.id); });
  div.querySelector('.inline-close').addEventListener('click', (e) => { e.stopPropagation(); closeInlineEditors(); });
  div.querySelector('.inline-source').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveInlineSource(entry.id); } });
  list.prepend(div);
}

function renderTranscriptList() {
  const list = $('transcriptList');
  if (!list) return;
  list.innerHTML = '';
  const entries = Array.isArray(currentEvent?.transcripts) ? currentEvent.transcripts : [];
  if (!entries.length) {
    list.innerHTML = '<div class="muted">No transcript yet. Start live to capture the first lines.</div>';
    return;
  }
  entries.forEach(renderEntry);
}

function updateEntry({ entryId, lang, text }) {
  const entry = document.querySelector(`[data-entry-id="${entryId}"]`);
  if (!entry) return;
  let line = entry.querySelector(`.trans[data-lang="${lang}"]`);
  if (!line) {
    line = document.createElement('div');
    line.className = 'trans';
    line.dataset.lang = lang;
    entry.insertBefore(line, entry.querySelector('.inline-editor'));
  }
  line.innerHTML = `<b>${lang.toUpperCase()}:</b> ${escapeHtml(text)}`;
}

function updateSourceEntry({ entryId, sourceLang, original, translations }) {
  const entry = document.querySelector(`[data-entry-id="${entryId}"]`);
  if (!entry) return;
  entry.querySelector('.orig').innerHTML = `<b>${langLabel(sourceLang)}:</b> ${escapeHtml(original)}`;
  entry.querySelector('.inline-source').value = original;
  Object.entries(translations || {}).forEach(([lang, text]) => updateEntry({ entryId, lang, text }));
  const actual = getEntryById(entryId);
  if (actual) {
    actual.sourceLang = sourceLang;
    actual.original = original;
    actual.translations = translations;
    actual.edited = true;
  }
}

function saveInlineSource(entryId) {
  if (!currentEvent) return;
  const card = document.querySelector(`[data-entry-id="${entryId}"]`);
  const textarea = card?.querySelector('.inline-source');
  const text = textarea?.value.trim();
  if (!text) return;
  socket.emit('admin_update_source', { eventId: currentEvent.id, entryId, sourceText: text });
  closeInlineEditors();
}

function renderEventList(events = [], activeEventId = null, openedEventId = null) {
  const box = $('eventList');
  box.innerHTML = '';
  if (!events.length) {
    box.innerHTML = '<div class="muted">No events yet.</div>';
    return;
  }
  events.forEach((event) => {
    const card = document.createElement('div');
    card.className = `event-card${event.id === activeEventId ? ' active' : ''}${event.id === openedEventId ? ' opened' : ''}`;
    const langs = (event.targetLangs || []).map((lang) => langLabel(lang)).join(', ');
    const displayId = event.shortId || event.id;
    const badges = [`<div class="mini-badge">${event.mode || 'live'}</div>`];
    if (event.hidden) badges.push('<div class="mini-badge mini-badge-warn" title="Hidden from participants">Hidden</div>');
    if (event.testMode) badges.push('<div class="mini-badge mini-badge-test" title="Test mode — participants see a TEST banner">Test</div>');
    const visibilityLabel = event.hidden ? 'Show to participants' : 'Hide from participants';
    const visibilityTitle = event.hidden
      ? 'Make this event visible in the participant chooser. Useful for live testing.'
      : 'Hide this event from the participant chooser.';
    card.innerHTML = `
      <div class="event-card-head"><div class="event-name">${escapeHtml(event.name || 'New event')}</div>${badges.join('')}</div>
      <div class="event-id-row">
        <span class="event-id-label">Event ID</span>
        <code class="event-id-value">${escapeHtml(displayId)}</code>
        <button class="btn btn-dark event-id-copy" type="button" data-action="copy-id" data-id="${displayId}" title="Copy Event ID">Copy</button>
      </div>
      <div class="muted">Scheduled: ${escapeHtml(formatDateTime(event.scheduledAt || event.createdAt))}</div>
      <div class="muted">Languages: ${escapeHtml(langs || '-')}</div>
      <div class="muted">Texts: ${event.transcriptCount || 0}</div>
      <div class="button-row compact">
        <button class="btn btn-dark" data-action="open" data-id="${event.id}" title="Load this event in Live Control to edit transcript, glossary, songs, and main screen.">Open</button>
        <button class="btn btn-primary" data-action="activate" data-id="${event.id}" title="Make this the active event for participants and the main screen. Only one event can be live at a time."${event.id === activeEventId ? ' disabled' : ''}>${event.id === activeEventId ? 'Live now' : 'Set live'}</button>
        <button class="btn btn-dark" data-action="visibility" data-id="${event.id}" title="${escapeHtml(visibilityTitle)}">${visibilityLabel}</button>
        <button class="btn btn-danger" data-action="delete" data-id="${event.id}">Delete</button>
      </div>`;
    box.appendChild(card);
  });
}

async function refreshEventList() {
  const res = await fetch('/api/events');
  const data = await res.json();
  if (!data.ok) return;
  availableEventsList = data.events || [];
  renderEventList(availableEventsList, data.activeEventId || null, currentEvent?.id || null);
  renderGlobalSongLibrary(currentGlobalSongLibrary);
}

function getSongSourceLang() {
  return $('songSourceLang')?.value || currentEvent?.songState?.sourceLang || currentEvent?.sourceLang || 'ro';
}

async function loadDisplayPresets() {
  if (!currentEvent) return;
  try {
    const code = encodeURIComponent(currentEvent.adminCode || getStoredAdminCode(currentEvent.id) || '');
    const res = await fetch(`/api/events/${currentEvent.id}/display-presets${code ? `?code=${code}` : ''}`);
    const data = await res.json();
    if (!data.ok) return;
    currentDisplayPresets = data.presets || [];
    if (currentEvent) currentEvent.displayPresets = currentDisplayPresets;
    renderDisplayPresets(currentDisplayPresets);
  } catch (err) {
    console.error(err);
  }
}

async function loadPinnedTextLibrary() {
  try {
    const res = await fetch('/api/pinned-text-library');
    const data = await res.json();
    if (!data.ok) return;
    currentPinnedTextLibrary = data.pinnedTextLibrary || [];
    renderPinnedTextLibrary(currentPinnedTextLibrary);
  } catch (err) {
    console.error(err);
  }
}

async function syncSpeedToEvent() {
  if (!currentEvent) return;
  const speed = $('speed').value || 'balanced';
  const sourceLang = $('currentSourceLang')?.value || currentEvent.sourceLang || 'ro';
  const res = await fetch(`/api/events/${currentEvent.id}/settings`, adminJsonOptions('POST', { speed, sourceLang }));
  const data = await res.json();
  if (data.ok) {
    currentEvent = data.event;
    if ($('currentSourceLang')) $('currentSourceLang').value = currentEvent.sourceLang || sourceLang;
  }
}

function populateEventLinks() {
  if (!currentEvent) return;
  const mainOperatorCode = currentEvent.mainOperatorCode || currentEvent.screenOperatorCode || '';
  const mainOperatorLink = currentEvent.mainOperatorLink || currentEvent.remoteControlLink || '';
  setHideableTextCode('adminCode', currentEvent.adminCode || '-');
  setHideableTextCode('screenOperatorCode', mainOperatorCode || '-');
  setHideableTextCode('accessScreenOperatorCode', mainOperatorCode || '-');
  if ($('participantLink')) $('participantLink').value = currentEvent.participantLink || '';
  $('translateLink').value = currentEvent.translateLink || '';
  if ($('remoteControlLink')) $('remoteControlLink').value = mainOperatorLink;
  if ($('accessRemoteControlLink')) $('accessRemoteControlLink').value = mainOperatorLink;
  if ($('qrImage')) $('qrImage').src = `/api/participant-qr.png?ts=${Date.now()}`;
  renderRemoteOperators(currentEvent.remoteOperators || []);
  if (typeof renderLiveLanguagesGrid === 'function') renderLiveLanguagesGrid();
}

function renderRemoteOperators(items = []) {
  const box = $('remoteOperatorsList');
  if (!box) return;
  const operators = Array.isArray(items) ? items : [];
  if (!operators.length) {
    box.innerHTML = '<div class="muted">No extra operators yet.</div>';
    return;
  }
  box.innerHTML = operators.map((operator) => `
    <div class="history-item">
      <div class="section-head compact-head">
        <div>
          <b>${escapeHtml(operator.name || 'Operator')}</b>
          <div class="small">${escapeHtml(remoteProfileLabels[operator.profile] || 'Main Screen only')}</div>
        </div>
        <div class="actions">
          <button class="btn btn-dark" type="button" data-remote-operator-action="copy" data-remote-operator-id="${operator.id}">Copy</button>
          <button class="btn btn-dark" type="button" data-remote-operator-action="email" data-remote-operator-id="${operator.id}">Email</button>
          <button class="btn btn-primary" type="button" data-remote-operator-action="open" data-remote-operator-id="${operator.id}">Open</button>
          <button type="button" data-remote-operator-action="delete" data-remote-operator-id="${operator.id}">Delete</button>
        </div>
      </div>
      <div class="meta-row access-code-row">
        <span>Code</span>
        <span class="hideable-code-wrap">
          <strong class="hideable-code is-code-hidden" data-code-value="${escapeHtml(operator.code || '-')}">${operator.code ? HIDDEN_PLACEHOLDER : '-'}</strong>
          <button class="code-toggle code-toggle-inline" type="button" aria-label="Show or hide code">👁</button>
        </span>
      </div>
      <div class="small hideable-code-wrap">
        <span class="hideable-code is-code-hidden" data-code-value="${escapeHtml(operator.remoteLink || '')}">${operator.remoteLink ? HIDDEN_PLACEHOLDER : ''}</span>
        ${operator.remoteLink ? '<button class="code-toggle code-toggle-inline" type="button" aria-label="Show or hide link">👁</button>' : ''}
      </div>
    </div>
  `).join('');
}


function renderSongStateLegacy(songState) {
  if (true) return;
  const libraryCount = Array.isArray(currentGlobalSongLibrary) ? currentGlobalSongLibrary.length : 0;
  const historyCount = Array.isArray(currentEvent?.songHistory) ? currentEvent.songHistory.length : 0;
  $('songCurrentIndex').textContent = `Saved: ${libraryCount} · History: ${historyCount}`;
  $('songPreview').textContent = currentEvent?.displayState?.manualSource || 'Song text will appear here.';
  $('songBlocksList').innerHTML = '<div class="muted">Use Save in library or Send first verse live.</div>';
}

function renderSongJumpSelect(blocks = [], labels = [], currentIndex = -1) {
  const select = $('songJumpSelect');
  if (!select) return;
  const previousValue = select.value;
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
  } else if (Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < blocks.length) {
    select.value = String(currentIndex);
  }
}



function renderSongState(songState) {
  const summaryEl = $('songCurrentIndex');
  const previewEl = $('songPreview');
  const blocksEl = $('songBlocksList');
  if (!summaryEl || !previewEl || !blocksEl) return;

  const libraryCount = Array.isArray(currentGlobalSongLibrary) ? currentGlobalSongLibrary.length : 0;
  const historyCount = Array.isArray(currentEvent?.songHistory) ? currentEvent.songHistory.length : 0;
  const blocks = Array.isArray(songState?.blocks) ? songState.blocks : [];
  const labels = Array.isArray(songState?.blockLabels) ? songState.blockLabels : [];
  const currentIndex = Number.isInteger(songState?.currentIndex) ? songState.currentIndex : -1;
  const activeBlock = typeof songState?.activeBlock === 'string' ? songState.activeBlock : '';
  const sourceLang = songState?.sourceLang || getSongSourceLang();

  summaryEl.textContent = `Saved: ${libraryCount} · History: ${historyCount} · Language: ${langLabel(sourceLang)}`;
  previewEl.textContent = activeBlock || currentEvent?.displayState?.manualSource || 'Song text will appear here.';
  renderSongJumpSelect(blocks, labels, currentIndex);

  if (!blocks.length) {
    blocksEl.innerHTML = '<div class="muted">Use Save in library or Send first verse live.</div>';
    return;
  }

  blocksEl.innerHTML = blocks.map((block, index) => {
    const activeClass = index === currentIndex ? ' active' : '';
    const label = escapeHtml(labels[index] || `Verse ${index + 1}`);
    return `
      <button class="history-item song-section-item${activeClass}" type="button" data-song-block-index="${index}">
        <div class="entry-head">
          <b>${label}</b>
          <span class="small">${index === currentIndex ? 'Live now' : 'Click to send live'}</span>
        </div>
        <div class="small">${escapeHtmlWithBreaks(block)}</div>
      </button>
    `;
  }).join('');
}

function renderGlobalSongLibrary(items = []) {
  const box = $('globalSongLibraryList');
  if (!box) return;
  const filteredItems = filterAndSortLibrary(items, 'globalSongLibrarySearch', 'globalSongLibrarySort');
  if (!filteredItems.length) {
    box.innerHTML = '<div class="muted">No church songs saved yet.</div>';
    return;
  }
  const selectedEventId = currentEvent?.id || availableEventsList[0]?.id || '';
  box.innerHTML = filteredItems.map((item) => `
    <details class="event-card library-card-details">
      <summary class="library-card-summary">
        <span class="name">${escapeHtml(item.title || 'Untitled')}</span>
      </summary>
      <div class="library-card-body">
        <div class="small"><b>Language:</b> ${escapeHtml(langLabel(item.sourceLang || currentEvent?.sourceLang || 'ro'))}</div>
        <div class="actions">
          <button class="btn btn-dark" data-global-song-action="load" data-global-song-id="${item.id}">Load in editor</button>
          <button class="btn btn-primary" data-global-song-action="send" data-global-song-id="${item.id}">Send first verse</button>
        </div>
        <div class="split-2 compact-library-row">
          <div>
            <label>Choose event</label>
            <select data-global-song-target="${item.id}">
              ${getTargetEventChoices(selectedEventId)}
            </select>
          </div>
          <div class="library-inline-actions">
            <button class="btn btn-dark" data-global-song-action="add" data-global-song-id="${item.id}">Add to event</button>
            <button data-global-song-action="delete" data-global-song-id="${item.id}">Delete</button>
          </div>
        </div>
      </div>
    </details>
  `).join('');
}

function renderPinnedTextLibrary(items = []) {
  const box = $('manualLibraryList');
  if (!box) return;
  currentPinnedTextLibrary = Array.isArray(items) ? items : [];
  const filteredItems = filterAndSortLibrary(currentPinnedTextLibrary, 'manualLibrarySearch', 'manualLibrarySort');
  if (!filteredItems.length) {
    box.innerHTML = '<div class="muted">No pinned texts saved yet.</div>';
    return;
  }
  box.innerHTML = filteredItems.map((item) => `
    <details class="event-card library-card-details">
      <summary class="library-card-summary">
        <span class="name">${escapeHtml(item.title || 'Untitled')}</span>
      </summary>
      <div class="library-card-body">
        <div class="small"><b>Language:</b> ${escapeHtml(langLabel(item.sourceLang || currentEvent?.sourceLang || 'ro'))}</div>
        <div class="small">${escapeHtmlWithBreaks(String(item.text || '').slice(0, 240))}${String(item.text || '').length > 240 ? '...' : ''}</div>
        <div class="actions">
          <button class="btn btn-dark" type="button" data-manual-library-action="load" data-manual-library-id="${item.id}">Load in editor</button>
          <button class="btn btn-primary" type="button" data-manual-library-action="send" data-manual-library-id="${item.id}">Send to main screen</button>
          <button type="button" data-manual-library-action="delete" data-manual-library-id="${item.id}">Delete</button>
        </div>
      </div>
    </details>
  `).join('');
}

function renderSongHistory(items = []) {
  const box = $('songHistoryList');
  if (!box) return;
  renderManualHistory(items);
  if (!items.length) {
    box.innerHTML = '<div class="muted">Nothing sent yet.</div>';
    return;
  }
  box.innerHTML = items.map((item) => {
    const preview = item.source || '';
    return `
      <div class="history-item">
        <div><b>${escapeHtml(item.title || 'Sent text')}</b> <span class="small">(${escapeHtml(item.kind || 'song')})</span></div>
        <div class="small">${escapeHtmlWithBreaks(preview.slice(0, 220))}${preview.length > 220 ? '...' : ''}</div>
      </div>
    `;
  }).join('');
}

async function loadSongLibrary() {
  return;
}

async function loadGlobalSongLibrary() {
  try {
    const url = currentEvent ? `/api/events/${currentEvent.id}/global-song-library` : '/api/global-song-library';
    const res = await fetch(url);
    const data = await res.json();
    if (!data.ok) return;
    currentGlobalSongLibrary = data.globalSongLibrary || [];
    renderGlobalSongLibrary(currentGlobalSongLibrary);
  } catch (err) {
    console.error(err);
  }
}

function fillSongEditor(item) {
  $('songTitle').value = item?.title || '';
  $('songText').value = item?.text || '';
  if ($('songSourceLang')) $('songSourceLang').value = item?.sourceLang || currentEvent?.sourceLang || 'ro';
  const previewBlocks = splitSongBlocksLocal(item?.text || '');
  renderSongState({
    title: item?.title || '',
    sourceLang: item?.sourceLang || currentEvent?.sourceLang || 'ro',
    blocks: previewBlocks,
    blockLabels: Array.isArray(item?.labels) ? item.labels : [],
    currentIndex: previewBlocks.length ? 0 : -1,
    activeBlock: previewBlocks[0] || '',
    translations: {},
    allTranslations: [],
    updatedAt: null
  });
}

async function saveSongToLibrary() {
  const title = $('songTitle').value.trim();
  const text = $('songText').value.trim();
  const labels = getSongEditorLabels();
  const sourceLang = getSongSourceLang();
  if (!title || !text) return alert('Complete title and text first.');
  const res = await fetch('/api/global-song-library', globalJsonOptions('POST', { title, text, labels, sourceLang }));
  const data = await res.json();
  if (!data.ok) return alert(data.error || 'Could not save item.');
  currentGlobalSongLibrary = data.globalSongLibrary || [];
  renderGlobalSongLibrary(currentGlobalSongLibrary);
  clearSong();
  renderSongState(currentEvent?.songState || {});
  setStatus('Saved to church library. Editor cleared for the next song.');
}

async function sendSongItemToLive(item) {
  if (!currentEvent) return alert('Open or create an event first.');
  const title = String(item?.title || '').trim();
  const text = String(item?.text || '').trim();
  const labels = Array.isArray(item?.labels) ? item.labels : getSongEditorLabels();
  const sourceLang = String(item?.sourceLang || getSongSourceLang()).trim() || currentEvent?.sourceLang || 'ro';
  if (!text) return alert('Write text first.');
  const res = await fetch(`/api/events/${currentEvent.id}/song/load`, adminJsonOptions('POST', { title, text, labels, sourceLang }));
  const data = await res.json();
  if (!data.ok) return alert(data.error || 'Could not start verse mode.');
  currentEvent = data.event || currentEvent;
  currentEvent.songState = data.songState || currentEvent.songState;
  renderActiveEventBadge(currentEvent);
  renderSongState(currentEvent.songState || {});
  setStatus('First verse is live. Choose any verse or chorus to send it live.');
}

async function sendSongToLive() {
  await sendSongItemToLive({
    title: $('songTitle').value.trim(),
    text: $('songText').value.trim(),
    sourceLang: getSongSourceLang()
  });
}

async function showSongBlock(index) {
  if (!currentEvent) return;
  const res = await fetch(`/api/events/${currentEvent.id}/song/show/${index}`, adminJsonOptions('POST'));
  const data = await res.json();
  if (!data.ok) return alert(data.error || 'Could not show verse.');
  currentEvent.songState = data.songState || currentEvent.songState;
  currentEvent.mode = 'song';
  renderActiveEventBadge(currentEvent);
  renderSongState(currentEvent.songState || {});
}

async function showSelectedSongSection() {
  const index = Number($('songJumpSelect')?.value);
  if (!Number.isInteger(index)) return;
  await showSongBlock(index);
  setStatus('Selected song section sent live.');
}

async function goToNextSongBlock() {
  if (!currentEvent) return;
  const res = await fetch(`/api/events/${currentEvent.id}/song/next`, adminJsonOptions('POST'));
  const data = await res.json();
  if (!data.ok) return alert(data.error || 'No next verse.');
  currentEvent.songState = data.songState || currentEvent.songState;
  currentEvent.mode = 'song';
  renderActiveEventBadge(currentEvent);
  renderSongState(currentEvent.songState || {});
  setStatus('Moved to next verse.');
}

async function goToPrevSongBlock() {
  if (!currentEvent) return;
  const res = await fetch(`/api/events/${currentEvent.id}/song/prev`, adminJsonOptions('POST'));
  const data = await res.json();
  if (!data.ok) return alert(data.error || 'No previous verse.');
  currentEvent.songState = data.songState || currentEvent.songState;
  currentEvent.mode = 'song';
  renderActiveEventBadge(currentEvent);
  renderSongState(currentEvent.songState || {});
  setStatus('Moved to previous verse.');
}

async function setDisplayMode(mode) {
  if (!currentEvent) return;
  if (mode === 'song' && !currentEvent.songState?.activeBlock && !currentEvent.songState?.translations) {
    return alert('Start Song first so there is an active verse on screen.');
  }
  const res = await fetch(`/api/events/${currentEvent.id}/display/mode`, adminJsonOptions('POST', { mode }));
  const data = await res.json();
  if (!data.ok) return alert(data.error || 'Could not change display mode.');
  if (data.event) {
    currentEvent = data.event;
  }
  currentEvent.displayState = data.displayState || currentEvent.displayState;
  currentEvent.displayStatePrevious = data.previousState || currentEvent.displayStatePrevious || null;
  refreshDisplayControls();
  renderActiveEventBadge(currentEvent);
  const statusMap = {
    auto: 'Main screen switched to live follow.',
    manual: 'Main screen switched to pinned text.',
    song: 'Main screen switched to Song.'
  };
  setStatus(statusMap[mode] || 'Main screen mode updated.');
}

async function setDisplayTheme(theme) {
  if (!currentEvent) return;
  const res = await fetch(`/api/events/${currentEvent.id}/display/theme`, adminJsonOptions('POST', { theme }));
  const data = await res.json();
  if (!data.ok) return alert(data.error || 'Could not change display theme.');
  currentEvent.displayState = data.displayState || currentEvent.displayState;
  currentEvent.displayStatePrevious = data.previousState || currentEvent.displayStatePrevious || null;
  refreshDisplayControls();
  setStatus(theme === 'light' ? 'Display theme set to black on white.' : 'Display theme set to white on black.');
}

function getDefaultDualLanguage(primaryLanguage) {
  return getDisplayLanguageChoicesClient().find((lang) => lang && lang !== primaryLanguage) || '';
}

async function setDisplayLanguage(language, secondaryLanguage = $('displaySecondaryLanguageSelect')?.value || '') {
  if (!currentEvent) return;
  const safeSecondaryLanguage = secondaryLanguage && secondaryLanguage !== language ? secondaryLanguage : '';
  const res = await fetch(`/api/events/${currentEvent.id}/display/language`, adminJsonOptions('POST', { language, secondaryLanguage: safeSecondaryLanguage }));
  const data = await res.json();
  if (!data.ok) return alert(data.error || 'Could not change screen language.');
  currentEvent.displayState = data.displayState || currentEvent.displayState;
  currentEvent.displayStatePrevious = data.previousState || currentEvent.displayStatePrevious || null;
  refreshDisplayControls();
  setStatus('Main screen language updated.');
}

async function toggleDualLanguageDisplay(enabled) {
  if (!currentEvent) {
    if ($('dualLanguageToggle')) $('dualLanguageToggle').checked = false;
    return alert('Open or create an event first.');
  }
  const choices = getDisplayLanguageChoicesClient();
  const primary = currentEvent.displayState?.language || choices[0] || currentEvent.targetLangs?.[0] || 'no';
  const secondary = enabled
    ? (currentEvent.displayState?.secondaryLanguage || getDefaultDualLanguage(primary))
    : '';
  if (enabled && !secondary) {
    if ($('dualLanguageToggle')) $('dualLanguageToggle').checked = false;
    return alert('Afișajul dual are nevoie de cel puțin două limbi disponibile.');
  }
  await setDisplayLanguage(primary, secondary);
}

async function saveDisplaySettings() {
  if (!currentEvent) return alert('Open or create an event first.');
  const backgroundPreset = $('displayBackgroundPresetSelect').value;
  const customBackground = $('displayBackgroundInput').value.trim();
  const showClock = !!$('displayShowClockBox').checked;
  const clockPosition = $('displayClockPositionSelect').value;
  const clockScale = Number($('displayClockScaleInput')?.value || 1);
  const textSize = $('displayTextSizeSelect').value;
  const textScale = Number($('displayTextScaleInput')?.value || 1);
  const screenStyle = $('displayScreenStyleSelect').value;
  const displayResolution = $('displayResolutionSelect')?.value || 'auto';
  const secondaryLanguage = $('displaySecondaryLanguageSelect')?.value || '';
  const res = await fetch(`/api/events/${currentEvent.id}/display/settings`, adminJsonOptions('POST', {
    backgroundPreset,
    customBackground,
    showClock,
    clockPosition,
    clockScale,
    textSize,
    textScale,
    screenStyle,
    displayResolution,
    secondaryLanguage
  }));
  const data = await res.json();
  if (!data.ok) return alert(data.error || 'Could not save main screen settings.');
  currentEvent.displayState = data.displayState || currentEvent.displayState;
  currentEvent.displayStatePrevious = data.previousState || currentEvent.displayStatePrevious || null;
  refreshDisplayControls();
  setStatus('Main screen settings saved.');
}

async function adjustClockScale(delta) {
  const input = $('displayClockScaleInput');
  if (!input) return;
  const current = Number(input.value || currentEvent?.displayState?.clockScale || 1);
  const next = Math.min(1.8, Math.max(0.7, Math.round((current + delta) * 10) / 10));
  input.value = String(next);
  if ($('displayClockScaleValue')) $('displayClockScaleValue').textContent = `${Math.round(next * 100)}%`;
  await saveDisplaySettings();
}

async function adjustDisplayTextScale(delta) {
  const input = $('displayTextScaleInput');
  if (!input) return;
  const current = Number(input.value || currentEvent?.displayState?.textScale || 1);
  const next = Math.min(1.4, Math.max(0.65, Math.round((current + delta) * 20) / 20));
  input.value = String(next);
  if ($('displayTextScaleValue')) $('displayTextScaleValue').textContent = `${Math.round(next * 100)}%`;
  await saveDisplaySettings();
}

async function saveDisplayPreset() {
  if (!currentEvent) return alert('Open or create an event first.');
  const presetNameInput = $('displayPresetName');
  if (!presetNameInput) return;
  const name = presetNameInput.value.trim();
  if (!name) return alert('Write the preset name first.');
  const payload = { name, ...getCurrentDisplayDraft() };
  const res = await fetch(`/api/events/${currentEvent.id}/display-presets`, adminJsonOptions('POST', payload));
  const data = await res.json();
  if (!data.ok) return alert(data.error || 'Could not save preset.');
  currentDisplayPresets = data.presets || [];
  currentEvent.displayPresets = currentDisplayPresets;
  renderDisplayPresets(currentDisplayPresets);
  presetNameInput.value = '';
  setStatus('Scene preset saved.');
}

async function applyDisplayPreset(presetId) {
  if (!currentEvent) return;
  const res = await fetch(`/api/events/${currentEvent.id}/display-presets/${presetId}/apply`, adminJsonOptions('POST'));
  const data = await res.json();
  if (!data.ok) return alert(data.error || 'Could not apply preset.');
  currentEvent.displayState = data.displayState || currentEvent.displayState;
  currentEvent.displayStatePrevious = data.previousState || currentEvent.displayStatePrevious || null;
  currentEvent.displayPresets = data.presets || currentEvent.displayPresets || [];
  currentDisplayPresets = currentEvent.displayPresets;
  refreshDisplayControls();
  renderActiveEventBadge(currentEvent);
  setStatus('Scene preset applied.');
}

async function restoreLastDisplayState() {
  if (!currentEvent) return alert('Open or create an event first.');
  const res = await fetch(`/api/events/${currentEvent.id}/display/restore-last`, adminJsonOptions('POST'));
  const data = await res.json();
  if (!data.ok) return alert(data.error || 'Could not restore previous screen state.');
  currentEvent = data.event || currentEvent;
  currentEvent.displayState = data.displayState || currentEvent.displayState;
  currentEvent.displayStatePrevious = data.previousState || currentEvent.displayStatePrevious || null;
  refreshDisplayControls();
  renderActiveEventBadge(currentEvent);
  renderSongState(currentEvent.songState || {});
  setStatus('Restored previous main screen state.');
}

async function applyDisplayShortcut(shortcut) {
  if (!currentEvent) return alert('Open or create an event first.');
  const res = await fetch(
    `/api/events/${currentEvent.id}/display/shortcut`,
    adminJsonOptions('POST', { shortcut, language: $('displayLanguageSelect')?.value || currentEvent.displayState?.language || 'no' })
  );
  const data = await res.json();
  if (!data.ok) return alert(data.error || 'Could not apply service shortcut.');
  currentEvent = data.event || currentEvent;
  currentEvent.displayState = data.displayState || currentEvent.displayState;
  currentEvent.displayStatePrevious = data.previousState || currentEvent.displayStatePrevious || null;
  refreshDisplayControls();
  renderActiveEventBadge(currentEvent);
  setStatus(`${data.shortcut || 'Service shortcut'} applied.`);
}

async function deleteDisplayPreset(presetId) {
  if (!currentEvent) return;
  if (!confirm('Delete this scene preset?')) return;
  const res = await fetch(`/api/events/${currentEvent.id}/display-presets/${presetId}`, adminJsonOptions('DELETE'));
  const data = await res.json();
  if (!data.ok) return alert(data.error || 'Could not delete preset.');
  currentDisplayPresets = data.presets || [];
  currentEvent.displayPresets = currentDisplayPresets;
  renderDisplayPresets(currentDisplayPresets);
  setStatus('Scene preset deleted.');
}

async function blankMainScreen() {
  if (!currentEvent) return alert('Open or create an event first.');
  const res = await fetch(`/api/events/${currentEvent.id}/display/blank`, adminJsonOptions('POST'));
  const data = await res.json();
  if (!data.ok) return alert(data.error || 'Could not blank main screen.');
  currentEvent = data.event || currentEvent;
  currentEvent.displayStatePrevious = data.previousState || currentEvent.displayStatePrevious || null;
  refreshDisplayControls();
  renderActiveEventBadge(currentEvent);
  renderSongState(currentEvent.songState || {});
  setStatus('Main screen switched to black screen.');
}

function openPreviewWindow(url, name, features) {
  if (!url) return;
  window.open(url, name, features);
}

function openMainPreviewWindow() {
  const url = $('translateLink')?.value || '/translate';
  openPreviewWindow(url, 'sanctuaryVoiceMainPreview', 'width=1500,height=920,resizable=yes,scrollbars=yes');
}

function openParticipantPreviewWindow() {
  const url = $('participantLink')?.value || '/participant';
  openPreviewWindow(url, 'sanctuaryVoiceParticipantPreview', 'width=520,height=920,resizable=yes,scrollbars=yes');
}

function openBothPreviewWindows() {
  const mainUrl = $('translateLink')?.value || '/translate';
  const participantUrl = $('participantLink')?.value || '/participant';
  const previewWindow = window.open('', 'sanctuaryVoiceDualPreview', 'width=1680,height=980,resizable=yes,scrollbars=yes');
  if (!previewWindow) return;
  previewWindow.document.open();
  previewWindow.document.write(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sanctuary Voice Dual Preview</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #071019;
      --panel: #0f1724;
      --line: rgba(255,255,255,0.08);
      --text: #f8fafc;
      --muted: rgba(248,250,252,0.72);
      --accent: #0f766e;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      min-height: 100%;
      background:
        radial-gradient(circle at top left, rgba(200, 138, 43, 0.16), transparent 24%),
        radial-gradient(circle at bottom right, rgba(15, 118, 110, 0.18), transparent 28%),
        linear-gradient(180deg, #071019, #02050a);
      color: var(--text);
      font-family: "Segoe UI", system-ui, sans-serif;
    }
    .shell {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr;
      gap: 14px;
      padding: 14px;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 16px;
      border: 1px solid var(--line);
      border-radius: 18px;
      background: rgba(15, 23, 36, 0.84);
      backdrop-filter: blur(18px);
    }
    .title {
      font-size: 1.05rem;
      font-weight: 700;
      letter-spacing: 0.01em;
    }
    .meta {
      color: var(--muted);
      font-size: 0.92rem;
    }
    .grid {
      display: grid;
      grid-template-columns: 1.5fr 0.95fr;
      gap: 14px;
      min-height: 0;
    }
    .panel {
      min-height: 0;
      display: grid;
      grid-template-rows: auto 1fr;
      border: 1px solid var(--line);
      border-radius: 22px;
      overflow: hidden;
      background: rgba(15, 23, 36, 0.8);
      box-shadow: 0 24px 70px rgba(0,0,0,0.28);
    }
    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      background: rgba(255,255,255,0.03);
    }
    .panel-title {
      font-weight: 700;
    }
    .panel-copy {
      color: var(--muted);
      font-size: 0.85rem;
    }
    iframe {
      width: 100%;
      height: 100%;
      border: 0;
      background: #000;
    }
    @media (max-width: 1100px) {
      .grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="topbar">
      <div>
        <div class="title">Sanctuary Voice Preview Workspace</div>
        <div class="meta">Projector and participant view together in one window.</div>
      </div>
      <div class="meta">Resize or split this window as needed.</div>
    </div>
    <div class="grid">
      <section class="panel">
        <div class="panel-head">
          <div class="panel-title">Main Screen</div>
          <div class="panel-copy">Projector preview</div>
        </div>
        <iframe src="${String(mainUrl).replaceAll('"', '&quot;')}" title="Main Screen Preview"></iframe>
      </section>
      <section class="panel">
        <div class="panel-head">
          <div class="panel-title">Participant View</div>
          <div class="panel-copy">Phone experience preview</div>
        </div>
        <iframe src="${String(participantUrl).replaceAll('"', '&quot;')}" title="Participant Preview"></iframe>
      </section>
    </div>
  </div>
</body>
</html>`);
  previewWindow.document.close();
}

async function saveSongLabels() {
  if (!currentEvent || currentEvent.mode !== 'song') return;
  const labels = getSongEditorLabels();
  const res = await fetch(`/api/events/${currentEvent.id}/song/labels`, adminJsonOptions('POST', { labels }));
  const data = await res.json();
  if (!data.ok) return;
  currentEvent.songState = data.songState || currentEvent.songState;
}

async function openEventById(eventId) {
  const storedCode = getStoredAdminCode(eventId);
  let res = await fetch(`/api/events/${eventId}${storedCode ? `?code=${encodeURIComponent(storedCode)}` : ''}`);
  let data = await res.json();
  if (data.ok && data.event && !data.event.adminCode) {
    const suppliedCode = (prompt('Enter admin code or PIN for this event:') || '').trim();
    if (suppliedCode) {
      res = await fetch(`/api/events/${eventId}?code=${encodeURIComponent(suppliedCode)}`);
      data = await res.json();
    }
  }
  if (!data.ok) return;
  currentEvent = data.event;
  rememberAdminCode(currentEvent);
  populateEventLinks();
  $('speed').value = currentEvent.speed || 'balanced';
  currentVolume = currentEvent.audioVolume;
  currentMuted = currentEvent.audioMuted;
  $('volumeRange').value = String(currentVolume);
  renderAudioStateLabel();
  renderTranscriptList();
  fillGlossaryLangs(currentEvent.targetLangs || []);
  renderActiveEventBadge(currentEvent);
  renderSongState(currentEvent.songState || {});
  if ($('manualSourceLang')) $('manualSourceLang').value = currentEvent.displayState?.manualSourceLang || currentEvent.sourceLang || 'ro';
  refreshDisplayControls();
  renderSongHistory(currentEvent.songHistory || []);
  await loadSongLibrary();
  await loadGlobalSongLibrary();
  closeInlineEditors();
  setPartialTranscript();
  if (!currentEvent.adminCode) {
    setStatus('Event opened in read-only mode. Admin code is required for control.');
    switchTab('dashboard');
    return;
  }
  socket.emit('join_event', { eventId: currentEvent.id, role: 'admin', code: currentEvent.adminCode });
  await refreshEventList();
  setStatus(`Opened: ${currentEvent.name}. Editing in Live Control.`);
  switchTab('dashboard');
}

async function createEvent() {
  const name = $('eventName').value.trim() || 'New event';
  const sourceLang = $('sourceLang').value;
  const targetLangs = selectedLangs();
  const scheduledDate = $('eventDate')?.value || '';
  const scheduledTime = $('eventTime')?.value || '';
  const timezone = $('eventTimezone')?.value || detectBrowserTimezone();
  if (!scheduledDate) return alert('Choose a date for the service.');
  if (!scheduledTime) return alert('Choose a start time for the service.');
  if (!targetLangs.length) return alert('Choose at least one target language.');
  if (targetLangs.includes(sourceLang)) return alert('Remove source language from target languages.');
  const createCode = currentEvent?.adminCode || getStoredAdminCode(currentEvent?.id || '');
  const res = await fetch('/api/events', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      code: createCode,
      name, speed: $('speed').value || 'balanced', sourceLang, targetLangs,
      scheduledAt: buildScheduledAt(),
      scheduledDate, scheduledTime, timezone
    })
  });
  const data = await res.json();
  if (!data.ok) return alert(data.error || 'Could not create event.');
  currentEvent = data.event;
  rememberAdminCode(currentEvent);
  populateEventLinks();
  fillGlossaryLangs(currentEvent.targetLangs || []);
  if ($('manualSourceLang')) $('manualSourceLang').value = currentEvent.displayState?.manualSourceLang || currentEvent.sourceLang || 'ro';
  renderActiveEventBadge(currentEvent);
  renderSongState(currentEvent.songState || {});
  refreshDisplayControls();
  renderSongHistory(currentEvent.songHistory || []);
  await loadSongLibrary();
  await loadGlobalSongLibrary();
  socket.emit('join_event', { eventId: currentEvent.id, role: 'admin', code: currentEvent.adminCode });
  if ($('eventModePreset').value === 'song') await setEventMode('song');
  await refreshEventList();
  setStatus('Event created.');
  switchTab('events');
  setTimeout(() => {
    $('eventOperatorPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('remoteOperatorName')?.focus();
  }, 0);
}

async function setEventMode(mode) {
  if (!currentEvent) return;
  const res = await fetch(`/api/events/${currentEvent.id}/mode`, adminJsonOptions('POST', { mode }));
  const data = await res.json();
  if (data.ok) {
    currentEvent = data.event;
    if (mode === 'live') currentEvent.mode = 'live';
    renderActiveEventBadge(currentEvent);
    refreshDisplayControls();
  }
}

async function returnToLiveText() {
  if (!currentEvent) return alert('Open or create an event first.');
  await syncSpeedToEvent();
  try {
    const res = await fetch(`/api/events/${currentEvent.id}/mode`, adminJsonOptions('POST', { mode: 'live', scope: 'participant' }));
    const data = await res.json();
    if (data.ok) {
      currentEvent = data.event;
      currentEvent.mode = 'live';
      renderActiveEventBadge(currentEvent);
      refreshDisplayControls();
    }
  } catch (err) {
    console.error(err);
  }
  setStatus('Participants are back on live text. Main screen unchanged.');
}

async function setActiveEvent() {
  if (!currentEvent) return;
  const res = await fetch(`/api/events/${currentEvent.id}/activate`, adminJsonOptions('POST'));
  const data = await res.json();
  if (data.ok) {
    currentEvent = data.event;
    renderActiveEventBadge(currentEvent);
    setStatus('Event is live now.');
  }
}

async function loadAudioInputs(keepValue = true) {
  const select = $('audioInput');
  const previous = keepValue ? select.value : '';
  select.innerHTML = '';
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    if (!inputs.length) {
      const o = document.createElement('option');
      o.textContent = 'No audio input';
      o.value = '';
      select.appendChild(o);
      return;
    }
    inputs.forEach((d) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || 'Audio input';
      select.appendChild(o);
    });
    if (previous && inputs.some((d) => d.deviceId === previous)) select.value = previous;
  } catch (_) {
    setStatus('Could not read audio inputs.');
  }
}

async function destroyAudioPipeline(options = {}) {
  const preserveRunState = !!options.preserveRunState;
  const wasRunning = audioState.running;
  const wasWindowRunning = window.isRecognitionRunning;
  audioState.running = false;
  if (!preserveRunState) window.isRecognitionRunning = false;
  stopAzureAudioStream();
  if (audioState.chunkTimer) clearTimeout(audioState.chunkTimer);
  audioState.chunkTimer = null;
  audioState.chunks = [];
  audioState.mimeType = '';
  if (audioState.recorder && audioState.recorder.state !== 'inactive') { try { audioState.recorder.stop(); } catch (_) {} }
  audioState.recorder = null;
  if (audioState.meterFrame) cancelAnimationFrame(audioState.meterFrame);
  audioState.meterFrame = null;
  if (audioState.stream) audioState.stream.getTracks().forEach((t) => t.stop());
  audioState.stream = null;
  stopBrowserAzureRecognition();
  if (audioState.context) await audioState.context.close().catch(() => {});
  audioState.context = null;
  audioState.source = null;
  audioState.rawAnalyser = null;
  audioState.gainNode = null;
  audioState.preampNode = null;
  audioState.analyser = null;
  audioState.monitorGainNode = null;
  audioState.destination = null;
  audioState.busy = false;
  audioState.uploadQueue = [];
  $('audioLevel').value = 0;
  if (preserveRunState) {
    audioState.running = wasRunning;
    window.isRecognitionRunning = wasWindowRunning;
    setOnAirState(wasRunning);
  } else {
    setOnAirState(false);
  }
}

function sliderToGain(value) {
  const v = Math.max(0, Number(value || 100));
  return Math.pow(v / 100, 2);
}

function getInputGainPercent() {
  return Math.max(0, Number($('inputGainRange')?.value || 0));
}

function getAudioProcessingSettings() {
  return {
    echoCancellation: !!$('echoCancellationBox')?.checked,
    noiseSuppression: !!$('noiseSuppressionBox')?.checked,
    autoGainControl: !!$('autoGainControlBox')?.checked
  };
}

function saveAudioProcessingSettings() {
  try {
    localStorage.setItem(AUDIO_PROCESSING_STORAGE_KEY, JSON.stringify(getAudioProcessingSettings()));
  } catch (_) {}
}

function hydrateAudioProcessingSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(AUDIO_PROCESSING_STORAGE_KEY) || '{}') || {};
  } catch (_) {
    saved = {};
  }
  const controls = [
    ['echoCancellationBox', 'echoCancellation'],
    ['noiseSuppressionBox', 'noiseSuppression'],
    ['autoGainControlBox', 'autoGainControl']
  ];
  controls.forEach(([id, key]) => {
    const el = $(id);
    if (el) el.checked = !!saved[key];
  });
  updateAudioProcessingHint();
}

function updateAudioProcessingHint() {
  const settings = getAudioProcessingSettings();
  const active = Object.entries(settings)
    .filter(([, enabled]) => enabled)
    .map(([key]) => ({
      echoCancellation: 'echo cancellation',
      noiseSuppression: 'noise suppression',
      autoGainControl: 'auto gain'
    })[key]);
  const hint = $('audioProcessingHint');
  if (hint) {
    hint.textContent = active.length
      ? `Browser processing active: ${active.join(', ')}.`
      : 'Processing is off by default for the most natural speech input.';
  }
}

function getAudioConstraints(deviceId = '') {
  const processing = getAudioProcessingSettings();
  const audio = {
    channelCount: 1,
    sampleRate: 48000,
    sampleSize: 16,
    echoCancellation: processing.echoCancellation,
    noiseSuppression: processing.noiseSuppression,
    autoGainControl: processing.autoGainControl
  };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return { audio };
}

async function handleAudioProcessingChange() {
  saveAudioProcessingSettings();
  updateAudioProcessingHint();
  if (audioState.running) {
    setStatus('Restarting audio with new processing settings...');
    const restartOptions = audioState.openAiFallbackActive
      ? { forceRestart: true, forceSpeechProvider: 'openai' }
      : { forceRestart: true };
    await startTranslation(restartOptions);
    return;
  }
  try {
    await createAudioPipeline();
    setStatus('Audio processing settings applied.');
  } catch (_) {
    setStatus('Audio settings saved. Start live to apply them.');
  }
}

function updateInputGain() {
  const value = getInputGainPercent();
  const gain = sliderToGain(value);
  $('inputGainLabel').textContent = `${value}% - ${gain.toFixed(1)}x`;
  if (audioState.preampNode) audioState.preampNode.gain.value = gain;
  if (audioState.running && value <= 0) setStatus('Audio blocked: input gain is 0%.');
}

function updateMonitorGain() {
  const enabled = !!$('monitorAudioBox').checked;
  const value = Number($('monitorGainRange').value || 0);
  const gain = enabled ? sliderToGain(value) : 0;
  $('monitorGainLabel').textContent = `${value}% - ${gain.toFixed(1)}x`;
  if (audioState.monitorGainNode) audioState.monitorGainNode.gain.value = gain;
}

function startMeterLoop() {
  if (!audioState.analyser) return;
  const displayData = new Uint8Array(audioState.analyser.fftSize);
  const gateData = new Uint8Array(audioState.analyser.fftSize);
  const draw = () => {
    if (!audioState.analyser) return;
    audioState.analyser.getByteTimeDomainData(displayData);
    audioState.analyser.getByteTimeDomainData(gateData);
    let displaySumSquares = 0;
    let gateSumSquares = 0;
    for (let i = 0; i < displayData.length; i++) {
      const normalized = (displayData[i] - 128) / 128;
      displaySumSquares += normalized * normalized;
    }
    for (let i = 0; i < gateData.length; i++) {
      const normalized = (gateData[i] - 128) / 128;
      gateSumSquares += normalized * normalized;
    }
    const displayRms = Math.sqrt(displaySumSquares / displayData.length);
    const gateRms = Math.sqrt(gateSumSquares / gateData.length);
    const displayDb = 20 * Math.log10(Math.max(displayRms, 0.00001));
    const gateDb = 20 * Math.log10(Math.max(gateRms, 0.00001));
    // Display: noise-floor at -45dB → 0%, full scale at -15dB → 100%, with a small dead-zone below 4%.
    const displayRaw = ((displayDb + 45) / 30) * 100;
    const displayLevel = displayRaw < 4 ? 0 : Math.max(0, Math.min(100, Math.round(displayRaw)));
    // Gate keeps the wider window so quiet speech still triggers the audio gate as before.
    const gateLevel = Math.max(0, Math.min(100, Math.round(((gateDb + 60) / 60) * 100)));
    $('audioLevel').value = displayLevel;
    audioState.currentLevel = displayLevel;
    audioState.chunkPeakLevel = Math.max(audioState.chunkPeakLevel || 0, gateLevel);
    audioState.chunkMinLevel = Math.min(Number.isFinite(audioState.chunkMinLevel) ? audioState.chunkMinLevel : 100, gateLevel);
    if (gateLevel >= AUDIO_GATE_MIN_PEAK) audioState.chunkActiveFrames = (audioState.chunkActiveFrames || 0) + 1;
    audioState.meterFrame = requestAnimationFrame(draw);
  };
  draw();
}

async function createAudioPipeline(options = {}) {
  const deviceId = $('audioInput').value;
  await destroyAudioPipeline({ preserveRunState: !!options.preserveRunState });
  audioState.stream = await navigator.mediaDevices.getUserMedia(getAudioConstraints(deviceId));
  audioState.context = new (window.AudioContext || window.webkitAudioContext)();
  await audioState.context.resume();
  audioState.source = audioState.context.createMediaStreamSource(audioState.stream);
  audioState.rawAnalyser = audioState.context.createAnalyser();
  audioState.rawAnalyser.fftSize = 2048;
  audioState.gainNode = audioState.context.createGain();
  audioState.preampNode = audioState.context.createGain();
  audioState.analyser = audioState.context.createAnalyser();
  audioState.analyser.fftSize = 2048;
  audioState.destination = audioState.context.createMediaStreamDestination();
  audioState.source.connect(audioState.rawAnalyser);
  audioState.source.connect(audioState.gainNode);
  audioState.gainNode.connect(audioState.preampNode);
  audioState.preampNode.connect(audioState.analyser);
  audioState.preampNode.connect(audioState.destination);
  audioState.monitorGainNode = audioState.context.createGain();
  audioState.monitorGainNode.gain.value = 0;
  audioState.preampNode.connect(audioState.monitorGainNode);
  audioState.monitorGainNode.connect(audioState.context.destination);
  audioState.gainNode.gain.value = 1;
  updateInputGain();
  updateMonitorGain();
  startMeterLoop();
}

async function loadSpeechRuntimeConfig() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    audioState.speechProvider = normalizeSpeechProvider(data.speechProvider || 'openai');
    if (data.publicBaseUrl) {
      publicBaseUrl = String(data.publicBaseUrl).replace(/\/+$/, '');
      hydratePermanentParticipantAccess();
    }
  } catch (_) {
    audioState.speechProvider = 'openai';
  }
  return audioState.speechProvider;
}

function normalizeSpeechProvider(provider) {
  return provider === 'azure' ? 'azure_sdk' : (provider || 'openai');
}

function isAzureSpeechProvider(provider = audioState.speechProvider) {
  return provider === 'azure' || provider === 'azure_sdk';
}

function sourceLangToAzureLocale(code) {
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

async function getBrowserAzureSpeechConfig() {
  if (!currentEvent) throw new Error('Open or create an event first.');
  if (!window.SpeechSDK) throw new Error('Azure Speech SDK did not load.');
  const res = await fetch(`/api/events/${currentEvent.id}/azure-token?code=${encodeURIComponent(currentEvent.adminCode || '')}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Azure token failed.');
  const speechConfig = SpeechSDK.SpeechConfig.fromAuthorizationToken(data.token, data.region);
  const sourceCode = currentEvent.liveSourceLang === 'auto'
    ? (currentEvent.sourceLang || 'ro')
    : (currentEvent.liveSourceLang || currentEvent.sourceLang || 'ro');
  speechConfig.speechRecognitionLanguage = sourceLangToAzureLocale(sourceCode);
  speechConfig.setProperty(SpeechSDK.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs, '750');
  return speechConfig;
}

async function startBrowserAzureRecognition() {
  if (!currentEvent) return false;
  if (!window.SpeechSDK) {
    setStatus('Azure Speech SDK did not load. Falling back to server audio.');
    return false;
  }
  const speechConfig = await getBrowserAzureSpeechConfig();
  try {
    await createAudioPipeline({ preserveRunState: true });
  } catch (err) {
    console.error(err);
    audioState.running = false;
    window.isRecognitionRunning = false;
    setOnAirState(false);
    setStatus('Audio start failed.');
    return false;
  }
  let audioConfig = null;
  if (SpeechSDK.AudioConfig.fromStreamInput && audioState.destination?.stream) {
    try {
      audioConfig = SpeechSDK.AudioConfig.fromStreamInput(audioState.destination.stream);
    } catch (err) {
      console.warn('Could not attach processed audio stream to Azure SDK:', err);
    }
  }
  if (!audioConfig) audioConfig = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();
  const recognizer = new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);
  audioState.browserRecognizer = recognizer;

  recognizer.recognizing = (_, event) => {
    const text = event.result?.text || '';
    if (text) setPartialTranscript(text);
  };

  recognizer.recognized = (_, event) => {
    if (event.result.reason !== SpeechSDK.ResultReason.RecognizedSpeech) return;
    const text = String(event.result.text || '').trim();
    if (!text || !currentEvent) return;
    setPartialTranscript(text);
    socket.emit('submit_text', { eventId: currentEvent.id, text });
  };

  recognizer.canceled = (_, event) => {
    console.error(event);
    setStatus(`Azure canceled: ${event.errorDetails || event.reason}`);
    stopBrowserAzureRecognition();
  };

  recognizer.sessionStopped = () => {
    if (audioState.running && isAzureSpeechProvider()) setStatus('Azure session stopped.');
    stopBrowserAzureRecognition();
  };

  recognizer.startContinuousRecognitionAsync(
    () => setStatus('On-Air. Azure Speech is listening.'),
    (err) => {
      console.error(err);
      setStatus(String(err || 'Could not start Azure recognition.'));
      stopBrowserAzureRecognition();
    }
  );
  return true;
}

function stopBrowserAzureRecognition() {
  const recognizer = audioState.browserRecognizer;
  if (!recognizer) return;
  audioState.browserRecognizer = null;
  try {
    recognizer.stopContinuousRecognitionAsync(
      () => recognizer.close(),
      () => recognizer.close()
    );
  } catch (_) {
    try { recognizer.close(); } catch (__) {}
  }
}

function downsampleTo16kPcm(input, inputRate) {
  const outputRate = 16000;
  if (!input?.length) return new ArrayBuffer(0);
  if (inputRate === outputRate) {
    const output = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const sample = Math.max(-1, Math.min(1, input[i]));
      output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return output.buffer;
  }

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

async function startAzureAudioStream() {
  if (!currentEvent || !audioState.context || !audioState.preampNode) return false;
  audioState.azureReady = false;
  socket.emit('azure_audio_start', { eventId: currentEvent.id });

  audioState.azureSource = audioState.preampNode;
  audioState.azureProcessor = audioState.context.createScriptProcessor(4096, 1, 1);
  audioState.azureProcessor.onaudioprocess = (event) => {
    if (!audioState.running || !isAzureSpeechProvider()) return;
    if (getInputGainPercent() <= 0) return;
    const pcm = downsampleTo16kPcm(event.inputBuffer.getChannelData(0), audioState.context.sampleRate);
    if (pcm.byteLength) socket.emit('azure_audio_chunk', { eventId: currentEvent.id, audio: pcm });
  };
  audioState.azureSource.connect(audioState.azureProcessor);
  audioState.azureProcessor.connect(audioState.context.destination);
  return true;
}

function stopAzureAudioStream() {
  if (currentEvent) socket.emit('azure_audio_stop', { eventId: currentEvent.id });
  if (audioState.azureSource && audioState.azureProcessor) {
    try { audioState.azureSource.disconnect(audioState.azureProcessor); } catch (_) {}
  }
  if (audioState.azureProcessor) {
    audioState.azureProcessor.disconnect();
    audioState.azureProcessor.onaudioprocess = null;
  }
  audioState.azureProcessor = null;
  audioState.azureSource = null;
  audioState.azureReady = false;
}

function chooseRecorderMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm'];
  return candidates.find((type) => window.MediaRecorder?.isTypeSupported?.(type)) || '';
}

function getAudioFileInfo(mimeType) {
  const type = String(mimeType || '').toLowerCase();
  if (type.includes('wav')) return { mimeType: 'audio/wav', ext: 'wav' };
  if (type.includes('mp4') || type.includes('m4a')) return { mimeType: 'audio/mp4', ext: 'm4a' };
  return { mimeType: 'audio/webm', ext: 'webm' };
}

async function postAudioChunk(blob) {
  if (!currentEvent || !blob || blob.size < 3500) return;
  if (getInputGainPercent() <= 0) return;
  const detectedType = blob.type || audioState.mimeType || 'audio/webm';
  const fileInfo = getAudioFileInfo(detectedType);
  const form = new FormData();
  form.append('code', currentEvent.adminCode);
  form.append('audio', new File([blob], `chunk.${fileInfo.ext}`, { type: fileInfo.mimeType }));
  const res = await fetch(`/api/events/${currentEvent.id}/transcribe`, { method: 'POST', body: form });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Audio upload failed.');
}

function resetAudioGateStats() {
  audioState.chunkPeakLevel = 0;
  audioState.chunkMinLevel = 100;
  audioState.chunkActiveFrames = 0;
}

function shouldUploadAudioChunk(blob, gateStats = {}) {
  if (!blob || blob.size < 3500) return false;
  if (getInputGainPercent() <= 0) return false;
  const peak = Number(gateStats.peak || 0);
  const min = Number.isFinite(gateStats.min) ? Number(gateStats.min) : 100;
  const activeFrames = Number(gateStats.activeFrames || 0);
  const dynamicRange = Math.max(0, peak - min);
  return peak >= AUDIO_GATE_MIN_PEAK
    && activeFrames >= AUDIO_GATE_MIN_ACTIVE_FRAMES
    && (dynamicRange >= AUDIO_GATE_MIN_DYNAMIC_RANGE || peak >= AUDIO_GATE_STRONG_PEAK);
}

function enqueueAudioBlob(blob) {
  if (!blob || blob.size < 3500) return;
  audioState.uploadQueue.push(blob);
  if (!audioState.busy) drainAudioUploadQueue().catch(console.error);
}

async function drainAudioUploadQueue() {
  if (audioState.busy) return;
  audioState.busy = true;
  try {
    while (audioState.uploadQueue.length) {
      const blob = audioState.uploadQueue.shift();
      try { await postAudioChunk(blob); } catch (err) { setStatus(err.message || 'Audio send failed.'); }
    }
  } finally {
    audioState.busy = false;
  }
}

async function startTranslation(options = {}) {
  if (!currentEvent) return alert('Open or create an event first.');
  if ((audioState.running || window.isRecognitionRunning) && !options.forceRestart) {
    setStatus('Already On-Air. Press Stop first if you want to restart.');
    return;
  }
  await syncSpeedToEvent();
  if (options.forceSpeechProvider) {
    audioState.speechProvider = options.forceSpeechProvider;
  } else {
    await loadSpeechRuntimeConfig();
    audioState.openAiFallbackActive = false;
  }
  await setEventMode('live');
  audioState.running = true;
  window.isRecognitionRunning = true;
  setOnAirState(true);
  notifyTranscriptionPaused(false);
  await enableScreenWakeLock();
  if (isAzureSpeechProvider()) {
    try {
      await createAudioPipeline({ preserveRunState: true });
    } catch (err) {
      console.error(err);
      audioState.running = false;
      window.isRecognitionRunning = false;
      setOnAirState(false);
      return setStatus('Audio start failed.');
    }
    const streamStarted = await startAzureAudioStream().catch((err) => {
      console.error(err);
      setStatus(err.message || 'Azure audio stream failed.');
      return false;
    });
    if (streamStarted) {
      setStatus('On-Air. Connecting Azure Speech...');
      return;
    }
    const started = await startBrowserAzureRecognition().catch((err) => {
      console.error(err);
      setStatus(err.message || 'Azure Speech start failed.');
      return false;
    });
    if (started) return;
  }
  if (!window.MediaRecorder) return alert('Use Chrome or Edge.');
  try { await createAudioPipeline({ preserveRunState: true }); } catch (_) {
    audioState.running = false;
    window.isRecognitionRunning = false;
    setOnAirState(false);
    return setStatus('Audio start failed.');
  }
  const mimeType = chooseRecorderMimeType();
  if (!mimeType) return alert('Unsupported audio format in this browser.');
  audioState.mimeType = mimeType;
  const startRecorderCycle = () => {
    if (!audioState.running) return;
    audioState.chunks = [];
    resetAudioGateStats();
    const recorder = new MediaRecorder(audioState.destination.stream, { mimeType, audioBitsPerSecond: 128000 });
    audioState.recorder = recorder;
    recorder.ondataavailable = (event) => { if (event.data && event.data.size > 0) audioState.chunks.push(event.data); };
    recorder.onstop = () => {
      const finalType = recorder.mimeType || mimeType || 'audio/webm';
      const blob = new Blob(audioState.chunks, { type: finalType });
      const gateStats = {
        peak: audioState.chunkPeakLevel,
        min: audioState.chunkMinLevel,
        activeFrames: audioState.chunkActiveFrames
      };
      audioState.chunks = [];
      if (audioState.chunkTimer) clearTimeout(audioState.chunkTimer);
      audioState.chunkTimer = null;
      if (audioState.recorder === recorder) audioState.recorder = null;
      if (audioState.running) startRecorderCycle();
      if (shouldUploadAudioChunk(blob, gateStats)) {
        enqueueAudioBlob(blob);
      } else if (audioState.running && getInputGainPercent() <= 0 && Date.now() - (audioState.lastGateStatusAt || 0) > 3000) {
        audioState.lastGateStatusAt = Date.now();
        setStatus('Audio blocked: input gain is 0%.');
      } else if (audioState.running && Date.now() - (audioState.lastGateStatusAt || 0) > 8000) {
        audioState.lastGateStatusAt = Date.now();
        setStatus('Listening. Quiet or steady noise skipped.');
      }
    };
    recorder.start();
    audioState.chunkTimer = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 5200);
  };
  startRecorderCycle();
  setStatus('On-Air. Translating from selected source.');
}

async function stopTranslation() {
  audioState.running = false;
  window.isRecognitionRunning = false;
  audioState.openAiFallbackActive = false;
  if (audioState.chunkTimer) clearTimeout(audioState.chunkTimer);
  audioState.chunkTimer = null;
  stopBrowserAzureRecognition();
  stopAzureAudioStream();
  setOnAirState(false);
  notifyTranscriptionPaused(true);
  await disableScreenWakeLock();
  if (audioState.recorder && audioState.recorder.state === 'recording') {
    audioState.recorder.stop();
    setTimeout(() => destroyAudioPipeline().catch(console.error), 100);
    return;
  }
  await destroyAudioPipeline();
  setStatus('Stopped.');
}

async function sendManualText(target = 'auto') {
  if (!currentEvent) return alert('Open or create an event first.');
  const title = $('manualTitle')?.value.trim() || '';
  const text = $('manualText').value.trim();
  const sourceLang = $('manualSourceLang')?.value || currentEvent?.sourceLang || 'ro';
  if (!text) return;

  if (target === 'manual') {
    const res = await fetch(
      `/api/events/${currentEvent.id}/display/manual`,
      adminJsonOptions('POST', { text, title, sourceLang })
    );
    const data = await res.json();
    if (!data.ok) {
      setStatus(data.error || 'Manual display push failed.');
      return;
    }

    currentEvent.displayState = {
      ...(currentEvent.displayState || {}),
      ...(data.displayState || {})
    };
    currentEvent.displayStatePrevious = data.previousState || currentEvent.displayStatePrevious || null;
    currentEvent.mode = 'live';
    currentEvent.songHistory = data.songHistory || currentEvent.songHistory || [];
    refreshDisplayControls();
    renderActiveEventBadge(currentEvent);
    renderSongHistory(currentEvent.songHistory);
    renderSongState(currentEvent.songState || {});
    setStatus('Manual text published to main screen.');
  } else {
    await setEventMode('live');
    socket.emit('submit_text', { eventId: currentEvent.id, text });
    setStatus('Text sent to live translation flow.');
  }

  if ($('manualTitle')) $('manualTitle').value = '';
  $('manualText').value = '';
  if ($('manualSourceLang')) $('manualSourceLang').value = currentEvent?.sourceLang || 'ro';
  lastManualEnterAt = 0;
}

async function savePinnedTextToLibrary() {
  const title = $('manualTitle')?.value.trim() || '';
  const text = $('manualText')?.value.trim() || '';
  const sourceLang = $('manualSourceLang')?.value || currentEvent?.sourceLang || 'ro';
  if (!title || !text) {
    alert('Add both a title and text before saving.');
    return;
  }
  try {
    const res = await fetch('/api/pinned-text-library', globalJsonOptions('POST', { title, text, sourceLang }));
    const data = await res.json();
    if (!data.ok) {
      alert(data.error || 'Could not save pinned text.');
      return;
    }
    currentPinnedTextLibrary = data.pinnedTextLibrary || [];
    renderPinnedTextLibrary(currentPinnedTextLibrary);
    $('manualTitle').value = '';
    $('manualText').value = '';
    if ($('manualSourceLang')) $('manualSourceLang').value = currentEvent?.sourceLang || 'ro';
    lastManualEnterAt = 0;
    setStatus('Saved to pinned text library.');
  } catch (err) {
    console.error(err);
    alert('Could not save pinned text.');
  }
}

function getManualHistoryItemById(itemId) {
  return (currentEvent?.songHistory || []).find((item) => item.id === itemId && (item.kind || 'song') === 'manual') || null;
}


async function loadSong() {
  switchTab('song');
}

async function moveSong(direction) {
  return;
}

async function showSongIndex(index) {
  return;
}

async function clearSong() {
  $('songTitle').value = '';
  $('songText').value = '';
  if ($('songSourceLang')) $('songSourceLang').value = currentEvent?.sourceLang || 'ro';
  setStatus('Editor cleared.');
}


socket.on('joined_event', ({ event, role }) => {
  if (role !== 'admin') return;
  currentEvent = event;
  if ($('songSourceLang')) $('songSourceLang').value = currentEvent.songState?.sourceLang || currentEvent.sourceLang || 'ro';
  if ($('manualSourceLang')) $('manualSourceLang').value = currentEvent.displayState?.manualSourceLang || currentEvent.sourceLang || 'ro';
  $('speed').value = event.speed || 'balanced';
  currentVolume = event.audioVolume;
  currentMuted = event.audioMuted;
  $('volumeRange').value = String(currentVolume);
  renderAudioStateLabel();
  renderTranscriptList();
  fillGlossaryLangs(currentEvent.targetLangs || []);
  renderActiveEventBadge(currentEvent);
  renderSongState(currentEvent.songState || {});
  refreshDisplayControls();
  renderSongHistory(event.songHistory || []);
  renderUsageStats(event.usageStats || {});
  loadSongLibrary();
  loadGlobalSongLibrary();
  loadPinnedTextLibrary();
  loadDisplayPresets();
  populateEventLinks();
  closeInlineEditors();
  refreshEventList();
  setPartialTranscript();
});

socket.on('transcript_entry', (entry) => {
  if (!currentEvent) return;
  currentEvent.transcripts = currentEvent.transcripts || [];
  if (!getEntryById(entry.id)) currentEvent.transcripts.push(entry);
  renderEntry(entry);
  renderDisplayAuditSummary();
  setPartialTranscript();
});

socket.on('transcript_updated', (payload) => {
  updateEntry(payload);
  renderDisplayAuditSummary();
});
socket.on('transcript_source_updated', (payload) => {
  updateSourceEntry(payload);
  renderDisplayAuditSummary();
  setPartialTranscript();
});
socket.on('audio_state', ({ audioMuted, audioVolume }) => {
  currentMuted = audioMuted;
  currentVolume = audioVolume;
  $('volumeRange').value = String(audioVolume);
  renderAudioStateLabel();
});
socket.on('partial_transcript', ({ text }) => { setPartialTranscript(text); });
socket.on('azure_audio_ready', () => {
  audioState.azureReady = true;
  if (audioState.running && isAzureSpeechProvider()) setStatus('On-Air. Azure Speech connected.');
});
socket.on('participant_stats', renderParticipantStats);
socket.on('usage_stats', renderUsageStats);
async function fallbackToOpenAiFromAzure(payload = {}) {
  const message = payload.message || 'Azure Speech failed.';
  const code = String(payload.code || '').toLowerCase();
  const text = `${code} ${message}`.toLowerCase();
  const isAzureSpeechError = payload.provider === 'azure_sdk' || payload.provider === 'azure' || text.includes('azure speech');
  const shouldFallback = isAzureSpeechError
    && audioState.running
    && isAzureSpeechProvider()
    && !audioState.openAiFallbackActive
    && (
      payload.fallbackToOpenAI
      || text.includes('auth')
      || text.includes('unauthorized')
      || text.includes('forbidden')
      || text.includes('subscription')
      || text.includes('quota')
      || text.includes('failed')
      || text.includes('oprit')
      || text.includes('nu am putut porni')
    );
  if (!shouldFallback) return false;
  audioState.openAiFallbackActive = true;
  setStatus(`${message} Switching to OpenAI backup...`);
  stopAzureAudioStream();
  stopBrowserAzureRecognition();
  audioState.speechProvider = 'openai';
  await startTranslation({ forceRestart: true, forceSpeechProvider: 'openai' });
  return true;
}

socket.on('server_error', (payload = {}) => {
  const message = payload.message || 'Server error.';
  setStatus(message);
  fallbackToOpenAiFromAzure(payload).catch((err) => {
    console.error(err);
    setStatus('Azure failed and OpenAI backup could not start.');
  });
});
socket.on('active_event_changed', async ({ eventId }) => {
  if (currentEvent) {
    currentEvent.isActive = currentEvent.id === eventId;
    renderActiveEventBadge(currentEvent);
  }
  await refreshEventList();
});
socket.on('mode_changed', ({ mode }) => {
  if (!currentEvent) return;
  currentEvent.mode = mode;
  if (mode === 'live') {
    currentEvent.displayState = currentEvent.displayState || {};
    currentEvent.displayState.mode = 'auto';
    currentEvent.displayState.blackScreen = false;
    refreshDisplayControls();
  }
  renderActiveEventBadge(currentEvent);
});
socket.on('song_state', (songState) => {
  if (!currentEvent) return;
  currentEvent.songState = songState;
  currentEvent.mode = 'song';
  if ($('songSourceLang')) $('songSourceLang').value = songState?.sourceLang || currentEvent.sourceLang || 'ro';
  renderSongState(songState);
  renderDisplayAuditSummary();
});
socket.on('song_clear', () => {
  if (!currentEvent) return;
  currentEvent.songState = { title: '', sourceLang: currentEvent.sourceLang || 'ro', blocks: [], blockLabels: [], currentIndex: -1, activeBlock: null, translations: {}, allTranslations: [], updatedAt: null };
  currentEvent.mode = 'live';
  if ($('songSourceLang')) $('songSourceLang').value = currentEvent.sourceLang || 'ro';
  renderSongState(currentEvent.songState);
  renderActiveEventBadge(currentEvent);
  renderDisplayAuditSummary();
});
socket.on('display_mode_changed', ({ mode, blackScreen, theme, language, secondaryLanguage, backgroundPreset, customBackground, showClock, clockPosition, clockScale, textSize, textScale, screenStyle, displayResolution, sceneLabel, manualSourceLang, previousState, presets }) => {
  if (!currentEvent) return;
  currentEvent.displayState = currentEvent.displayState || {};
  currentEvent.displayState.mode = mode;
  currentEvent.displayState.blackScreen = !!blackScreen;
  currentEvent.displayState.theme = theme || currentEvent.displayState.theme || 'dark';
  currentEvent.displayState.language = language || currentEvent.displayState.language;
  currentEvent.displayState.secondaryLanguage = secondaryLanguage || '';
  currentEvent.displayState.backgroundPreset = backgroundPreset || currentEvent.displayState.backgroundPreset || 'none';
  currentEvent.displayState.customBackground = typeof customBackground === 'string' ? customBackground : (currentEvent.displayState.customBackground || '');
  currentEvent.displayState.showClock = typeof showClock === 'boolean' ? showClock : !!currentEvent.displayState.showClock;
  currentEvent.displayState.clockPosition = clockPosition || currentEvent.displayState.clockPosition || 'top-right';
  currentEvent.displayState.clockScale = typeof clockScale === 'number' ? clockScale : (currentEvent.displayState.clockScale || 1);
  currentEvent.displayState.textSize = textSize || currentEvent.displayState.textSize || 'large';
  currentEvent.displayState.textScale = typeof textScale === 'number' ? textScale : (currentEvent.displayState.textScale || 1);
  currentEvent.displayState.screenStyle = screenStyle || currentEvent.displayState.screenStyle || 'focus';
  currentEvent.displayState.displayResolution = displayResolution || currentEvent.displayState.displayResolution || 'auto';
  currentEvent.displayState.sceneLabel = sceneLabel || '';
  currentEvent.displayState.manualSourceLang = manualSourceLang || currentEvent.displayState.manualSourceLang || currentEvent.sourceLang || 'ro';
  currentEvent.displayStatePrevious = previousState || null;
  if (Array.isArray(presets)) {
    currentEvent.displayPresets = presets;
    currentDisplayPresets = presets;
  }
  refreshDisplayControls();
  renderActiveEventBadge(currentEvent);
  renderSongState(currentEvent.songState || {});
});
socket.on('display_theme_changed', ({ theme }) => {
  if (!currentEvent) return;
  currentEvent.displayState = currentEvent.displayState || {};
  currentEvent.displayState.theme = theme || 'dark';
  refreshDisplayControls();
});
socket.on('display_manual_update', ({ mode, blackScreen, theme, language, secondaryLanguage, backgroundPreset, customBackground, showClock, clockPosition, clockScale, textSize, textScale, screenStyle, displayResolution, sceneLabel, manualSource, manualSourceLang, manualTranslations, updatedAt, previousState, presets }) => {
  if (!currentEvent) return;
  currentEvent.displayState = currentEvent.displayState || {};
  currentEvent.displayState.mode = mode || 'manual';
  currentEvent.displayState.blackScreen = !!blackScreen;
  currentEvent.displayState.theme = theme || currentEvent.displayState.theme || 'dark';
  currentEvent.displayState.language = language || currentEvent.displayState.language;
  currentEvent.displayState.secondaryLanguage = secondaryLanguage || '';
  currentEvent.displayState.backgroundPreset = backgroundPreset || currentEvent.displayState.backgroundPreset || 'none';
  currentEvent.displayState.customBackground = typeof customBackground === 'string' ? customBackground : (currentEvent.displayState.customBackground || '');
  currentEvent.displayState.showClock = typeof showClock === 'boolean' ? showClock : !!currentEvent.displayState.showClock;
  currentEvent.displayState.clockPosition = clockPosition || currentEvent.displayState.clockPosition || 'top-right';
  currentEvent.displayState.clockScale = typeof clockScale === 'number' ? clockScale : (currentEvent.displayState.clockScale || 1);
  currentEvent.displayState.textSize = textSize || currentEvent.displayState.textSize || 'large';
  currentEvent.displayState.textScale = typeof textScale === 'number' ? textScale : (currentEvent.displayState.textScale || 1);
  currentEvent.displayState.screenStyle = screenStyle || currentEvent.displayState.screenStyle || 'focus';
  currentEvent.displayState.displayResolution = displayResolution || currentEvent.displayState.displayResolution || 'auto';
  currentEvent.displayState.sceneLabel = sceneLabel || '';
  currentEvent.displayState.manualSource = manualSource || '';
  currentEvent.displayState.manualSourceLang = manualSourceLang || currentEvent.displayState.manualSourceLang || currentEvent.sourceLang || 'ro';
  currentEvent.displayState.manualTranslations = manualTranslations || {};
  currentEvent.displayState.updatedAt = updatedAt || currentEvent.displayState.updatedAt || null;
  currentEvent.displayStatePrevious = previousState || null;
  if (Array.isArray(presets)) {
    currentEvent.displayPresets = presets;
    currentDisplayPresets = presets;
  }
  currentEvent.mode = 'live';
  refreshDisplayControls();
  renderActiveEventBadge(currentEvent);
  renderSongState(currentEvent.songState || {});
});
socket.on('display_presets_updated', ({ presets }) => {
  currentDisplayPresets = presets || [];
  if (currentEvent) currentEvent.displayPresets = currentDisplayPresets;
  renderDisplayPresets(currentDisplayPresets);
});
socket.on('song_history_updated', ({ songHistory }) => {
  if (!currentEvent) return;
  currentEvent.songHistory = songHistory || [];
  renderSongHistory(currentEvent.songHistory);
  renderSongState(currentEvent.songState || {});
});

relocateMainScreenControls();
document.querySelectorAll('.nav-btn').forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
$('createEventBtn').addEventListener('click', createEvent);
$('sendManualLiveBtn').addEventListener('click', () => sendManualText('auto'));
$('sendManualDisplayBtn').addEventListener('click', () => sendManualText('manual'));
$('saveManualLibraryBtn').addEventListener('click', savePinnedTextToLibrary);
$('speed').addEventListener('change', syncSpeedToEvent);
$('currentSourceLang')?.addEventListener('change', async () => {
  await syncSpeedToEvent();
  setStatus(`Input language set to ${langLabel(currentEvent?.sourceLang || 'ro')}.`);
});
$('openTranscriptTabBtn').addEventListener('click', () => switchTab('transcript'));
$('manualText').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey) return;
  const now = Date.now();
  if (now - lastManualEnterAt < 600) {
    e.preventDefault();
    sendManualText(currentEvent?.displayState?.mode === 'manual' ? 'manual' : 'auto');
    return;
  }
  lastManualEnterAt = now;
});
$('saveGlossaryBtn').addEventListener('click', async () => {
  if (!currentEvent) return alert('Open or create an event first.');
  const source = $('glossarySource').value.trim();
  const target = $('glossaryTarget').value.trim();
  const lang = $('glossaryLang').value;
  const permanent = !!$('glossaryPermanent').checked;
  if (!source || !target) return;
  const res = await fetch(`/api/events/${currentEvent.id}/glossary`, adminJsonOptions('POST', { source, target, lang, permanent }));
  const data = await res.json();
  if (data.ok) { $('glossarySource').value = ''; $('glossaryTarget').value = ''; setStatus('Glossary saved.'); }
});
$('saveSourceCorrectionBtn').addEventListener('click', async () => {
  if (!currentEvent) return alert('Open or create an event first.');
  const heard = $('sourceWrong').value.trim();
  const correct = $('sourceCorrect').value.trim();
  const permanent = !!$('sourceCorrectionPermanent').checked;
  if (!heard || !correct) return;
  const res = await fetch(`/api/events/${currentEvent.id}/source-corrections`, adminJsonOptions('POST', { heard, correct, permanent }));
  const data = await res.json();
  if (data.ok) { $('sourceWrong').value = ''; $('sourceCorrect').value = ''; setStatus('Speech correction saved.'); }
});
$('glossaryMode').addEventListener('change', updateGlossaryMode);
$('muteGlobalBtn').addEventListener('click', () => {
  if (!currentEvent) return;
  currentMuted = !currentMuted;
  renderAudioStateLabel();
  socket.emit('set_audio_state', { eventId: currentEvent.id, audioMuted: currentMuted, audioVolume: currentVolume });
});
$('panicBtn').addEventListener('click', () => {
  if (!currentEvent) return;
  currentMuted = true;
  currentVolume = 0;
  $('volumeRange').value = '0';
  renderAudioStateLabel();
  socket.emit('set_audio_state', { eventId: currentEvent.id, audioMuted: true, audioVolume: 0 });
});
$('volumeRange').addEventListener('input', () => {
  currentVolume = Number($('volumeRange').value || 70);
  if (!currentEvent) return;
    socket.emit('set_audio_state', { eventId: currentEvent.id, audioMuted: currentMuted, audioVolume: currentVolume });
});
$('inputGainRange').addEventListener('input', updateInputGain);
$('monitorAudioBox').addEventListener('change', updateMonitorGain);
$('monitorGainRange').addEventListener('input', updateMonitorGain);
['echoCancellationBox', 'noiseSuppressionBox', 'autoGainControlBox'].forEach((id) => {
  $(id)?.addEventListener('change', () => handleAudioProcessingChange().catch(console.error));
});
$('audioInput').addEventListener('change', async () => {
  if (audioState.running) {
    const restartOptions = audioState.openAiFallbackActive
      ? { forceRestart: true, forceSpeechProvider: 'openai' }
      : { forceRestart: true };
    await startTranslation(restartOptions);
  }
  else { try { await createAudioPipeline(); setStatus('Audio source changed.'); } catch (_) { setStatus('Selected source failed.'); } }
});
$('startRecognitionBtn').addEventListener('click', startTranslation);
$('stopRecognitionBtn').addEventListener('click', stopTranslation);
$('backToLiveTextBtn')?.addEventListener('click', returnToLiveText);
$('copyParticipantBtn')?.addEventListener('click', () => copyField('participantLink', 'copyParticipantBtn'));
$('copyTranslateBtn').addEventListener('click', () => copyField('translateLink', 'copyTranslateBtn'));
$('copyRemoteControlBtn').addEventListener('click', () => copyField('remoteControlLink', 'copyRemoteControlBtn'));
$('copyAccessRemoteBtn').addEventListener('click', () => copyField('accessRemoteControlLink', 'copyAccessRemoteBtn'));
$('emailParticipantBtn')?.addEventListener('click', () => emailLinkFromField('participantLink', 'participant link'));
$('emailTranslateBtn').addEventListener('click', () => emailLinkFromField('translateLink', 'main screen link'));
$('emailAccessRemoteBtn').addEventListener('click', () => emailLinkFromField('accessRemoteControlLink', 'remote control link'));
$('copyPermanentParticipantBtn')?.addEventListener('click', () => copyField('permanentParticipantLink', 'copyPermanentParticipantBtn'));
$('emailPermanentParticipantBtn')?.addEventListener('click', () => emailLinkFromField('permanentParticipantLink', 'permanent participant link'));
$('downloadPermanentQrBtn')?.addEventListener('click', downloadPermanentQr);
$('copyQrBtn')?.addEventListener('click', copyQrImage);
$('downloadQrBtn')?.addEventListener('click', downloadQr);
$('openRemoteControlBtn').addEventListener('click', () => {
  const url = $('remoteControlLink')?.value || '';
  if (url) window.open(url, '_blank');
});
$('createRemoteOperatorBtn')?.addEventListener('click', async () => {
  if (!currentEvent) return alert('Open or create an event first.');
  const name = $('remoteOperatorName')?.value.trim() || 'Remote operator';
  const profile = $('remoteOperatorProfile')?.value || 'full';
  try {
    const res = await fetch(`/api/events/${currentEvent.id}/remote-operators`, adminJsonOptions('POST', { name, profile }));
    const data = await res.json();
    if (!data.ok) return alert(data.error || 'Could not create operator.');
    currentEvent.remoteOperators = data.remoteOperators || [];
    renderRemoteOperators(currentEvent.remoteOperators);
    $('remoteOperatorName').value = '';
    $('remoteOperatorProfile').value = 'full';
    setStatus(`Remote operator created for ${name}.`);
  } catch (err) {
    console.error(err);
    alert('Could not create operator.');
  }
});
$('setActiveEventBtn').addEventListener('click', setActiveEvent);
$('refreshEventsBtn').addEventListener('click', refreshEventList);
$('jumpLiveBtn').addEventListener('click', () => {
  closeInlineEditors();
  const first = document.querySelector('#transcriptList .entry');
  if (first) first.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('exportTranscriptBtn')?.addEventListener('click', exportTranscript);

async function clearTranscript() {
  if (!currentEvent) return alert('Open an event first.');
  if (!confirm('Clear the entire transcript for this event? This cannot be undone.')) return;
  try {
    const res = await fetch(`/api/events/${currentEvent.id}/transcripts/clear`, adminJsonOptions('POST'));
    const data = await res.json();
    if (!data.ok) return alert(data.error || 'Could not clear transcript.');
    if (currentEvent) {
      currentEvent.transcripts = [];
      currentEvent.latestDisplayEntry = null;
    }
    renderTranscriptList();
    setStatus('Transcript cleared.');
  } catch (err) {
    console.error(err);
    alert('Could not clear transcript.');
  }
}

$('clearTranscriptBtn')?.addEventListener('click', clearTranscript);

function renderLiveLanguagesGrid() {
  const grid = document.getElementById('liveLanguagesGrid');
  if (!grid) return;
  if (!currentEvent) {
    grid.innerHTML = '<div class="muted">Open an event to manage its languages.</div>';
    return;
  }
  const sourceLang = String(currentEvent.sourceLang || 'ro').toLowerCase();
  const selected = new Set((currentEvent.targetLangs || []).map((l) => String(l).toLowerCase()));
  grid.innerHTML = Object.entries(availableLanguages || {}).map(([code, name]) => {
    const isSource = code === sourceLang;
    const checked = selected.has(code);
    return `
      <label class="checkbox-item${isSource ? ' is-source' : ''}">
        <input type="checkbox" class="live-lang-checkbox" value="${escapeHtml(code)}" ${checked ? 'checked' : ''} ${isSource ? 'disabled' : ''}>
        <span>${escapeHtml(name || code.toUpperCase())}${isSource ? ' (source)' : ''}</span>
      </label>
    `;
  }).join('');
}

async function saveLiveLanguages() {
  if (!currentEvent) return alert('Open an event first.');
  const checkboxes = Array.from(document.querySelectorAll('#liveLanguagesGrid .live-lang-checkbox'));
  const next = checkboxes.filter((cb) => cb.checked && !cb.disabled).map((cb) => cb.value);
  if (!next.length) return alert('Pick at least one target language.');
  const status = document.getElementById('liveLanguagesStatus');
  if (status) status.textContent = 'Saving…';
  try {
    const res = await fetch(`/api/events/${currentEvent.id}/target-langs`, adminJsonOptions('POST', { targetLangs: next }));
    const data = await res.json();
    if (!data.ok) {
      if (status) status.textContent = data.error || 'Could not save.';
      return;
    }
    currentEvent.targetLangs = data.targetLangs || next;
    fillGlossaryLangs(currentEvent.targetLangs);
    refreshDisplayControls();
    renderLiveLanguagesGrid();
    if (status) status.textContent = `Saved at ${new Date().toLocaleTimeString()}. Participants will see the new language list immediately.`;
  } catch (err) {
    console.error(err);
    if (status) status.textContent = 'Could not save. Try again.';
  }
}

document.getElementById('saveLiveLanguagesBtn')?.addEventListener('click', saveLiveLanguages);

socket.on('event_target_langs_changed', ({ eventId, targetLangs }) => {
  if (currentEvent && currentEvent.id === eventId && Array.isArray(targetLangs)) {
    currentEvent.targetLangs = targetLangs;
    fillGlossaryLangs(targetLangs);
    refreshDisplayControls();
    renderLiveLanguagesGrid();
  }
});

socket.on('transcripts_cleared', ({ eventId }) => {
  if (currentEvent && currentEvent.id === eventId) {
    currentEvent.transcripts = [];
    currentEvent.latestDisplayEntry = null;
    renderTranscriptList();
  }
});
$('saveSongBtn').addEventListener('click', saveSongToLibrary);
$('sendSongBtn').addEventListener('click', sendSongToLive);
$('songPrevBtn')?.addEventListener('click', goToPrevSongBlock);
$('songNextBtn')?.addEventListener('click', goToNextSongBlock);
$('songJumpSelect')?.addEventListener('change', showSelectedSongSection);
$('blankMainScreenBtn').addEventListener('click', blankMainScreen);
$('displayRestoreBtn').addEventListener('click', restoreLastDisplayState);
  $('displayAutoBtn').addEventListener('click', () => setDisplayMode('auto'));
  $('displayManualBtn').addEventListener('click', () => setDisplayMode('manual'));
  $('displaySongBtn').addEventListener('click', () => setDisplayMode('song'));
  $('displayThemeSelect').addEventListener('change', () => setDisplayTheme($('displayThemeSelect').value));
  $('displayLanguageSelect').addEventListener('change', () => setDisplayLanguage($('displayLanguageSelect').value));
  $('displaySecondaryLanguageSelect')?.addEventListener('change', () => setDisplayLanguage($('displayLanguageSelect').value, $('displaySecondaryLanguageSelect').value));
  $('dualLanguageToggle')?.addEventListener('change', () => toggleDualLanguageDisplay($('dualLanguageToggle').checked));
  $('saveDisplaySettingsBtn').addEventListener('click', saveDisplaySettings);
$('clockSizeMinusBtn')?.addEventListener('click', () => adjustClockScale(-0.1));
$('clockSizePlusBtn')?.addEventListener('click', () => adjustClockScale(0.1));
$('textZoomMinusBtn')?.addEventListener('click', () => adjustDisplayTextScale(-0.05));
$('textZoomPlusBtn')?.addEventListener('click', () => adjustDisplayTextScale(0.05));
$('saveDisplayPresetBtn')?.addEventListener('click', saveDisplayPreset);
$('openMainPreviewBtn').addEventListener('click', openMainPreviewWindow);
$('openParticipantPreviewBtn').addEventListener('click', openParticipantPreviewWindow);
$('openBothPreviewsBtn').addEventListener('click', openBothPreviewWindows);
$('globalSongLibrarySearch').addEventListener('input', () => renderGlobalSongLibrary(currentGlobalSongLibrary));
$('globalSongLibrarySort').addEventListener('change', () => renderGlobalSongLibrary(currentGlobalSongLibrary));
$('manualLibrarySearch').addEventListener('input', () => renderPinnedTextLibrary(currentPinnedTextLibrary));
$('manualLibrarySort').addEventListener('change', () => renderPinnedTextLibrary(currentPinnedTextLibrary));
$('displayLanguageQuickButtons')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-quick-language]');
  if (!btn) return;
  await setDisplayLanguage(btn.getAttribute('data-quick-language'));
});
$('displayShortcutButtons')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-display-shortcut]');
  if (!btn) return;
  await applyDisplayShortcut(btn.getAttribute('data-display-shortcut'));
});
$('songBlocksList')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-song-block-index]');
  if (!btn) return;
  const index = Number(btn.getAttribute('data-song-block-index'));
  if (!Number.isInteger(index)) return;
  await showSongBlock(index);
});
$('songBlocksList')?.addEventListener('change', async (e) => {
  if (!e.target.matches('[data-song-label-input]')) return;
  await saveSongLabels();
});
$('globalSongLibraryList').addEventListener('click', async (e) => {
  const summary = e.target.closest('.library-card-summary');
  if (summary) return;
  const btn = e.target.closest('button[data-global-song-action]');
  if (!btn) return;
  const action = btn.getAttribute('data-global-song-action');
  const songId = btn.getAttribute('data-global-song-id');
  const item = currentGlobalSongLibrary.find((x) => x.id === songId);
  if (!item) return;
  if (action === 'load') {
    fillSongEditor(item);
    setStatus('Loaded from church library.');
    return;
  }
  if (action === 'send') {
    if (!currentEvent) return alert('Open or create an event first.');
    fillSongEditor(item);
    await sendSongItemToLive(item);
    return;
  }
  if (action === 'add') {
    const targetEventId = document.querySelector(`[data-global-song-target="${songId}"]`)?.value || '';
    if (!targetEventId) return alert('Choose the event first.');
    if (!currentEvent) return alert('Open any event first so the admin session is active.');
    const res = await fetch(`/api/events/${currentEvent.id}/global-song-library/${songId}/add-to-event`, adminJsonOptions('POST', { targetEventId }));
    const data = await res.json();
    if (!data.ok) return alert(data.error || 'Could not add item to event.');
    const targetEventName = availableEventsList.find((event) => event.id === targetEventId)?.name || 'selected event';
    setStatus(`Added to ${targetEventName}.`);
    return;
  }
  if (action === 'delete') {
    if (!confirm('Delete this song from church library?')) return;
    const res = await fetch(`/api/global-song-library/${songId}`, globalJsonOptions('DELETE'));
    const data = await res.json();
    if (!data.ok) return alert(data.error || 'Could not delete item.');
    currentGlobalSongLibrary = data.globalSongLibrary || [];
    renderGlobalSongLibrary(currentGlobalSongLibrary);
    setStatus('Deleted from church library.');
  }
});
$('displayPresetsList')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-display-preset-action]');
  if (!btn) return;
  const action = btn.getAttribute('data-display-preset-action');
  const presetId = btn.getAttribute('data-display-preset-id');
  const preset = currentDisplayPresets.find((item) => item.id === presetId);
  if (!preset) return;
  if (action === 'apply') {
    await applyDisplayPreset(presetId);
    return;
  }
  if (action === 'fill') {
    fillDisplayControlsFromPreset(preset);
    return;
  }
  if (action === 'delete') {
    await deleteDisplayPreset(presetId);
  }
});
$('manualHistoryList')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-manual-history-action]');
  if (!btn) return;
  const item = getManualHistoryItemById(btn.getAttribute('data-manual-history-id'));
  if (!item) return;
  if (btn.getAttribute('data-manual-history-action') === 'load') {
    if ($('manualTitle')) $('manualTitle').value = item.title || '';
    $('manualText').value = item.source || '';
    switchTab('manual');
    setStatus('Pinned text loaded into quick push editor.');
    return;
  }
  if ($('manualTitle')) $('manualTitle').value = item.title || '';
  $('manualText').value = item.source || '';
  await sendManualText('manual');
});
$('manualLibraryList')?.addEventListener('click', async (e) => {
  const summary = e.target.closest('.library-card-summary');
  if (summary) return;
  const btn = e.target.closest('button[data-manual-library-action]');
  if (!btn) return;
  const action = btn.getAttribute('data-manual-library-action');
  const itemId = btn.getAttribute('data-manual-library-id');
  const item = currentPinnedTextLibrary.find((entry) => entry.id === itemId);
  if (!item) return;
  if (action === 'load') {
    if ($('manualTitle')) $('manualTitle').value = item.title || '';
    $('manualText').value = item.text || '';
    if ($('manualSourceLang')) $('manualSourceLang').value = item.sourceLang || currentEvent?.sourceLang || 'ro';
    switchTab('manual');
    setStatus('Pinned text loaded into editor.');
    return;
  }
  if (action === 'send') {
    if ($('manualTitle')) $('manualTitle').value = item.title || '';
    $('manualText').value = item.text || '';
    if ($('manualSourceLang')) $('manualSourceLang').value = item.sourceLang || currentEvent?.sourceLang || 'ro';
    await sendManualText('manual');
    return;
  }
  if (action === 'delete') {
    if (!confirm('Delete this pinned text from library?')) return;
    try {
      const res = await fetch(`/api/pinned-text-library/${itemId}`, globalJsonOptions('DELETE'));
      const data = await res.json();
      if (!data.ok) {
        alert(data.error || 'Could not delete pinned text.');
        return;
      }
      currentPinnedTextLibrary = data.pinnedTextLibrary || [];
      renderPinnedTextLibrary(currentPinnedTextLibrary);
      setStatus('Deleted from pinned text library.');
    } catch (err) {
      console.error(err);
      alert('Could not delete pinned text.');
    }
  }
});
$('remoteOperatorsList')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-remote-operator-action]');
  if (!btn) return;
  const operatorId = btn.getAttribute('data-remote-operator-id');
  const action = btn.getAttribute('data-remote-operator-action');
  const operator = (currentEvent?.remoteOperators || []).find((item) => item.id === operatorId);
  if (!operator) return;
  if (action === 'copy') {
    await copyTextQuick(operator.remoteLink || '', btn);
    return;
  }
  if (action === 'open') {
    if (operator.remoteLink) window.open(operator.remoteLink, '_blank');
    return;
  }
  if (action === 'email') {
    const recipient = window.prompt('Email address for this remote link:');
    if (!recipient) return;
    const subject = encodeURIComponent(`Sanctuary Voice remote access for ${currentEvent?.name || 'event'}`);
    const body = encodeURIComponent(`Hello,\n\nUse this Sanctuary Voice remote link:\n${operator.remoteLink || ''}\n\nOperator: ${operator.name || 'Operator'}\nProfile: ${remoteProfileLabels[operator.profile] || 'Main Screen only'}\n\n`);
    window.location.href = `mailto:${encodeURIComponent(recipient)}?subject=${subject}&body=${body}`;
    setStatus(`Prepared email for ${operator.name || 'operator'}.`);
    return;
  }
  if (action === 'delete') {
    if (!confirm(`Delete operator "${operator.name || 'Operator'}"?`)) return;
    try {
      const res = await fetch(`/api/events/${currentEvent.id}/remote-operators/${operatorId}`, adminJsonOptions('DELETE'));
      const data = await res.json();
      if (!data.ok) return alert(data.error || 'Could not delete operator.');
      currentEvent.remoteOperators = data.remoteOperators || [];
      renderRemoteOperators(currentEvent.remoteOperators);
      setStatus('Remote operator deleted.');
    } catch (err) {
      console.error(err);
      alert('Could not delete operator.');
    }
  }
});
async function logoutAdminSession() {
  try {
    await fetch('/api/admin-logout', { method: 'POST' });
  } catch (err) {
    console.error(err);
  } finally {
    window.location.href = '/admin-login';
  }
}

$('adminLogoutBtn')?.addEventListener('click', logoutAdminSession);
$('openTranslateScreenBtn').addEventListener('click', () => { const url = $('translateLink').value || '/translate'; if (url) window.open(url, '_blank'); });
$('eventList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const id = btn.getAttribute('data-id');
  const action = btn.getAttribute('data-action');
  if (action === 'copy-id') {
    await copyTextQuick(id, btn);
    return;
  }
  if (action === 'visibility') {
    btn.disabled = true;
    try {
      const adminCode = currentEvent?.id === id ? currentEvent.adminCode : (getStoredAdminCode(id) || '');
      const res = await fetch(`/api/events/${id}/visibility`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: adminCode })
      });
      const data = await res.json();
      if (!data.ok) { alert(data.error || 'Could not change visibility.'); return; }
      await refreshEventList();
    } catch (err) {
      console.error(err);
      alert('Could not change visibility.');
    } finally {
      btn.disabled = false;
    }
    return;
  }
  if (action === 'open') return openEventById(id);
  if (action === 'activate') {
    const adminCode = currentEvent?.id === id ? currentEvent.adminCode : (prompt('Enter admin code or PIN for this event to activate it:') || '').trim();
    if (!adminCode) return;
    const res = await fetch(`/api/events/${id}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: adminCode })
    });
    const data = await res.json();
    if (data.ok) { if (currentEvent && currentEvent.id === id) currentEvent = data.event; await refreshEventList(); renderActiveEventBadge(currentEvent); }
    return;
  }
  if (action === 'delete') {
    if (!confirm('Delete this event permanently?')) return;
    const adminCode = currentEvent?.id === id ? currentEvent.adminCode : (prompt('Enter admin code or PIN for this event to delete it:') || '').trim();
    if (!adminCode) return;
    const res = await fetch(`/api/events/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: adminCode })
    });
    const data = await res.json();
    if (data.ok) {
      if (currentEvent?.id === id) {
        currentEvent = null;
        setHideableTextCode('adminCode', '-');
        if ($('participantLink')) $('participantLink').value = '';
        if ($('translateLink')) $('translateLink').value = '';
        setHideableTextCode('screenOperatorCode', '-');
        setHideableTextCode('accessScreenOperatorCode', '-');
        if ($('remoteControlLink')) $('remoteControlLink').value = '';
        if ($('accessRemoteControlLink')) $('accessRemoteControlLink').value = '';
        if ($('qrImage')) $('qrImage').src = '';
        $('transcriptList').innerHTML = ''; renderActiveEventBadge(null); resetParticipantStats();
        renderSongState({});
        refreshDisplayControls();
      }
      await refreshEventList();
    }
  }
});
document.addEventListener('visibilitychange', async () => { if (document.visibilityState === 'visible' && window.isRecognitionRunning && !screenWakeLock) await enableScreenWakeLock(); });
window.addEventListener('beforeunload', async () => { await disableScreenWakeLock(); });

window.addEventListener('load', async () => {
  const now = new Date();
  $('eventDate').value = now.toISOString().slice(0, 10);
  $('eventTime').value = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  populateTimezoneSelect();
  bindScheduledPreviewListeners();
  formatScheduledPreview();
  hydratePermanentParticipantAccess();
  hydrateAudioProcessingSettings();
  try { await navigator.mediaDevices.getUserMedia(getAudioConstraints()); } catch (_) {}
  const langRes = await fetch('/api/languages');
  const langData = await langRes.json();
  availableLanguages = langData.languages || {};
  fillLanguageSelectors();
  await loadAudioInputs();
  updateGlossaryMode();
  updateInputGain();
  updateMonitorGain();
  setOnAirState(false);
  resetParticipantStats();
  await loadPinnedTextLibrary();
  await loadGlobalSongLibrary();
  await refreshEventList();
  await refreshAccessRequests();
  initCodeMasking();
  initAdminPush().catch(() => {});
  try {
    const res = await fetch('/api/events/active');
    const data = await res.json();
    if (data.ok && data.event) await openEventById(data.event.id);
  } catch (_) {}
});

// ---------- Operator access requests ----------

function escHtml(s) { return escapeHtml(s); }

function formatAccessRequestTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}

let accessProfileOptions = [
  { key: 'main_screen', label: 'Main Screen only' },
  { key: 'song_only', label: 'Song only' },
  { key: 'main_and_song', label: 'Main Screen + Song' },
  { key: 'full', label: 'Full operator' }
];
let accessEventOptions = [];

async function refreshAccessRequests() {
  try {
    const res = await fetch('/api/admin/access-requests');
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok) return;
    if (Array.isArray(data.profiles) && data.profiles.length) accessProfileOptions = data.profiles;
    accessEventOptions = Array.isArray(data.events) ? data.events.filter((e) => e.status !== 'past') : [];
    renderAccessRequests(Array.isArray(data.requests) ? data.requests : []);
  } catch (err) {
    console.error('access requests load:', err);
  }
}

function profileLabel(key) {
  const found = accessProfileOptions.find((p) => p.key === key);
  return found ? found.label : key;
}

function profileOptionsHtml(selected) {
  const sel = selected || 'full';
  return accessProfileOptions
    .map((p) => `<option value="${escHtml(p.key)}"${p.key === sel ? ' selected' : ''}>${escHtml(p.label)}</option>`)
    .join('');
}

function eventOptionsHtml(selected) {
  const fallback = '<option value="">No specific event (operator dashboard)</option>';
  const items = accessEventOptions
    .map((ev) => {
      const tag = ev.status === 'active' ? ' · LIVE' : (ev.status === 'scheduled' ? ' · scheduled' : '');
      return `<option value="${escHtml(ev.id)}"${ev.id === selected ? ' selected' : ''}>${escHtml(ev.name + tag)}</option>`;
    })
    .join('');
  return fallback + items;
}

function renderAccessRequests(requests) {
  const list = document.getElementById('accessRequestsList');
  const granted = document.getElementById('accessGrantedList');
  if (!list || !granted) return;
  const pending = requests.filter((r) => r.status === 'pending');
  const processed = requests.filter((r) => r.status !== 'pending').slice(0, 12);
  if (!pending.length) {
    list.innerHTML = '<div class="muted">No pending requests.</div>';
  } else {
    list.innerHTML = pending.map((r) => `
      <div class="access-request-card" data-request-id="${r.id}">
        <div class="access-request-head">
          <strong>${escHtml(r.name || 'Unknown')}</strong>
          <span class="muted">${escHtml(formatAccessRequestTime(r.requestedAt))}</span>
        </div>
        ${r.contact ? `<div class="muted">${escHtml(r.contact)}</div>` : ''}
        <div class="access-request-role">
          <label class="muted" for="accessProfile-${escHtml(r.id)}">Role</label>
          <select id="accessProfile-${escHtml(r.id)}" class="access-profile-select" data-request-id="${r.id}">
            ${profileOptionsHtml('full')}
          </select>
        </div>
        <div class="access-request-role">
          <label class="muted" for="accessEvent-${escHtml(r.id)}">Event</label>
          <select id="accessEvent-${escHtml(r.id)}" class="access-profile-select" data-request-id="${r.id}">
            ${eventOptionsHtml('')}
          </select>
        </div>
        <div class="button-row compact">
          <button class="btn btn-primary" data-access-action="grant" data-request-id="${r.id}">Grant access</button>
          <button class="btn btn-dark" data-access-action="deny" data-request-id="${r.id}">Deny</button>
        </div>
      </div>
    `).join('');
  }
  if (!processed.length) {
    granted.innerHTML = '';
  } else {
    granted.innerHTML = `<div class="label">Recent decisions</div>` + processed.map((r) => `
      <div class="access-request-card processed" data-request-id="${r.id}">
        <div class="access-request-head">
          <strong>${escHtml(r.name || 'Unknown')}</strong>
          <span class="status-pill ${r.status === 'granted' ? 'active' : ''}">${r.status === 'granted' ? 'Granted' : 'Denied'}</span>
        </div>
        ${r.status === 'granted' && r.profile ? `<div class="muted">Role: ${escHtml(profileLabel(r.profile))}</div>` : ''}
        ${r.status === 'granted' && r.eventName ? `<div class="muted">Event: ${escHtml(r.eventName)}</div>` : ''}
        ${r.status === 'granted' && r.operatorCode ? `<div class="meta-row"><span>Code</span><span class="hideable-code-wrap"><code class="event-id-value hideable-code is-code-hidden" data-code-value="${escHtml(r.operatorCode)}">${HIDDEN_PLACEHOLDER}</code><button class="code-toggle code-toggle-inline" type="button" aria-label="Show or hide code">👁</button></span><button class="btn btn-dark" data-access-action="copy-code" data-code="${escHtml(r.operatorCode)}" type="button">Copy</button></div>` : ''}
        <div class="muted">${escHtml(formatAccessRequestTime(r.grantedAt || r.deniedAt || r.requestedAt))}</div>
        <button class="btn btn-danger" data-access-action="dismiss" data-request-id="${r.id}" type="button">Dismiss</button>
      </div>
    `).join('');
  }
}

document.getElementById('refreshAccessRequestsBtn')?.addEventListener('click', refreshAccessRequests);
document.getElementById('accessRequestsPanel')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-access-action]');
  if (!btn) return;
  const action = btn.getAttribute('data-access-action');
  const id = btn.getAttribute('data-request-id');
  if (action === 'copy-code') {
    await copyTextQuick(btn.getAttribute('data-code') || '', btn);
    return;
  }
  if (action === 'grant') {
    btn.disabled = true;
    const profileSelect = document.getElementById(`accessProfile-${id}`);
    const eventSelect = document.getElementById(`accessEvent-${id}`);
    const profile = profileSelect ? profileSelect.value : 'full';
    const eventId = eventSelect ? eventSelect.value : '';
    try {
      const res = await fetch(`/api/admin/access-requests/${id}/grant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile, eventId })
      });
      const data = await res.json();
      if (!data.ok) { alert(data.error || 'Could not grant access.'); return; }
      const code = data.code || '';
      if (code) {
        const eventInfo = data.eventName ? ` for "${data.eventName}"` : '';
        prompt(`Operator code (${profileLabel(data.profile || profile)})${eventInfo}. The operator is signed in automatically — share this only as a backup:`, code);
      }
      await refreshAccessRequests();
    } catch (err) {
      console.error(err);
      alert('Could not grant access.');
    } finally {
      btn.disabled = false;
    }
    return;
  }
  if (action === 'deny') {
    if (!confirm('Deny this request?')) return;
    try {
      const res = await fetch(`/api/admin/access-requests/${id}/deny`, { method: 'POST' });
      const data = await res.json();
      if (!data.ok) { alert(data.error || 'Could not deny.'); return; }
      await refreshAccessRequests();
    } catch (err) { console.error(err); }
    return;
  }
  if (action === 'dismiss') {
    try {
      await fetch(`/api/admin/access-requests/${id}`, { method: 'DELETE' });
      await refreshAccessRequests();
    } catch (err) { console.error(err); }
  }
});

// ---------- Admin push subscription ----------

async function initAdminPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  const btn = document.getElementById('enableAdminPushBtn');
  try {
    const keyRes = await fetch('/api/push/public-key');
    const keyData = await keyRes.json();
    if (!keyData.enabled || !keyData.publicKey) return;
    const reg = await navigator.serviceWorker.register('/push-sw.js');
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      await fetch('/api/admin/push-subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub })
      });
      if (btn) btn.hidden = true;
      return;
    }
    if (Notification.permission === 'granted') {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8ArrayLocal(keyData.publicKey)
      });
      await fetch('/api/admin/push-subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub })
      });
      if (btn) btn.hidden = true;
      return;
    }
    if (btn) {
      btn.hidden = false;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') { btn.disabled = false; return; }
        const newSub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8ArrayLocal(keyData.publicKey)
        });
        await fetch('/api/admin/push-subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription: newSub })
        });
        btn.hidden = true;
      }, { once: true });
    }
  } catch (err) {
    console.warn('admin push init failed:', err);
  }
}

function urlBase64ToUint8ArrayLocal(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

try {
  socket.on('access_request_created', () => { refreshAccessRequests(); });
} catch (_) {}

// ---------- Code masking ----------

const HIDDEN_PLACEHOLDER = '••••••••';

function renderCodeText(el) {
  if (!el) return;
  const real = el.dataset.codeValue || '-';
  el.textContent = el.classList.contains('is-code-hidden') ? (real === '-' ? '-' : HIDDEN_PLACEHOLDER) : real;
}

function setHideableTextCode(elementId, value) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.dataset.codeValue = String(value || '-');
  if (!el.classList.contains('hideable-code')) el.classList.add('hideable-code', 'is-code-hidden');
  renderCodeText(el);
}

function ensureCodeToggle(el) {
  if (!el || el.dataset.codeToggleInit === '1') return;
  el.dataset.codeToggleInit = '1';
  if (!el.classList.contains('hideable-code')) el.classList.add('hideable-code', 'is-code-hidden');
  if (!el.dataset.codeValue) el.dataset.codeValue = el.textContent || '-';
  renderCodeText(el);
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'code-toggle';
  toggle.title = 'Show / hide code';
  toggle.setAttribute('aria-label', 'Show or hide code');
  toggle.textContent = el.classList.contains('is-code-hidden') ? '👁' : '🙈';
  el.insertAdjacentElement('afterend', toggle);
  toggle.addEventListener('click', () => {
    el.classList.toggle('is-code-hidden');
    renderCodeText(el);
    toggle.textContent = el.classList.contains('is-code-hidden') ? '👁' : '🙈';
  });
}

function ensureInputCodeToggle(inputId) {
  const input = document.getElementById(inputId);
  if (!input || input.dataset.codeToggleInit === '1') return;
  input.dataset.codeToggleInit = '1';
  input.type = 'password';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'btn btn-dark code-toggle code-toggle-input';
  toggle.title = 'Show / hide value';
  toggle.setAttribute('aria-label', 'Show or hide value');
  toggle.textContent = '👁';
  input.insertAdjacentElement('afterend', toggle);
  toggle.addEventListener('click', () => {
    input.type = input.type === 'password' ? 'text' : 'password';
    toggle.textContent = input.type === 'password' ? '👁' : '🙈';
  });
}

function initCodeMasking() {
  ['adminCode', 'screenOperatorCode', 'accessScreenOperatorCode'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) ensureCodeToggle(el);
  });
  ['accessRemoteControlLink', 'remoteControlLink'].forEach(ensureInputCodeToggle);
}

// Delegated handler for dynamically rendered toggles (.code-toggle-inline within history-item)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button.code-toggle-inline');
  if (!btn) return;
  const wrap = btn.closest('.hideable-code-wrap');
  if (!wrap) return;
  const target = wrap.querySelector('.hideable-code');
  if (!target) return;
  target.classList.toggle('is-code-hidden');
  renderCodeText(target);
  btn.textContent = target.classList.contains('is-code-hidden') ? '👁' : '🙈';
});

// ---------- Self-test panel ----------

async function runSelfTest() {
  const btn = document.getElementById('runSelfTestBtn');
  const results = document.getElementById('selfTestResults');
  const summary = document.getElementById('selfTestSummary');
  if (!btn || !results) return;
  btn.disabled = true;
  btn.textContent = 'Running…';
  results.innerHTML = '<div class="muted">Running checks…</div>';
  if (summary) summary.textContent = '';
  try {
    const res = await fetch('/api/admin/self-test');
    if (res.status === 401) {
      results.innerHTML = '<div class="muted">Admin session expired.</div>';
      return;
    }
    const data = await res.json();
    if (!data.ok) {
      results.innerHTML = `<div class="muted">${escapeHtml(data.error || 'Self-test failed.')}</div>`;
      return;
    }
    renderSelfTestResults(data);
  } catch (err) {
    console.error(err);
    results.innerHTML = '<div class="muted">Connection error. Try again.</div>';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run self-test';
  }
}

function renderSelfTestResults(data) {
  const results = document.getElementById('selfTestResults');
  const summary = document.getElementById('selfTestSummary');
  if (!results) return;
  const checks = Array.isArray(data.checks) ? data.checks : [];
  if (!checks.length) {
    results.innerHTML = '<div class="muted">No checks returned.</div>';
    return;
  }
  results.innerHTML = checks.map((c) => `
    <div class="self-test-row" data-status="${escapeHtml(c.status || 'warn')}">
      <span class="self-test-dot"></span>
      <strong class="self-test-name">${escapeHtml(c.name || 'Check')}</strong>
      <span class="self-test-msg">${escapeHtml(c.message || '')}</span>
    </div>
  `).join('');
  if (summary) {
    const s = data.summary || {};
    const ranAt = data.ranAt ? new Date(data.ranAt).toLocaleTimeString() : '';
    summary.textContent = `${s.ok || 0} ok · ${s.warn || 0} warn · ${s.fail || 0} fail · ${ranAt}`;
  }
}

document.getElementById('runSelfTestBtn')?.addEventListener('click', runSelfTest);
