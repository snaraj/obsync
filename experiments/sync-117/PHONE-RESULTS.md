# Physical iPhone rehearsal, 2026-10-05

**Concurrent typing failed.** Pairing, ordinary transfers, background/reopen,
app relaunch, bounded server-interruption recovery and observed Leave behavior
completed on the physical phone. This replaces the previous control blocker;
it does not erase those failed attempts or establish release readiness.

The desktop/server source was `6b56e7dbb00427e90c38740407d7289b04bf5321`,
with driver source `7768a6d672c7b3b132b14d2546fa160386f2ab01`. The built
desktop plugin SHA-256 was
`8f6b05d7dd8f589c4781f117d0ce37eabd9bd0f8cd4ffe2751200c53ee9028ed`;
server SHA-256 was
`7c05a4bb731d85fb50c81db7bd2c8888df85fb89e2a63c8710126a545d7d8534`.
The existing synthetic phone vault showed Obsidian 1.13.7 and plugin 1.1.7.
Its installed bytes were **not independently hashed**. This was a fresh server
account, not a fresh iOS profile. Normal HTTPS validation stayed enabled on the
authorized temporary relay; no production account or provider account changed.

## Native observations

| Journey | Result and independent evidence |
| --- | --- |
| Pair | Phone Check reached the server. The phone's comparison was read independently and matched at creator approval. The single known synthetic note's upload was confirmed. Phone settings and creator enrollment both completed. |
| Initial two-way edit | `Desktop control 42` arrived on the phone; native `phone7` arrived in the desktop editor and disk. iOS later capitalized it to `Phone7` on blur; both devices reflected that edit. |
| Concurrent edit | 26 trusted desktop insertions, zero untrusted; 26 paced phone characters. Input intervals overlapped by 8,997 ms. The fixed 120-second observer failed the complete-stream and one-file predicates. |
| Background/reopen | A new desktop marker appeared after reopening, then `phone8` returned to the desktop editor/disk. A transient changes-could-not-be-read notice appeared on foregrounding; no setup or re-pairing was required. |
| Interruption | Only the exact owned test server was paused, with a 120-second automatic-resume bound. Phone `offline9` was visibly pending and absent from the desktop before resume; afterward it arrived automatically and both screens agreed. Independent offline iOS disk bytes were unavailable. |
| Relaunch | Only the synthetic Obsidian card was dismissed; the launch splash was observed. A fresh desktop marker and phone `phone6` crossed afterward without re-pairing. No independent iOS process identity was measured. |
| Leave | The exact phone enrollment became revoked while the creator remained active. Phone settings showed a blank server field and not paired. Its seven-line roundtrip note stayed visible, and 13 files remained. All 13 desktop note hashes stayed unchanged. No all-file iOS hash claim follows. |

The original concurrent note ended identically on both screens and in the
desktop file with suffix `abcdefghijklmnopqrABCDEFGHIJKL`: 30 of the 52 typed
characters, plus ten conflict copies. Its final file SHA-256 was
`87a2f5d076f1136585de0c6063c59c6cde27938a09b3e54f96052730726f9b4a`.
Both complete input streams existed in retained copies. The result proves
displacement and an unusable same-note experience, not permanent loss of all
copies of those characters. The desktop driver repositioned its caret on each
input; smooth cursor behavior was not proved. No paired baseline or measured
iOS artifact identity exists, so this is not an attributed candidate regression.
The separately agreed character engine remains #315; no engine code ships here.

Thirty-one finite synthetic plaintext/filename probes found zero matches in
35 owned server files (117,670 bytes). This is a bounded store observation,
not a general encryption, metadata-privacy or provider-billing proof. Native
screens were inspected throughout and both retained desktop captures were
opened after capture. UI navigation/tool delays prevent latency claims from
these roundtrips; no baseline speedup or private-path performance is claimed.

## Reproduce and clean up

Use [PHONE.md](PHONE.md), `phone-preflight.py`, `phone-session.py`,
`phone-pair.mjs`, `phone-peer-note.mjs` and `phone-cotype.mjs`. The external
run `2026-10-05-phone-resume-2011-native/evidence/` preserves driver hashes,
input traces, creator decisions, final-byte predicates, conflict contents,
lifecycle observations, privacy probes and separate cleanup receipts.
`acceptance-summary.json` indexes them. No old manifest, code or URL is reusable.

The controller exited zero. Both relays, all owned process groups, credentials,
runtime, private data, live manifest and copied session inputs were removed.
The held clipboard was restored. Hash/ownership/open-handle checks preceded
removal of another 44,722,664 bytes of copied preparation/build artifacts.
Candidate source stayed clean. On the phone, Manage vaults closed the fixture;
Files Get Info verified its exact location before recoverable deletion, then
Recents and the device-location search showed no result. Recently Deleted was
not purged. No download was used in this attempt; previous downloaded fixtures
were already absent. The previously inspected non-test Safari tab was preserved.
Historical ownership-uncertain fixtures are outside this cleanup claim.
