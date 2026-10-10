#!/usr/bin/env python3
"""Mutate the E2EE evidence instruments in disposable copies only.

Run after `make e2ee`: python3 -B scripts/validation/e2ee_mutations.py.
Every original suite must pass first and afterwards. A mutant must parse,
then fail the intended assertion; setup, import and timeout errors are not
kills. No production source or real data is changed. Each scratch tree is
removed even when a mutation survives.
"""
from pathlib import Path
import subprocess
import tempfile
import shutil

ROOT = Path(__file__).resolve().parents[2]

OBSERVER_CASES=[
('partial_write', 'at += written;', 'at = data.length;', 'test_recorder_short_writes_and_io_failures'),
('recorder_latch', 'if (errors.size) throw new Error("recorder_failed");', '', 'test_recorder_short_writes_and_io_failures'),
('flush_latch', 'errors.add("recorder_flush");', '', 'test_recorder_short_writes_and_io_failures'),
('receipt', 'bad("capture_receipt");', ';', 'test_missing_or_mismatched_recording_evidence_refuses'),
('raw_bytes', 'for (const [kind, bytes] of Object.entries(conn.raw || {})) check([bytes.toString("latin1")], kind);', '', 'test_raw_incomplete_header_is_scanned_and_refused'),
('close_body', 'body = buf.subarray(start); next = buf.length;', 'body = Buffer.alloc(0); next = buf.length;', 'test_close_delimited_bodies_are_scanned'),
('ambiguous_framing', 'if (cl !== undefined && te !== undefined) refuse("http_ambiguous_length");', '', 'test_bad_framing_refuses_even_without_a_hit'),
('duplicate_framing', 'if (headers[key] !== undefined && ["content-length", "transfer-encoding", "content-encoding"].includes(key)) refuse("http_duplicate_framing");', '', 'test_bodyless_responses_still_refuse_duplicate_framing'),
('decompression', 'bytes = decode(bytes, { maxOutputLength: MAX_BYTES });', 'bytes = bytes;', 'test_unknown_or_broken_compression_refuses'),
('unknown_encoding', 'if (!decode) refuse("http_content_encoding");', 'if (!decode) continue;', 'test_unknown_or_broken_compression_refuses'),
('value_word', 'check(viewsOf(m, request, true), request ? "request" : "response", words);', '', 'test_protocol_words_do_not_exempt_secret_values'),
('depth_budget', 'depth > MAX_DEPTH || ', '', 'test_decode_budget_is_a_refusal'),
('secret_report', 'visible: hits.length || errors.length ? {} : {', 'visible: {', 'test_failed_report_does_not_repeat_the_secret'),
('empty_needles', 'if (!needles.length) refuse("needles_empty");', '', 'test_needle_builder_refuses_an_empty_corpus'),

('upstream_eof', 'if (!upstreamEnded) errors.add("recorder_truncated");', '', 'test_recorder_requires_upstream_eof'),
('termination_receipt', 'if (rows.some((row) => row.upstreamEnded !== true)) bad("capture_termination");', '', 'test_missing_upstream_eof_receipt_refuses'),
('reserved_header', 'if (key === "line" || key === "raw" || key === "__proto__") refuse("http_header_reserved");', '', 'test_reserved_headers_cannot_replace_parser_metadata'),
('exchange_count', 'if (!conn.requests.length || conn.responses.filter((r) => !r.informational).length !== conn.requests.length) bad("capture_exchange_count");', '', 'test_final_response_count_must_equal_request_count'),
('node_budget', '++budget.nodes > 50000', 'false', 'test_json_node_budget_refuses'),
('domain_derivation', 'if (domainId && /^[0-9a-f]{32}$/.test(domainId)) {', 'if (false) {', 'test_domain_and_manifest_keys_are_derived'),
('reason_words', 'if (!isRequest) views.push(message.head.line.split(" ").slice(2).join(" "));', '', 'test_recovery_words_in_reason_trailers_and_chunk_extensions'),
('trailer_words', 'wireValues.push(row.slice(row.indexOf(":") + 1));', '', 'test_recovery_words_in_reason_trailers_and_chunk_extensions'),
('extension_words', 'if (line.includes(";")) wireValues.push(line.slice(line.indexOf(";") + 1));', '', 'test_recovery_words_in_reason_trailers_and_chunk_extensions'),
('bodyless_length', 'if (cl !== undefined && (!/^[0-9]+$/.test(cl) || !Number.isSafeInteger(Number(cl)) || Number(cl) > MAX_BYTES)) refuse("http_content_length");', '', 'test_bodyless_framing_is_validated'),
('bodyless_transfer', 'if (te !== undefined && te.toLowerCase() !== "chunked") refuse("http_transfer_encoding");', '', 'test_bodyless_framing_is_validated'),
('bodyless_forbidden', 'if ((status > 0 && status < 200 && (cl !== undefined || te !== undefined)) || (status === 204 && (te !== undefined || cl !== undefined && Number(cl) !== 0))) refuse("http_bodyless_framing");', '', 'test_bodyless_framing_is_validated'),
('duplicate_json', 'if (top.keys.has(decoded)) refuse("http_json_duplicate");', '', 'test_duplicate_json_values_cannot_disappear'),
('decoded_json_unique', 'inner = uniqueJson(b.toString("utf8")).value;', 'inner = JSON.parse(b.toString("utf8"));', 'test_encoded_duplicate_json_cannot_erase_a_secret'),
('decoded_json_refusal', 'catch (error) { if (error.message === "http_json_duplicate") throw error; continue; }', 'catch { continue; }', 'test_encoded_duplicate_json_cannot_erase_a_secret'),
('report_flush', 'process.exitCode = decision === "pass" ? 0 : 1;', 'process.exit(decision === "pass" ? 0 : 1);', 'test_json_node_budget_refuses'),

]

