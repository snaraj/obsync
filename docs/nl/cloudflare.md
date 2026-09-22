> Deze vertaling volgt het [Engelse origineel](../cloudflare.md). De Engelse tekst is leidend; opdrachten, opties, URL's en plaatshouders blijven ongewijzigd.

# Cloudflare

Twee manieren om Cloudflare tussen je apparaten en je server te zetten, en
welke daarvan de referentie-installatie gebruikt. Geen van beide is verplicht:
de server kent geen enkele aanbieder bij naam, en
[De server draaien](../server.md) heeft bij niemand een account nodig. Deze
pagina is voor jou als je de server buitenshuis wilt bereiken zonder een poort
op je router open te zetten, of als je een gepubliceerde hostnaam met een
toegangsbeleid ervoor wilt.

De menu's van Cloudflare en de voorwaarden van de abonnementen veranderen.
Elke stap hieronder noemt het menupad zoals de Cloudflare-documentatie het op
2026-09-22 gaf; controleer de actuele pagina voordat je op een limiet of een
prijs vertrouwt.

## Welke variant

| Variant | Wat apparaten zien | Wat het internet ziet | Grote eerste synchronisatie |
| --- | --- | --- | --- |
| **Privéroute** (de referentie-installatie) | je eigen privéadres en naam, via de Cloudflare One-client | niets: geen hostnaam, geen open poort | privénetwerkverkeer, niet via een publieke hostnaam geleid |
| **Publieke hostnaam met Access** | een publieke naam, een Access-beleid, een servicetoken in de plugin | de hostnaam, achter Access | via Cloudflare geleid, onder de voorwaarden van de aanbieder voor grote bestanden |

De privéroute is de referentie omdat de server onzichtbaar blijft en omdat
Cloudflares eigen documentatie grote overdrachten die kant op stuurt: een
route via een publieke hostnaam leidt het verkeer door Cloudflare, en op de
abonnementen Free, Pro en Business vereisen de dienstspecifieke voorwaarden
een betaalde dienst voor video en andere grote bestanden, terwijl een
privénetwerkroute ze als je eigen verkeer vervoert. Doe de grote eerste
synchronisatie in beide varianten op het LAN.

Wat TLS ook beëindigt, het leest je inloggegevens en nooit je notities: elk
blok en elk manifest wordt op het apparaat versleuteld, en geen sleutel die ze
ontsleutelt gaat over de lijn ([dreigingsmodel](../threat-model.md)). Op de
privéroute is de terminator van jou, binnen je eigen netwerk. Bij de publieke
hostnaam is de edge ook een terminator.

## Variant A: een privéroute en de Cloudflare One-client

De server houdt een privéadres in je eigen netwerk. Ernaast draait een
tunnelconnector, een route vertelt Cloudflare welke adressen achter die tunnel
zitten, en de Cloudflare One-client (voorheen WARP) op elk apparaat vervoert
het verkeer voor die adressen door de tunnel. De server-URL die je apparaten
intypen is een privénaam die naar dat privéadres wijst.

Wat je nodig hebt: een Cloudflare-account met een Zero Trust-organisatie (een
"teamnaam"), een machine in het netwerk van de server die de tunnelconnector
kan draaien, en de Cloudflare One-client op elk apparaat dat buitenshuis gaat
synchroniseren.

1. **Maak een tunnel.** Ga in het Cloudflare-dashboard naar **Networking** >
   **Tunnels** en maak een `cloudflared`-tunnel. Draai de connector die je
   krijgt op een machine binnen het netwerk van de server: in het cluster
   naast de server, of op dezelfde host.
2. **Leid het privéadres van de server door de tunnel.** Ga naar
   **Networking** > **Routes**, kies **Create route** > **Tunnel CIDR**, kies
   de tunnel en vul het privéadres of het subnet van de server in. Eén adres
   is genoeg; een subnet kan later worden verbreed.
3. **Meld elk apparaat aan.** Installeer de Cloudflare One-client, vul je
   teamnaam in, doorloop de aanmelding die je organisatie vereist en zet de
   verbinding aan. Op iOS en Android vraagt de client om een VPN-profiel te
   installeren; sta dat toe. Stel de aanmeldrechten voor apparaten zo in dat
   alleen je eigen identiteit apparaten kan aanmelden.
4. **Stuur het privébereik door de client.** Zorg er in de Split
   Tunnels-configuratie van de client voor dat het adres uit stap 2 door de
   client wordt geleid. In de modus **Exclude** verwijder je het
   RFC 1918-blok dat het bevat en voeg je de bereiken die je wél wilt
   uitsluiten opnieuw toe; in de modus **Include** voeg je het adres of het
   subnet toe.
5. **Laat de naam op het apparaat oplossen.** De plugin stuurt elk verzoek
   naar de server-URL die je hebt ingetypt, dus die naam moet op het
   onderweg gebruikte apparaat oplossen: een hostnaamroute, Local Domain
   Fallback naar je eigen resolver, of een privé-DNS-vermelding. Een naam die
   oplost naar een adres dat de client niet routeert, faalt precies zoals een
   server die offline is.
6. **Beëindig TLS zelf.** De route brengt je verkeer naar je eigen
   terminator: een ingress of reverse proxy vóór de server met een
   certificaat dat elk apparaat vertrouwt, zoals in
   [De server draaien](../server.md). De server draait met
   `OBSYNC_EDGE=none` en vertrouwt doorgestuurde adressen alleen uit
   `OBSYNC_TRUSTED_PROXY_CIDRS`, het eigen bereik van de terminator.
