# Character merge on desktops and a phone, 2026-10-08

Two people typing at one place in one note -- two desktops, or a desktop and
a phone -- until every keystroke of both stays, in each person's order, on
every device, and no state either editor or disk shows in between steps back.
The campaign found eight defects in the 1.1.7 candidate, each only once the
checks were strict enough. Six were fixed before the next run. The seventh,
found on a physical iPhone, is Obsidian's own: it happens with obsync
switched off. The eighth, found on the iPhone when both people typed in one
word, is fixed, and the fix kept every key on the iPhone. The failing runs
stay in this record: each is the evidence for one fix, or for what Obsidian
does on its own. The review of `8fc0bf43` and its CI found three more,
in code no run here had reached; `f6ab09fd`, `92ddfdbe` and `844c8e4a` fix them
(defects 9 to 11).

- **Date and operator role.** 2026-10-08 and 2026-10-09, `user`, through an
  agent on the user's development computer.
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
| `f78f2dab` | `8494d9d57b009cdc…` (the same bytes) | iPhone sessions 3 and 4 |
| a lab build on `ba704391`, not in this repository | `70dd68ae…` | iPhone session 5 |
| `9ca63459` | `2edf2b564870847a…` | iPhone session 6 |
| `4f561d4c` | `92fd2f346cd0de06…` | desktop same place 60 s, judged exact, its trace not written [^5] |
| `c8855743` | `92fd2f346cd0de06…` (the same bytes) | desktop same place 60 s and 600 s |

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
| Desktops, same place, 60 s | `4f561d4c` | 298 / 298 | 1,201 / 1,193 | 0 / 0 | 0 | exact; no result [^5] |
| Desktops, same place, 60 s | `c8855743` | 298 / 298 | 1,209 / 1,198 | 0 / 0 | 0 | pass |
| Desktops, same place, 600 s | `c8855743` | 2,976 / 2,976 | 12,000 / 11,934 | 0 / 0 | 0 | pass |

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
[^5]: The driver judged the run exact and then threw
    `ReferenceError: expected is not defined` before its result line:
    `92ddfdbe` had moved that text into `judge`. `c8855743` fixes it, and the
    600 s run begun beside it was stopped and run again on that commit. The
    row is the verdict it printed; it has no `final.json`.

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

After the tap and Cmd+Down, the editor draws its caret at the end of the
note, but iOS keeps typing where the tap put it: in A2, without obsync, the
keys landed at the start of line 1 and nothing twice. With obsync on, the
same keys landed there too (A3), or the editor showed the line above typed
again before them (A1), within 0.4 s of the first key. One run without obsync
cannot tell whether Obsidian alone ever doubles the line. Its teardown again
removed every relay and process (`final-cleanup` PASS).

Session 3 put the keys where session 2's did with one tap at the start of
line 1, then Cmd+Down: the editor moves its caret to the end and iOS keeps
typing at the tap (two notes reached the same state through Obsidian's file
switcher instead). A tap on line 2 alone put both at the end, and those keys
were exact. "Restarted" is the first keys after Obsidian was quit and opened
again; two void notes, one created by a mistyped name and one begun after
letters stopped reaching the phone, are left out:

| Runs | obsync | Keys at the start of line 1 | Line above typed again | Exact |
| --- | --- | --- | --- | --- |
| 10 notes typed in a running app | on 6, off 4 | 10 | 0 | -- |
| 3 notes, a tap on line 2 alone | on 1, off 2 | -- | 0 | 3 |
| 2 restarted, obsync on | on | 1 | 1 (`Desktop control 73⏎pDesktop control 73hone7`) | -- |
| 2 restarted, obsync off | off | 2 | 0 | -- |

Session 4, the same build and the same tap at the start of line 1:

| Note | obsync | Started | On the phone after the keys |
| --- | --- | --- | --- |
| W1 | on | first keys after pairing | `Desktop control 51⏎pDesktop control 51hone7` |
| T1 | on | restarted | `phone7Desktop control 31⏎` |
| W2 | off | running | `phone7Desktop control 52⏎` |
| T2 | off | restarted | `Desktop control 32⏎pDesktop control 32hone7` |
| T3 | off | restarted | `phone7Desktop control 33⏎` |
| T4 | off | restarted | `phone7Desktop control 34⏎` |

