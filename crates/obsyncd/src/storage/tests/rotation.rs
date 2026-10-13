//! Author causal tests for the specific floor/rotation lifecycle.
#![forbid(unsafe_code)]
use super::*;
use crate::storage::rotation::{RotationCompletion, RotationIntent};

fn intent() -> RotationIntent {
    RotationIntent {
        operation: "ab".repeat(16),
        previous_map: file(0x80),
        current_map: file(0x81),
        target: None,
        recovery_verifier: hex::encode(&sha256(&[0xc7; 32])),
    }
}
fn seed(setup: &Setup, fid: FileId, tag: &str, parents: &[VersionId], suite2: bool) -> VersionId {
    let mut v = version(setup, fid, tag, parents, &[], false);
    if suite2 {
        v.manifest_seal = ManifestSeal::Suite2;
    }
    let id = v.version_id;
    setup.store.append_version(v).unwrap();
    id
}
fn completion(
    store: &Store,
    state: &crate::storage::rotation::RotationState,
) -> RotationCompletion {
    RotationCompletion {
        cutoff: state.cutoff,
        inventory_hash: state.inventory_hash.clone(),
        catalog_pages: state.catalog_pages,
        catalog_hash: store.rotation_catalog_commitment(state).unwrap(),
    }
}
#[test]
fn rotation_fence_all_heads_ownership_catalog_commit_and_restart() {
    let dir = TempDir::new("rotation-lifecycle");
    let cfg = config(&dir);
    let setup = ready(&cfg);
    let other = spare_device(&setup.store, setup.account);
    let root = seed(&setup, file(1), "root", &[], false);
    let left = seed(&setup, file(1), "left", &[root], false);
    let right = seed(&setup, file(1), "right", &[root], false);
    let mut tombstone = version(&setup, file(2), "tombstone", &[], &[], true);
    let dead = tombstone.version_id;
    setup.store.append_version(tombstone.clone()).unwrap();
    let i = intent();
    let before = setup.store.index().seq;
    let state = setup
        .store
        .prepare_rotation(setup.device, i.clone())
        .unwrap();
    assert_eq!(state.cutoff, before);
    assert_eq!(state.inventory_heads, 3);
    let heads = setup
        .store
        .rotation_inventory(setup.device, &i.operation, 0)
        .unwrap();
    let mut forks = [left, right];
    forks.sort();
    assert_eq!(
        heads,
        vec![(file(1), forks[0]), (file(1), forks[1]), (file(2), dead)]
    );
    assert!(
        setup
            .store
            .rotation_inventory(setup.device, &i.operation, 1)
            .is_err()
    );
    assert!(
        setup
            .store
            .authorize_request(other, "GET", "/v1/account")
            .is_err()
    );
    tombstone.manifest_seal = ManifestSeal::Suite2;
    assert!(matches!(
        setup.store.append_version(tombstone),
        Err(StoreError::AuthorityRefused("generation_mismatch"))
    ));
    let mut blocked = version(&setup, file(5), "legacy", &[], &[], false);
    assert!(matches!(
        setup.store.append_version(blocked.clone()),
        Err(StoreError::AuthorityRefused("suite_required"))
    ));
    blocked.manifest_seal = ManifestSeal::Suite2;
    blocked.device_id = other;
    assert!(matches!(
        setup.store.append_version(blocked),
        Err(StoreError::AuthorityRefused("rotation_pending"))
    ));
    assert!(
        setup
            .store
            .setup_enrolment(atomic_setup(Some(&"a7".repeat(32)), true), UnixMs(11))
            .is_err()
    );
    assert!(
        setup
            .store
            .commit_rotation(
                setup.device,
                &i,
                &completion(&setup.store, &state),
                UnixMs(11)
            )
            .is_err()
    );
    let mut entries = vec![];
    for (n, (f, v)) in heads.iter().enumerate() {
        let nf = file(0x90 + n as u8);
        let nv = seed(&setup, nf, &format!("fresh-{n}"), &[], true);
        entries.push((*f, *v, nf, nv));
    }
    seed(&setup, i.current_map, "fresh-map", &[], true);
    let mut bad = entries.clone();
    bad.swap(0, 1);
    assert!(
        setup
            .store
            .rotation_catalog(setup.device, &i.operation, 0, bad)
            .is_err()
    );
    assert!(
        setup
            .store
            .rotation_catalog(setup.device, &i.operation, 1, entries.clone())
            .is_err()
    );
    let state = setup
        .store
        .rotation_catalog(setup.device, &i.operation, 0, entries.clone())
        .unwrap();
    assert_eq!(
        setup
            .store
            .rotation_catalog(setup.device, &i.operation, 0, entries.clone())
            .unwrap(),
        state
    );
    let mut bad = entries;
    bad[0].2 = file(0x99);
    assert!(
        setup
            .store
            .rotation_catalog(setup.device, &i.operation, 0, bad)
            .is_err()
    );
    let done = completion(&setup.store, &state);
    let committed = setup
        .store
        .commit_rotation(setup.device, &i, &done, UnixMs(12))
        .unwrap();
    assert!(committed.committed);
    assert_eq!(setup.store.current_generation(), Some(i.current_map));
    assert_eq!(setup.store.device_secret(&other), None);
    assert_eq!(
        setup
            .store
            .commit_rotation(setup.device, &i, &done, UnixMs(13))
            .unwrap(),
        committed
    );
    setup.store.snapshot().unwrap();
    let own = setup.device;
    drop(setup);
    let restored = open(&cfg);
    assert_eq!(
        restored.rotation_status(own, &i.operation).unwrap(),
        committed
    );
    assert_eq!(restored.current_generation(), Some(i.current_map));
    assert_eq!(restored.device_secret(&other), None);
    let mut recover = atomic_setup(Some(&"c7".repeat(32)), true);
    recover.generation = Some(i.current_map);
    restored.setup_enrolment(recover, UnixMs(14)).unwrap();
}
#[test]
fn rotation_resume_is_atomic_idempotent_and_cannot_resurrect_retired_grants() {
    let dir = TempDir::new("rotation-resume");
    let cfg = config(&dir);
    let setup = ready(&cfg);
    let i = intent();
    setup
        .store
        .prepare_rotation(setup.device, i.clone())
        .unwrap();
    let input = || {
        let mut d = atomic_setup(Some(&"c7".repeat(32)), true);
        d.generation = Some(i.current_map);
        d
    };
    let mut wrong = i.clone();
    wrong.target = Some(setup.device);
    assert!(
        setup
            .store
            .resume_rotation(wrong, "01".repeat(16), input(), UnixMs(12))
            .is_err()
    );
    let a = setup
        .store
        .resume_rotation(i.clone(), "01".repeat(16), input(), UnixMs(12))
        .unwrap();
    assert_eq!(setup.store.device_secret(&setup.device), None);
    let again = setup
        .store
        .resume_rotation(i.clone(), "01".repeat(16), input(), UnixMs(13))
        .unwrap();
    assert_eq!(a.device.device_id, again.device.device_id);
    assert_eq!(setup.store.devices().len(), 2);
    let b = setup
        .store
        .resume_rotation(i.clone(), "02".repeat(16), input(), UnixMs(14))
        .unwrap();
    assert_eq!(setup.store.device_secret(&a.device.device_id), None);
    assert!(matches!(
        setup
            .store
            .resume_rotation(i.clone(), "01".repeat(16), input(), UnixMs(15)),
        Err(StoreError::AuthorityRefused("resume_superseded"))
    ));
    setup.store.snapshot().unwrap();
    drop(setup);
    let restored = open(&cfg);
    assert_eq!(
        restored
            .rotation_status(b.device.device_id, &i.operation)
            .unwrap()
            .coordinator,
        b.device.device_id
    );
    let again = restored
        .resume_rotation(i.clone(), "02".repeat(16), input(), UnixMs(16))
        .unwrap();
    assert_eq!(again.device.device_id, b.device.device_id);
}
#[test]
fn rotation_late_chunk_publication_rechecks_fence_without_holding_stream_lock() {
    let dir = TempDir::new("rotation-late-chunk");
    let cfg = config(&dir);
    let setup = ready(&cfg);
    let old = spare_device(&setup.store, setup.account);
    let i = intent();
    let body = b"ciphertext arriving across fence";
    let sid = Sid::new(sha256(body));
    struct Fence<'a> {
        setup: &'a Setup,
        bytes: &'a [u8],
        intent: Option<RotationIntent>,
    }
    impl Read for Fence<'_> {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            if let Some(i) = self.intent.take() {
                self.setup
                    .store
                    .prepare_rotation(self.setup.device, i)
                    .unwrap();
            }
            let n = out.len().min(self.bytes.len());
            out[..n].copy_from_slice(&self.bytes[..n]);
            self.bytes = &self.bytes[n..];
            Ok(n)
        }
    }
    let mut stream = Fence {
        setup: &setup,
        bytes: body,
        intent: Some(i),
    };
    assert!(matches!(
        setup.store.put_chunk_scoped(
            old,
            None,
            &setup.account,
            &sid,
            body.len() as u64,
            &mut stream
        ),
        Err(StoreError::AuthorityRefused("grant_changed"))
    ));
    assert!(!setup.store.chunk_exists(&sid));
    assert!(!setup.store.chunk_path(&sid).exists());
    assert_eq!(setup.store.account().unwrap().used_bytes, 0);
    assert_eq!(setup.store.index().reserved_bytes, 0);
}

