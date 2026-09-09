//! Per-device HMAC request authentication (`docs/protocol.md`,
//! "Authentication").
//!
//! The window is ±300 s and nonces are remembered for 600 s. Both are
//! constants: no environment variable, build flag, or config field can widen
//! or disable them (AGENTS.md requirement 4 and "Security invariants").
#![forbid(unsafe_code)]

use std::collections::HashMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use obsync_core::hex;
use obsync_core::http::Request;
use obsync_core::{ct, hmac, sha256};

use crate::log::{Log, Val};
use crate::storage::types::{DeviceRecord, DeviceState, SeenEvent, SeenKind};
use crate::storage::{StoreError, error_fields};
use crate::types::{DeviceId, UnixMs};

use super::edge::ClientInfo;
use super::nonce_log::{Nonce, NonceLog};
use super::{ApiError, App, SIGN_IN_RECORD_INTERVAL_SECS, is_hex, render};

/// Widest accepted difference between the request timestamp and server time.
pub const CLOCK_SKEW_SECS: u64 = 300;
/// How long a nonce is remembered, so a captured request cannot be replayed.
pub const NONCE_TTL_SECS: u64 = 600;
/// Most nonces held at once. Reaching it refuses requests rather than
/// forgetting a nonce that is still inside its window.
pub const NONCE_CACHE_MAX: usize = 200_000;

/// Wall-clock source. Production reads the system clock; tests drive the
/// window and the nonce TTL with a fake.
pub trait Clock: Send + Sync {
    /// Unix seconds.
    fn unix_secs(&self) -> u64;
    /// Unix milliseconds.
    fn unix_ms(&self) -> u64;
}

/// The system clock.
pub struct SystemClock;

impl Clock for SystemClock {
    fn unix_secs(&self) -> u64 {
        self.unix_ms() / 1000
    }

    fn unix_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64)
    }
}

/// A clock the tests move by hand.
#[cfg(test)]
pub struct FakeClock {
    secs: std::sync::atomic::AtomicU64,
}

#[cfg(test)]
impl FakeClock {
    /// A fake clock parked at `secs`.
    pub fn new(secs: u64) -> Self {
        Self {
            secs: std::sync::atomic::AtomicU64::new(secs),
        }
    }

    /// Move the clock to `secs`.
    pub fn set(&self, secs: u64) {
        self.secs.store(secs, std::sync::atomic::Ordering::SeqCst);
    }
}

#[cfg(test)]
impl Clock for FakeClock {
    fn unix_secs(&self) -> u64 {
        self.secs.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn unix_ms(&self) -> u64 {
        self.unix_secs() * 1000
    }
}

/// Nonces seen inside the replay window, and the file that outlives the
/// process holding them.
///
/// There is no in-memory-only constructor. The window is a promise about
/// wall-clock time, and a cache that a restart empties cannot keep it
/// (AGENTS.md requirement 4): the only way to have one is to have the
/// durable state open (`super::nonce_log`).
pub struct NonceCache {
    seen: HashMap<Nonce, u64>,
    durable: NonceLog,
    log: Log,
    /// Most nonces held at once. [`NONCE_CACHE_MAX`] everywhere but the
    /// tests that drive the ceiling and the compaction it triggers.
    capacity: usize,
}

impl NonceCache {
    /// Open the durable state on the journal volume and load the nonces
    /// still inside the window.
    ///
    /// # Errors
    /// The volume, or on-disk state that is not a nonce log. Both refuse the
    /// start: a server that cannot record what it accepts cannot promise
    /// that it will refuse it a second time.
    pub fn open(journal_dir: &Path, now: u64, log: &Log) -> Result<NonceCache, StoreError> {
        Self::sized(journal_dir, now, NONCE_CACHE_MAX, log)
    }

    fn sized(
        journal_dir: &Path,
        now: u64,
        capacity: usize,
        log: &Log,
    ) -> Result<NonceCache, StoreError> {
        let (durable, entries) = NonceLog::open(journal_dir, now, log)?;
        Ok(NonceCache {
            seen: entries.into_iter().collect(),
            durable,
            log: log.clone(),
            capacity,
        })
    }

    /// Remember `nonce` for `device`, or report the replay.
    ///
    /// # Errors
    /// `401 replayed_nonce` when the pair is already held, `503
    /// nonce_cache_full` when the cache is at its ceiling — refusing beats
    /// forgetting a nonce that is still inside its window — and `503
    /// nonce_log_unavailable` when the volume will not take the record.
    pub fn remember(&mut self, device: &str, nonce: &str, now: u64) -> Result<(), ApiError> {
        let entry = (device.to_string(), nonce.to_string());
        if let Some(expiry) = self.seen.get(&entry)
            && *expiry > now
        {
            return Err(ApiError::new(
                401,
                "replayed_nonce",
                "nonce was used inside the window",
            ));
        }
        if self.seen.len() >= self.capacity {
            self.sweep(now);
        }
        if self.seen.len() >= self.capacity {
            return Err(ApiError::new(
                503,
                "nonce_cache_full",
                "replay cache is full; retry shortly",
            ));
        }
        // The file is rewritten before this line joins it, never after: a
        // volume that refuses the rewrite refuses the request too, and the
        // nonce it carried is still unspent.
        if self.durable.lines() > self.capacity * 2 {
            self.sweep(now);
            let live = &self.seen;
            self.durable
                .compact(live)
                .map_err(|e| self.unavailable(&e))?;
        }
        self.durable
            .append(now, &entry)
            .map_err(|e| self.unavailable(&e))?;
        self.seen.insert(entry, now + NONCE_TTL_SECS);
        Ok(())
    }

