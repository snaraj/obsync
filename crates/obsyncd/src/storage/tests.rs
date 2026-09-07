//! The storage engine end to end: refusals, durability, recovery, retention.
//!
//! Every test drives the public [`Store`] surface the API lane codes against,
//! on a real temp directory, with hand-written fixtures and no assertion
//! library (AGENTS.md, "Testing doctrine").
#![forbid(unsafe_code)]

use std::fs;
use std::io::Read;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime};

use obsync_core::sha256::sha256;

use super::*;
use crate::config::{MirrorVolume, StorageConfig, Watermark};
use crate::log::{Log, LogLevel};
use crate::storage::testutil::TempDir;

/// Small enough that a test can reach the watermark with a few bytes.
const CAPACITY: u64 = 64 * 1024;
/// The refusal threshold those tests are measured against.
const WATERMARK: u64 = 32 * 1024;
const DAY_MS: u64 = 24 * 60 * 60 * 1000;

fn config(dir: &TempDir) -> StorageConfig {
    StorageConfig {
        blobs_dir: dir.path().join("blobs"),
        journal_dir: dir.path().join("journal"),
        mirrors: Vec::new(),
        blobs_capacity: CAPACITY,
        journal_capacity: CAPACITY,
        blobs_class: "test-class".to_string(),
        journal_class: "test-class".to_string(),
        free_watermark: Watermark {
            percent: 0,
            bytes: WATERMARK,
        },
        retention_days: 30,
        retention_versions: 2,
        scrub_rate_bytes_per_sec: 1 << 20,
    }
}

fn open(cfg: &StorageConfig) -> Store {
    Store::open(cfg, [7u8; 32], Log::buffered(LogLevel::Debug)).expect("store opens")
}

/// A store with an account and one paired device.
struct Setup {
    store: Store,
    account: AccountId,
    device: DeviceId,
}

fn ready(cfg: &StorageConfig) -> Setup {
    let store = open(cfg);
    let account = store.setup("sentinel account").expect("setup runs once");
    let device = store
        .create_device(NewDevice {
            account_id: account,
            name: "sentinel device".to_string(),
            platform: "linux".to_string(),
            app_version: "0.1.0".to_string(),
            secret: [3u8; 32],
            state: DeviceState::Active,
        })
        .expect("device pairs")
        .device_id;
    Setup {
        store,
        account,
        device,
    }
}

fn put(setup: &Setup, body: &[u8]) -> Sid {
    let sid = Sid::new(sha256(body));
    setup
        .store
        .put_chunk(&setup.account, &sid, body.len() as u64, &mut &body[..])
        .expect("chunk lands");
    sid
}

/// A version whose id the server will accept, distinguished by `tag`.
fn version(
    setup: &Setup,
    file: FileId,
    tag: &str,
    parents: &[VersionId],
    sids: &[Sid],
    deleted: bool,
) -> NewVersion {
    let manifest = format!("sentinel-manifest-{tag}").into_bytes();
    let version_id = version_id_of(&file, parents, &manifest, sids);
    NewVersion {
        account_id: setup.account,
        file_id: file,
        version_id,
        parents: parents.to_vec(),
        sids: sids.to_vec(),
        bytes: 1,
        manifest_ct: manifest,
        manifest_nonce: [1u8; 12],
        device_id: setup.device,
        deleted,
    }
}

fn file(n: u8) -> FileId {
    FileId::new([n; 16])
}

/// Everything the store would serve, rendered so two stores can be compared.
fn fingerprint(store: &Store) -> String {
    let (files, _) = store.files_page(None, 1000);
    let detail: Vec<String> = files
        .iter()
        .map(|summary| format!("{:?}", store.file(&summary.file_id)))
        .collect();
    format!(
        "{:?}|{:?}|{:?}|{:?}|{:?}|{:?}",
        store.account(),
        store.devices(),
        detail,
        store.domains(),
        store.head_seq(),
        store.last_gc(),
    )
}

#[test]
fn the_store_and_the_log_are_shareable_across_request_threads() {
    // One store serves every connection thread (docs/architecture.md §9:
    // one thread per connection), so this is a compile-time contract, not a
    // hope. It fails to build, not at runtime, if either stops holding.
    fn shareable<T: Send + Sync>() {}
    shareable::<Store>();
    shareable::<Log>();
    fn cloneable<T: Clone>() {}
    cloneable::<Log>();
}

