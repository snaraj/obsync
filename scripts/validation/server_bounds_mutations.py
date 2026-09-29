#!/usr/bin/env python3
"""Reproduce the server-bounds (#193, part of #202, #204) guard probes from the
repository root.

Each probe must compile and fail a behavioral regression. Each escape must be
refused by a production build of the server, with the error it names. Sources
are restored from their exact starting bytes in finally, including on failure
or interrupt.
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
BODY = "crates/obsync-core/src/http/body.rs"
API = "crates/obsyncd/src/api/mod.rs"
AUTH = "crates/obsyncd/src/api/auth.rs"
CHUNKS = "crates/obsyncd/src/api/chunks.rs"
RENDER = "crates/obsyncd/src/api/render.rs"
INDEX = "crates/obsyncd/src/storage/index.rs"
JOURNAL = "crates/obsyncd/src/storage/journal.rs"
CLI = "crates/obsyncd/src/cli/mod.rs"
SERVE = "crates/obsyncd/src/cli/serve.rs"
PAIRING = "crates/obsyncd/src/api/pairing.rs"
SETUP = "crates/obsyncd/src/api/setup.rs"
UNVERIFIED = "crates/obsyncd/src/api/unverified.rs"
BUDGET = "three_hundred_slow_bodies_stay_inside_the_unverified_body_budget"
SHARE = "a_device_at_its_share_is_refused_and_no_other_device_is"
STREAM = "a_batch_streams_and_names_a_lost_chunk_missing"
PROBE = "the_readiness_probe_never_writes_through_a_planted_link"
KEY_FILE = "export_reads_the_key_from_a_file_only_its_owner_can_read"
INCOMPLETE = "a_body_is_too_large_only_when_it_passed_its_ceiling"
ACCEPT = "an_unverified_body_stays_reserved_until_its_check_has_run"
SIGNED = "a_signed_body_stays_reserved_until_its_nonce_is_remembered"
CLAIMS = "claims_waiting_for_the_pairing_table_keep_their_bodies_inside_the_budget"
PARSE = "a_token_body_and_its_parse_fit_the_reservation"
BOUND = "the_record_bound_keeps_every_head_and_the_newest_versions_that_fit"
SETUP_HELD = "a_setup_token_is_compared_while_its_body_is_reserved"
PAST = "a_record_at_the_bound_is_whole_and_one_byte_past_it_leaves_out_what_passes_it"
MEASURE = "a_records_measure_is_its_rendering_length"
LENGTH = "a_versions_length_is_its_rendering_length"
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
CLAIM_CHECK = """    let (_, (enrolment, vault, mut pairings)) =
        unverified::token_body(app, req)?.accept(|held| {
            let parsed = held.json()?;
            let enroll = parsed.credential("enroll_token")?;
            let enrolment = devices::enrolment_fields(parsed.value())?;
            let vault = vault_details(parsed.value())?;
            let pairings = app.pairings.lock().expect("pairings");
            pairings.begin_claim(id, &enroll, now)?;
            Ok((enrolment, vault, pairings))
        })?;
"""
SETUP_CHECK = """    let (_, (body, (account_name, enrolment))) =
        unverified::token_body(app, req)?.accept(|held| {
            let body = held.json()?;
            let fields = setup_fields(app, &body)?;
            Ok((body.into_value(), fields))
        })?;
"""
# The setup check, run inside `accept` on what the line before it seals.
SEALED_SETUP = """        .accept(|held| {
            let body = held.json()?;
            let fields = setup_fields(app, &body)?;
            Ok((body.into_value(), fields))
        })?;
"""
# The setup body accepted with no check and parsed after its reservation ends.
SETUP_RELEASED = """    let (raw, ()) = unverified::token_body(app, req)?.accept(|_| Ok(()))?;
    let outside = render::parse_json(&raw)?;
"""
# The claim's fields and table lock inside `accept`, and `begin_claim` after it.
CLAIM_AFTER = """    let (_, (enroll, enrolment, vault, mut pairings)) =
        unverified::token_body(app, req)?.accept(|held| {
            let parsed = held.json()?;
            let enroll = parsed.credential("enroll_token")?.as_str().to_string();
            let pairings = app.pairings.lock().expect("pairings");
            Ok((enroll, devices::enrolment_fields(parsed.value())?, vault_details(parsed.value())?, pairings))
        })?;
