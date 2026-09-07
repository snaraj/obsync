//! The append-only journal and the index snapshots beside it.
//!
//! docs/storage.md, "Journal frames" and "Durability rules" 2 and 3. A frame
//! is `u32 len | u32 crc32(payload) | payload`, the payload is canonical JSON
//! naming its type in `t`, segments roll at 64 MiB, and every append is
//! fsynced before the caller may acknowledge it. Replay stops at the first
//! torn or CRC-failing frame, truncates the segment there, and reports how
//! many frames survived (requirement 12).
//!
//! This module owns the whole on-disk format: nothing else in the server
//! encodes or decodes a frame.
#![forbid(unsafe_code)]

use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use obsync_core::crc32::crc32;
use obsync_core::hex;
use obsync_core::json::{self, Value};

use crate::storage::index::{DeviceEntry, FileEntry, Index};
use crate::storage::types::{
    DevicePolicy, DeviceRecord, DeviceState, DomainRecord, GcSummary, ScrubSummary, SeenEvent,
    SeenKind, StoreError, VersionRecord,
};
use crate::types::{AccountId, DeviceId, DomainId, FileId, Seq, Sid, UnixMs, VersionId};

#[cfg(test)]
use crate::storage::Fault;
#[cfg(test)]
use std::sync::Mutex;

/// Segments roll at this size (docs/storage.md, on-disk layout).
const SEGMENT_MAX: u64 = 64 * 1024 * 1024;
/// Snapshots kept on disk. Two, so a snapshot that turns out to be unreadable
/// still leaves an older one to replay from.
const SNAPSHOTS_KEPT: usize = 2;
const FILE_MODE: u32 = 0o600;
const DIR_MODE: u32 = 0o700;
/// Frame header: length and CRC.
const HEADER: usize = 8;

/// One journalled fact. Everything the server remembers is a sequence of these.
#[derive(Clone, Debug)]
pub(crate) enum Frame {
    /// Setup ran.
    Account {
        account_id: AccountId,
        name: String,
        created: UnixMs,
        quota_bytes: Option<u64>,
    },
    /// A device was paired. `wrapped` is the secret under the server key.
    Device {
        record: DeviceRecord,
        wrapped: [u8; 32],
    },
    /// A device's mutable fields changed.
    DeviceUpdate {
        device_id: DeviceId,
        name: Option<String>,
        policy: Option<DevicePolicy>,
        app_version: Option<String>,
    },
    /// A pairing's creator approved the claimant: it becomes active.
    DeviceActivate { device_id: DeviceId },
    /// A device was revoked; its wrapped secret is destroyed.
    DeviceRevoke { device_id: DeviceId },
    /// A device was deleted (a rejected pairing).
    DeviceDelete { device_id: DeviceId },
    /// A version landed.
    Version(VersionRecord),
    /// A domain was declared.
    Domain {
        domain_id: DomainId,
        created: UnixMs,
    },
    /// A device was seen.
    Seen {
        device_id: DeviceId,
        event: SeenEvent,
    },
    /// A collection run: which chunks went, and which versions retention
    /// pruned, so replay reaches the same index the run left behind.
    Gc {
        sids: Vec<Sid>,
        pruned: Vec<(FileId, VersionId)>,
        summary: GcSummary,
    },
    /// A scrub step, including anything it quarantined.
    Scrub { summary: ScrubSummary },
}

/// A frame with its journal position and the account it belongs to.
#[derive(Clone, Debug)]
pub(crate) struct Record {
    pub(crate) seq: Seq,
    pub(crate) account_id: Option<AccountId>,
    pub(crate) frame: Frame,
}

/// What one replay found, for the startup log line.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ReplayReport {
    /// Segments read.
    pub(crate) segments: u64,
    /// Frames applied.
    pub(crate) frames: u64,
    /// Bytes cut from a torn tail.
    pub(crate) truncated_bytes: u64,
}

/// The journal volume: segments, snapshots, quarantine.
pub(crate) struct Journal {
    root: PathBuf,
    segment: Option<File>,
    segment_no: u32,
    segment_len: u64,
    #[cfg(test)]
    fault: Mutex<Fault>,
}

impl Journal {
    /// Create the layout and open the newest segment for appending.
    pub(crate) fn open(journal_dir: &Path) -> Result<Journal, StoreError> {
        let root = journal_dir.join("v1");
        make_dir(&root.join("journal"))?;
        make_dir(&root.join("index"))?;
        let mut journal = Journal {
            root,
            segment: None,
            segment_no: 0,
            segment_len: 0,
            #[cfg(test)]
            fault: Mutex::new(Fault::None),
        };
        journal.segment_no = journal.segments()?.last().copied().unwrap_or(1);
        Ok(journal)
    }

    /// Where quarantined chunks go (docs/storage.md, on-disk layout).
    pub(crate) fn quarantine_dir(&self) -> PathBuf {
        self.root.join("quarantine")
    }

    fn segment_path(&self, number: u32) -> PathBuf {
        self.root.join("journal").join(format!("{number:06}.log"))
    }