#[test]
fn setup_runs_once_and_the_account_reports_real_usage() {
    let dir = TempDir::new("store-setup");
    let cfg = config(&dir);
    let store = open(&cfg);
    assert!(store.account().is_none());
    let account = store.setup("sentinel account").expect("first setup");
    assert!(
        matches!(store.setup("again"), Err(StoreError::AlreadySetUp)),
        "setup is valid once"
    );
    let record = store.account().expect("account exists");
    assert_eq!(record.account_id, account);
    assert_eq!(record.name, "sentinel account");
    assert_eq!(record.used_bytes, 0);

    let setup = Setup {
        store,
        account,
        device: DeviceId::new([0; 16]),
    };
    put(&setup, b"ciphertext-one");
    assert_eq!(
        setup.store.account().expect("account").used_bytes,
        b"ciphertext-one".len() as u64
    );
}

#[test]
fn a_chunk_is_stored_once_and_a_repost_is_verified_not_trusted() {
    let dir = TempDir::new("store-dedup");
    let cfg = config(&dir);
    let setup = ready(&cfg);
    let body = b"ciphertext-sentinel".to_vec();
    let sid = Sid::new(sha256(&body));

    assert_eq!(setup.store.missing_chunks(&[sid]), vec![sid]);
    assert_eq!(
        setup
            .store
            .put_chunk(&setup.account, &sid, body.len() as u64, &mut &body[..])
            .expect("first put"),
        PutOutcome::Created
    );
    assert!(setup.store.chunk_exists(&sid));
    assert_eq!(setup.store.chunk_len(&sid), Some(body.len() as u64));
    assert!(setup.store.missing_chunks(&[sid]).is_empty());

    assert_eq!(
        setup
            .store
            .put_chunk(&setup.account, &sid, body.len() as u64, &mut &body[..])
            .expect("second put")
            .clone(),
        PutOutcome::Existed
    );
    assert_eq!(
        setup.store.account().expect("account").used_bytes,
        body.len() as u64,
        "a repost is not counted twice"
    );

    // A forged body under a known sid is still refused.
    let err = setup
        .store
        .put_chunk(&setup.account, &sid, 4, &mut &b"evil"[..])
        .expect_err("a forged repost is refused");
    assert!(matches!(err, StoreError::SidMismatch { .. }), "{err}");

    let (mut file, len) = setup.store.open_chunk(&sid).expect("chunk opens");
    let mut read = Vec::new();
    file.read_to_end(&mut read).expect("chunk reads");
    assert_eq!(read, body);
    assert_eq!(len, body.len() as u64);
}

#[test]
fn a_refused_chunk_leaves_nothing_behind() {
    let dir = TempDir::new("store-refuse");
    let cfg = config(&dir);
    let setup = ready(&cfg);
    let body = b"ciphertext-sentinel".to_vec();

    let wrong = Sid::new(sha256(b"something else"));
    let err = setup
        .store
        .put_chunk(&setup.account, &wrong, body.len() as u64, &mut &body[..])
        .expect_err("a sid mismatch is refused");
    assert!(
        matches!(err, StoreError::SidMismatch { expected, .. } if expected == wrong),
        "{err}"
    );

    let sid = Sid::new(sha256(&body));
    let err = setup
        .store
        .put_chunk(&setup.account, &sid, 4096, &mut &body[..])
        .expect_err("a length mismatch is refused");
    assert!(
        matches!(
            err,
            StoreError::LengthMismatch {
                declared: 4096,
                actual: 19
            }
        ),
        "{err}"
    );

    assert!(!setup.store.chunk_exists(&sid));
    assert_eq!(setup.store.account().expect("account").used_bytes, 0);
    drop(setup);
    let reopened = open(&cfg);
    assert_eq!(
        reopened.account().expect("account").used_bytes,
        0,
        "and nothing was left on the volume for the next start to find"
    );
}

