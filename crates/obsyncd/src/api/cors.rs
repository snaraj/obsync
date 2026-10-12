//! Stateless, credential-free CORS for the plugin transport routes only.
//! Cookie/admin/dashboard assets and health routes never receive a grant.
#![forbid(unsafe_code)]

use obsync_core::http::{Headers, Response};

use super::{ApiError, Route, is_hex, resolve};

const MAX_HEADER_LIST_BYTES: usize = 4096;
const MAX_HEADER_NAMES: usize = 64;
const MAX_HEADER_NAME_BYTES: usize = 128;

/// The closed set mirrors `plugin/src/transport.ts::ROUTES`. Route resolution
/// alone accepts malformed IDs and extra slashes; those are not plugin routes.
pub(super) fn allowlisted(method: &str, path: &str) -> bool {
    if !path.starts_with('/') || path.contains("//") || path.ends_with('/') {
        return false;
    }
    let Some((route, _)) = resolve(method, path) else {
        return false;
    };
    match route {
        Route::Setup
        | Route::Account
        | Route::RecoveryRegister
        | Route::PairingCreate
        | Route::Devices
        | Route::Heartbeat
        | Route::ChunksExists
        | Route::ChunksGet
        | Route::FilesPage
        | Route::Changes
        | Route::LoginLink
        | Route::PluginManifest => true,
        Route::PairingClaim(id)
        | Route::PairingState(id)
        | Route::PairingReveal(id)
        | Route::PairingApprove(id)
        | Route::PairingReject(id)
        | Route::PairingEnvelope(id)
        | Route::DevicePatch(id)
        | Route::DeviceRevoke(id)
        | Route::DeviceArchive(id)
        | Route::VersionPost(id)
        | Route::FileGet(id) => is_hex(&id, 32),
        Route::ChunkPut(sid) | Route::ChunkGet(sid) => is_hex(&sid, 64),
        Route::VersionGet(id, sid) => is_hex(&id, 32) && is_hex(&sid, 64),
        _ => false,
    }
}

/// Never authenticates, consumes a nonce, reads a body or touches storage.
pub(super) fn preflight(path: &str, headers: &Headers) -> Result<Response, ApiError> {
    let bad = || ApiError::bad_request("malformed CORS preflight");
    let origins = headers.all("Origin");
    let methods = headers.all("Access-Control-Request-Method");
    let requested = headers.all("Access-Control-Request-Headers");
    if origins.len() != 1
        || origins[0].is_empty()
        || origins[0].len() > MAX_HEADER_LIST_BYTES
        || !origins[0]
            .bytes()
            .all(|b| b > b' ' && b < 0x7f && b != b',')
        || methods.len() != 1
        || !matches!(methods[0], "GET" | "POST" | "PUT" | "PATCH" | "DELETE")
        || requested.len() > 1
    {
        return Err(bad());
    }
    let mut names = Vec::new();
    if let Some(list) = requested.first() {
        if list.is_empty()
            || list.len() > MAX_HEADER_LIST_BYTES
            || list.bytes().any(|b| b < b' ' || b == 0x7f)
        {
            return Err(bad());
        }
        for name in list.split(',') {
            let name = name.trim_matches(' ');
            if name.is_empty()
                || name.len() > MAX_HEADER_NAME_BYTES
                || !name.bytes().all(token_byte)
                || names.len() == MAX_HEADER_NAMES
            {
                return Err(bad());
            }
            let name = name.to_ascii_lowercase();
            if forbidden(&name) || names.contains(&name) {
                return Err(bad());
            }
            names.push(name);
        }
    }
    if !allowlisted(methods[0], path) {
        return Err(ApiError::not_found("no plugin route for this preflight"));
    }
    names.sort();
    let mut response = Response::empty(204)
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", methods[0])
        .header("Access-Control-Max-Age", "0")
        .header(
            "Vary",
            "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
        );
    if !names.is_empty() {
        response = response.header("Access-Control-Allow-Headers", &names.join(", "));
    }
    Ok(response)
}

fn token_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)
}

fn forbidden(name: &str) -> bool {
    // Fetch forbidden request-header names/prefixes:
    // https://fetch.spec.whatwg.org/#forbidden-request-header
    // Method-override names are rejected outright: preflight supplies no values
    // to establish their safety. User-Agent is additionally refused because
    // supported browsers may silently replace it; this is portability policy.
    // A literal '*' would become a wildcard response grant, so also refuse it.
    name.starts_with("proxy-")
        || name.starts_with("sec-")
        || matches!(
            name,
            "*" | "accept-charset"
                | "accept-encoding"
                | "access-control-request-headers"
                | "access-control-request-method"
                | "connection"
                | "content-length"
                | "cookie"
                | "cookie2"
                | "date"
                | "dnt"
                | "expect"
                | "host"
                | "keep-alive"
                | "origin"
                | "referer"
                | "set-cookie"
                | "te"
                | "trailer"
                | "transfer-encoding"
                | "upgrade"
                | "via"
                | "x-http-method"
                | "x-http-method-override"
                | "x-method-override"
                | "user-agent"
        )
}
