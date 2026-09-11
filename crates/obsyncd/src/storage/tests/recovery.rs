//! Quarantine durability and recovery with task-owned synthetic chunks.
#![forbid(unsafe_code)]

use super::*;
use std::sync::mpsc;

const GOOD: &[u8] = b"synthetic-ciphertext-original";
const BAD: &[u8] = b"synthetic-damaged-ciphertext-with-a-different-and-longer-size";

fn damaged(cfg: &StorageConfig) -> (Setup, Sid) {
    let setup = ready(cfg);
    let sid = put(&setup, GOOD);
    fs::write(setup.store.blobs.path(&sid), BAD).expect("synthetic damage");
    (setup, sid)
}

fn target(cfg: &StorageConfig, sid: &Sid) -> std::path::PathBuf {
    cfg.journal_dir.join("v1/quarantine").join(sid.to_string())
}

#[test]
fn quarantine_failures_preserve_bytes_report_failure_and_recover() {
    for phase in [
        BlobPhase::QuarantineCopy,
        BlobPhase::QuarantineFileSync,
        BlobPhase::QuarantinePublish,
        BlobPhase::QuarantineSync,
        BlobPhase::QuarantineParentSync,
        BlobPhase::QuarantineRemove,
        BlobPhase::QuarantineSourceSync,
    ] {
        let dir = TempDir::new("quarantine-phase-recovery");
        let cfg = config(&dir);
        let (setup, sid) = damaged(&cfg);
        let store = &setup.store;
        store
            .index()
            .chunks
            .get_mut(&sid)
            .expect("chunk")
            .first_seen = UnixMs(17);
        let age = store.index().chunks[&sid].first_seen;
        store.set_fault(Fault::BlobErrno {
            phase,
            code: ENOSPC,
        });
        let summary = store.scrub_step(1 << 20);
        assert_eq!(summary.mismatches, 1, "{phase:?}");
        assert_eq!(
            summary.bytes_verified,
            BAD.len() as u64,
            "{phase:?} reports bytes actually hashed"
        );
        assert!(
            summary.quarantined.is_empty(),
            "failed {phase:?} is not success"
        );
        assert!(!summary.complete_pass, "{phase:?} stays pending");
        assert!(
            store
                .last_scrub()
                .expect("failure summary")
                .quarantined
                .is_empty()
        );
        assert!(
            store.chunk_exists(&sid),
            "{phase:?} retains conservative inventory"
        );
        assert_eq!(
            store.account().expect("account").used_bytes,
            BAD.len() as u64
        );
        assert_eq!(
            store.index().chunks[&sid].first_seen,
            age,
            "age is preserved"
        );
        assert_eq!(
            journal_used(store),
            journal_root_bytes(&cfg),
            "{phase:?} residue"
        );
        assert!(
            !unverified_flag(store),
            "a successful measure is trustworthy"
        );
        let log = store.log().captured();
        assert!(
            log.contains("event=scrub_repair_failed"),
            "{phase:?}: {log}"
        );
        assert!(log.contains("io=StorageFull"), "{phase:?}: {log}");
        assert!(!log.contains("event=chunk_quarantined"), "{phase:?}: {log}");
        if phase == BlobPhase::QuarantineSourceSync {
            assert!(!store.blobs.path(&sid).exists());
            assert_eq!(fs::read(target(&cfg, &sid)).expect("durable copy"), BAD);
        } else {
            assert_eq!(
                fs::read(store.blobs.path(&sid)).expect("primary retained"),
                BAD
            );
        }
        if matches!(
            phase,
            BlobPhase::QuarantineCopy
                | BlobPhase::QuarantineFileSync
                | BlobPhase::QuarantinePublish
        ) {
            assert_eq!(quarantine_bytes(&cfg), 0, "{phase:?} temporary cleanup");
        } else {
            assert_eq!(fs::read(target(&cfg, &sid)).expect("published copy"), BAD);
        }

        store.set_fault(Fault::None);
        let retried = store.scrub_step(1 << 20);
        assert!(retried.complete_pass, "{phase:?} finishes after recovery");
        assert_eq!(
            retried.quarantined.len(),
            usize::from(phase != BlobPhase::QuarantineSourceSync)
        );
        assert_eq!(store.missing_chunks(&[sid]), vec![sid]);
        assert_eq!(store.account().expect("account").used_bytes, 0);
        assert_eq!(fs::read(target(&cfg, &sid)).expect("preserved bytes"), BAD);
        drop(setup);
        let reopened = open(&cfg);
        assert!(!reopened.chunk_exists(&sid), "{phase:?} restart agrees");
        assert_eq!(journal_used(&reopened), journal_root_bytes(&cfg));
    }
}