    /// Segment numbers present, ascending.
    fn segments(&self) -> Result<Vec<u32>, StoreError> {
        let mut numbers = Vec::new();
        let dir = self.root.join("journal");
        match fs::read_dir(&dir) {
            Ok(entries) => {
                for entry in entries {
                    let path = entry?.path();
                    if let Some(number) = path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .and_then(|n| n.strip_suffix(".log"))
                        .and_then(|n| n.parse::<u32>().ok())
                    {
                        numbers.push(number);
                    }
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(StoreError::Io(e)),
        }
        numbers.sort_unstable();
        Ok(numbers)
    }

    /// Append one record and fsync it. The caller may acknowledge afterwards,
    /// never before (docs/storage.md, durability rule 4).
    pub(crate) fn append(&mut self, record: &Record) -> Result<(), StoreError> {
        let payload = record.to_value().to_json().into_bytes();
        let mut bytes = Vec::with_capacity(HEADER + payload.len());
        bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&crc32(&payload).to_le_bytes());
        bytes.extend_from_slice(&payload);

        if self.segment.is_none() || self.segment_len + bytes.len() as u64 > SEGMENT_MAX {
            self.roll()?;
        }
        #[cfg(test)]
        let mid_append = self.armed(Fault::JournalMidAppend);
        // A frame whose payload does not match its CRC: replay must refuse it
        // exactly as it refuses a torn one.
        #[cfg(test)]
        if self.armed(Fault::JournalTornFrame) {
            let last = bytes.len() - 1;
            bytes[last] ^= 0xff;
        }
        let file = self.segment.as_mut().expect("a segment is open");

        // A crash part way through a frame leaves a torn tail: replay
        // truncates it and reports the loss.
        #[cfg(test)]
        if mid_append {
            let half = bytes.len() / 2;
            file.write_all(&bytes[..half])?;
            file.sync_all()?;
            self.segment_len += half as u64;
            return Err(StoreError::Io(io::Error::new(
                io::ErrorKind::Interrupted,
                "injected crash",
            )));
        }

        file.write_all(&bytes)?;
        file.sync_all()?;
        self.segment_len += bytes.len() as u64;
        Ok(())
    }

    /// Open the next segment, fsyncing the directory that names it.
    fn roll(&mut self) -> Result<(), StoreError> {
        let existing = self.segments()?;
        let number = match existing.last() {
            Some(last) if self.segment.is_none() => *last,
            Some(last) => last + 1,
            None => 1,
        };
        let path = self.segment_path(number);
        let file = OpenOptions::new()
            .append(true)
            .create(true)
            .mode(FILE_MODE)
            .open(&path)?;
        self.segment_len = file.metadata()?.len();
        self.segment = Some(file);
        self.segment_no = number;
        fsync_dir(&self.root.join("journal"))
    }

    /// Replay every frame after `after` into `apply`.
    ///
    /// Stops at the first frame that is torn or fails its CRC, truncates the
    /// segment there, and returns what survived. A torn frame in anything but
    /// the last segment is corruption rather than a crash, and is refused.
    pub(crate) fn replay(
        &mut self,
        after: Seq,
        apply: &mut dyn FnMut(&Record),
    ) -> Result<ReplayReport, StoreError> {
        let mut report = ReplayReport::default();
        let numbers = self.segments()?;
        for (position, number) in numbers.iter().enumerate() {
            report.segments += 1;
            let path = self.segment_path(*number);
            let mut file = File::open(&path)?;
            let mut offset: u64 = 0;
            loop {
                match read_frame(&mut file)? {
                    FrameRead::Frame { payload, size } => {
                        let record = Record::decode(&payload)?;
                        if record.seq > after {
                            apply(&record);
                            report.frames += 1;
                        }
                        offset += size;
                    }
                    FrameRead::End => break,
                    FrameRead::Torn { remaining } => {
                        let is_last = position + 1 == numbers.len();
                        if !is_last {
                            return Err(StoreError::Corrupt(format!(
                                "segment {number:06} is torn but is not the last segment"
                            )));
                        }
                        drop(file);
                        let handle = OpenOptions::new().write(true).open(&path)?;
                        handle.set_len(offset)?;
                        handle.sync_all()?;
                        fsync_dir(&self.root.join("journal"))?;
                        report.truncated_bytes = remaining;
                        self.segment = None;
                        return Ok(report);
                    }
                }
            }
        }
        self.segment = None;
        Ok(report)
    }

    /// Write a snapshot of `index`, then drop what it supersedes.
    pub(crate) fn snapshot(&mut self, index: &Index) -> Result<(), StoreError> {
        let seq = index.seq;
        let payload = snapshot_value(index).to_json().into_bytes();
        let mut bytes = Vec::with_capacity(HEADER + payload.len());
        bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&crc32(&payload).to_le_bytes());
        bytes.extend_from_slice(&payload);

        let dir = self.root.join("index");
        let tmp = dir.join(format!("{}.tmp", seq.0));
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(FILE_MODE)
            .open(&tmp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, dir.join(format!("{}.snap", seq.0)))?;
        fsync_dir(&dir)?;
        self.prune(seq)
    }

    /// Delete superseded snapshots and the segments they cover.
    fn prune(&mut self, through: Seq) -> Result<(), StoreError> {
        let mut snapshots = self.snapshots()?;
        while snapshots.len() > SNAPSHOTS_KEPT {
            let (seq, path) = snapshots.remove(0);
            let _ = seq;
            fs::remove_file(path)?;
        }
        let oldest_kept = snapshots.first().map(|(seq, _)| *seq).unwrap_or(through);
        // A segment can go once a kept snapshot covers every frame in it,
        // which is true when the next segment's first frame is still covered.
        let numbers = self.segments()?;
        for pair in numbers.windows(2) {
            let (number, next) = (pair[0], pair[1]);
            let next_first = match self.first_seq(next)? {
                Some(seq) => seq,
                None => continue,
            };
            if next_first <= oldest_kept.next() && Some(number) != Some(self.segment_no) {
                fs::remove_file(self.segment_path(number))?;
            }
        }
        fsync_dir(&self.root.join("journal"))
    }

