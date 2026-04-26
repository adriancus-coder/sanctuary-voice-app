const socket = io();
const $ = (id) => document.getElementById(id);
let availableLanguages = {};
let mainScreenWakeLock = null;

const params = new URLSearchParams(window.location.search);
const state = {
  fixedEventId: params.get('event') || '',
  currentEvent: null,
  currentLanguage: params.get('lang') || 'no',
  secondaryLanguage: '',
  currentDisplayMode: 'auto',
  currentTheme: 'dark',
  backgroundPreset: 'none',
  customBackground: '',
  showClock: false,
  clockPosition: 'top-right',
  clockScale: 1,
  textSize: 'large',
  textScale: 1,
  screenStyle: 'focus',
  displayResolution: 'auto',
  blackScreen: false,
  manualTranslations: {},
  manualSourceLang: 'ro',
  latestLiveEntry: null,
  songState: null,
  renderTimer: null
};

function langLabel(code) {
  return availableLanguages[code] || code.toUpperCase();
}

function setStatus(text) {
  const el = $('translateStatus');
  if (el) el.textContent = text;
}

async function enableMainScreenWakeLock() {
  try {
    if (!('wakeLock' in navigator)) return;
    if (document.visibilityState !== 'visible') return;
    if (mainScreenWakeLock) return;
    mainScreenWakeLock = await navigator.wakeLock.request('screen');
    mainScreenWakeLock.addEventListener('release', () => {
      mainScreenWakeLock = null;
    });
  } catch (_) {}
}

async function disableMainScreenWakeLock() {
  try {
    if (!mainScreenWakeLock) return;
    await mainScreenWakeLock.release();
    mainScreenWakeLock = null;
  } catch (_) {}
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
  const available = Array.from(new Set([
    ...(event?.targetLangs || []),
    (event?.displayState?.mode === 'song' ? (event?.songState?.sourceLang || '') : ''),
    (event?.displayState?.mode === 'manual' ? (event?.displayState?.manualSourceLang || '') : '')
  ].filter(Boolean)));
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
    if (state.blackScreen) {
      wrap.style.backgroundImage = 'none';
      wrap.style.backgroundColor = '#000';
      wrap.dataset.textSize = state.textSize || 'large';
      wrap.dataset.screenStyle = state.screenStyle || 'focus';
      wrap.dataset.resolution = state.displayResolution || 'auto';
      if (clock) clock.style.display = 'none';
      return;
    }
    if (state.currentTheme === 'dark') {
      wrap.style.backgroundImage = 'none';
      wrap.style.backgroundSize = '';
      wrap.style.backgroundPosition = '';
      wrap.style.backgroundColor = '#000';
      wrap.dataset.textSize = state.textSize || 'large';
      wrap.dataset.screenStyle = state.screenStyle || 'focus';
    } else
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
    wrap.dataset.resolution = state.displayResolution || 'auto';
  }
  if (clock) {
    clock.style.display = state.showClock ? 'block' : 'none';
    clock.className = `display-clock clock-${state.clockPosition || 'top-right'}`;
    clock.style.setProperty('--clock-scale', String(state.clockScale || 1));
  }
}

