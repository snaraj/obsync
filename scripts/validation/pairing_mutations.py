#!/usr/bin/env python3
"""Reproduce the #153/#154 server pairing guard probes from the repository root.

Each probe must compile and fail a behavioral regression. Sources are restored
from their exact starting bytes in finally, including on failure or interrupt.
Never run beside another build or source editor in this worktree.
"""
from pathlib import Path
import subprocess

TABLE = "crates/obsyncd/src/api/pairing.rs"
APP = "crates/obsyncd/src/api/mod.rs"
UNCOLLECTED = "an_approved_device_that_never_collects_is_destroyed_at_expiry"
CASES = [
    ("sweep-takes-approved-uncollected", TABLE,
     "if matches!(p.state, State::Claimed | State::Approved)",
     "if matches!(p.state, State::Claimed)", UNCOLLECTED),
    ("collection-activates", TABLE,
     "        activate()?;\n        let envelope",
     "        let envelope", "an_unapproved_claimant_holds_a_secret_and_no_authority"),
    ("approval-does-not-activate", TABLE,
     "    // Approval grants nothing yet:",
     "    app.store.activate_device(&claimant)?;\n    // Approval grants nothing yet:",
     "the_pairing_flow_runs_end_to_end"),
    ("refused-activation-consumes-nothing", TABLE,
     "        activate()?;\n        let envelope = p.envelope.take().ok_or_else(consumed)?;\n        p.state = State::Consumed;\n",
     "        let envelope = p.envelope.take().ok_or_else(consumed)?;\n        p.state = State::Consumed;\n        activate()?;\n",
     "collecting_activates_after_every_check_and_a_refusal_consumes_nothing"),
    ("collection-inside-the-window", TABLE,
     "        if p.expires <= now {\n            return Err(expired());\n        }\n        if p.state != State::Approved {",
     "        if p.state != State::Approved {",
     "a_collection_after_the_ten_minutes_is_expired_and_activates_nothing"),
    ("ended-needs-the-token", TABLE,
     "Some(e) if ct::eq(e.enroll_token.as_bytes(), token.as_bytes()) => expired(),",
     "Some(_) => expired(),", "a_swept_pairing_still_answers_expired_to_its_token_for_an_hour"),
    ("ended-is-consulted", TABLE,
     "return Err(match self.ended.get(id) {",
     "return Err(match None::<&Ended> {", "a_late_claim_reads_as_expired_after_the_sweep"),
    ("ended-ages-out", TABLE,
     ".retain(|_, e| e.expires.saturating_add(ENDED_KEPT_SECS) > now);",
     ".retain(|_, _| true);", "a_swept_pairing_still_answers_expired_to_its_token_for_an_hour"),
    ("ended-is-bounded", TABLE,
     "if self.ended.len() > ENDED_KEPT_MAX {", "if false {",
     "expired_pairings_are_kept_to_a_bound_newest_first"),
    ("ended-evicts-oldest", TABLE,
     "newest.sort_by_key(|(_, e)| std::cmp::Reverse(e.expires));",
     "newest.sort_by_key(|(_, e)| e.expires);", "expired_pairings_are_kept_to_a_bound_newest_first"),
    ("ended-answers-its-creator-only", TABLE,
     "            let e = self.ended.get(id).ok_or_else(unknown)?;\n            if &e.creator != actor {\n                return Err(not_creator());\n            }\n",
     "            let e = self.ended.get(id).ok_or_else(unknown)?;\n",
     "a_swept_pairing_tells_its_creator_how_it_ended"),
    ("ended-remembers-collection", TABLE,
     "let state = if e.consumed {", "let state = if false {",
     "a_swept_pairing_tells_its_creator_how_it_ended"),
    ("sweep-logs-the-ended-state", APP,
     '                ("state", Val::word(ended.as_str())),\n',
     "", UNCOLLECTED),
]


def main():
    originals = {Path(path): Path(path).read_bytes() for _, path, *_ in CASES}
    failures = []
    try:
        for name, path, old, new, selector in CASES:
            source = originals[Path(path)].decode()
            if source.count(old) != 1:
                raise RuntimeError(f"{name}: mutation context moved")
            Path(path).write_text(source.replace(old, new, 1))
            try:
                result = subprocess.run(
                    ["cargo", "test", "-p", "obsyncd", "--lib", selector],
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True, timeout=300, check=False,
                )
                compiled = "could not compile" not in result.stdout
                killed = compiled and result.returncode != 0 and "FAILED" in result.stdout
                print(f"{name}: {'KILLED' if killed else 'NOT A KILL'}", flush=True)
                if not killed:
                    failures.append(name)
                    print(result.stdout, flush=True)
                else:
                    print("\n".join(line for line in result.stdout.splitlines()
                                    if "FAILED" in line or "test result:" in line), flush=True)
            finally:
                Path(path).write_bytes(originals[Path(path)])
    finally:
        for path, original in originals.items():
            path.write_bytes(original)
    if failures:
        raise SystemExit("Unkilled probes: " + ", ".join(failures))
    print(f"All {len(CASES)} server probes compiled and were killed.")


if __name__ == "__main__":
    main()
