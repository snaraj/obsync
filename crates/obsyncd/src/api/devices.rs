//! Device inventory, policy, revocation, and heartbeat
//! (`docs/protocol.md`, "Devices").
#![forbid(unsafe_code)]

use obsync_core::http::{Request, Response};
use obsync_core::json::{Value, obj};

use crate::storage::types::DevicePolicy;

use super::edge::ClientInfo;
use super::render::{self};
use super::{ApiError, App, auth};

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
            ("device", &target.to_string()),
            ("by", &authed.id.to_string()),
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