#[test]
fn the_watermark_and_the_quota_refuse_with_their_numbers() {
    let dir = TempDir::new("store-watermark");
    let mut cfg = config(&dir);
    // Everything but the watermark is already spoken for.
    cfg.blobs_capacity = WATERMARK + 8;
    let setup = ready(&cfg);
    let body = vec![b'x'; 16];
    let sid = Sid::new(sha256(&body));
    let err = setup
        .store
        .put_chunk(&setup.account, &sid, body.len() as u64, &mut &body[..])
        .expect_err("below the watermark");
    match err {
        StoreError::VolumeFull { free, watermark } => {
            assert_eq!(free, WATERMARK + 8, "the refusal names the free space");
            assert_eq!(watermark, WATERMARK, "and the threshold it was measured on");
        }
        other => panic!("expected volume_full, got {other}"),
    }
    assert!(!setup.store.chunk_exists(&sid));

    // The refusal line carries both numbers (requirement 12).
    let dir = TempDir::new("store-watermark-log");
    let mut cfg = config(&dir);
    cfg.blobs_capacity = WATERMARK + 8;
    let log = Log::buffered(LogLevel::Debug);
    let store = Store::open(&cfg, [7u8; 32], log.clone()).expect("store opens");
    let account = store.setup("sentinel").expect("setup");
    let _ = store.put_chunk(&account, &sid, body.len() as u64, &mut &body[..]);
    let captured = log.captured();
    assert!(captured.contains("decision=volume_full"), "{captured}");
    assert!(captured.contains("watermark=32768"), "{captured}");
    assert!(captured.contains("free=32776"), "{captured}");
    assert!(captured.contains("duration_ms="), "{captured}");
}

#[test]
fn a_quota_refuses_before_the_body_is_stored() {
    let dir = TempDir::new("store-quota");
    let cfg = config(&dir);
    let setup = ready(&cfg);
    // The account record carries the quota; set it through the journal the
    // same way setup does, then check the refusal names both numbers.
    {
        let mut journal = setup.store.journal();
        let mut index = setup.store.index();
        let account = index.account.clone().expect("account");
        super::append(&mut journal, &mut index, |_| Frame::Account {
            account_id: account.account_id,
            name: account.name.clone(),
            created: account.created,
            quota_bytes: Some(8),
        })
        .expect("quota is journalled");
    }
    let body = vec![b'x'; 16];
    let sid = Sid::new(sha256(&body));
    let err = setup
        .store
        .put_chunk(&setup.account, &sid, body.len() as u64, &mut &body[..])
        .expect_err("over quota");
    match err {
        StoreError::QuotaExceeded { used, quota } => {
            assert_eq!(used, 16);
            assert_eq!(quota, 8);
        }
        other => panic!("expected quota_exceeded, got {other}"),
    }
    assert!(!setup.store.chunk_exists(&sid));
}

#[test]
fn a_version_needs_its_chunks_its_id_and_a_live_device() {
    let dir = TempDir::new("store-version-refusals");
    let cfg = config(&dir);
    let setup = ready(&cfg);
    let missing = Sid::new(sha256(b"never uploaded"));

    let mut posted = version(&setup, file(1), "a", &[], &[missing], false);
    let err = setup
        .store
        .append_version(posted.clone())
        .expect_err("a version cannot name chunks the server lacks");
    match err {
        StoreError::MissingChunks(sids) => assert_eq!(sids, vec![missing]),
        other => panic!("expected missing_chunks, got {other}"),
    }

    let sid = put(&setup, b"ciphertext-sentinel");
    posted = version(&setup, file(1), "a", &[], &[sid], false);
    let forged = VersionId::new([9u8; 32]);
    let err = setup
        .store
        .append_version(NewVersion {
            version_id: forged,
            ..posted.clone()
        })
        .expect_err("a version id the server did not compute is refused");
    match err {
        StoreError::VersionIdMismatch { expected, actual } => {
            assert_eq!(expected, posted.version_id);
            assert_eq!(actual, forged);
        }
        other => panic!("expected version_id_mismatch, got {other}"),
    }

    let unknown = DeviceId::new([0xee; 16]);
    let err = setup
        .store
        .append_version(NewVersion {
            device_id: unknown,
            ..version(&setup, file(1), "a", &[], &[sid], false)
        })
        .expect_err("an unknown device is refused");
    assert!(matches!(err, StoreError::UnknownDevice), "{err}");

    // A device that claimed a pairing nobody approved writes nothing either,
    // whether or not the caller remembered to authenticate it.
    let pending = setup
        .store
        .create_device(NewDevice {
            account_id: setup.account,
            name: "phone".to_string(),
            platform: "ios".to_string(),
            app_version: "0.1.0".to_string(),
            secret: [4u8; 32],
            state: DeviceState::Pending,
        })
        .expect("device claims")
        .device_id;
    let err = setup
        .store
        .append_version(NewVersion {
            device_id: pending,
            ..version(&setup, file(1), "a", &[], &[sid], false)
        })
        .expect_err("a pending device is refused");
    assert!(matches!(err, StoreError::DevicePending), "{err}");

    setup.store.revoke_device(&setup.device).expect("revoke");
    let err = setup
        .store
        .append_version(posted)
        .expect_err("a revoked device is refused");
    assert!(matches!(err, StoreError::DeviceRevoked), "{err}");
    assert!(
        setup.store.file(&file(1)).is_none(),
        "no refusal wrote a version"
    );
}

