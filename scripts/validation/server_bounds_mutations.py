#!/usr/bin/env python3
"""Reproduce the server-bounds (#193, part of #202, #204) guard probes from the
repository root.

Each probe must compile and fail a behavioral regression. Sources are restored
from their exact starting bytes in finally, including on failure or interrupt.
Never run beside another build or source editor in this worktree. Name probes
to run only those: `python3 -B scripts/validation/server_bounds_mutations.py
nonce-share preauth-bare`.
"""
from pathlib import Path
import subprocess
import sys

CORE = "obsync-core"
SERVER = "obsyncd"
HTTP = "crates/obsync-core/src/http/server.rs"
API = "crates/obsyncd/src/api/mod.rs"
AUTH = "crates/obsyncd/src/api/auth.rs"
CHUNKS = "crates/obsyncd/src/api/chunks.rs"
RENDER = "crates/obsyncd/src/api/render.rs"
INDEX = "crates/obsyncd/src/storage/index.rs"
JOURNAL = "crates/obsyncd/src/storage/journal.rs"
CLI = "crates/obsyncd/src/cli/mod.rs"
SERVE = "crates/obsyncd/src/cli/serve.rs"
BUDGET = "three_hundred_slow_bodies_stay_inside_the_unverified_body_budget"
SHARE = "a_device_at_its_share_is_refused_and_no_other_device_is"
STREAM = "a_batch_streams_and_names_a_lost_chunk_missing"
PROBE = "the_readiness_probe_never_writes_through_a_planted_link"
KEY_FILE = "export_reads_the_key_from_a_file_only_its_owner_can_read"
PROBE_BODY = """    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)?;"""
CASES = [
    ("accept-blocks", CORE, HTTP, "            match listener.accept() {",
     "            thread::sleep(Duration::from_millis(50));\n            match listener.accept() {",
     "a_new_connection_is_accepted_without_waiting_for_a_poll"),
    ("stop-wakes-accept", CORE, HTTP,
     "                    let _ = TcpStream::connect_timeout(&target, SHUTDOWN_POLL);", "",
     "a_stop_wakes_a_listener_nobody_is_connecting_to"),
    ("batch-streams", SERVER, CHUNKS, "        Box::new(Batch::new(segments)),",
     "        Box::new(Cursor::new({\n            let mut all = Vec::new();\n"
     "            let _ = Batch::new(segments).read_to_end(&mut all);\n            all\n        })),",
     STREAM),
    ("batch-plans-from-the-volume", SERVER, CHUNKS,
     ".map(|sid| app.store.open_chunk(sid).ok().map(|(_, len)| len))",
     ".map(|sid| app.store.chunk_len(sid))", STREAM),
    ("batch-ceiling", SERVER, CHUNKS, "    if total > MULTIPART_MAX_TOTAL_BYTES {", "    if false {",
     "multipart_ciphertext_budget_accepts_exactly_32_mib_and_refuses_more"),
    ("batch-short-chunk", SERVER, CHUNKS, "                    if count == 0 {", "                    if false {",
     "a_chunk_shorter_than_its_plan_fails_the_read_instead_of_misframing"),
    ("page-byte-budget", SERVER, INDEX,
     "            if !changes.is_empty() && bytes + cost > CHANGES_PAGE_BYTES {", "            if false {",
     "a_change_page_stops_at_its_byte_budget_and_resumes_after_it"),
    ("page-carries-one", SERVER, INDEX,
     "            if !changes.is_empty() && bytes + cost > CHANGES_PAGE_BYTES {",
     "            if bytes + cost > CHANGES_PAGE_BYTES {",
     "an_entry_wider_than_the_budget_still_moves_the_cursor"),
    ("page-estimate-covers-rendering", SERVER, INDEX, "    const FIXED: usize = 512;",
     "    const FIXED: usize = 0;", "the_page_estimate_never_falls_short_of_the_rendering"),
    ("files-range-excludes-cursor", SERVER, INDEX, "Bound::Excluded(*a)", "Bound::Included(*a)",
     "files_page_walks_in_id_order"),
    ("frame-length-refused", SERVER, JOURNAL, "    u32::try_from(len).ok().map(u32::to_le_bytes)",
     "    Some((len as u32).to_le_bytes())", "a_frame_length_over_32_bits_is_refused_rather_than_wrapped"),
    ("preauth-ceiling", SERVER, API, "                .filter(|total| *total <= PREAUTH_BODY_BUDGET)",
     "                .filter(|_| true)", BUDGET),
    ("preauth-reserved", SERVER, RENDER, "    let _reserved = app.reserve_body(declared.unwrap_or(limit))?;",
     "", BUDGET),
    ("preauth-released", SERVER, API, "        self.budget.held.fetch_sub(self.bytes, Ordering::SeqCst);",
     "        let _ = self.bytes;", BUDGET),
    ("preauth-bare", SERVER, API, "                .bare())", ")", BUDGET),
    ("nonce-share", SERVER, AUTH, "        if held >= self.share {", "        if false {", SHARE),
    ("nonce-share-reloaded", SERVER, AUTH, "            *held.entry(device.clone()).or_default() += 1;", "",
     "a_share_still_refuses_after_a_reload"),
    ("nonce-share-counted", SERVER, AUTH, "            *self.held.entry(device).or_default() += 1;", "",
     SHARE),
    ("nonce-share-freed", SERVER, AUTH, "                *count -= 1;", "", SHARE),
    ("probe-removes-by-name", SERVER, API, PROBE_BODY,
     "    let mut f = std::fs::OpenOptions::new()\n        .write(true)\n        .create_new(true)\n"
     "        .mode(0o600)\n        .open(&path)?;", PROBE),
    ("probe-never-follows", SERVER, API, PROBE_BODY, "    let mut f = std::fs::File::create(&path)?;", PROBE),
    ("key-file-owner-only", SERVER, CLI, "    if meta.permissions().mode() & 0o077 != 0 {", "    if false {",
     KEY_FILE),
    ("key-file-regular", SERVER, CLI, "    if !meta.is_file() {", "    if false {", KEY_FILE),
    ("argv-key-warned", SERVER, CLI, "        let key_on_argv = key.is_some();",
     "        let key_on_argv = false;", "a_key_on_the_command_line_still_parses_and_is_warned_about"),
    ("body-rate-floor", SERVER, SERVE, "pub const MIN_BODY_RATE: u64 = 16 * 1024;",
     "pub const MIN_BODY_RATE: u64 = 0;", "a_chunk_body_trickled_below_the_rate_floor_is_refused"),
    ("body-rate-floor-lowered", SERVER, SERVE, "pub const MIN_BODY_RATE: u64 = 16 * 1024;",
     "pub const MIN_BODY_RATE: u64 = 64 * 1024;", "a_chunk_sent_at_256_kbit_per_second_arrives"),
    ("slow-body-chunk", SERVER, CHUNKS, "    if upload.slow {", "    if false {",
     "a_chunk_body_trickled_below_the_rate_floor_is_refused"),
    ("slow-body-json", SERVER, RENDER,
     "        Err(e) if e.kind() == ErrorKind::TimedOut => Err(slow_body(app, &req.body)),\n", "",
     "a_json_body_trickled_below_the_rate_floor_is_refused_as_slow"),
    ("slow-body-status", SERVER, RENDER, "        503,\n        \"slow_body\",",
     "        500,\n        \"slow_body\",", "a_chunk_body_trickled_below_the_rate_floor_is_refused"),
    ("reset-is-ordinary", CORE, HTTP,
     "        Report::io(if closed { \"peer_closed\" } else { decision }, err)",
     "        Report::io(decision, err)", "a_connection_failure_is_ordinary_only_when_the_peer_ended_it"),
    ("idle-failure-classified", CORE, HTTP,
     "                    (*sink)(Report::connection(\"connection_failed\", &err));",
     "                    (*sink)(Report::io(\"connection_failed\", &err));",
     "a_peer_resetting_an_idle_keep_alive_is_an_ordinary_close"),
    ("parser-refusal-reported", CORE, HTTP,
     "                (*sink)(Report {\n                    status: Some(status),\n"
     "                    ..Report::new(\"parser_refusal\")\n                });\n", "",
     "a_malformed_request_is_reported_as_a_parser_refusal"),
    ("ordinary-close-at-debug", SERVER, SERVE, "    if report.ordinary() {", "    if false {",
     "http_reports_are_logged_for_what_they_are"),
]