#[test]
fn quarantine_restart_retries_retained_primary_without_trusting_the_old_summary() {
    for phase in [
        BlobPhase::QuarantineSync,
        BlobPhase::QuarantineRemove,
        BlobPhase::QuarantineSourceSync,
    ] {
        let dir = TempDir::new("quarantine-restart");
        let cfg = config(&dir);
        let (setup, sid) = damaged(&cfg);
        setup.store.set_fault(Fault::BlobErrno {
            phase,
            code: ENOSPC,
        });
        assert!(setup.store.scrub_step(1 << 20).quarantined.is_empty());
        setup.store.snapshot().expect("snapshot failure summary");
        drop(setup);
        let reopened = open(&cfg);
        assert!(
            reopened
                .last_scrub()
                .expect("recorded failure")
                .quarantined
                .is_empty()
        );
        let retained = phase != BlobPhase::QuarantineSourceSync;
        assert_eq!(reopened.chunk_exists(&sid), retained);
        assert_eq!(
            reopened.account().expect("account").used_bytes,
            if retained { BAD.len() as u64 } else { 0 }
        );
        assert_eq!(
            journal_used(&reopened),
            journal_root_bytes(&cfg),
            "both copies counted"
        );
        if retained {
            assert_eq!(reopened.scrub_step(1 << 20).quarantined, vec![sid]);
        }
        let account = reopened.account().expect("account").account_id;
        assert_eq!(
            reopened
                .put_chunk(&account, &sid, GOOD.len() as u64, &mut &GOOD[..])
                .expect("reupload"),
            PutOutcome::Created
        );
        assert_eq!(
            reopened.blobs.verify_primary(&sid).expect("verify"),
            Some(true)
        );
        assert_eq!(
            fs::read(target(&cfg, &sid)).expect("retained damaged bytes"),
            BAD
        );
    }
}

#[test]
fn quarantine_source_sync_failure_never_discards_a_recovery_upload() {
    let dir = TempDir::new("quarantine-upload-recovery");
    let cfg = config(&dir);
    let (setup, sid) = damaged(&cfg);
    setup.store.set_fault(Fault::BlobErrno {
        phase: BlobPhase::QuarantineSourceSync,
        code: ENOSPC,
    });
    assert!(setup.store.scrub_step(1 << 20).quarantined.is_empty());
    assert!(
        !setup.store.scrub_step(1 << 20).complete_pass,
        "a second failed sync keeps inventory pending"
    );
    let mut body = GOOD;
    assert!(
        setup
            .store
            .put_chunk(&setup.account, &sid, GOOD.len() as u64, &mut body)
            .is_err()
    );
    assert_eq!(
        body, GOOD,
        "a refused recovery does not consume and discard the body"
    );
    assert!(setup.store.chunk_exists(&sid));
    setup.store.set_fault(Fault::None);
    assert_eq!(
        setup
            .store
            .put_chunk(&setup.account, &sid, GOOD.len() as u64, &mut body)
            .expect("retry"),
        PutOutcome::Created
    );
    assert_eq!(
        setup.store.blobs.verify_primary(&sid).expect("verify"),
        Some(true)
    );
    assert_eq!(
        setup.store.account().expect("account").used_bytes,
        GOOD.len() as u64
    );
}

