//! Device pairing (`docs/protocol.md`, "Pairing"; `docs/architecture.md` 4.2).
//!
//! Pairings live in memory only (`docs/storage.md`, "Journal frames"): a
//! restart cancels an in-flight pairing, which is the safe direction. The
//! device a claim creates is journaled, though, so cancelling the pairing is
//! only half of it: `App::reconcile_pending` destroys every pending device
//! this table is no longer holding. The table below is the whole state
//! machine, so every transition and every wrong-actor case is unit-testable
//! without a store or a socket.
#![forbid(unsafe_code)]

use std::collections::HashMap;

use obsync_core::ct;
use obsync_core::http::{Request, Response};
use obsync_core::json::{Value, obj};

use crate::log::Val;
use crate::storage::types::DeviceState;
use crate::types::DeviceId;

use super::edge::ClientInfo;
use super::render::{self, n, s};
use super::unverified::{self, Credential};
use super::{ApiError, App, auth, devices, rand};

/// A pairing is claimable for ten minutes and no longer
/// (`docs/architecture.md` 4.2).
pub const PAIRING_TTL_SECS: u64 = 600;

/// How long an expired pairing still answers a late claim with `410
/// pairing_expired` instead of `404 unknown_pairing` (issue #154).
pub const ENDED_KEPT_SECS: u64 = 3600;

/// The most expired pairings remembered at once; the oldest go first. It is
/// what bounds the memory: a paired device can open pairings in a loop.
pub const ENDED_KEPT_MAX: usize = 256;

/// What one [`PairingTable::sweep`] removed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Swept {
    /// How many pairings were forgotten.
    pub pairings: usize,
    /// Devices those pairings claimed that never collected the key, with the
    /// state the pairing ended in. Each is still PENDING -- collection is
    /// what activates -- and the caller deletes it; leaving it would leave a
    /// live credential behind an expired pairing.
    pub orphans: Vec<(DeviceId, State)>,
}

/// What an expired pairing leaves: enough to tell a late claim from a
/// mistyped code, and a creator's last poll from a stranger's.
#[derive(Clone, Debug)]
struct Ended {
    creator: DeviceId,
    enroll_token: String,
    expires: u64,
    consumed: bool,
}

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
    /// Optional sealed claimant vault details; the server cannot decrypt them.
    pub vault: Option<Value>,
    /// The claimant's ephemeral P-256 public key for pairing v2, as the
    /// base64url text the client sent. The server stores and returns it
    /// verbatim and does no EC math on it (`docs/protocol.md`, "Pairing").
    pub claimant_pub: Option<String>,
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
    /// The creator's ephemeral P-256 public key for pairing v2, posted with
    /// the envelope and returned with it, verbatim. `None` for a legacy pairing.
    pub creator_pub: Option<String>,
}

/// The in-memory pairing table.
pub struct PairingTable {
    entries: HashMap<String, Pairing>,
    ended: HashMap<String, Ended>,
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
            ended: HashMap::new(),
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
                creator_pub: None,
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

    /// Forget pairings whose ten minutes have passed.
    ///
    /// An expired pairing whose claimant never collected the key -- claimed
    /// and unapproved, or approved and never fetched -- leaves a device that
    /// holds no vault key. It is still pending, because collection is what
    /// activates ([`PairingTable::take_envelope`]), and its id comes back in
    /// [`Swept::orphans`] so the caller deletes it: expiry must destroy the
    /// device and its wrapped secret, or the claim would outlive the pairing
    /// that granted it (`docs/architecture.md` 4.2; issue #153).
    ///
    /// What is forgotten is remembered as ENDED for [`ENDED_KEPT_SECS`], at
    /// most [`ENDED_KEPT_MAX`] of them, so a late claim reads as expired and a
    /// creator still polling reads how it ended (issue #154).
    pub fn sweep(&mut self, now: u64) -> Swept {
        let mut swept = Swept::default();
        let ended = &mut self.ended;
        self.entries.retain(|id, p| {
            if p.expires > now {
                return true;
            }
            swept.pairings += 1;
            if matches!(p.state, State::Claimed | State::Approved)
                && let Some(claimant) = &p.claimant
            {
                swept.orphans.push((claimant.device_id, p.state));
            }
            ended.insert(
                id.clone(),
                Ended {
                    creator: p.creator,
                    enroll_token: std::mem::take(&mut p.enroll_token),
                    expires: p.expires,
                    consumed: p.state == State::Consumed,
                },
            );
            false
        });
        self.ended
            .retain(|_, e| e.expires.saturating_add(ENDED_KEPT_SECS) > now);
        if self.ended.len() > ENDED_KEPT_MAX {
            let mut newest: Vec<(String, Ended)> = self.ended.drain().collect();
            newest.sort_by_key(|(_, e)| std::cmp::Reverse(e.expires));
            newest.truncate(ENDED_KEPT_MAX);
            self.ended = newest.into_iter().collect();
        }
        swept
    }

