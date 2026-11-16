// Geluid via de Bluetooth-mediaroute (web 0.4).
//
// Web 0.2/0.3 startte per melding een korte mediastroom (stilte → opname → einde).
// De Opel liet die korte stromen niet horen, terwijl doorlopende muziek wel klinkt.
// Daarom nu: tijdens de rit speelt één media-element een onhoorbare draaggolf in een
// lus (Now Playing "Snelheidsassistent", status speelt). De gesproken opnamen worden via
// Web Audio over die lopende stroom gemengd: geen bronwissel, pauze of nieuwe stroom per melding.
// Zonder Web Audio valt de speler terug op afspelen via hetzelfde media-element.
export const OPNAME_LIMIETEN = [...Array.from({ length: 130 }, (_, i) => i + 1), 140, 150, 160, 180, 200];
export const DRAAGGOLF = 'audio/draaggolf.m4a';
/** Zo lang loopt de stroom minimaal vóór de eerste zin (autoradio ontdempen). */
export const VOORBEREIDING_MS = 3000;

export function bestandVoorTekst(tekst) {
  if (tekst === 'Snelheidsassistent geactiveerd.') return 'audio/activatie.m4a';
  if (tekst === 'Dit is een stemtest. Maximumsnelheid is vijftig kilometer per uur.') return 'audio/stemtest.m4a';
  const match = /^Maximumsnelheid is (\d+) kilometer per uur$/.exec(tekst);
  return match && OPNAME_LIMIETEN.includes(Number(match[1])) ? `audio/limiet-${Number(match[1])}.m4a` : null;
}

function maakStandaardContext() {
  const C = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!C) return null;
  try { return new C({ latencyHint: 'playback' }); } catch { return new C(); }
}
const haalStandaard = async url => {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.arrayBuffer();
};
const rond = (v, n = 2) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10 ** n) / 10 ** n : null);

