//! The storage engine end to end: refusals, durability, recovery, retention.
//!
//! Every test drives the public [`Store`] surface the API lane codes against,
//! on a real temp directory, with hand-written fixtures and no assertion
//! library (AGENTS.md, "Testing doctrine").
#![forbid(unsafe_code)]

use std::fs;
use std::io::Read;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::Path;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime};

use obsync_core::sha256::sha256;

use super::*;
use crate::config::{MirrorVolume, StorageConfig};
use crate::log::{Log, LogLevel};
use crate::storage::testutil::{CAPACITY, TempDir, WATERMARK, storage_config as config};
use crate::storage::{AppendPhase, BlobPhase, RollbackPhase};

const DAY_MS: u64 = 24 * 60 * 60 * 1000;

fn open(cfg: &StorageConfig) -> Store {
    open_with(cfg, [7u8; 32], Log::buffered(LogLevel::Debug))
}

/// The start sequence a store needs: the posture pass, then the open, with
/// the pass in hand as the proof the open requires.
fn open_with(cfg: &StorageConfig, key: [u8; 32], log: Log) -> Store {
    let posture = Posture::enforce(cfg, &log).expect("volume posture");
    Store::open(cfg, key, &posture, log).expect("store opens")
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

/// The domain every test file is in unless it says otherwise.
const DOMAIN: DomainId = DomainId::new([4u8; 16]);

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
        domain_id: DOMAIN,
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
        "{:?}|{:?}|{:?}|{:?}|{:?}",
        store.account(),
        store.devices(),
        detail,
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
    let store = open_with(&cfg, [7u8; 32], log.clone());
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

/// A version that names no parent replaces no head, so each one adds a head:
/// the shortest path to the ceiling, and the shape a client that keeps
/// posting without reconciling actually produces.
fn head(setup: &Setup, tag: &str) -> NewVersion {
    version(setup, file(1), tag, &[], &[], false)
}

#[test]
fn a_file_stops_at_the_heads_one_merge_can_name_and_the_refusal_moves_nothing() {
    let dir = TempDir::new("store-head-cap");
    let cfg = config(&dir);
    let setup = ready(&cfg);

    let mut heads = Vec::new();
    for n in 0..FILE_MAX_HEADS {
        let v = head(&setup, &format!("head-{n}"));
        let outcome = setup.store.append_version(v.clone()).expect("a head lands");
        assert_eq!(outcome.heads.len(), n + 1);
        heads.push(v.version_id);
    }
    // Everything the store would serve for this file, before the refusal.
    let before = format!("{:?}", setup.store.file(&file(1)));

    let over = head(&setup, "one-too-many");
    let err = setup
        .store
        .append_version(over.clone())
        .expect_err("the head past the ceiling is refused");
    assert!(
        matches!(
            err,
            StoreError::TooManyHeads { heads, max }
                if heads == FILE_MAX_HEADS + 1 && max == FILE_MAX_HEADS
        ),
        "{err}"
    );
    assert_eq!(
        format!("{:?}", setup.store.file(&file(1))),
        before,
        "the refusal moves nothing already stored"
    );
    assert!(
        setup.store.version(&file(1), &over.version_id).is_none(),
        "and stores nothing new"
    );

    // The ceiling is exactly one merge's reach, which is the point of it:
    // the file is still resolvable by a version naming every head.
    let merge = version(&setup, file(1), "merge", &heads, &[], false);
    let outcome = setup
        .store
        .append_version(merge.clone())
        .expect("the merge lands");
    assert_eq!(outcome.heads, vec![merge.version_id]);
    assert!(!outcome.conflicted);
}

#[test]
fn a_journal_that_already_holds_more_heads_than_the_ceiling_replays_unchanged() {
    let dir = TempDir::new("store-head-legacy");
    let cfg = config(&dir);
    let (account, device, planted) = {
        let setup = ready(&cfg);
        for n in 0..FILE_MAX_HEADS {
            setup
                .store
                .append_version(head(&setup, &format!("head-{n}")))
                .expect("a head lands");
        }
        // The frame a store that never had this ceiling would have written.
        // Replay is not a decision point: the journal is the source of truth,
        // and a frame it already holds has already happened.
        let manifest = b"sentinel-manifest-legacy".to_vec();
        let planted = version_id_of(&file(1), &[], &manifest, &[]);
        let seq = setup.store.head_seq().next();
        let record = Record {
            seq,
            account_id: Some(setup.account),
            frame: Frame::Version(VersionRecord {
                file_id: file(1),
                domain_id: DOMAIN,
                version_id: planted,
                parents: Vec::new(),
                sids: Vec::new(),
                bytes: 1,
                manifest_ct: manifest,
                manifest_nonce: [1u8; 12],
                device_id: setup.device,
                ts: UnixMs::now(),
                deleted: false,
                seq,
            }),
        };
        let (account, device) = (setup.account, setup.device);
        // The store goes first: the journal has exactly one writer.
        drop(setup);
        let mut journal =
            Journal::open(&cfg, Log::buffered(LogLevel::Debug)).expect("the journal opens");
        journal.append(&record).expect("the frame lands");
        (account, device, planted)
    };

    let setup = Setup {
        store: open(&cfg),
        account,
        device,
    };
    let stored = setup.store.file(&file(1)).expect("file");
    assert_eq!(
        stored.heads.len(),
        FILE_MAX_HEADS + 1,
        "replay applies every frame the journal holds"
    );
    assert!(stored.heads.contains(&planted), "including the planted one");

    // Only what a client posts from here is refused, and it is refused
    // against the number the journal actually left behind.
    let err = setup
        .store
        .append_version(head(&setup, "after-replay"))
        .expect_err("a further head is refused");
    assert!(
        matches!(
            err,
            StoreError::TooManyHeads { heads, max }
                if heads == FILE_MAX_HEADS + 2 && max == FILE_MAX_HEADS
        ),
        "{err}"
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

    // A different server key cannot unwrap it. The first store goes first:
    // the journal has one writer.
    drop(store);
    let other = open_with(&cfg, [8u8; 32], Log::buffered(LogLevel::Error));
    assert_ne!(
        other.device_secret(&id),
        Some(secret),
        "the secret is bound to the server key"
    );
    drop(other);
    let store = open(&cfg);

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
fn a_file_is_in_one_domain_for_life_and_the_store_holds_no_key_for_it() {
    let dir = TempDir::new("store-domains");
    let cfg = config(&dir);
    let setup = ready(&cfg);
    let sid = put(&setup, b"ciphertext-sentinel");

    // A domain exists because a file is in it: nothing declares one, and the
    // store holds no key for it (`docs/architecture.md` 5.1 item 4).
    assert!(!setup.store.domain_exists(&DOMAIN));
    let first = version(&setup, file(1), "one", &[], &[sid], false);
    let head = first.version_id;
    setup.store.append_version(first).expect("first version");
    assert!(setup.store.domain_exists(&DOMAIN));
    assert_eq!(
        setup.store.file(&file(1)).expect("the file").domain_id,
        DOMAIN
    );
    let (page, _) = setup.store.files_page(None, 10);
    assert_eq!(page[0].domain_id, DOMAIN);

    // A later version may not move the file into another domain: a grant a
    // recipient holds must not be widened or redirected by a version post.
    let other = DomainId::new([9u8; 16]);
    let mut moved = version(&setup, file(1), "two", &[head], &[sid], false);
    moved.domain_id = other;
    let refused = setup
        .store
        .append_version(moved)
        .expect_err("a file never changes domain");
    assert!(
        matches!(
            refused,
            StoreError::DomainMismatch { expected, actual } if expected == DOMAIN && actual == other
        ),
        "{refused}"
    );
    assert!(!setup.store.domain_exists(&other));

    // The refusal is the store's, not a rendering: the head did not move.
    assert_eq!(setup.store.file(&file(1)).expect("the file").heads, [head]);
}

#[test]
fn a_file_domain_survives_replay_from_frames_and_from_a_snapshot() {
    let dir = TempDir::new("store-domain-replay");
    let cfg = config(&dir);
    let setup = ready(&cfg);
    let sid = put(&setup, b"ciphertext-sentinel");
    let mut second = version(&setup, file(2), "two", &[], &[sid], false);
    second.domain_id = DomainId::new([7u8; 16]);
    let second_domain = second.domain_id;
    setup
        .store
        .append_version(version(&setup, file(1), "one", &[], &[sid], false))
        .expect("file one");
    setup.store.append_version(second).expect("file two");
    drop(setup);

    // From the frames alone.
    let replayed = open_with(&cfg, [3u8; 32], Log::new(LogLevel::Error));
    assert_eq!(replayed.file(&file(1)).expect("one").domain_id, DOMAIN);
    assert_eq!(
        replayed.file(&file(2)).expect("two").domain_id,
        second_domain
    );
    // And through a snapshot, which carries the domain per file.
    replayed.snapshot().expect("snapshot");
    drop(replayed);
    let loaded = open_with(&cfg, [3u8; 32], Log::new(LogLevel::Error));
    assert_eq!(loaded.file(&file(1)).expect("one").domain_id, DOMAIN);
    assert_eq!(loaded.file(&file(2)).expect("two").domain_id, second_domain);
    assert!(loaded.domain_exists(&second_domain));
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

/// `ENOSPC`: the same number on Linux and on macOS.
const ENOSPC: i32 = 28;
/// `EDQUOT`: Linux and macOS disagree on the number, and both map to
/// `ErrorKind::QuotaExceeded`, which is what every test asserts on.
#[cfg(target_os = "linux")]
const EDQUOT: i32 = 122;
#[cfg(not(target_os = "linux"))]
const EDQUOT: i32 = 69;

#[test]
fn a_full_blob_volume_refuses_per_phase_and_leaves_that_phase_s_residue() {
    // docs/storage.md, durability rule 1 has three points at which the
    // filesystem can refuse, and each leaves a DIFFERENT residue. "Exactly
    // one leftover" would be true of two of them and false of the third, so
    // every phase states its own number.
    for (phase, code, kind, residue) in [
        // The stream refuses: the temp is removed on the way out.
        (
            BlobPhase::Stream,
            ENOSPC,
            std::io::ErrorKind::StorageFull,
            0,
        ),
        // The fsync refuses: an unsynced temp stays.
        (
            BlobPhase::Sync,
            EDQUOT,
            std::io::ErrorKind::QuotaExceeded,
            1,
        ),
        // The rename refuses: a synced temp stays, named by nothing.
        (
            BlobPhase::Rename,
            ENOSPC,
            std::io::ErrorKind::StorageFull,
            1,
        ),
    ] {
        let dir = TempDir::new("store-blob-errno");
        let cfg = config(&dir);
        let log = Log::buffered(LogLevel::Debug);
        let store = open_with(&cfg, [7u8; 32], log.clone());
        let account = store.setup("sentinel account").expect("setup runs once");
        let body = b"ciphertext-sentinel".to_vec();
        let sid = Sid::new(sha256(&body));

        store.set_fault(Fault::BlobErrno { phase, code });
        let err = store
            .put_chunk(&account, &sid, body.len() as u64, &mut &body[..])
            .expect_err("the volume refused");
        match err {
            StoreError::Io(ref e) => assert_eq!(e.kind(), kind, "{phase:?}: {err}"),
            other => panic!("{phase:?}: expected the volume's own error, got {other}"),
        }
        assert!(
            !store.chunk_exists(&sid),
            "{phase:?}: nothing was acknowledged"
        );

        // The refusal line carries the code and the KIND, and no path
        // (AGENTS.md requirements 6 and 12).
        let captured = log.captured();
        assert!(
            captured.contains("decision=io_error"),
            "{phase:?}: {captured}"
        );
        assert!(
            captured.contains(&format!("io={kind:?}")),
            "{phase:?}: {captured}"
        );
        assert!(
            !captured.contains(dir.path().to_str().expect("a utf-8 temp path")),
            "{phase:?}: no path on the line: {captured}"
        );

        let tmp = cfg.blobs_dir.join("v1/tmp");
        assert_eq!(
            fs::read_dir(&tmp).expect("tmp").count(),
            residue,
            "{phase:?}: the residue this phase leaves"
        );
        drop(store);

        // Whatever it left, the next start removes it and says how many.
        let restart = Log::buffered(LogLevel::Debug);
        let reopened = open_with(&cfg, [7u8; 32], restart.clone());
        assert!(
            restart
                .captured()
                .contains(&format!("tmp_removed={residue}")),
            "{phase:?}: the start counts what it removed: {}",
            restart.captured()
        );
        assert_eq!(
            fs::read_dir(&tmp).expect("tmp").count(),
            0,
            "{phase:?}: and nothing is left"
        );
        assert!(
            !reopened.chunk_exists(&sid),
            "{phase:?}: the chunk never appears"
        );
    }
}

#[test]
fn the_journal_watermark_refuses_a_version_and_the_dashboard_agrees() {
    let dir = TempDir::new("store-journal-watermark");
    let cfg = config(&dir);
    let (account, device, sid) = {
        let setup = ready(&cfg);
        let sid = put(&setup, b"ciphertext-sentinel");
        (setup.account, setup.device, sid)
    };

    // The same volumes, re-opened with a journal capacity that leaves less
    // than the watermark for one more frame. Nothing else changes: the
    // frames setup wrote are what fills it.
    let mut tight = cfg.clone();
    tight.journal_capacity = WATERMARK + 8;
    let log = Log::buffered(LogLevel::Debug);
    let setup = Setup {
        store: open_with(&tight, [7u8; 32], log.clone()),
        account,
        device,
    };

    let refused = version(&setup, file(1), "one", &[], &[sid], false);
    let err = setup
        .store
        .append_version(refused)
        .expect_err("the journal volume is below its watermark");
    let (free, watermark) = match err {
        StoreError::JournalFull { free, watermark } => (free, watermark),
        other => panic!("expected journal_full, got {other}"),
    };
    assert_eq!(watermark, WATERMARK, "the threshold it was measured on");
    assert!(setup.store.file(&file(1)).is_none(), "nothing landed");

    // The refusal and the dashboard measure the same volume the same way.
    let journal = setup
        .store
        .volumes()
        .into_iter()
        .find(|v| v.role == "journal")
        .expect("a journal volume");
    assert_eq!(journal.bytes_total, WATERMARK + 8);
    assert_eq!(journal.watermark_bytes, WATERMARK);
    assert!(journal.bytes_used > 0, "setup's frames are counted");
    assert_eq!(
        journal.bytes_free, free,
        "the refusal's free space is the one the dashboard shows"
    );
    assert_eq!(journal.bytes_used + journal.bytes_free, journal.bytes_total);

    // The two volumes are told apart: this is the journal, not the blobs.
    let captured = log.captured();
    assert!(captured.contains("decision=journal_full"), "{captured}");
    assert!(!captured.contains("decision=volume_full"), "{captured}");
    assert!(captured.contains(&format!("free={free}")), "{captured}");
    assert!(
        captured.contains(&format!("watermark={WATERMARK}")),
        "{captured}"
    );
}

#[test]
fn a_faulted_journal_refuses_every_later_write_and_a_restart_clears_it() {
    let dir = TempDir::new("store-journal-faulted");
    let cfg = config(&dir);
    let setup = ready(&cfg);
    let sid = put(&setup, b"ciphertext-sentinel");
    let landed = version(&setup, file(1), "one", &[], &[sid], false);
    setup.store.append_version(landed).expect("acknowledged");

    setup.store.set_fault(Fault::JournalRecoveryFails {
        code: ENOSPC,
        at: AppendPhase::Write,
        rollback: RollbackPhase::Truncate,
    });
    let lost = version(&setup, file(2), "two", &[], &[sid], false);
    let err = setup
        .store
        .append_version(lost)
        .expect_err("the volume refused");
    assert!(matches!(err, StoreError::Io(_)), "{err}");
    assert_eq!(
        setup.store.journal_faulted(),
        Some(std::io::ErrorKind::StorageFull),
        "the store reports the fault readiness answers on"
    );

    // Later writes refuse without asking the volume.
    setup.store.set_fault(Fault::None);
    let after = version(&setup, file(3), "three", &[], &[sid], false);
    let err = setup
        .store
        .append_version(after)
        .expect_err("a faulted journal takes nothing");
    assert!(matches!(err, StoreError::JournalFaulted { .. }), "{err}");
    assert!(setup.store.file(&file(3)).is_none());

    // A restart replays, truncates the tail, and serves again.
    let (account, device) = (setup.account, setup.device);
    drop(setup);
    let reopened = open(&cfg);
    assert_eq!(reopened.journal_faulted(), None, "a start clears the state");
    assert!(
        reopened.file(&file(1)).is_some(),
        "everything acknowledged before the fault is intact"
    );
    assert!(reopened.file(&file(2)).is_none(), "the torn frame is gone");
    let setup = Setup {
        store: reopened,
        account,
        device,
    };
    let again = version(&setup, file(4), "four", &[], &[sid], false);
    setup
        .store
        .append_version(again)
        .expect("the journal takes writes again");
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
            domain_id: DOMAIN,
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

/// Every byte the journal ROOT holds, walked independently of the accounting
/// under test. `VolumeStatus` for the journal must equal this at every
/// moment, not only just after a roll.
fn journal_root_bytes(cfg: &StorageConfig) -> u64 {
    fn walk(path: &Path) -> u64 {
        let mut total = 0;
        let Ok(entries) = fs::read_dir(path) else {
            return 0;
        };
        for entry in entries.flatten() {
            let meta = entry.metadata().expect("metadata");
            if meta.is_dir() {
                total += walk(&entry.path());
            } else {
                total += meta.len();
            }
        }
        total
    }
    walk(&cfg.journal_dir.join("v1"))
}

/// What the dashboard shows for the journal volume.
fn journal_used(store: &Store) -> u64 {
    store
        .volumes()
        .into_iter()
        .find(|v| v.role == "journal")
        .expect("a journal volume")
        .bytes_used
}

#[test]
fn a_journal_whose_usage_cannot_be_re_read_refuses_writes_and_says_so() {
    // The reviewer's double failure at the surface an operator sees. When the
    // survey that follows a failed snapshot ALSO fails, `bytes_used` is the
    // last figure that was read successfully -- so the dashboard says so
    // beside it, and the server refuses writes rather than deciding the
    // watermark against a number nothing has re-read.
    let dir = TempDir::new("store-usage-unverified");
    let cfg = config(&dir);
    let log = Log::buffered(LogLevel::Debug);
    let setup = {
        let store = open_with(&cfg, [7u8; 32], log.clone());
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
    };
    let stale = journal_used(&setup.store);
    assert!(!unverified_flag(&setup.store), "verified to begin with");

    // A directory where the snapshot's destination belongs refuses the
    // rename; a FILE where the quarantine directory belongs then refuses the
    // survey that would account for the temporary the refused rename leaves
    // behind. Neither fixture is a permission: the in-image test stage runs
    // as root, and root walks a directory whose mode forbids it.
    let index_dir = cfg.journal_dir.join("v1/index");
    let seq = setup.store.head_seq();
    fs::create_dir_all(index_dir.join(format!("{seq}.snap"))).expect("block the rename");
    let quarantine = cfg.journal_dir.join("v1/quarantine");
    fs::write(&quarantine, b"not a directory\n").expect("block the survey");
    let err = setup.store.snapshot().expect_err("the snapshot fails");
    assert!(
        matches!(err, StoreError::Io(_)),
        "the original error is what the caller gets, got {err}"
    );

    assert_eq!(
        setup.store.journal_usage_unverified(),
        Some(std::io::ErrorKind::NotADirectory),
        "the failed survey is remembered as its own fact"
    );
    assert!(
        unverified_flag(&setup.store),
        "and the dashboard qualifies the figure it is showing"
    );
    assert_eq!(
        journal_used(&setup.store),
        stale,
        "which is the last one that was read successfully"
    );
    let refused = setup
        .store
        .update_device(&setup.device, Some("after".to_string()), None, None)
        .expect_err("admission is closed while the usage is unverified");
    assert_eq!(refused.code(), "journal_unverified", "{refused}");

    // The operator fixes the volume. No write is needed to recover: the
    // readiness path re-surveys, and after it the figure is current again.
    fs::remove_file(&quarantine).expect("free the name");
    setup
        .store
        .verify_journal_usage()
        .expect("the survey answers now");
    assert_eq!(setup.store.journal_usage_unverified(), None);
    assert!(
        !unverified_flag(&setup.store),
        "the dashboard stops warning"
    );
    setup
        .store
        .update_device(&setup.device, Some("after".to_string()), None, None)
        .expect("and writes are taken again");
    assert_eq!(
        journal_used(&setup.store),
        journal_root_bytes(&cfg),
        "against a total that is the volume's own"
    );
    assert!(
        log.captured()
            .contains("event=journal_survey_recovered by=readiness"),
        "the recovery names the path that found it: {}",
        log.captured()
    );
}

/// Whether the dashboard would mark the journal's usage figure as stale.
fn unverified_flag(store: &Store) -> bool {
    store
        .volumes()
        .into_iter()
        .find(|v| v.role == "journal")
        .expect("a journal volume")
        .usage_unverified
}

#[test]
fn journal_usage_stays_current_when_the_scrub_quarantines_a_chunk() {
    // The reviewer's reproduction, and the ordinary device update before the
    // scrub is the whole of it: without that update the next append rolls,
    // the roll re-surveys the volume, and the survey CONCEALS an accounting
    // that never saw the move. With the segment already open, nothing
    // re-surveys and the quarantined bytes are simply missing.
    let dir = TempDir::new("store-quarantine-accounting");
    let cfg = config(&dir);
    let setup = ready(&cfg);
    let body = b"ciphertext-sentinel".to_vec();
    let sid = put(&setup, &body);
    let path = setup.store.blobs.path(&sid);
    fs::write(&path, b"rot").expect("corrupt the only copy");
    drop(setup);

    let store = ready_existing(&cfg);
    let device = store.devices()[0].device_id;
    store
        .update_device(&device, Some("studio laptop".to_string()), None, None)
        .expect("an ordinary write opens the segment");
    assert_eq!(
        journal_used(&store),
        journal_root_bytes(&cfg),
        "current before the move"
    );

    let summary = store.scrub_step(1 << 20);
    assert_eq!(summary.quarantined, vec![sid], "the chunk is quarantined");
    assert!(
        cfg.journal_dir
            .join("v1/quarantine")
            .join(sid.to_string())
            .is_file(),
        "and it really is on the journal volume"
    );
    assert_eq!(
        journal_used(&store),
        journal_root_bytes(&cfg),
        "and the volume's usage says so in the same call, not at the next roll"
    );

    // ...and the next start, which re-surveys, reaches the same number.
    drop(store);
    let reopened = open(&cfg);
    assert_eq!(journal_used(&reopened), journal_root_bytes(&cfg));
}

#[test]
fn the_journal_watermark_counts_a_quarantine_no_append_wrote() {
    // Only the scrub wrote, and only into the quarantine. The refusal has to
    // see those bytes: they are on the journal volume exactly as a frame is.
    let dir = TempDir::new("store-quarantine-watermark");
    let cfg = config(&dir);
    let sid = {
        let setup = ready(&cfg);
        let sid = put(&setup, &vec![b'x'; 4096]);
        // Corrupted at the SAME length: what moves onto the journal volume
        // is whatever is on disk when the scrub gives up on it, and four
        // kilobytes of rot is four kilobytes of journal volume.
        fs::write(setup.store.blobs.path(&sid), vec![b'r'; 4096]).expect("corrupt the only copy");
        sid
    };

    // Capacity chosen against what the volume already holds, so there is
    // room for an ordinary frame now and none once four kilobytes land in
    // the quarantine: the refusal has to be caused by the quarantine and by
    // nothing else.
    let mut tight = cfg.clone();
    tight.journal_capacity = WATERMARK + journal_root_bytes(&cfg) + 2048;
    let log = Log::buffered(LogLevel::Debug);
    let store = open_with(&tight, [7u8; 32], log.clone());
    let device = store.devices()[0].device_id;
    store
        .update_device(&device, Some("before".to_string()), None, None)
        .expect("there is room before the quarantine");

    let summary = store.scrub_step(1 << 20);
    assert_eq!(
        summary.quarantined,
        vec![sid],
        "4 KiB moved onto the journal"
    );

    let err = store
        .update_device(&device, Some("after".to_string()), None, None)
        .expect_err("the quarantine took the volume below its watermark");
    let (free, watermark) = match err {
        StoreError::JournalFull { free, watermark } => (free, watermark),
        other => panic!("expected journal_full, got {other}"),
    };
    assert_eq!(watermark, WATERMARK);
    assert_eq!(
        free,
        tight.journal_capacity - journal_root_bytes(&tight),
        "the refusal is decided on what the volume really holds"
    );
    assert!(log.captured().contains("decision=journal_full"));
}

#[test]
fn a_quarantine_whose_sync_fails_after_the_move_is_still_accounted() {
    // The two directory fsyncs run AFTER the rename, so an error there means
    // the bytes DID move and the failure was in making that durable. The
    // comment this replaces claimed the opposite, and the accounting believed
    // it. Two outcomes are checked: the error still reaches the caller, and
    // the volume's usage is the volume's own either way.
    let dir = TempDir::new("store-quarantine-sync-fault");
    let cfg = config(&dir);
    let sid = {
        let setup = ready(&cfg);
        let sid = put(&setup, b"ciphertext-sentinel");
        fs::write(setup.store.blobs.path(&sid), b"rot").expect("corrupt the only copy");
        sid
    };

    let log = Log::buffered(LogLevel::Debug);
    let store = open_with(&cfg, [7u8; 32], log.clone());
    let device = store.devices()[0].device_id;
    store
        .update_device(&device, Some("open the segment".to_string()), None, None)
        .expect("an ordinary write opens the segment");

    store.set_fault(Fault::BlobErrno {
        phase: BlobPhase::QuarantineSync,
        code: ENOSPC,
    });
    let summary = store.scrub_step(1 << 20);
    store.set_fault(Fault::None);

    // 1. The bytes really moved, even though the call failed.
    let quarantined = cfg.journal_dir.join("v1/quarantine").join(sid.to_string());
    assert!(
        quarantined.is_file(),
        "the rename happened before the fsync refused"
    );
    // 2. The residue is accounted for.
    assert_eq!(
        journal_used(&store),
        journal_root_bytes(&cfg),
        "and those bytes are counted, in the same call that failed to sync them"
    );
    // 3. And the failure is REPORTED rather than swallowed by the accounting.
    // These are two separate properties and each has its own assertion: a
    // repair that counted the bytes and reported success would be worse than
    // one that counted nothing.
    assert!(
        log.captured().contains("event=scrub_repair_failed"),
        "the original error reaches the log: {}",
        log.captured()
    );
    assert!(
        log.captured().contains("io=StorageFull"),
        "with the kind the volume returned: {}",
        log.captured()
    );
    assert_eq!(
        summary.quarantined,
        vec![sid],
        "and the scrub still reports the chunk as one it could not repair"
    );
}

#[test]
fn a_quarantine_that_replaces_one_already_there_counts_the_difference() {
    // The FORMULA, not the wiring. This drives `Journal::quarantined`
    // directly with two sizes, which proves the arithmetic of a replacement
    // and says nothing about whether `Store::repair` reads the right ones --
    // substituting zero for the pre-move size leaves this test green. The
    // end-to-end proof is `a_second_quarantine_of_the_same_sid_is_accounted
    // _through_the_store`, and the two are kept apart on purpose: a test
    // that exercises a unit under a caller the product never uses is a test
    // of the unit, and should not be presented as anything else.
    //
    // The same sid quarantined twice: the second rename replaces the first
    // file, so the volume gains the difference and not the whole of it.
    let dir = TempDir::new("store-quarantine-replace");
    let cfg = config(&dir);
    let store = ready_existing(&cfg);
    let quarantine = cfg.journal_dir.join("v1/quarantine");
    fs::create_dir_all(&quarantine).expect("quarantine");

    let name = quarantine.join("a".repeat(64));
    fs::write(&name, vec![b'o'; 900]).expect("what an earlier pass left");
    {
        let mut journal = store.journal();
        journal.quarantined(0, 900);
    }
    assert_eq!(journal_used(&store), journal_root_bytes(&cfg), "before");

    // A second move onto the same name: 900 bytes leave the volume as 120
    // arrive, and the accounting has to see both halves.
    fs::write(&name, vec![b'n'; 120]).expect("the replacement");
    {
        let mut journal = store.journal();
        journal.quarantined(900, 120);
    }
    assert_eq!(
        journal_used(&store),
        journal_root_bytes(&cfg),
        "a replacement is a difference, not an addition"
    );
}

#[test]
fn the_journal_guard_spans_the_quarantine_move() {
    // Serialization by construction is one thing; a test that the guard is
    // really held while the file moves is another, and the verdict asks for
    // both. This is the second: a hook that runs INSIDE the move, after the
    // rename and before the accounting, asks the store for its own journal
    // mutex. `Mutex` is not reentrant, so a `try_lock` that fails is proof
    // the guarded region reaches this point -- and that no survey or
    // watermark reader can be here with it.
    let dir = TempDir::new("store-quarantine-guard");
    let cfg = config(&dir);
    let sid = {
        let setup = ready(&cfg);
        let sid = put(&setup, b"ciphertext-sentinel");
        fs::write(setup.store.blobs.path(&sid), b"rot").expect("corrupt the only copy");
        sid
    };

    let store = Arc::new(ready_existing(&cfg));
    let held = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let watching = Arc::downgrade(&store);
        let held = Arc::clone(&held);
        let ran = Arc::clone(&ran);
        store.blobs.set_mid_move(Arc::new(move || {
            let store = watching.upgrade().expect("the store outlives its own move");
            ran.store(true, std::sync::atomic::Ordering::SeqCst);
            held.store(
                store.journal_guard_held(),
                std::sync::atomic::Ordering::SeqCst,
            );
        }));
    }

    let summary = store.scrub_step(1 << 20);
    assert_eq!(summary.quarantined, vec![sid], "the move happened");
    assert!(
        ran.load(std::sync::atomic::Ordering::SeqCst),
        "the hook ran, so this test measured something"
    );
    assert!(
        held.load(std::sync::atomic::Ordering::SeqCst),
        "the journal guard is held while the file moves, not taken afterwards"
    );
}

#[test]
fn a_second_quarantine_of_the_same_sid_is_accounted_through_the_store() {
    // The replacement case, driven through `Store::repair` rather than
    // through `Journal::quarantined` directly. That distinction is the whole
    // test: the unit-level one exercises the arithmetic, and leaves the
    // STORE free to hand it a wrong `was` -- substituting zero for the
    // destination's pre-move size survives it, because it never runs.
    //
    // Two rounds, and the second must land while the segment is already open
    // so that nothing re-surveys and conceals the delta.
    let dir = TempDir::new("store-quarantine-replace-live");
    let cfg = config(&dir);
    let big = vec![b'x'; 4096];
    let sid = Sid::new(sha256(&big));

    // Round one: a 4 KiB chunk rots at its own length and is quarantined.
    {
        let setup = ready(&cfg);
        put(&setup, &big);
        fs::write(setup.store.blobs.path(&sid), vec![b'r'; 4096]).expect("rot, same length");
    }
    let first_quarantine = {
        let store = ready_existing(&cfg);
        assert_eq!(
            store.scrub_step(1 << 20).quarantined,
            vec![sid],
            "round one"
        );
        // The same chunk uploaded again -- the content hashes to the same
        // sid, so this is the same name -- and rotted to a DIFFERENT length.
        let account = store.account().expect("account").account_id;
        store
            .put_chunk(&account, &sid, big.len() as u64, &mut &big[..])
            .expect("the chunk lands again");
        fs::write(store.blobs.path(&sid), vec![b'r'; 100]).expect("rot, shorter this time");
        quarantine_bytes(&cfg)
    };

    // Round two, on a store that has surveyed the 4 KiB quarantine at open
    // and then opened its segment with an ordinary write.
    let store = ready_existing(&cfg);
    let device = store.devices()[0].device_id;
    store
        .update_device(&device, Some("open the segment".to_string()), None, None)
        .expect("an ordinary write opens the segment");
    let before = journal_used(&store);
    assert_eq!(
        before,
        journal_root_bytes(&cfg),
        "current before the replacement"
    );

    assert_eq!(
        store.scrub_step(1 << 20).quarantined,
        vec![sid],
        "round two"
    );
    let quarantined = cfg.journal_dir.join("v1/quarantine").join(sid.to_string());
    assert_eq!(
        fs::metadata(&quarantined).expect("the quarantine").len(),
        100,
        "the shorter file replaced the longer one at the same name"
    );
    assert_eq!(
        journal_used(&store),
        journal_root_bytes(&cfg),
        "and the accounting is the volume's own after a replacement"
    );
    // And the difference is where it should be. The whole-volume total also
    // moves with the frames this round journalled, so the quarantine's own
    // bytes are measured on their own: 4096 out, 100 in. Together with the
    // equality above that pins the accounting to new MINUS old -- a
    // replacement counted as an addition leaves the total 4096 too high,
    // which the walk equality refuses.
    assert_eq!(
        (first_quarantine, quarantine_bytes(&cfg)),
        (4096, 100),
        "the quarantine holds the replacement and not both"
    );
}

/// Bytes the quarantine directory holds, walked independently.
fn quarantine_bytes(cfg: &StorageConfig) -> u64 {
    let dir = cfg.journal_dir.join("v1/quarantine");
    let Ok(entries) = fs::read_dir(&dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|e| e.metadata().expect("metadata").len())
        .sum()
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

// --- Volume posture -------------------------------------------------------
//
// A restored snapshot, a `tar -x`, a `docker cp`, or a bind mount hands the
// server volumes it did not create. These drive the start-time pass against
// exactly that shape.

/// A mount class: reported at the mode it was read at, never corrected.
fn is_mount(class: PathClass) -> bool {
    matches!(class, PathClass::JournalMount | PathClass::BlobsMount)
}

/// The mode a restore hands a file over at.
const WEAK_FILE: u32 = 0o644;
/// The mode a restore hands a directory over at.
const WEAK_DIR: u32 = 0o755;

fn mode_of(path: &std::path::Path) -> u32 {
    fs::symlink_metadata(path)
        .expect("the path is there")
        .permissions()
        .mode()
        & 0o777
}

fn chmod(path: &std::path::Path, mode: u32) {
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).expect("the mode is set");
}

/// Both roots, both credential files, all of them widely readable: the state
/// a restore or a bind mount leaves behind.
fn restored_volume(cfg: &StorageConfig) -> (PathBuf, PathBuf) {
    let journal_root = PathClass::JournalRoot.path(&cfg.journal_dir);
    let blobs_root = PathClass::BlobsRoot.path(&cfg.blobs_dir);
    fs::create_dir_all(&journal_root).expect("the journal root is restored");
    fs::create_dir_all(&blobs_root).expect("the blob root is restored");
    let server_key = PathClass::ServerKey.path(&cfg.journal_dir);
    let setup_token = PathClass::SetupToken.path(&cfg.journal_dir);
    fs::write(&server_key, "ab".repeat(32)).expect("the wrapping material is restored");
    fs::write(&setup_token, "cd".repeat(32)).expect("the recovery login is restored");
    chmod(&server_key, WEAK_FILE);
    chmod(&setup_token, WEAK_FILE);
    chmod(&journal_root, WEAK_DIR);
    chmod(&blobs_root, WEAK_DIR);
    (server_key, setup_token)
}

#[test]
fn a_restored_volume_is_corrected_and_re_read_before_anything_is_served() {
    let dir = TempDir::new("posture-restored");
    let cfg = config(&dir);
    let (server_key, setup_token) = restored_volume(&cfg);
    let log = Log::buffered(LogLevel::Debug);

    let posture = Posture::enforce(&cfg, &log).expect("what can be corrected is corrected");

    assert_eq!(mode_of(&server_key), 0o600, "the wrapping material");
    assert_eq!(mode_of(&setup_token), 0o600, "the standing recovery login");
    assert_eq!(
        mode_of(&PathClass::JournalRoot.path(&cfg.journal_dir)),
        0o700
    );
    assert_eq!(mode_of(&PathClass::BlobsRoot.path(&cfg.blobs_dir)), 0o700);

    let captured = log.captured();
    for line in [
        "event=posture path_class=blobs_root decision=repaired from=0755 to=0700",
        "event=posture path_class=journal_root decision=repaired from=0755 to=0700",
        "event=posture path_class=server_key decision=repaired from=0644 to=0600",
        "event=posture path_class=setup_token decision=repaired from=0644 to=0600",
    ] {
        assert!(captured.contains(line), "missing {line}\n{captured}");
    }
    assert_eq!(posture.outcomes().len(), 6, "one decision per class");
    for outcome in posture.outcomes().iter().filter(|o| !is_mount(o.class)) {
        assert_eq!(
            outcome.decision,
            Decision::Repaired {
                from: if outcome.class.required_mode() == 0o700 {
                    WEAK_DIR
                } else {
                    WEAK_FILE
                },
                to: outcome.class.required_mode(),
            },
            "{:?}",
            outcome.class
        );
    }
}

#[test]
fn a_corrected_volume_is_quiet_and_unchanged_on_the_next_start() {
    let dir = TempDir::new("posture-idempotent");
    let cfg = config(&dir);
    let (server_key, _) = restored_volume(&cfg);
    let first = Log::buffered(LogLevel::Debug);
    Posture::enforce(&cfg, &first).expect("the first start corrects");

    let second = Log::buffered(LogLevel::Debug);
    let posture = Posture::enforce(&cfg, &second).expect("the second start has nothing to do");
    assert!(
        !second.captured().contains("event=posture"),
        "a corrected volume produces no posture line\n{}",
        second.captured()
    );
    for outcome in posture.outcomes().iter().filter(|o| !is_mount(o.class)) {
        assert_eq!(
            outcome.decision,
            Decision::Ok {
                mode: outcome.class.required_mode()
            },
            "{:?}",
            outcome.class
        );
    }
    assert_eq!(mode_of(&server_key), 0o600);
}

#[test]
fn a_link_where_a_credential_file_belongs_refuses_and_is_never_followed() {
    let dir = TempDir::new("posture-link");
    let cfg = config(&dir);
    fs::create_dir_all(PathClass::JournalRoot.path(&cfg.journal_dir)).expect("the journal root");
    let target = dir.path().join("attacker-owned");
    fs::write(&target, "ab".repeat(32)).expect("the link target");
    chmod(&target, WEAK_FILE);
    std::os::unix::fs::symlink(&target, PathClass::ServerKey.path(&cfg.journal_dir))
        .expect("the link is planted");

    let log = Log::buffered(LogLevel::Debug);
    let err = Posture::enforce(&cfg, &log).expect_err("a link is never followed");
    assert!(
        matches!(
            err,
            StoreError::Posture {
                class: "server_key",
                reason: "symlink"
            }
        ),
        "{err}"
    );
    assert!(
        log.captured()
            .contains("event=posture path_class=server_key decision=refused reason=symlink"),
        "{}",
        log.captured()
    );
    assert_eq!(
        mode_of(&target),
        WEAK_FILE,
        "the link was not followed: its target was not touched"
    );
}

#[test]
fn a_directory_where_the_setup_token_belongs_refuses() {
    let dir = TempDir::new("posture-token-dir");
    let cfg = config(&dir);
    fs::create_dir_all(PathClass::SetupToken.path(&cfg.journal_dir))
        .expect("a directory takes the name");
    let log = Log::buffered(LogLevel::Debug);
    let err = Posture::enforce(&cfg, &log).expect_err("a substituted type is never used");
    assert!(
        matches!(
            err,
            StoreError::Posture {
                class: "setup_token",
                reason: "not_a_regular_file"
            }
        ),
        "{err}"
    );
}

#[test]
fn a_regular_file_where_a_volume_root_belongs_refuses() {
    let dir = TempDir::new("posture-root-file");
    let cfg = config(&dir);
    fs::create_dir_all(&cfg.blobs_dir).expect("the volume");
    fs::write(PathClass::BlobsRoot.path(&cfg.blobs_dir), "not a root").expect("a file takes it");
    let log = Log::buffered(LogLevel::Debug);
    let err = Posture::enforce(&cfg, &log).expect_err("a root is a directory or it is nothing");
    assert!(
        matches!(
            err,
            StoreError::Posture {
                class: "blobs_root",
                reason: "not_a_directory"
            }
        ),
        "{err}"
    );
}

#[test]
fn every_measured_file_is_owned_by_the_user_this_process_runs_as() {
    let dir = TempDir::new("posture-owner");
    let cfg = config(&dir);
    let (server_key, _) = restored_volume(&cfg);
    let log = Log::buffered(LogLevel::Debug);
    let posture = Posture::enforce(&cfg, &log).expect("the pass runs");

    // The positive control: the pass learned the user from the filesystem
    // and it is the user that owns what this test created.
    assert_eq!(
        fs::symlink_metadata(&server_key).expect("the file").uid(),
        posture.uid(),
        "the pass measures owners against the user it runs as"
    );

    // The negative: a pass that expects another user refuses. Owning a file
    // as somebody else needs root, so the expectation is what varies; the
    // comparison under test is the same one.
    let err = Posture::expecting(posture.uid() ^ 1)
        .verify(PathClass::ServerKey, &server_key, &log)
        .expect_err("a foreign owner can widen it again the moment we look away");
    assert!(
        matches!(
            err,
            StoreError::Posture {
                reason: "foreign_owner",
                ..
            }
        ),
        "{err}"
    );
}

/// Defence in depth: the pass runs at the top of a start, and the function
/// that actually reads the wrapping material measures it again, on the
/// handle it then reads through, so a volume that changes underneath the
/// start is caught where it is used.
#[test]
fn the_wrapping_material_is_measured_where_it_is_read_not_only_where_the_pass_looked() {
    let dir = TempDir::new("posture-toctou");
    let cfg = config(&dir);
    let log = Log::buffered(LogLevel::Debug);
    let posture = Posture::enforce(&cfg, &log).expect("an empty volume");

    // After the pass, and before the read.
    let server_key = PathClass::ServerKey.path(&cfg.journal_dir);
    fs::write(&server_key, "ab".repeat(32)).expect("a key appears");
    chmod(&server_key, WEAK_FILE);

    let loaded =
        load_or_create_server_key(&cfg.journal_dir, None, &posture, &log).expect("the key loads");
    assert_eq!(loaded, [0xabu8; 32], "it is the key that was there");
    assert_eq!(
        mode_of(&server_key),
        0o600,
        "measured again where it is read"
    );
    assert!(
        log.captured()
            .contains("event=server_key source=volume mode=0600"),
        "{}",
        log.captured()
    );
}

/// `ReadWriteOnce` keeps other nodes off a volume; a second pod on the same
/// node, or a `check` while `serve` runs, is a second process on the same
/// journal. One writer is made true by the lock, not by the access mode.
#[test]
fn a_second_process_on_the_same_journal_refuses_to_start() {
    let dir = TempDir::new("store-lock");
    let cfg = config(&dir);
    let first = open(&cfg);

    let log = Log::buffered(LogLevel::Debug);
    let posture = Posture::enforce(&cfg, &log).expect("the pass runs beside a live store");
    let err = match Store::open(&cfg, [7u8; 32], &posture, log.clone()) {
        Ok(_) => panic!("the journal has one writer, and it is the first store"),
        Err(e) => e,
    };
    assert!(matches!(err, StoreError::Locked), "{err}");
    assert!(
        log.captured()
            .contains("event=store_open decision=refused reason=journal_locked"),
        "{}",
        log.captured()
    );
    assert!(
        !log.captured().contains("event=store_open") || !log.captured().contains("frames="),
        "nothing was replayed by the refused open: {}",
        log.captured()
    );

    // The lock goes with the store that held it.
    drop(first);
    Store::open(&cfg, [7u8; 32], &posture, log).expect("the journal is free again");
}

/// The round-10 schedule: a protected journal holding an account, the
/// pass, `v1` renamed aside by whoever can write the directory above it, a
/// valid journal with another account put under the name, the store opened,
/// the protected root restored, a snapshot writing the poisoned index into
/// it. Every step after the first needed a directory above the root that
/// another account could write. That directory is refused before any root
/// is trusted by name, and a store cannot be opened without the pass in
/// hand, so the schedule never reaches its second step.
#[test]
fn a_journal_directory_another_account_could_write_is_refused_before_any_store_opens() {
    let dir = TempDir::new("posture-substitution");
    let cfg = config(&dir);
    let account = ready(&cfg).account;

    // The schedule's precondition.
    chmod(&cfg.journal_dir, 0o777);
    let log = Log::buffered(LogLevel::Debug);
    let err = Posture::enforce(&cfg, &log)
        .expect_err("a directory anyone may write holds a root anyone may rename away");
    assert!(
        matches!(
            err,
            StoreError::Posture {
                class: "journal_mount",
                reason: "writable_by_others"
            }
        ),
        "{err}"
    );
    assert!(
        !log.captured().contains("event=store"),
        "nothing below the refusal ran: {}",
        log.captured()
    );

    // Closed again, the same journal opens with the account it always held.
    chmod(&cfg.journal_dir, 0o700);
    let store = ready_existing(&cfg);
    assert_eq!(
        store.account().map(|a| a.account_id),
        Some(account),
        "the account it always held"
    );
}

#[test]
fn a_restored_tree_takes_one_start_to_reach_the_mode_every_class_requires() {
    let dir = TempDir::new("posture-tree");
    let cfg = config(&dir);
    // A real volume with real content, as a backup would have captured it.
    let setup = ready(&cfg);
    let account = setup.account;
    let sid = put(&setup, b"restored");
    drop(setup);
    let key_hex = "ab".repeat(32);
    fs::write(PathClass::ServerKey.path(&cfg.journal_dir), &key_hex).expect("the key is restored");
    fs::write(
        PathClass::SetupToken.path(&cfg.journal_dir),
        "cd".repeat(32),
    )
    .expect("the login is restored");
    // The restore itself: every directory and every file, widely readable.
    widen(dir.path());

    // One start.
    let log = Log::buffered(LogLevel::Debug);
    let posture = Posture::enforce(&cfg, &log).expect("the pass corrects the tree");
    let loaded = load_or_create_server_key(&cfg.journal_dir, None, &posture, &log)
        .expect("the restored key loads");
    let store = Store::open(&cfg, loaded, &posture, log.clone()).expect("the store opens");

    assert_eq!(
        store.account().expect("the account survived").account_id,
        account
    );
    assert!(store.chunk_exists(&sid), "and so did its content");
    assert_eq!(loaded, hex::decode_array::<32>(&key_hex).expect("hex"));
    for (class, dir_of) in [
        (PathClass::ServerKey, &cfg.journal_dir),
        (PathClass::SetupToken, &cfg.journal_dir),
        (PathClass::JournalRoot, &cfg.journal_dir),
        (PathClass::BlobsRoot, &cfg.blobs_dir),
    ] {
        assert_eq!(
            mode_of(&class.path(dir_of)),
            class.required_mode(),
            "{class:?} after one start"
        );
    }
    // The line an operator reads states the mode that was read back.
    assert!(
        log.captured()
            .contains("event=server_key source=volume mode=0600"),
        "{}",
        log.captured()
    );
}

/// A collection that cannot journal its plan states which I/O stopped it.
///
/// The background threads log and carry on, so this line is the whole account
/// an operator ever gets of a failed collection (requirement 12). It named
/// `io_error` and no more until issue #19: a volume that filled and a volume
/// the process may not write printed the same six words.
#[test]
fn a_collection_that_cannot_journal_names_the_io_kind_that_stopped_it() {
    let dir = TempDir::new("store-gc-io-kind");
    let cfg = config(&dir);
    let log = Log::buffered(LogLevel::Debug);
    let store = open_with(&cfg, [7u8; 32], log.clone());
    store.setup("sentinel account").expect("setup runs once");
    store.set_fault(Fault::JournalMidAppend);

    let summary = store.gc_run(UnixMs::now());
    assert_eq!(
        summary.chunks_collected, 0,
        "a refused plan collects nothing"
    );

    let captured = log.captured();
    let line = captured
        .lines()
        .find(|line| line.contains("event=gc_failed"))
        .unwrap_or_else(|| panic!("no gc_failed line: {captured}"));
    assert!(line.contains("decision=io_error"), "{line}");
    assert!(line.contains("io=Interrupted"), "{line}");
}

/// Widen every directory and file under a tree, the way a restore that does
/// not carry modes leaves one.
fn widen(root: &std::path::Path) {
    let entries = fs::read_dir(root).expect("the tree is readable");
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            widen(&path);
            chmod(&path, WEAK_DIR);
        } else {
            chmod(&path, WEAK_FILE);
        }
    }
    chmod(root, WEAK_DIR);
}
