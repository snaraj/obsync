//! Files and versions (`docs/protocol.md`, "Files and versions").
//!
//! The server sees opaque ids, ciphertext manifests, chunk lists, and the
//! shape of the version graph. It never resolves a conflict: a post whose
//! parents are not the current heads becomes an additional head and the file
//! is reported conflicted (`docs/architecture.md` 6.1).
#![forbid(unsafe_code)]

use obsync_core::base64;
use obsync_core::http::{Request, Response};
use obsync_core::json::{Value, obj};

use crate::storage::types::NewVersion;
use crate::types::{FileId, Sid, UnixMs, VersionId};

use super::edge::ClientInfo;
use super::render::{self, b, s};
use super::{ApiError, App, auth};

/// Largest encrypted manifest the server will store, in base64 characters.
/// A manifest holds one file's path, size, and chunk list; nothing here needs
/// to be large, and the ceiling bounds what one version post can cost.
pub const MANIFEST_CT_MAX: usize = 1024 * 1024;

/// Most chunks one version may reference.
pub const VERSION_MAX_SIDS: usize = 65_536;

/// Most parents one version may declare.
pub const VERSION_MAX_PARENTS: usize = 64;

/// `POST /v1/files/{file_id}/versions`.
///
/// # Errors
/// `400 bad_request`, `409 missing_chunks` (with the list),
/// `422 version_id_mismatch`, plus the authentication refusals.
pub fn post_version(
    app: &App,
    req: &mut Request,
    client: &ClientInfo,
    file_hex: &str,
) -> Result<Response, ApiError> {
    let authed = auth::device(app, req, client)?;
    let file_id: FileId = render::file_id(file_hex)?;
    let body = render::parse_json(&authed.body)?;

    let version_id: VersionId = render::version_id(render::field_str(&body, "version_id")?)?;
    let parents: Vec<VersionId> =
        render::field_hex_array(&body, "parents", 64, VERSION_MAX_PARENTS)?
            .iter()
            .map(|v| render::version_id(v))
            .collect::<Result<_, _>>()?;
    let sids: Vec<Sid> = render::field_hex_array(&body, "sids", 64, VERSION_MAX_SIDS)?
        .iter()
        .map(|v| render::sid(v))
        .collect::<Result<_, _>>()?;
    let bytes = render::field_u64(&body, "bytes")?;
    let deleted = render::field_bool(&body, "deleted");

    let manifest_ct_b64 = render::field_str(&body, "manifest_ct")?;
    if manifest_ct_b64.len() > MANIFEST_CT_MAX {
        return Err(ApiError::new(
            413,
            "body_too_large",
            "manifest_ct exceeds the ceiling",
        ));
    }
    let manifest_ct = base64::decode(manifest_ct_b64)
        .map_err(|_| ApiError::bad_request("manifest_ct must be base64"))?;
    let manifest_nonce_hex = render::field_str(&body, "manifest_nonce")?;
    if !super::is_hex(manifest_nonce_hex, 24) {
        return Err(ApiError::bad_request(
            "manifest_nonce must be 24 hex characters",
        ));
    }
    let manifest_nonce = obsync_core::hex::decode_array::<12>(manifest_nonce_hex)
        .map_err(|_| ApiError::bad_request("manifest_nonce must be 24 hex characters"))?;

    if deleted && !sids.is_empty() {
        return Err(ApiError::bad_request("a tombstone carries no sids"));
    }

    let ts = UnixMs(app.clock.unix_ms());
    let outcome = app.store.append_version(NewVersion {
        file_id,
        version_id,
        parents,
        sids,
        bytes,
        manifest_ct,
        manifest_nonce,
        deleted,
        device_id: authed.id,
        ts,
    })?;

    if !outcome.existing {
        auth::record_edit(app, &authed.id, client);
    }
    let status = if outcome.existing { 200 } else { 201 };
    Ok(Response::json(
        status,
        &obj(vec![
            ("seq", render::seq(outcome.seq)),
            (
                "heads",
                render::strs(outcome.heads.iter().map(ToString::to_string)),
            ),
            ("conflicted", b(outcome.conflicted)),
        ]),
    ))
}

/// `GET /v1/files/{file_id}`.
///
/// # Errors
/// `404 unknown_file`, plus the authentication refusals.
pub fn get_file(
    app: &App,
    req: &mut Request,
    client: &ClientInfo,
    file_hex: &str,
) -> Result<Response, ApiError> {
    auth::device(app, req, client)?;
    let file_id = render::file_id(file_hex)?;
    let record = app
        .store
        .file(&file_id)
        .ok_or_else(|| ApiError::new(404, "unknown_file", "no such file"))?;
    Ok(Response::json(200, &render::file(&record)))
}

/// `GET /v1/files/{file_id}/versions/{version_id}`.
///
/// # Errors
/// `404 unknown_version`, plus the authentication refusals.
pub fn get_version(
    app: &App,
    req: &mut Request,
    client: &ClientInfo,
    file_hex: &str,
    version_hex: &str,
) -> Result<Response, ApiError> {
    auth::device(app, req, client)?;
    let file_id = render::file_id(file_hex)?;
    let version_id = render::version_id(version_hex)?;
    let record = app
        .store
        .version(&file_id, &version_id)
        .ok_or_else(|| ApiError::new(404, "unknown_version", "no such version"))?;
    Ok(Response::json(200, &render::version(&record)))
}

/// `GET /v1/files?after=<file_id>&limit=<n>`: the reconciliation page.
///
/// # Errors
/// `400 bad_request` for a malformed cursor, plus the authentication refusals.
pub fn page(app: &App, req: &mut Request, client: &ClientInfo) -> Result<Response, ApiError> {
    let after = req.query_param("after").map(str::to_string);
    let limit = req.query_param("limit").map(str::to_string);
    auth::device(app, req, client)?;

    let after = match after.as_deref() {
        Some(v) => Some(render::file_id(v)?),
        None => None,
    };
    let limit = match limit.as_deref() {
        Some(v) => v
            .parse::<u64>()
            .map_err(|_| ApiError::bad_request("limit must be a number"))?,
        None => super::CHANGES_MAX_LIMIT,
    }
    .clamp(1, super::CHANGES_MAX_LIMIT);

    let (files, next) = app.store.files_page(after.as_ref(), limit as usize);
    let next = match next {
        Some(id) => s(&id.to_string()),
        None => Value::Null,
    };
    Ok(Response::json(
        200,
        &obj(vec![
            (
                "files",
                Value::Array(files.iter().map(render::file_summary).collect()),
            ),
            ("next", next),
        ]),
    ))
}
