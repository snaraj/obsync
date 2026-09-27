# Hidden-window uploads — 2026-09-27

Issue #221: on a computer, a change made while Obsidian's window was hidden
took minutes to upload, because a hidden Chromium page slows chained timers to
about one a minute and obsync's upload path waited on them. This run checks the
1.1.4 fix, a worker-backed clock, on a real desktop Obsidian.

## Setup

- Obsidian 1.13.4 (Electron 43.1.1, Chromium 150), macOS 27.0 on Apple
  silicon, an isolated profile with its own disposable vault, paired to a
  local obsyncd over loopback.
- The 1.1.4 train build at 40fa48b, `main.js` SHA-256
  `5a60027793a317a21b528219805f8ca7464322f7b92fc481a4a9ec6dc054fdc3`.
- Driven through the profile's own DevTools port; the window was minimized,
  and `document.visibilityState` read `hidden` before and after the wait.

## Before the fix (recorded when #221 was filed)

In the same kind of hidden window, a note written from outside Obsidian took
about 124 s to be uploaded, a 128 MiB file had not started after three
minutes, and ten chained 100 ms page timers finished after 384 s.

## Observed

1. **No fallback.** With the console captured, reloading the plugin logged no
   `timers decision=fallback` line: the worker clock started.
2. **The clock keeps time while hidden.** After 5 minutes 40 seconds hidden,
   ten chained 100 ms timers on obsync's clock finished in **2.8 s**. The same
   chain started at the same moment on the page's own `window.setTimeout` had
   not finished 15 s later, as #221 predicted for a throttled page.
3. **A change uploads while hidden.** A note written through the vault adapter
   while the window was still hidden was posted to the server **1.5 s** later
   (`POST /v1/files/{file_id}/versions status=201`), and the device read
   `idle` afterwards.

## Not covered here

- Windows and Linux desktops: the same code path, unmeasured on a device in
  this run.
- A large file uploaded while hidden, and the reconnect timer after a server
  restart while hidden: both run on the same clock, covered by unit tests
  (`clock.test.mjs`), not measured live here.
- Phones are unchanged by #221 and were not part of this run.