    /// Drop expired entries, returning how many went.
    pub fn sweep(&mut self, now: u64) -> usize {
        let before = self.seen.len();
        self.seen.retain(|_, expiry| *expiry > now);
        before - self.seen.len()
    }

    /// Records written since the last call, for the sweep summary: what one
    /// period of requests cost the journal volume (requirement 12).
    pub const fn appends(&mut self) -> u64 {
        self.durable.take_appends()
    }

    /// How many nonces are held.
    pub fn len(&self) -> usize {
        self.seen.len()
    }

    /// Whether the cache holds nothing.
    pub fn is_empty(&self) -> bool {
        self.seen.is_empty()
    }

    /// How many times the durable state has been made durable, for the test
    /// that pins one per accepted request.
    #[cfg(test)]
    pub const fn syncs(&self) -> u64 {
        self.durable.syncs()
    }

    /// One line for a volume that would not take the record, and the
    /// refusal the request gets. The kind is the io kind and no location
    /// (requirement 12, requirement 6).
    fn unavailable(&self, e: &std::io::Error) -> ApiError {
        self.log.error(
            "nonce_log",
            &[("decision", Val::word("refused")), ("io", Val::io(e))],
        );
        ApiError::new(
            503,
            "nonce_log_unavailable",
            "replay state could not be recorded; retry shortly",
        )
    }
}

/// An authenticated device request.
pub struct Authed {
    /// The device's stored record.
    pub device: DeviceRecord,
    /// The device id it authenticated as.
    pub id: DeviceId,
    /// Where the request came from.
    pub client: ClientInfo,
    /// The request body, buffered for every endpoint but a chunk upload,
    /// whose body streams to the store and hashes to the sid.
    pub body: Vec<u8>,
}

/// Which device states an endpoint admits.
///
/// `Active` is the answer everywhere but one route. The exception is the
/// claimant's own envelope fetch, the single step a device takes between
/// claiming a pairing and being approved (`docs/architecture.md` 4.2): it
/// carries no authority of its own, because [`super::pairing::PairingTable`]
/// still refuses anyone but that pairing's claimant and still answers `409
/// not_approved` until the creator approves.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Admit {
    /// Only an approved device.
    ActiveOnly,
    /// An approved device, or the claimant polling for its envelope.
    ActiveOrPending,
}

/// What the body hash of the canonical string is.
enum BodyHash<'a> {
    /// Buffer the body under the JSON ceiling and hash it.
    Buffer,
    /// The sid is the body hash: the upload streams to the store unbuffered.
    Sid(&'a str),
}

/// Authenticate a device request whose body the handler will read as JSON.
///
/// # Errors
/// The refusals of `docs/protocol.md`: `401 missing_auth`, `401
/// bad_signature`, `401 stale_timestamp`, `401 replayed_nonce`, `403
/// device_revoked`, `403 device_pending`.
pub fn device(app: &App, req: &mut Request, client: &ClientInfo) -> Result<Authed, ApiError> {
    authenticate(app, req, client, &BodyHash::Buffer, Admit::ActiveOnly)
}

/// Authenticate the one request a device may make before it is approved: the
/// fetch of its own pairing envelope. Every other route takes [`device`].
///
/// # Errors
/// As [`device`], except that a pending device is admitted here.
pub fn device_claimant(
    app: &App,
    req: &mut Request,
    client: &ClientInfo,
) -> Result<Authed, ApiError> {
    authenticate(app, req, client, &BodyHash::Buffer, Admit::ActiveOrPending)
}

/// Authenticate a chunk upload: the body hash is the sid in the path, so the
/// body never has to be buffered to verify the signature.
///
/// # Errors
/// As [`device`].
pub fn device_chunk(
    app: &App,
    req: &mut Request,
    client: &ClientInfo,
    sid: &str,
) -> Result<Authed, ApiError> {
    authenticate(app, req, client, &BodyHash::Sid(sid), Admit::ActiveOnly)
}

