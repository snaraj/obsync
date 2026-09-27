> Questa traduzione segue [l'originale in inglese](../../README.md). Il testo inglese è quello canonico; comandi, opzioni, URL e segnaposto restano invariati.

<img src="../../brand/obsync-icon-256.png" alt="icona obsync: due anelli intrecciati" width="96" height="96">

# Self Hosted Private Sync

Sincronizzazione in tempo reale, ospitata da te e cifrata end-to-end, per
[Obsidian](https://obsidian.md). Le tue note si sincronizzano attraverso un
server che gestisci tu. Note, allegati e nomi dei file vengono cifrati sul tuo
dispositivo, e il server non riceve mai la chiave. Il plugin funziona su ogni
piattaforma su cui gira Obsidian, desktop e mobile. Nessun abbonamento e
nessun account altrove.

**Qualcosa non funziona? → [Risoluzione dei problemi](https://snaraj.github.io/obsync/troubleshooting/)**

## Trova quello che ti serve

Ogni pagina è anche sul [sito della documentazione](https://snaraj.github.io/obsync/).
Le pagine collegate sono in inglese.

### Usare obsync

| Voglio… | Vai a |
| --- | --- |
| Scegliere come i miei dispositivi raggiungono il mio server | [Scegli la tua configurazione](../setup.md) |
| Configurare tutto sulla mia rete di casa, con ogni schermata del telefono | [Stessa rete, passo per passo](../same-network.md) |
| Installare il plugin | [Installare il plugin](../community-plugin.md) |
| Configurare il mio primo dispositivo | [Avvio rapido](../quickstart.md) |
| Abbinare un telefono o un altro computer | [Abbina il telefono](../quickstart.md#pair-your-phone) |
| Sapere che cosa significano l'icona di stato e i comandi | [Uso quotidiano](../daily-use.md) e [Leggere la barra di stato](../troubleshooting.md#reading-the-status-bar) |
| Recuperare una versione precedente di una nota | [Ripristinare una versione conservata](../daily-use.md#restore-a-retained-version) |
| Sapere che cosa fa un'impostazione | [Impostazioni](../settings.md) |
| Gestire una copia di conflitto | [Conflitti](../conflicts.md) |
| Risolvere un problema | [Risoluzione dei problemi](../troubleshooting.md) |
| Rientrare dopo aver perso un dispositivo | [Recupero](../recovery.md) |
| Spostare il mio vault su un altro server | [Spostare questo vault su un altro server](../recovery.md#moving-this-vault-to-a-different-server) |

### Gestire un server

| Voglio… | Vai a |
| --- | --- |
| Avviare il mio server con Docker o Compose | [Avviare il server](../server.md) |
| Metterlo dietro il mio proxy (Caddy, nginx, Traefik, HAProxy) | [Hai già un terminatore TLS](../server.md#already-have-a-tls-terminator-docker) |
| Avviarlo senza container, con systemd | [Il binario statico](../server.md#without-a-container-the-static-binary) |
| Avviare il mio server su Kubernetes | [Kubernetes](../kubernetes.md) e il [riferimento del chart](../../chart/README.md) |
| Raggiungere il mio server fuori casa, con la mia VPN o il mio proxy | [Raggiungerlo da fuori della tua LAN](../server.md#reaching-it-from-outside-your-lan) |
| Usare Cloudflare (facoltativo) | [Cloudflare](cloudflare.md) |
| Fidarmi del certificato del mio server su ogni dispositivo | [Fidarsi dell'autorità di certificazione](../server.md#trust-the-certificate-authority-once-per-device) |
| Sapere quanta memoria e quanto disco gli servono | [Quanta memoria serve](../server.md#how-much-memory-it-needs) e [Archiviazione](../storage.md) |
| Fare il backup del mio server | [Fare il backup dei due volumi](../server.md#back-up-the-two-volumes) |
| Aggiornare il mio server | [Aggiornare per digest](../server.md#upgrade-by-digest) |
| Vedere i miei dispositivi e revocarne uno | [La dashboard](../dashboard.md) |
| Azzerare il mio server e ricominciare | [Svuotare un server](../purge.md) |
| Vedere che cosa è cambiato in ogni versione | [`CHANGELOG.md`](../../CHANGELOG.md) |

### Fiducia e privacy

| Voglio… | Vai a |
| --- | --- |
| Sapere a che cosa accede questo plugin sul mio dispositivo e sulla mia rete | [A che cosa accede questo plugin](#a-che-cosa-accede-questo-plugin) |
| Capire che cosa è cifrato e che cosa può vedere il server | [Modello delle minacce](../threat-model.md) e [il modello delle minacce della dashboard](../security/dashboard.md) |
| Segnalare un problema di sicurezza | [`SECURITY.md`](../../SECURITY.md) |

### Dentro il progetto

Per chi contribuisce e chi revisiona: [`CONTRIBUTING.md`](../../CONTRIBUTING.md),
[architettura](../architecture.md), [protocollo](../protocol.md),
[benchmark](../benchmarks.md),
[sessioni di validazione sui dispositivi](../validation-runs/) e
[tutte le pagine](../README.md).

## Installare

![Le impostazioni del plugin si aprono con Get started: la riga Setup guide e il suo pulsante Open the guide, sopra il campo Server URL](../assets/settings-get-started.png)

Installa il plugin da **Impostazioni → Plugin di terze parti → Sfoglia**.
Cerca **Self Hosted Private Sync** (id del plugin `obsync-private-sync`).
Serve Obsidian 1.13.0 o successivo. Le sue impostazioni si aprono con la guida
alla configurazione, a un clic di distanza.

> [!IMPORTANT]
> - Sincronizza con un server che gestisci **tu**: nessun servizio ospitato, nessun account altrove.
> - Fai prima un backup del tuo vault; tieni la frase di recupero di 24 parole fuori dal dispositivo che l'ha generata.
> - Non usarlo mai accanto a un'altra sincronizzazione (Obsidian Sync, una cartella cloud, un altro plugin) sullo stesso vault.
> - Software giovane: leggi la voce del [`CHANGELOG.md`](../../CHANGELOG.md) per la tua versione, aggiorna ogni dispositivo e sappi che cosa ha coperto ogni [sessione di validazione](../validation-runs/).

## Iniziare a sincronizzare

Il percorso completo più breve è Compose con Caddy sulla tua rete, da una
copia locale di questo repository. Ti dà HTTPS su qualsiasi rete, senza
dominio e senza account da nessuna parte.
[Stessa rete, passo per passo](../same-network.md) lo percorre con ogni
schermata. Sostituisci qui sotto `vX.Y.Z` con la release che stai
installando, cioè il tag più recente nella
[pagina delle Releases](https://github.com/snaraj/obsync/releases/latest).

**1. Verifica l'immagine.** Poi esegui esattamente il digest che il comando ha
stampato:

```sh
cosign verify ghcr.io/snaraj/obsync:vX.Y.Z \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**2. Avvia il server:**

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` è il nome che i tuoi dispositivi digiteranno. Deve risolversi
solo sulla tua rete. `OBSYNC_BIND_ADDRESS` è l'indirizzo su cui sono
pubblicate le porte 80 e 443: un indirizzo di bind limita l'interfaccia di
destinazione, non la sorgente, quindi è il tuo firewall a decidere chi lo
raggiunge. Compose si rifiuta di partire finché non hai scelto.

**3. Leggi il token di configurazione.** Al primo avvio il server genera un
token di configurazione e lo scrive sul suo volume journal, con permessi 0600,
senza mai registrarlo nei log. Crea il tuo account una volta sola e resta
l'accesso di recupero alla dashboard. Custodiscilo come la frase di recupero:

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

**4. Configura ogni dispositivo.** Fidati del certificato del server, una
volta sola ([come](../server.md#trust-the-certificate-authority-once-per-device)).
Installa il plugin, poi segui l'[avvio rapido](../quickstart.md): configura
il primo dispositivo, poi abbina gli altri.

Hai già HTTPS davanti, con un proxy o un tunnel di cui ti fidi? Avvia invece
il [server da solo](../server.md#already-have-a-tls-terminator-docker).

## A che cosa accede questo plugin

- **Il tuo server, e nient'altro.** Ogni richiesta va all'indirizzo **Server URL** che digiti; niente telemetria, nessuna terza parte.
- **Un account su quel server**, creato dal token di configurazione; il tuo account Obsidian non c'entra nulla.
- **Le GitHub Releases, tramite Obsidian**, per installazione e aggiornamento; Obsidian ignora gli asset di release in più.
- **L'elenco dei file del tuo vault**, per decidere che cosa sincronizzare; le cartelle nascoste (`.obsidian`, `.git`) e quelle che sono collegamenti simbolici vengono saltate.
- **Gli appunti, solo in scrittura**, da **Copy code** e **Copy link** in **Pair a new device**; mai letti.
- **Il tuo browser, quando chiedi la guida alla configurazione.** Lì si apre la guida del progetto; il plugin in sé non invia nulla.

Che cosa il server può vedere e che cosa no: [`SECURITY.md`](../../SECURITY.md) e il [modello delle minacce](../threat-model.md).

## Versioni

La release LATEST è il tag più recente nella
[pagina delle Releases](https://github.com/snaraj/obsync/releases/latest). È
quella che Obsidian installa e a cui si aggiorna. `main` è EDGE: lavoro già
unito ma non ancora rilasciato, per chi compila dal sorgente. Non c'è un
canale beta né un tag di pre-release. La sezione «Unreleased» del changelog
tiene traccia di EDGE.

## Domande, bug e sicurezza

- **Una domanda, o qualcosa di cui non sei sicuro che sia un bug:** [Discussions](https://github.com/snaraj/obsync/discussions).
- **Un bug:** [apri una issue](https://github.com/snaraj/obsync/issues/new/choose) con la segnalazione descritta in [Risoluzione dei problemi](../troubleshooting.md#how-to-collect-a-report). Lascia fuori qualsiasi token, frase o indirizzo che non pubblicheresti.
- **Una sospetta vulnerabilità:** in privato, tramite [`SECURITY.md`](../../SECURITY.md), mai come issue pubblica.

## Licenza

MIT. Vedi [`LICENSE`](../../LICENSE).
