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
- Public exposure on the reference deployment is a Cloudflare Tunnel with
  Cloudflare Access in front of it; the pod is reachable only from the tunnel
  connector under a default-deny NetworkPolicy.
- Releases are signed (cosign keyless), deployed by digest, and immutable.

## Out of scope

- Hiding file sizes, counts, and timing from the server (see threat model).
- Recovering a vault whose every device and recovery key are lost. That is
  the design, not a defect.
