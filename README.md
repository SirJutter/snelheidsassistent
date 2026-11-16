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
