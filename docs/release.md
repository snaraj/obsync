# Release path

Dated 2026-09-07. Requirement 10 in `AGENTS.md`, made operational.

## Lockstep locks (seven)

`VERSION`, `Cargo.toml` workspace `version`, `chart/Chart.yaml` `version`
and `appVersion`, `chart/values.yaml` `image.tag` (`vX.Y.Z`),
root `manifest.json` `version`, and the `CHANGELOG.md` heading `X.Y.Z`.
`scripts/ci/release_contract.py` walks every commit in `base..head` and
denies skips, reversions, and mixed ranges without exactly one patch.

Three followers move with the locks and are held by gates, not by the
classifier: `plugin/package.json` `version` and its two copies in
`package-lock.json` (the plugin's bundle test compares the built manifest to
both sources), and `Cargo.lock`, refreshed by `cargo check` (`--locked` in the
image and gate refuses a stale one).

## Classifier

Two verdicts, no flag: `artifact` (any path outside the documentation
allowlist changed, and every lock advanced exactly one patch) or
`no-artifact` (every commit confined to root `AGENTS.md`, `README.md`,
`.gitignore`, and Markdown under `docs/`; no lock touched).

**Genesis.** A range whose base carries NONE of the seven locks — the state a
repository born from GitHub's own root commit is in, which the one-patch rule
cannot classify because there is no version to advance — is `artifact` only if
the head carries all seven locks agreeing on one version, every commit that
introduces a lock introduces it at that same version, and no commit removes
one; anything else from a lock-less base denies by name. A base carrying any
lock takes the ordinary rules unchanged, so genesis governs exactly one range
and is unreachable once `main` has a `VERSION`.

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
the ZIP digest and each file's digest, size and content type. The publisher
requires the exact five-asset inventory and reads every uploaded byte back
before immutable publication. It scans source and final image for
high/critical findings, and publishes one immutable Release.

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
