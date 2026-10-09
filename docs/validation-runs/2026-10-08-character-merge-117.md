# Character merge on desktops and a phone, 2026-10-08

Two people typing at one place in one note -- two desktops, or a desktop and
a phone -- until every keystroke of both stays, in each person's order, on
every device, and no state either editor or disk shows in between steps back.
The campaign found seven defects in the 1.1.7 candidate, each only once the
checks were strict enough. Six were fixed before the next run; the seventh,
found on a physical iPhone at the end, is open. The failing runs stay in this
record: each is the evidence for one fix, or for the one still open.

- **Date and operator role.** 2026-10-08, `user`, through an agent on the
  user's development computer.
- **Route.** None of `docs/validation.md`'s production routes. Each lab runs
  its own `obsyncd` built from the candidate on that computer: over loopback
  HTTP for the desktops; for the phone, through a public quick tunnel of the
  user's edge provider, so its requests cross a real TLS edge and the public
  internet. Neither establishes the latency of a deployment behind its own
  terminator, and no TLS-inspecting proxy was in the path.
- **Server.** 1.1.7 candidate, built from each commit in the table below.
- **Plugin.** 1.1.7 candidate, copied into each vault by the lab: a manual
  file copy, not a Community plugins install.

## Builds

| Commit | Plugin `main.js` SHA-256 | Runs |
| --- | --- | --- |
| `46fc651b` | `8fa231f2df8ea82b…` | desktop same place 60 s, before the first fix |
| `b24f7305` | `bc6a6eb22994b248…` | desktop same place 60 s and 600 s |
| `54d03b3d` | `bc6a6eb22994b248…` (the same bytes) | phone session 1 |
| `e75bcfe0` | `6273a235bea38b0f…` | phone session 2 |
| `fc0ee57c` | `68c1609333feeca1…` | phone session 3 |
| `3c8a7914` | `d8d958dd03972531…` | phone session 4; desktop same place 60 s |
| `323e4b6b` | `dd02e96939be1614…` | desktop same place 60 s and 600 s |
| `5544d0ec` | `1a21bec4a8ee26e5…` | phone session 5; desktop same place 60 s and 600 s; desktop latency |
| `2ff710ee` | `1a21bec4a8ee26e5…` (the same bytes) | iPhone session 1 |
| `436c2bb5` | `8494d9d57b009cdc…` | iPhone session 2, built from a commit adding only this record on it |

Every build is from a clean tree (`source_dirty: false` in its receipt).

## Devices

- **Desktops.** macOS 27.0 (26A428), arm64; two instances of the official
  Obsidian app in fresh profiles. The installed application reads 1.13.4,
  before and after the runs; the version inside the app was not recorded
  during the runs. Profiles use the mock-keychain testing mode, so they do not
  establish native credential custody.
- **Phone.** Not a physical phone: an Android 15 emulator
  (`android-35`, `google_apis`, arm64-v8a, `pixel_8` profile, 1080×2400 at
  420 dpi, 2 cores, 2 GiB, software graphics, Android System WebView
  124.0.6367.219), a fresh profile each session, Obsidian 1.14.4 from its
  published APK (SHA-256 `b3e5bfa1…`). Every phone run types through the
  WebView's trusted input; the keyboard runs type through the emulator's
  on-screen keyboard instead, so composition, suggestions and autocorrect act
  as they do for a person.
- **iPhone.** The user's own iPhone, driven from the computer through Apple's
  iPhone Mirroring, which reaches the phone as a hardware keyboard; a fresh
  test vault beside the user's own, which was not edited. Obsidian for iOS
  1.14.4 (389), read from its settings in session 2. The model and the iOS
  version were not recorded. Same route as the emulator: a public quick
  tunnel, HTTPS trusted by the phone.

## How each run is judged

`scripts/validation/cotype-live.mjs` with `PLACE=same`: both carets are
placed once after the `0` that starts line 3 and never moved; each person's
keys are distinct code points, and every seventh is a wrong key deleted
next. A pass needs every device's disk and editor to hold exactly both
people's kept keys in typed order, and no conflict copy. Every state either
editor showed and every save either vault reported must hold each person's
keys as that person had them at one moment, never earlier than the moment
before it (`transient`). Every editor transaction is also judged by who made
it: typing never changes the other person's characters, and a synced change
never changes this person's. The page checks every state itself; `checked`
counts them, so a zero is never a check that did not run. A run's notices
are read too: a notice that is not true fails it.

