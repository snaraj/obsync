> Deze vertaling volgt het [Engelse origineel](../../README.md). De Engelse tekst is leidend; opdrachten, opties, URL's en plaatshouders blijven ongewijzigd.

<img src="../../brand/obsync-icon-256.png" alt="obsync-pictogram: twee in elkaar grijpende ringen" width="96" height="96">

# Self Hosted Private Sync

Zelf gehoste, end-to-end versleutelde live synchronisatie voor
[Obsidian](https://obsidian.md). Je notities synchroniseren via een server die
je zelf draait. Notities, bijlagen en bestandsnamen worden op je apparaat
versleuteld, en de server krijgt de sleutel nooit. De plugin werkt op elk
platform waarop Obsidian draait, desktop en mobiel. Er is geen abonnement en
nergens anders een account.

**Werkt er iets niet? → [Probleemoplossing](https://snaraj.github.io/obsync/troubleshooting/)**

## Vind wat je zoekt

Elke pagina staat ook op de
[documentatiesite](https://snaraj.github.io/obsync/). De gelinkte pagina's
zijn in het Engels.

### obsync gebruiken

| Ik wil… | Ga naar |
| --- | --- |
| Kiezen hoe mijn apparaten mijn server bereiken | [Kies je opzet](../setup.md) |
| Alles op mijn thuisnetwerk instellen, met elk scherm op de telefoon | [Hetzelfde netwerk, stap voor stap](../same-network.md) |
| De plugin installeren | [De plugin installeren](../community-plugin.md) |
| Mijn eerste apparaat instellen | [Snelstart](../quickstart.md) |
| Een telefoon of een andere computer koppelen | [Je telefoon koppelen](../quickstart.md#pair-your-phone) |
| Weten wat het statuspictogram en de opdrachten betekenen | [Dagelijks gebruik](../daily-use.md) en [De statusbalk lezen](../troubleshooting.md#reading-the-status-bar) |
| Een oudere versie van een notitie terugkrijgen | [Een bewaarde versie terugzetten](../daily-use.md#restore-a-retained-version) |
| Weten wat een instelling doet | [Instellingen](../settings.md) |
| Omgaan met een conflictkopie | [Conflicten](../conflicts.md) |
| Een probleem oplossen | [Probleemoplossing](../troubleshooting.md) |
| Weer binnenkomen nadat ik een apparaat kwijt ben | [Herstel](../recovery.md) |
| Mijn kluis naar een andere server verhuizen | [Deze kluis naar een andere server verhuizen](../recovery.md#moving-this-vault-to-a-different-server) |

### Een server draaien

| Ik wil… | Ga naar |
| --- | --- |
| Mijn server draaien met Docker of Compose | [De server draaien](../server.md) |
| Hem achter mijn eigen proxy zetten (Caddy, nginx, Traefik, HAProxy) | [Al een TLS-terminator?](../server.md#already-have-a-tls-terminator-docker) |
| Hem zonder container draaien, onder systemd | [De statische binary](../server.md#without-a-container-the-static-binary) |
| Mijn server op Kubernetes draaien | [Kubernetes](../kubernetes.md) en de [chart-referentie](../../chart/README.md) |
| Mijn server buitenshuis bereiken, via mijn eigen VPN of proxy | [Hem bereiken van buiten je LAN](../server.md#reaching-it-from-outside-your-lan) |
| Cloudflare gebruiken (optioneel) | [Cloudflare](cloudflare.md) |
| Het certificaat van mijn server op elk apparaat vertrouwen | [De certificaatautoriteit vertrouwen](../server.md#trust-the-certificate-authority-once-per-device) |
| Weten hoeveel geheugen en schijfruimte hij nodig heeft | [Hoeveel geheugen hij nodig heeft](../server.md#how-much-memory-it-needs) en [Opslag](../storage.md) |
| Een back-up van mijn server maken | [Een back-up van de twee volumes maken](../server.md#back-up-the-two-volumes) |
| Mijn server bijwerken | [Bijwerken via digest](../server.md#upgrade-by-digest) |
| Mijn apparaten zien en er een intrekken | [Het dashboard](../dashboard.md) |
| Mijn server wissen en opnieuw beginnen | [Een server leegmaken](../purge.md) |
| Zien wat er in elke versie is veranderd | [`CHANGELOG.md`](../../CHANGELOG.md) |

### Vertrouwen en privacy

| Ik wil… | Ga naar |
| --- | --- |
| Weten waar deze plugin op mijn apparaat en netwerk toegang toe heeft | [Waar deze plugin toegang toe heeft](#waar-deze-plugin-toegang-toe-heeft) |
| Begrijpen wat er versleuteld is en wat de server kan zien | [Dreigingsmodel](../threat-model.md) en [het dreigingsmodel van het dashboard](../security/dashboard.md) |
| Een beveiligingsprobleem melden | [`SECURITY.md`](../../SECURITY.md) |

### Binnen in het project

Voor bijdragers en reviewers: [`CONTRIBUTING.md`](../../CONTRIBUTING.md),
[architectuur](../architecture.md), [protocol](../protocol.md),
[benchmarks](../benchmarks.md),
[validatieruns op apparaten](../validation-runs/) en
[alle pagina's](../README.md).

## Installeren

![De instellingen van de plugin openen met Get started: de rij Setup guide en de knop Open the guide, boven het veld Server URL](../assets/settings-get-started.png)

Installeer de plugin via **Instellingen → Externe plug-in → Doorbladeren**.
Zoek naar **Self Hosted Private Sync** (plugin-id `obsync-private-sync`). Hij
heeft Obsidian 1.13.0 of nieuwer nodig. Zijn instellingen openen met de
installatiegids, één klik verderop.

> [!IMPORTANT]
> - Hij synchroniseert met een server die **jij** draait: geen gehoste dienst, nergens anders een account.
> - Maak eerst een back-up van je kluis; bewaar de herstelzin van 24 woorden niet op het apparaat dat hem heeft gemaakt.
> - Draai hem nooit naast een andere synchronisatie (Obsidian Sync, een cloudmap, een andere plugin) op één kluis.
> - Jonge software: lees het item in [`CHANGELOG.md`](../../CHANGELOG.md) voor jouw versie, werk elk apparaat bij en weet wat elke [validatierun](../validation-runs/) heeft gedekt.

## Aan de slag met synchroniseren

Het kortste volledige pad is Compose met Caddy op je eigen netwerk, vanuit een
checkout van dit repository. Het geeft je HTTPS op elk netwerk, zonder domein
en zonder account waar dan ook.
[Hetzelfde netwerk, stap voor stap](../same-network.md) loopt het met elk
scherm door. Vervang hieronder `vX.Y.Z` door de release die je installeert:
de nieuwste tag op de
[Releases-pagina](https://github.com/snaraj/obsync/releases/latest).

**1. Controleer de image.** Draai daarna precies de digest die de opdracht
heeft afgedrukt:

```sh
cosign verify ghcr.io/snaraj/obsync:vX.Y.Z \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**2. Start de server:**

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` is de naam die je apparaten zullen intypen. Hij hoeft alleen op
je eigen netwerk op te lossen. `OBSYNC_BIND_ADDRESS` is het adres waarop de
poorten 80 en 443 worden gepubliceerd: een bind-adres beperkt de
doelinterface, niet de bron, dus je firewall bepaalt wie hem bereikt. Compose
weigert te starten totdat je hebt gekozen.

**3. Lees het setup-token.** Bij de eerste start maakt de server een
setup-token aan en schrijft het naar zijn journal-volume, modus 0600, nooit
gelogd. Het maakt je account één keer aan en blijft de herstelaanmelding van
het dashboard. Bewaar het net zo zorgvuldig als de herstelzin:

```sh
docker exec obsync-obsync-1 obsyncd setup-token
```

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

**4. Stel elk apparaat in.** Vertrouw het certificaat van de server één keer
([hoe](../server.md#trust-the-certificate-authority-once-per-device)).
Installeer de plugin en volg dan de [Snelstart](../quickstart.md): stel het
eerste apparaat in en koppel daarna de andere.

Staat er al HTTPS voor, van een proxy of tunnel die je vertrouwt? Draai dan
de [kale server](../server.md#already-have-a-tls-terminator-docker).

## Waar deze plugin toegang toe heeft

- **Je eigen server, en niets anders.** Elk verzoek gaat naar de **Server URL** die je invult; geen telemetrie, geen derde partij.
- **Een account op die server**, aangemaakt met het setup-token; je Obsidian-account speelt geen rol.
- **GitHub Releases, via Obsidian**, voor installatie en updates; Obsidian negeert de extra release-bestanden.
- **De bestandslijst van je kluis**, om te bepalen wat er synchroniseert; verborgen mappen (`.obsidian`, `.git`) en mappen die een symbolische koppeling zijn, worden overgeslagen.
- **Het klembord, alleen om naar te schrijven**, door **Copy code** en **Copy link** in **Pair a new device**; nooit gelezen.
- **Je browser, als je om de installatiegids vraagt.** Daar opent de gids van het project; de plugin zelf verstuurt niets.

Wat de server wel en niet kan zien: [`SECURITY.md`](../../SECURITY.md) en het [dreigingsmodel](../threat-model.md).

## Versies

De LATEST-release is de nieuwste tag op de
[Releases-pagina](https://github.com/snaraj/obsync/releases/latest). Die
installeert Obsidian en daar werkt het naar bij. `main` is de EDGE: werk dat
is samengevoegd maar nog niet uitgebracht, voor wie vanaf de broncode bouwt.
Er is geen bètakanaal en geen pre-release-tag. De sectie ‘Unreleased’ in de
changelog houdt bij wat er in de EDGE zit.

## Vragen, fouten en beveiliging

- **Een vraag, of iets waarvan je niet zeker weet of het een fout is:** [Discussions](https://github.com/snaraj/obsync/discussions).
- **Een fout:** [open een issue](https://github.com/snaraj/obsync/issues/new/choose) met het rapport dat [Probleemoplossing](../troubleshooting.md#how-to-collect-a-report) beschrijft. Laat tokens, herstelzinnen en adressen die je niet zou publiceren weg.
- **Een vermoedelijke kwetsbaarheid:** vertrouwelijk, via [`SECURITY.md`](../../SECURITY.md), nooit als openbaar issue.

## Licentie

MIT. Zie [`LICENSE`](../../LICENSE).
