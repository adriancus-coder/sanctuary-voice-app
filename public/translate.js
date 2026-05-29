const socket = io();
const $ = (id) => document.getElementById(id);
let availableLanguages = {};
// V11.5: endonyms catalog (each language's name in its own language) — preferred over
// availableLanguages on end-user-facing Main Screen cards. Falls back if server didn't send.
let availableEndonyms = {};
let mainScreenWakeLock = null;

function escapeTextForHtml(text) {
  return String(text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const BIBLE_BOOK_NAMES = '(?:Geneza|Exod|Levitic|Numeri|Deuteronom|Iosua|Judec[ăa]tori|Rut|Samuel|[ÎI]mp[ăa]ra[țt]i|Cronici|Ezra|Neemia|Estera|Iov|Psalmi|Psalmul|Proverbe|Eclesiastul|C[âa]ntarea|Isaia|Ieremia|Pl[âa]ngeri|Ezechiel|Daniel|Osea|Ioel|Amos|Obadia|Iona|Mica|Naum|Habacuc|[ȚT]efania|Hagai|Zaharia|Maleahi|Matei|Marcu|Luca|Ioan|Faptele|Romani|Corinteni|Galateni|Efeseni|Filipeni|Coloseni|Tesaloniceni|Timotei|Tit|Filimon|Evrei|Iacov|Petru|Iuda|Apocalipsa|Genesis|Exodus|Leviticus|Numbers|Deuteronomy|Joshua|Judges|Ruth|Kings|Chronicles|Nehemiah|Esther|Job|Psalms|Psalm|Proverbs|Ecclesiastes|Song|Isaiah|Jeremiah|Lamentations|Ezekiel|Hosea|Joel|Amos|Obadiah|Jonah|Micah|Nahum|Habakkuk|Zephaniah|Haggai|Zechariah|Malachi|Matthew|Mark|Luke|John|Acts|Romans|Corinthians|Galatians|Ephesians|Philippians|Colossians|Thessalonians|Timothy|Titus|Philemon|Hebrews|James|Peter|Jude|Revelation)';
const BIBLE_REF_REGEX = new RegExp(`((?:[12]\\s+)?${BIBLE_BOOK_NAMES}\\s+\\d{1,3}:\\d{1,3}(?:[-–]\\d{1,3})?)`, 'g');

function highlightBibleRefs(text) {
  return escapeTextForHtml(text || '').replace(BIBLE_REF_REGEX, '<span class="bible-ref">$1</span>');
}

const params = new URLSearchParams(window.location.search);
const state = {
  fixedEventId: params.get('event') || '',
  accessCode: params.get('code') || '',
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
  transcriptionPaused: false,
  manualTranslations: {},
  manualSourceLang: 'ro',
  latestLiveEntry: null,
  songState: null,
  renderTimer: null
};

// Securitate: șterg query param-ul `code` din URL după ce am extras codul.
// Rămâne în state.accessCode pentru request-uri, dar nu mai e vizibil
// în bara de adresă, screenshot-uri, server logs, sau bookmark sharing.
if (params.has('code') && window.history && window.history.replaceState) {
  const cleanParams = new URLSearchParams(window.location.search);
  cleanParams.delete('code');
  const cleanQuery = cleanParams.toString();
  const cleanUrl = window.location.pathname + (cleanQuery ? '?' + cleanQuery : '') + window.location.hash;
  window.history.replaceState(null, '', cleanUrl);
}

function langLabel(code) {
  // V11.5: prefer endonym ("Norsk", "English") over RO name ("Norvegiană", "Engleză") on
  // end-user UI. Falls through to availableLanguages if no endonym for the code.
  return availableEndonyms[code] || availableLanguages[code] || code.toUpperCase();
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
      if (clock) {
        clock.style.display = state.showClock ? 'block' : 'none';
        clock.className = `display-clock clock-${state.clockPosition || 'top-right'}`;
        clock.style.setProperty('--clock-scale', String(state.clockScale || 1));
      }
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
        || '…';
    }
    // BUGFIX V3: NU folosim activeBlock ca fallback (text original)
    // pentru a evita afișarea textului românesc pe Main Screen când e altă limbă selectată
    return state.songState.translations?.[language]
      || '…';
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
      || '…';
  }
  return '…';
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

  // V11.7: Grow-to-fit algorithm via binary search. Previous shrink-to-fit started
  // small (width/12) and only shrunk on overflow — short verses stopped at the
  // initial small size, wasting card space. Now we search for the LARGEST size
  // that fits both dimensions, so short verses naturally grow to fill the card.

  // Reset inline styles from any previous fit pass.
  box.style.fontSize = '';
  box.style.lineHeight = '';
  box.style.maxWidth = '';
  box.style.maxHeight = '';
  box.style.transform = '';
  box.style.transformOrigin = '';

  // Available space = container clientW/H minus its CSS padding minus reserveHeight
  // (room for sibling labels above the text). Magic `-28`/`-20` buffers from the
  // shrink-to-fit era removed — binary search detects overflow precisely via
  // scrollWidth/scrollHeight, no slack buffer needed.
  const containerStyle = window.getComputedStyle(container);
  const paddingX = (parseFloat(containerStyle.paddingLeft) || 0) + (parseFloat(containerStyle.paddingRight) || 0);
  const paddingY = (parseFloat(containerStyle.paddingTop) || 0) + (parseFloat(containerStyle.paddingBottom) || 0);
  const reserveHeight = options.reserveHeight ?? 20;
  const availableWidth = Math.max(container.clientWidth - paddingX, 120);
  const availableHeight = Math.max(container.clientHeight - paddingY - reserveHeight, 80);
  if (availableWidth <= 0 || availableHeight <= 0) return;

  box.style.maxWidth = availableWidth + 'px';
  box.style.maxHeight = availableHeight + 'px';

  // V11.7: respect user's textSize preset + custom textScale by scaling the search
  // cap. These multipliers were applied to starting size in shrink-to-fit;
  // preserve them in grow-to-fit by scaling the upper search bound. Without this
  // the compact/large/xlarge/huge buttons + scale slider would become no-ops.
  // V21.28: callers that want textScale applied as a DIRECT multiplier on the
  // fitted size (like clock-scale on styles.css:3837) pass ignoreManualScale=true
  // and multiply box.style.fontSize themselves after the fit returns. Folding
  // textScale into the cap was a no-op for the single-language projector because
  // short verses settle below the cap — the cap was never the binding constraint.
  const sizeModeMult = ({ compact: 0.78, large: 1.0, xlarge: 1.18, huge: 1.4 })[state.textSize || 'large'] ?? 1.0;
  const manualScale = options.ignoreManualScale
    ? 1
    : Math.min(1.3, Math.max(0.65, Number(state.textScale || 1)));
  const baseCap = Math.min(options.maxSize ?? 220, 220);   // V11.7: absolute cap 220px
  const effectiveCap = Math.round(baseCap * sizeModeMult * manualScale);
  const minSize = 18;
  // hi guaranteed >= minSize even when multipliers compound aggressively
  // (current min: 220 * 0.78 * 0.65 = ~112, still well above 18 — but defensive).
  const lo0 = minSize;
  const hi0 = Math.max(effectiveCap, minSize);

  // V11.7: Binary search for the largest size that fits both dimensions.
  // Converges in ~log2(hi0 - lo0) ≈ 8 iterations. Each iteration triggers reflow
  // via scrollWidth/scrollHeight reads; total cost ~3-5ms per fit call.
  let lo = lo0;
  let hi = hi0;
  let best = minSize;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    box.style.fontSize = mid + 'px';
    box.style.lineHeight = mid <= 30 ? '1.0' : mid <= 42 ? '1.04' : mid <= 64 ? '1.08' : '1.12';

    const overflowsWidth = box.scrollWidth > availableWidth + 1;   // +1 tolerance for sub-pixel
    const overflowsHeight = box.scrollHeight > availableHeight + 1;
    if (overflowsWidth || overflowsHeight) {
      hi = mid - 1;
    } else {
      best = mid;
      lo = mid + 1;
    }
  }

  box.style.fontSize = best + 'px';
  box.style.lineHeight = best <= 30 ? '1.0' : best <= 42 ? '1.04' : best <= 64 ? '1.08' : '1.12';

  // V11.7: NO transform scale fallback (was: scale(0.72-1.0) when even minSize
  // overflowed after line-height compression). With grow-to-fit, if minSize=18
  // still overflows, text wraps/clips naturally — better than scale-shrinking
  // below readability threshold. options.dense kept as noop for backward compat
  // with applyDualTextScale call sites (V11.6 passed dense: true).
}

