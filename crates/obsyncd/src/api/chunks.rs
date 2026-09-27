//! Ciphertext chunk transfer (`docs/protocol.md`, "Chunks").
//!
//! The server never decrypts a chunk and never sees a plaintext byte: it
//! verifies `sid = SHA-256(ciphertext)` while streaming and stores what it was
//! given (AGENTS.md requirement 6).
#![forbid(unsafe_code)]

use std::fs::File;
use std::io::{self, Cursor, Read, Seek, SeekFrom};
use std::path::PathBuf;

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
    // Authentication FIRST, and the path only then: a handler that validates
    // before it authenticates answers an unauthenticated caller something
    // other than `401`, which is a refusal that has to be classified as a
    // credentialed one to be logged truthfully. `auth::device_chunk` takes
    // the sid as the body hash and re-checks its shape itself.
    auth::device_chunk(app, req, client, sid_hex)?;
    let sid = render::sid(sid_hex)?;
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
    // Authentication first, the path afterwards: see `put`.
    auth::device(app, req, client)?;
    let sid = render::sid(sid_hex)?;
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
/// A batch whose parts would exceed [`MULTIPART_MAX_TOTAL_BYTES`] is refused:
/// clients must split the request into smaller batches or use
/// `GET /v1/chunks/{sid}`. Below it the response STREAMS ([`Batch`]), so a
/// batch holds the server's copy buffer and one open chunk at a time rather
/// than every part in memory, twice over, before its first byte leaves.
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

    // Each chunk is opened here, once, for its length and for whether the
    // volume holds it at all -- the same evidence a single GET answers from --
    // and closed again. The stream reopens it when it gets there.
    let lengths: Vec<Option<u64>> = parsed
        .iter()
        .map(|sid| app.store.open_chunk(sid).ok().map(|(_, len)| len))
        .collect();
    let total = lengths
        .iter()
        .flatten()
        .fold(0u64, |sum, len| sum.saturating_add(*len));
    if total > MULTIPART_MAX_TOTAL_BYTES {
        return Err(ApiError::new(
            413,
            "batch_too_large",
            "this batch exceeds the multipart ceiling; fetch these sids one at a time",
        ));
    }

    let boundary = rand::hex_token(16)
        .map_err(|_| ApiError::new(500, "no_randomness", "the system CSPRNG is unavailable"))?;
    let framing = MultipartWriter::new(&boundary);
    let mut segments = Vec::new();
    let mut pending = Vec::new();
    for ((hex, sid), len) in sids.iter().zip(&parsed).zip(&lengths) {
        match len {
            Some(len) => {
                pending.extend(framing.part_head(&[
                    ("X-Obsync-Sid", hex.as_str()),
                    ("Content-Type", CHUNK_CONTENT_TYPE),
                    ("Content-Length", &len.to_string()),
                ]));
                segments.push(Segment::Framing(std::mem::take(&mut pending)));
                segments.push(Segment::Chunk(app.store.chunk_path(sid), *len));
            }
            None => pending.extend(framing.part_head(&[
                ("X-Obsync-Sid", hex.as_str()),
                ("X-Obsync-Missing", "1"),
                ("Content-Length", "0"),
            ])),
        }
        pending.extend_from_slice(MultipartWriter::PART_END);
    }
    pending.extend(framing.close());
    segments.push(Segment::Framing(pending));
    let len = segments.iter().map(Segment::len).sum();
    Ok(Response::stream(
        200,
        &framing.content_type(),
        Box::new(Batch::new(segments)),
        len,
    ))
}

/// One stretch of a batch body: framing already in memory, or a chunk still
/// on the volume with the length it had when the batch was planned.
enum Segment {
    Framing(Vec<u8>),
    Chunk(PathBuf, u64),
}

impl Segment {
    fn len(&self) -> u64 {
        match self {
            Segment::Framing(bytes) => bytes.len() as u64,
            Segment::Chunk(_, len) => *len,
        }
    }
}

/// A batch body, read in order. A chunk is opened only when the stream
/// reaches it, so a batch costs one descriptor at a time however many sids it
/// names.
///
/// A chunk the volume no longer holds, or holds shorter than planned (a
/// collection or a quarantine between the plan and the read), fails the read
/// instead of framing the next part early: the response has promised its
/// `Content-Length`, so the connection closes and the client retries against
/// a fresh plan, which then names the chunk missing.
struct Batch {
    segments: std::vec::IntoIter<Segment>,
    reading: Option<(Box<dyn Read + Send>, u64)>,
}

