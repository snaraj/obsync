//! Public plugin release metadata (`docs/protocol.md`, "Plugin distribution").
//!
//! Installation and updates use Obsidian's native release assets.
#![forbid(unsafe_code)]

use obsync_core::http::Response;

use super::{ApiError, App};

/// `GET /v1/plugin/manifest`.
///
/// # Errors
/// `404 plugin_unavailable` when the server ships no bundle.
pub fn manifest(app: &App) -> Result<Response, ApiError> {
    let manifest = app.plugin.manifest().ok_or_else(unavailable)?;
    Ok(Response::json(200, manifest))
}

fn unavailable() -> ApiError {
    ApiError::new(
        404,
        "plugin_unavailable",
        "this server ships no plugin bundle",
    )
}