#[test]
fn rotation_fence_rechecks_already_queued_grouped_posts() {
    let dir = TempDir::new("rotation-queued");
    let cfg = config(&dir);
    let setup = ready(&cfg);
    let mut v = version(&setup, file(4), "queued", &[], &[], false);
    v.manifest_seal = ManifestSeal::Suite2;
    let ticket = setup.store.versions().enqueue(Queued {
        scope: setup.store.request_scope(setup.device),
        v,
        accept_existing: false,
        edit: None,
    });
    setup
        .store
        .prepare_rotation(setup.device, intent())
        .unwrap();
    let batch = setup.store.versions().batch();
    assert_eq!(batch.len(), 1);
    let answers = setup.store.commit_batch(&mut setup.store.journal(), batch);
    assert_eq!(answers[0].0, ticket);
    // Original coordinator now owns Gnew; a queued write naming an old file
    // is refused too, while a fresh ID may publish only suite2.
    assert!(matches!(
        answers[0].1.0,
        Err(StoreError::AuthorityRefused("grant_changed"))
    ));
    assert!(setup.store.file(&file(4)).is_none());
}

#[test]
fn rotation_append_failures_do_not_publish_transfer_catalog_or_commit() {
    for phase in [AppendPhase::Write, AppendPhase::Sync] {
        let dir = TempDir::new("rotation-refused-transition");
        let cfg = config(&dir);
        let setup = ready(&cfg);
        let i = intent();
        let oldhead = seed(&setup, file(1), "old", &[], false);
        setup.store.set_fault(Fault::JournalAppendErrno {
            code: 28,
            at: phase,
        });
        assert!(
            setup
                .store
                .prepare_rotation(setup.device, i.clone())
                .is_err()
        );
        assert_eq!(setup.store.current_generation(), None);
        setup.store.set_fault(Fault::None);
        setup
            .store
            .prepare_rotation(setup.device, i.clone())
            .unwrap();
        let fresh = seed(&setup, file(0x90), "fresh", &[], true);
        seed(&setup, i.current_map, "map", &[], true);
        let entries = vec![(file(1), oldhead, file(0x90), fresh)];
        setup.store.set_fault(Fault::JournalAppendErrno {
            code: 28,
            at: phase,
        });
        assert!(
            setup
                .store
                .rotation_catalog(setup.device, &i.operation, 0, entries.clone())
                .is_err()
        );
        assert_eq!(
            setup
                .store
                .index()
                .authority
                .rotation
                .as_ref()
                .unwrap()
                .catalog_heads,
            0
        );
        setup.store.set_fault(Fault::None);
        let state = setup
            .store
            .rotation_catalog(setup.device, &i.operation, 0, entries)
            .unwrap();
        let mut input = atomic_setup(Some(&"c7".repeat(32)), true);
        input.generation = Some(i.current_map);
        setup.store.set_fault(Fault::JournalAppendErrno {
            code: 28,
            at: phase,
        });
        assert!(
            setup
                .store
                .resume_rotation(i.clone(), "01".repeat(16), input, UnixMs(11))
                .is_err()
        );
        assert_eq!(
            setup
                .store
                .index()
                .authority
                .rotation
                .as_ref()
                .unwrap()
                .coordinator,
            setup.device
        );
        assert!(setup.store.device_secret(&setup.device).is_some());
        assert!(
            setup
                .store
                .commit_rotation(
                    setup.device,
                    &i,
                    &completion(&setup.store, &state),
                    UnixMs(12)
                )
                .is_err()
        );
        assert_eq!(setup.store.current_generation(), Some(i.previous_map));
        setup.store.set_fault(Fault::None);
        drop(setup);
        let restored = open(&cfg);
        assert_eq!(restored.current_generation(), Some(i.previous_map));
        assert!(
            !restored
                .index()
                .authority
                .rotation
                .as_ref()
                .unwrap()
                .committed
        );
        assert_eq!(restored.devices().len(), 1);
    }
}

