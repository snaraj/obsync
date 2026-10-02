# Recovery key hold, warning and operator reset, 2026-09-29

A recovery key registered recently no longer unlocks revoking an account's
last active device: the server holds that device for seven days after the key
is registered. A device whose own registration meets a different key says so
in a security notice and at the top of Show sync status and of its settings,
until its own key is registered. Whoever runs the server can clear the key
with `obsyncd recovery reset plan|apply`, with the server stopped. The reset
also rotates the setup token and arms one re-enrolment: the new token and a
restored vault key then re-enrol the owner on that account, while an account
with no key that nobody has reset still refuses. Nothing a device holds on its
own can arm or perform it. This is an author implementation
record, not an independent security verdict; the adversarial run against the
composed head belongs to its security review.

## Builds

| | Commit | `obsyncd` SHA-256 | `main.js` SHA-256 |
| --- | --- | --- | --- |
| Before | `afbf7e7` (1.1.4) | `028611b6267b30f047c97efe50a5a66335675d7149f1d45f0a28a8f8c6b00cb7` | `19d3202059551d72f53f3f3a0deaf3eb159971604c1d9fb481f756ac56c28d0c` |
| After, runs 1 to 7 | the lane's working tree before its final wording | `539db65eac773fce856946b51a5274f5f7ed5807d3ab23fde0b8bb547b5a86e6` | `9804130507646186aaf7a8982cb40f186a034a24cc30673abdda0bd5d2cc114b` |
| After, run 8 | the lane head | `f3302e3b7f91eddd405e087d1568b09ef183a46bfdabd7c06396702b5a338aed` | `a008a86a17042115808029264bdb57adbda709811908daf83eb413c7d9455a1f` |

The server differs between the two "after" builds only in the wording
`obsyncd recovery reset` prints; the plugin differs in where the settings tab
shows the warning (run 8). Every run used a disposable loopback server, two
isolated desktop Obsidian 1.13.4 profiles on macOS with synthetic vaults, and
real clicks through the plugin's own dialogs. No note content, setup token,
pairing code or recovery word was recorded.

## Runs

1. **Setup registers the key with its time.** First setup on device A enrolled
   the account with its recovery key in the setup frame; the device's first
   start registered the same key again (`204`, nothing changed).
2. **The only device is held.** Leave on A, the account's only active device,
   within the hold: the dialog said, in the plugin's words, that the only
   device syncing the vault is kept until the key is seven days old, and
   offered Cancel and Leave on this device only. The server logged
   `event=device_revoke_refused decision=refused reason=recovery_too_new
   recovery_age_ms=74221 budget_ms=604800000` and answered `409
   recovery_too_new` in 13 ms. After Cancel, A was still paired and idle.
3. **Every other revoke is unchanged.** Device B was paired from A and received
   A's note; Leave on B (not the last device) revoked it at once (`204`,
   `event=device_revoked`).
4. **Recovery with the vault's own key.** B, left with its vault key, used Set
   up or recover with the setup token: `event=account_recovered`, a new active
   device on the same account, idle.
5. **The operator reset.** With the server running, `obsyncd recovery reset
   plan` refused with `reason=journal_locked`, exit 1, and changed nothing.
   With the server stopped: `plan` stated the key's registration time and the
   end of its hold and changed nothing (exit 0); `plan --output json` printed
   one object with `state` `planned` and `change` `clear`; `apply` cleared the
   key (`decision=cleared`, 20 ms, exit 0); a second `apply --output json`
   answered `change` `none`; a following `plan` said no key is registered.
   After the server started again, A's next start registered its key again
   (`event=recovery_registered`), with a new time. Neither step printed or
   logged the key.
6. **Journal compatibility.** On the journal this build wrote, the 1.1.4
   binary's `check` verified 29 frames with none failed and 1.1.4 served it
   (ready in 137 ms, both 1.1.5 devices unaffected); the 1.1.5 `check`
   afterwards verified 32 frames with none failed. The 1.1.4 stop wrote no
   snapshot (`decision=not_due`), so the documented case of a 1.1.4 snapshot
   dropping the registration time was not reached live.
7. **A 1.1.4 plugin meets the hold.** With the 1.1.4 plugin on A, now the only
   device, Leave showed "The server refused to revoke this device:" followed
   by the server's own sentence about the seven days, and offered Leave on
   this device only.
8. **The warning, on a real device.** The server's `409 recovery_mismatch`
   answer was simulated inside A's page (the request never reached the
   server, whose key was untouched). A showed the security notice, which stays
   until dismissed; the same text first in Show sync status and in a Security
   group under Get started in its settings, each with Open the guide; and
   `recovery decision=refused reason=recovery_mismatch warning=shown` in its
   log. With the simulation removed, the next registration reached the real
   server, succeeded, and the warning left Show sync status, the settings tab
   and the screen.

## Whole-app sweep

- Run 8 on the earlier build showed two defects, both fixed at the lane head
  and checked again: the warning's settings row, when hidden, left a stray
  divider above Server URL that 1.1.4 does not draw (the warning now has a
  group of its own); and the sticky notice stayed on screen after the warning
  had cleared (it is now taken down with the warning).
- While the warning stands, the status item stays the check mark, because sync
  itself is healthy; only the notice, Show sync status and the settings tab
  say it.