"""
CASES = [
    ("accept-blocks", CORE, HTTP, "            match listener.accept() {",
     "            thread::sleep(Duration::from_millis(50));\n            match listener.accept() {",
     "a_new_connection_is_accepted_without_waiting_for_a_poll"),
    ("stop-wakes-accept", CORE, HTTP,
     "                    for target in &targets {", "                    for target in &targets[..0] {",
     "a_stop_wakes_a_listener_nobody_is_connecting_to"),
    ("waker-tries-ipv4-loopback", CORE, HTTP,
     "            SocketAddr::from((Ipv6Addr::LOCALHOST, port)),\n"
     "            SocketAddr::from((Ipv4Addr::LOCALHOST, port)),\n",
     "            SocketAddr::from((Ipv6Addr::LOCALHOST, port)),\n",
     "a_wildcard_listener_is_woken_on_every_loopback_it_may_answer"),
    ("waker-unreachable-reported", CORE, HTTP,
     "                        (*sink)(Report::io(\"waker_unreachable\", &err));\n", "",
     "a_waker_that_reaches_no_listener_is_reported_once"),
    ("waker-reports-once", CORE, HTTP,
     "                        && !std::mem::replace(&mut reported, true)", "                        && true",
     "a_waker_that_reaches_no_listener_is_reported_once"),
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
    ("preauth-ceiling", SERVER, UNVERIFIED, "                .filter(|total| *total <= PREAUTH_BODY_BUDGET)",
     "                .filter(|_| true)", BUDGET),
    # An unverified body's reservation ends only after its credential check
    # (reviews of 7e1294d, c5f79e8 and 77660fb, finding 2). The budget is
    # sealed in unverified.rs and the credential checks take `&Held`, so
    # moving one out of `accept` does not compile (ESCAPES below). These
    # probes release inside `accept`, or launder a check through a second,
    # empty body, and the route tests catch each.
    ("preauth-reserved", SERVER, UNVERIFIED,
     "        let found = check(Held(&self.value))?;\n        let Self { value, reserved } = self;\n"
     "        drop(reserved);\n",
     "        let Self { value, reserved } = self;\n        drop(reserved);\n"
     "        let found = check(Held(&value))?;\n",
     ACCEPT),
    ("preauth-signed-reserved", SERVER, AUTH,
     "            super::unverified::read_body(app, req, super::JSON_BODY_LIMIT)?\n"
     "                .accept(|held| proof(&hex::encode(&sha256::sha256(held.value()))))?\n"
     "                .0\n",
     "            let raw = super::unverified::read_body(app, req, super::JSON_BODY_LIMIT)?\n"
     "                .accept(|_| Ok(()))?\n                .0;\n"
     "            proof(&hex::encode(&sha256::sha256(&raw)))?;\n            raw\n",
     SIGNED),
    # The reviewer's second-seal variants at 0bf6a62: release the real body,
    # parse it outside, and seal an empty one for the check. The check reads
    # its credential from the body it holds, so it finds none.
    ("preauth-setup-second-seal", SERVER, SETUP, SETUP_CHECK,
     SETUP_RELEASED + "    let _ = outside;\n    req.body = obsync_core::http::Body::empty();\n" + SETUP_CHECK,
     SETUP_HELD),
    ("preauth-claim-second-seal", SERVER, PAIRING, CLAIM_CHECK,
     "    let (raw, ()) = unverified::token_body(app, req)?.accept(|_| Ok(()))?;\n"
     "    let _outside = render::parse_json(&raw)?;\n"
     "    req.body = obsync_core::http::Body::empty();\n" + CLAIM_CHECK,
     CLAIMS),
    # `token_body` itself, the entry both token routes call (review of c78ef46).
    ("preauth-token-wrapper-reserve", SERVER, UNVERIFIED,
     "        TOKEN_BODY_LIMIT,\n        Some(TOKEN_BODY_RESERVE),\n",
     "        TOKEN_BODY_LIMIT,\n        None,\n", CLAIMS),
    ("preauth-token-wrapper-ceiling", SERVER, UNVERIFIED,
     "        TOKEN_BODY_LIMIT,\n        Some(TOKEN_BODY_RESERVE),\n",
     "        super::JSON_BODY_LIMIT,\n        Some(TOKEN_BODY_RESERVE),\n", INCOMPLETE),
    ("preauth-token-reserve", SERVER, UNVERIFIED,
     "    let bytes = reserve.unwrap_or(declared.unwrap_or(limit));",
     "    let _ = reserve;\n    let bytes = declared.unwrap_or(limit);", CLAIMS),
    ("preauth-token-ceiling", SERVER, API, "pub const TOKEN_BODY_LIMIT: u64 = 16 * 1024;",
     "pub const TOKEN_BODY_LIMIT: u64 = JSON_BODY_LIMIT;", PARSE),
    ("preauth-token-parse-reserved", SERVER, API, "pub const TOKEN_BODY_RESERVE: u64 = JSON_BODY_LIMIT;",
     "pub const TOKEN_BODY_RESERVE: u64 = TOKEN_BODY_LIMIT;", PARSE),
    # A file record's bound (reviews of 7e1294d, c5f79e8 and 77660fb,
    # finding 1, and its pre-review): decided in `kept`, measured exactly by
    # `measured` and `version_len`, and sent by `file`, whose real-bound test
    # keeps a record exactly at 450 MiB and cuts one a byte past it.
    ("record-bound", SERVER, RENDER, "            open = open && used + len <= FILE_RECORD_MAX as usize;",
     "            open = open && used + len <= FILE_RECORD_MAX as usize * 2;", BOUND),
    ("record-bound-inclusive", SERVER, RENDER, "            open = open && used + len <= FILE_RECORD_MAX as usize;",
     "            open = open && used + len < FILE_RECORD_MAX as usize;", BOUND),
    ("record-stops-at-first-misfit", SERVER, RENDER, "            open = open && used + len <= FILE_RECORD_MAX as usize;",
     "            open = used + len <= FILE_RECORD_MAX as usize;", BOUND),
    ("record-keeps-every-head", SERVER, RENDER, "            if head {\n                return true;\n            }\n", "",
     BOUND),
    ("record-counts-the-heads", SERVER, RENDER,
     "    let mut used = skeleton\n        + sized\n            .iter()\n            .filter(|(_, head)| *head)\n"
     "            .map(|(len, _)| len)\n            .sum::<usize>();",
     "    let mut used = skeleton;", BOUND),
    ("record-knows-its-heads", SERVER, RENDER, "        .map(|v| (version_len(v) + 1, f.heads.contains(&v.version_id)))",
     "        .map(|v| (version_len(v) + 1, false))", PAST),
    ("record-knows-every-head", SERVER, RENDER, "        .map(|v| (version_len(v) + 1, f.heads.contains(&v.version_id)))",
     "        .map(|v| (version_len(v) + 1, f.heads.first() == Some(&v.version_id)))", PAST),
    ("record-measure-halved", SERVER, RENDER,
     "        .map(|v| (version_len(v) + 1, f.heads.contains(&v.version_id)))",
     "        .map(|v| (version_len(v) / 2 + 1, f.heads.contains(&v.version_id)))", MEASURE),
    ("record-measure-comma", SERVER, RENDER,
     "        .map(|v| (version_len(v) + 1, f.heads.contains(&v.version_id)))",
     "        .map(|v| (version_len(v), f.heads.contains(&v.version_id)))", MEASURE),
    ("record-measure-over", SERVER, RENDER,
     "        .map(|v| (version_len(v) + 1, f.heads.contains(&v.version_id)))",
     "        .map(|v| (version_len(v) + 2, f.heads.contains(&v.version_id)))", MEASURE),
    ("record-skeleton-last-comma", SERVER, RENDER,
     "    let skeleton = file_of(f, Vec::new()).to_json().len() - 1;",
     "    let skeleton = file_of(f, Vec::new()).to_json().len();", MEASURE),
    ("record-skeleton-under", SERVER, RENDER,
     "    let skeleton = file_of(f, Vec::new()).to_json().len() - 1;",
     "    let skeleton = file_of(f, Vec::new()).to_json().len() - 2;", MEASURE),
    ("record-decided-on-its-measure", SERVER, RENDER, "    kept(skeleton, &sized)\n",
     "    kept(skeleton + 1, &sized)\n", PAST),
    ("record-sends-what-it-keeps", SERVER, RENDER,
     "        .filter(|(_, keep)| **keep)\n        .map(|(v, _)| version(v))",
     "        .filter(|_| true)\n        .map(|(v, _)| version(v))", PAST),
    ("record-sends-the-kept-ones", SERVER, RENDER,
     "        .zip(&keep)\n        .filter(|(_, keep)| **keep)\n        .map(|(v, _)| version(v))",
     "        .take(keep.iter().filter(|keep| **keep).count())\n        .map(version)", PAST),
    ("record-counts-what-it-leaves", SERVER, RENDER,
     "    let left_out = keep.iter().filter(|keep| !**keep).count();", "    let left_out = 0;", PAST),
    ("version-length-ids", SERVER, RENDER,
     "    let ids = |count: usize| 2 + count * 66 + count.saturating_sub(1);",
     "    let ids = |count: usize| 2 + count * 66;", LENGTH),
    ("version-length-manifest", SERVER, RENDER, "v.manifest_ct.len().div_ceil(3) * 4", "v.manifest_ct.len() / 3 * 4",
     LENGTH),
    ("version-length-numbers", SERVER, RENDER, "    let int = |value: u64| n(value).to_json().len();",
     "    let int = |value: u64| value.to_string().len();", LENGTH),
    ("version-length-own-ts", SERVER, RENDER, "        (\"ts\", int(ms_u64(v.ts))),",
     "        (\"ts\", int(v.bytes)),", LENGTH),
    ("version-length-own-parents", SERVER, RENDER, "        (\"parents\", ids(v.parents.len())),",
     "        (\"parents\", ids(v.sids.len())),", LENGTH),
    ("record-bound-450-mib", SERVER, API, "pub const FILE_RECORD_MAX: u64 = 450 * 1024 * 1024;",
     "pub const FILE_RECORD_MAX: u64 = 64 * 1024 * 1024;", "a_retained_history_past_sixty_four_mib_is_served_whole"),
    ("preauth-released", SERVER, UNVERIFIED, "        self.budget.held.fetch_sub(self.bytes, Ordering::SeqCst);",
     "        let _ = self.bytes;", BUDGET),
    ("preauth-bare", SERVER, UNVERIFIED, "        )\n        .bare()\n    })?;", "        )\n    })?;", BUDGET),
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
    ("slow-body-json", SERVER, UNVERIFIED,
     "        Err(e) if e.kind() == ErrorKind::TimedOut => Err(render::slow_body(app, body)),\n", "",
     "a_json_body_trickled_below_the_rate_floor_is_refused_as_slow"),
    ("slow-body-status", SERVER, RENDER, "        503,\n        \"slow_body\",",
     "        500,\n        \"slow_body\",", "a_chunk_body_trickled_below_the_rate_floor_is_refused"),
    ("rate-clock-at-first-read", SERVER, BODY, "            started: None,\n",
     "            started: Some(Instant::now()),\n", "a_slow_nonce_fsync_is_not_charged_to_the_chunk_body_behind_it"),
    ("slow-body-logged-as-warn", SERVER, API,
     "matches!(line.decision, \"slow_body\" | \"body_incomplete\")",
     "matches!(line.decision, \"body_incomplete\")", "a_json_body_trickled_below_the_rate_floor_is_refused_as_slow"),
    ("incomplete-logged-as-warn", SERVER, API,
     "matches!(line.decision, \"slow_body\" | \"body_incomplete\")",
     "matches!(line.decision, \"slow_body\")", INCOMPLETE),
    ("incomplete-is-not-too-large", SERVER, UNVERIFIED,
     "        Err(e) => Err(render::incomplete_body(app, body, &e)),",
     "        Err(_) => Err(ApiError::new(413, \"body_too_large\", \"request body exceeds the limit\")),",
     INCOMPLETE),
    ("too-large-needs-the-ceiling", SERVER, UNVERIFIED,
     " if e.kind() == ErrorKind::InvalidData && body.received() > limit => Err(",
     " if e.kind() == ErrorKind::InvalidData => Err(", INCOMPLETE),
    ("incomplete-retried", SERVER, RENDER, "        503,\n        \"body_incomplete\",",
     "        400,\n        \"body_incomplete\",", INCOMPLETE),
    ("incomplete-logged", SERVER, RENDER,
     "            (\"reason\", Val::word(\"body_incomplete\")),", "", INCOMPLETE),
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

# What the seal forbids (reviews of 77660fb and its pre-review): each escape
# must be refused by `cargo check` of the server as it ships, with this error.
ESCAPES = [
    ("escape-reseal", SETUP, SETUP_CHECK,
     "    let (raw, ()) = unverified::token_body(app, req)?.accept(|_| Ok(()))?;\n"
     "    let (_, (body, (account_name, enrolment))) =\n"
     "        unverified::Unverified::new(raw, app.reserve_body(super::TOKEN_BODY_RESERVE)?)\n"
     + SEALED_SETUP,
     "named `new` found for struct `Unverified"),
    ("escape-reseal-fields", SETUP, SETUP_CHECK,
     "    let (raw, ()) = unverified::token_body(app, req)?.accept(|_| Ok(()))?;\n"
     "    let sealed = unverified::token_body(app, req)?;\n"
     "    let (_, (body, (account_name, enrolment))) = unverified::Unverified { value: raw, ..sealed }\n"
     + SEALED_SETUP,
     "fields `value` and `reserved` of struct `Unverified` are private"),
    # The reviewer's second seal with the real bytes: a server build cannot
    # make a body that did not arrive on the connection.
    ("escape-launder", SETUP, SETUP_CHECK,
     SETUP_RELEASED + "    req.body = obsync_core::http::Body::from_bytes(raw);\n" + SETUP_CHECK,
     "named `from_bytes` found for struct `Body`"),
    ("escape-reserve", SETUP, SETUP_CHECK,
     "    let _reserved = app.bodies.reserve(super::TOKEN_BODY_RESERVE);\n" + SETUP_CHECK,
     "method `reserve` is private"),
    ("escape-release", SETUP, SETUP_CHECK,
     "    app.bodies.held.store(0, std::sync::atomic::Ordering::SeqCst);\n" + SETUP_CHECK,
     "field `held` of struct `BodyBudget` is private"),
    # A credential parsed anywhere but from the held body is not one.
    ("escape-setup-check-after", SETUP, SETUP_CHECK,
     SETUP_RELEASED + "    let body = outside;\n    let (account_name, enrolment) = setup_fields(app, &body)?;\n",
     "expected `&Parsed<'_>`, found `&Value`"),
    ("escape-claim-check-after", PAIRING, CLAIM_CHECK,
     CLAIM_AFTER + "    pairings.begin_claim(id, &enroll, now)?;\n",
     "expected `&Credential<'_>`, found `&String`"),
    ("escape-test-credential", PAIRING, CLAIM_CHECK,
     CLAIM_AFTER + "    pairings.begin_claim(id, &unverified::Credential::for_tests(&enroll), now)?;\n",
     "named `for_tests` found for struct `unverified::Credential"),
    ("escape-keep-held", SETUP, SETUP_CHECK,
     "    let mut kept = None;\n"
     "    let (_, ()) = unverified::token_body(app, req)?.accept(|held| {\n"
     "        kept = Some(held);\n        Ok(())\n    })?;\n"
     "    let body = kept.expect(\"held\").json()?;\n"
     "    let (account_name, enrolment) = setup_fields(app, &body)?;\n    let body = body.into_value();\n",
     "borrowed data escapes outside of closure"),
]


def main():
    wanted = set(sys.argv[1:])
    unknown = wanted - {case[0] for case in CASES + ESCAPES}
    if unknown:
        raise SystemExit("No such probe: " + ", ".join(sorted(unknown)))
    cases = [case for case in CASES if not wanted or case[0] in wanted]
    escapes = [case for case in ESCAPES if not wanted or case[0] in wanted]
    originals = {Path(path): Path(path).read_bytes()
                 for path in [case[2] for case in cases] + [case[1] for case in escapes]}
    failures = []
    try:
        for name, path, old, new, refusal in escapes:
            source = originals[Path(path)].decode()
            if source.count(old) != 1:
                raise RuntimeError(f"{name}: escape context moved")
            Path(path).write_text(source.replace(old, new, 1))
            try:
                result = subprocess.run(
                    ["cargo", "check", "-p", SERVER, "--lib", "--message-format", "short"],
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True, timeout=600, check=False,
                )
            finally:
                Path(path).write_bytes(originals[Path(path)])
            errors = [line for line in result.stdout.splitlines() if ": error" in line]
            refused = result.returncode != 0 and any(
                line.startswith(path + ":") and refusal in line for line in errors)
            print(f"{name}: {'REFUSED' if refused else 'NOT REFUSED'}", flush=True)
            print("\n".join(errors), flush=True)
            if not refused:
                failures.append(name)
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
        raise SystemExit("Unkilled probes or unrefused escapes: " + ", ".join(failures))
    print(f"All {len(cases)} server probes compiled and were killed; "
          f"all {len(escapes)} escapes were refused by a production build.")


if __name__ == "__main__":
    main()
