// Web Worker: Valhalla 3.9.0 (WebAssembly) met Nederlandse kaarttegels uit de browsercache.
// Alle kaartbepalingen gebeuren hier, op de iPhone zelf. Er gaan geen GPS-punten naar een server.
import { loadValhalla } from './vendor/valhalla-wasm/lib/index.js';
import { bepaalLimiet, tegelsRond } from './kern/limiet-kern.mjs';

const KAARTCACHE = 'kaart-nl-20261001';
const BASIS = new URL('./', self.location.href);
const MAX_NIVEAU2_IN_GEHEUGEN = 9;

let index = null;
let engine = null;
const geheugen = new Map(); // pad -> { bytes (gzip), gebruikt }
const bron = { get(pad) { const t = geheugen.get(pad); if (!t) return undefined; t.gebruikt = Date.now(); return t.bytes; } };

const meld = bericht => self.postMessage(bericht);
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const isGzip = b => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
const stroom = (bytes, transformatie) => new Response(new Blob([bytes]).stream().pipeThrough(transformatie)).arrayBuffer().then(b => new Uint8Array(b));
const tegelUrl = pad => new URL(`tiles/${pad.replace(/\.gph$/, '.gphz')}`, BASIS).href;

/** Haal een tegel uit de cache of van de webhosting; controleer nieuwe downloads op grootte en SHA-256. */
async function haalTegel(pad, { bewaarAlleen = false } = {}) {
  const info = index.tegels[pad];
  if (!info) return null; // buiten de Nederlandse kaart
  const url = tegelUrl(pad);
  const cache = await caches.open(KAARTCACHE);
  const gecached = await cache.match(url);
  if (gecached) return bewaarAlleen ? null : new Uint8Array(await gecached.arrayBuffer());
  const antwoord = await fetch(url, { cache: 'no-store' });
  if (!antwoord.ok) throw new Error(`Kaartdeel ${pad} niet beschikbaar (HTTP ${antwoord.status})`);
  const ontvangen = new Uint8Array(await antwoord.arrayBuffer());
  const gz = isGzip(ontvangen) ? ontvangen : await stroom(ontvangen, new CompressionStream('gzip'));
  const ruw = isGzip(ontvangen) ? await stroom(ontvangen, new DecompressionStream('gzip')) : ontvangen;
  if (ruw.byteLength !== info.bytes || hex(await crypto.subtle.digest('SHA-256', ruw)) !== info.sha256) {
    throw new Error(`Kaartdeel ${pad} is beschadigd en wordt niet gebruikt`);
  }
  await cache.put(url, new Response(gz, { headers: { 'Content-Type': 'application/octet-stream' } }));
  return bewaarAlleen ? null : gz;
}

/** Zorg dat de tegels rond een positie in het werkgeheugen staan. Geeft het aantal nieuw geladen tegels. */
async function zorgVoorTegels(lat, lon) {
  const nodig = tegelsRond(lat, lon, 0.01).filter(p => index.tegels[p]);
  const nieuw = nodig.filter(p => !geheugen.has(p));
  if (!nieuw.length) return 0;
  for (const pad of nieuw) geheugen.set(pad, { bytes: await haalTegel(pad), gebruikt: Date.now() });
  // Beperk het werkgeheugen: oude lokale (niveau-2) tegels die nu niet nodig zijn, opruimen.
  const lokaal = [...geheugen.entries()].filter(([p]) => p.startsWith('2/') && !nodig.includes(p)).sort((a, b) => a[1].gebruikt - b[1].gebruikt);
  const teVeel = [...geheugen.keys()].filter(p => p.startsWith('2/')).length - MAX_NIVEAU2_IN_GEHEUGEN;
  for (const [p] of lokaal.slice(0, Math.max(0, teVeel))) geheugen.delete(p);
  engine.reset(); // de engine moet de nieuwe tegelset opnieuw inlezen
  return nieuw.length;
}

async function opslagOverzicht() {
  const cache = await caches.open(KAARTCACHE);
  const sleutels = await cache.keys();
  let gzBytes = 0;
  for (const s of sleutels) { const pad = new URL(s.url).pathname.split('/tiles/')[1]?.replace(/\.gphz$/, '.gph'); gzBytes += index?.tegels[pad]?.gzBytes ?? 0; }
  const schatting = await navigator.storage?.estimate?.().catch(() => null);
  return { tegelsInCache: sleutels.length, tegelsTotaal: Object.keys(index?.tegels ?? {}).length, cacheMB: gzBytes / 1048576, totaalMB: (index?.totaalGzBytes ?? 0) / 1048576, quotumMB: schatting?.quota ? schatting.quota / 1048576 : null, gebruiktMB: schatting?.usage ? schatting.usage / 1048576 : null };
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'start') {
      const s = performance.now();
      index = await (await fetch(new URL('tiles/index.json', BASIS), { cache: 'no-cache' })).json();
      engine = await loadValhalla({ tiles: bron, config: { mjolnir: { tile_url_gz: true, max_cache_size: 96 * 1024 * 1024 } } });
      meld({ type: 'gereed', ms: Math.round(performance.now() - s), kaart: index.kaart, licentie: index.licentie, opslag: await opslagOverzicht() });
    } else if (data.type === 'koppel') {
      const laatste = data.fixes.at(-1);
      const s1 = performance.now();
      const nieuw = await zorgVoorTegels(laatste.lat, laatste.lon);
      const s2 = performance.now();
      const resultaat = bepaalLimiet(engine, data.fixes);
      meld({ type: 'resultaat', id: data.id, resultaat, tegelMs: Math.round(s2 - s1), matchMs: Math.round((performance.now() - s2) * 10) / 10, nieuweTegels: nieuw, geheugenMB: Math.round(engine.memoryBytes / 1048576) });
    } else if (data.type === 'download') {
      const paden = Object.keys(index.tegels);
      let klaar = 0;
      for (const pad of paden) {
        await haalTegel(pad, { bewaarAlleen: true });
        klaar++;
        meld({ type: 'download_voortgang', klaar, totaal: paden.length });
      }
      meld({ type: 'download_klaar', opslag: await opslagOverzicht() });
    } else if (data.type === 'opslag') {
      meld({ type: 'opslag', opslag: await opslagOverzicht() });
    } else if (data.type === 'wis_kaart') {
      await caches.delete(KAARTCACHE);
      geheugen.clear(); engine?.reset();
      meld({ type: 'opslag', opslag: await opslagOverzicht() });
    }
  } catch (fout) {
    meld({ type: 'fout', id: data?.id ?? null, soort: data?.type, bericht: String(fout?.message ?? fout) });
  }
};