## Results

X is the desktop, Y the other device.

| Run | Build | Typed (X / Y) | Checked states | Broken states | Copies | Result |
| --- | --- | --- | --- | --- | --- | --- |
| Desktops, same place, 60 s | `46fc651b` | 298 / 298 | 1,226 / 1,205 | 10 / 4 | 0 | fail |
| Desktops, same place, 60 s | `b24f7305` | 298 / 298 | 1,189 / 1,195 | 0 / 0 | 0 | pass |
| Desktops, same place, 600 s | `b24f7305` | 2,982 / 2,982 | 12,071 / 12,022 | 0 / 0 | 0 | pass |
| Phone, same place, 60 s | `54d03b3d` | 298 / 298 | 806 / 745 | 744 / 678 | 0 | fail |
| Phone keyboard, 60 s | `54d03b3d` | 297 / 297 | 742 / 663 | 0 / 0 | 0 | pass |
| Phone keyboard, 300 s | `54d03b3d` | 1,492 / 1,492 | 3,746 / 3,283 | 0 / 0 | 0 | pass |
| Phone, same place, 60 s | `e75bcfe0` | 298 / 298 | 802 / 728 | 9 / 18 | 0 | fail |
| Phone keyboard, 60 s | `e75bcfe0` | 239 / 239 | 632 / 576 | 0 / 0 | 0 | pass |
| Phone, same place, 60 s | `fc0ee57c` | 298 / 298 | 791 / 746 | 0 / 0 | 0 | pass |
| Phone, same place, 300 s | `fc0ee57c` | 1,491 / 216 | 3,081 / 431 | 2,723 / 95 | 0 | fail [^1] |
| Phone, same place, 60 s | `3c8a7914` | 299 / 299 | 790 / 722 | 0 / 0 | 0 | pass [^2] |
| Phone, same place, 300 s | `3c8a7914` | 1,493 / 1,493 | 3,972 / 3,633 | 0 / 0 | 0 | pass |
| Phone keyboard, 60 s | `3c8a7914` | 239 / 239 | 609 / 543 | 0 / 0 | 0 | pass |
| Desktops, same place, 60 s | `3c8a7914` | 299 / 299 | 1,195 / 1,185 | 208 / 207 | 0 | fail |
| Desktops, same place, 60 s | `323e4b6b` | 299 / 299 | 1,211 / 1,189 | 0 / 0 | 0 | pass |
| Desktops, same place, 600 s | `323e4b6b` | 2,987 / 2,987 | 11,842 / 11,883 | 0 / 0 | 0 | fail [^3] |
| Desktops, same place, 60 s | `5544d0ec` | 299 / 299 | 1,183 / 1,191 | 0 / 0 | 0 | pass |
| Desktops, same place, 600 s | `5544d0ec` | 2,987 / 2,987 | 11,906 / 11,941 | 0 / 0 | 0 | pass |
| Phone, same place, 60 s | `5544d0ec` | 298 / 298 | 832 / 758 | 0 / 0 | 0 | pass |
| Phone, same place, 300 s | `5544d0ec` | 1,490 / 1,490 | 4,064 / 3,771 | 0 / 0 | 0 | pass |
| Phone keyboard, 60 s | `5544d0ec` | 239 / 239 | 671 / 594 | 0 / 0 | 0 | pass |

The keyboard runs type words on the phone, so their Y count is keyboard taps.
Every figure is `final.json` in that run's evidence, read by one script.

[^1]: The emulator stalled under the computer's load from other work two
    minutes in, and its route's name stopped resolving: the phone typed 216
    keys and ended offline. The broken states before that are defect 4.
[^2]: The first 60 s run of this session started while the phone was still
    in its first sync and is not counted; this is its repeat.
[^3]: Every text check passed. One desktop told the user it had "stopped
    renaming" the note because the other "keeps giving it a different name",
    and to update obsync; nobody renamed it. That is defect 6.

## The iPhone sessions

