# Linux native rehearsal

Run inside a disposable GNOME desktop VM as its ordinary user. Install the
verified official Obsidian build, the repository's pinned Node, GNOME Keyring
and D-Bus; use the distribution's app-specific sandbox policy. Keep at least
20 GiB free. This helper uses software rendering and retains the sandbox.
It starts a separate GNOME login keyring and session bus for each fresh profile.
HOME and all four XDG storage roots stay inside that profile; inherited D-Bus,
keyring and session-wrapper controls are discarded before starting its session.
Verify this boundary with `python3 -B -m unittest discover -s
experiments/sync-117/linux-native -p test_environment.py`.

```sh
python3 -B experiments/sync-117/linux-native/run.py \
  --source "$SOURCE" \
  --harness "$DRIVER/experiments/sync-117/harness/scripts/validation/lab" \
  --run "$FRESH_EXTERNAL_RUN" --binary "$SERVER_BINARY" \
  --plugin "$PLUGIN_DIST" --obsidian "$OBSIDIAN_BINARY" --cotype
```

The controller performs native setup, pairing, optional concurrent typing,
bidirectional byte and file-identity checks, settings captures, native window
closure, explicit vault reopening and another transfer. Custody checks require
encrypted `gnome_libsecret` storage and equal secret/metadata revisions before
and after restart; no credential value leaves the renderer. Inspect the PNGs
yourself. Loopback HTTP does not establish trusted TLS or cross-device latency.
Typing latency starts at the last completed native insertion, before the final
cadence sleep. Earlier receipts used the end of that sleep; their retained
timelines allow the difference to be computed without changing those receipts.

Require `linux-workflow.json`, `teardown.json` and `final-cleanup.json` to pass.
The controller reaps its own launcher and removes accounts, profiles and private
logs. A failed cleanup preserves fixtures and fails the workflow; inspect exact
owned identities before retrying `down` and `finalize.py`. Remove the disposable
VM after exporting only reduced evidence. Never substitute forced whole-session
termination for native app closure: the former can interrupt host secret-store
persistence and trigger the plugin's credential-revision refusal.
