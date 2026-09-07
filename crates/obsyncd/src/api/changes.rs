//! The change feed (`docs/protocol.md`, "Change feed").
//!
//! `wait` long-polls up to 55 s, inside the 100 s idle ceiling a free edge
//! zone imposes (`docs/architecture.md` 6.1). Both caps are constants.
#![forbid(unsafe_code)]

use std::time::Duration;

use obsync_core::http::{Request, Response};
use obsync_core::json::{Value, obj};

use crate::types::Seq;

use super::edge::ClientInfo;
use super::render;
use super::{ApiError, App, CHANGES_MAX_LIMIT, CHANGES_MAX_WAIT_SECS, auth};

/// `GET /v1/changes?since=<seq>&wait=<seconds>&limit=<n>`.
///
/// # Errors
/// `400 bad_request` for malformed parameters, `416 seq_ahead` when `since`
/// is beyond the journal head, plus the authentication refusals.
pub fn feed(app: &App, req: &mut Request, client: &ClientInfo) -> Result<Response, ApiError> {
    let since = number(req, "since", 0, u64::MAX)?;
    let wait = number(req, "wait", 0, CHANGES_MAX_WAIT_SECS)?;
    let limit = number(req, "limit", CHANGES_MAX_LIMIT, CHANGES_MAX_LIMIT)?.max(1);
    auth::device(app, req, client)?;

    let mut changes = app.store.changes(Seq(since), limit as usize)?;
    if changes.changes.is_empty() && wait > 0 {
        app.store
            .wait_for_change(Seq(since), Duration::from_secs(wait));
        changes = app.store.changes(Seq(since), limit as usize)?;
    }

    Ok(Response::json(
        200,
        &obj(vec![
            ("seq", render::seq(changes.seq)),
            ("head_seq", render::seq(changes.head_seq)),
            (
                "changes",
                Value::Array(changes.changes.iter().map(render::change).collect()),
            ),
        ]),
    ))
}

/// One query parameter, defaulted and capped. A value above the cap is
/// clamped, never an error: the cap is the server's, not the client's.
fn number(req: &Request, name: &str, default: u64, cap: u64) -> Result<u64, ApiError> {
    match req.query_param(name) {
        None => Ok(default),
        Some(raw) => {
            let v: u64 = raw
                .parse()
                .map_err(|_| ApiError::bad_request(format!("{name} must be a number")))?;
            Ok(v.min(cap))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_documented_caps_are_constants() {
        assert_eq!(CHANGES_MAX_WAIT_SECS, 55);
        assert_eq!(CHANGES_MAX_LIMIT, 1000);
    }
}
