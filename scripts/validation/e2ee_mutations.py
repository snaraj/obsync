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
import re
import json

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

# New receive/flow guards get the same disposable red/restored-green audit.
ENGINE_CASES += [
('clear_field_allowlist', 'assert.deepEqual(Object.keys(value).sort(), names.split(" ").sort(), "ciphertext response clear-field allowlist")', 'undefined'),
('clear_field_inventory', 'inventoried.add(route === "/v1/changes" ? "changes" : route.includes("/versions/") ? "version" : "file");', ''),
('folder_move', 'a.host.moveFolder("SENTINEL-private-folder", movedFolder)', 'a.host.moveFolder("SENTINEL-private-folder", "SENTINEL-wrong-folder")'),
('delete_publication', 'await a.host.trash(deletePath);', ''),
('restore_readback', 'assert.equal(a.host.text(restored.path), deleteText, "restored-copy local byte readback");', 'a.host.seed(restored.path, "SENTINEL-wrong-restored-bytes"); assert.equal(a.host.text(restored.path), deleteText, "restored-copy local byte readback");'),
('restore_fresh_identity', 'assert.notEqual(a.state.fileByPath(restored.path).fileId, deleteRecord.fileId,', 'deleteRecord.fileId = a.state.fileByPath(restored.path).fileId; assert.notEqual(a.state.fileByPath(restored.path).fileId, deleteRecord.fileId,'),
('pause_delivery', 'await publishPause(a.engine.contextValue, pauseTarget, movedNote, true);', ''),
('pause_resume', 'await b.engine.resume(pauseTarget);', ''),
('hostile_manifest', 'changed[changed.length - 1] ^= 1; row.manifest_ct = changed.toString("base64");', 'row.manifest_ct = changed.toString("base64");'),
('hostile_parents', 'row.parents = ["0".repeat(64)];', 'row.parents = row.parents;'),
('hostile_chunk', 'injected++; const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1; return changed;', 'injected++; const changed = Buffer.from(bytes); return changed;'),
('hostile_saved_state', 'assert.deepEqual(recipientSnapshot(recovered), beforeReceive,', 'recovered.host.seed("SENTINEL-poisoned-write.md", "SENTINEL-poisoned-bytes"); assert.deepEqual(recipientSnapshot(recovered), beforeReceive,'),
('hostile_staged_state', 'assert.equal(receiveContext.staged?.size ?? 0, 0,', 'receiveContext.staged = new Map([["poisoned", {}]]); assert.equal(receiveContext.staged?.size ?? 0, 0,'),
('hostile_map_ciphertext', 'changed[changed.length - 1] ^= 1; body.versions[0].manifest_ct = changed.toString("base64");', 'body.versions[0].manifest_ct = changed.toString("base64");'),
('hostile_map_heads', 'body.heads.push("0".repeat(64));', 'body.heads = body.heads;'),
('hostile_map_saved_state', 'assert.deepEqual(recipientSnapshot(recovered), beforeMap,', 'recovered.host.seed("SENTINEL-poisoned-map-write.md", "SENTINEL-poisoned-bytes"); assert.deepEqual(recipientSnapshot(recovered), beforeMap,'),
('real_map_fork', 'await dm.saveDomainMap(a.transport, mapKeys, mapB, originalMapFile.heads);', 'await dm.saveDomainMap(a.transport, mapKeys, mapA, originalMapFile.heads);'),
('map_replay_authenticity', 'replayed++; return Buffer.from(JSON.stringify(originalMapFile));', 'replayed++; return Buffer.from(JSON.stringify(fork));'),
('map_replay_reached', 'replayed++; return Buffer.from(JSON.stringify(originalMapFile));', 'return Buffer.from(JSON.stringify(originalMapFile));'),
('real_request_restored_path_leak', 'sent++;', 'sent++; if (spec.text.restoredPath) input.headers["X-E2EE-Control"] = spec.text.restoredPath;'),
('api_only_manifest_key', 'const wrongDomain = await c.deriveDomainKey(c.unhex(apiSecret), context.domainId);', 'const wrongDomain = context.domainKey;'),
('api_only_chunk_key', 'c.decryptChunk(wrongDomain, c.unhex(originalChunk.cid), originalCiphertext)', 'c.decryptChunk(context.domainKey, c.unhex(originalChunk.cid), originalCiphertext)'),
('public_feed_tamper', 'corruptions++; const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1; return changed;', 'corruptions++; const changed = Buffer.from(bytes); return changed;'),
('public_feed_sibling', 'a.host.seed(siblingPath, spec.text.siblingText, Date.now() + 11);', ''),
('public_feed_cursor', 'assert.ok(recovered.state.data.lastSeq >= siblingRecord.seq,', 'recovered.state.data.lastSeq = badRecord.seq - 1; assert.ok(recovered.state.data.lastSeq >= siblingRecord.seq,'),
('public_feed_log', 'recovered.host.logs.slice(logsBeforeFeed).some((line) => line.includes("decision=parked reason=chunk_authentication"))', 'false'),
('direct_chunk_parking', 'assert.deepEqual(recovered.state.data.parked[futureRecord.file_id],', 'delete recovered.state.data.parked[futureRecord.file_id]; assert.deepEqual(recovered.state.data.parked[futureRecord.file_id],'),
('public_feed_parking', 'assert.deepEqual(recovered.state.data.parked[badRecord.file_id],', 'delete recovered.state.data.parked[badRecord.file_id]; assert.deepEqual(recovered.state.data.parked[badRecord.file_id],'),
('public_feed_durable_parking', 'await readback(async () => (await recovered.reload()).data.parked[badRecord.file_id]?.reason === "chunk_authentication",', 'delete recovered.state.data.parked[badRecord.file_id]; await recovered.state.save(); await readback(async () => (await recovered.reload()).data.parked[badRecord.file_id]?.reason === "chunk_authentication",'),
('public_feed_recovery', 'const badFileId = a.state.fileByPath(badPath).fileId;', 'const badFileId = a.state.fileByPath(badPath).fileId; delete recovered.state.data.parked[badFileId];'),
('public_feed_durable_clear', 'assert.equal((await recovered.reload()).data.parked[badFileId], undefined,', 'recovered.state.data.parked[badFileId] = { path: badPath, reason: "chunk_authentication" }; await recovered.state.save(); assert.equal((await recovered.reload()).data.parked[badFileId], undefined,'),
('real_request_feed_chunk_leak', 'sent++;', 'sent++; if (spec.hex.feed_bad_chunk) input.headers["X-E2EE-Control"] = spec.hex.feed_bad_chunk;'),
('feed_chunk_inventory', 'spec.hex[label] = c.hex(await c.hkdf(context.domainKey, c.utf8("obsync/v1/chunk"), c.unhex(manifest.chunks[0].cid), 32));', ''),
]

