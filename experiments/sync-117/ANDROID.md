# Disposable Android acceptance

Use this alongside [the desktop/phone lifecycle](PHONE.md). This is native
Android-emulator evidence, never physical-phone acceptance. Keep each failed
attempt and start a fresh profile for its replacement.

Build a clean candidate with its pinned tools. Supply an independently verified
official Obsidian APK, its SHA-256, Android SDK and Java installation. Reuse
verified tool installations, not an old emulator profile or enrollment. The
launcher creates private Android homes, an isolated ADB server with no USB
device access, and one emulator. Nothing attaches to a personal Android device.

```sh
python3 -B experiments/sync-117/android-session.py --source "$SOURCE" \
  --run "$ANDROID_RUN" --sdk "$SDK" --java "$JAVA" \
  --apk "$APK" --apk-sha256 "$APK_SHA256" --gpu software --online
```

Keep this foreground controller alive. `android-ready.json` records the source,
APK hash, graphics mode and one-hour deadline. The default console port is
5584; choose another unused even port from 5554 through 5584 if necessary.
`--online` requires authorization for the chosen test transport. The software
renderer completed the recorded run after an earlier automatic-renderer
attempt hung in Obsidian and Android itself before plugin installation. That
observation is not a universal diagnosis or a performance comparison.

Prove native input before exposing a test server. In the fresh Obsidian app,
choose Create a vault, Continue without sync, a synthetic `Obsync-…` name,
Device storage, and Documents. Inspect each resulting screen, including the
normal Android file-access confirmation. Copy only the candidate plugin into
that named vault, verify the installed files against the candidate hashes, and
accept Obsidian's normal trust prompt for that synthetic vault.

For automation, read `sdk`, `adbPort` and `serial` from this run's `lab.json`.
Verify recorded process identities first. Set both `ADB_SERVER_SOCKET` to
`tcp:127.0.0.1:PORT` and `ANDROID_ADB_SERVER_PORT` to that port; pass the same
`-P PORT -s SERIAL` to ADB. Never use global device discovery. ADB `shell input`
and `exec-out screencap -p` can drive and inspect onboarding; capture no pairing
code, recovery phrase or private endpoint. The whole AVD disappears at teardown.

Start a fresh desktop peer with the separately authorized bounded TLS recipe
in `PHONE.md`. Stop its download relay immediately when using local emulator
installation. The journey driver takes the actual synthetic vault path; it
must be under `/storage/emulated/0/Documents/Obsync-…`.

```sh
node experiments/sync-117/android-journeys.mjs \
  experiments/sync-117/harness "$PEER_RUN" "$ANDROID_RUN" \
  preflight "$ANDROID_VAULT"
```

Run commands sequentially: `pair`, `both-directions`, `cotype`,
`background`, `restart`, `offline`, then `leave`.
Wait for each process to exit before starting the next. After a failed
`cotype`, `cotype-observe` can preserve the separator failure while checking
marker survival and independent bytes. It describes the original common-prefix
rule and is not the oracle for a repaired candidate. Do not turn that weaker
observation into a co-editing PASS.
Pair compares both renderers independently; secrets stay in process memory.
Phase timestamps distinguish a comparison deadline from later key persistence.
Keep a failed automatic attempt even if native manual approval subsequently
completes enrollment; record that intervention separately. Co-typing produces
separate text and capture receipts. A text PASS does not override a later
capture failure, and a CAPTURED receipt still requires opening the images.
Editor input uses trusted native events. Restart checks enrollment retention;
Leave checks server revocation, forgotten enrollment and exact local-note hashes.
Offline calibration uses the app's authenticated transport, not browser fetch.

Open every resulting PNG. Record visible behavior separately from assertions,
including clipped/scrolling text, cursor limits, failed deadlines and any manual
intervention. The driver repositions the cursor for each co-typing insertion,
so it cannot establish cursor stability. Timings are single bounded observations,
not a baseline/candidate speedup. Desktop mock keychain custody and emulator
custody have different scopes.

End both controllers on success or failure:

```sh
printf '{}\n' > "$ANDROID_RUN/private/stop.json"
printf '{}\n' > "$PEER_RUN/private/stop-phone.json"
```

Require both controller exits, zero owned process groups, relay absence, and
absence of `runtime`, `private`, live manifests and copied peer inputs. Preserve
ownership records if teardown fails. Remove hash-verified copied preflight
artifacts and owned build outputs after checking open handles. Keep only the
recipe, sanitized receipts and inspected synthetic captures. Never remove
unattributed SDK caches, other agents' worktrees or historical fixtures by a
broad pattern.

The first native campaign exercised this driver while it was developed;
per-command driver hashes were not captured for those earlier invocations.
Subsequent receipts include the driver hash. The final driver is experimental
tooling, with no claim of a completed security-guard mutation audit or release
readiness.