    /// Whether a pairing is still holding this device as its claimant.
    ///
    /// A pending device with no pairing behind it is one nobody can approve:
    /// the table is the only place a claim exists, and it does not survive a
    /// restart (`App::reconcile_pending`).
    pub fn holds(&self, device: &DeviceId) -> bool {
        self.entries
            .values()
            .any(|p| p.claimant.as_ref().is_some_and(|c| &c.device_id == device))
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
        let Some(p) = self.entries.get(id) else {
            // Swept: the creator still learns how it ended, which is the one
            // thing it polls for after approving.
            let e = self.ended.get(id).ok_or_else(unknown)?;
            if &e.creator != actor {
                return Err(not_creator());
            }
            let state = if e.consumed {
                State::Consumed
            } else {
                State::Expired
            };
            return Ok((state, None));
        };
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
    /// calls [`PairingTable::finish_claim`] under the same lock. It takes the
    /// token as a [`Credential`], so it runs only inside `accept`, on the
    /// claim's body whose reservation is held.
    ///
    /// # Errors
    /// `404 unknown_pairing`, `410 pairing_expired`, `409 already_claimed`.
    pub fn begin_claim(&self, id: &str, token: &Credential, now: u64) -> Result<(), ApiError> {
        let token = token.as_str();
        let Some(p) = self.entries.get(id) else {
            // A code that expired is not a mistyped one, and says so -- but
            // only to a caller holding its token, so a stranger probing ids
            // learns nothing a live pairing would not tell it (issue #154).
            return Err(match self.ended.get(id) {
                Some(e) if ct::eq(e.enroll_token.as_bytes(), token.as_bytes()) => expired(),
                _ => unknown(),
            });
        };
        if !ct::eq(p.enroll_token.as_bytes(), token.as_bytes()) {
            return Err(unknown());
        }
        if p.expires <= now {
            return Err(expired());
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
        creator_pub: Option<&str>,
        now: u64,
    ) -> Result<DeviceId, ApiError> {
        let p = self.entries.get_mut(id).ok_or_else(unknown)?;
        if &p.creator != actor {
            return Err(not_creator());
        }
        if p.expires <= now {
            return Err(expired());
        }
        match p.state {
            State::Claimed => {}
            State::Open => return Err(not_claimed()),
            _ => return Err(already_approved()),
        }
        let claimant = p
            .claimant
            .as_ref()
            .expect("a claimed pairing has one")
            .device_id;
        p.envelope = Some((envelope.to_string(), nonce.to_string()));
        p.creator_pub = creator_pub.map(str::to_string);
        p.state = State::Approved;
        Ok(claimant)
    }

    /// The creator rejects the claimant. Returns the device to delete.
    ///
    /// ONLY A CLAIMED PAIRING. Rejection exists to destroy a device nobody
    /// approved, and the caller acts on the answer by DELETING that device.
    /// Approval is the moment the claimant stops being a claim and becomes a
    /// paired device holding the vault key, so a reject that still answered
    /// after it would delete a live device on a second click of a screen the
    /// creator had already answered -- silently, because deletion is not
    /// revocation and carries no last-active guard (issue #88). An approved
    /// pairing therefore refuses by name, and taking a paired device away is
    /// `POST /v1/devices/{id}/revoke`, which refuses the last active one.
    ///
    /// # Errors
    /// `404 unknown_pairing`, `403 not_creator`, `409 not_claimed`,
    /// `409 already_approved`.
    pub fn reject(&mut self, id: &str, actor: &DeviceId) -> Result<DeviceId, ApiError> {
        let p = self.entries.get(id).ok_or_else(unknown)?;
        if &p.creator != actor {
            return Err(not_creator());
        }
        match p.state {
            State::Claimed => {}
            State::Open => return Err(not_claimed()),
            _ => return Err(already_approved()),
        }
        let claimant = p
            .claimant
            .as_ref()
            .expect("a claimed pairing has one")
            .device_id;
        self.entries.remove(id);
        Ok(claimant)
    }

    /// The claimant fetches the envelope, exactly once, and inside the ten
    /// minutes.
    ///
    /// COLLECTION IS WHAT ACTIVATES (issue #153). `activate` runs after every
    /// check and before the envelope leaves the table, and a refusal from it
    /// consumes nothing. An approved device that never collects therefore
    /// stays pending -- no authority, and destroyed by the sweep or by a
    /// restart like any other claim -- where activating at approval left an
    /// active device with no vault key whenever the claimant's dialog closed
    /// first.
    ///
    /// # Errors
    /// `404 unknown_pairing`, `403 not_claimant`, `409 not_approved`,
    /// `410 envelope_consumed`, `410 pairing_expired`, or `activate`'s own.
    pub fn take_envelope(
        &mut self,
        id: &str,
        actor: &DeviceId,
        now: u64,
        activate: impl FnOnce() -> Result<(), ApiError>,
    ) -> Result<(String, String, Option<String>), ApiError> {
        let p = self.entries.get_mut(id).ok_or_else(unknown)?;
        let is_claimant = p.claimant.as_ref().is_some_and(|c| &c.device_id == actor);
        if !is_claimant {
            return Err(ApiError::new(
                403,
                "not_claimant",
                "only the claiming device may fetch",
            ));
        }
        let consumed = || ApiError::new(410, "envelope_consumed", "the envelope was already taken");
        if p.state == State::Consumed {
            return Err(consumed());
        }
        // Before `not_approved`: a claimant told "not yet" polls again, and
        // after the ten minutes there is no yet.
        if p.expires <= now {
            return Err(expired());
        }
        if p.state != State::Approved {
            return Err(ApiError::new(
                409,
                "not_approved",
                "the pairing is not approved yet",
            ));
        }
        activate()?;
        let (envelope, nonce) = p.envelope.take().ok_or_else(consumed)?;
        let creator_pub = p.creator_pub.take();
        p.state = State::Consumed;
        Ok((envelope, nonce, creator_pub))
    }
}

fn unknown() -> ApiError {
    ApiError::new(404, "unknown_pairing", "no such pairing")
}

fn expired() -> ApiError {
    ApiError::new(410, "pairing_expired", "the pairing has expired")
}

fn not_creator() -> ApiError {
    ApiError::new(403, "not_creator", "only the pairing's creator may do this")
}

fn not_claimed() -> ApiError {
    ApiError::new(409, "not_claimed", "no device has claimed the pairing")
}

fn already_approved() -> ApiError {
    ApiError::new(409, "already_approved", "the pairing is already approved")
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
    let now = app.clock.unix_secs();
    // The body is parsed, its fields read and the token checked inside
    // `accept`, with the body still reserved, the wait for the table's lock
    // included: nothing an unverified claimant sent is kept outside the
    // pre-authentication budget (`Unverified`). The table lock is held on
    // across device creation so two racing claims cannot both pass
    // `begin_claim`.
    let (_, (enrolment, vault, claimant_pub, mut pairings)) = unverified::token_body(app, req)?
        .accept(|held| {
            let parsed = held.json()?;
            let enroll = parsed.credential("enroll_token")?;
            let enrolment = devices::enrolment_fields(parsed.value())?;
            let vault = vault_details(parsed.value())?;
            let claimant_pub = public_key_field(parsed.value(), "claimant_pub")?;
            let pairings = app.pairings.lock().expect("pairings");
            pairings.begin_claim(id, &enroll, now)?;
            Ok((enrolment, vault, claimant_pub, pairings))
        })?;
    let (name, platform, app_version) = (
        enrolment.name.clone(),
        enrolment.platform.clone(),
        enrolment.app_version.clone(),
    );
    // The claimant is PENDING: it holds a secret and no authority until the
    // pairing's creator approves it (`docs/architecture.md` 4.2).
    let (record, secret) = devices::enrol(app, enrolment, DeviceState::Pending)?;
    pairings.finish_claim(
        id,
        Claimant {
            device_id: record.device_id,
            name,
            platform,
            app_version,
            vault,
            claimant_pub,
        },
    );
    drop(pairings);

    Ok(Response::json(
        201,
        &obj(vec![
            ("device_id", s(&record.device_id.to_string())),
            ("device_secret", s(&secret)),
        ]),
    ))
}

// Validate before claiming or enrolling, so a refused payload spends nothing.
fn vault_details(body: &Value) -> Result<Option<Value>, ApiError> {
    let Some(vault) = body.get("vault") else {
        return Ok(None);
    };
    let envelope = render::field_str(vault, "envelope")?;
    let nonce = render::field_str(vault, "nonce")?;
    if envelope.len() > 2048
        || !super::is_hex(nonce, 24)
        || !obsync_core::base64::decode(envelope).is_ok_and(|bytes| bytes.len() >= 16)
    {
        return Err(ApiError::bad_request("invalid sealed vault details"));
    }
    Ok(Some(obj(vec![
        ("envelope", s(envelope)),
        ("nonce", s(nonce)),
    ])))
}

/// Validate an optional ephemeral public-key field (pairing v2) without doing
/// any elliptic-curve mathematics: the server holds and returns it verbatim
/// and never computes on it (requirement 5, std-only). A raw-uncompressed
/// P-256 point is 65 bytes beginning `0x04`; its base64url is 87 characters.
/// Anything else is a `400`, and the field is bounded so an unverified claim
/// body cannot smuggle a large value past the pre-authentication budget.
fn public_key_field(body: &Value, name: &str) -> Result<Option<String>, ApiError> {
    let Some(v) = body.get(name) else {
        return Ok(None);
    };
    let text = v
        .as_str()
        .ok_or_else(|| ApiError::bad_request("public key must be a string"))?;
    let bad =
        || ApiError::bad_request("public key must be a raw-uncompressed P-256 point, base64url");
    if text.len() != 87
        || !text
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err(bad());
    }
    // base64url -> standard base64 with padding, then the standard decoder.
    let mut std: String = text
        .chars()
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            other => other,
        })
        .collect();
    std.push('=');
    let raw = obsync_core::base64::decode(&std).map_err(|_| bad())?;
    if raw.len() != PAIRING_PUBLIC_KEY_LEN || raw[0] != 0x04 {
        return Err(bad());
    }
    Ok(Some(text.to_string()))
}

