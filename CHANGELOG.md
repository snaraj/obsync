# Changelog

All notable changes to obsync are recorded here. The format follows
Keep a Changelog; versions follow SemVer. Every artifact-classified merge
advances exactly one SemVer step -- one patch, one minor, or one major
(AGENTS.md, requirement 10).

## 1.1.0 - 2026-09-21

- **The documentation can be published as a site, and the README is a front
  door.** `mkdocs.yml` builds the pages this repository already carried into a
  site with MkDocs Material, and `.github/workflows/docs-site.yml` deploys it
  to GitHub Pages on every push to `main` from this release on — at
  `snaraj.github.io/obsync`, once the repository owner has turned Pages on.
  Nothing about the documentation depends on that: the site is a RENDERING,
  never a second copy. Every page on it is a Markdown file reviewed in a pull
  request, readable in the repository without the site, and at the path it has
  always had, so no existing link breaks. That is also why this project has no
  GitHub wiki — wiki content is unreviewed, unversioned, invisible to
  `make check`, and cannot be part of a pull request.
  `docs/requirements.txt` pins the whole build closure by exact version AND by
  the sha256 of each wheel, and the install runs under `--require-hashes` with
  no resolution step. The theme fetches no font, script or style from any
  third party, and that is now proven on the OUTPUT rather than asserted of a
  setting: `theme.font` is `false`, and `scripts/ci/site_origins.py` rewrites
  the two script loads Material's own bundle carries to a CDN and then refuses
  any load in any built file whose origin is not this site's or this
  repository's. The docs workflow runs both between the build and the upload,
  so what is published is what was judged.
- **`README.md` is 200 lines instead of 573.** It keeps what a stranger needs
  before deciding: the pitch, the three warnings, what it does, the five
  captures, the shortest complete path to a running server, the disclosure of
  everything this plugin talks to, and where a question, a bug and a
  vulnerability go. Nothing was deleted. Every paragraph that left is on a page
  the README links to: [`docs/server.md`](docs/server.md) (the TLS terminator
  choice, Docker, Compose with its own certificate authority, the bind address,
  trusting that authority on each device, reaching the server from outside the
  LAN), [`docs/quickstart.md`](docs/quickstart.md) (setting up the first device
  and pairing a phone), [`docs/daily-use.md`](docs/daily-use.md) (the commands,
  the status bar, what syncs, restoring a retained version), and
  [`docs/index.md`](docs/index.md) (the repository layout).
- **A page for the dashboard, which never had one.**
  [`docs/dashboard.md`](docs/dashboard.md) is how to launch it, how to reach
  it, what each of its six pages shows, and how to revoke a device — with four
  marked capture slots naming what each image must show, because the run behind
  1.0.0 never exercised the device list or the revoke button.
- **The onboarding contract follows the commands it judges.**
  `scripts/ci/test_onboarding_contract.py` used to read `README.md` and
  `docs/architecture.md`. The install commands now also stand on
  `docs/server.md`, so that page is judged by the same rules — digest-only
  runs, both cosign identity flags, the journal volume nowhere else, the
  tokenless token read on every documented start, the standing-credential
  sentence — and the three site pages that hand a reader the setup token take
  the wording rule, and the rule that keeps the server's own run publishing
  `8080` on loopback alone now reads every publication form Docker accepts and
  judges all of them. The suite goes from 68 tests to 91, each addition with
  its own mutation.
- **A workflow of its own, outside the release chain.**
  `.github/workflows/docs-site.yml` builds the site under `mkdocs build
  --strict` on every pull request and deploys it on pushes to `main`, with
  every action pinned by commit SHA and the deploy job holding `pages: write`
  and `id-token: write` and nothing else. It adds no job to `pr-gate.yml` or
  `codeql.yml`, so the job inventory the release publisher authorizes against
  (`scripts/ci/release_contract.py`) is unchanged.
- **Two self-hosting guides, and CI runs the commands they show.**
  [`docs/server.md`](docs/server.md) gains backups of the two volumes and
  upgrade-and-roll-back by digest, and
  [`docs/kubernetes.md`](docs/kubernetes.md) is new: static local volumes with
  the ownership rule the server enforces, the values that match them, a TLS
  front inside the cluster — manifest included, carrying the three labels the
  chart's NetworkPolicy admits — with a certificate issued over DNS-01 and the
  cadence to renew it, the setup-token read for a distroless image, and
  reaching the deployment privately. Neither page is a promise.
  `.github/workflows/compose-e2e.yml` brings the Compose deployment up from the
  commands `docs/server.md` shows, on an amd64 and an arm64 runner, reads the
  setup token the way that page says to, signs in to the dashboard with it, and
  then does what that token exists for: `scripts/ci/api_flow.py` creates the
  account, pairs a SECOND device through the API, pushes one file and reads it
  back on that device, is refused by name for an unsigned, altered, stale or
  replayed request, and finds all of it intact after the stack is restarted.
  `.github/workflows/helm-e2e.yml` installs the chart into a `kind` cluster with
  the volumes and values `docs/kubernetes.md` shows, applies that page's own
  terminator, runs the same device flow through it over HTTPS — with a file
  larger than the 1 MiB body ceiling a stock proxy applies — and then upgrades
  on the digest and rolls back, with the account, both devices and the file
  surviving both pod replacements. Both read the page at the commit under test
  through `scripts/ci/docs_blocks.py` rather than a copy kept beside it, and
  `scripts/ci/test_selfhosting_contract.py` fails the build when a page and its
  gate stop agreeing. Every resource either workflow creates is named after the
  run that created it, and the teardown fires only for what a marker says that
  invocation actually made, so a preflight refusal on a machine that already
  hosts a deployment destroys nothing.
