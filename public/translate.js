const socket = io();
const $ = (id) => document.getElementById(id);
let availableLanguages = {};

const params = new URLSearchParams(window.location.search);
const state = {
  fixedEventId: params.get('event') || '',
  currentEvent: null,
  currentLanguage: params.get('lang') || 'no',
  currentDisplayMode: 'auto',
  currentTheme: 'dark',
  backgroundPreset: 'none',
  customBackground: '',
  showClock: false,
  clockPosition: 'top-right',
  textSize: 'large',
  screenStyle: 'focus',
  manualTranslations: {},
  latestLiveEntry: null,
  songState: null
};

function langLabel(code) {
  return availableLanguages[code] || code.toUpperCase();
}

function setStatus(text) {
  const el = $('translateStatus');
  if (el) el.textContent = text;
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
  const select = $('translateLanguage');
  if (!select) return;
  const available = Array.from(new Set(event?.targetLangs || []));
  select.innerHTML = available
    .map((code) => `<option value="${code}">${langLabel(code)}</option>`)
    .join('');
  if (!available.includes(state.currentLanguage)) {
    state.currentLanguage = detectPreferredSupportedLanguage(available);
  }
  select.value = state.currentLanguage;
}

function applyDisplayTheme(theme) {
  document.body.classList.remove('display-theme-dark', 'display-theme-light');
  document.body.classList.add(theme === 'light' ? 'display-theme-light' : 'display-theme-dark');
}

function getPresetBackground(preset, theme) {
  const overlays = {
    light: 'linear-gradient(rgba(255, 255, 255, 0.38), rgba(255, 255, 255, 0.38))',
    dark: 'linear-gradient(rgba(8, 12, 20, 0.34), rgba(8, 12, 20, 0.34))'
  };
  const overlay = theme === 'light' ? overlays.light : overlays.dark;
  if (preset === 'warm') {
    return `${overlay}, radial-gradient(circle at top, rgba(200, 138, 43, 0.30), transparent 32%), radial-gradient(circle at bottom, rgba(15, 118, 110, 0.18), transparent 38%), linear-gradient(180deg, #241b14, #080b12)`;
  }
  if (preset === 'sanctuary') {
    return `${overlay}, radial-gradient(circle at 20% 20%, rgba(255, 243, 214, 0.30), transparent 20%), radial-gradient(circle at 80% 24%, rgba(173, 216, 230, 0.14), transparent 18%), linear-gradient(160deg, #1a2230, #05070c 72%)`;
  }
  if (preset === 'soft-light') {
    return `${overlay}, linear-gradient(160deg, #faf3e6, #f2f7f5 48%, #edf1f8 100%)`;
  }
  return '';
}

function applyDisplaySettings() {
  const wrap = $('translateTextWrap');
  const clock = $('displayClock');
  if (wrap) {
    if (state.customBackground) {
      const overlay = state.currentTheme === 'light'
        ? 'linear-gradient(rgba(255, 255, 255, 0.45), rgba(255, 255, 255, 0.45))'
        : 'linear-gradient(rgba(12, 18, 28, 0.45), rgba(12, 18, 28, 0.45))';
      wrap.style.backgroundImage = `${overlay}, url("${state.customBackground.replaceAll('"', '%22')}")`;
      wrap.style.backgroundSize = 'cover';
      wrap.style.backgroundPosition = 'center';
      wrap.style.backgroundColor = '';
    } else {
      wrap.style.backgroundImage = getPresetBackground(state.backgroundPreset, state.currentTheme);
      wrap.style.backgroundSize = 'cover';
      wrap.style.backgroundPosition = 'center';
      wrap.style.backgroundColor = state.currentTheme === 'light' ? '#fffdf8' : '#000';
    }
    wrap.dataset.textSize = state.textSize || 'large';
    wrap.dataset.screenStyle = state.screenStyle || 'focus';
  }
  if (clock) {
    clock.style.display = state.showClock ? 'block' : 'none';
    clock.className = `display-clock clock-${state.clockPosition || 'top-right'}`;
  }
}

