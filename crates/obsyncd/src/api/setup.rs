//! First-boot account creation and the account view
//! (`docs/protocol.md`, "Setup and account").
#![forbid(unsafe_code)]

use obsync_core::ct;
use obsync_core::http::{Request, Response};
use obsync_core::json::{Value, obj};

use crate::storage::types::{DevicePolicy, NewDevice};

use super::edge::ClientInfo;
use super::render::{self, s};
use super::{ApiError, App, auth, devices, pairing};

/// `POST /v1/setup`: consume the one-time setup token and create the account.
///
/// When the body also carries `name`, `platform`, and `app_version`, the first
/// device is enrolled in the same call and its credential is returned beside
/// the account id. Without that, nothing could ever authenticate: pairing is a
/// device endpoint, so device one has no other way in
/// (`docs/architecture.md` 4.1). A dashboard-driven setup omits the three
/// fields and gets the documented `{"account_id"}` alone.
///
/// # Errors
/// `400 bad_request` for a malformed body, `401 bad_setup_token` for a token
/// that does not match, `409 already_set_up` once an account exists.
pub fn create(app: &App, req: &mut Request) -> Result<Response, ApiError> {
    let body = render::json_body(req)?;
    let token = render::field_str(&body, "setup_token")?;
    let name = render::text_field(
        render::field_str(&body, "account_name")?,
        "account_name",
        64,
    )?;

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
        app.log
            .warn("setup_refused", &[("decision", "bad_setup_token")]);
        return Err(ApiError::new(
            401,
            "bad_setup_token",
            "setup token does not match",
        ));
    }

    // The device fields are validated before the account is created, so a
    // malformed platform cannot leave an account behind with no device and a
    // setup call that now answers 409.
    let device = match body.get("name") {
        Some(_) => Some(first_device_fields(&body)?),
        None => None,
    };

    let account_id = app.store.setup(&name)?;
    let mut fields = vec![("account_id", s(&account_id.to_string()))];
    if let Some(new_device) = device {
        let (record, secret) = devices::enrol(app, new_device)?;
        fields.push(("device_id", s(&record.device_id.to_string())));
        fields.push(("device_secret", s(&secret)));
    }
    app.log.info(
        "account_created",
        &[("devices", if fields.len() > 1 { "1" } else { "0" })],
    );
    Ok(Response::json(201, &obj(fields)))
}

/// Device one as the setup body describes it.
fn first_device_fields(body: &Value) -> Result<NewDevice, ApiError> {
    let name = render::text_field(render::field_str(body, "name")?, "name", 64)?;
    let platform = render::field_str(body, "platform")?.to_string();
    if !pairing::PLATFORMS.contains(&platform.as_str()) {
        return Err(ApiError::bad_request(
            "platform is not one of the supported platforms",
        ));
    }
    let app_version =
        render::text_field(render::field_str(body, "app_version")?, "app_version", 32)?;
    Ok(NewDevice {
        name,
        platform,
        app_version,
        policy: DevicePolicy {
            per_file_max_bytes: 0,
            total_budget_bytes: 0,
        },
    })
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
    Ok(Response::json(200, &render::account(&record)))
}
