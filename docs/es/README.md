> Esta traducción sigue el [original en inglés](../../README.md). El texto en inglés es el canónico; los comandos, las opciones, las URL y los marcadores de posición no cambian.

<img src="../../brand/obsync-icon-256.png" alt="icono de obsync: dos anillos entrelazados" width="96" height="96">

# Self Hosted Private Sync

Sincronización en vivo, autoalojada y cifrada de extremo a extremo para
[Obsidian](https://obsidian.md). Tus notas se sincronizan a través de un
servidor que ejecutas tú mismo. Las notas, los adjuntos y los nombres de
archivo se cifran en tu dispositivo, y el servidor nunca recibe la clave. El
plugin funciona en todas las plataformas donde funciona Obsidian, de
escritorio y móviles. No hay suscripción ni cuenta en ningún otro sitio.

**¿Algo no funciona? → [Resolución de problemas](https://snaraj.github.io/obsync/troubleshooting/)**

## Encuentra lo que necesitas

Todas las páginas están también en el
[sitio de documentación](https://snaraj.github.io/obsync/). Las páginas
enlazadas están en inglés.

### Usar obsync

| Quiero… | Ve a |
| --- | --- |
| Elegir cómo llegan mis dispositivos a mi servidor | [Elige tu configuración](../setup.md) |
| Configurarlo todo en mi red de casa, con cada pantalla del teléfono | [Misma red, paso a paso](../same-network.md) |
| Instalar el plugin | [Instalar el plugin](../community-plugin.md) |
| Configurar mi primer dispositivo | [Inicio rápido](../quickstart.md) |
| Emparejar un teléfono u otro ordenador | [Empareja tu teléfono](../quickstart.md#pair-your-phone) |
| Saber qué significan el icono de estado y los comandos | [Uso diario](../daily-use.md) y [Leer la barra de estado](../troubleshooting.md#reading-the-status-bar) |
| Recuperar una versión anterior de una nota | [Restaurar una versión conservada](../daily-use.md#restore-a-retained-version) |
| Saber qué hace un ajuste | [Ajustes](../settings.md) |
| Resolver una copia de conflicto | [Conflictos](../conflicts.md) |
| Arreglar un problema | [Resolución de problemas](../troubleshooting.md) |
| Volver a entrar tras perder un dispositivo | [Recuperación](../recovery.md) |
| Llevar mi bóveda a otro servidor | [Mover esta bóveda a otro servidor](../recovery.md#moving-this-vault-to-a-different-server) |

### Ejecutar un servidor

| Quiero… | Ve a |
| --- | --- |
| Ejecutar mi servidor con Docker o Compose | [Ejecutar el servidor](../server.md) |
| Ponerlo detrás de mi propio proxy (Caddy, nginx, Traefik, HAProxy) | [Si ya tienes un terminador TLS](../server.md#already-have-a-tls-terminator-docker) |
| Ejecutarlo sin contenedor, con systemd | [El binario estático](../server.md#without-a-container-the-static-binary) |
| Ejecutar mi servidor en Kubernetes | [Kubernetes](../kubernetes.md) y la [referencia del chart](../../chart/README.md) |
| Llegar a mi servidor fuera de casa, con mi propia VPN o mi proxy | [Llegar desde fuera de tu LAN](../server.md#reaching-it-from-outside-your-lan) |
| Usar Cloudflare (opcional) | [Cloudflare](cloudflare.md) |
| Confiar en el certificado de mi servidor en cada dispositivo | [Confiar en la autoridad de certificación](../server.md#trust-the-certificate-authority-once-per-device) |
| Saber cuánta memoria y cuánto disco necesita | [Cuánta memoria necesita](../server.md#how-much-memory-it-needs) y [Almacenamiento](../storage.md) |
| Hacer copia de seguridad de mi servidor | [Copiar los dos volúmenes](../server.md#back-up-the-two-volumes) |
| Actualizar mi servidor | [Actualizar por digest](../server.md#upgrade-by-digest) |
| Ver mis dispositivos y revocar uno | [El panel](../dashboard.md) |
| Borrar mi servidor y empezar de nuevo | [Purgar un servidor](../purge.md) |
| Ver qué cambió en cada versión | [`CHANGELOG.md`](../../CHANGELOG.md) |

### Confianza y privacidad

| Quiero… | Ve a |
| --- | --- |
| Saber a qué accede este plugin en mi dispositivo y en mi red | [A qué accede este plugin](#a-qué-accede-este-plugin) |
| Entender qué se cifra y qué puede ver el servidor | [Modelo de amenazas](../threat-model.md) y [el modelo de amenazas del panel](../security/dashboard.md) |
| Informar de un problema de seguridad | [`SECURITY.md`](../../SECURITY.md) |

### Dentro del proyecto

Para quien contribuye o revisa: [`CONTRIBUTING.md`](../../CONTRIBUTING.md),
[arquitectura](../architecture.md), [protocolo](../protocol.md),
[benchmarks](../benchmarks.md),
[ejecuciones de validación en dispositivos](../validation-runs/) y
[todas las páginas](../README.md).

## Instalar

![Los ajustes del plugin se abren con Get started: la fila Setup guide y su botón Open the guide, encima del campo Server URL](../assets/settings-get-started.png)

Instala el plugin desde **Preferencias → Complementos comunitarios → Buscar**.
Busca **Self Hosted Private Sync** (id del plugin `obsync-private-sync`).
Necesita Obsidian 1.13.0 o posterior. Sus ajustes se abren con la guía de
configuración, a un toque.

> [!IMPORTANT]
> - Sincroniza con un servidor que ejecutas **tú**: sin servicio alojado, sin cuenta en ningún otro sitio.
> - Haz antes una copia de seguridad de tu bóveda; guarda la frase de recuperación de 24 palabras fuera del dispositivo que la generó.
> - No lo uses nunca junto a otra sincronización (Obsidian Sync, una carpeta en la nube, otro plugin) en una misma bóveda.
> - Software joven: lee la entrada del [`CHANGELOG.md`](../../CHANGELOG.md) de tu versión, actualiza todos los dispositivos y ten claro qué cubrió cada [ejecución de validación](../validation-runs/).

## Empezar a sincronizar

El camino completo más corto es Compose con Caddy en tu propia red, desde una
copia de este repositorio. Te da HTTPS en cualquier red, sin dominio y sin
cuenta en ningún sitio. [Misma red, paso a paso](../same-network.md) lo
recorre con cada pantalla. Sustituye abajo `vX.Y.Z` por la versión que estás
instalando: la etiqueta más reciente de la
[página de Releases](https://github.com/snaraj/obsync/releases/latest).

**1. Verifica la imagen.** Después ejecuta exactamente el digest que imprimió:

```sh
cosign verify ghcr.io/snaraj/obsync:vX.Y.Z \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**2. Arranca el servidor:**

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` es el nombre que escribirán tus dispositivos. Solo tiene que
resolver en tu propia red. `OBSYNC_BIND_ADDRESS` es la dirección en la que se
publican los puertos 80 y 443: una dirección de enlace limita la interfaz de
destino, no el origen, así que es tu cortafuegos el que decide quién llega.
Compose se niega a arrancar hasta que hayas elegido.

**3. Lee el token de configuración.** En el primer arranque el servidor genera
un token de configuración y lo escribe en su volumen de diario, con modo 0600,
sin registrarlo nunca. Crea tu cuenta una vez y sigue siendo el inicio de
sesión de recuperación del panel. Guárdalo como la frase de recuperación:

```sh
docker exec obsync-obsync-1 obsyncd setup-token
```

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

**4. Configura cada dispositivo.** Confía en el certificado del servidor una
vez ([cómo](../server.md#trust-the-certificate-authority-once-per-device)).
Instala el plugin y sigue el [Inicio rápido](../quickstart.md): configura el
primer dispositivo y después empareja los demás.

¿Ya tienes HTTPS delante, con un proxy o un túnel en el que confías? Ejecuta
en su lugar el
[servidor a pelo](../server.md#already-have-a-tls-terminator-docker).

## A qué accede este plugin

- **Tu servidor y nada más.** Cada petición va a la **Server URL** que escribes; sin telemetría, sin terceros.
- **Una cuenta en ese servidor**, creada con el token de configuración; tu cuenta de Obsidian no interviene.
- **Las Releases de GitHub, a través de Obsidian**, para instalar y actualizar; Obsidian ignora los demás archivos de la Release.
- **La lista de archivos de tu bóveda**, para decidir qué se sincroniza; se omiten las carpetas ocultas (`.obsidian`, `.git`) y las enlazadas simbólicamente.
- **El portapapeles, solo para escribir**, con **Copy code** y **Copy link** en **Pair a new device**; nunca lo lee.
- **Tu navegador, cuando pides la guía de configuración.** Abre allí la guía del proyecto; el plugin en sí no envía nada.

Lo que el servidor puede y no puede ver: [`SECURITY.md`](../../SECURITY.md) y el [modelo de amenazas](../threat-model.md).

## Versiones

La versión LATEST es la etiqueta más reciente de la
[página de Releases](https://github.com/snaraj/obsync/releases/latest). Es la
que Obsidian instala y a la que actualiza. `main` es EDGE: trabajo ya
fusionado pero sin publicar, para quien compila desde el código fuente. No hay
canal beta ni etiquetas de prelanzamiento. La sección «Unreleased» del
registro de cambios recoge lo que hay en EDGE.

## Preguntas, errores y seguridad

- **Una pregunta, o algo que no estás seguro de que sea un error:** [Discussions](https://github.com/snaraj/obsync/discussions).
- **Un error:** [abre un issue](https://github.com/snaraj/obsync/issues/new/choose) con el informe que describe [Resolución de problemas](../troubleshooting.md#how-to-collect-a-report). Deja fuera cualquier token, frase o dirección que no publicarías.
- **Una posible vulnerabilidad:** en privado, a través de [`SECURITY.md`](../../SECURITY.md); nunca en un issue público.

## Licencia

MIT. Ver [`LICENSE`](../../LICENSE).