    /// The sequence of the first frame in a segment.
    fn first_seq(&self, number: u32) -> Result<Option<Seq>, StoreError> {
        let mut file = File::open(self.segment_path(number))?;
        match read_frame(&mut file)? {
            FrameRead::Frame { payload, .. } => Ok(Some(Record::decode(&payload)?.seq)),
            _ => Ok(None),
        }
    }

    /// Snapshots on disk, oldest first.
    fn snapshots(&self) -> Result<Vec<(Seq, PathBuf)>, StoreError> {
        let mut found = Vec::new();
        for entry in fs::read_dir(self.root.join("index"))? {
            let path = entry?.path();
            if let Some(seq) = path
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(|n| n.strip_suffix(".snap"))
                .and_then(|n| n.parse::<u64>().ok())
            {
                found.push((Seq(seq), path));
            }
        }
        found.sort_by_key(|(seq, _)| *seq);
        Ok(found)
    }

    /// Load the newest snapshot that reads cleanly, newest first.
    ///
    /// Returns the index it held and how many snapshots were unreadable, so
    /// the startup line can say a snapshot was skipped rather than hiding it.
    pub(crate) fn load_snapshot(&self) -> Result<(Option<Index>, u64), StoreError> {
        let mut skipped = 0;
        for (_, path) in self.snapshots()?.into_iter().rev() {
            let mut file = File::open(&path)?;
            match read_frame(&mut file)? {
                FrameRead::Frame { payload, .. } => match json::parse(&payload) {
                    Ok(value) => match index_from_value(&value) {
                        Ok(index) => return Ok((Some(index), skipped)),
                        Err(_) => skipped += 1,
                    },
                    Err(_) => skipped += 1,
                },
                _ => skipped += 1,
            }
        }
        Ok((None, skipped))
    }

    /// Verify every frame's CRC without applying it (`obsyncd check`).
    pub(crate) fn verify(&self) -> Result<(u64, u64, u64), StoreError> {
        let mut frames = 0;
        let mut bad = 0;
        let mut segments = 0;
        for number in self.segments()? {
            segments += 1;
            let mut file = File::open(self.segment_path(number))?;
            loop {
                match read_frame(&mut file)? {
                    FrameRead::Frame { payload, .. } => match Record::decode(&payload) {
                        Ok(_) => frames += 1,
                        Err(_) => bad += 1,
                    },
                    FrameRead::End => break,
                    FrameRead::Torn { .. } => {
                        bad += 1;
                        break;
                    }
                }
            }
        }
        Ok((segments, frames, bad))
    }

    /// Arm a crash point for the next append. Tests only.
    #[cfg(test)]
    pub(crate) fn set_fault(&self, fault: Fault) {
        *self.fault.lock().expect("fault lock") = fault;
    }

    #[cfg(test)]
    fn armed(&self, at: Fault) -> bool {
        *self.fault.lock().expect("fault lock") == at
    }
}

/// What one read at the current offset found.
enum FrameRead {
    Frame { payload: Vec<u8>, size: u64 },
    End,
    Torn { remaining: u64 },
}

fn read_frame(file: &mut File) -> Result<FrameRead, StoreError> {
    let start = file.stream_position()?;
    let total = file.metadata()?.len();
    let mut header = [0u8; HEADER];
    match read_exact_or_end(file, &mut header)? {
        Some(()) => {}
        None => {
            return Ok(if file.stream_position()? == start {
                FrameRead::End
            } else {
                FrameRead::Torn {
                    remaining: total - start,
                }
            });
        }
    }
    let len = u32::from_le_bytes([header[0], header[1], header[2], header[3]]) as usize;
    let crc = u32::from_le_bytes([header[4], header[5], header[6], header[7]]);
    let mut payload = vec![0u8; len];
    if read_exact_or_end(file, &mut payload)?.is_none() || crc32(&payload) != crc {
        file.seek(SeekFrom::Start(start))?;
        return Ok(FrameRead::Torn {
            remaining: total - start,
        });
    }
    Ok(FrameRead::Frame {
        payload,
        size: (HEADER + len) as u64,
    })
}

/// `read_exact`, but a short read at the end of the file is not an error.
fn read_exact_or_end(file: &mut File, buf: &mut [u8]) -> Result<Option<()>, StoreError> {
    let mut filled = 0;
    while filled < buf.len() {
        match file.read(&mut buf[filled..]) {
            Ok(0) => return Ok(None),
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(StoreError::Io(e)),
        }
    }
    Ok(Some(()))
}

fn make_dir(path: &Path) -> Result<(), StoreError> {
    if path.is_dir() {
        return Ok(());
    }
    DirBuilder::new()
        .recursive(true)
        .mode(DIR_MODE)
        .create(path)?;
    Ok(())
}

fn fsync_dir(dir: &Path) -> Result<(), StoreError> {
    File::open(dir)?.sync_all()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Encoding. Canonical JSON, one `t` per frame type (docs/storage.md).
// ---------------------------------------------------------------------------

fn text(value: impl ToString) -> Value {
    Value::Str(value.to_string())
}

fn num(value: u64) -> Value {
    Value::Int(value as i64)
}

fn opt_text(value: &Option<String>) -> Value {
    match value {
        Some(v) => Value::Str(v.clone()),
        None => Value::Null,
    }
}

fn opt_num(value: Option<u64>) -> Value {
    match value {
        Some(v) => num(v),
        None => Value::Null,
    }
}

fn list<T>(items: &[T], each: impl Fn(&T) -> Value) -> Value {
    Value::Array(items.iter().map(each).collect())
}

fn field<'a>(value: &'a Value, name: &str) -> Result<&'a Value, StoreError> {
    value
        .get(name)
        .ok_or_else(|| StoreError::Corrupt(format!("frame is missing the field {name}")))
}

