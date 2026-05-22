// Offline cache for the static dashboard and last-good data snapshots.
const CACHE = 'qqqq-v1';
const SHELL = ['/', '/index.html', '/embed.html', '/app.js', '/lib/analytics.js', '/styles.css', '/manifest.json', '/icon.svg'];
const DATA = [
  '/data/holdings.json',
  '/data/monthly-allocations.json',
  '/data/changes.json',
  '/data/price-history.json',
  '/data/refresh-status.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll([...SHELL, ...DATA])).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isDataRequest(url) {
  return url.pathname.startsWith('/data/') && url.pathname.endsWith('.json');
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (isDataRequest(url)) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          }
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        if (res.ok && event.request.method === 'GET') {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return res;
      });
    })
  );
});