- Each Leave dialog, the settings tab and Show sync status carried no stale or
  contradictory text; the only notices were the ones described above.
- The plugin's console warnings during run 8 were exactly the refusals the
  run asked for: the simulated `409 recovery_mismatch` with its
  `warning=shown` line, and the held Leave's `409 recovery_too_new` with its
  `unpair decision=refused reason=recovery_too_new` line. No error line.

## Re-enrolment after an operator reset

An account with no recovery key answers `409 recovery_unavailable` to the setup
token, whatever proof comes with it, until the operator resets its recovery.
`obsyncd recovery reset apply` clears any key, rotates the setup token, and
arms one re-enrolment. The new token with a proof then registers the key that
proof derives, timed so the seven-day hold begins again, and enrols the device,
as an ordinary recovery does otherwise. The server cannot check that proof, so
the authority is the offline reset and the token it rotated; the proof only
chooses the key. The first key registered after the reset spends the arm,
whoever registers it. Nothing a device holds on its own can arm or perform it.

Both runs used a fresh disposable loopback server on the build below, isolated
Obsidian 1.13.4 profiles each under its own HOME on macOS, synthetic vaults and
real clicks through the plugin's own dialogs. No key, setup token, pairing code
or note content was recorded; the token moved only through 0600 files.

| | `obsyncd` SHA-256 | `main.js` SHA-256 |
| --- | --- | --- |
| Lane head | `e78d8d7a7ff8371b33b80c9e7bd5f9b5337db539adb3ea2af37de919304bb406` | `b549e1e05876f8bd856c69eb000fa632eac3575f07fc548072a34f26525b1bd2` |

The negative run used an earlier build of this work that differed only in the
wording of `recovery reset` and of one settings description, both changed
after that run's sweep.

1. **An account never reset refuses.** An account was set up the way a client
   before 1.1.3 did, with no recovery key (`201`). The setup token with a
   well-formed proof then answered `409 recovery_unavailable` over the wire.
   A third profile, C, used Set up or recover twice: its first attempt made a
   new key and sent no proof (`409 already_set_up`, told to pair); its second
   sent that key's proof (`409 recovery_unavailable`), stayed unpaired, and
   showed "This server holds a vault with no recovery key registered, so these
   words cannot re-enrol this device on their own", naming pairing and the
   operator's reset. The log held no `account_recovered`, `recovery_registered`
   or `recovery_reestablished` line, and the offline `recovery reset plan`
   afterwards said no recovery key is registered.
2. **The reset rotates and arms.** On a fresh server, device A (the owner) set
   up with its key registered and wrote a note; device B (a device the owner
   does not recognise) paired from A. A then left the server on this device
   only, keeping its vault key, and B was stopped. With the server stopped,
   `recovery reset plan` stated all three effects and changed nothing;
   `recovery reset apply --output json` answered `change` `cleared`,
   `setup_token` `rotated`, `re_enrolment` `armed`, exit 0, and the token file
   was gone. The next start minted a token different from the one before.
3. **The old token is refused; the new one re-enrols once.** On A, Set up or
   recover with the token from before the reset showed "This server did not
   accept that setup token" and left A unpaired. With the new token, A
   re-enrolled in 2.4 s: `event=recovery_registered decision=registered`, one
   `event=recovery_reestablished decision=reestablished` line naming the
   account and the arm's time, then `event=account_recovered` for a new active
   device, idle and synced.
4. **The re-enrolled device is live, and B is revoked.** B, still active, came
   back and pushed the note it had written while A was unpaired, which A had
   never held; it reached A 14 ms later. From A, B was revoked
   (`event=device_revoked decision=revoked`, `by_device` the re-enrolled
   device). B then showed "This device was removed from your server. Your
   notes and vault key are safe here." with the attention status item, its
   local notes untouched. (B was first stopped before its push had left: the
   status item reads calm before a push starts, so the rig now waits on the
   note's file record instead.)

## Whole-app sweep (re-enrolment)

- A: settings idle with no stale text; Show sync status named the re-enrolled
  device, the vault key present, two files tracked, and nothing recent.
- B: the removed-from-server status and the attention item, and nothing else.
- C: the refusal notice above, the setup token field empty after it.
- The Setup or recover description said recovery must have been registered
  before the last credential was lost, which the reset now contradicts; it now
  says the operator resets recovery first when the server has no key. The
  plan's sentence about arming was split in two. Both were changed after the
  negative run and are in the lane head above.
- A pairing dialog stayed open on A after the approval (Copy code and Copy link,
  no code shown) until the rig closed it; the screenshot guard refused to
  capture while it was open. Not investigated here.
- Each profile bound its own Obsidian CLI socket under its own HOME; teardown
  left no rig process, listener or state directory and found no setup token in
  any rig file.

## Automated evidence

At the lane head: the full plugin suite (1861 tests), the Rust workspace suite
(152 and 487 tests), `cargo fmt --check`, `cargo clippy --all-targets -- -D
warnings` and the contract suites (845 tests) passed. All 44 server probes in
`scripts/validation/account_recovery_mutations.py` compiled and were killed,
among them the ones that drop the arm check, leave the arm unspent after a
registration, skip the token's rotation, rotate before the journal lock or in
a plan, and lose the arm in a journal frame, a snapshot or its reading. The
plugin mutants M3600 to M3621 are reproducible individually with
`plugin/test/mutants/run.sh`.