export class BestandsSpeler {
  constructor({ maakAudio = () => new Audio(), maakContext = maakStandaardContext, haal = haalStandaard,
    mediaSession = globalThis.navigator?.mediaSession, log = () => {}, nu = () => Date.now(),
    timeoutMs = 15000, voorbereidingMs = VOORBEREIDING_MS } = {}) {
    this.audio = maakAudio(); this.log = log; this.nu = nu; this.timeoutMs = timeoutMs; this.voorbereidingMs = voorbereidingMs;
    this.maakContext = maakContext; this.haal = haal; this.mediaSession = mediaSession;
    this.audio.preload = 'auto'; this.audio.volume = 1; this.audio.muted = false;
    this.ctx = null; this.buffers = new Map();
    this.ronde = 0; this.gereed = Promise.resolve(false); this.draaggolfSinds = 0;
    this.eigenPauze = false; this.elementSpraak = false; this.annuleer = null; this.annuleerWacht = null;
    // Pauzes of haperingen die niet van ons komen (route, onderbreking, autoradio) zichtbaar maken.
    for (const naam of ['playing', 'pause', 'waiting', 'stalled', 'error']) {
      this.audio.addEventListener?.(naam, () => this.#draaggolfGebeurtenis(naam));
    }
    for (const actie of ['play', 'pause', 'stop']) {
      try { this.mediaSession?.setActionHandler?.(actie, () => this.#mediaActie(actie)); } catch { /* niet ondersteund */ }
    }
  }

  /** Huidige toestand voor het proeflog. Zegt niets over wat de bestuurder hoort. */
  toestand() {
    const sessie = globalThis.navigator?.audioSession;
    return {
      audiosessie_type: sessie?.type ?? null, audiosessie_toestand: sessie?.state ?? null,
      mediasessie: this.mediaSession?.playbackState ?? null, webaudio: this.ctx?.state ?? null,
      draaggolf_gepauzeerd: this.audio.paused, draaggolf_loopt_ms: this.draaggolfSinds ? this.nu() - this.draaggolfSinds : 0,
      draaggolf_gereedheid: this.audio.readyState ?? null,
    };
  }

  /** Direct vanuit de tik aanroepen: play() en resume() staan zonder await in het klikpad. */
  ontgrendel() {
    this.#annuleerLopend();
    const ronde = this.ronde;
    const draaggolf = this.#startDraaggolf();
    const context = this.#startContext();
    this.#zetMediaSessie('playing');
    this.gereed = Promise.all([draaggolf, context]).then(([d, c]) => {
      if (ronde !== this.ronde) return false;
      if (d) this.log('media_ontgrendeld', { webaudio_gereed: c, samplerate: this.ctx?.sampleRate ?? null, ...this.toestand() });
      return d;
    });
    return this.gereed;
  }

  async spreek(bestand, { isActueel = () => true, tekst = '' } = {}) {
    const ronde = this.ronde;
    const actueel = () => ronde === this.ronde && isActueel();
    if (!actueel()) return 'afgebroken';
    if (!await this.gereed) {
      if (ronde !== this.ronde) return 'afgebroken';
      this.log('media_niet_vrijgegeven', { bestand }); return 'fout';
    }
    if (!actueel()) return 'afgebroken';
    if (this.audio.paused) {
      // Bijvoorbeeld door de autoradio of een onderbreking gepauzeerd.
      this.log('draaggolf_hervatten', { bestand });
      if (!await this.#startDraaggolf()) return actueel() ? 'fout' : 'afgebroken';
      this.#zetMediaSessie('playing');
    }
    const buffer = this.ctx ? this.#laadBuffer(bestand) : Promise.resolve(null);
    const wachten = Math.max(0, this.draaggolfSinds + this.voorbereidingMs - this.nu());
    if (wachten) {
      this.log('media_voorbereiding', { ms: wachten });
      await new Promise(resolve => {
        const timer = setTimeout(() => { this.annuleerWacht = null; resolve(); }, wachten);
        this.annuleerWacht = () => { clearTimeout(timer); this.annuleerWacht = null; resolve(); };
      });
    }
    if (!actueel()) return 'afgebroken';
    if (this.ctx && this.ctx.state !== 'running') {
      try { await this.ctx.resume(); } catch (e) { this.log('webaudio_hervatten_fout', { naam: e.name, bericht: e.message }); }
    }
    const geladen = this.ctx?.state === 'running' ? await buffer : null;
    if (!actueel()) return 'afgebroken';
    return geladen ? this.#speelBuffer(geladen, bestand, tekst, actueel) : this.#speelViaElement(bestand, tekst, actueel);
  }

  stop() {
    this.#annuleerLopend();
    this.eigenPauze = true; this.audio.pause(); this.draaggolfSinds = 0;
    this.gereed = Promise.resolve(false);
    this.#zetMediaSessie('paused');
  }

  // ---------- intern ----------
  #annuleerLopend() { this.ronde++; this.annuleerWacht?.(); this.annuleer?.(); }

  #startDraaggolf() {
    if (!this.audio.paused && !this.elementSpraak && String(this.audio.src).endsWith(DRAAGGOLF)) return Promise.resolve(true);
    this.elementSpraak = false; this.eigenPauze = false;
    if (!String(this.audio.src).endsWith(DRAAGGOLF)) this.audio.src = DRAAGGOLF;
    this.audio.loop = true;
    const fout = e => { this.log('draaggolf_fout', { naam: e?.name ?? null, bericht: e?.message ?? null }); return false; };
    try {
      return Promise.resolve(this.audio.play()).then(() => { if (!this.draaggolfSinds) this.draaggolfSinds = this.nu(); return true; }, fout);
    } catch (e) { return Promise.resolve(fout(e)); }
  }

  #startContext() {
    try {
      if (!this.ctx) {
        this.ctx = this.maakContext();
        if (!this.ctx) { this.log('webaudio_niet_beschikbaar'); return Promise.resolve(false); }
        this.ctx.onstatechange = () => this.log('webaudio_toestand', { toestand: this.ctx.state });
      }
      // Een leeg monster in het klikpad geeft de context op iOS vrij.
      const leeg = this.ctx.createBufferSource();
      leeg.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      leeg.connect(this.ctx.destination); leeg.start(0);
      return Promise.resolve(this.ctx.resume()).then(() => this.ctx.state === 'running',
        e => { this.log('webaudio_fout', { naam: e.name, bericht: e.message }); return false; });
    } catch (e) { this.log('webaudio_fout', { naam: e.name, bericht: e.message }); return Promise.resolve(false); }
  }

  #laadBuffer(bestand) {
    if (!this.buffers.has(bestand)) {
      const belofte = this.haal(bestand)
        .then(data => new Promise((ok, fout) => { const p = this.ctx.decodeAudioData(data, ok, fout); p?.then?.(ok, fout); }))
        .catch(e => { this.buffers.delete(bestand); this.log('media_laden_fout', { bestand, naam: e?.name ?? null, bericht: e?.message ?? String(e) }); return null; });
      this.buffers.set(bestand, belofte);
    }
    return this.buffers.get(bestand);
  }

  #speelBuffer(buffer, bestand, tekst, actueel) {
    return new Promise(resolve => {
      let klaar = false;
      const bron = this.ctx.createBufferSource();
      bron.buffer = buffer; bron.connect(this.ctx.destination);
      const start = this.nu(), ctxStart = this.ctx.currentTime;
      const einde = uitkomst => {
        if (klaar) return; klaar = true; clearTimeout(timer);
        bron.onended = null; this.annuleer = null;
        if (uitkomst !== 'afgerond') { try { bron.stop(); } catch { /* al gestopt */ } }
        this.log('media_uitkomst', { bestand, tekst, uitkomst, route: 'webaudio', duur_s: rond(buffer.duration),
          verstreken_ms: this.nu() - start, context_voortgang_s: rond(this.ctx.currentTime - ctxStart), ...this.toestand() });
        resolve(uitkomst);
      };
      this.annuleer = () => einde('afgebroken');
      const timer = setTimeout(() => { this.log('media_geen_afronding', { bestand }); einde('fout'); }, buffer.duration * 1000 + this.timeoutMs);
      bron.onended = () => einde(actueel() ? 'afgerond' : 'afgebroken');
      this.log('media_gestart', { bestand, tekst, route: 'webaudio', duur_s: rond(buffer.duration), ...this.toestand() });
      try { bron.start(); } catch (e) { this.log('media_afspelen_geweigerd', { naam: e.name, bericht: e.message }); einde('fout'); }
    });
  }

