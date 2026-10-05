# Rejected version metadata batching, 2026-10-05

The prototype failed the acceptance rule fixed before measurement. Its median
paired 128-note sender ratio was 0.987755 (1.2% faster), below the required
5% improvement, and the third pair was 3.2% slower. It is rejected. Production
source is restored; this archive is evidence on a never-merge branch.

The bounded lever batches only encrypted version metadata for normal file
pushes: at most 32 distinct files, 16 KiB each, with a 4 ms coalescing window.
The additive authenticated endpoint uses the existing durable group commit.
Authentication, replay checks, encryption, integrity and fsync stay enabled.
Control and conflict-preservation writes keep the original immediate route.
No part of the prototype enters the release candidate.

| Sample | Arm | 128-note sender ms | Receiver ms | Large sender ms | Receiver ms |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | Baseline | 4911 | 5574 | 1832 | 2100 |
| 2 | Candidate | 4836 | 5448 | 1784 | 2053 |
| 3 | Candidate | 4840 | 5458 | 1785 | 2033 |
| 4 | Baseline | 4900 | 5554 | 1797 | 2059 |
| 5 | Baseline | 4805 | 5504 | 1788 | 2055 |
| 6 | Candidate | 4960 | 5594 | 1790 | 2064 |

Pairs are (1,2), (4,3), (5,6), candidate divided by baseline. Sender ratios
are 0.984728, 0.987755 and 1.032258. Median receiver ratio is 0.982715;
large-file sender/receiver medians are 0.993322/0.987373. All eight-note
isolated p95 controls meet the predeclared regression bound. No sample was
filtered or rerun. The rule and complete traffic differences are in
`evidence/comparison.json`; differing request counts are expected, not a
correctness failure or the reason for rejection.

Baseline 128-note bursts each made 128 version requests. Candidate bursts made
105, 107 and 110 requests (including 18, 17 and 15 batch requests). Chunk upload
counts and bytes stayed equal; some receiver read grouping changed. Request
counts fell without a consistent useful latency gain. Version batch histograms
count outcomes, not independent fsync calls; request time is not flush time.

Each fresh sample ran twelve phases: eight isolated notes, bursts of two, four
and 128, then a 64 MiB + 1 byte binary. Independent readback matched 143 files
and 68,275,569 bytes on each peer and persisted file/version identities. The
known synthetic content/path sentinels were absent from owned server storage;
that narrow check is not a general confidentiality proof. All twelve original
PNGs were opened and inspected: both peers display the same final numbered
note. Activity glyphs vary; the captures make no stable-idle claim.

Both native Obsidian 1.13.4 profiles and the server ran on the same macOS host,
over loopback HTTP with mock keychains. This screens the lever; it does not
prove TLS, credential custody, phone or deployed-route performance. No task
build, test, VM or emulator ran during sampling. External host load and observer
overhead were not calibrated. Six samples are not a population estimate.

Before measurement, 514 server library tests and all 1988 plugin tests passed;
149 lifecycle tests, formatting, clippy and both secret scans also passed.
Six server and sixteen client mutations were each killed twice, followed by
passing restored controls. The mutation receipts and recipes are retained.
This rejected prototype did not receive a complete release gate or formal
artifact approval. Initial tests exposed early-413 handling in the harness,
timer/cancellation stalls and interference with conflict-preservation writes.
The final source and bounded assertion deadlines addressed those failures.
Independent pre-review found incorrect inner-ack binding and stranded members
after timer rejection; both were fixed before the frozen run. Failed local
logs remain evidence; final success is not a first-pass claim.

All six runs finalized with no owned processes, profiles, accounts, raw private
logs, server state or manifests remaining. After archive/hash verification and
scoped open-handle checks, 1,282,243,915 bytes of copied inputs and owned build
outputs were removed. `evidence/final-task-cleanup.json` records those paths by
role. Only reduced receipts, synthetic screenshots and recipes remain.

Recompute from this directory:

```sh
python3 -B recipes/summarize.py samples
```

For fresh reproduction, use the harness at never-merge commit
`01e18a1e1caceef41b838bf935be8b01ddb69da5`, under `experiments/sync-117/`.
Build the baseline from candidate `519c0e50616cff58fffb772f172c5aad6620bba3`.
The rejected patch applies to the production source at
`4c746e4efbe1bec4cb03af347c1f554e122249a9`; those product sources are unchanged
at the baseline head. Apply the decoded `diff` from `recipes/candidate.diff.json` only to a separate
experimental checkout and build the second artifact pair. Exact frozen patch,
source and binary hashes are in `evidence/provenance.json`. Build paths can
change binary hashes. Never merge this branch or apply its instrumentation to
the release candidate. `recipes/README.md` records controller arguments and
thresholds. Archived mutation recipes take `SOURCE EVIDENCE_DIRECTORY` as
positional arguments; this path-only portability edit is recorded separately
in `evidence/archive-recipes.json`.