#[test]
fn heads_follow_the_graph_and_a_repost_is_a_no_op() {
    let dir = TempDir::new("store-heads");
    let cfg = config(&dir);
    let setup = ready(&cfg);
    let sid = put(&setup, b"ciphertext-sentinel");

    let first = version(&setup, file(1), "one", &[], &[sid], false);
    let root = setup.store.append_version(first.clone()).expect("first");
    assert_eq!(root.heads, vec![first.version_id]);
    assert!(!root.conflicted);
    assert!(!root.existed);

    let again = setup.store.append_version(first.clone()).expect("repost");
    assert!(again.existed, "the same version id is a no-op");
    assert_eq!(again.seq, root.seq, "and keeps its original sequence");
    assert_eq!(
        setup.store.file(&file(1)).expect("file").versions.len(),
        1,
        "no second copy"
    );

    let left = version(&setup, file(1), "left", &[first.version_id], &[sid], false);
    let right = version(&setup, file(1), "right", &[first.version_id], &[sid], false);
    setup.store.append_version(left.clone()).expect("left");
    let outcome = setup.store.append_version(right.clone()).expect("right");
    assert!(outcome.conflicted, "concurrent writers conflict");
    assert_eq!(outcome.heads, vec![left.version_id, right.version_id]);

    let merge = version(
        &setup,
        file(1),
        "merge",
        &[left.version_id, right.version_id],
        &[sid],
        false,
    );
    let outcome = setup.store.append_version(merge.clone()).expect("merge");
    assert!(!outcome.conflicted, "the merge resolves it");
    assert_eq!(outcome.heads, vec![merge.version_id]);

    let grave = version(&setup, file(1), "gone", &[merge.version_id], &[], true);
    let outcome = setup
        .store
        .append_version(grave.clone())
        .expect("tombstone");
    assert_eq!(outcome.heads, vec![grave.version_id]);
    let stored = setup.store.file(&file(1)).expect("file");
    assert!(
        stored.versions[0].deleted,
        "the newest version is the grave"
    );
    assert_eq!(
        setup
            .store
            .version(&file(1), &grave.version_id)
            .expect("version")
            .version_id,
        grave.version_id
    );
    assert!(
        setup
            .store
            .version(&file(1), &VersionId::new([0; 32]))
            .is_none()
    );
}

#[test]
fn the_feed_pages_and_a_cursor_past_the_head_is_refused() {
    let dir = TempDir::new("store-feed");
    let cfg = config(&dir);
    let setup = ready(&cfg);
    let sid = put(&setup, b"ciphertext-sentinel");
    for n in 1..=3u8 {
        let posted = version(&setup, file(n), "v", &[], &[sid], false);
        setup.store.append_version(posted).expect("version");
    }
    let head = setup.store.head_seq();

    let page = setup.store.changes(Seq(0), 2).expect("first page");
    assert_eq!(page.changes.len(), 2);
    assert_eq!(page.head_seq, head);
    let page = setup.store.changes(page.seq, 10).expect("second page");
    assert_eq!(page.changes.len(), 1);
    assert_eq!(page.seq, head, "a complete page advances to the head");

    let err = setup
        .store
        .changes(Seq(head.0 + 1), 10)
        .expect_err("a cursor past the head is refused");
    assert!(
        matches!(err, StoreError::SeqAhead { head: h, .. } if h == head),
        "{err}"
    );

    let (page, next) = setup.store.files_page(None, 2);
    assert_eq!(page.len(), 2);
    assert_eq!(next, Some(file(2)), "the cursor is the last id included");
    let (page, next) = setup.store.files_page(next.as_ref(), 2);
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].file_id, file(3), "and the last file is not skipped");
    assert_eq!(next, None);
}

