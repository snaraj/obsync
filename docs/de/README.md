> Diese Übersetzung folgt dem [englischen Original](../../README.md). Der englische Text ist maßgeblich; Befehle, Flags, URLs und Platzhalter bleiben unverändert.

# Self Hosted Private Sync

Selbst gehostete, Ende-zu-Ende-verschlüsselte Live-Synchronisation für
[Obsidian](https://obsidian.md): ein abhängigkeitsfreier Rust-Server mit
eingebautem Dashboard, den du selbst betreibst, plus dieses Plugin. Dateien
jeder Größe, jede Obsidian-Plattform, kein Abo, kein Dritter.

Installiere es unter Einstellungen → Externe Erweiterungen → Durchsuchen als
**Self Hosted Private Sync** (Plugin-ID `obsync-private-sync`), ab Obsidian
1.13.0.

> [!IMPORTANT]
> - Es synchronisiert mit einem Server, den **du** betreibst: kein gehosteter
>   Dienst, kein Konto anderswo.
> - Sichere vorher deinen Vault; bewahre die 24-Wörter-Wiederherstellungsphrase
>   nicht auf dem Gerät auf, das sie erzeugt hat.
> - Betreibe es nie neben einer anderen Synchronisation (Obsidian Sync, einem
>   Cloud-Ordner, einem anderen Plugin) auf einem Vault.
> - Junge Software: Lies den Eintrag zu deiner Version in
>   [`CHANGELOG.md`](../../CHANGELOG.md), aktualisiere jedes Gerät und mach
>   dir klar, was jeder [Validierungslauf](../validation-runs/) abgedeckt hat.

## Worauf dieses Plugin zugreift

- **Dein Server, sonst nichts.** Jede Anfrage geht an die **Server URL**, die
  du einträgst; keine Telemetrie, kein Dritter.
- **Ein Konto auf diesem Server**, aus dem Setup-Token angelegt; dein
  Obsidian-Konto spielt keine Rolle.
- **GitHub-Releases, über Obsidian**, für Installation und Update; Obsidian
  ignoriert die zusätzlichen Release-Artefakte.
- **Die Dateiliste deines Vaults**, um zu entscheiden, was synchronisiert
  wird; versteckte (`.obsidian`, `.git`) und symbolisch verlinkte Ordner
  werden übersprungen.
- **Die Zwischenablage, nur geschrieben** von **Copy code** und **Copy link**
  in **Pair a new device**, nie gelesen.

Was der Server sehen kann und was nicht: [`SECURITY.md`](../../SECURITY.md)
und das [Bedrohungsmodell](../threat-model.md).

## Synchronisation einrichten

Fünf Schritte von null bis zu zwei synchronen Geräten. `v1.0.6` ist das
Release, für das diese Seite geschrieben wurde; nimm das Tag des Releases, das
du installierst.

### 1. Den Server starten

Prüfe die Signatur und führe dann genau den Digest aus, den sie ausgegeben
hat:

```sh
cosign verify ghcr.io/snaraj/obsync:v1.0.6 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Der einfache Weg ist Compose mit Caddy, aus einem Checkout dieses
Repositories: HTTPS in jedem Netz, ohne Domain, ohne Konto bei irgendwem.

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` ist der Name, den deine Geräte eintippen werden; er muss nur in
deinem eigenen Netz auflösbar sein. `OBSYNC_BIND_ADDRESS` ist die Adresse, auf
der die Ports 80 und 443 veröffentlicht werden: Eine Bind-Adresse begrenzt die
Zielschnittstelle, nicht die Quelle, also entscheidet deine Firewall, wer ihn
erreicht. Compose startet erst, wenn du gewählt hast.

Schon HTTPS davor, durch einen Proxy oder einen Tunnel, dem du vertraust?
Starte stattdessen den nackten Server: [Server betreiben](../server.md).

### 2. Das Setup-Token lesen

Beim ersten Start prägt der Server ein Setup-Token und schreibt es auf sein
Journal-Volume, Modus 0600, nie protokolliert. Es legt dein Konto einmal an
und bleibt die Wiederherstellungsanmeldung des Dashboards: Hüte es wie die
Wiederherstellungsphrase. Lies es aus dem Container:

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

### 3. Dem Zertifikat vertrauen, einmal pro Gerät

Caddy signiert mit einer Zertifizierungsstelle, die es beim ersten Start
erzeugt hat; jedes Gerät muss ihr einmal vertrauen. Exportiere das
Wurzelzertifikat und installiere es je Plattform so, wie es
[Server betreiben](../server.md#trust-the-certificate-authority-once-per-device)
zeigt; unter iOS ist das Vertrauen ein zweiter Schalter nach der Installation.

### 4. Das erste Gerät einrichten

1. Einstellungen → Externe Erweiterungen → Durchsuchen → **Self Hosted
   Private Sync** → Installieren → Aktivieren.
2. Setze **Server URL** auf deinen Server (`https://sync.example.org`, mit
   Port, wenn es nicht 443 ist) und wähle dann **Whole vault** oder
   **Selected folders only**; enger werden kann die Auswahl später noch,
   weiter nicht.

   ![Der Einstellungsreiter des Plugins: das Feld Server URL mit einem Demo-Hostnamen, das Feld für Edge-Header und die Zeile Connection mit den Schaltflächen Check und Open dashboard](../assets/settings-server.png)

3. Füge das Setup-Token unter **First-time setup** ein, wähle **Set up** und
   schreib die 24-Wörter-Wiederherstellungsphrase auf.

   ![Der Abschnitt This device des Einstellungsreiters: die Zeile Pairing mit Pair this device und Pair a new device, die Zeile First-time setup mit dem Feld Setup token und der Schaltfläche Set up sowie die Zeile Vault key](../assets/settings-setup.png)

### 5. Das zweite Gerät koppeln

1. Installiere das Plugin dort mit derselben **Server URL**; führe auf dem
   ersten Gerät **Pair a new device** aus, für einen Code, der zehn Minuten
   gültig ist.

   ![Der Dialog Pair a new device auf dem ersten Gerät, sein Code unkenntlich gemacht, mit den Schaltflächen Copy code und Copy link und der Zeile Waiting for the new device](../assets/pair-new-device.png)

2. Öffne auf dem zweiten Gerät **Pair this device**, füge den Code ein und
   wähle **Pair**.
3. Zurück auf dem ersten Gerät genehmigst du es mit seinem Namen. Bearbeite
   auf einem der beiden eine Notiz; sie erscheint innerhalb von Sekunden auf
   dem anderen.

   ![Das erste Gerät fragt, ob das neue Gerät mit seinem Namen genehmigt werden soll, mit den Schaltflächen Approve und Reject](../assets/pair-approve.png)

![Animation: der Kopplungscode wird auf dem ersten Gerät gezeigt, auf dem zweiten eingefügt, auf dem ersten genehmigt, und die erste Notiz kommt auf dem zweiten an](../assets/pairing.gif)

Nur auf einem Computer ausprobieren? `http://127.0.0.1:8080` erreicht auf
einem Computer den nackten Server; Obsidian auf iOS und Android verweigert
einfaches HTTP.

Bildschirmfotos vom Telefon sind noch nicht in diesem Repository; sie werden
auf den Geräten des Maintainers aufgenommen und hinzugefügt, sobald ein
Validierungslauf sie festhält.

Jeder Schritt in voller Länge: [Schnellstart](../quickstart.md).

## Fortgeschritten: Cloudflare

Die Referenzinstallation hat keinen öffentlichen Hostnamen: Ein Cloudflare
Tunnel und eine private Route erreichen das Netz des Servers, und der
Cloudflare One Client auf jedem Gerät trägt die Server URL dorthin. Ein
öffentlicher Hostname hinter Cloudflare Access, mit einem Service-Token in
**Edge service-token headers** und `OBSYNC_EDGE=cloudflare`, funktioniert
ebenfalls. Beide, Schritt für Schritt: [Cloudflare](cloudflare.md).

## Andere Wege zu deinem Server

Was auch immer du wählst: Das Plugin braucht HTTPS mit einem Zertifikat, dem
jedes Gerät vertraut; der Server selbst bleibt hinter diesem Terminator bei
einfachem HTTP.

- **Nur LAN.** Der Compose-Pfad oben, nur zu Hause erreichbar; keine
  Synchronisation unterwegs.
- **WireGuard.** Dein eigenes VPN nach Hause: am schnellsten, ganz deins; eine
  Peer-Konfiguration auf jedem Gerät.
- **Tailscale.** Ein verwaltetes WireGuard-Mesh: am wenigsten Einrichtung; ein
  Dritter koordiniert es, zu den Bedingungen seines Tarifs.
- **Ein Reverse-Proxy mit automatischem TLS**, etwa Caddy auf einem
  öffentlichen Namen: aus dem Internet erreichbar, von dir zu pflegen.
- **Cloudflare Tunnel.** Siehe oben. Kein eingehender Port; ein Anbieter auf
  dem Pfad, zu seinen Bedingungen.

Was ein Gerät unterwegs braucht (Route, Name, Zertifikat, Firewall, die
iOS-Abfrage für das lokale Netz):
[Von außerhalb deines LANs erreichen](../server.md#reaching-it-from-outside-your-lan).

## Fehlersuche

| Symptom | Wahrscheinliche Ursache | Erster Versuch |
| --- | --- | --- |
| `obsync: offline` | Das Gerät erreicht die Server URL nicht | Öffne die URL dort in einem Browser; prüfe Port, HTTPS und die Route |
| Ein Telefon verbindet sich nicht, während ein Computer synchronisiert | Dem privaten Zertifikat wird auf dem Telefon nicht vertraut | Installiere das Wurzelzertifikat; schalte es unter iOS zusätzlich unter „Zertifikatsvertrauenseinstellungen“ ein |
| `401 stale_timestamp` | Eine Uhr geht um mehr als 300 Sekunden falsch | Schalte die automatische Zeit ein, auf dem Gerät oder dem Server |
| `403 device_pending` | Niemand hat das Gerät bisher genehmigt | Genehmige es mit seinem Namen auf dem Gerät, von dem aus du gekoppelt hast |
| Eine Datei kommt nie an | Sie liegt außerhalb der Ordnerauswahl oder über der Größenobergrenze eines Telefons | Prüfe **Sync folders on this device**; führe auf dem Telefon **Show remote-only files** aus |

Jedes andere Symptom, jeder Fehlercode und wie man einen meldet:
[Fehlersuche](../troubleshooting.md).

## Dokumentation

[Schnellstart](../quickstart.md) · [Server betreiben](../server.md) ·
[Cloudflare](cloudflare.md) · [Täglicher Gebrauch](../daily-use.md) ·
[Einstellungen](../settings.md) · [Fehlersuche](../troubleshooting.md) ·
[Wiederherstellung](../recovery.md) · [Changelog](../../CHANGELOG.md)

Alles Weitere: [docs/README.md](../README.md).

## Fragen, Fehler und Sicherheit

- **Eine Frage, oder du bist nicht sicher, ob es ein Fehler ist:**
  [Discussions](https://github.com/snaraj/obsync/discussions).
- **Ein Fehler:** [Eröffne ein Issue](https://github.com/snaraj/obsync/issues/new/choose)
  mit dem Bericht, den die [Fehlersuche](../troubleshooting.md) beschreibt;
  ohne Token, ohne Phrase, ohne eine Adresse, die du nicht veröffentlichen
  würdest.
- **Eine vermutete Schwachstelle:** vertraulich, über
  [`SECURITY.md`](../../SECURITY.md), nie als öffentliches Issue.

## Lizenz

MIT. Siehe [`LICENSE`](../../LICENSE).