#[test]
fn rotation_duplicate_destinations_and_changed_owner_intent_are_refused() {
    let dir = TempDir::new("rotation-catalog-duplicates");
    let cfg = config(&dir);
    let setup = ready(&cfg);
    let i = intent();
    let a = seed(&setup, file(1), "old-a", &[], false);
    let b = seed(&setup, file(2), "old-b", &[], false);
    let state = setup
        .store
        .prepare_rotation(setup.device, i.clone())
        .unwrap();
    let mut changed = i.clone();
    changed.recovery_verifier = "ff".repeat(32);
    assert!(setup.store.prepare_rotation(setup.device, changed).is_err());
    let destination = seed(&setup, file(0x90), "fresh", &[], true);
    assert!(
        setup
            .store
            .rotation_catalog(
                setup.device,
                &i.operation,
                0,
                vec![
                    (file(1), a, file(0x90), destination),
                    (file(2), b, file(0x90), destination)
                ]
            )
            .is_err()
    );
    setup
        .store
        .rotation_catalog(
            setup.device,
            &i.operation,
            0,
            vec![(file(1), a, file(0x90), destination)],
        )
        .unwrap();
    assert!(
        setup
            .store
            .rotation_catalog(
                setup.device,
                &i.operation,
                1,
                vec![(file(2), b, file(0x90), destination)]
            )
            .is_err()
    );
    assert_eq!(state.inventory_heads, 2);
}

