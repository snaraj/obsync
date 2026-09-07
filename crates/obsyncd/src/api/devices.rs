//! Device inventory, policy, revocation, and heartbeat
//! (`docs/protocol.md`, "Devices").
#![forbid(unsafe_code)]

use obsync_core::hex;
use obsync_core::http::{Request, Response};
use obsync_core::json::{Value, obj};

use crate::log::Val;
use crate::storage::types::{DevicePolicy, DeviceRecord, NewDevice};

use super::edge::ClientInfo;
use super::render::{self};
use super::{ApiError, App, auth, rand};

/// `GET /v1/devices`.
///
/// # Errors
/// The device-authentication refusals.
pub fn list(app: &App, req: &mut Request, client: &ClientInfo) -> Result<Response, ApiError> {
    auth::device(app, req, client)?;
    Ok(Response::json(200, &devices_body(app)))
}

/// The `{"devices":[…]}` body shared with the dashboard endpoint.
pub fn devices_body(app: &App) -> Value {
    let devices: Vec<Value> = app.store.devices().iter().map(render::device).collect();
    obj(vec![("devices", Value::Array(devices))])
}

/// What a caller must say to enrol a device.
pub struct Enrolment {
    /// User-chosen name, already validated as printable ASCII.
    pub name: String,
    /// One of `docs/protocol.md`'s platform words.
    pub platform: String,
    /// The plugin version the device reports.
    pub app_version: String,
}

/// Mint a device secret, create the device, and hand back its record with the
/// secret as hex.
///
/// The two callers are `POST /v1/setup` for device one and a pairing claim for
/// every device after it; they are the only places the server ever states a
/// device secret, and it goes to the device that will use it and nowhere else.
///
/// # Errors
/// `500 no_randomness` when the CSPRNG is unavailable, `409 not_set_up` before
/// setup, or whatever the store refuses with.
pub fn enrol(app: &App, e: Enrolment) -> Result<(DeviceRecord, String), ApiError> {
    let account_id = app.account_id()?;
    let mut secret = [0u8; 32];
    rand::fill(&mut secret)
        .map_err(|_| ApiError::new(500, "no_randomness", "the system CSPRNG is unavailable"))?;
    let record = app.store.create_device(NewDevice {
        account_id,
        name: e.name,
        platform: e.platform,
        app_version: e.app_version,
        secret,
    })?;
    Ok((record, hex::encode(&secret)))
}

/// The platforms a device may declare (`docs/protocol.md`, "Pairing").
pub const PLATFORMS: [&str; 6] = ["ios", "ipados", "android", "macos", "windows", "linux"];

/// Read and validate the `{name, platform, app_version}` a device describes
/// itself with, wherever it appears.
///
/// # Errors
/// `400 bad_request` for a missing field, an unprintable name, or a platform
/// this protocol does not name.
pub fn enrolment_fields(body: &Value) -> Result<Enrolment, ApiError> {
    let name = render::text_field(render::field_str(body, "name")?, "name", 64)?;
    let platform = render::field_str(body, "platform")?.to_string();
    if !PLATFORMS.contains(&platform.as_str()) {
        return Err(ApiError::bad_request(
            "platform is not one of the supported platforms",
        ));
    }
    let app_version =
        render::text_field(render::field_str(body, "app_version")?, "app_version", 32)?;
    Ok(Enrolment {
        name,
        platform,
        app_version,
    })
}

/// `PATCH /v1/devices/{id}`: rename a device or change its ceilings. Any
/// paired device may edit any device, which is how a user fixes a phone from a
/// laptop (`docs/protocol.md`, "Devices").
///
/// # Errors
/// `400 bad_request`, `404 unknown_device`, plus the authentication refusals.
pub fn patch(
    app: &App,
    req: &mut Request,
    client: &ClientInfo,
    id: &str,
) -> Result<Response, ApiError> {
    let authed = auth::device(app, req, client)?;
    let target = render::device_id(id)?;
    let body = render::parse_json(&authed.body)?;

    let name = match body.get("name") {
        Some(v) => Some(render::text_field(
            v.as_str()
                .ok_or_else(|| ApiError::bad_request("name must be a string"))?,
            "name",
            64,
        )?),
        None => None,
    };
    let policy = parse_policy(&body)?;
    if name.is_none() && policy.is_none() {
        return Err(ApiError::bad_request("nothing to change"));
    }
    let record = app.store.update_device(&target, name, policy, None)?;
    Ok(Response::json(200, &render::device(&record)))
}

/// `POST /v1/devices/{id}/revoke`.
///
/// # Errors
/// `404 unknown_device`, `409 last_device` when a device tries to revoke
/// itself while it is the only one, plus the authentication refusals.
pub fn revoke(
    app: &App,
    req: &mut Request,
    client: &ClientInfo,
    id: &str,
) -> Result<Response, ApiError> {
    let authed = auth::device(app, req, client)?;
    let target = render::device_id(id)?;
    let live = app.store.devices().iter().filter(|d| !d.revoked).count();
    if target == authed.id && live <= 1 {
        return Err(ApiError::new(
            409,
            "last_device",
            "the only device cannot revoke itself; pair another first",
        ));
    }
    app.store.revoke_device(&target)?;
    app.log.warn(
        "device_revoked",
        &[
            ("device", Val::device(&target)),
            ("by_device", Val::device(&authed.id)),
        ],
    );
    Ok(Response::empty(204))
}

/// `POST /v1/devices/heartbeat`: the plugin reports liveness, its version, and
/// the ceilings it is enforcing, on start and hourly.
///
/// # Errors
/// `400 bad_request` plus the authentication refusals.
pub fn heartbeat(app: &App, req: &mut Request, client: &ClientInfo) -> Result<Response, ApiError> {
    let authed = auth::device(app, req, client)?;
    let body = render::parse_json(&authed.body)?;
    let app_version =
        render::text_field(render::field_str(&body, "app_version")?, "app_version", 32)?;
    let policy = parse_policy(&body)?;
    app.store
        .update_device(&authed.id, None, policy, Some(app_version))?;
    auth::record_heartbeat(app, &authed.id, client);
    Ok(Response::empty(204))
}

/// The optional `policy` object of a PATCH or heartbeat body.
fn parse_policy(body: &Value) -> Result<Option<DevicePolicy>, ApiError> {
    let Some(p) = body.get("policy") else {
        return Ok(None);
    };
    if p.is_null() {
        return Ok(None);
    }
    Ok(Some(DevicePolicy {
        per_file_max_bytes: render::field_u64(p, "per_file_max_bytes")?,
        total_budget_bytes: render::field_u64(p, "total_budget_bytes")?,
    }))
}
