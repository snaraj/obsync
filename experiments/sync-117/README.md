# Native sync experiments

Measurement and harness source for #325. **Never merge or distribute this
branch.** Hooks preserve encryption, authentication, replay protection, integrity
and durable writes. They measure the baseline; they deliver no shipping speed
improvement or character-editing engine.

Physical-device setup, observation, failure records and removal are maintained
in [the phone lifecycle guide](PHONE.md). Those launchers bind each new run to
an explicit candidate version and artifact hashes; phone acceptance stays
separate from a successful local control or teardown.

[The Android recipe](ANDROID.md) owns a fresh emulator, native pairing and
editor journeys, independent file checks and complete fixture teardown. It
keeps emulator results distinct from physical-phone acceptance.

Build with pinned repository tools. `SOURCE` explicitly selects the built
checkout (`target/release/obsyncd`, `plugin/dist`); `RUN` must be a fresh private
directory outside every checkout. An installed macOS Obsidian app and at least
20 GiB free space are required by the desktop launcher.

```sh
python3 experiments/sync-117/test.py desktop --source "$SOURCE" --run "$RUN"
```

`desktop` owns two native profiles, setup/pairing, typed transfers, independent
disk readback, restart, screenshots and teardown. `cotype` performs three
concurrent typing cases. `throttle` checks minimized idle, cancel, unload, outage
and automatic recovery with exact bytes in both vaults. `editor` runs 80 paired baseline/early-save cases using
public `MarkdownView.save()` after 300 ms; ordinary disk publication and receiver
editing holds remain. It does not publish an unsaved buffer or prove crash
durability. `stage` requires this branch's instrumented build. `performance`
uses three alternating shown/minimized 7,700-note pairs, each minimized sample
lasting ten minutes. Run comparisons without task builds, VMs or stress beside
them. Unrelated host activity still needs separate observation.

`boundaries` types at both ends of one line, before its first character, and
with leading word separators. It keeps each cursor where native input leaves
it, records both editor buffers and independent files, and refuses missing
characters, collapsed separators or conflict copies. Use the same fresh-run
command above with `boundaries` in place of `desktop`. Failed scenarios also
remove their owned processes, accounts and profiles after absence proof;
reduced failure evidence remains for the next session.

Inspect PNGs and record visual observations. Automatic desktop scenarios remove
resolved profiles, account keys, private logs and manifests after process absence
proof. Require `teardown.json`, `final-cleanup.json`, and `workflow.json`.
Performance removes a generated fixture; an explicit pre-existing `--fixture`
is caller-owned and preserved. Keep reduced failures. A mock keychain and
loopback HTTP prove neither personal key custody nor TLS/mobile performance.

For interactive work use `up`, keep the holder alive, then `down`. After the
run is resolved, discard remaining private diagnostics with:

```sh
OBSYNC_LAB_SOURCE="$SOURCE" python3 -B \
  experiments/sync-117/harness/scripts/validation/lab/finalize.py "$RUN"
```

Cleanup refuses uncertain identities, live groups or linked fixture directories.
The focused cleanup checks are `test_cleanup.py` in the same helper directory.
Never kill by app name or delete by a broad pattern.

## Component stages on macOS ARM64 or Linux ARM64

The original campaign source and its four exact hashes are preserved in
`provenance/`; the maintained hooks have the explicitly documented changes.
Build the instrumented server for the selected hardware and the plugin's crypto
and chunker modules. Obtain pinned Node 26.10.0 and independently verify its
publisher-signed checksum. `component-prepare.py --help` lists all inputs. It
freezes them and generates a task-local certificate into a fresh
`/tmp/obsync-pi-lab-<16 lowercase hex>` directory; it installs nothing.

Run `python3 component-profile.py run` from that directory on the measurement
host. The client validates the task certificate and hostname. Three fresh
passes cover 128 small notes, a deterministic large file, and an unchanged
fixture reread/chunk/hash measurement. Same-process chunk download/decryption
and an independent output-file readback check uploaded content; stored manifest
discovery by a second client is not exercised. Native two-client tests remain
separate. Request, crypto and flush spans overlap; do not sum them into wall time.

The launcher has a 600-second wall budget, lower priority, and sampled abort
thresholds for child RSS, scratch size and free space. Its Python/TLS-proxy RSS
is outside the child measurement, and sampling permits transient overshoot.
Instrumentation overhead needs a matching uninstrumented comparison before
claiming an improvement.

Preserve reduced `evidence/` outside scratch. Require a successful teardown and
fresh absence proof for every recorded child group and launcher. Only then remove
the exact scratch directory, including inputs, certificates and private logs.
`component-profile.py cleanup` retries owned-child cleanup; it is not proof that
the launcher has exited. No fixture key or account may be retained for reuse.

`load319.py --source-repo SOURCE --run RUN --mode baseline|candidate --image IMAGE`
uses an immutable Node 26.10.0 image, four CPUs, 8 GiB, forty bounded workers,
original test deadlines and owned-container cleanup. Keep every failed result.

No personal vault, production credential or disabled protection is a fixture.
Private-path acceptance requires an authenticated mirror and trusted private
HTTPS. The separately authorized bounded relay rehearsal in `PHONE.md` does
not satisfy that private-path result. Keep raw logs, credentials and screenshots outside Git;
no runtime data or operational inventory belongs on this branch.