fn field_str<'a>(value: &'a Value, name: &str) -> Result<&'a str, StoreError> {
    field(value, name)?
        .as_str()
        .ok_or_else(|| StoreError::Corrupt(format!("field {name} is not a string")))
}

fn field_id<T: std::str::FromStr>(value: &Value, name: &str) -> Result<T, StoreError> {
    field_str(value, name)?
        .parse()
        .map_err(|_| StoreError::Corrupt(format!("field {name} is not a valid identifier")))
}

fn field_num(value: &Value, name: &str) -> Result<u64, StoreError> {
    field(value, name)?
        .as_u64()
        .ok_or_else(|| StoreError::Corrupt(format!("field {name} is not a number")))
}

fn field_bool(value: &Value, name: &str) -> Result<bool, StoreError> {
    field(value, name)?
        .as_bool()
        .ok_or_else(|| StoreError::Corrupt(format!("field {name} is not a boolean")))
}

fn field_opt_text(value: &Value, name: &str) -> Option<String> {
    value.get(name).and_then(|v| v.as_str()).map(str::to_string)
}

fn field_opt_num(value: &Value, name: &str) -> Option<u64> {
    value.get(name).and_then(|v| v.as_u64())
}

fn field_bytes<const N: usize>(value: &Value, name: &str) -> Result<[u8; N], StoreError> {
    hex::decode_array::<N>(field_str(value, name)?)
        .map_err(|_| StoreError::Corrupt(format!("field {name} is not {N} bytes of hex")))
}

fn field_list<T>(
    value: &Value,
    name: &str,
    each: impl Fn(&Value) -> Result<T, StoreError>,
) -> Result<Vec<T>, StoreError> {
    field(value, name)?
        .as_array()
        .ok_or_else(|| StoreError::Corrupt(format!("field {name} is not an array")))?
        .iter()
        .map(each)
        .collect()
}

fn id_of<T: std::str::FromStr>(value: &Value) -> Result<T, StoreError> {
    value
        .as_str()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| StoreError::Corrupt("array holds an invalid identifier".to_string()))
}

fn version_value(version: &VersionRecord) -> Value {
    json::obj(vec![
        ("file", text(version.file_id)),
        ("id", text(version.version_id)),
        ("parents", list(&version.parents, |p| text(*p))),
        ("sids", list(&version.sids, |s| text(*s))),
        ("bytes", num(version.bytes)),
        ("ct", text(hex::encode(&version.manifest_ct))),
        ("nonce", text(hex::encode(&version.manifest_nonce))),
        ("device", text(version.device_id)),
        ("ts", num(version.ts.0)),
        ("deleted", Value::Bool(version.deleted)),
        ("seq", num(version.seq.0)),
    ])
}

fn version_from(value: &Value) -> Result<VersionRecord, StoreError> {
    Ok(VersionRecord {
        file_id: field_id(value, "file")?,
        version_id: field_id(value, "id")?,
        parents: field_list(value, "parents", id_of)?,
        sids: field_list(value, "sids", id_of)?,
        bytes: field_num(value, "bytes")?,
        manifest_ct: hex::decode(field_str(value, "ct")?)
            .map_err(|_| StoreError::Corrupt("field ct is not hex".to_string()))?,
        manifest_nonce: field_bytes::<12>(value, "nonce")?,
        device_id: field_id(value, "device")?,
        ts: UnixMs(field_num(value, "ts")?),
        deleted: field_bool(value, "deleted")?,
        seq: Seq(field_num(value, "seq")?),
    })
}

fn device_value(record: &DeviceRecord, wrapped: &[u8; 32]) -> Value {
    json::obj(vec![
        ("id", text(record.device_id)),
        ("account", text(record.account_id)),
        ("name", text(&record.name)),
        ("platform", text(&record.platform)),
        ("app", text(&record.app_version)),
        ("created", num(record.created.0)),
        ("seen", opt_num(record.last_seen.map(|t| t.0))),
        ("sign_in", opt_num(record.last_sign_in.map(|t| t.0))),
        ("edit", opt_num(record.last_edit.map(|t| t.0))),
        ("addr", opt_text(&record.address)),
        ("country", opt_text(&record.country)),
        ("pfm", num(record.policy.per_file_max_bytes)),
        ("budget", num(record.policy.total_budget_bytes)),
        ("state", text(record.state.as_word())),
        ("wrapped", text(hex::encode(wrapped))),
    ])
}

fn device_from(value: &Value) -> Result<(DeviceRecord, [u8; 32]), StoreError> {
    let record = DeviceRecord {
        device_id: field_id(value, "id")?,
        account_id: field_id(value, "account")?,
        name: field_str(value, "name")?.to_string(),
        platform: field_str(value, "platform")?.to_string(),
        app_version: field_str(value, "app")?.to_string(),
        created: UnixMs(field_num(value, "created")?),
        last_seen: field_opt_num(value, "seen").map(UnixMs),
        last_sign_in: field_opt_num(value, "sign_in").map(UnixMs),
        last_edit: field_opt_num(value, "edit").map(UnixMs),
        address: field_opt_text(value, "addr"),
        country: field_opt_text(value, "country"),
        policy: DevicePolicy {
            per_file_max_bytes: field_num(value, "pfm")?,
            total_budget_bytes: field_num(value, "budget")?,
        },
        state: DeviceState::parse(field_str(value, "state")?)
            .ok_or_else(|| StoreError::Corrupt("field state is not a device state".to_string()))?,
    };
    Ok((record, field_bytes::<32>(value, "wrapped")?))
}

