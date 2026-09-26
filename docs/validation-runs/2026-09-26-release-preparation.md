# Release preparation and HTTPS smoke check, 2026-09-26

Author-operated validation on synthetic data only. The physical phone was
unavailable for the final candidate; no phone acceptance is claimed here.

## Build and route

- Product source: `ac1c934e61d2e77a1a47e5c178649f687f4897ef`, unchanged
  from `0136ddac5741f3340deaa3cc879deb403a8f88ac`.
- Desktop: Obsidian 1.13.7, installer 1.13.4, manually installed plugin
  1.1.3. Hardware model and OS version were not recorded during this run.
- Peer: the real compiled sync engine and HTTP transport with the in-memory
  mobile vault host. This tests the mobile engine path, not native iOS APIs,
  its editor, Files, background execution, or installation.
- Server: a native `obsyncd` build from the same source, isolated storage and
  disposable credentials. HTTPS terminates at a temporary free tunnel; a
  loopback proxy forwards only health and protocol paths plus the QA archive.
  No production server or owner vault was used.
- Both desktop and peer used the HTTPS route. Desktop operations used the
  Obsidian CLI and vault APIs, rather than native typing.
- Plugin bundle SHA-256:
  `ef030cab10b564982eb920d8781b9f8a7f5e01779395a2a1469e11553b4ddedb`.

## Observations

The smoke sequence ran from 19:56:13.280 to 19:56:26.534 UTC. Each check had
a 60-second deadline; no individual arrival-time claim is made.

| Scenario | Result |
| --- | --- |
| Pairing and initial sync | Pass: the emulated mobile peer claimed a new invitation, received its sealed key after desktop approval, and downloaded the two initial synthetic notes. |
| Desktop create | Pass: the native desktop vault created a note and the peer received its exact contents automatically. |
| Mobile edit | Pass: the emulated peer changed that note and the native desktop vault received the exact contents. |
| Desktop rename | Pass: the peer retained the contents under the new name and removed the old path. |
| Peer stop/start | Pass: after its engine stopped, the desktop edited the note; starting the same peer engine caught up automatically. This is not an app or OS restart. |
| Desktop deletion | Pass: deleting the synthetic note removed it from the peer. The peer retained only the two original notes, with no conflict copies. |
| Scoped cleanup | Pass: the emulated device was revoked and its temporary pairing file removed. Desktop/server resources remain solely for the pending native phone run. |

The local receipt is `desktop-mobile-smoke-result.json`. Assertions compare
actual native-vault reads with the emulated peer's files; the fake server is
not used in this check.

A subsequent native desktop inventory also contained exactly the two
original notes. Its paired engine was running and the rewrite fixture was
disabled; that separate receipt is `desktop-ready-state.json`.

## Phone preparation

A credential-free archive contains the exact bundle above, two synthetic
notes, an unpaired HTTPS address setting, and a disabled one-second rewrite
fixture restricted to the synthetic note. Opening its metadata with the
mobile state implementation creates a fresh native-storage identity and
retains no device credential or vault key. The HTTPS download matched the
local archive SHA-256:
`821dbb20d866246f870107e1ecaf1c7ad7bd7b8727e4f309f433513caa72033e`.

An expiring pairing-link route is prepared, with no invitation published
until the phone is present. Installation, native pairing, co-typing, the
five-minute rewrite hold and quiet window, and phone cleanup remain
**not attempted on this final bundle**. All other validation-plan scenarios
are outside this smoke check; earlier records retain their own build scope.

## Local gates

The final local `make check` passed in 226.913 seconds with 1,218 plugin tests, 70 dashboard
tests, 144 core tests, 375 server tests, two CLI tests and 767 contracts.
One core benchmark is intentionally ignored. Rust line coverage was 94.73%;
both working-tree and outgoing-history secret scans were clean. This run
included all three witness repairs and documentation clarifications; its
source and test input hashes were unchanged afterwards. A sandbox attempt
could not bind the HTTP test sockets; the successful run had loopback access.
The [mutation provenance](../../plugin/test/mutants/MEASUREMENT.md) records
the three separate full-suite replacement measurements.

Native phone acceptance, independent approval at the final committed head,
owner merge, exact-main CI, and immutable release publication remain required.
