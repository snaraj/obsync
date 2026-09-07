//! Device pairing (`docs/protocol.md`, "Pairing"; `docs/architecture.md` 4.2).
//!
//! Pairings live in memory only (`docs/storage.md`, "Journal frames"): a
//! restart cancels an in-flight pairing, which is the safe direction. The
//! table below is the whole state machine, so every transition and every
//! wrong-actor case is unit-testable without a store or a socket.
#![forbid(unsafe_code)]

use std::collections::HashMap;

use obsync_core::ct;
use obsync_core::http::{Request, Response};
use obsync_core::json::{Value, obj};

use crate::storage::types::{DevicePolicy, NewDevice};
use crate::types::DeviceId;

use super::edge::ClientInfo;
use super::render::{self, b, n, s};
use super::{ApiError, App, auth, rand};

/// A pairing is claimable for ten minutes and no longer
/// (`docs/architecture.md` 4.2).
pub const PAIRING_TTL_SECS: u64 = 600;

/// Platforms a claiming device may declare (`docs/protocol.md`, "Pairing").
pub const PLATFORMS: [&str; 6] = ["ios", "ipados", "android", "macos", "windows", "linux"];

/// Where a pairing is in its life.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    /// Created, waiting for a device to claim it.
    Open,
    /// Claimed by a device that now holds a secret but no vault key.
    Claimed,
    /// The creator posted the key envelope.
    Approved,
    /// The claimant fetched the envelope; it is gone.
    Consumed,
    /// The ten minutes elapsed.
    Expired,
}

impl State {
    /// Wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            State::Open => "open",
            State::Claimed => "claimed",
            State::Approved => "approved",
            State::Consumed => "consumed",
            State::Expired => "expired",
        }
    }
}

/// What the creator is shown about the device asking to join.
#[derive(Clone, Debug)]
pub struct Claimant {
    /// The device the claim created.
    pub device_id: DeviceId,
    /// Device name as the claimant reported it.
    pub name: String,
    /// Obsidian platform.
    pub platform: String,
    /// Plugin version.
    pub app_version: String,
}

/// One pairing.
#[derive(Clone, Debug)]
pub struct Pairing {
    /// The paired device that opened it; the only actor allowed to poll,
    /// approve, or reject.
    pub creator: DeviceId,
    /// The token the claiming device must present. Never logged.
    pub enroll_token: String,
    /// Unix seconds at which the pairing stops being claimable.
    pub expires: u64,
    /// Current state.
    pub state: State,
    /// The claiming device, once one has claimed.
    pub claimant: Option<Claimant>,
    /// The key envelope and its nonce, held for exactly one fetch.
    pub envelope: Option<(String, String)>,
}

/// The in-memory pairing table.
pub struct PairingTable {
    entries: HashMap<String, Pairing>,
}

impl Default for PairingTable {
    fn default() -> Self {
        Self::new()
    }
}

impl PairingTable {
    /// An empty table.
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    /// Open a pairing. Returns the expiry in unix seconds.
    pub fn create(&mut self, id: &str, creator: DeviceId, token: &str, now: u64) -> u64 {
        let expires = now + PAIRING_TTL_SECS;
        self.entries.insert(
            id.to_string(),
            Pairing {
                creator,
                enroll_token: token.to_string(),
                expires,
                state: State::Open,
                claimant: None,
                envelope: None,
            },
        );
        expires
    }

    /// How many pairings are held.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the table holds nothing.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Forget pairings whose ten minutes have passed, returning how many went.
    pub fn sweep(&mut self, now: u64) -> usize {
        let before = self.entries.len();
        self.entries.retain(|_, p| p.expires > now);
        before - self.entries.len()
    }

    /// The creator's view.
    ///
    /// # Errors
    /// `404 unknown_pairing`, `403 not_creator`.
    pub fn state_for(
        &self,
        id: &str,
        actor: &DeviceId,
        now: u64,
    ) -> Result<(State, Option<Claimant>), ApiError> {
        let p = self.entries.get(id).ok_or_else(unknown)?;
        if &p.creator != actor {
            return Err(not_creator());
        }
        let state = if p.expires <= now && !matches!(p.state, State::Consumed) {
            State::Expired
        } else {
            p.state
        };
        Ok((state, p.claimant.clone()))
    }

