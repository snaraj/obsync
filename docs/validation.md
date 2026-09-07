# Device validation plan

Dated 2026-09-07. The MVP is validated when every step below passes on
iPhone, iPad, Windows, and macOS against the reference deployment, plus the
LAN path from a desktop.

## Install (first time, manual by design)

Community-plugin restricted mode must be off. Copy `main.js`,
`manifest.json`, and `styles.css` (downloaded from the dashboard's Install
page or the GitHub Release) into `<vault>/.obsidian/plugins/obsync/`:

- **macOS / Windows / Linux:** Finder or Explorer; then Settings →
  Community plugins → enable obsync.
- **iOS / iPadOS:** the Files app → On My iPhone → Obsidian → `<vault>` →
  `.obsidian` (hidden folders are visible in Files) → `plugins` → create
  `obsync` → paste the three files; restart Obsidian; enable the plugin.
- **Android:** any file manager on the vault folder; same layout.

After the first install the plugin updates itself from the server.

## Scenarios

| # | Scenario | Pass condition |
| --- | --- | --- |
| V1 | Setup on the first desktop; recovery phrase shown and confirmed | account visible in dashboard |
| V2 | Pair iPhone, iPad, Windows from the desktop | each shows in Devices with platform and country |
| V3 | Type in a note on iPhone | appears on the other three within 3 s |
| V4 | Rename and move a folder on Windows | mirrored everywhere, no duplicates |
| V5 | Edit the same note offline on two devices, reconnect | clean merge or a visible conflict copy, never a lost edit |
| V6 | Add a 2 GiB image on macOS | syncs to Windows; iPhone lists it as remote-only under the per-file ceiling |
| V7 | Add a 20 GiB archive on macOS over LAN; kill Obsidian mid-upload; reopen | resumes; fewer than 8 MiB re-sent |
| V8 | Delete a file on iPad | tombstone everywhere; restorable from history within retention |
| V9 | Revoke the iPad from the dashboard | its next request fails; other devices unaffected |
| V10 | Restart the server pod mid-sync | clients resume; `/readyz` truthful during replay |
| V11 | Fill the blob volume to the watermark | uploads refused with a visible message; nothing corrupted |
| V12 | Scrub with one blob corrupted by hand on the host | chunk quarantined, dashboard alert, client re-uploads |
| V13 | Off-LAN sync from iPhone over cellular | works through the tunnel with Access |
| V14 | Dashboard from a phone browser | usable at 390 px wide |

Every run records device models, OS versions, app versions, the server
commit, and timings in `docs/validation-runs/<date>.md`. Captures for the
README come from V2 and V3.
