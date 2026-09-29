# Threat model

*For anyone deciding whether to trust obsync, and for reviewers.*

Dated 2026-09-20. Assets, adversaries, what holds, what does not.

The dashboard is one surface with its own entry points, session rules and
residuals; [`security/dashboard.md`](security/dashboard.md) is that page and
this one does not repeat it.

## In plain words

- **Encrypted on your device, before anything is sent:** the contents of
  your notes and attachments, and their file and folder names. The server
  stores only that ciphertext and never holds the key that opens it.
- **What the server can see**, and so anyone who runs it or takes its disks:
  how many files there are, their sizes, when they change, how their versions
  relate, and which devices use it, with the names you gave them, their
  network addresses and when they last signed in.
- **What sits in front of the server** (your HTTPS proxy, or a tunnel
  provider) sees the same, plus the sign-in credentials that pass through it.
  It never sees note contents or the key.
- **A paired device can read the whole vault.** If one is lost, revoke it
  ([Recovery](recovery.md)).
- **Not hidden from the server:** the number of files, their sizes and their
  timing.

The rest of this page is the precise version, for reviewers.

## On a work laptop, or a network you don't control

The question this answers: *I use Obsidian on my work laptop, behind my
employer's VPN, and I don't want them to see my notes.* Two different things
are in play, and obsync defends one of them completely and the other not at
all.

**The network — defended.** An employer's VPN, an "TLS-inspecting" proxy, or
any box that decrypts your HTTPS to look inside it, sees exactly what the
server sees, and no more: that a device talks to your server, how many files
there are and how big, when they change, and your devices' names, platforms,
app versions and addresses. It does **not** see the contents of any note or
attachment, any file or folder name, your vault key, or your recovery words —
those are encrypted on your device before anything is sent, and only
ciphertext leaves it. This is proven, not asserted: `scripts/ci/observer.mjs`
records every byte of a real session exactly as such a proxy would hold it and
searches it for the note text, the names, the vault key and the recovery
words, in every encoding; the search finds nothing (`docs/validation-runs`).

**The laptop itself — not defended, by anyone.** If your employer manages the
laptop (MDM), runs endpoint monitoring (EDR), can read its disk or its
keychain, or can watch your screen, then they can read your notes the same way
you can, because the notes are decrypted there for you to work on. No sync tool
changes that: the plaintext lives on the device by definition. If that is your
worry, the answer is a device you control, not a setting in obsync.

**The one credential that does cross in clear: your device's key to the
server.** When you set up the first device, and when you pair a new one, the
server hands that device a *device secret* — its key for making authenticated
requests. That secret crosses the network at that moment, so a proxy that is
decrypting your traffic then can capture it. The secret is **not** your vault
key: whoever holds it still cannot read a single note. But it carries the same
authority over the *account* that every paired device has: with it, and
without ever reading your content, someone could rename or remove your devices
or post changes that clutter your history — enough to disrupt your sync until
you revoke that device. A recovery key registered by anyone but you does not go
unnoticed: every device of yours that meets a recovery key it did not register
shows a warning that cannot be dismissed, a recovery key registered in the last
7 days cannot be used to remove your last working device, and whoever runs the
server can clear an unrecognised recovery key with an `obsyncd` command
([Recovery](recovery.md)). They cannot read, forge, or silently alter your
notes: a change that isn't sealed with your vault key is refused by every
device that has the key, your note is left untouched, and you are told which
device sent it.

**What to do.**

1. **Set up and pair where you trust the network** — your home Wi‑Fi, or a
   connection your employer does not inspect. Once a device is paired, it never
   sends its secret again; the exposure is only at setup and pairing.
2. **Type the pairing code into the other device; don't send it to yourself
   through work channels.** The code carries the secret that opens the sealed
   envelope your vault key travels in. Mailing it to your work address, or
   pasting it into a work chat, hands that secret to whatever inspects those
   channels. See [Troubleshooting](troubleshooting.md).
3. **If a device's code or secret may have leaked, revoke that device**
   ([Recovery](recovery.md)) and, if you had not yet written down your recovery
   phrase, do so — a revoked device can make no further requests.

## Assets

