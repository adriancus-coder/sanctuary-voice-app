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
  pinnedTextLibrary: [],
  worship: { online: false, hasState: false, songTitle: '', verseIndex: 0, ended: false, request: null },
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

function escapeHtmlWithBreaks(value) {
  return escapeHtml(value).replace(/\n/g, '<br>');
}

// V19: case + diacritic-insensitive search (RO ăâîșț etc.), mirrors app.js normalizeForSearch.
function normalizeForSearch(str) {
  if (!str) return '';
  return String(str).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

// V19: song-block "already displayed" tracking for the live song.
let remoteDisplayedSongBlocks = new Set();
let remoteCurrentSongTitle = '';

function switchRemoteTab(tab) {
  document.querySelectorAll('.top-nav-btn[data-tab]').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `tab-${tab}`);
  });
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
  // V21.17: compact event name in the thin header bar.
  const headerEventEl = $('remoteHeaderEventName');
  if (headerEventEl) headerEventEl.textContent = state.currentEvent?.name || '—';
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
    // BUGFIX V3: nu mai cădem pe activeBlock (text sursă) pentru limbi non-source
    return songState.translations?.[displayLang] || 'Waiting for song translation…';
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
    // BUGFIX V3: nu mai cădem pe activeBlock (text sursă) pentru limbi non-source
    return songState.translations?.[participantLang] || 'Waiting for song translation…';
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

// V19: shared diacritic-insensitive filter + sort for the library lists.
function filterAndSortRemoteList(items, searchId, sortId) {
  const query = normalizeForSearch(($(searchId)?.value || '').trim());
  const sortMode = $(sortId)?.value || 'az';
  return (Array.isArray(items) ? items : [])
    .filter((item) => {
      if (!query) return true;
      return normalizeForSearch(item.title).includes(query)
        || normalizeForSearch(item.text).includes(query);
    })
    .sort((a, b) => {
      if (sortMode === 'recent') {
        return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
      }
      const titleA = String(a.title || '').toLowerCase();
      const titleB = String(b.title || '').toLowerCase();
      return sortMode === 'za' ? titleB.localeCompare(titleA) : titleA.localeCompare(titleB);
    });
}

function findDuplicateRemoteLibrarySong(title) {
  const norm = normalizeForSearch(String(title || '').trim());
  if (!norm) return null;
  return (state.globalSongLibrary || [])
    .find((item) => normalizeForSearch(String(item?.title || '').trim()) === norm) || null;
}

function renderRemoteSongLibrary() {
  const box = $('remoteSongLibraryList');
  if (!box) return;
  const items = filterAndSortRemoteList(state.globalSongLibrary, 'remoteSongLibrarySearch', 'remoteSongLibrarySort');
  if (!items.length) {
    box.innerHTML = '<div class="muted">No church songs saved yet.</div>';
    return;
  }
  box.innerHTML = items.map((item) => `
    <details class="event-card library-card-details">
      <summary class="library-card-summary">
        <span class="name">${escapeHtml(item.title || 'Untitled')}</span>
      </summary>
      <div class="library-card-body">
        <div class="small"><b>Language:</b> ${escapeHtml(langLabel(item.sourceLang || state.currentEvent?.sourceLang || 'ro'))}</div>
        <div class="library-card-actions">
          <button class="btn btn-dark" type="button" data-remote-song-action="preview" data-remote-song-id="${item.id}">Preview</button>
          <button class="btn btn-dark" type="button" data-remote-song-action="load" data-remote-song-id="${item.id}">Edit</button>
          <button class="btn btn-dark" type="button" data-remote-song-action="stage" data-remote-song-id="${item.id}" title="Încarcă în Live Control (staged) — fără să afișeze pe proiector">Load</button>
          <button class="btn btn-primary" type="button" data-remote-song-action="send" data-remote-song-id="${item.id}">Send first verse</button>
          <button class="btn btn-dark" type="button" data-remote-song-action="add" data-remote-song-id="${item.id}">Add to event</button>
        </div>
        <div class="library-preview hidden" data-remote-song-preview="${item.id}">
          <pre class="library-preview-text">${escapeHtml(item.text || '')}</pre>
        </div>
      </div>
    </details>
  `).join('');
}

function renderRemotePinnedTextLibrary() {
  const box = $('remoteManualLibraryList');
  if (!box) return;
  const items = filterAndSortRemoteList(state.pinnedTextLibrary, 'remoteManualLibrarySearch', 'remoteManualLibrarySort');
  if (!items.length) {
    box.innerHTML = '<div class="muted">No pinned texts saved yet.</div>';
    return;
  }
  box.innerHTML = items.map((item) => `
    <details class="event-card library-card-details">
      <summary class="library-card-summary">
        <span class="name">${escapeHtml(item.title || 'Untitled')}</span>
      </summary>
      <div class="library-card-body">
        <div class="small"><b>Language:</b> ${escapeHtml(langLabel(item.sourceLang || state.currentEvent?.sourceLang || 'ro'))}</div>
        <div class="small">${escapeHtmlWithBreaks(String(item.text || '').slice(0, 200))}${String(item.text || '').length > 200 ? '...' : ''}</div>
        <div class="library-card-actions">
          <button class="btn btn-dark" type="button" data-remote-pinned-action="preview" data-remote-pinned-id="${item.id}">Preview</button>
          <button class="btn btn-dark" type="button" data-remote-pinned-action="load" data-remote-pinned-id="${item.id}">Load in editor</button>
          <button class="btn btn-primary" type="button" data-remote-pinned-action="send" data-remote-pinned-id="${item.id}">Send to main screen</button>
        </div>
        <div class="library-preview hidden" data-remote-pinned-preview="${item.id}">
          <pre class="library-preview-text">${escapeHtml(item.text || '')}</pre>
        </div>
      </div>
    </details>
  `).join('');
}

function renderRemoteSongHistory() {
  const box = $('remoteSongHistoryList');
  if (!box) return;
  const items = Array.isArray(state.currentEvent?.songHistory) ? state.currentEvent.songHistory : [];
  if (!items.length) {
    box.innerHTML = '<div class="muted">Nothing sent yet.</div>';
    return;
  }
  box.innerHTML = items.map((item) => {
    const preview = String(item.source || '');
    return `
      <div class="history-item">
        <div><b>${escapeHtml(item.title || 'Sent text')}</b> <span class="small">(${escapeHtml(item.kind || 'song')})</span></div>
        <div class="small">${escapeHtmlWithBreaks(preview.slice(0, 220))}${preview.length > 220 ? '...' : ''}</div>
      </div>
    `;
  }).join('');
}

