#!/usr/bin/env python3
"""Reproduce the server durability guard probes (#191, #192, #203) from the
repository root.

Each probe must compile and fail a behavioral regression. A probe is one or
more exact substitutions, each of which must match exactly once. Sources are
restored from their exact starting bytes in finally, including on failure or
interrupt. Never run beside another build or source editor in this worktree.
"""
from pathlib import Path
import subprocess
import sys

AUTH = "crates/obsyncd/src/api/auth.rs"
NONCE_LOG = "crates/obsyncd/src/api/nonce_log.rs"
API = "crates/obsyncd/src/api/mod.rs"
STORE = "crates/obsyncd/src/storage/mod.rs"
JOURNAL = "crates/obsyncd/src/storage/journal.rs"
INDEX = "crates/obsyncd/src/storage/index.rs"
SCRUB = "crates/obsyncd/src/storage/scrub.rs"
SERVE = "crates/obsyncd/src/cli/serve.rs"

GROUP = "concurrent_requests_share_an_fsync_and_none_is_answered_before_its_own"
PENDING = "a_nonce_in_flight_is_already_a_replay_and_the_check_does_not_wait_for_the_volume"
REFUSED = "a_refused_batch_answers_every_member_and_leaves_every_nonce_unspent"
FSYNC = "a_writer_s_fsync_holds_the_journal_and_never_the_index_and_nothing_is_applied_before_it"
GROWTH = "a_snapshot_is_due_after_the_journal_grows_past_the_floor_and_the_last_snapshot"
SNAPSHOT = "a_snapshot_is_written_with_no_guard_held_and_a_crash_part_way_loses_nothing"

