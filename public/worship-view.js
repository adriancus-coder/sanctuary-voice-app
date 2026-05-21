(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const eventId = params.get('event');
  const token = params.get('token');

  let song = null;
  let verseIndex = 0;

  // Verses split on blank lines — matches worship.js Live mode (V21.1).
  function parseVerses(text) {
    if (!text) return [];
    return String(text).split(/\n\s*\n/).map((v) => v.trim()).filter(Boolean);
  }

  function setStatus(text) {
    const el = $('viewStatus');
    if (el) el.textContent = text || '';
  }

  function render() {
    const titleEl = $('viewSongTitle');
    const labelEl = $('viewVerseLabel');
    const lyricsEl = $('viewLyrics');
    if (!song) {
      titleEl.textContent = '—';
      labelEl.textContent = '';
      lyricsEl.textContent = 'Așteaptă cântarea de la worship leader…';
      return;
    }
    const verses = parseVerses(song.text);
    if (!verses.length) {
      titleEl.textContent = song.title || '';
      labelEl.textContent = '';
      lyricsEl.textContent = 'Cântarea nu are versuri.';
      return;
    }
    const idx = Math.max(0, Math.min(verseIndex, verses.length - 1));
    titleEl.textContent = song.title || '';
    labelEl.textContent = 'Strofa ' + (idx + 1) + ' / ' + verses.length;
    lyricsEl.textContent = verses[idx] || '';
  }

  function applyState(state, songObj) {
    song = songObj || null;
    verseIndex = state && Number.isInteger(state.currentVerseIndex) ? state.currentVerseIndex : 0;
    render();
  }

  async function loadInitial() {
    if (!eventId || !token) {
      $('viewLyrics').textContent = 'Link invalid. Cere QR-ul de la worship leader.';
      return;
    }
    try {
      const res = await fetch('/api/worship-view/' + encodeURIComponent(eventId) +
        '?token=' + encodeURIComponent(token));
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        $('viewLyrics').textContent = data.error || 'Acces refuzat.';
        return;
      }
      applyState(data.state, data.song);
    } catch (err) {
      $('viewLyrics').textContent = 'Eroare de conexiune: ' + err.message;
    }
  }

  function initSocket() {
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

  document.addEventListener('DOMContentLoaded', () => {
    loadInitial();
    if (eventId && token) initSocket();
    const dec = $('viewFontDecrease');
    const inc = $('viewFontIncrease');
    if (dec) dec.addEventListener('click', () => changeViewFontSize(-2));
    if (inc) inc.addEventListener('click', () => changeViewFontSize(2));
    applyViewFontSize();
    attachViewPinchZoom();
  });
})();
