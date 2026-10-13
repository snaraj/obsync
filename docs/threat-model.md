# Threat model

*For anyone deciding whether to trust obsync, and for reviewers.*

Dated 2026-10-12. Assets, adversaries, what holds, what does not.

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
  ([Recovery](recovery.md)). Choose fresh-root rotation to reseal the current
  synced vault and pair every retained device again, or explicitly choose
  server access only. Access-only revocation leaves content keys unchanged:
  the old holder can decrypt later ciphertext a compromised server supplies.
  Strong protection begins on each device after its new-generation pin;
  neither choice erases old keys, plaintext or history.
- **Not hidden from the server:** the number of files, their sizes and their
  timing.

The rest of this page is the precise version, for reviewers.

## Visible metadata and attribution

Encryption protects contents and private names. It does not hide the fields
the sync protocol needs to store and route ciphertext:

| Surface | Visible information |
| --- | --- |
| Account and devices | Account name, device names, platform and app versions, device state and policy, creation and activity times, network address and edge-provided country when available. These names are user-supplied metadata; do not put a private note or vault title in them. |
| File and change records | Stable file/domain identifiers, version identifiers and parents, chunk identifiers and ordering, exact declared plaintext byte counts, ciphertext lengths, sealing-suite fields (and legacy manifest nonces), deletion flags, heads and sequence numbers. |
| Repeated content | Equal chunks within one generation/domain have equal ciphertext identifiers. Identical plaintext and context repeat deterministic SIV packets; folder identifiers repeat for the same path in that generation/domain. These disclose relationships without exposing the names themselves. |
| Activity and administration | Request timing and outcomes, storage/quota usage and per-device activity history, currently bounded to 256 events per device. The bound limits the application's history; an operator or network observer can retain its own observations. |

The wire fields are defined in [Protocol](protocol.md), with serialization in
`crates/obsyncd/src/api/render.rs`, address handling in `api/edge.rs` and
activity retention in `storage/index.rs`. Timing can reveal editing cadence;
obsync does not pad sizes or disguise traffic patterns.

A server-provided device id, timestamp, sequence or head list is an assertion
by that server. The content authentication described below does not make it
an independently authenticated statement of authorship or freshness. Devices
sharing the vault key can produce valid content for the same vault. A server
without that key cannot create new valid content, but can withhold or replay
previously valid ciphertext; local history can constrain what a client accepts
without proving that every client has seen the latest state. Pairing completion
on the creator likewise reports server activity; check the recipient itself to
confirm its notes sync. A server heartbeat is not proof that the recipient holds the key.

## On a work laptop, or a network you don't control

The question this answers: *I use Obsidian on my work laptop, behind my
employer's VPN, and I don't want them to see my notes.* Two different things
are in play: network observation and control of the device itself.

**The network — defended.** An employer's VPN, an "TLS-inspecting" proxy, or
any box that decrypts your HTTPS to look inside it, sees exactly what the
server sees, and no more: that a device talks to your server, how many files
there are and how big, when they change, and your devices' names, platforms,
app versions and addresses. It does **not** see the contents of any note or
attachment, any file or folder name, your vault key, or your recovery words —
those are encrypted on your device before anything is sent, and only
ciphertext carries that content. The required `scripts/ci/e2ee.mjs` regression
uses the real plugin crypto, transport and sync engine against `obsyncd`, with
in-memory vault and timer adapters. It checks setup, pairing, note creation,
edits, attachments, rename, recovery and history readback, and rejects tampered
content. Its revocation and migration assertions have their own current source
and receipts; access-only removal still leaves old content keys usable.
`scripts/ci/observer.mjs` scans the recorded HTTP bytes and decoded bodies for
the seeded content and content keys in supported encodings; the run also
scans server storage and diagnostic logs. Planted leaks before and after the
run must be detected. Missing evidence, unparseable framing or exhausted scan
budgets fail the run. This is scoped regression evidence, not a mathematical
proof, a test of every encoding, or native-device acceptance. The scanner
currently refuses streams or decompressed bodies over 64 MiB and nested
values beyond its decoding budget. Historical device records in
`docs/validation-runs/` retain their own source versions and limitations.

Content encryption does not hide sizes, timing, version relationships or
repeated-chunk equality within a domain. An active adversary's ability to
confirm guesses through chosen inputs needs separate analysis. Authentication
of ciphertext alone also does not prove freshness or identify which trusted
device authored it when devices share content keys.

**The laptop itself — not defended, by anyone.** If your employer manages the
laptop (MDM), runs endpoint monitoring (EDR), can read its disk or its
keychain, or can watch your screen, then they can read your notes the same way
you can, because the notes are decrypted there for you to work on. No sync tool
changes that: the plaintext lives on the device by definition. If that is your
worry, the answer is a device you control, not a setting in obsync.

