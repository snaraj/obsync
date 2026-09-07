//! Per-device HMAC request authentication (`docs/protocol.md`,
//! "Authentication").
//!
//! The window is ±300 s and nonces are remembered for 600 s. Both are
//! constants: no environment variable, build flag, or config field can widen
//! or disable them (AGENTS.md requirement 4 and "Security invariants").
#![forbid(unsafe_code)]

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use obsync_core::hex;
use obsync_core::http::Request;
use obsync_core::{ct, hmac, sha256};

use crate::log::Val;
use crate::storage::types::{DeviceRecord, SeenEvent, SeenKind};
use crate::types::{DeviceId, UnixMs};

use super::edge::ClientInfo;
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

/// Nonces seen inside the replay window, keyed by device and nonce.
pub struct NonceCache {
    seen: HashMap<(String, String), u64>,
}

impl NonceCache {
    /// An empty cache.
    pub fn new() -> Self {
        Self {
            seen: HashMap::new(),
        }
    }

    /// Remember `nonce` for `device`, or report the replay.
    ///
    /// # Errors
    /// `401 replayed_nonce` when the pair is already held, `503
    /// nonce_cache_full` when the cache is at its ceiling: refusing beats
    /// forgetting a nonce that is still inside its window.
    pub fn remember(&mut self, device: &str, nonce: &str, now: u64) -> Result<(), ApiError> {
        let key = (device.to_string(), nonce.to_string());
        if let Some(expiry) = self.seen.get(&key)
            && *expiry > now
        {
            return Err(ApiError::new(
                401,
                "replayed_nonce",
                "nonce was used inside the window",
            ));
        }
        if self.seen.len() >= NONCE_CACHE_MAX {
            self.sweep(now);
        }
        if self.seen.len() >= NONCE_CACHE_MAX {
            return Err(ApiError::new(
                503,
                "nonce_cache_full",
                "replay cache is full; retry shortly",
            ));
        }
        self.seen.insert(key, now + NONCE_TTL_SECS);
        Ok(())
    }

    /// Drop expired entries, returning how many went.
    pub fn sweep(&mut self, now: u64) -> usize {
        let before = self.seen.len();
        self.seen.retain(|_, expiry| *expiry > now);
        before - self.seen.len()
    }

    /// How many nonces are held.
    pub fn len(&self) -> usize {
        self.seen.len()
    }

    /// Whether the cache holds nothing.
    pub fn is_empty(&self) -> bool {
        self.seen.is_empty()
    }
}

impl Default for NonceCache {
    fn default() -> Self {
        Self::new()
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
/// device_revoked`.
pub fn device(app: &App, req: &mut Request, client: &ClientInfo) -> Result<Authed, ApiError> {
    authenticate(app, req, client, &BodyHash::Buffer)
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
    authenticate(app, req, client, &BodyHash::Sid(sid))
}

fn authenticate(
    app: &App,
    req: &mut Request,
    client: &ClientInfo,
    body_hash: &BodyHash<'_>,
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
    if record.revoked {
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

    record_sign_in(app, &id, client, now);
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
        app.log.warn(
            "seen_event_dropped",
            &[
                ("kind", Val::word(kind.as_word())),
                ("decision", Val::word(e.code())),
            ],
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn a_nonce_is_refused_a_second_time_inside_the_window() {
        let mut cache = NonceCache::new();
        cache.remember("dev", "n1", 1_000).expect("first use");
        let e = cache.remember("dev", "n1", 1_000).expect_err("replay");
        assert_eq!(e.status, 401);
        assert_eq!(e.code, "replayed_nonce");
    }

    #[test]
    fn the_same_nonce_from_another_device_is_not_a_replay() {
        let mut cache = NonceCache::new();
        cache.remember("dev_a", "n1", 1_000).expect("first use");
        cache
            .remember("dev_b", "n1", 1_000)
            .expect("different device");
    }

    #[test]
    fn a_nonce_is_forgotten_only_after_the_full_ttl() {
        let mut cache = NonceCache::new();
        cache.remember("dev", "n1", 1_000).expect("first use");
        assert!(
            cache
                .remember("dev", "n1", 1_000 + NONCE_TTL_SECS - 1)
                .is_err(),
            "a nonce inside the ttl is still a replay"
        );
        cache.sweep(1_000 + NONCE_TTL_SECS + 1);
        assert!(cache.is_empty());
        cache
            .remember("dev", "n1", 1_000 + NONCE_TTL_SECS + 1)
            .expect("outside the ttl");
    }

    #[test]
    fn sweeping_keeps_live_entries_and_drops_expired_ones() {
        let mut cache = NonceCache::new();
        cache.remember("dev", "old", 1_000).expect("first");
        cache.remember("dev", "new", 1_400).expect("second");
        let dropped = cache.sweep(1_700);
        assert_eq!(dropped, 1);
        assert_eq!(cache.len(), 1);
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