#[test]
fn a_long_poll_wakes_on_an_append_and_otherwise_times_out() {
    let dir = TempDir::new("store-longpoll");
    let cfg = config(&dir);
    let setup = ready(&cfg);
    let sid = put(&setup, b"ciphertext-sentinel");
    let head = setup.store.head_seq();

    let waited = SystemTime::now();
    assert_eq!(
        setup.store.wait_for_change(head, Duration::from_millis(50)),
        head,
        "with nothing to report the wait returns the head it had"
    );
    assert!(
        waited.elapsed().expect("clock").as_millis() >= 40,
        "and it actually waited"
    );

    let store = Arc::new(setup);
    let waiter = {
        let store = Arc::clone(&store);
        thread::spawn(move || store.store.wait_for_change(head, Duration::from_secs(5)))
    };
    thread::sleep(Duration::from_millis(20));
    let posted = version(&store, file(1), "one", &[], &[sid], false);
    store.store.append_version(posted).expect("version");
    let woken = waiter.join().expect("the waiter returns");
    assert!(
        woken > head,
        "the append woke the long poll: {woken} > {head}"
    );
}

#[test]
fn a_pending_device_activates_once_and_never_after_revocation() {
    let dir = TempDir::new("store-pending");
    let cfg = config(&dir);
    let store = open(&cfg);
    let account = store.setup("sentinel").expect("setup");
    let id = store
        .create_device(NewDevice {
            account_id: account,
            name: "phone".to_string(),
            platform: "ios".to_string(),
            app_version: "0.1.0".to_string(),
            secret: [0x5au8; 32],
            state: DeviceState::Pending,
        })
        .expect("device claims")
        .device_id;
    assert_eq!(
        store.device(&id).expect("device").state,
        DeviceState::Pending
    );
    assert_eq!(
        store.device_secret(&id),
        Some([0x5au8; 32]),
        "a pending device holds its secret: it fetches its own envelope with it"
    );

    store.activate_device(&id).expect("approval activates");
    assert_eq!(
        store.device(&id).expect("device").state,
        DeviceState::Active
    );
    store
        .activate_device(&id)
        .expect("approving twice is a no-op");

    store.revoke_device(&id).expect("revoke");
    let err = store
        .activate_device(&id)
        .expect_err("a revoked device never comes back");
    assert!(matches!(err, StoreError::DeviceRevoked), "{err}");
    assert_eq!(store.device_secret(&id), None);

    let unknown = DeviceId::new([0xfeu8; 16]);
    assert!(matches!(
        store.activate_device(&unknown),
        Err(StoreError::UnknownDevice)
    ));
}

#[test]
fn device_secrets_rest_wrapped_and_revocation_destroys_them() {
    let dir = TempDir::new("store-devices");
    let cfg = config(&dir);
    let store = open(&cfg);
    let account = store.setup("sentinel").expect("setup");
    let secret = [0xa5u8; 32];
    let record = store
        .create_device(NewDevice {
            account_id: account,
            name: "laptop".to_string(),
            platform: "macos".to_string(),
            app_version: "0.1.0".to_string(),
            secret,
            state: DeviceState::Active,
        })
        .expect("device pairs");
    let id = record.device_id;

    assert_eq!(
        store.device_secret(&id),
        Some(secret),
        "the wrap round trips"
    );
    let wrapped = store.wrapped_secret(&id).expect("wrapped");
    assert_ne!(wrapped, secret, "the journal never holds the plain secret");

    // A different server key cannot unwrap it.
    let other = Store::open(&cfg, [8u8; 32], Log::buffered(LogLevel::Error)).expect("reopen");
    assert_ne!(
        other.device_secret(&id),
        Some(secret),
        "the secret is bound to the server key"
    );
    drop(other);

    let updated = store
        .update_device(
            &id,
            Some("renamed".to_string()),
            Some(DevicePolicy {
                per_file_max_bytes: 5,
                total_budget_bytes: 7,
            }),
            Some("0.1.1".to_string()),
        )
        .expect("update");
    assert_eq!(updated.name, "renamed");
    assert_eq!(updated.policy.per_file_max_bytes, 5);
    assert_eq!(updated.app_version, "0.1.1");

    store
        .record_seen(
            &id,
            SeenEvent {
                kind: SeenKind::SignIn,
                ts: UnixMs(42),
                address: Some("198.51.100.7".to_string()),
                country: Some("XX".to_string()),
            },
        )
        .expect("seen");
    let history = store.seen_history(&id, 10);
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].kind, SeenKind::SignIn);
    assert_eq!(
        store.device(&id).expect("device").last_sign_in,
        Some(UnixMs(42))
    );

    store.revoke_device(&id).expect("revoke");
    assert_eq!(
        store.device_secret(&id),
        None,
        "a revoked device has no secret to authenticate with"
    );
    assert_eq!(
        store.wrapped_secret(&id),
        Some([0u8; 32]),
        "the wrapped secret is destroyed, not just flagged"
    );
    assert!(store.device(&id).expect("device").revoked());
    assert_eq!(store.devices().len(), 1);

    store.delete_device(&id).expect("delete");
    assert!(store.device(&id).is_none());
    assert!(matches!(
        store.delete_device(&id),
        Err(StoreError::UnknownDevice)
    ));
    assert!(matches!(
        store.record_seen(
            &id,
            SeenEvent {
                kind: SeenKind::Edit,
                ts: UnixMs(1),
                address: None,
                country: None
            }
        ),
        Err(StoreError::UnknownDevice)
    ));
}