CASES = [
    # --- nonce log group commit (#191) ------------------------------------
    ("wait-for-durable", AUTH, [(
        'None => self.settled.wait(state).expect("nonce cache"),',
        "None => return Ok(()),",
    )], GROUP),
    ("answer-before-the-flush", AUTH, [(
        "        drop(state);\n        let written = rewrite",
        "        let _ = batch.outcome.set(Ok(()));\n        self.settled.notify_all();\n"
        "        drop(state);\n        let written = rewrite",
    )], GROUP),
    ("unspent-on-failure", AUTH, [(
        "            self.seen.remove(entry);\n",
        "",
    )], REFUSED),
    ("unspent-nonce-returns-its-share", AUTH, [(
        "            self.release(&entry.0);\n",
        "",
    )], "a_refused_batch_gives_every_device_its_share_back"),
    ("share-reserved-before-the-batch", AUTH, [
        ("        let held = state.held_by(device);\n",
         "        state.open.entries.push((now, entry.clone()));\n        let held = state.held_by(device);\n"),
        ("        state.open.entries.push((now, entry));\n", ""),
    ], "a_refused_batch_gives_every_device_its_share_back"),
    ("nonce-fsync-inside-the-lock", AUTH, [
        ("        drop(state);\n        let written = rewrite", "        let written = rewrite"),
        ("        let mut state = self.state();\n        if let Err(e) = &written {",
         "        let mut state = state;\n        if let Err(e) = &written {"),
    ], PENDING),
    ("rewrite-excludes-the-batch", AUTH, [(
        "window(state.seen.iter().filter(|(e, _)| !pending.contains(e)))",
        "window(state.seen.iter().filter(|_| !pending.is_empty()))",
    )], "a_rewrite_holds_what_was_durable_and_never_the_batch_it_precedes"),
    ("refused-batch-is-cut-back", NONCE_LOG, [(
        "        self.file.set_len(self.durable_len)?;\n",
        "",
    )], "a_refused_batch_is_cut_back_so_the_next_one_lands_on_a_clean_line"),
    # --- journal fsync outside the index guard (#191) -----------------------
    ("journal-fsync-inside-the-index-lock", STORE, [
        ("        drop(index);\n        let written = journal.append_all(&records);",
         "        let written = journal.append_all(&records);"),
        ("        let mut index = self.index();\n        for record in &records {",
         "        let mut index = index;\n        for record in &records {"),
    ], FSYNC),
    ("apply-before-durable", STORE, [(
        "        drop(index);\n        let written = journal.append_all(&records);",
        "        let mut index = index;\n        for record in &records {\n            index.apply(record);\n"
        "        }\n        drop(index);\n        let written = journal.append_all(&records);",
    )], FSYNC),
    ("edit-event-folded-into-the-post", STORE, [(
        "            frames.extend(edit.map(|event| Frame::Seen { device_id, event }));\n",
        "",
    )], "a_post_journals_the_frames_it_always_did_and_every_replay_derives_the_same_device"),
    # --- snapshots (#192) ----------------------------------------------------
    ("growth-trigger", STORE, [(
        "self.journal_growth() >= floor.max(self.snapshot_bytes.load(Ordering::SeqCst))",
        "false",
    )], GROWTH),
    ("growth-outweighs-the-last-snapshot", STORE, [(
        "self.journal_growth() >= floor.max(self.snapshot_bytes.load(Ordering::SeqCst))",
        "self.journal_growth() >= floor",
    )], GROWTH),
    ("restart-remembers-the-last-snapshot", STORE, [(
        "snapshot_bytes: AtomicU64::new(snapshot_bytes),",
        "snapshot_bytes: AtomicU64::new(0),",
    )], GROWTH),
    ("stop-snapshots-only-when-due", SERVE, [(
        "if !store.snapshot_due(SNAPSHOT_AFTER_BYTES) {",
        "if store.journal_growth() == 0 {",
    )], "a_stop_writes_only_a_snapshot_that_is_due"),
    ("snapshot-written-outside-the-journal-lock", STORE, [
        ("let slot = self.journal().admit_snapshot();",
         "let mut held = self.journal();\n        let slot = held.admit_snapshot();"),
        ("self.journal().finish_snapshot(copy.seq, written)?;",
         "held.finish_snapshot(copy.seq, written)?;"),
    ], SNAPSHOT),
    ("snapshot-counted-as-it-lands", JOURNAL, [(
        "        self.written\n            .store(HEADER as u64 + self.len, Ordering::Release);\n",
        "",
    )], SNAPSHOT),
    ("snapshot-streamed-byte-for-byte", JOURNAL, [(
        "        frame.put(b\"],\")?;\n",
        "        frame.put(b\"]\")?;\n",
    )], "a_streamed_snapshot_is_the_one_frame_the_whole_object_makes_byte_for_byte"),
    # --- collection (#192) ---------------------------------------------------
    ("gc-reupload-check", STORE, [(
        "            if self.index().chunks.contains_key(sid) {\n                reuploaded += 1;\n"
        "                continue;\n            }\n",
        "",
    )], "a_chunk_re_uploaded_after_collection_decided_is_not_unlinked"),
    ("gc-prunes-heads-as-a-set", INDEX, [(
        "            entry.heads.retain(|head| !gone.contains(head));\n",
        "",
    )], "one_collection_frame_prunes_versions_across_files_and_the_feed_follows"),
    # --- scrub (#192, #203) --------------------------------------------------
    ("scrub-pass-interval", SCRUB, [(
        "        if !self.asked && now.0 < self.began.0.saturating_add(PASS_INTERVAL_MS) {\n"
        "            return true;\n        }\n",
        "",
    )], "a_store_smaller_than_one_step_is_not_re_hashed_until_the_interval_passes"),
    ("scrub-journals-only-events-and-passes", STORE, [(
        "if summary.complete_pass || summary.mismatches > 0 {",
        "if true {",
    )], "a_pass_walks_each_chunk_once_journals_once_and_logs_one_start_and_summary"),
    # --- readiness backed by real writes (#192) ------------------------------
    ("refused-write-takes-the-proof-away", STORE, [(
        "Err(StoreError::Io(_)) => proof.store(0, Ordering::SeqCst),",
        "Err(StoreError::Io(_)) => {}",
    )], "a_real_write_stands_in_for_the_readiness_probe_until_one_is_refused"),
    ("real-write-stands-in-for-the-probe", API, [(
        "if !blobs_proven {",
        "if true {",
    )], "a_real_write_stands_in_for_the_readiness_probe_until_one_is_refused"),
    # --- shutdown (#203) -----------------------------------------------------
    ("long-poll-wake-on-shutdown", SERVE, [(
        "            app.store.release_waiters();\n",
        "",
    )], "a_shutdown_answers_every_open_long_poll_within_a_tick"),
    ("release-notifies-the-waiters", STORE, [(
        "        drop(self.index());\n        self.changed.notify_all();\n",
        "        drop(self.index());\n",
    )], "releasing_waiters_answers_a_long_poll_at_once_and_every_later_one"),
    ("stopping-is-part-of-the-wait", STORE, [(
        "index.seq <= since && !self.stopping.load(Ordering::SeqCst)",
        "index.seq <= since",
    )], "releasing_waiters_answers_a_long_poll_at_once_and_every_later_one"),
]


def main():
    # Probe names on the command line run only those; none runs them all.
    chosen = [case for case in CASES if not sys.argv[1:] or case[0] in sys.argv[1:]]
    paths = {Path(path) for _, path, _, _ in chosen}
    originals = {path: path.read_bytes() for path in paths}
    failures = []
    try:
        for name, path, edits, selector in chosen:
            source = originals[Path(path)].decode()
            for old, new in edits:
                if source.count(old) != 1:
                    raise RuntimeError(f"{name}: mutation context moved")
                source = source.replace(old, new, 1)
            Path(path).write_text(source)
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
    print(f"All {len(chosen)} server probes compiled and were killed.")


if __name__ == "__main__":
    main()
