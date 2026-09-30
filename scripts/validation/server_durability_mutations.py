#!/usr/bin/env python3
"""Reproduce the server durability guard probes (#191, #192, #203, #273, #291,
#292, #294) from the repository root.

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
BLOBS = "crates/obsyncd/src/storage/blobs.rs"
TYPES = "crates/obsyncd/src/storage/types.rs"
SERVE = "crates/obsyncd/src/cli/serve.rs"

GROUP = "concurrent_requests_share_an_fsync_and_none_is_answered_before_its_own"
PENDING = "a_nonce_in_flight_is_already_a_replay_and_the_check_does_not_wait_for_the_volume"
REFUSED = "a_refused_batch_answers_every_member_and_leaves_every_nonce_unspent"
PANIC = "a_flush_that_panics_answers_every_member_and_blocks_nobody"
READ = "a_snapshot_is_read_a_file_at_a_time_to_the_index_it_was_written_from"
FSYNC = "a_writer_s_fsync_holds_the_journal_and_never_the_index_and_nothing_is_applied_before_it"
GROWTH = "a_snapshot_is_due_after_the_journal_grows_past_the_floor_and_the_last_snapshot"
SNAPSHOT = "a_snapshot_is_written_with_no_guard_held_and_a_crash_part_way_loses_nothing"
FANOUT = "a_new_fan_out_directory_is_durable_in_its_parent_before_its_chunk_is_acknowledged"
FANOUT_START = "a_start_after_a_cut_upload_makes_every_fan_out_name_durable"
NO_ROOM = "the_disk_cannot_hold"
NONCE_NO_ROOM = "journal_volume_with_no_room"
NONCE_NOT_READY = "a_faulted_nonce_log_is_not_ready_until_a_restart"

CASES = [
    # --- nonce log group commit (#191) ------------------------------------
    ("wait-for-durable", AUTH, [(
        "None => self\n                    .settled\n                    .wait(state)\n"
        "                    .unwrap_or_else(PoisonError::into_inner),",
        "None => return Ok(()),",
    )], GROUP),
    ("answer-before-the-flush", AUTH, [(
        "        self.state = None;\n        let written = rewrite",
        "        let _ = self.batch.outcome.set(Ok(()));\n        cache.settled.notify_all();\n"
        "        self.state = None;\n        let written = rewrite",
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
        ("        self.state = None;\n        let written = rewrite", "        let written = rewrite"),
        ("        let state = self.state.insert(cache.state());\n",
         "        let state = self.state.as_mut().expect(\"still locked\");\n"),
    ], PENDING),
    ("rewrite-excludes-the-batch", AUTH, [(
        "window(state.seen.iter().filter(|(e, _)| !pending.contains(e)))",
        "window(state.seen.iter().filter(|_| !pending.is_empty()))",
    )], "a_rewrite_holds_what_was_durable_and_never_the_batch_it_precedes"),
    ("refused-batch-is-cut-back", NONCE_LOG, [(
        "        self.file.set_len(self.durable_len)?;\n",
        "",
    )], "a_refused_batch_is_cut_back_so_the_next_one_lands_on_a_clean_line"),
    # --- a flush that panics settles its batch (drop guard) -----------------
    # Retargeted in 1.1.5 (#292): the outcome carries the refusal and whether
    # the log is faulted now; the subject, the batch settled, is the same.
    ("panicked-flight-settles", AUTH, [(
        "        let _ = self.batch.outcome.set(Err(Refused {\n"
        "            io: std::io::ErrorKind::Other,\n            faulted,\n        }));\n", "",
    )], PANIC),
    ("panicked-flight-unspends", AUTH, [(
        "        for (ts, entry) in &self.batch.entries {\n            state.unspend(*ts, entry);\n"
        "        }\n        let faulted = file.faulted();\n        state.durable = Some(file);\n",
        "        let faulted = file.faulted();\n        state.durable = Some(file);\n",
    )], PANIC),
    ("panicked-flight-wakes", AUTH, [(
        "        drop(state);\n        cache.settled.notify_all();\n",
        "        drop(state);\n",
    )], PANIC),
    # Retired: panicked-flight-clears-poison. 6821028 removed its subject,
    # `clear_poison()`, which raced a woken member; both lock sites now take
    # the guard out of the poison, probed by ci_green_mutations.py.
    ("panicked-flight-cuts-back", NONCE_LOG, [(
        "    pub fn abandon(&mut self) {\n        if let Err(e) = self.rollback() {\n"
        "            self.faulted = Some(e.kind());\n        }\n",
        "    pub fn abandon(&mut self) {\n",
    )], PANIC),
    ("panicked-leader-answered", AUTH, [(
        "                Some(file) => catch_unwind(AssertUnwindSafe(|| self.flush(state, file, now)))\n"
        "                    .unwrap_or_else(|_| self.state()),\n",
        "                Some(file) => self.flush(state, file, now),\n",
    )], PANIC),
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
    # Retargeted in 1.1.5: the frames are built for a whole group commit now
    # (`Store::write_versions`); the subject, the post's own edit event, is
    # the same.
    ("edit-event-folded-into-the-post", STORE, [(
        "                if let Some(event) = &post.edit {\n",
        "                if let Some(event) = post.edit.as_ref().filter(|_| false) {\n",
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
    # --- a snapshot read a file at a time (#205) ------------------------------
    ("snapshot-read-checks-the-crc", JOURNAL, [(
        "Ok(index) => Ok((payload.crc.finalize() == crc).then_some((index, total))),",
        "Ok(index) => Ok(Some((index, total))),",
    )], READ),
    ("snapshot-read-follows-escapes", JOURNAL, [(
        "                b'\\\\' => out.push(self.byte()?),\n", "",
    )], READ),
    ("snapshot-read-follows-nesting", JOURNAL, [(
        "                        b'{' | b'[' => depth += 1,\n", "",
    )], READ),
    ("snapshot-read-nothing-after", JOURNAL, [(
        "            if !matches!(self.byte()?, b' ' | b'\\t' | b'\\n' | b'\\r') {",
        "            if self.byte()? == 0 {",
    )], READ),
    ("snapshot-read-member-once", JOURNAL, [(
        "                if members.iter().any(|(k, _)| *k == key) {", "                if false {",
    )], READ),
    ("snapshot-read-files-once", JOURNAL, [(
        "                if files.is_some() {", "                if false {",
    )], READ),
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
    # --- scrub paced by the time it works (#216) -----------------------------
    ("scrub-rests-for-its-work", SERVE, [(
        "    by_rate.max(worked.mul_f64(rest_per_work))", "    by_rate",
    )], "the_scrub_rests_for_the_rate_or_its_work_whichever_is_longer"),
    ("scrub-loop-is-paced", SERVE, [(
        "        nap(app, scrub_pause(by_rate, worked));", "        nap(app, by_rate);",
    )], "a_scrub_step_rests_for_the_time_it_worked"),
    ("scrub-work-counted", STORE, [(
        "        totals.worked_ms += summary.duration_ms;\n", "",
    )], "a_pass_walks_each_chunk_once_journals_once_and_logs_one_start_and_summary"),
    ("scrub-work-logged", STORE, [(
        "                    (\"worked_ms\", Val::ms(totals.worked_ms)),\n", "",
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
    # --- a new fan-out directory's name (#273) -------------------------------
    ("fanout-parent-fsync", BLOBS, [(
        "            if self.unsynced().contains(step) {",
        "            if false && self.unsynced().contains(step) {",
    )], FANOUT),
    ("fanout-existing-is-not-durable", BLOBS, [(
        "                #[cfg(test)]\n                self.errno_at(BlobPhase::DirParentSync)?;\n"
        "                fsync_parent(step)?;\n                self.unsynced().remove(step);\n",
        "                self.unsynced().remove(step);\n                #[cfg(test)]\n"
        "                self.errno_at(BlobPhase::DirParentSync)?;\n                fsync_parent(step)?;\n",
    )], FANOUT),
    ("fanout-synced-once-a-cut-start", BLOBS, [(
        "            if left > 0 {",
        "            if left > u64::MAX - 1 {",
    )], FANOUT_START),
    # --- a disk with no room is a full server, not a fault (#291) ------------
    ("storage-full-code", TYPES, [(
        "        if self.out_of_space() {\n            return \"storage_full\";\n        }\n", "",
    )], NO_ROOM),
    ("storage-full-status", API, [(
        "            ref full if full.out_of_space() => {\n"
        "                ApiError::new(507, code, \"the volume is out of space\")\n            }\n", "",
    )], NO_ROOM),
    ("storage-full-counts-a-filesystem-quota", TYPES, [(
        "                io::ErrorKind::StorageFull | io::ErrorKind::QuotaExceeded\n",
        "                io::ErrorKind::StorageFull\n",
    )], "a_full_blob_volume_refuses_per_phase_and_leaves_that_phase_s_residue"),
    # --- the nonce log on a journal volume with no room (#292) ---------------
    ("nonce-no-room-is-storage-full", AUTH, [(
        "    if matches!(\n        refused.io,\n"
        "        std::io::ErrorKind::StorageFull | std::io::ErrorKind::QuotaExceeded\n    ) {\n"
        "        return ApiError::new(507, \"storage_full\", \"the volume is out of space\");\n    }\n", "",
    )], NONCE_NO_ROOM),
    # Re-anchored in 1.1.5 (#294): the refusal carries what the cut answered
    # now; the subject, a faulted log never answered 507, is the same.
    ("nonce-faulted-log-never-reads-full", AUTH, [(
        "    if refused.faulted.is_some() {\n", "    if false && refused.faulted.is_some() {\n",
    )], "a_faulted_nonce_log_says_so_until_a_restart_and_never_that_it_is_full"),
    ("nonce-no-room-leaves-the-nonce-unspent", AUTH, [(
        "            for (ts, entry) in &self.batch.entries {\n                state.unspend(*ts, entry);\n"
        "            }\n        }\n        let faulted = file.faulted();\n",
        "        }\n        let faulted = file.faulted();\n",
    )], NONCE_NO_ROOM),
    # --- readiness asks the nonce log (#294) ----------------------------------
    ("readiness-asks-the-nonce-log", API, [(
        "        if let Some(kind) = self.nonces.faulted() {\n"
        "            self.not_ready(\"journal\", &std::io::Error::from(kind));\n"
        "            return Err(NotReady {\n"
        "                reason: \"nonce log faulted; restart to recover\",\n"
        "                io: None,\n            });\n        }\n", "",
    )], NONCE_NOT_READY),
    ("the-flush-remembers-the-fault", AUTH, [(
        "        cache.found(faulted);\n        let _ = self.batch.outcome.set(written",
        "        let _ = self.batch.outcome.set(written",
    )], NONCE_NOT_READY),
    ("a-clean-cut-is-no-fault", AUTH, [(
        "        if let Some(kind) = faulted\n",
        "        if let Some(kind) = faulted.or(Some(std::io::ErrorKind::Other))\n",
    )], NONCE_NO_ROOM),
    ("clean-no-room-leaves-the-journal-unfaulted", JOURNAL, [(
        "            Ok(()) => (\"truncated\", None),\n",
        "            Ok(()) => {\n                self.faulted = Some(Faulted {\n"
        "                    io: e.kind(),\n                    rollback_io: e.kind(),\n"
        "                });\n                (\"truncated\", None)\n            }\n",
    )], "a_journal_append_the_disk_cannot_hold"),
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