    /// Check that a claim may proceed: the token matches, the pairing is live,
    /// and nobody has claimed it yet. The caller creates the device and then
    /// calls [`PairingTable::finish_claim`] under the same lock.
    ///
    /// # Errors
    /// `404 unknown_pairing`, `410 pairing_expired`, `409 already_claimed`.
    pub fn begin_claim(&self, id: &str, token: &str, now: u64) -> Result<(), ApiError> {
        let p = self.entries.get(id).ok_or_else(unknown)?;
        if !ct::eq(p.enroll_token.as_bytes(), token.as_bytes()) {
            return Err(unknown());
        }
        if p.expires <= now {
            return Err(ApiError::new(
                410,
                "pairing_expired",
                "the pairing has expired",
            ));
        }
        if p.state != State::Open {
            return Err(ApiError::new(
                409,
                "already_claimed",
                "the pairing is already claimed",
            ));
        }
        Ok(())
    }

    /// Record the device a claim created.
    pub fn finish_claim(&mut self, id: &str, claimant: Claimant) {
        if let Some(p) = self.entries.get_mut(id) {
            p.claimant = Some(claimant);
            p.state = State::Claimed;
        }
    }

    /// The creator posts the key envelope for a claimed pairing.
    ///
    /// # Errors
    /// `404 unknown_pairing`, `403 not_creator`, `410 pairing_expired`,
    /// `409 not_claimed`, `409 already_approved`.
    pub fn approve(
        &mut self,
        id: &str,
        actor: &DeviceId,
        envelope: &str,
        nonce: &str,
        now: u64,
    ) -> Result<(), ApiError> {
        let p = self.entries.get_mut(id).ok_or_else(unknown)?;
        if &p.creator != actor {
            return Err(not_creator());
        }
        if p.expires <= now {
            return Err(ApiError::new(
                410,
                "pairing_expired",
                "the pairing has expired",
            ));
        }
        match p.state {
            State::Claimed => {}
            State::Open => {
                return Err(ApiError::new(
                    409,
                    "not_claimed",
                    "no device has claimed the pairing",
                ));
            }
            _ => {
                return Err(ApiError::new(
                    409,
                    "already_approved",
                    "the pairing is already approved",
                ));
            }
        }
        p.envelope = Some((envelope.to_string(), nonce.to_string()));
        p.state = State::Approved;
        Ok(())
    }

    /// The creator rejects the claimant. Returns the device to delete.
    ///
    /// # Errors
    /// `404 unknown_pairing`, `403 not_creator`, `409 not_claimed`.
    pub fn reject(&mut self, id: &str, actor: &DeviceId) -> Result<DeviceId, ApiError> {
        let p = self.entries.get(id).ok_or_else(unknown)?;
        if &p.creator != actor {
            return Err(not_creator());
        }
        let claimant = p
            .claimant
            .as_ref()
            .ok_or_else(|| ApiError::new(409, "not_claimed", "no device has claimed the pairing"))?
            .device_id;
        self.entries.remove(id);
        Ok(claimant)
    }

    /// The claimant fetches the envelope, exactly once.
    ///
    /// # Errors
    /// `404 unknown_pairing`, `403 not_claimant`, `409 not_approved`,
    /// `410 envelope_consumed`.
    pub fn take_envelope(
        &mut self,
        id: &str,
        actor: &DeviceId,
    ) -> Result<(String, String), ApiError> {
        let p = self.entries.get_mut(id).ok_or_else(unknown)?;
        let is_claimant = p.claimant.as_ref().is_some_and(|c| &c.device_id == actor);
        if !is_claimant {
            return Err(ApiError::new(
                403,
                "not_claimant",
                "only the claiming device may fetch",
            ));
        }
        match p.state {
            State::Approved => {}
            State::Consumed => {
                return Err(ApiError::new(
                    410,
                    "envelope_consumed",
                    "the envelope was already taken",
                ));
            }
            _ => {
                return Err(ApiError::new(
                    409,
                    "not_approved",
                    "the pairing is not approved yet",
                ));
            }
        }
        let envelope = p.envelope.take().ok_or_else(|| {
            ApiError::new(410, "envelope_consumed", "the envelope was already taken")
        })?;
        p.state = State::Consumed;
        Ok(envelope)
    }
}

fn unknown() -> ApiError {
    ApiError::new(404, "unknown_pairing", "no such pairing")
}

fn not_creator() -> ApiError {
    ApiError::new(403, "not_creator", "only the pairing's creator may do this")
}