function renderRemoteSongState() {
  const songState = state.currentEvent?.songState || {};
  const blocks = Array.isArray(songState.blocks) ? songState.blocks : [];
  const labels = Array.isArray(songState.blockLabels) ? songState.blockLabels : [];
  const currentIndex = Number.isInteger(songState.currentIndex) ? songState.currentIndex : -1;
  const activeBlock = typeof songState.activeBlock === 'string' ? songState.activeBlock : '';
  const sourceLang = songState.sourceLang || state.currentEvent?.sourceLang || 'ro';

  // Reset the "already displayed" set when a different song goes live.
  const incomingTitle = String(songState.title || '');
  if (incomingTitle !== remoteCurrentSongTitle) {
    remoteDisplayedSongBlocks = new Set();
    remoteCurrentSongTitle = incomingTitle;
  }
  if (currentIndex >= 0) remoteDisplayedSongBlocks.add(currentIndex);

  const summaryEl = $('remoteSongSummary');
  if (summaryEl) {
    const libraryCount = Array.isArray(state.globalSongLibrary) ? state.globalSongLibrary.length : 0;
    const historyCount = Array.isArray(state.currentEvent?.songHistory) ? state.currentEvent.songHistory.length : 0;
    summaryEl.textContent = `Saved: ${libraryCount} · History: ${historyCount} · Language: ${langLabel(sourceLang)}`;
  }

  const modeBadge = $('remoteSongModeBadge');
  if (modeBadge) {
    modeBadge.textContent = (state.currentEvent?.displayState?.mode === 'song') ? 'Song live' : 'Live';
  }

  const previewEl = $('remoteSongPreview');
  if (previewEl) previewEl.textContent = activeBlock || 'Song text will appear here.';

  const editBtn = $('remoteEditLiveVerseBtn');
  if (editBtn) editBtn.hidden = !activeBlock;

  renderRemoteSongJumpSelect();

  const blocksEl = $('remoteSongBlocksList');
  if (!blocksEl) return;
  if (!blocks.length) {
    blocksEl.innerHTML = '<div class="muted">Use Save in library or Send first verse.</div>';
    return;
  }
  // V21.11: worship-position awareness. Recon (parser comparison)
  // confirmed worship verseIndex N == projector block index N — both
  // parsers split on the same /\n\s*\n/. So if worship is on the SAME
  // song as the projector, the green "♪ worship" badge marks the block.
  const worshipInfo = getRemoteWorshipBlockInfo();
  blocksEl.innerHTML = blocks.map((block, index) => {
    const activeClass = index === currentIndex ? ' active' : '';
    const displayedClass = remoteDisplayedSongBlocks.has(index) && index !== currentIndex ? ' already-displayed' : '';
    const label = escapeHtml(labels[index] || `Verse ${index + 1}`);
    const firstLine = String(block || '').split('\n')[0] || '';
    const preview = firstLine.length > 80 ? `${firstLine.slice(0, 80)}...` : firstLine;
    const worshipMarker = (worshipInfo.mode === 'same' && index === worshipInfo.verseIndex)
      ? '<span class="song-block-worship-badge" title="Worship e aici acum">♪ worship</span>' : '';
    return `
      <div class="song-section-item-wrap${activeClass}${displayedClass}">
        <button class="history-item song-section-item${activeClass}${displayedClass}" type="button" data-remote-song-block-index="${index}">
          <div class="entry-head">
            <b>${label}</b>${worshipMarker}
            <span class="small">${index === currentIndex ? 'Live now' : 'Click to send live'}</span>
          </div>
          <div class="small song-block-preview">${escapeHtml(preview)}</div>
        </button>
        <button class="btn btn-dark song-block-extend" type="button" data-remote-song-block-extend="${index}" aria-label="Show full verse">▾</button>
        <div class="song-block-full" data-remote-song-block-full="${index}" hidden>${escapeHtmlWithBreaks(block)}</div>
      </div>
    `;
  }).join('');
  if (worshipInfo.mode === 'different') {
    blocksEl.insertAdjacentHTML('afterbegin',
      `<div class="worship-different-song-msg">♪ Worship e pe altă cântare: <strong>${escapeHtml(worshipInfo.songTitle)}</strong></div>`);
  }
}

// V21.11: where is worship now, relative to the song loaded on the
// projector? Match is by title — songState carries `title`, the
// worship:state_change broadcast carries the song title too. (songState
// has no library id, so title is the only shared key.)
function getRemoteWorshipBlockInfo() {
  const w = state.worship;
  if (!w || !w.online || !w.songTitle) return { mode: 'none' };
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const projectorTitle = norm(state.currentEvent?.songState?.title);
  if (projectorTitle && norm(w.songTitle) === projectorTitle) {
    return { mode: 'same', verseIndex: Number.isInteger(w.verseIndex) ? w.verseIndex : 0 };
  }
  return { mode: 'different', songTitle: w.songTitle };
}

