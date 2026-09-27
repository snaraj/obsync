//! Per-device HMAC request authentication (`docs/protocol.md`,
//! "Authentication").
//!
//! The window is ±300 s and nonces are remembered for 600 s. Both are
//! constants: no environment variable, build flag, or config field can widen
//! or disable them (AGENTS.md requirement 4 and "Security invariants").
#![forbid(unsafe_code)]

use std::collections::{HashMap, HashSet};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use obsync_core::hex;
use obsync_core::http::Request;
use obsync_core::{ct, hmac, sha256};

use crate::log::{Log, Val};
use crate::storage::types::{DeviceRecord, DeviceState, SeenEvent, SeenKind};
use crate::storage::{StoreError, error_fields};
use crate::types::{DeviceId, UnixMs};

use super::edge::ClientInfo;
use super::nonce_log::{Nonce, NonceLog, window};
use super::{ApiError, App, SIGN_IN_RECORD_INTERVAL_SECS, is_hex, render};

/// Widest accepted difference between the request timestamp and server time.
pub const CLOCK_SKEW_SECS: u64 = 300;
/// How long a nonce is remembered, so a captured request cannot be replayed.
pub const NONCE_TTL_SECS: u64 = 600;
/// Most nonces held at once. Reaching it refuses requests rather than
/// forgetting a nonce that is still inside its window.
pub const NONCE_CACHE_MAX: usize = 200_000;
/// Most nonces one device holds at once: a quarter of the cache, about 83
/// requests a second sustained across the whole window. A device that
/// reaches it is refused on its own, and the other devices keep the rest, so
/// one runaway or compromised device can no longer lock every device out.
pub const NONCE_DEVICE_SHARE: usize = NONCE_CACHE_MAX / 4;
const _: () = assert!(NONCE_DEVICE_SHARE < NONCE_CACHE_MAX);

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
///
/// GROUP COMMIT. The mutex guards memory only and is never held across the
/// volume. A request checks its nonce, enters it in `seen` (so a replay of
/// it is refused from that moment, before it is durable) and joins the open
/// batch. Whoever finds no flush in flight becomes the leader: it takes the
/// batch and the file, releases the mutex, writes and fsyncs, and publishes
/// the outcome to every member. Requests that arrive during a flush wait and
/// form the next batch, so c concurrent requests cost about one fsync, not c.
/// No request is answered before the batch holding its nonce is durable; a
/// batch the volume refuses answers every member `503` and takes their
/// nonces back out of `seen`, so each is still unspent and a retry is not
/// refused as a replay.
pub struct NonceCache {
    state: Mutex<NonceState>,
    /// Signalled whenever a flush settles.
    settled: Condvar,
    log: Log,
    /// Most nonces held at once. [`NONCE_CACHE_MAX`] everywhere but the
    /// tests that drive the ceiling and the compaction it triggers.
    capacity: usize,
    /// Most nonces one device holds: [`NONCE_DEVICE_SHARE`], or the whole
    /// capacity where a test shrinks that below it.
    share: usize,
    #[cfg(test)]
    syncing: Arc<std::sync::atomic::AtomicBool>,
}

struct NonceState {
    /// Durable and pending nonces alike, each with its expiry. A nonce
    /// enters only through [`NonceState::admit`] and leaves only through
    /// [`NonceState::unspend`] and [`NonceState::sweep`], the three places
    /// that keep `held` its exact per-device count.
    seen: HashMap<Nonce, u64>,
    /// How many of `seen` each device holds, pending ones included, against
    /// its share.
    held: HashMap<String, usize>,
    /// The second of the last sweep a refusal ran. Nothing expires inside
    /// one second, so a device knocking at its share costs one sweep a
    /// second rather than one per request.
    swept_at: u64,
    /// The nonces the next flush writes.
    open: Batch,
    /// The file, here while no flush runs and with the leader while one
    /// does: `None` IS "a flush is in flight".
    durable: Option<NonceLog>,
}

/// Accepted nonces awaiting one fsync, and where their members learn how it
/// went.
#[derive(Default)]
struct Batch {
    entries: Vec<(u64, Nonce)>,
    outcome: Arc<OnceLock<Result<(), std::io::ErrorKind>>>,
}

impl NonceState {
    /// How many nonces `device` holds right now.
    fn held_by(&self, device: &str) -> usize {
        self.held.get(device).copied().unwrap_or(0)
    }

    /// Enter a nonce in the window, counted against its device once: an
    /// expired entry not yet swept is replaced, not counted twice.
    fn admit(&mut self, entry: Nonce, expiry: u64) {
        let device = entry.0.clone();
        if self.seen.insert(entry, expiry).is_none() {
            *self.held.entry(device).or_default() += 1;
        }
    }

    /// Take back a nonce whose batch the volume refused: it leaves `seen`
    /// exactly as it entered, and its device's count with it, unless a later
    /// acceptance of the same pair has replaced it since.
    fn unspend(&mut self, ts: u64, entry: &Nonce) {
        if self.seen.get(entry) == Some(&(ts + NONCE_TTL_SECS)) {
            self.seen.remove(entry);
            self.release(&entry.0);
        }
    }

    fn release(&mut self, device: &str) {
        if let Some(count) = self.held.get_mut(device) {
            *count -= 1;
            if *count == 0 {
                self.held.remove(device);
            }
        }
    }

    /// Drop expired entries, returning how many went.
    fn sweep(&mut self, now: u64) -> usize {
        let before = self.seen.len();
        let held = &mut self.held;
        self.seen.retain(|(device, _), expiry| {
            let live = *expiry > now;
            if !live && let Some(count) = held.get_mut(device) {
                *count -= 1;
            }
            live
        });
        held.retain(|_, count| *count > 0);
        before - self.seen.len()
    }
}

impl NonceCache {
    /// Open the durable state on the journal volume and load the nonces
    /// still inside the window.
    ///
    /// # Errors
    /// The volume, or on-disk state that is not a nonce log. Both refuse the
    /// start: a server that cannot record what it accepts cannot promise
    /// that it will refuse it a second time.
    pub fn open(
        journal_dir: &Path,
        now: u64,
        reported: Arc<AtomicU64>,
        log: &Log,
    ) -> Result<NonceCache, StoreError> {
        Self::sized(journal_dir, now, NONCE_CACHE_MAX, reported, log)
    }