function updateClock() {
  const clock = $('displayClock');
  if (!clock) return;
  const now = new Date();
  clock.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getTextToDisplay() {
  if (state.currentEvent?.mode === 'song' && state.songState) {
    return state.songState.translations?.[state.currentLanguage]
      || state.songState.activeBlock
      || 'Waiting for song translation...';
  }
  if (state.currentDisplayMode === 'manual') {
    return state.manualTranslations?.[state.currentLanguage] || '';
  }
  if (state.latestLiveEntry) {
    return state.latestLiveEntry.translations?.[state.currentLanguage]
      || state.latestLiveEntry.original
      || 'Waiting for translation...';
  }
  return 'Waiting for translation...';
}

function updateMeta() {
  const isSongMode = state.currentEvent?.mode === 'song';
  $('translateModeBadge').textContent = isSongMode ? 'Song mode' : (state.currentDisplayMode === 'manual' ? 'Manual' : 'Auto');
  $('translateLanguageLabel').textContent = langLabel(state.currentLanguage);
  $('translateEventName').textContent = state.currentEvent?.name || 'BPMS Main Screen';
  $('translateScreenLabel').textContent = isSongMode ? 'Song mode' : 'Live translation';
}

function autoFitText() {
  const box = $('translateText');
  const wrap = $('translateTextWrap');
  const label = $('translateScreenLabel');
  const clock = $('displayClock');
  if (!box || !wrap) return;

  const wrapStyle = window.getComputedStyle(wrap);
  const paddingX = (parseFloat(wrapStyle.paddingLeft) || 0) + (parseFloat(wrapStyle.paddingRight) || 0);
  const paddingY = (parseFloat(wrapStyle.paddingTop) || 0) + (parseFloat(wrapStyle.paddingBottom) || 0);
  const labelHeight = label && !label.hidden ? label.getBoundingClientRect().height + 18 : 0;
  const clockReserve = clock && clock.style.display !== 'none' ? Math.max(clock.getBoundingClientRect().height + 20, 48) : 0;
  const availableWidth = Math.max(wrap.clientWidth - paddingX - 32, 180);
  const availableHeight = Math.max(wrap.clientHeight - paddingY - labelHeight - clockReserve - 20, 120);

  box.style.fontSize = '';
  box.style.lineHeight = '';
  box.style.maxWidth = `${availableWidth}px`;
  box.style.maxHeight = `${availableHeight}px`;
  box.style.transform = '';
  box.style.transformOrigin = 'center center';
  let size = Math.min(Math.max(Math.floor(availableWidth / 10.6), 24), 118);
  const sizeMode = state.textSize || 'large';
  if (sizeMode === 'compact') size = Math.round(size * 0.82);
  if (sizeMode === 'xlarge') size = Math.round(size * 1.08);
  size = Math.min(Math.max(size, 18), 118);
  box.style.fontSize = `${size}px`;
  box.style.lineHeight = size <= 42 ? '1.04' : size <= 64 ? '1.08' : '1.12';

  while (size > 14 && (box.scrollHeight > availableHeight || box.scrollWidth > availableWidth)) {
    size -= 2;
    box.style.fontSize = `${size}px`;
    box.style.lineHeight = size <= 30 ? '1' : size <= 42 ? '1.04' : size <= 64 ? '1.08' : '1.12';
  }

  if (box.scrollHeight > availableHeight || box.scrollWidth > availableWidth) {
    let compressedLineHeight = 0.98;
    while (compressedLineHeight >= 0.88 && (box.scrollHeight > availableHeight || box.scrollWidth > availableWidth)) {
      box.style.lineHeight = compressedLineHeight.toFixed(2);
      compressedLineHeight -= 0.02;
    }
  }

  const heightRatio = availableHeight / Math.max(box.scrollHeight, 1);
  const widthRatio = availableWidth / Math.max(box.scrollWidth, 1);
  const ratio = Math.min(heightRatio, widthRatio, 1);
  if (ratio < 1) {
    box.style.transform = `scale(${Math.max(ratio, 0.72).toFixed(3)})`;
  }
}

function renderDisplay() {
  $('translateText').textContent = getTextToDisplay();
  $('translateText').dataset.textSize = state.textSize || 'large';
  $('translateText').dataset.screenStyle = state.screenStyle || 'focus';
  updateMeta();
  applyDisplayTheme(state.currentTheme);
  applyDisplaySettings();
  updateClock();
  requestAnimationFrame(autoFitText);
}

async function enterFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    await document.documentElement.requestFullscreen();
  } catch (_) {}
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

async function joinEvent() {
  const eventId = await resolveEventId();
  if (!eventId) {
    setStatus('Nu exista eveniment activ.');
    return;
  }

  socket.emit('join_event', {
    eventId,
    role: 'participant',
    language: state.currentLanguage,
    participantId: `display_${state.currentLanguage}`
  });
}

function handleLanguageChange() {
  renderDisplay();
}

socket.on('connect', async () => {
  setStatus('Connecting...');
  await joinEvent();
});

socket.on('disconnect', () => setStatus('Reconnecting...'));