function fillRemoteSongEditor(item) {
  if ($('remoteSongTitle')) $('remoteSongTitle').value = item?.title || '';
  if ($('remoteSongText')) $('remoteSongText').value = item?.text || '';
  if ($('remoteSongSourceLang')) {
    $('remoteSongSourceLang').value = item?.sourceLang || state.currentEvent?.sourceLang || 'ro';
  }
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
  const pinnedLangSelect = $('remotePinnedSourceLang');
  [songLangSelect, glossaryLangSelect, pinnedLangSelect].forEach((select) => {
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

async function loadRemotePinnedTextLibrary() {
  try {
    const res = await fetch('/api/pinned-text-library');
    const data = await res.json();
    state.pinnedTextLibrary = data.pinnedTextLibrary || [];
    renderRemotePinnedTextLibrary();
  } catch (_) {
    const box = $('remoteManualLibraryList');
    if (box) box.innerHTML = '<div class="muted">Could not load pinned text library.</div>';
  }
}

// V21.4-FIX: per-event "Songs in this event" panel on the operator. Read-only
// (the DELETE endpoint is admin-gated); reads state.currentEvent.songLibrary
// which is already on the event payload.
function renderRemoteEventSongLibrary() {
  const list = $('remoteEventSongsList');
  const count = $('remoteEventSongsCount');
  if (!list || !count) return;
  const items = Array.isArray(state.currentEvent?.songLibrary) ? state.currentEvent.songLibrary : [];
  count.textContent = String(items.length);
  if (!state.currentEvent) {
    list.innerHTML = '<p class="muted small">Niciun event selectat.</p>';
    return;
  }
  if (!items.length) {
    list.innerHTML = '<p class="muted small">Niciun cântec adăugat în event.</p>';
    return;
  }
  // V21.8: per-row "Push worship" button. Disabled when worship is
  // offline (no master socket reachable) so the operator does not push
  // into a void; the V21.3 presence flag drives the gate.
  // V21.12: Preview / Load (staged) / Send first verse buttons added.
  const worshipOnline = !!state.worship?.online;
  list.innerHTML = items.map((item, idx) => `
    <div class="event-song-row" data-remote-event-song-row="${escapeHtml(item.id)}">
      <span class="event-song-index">${idx + 1}.</span>
      <div class="event-song-meta">
        <strong>${escapeHtml(item.title || 'Untitled')}</strong>
      </div>
      <div class="event-song-actions">
        <button class="btn btn-dark btn-sm" type="button" data-event-song-preview="${escapeHtml(item.id)}">Preview</button>
        <button class="btn btn-dark btn-sm" type="button" data-event-song-load="${escapeHtml(item.id)}">Load</button>
        <button class="btn btn-primary btn-sm" type="button" data-event-song-send="${escapeHtml(item.id)}">Send</button>
        <button class="btn btn-primary btn-sm" type="button"
                data-remote-push-worship="${escapeHtml(item.id)}"
                ${worshipOnline ? '' : 'disabled title="Worship offline"'}>📢 Push</button>
        <!-- V21.34: mirror admin's per-event Delete (server-side gating
             relaxed to screen+'song') -->
        <button class="btn btn-danger btn-sm" type="button" data-event-song-delete="${escapeHtml(item.id)}">Delete</button>
      </div>
      <div class="event-song-preview hidden" data-event-song-preview-text="${escapeHtml(item.id)}"><pre>${escapeHtml(item.text || '')}</pre></div>
    </div>
  `).join('');
}

// V21.3: operator awareness of the worship-live channel.
function renderRemoteWorshipPanel() {
  const w = state.worship;
  // V21.17: mirror worship status into the thin header pill (always visible,
  // even when the Worship Live panel itself is hidden for non-song operators).
  const headerDot = $('remoteHeaderWorshipDot');
  const headerText = $('remoteHeaderWorshipText');
  if (headerDot) headerDot.classList.toggle('online', !!w.online);
  if (headerText) {
    if (w.online && w.hasState && w.songTitle) {
      // V21.22: surface END in the thin header pill too.
      headerText.textContent = w.ended
        ? `Worship · ${w.songTitle} · END`
        : `Worship live · ${w.songTitle}`;
    } else {
      headerText.textContent = w.online ? 'Worship live' : 'Worship offline';
    }
  }
  const presenceEl = $('remoteWorshipPresence');
  const statusEl = $('remoteWorshipStatus');
  const reqEl = $('remoteWorshipRequest');
  if (!presenceEl || !statusEl || !reqEl) return;
  presenceEl.textContent = w.online ? 'Worship online' : 'Worship offline';
  presenceEl.classList.toggle('active', w.online);
  if (w.hasState && w.songTitle) {
    if (w.ended) {
      // V21.22: worship master blanked the members' screen.
      statusEl.textContent = `Worship: ${w.songTitle} · END (ecran golit pentru membri)`;
    } else {
      statusEl.textContent = `Worship: ${w.songTitle} · strofa ${w.verseIndex + 1}`;
    }
  } else {
    statusEl.textContent = 'Echipa worship nu a trimis nicio cântare încă.';
  }
  if (w.request) {
    reqEl.classList.remove('hidden');
    // V21.9: "Am notat" replaces "Aprob" — the bridge is not automatic.
    // The operator acknowledges the worship request and then moves the
    // projector by hand. The hint line makes that contract explicit.
    reqEl.innerHTML = `
      <div class="worship-sync-toast-text">🎵 Worship cere sync proiector: <b>${escapeHtml(w.request.songTitle || 'cântare')}</b> · strofa ${w.request.verseIndex + 1}</div>
      <div class="worship-sync-toast-hint small muted">Vei sincroniza manual pe proiector după.</div>
      <div class="worship-sync-toast-actions">
        <button class="btn btn-primary" type="button" data-worship-req="note">Am notat</button>
        <button class="btn btn-dark" type="button" data-worship-req="decline">Refuz</button>
      </div>`;
  } else {
    reqEl.classList.add('hidden');
    reqEl.innerHTML = '';
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
  const presetsPanel = presetsList?.closest('.panel');
  const glossaryPanel = $('remoteGlossaryPanel');
  const liveAudioPanel = $('remoteLiveAudioPanel');
  const openMainScreenBtn = $('remoteOpenMainScreenBtn');
  const songTabBtn = $('remoteSongTabBtn');
  const pinnedTextPanel = $('remotePinnedTextPanel');
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
  if (presetsPanel) presetsPanel.hidden = !mainScreenAllowed;
  if (glossaryPanel) glossaryPanel.hidden = !glossaryAllowed;
  // V19 / V21.17: song panels are gated by the 'song' permission; pinned-text
  // sending needs 'main_screen'. With the tabs merged into one panel (V21.17),
  // each song panel carries data-remote-song-section and is hidden individually
  // when the operator lacks 'song' — the old per-tab gating is gone.
  if (songTabBtn) songTabBtn.hidden = !songAllowed;
  if (pinnedTextPanel) pinnedTextPanel.hidden = !mainScreenAllowed;
  document.querySelectorAll('[data-remote-song-section]').forEach((el) => {
    el.hidden = !songAllowed;
  });
  updateHeader();
  populateRemoteLanguageSelects();
  updateRemoteTextScaleDisplay();
  updateRemoteClockControls();  // V21.35: keep clock UI in sync with displayState
  updateRemoteGlossaryMode();
  syncGlossaryToggle();
  renderRemoteSimplePreviews();
  renderRemoteSongState();
  renderRemoteSongLibrary();
  renderRemotePinnedTextLibrary();
  renderRemoteSongHistory();
  renderRemoteWorshipPanel();
  renderRemoteEventSongLibrary();
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

// V21.34: minimal DELETE helper, paralel cu post(). Folosește același
// eventCodeOptions (codul operatorului ajunge tot în body sub `code`,
// pe care server-ul îl citește prin requireEventRole). Throws on !data.ok,
// la fel ca post(). Re-randarea listei după DELETE NU se face aici —
// vine prin socket event:songlibrary_changed (V21.6, remote.js:1022).
async function del(path) {
  const res = await fetch(path, eventCodeOptions('DELETE'));
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Request failed.');
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
  loadRemotePinnedTextLibrary();
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
socket.on('song_history_updated', ({ songHistory }) => {
  if (!state.currentEvent) return;
  state.currentEvent.songHistory = songHistory || [];
  renderRemoteSongHistory();
  renderRemoteSongState();
});
// V21.6: live sync of event.songLibrary — operator sees changes that
// originated on worship / admin without a manual refresh.
socket.on('event:songlibrary_changed', ({ eventId, songLibrary }) => {
  if (!state.currentEvent || state.currentEvent.id !== eventId) return;
  state.currentEvent.songLibrary = Array.isArray(songLibrary) ? songLibrary : [];
  renderRemoteEventSongLibrary();
});
// V21.3: worship-live awareness on the operator side.
socket.on('worship:state_change', (data) => {
  if (!data || data.eventId !== state.eventId) return;
  state.worship.hasState = true;
  state.worship.online = true;
  state.worship.songTitle = data.song ? (data.song.title || '') : '';
  state.worship.verseIndex = data.state ? (data.state.currentVerseIndex || 0) : 0;
  state.worship.ended = !!(data.state && data.state.ended);
  renderRemoteWorshipPanel();
  // V21.8: push-button gating depends on worship online — re-render.
  renderRemoteEventSongLibrary();
  // V21.11: refresh the worship badge on the song blocks.
  renderRemoteSongState();
});
socket.on('worship:master_presence', (data) => {
  if (!data || data.eventId !== state.eventId) return;
  state.worship.online = !!data.online;
  renderRemoteWorshipPanel();
  // V21.8: push buttons in the event-songs panel are gated by worship
  // presence — re-render so they enable/disable in lockstep.
  renderRemoteEventSongLibrary();
  // V21.11: the worship badge hides when worship goes offline.
  renderRemoteSongState();
});
socket.on('worship:sync_request_pending', (data) => {
  if (!data || data.eventId !== state.eventId || !data.request) return;
  state.worship.request = {
    id: data.request.id,
    songTitle: data.songTitle || '',
    verseIndex: data.request.targetVerseIndex || 0
  };
  renderRemoteWorshipPanel();
  // V21.10: also fly the global toast + tab badge so the operator
  // notices even when on another tab.
  showRemoteWorshipGlobalToast(state.worship.request);
  setStatus('Worship cere sync proiector — vezi tab-ul Song.');
});
socket.on('worship:sync_request_resolved', (data) => {
  if (!data) return;
  // V21.3: worship -> projector request the operator just resolved.
  if (state.worship.request && data.requestId === state.worship.request.id) {
    state.worship.request = null;
    renderRemoteWorshipPanel();
    // V21.10: hide toast + clear badge when the request is gone for
    // any reason (resolved here, or resolved from the global toast).
    hideRemoteWorshipGlobalToast();
    clearRemoteSongTabBadge();
    return;
  }
  // V21.8: an operator -> worship push WE sent just got accepted/declined
  // by the worship master. Surface the result so the operator knows.
  if (remotePendingPush && data.requestId === remotePendingPush.id) {
    const songTitle = remotePendingPush.songTitle || 'cântarea';
    remotePendingPush = null;
    setStatus(data.approved
      ? `Worship a acceptat: ${songTitle}.`
      : `Worship a refuzat: ${songTitle}.`);
  }
});

// V21.8: operator pushes a song from the per-event list to the worship
// master. Verse defaults to 0 (the verse-model reconciliation between
// projector and worship lives in the bridge — deferred). Single pending
// push at a time, matched by request id.
let remotePendingPush = null;

// V21.12: load a scheduled song into Live Song Control. staged=true
// uses /song/load {stage:true} (projector untouched); staged=false is
// "Send first verse" (projector switches immediately). post() applies
// the songState from the response and re-renders via refreshRemoteUi.
async function remoteLoadScheduledSong(item, staged) {
  if (!state.eventId || !item) return;
  try {
    await post(`/api/events/${state.eventId}/song/load`, {
      title: item.title || '',
      text: item.text || '',
      labels: item.labels || [],
      sourceLang: item.sourceLang || state.currentEvent?.sourceLang || 'ro',
      stage: !!staged
    });
    setStatus(staged
      ? `"${item.title || 'Cântare'}" încărcată în Live Song Control — alege o strofă pentru proiector.`
      : `"${item.title || 'Cântare'}" — prima strofă e live.`);
  } catch (err) {
    setStatus(err.message);
  }
}

$('remoteEventSongsList')?.addEventListener('click', async (e) => {
  // V21.12: Preview / Load (staged) / Send first verse.
  const previewBtn = e.target.closest('[data-event-song-preview]');
  if (previewBtn) {
    const id = previewBtn.getAttribute('data-event-song-preview');
    document.querySelector(`[data-event-song-preview-text="${CSS.escape(id)}"]`)?.classList.toggle('hidden');
    return;
  }
  const loadBtn = e.target.closest('[data-event-song-load]');
  if (loadBtn) {
    const item = (state.currentEvent?.songLibrary || []).find((s) => s.id === loadBtn.getAttribute('data-event-song-load'));
    if (item) remoteLoadScheduledSong(item, true);
    return;
  }
  const sendBtn = e.target.closest('[data-event-song-send]');
  if (sendBtn) {
    const item = (state.currentEvent?.songLibrary || []).find((s) => s.id === sendBtn.getAttribute('data-event-song-send'));
    if (item) remoteLoadScheduledSong(item, false);
    return;
  }
  // V21.34: Delete — server emits event:songlibrary_changed which the
  // socket listener at line 1022 catches and re-renders the list, so we
  // don't call renderRemoteEventSongLibrary() here.
  const delBtn = e.target.closest('[data-event-song-delete]');
  if (delBtn) {
    const id = delBtn.getAttribute('data-event-song-delete');
    if (!id || !state.eventId) return;
    if (!confirm('Delete this song from the event?')) return;
    try {
      await del(`/api/events/${state.eventId}/song-library/${encodeURIComponent(id)}`);
      setStatus('Removed from event.');
    } catch (err) {
      setStatus(err.message || 'Could not delete.');
    }
    return;
  }
  const btn = e.target.closest('[data-remote-push-worship]');
  if (!btn || btn.disabled) return;
  const songId = btn.getAttribute('data-remote-push-worship');
  const songTitle = btn.parentElement?.querySelector('.event-song-meta strong')?.textContent || '';
  if (!state.eventId || !songId) return;
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '… Trimit';
  try {
    const res = await fetch(`/api/events/${state.eventId}/worship/push`, eventCodeOptions('POST', { songId }));
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || 'Push eșuat.');
    remotePendingPush = { id: data.requestId, songTitle };
    btn.innerHTML = '✓ Trimis';
    setStatus(`Sugestie trimisă worship-ului: ${songTitle}.`);
    setTimeout(() => { btn.disabled = false; btn.innerHTML = originalText; }, 1500);
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = originalText;
    alert('Eroare: ' + err.message);
  }
});

// V21.10: shared resolver for worship sync requests — used by both the
// in-panel buttons (Tab Song) AND the new global toast (visible on any
// tab). Hides the toast + clears the badge on success.
async function resolveRemoteWorshipRequest(action, reqId, songTitle) {
  let body;
  let label;
  if (action === 'note') {
    body = { status: 'noted' };
    label = `Cerere notată — sincronizează manual pe proiector cântarea ${songTitle || 'worship'}.`;
  } else if (action === 'decline') {
    body = { approve: false };
    label = `Cerere worship refuzată: ${songTitle || 'cântare'}.`;
  } else {
    body = { approve: true };
    label = `Cerere worship aprobată: ${songTitle || 'cântare'}.`;
  }
  try {
    const res = await fetch(
      `/api/events/${state.eventId}/worship/sync-request/${reqId}/resolve`,
      eventCodeOptions('POST', body)
    );
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Acțiune eșuată.');
    state.worship.request = null;
    renderRemoteWorshipPanel();
    hideRemoteWorshipGlobalToast();
    clearRemoteSongTabBadge();
    setStatus(label);
  } catch (err) {
    setStatus(err.message);
  }
}

// V21.10: global toast (visible from any tab) + Song-tab dot badge.
function showRemoteWorshipGlobalToast(request) {
  const toast = $('worshipGlobalToast');
  if (!toast) return;
  const detail = $('worshipGlobalToastDetail');
  if (detail) {
    detail.textContent = `${request.songTitle || 'cântare'} · strofa ${(request.verseIndex || 0) + 1} — sincronizezi manual pe proiector după.`;
  }
  toast.dataset.requestId = request.id;
  toast.dataset.songTitle = request.songTitle || '';
  toast.classList.remove('hidden');
  setRemoteSongTabBadge(true);
}
function hideRemoteWorshipGlobalToast() {
  const toast = $('worshipGlobalToast');
  if (toast) toast.classList.add('hidden');
}
function setRemoteSongTabBadge(visible) {
  const badge = $('remoteSongTabBadge');
  if (badge) badge.classList.toggle('hidden', !visible);
}
function clearRemoteSongTabBadge() { setRemoteSongTabBadge(false); }

$('remoteWorshipRequest')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-worship-req]');
  if (!btn || !state.worship.request) return;
  const action = btn.getAttribute('data-worship-req');
  const reqId = state.worship.request.id;
  const songTitle = state.worship.request.songTitle || 'cântare';
  resolveRemoteWorshipRequest(action, reqId, songTitle);
});

// V21.10: global toast click handlers (note / decline / close).
$('worshipGlobalToast')?.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-worship-toast-action]');
  if (!btn) return;
  const action = btn.getAttribute('data-worship-toast-action');
  const toast = $('worshipGlobalToast');
  if (action === 'close') {
    // Just hide the toast — the request stays pending; the badge keeps
    // signalling that something needs attention in Tab Song.
    hideRemoteWorshipGlobalToast();
    return;
  }
  const reqId = toast?.dataset.requestId;
  const songTitle = toast?.dataset.songTitle || '';
  if (!reqId) return;
  resolveRemoteWorshipRequest(action, reqId, songTitle);
});

