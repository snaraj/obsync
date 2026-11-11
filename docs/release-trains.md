# Release trains after 1.1.5

Owner agreed on 2026-10-03 to retain the proposed groups and continue the
**v1.1.x patch train**. The [scope record](https://github.com/snaraj/obsync/issues/254#issuecomment-5973109483)
supersedes the descriptive milestones and proposed 1.2.0 start. These assignments
are applied on GitHub; they describe planned delivery, not completed acceptance.

| Release | Scope | Issues |
| --- | --- | --- |
| [v1.1.6](https://github.com/snaraj/obsync/milestone/31) | Native Rust CLI discovery, contexts and verified installation | #255 |
| [v1.1.7](https://github.com/snaraj/obsync/milestone/33) | First-sync writes, background performance, load-test regressions, measured pipeline/design work and CLI usability | #274, #277, #283, #319, #325, #329 |
| [v1.1.8](https://github.com/snaraj/obsync/milestone/37) | End-to-end encryption assurance, strict recovery, client key custody, configurable device revocation and build/CI dependency updates | #344, #346; dependency PRs #348–#355 |
| [v1.1.9](https://github.com/snaraj/obsync/milestone/38) | Security dependency repairs: Node build runtime, server trust bundle and documentation certifi | #357, #362, #363 |
| [v1.1.10](https://github.com/snaraj/obsync/milestone/39) | Maintenance: dependency updates, CI flake repairs, dashboard language and control contrast, neutral documentation, comment cleanup outside the plugin | #328, #338, #341, #343, #359, #360, #361, #366 |
| [v1.1.11](https://github.com/snaraj/obsync/milestone/40) | Force sync with the server, a copyable recovery backup with a direct way back to the encryption upgrade, and pairing again after a missed encryption upgrade | #364, #369, #370 |
| [v1.1.12](https://github.com/snaraj/obsync/milestone/41) | Pairing again after a rotation without a false upload question, and the mobile harness tests' disk-space dependence | #373, #376 |
| [v1.1.13](https://github.com/snaraj/obsync/milestone/34) | One folder record per folder id, conflict notices grouped per note, a too-large file refused before upload, plain HTTP refused at the transport, a stopped status, a revoked device's addresses deleted after 30 days, quieter server logs, and the Node and Rust builder images | #321, #330, #340, #341, #375, #386, #387; dependency PRs #372, #381 |
| [v1.1.14](https://github.com/snaraj/obsync/milestone/35) | Management authentication, existing-server setup, device lifecycle, MCP observe, readable logs, pairing confirmation and physical-phone blind-start/readback evidence, remaining concurrent-input timing, and final integrated acceptance | #254, #256, #257, #258, #261, #262, #290, #314, #339 |
| [v1.1.15](https://github.com/snaraj/obsync/milestone/32) | Deferred export, storage/deployment, backup/recovery and co-editing engine | #259, #260, #315, #317 |
| [v1.1.16](https://github.com/snaraj/obsync/milestone/36) | Large-file limits, mobile streaming and measured device ceilings | #331, #332 |

#325 separates the immediate measurements, pipeline improvements, reviewed
state/migration design and bounded experiments from #315's later engine. Its
experimental engine code does not ship in 1.1.7. #319 moves out of the deferred
bucket into 1.1.7. #254 and #262 close only after the integrated 1.1.14 management
train's public artifact and live acceptance; the explicit 1.1.15 work stays open.

Owner decision, 2026-10-12: ship the security train (#344, #346, PR #347)
first as **v1.1.8**, and move the previously agreed v1.1.8–v1.1.11 trains
forward one patch version. Their issue memberships remain unchanged; the
pairing/phone train includes #339 and #340 from the owner's 2026-10-09 ruling.
The large-files train (#330, #331, #332) was agreed on 2026-10-05. This ordering
changes no acceptance requirement and does not assert that any train is ready.

Owner decision, 2026-10-13: include all six open Dependabot PRs (#348–#353)
in the same **v1.1.8** security artifact PR (#347). This updates the Node
build runtime/image to 26.11.1, the Rust builder image to 1.99.0, CodeQL
actions to 4.38.3, setup-node to 7.1.0, upload-artifact to 7.0.2 and
download-artifact to 8.0.2. The repository Rust compiler stays pinned to
1.98.0 independently of its builder image. These changes require coherent
pins and fresh composed validation; the six PRs do not publish separate
releases. Later release memberships and numbering remain unchanged.

Owner decision, 2026-10-19: include the two newer open Dependabot updates,
#354 (Node 26.12.0, retaining npm 11.20.0) and #355 (CodeQL 4.39.0), in the
same **v1.1.8** artifact. These supersede the earlier Node and CodeQL pins;
the other dependency updates and the Rust compiler pin remain unchanged.

For this release only, the owner waived physical-phone verification as a
merge gate. The three unattended Android-emulator/native-desktop runs in
[the measured record](validation-runs/2026-10-17-unattended-mobile-acceptance.md)
remain emulator evidence. Physical-phone acceptance remains **NOT_RUN**;
the waiver does not establish iOS, stock Android, OEM lifecycle or
hardware-backed credential-storage behavior. The general physical-device
requirement and later trains are unchanged. Required CI and independent
approval of the final commit still apply.

Owner decision, 2026-11-01: ship security issues **#357, #362 and #363**
first as **v1.1.9**, moving the previously agreed v1.1.9–v1.1.12 groups
forward one patch to v1.1.10–v1.1.13. Their issue memberships and acceptance
requirements are unchanged. This is the scoped dependency repair release;
it does not claim completion of the later feature groups.

Owner task, 2026-11-01 (backlog to zero, delivered through merge trains):
ship the maintenance train (#328, #338, #341 F1/F2, #343, #359, #360, #361,
#366) as **v1.1.10**, moving the agreed v1.1.10–v1.1.13 groups forward one
patch to v1.1.11–v1.1.14. Their issue memberships and acceptance requirements
are unchanged.

Owner request, 2026-11-01: the owner's phone fell out of step with the server,
and the owner asked for Force sync (#369) and for the phone to sync again,
which needed #370 (a device that missed an encryption upgrade could not pair
again). Both ship with #364 as **v1.1.11**, moving the agreed v1.1.11–v1.1.14
groups forward one patch to v1.1.12–v1.1.15. Their issue memberships and
acceptance requirements are unchanged; the owner confirmed the move on
2026-11-02.

Owner decision, 2026-11-02: for 1.1.11 the owner waived physical-phone
verification as a merge gate. A candidate reaches the owner's phone only
through a download served from the laptop, which the owner's operating rules
forbid. The desktop record
([2026-11-02](validation-runs/2026-11-02-train-1.1.11.md)) stands. The
physical-phone journey runs on the published release right after
publication: the owner's iPhone, removed by the encryption upgrade, pairs
again with its older key kept, then Force sync. It is recorded, and a failure
there is fixed in the next patch. The waiver establishes no iPhone
behaviour; the general physical-device requirement and later trains are
unchanged.

Owner request, 2026-11-02: pairing the owner's iPhone again on 1.1.11 asked
to upload 149 notes the server already held (#376). The fix ships with #373
as **v1.1.12**, moving the agreed v1.1.12–v1.1.15 groups forward one patch
to v1.1.13–v1.1.16; their issue memberships and acceptance requirements are
unchanged. From v1.1.12 an Android emulator running the official Obsidian app
may stand in for the phone (AGENTS.md step 7). For 1.1.12 itself the owner
chose to skip the pre-merge phone and emulator journeys: the owner's iPhone
pairing again on the published release is its phone journey, recorded
afterwards, and a failure there is fixed in the next patch.

Composition, 2026-11-10, directed by the coordinator for the 1.1.13 train:
**v1.1.13** carries #375, #340 and #330 (narrowed on 2026-11-02 to refusing a
too-large file before any upload); #321's small slice (answered probes at
debug, one `device_joined` line); #341's follow-ups (a revoked device's
addresses deleted after 30 days, the Privacy navigation entry, the stale
wording); #386 and #387, found in its release audit; and the builder images
(#381, #372, carried by hand). #321, #330 and #341 move to the v1.1.13
milestone; #321 keeps its larger catalogue open, and #330's lifted-ceiling
work stays with #331 and #332. #290 (live pairing confirmation), #314 (phone
readback) and #339 (concurrent typing) need phone sessions and move to
**v1.1.14**, their issues and acceptance unchanged.

## Composition and acceptance

Each numbered release is assembled into one artifact PR before owner merge.
Internal work branches can remain separate during implementation and review.
This preserves automatic publication on an artifact merge while keeping the
approved train intact. Documentation-only changes do not publish a version.
The release order follows the table; no date or completed capability is promised.

- 1.1.6 requires real Windows/Linux/macOS CLI acceptance, visible manual checks,
  independent context/install readback and verified public installation.
- 1.1.7 requires measured before/after results, bounded-load regression proof,
  reviewed design and applicable desktop/phone sync evidence.
- 1.1.8 requires the security claim-to-evidence map, required confidentiality
  regressions, encrypted local custody or pre-persistence refusal, native
  desktop acceptance and the recorded unattended Android evidence, verified
  dependency pins and composed build/CI compatibility, and exact-head
  independent approval. Physical-phone verification has the release-specific
  owner waiver above; it is not reported as passed.
- 1.1.9 requires vulnerable-baseline and repaired Node controls, verified trust-bundle
  contents, composed build gates, independent exact-head review, authenticated
  artifacts and live server delivery. It introduces no new product behavior.
- 1.1.10 requires composed build gates, a shipped `main.js` and `styles.css`
  byte-identical to 1.1.9's (so no device journey is owed), independent
  exact-head review, authenticated artifacts and live server delivery. It
  introduces no new plugin behavior.
- 1.1.11 requires the plugin's desktop and physical-phone journeys (pairing again
  after a key rotation, the pending-transition restart, Force sync) recorded in
  `docs/validation-runs/`, composed build gates, independent exact-head review,
  authenticated artifacts and live server delivery. Physical-phone verification
  has the release-specific owner waiver above and runs on the published release.
- 1.1.12 requires the #376 failure and its repair shown against the live
  server's evidence and the plugin suite, composed build gates, independent
  exact-head review, authenticated artifacts and live server delivery. Its
  phone journey has the release-specific owner decision above.
- 1.1.13 requires composed build gates, its desktop validation runs (#375 on a
  case-folding filesystem, #290's live pairing during a long first sync)
  recorded with what they do not show, independent exact-head review,
  authenticated artifacts and live server delivery. #340's native visual
  proof while typing stays open on that issue.
- 1.1.14 requires the integrated CLI, native Obsidian and real MCP-host journeys,
  applicable security/performance gates and exact public artifact proof, and
  pairing-state readback and physical-phone acceptance for #290, #314 and #339;
  emulator rehearsal is supplemental evidence.
- 1.1.15 depends on the reviewed designs and retains every deferred security,
  recovery, native-device, mixed-version and convergence requirement.
- 1.1.16 requires measured size and watermark boundaries, mixed-version
  refusals and real-phone evidence before raising advertised limits.

Security, E2EE, durability and performance requirements remain unchanged.
The owner added CLI help, diagnostics and XDG defaults (#329) during the
1.1.6 delivery handoff on 2026-10-04; its existing machine interface stays stable.
Each capability needs its applicable V01–V19, S01–S12 and P01–P10 evidence from
the [acceptance plan](validation-plans/cli-mcp-v1.1.6.md). Deferred capabilities
remain visibly unsupported until delivered. No unit-test or CI result substitutes
for a required live observation.

Later additions, moves, deferrals or renumbering require owner agreement on the
exact issue list, recorded here and in the milestones, per [AGENTS.md](https://github.com/snaraj/obsync/blob/main/AGENTS.md).
Newly discovered work remains explicitly unassigned until that decision.
