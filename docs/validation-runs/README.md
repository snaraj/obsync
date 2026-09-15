# Validation runs

One file per device campaign, named `<date>.md` with the ISO date the run
STARTED: `2026-09-14.md`. A run record is the evidence behind a readiness
claim -- what was exercised, on which real devices, against which server, and
what it measured. `docs/validation.md` is the plan and does not change per
run; these files are the results and are append-only history. A claim that
appears in `CHANGELOG.md`, `README.md`, or a pull-request body and is not in a
run record here has no evidence behind it.

## Required fields

`docs/validation.md` requires every run to record device models, OS versions,
app versions, the server commit, and timings. In practice that is this header
plus one row per scenario:

- **Date and operator role.** The ISO date, and the role that ran it
  (`owner`), never a person's name.
- **Route.** Reference or Compose, per `docs/validation.md` "Routes", and the
  CLASS of TLS terminator in front of the server. The deployment's own tuple
  (proxy, route, certificate) lives in the platform runbook, not here.
- **Server.** The released version under test and the exact source commit the
  running image was built from.
- **Plugin.** The plugin version, and how it arrived: Settings -> Community
  plugins -> Browse, or Community plugins -> Check for updates. A manual file
  copy is not a production-path install, and a record of one says so rather
  than counting as an install result.
- **Devices.** One line per device: model, operating-system version, and
  Obsidian version (1.12.4 or newer). Devices are identified by ROLE -- "first
  desktop", "phone", "tablet" -- never by a device name, serial, or account.
  A field the run did not capture is written `not recorded during the run`
  and left there. Reading it off the device afterwards records TODAY's state
  as though it were the run's, and a value deduced from something else is a
  deduction, not an observation: both are worse than the gap they fill.
- **Scenarios.** Every scenario in `docs/validation.md` with `pass`, `fail`,
  or `not attempted`; the measured timing wherever the pass condition names
  one; and one sentence of what was observed. Silence is not a pass.
- **What was not validated.** The explicit list, closing the record. It is the
  half a later reader trusts the record for.

## Requirement 11 applies to every line

No address, hostname, live-deployment URL, certificate detail, device
identifier, serial, account name, pairing code, setup token, or recovery
phrase -- not in the prose, not in pasted command output, not in a capture
referenced from here. Redact by role. A record that needs a private fact to be
legible is naming the wrong fact: name the class instead.
