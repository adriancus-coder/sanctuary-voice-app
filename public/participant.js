// V22.26 — reconectare rapidă (fără backoff lung) pentru revenire instantă în browser
const socket = io({
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 300,
  reconnectionDelayMax: 1500,
  timeout: 5000
});
const $ = (id) => document.getElementById(id);
let availableLanguages = {};
// V11.5: endonyms catalog (each language's name in its own language) — preferred over
// availableLanguages on end-user-facing participant UI. Falls back if server didn't send.
let availableEndonyms = {};
let participantWakeLock = null;
const participantParams = new URLSearchParams(window.location.search);
const LIVE_ENTRY_MIN_DISPLAY_MS = 2200;
const LIVE_ENTRY_MAX_DISPLAY_MS = 9000;
const LIVE_ENTRY_MAX_QUEUE = 3;
const LIVE_ENTRY_CATCHUP_MIN_MS = 1100;

// V22.19 — displayBuffer reținut DOAR pentru cleanup defensive (clearTimer + null pe pendingText)
// la lifecycle events (service end, etc.). smartDisplayLiveText nu mai setează aceste câmpuri,
// deci sunt mereu null/0 — cleanup-ul rămâne ca no-op safe.
const displayBuffer = {
  pendingText: null,
  lastDisplayTime: 0,
  pendingTimer: null
};

// V22.20 — DIAGNOSTIC: log ce text ajunge efectiv la participant (în #lastText).
// RĂMÂNE până confirmă utilizatorul că afișarea e ok. NU scoate fără confirmare.
const partLog = { entries: [], startedAt: null };
function logPart(text) {
  if (!partLog.startedAt) partLog.startedAt = new Date().toISOString();
  partLog.entries.push({ t: new Date().toISOString(), text: String(text || '') });
  if (partLog.entries.length > 3000) partLog.entries.shift();
}
function copyPartLog() {
  const L = [
    `Participant display log — ${partLog.entries.length} updates`,
    `Started: ${partLog.startedAt || '-'}`,
    '',
    '---',
    ''
  ];
  partLog.entries.forEach((e, i) => {
    const tt = e.t.split('T')[1]?.replace('Z', '') || e.t;
    L.push(`#${i + 1} [${tt}] ${e.text}`);
  });
  const txt = L.join('\n');
  const btn = document.getElementById('copyPartLogBtn');
  const flash = () => {
    if (!btn) return;
    const o = btn.textContent;
    btn.textContent = '✓ Copiat!';
    setTimeout(() => { btn.textContent = o; }, 1500);
  };
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = txt;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); flash(); }
    catch (_) { alert('Copy failed'); }
    ta.remove();
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(txt).then(flash, fallback);
  } else {
    fallback();
  }
}
window.copyPartLog = copyPartLog;

// BUGFIX V1 - FIX 2: Auto-expire live text dacă nu vine update nou
const liveTextExpire = {
  timer: null,
  EXPIRE_MS: 6000  // 6 secunde
};

function refreshLiveTextExpireTimer() {
  // Cancel timer existent
  if (liveTextExpire.timer) {
    clearTimeout(liveTextExpire.timer);
    liveTextExpire.timer = null;
  }

  // Programează expire în 6 sec
  liveTextExpire.timer = setTimeout(() => {
    // Au trecut 6 sec fără update - resetează la loading dots
    // DOAR dacă suntem în mod Live (nu song, nu service ended, etc.)
    const isLiveMode = state.currentMode === 'live' || state.currentMode === 'auto' || !state.currentMode;
    const hasActiveLiveEntry = state.visibleLiveEntry && !state.serviceEndedAcknowledged;

    if (isLiveMode && hasActiveLiveEntry) {
      // Curăță ultima traducere și arată loading dots
      state.visibleLiveEntry = null;
      state.lastLiveEntryId = null;
      if (typeof showLoadingDots === 'function') {
        showLoadingDots();
      }
    }

    liveTextExpire.timer = null;
  }, liveTextExpire.EXPIRE_MS);
}

