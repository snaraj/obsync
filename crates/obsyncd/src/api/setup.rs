//! First-boot account creation and the account view
//! (`docs/protocol.md`, "Setup and account").
#![forbid(unsafe_code)]

use obsync_core::ct;
use obsync_core::http::{Request, Response};
use obsync_core::json::obj;

use crate::log::Val;
use crate::storage::types::DeviceState;
use crate::types::UnixMs;

use super::devices::Enrolment;
use super::edge::ClientInfo;
use super::render::{self, s};
use super::unverified::{self, Credential, Parsed};
use super::{ApiError, App, auth, devices};

/// `POST /v1/setup`: create an account, or recover one with the token and vault proof.
///
/// One call, because pairing is a device endpoint: without this, device one
/// would have nothing to authenticate with and no way to get it
/// (`docs/architecture.md` 4.1).
///
/// # Errors
/// `400 bad_request` for a malformed body, `401 bad_setup_token` for a token
/// that does not match, `409 already_set_up` without proof,
/// `409 recovery_unavailable` for an account with no verifier that the
/// operator has not reset, or `403 bad_recovery_proof`. After
/// `obsyncd recovery reset apply`, which rotates the token and arms one
/// re-enrolment, a recovery registers the verifier its proof derives.
pub fn create(app: &App, req: &mut Request) -> Result<Response, ApiError> {
    // The body is an unverified caller's until the token has matched, so it
    // is parsed, its fields read and the token compared inside `accept`, with
    // the body still reserved (`Unverified`).
    let (_, (body, (account_name, enrolment))) =
        unverified::token_body(app, req)?.accept(|held| {
            let body = held.json()?;
            let fields = setup_fields(app, &body)?;
            Ok((body.into_value(), fields))
        })?;
    // The token matched in constant time, so this caller holds the
    // first-boot credential. The `409` below is answered to a caller that
    // proved it, and the `401` above to one that did not.
    req.prove();
    let now = UnixMs(app.clock.unix_ms());
    let recovery = match body.get("recovery_verifier") {
        None => None,
        Some(_) => Some(verifier_field(&body, "recovery_verifier")?),
    };
    let (account_id, recovered) = if let Some(account) = app.store.account() {
        // An existing account is recovered, never recreated: the caller proves
        // the vault key with a recovery proof, or pairs from a syncing device.
        let Some(proof) = body.get("recovery_proof") else {
            return Err(ApiError::new(
                409,
                "already_set_up",
                "this account already exists; pair from a syncing device, or recover with its setup token and vault recovery phrase",
            ));
        };
        // No verifier and no reset since: nothing here proves the vault, and
        // the token alone must not. 1.1.4's answer, before any proof is read.
        if account.recovery_verifier.is_none() && account.recovery_cleared.is_none() {
            return Err(ApiError::new(
                409,
                "recovery_unavailable",
                "no recovery key is registered for this account; pair from a syncing device, or ask the operator to reset recovery",
            ));
        }
        // The verifier the proof derives. The server computes it, so a caller
        // cannot register one without a proof that produces it.
        let derived = proof
            .as_str()
            .filter(|text| super::is_hex(text, 64))
            .and_then(|text| obsync_core::hex::decode(text).ok())
            .map(|bytes| obsync_core::hex::encode(&obsync_core::sha256::sha256(&bytes)))
            .ok_or_else(|| {
                ApiError::new(
                    403,
                    "bad_recovery_proof",
                    "these recovery words do not prove this vault; no device was enrolled",
                )
            })?;
        match account.recovery_verifier.as_deref() {
            Some(expected) => {
                // Ordinary recovery: the proof must prove the registered key.
                if !ct::eq(derived.as_bytes(), expected.as_bytes()) {
                    return Err(ApiError::new(
                        403,
                        "bad_recovery_proof",
                        "these recovery words do not prove this vault; no device was enrolled",
                    ));
                }
            }
            None => {
                // The re-enrolment the operator's reset armed
                // (`obsyncd recovery reset apply`, `docs/recovery.md`). There
                // is nothing to check the proof against: the authority is that
                // offline reset and the token it rotated, which only a reader
                // of the journal volume since holds. The proof only chooses
                // the verifier, registered timed so the last-device hold runs
                // from now, and registering spends the arm; a wrong phrase
                // locks out only its user, and the operator can reset again.
                // No device credential reaches this: setup is authenticated by
                // the token, and only the offline reset arms it. A verifier
                // registered since the read is compared instead, so a proof
                // that does not produce it is refused.
                if !app.store.register_recovery(&derived, now)? {
                    return Err(ApiError::new(
                        403,
                        "bad_recovery_proof",
                        "these recovery words do not prove this vault; no device was enrolled",
                    ));
                }
                app.log.info(
                    "recovery_reestablished",
                    &[
                        ("account", Val::account(&account.account_id)),
                        ("decision", Val::word("reestablished")),
                        ("at", Val::ts(now)),
                        // Some: checked above, beside no verifier.
                        (
                            "armed_at",
                            Val::ts(account.recovery_cleared.unwrap_or_default()),
                        ),
                    ],
                );
            }
        }
        (account.account_id, true)
    } else {
        (
            app.store
                .setup_with_recovery(&account_name, recovery, now)?,
            false,
        )
    };
    // Device one is active on creation: pairing approval needs an approver,
    // and at setup there is none (`docs/architecture.md` 4.1).
    let (record, secret) = devices::enrol(app, enrolment, DeviceState::Active)?;
    app.log.info(
        if recovered {
            "account_recovered"
        } else {
            "account_created"
        },
        &[
            ("account", Val::account(&account_id)),
            ("device", Val::device(&record.device_id)),
        ],
    );
    Ok(Response::json(
        201,
        &obj(vec![
            ("account_id", s(&account_id.to_string())),
            ("recovered", obsync_core::json::Value::Bool(recovered)),
            ("device_id", s(&record.device_id.to_string())),
            ("device_secret", s(&secret)),
        ]),
    ))
}

