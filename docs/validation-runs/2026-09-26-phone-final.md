# 2026-09-26 final 1.1.3 native phone acceptance

Author-operated validation using a disposable server and synthetic vaults.
Owner vaults were excluded. This record keeps final-candidate evidence
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
- Phone: physical iPhone through native iPhone Mirroring. Model, OS version,
  and Obsidian application version not recorded during the run. Plugin
  version 1.1.3 was observed in Community plugins and in the pairing claim.

## Pairing and initial content

The phone package contained exactly two synthetic notes and a disabled,
separate timestamp fixture. The native pairing claimant reported iOS,
plugin 1.1.3, the expected test vault, and two notes. Approval succeeded;
the short-lived invitation files were removed. Both native editors showed
the initial note content before input began.

The locally built fixture is scoped to the two test vault names and one
synthetic note. Once enabled, it calls Obsidian's `processFrontMatter` once
per second to change a timestamp. It does not modify the obsync bundle.

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

## Repeated rewrites and Resume: in progress

Both native devices enabled the scoped one-second rewrite fixture. Twenty
native desktop characters were entered into the note body over **10.071
seconds** (21:06:06.770–21:06:16.841 UTC). All twenty remained in the desktop
main note. Both devices reported the shared pause, and one preservation
copy existed.

The first hold measurement ran from 21:07:19.654 to 21:12:52.015 UTC:
**332.361 seconds**, zero version POSTs across the disposable server, one
preservation copy, and the complete desktop body unchanged while its local
timestamp continued changing. The phone's local timestamp was also observed
changing during the window.

The final phone readback encountered a paused, then locked Mirroring session
requiring owner authentication. Continuous phone activity for the complete
window is therefore not established by that first measurement. It proves
the server/desktop hold; phone continuity remains pending. Sync remains
paused, and the desktop fixture remains active. Disabling both fixtures,
Resume, and the post-Resume quiet window are pending.

## Scope still outstanding

Final restart/reconnect, remaining affected native journeys, and scoped
cleanup are pending. Scenarios not explicitly recorded here were not
attempted in this run; earlier records retain their original build scope.
This record does not establish independent final-head approval, owner merge,
exact-main CI, immutable publication, distribution, or production activation.
