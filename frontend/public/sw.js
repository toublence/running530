// Minimal service worker for offline caching of static assets
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only handle GET requests and same-origin
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      // Decide whether to cache: skip partial/opaque/range/audio responses
      const isRangeReq = req.headers.has('range') || req.headers.has('Range');
      const contentRange = res.headers.get('Content-Range');
      const isPartial = res.status === 206 || !!contentRange;
      const isOpaqueOrNonBasic = res.type && res.type !== 'basic';
      const url = new URL(req.url);
      const isAudio = /\.(mp3|wav|ogg|m4a)(\?|$)/i.test(url.pathname) || (req.destination === 'audio');
      const okToCache = res.ok && !isPartial && !isOpaqueOrNonBasic && !isRangeReq && !isAudio;
      if (okToCache) {
        try {
          const cache = await caches.open('app-cache-v1');
          await cache.put(req, res.clone());
        } catch (e) {
          // Ignore caching errors to avoid breaking the response
          // e.g., DOMException: Partial response (status code 206) is unsupported
        }
      }
      return res;
    } catch (err) {
      const cached = await caches.match(req);
      if (cached) return cached;
      throw err;
    }
  })());
});

