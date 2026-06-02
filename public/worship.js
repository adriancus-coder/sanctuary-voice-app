(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  let currentEvent = null;
  // WORSHIP-ROLES-2 — capabilitățile sesiunii curente (din /api/worship/events* response).
  // Membru de bază (login cu PIN global SAU rol fără bife) = role gol + canLead/canAdmin false.
  // WORSHIP-ROLES-LIVE — _myEmoji adăugat pentru badge-ul vizibil.
  let _myRole = '', _myCanLead = false, _myCanAdmin = false, _myEmoji = '';
  function applyCurrentUser(u) {
    if (!u) return;
    _myRole = String(u.role || '');
    _myCanLead = !!u.canLead;
    _myCanAdmin = !!u.canAdmin;
    _myEmoji = String(u.emoji || '');
    renderMyRoleBadge();
  }
  // WORSHIP-ROLES-LIVE — afișează rolul curent al membrului (cine ești).
  // PIN global (login fără cod-rol) = _myRole gol → badge ascuns (compat).
  function renderMyRoleBadge() {
    const el = document.getElementById('worshipMyRoleBadge');
    if (!el) return;
    if (!_myRole) { el.classList.add('hidden'); el.textContent = ''; return; }
    const caps = [_myCanLead ? 'Lider' : null, _myCanAdmin ? 'Worship admin' : null].filter(Boolean).join(', ') || 'Membru';
    el.innerHTML = (_myEmoji ? escapeHtml(_myEmoji) + ' ' : '') + '<strong>' + escapeHtml(_myRole) + '</strong> · ' + escapeHtml(caps);
    el.classList.remove('hidden');
  }
  // V21.5: split into liveEvent (the read-only header — the sync source with
  // admin/operator) and pickerEvents (future + live, used by the per-card
  // "Add to event" picker). pickerEvents loads lazily on first picker open.
  let liveEvent = null;
  let pickerEvents = [];
  let pickerEventsLoaded = false;
  let libraryItems = [];

  // V21.1: Live mode state
  let liveMode = 'setlist';
  let liveCurrentSongId = null;
  let liveCurrentVerseIndex = 0;
  // V21.22: when true, the members' screen is blanked (waiting); song/verse
  // are preserved so the master can step back with the left arrow.
  let liveEnded = false;
  // V21.13: lyrics font size (master). Inline px overrides the CSS —
  // no persistence, resets to default on reload. V21.13-FIX: shared by
  // the A−/A+ buttons AND pinch-to-zoom.
  let liveFontSize = 32;
  const LIVE_FONT_MIN = 20;
  const LIVE_FONT_MAX = 60;

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function normalizeForSearch(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .trim();
  }

  function formatDate(value) {
    const ts = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(ts)) return '';
    try {
      return new Date(ts).toLocaleString('ro-RO', {
        weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
      });
    } catch (err) {
      return new Date(ts).toLocaleDateString();
    }
  }

  function setStatus(el, text, kind) {
    if (!el) return;
    el.textContent = text || '';
    el.className = 'status-line' + (kind ? ' ' + kind : '');
  }

  // --- LOGIN / LOGOUT ---
  async function doLogin() {
    const pin = $('worshipPinInput').value.trim();
    const status = $('worshipLoginStatus');
    if (!pin) {
      setStatus(status, 'Introdu PIN.', 'err');
      return;
    }
    const btn = $('worshipLoginBtn');
    btn.disabled = true;
    setStatus(status, 'Se verifică...', '');
    try {
      const res = await fetch('/api/auth/worship', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setStatus(status, data.error || 'Autentificare eșuată.', 'err');
        return;
      }
      $('worshipPinInput').value = '';
      setStatus(status, '', '');
      enterApp();
    } catch (err) {
      setStatus(status, 'Eroare de rețea: ' + err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  async function doLogout() {
    try {
      await fetch('/api/auth/worship/logout', { method: 'POST' });
    } catch (err) { /* ignore */ }
    location.reload();
  }

  function enterApp() {
    $('worshipLoginScreen').classList.add('hidden');
    $('worshipApp').classList.remove('hidden');
    // V21.7: open the master socket on app entry (not on first Live-mode
    // toggle), so worship receives backend broadcasts on every tab —
    // including event:songlibrary_changed (V21.6) and the new
    // active_event_changed handler below.
    initMasterSocket();
    loadLiveEvent();
  }

  // --- EVENTS ---
  // V21.5: the header shows ONLY the live event (sync with admin/operator).
  // If none exists, the worship app still works for setlist prep — the
  // per-card picker still lists future events.
  async function loadLiveEvent() {
    try {
      const res = await fetch('/api/worship/events?mode=live');
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        liveEvent = null;
        renderLiveEventDisplay();
        renderEmptyEventInfo('Nu s-au putut încărca event-urile.');
        loadLibrary();
        return;
      }
      liveEvent = Array.isArray(data.events) && data.events.length ? data.events[0] : null;
      if (data.currentUser) applyCurrentUser(data.currentUser);   // WORSHIP-ROLES-2
      renderLiveEventDisplay();
      if (liveEvent) {
        await loadEventDetail(liveEvent.id);
      } else {
        currentEvent = null;
        renderEmptyEventInfo('Nu există event live. Programul se completează când admin pornește un event.');
        renderEventSongs();
        loadLibrary();
        resetLiveForEvent();
      }
    } catch (err) {
      liveEvent = null;
      renderLiveEventDisplay();
      renderEmptyEventInfo('Eroare la încărcare: ' + escapeHtml(err.message));
    }
  }

  // WORSHIP-EVENT-DROPDOWN-B — populează select-ul din header cu evenimentele în lucru
  // (pickerEvents = future + live), marchează currentEvent ca selectat.
  async function renderEventDropdown() {
    const sel = $('worshipEventDropdown');
    if (!sel) return;
    await ensurePickerEvents();
    const evs = Array.isArray(pickerEvents) ? pickerEvents : [];
    if (!evs.length) {
      sel.innerHTML = '<option value="">Niciun eveniment</option>';
      return;
    }
    const curId = currentEvent ? currentEvent.id : (liveEvent ? liveEvent.id : '');
    sel.innerHTML = evs.map((e) => {
      const live = (liveEvent && e.id === liveEvent.id) ? ' • LIVE' : '';
      const draft = (e.worshipDraft && !e.approved) ? ' • draft' : '';
      return '<option value="' + escapeHtml(e.id) + '"' + (e.id === curId ? ' selected' : '') + '>' +
        escapeHtml(e.name || 'Eveniment') + live + draft + '</option>';
    }).join('');
  }

  // WORSHIP-EVENT-DROPDOWN-B — elementele read-only au fost înlocuite cu dropdown-ul;
  // această funcție rămâne ca shim pentru caller-ii existenți (loadLiveEvent etc.).
  function renderLiveEventDisplay() {
    renderEventDropdown();
  }

  function renderEmptyEventInfo(message) {
    $('worshipEventInfo').innerHTML = '<p class="muted">' + message + '</p>';
  }

  // V21.5: lazy-load future+live events for the per-card picker. Called the
  // first time a picker opens; results are cached and reused.
  async function ensurePickerEvents() {
    if (pickerEventsLoaded) return;
    try {
      const res = await fetch('/api/worship/events?mode=picker');
      const data = await res.json().catch(() => ({}));
      pickerEvents = (res.ok && data && data.ok && Array.isArray(data.events)) ? data.events : [];
      if (data && data.currentUser) applyCurrentUser(data.currentUser);   // WORSHIP-ROLES-2
    } catch (err) {
      pickerEvents = [];
    }
    pickerEventsLoaded = true;
  }

  async function loadEventDetail(eventId) {
    try {
      const res = await fetch('/api/worship/events/' + encodeURIComponent(eventId));
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        $('worshipEventInfo').innerHTML =
          '<p class="muted">Event indisponibil.</p>';
        currentEvent = null;
        renderEventSongs();
        return;
      }
      currentEvent = data.event;
      if (data.currentUser) applyCurrentUser(data.currentUser);   // WORSHIP-ROLES-2
      $('worshipEventInfo').innerHTML =
        '<div class="event-info-card">' +
        '<strong>' + escapeHtml(currentEvent.name) + '</strong>' +
        '<div class="small muted">' + escapeHtml(formatDate(currentEvent.scheduledAt || currentEvent.scheduledTimestamp)) + '</div>' +
        '</div>';
      renderEventSongs();
      loadLibrary();
      resetLiveForEvent();
      renderEventDropdown();   // WORSHIP-EVENT-DROPDOWN-B — reflectă currentEvent în select
    } catch (err) {
      $('worshipEventInfo').innerHTML =
        '<p class="muted">Eroare: ' + escapeHtml(err.message) + '</p>';
    }
  }

  // WORSHIP-SONGS: predefined keys (major + minor) for the gamă selector.
  const SONG_KEYS = ['C','C#','Db','D','D#','Eb','E','F','F#','Gb','G','G#','Ab','A','A#','Bb','B',
                     'Cm','C#m','Dm','D#m','Ebm','Em','Fm','F#m','Gm','G#m','Am','A#m','Bbm','Bm'];

  // WORSHIP-KEY-TRANSPOSE: scară cromatică curată (12 semitoni, sharp-only) + mapping
  // enharmonic. Folosită DOAR pentru transpunere ±1 semiton, separat de SONG_KEYS care
  // amestecă enharmonice + major/minor pentru selector.
  const CHROMATIC = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const ENHARMONIC = { 'Db':'C#','Eb':'D#','Gb':'F#','Ab':'G#','Bb':'A#',
                       'Dbm':'C#m','Ebm':'D#m','Gbm':'F#m','Abm':'G#m','Bbm':'A#m' };
  function transposeKey(key, semitones) {
    if (!key) return key;
    let k = String(key).trim();
    if (ENHARMONIC[k]) k = ENHARMONIC[k];
    const isMinor = /m$/.test(k);
    const root = isMinor ? k.slice(0, -1) : k;
    let idx = CHROMATIC.indexOf(root);
    if (idx < 0) return key;   // gamă custom (ex. "D/F#") — nu transpune
    idx = (idx + (semitones % 12) + 12) % 12;
    return CHROMATIC[idx] + (isMinor ? 'm' : '');
  }

  function renderEventSongs() {
    const list = $('eventSongsList');
    const songs = (currentEvent && Array.isArray(currentEvent.songs)) ? currentEvent.songs : [];
    $('eventSongsCount').textContent = String(songs.length);

    if (!songs.length) {
      list.innerHTML = '<p class="muted small">Niciun cântec adăugat încă. Folosește Library de mai jos.</p>';
      return;
    }

    list.innerHTML = songs.map((s, idx) => {
      const keyVal = s.key ? escapeHtml(s.key) : '';
      const opts = SONG_KEYS.map((k) =>
        '<option value="' + k + '"' + (s.key === k ? ' selected' : '') + '>' + k + '</option>').join('');
      const customOpt = (keyVal && !SONG_KEYS.includes(s.key))
        ? '<option value="' + keyVal + '" selected>' + keyVal + '</option>' : '';
      return (
        '<div class="event-song-row" draggable="true" data-event-song-id="' + escapeHtml(s.id) + '" data-idx="' + idx + '">' +
          '<span class="song-drag-handle" title="Trage pentru reordonare">⠿</span>' +
          '<div class="event-song-arrows">' +
            '<button class="btn btn-sm song-move-up" type="button" data-song-up="' + escapeHtml(s.id) + '"' + (idx === 0 ? ' disabled' : '') + '>▲</button>' +
            '<button class="btn btn-sm song-move-down" type="button" data-song-down="' + escapeHtml(s.id) + '"' + (idx === songs.length - 1 ? ' disabled' : '') + '>▼</button>' +
          '</div>' +
          '<div class="event-song-meta">' +
            '<strong><span class="song-order-num">' + (idx + 1) + '.</span> ' + escapeHtml(s.title || 'Fără titlu') + '</strong>' +
            (s.addedByWorship ? '<span class="worship-tag">adăugat de tine</span>' : '') +
          '</div>' +
          '<div class="song-key-wrap" title="Gamă (dublu-click pt valoare custom)">' +
            '<select class="song-key-select" data-song-key="' + escapeHtml(s.id) + '">' +
              '<option value="">— gamă —</option>' + opts + customOpt +
            '</select>' +
          '</div>' +
          // WORSHIP-SECTIONS-A — toggle pt marcaje secțiune (Strofă/Refren/Pod) per bloc
          '<button class="btn btn-dark btn-sm song-sections-toggle" type="button" data-sections-toggle="' + escapeHtml(s.id) + '" title="Marchează secțiuni">🏷 Secțiuni</button>' +
          (s.addedByWorship
            ? '<button class="btn btn-danger btn-sm" type="button" data-event-song-delete="' + escapeHtml(s.id) + '">Șterge</button>'
            : '') +
          '<div class="song-sections-panel hidden" data-song-sections="' + escapeHtml(s.id) + '">' +
            renderSongSections(s) +
          '</div>' +
        '</div>'
      );
    }).join('');
    bindSongRowEvents();
  }

  // WORSHIP-SECTIONS-A — generează rândurile cu select Strofă/Refren/Pod per bloc parseVerses.
  const SECTION_LABELS = { verse: 'Strofă', chorus: 'Refren', bridge: 'Pod' };
  function renderSongSections(song) {
    const verses = parseVerses(song.text || '');
    if (!verses.length) return '<p class="muted small">Cântarea n-are blocuri (text gol).</p>';
    const sections = Array.isArray(song.sections) ? song.sections : [];
    const notes = Array.isArray(song.sectionNotes) ? song.sectionNotes : [];
    return verses.map(function (v, i) {
      const type = sections[i] || 'verse';
      const note = notes[i] || '';
      const preview = (v.split('\n')[0] || '').slice(0, 40);
      const opts = ['verse', 'chorus', 'bridge'].map(function (t) {
        return '<option value="' + t + '"' + (t === type ? ' selected' : '') + '>' + SECTION_LABELS[t] + '</option>';
      }).join('');
      return '<div class="song-section-row">' +
        '<span class="song-section-num">' + (i + 1) + '</span>' +
        '<select class="song-section-select" data-section-idx="' + i + '">' + opts + '</select>' +
        '<span class="song-section-preview">' + escapeHtml(preview) + '…</span>' +
        '<input type="text" class="song-section-note" data-note-idx="' + i + '" value="' + escapeHtml(note) + '" placeholder="cine cântă (ex. doar fetele, X solo)" maxlength="200">' +
      '</div>';
    }).join('');
  }

  async function saveSongSections(songId) {
    if (!currentEvent || !songId) return;
    const wrap = document.querySelector('[data-song-sections="' + songId + '"]');
    if (!wrap) return;
    const sections = Array.from(wrap.querySelectorAll('.song-section-select')).map((sel) => sel.value);
    try {
      const res = await fetch('/api/worship/events/' + encodeURIComponent(currentEvent.id) +
        '/songs/' + encodeURIComponent(songId) + '/sections',
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ sections }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        const s = (currentEvent.songs || []).find((x) => String(x.id) === String(songId));
        if (s) s.sections = data.song && Array.isArray(data.song.sections) ? data.song.sections : sections;
      }
    } catch (err) { console.warn('save sections failed', err); }
  }

  // WORSHIP-NOTES-1 — salvează note de interpretare per-bloc (paralel cu sections)
  async function saveSongNotes(songId) {
    if (!currentEvent || !songId) return;
    const wrap = document.querySelector('[data-song-sections="' + songId + '"]');
    if (!wrap) return;
    const sectionNotes = Array.from(wrap.querySelectorAll('.song-section-note')).map((inp) => inp.value);
    try {
      const res = await fetch('/api/worship/events/' + encodeURIComponent(currentEvent.id) +
        '/songs/' + encodeURIComponent(songId) + '/section-notes',
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ sectionNotes }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        const s = (currentEvent.songs || []).find((x) => String(x.id) === String(songId));
        if (s) s.sectionNotes = (data.song && Array.isArray(data.song.sectionNotes)) ? data.song.sectionNotes : sectionNotes;
      }
    } catch (err) { console.warn('save section notes failed', err); }
  }

  // WORSHIP-SONGS: bind gamă (change + dblclick custom), arrows, and drag&drop after each render.
  // Delete keeps using the pre-existing delegated listener on #eventSongsList (do not duplicate it).
  function bindSongRowEvents() {
    document.querySelectorAll('#eventSongsList .song-key-select').forEach((sel) => {
      sel.addEventListener('change', () => saveSongKey(sel.getAttribute('data-song-key'), sel.value));
      sel.addEventListener('dblclick', (e) => {
        e.preventDefault();
        const custom = prompt('Gamă personalizată (ex. D/F#, Bb7):', sel.value || '');
        if (custom !== null) saveSongKey(sel.getAttribute('data-song-key'), custom.trim());
      });
    });
    document.querySelectorAll('#eventSongsList [data-song-up]').forEach((b) =>
      b.addEventListener('click', () => moveSong(b.getAttribute('data-song-up'), -1)));
    document.querySelectorAll('#eventSongsList [data-song-down]').forEach((b) =>
      b.addEventListener('click', () => moveSong(b.getAttribute('data-song-down'), +1)));
    // WORSHIP-SECTIONS-A — toggle panel + save la change pe select
    document.querySelectorAll('#eventSongsList [data-sections-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-sections-toggle');
        const panel = document.querySelector('[data-song-sections="' + id + '"]');
        if (panel) panel.classList.toggle('hidden');
      });
    });
    document.querySelectorAll('#eventSongsList .song-section-select').forEach((sel) => {
      sel.addEventListener('change', () => {
        const panel = sel.closest('[data-song-sections]');
        const id = panel && panel.getAttribute('data-song-sections');
        if (id) saveSongSections(id);
      });
    });
    // WORSHIP-NOTES-1 — salvează note la blur (mai discret decât change pe input;
    // schimbarea fiecărei litere nu generează request)
    document.querySelectorAll('#eventSongsList .song-section-note').forEach((inp) => {
      inp.addEventListener('change', () => {
        const panel = inp.closest('[data-song-sections]');
        const id = panel && panel.getAttribute('data-song-sections');
        if (id) saveSongNotes(id);
      });
    });
    bindSongDragDrop();
  }

  async function saveSongKey(songId, key) {
    if (!currentEvent || !songId) return;
    try {
      const res = await fetch('/api/worship/events/' + encodeURIComponent(currentEvent.id) +
        '/songs/' + encodeURIComponent(songId) + '/key',
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        const s = (currentEvent.songs || []).find((x) => String(x.id) === String(songId));
        if (s) s.key = data.song ? data.song.key : key;
        renderEventSongs();
        // WORSHIP-KEY-LIVE-REFRESH — dacă suntem în modul live, actualizează și acolo gama afișată
        // (lângă strofă + pe mini-carduri), ca transpunerea instant SAU programată să se reflecte imediat.
        if (liveMode === 'live') refreshLiveMode();
      }
    } catch (err) { console.warn('save key failed', err); }
  }

  async function persistOrder(order) {
    if (!currentEvent) return;
    try {
      const res = await fetch('/api/worship/events/' + encodeURIComponent(currentEvent.id) + '/songs/reorder',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        // server confirmed; reflect the new order locally then re-render
        const byId = new Map((currentEvent.songs || []).map((s) => [String(s.id), s]));
        const next = [];
        order.forEach((id) => { if (byId.has(id)) { next.push(byId.get(id)); byId.delete(id); } });
        byId.forEach((v) => next.push(v));
        currentEvent.songs = next;
        renderEventSongs();
      }
    } catch (err) { console.warn('reorder failed', err); }
  }

  async function moveSong(songId, dir) {
    const songs = currentEvent && Array.isArray(currentEvent.songs) ? currentEvent.songs.slice() : [];
    const i = songs.findIndex((s) => String(s.id) === String(songId));
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= songs.length) return;
    const tmp = songs[i]; songs[i] = songs[j]; songs[j] = tmp;
    await persistOrder(songs.map((s) => String(s.id)));
  }

  let _dragSongId = null;
  function bindSongDragDrop() {
    document.querySelectorAll('#eventSongsList .event-song-row').forEach((row) => {
      row.addEventListener('dragstart', (e) => {
        _dragSongId = row.getAttribute('data-event-song-id');
        row.classList.add('dragging');
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragend', () => { row.classList.remove('dragging'); _dragSongId = null; });
      row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drag-over'); });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drag-over');
        const targetId = row.getAttribute('data-event-song-id');
        if (!_dragSongId || _dragSongId === targetId) return;
        const songs = (currentEvent.songs || []).slice();
        const from = songs.findIndex((s) => String(s.id) === String(_dragSongId));
        const to = songs.findIndex((s) => String(s.id) === String(targetId));
        if (from < 0 || to < 0) return;
        const moved = songs.splice(from, 1)[0];
        songs.splice(to, 0, moved);
        persistOrder(songs.map((s) => String(s.id)));
      });
    });
  }

  // --- LIBRARY ---
  async function loadLibrary() {
    const status = $('globalSongLibraryStatus');
    try {
      const res = await fetch('/api/global-song-library');
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        libraryItems = [];
        setStatus(status, 'Library indisponibilă.', 'err');
        renderLibrary();
        return;
      }
      libraryItems = Array.isArray(data.globalSongLibrary) ? data.globalSongLibrary : [];
      setStatus(status, '', '');
      renderLibrary($('globalSongLibrarySearch').value);
    } catch (err) {
      libraryItems = [];
      setStatus(status, 'Eroare la încărcarea Library: ' + err.message, 'err');
      renderLibrary();
    }
  }

  function renderLibrary(filter) {
    const list = $('globalSongLibraryList');
    const normalized = normalizeForSearch(filter || '');
    const filtered = normalized
      ? libraryItems.filter((item) =>
          normalizeForSearch(item.title || '').includes(normalized) ||
          normalizeForSearch(item.text || '').includes(normalized))
      : libraryItems;

    if (!filtered.length) {
      list.innerHTML = '<p class="muted small">' +
        (libraryItems.length ? 'Niciun rezultat.' : 'Library este goală.') + '</p>';
      return;
    }

    // V21.5: each Library card opens a per-card "Add to event" picker
    // (nested <details>) listing future + live events. No more single
    // currentEvent.editable gate — worship picks the target per song.
    list.innerHTML = filtered.slice(0, 60).map((item) => {
      const id = escapeHtml(item.id);
      const chars = item.text ? String(item.text).length : 0;
      return '<details class="library-card">' +
        '<summary>' +
          '<strong>' + escapeHtml(item.title || 'Fără titlu') + '</strong>' +
          '<span class="muted small"> · ' + chars + ' caractere</span>' +
        '</summary>' +
        '<div class="library-card-body">' +
          '<pre class="library-preview-text">' + escapeHtml(item.text || '') + '</pre>' +
          '<div class="library-card-actions">' +
            '<details class="add-to-event-picker">' +
              '<summary class="btn btn-primary btn-sm">Adaugă în event ▾</summary>' +
              '<div class="add-to-event-list" data-library-song-id="' + id + '"></div>' +
            '</details>' +
          '</div>' +
        '</div>' +
      '</details>';
    }).join('');
  }

  // V21.5: populate a picker's option list. Lazy — called when the picker
  // <details> first toggles open.
  function renderAddToEventPicker(librarySongId, containerEl) {
    if (!containerEl) return;
    if (!pickerEvents.length) {
      containerEl.innerHTML = '<p class="muted small">Niciun event disponibil. Cere admin să creeze un event.</p>';
      return;
    }
    containerEl.innerHTML = pickerEvents.map((ev) =>
      '<button type="button" class="event-picker-option' + (ev.isActive ? ' active' : '') + '"' +
        ' data-worship-picker-event="' + escapeHtml(ev.id) + '"' +
        ' data-worship-picker-song="' + escapeHtml(librarySongId) + '">' +
        '<span class="event-picker-name"><strong>' + escapeHtml(ev.name || 'Event') + '</strong>' +
          (ev.isActive ? '<span class="badge-live">LIVE</span>' : '') + '</span>' +
        '<span class="small muted">' + escapeHtml(formatDate(ev.scheduledAt || ev.scheduledTimestamp)) + '</span>' +
      '</button>'
    ).join('');
  }

  // --- ADD / DELETE ---
  // V21.4-FIX5: visible click feedback parity with admin (V21.4-FIX2).
  // Pulls just the event detail (NOT the global library) so the green
  // "✓ Adăugat" state on the Library button survives long enough to read;
  // calling loadEventDetail here would also rebuild the library list and
  // wipe the button mid-flight.
  // V21.5: add a song to a specific event chosen in the per-card picker.
  // Feedback mirrors V21.4-FIX2/FIX5: button shows green confirmation; if the
  // target is the current live event, the new row in the Setlist panel
  // flashes gold and scrolls into view. Only the event-detail is refreshed
  // (not the global library) so the green state survives the 1.5s display
  // window.
  async function addSongToSpecificEvent(eventId, librarySongId, btn) {
    if (!eventId || !librarySongId) return;
    const targetEvent = pickerEvents.find((e) => e && e.id === eventId);
    const targetName = targetEvent ? targetEvent.name : 'event';
    const originalText = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '… Se adaugă'; }
    try {
      const res = await fetch('/api/worship/events/' + encodeURIComponent(eventId) + '/songs/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ librarySongId })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        alert(data.error || 'Adăugarea a eșuat.');
        if (btn) { btn.disabled = false; btn.innerHTML = originalText; }
        return;
      }
      if (btn) {
        btn.classList.add('btn-confirmed');
        btn.innerHTML = '✓ Adăugat la ' + escapeHtml(targetName);
      }
      // Refresh the Setlist panel only when the target matches the live event.
      const isLiveTarget = liveEvent && eventId === liveEvent.id;
      if (isLiveTarget) {
        try {
          const detail = await fetch('/api/worship/events/' + encodeURIComponent(eventId));
          const dj = await detail.json().catch(() => ({}));
          if (detail.ok && dj && dj.ok && dj.event) {
            currentEvent = dj.event;
            renderEventSongs();
          }
        } catch (err) { /* render stale state is fine */ }
        const newItemId = data.itemId;
        if (newItemId) {
          setTimeout(() => {
            const row = document.querySelector('[data-event-song-id="' + newItemId + '"]');
            if (row) {
              row.classList.add('event-song-row-flash');
              row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
              setTimeout(() => row.classList.remove('event-song-row-flash'), 1600);
            }
          }, 60);
        }
      }
      setTimeout(() => {
        if (btn) {
          btn.classList.remove('btn-confirmed');
          btn.disabled = false;
          btn.innerHTML = originalText;
        }
        // Close the picker after success so the next pick is a fresh tap.
        const picker = btn ? btn.closest('.add-to-event-picker') : null;
        if (picker) picker.removeAttribute('open');
        // V21.39: clear the search field after a successful add so the next
        // search starts fresh — pairs with the picker close above.
        const sEl = $('globalSongLibrarySearch');
        if (sEl) { sEl.value = ''; renderLibrary(); }
      }, 1500);
    } catch (err) {
      alert('Eroare: ' + err.message);
      if (btn) { btn.disabled = false; btn.innerHTML = originalText; }
    }
  }

  async function deleteOwnSong(itemId) {
    if (!currentEvent) return;
    if (!confirm('Ștergi cântarea adăugată?')) return;
    try {
      const res = await fetch(
        '/api/worship/events/' + encodeURIComponent(currentEvent.id) + '/songs/' + encodeURIComponent(itemId),
        { method: 'DELETE' }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        alert(data.error || 'Ștergerea a eșuat.');
        return;
      }
      await loadEventDetail(currentEvent.id);
    } catch (err) {
      alert('Eroare: ' + err.message);
    }
  }

  // --- V20.3: IMPORT / SEARCH / SAVE ---
  function findDuplicateInLibrary(title) {
    const normalized = normalizeForSearch(title);
    if (!normalized) return null;
    return libraryItems.find((item) => normalizeForSearch(item.title || '') === normalized) || null;
  }

  function fillEditor(song) {
    $('songTitle').value = song.title || '';
    $('songText').value = song.text || '';
  }

  function clearSongEditor() {
    $('songTitle').value = '';
    $('songText').value = '';
    $('importUrlResults').innerHTML = '';
    setStatus($('importUrlStatus'), '', '');
  }

  async function importFromUrl(url) {
    const res = await fetch('/api/songs/import-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok || !data.song) throw new Error(data.error || 'Import eșuat.');
    return data.song;
  }

  // Fill the editor from an imported song, warning if it duplicates a library
  // title. Returns true if the editor was filled, false if the user cancelled.
  function acceptImportedSong(song) {
    const dup = findDuplicateInLibrary(song.title);
    if (dup && !confirm('Cântarea "' + dup.title + '" există deja în Library.\n\nContinui oricum?')) {
      return false;
    }
    fillEditor(song);
    return true;
  }

  // V21.15: the unified search field is #globalSongLibrarySearch. Library
  // filtering is instant on input; this resurse search runs only on Enter or
  // the "Caută și pe resurse" button so external requests stay rate-light.
  async function doImportOrSearch() {
    const input = $('globalSongLibrarySearch');
    const status = $('importUrlStatus');
    const resultsEl = $('importUrlResults');
    const btn = $('importUrlBtn');
    const resurseSection = document.querySelector('.unified-search-resurse-section');
    const spinner = document.querySelector('.unified-search-spinner');
    const value = (input.value || '').trim();
    if (!value) {
      setStatus(status, 'Introdu un URL sau cuvinte cheie.', 'err');
      return;
    }
    const isUrl = /^https?:\/\//i.test(value);
    btn.disabled = true;
    if (resurseSection) resurseSection.classList.remove('hidden');
    if (spinner) spinner.classList.remove('hidden');
    setStatus(status, isUrl ? 'Se importă...' : 'Se caută pe resurse...', '');
    resultsEl.innerHTML = '';
    try {
      if (isUrl) {
        const song = await importFromUrl(value);
        if (!acceptImportedSong(song)) {
          setStatus(status, 'Anulat — cântarea există deja în Library.', 'err');
          return;
        }
        setStatus(status, 'Importat: „' + song.title + '”. Verifică și salvează.', 'ok');
      } else {
        const res = await fetch('/api/songs/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: value })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || 'Căutare eșuată.');
        const results = Array.isArray(data.results) ? data.results : [];
        if (!results.length) {
          setStatus(status, 'Niciun rezultat pentru „' + value + '”.', 'err');
          return;
        }
        setStatus(status, results.length + ' rezultate — alege și importă:', 'ok');
        resultsEl.innerHTML = results.map((item) =>
          '<div class="import-result-row">' +
            '<div class="import-result-meta">' +
              '<strong>' + escapeHtml(item.title || 'Fără titlu') + '</strong>' +
              (item.author ? '<div class="small muted">' + escapeHtml(item.author) + '</div>' : '') +
            '</div>' +
            '<button class="btn btn-dark btn-sm" type="button" data-import-result-url="' + escapeHtml(item.url || '') + '">Import</button>' +
          '</div>'
        ).join('');
      }
    } catch (err) {
      setStatus(status, 'Eroare: ' + err.message, 'err');
    } finally {
      btn.disabled = false;
      if (spinner) spinner.classList.add('hidden');
      // WORSHIP-UI-TWEAKS-A — deschide rezultatele + golește inputul după căutare.
      // Setarea programatică a .value NU declanșează listenerul 'input' (doar tastarea o face),
      // deci nu se re-render-uiește lista locală și nu se ascunde secțiunea Resurse.
      const resultsDd = document.getElementById('libraryResultsDropdown');
      if (resultsDd) resultsDd.open = true;
      if (input) input.value = '';
    }
  }

  async function saveSongInLibrary() {
    const title = $('songTitle').value.trim();
    const text = $('songText').value.trim();
    if (!title || !text) {
      alert('Completează titlul și versurile.');
      return;
    }
    const dup = findDuplicateInLibrary(title);
    if (dup && !confirm('Cântarea "' + dup.title + '" există deja în Library. O suprascrii?')) return;
    const btn = $('songSaveBtn');
    btn.disabled = true;
    try {
      const res = await fetch('/api/global-song-library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, text })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'Salvare eșuată.');
      clearSongEditor();
      setStatus($('importUrlStatus'), 'Salvat în Library: „' + title + '”.', 'ok');
      await loadLibrary();
    } catch (err) {
      alert('Eroare la salvare: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  }

  // --- V21.1: LIVE MODE ---
  // Verses are split on blank lines. NOTE: this differs from the projector's
  // marker-aware block model; reconciling the two indexes is a V21.3 concern
  // (projector sync). For standalone worship-tablet use this split is enough.
  function parseVerses(text) {
    if (!text) return [];
    return String(text).split(/\n\s*\n/).map((v) => v.trim()).filter(Boolean);
  }

  function getLiveSong() {
    const songs = (currentEvent && Array.isArray(currentEvent.songs)) ? currentEvent.songs : [];
    return songs.find((s) => s.id === liveCurrentSongId) || null;
  }

  function toggleMode(mode) {
    if (mode !== 'setlist' && mode !== 'live') return;
    liveMode = mode;
    $('worshipSetlistMode').classList.toggle('hidden', mode !== 'setlist');
    $('worshipLiveMode').classList.toggle('hidden', mode !== 'live');
    document.querySelectorAll('[data-worship-mode]').forEach((b) => {
      b.classList.toggle('active', b.dataset.worshipMode === mode);
    });
    if (mode === 'live') {
      refreshLiveMode();
      initMasterSocket();
      joinMasterRoom();
    }
  }

  function refreshLiveMode() {
    const select = $('liveSongSelect');
    if (!select) return;
    const songs = (currentEvent && Array.isArray(currentEvent.songs)) ? currentEvent.songs : [];
    if (!songs.length) {
      select.innerHTML = '<option value="">Niciun cântec în event</option>';
      select.disabled = true;
    } else {
      select.disabled = false;
      // WORSHIP-LIVE-KEY: number each song (1., 2., …) and surface its key in
      // the LIVE picker so the leader sees order + tonality at a glance.
      select.innerHTML = '<option value="">Alege cântarea…</option>' +
        songs.map((s, idx) => '<option value="' + escapeHtml(s.id) + '">' +
          (idx + 1) + '. ' + escapeHtml(s.title || 'Fără titlu') +
          (s.key ? ' [' + escapeHtml(s.key) + ']' : '') + '</option>').join('');
    }
    // Restore from the server-side worshipState if it points at a known song.
    const ws = currentEvent && currentEvent.worshipState;
    if (ws && ws.currentSongId && songs.some((s) => s.id === ws.currentSongId)) {
      liveCurrentSongId = ws.currentSongId;
      liveCurrentVerseIndex = Number.isInteger(ws.currentVerseIndex) ? ws.currentVerseIndex : 0;
      // V21.22: pick up the ended flag so a refresh keeps the master's UI
      // in END state if that's where the session was.
      liveEnded = !!ws.ended;
    }
    select.value = liveCurrentSongId || '';
    renderLiveMode();
    // WORSHIP-LEADER: keep the leader's jump-song dropdown in step with the
    // event's song list (function-declaration hoisting makes the forward call safe).
    populateLeaderSelects();
  }

  function renderLiveMode() {
    const labelEl = $('liveVerseLabel');
    const textEl = $('liveVerseText');
    const posEl = $('liveVersePosition');
    const listEl = $('liveVerseList');
    if (!labelEl || !textEl || !posEl || !listEl) return;
    const song = getLiveSong();
    // WORSHIP-LIVE-KEY: current song's key (gamă), surfaced in LIVE mode next to
    // the verse label and on every verse mini-card so the team always sees the
    // tonality. Read-only — does not touch the live control path.
    const songKey = song && song.key ? song.key : '';
    if (!song) {
      labelEl.textContent = '—';
      textEl.textContent = 'Selectează o cântare.';
      posEl.textContent = '0 / 0';
      listEl.innerHTML = '';
      return;
    }
    const verses = parseVerses(song.text);
    if (!verses.length) {
      labelEl.textContent = '—';
      textEl.textContent = 'Cântarea nu are versuri.';
      posEl.textContent = '0 / 0';
      listEl.innerHTML = '';
      return;
    }
    const idx = Math.max(0, Math.min(liveCurrentVerseIndex, verses.length - 1));
    liveCurrentVerseIndex = idx;
    // V21.22: when in END state, show a clear "paused" view while keeping
    // the verse list highlighted so the master can step back.
    const keyBadge = songKey ? ' <span class="live-song-key">🎵 ' + escapeHtml(songKey) + '</span>' : '';
    if (liveEnded) {
      labelEl.innerHTML = 'END' + keyBadge;
      textEl.textContent = 'Ecran golit pentru membri.';
      posEl.textContent = 'END · ' + verses.length + ' / ' + verses.length;
    } else {
      labelEl.innerHTML = 'Strofa ' + (idx + 1) + keyBadge;
      textEl.textContent = verses[idx];
      posEl.textContent = (idx + 1) + ' / ' + verses.length;
    }
    // V21.4-FIX: mini-cards with full verse preview so the master sees
    // upcoming text at a glance. Horizontal scroll; current item auto-scrolls
    // into view after render.
    listEl.innerHTML = verses.map((v, i) => {
      // WORSHIP-NEXT-PREVIEW — current pe idx, next (preview) pe idx+1 (doar dacă nu suntem END)
      const cls = (i === idx && !liveEnded) ? ' current'
                : (i === idx + 1 && !liveEnded) ? ' next'
                : '';
      return '<button type="button" class="verse-mini-item' + cls +
        '" data-verse-index="' + i + '">' +
          '<div class="verse-mini-label">Strofa ' + (i + 1) +
            (songKey ? ' <span class="verse-mini-key">🎵 ' + escapeHtml(songKey) + '</span>' : '') +
          '</div>' +
          '<div class="verse-mini-text">' + escapeHtml(v) + '</div>' +
        '</button>';
    }).join('');
    const currentEl = listEl.querySelector('.verse-mini-item.current');
    if (currentEl && typeof currentEl.scrollIntoView === 'function') {
      currentEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
    // V21.22: next-button label morphs:
    //   normal verse  → '→'
    //   last verse    → 'END'  (next press blanks members)
    //   ended         → '→'    (disabled — only ← exits END)
    const nextBtn = $('liveVerseNext');
    if (nextBtn) {
      const isLast = idx === verses.length - 1;
      nextBtn.classList.toggle('live-end-btn', !liveEnded && isLast);
      nextBtn.disabled = liveEnded;
      nextBtn.textContent = liveEnded ? '→' : (isLast ? 'END' : '→');
      nextBtn.setAttribute('aria-label',
        liveEnded ? 'Sfârșit' : (isLast ? 'Termină cântarea' : 'Verset următor'));
    }
  }

  function resetLiveForEvent() {
    liveCurrentSongId = null;
    liveCurrentVerseIndex = 0;
    liveEnded = false;
    refreshLiveMode();
    joinMasterRoom();
  }

  async function setLiveVerse(index, opts) {
    const song = getLiveSong();
    if (!song || !currentEvent) return;
    const verses = parseVerses(song.text);
    if (!verses.length) return;
    const clamped = Math.max(0, Math.min(index, verses.length - 1));
    const ended = !!(opts && opts.ended);
    liveCurrentVerseIndex = clamped;
    liveEnded = ended;
    renderLiveMode();
    renderLiveSectionNote();   // WORSHIP-NOTES-2 — reflectă nota blocului curent
    checkPendingHints(liveCurrentVerseIndex);   // FAZA C
    try {
      const res = await fetch('/api/worship/events/' + encodeURIComponent(currentEvent.id) + '/verse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ songId: song.id, verseIndex: clamped, ended })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setStatus($('liveStatus'), data.error || 'Sincronizare eșuată.', 'err');
      } else if (ended) {
        setStatus($('liveStatus'), 'Sincronizat · ecran golit pentru membri', 'ok');
      } else {
        setStatus($('liveStatus'), 'Sincronizat · strofa ' + (clamped + 1), 'ok');
      }
    } catch (err) {
      setStatus($('liveStatus'), 'Eroare rețea: ' + err.message, 'err');
    }
  }

  // V21.22: arrow / swipe navigation that knows about END state.
  //   prev from END  → back to last verse (same index, ended=false)
  //   next on last   → enter END (same index, ended=true)
  //   prev / next while in END are otherwise ignored
  function liveNext() {
    if (liveEnded) return;
    const song = getLiveSong();
    if (!song) return;
    const verses = parseVerses(song.text);
    if (!verses.length) return;
    if (liveCurrentVerseIndex >= verses.length - 1) {
      setLiveVerse(verses.length - 1, { ended: true });
    } else {
      setLiveVerse(liveCurrentVerseIndex + 1);
    }
  }

  function livePrev() {
    if (liveEnded) {
      const song = getLiveSong();
      const verses = song ? parseVerses(song.text) : [];
      if (!verses.length) {
        liveEnded = false;
        renderLiveMode();
        return;
      }
      setLiveVerse(verses.length - 1);
    } else {
      setLiveVerse(liveCurrentVerseIndex - 1);
    }
  }

  function changeLiveSong(songId) {
    liveCurrentSongId = songId || null;
    liveCurrentVerseIndex = 0;
    // V21.22: switching songs always exits END.
    liveEnded = false;
    // FAZA C — curăță hinturile programate pentru cântarea veche (structura sections nouă)
    if (_pendingHints.length) { _pendingHints = []; renderPendingHints(); }
    if (liveCurrentSongId) {
      setLiveVerse(0);
    } else {
      renderLiveMode();
      setStatus($('liveStatus'), '', '');
    }
  }

  function attachSwipeHandlers() {
    const display = $('liveLyricsDisplay');
    if (!display) return;
    let startX = null;
    let startY = null;
    display.addEventListener('touchstart', (e) => {
      // V21.13-FIX: only a single-finger touch is a swipe. Two fingers
      // is a pinch-zoom (handled separately) — clear any swipe in
      // progress so the touchend below bails.
      if (e.touches.length !== 1) { startX = null; startY = null; return; }
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    }, { passive: true });
    display.addEventListener('touchend', (e) => {
      if (startX === null) return;
      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;
      startX = null;
      startY = null;
      if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) return;
      // V21.22: swipe uses the same END-aware helpers as the buttons.
      if (dx < 0) liveNext(); else livePrev();
    }, { passive: true });
  }

  // V21.13-FIX: pinch-to-zoom on the lyrics display (two fingers).
  // Shares liveFontSize with the A−/A+ buttons. preventDefault stops
  // the browser's native page zoom; passive:false is required for it.
  function attachPinchZoom() {
    const display = $('liveLyricsDisplay');
    if (!display) return;
    let pinchStartDist = null;
    let pinchStartFont = null;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    display.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        pinchStartDist = dist(e.touches);
        pinchStartFont = liveFontSize;
        e.preventDefault();
      }
    }, { passive: false });
    display.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && pinchStartDist) {
        const next = Math.round(pinchStartFont * (dist(e.touches) / pinchStartDist));
        liveFontSize = Math.max(LIVE_FONT_MIN, Math.min(LIVE_FONT_MAX, next));
        applyLiveFontSize();
        e.preventDefault();
      }
    }, { passive: false });
    display.addEventListener('touchend', (e) => {
      if (e.touches.length < 2) { pinchStartDist = null; pinchStartFont = null; }
    });
  }

  // --- V21.2: SHARE WITH TEAM (QR) ---
  async function shareWithTeam() {
    if (!currentEvent) {
      alert('Selectează un event mai întâi.');
      return;
    }
    const btn = $('worshipShareBtn');
    if (btn) btn.disabled = true;
    try {
      const res = await fetch('/api/worship/events/' + encodeURIComponent(currentEvent.id) + '/share-qr', {
        method: 'POST'
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'Generarea QR a eșuat.');
      $('worshipQrImage').innerHTML =
        '<img src="' + escapeHtml(data.qrDataUrl || '') + '" alt="QR cod worship view" width="240" height="240">';
      $('worshipQrUrl').value = data.url || '';
      $('worshipQrModal').classList.remove('hidden');
    } catch (err) {
      alert('Eroare: ' + err.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function closeQrModal() {
    $('worshipQrModal').classList.add('hidden');
  }

  async function copyQrLink() {
    const url = $('worshipQrUrl').value;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      const btn = $('worshipQrCopyBtn');
      const original = btn.textContent;
      btn.textContent = 'Copiat ✓';
      setTimeout(() => { btn.textContent = original; }, 1500);
    } catch (err) {
      $('worshipQrUrl').select();
    }
  }

  // --- V21.3: MASTER SOCKET + PROJECTOR SYNC REQUEST ---
  let masterSocket = null;
  let masterHeartbeatTimer = null;
  let pendingSyncId = null;
  // V21.8: incoming operator->worship push awaiting accept/decline.
  let pendingOperatorPush = null;
  // WORSHIP-LEADER: am I the designated leader for the live event, and who is
  // (if anyone)? Both are driven by the server's `worship:leader` broadcast —
  // never set optimistically — so a single source of truth decides the role.
  let isWorshipLeader = false;
  let currentLeaderId = null;

  function joinMasterRoom() {
    if (masterSocket && masterSocket.connected) {
      // V21.x: prefer liveEvent.id — set EARLY in loadLiveEvent, before
      // loadEventDetail completes — so the room subscription happens
      // even during the brief window when currentEvent is still null.
      const eventId = (liveEvent && liveEvent.id) || (currentEvent && currentEvent.id);
      if (eventId) masterSocket.emit('worship:master:join', { eventId });
    }
  }

  function initMasterSocket() {
    if (masterSocket || typeof io !== 'function') return;
    masterSocket = io();
    // V21.x: on every (re)connect, rejoin the worship room AND resync
    // state. Socket.IO does not auto-rejoin rooms on reconnect (server
    // discards membership), so any broadcasts during a network blip
    // would otherwise be lost — loadLiveEvent's loadEventDetail
    // refetches the event detail to recover.
    masterSocket.on('connect', () => {
      // WORSHIP-LEADER: a (re)connect means a new socket id. The server drops
      // leadership on the old socket's disconnect, so reset locally to avoid a
      // stale "you are leader" — the master re-claims explicitly if desired.
      isWorshipLeader = false;
      currentLeaderId = null;
      renderLeaderUI();
      joinMasterRoom();
      loadLiveEvent();
    });
    masterSocket.on('worship:master:denied', (d) => {
      setStatus($('liveStatus'), (d && d.message) || 'Conexiune worship respinsă.', 'err');
    });
    masterSocket.on('worship:sync_request_resolved', (data) => {
      if (!data || !pendingSyncId || data.requestId !== pendingSyncId) return;
      pendingSyncId = null;
      // V21.9: prefer the precise `status` field. Old payloads only had
      // `approved` boolean — fall back to it.
      const status = (typeof data.status === 'string') ? data.status
        : (data.approved ? 'approved' : 'declined');
      if (status === 'noted') {
        setStatus($('liveStatus'),
          'Cerere notată — operatorul sincronizează manual pe proiector.', 'ok');
      } else if (status === 'declined') {
        setStatus($('liveStatus'), 'Operatorul a refuzat sync-ul.', 'err');
      } else {
        setStatus($('liveStatus'), 'Operatorul a aprobat sync-ul proiectorului.', 'ok');
      }
    });
    // V21.7: when admin starts/stops the active event for the org, the
    // worship header / Setlist / Live-mode picker must follow without a
    // page reload. The server already emits active_event_changed
    // globally (io.emit) on /activate, on event-delete reassignment,
    // and on auto-activate of a new event. Re-running loadLiveEvent
    // owns the whole cascade: it re-fetches ?mode=live, updates the
    // header, swaps currentEvent, and re-renders Setlist + Live mode.
    masterSocket.on('active_event_changed', () => {
      loadLiveEvent();
    });
    // WORSHIP-SYNC — every worship master reflects live verse/song changes made
    // by ANOTHER master, so everyone with control sees the same live state
    // instantly. The server already broadcasts worship:state_change to the
    // worship:<id> room on every POST /verse; worship.js just wasn't listening.
    // (Hints stay single-leader — this is ONLY shared live state.)
    //
    // Echo handling: the payload's only source field is state.lastUpdatedBy, a
    // COARSE role ('worship'/'operator'/null) — every worship master writes
    // 'worship', so it can't tell my change from another master's, and the
    // client has no access to its own session id. So we suppress the echo by
    // value: if the incoming state already equals my live state (the usual case
    // right after I changed it), it's a no-op → skip, avoiding any visual jump
    // on my own change. A genuine change from another master differs → applied.
    //
    // This handler only READS + re-renders; it never calls setLiveVerse/
    // changeLiveSong, so it can't POST or loop the broadcast between masters.
    masterSocket.on('worship:state_change', (payload) => {
      if (!payload || !payload.state || !currentEvent) return;
      if (payload.eventId && payload.eventId !== currentEvent.id) return;
      const st = payload.state;
      const incomingSong = st.currentSongId || null;
      const incomingVerse = Number.isInteger(st.currentVerseIndex) ? st.currentVerseIndex : 0;
      const incomingEnded = st.ended === true;
      // Echo / no-op suppression (see note above).
      if (incomingSong === liveCurrentSongId &&
          incomingVerse === liveCurrentVerseIndex &&
          incomingEnded === liveEnded) {
        return;
      }
      // Mirror into the local event state so a later refreshLiveMode (e.g. when
      // entering Live mode) restores THIS state, not a stale one.
      if (currentEvent.worshipState && typeof currentEvent.worshipState === 'object') {
        currentEvent.worshipState.currentSongId = incomingSong;
        currentEvent.worshipState.currentVerseIndex = incomingVerse;
        currentEvent.worshipState.ended = incomingEnded;
      } else {
        currentEvent.worshipState = {
          currentSongId: incomingSong,
          currentVerseIndex: incomingVerse,
          ended: incomingEnded
        };
      }
      // Apply to the live module state.
      liveCurrentSongId = incomingSong;
      liveCurrentVerseIndex = incomingVerse;
      liveEnded = incomingEnded;
      // Re-render only when in Live mode — refreshLiveMode re-populates the song
      // picker + verse view, so a song switch by another master shows too. When
      // not in Live mode the mirror above is enough; entering Live mode applies it.
      if (liveMode === 'live') refreshLiveMode();
      checkPendingHints(liveCurrentVerseIndex);   // FAZA C — declanșare și prin sync de la alt master
    });
    // V21.8: operator suggested a song. Show the accept/decline modal —
    // the master picks. Decline marks the request declined; Accept moves
    // worshipState via the sync-response endpoint, which broadcasts to
    // members + operator. Verse defaults to 0 server-side.
    masterSocket.on('worship:operator_push', (data) => {
      if (!data || !currentEvent || data.eventId !== currentEvent.id) return;
      pendingOperatorPush = data.request || null;
      const titleEl = $('worshipPushSongTitle');
      if (titleEl) titleEl.textContent = data.songTitle || 'Cântare';
      $('worshipPushModal').classList.remove('hidden');
    });
    // V21.6: live sync of event.songLibrary. The broadcast carries the
    // raw library (no per-session addedByWorship), so we refetch the
    // worship-scoped detail to keep the "adăugat de tine" flag and the
    // Delete button correct for this session.
    masterSocket.on('event:songlibrary_changed', async (data) => {
      if (!data || !data.eventId) return;
      // V21.x: race-safe — when active_event_changed fires immediately
      // before this (admin activate + add in quick succession), the
      // active_event_changed handler is still re-fetching and
      // currentEvent may not yet be set. liveEvent is populated first
      // in loadLiveEvent, so use it as the source of truth for which
      // event this worship is attached to.
      const myId = (liveEvent && liveEvent.id) || (currentEvent && currentEvent.id);
      if (!myId || myId !== data.eventId) return;
      try {
        const r = await fetch('/api/worship/events/' + encodeURIComponent(data.eventId));
        const j = await r.json().catch(() => ({}));
        if (r.ok && j && j.ok && j.event) {
          currentEvent = j.event;
          renderEventSongs();
          // Keep Live mode's song picker fresh too (new song may need it).
          refreshLiveMode();
        }
      } catch (err) { /* render stale state is fine */ }
    });
    // WORSHIP-LEADER: leadership changes for the event. The broadcast is the
    // single source of truth — set isWorshipLeader by comparing the announced
    // leaderId to my own socket id.
    masterSocket.on('worship:leader', (d) => {
      if (!d) return;
      currentLeaderId = d.active ? d.leaderId : null;
      isWorshipLeader = !!(d.active && d.leaderId && d.leaderId === masterSocket.id);
      renderLeaderUI();
    });
    // WORSHIP-LEADER: a hint from the leader. The leader doesn't need a banner
    // of their own hint (they triggered it), so only non-leaders show it.
    masterSocket.on('worship:hint', (h) => {
      // WORSHIP-COUNTDOWN — countdown e văzut de TOȚI (inclusiv liderul), banner separat de hint
      if (h && h.type === 'countdown') { showCountdownOverlay(); return; }
      // WORSHIP-NOTES-FIX — nota e văzută de TOȚI (inclusiv liderul, ca referință)
      if (h && h.type === 'note') { showWorshipHintBanner(h); return; }
      // WORSHIP-ROLES-3 — mesaj de la admin țintit pe rol (deja filtrat server-side); toți primitorii îl arată
      if (h && h.type === 'admin_msg') { showWorshipHintBanner(h); return; }
      if (!isWorshipLeader) showWorshipHintBanner(h);
    });
    masterHeartbeatTimer = setInterval(() => {
      if (masterSocket && masterSocket.connected && currentEvent) {
        masterSocket.emit('worship:master:heartbeat', { eventId: currentEvent.id });
      }
    }, 20000);
  }

  // V21.8: accept / decline an operator push. Accept moves worshipState
  // via /sync-response (which broadcasts state_change to members and the
  // operator's panel); we also apply the response to the local Live mode
  // UI so the picker + verse update on the master tablet.
  async function respondToOperatorPush(accept) {
    if (!currentEvent || !pendingOperatorPush) return;
    const requestId = pendingOperatorPush.id;
    const acceptBtn = $('worshipPushAcceptBtn');
    const declineBtn = $('worshipPushDeclineBtn');
    if (acceptBtn) acceptBtn.disabled = true;
    if (declineBtn) declineBtn.disabled = true;
    try {
      const res = await fetch('/api/worship/events/' + encodeURIComponent(currentEvent.id) + '/sync-response', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, accept: !!accept })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'Răspuns eșuat.');
      if (accept && data.worshipState) {
        // Apply server-confirmed state to the local Live mode picker.
        if (liveMode !== 'live') toggleMode('live');
        liveCurrentSongId = data.worshipState.currentSongId || null;
        liveCurrentVerseIndex = Number.isInteger(data.worshipState.currentVerseIndex)
          ? data.worshipState.currentVerseIndex : 0;
        // V21.22: accepting a push exits END (server already cleared it).
        liveEnded = false;
        refreshLiveMode();
        setStatus($('liveStatus'), 'Cântare primită de la operator · strofa ' + (liveCurrentVerseIndex + 1), 'ok');
      }
    } catch (err) {
      alert('Eroare: ' + err.message);
    } finally {
      if (acceptBtn) acceptBtn.disabled = false;
      if (declineBtn) declineBtn.disabled = false;
      pendingOperatorPush = null;
      $('worshipPushModal').classList.add('hidden');
    }
  }

  async function requestProjectorSync() {
    if (!currentEvent) { alert('Selectează un event.'); return; }
    if (!liveCurrentSongId) {
      setStatus($('liveStatus'), 'Alege o cântare în Live mode mai întâi.', 'err');
      return;
    }
    const btn = $('worshipSyncProjectorBtn');
    if (btn) btn.disabled = true;
    try {
      const res = await fetch('/api/worship/events/' + encodeURIComponent(currentEvent.id) + '/sync-request', {
        method: 'POST'
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'Cererea a eșuat.');
      pendingSyncId = data.requestId;
      setStatus($('liveStatus'), 'Cerere trimisă — aștept aprobarea operatorului…', '');
    } catch (err) {
      setStatus($('liveStatus'), err.message, 'err');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // --- WORSHIP-LEADER: designated leader + hints ---
  // Map a hint object to its banner text. Shared shape with worship-view.js
  // (no bundler here, so the mapping is intentionally duplicated there).
  function worshipHintText(h) {
    if (!h || typeof h !== 'object') return '';
    switch (h.type) {
      case 'repeat': return '🔁 Repetăm strofa';
      case 'next': return '⏭ Strofa următoare';
      case 'chorus': return '🎶 Refren';
      case 'jump_verse': return '➡ Strofa ' + (Number(h.verseIndex) + 1);
      case 'change_key': return '🎵 Gama: ' + (h.key || '');
      case 'transpose': return h.text || '🎵 Transpunere gamă';
      case 'jump_song': return '🎶 ' + (h.text || 'Altă cântare');
      case 'note': return '📝 ' + (h.text || '');
      case 'admin_msg': return '📢 ' + (h.text || '');
      case 'free': return h.text || '';
      default: return h.text || '';
    }
  }

  // WORSHIP-NOTES-FIX — nota aparține worship admin (non-lider): vede textul + butonul de push.
  // Liderul NU vede nota local de aici — o vede ca banner separat când i se face push (receptor 'note').
  function renderLiveSectionNote() {
    const el = document.getElementById('liveSectionNote');
    const btn = document.getElementById('worshipSendNoteBtn');
    const song = getLiveSong();
    const notes = (song && Array.isArray(song.sectionNotes)) ? song.sectionNotes : [];
    const note = notes[liveCurrentVerseIndex] || '';
    // WORSHIP-ROLES-2 — gate canAdmin DOAR pentru sesiuni cu rol; PIN global (_myRole='') = compat
    // (vede & poate trimite ca înainte). Liderul (worship master cu role activ) NU vede aici (vezi banner).
    const hasAdminCap = (_myRole === '' /* PIN global compat */) || _myCanAdmin;
    const showForAdmin = !!(note && !isWorshipLeader && hasAdminCap);
    if (el) {
      if (showForAdmin) { el.textContent = '📝 ' + note; el.classList.remove('hidden'); }
      else { el.textContent = ''; el.classList.add('hidden'); }
    }
    if (btn) {
      if (showForAdmin) btn.classList.remove('hidden');
      else btn.classList.add('hidden');
    }
  }

  // A single fixed banner overlay. A new hint replaces the text in place; the
  // banner stays until the × is pressed. textContent (not innerHTML) keeps
  // free-text hints inert against injection.
  // Banner de hint: poziționat SUS, deasupra strofei (nu o acoperă), calculat dinamic față de
  // #liveVerseText. Dispare automat după 5s; butonul × închide mai devreme. textContent = inert la injection.
  let _hintBannerTimer = null;
  function showWorshipHintBanner(hint) {
    const text = worshipHintText(hint);
    if (!text) return;
    let banner = document.querySelector('.worship-hint-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'worship-hint-banner';
      const span = document.createElement('span');
      span.className = 'whb-text';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'whb-close';
      close.setAttribute('aria-label', 'Închide');
      close.textContent = '×';
      close.addEventListener('click', () => {
        if (_hintBannerTimer) { clearTimeout(_hintBannerTimer); _hintBannerTimer = null; }
        banner.remove();
      });
      banner.appendChild(span);
      banner.appendChild(close);
      document.body.appendChild(banner);
    }
    banner.querySelector('.whb-text').textContent = text;
    positionHintBannerAboveVerse(banner);
    if (_hintBannerTimer) clearTimeout(_hintBannerTimer);
    _hintBannerTimer = setTimeout(() => { _hintBannerTimer = null; if (banner) banner.remove(); }, 5000);
  }

  // Calculează poziția banner-ului ca să stea DEASUPRA marginii de sus a strofei (#liveVerseText),
  // fără s-o acopere. Dacă nu încape, rămâne lipit de marginea de sus a ecranului.
  function positionHintBannerAboveVerse(banner) {
    const verse = document.getElementById('liveVerseText');
    banner.style.top = '12px';
    banner.style.bottom = 'auto';
    if (!verse) return;
    requestAnimationFrame(() => {
      const vRect = verse.getBoundingClientRect();
      const bH = banner.offsetHeight || 80;
      let top = vRect.top - bH - 12;
      if (top < 8) top = 8;
      banner.style.top = top + 'px';
    });
  }

  // Reflect the leader role in the toolbar: when leader, show the hint panel
  // and refresh its dynamic selects; otherwise hide it and note who's leading.
  function renderLeaderUI() {
    const btn = $('worshipLeaderToggleBtn');
    const status = $('worshipLeaderStatus');
    const controls = $('worshipLeaderControls');
    const livePanel = $('worshipLiveMode');   // FAZA D — container pentru clasa leader-mode
    const appRoot = $('worshipApp');          // WORSHIP-LEADER-MOBILE — container mare (header/info/switcher)
    if (!btn || !controls) return;
    if (isWorshipLeader) {
      btn.textContent = '🎹 Ești lider (eliberează)';
      btn.classList.add('btn-confirmed');
      controls.classList.remove('hidden');
      if (livePanel) livePanel.classList.add('leader-mode');   // FAZA D — UI optimizat pt control
      if (appRoot) appRoot.classList.add('leader-mode');       // WORSHIP-LEADER-MOBILE — ascunde header/info
      if (status) status.textContent = 'Trimiți hinturi echipei și pe proiector.';
      populateLeaderSelects();
    } else {
      btn.textContent = '🎹 Sunt lider';
      btn.classList.remove('btn-confirmed');
      controls.classList.add('hidden');
      if (livePanel) livePanel.classList.remove('leader-mode');   // FAZA D — revine la normal
      if (appRoot) appRoot.classList.remove('leader-mode');       // WORSHIP-LEADER-MOBILE — revine la normal
      if (status) status.textContent = currentLeaderId ? 'Lider activ: altcineva (apasă pentru a prelua)' : '';
    }
    renderLiveSectionNote();   // WORSHIP-NOTES-2 — show/hide nota când se schimbă rolul
  }

  // Fill the gamă select (predefined keys) and the jump-song select (current
  // event songs). Cheap; safe to call on every live-mode refresh.
  function populateLeaderSelects() {
    const keySel = $('worshipHintKeySelect');
    if (keySel) {
      keySel.innerHTML = '<option value="">— gamă —</option>' +
        SONG_KEYS.map((k) => '<option value="' + k + '">' + k + '</option>').join('');
    }
    const songSel = $('worshipHintSongSelect');
    if (songSel) {
      const songs = (currentEvent && Array.isArray(currentEvent.songs)) ? currentEvent.songs : [];
      // WORSHIP-LIVE-KEY: same number + key treatment as the main live picker.
      songSel.innerHTML = '<option value="">— cântare —</option>' +
        songs.map((s, idx) => '<option value="' + escapeHtml(s.id) + '">' +
          (idx + 1) + '. ' + escapeHtml(s.title || 'Fără titlu') +
          (s.key ? ' [' + escapeHtml(s.key) + ']' : '') + '</option>').join('');
    }
  }

  function toggleLeader() {
    if (!currentEvent || !masterSocket) return;
    if (isWorshipLeader) {
      masterSocket.emit('worship:leader:release', { eventId: currentEvent.id });
      return;
    }
    // WORSHIP-ROLES-2 — gate canLead, DOAR pentru sesiuni cu rol (compat: login cu PIN global = _myRole gol → trece)
    if (_myRole && !_myCanLead) {
      setStatus($('liveStatus'), 'Rolul tău („' + _myRole + '") nu poate fi lider.', 'warn');
      return;
    }
    // Make sure we're in the worship room first so we receive our own
    // confirming `worship:leader` broadcast.
    joinMasterRoom();
    masterSocket.emit('worship:leader:claim', { eventId: currentEvent.id });
  }

  // WORSHIP-COUNTDOWN — overlay 3-2-1-GO afișat la toți (lider + echipă + proiector)
  let _countdownTimer = null;
  function showCountdownOverlay() {
    let ov = document.getElementById('worshipCountdownOverlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'worshipCountdownOverlay';
      ov.className = 'worship-countdown-overlay';
      document.body.appendChild(ov);
    }
    const steps = ['3', '2', '1', 'GO'];
    let i = 0;
    if (_countdownTimer) clearInterval(_countdownTimer);
    const tick = () => {
      if (i >= steps.length) {
        clearInterval(_countdownTimer); _countdownTimer = null;
        ov.style.display = 'none';
        return;
      }
      ov.textContent = steps[i];
      ov.classList.remove('cd-pulse'); void ov.offsetWidth; ov.classList.add('cd-pulse');
      ov.classList.toggle('cd-go', steps[i] === 'GO');
      ov.style.display = 'flex';
      i++;
    };
    tick();
    _countdownTimer = setInterval(tick, 700);
  }

  function sendHint(p) {
    if (!isWorshipLeader || !currentEvent || !masterSocket) return;
    masterSocket.emit('worship:hint', Object.assign({}, p, { eventId: currentEvent.id }));
  }

  // WORSHIP-NOTES-FIX — push notă de la worship admin (non-lider): NU cere isWorshipLeader.
  // Serverul acceptă type 'note' de la orice master worship (vezi socket/handlers.js).
  function sendNote(text) {
    if (!currentEvent || !masterSocket) return;
    masterSocket.emit('worship:hint', { type: 'note', text, eventId: currentEvent.id });
  }

  // WORSHIP-BTN-FEEDBACK — feedback vizual pe butonul care a declanșat o trimitere la echipă
  function flashButtonSent(btn) {
    if (!btn) return;
    btn.classList.remove('btn-sent'); void btn.offsetWidth;   // reset animație
    btn.classList.add('btn-sent');
    setTimeout(() => btn.classList.remove('btn-sent'), 900);
  }
  function pressFeedback(btn) {
    if (!btn) return;
    btn.classList.add('btn-pressed');
    setTimeout(() => btn.classList.remove('btn-pressed'), 180);
  }

  // WORSHIP-SCHEDULE-B — hinturi programate (selector „Când")
  // Aplicarea efectivă la moment = FAZA C; aici doar coada + UI.
  let _pendingHints = [];   // { id, hint, when, label, action }
  const WHEN_LABELS = { now: 'Acum', next_verse: 'Următorul vers',
                        next_strofa: 'Următoarea strofă', next_refren: 'Următorul refren',
                        next_pod: 'Următorul pod' };
  const WHEN_SECTION = { next_strofa: 'verse', next_refren: 'chorus', next_pod: 'bridge' };
  // WORSHIP-COUNTDOWN — nimic selectat default; liderul alege conștient (pastila „Acum" inclusă).
  // Persistă între dispatch-uri (nu reset) — liderul poate programa mai multe la același moment.
  let _whenValue = null;
  function getWhenValue() { return _whenValue; }
  // dispatchHint(hint, action?): la 'now', cheamă action() + sendHint(hint); altfel, doar
  // queue (action e păstrat pt FAZA C, ca să-l execute la trigger).
  function dispatchHint(hint, action) {
    const when = getWhenValue();
    // WORSHIP-COUNTDOWN — gardă: liderul trebuie să aleagă conștient un moment înainte să trimită hint
    if (!when) {
      setStatus($('liveStatus'), 'Alege momentul („Când se aplică") întâi.', 'warn');
      return;
    }
    if (when === 'now') {
      if (typeof action === 'function') { try { action(); } catch (_) {} }
      sendHint(hint);
      return;
    }
    const id = 'ph_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    _pendingHints.push({ id, hint, when, label: WHEN_LABELS[when] || when, action: action || null });
    renderPendingHints();
    setStatus($('liveStatus'), 'Hint programat: ' + (WHEN_LABELS[when] || when), 'ok');
  }
  function renderPendingHints() {
    const box = $('worshipPendingHints');
    if (!box) return;
    if (!_pendingHints.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="pending-title">În așteptare:</div>' + _pendingHints.map((p) =>
      '<div class="pending-hint-row" data-pending-id="' + p.id + '">' +
        '<span class="pending-when">⏱ ' + escapeHtml(p.label) + '</span>' +
        '<span class="pending-text">' + escapeHtml(worshipHintText(p.hint) || '') + '</span>' +
        '<button class="btn btn-sm pending-cancel" type="button" data-cancel-pending="' + p.id + '">✕</button>' +
      '</div>').join('');
    box.querySelectorAll('[data-cancel-pending]').forEach((b) =>
      b.addEventListener('click', () => {
        const id = b.getAttribute('data-cancel-pending');
        _pendingHints = _pendingHints.filter((x) => x.id !== id);
        renderPendingHints();
      }));
  }

  // FAZA C — motor de aplicare: hinturile programate se declanșează când se ajunge
  // la versul-țintă (next_verse = orice schimbare; next_strofa/refren/pod = match pe
  // sections[newVerseIndex] din WORSHIP-SECTIONS-A). Re-entry guard pentru cazul în care
  // o acțiune declanșată (ex. liveNext) provoacă un nou setLiveVerse → checkPendingHints.
  let _checkingPending = false;
  function checkPendingHints(newVerseIndex) {
    if (_checkingPending) return;
    if (!_pendingHints.length) return;
    _checkingPending = true;
    try {
      const song = getLiveSong();
      const sections = (song && Array.isArray(song.sections)) ? song.sections : [];
      const sectionAtNew = sections[newVerseIndex] || 'verse';
      let applied = false;
      _pendingHints = _pendingHints.filter((p) => {
        const isVerseTrigger = (p.when === 'next_verse');
        const targetSection = WHEN_SECTION[p.when];   // undefined pt next_verse
        const matches = isVerseTrigger || (targetSection && sectionAtNew === targetSection);
        if (!matches) return true;   // încă nu — păstrează în coadă
        // WORSHIP-COUNTDOWN (A) — anunță schimbarea cu 3-2-1-GO la toți, apoi aplică pe GO
        showCountdownOverlay();
        sendHint({ type: 'countdown' });
        const act = p.action;
        const hintPayload = p.hint;
        setTimeout(() => {
          try { if (typeof act === 'function') act(); }
          catch (e) { console.warn('pending action failed', e); }
          sendHint(hintPayload);
        }, 2100);   // după 3-2-1 (3×700ms), pe „GO"
        applied = true;
        return false;   // scoate din coadă
      });
      if (applied) renderPendingHints();
    } finally {
      _checkingPending = false;
    }
  }

  // --- V21.4-FIX: FULLSCREEN ---
  // Native Fullscreen API where supported; CSS fallback for iOS Safari which
  // does not expose requestFullscreen on arbitrary elements.
  let isLiveFullscreen = false;

  function enterFullscreenFallback() {
    $('liveFullscreenContainer').classList.add('live-fullscreen-fallback');
    document.body.classList.add('live-fullscreen-active');
  }
  function exitFullscreenFallback() {
    $('liveFullscreenContainer').classList.remove('live-fullscreen-fallback');
    document.body.classList.remove('live-fullscreen-active');
  }

  function setFullscreenUi(on) {
    isLiveFullscreen = on;
    $('liveExitFullscreenBtn').classList.toggle('hidden', !on);
    const btn = $('liveFullscreenBtn');
    if (btn) btn.textContent = on ? '✕ Ieși din fullscreen' : '⛶ Fullscreen';
    if (on) renderLiveMode(); // re-scroll mini-list into view inside the new layout
  }

  async function toggleLiveFullscreen() {
    const container = $('liveFullscreenContainer');
    if (!container) return;
    if (!isLiveFullscreen) {
      // V21.4-FIX9: try the STANDARD API first with explicit
      // navigationUI:'hide'. On Chrome iOS 124+ / Safari iOS 16.4+ that
      // hides the browser's own URL bar + toolbar — the CSS fallback
      // cannot do that, only the native API can. Older browsers ignore
      // the option or fall through to webkit / fallback.
      if (typeof container.requestFullscreen === 'function') {
        try {
          await container.requestFullscreen({ navigationUI: 'hide' });
          setFullscreenUi(true);
          return;
        } catch (err) { /* fall through */ }
      }
      if (typeof container.webkitRequestFullscreen === 'function') {
        try {
          await container.webkitRequestFullscreen();
          setFullscreenUi(true);
          return;
        } catch (err) { /* fall through */ }
      }
      enterFullscreenFallback();
      setFullscreenUi(true);
    } else {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        try { await (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (err) {}
      }
      exitFullscreenFallback();
      setFullscreenUi(false);
    }
  }

  // Keep UI in sync if the user exits fullscreen via ESC / browser chrome.
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && isLiveFullscreen) {
      exitFullscreenFallback();
      setFullscreenUi(false);
    }
  });
  document.addEventListener('webkitfullscreenchange', () => {
    if (!document.webkitFullscreenElement && isLiveFullscreen) {
      exitFullscreenFallback();
      setFullscreenUi(false);
    }
  });

  // --- V21.13: LYRICS FONT SIZE (master) ---
  function applyLiveFontSize() {
    const el = $('liveVerseText');
    if (el) el.style.fontSize = liveFontSize + 'px';
  }
  function changeLiveFontSize(delta) {
    liveFontSize = Math.max(LIVE_FONT_MIN, Math.min(LIVE_FONT_MAX, liveFontSize + delta));
    applyLiveFontSize();
  }

  // --- LISTENERS ---
  // WORSHIP-DRAFT-2 — worship creează un eveniment draft (nume minim); admin îl aprobă ulterior
  async function createWorshipDraft() {
    const name = prompt('Nume eveniment nou (ex. „Repetiție duminică"):', '');
    if (name === null) return;
    const trimmed = String(name).trim();
    if (!trimmed) { alert('Numele e obligatoriu.'); return; }
    try {
      const res = await fetch('/api/worship/events/create-draft', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ name: trimmed })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'Creare eșuată.');
      pickerEventsLoaded = false;
      await loadEventDetail(data.eventId);
      const setlistBtn = document.querySelector('[data-worship-mode="setlist"]');
      if (setlistBtn) setlistBtn.click();
      alert('Eveniment creat: „' + data.name + '". Adaugă cântări; un admin îl va aproba și pune live.');
    } catch (err) {
      alert('Eroare: ' + err.message);
    }
  }

  function attachListeners() {
    $('worshipLoginBtn').addEventListener('click', doLogin);
    $('worshipPinInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doLogin(); }
    });
    $('worshipLogoutBtn').addEventListener('click', doLogout);
    // WORSHIP-DRAFT-2 — buton de creare draft (one-time bind, lângă Logout)
    $('worshipCreateDraftBtn')?.addEventListener('click', createWorshipDraft);
    // WORSHIP-EVENT-DROPDOWN-B — schimbarea selecției încarcă evenimentul
    $('worshipEventDropdown')?.addEventListener('change', async (e) => {
      const id = e.target.value;
      if (id) await loadEventDetail(id);
    });

    // V21.5: dropdown removed — header now shows the live event read-only.
    // No change-listener needed; loadLiveEvent owns the single event source.

    // V21.15: one unified field. Library filters instantly (debounced);
    // Enter additionally fires the resurse search.
    let librarySearchDebounce;
    $('globalSongLibrarySearch').addEventListener('input', (e) => {
      const val = e.target.value;
      clearTimeout(librarySearchDebounce);
      librarySearchDebounce = setTimeout(() => renderLibrary(val), 220);
      // Resurse results are stale once the query changes — hide until re-run.
      const resurseSection = document.querySelector('.unified-search-resurse-section');
      if (resurseSection) resurseSection.classList.add('hidden');
      // WORSHIP-SEARCH-OPENS-LIBRARY — deschide rezultatele când userul caută ceva
      const resultsDd = document.getElementById('libraryResultsDropdown');
      if (resultsDd && val.trim()) resultsDd.open = true;
    });
    // V21.39: select-all on focus so re-tap replaces the previous query in
    // one keypress. setTimeout(0) sidesteps mouseup-deselect on click-focus.
    $('globalSongLibrarySearch').addEventListener('focus', (e) => {
      setTimeout(() => { try { e.target.select(); } catch (_) {} }, 0);
    });
    $('globalSongLibrarySearch').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doImportOrSearch();
        setTimeout(() => { try { e.target.select(); } catch (_) {} }, 0);  // V21.40: select query after search
      }
    });

    // V21.5: per-card picker — click on an event option adds the song.
    $('globalSongLibraryList').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-worship-picker-event]');
      if (!btn || btn.disabled) return;
      addSongToSpecificEvent(
        btn.getAttribute('data-worship-picker-event'),
        btn.getAttribute('data-worship-picker-song'),
        btn
      );
    });
    // toggle does NOT bubble — capture phase catches it on the way down.
    $('globalSongLibraryList').addEventListener('toggle', (e) => {
      const picker = e.target;
      if (!picker || !picker.matches || !picker.matches('.add-to-event-picker') || !picker.open) return;
      const listEl = picker.querySelector('.add-to-event-list');
      if (!listEl) return;
      ensurePickerEvents().then(() => {
        renderAddToEventPicker(listEl.getAttribute('data-library-song-id'), listEl);
      });
    }, true);

    $('eventSongsList').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-event-song-delete]');
      if (!btn) return;
      deleteOwnSong(btn.dataset.eventSongDelete);
    });

    $('importUrlBtn').addEventListener('click', doImportOrSearch);
    $('songSaveBtn').addEventListener('click', saveSongInLibrary);
    $('songClearBtn').addEventListener('click', clearSongEditor);

    // V21.1: Live mode
    document.querySelectorAll('[data-worship-mode]').forEach((b) => {
      b.addEventListener('click', () => toggleMode(b.dataset.worshipMode));
    });
    $('liveSongSelect').addEventListener('change', (e) => changeLiveSong(e.target.value));
    // V21.22: navigation goes through liveNext/livePrev so END semantics
    // (right-arrow → END on last verse; left-arrow exits END) are honored.
    $('liveVersePrev').addEventListener('click', livePrev);
    $('liveVerseNext').addEventListener('click', liveNext);
    $('liveVerseList').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-verse-index]');
      if (btn) setLiveVerse(parseInt(btn.dataset.verseIndex, 10));
    });
    attachSwipeHandlers();
    attachPinchZoom();

    // V21.2: Share with team (QR)
    $('worshipShareBtn').addEventListener('click', shareWithTeam);
    $('worshipQrCloseBtn').addEventListener('click', closeQrModal);
    $('worshipQrCopyBtn').addEventListener('click', copyQrLink);

    // V21.3: projector sync request
    $('worshipSyncProjectorBtn').addEventListener('click', requestProjectorSync);

    // V21.8: operator push accept/decline
    $('worshipPushAcceptBtn').addEventListener('click', () => respondToOperatorPush(true));
    $('worshipPushDeclineBtn').addEventListener('click', () => respondToOperatorPush(false));

    // V21.4-FIX: fullscreen toggle (enter via toolbar, exit via corner X)
    $('liveFullscreenBtn').addEventListener('click', toggleLiveFullscreen);
    $('liveExitFullscreenBtn').addEventListener('click', toggleLiveFullscreen);

    // V21.13: lyrics font size +/- (works in both normal and fullscreen)
    $('liveFontDecrease').addEventListener('click', () => changeLiveFontSize(-2));
    $('liveFontIncrease').addEventListener('click', () => changeLiveFontSize(2));
    applyLiveFontSize();

    // WORSHIP-LEADER: claim/release + hint controls. Action hints reuse the
    // existing live navigation (liveNext / setLiveVerse / changeLiveSong) so
    // the live worship state moves through the one canonical path; the hint
    // itself is only the banner signal.
    $('worshipLeaderToggleBtn').addEventListener('click', toggleLeader);
    document.querySelectorAll('#worshipLeaderControls [data-hint]').forEach((b) => {
      b.addEventListener('click', () => {
        pressFeedback(b);
        const wasNow = getWhenValue() === 'now';
        const t = b.getAttribute('data-hint');
        if (t === 'next') dispatchHint({ type: 'next' }, () => liveNext());
        else if (t === 'repeat') dispatchHint({ type: 'repeat' }, () => setLiveVerse(liveCurrentVerseIndex));
        else if (t === 'chorus') dispatchHint({ type: 'chorus' });
        if (wasNow) flashButtonSent(b);
      });
    });
    // WORSHIP-WHEN-CARD — selectează momentul (one-touch), evidențiază butonul activ
    document.querySelectorAll('#worshipWhenOptions .when-pill').forEach((btn) => {
      // WORSHIP-COUNTDOWN-MOVE — exclude butonul de acțiune (fără data-when) din selecția de momente
      if (!btn.getAttribute('data-when')) return;
      btn.addEventListener('click', () => {
        _whenValue = btn.getAttribute('data-when');
        document.querySelectorAll('#worshipWhenOptions .when-pill').forEach((b) =>
          b.classList.toggle('active', b === btn));
      });
    });
    $('worshipHintKeySelect').addEventListener('change', (e) => {
      const key = e.target.value;
      if (key) dispatchHint({ type: 'change_key', key });
    });
    // WORSHIP-KEY-TRANSPOSE — +/− semiton din gama cântării curente, cumulativ
    let _keyStepAccum = 0;
    let _keyStepTimer = null;
    // Acțiunea pură de transpunere (folosită + la „now" cumulativ, + la apply în FAZA C)
    function _applyTranspose(direction) {
      const song = getLiveSong();
      if (!song || !song.key) return;
      const newKey = transposeKey(song.key, direction);
      if (newKey && newKey !== song.key) saveSongKey(song.id, newKey);
    }
    function stepKey(direction) {
      // WORSHIP-SCHEDULE-B — pe „nu acum" doar queue (aplicare la FAZA C, fără cumulativ)
      if (getWhenValue() !== 'now') {
        const arrow = direction > 0 ? '↑' : '↓';
        const sign = direction > 0 ? '+' : '';
        dispatchHint(
          { type: 'transpose', text: `${arrow} ${sign}${direction} semiton (programat)` },
          () => _applyTranspose(direction)
        );
        return;
      }
      // path „now" — comportament existent (cumulativ + banner cu „acum: <newKey>")
      const song = getLiveSong();
      if (!song) { setStatus($('liveStatus'), 'Selectează o cântare întâi.', 'warn'); return; }
      const currentKey = song.key || '';
      if (!currentKey) { setStatus($('liveStatus'), 'Cântarea nu are gamă setată.', 'warn'); return; }
      const newKey = transposeKey(currentKey, direction);
      if (newKey === currentKey) { setStatus($('liveStatus'), 'Gamă custom — nu pot transpune.', 'warn'); return; }
      saveSongKey(song.id, newKey);   // mută gama real (re-randează din WORSHIP-SONGS)
      _keyStepAccum += direction;
      if (_keyStepTimer) clearTimeout(_keyStepTimer);
      _keyStepTimer = setTimeout(() => { _keyStepAccum = 0; }, 1500);
      const n = _keyStepAccum;
      const arrow = n > 0 ? '↑' : (n < 0 ? '↓' : '↔');
      const sign = n > 0 ? '+' : '';
      const word = (Math.abs(n) === 1) ? 'semiton' : 'semitoni';
      sendHint({ type: 'transpose', text: `${arrow} ${sign}${n} ${word} (acum: ${newKey})` });
    }
    $('worshipKeyUpBtn')?.addEventListener('click', (e) => {
      pressFeedback(e.currentTarget);
      const wasNow = getWhenValue() === 'now';
      stepKey(1);
      if (wasNow) flashButtonSent(e.currentTarget);
    });
    $('worshipKeyDownBtn')?.addEventListener('click', (e) => {
      pressFeedback(e.currentTarget);
      const wasNow = getWhenValue() === 'now';
      stepKey(-1);
      if (wasNow) flashButtonSent(e.currentTarget);
    });
    $('worshipHintSongSelect').addEventListener('change', (e) => {
      const songId = e.target.value;
      if (!songId) return;
      const song = (currentEvent && currentEvent.songs || []).find((s) => String(s.id) === String(songId));
      const hint = { type: 'jump_song', songId, text: song ? (song.title || 'Cântare') : 'Cântare' };
      dispatchHint(hint, () => changeLiveSong(songId));
    });
    $('worshipHintFreeBtn').addEventListener('click', () => {
      const inp = $('worshipHintFreeInput');
      const text = (inp.value || '').trim();
      if (!text) return;
      dispatchHint({ type: 'free', text });
      inp.value = '';
    });
    // WORSHIP-NOTES-FIX — push notă de la worship admin (non-lider) la echipă + liderul-referință.
    // Foloseste sendNote (nu sendHint, care cere isWorshipLeader). Proiectorul ignoră 'note'.
    $('worshipSendNoteBtn')?.addEventListener('click', (e) => {
      const song = getLiveSong();
      const notes = (song && Array.isArray(song.sectionNotes)) ? song.sectionNotes : [];
      const note = notes[liveCurrentVerseIndex] || '';
      if (!note) { setStatus($('liveStatus'), 'Nicio notă pe blocul curent.', 'warn'); return; }
      pressFeedback(e.currentTarget);
      sendNote(note);
      flashButtonSent(e.currentTarget);
    });
    // WORSHIP-COUNTDOWN — buton manual: instant pt toți (lider+echipă+proiector), NU trece prin „Când"
    $('worshipCountdownBtn')?.addEventListener('click', (e) => {
      pressFeedback(e.currentTarget);
      showCountdownOverlay();
      sendHint({ type: 'countdown' });
      flashButtonSent(e.currentTarget);
    });

    $('importUrlResults').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-import-result-url]');
      if (!btn || btn.disabled) return;
      const url = btn.dataset.importResultUrl;
      if (!url) return;
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = '...';
      try {
        const song = await importFromUrl(url);
        if (!acceptImportedSong(song)) {
          btn.disabled = false;
          btn.textContent = original;
          return;
        }
        $('importUrlResults').innerHTML = '';
        setStatus($('importUrlStatus'), 'Importat: „' + song.title + '”. Verifică și salvează.', 'ok');
      } catch (err) {
        btn.disabled = false;
        btn.textContent = original;
        alert('Eroare: ' + err.message);
      }
    });
  }

  // --- INIT ---
  // Probe the existing session: if the worship cookie is still valid (8h
  // window) skip the login screen and go straight to the app. V21.5 probes
  // with ?mode=live so the same response can prime the header display.
  async function init() {
    attachListeners();
    try {
      const res = await fetch('/api/worship/events?mode=live');
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data && data.ok) {
          $('worshipLoginScreen').classList.add('hidden');
          $('worshipApp').classList.remove('hidden');
          // V21.7: open the master socket on app entry so the broadcasts
          // (songlibrary_changed, active_event_changed, sync_request_*)
          // are received regardless of which tab is active.
          initMasterSocket();
          liveEvent = Array.isArray(data.events) && data.events.length ? data.events[0] : null;
          renderLiveEventDisplay();
          if (liveEvent) {
            loadEventDetail(liveEvent.id);
          } else {
            currentEvent = null;
            renderEmptyEventInfo('Nu există event live. Programul se completează când admin pornește un event.');
            renderEventSongs();
            loadLibrary();
          }
          return;
        }
      }
    } catch (err) { /* fall through to login screen */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // V21.19: register the worship master service worker for PWA installability.
  // Scope `/worship` does NOT swallow `/worship-view` because that scope is
  // more specific and is owned by worship-view-sw.js (V21.18) — the most
  // specific matching scope wins. The fetch handler in worship-sw.js also
  // restricts caching to its SHELL list, so even if scopes ever overlapped
  // the worker would not intercept worship-view assets.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('/worship-sw.js', { scope: '/worship' })
        .catch((err) => console.warn('worship SW registration failed:', err && err.message));
    });
  }
})();