function applyDualTextScale() {
  const dual = $('translateDualText');
  if (!dual) return;

  // V11.6: Reset inline styles so fitting starts clean on each update.
  // Selector matches all dual-text elements; we only act on primary/secondary
  // below, but resetting the class globally is safe (idempotent) and defensive
  // against any future card variants on the same screen.
  document.querySelectorAll('.unified-display-language-text').forEach((el) => {
    el.style.fontSize = '';
    el.style.lineHeight = '';
    el.style.transform = '';
    el.style.maxWidth = '';
    el.style.maxHeight = '';
  });

  const scale = Math.min(1.3, Math.max(0.65, Number(state.textScale || 1)));
  dual.style.setProperty('--dual-text-scale', String(scale));

  const primaryText = $('translatePrimaryText');
  const secondaryText = $('translateSecondaryText');
  const primaryCard = primaryText?.parentElement;
  const secondaryCard = secondaryText?.parentElement;
  if (!primaryText || !primaryCard || !secondaryText || !secondaryCard) return;

  // V11.6 Pass 1: fit each card independently to discover natural size.
  // V11.7: maxSize 100 → 220 to let pass 1 discover real natural max with grow-to-fit
  //        (shrink-to-fit era's 100 was a starting-size cap; grow-to-fit needs upper search bound).
  //        reserveHeight 60 → 20 reduces wasted vertical padding (header label is small).
  fitDisplayTextElement(primaryText, primaryCard, { reserveHeight: 20, maxSize: 220, dense: true });
  fitDisplayTextElement(secondaryText, secondaryCard, { reserveHeight: 20, maxSize: 220, dense: true });

  // V11.6 Pass 2: read effective sizes (fontSize × transform scale if applied),
  // take min. Skip sync if cards are already balanced (within 0.5px).
  const sizeA = readEffectiveFontSize(primaryText);
  const sizeB = readEffectiveFontSize(secondaryText);
  if (Math.abs(sizeA - sizeB) < 0.5) return;

  // V11.6 Pass 3: re-fit BOTH with the smaller size as cap. The larger card
  // shrinks down to match; the smaller card's transform scale (if any) is
  // re-evaluated — cleared if no longer needed at the new fontSize.
  const finalSize = Math.min(sizeA, sizeB);
  resetTextStyles(primaryText);
  resetTextStyles(secondaryText);
  // V11.7: reserveHeight 60 → 20 — consistent with pass 1.
  fitDisplayTextElement(primaryText, primaryCard, { reserveHeight: 20, maxSize: finalSize, dense: true });
  fitDisplayTextElement(secondaryText, secondaryCard, { reserveHeight: 20, maxSize: finalSize, dense: true });
}

