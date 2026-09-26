# Mutation measurement provenance

The full campaign uses six isolated lanes with the 1,218-test plugin suite
at `ac1c934e61d2e77a1a47e5c178649f687f4897ef`. All six pristine
baselines passed. Product source is unchanged by the witness repairs below.
The original lane logs and original failed or surviving results are retained.

The frozen input manifest is `source-hashes.json`, SHA-256
`665815f0183a3c4a1546206d3ab8aea6b521a316df68cec0d0125803621c0532`.
Its source/test/package hashes are checked before each continuation, and
every lane restores and verifies its source and tests after each mutation.

## Explicit replacement measurements

These three full-suite runs replace the corresponding original table rows.
All three still run 1,218 tests: 1,217 pass, one behavioral failure, zero
cancellations and zero skipped tests. Each patch applies with exact context,
compiles, and restores its product source afterwards. No production behavior
was changed to obtain these results.

| Mutant | Original result | Witness repair |
| --- | --- | --- |
| M64 | 1,218 passed | Isolate the existing pending-upload folder-rename test from periodic disk rediscovery. The watcher must carry the pending upload through the rename. The mutant now fails its bounded wait for delivery; the original passes. |
| M583 | 1,217 passed, zero failures, one cancelled | Observe either forgotten-device or offline status before asserting the original expected classification. The mutant now reaches and fails the original assertion. |
| M609 | 1,218 passed | Extend the existing cancelled-pairing test to cover incomplete as well as valid codes, and require no notice after closing. The mutant reports validation after cancellation and fails. |

The M583 full-suite replacement used recovery-test SHA-256
`477b481625787bec668fe59f923bc59ac516463fd4f79fcf8933e8b32ffeab75`.
The M609 replacement includes both recovery repairs, SHA-256
`3e710f9a4cc6b77cca3c318f6b8ff0a04e59347fa4834024a68df7c969a320b4`.
The M64 replacement additionally uses interactions-test SHA-256
`d4cd39d7de2de74654811147a5c2aabaece8ab98a2e2b707c874af9e70a1796f`.
The independent reviewer replayed M583 and M609 with the combined recovery
changes, and M64 with the actual interactions change, with passing baselines,
behavioral failures, zero cancellations, and passing restored builds.

| Replacement log | SHA-256 |
| --- | --- |
| `m64-remeasurement.log` | `e1ad4b7601d8f0c7e97c7529ca84b5df28fee69274cf441f0f8896358e7df0b3` |
| `m583-remeasurement.log` | `88bd3fd34f4664d645a2c1b59d786b2f7e4d18b0517b75b1fb69a867b0290b7d` |
| `m609-remeasurement.log` | `2b178f8247dd894d823194b61cfbfebbc102a1dd49e70044b0bf0a19aa0a38d7` |

## Regeneration and scope

Concatenate the six original lane logs, followed by the three replacement
logs, into `completed-matrix.log`. `record.py` uses the last measured section
for each mutant. Then run:

```sh
python3 plugin/test/mutants/record.py completed-matrix.log plugin/test/mutants 1218
```

The table therefore describes a frozen campaign plus three named
re-measurements. It does not imply every historical mutant ran against the
final test tree. Non-passing-test counts include any cancellations, which
are reported separately; a cancellation alone is not a behavioral kill.

## Completed result

All 796 controls are measured: 796 behavioral kills, zero survivors,
zero cancellation-only kills, and all six lane source/test/package manifests
restored. Each result accounts for the full 1,218-test suite. Eight rows
include cancellations alongside actual failures; those cancellations are
reported separately and are not the evidence used to count a kill.

The combined log has 799 sections: 796 original sections plus the three
replacement measurements above. Its SHA-256 is
`0ba114be2f70127cc0072efd76b776a1cfbcd34a0743403086677b3ee9ccffa2`.
The generated `MATRIX.md` SHA-256 is
`25f72a0a6312ae46b0841d1aa66b7b1679edbf3a671460e1eb28a627dc7e4789`.
An independent regeneration is byte-identical, and every table row matches
the raw log's counts. The independent reviewer additionally verified all
796 guards with focused positive, mutated, and restored checks; those
independent measurements have zero cancellations.
