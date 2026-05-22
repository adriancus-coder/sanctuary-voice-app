// Sanctuary Voice service worker — participant + push notifications.
// 1. Web push: shows live notifications when admins or participants are subscribed.
// 2. Participant offline shell: caches the static assets so the listener page
//    keeps rendering if the network drops mid-service. Live translation data
//    still requires the open socket; cache only covers HTML / JS / CSS / icon.
//
// V21.19 hardening — push-sw.js owns scope `/` (the broadest), so without an
// allowlist its fetch handler would also intercept and cache /admin, /remote,
// /worship, /translate, etc. that's wrong: those pages have their own service
// workers (or none) and shouldn't be cached by the participant SW. The fetch
// handler now ONLY responds for paths in PARTICIPANT_SHELL — everything else
// falls through to the network unchanged. Push handlers below are untouched.

const CACHE_NAME = 'sv-shell-v3';
const PARTICIPANT_SHELL = [
  '/participant',
  '/participant.html',
  '/live',
  '/participant.js',
  '/styles.css',
  '/manifest.webmanifest',
  '/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PARTICIPANT_SHELL).catch(() => {}))
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
  // Live state — never cache.
  if (url.pathname.startsWith('/socket.io') || url.pathname.startsWith('/api/')) return;
  // V21.19: restrict to participant shell paths only — don't intercept
  // /admin, /remote, /worship, /translate, etc. (those either have their
  // own narrower SW or no SW at all and should hit the network directly).
  if (!PARTICIPANT_SHELL.includes(url.pathname)) return;

  event.respondWith(
    fetch(req).then((res) => {
      if (res && res.status === 200) {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match('/participant')))
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = {};
  }

  const title = data.title || 'Sanctuary Voice';
  const options = {
    body: data.body || 'Traducerea este live.',
    data: {
      url: data.url || '/participant'
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification?.data?.url || '/participant';
  event.waitUntil(clients.openWindow(url));
});
