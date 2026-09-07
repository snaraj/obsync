# Release path

Dated 2026-09-07. Requirement 10 in `AGENTS.md`, made operational.

## Lockstep locks (seven)

`VERSION`, `Cargo.toml` workspace `version`, `chart/Chart.yaml` `version`
and `appVersion`, `chart/values.yaml` `image.tag` (`vX.Y.Z`),
`plugin/manifest.json` `version`, and the `CHANGELOG.md` heading `X.Y.Z`.
`scripts/ci/release_contract.py` walks every commit in `base..head` and
denies skips, reversions, and mixed ranges without exactly one patch.

## Classifier

Two verdicts, no flag: `artifact` (any path outside the documentation
allowlist changed, and every lock advanced exactly one patch) or
`no-artifact` (every commit confined to root `AGENTS.md`, `README.md`,
`.gitignore`, and Markdown under `docs/`; no lock touched).

## Publisher

`release-after-main.yml` (holds `actions: write`, `contents: read`; cannot
create refs) dispatches `release-publisher.yml` with the successful run id.
The publisher's read-only authorization job verifies the run, repository,
workflow path, push event, main branch, source SHA, and PR-gate job
inventory; then its write/packages/OIDC job builds the multi-arch image
(linux/amd64, linux/arm64) with checksum-pinned tools, signs image and OCI
chart keyless (identity `refs/heads/main` of this repository), attaches
`obsync-plugin-vX.Y.Z.zip` (main.js, manifest.json, styles.css) with its
SHA-256 in the evidence manifest, scans source and final image for
high/critical findings, and publishes one immutable Release.

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
