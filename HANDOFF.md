# obsync 1.1.3 — clean author handoff

This is a handoff branch, not an additional release PR. Continue the existing
[PR #189](https://github.com/snaraj/obsync/pull/189) on
`gpt-6-high/136-sync-train-1.1.3-main`. The owner requested this checkpoint to
transfer execution to any capable agent. Do not restart the project or invent scope.

## State that matters

- PR head: `ac1c934e61d2e77a1a47e5c178649f687f4897ef`. Product source and final bundle are unchanged from
  `0136ddac5741f3340deaa3cc879deb403a8f88ac`; the later commit corrects evidence,
  records cleanup, and adds a real iOS permission screenshot.
- Protected base last verified: `88e8804065a27834bc671a875551a235bafbe193`.
  #133 merged and 1.1.2 published. #187 and #188 are superseded/closed.
- Version locks are 1.1.3, exactly one patch step over main. PR #189 stays
  Draft, with `requires-review` OFF while author acceptance is incomplete.
  No independent verdict exists at this head. Owner alone merges.
- Final plugin SHA-256:
  `ef030cab10b564982eb920d8781b9f8a7f5e01779395a2a1469e11553b4ddedb`.
- Full `make check BASE=88e8804065a27834bc671a875551a235bafbe193` passed again
  in 229.796 seconds: 1,218 plugin, 70 dashboard, 144 core, 375 server,
  two CLI tests, 767 contracts, 94.73% Rust line coverage, both secret scans.
  One core benchmark is intentionally ignored. The final wording additionally
  passes all 104 capture contracts. Re-query hosted checks at the new head;
  23 checks passed and docs deployment skipped at the preceding source head.

## Strongest evidence: actual native behavior

Read [the final measured record](docs/validation-runs/2026-09-25-editor-budget.md)
and its actual screenshots before changing code. Native evidence is scoped to
its exact build; automated tests do not replace it.

1. Two native Obsidian 1.13.7 profiles on one physical laptop ran the final,
   uninstrumented bundle. Forty alternating key events over 16.698 seconds,
   without a midpoint pause, converged to both complete twenty-letter sequences.
   No new conflict copies appeared; replay of the checksummed journal found
   one head, 446 stored versions, and no paused note. This is desktop proof,
   not two physical devices or phone proof.
2. The preceding valid failure had both append carets verified, a ten-version
   listing, and zero merge-storm refusals. Retained common ancestry had fallen
   outside the listing. The repair retrieves omitted parent records with a
   64-read bound, validates their IDs/parents, stops at a shared frontier,
   restores incomplete expansions, and handles recursive criss-cross bases.
   Nineteen new mutation controls plus two recuts compile and fail assertions;
   restored focused tests pass. An incorrectly positioned-caret run is excluded.
3. Earlier desktop rewrite hold/Resume results, actual recovery and Leave,
   first-sync, phone and three-peer results are in the linked dated records.
   Keep their original hashes and limitations. In particular, the older
   five-minute rewrite proof does NOT certify this final phone build.
4. The final build was installed and reloaded in an isolated physical iPhone
   vault, but final phone pairing/typing/rewrite acceptance never completed.
   An initial IP URL correctly failed TLS against a hostname certificate.
   Later inspection found a mistyped port and UI entry dropping characters.
   Safari reached the server over trusted HTTPS and Obsidian Local Network
   permission was ON. Do not misreport this as a plugin networking failure.
   Repeated computer-tool `noWindowsAvailable` and text-entry problems are
   environment failures. Stop repeating unlock requests when already unlocked.

## Finish the existing work, in this order

1. Read current AGENTS.md and the machine's applicable skill. Fetch origin,
   verify PR head/base and signer, and work on the existing PR branch. Keep
   this handoff document out of product changes unless deliberately retained.
2. Inspect the existing full mutation campaign before starting anything else.
   It reached 196/796 at a clean checkpoint, every lane restored, with no
   unexpected results; it has resumed. Six pristine baselines each passed all
   1,218 tests. Do not call partial counts a pass or count compile errors as kills.
3. On the original machine, evidence lives at
   `~/code/obsync-evidence-2026-09-24/final-ancestry-matrix/`.
   Read `campaign-progress.json`, then `campaign-findings.json` or
   `campaign-completion.json` if present. Six lanes and pinned dependencies
   are intentionally retained until this run ends. The old-thread one-time
   wake was stopped for handoff; review/conversation singletons were untouched.
   Do not duplicate the runner. Its `pause-requested` file pauses only between
   mutants and preserves restoration. Delete only your known pause reason to resume.
4. When all 796 measured controls complete, inspect the receipt, failures and
   restored hashes, then generate the existing matrix record:
   `python3 plugin/test/mutants/record.py /path/to/completed-matrix.log plugin/test/mutants 1218`.
   `MATRIX.md` is still historical. Commit the generated record with the relevant
   gates. Any survivor or invalid measurement must be resolved first.
5. Recreate a small disposable server, one native desktop vault and one phone
   vault. All previous active desktop/server fixtures were intentionally removed.
   Verify the saved HTTPS hostname AND port before pairing. Never weaken TLS.
   Repeat the affected final-build phone/desktop typing and rewrite hold/Resume
   journeys from docs/validation.md; preserve actual input timing, both saved
   contents, copy counts, server heads and quiet follow-up. Capture only synthetic
   note areas and safe setup controls; redact identifiers and embedded metadata.
6. Clean up the new fixtures. Complete the remaining phone certificate/secret
   and browser residue cleanup below. Then update evidence and PR accounting,
   re-run required gates, apply `requires-review` when complete from author,
   obtain independent exact-head review, resolve findings on the same branch,
   and only then flip Ready. Give the owner the merge command; never merge.
7. After the owner merges, verify exact-main CI, immutable 1.1.3 release/assets,
   image/chart signatures and actual installation/distribution. Publication
   is not deployment. Nothing here proves production activation.

## Scope and decisions already made

PR #189 targets these 23 issues: #135, #136, #137, #138, #139, #140, #141, #142, #143, #144, #145, #146, #147, #149, #150, #159, #172, #173, #175, #178, #179, #180, #181.
Together with closed predecessor issues #129, #131 and #148, that is 26 train
issues, not all repository issues. The other currently open issues remain
outside the PR's closure claims: #43, #72, #74, #93, #122, #127, #134, #151, #152, #153, #154, #155, #156, #157, #158, #160, #161, #162, #163, #164, #165, #166, #167, #168, #169, #170, #171, #174, #176, #177, #182, #183, #184, #185, #186.
Do not silently mark them implemented or expand the release to include them.

The owner approved sealed vault name/note count in pairing (#141), and
account re-enrolment using setup token plus vault-key proof (#142). Delete
versus edit (#178) must keep the edit, retain deletion only in history, settle
one live head, and avoid repeated notices. These changes are already in this
branch; inspect their tests and dated native evidence before touching them.
Guides cover ordinary users and Docker/Kubernetes/homelab operators. Cloudflare
is optional. Preserve provider choice, E2EE, and honest availability/backup limits.

## Cleanup and retained essentials

Removed and verified: two active desktop QA apps/profiles/vaults, all four QA
containers and four disposable volumes, old download-serving files and backup,
plus the final phone QA vault and ZIP through recoverable Files deletion.
Only the owner's two vault folders and original download remained in those
phone views. Owner contents were not opened; Recently Deleted was not purged.

Still needs phone UI cleanup: QA certificate profile(s), any test-only secret
references whose ownership can be proved, and QA Safari tabs/history/download
entries. Never delete an owner vault, unrelated profile or whole browser history.
A certificate-removal passcode, if requested, belongs to the owner.

Obsolete branches/worktrees are being removed under explicit owner authority;
main, the live PR branch and this handoff branch are the intended survivors.
Before deleting refs, their complete history was verified in the local
`handoff-pre-cleanup.bundle`; the cleanup receipt records the exact inventory.
Retain only the live campaign, its pinned toolchain, concise receipts, this
handoff, and the committed manual records/screenshots. Old QA fixtures and
scratch experiments are not necessary to resume the work.

Do not touch Bitwarden. Do not duplicate or restart the separately owned
review/conversation monitors. Notify the owner only for a required action.