function cancelLiveTextExpireTimer() {
  if (liveTextExpire.timer) {
    clearTimeout(liveTextExpire.timer);
    liveTextExpire.timer = null;
  }
}

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
  // V11.5: prefer endonym over RO name on end-user UI (participant phone view).
  return availableEndonyms[code] || availableLanguages[code] || code.toUpperCase();
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
  currentLanguage: participantParams.get('lang') || (function() {
    try {
      const eventKey = participantParams.get('event') || 'default';
      return localStorage.getItem(`sanctuary_voice_lang_${eventKey}`) || 'no';
    } catch (_) { return 'no'; }
  })(),
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
  serviceEndedAcknowledged: false,
  lastSpokenEntryId: null,
  localAudioEnabled: true,
  serverAudioMuted: false,
  languageInitialized: false,
  participantId: getOrCreateParticipantId(),
  compactMode: participantParams.get('compact') === '1' || localStorage.getItem('sanctuary_voice_participant_compact') === '1',
  focusMode: participantParams.get('focus') === '1' || localStorage.getItem('sanctuary_voice_participant_focus') === '1'
};

// Securitate: șterg query param-ul `code` din URL după ce am extras codul.
// Rămâne în state.previewCode pentru request-uri, dar nu mai e vizibil
// în bara de adresă, screenshot-uri, server logs, sau bookmark sharing.
if (participantParams.has('code') && window.history && window.history.replaceState) {
  const cleanParams = new URLSearchParams(window.location.search);
  cleanParams.delete('code');
  const cleanQuery = cleanParams.toString();
  const cleanUrl = window.location.pathname + (cleanQuery ? '?' + cleanQuery : '') + window.location.hash;
  window.history.replaceState(null, '', cleanUrl);
}

let publicEvents = [];
let pushSubscriptionEventId = '';

const SERVICE_ENDED_MESSAGES = {
  ro: {
    title: 'Serviciul a luat sfârșit',
    subtitle: 'Vă mulțumim că ați fost cu noi!',
    close: 'Închide',
    farewell: 'Vă așteptăm la următorul serviciu divin.'
  },
  no: {
    title: 'Gudstjenesten er avsluttet',
    subtitle: 'Takk for at du var med oss!',
    close: 'Lukk',
    farewell: 'Vi venter på deg ved neste gudstjeneste.'
  },
  en: {
    title: 'The service has ended',
    subtitle: 'Thank you for being with us!',
    close: 'Close',
    farewell: 'We look forward to seeing you at the next service.'
  },
  ru: {
    title: 'Богослужение завершено',
    subtitle: 'Спасибо, что были с нами!',
    close: 'Закрыть',
    farewell: 'Ждём вас на следующем богослужении.'
  },
  uk: {
    title: 'Богослужіння завершено',
    subtitle: 'Дякуємо, що були з нами!',
    close: 'Закрити',
    farewell: 'Чекаємо на вас на наступному богослужінні.'
  },
  es: {
    title: 'El servicio ha terminado',
    subtitle: '¡Gracias por estar con nosotros!',
    close: 'Cerrar',
    farewell: 'Los esperamos en el próximo servicio.'
  },
  de: {
    title: 'Der Gottesdienst ist beendet',
    subtitle: 'Danke, dass Sie bei uns waren!',
    close: 'Schließen',
    farewell: 'Wir freuen uns auf Sie beim nächsten Gottesdienst.'
  },
  fr: {
    title: 'Le service est terminé',
    subtitle: 'Merci d\'avoir été avec nous !',
    close: 'Fermer',
    farewell: 'Nous vous attendons au prochain service.'
  },
  it: {
    title: 'Il servizio è terminato',
    subtitle: 'Grazie per essere stati con noi!',
    close: 'Chiudi',
    farewell: 'Vi aspettiamo al prossimo servizio.'
  },
  hu: {
    title: 'Az istentisztelet véget ért',
    subtitle: 'Köszönjük, hogy velünk voltál!',
    close: 'Bezár',
    farewell: 'Várunk a következő istentiszteleten.'
  },
  pl: {
    title: 'Nabożeństwo zakończone',
    subtitle: 'Dziękujemy, że byliście z nami!',
    close: 'Zamknij',
    farewell: 'Zapraszamy na kolejne nabożeństwo.'
  },
  pt: {
    title: 'O culto terminou',
    subtitle: 'Obrigado por estar conosco!',
    close: 'Fechar',
    farewell: 'Esperamos vê-los no próximo culto.'
  }
};

