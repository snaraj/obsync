> Diese Übersetzung folgt dem [englischen Original](../cloudflare.md). Der englische Text ist maßgeblich; Befehle, Flags, URLs und Platzhalter bleiben unverändert.

# Cloudflare

Zwei Wege, Cloudflare zwischen deine Geräte und deinen Server zu setzen, und
welchen davon die Referenzinstallation nutzt. Keiner ist Pflicht: Der Server
kennt keinen Anbieter beim Namen, und [Server betreiben](../server.md) braucht
kein Konto bei irgendwem. Diese Seite ist für dich, wenn du den Server von
unterwegs erreichen willst, ohne einen Port am Router zu öffnen, oder wenn du
einen veröffentlichten Hostnamen mit einer Zugriffsrichtlinie davor willst.

Cloudflares Menüs und Tarifbedingungen ändern sich. Jeder Schritt unten nennt
den Menüpfad so, wie ihn die Cloudflare-Dokumentation am 2026-09-22 angab;
prüfe die aktuelle Seite, bevor du dich auf ein Limit oder einen Preis
verlässt.

## Welche Variante

| Variante | Was die Geräte sehen | Was das Internet sieht | Große Erstsynchronisation |
| --- | --- | --- | --- |
| **Private Route** (die Referenzinstallation) | deine eigene private Adresse und deinen Namen, über den Cloudflare One Client | nichts: kein Hostname, kein offener Port | privater Netzwerkverkehr, nicht über einen öffentlichen Hostnamen geleitet |
| **Öffentlicher Hostname mit Access** | einen öffentlichen Namen, eine Access-Richtlinie, ein Service-Token im Plugin | den Hostnamen, hinter Access | über Cloudflare geleitet, zu den Bedingungen des Anbieters für große Dateien |

Die private Route ist die Referenz, weil der Server unsichtbar bleibt und
weil Cloudflares eigene Dokumentation große Übertragungen dorthin verweist:
Eine Route über einen öffentlichen Hostnamen leitet den Verkehr durch
Cloudflare, und in den Tarifen Free, Pro und Business verlangen die
dienstspezifischen Bedingungen für Video und andere große Dateien einen
kostenpflichtigen Dienst, während eine private Netzwerkroute sie als deinen
eigenen Verkehr befördert. Mach die große Erstsynchronisation in beiden
Varianten im LAN.

Was auch immer TLS terminiert, liest deine Zugangsdaten und nie deine Notizen:
Jeder Chunk und jedes Manifest wird auf dem Gerät verschlüsselt, und kein
Schlüssel, der sie entschlüsselt, geht über die Leitung
([Bedrohungsmodell](../threat-model.md)). Auf der privaten Route gehört der
Terminator dir, in deinem Netz. Beim öffentlichen Hostnamen ist auch die Edge
ein Terminator.

## Variante A: eine private Route und der Cloudflare One Client

Der Server behält eine private Adresse in deinem eigenen Netz. Daneben läuft
ein Tunnel-Connector, eine Route sagt Cloudflare, welche Adressen hinter
diesem Tunnel liegen, und der Cloudflare One Client (früher WARP) auf jedem
Gerät befördert den Verkehr für diese Adressen durch den Tunnel. Die
Server-URL, die deine Geräte eintippen, ist ein privater Name, der auf diese
private Adresse auflöst.

Was du brauchst: ein Cloudflare-Konto mit einer Zero-Trust-Organisation
(einem „Team-Namen“), eine Maschine im Netz des Servers, die den
Tunnel-Connector ausführen kann, und den Cloudflare One Client auf jedem
Gerät, das von unterwegs synchronisieren soll.

1. **Einen Tunnel anlegen.** Gehe im Cloudflare-Dashboard zu **Networking** >
   **Tunnels** und lege einen `cloudflared`-Tunnel an. Starte den Connector,
   den es dir gibt, auf einer Maschine im Netz des Servers: im Cluster neben
   dem Server oder auf demselben Host.
