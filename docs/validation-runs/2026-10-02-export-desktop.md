# Export desktop rehearsal — 2026-10-02

## Scope and candidate

Native macOS Obsidian 1.13.4, one disposable profile and vault, loopback HTTP server.
The owner profile and real vaults were not opened. The candidate was an
uncommitted export implementation over
`03d108505d3993bddff276d70c814a6547222339` (version 1.1.5); this is development
evidence, not a release or an exact PR-head verdict.

| Artifact | SHA-256 |
| --- | --- |
| `obsyncd` | `4309e67a5dee8e295e7416a269f949904d2c555d835d5203377d662461b5315d` |
| `main.js` | `cf7d1e935d99c2da2f16bed86e0322871719821b178d2e5c11bd7a877e19b809` |
| `manifest.json` | `ed84bd8d8d6f4e316d96ecddc8e097704a8719367781ac35d61cff7b4dba463d` |
| `styles.css` | `43dd0db8ccce20e88a3c63ec2ea35e46ce4133912c0e797da036e37a6499287b` |

## Reproduction

Build with `cargo build --release -p obsyncd` and `cd plugin && npm run build`.
Use the disposable native lab launcher with one device and an external run
directory. Its external `export-native.mjs` driver calls the real plugin
command and dialog controls; the lab verifies the recorded process identity
and exact vault before each renderer operation. The driver and generated
fixture remain outside the repository, as required for reusable lab data.

```sh
python3 -B "$HARNESS/lab.py" up --run "$RUN" --source-repo "$CANDIDATE" \
  --binary "$CANDIDATE/target/release/obsyncd" \
  --plugin "$CANDIDATE/plugin/dist" --devices 1 --hold
node "$HARNESS/journeys.mjs" "$RUN" init
node "$HARNESS/journeys.mjs" "$RUN" setup-first
node "$LAB/export-native.mjs" "$HARNESS" "$RUN" prepare
node "$LAB/export-native.mjs" "$HARNESS" "$RUN" encrypted
```

Stop only the server process group recorded in that run, using the launcher's
identity-checked `stop` function, and assert the group is absent. Keep the
owned desktop running, then run:

```sh
node "$LAB/export-native.mjs" "$HARNESS" "$RUN" open
node "$LAB/export-native.mjs" "$HARNESS" "$RUN" plain
python3 -B "$HARNESS/lab.py" down --run "$RUN"
```

The fixture is three files: an empty Markdown file, a Unicode-named Markdown
file with CRLF bytes (52 bytes), and a binary file containing byte 42 repeated
8,388,627 times (one chunk plus 19 bytes). Native setup confirmed recovery,
the editor showed the sentinel note, and sync reached idle after all three
uploads. No recovery phrase, key or credential appears in recorded output.

## Observations

| Native action | Result | Elapsed ms | Animation frames | Largest frame gap ms |
| --- | --- | ---: | ---: | ---: |
| Encrypted copy | PASS, archive 8,393,658 bytes | 203.0 | 24 | 8.8 |
| Offline open, server process absent | PASS, three paths and bytes identical | 103.6 | 12 | 8.4 |
| Plain local copy, server process absent | PASS, three paths and bytes identical, no pending uploads | 204.8 | 24 | 9.0 |

The driver produced these numbers from `performance.now()` and
`requestAnimationFrame` while the native window was visible. Completion is
polled, so these are coarse functional observations under concurrent work,
not a quiet benchmark. Every plaintext output path, size and SHA-256 matched
an independent filesystem inventory of the source. The archive and both
outputs were outside the vault.

Opening the command twice produced one dialog. Screenshots of each completed
action were visually inspected: labels, warnings, success text and controls
were readable; the taller offline form scrolled to its action buttons.
Inputs were masked and the recovery password was empty. All three actions
recorded zero renderer warnings, errors or exceptions.

Earlier attempts caught two product defects: repeated export commands opened
stacked dialogs, and nanosecond-derived timestamps falsely marked uploaded
files as pending. The final run includes the singleton-dialog and host-rounded
timestamp fixes. A hidden-window attempt is excluded from responsiveness
evidence. An intermediate layout-only capture was not used as success proof.

## Focused safety evidence

`node --test test/export.test.mjs test/status-ui.test.mjs` passed all 32 tests.
The export cases include exact multi-chunk output, wrong-key refusal with no
stage, authenticated inventory, malformed/truncated archives, missing chunks,
path collisions, existing destinations, cancellation, source changes, and
server-origin acknowledgment. Synthetic non-dot vault configuration is
excluded from scan/copy/revalidation, and an explicitly supplied configuration
path is refused before staging. This custom-config case is a real filesystem
test; native Obsidian custom-config setup was not exercised.

A child process exited during plaintext staging. The destination stayed
absent; its stage was 0700 and journal 0600. Retrying the same target removed
the verified orphan and produced exact bytes. Active-process, invalid-record
and wrong-inode recovery attempts preserved sentinel files and refused.
This is process-crash evidence, not power-loss durability evidence.

Seventeen bounded JavaScript mutations were killed: inventory authentication,
coherent selection, metadata budget, ciphertext digest and length, portable
path collision, server-origin acknowledgment, unsupported platform,
outside-vault destination, host timestamp precision, configured-directory
exclusion, explicit config-path refusal, active recovery owner, recovery
record and inode binding, local snapshot stability, and duplicate dialogs.
Each compiled file was restored after its mutation.

## Cleanup and remaining acceptance

Final teardown reported zero owned process groups, zero holders and no
runtime directory. Earlier disposable attempts were also torn down. Only
external evidence, private lab records and reusable fixture generators remain.

Issue #317 is not complete. Still unproved: physical phone behavior, supported
Windows/mobile private publication adapters, Linux native acceptance,
app/CLI interoperability, foreign vaults with custom config directories,
machine-crash publication durability, and the required 7,703-note elapsed-time,
peak-memory, extra-disk and responsiveness measurements. Integrity and flush
checks remained enabled in every reported run. Platform boundaries and the
recovery contract are documented in [export and offline copies](../export.md).
