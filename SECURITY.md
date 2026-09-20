# Security

## Reporting

Report suspected vulnerabilities privately through GitHub's security
advisory form for this repository ("Report a vulnerability"). Do not open a
public issue for anything security-sensitive. Reports are read by the
owner; expect a reply within a week.

## Supported versions

Only the latest released version (the newest `X.Y.Z` release) is supported.
Legacy releases through `v0.1.10` retain their original prefixed tags.
Fixes ship as new versions, never as re-tags.

## Posture (what you can rely on)

- Vault content is encrypted on the device before it leaves it. The server
  stores ciphertext chunks and encrypted manifests and never holds the vault
  key. See `docs/architecture.md` (trust model) and `docs/threat-model.md`.
- Every API request is authenticated with a per-device HMAC over the method,
  path, timestamp, nonce, and body hash. Replays are rejected.
- The server is one static, dependency-free Rust binary in a shell-less
  distroless image, running as non-root with a read-only root filesystem.
  It speaks plain HTTP and is always deployed behind a TLS terminator.
- The reference deployment is private and owner-only: no public hostname, no
  public route, and no access application in front of it. It is reached over
  private connectivity — a LAN, or a VPN back to it — and the pod accepts
  connections from exactly one named peer under a default-deny NetworkPolicy
  that denies all egress. A tunnel provider's PRIVATE route is one optional way
  to reach it from outside that network; a published hostname is a deployment
  choice this project supports and does not make.
- Releases are signed (cosign keyless), deployed by digest, and immutable.

## Out of scope

- Hiding file sizes, counts, and timing from the server (see threat model).
- Recovering a vault whose every device and recovery key are lost. That is
  the design, not a defect.
