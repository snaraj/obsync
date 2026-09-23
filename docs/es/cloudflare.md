> Esta traducción sigue el [original en inglés](../cloudflare.md). El texto en inglés es el canónico; los comandos, las opciones, las URL y los marcadores de posición no cambian.

# Cloudflare

Dos maneras de poner Cloudflare entre tus dispositivos y tu servidor, y cuál
de ellas usa la instalación de referencia. Ninguna es obligatoria: el servidor
no conoce a ningún proveedor por su nombre, y [Ejecutar el servidor](../server.md)
no necesita cuenta con nadie. Esta página es para cuando quieres llegar al
servidor fuera de casa sin abrir un puerto en el router, o cuando quieres un
nombre de host publicado con una política de acceso delante.

Los menús de Cloudflare y las condiciones de sus planes cambian. Cada paso de
abajo nombra la ruta de menú tal como la daba la documentación de Cloudflare
el 2026-09-22; consulta la página actual antes de fiarte de un límite o de
un precio.

## Qué variante

| Variante | Qué ven los dispositivos | Qué ve internet | Primera sincronización grande |
| --- | --- | --- | --- |
| **Ruta privada** (la instalación de referencia) | tu propia dirección privada y tu nombre, a través del cliente Cloudflare One | nada: ni nombre de host ni puerto abierto | tráfico de red privada, no pasa por un nombre de host público |
| **Nombre de host público con Access** | un nombre público, una política de Access, un token de servicio en el plugin | el nombre de host, detrás de Access | pasa por Cloudflare, bajo las condiciones del proveedor para archivos grandes |

La ruta privada es la de referencia porque el servidor permanece invisible y
porque la propia documentación de Cloudflare envía las transferencias grandes
por ahí: una ruta con nombre de host público hace pasar el tráfico por
Cloudflare, y en los planes Free, Pro y Business las condiciones específicas
del servicio exigen un servicio de pago para vídeo y otros archivos grandes,
mientras que una ruta de red privada los transporta como tráfico tuyo. Haz la
primera sincronización grande en la LAN en cualquiera de las dos variantes.

Lo que termine TLS lee tus credenciales y nunca tus notas: cada fragmento y
cada manifiesto se cifran en el dispositivo, y ninguna clave que los descifre
cruza el cable ([modelo de amenazas](../threat-model.md)). En la ruta privada
el terminador es tuyo, dentro de tu red. Con el nombre de host público, el
borde también es un terminador.

## Variante A: una ruta privada y el cliente Cloudflare One

El servidor conserva una dirección privada en tu propia red. A su lado corre
un conector de túnel, una ruta le dice a Cloudflare qué direcciones viven
detrás de ese túnel, y el cliente Cloudflare One (antes WARP) en cada
dispositivo lleva el tráfico hacia esas direcciones a través del túnel. La
URL del servidor que escriben tus dispositivos es un nombre privado que
resuelve a esa dirección privada.

Lo que necesitas: una cuenta de Cloudflare con una organización Zero Trust
(un «nombre de equipo»), una máquina en la red del servidor que pueda
ejecutar el conector del túnel, y el cliente Cloudflare One en cada
dispositivo que vaya a sincronizar fuera de casa.

1. **Crea un túnel.** En el panel de Cloudflare, ve a **Networking** >
   **Tunnels** y crea un túnel `cloudflared`. Ejecuta el conector que te da en
   una máquina dentro de la red del servidor: en el clúster junto al servidor,
   o en el mismo host.
2. **Enruta la dirección privada del servidor por el túnel.** Ve a
   **Networking** > **Routes**, elige **Create route** > **Tunnel CIDR**,
   selecciona el túnel e introduce la dirección privada o la subred del
   servidor. Con una dirección basta; una subred se puede ampliar después.
3. **Inscribe cada dispositivo.** Instala el cliente Cloudflare One, escribe
   tu nombre de equipo, completa el inicio de sesión que exija tu organización
   y activa la conexión. En iOS y Android el cliente pide instalar un perfil
   de VPN; acéptalo. Configura los permisos de inscripción de dispositivos
   para que solo tu propia identidad pueda inscribirlos.
4. **Envía el rango privado por el cliente.** En la configuración de Split
   Tunnels del cliente, asegúrate de que la dirección del paso 2 se enruta por
   el cliente. En modo **Exclude**, quita el bloque RFC 1918 que la contiene y
   vuelve a añadir los rangos que aún quieras excluir; en modo **Include**,
   añade la dirección o la subred.
5. **Haz que el nombre resuelva en el dispositivo.** El plugin envía cada
   petición a la URL del servidor que escribiste, así que ese nombre tiene que
   resolver en el dispositivo itinerante: una ruta de nombre de host, Local
   Domain Fallback hacia tu propio resolutor, o una entrada de DNS privada.
   Un nombre que resuelve a una dirección que el cliente no enruta falla
   exactamente igual que un servidor apagado.
6. **Termina TLS tú mismo.** La ruta lleva tu tráfico hasta tu propio
   terminador: un ingress o un proxy inverso delante del servidor con un
   certificado en el que confíe cada dispositivo, como en
   [Ejecutar el servidor](../server.md). El servidor corre con
   `OBSYNC_EDGE=none` y solo confía en direcciones reenviadas desde
   `OBSYNC_TRUSTED_PROXY_CIDRS`, el rango propio del terminador.
