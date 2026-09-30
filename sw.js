/**
 * Shadow Nexus Social — Service Worker
 *
 * Strategy:
 *   - Navigation (HTML page loads) → Network-first, fallback to cache → offline.html
 *   - Same-origin assets (CSS/JS/icons) → Cache-first, network fallback
 *   - TV engine JS files              → Network-first, cache as offline fallback only
 *   - Firebase & external CDN requests  → Network-only (always fresh)
 *
 * Path detection: base is derived from sw.js location so this works on
 * shadownexussocial.online (/) and any local dev server (/).
 *
 * Build: SNS-2026-WORLD-BG-GLOBAL-001
 */

const CACHE_VERSION = 'v93';
const BUILD_ID      = 'SNS-2026-WORLD-BG-GLOBAL-001';
const CACHE_NAME    = `shadow-nexus-${CACHE_VERSION}`;
const MEDIA_CACHE   = `shadow-nexus-media-${CACHE_VERSION}`;

// Detect base path from the SW's own URL (e.g. /ShadowNexusSocial/ or /)
const SW_URL  = new URL(self.location.href);
const BASE    = SW_URL.pathname.replace(/sw\.js$/, ''); // e.g. '/ShadowNexusSocial/' or '/'
const OFFLINE = BASE + 'offline.html';

/** Files pre-cached on install — paths relative to BASE */
const SHELL_FILES = [
  '',            // root / index
  'index.html',
  'offline.html',
  'style.css',
  'album.css',
  'realm.css',
  'mobile.css',
  'profile-theme.css',
  'profile-music.css',
  'theme-engine.css',
  'script.js',
  'snx-net.js',
  'studio.css',
  'nexus.css',
  'nexus.js',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
  'favicon.ico',
  'favicon-32x32.png',
  'favicon-16x16.png',
  'version.json',
  'shadow-nexus-upgrade.js',
  'shadow-nexus-upgrade.css',
  'nexus-intro.js',
  'nexus-intro.css',
  'snx-perf.js',
  'snx-perf.css',
  'nexus-glass.css',
  'snx-stage11.css',
  'snx-world-bg.css',
  'assets/images/shadow-nexus-world.webp',
  'assets/images/shadow-nexus-global-bg.png',
];

/** Max entries for the media cache (CDN images / avatars). */
const MEDIA_CACHE_MAX = 100;
/** Max age for media cache entries (24 hours). */
const MEDIA_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Paths that must always go to the network (never served from cache) */
const NETWORK_FIRST_PATHS = [];

/**
 * TV engine JS files — always network-first so a new deployment is served
 * immediately. The cached copy is only used as an offline fallback.
 * The browser must NEVER prefer a stale cached TV engine over the deployed version.
 */
const TV_NETWORK_FIRST_FILES = [
  // 24-Hour TV engine files
  'snx-ch-adapter.js',
  'snx-tv-network.js',
  'snx-tv-network.css',
  'snx-theater.js',
  'snx-main-tv-feature.js',
  'snx-ch-broadcast.js',
  'snx-ch-control.js',
  'snx-creator-channels.js',
  'snx-ch-auth-bridge.js',
  'snx-ch-firebase.js',
  'snx-ch-engine.js',
  'channel.html',
  // SNS Live engine files — always network-first so fixes are never stale
  'live.js',
  'live.css',
  // Radio engine files — network-first so listeners always get the latest version
  'snx-radio.js',
  'snx-radio-player.js',
  'snx-radio-studio.js',
  'snx-radio.css',
  'snx-audio-coordinator.js',
];

const PRECACHE_URLS = SHELL_FILES.map(f => BASE + f);

/** Hosts that must always go to the network */
const NETWORK_ONLY_HOSTS = [
  'firestore.googleapis.com',
  'firebase.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'firebaseinstallations.googleapis.com',
  'www.gstatic.com',
  'firebaseio.com',
  'googleapis.com',
  // Cloudflare upload worker + R2 CDN — never cache, always network
  'workers.dev',
  'cloudflare.com',
  'cdn.shadownexus.social',
  'photos.shadownexus.social',
  'r2.dev',
];

/* ─────────────────────────────────────────────
   INSTALL — pre-cache the app shell
   skipWaiting() is called so the new SW takes
   over as soon as it is installed, rather than
   waiting for all tabs to close. The page-side
   controllerchange handler (index.html) will
   reload once, guarded by sessionStorage so it
   cannot loop.
   ───────────────────────────────────────────── */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) =>
        Promise.allSettled(
          PRECACHE_URLS.map((url) =>
            cache.add(url).catch((err) =>
              console.warn(`[SW] Pre-cache skipped: ${url}`, err.message)
            )
          )
        )
      )
    // NOTE: skipWaiting() is intentionally NOT called automatically here.
    // Auto-skipWaiting causes the SW to take over mid-session on Android,
    // which results in a page reload that destroys the active Firebase Auth
    // session and forces re-login.
    // The new SW activates naturally when all tabs are closed and reopened.
    // The page explicitly sends SKIP_WAITING (below) only when the user
    // acknowledges the update toast — that path is safe.
  );
});

/* ─────────────────────────────────────────────
   ACTIVATE — clean up old caches, claim clients
   clients.claim() is called so new installs
   (fresh browser, cleared site data) take control
   of existing pages immediately.
   For update deployments the SW waits for all
   tabs to close naturally (no auto-skipWaiting),
   so claim() is a no-op until that happens.
   ───────────────────────────────────────────── */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) =>
        Promise.all(
          names
            .filter((n) => n !== CACHE_NAME && n !== MEDIA_CACHE)
            .map((n) => {
              console.log(`[SW] Deleting old cache: ${n}`);
              return caches.delete(n);
            })
        )
      )
      .then(() => self.clients.claim())
  );
});

