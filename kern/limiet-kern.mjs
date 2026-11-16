// Kernlogica van de Snelheidsassistent-webapp.
// Zuivere functies, bruikbaar in een Web Worker, op de hoofdpagina en in Node-tests.
// Grenswaarden zijn gelijk aan de native app 1.6 (7), zie SpeedLimitService.swift en
// OfflineSpeedLimitProvider.swift in de v7-broncode.

export const GRENZEN = Object.freeze({
  gpsMaxOnzekerheidM: 30,   // native: horizontalAccuracy <= 30
  gpsMaxLeeftijdS: 5,       // native: abs(age) <= 5
  versheidS: 8,             // native: limiet/GPS ongeldig na 8 s
  spoorMaxS: 20,            // native: punten ouder dan 20 s vervallen
  spoorMaxPunten: 20,       // native: maximaal 20 punten
  onderbrekingS: 10,        // native: gat > 10 s => spoor wissen
  sprongM: 200,             // native: sprong > 200 m => spoor wissen
  wegMaxAfstandM: 30,       // native: distance_from_trace_point <= 30
  herpogingPunten: 6,       // native: bij fout opnieuw met laatste 6 punten
  aanvraagIntervalMs: 1000, // native: maximaal 1 kaartaanvraag per seconde
});

const R = 6371008.8;
const rad = d => d * Math.PI / 180;