function getServiceEndedMessages() {
  const lang = state.currentLanguage || 'en';
  return SERVICE_ENDED_MESSAGES[lang] || SERVICE_ENDED_MESSAGES.en;
}

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
  const lang = state.currentLanguage;
  const sourceLang = entry?.sourceLang || state.currentEvent?.sourceLang || 'ro';

  // Dacă utilizatorul a ales limba sursă, returnăm original (corect)
  if (lang === sourceLang) {
    return entry?.original || '';
  }

  // Altfel, returnăm DOAR traducerea în limba aleasă
  // BUGFIX V1: NU mai dăm fallback la original (care e în limba sursă)
  // pentru a evita afișarea textului românesc unui participant care a ales altă limbă.
  // Dacă lipsește traducerea, returnăm string gol -> handler-ul de afișare va păstra ultima traducere validă.
  return entry?.translations?.[lang] || '';
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
  // BUGFIX V3: NU mai dăm fallback la activeBlock (text original)
  // pentru a evita afișarea textului românesc unui participant care a ales altă limbă.
  // Returnăm string gol -> handler-ul de afișare va păstra ultima valoare sau loading dots.
  return songState?.translations?.[state.currentLanguage] || '';
}

function getLiveEntryDuration(entry) {
  const text = String(getTextForEntry(entry) || '').trim();
  const words = countWords(text);
  const lineCount = Math.max(1, Math.ceil(text.length / 42));
  const readingMs = 1400 + (words * 380) + (lineCount * 360);
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
    if (data.languageEndonyms) availableEndonyms = data.languageEndonyms;
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
  const limit = (window.matchMedia && window.matchMedia('(max-width: 379px)').matches) ? 2 : 3;
  const ids = state.recentEntryIds
    .filter((id) => id !== currentId)
    .slice(-limit)
    .reverse();
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
    // Cu maxim 3 linii: prima (cea mai recentă) cea mai vizibilă, ultima cea mai estompată.
    // Index 0 = cea mai recentă, ultima = cea mai veche.
    // Aceeași tonalitate ca live text (alb crem), doar opacity diferit pentru ierarhie.
    let opacity;
    if (lines.length === 3) {
      opacity = i === 0 ? 0.85 : i === 1 ? 0.65 : 0.45;
    } else if (lines.length === 2) {
      opacity = i === 0 ? 0.85 : 0.55;
    } else {
      opacity = 0.85;
    }
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

// SMART FLUSH V3: Loading dots indicator (replaces "Waiting..." text messages)
function showLoadingDots() {
  const el = document.getElementById('lastText');
  if (!el) return;
  el.innerHTML = '<span class="loading-dots"><span>•</span><span>•</span><span>•</span></span>';
  el.classList.add('loading-dots-active');
}

function clearLoadingDots() {
  const el = document.getElementById('lastText');
  if (!el) return;
  el.classList.remove('loading-dots-active');
}

// V22.21 — afișează doar propoziții complete (terminate cu . ! ?). Fragmentele scurte
// premature (începuturi de propoziție de la Azure) sunt ignorate până se completează.
// Virgula NU închide propoziția. Păstrează ultima propoziție completă afișată ca fallback.
let lastCompleteText = '';
function smartDisplayLiveText(newText, callback) {
  const txt = String(newText || '').trim();
  if (!txt) return;
  const isSpecial = txt.includes('📖');
  // V22.27 — publică și pe virgulă/pauză (, ; :), nu doar la final de propoziție (. ! ?),
  // pentru mai puțină întârziere la vorbitori rapizi. Fragmentele fără punctuație rămân blocate.
  const looksComplete = /[.!?,;:]["'»)\]]?\s*$/.test(txt);
  if (isSpecial || looksComplete) {
    lastCompleteText = txt;
    callback(txt);
  }
}

function renderLiveView({ announce = false } = {}) {
  if (!state.currentEvent) return;
  if (state.serviceEndedAcknowledged) {
    clearLoadingDots();
    $('lastText').textContent = getServiceEndedMessages().farewell;
    const earlierBox = $('participantEarlierLines');
    if (earlierBox) earlierBox.innerHTML = '';
    $('history').innerHTML = '';
    updateTopMeta();
    return;
  }
  if (state.currentMode === 'song' && state.currentSongState) {
    const songText = getSongTextForCurrentLanguage(state.currentSongState) || 'Waiting for song translation...';
    clearLoadingDots();
    $('lastText').textContent = songText;
    renderEarlierLines(null);
    renderHistory();
    updateTopMeta();
    return;
  }
  const visibleEntry = state.visibleLiveEntry || (state.allowTranscriptFallback ? getLatestEntry() : null);
  state.lastLiveEntryId = visibleEntry?.id || null;
  if (visibleEntry) {
    smartDisplayLiveText(getTextForEntry(visibleEntry), (text) => {
      logPart(text);   // V22.20 diagnostic
      clearLoadingDots();
      $('lastText').innerHTML = highlightBibleRefs(text);
    });
  } else {
    showLoadingDots();
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
  syncWelcomeLanguageOptions();
  modal.hidden = false;
  $('participantAiNoticeOk')?.focus();
}

function syncWelcomeLanguageOptions() {
  const select = $('participantWelcomeLang');
  const main = $('languageSelect');
  if (!select || !main) return;
  select.innerHTML = main.innerHTML;
  select.value = main.value;
}

function handleWelcomeLanguageChange() {
  const select = $('participantWelcomeLang');
  const main = $('languageSelect');
  if (!select || !main) return;
  main.value = select.value;
  handleLanguageChange();
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
  // BUGFIX V1: cancel auto-expire timer când intrăm în mod special
  if (typeof cancelLiveTextExpireTimer === 'function') {
    cancelLiveTextExpireTimer();
  }

  // SMART FLUSH V1.1: cleanup display buffer când intră în mod special
  if (displayBuffer.pendingTimer) {
    clearTimeout(displayBuffer.pendingTimer);
    displayBuffer.pendingTimer = null;
  }
  displayBuffer.pendingText = null;

  const overlay = $('participantServiceEnded');
  if (!overlay) return;

  // Localizez textele popup-ului în limba participantului
  const messages = getServiceEndedMessages();
  const titleEl = $('participantServiceEndedTitle');
  const subtitleEl = overlay.querySelector('.participant-service-ended-subtitle');
  const closeBtn = $('participantServiceEndedClose');
  if (titleEl) titleEl.textContent = messages.title;
  if (subtitleEl) subtitleEl.textContent = messages.subtitle;
  if (closeBtn) closeBtn.textContent = messages.close;

  const timeEl = $('participantServiceEndedTime');
  if (timeEl) timeEl.textContent = formatServiceEndedTime(endedAt);
  overlay.hidden = false;
  closeBtn?.focus();
}

function hideServiceEndedOverlay() {
  const overlay = $('participantServiceEnded');
  if (overlay) overlay.hidden = true;
  state.serviceEndedAcknowledged = true;
  renderLiveView({ announce: false });
}

// BIBLE MODE: localized messages in 12 languages
const BIBLE_READING_MESSAGES = {
  ro: { title: '📖 Citește din Biblie', subtitle: 'Citește din Biblia ta sau de pe ecran.' },
  no: { title: '📖 Bibellesning', subtitle: 'Les fra din egen Bibel eller fra skjermen.' },
  en: { title: '📖 Bible Reading', subtitle: 'Read from your Bible or from the screen.' },
  ru: { title: '📖 Чтение Библии', subtitle: 'Читайте из своей Библии или с экрана.' },
  uk: { title: '📖 Читання Біблії', subtitle: 'Читайте зі своєї Біблії або з екрану.' },
  es: { title: '📖 Lectura de la Biblia', subtitle: 'Lee de tu Biblia o de la pantalla.' },
  de: { title: '📖 Bibellesung', subtitle: 'Lies aus deiner Bibel oder vom Bildschirm.' },
  fr: { title: '📖 Lecture de la Bible', subtitle: 'Lisez dans votre Bible ou sur l\'écran.' },
  it: { title: '📖 Lettura della Bibbia', subtitle: 'Leggi dalla tua Bibbia o dallo schermo.' },
  hu: { title: '📖 Bibliaolvasás', subtitle: 'Olvasd a saját Bibliádból vagy a kijelzőről.' },
  pl: { title: '📖 Czytanie Biblii', subtitle: 'Czytaj ze swojej Biblii lub z ekranu.' },
  pt: { title: '📖 Leitura da Bíblia', subtitle: 'Lê da tua Bíblia ou do ecrã.' }
};

function getBibleReadingText() {
  const lang = state.currentLanguage || 'en';
  return BIBLE_READING_MESSAGES[lang] || BIBLE_READING_MESSAGES.en;
}

// BIBLE MODE V3.3: track if Bible Reading is active in live text
let bibleReadingLiveTextActive = false;

function showBibleReadingOverlay() {
  // BUGFIX V4: ascunde zonele de history pentru estetică clean
  // (Earlier lines inline + History panel ar arăta traduceri vechi peste mesajul Bible Reading)
  const earlierInline = document.getElementById('participantEarlierLines');
  const historyPanel = document.getElementById('participantHistoryPanel');
  if (earlierInline) earlierInline.style.display = 'none';
  if (historyPanel) historyPanel.style.display = 'none';

  // BUGFIX V1: cancel auto-expire timer când intrăm în mod special
  if (typeof cancelLiveTextExpireTimer === 'function') {
    cancelLiveTextExpireTimer();
  }

  // SMART FLUSH V1.1: cleanup display buffer când intră în mod special
  if (displayBuffer.pendingTimer) {
    clearTimeout(displayBuffer.pendingTimer);
    displayBuffer.pendingTimer = null;
  }
  displayBuffer.pendingText = null;

  // Bottom subtle bar with subtitle (doar instrucțiunea)
  let bottomBar = document.getElementById('participantBibleReadingBottom');
  if (!bottomBar) {
    bottomBar = document.createElement('div');
    bottomBar.id = 'participantBibleReadingBottom';
    bottomBar.className = 'participant-bible-reading-bottom';
    bottomBar.innerHTML = `
      <span class="participant-bible-reading-bottom-icon">📖</span>
      <span id="participantBibleReadingBottomText"></span>
    `;
    document.body.appendChild(bottomBar);
  }
  const text = getBibleReadingText();
  document.getElementById('participantBibleReadingBottomText').textContent = text.subtitle;
  bottomBar.hidden = false;

  // After 3 seconds (drain pipeline), replace Live Text with Bible Reading title
  setTimeout(() => {
    if (state.currentEvent?.bibleMode) {
      bibleReadingLiveTextActive = true;
      const lastTextEl = document.getElementById('lastText');
      if (lastTextEl) {
        lastTextEl.innerHTML = `<span class="bible-reading-live-icon">📖</span> ${text.title}`;
        lastTextEl.classList.add('bible-reading-mode');
      }
    }
  }, 3000);
}

function hideBibleReadingOverlay() {
  // BUGFIX V4: restaurează zonele de history (display='' = revin la stilul default din CSS)
  const earlierInline = document.getElementById('participantEarlierLines');
  const historyPanel = document.getElementById('participantHistoryPanel');
  if (earlierInline) earlierInline.style.display = '';
  if (historyPanel) historyPanel.style.display = '';

  // Hide bottom bar
  const bottomBar = document.getElementById('participantBibleReadingBottom');
  if (bottomBar) bottomBar.hidden = true;

  // Restore Live Text - remove bible mode styling
  bibleReadingLiveTextActive = false;
  const lastTextEl = document.getElementById('lastText');
  if (lastTextEl) {
    lastTextEl.classList.remove('bible-reading-mode');
    // Don't manually set text - let the next renderLiveView call update it normally
  }

  // Trigger re-render of live view to restore proper text
  if (typeof renderLiveView === 'function') {
    renderLiveView({ announce: false });
  }
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
      role: 'participant',
      subscription
    })
  });
  pushSubscriptionEventId = state.currentEvent.id;
}