// V21.10: clicking the Song tab clears the unread badge (user has
// presumably noticed the request inside the in-panel UI).
$('remoteSongTabBtn')?.addEventListener('click', () => clearRemoteSongTabBadge());
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
  // V21.26: parity with admin (app.js setDisplayModeWithConfirmation) —
  // putting Live Text on Main Screen is unusual; warn before doing it.
  // Same text, same condition (mode === 'auto' / Live follow). Song and
  // pinned-text modes are NOT gated (mirrors admin behavior).
  const confirmed = window.confirm(
    'Live Text on Main Screen is unusual.\n\n' +
    'Main Screen is typically for Song display.\n\n' +
    'Are you sure you want to show Live Text on the projector?'
  );
  if (!confirmed) return;
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

function updateRemoteTextScaleDisplay() {
  const scale = Number(state.currentEvent?.displayState?.textScale || 1);
  const display = $('remoteTextScaleValue');
  if (display) display.textContent = `${Math.round(scale * 100)}%`;
}

async function setRemoteTextScale(newScale) {
  if (!state.eventId) return;
  const safeScale = Math.min(1.4, Math.max(0.65, Number(newScale) || 1));
  try {
    const data = await post(`/api/events/${state.eventId}/display/text`, { textScale: safeScale });
    if (!data.ok) {
      setStatus(data.error || 'Could not change text size.');
      return;
    }
    if (state.currentEvent) state.currentEvent.displayState = data.displayState || state.currentEvent.displayState;
    updateRemoteTextScaleDisplay();
    setStatus(`Text scale: ${Math.round(safeScale * 100)}%`);
  } catch (err) {
    setStatus(err.message || 'Could not change text size.');
  }
}

