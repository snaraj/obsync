# Documentation

Every page under `docs/`, and the repository files a reader reaches for. The
[README](../README.md) is the short guide; these are the long ones.

**Versions.** These pages describe `main`, which is the EDGE: merged but
unreleased work. The LATEST release is the newest tag on the
[Releases page](https://github.com/snaraj/obsync/releases/latest) and is what
Obsidian installs; read the [`CHANGELOG.md`](../CHANGELOG.md) entry for the
version you run. There is no beta channel and no pre-release tag.

| Page | What it answers |
| --- | --- |
| [Quickstart](quickstart.md) | The first device and the second one, every step in full, with the validated-run captures |
| [Run the server](server.md) | Docker, Compose with Caddy, certificates, backups, reaching it from outside your LAN |
| [Cloudflare](cloudflare.md) | Tunnel with a private route and the Cloudflare One client, or a public hostname behind Access |
| [Kubernetes](../chart/README.md) | Installing the server with the signed Helm chart |
| [Daily use](daily-use.md) | Commands, the status bar, what syncs and what does not, restoring a version, the dashboard |
| [Settings](settings.md) | Every setting, its default, and when to change it |
| [Troubleshooting](troubleshooting.md) | Symptom, cause, fix, and how to collect a report |
| [Conflicts](conflicts.md) | What a conflict copy is and what to do with it |
| [Recovery](recovery.md) | A lost device, a lost server, a moved server, a rotated token |
| [Purging a server](purge.md) | Wiping the journal and the blobs, and re-pairing every device afterwards |
| [Installing and updating](community-plugin.md) | Obsidian's directory, updates, credential custody, the listing review |
| [Threat model](threat-model.md) | What is defended, and what is not |
| [The dashboard's threat model](security/dashboard.md) | Sessions, sign-in, revocation, residuals |
| [Architecture](architecture.md) | How the whole system is built, and every environment variable |
| [Protocol](protocol.md) | The wire contract between plugin and server |
| [Storage](storage.md) | Volumes, durability, retention, scrub, and every refusal |
| [Validation](validation.md) | The device validation plan and what "ready" means |
| [Validation runs](validation-runs/) | What each run on real devices covered, and what it did not |
| [Benchmarks](benchmarks.md) | Measured against LiveSync, each number naming the command that produced it |
| [Platform onboarding](platform-onboarding.md) | What the reference cluster adds for a published hostname |
| [CI map](ci-map.md) | What each CI job runs and what that proves |
| [Releases](release.md) | How a release is cut, signed, and audited |
| [Captures](captures/README.md) | The five validated-run screenshots, their form, and the redaction rules |
| [Translations](translations.md) | Which languages the guides exist in, and how they are kept current |
| [`CHANGELOG.md`](../CHANGELOG.md) | What changed in each version |
| [`SECURITY.md`](../SECURITY.md) | Posture, supported versions, and how to report a vulnerability |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | How to work on this repository |