7. **Opcionalmente, filtra con Gateway.** Una política de red de Gateway puede
   permitir que solo tus dispositivos inscritos lleguen a la dirección y al
   puerto del servidor, y bloquear todo lo demás en esa ruta.
8. **Comprueba desde un dispositivo fuera de tu red.** Abre la URL del
   servidor en un navegador de ese dispositivo y espera la página de inicio de
   sesión del panel. En el plugin, pulsa **Check** en **Connection**: un solo
   viaje de ida y vuelta demuestra a la vez la dirección, el certificado y la
   credencial.

Contrapartidas:

- Cada dispositivo que sincroniza ejecuta el cliente Cloudflare One, y el
  cliente tiene que estar conectado antes de que la sincronización fuera de
  casa funcione.
- Cloudflare transporta el tráfico entre el dispositivo y el conector del
  túnel. Deja desactivado el descifrado TLS de Gateway; el tráfico es entonces
  opaco para él más allá de direcciones, tamaños y tiempos, que el
  [modelo de amenazas](../threat-model.md) ya concede a cualquier ruta de
  red.
- El conector es un proceso en tu red que mantiene abierta una conexión
  saliente hacia Cloudflare. Cuando cae, los dispositivos itinerantes muestran
  `obsync: offline` mientras la LAN sigue funcionando.

## Variante B: un nombre de host público detrás de Access

El servidor recibe un nombre de host en un dominio que tienes en Cloudflare.
El túnel publica ese nombre hacia la dirección privada del servidor, y
Cloudflare Access se sitúa delante: una política de identidad para el panel y
un token de servicio para las llamadas a la API del plugin. Es la variante
que [incorporación a la plataforma](../platform-onboarding.md) describe para
el clúster de referencia, y la que la instalación de referencia no ha
adoptado.

1. **Publica el nombre de host.** En la configuración del túnel, añade una
   ruta de aplicación publicada desde tu nombre de host (`sync.example.com`
   representa el tuyo) hacia la dirección HTTP privada del servidor, puerto
   8080. Cloudflare crea el registro DNS.
2. **Pon Access delante.** Ve a **Zero Trust** > **Access controls** >
   **Applications**, crea una aplicación **Self-hosted** en ese nombre de host
   y añade una política de identidad que solo te permita a ti, por ejemplo un
   PIN de un solo uso enviado a tu propia dirección, para el panel.
3. **Crea un token de servicio para el plugin.** Ve a **Zero Trust** >
   **Access controls** > **Service credentials** > **Service Tokens**, crea
   uno y copia el Client ID y el Client Secret; el secreto se muestra una sola
   vez. Añade a la aplicación una política **Service Auth** que incluya ese
   token, para las rutas que usa el plugin (`/v1/*`).
4. **Pega el token en el plugin.** En **Edge service-token headers**, uno por
   línea, exactamente como los nombra Cloudflare:

   ```text
   CF-Access-Client-Id: <the client id>
   CF-Access-Client-Secret: <the client secret>
   ```

   Viajan con cada petición a la URL del servidor, y con nada más.
5. **Dile al servidor que está detrás del borde.** Ejecútalo con
   `OBSYNC_EDGE=cloudflare`. En ese modo cada petición debe llevar las
   cabeceras del borde con la dirección de conexión y el identificador de
   petición, y una petición que llega esquivando el borde se rechaza con
   `421 edge_required` ([resolución de problemas](../troubleshooting.md#edge_required)).
6. **Comprueba.** Abre el nombre de host en un navegador y espera el inicio de
   sesión de Access, y luego el panel. En el plugin, pulsa **Check** en
   **Connection**.

Contrapartidas:

- El nombre de host es público. Access rechaza a los desconocidos, y el
  servidor sigue autenticando por sí mismo cada petición de dispositivo, pero
  el nombre existe y se puede descubrir.
- El token de servicio es una credencial. Quien lo tenga llega a la puerta
  principal de la API; la autenticación de dispositivos del servidor sigue
  detrás. Rótalo en Cloudflare si alguna vez queda expuesto.
- Las transferencias grandes pasan por Cloudflare bajo las condiciones de
  arriba. Haz la primera sincronización grande en la LAN.
- Las cabeceras del borde con la dirección de conexión y el país son lo que la
  página de dispositivos del panel muestra como dirección y país en este
  modo.

## Qué se ha comprobado

La ruta privada es la ruta de la instalación de referencia. La
[ejecución del 2026-09-14](../validation-runs/2026-09-14.md) deja constancia
de que ese día no se ejercitó, y de por qué; la
[ejecución del 2026-09-20](../validation-runs/2026-09-20.md) registra una
ejecución con dispositivos en la ruta de referencia con las comprobaciones de
conectividad y TLS superadas. La variante con nombre de host público no ha
sido ejercitada por ninguna ejecución registrada.

## Siguiente

- [Ejecutar el servidor](../server.md): el terminador, los volúmenes, el
  token de configuración.
- [Kubernetes](https://github.com/snaraj/obsync/blob/main/chart/README.md): el chart que usa la instalación de
  referencia.
- [Incorporación a la plataforma](../platform-onboarding.md): qué añadiría el
  clúster de referencia para un nombre de host publicado.
- [Resolución de problemas](../troubleshooting.md): `edge_required`,
  `offline` y el certificado.
