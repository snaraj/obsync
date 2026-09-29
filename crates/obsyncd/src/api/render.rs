//! Wire shapes in both directions: store records to the JSON of
//! `docs/protocol.md`, and the small parsers every handler needs.
//!
//! Every conversion between a storage type and JSON lives here so the shapes
//! are stated once and a change to a record is a one-file change.
#![forbid(unsafe_code)]

use std::io::ErrorKind;

use obsync_core::base64;
use obsync_core::hex;
use obsync_core::http::{Body, Request};
use obsync_core::json::{Value, obj, parse_limited};

use crate::log::Val;

use crate::storage::types::{
    AccountRecord, Change, DevicePolicy, DeviceRecord, FileRecord, FileSummary, GcSummary,
    ScrubSummary, SeenEvent, VersionRecord, VolumeStatus,
};
use crate::types::{DeviceId, DomainId, FileId, Seq, Sid, UnixMs, VersionId};

use super::{
    ApiError, App, FILE_RECORD_MAX, JSON_BODY_LIMIT, TOKEN_BODY_LIMIT, TOKEN_BODY_RESERVE,
    Unverified,
};

/// A JSON string.
pub fn s(v: &str) -> Value {
    Value::Str(v.to_string())
}

/// A JSON integer.
pub fn n(v: u64) -> Value {
    Value::Int(v as i64)
}

/// A JSON boolean.
pub fn b(v: bool) -> Value {
    Value::Bool(v)
}

/// A JSON array of strings.
pub fn strs<I: IntoIterator<Item = String>>(it: I) -> Value {
    Value::Array(it.into_iter().map(Value::Str).collect())
}

/// A journal sequence as a number.
pub fn seq(v: Seq) -> Value {
    n(seq_u64(v))
}

/// A journal sequence as a plain integer.
pub fn seq_u64(v: Seq) -> u64 {
    v.0
}

/// A unix-millisecond timestamp as a number.
pub fn ms(v: UnixMs) -> Value {
    n(ms_u64(v))
}

/// A unix-millisecond timestamp as a plain integer.
pub fn ms_u64(v: UnixMs) -> u64 {
    v.0
}

/// A value that may be absent, as JSON `null` or the rendered value.
pub fn maybe<T>(v: Option<T>, render: impl FnOnce(T) -> Value) -> Value {
    v.map_or(Value::Null, render)
}

/// `GET /v1/account`. The device count is the caller's, because the record
/// does not carry it and the store is the only place that knows.
pub fn account(a: &AccountRecord, device_count: u64) -> Value {
    obj(vec![
        ("account_id", s(&a.account_id.to_string())),
        ("name", s(&a.name)),
        ("created", ms(a.created)),
        ("quota_bytes", maybe(a.quota_bytes, n)),
        ("used_bytes", n(a.used_bytes)),
        ("device_count", n(device_count)),
    ])
}

/// One entry of `GET /v1/devices`.
pub fn device(d: &DeviceRecord) -> Value {
    obj(vec![
        ("device_id", s(&d.device_id.to_string())),
        ("name", s(&d.name)),
        ("platform", s(&d.platform)),
        ("app_version", s(&d.app_version)),
        ("created", ms(d.created)),
        ("last_seen", maybe(d.last_seen, ms)),
        ("last_sign_in", maybe(d.last_sign_in, ms)),
        ("last_edit", maybe(d.last_edit, ms)),
        ("address", maybe(d.address.as_deref(), s)),
        ("country", maybe(d.country.as_deref(), s)),
        ("policy", policy(&d.policy)),
        // `state` is the truth; `revoked` stays because the dashboard and the
        // plugin read it and a pending device is not a revoked one.
        ("state", s(d.state.as_word())),
        ("revoked", b(d.revoked())),
    ])
}

/// A device plus its retention-bounded activity, for the dashboard.
pub fn device_with_history(d: &DeviceRecord, history: &[SeenEvent]) -> Value {
    let mut v = match device(d) {
        Value::Object(fields) => fields,
        other => return other,
    };
    v.push((
        "history".to_string(),
        Value::Array(history.iter().map(seen).collect()),
    ));
    Value::Object(v)
}

/// One `seen` event.
pub fn seen(e: &SeenEvent) -> Value {
    obj(vec![
        ("ts", ms(e.ts)),
        ("event", s(e.kind.as_word())),
        ("address", maybe(e.address.as_deref(), s)),
        ("country", maybe(e.country.as_deref(), s)),
    ])
}