socket.on('joined_event', ({ event, languageNames }) => {
  if (languageNames) availableLanguages = languageNames;
  state.currentEvent = event;
  state.currentDisplayMode = event.displayState?.mode || 'auto';
  state.currentTheme = event.displayState?.theme || 'dark';
  state.currentLanguage = event.displayState?.language || state.currentLanguage;
  state.backgroundPreset = event.displayState?.backgroundPreset || 'none';
  state.customBackground = event.displayState?.customBackground || '';
  state.showClock = !!event.displayState?.showClock;
  state.clockPosition = event.displayState?.clockPosition || 'top-right';
  state.textSize = event.displayState?.textSize || 'large';
  state.screenStyle = event.displayState?.screenStyle || 'focus';
  state.manualTranslations = event.displayState?.manualTranslations || {};
  state.songState = event.songState || null;
  state.latestLiveEntry = (event.transcripts || [])
    .slice()
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0))
    .pop() || null;
  syncLanguageOptions(event);
  renderDisplay();
  setStatus('Connected.');
});

socket.on('mode_changed', ({ mode }) => {
  if (!state.currentEvent) return;
  state.currentEvent.mode = mode || 'live';
  renderDisplay();
});

socket.on('song_state', (songState) => {
  state.songState = songState;
  if (state.currentEvent) state.currentEvent.mode = 'song';
  renderDisplay();
});

socket.on('song_clear', () => {
  state.songState = null;
  if (state.currentEvent) state.currentEvent.mode = 'live';
  renderDisplay();
});

socket.on('transcript_entry', (entry) => {
  if (state.currentEvent?.mode === 'song' || state.currentDisplayMode !== 'auto') return;
  state.latestLiveEntry = entry;
  renderDisplay();
});

socket.on('display_live_entry', (entry) => {
  if (state.currentEvent?.mode === 'song' || state.currentDisplayMode !== 'auto') return;
  state.latestLiveEntry = entry;
  renderDisplay();
});

socket.on('transcript_source_updated', (payload) => {
  if (state.currentEvent?.mode === 'song' || state.currentDisplayMode !== 'auto') return;
  if (!state.latestLiveEntry || state.latestLiveEntry.id !== payload.entryId) return;
  state.latestLiveEntry = {
    ...state.latestLiveEntry,
    sourceLang: payload.sourceLang,
    original: payload.original,
    translations: payload.translations || {}
  };
  renderDisplay();
});

socket.on('display_mode_changed', ({ mode, theme, language, backgroundPreset, customBackground, showClock, clockPosition, textSize, screenStyle, manualTranslations }) => {
  state.currentDisplayMode = mode || 'auto';
  state.currentTheme = theme || state.currentTheme || 'dark';
  state.currentLanguage = language || state.currentLanguage;
  state.backgroundPreset = backgroundPreset || state.backgroundPreset || 'none';
  state.customBackground = typeof customBackground === 'string' ? customBackground : state.customBackground;
  state.showClock = typeof showClock === 'boolean' ? showClock : state.showClock;
  state.clockPosition = clockPosition || state.clockPosition;
  state.textSize = textSize || state.textSize || 'large';
  state.screenStyle = screenStyle || state.screenStyle || 'focus';
  state.manualTranslations = manualTranslations || state.manualTranslations || {};
  if ($('translateLanguage')) $('translateLanguage').value = state.currentLanguage;
  renderDisplay();
});

socket.on('display_theme_changed', ({ theme }) => {
  state.currentTheme = theme || 'dark';
  renderDisplay();
});

socket.on('display_manual_update', ({ mode, theme, language, backgroundPreset, customBackground, showClock, clockPosition, textSize, screenStyle, manualTranslations }) => {
  state.currentDisplayMode = mode || 'manual';
  state.currentTheme = theme || state.currentTheme || 'dark';
  state.currentLanguage = language || state.currentLanguage;
  state.backgroundPreset = backgroundPreset || state.backgroundPreset || 'none';
  state.customBackground = typeof customBackground === 'string' ? customBackground : state.customBackground;
  state.showClock = typeof showClock === 'boolean' ? showClock : state.showClock;
  state.clockPosition = clockPosition || state.clockPosition;
  state.textSize = textSize || state.textSize || 'large';
  state.screenStyle = screenStyle || state.screenStyle || 'focus';
  state.manualTranslations = manualTranslations || {};
  renderDisplay();
});

socket.on('active_event_changed', async () => {
  if (!state.fixedEventId) await joinEvent();
});

$('translateLanguage')?.addEventListener('change', handleLanguageChange);
$('fullscreenBtn')?.addEventListener('click', enterFullscreen);
window.addEventListener('resize', autoFitText);
document.addEventListener('fullscreenchange', () => {
  document.body.classList.toggle('display-fullscreen', !!document.fullscreenElement);
  applyDisplaySettings();
  autoFitText();
});

window.addEventListener('load', async () => {
  try {
    const res = await fetch('/api/languages');
    const data = await res.json();
    availableLanguages = data.languages || {};
  } catch (_) {}
  updateClock();
  window.setInterval(updateClock, 1000);
});