7. **Filter eventueel met Gateway.** Een Gateway-netwerkbeleid kan alleen je
   aangemelde apparaten toegang geven tot het adres en de poort van de
   server, en al het andere op die route blokkeren.
8. **Controleer vanaf een apparaat buiten je netwerk.** Open de server-URL in
   een browser op dat apparaat en verwacht de aanmeldpagina van het
   dashboard. Kies in de plugin **Check** onder **Connection**: één
   rondreis bewijst adres, certificaat en inloggegeven tegelijk.

Afwegingen:

- Elk synchroniserend apparaat draait de Cloudflare One-client, en de client
  moet verbonden zijn voordat synchronisatie buitenshuis werkt.
- Cloudflare vervoert het verkeer tussen het apparaat en de tunnelconnector.
  Laat de TLS-ontsleuteling van Gateway uit; het verkeer is dan voor
  Cloudflare ondoorzichtig, afgezien van adressen, groottes en tijdstippen,
  wat het [dreigingsmodel](../threat-model.md) aan elk netwerkpad toch al
  toestaat.
- De connector is een proces in je netwerk dat een uitgaande verbinding naar
  Cloudflare openhoudt. Valt hij weg, dan tonen apparaten onderweg
  `obsync: offline` terwijl het LAN gewoon doorwerkt.

## Variant B: een publieke hostnaam achter Access

De server krijgt een hostnaam op een domein dat je bij Cloudflare hebt. De
tunnel publiceert die hostnaam naar het privéadres van de server, en
Cloudflare Access staat ervoor: een identiteitsbeleid voor het dashboard en
een servicetoken voor de API-aanroepen van de plugin. Dit is de variant die
[platform-onboarding](../platform-onboarding.md) beschrijft voor het
referentiecluster, en de variant die de referentie-installatie niet heeft
gekozen.

1. **Publiceer de hostnaam.** Voeg in de configuratie van de tunnel een route
   voor een gepubliceerde applicatie toe van je hostnaam (`sync.example.com`
   staat voor die van jou) naar het privé-HTTP-adres van de server, poort
   8080. Cloudflare maakt het DNS-record aan.
2. **Zet Access ervoor.** Ga naar **Zero Trust** > **Access controls** >
   **Applications**, maak een **Self-hosted**-applicatie op die hostnaam en
   voeg een identiteitsbeleid toe dat alleen jou toelaat, bijvoorbeeld een
   eenmalige pincode naar je eigen adres, voor het dashboard.
3. **Maak een servicetoken voor de plugin.** Ga naar **Zero Trust** >
   **Access controls** > **Service credentials** > **Service Tokens**, maak er
   een en kopieer de Client ID en het Client Secret; het geheim wordt maar één
   keer getoond. Voeg aan de applicatie een **Service Auth**-beleid toe dat
   dit token bevat, voor de paden die de plugin gebruikt (`/v1/*`).
4. **Plak het token in de plugin.** Onder **Edge service-token headers**, één
   per regel, precies zoals Cloudflare ze noemt:

   ```text
   CF-Access-Client-Id: <the client id>
   CF-Access-Client-Secret: <the client secret>
   ```

   Ze reizen mee met elk verzoek naar de server-URL, en met niets anders.
5. **Vertel de server dat hij achter de edge staat.** Draai hem met
   `OBSYNC_EDGE=cloudflare`. In die modus moet elk verzoek de edge-headers
   met het verbindende adres en de request-ID dragen, en een verzoek dat om
   de edge heen binnenkomt wordt geweigerd met `421 edge_required`
   ([probleemoplossing](../troubleshooting.md#edge_required)).
6. **Controleer.** Open de hostnaam in een browser en verwacht de
   Access-aanmelding, daarna het dashboard. Kies in de plugin **Check** onder
   **Connection**.

Afwegingen:

- De hostnaam is publiek. Access weigert vreemden, en de server
  authenticeert nog steeds zelf elk apparaatverzoek, maar de naam bestaat en
  is vindbaar.
- Het servicetoken is een inloggegeven. Wie het heeft, komt bij de voordeur
  van de API; de eigen apparaatauthenticatie van de server staat daar nog
  achter. Roteer het in Cloudflare als het ooit uitlekt.
- Grote overdrachten gaan via Cloudflare onder de bovenstaande voorwaarden.
  Doe de grote eerste synchronisatie op het LAN.
- De edge-headers met het verbindende adres en het land zijn wat de pagina
  Apparaten van het dashboard in deze modus als adres en land toont.

## Wat is aangetoond

De privéroute is de route van de referentie-installatie. De
[run van 2026-09-14](../validation-runs/2026-09-14.md) legt vast dat hij die
dag niet is beproefd, en waarom; de
[run van 2026-09-20](../validation-runs/2026-09-20.md) legt een apparatenrun
op de referentieroute vast waarbij de verbindings- en TLS-controles slaagden.
De variant met publieke hostnaam is door geen enkele vastgelegde run beproefd.

## Verder

- [De server draaien](../server.md): de terminator, de volumes, het
  setup-token.
- [Kubernetes](https://github.com/snaraj/obsync/blob/main/chart/README.md): de chart die de referentie-installatie
  gebruikt.
- [Platform-onboarding](../platform-onboarding.md): wat het referentiecluster
  zou toevoegen voor een gepubliceerde hostnaam.
- [Probleemoplossing](../troubleshooting.md): `edge_required`, `offline` en
  het certificaat.
