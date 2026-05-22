// Sanctuary Voice — Worship View service worker (V21.18).
// PWA support for the permanent worship-view link (Add to Home Screen).
//
// Caching policy is deliberately narrow:
//   - Caches ONLY the static shell (HTML + JS + CSS + icon + manifest).
//   - NEVER caches /api/ (state lives there) or /socket.io/ (live channel).
//   - Network-first for the shell so updates ship to devices on next reload
//     without needing a cache-bust; cache only fills the offline fallback.
//
// Lyrics arrive exclusively via the Socket.IO connection, never as HTTP
// responses, so they cannot be cached by this worker even by accident.

const CACHE_NAME = 'sv-worship-view-v1';
const SHELL = [
  '/worship-view',
  '/worship-view.js',
  '/styles.css',
  '/icon.svg',
  '/worship-view.webmanifest'
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

  // Only intercept the known shell paths. Anything else (other pages, other
  // assets shared by sibling apps like push-sw.js for /participant) is left
  // to the network or to a more specific worker.
  const isShell = SHELL.includes(url.pathname);
  if (!isShell) return;

  event.respondWith(
    fetch(req).then((res) => {
      if (res && res.status === 200) {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match('/worship-view')))
  );
});