/// `POST /v1/pairing`: a paired device opens a pairing.
///
/// # Errors
/// The device-authentication refusals, or `500 no_randomness`.
pub fn create(app: &App, req: &mut Request, client: &ClientInfo) -> Result<Response, ApiError> {
    let authed = auth::device(app, req, client)?;
    let id = token(16)?;
    let enroll = token(32)?;
    let now = app.clock.unix_secs();
    let expires = app
        .pairings
        .lock()
        .expect("pairings")
        .create(&id, authed.id, &enroll, now);
    Ok(Response::json(
        201,
        &obj(vec![
            ("pairing_id", s(&id)),
            ("enroll_token", s(&enroll)),
            ("expires", n(expires)),
        ]),
    ))
}

/// `POST /v1/pairing/{id}/claim`: the new device claims the pairing with the
/// enrollment token. Unauthenticated by design: the token is the credential.
///
/// # Errors
/// `400 bad_request`, `404 unknown_pairing`, `410 pairing_expired`,
/// `409 already_claimed`.
pub fn claim(
    app: &App,
    req: &mut Request,
    _client: &ClientInfo,
    id: &str,
) -> Result<Response, ApiError> {
    let body = render::json_body(req)?;
    let enroll = render::field_str(&body, "enroll_token")?.to_string();
    let name = render::text_field(render::field_str(&body, "name")?, "name", 64)?;
    let platform = render::field_str(&body, "platform")?.to_string();
    let app_version =
        render::text_field(render::field_str(&body, "app_version")?, "app_version", 32)?;
    if !PLATFORMS.contains(&platform.as_str()) {
        return Err(ApiError::bad_request(
            "platform is not one of the supported platforms",
        ));
    }
    let now = app.clock.unix_secs();

    // The table lock is held across device creation so two racing claims
    // cannot both pass `begin_claim`.
    let mut pairings = app.pairings.lock().expect("pairings");
    pairings.begin_claim(id, &enroll, now)?;
    let record = app.store.create_device(NewDevice {
        name: name.clone(),
        platform: platform.clone(),
        app_version: app_version.clone(),
        policy: DevicePolicy {
            per_file_max_bytes: 0,
            total_budget_bytes: 0,
        },
    })?;
    let secret = app
        .store
        .device_secret(&record.device_id)
        .ok_or_else(|| ApiError::new(500, "device_secret_missing", "device secret unavailable"))?;
    pairings.finish_claim(
        id,
        Claimant {
            device_id: record.device_id,
            name,
            platform,
            app_version,
        },
    );
    drop(pairings);

    Ok(Response::json(
        201,
        &obj(vec![
            ("device_id", s(&record.device_id.to_string())),
            ("device_secret", s(&obsync_core::hex::encode(&secret))),
        ]),
    ))
}

/// `GET /v1/pairing/{id}`: the creator polls for a claimant.
///
/// # Errors
/// `404 unknown_pairing`, `403 not_creator`.
pub fn state(
    app: &App,
    req: &mut Request,
    client: &ClientInfo,
    id: &str,
) -> Result<Response, ApiError> {
    let authed = auth::device(app, req, client)?;
    let now = app.clock.unix_secs();
    let (state, claimant) = app
        .pairings
        .lock()
        .expect("pairings")
        .state_for(id, &authed.id, now)?;
    let claimant = match claimant {
        Some(c) => obj(vec![
            ("device_id", s(&c.device_id.to_string())),
            ("name", s(&c.name)),
            ("platform", s(&c.platform)),
            ("app_version", s(&c.app_version)),
        ]),
        None => Value::Null,
    };
    Ok(Response::json(
        200,
        &obj(vec![("state", s(state.as_str())), ("claimant", claimant)]),
    ))
}

/// `POST /v1/pairing/{id}/approve`: the creator posts the key envelope.
///
/// # Errors
/// `400 bad_request`, `404 unknown_pairing`, `403 not_creator`,
/// `409 not_claimed`, `409 already_approved`, `410 pairing_expired`.
pub fn approve(
    app: &App,
    req: &mut Request,
    client: &ClientInfo,
    id: &str,
) -> Result<Response, ApiError> {
    let authed = auth::device(app, req, client)?;
    let body = render::parse_json(&authed.body)?;
    let envelope = render::field_str(&body, "envelope")?;
    let nonce = render::field_str(&body, "nonce")?;
    if envelope.is_empty() || envelope.len() > 8192 {
        return Err(ApiError::bad_request(
            "envelope must be 1..8192 characters of base64",
        ));
    }
    if !super::is_hex(nonce, 24) {
        return Err(ApiError::bad_request("nonce must be 24 hex characters"));
    }
    let now = app.clock.unix_secs();
    app.pairings
        .lock()
        .expect("pairings")
        .approve(id, &authed.id, envelope, nonce, now)?;
    Ok(Response::empty(204))
}