/// A device policy as the plugin reports and reads it.
pub fn policy(p: &DevicePolicy) -> Value {
    obj(vec![
        ("per_file_max_bytes", n(p.per_file_max_bytes)),
        ("total_budget_bytes", n(p.total_budget_bytes)),
    ])
}

/// One version record.
pub fn version(v: &VersionRecord) -> Value {
    obj(vec![
        ("version_id", s(&v.version_id.to_string())),
        ("parents", strs(v.parents.iter().map(ToString::to_string))),
        ("sids", strs(v.sids.iter().map(ToString::to_string))),
        ("bytes", n(v.bytes)),
        ("manifest_ct", s(&base64::encode(&v.manifest_ct))),
        ("manifest_nonce", s(&hex::encode(&v.manifest_nonce))),
        ("device_id", s(&v.device_id.to_string())),
        ("ts", ms(v.ts)),
        ("deleted", b(v.deleted)),
    ])
}

/// `GET /v1/files/{file_id}`.
///
/// The domain is stated once, on the file: every version of a file is in the
/// file's domain, so repeating it per version would be a second copy of one
/// fact (`docs/architecture.md` 5.1 item 4). The change feed carries its own,
/// because a feed entry arrives without its file.
///
/// Never past [`FILE_RECORD_MAX`] bytes of JSON: every head, then the other
/// versions newest first while the next one fits. The first that does not
/// fit ends them, so the record is always a file's newest versions, as the
/// retention cap already makes it. Returns the record and how many versions
/// it left out.
pub fn file(f: &FileRecord) -> (Value, usize) {
    file_measured(f, rendered_len)
}

/// A version's share of a record: its text and the comma after it.
fn rendered_len(version: &Value) -> usize {
    version.to_json().len() + 1
}

/// [`file`], with each version's share measured by `measure`: every version
/// is rendered once to be measured, and the kept ones again to be sent, so a
/// record past the bound never holds more than its own versions' text.
fn file_measured(f: &FileRecord, measure: fn(&Value) -> usize) -> (Value, usize) {
    let sized: Vec<(usize, bool)> = f
        .versions
        .iter()
        .map(|v| (measure(&version(v)), f.heads.contains(&v.version_id)))
        .collect();
    let keep = kept(file_of(f, Vec::new()).to_json().len(), &sized);
    let versions = f
        .versions
        .iter()
        .zip(&keep)
        .filter(|(_, keep)| **keep)
        .map(|(v, _)| version(v))
        .collect();
    let left_out = keep.iter().filter(|keep| !**keep).count();
    (file_of(f, versions), left_out)
}

/// Which versions a record keeps, given the size of everything else in it
/// and each version's share, newest first, with whether it is a head: every
/// head, then the others while the next fits under [`FILE_RECORD_MAX`], the
/// first that does not fit ending them. The bound is decided here and only
/// here, so it is tested at its real size with numbers (review of c5f79e8).
fn kept(skeleton: usize, sized: &[(usize, bool)]) -> Vec<bool> {
    let mut used = skeleton
        + sized
            .iter()
            .filter(|(_, head)| *head)
            .map(|(len, _)| len)
            .sum::<usize>();
    let mut open = true;
    sized
        .iter()
        .map(|&(len, head)| {
            if head {
                return true;
            }
            open = open && used + len <= FILE_RECORD_MAX as usize;
            if open {
                used += len;
            }
            open
        })
        .collect()
}

fn file_of(f: &FileRecord, versions: Vec<Value>) -> Value {
    obj(vec![
        ("file_id", s(&f.file_id.to_string())),
        ("domain_id", s(&f.domain_id.to_string())),
        ("heads", strs(f.heads.iter().map(ToString::to_string))),
        ("conflicted", b(f.conflicted)),
        ("versions", Value::Array(versions)),
    ])
}

/// One entry of `GET /v1/files`.
pub fn file_summary(f: &FileSummary) -> Value {
    obj(vec![
        ("file_id", s(&f.file_id.to_string())),
        ("domain_id", s(&f.domain_id.to_string())),
        ("heads", strs(f.heads.iter().map(ToString::to_string))),
        ("conflicted", b(f.conflicted)),
        ("latest_ts", ms(f.latest_ts)),
    ])
}