fn seen_value(event: &SeenEvent) -> Value {
    json::obj(vec![
        ("kind", text(event.kind.as_word())),
        ("ts", num(event.ts.0)),
        ("addr", opt_text(&event.address)),
        ("country", opt_text(&event.country)),
    ])
}

fn seen_from(value: &Value) -> Result<SeenEvent, StoreError> {
    Ok(SeenEvent {
        kind: SeenKind::parse(field_str(value, "kind")?)
            .ok_or_else(|| StoreError::Corrupt("field kind is not an activity kind".to_string()))?,
        ts: UnixMs(field_num(value, "ts")?),
        address: field_opt_text(value, "addr"),
        country: field_opt_text(value, "country"),
    })
}

fn gc_value(summary: &GcSummary) -> Value {
    json::obj(vec![
        ("started", num(summary.started.0)),
        ("ms", num(summary.duration_ms)),
        ("chunks", num(summary.chunks_collected)),
        ("bytes", num(summary.bytes_collected)),
        ("retained", num(summary.chunks_retained)),
    ])
}

fn gc_from(value: &Value) -> Result<GcSummary, StoreError> {
    Ok(GcSummary {
        started: UnixMs(field_num(value, "started")?),
        duration_ms: field_num(value, "ms")?,
        chunks_collected: field_num(value, "chunks")?,
        bytes_collected: field_num(value, "bytes")?,
        chunks_retained: field_num(value, "retained")?,
    })
}

fn scrub_value(summary: &ScrubSummary) -> Value {
    json::obj(vec![
        ("started", num(summary.started.0)),
        ("ms", num(summary.duration_ms)),
        ("chunks", num(summary.chunks_verified)),
        ("bytes", num(summary.bytes_verified)),
        ("mismatches", num(summary.mismatches)),
        ("quarantined", list(&summary.quarantined, |s| text(*s))),
        ("complete", Value::Bool(summary.complete_pass)),
    ])
}

fn scrub_from(value: &Value) -> Result<ScrubSummary, StoreError> {
    Ok(ScrubSummary {
        started: UnixMs(field_num(value, "started")?),
        duration_ms: field_num(value, "ms")?,
        chunks_verified: field_num(value, "chunks")?,
        bytes_verified: field_num(value, "bytes")?,
        mismatches: field_num(value, "mismatches")?,
        quarantined: field_list(value, "quarantined", id_of)?,
        complete_pass: field_bool(value, "complete")?,
    })
}

impl Record {
    /// The canonical JSON for this record.
    fn to_value(&self) -> Value {
        let mut pairs: Vec<(&str, Value)> =
            vec![("t", text(self.frame.kind())), ("s", num(self.seq.0))];
        if let Some(account) = self.account_id {
            pairs.push(("a", text(account)));
        }
        match &self.frame {
            Frame::Account {
                account_id,
                name,
                created,
                quota_bytes,
            } => {
                pairs.push(("id", text(*account_id)));
                pairs.push(("name", text(name)));
                pairs.push(("created", num(created.0)));
                pairs.push(("quota", opt_num(*quota_bytes)));
            }
            Frame::Device { record, wrapped } => {
                pairs.push(("device", device_value(record, wrapped)));
            }
            Frame::DeviceUpdate {
                device_id,
                name,
                policy,
                app_version,
            } => {
                pairs.push(("device", text(*device_id)));
                pairs.push(("name", opt_text(name)));
                pairs.push(("app", opt_text(app_version)));
                pairs.push((
                    "policy",
                    match policy {
                        Some(policy) => json::obj(vec![
                            ("pfm", num(policy.per_file_max_bytes)),
                            ("budget", num(policy.total_budget_bytes)),
                        ]),
                        None => Value::Null,
                    },
                ));
            }
            Frame::DeviceActivate { device_id }
            | Frame::DeviceRevoke { device_id }
            | Frame::DeviceDelete { device_id } => {
                pairs.push(("device", text(*device_id)));
            }
            Frame::Version(version) => pairs.push(("version", version_value(version))),
            Frame::Domain { domain_id, created } => {
                pairs.push(("domain", text(*domain_id)));
                pairs.push(("created", num(created.0)));
            }
            Frame::Seen { device_id, event } => {
                pairs.push(("device", text(*device_id)));
                pairs.push(("event", seen_value(event)));
            }
            Frame::Gc {
                sids,
                pruned,
                summary,
            } => {
                pairs.push(("sids", list(sids, |s| text(*s))));
                pairs.push((
                    "pruned",
                    Value::Array(
                        pruned
                            .iter()
                            .map(|(file_id, version_id)| {
                                json::obj(vec![("f", text(*file_id)), ("v", text(*version_id))])
                            })
                            .collect(),
                    ),
                ));
                pairs.push(("summary", gc_value(summary)));
            }
            Frame::Scrub { summary } => pairs.push(("summary", scrub_value(summary))),
        }
        json::obj(pairs)
    }