#[test]
fn quarantine_partial_copy_cleanup_failure_is_counted_and_startup_removes_only_temps() {
    let dir = TempDir::new("quarantine-partial-cleanup");
    let cfg = config(&dir);
    let (setup, sid) = damaged(&cfg);
    setup.store.set_fault(Fault::BlobErrno {
        phase: BlobPhase::QuarantineCleanup,
        code: ENOSPC,
    });
    assert!(setup.store.scrub_step(1 << 20).quarantined.is_empty());
    assert_eq!(quarantine_bytes(&cfg), 2, "real partial bytes remain");
    assert_eq!(journal_used(&setup.store), journal_root_bytes(&cfg));
    assert_eq!(
        fs::read(setup.store.blobs.path(&sid)).expect("original"),
        BAD
    );
    let quarantine = cfg.journal_dir.join("v1/quarantine");
    fs::write(target(&cfg, &sid), b"previous-quarantine").expect("prior final copy");
    fs::create_dir(quarantine.join(".tmp-directory")).expect("non-file sentinel");
    drop(setup);
    let reopened = open(&cfg);
    assert!(reopened.chunk_exists(&sid));
    assert!(
        reopened
            .log()
            .captured()
            .contains("event=quarantine_tmp_removed files=1")
    );
    assert_eq!(
        fs::read(target(&cfg, &sid)).expect("final copy survives"),
        b"previous-quarantine"
    );
    assert!(
        quarantine.join(".tmp-directory").is_dir(),
        "cleanup only removes regular temp files"
    );
    assert_eq!(
        fs::read_dir(&quarantine).expect("entries").count(),
        2,
        "only the final copy and non-file sentinel survive"
    );
    assert_eq!(journal_used(&reopened), journal_root_bytes(&cfg));
    assert_eq!(reopened.scrub_step(1 << 20).quarantined, vec![sid]);
}

#[test]
fn quarantine_temp_collision_never_overwrites_or_removes_a_file_it_did_not_create() {
    let dir = TempDir::new("quarantine-temp-collision");
    let cfg = config(&dir);
    let (setup, sid) = damaged(&cfg);
    let quarantine = cfg.journal_dir.join("v1/quarantine");
    fs::create_dir_all(&quarantine).expect("quarantine");
    let existing = quarantine.join(".tmp-collision");
    fs::write(&existing, b"prior-temporary-sentinel").expect("pre-existing temp");
    setup.store.set_fault(Fault::QuarantineTempCollision);
    let summary = setup.store.scrub_step(1 << 20);
    assert!(summary.quarantined.is_empty());
    assert!(!summary.complete_pass);
    assert_eq!(
        fs::read(&existing).expect("prior temp survives"),
        b"prior-temporary-sentinel"
    );
    assert_eq!(
        fs::read(setup.store.blobs.path(&sid)).expect("primary survives"),
        BAD
    );
    assert!(!target(&cfg, &sid).exists());
    assert_eq!(journal_used(&setup.store), journal_root_bytes(&cfg));
    assert!(setup.store.log().captured().contains("io=AlreadyExists"));
    setup.store.set_fault(Fault::None);
    assert_eq!(setup.store.scrub_step(1 << 20).quarantined, vec![sid]);
    assert_eq!(
        fs::read(&existing).expect("unowned temp still survives"),
        b"prior-temporary-sentinel"
    );
}

#[test]
fn quarantine_peak_admission_counts_existing_destination_and_actual_source_length() {
    let dir = TempDir::new("quarantine-peak-admission");
    let cfg = config(&dir);
    let (setup, sid) = damaged(&cfg);
    let quarantine = cfg.journal_dir.join("v1/quarantine");
    fs::create_dir_all(&quarantine).expect("quarantine");
    let prior = vec![b'p'; 4096];
    fs::write(target(&cfg, &sid), &prior).expect("prior copy");
    drop(setup);
    let mut tight = cfg.clone();
    tight.journal_capacity = WATERMARK + journal_root_bytes(&cfg) + BAD.len() as u64 - 1;
    let store = open(&tight);
    let before = journal_root_bytes(&tight);
    let summary = store.scrub_step(1 << 20);
    assert!(summary.quarantined.is_empty());
    assert!(!summary.complete_pass);
    assert_eq!(
        fs::read(store.blobs.path(&sid)).expect("source unchanged"),
        BAD
    );
    assert_eq!(
        fs::read(target(&tight, &sid)).expect("destination unchanged"),
        prior
    );
    assert_eq!(
        journal_root_bytes(&tight),
        before,
        "no room even for a failure summary"
    );
    assert_eq!(store.chunk_len(&sid), Some(BAD.len() as u64));
    assert!(store.log().captured().contains("decision=journal_full"));
}

