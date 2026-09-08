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

/// `POST /v1/setup`: consume the one-time setup token, create the account, and
/// enrol the first device in the same call.
///
/// One call, because pairing is a device endpoint: without this, device one
/// would have nothing to authenticate with and no way to get it
/// (`docs/architecture.md` 4.1).
///
/// # Errors
/// `400 bad_request` for a malformed body, `401 bad_setup_token` for a token
/// that does not match, `409 already_set_up` once an account exists.
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

    if app.store.account().is_some() {
        return Err(ApiError::new(
            409,
            "already_set_up",
            "the account already exists",
        ));
    }
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

    let account_id = app.store.setup(&account_name)?;
    // Device one is active on creation: pairing approval needs an approver,
    // and at setup there is none (`docs/architecture.md` 4.1).
    let (record, secret) = devices::enrol(app, enrolment, DeviceState::Active)?;
    app.log.info(
        "account_created",
        &[
            ("account", Val::account(&account_id)),
            ("device", Val::device(&record.device_id)),
        ],
    );
    Ok(Response::json(
        201,
        &obj(vec![
            ("account_id", s(&account_id.to_string())),
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