# The first uncaught assertion must be the behavior this mutant attacks.
# Fixture setup, HTTP-result and unrelated readback assertions are not kills.
ENGINE_ASSERTIONS = {
    'control_before': ('required scanner positive controls',),
    'control_after': ('required scanner positive controls',),
    'setup_flow': ('required runtime flows',),
    'root_key_inventory': ('required needle absent: key:vrk',),
    'paired_key_kept': ('recipient must keep the key delivered by pairing before sync',),
    'storage_scanner': ('storage/log scanner positive control',),
    'needle_capture': ('positive-control request count',),
    'typed_sink': ('credential sink scan:',),
    'ciphertext_negative': ('hostile manifest must not be applied by the recipient',),
    'required_tamper': ('required runtime flows',),
    'envelope_inventory': ('required needle absent: key:pairing_envelope',),
    'vault_details_inventory': ('required needle absent: key:pairing_vault_details',),
    'vault_details_readback': ('inventoried vault-details key must open the actual paired vault details',),
    'phrase_inventory': ('required needle absent: recovery:phrase',),
    'credential_raw_bytes': ('duplicate credential fields must retain the leaked proof hit',),
    'diagnostic_inventory': ('diagnostic credential positive control',),
    'server_log_credential_leak': ('unexpected key:proof on server_logs',),
    'client_log_credential_leak': ('unexpected key:proof on client_diagnostics',),
    'clear_field_allowlist': ('clear-field allowlist negative control',),
    'clear_field_inventory': ('clear-field inventory must exercise all three read routes',),
    'folder_move': ('folder move content and empty-folder readback',),
    'delete_publication': ('deleted recipient readback',),
    'restore_readback': ('restored-copy local byte readback',),
    'restore_fresh_identity': ('restoration must use a fresh identity',),
    'pause_delivery': ('encrypted pause applied',),
    'pause_resume': ('explicit resume clears the hold',),
    'hostile_manifest': ('hostile manifest must not be applied by the recipient',),
    'hostile_parents': ('hostile parents must not be applied by the recipient',),
    'hostile_chunk': ('hostile chunk must not be applied by the recipient',),
    'hostile_saved_state': ('hostile manifest must not change saved bytes or sync records',),
    'hostile_staged_state': ('refused data must not remain staged for reuse',),
    'hostile_map_ciphertext': ('hostile map ciphertext must be refused',),
    'hostile_map_heads': ('hostile map fork must be refused',),
    'hostile_map_saved_state': ('hostile map must leave saved state untouched',),
    'real_map_fork': ('real divergent encrypted maps must leave two heads',),
    'map_replay_authenticity': ('authentic old map remains readable under a server replay',),
    'map_replay_reached': ('rollback limitation must exercise the real response boundary',),
    'api_only_manifest_key': ('API-only credentials cannot decrypt manifests',),
    'api_only_chunk_key': ('API-only credentials cannot decrypt chunks',),
    'public_feed_tamper': ('corrupted public-feed bytes must not be applied',),
    'public_feed_sibling': ('valid sibling must pass the corrupted feed record',),
    'public_feed_cursor': ('feed cursor must advance past the valid sibling',),
    'public_feed_log': ('public-feed chunk parking must be visible',),
    'direct_chunk_parking': ('chunk corruption must remain retryable',),
    'public_feed_parking': ('damaged public-feed record must remain parked for retry',),
    'public_feed_durable_parking': ('public-feed parking must persist for restart recovery',),
    'public_feed_recovery': ('honest public-feed retry must recover damaged bytes and clear parking',),
    'public_feed_durable_clear': ('successful public-feed retry must durably clear parking',),
    'feed_chunk_inventory': ('required needle absent: key:feed_bad_chunk',),
}
ENGINE_ASSERTIONS.update({name: ('traffic scan:',) for name, *_ in ENGINE_CASES if name.startswith('real_request_')})


