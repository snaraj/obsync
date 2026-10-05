# Bounded co-editing experiments

Status: proposed preregistration, 2026-10-05. **E1–E11 and the full editor-buffer
experiment are NOT_RUN.** A separate public-save desktop pilot is recorded below;
it does not satisfy those rows. This docs-only change supplies no engine. This is the
experiment contract for [the state/migration proposal](../design/co-editing-state.md)
and [#315](https://github.com/snaraj/obsync/issues/315), not evidence of delivery.

## 1. Entry and stop conditions

Before any run, publish this scenario set, counts, thresholds, source commits,
fixture recipe and environment on the issue. Record the approving review and
freeze the record. A changed budget requires a dated reason and a new series;
retain the old failure. Never choose a threshold after seeing its data.

Required entry gates:

- The shared baseline and quiet measurement window are released by the
  coordinator. No other build, test, stress run or native lab competes with a
  timing run. Record load, thermals/power mode and competing process categories.
- The state design is reviewed. Each experiment lists which design conflicts
  it needs resolved; algorithm-only work cannot claim native or security proof.
- Use released baseline `897124b073baf51ef2cb3fff52a5badc1940a237` and resolve the candidate to a full commit. Create the
  prototype on `gpt-6-high/325-coedit-experiment`, separate from the docs branch.
  Push reproducible source only after normal identity and secret checks.
  **Never merge this branch, open a shipping PR for it or publish its artifacts.**
- Record exact Obsidian/plugin/OS/WebView versions, device role aliases, server
  architecture and resource limits, TLS route, fixture and driver hashes. No
  personal vault, production account, live storage or unrelated application is
  a fixture. Physical-phone pairing needs an unlocked phone, the real pairing
  interface, and a visible matching code on both devices.

Stop immediately on changed sentinel bytes, unverified plaintext publication,
unexpected write outside the owned run, missing cleanup identity, disk free
space below 20 GiB, a security guard bypass or resource ceiling exhaustion.
Preserve evidence and report the refusal; do not rerun with a wider limit to
convert that same observation into a pass.

## 2. Fixed experimental envelope

These are proposed **prototype** budgets fixed before measurement. They are
not existing product constants or newly measured performance results.

| Item | Frozen value and response at the bound |
| --- | --- |
| Devices | Two active editors A/B plus an idle reader C; at most one desktop and one phone active in a constrained native lab lane unless the coordinator allocates another. Run C sequentially where concurrent capacity is unavailable and label the limitation. |
| Fixture bytes | At most 128 MiB plaintext and 1 GiB total owned run storage; sentinel-only generated notes, manifest and client-side hashes outside the repository. |
| Notes | 8 KiB, 256 KiB and 1 MiB UTF-8 notes; LF and CRLF variants, emoji/surrogate pairs, combining marks, bidi text, repeated characters and long lines. A 20 MiB binary attachment is an unchanged-path control. |
| Batching | 100 ms fixed window; one outstanding durable content batch per note. Encrypted frame buckets of 1, 2, 4, 8, 16, 32 and 64 KiB including overhead; split before the 64 KiB ceiling without changing event order. No compression. |
| Presence | At most one update per active device per 250 ms; coalesce superseded positions, expire after 5 s, emit zero presence messages while idle. |
| Receive queue | At most 128 frames or 8 MiB, whichever first; stop admission and fetch missing authenticated history in bounded pages. Never discard an acknowledged content frame to stay under the cap. |
| Active merge work | One note per worker, 8 ms scheduling slice, 32 MiB incremental live JS heap on mobile and 64 MiB on desktop above the idle fixture baseline. Hold visibly at the limit; record failure if the required fixture cannot complete. |
| Pending durable history | At most 32 MiB encrypted local outbox in this prototype; preserve the existing outbox and stop new co-edit publication at the bound. Ordinary local editing still needs a truthful unsent state. |
| Catch-up | At most 100,000 operations per branch and 200,000 total, with a 60 s wall deadline and 15 s process CPU budget per 1 MiB-note run. Hitting a bound is a failed acceptance row, not permission to discard a tail. |
| Gap and silence | Missing authenticated dependency: report waiting immediately, stalled by 5 s. Connected peer with no liveness response: unknown by 10 s. Suspended mobile app: assess within 10 s of foreground resume, never claim background timer execution. |
| Replication | Three recorded runs per native scenario/profile after one excluded warm-up. Keep failures and all samples; no best-run selection. |
| Functional repetitions | Twenty cases per edit operation, per recorded run, plus the continuous co-typing row below. Ten owned process-stop/restart trials per named interruption boundary; no machine reboot. |

The heap numbers apply to measured additional live JS state, not total app RSS.
Record RSS and system pressure separately. A host lacking the required metric
reports UNKNOWN for that budget. A resource failure does not weaken the
server's any-size contract: it prevents promoting this bounded prototype.

## 3. Network and measurement method

Use private trusted TLS for every native run. Record actual RTT rather than
assuming the route name proves it. Two profiles are fixed:

1. LAN, no injected impairment. Report measured request RTT distribution.
2. A private VPN/cellular route, with its actual RTT and loss recorded. Also
   run a separately labeled controlled link with 100 ms added round-trip delay,
   10 Mbit/s each direction and no injected loss. If that controlled route is
   unavailable, record NOT_RUN; do not relabel a loopback delay as cellular.

Measure from the committed local editor transaction to the corresponding
visible transaction on the peer. Use synchronized monotonic instrumentation
with measured clock-offset uncertainty no more than 5 ms, or a common-clock
video observer. Record uncertainty; if it exceeds the limit the latency row is
UNKNOWN. Pair each sample with a durable-server receipt and resulting operation
identity so a quick optimistic echo cannot count as delivery. Report median,
p95, maximum, sample count, missing deliveries and UI stalls for each run and
direction. No pooling hides a failing device or IME series.

Issue targets are p50 <= 250 ms and p95 <= 500 ms on LAN. For the remote profile,
require p95 <= measured p95 RTT + 250 ms; state this percentile interpretation
in the preregistration. Every required edit must arrive; missing samples fail.
No input task may block the UI for more than 50 ms; report frame intervals and
input delay separately from network latency. Video/screenshots must show the
actual editor, selections, undo and recovery surfaces, with secrets masked.

## 4. Scenario matrix and exact oracles

### Whole-file editor-buffer experiment for 1.1.7 preparation

Before a character engine, compare the released save-driven sender with a
measurement-only sender that samples a committed editor buffer 300 ms after
the last input. It stays on the never-merged experiment branch and uses the
existing authenticated, encrypted whole-file protocol. Do not transmit an IME
composition, invent a disk-save acknowledgement, overwrite an unsaved buffer,
or bypass the receiver's editing guards. Measure the 10-second recent-input
hold separately from unsaved-text and active-composition holds, which can
continue beyond that window until their conditions clear.

Use two native desktops and a physical phone with one 8 KiB synthetic note.
Record twenty single-writer edits in each direction and twenty overlapping
two-writer edits, followed by disconnect/reconnect and process restart. Read
editor text, disk bytes and acknowledged versions independently. Compare
latency distributions, request/byte counts, duplicate versions, conflict copies,
cursor movement and locally unsent text. A faster first appearance with lost
text or a false saved indicator fails. This experiment cannot establish the
character engine's convergence, offline outbox durability or revocation claims.
Status: **NOT_RUN**; a reviewed buffer/disk publication boundary is required
before executing the prototype.

### Completed desktop public-save pilot

On 2026-10-05, two installed Obsidian 1.13.4 desktop windows ran 40 paired
trials, alternating arm order independently of writer direction: ten A-to-B,
ten B-to-A and twenty overlapping cases per arm (80 total). Each writer typed
four characters at 100 ms intervals through native input, with one initial
caret placement. The experimental arm called public `MarkdownView.save()`
300 ms after input; the baseline retained ordinary saving. It published only
through the existing disk-to-encrypted-whole-file path. This is a save-timing
pilot, not direct publication of an unsaved editor buffer.

The candidate plugin SHA-256 was
`e69799d25f9cb71c30f49a58e2b8a58f02433a52fc99ce8e63a4a9b28ae3912b`;
server SHA-256 was
`9d42d9c240862340d39ce76d36f10d1564fa7dba1e9cab7bad047751c0282cdc`.
Both derive from `897124b073baf51ef2cb3fff52a5badc1940a237` plus the recorded
1.1.7 preparation changes; they predate the later outage-throttling fix. The
never-merged experiment commit `82dbe4cffbd40bfcb3096d49a95a5610c87d1c5a` supplies `experiments/sync-117/harness/scripts/validation/lab/editor-save.mjs`.
An explicit candidate source checkout and fresh external run are required:
`python3 experiments/sync-117/test.py editor --source "$CANDIDATE" --run "$RUN"`.

| Case | Samples per arm | Baseline median / p95 / max, ms | Early-save median / p95 / max, ms |
| --- | ---: | ---: | ---: |
| A to B | 10 | 2003 / 2153 / 2153 | 533 / 583 / 583 |
| B to A | 10 | 2005.5 / 2034 / 2034 | 572.5 / 581 / 581 |
| Overlapping writers | 20 | 11120.5 / 11139 / 11154 | 10725 / 10741 / 10742 |

Latency starts after the last injected input and ends at the observed peer
editor/disk predicate. These are common-host observations, not physical-phone
measurements. All 80 cases preserved exact expected editor/disk text and no conflict copies under the driver's
filename oracle. File/version identities were not independently compared in
this pilot. All 120
writer disk-save observations were present; save-hook entry was observed at
303–308 ms. The one-way disk-save medians changed from 1768.5/1772.5 ms to
310.5/311 ms. Overlap remained governed by receiver editing holds.

No task build, VM or stress ran alongside the campaign; document work and a
small cleanup-guard test continued, and unrelated host idleness was not proven.
Loopback HTTP and a disposable mock keychain limit this to functional desktop
save behavior. It does not establish trusted TLS latency, physical-phone
performance, request/byte savings, 8 KiB/IME behavior, disconnect/restart or
crash durability. The two inspected final editor screenshots showed both
writers' text; one transient combined-edits toast was partly clipped at the
right edge. No claim of full UI or engine acceptance follows.

The external `editor-save-candidate/evidence/` record contains all 80 cases,
`editor-summary.json`, the two-image inspection receipt and separate teardown,
final cleanup and workflow receipts. Hooks were removed and all generated
accounts, profiles, vaults, server data and private logs were discarded after
process absence proof. The pilot supports further save-timing investigation;
it does not select a shipping change or mark the larger buffer experiment or
E1–E11 complete.

### Deferred character-engine acceptance

| ID | Bounded run | Pass oracle | State |
| --- | --- | --- | --- |
| E1 | A/B type for 10 minutes in the same line/paragraph at 5 committed operations/s/device; twenty range-delete/concurrent-insert cases in each run. Repeat all note sizes and both measured network profiles. | All admitted operations are accounted for; only causally deleted character identities disappear. Exact final UTF-8 bytes agree on A/B/C, no conflict copy, typed passages do not interleave, latency and resource budgets pass. | NOT_RUN |
| E2 | Twenty cases each of paste, selection replacement, local undo/redo, split-view edit, popout edit, emoji and combining-mark edits; physical IME composition on each advertised phone platform. | No lost keystroke/composition, cursor follows its intended logical anchor, local undo does not undo peer work. Native screenshots/video and byte oracle both pass. Held IME samples remain in latency results. | NOT_RUN |
| E3 | Twenty whole-note delete versus edit/rename/external-save cases, both delivery orders; restart after preservation and after deletion. | Live note absent everywhere after preservation completes; concurrent editor text available through both history and Trash; one notice per device/generation across replay/restart; Restore creates a fresh identity without replacing another file. | NOT_RUN |
| E4 | Twenty external rewrites with same size/mtime and twenty changed-size rewrites, open and closed editor; stop at each projection/outbox boundary. | Correct causal diff or visible safe hold; disk, editor and frontier agree after recovery; no duplicate publication, torn bytes or hidden loss. A hold fails any scenario requiring automatic completion. | NOT_RUN |
| E5 | A offline for one real 24-hour interval while B edits; A has 100,000 operations, B another 100,000. Separately replay the same history without waiting, labeled accelerated. | Reconnect preserves both tails, converges without copies within catch-up memory/CPU/wall budgets; no GC of needed history. The accelerated row does not stand for the real offline duration or phone suspension. | NOT_RUN |
| E6 | Unchanged released 1.1.6 beside prototype: edit before/during/after conversion, lost conversion response, original/fresh file ID, rename/delete/folder operations, restart, metadata loss and plugin downgrade. | Each edit is either committed once before the atomic fence or visibly retained locally after refusal. Updating imports preserved text from its verified base; a deleted generation stays deleted. No old write crosses the fence and no old edit is erased. | NOT_RUN |
| E7 | Owned server process stop before/after each fence, seed, nonce and journal durability boundary; old server attempts both journal and snapshot stores; restored pre-conversion backup. | Acknowledged data survives; unacknowledged outcome is reconciled truthfully. Old server refuses upgraded storage before writing, updated clients refuse rollback, and no partial conversion becomes writable. This is process interruption, not power-loss proof. | NOT_RUN |
| E8 | Isolated synthetic frame validation: altered ciphertext/context, wrong signer, duplicate identity, changed membership, cross-generation substitution, missing parent, order permutations and final silence. | Invalid frames change no projection/frontier; exact duplicates apply once; valid concurrent orderings converge; missing dependencies/silence produce the specified bounded waiting/unknown state. Observer bytes contain no text/path/key sentinel. | NOT_RUN |
| E9 | Revoked writer, offline authorized writer crossing two epochs, withheld membership update while ordinary requests succeed, reconnect before/after learning the removing epoch, concurrent epoch proposals, restored sender outbox, loss of all current devices and recovery. | Content encrypted after a writer validates the removing epoch is unavailable to the revoked key set. Record that an unaware writer's old-epoch content remains readable by that set; never label successful requests as fresh membership. Allowed old edits stay recoverable; nonce/key pairs never repeat for different plaintext; recovery follows the separately accepted authority. Blocked until that design decision. | NOT_RUN |
| E10 | Idle 10 minutes, active 10 minutes, disconnect/reconnect twenty times, twenty foreground/background cycles, notification/feed duplicates and queue saturation. | Zero idle presence, one application path, bounded queue, no duplicated edit or unbounded retry; fallback resumes and visible status meets bounds. No battery-life claim follows from this short run. | NOT_RUN |
| E11 | Twenty cases each of pause with pending text, resume, leave with/without the chosen local copy, disabled presence during active typing, retention/deletion with an offline peer, and export before server acknowledgement. | Independent editor/disk/outbox readback preserves pending edits. Pause admits no new publication after its completion receipt; in-flight requests have explicit outcomes. Leave removes credentials and preserves only the chosen copy. Disabled presence emits no presence frames while content sync continues. Deletion status distinguishes server completion from offline copies. Export includes pending text and labels recovery branches; diagnostics contain no content/path/key sentinel. | NOT_RUN |

For E1/E8, enumerate all delivery permutations of each three-event reference
case (including two insertions and a range deletion), then fixed seeds 0–99
with 200 operations each. The independent oracle tracks inserted character
identities and causal deletion; it must not call the candidate's ordering or
merge function. Check byte convergence, preservation and non-interleaving as
separate properties. These small deterministic cases precede native work.

The server remains blind during observation. Synthetic plaintext and expected
hashes are held by the client observer only; scan captured wire, logs and store
metadata for sentinel encodings without sending expected plaintext to the
server. A scan pass supports the observed run, not an information-theoretic
claim that timing or size reveals nothing.

## 5. Driver contract and evidence

The experiment branch must provide one stdlib-only driver at
`scripts/experiments/coedit.mjs`. These commands are the planned interface;
they are **not runnable until that source is implemented and reviewed**:

```sh
node scripts/experiments/coedit.mjs prepare --baseline "$BASE" --candidate "$CANDIDATE" --run "$RUN" --seed 315 --max-bytes 1073741824
node scripts/experiments/coedit.mjs reference --run "$RUN" --seeds 0:99 --operations 200
node scripts/experiments/coedit.mjs native --run "$RUN" --scenario E1 --profile lan --runs 3 --warmups 1
node scripts/experiments/coedit.mjs audit --run "$RUN"
node scripts/experiments/coedit.mjs down --run "$RUN"
```

`BASE` and `CANDIDATE` are full immutable commit IDs, and `RUN` is an owned
external directory. Repeat the native invocation for every matrix row/profile;
the driver rejects an unknown ID or an environment whose declared capabilities
do not match the row. `prepare` writes the frozen manifest; it cannot loosen
budgets at runtime. The driver records exact argv, source/fixture hashes,
observer version and timings in a receipt. Secrets never appear in argv,
receipts, screenshots or public logs. Prototype source can be reproduced from
the pushed experiment branch; deterministic dataset recipes live beside the drivers on the never-merged
experiment branch; generated data and run output stay outside every checkout.

Each run retains its input trace, independent expected identities, client byte
inventories, stage timings, memory/CPU samples, bounded server metadata, native
visual evidence and cleanup receipt. Public records contain sanitized counts,
hashes, exact commit/command and explicit FAIL/UNKNOWN/NOT_RUN rows. Every
number in the final report links to that receipt. Missing physical-device,
platform metric or storage proof stays a gap, even if the emulator passes.

The existing 7,700-note first-sync/stage-profile benchmark belongs to the
separate measured pipeline work. Cite its exact baseline/candidate records;
these note-sized co-edit experiments neither replace it nor claim its speedup.

## 6. Guard audit and promotion

Before review, remove/invert each new guard one at a time in the disposable
prototype and require the relevant oracle to fail: causal/context binding,
signature/epoch check, duplicate suppression, fence comparison, legacy writer
gate, preservation-before-delete, notice receipt, outbox receipt ordering,
checkpoint retention, queue/byte bound and session/counter discipline. For E11,
mutate the pause publication gate, presence-disabled gate, credential removal,
local-copy choice, pending-export inclusion and deletion-status distinction;
each corresponding independent oracle must fail. Restore
and prove source identity after each case. Report a surviving mutation as a
finding. Never mutate a shared or live server, profile or vault.

Fast pre-push work is the reference corpus, codec known answers, bounded guard
suite and one local two-editor smoke after relevant code changes. Full native
matrix and 24-hour/offline rows run for an experiment candidate or release
candidate, not every docs commit. Failure evidence is retained; a unit pass
does not mark a native row complete. The unchanged repository gate still runs
where its policy requires it.

After each run, stop only manifest-owned processes, prove they exited, remove
their runtime directories and verify control sentinels. Retain fixture recipes
and sanitized evidence only. Remove generated fixture data, test accounts,
credentials, payload archives and owned resources once the test is resolved,
then independently verify their absence. Never sweep
by a broad name pattern. The final design record can select or reject a
candidate only after presenting these results and unresolved limits. It cannot
announce the deferred engine as implemented or close #315's product acceptance.
