# One disposable desktop/server/mobile transport session

The wrapper owns one native Mac Obsidian A, one real candidate server, a private
profile/vault, and one loopback TLS/recorder process. It neither sets up an
account nor operates UI. Its child does the native setup and journeys.

```sh
python3 -B scripts/validation/mobile-session.py \
  --config "$PRIVATE_CONFIG" --run "$FRESH_EXTERNAL_RUN" \
  --child "$NODE" "$SETUP_AND_JOURNEY_DRIVER" other-arguments
```

The absent run needs an existing real parent outside the repository, 20 GiB
free, and no symlink aliases. Configuration is an owned 0600 JSON file:

```json
{
  "schema": 1,
  "source": "/absolute/clean/candidate",
  "sourceHead": "40 lowercase hex characters",
  "serverBinary": "/absolute/candidate/obsyncd",
  "serverSha256": "64 lowercase hex characters",
  "pluginHashes": {"main.js": "sha256", "manifest.json": "sha256", "styles.css": "sha256"},
  "node": "/absolute/pinned/node",
  "nodeSha256": "sha256",
  "obsidianExecutable": "/absolute/Obsidian.app/Contents/MacOS/Obsidian",
  "obsidianSha256": "sha256",
  "obsidianAsar": "/absolute/Obsidian.app/Contents/Resources/app.asar",
  "obsidianAsarSha256": "sha256",
  "tlsScript": "/absolute/driver/scripts/validation/mobile-tls.mjs",
  "tlsScriptSha256": "sha256",
  "observerSha256": "sha256",
  "seconds": 14400,
  "tlsPort": 18473
}
```

The observer is fixed to `source/scripts/ci/observer.mjs`; plugins come from
`source/plugin/dist`. All pins are required, including app.asar so the Electron
executable alone cannot stand in for application JS provenance. Acquisition
and official publisher authenticity remain the caller's responsibility.

The one-day synthetic localhost certificate has SKI and AKI, strict Python TLS
must accept localhost and reject the IP hostname, and every owned listener is
independently checked at 127.0.0.1. Desktop A uses the recorder's loopback HTTP;
Android uses `https://localhost:tlsPort` through its separately owned reverse.
No public tunnel, host trust installation, mock keychain or TLS bypass exists.

`lab.json` matches the desktop guard's format1 schema, including exact source,
three copied plugin hashes, server hash, A profile/vault/CDP port, process
argv/identities and the owner `holder`. `private/tls-binding.json` binds the
actual TLS PID, argv, script digest, recorder/upstream/TLS ports and loopback.
The child receives `OBSYNC_MOBILE_RUN` and may use those private records.
READY means provisioning only; `productAcceptance` remains NOT_ASSERTED.

For a native app restart, atomically replace the private request with:

```json
{"schema":1,"requestId":"restart-1","device":"A"}
```

Use `private/restart.json`; await the matching `private/restart-result.json`.
The UI driver must first request ordinary Quit. The owner verifies a natural
zero exit, then stops any remaining members of its retained A process group
before reaping the leader. It restarts the same private profile and proves
fresh CDP readiness before publishing the new PID manifest/result. A forced
termination cannot count as an ordinary restart. Nothing clears the vault or
enrollment. The separate fixed B/C/D recovery provision operation is described
in [MOBILE-RECOVERY.md](MOBILE-RECOVERY.md).

After all native witnesses and metadata are collected and Android cleanup
passes, request ordinary Quit of the final desktop (A for core, C for full).
Submit `private/close-transport.json` with `schema:1`, a fresh `requestId`, and
`protocol:"NATURAL_EOF_90S"`. The wrapper requires a natural zero desktop exit
and absence of live group members, then allows up to 70 seconds for outstanding
recorded responses to reach EOF. The child awaits the matching result for up
to 90 seconds. These are terminal shutdown budgets, not journey deadlines.
Future connections are expected to refuse, and normal bound desktop helpers
must no longer run. Recorder exit must be zero, completion
must be nonempty/error-free, and the entire owned transport group must be gone.
`evidence/transport-close.json` retains bounded EOF counts and original failure
enums; `evidence/transport-terminal.json` records successful natural shutdown.
The wrapper also writes `evidence/traffic-complete.json` and
`evidence/traffic-manifest.json`; the latter contains only source/observer
hashes and each closed capture's filename, size and SHA256. Raw bytes stay in
`private/traffic` until final cleanup.

The child now runs the actual candidate observer and planted controls using
its already-collected private witnesses, writes sanitized evidence JSON, and
writes `private/scan-result.json`:

```json
{"schema":1,"result":"PASS","sourceHead":"exact head","observerSha256":"exact hash","captureManifestSha256":"SHA256 of evidence/traffic-manifest.json","receipts":["evidence/native-confidentiality.json","evidence/native-confidentiality-controls.json"]}
```

The wrapper requires both fixed receipts with matching PASS/source/capture
bindings, nonempty coverage, zero hits/errors and successful planted controls.
These are structural admission checks of native-produced evidence. It writes their hashes to `evidence/scan-manifest.json`, and then accepts a
zero child exit as session-lifecycle PASS. Full native acceptance still belongs
to the child's complete journey criteria and separate acceptance record.

On all outcomes, owned leaders remain unreaped until their process groups are
stopped. Profile, vault, server data, certificates, credentials and raw traffic
are removed only after every owned group is absent. Startup failures preserve
bounded redacted diagnostics; after the child begins it must write sanitized
phase failures itself. `peer-result.json` records outcome, failure, budget,
cleanup and residue. Missing cleanup proof preserves ownership state and fails.
The caller must independently confirm the controller exited.
Validated synthetic note/map/chunk ciphertext samples are retained under
`evidence/native-ciphertext-{before,access,rotated}.json`, bound by the capture
receipt to the original bytes and candidate source. No roots, backups, API
credentials, whole server journal or raw HTTP are retained. After cleanup the
whole-traffic confidentiality scan and key-based opening cannot be reproduced
from the retained connection completion/count/hash receipts alone.
