# Cloudflare

Two ways to put Cloudflare between your devices and your server, and which one
the reference deployment uses. Neither is required: the server knows no
provider by name, and [Run the server](server.md) needs no account with
anybody. Take this page when you want to reach the server away from home
without opening a port on your router, or when you want a published hostname
with an access policy in front of it.

Cloudflare's own menus and plan terms change. Every step below names the
menu path as the Cloudflare documentation gave it on 2026-09-22; check the
current page before you rely on a limit or a price.

## Which shape

| Shape | What devices see | What the internet sees | Large first sync |
| --- | --- | --- | --- |
| **Private route** (the reference deployment) | your own private address and name, through the Cloudflare One client | nothing: no hostname, no open port | private network traffic, not proxied through a public hostname |
| **Public hostname with Access** | a public name, an Access policy, a service token in the plugin | the hostname, behind Access | proxied through Cloudflare, under the provider's terms for large files |

The private route is the reference because the server stays invisible and
because Cloudflare's own documentation sends large transfers that way: a
public hostname route proxies traffic through Cloudflare, and on the Free,
Pro and Business plans the service-specific terms require a paid service for
video and other large files, while a private network route carries them as
your own traffic. Do a bulk first sync on the LAN in either shape.

Whatever terminates TLS reads your credentials and never your notes: every
chunk and manifest is encrypted on the device, and no key that decrypts them
crosses the wire ([threat model](threat-model.md)). On the private route,
the terminator is yours, inside your network. On the public hostname, the
edge is a terminator too.

## Shape A: a private route and the Cloudflare One client

The server keeps a private address on your own network. A tunnel connector
runs beside it, a route tells Cloudflare which addresses live behind that
tunnel, and the Cloudflare One client (formerly WARP) on each device carries
traffic for those addresses through the tunnel. The Server URL your devices
type is a private name that resolves to that private address.

What you need: a Cloudflare account with a Zero Trust organization (a
"team name"), a machine on the server's network that can run the tunnel
connector, and the Cloudflare One client on every device that will sync away
from home.

1. **Create a tunnel.** In the Cloudflare dashboard, go to **Networking** >
   **Tunnels** and create a `cloudflared` tunnel. Run the connector it gives
   you on a machine inside the server's network: in the cluster next to the
   server, or on the same host.
2. **Route the server's private address through it.** Go to **Networking** >
   **Routes**, select **Create route** > **Tunnel CIDR**, choose the tunnel,
   and enter the server's private address or subnet. One address is enough;
   a subnet can be widened later.
3. **Enroll each device.** Install the Cloudflare One client, enter your team
   name, complete the sign-in your organization requires, and turn the
   connection on. On iOS and Android the client asks to install a VPN
   profile; accept it. Set device enrollment permissions so only your own
   identity can enroll.
4. **Send the private range through the client.** In the client's Split
   Tunnels configuration, make sure the address from step 2 is routed
   through the client. In **Exclude** mode, remove the RFC 1918 block that
   contains it and re-add the ranges you still want excluded; in **Include**
   mode, add the address or subnet.
5. **Make the name resolve on the device.** The plugin sends every request to
   the Server URL you typed, so that name has to resolve on the roaming
   device: a hostname route, Local Domain Fallback to your own resolver, or
   a private DNS entry. A name that resolves to an address the client does
   not route fails exactly like an offline server.
6. **Terminate TLS yourself.** The route carries your traffic to your own
   terminator: an ingress or reverse proxy in front of the server with a
   certificate every device trusts, as in [Run the server](server.md). The
   server runs with `OBSYNC_EDGE=none` and trusts forwarded addresses only
   from `OBSYNC_TRUSTED_PROXY_CIDRS`, the terminator's own range.
7. **Optionally, filter with Gateway.** A Gateway network policy can allow
   only your enrolled devices to reach the server's address and port, and
   block everything else on that route.
8. **Verify from a device that is off your network.** Open the Server URL in
   a browser on that device and expect the dashboard's sign-in page. In the
   plugin, select **Check** under **Connection**: one round trip proves the
   address, the certificate and the credential together.

Trade-offs:

- Every syncing device runs the Cloudflare One client, and the client has to
  be connected before sync away from home works.
- Cloudflare carries the traffic between the device and the tunnel connector.
  Leave Gateway TLS decryption off; the traffic is then opaque to it beyond
  addresses, sizes and timing, which the [threat model](threat-model.md)
  already concedes to any network path.
- The connector is a process on your network that keeps an outbound
  connection to Cloudflare open. When it is down, roaming devices show
  `obsync: offline` while the LAN keeps working.

## Shape B: a public hostname behind Access

The server gets a hostname on a domain you have on Cloudflare. The tunnel
publishes that hostname to the server's private address, and Cloudflare
Access sits in front of it: an identity policy for the dashboard, and a
service token for the plugin's API calls. This is the shape
[platform onboarding](platform-onboarding.md) describes for the reference
cluster, and the one the reference deployment has not taken.

1. **Publish the hostname.** In the tunnel's configuration, add a published
   application route from your hostname (`sync.example.com` standing in for
   your own) to the server's private HTTP address, port 8080. Cloudflare
   creates the DNS record.
2. **Put Access in front.** Go to **Zero Trust** > **Access controls** >
   **Applications**, create a **Self-hosted** application on that hostname,
   and add an identity policy that allows only you, such as a one-time PIN
   to your own address, for the dashboard.
3. **Create a service token for the plugin.** Go to **Zero Trust** > **Access
   controls** > **Service credentials** > **Service Tokens**, create one, and
   copy the Client ID and the Client Secret; the secret is shown once. Add a
   **Service Auth** policy to the application that includes this token, for
   the paths the plugin uses (`/v1/*`).
4. **Paste the token into the plugin.** Under **Edge service-token headers**,
   one per line, exactly as Cloudflare names them:

   ```text
   CF-Access-Client-Id: <the client id>
   CF-Access-Client-Secret: <the client secret>
   ```

   They ride on every request to the Server URL, and on nothing else.
5. **Tell the server it is behind the edge.** Run it with
   `OBSYNC_EDGE=cloudflare`. In that mode every request must carry the
   edge's connecting-address and request-id headers, and a request that
   arrives around the edge is refused with `421 edge_required`
   ([troubleshooting](troubleshooting.md#edge_required)).
6. **Verify.** Open the hostname in a browser and expect the Access sign-in,
   then the dashboard. In the plugin, select **Check** under **Connection**.

Trade-offs:

- The hostname is public. Access refuses strangers, and the server still
  authenticates every device request itself, but the name exists and is
  discoverable.
- The service token is a credential. Anyone holding it can reach the API's
  front door; the server's own device authentication still stands behind it.
  Rotate it in Cloudflare if it is ever exposed.
- Large transfers are proxied through Cloudflare under the terms above. Do the
  bulk first sync on the LAN.
- The edge's connecting-address and country headers are what the dashboard's
  Devices page shows for address and country in this mode.

## What has been proven

The private route is the reference deployment's route. The
[2026-09-14 run](validation-runs/2026-09-14.md) records that it was not
exercised that day, and why; the [2026-09-20 run](validation-runs/2026-09-20.md)
records a device run on the reference route with the connectivity and TLS
checks passed. The public hostname shape has not been exercised by any
recorded run.

## Next

- [Run the server](server.md): the terminator, the volumes, the setup token.
- [Kubernetes](../chart/README.md): the chart the reference deployment uses.
- [Platform onboarding](platform-onboarding.md): what the reference cluster
  would add for a published hostname.
- [Troubleshooting](troubleshooting.md): `edge_required`, `offline`, and the
  certificate.