function updateClock() {
  const clock = $('displayClock');
  if (!clock) return;
  const now = new Date();
  clock.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getDisplayLanguages() {
  if (state.blackScreen) return [];
  const secondaryLanguage = state.secondaryLanguage && state.secondaryLanguage !== state.currentLanguage
    ? state.secondaryLanguage
    : '';
  return secondaryLanguage ? [state.currentLanguage, secondaryLanguage] : [state.currentLanguage];
}

function getTextToDisplay(language = state.currentLanguage) {
  if (state.blackScreen) {
    return '';
  }
  if (state.currentDisplayMode === 'song' && state.songState) {
    const sourceLang = state.songState?.sourceLang || state.currentEvent?.sourceLang || 'ro';
    if (language === sourceLang) {
      return state.songState.activeBlock
        || 'Waiting for song text...';
    }
    return state.songState.translations?.[language]
      || state.songState.activeBlock
      || 'Waiting for song translation...';
  }
  if (state.currentDisplayMode === 'manual') {
    if (language === (state.manualSourceLang || state.currentEvent?.sourceLang || 'ro')) {
      return state.currentEvent?.displayState?.manualSource || '';
    }
    return state.manualTranslations?.[language] || state.currentEvent?.displayState?.manualSource || '';
  }
  if (state.latestLiveEntry) {
    return state.latestLiveEntry.translations?.[language]
      || state.latestLiveEntry.original
      || 'Waiting for translation...';
  }
  return 'Waiting for translation...';
}

function updateMeta() {
  const modeLabels = {
    auto: 'Auto',
    manual: 'Pinned text',
    song: 'Song'
  };
  $('translateModeBadge').textContent = state.blackScreen ? 'Black screen' : (modeLabels[state.currentDisplayMode] || 'Auto');
  $('translateLanguageLabel').textContent = getDisplayLanguages().map(langLabel).join(' + ') || langLabel(state.currentLanguage);
  $('translateEventName').textContent = state.currentEvent?.name || 'Sanctuary Voice Main Screen';
  $('translateScreenLabel').textContent = state.blackScreen
    ? ''
    : (state.currentDisplayMode === 'song' ? 'Song' : state.currentDisplayMode === 'manual' ? 'Pinned text' : 'Live translation');
}

function fitDisplayTextElement(box, container, options = {}) {
  if (!box || !container) return;
  const containerStyle = window.getComputedStyle(container);
  const paddingX = (parseFloat(containerStyle.paddingLeft) || 0) + (parseFloat(containerStyle.paddingRight) || 0);
  const paddingY = (parseFloat(containerStyle.paddingTop) || 0) + (parseFloat(containerStyle.paddingBottom) || 0);
  const availableWidth = Math.max(container.clientWidth - paddingX - 28, 180);
  const availableHeight = Math.max(container.clientHeight - paddingY - (options.reserveHeight || 0) - 20, 120);
  box.style.fontSize = '';
  box.style.lineHeight = '';
  box.style.maxWidth = `${availableWidth}px`;
  box.style.maxHeight = `${availableHeight}px`;
  box.style.transform = '';
  box.style.transformOrigin = 'center center';
  let size = Math.min(Math.max(Math.floor(availableWidth / (options.dense ? 12.6 : 10.6)), 24), options.maxSize || 118);
  const sizeMode = state.textSize || 'large';
  if (sizeMode === 'compact') size = Math.round(size * 0.82);
  if (sizeMode === 'xlarge') size = Math.round(size * 1.08);
  const manualScale = Math.min(1.4, Math.max(0.65, Number(state.textScale || 1)));
  const maxSize = Math.round((options.maxSize || 118) * 1.4);
  size = Math.round(size * manualScale);
  size = Math.min(Math.max(size, 18), maxSize);
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

function autoFitText() {
  const dual = $('translateDualText');
  if (dual && !dual.hidden) {
    document.querySelectorAll('.unified-display-language-card').forEach((card) => {
      const languageLabel = card.querySelector('.unified-display-language-label');
      const languageText = card.querySelector('.unified-display-language-text');
      const reserveHeight = languageLabel ? languageLabel.getBoundingClientRect().height + 18 : 0;
      fitDisplayTextElement(languageText, card, { reserveHeight, dense: true, maxSize: 82 });
    });
    return;
  }

  const box = $('translateText');
  const wrap = $('translateTextWrap');
  const label = $('translateScreenLabel');
  const clock = $('displayClock');
  const labelHeight = label && !label.hidden ? label.getBoundingClientRect().height + 18 : 0;
  const clockReserve = clock && clock.style.display !== 'none' ? Math.max(clock.getBoundingClientRect().height + 20, 48) : 0;
  fitDisplayTextElement(box, wrap, { reserveHeight: labelHeight + clockReserve, dense: false, maxSize: 118 });
}

function renderDisplay() {
  const languages = getDisplayLanguages();
  const useDual = languages.length === 2;
  const singleText = $('translateText');
  const dualText = $('translateDualText');
  if (singleText) {
    singleText.hidden = useDual;
    singleText.textContent = getTextToDisplay(languages[0] || state.currentLanguage);
  }
  if (dualText) {
    dualText.hidden = !useDual;
    dualText.dataset.textSize = state.textSize || 'large';
    dualText.dataset.screenStyle = state.screenStyle || 'focus';
    if ($('translatePrimaryLanguageLabel')) $('translatePrimaryLanguageLabel').textContent = langLabel(languages[0] || state.currentLanguage);
    if ($('translatePrimaryText')) $('translatePrimaryText').textContent = getTextToDisplay(languages[0] || state.currentLanguage);
    if ($('translateSecondaryLanguageLabel')) $('translateSecondaryLanguageLabel').textContent = langLabel(languages[1] || '');
    if ($('translateSecondaryText')) $('translateSecondaryText').textContent = getTextToDisplay(languages[1] || state.currentLanguage);
  }
  if ($('translateText')) {
    $('translateText').dataset.textSize = state.textSize || 'large';
    $('translateText').dataset.screenStyle = state.screenStyle || 'focus';
  }
  updateMeta();
  applyDisplayTheme(state.currentTheme);
  applyDisplaySettings();
  updateClock();
  requestAnimationFrame(autoFitText);
}

function scheduleDisplayRender(delay = 70) {
  if (state.renderTimer) clearTimeout(state.renderTimer);
  state.renderTimer = window.setTimeout(() => {
    state.renderTimer = null;
    renderDisplay();
  }, delay);
}

async function enterFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    await document.documentElement.requestFullscreen();
    await enableMainScreenWakeLock();
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
  await enableMainScreenWakeLock();
  await joinEvent();
});

