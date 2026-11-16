// Geluid naar de auto (web 0.5).
//
// Twee routes:
// - 'media' (web 0.4, bewezen hoorbaar als de Opel op Bluetooth-audio staat): tijdens de rit één
//   onhoorbare draaggolf op een media-element; spraak via Web Audio daaroverheen gemengd.
// - 'gesprek' / 'microfoon': per melding audioSession 'play-and-record'. WebKit zet daarbij
//   AVAudioSessionCategoryOptionAllowBluetooth (HFP), de handsfree-route die de native app via
//   voicePrompt gebruikte (radio onderbroken, groen telefoontje). 'microfoon' opent daarnaast kort
//   de microfoon (getUserMedia) als dat nodig blijkt om HFP te openen. Na de melding wordt alles
//   losgelaten zodat de radio terugkomt. Welke route werkt, bepaalt de stilstaande geluidstest.
export const OPNAME_LIMIETEN = [...Array.from({ length: 130 }, (_, i) => i + 1), 140, 150, 160, 180, 200];
export const DRAAGGOLF = 'audio/draaggolf.m4a';
export const ROUTES = ['gesprek', 'microfoon', 'media'];
/** Media-route: zo lang loopt de stroom minimaal vóór de eerste zin. */
export const VOORBEREIDING_MS = 3000;
/** Handsfree-route: wachttijd na openen (native app: 1 s). */
export const GESPREK_VOORBEREIDING_MS = 1500;
/** Handsfree-route: zo lang blijft de verbinding open voor een direct volgende zin. */
export const GESPREK_NALOOP_MS = 1500;

