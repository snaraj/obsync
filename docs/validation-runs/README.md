# Validation runs

*Internals, for contributors and reviewers.*

One file per device campaign, named `<date>.md` with the ISO date the run
STARTED: `2026-09-14.md`. A run record is the evidence behind a readiness
claim -- what was exercised, on which real devices, against which server, and
what it measured. `docs/validation.md` is the plan and does not change per
run; these files are the results and are append-only history. A claim that
appears in `CHANGELOG.md`, `README.md`, or a pull-request body and is not in a
run record here has no evidence behind it.

## Clients

What each client of the MVP set ([validation](../validation.md)) has so far. A
CI job is evidence that the plugin works inside the real application on that
system; it is not a device run, and only a record below is
([Your devices](../setup.md#your-devices)).

| Client | Recorded on a device | Proven in CI |
| --- | --- | --- |
| macOS | Every run below | `desktop-matrix.yml`, `obsidian-macos`: the official Obsidian app, two instances, through setup, pairing, notes both ways, a rename and folders, against the server behind Caddy; `plugin-tests` on macOS |
| iPhone | Every run below | Nothing: no CI job runs a phone |
| iPad | Not yet recorded | Nothing |
| Windows | [2026-09-27](2026-09-27-windows-11-vm.md): Windows 11 on ARM64 in a virtual machine, the 1.1.4 build | `desktop-matrix.yml`, `obsidian-windows`: the same journeys, plus a case-only rename, the trash and a file another program holds open on NTFS; `plugin-tests` on Windows |
| Linux | Not yet recorded | `desktop-matrix.yml`, `obsidian-linux`: the same journeys with the official AppImage, the authority trusted in each instance's own NSS store, and a third instance without it refused |
| Android | Not yet recorded <!-- RUN(1.1.4) Android emulator: the coordinator links the record here --> | Nothing: no CI job runs a phone |

`desktop-matrix.yml` runs nightly and on pull requests that change the plugin
or its harnesses; a red leg there is a finding to read.

## The runs

Newest first. Each record identifies its build and separates what was
observed from what was still outstanding.

- [2026-09-27 Windows 11 desktop](2026-09-27-windows-11-vm.md): the first
  Windows run, Windows 11 on ARM64 against a macOS desktop. 9 of 10 journeys
  pass: notes, a folder rename, case-only renames on NTFS, the trash, a
  linked folder refused, a restore and a conflict with exactly one copy each
  (#222), a 64 MiB file. A renamed selected folder leaves an empty folder on
  the other device (#240, 1.1.5).
- [2026-09-27 hidden-window uploads](2026-09-27-hidden-window.md): native
  desktop, window hidden over five minutes; obsync's clock kept time (ten
  chained 100 ms timers in 2.8 s) and a change uploaded in 1.5 s (#221).
- [2026-09-26 final native phone acceptance](2026-09-26-phone-final.md): exact
  candidate desktop/phone co-typing; reactive rewrite hold, Resume and
  542-second quiet window; automatic fresh-note sync; phone restart;
  vault rename/move; phone typing through remote deletion; scoped cleanup.
  Interrupted and imperfect attempts, unmeasured notice behavior, and the
  partial desktop process-restart scope are retained explicitly.
- [2026-09-26 release preparation](2026-09-26-release-preparation.md): native
  desktop with an emulated mobile peer over disposable HTTPS; exact phone
  archive prepared, native phone acceptance still outstanding.
- [2026-09-25 editor refusal and merge budget](2026-09-25-editor-budget.md):
  retained matched-build typing failure, refused-write accounting repair,
  1,200-test gate, nested mutation reporting repair and qualified desktop
  rewrite control; repaired phone acceptance and cleanup remain outstanding.
- [2026-09-25 three-device typing follow-up](2026-09-25-passive-peer-typing.md):
  adjacent-block and passive-receiver failures, their automated repairs,
  mixed-build native controls, and the final phone installation checkpoint.
- [2026-09-25 native editor-save follow-up](2026-09-25-native-editor-save.md):
  retained same-line failures, adjacent-line passes, and the active-editor
  retry repair with its automated evidence and outstanding native gate.
- [2026-09-24 native desktop checks](2026-09-24-native-1.1.3.md) for the 1.1.3
  candidate.
- [2026-09-24 account recovery](2026-09-24-account-recovery.md): setup token
  plus recovery phrase re-enrollment.
- [2026-09-24 pairing and delete-versus-edit](2026-09-24-pairing-and-deletion.md).
- [2026-09-24 delete-versus-edit decision](2026-09-24-delete-edit-research.md):
  the edit-wins behaviour chosen, and how other tools document it.
- [2026-09-24 repeated-rewrite recovery](2026-09-24-rewrite-storm.md), with
  follow-ups for [the Resume copies](2026-09-24-rewrite-storm-resume.md),
  [a passive open editor](2026-09-24-rewrite-passive-editor.md) and
  [the typing editor's hold](2026-09-24-rewrite-editor-overlap.md).
- [2026-09-24 native iPhone acceptance](2026-09-24-phone-candidate.md): current
  1.1.2 installation, identical first sync, two-way edits, offline restart and
  automatic recovery.
- [2026-09-24 phone candidate 1.1.3](2026-09-24-phone-1.1.3.md): separate
  candidate installation and current native acceptance scope, with its
  [timing and first-sync follow-up](2026-09-24-phone-timing-followup.md).
- [2026-09-24 replacement-build device follow-up](2026-09-24-replacement-device-followup.md):
  exact repaired 1.1.2 desktop with the final 1.1.3 phone, identical offline
  notes and automatic recovery.
- [2026-09-24 review regressions](2026-09-24-review-fixes.md): the automated
  checks behind two review repairs.
- [2026-09-24 co-typing with delayed receipts](2026-09-24-cotyping-delayed-ack.md):
  pristine-baseline failure, deterministic reproductions and repair;
  simulation boundaries stated.
- [2026-09-24 co-typing publication order](2026-09-24-cotyping-order.md):
  delayed uploads, loop-budget regressions and retained failed schedules.
- [2026-09-24 historical catch-up and typing repairs](2026-09-24-history-and-typing.md):
  bounded history replay, adjacent line edits, same-line appends and preserved
  safety witnesses.
- [2026-09-24 screenshot privacy repair](2026-09-24-screenshot-privacy.md):
  opaque masks, metadata removal and unchanged visible evidence.
- [2026-09-24 arrival timing and shared merge bases](2026-09-24-arrival-and-shared-base.md):
  background Resume roles, continued typing, shared-text duplication and
  retained failed schedules.
- [2026-09-24 scenario battery, first sitting](2026-09-24.md): an iPhone and a
  desktop on one network, plus isolated desktop instances; what bears on 1.1.2.
- [2026-09-23 same network, a laptop as the server](2026-09-23.md): the Compose
  route end to end for 1.1.1, the phone's certificate install included.
- [2026-09-21 user journeys on 1.0.3, then 1.0.4](2026-09-21.md): a day's
  vault work over a private route, and the in-app plugin update.
- [2026-09-20 private route](2026-09-20.md): pairing and both edit directions
  on the 1.0.0 server over a private route to a cluster.
- [2026-09-14 same network](2026-09-14.md): the 1.0.0 server on the Compose
  route.

## Required fields

`docs/validation.md` requires every run to record device models, OS versions,
app versions, the server commit, and timings. In practice that is this header
plus one row per scenario:

- **Date and operator role.** The ISO date, and the role that ran it
  (`owner`), never a person's name.
- **Route.** Kubernetes or Compose, per `docs/validation.md` "Routes", and the
  CLASS of TLS terminator in front of the server. The deployment's own tuple
  (proxy, route, certificate) stays with the person who runs it, not here.
- **Server.** The released version under test and the exact source commit the
  running image was built from.
- **Plugin.** The plugin version, and how it arrived: Settings -> Community
  plugins -> Browse, or Community plugins -> Check for updates. A manual file
  copy is not a production-path install, and a record of one says so rather
  than counting as an install result.
- **Devices.** One line per device: model, operating-system version, and
  Obsidian version (1.13.0 or newer). Devices are identified by ROLE -- "first
  desktop", "phone", "tablet" -- never by a device name, serial, or account.
  A field the run did not capture is written `not recorded during the run`
  and left there. Reading it off the device afterwards records TODAY's state
  as though it were the run's, and a value deduced from something else is a
  deduction, not an observation: both are worse than the gap they fill.
- **Scenarios.** Every scenario in `docs/validation.md` with `pass`, `fail`,
  or `not attempted`; the measured timing wherever the pass condition names
  one; and one sentence of what was observed. Silence is not a pass.
  The user journeys of that plan are recorded in this same file, as `J` rows
  beside the `V` rows and to the same standard.
- **What was not validated.** The explicit list, closing the record. It is the
  half a later reader trusts the record for.

## Requirement 11 applies to every line

No address, hostname, live-deployment URL, certificate detail, device
identifier, serial, account name, pairing code, setup token, or recovery
phrase -- not in the prose, not in pasted command output, not in a capture
referenced from here. Redact by role. A record that needs a private fact to be
legible is naming the wrong fact: name the class instead.
