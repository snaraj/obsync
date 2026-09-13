# Threat model

Dated 2026-09-12. Assets, adversaries, what holds, what does not.

## Assets

1. Vault plaintext and file names.
2. The vault root key and domain keys.
3. Device secrets (API access).
4. Availability and integrity of the stored history.

## Adversaries and outcomes

| Adversary | Can see or do | Cannot |
| --- | --- | --- |
| Passive network attacker | nothing beyond TLS metadata on the public leg | read content or forge requests |
| TLS terminator / edge operator | request metadata, ciphertext, and credentials in clear at the terminator: the device secret at setup/pairing, dashboard session cookies and recovery sign-in links | read vault content, names or vault keys; replace client code through the sync server (installation uses Obsidian's directory and GitHub assets, with the client trust limits in `docs/community-plugin.md`) |
| Server operator or stolen volumes | ciphertext, sizes, version graph, device activity; wrapped device credentials can be recovered if the server wrapping key is also available | decrypt vault content without a device-held vault key |
| Compromised or lost device | read the vault it holds; write, delete, or corrupt versions | erase history (retention keeps versions); make new authenticated server requests after revocation; write outside another device's vault root, through a symlinked folder, or into hidden folders (manifest paths are confined on the filesystem, not lexically); make another device exceed its per-file ceiling, its total budget, or its batch memory bound, or write a byte it has not verified (every decrypted manifest is bound field by field to the authenticated record before policy, download, or a write, and every declared chunk length is proved against the bytes) |
| Unapproved pairing claimant | poll its own pairing for the envelope | call any other device route: a pending device has no authority until the creator approves; outlive its pairing (expiry destroys it, and so does the next start, since pairings do not survive one) |
| Other cluster tenant, or another account on the host | nothing (default-deny NetworkPolicy, non-root pod, volume roots 0700 and credential files 0600, measured and corrected on every start, `docs/storage.md`) | reach the API or the volumes, or read the recovery login or the wrapping key off a restored or bind-mounted volume |
| Malicious client input | attempt parser abuse, oversize bodies, replay, forged sids | pass unverified data (sid check, HMAC, limits); replay a captured request across a restart (accepted nonces are durable); grow a file record or a feed page without bound (heads, sids, parents and manifests are all capped, `docs/protocol.md`) |

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
   at setup/pairing and the dashboard session cookie
   and recovery link for as long as sessions exist. The terminator is in the
   trust base for credentials and out of it for content
   (`docs/architecture.md` 2.1, choice 1).
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
6. Homegrown primitives: mitigated by published test vectors,
   differential tests against the host's OpenSSL in CI, a verify-only
   asymmetric surface, and constant-time construction by design; a
   dedicated security review is required before any primitive changes.