// V11.6 helper: clear inline overrides set by fitDisplayTextElement.
function resetTextStyles(el) {
  if (!el) return;
  el.style.fontSize = '';
  el.style.lineHeight = '';
  el.style.transform = '';
  el.style.maxWidth = '';
  el.style.maxHeight = '';
}

// V11.6 helper: combine inline fontSize with transform scale (if any) from
// fitDisplayTextElement's final fallback. Parses matrix(a, b, c, d, tx, ty)
// where uniform scale produces a === d === scale factor. Returns visual size
// in CSS pixels.
function readEffectiveFontSize(el) {
  if (!el) return 0;
  const cs = window.getComputedStyle(el);
  const fontSize = parseFloat(cs.fontSize) || 0;
  const transform = cs.transform || '';
  const m = transform.match(/matrix\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(',').map(s => parseFloat(s.trim()));
    if (parts.length >= 4 && Number.isFinite(parts[0])) {
      return fontSize * parts[0];
    }
  }
  return fontSize;
}

function autoFitText() {
  const dual = $('translateDualText');
  if (dual && !dual.hidden) {
    applyDualTextScale();
    return;
  }

  const box = $('translateText');
  const wrap = $('translateTextWrap');
  const label = $('translateScreenLabel');
  const clock = $('displayClock');
  const labelHeight = label && !label.hidden ? label.getBoundingClientRect().height + 18 : 0;
  const clockReserve = clock && clock.style.display !== 'none' ? Math.max(clock.getBoundingClientRect().height + 20, 48) : 0;
  // V21.29: zoom single — split on direction so + stays contained inside
  // the usable card while − is always visibly smaller.
  //   SHRINK (<1): fit at natural fill (ignoreManualScale=true so the cap
  //   reflects only the textSize preset) then multiply post-fit. The result
  //   is always strictly smaller than the natural fit → never clips.
  //   GROW (>=1): keep textScale in the cap (V11.7 behavior preserved in
  //   fitDisplayTextElement). The binary search stops at the largest size
  //   that fits both dimensions, so + grows ONLY into the slack a short
  //   verse leaves on the card and never spills past the usable edge.
  //   We do NOT multiply post-fit on grow — that would push text past the
  //   binary search's overflow stopping condition (the V21.28 clipping bug).
  const scale = Math.min(1.4, Math.max(0.65, Number(state.textScale || 1)));
  if (scale < 1) {
    fitDisplayTextElement(box, wrap, { reserveHeight: labelHeight + clockReserve, dense: false, maxSize: 130, ignoreManualScale: true });
    const fitted = parseFloat(box.style.fontSize);
    if (fitted) box.style.fontSize = (fitted * scale) + 'px';
  } else {
    fitDisplayTextElement(box, wrap, { reserveHeight: labelHeight + clockReserve, dense: false, maxSize: 130 });
  }
}