/// One entry of the change feed: the version that landed, its journal
/// position, and the file's heads as they stand now.
pub fn change(c: &Change) -> Value {
    let v = &c.version;
    obj(vec![
        ("seq", seq(v.seq)),
        ("file_id", s(&v.file_id.to_string())),
        ("domain_id", s(&v.domain_id.to_string())),
        ("version_id", s(&v.version_id.to_string())),
        ("parents", strs(v.parents.iter().map(ToString::to_string))),
        ("sids", strs(v.sids.iter().map(ToString::to_string))),
        ("bytes", n(v.bytes)),
        ("manifest_ct", s(&base64::encode(&v.manifest_ct))),
        ("manifest_nonce", s(&hex::encode(&v.manifest_nonce))),
        ("device_id", s(&v.device_id.to_string())),
        ("ts", ms(v.ts)),
        ("deleted", b(v.deleted)),
        ("heads", strs(c.heads.iter().map(ToString::to_string))),
        ("conflicted", b(c.conflicted)),
    ])
}

/// One volume: its role, the class label the operator gave it, and its
/// numbers. The mount point never leaves the process (requirement 6).
///
/// `usage_unverified` qualifies `bytes_used` rather than replacing it: the
/// figure is the last one that was read successfully, and saying so is more
/// useful to an operator than either hiding it or presenting it as current.
pub fn volume(v: &VolumeStatus) -> Value {
    obj(vec![
        ("role", s(&v.role)),
        ("path_class", s(&v.class_label)),
        ("bytes_total", n(v.bytes_total)),
        ("bytes_used", n(v.bytes_used)),
        ("bytes_free", n(v.bytes_free)),
        ("watermark_bytes", n(v.watermark_bytes)),
        ("usage_unverified", b(v.usage_unverified)),
    ])
}

/// The last garbage collection (`docs/protocol.md`, `<gc>`).
pub fn gc(g: &GcSummary) -> Value {
    obj(vec![
        ("ts", ms(g.started)),
        ("duration_ms", n(g.duration_ms)),
        ("chunks_collected", n(g.chunks_collected)),
        ("bytes_collected", n(g.bytes_collected)),
        ("chunks_retained", n(g.chunks_retained)),
    ])
}

/// The last scrub pass (`docs/protocol.md`, `<scrub>`).
pub fn scrub(v: &ScrubSummary) -> Value {
    obj(vec![
        ("ts", ms(v.started)),
        ("duration_ms", n(v.duration_ms)),
        ("chunks_verified", n(v.chunks_verified)),
        ("bytes_verified", n(v.bytes_verified)),
        ("mismatches", n(v.mismatches)),
        ("quarantined", n(v.quarantined.len() as u64)),
        ("complete_pass", b(v.complete_pass)),
    ])
}

/// The quarantine list of `GET /v1/admin/storage`.
///
/// What the server can state is the last scrub step's quarantined sids and
/// when that step ran; the byte count of a quarantined chunk is not tracked,
/// so it is reported as zero rather than guessed.
pub fn quarantine(last: Option<&ScrubSummary>) -> Value {
    let Some(summary) = last else {
        return Value::Array(Vec::new());
    };
    Value::Array(
        summary
            .quarantined
            .iter()
            .map(|sid| {
                obj(vec![
                    ("sid", s(&sid.to_string())),
                    ("ts", ms(summary.started)),
                    ("bytes", n(0)),
                    ("reason", s("sid_mismatch")),
                ])
            })
            .collect(),
    )
}

/// Read and parse a body whose credential rides inside it (setup, pairing
/// claim), under [`TOKEN_BODY_LIMIT`].
///
/// The reservation covers the body AND its parse ([`TOKEN_BODY_RESERVE`]),
/// and it stays with the value until the token verifies ([`Unverified`]), so
/// what an unverified caller makes this process keep, waiting included,
/// stays inside [`super::PREAUTH_BODY_BUDGET`].
///
/// # Errors
/// As [`read_body`], and `400 bad_json` when the body does not parse.
pub fn token_body<'a>(app: &'a App, req: &mut Request) -> Result<Unverified<'a, Value>, ApiError> {
    let raw = read_reserved(app, req, TOKEN_BODY_LIMIT, Some(TOKEN_BODY_RESERVE))?;
    let value = parse_json(&raw.value)?;
    Ok(Unverified {
        value,
        reserved: raw.reserved,
    })
}

