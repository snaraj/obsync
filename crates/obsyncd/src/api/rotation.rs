//! Device-authenticated, owner-authorized fresh-root coordination only.
#![forbid(unsafe_code)]
use super::edge::ClientInfo;
use super::{ApiError, App, auth, render, setup};
use crate::storage::rotation::{self, RotationCompletion, RotationIntent, RotationState};
use crate::types::Seq;
use obsync_core::http::{Request, Response};
use obsync_core::json::{Value, obj};

fn operation(op: &str) -> Result<(), ApiError> {
    if op.len() == 32
        && op
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        Ok(())
    } else {
        Err(ApiError::bad_request("invalid rotation operation"))
    }
}
fn integer(body: &Value, name: &str) -> Result<u64, ApiError> {
    body.get(name)
        .and_then(Value::as_u64)
        .ok_or_else(|| ApiError::bad_request(format!("invalid {name}")))
}
fn digest(body: &Value, name: &str) -> Result<String, ApiError> {
    rotation::hex_id(body, name, 64).map_err(|_| ApiError::bad_request(format!("invalid {name}")))
}
fn intent(body: &Value) -> Result<RotationIntent, ApiError> {
    RotationIntent::parse(
        body.get("intent")
            .ok_or_else(|| ApiError::bad_request("missing intent"))?,
    )
    .map_err(|_| ApiError::bad_request("invalid rotation intent"))
}
fn state(app: &App, r: &RotationState) -> Result<Response, ApiError> {
    let mut value = r.value();
    if let Value::Object(fields) = &mut value {
        fields.push((
            "catalog_hash".into(),
            Value::Str(app.store.rotation_catalog_commitment(r)?),
        ));
    }
    Ok(Response::json(200, &value))
}
fn close(app: &App) {
    let devices = app.store.devices();
    let mut sessions = app.sessions.lock().expect("sessions");
    for device in devices
        .into_iter()
        .filter(|d| d.state == crate::storage::DeviceState::Revoked)
    {
        sessions.close_for_device(&device.device_id);
    }
}
pub fn capabilities(
    app: &App,
    req: &mut Request,
    client: &ClientInfo,
) -> Result<Response, ApiError> {
    auth::device(app, req, client)?;
    Ok(Response::json(
        200,
        &obj(vec![
            ("rotation_protocol", Value::Int(1)),
            ("seal_suite", Value::Int(2)),
        ]),
    ))
}
pub fn prepare(app: &App, req: &mut Request, client: &ClientInfo) -> Result<Response, ApiError> {
    let caller = auth::device(app, req, client)?;
    let body = render::parse_json(&caller.body)?;
    setup::owner_token(app, &body)?;
    let r = app.store.prepare_rotation(caller.id, intent(&body)?)?;
    close(app);
    state(app, &r)
}
pub fn status(
    app: &App,
    req: &mut Request,
    client: &ClientInfo,
    op: &str,
) -> Result<Response, ApiError> {
    let caller = auth::device(app, req, client)?;
    operation(op)?;
    state(app, &app.store.rotation_status(caller.id, op)?)
}
pub fn inventory(
    app: &App,
    req: &mut Request,
    client: &ClientInfo,
    op: &str,
) -> Result<Response, ApiError> {
    let caller = auth::device(app, req, client)?;
    operation(op)?;
    let page = req
        .query_param("page")
        .unwrap_or("0")
        .parse::<u64>()
        .map_err(|_| ApiError::bad_request("invalid inventory page"))?;
    let heads = app.store.rotation_inventory(caller.id, op, page)?;
    let r = app.store.rotation_status(caller.id, op)?;
    Ok(Response::json(
        200,
        &obj(vec![
            ("operation", Value::Str(op.into())),
            ("cutoff", Value::from(r.cutoff.0)),
            ("inventory_hash", Value::Str(r.inventory_hash)),
            ("page", Value::from(page)),
            ("inventory_heads", Value::from(r.inventory_heads)),
            (
                "heads",
                Value::Array(
                    heads
                        .into_iter()
                        .map(|(f, v)| {
                            Value::Array(vec![Value::Str(f.to_string()), Value::Str(v.to_string())])
                        })
                        .collect(),
                ),
            ),
        ]),
    ))
}
pub fn catalog(
    app: &App,
    req: &mut Request,
    client: &ClientInfo,
    op: &str,
) -> Result<Response, ApiError> {
    let caller = auth::device(app, req, client)?;
    operation(op)?;
    let body = render::parse_json(&caller.body)?;
    let entries = rotation::catalog_parse(
        body.get("entries")
            .ok_or_else(|| ApiError::bad_request("missing catalog entries"))?,
    )
    .map_err(|_| ApiError::bad_request("invalid catalog entries"))?;
    state(
        app,
        &app.store
            .rotation_catalog(caller.id, op, integer(&body, "page")?, entries)?,
    )
}
pub fn commit(
    app: &App,
    req: &mut Request,
    client: &ClientInfo,
    op: &str,
) -> Result<Response, ApiError> {
    let caller = auth::device(app, req, client)?;
    operation(op)?;
    let body = render::parse_json(&caller.body)?;
    setup::owner_token(app, &body)?;
    let intent = intent(&body)?;
    if intent.operation != op {
        return Err(ApiError::bad_request("operation mismatch"));
    }
    let completion = RotationCompletion {
        cutoff: Seq(integer(&body, "cutoff")?),
        inventory_hash: digest(&body, "inventory_hash")?,
        catalog_pages: integer(&body, "catalog_pages")?,
        catalog_hash: digest(&body, "catalog_hash")?,
    };
    let r = app.store.commit_rotation(
        caller.id,
        &intent,
        &completion,
        crate::types::UnixMs(app.clock.unix_ms()),
    )?;
    close(app);
    state(app, &r)
}
