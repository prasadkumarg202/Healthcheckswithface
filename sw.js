/**
 * sw.js — EROS Wellness AI Service Worker
 * ─────────────────────────────────────────
 * Provides offline fallback and static asset caching.
 * Fixes the persistent 404 errors logged by the browser.
 */

const CACHE_NAME = 'eros-wellness-v2';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/js/signal.js',
  '/js/charts.js',
  '/js/roi.js',
  '/js/app.js',
  '/favicon.svg',
];

/* ── Install: pre-cache static assets ── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS).catch(err => {
        console.warn('[SW] Pre-cache failed for some assets:', err);
      });
    })
  );
  self.skipWaiting();
});

/* ── Activate: clean up old caches ── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

/* ── Fetch: Network-first with cache fallback ──
   CDN requests (MediaPipe, Chart.js) are never cached —
   they need to be loaded fresh with CORS headers intact.
*/
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip CDN requests and non-GET
  if (event.request.method !== 'GET') return;
  if (url.hostname !== self.location.hostname) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Cache successful local GET responses
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        // Network failed — return from cache
        return caches.match(event.request).then(cached => {
          if (cached) return cached;
          // Ultimate fallback for navigation requests
          if (event.request.mode === 'navigate') {
            return caches.match('/index.html');
          }
          return new Response('Offline', { status: 503 });
        });
      })
  );
});