/// `POST /v1/pairing/{id}/reject`: the creator refuses; the claimant device is
/// deleted, so its secret stops working immediately.
///
/// # Errors
/// `404 unknown_pairing`, `403 not_creator`, `409 not_claimed`.
pub fn reject(
    app: &App,
    req: &mut Request,
    client: &ClientInfo,
    id: &str,
) -> Result<Response, ApiError> {
    let authed = auth::device(app, req, client)?;
    let claimant = app
        .pairings
        .lock()
        .expect("pairings")
        .reject(id, &authed.id)?;
    app.store.delete_device(&claimant)?;
    app.log
        .info("pairing_rejected", &[("device", &claimant.to_string())]);
    Ok(Response::empty(204))
}

/// `GET /v1/pairing/{id}/envelope`: the claimant fetches the key envelope,
/// exactly once.
///
/// # Errors
/// `404 unknown_pairing`, `403 not_claimant`, `409 not_approved`,
/// `410 envelope_consumed`.
pub fn envelope(
    app: &App,
    req: &mut Request,
    client: &ClientInfo,
    id: &str,
) -> Result<Response, ApiError> {
    let authed = auth::device(app, req, client)?;
    let (envelope, nonce) = app
        .pairings
        .lock()
        .expect("pairings")
        .take_envelope(id, &authed.id)?;
    Ok(Response::json(
        200,
        &obj(vec![("envelope", s(&envelope)), ("nonce", s(&nonce))]),
    ))
}

fn token(bytes: usize) -> Result<String, ApiError> {
    rand::hex_token(bytes)
        .map_err(|_| ApiError::new(500, "no_randomness", "the system CSPRNG is unavailable"))
}