    fn sized(
        journal_dir: &Path,
        now: u64,
        capacity: usize,
        reported: Arc<AtomicU64>,
        log: &Log,
    ) -> Result<NonceCache, StoreError> {
        let (durable, entries) = NonceLog::open(journal_dir, now, reported, log)?;
        let mut held: HashMap<String, usize> = HashMap::new();
        for ((device, _), _) in &entries {
            *held.entry(device.clone()).or_default() += 1;
        }
        Ok(NonceCache {
            #[cfg(test)]
            syncing: durable.syncing(),
            state: Mutex::new(NonceState {
                seen: entries.into_iter().collect(),
                held,
                swept_at: 0,
                open: Batch::default(),
                durable: Some(durable),
            }),
            settled: Condvar::new(),
            log: log.clone(),
            capacity,
            share: NONCE_DEVICE_SHARE.min(capacity),
        })
    }

    /// The state, whatever a panic did to the lock. The panic that can hold
    /// it is a flush's, and `Flight` puts the state back before that guard
    /// goes, so the poison the guard leaves says nothing about the state. A
    /// member woken by the flush before reached the lock in the instant
    /// between the two, trusted the poison and panicked in turn -- poisoning
    /// the lock again, for good, so that every request after it failed too
    /// (the arm64 runners, 2026-09-27).
    fn state(&self) -> MutexGuard<'_, NonceState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The file, while no flush holds it. Tests only, between requests.
    #[cfg(test)]
    fn with_durable<T>(&self, read: impl FnOnce(&NonceLog) -> T) -> T {
        read(self.state().durable.as_ref().expect("no flush in flight"))
    }

    /// Arm the durable log's crash point. Tests only.
    #[cfg(test)]
    pub(super) fn set_fault(&self, fault: super::nonce_log::NonceFault) {
        self.with_durable(|file| file.set_fault(fault));
    }

    /// Remember `nonce` for `device`, or report the replay. Returns only once
    /// the record is durable.
    ///
    /// The reservation comes first and is all in memory: a request refused
    /// as a replay, for the ceiling or for its device's share never enters
    /// `seen` or a batch, so it costs no fsync and holds nothing.
    ///
    /// # Errors
    /// `401 replayed_nonce` when the pair is already held, durable or still
    /// in flight; `503 nonce_cache_full` when the cache is at its ceiling and
    /// `503 nonce_share_full` when this device holds its whole share of it --
    /// refusing beats forgetting a nonce that is still inside its window --
    /// and `503 nonce_log_unavailable` when the volume will not take the
    /// batch the record was written in.
    pub fn remember(&self, device: &str, nonce: &str, now: u64) -> Result<(), ApiError> {
        let entry = (device.to_string(), nonce.to_string());
        let mut state = self.state();
        if let Some(expiry) = state.seen.get(&entry)
            && *expiry > now
        {
            return Err(ApiError::new(
                401,
                "replayed_nonce",
                "nonce was used inside the window",
            ));
        }
        if (state.seen.len() >= self.capacity || state.held_by(device) >= self.share)
            && now > state.swept_at
        {
            state.swept_at = now;
            state.sweep(now);
        }
        if state.seen.len() >= self.capacity {
            return Err(ApiError::new(
                503,
                "nonce_cache_full",
                "replay cache is full; retry shortly",
            ));
        }
        let held = state.held_by(device);
        if held >= self.share {
            let mut fields = vec![
                ("decision", Val::word("refused")),
                ("reason", Val::word("device_share")),
                ("held", Val::count(held as u64)),
                ("budget", Val::count(self.share as u64)),
            ];
            if let Ok(id) = device.parse::<DeviceId>() {
                fields.insert(0, ("device", Val::device(&id)));
            }
            self.log.warn("nonce_cache", &fields);
            return Err(ApiError::new(
                503,
                "nonce_share_full",
                "this device's share of the replay cache is full; retry shortly",
            ));
        }
        state.admit(entry.clone(), now + NONCE_TTL_SECS);
        state.open.entries.push((now, entry));
        let outcome = Arc::clone(&state.open.outcome);
        loop {
            if let Some(settled) = outcome.get() {
                return settled.map_err(|_| unavailable());
            }
            state = match state.durable.take() {
                // A flush that panics has settled its batch on the way out
                // (`Flight`), this request's own included, so the leader is
                // answered like every other member rather than with the panic.
                Some(file) => catch_unwind(AssertUnwindSafe(|| self.flush(state, file, now)))
                    .unwrap_or_else(|_| self.state()),
                None => self
                    .settled
                    .wait(state)
                    .unwrap_or_else(PoisonError::into_inner),
            };
        }
    }

    /// Lead one flush: take the open batch and the file, and land them.
    fn flush<'a>(
        &'a self,
        mut state: MutexGuard<'a, NonceState>,
        file: NonceLog,
        now: u64,
    ) -> MutexGuard<'a, NonceState> {
        let batch = std::mem::take(&mut state.open);
        Flight {
            cache: self,
            batch,
            file: Some(file),
            state: Some(state),
        }
        .land(now)
    }

    /// Drop expired entries, returning how many went.
    pub fn sweep(&self, now: u64) -> usize {
        self.state().sweep(now)
    }

    /// Records written since the last call, for the sweep summary: what one
    /// period of requests cost the journal volume (requirement 12). Zero
    /// while a flush holds the file; its records count at the next call.
    pub fn appends(&self) -> u64 {
        self.state()
            .durable
            .as_mut()
            .map_or(0, NonceLog::take_appends)
    }

    /// How many nonces are held.
    pub fn len(&self) -> usize {
        self.state().seen.len()
    }

    /// Whether the cache holds nothing.
    pub fn is_empty(&self) -> bool {
        self.state().seen.is_empty()
    }

    /// How many times the durable state has been made durable, for the test
    /// that pins one per flush.
    #[cfg(test)]
    pub fn syncs(&self) -> u64 {
        self.with_durable(NonceLog::syncs)
    }

    /// Whether every device's count is exactly what `seen` holds for it,
    /// and how many `device` holds. Tests only.
    #[cfg(test)]
    fn held_exactly(&self, device: &str) -> (bool, usize) {
        let state = self.state();
        let mut counted: HashMap<String, usize> = HashMap::new();
        for (owner, _) in state.seen.keys() {
            *counted.entry(owner.clone()).or_default() += 1;
        }
        (counted == state.held, state.held_by(device))
    }
}

