# Community plugin distribution

Self Hosted Private Sync installs and updates through Obsidian's Community Plugins browser on
desktop and mobile. The server does not install client code, and manual
placement of plugin files is not the production installation path.

The directory identity is `obsync-private-sync`; the displayed name is
Self Hosted Private Sync. A pre-directory build using a different ID is a separate installation.
The plugin does not read or import another installation's settings. Preserve
its recovery material before removing it, then configure the native install's
folder selection and pair it through Self Hosted Private Sync settings.

## Install and connect

Obsidian 1.13.0 or newer is required. Signing in to Obsidian does not enroll
a device with the self-hosted server: pair each device once, then sync runs
automatically.

1. Open the vault to sync. In Settings → Community plugins, allow community
   plugins, select Browse, search for Self Hosted Private Sync, then Install and Enable.
2. Open Self Hosted Private Sync settings and enter the HTTPS server address supplied by the
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
GitHub. Self Hosted Private Sync does not fetch or execute code from the sync server, install a
loader, or update itself. Its server-version notice points to Obsidian's
plugin manager. A new install and a subsequent native update both require
real-device validation; an archive test alone proves neither.

## Device credentials and recovery

The plugin keeps its vault key, device secret and edge header values in one
exact owned native SecretStorage entry. Plugin data holds only its reference
and nonsecret bookkeeping. Existing settings migrate only after a verified
secret write. A bounded previous credential record allows reload after an
interrupted metadata update without guessing or silently creating a new key.

If storage is unavailable or cannot be verified, sync stops with an error.
Keep the vault, its settings and recovery phrase intact, check Obsidian's
secret storage, then reload. Do not delete the reference or repeat account
setup. An incomplete enrollment can finish approval in its already-open pairing
dialog. After approval, the existing recovery phrase can restore its key;
the phrase does not approve a pending device. Closing or restarting Obsidian
does not resume a pending dialog because the pairing code is not persisted.
Do not repeat server setup to recover this state. Other plugin installations are
never imported automatically.

The public API provides no crash-durable transaction across secret storage
and plugin data. Immediate readback is not app-restart persistence proof.
An interrupted first migration can leave an unreferenced native entry; the
plugin does not enumerate or automatically delete native secrets. Storage is
vault-local and shared with other trusted plugins, without a promise of
universal OS encryption. See [credential custody](architecture.md#device-local-credential-custody)
and the [official storage guide](https://docs.obsidian.md/plugins/guides/secret-storage).

## Trust and network use

The plugin talks to the configured self-hosted server for account setup,
pairing, encrypted sync, history, device management and version information.
It has no subscription, advertising or telemetry service. Obsidian contacts
its directory and GitHub to install and update community plugins. Optional
network access providers are chosen by the server operator.

Four more surfaces the plugin touches, each only on the reader's own action:

- **Your edge, only if you configured one.** Headers you paste under **Edge
  service-token headers** ride on every request to the Server URL, because
  the proxy that needs them is on the path to your server.
- **Your browser, when you ask for the dashboard.** **Open dashboard** opens a
  sign-in link in your browser, and only when that link is on your server's
  own origin.
- **Your browser, when you ask for the setup guide.** **Setup guide** in the
  settings and the command **Open the setup guide** open the project's guide,
  a fixed address shipped with the plugin. The plugin itself sends nothing there.
- **Obsidian's secret storage.** The vault key, the device secret and any edge
  header values live there, never in plain plugin data.

Releases from 0.1.15 also publish native GitHub Actions build provenance for
all three installation files. The publisher and read-only audit verify it
against the exact protected-main source. Directory acceptance is still a
separate observed result, not implied by producing an attestation.

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

### Listing review findings (2026-09-22)

Obsidian's review scan of the 1.0.6 listing reported one network call, vault
enumeration, clipboard access, one stylesheet warning and two extra Release
assets. Where each one stands:

- **One network call.** Obsidian's `requestUrl`, injected once into the
  transport (`plugin/src/main.ts`), reaching the configured Server URL and
  nothing else. Disclosed in the README under "What this plugin accesses".
- **Vault enumeration.** `vault.getFiles()` decides which files are in scope
  for sync. Disclosed there.
- **Clipboard.** Two `navigator.clipboard.writeText` calls, behind the **Copy
  code** and **Copy link** buttons of **Pair a new device**
  (`plugin/src/ui/modals.ts`). Nothing reads the clipboard. Disclosed there.
- **`multicolumn` at `styles.css:20`.** `column-gap` on the recovery-phrase
  grid is also a multi-column property, which is what the scanner keys on. It
  is now the `gap` shorthand, which lays out the same two columns of twelve.
- **Extra Release assets.** `obsync-X.Y.Z-release-manifest.json` and
  `obsync-plugin-X.Y.Z.zip` are not plugin files, and Obsidian does not
  download them. They stay: the publisher's five-asset inventory requires
  them, the read-only release audit downloads both to re-verify the image,
  chart and bundle digests, and a deployer reads the image digest out of the
  manifest before running it ([release path](release.md)). The scanner's line
  is informational, not a refusal.
- **`manifest.json`** against the submission requirements: the description is
  one action statement of 91 characters ending with a period; `minAppVersion`
  is 1.13.0 because the settings tab is declared to Obsidian from 1.0.2
  (`CHANGELOG.md`); `isDesktopOnly` is `false` because the bundle imports
  `obsidian` and nothing from Node or Electron; `fundingUrl` is absent because
  no donations are taken; `authorUrl` and `helpUrl` are set. Nothing to
  change.

## Maintainer submission

Obsidian's current requirements were checked on 2026-09-11 against
[Submit your plugin](https://docs.obsidian.md/plugins/releasing/submit-plugin)
and [Set up and claim](https://docs.obsidian.md/community-directory/set-up-and-claim).

The default branch must contain `README.md`, `LICENSE` and the canonical root
`manifest.json`. The matching published GitHub release must use its exact
unprefixed version as the tag and carry the three individual plugin files.
The publisher supplies them from the same build as the server's bundle and
verifies their hashes before sealing the release.

The default branch also carries root `versions.json`, the ledger the installer
reads to offer an older Obsidian the newest release it can actually run. This
plugin's floor has moved three times (1.7.0 at 0.1.11, 1.7.2 at 0.1.13,
1.12.4 at 0.1.16, 1.13.0 at 1.0.2), so without the ledger an Obsidian below
1.13.0 is offered nothing at all rather than 1.0.1. It is held as a release follower rather than a lock;
`docs/release.md` states the rule and the gate that enforces it.

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
