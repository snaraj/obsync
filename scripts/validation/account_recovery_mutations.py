#!/usr/bin/env python3
"""Reproduce #142 server guard probes from the repository root.

Each probe must compile and fail a behavioral regression. Sources are restored
from their exact starting bytes in finally, including on failure or interrupt.
Never run beside another build or source editor in this worktree.
"""
from pathlib import Path
import subprocess

API = "crates/obsyncd/src/api/setup.rs"
STORE = "crates/obsyncd/src/storage/mod.rs"
JOURNAL = "crates/obsyncd/src/storage/journal.rs"
REENROL = "setup_token_and_vault_proof_reenrol_after_the_last_device_leaves"
DURABLE = "account_recovery_is_immutable_and_survives_journal_and_snapshot_replay"
CASES = [
    ("token-required", API, "if !ct::eq(expected.as_bytes(), token.as_bytes()) {", "if false {", REENROL),
    ("proof-required", API, "if !digest.is_some_and(|actual| ct::eq(actual.as_bytes(), expected.as_bytes())) {", "if false {", REENROL),
    ("proof-is-a-preimage", API, "obsync_core::hex::encode(&obsync_core::sha256::sha256(&bytes))", "obsync_core::hex::encode(&bytes)", REENROL),
    ("bounded-verifier", API, "if !super::is_hex(value, 64) {", "if false {", "a_legacy_account_needs_an_authenticated_recovery_registration"),
    ("authenticated-registration", API, "let authed = auth::device(app, req, client)?;\n    let body = render::parse_json(&authed.body)?;", "let body = render::json_body(req)?;", REENROL),
    ("immutable-verifier", STORE, "return Ok(obsync_core::ct::eq(\n                existing.as_bytes(),\n                verifier.as_bytes(),\n            ));", "return Ok(true);", DURABLE),
    ("durable-initial-verifier", STORE, "            recovery_verifier,\n        })?;", "            recovery_verifier: None,\n        })?;", "initial_account_recovery_is_one_durable_setup_fact"),
    ("durable-registration", STORE, "recovery_verifier: Some(verifier.to_string()),", "recovery_verifier: None,", DURABLE),
    ("last-device-can-recover", STORE, "            && index\n                .account\n                .as_ref()\n                .is_none_or(|a| a.recovery_verifier.is_none())", "", REENROL),
    ("legacy-last-device-protected", STORE, "            && active <= 1", "            && false", "a_legacy_account_needs_an_authenticated_recovery_registration"),
    ("journal-writes-verifier", JOURNAL, 'pairs.push(("recovery", opt_text(recovery_verifier)));', 'pairs.push(("recovery", Value::Null));', DURABLE),
    ("journal-reads-verifier", JOURNAL, "recovery_verifier: recovery_verifier(&value)?,", "recovery_verifier: None,", DURABLE),
    ("snapshot-writes-verifier", JOURNAL, '("recovery", opt_text(&account.recovery_verifier)),', '("recovery", Value::Null),', DURABLE),
    ("snapshot-reads-verifier", JOURNAL, "recovery_verifier: recovery_verifier(account)?,", "recovery_verifier: None,", DURABLE),
    ("stored-verifier-shape", JOURNAL, "if text.len() != 64 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {", "if false {", "account_recovery_frames_refuse_malformed_verifiers_and_read_legacy_frames"),
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
                    text=True, timeout=120, check=False,
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
