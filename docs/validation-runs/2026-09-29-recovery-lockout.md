# Recovery key hold, warning and operator reset, 2026-09-29

A recovery key registered recently no longer unlocks revoking an account's
last active device: the server holds that device for seven days after the key
is registered. A device whose own registration meets a different key says so
in a security notice and at the top of Show sync status and of its settings,
until its own key is registered. Whoever runs the server can clear the key
with `obsyncd recovery reset plan|apply`, with the server stopped. This is an
author implementation record, not an independent security verdict; the
adversarial run against the composed head belongs to its security review.

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

## Automated evidence

Full plugin suite, Rust workspace suite, `cargo fmt --check`, `cargo clippy
--all-targets -- -D warnings` and the contract suites passed at the lane head.
All 34 server probes in `scripts/validation/account_recovery_mutations.py`
compiled and were killed, including one #142 probe whose replacement text no
longer compiled and was restated. The plugin mutants M3600 to M3615 are
reproducible individually with `plugin/test/mutants/run.sh`.
