# 2026-09-26 final 1.1.3 native phone acceptance

Author-operated validation using a disposable server and synthetic vaults.
The user's vaults were excluded. This record keeps final-candidate evidence
separate from the earlier device runs.

## Build and devices

- Product source: `0136ddac5741f3340deaa3cc879deb403a8f88ac`;
  subsequent author commits changed tests and documentation only.
- Plugin: 1.1.3, bundle SHA-256
  `ef030cab10b564982eb920d8781b9f8a7f5e01779395a2a1469e11553b4ddedb`.
  The desktop used the locally built bundle. The phone installed the same
  bundle from a verified archive through Files, then enabled it in Community
  plugins. This is manual candidate installation, not production installer
  or distribution evidence.
- Server: native 1.1.3 build from the same product source, with disposable
  journal/blob directories. Route: a temporary HTTPS tunnel to a loopback
  proxy and the real server, using normally trusted TLS. No certificate
  bypass or production deployment was involved.
- First desktop: physical MacBookPro18,4, macOS 27.0, Obsidian 1.13.7.
- Phone: physical iPhone through native iPhone Mirroring, Obsidian 1.13.7
  (observed in the native vault manager). Model and OS version were not
  recorded. Plugin 1.1.3 was observed in Community plugins and in the
  pairing claim.

## Pairing and initial content

The phone package contained exactly two synthetic notes and a disabled,
separate timestamp fixture. The native pairing claimant reported iOS,
plugin 1.1.3, the expected test vault, and two notes. Approval succeeded;
the short-lived invitation files were removed. Both native editors showed
the initial note content before input began.

The first locally built fixture was scoped to the two test vault names and
one synthetic note. Once enabled, it called Obsidian's `processFrontMatter`
on a one-second timer, including while idle. That differs from S89's
modify-triggered fixture; the effect on this run is recorded below. Neither
fixture modifies the obsync bundle.

## Native co-typing: pass

Both append carets were visually checked on separate lines of the same
note. Forty alternating native input events entered twenty desktop letters
and twenty phone digits, with a requested 500 ms delay between events and
no midpoint pause. Actual first-to-last input duration was **30.489 seconds**
(21:02:02.673–21:02:33.162 UTC); app switching accounts for the difference
from the requested delay.

Both native views subsequently showed the complete sequences in the main
note. A scoped desktop vault read and authenticated server read found one
head, no new copies, and exactly the original two files. The saved desktop
note SHA-256 was
`5a06445b17578592c88cbcf69f5b35f19c8990cc1b3a0ee959f372f850c57b30`.
The phone content was observed visually; no phone filesystem hash is claimed.

Local receipts: `native-input-receipt.json` and
`acceptance-cotyping-initial.json`. The event log records every character
and timestamp. The final post-input screenshots initially showed each
device's own sequence while sync was still active; the later readbacks
above establish convergence, not an instantaneous-sync claim.

## Unconditional rewrite fixture: hold pass, S89 not established

Both native devices enabled the scoped one-second rewrite fixture. Twenty
native desktop characters were entered into the note body over **10.071
seconds** (21:06:06.770–21:06:16.841 UTC). All twenty remained in the desktop
main note. Both devices reported the shared pause, and one preservation
copy existed.

That copy's timestamp precedes the keyboard sequence. This run does not
establish whether the initial pause occurred before or during typing, or
claim that keyboard input triggered it.

The first hold measurement ran from 21:07:19.654 to 21:12:52.015 UTC:
**332.361 seconds**, zero version POSTs across the disposable server, one
preservation copy, and the complete desktop body unchanged while its local
timestamp continued changing. The phone's local timestamp was also observed
changing during the window.

The final phone readback encountered a paused, then locked Mirroring session
requiring the user's authentication. Continuous phone activity for the complete
window is not established by that first measurement; it proves only the
server/desktop hold.

