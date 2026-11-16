// Snelheidsassistent webapp — rit, GPS, scherm wakker houden, spraak en lokaal proeflog.
// De bepaling van de maximumsnelheid gebeurt in worker.mjs (Valhalla WebAssembly, offline kaart).
import { GpsSpoor, LimietBevestiging, SpraakWachtrij, pasTijdsregelToe, afstandM, GRENZEN } from './kern/limiet-kern.mjs';

import { BestandsSpeler, bestandVoorTekst } from './kern/audio-bestanden.mjs?v=0.2';
import { ProeflogOpslag } from './kern/proeflog-opslag.mjs?v=0.2';

const VERSIE = 'web 0.2.1 · 16-11-2026';
const $ = id => document.getElementById(id);

// ---------- lokaal proeflog (zonder coördinaten of wegnamen) ----------
const proeflog = new ProeflogOpslag({ status: blijvend => {
  const vak = $('log-opslag');
  if (vak) vak.textContent = blijvend
    ? 'Het proeflog blijft maximaal 7 dagen bewaard, ook na heropenen. Maximaal 30.000 gebeurtenissen; geen coördinaten of wegnamen.'
    : 'Blijvend opslaan is niet beschikbaar. Deel het proeflog vóór je deze pagina sluit.';
} });
function log(gebeurtenis, velden = {}) { proeflog.record(gebeurtenis, velden); }

// ---------- instellingen (per toestel, alleen gemak) ----------
const STANDAARD = { spraak: true, voorbereiding: 1, audiotype: 'playback', spraaktechniek: 'audio' };
let instellingen = { ...STANDAARD };
try {
  const bewaard = JSON.parse(localStorage.getItem('instellingen') ?? '{}');
  instellingen = { ...STANDAARD, ...bewaard };
  if (!('spraaktechniek' in bewaard)) instellingen.audiotype = 'playback';
} catch { /* privémodus */ }
const bewaarInstellingen = () => { try { localStorage.setItem('instellingen', JSON.stringify(instellingen)); } catch { /* geen opslag */ } };

// ---------- toestand ----------
let aan = false, generatie = 0, watchId = null, bezig = false, laatsteAanvraag = 0, aanvraagTeller = 0;
let laatsteFix = null, resultaatTijd = null, huidige = null, weg = '', status = 'Kaart laden…';
let kaartGereed = false, schermStatus = '', gpsMelding = '', audioMelding = '', onderbroken = false;
const spoor = new GpsSpoor();
const bevestiging = new LimietBevestiging();
const wachtenden = new Map();

// ---------- worker ----------
const worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
worker.onmessage = ({ data }) => {
  if (data.type === 'gereed') {
    kaartGereed = true; status = 'Klaar voor vertrek';
    log('kaart_gereed', { ms: data.ms }); toonOpslag(data.opslag); render();
  } else if (data.type === 'resultaat' || (data.type === 'fout' && data.id != null)) {
    const klaar = wachtenden.get(data.id); wachtenden.delete(data.id); klaar?.(data);
  } else if (data.type === 'download_voortgang') {
    $('kaart-status').textContent = `Kaart downloaden: ${data.klaar} van ${data.totaal} delen…`;
  } else if (data.type === 'download_klaar' || data.type === 'opslag') {
    toonOpslag(data.opslag); $('download').disabled = false;
    if (data.type === 'download_klaar') log('kaart_download_klaar', { tegels: data.opslag.tegelsInCache });
  } else if (data.type === 'fout') {
    log('worker_fout', { soort: data.soort, bericht: data.bericht });
    if (data.soort === 'start') { status = 'Kaart kan niet worden geladen. Controleer de internetverbinding en open de app opnieuw.'; render(); }
    if (data.soort === 'download') { $('kaart-status').textContent = 'Download onderbroken: ' + data.bericht; $('download').disabled = false; }
  }
};
worker.postMessage({ type: 'start' });

