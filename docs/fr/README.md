> Cette traduction suit [l'original en anglais](../../README.md). Le texte anglais fait foi ; les commandes, options, URL et espaces réservés restent inchangés.

<img src="../../brand/obsync-icon-256.png" alt="icône obsync : deux anneaux entrelacés" width="96" height="96">

# Self Hosted Private Sync

Synchronisation en direct, auto-hébergée et chiffrée de bout en bout pour
[Obsidian](https://obsidian.md) : un serveur Rust sans dépendances, doté d'un
tableau de bord intégré, que vous faites tourner vous-même, plus ce module.
Des fichiers de toute taille, toutes les plateformes Obsidian, aucun
abonnement, aucun tiers.

Installez-le depuis Paramètres → Modules complémentaires → Parcourir sous le
nom **Self Hosted Private Sync** (identifiant du module
`obsync-private-sync`), sur Obsidian 1.13.0 ou plus récent.

**Nouveau ici ? Commencez par le [guide d’installation](https://snaraj.github.io/obsync/setup/) (en anglais).** Il vous aide à choisir comment vos appareils joignent votre serveur et détaille chaque option pas à pas. Dans Obsidian : Paramètres → Self Hosted Private Sync → Setup guide.

> [!IMPORTANT]
> - Il se synchronise avec un serveur que **vous** faites tourner : aucun
>   service hébergé, aucun compte ailleurs.
> - Sauvegardez d'abord votre coffre ; conservez la phrase de récupération de
>   24 mots ailleurs que sur l'appareil qui l'a générée.
> - Ne l'utilisez jamais à côté d'une autre synchronisation (Obsidian Sync, un
>   dossier cloud, un autre module) sur un même coffre.
> - Logiciel jeune : lisez l'entrée de [`CHANGELOG.md`](../../CHANGELOG.md)
>   correspondant à votre version, mettez à jour chaque appareil, et sachez ce
>   que chaque [campagne de validation](../validation-runs/) a couvert.

## Ce à quoi ce module accède

- **Votre serveur, et rien d'autre.** Chaque requête va à la **Server URL**
  que vous saisissez ; aucune télémétrie, aucun tiers.
- **Un compte sur ce serveur**, créé à partir du jeton d'installation ; votre
  compte Obsidian n'y joue aucun rôle.
- **Les GitHub Releases, via Obsidian**, pour installer et mettre à jour ;
  Obsidian ignore les autres fichiers publiés avec la Release.
- **La liste des fichiers de votre coffre**, pour décider quoi synchroniser ;
  les dossiers cachés (`.obsidian`, `.git`) et ceux qui sont des liens
  symboliques sont ignorés.
- **Le presse-papiers, écrit uniquement** par **Copy code** et **Copy link**
  dans **Pair a new device**, jamais lu.

Ce que le serveur peut voir et ce qu'il ne peut pas voir :
[`SECURITY.md`](../../SECURITY.md) et le [modèle de menace](../threat-model.md).

## Commencer à synchroniser

Cinq étapes pour passer de rien à deux appareils synchronisés. `v1.0.6` est la
version pour laquelle cette page a été écrite ; prenez le tag de la version
que vous installez.

### 1. Démarrer le serveur

Vérifiez la signature, puis exécutez exactement l'empreinte qu'elle a
affichée :

```sh
cosign verify ghcr.io/snaraj/obsync:v1.0.6 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Le chemin le plus simple est Compose avec Caddy, depuis une copie de travail
de ce dépôt : du HTTPS sur n'importe quel réseau, sans domaine et sans compte
chez qui que ce soit.

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` est le nom que vos appareils saisiront ; il n'a besoin de
résoudre que sur votre propre réseau. `OBSYNC_BIND_ADDRESS` est l'adresse sur
laquelle les ports 80 et 443 sont publiés : une adresse de liaison limite
l'interface de destination, pas la source, c'est donc votre pare-feu qui
décide qui l'atteint. Compose refuse de démarrer tant que vous n'avez pas
choisi.

Vous avez déjà du HTTPS devant, par un proxy ou un tunnel auquel vous faites
confiance ? Lancez plutôt le serveur nu :
[Faire tourner le serveur](../server.md).

### 2. Lire le jeton d'installation

Au premier démarrage, le serveur émet un jeton d'installation et l'écrit sur
son volume de journal, en mode 0600, sans jamais le journaliser. Il crée votre
compte une seule fois et reste la connexion de secours au tableau de bord :
gardez-le avec le même soin que la phrase de récupération. Lisez-le depuis le
conteneur :

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

### 3. Faire confiance au certificat, une fois par appareil

Caddy signe avec une autorité qu'il a générée au premier démarrage ; chaque
appareil doit lui faire confiance une fois. Exportez le certificat racine et
installez-le sur chaque plateforme comme le montre
[Faire tourner le serveur](../server.md#trust-the-certificate-authority-once-per-device) ;
sur iOS, lui faire confiance est un second interrupteur, après l'installation.

### 4. Configurer le premier appareil

1. Paramètres → Modules complémentaires → Parcourir → **Self Hosted Private
   Sync** → Installer → Activer.
2. Réglez **Server URL** sur votre serveur (`https://sync.example.org`, port
   compris quand ce n'est pas le 443), puis choisissez **Whole vault** ou
   **Selected folders only** ; la sélection ne pourra ensuite que se
   restreindre.

   ![L'onglet de paramètres du module : le champ Server URL contenant un nom d'hôte de démonstration, la zone des en-têtes de bordure, et la ligne Connection avec ses boutons Check et Open dashboard](../assets/settings-server.png)

3. Collez le jeton d'installation sous **First-time setup**, choisissez
   **Set up**, et notez la phrase de récupération de 24 mots.

   ![La section This device de l'onglet de paramètres : la ligne Pairing avec Pair this device et Pair a new device, la ligne First-time setup avec le champ Setup token et le bouton Set up, et la ligne Vault key](../assets/settings-setup.png)

### 5. Appairer le second appareil

1. Installez-y le module avec la même **Server URL** ; sur le premier
   appareil, lancez **Pair a new device** pour obtenir un code valable dix
   minutes.

   ![La fenêtre Pair a new device sur le premier appareil, son code masqué, avec les boutons Copy code et Copy link et la ligne Waiting for the new device](../assets/pair-new-device.png)

2. Sur le second appareil, ouvrez **Pair this device**, collez le code, et
   choisissez **Pair**.
3. De retour sur le premier appareil, approuvez-le par son nom. Modifiez une
   note sur l'un des deux ; elle apparaît sur l'autre en quelques secondes.

   ![Le premier appareil demandant s'il faut approuver le nouvel appareil par son nom, avec les boutons Approve et Reject](../assets/pair-approve.png)

![Animation : le code d'appairage affiché sur le premier appareil, collé sur le second, approuvé sur le premier, et la première note arrivant sur le second](../assets/pairing.gif)

Vous l'essayez sur un seul ordinateur ? `http://127.0.0.1:8080` atteint le
serveur nu sur un ordinateur de bureau ; Obsidian sur iOS et Android refuse le
HTTP simple.

Les captures d'écran de téléphone ne sont pas encore dans ce dépôt ; elles
sont prises sur les appareils du mainteneur et ajoutées dès qu'une campagne
de validation les consigne.

Chaque étape en entier : [Démarrage rapide](../quickstart.md).

## Pour aller plus loin : Cloudflare

Le déploiement de référence n'a aucun nom d'hôte public : un Cloudflare Tunnel
et une route privée joignent le réseau du serveur, et le client Cloudflare One
de chaque appareil y porte la Server URL. Un nom d'hôte public derrière
Cloudflare Access, avec un jeton de service dans **Edge service-token
headers** et `OBSYNC_EDGE=cloudflare`, fonctionne aussi. Les deux, étape par
étape : [Cloudflare](cloudflare.md).

## Autres façons de joindre votre serveur

Quel que soit votre choix, le module a besoin de HTTPS avec un certificat
auquel chaque appareil fait confiance ; le serveur lui-même reste en HTTP
simple derrière ce terminateur.

- **LAN seulement.** Le chemin Compose ci-dessus, joignable uniquement à la
  maison ; aucune synchronisation en déplacement.
- **WireGuard.** Votre propre VPN vers chez vous : le plus rapide, entièrement
  à vous ; une configuration de pair sur chaque appareil.
- **Tailscale.** Un maillage WireGuard géré : le moins de configuration ; un
  tiers le coordonne, selon les conditions de ses offres.
- **Un reverse proxy avec TLS automatique**, comme Caddy sur un nom public :
  joignable depuis Internet, et c'est à vous de le tenir à jour.
- **Cloudflare Tunnel.** Voir ci-dessus. Aucun port entrant ; un fournisseur
  sur le chemin, avec ses propres conditions.

Ce dont un appareil itinérant a besoin (la route, le nom, le certificat, le
pare-feu, la demande iOS d'accès au réseau local) :
[Le joindre hors de votre LAN](../server.md#reaching-it-from-outside-your-lan).

## Dépannage

| Symptôme | Cause probable | Première chose à essayer |
| --- | --- | --- |
| `obsync: offline` | L'appareil n'arrive pas à joindre la Server URL | Ouvrez l'URL dans un navigateur sur le même appareil ; vérifiez le port, le HTTPS et la route |
| Un téléphone ne se connecte pas alors qu'un ordinateur synchronise | Le certificat privé n'est pas approuvé sur le téléphone | Installez le certificat racine ; sur iOS, activez-le en plus sous « Réglages de confiance des certificats » |
| `401 stale_timestamp` | Une horloge est décalée de plus de 300 secondes | Activez l'heure automatique, sur l'appareil ou sur le serveur |
| `403 device_pending` | Personne n'a encore approuvé l'appareil | Approuvez-le par son nom sur l'appareil depuis lequel vous l'avez appairé |
| Un fichier n'arrive jamais | Il est hors de la sélection de dossiers, ou au-dessus du plafond de taille d'un téléphone | Vérifiez **Sync folders on this device** ; sur le téléphone, lancez **Show remote-only files** |

Tout autre symptôme, tous les codes d'erreur, et comment en signaler un :
[Dépannage](../troubleshooting.md).

## Documentation

[Démarrage rapide](../quickstart.md) · [Faire tourner le serveur](../server.md) ·
[Cloudflare](cloudflare.md) · [Usage quotidien](../daily-use.md) ·
[Paramètres](../settings.md) · [Dépannage](../troubleshooting.md) ·
[Récupération](../recovery.md) · [Journal des modifications](../../CHANGELOG.md)

Tout le reste : [docs/README.md](../README.md).

## Questions, bogues et sécurité

- **Une question, ou un doute sur le fait que ce soit un bogue :**
  [Discussions](https://github.com/snaraj/obsync/discussions).
- **Un bogue :** [ouvrez un ticket](https://github.com/snaraj/obsync/issues/new/choose)
  avec le rapport décrit dans [Dépannage](../troubleshooting.md) ; aucun
  jeton, aucune phrase de récupération, aucune adresse que vous ne publieriez
  pas.
- **Une vulnérabilité soupçonnée :** en privé, via
  [`SECURITY.md`](../../SECURITY.md), jamais dans un ticket public.

## Licence

MIT. Voir [`LICENSE`](../../LICENSE).