After the user's authentication, a second hold ran from 21:22:34.272 to
21:28:29.560 UTC: **355.288 seconds** and **zero version POSTs**. Both
fixtures remained enabled, the desktop retained all twenty characters, and
there was still one head and one preservation copy. The phone stayed
accessible throughout; repeated native observations showed its timestamp
advancing, including a readback after the end snapshot. This measures
continuing rewrites, not an exact one-second execution cadence. Receipts:
`acceptance-hold-active-start.json`, `acceptance-hold-active-end.json`, and
`hold-active-comparison.json`.

Both fixtures were then disabled and both devices resumed. The desktop
reached idle with one main head and one copy. The main note lacked the
twenty letters; the existing preservation copy contained the complete
pre-Resume snapshot, byte for byte (SHA-256
`0b3f96c33d066bdf6bc5759dfb2573e28f32b0fe10e4d5df937b9ce2cc8e99c9`).
No text loss was observed, but this is **not** the required all-characters-
in-the-main-note S89 result.

The timer had paused the desktop before typing started. Resume therefore
used its persisted background-writer role: keep that device's held text
beside the note and adopt the peer's main text. Independent inspection
confirmed this matches the existing background-side Resume regression.
The test must reproduce S89's typing-triggered sequence before this result
can justify either acceptance or a product repair.

## Corrected reactive fixture: first attempt interrupted

A new disposable phone vault installed the same obsync bundle with a fixture
that listens only to modifications of the new synthetic test note. Each
modification rearms a one-second debounce; enabling it on an idle note
starts no timer. It writes the current second through `processFrontMatter`,
matching the reported S89 trigger. The archive's local and HTTPS-download
SHA-256 matched:
`63c54b881c1dd95813136f3cab606777e33599ad3d1d94b24c19bd5a6738b4a9`.
The fixture was also checked for its idle behavior, path restriction,
debounce, reaction to its own modification, and timer cleanup.

The new native phone claimant reported iOS, plugin 1.1.3, and the expected
two-note test vault. Pairing was approved and its invitation files removed.
Both fixtures were enabled and both notes still showed the baseline
timestamp before input. The first phone registration had already left the
test server through the native Leave command.

Twenty desktop characters were entered over **9.984 seconds**. The first
post-input phone readback found Mirroring paused, then locked. Simultaneous
phone operation during that input is unproven, so this attempt is not an
S89 pass. The desktop retained all twenty characters with one head and no
new copy of this note. Its fixture was disabled. After renewed access, the phone caught up and
both fixtures were disabled before resetting the synthetic baseline. Receipts: `reactive-input-interrupted.json`
and `reactive-mirror-interrupted.json`.

## Corrected reactive fixture: pass

A second attempt began with both fixtures enabled on an unchanged baseline.
Twenty native desktop characters were entered over **10.017 seconds**.
The phone was observed immediately before and after input, then showed all
twenty characters and an advancing local timestamp. Both devices paused.

The measured hold lasted **316.506 seconds** (22:18:03.609–22:23:20.115 UTC).
The disposable server's logged global version-endpoint POST count stayed
at 61. Repeated phone observations throughout showed the full body and
advancing timestamps; the desktop body also stayed complete while its
stamp changed. There was one main head and no preservation copy of this
note before Resume. Both fixtures were then disabled. The phone used the
native Resume control; the desktop invoked the plugin's native Sync now
command through the vault-scoped Obsidian CLI.

After Resume, both native views contained all twenty letters in the main
note. The desktop/server read found one head, one preservation copy, no
paused files, and the fixture disabled. Main-note SHA-256:
`653ac3029c7d11525309f0d23f146b508bb558273bf3ef88010d6430924a6635`.
A **542.454-second** quiet window (22:26:17.169–22:35:19.623 UTC)
recorded 65→65 logged global version-endpoint POSTs and unchanged main text,
head count, copy count, and desktop inventory. The phone remained accessible;
its final status was idle and its main text and timestamp matched visually.

These counters cover all logged version-endpoint requests on the disposable
server, including notes, copies, encrypted control records, and refused
attempts. They are not a count of content versions for this one note.
The phone also had an unrelated preservation copy of the earlier co-typing
note; that copy is excluded from this scenario's count. Full-vault byte
identity and the provenance of that unrelated copy are not claimed.

