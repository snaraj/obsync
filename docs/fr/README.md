> Cette traduction suit [l'original en anglais](../../README.md). Le texte anglais fait foi ; les commandes, options, URL et espaces réservés restent inchangés.

<img src="../../brand/obsync-icon-256.png" alt="icône obsync : deux anneaux entrelacés" width="96" height="96">

# Self Hosted Private Sync

Synchronisation en direct, auto-hébergée et chiffrée de bout en bout pour
[Obsidian](https://obsidian.md). Vos notes se synchronisent via un serveur que
vous faites tourner vous-même. Les notes, les pièces jointes et les noms de
fichiers sont chiffrés sur votre appareil, et le serveur ne reçoit jamais la
clé. Le module fonctionne sur toutes les plateformes où tourne Obsidian, sur
ordinateur comme sur mobile. Aucun abonnement, aucun compte ailleurs.

**Quelque chose ne marche pas ? → [Dépannage](https://snaraj.github.io/obsync/troubleshooting/)**

## Trouver ce qu'il vous faut

Toutes les pages sont aussi sur le
[site de documentation](https://snaraj.github.io/obsync/). Les pages liées
sont en anglais.

### Utiliser obsync

| Je veux… | Aller à |
| --- | --- |
| Choisir comment mes appareils joignent mon serveur | [Choisir votre installation](../setup.md) |
| Tout installer sur mon réseau domestique, avec chaque écran du téléphone | [Même réseau, pas à pas](../same-network.md) |
| Installer le module | [Installer le module](../community-plugin.md) |
| Configurer mon premier appareil | [Démarrage rapide](../quickstart.md) |
| Associer un téléphone ou un autre ordinateur | [Associer votre téléphone](../quickstart.md#pair-your-phone) |
| Savoir ce que signifient l'icône d'état et les commandes | [Usage quotidien](../daily-use.md) et [Lire la barre d'état](../troubleshooting.md#reading-the-status-bar) |
| Récupérer une ancienne version d'une note | [Restaurer une version conservée](../daily-use.md#restore-a-retained-version) |
| Savoir ce que fait un réglage | [Réglages](../settings.md) |
| Traiter une copie de conflit | [Conflits](../conflicts.md) |
| Résoudre un problème | [Dépannage](../troubleshooting.md) |
| Retrouver l'accès après avoir perdu un appareil | [Récupération](../recovery.md) |
| Déplacer mon coffre vers un autre serveur | [Déplacer ce coffre vers un autre serveur](../recovery.md#moving-this-vault-to-a-different-server) |

### Faire tourner un serveur

| Je veux… | Aller à |
| --- | --- |
| Faire tourner mon serveur avec Docker ou Compose | [Faire tourner le serveur](../server.md) |
| Le placer derrière mon propre proxy (Caddy, nginx, Traefik, HAProxy) | [Vous avez déjà un terminateur TLS](../server.md#already-have-a-tls-terminator-docker) |
| Le faire tourner sans conteneur, sous systemd | [Le binaire statique](../server.md#without-a-container-the-static-binary) |
| Faire tourner mon serveur sur Kubernetes | [Kubernetes](../kubernetes.md) et la [référence du chart](../../chart/README.md) |
| Joindre mon serveur hors de chez moi, par mon propre VPN ou proxy | [Le joindre depuis l'extérieur de votre LAN](../server.md#reaching-it-from-outside-your-lan) |
| Utiliser Cloudflare (facultatif) | [Cloudflare](cloudflare.md) |
| Faire confiance au certificat de mon serveur sur chaque appareil | [Faire confiance à l'autorité de certification](../server.md#trust-the-certificate-authority-once-per-device) |
| Savoir combien de mémoire et de disque il lui faut | [Combien de mémoire il lui faut](../server.md#how-much-memory-it-needs) et [Stockage](../storage.md) |
| Sauvegarder mon serveur | [Sauvegarder les deux volumes](../server.md#back-up-the-two-volumes) |
| Mettre à jour mon serveur | [Mettre à jour par empreinte](../server.md#upgrade-by-digest) |
| Voir mes appareils et en révoquer un | [Le tableau de bord](../dashboard.md) |
| Effacer mon serveur et repartir de zéro | [Purger un serveur](../purge.md) |
| Voir ce qui a changé à chaque version | [`CHANGELOG.md`](../../CHANGELOG.md) |

### Confiance et vie privée

| Je veux… | Aller à |
| --- | --- |
| Savoir à quoi ce module accède sur mon appareil et mon réseau | [Ce à quoi ce module accède](#ce-à-quoi-ce-module-accède) |
| Comprendre ce qui est chiffré et ce que le serveur peut voir | [Modèle de menace](../threat-model.md) et [le modèle de menace du tableau de bord](../security/dashboard.md) |
| Signaler un problème de sécurité | [`SECURITY.md`](../../SECURITY.md) |

### Dans les coulisses du projet

Pour les contributeurs et les relecteurs : [`CONTRIBUTING.md`](../../CONTRIBUTING.md),
[architecture](../architecture.md), [protocole](../protocol.md),
[benchmarks](../benchmarks.md),
[campagnes de validation sur appareils](../validation-runs/) et
[toutes les pages](../README.md).

## Installer

![Les paramètres du module s'ouvrent sur Get started : la ligne Setup guide et son bouton Open the guide, au-dessus du champ Server URL](../assets/settings-get-started.png)

Installez le module depuis **Paramètres → Modules complémentaires →
Parcourir**. Cherchez **Self Hosted Private Sync** (identifiant du module
`obsync-private-sync`). Il faut Obsidian 1.13.0 ou plus récent. Ses paramètres
s'ouvrent sur le guide d'installation, à un clic.

> [!IMPORTANT]
> - Il se synchronise avec un serveur que **vous** faites tourner : aucun service hébergé, aucun compte ailleurs.
> - Sauvegardez d'abord votre coffre ; conservez la phrase de récupération de 24 mots ailleurs que sur l'appareil qui l'a générée.
> - Ne l'utilisez jamais à côté d'une autre synchronisation (Obsidian Sync, un dossier cloud, un autre module) sur un même coffre.
> - Logiciel jeune : lisez l'entrée de [`CHANGELOG.md`](../../CHANGELOG.md) pour votre version, mettez à jour chaque appareil, et sachez ce que chaque [campagne de validation](../validation-runs/) a couvert.

## Commencer à synchroniser

Le chemin complet le plus court est Compose avec Caddy sur votre propre
réseau, depuis une copie de travail de ce dépôt. Il vous donne du HTTPS sur
n'importe quel réseau, sans domaine et sans compte nulle part.
[Même réseau, pas à pas](../same-network.md) le parcourt avec chaque écran.
Remplacez `vX.Y.Z` ci-dessous par la version que vous installez, le tag le
plus récent de la [page Releases](https://github.com/snaraj/obsync/releases/latest).

**1. Vérifiez l'image.** Puis exécutez exactement l'empreinte que la
commande a affichée :

```sh
cosign verify ghcr.io/snaraj/obsync:vX.Y.Z \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**2. Démarrez le serveur :**

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` est le nom que vos appareils saisiront. Il n'a besoin de
résoudre que sur votre propre réseau. `OBSYNC_BIND_ADDRESS` est l'adresse sur
laquelle les ports 80 et 443 sont publiés : une adresse de liaison limite
l'interface de destination, pas la source, c'est donc votre pare-feu qui
décide qui l'atteint. Compose refuse de démarrer tant que vous n'avez pas
choisi.

**3. Lisez le jeton d'installation.** Au premier démarrage, le serveur émet un
jeton d'installation et l'écrit sur son volume de journal, en mode 0600, sans
jamais le journaliser. Il crée votre compte une seule fois et reste la
connexion de secours au tableau de bord. Gardez-le comme la phrase de
récupération :

```sh
docker exec obsync-obsync-1 obsyncd setup-token
```

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

**4. Configurez chaque appareil.** Faites confiance au certificat du serveur,
une fois ([comment](../server.md#trust-the-certificate-authority-once-per-device)).
Installez le module, puis suivez le [démarrage rapide](../quickstart.md) :
configurez le premier appareil, puis associez les autres.

Vous avez déjà du HTTPS devant, par un proxy ou un tunnel auquel vous faites
confiance ? Lancez plutôt le
[serveur nu](../server.md#already-have-a-tls-terminator-docker).

## Ce à quoi ce module accède

- **Votre serveur, et rien d'autre.** Chaque requête va à la **Server URL** que vous saisissez ; aucune télémétrie, aucun tiers.
- **Un compte sur ce serveur**, créé à partir du jeton d'installation ; votre compte Obsidian n'y joue aucun rôle.
- **Les GitHub Releases, via Obsidian**, pour installer et mettre à jour ; Obsidian ignore les autres fichiers publiés avec la Release.
- **La liste des fichiers de votre coffre**, pour décider quoi synchroniser ; les dossiers cachés (`.obsidian`, `.git`) et ceux qui sont des liens symboliques sont ignorés.
- **Le presse-papiers, en écriture seulement**, par **Copy code** et **Copy link** dans **Pair a new device** ; jamais lu.
- **Votre navigateur, quand vous demandez le guide d'installation.** Le guide du projet s'y ouvre ; le module lui-même n'envoie rien.

Ce que le serveur peut voir et ce qu'il ne peut pas voir : [`SECURITY.md`](../../SECURITY.md) et le [modèle de menace](../threat-model.md).

## Versions

La version LATEST est le tag le plus récent de la
[page Releases](https://github.com/snaraj/obsync/releases/latest). C'est elle
qu'Obsidian installe et vers laquelle il met à jour. `main` est la version
EDGE : du travail fusionné mais pas encore publié, pour qui compile depuis les
sources. Il n'y a ni canal bêta ni tag de préversion. La section
« Unreleased » du journal des modifications consigne ce que contient EDGE.

## Questions, bogues et sécurité

- **Une question, ou pas sûr que ce soit un bogue :** [Discussions](https://github.com/snaraj/obsync/discussions).
- **Un bogue :** [ouvrez un ticket](https://github.com/snaraj/obsync/issues/new/choose) avec le rapport que décrit le [dépannage](../troubleshooting.md#how-to-collect-a-report). Laissez de côté tout jeton, toute phrase et toute adresse que vous ne publieriez pas.
- **Une vulnérabilité soupçonnée :** en privé, via [`SECURITY.md`](../../SECURITY.md), jamais dans un ticket public.

## Licence

MIT. Voir [`LICENSE`](../../LICENSE).
