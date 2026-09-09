# Agent contract — obsync

This is the CANONICAL, vendor-agnostic agent contract for this repository:
any frontier model, or hurried human, must be able to operate here cold from
this document alone. Tool-specific entrypoints (CLAUDE.md) only import it.
Sibling repositories (the owner's two site repositories and the platform
repository) share these conventions by deliberate copy, never by reference:
nothing here depends on them.

## Cold start — first-session checklist

1. Read this file end to end, then `docs/architecture.md` and
   `docs/protocol.md`. Those three are the whole briefing.
2. `git fetch origin` and work from `origin/main`. Never trust a local
   `main`, a stale worktree, or another agent's summary of remote state.
3. Verify identity and tooling: `gh auth status` shows the owner's account;
   commits carry the noreply identity per "Commit identity mechanics"; the
   pinned toolchain is `rust-toolchain.toml` (Rust 1.98.0, components
   `rustfmt`, `clippy`, `llvm-tools`) and `plugin/package.json` (Node
   24.19.0, npm 11.17.0, one exact `typescript` devDependency). The gate
   verifies these exactly.
4. Survey live state yourself: `gh issue list`, `gh pr list`, including the
   open-agent-PR count against the PR budget below.
5. Claim work through an issue, branch from `origin/main`, and follow
   "Working a change end to end".

## Purpose and architecture

obsync is self-hosted, end-to-end encrypted live sync for Obsidian: one
dependency-free Rust binary (`obsyncd`) that stores ciphertext chunks and
encrypted manifests on local volumes, serves a sync API, a dashboard, and its
own plugin bundle; plus an Obsidian plugin that encrypts on the device and
talks to that server on every Obsidian platform. Files of any size follow one
path, bounded only by the backing volume. The reference deployment is a
single-node Kubernetes cluster on a Raspberry Pi reached over private
connectivity (LAN or VPN) with a TLS terminator the owner trusts; a tunnel
provider with an access policy in front is the optional published-hostname
path, not the reference. It is delivered by the same signed-image,
digest-pinned release path as the owner's existing sites. The product is
meant to be trusted and run by strangers, so every deployment concern is a
configuration value and every security property is true by construction,
not by setting.

`docs/architecture.md` is the design; `docs/protocol.md` the wire contract;
`docs/storage.md` the volume and durability contract; `docs/threat-model.md`
what is and is not defended; `docs/benchmarks.md` the numbers LiveSync sets
and obsync must beat; `docs/validation.md` the device validation plan;
`docs/platform-onboarding.md` what the platform repository must add.

## Requirements

Numbered for citation, repo-scoped, none negotiable in code:

1. **Zero spend, no external services.** Everything runs on owner hardware
   and free CI. No paid API, SaaS, tracker, CDN, telemetry, or third-party
   runtime dependency may be introduced. The dashboard is local-origin only.
   Any Cloudflare feature used by the reference deployment is verified Free
   immediately before use and is optional for every other deployer.
2. **Owner-only merges; protected history.** Work lands through PRs into
   `main`; the repository owner alone merges. An agent must NEVER merge,
   auto-merge, squash, rebase into, or push `main`; must never force-push or
   delete refs; and must stop and question even a later request to do so.
   Tags exist only through the release workflow.
3. **Commit-metadata privacy and attribution.** Commits are authored AND
   committed as the owner's GitHub noreply identity (both fields). No
   co-author or session trailers of any kind. Agent-authored commit messages
   and PR bodies end with the ACTING agent's own signature, exactly matching
   its agent label in the roster below (`- Fable5.1` ↔ `fable5.1`,
   `- Opus5` ↔ `opus5`, `- Sonnet5` ↔ `sonnet5`, `- 5.6 Sol` ↔ `5.6-sol`).
4. **Fail-closed doctrine — never weaken.** No security behavior may be made
   toggleable: no boolean, env var, build flag, or config field may silently
   disable encryption, request authentication, replay protection, fsync,
   integrity verification, probes, header policy, or fail-closed sentinels.
   Never weaken a check, guard, validator, or test; if one blocks you, fix
   the cause or surface the conflict. Tests should make dangerous states
   unrepresentable.