function toonOpslag(o) {
  if (!o) return;
  const quotum = o.quotumMB ? ` · beschikbaar voor deze app ca. ${Math.round(o.quotumMB)} MB` : '';
  $('kaart-status').textContent = o.tegelsInCache >= o.tegelsTotaal
    ? `Heel Nederland staat op deze iPhone (${Math.round(o.cacheMB)} MB)${quotum}.`
    : `${o.tegelsInCache} van ${o.tegelsTotaal} kaartdelen op deze iPhone (${Math.round(o.cacheMB)} van ${Math.round(o.totaalMB)} MB). Ontbrekende delen worden tijdens de rit via internet opgehaald${quotum}.`;
}

// ---------- audio en spraak ----------
let audioContext = null, stilte = null, laatsteSpraakEinde = 0;
const bestandsSpeler = new BestandsSpeler({ log });
function kiesStem() {
  const stemmen = speechSynthesis.getVoices().filter(v => v.lang?.toLowerCase().replace('_', '-') === 'nl-nl');
  return stemmen.find(v => v.localService) ?? stemmen[0] ?? null;
}
function zetAudiotype() {
  if (!('audioSession' in navigator)) return;
  try { navigator.audioSession.type = instellingen.audiotype; log('audiotype', { type: navigator.audioSession.type }); }
  catch (e) { log('audiotype_fout', { bericht: e.message }); }
}
/** Moet direct vanuit een tik worden aangeroepen: iOS staat geluid pas toe na een gebruikershandeling. */
function ontgrendelAudio() {
  zetAudiotype();
  if (instellingen.spraaktechniek === 'audio') { bestandsSpeler.ontgrendel(); return; }
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC && !audioContext) audioContext = new AC();
    audioContext?.resume();
  } catch (e) { log('audio_fout', { bericht: e.message }); }
  const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u);
}
function stopStilte() { if (stilte) { try { stilte.stop(); } catch { /* al gestopt */ } stilte = null; } }
async function bereidAudioVoor(seconden) {
  if (!audioContext) return;
  try {
    await audioContext.resume();
    stilte = audioContext.createBufferSource();
    stilte.buffer = audioContext.createBuffer(1, audioContext.sampleRate, audioContext.sampleRate);
    stilte.loop = true; stilte.connect(audioContext.destination); stilte.start();
    log('audio_voorbereiding', { seconden, toestand: audioContext.state });
    await new Promise(r => setTimeout(r, seconden * 1000));
  } catch (e) { log('audio_voorbereiding_fout', { bericht: e.message }); }
}
function spreek(tekst, ronde) {
  return (async () => {
    if (!aan && ronde !== 'test') return 'afgebroken';
    if (document.hidden) return 'afgebroken';
    if (instellingen.spraaktechniek === 'audio') {
      const bestand = bestandVoorTekst(tekst);
      if (!bestand) { log('media_bestand_ontbreekt', { tekst }); return 'fout'; }
      const waarde = /^Maximumsnelheid is (\d+) kilometer per uur$/.exec(tekst);
      const uitkomst = await bestandsSpeler.spreek(bestand, {
        tekst, voorbereiding: instellingen.voorbereiding,
        isActueel: () => !document.hidden && (ronde === 'test' || (aan && ronde === wachtrij.ronde &&
          (!waarde || (huidige === Number(waarde[1]) && laatsteFix && Date.now() - laatsteFix.tijd <= GRENZEN.versheidS * 1000)))),
      });
      if (uitkomst === 'fout') audioMelding = 'Een geluidsmelding kon niet worden afgespeeld. Controleer dit stilstaand met de stemtest.';
      else if (uitkomst === 'afgerond') audioMelding = '';
      render();
      return uitkomst;
    }
    if (instellingen.voorbereiding > 0 && Date.now() - laatsteSpraakEinde > 5000) await bereidAudioVoor(instellingen.voorbereiding);
    if (ronde !== 'test' && ronde !== wachtrij.ronde) { stopStilte(); return 'afgebroken'; }
    return await new Promise(resolve => {
      const u = new SpeechSynthesisUtterance(tekst);
      u.lang = 'nl-NL'; u.voice = kiesStem(); u.rate = 1; u.volume = 1;
      let klaar = false;
      const einde = uitkomst => { if (klaar) return; klaar = true; clearTimeout(wacht); laatsteSpraakEinde = Date.now(); stopStilte(); resolve(uitkomst); };
      const wacht = setTimeout(() => { log('spraak_geen_afronding', { tekst }); speechSynthesis.cancel(); einde('fout'); }, 15000);
      u.onstart = () => { log('spraak_gestart', { tekst, stem: u.voice?.name ?? 'standaard' }); stopStilte(); };
      u.onend = () => { log('spraak_afgerond', { tekst }); einde('afgerond'); };
      u.onerror = e => { log('spraak_fout', { tekst, fout: e.error }); einde(['interrupted', 'canceled'].includes(e.error) ? 'afgebroken' : 'fout'); };
      log('spraak_aangevraagd', { tekst });
      speechSynthesis.speak(u);
    });
  })();
}
const wachtrij = new SpraakWachtrij({
  spreek,
  isActueel: item => aan && item.limiet === huidige && laatsteFix && Date.now() - laatsteFix.tijd <= GRENZEN.versheidS * 1000,
  log,
});

