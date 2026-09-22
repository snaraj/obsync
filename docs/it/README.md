> Questa traduzione segue [l'originale in inglese](../../README.md). Il testo inglese è quello canonico; comandi, opzioni, URL e segnaposto restano invariati.

# Self Hosted Private Sync

Sincronizzazione in tempo reale, cifrata end-to-end e ospitata da te, per
[Obsidian](https://obsidian.md): un server Rust senza dipendenze con una
dashboard integrata, che gestisci tu, più questo plugin. File di qualsiasi
dimensione, tutte le piattaforme Obsidian, nessun abbonamento, nessuna terza
parte.

Installalo da Impostazioni → Plugin di terze parti → Sfoglia cercando
**Self Hosted Private Sync** (id del plugin `obsync-private-sync`), su Obsidian
1.13.0 o successivo.

> [!IMPORTANT]
> Questo plugin sincronizza con un server che gestisci **tu**. Non esiste alcun
> servizio ospitato e nessun account presso nessuno tranne te stesso: senza un
> tuo `obsyncd` raggiungibile via HTTPS, il plugin non ha nulla con cui
> sincronizzare.

> [!IMPORTANT]
> Fai un backup del tuo vault prima della prima sincronizzazione, e conserva la
> frase di recupero di 24 parole in un posto diverso dal dispositivo che l'ha
> generata. Il server conserva solo testo cifrato e non può recuperare un vault
> al posto tuo.

> [!IMPORTANT]
> Non usare questo plugin accanto a un'altra soluzione di sincronizzazione sullo
> stesso vault — Obsidian Sync, una cartella cloud che sincronizza file o un
> altro plugin di sincronizzazione. Due scrittori su uno stesso vault producono
> conflitti che nessuno dei due sa risolvere.

## Prima di affidarti a questo plugin

È software giovane, e sincronizza l'unica copia delle tue note.

- **[`CHANGELOG.md`](../../CHANGELOG.md) è l'elenco aggiornato di ciò che si
  sa.** Leggi la voce della versione che usi, e quelle sopra di essa. Le pagine
  delle release conservano le note con cui sono state pubblicate; le scoperte
  successive vengono aggiunte qui.
- **Aggiorna ogni dispositivo che sincronizza un vault.** Un solo dispositivo
  rimasto a una versione più vecchia può ancora agire secondo il vecchio
  comportamento e influenzare gli altri.
- **Ciò che è stato esercitato su hardware** è registrato sessione per sessione
  in [`docs/validation-runs/`](../validation-runs/), compreso ciò che ogni
  sessione non ha coperto. Una piattaforma che nessuna sessione nomina non è
  dimostrata.
- **Un flusso di avvisi «merged concurrent edits»** su due dispositivi che
  modificano la stessa nota: chiudi Obsidian su uno dei due perché l'altro possa
  smaltire il lavoro, aggiornali entrambi, poi riprendi.

## A che cosa accede questo plugin

Breve e completo, così puoi decidere prima di installarlo.

- **Una sola destinazione di rete: il tuo server.** Ogni richiesta va
  all'indirizzo **Server URL** che digiti nelle impostazioni del plugin, e a
  nient'altro. Non c'è telemetria, non ci sono analisi, non c'è alcun
  segnalatore di crash, nessuna pubblicità e nessun servizio di terze parti in
  nessun punto del percorso di sincronizzazione. Il plugin, inoltre, non scarica
  né esegue mai codice da quel server.
- **Un account su quel server, che crei tu.** Il primo dispositivo usa il token
  di configurazione che il tuo server ha scritto al primo avvio; ogni altro
  dispositivo viene abbinato da un dispositivo che già sincronizza. Il tuo
  account Obsidian non c'entra nulla.
- **Obsidian e GitHub, solo per installazione e aggiornamenti.** Obsidian stesso
  scarica `main.js`, `manifest.json` e `styles.css` dalle GitHub Releases di
  questo repository. Ogni release porta anche uno ZIP del plugin e un manifest
  di release per chi distribuisce il server; Obsidian li ignora entrambi.
- **Il tuo edge, solo se ne hai configurato uno.** Le intestazioni che incolli
  sotto **Edge service-token headers** viaggiano con ogni richiesta verso l'URL
  del server indicato sopra, perché il proxy che ne ha bisogno sta sul percorso
  verso il tuo server.
- **L'elenco dei file del tuo vault.** Il plugin elenca ogni file del vault per
  decidere che cosa rientra nell'ambito, legge i file dentro la tua selezione di
  cartelle e scrive ciò che gli altri dispositivi hanno cambiato. Le cartelle
  nascoste (`.obsidian`, `.git`) e quelle che sono collegamenti simbolici
  vengono saltate.
- **Gli appunti, solo scritti e mai letti.** Solo i pulsanti **Copy code** e
  **Copy link** in **Pair a new device** ci scrivono dentro. Nulla nel plugin
  legge gli appunti.
- **Il tuo browser, quando chiedi la dashboard.** **Open dashboard** apre un
  link di accesso nel tuo browser, e solo quando quel link sta sull'origine del
  tuo stesso server.
- **L'archivio segreto di Obsidian.** La chiave del vault, il segreto del
  dispositivo ed eventuali valori delle intestazioni edge stanno lì, mai nei
  dati in chiaro del plugin.

Che cosa il server può vedere e che cosa no sta in
[`SECURITY.md`](../../SECURITY.md) e
[`docs/threat-model.md`](../threat-model.md).

## Sincronizzati in cinque passi

Il percorso su cui questa release è stata validata, da un vault vuoto a due
dispositivi sincroni. Tutti e cinque i passi presuppongono che il tuo server sia
già in funzione, cosa di cui parla la sezione qui sotto; ogni passo è scritto
per esteso nella guida di avvio rapido.

1. **Installa dai plugin di terze parti.** In Impostazioni → Plugin di terze
   parti → Sfoglia, cerca **Self Hosted Private Sync**, scegli Installa e poi
   Abilita — come arriva ogni altro plugin di Obsidian, su ogni piattaforma.

   ![Il browser dei plugin di terze parti di Obsidian mostra Self Hosted Private Sync con il suo pulsante Installa](../captures/01-install-from-directory.png)

2. **Puntalo al tuo server e configuralo.** Apri la scheda delle impostazioni
   del plugin, imposta **Server URL** sul tuo server, scegli quali cartelle
   sincronizza questo dispositivo, poi incolla il tuo token di configurazione
   sotto **First-time setup**.

   ![La scheda delle impostazioni del plugin, scorsa fino alla selezione delle cartelle, alla riga Pairing e al campo del token sotto First-time setup](../captures/02-first-time-setup.png)

3. **Conserva la frase di recupero.** La configurazione genera la chiave del
   vault su questo dispositivo e mostra una volta sola una frase di 24 parole:
   scrivila e tienila in un posto diverso da questo dispositivo, perché il
   server conserva solo testo cifrato e non può recuperare un vault al posto
   tuo.

   ![La finestra con la frase di recupero mostrata dopo la prima configurazione, con le parole oscurate](../captures/03-recovery-phrase.png)

4. **Abbina un secondo dispositivo con un codice monouso.** Esegui **Pair a new
   device** sul primo dispositivo, inserisci entro dieci minuti sul secondo il
   codice che mostra e approva il dispositivo per nome — la chiave del vault
   viaggia cifrata sotto un segreto di abbinamento che il server non vede mai.

   ![La finestra Pair a new device sul primo dispositivo, con il suo codice monouso oscurato](../captures/04-pair-a-new-device.png)

5. **Modifica su uno dei due dispositivi e guardala arrivare.** Scrivi in una
   nota su un dispositivo e compare sull'altro nel giro di secondi, in entrambe
   le direzioni, con la barra di stato che mostra che cosa sta facendo la
   sincronizzazione.

   ![La nota usa e getta con le modifiche di entrambi i dispositivi, con la barra di stato della sincronizzazione visibile](../captures/05-sync-both-ways.png)

L'elenco dei dispositivi della dashboard e il suo pulsante di revoca sono
descritti in [Vedere i tuoi dispositivi](../daily-use.md#see-your-devices) e non
sono stati esercitati nella sessione con dispositivi per la 1.0.0 registrata in
[docs/validation-runs/2026-09-14.md](../validation-runs/2026-09-14.md).

## Iniziare a sincronizzare

Il percorso corretto più breve: una macchina tua esegue il server, ogni
dispositivo lo raggiunge via HTTPS e ogni dispositivo viene abbinato una volta.
L'accesso a Obsidian qui non autorizza nulla; l'unico account è quello sul tuo
server.

### 1. Avviare il server

Due modi per avviarlo. Entrambi eseguono esattamente i byte firmati da chi
pubblica: verifica la firma, leggi il digest dall'output verificato ed esegui
quel digest. `v1.0.6` è la release per cui è stata scritta questa pagina; usa il
tag della release che stai installando.

```sh
cosign verify ghcr.io/snaraj/obsync:v1.0.6 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**Ancora senza HTTPS?** `deploy/compose` avvia il server dietro il proprio
terminatore TLS (Caddy), su qualsiasi rete, senza dominio e senza account presso
nessuno. Da una copia locale di questo repository:

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` è il nome che i tuoi dispositivi digiteranno. Deve risolversi solo
sulla tua rete. `OBSYNC_BIND_ADDRESS` è l'indirizzo di questo host su cui sono
pubblicate le porte 80 e 443: un indirizzo di bind limita l'interfaccia di
destinazione, non la sorgente, quindi è il tuo firewall a decidere chi lo
raggiunge. Compose si rifiuta di partire finché non hai scelto. Entrambi sono
spiegati in [Avviare il server](../server.md).

**Hai già HTTPS davanti** alla macchina, con un reverse proxy o un tunnel di cui
ti fidi? Avvia il server da solo. Parla HTTP in chiaro sulla porta 8080, e il
tuo terminatore gli inoltra il traffico:

```sh
docker volume create obsync-blobs
docker volume create obsync-journal
docker run -d --name obsync -p 127.0.0.1:8080:8080 \
  -v obsync-blobs:/data/blobs -v obsync-journal:/data/journal \
  -e OBSYNC_BLOBS_CAPACITY=250GiB -e OBSYNC_JOURNAL_CAPACITY=4GiB \
  -e OBSYNC_PUBLIC_URL=https://sync.example.org \
  ghcr.io/snaraj/obsync@sha256:<the digest cosign just verified>
```

### 2. Leggere il token di configurazione

Al primo avvio il server conia un token di configurazione e lo scrive sul suo
volume journal, con permessi 0600, senza mai registrarlo nei log. Il token crea
il tuo account una volta sola, e poi resta per tutta la vita del server
l'accesso di recupero alla dashboard: custodiscilo con la stessa cura della
frase di recupero. Leggilo dal container stesso, senza immagini di supporto. Sul
percorso Compose:

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

Sul percorso con il server da solo:

```sh
docker cp obsync:/data/journal/v1/setup-token - | tar -xO
```

### 3. Fidarsi del certificato, una volta per dispositivo (percorso Compose)

Caddy ha emesso il certificato da un'autorità che ha generato al primo avvio,
quindi a ogni dispositivo va detto una volta di fidarsi di quell'autorità.
Esporta il certificato radice:

```sh
docker cp obsync-caddy-1:/data/caddy/pki/authorities/local/root.crt - | tar -xO > obsync-root.crt
```

Installa `obsync-root.crt` su ogni dispositivo. I passi per macOS, Windows,
Linux, iOS e Android sono in
[Fidarsi dell'autorità di certificazione, una volta per dispositivo](../server.md#trust-the-certificate-authority-once-per-device).
Su iOS, fidarsi del certificato è un secondo interruttore dopo averlo
installato.

### 4. Configurare il primo dispositivo

1. Impostazioni → Plugin di terze parti → Sfoglia → **Self Hosted Private
   Sync** → Installa → Abilita.
2. Nelle impostazioni del plugin, imposta **Server URL** sul tuo server, porta
   compresa quando non è la 443: `https://sync.example.org`.

   ![La scheda delle impostazioni del plugin: il campo Server URL con un nome host di esempio, il riquadro per le intestazioni edge e la riga Connection con i suoi pulsanti Check e Open dashboard](../assets/settings-server.png)

3. Scegli ora **Whole vault** oppure **Selected folders only**. Una volta che un
   dispositivo ha sincronizzato, la sua selezione può solo restringersi.
4. Incolla il token di configurazione sotto **First-time setup** e scegli
   **Set up**. Scrivi la frase di recupero di 24 parole e tienila fuori da
   questo dispositivo.

   ![La sezione This device della scheda delle impostazioni: la riga Pairing con Pair this device e Pair a new device, la riga First-time setup con il campo Setup token e il pulsante Set up, e la riga Vault key](../assets/settings-setup.png)

### 5. Abbinare il secondo dispositivo

1. Installa e abilita lì il plugin, imposta lo stesso **Server URL** e scegli le
   sue cartelle.
2. Sul primo dispositivo esegui **Pair a new device**. Mostra un codice valido
   per dieci minuti.

   ![La finestra Pair a new device sul primo dispositivo, con il suo codice oscurato, i pulsanti Copy code e Copy link e la riga Waiting for the new device](../assets/pair-new-device.png)

3. Sul secondo dispositivo apri **Pair this device**, incolla il codice e scegli
   **Pair**.

   ![La finestra Pair this device sul secondo dispositivo, con il campo Pairing code vuoto e il pulsante Pair](../assets/pair-this-device.png)

4. Torna sul primo dispositivo e approva il nuovo dispositivo per nome. Modifica
   una nota su uno dei due; compare sull'altro nel giro di secondi.

   ![Il primo dispositivo chiede se approvare il nuovo dispositivo per nome, con i pulsanti Approve e Reject](../assets/pair-approve.png)

   ![Il secondo dispositivo mostra la nota scritta sul primo dispositivo, con la barra di stato che riporta obsync idle](../assets/first-sync.png)

L'intero scambio di abbinamento, in un breve ciclo:

![Animazione: il codice di abbinamento mostrato sul primo dispositivo, incollato sul secondo, approvato sul primo, e la prima nota che arriva sul secondo](../assets/pairing.gif)

Le schermate da telefono non sono ancora in questo repository; vengono prese
sui dispositivi personali del manutentore e aggiunte quando una sessione di
validazione le registra.

Ogni passo per esteso, con ciò che ogni schermata chiede e perché:
[Avvio rapido](../quickstart.md).

**Lo provi su un solo computer?** Su un computer il plugin accetta anche un
indirizzo `http://` in chiaro, così `http://127.0.0.1:8080` raggiunge il server
da solo qui sopra senza terminatore. I telefoni no: Obsidian su iOS e Android
rifiuta l'HTTP in chiaro.

## Avanzato: Cloudflare

L'installazione di riferimento non ha **alcun nome host pubblico**. Un
Cloudflare Tunnel collega la rete privata del server a Cloudflare, una rotta
privata dice a Cloudflare quali indirizzi stanno dietro quel tunnel, e il client
Cloudflare One su ogni dispositivo ci porta l'URL del server. Nulla è
raggiungibile da internet, e le prime sincronizzazioni voluminose non passano
per un nome host pubblico. È supportata anche l'altra variante: un nome host
pubblico dietro Cloudflare Access, con un token di servizio in **Edge
service-token headers** e `OBSYNC_EDGE=cloudflare` sul server. Entrambe, passo
per passo: [Cloudflare](cloudflare.md).

## Altri modi per raggiungere il tuo server

Una riga ciascuno, nessuna guida passo passo. Qualunque cosa tu scelga, il
plugin ha bisogno di HTTPS con un certificato di cui ogni dispositivo si fida, e
il server stesso resta su HTTP in chiaro dietro quel terminatore.

- **Solo LAN.** Il percorso Compose qui sopra, raggiungibile solo da casa. Il
  più semplice; nessuna sincronizzazione fuori casa.
- **WireGuard.** La tua VPN verso la tua rete. Il più veloce e del tutto tuo;
  porti una configurazione peer su ogni dispositivo e tieni raggiungibile un
  endpoint.
- **Tailscale.** Una mesh WireGuard gestita, con nomi propri. Il minimo di
  configurazione sui dispositivi; una terza parte coordina la mesh, e i limiti
  del suo piano tocca a te leggerli.
- **Un reverse proxy con TLS automatico**, per esempio Caddy su un nome
  pubblico. Un certificato pubblicamente attendibile e un indirizzo permanente;
  il server diventa allora raggiungibile da internet, e il proxy e i suoi
  aggiornamenti restano a carico tuo.
- **Cloudflare Tunnel.** Qui sopra. Nessuna porta in ingresso; un provider sul
  percorso, con le sue condizioni.

Che cosa serve a un dispositivo in mobilità, qualunque cosa tu scelga (la rotta,
il nome, il certificato, la richiesta iOS per la rete locale, il firewall):
[Raggiungerlo da fuori della tua LAN](../server.md#reaching-it-from-outside-your-lan).

## Risoluzione dei problemi

| Sintomo | Causa probabile | Prima cosa da provare |
| --- | --- | --- |
| `obsync: offline` | Il dispositivo non raggiunge l'URL del server | Apri l'URL in un browser sullo stesso dispositivo; controlla la porta, HTTPS e la rotta |
| Un telefono non si connette mentre un computer sincronizza | Il certificato privato non è considerato attendibile sul telefono | Installa il certificato radice; su iOS attivalo anche in «Impostazioni attendibilità certificati» |
| `401 stale_timestamp` | Un orologio sbaglia di più di 300 secondi | Attiva l'ora automatica, sul dispositivo o sul server |
| `403 device_pending` | Nessuno ha ancora approvato il dispositivo | Approvalo per nome sul dispositivo da cui hai fatto l'abbinamento |
| Un file non arriva mai | È fuori dalla selezione di cartelle, o sopra il limite di dimensione di un telefono | Controlla **Sync folders on this device**; sul telefono esegui **Show remote-only files** |

Ogni altro sintomo, ogni codice di errore e come raccogliere una segnalazione
che valga la pena inviare: [Risoluzione dei problemi](../troubleshooting.md).

## Documentazione

| Pagina | A che cosa risponde |
| --- | --- |
| [Avvio rapido](../quickstart.md) | Il primo dispositivo e il secondo, ogni passo per esteso |
| [Avviare il server](../server.md) | Docker, Compose con Caddy, certificati, backup, raggiungerlo da fuori della tua LAN |
| [Cloudflare](cloudflare.md) | Tunnel con una rotta privata e il client Cloudflare One, oppure un nome host pubblico dietro Access |
| [Kubernetes](../../chart/README.md) | Installare il server con il chart Helm firmato |
| [Uso quotidiano](../daily-use.md) | Comandi, la barra di stato, che cosa si sincronizza e che cosa no, ripristinare una versione, la dashboard |
| [Impostazioni](../settings.md) | Ogni impostazione, il suo valore predefinito e quando cambiarla |
| [Risoluzione dei problemi](../troubleshooting.md) | Sintomo, causa, rimedio e come raccogliere una segnalazione |
| [Conflitti](../conflicts.md) | Che cos'è una copia di conflitto e che cosa farci |
| [Recupero](../recovery.md) | Un dispositivo perso, un server perso, un server spostato, un token ruotato |
| [Installare e aggiornare](../community-plugin.md) | Il catalogo di Obsidian, gli aggiornamenti, la custodia delle credenziali, la revisione della scheda |
| [Modello delle minacce](../threat-model.md) | Che cosa è difeso e che cosa no |
| [Il modello delle minacce della dashboard](../security/dashboard.md) | Sessioni, accesso, revoca, rischi residui |
| [Architettura](../architecture.md) | Com'è costruito l'intero sistema, e ogni variabile d'ambiente |
| [Protocollo](../protocol.md) | Il contratto di comunicazione fra plugin e server |
| [Archiviazione](../storage.md) | Volumi, durabilità, conservazione, scrub e ogni rifiuto |
| [Validazione](../validation.md) | Il piano di validazione sui dispositivi e che cosa significa «pronto» |
| [Release](../release.md) | Come una release viene tagliata, firmata e verificata |
| [Traduzioni](../translations.md) | In quali lingue esistono le guide, e come vengono tenute aggiornate |
| [`CHANGELOG.md`](../../CHANGELOG.md) | Che cosa è cambiato in ogni versione |
| [`SECURITY.md`](../../SECURITY.md) | Postura, versioni supportate e come segnalare una vulnerabilità |
| [`CONTRIBUTING.md`](../../CONTRIBUTING.md) | Come lavorare su questo repository |

## Domande, bug e sicurezza

- **Una domanda, o qualcosa di cui non sei sicuro che sia un bug:**
  [Discussions](https://github.com/snaraj/obsync/discussions).
- **Un bug:** [apri una issue](https://github.com/snaraj/obsync/issues/new/choose)
  con il modello per la segnalazione dei bug e la segnalazione descritta in
  [Risoluzione dei problemi](../troubleshooting.md). Senza token, senza frase di
  recupero e senza alcun indirizzo che non pubblicheresti.
- **Una sospetta vulnerabilità:** in privato, tramite
  [`SECURITY.md`](../../SECURITY.md) — mai come issue pubblica.

## Licenza

MIT. Vedi [`LICENSE`](../../LICENSE).