/// A raw-uncompressed P-256 public key is 65 bytes: `0x04` then two 32-byte
/// coordinates.
const PAIRING_PUBLIC_KEY_LEN: usize = 65;

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
        Some(c) => {
            let mut fields = vec![
                ("device_id", s(&c.device_id.to_string())),
                ("name", s(&c.name)),
                ("platform", s(&c.platform)),
                ("app_version", s(&c.app_version)),
            ];
            if let Some(vault) = c.vault {
                fields.push(("vault", vault));
            }
            if let Some(key) = c.claimant_pub {
                fields.push(("claimant_pub", s(&key)));
            }
            obj(fields)
        }
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
    let creator_pub = public_key_field(&body, "creator_pub")?;
    let now = app.clock.unix_secs();
    let claimant = app.pairings.lock().expect("pairings").approve(
        id,
        &authed.id,
        envelope,
        nonce,
        creator_pub.as_deref(),
        now,
    )?;
    // Approval grants nothing yet: the claimant becomes active when it
    // collects the envelope, inside the ten minutes (`envelope` below).
    app.log.info(
        "pairing_approved",
        &[
            ("device", Val::device(&claimant)),
            ("by_device", Val::device(&authed.id)),
        ],
    );
    Ok(Response::empty(204))
}

/// `POST /v1/pairing/{id}/reject`: the creator refuses a CLAIM; the claimant
/// device is deleted, so its secret stops working immediately. A pairing the
/// creator already approved is refused and changes nothing
/// ([`PairingTable::reject`]).
///
/// # Errors
/// `404 unknown_pairing`, `403 not_creator`, `409 not_claimed`,
/// `409 already_approved`.
pub fn reject(
    app: &App,
    req: &mut Request,
    client: &ClientInfo,
    id: &str,
) -> Result<Response, ApiError> {
    let authed = auth::device(app, req, client)?;
    let claimant = match app
        .pairings
        .lock()
        .expect("pairings")
        .reject(id, &authed.id)
    {
        Ok(claimant) => claimant,
        // The refusal names itself, because the one this issue is about --
        // a reject arriving after the approval -- is indistinguishable from a
        // creator answering twice, and an operator asking why a device is
        // still listed needs the reason and not just the status
        // (requirement 12). The state is not in the line: the reason IS it.
        Err(e) => {
            app.log.warn(
                "pairing_reject",
                &[
                    ("by_device", Val::device(&authed.id)),
                    ("decision", Val::word("refused")),
                    ("reason", Val::word(e.code)),
                ],
            );
            return Err(e);
        }
    };
    app.store.delete_device(&claimant)?;
    app.log.info(
        "pairing_rejected",
        &[
            ("device", Val::device(&claimant)),
            ("decision", Val::word("deleted")),
        ],
    );
    Ok(Response::empty(204))
}

