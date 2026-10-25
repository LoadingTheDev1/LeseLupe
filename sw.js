// Offline support: keep the app itself on the device. Translations and Gutenberg downloads always go to the network.
const VERSION = "leselupe-v2";
const SHELL = [
  "./",
  "./css/app.css",
  "./fonts/ibm-plex-sans-latin-400-normal.woff2",
  "./fonts/ibm-plex-sans-latin-500-normal.woff2",
  "./fonts/ibm-plex-sans-latin-600-normal.woff2",
  "./fonts/ibm-plex-sans-latin-ext-400-normal.woff2",
  "./fonts/ibm-plex-sans-latin-ext-500-normal.woff2",
  "./fonts/ibm-plex-sans-latin-ext-600-normal.woff2",
  "./fonts/literata-latin-400-italic.woff2",
  "./fonts/literata-latin-400-normal.woff2",
  "./fonts/literata-latin-600-normal.woff2",
  "./fonts/literata-latin-ext-400-italic.woff2",
  "./fonts/literata-latin-ext-400-normal.woff2",
  "./fonts/literata-latin-ext-600-normal.woff2",
  "./icons/apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/icon.svg",
  "./index.html",
  "./js/app.js",
  "./js/db.js",
  "./js/gutenberg.js",
  "./js/importers.js",
  "./js/sample.js",
  "./js/text.js",
  "./js/translate.js",
  "./manifest.webmanifest",
  "./vendor/jszip.min.js",
  "./vendor/pdf.min.mjs",
  "./vendor/pdf.worker.min.mjs"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // APIs and downloads: straight to the network

  const put = (res) => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req.mode === "navigate" ? "./" : req, copy)); }
    return res;
  };
  const isCode = req.mode === "navigate" || /\.(html|js|css|webmanifest)$/.test(url.pathname) && !url.pathname.includes("/vendor/");
  if (isCode) {
    // network first, so updates arrive right away; the cached copy is used offline
    event.respondWith(
      fetch(req).then(put).catch(() =>
        caches.match(req.mode === "navigate" ? "./" : req).then((r) => r || caches.match("./index.html")))
    );
    return;
  }
  // fonts, icons and libraries: cache first
  event.respondWith(caches.match(req).then((cached) => cached || fetch(req).then(put)));
});