T2 is defect 7 with obsync switched off in the test vault: its history holds
two versions, the desktop's and one upload of the doubled text when obsync
was switched back on afterwards. Every note's published text equalled the
phone's screen. Two notes begun while no letter reached the phone are void
and left out; in both, iPhone Mirroring had been switched to another app
while iOS showed a suggestion beside the caret.

Session 4 then had both people type in one note at once, a key every 0.3 s on
the desktop and every 0.4 s on the phone:

| Run | Desktop's keys | Phone's keys | Both devices after | Result |
| --- | --- | --- | --- | --- |
| 1 | `d1`…`d9` on line 2 | `x1`…`x6` at the end of line 1 | `Desktop control 35x1x2x3x4x5x6⏎d1d2d3d4d5d6d7d8d9` | exact |
| 2 | `d1`…`d6` at the end of line 1 | `y1`…`y6` at the end of line 1 | line 1 ends `d1d2d3d4d5d6y1yyy3yyy566` | defect 8 |
| 3 | `e1`…`e6` at the end of line 1 | `z1`…`z6` on line 2 | `Desktop control 36e1e2e3e4e5e6⏎z1z2z3z4z5z6` | exact |
| 4 | `f1`…`f6` at the end of line 2 | `w1`…`w6` at the end of line 2 | line 2 ends `f1f2f3f4f5f6w1www3w4w5w6` | defect 8 |

In every run both devices held the same text on screen and on disk, the note
had one newest version, and there was no copy. Each session's teardown removed
every relay and process (`final-cleanup` PASS), and the test vaults and their
downloads were then deleted from the phone.

Session 5 looked for a way to deliver the other person's text that keeps the
phone's keys. Its build added, for the lab only, a switch read from a synced
note that changed what the phone's writer did with a merge for its focused
editor; nothing else differed from `ba704391`. In every run the desktop typed
`d1`…`d6` at the end of line 1, a key every 0.3 s, and the phone typed at the
end of line 1, a key every 0.4 s; the merge puts the desktop's text before the
phone's `w` keys and after its `a` keys:

| Note | What the phone did with a merge | Phone's keys | Both devices after | Result |
| --- | --- | --- | --- | --- |
| s1 | delivered it, as built | `a1`…`a6` | `Desktop control 21a1a2a3a4a5a6d1d2d3d4d5d6` | exact |
| s2 | delivered it, as built | `w1`…`w6` | `Desktop control 22d1d2d3d4d5d6w1www3w4w5w6` | one key replaced |
| s3 | delivered it, then took focus from the editor and gave it back | `w1`…`w6` | `Desktop control 23d1d2d3d4d5d6w1www3w4www6` | two replaced |
| s4 | held it while it changed the word at the caret | `w1`…`w6`, a space, `x7`…`x9` | `Desktop control 24d1d2d3d4d5d6w1w2w3w4w5w6 x7x8x9` | exact; it arrived on the space |
| s6 | delivered it, as built; the desktop typed only during a 6 s pause | `w1w2w3`, then `w4w5w6` | `Desktop control 26d1d2d3d4d5d6w1w2w3w4w5w6` | exact |
| s7 | delivered it, then removed the selection and added it back | `w1`…`w8` | `Desktop control 27d1d2d3d4d5d6w122www4w5w6w7w8` | two replaced |
| s8 | delivered it, then switched autocorrect off for one frame | `w1`…`w8` | `Desktop control 28d1d2d3d4d5d6w122w344w5w6w7w8` | two replaced |

A seventh note, s5, is void: its hold also required a key-press event within
2 s, and its result matched the build's own, so that event evidently never
fired through iPhone Mirroring.
The desktop read every note back, and it matched the phone's screen. The
teardown removed every relay and process (`final-cleanup` PASS).

Session 6 ran the fix, `9ca63459`, the same way: the phone typed at the end of
line 1 and the desktop at the end of line 1 while it did, unless the table
says otherwise; "while typing" is the phone's screen just after its last key,
and the text after is 4 s later:

