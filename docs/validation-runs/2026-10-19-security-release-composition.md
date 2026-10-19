# Security release composition — 2026-10-19

This record covers the v1.1.8 composition of #344/#346/#347 and approved
Dependabot updates #348–#355. The owner waived physical-phone verification
for this release only; [the release plan](../release-trains.md) records that
decision. Physical execution remains NOT_RUN, and independent final-head
review and required CI remain separate gates.

## Source and dependency changes

Plan #345 landed at protected main
`cc8d54fab85b6c40de1112370619a19ada20f9ba`. The subsequent GitHub update-branch
commit on #347, `650608da9a085cec9707773aaea4fd01e13699ec`, fails the unchanged
release classifier with `release range must be one contiguous linear commit
chain`. Its hosted security job fails at the same release-step check. The
replacement branch starts from current main and carries the security tree
without rewriting that published history.

Relative to that carried tree, product code under `crates/`, `plugin/src/`
and the mobile runner under `scripts/validation/` is unchanged. The new
dependency delta changes eleven files; the other changes are this record and
the owner-approved release-plan update.

| Input | Final pin | Primary source |
| --- | --- | --- |
| Node / npm | 26.12.0 / 11.20.0 | [Official release index](https://nodejs.org/download/release/index.json) |
| Node build image | `26.12.0-trixie-slim@sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4` | [Official image source](https://github.com/nodejs/docker-node/blob/f27125230b3c367dcf63043ea3fe286fb3d0914c/26/trixie-slim/Dockerfile) |
| CodeQL init/analyze | 4.39.0, `6f2ac81f5cd81fe351a197ba0b00d91d03cd2aee` | [Official release](https://github.com/github/codeql-action/releases/tag/v4.39.0) |

The image index was independently read with `docker buildx imagetools inspect`;
both Linux architectures are present. The CodeQL annotated tag peels to the
pinned commit; GitHub reports that commit's signature verified. The tag itself
is unsigned. The local Node archive was checked against the official
`SHASUMS256.txt`; its SHA-256 is
`a2e255e35347f727f29aa158c552a60140b17b6ba68719d5d6fc46c7d058aa75`.
Rust builder 1.99.0, compiler 1.98.0 and the other previously composed action
pins remain unchanged. No runtime dependency was added.

## Measured validation

- The dependency delta passes 3 pin tests, 14 workflow-integrity tests,
  135 CodeQL-disposition tests, 11 E2EE-contract tests and 88 dashboard tests:
  251 tests total. The Makefile battery check and actionlint pass. All 40
  finite dependency mutations fail with assertions; the restored baseline
  passes. Commands are the corresponding `scripts/ci/test_*.py` files,
  `node --test dashboard/test/*.test.mjs`, `scripts/ci/makefile-invariants.sh`
  and actionlint over the three changed workflows.
- The composed macOS gate passes formatting, clippy, 734 Rust tests (one
  ignored measurement), 94.85% line coverage, 2,528 plugin tests without
  skips, the real-server E2EE run (21 flows and two planted-leak controls),
  and CORS checks. These are the commands in `make check` through `e2ee`.
- `bash scripts/ci/mobile-harness.sh` passes 232 Python tests, 232 JavaScript
  tests and all 329 scripted mutation controls, without skips. This is offline
  harness evidence, not a new native-device run.
- The native CLI package journey passes 207 commands; dashboard tests pass
  88/88; Helm lint, rendering and chart-pin checks pass. Commands:
  `make cli dashboard chart` with the repository's pinned tools.
- With the standard system PATH restored, `make contracts secrets` passes
  all 935 repository contracts and the working-tree secret scan. The outgoing
  commit-range scan and the final clean-source checks are bound to the
  replacement commit in its PR evidence; a pre-commit empty range is not
  evidence about that eventual commit.
- Both native arm64 Docker builds pass (`docker build --target server` and
  `docker build`). The image's plugin suite passes 2,484 tests with nine
  case-folding tests inapplicable to its case-sensitive filesystem; the macOS
  suite above covers those cases. Independent extraction confirms an arm64
  static ELF, nonroot user, the intended entrypoint and exactly port 8080.
  `scripts/ci/image-smoke.sh` passes 11 properties and
  `scripts/ci/compose-smoke.sh` passes 16 steps through certificate-verified
  HTTPS. The latter's exact project containers, volumes and network, and the
  former's two primary volumes, were independently found absent afterwards.

The initial uncommitted-tree `make check` is retained as FAIL: four mobile
tests refused `source_binding` because their crypto oracle requires a clean
committed source. The guard was not changed. Its continuation used the clean
carried tree at `650608da…`, whose product sources and built plugin match this
composition; the new committed candidate's own binding is checked before
publication. The first contract invocation also remains FAIL: its restricted
PATH omitted `/sbin`, so the publication tests could not locate the existing
Darwin `sha256sum`. Restoring the standard system PATH is an environment
correction, not a new executable or relaxed test.

The first documentation container used native arm64 and correctly failed the
wheel-hash gate: `docs/requirements.txt` deliberately pins CPython 3.12
Linux/amd64 wheels. The reproduction uses that declared platform; no hash or
dependency constraint was changed to admit the incompatible wheel.
The local Docker engine also refused loading both architectures under one
index digest. Its amd64 child was resolved from the same pinned Python index:
`python@sha256:44ff437bba879d4941b710a369a8f19266aea34b29002807f0c487fabc9eec9b`.
Documentation tooling may use emulation; the server/container checks above
ran natively on arm64.

## Native evidence continuity and limits

The Node 26.12.0 macOS build and the container-exported plugin match all three
hashes in [the three-run native record](2026-10-17-unattended-mobile-acceptance.md):
`main.js`, `manifest.json` and `styles.css` are byte-identical. The earlier
unattended runs retain their original measured commit
`780a8cba86039760e4f349dd6f3e09d258aafe40` and are not relabelled as executions
of this replacement commit.

The rebuilt macOS server's full SHA-256 is
`40f72ea6f2d25ab214a51c1e57c0abb94f7a284843a8324df98e84604c121852`.
Its 1,397,184 bytes differ from the earlier measured server at 48 bytes,
all inside the Mach-O UUID and code-signature ranges; there are zero
differences outside those ranges. Both pass `codesign --verify --strict`.
This is a structural byte comparison, not a claim of identical file hashes
or a new mobile execution. The container's Linux server SHA-256 is
`f5456c55011a58966c9dab8ecad57e33539840bcdd5f60ff51996a5e9aaafac1`.

The prior retained three-run audit, supplemental audit and cleanup receipts
still match their published hashes. Their finite confidentiality and direct
old-key rejection observations remain as documented there. The emulator does
not establish iOS behavior, stock-phone trust, OEM power management or
hardware-backed mobile custody. No public test endpoint or phone interaction
is part of this composition check.