function handleLanguageChange() {
  state.currentLanguage = $('languageSelect').value;
  try {
    const eventKey = state.currentEvent?.id || state.fixedEventId || 'default';
    localStorage.setItem(`sanctuary_voice_lang_${eventKey}`, state.currentLanguage);
  } catch (_) {}
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
  if (event?.transcriptionOnAir) {
    state.serviceEndedAcknowledged = false;
  }
  if (state.currentMode === 'live') {
    const latest = event.latestDisplayEntry;
    if (latest) {
      state.visibleLiveEntry = cloneEntry(latest);
      state.awaitingFreshLiveEntry = false;
      state.allowTranscriptFallback = true;
      state.freshLiveStartedAt = 0;
      state.freshLiveBlockedEntryIds = new Set();
      state.liveEntryShownAt = Date.now();
    } else {
      state.visibleLiveEntry = null;
      state.awaitingFreshLiveEntry = false;
      state.allowTranscriptFallback = true;
      state.freshLiveStartedAt = 0;
      state.freshLiveBlockedEntryIds = new Set();
    }
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
  setStatus(state.serverAudioMuted ? 'Audio is muted by the operator. You cannot enable it right now.' : 'Connected.');
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
  if (!entry?.id) return;

  // BUGFIX V1: protecție limbă - dacă limba mea NU are traducere, NU procesa entry-ul.
  // Asta evită bug-ul unde participanții vedeau text românesc în loc de limba lor selectată.
  // Așteptăm un partial cu limba mea (sau urmatorul display_live_entry cu traducere completă).
  const lang = state.currentLanguage;
  const sourceLang = entry?.sourceLang || state.currentEvent?.sourceLang || 'ro';
  const isSourceUser = lang === sourceLang;

  if (!isSourceUser) {
    const langTranslation = entry?.translations?.[lang];
    if (typeof langTranslation !== 'string' || !langTranslation.trim()) {
      // Skip - nu am traducere pentru limba mea, păstrăm ce afișăm acum
      return;
    }
  }

  setParticipantUpdating(false);
  state.serviceEndedAcknowledged = false;
  state.currentEvent.latestDisplayEntry = cloneEntry(entry);
  enqueueLiveEntry(entry);

  // BUGFIX V1: refresh auto-expire timer la fiecare update valid
  refreshLiveTextExpireTimer();
});