| Note | Phone's keys | Desktop's keys | On the phone while typing | Both devices after | Result |
| --- | --- | --- | --- | --- | --- |
| s1 | `w1`…`w8`, 0.4 s apart | `d1`…`d6`, 0.3 s apart | its own keys only | `Desktop control 31d1d2d3d4d5d6w1w2w3w4w5w6w7w8` | exact |
| s2 | `y1`…`y9`, 0.35 s apart | `d1`…`d8`, 0.25 s apart | its own keys only | `Desktop control 32d1d2d3d4d5d6d7d8y1y2y3y4y5y6y7y8y9` | exact |
| s3 | `w1w2w3`, a 2.0 s pause, `w4`…`w9` 0.3 s apart | `d1d2` during the first keys | not observed | `Desktop control 33d1d2w1w2w3w4w5w6w7w8w9` | exact |
| s4 | the same with pauses of 1.7 s and 1.6 s | `d1d2` during the first keys | not observed | `Desktop control 34d1d2w1w2w3w4w5w6w7w8w9` | exact |
| s5 | `w1w2w3`, a space, `x7x8x9` | `d1d2d3` during the first keys | before the space its own keys only; by the fourth key after it, the desktop's text too | `Desktop control 35d1d2d3w1w2w3 x7x8x9` | exact |
| s6 | `a1`…`a6` | `d1`…`d4` | its own keys only | `Desktop control 36a1a2a3a4a5a6d1d2d3d4` | exact |
| s7 | `w1`…`w7` on line 2 | `d1`…`d4` | the desktop's text too, by the tenth key | `Desktop control 37d1d2d3d4⏎w1w2w3w4w5w6w7` | exact |
| s8 | `w1`…`w9` and `v1`…`v3` after `k1`, 0.3 s apart, 8 s in all | `d1`…`d9` | its own keys only | `Desktop control 38k1d1d2d3d4d5d6d7d8d9w1w2w3w4w5w6w7w8w9v1v2v3` | exact |

135 phone keys and 76 desktop keys, none lost, replaced or doubled. The
desktop read every note back, and it matched the phone's screen; each vault
held the eight notes and the sentinel, and no copy. The teardown removed
every relay and process (`final-cleanup` PASS), and both sessions' test
vaults and downloads were then deleted from the phone.

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
7. **The line above typed again after the first key, on an iPhone: Obsidian's
   own, not obsync's** (`2ff710ee`, iPhone, note 1; settled in session 4).
   The phone's first version after its first key held the desktop's line,
   the key, and the desktop's line again, and the next five keys landed after
   it; both devices then held that text, with no copy. No merge made it: that
   version's only parent is the desktop's. The trigger is a tap followed by
   Cmd+Down from a hardware keyboard: the editor draws its caret at the end,
   while iOS keeps typing where the tap put it. Session 4 made it with obsync
   switched off (T2), and that note's history holds one upload of the doubled
   text, made when obsync was switched back on: Obsidian for iOS 1.14.4 writes
   it with no plugin running, and obsync only synced what the editor held.
   Across the four sessions, of the runs whose keys landed at the start of
   line 1, it happened in 4 of 13 with obsync on and 1 of 11 with it off,
   every time in the first keys after the app started or the vault was
   paired, and never in an app already typed in (0 of 13). obsync's code makes
   no editor transaction on a key and touches no open editor at start. Nothing
   in obsync is changed for it; the recipe above is what a report to
   Obsidian's developers needs.
8. **On an iPhone, a key typed right after the other person's text arrived in
   the same word overwrote the key before it** (`f78f2dab`, iPhone session 4,
   co-typing runs 2 and 4; fixed by `9ca63459`). Every key reached the phone's editor and was
   published as typed: in run 4 the phone's version after its fourth key
   ends `f1fw1w2`. The phone's next version, after a merge put the desktop's
   `1f` in front of it in the same word, ends `f1fw1www3`: the next key
   replaced the `2` and the key after it went in. Run 2 lost three keys that
   way and run 4 one; each loss followed a merge into the phone's open editor
   that landed in the word being typed, before the caret. With the desktop's
   text on another line, before the caret (run 3) or after it (run 1), every
   key stayed. Every desktop key was kept, both devices converged, and the
   merges themselves are right; the replaced key is the phone editor's own
   input after obsync delivered the merge into it. The iOS keyboard keeps its
   own record of the word at the caret, and text it did not type, landing in
   that word while the word is typed, leaves that record stale. Each
   keystroke's save retries a parked version at once, so a merge usually
   lands just after a key. In session 5, delivering the merge and then
   refocusing the editor, re-selecting, or switching autocorrect for a frame
   each still replaced keys. Holding it until the word was left replaced
   none, and neither did text that arrived during a pause. Since
   `9ca63459`, on iOS only, a version that would change the word at a focused
   caret waits while that word is typed. It lands when the caret leaves the
   word (a space retries it at once), the editor loses focus, or typing pauses
   for 1.5 s, and each wait logs one line (`reason=typing_word`). Session 6
   kept every key in eight runs, including pauses of 1.6 to 2.0 s followed by
   fast typing, and text on another line still arrived while the phone typed.
   What the keyboard holds is inferred from what each delivery did; it was
   not read from iOS.