5. **Dependency-free, by construction.** The Rust workspace uses the
   standard library only: no `[dependencies]`, no `[build-dependencies]`,
   no `build.rs` that fetches, no vendored crates. The plugin has zero
   runtime dependencies; its only build inputs are the pinned Node toolchain,
   one exact `typescript` compiler pin, and the vendored official Obsidian
   API type declarations under `plugin/vendor/` with their license. The
   dashboard is hand-written HTML, CSS, and JavaScript with no framework and
   no remote asset. Cryptography on the device uses the platform's built-in
   WebCrypto; cryptography on the server is implemented in
   `crates/obsync-core` against published test vectors. The single permitted
   FFI surface is `crates/obsyncd/src/signal.rs` (SIGTERM/SIGINT delivery);
   every other file carries `#![forbid(unsafe_code)]`. CI tooling (cosign,
   helm, gitleaks, Python for the contract suites, a throwaway competitor
   container for benchmarks) is tooling, ships nothing, and is pinned by
   version and checksum. A dependency of any other kind is an owner
   decision, not a convenience.
6. **Blind server.** No code path sends, stores, or logs a vault key, a
   domain key, a chunk key, a plaintext chunk, or a clear file path to the
   server. The server never decrypts content and cannot: it holds no key
   material for it. Path names travel only inside encrypted manifests.
   `TestBlindServer` in `crates/obsyncd` pins that no handler, log line, or
   journal frame carries a field named or shaped like a key or a path.
7. **Truthful serving contract, TLS outside the process.** The server
   listens on plain HTTP, port 8080 by default, and is always deployed behind
   a TLS terminator (a reverse proxy the owner trusts on the reference
   deployment; any reverse proxy or tunnel elsewhere). TLS is never implemented or linked in
   this process. `/livez` and `/readyz` stay truthful: readiness reflects
   real serving ability (volumes writable, journal replayed, not shutting
   down), never a hardcoded yes.
8. **Any size, one path.** Server code contains no fixed per-file or
   per-vault size limit. The only refusals are explicit, configurable, and
   visible: the free-space watermark on a volume (HTTP 507) and an account
   quota (HTTP 507). Device-side ceilings (mobile budget, per-file mobile
   ceiling) are plugin policy, defaulted per platform and shown in the UI.
9. **Ratchet-only quality floors.** The PR gate enforces the Rust line
   coverage floor `RUST_COVERAGE_FLOOR` (measured with the pinned
   `llvm-tools` component, no crate) and the plugin test floor. The first
   server PR sets each floor at its measured value; afterwards floors only
   rise. The floor is ONE fact recorded in this file, the Makefile, and
   `pr-gate.yml`, and the three move together. Current
   `RUST_COVERAGE_FLOOR`: 89 (measured 89.80 % on the composed bootstrap
   wave, 2026-09-07).
10. **Every artifact merge releases after the gate; deploy remains
    separate.** Every PR whose range touches any artifact surface advances
    exactly one patch from its current protected base in ALL lockstep locks:
    `VERSION`, the workspace `version` in `Cargo.toml`, chart `version` and
    `appVersion`, `chart/values.yaml` `image.tag` (`vX.Y.Z`),
    `plugin/manifest.json` `version`, and the `CHANGELOG.md` `X.Y.Z` entry.
    A range whose every commit is confined to the closed documentation
    allowlist — root `AGENTS.md`, `README.md`, `.gitignore`, and Markdown
    files under `docs/` — classifies no-artifact and advances nothing. The
    classifier has exactly two verdicts and no flag; a non-allowlisted path
    with an unchanged version denies. Successful main CI dispatches the
    publisher, which creates the annotated `vX.Y.Z` tag at the exact merged
    SHA, emits the signed multi-arch image (linux/amd64, linux/arm64), the
    signed OCI chart, the plugin bundle as a Release asset with its SHA-256
    in the evidence manifest, and one immutable GitHub Release. Images
    deploy by digest; publication is never deployment.
11. **No secrets, no private facts, no personal data.** No credential,
    token, private host fact, address, device identifier, or personal data
    enters this repository, including tests, fixtures, docs, and commit
    messages. Access control is always expressed by role.