/// The account name and the first device's enrolment from a setup body,
/// once its token has matched. Runs inside `accept`: until the token matches,
/// the body is an unverified caller's.
fn setup_fields(app: &App, parsed: &Parsed) -> Result<(String, Enrolment), ApiError> {
    let body = parsed.value();
    let token = parsed.credential("setup_token")?;
    let account_name =
        render::text_field(render::field_str(body, "account_name")?, "account_name", 64)?;
    let device = body
        .get("device")
        .ok_or_else(|| ApiError::bad_request("device must be an object"))?;
    // Validated before the account is created, so a malformed platform
    // cannot leave an account behind that no device can ever reach.
    let enrolment = devices::enrolment_fields(device)?;

    // The TOKEN first, and the account afterwards. Both refusals are
    // documented and both still happen; what changes is what an
    // unauthenticated caller learns from them. Asking the account first made
    // `409 already_set_up` an answer anybody could get with a wrong token,
    // which is a free "is this server claimed?" oracle on a public hostname.
    // Now only a caller holding the token can tell the two apart
    // (`docs/protocol.md`, "Setup and account").
    check_token(app, &token)?;
    Ok((account_name, enrolment))
}

/// Refuse unless `token` is the outstanding setup token, compared in constant
/// time. It takes a [`Credential`], so the comparison and its refusal run only
/// inside `accept`, on the body whose reservation is held.
///
/// # Errors
/// `409 already_set_up` when no setup token is outstanding, and
/// `401 bad_setup_token` when this one does not match.
fn check_token(app: &App, token: &Credential) -> Result<(), ApiError> {
    let expected = app
        .setup_token
        .as_deref()
        .ok_or_else(|| ApiError::new(409, "already_set_up", "no setup token is outstanding"))?;
    #[cfg(test)]
    app.bodies
        .at_token_check
        .store(app.preauth_held(), std::sync::atomic::Ordering::SeqCst);
    if !ct::eq(expected.as_bytes(), token.as_str().as_bytes()) {
        app.log.warn(
            "setup_refused",
            &[("decision", Val::word("bad_setup_token"))],
        );
        return Err(ApiError::new(
            401,
            "bad_setup_token",
            "setup token does not match",
        ));
    }
    Ok(())
}

/// `GET /v1/account`.
///
/// # Errors
/// The device-authentication refusals, or `409 not_set_up`.
pub fn account(app: &App, req: &mut Request, client: &ClientInfo) -> Result<Response, ApiError> {
    auth::device(app, req, client)?;
    let record = app
        .store
        .account()
        .ok_or_else(|| ApiError::new(409, "not_set_up", "no account exists yet"))?;
    let device_count = app.store.working_device_count();
    Ok(Response::json(200, &render::account(&record, device_count)))
}

fn verifier_field(body: &obsync_core::json::Value, field: &str) -> Result<String, ApiError> {
    let value = render::field_str(body, field)?;
    if !super::is_hex(value, 64) {
        return Err(ApiError::bad_request(
            "recovery verifier must be 64 hex characters",
        ));
    }
    Ok(value.to_ascii_lowercase())
}

/// Register an existing account's vault recovery verifier after device authentication.
/// A different verifier is refused, even for an authenticated device; the
/// device that meets it warns its person (`docs/recovery.md`), and only the
/// operator's reset clears it.
///
/// # Errors
/// Authentication refusals, `400 bad_request`, `409 recovery_mismatch`, or storage refusal.
pub fn register_recovery(
    app: &App,
    req: &mut Request,
    client: &ClientInfo,
) -> Result<Response, ApiError> {
    let authed = auth::device(app, req, client)?;
    let body = render::parse_json(&authed.body)?;
    let verifier = verifier_field(&body, "recovery_verifier")?;
    if !app
        .store
        .register_recovery(&verifier, UnixMs(app.clock.unix_ms()))?
    {
        return Err(ApiError::new(
            409,
            "recovery_mismatch",
            "this account already has recovery for a different vault key",
        ));
    }
    Ok(Response::empty(204))
}
