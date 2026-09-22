> Cette traduction suit [l'original en anglais](../../README.md). Le texte anglais fait foi ; les commandes, options, URL et espaces réservés restent inchangés.

# Self Hosted Private Sync

Synchronisation en direct, auto-hébergée et chiffrée de bout en bout pour
[Obsidian](https://obsidian.md) : un serveur Rust sans dépendances, doté d'un
tableau de bord intégré, que vous faites tourner vous-même, plus ce module.
Des fichiers de toute taille, toutes les plateformes Obsidian, aucun
abonnement, aucun tiers.

Installez-le depuis Paramètres → Modules complémentaires → Parcourir sous le
nom **Self Hosted Private Sync** (identifiant du module
`obsync-private-sync`), sur Obsidian 1.13.0 ou plus récent.

> [!IMPORTANT]
> Ce module se synchronise avec un serveur que **vous** faites tourner. Il
> n'existe aucun service hébergé et aucun compte chez qui que ce soit d'autre
> que vous-même : sans votre propre `obsyncd` joignable en HTTPS, le module
> n'a rien avec quoi se synchroniser.

> [!IMPORTANT]
> Sauvegardez votre coffre avant la première synchronisation, et conservez la
> phrase de récupération de 24 mots ailleurs que sur l'appareil qui l'a
> générée. Le serveur ne stocke que du texte chiffré et ne peut pas récupérer
> un coffre à votre place.

> [!IMPORTANT]
> N'utilisez pas ce module à côté d'une autre solution de synchronisation sur
> le même coffre — Obsidian Sync, un dossier cloud synchronisé, ou un autre
> module de synchronisation. Deux programmes qui écrivent dans le même coffre
> produisent des conflits qu'aucun des deux ne peut réconcilier.

## Avant de vous y fier

C'est un logiciel jeune, et il synchronise l'unique copie de vos notes.

- **[`CHANGELOG.md`](../../CHANGELOG.md) est la liste tenue à jour de ce que
  l'on sait.** Lisez l'entrée de la version que vous utilisez, ainsi que
  celles qui figurent au-dessus. Les pages de version conservent les notes
  avec lesquelles elles ont été publiées ; les découvertes ultérieures sont
  ajoutées ici.
- **Mettez à jour chaque appareil qui synchronise un coffre.** Un seul
  appareil resté sur une version plus ancienne peut encore agir selon
  l'ancien comportement et affecter les autres.
- **Ce qui a été éprouvé sur du matériel** est consigné campagne par campagne
  dans [`docs/validation-runs/`](../validation-runs/), y compris ce que chaque
  campagne n'a pas couvert. Une plateforme qu'aucune campagne ne nomme n'est
  pas prouvée.
- **Un flot d'avis « merged concurrent edits »** sur deux appareils qui
  modifient une même note : quittez Obsidian sur l'un d'eux pour que l'autre
  puisse finir d'écouler son travail, mettez les deux à jour, puis reprenez.

## Ce à quoi ce module accède

Court et complet, pour que vous puissiez décider avant d'installer.

- **Une seule destination réseau : votre propre serveur.** Chaque requête va
  à la **Server URL** que vous saisissez dans les paramètres du module, et
  nulle part ailleurs. Il n'y a ni télémétrie, ni analyse d'audience, ni
  rapporteur de plantages, ni publicité, ni service tiers où que ce soit sur
  le chemin de la synchronisation. Le module ne télécharge jamais non plus de
  code depuis ce serveur et n'en exécute aucun.
- **Un compte sur ce serveur, que vous créez vous-même.** Le premier appareil
  utilise le jeton d'installation que votre serveur a écrit au premier
  démarrage ; chaque autre appareil est appairé depuis un appareil qui
  synchronise déjà. Votre compte Obsidian n'y joue aucun rôle.
- **Obsidian et GitHub, pour l'installation et les mises à jour seulement.**
  Obsidian lui-même télécharge `main.js`, `manifest.json` et `styles.css`
  depuis les GitHub Releases de ce dépôt. Chaque Release porte aussi un ZIP
  du module et un manifeste de version pour les personnes qui déploient le
  serveur ; Obsidian ignore les deux.
- **Votre bordure, seulement si vous en avez configuré une.** Les en-têtes
  que vous collez sous **Edge service-token headers** accompagnent chaque
  requête vers la Server URL ci-dessus, parce que le proxy qui en a besoin se
  trouve sur le chemin de votre serveur.
- **La liste des fichiers de votre coffre.** Le module liste chaque fichier
  du coffre pour décider de ce qui entre dans le périmètre, lit les fichiers
  contenus dans votre sélection de dossiers, et écrit ce que les autres
  appareils ont modifié. Les dossiers cachés (`.obsidian`, `.git`) et les
  dossiers qui sont des liens symboliques sont ignorés.
- **Le presse-papiers, écrit et jamais lu.** Seuls les boutons **Copy code**
  et **Copy link** de **Pair a new device** y écrivent. Rien dans le module
  ne lit le presse-papiers.
- **Votre navigateur, quand vous demandez le tableau de bord.**
  **Open dashboard** ouvre un lien de connexion dans votre navigateur, et
  seulement lorsque ce lien se trouve sur l'origine de votre propre serveur.
- **Le stockage sécurisé d'Obsidian.** La clé du coffre, le secret de
  l'appareil et les éventuelles valeurs d'en-têtes de bordure y résident,
  jamais dans les données en clair du module.

Ce que le serveur peut voir et ce qu'il ne peut pas voir est dans
[`SECURITY.md`](../../SECURITY.md) et
[`docs/threat-model.md`](../threat-model.md).

## Synchronisé en cinq étapes

Le chemin sur lequel cette version a été validée, d'un coffre vide à deux
appareils synchronisés. Les cinq étapes supposent que votre propre serveur
tourne déjà, ce qui est l'objet de la section suivante ; chaque étape est
écrite en entier dans le démarrage rapide.

1. **Installez-le depuis les Modules complémentaires.** Dans Paramètres →
   Modules complémentaires → Parcourir, cherchez **Self Hosted Private
   Sync**, choisissez Installer, puis Activer — exactement comme arrive
   n'importe quel autre module Obsidian, sur toutes les plateformes.

   ![Le navigateur des Modules complémentaires d'Obsidian montrant Self Hosted Private Sync avec son bouton Installer](../captures/01-install-from-directory.png)

2. **Pointez-le vers votre serveur et configurez-le.** Ouvrez l'onglet de
   paramètres du module, réglez **Server URL** sur votre propre serveur,
   choisissez les dossiers que cet appareil synchronise, puis collez votre
   jeton d'installation sous **First-time setup**.

   ![L'onglet de paramètres du module, défilé jusqu'à la sélection de dossiers, jusqu'à Pairing et jusqu'au champ du jeton sous First-time setup](../captures/02-first-time-setup.png)

3. **Conservez la phrase de récupération.** La configuration génère la clé du
   coffre sur cet appareil et affiche une seule fois une phrase de 24 mots :
   notez-la et gardez-la ailleurs que sur cet appareil, car le serveur ne
   détient que du texte chiffré et ne peut pas récupérer un coffre à votre
   place.

   ![La fenêtre de la phrase de récupération affichée après la configuration initiale, ses mots masqués](../captures/03-recovery-phrase.png)

4. **Appairez un deuxième appareil avec un code à usage unique.** Lancez
   **Pair a new device** sur le premier appareil, saisissez sur le second,
   dans les dix minutes, le code qu'il affiche, et approuvez l'appareil par
   son nom — la clé du coffre voyage chiffrée sous un secret d'appairage que
   le serveur ne voit jamais.

   ![La fenêtre Pair a new device sur le premier appareil, son code à usage unique masqué](../captures/04-pair-a-new-device.png)

5. **Modifiez sur l'un ou l'autre appareil et regardez la note arriver.**
   Tapez dans une note sur un appareil et elle apparaît sur l'autre en
   quelques secondes, dans les deux sens, la barre d'état montrant ce que
   fait la synchronisation.

   ![La note jetable portant les modifications des deux appareils, avec la barre d'état de synchronisation visible](../captures/05-sync-both-ways.png)

La liste des appareils du tableau de bord et son bouton de révocation sont
décrits sous [Voir vos appareils](../daily-use.md#see-your-devices) et n'ont
pas été éprouvés lors de la campagne sur appareils de la 1.0.0 consignée dans
[docs/validation-runs/2026-09-14.md](../validation-runs/2026-09-14.md).

## Commencer à synchroniser

Le chemin correct le plus court : une machine qui vous appartient fait
tourner le serveur, chaque appareil le joint en HTTPS, et chaque appareil est
appairé une fois. Se connecter à Obsidian n'autorise rien ici ; le seul
compte est celui de votre serveur.

### 1. Démarrer le serveur

Deux façons de le démarrer. Toutes deux exécutent exactement les octets que
l'éditeur a signés : vérifiez la signature, lisez l'empreinte dans la sortie
vérifiée, et exécutez cette empreinte. `v1.0.6` est la version pour laquelle
cette page a été écrite ; prenez le tag de la version que vous installez.

```sh
cosign verify ghcr.io/snaraj/obsync:v1.0.6 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**Pas encore de HTTPS ?** `deploy/compose` démarre le serveur derrière son
propre terminateur TLS (Caddy), sur n'importe quel réseau, sans domaine et
sans compte chez qui que ce soit. Depuis une copie de travail de ce dépôt :

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` est le nom que vos appareils saisiront. Il n'a besoin de
résoudre que sur votre propre réseau. `OBSYNC_BIND_ADDRESS` est l'adresse de
cet hôte sur laquelle les ports 80 et 443 sont publiés : une adresse de
liaison limite l'interface de destination, pas la source, c'est donc votre
pare-feu qui décide qui l'atteint. Compose refuse de démarrer tant que vous
n'avez pas choisi. Les deux sont expliqués dans
[Faire tourner le serveur](../server.md).

**Vous avez déjà du HTTPS devant** la machine, par un reverse proxy ou un
tunnel auquel vous faites confiance ? Lancez le serveur nu. Il parle du HTTP
simple sur le port 8080, et votre terminateur lui transmet les requêtes :

```sh
docker volume create obsync-blobs
docker volume create obsync-journal
docker run -d --name obsync -p 127.0.0.1:8080:8080 \
  -v obsync-blobs:/data/blobs -v obsync-journal:/data/journal \
  -e OBSYNC_BLOBS_CAPACITY=250GiB -e OBSYNC_JOURNAL_CAPACITY=4GiB \
  -e OBSYNC_PUBLIC_URL=https://sync.example.org \
  ghcr.io/snaraj/obsync@sha256:<the digest cosign just verified>
```

### 2. Lire le jeton d'installation

Au premier démarrage, le serveur émet un jeton d'installation et l'écrit sur
son volume de journal, en mode 0600, sans jamais le journaliser. Le jeton
crée votre compte une seule fois, puis il reste, pour toute la vie du
serveur, la connexion de secours au tableau de bord : gardez-le avec le même
soin que la phrase de récupération. Lisez-le depuis le conteneur lui-même,
sans image auxiliaire. Sur le chemin Compose :

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

Sur le chemin du serveur nu :

```sh
docker cp obsync:/data/journal/v1/setup-token - | tar -xO
```

### 3. Faire confiance au certificat, une fois par appareil (chemin Compose)

Caddy a émis le certificat depuis une autorité qu'il a générée au premier
démarrage : il faut donc dire une fois à chaque appareil de faire confiance à
cette autorité. Exportez le certificat racine :

```sh
docker cp obsync-caddy-1:/data/caddy/pki/authorities/local/root.crt - | tar -xO > obsync-root.crt
```

Installez `obsync-root.crt` sur chaque appareil. Les étapes pour macOS,
Windows, Linux, iOS et Android se trouvent dans
[Faire confiance à l'autorité de certification, une fois par appareil](../server.md#trust-the-certificate-authority-once-per-device).
Sur iOS, faire confiance au certificat est un second interrupteur, après son
installation.

### 4. Configurer le premier appareil

1. Paramètres → Modules complémentaires → Parcourir → **Self Hosted Private
   Sync** → Installer → Activer.
2. Dans les paramètres du module, réglez **Server URL** sur votre serveur,
   port compris quand ce n'est pas le 443 : `https://sync.example.org`.

   ![L'onglet de paramètres du module : le champ Server URL contenant un nom d'hôte de démonstration, la zone des en-têtes de bordure, et la ligne Connection avec ses boutons Check et Open dashboard](../assets/settings-server.png)

3. Choisissez dès maintenant **Whole vault** ou **Selected folders only**.
   Une fois qu'un appareil a synchronisé, sa sélection ne peut plus que se
   restreindre.
4. Collez le jeton d'installation sous **First-time setup** et choisissez
   **Set up**. Notez la phrase de récupération de 24 mots et gardez-la hors
   de cet appareil.

   ![La section This device de l'onglet de paramètres : la ligne Pairing avec Pair this device et Pair a new device, la ligne First-time setup avec le champ Setup token et le bouton Set up, et la ligne Vault key](../assets/settings-setup.png)

### 5. Appairer le second appareil

1. Installez-y le module et activez-le, réglez la même **Server URL**, et
   choisissez ses dossiers.
2. Sur le premier appareil, lancez **Pair a new device**. Il affiche un code
   valable dix minutes.

   ![La fenêtre Pair a new device sur le premier appareil, son code masqué, avec les boutons Copy code et Copy link et la ligne Waiting for the new device](../assets/pair-new-device.png)

3. Sur le second appareil, ouvrez **Pair this device**, collez le code, et
   choisissez **Pair**.

   ![La fenêtre Pair this device sur le second appareil, avec le champ Pairing code vide et le bouton Pair](../assets/pair-this-device.png)

4. De retour sur le premier appareil, approuvez le nouvel appareil par son
   nom. Modifiez une note sur l'un des deux ; elle apparaît sur l'autre en
   quelques secondes.

   ![Le premier appareil demandant s'il faut approuver le nouvel appareil par son nom, avec les boutons Approve et Reject](../assets/pair-approve.png)

   ![Le second appareil affichant la note écrite sur le premier appareil, la barre d'état indiquant obsync idle](../assets/first-sync.png)

Tout l'échange d'appairage, en une courte boucle :

![Animation : le code d'appairage affiché sur le premier appareil, collé sur le second, approuvé sur le premier, et la première note arrivant sur le second](../assets/pairing.gif)

Les captures d'écran de téléphone ne sont pas encore dans ce dépôt ; elles
sont prises sur les appareils du mainteneur et ajoutées dès qu'une campagne
de validation les consigne.

Chaque étape en entier, avec ce que chaque écran demande et pourquoi :
[Démarrage rapide](../quickstart.md).

**Vous l'essayez sur un seul ordinateur ?** Sur un ordinateur, le module
accepte aussi une adresse `http://` simple, si bien que
`http://127.0.0.1:8080` atteint le serveur nu ci-dessus sans terminateur. Les
téléphones, non : Obsidian sur iOS et Android refuse le HTTP simple.

## Pour aller plus loin : Cloudflare

Le déploiement de référence n'a **aucun nom d'hôte public**. Un Cloudflare
Tunnel relie le réseau privé du serveur à Cloudflare, une route privée
indique à Cloudflare quelles adresses se trouvent derrière ce tunnel, et le
client Cloudflare One sur chaque appareil y porte la Server URL. Rien n'est
joignable depuis Internet, et les grosses premières synchronisations ne sont
pas relayées par un nom d'hôte public. L'autre variante, un nom d'hôte public
derrière Cloudflare Access avec un jeton de service dans **Edge service-token
headers** et `OBSYNC_EDGE=cloudflare` sur le serveur, est elle aussi prise en
charge. Les deux, étape par étape : [Cloudflare](cloudflare.md).

## Autres façons de joindre votre serveur

Une ligne chacune, sans tutoriel. Quel que soit votre choix, le module a
besoin de HTTPS avec un certificat auquel chaque appareil fait confiance, et
le serveur lui-même reste en HTTP simple derrière ce terminateur.

- **LAN seulement.** Le chemin Compose ci-dessus, joignable uniquement à la
  maison. Le plus simple ; aucune synchronisation hors de chez vous.
- **WireGuard.** Votre propre VPN vers votre réseau. Le plus rapide et
  entièrement à vous ; vous portez une configuration de pair sur chaque
  appareil et gardez un point d'accès joignable.
- **Tailscale.** Un maillage WireGuard géré, avec ses propres noms. Le moins
  de configuration sur les appareils ; un tiers coordonne le maillage, et
  c'est à vous de lire les limites de ses offres.
- **Un reverse proxy avec TLS automatique**, comme Caddy sur un nom public.
  Un certificat publiquement reconnu et une adresse permanente ; le serveur
  est alors joignable depuis Internet, et c'est à vous de garder le proxy et
  ses mises à jour en bon état.
- **Cloudflare Tunnel.** Voir ci-dessus. Aucun port entrant ; un fournisseur
  sur le chemin, avec ses propres conditions.

Ce dont un appareil itinérant a besoin, quel que soit votre choix (la route,
le nom, le certificat, la demande iOS d'accès au réseau local, le pare-feu) :
[Le joindre hors de votre LAN](../server.md#reaching-it-from-outside-your-lan).

## Dépannage

| Symptôme | Cause probable | Première chose à essayer |
| --- | --- | --- |
| `obsync: offline` | L'appareil n'arrive pas à joindre la Server URL | Ouvrez l'URL dans un navigateur sur le même appareil ; vérifiez le port, le HTTPS et la route |
| Un téléphone ne se connecte pas alors qu'un ordinateur synchronise | Le certificat privé n'est pas approuvé sur le téléphone | Installez le certificat racine ; sur iOS, activez-le en plus sous « Réglages de confiance des certificats » |
| `401 stale_timestamp` | Une horloge est décalée de plus de 300 secondes | Activez l'heure automatique, sur l'appareil ou sur le serveur |
| `403 device_pending` | Personne n'a encore approuvé l'appareil | Approuvez-le par son nom sur l'appareil depuis lequel vous l'avez appairé |
| Un fichier n'arrive jamais | Il est hors de la sélection de dossiers, ou au-dessus du plafond de taille d'un téléphone | Vérifiez **Sync folders on this device** ; sur le téléphone, lancez **Show remote-only files** |

Tout autre symptôme, tous les codes d'erreur, et comment rassembler un
rapport qui vaille la peine d'être envoyé : [Dépannage](../troubleshooting.md).

## Documentation

| Page | Ce à quoi elle répond |
| --- | --- |
| [Démarrage rapide](../quickstart.md) | Le premier appareil et le second, chaque étape en entier |
| [Faire tourner le serveur](../server.md) | Docker, Compose avec Caddy, les certificats, les sauvegardes, joindre le serveur hors de votre LAN |
| [Cloudflare](cloudflare.md) | Un tunnel avec une route privée et le client Cloudflare One, ou un nom d'hôte public derrière Access |
| [Kubernetes](../../chart/README.md) | Installer le serveur avec le chart Helm signé |
| [Usage quotidien](../daily-use.md) | Les commandes, la barre d'état, ce qui se synchronise et ce qui ne se synchronise pas, restaurer une version, le tableau de bord |
| [Paramètres](../settings.md) | Chaque paramètre, sa valeur par défaut, et quand le changer |
| [Dépannage](../troubleshooting.md) | Le symptôme, la cause, le correctif, et comment rassembler un rapport |
| [Conflits](../conflicts.md) | Ce qu'est une copie de conflit et quoi en faire |
| [Récupération](../recovery.md) | Un appareil perdu, un serveur perdu, un serveur déplacé, un jeton renouvelé |
| [Installation et mises à jour](../community-plugin.md) | L'annuaire d'Obsidian, les mises à jour, la garde des identifiants, la revue de la fiche |
| [Modèle de menace](../threat-model.md) | Ce qui est défendu, et ce qui ne l'est pas |
| [Le modèle de menace du tableau de bord](../security/dashboard.md) | Les sessions, la connexion, la révocation, les risques résiduels |
| [Architecture](../architecture.md) | Comment tout le système est construit, et chaque variable d'environnement |
| [Protocole](../protocol.md) | Le contrat de communication entre le module et le serveur |
| [Stockage](../storage.md) | Les volumes, la durabilité, la rétention, le nettoyage, et chaque refus |
| [Validation](../validation.md) | Le plan de validation sur appareils et ce que « prêt » signifie |
| [Publication des versions](../release.md) | Comment une version est préparée, signée et auditée |
| [Traductions](../translations.md) | Dans quelles langues les guides existent, et comment ils sont tenus à jour |
| [`CHANGELOG.md`](../../CHANGELOG.md) | Ce qui a changé dans chaque version |
| [`SECURITY.md`](../../SECURITY.md) | La posture, les versions prises en charge, et comment signaler une vulnérabilité |
| [`CONTRIBUTING.md`](../../CONTRIBUTING.md) | Comment travailler sur ce dépôt |

## Questions, bogues et sécurité

- **Une question, ou quelque chose dont vous ne savez pas si c'est un
  bogue :** [Discussions](https://github.com/snaraj/obsync/discussions).
- **Un bogue :** [ouvrez un ticket](https://github.com/snaraj/obsync/issues/new/choose)
  avec le modèle de rapport de bogue et le rapport décrit dans
  [Dépannage](../troubleshooting.md). N'y mettez aucun jeton, aucune phrase
  de récupération, et aucune adresse que vous ne publieriez pas.
- **Une vulnérabilité soupçonnée :** en privé, via
  [`SECURITY.md`](../../SECURITY.md) — jamais dans un ticket public.

## Licence

MIT. Voir [`LICENSE`](../../LICENSE).