9. **A merge over a partial history** (review of `8fc0bf43`, finding 1;
   reproduced there on unchanged product bytes, not in a run here). When the
   walk to a pair's shared frontier stopped -- its 64 reads spent, or a
   retained ancestor answering 404 -- it put the listing back and the merge
   went on over the newest ancestor listed. That base can be older than keys
   both heads hold, the class of defect 2: the review's two variants brought
   a deleted typo back and typed two keys twice. Fixed by `f6ab09fd`: a walk that
   stops says so, and that pair takes no base from the listing, at the top
   or at any criss-cross level. While the note is typed in, it waits for the
   next try (`deferred reason=history_budget_wait`), as an exhausted
   criss-cross level already did; otherwise both texts are kept, the note
   and one copy (`unmerged reason=history_budget`).
10. **The same-place judge passed a note whose untouched lines had changed**
    (review of `8fc0bf43`, finding 2). Its pass checked every typed key on
    line 3 and left out `fixed_lines`, which it computed. Fixed by `92ddfdbe`:
    the pass needs the fixed lines, and before judging a run the driver
    judges a kept note and the same note with its fixed lines changed, and
    stops unless it tells them apart. Judged again, all 22 recorded
    same-place and keyboard runs hold their fixed lines: no result here
    rested on the gap.
11. **Two plugins' stamps of one line joined into a time neither wrote**
    (this PR's CI at `8fc0bf43`: `stamper.test.mjs:243`, a rewrite storm
    paused after 11 or 12 versions where the bound is 10). Since `ccd0f828`
    the hold for a plugin's automatic rewrite (#179) took two sides as
    meeting only where they changed one character differently. Two stamps
    of `updated:` that rewrote different digits of one time joined cleanly
    -- `05.010Z` and `06.000Z` over `05.000Z` made `06.010Z` -- and the storm
    went unseen for that round: of 148,682 sampled pairs of stamps, 24,702
    joined that way. Fixed by `844c8e4a`: the hold is judged per line, the
    changes that share a line taken together and compared by what the line
    reads on each side; the same sample joins none. People's typing is not
    judged by it and still merges letter by letter.

## Journeys and timings

