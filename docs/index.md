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
| Choose how your devices reach your server | [Choose your setup](setup.md) |
| Get two devices syncing | [Quickstart](quickstart.md) |
| Put the server somewhere | [Run the server](server.md) with Docker, or [on Kubernetes](kubernetes.md) |
| Install or update the plugin | [Install the plugin](community-plugin.md) |
| Know what a setting does | [Settings reference](settings.md) |
| Fix something | [Troubleshooting](troubleshooting.md) |
| Get back in after losing a device | [Recovery](recovery.md) |
| Know what the server can see | [Threat model](threat-model.md) |
| Know what the dashboard defends | [The dashboard's threat model](security/dashboard.md) |
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

From a checkout, on any machine with a container runtime:

```sh
docker run --rm --platform linux/amd64 -v "$PWD:/repo" -w /repo \
  python:3.12-slim sh -c 'pip install --require-hashes --no-deps \
  --only-binary=:all: -r docs/requirements.txt && mkdocs build --strict \
  && python3 -B scripts/ci/site_origins.py strip site \
  && python3 -B scripts/ci/site_origins.py assert site'
```

The last two commands are the same ones
`.github/workflows/docs-site.yml` runs before it uploads anything, and they are
a pair. The vendored theme bundle carries loads to other hosts whatever
`mkdocs.yml` says -- two script injections and the addresses it builds to ask a
code-hosting API about this repository -- so `strip` rewrites the injections
into the no-op their own else branch already is and neutralises every other
address a script carries. `assert` then reads the OUTPUT and refuses anything
left: HTML through a parser (every `src`, `srcset` candidate, `poster`, `data`,
`action`, `formaction`, loading `link` and meta refresh, in any case and any
quoting, protocol-relative addresses included), stylesheets for `url()` and
`@import`, scripts for every string and template literal that carries an
address, and an output too thin to have been judged at all. A link a reader may
CLICK is a navigation rather than a load: those are counted and the count is
printed. Requirement 1 admits no third-party runtime dependency, and a setting
in `mkdocs.yml` is not evidence about the bytes a reader downloads.

The container is not decoration. `docs/requirements.txt` pins every package by
exact version AND by the sha256 of the exact wheel, and a wheel's sha256 is a
fact about ONE file: the closure is resolved and hashed for **CPython 3.12 on
linux/amd64**, the interpreter and platform
`.github/workflows/docs-site.yml` pins. `--require-hashes` therefore refuses a
venv on another interpreter — and so, before it, does `--only-binary=:all:`,
because several of these packages publish no wheel at all for a newer Python.
Running the pinned image is how a reader gets the bytes CI gets.

`mkdocs.yml` at the repository root carries the navigation and the reasoning
behind it. `.github/workflows/docs-site.yml` runs the same install and the same
`mkdocs build --strict` on every pull request, and deploys the result to GitHub
Pages on pushes to `main`.