ENGINE_CASES=[
('control_before', 'await positiveControl("control-before");', ''),
('control_after', 'await positiveControl("control-after");', ''),
('setup_flow', 'flows.add("setup");', ''),
('root_key_inventory', 'hex: { vrk: secret }', 'hex: {}'),
('paired_key_kept', 'b.state.data.vrk = opened.vrk;', ''),
('real_request_content_leak', 'sent++;', 'sent++; input.headers["X-E2EE-Control"] = marker;'),
('real_request_key_leak', 'sent++;', 'sent++; input.headers["X-E2EE-Control"] = secret;'),
('storage_scanner', 'assert.ok(![...needle.forms, ...needle.raws].some((value) => view.includes(value)), `unexpected ${needle.label} on ${surface}`);', ';'),
('needle_capture', 'sent++;', 'sent += 2;'),
('typed_sink', 'allow("recovery_proof", credentials.proof);', ''),
('ciphertext_negative', 'changed[changed.length - 1] ^= 1;', ''),
('required_tamper', 'flows.add("tamper-refusal");', ''),

('envelope_inventory', 'spec.hex.pairing_envelope = c.hex(envelopeKey);', ''),
('vault_details_inventory', 'spec.hex.pairing_vault_details = c.hex(vaultDetailsKey);', ''),
('vault_details_readback', 'pairing.sealPairingVault(ps, invitation.pairing_id, { name: vaultName, notes: 0 })', 'pairing.sealPairingVault(ps, invitation.pairing_id, { name: vaultName, notes: 1 })'),
('real_request_vault_details_leak', 'sent++;', 'sent++; if (spec.hex.pairing_vault_details) input.headers["X-E2EE-Control"] = spec.hex.pairing_vault_details;'),
('phrase_inventory', '  const needles = buildNeedles(spec),', '  delete spec.phrase; const needles = buildNeedles(spec),'),
('real_request_envelope_leak', 'sent++;', 'sent++; if (spec.hex.pairing_envelope) input.headers["X-E2EE-Control"] = spec.hex.pairing_envelope;'),
('real_request_phrase_leak', 'sent++;', 'sent++; if (spec.phrase) input.headers["X-E2EE-Control"] = spec.phrase;'),
('credential_raw_bytes', 'request: Buffer.concat(requests.map((m) => m.wire)), response: Buffer.concat(responses.map((m) => m.wire))', 'request: Buffer.alloc(0), response: Buffer.alloc(0)'),
('diagnostic_inventory', '[...needles, ...credentialNeedles(credentials)]', '[...needles]'),
('server_log_credential_leak', 'assertNoNeedles(Buffer.from(logs), diagnosticNeedles, "server_logs");', 'logs += recovery.proof; assertNoNeedles(Buffer.from(logs), diagnosticNeedles, "server_logs");'),
('client_log_credential_leak', 'for (const d of devices) assertNoNeedles(Buffer.from(d.host.logs.join("\\n")), diagnosticNeedles, "client_diagnostics");', 'a.host.logs.push(recovery.proof); for (const d of devices) assertNoNeedles(Buffer.from(d.host.logs.join("\\n")), diagnosticNeedles, "client_diagnostics");'),

]

CONTRACT_CASES = [
    ('ci_job_failure', 'if "if" in job or job.get("continue-on-error", False) is not False:', 'if False:', 'test_conditional_and_ignored_jobs_or_steps_refuse'),
    ('ci_unique_step', 'if len(candidates) != 1:', 'if len(candidates) < 1:', 'test_missing_or_duplicate_step_refuses'),
    ('ci_step_failure', 'if "if" in step or step.get("continue-on-error", False) is not False:', 'if False:', 'test_conditional_and_ignored_jobs_or_steps_refuse'),
    ('ci_context', 'if "working-directory" in step or step.get("shell", "bash") != "bash":', 'if False:', 'test_wrong_execution_context_refuses'),
    ('ci_command_failure', 'if [line.strip() for line in run.splitlines() if line.strip()] != ["set -euo pipefail", *COMMANDS]:', 'if False:', 'test_workflow_executes_and_propagates_failure'),
    ('make_command_failure', 'if not match or [line.strip() for line in match[1].splitlines()] != COMMANDS:', 'if False:', 'test_make_cannot_ignore_errors'),
    ('make_global_failure', 'raise ValueError("unsupported Make declaration can suppress E2EE failure")', 'pass', 'test_make_target_propagates_failure'),
    ('make_unique_target', 'if len(re.findall(r"^e2ee:", makefile, re.M)) != 1:', 'if False:', 'test_duplicate_make_target_refuses'),
]


