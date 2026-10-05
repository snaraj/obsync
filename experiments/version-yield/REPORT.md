# Rejected version-queue scheduling yield, 2026-10-05

A single scheduler yield after enqueue and before the journal lock did not
meet the frozen 5% improvement threshold. The median paired 128-note sender
ratio was 0.989020 (about 1.1% faster); receiver ratio 0.991225. The source
change is rejected and restored. No production optimization is claimed.

The experiment changes only `std::thread::yield_now()` outside the queue and
journal locks. Existing authentication, nonce persistence, encryption, integrity,
per-file ordering and durable acknowledgement remain enabled. Ninety-seven
storage tests passed. The narrow review identified no new correctness guard:
removing the yield is the measured baseline, not a correctness mutation kill.

| Sample | Arm | 128-note sender ms | Receiver ms | Large sender ms | Receiver ms |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | Baseline | 4848 | 5511 | 1837 | 2112 |
| 2 | Candidate | 4542 | 5233 | 1809 | 2086 |
| 3 | Candidate | 4684 | 5359 | 1801 | 2077 |
| 4 | Baseline | 4736 | 5399 | 1803 | 2080 |
| 5 | Baseline | 4770 | 5470 | 1797 | 2066 |
| 6 | Candidate | 4764 | 5422 | 1803 | 2082 |

Pairs are (1,2), (4,3), (5,6), with candidate divided by baseline. Small-note
sender ratios are 0.936881, 0.989020 and 0.998742. All improve, but the median
fails the fixed threshold. Large-file sender/receiver median ratios are
0.998891/0.998558. Each fresh run also includes eight isolated notes and bursts
of two and four; every isolated-note p95 meets the frozen regression bound.
All raw observations and small-sample limitations remain in the JSON receipts.

Every sample independently matches 143 file paths and 68,275,569 bytes on each
peer, with equal persisted file/version identities. All sender request counts
and body sizes match. One receiver burst differs: seven chunk-read requests
with 8,569 request-body bytes versus eight with 8,579 bytes; do not claim identical
receiver traffic. Observed version-batch histograms are retained per scenario.
They count version outcomes, not independent fsync calls. Known synthetic
plaintext/path sentinels were absent from the owned server storage; that narrow
oracle is not a general confidentiality proof.

The installed native app is Obsidian 1.13.4 on the same macOS host for both
peers and server. Loopback HTTP and mock keychains make this a screening
comparison, not TLS, phone, key-custody or deployed-route performance acceptance.
No task build, VM or emulator ran during timed samples. An independent short
Node mutation pass overlapped the start of the campaign; its exact overlap
with sampling was not recorded. Host-wide idleness and observer overhead were
not calibrated. No sample was filtered or repeated.

All twelve synthetic PNGs were displayed and inspected. They show the same
last numbered note in both windows. Activity glyphs after opening it are not
a stable-idle assertion. Six runs have successful teardown/finalization receipts:
owned processes, profiles, accounts, server state, private logs and manifests
are absent. Input cleanup is recorded separately. The exact rejected patch,
input hashes, unchanged plugin hash, recipes and reduced evidence are retained.

Recompute the complete frozen acceptance rule with:

```sh
python3 -B recipes/summarize.py samples
```

For reproduction, use the harness at never-merge commit
`01e18a1e1caceef41b838bf935be8b01ddb69da5`; its entry point is
`experiments/sync-117/test.py`. Build `obsyncd` twice from candidate
`4c746e4efbe1bec4cb03af347c1f554e122249a9`, applying the decoded
`recipes/candidate.diff.json` only to the second build. Use the unchanged plugin
whose SHA-256 is in `evidence/provenance.json`. `recipes/README.md` records the
predeclared sequence, acceptance thresholds and controller arguments.
