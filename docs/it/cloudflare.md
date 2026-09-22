> Questa traduzione segue [l'originale in inglese](../cloudflare.md). Il testo inglese è quello canonico; comandi, opzioni, URL e segnaposto restano invariati.

# Cloudflare

Due modi per mettere Cloudflare fra i tuoi dispositivi e il tuo server, e
quale dei due usa l'installazione di riferimento. Nessuno è obbligatorio: il
server non conosce alcun provider per nome, e
[Avviare il server](../server.md) non richiede un account presso nessuno.
Questa pagina fa per te se vuoi raggiungere il server fuori casa senza aprire
una porta sul router, o se vuoi un nome host pubblicato con una policy di
accesso davanti.

I menu di Cloudflare e le condizioni dei suoi piani cambiano. Ogni passo qui
sotto indica il percorso di menu come lo riportava la documentazione
Cloudflare il 2026-09-22; controlla la pagina attuale prima di fare
affidamento su un limite o su un prezzo.

## Quale variante

| Variante | Cosa vedono i dispositivi | Cosa vede internet | Prima sincronizzazione voluminosa |
| --- | --- | --- | --- |
| **Rotta privata** (l'installazione di riferimento) | il tuo indirizzo privato e il tuo nome, tramite il client Cloudflare One | nulla: nessun nome host, nessuna porta aperta | traffico di rete privata, non instradato attraverso un nome host pubblico |
| **Nome host pubblico con Access** | un nome pubblico, una policy di Access, un token di servizio nel plugin | il nome host, dietro Access | passa da Cloudflare, alle condizioni del provider per i file grandi |

La rotta privata è quella di riferimento perché il server resta invisibile e
perché la stessa documentazione di Cloudflare manda per quella strada i
trasferimenti grandi: una rotta con nome host pubblico fa passare il traffico
da Cloudflare, e sui piani Free, Pro e Business le condizioni specifiche del
servizio richiedono un servizio a pagamento per video e altri file grandi,
mentre una rotta di rete privata li trasporta come traffico tuo. Fai la prima
sincronizzazione voluminosa sulla LAN in entrambe le varianti.

Qualunque cosa termini TLS legge le tue credenziali e mai le tue note: ogni
chunk e ogni manifest sono cifrati sul dispositivo, e nessuna chiave in grado
di decifrarli attraversa la rete ([modello delle minacce](../threat-model.md)).
Sulla rotta privata il terminatore è tuo, dentro la tua rete. Con il nome host
pubblico anche l'edge è un terminatore.

## Variante A: una rotta privata e il client Cloudflare One

Il server mantiene un indirizzo privato nella tua rete. Accanto a lui gira un
connettore del tunnel, una rotta dice a Cloudflare quali indirizzi stanno
dietro quel tunnel, e il client Cloudflare One (in passato WARP) su ogni
dispositivo porta il traffico verso quegli indirizzi attraverso il tunnel.
L'URL del server che i tuoi dispositivi digitano è un nome privato che si
risolve in quell'indirizzo privato.

Cosa ti serve: un account Cloudflare con un'organizzazione Zero Trust (un
«nome del team»), una macchina nella rete del server che possa eseguire il
connettore del tunnel, e il client Cloudflare One su ogni dispositivo che
sincronizzerà fuori casa.

1. **Crea un tunnel.** Nella dashboard di Cloudflare vai su **Networking** >
   **Tunnels** e crea un tunnel `cloudflared`. Esegui il connettore che ti
   fornisce su una macchina dentro la rete del server: nel cluster accanto al
   server, o sullo stesso host.
2. **Instrada l'indirizzo privato del server attraverso il tunnel.** Vai su
   **Networking** > **Routes**, scegli **Create route** > **Tunnel CIDR**,
   seleziona il tunnel e inserisci l'indirizzo privato o la subnet del server.
   Basta un indirizzo; una subnet si può allargare in seguito.
3. **Registra ogni dispositivo.** Installa il client Cloudflare One, inserisci
   il nome del team, completa l'accesso richiesto dalla tua organizzazione e
   attiva la connessione. Su iOS e Android il client chiede di installare un
   profilo VPN; accetta. Imposta i permessi di registrazione dei dispositivi
   in modo che solo la tua identità possa registrarne.
4. **Manda l'intervallo privato attraverso il client.** Nella configurazione
   Split Tunnels del client, assicurati che l'indirizzo del passo 2 venga
   instradato attraverso il client. In modalità **Exclude**, togli il blocco
   RFC 1918 che lo contiene e aggiungi di nuovo gli intervalli che vuoi
   ancora escludere; in modalità **Include**, aggiungi l'indirizzo o la
   subnet.
5. **Fai risolvere il nome sul dispositivo.** Il plugin invia ogni richiesta
   all'URL del server che hai digitato, quindi quel nome deve risolversi sul
   dispositivo in mobilità: una rotta per nome host, Local Domain Fallback
   verso il tuo resolver, o una voce DNS privata. Un nome che si risolve in un
   indirizzo che il client non instrada fallisce esattamente come un server
   spento.
6. **Termina TLS per conto tuo.** La rotta porta il tuo traffico fino al tuo
   terminatore: un ingress o un reverse proxy davanti al server con un
   certificato di cui ogni dispositivo si fida, come in
   [Avviare il server](../server.md). Il server gira con `OBSYNC_EDGE=none`
   e si fida degli indirizzi inoltrati solo da `OBSYNC_TRUSTED_PROXY_CIDRS`,
   l'intervallo del terminatore stesso.
7. **Se vuoi, filtra con Gateway.** Una policy di rete di Gateway può
   consentire solo ai tuoi dispositivi registrati di raggiungere indirizzo e
   porta del server, e bloccare tutto il resto su quella rotta.
8. **Verifica da un dispositivo fuori dalla tua rete.** Apri l'URL del server
   in un browser su quel dispositivo e aspettati la pagina di accesso della
   dashboard. Nel plugin scegli **Check** sotto **Connection**: un solo
   round trip dimostra insieme indirizzo, certificato e credenziale.

Compromessi:

- Ogni dispositivo che sincronizza esegue il client Cloudflare One, e il
  client deve essere connesso prima che la sincronizzazione fuori casa
  funzioni.
- Cloudflare trasporta il traffico fra il dispositivo e il connettore del
  tunnel. Lascia spenta la decifratura TLS di Gateway; il traffico gli resta
  allora opaco al di là di indirizzi, dimensioni e tempi, cosa che il
  [modello delle minacce](../threat-model.md) concede già a qualsiasi
  percorso di rete.
- Il connettore è un processo nella tua rete che tiene aperta una connessione
  in uscita verso Cloudflare. Quando è giù, i dispositivi in mobilità mostrano
  `obsync: offline` mentre la LAN continua a funzionare.

## Variante B: un nome host pubblico dietro Access

Il server riceve un nome host su un dominio che hai su Cloudflare. Il tunnel
pubblica quel nome verso l'indirizzo privato del server, e Cloudflare Access
gli sta davanti: una policy di identità per la dashboard e un token di
servizio per le chiamate API del plugin. È la variante che
[l'onboarding della piattaforma](../platform-onboarding.md) descrive per il
cluster di riferimento, e quella che l'installazione di riferimento non ha
adottato.

1. **Pubblica il nome host.** Nella configurazione del tunnel aggiungi una
   rotta di applicazione pubblicata dal tuo nome host (`sync.example.com` sta
   per il tuo) verso l'indirizzo HTTP privato del server, porta 8080.
   Cloudflare crea il record DNS.
2. **Metti Access davanti.** Vai su **Zero Trust** > **Access controls** >
   **Applications**, crea un'applicazione **Self-hosted** su quel nome host e
   aggiungi una policy di identità che consenta solo te, per esempio un PIN
   monouso inviato al tuo indirizzo, per la dashboard.
3. **Crea un token di servizio per il plugin.** Vai su **Zero Trust** >
   **Access controls** > **Service credentials** > **Service Tokens**, creane
   uno e copia il Client ID e il Client Secret; il secret viene mostrato una
   sola volta. Aggiungi all'applicazione una policy **Service Auth** che
   includa questo token, per i percorsi usati dal plugin (`/v1/*`).
4. **Incolla il token nel plugin.** Sotto **Edge service-token headers**, uno
   per riga, esattamente come li chiama Cloudflare:

   ```text
   CF-Access-Client-Id: <the client id>
   CF-Access-Client-Secret: <the client secret>
   ```

   Viaggiano con ogni richiesta verso l'URL del server, e con nient'altro.
5. **Di' al server che sta dietro l'edge.** Avvialo con
   `OBSYNC_EDGE=cloudflare`. In quella modalità ogni richiesta deve portare le
   intestazioni dell'edge con l'indirizzo di connessione e l'ID della
   richiesta, e una richiesta che arriva aggirando l'edge viene rifiutata con
   `421 edge_required` ([risoluzione dei problemi](../troubleshooting.md#edge_required)).
6. **Verifica.** Apri il nome host in un browser e aspettati l'accesso di
   Access, poi la dashboard. Nel plugin scegli **Check** sotto **Connection**.

Compromessi:

- Il nome host è pubblico. Access rifiuta gli sconosciuti, e il server
  autentica comunque da sé ogni richiesta dei dispositivi, ma il nome esiste
  ed è individuabile.
- Il token di servizio è una credenziale. Chi lo possiede raggiunge la porta
  d'ingresso dell'API; l'autenticazione dei dispositivi da parte del server
  resta comunque dietro. Ruotalo in Cloudflare se mai venisse esposto.
- I trasferimenti grandi passano da Cloudflare alle condizioni sopra. Fai la
  prima sincronizzazione voluminosa sulla LAN.
- Le intestazioni dell'edge con indirizzo di connessione e paese sono ciò che
  la pagina Dispositivi della dashboard mostra come indirizzo e paese in
  questa modalità.

## Cosa è stato provato

La rotta privata è la rotta dell'installazione di riferimento. La
[sessione del 2026-09-14](../validation-runs/2026-09-14.md) registra che quel
giorno non è stata esercitata, e perché; la
[sessione del 2026-09-20](../validation-runs/2026-09-20.md) registra una
sessione con dispositivi sulla rotta di riferimento con i controlli di
connettività e TLS superati. La variante con nome host pubblico non è stata
esercitata da alcuna sessione registrata.

## Poi

- [Avviare il server](../server.md): il terminatore, i volumi, il token di
  configurazione.
- [Kubernetes](https://github.com/snaraj/obsync/blob/main/chart/README.md): il chart usato dall'installazione di
  riferimento.
- [Onboarding della piattaforma](../platform-onboarding.md): cosa
  aggiungerebbe il cluster di riferimento per un nome host pubblicato.
- [Risoluzione dei problemi](../troubleshooting.md): `edge_required`,
  `offline` e il certificato.