- **Both architectures, natively, before the merge rather than after.**
  `.github/workflows/arch-matrix.yml` builds the server on `ubuntu-24.04` and
  on `ubuntu-24.04-arm` — so the workspace test suite runs on each — asserts a
  static ELF for that architecture, builds the shipped image on both, and runs
  the resulting binary on Debian, Ubuntu, Fedora and Alpine, each pinned by
  digest, on each architecture. The binary links no libc at all, so there is no
  glibc floor to document and these eight legs are what says so.
- **New troubleshooting entries for two failures that are not the server.** A
  phone that reports the hostname cannot be found on its own Wi-Fi is usually
  the router's DNS-rebinding protection returning an empty answer for a name
  that resolves to a private address; a TLS error from a device behind an
  access-controlled edge is usually that edge's own decision — a posture policy
  the device no longer passes, or an allow policy demanding the identity be
  re-authenticated — rather than the certificate, so the edge policy for that
  device is what you read first.

**Compatibility with 1.0.3.** That release changed three behaviours on purpose,
and this one keeps them: the outcome of two concurrent revocations of the same
device, how a pending device's refusal is classified, and the handling of
sessions and sign-in links a device originates. Everything else a paired device
sees over the wire is unchanged, so a 1.0.x plugin and a 1.1.0 server
interoperate exactly as before.

## 1.0.3 - 2026-09-20

Dashboard security: an independent review of 1.0.1, and a second pass that
exercised a running server rather than reading it. Your vault, your devices
and your pairing are untouched, and the plugin does not change.

**Nothing to do — unless you open the dashboard over plain `http`.** That
stops working after this update at any IP address or LAN name, and also at
`localhost` if your browser is Safari (first bullet below). One thing
everybody will notice: dashboard sessions opened before this update are
signed out once, so open the dashboard from **Open dashboard** on a paired
device again.

- **The dashboard needs a secure address now.** Its two cookies are `Secure`
  and host-bound, which is what stops one plaintext request from carrying
  your session in the clear or letting another host on your domain plant one.
  What that means for the address bar:
  - an `https` address works in every browser — this is the supported way in,
    and the one every install guide here already describes;
  - plain `http` to `localhost` or `127.0.0.1` works in Chrome and Firefox,
    which treat loopback as secure, but **not in Safari**, which sends no
    `Secure` cookie to a plaintext origin at all: on Safari the sign-in
    redirect appears to work and every page is then signed out;
  - plain `http` to any other IP address or LAN name works nowhere. If that
    is how you reach the dashboard today, put your TLS terminator in front of
    it and use its name.
- **Revoking a device now ends what it opened.** Revoking used to leave the
  sign-in link that device had just minted working, and any dashboard session
  opened from one of its links alive for up to twelve hours. Revoking a lost
  laptop while its browser was still signed in did not sign it out. It does
  now: the link stops working and the session ends in the same moment.
- **The dashboard can no longer revoke your last device.** The plugin has
  always refused that, because an account with no active device can never
  sync again and nothing re-enrols one; the dashboard's Revoke button had no
  such guard, so one click was permanent. It refuses now, and the confirm
  text says what revocation does and does not do.
- **Sessions end sooner, and you can end all of them.** A dashboard left open
  and untouched for an hour signs itself out; the twelve-hour limit still
  applies whatever you are doing. **Sign out everywhere** in the top bar ends
  every session the server holds at once, and cancels any sign-in link that
  was opened and never used — a machine you no longer have may be holding
  one, and it would have worked for its five minutes.
- **Two devices revoking each other at the same moment can no longer empty
  your account.** The check for "this is your last device" and the revocation
  itself now happen together, so two clicks that land in the same instant
  cannot both go through. Before, they could, and an account with no active
  device can never sync again: nothing re-enrols one.
- **The recovery token is treated as the break-glass credential it is.** A
  sign-in with it is logged as a warning, and the Overview page says so for
  as long as that session lasts, so a use you did not make is visible.
  `docs/recovery.md` has the three steps that rotate it, and how to tell it
  has been used. Every refused sign-in is logged as a warning too, and while
  the Logs page holds it you can see it. Be precise about what that promise
  is: a refused sign-in is unauthenticated traffic, so it lives in the
  smaller of the two rings below (200 lines) and other unauthenticated
  traffic can push it out of that one — what it can never do is push out the
  authenticated half (1000 lines), which is where your own devices' and your
  own dashboard's decisions are. Your server's stdout keeps every one of
  these lines whatever the page shows.
- **The Logs page can no longer be wiped by a stranger.** Anyone who could
  reach the server could push every decision out of it with about a thousand
  free health probes. Authenticated decisions and unauthenticated traffic now
  keep separate space, so a burst of probes pushes out only older probes.
  Three sync endpoints also used to check the shape of an address or a
  parameter before checking who was asking, which let an anonymous caller
  land a refusal in the authenticated half — a thousand malformed requests
  emptied it in about a second. Every endpoint that needs a credential now
  asks for one first, and knowing a revoked or unapproved device's id is no
  longer treated as knowing its key.
- **The server stops telling strangers how much you write — nearly.** Every
  response used to carry the journal position in a header, including answers
  to unauthenticated probes; polling it reconstructed when and how much you
  edit. The header now rides only a response to a caller whose credential the
  server actually verified. One opening is narrowed rather than closed, and
  it is worth knowing about: `GET /readyz` still states that same position in
  its body, because the readiness contract says it does and the release
  smokes read it. If your server is reachable by people you do not trust,
  `/readyz` is what they can still poll. Whether readiness should state a
  sequence at all is a decision for a later release.
- **Smaller hardening.** `object-src 'none'` and two cross-origin isolation
  headers on dashboard pages; a proper doctype on the page; and an
  unauthenticated caller with a wrong setup token can no longer tell a
  claimed server from an unclaimed one.
