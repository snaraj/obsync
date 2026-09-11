# Community plugin distribution

Obsync installs and updates through Obsidian's Community Plugins browser on
desktop and mobile. The server does not install client code. If Obsync is
not listed in Browse, the directory entry is not yet available; manual
placement of plugin files is not the production installation path.

The directory identity is `obsync-private-sync`; the displayed name is
Obsync. A pre-directory build using a different ID is a separate installation.
The plugin does not read or import another installation's settings. Preserve
its recovery material before removing it, then configure the native install's
folder selection and pair it through Obsync settings.

## Install and connect

1. Open the vault to sync. In Settings → Community plugins, allow community
   plugins, select Browse, search for Obsync, then Install and Enable.
2. Open Obsync settings and enter the HTTPS server address supplied by the
   operator. The certificate must already be trusted by the device. Connect
   to the server's private network when it requires one.
3. Save the folders this device should sync before setup or pairing. For a
   workspace vault, select only the intended note folders. Folder selection
   is local to each device.
4. On the first device, complete First-time setup and keep the recovery
   phrase safe. On another device, enter the pairing code from Pair a new
   device on an existing paired device, then approve the new device there.

Updates use Settings → Community plugins → Check for updates. Obsidian
downloads the release's `main.js`, `manifest.json` and `styles.css` from
GitHub. Obsync does not fetch or execute code from the sync server, install a
loader, or update itself. Its server-version notice points to Obsidian's
plugin manager. A new install and a subsequent native update both require
real-device validation; an archive test alone proves neither.

## Trust and network use

The plugin talks to the configured self-hosted server for account setup,
pairing, encrypted sync, history, device management and version information.
It has no subscription, advertising or telemetry service. Obsidian contacts
its directory and GitHub to install and update community plugins. Optional
network access providers are chosen by the server operator.

The native installer relies on Obsidian's directory and GitHub release
distribution. It does not document verification of this project's Cosign
evidence before executing plugin code. The publisher signs the server image
and chart and binds plugin bytes in immutable release evidence; that is
producer-side evidence, not a separate signature verifier in the Obsidian
client. Treat installing a community plugin as trusting its code with the
vault.

For a production phone setup, the operator should supply normally trusted
HTTPS. A publicly trusted certificate can cover a privately reachable
service; certificate trust and network reachability are separate choices.
Private certificate authorities remain an operator-managed deployment option
in `deploy/compose`, with explicit per-device trust setup. Never bypass a
certificate error in the plugin.

## Maintainer submission

Obsidian's current requirements were checked on 2026-09-11 against
[Submit your plugin](https://docs.obsidian.md/plugins/releasing/submit-plugin)
and [Set up and claim](https://docs.obsidian.md/community-directory/set-up-and-claim).

The default branch must contain `README.md`, `LICENSE` and the canonical root
`manifest.json`. The matching published GitHub release must use its exact
unprefixed version as the tag and carry the three individual plugin files.
The publisher supplies them from the same build as the server's bundle and
verifies their hashes before sealing the release.

After the owner merges and the release is verified, sign in to
`community.obsidian.md` with the maintainer's Obsidian account, connect the
GitHub account, and submit `https://github.com/snaraj/obsync` under Plugins →
New plugin. Review the developer terms and continuing-support commitment as
the maintainer. Resolve the directory's review feedback and publish the
listing before claiming that the app is installable from Browse.

The directory reads the default branch and requires a published release.
Neither a Draft PR nor a local bundle satisfies that prerequisite. Owner
merge, directory acceptance and real-device acceptance are distinct results.
This procedure does not waive the repository's runtime live-validation gate.
