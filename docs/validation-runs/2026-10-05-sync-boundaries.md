# Native insertion-boundary regression

Two disposable macOS Obsidian 1.13.4 profiles reproduced three failures with
the 1.1.7 candidate at `6b56e7dbb00427e90c38740407d7289b04bf5321`:
typing before and after one line left three conflict copies; simultaneous
prefixes also left three copies; two word streams joined `A004B001` without
the space typed by the second writer. Both editors agreed with independent
file reads. These are failures of that candidate, not a comparison with 1.1.6.

The repaired merge keeps every original character as an alignment anchor,
including when typing precedes the first character. When different additions
share only leading whitespace, each retains its separator. Deletions,
replacements, oversized alignments and structural overlaps retain the existing
conflict path. Encryption, request authentication, durability and editor-write
guards are unchanged.

The same native inputs then passed all three cases. Both editors and files
contained the expected complete text, one shared file identity and no conflict
copies. Input was trusted: 14/26, 13/13 and 4/4 insertions respectively, with
zero untrusted events. The driver positioned each cursor once before typing;
the final screenshots showed each cursor at its own stream endpoint. All six
failure and six passing screenshots were inspected.

Convergence after the last input took 11,064, 10,530 and 10,545 ms, including
the existing ten-second editing hold. These are correctness observations,
not a speedup or continuous character-level collaboration claim. The test
used loopback HTTP and a mock desktop keychain; physical-phone, trusted-TLS
and personal-key-custody acceptance remain separate.

The tested repair bundle was
`ba802324c917a33353b8698d29db60604e682100cd630e9f6ff27ef28d6733a0`.
A subsequent logging-only field-order correction changes the bundle hash;
later platform records must name the bundle actually installed there.
The initial regression tests failed on both defects. Ten deliberate code
faults were detected, including prefix refusal, separator collapse, empty-side
duplication, ordering, Unicode whitespace and missing diagnostic fields.

Reproduce with the experimental harness at
`f1ccf248a69d981b6e543e46ff42cf8e0a0aa723`:

```sh
python3 experiments/sync-117/test.py boundaries --source "$SOURCE" --run "$RUN"
```

Use a built explicit source and a new external run directory. Inspect
`boundary-cotype.json`, all six PNGs, `teardown.json`, `final-cleanup.json` and
`workflow.json`. Failed cases retain reduced evidence. The wrapper removes
owned accounts, profiles and private logs after process-absence proof, on
failure too; failed shutdown preserves ownership records for an exact retry.
Both recorded runs have no remaining runtime, private data or live manifest.
The cleanup suite passed 25 checks and detected both introduced cleanup faults.

The full local gate completed after correcting four initial assertions: two
conflict-copy fixtures now remove original text (actual replacements), and
the success log keeps its existing final `announced` field. The first gate
passed Rust formatting, lint, tests and 94.72% line coverage, then reported
1,977/1,981 plugin passes. After repair, 98 focused tests passed; the remaining
canonical targets (`make plugin cli dashboard chart contracts secrets`) passed
with 1,981 plugin tests, 83 dashboard tests, 873 contract tests, CLI checks,
chart validation and both secret scans. Two additional compiled-copy mutations
detected a missing merge duration and the obsolete replacement fixture. Their
scratch directory was removed. No Rust source changed between those stages.
