# Physical phone acceptance and fixture lifecycle

These are maintained application test recipes. A native device journey is the
acceptance evidence; CI and launch checks cannot substitute for it. Run the
same journeys against the baseline and candidate before claiming improvement.
This experimental tooling remains outside the shipping artifact.

The launcher refusals have a repeatable mutation check:
`phone-mutations.py --source SOURCE --preflight PREFLIGHT --receipt NEW_JSON`.
It temporarily changes only its sibling launcher files and restores them;
run it from an idle, task-owned checkout. Native launch is intercepted during
mutations. This proves the refusal tests, not phone acceptance.

## Start from a new session

Set `SOURCE` to a clean, built candidate checkout, `PREFLIGHT` to a new external
directory, and `RUN` to another new external directory. Use the repository's
pinned build tools. The manifest version must match `SOURCE/VERSION`; the
synthetic vault name is derived from that version. No personal vault is copied.

```sh
python3 -B experiments/sync-117/phone-preflight.py --source "$SOURCE" --run "$PREFLIGHT"
OBSYNC_LAB_SOURCE="$SOURCE" OBSYNC_PHONE_PREFLIGHT="$PREFLIGHT" \
  python3 -B -m unittest discover -s experiments/sync-117 -p test_phone_preflight.py
python3 -B experiments/sync-117/phone-session.py --source "$SOURCE" \
  --preflight "$PREFLIGHT" --run "$RUN" --local-control-only
```

The last command exercises the actual desktop app: fresh account setup,
settings, pairing-code generation and regeneration, then verified teardown.
It opens no public relay. It does not test the phone, real desktop key custody,
or production installation. Desktop profiles use a mock keychain.

Before a phone attempt, prove native phone control and ordinary text entry.
Resolve any required enrollment approval before starting a timed exposure.
A working screenshot does not prove that keystrokes arrive intact. Read back
input on screen; keep pairing/recovery values out of captures and logs.

With explicit authorization for disposable credentials and metadata through
the relay, use a fresh `RUN` and omit `--local-control-only`. Keep the foreground
controller alive. It initializes the account locally, checks normal HTTPS trust,
serves only one synthetic ZIP at a random path, and expires both accountless
relays after one hour. This is an optional transport rehearsal, not private-path
or Cloudflare account/billing acceptance. Never infer exposure permission from
this recipe. No production server, provider account or DNS setting is changed.

The private download URL is in `RUN/private/download-url.txt`. Install only
the named synthetic vault. Check the enabled plugin version on the phone;
server-side ZIP equality alone is not installed-byte verification. Stop ZIP
delivery immediately after extraction by writing `{}` to
`RUN/private/stop-download.json` and verify `download-stopped.json`.

## Observe the user experience

Use `phone-pair.mjs TOOLING RUN generate|regenerate|match|approve|status`, where
`TOOLING` is `experiments/sync-117/harness`. Approval requires an independently
observed phone comparison in private `runtime/phone-observed-match.txt`; it
must match the current desktop prompt. Never copy the desktop value into that
file as if it came from the phone. Codes expire; regenerate instead of reusing.

Record each journey separately as `PASS`, `FAIL`, `BLOCKED` or `NOT_RUN`:

| Journey | Required observation |
| --- | --- |
| Pairing | Independently matching screens; approved device actually keeps its key |
| Each direction | Type through the native editor; receiving screen and independent desktop file bytes agree |
| Concurrent typing | Overlapping input on the same note; final buffers/bytes, conflicts, cursor disruption and time after last input |
| Background/reopen | Return to the app and edit both ways without setup or re-pairing |
| Connectivity recovery | Visible interruption, automatic resume, unchanged final bytes |
| User data control | Leave revokes this test device, forgets enrollment, and keeps local notes |

`phone-peer-note.mjs TOOLING RUN create` creates the desktop sentinel using native
input. `phone-cotype.mjs` documents its bounded prepare/type/observe commands
in source. Desktop observations remain incomplete until the phone screen is
independently checked. Do not report smooth typing from final-byte equality
alone. Preserve failures, time budgets and any manual intervention.

## End every attempt, including blocked attempts

Write `{}` to `RUN/private/stop-phone.json`, then wait for the controller to
exit. Require `phone-network-cleanup.json`, `teardown.json` and
`final-cleanup.json`: both relays absent, all owned process groups gone, runtime,
private logs/credentials and the live manifest removed. If cleanup fails,
preserve ownership metadata and retry that exact run; never kill by app name.

Close the phone's test vault and remove only its exact folder and downloaded
ZIP through the phone's recoverable file deletion. Verify both locations after
deletion. Close only task-created browser tabs when their identity is certain;
record uncertain tabs instead of closing unrelated ones. Do not empty Trash or
Recently Deleted. Phone cleanup is a separate observation, never inferred from
desktop teardown. Record any remaining resources as an unresolved result.

After all attempts using a preflight are resolved, verify copied binary/ZIP
hashes against `preflight.json`, ownership, and absence of open handles before
removing them. Remove owned build outputs when no active run needs them.
Keep recipes, sanitized receipts and inspected synthetic captures; never keep
test accounts, keys, URLs or raw secret screenshots for the next session.

## Durable run record

Keep one receipt directory per attempt, with source SHA, driver SHA/hashes,
artifact hashes, versions, platform classes, transport, start/end/deadline,
named journeys and budgets, visible observations, independent readbacks,
failure stage/reason, and teardown/absence evidence. Do not publish hostnames,
device identifiers, paths outside the synthetic fixture or credentials.

Keep acceptance and cleanup separate: `BLOCKED` with clean teardown is not a
passing device test. Missing evidence stays `NOT_RUN` or `UNKNOWN`. A later
success is a new attempt; it does not erase a failure. The next session reads
these receipts, revalidates current tooling, and starts with fresh fixtures.
