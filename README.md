# obsync

Self-hosted, end-to-end encrypted live sync for [Obsidian](https://obsidian.md).
One dependency-free Rust binary with a built-in dashboard, plus an Obsidian
plugin. Files of any size, bounded only by your disk. No subscription, no
third-party service, no crates, no npm packages.

> Status: pre-release. The first validated release is `v0.1.0`.

<!-- README screenshot rule (AGENTS.md): this section leads with captures of
     the dashboard and the plugin once they render. Placeholders until then. -->

## Screenshots

_Dashboard overview, devices table, and the plugin's sync status will appear
here on the first release._

## What it does

- Syncs a vault across every Obsidian platform (macOS, Windows, Linux, iOS,
  iPadOS, Android) through a plugin that talks to your own server.
- Encrypts every chunk and every manifest on the device. The server stores
  ciphertext only and never learns the vault key or a single file name.
- Handles large files by content-defined chunking with resumable, deduplicated
  uploads: a 100 GB video and a 2 KB note follow the same path.
- Keeps versions and never silently discards a conflicting edit.
- Ships a dashboard: account, devices (type, address, country, last sign-in,
  last edit), storage per volume, scrub and garbage-collection status, pairing,
  and plugin install.
- Runs as one static binary: Docker, Kubernetes (Helm chart included), or a
  bare host.

## Layout

| Path | Contents |
| --- | --- |
| `crates/obsync-core` | Homegrown primitives: SHA-256, HMAC, HKDF, CRC32, encodings, JSON, HTTP/1.1 |
| `crates/obsyncd` | The server: storage engine, journal, sync API, dashboard, CLI |
| `plugin/` | The Obsidian plugin (TypeScript, WebCrypto, no runtime dependencies) |
| `dashboard/` | Static dashboard assets embedded into the server |
| `chart/` | Helm chart |
| `bench/` | Benchmark harness; LiveSync is the reference to beat |
| `docs/` | Architecture, protocol, storage, threat model, validation, onboarding |

Start with [`AGENTS.md`](AGENTS.md) (the contract) and
[`docs/architecture.md`](docs/architecture.md).

## License

MIT. See [`LICENSE`](LICENSE).
