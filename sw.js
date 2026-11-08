// Encore service worker: makes the app work offline.
// App files are served from cache and refreshed in the background (stale-while-revalidate).
// API calls (Ticketmaster, Bandsintown, geocoding) always go to the network.

const VERSION = 'encore-v2';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/store.js',
  './js/api.js',
  './js/refresh.js',
  './js/ui.js',
  './js/util.js',
  './js/views.js',
  './js/views-more.js',
  './js/chart.js',
  './js/files.js',
  './js/sync.js',
  './js/spotify.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never cache API responses

  // Navigations: serve the cached shell so the app opens offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html')),
    );
    return;
  }

  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});

// Background alerts sent by the scheduled GitHub Action (see server/check.mjs).
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { body: event.data?.text() || '' }; }
  const title = d.title || 'Encore';
  event.waitUntil((async () => {
    if (typeof d.badge === 'number' && self.navigator?.setAppBadge) {
      try { await self.navigator.setAppBadge(d.badge); } catch { /* unsupported */ }
    }
    await self.registration.showNotification(title, {
      body: d.body || '',
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      tag: d.tag || 'encore',
      data: { url: d.url || './#/shows' },
    });
  })());
});

// Tapping a notification opens (or focuses) the app at the right screen.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || './#/shows', self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          c.postMessage({ type: 'open', url });
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