#[test]
fn an_escrowed_domain_key_round_trips_and_can_be_withdrawn() {
    let dir = TempDir::new("store-escrow");
    let cfg = config(&dir);
    let setup = ready(&cfg);
    let domain = DomainId::new([4u8; 16]);
    assert!(matches!(
        setup.store.set_escrow(&domain, Some([1u8; 32])),
        Err(StoreError::UnknownDomain)
    ));

    setup.store.create_domain(domain).expect("domain");
    setup.store.create_domain(domain).expect("declaring twice");
    assert_eq!(setup.store.domains().len(), 1);
    assert!(!setup.store.domains()[0].escrowed);
    assert_eq!(setup.store.escrow_key(&domain), None);

    let key = [0x5au8; 32];
    setup.store.set_escrow(&domain, Some(key)).expect("escrow");
    assert!(setup.store.domains()[0].escrowed);
    assert_eq!(setup.store.escrow_key(&domain), Some(key));

    setup.store.set_escrow(&domain, None).expect("withdraw");
    assert!(!setup.store.domains()[0].escrowed);
    assert_eq!(setup.store.escrow_key(&domain), None);
}

#[test]
fn volumes_report_capacity_class_and_watermark() {
    let dir = TempDir::new("store-volumes");
    let mut cfg = config(&dir);
    cfg.mirrors = vec![MirrorVolume {
        path: dir.path().join("mirror"),
        label: "slow-hdd".to_string(),
    }];
    let setup = ready(&cfg);
    put(&setup, b"ciphertext-sentinel");

    let volumes = setup.store.volumes();
    assert_eq!(volumes.len(), 3);
    assert_eq!(volumes[0].role, "blobs");
    assert_eq!(volumes[0].class_label, "test-class");
    assert_eq!(volumes[0].bytes_total, CAPACITY);
    assert_eq!(volumes[0].bytes_used, 19);
    assert_eq!(volumes[0].bytes_free, CAPACITY - 19);
    assert_eq!(volumes[0].watermark_bytes, WATERMARK);
    assert_eq!(volumes[1].role, "mirror");
    assert_eq!(volumes[1].class_label, "slow-hdd");
    assert_eq!(volumes[2].role, "journal");
    assert!(volumes[2].bytes_used > 0, "the journal has frames in it");
}

#[test]
fn a_crash_before_the_chunk_is_durable_leaves_the_store_consistent() {
    for fault in [Fault::ChunkBeforeFsync, Fault::ChunkBeforeRename] {
        let dir = TempDir::new("store-chunk-crash");
        let cfg = config(&dir);
        let setup = ready(&cfg);
        let body = b"ciphertext-sentinel".to_vec();
        let sid = Sid::new(sha256(&body));
        setup.store.set_fault(fault);
        let err = setup
            .store
            .put_chunk(&setup.account, &sid, body.len() as u64, &mut &body[..])
            .expect_err("the crash surfaces");
        assert!(matches!(err, StoreError::Io(_)), "{fault:?}: {err}");
        assert!(
            !setup.store.chunk_exists(&sid),
            "{fault:?}: not acknowledged"
        );
        drop(setup);

        let reopened = open(&cfg);
        assert!(
            !reopened.chunk_exists(&sid),
            "{fault:?}: and not on the volume"
        );
        assert_eq!(reopened.account().expect("account").used_bytes, 0);
        assert!(
            reopened.account().is_some(),
            "{fault:?}: the frames before the crash survived"
        );
    }
}

