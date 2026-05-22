// Sanctuary Voice — Worship master (/worship) service worker (V21.19).
//
// Same shape as worship-view-sw.js (V21.18) and remote-sw.js:
//   - Caches ONLY the static shell.
//   - NEVER caches /api/ (state) or /socket.io/ (live channel).
//   - Network-first so code updates reach devices on next reload.
//
// Scope is `/worship`. NOTE: `/worship-view` (V21.18) is registered with a
// more-specific scope `/worship-view`, so the browser picks
// worship-view-sw.js for those URLs — this worker only controls `/worship`,
// `/worship.js`, etc. The fetch handler additionally restricts to the SHELL
// list so even if scope ever changed, only worship-master assets are cached.

const CACHE_NAME = 'sv-worship-v1';
const SHELL = [
  '/worship',
  '/worship.js',
  '/styles.css',
  '/icon.svg',
  '/worship.webmanifest'
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
  if (url.pathname.startsWith('/socket.io')) return;
  if (url.pathname.startsWith('/api/')) return;

  if (!SHELL.includes(url.pathname)) return;

  event.respondWith(
    fetch(req).then((res) => {
      if (res && res.status === 200) {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match('/worship')))
  );
});
