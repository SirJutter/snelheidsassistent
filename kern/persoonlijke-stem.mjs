// Persoonlijke opnamen blijven in IndexedDB op dit toestel, buiten de openbare appcache.
import { OPNAME_LIMIETEN } from './audio-bestanden.mjs?v=0.5.2';

export const STEM_TEKSTEN = Object.fromEntries([
  ['audio/activatie.m4a', 'Snelheidsassistent is actief.'],
  ['audio/proef-1.m4a', 'Proef één.'], ['audio/proef-2.m4a', 'Proef twee.'],
  ...OPNAME_LIMIETEN.map(n => [`audio/limiet-${n}.m4a`, `De maximumsnelheid is ${n} kilometer per uur.`]),
]);

export async function controleerStem(pak) {
  if (pak?.formaat !== 'snelheidsassistent-persoonlijke-stem-1' ||
      pak.stem !== 'Xander (verbeterd)' || pak.kwaliteit !== 2 ||
      !/^com\.apple\.voice\.enhanced\.nl-NL\.Xander$/.test(pak.identificatie ?? '')) {
    throw Error('Dit is geen stempakket met Xander (verbeterd).');
  }
  const opnamen = pak.opnamen;
  if (!Array.isArray(opnamen) || opnamen.length !== Object.keys(STEM_TEKSTEN).length) {
    throw Error('Het stempakket is niet compleet.');
  }
  const bestanden = new Map();
  for (const r of opnamen) {
    if (!Object.hasOwn(STEM_TEKSTEN, r.bestand) || r.tekst !== STEM_TEKSTEN[r.bestand] || bestanden.has(r.bestand) ||
        typeof r.audio !== 'string' || r.audio.length < 16 || r.audio.length > 1500000) {
      throw Error('Een opname ontbreekt, is dubbel of hoort bij een andere melding.');
    }
    let bytes;
    try { bytes = Uint8Array.from(atob(r.audio), c => c.charCodeAt(0)); }
    catch { throw Error('Een opname is beschadigd.'); }
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map(b => b.toString(16).padStart(2, '0')).join('');
    if (hash !== r.sha256 || String.fromCharCode(...bytes.slice(4, 8)) !== 'ftyp') throw Error('Een opname is beschadigd.');
    bestanden.set(r.bestand, bytes.buffer);
  }
  return { stem: pak.stem, identificatie: pak.identificatie, bestanden };
}

export class PersoonlijkeStem {
  constructor({ indexedDB = globalThis.indexedDB, naam = 'snelheidsassistent-persoonlijke-stem', status = () => {} } = {}) {
    this.actief = null; this.urls = new Map(); this.status = status;
    this.db = new Promise(resolve => {
      if (!indexedDB) { resolve(null); return; }
      try {
        const q = indexedDB.open(naam, 1);
        q.onupgradeneeded = () => q.result.createObjectStore('stem');
        q.onsuccess = () => resolve(q.result);
        q.onerror = q.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
    this.gereed = this.db.then(async db => {
      if (!db) return;
      this.actief = await new Promise((resolve, reject) => {
        const q = db.transaction('stem').objectStore('stem').get('actief');
        q.onsuccess = () => resolve(q.result ?? null); q.onerror = () => reject(q.error);
      });
    }).catch(() => { this.actief = null; }).then(() => this.status(this.actief?.stem ?? null));
  }
  async importeer(tekst) {
    if (typeof tekst !== 'string' || tekst.length > 30000000) throw Error('Het stembestand is te groot.');
    const nieuw = await controleerStem(JSON.parse(tekst));
    await this.gereed;
    const db = await this.db;
    if (!db) throw Error('Deze iPhone kan de stem niet blijvend opslaan.');
    // Alles in één transactie: een mislukte import houdt de vorige stem intact.
    await new Promise((resolve, reject) => {
      const tx = db.transaction('stem', 'readwrite'); tx.objectStore('stem').put(nieuw, 'actief');
      tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error);
    });
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.actief = nieuw; this.status(nieuw.stem);
  }
  async elementBestand(bestand) {
    await this.gereed;
    const data = this.actief?.bestanden.get(bestand);
    if (!data) return bestand;
    if (!this.urls.has(bestand)) this.urls.set(bestand, URL.createObjectURL(new Blob([data], { type: 'audio/mp4' })));
    return this.urls.get(bestand);
  }
  async haal(bestand) {
    await this.gereed;
    return this.actief?.bestanden.get(bestand)?.slice(0) ?? null;
  }
}
