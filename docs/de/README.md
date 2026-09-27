> Diese Übersetzung folgt dem [englischen Original](../../README.md). Der englische Text ist maßgeblich; Befehle, Flags, URLs und Platzhalter bleiben unverändert.

<img src="../../brand/obsync-icon-256.png" alt="obsync-Symbol: zwei ineinandergreifende Ringe" width="96" height="96">

# Self Hosted Private Sync

Selbst gehostete, Ende-zu-Ende-verschlüsselte Live-Synchronisation für
[Obsidian](https://obsidian.md). Deine Notizen werden über einen Server
synchronisiert, den du selbst betreibst. Notizen, Anhänge und Dateinamen werden auf
deinem Gerät verschlüsselt, und der Server bekommt den Schlüssel nie. Das
Plugin läuft auf jeder Plattform, auf der Obsidian läuft, am Computer wie auf
dem Handy. Es gibt kein Abo und kein Konto irgendwo anders.

**Funktioniert etwas nicht? → [Fehlersuche](https://snaraj.github.io/obsync/troubleshooting/)**

## Finde, was du brauchst

Jede Seite steht auch auf der
[Dokumentations-Website](https://snaraj.github.io/obsync/). Die verlinkten
Seiten sind auf Englisch.

### obsync nutzen

| Ich möchte … | Weiter zu |
| --- | --- |
| wählen, wie meine Geräte meinen Server erreichen | [Einrichtung wählen](../setup.md) |
| alles in meinem Heimnetz einrichten, mit jedem Bildschirm auf dem Handy | [Gleiches Netz, Schritt für Schritt](../same-network.md) |
| das Plugin installieren | [Das Plugin installieren](../community-plugin.md) |
| mein erstes Gerät einrichten | [Schnellstart](../quickstart.md) |
| ein Handy oder einen weiteren Computer koppeln | [Dein Handy koppeln](../quickstart.md#pair-your-phone) |
| wissen, was das Statussymbol und die Befehle bedeuten | [Täglicher Gebrauch](../daily-use.md) und [Die Statusleiste lesen](../troubleshooting.md#reading-the-status-bar) |
| eine ältere Version einer Notiz zurückholen | [Eine aufbewahrte Version wiederherstellen](../daily-use.md#restore-a-retained-version) |
| wissen, was eine Einstellung bewirkt | [Einstellungen](../settings.md) |
| mit einer Konfliktkopie umgehen | [Konflikte](../conflicts.md) |
| ein Problem beheben | [Fehlersuche](../troubleshooting.md) |
| wieder hineinkommen, nachdem ich ein Gerät verloren habe | [Wiederherstellung](../recovery.md) |
| meinen Vault auf einen anderen Server umziehen | [Diesen Vault auf einen anderen Server umziehen](../recovery.md#moving-this-vault-to-a-different-server) |

### Einen Server betreiben

| Ich möchte … | Weiter zu |
| --- | --- |
| meinen Server mit Docker oder Compose betreiben | [Server betreiben](../server.md) |
| ihn hinter meinen eigenen Proxy stellen (Caddy, nginx, Traefik, HAProxy) | [Schon einen TLS-Terminator?](../server.md#already-have-a-tls-terminator-docker) |
| ihn ohne Container betreiben, unter systemd | [Das statische Binary](../server.md#without-a-container-the-static-binary) |
| meinen Server auf Kubernetes betreiben | [Kubernetes](../kubernetes.md) und die [Chart-Referenz](../../chart/README.md) |
| meinen Server von unterwegs erreichen, über mein eigenes VPN oder meinen Proxy | [Von außerhalb deines LANs erreichen](../server.md#reaching-it-from-outside-your-lan) |
| Cloudflare nutzen (optional) | [Cloudflare](cloudflare.md) |
| dem Zertifikat meines Servers auf jedem Gerät vertrauen | [Der Zertifizierungsstelle vertrauen](../server.md#trust-the-certificate-authority-once-per-device) |
| wissen, wie viel Arbeitsspeicher und Festplatte er braucht | [Wie viel Arbeitsspeicher er braucht](../server.md#how-much-memory-it-needs) und [Speicher](../storage.md) |
| meinen Server sichern | [Die zwei Volumes sichern](../server.md#back-up-the-two-volumes) |
| meinen Server aktualisieren | [Per Digest aktualisieren](../server.md#upgrade-by-digest) |
| meine Geräte sehen und eines widerrufen | [Das Dashboard](../dashboard.md) |
| meinen Server löschen und neu anfangen | [Einen Server leeren](../purge.md) |
| sehen, was sich in jeder Version geändert hat | [`CHANGELOG.md`](../../CHANGELOG.md) |

### Vertrauen und Privatsphäre

| Ich möchte … | Weiter zu |
| --- | --- |
| wissen, worauf dieses Plugin auf meinem Gerät und in meinem Netz zugreift | [Worauf dieses Plugin zugreift](#worauf-dieses-plugin-zugreift) |
| verstehen, was verschlüsselt ist und was der Server sehen kann | [Bedrohungsmodell](../threat-model.md) und [das Bedrohungsmodell des Dashboards](../security/dashboard.md) |
| ein Sicherheitsproblem melden | [`SECURITY.md`](../../SECURITY.md) |

### Blick ins Projekt

Für Mitwirkende und Prüfende: [`CONTRIBUTING.md`](../../CONTRIBUTING.md),
[Architektur](../architecture.md), [Protokoll](../protocol.md),
[Benchmarks](../benchmarks.md), [Validierungsläufe auf Geräten](../validation-runs/)
und [alle Seiten](../README.md).

## Installieren

![Die Einstellungen des Plugins öffnen mit Get started: die Zeile Setup guide mit ihrer Schaltfläche Open the guide, über dem Feld Server URL](../assets/settings-get-started.png)

Installiere das Plugin über **Einstellungen → Externe Erweiterungen →
Durchsuchen**. Suche nach **Self Hosted Private Sync** (Plugin-ID
`obsync-private-sync`). Es braucht Obsidian 1.13.0 oder neuer. Seine
Einstellungen öffnen mit der Einrichtungsanleitung, nur einen Klick entfernt.

> [!IMPORTANT]
> - Es synchronisiert mit einem Server, den **du** betreibst: kein gehosteter Dienst, kein Konto anderswo.
> - Sichere vorher deinen Vault; bewahre die 24-Wörter-Wiederherstellungsphrase nicht auf dem Gerät auf, das sie erzeugt hat.
> - Betreibe es nie neben einer anderen Synchronisation (Obsidian Sync, einem Cloud-Ordner, einem anderen Plugin) auf demselben Vault.
> - Junge Software: Lies den Eintrag zu deiner Version in [`CHANGELOG.md`](../../CHANGELOG.md), aktualisiere jedes Gerät und mach dir klar, was jeder [Validierungslauf](../validation-runs/) abgedeckt hat.

## Synchronisation einrichten

Der kürzeste vollständige Weg ist Compose mit Caddy in deinem eigenen Netz,
aus einem Checkout dieses Repositories. Er gibt dir HTTPS in jedem Netz, ohne
Domain und ohne Konto irgendwo. [Gleiches Netz, Schritt für Schritt](../same-network.md)
führt mit jedem Bildschirm hindurch. Ersetze unten `vX.Y.Z` durch das Release,
das du installierst: das neueste Tag auf der
[Releases-Seite](https://github.com/snaraj/obsync/releases/latest).

**1. Das Image prüfen.** Führe danach genau den Digest aus, den der Befehl
ausgegeben hat:

```sh
cosign verify ghcr.io/snaraj/obsync:vX.Y.Z \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**2. Den Server starten:**

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` ist der Name, den deine Geräte eintippen werden. Er muss nur in
deinem eigenen Netz auflösbar sein. `OBSYNC_BIND_ADDRESS` ist die Adresse, auf
der die Ports 80 und 443 veröffentlicht werden: Eine Bind-Adresse begrenzt die
Zielschnittstelle, nicht die Quelle, also entscheidet deine Firewall, wer ihn
erreicht. Compose startet erst, wenn du gewählt hast.

**3. Das Setup-Token lesen.** Beim ersten Start erzeugt der Server ein
Setup-Token und schreibt es auf sein Journal-Volume, Modus 0600, nie
protokolliert. Es legt dein Konto einmal an und bleibt die
Wiederherstellungsanmeldung des Dashboards. Hüte es wie die
Wiederherstellungsphrase:

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

**4. Jedes Gerät einrichten.** Vertraue dem Zertifikat des Servers einmal
([so geht's](../server.md#trust-the-certificate-authority-once-per-device)).
Installiere das Plugin und folge dann dem [Schnellstart](../quickstart.md):
Richte das erste Gerät ein und kopple danach die anderen.

Hast du schon HTTPS davor, durch einen Proxy oder Tunnel, dem du vertraust?
Starte stattdessen den
[nackten Server](../server.md#already-have-a-tls-terminator-docker).

## Worauf dieses Plugin zugreift

- **Dein Server, sonst nichts.** Jede Anfrage geht an die **Server URL**, die du einträgst; keine Telemetrie, kein Dritter.
- **Ein Konto auf diesem Server**, aus dem Setup-Token angelegt; dein Obsidian-Konto spielt keine Rolle.
- **GitHub-Releases, über Obsidian**, für Installation und Update; Obsidian ignoriert die zusätzlichen Release-Dateien.
- **Die Dateiliste deines Vaults**, um zu entscheiden, was synchronisiert wird; versteckte (`.obsidian`, `.git`) und symbolisch verlinkte Ordner werden übersprungen.
- **Die Zwischenablage, nur schreibend**, durch **Copy code** und **Copy link** in **Pair a new device**, nie lesend.
- **Dein Browser, wenn du die Einrichtungsanleitung aufrufst.** Dort öffnet sich die Anleitung des Projekts; das Plugin selbst sendet nichts.

Was der Server sehen kann und was nicht: [`SECURITY.md`](../../SECURITY.md) und das [Bedrohungsmodell](../threat-model.md).

## Versionen

Das LATEST-Release ist das neueste Tag auf der
[Releases-Seite](https://github.com/snaraj/obsync/releases/latest). Das
installiert Obsidian, und darauf aktualisiert es. `main` ist EDGE:
zusammengeführte, aber noch nicht veröffentlichte Arbeit, für alle, die aus
dem Quellcode bauen. Es gibt keinen Beta-Kanal und kein Vorab-Tag. Der
Abschnitt „Unreleased“ im Changelog ist das Protokoll von EDGE.

## Fragen, Fehler und Sicherheit

- **Eine Frage, oder du bist nicht sicher, ob es ein Fehler ist:** [Discussions](https://github.com/snaraj/obsync/discussions).
- **Ein Fehler:** [Eröffne ein Issue](https://github.com/snaraj/obsync/issues/new/choose) mit dem Bericht, den die [Fehlersuche](../troubleshooting.md#how-to-collect-a-report) beschreibt. Lass jedes Token, jede Phrase und jede Adresse weg, die du nicht veröffentlichen würdest.
- **Eine vermutete Schwachstelle:** vertraulich, über [`SECURITY.md`](../../SECURITY.md), nie als öffentliches Issue.

## Lizenz

MIT. Siehe [`LICENSE`](../../LICENSE).