  /** Terugval zonder Web Audio: opname op hetzelfde element, daarna direct de draaggolf terug. */
  #speelViaElement(bestand, tekst, actueel) {
    return new Promise(resolve => {
      let klaar = false;
      const start = this.nu(), ronde = this.ronde;
      const einde = uitkomst => {
        if (klaar) return; klaar = true; clearTimeout(timer);
        this.audio.onplaying = this.audio.onended = this.audio.onerror = null; this.annuleer = null;
        this.log('media_uitkomst', { bestand, tekst, uitkomst, route: 'element', verstreken_ms: this.nu() - start, ...this.toestand() });
        if (ronde === this.ronde) this.#startDraaggolf();
        resolve(uitkomst);
      };
      this.annuleer = () => einde('afgebroken');
      const timer = setTimeout(() => { this.log('media_geen_afronding', { bestand }); einde('fout'); }, this.timeoutMs);
      this.audio.onplaying = () => {
        if (!actueel()) { einde('afgebroken'); return; }
        this.log('media_gestart', { bestand, tekst, route: 'element', volume: this.audio.volume, gedempt: this.audio.muted, ...this.toestand() });
      };
      this.audio.onended = () => einde(actueel() ? 'afgerond' : 'afgebroken');
      this.audio.onerror = () => { this.log('media_fout', { bestand, code: this.audio.error?.code ?? null }); einde('fout'); };
      this.elementSpraak = true; this.audio.loop = false; this.audio.src = bestand;
      this.log('media_aangevraagd', { bestand, tekst, route: 'element' });
      try {
        Promise.resolve(this.audio.play()).catch(e => { this.log('media_afspelen_geweigerd', { naam: e.name, bericht: e.message }); einde(actueel() ? 'fout' : 'afgebroken'); });
      } catch (e) { this.log('media_afspelen_geweigerd', { naam: e.name, bericht: e.message }); einde('fout'); }
    });
  }

  #zetMediaSessie(stand) {
    const ms = this.mediaSession;
    if (!ms) return;
    try {
      if (!ms.metadata && typeof globalThis.MediaMetadata === 'function') {
        ms.metadata = new globalThis.MediaMetadata({ title: 'Snelheidsassistent', artist: 'Maximumsnelheid', album: 'Snelheidsassistent' });
      }
      ms.playbackState = stand;
    } catch (e) { this.log('mediasessie_fout', { bericht: e.message }); }
  }

  #mediaActie(actie) {
    this.log('mediasessie_actie', { actie, ...this.toestand() });
    if (actie === 'play') {
      this.#startDraaggolf().then(ok => { if (ok) this.#zetMediaSessie('playing'); });
    } else {
      this.eigenPauze = true; this.audio.pause(); this.draaggolfSinds = 0; this.#zetMediaSessie('paused');
    }
  }

  #draaggolfGebeurtenis(naam) {
    if (this.elementSpraak) return;
    if (naam === 'playing') { if (!this.draaggolfSinds) this.draaggolfSinds = this.nu(); return; }
    if (naam === 'pause') {
      if (this.eigenPauze) return;
      this.draaggolfSinds = 0;
      this.log('draaggolf_gepauzeerd_extern', this.toestand()); return;
    }
    this.log('draaggolf_' + naam, { code: this.audio.error?.code ?? null, ...this.toestand() });
  }
}
