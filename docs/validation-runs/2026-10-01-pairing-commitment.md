# 2026-10-01 Pairing with a commitment: desktops, an intermediary, an iPhone

Agent-operated, for the user, on the user's computer, with two disposable
loopback servers and six disposable vaults in isolated Obsidian profiles,
then a seventh disposable vault on the user's iPhone, driven through iPhone
Mirroring with the user present. None of the user's own vaults took part.
This run validates the pairing repair that answers the review of `c077ac52`
(finding 1): the code commits to the creator's key, the creator fixes the
claim before revealing that key, the match code covers both keys, and 1.1.5
pairs no other way (`docs/protocol.md`, "Pairing v2: one way only").

## Builds

| Name | Hash (SHA-256) | Source |
| --- | --- | --- |
| obsyncd | `1db8cc9bd95439a8…` | `cargo build --release -p obsyncd` at `eaa0fbc6` |
| 1.1.5 plugin `main.js` | `d6cdece6acd7289b…` | `npm run build` at `eaa0fbc6` |
| 1.1.4 plugin `main.js` | `19d3202059551d72…` | `npm run build` on the source of tag `1.1.4`, read with `git archive`, nothing downloaded |

Obsidian 1.13.4 on macOS, each instance with its own `--user-data-dir` and
a DevTools port, driven in-page; every setup token and pairing code went from
a 0600 file into the page and was never printed. The servers listened on
loopback over plain HTTP (`OBSYNC_EDGE=none`).

The iPhone leg (P6 to P8) ran the same bytes, rebuilt at `c06e9cfd`: both
hashes above came out identical. The phone reached the loopback server over
HTTPS through a quick tunnel, and its vault arrived as a zip over a second
one; both tunnels were stopped when the leg ended.

## The intermediary

A lab proxy (Node, `node:http`) sat between one new device and the server,
standing in for an attacker on the HTTPS path who also read the code. It
rewrote one field per leg, with another valid P-256 key (a published
test-vector point), and logged each rewrite:

- **reveal**: the `creator_pub` the new device's `409 not_approved` wait
  carries;
- **claim**: the `claimant_pub` the new device's claim carries.

## Legs

| Leg | Devices | Observed | Result |
| --- | --- | --- | --- |
| P1 pairing | A creates, B claims, both 1.1.5 | A's code: 128 base32 characters. B's dialog: the intro, "Claiming the pairing…", then "Waiting for your other device. When it asks you to approve this device, a code appears here: …" with no digits, then the code, 2.2 s after Pair. A's prompt showed the same six digits. Approve; B asked "Add this vault's notes" (1 note), Pair and upload; B paired. A note written on A was on B in 0.8 s, one written on B was on A at the first read. Both read `obsync: idle` and held the same four notes. Server: `pairing_revealed`, `pairing_approved`, `pairing_collected`. | pass |
| P2 an older new device | A (1.1.5) creates, C (1.1.4) claims | C read the code's first 64 bytes, as 1.1.4 does, and showed an old-style code at once. A showed no code and no Approve: "That device runs obsync older than 1.1.5, which pairs in a way that no longer protects your vault key, so it was refused and nothing was shared. Update obsync on it, then make a new code here." Server: `pairing_rejected`, no `pairing_revealed`. C: "The other device did not approve this device: …". | pass |
| P3 an older creator | D (1.1.4, its own server) creates, E (1.1.5) claims | D's code: 103 characters. E: "Claiming the pairing…", then "That code comes from a device running obsync older than 1.1.5, which pairs in a way that no longer protects your vault key. Update obsync on that device, then make a new code there with Pair a new device." The server received no claim. | pass |
| P4 a changed creator key | A creates, F claims through the proxy (reveal) | Proxy: `rewrote not_approved.creator_pub`. F showed no code at any point and ended: "The other device's key does not match the code this device was given, so pairing stopped and nothing was shared. Someone may have changed it on the way: choose Reject on the other device, …". A showed its prompt with a code; with no code beside it, Reject. Server: `pairing_revealed`, `pairing_rejected`. | pass |
| P5 a changed new-device key | A creates, F claims through the proxy (claim) | Proxy: `rewrote claim.claimant_pub`. F checked A's genuine key against the code and showed its code 2.2 s after Pair; A's prompt showed a different six digits. Reject; F: "The other device did not approve this device: …". | pass |
| P6 an iPhone | A (desktop) creates, the iPhone claims, both 1.1.5 | The phone's vault held the plugin and the server address only, so nothing was typed into a plugin field. The user copied A's code with Copy code and pasted it on the phone; the agent typed no code. The user approved on A. The phone: "Approved", "Add this vault's notes" (2 notes), Pair and upload, then `this device is paired, and its first sync is running.` Server: `device_created` (pending), `pairing_revealed`, `pairing_approved` 46.8 s later (the user's comparison), `device_activated` and `pairing_collected` 2.0 s after that. Its only warnings were the 22 `409 not_approved` waits of the approval window. | pass |
| P7 sync, Wi-Fi then cellular | A and the iPhone | The phone's 2 notes were on A at the first read; a note written on A was on the phone at the next look. The user then turned the phone's Wi-Fi off (5G). A note written on A was on the phone at the next look. A note made on the phone reached A as `Untitled.md`, then as its rename `Phone5G.md` with its text, and A held the renamed note alone. Sync status on the phone: `idle`, 4 files tracked, 0 remote-only; the status item a check. | pass |
| P8 leaving | the iPhone | Settings, Leave this server, Leave. The phone: `obsync: this device left the server; every note is still in this vault.` Server: `device_revoked`. The lab vault then went to the phone's Recently Deleted, which is the user's to empty. | pass |

## What was not validated

- **Android**, and the refusal legs on a phone. The iPhone ran the normal
  pairing (P6); the older-version legs (P2, P3) and the intermediary legs
  (P4, P5) ran on desktops only.
- **Windows** and **Linux** desktops, beyond what `desktop-matrix.yml` runs.
- **TLS on the desktop legs.** P1 to P5 spoke plain HTTP on loopback, and
  the intermediary rewrote plain HTTP; only the iPhone leg crossed TLS. The
  2026-09-29 observer proof's passive TLS-inspection capture was not
  repeated on this build; the code's commitment never crosses the network,
  so what that capture could read is unchanged.
- **A chosen collision.** P4 and P5 change a key without searching for one
  that makes the codes agree. The bound for that, one in a million per
  attempt, rests on the order the tests pin and on `docs/protocol.md`, not
  on this run.
- **The hand-off notice** (a new device whose dialog closed raising its
  code as a notice) and a restart dropping a claim an older obsync held
  were not exercised here; plugin tests cover both.