#[test]
fn a_crash_mid_journal_costs_only_the_torn_frame() {
    let dir = TempDir::new("store-journal-crash");
    let cfg = config(&dir);
    let setup = ready(&cfg);
    let sid = put(&setup, b"ciphertext-sentinel");
    let landed = version(&setup, file(1), "one", &[], &[sid], false);
    setup.store.append_version(landed.clone()).expect("first");

    setup.store.set_fault(Fault::JournalMidAppend);
    let lost = version(&setup, file(2), "two", &[], &[sid], false);
    let err = setup
        .store
        .append_version(lost.clone())
        .expect_err("the crash surfaces");
    assert!(matches!(err, StoreError::Io(_)), "{err}");
    drop(setup);

    let reopened = open(&cfg);
    assert!(
        reopened.account().is_some(),
        "the account frame survived the torn tail"
    );
    assert!(
        reopened.file(&file(1)).is_some(),
        "and so did the version before it"
    );
    assert!(
        reopened.file(&file(2)).is_none(),
        "the torn frame is gone, not half applied"
    );
    assert!(
        reopened.chunk_exists(&sid),
        "the chunk is still on the volume"
    );

    // The store is writable again, from the truncated tail.
    let account = reopened.account().expect("account").account_id;
    let device = reopened.devices()[0].device_id;
    let manifest = b"sentinel-manifest-three".to_vec();
    let file_id = file(3);
    let version_id = version_id_of(&file_id, &[], &manifest, &[sid]);
    reopened
        .append_version(NewVersion {
            account_id: account,
            file_id,
            version_id,
            parents: Vec::new(),
            sids: vec![sid],
            bytes: 1,
            manifest_ct: manifest,
            manifest_nonce: [1u8; 12],
            device_id: device,
            deleted: false,
        })
        .expect("the journal takes writes again");
    assert!(reopened.file(&file(3)).is_some());
}

#[test]
fn a_snapshot_replays_to_exactly_what_the_frames_alone_replay_to() {
    let dir = TempDir::new("store-snapshot");
    let cfg = config(&dir);
    let setup = ready(&cfg);
    let sid = put(&setup, b"ciphertext-sentinel");
    let root = version(&setup, file(1), "one", &[], &[sid], false);
    setup.store.append_version(root.clone()).expect("root");
    let child = version(&setup, file(1), "two", &[root.version_id], &[sid], false);
    setup.store.append_version(child).expect("child");
    setup
        .store
        .create_domain(DomainId::new([4u8; 16]))
        .expect("domain");
    setup
        .store
        .set_escrow(&DomainId::new([4u8; 16]), Some([9u8; 32]))
        .expect("escrow");
    setup.store.snapshot().expect("snapshot");
    // Frames after the snapshot, so replay has to do both halves.
    setup
        .store
        .append_version(version(&setup, file(2), "three", &[], &[sid], false))
        .expect("after the snapshot");
    let live = fingerprint(&setup.store);
    drop(setup);

    let with_snapshot = open(&cfg);
    assert_eq!(
        fingerprint(&with_snapshot),
        live,
        "reopening reproduces the running state"
    );
    drop(with_snapshot);

    for entry in fs::read_dir(dir.path().join("journal/v1/index")).expect("index dir") {
        fs::remove_file(entry.expect("entry").path()).expect("drop the snapshot");
    }
    let frames_only = open(&cfg);
    assert_eq!(
        fingerprint(&frames_only),
        live,
        "and the frames alone replay to the same state"
    );
}

#[test]
fn collection_takes_unreferenced_chunks_and_survives_a_restart() {
    let dir = TempDir::new("store-gc");
    let cfg = config(&dir);
    let setup = ready(&cfg);
    let kept = put(&setup, b"ciphertext-kept");
    let orphan = put(&setup, b"ciphertext-orphan");
    let live = version(&setup, file(1), "one", &[], &[kept], false);
    setup.store.append_version(live).expect("version");

    // Nothing is collectable yet: the orphan is newborn.
    let now = UnixMs::now();
    let summary = setup.store.gc_run(now);
    assert_eq!(summary.chunks_collected, 0, "newborn chunks are protected");
    assert!(setup.store.chunk_exists(&orphan));

    // Age the orphan on disk and reopen so the scan picks up its real age.
    let old = SystemTime::now() - Duration::from_millis(2 * DAY_MS);
    let path = setup.store.blobs.path(&orphan);
    let handle = fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .expect("chunk opens");
    handle
        .set_times(fs::FileTimes::new().set_modified(old))
        .expect("backdate the chunk");
    drop(handle);
    drop(setup);

    let store = open(&cfg);
    let summary = store.gc_run(UnixMs::now());
    assert_eq!(summary.chunks_collected, 1, "the aged orphan goes");
    assert_eq!(summary.bytes_collected, b"ciphertext-orphan".len() as u64);
    assert_eq!(summary.chunks_retained, 1);
    assert!(!store.chunk_exists(&orphan), "gone from the index");
    assert!(!path.exists(), "and gone from the volume");
    assert!(store.chunk_exists(&kept), "the referenced chunk stays");
    assert_eq!(store.last_gc().expect("summary").chunks_collected, 1);
    drop(store);

    let reopened = open(&cfg);
    assert!(!reopened.chunk_exists(&orphan), "the collection is durable");
    assert!(reopened.chunk_exists(&kept));
    assert_eq!(
        reopened.last_gc().expect("summary").chunks_collected,
        1,
        "and the run is remembered across a restart"
    );
}