// V21.35: clock controls mirror admin (showClock + clockPosition + clockScale).
// All ride the same /display/text endpoint as text zoom.
function updateRemoteClockControls() {
  const ds = state.currentEvent?.displayState || {};
  if ($('remoteShowClockBox')) $('remoteShowClockBox').checked = !!ds.showClock;
  if ($('remoteClockPositionSelect')) $('remoteClockPositionSelect').value = ds.clockPosition || 'top-right';
  const scale = Number(ds.clockScale || 1);
  if ($('remoteClockScaleValue')) $('remoteClockScaleValue').textContent = `${Math.round(scale * 100)}%`;
}

async function setRemoteClockScale(newScale) {
  if (!state.eventId) return;
  // Server validates clockScale 0.7-1.8 (routes/events.js:1297). Admin clamps
  // to 2.5 — latent bug there, NOT fixed here. We clamp to the server limits
  // so the operator's buttons never produce a 400.
  const safe = Math.min(1.8, Math.max(0.7, Math.round(Number(newScale) * 10) / 10));
  try {
    const data = await post(`/api/events/${state.eventId}/display/text`, { clockScale: safe });
    if (!data.ok) {
      setStatus(data.error || 'Could not change clock size.');
      return;
    }
    if (state.currentEvent) state.currentEvent.displayState = data.displayState || state.currentEvent.displayState;
    updateRemoteClockControls();
    setStatus(`Clock size: ${Math.round(safe * 100)}%`);
  } catch (err) {
    setStatus(err.message || 'Could not change clock size.');
  }
}