fn authenticate(
    app: &App,
    req: &mut Request,
    client: &ClientInfo,
    body_hash: &BodyHash<'_>,
    admit: Admit,
) -> Result<Authed, ApiError> {
    let missing = || {
        ApiError::new(
            401,
            "missing_auth",
            "device, timestamp, nonce, and signature required",
        )
    };
    let bad = || ApiError::new(401, "bad_signature", "request signature does not verify");

    let device_hex = req
        .headers
        .get("x-obsync-device")
        .ok_or_else(missing)?
        .to_string();
    let ts_hex = req
        .headers
        .get("x-obsync-ts")
        .ok_or_else(missing)?
        .to_string();
    let nonce = req
        .headers
        .get("x-obsync-nonce")
        .ok_or_else(missing)?
        .to_string();
    let sig = req
        .headers
        .get("x-obsync-sig")
        .ok_or_else(missing)?
        .to_string();
    let target = req.target.clone();
    let method = req.method.clone();

    if !is_hex(&device_hex, 32) || !is_hex(&nonce, 32) || !is_hex(&sig, 64) {
        return Err(bad());
    }
    let id = render::device_id(&device_hex).map_err(|_| bad())?;
    let ts: u64 = ts_hex.parse().map_err(|_| bad())?;

    let record = app.store.device(&id).ok_or_else(bad)?;
    match record.state {
        DeviceState::Active => {}
        DeviceState::Revoked => {
            return Err(ApiError::new(403, "device_revoked", "device is revoked"));
        }
        // A claimed device holds a secret and no authority. Only the
        // envelope fetch admits it; everything else is refused here, so a
        // route added later is refused by default rather than by memory.
        DeviceState::Pending if admit == Admit::ActiveOnly => {
            return Err(ApiError::new(
                403,
                "device_pending",
                "device is waiting for pairing approval",
            ));
        }
        DeviceState::Pending => {}
    }
    let secret = app.store.device_secret(&id).ok_or_else(bad)?;

    let now = app.clock.unix_secs();
    if now.abs_diff(ts) > CLOCK_SKEW_SECS {
        return Err(ApiError::new(
            401,
            "stale_timestamp",
            "timestamp is outside the ±300 s window",
        ));
    }

    let (hash_hex, body) = match body_hash {
        BodyHash::Sid(sid) => ((*sid).to_string(), Vec::new()),
        BodyHash::Buffer => {
            let raw = render::read_body(req, super::JSON_BODY_LIMIT)?;
            (hex::encode(&sha256::sha256(&raw)), raw)
        }
    };

    let canon = canonical(&method, &target, &ts_hex, &nonce, &hash_hex);
    if !verify(&secret, &canon, &sig) {
        return Err(bad());
    }
    app.nonces
        .lock()
        .expect("nonce cache")
        .remember(&device_hex, &nonce, now)?;

    // A sign-in is an ACTIVE device's first authenticated request. A pending
    // device polling for its envelope has not signed in to anything.
    if record.active() {
        record_sign_in(app, &id, client, now);
    }
    Ok(Authed {
        device: record,
        id,
        client: client.clone(),
        body,
    })
}

/// The signed string of `docs/protocol.md`: protocol tag, method, request
/// target exactly as sent, timestamp, nonce, and the hex body hash.
pub fn canonical(method: &str, target: &str, ts: &str, nonce: &str, body_hash_hex: &str) -> String {
    format!("obsync/v1\n{method}\n{target}\n{ts}\n{nonce}\n{body_hash_hex}")
}

/// Constant-time signature check. A malformed signature is a failure, never a
/// panic and never an early exit that leaks a prefix.
pub fn verify(secret: &[u8; 32], canonical: &str, sig_hex: &str) -> bool {
    let Ok(sig) = hex::decode_array::<32>(sig_hex) else {
        return false;
    };
    let mac = hmac::hmac_sha256(secret, canonical.as_bytes());
    ct::eq(&mac, &sig)
}

/// Journal a `sign_in` event at most once per device per 15 minutes, so a
/// chatty client cannot flood the journal with activity frames.
fn record_sign_in(app: &App, id: &DeviceId, client: &ClientInfo, now: u64) {
    {
        let mut seen = app.seen.lock().expect("seen throttle");
        let key = id.to_string();
        if let Some(last) = seen.get(&key)
            && now.saturating_sub(*last) < SIGN_IN_RECORD_INTERVAL_SECS
        {
            return;
        }
        seen.insert(key, now);
    }
    record_seen(app, id, client, SeenKind::SignIn, now);
}

/// Journal an `edit` event for an accepted version post.
pub fn record_edit(app: &App, id: &DeviceId, client: &ClientInfo) {
    let now = app.clock.unix_secs();
    record_seen(app, id, client, SeenKind::Edit, now);
}

/// Journal a `heartbeat` event.
pub fn record_heartbeat(app: &App, id: &DeviceId, client: &ClientInfo) {
    let now = app.clock.unix_secs();
    record_seen(app, id, client, SeenKind::Heartbeat, now);
}