- **New page:** `docs/security/dashboard.md`, the dashboard's own threat
  model — what it holds, how you get in, what defends it, and what is
  deliberately left standing.

## 1.0.2 - 2026-09-20

- **Obsidian 1.13.0 or newer.** The floor moves from 1.12.4 because the
  settings tab is now declared to Obsidian rather than drawn by the plugin,
  which is what makes every row searchable from Settings and what the
  non-deprecated destructive button needs. Root `versions.json` keeps 1.0.1
  available to an Obsidian below 1.13.0; the wire protocol, the journal and
  pairing are unchanged, so a device on 1.0.1 and a device on 1.0.2 sync the
  same vault.
- **A shorter first run.** A host name typed alone in **Server URL** becomes
  `https://host`. **Set up** and **Pair this device** apply a folder selection
  that was typed but not yet saved, so the screen is what the device syncs.
  The account-name field is gone: the dashboard calls the one account a
  server holds `obsync`. Notices drop the `obsync:` prefix.
- **A clean community-directory scorecard.** The directory's automated scan
  reported 221 issues on 1.0.0; the same rules (`eslint-plugin-obsidianmd`
  0.4.2 with typescript-eslint's type-checked set) now report none. The
  vendored Obsidian API declaration sits under a `node_modules` path, the one
  name every linter skips, and is pinned at exactly the floor so the compiler
  refuses any member the floor lacks. In the plugin: 17 redundant casts, typed
  edge-header parsing, a history cleanup that no longer throws from `finally`,
  a control-character check that is a loop rather than a regular expression,
  `console.warn` for refusals and `console.debug` for routine decisions,
  sentence-case notices. In the stylesheets: no `columns`, no `clip-path`, no
  `!important`; the recovery phrase is a numbered list laid out as a grid.
- **Disclosures.** The README now states that the plugin lists every file in
  the vault to decide what is in scope, writes the clipboard only when you
  press Copy, talks to one host, and that each Release carries a plugin ZIP
  and an evidence manifest that Obsidian ignores.

## 1.0.1 - 2026-09-20

- **Open dashboard opens the configured server, or nothing.** The plugin used
  to open whatever the server answered with. The server builds that link from
  `OBSYNC_PUBLIC_URL`, which the chart leaves empty on purpose -- a private
  deployment advertises no address of its own -- so on the chart's path the
  answer is the relative `/login?token=…` and the command failed on every
  deployment that had not named itself; on the Compose path the value was
  there but dropped the port. The link is now resolved against the **Server
  URL** this device is configured with, and opened only when the
  resolved ORIGIN is that server's. A link to any other origin is refused by
  name and not opened: the answer carries a single-use dashboard sign-in token,
  and resolving a server's answer without checking where it points is how that
  token would reach somebody else's origin.
- **The Compose route hands out the port it publishes.** `OBSYNC_PUBLIC_URL`
  and the terminator's HTTP-to-HTTPS redirect both named the default HTTPS port
  while the deployment published `OBSYNC_HTTPS_PORT`, so a deployment that
  moved that port sent its own readers to a port nothing listens on. Both now
  carry the published port, and `scripts/ci/compose-smoke.sh` -- which already
  publishes a non-default pair -- reads back the redirect AND the address the
  server hands out. A deployment whose devices arrive somewhere else, because
  another reverse proxy holds 443 in front of it, sets `OBSYNC_PUBLIC_URL`
  itself: an explicit value wins, and the smoke proves that too.
- **A standalone Helm path.** `chart/README.md` carries the exact OCI install
  command, the Secret command for the server key, and a minimal `values.yaml`
  that produces a running pod outside the owner's own platform. No chart
  DEFAULT moved: `deploymentReady: false`, the reference StorageClasses and the
  reference ingress peer are fail-closed on purpose, and the new file is about
  which of them a stranger must replace with their own.
- **The README answers the questions a stranger asks first.** What this plugin
  talks to (your own server, and Obsidian's directory for installation — no
  telemetry, no third party, and no code ever fetched from the sync server);
  what it does, in six lines, above the fold; a Documentation table; and where
  a question, a bug and a vulnerability each go. Four new pages carry what the
  README used to imply: [`docs/troubleshooting.md`](docs/troubleshooting.md)
  (one heading per failure mode, the protocol refusals a device can show, and
  how to collect a report without pasting a credential),
  [`docs/settings.md`](docs/settings.md) (every setting, its default, and when
  to change it), [`docs/recovery.md`](docs/recovery.md) (a lost device, a lost
  server key, a restored volume, a rotated setup token, a moved address — and
  the plain statement that a vault with no device left has no supported way
  back in this version), and [`docs/conflicts.md`](docs/conflicts.md) (what a
  conflict copy is and what to do with it).
- **The Release page leads with what changed.** From this release the published
  notes carry that version's own changelog entry, then the line that installs
  or updates the plugin and the line that upgrades the server by digest, with
  the artifact table and the evidence digest folded underneath. Releases
  through 1.0.0 keep the body they published, byte for byte, because the
  read-only audit re-derives and compares it.
- **The plugin's directory entry says what it does.** The manifest description
  is an action ("Sync your vault across devices, end-to-end encrypted, through
  a server you run yourself.") rather than a product name nobody has heard, and
  a `helpUrl` points at the documentation table.
- **Documentation repairs found by auditing 1.0.0's install path.** The
  `cosign verify` example names the release being installed rather than
  `v0.1.0`; `SECURITY.md` states the private, owner-only posture the reference
  deployment has had since 2026-09-07 instead of a public tunnel with an access
  application; the README says how to reach the server from outside the LAN and
  what the recorded device run did and did not prove; the Kubernetes
  setup-token read is a command rather than a suggestion; the protocol refusals
  the plugin shows verbatim each have a sentence; the first-time-setup
  and pairing surfaces are named as they are labelled; and the two "may not be
  listed yet" hedges are gone, because it is.

## 1.0.0 - 2026-09-15

- First stable release. No behaviour changes with it: 1.0.0 is the point at
  which the guarantees below stop being intentions and start being the
  contract this project is judged against. Everything under "Known limits" is
  what 1.0.0 does NOT claim.
- **Dependency-free, by construction.** The server is one Rust binary built
  against the standard library alone -- no crates, no build script, no
  vendored code -- and the plugin has zero runtime dependencies, built by one
  pinned TypeScript compiler and a bundler in this repository. Cryptography is
  the platform's own WebCrypto on the device and an implementation checked
  against published test vectors on the server. `#![forbid(unsafe_code)]`
  holds everywhere but the one file that delivers SIGTERM.
- **A blind server.** No vault key, chunk key, plaintext chunk, or clear file
  path is sent to, stored by, or logged by the server; file names travel only
  inside encrypted manifests. The server cannot decrypt a vault because it
  holds no key material with which to try. The doctrine tests in
  `crates/obsyncd` refuse a handler, log line, or journal frame carrying a
  field named or shaped like a key or a path.
- **Fail-closed, with nothing to turn off.** No flag, environment variable,
  build feature, or configuration field disables encryption, request
  authentication, replay protection, fsync, integrity verification, probes, or
  the response header policy. The signing window (+/-300 s) and the nonce
  memory (600 s) are constants, not settings. A chart that has not been given
  a resolved image digest fails at pull time rather than deploying something
  unverified.
- **Any size, one path.** There is no per-file or per-vault size limit in
  server code. The only refusals are explicit, configurable and visible: the
  free-space watermark on a volume and the account quota, both HTTP 507.
  Device-side ceilings -- the mobile budget and the per-file mobile ceiling --
  are plugin policy, defaulted per platform and shown in the interface.
- **Native installation and updates.** The plugin installs and updates through
  Obsidian's own Settings -> Community plugins browser as Self Hosted Private
  Sync (`obsync-private-sync`). Root `versions.json` tells that installer which
  release each Obsidian version may take, so an older Obsidian is offered the
  newest release it can actually run instead of nothing. No supported path
  copies files by hand.
- **Two independent routes to a working deployment.** The reference route puts
  a TLS terminator the operator trusts in front of the pod on a private
  network, with `OBSYNC_EDGE=none`. The Compose route (`deploy/compose`) needs
  an account with nobody: Caddy, a private name, a private certificate
  authority, and nothing reachable from the internet;
  `scripts/ci/compose-smoke.sh` re-proves its serving path and its published
  address on every pull request. A tunnel on a public hostname is an optional
  convenience on top of either, never the foundation.

### Validated on real devices

The device campaign behind this release is recorded in
[`docs/validation-runs/2026-09-14.md`](docs/validation-runs/2026-09-14.md),
which carries every V1 through V16 outcome in its own row.

- Route: the Compose route (`deploy/compose`, validation.md V15) with a
  macOS laptop as the server: the 0.1.19 release image by digest behind Caddy
  `tls internal`, a private name and a privately trusted root on each device,
  reachable only on the local network. The reference route (Helm chart behind
  a WARP private route on the homelab) was not exercised in this run: the
  WARP client delivered SSH but not a second port to the same host.
- Devices, operating systems, Obsidian versions, plugin version, server
  commit: a MacBook Pro on macOS 26.6 with Obsidian 1.13.7 and plugin 0.1.18
  (paired first); an iPhone 15 Pro Max on iOS 26.6.1 whose Obsidian version
  was not recorded during the run, with plugin 0.1.19 installed from the
  community directory; server `obsyncd` 0.1.19 from release commit `e47e3d4`.
  The run was driven by the coordinator agent lane with the owner at the
  keyboard for the passcode, the local-network prompt, the firewall changes,
  and one live edit.
- Passed: the production-path install on both devices; V1 first-time setup and
  device enrollment (setup token accepted, recovery phrase shown, device
  listed); V2 pairing the phone (one-time code pasted on the phone, approved
  by name on the desktop, sealed envelope delivered, about one minute end to
  end); V3 two-way live edits (a note created on the desktop appeared on the
  phone, a line appended on the phone appeared on the desktop, each within a
  few seconds as observed, not instrumented); V15 itself, since this run is
  that Compose route confirmed on two real devices with no provider, no public
  hostname, and no port reachable from the internet. Unsigned requests to
  every sync endpoint were refused (401/404/400) and the server log shows
  exactly the two enrolled devices.
- Not attempted: V4, V5, V6, V7, V8, V9, V10, V11, V12, V14, V16, and the
  native update 0.1.18 -> 0.1.19 on the desktop. Not applicable: V13, because
  a laptop server has no private route.
- Two findings, both about generated URLs on a non-default HTTPS port and
  neither affecting sync correctness or privacy: the dashboard link the plugin
  opens, and the terminator's HTTP-to-HTTPS redirect, both drop that port.
  Tracked as [issue #68](https://github.com/snaraj/obsync/issues/68).

### Known limits

- V7 (a 20 GiB archive, Obsidian killed mid-upload, fewer than 8 MiB re-sent)
  is unproven. Resumable uploads exist; the retransmission bound has never been
  measured on a real device.
- V12 (a blob corrupted by hand, quarantined by scrub, restored from a healthy
  client) is unproven on real devices. Hosts without bounded range reads refuse
  automatic repair from a local source above 8 MiB, so a matching source on a
  capable device is required; a synthetic test does not close it.
- iPad and Windows are not validated. `docs/validation.md` names them as
  required platforms for the full campaign and this release does not claim
  them.
- Off-LAN sync (V13) is unproven on either route.
- The selected-folder list may only narrow once a vault has history. Widening
  it needs a safe current-head resync, which this version does not implement.
- Public reachability is not, and has never been, an acceptance criterion
  here: the reference deployment is private and owner-only by ruling.

## 0.1.20 - Unreleased

- Upgrade the plugin build toolchain from Node 24.19.0 with npm 11.17.0 to
  exact Node 26.8.2 with npm 11.19.1, and pin the matching multi-architecture
  image digest in the container build.
- Upgrade the CodeQL Action initialization and analysis steps from 4.37.9 to
  4.38.0 at one immutable upstream commit.

## 0.1.19 - Unreleased

- Generalise the release rule from "exactly one patch" to exactly one SemVer
  step, so a minor (`X.Y+1.0`) and a major (`X+1.0.0`) advance are admissible
  from a protected base and 1.0.0 is reachable without editing the gate in the
  pull request the gate must pass. Every skip, reversion, mixed range, second
  boundary in one range, and step that leaves a lower field non-zero
  (`X.Y+1.1`, `X+1.0.1`) stays denied, and the refusal now names all three
  admissible versions.
- Add root `versions.json`, the ledger Obsidian's community-plugin installer
  reads to offer an older Obsidian the newest release it can actually run, and
  hold it as a release follower: the head row must carry exactly root
  `manifest.json`'s `minAppVersion`, the rows must ascend, and no row may name
  a version above the head. The recorded floors are the ones each published
  release's own manifest declared.
- Follow the vault's own "Deleted files" preference when sync removes a file,
  through `FileManager.trashFile`, instead of always using the operating
  system bin. The file lookup is file-only, so a folder standing where a
  remote manifest names a file is never deleted with its contents.
- Normalise the folder selection a person types in settings through the host's
  `normalizePath`, so a leading or trailing slash, a doubled separator or a
  backslash is a typo rather than a refusal that discards the whole selection.
  Paths that arrive from another device are still refused, never normalised.
- Schedule the engine's timers and the transport's backoff through
  `window`, the one spelling that means the same thing in Obsidian's desktop
  Electron runtime and on mobile.
- State the truth in `README.md`: the plugin is listed in Obsidian's community
  directory as Self Hosted Private Sync, installed from Settings → Community
  plugins → Browse. Add the commands and status-bar legend, a troubleshooting
  section, and the three callouts a self-hosted sync plugin owes a new reader.
- Add the repository conventions established plugins share: issue templates
  for a bug report and a feature request, `.editorconfig`, and a
  `CONTRIBUTING.md` that points at the contract.

## 0.1.18 - Unreleased

- Accept maximal encrypted chunks within the fixed 8 MiB plaintext plus
  16-byte authentication-tag upload ceiling. Budget pulls by ciphertext size
  so three maximal chunks fit the unchanged 32 MiB multipart payload ceiling.
  Preserve chunk identities, history and ordinary four-upload concurrency.

## 0.1.17 - Unreleased

- Automatically audit remembered selected-file chunks and restore missing
  ciphertext from an intact local copy after scrub quarantine. Authenticate
  the retained manifest, preserve chunk identity, and verify restored bytes
  without creating another file version or changing history or tombstones.
- Bound each repair step to 64 chunk entries and at most one chunk upload;
  share one tracked worker between the background timer and Sync now, cancel
  reads on stop, and drain already dispatched writes before replacement loads.
- Report unavailable or changed repair sources. Devices without bounded range
  reads refuse automatic reads of source files above 8 MiB; larger files need
  a matching source on a device with bounded range reads. Native-device V12
  acceptance remains a separate validation requirement.

## 0.1.16 - Unreleased

- Fix native provenance verification by using the exact certificate identity
  without the mutually exclusive workflow selector. Retain repository,
  source, signer, issuer, hosted-runner and SLSA constraints, with a real CLI
  argument regression alongside the publication model.

- Store device credentials, vault keys and edge headers in one owned native
  SecretStorage entry, keeping only a reference and bookkeeping in plugin
  data. Migrate existing settings after verified secret writes, retain a
  bounded prior credential record for interrupted updates, and stop sync on
  unavailable or unverified persistence. Bind recovery dialogs before phrase
  derivation and drain stopped engine work before replacement loads. Require
  Obsidian 1.12.4 or newer.
- Remove obsolete server plugin-code download endpoints. Native Community
  Plugins installation and updates remain the supported distribution path;
  packaged assets and historical release verification remain intact.
- Align current pairing, credential custody, recovery and installation
  guidance with the implemented behavior and remove numbered feature promises.

## 0.1.15 - Unreleased

- Let a new device wait for approval through its own envelope endpoint,
  preserving one-time collection and stopping when the pairing dialog closes.
- Encode device policy using the existing v1 API field names, so heartbeats
  and device-setting updates report both ceilings successfully to the server.
- Use Self Hosted Private Sync as the community plugin display name, preserving
  the installation ID and device pairing protocol.
- Publish GitHub Actions SLSA build provenance for the three native plugin
  assets and verify it against the authorized protected-main source before
  sealing the release. Revalidate that provenance in the read-only release
  audit while preserving historical releases and existing release evidence.
- Refuse publication when the dispatch workflow commit differs from the
  authorized source, so native provenance cannot name a different build.

## 0.1.14 - Unreleased

- Return a failed process status for incomplete check and export reports.
- Verify ciphertext references from every retained version during offline checks,
  including missing history-only chunks, and count each verified chunk once.

## 0.1.13 - Unreleased

- Use Private Sync as the community plugin display name and link the maintainer profile.
- Compile against the official Obsidian 1.7.2 API declarations and declare the same minimum application version.

## 0.1.12 - Unreleased

- Use the distinct `obsync-private-sync` installation and pairing-link identity
  while retaining the Obsync display name. Native installs keep their own
  settings; no other plugin folder or protocol action is adopted. Release
  verification preserves the original ID through 0.1.11 and requires the new
  ID thereafter.

## 0.1.11 - Unreleased

- Prepare native installation and updates through Obsidian's Community
  Plugins browser. Keep one root manifest, publish the three individual
  plugin files from the same build as the ZIP, and bind every asset in v2
  release evidence. New GitHub tags match the unprefixed plugin version;
  image tags retain their prefix. Existing immutable releases retain their
  original audit contract. Directory acceptance and device validation remain
  separate prerequisites for production use.
- Align the commit-signature validator with the documented GPT-6 lane while
  retaining exact-match, identity and trailer refusals.
- Add a folder selection saved only on this device. Existing dedicated
  vaults retain whole-vault sync; selected folders admit only descendants,
  and an explicit empty selection syncs no files. Scoped scans start at the
  selected folders. Push, pull, on-demand downloads, remembered rename and
  deletion sources, conflict copies and merge history obey the selection
  before file access. Invalid persisted selections refuse loading.
- Saving a narrower selection waits for active transfers, preserves files
  and state, and never rewinds the feed. Queued renames remain publishable
  after restart. Expansion after a device has sync history is refused;
  move local files into an already selected folder and run Sync now to add
  content within the same vault. The selection does not revoke access to
  previously shared content or sandbox Obsidian, its plugins or the local OS.
- Complete native folder-selection saves without returning a thenable UI
  component to a Promise continuation, including handled save failures.
- Disabling the plugin cancels pending startup and folder-change
  continuations, so a delayed transfer or local save cannot restart sync
  after unload. Stale startup results cannot replace a newer engine or its
  status; an already-issued local write may finish and must be checked after
  restart.
- Add **Restore from history** to the native command palette. It browses
  retained versions, including deleted notes, with a separate bounded read
  cursor and restores verified content as a new sibling file. Existing
  files, unsynced edits and original history are preserved; the new copy
  uses ordinary sync with a fresh identity. Folder selection and current
  device limits apply, including local bytes added during the download.
- History reads make one attempt at a time; cancellation discards late
  results and blocks replacement reads until the outstanding request
  settles. A dispatched local create is preserved and reported separately
  from remote sync. Desktop publishes without replacing a destination;
  mobile uses Obsidian's create-only API. Neither platform silently falls
  back to an overwriting write.
- Resume sync after a same-instance reload waits for prior history recovery
  and manual-download work, without loading state ahead of their saves.
- Quarantine damaged chunks across separate blob and journal mounts using
  a synced copy on the destination volume before removing the primary.
  Reserve peak copy space, account failed-copy residue, and retain failed
  operations for recovery without claiming quarantine or losing inventory.
  Recovery uploads and delayed scrub summaries cannot discard each other;
  concurrent GC skips a busy chunk pass without holding partial locks.

## 0.1.10 - Unreleased

- The chart's own defaults could not start the server, and both halves of
  that are fixed here. `chart/values.yaml` declares each claim as a
  Kubernetes quantity (`250Gi`, `4Gi`) and the Deployment renders it verbatim
  into `OBSYNC_BLOBS_CAPACITY` / `OBSYNC_JOURNAL_CAPACITY`, but the server's
  size grammar knew only `KiB`/`MiB`/`GiB`/`TiB` and lower-cased what it read,
  so `Gi` was not a size and the pod exited on its own chart's defaults. The
  Service is named `obsync`, so a kubelet with service links on also injected
  `OBSYNC_SERVICE_HOST`, `OBSYNC_SERVICE_PORT` and `OBSYNC_PORT_*` -- and an
  unknown `OBSYNC_*` name is a startup error by design, which is a second
  refusal on the same first boot.

- **Size grammar, one spelling per multiplier.** `parse_size` (and therefore
  `OBSYNC_BLOBS_CAPACITY`, `OBSYNC_JOURNAL_CAPACITY`, `OBSYNC_SCRUB_RATE` and
  the size term of `OBSYNC_FREE_WATERMARK`) now accepts a bare byte count
  (`512`), `B`, the Kubernetes binary suffixes `Ki`, `Mi`, `Gi`, `Ti`, and
  their long forms `KiB`, `MiB`, `GiB`, `TiB`; `Gi` and `GiB` are the same
  multiplier. The suffix is matched case-sensitively after trimming.
  COMPATIBILITY, for both `OBSYNC_*_CAPACITY` and `OBSYNC_FREE_WATERMARK`:
  the single letters `k`, `m`, `g`, `t` and every lower- or upper-case
  spelling (`gib`, `GIB`, `4mib`, `512b`) are DROPPED and now refuse the
  start. A value using one must be rewritten -- `250g` becomes `250Gi`,
  `1%,2g` becomes `1%,2Gi`, `64m` becomes `64Mi`. Nothing in this repository,
  its charts, its compose file or its README used a dropped form. The reason
  they are gone is that Kubernetes reads a single letter as a power of a
  thousand, so keeping them binary made `250G`-shaped input ambiguous in
  exactly the direction that over-states a volume and makes the free-space
  watermark fire late. Decimal SI (`G`, `GB`) is refused for that reason;
  a fraction (`1.5Gi`) is refused for a different one, that the grammar
  deliberately admits whole units of one multiplier and nothing else -- the
  value is an exact byte count, it is simply not a spelling this grammar has.
  A whole-unit size whose product does not fit in 64 bits is refused rather
  than wrapped. The error text now names the accepted forms.

- **Chart.** `values.schema.json` admits only Kubernetes binary quantities
  for the claim sizes the server is told (`^[1-9][0-9]*(Ki|Mi|Gi|Ti)$`), so a
  decimal `250G` -- or the server's own `250GiB`, which the API server would
  refuse -- fails `helm lint` instead of rendering a pod that cannot start.
  The Deployment sets `enableServiceLinks: false` beside its existing
  `automountServiceAccountToken: false`; the Service keeps its name and the
  server's refusal of unknown `OBSYNC_*` names is unchanged and retested.

- **The gate now runs the chart against the binary.** `image-smoke.sh` gains
  a tenth property: `helm template` renders the deployment, the rendered
  environment is read from that render through the fail-closed YAML reader
  (`scripts/ci/chart_pins.py env` -- no variable name, value or mount path is
  typed into the smoke), and the SHIPPED image is started on exactly those
  values and must answer `/readyz`. `chart_pins.py environment` holds the
  render side: service links off, and every quantity either reader refuses is
  refused by the schema. The container job installs the pinned helm for it.

## 0.1.9 - Unreleased

- Two exact pins advance, each confirmed from its source before it was
  written rather than from the proposal text. The runtime base
  `gcr.io/distroless/static-debian13:nonroot` moves from `sha256:f7f8f729...`
  to `sha256:1c2c046b...`: `docker buildx imagetools inspect` resolves that
  tag today to index digest `sha256:1c2c046b...`, and an anonymous registry
  HEAD accepting only the index media types returns the same
  `docker-content-digest`. That digest is the multi-arch INDEX, which is what
  a `FROM` must name for both production platforms; the per-architecture
  manifests beneath it (`sha256:e754765a...` amd64, `sha256:9381e9b7...`
  arm64/v8, and four others) are different digests, and pinning one would
  break the other platform. `docker/setup-qemu-action` moves from `96fe6ef7`
  (v4.2.0) to `1f40c722` (v4.3.0) in the release publisher, with the version
  comment updated; the tag `v4.3.0` in that repository is a lightweight tag
  resolving to exactly that commit. The `library/node` major bump is held
  under issue #32 and the node stage is untouched here.

## 0.1.8 - Unreleased

- A dismissed alert GitHub has stamped `fixed_at` is skipped, counted and
  named instead of refusing the run. `Alert.historical` described exactly this
  case and then tested `most_recent_instance.state == "fixed"`, which the
  shape never satisfies, so the first live reconcile after v0.1.7 (push run
  34368935826 at `f229a46`) stopped on alert #90 with
  `was analysed on commit e4aa059…, not f229a46…` before writing anything:
  every later step was skipped, main kept its one covered open alert, and the
  publisher denied the version on the exact-SHA binding. The API partitions
  main's 78 dismissals exactly: 33 (#55–#90, `hard-coded-cryptographic-value`
  in `api/auth.rs` 583–1052, the auth nonce vectors v0.1.7 removed) carry
  `fixed_at` with their instance left on `e4aa059`, and the other 45 carry
  `fixed_at: null` with their instance on `f229a46`. The stamp is what earns
  the exemption and an old commit alone never does: an unstamped dismissal
  whose instance names another commit, and any OPEN alert that does, are still
  refused as superseded or foreign, and the ref and analysis-key bindings now
  hold in every state. The stamp is read for its presence, null or a non-empty
  string, and its syntax is not validated: the ref, the analysis key and the
  alert's own state are what guard the exemption. `fixed_at` can be read at face value because the job
  waits for `processing_status: complete` on both analyses before it lists
  anything, and on a pull request the base listing now requires the analysis
  record it selects per language to report an empty `error` — agreement on a
  commit is not evidence that the analysis of that commit succeeded, and there
  is no fallback to an older healthy record.

## 0.1.7 - Unreleased

- A journal append that fails is rolled back to the length the journal has
  made durable and the cut is fsynced, so the next frame starts clean and a
  write acknowledged after a failure can no longer be discarded by the next
  start's truncation; if that rollback itself fails the journal is faulted,
  every later append refuses with `journal_faulted`, `/readyz` answers 503
  with the reason to restart, and the line names both the append's and the
  rollback's error kinds.
- The journal volume has its own free-space watermark, refusing a frame with
  `507 journal_full` against `OBSYNC_JOURNAL_CAPACITY` minus everything the
  journal root holds, snapshots included; `VolumeStatus` reports that same
  number, and the image smoke gained a ninth property that exhausts a real
  blob volume and requires the server's `io=StorageFull` account, its 503,
  and its recovery when the space comes back.
- A journal accounting survey that is itself refused is now recorded as a
  fact of its own rather than dropped: the tracked total is marked unverified,
  a survey publishes both of its halves or neither, and while it stands the
  server is fail-closed — an append retries the survey once and otherwise
  refuses with `503 journal_unverified` having written nothing, so the
  watermark is never decided against a figure nothing has re-read. `/readyz`
  retries the survey too and answers `503 not_ready` with the kind that
  refused it, so a volume an operator has fixed comes back on the next probe
  with no write in between; `VolumeStatus` gained `usage_unverified` so the
  dashboard shows the figure as the last one read successfully. A faulted
  journal stays faulted however well the volume measures: that state is about
  the segment's contents and still clears only at a restart. The original
  operation error is unchanged and still what its caller gets.
- The `dispositions` reconciliation rewrites a stored justification with two
  writes, `state=open` then `state=dismissed`: GitHub refuses a `dismissed`
  write to an already-dismissed alert, which stopped the first live run on
  `main` with 78 rewrites planned. Each write announces its phase; either write
  failing is fatal to that run and blocks publication, and the next authorized
  run converges from whatever state was left. The offline step harness is now
  STATEFUL — it holds each alert's state, reason and comment, answers listings
  from them, and refuses a second dismissal the way the API does — so the
  single-write shape cannot pass the suite again.

## 0.1.6 - 2026-09-09

- CodeQL dispositions are code: `security/codeql-dispositions.json` records
  every accepted alert with its rule, its glob, its scope, one of CodeQL's
  three reasons and the issue carrying the reasoning, and a new `dispositions`
  job in `codeql.yml` waits for both analyses to be indexed and then fails any
  ref that carries an alert no entry covers — on a pull request that means the
  changed range AND the base branch, whose alerts a diff-informed pull-request
  analysis never shows and whose dismissed alerts count too, judged in the
  commit the base's analyses ran on. On a push to `main` the job first
  reconciles the alerts that are already quiet — a dismissal nothing covers is
  reopened, a stored justification that is not this file's is rewritten — then
  dismisses every covered open alert and requires `main` to hold zero, so
  nobody dismisses by hand, nothing is excluded from analysis, and a new real
  finding blocks the gate and the release chain until it is fixed or
  dispositioned in a reviewed pull request.
- An acceptance over product code now names what was reviewed: `line_is` (the
  exact source line) or `reviewed_sha256` (the file's bytes), verified on every
  run whether or not an alert touches the file, so an edit to accepted code
  cannot land without re-triage in the same pull request. Every judged alert
  must also name the commit it was analysed on and this workflow's analysis
  key, so a superseded or foreign record cannot supply a line number to a
  checkout that never produced it.

## 0.1.5 - 2026-09-09

- Every line that states a storage refusal now names the `io::ErrorKind`
  behind it (`io=StorageFull`, `io=PermissionDenied`, `io=NotFound`) through
  the one helper the request path already used, so the five fatal startup
  refusals, the collection, unlink and scrub lines, the snapshot retries, the
  expired-pairing sweep, the dropped `seen` event and the `check`/`export`
  refusal say WHICH I/O stopped them instead of `refusal=io_error` alone.
- The image smoke's `deny` adds the number behind that word: `df` of both
  volumes read from inside the compose path's digest-pinned throwaway image,
  and the daemon's own `docker system df`, both best-effort so neither can
  mask the refusal they explain.

## 0.1.4 - 2026-09-09

- The chart's `deploymentReady` gates the replica count instead of only
  annotating it. False, the shipped default, renders every object with
  zero application replicas, so the claims can bind their volumes and the
  TLS proxy can resolve the Service while no Pod waits on a volume or a
  Secret that does not exist yet; true is a scale from zero to one. The
  chart pins render both values and refuse a non-boolean.

## 0.1.3 - 2026-09-08

- The publisher attests with the URI form of the provenance type
  (`--type https://slsa.dev/provenance/v1`): the named `slsaprovenance1`
  makes cosign re-serialise the predicate through its typed struct and
  drop BuildKit's layer metadata, which is what the contract binds each
  platform through. The contract accepts the in-toto Statement v0.1 that
  cosign emits. v0.1.2's publisher run built, signed and attested its
  image, then refused its own attestation on both counts, so that tag
  carries no chart and no Release; nothing weaker was accepted.

## 0.1.2 - 2026-09-08

Tagged and its image published, signed and attested; the publisher's own
verification refused the attestation (statement type; predicate stripped of
its layer groups), so this version received no chart and no GitHub Release
(repaired in 0.1.3).


- The release publisher attests the image's SLSA v1 provenance onto the
  published digest with its own identity, one statement per platform,
  and proves it verifies with the consumer's command before the chart
  embeds the digest. v0.1.1's image carries BuildKit provenance but no
  signed attestation, which the platform's acquisition check requires.
  `scripts/ci/provenance_contract.py` decides, offline, what each
  statement binds: the BuildKit v1 shape naming this exact run, and one
  production platform, identified by the layer digests of that platform's
  manifest; every platform gets exactly one statement, on a fresh build
  and on a reused digest alike.

## 0.1.1 - 2026-09-08

- The release publisher checks the plugin bundle's listing for the names
  the archive holds. The first v0.1.0 publisher run exported a correct
  bundle and then failed its own check, looking for `./main.js` in a
  listing that said `main.js`; v0.1.0 keeps its tag, signed image and
  signed chart and received no Release.
- The nonce log's compaction recovery contract is published for operators
  (`docs/storage.md`, "Nonce log recovery"), and each of its sentences is
  pinned by a test that drives a real compaction over a real volume.

## 0.1.0 - 2026-09-08

Tagged, with its image and chart published and signed; it received no
GitHub Release because the publisher's bundle check failed after them
(repaired in 0.1.1).

### Added

- Repository contract, architecture, wire protocol, storage, threat model,
  benchmark, validation, and platform-onboarding documents.
- Start-time volume posture: `serve`, `check`, and `export` measure the type,
  owner, and mode of both volume roots and both credential files before
  anything is read or written through them. A weak mode is corrected and
  re-read; a link, a substituted type, or a foreign owner refuses the start.
- A ceiling on the heads one file may hold, equal to the parents one version
  may declare, so a conflicted file is always resolvable by one merge naming
  every head and the head list a response carries is bounded. The version
  that would pass it is refused with `409 too_many_heads` and nothing
  already stored changes; replay applies what the journal already holds.
- Replay protection that survives a restart: every accepted nonce is
  appended to `v1/nonces` on the journal volume and fsynced before its
  request is answered, and a start loads back what the 600 s window still
  covers. The file is rewritten once it passes twice the cache's ceiling, a
  torn final line costs only itself, and a volume that will not take the
  record refuses the request with `503 nonce_log_unavailable`, and a link
  standing where that file belongs refuses the start.
- Pending devices are reconciled against the pairing table on every start.
  A pairing lives in memory and the device a claim creates is journaled, so
  a restart used to leave an unapproved claimant nobody could approve and
  expiry could not reach, holding its wrapped secret for the life of the
  store. It is now destroyed down the path expiry uses, with one line
  stating the count.