2. **Die private Adresse des Servers durch den Tunnel routen.** Gehe zu
   **Networking** > **Routes**, wähle **Create route** > **Tunnel CIDR**,
   wähle den Tunnel und trage die private Adresse oder das Subnetz des
   Servers ein. Eine Adresse genügt; ein Subnetz lässt sich später erweitern.
3. **Jedes Gerät registrieren.** Installiere den Cloudflare One Client, gib
   deinen Team-Namen ein, schließe die Anmeldung ab, die deine Organisation
   verlangt, und schalte die Verbindung ein. Auf iOS und Android bittet der
   Client darum, ein VPN-Profil zu installieren; erlaube es. Setze die
   Geräte-Registrierungsberechtigungen so, dass nur deine eigene Identität
   Geräte registrieren kann.
4. **Den privaten Bereich durch den Client schicken.** Stelle in der
   Split-Tunnels-Konfiguration des Clients sicher, dass die Adresse aus
   Schritt 2 durch den Client geroutet wird. Im Modus **Exclude** entfernst
   du den RFC-1918-Block, der sie enthält, und fügst die Bereiche wieder
   hinzu, die ausgeschlossen bleiben sollen; im Modus **Include** fügst du die
   Adresse oder das Subnetz hinzu.
5. **Den Namen auf dem Gerät auflösbar machen.** Das Plugin schickt jede
   Anfrage an die Server-URL, die du eingetippt hast, also muss dieser Name
   auf dem mobilen Gerät auflösen: eine Hostname-Route, Local Domain Fallback
   auf deinen eigenen Resolver oder ein privater DNS-Eintrag. Ein Name, der
   auf eine Adresse auflöst, die der Client nicht routet, scheitert genau wie
   ein Server, der offline ist.
6. **TLS selbst terminieren.** Die Route trägt deinen Verkehr zu deinem
   eigenen Terminator: ein Ingress oder Reverse-Proxy vor dem Server mit einem
   Zertifikat, dem jedes Gerät vertraut, wie in
   [Server betreiben](../server.md). Der Server läuft mit `OBSYNC_EDGE=none`
   und vertraut weitergeleiteten Adressen nur aus
   `OBSYNC_TRUSTED_PROXY_CIDRS`, dem eigenen Bereich des Terminators.
7. **Optional mit Gateway filtern.** Eine Gateway-Netzwerkrichtlinie kann nur
   deinen registrierten Geräten den Zugriff auf Adresse und Port des Servers
   erlauben und alles andere auf dieser Route blockieren.
8. **Von einem Gerät außerhalb deines Netzes prüfen.** Öffne die Server-URL
   im Browser dieses Geräts und erwarte die Anmeldeseite des Dashboards.
   Wähle im Plugin **Check** unter **Connection**: Ein einziger Roundtrip
   beweist Adresse, Zertifikat und Zugangsdaten zusammen.

Abwägungen:

- Jedes synchronisierende Gerät führt den Cloudflare One Client aus, und der
  Client muss verbunden sein, bevor Sync von unterwegs funktioniert.
- Cloudflare befördert den Verkehr zwischen dem Gerät und dem
  Tunnel-Connector. Lass die TLS-Entschlüsselung von Gateway ausgeschaltet;
  der Verkehr ist dann jenseits von Adressen, Größen und Zeitpunkten
  undurchsichtig, was das [Bedrohungsmodell](../threat-model.md) jedem
  Netzwerkpfad ohnehin zugesteht.
- Der Connector ist ein Prozess in deinem Netz, der eine ausgehende
  Verbindung zu Cloudflare offen hält. Ist er weg, zeigen mobile Geräte
  `obsync: offline`, während das LAN weiterarbeitet.

## Variante B: ein öffentlicher Hostname hinter Access

Der Server bekommt einen Hostnamen in einer Domain, die du bei Cloudflare
hast. Der Tunnel veröffentlicht diesen Hostnamen auf die private Adresse des
Servers, und Cloudflare Access sitzt davor: eine Identitätsrichtlinie für das
Dashboard und ein Service-Token für die API-Aufrufe des Plugins. Das ist die
Variante, die [Platform-Onboarding](../platform-onboarding.md) für den
Referenz-Cluster beschreibt, und die, die die Referenzinstallation nicht
gewählt hat.

