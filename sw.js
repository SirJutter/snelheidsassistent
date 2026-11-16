// Service worker: de app zelf (niet de kaart) ook zonder internet kunnen openen.
// Kaartdelen beheert worker.mjs in een eigen cache; die gaan hier ongemoeid doorheen.
const APP = 'snelheidsassistent-app-web-0.5';
const BESTANDEN = ['./', 'index.html', 'style.css', 'app.mjs', 'worker.mjs', 'kern/limiet-kern.mjs', 'manifest.webmanifest', 'icon.png',
  'vendor/valhalla-wasm/lib/index.js', 'vendor/valhalla-wasm/lib/tiles.js', 'vendor/valhalla-wasm/lib/default-config.json',
  'vendor/valhalla-wasm/dist/valhalla.mjs', 'vendor/valhalla-wasm/dist/valhalla.wasm', 'tiles/index.json', 'kern/audio-bestanden.mjs', 'kern/proeflog-opslag.mjs', 'audio/draaggolf.m4a', 'audio/activatie.m4a', 'audio/proef-1.m4a', 'audio/proef-2.m4a',
  ...[...Array.from({ length: 130 }, (_, i) => i + 1), 140, 150, 160, 180, 200].map(n => `audio/limiet-${n}.m4a`)];
self.addEventListener('install', e => e.waitUntil(caches.open(APP).then(c => c.addAll(BESTANDEN)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(n => (n.startsWith('snelheidsassistent-app-') || n === 'app-web-0.1') && n !== APP).map(n => caches.delete(n)))).then(() => self.clients.claim())));
async function audioAntwoord(request) {
  const cache = await caches.open(APP);
  const volledigVerzoek = new Request(request.url);
  let antwoord = await cache.match(volledigVerzoek);
  if (!antwoord) {
    antwoord = await fetch(volledigVerzoek);
    if (antwoord.ok && antwoord.status === 200) await cache.put(volledigVerzoek, antwoord.clone());
  }
  const bereik = request.headers.get('Range');
  if (!bereik || antwoord.status !== 200) return antwoord;
  const match = /^bytes=(\d*)-(\d*)$/.exec(bereik);
  if (!match || (!match[1] && !match[2])) return antwoord;
  const bytes = await antwoord.arrayBuffer();
  const totaal = bytes.byteLength;
  const start = match[1] ? Number(match[1]) : Math.max(0, totaal - Number(match[2]));
  const eind = match[1] ? (match[2] ? Math.min(Number(match[2]), totaal - 1) : totaal - 1) : totaal - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(eind) || start < 0 || start >= totaal || eind < start) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${totaal}` } });
  }
  const headers = new Headers(antwoord.headers);
  headers.delete('Content-Encoding');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Range', `bytes ${start}-${eind}/${totaal}`);
  headers.set('Content-Length', String(eind - start + 1));
  return new Response(bytes.slice(start, eind + 1), { status: 206, headers });
}
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.endsWith('.gphz')) return;
  // Safari vraagt audiobestanden ook als bytebereik op, óók vanuit de offline cache.
  if (url.pathname.startsWith(new URL('./audio/', self.registration.scope).pathname)) {
    e.respondWith(audioAntwoord(e.request)); return;
  }
  // Eerst het netwerk (nieuwste versie), anders de opgeslagen kopie.
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const kopie = r.clone(); caches.open(APP).then(c => c.put(e.request, kopie)); } return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
