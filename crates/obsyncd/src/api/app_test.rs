//! The application state a start assembles, over a real store on a real
//! volume: what `App::new` does about the loose ends a restart leaves.
//!
//! No listener and no socket. These tests build and drop the state the way
//! `serve` does, so the second one opens the volumes the first one wrote,
//! which is the only way to see what a restart actually inherits.
#![forbid(unsafe_code)]

use super::*;
use crate::api::auth::FakeClock;
use crate::api::pairing::Claimant;
use crate::log::LogLevel;
use crate::storage::testutil::TempDir;
use crate::storage::types::NewDevice;
use crate::storage::{Posture, Store};
use crate::types::AccountId;

const NOW: u64 = 1_757_200_000;

/// The state `serve` assembles, without a listener: the posture pass,
/// the store, then the application over it. Dropping it releases the
/// journal, so a test can build the next one over the same volumes.
fn app(dir: &TempDir, log: &Log) -> App {
    let pairs: Vec<(String, String)> = [
        (
            "OBSYNC_BLOBS_DIR",
            dir.path().join("blobs").display().to_string(),
        ),
        (
            "OBSYNC_JOURNAL_DIR",
            dir.path().join("journal").display().to_string(),
        ),
        ("OBSYNC_BLOBS_CAPACITY", "64MiB".to_string()),
        ("OBSYNC_JOURNAL_CAPACITY", "16MiB".to_string()),
        ("OBSYNC_FREE_WATERMARK", "1%,64KiB".to_string()),
        ("OBSYNC_SERVER_KEY", "aa".repeat(32)),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    let cfg = Config::from_pairs(&pairs).expect("configuration");
    let storage = cfg.storage();
    let posture = Posture::enforce(&storage, log).expect("volume posture");
    let store = Store::open(&storage, [7u8; 32], &posture, log.clone()).expect("the store opens");
    App::new(
        cfg,
        store,
        Dashboard::unavailable(),
        PluginDist::unavailable(),
        Arc::new(AtomicBool::new(false)),
        None,
        Arc::new(FakeClock::new(NOW)),
    )
    .expect("the application state opens")
}

fn device(account: AccountId, name: &'static str, state: DeviceState) -> NewDevice {
    NewDevice {
        account_id: account,
        name: name.to_string(),
        platform: "linux".to_string(),
        app_version: "0.1.0".to_string(),
        secret: [3u8; 32],
        state,
    }
}

/// A claim journals its device and a pairing holds it in memory, so a
/// restart leaves a credential nobody can ever approve.
#[test]
fn a_pending_device_whose_pairing_is_gone_does_not_survive_the_restart() {
    let dir = TempDir::new("app-pending");
    let first = Log::buffered(LogLevel::Debug);
    let (pending, active, revoked) = {
        let app = app(&dir, &first);
        let account = app.store.setup("sentinel account").expect("setup");
        let active = app
            .store
            .create_device(device(account, "approved", DeviceState::Active))
            .expect("the approved device")
            .device_id;
        let revoked = app
            .store
            .create_device(device(account, "gone", DeviceState::Active))
            .expect("the revoked device")
            .device_id;
        app.store.revoke_device(&revoked).expect("revoked");
        let pending = app
            .store
            .create_device(device(account, "claimant", DeviceState::Pending))
            .expect("the claimant")
            .device_id;
        assert!(
            app.store.device_secret(&pending).is_some(),
            "the claimant holds a credential while its pairing stands"
        );
        (pending, active, revoked)
    };

    let second = Log::buffered(LogLevel::Debug);
    let restarted = app(&dir, &second);
    assert!(
        restarted.store.device(&pending).is_none(),
        "the orphaned claimant is gone"
    );
    assert!(
        restarted.store.device_secret(&pending).is_none(),
        "and its secret with it"
    );
    assert!(
        restarted.store.device(&active).is_some(),
        "an approved device is not a loose end"
    );
    assert!(
        restarted.store.device(&revoked).is_some(),
        "and a revoked device's record is the revocation"
    );
    assert!(
        second
            .captured()
            .contains("event=pending_reconciled count=1 refused=0"),
        "{}",
        second.captured()
    );

    // The destruction is journaled, so the next start finds nothing to
    // do rather than doing it again.
    drop(restarted);
    let third = Log::buffered(LogLevel::Debug);
    let again = app(&dir, &third);
    assert!(again.store.device(&pending).is_none());
    assert!(
        third
            .captured()
            .contains("event=pending_reconciled count=0 refused=0"),
        "{}",
        third.captured()
    );
}

#[test]
fn a_pending_device_whose_pairing_still_stands_is_left_alone() {
    let dir = TempDir::new("app-claimed");
    let log = Log::buffered(LogLevel::Debug);
    let app = app(&dir, &log);
    let account = app.store.setup("sentinel account").expect("setup");
    let creator = app
        .store
        .create_device(device(account, "laptop", DeviceState::Active))
        .expect("the creator")
        .device_id;
    let claimant = app
        .store
        .create_device(device(account, "phone", DeviceState::Pending))
        .expect("the claimant")
        .device_id;
    // A second claimant with no pairing of its own, so the question the
    // table is asked is which device it is holding and not whether it is
    // holding one.
    let orphan = app
        .store
        .create_device(device(account, "tablet", DeviceState::Pending))
        .expect("the orphan")
        .device_id;
    {
        let mut pairings = app.pairings.lock().expect("pairings");
        pairings.create("p", creator, "t", NOW);
        pairings.finish_claim(
            "p",
            Claimant {
                device_id: claimant,
                name: "phone".to_string(),
                platform: "ios".to_string(),
                app_version: "0.1.0".to_string(),
            },
        );
    }

    app.reconcile_pending();
    assert!(
        app.store.device(&claimant).is_some(),
        "a claim its creator can still approve is not an orphan"
    );
    assert!(app.store.device_secret(&claimant).is_some());
    assert!(
        app.store.device(&orphan).is_none(),
        "and another device's pairing is not a reason to keep this one"
    );
    assert!(
        log.captured()
            .contains("event=pending_reconciled count=1 refused=0"),
        "{}",
        log.captured()
    );
}