The desktop created each note by typing it, one line and a line break; the
phone opened it once it had arrived and typed `phone7` a key at a time,
0.4 s apart, at the end. "Published" is the newest version's text, decrypted
by the desktop, which held the same text on disk and in its editor every
time.

Session 1:

| Note | Caret placed by | Inline predictions | Published | Result |
| --- | --- | --- | --- | --- |
| 1 | taps on line 2, then Cmd+Down | on, as the phone was | `Desktop control 42⏎pDesktop control 42hone7` | fail: defect 7 |
| 2 | Cmd+Down | turned off | `Desktop control 43⏎phone7` | pass |
| 3 | Cmd+Down | asked back on; none was shown | `Desktop control 44⏎phone7` | pass |
| 4 | taps on line 2, then Cmd+Down | as for note 3 | nothing: no key reached the editor | void |

`⏎` is the line break. In notes 1 to 3 each key was one version, children of
the desktop's single version in order: the phone's merge never ran. In
note 4 the editor lost its input focus after the taps and Cmd+Down, and iOS
then offered a suggestion of its own beside the caret; it was dismissed, not
taken, and the note stayed exactly as the desktop wrote it. The session's
window closed there, and its teardown removed every relay and process
(`final-cleanup` PASS).

Session 2, every note with one tap on line 2, then Cmd+Down, then the keys;
obsync was switched off and on in the test vault's Community plugins between
notes, and nothing else changed:

| Note | obsync | On the phone after the keys | Result |
| --- | --- | --- | --- |
| A1 | on | `Desktop control 51⏎pDesktop control 51hone7` | defect 7, the published text too |
| A2 | off | `phone7Desktop control 52⏎` | keys at the start of line 1, none twice |
| A3 | on | `phone7Desktop control 53⏎` | keys at the start of line 1, none twice |
| A4 | on | unchanged | void: no key reached any field until Mirroring was reconnected |
| B1 | off | unchanged | void: begun while no key reached any field |

Obsidian without obsync shows the cause: after the tap and Cmd+Down, the
caret is drawn at the end of the note, and the keys land where the editor's
own selection still is, the start of line 1. With obsync on, the same keys
landed there too (A3), or the editor showed the line above typed again before
them (A1), within 0.4 s of the first key. Its teardown again removed every
relay and process (`final-cleanup` PASS).

## The defects the failures found

1. **A deleted key came back for a moment** (`46fc651b`, desktops). A merge
   that came out exactly as the other device's text took that device's
   version as this one's own, though it had never seen a key typed and
   deleted here. Fixed by `b8cefced`: such a version is adopted only when this
   device's own history is in it, and an unsent deletion goes out first.
2. **Two typed keys lost on every device** (`54d03b3d`, phone). Two merges
   below the losing merge shared two newest ancestors, and one had sunk below
   the ten versions the server lists; merged over the one listed, a base
   older than two keys both heads held wrote them twice, and the merge over
   it took both out. Fixed by `978bf5ce`: a pair's ancestry is completed to
   its shared frontier before any base is chosen, at every level.
3. **Two typed keys gone for two seconds on both devices** (`e75bcfe0`,
   phone). The phone recalled the unlisted ancestry from what it held and
   added each version before its first known parent; a parent reached first
   from the other head stood before its child, and the second criss-cross
   level took that parent for a base. Fixed by `cde8ed43`: completed ancestry
   is put back in children-first order once, and each criss-cross log line
   names its two bases.
4. **Two of the phone's keys twice, and its deleted typo back, for good**
   (`fc0ee57c`, phone, 300 s). The desktop published a version holding three
   of the phone's keys with only its own previous version as parent. The
   incoming merge had been delivered into the open editor and saved; the next
   keystroke's save landed before the confirmation read the file, the file no
   longer matched the delivered text, and the write was refused as replaced:
   the merge was never posted, and the next save published the phone's keys
   as the desktop's own typing. Fixed by `3b0db0e3`: a file that still holds
   the delivered write after a completed delivery is typing on it, and the
   write stands.
5. **A deleted typo back at the end of a desktop's typing, for good**
   (`3c8a7914`, desktops). The version graph shows the desktop never
   published that deletion. Its upload of the typo was acknowledged while a
   pull, begun 19 ms earlier, still read the graph against the record before
   it; that record's text equalled the other device's newest version, so the
   pull took that version for its own and overwrote the record of the upload.
   The deletion typed next matched that version and went nowhere, and the
   other device's merge of the upload brought the typo back. Fixed by
   `323e4b6b`: a pull that finds its record moved on reads the graph again
   (`retry reason=record_advanced`), as a merge already did.