async function setRemoteTextSize(textSize) {
  if (!state.eventId) return;
  if (!['compact', 'large', 'xlarge', 'huge'].includes(textSize)) return;
  try {
    const data = await post(`/api/events/${state.eventId}/display/text`, { textSize });
    if (!data.ok) {
      setStatus(data.error || 'Could not change text size.');
      return;
    }
    if (state.currentEvent) state.currentEvent.displayState = data.displayState || state.currentEvent.displayState;
    setStatus(`Text size: ${textSize}`);
  } catch (err) {
    setStatus(err.message || 'Could not change text size.');
  }
}

$('remoteTextZoomMinusBtn')?.addEventListener('click', () => {
  const current = Number(state.currentEvent?.displayState?.textScale || 1);
  setRemoteTextScale(Math.round((current - 0.1) * 20) / 20);
});

$('remoteTextZoomPlusBtn')?.addEventListener('click', () => {
  const current = Number(state.currentEvent?.displayState?.textScale || 1);
  setRemoteTextScale(Math.round((current + 0.1) * 20) / 20);
});

$('remoteTextZoomResetBtn')?.addEventListener('click', () => {
  setRemoteTextScale(1);
});

$('remoteTextSizeMoreBtn')?.addEventListener('click', () => {
  const panel = $('remoteTextSizeMorePanel');
  const btn = $('remoteTextSizeMoreBtn');
  if (panel && btn) {
    const isHidden = panel.hasAttribute('hidden');
    if (isHidden) {
      panel.removeAttribute('hidden');
      btn.textContent = 'More ▴';
    } else {
      panel.setAttribute('hidden', '');
      btn.textContent = 'More ▾';
    }
  }
});

document.querySelectorAll('.remote-text-size-preset').forEach((btn) => {
  btn.addEventListener('click', () => {
    const size = btn.dataset.textSize;
    if (size) setRemoteTextSize(size);
  });
});

