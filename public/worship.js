(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  let currentEvent = null;
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
      renderLiveEventDisplay();
      if (liveEvent) {
        await loadEventDetail(liveEvent.id);
      } else {
        currentEvent = null;
        renderEmptyEventInfo('Nu există event live. Setlist-ul se completează când admin pornește un event.');
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

  function renderLiveEventDisplay() {
    const nameEl = $('worshipLiveEventName');
    const noneEl = $('worshipLiveEventNoActive');
    if (!nameEl || !noneEl) return;
    if (liveEvent) {
      nameEl.textContent = liveEvent.name || 'Event live';
      nameEl.classList.remove('hidden');
      noneEl.classList.add('hidden');
    } else {
      nameEl.classList.add('hidden');
      noneEl.classList.remove('hidden');
    }
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
      $('worshipEventInfo').innerHTML =
        '<div class="event-info-card">' +
        '<strong>' + escapeHtml(currentEvent.name) + '</strong>' +
        '<div class="small muted">' + escapeHtml(formatDate(currentEvent.scheduledAt || currentEvent.scheduledTimestamp)) + '</div>' +
        '</div>';
      renderEventSongs();
      loadLibrary();
      resetLiveForEvent();
    } catch (err) {
      $('worshipEventInfo').innerHTML =
        '<p class="muted">Eroare: ' + escapeHtml(err.message) + '</p>';
    }
  }

  function renderEventSongs() {
    const list = $('eventSongsList');
    const songs = (currentEvent && Array.isArray(currentEvent.songs)) ? currentEvent.songs : [];
    $('eventSongsCount').textContent = String(songs.length);

    if (!songs.length) {
      list.innerHTML = '<p class="muted small">Niciun cântec adăugat încă. Folosește Library de mai jos.</p>';
      return;
    }

    list.innerHTML = songs.map((s) =>
      '<div class="event-song-row" data-event-song-id="' + escapeHtml(s.id) + '">' +
        '<div class="event-song-meta">' +
          '<strong>' + escapeHtml(s.title || 'Fără titlu') + '</strong>' +
          (s.addedByWorship ? '<span class="worship-tag">adăugat de tine</span>' : '') +
        '</div>' +
        (s.addedByWorship
          ? '<button class="btn btn-danger btn-sm" type="button" data-event-song-delete="' + escapeHtml(s.id) + '">Șterge</button>'
          : '') +
      '</div>'
    ).join('');
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

  async function doImportOrSearch() {
    const input = $('importUrlInput');
    const status = $('importUrlStatus');
    const resultsEl = $('importUrlResults');
    const btn = $('importUrlBtn');
    const value = (input.value || '').trim();
    if (!value) {
      setStatus(status, 'Introdu un URL sau cuvinte cheie.', 'err');
      return;
    }
    const isUrl = /^https?:\/\//i.test(value);
    btn.disabled = true;
    setStatus(status, isUrl ? 'Se importă...' : 'Se caută...', '');
    resultsEl.innerHTML = '';
    try {
      if (isUrl) {
        const song = await importFromUrl(value);
        if (!acceptImportedSong(song)) {
          setStatus(status, 'Anulat — cântarea există deja în Library.', 'err');
          return;
        }
        input.value = '';
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
      select.innerHTML = '<option value="">Alege cântarea…</option>' +
        songs.map((s) => '<option value="' + escapeHtml(s.id) + '">' + escapeHtml(s.title || 'Fără titlu') + '</option>').join('');
    }
    // Restore from the server-side worshipState if it points at a known song.
    const ws = currentEvent && currentEvent.worshipState;
    if (ws && ws.currentSongId && songs.some((s) => s.id === ws.currentSongId)) {
      liveCurrentSongId = ws.currentSongId;
      liveCurrentVerseIndex = Number.isInteger(ws.currentVerseIndex) ? ws.currentVerseIndex : 0;
    }
    select.value = liveCurrentSongId || '';
    renderLiveMode();
  }

  function renderLiveMode() {
    const labelEl = $('liveVerseLabel');
    const textEl = $('liveVerseText');
    const posEl = $('liveVersePosition');
    const listEl = $('liveVerseList');
    if (!labelEl || !textEl || !posEl || !listEl) return;
    const song = getLiveSong();
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
    labelEl.textContent = 'Strofa ' + (idx + 1);
    textEl.textContent = verses[idx];
    posEl.textContent = (idx + 1) + ' / ' + verses.length;
    // V21.4-FIX: mini-cards with full verse preview so the master sees
    // upcoming text at a glance. Horizontal scroll; current item auto-scrolls
    // into view after render.
    listEl.innerHTML = verses.map((v, i) =>
      '<button type="button" class="verse-mini-item' + (i === idx ? ' current' : '') +
      '" data-verse-index="' + i + '">' +
        '<div class="verse-mini-label">Strofa ' + (i + 1) + '</div>' +
        '<div class="verse-mini-text">' + escapeHtml(v) + '</div>' +
      '</button>'
    ).join('');
    const currentEl = listEl.querySelector('.verse-mini-item.current');
    if (currentEl && typeof currentEl.scrollIntoView === 'function') {
      currentEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }

  function resetLiveForEvent() {
    liveCurrentSongId = null;
    liveCurrentVerseIndex = 0;
    refreshLiveMode();
    joinMasterRoom();
  }

  async function setLiveVerse(index) {
    const song = getLiveSong();
    if (!song || !currentEvent) return;
    const verses = parseVerses(song.text);
    if (!verses.length) return;
    const clamped = Math.max(0, Math.min(index, verses.length - 1));
    liveCurrentVerseIndex = clamped;
    renderLiveMode();
    try {
      const res = await fetch('/api/worship/events/' + encodeURIComponent(currentEvent.id) + '/verse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ songId: song.id, verseIndex: clamped })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setStatus($('liveStatus'), data.error || 'Sincronizare eșuată.', 'err');
      } else {
        setStatus($('liveStatus'), 'Sincronizat · strofa ' + (clamped + 1), 'ok');
      }
    } catch (err) {
      setStatus($('liveStatus'), 'Eroare rețea: ' + err.message, 'err');
    }
  }

  function changeLiveSong(songId) {
    liveCurrentSongId = songId || null;
    liveCurrentVerseIndex = 0;
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
      setLiveVerse(dx < 0 ? liveCurrentVerseIndex + 1 : liveCurrentVerseIndex - 1);
    }, { passive: true });
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

  function joinMasterRoom() {
    if (masterSocket && masterSocket.connected && currentEvent) {
      masterSocket.emit('worship:master:join', { eventId: currentEvent.id });
    }
  }

  function initMasterSocket() {
    if (masterSocket || typeof io !== 'function') return;
    masterSocket = io();
    masterSocket.on('connect', joinMasterRoom);
    masterSocket.on('worship:master:denied', (d) => {
      setStatus($('liveStatus'), (d && d.message) || 'Conexiune worship respinsă.', 'err');
    });
    masterSocket.on('worship:sync_request_resolved', (data) => {
      if (!data || !pendingSyncId || data.requestId !== pendingSyncId) return;
      pendingSyncId = null;
      setStatus($('liveStatus'),
        data.approved ? 'Operatorul a aprobat sync-ul proiectorului.' : 'Operatorul a refuzat sync-ul.',
        data.approved ? 'ok' : 'err');
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
      if (!data || !currentEvent || data.eventId !== currentEvent.id) return;
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

  // --- LISTENERS ---
  function attachListeners() {
    $('worshipLoginBtn').addEventListener('click', doLogin);
    $('worshipPinInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doLogin(); }
    });
    $('worshipLogoutBtn').addEventListener('click', doLogout);

    // V21.5: dropdown removed — header now shows the live event read-only.
    // No change-listener needed; loadLiveEvent owns the single event source.

    $('globalSongLibrarySearch').addEventListener('input', (e) => {
      renderLibrary(e.target.value);
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
    $('importUrlInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doImportOrSearch(); }
    });
    $('songSaveBtn').addEventListener('click', saveSongInLibrary);
    $('songClearBtn').addEventListener('click', clearSongEditor);

    // V21.1: Live mode
    document.querySelectorAll('[data-worship-mode]').forEach((b) => {
      b.addEventListener('click', () => toggleMode(b.dataset.worshipMode));
    });
    $('liveSongSelect').addEventListener('change', (e) => changeLiveSong(e.target.value));
    $('liveVersePrev').addEventListener('click', () => setLiveVerse(liveCurrentVerseIndex - 1));
    $('liveVerseNext').addEventListener('click', () => setLiveVerse(liveCurrentVerseIndex + 1));
    $('liveVerseList').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-verse-index]');
      if (btn) setLiveVerse(parseInt(btn.dataset.verseIndex, 10));
    });
    attachSwipeHandlers();

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
        $('importUrlInput').value = '';
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
            renderEmptyEventInfo('Nu există event live. Setlist-ul se completează când admin pornește un event.');
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
})();
