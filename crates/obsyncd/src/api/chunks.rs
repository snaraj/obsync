//! Ciphertext chunk transfer (`docs/protocol.md`, "Chunks").
//!
//! The server never decrypts a chunk and never sees a plaintext byte: it
//! verifies `sid = SHA-256(ciphertext)` while streaming and stores what it was
//! given (AGENTS.md requirement 6).
#![forbid(unsafe_code)]

use std::io::{Read, Seek, SeekFrom};

use obsync_core::http::{MultipartWriter, Request, Response, parse_range};
use obsync_core::json::obj;

use crate::types::Sid;

use super::edge::ClientInfo;
use super::render::{self, s};
use super::{
    ApiError, App, CHUNK_BODY_LIMIT, EXISTS_MAX_SIDS, MULTIPART_MAX_SIDS,
    MULTIPART_MAX_TOTAL_BYTES, auth, rand,
};

/// Content type of a stored chunk: opaque ciphertext.
pub const CHUNK_CONTENT_TYPE: &str = "application/octet-stream";

/// `POST /v1/chunks/exists`: which of these sids does the server not hold?
///
/// # Errors
/// `400 bad_request` for a malformed or oversized list, plus the
/// authentication refusals.
pub fn exists(app: &App, req: &mut Request, client: &ClientInfo) -> Result<Response, ApiError> {
    let authed = auth::device(app, req, client)?;
    let body = render::parse_json(&authed.body)?;
    let sids = render::field_hex_array(&body, "sids", 64, EXISTS_MAX_SIDS)?;
    let parsed: Vec<Sid> = sids
        .iter()
        .map(|v| render::sid(v))
        .collect::<Result<_, _>>()?;
    let missing = app.store.missing_chunks(&parsed);
    Ok(Response::json(
        200,
        &obj(vec![(
            "missing",
            render::strs(missing.iter().map(ToString::to_string)),
        )]),
    ))
}

/// `PUT /v1/chunks/{sid}`: upload one chunk. The body hash is the sid, so the
/// signature is verified before a byte is read and the body streams straight
/// into the store.
///
/// # Errors
/// `400 length_required`, `413 body_too_large`, `422 sid_mismatch`,
/// `507 volume_full`, `507 quota_exceeded`, plus the authentication refusals.
pub fn put(
    app: &App,
    req: &mut Request,
    client: &ClientInfo,
    sid_hex: &str,
) -> Result<Response, ApiError> {
    let sid = render::sid(sid_hex)?;
    auth::device_chunk(app, req, client, sid_hex)?;
    let account = app.account_id()?;

    if req.body.is_chunked() {
        return Err(ApiError::new(
            411,
            "length_required",
            "chunk uploads require Content-Length",
        ));
    }
    let declared = req.body.declared_len().ok_or_else(|| {
        ApiError::new(
            411,
            "length_required",
            "chunk uploads require Content-Length",
        )
    })?;
    if declared > CHUNK_BODY_LIMIT {
        return Err(ApiError::new(
            413,
            "body_too_large",
            "chunk ciphertext is at most 8 MiB plus the 16-byte authentication tag",
        ));
    }

    let outcome = app
        .store
        .put_chunk(&account, &sid, declared, &mut req.body)?;
    let status = if stored_now(&outcome) { 201 } else { 200 };
    Ok(Response::json(status, &obj(vec![("sid", s(sid_hex))])))
}

