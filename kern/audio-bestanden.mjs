// Eén blijvend media-element: iOS verleent afspeeltoestemming per element.
export const OPNAME_LIMIETEN = [...Array.from({ length: 130 }, (_, i) => i + 1), 140, 150, 160, 180, 200];
export function bestandVoorTekst(tekst) {
  if (tekst === 'Snelheidsassistent geactiveerd.') return 'audio/activatie.m4a';
  if (tekst === 'Dit is een stemtest. Maximumsnelheid is vijftig kilometer per uur.') return 'audio/stemtest.m4a';
  const match = /^Maximumsnelheid is (\d+) kilometer per uur$/.exec(tekst);
  return match && OPNAME_LIMIETEN.includes(Number(match[1])) ? `audio/limiet-${Number(match[1])}.m4a` : null;
}
export class BestandsSpeler {
  constructor({ maakAudio = () => new Audio(), log = () => {}, nu = () => Date.now(), timeoutMs = 15000 } = {}) {
    this.audio = maakAudio(); this.log = log; this.nu = nu; this.timeoutMs = timeoutMs;
    this.audio.preload = 'auto'; this.audio.volume = 1; this.audio.muted = false;
    this.ronde = 0; this.gereed = Promise.resolve(false); this.geopend = 0; this.laatsteEinde = 0;
    this.annuleer = null; this.annuleerWacht = null;
  }
  ontgrendel() {
    this.stop();
    this.audio.src = 'audio/stilte.wav'; this.audio.loop = true;
    // play() staat direct in het klikpad; geen fetch, timer of await ervoor.
    const ronde = this.ronde;
    try {
      this.gereed = Promise.resolve(this.audio.play()).then(() => {
        if (ronde !== this.ronde) return false;
        this.geopend = this.nu(); this.log('media_ontgrendeld'); return true;
      }, e => { this.log('media_ontgrendelen_fout', { naam: e.name, bericht: e.message }); return false; });
    } catch (e) { this.log('media_ontgrendelen_fout', { naam: e.name, bericht: e.message }); this.gereed = Promise.resolve(false); }
    return this.gereed;
  }
  async spreek(bestand, { voorbereiding = 1, isActueel = () => true, tekst = '' } = {}) {
    const ronde = this.ronde;
    const actueel = () => ronde === this.ronde && isActueel();
    if (!actueel()) return 'afgebroken';
    if (!await this.gereed) {
      if (ronde !== this.ronde) return 'afgebroken';
      this.log('media_niet_vrijgegeven', { bestand }); return 'fout';
    }
    if (!actueel()) return 'afgebroken';
    if (this.nu() - this.laatsteEinde > 5000 && this.audio.paused) {
      try {
        this.audio.src = 'audio/stilte.wav'; this.audio.loop = true;
        await this.audio.play(); this.geopend = this.nu();
      } catch (e) { this.log('media_voorbereiding_fout', { naam: e.name, bericht: e.message }); return 'fout'; }
    }
    const wachten = this.nu() - this.laatsteEinde > 5000 ? Math.max(0, voorbereiding * 1000 - (this.nu() - this.geopend)) : 0;
    if (wachten) {
      this.log('media_voorbereiding', { ms: wachten });
      await new Promise(resolve => {
        const timer = setTimeout(() => { this.annuleerWacht = null; resolve(); }, wachten);
        this.annuleerWacht = () => { clearTimeout(timer); this.annuleerWacht = null; resolve(); };
      });
    }
    if (!actueel()) return 'afgebroken';
    return new Promise(resolve => {
      let klaar = false;
      const einde = uitkomst => {
        if (klaar) return; klaar = true; clearTimeout(timer);
        this.audio.onplaying = this.audio.onended = this.audio.onerror = null;
        this.annuleer = null; this.laatsteEinde = this.nu();
        if (uitkomst !== 'afgerond') this.audio.pause();
        this.log('media_uitkomst', { bestand, tekst, uitkomst }); resolve(uitkomst);
      };
      this.annuleer = () => einde('afgebroken');
      const timer = setTimeout(() => { this.log('media_geen_afronding', { bestand }); einde('fout'); }, this.timeoutMs);
      this.audio.onplaying = () => {
        if (!actueel()) { einde('afgebroken'); return; }
        this.log('media_gestart', { bestand, tekst, volume: this.audio.volume, gedempt: this.audio.muted });
      };
      this.audio.onended = () => einde(actueel() ? 'afgerond' : 'afgebroken');
      this.audio.onerror = () => { this.log('media_fout', { bestand, code: this.audio.error?.code ?? null }); einde('fout'); };
      this.audio.loop = false; this.audio.src = bestand;
      this.log('media_aangevraagd', { bestand, tekst });
      try {
        Promise.resolve(this.audio.play()).catch(e => { this.log('media_afspelen_geweigerd', { naam: e.name, bericht: e.message }); einde(actueel() ? 'fout' : 'afgebroken'); });
      } catch (e) { this.log('media_afspelen_geweigerd', { naam: e.name, bericht: e.message }); einde('fout'); }
    });
  }
  stop() {
    this.ronde++;
    this.annuleerWacht?.(); this.annuleer?.(); this.audio.pause(); this.audio.loop = false;
    this.gereed = Promise.resolve(false); this.laatsteEinde = 0;
  }
}
