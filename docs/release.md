# Release path

Dated 2026-09-07. Requirement 10 in `AGENTS.md`, made operational.

## Lockstep locks (seven)

`VERSION`, `Cargo.toml` workspace `version`, `chart/Chart.yaml` `version`
and `appVersion`, `chart/values.yaml` `image.tag` (`vX.Y.Z`),
root `manifest.json` `version`, and the `CHANGELOG.md` heading `X.Y.Z`.
`scripts/ci/release_contract.py` walks every commit in `base..head` and
denies skips, reversions, and mixed ranges without exactly one release step.
A STEP is one patch (`X.Y.Z+1`), one minor (`X.Y+1.0`), or one major
(`X+1.0.0`), and nothing else: a step zeroes every field below the one it
advances, so `X.Y+1.1` and `X+1.0.1` deny beside `X.Y.Z+2`. One step at a
time, never a skip, is the whole rule -- which is what makes 1.0.0 reachable
from 0.Y.Z without a gate edit in the pull request that needs the gate.

Four followers move with the locks and are held by gates, not by the
classifier: `plugin/package.json` `version` and its two copies in
`package-lock.json` (the plugin's bundle test compares the built manifest to
both sources); `Cargo.lock`, refreshed by `cargo check` (`--locked` in the
image and gate refuses a stale one); and root `versions.json`.

`versions.json` is the ledger Obsidian's community-plugin installer reads to
decide WHICH release a given Obsidian version may install: the newest plugin
version whose recorded `minAppVersion` that app satisfies. It is not an eighth
lock, because it does not carry one version — it accumulates one row per
published version and its older rows must not move when the head advances.
`scripts/ci/versions_json.py` decides and `scripts/ci/test_versions_json.py`
runs it over the committed tree in the `security` job and in `make check`: the
head version must be the last row and must carry exactly root
`manifest.json`'s `minAppVersion`, every key and value must be a bare `X.Y.Z`,
the rows must ascend, and no row may name a version above the head. A gap is
admissible and 0.1.15 is one: it was built but never published, so a row for
it would promise the installer a download that does not exist. The floors this
plugin has published are 1.7.0 (0.1.11-0.1.12), 1.7.2 (0.1.13-0.1.14) and
1.12.4 (0.1.16 onwards), each read from that release's own `manifest.json`.

## Classifier

Two verdicts, no flag: `artifact` (any path outside the documentation
allowlist changed, and every lock advanced exactly one release step) or
`no-artifact` (every commit confined to root `AGENTS.md`, `README.md`,
`.gitignore`, and Markdown under `docs/`; no lock touched).

**Genesis.** A range whose base carries NONE of the seven locks — the state a
repository born from GitHub's own root commit is in, which the release-step
rule cannot classify because there is no version to advance — is `artifact`
only if the head carries all seven locks agreeing on one version, every commit
that introduces a lock introduces it at that same version, and no commit
removes one; anything else from a lock-less base denies by name. A base
carrying any lock takes the ordinary rules unchanged, so genesis governs
exactly one range and is unreachable once `main` has a `VERSION`.

## Publisher

`release-after-main.yml` (holds `actions: write`, `contents: read`; cannot
create refs) dispatches `release-publisher.yml` with the successful run id.
The publisher's read-only authorization job verifies the run, repository,
workflow path, push event, main branch, source SHA, and PR-gate job
inventory; then its write/packages/OIDC job builds the multi-arch image
(linux/amd64, linux/arm64) with checksum-pinned tools, signs image and OCI
chart keyless (identity `refs/heads/main` of this repository), attaches
`obsync-plugin-X.Y.Z.zip` and the individual `main.js`, `manifest.json`, and
`styles.css` files from the same image build. The v2 evidence manifest binds
the ZIP digest and each file's digest, size and content type.

**The Release body.** From 1.0.1 the notes lead with that version's own
`CHANGELOG.md` section, read out of the SOURCE COMMIT rather than out of a
working tree, then the one line that installs or updates the plugin and the one
that upgrades the server by digest, and fold the artifact table, the signing
identity and the evidence digest under `Supply-chain evidence`. Releases
through 1.0.0 keep the body they published, byte for byte: the read-only audit
re-derives the notes from the sealed manifest and compares them, so a format
change that reached backwards would fail against a release nobody can edit.
`scripts/ci/test_community_release.py` pins both shapes and the boundary
between them. The publisher
requires the exact five-asset inventory and reads every uploaded byte back
before immutable publication. It scans source and final image for
high/critical findings, and publishes one immutable Release.

From 0.1.15, the publisher also creates GitHub Actions SLSA v1 build
provenance for `main.js`, `manifest.json` and `styles.css`. The dispatch
workflow SHA must equal the authorized source SHA before any publication
write, because GitHub's provenance derives that identity from the workflow.
The orchestrator dispatches against `main`; if `main` advances before that
dispatch binds its workflow commit, publication of the superseded source is
refused before the first tag or artifact write. Automatic publication requires
the dispatch context to match the validated source.
The exported bytes are verified against the attestation bundle before release
publication; the read-only audit later verifies downloaded bytes through the
attestation API. This adds no Release asset and preserves earlier evidence.

The GitHub tag is exactly the root manifest version, `X.Y.Z`, as required by
Obsidian's native installer. Container image tags remain `vX.Y.Z`; chart tags
remain `X.Y.Z`. These names are distinct inputs, and the scheduled audit
rebinds each alias to the digest in the sealed evidence.

Releases through `v0.1.10` are immutable history. The read-only audit retains
their exact v1 schema, notes, two-asset inventory and prefixed tags. The
historical Git reader accepts `plugin/manifest.json` only for those versions
and rejects duplicate manifests. Publishing with the migrated workflow
requires the root manifest and v2 evidence. A missing new asset never selects
legacy behavior. The audit also checks the source commit's complete release
locks, so a manifest cannot choose an older publication format for new code.

The plugin ID is version-bound independently of the GitHub tag format:
releases through 0.1.11 retain `obsync`; releases from 0.1.12 require
`obsync-private-sync` in both the source manifest and bounded plugin archive.
Downloaded metadata cannot select a different identity or an older format.

The native provenance verifier uses an exact certificate identity containing
the repository, workflow path and main ref. GitHub CLI makes that selector
mutually exclusive with `--signer-workflow`; combining them refuses the
command before any cryptographic verification. The separate repository,
source ref/digest, signer digest, issuer, hosted-runner and SLSA-v1 checks
remain required. The local argument regression invokes real `gh` against a
malformed local bundle; live signed-attestation verification is separate.

Native installation and the first directory submission are described in
[Community plugin distribution](community-plugin.md). Publication alone does
not prove directory acceptance, installation, or device synchronization.

## Governance receipt

Before the first Release under this path the owner activates: immutable
releases, strict required checks at the exact head, no core bypass actor,
signed commits on `main`. The read-only preflight and the standalone bypass
check are the same commands as the sibling repositories' release governance
document and are pinned in `scripts/ci/test_release_contract.py`.

## Deployment

Publication is never deployment. The promoter in the platform repository
selects the digest; Flux deploys it; the deploy-assurance watchdog reports
drift. See `docs/platform-onboarding.md`.
