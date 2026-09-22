> Esta traducción sigue el [original en inglés](../../README.md). El texto en inglés es el canónico; los comandos, las opciones, las URL y los marcadores de posición no cambian.

# Self Hosted Private Sync

Sincronización en vivo, autoalojada y cifrada de extremo a extremo para
[Obsidian](https://obsidian.md): un servidor en Rust sin dependencias, con
panel integrado, que ejecutas tú mismo, más este plugin. Archivos de cualquier
tamaño, todas las plataformas de Obsidian, sin suscripción, sin terceros.

Instálalo desde Preferencias → Complementos comunitarios → Buscar como **Self
Hosted Private Sync** (id del plugin `obsync-private-sync`), en Obsidian 1.13.0
o posterior.

> [!IMPORTANT]
> Este plugin sincroniza con un servidor que ejecutas **tú**. No hay servicio
> alojado ni cuenta con nadie más que contigo: sin tu propio `obsyncd`
> accesible por HTTPS, el plugin no tiene con qué sincronizar.

> [!IMPORTANT]
> Haz una copia de seguridad de tu bóveda antes de la primera sincronización, y
> guarda la frase de recuperación de 24 palabras en un lugar distinto del
> dispositivo que la generó. El servidor solo almacena texto cifrado y no puede
> recuperar una bóveda por ti.

> [!IMPORTANT]
> No uses este plugin junto a otra solución de sincronización en la misma
> bóveda: Obsidian Sync, una carpeta en la nube que sincronice archivos u otro
> plugin de sincronización. Dos escritores sobre una bóveda producen conflictos
> que ninguno de los dos puede resolver.

## Antes de confiar en él

Este es software joven que sincroniza la única copia de tus notas.

- **[`CHANGELOG.md`](../../CHANGELOG.md) es la lista mantenida de lo que se
  sabe.** Lee la entrada de la versión que usas y las entradas por encima. Las
  páginas de cada versión conservan las notas con las que se publicaron; los
  hallazgos posteriores se añaden aquí.
- **Actualiza todos los dispositivos que sincronizan una bóveda.** Un solo
  dispositivo que se quede en una versión anterior puede seguir actuando con
  el comportamiento antiguo y afectar a los demás.
- **Lo que se ha ejercitado de verdad en hardware** queda registrado por
  ejecución en [`docs/validation-runs/`](../validation-runs/), incluido lo que
  cada ejecución no cubrió. Una plataforma que ninguna ejecución nombra no está
  probada.
- **Un torrente de avisos «merged concurrent edits»** en dos dispositivos que
  editan una misma nota: cierra Obsidian en uno de ellos para que el otro
  pueda vaciar su trabajo pendiente, actualiza los dos y continúa.

## A qué accede este plugin

Breve y completo, para que decidas antes de instalar.

- **Un único destino de red: tu propio servidor.** Cada petición va a la
  **Server URL** que escribes en los ajustes del plugin, y a nada más. No hay
  telemetría, ni analítica, ni informes de fallos, ni publicidad, ni ningún
  servicio de terceros en ninguna parte del camino de sincronización. El
  plugin tampoco descarga ni ejecuta nunca código de ese servidor.
- **Una cuenta en ese servidor, que creas tú.** El primer dispositivo usa el
  token de configuración que tu servidor escribió en el primer arranque; cada
  dispositivo siguiente se empareja desde uno que ya sincroniza. Tu cuenta de
  Obsidian no interviene.
- **Obsidian y GitHub, solo para instalar y actualizar.** Es el propio Obsidian
  quien descarga `main.js`, `manifest.json` y `styles.css` desde las Releases
  de GitHub de este repositorio. Cada Release lleva además un ZIP del plugin y
  un manifiesto de la versión para quienes despliegan el servidor; Obsidian
  ignora ambos.
- **Tu edge, solo si configuraste uno.** Las cabeceras que pegas en **Edge
  service-token headers** viajan con cada petición a la Server URL de arriba,
  porque el proxy que las necesita está en el camino hacia tu servidor.
- **La lista de archivos de tu bóveda.** El plugin lista todos los archivos de
  la bóveda para decidir qué entra en el alcance, lee los que están dentro de
  tu selección de carpetas y escribe lo que otros dispositivos cambiaron. Las
  carpetas ocultas (`.obsidian`, `.git`) y las carpetas con enlaces simbólicos
  se omiten.
- **El portapapeles, escrito y nunca leído.** Solo los botones **Copy code** y
  **Copy link** de **Pair a new device** escriben en él. Nada en el plugin lee
  el portapapeles.
- **Tu navegador, cuando pides el panel.** **Open dashboard** abre un enlace
  de inicio de sesión en tu navegador, y solo cuando ese enlace está en el
  origen de tu propio servidor.
- **El almacenamiento secreto de Obsidian.** La clave de la bóveda, el secreto
  del dispositivo y cualquier valor de cabecera de edge viven ahí, nunca en
  datos de plugin en claro.

Lo que el servidor puede y no puede ver está en
[`SECURITY.md`](../../SECURITY.md) y en
[`docs/threat-model.md`](../threat-model.md).

## Sincronizado en cinco pasos

El camino con el que se validó esta versión, desde una bóveda vacía hasta dos
dispositivos sincronizados. Los cinco dan por hecho que tu propio servidor ya
está en marcha, que es la sección siguiente; cada paso está escrito por
completo en el inicio rápido.

1. **Instala desde Complementos comunitarios.** En Preferencias → Complementos
   comunitarios → Buscar, busca **Self Hosted Private Sync** y pulsa
   Instalar y después Activar, igual que llega cualquier otro plugin de
   Obsidian, en todas las plataformas.

   ![El explorador de complementos comunitarios de Obsidian mostrando Self Hosted Private Sync con su botón Instalar](../captures/01-install-from-directory.png)

2. **Apúntalo a tu servidor y configúralo.** Abre la pestaña de ajustes del
   plugin, pon en **Server URL** tu propio servidor, elige qué carpetas
   sincroniza este dispositivo y pega tu token de configuración en
   **First-time setup**.

   ![La pestaña de ajustes del plugin desplazada hasta la selección de carpetas, Pairing y el campo del token en First-time setup](../captures/02-first-time-setup.png)

3. **Guarda la frase de recuperación.** La configuración genera la clave de la
   bóveda en este dispositivo y muestra una sola vez una frase de 24 palabras:
   apúntala y guárdala en otro lugar que no sea este dispositivo, porque el
   servidor solo guarda texto cifrado y no puede recuperar una bóveda por ti.

   ![El diálogo de la frase de recuperación tras la configuración inicial, con las palabras ocultas](../captures/03-recovery-phrase.png)

4. **Empareja un segundo dispositivo con un código de un solo uso.** Ejecuta
   **Pair a new device** en el primer dispositivo, introduce en el segundo el
   código que muestra antes de diez minutos y aprueba el dispositivo por su
   nombre: la clave de la bóveda viaja cifrada bajo un secreto de
   emparejamiento que el servidor nunca ve.

   ![El diálogo Pair a new device en el primer dispositivo, con su código de un solo uso oculto](../captures/04-pair-a-new-device.png)

5. **Edita en cualquiera de los dos y mira cómo llega.** Escribe en una nota
   en un dispositivo y aparece en el otro en segundos, en ambas direcciones,
   con la barra de estado mostrando qué hace la sincronización.

   ![La nota desechable con las ediciones de ambos dispositivos, con la barra de estado de sincronización visible](../captures/05-sync-both-ways.png)

La lista de dispositivos del panel y su botón de revocar se describen en
[Ver tus dispositivos](../daily-use.md#see-your-devices) y no se ejercitaron en
la ejecución con dispositivos de 1.0.0 registrada en
[docs/validation-runs/2026-09-14.md](../validation-runs/2026-09-14.md).

## Empezar a sincronizar

El camino correcto más corto: una máquina tuya ejecuta el servidor, todos los
dispositivos llegan a él por HTTPS y cada dispositivo se empareja una vez.
Iniciar sesión en Obsidian no autoriza nada aquí; la única cuenta es la de tu
servidor.

### 1. Arranca el servidor

Dos maneras de arrancarlo. Ambas ejecutan exactamente los bytes que firmó el
publicador: verifica la firma, lee el digest de la salida verificada y ejecuta
exactamente ese digest. `v1.0.6` es la versión con la que se escribió esta
página; usa la etiqueta de la versión que estás instalando.

```sh
cosign verify ghcr.io/snaraj/obsync:v1.0.6 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**¿Aún sin HTTPS?** `deploy/compose` arranca el servidor detrás de su propio
terminador TLS (Caddy), en cualquier red, sin dominio y sin cuenta con nadie.
Desde una copia de este repositorio:

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` es el nombre que escribirán tus dispositivos. Solo tiene que
resolver en tu propia red. `OBSYNC_BIND_ADDRESS` es la dirección de este host
en la que se publican los puertos 80 y 443: una dirección de enlace limita la
interfaz de destino, no el origen, así que es tu cortafuegos el que decide
quién llega. Compose se niega a arrancar hasta que hayas elegido. Ambas se
explican en [Ejecutar el servidor](../server.md).

**¿Ya tienes HTTPS delante** de la máquina, con un proxy inverso o un túnel en
el que confías? Ejecuta el servidor a pelo. Habla HTTP plano en el puerto 8080
y tu terminador le reenvía:

```sh
docker volume create obsync-blobs
docker volume create obsync-journal
docker run -d --name obsync -p 127.0.0.1:8080:8080 \
  -v obsync-blobs:/data/blobs -v obsync-journal:/data/journal \
  -e OBSYNC_BLOBS_CAPACITY=250GiB -e OBSYNC_JOURNAL_CAPACITY=4GiB \
  -e OBSYNC_PUBLIC_URL=https://sync.example.org \
  ghcr.io/snaraj/obsync@sha256:<the digest cosign just verified>
```

### 2. Lee el token de configuración

En el primer arranque el servidor acuña un token de configuración y lo escribe
en su volumen de diario, con modo 0600, sin registrarlo nunca. El token crea
tu cuenta una vez y después sigue siendo el inicio de sesión de recuperación
del panel durante toda la vida del servidor: guárdalo con el mismo cuidado que
la frase de recuperación. Léelo desde el propio contenedor, sin imagen
auxiliar. En el camino de Compose:

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

En el camino del servidor a pelo:

```sh
docker cp obsync:/data/journal/v1/setup-token - | tar -xO
```

### 3. Confía en el certificado, una vez por dispositivo (camino de Compose)

Caddy emitió el certificado desde una autoridad que generó en el primer
arranque, así que a cada dispositivo hay que decirle una vez que confíe en esa
autoridad. Exporta la raíz:

```sh
docker cp obsync-caddy-1:/data/caddy/pki/authorities/local/root.crt - | tar -xO > obsync-root.crt
```

Instala `obsync-root.crt` en cada dispositivo. Los pasos para macOS, Windows,
Linux, iOS y Android están en
[Confiar en la autoridad de certificación, una vez por dispositivo](../server.md#trust-the-certificate-authority-once-per-device).
En iOS, confiar en el certificado es un segundo interruptor tras instalarlo.

### 4. Configura el primer dispositivo

1. Preferencias → Complementos comunitarios → Buscar → **Self Hosted Private
   Sync** → Instalar → Activar.
2. En los ajustes del plugin, pon en **Server URL** tu servidor, con el
   puerto cuando no sea el 443: `https://sync.example.org`.

   ![La pestaña de ajustes del plugin: el campo Server URL con un nombre de host de demostración, la caja de cabeceras de edge y la fila Connection con sus botones Check y Open dashboard](../assets/settings-server.png)

3. Elige ahora **Whole vault** o **Selected folders only**. Una vez que un
   dispositivo ha sincronizado, su selección solo puede estrecharse.
4. Pega el token de configuración en **First-time setup** y pulsa **Set up**.
   Apunta la frase de recuperación de 24 palabras y guárdala fuera de este
   dispositivo.

   ![La sección This device de la pestaña de ajustes: la fila Pairing con Pair this device y Pair a new device, la fila First-time setup con el campo Setup token y el botón Set up, y la fila Vault key](../assets/settings-setup.png)

### 5. Empareja el segundo dispositivo

1. Instala y activa allí el plugin, pon la misma **Server URL** y elige sus
   carpetas.
2. En el primer dispositivo, ejecuta **Pair a new device**. Muestra un código
   válido durante diez minutos.

   ![El diálogo Pair a new device en el primer dispositivo, con su código oculto, los botones Copy code y Copy link y la línea Waiting for the new device](../assets/pair-new-device.png)

3. En el segundo dispositivo, abre **Pair this device**, pega el código y
   pulsa **Pair**.

   ![El diálogo Pair this device en el segundo dispositivo, con el campo Pairing code vacío y el botón Pair](../assets/pair-this-device.png)

4. De vuelta en el primer dispositivo, aprueba el nuevo dispositivo por su
   nombre. Edita una nota en cualquiera de los dos; aparece en el otro en
   segundos.

   ![El primer dispositivo preguntando si aprobar el nuevo dispositivo por su nombre, con los botones Approve y Reject](../assets/pair-approve.png)

   ![El segundo dispositivo mostrando la nota escrita en el primero, con la barra de estado indicando obsync idle](../assets/first-sync.png)

Todo el intercambio de emparejamiento, en un bucle corto:

![Animación: el código de emparejamiento mostrado en el primer dispositivo, pegado en el segundo, aprobado en el primero y la primera nota llegando al segundo](../assets/pairing.gif)

Las capturas de teléfono aún no están en este repositorio; se toman en los
propios dispositivos del mantenedor y se añaden cuando una ejecución de
validación las registra.

Cada paso al completo, con lo que pide cada pantalla y por qué:
[Inicio rápido](../quickstart.md).

**¿Probándolo en un solo ordenador?** En un ordenador el plugin también acepta
una dirección `http://` plana, así que `http://127.0.0.1:8080` llega al
servidor a pelo de arriba sin terminador. Los teléfonos no: Obsidian en iOS y
Android rechaza el HTTP plano.

## Avanzado: Cloudflare

La instalación de referencia **no tiene nombre de host público**. Un Cloudflare
Tunnel conecta la red privada del servidor con Cloudflare, una ruta privada le
dice a Cloudflare qué direcciones viven detrás de ese túnel y el cliente
Cloudflare One de cada dispositivo lleva allí la Server URL. Nada es accesible
desde internet, y las primeras sincronizaciones grandes no pasan por un nombre
de host público. La otra forma, un nombre de host público detrás de Cloudflare
Access con un token de servicio en **Edge service-token headers** y
`OBSYNC_EDGE=cloudflare` en el servidor, también está soportada. Las dos, paso
a paso: [Cloudflare](cloudflare.md).

## Otras maneras de llegar a tu servidor

Una línea por opción, sin tutorial. Elijas lo que elijas, el plugin necesita
HTTPS con un certificado en el que confíen todos los dispositivos, y el
servidor en sí sigue en HTTP plano detrás de ese terminador.

- **Solo LAN.** El camino de Compose de arriba, accesible solo en casa. Lo más
  sencillo; sin sincronización fuera de casa.
- **WireGuard.** Tu propia VPN de vuelta a tu red. Lo más rápido y
  enteramente tuyo; llevas una configuración de par en cada dispositivo y
  mantienes un extremo accesible.
- **Tailscale.** Una malla WireGuard gestionada con sus propios nombres. La
  menor configuración en los dispositivos; un tercero coordina la malla, y sus
  límites de plan los lees tú.
- **Un proxy inverso con TLS automático**, como Caddy en un nombre público.
  Un certificado de confianza pública y una dirección permanente; el servidor
  pasa a ser accesible desde internet, y el proxy y sus actualizaciones son
  cosa tuya.
- **Cloudflare Tunnel.** Arriba. Sin puerto entrante; un proveedor en el
  camino con sus propias condiciones.

Lo que necesita un dispositivo itinerante, elijas lo que elijas (la ruta, el
nombre, el certificado, el aviso de red local de iOS, el cortafuegos):
[Llegar desde fuera de tu LAN](../server.md#reaching-it-from-outside-your-lan).

## Resolución de problemas

| Síntoma | Causa probable | Lo primero que probar |
| --- | --- | --- |
| `obsync: offline` | El dispositivo no llega a la Server URL | Abre la URL en un navegador del mismo dispositivo; revisa el puerto, HTTPS y la ruta |
| Un teléfono no conecta mientras un ordenador sincroniza | El certificado privado no es de confianza en el teléfono | Instala el certificado raíz; en iOS actívalo además en «Ajustes de confianza de certificados» |
| `401 stale_timestamp` | Un reloj está desviado más de 300 segundos | Activa la hora automática, en el dispositivo o en el servidor |
| `403 device_pending` | Nadie ha aprobado todavía el dispositivo | Apruébalo por su nombre en el dispositivo desde el que emparejaste |
| Un archivo nunca llega | Está fuera de la selección de carpetas, o por encima del límite de tamaño de un teléfono | Revisa **Sync folders on this device**; en el teléfono ejecuta **Show remote-only files** |

Cualquier otro síntoma, cada código de error y cómo reunir un informe que
merezca la pena enviar: [Resolución de problemas](../troubleshooting.md).

## Documentación

| Página | Qué responde |
| --- | --- |
| [Inicio rápido](../quickstart.md) | El primer dispositivo y el segundo, cada paso al completo |
| [Ejecutar el servidor](../server.md) | Docker, Compose con Caddy, certificados, copias de seguridad, llegar desde fuera de tu LAN |
| [Cloudflare](cloudflare.md) | Túnel con ruta privada y el cliente Cloudflare One, o un nombre de host público detrás de Access |
| [Kubernetes](../../chart/README.md) | Instalar el servidor con el chart de Helm firmado |
| [Uso diario](../daily-use.md) | Comandos, la barra de estado, qué se sincroniza y qué no, restaurar una versión, el panel |
| [Ajustes](../settings.md) | Cada ajuste, su valor por defecto y cuándo cambiarlo |
| [Resolución de problemas](../troubleshooting.md) | Síntoma, causa, solución y cómo reunir un informe |
| [Conflictos](../conflicts.md) | Qué es una copia de conflicto y qué hacer con ella |
| [Recuperación](../recovery.md) | Un dispositivo perdido, un servidor perdido, un servidor trasladado, un token rotado |
| [Instalar y actualizar](../community-plugin.md) | El directorio de Obsidian, actualizaciones, custodia de credenciales, la revisión del listado |
| [Modelo de amenazas](../threat-model.md) | Qué se defiende y qué no |
| [Modelo de amenazas del panel](../security/dashboard.md) | Sesiones, inicio de sesión, revocación, riesgos residuales |
| [Arquitectura](../architecture.md) | Cómo está construido todo el sistema, y cada variable de entorno |
| [Protocolo](../protocol.md) | El contrato de red entre plugin y servidor |
| [Almacenamiento](../storage.md) | Volúmenes, durabilidad, retención, scrub y cada rechazo |
| [Validación](../validation.md) | El plan de validación con dispositivos y qué significa «listo» |
| [Versiones](../release.md) | Cómo se corta, firma y audita una versión |
| [Traducciones](../translations.md) | En qué idiomas existen las guías y cómo se mantienen al día |
| [`CHANGELOG.md`](../../CHANGELOG.md) | Qué cambió en cada versión |
| [`SECURITY.md`](../../SECURITY.md) | Postura, versiones soportadas y cómo informar de una vulnerabilidad |
| [`CONTRIBUTING.md`](../../CONTRIBUTING.md) | Cómo trabajar en este repositorio |

## Preguntas, errores y seguridad

- **Una pregunta, o algo que no estás seguro de que sea un error:**
  [Discussions](https://github.com/snaraj/obsync/discussions).
- **Un error:** [abre un issue](https://github.com/snaraj/obsync/issues/new/choose)
  con la plantilla de informe de error y el informe descrito en
  [Resolución de problemas](../troubleshooting.md). Sin ningún token, sin la
  frase de recuperación y sin ninguna dirección que no publicarías.
- **Una posible vulnerabilidad:** en privado, a través de
  [`SECURITY.md`](../../SECURITY.md); nunca en un issue público.

## Licencia

MIT. Ver [`LICENSE`](../../LICENSE).