#[test]
fn rotation_floor_marker_survives_compaction_and_refuses_legacy_snapshot_fallback() {
    let dir = TempDir::new("rotation-floor-compaction");
    let cfg = config(&dir);
    let setup = ready(&cfg);
    setup.store.snapshot().unwrap();
    let oldseq = setup.store.head_seq();
    let legacy = fs::read(cfg.journal_dir.join(format!("v1/index/{}.snap", oldseq.0))).unwrap();
    setup
        .store
        .prepare_rotation(setup.device, intent())
        .unwrap();
    setup.store.snapshot().unwrap();
    for n in 0..3 {
        setup.store.journal().force_roll().unwrap();
        setup
            .store
            .update_device(&setup.device, Some(format!("snapshot-{n}")), None, None)
            .unwrap();
        setup.store.snapshot().unwrap();
    }
    let marker = cfg.journal_dir.join("v1/journal/000000.log");
    assert!(marker.is_file());
    assert!(
        !cfg.journal_dir.join("v1/journal/000001.log").exists(),
        "floor-bearing ordinary segment actually pruned"
    );
    let own = setup.device;
    drop(setup);
    let restored = open(&cfg);
    assert_eq!(
        restored
            .rotation_status(own, &intent().operation)
            .unwrap()
            .intent,
        intent()
    );
    drop(restored);
    for entry in fs::read_dir(cfg.journal_dir.join("v1/index")).unwrap() {
        fs::remove_file(entry.unwrap().path()).unwrap();
    }
    fs::write(
        cfg.journal_dir.join(format!("v1/index/{}.snap", oldseq.0)),
        legacy,
    )
    .unwrap();
    let log = Log::buffered(LogLevel::Debug);
    let posture = Posture::enforce(&cfg, &log).unwrap();
    assert!(matches!(
        Store::open(&cfg, [7; 32], &posture, log),
        Err(StoreError::Corrupt(_))
    ));
    assert!(marker.is_file(), "permanent barrier never silently deleted");
}

