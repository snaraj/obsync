#!/usr/bin/env python3
"""Reproduce the #153/#154 server pairing guard probes from the repository root.

Each probe must compile and fail a behavioral regression. Sources are restored
from their exact starting bytes in finally, including on failure or interrupt.
Never run beside another build or source editor in this worktree.
"""
from pathlib import Path

from kills import Judge

TABLE = "crates/obsyncd/src/api/pairing.rs"
APP = "crates/obsyncd/src/api/mod.rs"
UNCOLLECTED = "an_approved_device_that_never_collects_is_destroyed_at_expiry"
CASES = [
    ("sweep-takes-approved-uncollected", TABLE,
     "if matches!(p.state, State::Claimed | State::Approved)",
     "if matches!(p.state, State::Claimed)", UNCOLLECTED),
    ("collection-activates", TABLE,
     "        activate()?;\n        let (envelope, nonce)",
     "        let (envelope, nonce)", "an_unapproved_claimant_holds_a_secret_and_no_authority"),
    ("approval-does-not-activate", TABLE,
     "    // Approval grants nothing yet:",
     "    app.store.activate_device(&claimant)?;\n    // Approval grants nothing yet:",
     "the_pairing_flow_runs_end_to_end"),
    ("refused-activation-consumes-nothing", TABLE,
     "        activate()?;\n        let (envelope, nonce) = p.envelope.take().ok_or_else(consumed)?;\n        let creator_pub = p.creator_pub.take();\n        p.state = State::Consumed;\n",
     "        let (envelope, nonce) = p.envelope.take().ok_or_else(consumed)?;\n        let creator_pub = p.creator_pub.take();\n        p.state = State::Consumed;\n        activate()?;\n",
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
    # Pairing v2 (the key-exchange fields): the server holds them verbatim and
    # validates their shape without any EC math.
    ("pubkey-rejects-a-non-04-prefix", TABLE,
     "if raw.len() != PAIRING_PUBLIC_KEY_LEN || raw[0] != 0x04 {",
     "if raw.len() != PAIRING_PUBLIC_KEY_LEN {",
     "public_key_field_is_optional_and_holds_a_p256_point_verbatim"),
    # The reveal (review of PR #306): the creator's key reaches the waiting
    # claimant before approval, from the creator alone, once a claim exists.
    ("reveal-stores-the-creator-key", TABLE,
     "        p.creator_pub = Some(creator_pub.to_string());",
     "        let _ = creator_pub;",
     "a_revealed_creator_pub_rides_the_wait_and_the_envelope"),
    ("reveal-holds-one-key", TABLE,
     "        if p.creator_pub\n            .as_deref()\n            .is_some_and(|held| held != creator_pub)\n        {",
     "        if false {",
     "a_revealed_creator_pub_rides_the_wait_and_the_envelope"),
    ("reveal-is-the-creators", TABLE,
     "        if &p.creator != actor {\n            return Err(not_creator());\n        }\n        if p.expires <= now {\n            return Err(expired());\n        }\n        match p.state {\n            State::Claimed => {}\n            State::Open => return Err(not_claimed()),\n            _ => return Err(already_approved()),\n        }\n        if p.creator_pub",
     "        if p.expires <= now {\n            return Err(expired());\n        }\n        match p.state {\n            State::Claimed => {}\n            State::Open => return Err(not_claimed()),\n            _ => return Err(already_approved()),\n        }\n        if p.creator_pub",
     "a_revealed_creator_pub_rides_the_wait_and_the_envelope"),
    ("reveal-inside-the-window", TABLE,
     "        if p.expires <= now {\n            return Err(expired());\n        }\n        match p.state {\n            State::Claimed => {}\n            State::Open => return Err(not_claimed()),\n            _ => return Err(already_approved()),\n        }\n        if p.creator_pub",
     "        match p.state {\n            State::Claimed => {}\n            State::Open => return Err(not_claimed()),\n            _ => return Err(already_approved()),\n        }\n        if p.creator_pub",
     "a_reveal_needs_a_live_claim_not_yet_approved"),
    ("reveal-needs-a-claim-not-yet-approved", TABLE,
     "        match p.state {\n            State::Claimed => {}\n            State::Open => return Err(not_claimed()),\n            _ => return Err(already_approved()),\n        }\n        if p.creator_pub",
     "        if p.creator_pub",
     "a_reveal_needs_a_live_claim_not_yet_approved"),
    ("the-wait-carries-the-key", TABLE,
     "                Some(key) => waiting.with_field(\"creator_pub\", s(key)),",
     "                Some(_) => waiting,",
     "a_revealed_creator_pub_rides_the_wait_and_the_envelope"),
    ("collection-returns-the-creator-key", TABLE,
     "        let creator_pub = p.creator_pub.take();",
     "        let creator_pub: Option<String> = None;",
     "a_revealed_creator_pub_rides_the_wait_and_the_envelope"),
    ("the-reveal-route-is-served", APP,
     "            Route::PairingReveal(id) => pairing::reveal(self, req, client, &id),\n",
     "            Route::PairingReveal(id) => pairing::approve(self, req, client, &id),\n",
     "the_creator_key_reaches_the_waiting_claimant_only_once_revealed"),
]


def main():
    originals = {Path(path): Path(path).read_bytes() for _, path, *_ in CASES}
    failures = []
    judge = Judge({("obsyncd", case[-1]) for case in CASES})
    try:
        for name, path, old, new, selector in CASES:
            source = originals[Path(path)].decode()
            if source.count(old) != 1:
                raise RuntimeError(f"{name}: mutation context moved")
            Path(path).write_text(source.replace(old, new, 1))
            try:
                verdict, evidence = judge.test(selector)
                print(f"{name}: {verdict}\n{evidence}", flush=True)
                if verdict != "KILLED":
                    failures.append(f"{name} ({verdict})")
            finally:
                Path(path).write_bytes(originals[Path(path)])
    finally:
        for path, original in originals.items():
            path.write_bytes(original)
        judge.close()
    if failures:
        raise SystemExit("Unkilled probes: " + ", ".join(failures))
    print(f"All {len(CASES)} server probes compiled and were killed.")


if __name__ == "__main__":
    main()