12. **Failures are visible.** Every refusal, timeout, integrity mismatch,
    and budget overrun logs one structured line with the decision, the
    duration, and the budget it was measured against; long-running work
    (journal replay, garbage collection, scrub) logs START with a budget and
    a per-run SUMMARY. A fix for any failure also strengthens the logging
    that would have surfaced it sooner.
13. **Low code volume.** Deletion outranks addition; a net-negative PR is
    the ideal; every PR body carries its `+/−` accounting. Generality is
    earned by a second real caller, never anticipated.
14. **Portability is a requirement, not a hope.** The server builds and
    runs on linux/amd64 and linux/arm64 (the Pi) as a static binary and on
    macOS for development. The plugin runs on every Obsidian platform;
    mobile constraints (whole-file reads, HTTPS-only, memory) are named in
    `docs/architecture.md` and every plugin PR states its per-platform
    behavior.

### Deployment-provider contract

The server knows no ingress, DNS, edge, or access provider by name. Provider
behavior is selected by `OBSYNC_EDGE` (`none` | `cloudflare`), and provider
names live only in `chart/values.yaml` defaults and `docs/`. In
`cloudflare` mode the server requires the edge's connecting-address and
request-id headers on every request and refuses requests that lack them;
in `none` mode it trusts only `OBSYNC_TRUSTED_PROXY_CIDRS` for forwarded
addresses. `TestProviderNeutrality` pins zero provider names under
`crates/` and `plugin/src/`.

## Testing doctrine

- Every primitive in `crates/obsync-core` ships known-answer tests from the
  published vectors (FIPS 180-4, RFC 4231, RFC 5869, RFC 4648, the CRC-32
  check value, RFC 8259 test corpus) and a differential test against the
  CI host's `sha256sum`/`openssl` where one exists. Constant-time
  comparison has a test that proves early-exit is impossible by
  construction (single accumulator, no branch on data).
- The storage engine is tested with injected fault points: a crash
  between write and fsync, between fsync and rename, mid-journal-append,
  and a torn final frame. Each recovers to a consistent index and the test
  says which frames survived.
- The HTTP/1.1 parser has a hostile corpus: oversize headers, smuggled
  `Content-Length` pairs, invalid chunk sizes, absent `Host`, slowloris
  timing. Every case names the refusal it expects.
- Plugin tests run under `node --test` against Node's built-in WebCrypto
  and a hand-written fake of the Obsidian `Vault`/`DataAdapter` surface.
  Encrypt/decrypt round-trips are cross-checked against fixtures produced
  by the Rust core so the two implementations agree on every byte.
- Tests are stdlib-only with hand-written fakes; no assertion libraries,
  no mock frameworks. Fixture text is sentinel-only.
- Repo-doctrine pins live in `crates/obsyncd/src/doctrine_test.rs`
  (blind server, provider neutrality, no-unsafe, dependency-free manifest).

## Package layout

- `crates/obsync-core`: one module per primitive (`sha256`, `hmac`,
  `hkdf`, `crc32`, `hex`, `base32`, `base64`, `ct`, `json`, `http`), each
  with its tests beside it. No I/O except in `http`.
- `crates/obsyncd`: `config`, `signal` (the only unsafe), `log`,
  `storage/{blobs,journal,index,gc,scrub}`, `api/{auth,pairing,sync,
  chunks,changes,admin,plugin}`, `dashboard` (serves `OBSYNC_DASHBOARD_DIR`), `cli`
  (`serve`, `check`, `export`, `bench`). Type declarations live in
  `types.rs` per module group; methods stay beside the logic they serve.
- `plugin/src`: `main.ts` (plugin entry), `crypto.ts`, `chunker.ts`,
  `state.ts`, `transport.ts`, `sync/{push,pull,conflict}.ts`,
  `pairing.ts`, `policy.ts`, `ui/`. `plugin/build.mjs` is the homegrown
  bundler that emits one `main.js`.
- `dashboard/`: `index.html`, `app.css`, `app.js`, `lib.js` (pure functions,
  tested under `node --test`), plus `dev/` (a mock server for development)
  and `test/`.

