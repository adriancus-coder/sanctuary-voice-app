const socket = io();
const $ = (id) => document.getElementById(id);
let availableLanguages = {};
const params = new URLSearchParams(window.location.search);
const state = {
  fixedEventId: params.get('event') || '',
  currentEvent: null,
  currentLanguage: params.get('lang') || 'no',
  mode: 'live'
};
function langLabel(code) { return availableLanguages[code] || code.toUpperCase(); }
function renderSongText(songState) {
  const textEl = $('translateText');
  const titleEl = $('translateEventName');
  if (textEl) textEl.textContent = songState?.translations?.[state.currentLanguage] || 'Waiting for song translation...';
  if (titleEl) titleEl.textContent = songState?.title || state.currentEvent?.name || 'Song Screen';
}
function syncLanguageSelect() {
  const select = $('translateLanguage');
  if (!select) return;
  const langs = state.currentEvent?.targetLangs || [];
  select.innerHTML = langs.map((code) => `<option value="${code}">${langLabel(code)}</option>`).join('');
  if (!langs.includes(state.currentLanguage)) state.currentLanguage = langs[0] || 'no';
  select.value = state.currentLanguage;
}
async function resolveEventId() {
  if (state.fixedEventId) return state.fixedEventId;
  try { const res = await fetch('/api/events/active'); const data = await res.json(); if (data.ok && data.event?.id) return data.event.id; } catch (_) {}
  return '';
}
async function joinEvent() {
  const eventId = await resolveEventId();
  if (!eventId) return;
  socket.emit('join_event', { eventId, role: 'participant', language: state.currentLanguage, participantId: `song_screen_${state.currentLanguage}` });
}
socket.on('connect', joinEvent);
socket.on('joined_event', ({ event }) => { state.currentEvent = event; state.mode = event.mode || 'live'; syncLanguageSelect(); if (state.mode === 'song' && event.songState) renderSongText(event.songState); });
socket.on('mode_changed', ({ mode }) => {
  state.mode = mode || 'live';
  const textEl = $('translateText');
  if (state.mode !== 'song' && textEl) textEl.textContent = 'Song mode is off.';
});
socket.on('song_state', (songState) => { if (state.mode !== 'song') return; renderSongText(songState); });
socket.on('song_clear', () => {
  const textEl = $('translateText');
  if (textEl) textEl.textContent = 'Waiting for song translation...';
});
socket.on('active_event_changed', async () => { if (!state.fixedEventId) await joinEvent(); });
$('translateLanguage')?.addEventListener('change', () => {
  state.currentLanguage = $('translateLanguage').value;
  if (state.currentEvent?.id) socket.emit('participant_language', { eventId: state.currentEvent.id, language: state.currentLanguage });
  if (state.currentEvent?.songState) renderSongText(state.currentEvent.songState);
});
window.addEventListener('load', async () => { try { const res = await fetch('/api/languages'); const data = await res.json(); availableLanguages = data.languages || {}; } catch (_) {} });
