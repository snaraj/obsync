> Deze vertaling volgt het [Engelse origineel](../../README.md). De Engelse tekst is leidend; opdrachten, opties, URL's en plaatshouders blijven ongewijzigd.

<img src="../../brand/obsync-icon-256.png" alt="obsync-pictogram: twee in elkaar grijpende ringen" width="96" height="96">

# Self Hosted Private Sync

Zelf gehoste, end-to-end versleutelde live synchronisatie voor
[Obsidian](https://obsidian.md): één afhankelijkheidsvrije Rust-server met een
ingebouwd dashboard die je zelf draait, plus deze plugin. Bestanden van elke
grootte, elk Obsidian-platform, geen abonnement, geen derde partij.

Installeer hem via Instellingen → Externe plug-in → Doorbladeren als
**Self Hosted Private Sync** (plugin-id `obsync-private-sync`), op Obsidian
1.13.0 of nieuwer.

**Nieuw hier? Begin met de [installatiegids](https://snaraj.github.io/obsync/setup/) (in het Engels).** Die helpt je kiezen hoe je apparaten je server bereiken en loopt elke optie stap voor stap door. In Obsidian: Instellingen → Self Hosted Private Sync → Setup guide.

> [!IMPORTANT]
> - Hij synchroniseert met een server die **jij** draait: geen gehoste dienst,
>   nergens anders een account.
> - Maak eerst een back-up van je kluis; bewaar de herstelzin van 24 woorden
>   niet op het apparaat dat hem heeft gemaakt.
> - Draai hem nooit naast een andere synchronisatie (Obsidian Sync, een
>   cloudmap, een andere plugin) op één kluis.
> - Jonge software: lees het item in [`CHANGELOG.md`](../../CHANGELOG.md) voor
>   jouw versie, werk elk apparaat bij en weet wat elke
>   [validatierun](../validation-runs/) heeft gedekt.

## Waar deze plugin toegang toe heeft

- **Je eigen server, en niets anders.** Elk verzoek gaat naar de
  **Server URL** die je invult; geen telemetrie, geen derde partij.
- **Een account op die server**, aangemaakt met het setup-token; je
  Obsidian-account speelt geen rol.
- **GitHub Releases, via Obsidian**, voor installatie en updates; Obsidian
  negeert de extra release-bestanden.
- **De bestandslijst van je kluis**, om te bepalen wat er synchroniseert;
  verborgen mappen (`.obsidian`, `.git`) en mappen die een symbolische
  koppeling zijn, worden overgeslagen.
- **Het klembord, alleen beschreven** door **Copy code** en **Copy link** in
  **Pair a new device**, nooit gelezen.

Wat de server wel en niet kan zien: [`SECURITY.md`](../../SECURITY.md) en het
[dreigingsmodel](../threat-model.md).

## Aan de slag met synchroniseren

Vijf stappen, van niets tot twee apparaten die synchroon lopen. `v1.0.6` is de
release waarvoor deze pagina is geschreven; neem de tag van de release die je
installeert.

### 1. De server starten

Controleer de handtekening en draai daarna precies de digest die ze afdrukt:

```sh
cosign verify ghcr.io/snaraj/obsync:v1.0.6 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Het eenvoudigste pad is Compose met Caddy, vanuit een checkout van dit
repository: HTTPS op elk netwerk, zonder domein en zonder account bij wie dan
ook.

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` is de naam die je apparaten zullen intypen; hij hoeft alleen op
je eigen netwerk op te lossen. `OBSYNC_BIND_ADDRESS` is het adres waarop de
poorten 80 en 443 worden gepubliceerd: een bind-adres beperkt de
doelinterface, niet de bron, dus je firewall bepaalt wie hem bereikt. Compose
weigert te starten totdat je hebt gekozen.

Staat er al HTTPS voor, van een proxy of een tunnel die je vertrouwt? Draai
dan de kale server: [De server draaien](../server.md).

### 2. Het setup-token lezen

Bij de eerste start maakt de server een setup-token aan en schrijft het naar
zijn journal-volume, modus 0600, nooit gelogd. Het maakt je account één keer
aan en blijft daarna de herstelaanmelding van het dashboard: behandel het met
dezelfde zorg als de herstelzin. Lees het uit de container:

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

### 3. Het certificaat vertrouwen, eenmaal per apparaat

Caddy ondertekent met een autoriteit die het bij de eerste start zelf heeft
gemaakt, dus elk apparaat moet die één keer vertrouwen. Exporteer het
hoofdcertificaat en installeer het per platform zoals
[De server draaien](../server.md#trust-the-certificate-authority-once-per-device)
laat zien; op iOS is het vertrouwen ervan een tweede schakelaar ná de
installatie.

### 4. Het eerste apparaat inrichten

1. Instellingen → Externe plug-in → Doorbladeren →
   **Self Hosted Private Sync** → Installeren → Activeer.
2. Zet **Server URL** op je server (`https://sync.example.org`, met poort
   wanneer die niet 443 is) en kies dan **Whole vault** of
   **Selected folders only**; de selectie kan later alleen nog smaller worden.

   ![Het instellingentabblad van de plugin: het veld Server URL met een demo-hostnaam, het vak voor de edge-headers en de rij Connection met de knoppen Check en Open dashboard](../assets/settings-server.png)

3. Plak het setup-token onder **First-time setup**, kies **Set up** en schrijf
   de herstelzin van 24 woorden op.

   ![Het gedeelte This device van het instellingentabblad: de rij Pairing met Pair this device en Pair a new device, de rij First-time setup met het veld Setup token en de knop Set up, en de rij Vault key](../assets/settings-setup.png)

### 5. Het tweede apparaat koppelen

1. Installeer de plugin daar met dezelfde **Server URL**; voer op het eerste
   apparaat **Pair a new device** uit voor een code die tien minuten geldig
   is.

   ![Het dialoogvenster Pair a new device op het eerste apparaat, de code onleesbaar gemaakt, met de knoppen Copy code en Copy link en de regel Waiting for the new device](../assets/pair-new-device.png)

2. Open op het tweede apparaat **Pair this device**, plak de code en kies
   **Pair**.
3. Terug op het eerste apparaat keur je het op naam goed. Bewerk op een van
   beide een notitie; ze verschijnt binnen enkele seconden op het andere.

   ![Het eerste apparaat vraagt of het nieuwe apparaat op naam moet worden goedgekeurd, met de knoppen Approve en Reject](../assets/pair-approve.png)

![Animatie: de koppelcode wordt op het eerste apparaat getoond, op het tweede geplakt, op het eerste goedgekeurd, en de eerste notitie komt aan op het tweede](../assets/pairing.gif)

Het op één computer uitproberen? Op een computer bereikt
`http://127.0.0.1:8080` de kale server; Obsidian op iOS en Android weigert
gewoon HTTP.

Schermafbeeldingen van een telefoon staan nog niet in dit repository; ze
worden op de eigen apparaten van de beheerder gemaakt en toegevoegd zodra een
validatierun ze vastlegt.

Elke stap volledig: [Snelstart](../quickstart.md).

## Gevorderd: Cloudflare

De referentie-installatie heeft geen publieke hostnaam: een Cloudflare Tunnel
en een privéroute bereiken het netwerk van de server, en de Cloudflare
One-client op elk apparaat draagt de server-URL daarheen. Een publieke
hostnaam achter Cloudflare Access, met een servicetoken in
**Edge service-token headers** en `OBSYNC_EDGE=cloudflare`, werkt ook.
Beide, stap voor stap: [Cloudflare](cloudflare.md).

## Andere manieren om je server te bereiken

Wat je ook kiest, de plugin heeft HTTPS nodig met een certificaat dat elk
apparaat vertrouwt; de server zelf blijft achter die terminator op gewoon
HTTP.

- **Alleen LAN.** Het Compose-pad hierboven, alleen thuis bereikbaar; geen
  synchronisatie buitenshuis.
- **WireGuard.** Je eigen VPN naar huis: het snelst en helemaal van jou; op
  elk apparaat een peer-configuratie.
- **Tailscale.** Een beheerde WireGuard-mesh: de minste inrichting; een derde
  partij coördineert hem, onder de voorwaarden van zijn abonnement.
- **Een reverse proxy met automatische TLS**, zoals Caddy op een publieke
  naam: bereikbaar vanaf het internet, en jij houdt hem bij.
- **Cloudflare Tunnel.** Zie hierboven. Geen inkomende poort; een aanbieder op
  het pad, onder zijn eigen voorwaarden.

Wat een apparaat onderweg nodig heeft (route, naam, certificaat, firewall, de
iOS-vraag voor het lokale netwerk):
[Hem bereiken van buiten je LAN](../server.md#reaching-it-from-outside-your-lan).

## Probleemoplossing

| Symptoom | Waarschijnlijke oorzaak | Eerste wat je probeert |
| --- | --- | --- |
| `obsync: offline` | Het apparaat kan de server-URL niet bereiken | Open de URL in een browser op hetzelfde apparaat; controleer de poort, HTTPS en de route |
| Een telefoon verbindt niet terwijl een computer wel synchroniseert | Het privécertificaat wordt op de telefoon niet vertrouwd | Installeer het hoofdcertificaat; zet het op iOS ook aan onder "Certificaatvertrouwensinstellingen" |
| `401 stale_timestamp` | Een klok wijkt meer dan 300 seconden af | Zet de automatische tijd aan, op het apparaat of op de server |
| `403 device_pending` | Niemand heeft het apparaat nog goedgekeurd | Keur het op naam goed op het apparaat waarvandaan je hebt gekoppeld |
| Een bestand komt nooit aan | Het valt buiten de mapselectie, of boven de groottegrens van een telefoon | Controleer **Sync folders on this device**; voer op de telefoon **Show remote-only files** uit |

Elk ander symptoom en elke foutcode, en hoe je er een meldt:
[Probleemoplossing](../troubleshooting.md).

## Documentatie

[Snelstart](../quickstart.md) · [De server draaien](../server.md) ·
[Cloudflare](cloudflare.md) · [Dagelijks gebruik](../daily-use.md) ·
[Instellingen](../settings.md) · [Probleemoplossing](../troubleshooting.md) ·
[Herstel](../recovery.md) · [Changelog](../../CHANGELOG.md)

Al het overige: [docs/README.md](../README.md).

## Vragen, fouten en beveiliging

- **Een vraag, of iets waarvan je niet zeker weet of het een fout is:**
  [Discussions](https://github.com/snaraj/obsync/discussions).
- **Een fout:** [open een issue](https://github.com/snaraj/obsync/issues/new/choose)
  met het rapport dat [Probleemoplossing](../troubleshooting.md) beschrijft;
  zonder token, zonder herstelzin en zonder een adres dat je niet zou
  publiceren.
- **Een vermoedelijke kwetsbaarheid:** vertrouwelijk, via
  [`SECURITY.md`](../../SECURITY.md), nooit als openbaar issue.

## Licentie

MIT. Zie [`LICENSE`](../../LICENSE).
