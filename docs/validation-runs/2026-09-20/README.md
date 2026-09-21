# Captures for the 2026-09-20 run

Evidence for `docs/validation-runs/2026-09-20.md`. The image files arrive
through the docs-site change (image files are artifact-class); this file
states, for each, what it shows and what was cropped. Requirement 11 is
checked against the committed pixels, not against this table.

| File | Shows | Cropped out |
| --- | --- | --- |
| `11-desktop-approve-prompt.png` | the desktop plugin's approval prompt for the phone: `Approve "ios" on ios (obsync 1.0.1)?` with Approve and Reject | nothing; the prompt state displays no code |
| `13-mobile-file-arrived.png` | the phone's file list with the desktop-written note present, status bar showing cellular | everything outside the phone frame |
| `14-mobile-appended-line.png` | the note on the phone with the line the phone appended | everything outside the phone frame |
| `15-desktop-both-lines.png` | the desktop editor with both lines, status bar reading idle | the rest of the desktop |

Withheld under requirement 11: the phone-side captures of the pairing step
(pairing code and server address on screen) and the dashboard views (account
identifier and address bar on screen).