#[test]
fn quarantine_failed_accounting_is_unverified_and_refuses_until_a_full_survey_succeeds() {
    let dir = TempDir::new("quarantine-survey-refusal");
    let cfg = config(&dir);
    let (setup, sid) = damaged(&cfg);
    let fault = setup.store.journal().fault_handle();
    setup.store.blobs.set_mid_move(Arc::new(move || {
        *fault.lock().expect("fault") = Fault::JournalSurveyErrno { code: ENOSPC };
    }));
    let before = journal_used(&setup.store);
    let summary = setup.store.scrub_step(1 << 20);
    assert!(
        summary.quarantined.is_empty(),
        "an unmeasured operation is not reported successful"
    );
    assert!(
        !summary.complete_pass,
        "accounting failure does not finish a pass"
    );
    assert!(
        !setup.store.chunk_exists(&sid),
        "durable physical absence is still true"
    );
    assert_eq!(fs::read(target(&cfg, &sid)).expect("durable copy"), BAD);
    assert!(unverified_flag(&setup.store));
    assert_eq!(
        journal_used(&setup.store),
        before,
        "retain last good total, never substitute zero"
    );
    assert!(matches!(
        setup
            .store
            .update_device(&setup.device, Some("refused".into()), None, None),
        Err(StoreError::JournalUnverified { .. })
    ));
    assert!(setup.store.verify_journal_usage().is_err());
    setup.store.set_fault(Fault::None);
    setup
        .store
        .verify_journal_usage()
        .expect("full resurvey recovers");
    assert!(!unverified_flag(&setup.store));
    assert_eq!(journal_used(&setup.store), journal_root_bytes(&cfg));
    assert_eq!(
        setup
            .store
            .put_chunk(&setup.account, &sid, GOOD.len() as u64, &mut &GOOD[..])
            .expect("reupload"),
        PutOutcome::Created
    );
}

#[test]
fn quarantine_admission_with_unknown_usage_preserves_the_primary() {
    let dir = TempDir::new("quarantine-unknown-admission");
    let cfg = config(&dir);
    let (setup, sid) = damaged(&cfg);
    setup
        .store
        .set_fault(Fault::JournalSurveyErrno { code: ENOSPC });
    let summary = setup.store.scrub_step(1 << 20);
    assert!(summary.quarantined.is_empty());
    assert!(!summary.complete_pass);
    assert!(unverified_flag(&setup.store));
    assert!(setup.store.chunk_exists(&sid));
    assert_eq!(
        fs::read(setup.store.blobs.path(&sid)).expect("primary intact"),
        BAD
    );
    assert!(
        !target(&cfg, &sid).exists(),
        "unknown usage refuses before copying"
    );
    setup.store.set_fault(Fault::None);
    assert_eq!(setup.store.scrub_step(1 << 20).quarantined, vec![sid]);
}

#[test]
fn quarantine_admission_never_interprets_an_unreadable_directory_as_zero() {
    let dir = TempDir::new("quarantine-preflight-survey");
    let cfg = config(&dir);
    let (setup, sid) = damaged(&cfg);
    let quarantine = cfg.journal_dir.join("v1/quarantine");
    fs::write(&quarantine, b"not-a-directory").expect("synthetic refused survey");
    let summary = setup.store.scrub_step(1 << 20);
    assert!(summary.quarantined.is_empty());
    assert!(!summary.complete_pass);
    assert!(unverified_flag(&setup.store));
    assert_eq!(
        fs::read(setup.store.blobs.path(&sid)).expect("primary intact"),
        BAD
    );
    fs::remove_file(&quarantine).expect("restore test precondition");
    assert_eq!(setup.store.scrub_step(1 << 20).quarantined, vec![sid]);
    assert!(!unverified_flag(&setup.store));
}

