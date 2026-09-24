> Questa traduzione segue [l'originale in inglese](../../README.md). Il testo inglese è quello canonico; comandi, opzioni, URL e segnaposto restano invariati.

<img src="../../brand/obsync-icon-256.png" alt="icona obsync: due anelli intrecciati" width="96" height="96">

# Self Hosted Private Sync

Sincronizzazione in tempo reale, cifrata end-to-end e ospitata da te, per
[Obsidian](https://obsidian.md): un server Rust senza dipendenze con una
dashboard integrata, che gestisci tu, più questo plugin. File di qualsiasi
dimensione, tutte le piattaforme Obsidian, nessun abbonamento, nessuna terza
parte.

Installalo da Impostazioni → Plugin di terze parti → Sfoglia cercando
**Self Hosted Private Sync** (id del plugin `obsync-private-sync`), su Obsidian
1.13.0 o successivo.

**Nuovo qui? Inizia dalla [guida all’installazione](https://snaraj.github.io/obsync/setup/) (in inglese).** Ti aiuta a scegliere come i tuoi dispositivi raggiungono il server e spiega ogni opzione passo per passo. In Obsidian: Impostazioni → Self Hosted Private Sync → Setup guide.

> [!IMPORTANT]
> - Sincronizza con un server che gestisci **tu**: nessun servizio ospitato, nessun account altrove.
> - Fai prima un backup del tuo vault; tieni la frase di recupero di 24 parole fuori dal dispositivo che l'ha generata.
> - Non usarlo mai accanto a un'altra sincronizzazione (Obsidian Sync, una cartella cloud, un altro plugin) sullo stesso vault.
> - Software giovane: leggi la voce del [`CHANGELOG.md`](../../CHANGELOG.md) per la tua versione, aggiorna ogni dispositivo e sappi che cosa ha coperto ogni [sessione di validazione](../validation-runs/).

## A che cosa accede questo plugin

- **Il tuo server, e nient'altro.** Ogni richiesta va all'indirizzo **Server URL** che digiti; niente telemetria, nessuna terza parte.
- **Un account su quel server**, creato dal token di configurazione; il tuo account Obsidian non c'entra nulla.
- **Le GitHub Releases, tramite Obsidian**, per installazione e aggiornamento; Obsidian ignora gli asset di release in più.
- **L'elenco dei file del tuo vault**, per decidere che cosa sincronizzare; le cartelle nascoste (`.obsidian`, `.git`) e quelle che sono collegamenti simbolici vengono saltate.
- **Gli appunti, solo scritti** da **Copy code** e **Copy link** in **Pair a new device**, mai letti.

Che cosa il server può vedere e che cosa no: [`SECURITY.md`](../../SECURITY.md)
e il [modello delle minacce](../threat-model.md).

## Iniziare a sincronizzare

Cinque passi da zero a due dispositivi sincroni. `v1.0.6` è la release per cui è
stata scritta questa pagina; usa il tag che stai installando.

### 1. Avviare il server

Verifica la firma, poi esegui esattamente il digest che ha stampato:

```sh
cosign verify ghcr.io/snaraj/obsync:v1.0.6 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Il percorso più semplice è Compose con Caddy, da una copia locale di questo
repository: HTTPS su qualsiasi rete, senza dominio e senza account presso
nessuno.

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` è il nome che i tuoi dispositivi digiteranno; deve risolversi solo
sulla tua rete. `OBSYNC_BIND_ADDRESS` è l'indirizzo su cui sono pubblicate le
porte 80 e 443: un indirizzo di bind limita l'interfaccia di destinazione, non
la sorgente, quindi è il tuo firewall a decidere chi lo raggiunge. Compose si
rifiuta di partire finché non hai scelto.

Hai già HTTPS davanti, con un proxy o un tunnel di cui ti fidi? Avvia invece il
server da solo: [Avviare il server](../server.md).

### 2. Leggere il token di configurazione

Al primo avvio il server conia un token di configurazione e lo scrive sul suo
volume journal, con permessi 0600, senza mai registrarlo nei log. Crea il tuo
account una volta sola e resta l'accesso di recupero alla dashboard:
custodiscilo con la stessa cura della frase di recupero. Leggilo dal container:

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

### 3. Fidarsi del certificato, una volta per dispositivo

Caddy firma con un'autorità che ha generato al primo avvio; ogni dispositivo
deve fidarsene una volta. Esporta il certificato radice e installalo su ciascuna
piattaforma come mostra
[Avviare il server](../server.md#trust-the-certificate-authority-once-per-device);
su iOS, fidarsi del certificato è un secondo interruttore dopo l'installazione.

### 4. Configurare il primo dispositivo

1. Impostazioni → Plugin di terze parti → Sfoglia → **Self Hosted Private
   Sync** → Installa → Abilita.
2. Imposta **Server URL** sul tuo server (`https://sync.example.org`, porta
   compresa quando non è la 443), poi scegli **Whole vault** oppure **Selected
   folders only**; in seguito la selezione può solo restringersi.

   ![La scheda delle impostazioni del plugin: il campo Server URL con un nome host di esempio, il riquadro per le intestazioni edge e la riga Connection con i suoi pulsanti Check e Open dashboard](../assets/settings-server.png)

3. Incolla il token di configurazione sotto **First-time setup**, scegli
   **Set up** e scrivi la frase di recupero di 24 parole.

   ![La sezione This device della scheda delle impostazioni: la riga Pairing con Pair this device e Pair a new device, la riga First-time setup con il campo Setup token e il pulsante Set up, e la riga Vault key](../assets/settings-setup.png)

### 5. Abbinare il secondo dispositivo

1. Installa lì il plugin con lo stesso **Server URL**; sul primo dispositivo
   esegui **Pair a new device** per ottenere un codice valido dieci minuti.

   ![La finestra Pair a new device sul primo dispositivo, con il suo codice oscurato, i pulsanti Copy code e Copy link e la riga Waiting for the new device](../assets/pair-new-device.png)

2. Sul secondo dispositivo apri **Pair this device**, incolla il codice e scegli
   **Pair**.
3. Torna sul primo dispositivo e approvalo per nome. Modifica una nota su uno
   dei due; compare sull'altro nel giro di secondi.

   ![Il primo dispositivo chiede se approvare il nuovo dispositivo per nome, con i pulsanti Approve e Reject](../assets/pair-approve.png)

![Animazione: il codice di abbinamento mostrato sul primo dispositivo, incollato sul secondo, approvato sul primo, e la prima nota che arriva sul secondo](../assets/pairing.gif)

Lo provi su un solo computer? Su un computer `http://127.0.0.1:8080` raggiunge
il server da solo; Obsidian su iOS e Android rifiuta l'HTTP in chiaro.

Le schermate da telefono non sono ancora in questo repository; vengono prese
sui dispositivi personali del manutentore e aggiunte quando una sessione di
validazione le registra.

Ogni passo per esteso: [Avvio rapido](../quickstart.md).

## Avanzato: Cloudflare

L'installazione di riferimento non ha alcun nome host pubblico: un Cloudflare
Tunnel e una rotta privata raggiungono la rete del server, e il client
Cloudflare One di ogni dispositivo ci porta l'URL del server. Funziona anche un
nome host pubblico dietro Cloudflare Access, con un token di servizio in **Edge
service-token headers** e `OBSYNC_EDGE=cloudflare`. Entrambe, passo per passo:
[Cloudflare](cloudflare.md).

## Altri modi per raggiungere il tuo server

Qualunque cosa tu scelga, il plugin ha bisogno di HTTPS con un certificato di
cui ogni dispositivo si fida; il server resta su HTTP in chiaro dietro quel
terminatore.

- **Solo LAN.** Il percorso Compose qui sopra, raggiungibile solo da casa; nessuna sincronizzazione fuori casa.
- **WireGuard.** La tua VPN verso casa: la più veloce e del tutto tua; una configurazione peer su ogni dispositivo.
- **Tailscale.** Una mesh WireGuard gestita: il minimo di configurazione; una terza parte la coordina, alle condizioni del suo piano.
- **Un reverse proxy con TLS automatico**, per esempio Caddy su un nome pubblico: raggiungibile da internet, e gli aggiornamenti tocca a te.
- **Cloudflare Tunnel.** Qui sopra. Nessuna porta in ingresso; un provider sul percorso, con le sue condizioni.

Che cosa serve a un dispositivo in mobilità (la rotta, il nome, il certificato,
il firewall, la richiesta iOS per la rete locale):
[Raggiungerlo da fuori della tua LAN](../server.md#reaching-it-from-outside-your-lan).

## Risoluzione dei problemi

| Sintomo | Causa probabile | Prima cosa da provare |
| --- | --- | --- |
| `obsync: offline` | Il dispositivo non raggiunge l'URL del server | Apri l'URL in un browser sullo stesso dispositivo; controlla la porta, HTTPS e la rotta |
| Un telefono non si connette mentre un computer sincronizza | Il certificato privato non è considerato attendibile sul telefono | Installa il certificato radice; su iOS attivalo anche in «Impostazioni attendibilità certificati» |
| `401 stale_timestamp` | Un orologio sbaglia di più di 300 secondi | Attiva l'ora automatica, sul dispositivo o sul server |
| `403 device_pending` | Nessuno ha ancora approvato il dispositivo | Approvalo per nome sul dispositivo da cui hai fatto l'abbinamento |
| Un file non arriva mai | È fuori dalla selezione di cartelle, o sopra il limite di dimensione di un telefono | Controlla **Sync folders on this device**; sul telefono esegui **Show remote-only files** |

Ogni altro sintomo e codice di errore, e come segnalarlo:
[Risoluzione dei problemi](../troubleshooting.md).

## Documentazione

[Avvio rapido](../quickstart.md) · [Avviare il server](../server.md) ·
[Cloudflare](cloudflare.md) · [Uso quotidiano](../daily-use.md) ·
[Impostazioni](../settings.md) · [Risoluzione dei problemi](../troubleshooting.md) ·
[Recupero](../recovery.md) · [Changelog](../../CHANGELOG.md)

Tutto il resto: [docs/README.md](../README.md).

## Domande, bug e sicurezza

- **Una domanda, o qualcosa di cui non sei sicuro che sia un bug:** [Discussions](https://github.com/snaraj/obsync/discussions).
- **Un bug:** [apri una issue](https://github.com/snaraj/obsync/issues/new/choose) con la segnalazione descritta in [Risoluzione dei problemi](../troubleshooting.md); senza token, senza frase di recupero e senza alcun indirizzo che non pubblicheresti.
- **Una sospetta vulnerabilità:** in privato, tramite [`SECURITY.md`](../../SECURITY.md), mai come issue pubblica.

## Licenza

MIT. Vedi [`LICENSE`](../../LICENSE).