socket.on('display_live_entry_partial', (payload) => {
  if (!state.currentEvent) return;
  if (!payload?.entryId) return;
  const lang = state.currentLanguage;
  const sourceLang = payload?.sourceLang || state.currentEvent?.sourceLang || 'ro';
  const isSourceUser = lang === sourceLang;
  const partialForLang = isSourceUser
    ? (payload?.original || '')
    : payload?.translations?.[lang];
  if (typeof partialForLang !== 'string' || !partialForLang.trim()) return;
  state.serviceEndedAcknowledged = false;
  setParticipantUpdating(false);
  const existing = state.visibleLiveEntry;
  if (existing && existing.id === payload.entryId) {
    existing.translations = { ...(existing.translations || {}), [lang]: partialForLang };
    state.visibleLiveEntry = existing;
    state.lastLiveEntryId = existing.id;
    clearLoadingDots();
    $('lastText').innerHTML = highlightBibleRefs(getTextForEntry(existing));
    // BUGFIX V1: refresh auto-expire timer (early-return path is still real activity)
    refreshLiveTextExpireTimer();
    return;
  }
  if (existing && existing.id !== payload.entryId) {
    rememberRecentEntry(existing);
  }
  const partialEntry = {
    id: payload.entryId,
    sourceLang: payload.sourceLang || state.currentEvent?.sourceLang || 'ro',
    original: payload.original || '',
    translations: { [lang]: partialForLang },
    createdAt: payload.createdAt || new Date().toISOString(),
    partial: true
  };
  state.visibleLiveEntry = partialEntry;
  state.awaitingFreshLiveEntry = false;
  state.allowTranscriptFallback = true;
  state.freshLiveStartedAt = 0;
  state.freshLiveBlockedEntryIds = new Set();
  state.liveEntryShownAt = Date.now();
  state.lastLiveEntryId = partialEntry.id;
  renderLiveView({ announce: false });

  // BUGFIX V1: refresh auto-expire timer
  refreshLiveTextExpireTimer();
});

