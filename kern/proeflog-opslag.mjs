const MAX_RIJEN = 30000;
const BEWAAR_MS = 7 * 24 * 60 * 60 * 1000;
export class ProeflogOpslag {
  constructor({ indexedDB = globalThis.indexedDB, naam = 'snelheidsassistent-proeflog', nu = () => Date.now(), status = () => {} } = {}) {
    this.nu = nu; this.status = status; this.geheugen = []; this.nummer = 0;
    this.sessie = `${nu()}-${Math.random().toString(36).slice(2)}`;
    this.db = new Promise(resolve => {
      if (!indexedDB) { status(false); resolve(null); return; }
      try {
        const q = indexedDB.open(naam, 1);
        q.onupgradeneeded = () => { if (!q.result.objectStoreNames.contains('regels')) q.result.createObjectStore('regels', { keyPath: 'id' }); };
        q.onsuccess = () => { status(true); resolve(q.result); };
        q.onerror = q.onblocked = () => { status(false); resolve(null); };
      } catch { status(false); resolve(null); }
    });
    this.staart = this.db.then(db => db ? this._snoei(db) : null).catch(() => status(false));
  }
  record(gebeurtenis, velden = {}) {
    const tijd = this.nu();
    const rij = { tijd_utc: new Date(tijd).toISOString(), gebeurtenis, ...velden, sessie: this.sessie };
    const nummer = ++this.nummer;
    const item = { id: `${this.sessie}:${String(nummer).padStart(8, '0')}`, tijd, rij };
    this.geheugen.push(item);
    if (this.geheugen.length > MAX_RIJEN) this.geheugen.splice(0, this.geheugen.length - MAX_RIJEN);
    this.staart = this.staart.then(async () => {
      const db = await this.db; if (!db) return;
      await this._mutatie(db, store => store.put(item));
      if (nummer % 200 === 0) await this._snoei(db);
    }).catch(() => this.status(false));
  }
  _mutatie(db, actie) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('regels', 'readwrite'); actie(tx.objectStore('regels'));
      tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  _lees(db) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('regels', 'readonly'); const q = tx.objectStore('regels').getAll();
      q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error);
    });
  }
  async _snoei(db) {
    const alle = (await this._lees(db)).sort((a,b) => a.tijd - b.tijd || a.id.localeCompare(b.id));
    const behouden = alle.filter(a => a.tijd >= this.nu() - BEWAAR_MS).slice(-MAX_RIJEN);
    const ids = new Set(behouden.map(a => a.id));
    const weg = alle.filter(a => !ids.has(a.id));
    if (weg.length) await this._mutatie(db, store => weg.forEach(a => store.delete(a.id)));
  }
  async exporteer() {
    await this.staart;
    let opgeslagen = [];
    try { const db = await this.db; if (db) { await this._snoei(db); opgeslagen = await this._lees(db); } } catch { this.status(false); }
    const samen = new Map(opgeslagen.map(a => [a.id, a]));
    this.geheugen.forEach(a => samen.set(a.id, a));
    return [...samen.values()].filter(a => a.tijd >= this.nu() - BEWAAR_MS)
      .sort((a,b) => a.tijd - b.tijd || a.id.localeCompare(b.id)).slice(-MAX_RIJEN).map(a => a.rij);
  }
}