    /// Parse one frame payload.
    pub(crate) fn decode(payload: &[u8]) -> Result<Record, StoreError> {
        let value = json::parse(payload)
            .map_err(|e| StoreError::Corrupt(format!("frame is not JSON: {}", e.kind.as_str())))?;
        let seq = Seq(field_num(&value, "s")?);
        let account_id = value
            .get("a")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse().ok());
        let frame = match field_str(&value, "t")? {
            "account" => Frame::Account {
                account_id: field_id(&value, "id")?,
                name: field_str(&value, "name")?.to_string(),
                created: UnixMs(field_num(&value, "created")?),
                quota_bytes: field_opt_num(&value, "quota"),
            },
            "device" => {
                let (record, wrapped) = device_from(field(&value, "device")?)?;
                Frame::Device { record, wrapped }
            }
            "device_update" => Frame::DeviceUpdate {
                device_id: field_id(&value, "device")?,
                name: field_opt_text(&value, "name"),
                app_version: field_opt_text(&value, "app"),
                policy: match value.get("policy") {
                    Some(policy) if !policy.is_null() => Some(DevicePolicy {
                        per_file_max_bytes: field_num(policy, "pfm")?,
                        total_budget_bytes: field_num(policy, "budget")?,
                    }),
                    _ => None,
                },
            },
            "device_activate" => Frame::DeviceActivate {
                device_id: field_id(&value, "device")?,
            },
            "device_revoke" => Frame::DeviceRevoke {
                device_id: field_id(&value, "device")?,
            },
            "device_delete" => Frame::DeviceDelete {
                device_id: field_id(&value, "device")?,
            },
            "version" => Frame::Version(version_from(field(&value, "version")?)?),
            "domain" => Frame::Domain {
                domain_id: field_id(&value, "domain")?,
                created: UnixMs(field_num(&value, "created")?),
            },
            "seen" => Frame::Seen {
                device_id: field_id(&value, "device")?,
                event: seen_from(field(&value, "event")?)?,
            },
            "gc" => Frame::Gc {
                sids: field_list(&value, "sids", id_of)?,
                pruned: field_list(&value, "pruned", |entry| {
                    Ok((field_id(entry, "f")?, field_id(entry, "v")?))
                })?,
                summary: gc_from(field(&value, "summary")?)?,
            },
            "scrub" => Frame::Scrub {
                summary: scrub_from(field(&value, "summary")?)?,
            },
            other => return Err(StoreError::Corrupt(format!("unknown frame type {other}"))),
        };
        Ok(Record {
            seq,
            account_id,
            frame,
        })
    }
}

impl Frame {
    /// The wire name of this frame type (docs/storage.md, "Journal frames").
    pub(crate) const fn kind(&self) -> &'static str {
        match self {
            Frame::Account { .. } => "account",
            Frame::Device { .. } => "device",
            Frame::DeviceUpdate { .. } => "device_update",
            Frame::DeviceActivate { .. } => "device_activate",
            Frame::DeviceRevoke { .. } => "device_revoke",
            Frame::DeviceDelete { .. } => "device_delete",
            Frame::Version(_) => "version",
            Frame::Domain { .. } => "domain",
            Frame::Seen { .. } => "seen",
            Frame::Gc { .. } => "gc",
            Frame::Scrub { .. } => "scrub",
        }
    }
}

/// A snapshot is one frame holding the whole index.
fn snapshot_value(index: &Index) -> Value {
    let account = match &index.account {
        Some(account) => json::obj(vec![
            ("id", text(account.account_id)),
            ("name", text(&account.name)),
            ("created", num(account.created.0)),
            ("quota", opt_num(account.quota_bytes)),
        ]),
        None => Value::Null,
    };
    let devices = Value::Array(
        index
            .devices
            .values()
            .map(|entry| {
                let mut value = device_value(&entry.record, &entry.wrapped);
                if let Value::Object(members) = &mut value {
                    members.push((
                        "history".to_string(),
                        Value::Array(entry.seen.iter().map(seen_value).collect()),
                    ));
                }
                value
            })
            .collect(),
    );
    let files = Value::Array(
        index
            .files
            .iter()
            .map(|(file_id, entry)| {
                json::obj(vec![
                    ("id", text(*file_id)),
                    ("heads", list(&entry.heads, |h| text(*h))),
                    ("versions", list(&entry.versions, version_value)),
                ])
            })
            .collect(),
    );
    let domains = Value::Array(
        index
            .domains
            .values()
            .map(|record| {
                json::obj(vec![
                    ("id", text(record.domain_id)),
                    ("created", num(record.created.0)),
                ])
            })
            .collect(),
    );
    json::obj(vec![
        ("t", text("snapshot")),
        ("s", num(index.seq.0)),
        ("account", account),
        ("devices", devices),
        ("files", files),
        ("domains", domains),
        (
            "gc",
            match &index.last_gc {
                Some(summary) => gc_value(summary),
                None => Value::Null,
            },
        ),
        (
            "scrub",
            match &index.last_scrub {
                Some(summary) => scrub_value(summary),
                None => Value::Null,
            },
        ),
    ])
}

