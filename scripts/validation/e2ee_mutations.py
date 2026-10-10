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
]

ENGINE_CASES=[
('control_before', 'await positiveControl("control-before");', ''),
('control_after', 'await positiveControl("control-after");', ''),
('setup_flow', 'flows.add("setup");', ''),
('root_key_inventory', 'hex: { vrk: secret }', 'hex: {}'),
('storage_scanner', 'assert.ok(![...needle.forms, ...needle.raws].some((value) => view.includes(value)), `unexpected ${needle.label} on ${surface}`);', ';'),
('needle_capture', 'sent++;', 'sent += 2;'),
('typed_sink', 'allow("recovery_proof", credentials.proof);', ''),
('ciphertext_negative', 'changed[changed.length - 1] ^= 1;', ''),
('required_tamper', 'flows.add("tamper-refusal");', ''),
]

def run(command, cwd, timeout):
    return subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=timeout)


def main():
    source = (ROOT / "scripts/ci/observer.mjs").read_text()
    engine = (ROOT / "scripts/ci/e2ee.mjs").read_text()
    with tempfile.TemporaryDirectory(prefix="obsync-e2ee-mutations-") as tmp:
        root = Path(tmp)
        directory = root / "scripts/ci"
        directory.mkdir(parents=True)
        (root / "plugin").symlink_to(ROOT / "plugin", target_is_directory=True)
        shutil.copyfile(ROOT / "scripts/ci/test_observer.py", directory / "test_observer.py")
        observer_file = directory / "observer.mjs"
        engine_file = directory / "e2ee.mjs"
        observer_file.write_text(source)
        engine_file.write_text(engine)
        scanner_command = ["python3", "-B", "-m", "unittest", "test_observer"]
        engine_command = ["node", str(engine_file)]
        def baseline():
            for command, cwd in [(scanner_command, directory), (engine_command, ROOT)]:
                result = run(command, cwd, 60)
                if result.returncode:
                    raise SystemExit("baseline refused; no mutation evidence: " + result.stderr[-2000:])
        baseline()
        for name, old, new, test in OBSERVER_CASES:
            assert old in source, name
            observer_file.write_text(source.replace(old, new))
            assert run(["node", "--check", str(observer_file)], ROOT, 10).returncode == 0, name
            result = run(["python3", "-B", "-m", "unittest", "test_observer.ObserverScanner." + test], directory, 30)
            if result.returncode == 0 or "AssertionError" not in result.stderr or "ERROR:" in result.stderr:
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
            print(f"mutation={name} decision=killed", flush=True)
            engine_file.write_text(engine)
        baseline()
        print(f"e2ee-mutations decision=pass killed={len(OBSERVER_CASES) + len(ENGINE_CASES)} restored=pass")


if __name__ == "__main__":
    main()
