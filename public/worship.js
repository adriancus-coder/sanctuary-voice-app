(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  let currentEvent = null;
  let availableEvents = [];
  let libraryItems = [];

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

    const canAdd = !!currentEvent;
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
              (canAdd ? '' : ' disabled title="Selectează un event"') + '>Adaugă în event</button>' +
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