#[test]
fn retention_prunes_old_versions_and_replay_agrees() {
    let dir = TempDir::new("store-retention");
    let mut cfg = config(&dir);
    cfg.retention_versions = 1;
    let setup = ready(&cfg);
    let sid = put(&setup, b"ciphertext-sentinel");
    let mut parents: Vec<VersionId> = Vec::new();
    let mut ids = Vec::new();
    for tag in ["one", "two", "three"] {
        let posted = version(&setup, file(1), tag, &parents, &[sid], false);
        setup.store.append_version(posted.clone()).expect("version");
        parents = vec![posted.version_id];
        ids.push(posted.version_id);
    }
    // Run the collection from far enough in the future that every version
    // is outside the retention window. Moving the horizon rather than the
    // stored timestamps keeps the journal and the index telling one story.
    let later = UnixMs(UnixMs::now().0 + 90 * DAY_MS);
    setup.store.gc_run(later);

    let stored = setup.store.file(&file(1)).expect("file");
    assert_eq!(stored.versions.len(), 1, "only the head survives retention");
    assert_eq!(stored.versions[0].version_id, ids[2]);
    let live = fingerprint(&setup.store);
    drop(setup);

    let reopened = open(&cfg);
    assert_eq!(
        fingerprint(&reopened),
        live,
        "replaying the gc frame prunes the same versions"
    );
}

#[test]
fn the_scrub_repairs_from_a_mirror_and_quarantines_what_it_cannot() {
    let dir = TempDir::new("store-scrub");
    let mut cfg = config(&dir);
    let mirror = dir.path().join("mirror");
    cfg.mirrors = vec![MirrorVolume {
        path: mirror.clone(),
        label: "mirror".to_string(),
    }];
    let setup = ready(&cfg);
    let body = b"ciphertext-sentinel".to_vec();
    let sid = put(&setup, &body);
    let path = setup.store.blobs.path(&sid);

    let summary = setup.store.scrub_step(1 << 20);
    assert_eq!(summary.chunks_verified, 1);
    assert_eq!(summary.mismatches, 0);
    assert!(summary.complete_pass, "one step covered the volume");

    // Corrupt the primary; the mirror still holds the truth.
    fs::write(&path, b"rot").expect("corrupt the primary");
    drop(setup);
    let setup = ready_existing(&cfg);
    let summary = setup.scrub_step(1 << 20);
    assert_eq!(summary.mismatches, 1, "the scrub notices");
    assert!(summary.quarantined.is_empty(), "and repairs it");
    assert!(setup.chunk_exists(&sid));
    assert_eq!(fs::read(&path).expect("chunk"), body, "the bytes are back");

    // Corrupt both copies: there is nothing to repair from.
    fs::write(&path, b"rot").expect("corrupt the primary");
    let mirror_path = mirror
        .join("v1")
        .join(&sid.to_string()[0..2])
        .join(&sid.to_string()[2..4])
        .join(sid.to_string());
    fs::write(&mirror_path, b"rot").expect("corrupt the mirror");
    drop(setup);
    let setup = ready_existing(&cfg);
    let summary = setup.scrub_step(1 << 20);
    assert_eq!(summary.mismatches, 1);
    assert_eq!(summary.quarantined, vec![sid], "it is quarantined");
    assert!(!setup.chunk_exists(&sid), "and dropped from the index");
    assert!(!path.exists(), "and moved off the blob volume");
    assert!(
        dir.path()
            .join("journal/v1/quarantine")
            .join(sid.to_string())
            .is_file(),
        "the operator can still see it"
    );
    assert_eq!(setup.last_scrub().expect("summary").mismatches, 1);
    drop(setup);

    let reopened = open(&cfg);
    assert!(!reopened.chunk_exists(&sid), "the quarantine is durable");
}

/// Reopen a store on an existing volume, without running setup again.
fn ready_existing(cfg: &StorageConfig) -> Store {
    open(cfg)
}