fn index_from_value(value: &Value) -> Result<Index, StoreError> {
    if field_str(value, "t")? != "snapshot" {
        return Err(StoreError::Corrupt("not a snapshot frame".to_string()));
    }
    let mut index = Index {
        seq: Seq(field_num(value, "s")?),
        ..Index::default()
    };
    if let Some(account) = value.get("account").filter(|v| !v.is_null()) {
        index.account = Some(crate::storage::types::AccountRecord {
            account_id: field_id(account, "id")?,
            name: field_str(account, "name")?.to_string(),
            created: UnixMs(field_num(account, "created")?),
            quota_bytes: field_opt_num(account, "quota"),
            used_bytes: 0,
        });
    }
    for device in field(value, "devices")?
        .as_array()
        .ok_or_else(|| StoreError::Corrupt("devices is not an array".to_string()))?
    {
        let (record, wrapped) = device_from(device)?;
        let history = match device.get("history").and_then(|v| v.as_array()) {
            Some(events) => events
                .iter()
                .map(seen_from)
                .collect::<Result<Vec<_>, _>>()?,
            None => Vec::new(),
        };
        index.devices.insert(
            record.device_id,
            DeviceEntry {
                record,
                wrapped,
                seen: history.into(),
            },
        );
    }
    for file in field(value, "files")?
        .as_array()
        .ok_or_else(|| StoreError::Corrupt("files is not an array".to_string()))?
    {
        let file_id: FileId = field_id(file, "id")?;
        let heads: Vec<VersionId> = field_list(file, "heads", id_of)?;
        let versions = field_list(file, "versions", version_from)?;
        for version in &versions {
            index.feed.push((version.seq, file_id, version.version_id));
        }
        index.files.insert(
            file_id,
            FileEntry {
                conflicted: heads.len() > 1,
                heads,
                versions,
            },
        );
    }
    index.feed.sort_by_key(|(seq, _, _)| *seq);
    for domain in field(value, "domains")?
        .as_array()
        .ok_or_else(|| StoreError::Corrupt("domains is not an array".to_string()))?
    {
        let domain_id: DomainId = field_id(domain, "id")?;
        index.domains.insert(
            domain_id,
            DomainRecord {
                domain_id,
                created: UnixMs(field_num(domain, "created")?),
            },
        );
    }
    if let Some(summary) = value.get("gc").filter(|v| !v.is_null()) {
        index.last_gc = Some(gc_from(summary)?);
    }
    if let Some(summary) = value.get("scrub").filter(|v| !v.is_null()) {
        index.last_scrub = Some(scrub_from(summary)?);
    }
    Ok(index)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::testutil::{TempDir, device_record, version_record};

    fn journal(dir: &TempDir) -> Journal {
        Journal::open(dir.path()).expect("journal opens")
    }

    fn account_frame() -> Frame {
        Frame::Account {
            account_id: AccountId::new([1u8; 16]),
            name: "sentinel".to_string(),
            created: UnixMs(1_757_000_000_000),
            quota_bytes: Some(1024),
        }
    }

    fn record(seq: u64, frame: Frame) -> Record {
        Record {
            seq: Seq(seq),
            account_id: Some(AccountId::new([1u8; 16])),
            frame,
        }
    }

    fn replay_all(journal: &mut Journal) -> (Vec<Record>, ReplayReport) {
        let mut seen = Vec::new();
        let report = journal
            .replay(Seq(0), &mut |record| seen.push(record.clone()))
            .expect("replay");
        (seen, report)
    }

    #[test]
    fn every_frame_type_round_trips_through_a_segment() {
        let dir = TempDir::new("journal-frames");
        let mut journal = journal(&dir);
        let device = device_record();
        let frames = vec![
            account_frame(),
            Frame::Device {
                record: device.clone(),
                wrapped: [9u8; 32],
            },
            Frame::DeviceUpdate {
                device_id: device.device_id,
                name: Some("renamed".to_string()),
                policy: Some(DevicePolicy {
                    per_file_max_bytes: 5,
                    total_budget_bytes: 7,
                }),
                app_version: Some("0.1.1".to_string()),
            },
            Frame::Device {
                record: DeviceRecord {
                    state: DeviceState::Pending,
                    ..device.clone()
                },
                wrapped: [9u8; 32],
            },
            Frame::DeviceActivate {
                device_id: device.device_id,
            },
            Frame::DeviceRevoke {
                device_id: device.device_id,
            },
            Frame::DeviceDelete {
                device_id: device.device_id,
            },
            Frame::Version(version_record(
                FileId::new([2u8; 16]),
                VersionId::new([3u8; 32]),
                &[VersionId::new([4u8; 32])],
                Seq(6),
            )),
            Frame::Domain {
                domain_id: DomainId::new([5u8; 16]),
                created: UnixMs(7),
            },
            Frame::Seen {
                device_id: device.device_id,
                event: SeenEvent {
                    kind: SeenKind::Edit,
                    ts: UnixMs(11),
                    address: Some("198.51.100.7".to_string()),
                    country: Some("XX".to_string()),
                },
            },
            Frame::Gc {
                sids: vec![Sid::new([1u8; 32])],
                pruned: vec![(FileId::new([2u8; 16]), VersionId::new([3u8; 32]))],
                summary: GcSummary {
                    started: UnixMs(1),
                    duration_ms: 2,
                    chunks_collected: 3,
                    bytes_collected: 4,
                    chunks_retained: 5,
                },
            },
            Frame::Scrub {
                summary: ScrubSummary {
                    started: UnixMs(1),
                    duration_ms: 2,
                    chunks_verified: 3,
                    bytes_verified: 4,
                    mismatches: 1,
                    quarantined: vec![Sid::new([6u8; 32])],
                    complete_pass: true,
                },
            },
        ];
        for (n, frame) in frames.iter().enumerate() {
            journal
                .append(&record(n as u64 + 1, frame.clone()))
                .expect("append");
        }

        let (seen, report) = replay_all(&mut journal);
        assert_eq!(report.frames as usize, frames.len());
        assert_eq!(report.truncated_bytes, 0);
        assert_eq!(seen.len(), frames.len());
        for (n, (original, replayed)) in frames.iter().zip(seen.iter()).enumerate() {
            assert_eq!(replayed.seq, Seq(n as u64 + 1));
            assert_eq!(
                format!("{original:?}"),
                format!("{:?}", replayed.frame),
                "frame {} survives the round trip",
                original.kind()
            );
        }
    }

    #[test]
    fn a_crash_mid_append_truncates_the_tail_and_keeps_the_rest() {
        let dir = TempDir::new("journal-torn");
        let mut journal = journal(&dir);
        journal.append(&record(1, account_frame())).expect("append");
        journal
            .append(&record(
                2,
                Frame::Domain {
                    domain_id: DomainId::new([5u8; 16]),
                    created: UnixMs(7),
                },
            ))
            .expect("append");
        journal.set_fault(Fault::JournalMidAppend);
        let err = journal
            .append(&record(3, account_frame()))
            .expect_err("the injected crash surfaces");
        assert!(matches!(err, StoreError::Io(_)), "{err}");

        let mut reopened = Journal::open(dir.path()).expect("reopen");
        let (seen, report) = replay_all(&mut reopened);
        assert_eq!(report.frames, 2, "the two complete frames survive");
        assert!(report.truncated_bytes > 0, "the torn tail is reported");
        assert_eq!(seen[0].frame.kind(), "account");
        assert_eq!(seen[1].frame.kind(), "domain");

        // The truncation is durable: a second replay finds a clean tail and
        // appending afterwards works.
        let (seen, report) = replay_all(&mut reopened);
        assert_eq!(report.frames, 2);
        assert_eq!(report.truncated_bytes, 0, "nothing left to truncate");
        assert_eq!(seen.len(), 2);
        reopened
            .append(&record(3, account_frame()))
            .expect("append");
        let (seen, _) = replay_all(&mut reopened);
        assert_eq!(seen.len(), 3);
    }

    #[test]
    fn a_frame_whose_crc_fails_is_refused_like_a_torn_one() {
        let dir = TempDir::new("journal-crc");
        let mut journal = journal(&dir);
        journal.append(&record(1, account_frame())).expect("append");
        journal.set_fault(Fault::JournalTornFrame);
        journal.append(&record(2, account_frame())).expect("append");

        let mut reopened = Journal::open(dir.path()).expect("reopen");
        let (seen, report) = replay_all(&mut reopened);
        assert_eq!(report.frames, 1, "only the intact frame survives");
        assert_eq!(seen.len(), 1);
        assert!(report.truncated_bytes > 0);
    }

    #[test]
    fn a_snapshot_replaces_the_frames_it_covers() {
        let dir = TempDir::new("journal-snapshot");
        let mut journal = journal(&dir);
        journal.append(&record(1, account_frame())).expect("append");
        let mut index = Index::default();
        index.apply(&record(1, account_frame()));
        journal.snapshot(&index).expect("snapshot");

        journal
            .append(&record(
                2,
                Frame::Domain {
                    domain_id: DomainId::new([5u8; 16]),
                    created: UnixMs(7),
                },
            ))
            .expect("append");

        let reopened = Journal::open(dir.path()).expect("reopen");
        let (loaded, skipped) = reopened.load_snapshot().expect("load");
        let mut loaded = loaded.expect("a snapshot exists");
        assert_eq!(skipped, 0);
        assert_eq!(loaded.seq, Seq(1));
        assert_eq!(loaded.account.as_ref().expect("account").name, "sentinel");

        let mut journal = reopened;
        let report = journal
            .replay(loaded.seq, &mut |record| loaded.apply(record))
            .expect("replay after the snapshot");
        assert_eq!(report.frames, 1, "only the frames after the snapshot");
        assert_eq!(loaded.seq, Seq(2));
        assert_eq!(loaded.domains.len(), 1);
    }

    #[test]
    fn an_unreadable_snapshot_is_skipped_for_an_older_one() {
        let dir = TempDir::new("journal-bad-snapshot");
        let mut journal = journal(&dir);
        journal.append(&record(1, account_frame())).expect("append");
        let mut index = Index::default();
        index.apply(&record(1, account_frame()));
        journal.snapshot(&index).expect("first snapshot");
        index.seq = Seq(2);
        journal.snapshot(&index).expect("second snapshot");

        let snapshot = dir.path().join("v1/index/2.snap");
        fs::write(&snapshot, b"not a frame at all").expect("corrupt the newest snapshot");

        let (loaded, skipped) = journal.load_snapshot().expect("load");
        assert_eq!(skipped, 1, "the corrupt snapshot is counted, not hidden");
        assert_eq!(loaded.expect("older snapshot").seq, Seq(1));
    }

    #[test]
    fn verify_counts_frames_and_flags_a_bad_one() {
        let dir = TempDir::new("journal-verify");
        let mut journal = journal(&dir);
        journal.append(&record(1, account_frame())).expect("append");
        journal.append(&record(2, account_frame())).expect("append");
        let (segments, frames, bad) = journal.verify().expect("verify");
        assert_eq!((segments, frames, bad), (1, 2, 0));

        journal.set_fault(Fault::JournalTornFrame);
        journal.append(&record(3, account_frame())).expect("append");
        let (_, frames, bad) = journal.verify().expect("verify");
        assert_eq!((frames, bad), (2, 1));
    }

    #[test]
    fn an_unknown_frame_type_is_corrupt_not_ignored() {
        let payload = br#"{"t":"nonsense","s":1}"#;
        let err = Record::decode(payload).expect_err("unknown frame types are refused");
        assert!(matches!(err, StoreError::Corrupt(_)), "{err}");
        let err = Record::decode(br#"{"s":1}"#).expect_err("a frame must name its type");
        assert!(matches!(err, StoreError::Corrupt(_)), "{err}");
        let err = Record::decode(b"{").expect_err("a frame must be JSON");
        assert!(matches!(err, StoreError::Corrupt(_)), "{err}");
    }
}