**Account credentials cross the TLS terminator.** These include the setup
token, recovery authentication proof, dashboard credentials and your device's
key to the server. When you set up the first device, and when you pair a new one, the
server hands that device a *device secret* — its key for making authenticated
requests. That secret crosses the network at that moment, so a proxy that is
decrypting your traffic then can capture it. The secret is **not** your vault
key: whoever holds it still cannot read a single note. But it carries the same
authority over the *account* that every paired device has: with it, and
without ever reading your content, someone could rename or remove your devices
or post changes that clutter your history — enough to disrupt your sync until
you revoke that device. Routine device authentication cannot replace an existing
recovery verifier or commit strong rotation; prepare and commit also require the
owner-supplied setup token. Suite 2 registers its verifier during setup/rotation,
not through a separate startup registration. Legacy explicit registration has
mismatch warnings; those are not a universal suite-2 monitoring guarantee.
A verifier registered less than 7 days ago cannot unlock removal of the last
active device. The operator can reset it with an offline `obsyncd` command;
that reset and new token authorize choosing a verifier without proving continuity
with the prior root ([Recovery](recovery.md)). They cannot read, forge, or
silently alter your notes by creating newly authenticated content: a change that isn't sealed with
your vault key is refused by every device that has the key and your note is
left untouched. Replaying previously authentic content has the freshness
limits described above. The displayed
device attribution comes from the server; it is not proof of authorship
against a compromised server.

**What to do.**

1. **Set up and pair where you trust the network** — your home Wi‑Fi, or a
   connection your employer does not inspect. Ordinary authenticated requests
   send signatures instead of the device secret. Enrollment, including recovery or
   coordinator resume, returns a credential across the terminator; strong
   prepare/commit also send the owner token.
2. **Type the pairing code into the other device; don't send it to yourself
   through work channels.** The code carries a secret that helps open the
   sealed envelope your vault key travels in. From 1.1.5 the envelope also
   needs a key exchange only the two devices hold, so a copy of the code alone
   no longer opens it, and the match code tells you if anyone changed that
   exchange; a 1.1.5 device pairs with neither a server nor a device older
   than 1.1.5. Mailing
   the code to your work address, or pasting it into a work chat, hands that
   secret to whatever inspects those channels. See
   [Troubleshooting](troubleshooting.md).
3. **If a device's code or secret may have leaked, revoke that device**
   ([Recovery](recovery.md)) and, if you had not yet written down your recovery
   backup, do so. Revocation blocks authenticated requests on an honest server;
   rotate to a fresh root and re-pair retained devices to separate future content.
   Preserve the old backup for old history. A colluding server can still accept
   old-device requests and supply ciphertext in the old scope.

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
| Holder of a device secret without the vault key | rename or revoke ANY device, register account recovery, change a device's mobile ceilings, post tombstones or garbage versions (clutter, forced-conflict state, and quota or journal exhaustion). All of this is availability and account control; NONE of it reads or forges content | read or forge content with that secret; replace an existing recovery verifier by routine device authentication or commit strong rotation without the separate owner token; the legacy registration mismatch warning is not a suite-2 startup guarantee; erase history (retention keeps versions); make new authenticated requests to an honest server after revocation; make ANOTHER device accept altered or injected content or a deletion — a change not sealed with the vault key is refused as `undecryptable`, the receiver's note is left untouched and it is shown the server-reported device attribution (`plugin/test/vault-identity.test.mjs`); write outside another device's vault root, through a symlinked folder, or into hidden folders (manifest paths are confined on the filesystem, not lexically); make another device exceed its per-file ceiling, its total budget, or its batch memory bound, or write a byte it has not verified (every decrypted manifest is bound field by field to the authenticated record before policy, download, or a write, and every declared chunk length is proved against the bytes); lock the other devices out of the replay cache (each device holds its own share of it) |
| Unapproved pairing claimant | poll its own pairing for the envelope | call any other device route: a pending device has no authority until it collects the envelope the creator approved; outlive its pairing without collecting it (expiry destroys it, approved or not, and so does the next start, since pairings do not survive one) |
| Compromised paired device holding the vault key | read and produce valid content in that key's generation/scope, including after access-only revocation if a server supplies ciphertext; retain old content and keys after strong rotation | derive a fresh independent replacement root without approved pairing or its backup; decrypt a different vault without its key; bypass a receiving device's filesystem confinement and resource limits merely by producing valid encrypted content. Shared-key content does not establish which device authored it |
| Holder of a leaked pairing code, even one that also controls the server or the network path (a TLS-inspecting proxy) | claim it first, under any name it likes, and be refused when the person compares the codes; with a device before 1.1.5 on one end, nothing: 1.1.5 refuses to pair with one, on either side | open the vault key from the code plus a record of every pairing request (the envelope key also needs an ephemeral exchange held only by the two devices); make the two screens agree on a substituted key more often than once in a million attempts, each of which costs the person a new code: the code commits to the creator's key, the creator fixes the claim before revealing that key, and the match code covers both keys and nothing the server chooses (`docs/protocol.md`, "Pairing v2"); downgrade a 1.1.5 pair to the older pairing, which no 1.1.5 device performs (1.1.5) |
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
- Recovering a vault after every device and complete recovery backup are lost.
- Protecting a device against its own operating system.