| Row | Session | Result | Observed |
| --- | --- | --- | --- |
| V2 pair a phone | 4, 5 | pass | Both sessions paired through the dialogs, codes compared by independent renderers. |
| V2 pair a phone | iPhone 1-4 | pass | Paired through the dialogs; the code the phone showed matched the desktop's. |
| A desktop's note, then typing on the iPhone | iPhone 1-4 | pass for obsync | Every published text equalled the phone's screen. Defect 7 is Obsidian's: it also happened with obsync off (session 4, T2). Exact without a tap before Cmd+Down. |
| Two people typing in one note, on an iPhone | iPhone 4 | fail | Defect 8 in runs 2 and 4, where both typed in one word; runs 1 and 3 exact; both devices converged every time, with no copy. |
| Two people typing in one note, on an iPhone | iPhone 6, `9ca63459` | pass | Eight runs, seven of them in one word: 135 phone keys and 76 desktop keys, every one kept, both devices converged, no copy. |
| V3 typing on a phone shows elsewhere within 3 s | 4 | fail | Cotype journey, 147 keystrokes each way: desktop to phone p50 1,068 ms, p95 1,724 ms, max 3,577 ms; phone to desktop p50 1,040 ms, p95 2,029 ms, max 3,634 ms. |
| V3 | 5 | pass | Desktop to phone p50 940 ms, p95 1,345 ms, max 1,602 ms; phone to desktop p50 952 ms, p95 1,372 ms, max 1,778 ms. |
| Cotype journey, 1.5 s for every keystroke | 1, 4, 5 | fail | 5 / 5, 15 / 15, and 2 / 3 keystrokes over 1.5 s (desktop to phone / phone to desktop); none missing. |
| Two people typing at one place (this record's scenario) | all | pass on `5544d0ec` and `c8855743` | The results table: no copy, and no lost, doubled or returning key, in any run of the final build. |
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
| The iPhone word hold's, 15 (M4237–M4251) | `9ca63459` | its 10 tests, 10 / 10 | 15, each by the test written for it | 0 |
| Round six's, 35: 12 new (M4252–M4263), 18 re-cut, and M4201–M4203, M4221, M4223 measured again | `f6ab09fd` | the whole suite 2,240 / 2,240, or the targeted files 68 / 68, 20 / 20, 34 / 34 | 33 | 2: M848, M851 |

The seven survivors' kills were measured against the tests that kill them,
with the source restored from a copy after each. M3298 and M3300 are retired:
the order M3298 pinned no longer decides anything, and the check M3300
removed is the one `436c2bb5` deletes because `canRefresh` already makes it.
All 2,042 mutants apply at `436c2bb5`. The word hold's 15 ran in a scratch
copy against the tests that target them; the hold moved the context of M4116
and M4146, which are re-cut as one-line hunks and still killed by the whole
suite (M4116: 10 tests failed and one timed out; M4146: 4 failed), and all
2,057 apply at `9ca63459`.

Round six's ran the same way in a scratch copy of `f6ab09fd`'s tree, each
against the whole suite or the test files written for it, as the commit
bodies list. The three gates that read the per-line rule (M4201–M4203)
were run against the whole suite again. M848 and M851, the listing put back
after a stopped walk, survive the whole suite: after a stopped walk no base
is taken from either list, so the restore now decides only which listed
ancestor names a closing of identical heads, and no test reaches that. It
is kept, since it is not shown redundant. M4223 is counted by the test
written for it, run alone; against its whole file it exhausts the heap at
the 29th test, a cycle, which is not counted. M4196 and M4197 are retired
with the character-level contest they mutated. All 2,067 apply at
`f6ab09fd`. The whole set has not been run again at one final commit.

## What was not validated

- **iPhone acceptance beyond co-typing.** Six iPhone sessions paired,
  settled defect 7 as Obsidian's, found defect 8 and kept every key with its
  fix in eight short co-typing runs. No background, offline or leave
  journey, and no timed co-typing journey, ran on an iPhone, and every iPhone
  key came from a hardware keyboard through iPhone Mirroring, none from the
  on-screen one. Every other phone result is an Android emulator. Nothing here
  speaks for an iPad, though the word hold applies there too, or for a
  physical Android phone, where nothing is held.
- **A production route.** Loopback for the desktops, a public quick tunnel
  for the phone; no deployment behind the user's terminator, no
  TLS-inspecting proxy.
- **Relay within 1.5 s for every keystroke.** The cotype journey fails that
  budget over the tunnel in every session here, as most samples did before
  this work; the median is about one second. The desktop latency scenario
  passes over loopback.
- **A prompt return from the background on Android.** See the journey rows.
- **Ancestry past the read budget, live.** In the final 600 s desktop run
  on `5544d0ec` one device's held ancestry reached its 8 MiB budget and one
  merge read 64 versions and stopped (`merge_ancestry_limit`). That build fell
  back to the listed base, and that run's text stayed exact; since defect 9's
  fix such a pair waits while typed in and is otherwise kept as two texts. No
  run here has met that path on the fixed build: its evidence is the tests.
- **The same text typed at one place by both people at one moment.** Kept
  once, not twice: two insertions where one is the start of the other combine
  into the longer one, by design of the merge.
- **The lab's own dialogs.** Obsidian's vault-trust dialog, opened by the
  lab's settings step, stood over the phone's vault after pairing in one
  session and was dismissed as a person would; it is Obsidian's, not obsync's.
- **The in-app Obsidian version on the desktops** during the runs.
- **Restart, offline, rename, folder, large-file and every other journey not
  in the table**, on this build.
