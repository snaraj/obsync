//! Wire shapes in both directions: store records to the JSON of
//! `docs/protocol.md`, and the small parsers every handler needs.
//!
//! Every conversion between a storage type and JSON lives here so the shapes
//! are stated once and a change to a record is a one-file change.
#![forbid(unsafe_code)]

use obsync_core::base64;
use obsync_core::hex;
use obsync_core::http::Request;
use obsync_core::json::{Value, obj, parse_limited};

use crate::storage::types::{
    AccountRecord, Change, DevicePolicy, DeviceRecord, DomainRecord, FileRecord, FileSummary,
    GcSummary, ScrubSummary, SeenEvent, VersionRecord, VolumeStatus,
};
use crate::types::{DeviceId, DomainId, FileId, Seq, Sid, UnixMs, VersionId};

use super::{ApiError, JSON_BODY_LIMIT};

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
pub fn file(f: &FileRecord) -> Value {
    obj(vec![
        ("file_id", s(&f.file_id.to_string())),
        ("heads", strs(f.heads.iter().map(ToString::to_string))),
        ("conflicted", b(f.conflicted)),
        (
            "versions",
            Value::Array(f.versions.iter().map(version).collect()),
        ),
    ])
}

/// One entry of `GET /v1/files`.
pub fn file_summary(f: &FileSummary) -> Value {
    obj(vec![
        ("file_id", s(&f.file_id.to_string())),
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

/// One domain as `GET /v1/domains` reports it.
pub fn domain(d: &DomainRecord) -> Value {
    obj(vec![
        ("domain_id", s(&d.domain_id.to_string())),
        ("escrowed", b(d.escrowed)),
        ("created", ms(d.created)),
    ])
}

/// One volume: its role, the class label the operator gave it, and its
/// numbers. The mount point never leaves the process (requirement 6).
pub fn volume(v: &VolumeStatus) -> Value {
    obj(vec![
        ("role", s(&v.role)),
        ("path_class", s(&v.class_label)),
        ("bytes_total", n(v.bytes_total)),
        ("bytes_used", n(v.bytes_used)),
        ("bytes_free", n(v.bytes_free)),
        ("watermark_bytes", n(v.watermark_bytes)),
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

/// Read and parse a JSON request body under the protocol's 4 MiB ceiling.
///
/// # Errors
/// `413 body_too_large` above the ceiling, `400 bad_json` when it does not
/// parse, `400 bad_request` when the body cannot be read.
pub fn json_body(req: &mut Request) -> Result<Value, ApiError> {
    let raw = read_body(req, JSON_BODY_LIMIT)?;
    parse_json(&raw)
}

/// Read a request body under an explicit ceiling.
///
/// # Errors
/// `413 body_too_large` above the ceiling, `400 bad_request` on a read error.
pub fn read_body(req: &mut Request, limit: u64) -> Result<Vec<u8>, ApiError> {
    if let Some(declared) = req.body.declared_len()
        && declared > limit
    {
        return Err(ApiError::new(
            413,
            "body_too_large",
            "request body exceeds the limit",
        ));
    }
    req.body
        .read_to_vec(limit as usize)
        .map_err(|_| ApiError::new(413, "body_too_large", "request body exceeds the limit"))
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
}