def main():
    wanted = set(sys.argv[1:])
    unknown = wanted - {case[0] for case in CASES}
    if unknown:
        raise SystemExit("No such probe: " + ", ".join(sorted(unknown)))
    cases = [case for case in CASES if not wanted or case[0] in wanted]
    originals = {Path(path): Path(path).read_bytes() for _, _, path, *_ in cases}
    failures = []
    try:
        for name, crate, path, old, new, selector in cases:
            source = originals[Path(path)].decode()
            if source.count(old) != 1:
                raise RuntimeError(f"{name}: mutation context moved")
            Path(path).write_text(source.replace(old, new, 1))
            try:
                result = subprocess.run(
                    ["cargo", "test", "-p", crate, "--lib", selector],
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True, timeout=600, check=False,
                )
                output = result.stdout
                compiled = "could not compile" not in output
                killed = compiled and result.returncode != 0 and "FAILED" in output
            except subprocess.TimeoutExpired as expired:
                output = expired.stdout or ""
                killed = False
            finally:
                Path(path).write_bytes(originals[Path(path)])
            print(f"{name}: {'KILLED' if killed else 'NOT A KILL'}", flush=True)
            if not killed:
                failures.append(name)
                print(output, flush=True)
            else:
                print("\n".join(line for line in output.splitlines()
                                if "FAILED" in line or "test result:" in line), flush=True)
    finally:
        for path, original in originals.items():
            path.write_bytes(original)
    if failures:
        raise SystemExit("Unkilled probes: " + ", ".join(failures))
    print(f"All {len(cases)} server probes compiled and were killed.")


if __name__ == "__main__":
    main()