// ---------- scherm wakker houden ----------
let wake = null, wakeBezig = false;
async function houdSchermAan() {
  if (!aan || document.hidden || wake || wakeBezig) return;
  if (!('wakeLock' in navigator)) { schermStatus = 'niet_ondersteund'; log('scherm_niet_ondersteund'); render(); return; }
  wakeBezig = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (!aan || document.hidden) { await lock.release(); return; }
    wake = lock; schermStatus = 'actief'; log('scherm_wakker');
    lock.addEventListener('release', () => {
      if (wake === lock) wake = null;
      log('scherm_losgelaten');
      if (aan && !document.hidden) { schermStatus = 'opnieuw'; setTimeout(houdSchermAan, 500); }
      render();
    });
  } catch (e) { schermStatus = 'mislukt'; log('scherm_fout', { bericht: e.message }); }
  finally { wakeBezig = false; render(); }
}

// ---------- rit ----------
function startRit() {
  if (aan) return;
  if (!isSecureContext || !navigator.geolocation) { gpsMelding = 'Deze pagina moet via een beveiligd https-adres worden geopend.'; render(); return; }
  if (!kaartGereed) { status = 'De kaart wordt nog geladen. Probeer het zo opnieuw.'; render(); return; }
  ontgrendelAudio();
  aan = true; generatie++; onderbroken = false; gpsMelding = ''; audioMelding = '';
  spoor.wis(); bevestiging.reset(); huidige = null; weg = ''; resultaatTijd = null; laatsteFix = null; laatsteAanvraag = 0;
  status = 'Wachten op GPS-signaal';
  log('rit_start', { versie: VERSIE, techniek: instellingen.spraaktechniek, voorbereiding: instellingen.voorbereiding, audiotype: instellingen.audiotype, standalone: matchMedia('(display-mode: standalone)').matches });
  navigator.storage?.persist?.().then(r => log('opslag_blijvend', { toegekend: r })).catch(() => {});
  houdSchermAan();
  watchId = navigator.geolocation.watchPosition(opFix, opGpsFout, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  if (instellingen.spraak) wachtrij.start();
  render();
}
function stopRit(reden = 'handmatig') {
  if (!aan) return;
  aan = false; generatie++;
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  if (wake) { const w = wake; wake = null; w.release().catch(() => {}); }
  wachtrij.stop(); bestandsSpeler.stop(); speechSynthesis.cancel(); stopStilte(); audioContext?.suspend().catch(() => {});
  spoor.wis(); bevestiging.reset(); huidige = null; weg = ''; resultaatTijd = null; laatsteFix = null; bezig = false; wachtenden.clear();
  status = 'Snelheidsmeldingen uitgeschakeld'; schermStatus = '';
  log('rit_stop', { reden });
  render();
}
function verbergLimiet(melding) {
  huidige = null; weg = ''; resultaatTijd = null; bevestiging.waarneem(null); status = melding;
}
function wissen(melding) {
  generatie++; spoor.wis(); laatsteFix = null; laatsteAanvraag = 0; verbergLimiet(melding);
}

function opFix(p) {
  if (!aan) return;
  const fix = { lat: p.coords.latitude, lon: p.coords.longitude, nauwkeurigheid: p.coords.accuracy, tijd: p.timestamp, snelheid: p.coords.speed };
  const reden = spoor.voegToe(fix, Date.now());
  if (reden && reden !== 'gewist_en_toegevoegd') {
    log('gps_afgewezen', { reden, nauwkeurigheid_m: Math.round(fix.nauwkeurigheid) });
    if (huidige === null) status = reden === 'onnauwkeurig' ? `GPS nog niet nauwkeurig genoeg (±${Math.round(fix.nauwkeurigheid)} m)` : 'Wachten op een verse GPS-meting';
    render(); return;
  }
  if (reden === 'gewist_en_toegevoegd') { generatie++; verbergLimiet('GPS onderbroken · opnieuw een weg zoeken'); log('spoor_gewist'); }
  laatsteFix = fix; gpsMelding = '';
  vraagLimiet();
  render();
}
function opGpsFout(e) {
  log('gps_fout', { code: e.code, bericht: e.message });
  if (e.code === 1) { stopRit('locatie_geweigerd'); gpsMelding = 'Locatietoegang is geweigerd. Sta locatie toe voor deze website in de iPhone-instellingen (Privacy › Locatievoorzieningen › Safari-websites).'; }
  else gpsMelding = 'Wachten op GPS-signaal';
  render();
}

function vraagLimiet() {
  if (!aan || bezig || !kaartGereed || spoor.punten.length < 2 || Date.now() - laatsteAanvraag < GRENZEN.aanvraagIntervalMs) return;
  bezig = true; laatsteAanvraag = Date.now();
  const gen = generatie, punten = spoor.punten.slice(), eind = punten.at(-1), id = ++aanvraagTeller;
  wachtenden.set(id, antwoord => { bezig = false; verwerk(antwoord, gen, eind, id); });
  worker.postMessage({ type: 'koppel', id, fixes: punten });
}

function omschrijving(reden, tijdsregel) {
  if (tijdsregel === 'onzeker') return 'Limiet hangt af van tijd of omstandigheden · niet uitgesproken';
  if (tijdsregel === 'toegepast') return 'Tijdsafhankelijke limiet uit offline kaart';
  return ({
    limiet_gevonden: 'Snelheidslimiet uit offline kaart',
    limiet_met_tijdsregel: 'Snelheidslimiet uit offline kaart',
    limiet_ontbreekt_in_kaart: 'Weg gevonden · maximumsnelheid ontbreekt in kaart',
    onbegrensd_in_kaart: 'Kaart vermeldt geen numerieke snelheidslimiet',
    weg_te_ver_van_gps: 'GPS-punt ligt te ver van de gekoppelde weg',
    geen_wegvak: 'Geen bruikbaar wegvak gevonden',
  })[reden] ?? 'Geen betrouwbare wegkoppeling gevonden';
}

function verwerk(antwoord, gen, eind, id) {
  if (antwoord.type === 'fout') {
    log('kaart_fout', { id, bericht: antwoord.bericht });
    if (aan && gen === generatie) { verbergLimiet(/HTTP|fetch|network|Load failed/i.test(antwoord.bericht) ? 'Kaartdeel niet beschikbaar · geen internet en niet gedownload' : 'Kaartfout · maximumsnelheid onbekend'); render(); }
    return;
  }
  const r = antwoord.resultaat;
  let limiet = r.limiet, tijdsregel = 'geen';
  if (limiet != null && r.voorwaardelijk) ({ limiet, tijdsregel } = pasTijdsregelToe(limiet, r.voorwaardelijk, new Date()));
  log('kaart_resultaat', { id, reden: r.reden, limiet_kmu: limiet ?? 'onbekend', tijdsregel, afstand_m: r.afstandM == null ? null : Math.round(r.afstandM * 10) / 10, match_ms: antwoord.matchMs, tegel_ms: antwoord.tegelMs, nieuwe_tegels: antwoord.nieuweTegels, geheugen_mb: antwoord.geheugenMB });
  if (!aan || gen !== generatie) { log('resultaat_afgewezen', { id, reden: 'rit_of_spoor_gewijzigd' }); return; }
  if (Date.now() - eind.tijd > GRENZEN.gpsMaxLeeftijdS * 1000 || !laatsteFix || afstandM(laatsteFix, eind) > 40) {
    verbergLimiet('Wegkoppeling verouderd · opnieuw bepalen'); log('resultaat_afgewezen', { id, reden: 'verouderd_of_verplaatst' }); render(); return;
  }
  huidige = limiet; weg = r.weg ?? ''; resultaatTijd = limiet == null ? null : eind.tijd;
  status = omschrijving(r.reden, tijdsregel);
  const melden = bevestiging.waarneem(limiet);
  if (melden != null) { log('limiet_bevestigd', { limiet_kmu: melden }); if (instellingen.spraak) wachtrij.meld(melden); }
  render();
}

setInterval(() => {
  if (!aan) return;
  if (laatsteFix && Date.now() - laatsteFix.tijd > GRENZEN.versheidS * 1000) { log('gps_verouderd'); wissen('GPS-signaal verouderd · maximumsnelheid onbekend'); render(); }
  else if (resultaatTijd && Date.now() - resultaatTijd > GRENZEN.versheidS * 1000) { log('limiet_verouderd'); verbergLimiet('Wegkoppeling verouderd · maximumsnelheid onbekend'); render(); }
}, 1000);

document.addEventListener('visibilitychange', () => {
  log('zichtbaarheid', { verborgen: document.hidden, rit: aan });
  if (!aan) return;
  if (document.hidden) { onderbroken = true; bestandsSpeler.stop(); speechSynthesis.cancel(); }
  else { wissen('Pagina was niet zichtbaar · opnieuw een weg zoeken'); houdSchermAan(); render(); }
});

// ---------- weergave ----------
function render() {
  $('limiet').textContent = aan && huidige != null ? String(huidige) : '–';
  $('limiet').setAttribute('aria-label', aan && huidige != null ? `Maximumsnelheid ${huidige} kilometer per uur` : 'Maximumsnelheid onbekend');
  $('weg').textContent = aan ? weg : '';
  $('status').textContent = gpsMelding || status;
  $('knop').textContent = aan ? 'Uit' : 'Aan';
  $('knop').className = aan ? 'aan' : '';
  $('knop').disabled = !kaartGereed && !aan;
  const banners = [];
  if (aan && schermStatus === 'mislukt') banners.push('Het scherm kan automatisch uitgaan. Zet tijdens de rit Instellingen › Scherm en helderheid › Automatisch vergrendelen op Nooit.');
  if (aan && schermStatus === 'niet_ondersteund') banners.push('Deze browser kan het scherm niet wakker houden. Zet Automatisch vergrendelen tijdelijk op Nooit.');
  if (aan && onderbroken) banners.push('De pagina was even niet zichtbaar. Dan stoppen GPS en meldingen. Houd de app open en het scherm aan.');
  if (aan && !instellingen.spraak) banners.push('Spraak staat uit in Instellingen.');
  if (aan && audioMelding) banners.push(audioMelding);
  $('banners').replaceChildren(...banners.map(t => Object.assign(document.createElement('p'), { textContent: t })));
  $('hint').textContent = aan ? 'Houd deze app open met het scherm aan. Volg altijd de verkeersborden.' : 'Tik vóór vertrek op Aan. Je hoort de maximumsnelheid via de iPhone of de autoradio.';
}

// ---------- bediening ----------
$('knop').addEventListener('click', () => (aan ? stopRit('handmatig') : startRit()));
$('instellingen-open').addEventListener('click', () => { worker.postMessage({ type: 'opslag' }); $('instellingen').showModal(); });
$('instellingen-dicht').addEventListener('click', () => $('instellingen').close());
$('spraak').checked = instellingen.spraak;
$('spraak').addEventListener('change', e => { instellingen.spraak = e.target.checked; bewaarInstellingen(); log('instelling_spraak', { aan: instellingen.spraak }); if (!instellingen.spraak) { wachtrij.stop(); bestandsSpeler.stop(); speechSynthesis.cancel(); } else if (aan) { ontgrendelAudio(); /* volgende bevestigde wijziging wordt weer gemeld */ } render(); });
$('voorbereiding').value = String(instellingen.voorbereiding);
$('voorbereiding').addEventListener('change', e => { instellingen.voorbereiding = Number(e.target.value); bewaarInstellingen(); log('instelling_voorbereiding', { seconden: instellingen.voorbereiding }); });
$('spraaktechniek').value = instellingen.spraaktechniek;
$('spraaktechniek').addEventListener('change', e => {
  if (aan) { e.target.value = instellingen.spraaktechniek; $('stemtest-status').textContent = 'Zet eerst de meldingen uit.'; return; }
  bestandsSpeler.stop(); speechSynthesis.cancel(); stopStilte();
  instellingen.spraaktechniek = e.target.value; bewaarInstellingen();
  log('instelling_spraaktechniek', { techniek: instellingen.spraaktechniek });
});
$('audiotype').value = instellingen.audiotype;
$('audiotype').addEventListener('change', e => { instellingen.audiotype = e.target.value; bewaarInstellingen(); zetAudiotype(); });
$('stemtest').addEventListener('click', async () => {
  if (aan) { $('stemtest-status').textContent = 'Zet eerst de meldingen uit; test stilstaand.'; return; }
  ontgrendelAudio();
  $('stemtest').disabled = true; $('stemtest-status').textContent = 'Stemtest loopt…';
  log('stemtest', { techniek: instellingen.spraaktechniek, voorbereiding: instellingen.voorbereiding, audiotype: instellingen.audiotype });
  const a = await spreek('Snelheidsassistent geactiveerd.', 'test');
  const b = a === 'afgerond' ? await spreek('Dit is een stemtest. Maximumsnelheid is vijftig kilometer per uur.', 'test') : a;
  $('stemtest-status').textContent = b === 'afgerond' ? 'De browser meldt: afgerond. Geef hieronder aan wat je zelf hoorde.' : `Stemtest: ${b}`;
  $('stemtest').disabled = false;
  if (!aan) bestandsSpeler.stop();
});
$('gehoord').addEventListener('change', e => log('hoorbaarheid_door_gebruiker', { techniek: instellingen.spraaktechniek, antwoord: e.target.value, voorbereiding: instellingen.voorbereiding, audiotype: instellingen.audiotype }));
$('download').addEventListener('click', () => { $('download').disabled = true; navigator.storage?.persist?.().catch(() => {}); log('kaart_download_start'); worker.postMessage({ type: 'download' }); });
$('wis-kaart').addEventListener('click', () => { if (confirm('Opgeslagen kaart van deze iPhone verwijderen?')) worker.postMessage({ type: 'wis_kaart' }); });
$('deel-log').addEventListener('click', async () => {
  log('log_gedeeld');
  const tekst = (await proeflog.exporteer()).map(r => JSON.stringify(r)).join('\n') + '\n';
  const bestand = new File([tekst], `Snelheidsassistent-web-${new Date().toISOString().slice(0, 16).replace(':', '-')}.jsonl`, { type: 'text/plain' });
  try {
    if (navigator.canShare?.({ files: [bestand] })) await navigator.share({ files: [bestand], title: 'Snelheidsassistent proeflog' });
    else { const url = URL.createObjectURL(bestand); const a = Object.assign(document.createElement('a'), { href: url, download: bestand.name }); a.click(); setTimeout(() => URL.revokeObjectURL(url), 3000); }
  } catch (e) { if (e.name !== 'AbortError') alert('Delen mislukt: ' + e.message); }
});
$('versie').textContent = VERSIE;
speechSynthesis.addEventListener?.('voiceschanged', () => log('stemmen', { nl: speechSynthesis.getVoices().filter(v => /^nl/i.test(v.lang)).map(v => v.name).join(', ') }));
log('geopend', { versie: VERSIE, beveiligd: isSecureContext, standalone: matchMedia('(display-mode: standalone)').matches, wakeLock: 'wakeLock' in navigator, spraak: 'speechSynthesis' in window, audioSession: 'audioSession' in navigator });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(e => log('sw_fout', { bericht: e.message }));
render();
