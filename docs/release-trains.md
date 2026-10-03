# Release trains after 1.1.5

Owner agreed on 2026-10-03 to retain the proposed groups and continue the
**v1.1.x patch train**. The [scope record](https://github.com/snaraj/obsync/issues/254#issuecomment-5973109483)
supersedes the descriptive milestones and proposed 1.2.0 start. These assignments
are applied on GitHub; they describe planned delivery, not completed acceptance.

| Release | Scope | Issues |
| --- | --- | --- |
| [v1.1.6](https://github.com/snaraj/obsync/milestone/31) | Native Rust CLI discovery, contexts and verified installation | #255 |
| [v1.1.7](https://github.com/snaraj/obsync/milestone/33) | First-sync writes, background performance, load-test regressions and measured pipeline/design work | #274, #277, #283, #319, #325 |
| [v1.1.8](https://github.com/snaraj/obsync/milestone/34) | Pairing confirmation and physical-phone blind-start/readback acceptance | #290, #314 |
| [v1.1.9](https://github.com/snaraj/obsync/milestone/35) | Management authentication, existing-server setup, device lifecycle, MCP observe, readable logs and final integrated acceptance | #254, #256, #257, #258, #261, #262, #321 |
| [v1.1.10](https://github.com/snaraj/obsync/milestone/32) | Deferred export, storage/deployment, backup/recovery and co-editing engine | #259, #260, #315, #317 |

#325 separates the immediate measurements, pipeline improvements, reviewed
state/migration design and bounded experiments from #315's later engine. Its
experimental engine code does not ship in 1.1.7. #319 moves out of the deferred
bucket into 1.1.7. #254 and #262 close only after the integrated 1.1.9 management
train's public artifact and live acceptance; the explicit 1.1.10 work stays open.

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
- 1.1.8 requires pairing-state readback and physical-phone acceptance; emulator
  rehearsal is supplemental evidence.
- 1.1.9 requires the integrated CLI, native Obsidian and real MCP-host journeys,
  applicable security/performance gates and exact public artifact proof.
- 1.1.10 depends on the reviewed designs and retains every deferred security,
  recovery, native-device, mixed-version and convergence requirement.

Security, E2EE, durability and performance requirements remain unchanged.
Each capability needs its applicable V01–V19, S01–S12 and P01–P10 evidence from
the [acceptance plan](validation-plans/cli-mcp-v1.1.6.md). Deferred capabilities
remain visibly unsupported until delivered. No unit-test or CI result substitutes
for a required live observation.

Later additions, moves, deferrals or renumbering require owner agreement on the
exact issue list, recorded here and in the milestones, per [AGENTS.md](https://github.com/snaraj/obsync/blob/main/AGENTS.md).
Newly discovered work remains explicitly unassigned until that decision.
