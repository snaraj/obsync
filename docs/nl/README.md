> Deze vertaling volgt het [Engelse origineel](../../README.md). De Engelse tekst is leidend; opdrachten, opties, URL's en plaatshouders blijven ongewijzigd.

# Self Hosted Private Sync

Zelf gehoste, end-to-end versleutelde live synchronisatie voor
[Obsidian](https://obsidian.md): één afhankelijkheidsvrije Rust-server met een
ingebouwd dashboard die je zelf draait, plus deze plugin. Bestanden van elke
grootte, elk Obsidian-platform, geen abonnement, geen derde partij.

Installeer hem via Instellingen → Externe plug-in → Doorbladeren als
**Self Hosted Private Sync** (plugin-id `obsync-private-sync`), op Obsidian
1.13.0 of nieuwer.

> [!IMPORTANT]
> Deze plugin synchroniseert met een server die **jij** draait. Er is geen
> gehoste dienst en geen account bij wie dan ook behalve bij jezelf: zonder je
> eigen `obsyncd`, bereikbaar via HTTPS, heeft de plugin niets om mee te
> synchroniseren.

> [!IMPORTANT]
> Maak een back-up van je kluis vóór de eerste synchronisatie, en bewaar de
> herstelzin van 24 woorden ergens anders dan op het apparaat dat hem heeft
> gegenereerd. De server bewaart alleen cijfertekst en kan een kluis niet voor
> je herstellen.

> [!IMPORTANT]
> Draai deze plugin niet naast een andere synchronisatieoplossing op dezelfde
> kluis — Obsidian Sync, een cloudmap die bestanden synchroniseert, of een
> andere sync-plugin. Twee schrijvers op één kluis veroorzaken conflicten die
> geen van beide kan oplossen.

## Voordat je erop vertrouwt

Dit is jonge software die de enige kopie van je notities synchroniseert.

- **[`CHANGELOG.md`](../../CHANGELOG.md) is de bijgehouden lijst van wat
  bekend is.** Lees het item voor de versie waarop je zit, en de items
  daarboven. Releasepagina's behouden de notities waarmee ze zijn
  gepubliceerd; latere bevindingen komen hier bij.
- **Werk elk apparaat bij dat een kluis synchroniseert.** Eén apparaat dat op
  een oudere versie blijft staan, kan nog naar het oude gedrag handelen en de
  andere beïnvloeden.
- **Wat op hardware daadwerkelijk is beproefd**, staat per run vastgelegd in
  [`docs/validation-runs/`](../validation-runs/), inclusief wat elke run niet
  heeft gedekt. Een platform dat geen enkele run noemt, is niet aangetoond.
- **Een stroom meldingen "merged concurrent edits"** op twee apparaten die één
  notitie bewerken: sluit Obsidian af op een van beide zodat het andere zijn
  werk kan afmaken, werk beide bij en ga dan verder.

## Waar deze plugin toegang toe heeft

Kort en volledig, zodat je kunt beslissen voordat je installeert.

- **Eén netwerkbestemming: je eigen server.** Elk verzoek gaat naar de
  **Server URL** die je in de instellingen van de plugin invult, en naar niets
  anders. Er is geen telemetrie, geen analyse, geen crashmelder, geen reclame
  en nergens op het synchronisatiepad een dienst van derden. De plugin
  downloadt ook nooit code van die server en voert die nooit uit.
- **Een account op die server, dat je zelf aanmaakt.** Het eerste apparaat
  gebruikt het setup-token dat je server bij de eerste start heeft
  weggeschreven; elk volgend apparaat wordt gekoppeld vanaf een apparaat dat
  al synchroniseert. Je Obsidian-account speelt geen rol.
- **Obsidian en GitHub, alleen voor installatie en updates.** Obsidian zelf
  downloadt `main.js`, `manifest.json` en `styles.css` uit de GitHub-releases
  van dit repository. Elke release draagt daarnaast een plugin-ZIP en een
  release-manifest voor mensen die de server uitrollen; Obsidian negeert
  beide.
- **Je edge, alleen als je er een hebt ingesteld.** Headers die je onder
  **Edge service-token headers** plakt, reizen mee met elk verzoek naar de
  bovengenoemde server-URL, omdat de proxy die ze nodig heeft op het pad naar
  je server ligt.
- **De bestandslijst van je kluis.** De plugin somt elk bestand in de kluis op
  om te bepalen wat binnen het bereik valt, leest de bestanden binnen je
  mapselectie en schrijft wat andere apparaten hebben gewijzigd. Verborgen
  mappen (`.obsidian`, `.git`) en mappen die symbolische koppelingen zijn,
  worden overgeslagen.
- **Het klembord, alleen beschreven en nooit gelezen.** Alleen de knoppen
  **Copy code** en **Copy link** in **Pair a new device** schrijven erin.
  Niets in de plugin leest het klembord.
- **Je browser, wanneer je om het dashboard vraagt.** **Open dashboard** opent
  een aanmeldlink in je browser, en alleen wanneer die link op de eigen
  oorsprong van je server ligt.
- **Obsidians beveiligde opslag.** De kluissleutel, het apparaatgeheim en
  eventuele waarden van edge-headers staan daar, nooit in gewone
  plugin-gegevens.

Wat de server wel en niet kan zien, staat in
[`SECURITY.md`](../../SECURITY.md) en
[`docs/threat-model.md`](../threat-model.md).

## In vijf stappen synchroon

Het pad waarop deze release is gevalideerd, van een lege kluis tot twee
apparaten die synchroon lopen. Alle vijf gaan ervan uit dat je eigen server al
draait, wat het hoofdstuk hieronder is; elke stap staat volledig uitgeschreven
in de snelstart.

1. **Installeren via Externe plug-in.** Zoek onder Instellingen → Externe
   plug-in → Doorbladeren naar **Self Hosted Private Sync**, kies Installeren
   en daarna Activeer — zoals elke andere Obsidian-plug-in binnenkomt, op elk
   platform.

   ![Obsidians browser voor externe plug-ins toont Self Hosted Private Sync met de knop Installeren](../captures/01-install-from-directory.png)

2. **Wijs hem naar je server en richt hem in.** Open het instellingentabblad
   van de plugin, zet **Server URL** op je eigen server, kies welke mappen dit
   apparaat synchroniseert en plak dan je setup-token onder
   **First-time setup**.

   ![Het instellingentabblad van de plugin, gescrold naar de mapselectie, naar Pairing en naar het tokenveld onder First-time setup](../captures/02-first-time-setup.png)

3. **Bewaar de herstelzin.** De inrichting genereert de kluissleutel op dit
   apparaat en toont eenmalig een zin van 24 woorden: schrijf hem op en bewaar
   hem ergens anders dan op dit apparaat, want de server houdt alleen
   cijfertekst en kan een kluis niet voor je herstellen.

   ![Het dialoogvenster met de herstelzin na de eerste inrichting, de woorden onleesbaar gemaakt](../captures/03-recovery-phrase.png)

4. **Koppel een tweede apparaat met een eenmalige code.** Voer op het eerste
   apparaat **Pair a new device** uit, typ de getoonde code binnen tien
   minuten op het tweede in en keur het apparaat op naam goed — de
   kluissleutel reist versleuteld onder een koppelgeheim dat de server nooit
   ziet.

   ![Het dialoogvenster Pair a new device op het eerste apparaat, de eenmalige code onleesbaar gemaakt](../captures/04-pair-a-new-device.png)

5. **Bewerk op een van beide apparaten en zie het aankomen.** Typ op het ene
   apparaat in een notitie en ze verschijnt binnen enkele seconden op het
   andere, in beide richtingen, terwijl de statusbalk laat zien wat de
   synchronisatie doet.

   ![De wegwerpnotitie met de bewerkingen van beide apparaten, met de synchronisatiestatusbalk zichtbaar](../captures/05-sync-both-ways.png)

De apparatenlijst van het dashboard en de intrekknop daarvan staan beschreven
onder [Je apparaten zien](../daily-use.md#see-your-devices) en zijn niet
beproefd in de apparatenrun voor 1.0.0 die is vastgelegd in
[docs/validation-runs/2026-09-14.md](../validation-runs/2026-09-14.md).

## Aan de slag

Het kortste correcte pad: één machine die van jou is draait de server, elk
apparaat bereikt hem via HTTPS, en elk apparaat wordt eenmaal gekoppeld.
Aanmelden bij Obsidian autoriseert hier niets; het enige account is dat op je
server.

### 1. De server starten

Twee manieren om hem te starten. Beide draaien precies de bytes die de
publisher heeft ondertekend: controleer de handtekening, lees de digest uit de
gecontroleerde uitvoer en draai precies die digest. `v1.0.6` is de release
waarvoor deze pagina is geschreven; neem de tag van de release die je
installeert.

```sh
cosign verify ghcr.io/snaraj/obsync:v1.0.6 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**Nog geen HTTPS?** `deploy/compose` start de server achter zijn eigen
TLS-terminator (Caddy), op elk netwerk, zonder domein en zonder account bij
wie dan ook. Vanuit een checkout van dit repository:

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` is de naam die je apparaten zullen intypen. Hij hoeft alleen op
je eigen netwerk op te lossen. `OBSYNC_BIND_ADDRESS` is het adres van deze
host waarop de poorten 80 en 443 worden gepubliceerd: een bind-adres beperkt
de doelinterface, niet de bron, dus je firewall bepaalt wie hem bereikt.
Compose weigert te starten totdat je hebt gekozen. Beide worden uitgelegd in
[De server draaien](../server.md).

**Al HTTPS ervoor** staan, van een reverse proxy of een tunnel die je
vertrouwt? Draai dan de kale server. Hij spreekt gewoon HTTP op poort 8080, en
jouw terminator stuurt ernaartoe door:

```sh
docker volume create obsync-blobs
docker volume create obsync-journal
docker run -d --name obsync -p 127.0.0.1:8080:8080 \
  -v obsync-blobs:/data/blobs -v obsync-journal:/data/journal \
  -e OBSYNC_BLOBS_CAPACITY=250GiB -e OBSYNC_JOURNAL_CAPACITY=4GiB \
  -e OBSYNC_PUBLIC_URL=https://sync.example.org \
  ghcr.io/snaraj/obsync@sha256:<the digest cosign just verified>
```

### 2. Het setup-token lezen

Bij de eerste start maakt de server een setup-token aan en schrijft het naar
zijn journal-volume, modus 0600, nooit gelogd. Het token maakt je account één
keer aan en blijft daarna voor de hele levensduur van de server de
herstelaanmelding van het dashboard: behandel het met dezelfde zorg als de
herstelzin. Lees het uit de container zelf, zonder hulp-image. Op het
Compose-pad:

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

Op het pad met de kale server:

```sh
docker cp obsync:/data/journal/v1/setup-token - | tar -xO
```

### 3. Het certificaat vertrouwen, eenmaal per apparaat (Compose-pad)

Caddy heeft het certificaat uitgegeven vanuit een certificaatautoriteit die
het bij de eerste start zelf heeft gegenereerd, dus elk apparaat moet één keer
te horen krijgen dat het die autoriteit vertrouwt. Exporteer het
hoofdcertificaat:

```sh
docker cp obsync-caddy-1:/data/caddy/pki/authorities/local/root.crt - | tar -xO > obsync-root.crt
```

Installeer `obsync-root.crt` op elk apparaat. De stappen voor macOS, Windows,
Linux, iOS en Android staan in
[De certificaatautoriteit vertrouwen, eenmaal per apparaat](../server.md#trust-the-certificate-authority-once-per-device).
Op iOS is het vertrouwen van het certificaat een tweede schakelaar ná de
installatie.

### 4. Het eerste apparaat inrichten

1. Instellingen → Externe plug-in → Doorbladeren → **Self Hosted Private
   Sync** → Installeren → Activeer.
2. Zet in de instellingen van de plugin **Server URL** op je server, met poort
   wanneer die niet 443 is: `https://sync.example.org`.

   ![Het instellingentabblad van de plugin: het veld Server URL met een demo-hostnaam, het vak voor de edge-headers en de rij Connection met de knoppen Check en Open dashboard](../assets/settings-server.png)

3. Kies nu **Whole vault** of **Selected folders only**. Zodra een apparaat
   heeft gesynchroniseerd, kan zijn selectie alleen nog smaller worden.
4. Plak het setup-token onder **First-time setup** en kies **Set up**. Schrijf
   de herstelzin van 24 woorden op en bewaar hem niet op dit apparaat.

   ![Het gedeelte This device van het instellingentabblad: de rij Pairing met Pair this device en Pair a new device, de rij First-time setup met het veld Setup token en de knop Set up, en de rij Vault key](../assets/settings-setup.png)

### 5. Het tweede apparaat koppelen

1. Installeer en activeer de plugin daar, zet dezelfde **Server URL** en kies
   zijn mappen.
2. Voer op het eerste apparaat **Pair a new device** uit. Het toont een code
   die tien minuten geldig is.

   ![Het dialoogvenster Pair a new device op het eerste apparaat, de code onleesbaar gemaakt, met de knoppen Copy code en Copy link en de regel Waiting for the new device](../assets/pair-new-device.png)

3. Open op het tweede apparaat **Pair this device**, plak de code en kies
   **Pair**.

   ![Het dialoogvenster Pair this device op het tweede apparaat, met het lege veld Pairing code en de knop Pair](../assets/pair-this-device.png)

4. Terug op het eerste apparaat keur je het nieuwe apparaat op naam goed.
   Bewerk op een van beide een notitie; ze verschijnt binnen enkele seconden
   op het andere.

   ![Het eerste apparaat vraagt of het nieuwe apparaat op naam moet worden goedgekeurd, met de knoppen Approve en Reject](../assets/pair-approve.png)

   ![Het tweede apparaat toont de notitie die op het eerste apparaat is geschreven, met de statusbalk die obsync idle weergeeft](../assets/first-sync.png)

De hele koppelingsuitwisseling, in één korte lus:

![Animatie: de koppelcode wordt op het eerste apparaat getoond, op het tweede geplakt, op het eerste goedgekeurd, en de eerste notitie komt aan op het tweede](../assets/pairing.gif)

Schermafbeeldingen van een telefoon staan nog niet in dit repository; ze
worden op de eigen apparaten van de beheerder gemaakt en toegevoegd zodra een
validatierun ze vastlegt.

Elke stap volledig, met wat elk scherm vraagt en waarom:
[Snelstart](../quickstart.md).

**Het op één computer uitproberen?** Op een computer accepteert de plugin ook
een gewoon `http://`-adres, zodat `http://127.0.0.1:8080` de kale server
hierboven bereikt zonder terminator. Telefoons niet: Obsidian op iOS en
Android weigert gewoon HTTP.

## Gevorderd: Cloudflare

De referentie-installatie heeft **geen publieke hostnaam**. Een Cloudflare
Tunnel verbindt het privénetwerk van de server met Cloudflare, een privéroute
vertelt Cloudflare welke adressen achter die tunnel zitten, en de Cloudflare
One-client op elk apparaat draagt de server-URL daarheen. Niets is bereikbaar
vanaf het internet, en grote eerste synchronisaties worden niet via een
publieke hostnaam geleid. De andere variant, een publieke hostnaam achter
Cloudflare Access met een servicetoken in **Edge service-token headers** en
`OBSYNC_EDGE=cloudflare` op de server, wordt ook ondersteund. Beide, stap voor
stap: [Cloudflare](cloudflare.md).

## Andere manieren om je server te bereiken

Eén regel per manier, geen handleiding. Wat je ook kiest, de plugin heeft
HTTPS nodig met een certificaat dat elk apparaat vertrouwt, en de server zelf
blijft achter die terminator op gewoon HTTP.

- **Alleen LAN.** Het Compose-pad hierboven, alleen thuis bereikbaar. Het
  eenvoudigst; geen synchronisatie buitenshuis.
- **WireGuard.** Je eigen VPN terug naar je netwerk. Het snelst en helemaal
  van jou; je draagt op elk apparaat een peer-configuratie en houdt één
  eindpunt bereikbaar.
- **Tailscale.** Een beheerde WireGuard-mesh met eigen namen. De minste
  inrichting op de apparaten; een derde partij coördineert de mesh, en de
  limieten van het abonnement moet je zelf nalezen.
- **Een reverse proxy met automatische TLS**, zoals Caddy op een publieke
  naam. Een publiek vertrouwd certificaat en een permanent adres; de server is
  dan bereikbaar vanaf het internet, en de proxy en zijn updates moet je zelf
  goed houden.
- **Cloudflare Tunnel.** Zie hierboven. Geen inkomende poort; een aanbieder op
  het pad met eigen voorwaarden.

Wat een apparaat onderweg nodig heeft, wat je ook kiest (de route, de naam,
het certificaat, de iOS-vraag voor het lokale netwerk, de firewall):
[Hem bereiken van buiten je LAN](../server.md#reaching-it-from-outside-your-lan).

## Probleemoplossing

| Symptoom | Waarschijnlijke oorzaak | Eerste wat je probeert |
| --- | --- | --- |
| `obsync: offline` | Het apparaat kan de server-URL niet bereiken | Open de URL in een browser op hetzelfde apparaat; controleer de poort, HTTPS en de route |
| Een telefoon verbindt niet terwijl een computer wel synchroniseert | Het privécertificaat wordt op de telefoon niet vertrouwd | Installeer het hoofdcertificaat; zet het op iOS ook aan onder "Certificaatvertrouwensinstellingen" |
| `401 stale_timestamp` | Een klok wijkt meer dan 300 seconden af | Zet de automatische tijd aan, op het apparaat of op de server |
| `403 device_pending` | Niemand heeft het apparaat nog goedgekeurd | Keur het op naam goed op het apparaat waarvandaan je hebt gekoppeld |
| Een bestand komt nooit aan | Het valt buiten de mapselectie, of boven de groottegrens van een telefoon | Controleer **Sync folders on this device**; voer op de telefoon **Show remote-only files** uit |

Elk ander symptoom, elke foutcode en hoe je een rapport verzamelt dat het
versturen waard is: [Probleemoplossing](../troubleshooting.md).

## Documentatie

| Pagina | Wat ze beantwoordt |
| --- | --- |
| [Snelstart](../quickstart.md) | Het eerste apparaat en het tweede, elke stap volledig |
| [De server draaien](../server.md) | Docker, Compose met Caddy, certificaten, back-ups, hem bereiken van buiten je LAN |
| [Cloudflare](cloudflare.md) | Tunnel met een privéroute en de Cloudflare One-client, of een publieke hostnaam achter Access |
| [Kubernetes](../../chart/README.md) | De server installeren met de ondertekende Helm-chart |
| [Dagelijks gebruik](../daily-use.md) | Opdrachten, de statusbalk, wat wel en niet synchroniseert, een versie terugzetten, het dashboard |
| [Instellingen](../settings.md) | Elke instelling, de standaardwaarde en wanneer je die verandert |
| [Probleemoplossing](../troubleshooting.md) | Symptoom, oorzaak, oplossing en hoe je een rapport verzamelt |
| [Conflicten](../conflicts.md) | Wat een conflictkopie is en wat je ermee doet |
| [Herstel](../recovery.md) | Een verloren apparaat, een verloren server, een verhuisde server, een geroteerd token |
| [Installeren en bijwerken](../community-plugin.md) | De directory van Obsidian, updates, het beheer van de inloggegevens, de beoordeling van de vermelding |
| [Dreigingsmodel](../threat-model.md) | Wat wordt verdedigd en wat niet |
| [Het dreigingsmodel van het dashboard](../security/dashboard.md) | Sessies, aanmelding, intrekking, restrisico's |
| [Architectuur](../architecture.md) | Hoe het hele systeem is gebouwd, en elke omgevingsvariabele |
| [Protocol](../protocol.md) | Het contract op de lijn tussen plugin en server |
| [Opslag](../storage.md) | Volumes, duurzaamheid, bewaring, scrub en elke weigering |
| [Validatie](../validation.md) | Het validatieplan voor apparaten en wat "gereed" betekent |
| [Releases](../release.md) | Hoe een release wordt gesneden, ondertekend en gecontroleerd |
| [Vertalingen](../translations.md) | In welke talen de handleidingen bestaan en hoe ze actueel worden gehouden |
| [`CHANGELOG.md`](../../CHANGELOG.md) | Wat er in elke versie is veranderd |
| [`SECURITY.md`](../../SECURITY.md) | Houding, ondersteunde versies en hoe je een kwetsbaarheid meldt |
| [`CONTRIBUTING.md`](../../CONTRIBUTING.md) | Hoe je aan dit repository werkt |

## Vragen, fouten en beveiliging

- **Een vraag, of iets waarvan je niet zeker weet of het een fout is:**
  [Discussions](https://github.com/snaraj/obsync/discussions).
- **Een fout:** [open een issue](https://github.com/snaraj/obsync/issues/new/choose)
  met het sjabloon voor foutrapporten en het rapport dat in
  [Probleemoplossing](../troubleshooting.md) wordt beschreven. Zonder token,
  zonder herstelzin en zonder een adres dat je niet zou publiceren.
- **Een vermoedelijke kwetsbaarheid:** vertrouwelijk, via
  [`SECURITY.md`](../../SECURITY.md) — nooit als openbaar issue.

## Licentie

MIT. Zie [`LICENSE`](../../LICENSE).