#[test]
fn quarantine_summary_append_failure_preserves_live_and_replayed_inventory() {
    for phase in [AppendPhase::Write, AppendPhase::Sync] {
        let dir = TempDir::new("quarantine-summary-refusal");
        let cfg = config(&dir);
        let (setup, sid) = damaged(&cfg);
        setup.store.set_fault(Fault::JournalAppendErrno {
            code: ENOSPC,
            at: phase,
        });
        let summary = setup.store.scrub_step(1 << 20);
        assert_eq!(
            summary.quarantined,
            vec![sid],
            "physical operation completed"
        );
        assert!(summary.complete_pass);
        assert_eq!(setup.store.missing_chunks(&[sid]), vec![sid]);
        assert_eq!(setup.store.account().expect("account").used_bytes, 0);
        assert!(
            setup.store.last_scrub().is_none(),
            "uncommitted summary is not durable history"
        );
        setup.store.set_fault(Fault::None);
        assert_eq!(
            setup
                .store
                .put_chunk(&setup.account, &sid, GOOD.len() as u64, &mut &GOOD[..])
                .expect("reupload"),
            PutOutcome::Created
        );
        drop(setup);
        let reopened = open(&cfg);
        assert_eq!(
            reopened.blobs.verify_primary(&sid).expect("verify"),
            Some(true)
        );
        assert_eq!(
            reopened.account().expect("account").used_bytes,
            GOOD.len() as u64
        );
        assert_eq!(journal_used(&reopened), journal_root_bytes(&cfg));
    }
}

#[test]
fn quarantine_delayed_summary_cannot_forget_a_new_upload() {
    let dir = TempDir::new("quarantine-delayed-summary");
    let cfg = config(&dir);
    let (setup, sid) = damaged(&cfg);
    let account = setup.account;
    let store = Arc::new(setup.store);
    let weak = Arc::downgrade(&store);
    *store.before_scrub_summary.lock().expect("hook") = Some(Arc::new(move || {
        let store = weak.upgrade().expect("store");
        assert_eq!(
            store
                .put_chunk(&account, &sid, GOOD.len() as u64, &mut &GOOD[..])
                .expect("upload before summary"),
            PutOutcome::Created
        );
    }));
    assert_eq!(store.scrub_step(1 << 20).quarantined, vec![sid]);
    assert!(
        store.chunk_exists(&sid),
        "summary is historical, not an inventory deletion"
    );
    assert_eq!(
        store.account().expect("account").used_bytes,
        GOOD.len() as u64
    );
    assert_eq!(
        store.blobs.verify_primary(&sid).expect("verify"),
        Some(true)
    );
    store
        .snapshot()
        .expect("snapshot preserves summary compatibility");
    drop(store);
    let reopened = open(&cfg);
    assert!(reopened.chunk_exists(&sid));
    assert_eq!(
        reopened
            .last_scrub()
            .expect("historical summary")
            .quarantined,
        vec![sid]
    );
    assert_eq!(
        reopened.account().expect("account").used_bytes,
        GOOD.len() as u64
    );
}

#[test]
fn quarantine_holds_sid_and_journal_guards_and_copies_to_a_distinct_file() {
    let dir = TempDir::new("quarantine-serialized-copy");
    let cfg = config(&dir);
    let (setup, sid) = damaged(&cfg);
    let store = Arc::new(setup.store);
    let original = fs::metadata(store.blobs.path(&sid)).expect("primary");
    let weak = Arc::downgrade(&store);
    let dest = target(&cfg, &sid);
    store.blobs.set_mid_move(Arc::new(move || {
        let store = weak.upgrade().expect("store");
        assert!(
            store.chunk_locks[usize::from(sid.as_bytes()[0])]
                .try_lock()
                .is_err()
        );
        assert!(store.journal_guard_held());
        assert!(
            store.index.try_lock().is_ok(),
            "copy does not block index readers"
        );
        assert_eq!(
            fs::read(store.blobs.path(&sid)).expect("source still present"),
            BAD
        );
        assert_eq!(fs::read(&dest).expect("complete copy"), BAD);
        let copied = fs::metadata(&dest).expect("destination");
        assert_ne!(
            (original.dev(), original.ino()),
            (copied.dev(), copied.ino()),
            "a new destination file, not a rename or hard link of the primary"
        );
    }));
    assert_eq!(store.scrub_step(1 << 20).quarantined, vec![sid]);
}