/// `GET /v1/pairing/{id}/envelope`: the claimant fetches the key envelope,
/// exactly once, and becomes active by doing so.
///
/// The one route a device still waiting for approval may reach, so it can
/// poll for the approval. Only that pairing's claimant is served, only after
/// the creator approved and only inside the ten minutes; the activation is
/// journaled before the envelope leaves, and a journal that refuses it
/// consumes nothing (`docs/architecture.md` 4.2; issue #153).
///
/// # Errors
/// `404 unknown_pairing`, `403 not_claimant`, `409 not_approved`,
/// `410 envelope_consumed`, `410 pairing_expired`, or a storage refusal.
pub fn envelope(
    app: &App,
    req: &mut Request,
    client: &ClientInfo,
    id: &str,
) -> Result<Response, ApiError> {
    let authed = auth::device_claimant(app, req, client)?;
    let now = app.clock.unix_secs();
    let (envelope, nonce, creator_pub) =
        app.pairings
            .lock()
            .expect("pairings")
            .take_envelope(id, &authed.id, now, || {
                Ok(app.store.activate_device(&authed.id)?)
            })?;
    app.log.info(
        "pairing_collected",
        &[
            ("device", Val::device(&authed.id)),
            ("decision", Val::word("activated")),
        ],
    );
    let mut fields = vec![("envelope", s(&envelope)), ("nonce", s(&nonce))];
    if let Some(key) = creator_pub {
        fields.push(("creator_pub", s(&key)));
    }
    Ok(Response::json(200, &obj(fields)))
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
    use crate::api::unverified::Credential;

    fn tok(token: &str) -> Credential<'_> {
        Credential::for_tests(token)
    }

    const NOW: u64 = 1_757_200_000;

    #[test]
    fn sealed_vault_is_optional_bounded_and_opaque() {
        assert_eq!(vault_details(&obj(vec![])).unwrap(), None);
        let envelope = obsync_core::base64::encode(&[0; 16]);
        let nonce = "ab".repeat(12);
        let sealed = obj(vec![("envelope", s(&envelope)), ("nonce", s(&nonce))]);
        assert_eq!(
            vault_details(&obj(vec![("vault", sealed.clone())])).unwrap(),
            Some(sealed)
        );
        for (ct, iv) in [
            ("A".repeat(2052), nonce.clone()),
            ("!".into(), nonce.clone()),
            (obsync_core::base64::encode(&[0; 15]), nonce.clone()),
            (envelope.clone(), "ab".into()),
            (envelope.clone(), "z".repeat(24)),
        ] {
            assert!(
                vault_details(&obj(vec![(
                    "vault",
                    obj(vec![("envelope", s(&ct)), ("nonce", s(&iv))])
                )]))
                .is_err()
            );
        }
        for bad in [
            Value::Null,
            s("clear name"),
            obj(vec![]),
            obj(vec![("envelope", s(&envelope))]),
        ] {
            assert!(vault_details(&obj(vec![("vault", bad)])).is_err());
        }
        let unknown = obj(vec![(
            "vault",
            obj(vec![
                ("envelope", s(&envelope)),
                ("nonce", s(&nonce)),
                ("name", s("must not retain")),
            ]),
        )]);
        assert!(
            vault_details(&unknown)
                .unwrap()
                .unwrap()
                .get("name")
                .is_none()
        );
    }

    /// A raw-uncompressed P-256 point (65 bytes, `0x04` prefix) as base64url.
    const PUBKEY: &str =
        "BO8WCdd27pWdRyoUup6EiGUawF_1YKg8KISaBuGImQsp-zQ_bUKC0Ks1RRbDGmCLqT2V7eHp2NzNejuASM-kyJ4";

    #[test]
    fn public_key_field_is_optional_and_holds_a_p256_point_verbatim() {
        // Absent is fine (a legacy pairing carries no key).
        assert_eq!(public_key_field(&obj(vec![]), "k").unwrap(), None);
        // A valid point is returned verbatim, never decoded on the server.
        assert_eq!(
            public_key_field(&obj(vec![("k", s(PUBKEY))]), "k").unwrap(),
            Some(PUBKEY.to_string())
        );
        // Wrong prefix (a compressed point), wrong length, a bad alphabet, the
        // wrong type: each is a 400 the server never computes on.
        let compressed = {
            let mut raw = [0u8; 65];
            raw[0] = 0x02;
            obsync_core::base64::encode(&raw)
                .replace('+', "-")
                .replace('/', "_")
                .trim_end_matches('=')
                .to_string()
        };
        let short = {
            let raw = [4u8; 64];
            obsync_core::base64::encode(&raw)
                .replace('+', "-")
                .replace('/', "_")
                .trim_end_matches('=')
                .to_string()
        };
        for bad in [
            compressed,
            short,
            "!".repeat(87),
            "AAAA".to_string(),
            format!("{PUBKEY}A"),
        ] {
            assert!(
                public_key_field(&obj(vec![("k", s(&bad))]), "k").is_err(),
                "{bad}"
            );
        }
        assert!(public_key_field(&obj(vec![("k", Value::Null)]), "k").is_err());
        assert!(public_key_field(&obj(vec![("k", n(1))]), "k").is_err());
    }

    #[test]
    fn the_pairing_carries_the_claimant_pub_to_the_creator() {
        let (mut t, creator) = table();
        t.begin_claim("p1", &tok("tok"), NOW).expect("claimable");
        t.finish_claim(
            "p1",
            Claimant {
                device_id: dev(2),
                name: "n".into(),
                platform: "ios".into(),
                app_version: "0".into(),
                vault: None,
                claimant_pub: Some("CLAIMANTKEY".into()),
            },
        );
        let (_, claimant) = t.state_for("p1", &creator, NOW).expect("state");
        assert_eq!(
            claimant.unwrap().claimant_pub.as_deref(),
            Some("CLAIMANTKEY")
        );
    }

    #[test]
    fn approve_stores_the_creator_pub_and_collection_returns_it_once() {
        let (mut t, creator, claimant) = claimed();
        t.approve("p1", &creator, "ct", "aa", Some("CREATORKEY"), NOW)
            .expect("approved");
        let (env, nonce, key) = t
            .take_envelope("p1", &claimant, NOW, || Ok(()))
            .expect("collected");
        assert_eq!(
            (env.as_str(), nonce.as_str(), key.as_deref()),
            ("ct", "aa", Some("CREATORKEY"))
        );
    }

    /// A fetch whose activation always succeeds, inside the ten minutes.
    fn take(t: &mut PairingTable, actor: &DeviceId) -> Result<(String, String), ApiError> {
        t.take_envelope("p1", actor, NOW, || Ok(()))
            .map(|(e, nonce, _)| (e, nonce))
    }

    fn table() -> (PairingTable, DeviceId) {
        let mut t = PairingTable::new();
        let creator = dev(1);
        t.create("p1", creator, "tok", NOW);
        (t, creator)
    }

    fn claimed() -> (PairingTable, DeviceId, DeviceId) {
        let (mut t, creator) = table();
        t.begin_claim("p1", &tok("tok"), NOW).expect("claimable");
        let claimant = dev(2);
        t.finish_claim(
            "p1",
            Claimant {
                device_id: claimant,
                name: "phone".to_string(),
                platform: "ios".to_string(),
                app_version: "0.1.0".to_string(),
                vault: None,
                claimant_pub: None,
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
            t.begin_claim("nope", &tok("tok"), NOW)
                .expect_err("unknown")
                .code,
            "unknown_pairing"
        );
    }

    #[test]
    fn the_wrong_enrollment_token_is_indistinguishable_from_an_unknown_pairing() {
        let (t, _) = table();
        let e = t
            .begin_claim("p1", &tok("wrong"), NOW)
            .expect_err("refused");
        assert_eq!(e.status, 404);
        assert_eq!(e.code, "unknown_pairing");
    }

    #[test]
    fn a_claim_after_ten_minutes_is_expired() {
        let (t, _) = table();
        let e = t
            .begin_claim("p1", &tok("tok"), NOW + PAIRING_TTL_SECS)
            .expect_err("expired");
        assert_eq!(e.status, 410);
        assert_eq!(e.code, "pairing_expired");
    }

    #[test]
    fn a_second_claim_is_refused() {
        let (t, _, _) = claimed();
        let e = t
            .begin_claim("p1", &tok("tok"), NOW)
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
            t.approve("p1", &creator, "ct", "aa", None, NOW)
                .expect_err("no claim")
                .code,
            "not_claimed"
        );
        let (mut t, creator, claimant) = claimed();
        assert_eq!(
            t.approve("p1", &claimant, "ct", "aa", None, NOW)
                .expect_err("wrong actor")
                .code,
            "not_creator"
        );
        t.approve("p1", &creator, "ct", "aa", None, NOW)
            .expect("creator approves");
        assert_eq!(
            t.state_for("p1", &creator, NOW).expect("state").0,
            State::Approved
        );
        assert_eq!(
            t.approve("p1", &creator, "ct", "aa", None, NOW)
                .expect_err("twice")
                .code,
            "already_approved"
        );
    }

    #[test]
    fn approve_after_expiry_is_refused() {
        let (mut t, creator, _) = claimed();
        let e = t
            .approve("p1", &creator, "ct", "aa", None, NOW + PAIRING_TTL_SECS)
            .expect_err("expired");
        assert_eq!(e.code, "pairing_expired");
    }

    #[test]
    fn the_envelope_is_served_exactly_once_and_only_to_the_claimant() {
        let (mut t, creator, claimant) = claimed();
        assert_eq!(
            take(&mut t, &claimant).expect_err("not approved yet").code,
            "not_approved"
        );
        t.approve("p1", &creator, "ct", "aa", None, NOW)
            .expect("approved");
        assert_eq!(
            take(&mut t, &creator)
                .expect_err("creator is not the claimant")
                .code,
            "not_claimant"
        );
        let (env, nonce) = take(&mut t, &claimant).expect("first fetch");
        assert_eq!((env.as_str(), nonce.as_str()), ("ct", "aa"));
        let e = take(&mut t, &claimant).expect_err("second fetch");
        assert_eq!(e.status, 410);
        assert_eq!(e.code, "envelope_consumed");
    }

    #[test]
    fn an_unrelated_device_cannot_fetch_the_envelope() {
        let (mut t, creator, _) = claimed();
        t.approve("p1", &creator, "ct", "aa", None, NOW)
            .expect("approved");
        assert_eq!(
            take(&mut t, &dev(9)).expect_err("stranger").code,
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

    /// Issue #88: the reject that arrives after the approval.
    #[test]
    fn an_approved_pairing_refuses_a_reject_and_keeps_its_claimant() {
        for consume in [false, true] {
            let (mut t, creator, claimant) = claimed();
            t.approve("p1", &creator, "ct", "aa", None, NOW)
                .expect("approved");
            if consume {
                take(&mut t, &claimant).expect("fetched");
            }
            let e = t
                .reject("p1", &creator)
                .expect_err("an approved pairing is not rejectable");
            assert_eq!(e.status, 409, "consumed: {consume}");
            assert_eq!(e.code, "already_approved", "consumed: {consume}");
            // Nothing moved: the refusal names no device, so the caller has
            // nothing to delete, and the pairing is still the one it was.
            let (state, seen) = t.state_for("p1", &creator, NOW).expect("still held");
            assert_eq!(
                state,
                if consume {
                    State::Consumed
                } else {
                    State::Approved
                }
            );
            assert_eq!(seen.expect("claimant").device_id, claimant);
        }
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
        assert_eq!(t.sweep(NOW + 1), Swept::default(), "a live pairing is kept");
        assert_eq!(
            t.sweep(NOW + PAIRING_TTL_SECS),
            Swept {
                pairings: 1,
                orphans: Vec::new()
            },
            "an unclaimed pairing leaves no device behind"
        );
        assert!(t.is_empty());
    }

    #[test]
    fn approve_names_the_device_to_activate() {
        let (mut t, creator, claimant) = claimed();
        assert_eq!(
            t.approve("p1", &creator, "ct", "aa", None, NOW)
                .expect("creator approves"),
            claimant,
            "the caller logs exactly that device; collection activates it"
        );
    }

    #[test]
    fn an_expired_unapproved_pairing_hands_back_the_device_it_claimed() {
        let (mut t, _, claimant) = claimed();
        assert_eq!(
            t.sweep(NOW + 1),
            Swept::default(),
            "still inside the ten minutes"
        );
        assert_eq!(
            t.sweep(NOW + PAIRING_TTL_SECS),
            Swept {
                pairings: 1,
                orphans: vec![(claimant, State::Claimed)]
            },
            "an unapproved claim does not outlive its pairing"
        );
        assert!(t.is_empty());
    }

    /// Issue #153: approved, never collected, so never activated.
    #[test]
    fn an_expired_approved_pairing_hands_back_its_device_unless_collected() {
        for consume in [false, true] {
            let (mut t, creator, claimant) = claimed();
            t.approve("p1", &creator, "ct", "aa", None, NOW)
                .expect("approved");
            if consume {
                take(&mut t, &claimant).expect("fetched");
            }
            assert_eq!(
                t.sweep(NOW + PAIRING_TTL_SECS),
                Swept {
                    pairings: 1,
                    orphans: if consume {
                        Vec::new()
                    } else {
                        vec![(claimant, State::Approved)]
                    }
                },
                "only the collection activated it (consumed: {consume})"
            );
        }
    }

    /// Issue #153: the checks come first, the activation next, the envelope
    /// last -- and a refused activation leaves the envelope where it was.
    #[test]
    fn collecting_activates_after_every_check_and_a_refusal_consumes_nothing() {
        let (mut t, creator, claimant) = claimed();
        let mut asked = 0;
        let e = t
            .take_envelope("p1", &claimant, NOW, || {
                asked += 1;
                Ok(())
            })
            .expect_err("not approved yet");
        assert_eq!(e.code, "not_approved");
        t.approve("p1", &creator, "ct", "aa", None, NOW)
            .expect("approved");
        let e = t
            .take_envelope("p1", &creator, NOW, || {
                asked += 1;
                Ok(())
            })
            .expect_err("the creator is no claimant");
        assert_eq!(e.code, "not_claimant");
        assert_eq!(asked, 0, "no refusal activates anything");
        let e = t
            .take_envelope("p1", &claimant, NOW, || {
                Err(ApiError::new(507, "journal_full", "full"))
            })
            .expect_err("the journal refused");
        assert_eq!(e.code, "journal_full");
        assert_eq!(
            t.state_for("p1", &creator, NOW).expect("state").0,
            State::Approved,
            "a refused activation consumes nothing"
        );
        let got = t
            .take_envelope("p1", &claimant, NOW, || {
                asked += 1;
                Ok(())
            })
            .expect("collected");
        assert_eq!((got.0.as_str(), got.1.as_str()), ("ct", "aa"));
        assert_eq!(asked, 1);
        let e = t
            .take_envelope("p1", &claimant, NOW, || {
                asked += 1;
                Ok(())
            })
            .expect_err("once");
        assert_eq!(e.code, "envelope_consumed");
        assert_eq!(asked, 1, "a second fetch activates nothing");
    }

    /// Issue #153: after the ten minutes there is nothing left to wait for,
    /// approved or not, and nothing is activated.
    #[test]
    fn a_collection_after_the_ten_minutes_is_expired_and_activates_nothing() {
        for approve in [false, true] {
            let (mut t, creator, claimant) = claimed();
            if approve {
                t.approve("p1", &creator, "ct", "aa", None, NOW)
                    .expect("approved");
            }
            let e = t
                .take_envelope("p1", &claimant, NOW + PAIRING_TTL_SECS, || {
                    panic!("an expired pairing must not activate")
                })
                .expect_err("expired");
            assert_eq!(
                (e.status, e.code),
                (410, "pairing_expired"),
                "approved: {approve}"
            );
        }
    }

    /// Issue #154: a late claim is told it is late, for an hour, and only a
    /// caller holding the token is told anything.
    #[test]
    fn a_swept_pairing_still_answers_expired_to_its_token_for_an_hour() {
        let (mut t, _) = table();
        t.sweep(NOW + PAIRING_TTL_SECS);
        let late = NOW + PAIRING_TTL_SECS + 1;
        let e = t.begin_claim("p1", &tok("tok"), late).expect_err("late");
        assert_eq!((e.status, e.code), (410, "pairing_expired"));
        let e = t
            .begin_claim("p1", &tok("tak"), late)
            .expect_err("mistyped");
        assert_eq!(
            (e.status, e.code),
            (404, "unknown_pairing"),
            "the wrong token learns nothing"
        );
        let e = t.begin_claim("p9", &tok("tok"), late).expect_err("unknown");
        assert_eq!(e.code, "unknown_pairing");
        t.sweep(NOW + PAIRING_TTL_SECS + ENDED_KEPT_SECS - 1);
        assert_eq!(
            t.begin_claim("p1", &tok("tok"), late)
                .expect_err("kept")
                .code,
            "pairing_expired"
        );
        t.sweep(NOW + PAIRING_TTL_SECS + ENDED_KEPT_SECS);
        assert_eq!(
            t.begin_claim("p1", &tok("tok"), late)
                .expect_err("forgotten")
                .code,
            "unknown_pairing",
            "an hour on, it is forgotten"
        );
    }

    /// Issue #153: the creator's last poll learns how its pairing ended, and
    /// nobody else learns anything new.
    #[test]
    fn a_swept_pairing_tells_its_creator_how_it_ended() {
        for consume in [false, true] {
            let (mut t, creator, claimant) = claimed();
            t.approve("p1", &creator, "ct", "aa", None, NOW)
                .expect("approved");
            if consume {
                take(&mut t, &claimant).expect("fetched");
            }
            t.sweep(NOW + PAIRING_TTL_SECS);
            let (state, seen) = t
                .state_for("p1", &creator, NOW + PAIRING_TTL_SECS)
                .expect("remembered");
            assert_eq!(
                state,
                if consume {
                    State::Consumed
                } else {
                    State::Expired
                }
            );
            assert!(seen.is_none(), "the claimant is not kept");
            assert_eq!(
                t.state_for("p1", &dev(9), NOW + PAIRING_TTL_SECS)
                    .expect_err("stranger")
                    .code,
                "not_creator"
            );
            assert!(!t.holds(&claimant), "an ended pairing holds no device");
        }
    }

    /// Issue #154: the memory an expired pairing keeps is bounded, oldest out.
    #[test]
    fn expired_pairings_are_kept_to_a_bound_newest_first() {
        let mut t = PairingTable::new();
        let creator = dev(1);
        let total = ENDED_KEPT_MAX + 3;
        for i in 0..total {
            t.create(&format!("p{i}"), creator, "tok", NOW + i as u64);
        }
        let late = NOW + PAIRING_TTL_SECS + total as u64;
        t.sweep(late);
        assert_eq!(t.ended.len(), ENDED_KEPT_MAX);
        for i in 0..3 {
            assert_eq!(
                t.begin_claim(&format!("p{i}"), &tok("tok"), late)
                    .expect_err("evicted")
                    .code,
                "unknown_pairing",
                "the oldest are forgotten first"
            );
        }
        assert_eq!(
            t.begin_claim(&format!("p{}", total - 1), &tok("tok"), late)
                .expect_err("kept")
                .code,
            "pairing_expired"
        );
    }

    #[test]
    fn a_consumed_pairing_does_not_flip_back_to_expired() {
        let (mut t, creator, claimant) = claimed();
        t.approve("p1", &creator, "ct", "aa", None, NOW)
            .expect("approved");
        take(&mut t, &claimant).expect("fetched");
        let (state, _) = t
            .state_for("p1", &creator, NOW + PAIRING_TTL_SECS)
            .expect("state");
        assert_eq!(state, State::Consumed);
    }
}