// V21.35: clock controls — paralel cu text zoom bindings.
$('remoteShowClockBox')?.addEventListener('change', async () => {
  if (!state.eventId) return;
  const showClock = !!$('remoteShowClockBox').checked;
  try {
    const data = await post(`/api/events/${state.eventId}/display/text`, { showClock });
    if (state.currentEvent && data.displayState) state.currentEvent.displayState = data.displayState;
    setStatus(`Clock ${showClock ? 'shown' : 'hidden'}.`);
  } catch (err) {
    setStatus(err.message || 'Could not toggle clock.');
  }
});
$('remoteClockPositionSelect')?.addEventListener('change', async () => {
  if (!state.eventId) return;
  const clockPosition = $('remoteClockPositionSelect').value;
  try {
    const data = await post(`/api/events/${state.eventId}/display/text`, { clockPosition });
    if (state.currentEvent && data.displayState) state.currentEvent.displayState = data.displayState;
    setStatus(`Clock position: ${clockPosition}.`);
  } catch (err) {
    setStatus(err.message || 'Could not move clock.');
  }
});
$('remoteClockSizeMinusBtn')?.addEventListener('click', () => {
  const current = Number(state.currentEvent?.displayState?.clockScale || 1);
  setRemoteClockScale(current - 0.1);
});
$('remoteClockSizePlusBtn')?.addEventListener('click', () => {
  const current = Number(state.currentEvent?.displayState?.clockScale || 1);
  setRemoteClockScale(current + 0.1);
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

// V21.17-FIX: quick clipboard copy for the two worship links the operator hands
// to leaders + team. Worship master = /worship (PIN gate); team permanent view
// = /worship-view (V21.18 — own PIN gate, no token needed). Falls back to a
// prompt-like alert if the Clipboard API is unavailable (insecure context).
function copyWorshipLink(path, label, btn) {
  const url = window.location.origin + path;
  const flashOk = () => {
    setStatus(`Link ${label} copiat: ${url}`);
    if (btn) {
      const original = btn.textContent;
      btn.textContent = '✓ Copiat';
      btn.disabled = true;
      setTimeout(() => {
        btn.textContent = original;
        btn.disabled = false;
      }, 1500);
    }
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(url).then(flashOk).catch(() => {
      window.prompt(`Copiază manual linkul ${label}:`, url);
    });
  } else {
    window.prompt(`Copiază manual linkul ${label}:`, url);
  }
}

$('remoteCopyWorshipLink')?.addEventListener('click', (e) => {
  copyWorshipLink('/worship', 'worship', e.currentTarget);
});

$('remoteCopyTeamLink')?.addEventListener('click', (e) => {
  copyWorshipLink('/worship-view', 'team', e.currentTarget);
});

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

document.querySelectorAll('.top-nav-btn[data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => switchRemoteTab(btn.dataset.tab));
});

let remoteLibrarySearchDebounce;
$('remoteSongLibrarySearch')?.addEventListener('input', () => {
  clearTimeout(remoteLibrarySearchDebounce);
  remoteLibrarySearchDebounce = setTimeout(renderRemoteSongLibrary, 220);
  // Resurse results are stale once the query changes — hide until re-run.
  document.querySelector('.unified-search-resurse-section')?.classList.add('hidden');
});
// V21.39: select-all on focus so re-tap replaces the previous query in one keypress.
// setTimeout(0) sidesteps mouseup-deselect when the focus arrived via click.
$('remoteSongLibrarySearch')?.addEventListener('focus', (e) => {
  setTimeout(() => { try { e.target.select(); } catch (_) {} }, 0);
});
$('remoteSongLibrarySort')?.addEventListener('change', renderRemoteSongLibrary);
$('remoteManualLibrarySearch')?.addEventListener('input', renderRemotePinnedTextLibrary);
$('remoteManualLibrarySort')?.addEventListener('change', renderRemotePinnedTextLibrary);

$('remoteSongLibraryList')?.addEventListener('click', async (e) => {
  if (e.target.closest('.library-card-summary')) return;
  const btn = e.target.closest('button[data-remote-song-action]');
  if (!btn) return;
  const action = btn.getAttribute('data-remote-song-action');
  const songId = btn.getAttribute('data-remote-song-id');
  const item = (state.globalSongLibrary || []).find((entry) => entry.id === songId);
  if (!item) return;
  if (action === 'preview') {
    const previewEl = document.querySelector(`[data-remote-song-preview="${songId}"]`);
    if (previewEl) {
      previewEl.classList.toggle('hidden');
      btn.textContent = previewEl.classList.contains('hidden') ? 'Preview' : 'Hide preview';
    }
    return;
  }
  if (action === 'load') {
    fillRemoteSongEditor(item);
    setStatus('Loaded from church library into the editor.');
    // V21.39: clear the search field after a successful action so the next
    // search starts fresh (admin already does this via clearLibrarySearch).
    const sEl = $('remoteSongLibrarySearch'); if (sEl) { sEl.value = ''; renderRemoteSongLibrary(); }
    return;
  }
  // SONG-LIBRARY-LOAD-BTN — încarcă în Live Control (staged), fără să afișeze pe proiector.
  if (action === 'stage') {
    await remoteLoadScheduledSong(item, true);
    return;
  }
  if (action === 'send') {
    try {
      await post(`/api/events/${state.eventId}/song/load`, {
        title: item.title || '',
        text: item.text || '',
        labels: item.labels || [],
        sourceLang: item.sourceLang || state.currentEvent?.sourceLang || 'ro'
      });
      btn.closest('.library-card-details')?.removeAttribute('open');
      setStatus('Song loaded from church library — first verse is live.');
      // V21.39: clear search after success (mirror admin clearLibrarySearch).
      const sEl = $('remoteSongLibrarySearch'); if (sEl) { sEl.value = ''; renderRemoteSongLibrary(); }
    } catch (err) {
      setStatus(err.message);
    }
    return;
  }
  if (action === 'add') {
    if (!state.eventId) return setStatus('No live event connected.');
    try {
      const res = await fetch(
        `/api/events/${state.eventId}/global-song-library/${songId}/add-to-event`,
        eventCodeOptions('POST', { targetEventId: state.eventId })
      );
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Could not add song to event.');
      setStatus(`Added "${item.title || 'song'}" to this event's song library.`);
      // V21.39: clear search after success (mirror admin clearLibrarySearch).
      const sEl = $('remoteSongLibrarySearch'); if (sEl) { sEl.value = ''; renderRemoteSongLibrary(); }
    } catch (err) {
      setStatus(err.message);
    }
  }
});

$('remoteManualLibraryList')?.addEventListener('click', async (e) => {
  if (e.target.closest('.library-card-summary')) return;
  const btn = e.target.closest('button[data-remote-pinned-action]');
  if (!btn) return;
  const action = btn.getAttribute('data-remote-pinned-action');
  const itemId = btn.getAttribute('data-remote-pinned-id');
  const item = (state.pinnedTextLibrary || []).find((entry) => entry.id === itemId);
  if (!item) return;
  if (action === 'preview') {
    const previewEl = document.querySelector(`[data-remote-pinned-preview="${itemId}"]`);
    if (previewEl) {
      previewEl.classList.toggle('hidden');
      btn.textContent = previewEl.classList.contains('hidden') ? 'Preview' : 'Hide preview';
    }
    return;
  }
  if (action === 'load') {
    if ($('remotePinnedTitle')) $('remotePinnedTitle').value = item.title || '';
    if ($('remotePinnedText')) $('remotePinnedText').value = item.text || '';
    if ($('remotePinnedSourceLang')) {
      $('remotePinnedSourceLang').value = item.sourceLang || state.currentEvent?.sourceLang || 'ro';
    }
    setStatus('Pinned text loaded into the editor.');
    return;
  }
  if (action === 'send') {
    try {
      await post(`/api/events/${state.eventId}/display/manual`, {
        title: item.title || '',
        text: item.text || '',
        sourceLang: item.sourceLang || state.currentEvent?.sourceLang || 'ro'
      });
      setStatus('Pinned text sent to the main screen.');
    } catch (err) {
      setStatus(err.message);
    }
  }
});

$('remotePinnedSendBtn')?.addEventListener('click', async () => {
  const title = $('remotePinnedTitle')?.value.trim() || '';
  const text = $('remotePinnedText')?.value.trim() || '';
  const sourceLang = $('remotePinnedSourceLang')?.value || state.currentEvent?.sourceLang || 'ro';
  if (!text) return setStatus('Add pinned text first.');
  try {
    await post(`/api/events/${state.eventId}/display/manual`, { title, text, sourceLang });
    setStatus('Pinned text sent to the main screen.');
  } catch (err) {
    setStatus(err.message);
  }
});

$('remoteSongBlocksList')?.addEventListener('click', async (e) => {
  const extendBtn = e.target.closest('[data-remote-song-block-extend]');
  if (extendBtn) {
    e.preventDefault();
    e.stopPropagation();
    const idx = extendBtn.dataset.remoteSongBlockExtend;
    const fullEl = document.querySelector(`[data-remote-song-block-full="${idx}"]`);
    if (fullEl) {
      const hidden = fullEl.hasAttribute('hidden');
      if (hidden) {
        fullEl.removeAttribute('hidden');
        extendBtn.textContent = '▴';
      } else {
        fullEl.setAttribute('hidden', '');
        extendBtn.textContent = '▾';
      }
    }
    return;
  }
  const btn = e.target.closest('button[data-remote-song-block-index]');
  if (!btn) return;
  const index = Number(btn.getAttribute('data-remote-song-block-index'));
  if (!Number.isInteger(index)) return;
  try {
    await post(`/api/events/${state.eventId}/song/show/${index}`);
    setStatus('Selected verse sent live.');
  } catch (err) {
    setStatus(err.message);
  }
});

$('remoteSongClearLiveBtn')?.addEventListener('click', async () => {
  try {
    await post(`/api/events/${state.eventId}/song/clear`);
    setStatus('Song cleared from the main screen.');
  } catch (err) {
    setStatus(err.message);
  }
});

$('remoteSongBlackBtn')?.addEventListener('click', async () => {
  try {
    await post(`/api/events/${state.eventId}/display/blank`);
    setStatus('Main screen set to black screen.');
  } catch (err) {
    setStatus(err.message);
  }
});

function openRemoteEditVerseModal() {
  const songState = state.currentEvent?.songState;
  if (!songState || !songState.activeBlock) {
    setStatus('No active verse to edit.');
    return;
  }
  if ($('remoteEditVerseText')) $('remoteEditVerseText').value = songState.activeBlock;
  const modal = $('remoteEditVerseModal');
  if (modal) modal.hidden = false;
  setTimeout(() => $('remoteEditVerseText')?.focus(), 50);
}

function closeRemoteEditVerseModal() {
  const modal = $('remoteEditVerseModal');
  if (modal) modal.hidden = true;
}

async function saveRemoteEditedVerse(updateLibrary) {
  const newText = $('remoteEditVerseText')?.value.trim() || '';
  if (!newText) return setStatus('Verse text cannot be empty.');
  if (updateLibrary && !window.confirm(
    'This will update the original song in the church library permanently. Continue?'
  )) return;
  try {
    const res = await fetch(`/api/events/${state.eventId}/song/edit-active-block`, eventCodeOptions('POST', {
      newText,
      updateLibrary: !!updateLibrary
    }));
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Could not save edited verse.');
    if (data.event) state.currentEvent = data.event;
    if (data.songState && state.currentEvent) state.currentEvent.songState = data.songState;
    if (Array.isArray(data.globalSongLibrary)) state.globalSongLibrary = data.globalSongLibrary;
    closeRemoteEditVerseModal();
    refreshRemoteUi();
    renderRemoteSongLibrary();
    setStatus(updateLibrary ? 'Verse updated and saved to the library.' : 'Verse updated for this event.');
  } catch (err) {
    setStatus(err.message);
  }
}

$('remoteEditLiveVerseBtn')?.addEventListener('click', openRemoteEditVerseModal);
$('remoteCancelEditVerseBtn')?.addEventListener('click', closeRemoteEditVerseModal);
$('remoteSaveEditVerseBtn')?.addEventListener('click', () => saveRemoteEditedVerse(false));
$('remoteSaveEditVerseLibraryBtn')?.addEventListener('click', () => saveRemoteEditedVerse(true));
document.querySelectorAll('[data-remote-edit-verse-close]').forEach((el) => {
  el.addEventListener('click', closeRemoteEditVerseModal);
});

async function importRemoteSongFromUrl(url) {
  const res = await fetch('/api/songs/import-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, code: state.accessCode, eventId: state.eventId })
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || 'Import failed');
  const dup = findDuplicateRemoteLibrarySong(data.song.title);
  if (dup) {
    const ok = window.confirm(
      `Cântarea există deja în Library: "${dup.title}".\n\nContinui oricum și suprascrii editorul?`
    );
    if (!ok) {
      const err = new Error(`Anulat — cântarea există deja: "${dup.title}"`);
      err.cancelled = true;
      throw err;
    }
  }
  if ($('remoteSongTitle') && data.song.title) $('remoteSongTitle').value = data.song.title;
  if ($('remoteSongText') && data.song.text) $('remoteSongText').value = data.song.text;
  return data.song;
}

// V21.15: the unified search field is #remoteSongLibrarySearch. Library
// filtering is instant on input; this resurse search runs only on Enter or
// the "Caută și pe resurse" button so external requests stay rate-light.
$('remoteImportUrlBtn')?.addEventListener('click', async () => {
  const input = $('remoteSongLibrarySearch');
  const status = $('remoteImportUrlStatus');
  const resultsEl = $('remoteImportUrlResults');
  const btn = $('remoteImportUrlBtn');
  const resurseSection = document.querySelector('.unified-search-resurse-section');
  const spinner = document.querySelector('.unified-search-spinner');
  const value = (input?.value || '').trim();
  if (!value) {
    if (status) {
      status.textContent = 'Introdu un URL sau cuvinte cheie pentru căutare.';
      status.style.color = '#f80';
    }
    return;
  }
  const isUrl = /^https?:\/\//i.test(value);
  if (resurseSection) resurseSection.classList.remove('hidden');
  if (spinner) spinner.classList.remove('hidden');
  if (status) {
    status.textContent = isUrl ? 'Se importă...' : 'Se caută pe resurse...';
    status.style.color = '';
  }
  if (resultsEl) resultsEl.innerHTML = '';
  if (btn) btn.disabled = true;
  try {
    if (isUrl) {
      const song = await importRemoteSongFromUrl(value);
      if (status) {
        status.textContent = `Importat: "${song.title}" (${song.sourceProvider || 'URL'})`;
        status.style.color = '#0c0';
      }
    } else {
      const res = await fetch('/api/songs/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: value, code: state.accessCode, eventId: state.eventId })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Search failed');
      if (!data.results || !data.results.length) {
        if (status) {
          status.textContent = `Niciun rezultat pentru "${value}".`;
          status.style.color = '#f80';
        }
        return;
      }
      if (status) {
        status.textContent = `${data.results.length} rezultate pentru "${value}":`;
        status.style.color = '#0c0';
      }
      if (resultsEl) {
        resultsEl.innerHTML = data.results.map((item) => `
          <div class="import-result-row" style="display:flex; gap:8px; align-items:center; padding:6px 8px; border-bottom:1px solid rgba(255,255,255,0.08);">
            <div style="flex:1; min-width:0;">
              <div style="font-weight:600;">${escapeHtml(item.title)}</div>
              <div class="muted small">${escapeHtml(item.author || 'Anonim')}</div>
            </div>
            <button class="btn btn-dark" type="button" data-remote-import-result-url="${escapeHtml(item.url)}">Import</button>
          </div>
        `).join('');
      }
    }
  } catch (err) {
    if (status) {
      if (err.cancelled) {
        status.textContent = err.message;
        status.style.color = '#f80';
      } else {
        status.textContent = `Eroare: ${err.message}`;
        status.style.color = '#f00';
      }
    }
  } finally {
    if (btn) btn.disabled = false;
    if (spinner) spinner.classList.add('hidden');
  }
});

// V21.15: Enter on the unified search field fires the resurse search.
$('remoteSongLibrarySearch')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('remoteImportUrlBtn')?.click();
    setTimeout(() => { try { e.target.select(); } catch (_) {} }, 0);  // V21.40: select query after search
  }
});

