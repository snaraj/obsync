# Choose your setup

Every setup has the same three parts:

- **The server:** one container you run on a computer or a Raspberry Pi that stays on.
- **HTTPS in front of it,** with a certificate every device trusts.
- **A way for each device to reach it.**

Only the last part differs between setups. Pick the row that matches how you want to sync, then follow its guide.

Not sure? Start with **Same network**. The [Quickstart](quickstart.md) takes you from nothing to two devices in sync, with a screenshot of each step in the plugin.

## The setups

"Proven" names the evidence, and nothing else counts. There are two kinds:

- **CI runs the guide:** on every change, CI runs the commands the page shows.
- **A recorded run:** real devices completed setup, pairing and sync both ways, and a validation run records it ([how runs work](validation.md)).

| Setup | Syncs when | You need | Proven |
| --- | --- | --- | --- |
| **Same network:** [Compose with Caddy](server.md#any-network-no-provider-compose-with-caddy) | Your devices are on the same network as the server | A computer with Docker. One certificate trusted per device | CI runs the guide. Recorded run: macOS and iPhone, [2026-09-14](validation-runs/2026-09-14.md) |
| **Side by side, no Wi-Fi:** the same-network setup on one device's personal hotspot | Both devices are on that hotspot | As above, with the server's computer joined to the hotspot | Not yet recorded |
| **Private route to a cluster:** [Kubernetes](kubernetes.md), reached through [a private route](cloudflare.md#shape-a-a-private-route-and-the-cloudflare-one-client) | The device's private-network client is connected | A Kubernetes node, and the private-network client on each device | CI installs the chart. Recorded runs: macOS and iPhone, [2026-09-20](validation-runs/2026-09-20.md) and [2026-09-21](validation-runs/2026-09-21.md) |
| **Your own VPN:** WireGuard or Tailscale to either server above | The VPN is connected | A VPN on every device, plus [what a roaming device needs](server.md#reaching-it-from-outside-your-lan) | Not yet recorded |
| **A public name:** [behind an access policy](cloudflare.md#shape-b-a-public-hostname-behind-access), or a reverse proxy with automatic TLS | The device has internet | A domain. For an access policy, its service token in the plugin | Not yet recorded |

In every recorded run so far, the devices were on the server's own network or its private route. Syncing from somewhere else entirely has not been recorded yet: [Reaching it from outside your LAN](server.md#reaching-it-from-outside-your-lan) lists what that needs.

## Your devices

| Platform | Status |
| --- | --- |
| macOS | In every recorded run |
| iPhone and iPad | iPhone is in every recorded run. Trust the certificate once, in [two steps](server.md#trust-the-certificate-authority-once-per-device) |
| Windows and Linux | Not yet in a recorded run. The plugin runs the same code as on macOS |
| Android | Not yet in a recorded run. Android apps may decline certificates you install yourself. If Obsidian refuses to connect, use a public name with a publicly trusted certificate ([how](server.md#trust-the-certificate-authority-once-per-device)) |

## When a device is away from the server

Nothing is lost while a device cannot reach the server:

- Edits stay on the device.
- The server keeps everything the other devices sent.

When the device can reach the server again, sync resumes by itself: while it waits the status bar reads `obsync: offline — retrying`, and it tries again at once when the device reports its network back, otherwise within five minutes. **Sync now** from the command palette makes the next attempt happen now. The plugin then compares the vault with the server, sends what changed while you were away, and brings down what changed elsewhere.

The server keeps each deletion for 30 days by default. A device away for longer than that may still hold a note deleted elsewhere; delete it again there. Letting every device reach the server at least once a month avoids this.

## Get help

- [Troubleshooting](troubleshooting.md) covers every symptom and error code, and how to report one.
- In Obsidian, **Settings → Self Hosted Private Sync → Setup guide** opens this page.

![The plugin's settings opening with Get started: the Setup guide row and its Open the guide button, above the Server URL field](assets/settings-get-started.png)
