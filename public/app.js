const socket = io();
const $ = (id) => document.getElementById(id);

let currentEvent = null;
let currentGlobalSongLibrary = [];
let availableEventsList = [];
let currentVolume = 70;
let currentMuted = false;
let selectedEntryId = null;
let sourceEditLock = false;
let activeTab = 'dashboard';
let lastManualEnterAt = 0;
let screenWakeLock = null;
window.isRecognitionRunning = false;
let availableLanguages = {};

let audioState = {
  stream: null,
  context: null,
  source: null,
  gainNode: null,
  preampNode: null,
  analyser: null,
  destination: null,
  meterFrame: null,
  recorder: null,
  running: false,
  busy: false,
  uploadQueue: [],
  chunks: [],
  chunkTimer: null,
  mimeType: '',
  monitorGainNode: null,
  monitorEnabled: false
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

function setOnAirState(isOn) {
  const badge = $('onAirBadge');
  if (!badge) return;
  badge.textContent = isOn ? 'On-Air' : 'Off-Air';
  badge.className = isOn ? 'status-pill active' : 'status-pill';
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
  $('songModeBadge').textContent = isSongMode ? 'Song mode live' : (event.displayState?.mode === 'manual' ? 'Pinned text live' : 'Live follow');
  $('songModeBadge').className = (isSongMode || event.displayState?.mode === 'manual') ? 'status-pill active' : 'status-pill';
}

function refreshDisplayControls() {
  const modeLabel = $('displayModeLabel');
  const themeSelect = $('displayThemeSelect');
  const languageSelect = $('displayLanguageSelect');
  const backgroundPresetSelect = $('displayBackgroundPresetSelect');
  const backgroundInput = $('displayBackgroundInput');
  const showClockBox = $('displayShowClockBox');
  const clockPositionSelect = $('displayClockPositionSelect');
  const textSizeSelect = $('displayTextSizeSelect');
  const screenStyleSelect = $('displayScreenStyleSelect');
  if (modeLabel) {
    const modeMap = {
      auto: 'Live follow',
      manual: 'Pinned text',
      song: 'Song'
    };
    const modeText = currentEvent?.displayState?.blackScreen
      ? 'Black screen'
      : (modeMap[currentEvent?.displayState?.mode] || 'Live follow');
    const themeText = currentEvent?.displayState?.theme === 'light' ? 'Black on white' : 'White on black';
    modeLabel.textContent = `Main screen: ${modeText} · Theme: ${themeText}`;
  }
  if (themeSelect) {
    themeSelect.value = currentEvent?.displayState?.theme || 'dark';
  }
  if (languageSelect) {
    const langs = currentEvent?.targetLangs || [];
    languageSelect.innerHTML = langs.map((lang) => `<option value="${lang}">${escapeHtml(langLabel(lang))}</option>`).join('');
    languageSelect.value = currentEvent?.displayState?.language || langs[0] || 'no';
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
  if (textSizeSelect) {
    textSizeSelect.value = currentEvent?.displayState?.textSize || 'large';
  }
  if (screenStyleSelect) {
    screenStyleSelect.value = currentEvent?.displayState?.screenStyle || 'focus';
  }
}

function getSongEditorLabels() {
  return Array.from(document.querySelectorAll('[data-song-label-input]')).map((input, index) => {
    const value = String(input.value || '').trim();
    return value || `Verse ${index + 1}`;
  });
}

function splitSongBlocksLocal(text) {
  return String(text || '')
    .split(/\n\s*\n/)
    .map((block) => block.split('\n').map((line) => line.trim()).filter(Boolean).join('\n'))
    .map((block) => block.trim())
    .filter(Boolean);
}

function renderParticipantStats(stats = {}) {
  const uniqueCount = Number(stats.uniqueCount || stats.total || 0);
  const languages = Array.isArray(stats.languages) ? stats.languages : Object.entries(stats.byLanguage || {}).map(([lang, count]) => ({ lang, count }));
  $('participantStatsSummary').textContent = uniqueCount === 1 ? '1 unique participant' : `${uniqueCount} unique participants`;
  $('participantStatsList').innerHTML = languages.length
    ? languages.map((item) => `<div class="history-item">${escapeHtml(langLabel(item.lang))}: ${item.count}</div>`).join('')
    : '<div class="muted">No connected participant.</div>';
}

function resetParticipantStats() {
  renderParticipantStats({ uniqueCount: 0, languages: [] });
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
  const targetBox = $('targetLangList');
  sourceSelect.innerHTML = '';
  targetBox.innerHTML = '';
  Object.entries(availableLanguages).forEach(([code, label]) => {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = label;
    if (code === 'ro') option.selected = true;
    sourceSelect.appendChild(option);

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
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  };
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

function downloadQr() {
  const src = $('qrImage')?.src;
  if (!src) return;
  const a = document.createElement('a');
  a.href = src;
  a.download = `bpms-qr-${Date.now()}.png`;
  a.click();
}

function buildScheduledAt() {
  const date = $('eventDate')?.value;
  const time = $('eventTime')?.value;
  if (!date) return null;
  return time ? `${date}T${time}:00` : `${date}T00:00:00`;
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
    card.innerHTML = `
      <div class="event-card-head"><div class="event-name">${escapeHtml(event.name || 'New event')}</div><div class="mini-badge">${event.mode || 'live'}</div></div>
      <div class="muted">Scheduled: ${escapeHtml(formatDateTime(event.scheduledAt || event.createdAt))}</div>
      <div class="muted">Languages: ${escapeHtml(langs || '-')}</div>
      <div class="muted">Texts: ${event.transcriptCount || 0}</div>
      <div class="button-row compact">
        <button class="btn btn-dark" data-action="open" data-id="${event.id}">Open</button>
        <button class="btn btn-dark" data-action="activate" data-id="${event.id}">Set live</button>
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

async function syncSpeedToEvent() {
  if (!currentEvent) return;
  const speed = $('speed').value || 'balanced';
  const res = await fetch(`/api/events/${currentEvent.id}/settings`, adminJsonOptions('POST', { speed }));
  const data = await res.json();
  if (data.ok) currentEvent = data.event;
}

function populateEventLinks() {
  if (!currentEvent) return;
  $('adminCode').textContent = currentEvent.adminCode || '-';
  $('participantLink').value = currentEvent.participantLink || '';
  $('translateLink').value = currentEvent.translateLink || '';
  $('qrImage').src = currentEvent.qrCodeDataUrl || '';
}


function renderSongStateLegacy(songState) {
  if (true) return;
  const libraryCount = Array.isArray(currentGlobalSongLibrary) ? currentGlobalSongLibrary.length : 0;
  const historyCount = Array.isArray(currentEvent?.songHistory) ? currentEvent.songHistory.length : 0;
  $('songCurrentIndex').textContent = `Saved: ${libraryCount} · History: ${historyCount}`;
  $('songPreview').textContent = currentEvent?.displayState?.manualSource || 'Song mode text will appear here.';
  $('songBlocksList').innerHTML = '<div class="muted">Use Save in library or Send first verse live.</div>';
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

  summaryEl.textContent = `Saved: ${libraryCount} · History: ${historyCount}`;
  previewEl.textContent = activeBlock || currentEvent?.displayState?.manualSource || 'Song mode text will appear here.';

  if (!blocks.length) {
    blocksEl.innerHTML = '<div class="muted">Use Save in library or Send first verse live.</div>';
    return;
  }

  blocksEl.innerHTML = blocks.map((block, index) => {
    const activeClass = index === currentIndex ? ' active' : '';
    const label = escapeHtml(labels[index] || `Verse ${index + 1}`);
    return `
      <div class="history-item${activeClass}">
        <input class="song-block-label-input" data-song-label-input="${index}" type="text" value="${label}">
        <button class="btn btn-dark" type="button" data-song-block-index="${index}">Show on screen</button>
        <div class="small">${escapeHtmlWithBreaks(block)}</div>
      </div>
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
  const previewBlocks = splitSongBlocksLocal(item?.text || '');
  renderSongState({
    title: item?.title || '',
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
  if (!title || !text) return alert('Complete title and text first.');
  const res = await fetch('/api/global-song-library', globalJsonOptions('POST', { title, text, labels }));
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
  if (!text) return alert('Write text first.');
  const res = await fetch(`/api/events/${currentEvent.id}/song/load`, adminJsonOptions('POST', { title, text, labels }));
  const data = await res.json();
  if (!data.ok) return alert(data.error || 'Could not start verse mode.');
  currentEvent = data.event || currentEvent;
  currentEvent.songState = data.songState || currentEvent.songState;
  renderActiveEventBadge(currentEvent);
  renderSongState(currentEvent.songState || {});
  setStatus('First verse is now on screen. Use Previous/Next for the rest.');
}

async function sendSongToLive() {
  await sendSongItemToLive({
    title: $('songTitle').value.trim(),
    text: $('songText').value.trim()
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
    return alert('Start Song mode first so there is an active verse on screen.');
  }
  const res = await fetch(`/api/events/${currentEvent.id}/display/mode`, adminJsonOptions('POST', { mode }));
  const data = await res.json();
  if (!data.ok) return alert(data.error || 'Could not change display mode.');
  if (data.event) {
    currentEvent = data.event;
  }
  currentEvent.displayState = data.displayState || currentEvent.displayState;
  refreshDisplayControls();
  renderActiveEventBadge(currentEvent);
  const statusMap = {
    auto: 'Main screen switched to live follow.',
    manual: 'Main screen switched to pinned text.',
    song: 'Main screen switched to Song mode.'
  };
  setStatus(statusMap[mode] || 'Main screen mode updated.');
}

async function setDisplayTheme(theme) {
  if (!currentEvent) return;
  const res = await fetch(`/api/events/${currentEvent.id}/display/theme`, adminJsonOptions('POST', { theme }));
  const data = await res.json();
  if (!data.ok) return alert(data.error || 'Could not change display theme.');
  currentEvent.displayState = data.displayState || currentEvent.displayState;
  refreshDisplayControls();
  setStatus(theme === 'light' ? 'Display theme set to black on white.' : 'Display theme set to white on black.');
}

async function setDisplayLanguage(language) {
  if (!currentEvent) return;
  const res = await fetch(`/api/events/${currentEvent.id}/display/language`, adminJsonOptions('POST', { language }));
  const data = await res.json();
  if (!data.ok) return alert(data.error || 'Could not change screen language.');
  currentEvent.displayState = data.displayState || currentEvent.displayState;
  refreshDisplayControls();
  setStatus('Main screen language updated.');
}

async function saveDisplaySettings() {
  if (!currentEvent) return alert('Open or create an event first.');
  const backgroundPreset = $('displayBackgroundPresetSelect').value;
  const customBackground = $('displayBackgroundInput').value.trim();
  const showClock = !!$('displayShowClockBox').checked;
  const clockPosition = $('displayClockPositionSelect').value;
  const textSize = $('displayTextSizeSelect').value;
  const screenStyle = $('displayScreenStyleSelect').value;
  const res = await fetch(`/api/events/${currentEvent.id}/display/settings`, adminJsonOptions('POST', {
    backgroundPreset,
    customBackground,
    showClock,
    clockPosition,
    textSize,
    screenStyle
  }));
  const data = await res.json();
  if (!data.ok) return alert(data.error || 'Could not save main screen settings.');
  currentEvent.displayState = data.displayState || currentEvent.displayState;
  refreshDisplayControls();
  setStatus('Main screen settings saved.');
}

async function blankMainScreen() {
  if (!currentEvent) return alert('Open or create an event first.');
  const res = await fetch(`/api/events/${currentEvent.id}/display/blank`, adminJsonOptions('POST'));
  const data = await res.json();
  if (!data.ok) return alert(data.error || 'Could not blank main screen.');
  currentEvent = data.event || currentEvent;
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
  openPreviewWindow(url, 'bpmsMainPreview', 'width=1500,height=920,resizable=yes,scrollbars=yes');
}

function openParticipantPreviewWindow() {
  const url = $('participantLink')?.value || '/participant';
  openPreviewWindow(url, 'bpmsParticipantPreview', 'width=520,height=920,resizable=yes,scrollbars=yes');
}

function openBothPreviewWindows() {
  const mainUrl = $('translateLink')?.value || '/translate';
  const participantUrl = $('participantLink')?.value || '/participant';
  const previewWindow = window.open('', 'bpmsDualPreview', 'width=1680,height=980,resizable=yes,scrollbars=yes');
  if (!previewWindow) return;
  previewWindow.document.open();
  previewWindow.document.write(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BPMS Dual Preview</title>
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
        <div class="title">BPMS Live Preview Workspace</div>
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
  const res = await fetch(`/api/events/${eventId}`);
  const data = await res.json();
  if (!data.ok) return;
  currentEvent = data.event;
  populateEventLinks();
  $('speed').value = currentEvent.speed || 'balanced';
  currentVolume = currentEvent.audioVolume;
  currentMuted = currentEvent.audioMuted;
  $('volumeRange').value = String(currentVolume);
  $('transcriptList').innerHTML = '';
  (currentEvent.transcripts || []).forEach(renderEntry);
  fillGlossaryLangs(currentEvent.targetLangs || []);
  renderActiveEventBadge(currentEvent);
  renderSongState(currentEvent.songState || {});
  refreshDisplayControls();
  renderSongHistory(currentEvent.songHistory || []);
  await loadSongLibrary();
  await loadGlobalSongLibrary();
  closeInlineEditors();
  $('partialTranscript').textContent = 'Waiting for full sentence...';
  socket.emit('join_event', { eventId: currentEvent.id, role: 'admin', code: currentEvent.adminCode });
  await refreshEventList();
  setStatus(`Opened: ${currentEvent.name}.`);
  switchTab('dashboard');
}

async function createEvent() {
  const name = $('eventName').value.trim() || 'New event';
  const sourceLang = $('sourceLang').value;
  const targetLangs = selectedLangs();
  if (!targetLangs.length) return alert('Choose at least one target language.');
  if (targetLangs.includes(sourceLang)) return alert('Remove source language from target languages.');
  const res = await fetch('/api/events', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      name, speed: $('speed').value || 'balanced', sourceLang, targetLangs, scheduledAt: buildScheduledAt()
    })
  });
  const data = await res.json();
  if (!data.ok) return alert(data.error || 'Could not create event.');
  currentEvent = data.event;
  populateEventLinks();
  fillGlossaryLangs(currentEvent.targetLangs || []);
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
  switchTab('dashboard');
}

async function setEventMode(mode) {
  if (!currentEvent) return;
  const res = await fetch(`/api/events/${currentEvent.id}/mode`, adminJsonOptions('POST', { mode }));
  const data = await res.json();
  if (data.ok) {
    currentEvent = data.event;
    renderActiveEventBadge(currentEvent);
  }
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

async function destroyAudioPipeline() {
  audioState.running = false;
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
  if (audioState.context) await audioState.context.close().catch(() => {});
  audioState.context = null;
  audioState.source = null;
  audioState.gainNode = null;
  audioState.preampNode = null;
  audioState.analyser = null;
  audioState.monitorGainNode = null;
  audioState.destination = null;
  audioState.busy = false;
  audioState.uploadQueue = [];
  $('audioLevel').value = 0;
  setOnAirState(false);
}

function sliderToGain(value) {
  const v = Math.max(0, Number(value || 100));
  return Math.pow(v / 100, 2);
}

function updateInputGain() {
  const value = Number($('inputGainRange').value || 100);
  const gain = sliderToGain(value);
  $('inputGainLabel').textContent = `${value}% · ${gain.toFixed(1)}x`;
  if (audioState.preampNode) audioState.preampNode.gain.value = gain;
}

function updateMonitorGain() {
  const enabled = !!$('monitorAudioBox').checked;
  const value = Number($('monitorGainRange').value || 0);
  const gain = enabled ? sliderToGain(value) : 0;
  $('monitorGainLabel').textContent = `${value}% · ${gain.toFixed(1)}x`;
  if (audioState.monitorGainNode) audioState.monitorGainNode.gain.value = gain;
}

function startMeterLoop() {
  if (!audioState.analyser) return;
  const data = new Uint8Array(audioState.analyser.fftSize);
  const draw = () => {
    if (!audioState.analyser) return;
    audioState.analyser.getByteTimeDomainData(data);
    let sumSquares = 0;
    for (let i = 0; i < data.length; i++) {
      const normalized = (data[i] - 128) / 128;
      sumSquares += normalized * normalized;
    }
    const rms = Math.sqrt(sumSquares / data.length);
    const db = 20 * Math.log10(Math.max(rms, 0.00001));
    const level = Math.max(0, Math.min(100, Math.round(((db + 60) / 60) * 100)));
    $('audioLevel').value = level;
    audioState.meterFrame = requestAnimationFrame(draw);
  };
  draw();
}

async function createAudioPipeline() {
  const deviceId = $('audioInput').value;
  await destroyAudioPipeline();
  audioState.stream = await navigator.mediaDevices.getUserMedia({
    audio: deviceId ? { deviceId: { exact: deviceId }, channelCount: 2, sampleRate: 48000, sampleSize: 16, echoCancellation: false, noiseSuppression: false, autoGainControl: false } : { channelCount: 2, sampleRate: 48000, sampleSize: 16, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
  });
  audioState.context = new (window.AudioContext || window.webkitAudioContext)();
  await audioState.context.resume();
  audioState.source = audioState.context.createMediaStreamSource(audioState.stream);
  audioState.gainNode = audioState.context.createGain();
  audioState.preampNode = audioState.context.createGain();
  audioState.analyser = audioState.context.createAnalyser();
  audioState.analyser.fftSize = 2048;
  audioState.destination = audioState.context.createMediaStreamDestination();
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
  const detectedType = blob.type || audioState.mimeType || 'audio/webm';
  const fileInfo = getAudioFileInfo(detectedType);
  const form = new FormData();
  form.append('code', currentEvent.adminCode);
  form.append('audio', new File([blob], `chunk.${fileInfo.ext}`, { type: fileInfo.mimeType }));
  const res = await fetch(`/api/events/${currentEvent.id}/transcribe`, { method: 'POST', body: form });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Audio upload failed.');
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

async function startTranslation() {
  if (!currentEvent) return alert('Open or create an event first.');
  await syncSpeedToEvent();
  if (!window.MediaRecorder) return alert('Use Chrome or Edge.');
  try { await createAudioPipeline(); } catch (_) { return setStatus('Audio start failed.'); }
  const mimeType = chooseRecorderMimeType();
  if (!mimeType) return alert('Unsupported audio format in this browser.');
  await setEventMode('live');
  audioState.running = true;
  audioState.mimeType = mimeType;
  window.isRecognitionRunning = true;
  setOnAirState(true);
  await enableScreenWakeLock();
  const startRecorderCycle = () => {
    if (!audioState.running) return;
    audioState.chunks = [];
    const recorder = new MediaRecorder(audioState.destination.stream, { mimeType, audioBitsPerSecond: 128000 });
    audioState.recorder = recorder;
    recorder.ondataavailable = (event) => { if (event.data && event.data.size > 0) audioState.chunks.push(event.data); };
    recorder.onstop = () => {
      const finalType = recorder.mimeType || mimeType || 'audio/webm';
      const blob = new Blob(audioState.chunks, { type: finalType });
      audioState.chunks = [];
      if (audioState.chunkTimer) clearTimeout(audioState.chunkTimer);
      audioState.chunkTimer = null;
      if (audioState.recorder === recorder) audioState.recorder = null;
      if (audioState.running) startRecorderCycle();
      if (blob.size >= 3500) enqueueAudioBlob(blob);
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
  if (audioState.chunkTimer) clearTimeout(audioState.chunkTimer);
  audioState.chunkTimer = null;
  setOnAirState(false);
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
  const text = $('manualText').value.trim();
  if (!text) return;

  if (target === 'manual') {
    const res = await fetch(
      `/api/events/${currentEvent.id}/display/manual`,
      adminJsonOptions('POST', { text, title: '' })
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

  $('manualText').value = '';
  lastManualEnterAt = 0;
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
  setStatus('Editor cleared.');
}


socket.on('joined_event', ({ event, role }) => {
  if (role !== 'admin') return;
  currentEvent = event;
  $('speed').value = event.speed || 'balanced';
  currentVolume = event.audioVolume;
  currentMuted = event.audioMuted;
  $('volumeRange').value = String(currentVolume);
  $('audioStateLabel').textContent = currentMuted ? 'Global audio off.' : 'Global audio active.';
  $('transcriptList').innerHTML = '';
  (event.transcripts || []).forEach(renderEntry);
  fillGlossaryLangs(currentEvent.targetLangs || []);
  renderActiveEventBadge(currentEvent);
  renderSongState(currentEvent.songState || {});
  refreshDisplayControls();
  renderSongHistory(event.songHistory || []);
  loadSongLibrary();
  loadGlobalSongLibrary();
  populateEventLinks();
  closeInlineEditors();
  refreshEventList();
  $('partialTranscript').textContent = 'Waiting for full sentence...';
});

socket.on('transcript_entry', (entry) => {
  if (!currentEvent) return;
  currentEvent.transcripts = currentEvent.transcripts || [];
  if (!getEntryById(entry.id)) currentEvent.transcripts.push(entry);
  renderEntry(entry);
  $('partialTranscript').textContent = 'Waiting for full sentence...';
});

socket.on('transcript_updated', updateEntry);
socket.on('transcript_source_updated', (payload) => { updateSourceEntry(payload); $('partialTranscript').textContent = 'Waiting for full sentence...'; });
socket.on('audio_state', ({ audioMuted, audioVolume }) => {
  currentMuted = audioMuted;
  currentVolume = audioVolume;
  $('volumeRange').value = String(audioVolume);
  $('audioStateLabel').textContent = audioMuted ? 'Global audio off.' : 'Global audio active.';
});
socket.on('partial_transcript', ({ text }) => { $('partialTranscript').textContent = text || 'Waiting for full sentence...'; });
socket.on('participant_stats', renderParticipantStats);
socket.on('server_error', ({ message }) => setStatus(message || 'Server error.'));
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
  renderActiveEventBadge(currentEvent);
});
socket.on('song_state', (songState) => {
  if (!currentEvent) return;
  currentEvent.songState = songState;
  currentEvent.mode = 'song';
  renderSongState(songState);
});
socket.on('song_clear', () => {
  if (!currentEvent) return;
  currentEvent.songState = { title: '', blocks: [], blockLabels: [], currentIndex: -1, activeBlock: null, translations: {}, allTranslations: [], updatedAt: null };
  currentEvent.mode = 'live';
  renderSongState(currentEvent.songState);
  renderActiveEventBadge(currentEvent);
});
socket.on('display_mode_changed', ({ mode, blackScreen, theme, language, backgroundPreset, customBackground, showClock, clockPosition, textSize, screenStyle }) => {
  if (!currentEvent) return;
  currentEvent.displayState = currentEvent.displayState || {};
  currentEvent.displayState.mode = mode;
  currentEvent.displayState.blackScreen = !!blackScreen;
  currentEvent.displayState.theme = theme || currentEvent.displayState.theme || 'dark';
  currentEvent.displayState.language = language || currentEvent.displayState.language;
  currentEvent.displayState.backgroundPreset = backgroundPreset || currentEvent.displayState.backgroundPreset || 'none';
  currentEvent.displayState.customBackground = typeof customBackground === 'string' ? customBackground : (currentEvent.displayState.customBackground || '');
  currentEvent.displayState.showClock = typeof showClock === 'boolean' ? showClock : !!currentEvent.displayState.showClock;
  currentEvent.displayState.clockPosition = clockPosition || currentEvent.displayState.clockPosition || 'top-right';
  currentEvent.displayState.textSize = textSize || currentEvent.displayState.textSize || 'large';
  currentEvent.displayState.screenStyle = screenStyle || currentEvent.displayState.screenStyle || 'focus';
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
socket.on('display_manual_update', ({ mode, blackScreen, theme, language, backgroundPreset, customBackground, showClock, clockPosition, textSize, screenStyle, manualSource, manualTranslations, updatedAt }) => {
  if (!currentEvent) return;
  currentEvent.displayState = currentEvent.displayState || {};
  currentEvent.displayState.mode = mode || 'manual';
  currentEvent.displayState.blackScreen = !!blackScreen;
  currentEvent.displayState.theme = theme || currentEvent.displayState.theme || 'dark';
  currentEvent.displayState.language = language || currentEvent.displayState.language;
  currentEvent.displayState.backgroundPreset = backgroundPreset || currentEvent.displayState.backgroundPreset || 'none';
  currentEvent.displayState.customBackground = typeof customBackground === 'string' ? customBackground : (currentEvent.displayState.customBackground || '');
  currentEvent.displayState.showClock = typeof showClock === 'boolean' ? showClock : !!currentEvent.displayState.showClock;
  currentEvent.displayState.clockPosition = clockPosition || currentEvent.displayState.clockPosition || 'top-right';
  currentEvent.displayState.textSize = textSize || currentEvent.displayState.textSize || 'large';
  currentEvent.displayState.screenStyle = screenStyle || currentEvent.displayState.screenStyle || 'focus';
  currentEvent.displayState.manualSource = manualSource || '';
  currentEvent.displayState.manualTranslations = manualTranslations || {};
  currentEvent.displayState.updatedAt = updatedAt || currentEvent.displayState.updatedAt || null;
  currentEvent.mode = 'live';
  refreshDisplayControls();
  renderActiveEventBadge(currentEvent);
  renderSongState(currentEvent.songState || {});
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
$('speed').addEventListener('change', syncSpeedToEvent);
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
  socket.emit('set_audio_state', { eventId: currentEvent.id, audioMuted: currentMuted, audioVolume: currentVolume, code: currentEvent.adminCode });
});
$('panicBtn').addEventListener('click', () => {
  if (!currentEvent) return;
  currentMuted = true;
  currentVolume = 0;
  $('volumeRange').value = '0';
  socket.emit('set_audio_state', { eventId: currentEvent.id, audioMuted: true, audioVolume: 0, code: currentEvent.adminCode });
});
$('volumeRange').addEventListener('input', () => {
  currentVolume = Number($('volumeRange').value || 70);
  if (!currentEvent) return;
  socket.emit('set_audio_state', { eventId: currentEvent.id, audioMuted: currentMuted, audioVolume: currentVolume, code: currentEvent.adminCode });
});
$('inputGainRange').addEventListener('input', updateInputGain);
$('monitorAudioBox').addEventListener('change', updateMonitorGain);
$('monitorGainRange').addEventListener('input', updateMonitorGain);
$('audioInput').addEventListener('change', async () => {
  if (audioState.running) await startTranslation();
  else { try { await createAudioPipeline(); setStatus('Audio source changed.'); } catch (_) { setStatus('Selected source failed.'); } }
});
$('startRecognitionBtn').addEventListener('click', startTranslation);
$('stopRecognitionBtn').addEventListener('click', stopTranslation);
$('copyParticipantBtn').addEventListener('click', () => copyField('participantLink', 'copyParticipantBtn'));
$('copyTranslateBtn').addEventListener('click', () => copyField('translateLink', 'copyTranslateBtn'));
$('copyQrBtn').addEventListener('click', copyQrImage);
$('downloadQrBtn').addEventListener('click', downloadQr);
$('setActiveEventBtn').addEventListener('click', setActiveEvent);
$('refreshEventsBtn').addEventListener('click', refreshEventList);
$('jumpLiveBtn').addEventListener('click', () => {
  closeInlineEditors();
  const first = document.querySelector('#transcriptList .entry');
  if (first) first.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('saveSongBtn').addEventListener('click', saveSongToLibrary);
$('sendSongBtn').addEventListener('click', sendSongToLive);
$('songPrevBtn').addEventListener('click', goToPrevSongBlock);
$('songNextBtn').addEventListener('click', goToNextSongBlock);
$('blankMainScreenBtn').addEventListener('click', blankMainScreen);
$('displayAutoBtn').addEventListener('click', () => setDisplayMode('auto'));
$('displayManualBtn').addEventListener('click', () => setDisplayMode('manual'));
$('displaySongBtn').addEventListener('click', () => setDisplayMode('song'));
$('displayThemeSelect').addEventListener('change', () => setDisplayTheme($('displayThemeSelect').value));
$('displayLanguageSelect').addEventListener('change', () => setDisplayLanguage($('displayLanguageSelect').value));
$('saveDisplaySettingsBtn').addEventListener('click', saveDisplaySettings);
$('openMainPreviewBtn').addEventListener('click', openMainPreviewWindow);
$('openParticipantPreviewBtn').addEventListener('click', openParticipantPreviewWindow);
$('openBothPreviewsBtn').addEventListener('click', openBothPreviewWindows);
$('globalSongLibrarySearch').addEventListener('input', () => renderGlobalSongLibrary(currentGlobalSongLibrary));
$('globalSongLibrarySort').addEventListener('change', () => renderGlobalSongLibrary(currentGlobalSongLibrary));
$('songBlocksList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-song-block-index]');
  if (!btn) return;
  const index = Number(btn.getAttribute('data-song-block-index'));
  if (!Number.isInteger(index)) return;
  await showSongBlock(index);
});
$('songBlocksList').addEventListener('change', async (e) => {
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
$('manualHistoryList')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-manual-history-action]');
  if (!btn) return;
  const item = getManualHistoryItemById(btn.getAttribute('data-manual-history-id'));
  if (!item) return;
  if (btn.getAttribute('data-manual-history-action') === 'load') {
    $('manualText').value = item.source || '';
    switchTab('manual');
    setStatus('Pinned text loaded into quick push editor.');
    return;
  }
  $('manualText').value = item.source || '';
  await sendManualText('manual');
});
$('openTranslateScreenBtn').addEventListener('click', () => { const url = $('translateLink').value || '/translate'; if (url) window.open(url, '_blank'); });
$('eventList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const id = btn.getAttribute('data-id');
  const action = btn.getAttribute('data-action');
  if (action === 'open') return openEventById(id);
  if (action === 'activate') {
    const adminCode = currentEvent?.id === id ? currentEvent.adminCode : (prompt('Enter admin code for this event to activate it:') || '').trim();
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
    const adminCode = currentEvent?.id === id ? currentEvent.adminCode : (prompt('Enter admin code for this event to delete it:') || '').trim();
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
        $('adminCode').textContent = '-'; $('participantLink').value = ''; $('translateLink').value = '';
        $('qrImage').src = ''; $('transcriptList').innerHTML = ''; renderActiveEventBadge(null); resetParticipantStats();
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
  try { await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (_) {}
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
  await loadGlobalSongLibrary();
  await refreshEventList();
  try {
    const res = await fetch('/api/events/active');
    const data = await res.json();
    if (data.ok && data.event) await openEventById(data.event.id);
  } catch (_) {}
});
