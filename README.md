# Snelheidsassistent (webversie)

Privé-hulpmiddel dat tijdens het rijden de geregistreerde maximumsnelheid uitspreekt.
De bepaling gebeurt volledig in de browser van het toestel (Valhalla 3.9.0 als WebAssembly);
er worden geen locaties naar een server gestuurd. De pagina moet tijdens de rit open en zichtbaar blijven.

Volg altijd de verkeersborden. Tijdelijke borden en matrixborden ontbreken in de kaartgegevens.

- Kaartgegevens © OpenStreetMap-bijdragers, ODbL 1.0 (https://www.openstreetmap.org/copyright),
  via Librescoot valhalla-tiles tiles-20261001T110408Z (Nederland).
- Wegkoppeling: Valhalla (MIT) via @adret-maps/valhalla-wasm (MIT); zie vendor/valhalla-wasm/LICENSE en THIRD_PARTY_NOTICES.md.


## Web 0.2 — audioherstel (15 november 2026)

De bestaande kaartmotor en Nederlandse kaart zijn ongewijzigd. De nieuwe standaard
is **Geluidsbestanden (Opel-proef)** met audiotype **Afspelen**. Eén blijvend
media-element wordt bij de tik vrijgegeven; een korte stilte opent de audioverbinding.
Daarna speelt hetzelfde element de Nederlandse meldingen af. De eenvoudige proefstem
is met eSpeak NG gegenereerd; er wordt geen tekst naar een spraakdienst gestuurd.
De eerdere browserspraak blijft selecteerbaar als vergelijking.

De geluidsbestanden worden met de app opgeslagen. Safari-bytebereiken worden ook
vanuit de offline cache ondersteund. Dit bevestigt nog geen hoorbaarheid in de Opel.

Het proeflog wordt in IndexedDB bewaard: maximaal zeven dagen en 30.000 gebeurtenissen,
zonder coördinaten of wegnamen. Als opslag niet beschikbaar is, meldt de pagina dat.

Stilstaande controle: herlaad, controleer bij het tandwiel **web 0.2**, kies
**Geluidsbestanden (Opel-proef)**, **Afspelen**, **1 sec**, en doe de stemtest met
de Opel op Bluetooth-audio/media. Geef aan wat je zelf hoorde en deel het proeflog.
Er is geen nieuwe kaartdownload nodig. De native iPhone-app is niet gewijzigd.


## Web 0.4 — doorlopende mediastroom (16 november 2026)

Web 0.2/0.3 startte per melding een korte mediastroom. Die bleef via de Opel stil,
terwijl doorlopende muziek wel klinkt. Daarom loopt tijdens de rit nu één onhoorbare
mediastroom naar de auto (in het iPhone-mediacentrum zichtbaar als "Snelheidsassistent").
De Nederlandse opnamen worden via Web Audio over die stroom gemengd, zonder bronwissel
of pauze. De eerste zin volgt circa drie seconden na Aan of Test geluid; daarna direct.
Muziek vanaf dezelfde iPhone pauzeert tijdens de rit. Bij Uit stopt de stroom.
Kaart, wegkoppeling en limietbepaling zijn ongewijzigd.


## Web 0.5 — telefoonverbinding van de auto en nieuwe startmeldingen (16 november 2026)

Web 0.4 was hoorbaar, maar alleen als de Opel handmatig op Bluetooth-media stond. Web 0.5
probeert per melding de telefoonverbinding van de auto (handsfree), zoals de oude iPhone-app:
radio kort onderbroken, daarna weer terug. De stilstaande geluidstest (Opel op de gewone radio)
speelt "Proef één" (zonder microfoon) en "Proef twee" (met kort de microfoon aan). Het antwoord
bepaalt de route; zonder test of bij "niets" blijft de route van web 0.4 actief.
De microfoon wordt nooit opgenomen of verstuurd en alleen rond een melding geopend.

Nieuwe meldingen: "Snelheidsassistent is actief." bij Aan, daarna na de eerste verse
wegkoppeling "De maximumsnelheid is … kilometer per uur.", en bij elke bevestigde wijziging.

Beperking: Safari stopt de locatiebepaling zodra de pagina niet zichtbaar is (scherm vergrendeld
of andere app). De app werkt daarom alleen met het scherm aan.


### Persoonlijke Xander-stem (web 0.5.1)

De werkende geluidsroute van 0.5 blijft behouden. Een persoonlijk stempakket vervangt alleen de
opnamen. Zonder import blijft de bestaande proefstem actief. De app meldt de echte installatiestatus.

Xander (verbeterd) wordt niet als openbare opname verspreid. Maak het pakket op je eigen Mac
met de verbeterde stem geïnstalleerd, zet het bestand op je eigen iPhone en kies in de webapp
Instellingen → Zet Xander op deze iPhone. De rit moet Uit staan. Het pakket wordt lokaal gecontroleerd
en in één transactie in IndexedDB opgeslagen. Het wordt niet naar de website of GitHub gestuurd.
Bewaar een privékopie; bij het wissen van websitegegevens kan ook deze stem verdwijnen.

De generator staat alleen in de lokale projectmap `web/tools/maak-xander-pakket.py` en gebruikt
`maak-xander-stem.swift`. Beide weigeren compacte Xander als vervanging voor de verbeterde stem.
Dit is geen overstap naar een native iPhone-app. Kaart, GPS en geluidsroute zijn ongewijzigd.


### Kortere radio-onderbreking (web 0.5.2, 17 november 2026)

Alleen de timing van de telefoonverbinding is aangepast; route, stem, kaart en limieten niet.
Ritlog 17-11: de stilte vóór de stem was vooral iOS die het geluid opstart (ca. 1,3 s); onze eigen
wachttijd voegde daar 0,1-0,2 s aan toe, of de volle 1,5 s als het geluid al liep.
- Voorbereiding vanaf openen 1,5 s → 1,0 s, met minimaal 0,1 s nadat het geluid weer loopt.
- Naloop na de laatste zin 1,5 s → 0,5 s. Een direct volgende zin deelt nog steeds de verbinding.
- Een melding vlak na het sluiten wacht nu eerst tot het sluiten echt klaar is.
Terugval: `GESPREK_TERUGVAL_0_5_1` in `kern/audio-bestanden.mjs` (1,5 s / 1,5 s).