socket.on('disconnect', () => setStatus('Reconnecting...'));

socket.on('joined_event', ({ event, languageNames }) => {
  if (languageNames) availableLanguages = languageNames;
  state.currentEvent = event;
  state.currentDisplayMode = event.displayState?.mode || 'auto';
  state.currentTheme = event.displayState?.theme || 'dark';
  state.currentLanguage = event.displayState?.language || state.currentLanguage;
  state.secondaryLanguage = event.displayState?.secondaryLanguage || '';
  state.blackScreen = !!event.displayState?.blackScreen;
  state.backgroundPreset = event.displayState?.backgroundPreset || 'none';
  state.customBackground = event.displayState?.customBackground || '';
  state.showClock = !!event.displayState?.showClock;
  state.clockPosition = event.displayState?.clockPosition || 'top-right';
  state.clockScale = event.displayState?.clockScale || 1;
  state.textSize = event.displayState?.textSize || 'large';
  state.textScale = event.displayState?.textScale || 1;
  state.screenStyle = event.displayState?.screenStyle || 'focus';
  state.displayResolution = event.displayState?.displayResolution || 'auto';
  state.manualSourceLang = event.displayState?.manualSourceLang || event.sourceLang || 'ro';
  state.manualTranslations = event.displayState?.manualTranslations || {};
  state.songState = event.songState || null;
  state.latestLiveEntry = event.latestDisplayEntry || null;
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
  syncLanguageOptions({ ...state.currentEvent, displayState: { ...(state.currentEvent?.displayState || {}), mode: 'song' }, songState });
  scheduleDisplayRender(30);
});

socket.on('song_clear', () => {
  state.songState = null;
  state.latestLiveEntry = null;
  if (state.currentEvent) {
    state.currentEvent.mode = 'live';
    state.currentEvent.latestDisplayEntry = null;
  }
  syncLanguageOptions({ ...state.currentEvent, displayState: { ...(state.currentEvent?.displayState || {}), mode: state.currentDisplayMode } });
  renderDisplay();
});

socket.on('display_live_entry', (entry) => {
  if (state.currentDisplayMode !== 'auto') return;
  if (state.currentEvent) state.currentEvent.latestDisplayEntry = entry;
  state.latestLiveEntry = entry;
  scheduleDisplayRender(45);
});
socket.on('display_mode_changed', ({ mode, blackScreen, theme, language, secondaryLanguage, backgroundPreset, customBackground, showClock, clockPosition, clockScale, textSize, textScale, screenStyle, displayResolution, manualTranslations, manualSourceLang }) => {
  if (state.currentEvent) {
    state.currentEvent.displayState = {
      ...(state.currentEvent.displayState || {}),
      mode: mode || 'auto',
      blackScreen: !!blackScreen,
      theme: theme || state.currentTheme || 'dark',
      language: language || state.currentLanguage,
      secondaryLanguage: secondaryLanguage || '',
      backgroundPreset: backgroundPreset || state.backgroundPreset || 'none',
      customBackground: typeof customBackground === 'string' ? customBackground : state.customBackground,
      showClock: typeof showClock === 'boolean' ? showClock : state.showClock,
      clockPosition: clockPosition || state.clockPosition,
      clockScale: clockScale || state.clockScale,
      textSize: textSize || state.textSize || 'large',
      textScale: textScale || state.textScale || 1,
      screenStyle: screenStyle || state.screenStyle || 'focus',
      displayResolution: displayResolution || state.displayResolution || 'auto',
      manualSourceLang: manualSourceLang || state.manualSourceLang || state.currentEvent?.sourceLang || 'ro'
    };
  }
  state.currentDisplayMode = mode || 'auto';
  state.blackScreen = !!blackScreen;
  state.currentTheme = theme || state.currentTheme || 'dark';
  state.currentLanguage = language || state.currentLanguage;
  state.secondaryLanguage = secondaryLanguage || '';
  state.backgroundPreset = backgroundPreset || state.backgroundPreset || 'none';
  state.customBackground = typeof customBackground === 'string' ? customBackground : state.customBackground;
  state.showClock = typeof showClock === 'boolean' ? showClock : state.showClock;
  state.clockPosition = clockPosition || state.clockPosition;
  state.clockScale = clockScale || state.clockScale;
  state.textSize = textSize || state.textSize || 'large';
  state.textScale = textScale || state.textScale || 1;
  state.screenStyle = screenStyle || state.screenStyle || 'focus';
  state.displayResolution = displayResolution || state.displayResolution || 'auto';
  state.manualSourceLang = manualSourceLang || state.manualSourceLang || state.currentEvent?.sourceLang || 'ro';
  state.manualTranslations = manualTranslations || state.manualTranslations || {};
  syncLanguageOptions({ ...state.currentEvent, displayState: { ...(state.currentEvent?.displayState || {}), mode: state.currentDisplayMode, manualSourceLang: state.manualSourceLang }, songState: state.songState });
  if ($('translateLanguage')) $('translateLanguage').value = state.currentLanguage;
  renderDisplay();
});