#[test]
fn rotation_same_coordinator_chunk_and_staging_queue_keep_admission_scope() {
    let dir = TempDir::new("rotation-coordinator-epochs");
    let cfg = config(&dir);
    let setup = ready(&cfg);
    let i = intent();
    struct Fence<'a> {
        setup: &'a Setup,
        bytes: &'a [u8],
        intent: Option<RotationIntent>,
    }
    impl Read for Fence<'_> {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            if let Some(i) = self.intent.take() {
                self.setup
                    .store
                    .prepare_rotation(self.setup.device, i)
                    .unwrap();
            }
            let n = out.len().min(self.bytes.len());
            out[..n].copy_from_slice(&self.bytes[..n]);
            self.bytes = &self.bytes[n..];
            Ok(n)
        }
    }
    let body = b"old coordinator ciphertext at fence";
    let sid = Sid::new(sha256(body));
    let scope = setup.store.request_scope(setup.device);
    let mut stream = Fence {
        setup: &setup,
        bytes: body,
        intent: Some(i.clone()),
    };
    assert!(matches!(
        setup.store.put_chunk_scoped(
            setup.device,
            scope,
            &setup.account,
            &sid,
            body.len() as u64,
            &mut stream
        ),
        Err(StoreError::AuthorityRefused("grant_changed"))
    ));
    assert!(!setup.store.chunk_path(&sid).exists());
    seed(&setup, i.current_map, "map", &[], true);
    let mut v = version(&setup, file(0x95), "queued-staging", &[], &[], false);
    v.manifest_seal = ManifestSeal::Suite2;
    setup.store.versions().enqueue(Queued {
        scope: setup.store.request_scope(setup.device),
        v,
        accept_existing: false,
        edit: None,
    });
    let state = setup
        .store
        .rotation_status(setup.device, &i.operation)
        .unwrap();
    setup
        .store
        .commit_rotation(
            setup.device,
            &i,
            &completion(&setup.store, &state),
            UnixMs(12),
        )
        .unwrap();
    let answers = setup
        .store
        .commit_batch(&mut setup.store.journal(), setup.store.versions().batch());
    assert!(matches!(
        answers[0].1.0,
        Err(StoreError::AuthorityRefused("grant_changed"))
    ));
    assert!(setup.store.file(&file(0x95)).is_none());
}

#[test]
fn rotation_concurrent_initiators_cannot_change_the_frozen_intent() {
    let dir = TempDir::new("rotation-concurrent");
    let cfg = config(&dir);
    let setup = ready(&cfg);
    let other = spare_device(&setup.store, setup.account);
    let store = Arc::new(setup.store);
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let workers: [_; 2] = [setup.device, other].map(|device| {
        let store = Arc::clone(&store);
        let barrier = Arc::clone(&barrier);
        thread::spawn(move || {
            let mut i = intent();
            if device == other {
                i.operation = "bc".repeat(16);
                i.current_map = file(0x82);
            }
            barrier.wait();
            store.prepare_rotation(device, i)
        })
    });
    barrier.wait();
    let results = workers.map(|w| w.join().unwrap());
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, Err(StoreError::AuthorityRefused("rotation_conflict"))))
            .count(),
        1
    );
    let winner = results.into_iter().find_map(Result::ok).unwrap();
    assert_eq!(store.index().authority.rotation.as_ref(), Some(&winner));
    drop(store);
    let restored = open(&cfg);
    assert_eq!(
        restored
            .rotation_status(winner.coordinator, &winner.intent.operation)
            .unwrap(),
        winner
    );
}

#[test]
fn rotation_retention_preserves_frozen_tombstones_and_catalogued_staging_versions() {
    let dir = TempDir::new("rotation-retention");
    let mut cfg = config(&dir);
    cfg.retention_versions = 1;
    let setup = ready(&cfg);
    let i = intent();
    let mut dead = version(&setup, file(1), "old-tombstone", &[], &[], true);
    let old = dead.version_id;
    setup.store.append_version(dead.clone()).unwrap();
    setup
        .store
        .prepare_rotation(setup.device, i.clone())
        .unwrap();
    dead.file_id = file(0x90);
    dead.manifest_seal = ManifestSeal::Suite2;
    dead.version_id = version_id_of(&dead.file_id, &[], &dead.manifest_ct, &[]);
    let destination = dead.version_id;
    setup.store.append_version(dead).unwrap();
    setup
        .store
        .rotation_catalog(
            setup.device,
            &i.operation,
            0,
            vec![(file(1), old, file(0x90), destination)],
        )
        .unwrap();
    seed(
        &setup,
        file(0x90),
        "later-staging-edit",
        &[destination],
        true,
    );
    setup.store.gc_run(UnixMs(UnixMs::now().0 + 90 * DAY_MS));
    assert!(
        setup
            .store
            .file(&file(1))
            .unwrap()
            .versions
            .iter()
            .any(|v| v.version_id == old)
    );
    assert!(setup.store.version(&file(0x90), &destination).is_some());
    drop(setup);
    let restored = open(&cfg);
    assert!(restored.version(&file(0x90), &destination).is_some());
}