def engine_kill(name, result, expected):
    first = re.search(r"^AssertionError \[ERR_ASSERTION\]: (.+)$", result.stderr, re.M)
    message = re.sub(r"^(?:Missing expected (?:exception|rejection)|Got unwanted rejection): ", "", first[1]) if first else ""
    matched = any(message == label or label in ("traffic scan:", "credential sink scan:") and message.startswith(label) for label in expected)
    if result.returncode == 0 or first is None or not matched:
        raise SystemExit(f"mutation={name} decision=not-killed-by-target-assertion")
    # Only the assertion header, never actual/expected values or stack dumps.
    print(f"mutation={name} decision=killed assertion={json.dumps(first[1])}", flush=True)


CONTRACT_CASES = [
    ('ci_job_failure', 'if "if" in job or job.get("continue-on-error", False) is not False:', 'if False:', 'test_conditional_and_ignored_jobs_or_steps_refuse'),
    ('ci_unique_step', 'if len(candidates) != 1:', 'if len(candidates) < 1:', 'test_missing_or_duplicate_step_refuses'),
    ('ci_step_failure', 'if "if" in step or step.get("continue-on-error", False) is not False:', 'if False:', 'test_conditional_and_ignored_jobs_or_steps_refuse'),
    ('ci_context', 'if "working-directory" in step or step.get("shell", "bash") != "bash":', 'if False:', 'test_wrong_execution_context_refuses'),
    ('ci_command_failure', 'if [line.strip() for line in run.splitlines() if line.strip()] != ["set -euo pipefail", *COMMANDS]:', 'if False:', 'test_workflow_executes_and_propagates_failure'),
    ('make_command_failure', 'if not match or [line.strip() for line in match[1].splitlines()] != COMMANDS:', 'if False:', 'test_make_cannot_ignore_errors'),
    ('make_global_failure', 'raise ValueError("unsupported Make declaration can suppress E2EE failure")', 'pass', 'test_make_target_propagates_failure'),
    ('make_unique_target', 'if len(re.findall(r"^[ \\t]*e2ee:", makefile, re.M)) != 1:', 'if False:', 'test_duplicate_make_target_refuses'),
    ('make_indented_target', 'r"^[ \\t]*e2ee:"', 'r"^e2ee:"', 'test_duplicate_make_target_refuses'),
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
        assert set(ENGINE_ASSERTIONS) == {case[0] for case in ENGINE_CASES}
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
            engine_kill(name, result, ENGINE_ASSERTIONS[name])
            engine_file.write_text(engine)
        # One demonstrated runtime defect: deleting chunk-error normalization
        # used to stall the public feed. Mutate ONLY a copied compiled module,
        # never the shared plugin symlink or a production source checkout.
        (root / "plugin").unlink()
        shutil.copytree(ROOT / "plugin/build", root / "plugin/build")
        (root / "plugin/test").mkdir()
        shutil.copyfile(ROOT / "plugin/test/fake.mjs", root / "plugin/test/fake.mjs")
        chunk_file = root / "plugin/build/sync/pull.js"
        chunk_source = chunk_file.read_text()
        guard = 'throw new ManifestError("chunk_authentication");'
        assert chunk_source.count(guard) == 1
        for name, fixture in [("chunk_receive_normalization", engine),
                              ("chunk_public_feed_normalization", engine.replace('["manifest", "parents", "chunk"]', '["manifest", "parents"]'))]:
            engine_file.write_text(fixture)
            chunk_file.write_text(chunk_source.replace(guard, 'throw error;').replace(
                'catch {\n        // A failed tag/cid belongs',
                'catch (error) {\n        // A failed tag/cid belongs'))
            syntax = run(["node", "--check", str(chunk_file)], ROOT, 10)
            assert syntax.returncode == 0, syntax.stderr
            result = run(engine_command, ROOT, 30)
            expected = "hostile chunk must be a per-record refusal" if name == "chunk_receive_normalization" else "valid sibling must pass the corrupted feed record"
            engine_kill(name, result, (expected,))
            chunk_file.write_text(chunk_source)
        # Without this exact existing parking mapping the cursor advances but
        # the damaged record is forgotten. Isolate eventual recovery from the
        # earlier mark/log assertions so the mutation must fail byte readback.
        mapping = 'if (error instanceof ManifestError && error.reason === "chunk_authentication")\n        return error.reason;'
        assert chunk_source.count(mapping) == 1
        fixture = engine.replace('["manifest", "parents", "chunk"]', '["manifest", "parents"]')
        fixture = '\n'.join(line for line in fixture.splitlines() if not any(guard in line for guard in [
            'assert.deepEqual(recovered.state.data.parked[badRecord.file_id]',
            'public-feed parking must persist for restart recovery',
            'public-feed chunk parking must be visible',
        ]))
        engine_file.write_text(fixture)
        chunk_file.write_text(chunk_source.replace(mapping, ''))
        syntax = run(["node", "--check", str(chunk_file)], ROOT, 10)
        assert syntax.returncode == 0, syntax.stderr
        result = run(engine_command, ROOT, 30)
        engine_kill("chunk_retry_mapping", result, ("honest public-feed retry must recover damaged bytes and clear parking",))
        chunk_file.write_text(chunk_source)
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
        print(f"e2ee-mutations decision=pass killed={len(OBSERVER_CASES) + len(ENGINE_CASES) + len(CONTRACT_CASES) + 3} restored=pass")


if __name__ == "__main__":
    main()
