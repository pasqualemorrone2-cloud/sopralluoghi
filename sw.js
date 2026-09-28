// Cache dell'app per l'uso senza rete; le tessere della mappa si salvano man mano che si visualizzano.
const APP = 'sopralluoghi-app-v1', TILES = 'sopralluoghi-tiles-v1';
const FILES = ['./', 'index.html', 'app.js', 'logo.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable.png',
  'lib/leaflet.js', 'lib/leaflet.css', 'lib/piexif.js', 'lib/jszip.min.js', 'lib/xlsx.full.min.js', 'lib/docx.js', 'lib/shp.min.js',
  'lib/images/marker-icon.png', 'lib/images/marker-shadow.png', 'lib/images/layers.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(APP).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== APP && k !== TILES).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.hostname.endsWith('arcgisonline.com')) {
    e.respondWith(caches.open(TILES).then(async c => {
      const hit = await c.match(e.request);
      const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (u.origin === location.origin) e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request)));
});
