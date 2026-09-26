//! First-boot account creation and the account view
//! (`docs/protocol.md`, "Setup and account").
#![forbid(unsafe_code)]

use obsync_core::ct;
use obsync_core::http::{Request, Response};
use obsync_core::json::obj;

use crate::log::Val;
use crate::storage::types::DeviceState;

use super::edge::ClientInfo;
use super::render::{self, s};
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
/// `409 recovery_unavailable` without registration, or `403 bad_recovery_proof`.
pub fn create(app: &App, req: &mut Request) -> Result<Response, ApiError> {
    let body = render::json_body(req)?;
    let token = render::field_str(&body, "setup_token")?;
    let account_name = render::text_field(
        render::field_str(&body, "account_name")?,
        "account_name",
        64,
    )?;
    let device = body
        .get("device")
        .ok_or_else(|| ApiError::bad_request("device must be an object"))?;
    // Validated before the account is created, so a malformed platform cannot
    // leave an account behind that no device can ever reach.
    let enrolment = devices::enrolment_fields(device)?;

    // The TOKEN first, and the account afterwards. Both refusals are
    // documented and both still happen; what changes is what an
    // unauthenticated caller learns from them. Asking the account first made
    // `409 already_set_up` an answer anybody could get with a wrong token,
    // which is a free "is this server claimed?" oracle on a public hostname.
    // Now only a caller holding the token can tell the two apart
    // (`docs/protocol.md`, "Setup and account").
    let expected = app
        .setup_token
        .as_deref()
        .ok_or_else(|| ApiError::new(409, "already_set_up", "no setup token is outstanding"))?;
    if !ct::eq(expected.as_bytes(), token.as_bytes()) {
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
    // The token matched in constant time, so this caller holds the
    // first-boot credential. The `409` below is answered to a caller that
    // proved it, and the `401` above to one that did not.
    req.prove();
    let recovery = match body.get("recovery_verifier") {
        None => None,
        Some(_) => Some(verifier_field(&body, "recovery_verifier")?),
    };
    let (account_id, recovered) = if let Some(account) = app.store.account() {
        let Some(proof) = body.get("recovery_proof") else {
            return Err(ApiError::new(
                409,
                "already_set_up",
                "this account already exists; pair from a syncing device, or recover with its setup token and vault recovery phrase",
            ));
        };
        let expected = account.recovery_verifier.as_deref().ok_or_else(|| {
            ApiError::new(
                409,
                "recovery_unavailable",
                "a paired device must register vault recovery before the last credential is lost",
            )
        })?;
        let proof = proof
            .as_str()
            .filter(|text| super::is_hex(text, 64))
            .and_then(|text| obsync_core::hex::decode(text).ok());
        let digest =
            proof.map(|bytes| obsync_core::hex::encode(&obsync_core::sha256::sha256(&bytes)));
        if !digest.is_some_and(|actual| ct::eq(actual.as_bytes(), expected.as_bytes())) {
            return Err(ApiError::new(
                403,
                "bad_recovery_proof",
                "these recovery words do not prove this vault; no device was enrolled",
            ));
        }
        (account.account_id, true)
    } else {
        (
            app.store.setup_with_recovery(&account_name, recovery)?,
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
    let device_count = app.store.devices().len() as u64;
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
/// A different verifier is refused, even for an authenticated device.
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
    if !app.store.register_recovery(&verifier)? {
        return Err(ApiError::new(
            409,
            "recovery_mismatch",
            "this account already has recovery for a different vault key",
        ));
    }
    Ok(Response::empty(204))
}