Receipts: `reactive-native-input.json`, `reactive-hold-start.json`,
`reactive-hold-end.json`, `reactive-quiet-start.json`,
`reactive-quiet-end.json`, and their measured comparisons. Independent
review recomputed the log-prefix hashes, counters, durations, and note hashes.
No product or test repair was made from these native runs.

## Creation, lifecycle, rename, and move

- **Phone creation:** renamed the disposable phone vault through Obsidian's
  vault manager. Obsidian displayed its author-trust prompt; enabling the
  already-authorized candidate led to idle without re-pairing. The displayed
  device identity stayed the same. A new note typed on the renamed phone
  arrived automatically on the desktop with the complete text.
- **Phone process restart:** dismissed Obsidian's card from the native app
  switcher, then created a new desktop note while the phone app was closed.
  The first launch tap returned to Home; a second opened Obsidian. The new
  note arrived with its full text without Sync now or a pairing prompt.
  Later status showed idle and the same device identity. This establishes
  successful automatic catch-up, not a precise launch-to-idle latency.
- **Desktop rename and move:** closed only the QA window, renamed its vault
  using the native vault manager, reopened, then repeated for a move to a
  different parent directory. Each reopen reached idle automatically.
  Hashed installation and device identity, active-device membership, desktop
  whole-vault selection, and existing note hashes stayed unchanged. A new note created through the
  scoped native vault API after each operation arrived on the phone with
  its complete text. The phone rename was restored before cleanup.

The desktop lifecycle check is a QA-window unload/reopen, **not** the
literal whole-process quit on both devices required by J8. That complete
J8 row remains unmeasured on this bundle. Receipts:
`final-lifecycle-receipt.json` and the associated `identity-*.json` files.

## Remote deletion while the phone types

The desktop trashed a synthetic note through Obsidian's `fileManager` while
the phone kept its editor open and entered 199 digits. In the first attempt,
deletion happened 831 ms before the first key; all digits survived, but that
attempt is not evidence of deletion during input.

The bounded repeat entered another 199 native keys over **34.537 seconds**.
Deletion occurred **13.860 seconds** after the first key, inside that input
window. The phone editor stayed open, and the desktop automatically received
the restored note with both complete 199-character sequences. The saved
note SHA-256 was
`d5f92bb6f7edd3083632be029d5324b1399942643cb6423b4c9542fd1cf1c2ad`.
The phone's complete text was read visually. No notice screenshot was
captured, so notice wording/count is not established by this run.
Receipts: `delete-typing-repeat-event.json`,
`delete-typing-repeat-readback.json`, and
`identity-after-phone-restart-delete.json`. CLI plain-text readback adds a
trailing newline; the hash above is from the direct native vault read.

## Cleanup and scope

Both phone QA vaults were deleted through Obsidian after leaving the test
server. Their installed plugins were removed with those vaults; both ZIPs
were moved to Files trash. The corrected vault's exact test secret was
cleared and verified by its scoped helper before deletion. The first vault
was deleted natively; no separate OS-level secret-absence claim is made.
The user removed the older obsync validation certificate profile at the
passcode prompt, and its absence was verified. The current QA Safari tab
and its route-specific history entry were removed. Unrelated profiles,
browsing history, and the user's vaults were preserved.

The desktop registration was revoked, its exact test secret cleared, its
plugins disabled, and its QA window closed and vault registration removed.
The temporary CLI setting was restored to disabled. Task-owned native vault,
server binary, journal, blobs, packages, and tunnel files were removed.
The three verified QA processes stopped and both loopback listeners were
absent. Evidence, source, and non-secret logs remain for review. Raw server
log prefixes used by the measurements were retained unchanged.

Scenarios not explicitly recorded here were not attempted in this run;
earlier records retain their original build scope. Bug-fix closure support comes from the implementation, regression
and mutation evidence, and the applicable native results together. It does
not mean every historical issue's requested device variant was rerun.
This record does not establish independent final-head approval, the user's merge,
exact-main CI, immutable publication, distribution, or production activation.
