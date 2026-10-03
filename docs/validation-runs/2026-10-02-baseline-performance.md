# Released 1.1.5 desktop throughput baseline

Date: 2026-10-02. Six alternating shown/minimized samples were scheduled on
one disposable macOS Obsidian instance per sample. Five completed; sample 5
failed before recording measurements. This gives **two complete pairs**, not
the three required for the planned comparison. The campaign does not close
[#262](https://github.com/snaraj/obsync/issues/262) or
[#274](https://github.com/snaraj/obsync/issues/274) or
[#283](https://github.com/snaraj/obsync/issues/283).

## Artifacts and method

All six `build.json` receipts identify clean released 1.1.5 source
`03d108505d3993bddff276d70c814a6547222339` and these SHA-256 values:

| Artifact | SHA-256 |
| --- | --- |
| `obsyncd` | `5c7b0af778c5162b5915ebc4c4f0114a3e6d874ae5f547ac1096aa9878d41804` |
| `main.js` | `34797c29613f28104157e09de46dc713be862269bdebca11c587ebe8c2522b11` |
| `manifest.json` | `ed84bd8d8d6f4e316d96ecddc8e097704a8719367781ac35d61cff7b4dba463d` |
| `styles.css` | `43dd0db8ccce20e88a3c63ec2ea35e46ce4133912c0e797da036e37a6499287b` |

Each sample used a fresh vault, account and server with the same 7,700
synthetic notes: 11,565,400 bytes, fixture digest
`637f4bea6f1ed029d67f4099120cf4961592f1f146137411b2dc6aa4b1b3e42b`.
The local server was reached through a temporary public HTTPS tunnel with
certificate verification enabled. This was not either reference deployment
route or Community Plugins installation proof. Security checks and durable
acknowledgments were unchanged. The campaign did not separately record the
host OS/app version or a cold/warm filesystem-cache classification.

The frozen harness first opened and trusted the owned vault, attached
measurement observers, set the window state, and completed native account
setup and phrase confirmation. It observed normal push completion logs and
completed `saveData` calls without replacing those operations. Minimized
samples stayed minimized for at least ten minutes, including the interval
after first sync. A subsequent **Sync now** was timed until its drained log.

### Reconstructing the campaign harness

The retained six-file snapshot is evidence, not a standalone executable
bundle. `lab.py` requires a Git worktree with the harness installed at
`scripts/validation/lab`; `journeys.mjs` also imports
`../../ci/obsidian-drive.mjs`. Start with that support file from baseline commit
`03d108505d3993bddff276d70c814a6547222339`, SHA-256
`ad9d047b12186ea3814c0a25393aee765a6f11538cd367dc299c99b61ef3d399`.
The baseline file needs the explicit import adapter below: export the seven
UI helpers and run its own journey only when invoked directly. The resulting
file has SHA-256
`0624d49ede7c9e027e5816f510ca60c1b0f7cccc8c826b4df57f0702385e6acc`.
That support file was not included in the campaign snapshot; this pins a
reconstruction, not independently retained historical support-file bytes.

Set `BASELINE_CHECKOUT` to the already built baseline checkout,
`FROZEN_HARNESS` to the retained snapshot, and `HARNESS_CHECKOUT` to a new
disposable worktree path. Reconstruct the layout without changing either
retained input:

```sh
git -C "$BASELINE_CHECKOUT" worktree add --detach "$HARNESS_CHECKOUT" \
  03d108505d3993bddff276d70c814a6547222339
HARNESS="$HARNESS_CHECKOUT/scripts/validation/lab"
python3 -B - "$FROZEN_HARNESS" "$HARNESS" <<'PY'
import hashlib, json, shutil, sys
from pathlib import Path
source, destination = map(Path, sys.argv[1:])
files = json.loads((source / "sha256.json").read_text())["files"]
assert set(files) == {"lab.py", "cdp.mjs", "journeys.mjs", "performance.py",
                      "performance.mjs", "fixture.py"}
destination.mkdir(parents=True)
for name, digest in files.items():
    assert hashlib.sha256((source / name).read_bytes()).hexdigest() == digest
    shutil.copyfile(source / name, destination / name)
support = destination / "../../ci/obsidian-drive.mjs"
assert hashlib.sha256(support.read_bytes()).hexdigest() == \
    "ad9d047b12186ea3814c0a25393aee765a6f11538cd367dc299c99b61ef3d399"
text = support.read_text()
entry = "\nmain().catch((error) => {"
assert text.count(entry) == 1
exports = "export { click, fillSetting, fillPlaceholder, settingsShow, " \
          "confirmPhrase, pairingCode, LABELS };"
support.write_text(text.replace(entry, "\n" + exports +
                               "\n\nif (import.meta.main) main().catch((error) => {"))
assert hashlib.sha256(support.read_bytes()).hexdigest() == \
    "0624d49ede7c9e027e5816f510ca60c1b0f7cccc8c826b4df57f0702385e6acc"
PY
python3 -B "$HARNESS/performance.py" --help
```

This reconstruction was checked with `--help`, the six snapshot hashes, both
support-file hashes, and relative-import/export resolution on Node 26.10.0.
Those checks did not start
a lab or replay the measurements. A separately authorized campaign then uses
new external output paths and the required native app/TLS route:

```sh
python3 -B "$HARNESS/performance.py" \
  --source-repo "$BASELINE_CHECKOUT" --run "$NEW_EXTERNAL_RUN" \
  --fixture "$EXTERNAL_FIXTURE" --notes 7700 --pairs 3 \
  --tunnel "$APPROVED_TUNNEL_EXECUTABLE"
```

A later portable harness revision is not the frozen campaign harness.
Frozen `performance.py` SHA-256:
`e4ff07c6cfc15f7a164d9e3c6881b1541d365871ad300a65386f3ccb8e0807ce`.
Frozen `performance.mjs` SHA-256:
`01cb1bd0a720986f40bb973259be5d3a55a50d76d25958721d866b1db30987ad`.
The six-file snapshot and its complete checksum manifest remain outside the
repository with the synthetic fixture and raw evidence.

## Every scheduled sample

Upload span is the time between the first and last of 7,700 completed pushes.
Throughput is `7699 * 1000 / upload_span_ms`; it excludes account setup and
other time before the first push. Sync now is a later full-vault drain, not
part of that span. Failure rows stay in the scheduled sample count.

| Sample | Window | Completed pushes | Upload span | Notes/s | Sync now | Minimized duration |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | Shown | 7,700 | 247.864 s | 31.061 | 3.345 s | — |
| 2 | Minimized | 7,700 | 264.411 s | 29.118 | 3.392 s | 604.926 s |
| 3 | Shown | 7,700 | 248.954 s | 30.925 | 3.368 s | — |
| 4 | Minimized | 7,700 | 261.662 s | 29.423 | 3.466 s | 605.318 s |
| 5 | Shown requested | No measurement | — | — | — | — |
| 6 | Minimized | 7,700 | 257.232 s | 29.930 | 3.394 s | 604.903 s |

The complete pairs' minimized/shown throughput ratios are **0.937419**
(samples 2/1) and **0.951434** (4/3). Their Sync now duration ratios are
1.014051 and 1.029097. Sample 6 has no measured shown partner; it is not
paired with a different attempt. Both pairs meet the [pre-run thresholds](https://github.com/snaraj/obsync/issues/283#issuecomment-5957065988):
minimized throughput at least 0.8 times shown and Sync now duration at most
1.2 times shown. They do not establish the required three-pair comparison,
proven idle conditions or restoration on idle, cancel, error and unload.

### Seventh-thousand rate and bookkeeping saves

Each thousand rate uses 1,000 intervals between recorded completed pushes:
`1000000 / (pushed[start + 1000] - pushed[start])`, at starts 0 and 6,000.
Saves count completed `saveData` calls from account-setup start through the
first observed 7,700-push idle state, divided by 77 for the per-100 figure.
They do not measure physical disk-write bytes or serialization time.

| Sample | First thousand notes/s | Seventh thousand notes/s | Seventh / first | Saves in first-sync window | Saves / 100 notes |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 29.732 | 31.183 | 1.048801 | 243 | 3.155844 |
| 2 | 28.305 | 30.487 | 1.077101 | 254 | 3.298701 |
| 3 | 31.554 | 30.836 | 0.977243 | 246 | 3.194805 |
| 4 | 29.847 | 26.976 | 0.903804 | 252 | 3.272727 |
| 5 | — | — | — | — | — |
| 6 | 28.293 | 29.354 | 1.037514 | 249 | 3.233766 |

All five measured seventh/first ratios fall within 0.90–1.10. The campaign
records the missing rate metric for these samples. It did not inject a crash
between the server answer and state persistence, independently verify stable
file identity after restart, or measure rewritten bytes, serialization time
and editor responsiveness required by #274's follow-up. It supplies no new
crash-recovery acceptance.

## Load and failures

The coordinator reserved a quiet work window, but the machine was not proven
idle. At each sample's first recorded CPU snapshot, idle percentages were
23.71, 32.60, 21.65, 17.10, 35.94 and 28.15 respectively. The snapshots and
start/end load averages are retained. They neither isolate the source of
load nor establish a causal explanation for the rates or failures. This
campaign must not be compared as a proven idle baseline against a loaded run.

Sample 5 completed initialization, measurement preparation and native setup.
Its initial measurement evaluation then refused or timed out; there is no
`window.json`, progress series or performance result. The sanitized failure
record omitted the safe window/measurement fields needed to distinguish the
cause. Its whole attempt lasted 25.273 s including setup and teardown; that
is not an upload measurement. Cause: **UNKNOWN**. The failed sample was kept
and the remaining scheduled sample ran; it was not replaced by a retry.

## Follow-up calibration and diagnostic boundary

After freezing that campaign, the measurement harness was changed to save
safe window fields before evaluating the window-state guard. A separate
three-attempt, 20-note shown-window calibration produced:

| Attempt | Observed result |
| --- | --- |
| 1 | Measurement present; shown, not minimized; zero recorded window mismatches; setup started; 20 pushes completed |
| 2 | Same observed control result; 20 pushes completed |
| 3 | Failed native phrase-confirmation deadline during setup, before a measurement result |

Those two successful controls do not explain sample 5 or replace its missing
measurement. The third calibration failure is a different observed stage;
its underlying cause is also unresolved.

A subsequent private setup diagnostic added safe booleans/counts for owned
windows and console-summary counts to the harness source. It did not print
phrase words, pairing codes, credentials or arbitrary exception text. Three
scheduled diagnostic attempts failed at launcher readiness parsing with
`JSONDecodeError`; their teardown receipts record sandbox refusal before
manifest creation or process launch. One isolated launcher check had the
same pre-launch boundary. All four report zero created processes and no
runtime. They provide no app diagnostic result and no evidence of a product
setup failure. Source addition is distinct from an executed diagnostic.

## Retention and teardown

All six performance attempts and all three calibration attempts have teardown
receipts with zero owned process groups, zero holders and no runtime directory.
The four pre-launch diagnostic receipts also report no runtime; directory
absence was checked again while preparing this record. Raw metrics, failures,
source snapshots and sanitized receipts remain outside the product repository.

Result-file SHA-256 references:

- Six-sample campaign: `397acc6a61170c79055f8a9303395a47fa8099eb68f5496c8f4660ca725b85e2`.
- Three-attempt calibration: `b3b7105db47cadc5dc3794282fa62151ce54aec8bef03d8c4e05d022b932aabb`.
- Three-attempt setup diagnostic: `72715c2e7f4bf6cf943ddb9be42e3e57867d88bbf2168d425c6abfbe9d71c00b`.

Phone behavior, concurrent typing, energy, peak RSS, network bytes, complete
idle CPU/wakeup distributions, independent peer readback and the final
candidate's before/after comparison were not established by this campaign.