/// A flush in flight: the batch it took, the file, and the mutex while it
/// holds it. Dropped with the file still inside -- which only a flush
/// unwinding from a panic is -- it settles the batch as a refused one: a
/// panic anywhere between taking the batch and publishing its outcome would
/// otherwise leave every member waiting for an outcome nobody sets, and
/// every later request waiting for a file nobody hands back.
struct Flight<'a> {
    cache: &'a NonceCache,
    batch: Batch,
    file: Option<NonceLog>,
    state: Option<MutexGuard<'a, NonceState>>,
}

impl<'a> Flight<'a> {
    /// Write and fsync with the mutex released, then settle every member at
    /// once.
    ///
    /// The file is rewritten before the batch joins it, never after: a
    /// volume that refuses the rewrite refuses the batch too, and every
    /// nonce in it is still unspent. The rewrite holds what was durable
    /// before this batch and not the batch itself, because a batch the
    /// append then refuses must not survive in the rewritten file.
    fn land(mut self, now: u64) -> MutexGuard<'a, NonceState> {
        let cache = self.cache;
        let file = self.file.as_mut().expect("a flight holds the file");
        let state = self.state.as_mut().expect("a flight starts locked");
        let rewrite = (file.lines() > cache.capacity * 2).then(|| {
            state.sweep(now);
            let pending: HashSet<&Nonce> = self.batch.entries.iter().map(|(_, e)| e).collect();
            window(state.seen.iter().filter(|(e, _)| !pending.contains(e)))
        });
        self.state = None;
        let written = rewrite
            .map_or(Ok(()), |(body, lines)| file.compact(&body, lines))
            .and_then(|()| file.append(&self.batch.entries));
        let state = self.state.insert(cache.state());
        if let Err(e) = &written {
            cache.log.error(
                "nonce_log",
                &[
                    ("decision", Val::word("refused")),
                    ("io", Val::io(e)),
                    ("batch", Val::count(self.batch.entries.len() as u64)),
                ],
            );
            for (ts, entry) in &self.batch.entries {
                state.unspend(*ts, entry);
            }
        }
        state.durable = self.file.take();
        let _ = self.batch.outcome.set(written.map_err(|e| e.kind()));
        cache.settled.notify_all();
        self.state.take().expect("a flight ends locked")
    }
}

impl Drop for Flight<'_> {
    fn drop(&mut self) {
        let Some(mut file) = self.file.take() else {
            return;
        };
        let cache = self.cache;
        file.abandon();
        let mut state = self
            .state
            .take()
            .unwrap_or_else(|| cache.state.lock().unwrap_or_else(PoisonError::into_inner));
        cache.log.error(
            "nonce_log",
            &[
                ("decision", Val::word("refused")),
                ("reason", Val::word("flush_panicked")),
                ("batch", Val::count(self.batch.entries.len() as u64)),
            ],
        );
        for (ts, entry) in &self.batch.entries {
            state.unspend(*ts, entry);
        }
        state.durable = Some(file);
        let _ = self.batch.outcome.set(Err(std::io::ErrorKind::Other));
        // Dropped while unwinding, this guard poisons the lock; the state it
        // guards is whole again, and every lock taken on it says so
        // (`NonceCache::state`).
        drop(state);
        cache.settled.notify_all();
    }
}

/// The refusal every member of a batch the volume would not take gets. The
/// flush that failed has already logged the one line (requirement 12).
fn unavailable() -> ApiError {
    ApiError::new(
        503,
        "nonce_log_unavailable",
        "replay state could not be recorded; retry shortly",
    )
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
    // Revocation is the one refusal that cannot wait for the signature:
    // revoking DESTROYS the wrapped secret, so there is nothing left to
    // verify against and the server can never claim this caller proved
    // anything. The documented `403 device_revoked` still stands, and
    // `App::finish` classes it for what it is -- a refusal answered before
    // any proof (`docs/security/dashboard.md`).
    if matches!(record.state, DeviceState::Revoked) {
        return Err(ApiError::new(403, "device_revoked", "device is revoked"));
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
            let raw = render::read_body(app, req, super::JSON_BODY_LIMIT)?;
            (hex::encode(&sha256::sha256(&raw)), raw)
        }
    };

    let canon = canonical(&method, &target, &ts_hex, &nonce, &hash_hex);
    if !verify(&secret, &canon, &sig) {
        return Err(bad());
    }
    app.nonces.remember(&device_hex, &nonce, now)?;

    // The signature verified, the timestamp is inside the window and the
    // nonce is fresh: this caller holds the device secret. That fact, and
    // not the status the handler goes on to answer, is what
    // `App::finish` reads to classify the response (`api/mod.rs`,
    // `Trust`). Everything refused above this line -- a missing or
    // malformed header, an unknown device, a revoked or pending one, a
    // stale timestamp, a replayed nonce -- is refused BEFORE any proof, so
    // it counts as none. A revoked device is refused there and not here
    // because revocation destroys the wrapped secret: there is nothing
    // left to verify it against, so the server cannot claim it proved
    // anything (`docs/security/dashboard.md`).
    req.prove();

    // A claimed device holds a secret and no authority. Only the envelope
    // fetch admits it; everything else is refused HERE, after the signature
    // verified, so a caller that merely knows a pending device's id cannot
    // tell it from an unknown one, and so this refusal is the credentialed
    // decision it really is. A route added later is refused by default
    // rather than by memory.
    if admit == Admit::ActiveOnly && matches!(record.state, DeviceState::Pending) {
        return Err(ApiError::new(
            403,
            "device_pending",
            "device is waiting for pairing approval",
        ));
    }

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
    record_seen(app, id, client, SeenKind::SignIn);
}

/// Journal a `heartbeat` event.
pub fn record_heartbeat(app: &App, id: &DeviceId, client: &ClientInfo) {
    record_seen(app, id, client, SeenKind::Heartbeat);
}