Device credentials, roots and edge headers use the installation's owned
Obsidian SecretStorage envelope rather than plaintext plugin data. Suite 2 binds
its generation, enrollment/rotation phase and exact secret revision to a separate
nonsecret metadata marker. Missing, corrupt, copied or torn v2 custody refuses
load: no previous-revision or plaintext fallback. V1's bounded previous revision
behavior is historical only. A pending enrollment or rotation cannot be lost
through generic Leave/switch/credential changes. New root/credential authority
and its sync bookkeeping become public only after local save acknowledgement.
One old root, explicitly labeled by suite, may be retained for history only;
normal sync never tries it as an alternate current key.

SecretStorage is shared with trusted plugins in the vault, not isolated from
those plugins or the OS. Universal OS encryption and an atomic crash-durable
transaction with plugin metadata are not documented API guarantees. Native
app-restart persistence and physical-phone custody remain separate acceptance
evidence. The plugin's fail-stopped pin detects mismatch; it cannot guarantee
that host storage always encrypts its owned envelope.

Live recovery requires the complete `obsync-recovery-v2` prefixed backup,
explicit supported recovery-only capability and an existing matching suite-2
account/map. The plugin stages the root until authenticated readback; a server
cannot grant initial-map creation by omitting that map. Missing/unknown/stripped
prefixes and authentication failures never select legacy parsing or another root.
Legacy words require explicit history or recovery-and-upgrade selection, with
no intermediate legacy engine. Lost one-time enrollment may leave an orphan
server grant without a local credential; it does not justify automatic retry or
promotion. Missing entire rotation custody cannot be reconstructed from a server's
claims. A backup format prefix does not prove freshness.

## Controls by requirement

- Content confidentiality: current RFC 5297 AES-SIV-CMAC-512 with two
  AES-256 halves, context-derived keys and authenticated generation/domain/kind.
  Manifests/maps use counted parents and ordered SIDs, chunks use separate CID
  and cipher derivations, and paths remain inside manifests. Packets have a
  16-byte synthetic IV, with no legacy GCM nonce field. Authenticate before
  plaintext release; no live legacy fallback. The 64-byte derived key has only
  the entropy supplied by the 256-bit root. Determinism admits equality and
  chosen-input confirmation; per-operation caps do not impose a global offline
  key-use quota. The [E09 analysis](security/e09-key-nonce-inventory.md) retains
  conditional processed-block/KDF bounds, quantitative and native acceptance
  requirements; mode vectors do not certify the whole protocol.
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

## Residual risks and acceptance limits

1. Every credential crosses the TLS terminator in clear: the device secret
   at setup/pairing, the account-recovery proof plus setup token, and the dashboard session cookie
   and recovery link for as long as sessions exist. The terminator is in the
   trust base for credentials and out of it for content
   (`docs/architecture.md` 2.1, choice 1). The dashboard's cookies are
   `Secure` and `__Host-`-prefixed, which stops the leg between the
   terminator and the browser from ever being plaintext, and makes a
   dashboard served over plain HTTP by IP address unsupported by
   construction ([`security/dashboard.md`](security/dashboard.md)).
2. Single copy on one node (accepted for the reference deployment; mirrors and replicas are the
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
7. Server primitives are checked against published vectors. The SHA-256
   differential test compares with an available host tool and skips when
   none is present; it is not differential evidence for every primitive.
   Current device sealing composes platform WebCrypto CBC/CTR as RFC 5297 SIV;
   published CMAC/SIV vectors and an established independent full-mode oracle
   check composition, not two independent AES engines when both use OpenSSL.
   Native support/latency, physical phones, aggregate quantitative bounds and
   independent protocol review remain distinct requirements. Unsupported native
   operations refuse rather than switching modes.
8. On Linux, Obsidian's secret storage is only as private as the desktop's
   keyring: without one it still keeps the vault key and device secret,
   unencrypted (Obsidian 1.13.7, issue #217; from its next start Obsidian
   shows a notice saying so), protected then by the home folder's
   permissions alone. Obsidian's API does not say which storage it uses, so
   the plugin cannot detect it; `docs/community-plugin.md` tells the user.

Fresh-root rotation protects only content sealed under the new root and only on
transitioned devices. All retained devices must explicitly re-pair from the
trusted initiator; server device names/keys/lists do not choose recipients.
Untransitioned/offline devices can continue in the old generation through a
malicious server. The server can withhold a transition or replay authentic old
state to a client with no newer trusted witness. Local generation/receipt pins
constrain substitution and crash recovery but do not provide global freshness,
fork detection or proof that every peer transitioned. Shared content keys still
do not authenticate a physical device's authorship. Old history is read-only
under its explicitly selected root/suite; it is never a live downgrade path.
No passing component or author test alone is a full security approval.
