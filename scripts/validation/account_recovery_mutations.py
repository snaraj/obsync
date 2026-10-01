#!/usr/bin/env python3
"""Reproduce the account-recovery server guard probes from the repository root.

#142 (registration, proof, re-enrolment) and 1.1.5 (the registration time, the
seven-day last-device hold, the operator's reset, and the one re-enrolment that
reset arms and the setup token it rotates). Each probe must compile
and fail a behavioral regression. Sources are restored from their exact
starting bytes in finally, including on failure or interrupt. Never run beside
another build or source editor in this worktree.
"""
from pathlib import Path

from kills import Judge

API = "crates/obsyncd/src/api/setup.rs"
API_MOD = "crates/obsyncd/src/api/mod.rs"
DEVICES = "crates/obsyncd/src/api/devices.rs"
ADMIN = "crates/obsyncd/src/api/admin.rs"
STORE = "crates/obsyncd/src/storage/mod.rs"
JOURNAL = "crates/obsyncd/src/storage/journal.rs"
CLI = "crates/obsyncd/src/cli/recovery.rs"
REENROL = "setup_token_and_vault_proof_reenrol_after_the_last_device_leaves"
DURABLE = "account_recovery_is_immutable_and_survives_journal_and_snapshot_replay"
HOLD = "a_young_recovery_key_holds_only_the_last_device_and_the_reset_restores_the_guard"
ROUTES = "a_new_recovery_key_holds_the_only_device_on_both_revoke_routes"
FRAMES = "account_recovery_frames_refuse_malformed_verifiers_and_read_legacy_frames"
RESET = "a_plan_says_what_stands_and_changes_nothing_then_apply_clears_it_durably"
NEVER_RESET = "an_account_never_reset_refuses_a_recovery_without_a_key_whatever_the_proof"
REARM = "a_reset_arms_one_re_enrolment_by_the_rotated_token_and_nothing_a_device_holds"
ARM = "the_reset_arms_one_re_enrolment_that_replay_keeps_and_any_registration_spends"
ARMED_CLI = "a_reset_with_no_key_still_rotates_the_token_and_arms_one_re_enrolment"
REFUSED_CLI = "a_reset_refuses_while_the_server_holds_the_journal_and_before_setup"
CASES = [
    ("token-required", API, "if !ct::eq(expected.as_bytes(), token.as_str().as_bytes()) {", "if false {", REENROL),
    ("proof-required", API, "if !ct::eq(derived.as_bytes(), expected.as_bytes()) {", "if false {", REENROL),
    # 1.1.5: the one re-enrolment the operator's reset arms.
    ("arm-required", API, "if account.recovery_verifier.is_none() && account.recovery_cleared.is_none() {", "if false {", NEVER_RESET),
    ("reestablish-registers", API, "if !app.store.register_recovery(&derived, now)? {", "if false && app.store.register_recovery(&derived, now)? {", REARM),
    ("reestablish-timed", API, "app.store.register_recovery(&derived, now)?", "app.store.register_recovery(&derived, UnixMs(0))?", REARM),
    ("registration-spends-the-arm", STORE, "                Some(now),\n                None,\n            )]", "                Some(now),\n                Some(now),\n            )]", ARM),
    ("reset-arms", STORE, "vec![account_frame(account, None, None, Some(now))]", "vec![account_frame(account, None, None, None)]", ARMED_CLI),
    ("reset-rotates-the-token", CLI, "    rotate_setup_token(cfg, sync)?;\n", "", ARMED_CLI),
    ("rotation-after-the-lock", CLI, "    let store = Store::open(&storage, server_key, &posture, log.clone())?;", "    rotate_setup_token(cfg, &sync_folder)?;\n    let store = Store::open(&storage, server_key, &posture, log.clone())?;", REFUSED_CLI),
    ("plan-rotates-nothing", CLI, "        Mode::Plan => false,", "        Mode::Plan => {\n            rotate_setup_token(cfg, &sync_folder)?;\n            false\n        }", RESET),
    ("journal-writes-arm", JOURNAL, '"recovery_cleared_at",\n                    opt_num(recovery_cleared.map(|t| t.0)),', '"recovery_cleared_at",\n                    Value::Null,', ARM),
    ("snapshot-writes-arm", JOURNAL, '"recovery_cleared_at",\n                opt_num(account.recovery_cleared.map(|t| t.0)),', '"recovery_cleared_at",\n                Value::Null,', ARM),
    ("arm-is-read", JOURNAL, 'let cleared = match value.get("recovery_cleared_at") {', 'let cleared = match value.get("recovery_cleared_unread") {', ARM),
    ("proof-is-a-preimage", API, "obsync_core::hex::encode(&obsync_core::sha256::sha256(&bytes))", "obsync_core::hex::encode(&bytes)", REENROL),
    ("bounded-verifier", API, "if !super::is_hex(value, 64) {", "if false {", NEVER_RESET),
    ("authenticated-registration", API, "let authed = auth::device(app, req, client)?;\n    let body = render::parse_json(&authed.body)?;", "let (raw, ()) = unverified::read_body(app, req, 4096)?.accept(|_| Ok(()))?;\n    let _ = client;\n    let body = render::parse_json(&raw)?;", REENROL),
    ("immutable-verifier", STORE, "return Ok(obsync_core::ct::eq(\n                existing.as_bytes(),\n                verifier.as_bytes(),\n            ));", "return Ok(true);", DURABLE),
    ("durable-initial-verifier", STORE, "                recovery_verifier,\n                recovery_cleared: None,\n            }]", "                recovery_verifier: None,\n                recovery_cleared: None,\n            }]", "initial_account_recovery_is_one_durable_setup_fact"),
    ("durable-registration", STORE, "                Some(verifier.to_string()),\n                Some(now),", "                None,\n                Some(now),", DURABLE),
    ("last-device-can-recover", STORE, "if account.is_none_or(|a| a.recovery_verifier.is_none()) {", "if true {", REENROL),
    ("no-key-last-device-protected", STORE, "if target_is_active && active <= 1 {", "if target_is_active && false {", "the_dashboard_refuses_to_revoke_the_only_active_device"),
    ("journal-writes-verifier", JOURNAL, 'pairs.push(("recovery", opt_text(recovery_verifier)));', 'pairs.push(("recovery", Value::Null));', DURABLE),
    ("journal-reads-verifier", JOURNAL, "let (recovery_verifier, recovery_registered, recovery_cleared) = recovery(&value)?;", "let (_, recovery_registered, recovery_cleared) = recovery(&value)?;\n                let recovery_verifier = None;", DURABLE),
    ("snapshot-writes-verifier", JOURNAL, '("recovery", opt_text(&account.recovery_verifier)),', '("recovery", Value::Null),', DURABLE),
    ("snapshot-reads-verifier", JOURNAL, "let (recovery_verifier, recovery_registered, recovery_cleared) = recovery(account)?;", "let (_, recovery_registered, recovery_cleared) = recovery(account)?;\n        let recovery_verifier = None;", DURABLE),
    ("stored-verifier-shape", JOURNAL, "if text.len() != 64 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {", "if false {", FRAMES),
    # 1.1.5: the seven-day hold on the last active device.
    ("young-key-holds-last-device", STORE, "if age < RECOVERY_HOLD_MS {", "if false {", HOLD),
    ("hold-ends-on-time", STORE, "if age < RECOVERY_HOLD_MS {", "if age <= RECOVERY_HOLD_MS {", DURABLE),
    ("hold-lasts-to-the-end", STORE, "if age < RECOVERY_HOLD_MS {", "if age < RECOVERY_HOLD_MS - 1 {", DURABLE),
    ("hold-is-seven-days", STORE, "pub const RECOVERY_HOLD_MS: u64 = 7 * 24 * 60 * 60 * 1000;", "pub const RECOVERY_HOLD_MS: u64 = 6 * 24 * 60 * 60 * 1000;", ROUTES),
    ("clock-behind-holds", STORE, "let age = now.0.saturating_sub(registered.0);", "let age = now.0.wrapping_sub(registered.0);", HOLD),
    ("untimed-key-keeps-the-old-rule", STORE, "if let Some(registered) = account.and_then(|a| a.recovery_registered) {", "if let Some(registered) = account.map(|a| a.recovery_registered.unwrap_or(now)) {", HOLD),
    ("setup-stamps-its-key", STORE, "recovery_registered: recovery_verifier.as_ref().map(|_| now),", "recovery_registered: None,", "initial_account_recovery_is_one_durable_setup_fact"),
    ("registration-stamps-its-key", STORE, "                Some(verifier.to_string()),\n                Some(now),", "                Some(verifier.to_string()),\n                None,", DURABLE),
    ("journal-writes-time", JOURNAL, 'pairs.push(("recovery_at", opt_num(recovery_registered.map(|t| t.0))));', 'pairs.push(("recovery_at", Value::Null));', DURABLE),
    ("snapshot-writes-time", JOURNAL, '"recovery_at",\n                opt_num(account.recovery_registered.map(|t| t.0)),', '"recovery_at",\n                Value::Null,', DURABLE),
    ("time-is-read", JOURNAL, 'let registered = match value.get("recovery_at") {', 'let registered = match value.get("recovery_at_unread") {', FRAMES),
    ("malformed-time-refused", JOURNAL, "Some(at) => Some(UnixMs(at.as_u64().ok_or_else(|| {\n            StoreError::Corrupt(\"invalid recovery registration time\".into())\n        })?)),", "Some(at) => at.as_u64().map(UnixMs),", FRAMES),
    ("reset-clears-the-key", STORE, "vec![account_frame(account, None, None, Some(now))]", "vec![account_frame(account.clone(), account.recovery_verifier.clone(), None, Some(now))]", RESET),
    ("plan-changes-nothing", CLI, "        Mode::Plan => false,", "        Mode::Plan => store.reset_recovery(UnixMs::now())?,", RESET),
    ("registration-uses-the-server-clock", API, "        .register_recovery(&verifier, UnixMs(app.clock.unix_ms()))?", "        .register_recovery(&verifier, UnixMs::now())?", ROUTES),
    ("device-revoke-uses-the-server-clock", DEVICES, ".revoke_device_unless_last(&target, UnixMs(app.clock.unix_ms()))?;", ".revoke_device_unless_last(&target, UnixMs::now())?;", ROUTES),
    ("dashboard-revoke-uses-the-server-clock", ADMIN, ".revoke_device_unless_last(&target, UnixMs(app.clock.unix_ms()))?;", ".revoke_device_unless_last(&target, UnixMs::now())?;", ROUTES),
    ("hold-is-a-conflict", API_MOD, "StoreError::RecoveryTooNew => ApiError::new(\n                409,", "StoreError::RecoveryTooNew => ApiError::new(\n                403,", ROUTES),
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
