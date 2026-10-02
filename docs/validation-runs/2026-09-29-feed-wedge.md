# A desktop feed that stops — 2026-09-29

Issue #276: twice on 1.1.x builds, a desktop's feed stopped taking changes
from other devices and said nothing. This run tried to reproduce it on
origin/main and on the 1.1.5 instrumentation. It did not reproduce, so the
mechanism is unconfirmed. The record covers the attempts, and a live check of
what a held pull chain now says.

## The two reports

- **1.1.4, the security lane's run.** After a Settings window closed, the
  desktop's feed was past its read with its cursor still, the device read
  nothing from the other device again, and **Sync now** did not return. The
  engine's state showed no request open. The cause was inferred from that
  state and not observed.
- **A 1.1.5 train build, Lane H's first sync** (1 of 3 runs). The receiving
  device had applied 82 of a page's 1,000 entries. Two 100 MiB attachments
  were parked for the download lane and one was fully staged. The lane
  waited on the pull chain the page held, and the page waited on something
  that sent no request, for 18 minutes. The plugin log from before the stall
  was not captured.

## Setup

- Obsidian 1.13.4 on macOS 27.0 (Apple silicon). Two isolated profiles, each
  with its own `--user-data-dir`, its own `HOME` and a disposable vault,
  driven through their DevTools ports.
- obsyncd built from afbf7e7 on the Mac's loopback; one series went through a
  local forwarding hop.
- Builds (`main.js` SHA-256):
  - origin/main at afbf7e7:
    `19d3202059551d72f53f3f3a0deaf3eb159971604c1d9fb481f756ac56c28d0c`;
  - the same source with diagnostic log lines added to the pull chain, the
    feed loop and state saves, changing no behaviour:
    `3df902555a050131bb8a2233b8e2dcbd1bb3c9aef5d016924933d2ca718109d6`,
    then `d01d27115a6cbc08821ba980553253e2360cceb297a7e741a673bc97c67f4256`;
  - the #276 instrumentation (58663e8):
    `8cdf71ac94a65ad2695ab1f75bc484313dc7d7d0d08b0e750ed5110daecb0713`.
- The machine was shared with other lanes. The 1-minute load average was
  between 14 and 84 during these runs, and CPU burners (`node -e 'for(;;){}'`)
  ran only inside the run windows named below.

## On origin/main, nothing stalled

| Run | Shape | Build | Load | Result |
| --- | --- | --- | --- | --- |
| B2 | fresh server; A set up, a note written as Settings closes, B paired, one note each way; 4 burners | diagnostic | 17–56 | 12/12 |
| B2, slowed | the same, both rigs at nice 20 | diagnostic | 31–84 | 6/6 |
| B2, hop | slowed, through the hop, the window's focus dropping the long poll first | diagnostic | 22–58 | 15/15 |
| Smoke | one note each way | diagnostic | — | passed |
| Bursts | 20 bursts, 3 notes each way per burst, after a focus that drops the poll, 3 burners | diagnostic | 19–44 | 20/20, 7.2–8.8 s a burst |
| Bursts | 3 bursts, 2 burners | diagnostic | 22–23 | 3/3, 7.2–8.7 s a burst |

Off the rigs:

- **Fuzz.** 60 seeds of 40 random steps each on two paired fake desktops,
  with every version post answered only after its own echo had come back
  through the feed. None stalled.
- **Walk probe.** 200 rounds of the desktop host's sweep and scan side by
  side, over a 300-note vault with 4 burners at load 24–37. The slowest call
  took 102 ms, and no call went past 60 s.

## At the instrumentation, nothing stalled either

| Run | Shape | Load | Result |
| --- | --- | --- | --- |
| Bursts | 20 bursts, 3 notes each way per burst, 3 burners | 16–55 | 20/20, 7.0–9.0 s a burst; no `feed decision=stalled` line |
| B2, hop | 10 runs, slowed, through the hop, 4 burners | 21–63 | 10/10; no stalled line |

## A held chain, before and after

The start's temp sweep was made to wait on a gate in rig A: a pull that
never ends, standing in for whatever held the chain in the reports. Then B
wrote a note, A pressed **Sync now** 31 s after the hold, and the gate
opened at 135 s.

| | origin/main | instrumentation |
| --- | --- | --- |
| Status 25 s after Sync now | `obsync: idle` | `obsync: checking for changes, waiting for the cleanup of interrupted writes` |
| Warnings while held | none in 135 s | one `feed decision=stalled` at 110,004 ms, `chain=sweep:110004 behind=2` |
| **Show sync status**, State | `idle` | the same words as the status |
| B's note on A | absent while held; 316 ms after the gate opened | absent while held; 336 ms after the gate opened |
| Sync now | 105.7 s, silent | 105.8 s, waiting said in the status and at debug |

After the gate opened, both rigs read `obsync: idle` with no notice open.
The one warning left over on both builds was the first device's
domain-map probe answering `404 unknown_file` at setup; the train has
since stopped logging that expected answer as a warning.

## Lane H's shape

A fake test reproduces the shape: a page record's write that never ends,
the lane waiting its turn with one file staged, and a metadata save in
flight. There the line reads
`chain=page:110000 behind=2 pulls=1 step=apply:3:110000 lane=turn staged=1 saving=1`.
The same shape was not run live: that run was stopped at rig start.

## Not covered

- The cause of either report. The line now logged names the pull that holds
  the chain, the record in hand and its step, the lane and a save in flight;
  the next occurrence will say which.
- Windows, Linux and phones: the same engine code, not run here.
- Load above 84.