/// Read a request body under an explicit ceiling.
///
/// Every caller reads its body before a credential has verified, so the read
/// holds a reservation against [`super::PREAUTH_BODY_BUDGET`], and the body
/// comes back [`Unverified`]: the reservation ends only when the caller's
/// credential check has passed or failed. A chunked body's length is unknown
/// until it ends, so it reserves the ceiling.
///
/// # Errors
/// `413 body_too_large` above the ceiling, `503 slow_body` for a body slower
/// than the rate floor, `503 body_incomplete` for one that ended or broke
/// before it was whole, `400 bad_request` for a chunked body whose framing is
/// not HTTP, and a bare `503` when the budget has no room for this body.
pub fn read_body<'a>(
    app: &'a App,
    req: &mut Request,
    limit: u64,
) -> Result<Unverified<'a, Vec<u8>>, ApiError> {
    read_reserved(app, req, limit, None)
}

/// [`read_body`], reserving `reserve` bytes, or the body's declared length
/// when `None`.
fn read_reserved<'a>(
    app: &'a App,
    req: &mut Request,
    limit: u64,
    reserve: Option<u64>,
) -> Result<Unverified<'a, Vec<u8>>, ApiError> {
    let declared = req.body.declared_len();
    if let Some(declared) = declared
        && declared > limit
    {
        return Err(ApiError::new(
            413,
            "body_too_large",
            "request body exceeds the limit",
        ));
    }
    let reserved = app.reserve_body(reserve.unwrap_or(declared.unwrap_or(limit)))?;
    match req.body.read_to_vec(limit as usize) {
        Ok(value) => Ok(Unverified { value, reserved }),
        Err(e) if e.kind() == ErrorKind::TimedOut => Err(slow_body(app, &req.body)),
        // The body refuses its ceiling once more than `limit` bytes of it
        // have arrived, and only then; the same kind below that is framing.
        Err(e) if e.kind() == ErrorKind::InvalidData && req.body.received() > limit => Err(
            ApiError::new(413, "body_too_large", "request body exceeds the limit"),
        ),
        Err(e) if e.kind() == ErrorKind::InvalidData => Err(ApiError::bad_request(
            "the chunked request body is not framed as HTTP",
        )),
        Err(e) => Err(incomplete_body(app, &req.body, &e)),
    }
}

/// A body that ended, or whose connection broke, before it was whole: the
/// client left, or something between it and the server gave up. Nothing
/// was wrong with its size, so it is not `413`; the request never arrived,
/// so a client retries it (`docs/protocol.md`, "Limits and headers"). One
/// line with what did arrive and how the read ended.
fn incomplete_body(app: &App, body: &Body, e: &std::io::Error) -> ApiError {
    app.log.warn(
        "request_body",
        &[
            ("decision", Val::word("refused")),
            ("reason", Val::word("body_incomplete")),
            ("io", Val::io(e)),
            ("bytes", Val::bytes(body.received())),
        ],
    );
    ApiError::new(
        503,
        "body_incomplete",
        "the request body did not arrive whole; retry",
    )
}

/// A body that arrived more slowly than the rate floor allows. That is the
/// sender's link and never the server's storage, so it has its own code and
/// a status every client retries, and one line with what arrived and the
/// time it was allowed (`docs/protocol.md`, "Limits and headers").
///
/// The body reports its own timeout as `TimedOut` and nothing else does:
/// every other failure of a read keeps the refusal it had.
pub fn slow_body(app: &App, body: &Body) -> ApiError {
    let budget = body.rate_budget().map_or(0, |b| b.as_millis() as u64);
    app.log.warn(
        "request_body",
        &[
            ("decision", Val::word("refused")),
            ("reason", Val::word("slow_body")),
            ("bytes", Val::bytes(body.received())),
            ("budget_ms", Val::ms(budget)),
        ],
    );
    ApiError::new(
        503,
        "slow_body",
        "the request body arrived more slowly than the server accepts; retry",
    )
}

/// Parse JSON bytes under the protocol's ceiling.
///
/// # Errors
/// `400 bad_json` when the bytes are not JSON within the depth and size limit.
pub fn parse_json(raw: &[u8]) -> Result<Value, ApiError> {
    parse_limited(raw, JSON_BODY_LIMIT as usize)
        .map_err(|_| ApiError::new(400, "bad_json", "body is not valid JSON"))
}

/// A required string field.
///
/// # Errors
/// `400 bad_request` when absent or not a string.
pub fn field_str<'a>(v: &'a Value, name: &str) -> Result<&'a str, ApiError> {
    v.get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request(format!("{name} must be a string")))
}

/// A required unsigned field.
///
/// # Errors
/// `400 bad_request` when absent or not a non-negative integer.
pub fn field_u64(v: &Value, name: &str) -> Result<u64, ApiError> {
    v.get(name)
        .and_then(Value::as_u64)
        .ok_or_else(|| ApiError::bad_request(format!("{name} must be a non-negative integer")))
}