/// A distinct device id for the tests below, built the way the wire does.
#[cfg(test)]
fn dev(byte: u8) -> DeviceId {
    format!("{byte:02x}").repeat(16).parse().expect("device id")
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_757_200_000;

    fn table() -> (PairingTable, DeviceId) {
        let mut t = PairingTable::new();
        let creator = dev(1);
        t.create("p1", creator, "tok", NOW);
        (t, creator)
    }

    fn claimed() -> (PairingTable, DeviceId, DeviceId) {
        let (mut t, creator) = table();
        t.begin_claim("p1", "tok", NOW).expect("claimable");
        let claimant = dev(2);
        t.finish_claim(
            "p1",
            Claimant {
                device_id: claimant,
                name: "phone".to_string(),
                platform: "ios".to_string(),
                app_version: "0.1.0".to_string(),
            },
        );
        (t, creator, claimant)
    }

    #[test]
    fn a_fresh_pairing_is_open_to_its_creator_only() {
        let (t, creator) = table();
        let (state, claimant) = t.state_for("p1", &creator, NOW).expect("creator sees it");
        assert_eq!(state, State::Open);
        assert!(claimant.is_none());
        let e = t
            .state_for("p1", &dev(9), NOW)
            .expect_err("a stranger does not");
        assert_eq!(e.code, "not_creator");
        assert_eq!(e.status, 403);
    }

    #[test]
    fn an_unknown_pairing_is_a_404() {
        let (t, creator) = table();
        assert_eq!(
            t.state_for("nope", &creator, NOW)
                .expect_err("unknown")
                .code,
            "unknown_pairing"
        );
        assert_eq!(
            t.begin_claim("nope", "tok", NOW).expect_err("unknown").code,
            "unknown_pairing"
        );
    }

    #[test]
    fn the_wrong_enrollment_token_is_indistinguishable_from_an_unknown_pairing() {
        let (t, _) = table();
        let e = t.begin_claim("p1", "wrong", NOW).expect_err("refused");
        assert_eq!(e.status, 404);
        assert_eq!(e.code, "unknown_pairing");
    }

    #[test]
    fn a_claim_after_ten_minutes_is_expired() {
        let (t, _) = table();
        let e = t
            .begin_claim("p1", "tok", NOW + PAIRING_TTL_SECS)
            .expect_err("expired");
        assert_eq!(e.status, 410);
        assert_eq!(e.code, "pairing_expired");
    }

    #[test]
    fn a_second_claim_is_refused() {
        let (t, _, _) = claimed();
        let e = t
            .begin_claim("p1", "tok", NOW)
            .expect_err("already claimed");
        assert_eq!(e.status, 409);
        assert_eq!(e.code, "already_claimed");
    }

    #[test]
    fn the_creator_sees_the_claimant_after_a_claim() {
        let (t, creator, claimant) = claimed();
        let (state, seen) = t.state_for("p1", &creator, NOW).expect("creator sees it");
        assert_eq!(state, State::Claimed);
        assert_eq!(seen.expect("claimant").device_id, claimant);
    }

    #[test]
    fn approve_requires_a_claim_and_the_creator() {
        let (mut t, creator) = table();
        assert_eq!(
            t.approve("p1", &creator, "ct", "aa", NOW)
                .expect_err("no claim")
                .code,
            "not_claimed"
        );
        let (mut t, creator, claimant) = claimed();
        assert_eq!(
            t.approve("p1", &claimant, "ct", "aa", NOW)
                .expect_err("wrong actor")
                .code,
            "not_creator"
        );
        t.approve("p1", &creator, "ct", "aa", NOW)
            .expect("creator approves");
        assert_eq!(
            t.state_for("p1", &creator, NOW).expect("state").0,
            State::Approved
        );
        assert_eq!(
            t.approve("p1", &creator, "ct", "aa", NOW)
                .expect_err("twice")
                .code,
            "already_approved"
        );
    }

    #[test]
    fn approve_after_expiry_is_refused() {
        let (mut t, creator, _) = claimed();
        let e = t
            .approve("p1", &creator, "ct", "aa", NOW + PAIRING_TTL_SECS)
            .expect_err("expired");
        assert_eq!(e.code, "pairing_expired");
    }

    #[test]
    fn the_envelope_is_served_exactly_once_and_only_to_the_claimant() {
        let (mut t, creator, claimant) = claimed();
        assert_eq!(
            t.take_envelope("p1", &claimant)
                .expect_err("not approved yet")
                .code,
            "not_approved"
        );
        t.approve("p1", &creator, "ct", "aa", NOW)
            .expect("approved");
        assert_eq!(
            t.take_envelope("p1", &creator)
                .expect_err("creator is not the claimant")
                .code,
            "not_claimant"
        );
        let (env, nonce) = t.take_envelope("p1", &claimant).expect("first fetch");
        assert_eq!((env.as_str(), nonce.as_str()), ("ct", "aa"));
        let e = t.take_envelope("p1", &claimant).expect_err("second fetch");
        assert_eq!(e.status, 410);
        assert_eq!(e.code, "envelope_consumed");
    }

    #[test]
    fn an_unrelated_device_cannot_fetch_the_envelope() {
        let (mut t, creator, _) = claimed();
        t.approve("p1", &creator, "ct", "aa", NOW)
            .expect("approved");
        assert_eq!(
            t.take_envelope("p1", &dev(9)).expect_err("stranger").code,
            "not_claimant"
        );
    }

    #[test]
    fn reject_names_the_device_to_delete_and_forgets_the_pairing() {
        let (mut t, creator, claimant) = claimed();
        assert_eq!(
            t.reject("p1", &dev(9)).expect_err("stranger").code,
            "not_creator"
        );
        assert_eq!(t.reject("p1", &creator).expect("rejected"), claimant);
        assert_eq!(
            t.state_for("p1", &creator, NOW).expect_err("gone").code,
            "unknown_pairing"
        );
    }

    #[test]
    fn reject_without_a_claim_is_refused() {
        let (mut t, creator) = table();
        assert_eq!(
            t.reject("p1", &creator).expect_err("no claim").code,
            "not_claimed"
        );
    }

    #[test]
    fn an_expired_pairing_reads_as_expired_and_sweeps_away() {
        let (mut t, creator) = table();
        let (state, _) = t
            .state_for("p1", &creator, NOW + PAIRING_TTL_SECS)
            .expect("state");
        assert_eq!(state, State::Expired);
        assert_eq!(t.sweep(NOW + 1), 0, "a live pairing is kept");
        assert_eq!(t.sweep(NOW + PAIRING_TTL_SECS), 1);
        assert!(t.is_empty());
    }

    #[test]
    fn a_consumed_pairing_does_not_flip_back_to_expired() {
        let (mut t, creator, claimant) = claimed();
        t.approve("p1", &creator, "ct", "aa", NOW)
            .expect("approved");
        t.take_envelope("p1", &claimant).expect("fetched");
        let (state, _) = t
            .state_for("p1", &creator, NOW + PAIRING_TTL_SECS)
            .expect("state");
        assert_eq!(state, State::Consumed);
    }
}
