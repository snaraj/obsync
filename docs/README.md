<img src="../brand/obsync-icon-256.png" alt="obsync icon: two interlocked rings" width="96" height="96">

# Documentation

Every page under `docs/`, grouped by who it is written for, and the repository
files a reader reaches for. The [README](../README.md) is the front door;
these are the long pages. The same pages are on the
[documentation site](https://snaraj.github.io/obsync/).

**Versions.** These pages describe `main`, which is the EDGE: merged but
unreleased work. The LATEST release is the newest tag on the
[Releases page](https://github.com/snaraj/obsync/releases/latest) and is what
Obsidian installs; read the [`CHANGELOG.md`](../CHANGELOG.md) entry for the
version you run. There is no beta channel and no pre-release tag.

## Use obsync

| Page | What it answers |
| --- | --- |
| [Choose your setup](setup.md) | How your devices reach your server, and which setups are proven on real devices |
| [Quickstart](quickstart.md) | The first device and the second one, every step, with the validated-run captures |
| [Same network, step by step](same-network.md) | A server at home and a phone on the same Wi-Fi, every screen |
| [Install the plugin](community-plugin.md) | Obsidian's directory, updates, and where credentials are kept |
| [Daily use](daily-use.md) | Commands, the status bar, what syncs and what does not, restoring a version |
| [Settings](settings.md) | Every setting, its default, and when to change it |
| [Conflicts](conflicts.md) | What a conflict copy is and what to do with it |
| [Troubleshooting](troubleshooting.md) | What you see, why it happens, how to fix it, and how to report a problem |
| [Recovery](recovery.md) | A lost device, a lost server, a moved server, a rotated token |
| [Export and offline copies](export.md) | Encrypted copies, opening plain notes offline, format and platform limits |

## Run a server

| Page | What it answers |
| --- | --- |
| [Docker and Compose](server.md) | Docker, Compose with Caddy, certificates, backups, upgrades, reaching it from outside your LAN |
| [Kubernetes](kubernetes.md) | Volumes, values, a TLS front and a private route for the signed Helm chart |
| [Chart reference](../chart/README.md) | The chart's own install, Secret and values reference |
| [Cloudflare](cloudflare.md) | An optional provider: a private route with its client, or a public hostname behind Access |
| [The dashboard](dashboard.md) | Signing in, what each page shows, revoking a device |
| [Storage](storage.md) | Volumes, durability, retention, scrub, and every refusal |
| [Purging a server](purge.md) | Wiping the journal and the blobs, and re-pairing every device afterwards |

## Trust and privacy

| Page | What it answers |
| --- | --- |
| [What this plugin accesses](../README.md#what-this-plugin-accesses) | Every surface the plugin touches |
| [Threat model](threat-model.md) | What is encrypted, what is defended, and what is not |
| [The dashboard's threat model](security/dashboard.md) | Sessions, sign-in, revocation, residuals |
| [`SECURITY.md`](../SECURITY.md) | Posture, supported versions, and how to report a vulnerability |

## Internals

### Planned CLI and MCP capabilities

These documents describe planned work, not commands available in the current release.

| Page | What it answers |
| --- | --- |
| [CLI and MCP design](design/cli-mcp-v1.1.6.md) | Staged offline CLI, management auth, native existing-server setup/device lifecycle and MCP observe; deferred storage/recovery scope |
| [Management authentication design](design/auth-v1.1.6.md) | Grant state, safe browser/bootstrap ordering, delegation, durable audit and credential custody |
| [CLI and MCP security contract](security/cli-mcp-v1.1.6.md) | Trust boundaries, credential custody and required security evidence |
| [CLI and MCP live acceptance](validation-plans/cli-mcp-v1.1.6.md) | Per-slice gate unions, real application/device proof, measured speed and public installation |

### Current implementation

| Page | What it answers |
| --- | --- |
| [Architecture](architecture.md) | How the whole system is built, and every environment variable |
| [Protocol](protocol.md) | The wire contract between plugin and server |
| [Releases](release.md) | How a release is cut, signed, and audited, and the directory listing |
| [CI map](ci-map.md) | What each CI job runs and what that proves |
| [Validation](validation.md) | The device validation plan and what "ready" means |
| [Validation runs](validation-runs/README.md) | What each run on real devices covered, and what it did not |
| [Benchmarks](benchmarks.md) | Measured against LiveSync, each number naming the command that produced it |
| [Platform onboarding](platform-onboarding.md) | What a GitOps platform repository adds to run the chart |
| [Captures](captures/README.md) | The five validated-run screenshots, their form, and the redaction rules |
| [Translations](translations.md) | Which languages the guides exist in, and how they are kept current |
| [`CHANGELOG.md`](../CHANGELOG.md) | What changed in each version |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | How to work on this repository |
