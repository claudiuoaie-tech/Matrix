// Rota-Matrix service worker.
//
// Strategy:
//  - App shell is precached on install so the PWA opens offline.
//  - Navigations: network-first (always fresh online), falling back to a cached
//    page and then the shell when offline.
//  - Static assets (Next chunks, icons, manifest): cache-first with runtime
//    caching so repeat loads work offline.
//  - API traffic (cross-origin to the Express backend) is never touched, so rota
//    data is always live and never served stale.

const VERSION = "v2";
const SHELL_CACHE = `rota-matrix-shell-${VERSION}`;
const RUNTIME_CACHE = `rota-matrix-runtime-${VERSION}`;
const OFFLINE_URL = "/";

// Precached on install. Wrapped individually so one missing asset can't abort
// the whole install.
const SHELL = [
  "/",
  "/worker/login",
  "/manifest.json",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) =>
        Promise.allSettled(SHELL.map((url) => cache.add(url)))
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  const keep = [SHELL_CACHE, RUNTIME_CACHE];
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

// Allow the page to trigger an immediate update.
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icon") ||
    url.pathname === "/manifest.json" ||
    /\.(?:css|js|woff2?|png|jpg|jpeg|svg|gif|webp|ico)$/.test(url.pathname)
  );
}

async function cacheFirst(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone());
  return res;
}

async function networkFirstNavigation(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    // Offline: prefer the cached version of this page, then the shell.
    const cached = (await cache.match(req)) || (await caches.match(OFFLINE_URL));
    if (cached) return cached;
    return new Response(
      "<h1>You're offline</h1><p>Reconnect to load Rota-Matrix.</p>",
      { headers: { "Content-Type": "text/html" }, status: 503 }
    );
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin GETs; API/POST traffic passes straight through.
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    event.respondWith(networkFirstNavigation(req));
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Everything else same-origin: try cache, fall back to network.
  event.respondWith(caches.match(req).then((cached) => cached || fetch(req)));
});