def run(command, cwd, timeout):
    return subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=timeout)


def main():
    source = (ROOT / "scripts/ci/observer.mjs").read_text()
    engine = (ROOT / "scripts/ci/e2ee.mjs").read_text()
    contract = (ROOT / "scripts/ci/e2ee_contract.py").read_text()
    with tempfile.TemporaryDirectory(prefix="obsync-e2ee-mutations-") as tmp:
        root = Path(tmp)
        directory = root / "scripts/ci"
        directory.mkdir(parents=True)
        (root / "plugin").symlink_to(ROOT / "plugin", target_is_directory=True)
        shutil.copyfile(ROOT / "scripts/ci/test_observer.py", directory / "test_observer.py")
        for name in ("e2ee_contract.py", "test_e2ee_contract.py", "miniyaml.py", "workflow_runs.py", "makefile-invariants.sh"):
            shutil.copyfile(ROOT / "scripts/ci" / name, directory / name)
        shutil.copyfile(ROOT / "Makefile", root / "Makefile")
        (root / ".github/workflows").mkdir(parents=True)
        shutil.copyfile(ROOT / ".github/workflows/pr-gate.yml", root / ".github/workflows/pr-gate.yml")
        contract_file = directory / "e2ee_contract.py"
        observer_file = directory / "observer.mjs"
        engine_file = directory / "e2ee.mjs"
        observer_file.write_text(source)
        engine_file.write_text(engine)
        scanner_command = ["python3", "-B", "-m", "unittest", "test_observer"]
        engine_command = ["node", str(engine_file)]
        def baseline():
            for command, cwd in [(scanner_command, directory), (engine_command, ROOT), (["python3", "-B", "-m", "unittest", "test_e2ee_contract"], directory)]:
                result = run(command, cwd, 60)
                if result.returncode:
                    raise SystemExit("baseline refused; no mutation evidence: " + result.stderr[-2000:])
        baseline()
        for name, old, new, test in OBSERVER_CASES:
            assert old in source, name
            observer_file.write_text(source.replace(old, new))
            assert run(["node", "--check", str(observer_file)], ROOT, 10).returncode == 0, name
            result = run(["python3", "-B", "-m", "unittest", "test_observer.ObserverScanner." + test], directory, 30)
            killed = result.returncode != 0 and "AssertionError" in result.stderr and "ERROR:" not in result.stderr
            if not killed:
                raise SystemExit(f"mutation={name} decision=not-killed-by-assertion")
            print(f"mutation={name} decision=killed", flush=True)
            observer_file.write_text(source)
        for name, old, new in ENGINE_CASES:
            assert old in engine, name
            engine_file.write_text(engine.replace(old, new))
            assert run(["node", "--check", str(engine_file)], ROOT, 10).returncode == 0, name
            result = run(engine_command, ROOT, 30)
            if result.returncode == 0 or "AssertionError" not in result.stderr:
                raise SystemExit(f"mutation={name} decision=not-killed-by-assertion")
            if name.startswith("real_request_") and "traffic scan:" not in result.stderr:
                raise SystemExit(f"mutation={name} decision=not-killed-by-traffic-scan")
            if name.endswith("log_credential_leak") and "unexpected key:proof on" not in result.stderr:
                raise SystemExit(f"mutation={name} decision=not-killed-by-diagnostic-scan")
            print(f"mutation={name} decision=killed", flush=True)
            engine_file.write_text(engine)
        for name, old, new, test in CONTRACT_CASES:
            assert old in contract, name
            contract_file.write_text(contract.replace(old, new))
            compile(contract_file.read_text(), str(contract_file), "exec")
            result = run(["python3", "-B", "-m", "unittest", "test_e2ee_contract.E2eeContract." + test], directory, 30)
            if result.returncode == 0 or "AssertionError" not in result.stderr or "ERROR:" in result.stderr:
                raise SystemExit(f"mutation={name} decision=not-killed-by-assertion")
            print(f"mutation={name} decision=killed", flush=True)
            contract_file.write_text(contract)
        baseline()
        print(f"e2ee-mutations decision=pass killed={len(OBSERVER_CASES) + len(ENGINE_CASES) + len(CONTRACT_CASES)} restored=pass")


if __name__ == "__main__":
    main()
