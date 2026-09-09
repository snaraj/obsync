# Changelog

All notable changes to obsync are recorded here. The format follows
Keep a Changelog; versions follow SemVer. Every artifact-classified merge
advances exactly one patch (AGENTS.md, requirement 10).

## 0.1.7 - Unreleased

- The `dispositions` reconciliation rewrites a stored justification with two
  writes, `state=open` then `state=dismissed`: GitHub refuses a `dismissed`
  write to an already-dismissed alert, which stopped the first live run on
  `main` with 78 rewrites planned. Each write announces its phase; either write
  failing is fatal to that run and blocks publication, and the next authorized
  run converges from whatever state was left. The offline step harness is now
  STATEFUL — it holds each alert's state, reason and comment, answers listings
  from them, and refuses a second dismissal the way the API does — so the
  single-write shape cannot pass the suite again.

## 0.1.6 - Unreleased

- CodeQL dispositions are code: `security/codeql-dispositions.json` records
  every accepted alert with its rule, its glob, its scope, one of CodeQL's
  three reasons and the issue carrying the reasoning, and a new `dispositions`
  job in `codeql.yml` waits for both analyses to be indexed and then fails any
  ref that carries an alert no entry covers — on a pull request that means the
  changed range AND the base branch, whose alerts a diff-informed pull-request
  analysis never shows and whose dismissed alerts count too, judged in the
  commit the base's analyses ran on. On a push to `main` the job first
  reconciles the alerts that are already quiet — a dismissal nothing covers is
  reopened, a stored justification that is not this file's is rewritten — then
  dismisses every covered open alert and requires `main` to hold zero, so
  nobody dismisses by hand, nothing is excluded from analysis, and a new real
  finding blocks the gate and the release chain until it is fixed or
  dispositioned in a reviewed pull request.
- An acceptance over product code now names what was reviewed: `line_is` (the
  exact source line) or `reviewed_sha256` (the file's bytes), verified on every
  run whether or not an alert touches the file, so an edit to accepted code
  cannot land without re-triage in the same pull request. Every judged alert
  must also name the commit it was analysed on and this workflow's analysis
  key, so a superseded or foreign record cannot supply a line number to a
  checkout that never produced it.

## 0.1.5 - 2026-09-09

- Every line that states a storage refusal now names the `io::ErrorKind`
  behind it (`io=StorageFull`, `io=PermissionDenied`, `io=NotFound`) through
  the one helper the request path already used, so the five fatal startup
  refusals, the collection, unlink and scrub lines, the snapshot retries, the
  expired-pairing sweep, the dropped `seen` event and the `check`/`export`
  refusal say WHICH I/O stopped them instead of `refusal=io_error` alone.
- The image smoke's `deny` adds the number behind that word: `df` of both
  volumes read from inside the compose path's digest-pinned throwaway image,
  and the daemon's own `docker system df`, both best-effort so neither can
  mask the refusal they explain.

## 0.1.4 - 2026-09-09

- The chart's `deploymentReady` gates the replica count instead of only
  annotating it. False, the shipped default, renders every object with
  zero application replicas, so the claims can bind their volumes and the
  TLS proxy can resolve the Service while no Pod waits on a volume or a
  Secret that does not exist yet; true is a scale from zero to one. The
  chart pins render both values and refuse a non-boolean.

## 0.1.3 - 2026-09-08

- The publisher attests with the URI form of the provenance type
  (`--type https://slsa.dev/provenance/v1`): the named `slsaprovenance1`
  makes cosign re-serialise the predicate through its typed struct and
  drop BuildKit's layer metadata, which is what the contract binds each
  platform through. The contract accepts the in-toto Statement v0.1 that
  cosign emits. v0.1.2's publisher run built, signed and attested its
  image, then refused its own attestation on both counts, so that tag
  carries no chart and no Release; nothing weaker was accepted.

## 0.1.2 - 2026-09-08

Tagged and its image published, signed and attested; the publisher's own
verification refused the attestation (statement type; predicate stripped of
its layer groups), so this version received no chart and no GitHub Release
(repaired in 0.1.3).


- The release publisher attests the image's SLSA v1 provenance onto the
  published digest with its own identity, one statement per platform,
  and proves it verifies with the consumer's command before the chart
  embeds the digest. v0.1.1's image carries BuildKit provenance but no
  signed attestation, which the platform's acquisition check requires.
  `scripts/ci/provenance_contract.py` decides, offline, what each
  statement binds: the BuildKit v1 shape naming this exact run, and one
  production platform, identified by the layer digests of that platform's
  manifest; every platform gets exactly one statement, on a fresh build
  and on a reused digest alike.

## 0.1.1 - 2026-09-08

- The release publisher checks the plugin bundle's listing for the names
  the archive holds. The first v0.1.0 publisher run exported a correct
  bundle and then failed its own check, looking for `./main.js` in a
  listing that said `main.js`; v0.1.0 keeps its tag, signed image and
  signed chart and received no Release.
- The nonce log's compaction recovery contract is published for operators
  (`docs/storage.md`, "Nonce log recovery"), and each of its sentences is
  pinned by a test that drives a real compaction over a real volume.

## 0.1.0 - 2026-09-08

Tagged, with its image and chart published and signed; it received no
GitHub Release because the publisher's bundle check failed after them
(repaired in 0.1.1).

### Added

- Repository contract, architecture, wire protocol, storage, threat model,
  benchmark, validation, and platform-onboarding documents.
- Start-time volume posture: `serve`, `check`, and `export` measure the type,
  owner, and mode of both volume roots and both credential files before
  anything is read or written through them. A weak mode is corrected and
  re-read; a link, a substituted type, or a foreign owner refuses the start.
- A ceiling on the heads one file may hold, equal to the parents one version
  may declare, so a conflicted file is always resolvable by one merge naming
  every head and the head list a response carries is bounded. The version
  that would pass it is refused with `409 too_many_heads` and nothing
  already stored changes; replay applies what the journal already holds.
- Replay protection that survives a restart: every accepted nonce is
  appended to `v1/nonces` on the journal volume and fsynced before its
  request is answered, and a start loads back what the 600 s window still
  covers. The file is rewritten once it passes twice the cache's ceiling, a
  torn final line costs only itself, and a volume that will not take the
  record refuses the request with `503 nonce_log_unavailable`, and a link
  standing where that file belongs refuses the start.
- Pending devices are reconciled against the pairing table on every start.
  A pairing lives in memory and the device a claim creates is journaled, so
  a restart used to leave an unapproved claimant nobody could approve and
  expiry could not reach, holding its wrapped secret for the life of the
  store. It is now destroyed down the path expiry uses, with one line
  stating the count.