## Build, test, and release flows

`make check` is the canonical gate and CI runs the same battery:
`cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`,
`cargo test --workspace`, coverage against `RUST_COVERAGE_FLOOR`, the plugin
build and `node --test`, chart lint plus the pin scripts under `scripts/ci`,
the contract suites (`python3 -B -m unittest discover -s scripts/ci`), and
both secret scans. Frontend and backend checks run once, natively; only the
final image stage is per-target.

Releases follow requirement 10. The publisher's read-only authorization job
verifies the exact run, repository, workflow path, push event, main branch,
source SHA, and PR-gate job inventory before its write/packages/OIDC job can
start; it emits the signed image, signed OCI chart, plugin bundle, and one
immutable Release carrying one deterministic evidence manifest. Deployment
resolves digests, never tags.

## Adversarial review protocol

Every substantive PR receives an independent adversarial review BEFORE it
leaves draft. Review depth is risk-based:

- **Security-surface changes** (crypto, auth, pairing, request parsing,
  storage durability, CI workflows, chart, release machinery) take focused
  tests, one full CI cycle, live validation when runtime behavior changes,
  ONE independent adversarial review, and owner merge.
- **Normal code changes** take focused tests, one full local gate, one
  review.
- **Docs, comments, formatting** (requirement 10's no-artifact class) run
  the relevant checks; review is the coordinator's routing decision.

**Code-scanning dispositions.** A CodeQL alert is resolved in exactly two
ways: the finding is fixed, or a reviewed entry in
`security/codeql-dispositions.json` accepts it with a rule, a scope, one of
CodeQL's three reasons, the sentence the dismissal will carry, and the issue
holding the reasoning. An acceptance over PRODUCT code also names what was
read — the exact line, or the sha256 of the reviewed file, re-verified on every
run — so an edit to accepted code cannot land without re-triage in the same PR.
The `dispositions` job fails any PR carrying an alert no entry covers, in the
changed range or on the base branch, whose alerts a diff-informed pull-request
analysis never shows and whose DISMISSED alerts count too. On `main` it
reconciles first: a dismissal nothing covers is reopened, a stored
justification that is not this file's is rewritten. Then it dismisses every
covered open alert and requires main to hold zero, which is a gate invariant
rather than a habit. Every judged alert must name the commit and this
workflow's analysis, with one exemption: a DISMISSED alert GitHub has stamped
`fixed_at`, on this ref and from this analysis, is no longer detected, so its
instance names the last commit that saw it by construction — it is skipped,
counted and named, never judged. An unstamped record on another commit, and an
OPEN alert on another commit, stay refused as superseded or foreign. That
exemption rests on the analysis being a successful one, so the base listing
refuses an analysis record reporting a non-empty `error`, or missing the fields
that would say, and never falls back to an older healthy record.
Nothing is excluded from analysis: no `query-filters`, no
`paths-ignore`, no `config-file`. Dismissing an alert by hand — in the UI or
through the API — is forbidden for everyone, the owner included, because a hand
dismissal is unreviewed, absent from this repository, and invisible to the next
reader; the next push to `main` reopens or rewrites it.

**Reviewer independence** is established by the POSTING ACTOR: a verdict
receipt is posted by the `snaraj-agent-reviews[bot]` GitHub App, a principal
granted Contents write in no repository. The signature line is lane
provenance, not identity. Same-lane review is permitted.

**Exact-head receipt.** One normal PR comment in exactly this shape:

```text
HEAD: <40-lowercase-hex>
VERDICT: APPROVE

1. <numbered finding, or explicit no-finding scope>

Mutation audit: <hostile mutation results>
Claim audit: <SUPPORTED and OVERSTATED results>
Full-gate and flake evidence: <commands, results, and capability boundaries>
Scratch cleanup: <disposable workspace and residue result>

- <Agent> (adversarial reviewer)
```

The verdict line may instead be exactly `VERDICT: REQUEST-CHANGES`. Any head
change invalidates the receipt. The review must: audit every claim in the
body against the diff and reproduce every number; build a mutation kill
matrix for every guard or test the PR adds (a surviving mutant is a
finding); probe vacuity (an assertion no input can fail is a finding); probe
flakes; check hygiene (identity, signature, labels, no trailers, secret
scan, out-of-lane paths untouched); check doctrine (nothing weakened). The
posted verdict removes `requires-review`. A REQUEST-CHANGES verdict returns
the work to the same branch owner for a delta re-review of the changed scope.

### After review, Ready

Once the independent review has approved the exact final head and all
required checks are green, the coordinator flips Ready and the owner merges.
No third pass is required. A green check, a peer approval, or a ready state
is evidence, never authority.

## GitHub conventions

- **Issues first.** Substantive work is tracked as a labeled issue; PRs use
  an exact standalone `Closes #N` line.
- **Labels.** One taxonomy, identical across the fleet:
  `production-readiness`, `conventions`, `security`, `tests`, `ci`, `docs`,
  `release`, `fix`, `provider-neutrality`, `delivery-lane`, `features`,
  `requires-review`, `cybersecurity-review-requested`, `priority-high`,
  `inprogress`, `dependencies`. New labels are added fleet-wide at once.
- **`requires-review`** is PR-head-only: applied by the author when the
  exact head, body, commits, and evidence are complete; removed by the
  reviewer with either verdict; reapplied only for a complete replacement
  head. Never on an issue.
- **Agent labels.** Every agent-created PR and issue carries `agent-authored`
  AND the acting agent's own label: `fable5.1` (Claude Fable 5.1, `D97706`),
  `opus5` (Claude Opus 5), `sonnet5` (Claude Sonnet 5, `0EA5E9`), `5.6-sol`
  (ChatGPT 5.6 Sol). Body signature must match the label.
- **PR budget.** At most 3 agent PRs open by default. The owner authorized
  the bootstrap wave (core, server, plugin, scaffold, dashboard) to run in
  parallel on 2026-09-07; that override does not carry forward.
- **Merge authority.** THE OWNER ALONE MERGES. Every agent PR opens as a
  draft. Never self-approve; never force-push a shared ref.
- **Milestones and assignee.** Every PR and issue carries one milestone and
  the owner as assignee.
- **Linear history.** Squash or rebase merges only; branches auto-delete on
  merge; history is append-only.
- **Commits.** Detailed bodies to the review evidence standard: problem,
  mechanism, enumerated changes, evidence, `+/−` accounting, signed per lane.
- **Dependabot** covers `github-actions` and `docker` only; there is no
  package ecosystem to update. Dependency PRs obey the same next-patch,
  changelog, exact-head review, and base-freshness controls.
- **Merge readiness.** Draft remains Draft until every check is green at the
  exact head, the base equals current `main`, all findings are resolved, a
  fresh exact-head APPROVE receipt exists, the next patch still follows that
  base for an artifact PR, and the automatic release consequence is proven.
  Only the coordinator flips Ready.

## Parallel agents in one checkout

Several agents work this repository at once. Git worktrees under
`.worktrees/` (ignored) are the isolation mechanism.

- The shared checkout is nobody's workspace: it stays on `main`, clean.
- One writer per branch, always. A tree moving under you belongs to another
  executor; stop.
- Each lane creates its own worktree: `git worktree add .worktrees/<lane>
  -b <branch> origin/main` (or a declared predecessor branch), works there,
  pushes only its own branch, and removes the worktree when its PR closes.
- Reviewers work disposably in a scratch worktree they remove afterwards
  and report the removal in the receipt.

## Working a change end to end

1. **Claim the work.** File or take the issue; label it (both agent
   labels), assign the owner, set a milestone.
2. **Branch from `origin/main`** after `git fetch origin`; grammar
   `<lane>-<effort>/<issue#>-<topic>` (e.g. `opus5-high/12-storage-engine`),
   effort in `low | med | high | xhigh | max`. A branch with no issue states
   why in its PR body. Reserve the exact next patch when the change touches
   any artifact surface. If another PR lands first, re-cut a fresh branch
   from current `main`, carry the diff, take the new next patch, supersede
   the stale PR; never rewrite published history.
3. **Build the change** inside the requirements. Mutate every guard you
   add before hand-off: delete or invert it locally, prove the suite goes
   red, restore. The reviewer's mutation matrix is the second pass.
4. **Run the full local gate** (`make check`), both secret scans, then
   commit under the pinned identity with an evidence-standard body ending
   with your signature. Before every push: `git log -1 --format=%B | tail
   -1` shows the lane line last, and the range contains no trailer.
5. **Push and open a DRAFT PR** with `Closes #N`, both agent labels, owner
   assignee, milestone, signed body with reproducible numbers. Apply
   `requires-review` once complete-from-author.
6. **Adversarial review**; fix findings on the same branch; delta re-review.
7. **Prove server release controls** for an automatic-release change per
   `docs/release.md`.
8. **Owner comments** are answered with reproduction, not assertion.
9. **The owner merges.** Nothing else substitutes.

## Commit identity mechanics

Requirement 3, made operational. The identity, BOTH author and committer,
on every outgoing commit, is exactly:

    Samuel Naranjo <39077795+snaraj@users.noreply.github.com>

Pin it per command with environment variables, never with `git config`:

    GIT_AUTHOR_NAME='Samuel Naranjo' \
    GIT_AUTHOR_EMAIL='39077795+snaraj@users.noreply.github.com' \
    GIT_COMMITTER_NAME='Samuel Naranjo' \
    GIT_COMMITTER_EMAIL='39077795+snaraj@users.noreply.github.com' \
    git commit ...

Agent commits are SSH-signed per command with the owner-registered signing
key, selected explicitly by intersecting GitHub's registered signing keys
with the keys the agent holds, requiring exactly one match:

    signing_key() {
      local matched
      matched="$(comm -12 \
        <(gh api /users/snaraj/ssh_signing_keys --jq '.[].key' | sort) \
        <(ssh-add -L | awk '{print $1, $2}' | sort))"
      test "$(printf '%s' "${matched}" | grep -c '')" -eq 1 || {
        printf 'expected exactly one registered signing key in the agent\n' >&2
        return 1
      }
      printf '%s' "${matched}"
    }

    git -c gpg.format=ssh \
        -c user.signingkey="key::$(signing_key)" \
        commit -S ...

Every agent commit must show as Verified. Commit bodies end with the lane
signature and nothing after it.

## Docs and README conventions

- `docs/` holds durable design and operating documents, dated where facts
  drift. Process history stays out of product files.
- The README leads with screenshot captures of the dashboard and the plugin.
  A PR that changes what either renders asks the owner for a fresh capture
  and says so in its body; captures are committed under `docs/captures/`
  as PNG, never generated at build time.
- Numbers in docs are reproducible: every figure names the command that
  produced it.

## Security invariants beyond the numbered requirements

- Request authentication is HMAC-SHA256 over method, path, query,
  timestamp, nonce, and body hash; the window is ±300 s and nonces are
  remembered for 600 s. Both values are constants, not configuration.
- Device secrets rest wrapped under the server key; the server key comes
  from `OBSYNC_SERVER_KEY` (a Kubernetes Secret on the reference
  deployment) or is generated once at first boot with mode 0600.
- Every write to a blob or journal is fsynced (file and directory) before
  the response that acknowledges it.
- Every response carries `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, and `X-Obsync-Seq`; every HTML response
  adds `Content-Security-Policy: default-src 'self'; script-src 'self';
  style-src 'self'; img-src 'self' data:; connect-src 'self';
  frame-ancestors 'none'; base-uri 'none'; form-action 'self'`. The
  framework's own refusals (400, 408, 431, 501, 505, 503, 500) are bare
  status lines with `Connection: close` and no body. The origin never
  emits `Strict-Transport-Security` or `Date`: the terminator owns the
  first and the second is a clock dependency with no consumer.
- The dashboard sets `HttpOnly`/`SameSite=Strict` session cookies and a
  double-submit CSRF header; it serves no inline script.
- Nothing listens except the one configured HTTP port and the health
  endpoints on it.
- The container runs as non-root with a read-only root filesystem, no
  capabilities, and no shell.