1. **Den Hostnamen veröffentlichen.** Füge in der Konfiguration des Tunnels
   eine Route für eine veröffentlichte Anwendung von deinem Hostnamen
   (`sync.example.com` steht für deinen eigenen) auf die private HTTP-Adresse
   des Servers, Port 8080, hinzu. Cloudflare legt den DNS-Eintrag an.
2. **Access davorsetzen.** Gehe zu **Zero Trust** > **Access controls** >
   **Applications**, lege eine **Self-hosted**-Anwendung auf diesem Hostnamen
   an und füge eine Identitätsrichtlinie hinzu, die nur dich erlaubt, etwa
   eine Einmal-PIN an deine eigene Adresse, für das Dashboard.
3. **Ein Service-Token für das Plugin anlegen.** Gehe zu **Zero Trust** >
   **Access controls** > **Service credentials** > **Service Tokens**, lege
   eines an und kopiere Client ID und Client Secret; das Secret wird nur
   einmal angezeigt. Füge der Anwendung eine **Service Auth**-Richtlinie
   hinzu, die dieses Token einschließt, für die Pfade, die das Plugin nutzt
   (`/v1/*`).
4. **Das Token ins Plugin einfügen.** Unter **Edge service-token headers**,
   eines pro Zeile, genau so, wie Cloudflare sie nennt:

   ```text
   CF-Access-Client-Id: <the client id>
   CF-Access-Client-Secret: <the client secret>
   ```

   Sie reisen mit jeder Anfrage an die Server-URL mit, und mit nichts sonst.
5. **Dem Server sagen, dass er hinter der Edge steht.** Starte ihn mit
   `OBSYNC_EDGE=cloudflare`. In diesem Modus muss jede Anfrage die Header der
   Edge für die verbindende Adresse und die Request-ID tragen, und eine
   Anfrage, die an der Edge vorbei ankommt, wird mit `421 edge_required`
   abgewiesen ([Fehlersuche](../troubleshooting.md#edge_required)).
6. **Prüfen.** Öffne den Hostnamen im Browser und erwarte die
   Access-Anmeldung, dann das Dashboard. Wähle im Plugin **Check** unter
   **Connection**.

Abwägungen:

- Der Hostname ist öffentlich. Access weist Fremde ab, und der Server
  authentifiziert weiterhin jede Geräteanfrage selbst, aber der Name existiert
  und ist auffindbar.
- Das Service-Token ist ein Zugangsdatum. Wer es hat, erreicht die Vordertür
  der API; die eigene Geräteauthentifizierung des Servers steht weiterhin
  dahinter. Rotiere es in Cloudflare, falls es je offengelegt wird.
- Große Übertragungen laufen zu den oben genannten Bedingungen durch
  Cloudflare. Mach die große Erstsynchronisation im LAN.
- Die Header der Edge für die verbindende Adresse und das Land sind das, was
  die Geräteseite des Dashboards in diesem Modus als Adresse und Land zeigt.

## Was nachgewiesen ist

Die private Route ist die Route der Referenzinstallation. Der
[Lauf vom 2026-09-14](../validation-runs/2026-09-14.md) hält fest, dass sie an
diesem Tag nicht geprüft wurde, und warum; der
[Lauf vom 2026-09-20](../validation-runs/2026-09-20.md) hält einen Gerätelauf
auf der Referenzroute fest, bei dem die Verbindungs- und TLS-Prüfungen
bestanden wurden. Die Variante mit öffentlichem Hostnamen wurde von keinem
aufgezeichneten Lauf geprüft.

## Weiter

- [Server betreiben](../server.md): der Terminator, die Volumes, das
  Setup-Token.
- [Kubernetes](https://github.com/snaraj/obsync/blob/main/chart/README.md): das Chart, das die Referenzinstallation
  nutzt.
- [Platform-Onboarding](../platform-onboarding.md): was der Referenz-Cluster
  für einen veröffentlichten Hostnamen ergänzen würde.
- [Fehlersuche](../troubleshooting.md): `edge_required`, `offline` und das
  Zertifikat.