#[test]
fn rotation_commit_binds_all_completion_fields_and_requires_map_and_complete_inventory() {
    let dir = TempDir::new("rotation-commit-fields");
    let cfg = config(&dir);
    let setup = ready(&cfg);
    let i = intent();
    let mut own = i.clone();
    own.target = Some(setup.device);
    assert!(matches!(
        setup.store.prepare_rotation(setup.device, own),
        Err(StoreError::AuthorityRefused("own_device"))
    ));
    let state = setup
        .store
        .prepare_rotation(setup.device, i.clone())
        .unwrap();
    let mut done = completion(&setup.store, &state);
    assert!(matches!(
        setup
            .store
            .commit_rotation(setup.device, &i, &done, UnixMs(12)),
        Err(StoreError::AuthorityRefused("rotation_incomplete"))
    ));
    seed(&setup, i.current_map, "map", &[], true);
    done.cutoff = done.cutoff.next();
    assert!(
        setup
            .store
            .commit_rotation(setup.device, &i, &done, UnixMs(12))
            .is_err()
    );
    done = completion(&setup.store, &state);
    done.inventory_hash = "ff".repeat(32);
    assert!(
        setup
            .store
            .commit_rotation(setup.device, &i, &done, UnixMs(12))
            .is_err()
    );
    done = completion(&setup.store, &state);
    done.catalog_pages = 1;
    assert!(
        setup
            .store
            .commit_rotation(setup.device, &i, &done, UnixMs(12))
            .is_err()
    );
    done = completion(&setup.store, &state);
    done.catalog_hash = "ff".repeat(32);
    assert!(
        setup
            .store
            .commit_rotation(setup.device, &i, &done, UnixMs(12))
            .is_err()
    );
    let mut input = atomic_setup(Some(&"b8".repeat(32)), true);
    input.generation = Some(i.current_map);
    assert!(matches!(
        setup
            .store
            .resume_rotation(i, "01".repeat(16), input, UnixMs(12)),
        Err(StoreError::BadRecoveryProof)
    ));
}

#[test]
fn rotation_catalog_cannot_relabel_an_existing_suite2_source_as_fresh_destination() {
    let dir = TempDir::new("rotation-suite2-relabel");
    let cfg = config(&dir);
    let store = open(&cfg);
    let outcome = suite2_setup(&store);
    let setup = Setup {
        store,
        device: outcome.device.device_id,
        account: outcome.device.account_id,
    };
    let old = seed(&setup, file(1), "suite2-old", &[], true);
    let mut i = intent();
    i.previous_map = file(0xb2);
    setup
        .store
        .prepare_rotation(setup.device, i.clone())
        .unwrap();
    assert!(matches!(
        setup.store.rotation_catalog(
            setup.device,
            &i.operation,
            0,
            vec![(file(1), old, file(1), old)]
        ),
        Err(StoreError::AuthorityRefused("generation_mismatch"))
    ));
    seed(&setup, i.current_map, "map", &[], true);
    let state = setup
        .store
        .rotation_status(setup.device, &i.operation)
        .unwrap();
    assert!(matches!(
        setup.store.commit_rotation(
            setup.device,
            &i,
            &completion(&setup.store, &state),
            UnixMs(12)
        ),
        Err(StoreError::AuthorityRefused("rotation_incomplete"))
    ));
}

#[test]
fn suite2_initial_floor_requires_recovery_verifier_before_any_authority_mutation() {
    let dir = TempDir::new("suite2-missing-verifier");
    let cfg = config(&dir);
    let store = open(&cfg);
    let mut input = atomic_setup(None, false);
    input.generation = Some(file(0xb2));
    assert!(matches!(
        store.setup_enrolment(input, UnixMs(9)),
        Err(StoreError::AuthorityRefused("recovery_verifier_required"))
    ));
    assert!(store.account().is_none());
    assert!(store.devices().is_empty());
    assert_eq!(store.current_generation(), None);
    assert!(!cfg.journal_dir.join("v1/journal/000000.log").exists());
}
