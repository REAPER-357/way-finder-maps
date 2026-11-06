/* Way-Finder Maps service worker: caches the app itself so it opens offline.
   It never caches map tiles from the network (privacy + storage). */
const CACHE = 'wayfinder-shell-v1';
const SHELL = [
  './', './index.html', './manifest.json', './small-icon.png', './icon.png',
  './assets/lib/maplibre-gl.js', './assets/lib/maplibre-gl.css', './assets/lib/pmtiles.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c =>
    Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return; // tiles etc. go straight to network
  const isFont = url.pathname.includes('/assets/fonts/');
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => {
      const net = fetch(req).then(res => {
        if (res && res.ok && (SHELL.some(s => new URL(s, location).pathname === url.pathname) || isFont)) {
          const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || net; // cache first, refresh in background
    })
  );
});
