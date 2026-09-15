# README captures

`README.md` leads with captures of the plugin and the dashboard (`AGENTS.md`,
"Docs and README conventions"). They are committed PNG files in this folder,
never generated at build time, and a pull request that changes what either
surface renders asks the owner for fresh ones and says so in its body.

## The five

`README.md` references exactly these names, in this order, one sentence each.
The names are part of the README and do not change without changing it:

| File | Shows |
| --- | --- |
| `01-install-from-directory.png` | Settings -> Community plugins -> Browse with **Self Hosted Private Sync** found and the Install button |
| `02-first-time-setup.png` | the plugin's settings tab, scrolled to the saved folder selection, **Pairing**, and **First-time setup** where the setup token goes; the **Server URL** field is above the frame, because the address it holds may not be published |
| `03-recovery-phrase.png` | the 24-word recovery-phrase dialog, words obscured |
| `04-pair-a-new-device.png` | the **Pair a new device** dialog on the first device, its one-time code obscured, cropped to the dialog so the settings page behind it -- which carries this device's name -- is not published |
| `05-sync-both-ways.png` | the disposable note carrying both devices' edits, seen on the desktop, with the status bar visible |

In `docs/validation.md` terms: 01 comes from the production-path install, 02
and 03 from V1, 04 from V2, 05 from V3. They are taken during a real
validation run and belong to the run recorded in
`docs/validation-runs/<date>.md`.

## How README.md displays them

`scripts/ci/test_capture_contract.py` refuses anything but this form, so it is
written here rather than only in the suite. It is deliberately narrower than
markdown: the question it answers is not "does this parse" but "does a reader
SEE five screenshots".

First, every HTML comment is removed from the WHOLE of `README.md` -- a closed
`<!--` to `-->`, and an unclosed `<!--` running to the end of the file. What
is left is the visible document. The CAPTURE SECTION is the lines of that
visible text from `## Get synced in five steps` up to the next line beginning
`## `. If the heading is not in the visible text at all, the README has no
screenshots in it and that is a refusal, not an empty count: a comment opened
on the line ABOVE the heading hides the whole section from any rule that only
reads the section.

Inside the section:

- exactly five image lines, in the order of the table above, each ALONE on its
  line, indented by EXACTLY the three spaces that continue its numbered list
  item, matching `![<alt>](docs/captures/<name>)` with alternative text that is
  not empty and nothing after the closing parenthesis;
- no line may begin with four spaces or a tab. In CommonMark that opens an
  indented code block whatever it contains, so eight spaces turn all five
  screenshots into code samples without changing a character of the image
  syntax;
- no line may carry a backtick, a `~~~` fence, a `<pre` tag, an HTML comment
  opener `<!--`, an escaped `\![`, or an `<img` tag, in EITHER case: `<PRE>`
  hides an image exactly as well as `<pre>`. Each of those renders an image as
  literal text or hides it altogether, and the section is where the
  screenshots have to actually appear;
- any other mention of `docs/captures/` -- a link with no `!`, an image with
  empty alternative text, an image sharing a line with prose -- is refused
  rather than counted.

Outside that section README.md may say whatever it likes, including the
comment that records this rule; this is a form for one section, not a markdown
policy. Renaming the heading is a change to this convention and to the suite,
in one pull request.

## How to take them

1. Use a DISPOSABLE vault with disposable notes, on a device paired for the
   run. Never capture a personal vault: a file tree is personal data.
2. Capture the window, not the screen: no menu bar, no wallpaper, no other
   application, no browser tab bar. When the surface is a DIALOG, crop to the
   dialog: the page behind a modal is still published, and a settings page
   behind one carries this device's name.
3. PNG only, at the device's own resolution. No JPEG, no screen recording,
   no animated image, no capture cropped so tightly that the surface it
   claims to show is no longer identifiable.
4. Keep them small. A capture over about 400 KB is a full-screen capture that
   wanted cropping; the repository carries these forever.
5. Name the file exactly as the table above spells it and put it in this
   folder. The README references it by relative path.

## What must not be in a capture (requirement 11)

Read every pixel before committing, including window titles, tooltips,
notification banners, and anything reflected in a status bar:

- **No recovery phrase.** Capture 03 exists to show that the dialog appears
  and what it asks of the reader, with the words obscured in the image itself
  — blurred or covered, not merely small.
- **No setup token, pairing code, session link, or edge service-token header
  value.** Obscure them the same way. A code that has expired is still a
  picture of a credential and teaches the wrong habit.
- **No address or hostname.** The **Server URL** field, the dashboard's
  address bar, and the Devices list's address column are redacted in the
  image.
- **No device identifier, serial, account name, or e-mail.** Devices appear
  by role. The Devices list shows device names the owner chose, so those are
  redacted too unless they are already role names.
- **No personal note content, file name, or folder name** beyond the
  disposable ones made for the run.

Redaction is part of the capture, not of a viewer: the committed PNG must
itself carry no private fact, because it is published the moment it is pushed.
