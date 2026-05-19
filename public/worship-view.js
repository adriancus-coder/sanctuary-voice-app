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

  document.addEventListener('DOMContentLoaded', () => {
    loadInitial();
    if (eventId && token) initSocket();
  });
})();