/// An optional boolean field, defaulting to `false`.
pub fn field_bool(v: &Value, name: &str) -> bool {
    v.get(name).and_then(Value::as_bool).unwrap_or(false)
}

/// A required array of hex ids of one length, refusing anything else.
///
/// # Errors
/// `400 bad_request` when absent, not an array, too long, or malformed.
pub fn field_hex_array(
    v: &Value,
    name: &str,
    chars: usize,
    max: usize,
) -> Result<Vec<String>, ApiError> {
    let items = v
        .get(name)
        .and_then(Value::as_array)
        .ok_or_else(|| ApiError::bad_request(format!("{name} must be an array")))?;
    if items.len() > max {
        return Err(ApiError::bad_request(format!(
            "{name} holds at most {max} entries"
        )));
    }
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let text = item
            .as_str()
            .ok_or_else(|| ApiError::bad_request(format!("{name} holds hex strings")))?;
        if !super::is_hex(text, chars) {
            return Err(ApiError::bad_request(format!(
                "{name} holds {chars}-character hex ids"
            )));
        }
        out.push(text.to_string());
    }
    Ok(out)
}

/// Parse a storage id.
///
/// # Errors
/// `400 bad_request` when it is not 64 lowercase hex characters.
pub fn sid(v: &str) -> Result<Sid, ApiError> {
    v.parse::<Sid>()
        .map_err(|_| ApiError::bad_request("sid must be 64 hex characters"))
}

/// Parse a file id.
///
/// # Errors
/// `400 bad_request` when it is not 32 lowercase hex characters.
pub fn file_id(v: &str) -> Result<FileId, ApiError> {
    v.parse::<FileId>()
        .map_err(|_| ApiError::bad_request("file_id must be 32 hex characters"))
}

/// Parse a version id.
///
/// # Errors
/// `400 bad_request` when it is not 64 lowercase hex characters.
pub fn version_id(v: &str) -> Result<VersionId, ApiError> {
    v.parse::<VersionId>()
        .map_err(|_| ApiError::bad_request("version_id must be 64 hex characters"))
}

/// Parse a device id.
///
/// # Errors
/// `400 bad_request` when it is not 32 lowercase hex characters.
pub fn device_id(v: &str) -> Result<DeviceId, ApiError> {
    v.parse::<DeviceId>()
        .map_err(|_| ApiError::bad_request("device_id must be 32 hex characters"))
}

/// Parse a domain id.
///
/// # Errors
/// `400 bad_request` when it is not 32 lowercase hex characters.
pub fn domain_id(v: &str) -> Result<DomainId, ApiError> {
    v.parse::<DomainId>()
        .map_err(|_| ApiError::bad_request("domain_id must be 32 hex characters"))
}