export function afstandM(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function koersGraden(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

export function hoekVerschil(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Valhalla-polyline met precisie 6. */
export function decodeerPolyline6(tekst) {
  const punten = [];
  let i = 0, lat = 0, lon = 0;
  while (i < tekst.length) {
    for (const deel of ['lat', 'lon']) {
      let shift = 0, result = 0, byte;
      do { byte = tekst.charCodeAt(i++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
      const delta = (result & 1) ? ~(result >> 1) : (result >> 1);
      if (deel === 'lat') lat += delta; else lon += delta;
    }
    punten.push({ lat: lat / 1e6, lon: lon / 1e6 });
  }
  return punten;
}

/**
 * Kort spoor van echte, verse en nauwkeurige GPS-punten.
 * `voegToe` geeft een reden terug wanneer een punt niet bruikbaar is.
 */
export class GpsSpoor {
  constructor() { this.punten = []; }
  wis() { this.punten = []; }

  /** fix: {lat, lon, nauwkeurigheid, tijd (ms), snelheid (m/s of null)}; nu: ms */
  voegToe(fix, nu) {
    const leeftijd = (nu - fix.tijd) / 1000;
    if (!(Number.isFinite(fix.lat) && Number.isFinite(fix.lon))) return 'ongeldig';
    if (!(fix.nauwkeurigheid >= 0 && fix.nauwkeurigheid <= GRENZEN.gpsMaxOnzekerheidM)) return 'onnauwkeurig';
    if (!(Math.abs(leeftijd) <= GRENZEN.gpsMaxLeeftijdS)) return 'te_oud';
    const vorige = this.punten.at(-1);
    if (vorige && fix.tijd <= vorige.tijd) return 'dubbel_of_ouder';
    let gewist = false;
    if (vorige && ((fix.tijd - vorige.tijd) / 1000 > GRENZEN.onderbrekingS || afstandM(vorige, fix) > GRENZEN.sprongM)) {
      this.wis(); gewist = true;
    }
    this.punten = this.punten.filter(p => (fix.tijd - p.tijd) / 1000 <= GRENZEN.spoorMaxS);
    this.punten.push(fix);
    if (this.punten.length > GRENZEN.spoorMaxPunten) this.punten.splice(0, this.punten.length - GRENZEN.spoorMaxPunten);
    return gewist ? 'gewist_en_toegevoegd' : null;
  }
}

function mediaanNauwkeurigheid(fixes) {
  const v = fixes.map(f => f.nauwkeurigheid).filter(x => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  return v.length ? Math.min(30, Math.max(4, v[Math.floor(v.length / 2)])) : 10;
}

function leesLimiet(waarde) {
  // Valhalla: 0 of ontbrekend = onbekend, 255 = onbegrensd. Nooit een standaardwaarde verzinnen.
  if (waarde === 'unlimited' || waarde === 255) return { soort: 'onbegrensd' };
  if (Number.isInteger(waarde) && waarde > 0 && waarde < 255) return { soort: 'getal', kmu: waarde };
  return { soort: 'ontbreekt' };
}

function koppel(engine, fixes) {
  const verzoek = {
    shape: fixes.map(f => ({ lat: f.lat, lon: f.lon })),
    costing: 'auto',
    shape_match: 'map_snap',
    trace_options: { gps_accuracy: mediaanNauwkeurigheid(fixes), search_radius: 50 },
  };
  return engine.traceRoute(verzoek);
}

/**
 * Bepaal de geregistreerde maximumsnelheid voor het laatste GPS-punt.
 * engine: object met traceRoute(req) en locate(req) zoals @adret-maps/valhalla-wasm.
 * Retourneert {limiet|null, reden, weg, wayId, afstandM, voorwaardelijk, herpoging}.
 */
export function bepaalLimiet(engine, fixes) {
  const leeg = (reden, extra = {}) => ({ limiet: null, reden, weg: null, wayId: null, afstandM: null, voorwaardelijk: null, herpoging: null, ...extra });
  if (!Array.isArray(fixes) || fixes.length < 2) return leeg('onvoldoende_punten');
  let route, herpoging = null;
  try { route = koppel(engine, fixes); }
  catch (fout) {
    if (fixes.length <= GRENZEN.herpogingPunten) return leeg('geen_koppeling', { fout: `${fout.code ?? ''} ${fout.message}` });
    herpoging = `${fout.code ?? ''} ${fout.message}`;
    try { route = koppel(engine, fixes.slice(-GRENZEN.herpogingPunten)); }
    catch (fout2) { return leeg('geen_koppeling', { fout: `${fout2.code ?? ''} ${fout2.message}`, herpoging }); }
  }
  const leg = route?.trip?.legs?.at(-1);
  const lijn = leg?.shape ? decodeerPolyline6(leg.shape) : [];
  if (lijn.length < 2) return leeg('geen_koppeling', { herpoging });
  const eind = lijn.at(-1);
  // Koers van het laatste stuk gekoppelde weg (eerste punt dat ver genoeg terug ligt).
  let vorige = null;
  for (let i = lijn.length - 2; i >= 0; i--) { if (afstandM(lijn[i], eind) >= 1) { vorige = lijn[i]; break; } }
  const laatsteGps = fixes.at(-1);
  const afstand = afstandM(laatsteGps, eind);
  if (!(afstand <= GRENZEN.wegMaxAfstandM)) return leeg('weg_te_ver_van_gps', { afstandM: afstand, herpoging });
  const koers = vorige ? koersGraden(vorige, eind) : null;
  const locatie = { lat: eind.lat, lon: eind.lon, radius: 3 };
  if (koers !== null) Object.assign(locatie, { heading: Math.round(koers), heading_tolerance: 45 });
  let gevonden;
  try { gevonden = engine.locate({ locations: [locatie], costing: 'auto', verbose: true }); }
  catch (fout) { return leeg('geen_wegvak', { fout: `${fout.code ?? ''} ${fout.message}`, afstandM: afstand, herpoging }); }
  const kandidaten = (gevonden?.[0]?.edges ?? [])
    .filter(e => e && e.edge_info && Number.isFinite(e.distance))
    .filter(e => koers === null || !Number.isFinite(e.heading) || hoekVerschil(e.heading, koers) <= 45)
    .sort((a, b) => a.distance - b.distance || (koers === null ? 0 : hoekVerschil(a.heading, koers) - hoekVerschil(b.heading, koers)));
  const wegvak = kandidaten[0];
  if (!wegvak) return leeg('geen_wegvak', { afstandM: afstand, herpoging });
  const info = wegvak.edge_info;
  const weg = Array.isArray(info.names) ? info.names.filter(n => typeof n === 'string').join(', ') : '';
  const voorwaardelijk = info.conditional_speed_limits ?? null;
  const l = leesLimiet(info.speed_limit);
  const basis = { weg, wayId: info.way_id ?? null, afstandM: afstand, voorwaardelijk, herpoging };
  if (l.soort === 'onbegrensd') return { limiet: null, reden: 'onbegrensd_in_kaart', ...basis };
  if (l.soort === 'ontbreekt') return { limiet: null, reden: 'limiet_ontbreekt_in_kaart', ...basis };
  return { limiet: l.kmu, reden: voorwaardelijk ? 'limiet_met_tijdsregel' : 'limiet_gevonden', ...basis };
}

/** Eerste bekende limiet direct; latere wijzigingen na twee gelijke resultaten (native LimitConfirmation). */
export class LimietBevestiging {
  constructor() { this.reset(); }
  reset() { this.kandidaat = null; this.aantal = 0; this.gemeld = null; }
  waarneem(limiet) {
    if (limiet == null) { this.kandidaat = null; this.aantal = 0; return null; }
    if (this.kandidaat === limiet) this.aantal = Math.min(this.aantal + 1, 2); else { this.kandidaat = limiet; this.aantal = 1; }
    if (this.gemeld === limiet || !(this.gemeld === null || this.aantal >= 2)) return null;
    this.gemeld = limiet;
    return limiet;
  }
}

/** Valhalla-tegelpad voor niveau en id, zoals "2/000/817/217.gph". */
export function tegelPad(niveau, id) {
  const s = String(id);
  const breedte = niveau === 2 ? 9 : 6;
  const p = s.padStart(breedte, '0');
  const delen = p.match(/.{3}/g);
  return `${niveau}/${delen.join('/')}.gph`;
}

const NIVEAUS = [{ niveau: 0, grootte: 4 }, { niveau: 1, grootte: 1 }, { niveau: 2, grootte: 0.25 }];
/** Tegels die een punt (met marge in graden) raken, op alle drie de niveaus. */
export function tegelsRond(lat, lon, margeGraden = 0.01) {
  const uit = new Set();
  for (const { niveau, grootte } of NIVEAUS) {
    const kolommen = Math.round(360 / grootte);
    for (const dLat of [-margeGraden, 0, margeGraden]) for (const dLon of [-margeGraden, 0, margeGraden]) {
      const rij = Math.floor((lat + dLat + 90) / grootte), kol = Math.floor((lon + dLon + 180) / grootte);
      uit.add(tegelPad(niveau, rij * kolommen + kol));
    }
  }
  return [...uit];
}

// ---------------------------------------------------------------------------
// Tijdsafhankelijke limieten (OSM maxspeed:conditional, via Valhalla /locate).
// In Nederland gevonden: {"19:00-06:00":130} of {"19:00-06:00":120} bij basis 100.
// Alleen de notatie "UU:MM-UU:MM" (eventueel meerdere, gescheiden door komma of
// puntkomma) wordt toegepast. Elke andere notatie geeft "onzeker": geen melding.

const KLOK = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/;

/** Minuten na middernacht in Nederlandse tijd. */
export function minutenInNederland(datum) {
  const delen = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(datum);
  const u = Number(delen.find(d => d.type === 'hour').value), m = Number(delen.find(d => d.type === 'minute').value);
  return u * 60 + m;
}

function binnenVenster(venster, minuten) {
  const m = KLOK.exec(venster.trim());
  if (!m) return null;
  const [, u1, m1, u2, m2] = m.map(Number);
  if (u1 > 24 || u2 > 24 || m1 > 59 || m2 > 59) return null;
  const van = u1 * 60 + m1, tot = u2 * 60 + m2;
  return van <= tot ? (minuten >= van && minuten < tot) : (minuten >= van || minuten < tot);
}

/**
 * Pas tijdsregels toe op een basislimiet.
 * Retourneert {limiet|null, tijdsregel: 'geen'|'toegepast'|'niet_actief'|'onzeker'}.
 */
export function pasTijdsregelToe(basis, voorwaardelijk, datum = new Date()) {
  if (!voorwaardelijk || typeof voorwaardelijk !== 'object' || !Object.keys(voorwaardelijk).length) return { limiet: basis, tijdsregel: 'geen' };
  const minuten = minutenInNederland(datum);
  let actief = null;
  for (const [sleutel, waarde] of Object.entries(voorwaardelijk)) {
    if (!(Number.isInteger(waarde) && waarde > 0 && waarde < 255)) return { limiet: null, tijdsregel: 'onzeker' };
    for (const venster of sleutel.split(/[;,]/)) {
      const binnen = binnenVenster(venster, minuten);
      if (binnen === null) return { limiet: null, tijdsregel: 'onzeker' };
      if (binnen) {
        if (actief !== null && actief !== waarde) return { limiet: null, tijdsregel: 'onzeker' };
        actief = waarde;
      }
    }
  }
  if (actief !== null) return { limiet: actief, tijdsregel: 'toegepast' };
  return { limiet: basis, tijdsregel: 'niet_actief' };
}

// ---------------------------------------------------------------------------
// Spraakwachtrij: activering eerst, daarna hooguit één (de nieuwste) limietmelding.
// Een melding die bij het uitspreken niet meer actueel is, wordt overgeslagen.

export class SpraakWachtrij {
  /**
   * spreek(tekst, ronde) -> Promise<'afgerond'|'afgebroken'|'fout'>
   * isActueel(item) -> boolean   (item: {soort, tekst, limiet})
   * log(gebeurtenis, velden)
   */
  constructor({ spreek, isActueel, log = () => {} }) {
    this.spreek = spreek; this.isActueel = isActueel; this.log = log;
    this.ronde = 0; this.activatie = false; this.limiet = null; this.bezig = false;
  }
  start() {
    this.ronde++; this.activatie = true; this.limiet = null; this.bezig = false;
    this.#verwerk();
  }
  meld(limiet) {
    const nieuw = { soort: 'limiet', limiet, tekst: `De maximumsnelheid is ${limiet} kilometer per uur.` };
    if (this.limiet) this.log('spraak_vervangen', { oud: this.limiet.limiet, nieuw: limiet });
    this.limiet = nieuw;
    if (!this.bezig) this.#verwerk();
  }
  stop() { this.ronde++; this.activatie = false; this.limiet = null; this.bezig = false; }
  async #verwerk() {
    if (this.bezig) return;
    const ronde = this.ronde;
    this.bezig = true;
    try {
      while (ronde === this.ronde) {
        let item;
        if (this.activatie) { item = { soort: 'activatie', limiet: null, tekst: 'Snelheidsassistent is actief.' }; this.activatie = false; }
        else if (this.limiet) { item = this.limiet; this.limiet = null; }
        else break;
        if (item.soort === 'limiet' && !this.isActueel(item)) { this.log('spraak_overgeslagen', { limiet: item.limiet, reden: 'niet_meer_actueel' }); continue; }
        const uitkomst = await this.spreek(item.tekst, ronde);
        if (ronde !== this.ronde) return;
        this.log('spraak_uitkomst', { soort: item.soort, limiet: item.limiet, uitkomst });
      }
    } finally {
      if (ronde === this.ronde) this.bezig = false;
    }
  }
}