/* ─────────────────────────────────────────────
   FETCH — request routing
   ───────────────────────────────────────────── */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET
  if (request.method !== 'GET') return;

  // Network-only: Firebase & external API hosts
  if (NETWORK_ONLY_HOSTS.some((host) => url.hostname.includes(host))) {
    event.respondWith(fetch(request));
    return;
  }

  // Navigation requests (page loads) — network-first, cache fallback, then offline page
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() =>
          caches.match(request).then(
            (cached) => cached || caches.match(OFFLINE)
          )
        )
    );
    return;
  }

  // Live streaming files — always network, never cache
  const pathname = url.pathname;
  if (url.origin === self.location.origin &&
      NETWORK_FIRST_PATHS.some(p => pathname.endsWith(p))) {
    event.respondWith(fetch(request));
    return;
  }

  // TV engine JS files — network-first, cache only as offline fallback.
  // This ensures the deployed TV code is always preferred over a stale cache.
  if (url.origin === self.location.origin &&
      TV_NETWORK_FIRST_FILES.some(f => pathname.endsWith('/' + f) || pathname === BASE + f || pathname.includes(f))) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() =>
          // Offline fallback — serve cached version if available
          caches.match(request).then(
            (cached) => cached || new Response('', { status: 503, statusText: 'Service Unavailable' })
          )
        )
    );
    return;
  }

  // Same-origin assets — cache-first, network fallback
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        }).catch(() =>
          new Response('', { status: 404, statusText: 'Not Found' })
        );
      })
    );
    return;
  }

  // Cross-origin CDN media (images, avatars) — stale-while-revalidate with size cap
  const isMedia = /\.(jpe?g|png|gif|webp|svg|mp4|webm|mp3|m4a|ogg|opus)(\?|$)/i.test(url.pathname);
  if (isMedia) {
    event.respondWith(
      caches.open(MEDIA_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) {
          // Serve cached copy; revalidate in background
          const dateHeader = cached.headers.get('date');
          const age = dateHeader ? Date.now() - new Date(dateHeader).getTime() : Infinity;
          if (age < MEDIA_CACHE_MAX_AGE_MS) {
            return cached; // fresh enough — no revalidation needed
          }
          // Stale — refresh in background
          fetch(request).then((fresh) => {
            if (fresh && fresh.status === 200) {
              _trimMediaCache(cache).then(() => cache.put(request, fresh.clone()));
            }
          }).catch(() => {});
          return cached;
        }
        // Not in cache — fetch, store, then serve
        try {
          const response = await fetch(request);
          if (response && response.status === 200) {
            await _trimMediaCache(cache);
            cache.put(request, response.clone());
          }
          return response;
        } catch (_) {
          return caches.match(request);
        }
      })
    );
    return;
  }

  // Cross-origin non-media assets (fonts, scripts from CDN) — network-first, cache fallback
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});

/** Trim media cache to MEDIA_CACHE_MAX entries (LRU by insertion order). */
async function _trimMediaCache(cache) {
  const keys = await cache.keys();
  if (keys.length >= MEDIA_CACHE_MAX) {
    const toDelete = keys.slice(0, keys.length - MEDIA_CACHE_MAX + 1);
    await Promise.all(toDelete.map((k) => cache.delete(k)));
  }
}

/* ─────────────────────────────────────────────
   MESSAGE — cache control from the page
   ───────────────────────────────────────────── */
/** Current network tier reported by snx-net.js on any page */
let _snxNetTier     = 'good';
let _snxDataSaver   = false;
let _snxOffline     = false;

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    // Honour explicit skip-waiting requests from the page (e.g. update prompt)
    self.skipWaiting();
  }
  if (event.data?.type === 'CLEAR_CACHE') {
    caches.delete(CACHE_NAME).then(() => {
      event.source?.postMessage({ type: 'CACHE_CLEARED' });
    });
  }
  if (event.data?.type === 'CHECK_UPDATE') {
    // Client asked if there's a newer SW ready; respond immediately
    event.source?.postMessage({
      type:       'UPDATE_STATUS',
      hasUpdate:  false,  // SW itself can't self-inspect; client handles via reg.waiting
    });
  }
  if (event.data?.type === 'GET_VERSION') {
    // Let the page know which build this SW is running
    event.source?.postMessage({ type: 'SW_VERSION', version: CACHE_VERSION, buildId: BUILD_ID });
  }

  // ── SNX-NET: network quality state update from snx-net.js ──
  if (event.data?.type === 'SNX_NET_STATE') {
    _snxNetTier   = event.data.tier      ?? 'good';
    _snxDataSaver = event.data.dataSaver ?? false;
    _snxOffline   = event.data.offline   ?? false;
    // On data-saver tier: trim media cache more aggressively
    if (_snxDataSaver) {
      caches.open(MEDIA_CACHE).then(cache => {
        cache.keys().then(keys => {
          // Keep only the 30 most-recently-cached items when bandwidth is tight
          if (keys.length > 30) {
            keys.slice(0, keys.length - 30).forEach(k => cache.delete(k));
          }
        });
      }).catch(() => {});
    }
  }
});