fn record_seen(app: &App, id: &DeviceId, client: &ClientInfo, kind: SeenKind, now: u64) {
    let event = SeenEvent {
        ts: UnixMs(now * 1000),
        kind,
        address: client.address.clone(),
        country: client.country.clone(),
    };
    if let Err(e) = app.store.record_seen(id, event) {
        let mut fields = vec![
            ("kind", Val::word(kind.as_word())),
            ("decision", Val::word(e.code())),
        ];
        fields.extend(error_fields(&e));
        app.log.warn("seen_event_dropped", &fields);
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    use super::*;
    use crate::log::LogLevel;
    use crate::storage::PathClass;
    use crate::storage::testutil::TempDir;

    const SECRET: [u8; 32] = [7u8; 32];

    fn signature(secret: &[u8; 32], canon: &str) -> String {
        hex::encode(&hmac::hmac_sha256(secret, canon.as_bytes()))
    }

    #[test]
    fn the_canonical_string_is_the_documented_six_lines() {
        let c = canonical("GET", "/v1/changes?since=7", "1757200000", "ab", "cd");
        assert_eq!(c, "obsync/v1\nGET\n/v1/changes?since=7\n1757200000\nab\ncd");
        assert_eq!(c.lines().count(), 6);
    }

    #[test]
    fn a_valid_signature_verifies_and_a_tampered_one_does_not() {
        let canon = canonical("PUT", "/v1/chunks/aa", "1757200000", "bb", "cc");
        let sig = signature(&SECRET, &canon);
        assert!(verify(&SECRET, &canon, &sig));

        let tampered = canonical("PUT", "/v1/chunks/ab", "1757200000", "bb", "cc");
        assert!(
            !verify(&SECRET, &tampered, &sig),
            "a changed path must not verify"
        );

        let other = [8u8; 32];
        assert!(
            !verify(&other, &canon, &sig),
            "another device's secret must not verify"
        );
    }

    #[test]
    fn a_malformed_signature_is_a_refusal_not_a_panic() {
        let canon = canonical("GET", "/v1/account", "1", "2", "3");
        assert!(!verify(&SECRET, &canon, ""));
        assert!(!verify(&SECRET, &canon, "zz"));
        assert!(!verify(&SECRET, &canon, &"a".repeat(63)));
        assert!(!verify(&SECRET, &canon, &"a".repeat(128)));
    }

    const DEVICE: &str = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
    const OTHER: &str = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";

    fn nonce(n: u8) -> String {
        format!("{n:032x}")
    }

    /// A journal volume with the root the posture pass would have made.
    fn volume(label: &str) -> TempDir {
        let dir = TempDir::new(label);
        std::fs::create_dir_all(PathClass::JournalRoot.path(dir.path())).expect("journal root");
        dir
    }

    /// Where the durable state rests, as `docs/storage.md` states it.
    fn log_file(dir: &TempDir) -> std::path::PathBuf {
        PathClass::JournalRoot.path(dir.path()).join("nonces")
    }

    /// Where a compaction assembles the replacement before it takes the
    /// name (`docs/storage.md`, "Nonce log recovery", steps 1 and 2).
    fn tmp_file(dir: &TempDir) -> std::path::PathBuf {
        PathClass::JournalRoot.path(dir.path()).join("nonces.tmp")
    }

    /// Whether this process is root, whom no directory mode holds out. The
    /// user comes off `/proc/self` on Linux, as `storage::posture` reads
    /// it, and off the volume the caller just made everywhere else.
    fn running_as_root(dir: &TempDir) -> bool {
        std::fs::metadata("/proc/self")
            .or_else(|_| std::fs::metadata(dir.path()))
            .is_ok_and(|m| m.uid() == 0)
    }

    fn lines_on_disk(dir: &TempDir) -> usize {
        std::fs::read_to_string(log_file(dir))
            .expect("the log is there")
            .lines()
            .count()
    }

    /// A cache over `dir` at a capacity the test drives. Production takes
    /// `NONCE_CACHE_MAX`; two is enough to reach the ceiling and the
    /// compaction that stands beyond it inside one test.
    fn cache(dir: &TempDir, now: u64, capacity: usize, log: &Log) -> NonceCache {
        NonceCache::sized(dir.path(), now, capacity, log).expect("the nonce log opens")
    }

    /// Accept five nonces at a capacity of two: two per window, with a
    /// window between each pair, so the file grows to one line short of
    /// twice the ceiling while the cache never passes it. Returns the
    /// second the last of them was accepted at, when one entry is live.
    fn fill_to_the_threshold(c: &mut NonceCache) -> u64 {
        let mut now = 1_000;
        for n in 1..=5u8 {
            if n % 2 == 1 && n > 1 {
                now += NONCE_TTL_SECS + 1;
            }
            c.remember(DEVICE, &nonce(n), now).expect("accepted");
        }
        now
    }

    #[test]
    fn a_nonce_is_refused_a_second_time_inside_the_window() {
        let dir = volume("nonce-replay");
        let log = Log::buffered(LogLevel::Debug);
        let mut c = cache(&dir, 1_000, NONCE_CACHE_MAX, &log);
        assert!(c.is_empty(), "a volume with no log is a first boot");
        c.remember(DEVICE, &nonce(1), 1_000).expect("first use");
        let e = c.remember(DEVICE, &nonce(1), 1_000).expect_err("replay");
        assert_eq!(e.status, 401);
        assert_eq!(e.code, "replayed_nonce");
    }

    #[test]
    fn the_same_nonce_from_another_device_is_not_a_replay() {
        let dir = volume("nonce-devices");
        let log = Log::buffered(LogLevel::Debug);
        let mut c = cache(&dir, 1_000, NONCE_CACHE_MAX, &log);
        c.remember(DEVICE, &nonce(1), 1_000).expect("first use");
        c.remember(OTHER, &nonce(1), 1_000)
            .expect("different device");
    }

    #[test]
    fn a_nonce_is_forgotten_only_after_the_full_ttl() {
        let dir = volume("nonce-ttl");
        let log = Log::buffered(LogLevel::Debug);
        let mut c = cache(&dir, 1_000, NONCE_CACHE_MAX, &log);
        c.remember(DEVICE, &nonce(1), 1_000).expect("first use");
        assert!(
            c.remember(DEVICE, &nonce(1), 1_000 + NONCE_TTL_SECS - 1)
                .is_err(),
            "a nonce inside the ttl is still a replay"
        );
        c.sweep(1_000 + NONCE_TTL_SECS + 1);
        assert!(c.is_empty());
        c.remember(DEVICE, &nonce(1), 1_000 + NONCE_TTL_SECS + 1)
            .expect("outside the ttl");
    }

    #[test]
    fn sweeping_keeps_live_entries_and_drops_expired_ones() {
        let dir = volume("nonce-sweep");
        let log = Log::buffered(LogLevel::Debug);
        let mut c = cache(&dir, 1_000, NONCE_CACHE_MAX, &log);
        c.remember(DEVICE, &nonce(1), 1_000).expect("first");
        c.remember(DEVICE, &nonce(2), 1_400).expect("second");
        let dropped = c.sweep(1_700);
        assert_eq!(dropped, 1);
        assert_eq!(c.len(), 1);
    }

    /// The whole point of the file: a request captured before a restart is
    /// still inside its window after one.
    #[test]
    fn a_nonce_outlives_the_process_that_accepted_it() {
        let dir = volume("nonce-restart");
        let log = Log::buffered(LogLevel::Debug);
        let mut c = cache(&dir, 1_000, NONCE_CACHE_MAX, &log);
        c.remember(DEVICE, &nonce(1), 1_000).expect("first use");
        assert_eq!(
            lines_on_disk(&dir),
            1,
            "the accepted nonce is on the volume"
        );
        drop(c);

        let mut restarted = cache(&dir, 1_100, NONCE_CACHE_MAX, &log);
        assert_eq!(restarted.len(), 1, "the window survives the process");
        let e = restarted
            .remember(DEVICE, &nonce(1), 1_100)
            .expect_err("the captured request is still a replay");
        assert_eq!(e.code, "replayed_nonce");
        assert!(
            log.captured()
                .contains("event=nonce_log decision=loaded entries=1"),
            "{}",
            log.captured()
        );
    }

    #[test]
    fn an_entry_past_the_window_is_not_loaded() {
        let dir = volume("nonce-expiry");
        let log = Log::buffered(LogLevel::Debug);
        let mut c = cache(&dir, 1_000, NONCE_CACHE_MAX, &log);
        c.remember(DEVICE, &nonce(1), 1_000).expect("first use");
        drop(c);

        // One second past the window it protects nothing, and holding it
        // would be a cache that only ever grows.
        let mut restarted = cache(&dir, 1_000 + NONCE_TTL_SECS + 1, NONCE_CACHE_MAX, &log);
        assert!(restarted.is_empty());
        restarted
            .remember(DEVICE, &nonce(1), 1_000 + NONCE_TTL_SECS + 1)
            .expect("outside the window it is a fresh nonce");
        assert!(log.captured().contains("expired=1"), "{}", log.captured());
    }

    #[test]
    fn a_torn_last_line_costs_only_itself() {
        let dir = volume("nonce-torn");
        let log = Log::buffered(LogLevel::Debug);
        let mut c = cache(&dir, 1_000, NONCE_CACHE_MAX, &log);
        c.remember(DEVICE, &nonce(1), 1_000).expect("first");
        c.remember(DEVICE, &nonce(2), 1_000).expect("second");
        drop(c);
        // A crash between an append and its fsync: half a line, and only
        // ever the newest one.
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(log_file(&dir))
            .expect("the log opens");
        file.write_all(format!("1000 {DEVICE} {}", &nonce(3)[..10]).as_bytes())
            .expect("the torn line lands");
        drop(file);

        let mut restarted = cache(&dir, 1_000, NONCE_CACHE_MAX, &log);
        assert_eq!(restarted.len(), 2, "everything before it survives");
        assert_eq!(lines_on_disk(&dir), 2, "and the torn line is cut off");
        assert!(
            log.captured().contains("decision=truncated"),
            "{}",
            log.captured()
        );
        restarted
            .remember(DEVICE, &nonce(1), 1_000)
            .expect_err("the lines that were durable are still held");
    }

    #[test]
    fn a_line_that_is_not_an_entry_refuses_the_start() {
        let dir = volume("nonce-corrupt");
        let log = Log::buffered(LogLevel::Debug);
        std::fs::write(
            log_file(&dir),
            format!("1000 {DEVICE} not-a-nonce\n1000 x y\n"),
        )
        .expect("foreign content");
        let Err(e) = NonceCache::sized(dir.path(), 1_000, NONCE_CACHE_MAX, &log) else {
            panic!("a log that is not a log refuses the start");
        };
        assert_eq!(e.code(), "corrupt");
        assert!(
            log.captured().contains("reason=nonce_log_corrupt"),
            "{}",
            log.captured()
        );
    }

    #[test]
    fn a_link_where_the_durable_state_belongs_refuses_the_start() {
        let dir = volume("nonce-link");
        let log = Log::buffered(LogLevel::Debug);
        // The shape a restored volume can arrive in: the name pointing at
        // another file this server may write. An append through it would put
        // nonce lines inside that file.
        let target = dir.path().join("elsewhere");
        std::fs::write(&target, "sentinel\n").expect("the target");
        std::os::unix::fs::symlink(&target, log_file(&dir)).expect("the link is planted");

        let Err(e) = NonceCache::sized(dir.path(), 1_000, NONCE_CACHE_MAX, &log) else {
            panic!("a link is never followed");
        };
        assert_eq!(e.code(), "corrupt");
        assert!(
            log.captured().contains("reason=not_a_regular_file"),
            "{}",
            log.captured()
        );
        assert_eq!(
            std::fs::read_to_string(&target).expect("still there"),
            "sentinel\n",
            "and nothing is written through it"
        );
    }

    #[test]
    fn the_ceiling_still_refuses_after_a_reload() {
        let dir = volume("nonce-ceiling");
        let log = Log::buffered(LogLevel::Debug);
        let mut c = cache(&dir, 1_000, 2, &log);
        c.remember(DEVICE, &nonce(1), 1_000).expect("first");
        c.remember(DEVICE, &nonce(2), 1_000).expect("second");
        drop(c);

        // Reloading is not a way past the ceiling: what came back off the
        // volume counts against it exactly as what this process accepted.
        let mut restarted = cache(&dir, 1_000, 2, &log);
        assert_eq!(restarted.len(), 2);
        let e = restarted
            .remember(DEVICE, &nonce(3), 1_000)
            .expect_err("the ceiling is reached");
        assert_eq!(e.status, 503);
        assert_eq!(e.code, "nonce_cache_full");
    }

    #[test]
    fn every_accepted_nonce_pays_for_one_durable_record() {
        let dir = volume("nonce-durability");
        let log = Log::buffered(LogLevel::Debug);
        let mut c = cache(&dir, 1_000, NONCE_CACHE_MAX, &log);
        for n in 1..=3u8 {
            c.remember(DEVICE, &nonce(n), 1_000).expect("accepted");
        }
        // A replay is not an acceptance, so it costs nothing.
        c.remember(DEVICE, &nonce(1), 1_000).expect_err("replay");
        assert_eq!(
            c.syncs(),
            3,
            "the record is made durable before the request is served"
        );
    }

    #[test]
    fn the_log_is_compacted_once_it_passes_twice_the_ceiling() {
        let dir = volume("nonce-compaction");
        let log = Log::buffered(LogLevel::Debug);
        let mut c = cache(&dir, 1_000, 2, &log);
        let now = fill_to_the_threshold(&mut c);
        assert_eq!(lines_on_disk(&dir), 5, "every acceptance is one line");

        c.remember(DEVICE, &nonce(6), now).expect("accepted");
        assert_eq!(
            lines_on_disk(&dir),
            2,
            "the rewrite keeps what the window still covers and nothing else"
        );
        c.remember(DEVICE, &nonce(5), now)
            .expect_err("and a live nonce is still a replay after the rewrite");
    }

    /// The reviewer's round-15 case: a link planted at the temporary name.
    /// A compaction that opened it by name would rewrite the link's target
    /// and then rename the link onto the log.
    #[test]
    fn a_link_standing_at_the_temporary_name_is_not_followed_by_compaction() {
        let dir = volume("nonce-tmp-link");
        let log = Log::buffered(LogLevel::Debug);
        let victim = dir.path().join("victim");
        std::fs::write(&victim, "sentinel\n").expect("the victim");
        let tmp = tmp_file(&dir);
        std::os::unix::fs::symlink(&victim, &tmp).expect("the link is planted");

        let mut c = cache(&dir, 1_000, 2, &log);
        let now = fill_to_the_threshold(&mut c);
        c.remember(DEVICE, &nonce(6), now).expect("accepted");
        assert_eq!(lines_on_disk(&dir), 2, "the rewrite happened");
        assert_eq!(
            std::fs::read_to_string(&victim).expect("still there"),
            "sentinel\n",
            "and nothing was written through the planted link"
        );
        let meta = std::fs::symlink_metadata(log_file(&dir)).expect("the log");
        assert!(
            meta.file_type().is_file(),
            "the log is a regular file, not the link"
        );
        assert!(
            std::fs::symlink_metadata(&tmp).is_err(),
            "the planted name is gone, not renamed onto the log"
        );
        // The handle that wrote the rewrite is the one that appends: the
        // next accepted nonce, in a fresh window so the ceiling of two is
        // not what answers, lands in the log and only there.
        c.remember(DEVICE, &nonce(7), now + NONCE_TTL_SECS + 1)
            .expect("accepted after the rewrite");
        assert_eq!(lines_on_disk(&dir), 3);
        assert_eq!(
            std::fs::read_to_string(&victim).expect("still there"),
            "sentinel\n"
        );
    }

    // Pins `docs/storage.md`, "Nonce log recovery": "A crash before step 5
    // leaves a partial `v1/nonces.tmp` behind. The next start ignores it."
    #[test]
    fn a_partial_temporary_file_is_ignored_at_the_next_start_and_the_rewrite_replaces_it() {
        let dir = volume("nonce-tmp-partial");
        let log = Log::buffered(LogLevel::Debug);
        let mut c = cache(&dir, 1_000, 2, &log);
        let now = fill_to_the_threshold(&mut c);
        drop(c);
        // What a crash between step 2 and step 5 leaves: as much of the
        // replacement as reached the volume. One complete line and a torn
        // one, naming a device and a nonce the log itself never held.
        std::fs::write(
            tmp_file(&dir),
            format!(
                "{now} {OTHER} {}\n{now} {OTHER} {}",
                nonce(9),
                &nonce(9)[..10]
            ),
        )
        .expect("the leftover lands");

        let mut restarted = cache(&dir, now, 2, &log);
        assert_eq!(
            restarted.len(),
            1,
            "the window is what `v1/nonces` still covers, and nothing else"
        );
        // The leftover named a nonce. A start that had read it would call
        // this a replay; it is accepted, and it is the request that crosses
        // the threshold and drives the rewrite.
        restarted
            .remember(OTHER, &nonce(9), now)
            .expect("nothing standing at the temporary name was ever loaded");
        assert_eq!(
            lines_on_disk(&dir),
            2,
            "the rewrite kept the live entry and the line that triggered it"
        );
        assert!(
            std::fs::read_to_string(log_file(&dir))
                .expect("the log")
                .ends_with('\n'),
            "and no torn tail came with it"
        );
        assert!(
            std::fs::symlink_metadata(tmp_file(&dir)).is_err(),
            "the temporary name is gone"
        );
    }

    // Pins `docs/storage.md`, "Nonce log recovery": "Any failure inside the
    // sequence refuses the request that triggered it with `503
    // nonce_log_unavailable` ... Nothing already durable changes ... the
    // nonce the refused request carried was never recorded."
    #[test]
    fn a_directory_at_the_temporary_name_refuses_the_request_and_spends_no_nonce() {
        let dir = volume("nonce-tmp-directory");
        let log = Log::buffered(LogLevel::Debug);
        // A name step 1 cannot remove and step 2 cannot take.
        std::fs::create_dir(tmp_file(&dir)).expect("a directory stands at the temporary name");
        let mut c = cache(&dir, 1_000, 2, &log);
        let now = fill_to_the_threshold(&mut c);
        assert_eq!(lines_on_disk(&dir), 5);

        let e = c
            .remember(DEVICE, &nonce(6), now)
            .expect_err("the rewrite cannot happen, so the request cannot be answered");
        assert_eq!(e.status, 503);
        assert_eq!(e.code, "nonce_log_unavailable");
        assert!(
            log.captured().contains("event=nonce_log decision=refused"),
            "{}",
            log.captured()
        );
        assert_eq!(lines_on_disk(&dir), 5, "nothing already durable changed");
        assert_eq!(c.len(), 1, "and neither did the window");
        assert_eq!(
            c.remember(DEVICE, &nonce(5), now)
                .expect_err("what the window held it holds still")
                .code,
            "replayed_nonce"
        );

        std::fs::remove_dir(tmp_file(&dir)).expect("the directory goes");
        c.remember(DEVICE, &nonce(6), now)
            .expect("the nonce the refusal carried was never spent");
        assert_eq!(
            lines_on_disk(&dir),
            2,
            "and the threshold was still outstanding, so the rewrite happened"
        );
    }

    // Pins `docs/storage.md`, "Nonce log recovery": "A crash after step 5
    // leaves the replacement standing as the log, and that is the file the
    // next start reads."
    #[test]
    fn the_bytes_the_rename_publishes_are_the_window_a_fresh_start_reads() {
        let log = Log::buffered(LogLevel::Debug);
        // The replacement a real compaction publishes, taken off a real
        // volume: a log opened, handed a live window, rewritten.
        let source = volume("nonce-rename-source");
        let (mut durable, _) = NonceLog::open(source.path(), 1_000, &log).expect("the log opens");
        let live: HashMap<Nonce, u64> = [
            ((DEVICE.to_string(), nonce(5)), 2_202 + NONCE_TTL_SECS),
            ((OTHER.to_string(), nonce(6)), 2_202 + NONCE_TTL_SECS),
        ]
        .into_iter()
        .collect();
        durable.compact(&live).expect("the rewrite lands");
        let published = std::fs::read_to_string(log_file(&source)).expect("the log");
        assert_eq!(
            published.lines().count(),
            2,
            "step 5 puts one line per live entry at the log's name"
        );
        assert!(
            std::fs::symlink_metadata(tmp_file(&source)).is_err(),
            "and consumes the temporary name doing it"
        );

        // Step 6 lost: the replacement's bytes stand at the log's name and
        // no temporary file is left. Built by hand, because a test cannot
        // stop the kernel between a rename and the fsync that follows it.
        let dir = volume("nonce-rename-crash");
        std::fs::write(log_file(&dir), &published).expect("what the rename left");
        let mut restarted = cache(&dir, 2_202, NONCE_CACHE_MAX, &log);
        assert_eq!(
            restarted.len(),
            2,
            "exactly the entries the replacement held"
        );
        assert_eq!(
            restarted
                .remember(DEVICE, &nonce(5), 2_202)
                .expect_err("each is still inside its window")
                .code,
            "replayed_nonce"
        );
        assert_eq!(
            restarted
                .remember(OTHER, &nonce(6), 2_202)
                .expect_err("both of them")
                .code,
            "replayed_nonce"
        );
    }

    // Pins `docs/storage.md`, "Nonce log recovery": "The compaction
    // threshold is still outstanding, so the next accepted request attempts
    // the rewrite again."
    #[test]
    fn a_root_that_will_not_take_the_replacement_refuses_and_keeps_the_threshold() {
        let dir = volume("nonce-root-readonly");
        let log = Log::buffered(LogLevel::Debug);
        if running_as_root(&dir) {
            // A mode holds root out of nothing, so there is no refusal to
            // make here. The case is skipped, never weakened.
            return;
        }
        let mut c = cache(&dir, 1_000, 2, &log);
        let now = fill_to_the_threshold(&mut c);
        let root = PathClass::JournalRoot.path(dir.path());

        // Step 2 cannot create the replacement under a root this user may
        // not write. Everything is measured while the root is closed and
        // asserted after it is open, so no panic can leave it that way.
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o500))
            .expect("closed to its owner");
        let refused = c.remember(DEVICE, &nonce(6), now);
        let while_closed = std::fs::read_to_string(log_file(&dir)).map(|t| t.lines().count());
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))
            .expect("open again");

        let e = refused.expect_err("the replacement cannot be created");
        assert_eq!(e.status, 503);
        assert_eq!(e.code, "nonce_log_unavailable");
        assert!(
            log.captured().contains("event=nonce_log decision=refused"),
            "{}",
            log.captured()
        );
        assert_eq!(
            while_closed.expect("the log is still readable"),
            5,
            "nothing already durable changed"
        );
        c.remember(DEVICE, &nonce(6), now)
            .expect("accepted once the root takes a new file");
        assert_eq!(
            lines_on_disk(&dir),
            2,
            "and the rewrite it was owed happened then"
        );
    }

    #[test]
    fn the_durable_state_is_readable_by_nobody_but_this_user() {
        let dir = volume("nonce-mode");
        let log = Log::buffered(LogLevel::Debug);
        let mut c = cache(&dir, 1_000, 2, &log);
        c.remember(DEVICE, &nonce(1), 1_000).expect("accepted");
        let mode = std::fs::symlink_metadata(log_file(&dir))
            .expect("the log is there")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn the_window_is_exactly_three_hundred_seconds() {
        assert_eq!(CLOCK_SKEW_SECS, 300);
        assert_eq!(NONCE_TTL_SECS, 600);
        let now: u64 = 1_757_200_000;
        assert!(now.abs_diff(now + CLOCK_SKEW_SECS) <= CLOCK_SKEW_SECS);
        assert!(now.abs_diff(now + CLOCK_SKEW_SECS + 1) > CLOCK_SKEW_SECS);
        assert!(now.abs_diff(now - CLOCK_SKEW_SECS - 1) > CLOCK_SKEW_SECS);
    }
}