/// A bounded free-text field: printable ASCII only, so a name from a device
/// cannot inject a control character into a log line or the dashboard.
///
/// # Errors
/// `400 bad_request` when it is empty, too long, or not printable ASCII.
pub fn text_field(v: &str, name: &str, max: usize) -> Result<String, ApiError> {
    let trimmed = v.trim();
    if trimmed.is_empty() || trimmed.len() > max {
        return Err(ApiError::bad_request(format!(
            "{name} must be 1..{max} characters"
        )));
    }
    if !trimmed.bytes().all(|c| (0x20..0x7f).contains(&c)) {
        return Err(ApiError::bad_request(format!(
            "{name} must be printable ASCII"
        )));
    }
    Ok(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The heap a parsed value holds: every `Vec` and `String` by its
    /// capacity, and 16 bytes of allocator bookkeeping for each.
    fn heap(value: &Value) -> usize {
        let block = |bytes: usize| if bytes == 0 { 0 } else { bytes + 16 };
        match value {
            Value::Str(text) => block(text.capacity()),
            Value::Array(items) => {
                block(items.capacity() * size_of::<Value>()) + items.iter().map(heap).sum::<usize>()
            }
            Value::Object(pairs) => {
                block(pairs.capacity() * size_of::<(String, Value)>())
                    + pairs
                        .iter()
                        .map(|(key, item)| block(key.capacity()) + heap(item))
                        .sum::<usize>()
            }
            _ => 0,
        }
    }

    /// Review of 7e1294d, finding 2: a token route's reservation covers its
    /// body and the parse of it. The costliest shapes a body of
    /// `TOKEN_BODY_LIMIT` bytes can take -- values two bytes apart, empty
    /// containers, unique keys, one-element arrays, and nests at the depth
    /// cap -- each parse, and body plus value fit what the read reserved.
    #[test]
    fn a_token_body_and_its_parse_fit_the_reservation() {
        let limit = usize::try_from(TOKEN_BODY_LIMIT).expect("fits");
        let fill = |open: &str, item: &dyn Fn(usize) -> String, close: &str| {
            let mut doc = open.to_string();
            let mut n = 0;
            loop {
                let next = format!("{}{}", if n == 0 { "" } else { "," }, item(n));
                if doc.len() + next.len() + close.len() > limit {
                    break;
                }
                doc.push_str(&next);
                n += 1;
            }
            doc.push_str(close);
            doc
        };
        let nest = "[".repeat(obsync_core::json::MAX_DEPTH - 1)
            + &"]".repeat(obsync_core::json::MAX_DEPTH - 1);
        let shapes = [
            ("numbers", fill("[", &|_| "0".to_string(), "]")),
            ("empty arrays", fill("[", &|_| "[]".to_string(), "]")),
            ("empty objects", fill("[", &|_| "{}".to_string(), "]")),
            ("empty strings", fill("[", &|_| "\"\"".to_string(), "]")),
            ("one-element arrays", fill("[", &|_| "[0]".to_string(), "]")),
            ("unique keys", fill("{", &|n| format!("\"{n}\":0"), "}")),
            ("nests", fill("[", &|_| nest.clone(), "]")),
        ];
        let mut worst = 0.0f64;
        for (name, doc) in &shapes {
            assert!(
                doc.len() <= limit && doc.len() > limit - 256,
                "{name}: {} bytes",
                doc.len()
            );
            let value = parse_json(doc.as_bytes()).unwrap_or_else(|e| panic!("{name}: {e:?}"));
            let held = doc.len() + heap(&value);
            worst = worst.max(held as f64 / doc.len() as f64);
            assert!(
                held as u64 <= TOKEN_BODY_RESERVE,
                "{name}: {held} bytes held for a {} byte body, {TOKEN_BODY_RESERVE} reserved",
                doc.len()
            );
        }
        // The reservation is not vacuous: the costliest shape needs most of
        // it, so a ceiling raised without it is caught here.
        assert!(
            worst * TOKEN_BODY_LIMIT as f64 > TOKEN_BODY_RESERVE as f64 / 8.0,
            "worst {worst:.1}x"
        );
    }

    /// A version `id` of a test file: `sids` chunks and a manifest of
    /// `manifest` bytes, as `files::post_version` accepts them.
    fn sized_version(id: u8, sids: usize, manifest: usize) -> VersionRecord {
        VersionRecord {
            file_id: FileId::new([0x11; 16]),
            domain_id: DomainId::new([0x22; 16]),
            version_id: VersionId::new([id; 32]),
            parents: Vec::new(),
            sids: (0..sids)
                .map(|n| {
                    let mut bytes = [id; 32];
                    bytes[..8].copy_from_slice(&(n as u64).to_be_bytes());
                    Sid::new(bytes)
                })
                .collect(),
            bytes: 8 * 1024 * 1024 * sids as u64,
            manifest_ct: vec![0xa5; manifest],
            manifest_nonce: [0x44; 12],
            device_id: DeviceId::new([0x55; 16]),
            ts: UnixMs(1_790_000_000_000 + u64::from(id)),
            deleted: false,
            seq: Seq(u64::from(id)),
        }
    }

    fn record_of(versions: Vec<VersionRecord>, heads: &[u8]) -> FileRecord {
        FileRecord {
            file_id: FileId::new([0x11; 16]),
            domain_id: DomainId::new([0x22; 16]),
            heads: heads.iter().map(|id| VersionId::new([*id; 32])).collect(),
            conflicted: heads.len() > 1,
            versions,
        }
    }

    fn ids(record: &Value) -> Vec<String> {
        record
            .get("versions")
            .and_then(Value::as_array)
            .expect("versions")
            .iter()
            .map(|v| v.get("version_id").and_then(Value::as_str).expect("id")[..2].to_string())
            .collect()
    }

    /// Review of 7e1294d, finding 1: the reviewer's history. Sixty retained
    /// versions of a file of 4,000 chunks of 8 MiB, each with a 648,152-byte
    /// manifest -- every one a version the server accepts -- render past the
    /// 64 MiB the plugin used to refuse, and are served whole.
    #[test]
    fn a_retained_history_past_sixty_four_mib_is_served_whole() {
        let versions: Vec<VersionRecord> = (1..=60u8)
            .rev()
            .map(|id| sized_version(id, 4000, 648_152))
            .collect();
        let (record, left_out) = file(&record_of(versions, &[60]));
        let json = record.to_json().len() as u64;
        assert_eq!(left_out, 0);
        assert_eq!(ids(&record).len(), 60);
        assert!(
            json > 64 * 1024 * 1024,
            "the history renders as {json} bytes"
        );
        assert!(json <= FILE_RECORD_MAX);
    }

    /// Review of c5f79e8, finding 1: the production bound, at its real size.
    /// Newest first: a head, two others, a second head, a small old one.
    /// Every head stays; the others are the newest that fit under 450 MiB;
    /// the first that does not fit ends them, even when an older, smaller
    /// one would fit after it; and a record that fits exactly is whole.
    #[test]
    fn the_record_bound_keeps_every_head_and_the_newest_versions_that_fit() {
        const MIB: usize = 1024 * 1024;
        let sized = [
            (200 * MIB, true),
            (100 * MIB, false),
            (200 * MIB, false),
            (50 * MIB, true),
            (1024, false),
        ];
        assert_eq!(kept(100, &sized), [true, true, false, true, false]);
        let max = FILE_RECORD_MAX as usize;
        assert_eq!(
            kept(0, &[(max - 10, false), (10, false), (1, false)]),
            [true, true, false],
            "a record at the bound is whole, and one byte more is left out"
        );
        assert_eq!(
            kept(max, &[(1, true), (1, false)]),
            [true, false],
            "every head, even past the bound"
        );
    }

    /// And the record `file` sends is the one `kept` chose: with each
    /// version measured 330,000 times larger, a small record passes the
    /// bound, and what is sent and counted as left out follows `kept`.
    #[test]
    fn a_record_measured_past_its_bound_sends_what_the_bound_keeps() {
        fn inflated(version: &Value) -> usize {
            rendered_len(version) * 330_000
        }
        let versions = vec![
            sized_version(0x50, 2, 100),
            sized_version(0x40, 1, 10),
            sized_version(0x30, 2, 100),
            sized_version(0x20, 2, 100),
            sized_version(0x10, 1, 10),
        ];
        let record = record_of(versions, &[0x50, 0x20]);
        let sized: Vec<(usize, bool)> = record
            .versions
            .iter()
            .map(|v| (inflated(&version(v)), record.heads.contains(&v.version_id)))
            .collect();
        let keep = kept(file_of(&record, Vec::new()).to_json().len(), &sized);
        let expected: Vec<String> = record
            .versions
            .iter()
            .zip(&keep)
            .filter(|(_, keep)| **keep)
            .map(|(v, _)| format!("{:02x}", v.version_id.as_bytes()[0]))
            .collect();
        assert!(
            keep.contains(&false) && expected.len() > 2,
            "the bound leaves some out and keeps a non-head: {keep:?}"
        );
        let (record_json, left_out) = file_measured(&record, inflated);
        assert_eq!(ids(&record_json), expected);
        assert_eq!(left_out, keep.iter().filter(|keep| !**keep).count());
        // Measured as sent, the same record is whole.
        assert_eq!(file(&record).1, 0);
    }

    #[test]
    fn a_versions_share_is_its_text_and_the_comma_after_it() {
        let value = version(&sized_version(0x50, 3, 100));
        assert_eq!(rendered_len(&value), value.to_json().len() + 1);
    }

    #[test]
    fn text_fields_refuse_control_characters_and_overlength() {
        assert!(text_field("MacBook", "name", 64).is_ok());
        assert!(text_field("Mac\nBook", "name", 64).is_err());
        assert!(text_field("   ", "name", 64).is_err());
        assert!(text_field(&"x".repeat(65), "name", 64).is_err());
    }

    #[test]
    fn hex_arrays_refuse_the_wrong_length_and_oversize_batches() {
        let v = parse_json(br#"{"sids":["00"]}"#).expect("json");
        assert!(field_hex_array(&v, "sids", 64, 8).is_err());
        let long = format!(
            r#"{{"sids":[{}]}}"#,
            vec!["\"".to_string() + &"a".repeat(64) + "\""; 3].join(",")
        );
        let v = parse_json(long.as_bytes()).expect("json");
        assert!(field_hex_array(&v, "sids", 64, 2).is_err());
        assert_eq!(field_hex_array(&v, "sids", 64, 8).expect("ok").len(), 3);
    }

    /// The response bound `docs/protocol.md` states under "Limits and
    /// headers", measured on the rendering rather than argued from it.
    ///
    /// Every ceiling below is a number in that document. The head list is the
    /// part `FILE_MAX_HEADS` bounds; the rest of a record is bounded by the
    /// per-version ceilings, and this is where a change to any of them stops
    /// being invisible.
    #[test]
    fn a_head_list_a_version_and_a_full_page_stay_under_the_documented_ceilings() {
        use crate::api::CHANGES_MAX_LIMIT;
        use crate::api::files::{MANIFEST_CT_MAX, VERSION_MAX_SIDS};
        use crate::config::Config;
        use crate::storage::FILE_MAX_HEADS;

        const HEADS_CEILING: usize = 8 * 1024;
        const VERSION_CEILING: u64 = 6 * 1024 * 1024;
        const PAGE_CEILING: u64 = 8 * 1024 * 1024;

        let heads: Vec<VersionId> = (0..FILE_MAX_HEADS)
            .map(|n| VersionId::new([n as u8; 32]))
            .collect();
        let sids: Vec<Sid> = (0..VERSION_MAX_SIDS)
            .map(|n| {
                let mut bytes = [0u8; 32];
                bytes[0] = (n >> 8) as u8;
                bytes[1] = n as u8;
                Sid::new(bytes)
            })
            .collect();
        // The ceiling is on the base64 the wire carries, and three bytes
        // become four characters, so this is the largest manifest a version
        // post can get past `files::post_version`.
        let manifest_ct = vec![0xa5u8; MANIFEST_CT_MAX / 4 * 3];
        // Every list at its ceiling at once: the widest version the server
        // will ever have to render.
        let worst = VersionRecord {
            file_id: FileId::new([0x11; 16]),
            domain_id: DomainId::new([0x22; 16]),
            version_id: VersionId::new([0x33; 32]),
            parents: heads.clone(),
            sids,
            bytes: u64::MAX,
            manifest_ct,
            manifest_nonce: [0x44; 12],
            device_id: DeviceId::new([0x55; 16]),
            ts: UnixMs(u64::MAX),
            deleted: false,
            seq: Seq(u64::MAX),
        };

        let bare = FileRecord {
            file_id: worst.file_id,
            domain_id: worst.domain_id,
            heads: Vec::new(),
            conflicted: false,
            versions: Vec::new(),
        };
        let conflicted = FileRecord {
            heads: heads.clone(),
            conflicted: true,
            ..bare.clone()
        };
        let heads_bytes = file(&conflicted).0.to_json().len() - file(&bare).0.to_json().len();
        assert!(
            heads_bytes <= HEADS_CEILING,
            "a full head list renders as {heads_bytes} bytes"
        );

        let version_bytes = version(&worst).to_json().len() as u64;
        assert!(
            version_bytes <= VERSION_CEILING,
            "the widest version renders as {version_bytes} bytes"
        );
        let entry = change(&Change {
            version: worst,
            heads,
            conflicted: true,
        });
        let change_bytes = entry.to_json().len() as u64;
        assert!(
            change_bytes <= VERSION_CEILING,
            "the widest change entry renders as {change_bytes} bytes"
        );

        // Every head is always in a record, at its widest, with room for
        // the rest: `file` can always keep its promise.
        let skeleton = file(&bare).0.to_json().len() as u64;
        let heads_only =
            skeleton + heads_bytes as u64 + FILE_MAX_HEADS as u64 * (version_bytes + 1);
        assert!(
            heads_only <= FILE_RECORD_MAX,
            "the heads alone reach {heads_only}"
        );
        // And at the shipped retention nothing is ever left out: retention's
        // versions plus one per head, all at their widest, fit.
        let versions = u64::from(Config::default().retention_versions) + FILE_MAX_HEADS as u64;
        let record = skeleton + heads_bytes as u64 + versions * (version_bytes + 1);
        assert!(record <= FILE_RECORD_MAX, "a file record reaches {record}");

        // A page stops at its byte budget and always carries one entry, so
        // the widest entry alone must fit under the page ceiling too. The
        // count ceiling is no longer what bounds a page: a thousand of these
        // would be about 6 GiB.
        assert!(
            change_bytes <= PAGE_CEILING,
            "one entry reaches {change_bytes}"
        );
        assert!(CHANGES_MAX_LIMIT * change_bytes > PAGE_CEILING);
    }
}
