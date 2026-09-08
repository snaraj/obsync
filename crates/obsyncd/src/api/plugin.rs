//! Plugin distribution (`docs/protocol.md`, "Plugin distribution").
//!
//! Unauthenticated by design: the bundle is public source, and a device that
//! has not paired yet still needs to install it.
#![forbid(unsafe_code)]

use obsync_core::http::Response;

use super::{ApiError, App};

/// Content type of the compiled plugin.
pub const BUNDLE_CONTENT_TYPE: &str = "text/javascript; charset=utf-8";
/// Content type of the plugin stylesheet.
pub const STYLES_CONTENT_TYPE: &str = "text/css; charset=utf-8";

/// `GET /v1/plugin/manifest`.
///
/// # Errors
/// `404 plugin_unavailable` when the server ships no bundle.
pub fn manifest(app: &App) -> Result<Response, ApiError> {
    let manifest = app.plugin.manifest().ok_or_else(unavailable)?;
    Ok(Response::json(200, manifest))
}

/// `GET /v1/plugin/bundle`.
///
/// # Errors
/// `404 plugin_unavailable` when the server ships no bundle.
pub fn bundle(app: &App) -> Result<Response, ApiError> {
    let bytes = app.plugin.bundle().ok_or_else(unavailable)?;
    Ok(Response::bytes(200, BUNDLE_CONTENT_TYPE, bytes.to_vec()))
}

/// `GET /v1/plugin/styles`.
///
/// # Errors
/// `404 plugin_unavailable` when the server ships no bundle.
pub fn styles(app: &App) -> Result<Response, ApiError> {
    let bytes = app.plugin.styles().ok_or_else(unavailable)?;
    Ok(Response::bytes(200, STYLES_CONTENT_TYPE, bytes.to_vec()))
}

fn unavailable() -> ApiError {
    ApiError::new(
        404,
        "plugin_unavailable",
        "this server ships no plugin bundle",
    )
}