#[test]
fn quarantine_skips_a_candidate_whose_collection_already_finished() {
    let dir = TempDir::new("quarantine-stale-candidate");
    let cfg = config(&dir);
    let setup = ready(&cfg);
    let a = put(&setup, b"synthetic-chunk-a");
    let b = put(&setup, b"synthetic-chunk-b");
    let (first, collected) = if a < b { (a, b) } else { (b, a) };
    for sid in [first, collected] {
        fs::write(setup.store.blobs.path(&sid), BAD).expect("synthetic damage");
    }
    let store = Arc::new(setup.store);
    let weak = Arc::downgrade(&store);
    store.blobs.set_mid_move(Arc::new(move || {
        let store = weak.upgrade().expect("store");
        // Model a completed collection after selection. The actual GC's SID
        // serialization is tested separately; this fixture makes the stale
        // candidate deterministic without depending on thread scheduling.
        store
            .blobs
            .remove(&collected)
            .expect("completed collection");
        store.index().forget_chunk(&collected);
    }));
    let summary = store.scrub_step(1 << 20);
    assert_eq!(summary.quarantined, vec![first]);
    assert!(summary.complete_pass);
    assert!(
        !store.log().captured().contains("event=chunk_missing"),
        "a collected candidate is not reported as lost data"
    );
}

#[test]
fn quarantine_upload_holds_only_its_sid_lock_while_streaming() {
    struct CheckedBody<'a> {
        store: &'a Store,
        sid: Sid,
        bytes: &'static [u8],
    }
    impl Read for CheckedBody<'_> {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            assert!(
                self.store.chunk_locks[usize::from(self.sid.as_bytes()[0])]
                    .try_lock()
                    .is_err()
            );
            assert!(self.store.index.try_lock().is_ok());
            assert!(!self.store.journal_guard_held());
            self.bytes.read(out)
        }
    }
    let dir = TempDir::new("quarantine-upload-lock");
    let setup = ready(&config(&dir));
    let sid = Sid::new(sha256(GOOD));
    let mut body = CheckedBody {
        store: &setup.store,
        sid,
        bytes: GOOD,
    };
    assert_eq!(
        setup
            .store
            .put_chunk(&setup.account, &sid, GOOD.len() as u64, &mut body)
            .expect("upload"),
        PutOutcome::Created
    );
    assert_eq!(
        setup.store.blobs.verify_primary(&sid).expect("verify"),
        Some(true)
    );
}

#[test]
fn quarantine_gc_releases_partial_stripes_and_skips_without_waiting() {
    let dir = TempDir::new("quarantine-gc-contention");
    let cfg = config(&dir);
    let store = Arc::new(ready_existing(&cfg));
    let busy = store.chunk_locks[255].lock().expect("busy upload");
    let (tx, rx) = mpsc::channel();
    let worker = Arc::clone(&store);
    let join = thread::spawn(move || {
        let summary = worker.gc_run(UnixMs::now());
        tx.send(summary).expect("result");
    });
    let promptly = rx.recv_timeout(Duration::from_secs(5));
    drop(busy);
    join.join().expect("GC returns");
    let summary = promptly.expect("GC skips instead of waiting for a slow upload");
    assert_eq!(summary.chunks_collected, 0);
    assert!(
        store.last_gc().is_none(),
        "a skipped pass has no success frame"
    );
    assert!(
        store.try_all_chunks().is_some(),
        "all earlier stripes were released"
    );
    assert!(
        store
            .log()
            .captured()
            .contains("event=gc_skipped decision=chunks_busy")
    );
    store.gc_run(UnixMs::now());
    assert!(store.last_gc().is_some(), "a later quiet pass proceeds");
}