/// `GET /v1/chunks/{sid}`, honoring a single `Range`.
///
/// # Errors
/// `404 unknown_chunk`, `416 range_not_satisfiable`, plus the authentication
/// refusals.
pub fn get(
    app: &App,
    req: &mut Request,
    client: &ClientInfo,
    sid_hex: &str,
) -> Result<Response, ApiError> {
    let sid = render::sid(sid_hex)?;
    auth::device(app, req, client)?;
    let (mut file, total) = app
        .store
        .open_chunk(&sid)
        .map_err(|_| ApiError::new(404, "unknown_chunk", "no such chunk"))?;

    let range = match req.headers.get("range") {
        Some(raw) => parse_range(raw, total).map_err(|_| {
            ApiError::new(
                416,
                "range_not_satisfiable",
                "the requested range is not satisfiable",
            )
        })?,
        None => None,
    };

    match range {
        None => Ok(
            Response::stream(200, CHUNK_CONTENT_TYPE, Box::new(file), total)
                .header("Accept-Ranges", "bytes"),
        ),
        Some((start, end)) => {
            let len = end.saturating_sub(start) + 1;
            file.seek(SeekFrom::Start(start)).map_err(|_| {
                ApiError::new(
                    416,
                    "range_not_satisfiable",
                    "the requested range is not satisfiable",
                )
            })?;
            Ok(
                Response::stream(206, CHUNK_CONTENT_TYPE, Box::new(file.take(len)), len)
                    .header("Accept-Ranges", "bytes")
                    .header("Content-Range", &format!("bytes {start}-{end}/{total}")),
            )
        }
    }
}

/// `POST /v1/chunks/get`: fetch up to 64 chunks in one `multipart/mixed`
/// response, one part per requested sid in request order.
///
/// A batch whose parts would exceed [`MULTIPART_MAX_TOTAL_BYTES`] is refused
/// rather than buffered: clients must split the request into smaller batches
/// or use `GET /v1/chunks/{sid}`, which streams.
///
/// # Errors
/// `400 bad_request`, `413 batch_too_large`, plus the authentication refusals.
pub fn batch_get(app: &App, req: &mut Request, client: &ClientInfo) -> Result<Response, ApiError> {
    let authed = auth::device(app, req, client)?;
    let body = render::parse_json(&authed.body)?;
    let sids = render::field_hex_array(&body, "sids", 64, MULTIPART_MAX_SIDS)?;
    let parsed: Vec<Sid> = sids
        .iter()
        .map(|v| render::sid(v))
        .collect::<Result<_, _>>()?;

    let mut total = 0u64;
    for sid in &parsed {
        total = total.saturating_add(app.store.chunk_len(sid).unwrap_or(0));
    }
    if total > MULTIPART_MAX_TOTAL_BYTES {
        return Err(ApiError::new(
            413,
            "batch_too_large",
            "this batch exceeds the multipart ceiling; fetch these sids one at a time",
        ));
    }

    let boundary = rand::hex_token(16)
        .map_err(|_| ApiError::new(500, "no_randomness", "the system CSPRNG is unavailable"))?;
    let mut writer = MultipartWriter::new(&boundary);
    for (hex, sid) in sids.iter().zip(parsed.iter()) {
        match read_chunk(app, sid) {
            Some(bytes) => {
                let len = bytes.len().to_string();
                writer.part(
                    &[
                        ("X-Obsync-Sid", hex.as_str()),
                        ("Content-Type", CHUNK_CONTENT_TYPE),
                        ("Content-Length", len.as_str()),
                    ],
                    &bytes,
                );
            }
            None => writer.part(
                &[
                    ("X-Obsync-Sid", hex.as_str()),
                    ("X-Obsync-Missing", "1"),
                    ("Content-Length", "0"),
                ],
                &[],
            ),
        }
    }
    let content_type = writer.content_type();
    Ok(Response::bytes(200, &content_type, writer.finish()))
}

/// Read one whole chunk, or `None` when the server does not hold it.
fn read_chunk(app: &App, sid: &Sid) -> Option<Vec<u8>> {
    let (mut file, len) = app.store.open_chunk(sid).ok()?;
    let mut buf = Vec::with_capacity(len as usize);
    file.read_to_end(&mut buf).ok()?;
    Some(buf)
}

/// Whether the store wrote the chunk now (`201`) or already held it (`200`).
fn stored_now(outcome: &crate::storage::types::PutOutcome) -> bool {
    matches!(outcome, crate::storage::types::PutOutcome::Created)
}
