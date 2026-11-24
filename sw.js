const CACHE_PREFIX = "wallen-app-";
const CACHE_NAME = CACHE_PREFIX + "v20";
const ASSETS_TO_CACHE = [
  "./",
  "./index.html",
  "./bundle.js",
  "./firebase-vendor.js",
  "./sync.js",
  "./jspdf.umd.min.js",
  "./pdfpacket.js",
  "./salepdf.js",
  "./pdf.min.js",
  "./pdf.worker.min.js",
  "./logo-cover.png",
  "./logo-pdf.png",
  "./tailwind.css",
  "./manifest.json",
  "./apple-touch-icon.png",
  "./icon-192.png",
  "./icon-512.png",
  "./favicon-32.png",
  "./favicon-16.png",
  "./logo.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    // cache:"reload" skips the browser's own HTTP cache so a new upload is really fetched
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE.map((u) => new Request(u, { cache: "reload" })))).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// v18: network first for our own files (checks GitHub for a newer copy each time, so an upload
// shows up without reinstalling); falls back to the saved copy when there's no signal or the
// network takes more than 4 seconds (e.g. weak signal in the barn).
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // don't intercept fonts/CDN requests
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(event.request, { ignoreSearch: true });
    const net = fetch(event.request, { cache: "no-cache" }).then((response) => {
      if (response && response.status === 200) cache.put(event.request, response.clone());
      return response;
    });
    if (!cached) return net.catch(() => caches.match("./index.html"));
    const timeout = new Promise((res) => setTimeout(() => res(null), 4000));
    try { const r = await Promise.race([net, timeout]); return r || cached; } catch (e) { return cached; }
  })());
});