socket.on('display_theme_changed', ({ theme }) => {
  state.currentTheme = theme || 'dark';
  renderDisplay();
});

socket.on('display_manual_update', ({ mode, blackScreen, theme, language, secondaryLanguage, backgroundPreset, customBackground, showClock, clockPosition, clockScale, textSize, textScale, screenStyle, displayResolution, manualTranslations, manualSourceLang, manualSource }) => {
  state.currentDisplayMode = mode || 'manual';
  state.blackScreen = !!blackScreen;
  state.currentTheme = theme || state.currentTheme || 'dark';
  state.currentLanguage = language || state.currentLanguage;
  state.secondaryLanguage = secondaryLanguage || '';
  state.backgroundPreset = backgroundPreset || state.backgroundPreset || 'none';
  state.customBackground = typeof customBackground === 'string' ? customBackground : state.customBackground;
  state.showClock = typeof showClock === 'boolean' ? showClock : state.showClock;
  state.clockPosition = clockPosition || state.clockPosition;
  state.clockScale = clockScale || state.clockScale;
  state.textSize = textSize || state.textSize || 'large';
  state.textScale = textScale || state.textScale || 1;
  state.screenStyle = screenStyle || state.screenStyle || 'focus';
  state.displayResolution = displayResolution || state.displayResolution || 'auto';
  state.manualSourceLang = manualSourceLang || state.manualSourceLang || state.currentEvent?.sourceLang || 'ro';
  state.manualTranslations = manualTranslations || {};
  if (state.currentEvent) {
    state.currentEvent.displayState = state.currentEvent.displayState || {};
    state.currentEvent.displayState.mode = state.currentDisplayMode;
    state.currentEvent.displayState.language = state.currentLanguage;
    state.currentEvent.displayState.secondaryLanguage = state.secondaryLanguage;
    state.currentEvent.displayState.clockScale = state.clockScale;
    state.currentEvent.displayState.textScale = state.textScale;
    state.currentEvent.displayState.displayResolution = state.displayResolution;
    state.currentEvent.displayState.manualSource = manualSource || state.currentEvent.displayState.manualSource || '';
    state.currentEvent.displayState.manualSourceLang = state.manualSourceLang;
  }
  syncLanguageOptions({ ...state.currentEvent, displayState: { ...(state.currentEvent?.displayState || {}), mode: state.currentDisplayMode, manualSourceLang: state.manualSourceLang }, songState: state.songState });
  renderDisplay();
});

socket.on('active_event_changed', async () => {
  if (!state.fixedEventId) await joinEvent();
});

$('translateLanguage')?.addEventListener('change', handleLanguageChange);
$('fullscreenBtn')?.addEventListener('click', enterFullscreen);
window.addEventListener('resize', autoFitText);
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    await enableMainScreenWakeLock();
  }
});
document.addEventListener('fullscreenchange', () => {
  document.body.classList.toggle('display-fullscreen', !!document.fullscreenElement);
  applyDisplaySettings();
  autoFitText();
  enableMainScreenWakeLock();
});
window.addEventListener('beforeunload', () => {
  disableMainScreenWakeLock();
});

window.addEventListener('load', async () => {
  await enableMainScreenWakeLock();
  try {
    const res = await fetch('/api/languages');
    const data = await res.json();
    availableLanguages = data.languages || {};
  } catch (_) {}
  updateClock();
  window.setInterval(updateClock, 1000);
});
