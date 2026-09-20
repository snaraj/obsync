# Self Hosted Private Sync

Self-hosted, end-to-end encrypted live sync for [Obsidian](https://obsidian.md).
One dependency-free Rust binary with a built-in dashboard, plus an Obsidian
plugin. Files of any size, bounded only by your disk. No subscription, no
third-party service, no crates, no npm packages.

This site is a rendering of the `docs/` folder of
[snaraj/obsync](https://github.com/snaraj/obsync). Every page here is a
Markdown file in that repository, reviewed in a pull request like any other
file, and readable without this site. A few documents live at the root of the
repository rather than in `docs/` — the README, the changelog, the security
policy, the contributing guide, the agent contract, and the Helm chart's own
README — and the navigation links to them where they are instead of keeping a
second copy here.

## Where to start

| You want to | Go to |
| --- | --- |
| Get two devices syncing | [Quickstart](quickstart.md) |
| Put the server somewhere | [Run the server](server.md) or the [Helm chart](https://github.com/snaraj/obsync/blob/main/chart/README.md) |
| Install or update the plugin | [Install the plugin](community-plugin.md) |
| Know what a setting does | [Settings reference](settings.md) |
| Fix something | [Troubleshooting](troubleshooting.md) |
| Get back in after losing a device | [Recovery](recovery.md) |
| Know what the server can see | [Threat model](threat-model.md) |
| Read the design | [Architecture](architecture.md) and [Protocol](protocol.md) |

## Where things live

| Path | Contents |
| --- | --- |
| `crates/obsync-core` | Homegrown primitives: SHA-256, HMAC, HKDF, CRC32, encodings, JSON, HTTP/1.1 |
| `crates/obsyncd` | The server: storage engine, journal, sync API, dashboard, CLI |
| `plugin/` | The Obsidian plugin (TypeScript, WebCrypto, no runtime dependencies) |
| `dashboard/` | Static dashboard assets embedded into the server |
| `chart/` | Helm chart |
| `bench/` | Benchmark harness; LiveSync is the reference to beat |
| `docs/` | Architecture, protocol, storage, threat model, validation, onboarding |

Start with
[`AGENTS.md`](https://github.com/snaraj/obsync/blob/main/AGENTS.md) (the
contract) and [Architecture](architecture.md).

## Building this site

```sh
python3 -m venv .venv
.venv/bin/pip install --no-deps --only-binary=:all: -r docs/requirements.txt
.venv/bin/mkdocs build --strict
```

`mkdocs.yml` at the repository root carries the navigation and the reasoning
behind it; `docs/requirements.txt` pins every package the build installs, with
no resolution step. `.github/workflows/docs-site.yml` runs the same two
commands on every pull request and deploys the result to GitHub Pages on
pushes to `main`.
