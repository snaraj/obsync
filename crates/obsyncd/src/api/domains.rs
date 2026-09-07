//! Domains (`docs/protocol.md`, "Domains (sharing)").
//!
//! A domain is the unit of sharing and escrow. The server tracks the id and
//! whether a key is escrowed; which paths belong to a domain is client-side
//! metadata it never sees (`docs/architecture.md` 3.1).
#![forbid(unsafe_code)]

use obsync_core::http::{Request, Response};
use obsync_core::json::{Value, obj};

use super::edge::ClientInfo;
use super::render;
use super::{ApiError, App, auth};

/// `GET /v1/domains`.
///
/// # Errors
/// The device-authentication refusals.
pub fn list(app: &App, req: &mut Request, client: &ClientInfo) -> Result<Response, ApiError> {
    auth::device(app, req, client)?;
    Ok(Response::json(200, &domains_body(app)))
}

/// The `{"domains":[…]}` body shared with the dashboard endpoint.
pub fn domains_body(app: &App) -> Value {
    let domains: Vec<Value> = app.store.domains().iter().map(render::domain).collect();
    obj(vec![("domains", Value::Array(domains))])
}

/// `POST /v1/domains`.
///
/// # Errors
/// `400 bad_request` for a malformed id, plus the authentication refusals.
pub fn create(app: &App, req: &mut Request, client: &ClientInfo) -> Result<Response, ApiError> {
    let authed = auth::device(app, req, client)?;
    let body = render::parse_json(&authed.body)?;
    let domain_id = render::domain_id(render::field_str(&body, "domain_id")?)?;
    app.store.create_domain(domain_id)?;
    Ok(Response::json(
        201,
        &obj(vec![("domain_id", render::s(&domain_id.to_string()))]),
    ))
}
