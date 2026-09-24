> Esta traducción sigue el [original en inglés](../../README.md). El texto en inglés es el canónico; los comandos, las opciones, las URL y los marcadores de posición no cambian.

<img src="../../brand/obsync-icon-256.png" alt="icono de obsync: dos anillos entrelazados" width="96" height="96">

# Self Hosted Private Sync

Sincronización en vivo, autoalojada y cifrada de extremo a extremo para
[Obsidian](https://obsidian.md): un servidor en Rust sin dependencias, con
panel integrado, que ejecutas tú mismo, más este plugin. Archivos de cualquier
tamaño, todas las plataformas de Obsidian, sin suscripción, sin terceros.

Instálalo desde Preferencias → Complementos comunitarios → Buscar como **Self
Hosted Private Sync** (id del plugin `obsync-private-sync`), en Obsidian 1.13.0
o posterior.

**¿Primera vez? Empieza por la [guía de configuración](https://snaraj.github.io/obsync/setup/) (en inglés).** Te ayuda a elegir cómo llegan tus dispositivos a tu servidor y recorre cada opción paso a paso. En Obsidian: Ajustes → Self Hosted Private Sync → Setup guide.

> [!IMPORTANT]
> - Sincroniza con un servidor que ejecutas **tú**: sin servicio alojado, sin
>   cuenta en ningún otro sitio.
> - Haz antes una copia de seguridad de tu bóveda; guarda la frase de
>   recuperación de 24 palabras fuera del dispositivo que la generó.
> - No lo uses nunca junto a otra sincronización (Obsidian Sync, una carpeta en
>   la nube, otro plugin) en una misma bóveda.
> - Software joven: lee la entrada del [`CHANGELOG.md`](../../CHANGELOG.md) de
>   tu versión, actualiza todos los dispositivos y ten claro qué cubrió cada
>   [ejecución de validación](../validation-runs/).

## A qué accede este plugin

- **Tu servidor y nada más.** Cada petición va a la **Server URL** que
  escribes; sin telemetría, sin terceros.
- **Una cuenta en ese servidor**, creada con el token de configuración; tu
  cuenta de Obsidian no interviene.
- **Las Releases de GitHub, a través de Obsidian**, para instalar y actualizar;
  Obsidian ignora los demás archivos de la Release.
- **La lista de archivos de tu bóveda**, para decidir qué se sincroniza; se
  omiten las carpetas ocultas (`.obsidian`, `.git`) y las de enlaces
  simbólicos.
- **El portapapeles, solo escrito** por **Copy code** y **Copy link** en **Pair
  a new device**, nunca leído.

Lo que el servidor puede y no puede ver: [`SECURITY.md`](../../SECURITY.md) y
el [modelo de amenazas](../threat-model.md).

## Empezar a sincronizar

Cinco pasos desde cero hasta dos dispositivos sincronizados. `v1.0.6` es la
versión con la que se escribió esta página; usa la etiqueta de la versión que
estás instalando.

### 1. Arranca el servidor

Verifica la firma y después ejecuta exactamente el digest que imprimió:

```sh
cosign verify ghcr.io/snaraj/obsync:v1.0.6 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

El camino sencillo es Compose con Caddy, desde una copia de este repositorio:
HTTPS en cualquier red, sin dominio y sin cuenta con nadie.

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` es el nombre que escribirán tus dispositivos; solo tiene que
resolver en tu propia red. `OBSYNC_BIND_ADDRESS` es la dirección en la que se
publican los puertos 80 y 443: una dirección de enlace limita la interfaz de
destino, no el origen, así que es tu cortafuegos el que decide quién llega.
Compose se niega a arrancar hasta que hayas elegido.

¿Ya tienes HTTPS delante, con un proxy o un túnel en el que confías? Ejecuta
entonces el servidor a pelo: [Ejecutar el servidor](../server.md).

### 2. Lee el token de configuración

En el primer arranque el servidor acuña un token de configuración y lo escribe
en su volumen de diario, con modo 0600, sin registrarlo nunca. Crea tu cuenta
una vez y después sigue siendo el inicio de sesión de recuperación del panel:
guárdalo con el mismo cuidado que la frase de recuperación. Léelo desde el
contenedor:

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

### 3. Confía en el certificado, una vez por dispositivo

Caddy firma con una autoridad que generó en el primer arranque; cada
dispositivo tiene que confiar en ella una vez. Exporta el certificado raíz e
instálalo en cada plataforma como muestra
[Ejecutar el servidor](../server.md#trust-the-certificate-authority-once-per-device);
en iOS, confiar en él es un segundo interruptor tras instalarlo.

### 4. Configura el primer dispositivo

1. Preferencias → Complementos comunitarios → Buscar → **Self Hosted Private
   Sync** → Instalar → Activar.
2. Pon en **Server URL** tu servidor (`https://sync.example.org`, con el puerto
   salvo que sea el 443) y elige después **Whole vault** o **Selected folders
   only**; más adelante solo puede estrecharse.

   ![La pestaña de ajustes del plugin: el campo Server URL con un nombre de host de demostración, la caja de cabeceras de edge y la fila Connection con sus botones Check y Open dashboard](../assets/settings-server.png)

3. Pega el token de configuración en **First-time setup**, pulsa **Set up** y
   apunta la frase de recuperación de 24 palabras.

   ![La sección This device de la pestaña de ajustes: la fila Pairing con Pair this device y Pair a new device, la fila First-time setup con el campo Setup token y el botón Set up, y la fila Vault key](../assets/settings-setup.png)

### 5. Empareja el segundo dispositivo

1. Instala allí el plugin con la misma **Server URL**; en el primer dispositivo,
   ejecuta **Pair a new device** para obtener un código válido durante diez
   minutos.

   ![El diálogo Pair a new device en el primer dispositivo, con su código oculto, los botones Copy code y Copy link y la línea Waiting for the new device](../assets/pair-new-device.png)

2. En el segundo dispositivo, abre **Pair this device**, pega el código y pulsa
   **Pair**.
3. De vuelta en el primer dispositivo, apruébalo por su nombre. Edita una nota
   en cualquiera de los dos; aparece en el otro en segundos.

   ![El primer dispositivo preguntando si aprobar el nuevo dispositivo por su nombre, con los botones Approve y Reject](../assets/pair-approve.png)

![Animación: el código de emparejamiento mostrado en el primer dispositivo, pegado en el segundo, aprobado en el primero y la primera nota llegando al segundo](../assets/pairing.gif)

¿Lo pruebas en un solo ordenador? `http://127.0.0.1:8080` llega al servidor a
pelo en un ordenador; Obsidian en iOS y Android rechaza el HTTP plano.

Las capturas de teléfono aún no están en este repositorio; se toman en los
propios dispositivos del mantenedor y se añaden cuando una ejecución de
validación las registra.

Cada paso al completo: [Inicio rápido](../quickstart.md).

## Avanzado: Cloudflare

La instalación de referencia no tiene nombre de host público: un Cloudflare
Tunnel y una ruta privada llegan a la red del servidor, y el cliente Cloudflare
One de cada dispositivo lleva allí la Server URL. También funciona un nombre de
host público detrás de Cloudflare Access, con un token de servicio en **Edge
service-token headers** y `OBSYNC_EDGE=cloudflare`. Las dos, paso a paso:
[Cloudflare](cloudflare.md).

## Otras maneras de llegar a tu servidor

Elijas lo que elijas, el plugin necesita HTTPS con un certificado en el que
confíen todos los dispositivos; el servidor sigue en HTTP plano detrás de ese
terminador.

- **Solo LAN.** El camino de Compose de arriba, accesible solo en casa; sin
  sincronización fuera.
- **WireGuard.** Tu propia VPN de vuelta a casa: lo más rápido y enteramente
  tuyo; una configuración de par en cada dispositivo.
- **Tailscale.** Una malla WireGuard gestionada: la menor configuración; un
  tercero la coordina, con las condiciones de su plan.
- **Un proxy inverso con TLS automático**, como Caddy en un nombre público:
  accesible desde internet, y a ti te toca mantenerlo al día.
- **Cloudflare Tunnel.** Arriba. Sin puerto entrante; un proveedor en el
  camino, con sus condiciones.

Lo que necesita un dispositivo itinerante (la ruta, el nombre, el certificado,
el cortafuegos, el aviso de red local de iOS):
[Llegar desde fuera de tu LAN](../server.md#reaching-it-from-outside-your-lan).

## Resolución de problemas

| Síntoma | Causa probable | Lo primero que probar |
| --- | --- | --- |
| `obsync: offline` | El dispositivo no llega a la Server URL | Abre la URL en un navegador del mismo dispositivo; revisa el puerto, HTTPS y la ruta |
| Un teléfono no conecta mientras un ordenador sincroniza | El certificado privado no es de confianza en el teléfono | Instala el certificado raíz; en iOS actívalo además en «Ajustes de confianza de certificados» |
| `401 stale_timestamp` | Un reloj está desviado más de 300 segundos | Activa la hora automática, en el dispositivo o en el servidor |
| `403 device_pending` | Nadie ha aprobado todavía el dispositivo | Apruébalo por su nombre en el dispositivo desde el que emparejaste |
| Un archivo nunca llega | Está fuera de la selección de carpetas, o por encima del límite de tamaño de un teléfono | Revisa **Sync folders on this device**; en el teléfono ejecuta **Show remote-only files** |

Cualquier otro síntoma y código de error, y cómo informar de uno:
[Resolución de problemas](../troubleshooting.md).

## Documentación

[Inicio rápido](../quickstart.md) · [Ejecutar el servidor](../server.md) ·
[Cloudflare](cloudflare.md) · [Uso diario](../daily-use.md) ·
[Ajustes](../settings.md) · [Resolución de problemas](../troubleshooting.md) ·
[Recuperación](../recovery.md) · [Registro de cambios](../../CHANGELOG.md)

Todo lo demás: [docs/README.md](../README.md).

## Preguntas, errores y seguridad

- **Una pregunta, o algo que no estás seguro de que sea un error:**
  [Discussions](https://github.com/snaraj/obsync/discussions).
- **Un error:** [abre un issue](https://github.com/snaraj/obsync/issues/new/choose)
  con el informe que describe [Resolución de problemas](../troubleshooting.md);
  sin ningún token, sin la frase de recuperación y sin ninguna dirección que no
  publicarías.
- **Una posible vulnerabilidad:** en privado, a través de
  [`SECURITY.md`](../../SECURITY.md); nunca en un issue público.

## Licencia

MIT. Ver [`LICENSE`](../../LICENSE).