impl Batch {
    fn new(segments: Vec<Segment>) -> Batch {
        Batch {
            segments: segments.into_iter(),
            reading: None,
        }
    }
}

impl Read for Batch {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        loop {
            match &mut self.reading {
                Some((_, 0)) => self.reading = None,
                Some((reader, left)) => {
                    let count = reader.read(out)?;
                    if count == 0 {
                        return Err(io::Error::new(
                            io::ErrorKind::UnexpectedEof,
                            "a chunk ended before the length its part declared",
                        ));
                    }
                    *left -= count as u64;
                    return Ok(count);
                }
                None => {
                    let Some(segment) = self.segments.next() else {
                        return Ok(0);
                    };
                    let left = segment.len();
                    let reader: Box<dyn Read + Send> = match segment {
                        Segment::Framing(bytes) => Box::new(Cursor::new(bytes)),
                        Segment::Chunk(path, len) => Box::new(File::open(path)?.take(len)),
                    };
                    self.reading = Some((reader, left));
                }
            }
        }
    }
}

/// Whether the store wrote the chunk now (`201`) or already held it (`200`).
fn stored_now(outcome: &crate::storage::types::PutOutcome) -> bool {
    matches!(outcome, crate::storage::types::PutOutcome::Created)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::testutil::TempDir;

    /// Two chunk files and the batch that frames them.
    fn planned(dir: &TempDir) -> (Batch, PathBuf) {
        let first = dir.path().join("first");
        let second = dir.path().join("second");
        std::fs::write(&first, b"one").expect("first chunk");
        std::fs::write(&second, b"two").expect("second chunk");
        let batch = Batch::new(vec![
            Segment::Framing(b"[".to_vec()),
            Segment::Chunk(first, 3),
            Segment::Framing(b"|".to_vec()),
            Segment::Chunk(second.clone(), 3),
            Segment::Framing(b"]".to_vec()),
        ]);
        (batch, second)
    }

    #[test]
    fn a_batch_streams_its_segments_in_order() {
        let dir = TempDir::new("batch-order");
        let (mut batch, _) = planned(&dir);
        let mut body = Vec::new();
        batch.read_to_end(&mut body).expect("the whole body");
        assert_eq!(body, b"[one|two]");
    }

    /// The property the stream exists for: a chunk is opened when the body
    /// reaches it and not before, so a batch never holds its chunks open, or
    /// in memory, all at once. A chunk that goes after the plan and before
    /// the read fails the read; an eager open would have read it anyway.
    #[test]
    fn a_batch_opens_each_chunk_only_when_its_stream_reaches_it() {
        let dir = TempDir::new("batch-lazy");
        let (mut batch, second) = planned(&dir);
        let mut head = [0u8; 4];
        batch.read_exact(&mut head).expect("the first part");
        assert_eq!(&head, b"[one");
        std::fs::remove_file(&second).expect("collected after the plan");
        let mut rest = Vec::new();
        let e = batch
            .read_to_end(&mut rest)
            .expect_err("the second chunk is opened only now, and is gone");
        assert_eq!(e.kind(), io::ErrorKind::NotFound);
    }

    /// A chunk shorter now than when it was planned cannot keep the length
    /// its part declared. The read fails rather than framing the next part
    /// early, so the client sees a broken response and never a misframed one.
    #[test]
    fn a_chunk_shorter_than_its_plan_fails_the_read_instead_of_misframing() {
        let dir = TempDir::new("batch-short");
        let path = dir.path().join("short");
        std::fs::write(&path, b"abc").expect("chunk");
        let mut batch = Batch::new(vec![
            Segment::Chunk(path, 5),
            Segment::Framing(b"--next".to_vec()),
        ]);
        let mut body = Vec::new();
        let e = batch.read_to_end(&mut body).expect_err("short chunk");
        assert_eq!(e.kind(), io::ErrorKind::UnexpectedEof);
        assert_eq!(body, b"abc", "nothing after the short chunk was framed");
    }
}