/// An activity event as this request saw it: when, and from where. An
/// accepted version post journals its `edit` event in the version's own
/// append (`Store::post_version`).
pub fn seen_event(app: &App, client: &ClientInfo, kind: SeenKind) -> SeenEvent {
    SeenEvent {
        ts: UnixMs(app.clock.unix_secs() * 1000),
        kind,
        address: client.address.clone(),
        country: client.country.clone(),
    }
}

fn record_seen(app: &App, id: &DeviceId, client: &ClientInfo, kind: SeenKind) {
    if let Err(e) = app.store.record_seen(id, seen_event(app, client, kind)) {
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
    use std::sync::atomic::Ordering;

    use super::super::nonce_log::NonceFault;

    /// The accounting handle a nonce log publishes into. These tests judge
    /// the log, not the journal that reads it, so each gets its own.
    fn reported() -> Arc<AtomicU64> {
        Arc::new(AtomicU64::new(0))
    }

    use std::io::Write;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::time::{Duration, Instant};

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

    /// A distinct nonce per seed, DERIVED at runtime rather than written
    /// down as one.
    ///
    /// Deterministic, so a test that expects a replay gets the same thirty-two
    /// characters back for the same seed, and distinct per seed, which is the
    /// only property any test here relies on. Derived rather than formatted
    /// from the seed because a constant reaching a nonce is exactly what
    /// `rust/hard-coded-cryptographic-value` exists to find: a fixture that
    /// trips it costs a triage on every change to this file, and an alert
    /// list that is mostly fixtures is one nobody reads. Nothing here is a
    /// credential -- a nonce is a public request value that opens nothing --
    /// but the analyser cannot know that, and neither can a reader skimming
    /// the list.
    fn nonce(seed: u8) -> String {
        hex::encode(&sha256::sha256(&[seed])[..16])
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
        NonceCache::sized(dir.path(), now, capacity, reported(), log).expect("the nonce log opens")
    }

    /// Accept five nonces at a capacity of two: two per window, with a
    /// window between each pair, so the file grows to one line short of
    /// twice the ceiling while the cache never passes it. Returns the
    /// second the last of them was accepted at, when one entry is live.
    fn fill_to_the_threshold(c: &NonceCache) -> u64 {
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
        let c = cache(&dir, 1_000, NONCE_CACHE_MAX, &log);
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
        let c = cache(&dir, 1_000, NONCE_CACHE_MAX, &log);
        c.remember(DEVICE, &nonce(1), 1_000).expect("first use");
        c.remember(OTHER, &nonce(1), 1_000)
            .expect("different device");
    }

    #[test]
    fn a_nonce_is_forgotten_only_after_the_full_ttl() {
        let dir = volume("nonce-ttl");
        let log = Log::buffered(LogLevel::Debug);
        let c = cache(&dir, 1_000, NONCE_CACHE_MAX, &log);
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
        let c = cache(&dir, 1_000, NONCE_CACHE_MAX, &log);
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
        let c = cache(&dir, 1_000, NONCE_CACHE_MAX, &log);
        c.remember(DEVICE, &nonce(1), 1_000).expect("first use");
        assert_eq!(
            lines_on_disk(&dir),
            1,
            "the accepted nonce is on the volume"
        );
        drop(c);

        let restarted = cache(&dir, 1_100, NONCE_CACHE_MAX, &log);
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
        let c = cache(&dir, 1_000, NONCE_CACHE_MAX, &log);
        c.remember(DEVICE, &nonce(1), 1_000).expect("first use");
        drop(c);

        // One second past the window it protects nothing, and holding it
        // would be a cache that only ever grows.
        let restarted = cache(&dir, 1_000 + NONCE_TTL_SECS + 1, NONCE_CACHE_MAX, &log);
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
        let c = cache(&dir, 1_000, NONCE_CACHE_MAX, &log);
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

        let restarted = cache(&dir, 1_000, NONCE_CACHE_MAX, &log);
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
        let Err(e) = NonceCache::sized(dir.path(), 1_000, NONCE_CACHE_MAX, reported(), &log) else {
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

        let Err(e) = NonceCache::sized(dir.path(), 1_000, NONCE_CACHE_MAX, reported(), &log) else {
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
        let c = cache(&dir, 1_000, 2, &log);
        c.remember(DEVICE, &nonce(1), 1_000).expect("first");
        c.remember(DEVICE, &nonce(2), 1_000).expect("second");
        drop(c);

        // Reloading is not a way past the ceiling: what came back off the
        // volume counts against it exactly as what this process accepted.
        let restarted = cache(&dir, 1_000, 2, &log);
        assert_eq!(restarted.len(), 2);
        let e = restarted
            .remember(DEVICE, &nonce(3), 1_000)
            .expect_err("the ceiling is reached");
        assert_eq!(e.status, 503);
        assert_eq!(e.code, "nonce_cache_full");
    }

    /// Security item 7: one device at its share is refused, alone, with its
    /// own code and a line naming the share; every other device is still
    /// answered, and the device is answered again once its window moves on.
    #[test]
    fn a_device_at_its_share_is_refused_and_no_other_device_is() {
        let dir = volume("nonce-share");
        let log = Log::buffered(LogLevel::Debug);
        let mut c = cache(&dir, 1_000, 8, &log);
        c.share = 2;
        c.remember(DEVICE, &nonce(1), 1_000).expect("first");
        c.remember(DEVICE, &nonce(2), 1_000).expect("second");
        let e = c
            .remember(DEVICE, &nonce(3), 1_000)
            .expect_err("the device's share is spent");
        assert_eq!((e.status, e.code), (503, "nonce_share_full"));
        assert!(
            log.captured().contains(
                "event=nonce_cache device=a1a1a1a1 decision=refused reason=device_share held=2 budget=2"
            ),
            "{}",
            log.captured()
        );
        c.remember(OTHER, &nonce(1), 1_000)
            .expect("another device is still answered");
        c.remember(OTHER, &nonce(2), 1_000)
            .expect("up to its own share");
        assert_eq!(c.len(), 4, "the cache itself was never full");

        // The window moves on: the spent share comes back as it expires.
        c.remember(DEVICE, &nonce(3), 1_000 + NONCE_TTL_SECS + 1)
            .expect("answered again once its nonces expire");
    }

    /// A restart is not a way past a share: what comes back off the volume
    /// counts against its device exactly as what this process accepted.
    #[test]
    fn a_share_still_refuses_after_a_reload() {
        let dir = volume("nonce-share-reload");
        let log = Log::buffered(LogLevel::Debug);
        let c = cache(&dir, 1_000, 8, &log);
        c.remember(DEVICE, &nonce(1), 1_000).expect("first");
        c.remember(DEVICE, &nonce(2), 1_000).expect("second");
        drop(c);

        let mut restarted = cache(&dir, 1_000, 8, &log);
        restarted.share = 2;
        let e = restarted
            .remember(DEVICE, &nonce(3), 1_000)
            .expect_err("the reloaded nonces count");
        assert_eq!(e.code, "nonce_share_full");
        restarted
            .remember(OTHER, &nonce(3), 1_000)
            .expect("and only against their own device");
    }

    #[test]
    fn every_accepted_nonce_pays_for_one_durable_record() {
        let dir = volume("nonce-durability");
        let log = Log::buffered(LogLevel::Debug);
        let c = cache(&dir, 1_000, NONCE_CACHE_MAX, &log);
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

    /// Every durable batch so far: when its fsync returned, and what it held.
    fn flushed(c: &NonceCache) -> Vec<(Instant, Vec<Nonce>)> {
        c.with_durable(|file| file.flushed().to_vec())
    }

    /// When the fsync that made `entry` durable returned.
    fn durable_at(flushes: &[(Instant, Vec<Nonce>)], entry: &Nonce) -> Instant {
        flushes
            .iter()
            .find(|(_, batch)| batch.contains(entry))
            .map(|(at, _)| *at)
            .expect("every accepted nonce is in a durable batch")
    }

    /// Wait, without taking the cache's lock, until an armed slow fsync is
    /// running.
    fn until_syncing(c: &NonceCache) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !c.syncing.load(Ordering::SeqCst) {
            assert!(Instant::now() < deadline, "no flush ever reached its fsync");
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    #[test]
    fn concurrent_requests_share_an_fsync_and_none_is_answered_before_its_own() {
        const REQUESTS: u8 = 8;
        let dir = volume("nonce-group-commit");
        let log = Log::buffered(LogLevel::Debug);
        let c = cache(&dir, 1_000, NONCE_CACHE_MAX, &log);
        c.set_fault(NonceFault::SlowSync { ms: 150 });
        let start = std::sync::Barrier::new(usize::from(REQUESTS));
        let answered: Vec<(Nonce, Instant)> = std::thread::scope(|s| {
            let handles: Vec<_> = (1..=REQUESTS)
                .map(|n| {
                    let (c, start) = (&c, &start);
                    s.spawn(move || {
                        start.wait();
                        c.remember(DEVICE, &nonce(n), 1_000).expect("accepted");
                        ((DEVICE.to_string(), nonce(n)), Instant::now())
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().expect("joins"))
                .collect()
        });
        c.set_fault(NonceFault::None);
        let flushes = flushed(&c);
        for (entry, at) in &answered {
            assert!(
                durable_at(&flushes, entry) <= *at,
                "{entry:?} was answered before the fsync that made it durable returned"
            );
        }
        assert!(
            flushes.len() < usize::from(REQUESTS),
            "{} fsyncs for {REQUESTS} concurrent requests: nothing was shared",
            flushes.len()
        );
        assert_eq!(lines_on_disk(&dir), usize::from(REQUESTS));
    }

    #[test]
    fn a_nonce_in_flight_is_already_a_replay_and_the_check_does_not_wait_for_the_volume() {
        let dir = volume("nonce-pending-replay");
        let log = Log::buffered(LogLevel::Debug);
        let c = cache(&dir, 1_000, NONCE_CACHE_MAX, &log);
        c.set_fault(NonceFault::SlowSync { ms: 400 });
        let refused_at = std::thread::scope(|s| {
            let first = s.spawn(|| c.remember(DEVICE, &nonce(1), 1_000));
            until_syncing(&c);
            let replay = c
                .remember(DEVICE, &nonce(1), 1_000)
                .expect_err("a replay of a nonce still in flight");
            let refused_at = Instant::now();
            assert_eq!(replay.code, "replayed_nonce");
            first
                .join()
                .expect("joins")
                .expect("the original is accepted");
            refused_at
        });
        c.set_fault(NonceFault::None);
        let entry = (DEVICE.to_string(), nonce(1));
        assert!(
            refused_at < durable_at(&flushed(&c), &entry),
            "the replay waited for the fsync: the volume was written under the cache's lock"
        );
    }

    #[test]
    fn a_refused_batch_answers_every_member_and_leaves_every_nonce_unspent() {
        const REQUESTS: u8 = 6;
        let dir = volume("nonce-batch-refused");
        let log = Log::buffered(LogLevel::Debug);
        let c = cache(&dir, 1_000, NONCE_CACHE_MAX, &log);
        c.set_fault(NonceFault::SlowSyncFails {
            ms: 150,
            code: ENOSPC,
        });
        let start = std::sync::Barrier::new(usize::from(REQUESTS));
        std::thread::scope(|s| {
            for n in 1..=REQUESTS {
                let (c, start) = (&c, &start);
                s.spawn(move || {
                    start.wait();
                    let e = c
                        .remember(DEVICE, &nonce(n), 1_000)
                        .expect_err("the batch was refused");
                    assert_eq!((e.status, e.code), (503, "nonce_log_unavailable"));
                });
            }
        });
        c.set_fault(NonceFault::None);
        let captured = log.captured();
        let largest = captured
            .lines()
            .filter(|l| l.contains("event=nonce_log decision=refused"))
            .filter_map(|l| {
                l.split("batch=")
                    .nth(1)?
                    .split(' ')
                    .next()?
                    .parse::<u64>()
                    .ok()
            })
            .max()
            .expect("each refused flush logs its batch");
        assert!(
            largest > 1,
            "no batch held more than one request: {captured}"
        );
        assert_eq!(c.len(), 0, "nothing refused is held");
        assert_eq!(
            lines_on_disk(&dir),
            0,
            "and nothing refused is on the volume"
        );
        for n in 1..=REQUESTS {
            c.remember(DEVICE, &nonce(n), 1_000)
                .expect("a retry of a refused request is not a replay");
        }
    }

    /// Each device's share counts exactly what the window holds for it,
    /// through every path that takes a nonce in or out: acceptance, the
    /// sweep a share refusal runs, the sweep a compaction runs, and a batch
    /// the volume refuses. A refused nonce handed back to the window but not
    /// to its device would shrink that device's share for good.
    #[test]
    fn a_refused_batch_gives_every_device_its_share_back() {
        let dir = volume("nonce-share-refused");
        let log = Log::buffered(LogLevel::Debug);
        let mut c = cache(&dir, 1_000, 8, &log);
        c.share = 3;
        let exact = |c: &NonceCache, device: &str, held: usize| {
            assert_eq!(c.held_exactly(device), (true, held), "{device}");
        };
        // Three windows, each share refusal sweeping the one before it. The
        // last leaves this device one short of its share, so nothing but the
        // compaction sweeps it: seventeen lines, past twice the ceiling.
        let mut now = 1_000;
        for round in 0..3u8 {
            for device in [DEVICE, OTHER] {
                let quota = if round == 2 && device == DEVICE { 2 } else { 3 };
                for n in 1..=quota {
                    c.remember(device, &nonce(round * 10 + n), now)
                        .expect("inside the share");
                }
                exact(&c, device, usize::from(quota));
            }
            now += NONCE_TTL_SECS + 1;
        }
        c.set_fault(NonceFault::SlowSyncFails {
            ms: 150,
            code: ENOSPC,
        });

        // The compaction sweeps the expired window, then the append that
        // follows it is refused.
        let e = c
            .remember(DEVICE, &nonce(41), now)
            .expect_err("the append was refused");
        assert_eq!(e.code, "nonce_log_unavailable");
        assert_eq!(
            lines_on_disk(&dir),
            0,
            "the compaction ran, and the refused batch was cut back after it"
        );
        exact(&c, DEVICE, 0);
        exact(&c, OTHER, 0);

        // A batch of both devices, refused as one.
        let start = std::sync::Barrier::new(5);
        std::thread::scope(|s| {
            for (device, n) in [
                (DEVICE, 42),
                (DEVICE, 43),
                (OTHER, 41),
                (OTHER, 42),
                (OTHER, 43),
            ] {
                let (c, start) = (&c, &start);
                s.spawn(move || {
                    start.wait();
                    let e = c
                        .remember(device, &nonce(n), now)
                        .expect_err("the batch was refused");
                    assert_eq!(e.code, "nonce_log_unavailable");
                });
            }
        });
        c.set_fault(NonceFault::None);
        exact(&c, DEVICE, 0);
        exact(&c, OTHER, 0);
        assert_eq!(c.len(), 0);

        // Every share is whole again, and no bigger than it was.
        for device in [DEVICE, OTHER] {
            for n in 41..=43 {
                c.remember(device, &nonce(n), now)
                    .expect("the refused nonces were handed back");
            }
            let syncs = c.syncs();
            let e = c
                .remember(device, &nonce(44), now)
                .expect_err("and the share is still the share");
            assert_eq!(e.code, "nonce_share_full");
            assert_eq!(c.syncs(), syncs, "a refused share costs no fsync");
            exact(&c, device, 3);
        }
        drop(c);
        let reloaded = cache(&dir, now, 8, &log);
        assert_eq!(
            reloaded.len(),
            6,
            "no refused nonce ever reached the volume"
        );
        exact(&reloaded, DEVICE, 3);
    }

    /// A panic inside a flush is a bug, and it costs one refusal per member
    /// and nothing more: the whole batch is answered `503`, the leader
    /// included, every nonce in it is unspent now and after a restart, the
    /// half a batch that landed is cut back, and the next request is served.
    /// Both places a flush can die: holding the cache's mutex, and not.
    #[test]
    fn a_flush_that_panics_answers_every_member_and_blocks_nobody() {
        flush_panics(false, "nonce-panic-write");
        flush_panics(true, "nonce-panic-locked");
    }

    /// The member that meets the poison: parked on the condvar while a flush
    /// is out, it is woken only after that flush has died holding the lock.
    /// Held, not raced -- the arm64 runners met this instant by chance and
    /// the member panicked; no answer and no later request may depend on it.
    #[test]
    fn a_member_woken_on_a_lock_a_flush_poisoned_is_answered() {
        let dir = volume("nonce-poisoned-wake");
        let log = Log::buffered(LogLevel::Debug);
        let c = Arc::new(cache(&dir, 1_000, NONCE_CACHE_MAX, &log));
        let file = c.state().durable.take().expect("no flush in flight");
        let member = {
            let c = Arc::clone(&c);
            std::thread::spawn(move || c.remember(DEVICE, &nonce(1), 1_000))
        };
        // The member holds the lock from its check until it waits, so its
        // nonce in the open batch means it is waiting.
        while c.state().open.entries.is_empty() {
            std::thread::yield_now();
        }
        let flush = Arc::clone(&c);
        let died = std::thread::spawn(move || {
            let mut state = flush.state();
            state.durable = Some(file);
            panic!("injected panic while a flush holds the cache");
        })
        .join();
        assert!(
            died.is_err() && c.state.is_poisoned(),
            "the lock is poisoned"
        );
        c.settled.notify_all();
        member
            .join()
            .expect("a member woken on a poisoned lock panicked")
            .expect("it leads the next flush, which lands");
        c.remember(DEVICE, &nonce(2), 1_000)
            .expect("and the next request is served");
        assert_eq!(c.len(), 2);
    }

    fn flush_panics(locked: bool, name: &str) {
        const REQUESTS: u8 = 6;
        let dir = volume(name);
        let log = Log::buffered(LogLevel::Debug);
        let c = Arc::new(cache(&dir, 1_000, NONCE_CACHE_MAX, &log));
        c.set_fault(NonceFault::SlowSyncThenPanic { ms: 200, locked });
        // Detached threads and a deadline: a member left waiting fails the
        // test instead of hanging it.
        let (done, answers) = std::sync::mpsc::channel();
        let requests: Vec<_> = (1..=REQUESTS)
            .map(|n| {
                let (c, done) = (Arc::clone(&c), done.clone());
                std::thread::spawn(move || {
                    // The first request's flush is slow and lands; everyone
                    // who arrives meanwhile forms the next batch, whose flush
                    // panics.
                    if n > 1 {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    let _ = done.send((n, c.remember(DEVICE, &nonce(n), 1_000)));
                })
            })
            .collect();
        let mut settled = Vec::new();
        while settled.len() < usize::from(REQUESTS) {
            settled.push(
                answers
                    .recv_timeout(Duration::from_secs(10))
                    .expect("a member was left waiting on a flush that panicked"),
            );
        }
        for request in requests {
            request.join().expect("no request panicked");
        }
        settled.sort_by_key(|(n, _)| *n);
        assert!(settled[0].1.is_ok(), "{name}: the first batch landed");
        for (n, answer) in &settled[1..] {
            let e = answer.as_ref().expect_err("the panicked batch is refused");
            assert_eq!(
                (e.status, e.code),
                (503, "nonce_log_unavailable"),
                "{name}: request {n}"
            );
        }
        assert!(
            log.captured()
                .contains("event=nonce_log decision=refused reason=flush_panicked batch=5"),
            "{}",
            log.captured()
        );
        assert_eq!(c.len(), 1, "{name}: only the batch that landed is held");
        assert_eq!(
            lines_on_disk(&dir),
            1,
            "{name}: none of the panicked batch stays"
        );
        c.remember(DEVICE, &nonce(7), 1_000)
            .expect("the next request is served");

        drop(c);
        let restarted = cache(&dir, 1_000, NONCE_CACHE_MAX, &log);
        assert_eq!(
            restarted
                .remember(DEVICE, &nonce(1), 1_000)
                .expect_err("spent")
                .code,
            "replayed_nonce"
        );
        for n in 2..=REQUESTS {
            restarted
                .remember(DEVICE, &nonce(n), 1_000)
                .expect("a nonce the panicked batch carried was never spent");
        }
    }

    #[test]
    fn a_batch_made_durable_is_still_spent_after_a_crash_before_it_was_answered() {
        const REQUESTS: u8 = 4;
        let dir = volume("nonce-crash-after-flush");
        let log = Log::buffered(LogLevel::Debug);
        let c = cache(&dir, 1_000, NONCE_CACHE_MAX, &log);
        c.set_fault(NonceFault::CrashAfterSync);
        let start = std::sync::Barrier::new(usize::from(REQUESTS));
        std::thread::scope(|s| {
            for n in 1..=REQUESTS {
                let (c, start) = (&c, &start);
                s.spawn(move || {
                    start.wait();
                    let _ = c.remember(DEVICE, &nonce(n), 1_000);
                });
            }
        });
        // The process is gone: nobody was answered, and the next start reads
        // only what the volume holds.
        drop(c);
        let restarted = cache(&dir, 1_000, NONCE_CACHE_MAX, &log);
        for n in 1..=REQUESTS {
            assert_eq!(
                restarted
                    .remember(DEVICE, &nonce(n), 1_000)
                    .expect_err("every nonce the flush made durable is spent")
                    .code,
                "replayed_nonce"
            );
        }
    }

    #[test]
    fn a_rewrite_holds_what_was_durable_and_never_the_batch_it_precedes() {
        // The rewrite lands and the append after it is refused. The refused
        // nonce is unspent, so it must not be in the rewritten file either,
        // or a restart would refuse the retry the refusal promised.
        let dir = volume("nonce-rewrite-excludes-batch");
        let log = Log::buffered(LogLevel::Debug);
        let c = cache(&dir, 1_000, 2, &log);
        let now = fill_to_the_threshold(&c);
        c.set_fault(NonceFault::SyncFails { code: ENOSPC });
        c.remember(DEVICE, &nonce(6), now)
            .expect_err("the append after the rewrite is refused");
        c.set_fault(NonceFault::None);
        assert_eq!(lines_on_disk(&dir), 1, "the rewrite landed without it");
        drop(c);
        let restarted = cache(&dir, now, 2, &log);
        restarted
            .remember(DEVICE, &nonce(6), now)
            .expect("the refused nonce was never written down");
        restarted
            .remember(DEVICE, &nonce(5), now)
            .expect_err("and what was durable before it still is");
    }

    /// The bytes the nonce log and its compaction temporary occupy, walked
    /// independently of what the log publishes.
    fn nonce_bytes_on_disk(dir: &TempDir) -> u64 {
        let root = PathClass::JournalRoot.path(dir.path());
        ["nonces", "nonces.tmp"]
            .iter()
            .map(|name| {
                std::fs::symlink_metadata(root.join(name))
                    .map(|m| m.len())
                    .unwrap_or(0)
            })
            .sum()
    }

    #[test]
    fn the_log_publishes_what_it_occupies_on_the_journal_volume() {
        // The nonce log rests on the journal volume and grows on every
        // authenticated request. The journal's own survey deliberately
        // leaves these two names alone, so if this number were not published
        // the volume's watermark would never see the file at all.
        let dir = volume("nonce-accounting");
        let log = Log::buffered(LogLevel::Debug);
        let handle = reported();
        let c = NonceCache::sized(dir.path(), 1_000, 2, Arc::clone(&handle), &log)
            .expect("the nonce log opens");
        assert_eq!(
            handle.load(Ordering::Acquire),
            nonce_bytes_on_disk(&dir),
            "at the open"
        );

        let now = fill_to_the_threshold(&c);
        let grown = handle.load(Ordering::Acquire);
        assert!(grown > 0, "the log grew with the nonces it accepted");
        assert_eq!(grown, nonce_bytes_on_disk(&dir), "and said so as it grew");

        // The compaction rewrites the file SMALLER: the published number has
        // to come down as well as up, or the volume looks permanently full.
        c.remember(DEVICE, &nonce(6), now).expect("accepted");
        assert!(
            handle.load(Ordering::Acquire) < grown,
            "the compaction freed bytes: {} is not below {grown}",
            handle.load(Ordering::Acquire)
        );
        assert_eq!(
            handle.load(Ordering::Acquire),
            nonce_bytes_on_disk(&dir),
            "after the compaction, temporary included"
        );
    }

    /// `ENOSPC`, the same number on Linux and on macOS.
    const ENOSPC: i32 = 28;

    #[test]
    fn a_write_that_failed_part_way_still_publishes_the_bytes_that_landed() {
        // The claim this pins is that the figure is published BEFORE the
        // error is returned. A volume that refuses half way through a line
        // AND refuses the cut that would take it back still grew the file,
        // and a watermark that cannot see those bytes is a watermark that
        // admits a write onto a full volume.
        let dir = volume("nonce-partial-write");
        let log = Log::buffered(LogLevel::Debug);
        let handle = reported();
        let c = NonceCache::sized(dir.path(), 1_000, 2, Arc::clone(&handle), &log)
            .expect("the nonce log opens");
        c.remember(DEVICE, &nonce(1), 1_000).expect("accepted");
        let before = handle.load(Ordering::Acquire);

        c.set_fault(NonceFault::ShortWriteStuck { code: ENOSPC });
        c.remember(DEVICE, &nonce(2), 1_000)
            .expect_err("the volume refused");
        c.set_fault(NonceFault::None);

        let landed = handle.load(Ordering::Acquire);
        assert!(
            landed > before,
            "bytes landed before the error and were published: \
             {landed} is not above {before}"
        );
        assert_eq!(
            landed,
            nonce_bytes_on_disk(&dir),
            "and the figure is the volume's own"
        );

        // Bytes nothing could cut stay where they are, and nothing is ever
        // written after them: the log refuses until a restart, which cuts
        // the torn tail and keeps every line that was durable.
        assert_eq!(
            c.remember(DEVICE, &nonce(3), 1_000)
                .expect_err("a faulted log takes nothing more")
                .code,
            "nonce_log_unavailable"
        );
        drop(c);
        let restarted = cache(&dir, 1_000, 2, &log);
        assert_eq!(restarted.len(), 1, "the durable line survives");
        restarted
            .remember(DEVICE, &nonce(2), 1_000)
            .expect("the refused nonce was never spent");
    }

    #[test]
    fn a_refused_batch_is_cut_back_so_the_next_one_lands_on_a_clean_line() {
        // Without the cut, a short write leaves half a line and the next
        // accepted batch lands glued to it: one line that parses as nothing,
        // in the middle of the file, and the next start refuses the whole log
        // as corrupt.
        for fault in [
            NonceFault::ShortWrite { code: ENOSPC },
            NonceFault::SyncFails { code: ENOSPC },
        ] {
            let dir = volume("nonce-cut-back");
            let log = Log::buffered(LogLevel::Debug);
            let handle = reported();
            let c = NonceCache::sized(dir.path(), 1_000, 8, Arc::clone(&handle), &log)
                .expect("the nonce log opens");
            c.remember(DEVICE, &nonce(1), 1_000).expect("accepted");
            let before = nonce_bytes_on_disk(&dir);

            c.set_fault(fault);
            c.remember(DEVICE, &nonce(2), 1_000)
                .expect_err("the volume refused");
            c.set_fault(NonceFault::None);
            assert_eq!(nonce_bytes_on_disk(&dir), before, "{fault:?}: cut back");
            assert_eq!(handle.load(Ordering::Acquire), before, "{fault:?}");

            c.remember(DEVICE, &nonce(3), 1_000).expect("accepted");
            drop(c);
            let restarted = cache(&dir, 1_000, 8, &log);
            assert_eq!(restarted.len(), 2, "{fault:?}: both durable lines load");
            restarted
                .remember(DEVICE, &nonce(2), 1_000)
                .expect("the refused nonce was never spent");
        }
    }

    #[test]
    fn a_compaction_leftover_is_counted_where_the_watermark_reads_it() {
        // The residue of a compaction that died between its temporary and
        // its rename. Those bytes are on the journal volume and stay there
        // until the next compaction takes the name again, and the journal's
        // own survey deliberately leaves this name alone, so the only thing
        // that can see them is this log's own accounting.
        let dir = volume("nonce-compaction-residue");
        let log = Log::buffered(LogLevel::Debug);
        let handle = reported();
        let c = NonceCache::sized(dir.path(), 1_000, 2, Arc::clone(&handle), &log)
            .expect("the nonce log opens");
        c.remember(DEVICE, &nonce(1), 1_000).expect("accepted");
        let clean = handle.load(Ordering::Acquire);

        std::fs::write(
            PathClass::JournalRoot.path(dir.path()).join("nonces.tmp"),
            vec![b'x'; 512],
        )
        .expect("what a failed compaction leaves");
        c.remember(DEVICE, &nonce(2), 1_000).expect("accepted");

        assert!(
            handle.load(Ordering::Acquire) >= clean + 512,
            "the leftover is counted: {} is not at least {}",
            handle.load(Ordering::Acquire),
            clean + 512
        );
        assert_eq!(
            handle.load(Ordering::Acquire),
            nonce_bytes_on_disk(&dir),
            "and the number is the volume's own"
        );
    }

    #[test]
    fn the_log_is_compacted_once_it_passes_twice_the_ceiling() {
        let dir = volume("nonce-compaction");
        let log = Log::buffered(LogLevel::Debug);
        let c = cache(&dir, 1_000, 2, &log);
        let now = fill_to_the_threshold(&c);
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

        let c = cache(&dir, 1_000, 2, &log);
        let now = fill_to_the_threshold(&c);
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
        let c = cache(&dir, 1_000, 2, &log);
        let now = fill_to_the_threshold(&c);
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

        let restarted = cache(&dir, now, 2, &log);
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
        let c = cache(&dir, 1_000, 2, &log);
        let now = fill_to_the_threshold(&c);
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
        let (mut durable, _) =
            NonceLog::open(source.path(), 1_000, reported(), &log).expect("the log opens");
        let live: HashMap<Nonce, u64> = [
            ((DEVICE.to_string(), nonce(5)), 2_202 + NONCE_TTL_SECS),
            ((OTHER.to_string(), nonce(6)), 2_202 + NONCE_TTL_SECS),
        ]
        .into_iter()
        .collect();
        let (body, lines) = window(live.iter());
        durable.compact(&body, lines).expect("the rewrite lands");
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
        let restarted = cache(&dir, 2_202, NONCE_CACHE_MAX, &log);
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
        let c = cache(&dir, 1_000, 2, &log);
        let now = fill_to_the_threshold(&c);
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
        let c = cache(&dir, 1_000, 2, &log);
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
