(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const eventId = params.get('event');
  const token = params.get('token');
  // V21.18: token + event in URL → V21.2 QR flow (one-time, per master session).
  // Otherwise → permanent-link flow (PIN gate + auto-detect live event).
  const mode = (eventId && token) ? 'token' : 'permanent';

  let currentSong = null;
  let currentVerseIndex = 0;
  let currentEventName = '';

  // Verses split on blank lines — matches worship.js Live mode (V21.1).
  function parseVerses(text) {
    if (!text) return [];
    return String(text).split(/\n\s*\n/).map((v) => v.trim()).filter(Boolean);
  }

  function setStatus(text) {
    const el = $('viewStatus');
    if (el) el.textContent = text || '';
  }

  function show(id) {
    const el = $(id);
    if (el) el.classList.remove('hidden');
  }

  function hide(id) {
    const el = $(id);
    if (el) el.classList.add('hidden');
  }

  function showAppShell() {
    hide('viewLoginScreen');
    show('viewApp');
    show('viewFontControls');
  }

  function showWaiting(message) {
    showAppShell();
    currentSong = null;
    currentVerseIndex = 0;
    const titleEl = $('viewSongTitle');
    const labelEl = $('viewVerseLabel');
    const lyricsEl = $('viewLyrics');
    if (titleEl) titleEl.textContent = currentEventName ? currentEventName : '—';
    if (labelEl) labelEl.textContent = '';
    if (lyricsEl) lyricsEl.textContent = message || 'Worship nu e live acum. Așteaptă să înceapă.';
  }

  function render() {
    const titleEl = $('viewSongTitle');
    const labelEl = $('viewVerseLabel');
    const lyricsEl = $('viewLyrics');
    if (!currentSong) {
      if (titleEl) titleEl.textContent = '—';
      if (labelEl) labelEl.textContent = '';
      if (lyricsEl) lyricsEl.textContent = 'Așteaptă cântarea de la worship leader…';
      return;
    }
    const verses = parseVerses(currentSong.text);
    if (!verses.length) {
      if (titleEl) titleEl.textContent = currentSong.title || '';
      if (labelEl) labelEl.textContent = '';
      if (lyricsEl) lyricsEl.textContent = 'Cântarea nu are versuri.';
      return;
    }
    const idx = Math.max(0, Math.min(currentVerseIndex, verses.length - 1));
    if (titleEl) titleEl.textContent = currentSong.title || '';
    if (labelEl) labelEl.textContent = 'Strofa ' + (idx + 1) + ' / ' + verses.length;
    if (lyricsEl) lyricsEl.textContent = verses[idx] || '';
  }

  function applyState(state, songObj) {
    showAppShell();
    currentSong = songObj || null;
    currentVerseIndex = state && Number.isInteger(state.currentVerseIndex) ? state.currentVerseIndex : 0;
    // V21.22: worship master can blank the members' screen at song end with
    // the right-arrow → END button. Reuse the existing waiting screen so
    // members see consistent UX between "not live yet" and "paused".
    if (state && state.ended === true) {
      showWaiting('Pauză worship. Așteaptă următoarea cântare.');
      return;
    }
    render();
  }

  // ---- V21.2 QR token flow (unchanged) ----
  async function loadInitialToken() {
    try {
      const res = await fetch('/api/worship-view/' + encodeURIComponent(eventId) +
        '?token=' + encodeURIComponent(token));
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        showAppShell();
        $('viewLyrics').textContent = data.error || 'Acces refuzat.';
        return;
      }
      applyState(data.state, data.song);
    } catch (err) {
      showAppShell();
      $('viewLyrics').textContent = 'Eroare de conexiune: ' + err.message;
    }
  }

  function initSocketToken() {
    if (typeof io !== 'function') return;
    const socket = io();
    socket.on('connect', () => {
      socket.emit('worship:view:join', { eventId, token });
      setStatus('Conectat · sincronizat live');
    });
    socket.on('disconnect', () => setStatus('Reconectare…'));
    socket.on('worship:view:denied', (d) => {
      $('viewLyrics').textContent = (d && d.message) || 'Link invalid sau expirat.';
      setStatus('');
    });
    socket.on('worship:state_change', (data) => {
      if (!data || data.eventId !== eventId) return;
      applyState(data.state, data.song);
    });
  }

  // ---- V21.18 permanent-link flow ----
  function setLoginStatus(text) {
    const el = $('viewLoginStatus');
    if (el) el.textContent = text || '';
  }

  function showLoginGate() {
    hide('viewApp');
    hide('viewFontControls');
    show('viewLoginScreen');
    setLoginStatus('');
    const input = $('viewPinInput');
    if (input) {
      input.value = '';
      try { input.focus(); } catch (_) { /* ignore */ }
    }
  }

  async function checkAuth() {
    try {
      const res = await fetch('/api/worship-view/me', { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      return !!(data && data.authenticated);
    } catch (_) {
      return false;
    }
  }

  async function submitPin() {
    const input = $('viewPinInput');
    const pin = (input && input.value || '').trim();
    if (!pin) { setLoginStatus('Introdu PIN-ul.'); return; }
    setLoginStatus('Se verifică…');
    try {
      const res = await fetch('/api/worship-view/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ pin })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setLoginStatus(data.error || 'PIN invalid.');
        return;
      }
      setLoginStatus('');
      await enterPermanent();
    } catch (err) {
      setLoginStatus('Eroare: ' + err.message);
    }
  }

  async function loadInitialPermanent() {
    try {
      const res = await fetch('/api/worship-view/live', { credentials: 'same-origin' });
      if (res.status === 401) {
        showLoginGate();
        return false;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        showAppShell();
        $('viewLyrics').textContent = data.error || 'Eroare la încărcare.';
        return true;
      }
      currentEventName = data.eventName || '';
      if (!data.live) {
        showWaiting();
      } else {
        applyState(data.state, data.song);
      }
      return true;
    } catch (err) {
      showAppShell();
      $('viewLyrics').textContent = 'Eroare de conexiune: ' + err.message;
      return true;
    }
  }

  function initSocketPermanent() {
    if (typeof io !== 'function') return;
    const socket = io();
    socket.on('connect', () => {
      socket.emit('worship:view:join_permanent');
      setStatus('Conectat · sincronizat live');
    });
    socket.on('disconnect', () => setStatus('Reconectare…'));
    socket.on('worship:view:permanent_denied', () => {
      // Cookie probably expired/cleared on the server. Re-prompt PIN.
      showLoginGate();
      setLoginStatus('Sesiune expirată. Reintrodu PIN-ul.');
      setStatus('');
    });
    socket.on('worship:view:live', (data) => {
      if (!data) return;
      // The server sends the per-event payload (same shape as worship:state_change).
      currentEventName = data.eventName || currentEventName;
      applyState(data.state, data.song);
    });
    socket.on('worship:view:offline', () => {
      currentEventName = '';
      showWaiting();
    });
  }

  async function enterPermanent() {
    const proceeded = await loadInitialPermanent();
    if (proceeded) initSocketPermanent();
  }

  // V21.13: per-device lyrics font size. Inline px overrides the CSS;
  // no persistence — resets to default on reload. V21.13-FIX: shared
  // by the A−/A+ buttons AND pinch-to-zoom.
  let viewFontSize = 32;
  const VIEW_FONT_MIN = 20;
  const VIEW_FONT_MAX = 48;
  function applyViewFontSize() {
    const el = $('viewLyrics');
    if (el) el.style.fontSize = viewFontSize + 'px';
  }
  function changeViewFontSize(delta) {
    viewFontSize = Math.max(VIEW_FONT_MIN, Math.min(VIEW_FONT_MAX, viewFontSize + delta));
    applyViewFontSize();
  }

  // V21.13-FIX: pinch-to-zoom on the member lyrics. The member view is
  // read-only (no swipe), so two fingers is unambiguous — no guard
  // needed against a swipe gesture.
  function attachViewPinchZoom() {
    const el = $('viewLyrics');
    if (!el) return;
    let startDist = null;
    let startFont = null;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    el.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        startDist = dist(e.touches);
        startFont = viewFontSize;
        e.preventDefault();
      }
    }, { passive: false });
    el.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && startDist) {
        const next = Math.round(startFont * (dist(e.touches) / startDist));
        viewFontSize = Math.max(VIEW_FONT_MIN, Math.min(VIEW_FONT_MAX, next));
        applyViewFontSize();
        e.preventDefault();
      }
    }, { passive: false });
    el.addEventListener('touchend', (e) => {
      if (e.touches.length < 2) { startDist = null; startFont = null; }
    });
  }

  // V21.18: register the worship-view service worker for PWA installability.
  // The SW caches only the static shell — live lyrics travel over the socket
  // and are never cached. Scope `/worship-view` keeps it isolated from
  // push-sw.js (which handles /participant offline shell + push notifications).
  function registerWorshipViewServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker
      .register('/worship-view-sw.js', { scope: '/worship-view' })
      .catch((err) => console.warn('worship-view SW registration failed:', err && err.message));
  }

  document.addEventListener('DOMContentLoaded', async () => {
    const dec = $('viewFontDecrease');
    const inc = $('viewFontIncrease');
    if (dec) dec.addEventListener('click', () => changeViewFontSize(-2));
    if (inc) inc.addEventListener('click', () => changeViewFontSize(2));
    applyViewFontSize();
    attachViewPinchZoom();
    registerWorshipViewServiceWorker();

    if (mode === 'token') {
      // V21.2 QR flow — straight in, no PIN gate.
      showAppShell();
      await loadInitialToken();
      initSocketToken();
      return;
    }

    // Permanent-link flow.
    const loginBtn = $('viewLoginBtn');
    const pinInput = $('viewPinInput');
    if (loginBtn) loginBtn.addEventListener('click', submitPin);
    if (pinInput) {
      pinInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submitPin(); }
      });
    }

    const authed = await checkAuth();
    if (!authed) {
      showLoginGate();
      return;
    }
    await enterPermanent();
  });
})();
