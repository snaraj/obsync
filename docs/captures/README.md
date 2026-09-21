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
| `02-first-time-setup.png` | the plugin's settings tab, scrolled to the folder selection, **Pairing**, and **First-time setup** where the setup token goes; the **Server URL** field is above the frame, because the address it holds may not be published |
| `03-recovery-phrase.png` | the 24-word recovery-phrase dialog, words obscured |
| `04-pair-a-new-device.png` | the **Pair a new device** dialog on the first device, its one-time code obscured, cropped to the dialog so the settings page behind it -- which carries this device's name -- is not published |
| `05-sync-both-ways.png` | the disposable note carrying both devices' edits, seen on the desktop, with the status bar visible |

In `docs/validation.md` terms: 01 comes from the production-path install, 02
and 03 from V1, 04 from V2, 05 from V3. They are taken during a real
validation run and belong to the run recorded in
`docs/validation-runs/<date>.md`.

Four more captures, numbered 06 to 09, belong to the dashboard and are not
part of this table because `README.md` does not display them: their names,
what each must show, and where they go are in
[the dashboard page](../dashboard.md). Everything below
about how to take one, and everything under requirement 11, applies to them
exactly as it does to the five.

## How README.md displays them

`scripts/ci/test_capture_contract.py` refuses anything but this form, so it is
written here rather than only in the suite. It is deliberately narrower than
markdown: the question it answers is not "does this parse" but "does a reader
SEE five screenshots".

### The visible document

`README.md` is first reduced to what a reader actually sees, by removing the
literal contents of every block that can ENCLOSE a heading. Comment stripping
alone is not that, and saying it was is how three separate constructs got past
this rule: a `~~~` fence, a ``` fence, and an outer `<PRE>` each hid all five
screenshots with the section itself unchanged.

- **Fenced code blocks** ([CommonMark 4.5](https://spec.commonmark.org/0.31.2/#fenced-code-blocks)):
  up to three spaces of indent, then three or more backticks or tildes; closed
  by the first later line with up to three spaces of indent and a run of the
  same character at least as long, or by the end of the file.
- **HTML blocks** ([CommonMark 4.6](https://spec.commonmark.org/0.31.2/#html-blocks))
  of the five kinds that end at a closing marker: `<pre` / `<script` /
  `<style` / `<textarea` (either case), `<!--`, `<?`, `<!` and a letter, and
  `<![CDATA[`. Each may be indented up to three spaces, and an unclosed one
  runs to the end of the file.
- HTML blocks of **types 6 and 7** end at the next blank line instead, so the
  form simply REQUIRES the line above the heading to be blank: neither kind
  can still be open there. **Indented code blocks** (CommonMark 4.4) need four
  spaces on every line, and the heading has none, so they cannot enclose it.

### The capture section

The CAPTURE SECTION is the lines of that visible text from
`## Get synced in five steps` up to the next line beginning `## `. If the
heading is not in the visible text at all, the README has no screenshots in it
and that is a refusal, not an empty count. The line above the heading must be
blank.

Inside the section, every line must be exactly one of six shapes. This is a
WHITELIST, and it is one deliberately: four rounds of "no backtick, no tilde,
no `<pre`" lists each missed a construct, the last of them a `<div>` on the
line directly above each image. That is an HTML block of type 6, which ends at
a blank line rather than at a marker, so the pass above cannot remove it -- and
it turns the image under it into raw HTML with every image line unchanged.
Types 6 and 7 can only BEGIN with `<`, and no shape below admits a `<`
anywhere, so neither can start in this section at all.

| Shape | What it looks like |
| --- | --- |
| the heading | `## Get synced in five steps` |
| a blank line | empty, no spaces |
| a step opener | `1.` to `5.`, a space, then a bold run |
| a continuation line | EXACTLY three spaces, then text that does not start with `!` |
| a prose line | no indent, and does not start with `#` or `!` |
| an image line | three spaces, then `![<alt>](docs/captures/<name>)`, with a BLANK LINE on each side |
| an alt text | a letter or digit, then letters, digits, spaces, commas, periods, apostrophes and hyphens |

Every shape but the heading forbids a backtick, a tilde, a backslash and a `<`
in any position -- including the alternative text, which is written as the
characters it ADMITS rather than the one it excludes. Written as "anything but
a `]`" it let an unmatched `[` stand before the closing bracket, and a
backslash escape that bracket; under
[CommonMark's link-text rules](https://spec.commonmark.org/0.31.2/#links),
applied to [images](https://spec.commonmark.org/0.31.2/#images), neither of
those is an image any more. A fourth space or a tab is refused too: in CommonMark that
opens an indented code block whatever it contains, so eight spaces would turn
all five screenshots into code samples without changing a character of the
image syntax.

There must be exactly five image lines, in the order of the table above, each
with alternative text that is not empty. Any other mention of
`docs/captures/` -- a link with no `!`, an image with empty alternative text,
an image sharing a line with prose -- is refused rather than counted.

Outside that section README.md may say whatever it likes, including the
comment that records this rule and the fenced blocks of the quick start; this
is a form for one section, not a markdown policy. Renaming the heading is a
change to this convention and to the suite, in one pull request.

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
