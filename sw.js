// Service worker: de app zelf (niet de kaart) ook zonder internet kunnen openen.
// Kaartdelen beheert worker.mjs in een eigen cache; die gaan hier ongemoeid doorheen.
const APP = 'app-web-0.1';
const BESTANDEN = ['./', 'index.html', 'style.css', 'app.mjs', 'worker.mjs', 'kern/limiet-kern.mjs', 'manifest.webmanifest', 'icon.png',
  'vendor/valhalla-wasm/lib/index.js', 'vendor/valhalla-wasm/lib/tiles.js', 'vendor/valhalla-wasm/lib/default-config.json',
  'vendor/valhalla-wasm/dist/valhalla.mjs', 'vendor/valhalla-wasm/dist/valhalla.wasm', 'tiles/index.json'];
self.addEventListener('install', e => e.waitUntil(caches.open(APP).then(c => c.addAll(BESTANDEN)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(n => n.startsWith('app-') && n !== APP).map(n => caches.delete(n)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.endsWith('.gphz')) return;
  // Eerst het netwerk (nieuwste versie), anders de opgeslagen kopie.
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const kopie = r.clone(); caches.open(APP).then(c => c.put(e.request, kopie)); } return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