1. Vault plaintext and file names.
2. The vault root key and domain keys.
3. Device secrets (API access).
4. Availability and integrity of the stored history.

## Adversaries and outcomes

| Adversary | Can see or do | Cannot |
| --- | --- | --- |
| Passive network attacker | nothing beyond TLS metadata on the public leg | read content or forge requests |
| TLS terminator / edge operator | request metadata, ciphertext, and credentials in clear at the terminator: the device secret at setup/pairing, the account-recovery authentication proof and setup token, dashboard session cookies and recovery sign-in links. A captured device secret carries that device's **account** authority (the "Compromised or lost device" row): the holder can disrupt sync and act on devices, without ever reading content | read vault content, names or vault keys; replace client code through the sync server (installation uses Obsidian's directory and GitHub assets, with the client trust limits in `docs/community-plugin.md`) |
| Server operator or stolen volumes | ciphertext, sizes, version graph, device activity; wrapped device credentials can be recovered if the server wrapping key is also available | decrypt vault content without a device-held vault key |
| Compromised or lost device, or a holder of its device secret | read the vault it holds; and, with only the device secret and no vault key: rename or revoke ANY device, register account recovery, change a device's mobile ceilings, post tombstones or garbage versions (clutter, forced-conflict state, and quota or journal exhaustion). All of this is availability and account control; NONE of it reads or forges content | read or forge content with that secret; register a recovery verifier unnoticed — every device that meets a verifier it did not register shows a warning that cannot be muted, a verifier registered in the last 7 days cannot unlock revoking the last active device, and the operator can clear an unrecognised verifier with an `obsyncd` command (1.1.5); erase history (retention keeps versions); make new authenticated server requests after revocation; make ANOTHER device accept altered or injected content or a deletion — a change not sealed with the vault key is refused as `undecryptable`, the receiver's note is left untouched and it is told which device sent it (`plugin/test/vault-identity.test.mjs`); write outside another device's vault root, through a symlinked folder, or into hidden folders (manifest paths are confined on the filesystem, not lexically); make another device exceed its per-file ceiling, its total budget, or its batch memory bound, or write a byte it has not verified (every decrypted manifest is bound field by field to the authenticated record before policy, download, or a write, and every declared chunk length is proved against the bytes); lock the other devices out of the replay cache (each device holds its own share of it) |
| Unapproved pairing claimant | poll its own pairing for the envelope | call any other device route: a pending device has no authority until it collects the envelope the creator approved; outlive its pairing without collecting it (expiry destroys it, approved or not, and so does the next start, since pairings do not survive one) |
| Holder of a leaked pairing code | claim it first, under any name it likes | show the owner the match code of the owner's own device: the code is derived from the pairing secret and the device id each claim gets, so the prompt shows the racing claim's own code and the owner's screen shows another (1.1.4) |
| Other cluster tenant, or another account on the host | nothing (default-deny NetworkPolicy, non-root pod, volume roots 0700 and credential files 0600, measured and corrected on every start, `docs/storage.md`) | reach the API or the volumes, or read the recovery login or the wrapping key off a restored or bind-mounted volume |
| Malicious client input | attempt parser abuse, oversize bodies, replay, forged sids | pass unverified data (sid check, HMAC, limits); replay a captured request across a restart (accepted nonces are durable); grow a file record or a feed page without bound (heads, sids, parents and manifests are all capped, a file record stops at 450 MiB with every head in it, and a feed page stops at 8 MiB, `docs/protocol.md`); make the server keep more than 64 MiB of what callers sent before their credential verified, parsed or waiting for a lock included (each body stays reserved until its credential verifies, and a setup or claim body, parsed first, reserves 4 MiB for at most 16 KiB) |

## Deliberate non-goals

The plugin's device-local folder selection additionally confines its own
file reads, writes and deletions to selected folders, including remembered
rename sources and conflict/history paths (`docs/architecture.md` 6.2.1).
It does not restrict Obsidian's own vault indexing, other plugins, the local
OS, or what a paired device can read from content already uploaded. Every
paired device still holds the owner key and account-wide API authority.
Keep administration code outside selected folders, and treat shared note
content as untrusted when opening links or copying commands from it.

