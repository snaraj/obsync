# Threat model

Dated 2026-09-07. Assets, adversaries, what holds, what does not.

## Assets

1. Vault plaintext and file names.
2. The vault root key and domain keys.
3. Device secrets (API access).
4. Availability and integrity of the stored history.

## Adversaries and outcomes

| Adversary | Can see or do | Cannot |
| --- | --- | --- |
| Passive network attacker | nothing beyond TLS metadata on the public leg | read content or forge requests |
| TLS terminator / edge operator | request metadata, ciphertext, device secret once at pairing (v1) | read content, names, or keys; replace plugin code (the plugin never installs served code; updates come from the signed Release) |
| Server operator or stolen volumes | ciphertext, sizes, version graph, device activity | decrypt anything; device secrets are wrapped under the server key |
| Compromised or lost device | read the vault it holds; write, delete, or corrupt versions | erase history (retention keeps versions); act after revocation; write outside another device's vault root, through a symlinked folder, or into hidden folders (manifest paths are confined on the filesystem, not lexically) |
| Unapproved pairing claimant | poll its own pairing for the envelope | call any other device route: a pending device has no authority until the creator approves |
| Other cluster tenant | nothing (default-deny NetworkPolicy, non-root pod, private volume dirs) | reach the API or the volumes |
| Malicious client input | attempt parser abuse, oversize bodies, replay, forged sids | pass unverified data (sid check, HMAC, limits) |

## Deliberate non-goals

- Recipients and multi-user access: out of scope in v0.1; the server is
  owner-only. Every paired device is the owner, so no adversary row below
  describes a second person with partial access, because v0.1 cannot
  express one. The acceptance criteria that gate phase 2 are in
  `docs/architecture.md` section 5.
- Hiding file counts, sizes, timing, and version-graph shape from the
  server. Size padding is a v0.3 option.
- Recovering a vault after every device and the recovery phrase are lost.
- Protecting a device against its own operating system.

## Controls by requirement

- Content confidentiality: AES-256-GCM per chunk with per-chunk derived
  keys; manifests under a separate key; paths only inside manifests.
- Request integrity and authenticity: HMAC over method, path, timestamp,
  nonce, body hash; replay window and nonce cache.
- Storage integrity: sid verification on write, scrub on read schedule,
  plaintext hash verified by the client before any vault write.
- Availability: fsync-before-ack, watermark refusals, retention and
  automatic GC, health probes that tell the truth.
- Least privilege: non-root, read-only root filesystem, one listener,
  default-deny network, digest-pinned signed images.

## Residual risks recorded for v1

1. Device secret crosses the terminator at pairing (fixed by X25519 in
   v0.2).
2. Single copy on one node (owner-accepted; mirrors and replicas are the
   path).
3. Desktop vault-boundary races: the plugin binds every path component with
   no-follow stats before and after each open and rename, which closes a
   swap between the walk and the open; Node's filesystem API has no
   directory-relative opens, so a local attacker who can race the write
   itself is not defended against (a device's own operating system is a
   non-goal above).
4. Homegrown primitives: mitigated by published test vectors,
   differential tests against the host's OpenSSL in CI, a verify-only
   asymmetric surface, and constant-time construction by design; a
   dedicated security review is required before any primitive changes.