export function bestandVoorTekst(tekst) {
  if (tekst === 'Snelheidsassistent is actief.') return 'audio/activatie.m4a';
  if (tekst === 'Proef één.') return 'audio/proef-1.m4a';
  if (tekst === 'Proef twee.') return 'audio/proef-2.m4a';
  const match = /^De maximumsnelheid is (\d+) kilometer per uur\.$/.exec(tekst);
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
  constructor({ maakAudio = () => new Audio(), maakContext = maakStandaardContext, haal = haalStandaard, haalElementBestand = async bestand => bestand,
    mediaSession = globalThis.navigator?.mediaSession,
    vraagMicrofoon = c => globalThis.navigator.mediaDevices.getUserMedia(c),
    audioSessie = () => globalThis.navigator?.audioSession,
    log = () => {}, nu = () => Date.now(), timeoutMs = 15000, voorbereidingMs = VOORBEREIDING_MS,
    gesprekVoorbereidingMs = GESPREK_VOORBEREIDING_MS, gesprekNaloopMs = GESPREK_NALOOP_MS, route = 'media' } = {}) {
    this.audio = maakAudio(); this.log = log; this.nu = nu; this.timeoutMs = timeoutMs; this.voorbereidingMs = voorbereidingMs;
    this.gesprekVoorbereidingMs = gesprekVoorbereidingMs; this.gesprekNaloopMs = gesprekNaloopMs;
    this.maakContext = maakContext; this.haal = haal; this.haalElementBestand = haalElementBestand; this.mediaSession = mediaSession;
    this.vraagMicrofoon = vraagMicrofoon; this.audioSessie = audioSessie; this.route = route;
    this.audio.preload = 'auto'; this.audio.volume = 1; this.audio.muted = false;
    this.ctx = null; this.buffers = new Map();
    this.ronde = 0; this.gereed = Promise.resolve(false); this.draaggolfSinds = 0;
    this.eigenPauze = false; this.elementSpraak = false; this.annuleer = null; this.annuleerWacht = null;
    this.gesprekOpen = false; this.gesprekSinds = 0; this.microfoon = null; this.sluitTimer = null;
    for (const naam of ['playing', 'pause', 'waiting', 'stalled', 'error']) {
      this.audio.addEventListener?.(naam, () => this.#draaggolfGebeurtenis(naam));
    }
    for (const actie of ['play', 'pause', 'stop']) {
      try { this.mediaSession?.setActionHandler?.(actie, () => this.#mediaActie(actie)); } catch { /* niet ondersteund */ }
    }
  }

  /** Huidige toestand voor het proeflog. Zegt niets over wat de bestuurder hoort. */
  toestand() {
    const sessie = this.audioSessie();
    return {
      route: this.route, audiosessie_type: sessie?.type ?? null, audiosessie_toestand: sessie?.state ?? null,
      mediasessie: this.mediaSession?.playbackState ?? null, webaudio: this.ctx?.state ?? null,
      gesprek_open: this.gesprekOpen, microfoon_aan: Boolean(this.microfoon),
      draaggolf_gepauzeerd: this.audio.paused, draaggolf_loopt_ms: this.draaggolfSinds ? this.nu() - this.draaggolfSinds : 0,
      draaggolf_gereedheid: this.audio.readyState ?? null,
    };
  }

  /** Direct vanuit de tik aanroepen: play() en resume() staan zonder await in het klikpad. */
  ontgrendel() {
    this.#annuleerLopend();
    const ronde = this.ronde;
    const context = this.#startContext();
    let element;
    if (this.route === 'media') { element = this.#startDraaggolf(); this.#zetMediaSessie('playing'); }
    else {
      // Alleen toestemming voor het element vastleggen (terugval en latere media-route); geen stroom.
      this.#sluitGesprek(); this.audio.pause(); this.draaggolfSinds = 0; this.#zetMediaSessie('paused');
      element = this.#ontgrendelElement();
    }
    this.gereed = Promise.all([element, context]).then(([e, c]) => {
      if (ronde !== this.ronde) return false;
      const ok = this.route === 'media' ? e : (c || e);
      if (ok) this.log('media_ontgrendeld', { webaudio_gereed: c, element_gereed: e, samplerate: this.ctx?.sampleRate ?? null, ...this.toestand() });
      return ok;
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
    return this.route === 'media' ? this.#spreekMedia(bestand, tekst, actueel) : this.#spreekGesprek(bestand, tekst, actueel);
  }

  /** Handsfree-verbinding direct loslaten (radio terug). */
  sluitGesprek() { this.#sluitGesprek(); }

  stop() {
    this.#annuleerLopend();
    this.#sluitGesprek();
    this.eigenPauze = true; this.audio.pause(); this.draaggolfSinds = 0;
    this.gereed = Promise.resolve(false);
    this.#zetMediaSessie('paused');
  }

  // ---------- media-route (web 0.4) ----------
  async #spreekMedia(bestand, tekst, actueel) {
    if (this.audio.paused) {
      this.log('draaggolf_hervatten', { bestand });
      if (!await this.#startDraaggolf()) return actueel() ? 'fout' : 'afgebroken';
      this.#zetMediaSessie('playing');
    }
    const buffer = this.ctx ? this.#laadBuffer(bestand) : Promise.resolve(null);
    if (!await this.#wacht(Math.max(0, this.draaggolfSinds + this.voorbereidingMs - this.nu())) || !actueel()) return 'afgebroken';
    await this.#hervatContext();
    const geladen = this.ctx?.state === 'running' ? await buffer : null;
    if (!actueel()) return 'afgebroken';
    return geladen ? this.#speelBuffer(geladen, bestand, tekst, actueel) : this.#speelViaElement(bestand, tekst, actueel);
  }

  // ---------- handsfree-route ----------
  async #spreekGesprek(bestand, tekst, actueel) {
    clearTimeout(this.sluitTimer); this.sluitTimer = null;
    const buffer = this.ctx ? this.#laadBuffer(bestand) : Promise.resolve(null);
    if (!this.gesprekOpen) {
      this.#zetType('play-and-record');
      this.gesprekOpen = true; this.gesprekSinds = this.nu();
      if (this.route === 'microfoon') {
        try {
          const stroom = await this.vraagMicrofoon({ audio: true });
          if (!actueel()) { for (const t of stroom.getTracks()) t.stop(); this.#sluitGesprek(); return 'afgebroken'; }
          this.microfoon = stroom; this.gesprekSinds = this.nu(); this.log('microfoon_aan');
        } catch (e) {
          this.log('microfoon_fout', { naam: e?.name ?? null, bericht: e?.message ?? null });
          this.#sluitGesprek(); return actueel() ? 'fout' : 'afgebroken';
        }
      }
      await this.#hervatContext();
      this.log('gesprek_geopend', this.toestand());
    }
    const wacht = Math.max(0, this.gesprekSinds + this.gesprekVoorbereidingMs - this.nu());
    if (!await this.#wacht(wacht) || !actueel()) { this.#planSluiten(); return 'afgebroken'; }
    const geladen = this.ctx?.state === 'running' ? await buffer : null;
    if (!actueel()) { this.#planSluiten(); return 'afgebroken'; }
    const uitkomst = geladen ? await this.#speelBuffer(geladen, bestand, tekst, actueel) : await this.#speelViaElement(bestand, tekst, actueel);
    if (this.gesprekOpen) this.#planSluiten();
    return uitkomst;
  }

  #planSluiten() {
    clearTimeout(this.sluitTimer);
    this.sluitTimer = setTimeout(() => { this.sluitTimer = null; this.#sluitGesprek(); }, this.gesprekNaloopMs);
  }

  #sluitGesprek() {
    clearTimeout(this.sluitTimer); this.sluitTimer = null;
    if (this.microfoon) { for (const t of this.microfoon.getTracks()) t.stop(); this.microfoon = null; this.log('microfoon_uit'); }
    if (!this.gesprekOpen) return;
    this.gesprekOpen = false;
    // Geen lopende Web Audio meer, dan geeft WebKit de audiosessie vrij en eindigt de handsfree-verbinding.
    try { Promise.resolve(this.ctx?.suspend?.()).catch(() => {}); } catch { /* al gesloten */ }
    this.#zetType('playback');
    this.log('gesprek_gesloten', this.toestand());
  }

  #zetType(type) {
    const sessie = this.audioSessie();
    if (!sessie) return;
    try { sessie.type = type; this.log('audiotype', { gevraagd: type, gemeld: sessie.type, toestand: sessie.state ?? null }); }
    catch (e) { this.log('audiotype_fout', { gevraagd: type, bericht: e.message }); }
  }

  // ---------- gedeeld ----------
  #annuleerLopend() { this.ronde++; this.annuleerWacht?.(); this.annuleer?.(); }

  /** true = gewacht, false = geannuleerd. */
  #wacht(ms) {
    if (!ms) return Promise.resolve(true);
    this.log('media_voorbereiding', { ms, route: this.route });
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.annuleerWacht = null; resolve(true); }, ms);
      this.annuleerWacht = () => { clearTimeout(timer); this.annuleerWacht = null; resolve(false); };
    });
  }

  async #hervatContext() {
    if (!this.ctx || this.ctx.state === 'running') return;
    try { await this.ctx.resume(); } catch (e) { this.log('webaudio_hervatten_fout', { naam: e.name, bericht: e.message }); }
  }

  #ontgrendelElement() {
    if (!String(this.audio.src).endsWith(DRAAGGOLF)) this.audio.src = DRAAGGOLF;
    this.audio.loop = true; this.eigenPauze = true;
    try {
      return Promise.resolve(this.audio.play()).then(() => { this.audio.pause(); return true; }, () => false);
    } catch { return Promise.resolve(false); }
  }

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
        this.log('media_uitkomst', { bestand, tekst, uitkomst, speler: 'webaudio', duur_s: rond(buffer.duration),
          verstreken_ms: this.nu() - start, context_voortgang_s: rond(this.ctx.currentTime - ctxStart), ...this.toestand() });
        resolve(uitkomst);
      };
      this.annuleer = () => einde('afgebroken');
      const timer = setTimeout(() => { this.log('media_geen_afronding', { bestand }); einde('fout'); }, buffer.duration * 1000 + this.timeoutMs);
      bron.onended = () => einde(actueel() ? 'afgerond' : 'afgebroken');
      this.log('media_gestart', { bestand, tekst, speler: 'webaudio', duur_s: rond(buffer.duration), ...this.toestand() });
      try { bron.start(); } catch (e) { this.log('media_afspelen_geweigerd', { naam: e.name, bericht: e.message }); einde('fout'); }
    });
  }

  /** Terugval zonder Web Audio: opname op hetzelfde element; in de media-route daarna de draaggolf terug. */
  async #speelViaElement(bestand, tekst, actueel) {
    let bron;
    try { bron = await this.haalElementBestand(bestand); }
    catch (e) { this.log('media_laden_fout', { bestand, bericht: e.message }); return actueel() ? 'fout' : 'afgebroken'; }
    if (!actueel()) return 'afgebroken';
    return new Promise(resolve => {
      let klaar = false;
      const start = this.nu(), ronde = this.ronde;
      const einde = uitkomst => {
        if (klaar) return; klaar = true; clearTimeout(timer);
        this.audio.onplaying = this.audio.onended = this.audio.onerror = null; this.annuleer = null;
        this.log('media_uitkomst', { bestand, tekst, uitkomst, speler: 'element', verstreken_ms: this.nu() - start, ...this.toestand() });
        if (ronde === this.ronde && this.route === 'media') this.#startDraaggolf();
        else { this.eigenPauze = true; this.audio.pause(); }
        resolve(uitkomst);
      };
      this.annuleer = () => einde('afgebroken');
      const timer = setTimeout(() => { this.log('media_geen_afronding', { bestand }); einde('fout'); }, this.timeoutMs);
      this.audio.onplaying = () => {
        if (!actueel()) { einde('afgebroken'); return; }
        this.log('media_gestart', { bestand, tekst, speler: 'element', volume: this.audio.volume, gedempt: this.audio.muted, ...this.toestand() });
      };
      this.audio.onended = () => einde(actueel() ? 'afgerond' : 'afgebroken');
      this.audio.onerror = () => { this.log('media_fout', { bestand, code: this.audio.error?.code ?? null }); einde('fout'); };
      this.elementSpraak = true; this.audio.loop = false; this.audio.src = bron;
      this.log('media_aangevraagd', { bestand, tekst, speler: 'element' });
      try {
        Promise.resolve(this.audio.play()).catch(e => { this.log('media_afspelen_geweigerd', { naam: e.name, bericht: e.message }); einde(actueel() ? 'fout' : 'afgebroken'); });
      } catch (e) { this.log('media_afspelen_geweigerd', { naam: e.name, bericht: e.message }); einde('fout'); }
    });
  }

  #zetMediaSessie(stand) {
    const ms = this.mediaSession;
    if (!ms) return;
    try {
      if (stand === 'playing' && !ms.metadata && typeof globalThis.MediaMetadata === 'function') {
        ms.metadata = new globalThis.MediaMetadata({ title: 'Snelheidsassistent', artist: 'Maximumsnelheid', album: 'Snelheidsassistent' });
      }
      ms.playbackState = stand;
    } catch (e) { this.log('mediasessie_fout', { bericht: e.message }); }
  }

  #mediaActie(actie) {
    this.log('mediasessie_actie', { actie, ...this.toestand() });
    if (this.route !== 'media') return;
    if (actie === 'play') {
      this.#startDraaggolf().then(ok => { if (ok) this.#zetMediaSessie('playing'); });
    } else {
      this.eigenPauze = true; this.audio.pause(); this.draaggolfSinds = 0; this.#zetMediaSessie('paused');
    }
  }

  #draaggolfGebeurtenis(naam) {
    if (this.elementSpraak || this.route !== 'media') return;
    if (naam === 'playing') { if (!this.draaggolfSinds) this.draaggolfSinds = this.nu(); return; }
    if (naam === 'pause') {
      if (this.eigenPauze) return;
      this.draaggolfSinds = 0;
      this.log('draaggolf_gepauzeerd_extern', this.toestand()); return;
    }
    this.log('draaggolf_' + naam, { code: this.audio.error?.code ?? null, ...this.toestand() });
  }
}