- Recipients and multi-user access: out of scope in v0.1; the server is
  owner-only. Every paired device is the owner, so no adversary row below
  describes a second person with partial access, because v0.1 cannot
  express one. The acceptance criteria that gate phase 2 are in
  `docs/architecture.md` section 5.
- Hiding file counts, sizes, timing, and version-graph shape from the
  server. Size padding is deferred.
- Recovering a vault after every device and the recovery phrase are lost.
- Protecting a device against its own operating system.

Device credentials, vault keys and edge headers use Obsidian's native
SecretStorage rather than plaintext plugin data. The exact owned reference
and a matching device/server revision are required on load; there is no
plaintext fallback or search through other secrets. Current and previous
credential records are retained in a bounded envelope for interrupted
metadata updates. SecretStorage is shared with trusted plugins in the vault,
not isolated from those plugins or the OS. Universal OS encryption and a
crash-durable transaction with plugin data are not documented API guarantees.
Native app-restart persistence remains separate acceptance evidence.

## Controls by requirement

- Content confidentiality: AES-256-GCM per chunk with per-chunk derived
  keys; manifests under a separate key; paths only inside manifests.
- Request integrity and authenticity: HMAC over method, path, timestamp,
  nonce, body hash; a ±300 s window and a 600 s nonce cache that rests on the
  journal volume, so the window a captured request has to beat is not
  reopened by a restart.
- Storage integrity: sid verification on write, scrub on read schedule,
  plaintext hash verified by the client before any vault write.
- Availability: fsync-before-ack, watermark refusals, retention and
  automatic GC, health probes that tell the truth.
- Least privilege: non-root, read-only root filesystem, one listener,
  default-deny network, digest-pinned signed images.

## Residual risks recorded for v1

1. Every credential crosses the TLS terminator in clear: the device secret
   at setup/pairing, the account-recovery proof plus setup token, and the dashboard session cookie
   and recovery link for as long as sessions exist. The terminator is in the
   trust base for credentials and out of it for content
   (`docs/architecture.md` 2.1, choice 1). The dashboard's cookies are
   `Secure` and `__Host-`-prefixed, which stops the leg between the
   terminator and the browser from ever being plaintext, and makes a
   dashboard served over plain HTTP by IP address unsupported by
   construction ([`security/dashboard.md`](security/dashboard.md)).
2. Single copy on one node (owner-accepted; mirrors and replicas are the
   path).
3. Desktop vault-boundary races: the plugin binds every path component with
   no-follow stats before and after each open and rename, which closes a
   swap between the walk and the open; Node's filesystem API has no
   directory-relative opens, so a local attacker who can race the write
   itself is not defended against (a device's own operating system is a
   non-goal above).
4. The hop from the TLS terminator to this process is plain HTTP. What
   bounds it is reachability -- a default-deny network policy and a
   restricted pod-security level -- and not encryption; a sidecar terminator
   would make it loopback (`docs/architecture.md` 2.1, choice 2).
5. On a public hostname behind a tunnel provider, that provider's terms and
   not this server bound a sustained bulk transfer. The any-size promise is
   the server's; the transport is the deployer's, and a bulk first sync
   belongs on a LAN or VPN where one exists (`docs/architecture.md` 2.1,
   choice 3).
6. The dashboard's decision log is two bounded in-memory rings, not an audit
   trail: unauthenticated traffic evicts only unauthenticated traffic, but
   neither ring is durable and a restart empties both. Process stdout is the
   record ([`security/dashboard.md`](security/dashboard.md)).
7. Homegrown primitives: mitigated by published test vectors,
   differential tests against the host's OpenSSL in CI, a verify-only
   asymmetric surface, and constant-time construction by design; a
   dedicated security review is required before any primitive changes.
8. On Linux, Obsidian's secret storage is only as private as the desktop's
   keyring: without one it still keeps the vault key and device secret,
   unencrypted (Obsidian 1.13.7, issue #217; from its next start Obsidian
   shows a notice saying so), protected then by the home folder's
   permissions alone. Obsidian's API does not say which storage it uses, so
   the plugin cannot detect it; `docs/community-plugin.md` tells the user.
