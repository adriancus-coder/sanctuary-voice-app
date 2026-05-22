// Sanctuary Voice — Operator (/remote) service worker (V21.19).
// PWA support for the single-tab operator console.
//
// Same shape as worship-view-sw.js (V21.18):
//   - Caches ONLY the static shell.
//   - NEVER caches /api/ (state) or /socket.io/ (live channel).
//   - Network-first for the shell so code updates ship on next reload;
//     cache only fills the offline fallback.
//
// Operator state (event display, song verses, worship) arrives over
// Socket.IO, never as HTTP responses — it cannot be cached by accident.

const CACHE_NAME = 'sv-remote-v1';
const SHELL = [
  '/remote',
  '/remote.js',
  '/styles.css',
  '/icon.svg',
  '/remote.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Hard exclusions — never touch live data.
  if (url.pathname.startsWith('/socket.io')) return;
  if (url.pathname.startsWith('/api/')) return;

  // Only intercept the known shell paths. Anything else falls through to
  // the network so we don't accidentally cache other pages or assets.
  if (!SHELL.includes(url.pathname)) return;

  event.respondWith(
    fetch(req).then((res) => {
      if (res && res.status === 200) {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match('/remote')))
  );
});
