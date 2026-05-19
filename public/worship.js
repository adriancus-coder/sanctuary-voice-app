(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  let currentEvent = null;
  let availableEvents = [];
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
    loadEvents();
  }

  // --- EVENTS ---
  async function loadEvents() {
    try {
      const res = await fetch('/api/worship/events');
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        $('worshipEventInfo').innerHTML =
          '<p class="muted">Nu s-au putut încărca event-urile.</p>';
        return;
      }
      availableEvents = Array.isArray(data.events) ? data.events : [];
      const select = $('worshipEventSelect');

      if (!availableEvents.length) {
        $('worshipEventInfo').innerHTML =
          '<p class="muted">Nu există event-uri viitoare. Contactează administratorul pentru a crea un event.</p>';
        select.innerHTML = '<option>—</option>';
        select.disabled = true;
        currentEvent = null;
        renderEventSongs();
        loadLibrary();
        return;
      }

      select.disabled = false;
      select.innerHTML = availableEvents.map((ev) =>
        `<option value="${escapeHtml(ev.id)}">${escapeHtml(ev.name)} — ${escapeHtml(formatDate(ev.scheduledAt || ev.scheduledTimestamp))}</option>`
      ).join('');
      select.value = availableEvents[0].id;
      await loadEventDetail(availableEvents[0].id);
    } catch (err) {
      $('worshipEventInfo').innerHTML =
        '<p class="muted">Eroare la încărcarea event-urilor: ' + escapeHtml(err.message) + '</p>';
    }
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
      '<div class="event-song-row">' +
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

    const canAdd = !!currentEvent && currentEvent.editable !== false;
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
            '<button class="btn btn-primary btn-sm" type="button" data-worship-lib-add="' + id + '"' +
              (canAdd ? '' : ' disabled title="' + (currentEvent ? 'Setlist blocat pentru event live' : 'Selectează un event') + '"') + '>Adaugă în event</button>' +
          '</div>' +
        '</div>' +
      '</details>';
    }).join('');
  }

  // --- ADD / DELETE ---
  async function addSongToEvent(librarySongId, btn) {
    if (!currentEvent) {
      alert('Selectează un event mai întâi.');
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = 'Se adaugă...'; }
    try {
      const res = await fetch('/api/worship/events/' + encodeURIComponent(currentEvent.id) + '/songs/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ librarySongId })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        alert(data.error || 'Adăugarea a eșuat.');
        if (btn) { btn.disabled = false; btn.textContent = 'Adaugă în event'; }
        return;
      }
      await loadEventDetail(currentEvent.id);
    } catch (err) {
      alert('Eroare: ' + err.message);
      if (btn) { btn.disabled = false; btn.textContent = 'Adaugă în event'; }
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
    listEl.innerHTML = verses.map((v, i) =>
      '<button type="button" class="verse-list-item' + (i === idx ? ' current' : '') +
      '" data-verse-index="' + i + '">' + (i === idx ? '● ' : '') + 'Strofa ' + (i + 1) + '</button>'
    ).join('');
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
    masterHeartbeatTimer = setInterval(() => {
      if (masterSocket && masterSocket.connected && currentEvent) {
        masterSocket.emit('worship:master:heartbeat', { eventId: currentEvent.id });
      }
    }, 20000);
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

  // --- LISTENERS ---
  function attachListeners() {
    $('worshipLoginBtn').addEventListener('click', doLogin);
    $('worshipPinInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doLogin(); }
    });
    $('worshipLogoutBtn').addEventListener('click', doLogout);

    $('worshipEventSelect').addEventListener('change', (e) => {
      if (e.target.value && e.target.value !== '—') loadEventDetail(e.target.value);
    });

    $('globalSongLibrarySearch').addEventListener('input', (e) => {
      renderLibrary(e.target.value);
    });

    $('globalSongLibraryList').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-worship-lib-add]');
      if (!btn || btn.disabled) return;
      addSongToEvent(btn.dataset.worshipLibAdd, btn);
    });

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
  // window) skip the login screen and go straight to the app.
  async function init() {
    attachListeners();
    try {
      const res = await fetch('/api/worship/events');
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data && data.ok) {
          $('worshipLoginScreen').classList.add('hidden');
          $('worshipApp').classList.remove('hidden');
          availableEvents = Array.isArray(data.events) ? data.events : [];
          renderEventsFromCache();
          return;
        }
      }
    } catch (err) { /* fall through to login screen */ }
  }

  function renderEventsFromCache() {
    const select = $('worshipEventSelect');
    if (!availableEvents.length) {
      $('worshipEventInfo').innerHTML =
        '<p class="muted">Nu există event-uri viitoare. Contactează administratorul pentru a crea un event.</p>';
      select.innerHTML = '<option>—</option>';
      select.disabled = true;
      renderEventSongs();
      loadLibrary();
      return;
    }
    select.disabled = false;
    select.innerHTML = availableEvents.map((ev) =>
      `<option value="${escapeHtml(ev.id)}">${escapeHtml(ev.name)} — ${escapeHtml(formatDate(ev.scheduledAt || ev.scheduledTimestamp))}</option>`
    ).join('');
    select.value = availableEvents[0].id;
    loadEventDetail(availableEvents[0].id);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