// V22.6 — setează HTML cu fade blând DOAR când conținutul se schimbă (altfel no-op,
// ca să nu pâlpâie la fiecare render). Folosește clasa CSS .text-fading.
function setTextWithFade(el, html) {
  if (!el) return;
  if (el.innerHTML === html) return;
  el.classList.add('text-fading');
  clearTimeout(el._fadeTimer);
  el._fadeTimer = setTimeout(() => {
    el.innerHTML = html;
    el.classList.remove('text-fading');
    if (typeof autoFitText === 'function') requestAnimationFrame(autoFitText);
  }, 120);
}

function renderDisplay() {
  const languages = getDisplayLanguages();
  const useDual = languages.length === 2;
  const singleText = $('translateText');
  const dualText = $('translateDualText');
  if (singleText) {
    singleText.hidden = useDual;
    setTextWithFade(singleText, highlightBibleRefs(getTextToDisplay(languages[0] || state.currentLanguage)));
  }
  if (dualText) {
    dualText.hidden = !useDual;
    dualText.dataset.textSize = state.textSize || 'large';
    dualText.dataset.screenStyle = state.screenStyle || 'focus';
    if ($('translatePrimaryLanguageLabel')) $('translatePrimaryLanguageLabel').textContent = langLabel(languages[0] || state.currentLanguage);
    if ($('translatePrimaryText')) setTextWithFade($('translatePrimaryText'), highlightBibleRefs(getTextToDisplay(languages[0] || state.currentLanguage)));
    if ($('translateSecondaryLanguageLabel')) $('translateSecondaryLanguageLabel').textContent = langLabel(languages[1] || '');
    if ($('translateSecondaryText')) setTextWithFade($('translateSecondaryText'), highlightBibleRefs(getTextToDisplay(languages[1] || state.currentLanguage)));
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

// V21.30: enterFullscreen() and its button listener removed. The Fullscreen
// API drops out when the projector tab loses focus (Chrome policy), which
// happens routinely on the same-laptop setup when admin clicks Clear in the
// admin window. F11 = browser-level fullscreen, immune to tab-blur. The
// fullscreenchange handler below stays as a defensive no-op; wake-lock is
// still triggered via visibilitychange + load (not fullscreen).

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
    code: state.accessCode || undefined,
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

socket.on('joined_event', ({ event, languageNames, languageEndonyms }) => {
  if (languageNames) availableLanguages = languageNames;
  if (languageEndonyms) availableEndonyms = languageEndonyms;
  state.currentEvent = event;
  state.currentDisplayMode = event.displayState?.mode || 'auto';
  state.currentTheme = event.displayState?.theme || 'dark';
  state.currentLanguage = event.displayState?.language || state.currentLanguage;
  state.secondaryLanguage = event.displayState?.secondaryLanguage || '';
  state.blackScreen = !!event.displayState?.blackScreen;
  state.transcriptionPaused = !!event.transcriptionPaused;
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
  renderDisplay();
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

socket.on('transcription_state', ({ paused }) => {
  state.transcriptionPaused = !!paused;
  if (state.currentEvent) state.currentEvent.transcriptionPaused = state.transcriptionPaused;
  renderDisplay();
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
  if (!state.fixedEventId || !state.currentEvent) await joinEvent();
});

socket.on('event_target_langs_changed', ({ eventId, targetLangs, displayLanguage, secondaryLanguage }) => {
  if (!state.currentEvent || state.currentEvent.id !== eventId) return;
  if (Array.isArray(targetLangs)) state.currentEvent.targetLangs = targetLangs;
  if (displayLanguage) state.currentLanguage = displayLanguage;
  if (typeof secondaryLanguage === 'string') state.secondaryLanguage = secondaryLanguage;
  syncLanguageOptions(state.currentEvent);
  renderDisplay();
});

socket.on('transcripts_cleared', ({ eventId }) => {
  if (!state.currentEvent || state.currentEvent.id !== eventId) return;
  state.currentEvent.transcripts = [];
  state.currentEvent.latestDisplayEntry = null;
  state.latestLiveEntry = null;
  renderDisplay();
});

$('translateLanguage')?.addEventListener('change', handleLanguageChange);
// V21.30: fullscreenBtn removed from translate.html; F11 (browser fullscreen)
// is the supported path now. Listener removed alongside enterFullscreen().
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
    availableEndonyms = data.languageEndonyms || {};
  } catch (_) {}
  updateClock();
  window.setInterval(updateClock, 1000);
});