6. **A false "stopped renaming" notice after minutes of typing** (`323e4b6b`,
   desktops, 600 s). Two people typing make each device merge the same fork
   to the same text a few times a minute, and each such pair is closed; the
   breaker that bounds closings counted them all in a plain minute and
   tripped 15 times. Fixed by `5544d0ec`: a keystroke here between two
   closings of one name starts that count again, as it starts the merge
   breaker's; closings of two names, and closings nobody typed between, are
   counted as before. The 600 s run on that build reset the count 10 and 8
   times, never past 2, and showed no such notice.
7. **The line above typed again after the first key, on an iPhone**
   (`2ff710ee`, iPhone, note 1; OPEN). The phone's first version after its
   first key held the desktop's line, the key, and the desktop's line again,
   and the next five keys landed after it; both devices then held that text,
   with no copy. No merge made it: that version's only parent is the
   desktop's, so the phone's editor held that text when the save after the
   key read it. Ruled out by reading the app's code: Obsidian's own handling
   of a file changed underneath an editor, which merges against the last
   saved text and only while the editor is unsaved, and of another pane's
   text, which diffs the live document. Reproduced in session 2 (A1). The
   trigger is a tap followed by Cmd+Down from a hardware keyboard: the caret
   is then drawn at the end while the editor's own selection stays where the
   tap put it, and keys typed next land there. Obsidian without obsync puts
   them at the start of line 1 and nothing twice (A2); with obsync, the line
   above was typed again in one of two runs (A1, A3), so obsync turns a
   misplaced key into a doubled line, which then syncs. Without a tap first,
   the same Cmd+Down and keys were exact (session 1, notes 2 and 3), and
   inline predictions play no part. The link is not established yet; the
   leading candidate is obsync's save of the editor 5 ms after each key,
   which on this path can run between iOS changing the page and the editor
   reading that change.

## Journeys and timings

