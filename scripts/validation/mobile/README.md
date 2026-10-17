# Native Android acceptance: desktop controls

`desktop.mjs` drives the task-owned macOS Obsidian peer from a lab-format-1
`lab.json`. It reuses the existing guarded CDP transport, operates ordinary
plugin controls, and records reduced JSON receipts. It does not launch or
restart applications. The supervising journey owns lifecycle, Android consent,
cross-device byte comparison, and cleanup. Emulator evidence does not establish
physical phone acceptance or hardware-backed Android storage.

```sh
node scripts/validation/mobile/desktop.mjs "$DESKTOP_RUN" status --source "$CANDIDATE"
node scripts/validation/mobile/desktop.mjs "$DESKTOP_RUN" pair-generate --source "$CANDIDATE"
node scripts/validation/mobile/desktop.mjs "$DESKTOP_RUN" pair-match --source "$CANDIDATE" \
  --android-run "$ANDROID_RUN" --observation "$ANDROID_RUN/private/android-claimant-observation.json"
node scripts/validation/mobile/desktop.mjs "$DESKTOP_RUN" pair-approve --source "$CANDIDATE" \
  --android-run "$ANDROID_RUN" --observation "$ANDROID_RUN/private/android-claimant-observation.json"
```

The candidate checkout must remain clean and at the manifest source head. The
helper verifies recorded process identities, the exact owned profile/vault,
loopback endpoint, built artifact hashes, and installed/source plugin hashes.
When the lab URL points at its task recording proxy, the fixed private
`tls-binding.json` must bind its schema-1 PID, identity, argv, script SHA-256,
upstream port, recorder port, TLS port and loopback address. The helper checks
the current process and both exact loopback listeners. It never accepts an
unbound second loopback service or adds unknown process names to the lab.
The parent must independently establish the clean build's provenance and the
official application installation. It must integrate `android-session.py` as a
sibling of `mobile/`; pairing calls its guarded, scoped `adb` subcommand to read
only the owned `md.obsidian` PID. No global device or profile discovery occurs.

Private inputs and outputs are exclusive mode-0600 files under
`DESKTOP_RUN/private/desktop/` in a mode-0700 directory:

| File | Producer and use |
| --- | --- |
| `phone-pair-code.txt` | `pair-generate`; transfer privately to Android's ordinary pairing field |
| `phone-creator-match.txt` | `pair-match`; creator observation, never a claimant witness |
| `pair-approval-used.json` | `pair-approve`; prevents repeat approval using that invitation |
| `note-LABEL.json` | `note LABEL`; synthetic `{path,text,sha256}` expected bytes for later `read-note LABEL` |
| `phone-old-recovery-backup.txt` | `save-old`; complete marked current recovery backup read from UI |
| `phone-new-recovery-backup.txt` | `rotate-stage` or `save-new`; complete distinct new backup read from UI |
| `phone-transition-PHASE-checkpoint.json` | prepare/seed/status; private hash of persisted transition identity |

The supervising driver may stage an Android-created synthetic note expectation
in the same private `note-LABEL.json` schema. Paths must be one bounded Markdown
filename; text is bounded to 16 KiB. `read-note` first waits for exact independent
disk bytes, then uses the native quick switcher to open the unique result and
checks editor bytes and disk bytes again. It never creates the destination.

Android's independent witness must be exactly
`ANDROID_RUN/private/android-claimant-observation.json` with
`{code, observedAt, appPid}`. `observedAt` is UTC ISO time or epoch milliseconds.
The witness must follow invitation creation, be at most 60 seconds old, match
the current Android PID, and match exactly one visible creator code. Missing,
duplicate, mismatched, stale, future, or reused witnesses refuse approval.
Neither SAS nor invitation appears in a receipt. Approval alone is not consent
or claimant key-retention evidence; the Android driver must observe those.

For a subsequent fresh pairing on the same disposable account, the supervisor
must archive the three owned pairing files before `pair-generate`. This is a
new invitation only; never clear native custody or reset the account.

Additional commands preserve the finite desktop contract:

| Command | Observation/action |
| --- | --- |
| `status` | Reduced status, suite, phase, history availability; pending checkpoint comparison |
| `snapshot` | Bounded authenticated device-list read and private custody/state fingerprint |
| `note LABEL` | New note shortcut, native title and text input, independent disk readback |
| `save-old` | Show the confirmed Recovery backup and privately retain it |
| `inspect-cancel` | Observe both revoke choices, cancel, require identical before/after authenticated snapshot |
| `block-access` | Sole active other device's Revoke → Block access; require authenticated revoked state |
| `rotate-stage` | Sole active other device's Revoke → Rotate key → Stage encryption transition; save new backup |
| `save-new` | Save the currently displayed new backup if not already saved |
| `prepare` | Fill saved complete new backup and owned setup token, press Prepare transition; require prepared |
| `resume` | Recovery backup → Resume encryption transition |
| `seed` | Re-encrypt current versions; require commit_unknown |
| `commit` | Confirm new backup and owned token, press Commit new key; require active |
| `close-dialog` | Close only a sole Recovery backup or Encryption upgrade and key rotation dialog |
| `quit` | Request normal owned application quit; supervisor must prove old process/group absence |

Stop after the first failure and inspect the current phase before retrying.
`prepare` and `seed` retain checkpoint hashes; after full termination/relaunch,
`status` must report `pendingCheckpointMatches:true` before resuming. The
supervisor separately proves stopped ordinary sync, generation change,
revoked-phone refusal, restart persistence and direct old-key ciphertext
rejection. A desktop phase receipt is not a complete journey verdict.

Offline guards:

```sh
node --test scripts/validation/mobile/desktop-guard.test.mjs
node scripts/validation/mobile/desktop-guard-mutations.mjs
```

The tests use synthetic codes and disposable filesystem fixtures. They never
connect to an application or replace native storage. CDP is the existing lab
transport relocated to `mobile/cdp.mjs`; its unused screenshot and clipboard
helpers are not part of this driver's acceptance path.