socket.on('display_mode_changed', (payload) => {
  if (!state.currentEvent) return;
  state.currentEvent.displayState = {
    ...(state.currentEvent.displayState || {}),
    ...payload
  };
  if ((payload?.mode || '') === 'auto') {
    // V11.1: when song_clear just fired, the server emits display_mode_changed mode='auto'
    // as part of the same flow. Without suppression, this would set allowTranscriptFallback=true
    // and render the latest stale transcript — overriding the "show 3-dot loader until fresh
    // entry" intent. 3-second suppression window lets the song_clear visual settle first.
    if (state.suppressTranscriptFallback) return;
    state.awaitingFreshLiveEntry = false;
    state.freshLiveStartedAt = 0;
    state.freshLiveBlockedEntryIds = new Set();
    state.allowTranscriptFallback = true;
    renderLiveView({ announce: false });
  }
});

socket.on('display_manual_update', (payload) => {
  if (!state.currentEvent) return;
  state.currentEvent.displayState = {
    ...(state.currentEvent.displayState || {}),
    ...payload
  };
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

// BIBLE MODE: handle activation/deactivation
socket.on('bible_mode_changed', (payload) => {
  // V3.3: keep state in sync so the 3s drain guard inside showBibleReadingOverlay sees the current value
  if (state.currentEvent) {
    state.currentEvent.bibleMode = !!payload?.enabled;
  }
  if (payload?.enabled) {
    showBibleReadingOverlay();
  } else {
    hideBibleReadingOverlay();
  }
});

socket.on('audio_state', ({ audioMuted }) => {
  state.serverAudioMuted = !!audioMuted;
  if (audioMuted) {
    stopSpeech();
    setStatus('Audio is muted by the operator. You cannot enable it right now.');
  } else {
    setStatus(state.localAudioEnabled ? 'Audio active.' : 'Audio paused by you. Tap "Audio on" to resume.');
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
    showLoadingDots();
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
    // BUGFIX V1: cancel auto-expire timer când intrăm în mod special
    if (typeof cancelLiveTextExpireTimer === 'function') {
      cancelLiveTextExpireTimer();
    }
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
    // V11.1: respect song_clear's 3-sec suppression window — keep awaiting fresh entry,
    // don't fall back to latest stale transcript while the loading dots are showing.
    if (!state.suppressTranscriptFallback) {
      state.awaitingFreshLiveEntry = false;
      state.allowTranscriptFallback = true;
      state.freshLiveStartedAt = 0;
      state.freshLiveBlockedEntryIds = new Set();
    }
    setStatus(state.serverAudioMuted ? 'Audio is muted by the operator. You cannot enable it right now.' : 'Connected.');
  }
  renderLiveView({ announce: false });
});

socket.on('song_state', (songState) => {
  // BUGFIX V1: cancel auto-expire timer când intrăm în mod special
  if (typeof cancelLiveTextExpireTimer === 'function') {
    cancelLiveTextExpireTimer();
  }
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
  // V11: explicit visual reset so participant sees the song text disappear immediately.
  // V11.1: show the 3-dot loader (Smart Flush V3) + suppress transcript fallback for 3 sec
  // so the follow-up display_mode_changed mode='auto' event (which normally enables
  // allowTranscriptFallback=true → renders latest old transcript) does NOT override the
  // "waiting for fresh entry" intent. After 3s the suppression lifts naturally so the
  // normal mode=auto behavior resumes for future live updates.
  state.visibleLiveEntry = null;
  state.liveEntryQueue = [];
  if (state.liveEntryTimer) { clearTimeout(state.liveEntryTimer); state.liveEntryTimer = null; }
  const earlierBox = document.getElementById('participantEarlierLines');
  if (earlierBox) earlierBox.innerHTML = '';
  // SMART FLUSH V1.1: drop any pending buffered chunks that were about to be displayed
  if (displayBuffer.pendingTimer) { clearTimeout(displayBuffer.pendingTimer); displayBuffer.pendingTimer = null; }
  displayBuffer.pendingText = null;
  // V11.1: explicit 3-dot loader instead of static text (matches Smart Flush V3 design)
  showLoadingDots();
  // V11.1: sticky suppression flag — display_mode_changed honors this for 3s
  state.suppressTranscriptFallback = true;
  if (state.suppressTranscriptFallbackTimer) clearTimeout(state.suppressTranscriptFallbackTimer);
  state.suppressTranscriptFallbackTimer = setTimeout(() => {
    state.suppressTranscriptFallback = false;
    state.suppressTranscriptFallbackTimer = null;
  }, 3000);
  syncLanguageOptions({ ...state.currentEvent, mode: 'live', songState: null });
  waitForFreshLiveEntry();
  // Don't call renderLiveView here — it would overwrite showLoadingDots if no fresh entry.
  // waitForFreshLiveEntry already calls renderLiveView; that one will respect the dots.
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
  setStatus(state.serverAudioMuted ? 'Audio is muted by the operator. You cannot enable it right now.' : 'Audio active.');
  applyAudioButtonState();
  const latestEntry = getLatestEntry();
  if (latestEntry) speakLatestEntry(latestEntry);
});

$('pauseAudioBtn').addEventListener('click', () => {
  state.localAudioEnabled = false;
  stopSpeech();
  setStatus('Audio paused by you. Tap "Audio on" to resume.');
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
$('participantWelcomeLang')?.addEventListener('change', handleWelcomeLanguageChange);
$('participantServiceEndedClose')?.addEventListener('click', hideServiceEndedOverlay);

window.addEventListener('load', async () => {
  try {
    const res = await fetch('/api/languages');
    const data = await res.json();
    availableLanguages = data.languages || {};
    availableEndonyms = data.languageEndonyms || {};
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
    // V22.26 — reconectare instantă la revenirea în browser
    if (!socket.connected) socket.connect();
    await enableWakeLock();
  }
});
// V22.26 — reconectare și când rețeaua revine
window.addEventListener('online', () => {
  if (!socket.connected) socket.connect();
});

if ('serviceWorker' in navigator && !state.previewMode) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/push-sw.js').catch(() => {});
  });
}

window.addEventListener('beforeunload', async () => {
  await disableWakeLock();
});

// V22.20 — listener pentru butonul de copiere log diagnostic
document.getElementById('copyPartLogBtn')?.addEventListener('click', copyPartLog);