| Row | Session | Result | Observed |
| --- | --- | --- | --- |
| V2 pair a phone | 4, 5 | pass | Both sessions paired through the dialogs, codes compared by independent renderers. |
| V2 pair a phone | iPhone 1, 2 | pass | Paired through the dialogs; the code the phone showed matched the desktop's. |
| A desktop's note, then typing on the iPhone | iPhone 1, 2 | fail | Defect 7 (session 1 note 1, session 2 A1); exact without a tap before Cmd+Down. |
| V3 typing on a phone shows elsewhere within 3 s | 4 | fail | Cotype journey, 147 keystrokes each way: desktop to phone p50 1,068 ms, p95 1,724 ms, max 3,577 ms; phone to desktop p50 1,040 ms, p95 2,029 ms, max 3,634 ms. |
| V3 | 5 | pass | Desktop to phone p50 940 ms, p95 1,345 ms, max 1,602 ms; phone to desktop p50 952 ms, p95 1,372 ms, max 1,778 ms. |
| Cotype journey, 1.5 s for every keystroke | 1, 4, 5 | fail | 5 / 5, 15 / 15, and 2 / 3 keystrokes over 1.5 s (desktop to phone / phone to desktop); none missing. |
| Two people typing at one place (this record's scenario) | all | pass on `5544d0ec` | The results table: no copy, and no lost, doubled or returning key, in any run of the final build. |
| J1, J2 after the app returns from the background | 4 | pass | Desktop to phone 1,065 ms, phone to desktop 1,022 ms. |
| J1, J2 after the app returns from the background | 5 | pass, slowly | Desktop to phone 127,870 ms, phone to desktop 9,575 ms. [^4] |
| J10 leave | 4 | pass | The server revoked the device in 3,271 ms; 8 local notes unchanged; the device's records cleared. |
| J10 leave | 5 | not attempted | The emulator had stopped responding [^4]. |
| Desktop latency, loopback | `5544d0ec` | pass | One line typed: remote 187 ms, converged 297 ms; both lines: 314 / 354 ms; continuous typing: 564 / 314 ms; no unexpected notice. |
| Every other V and J row | -- | not attempted | |

The journeys and the latency scenario run the lab's own drivers, which are not
part of this repository; every journey receipt names its driver's SHA-256
(`063ba2e2…`). The cotype figures are computed as the journey judges them, from each
renderer's clock corrected by its measured offset, plus both clocks'
uncertainty. Earlier 1.1.7 candidates, in this journey's complete samples of
2026-10-06 and 2026-10-07 (no keystroke missing, 20 of them), measured p50
0.26–1.18 s and p95 0.39–3.47 s, and three of the 20 kept every keystroke
within 1.5 s; their routes were not re-read for this record.

[^4]: Back from the background, the phone could not resolve its route's name
    for 14 s ("Unable to resolve host"), then logged nothing for 50 s; a
    58-byte chunk took 20.6 s, and the note was applied 62.8 s after its pull
    began. The feed's own watchdog said so (`feed decision=stalled
    waited_ms=119162 budget_ms=110000`). Minutes later the emulator stopped
    responding as a whole: Android's own system process logged dispatches
    stalled 25 to 32 s, Obsidian was stopped for not answering a focus change
    in 5 s while it used 14 % CPU, and Android then reported its own system
    process as not responding. The computer's load average was 12 to 21 on 10
    cores at that time, from other work. One earlier session saw an
    87 s return the same way; session 4 saw 1 s. Whether a real phone on a
    stable route returns slowly is not established.

## Mutation evidence

Each mutant is applied with `plugin/test/mutants/run.sh`'s own flags to an
export of the named commit and the whole plugin suite run; a control lane
runs the unmutated suite beside them. Killed means at least one test failed.

| Set | Commit | Control | Killed | Survived |
| --- | --- | --- | --- | --- |
| This PR's own, 128 | `5544d0ec` | 2,220 / 2,220 | 122, and M4225 by timeout: three tests never finish | 0; five did not apply there and were re-cut |
| Those five, and M4225 again | `436c2bb5` | 2,225 / 2,225 | 5, and M4225 by timeout again | 0 |
| The library's re-cut, 142 | `2ff710ee` | 2,220 / 2,220 | 59 of the 68 run | 9: seven now killed by the tests `436c2bb5` adds, two retired |
| The 74 not run | `436c2bb5` | 2,225 / 2,225 | 74 | 0 |

The seven survivors' kills were measured against the tests that kill them,
with the source restored from a copy after each. M3298 and M3300 are retired:
the order M3298 pinned no longer decides anything, and the check M3300
removed is the one `436c2bb5` deletes because `canRefresh` already makes it.
All 2,042 mutants apply at `436c2bb5`. The whole set has not been run again
at one final commit.

## What was not validated

- **iPhone acceptance.** Two iPhone sessions paired and reproduced defect 7,
  which is open; no co-typing, background, restart, offline or leave journey
  ran on an iPhone. Every other phone result is an
  Android emulator. Nothing here speaks for an iPad, or for a physical
  Android phone.
- **A production route.** Loopback for the desktops, a public quick tunnel
  for the phone; no deployment behind the user's terminator, no
  TLS-inspecting proxy.
- **Relay within 1.5 s for every keystroke.** The cotype journey fails that
  budget over the tunnel in every session here, as most samples did before
  this work; the median is about one second. The desktop latency scenario
  passes over loopback.
- **A prompt return from the background on Android.** See the journey rows.
- **Ancestry past the read budget.** In the final 600 s desktop run one
  device's held ancestry reached its 8 MiB budget and one merge read 64
  versions and stopped (`merge_ancestry_limit`). It fell back to the listed
  base and that run's text stayed exact, but a base chosen past the budget can
  be older than keys both heads hold -- the class of defect 2 -- so a longer
  session than any here could meet it.
- **The same text typed at one place by both people at one moment.** Kept
  once, not twice: two insertions where one is the start of the other combine
  into the longer one, by design of the merge.
- **The lab's own dialogs.** Obsidian's vault-trust dialog, opened by the
  lab's settings step, stood over the phone's vault after pairing in one
  session and was dismissed as a person would; it is Obsidian's, not obsync's.
- **The in-app Obsidian version on the desktops** during the runs.
- **Restart, offline, rename, folder, large-file and every other journey not
  in the table**, on this build.