$('remoteImportUrlResults')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-remote-import-result-url]');
  if (!btn) return;
  const url = btn.dataset.remoteImportResultUrl;
  const status = $('remoteImportUrlStatus');
  const resultsEl = $('remoteImportUrlResults');
  if (status) {
    status.textContent = 'Se importă rezultatul selectat...';
    status.style.color = '';
  }
  btn.disabled = true;
  btn.textContent = '...';
  try {
    const song = await importRemoteSongFromUrl(url);
    if (status) {
      status.textContent = `Importat: "${song.title}"`;
      status.style.color = '#0c0';
    }
    if (resultsEl) resultsEl.innerHTML = '';
  } catch (err) {
    if (status) {
      if (err.cancelled) {
        status.textContent = err.message;
        status.style.color = '#f80';
      } else {
        status.textContent = `Eroare la import: ${err.message}`;
        status.style.color = '#f00';
      }
    }
    btn.disabled = false;
    btn.textContent = 'Import';
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
  loadRemotePinnedTextLibrary();
  await join();
});

window.addEventListener('beforeunload', () => {
  if (state.liveAudio.running && state.eventId) {
    socket.emit('azure_audio_stop', { eventId: state.eventId });
  }
});

// V21.19: register the operator service worker for PWA installability.
// Scope `/remote` keeps it isolated from push-sw.js (scope /, used by
// /participant) and worship-sw.js (scope /worship). Shell-only cache —
// live state arrives over Socket.IO and is never cached.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/remote-sw.js', { scope: '/remote' })
      .catch((err) => console.warn('remote SW registration failed:', err && err.message));
  });
}
