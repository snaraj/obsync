> Cette traduction suit [l'original en anglais](../cloudflare.md). Le texte anglais fait foi ; les commandes, options, URL et espaces réservés restent inchangés.

# Cloudflare

Deux façons de placer Cloudflare entre vos appareils et votre serveur, et
laquelle utilise le déploiement de référence. Aucune n'est obligatoire : le
serveur ne connaît aucun fournisseur par son nom, et
[Faire tourner le serveur](../server.md) n'exige de compte chez personne.
Cette page s'adresse à vous si vous voulez joindre le serveur hors de chez
vous sans ouvrir de port sur votre routeur, ou si vous voulez un nom d'hôte
publié avec une politique d'accès devant.

Les menus de Cloudflare et les conditions de ses offres changent. Chaque
étape ci-dessous nomme le chemin de menu tel que la documentation Cloudflare
le donnait le 2026-09-22 ; vérifiez la page actuelle avant de vous fier à une
limite ou à un prix.

## Quelle variante

| Variante | Ce que voient les appareils | Ce que voit Internet | Première synchronisation volumineuse |
| --- | --- | --- | --- |
| **Route privée** (le déploiement de référence) | votre propre adresse privée et votre nom, via le client Cloudflare One | rien : ni nom d'hôte ni port ouvert | trafic de réseau privé, sans passer par un nom d'hôte public |
| **Nom d'hôte public avec Access** | un nom public, une politique Access, un jeton de service dans le plugin | le nom d'hôte, derrière Access | relayé par Cloudflare, aux conditions du fournisseur pour les gros fichiers |

La route privée est la référence parce que le serveur reste invisible et
parce que la documentation de Cloudflare elle-même y envoie les gros
transferts : une route par nom d'hôte public fait passer le trafic par
Cloudflare, et sur les offres Free, Pro et Business les conditions propres au
service exigent un service payant pour la vidéo et les autres gros fichiers,
alors qu'une route de réseau privé les transporte comme votre propre trafic.
Faites la première synchronisation volumineuse sur le LAN dans les deux cas.

Ce qui termine TLS lit vos identifiants et jamais vos notes : chaque bloc et
chaque manifeste sont chiffrés sur l'appareil, et aucune clé capable de les
déchiffrer ne traverse le réseau ([modèle de menace](../threat-model.md)).
Sur la route privée, le terminateur est le vôtre, dans votre réseau. Avec le
nom d'hôte public, la bordure est elle aussi un terminateur.

## Variante A : une route privée et le client Cloudflare One

Le serveur garde une adresse privée sur votre propre réseau. Un connecteur de
tunnel tourne à côté, une route indique à Cloudflare quelles adresses se
trouvent derrière ce tunnel, et le client Cloudflare One (anciennement WARP)
sur chaque appareil achemine le trafic vers ces adresses à travers le tunnel.
L'URL du serveur que saisissent vos appareils est un nom privé qui résout
vers cette adresse privée.

Ce qu'il vous faut : un compte Cloudflare avec une organisation Zero Trust
(un « nom d'équipe »), une machine sur le réseau du serveur capable de faire
tourner le connecteur de tunnel, et le client Cloudflare One sur chaque
appareil qui synchronisera hors de chez vous.

1. **Créez un tunnel.** Dans le tableau de bord Cloudflare, allez dans
   **Networking** > **Tunnels** et créez un tunnel `cloudflared`. Lancez le
   connecteur qu'il vous donne sur une machine du réseau du serveur : dans le
   cluster à côté du serveur, ou sur le même hôte.
2. **Routez l'adresse privée du serveur par le tunnel.** Allez dans
   **Networking** > **Routes**, choisissez **Create route** > **Tunnel CIDR**,
   sélectionnez le tunnel et saisissez l'adresse privée ou le sous-réseau du
   serveur. Une seule adresse suffit ; un sous-réseau peut être élargi plus
   tard.
3. **Inscrivez chaque appareil.** Installez le client Cloudflare One,
   saisissez votre nom d'équipe, terminez la connexion exigée par votre
   organisation et activez la connexion. Sur iOS et Android, le client demande
   à installer un profil VPN ; acceptez. Réglez les permissions d'inscription
   des appareils pour que seule votre propre identité puisse en inscrire.
4. **Envoyez la plage privée par le client.** Dans la configuration Split
   Tunnels du client, assurez-vous que l'adresse de l'étape 2 est routée par le
   client. En mode **Exclude**, retirez le bloc RFC 1918 qui la contient et
   rajoutez les plages que vous voulez encore exclure ; en mode **Include**,
   ajoutez l'adresse ou le sous-réseau.
5. **Faites résoudre le nom sur l'appareil.** Le plugin envoie chaque requête
   à l'URL du serveur que vous avez saisie, donc ce nom doit résoudre sur
   l'appareil itinérant : une route de nom d'hôte, Local Domain Fallback vers
   votre propre résolveur, ou une entrée DNS privée. Un nom qui résout vers
   une adresse que le client ne route pas échoue exactement comme un serveur
   hors ligne.
6. **Terminez TLS vous-même.** La route porte votre trafic jusqu'à votre
   propre terminateur : un ingress ou un reverse proxy devant le serveur avec
   un certificat auquel chaque appareil fait confiance, comme dans
   [Faire tourner le serveur](../server.md). Le serveur tourne avec
   `OBSYNC_EDGE=none` et ne fait confiance aux adresses transmises qu'en
   provenance de `OBSYNC_TRUSTED_PROXY_CIDRS`, la plage du terminateur
   lui-même.
7. **Filtrez éventuellement avec Gateway.** Une politique réseau Gateway peut
   n'autoriser que vos appareils inscrits à joindre l'adresse et le port du
   serveur, et bloquer tout le reste sur cette route.
8. **Vérifiez depuis un appareil hors de votre réseau.** Ouvrez l'URL du
   serveur dans un navigateur de cet appareil et attendez-vous à la page de
   connexion du tableau de bord. Dans le plugin, choisissez **Check** sous
   **Connection** : un seul aller-retour prouve à la fois l'adresse, le
   certificat et l'identifiant.

Compromis :

- Chaque appareil qui synchronise fait tourner le client Cloudflare One, et le
  client doit être connecté pour que la synchronisation hors de chez vous
  fonctionne.
- Cloudflare transporte le trafic entre l'appareil et le connecteur de tunnel.
  Laissez le déchiffrement TLS de Gateway désactivé ; le trafic lui est alors
  opaque au-delà des adresses, des tailles et des horaires, ce que le
  [modèle de menace](../threat-model.md) concède déjà à tout chemin réseau.
- Le connecteur est un processus sur votre réseau qui garde ouverte une
  connexion sortante vers Cloudflare. Quand il tombe, les appareils itinérants
  affichent `obsync: offline` tandis que le LAN continue de fonctionner.

## Variante B : un nom d'hôte public derrière Access

Le serveur reçoit un nom d'hôte sur un domaine que vous avez chez Cloudflare.
Le tunnel publie ce nom vers l'adresse privée du serveur, et Cloudflare
Access se place devant : une politique d'identité pour le tableau de bord et
un jeton de service pour les appels d'API du plugin. C'est la variante que
[l'intégration à la plateforme](../platform-onboarding.md) décrit pour le
cluster de référence, et celle que le déploiement de référence n'a pas
retenue.

1. **Publiez le nom d'hôte.** Dans la configuration du tunnel, ajoutez une
   route d'application publiée de votre nom d'hôte (`sync.example.com` tient
   lieu du vôtre) vers l'adresse HTTP privée du serveur, port 8080.
   Cloudflare crée l'enregistrement DNS.
2. **Placez Access devant.** Allez dans **Zero Trust** > **Access controls** >
   **Applications**, créez une application **Self-hosted** sur ce nom d'hôte
   et ajoutez une politique d'identité qui n'autorise que vous, par exemple un
   code PIN à usage unique envoyé à votre propre adresse, pour le tableau de
   bord.
3. **Créez un jeton de service pour le plugin.** Allez dans **Zero Trust** >
   **Access controls** > **Service credentials** > **Service Tokens**, créez-en
   un et copiez le Client ID et le Client Secret ; le secret n'est affiché
   qu'une fois. Ajoutez à l'application une politique **Service Auth** qui
   inclut ce jeton, pour les chemins qu'utilise le plugin (`/v1/*`).
4. **Collez le jeton dans le plugin.** Sous **Edge service-token headers**, un
   par ligne, exactement comme Cloudflare les nomme :

   ```text
   CF-Access-Client-Id: <the client id>
   CF-Access-Client-Secret: <the client secret>
   ```

   Ils accompagnent chaque requête vers l'URL du serveur, et rien d'autre.
5. **Dites au serveur qu'il est derrière la bordure.** Lancez-le avec
   `OBSYNC_EDGE=cloudflare`. Dans ce mode, chaque requête doit porter les
   en-têtes de la bordure indiquant l'adresse de connexion et l'identifiant de
   requête, et une requête qui arrive en contournant la bordure est refusée
   avec `421 edge_required` ([dépannage](../troubleshooting.md#edge_required)).
6. **Vérifiez.** Ouvrez le nom d'hôte dans un navigateur et attendez-vous à la
   connexion Access, puis au tableau de bord. Dans le plugin, choisissez
   **Check** sous **Connection**.

Compromis :

- Le nom d'hôte est public. Access refuse les inconnus, et le serveur
  authentifie toujours lui-même chaque requête d'appareil, mais le nom existe
  et peut être découvert.
- Le jeton de service est un identifiant. Quiconque le détient atteint la
  porte d'entrée de l'API ; l'authentification des appareils par le serveur
  reste derrière. Faites-le tourner dans Cloudflare s'il est un jour exposé.
- Les gros transferts passent par Cloudflare aux conditions ci-dessus. Faites
  la première synchronisation volumineuse sur le LAN.
- Les en-têtes de la bordure indiquant l'adresse de connexion et le pays sont
  ce que la page Appareils du tableau de bord affiche comme adresse et pays
  dans ce mode.

## Ce qui a été prouvé

La route privée est la route du déploiement de référence. La
[campagne du 2026-09-14](../validation-runs/2026-09-14.md) note qu'elle n'a
pas été exercée ce jour-là, et pourquoi ; la
[campagne du 2026-09-20](../validation-runs/2026-09-20.md) enregistre une
campagne sur appareils sur la route de référence, avec les vérifications de
connectivité et de TLS réussies. La variante à nom d'hôte public n'a été
exercée par aucune campagne enregistrée.

## Ensuite

- [Faire tourner le serveur](../server.md) : le terminateur, les volumes, le
  jeton d'installation.
- [Kubernetes](../../chart/README.md) : le chart qu'utilise le déploiement
  de référence.
- [Intégration à la plateforme](../platform-onboarding.md) : ce que le
  cluster de référence ajouterait pour un nom d'hôte publié.
- [Dépannage](../troubleshooting.md) : `edge_required`, `offline` et le
  certificat.
