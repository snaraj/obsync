//! The account's specific generation, floor and fresh-root rotation state.
#![forbid(unsafe_code)]

use super::StoreError;
use crate::types::{DeviceId, FileId, Seq, VersionId};
use obsync_core::json::{Value, obj};
use std::collections::BTreeMap;

/// One immutable owner-authorized fresh-root intent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RotationIntent {
    pub operation: String,
    pub previous_map: FileId,
    pub current_map: FileId,
    pub target: Option<DeviceId>,
    pub recovery_verifier: String,
}

/// Durable progress; the unbounded inventory/catalog live in bounded files.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RotationState {
    pub intent: RotationIntent,
    pub coordinator: DeviceId,
    pub cutoff: Seq,
    pub inventory_hash: String,
    pub inventory_heads: u64,
    pub catalog_pages: u64,
    pub catalog_heads: u64,
    pub catalog_last: Option<(FileId, VersionId)>,
    pub committed: bool,
    pub resume_id: Option<String>,
}

/// One API credential's content-publication scope, never a content key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Grant {
    pub generation: FileId,
    pub operation: Option<String>,
}

/// Specific account coordination state; absence is the legacy pre-floor form.
#[derive(Clone, Debug, Default)]
pub(crate) struct Authority {
    pub generation: Option<FileId>,
    pub rotation: Option<RotationState>,
    pub grants: BTreeMap<DeviceId, Grant>,
}

impl Authority {
    pub fn floor2(&self) -> bool {
        self.generation.is_some()
    }
    pub fn pending(&self) -> Option<&RotationState> {
        self.rotation.as_ref().filter(|r| !r.committed)
    }
}

pub fn hex_id(value: &Value, name: &str, width: usize) -> Result<String, StoreError> {
    value
        .get(name)
        .and_then(Value::as_str)
        .filter(|s| {
            s.len() == width
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        .map(str::to_string)
        .ok_or_else(|| StoreError::Corrupt(format!("invalid rotation field {name}")))
}
fn id<T: std::str::FromStr>(value: &Value, name: &str, width: usize) -> Result<T, StoreError> {
    hex_id(value, name, width)?
        .parse()
        .map_err(|_| StoreError::Corrupt("invalid rotation identifier".into()))
}
fn number(value: &Value, name: &str) -> Result<u64, StoreError> {
    value
        .get(name)
        .and_then(Value::as_u64)
        .ok_or_else(|| StoreError::Corrupt(format!("invalid rotation number {name}")))
}

impl RotationIntent {
    pub fn parse(value: &Value) -> Result<Self, StoreError> {
        let fields = value
            .as_object()
            .ok_or_else(|| StoreError::Corrupt("rotation intent must be an object".into()))?;
        if fields.len() != 6
            || fields.iter().any(|(k, _)| {
                !matches!(
                    k.as_str(),
                    "operation"
                        | "previous_map"
                        | "current_map"
                        | "target"
                        | "recovery_verifier"
                        | "seal_suite"
                )
            })
            || value.get("seal_suite").and_then(Value::as_u64) != Some(2)
        {
            return Err(StoreError::Corrupt("unsupported rotation intent".into()));
        }
        let target = match value.get("target") {
            Some(Value::Null) => None,
            Some(_) => Some(id(value, "target", 32)?),
            None => return Err(StoreError::Corrupt("rotation target is required".into())),
        };
        let intent = Self {
            operation: hex_id(value, "operation", 32)?,
            previous_map: id(value, "previous_map", 32)?,
            current_map: id(value, "current_map", 32)?,
            target,
            recovery_verifier: hex_id(value, "recovery_verifier", 64)?,
        };
        if intent.previous_map == intent.current_map {
            return Err(StoreError::Corrupt(
                "rotation requires a fresh generation".into(),
            ));
        }
        Ok(intent)
    }
    pub fn value(&self) -> Value {
        obj(vec![
            ("operation", Value::Str(self.operation.clone())),
            ("previous_map", Value::Str(self.previous_map.to_string())),
            ("current_map", Value::Str(self.current_map.to_string())),
            (
                "target",
                self.target
                    .map(|id| Value::Str(id.to_string()))
                    .unwrap_or(Value::Null),
            ),
            (
                "recovery_verifier",
                Value::Str(self.recovery_verifier.clone()),
            ),
            ("seal_suite", Value::Int(2)),
        ])
    }
}

impl RotationState {
    pub fn value(&self) -> Value {
        obj(vec![
            ("intent", self.intent.value()),
            ("coordinator", Value::Str(self.coordinator.to_string())),
            ("cutoff", Value::from(self.cutoff.0)),
            ("inventory_hash", Value::Str(self.inventory_hash.clone())),
            ("inventory_heads", Value::from(self.inventory_heads)),
            ("catalog_pages", Value::from(self.catalog_pages)),
            ("catalog_heads", Value::from(self.catalog_heads)),
            (
                "catalog_last",
                self.catalog_last
                    .map(|(f, v)| {
                        Value::Array(vec![Value::Str(f.to_string()), Value::Str(v.to_string())])
                    })
                    .unwrap_or(Value::Null),
            ),
            ("committed", Value::Bool(self.committed)),
            (
                "resume_id",
                self.resume_id
                    .clone()
                    .map(Value::Str)
                    .unwrap_or(Value::Null),
            ),
        ])
    }
    pub(crate) fn parse(v: &Value) -> Result<Self, StoreError> {
        if v.as_object().is_none_or(|fields| {
            fields.len() != 10
                || fields.iter().any(|(k, _)| {
                    !matches!(
                        k.as_str(),
                        "intent"
                            | "coordinator"
                            | "cutoff"
                            | "inventory_hash"
                            | "inventory_heads"
                            | "catalog_pages"
                            | "catalog_heads"
                            | "catalog_last"
                            | "committed"
                            | "resume_id"
                    )
                })
        }) {
            return Err(StoreError::Corrupt("invalid rotation state shape".into()));
        }
        let intent = RotationIntent::parse(
            v.get("intent")
                .ok_or_else(|| StoreError::Corrupt("missing rotation intent".into()))?,
        )?;
        let catalog_last = match v.get("catalog_last") {
            Some(Value::Null) => None,
            Some(Value::Array(a)) if a.len() == 2 => Some((
                a[0].as_str()
                    .and_then(|s| s.parse().ok())
                    .ok_or_else(|| StoreError::Corrupt("bad catalog file".into()))?,
                a[1].as_str()
                    .and_then(|s| s.parse().ok())
                    .ok_or_else(|| StoreError::Corrupt("bad catalog head".into()))?,
            )),
            _ => return Err(StoreError::Corrupt("bad catalog cursor".into())),
        };
        let resume_id = match v.get("resume_id") {
            Some(Value::Null) => None,
            Some(_) => Some(hex_id(v, "resume_id", 32)?),
            None => return Err(StoreError::Corrupt("missing resume ID state".into())),
        };
        let inventory_heads = number(v, "inventory_heads")?;
        let catalog_heads = number(v, "catalog_heads")?;
        let catalog_pages = number(v, "catalog_pages")?;
        if catalog_heads > inventory_heads
            || catalog_pages > catalog_heads
            || (catalog_heads == 0) != (catalog_pages == 0)
            || (catalog_heads == 0) != catalog_last.is_none()
        {
            return Err(StoreError::Corrupt(
                "invalid rotation progress bounds".into(),
            ));
        }
        Ok(Self {
            intent,
            coordinator: id(v, "coordinator", 32)?,
            cutoff: Seq(number(v, "cutoff")?),
            inventory_hash: hex_id(v, "inventory_hash", 64)?,
            inventory_heads: number(v, "inventory_heads")?,
            catalog_pages: number(v, "catalog_pages")?,
            catalog_heads: number(v, "catalog_heads")?,
            catalog_last,
            committed: v
                .get("committed")
                .and_then(Value::as_bool)
                .ok_or_else(|| StoreError::Corrupt("bad rotation phase".into()))?,
            resume_id,
        })
    }
}

impl Authority {
    pub(crate) fn value(&self) -> Value {
        obj(vec![
            ("seal_suite", Value::Int(2)),
            (
                "generation",
                self.generation
                    .map(|g| Value::Str(g.to_string()))
                    .unwrap_or(Value::Null),
            ),
            (
                "rotation",
                self.rotation
                    .as_ref()
                    .map(RotationState::value)
                    .unwrap_or(Value::Null),
            ),
        ])
    }
    pub(crate) fn parse(v: &Value) -> Result<Self, StoreError> {
        if number(v, "seal_suite")? != 2 {
            return Err(StoreError::Corrupt("unknown authority suite".into()));
        }
        let generation = Some(id(v, "generation", 32)?);
        let rotation = match v.get("rotation") {
            Some(Value::Null) => None,
            Some(state) => Some(RotationState::parse(state)?),
            None => return Err(StoreError::Corrupt("missing rotation authority".into())),
        };
        Ok(Self {
            generation,
            rotation,
            grants: BTreeMap::new(),
        })
    }
}

impl super::Store {
    /// Rechecked by durable enrollment/activation as well as the HTTP ceremony.
    pub fn check_enrollment(&self, suite2: bool) -> Result<(), StoreError> {
        let _journal = self.journal();
        let index = self.index();
        if index.authority.pending().is_some() {
            return Err(StoreError::AuthorityRefused("rotation_pending"));
        }
        if index.authority.floor2() && !suite2 {
            return Err(StoreError::AuthorityRefused("suite_required"));
        }
        Ok(())
    }
}

use super::journal::Frame;
use super::{DeviceState, ManifestSeal, NewDevice, NewSetup, SetupOutcome};
use crate::types::UnixMs;
use obsync_core::sha256::Sha256;
use obsync_core::{hex, sha256};
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

pub const INVENTORY_PAGE: u64 = 256;
const ROW_BYTES: u64 = 104;
const CATALOG_BYTES: usize = 64 * 1024;

fn rotation_root(store: &super::Store, intent: &RotationIntent) -> PathBuf {
    store
        .cfg
        .journal_dir
        .join("v1/rotation")
        .join(&intent.operation)
}
fn ensure_dir(path: &Path) -> Result<(), StoreError> {
    if !path.exists() {
        DirBuilder::new().mode(0o700).create(path)?;
        if let Some(parent) = path.parent() {
            File::open(parent)?.sync_all()?;
        }
    }
    Ok(())
}
fn source_bytes(source: (FileId, VersionId)) -> Vec<u8> {
    let mut b = Value::Array(vec![
        Value::Str(source.0.to_string()),
        Value::Str(source.1.to_string()),
    ])
    .to_json()
    .into_bytes();
    b.push(b'\n');
    b
}
fn source_at(file: &mut File, position: u64) -> Result<(FileId, VersionId), StoreError> {
    file.seek(SeekFrom::Start(
        position
            .checked_mul(ROW_BYTES)
            .ok_or_else(|| StoreError::Corrupt("inventory offset overflow".into()))?,
    ))?;
    let mut b = [0; ROW_BYTES as usize];
    file.read_exact(&mut b)?;
    if b[ROW_BYTES as usize - 1] != b'\n' {
        return Err(StoreError::Corrupt("invalid inventory row".into()));
    }
    let v = obsync_core::json::parse(&b[..ROW_BYTES as usize - 1])
        .map_err(|_| StoreError::Corrupt("invalid inventory JSON".into()))?;
    let a = v
        .as_array()
        .filter(|a| a.len() == 2)
        .ok_or_else(|| StoreError::Corrupt("invalid inventory tuple".into()))?;
    let source = (
        a[0].as_str()
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| StoreError::Corrupt("invalid inventory file".into()))?,
        a[1].as_str()
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| StoreError::Corrupt("invalid inventory head".into()))?,
    );
    if source_bytes(source) != b {
        return Err(StoreError::Corrupt("noncanonical inventory".into()));
    }
    Ok(source)
}
fn file_hash(path: &Path) -> Result<String, StoreError> {
    let mut f = File::open(path)?;
    let mut h = Sha256::new();
    let mut b = [0; 65536];
    loop {
        let n = f.read(&mut b)?;
        if n == 0 {
            break;
        }
        h.update(&b[..n]);
    }
    Ok(hex::encode(&h.finalize()))
}
fn pending(
    state: &Option<RotationState>,
    coordinator: DeviceId,
    operation: &str,
) -> Result<RotationState, StoreError> {
    let r = state
        .as_ref()
        .filter(|r| r.intent.operation == operation && r.coordinator == coordinator)
        .ok_or(StoreError::AuthorityRefused("rotation_conflict"))?;
    if r.committed {
        return Err(StoreError::AuthorityRefused("rotation_committed"));
    }
    Ok(r.clone())
}
fn active(index: &super::index::Index, id: DeviceId) -> Result<(), StoreError> {
    match index.devices.get(&id).map(|d| d.record.state) {
        Some(DeviceState::Active) => Ok(()),
        Some(DeviceState::Revoked) => Err(StoreError::DeviceRevoked),
        Some(DeviceState::Pending) => Err(StoreError::DevicePending),
        None => Err(StoreError::UnknownDevice),
    }
}
fn map_exists(index: &super::index::Index, generation: FileId) -> bool {
    index.files.get(&generation).is_some_and(|f| {
        f.generation == Some(generation)
            && f.heads.len() == 1
            && f.versions.iter().any(|v| {
                f.heads[0] == v.version_id && !v.deleted && v.manifest_seal == ManifestSeal::Suite2
            })
    })
}

/// One fixed opaque source/destination tuple, never a path or content key.
pub type CatalogEntry = (FileId, VersionId, FileId, VersionId);
pub fn catalog_value(entries: &[CatalogEntry]) -> Value {
    Value::Array(
        entries
            .iter()
            .map(|(f, v, n, w)| {
                Value::Array(vec![
                    Value::Str(f.to_string()),
                    Value::Str(v.to_string()),
                    Value::Str(n.to_string()),
                    Value::Str(w.to_string()),
                ])
            })
            .collect(),
    )
}
pub fn catalog_parse(value: &Value) -> Result<Vec<CatalogEntry>, StoreError> {
    let a = value
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= INVENTORY_PAGE as usize)
        .ok_or(StoreError::Corrupt(
            "catalog page must contain1..256 entries".into(),
        ))?;
    a.iter()
        .map(|v| {
            let e = v
                .as_array()
                .filter(|e| e.len() == 4)
                .ok_or_else(|| StoreError::Corrupt("bad catalog tuple".into()))?;
            Ok((
                tuple_id(&e[0], 32)?,
                tuple_id(&e[1], 64)?,
                tuple_id(&e[2], 32)?,
                tuple_id(&e[3], 64)?,
            ))
        })
        .collect()
}

/// Exact frozen completion fields authenticated by the commit request.
pub struct RotationCompletion {
    pub cutoff: Seq,
    pub inventory_hash: String,
    pub catalog_pages: u64,
    pub catalog_hash: String,
}

impl super::Store {
    /// Owner token authentication is supplied by the handler; storage binds the
    /// exact intent and credential under the same publication writer lock.
    pub fn prepare_rotation(
        &self,
        coordinator: DeviceId,
        intent: RotationIntent,
    ) -> Result<RotationState, StoreError> {
        RotationIntent::parse(&intent.value())?;
        let mut journal = self.journal();
        let index = self.index();
        active(&index, coordinator)?;
        if let Some(old) = &index.authority.rotation {
            if old.intent == intent && old.coordinator == coordinator {
                let result = old.clone();
                drop(index);
                journal.ensure_floor_marker()?;
                self.verify_rotation_files(&result)?;
                return Ok(result);
            }
            if !old.committed || old.intent.operation == intent.operation {
                return Err(StoreError::AuthorityRefused("rotation_conflict"));
            }
        }
        if index
            .authority
            .generation
            .is_some_and(|g| g != intent.previous_map)
        {
            return Err(StoreError::AuthorityRefused("generation_mismatch"));
        }
        if let Some(target) = intent.target {
            if target == coordinator {
                return Err(StoreError::AuthorityRefused("own_device"));
            }
            if !index.devices.contains_key(&target) {
                return Err(StoreError::UnknownDevice);
            }
        }
        if index.authority.generation.is_none()
            && index.files.values().any(|f| f.generation.is_some())
        {
            return Err(StoreError::Corrupt(
                "partial legacy generation bootstrap".into(),
            ));
        }
        if index.authority.floor2() && index.files.values().any(|f| f.generation.is_none()) {
            return Err(StoreError::Corrupt("unknown file generation".into()));
        }
        let cutoff = index.seq;
        let copy = index.snapshot_copy();
        drop(index);
        let root = rotation_root(self, &intent);
        ensure_dir(&self.cfg.journal_dir.join("v1/rotation"))?;
        ensure_dir(&root)?;
        let tmp = root.join("inventory.tmp");
        let final_path = root.join("inventory");
        let result = (|| {
            let mut out = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&tmp)?;
            let mut hash = Sha256::new();
            let mut count = 0u64;
            let mut page = Vec::with_capacity(INVENTORY_PAGE as usize * ROW_BYTES as usize);
            for (fid, entry) in &copy.files {
                if entry.generation.is_some_and(|g| g != intent.previous_map) {
                    continue;
                }
                let mut heads = entry.heads.clone();
                heads.sort();
                for head in heads {
                    let bytes = source_bytes((*fid, head));
                    page.extend_from_slice(&bytes);
                    hash.update(&bytes);
                    if page.len() == INVENTORY_PAGE as usize * ROW_BYTES as usize {
                        journal.admit_quarantine(page.len() as u64)?;
                        out.write_all(&page)?;
                        page.clear();
                    }
                    count = count
                        .checked_add(1)
                        .ok_or_else(|| StoreError::Corrupt("inventory count overflow".into()))?;
                }
            }
            if !page.is_empty() {
                journal.admit_quarantine(page.len() as u64)?;
                out.write_all(&page)?;
            }
            out.sync_all()?;
            drop(out);
            fs::rename(&tmp, &final_path)?;
            File::open(&root)?.sync_all()?;
            Ok::<_, StoreError>((count, hex::encode(&hash.finalize())))
        })();
        if result.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        journal.resurvey("rotation_inventory")?;
        let (inventory_heads, inventory_hash) = result?;
        let state = RotationState {
            intent,
            coordinator,
            cutoff,
            inventory_hash,
            inventory_heads,
            catalog_pages: 0,
            catalog_heads: 0,
            catalog_last: None,
            committed: false,
            resume_id: None,
        };
        let index = self.index();
        self.commit(&mut journal, index, |_| {
            vec![Frame::RotationPrepare(state.clone())]
        })?;
        Ok(state)
    }

    pub fn rotation_status(
        &self,
        coordinator: DeviceId,
        operation: &str,
    ) -> Result<RotationState, StoreError> {
        let journal = self.journal();
        let index = self.index();
        active(&index, coordinator)?;
        let state = index
            .authority
            .rotation
            .as_ref()
            .filter(|r| r.coordinator == coordinator && r.intent.operation == operation)
            .cloned()
            .ok_or(StoreError::AuthorityRefused("rotation_conflict"))?;
        if !journal.floor_ready() {
            return Err(StoreError::AuthorityRefused("floor_activation_pending"));
        }
        drop(index);
        Ok(state)
    }

    pub fn rotation_inventory(
        &self,
        coordinator: DeviceId,
        operation: &str,
        page: u64,
    ) -> Result<Vec<(FileId, VersionId)>, StoreError> {
        let state = self.rotation_status(coordinator, operation)?;
        let first = page
            .checked_mul(INVENTORY_PAGE)
            .ok_or(StoreError::AuthorityRefused("bad_inventory_page"))?;
        if first > state.inventory_heads || (first == state.inventory_heads && first != 0) {
            return Err(StoreError::AuthorityRefused("bad_inventory_page"));
        }
        let mut file = File::open(rotation_root(self, &state.intent).join("inventory"))?;
        (first
            ..state
                .inventory_heads
                .min(first.saturating_add(INVENTORY_PAGE)))
            .map(|n| source_at(&mut file, n))
            .collect()
    }

    pub fn rotation_catalog(
        &self,
        coordinator: DeviceId,
        operation: &str,
        page: u64,
        entries: Vec<CatalogEntry>,
    ) -> Result<RotationState, StoreError> {
        if entries.is_empty() || entries.len() > INVENTORY_PAGE as usize {
            return Err(StoreError::AuthorityRefused("bad_catalog_page"));
        }
        let bytes = catalog_value(&entries).to_json().into_bytes();
        if bytes.len() > CATALOG_BYTES {
            return Err(StoreError::AuthorityRefused("bad_catalog_page"));
        }
        let mut journal = self.journal();
        let index = self.index();
        active(&index, coordinator)?;
        let mut state = pending(&index.authority.rotation, coordinator, operation)?;
        let root = rotation_root(self, &state.intent);
        let path = root.join(format!("catalog-{page}"));
        if page < state.catalog_pages {
            if fs::read(&path)? == bytes {
                return Ok(state);
            }
            return Err(StoreError::AuthorityRefused("catalog_conflict"));
        }
        if page != state.catalog_pages
            || state
                .catalog_heads
                .checked_add(entries.len() as u64)
                .is_none_or(|n| n > state.inventory_heads)
        {
            return Err(StoreError::AuthorityRefused("catalog_conflict"));
        }
        unique_destinations(&root, state.catalog_pages, &entries)?;
        let mut inventory = File::open(root.join("inventory"))?;
        for (n, (f, v, new_file, new_head)) in entries.iter().enumerate() {
            if source_at(&mut inventory, state.catalog_heads + n as u64)? != (*f, *v) {
                return Err(StoreError::AuthorityRefused("catalog_conflict"));
            }
            let destination = index
                .files
                .get(new_file)
                .filter(|f| f.generation == Some(state.intent.current_map))
                .ok_or(StoreError::AuthorityRefused("generation_mismatch"))?;
            if !destination
                .versions
                .iter()
                .any(|v| v.version_id == *new_head && v.manifest_seal == ManifestSeal::Suite2)
            {
                return Err(StoreError::UnknownVersion);
            }
        }
        drop(index);
        journal.admit_quarantine(bytes.len() as u64)?;
        let tmp = root.join(format!("catalog-{page}.tmp"));
        let written = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&tmp)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            fs::rename(&tmp, &path)?;
            File::open(&root)?.sync_all()?;
            Ok::<(), StoreError>(())
        })();
        if written.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        journal.resurvey("rotation_catalog")?;
        written?;
        state.catalog_pages += 1;
        state.catalog_heads += entries.len() as u64;
        state.catalog_last = entries.last().map(|e| (e.0, e.1));
        let index = self.index();
        self.commit(&mut journal, index, |_| {
            vec![Frame::RotationProgress(state.clone())]
        })?;
        Ok(state)
    }

    pub fn rotation_catalog_commitment(&self, state: &RotationState) -> Result<String, StoreError> {
        let root = rotation_root(self, &state.intent);
        let mut hash = Sha256::new();
        for page in 0..state.catalog_pages {
            let digest = hex::decode(&file_hash(&root.join(format!("catalog-{page}")))?)
                .map_err(|_| StoreError::Corrupt("invalid catalog digest".into()))?;
            hash.update(&digest);
        }
        Ok(hex::encode(&hash.finalize()))
    }

    pub fn commit_rotation(
        &self,
        coordinator: DeviceId,
        intent: &RotationIntent,
        completion: &RotationCompletion,
        now: UnixMs,
    ) -> Result<RotationState, StoreError> {
        let mut journal = self.journal();
        let index = self.index();
        active(&index, coordinator)?;
        let mut state = index
            .authority
            .rotation
            .as_ref()
            .filter(|r| r.coordinator == coordinator && r.intent == *intent)
            .cloned()
            .ok_or(StoreError::AuthorityRefused("rotation_conflict"))?;
        if state.cutoff != completion.cutoff
            || state.inventory_hash != completion.inventory_hash
            || state.catalog_pages != completion.catalog_pages
            || self.rotation_catalog_commitment(&state)? != completion.catalog_hash
        {
            return Err(StoreError::AuthorityRefused("rotation_conflict"));
        }
        if state.committed {
            drop(index);
            journal.ensure_floor_marker()?;
            return Ok(state);
        }
        self.verify_rotation_files(&state)?;
        if state.catalog_heads != state.inventory_heads
            || !map_exists(&index, state.intent.current_map)
        {
            return Err(StoreError::AuthorityRefused("rotation_incomplete"));
        }
        state.committed = true;
        self.commit(&mut journal, index, |_| {
            vec![Frame::RotationCommit {
                state: state.clone(),
                at: now,
            }]
        })?;
        Ok(state)
    }

    pub fn resume_rotation(
        &self,
        intent: RotationIntent,
        resume_id: String,
        input: NewSetup,
        now: UnixMs,
    ) -> Result<SetupOutcome, StoreError> {
        RotationIntent::parse(&intent.value())?;
        if resume_id.len() != 32
            || !resume_id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(StoreError::AuthorityRefused("bad_resume_id"));
        }
        if input
            .recovery_verifier
            .as_ref()
            .is_some_and(|v| v != &intent.recovery_verifier)
        {
            return Err(StoreError::BadRecoveryProof);
        }
        let mut journal = self.journal();
        let index = self.index();
        let mut state = index
            .authority
            .rotation
            .as_ref()
            .filter(|r| !r.committed && r.intent == intent)
            .cloned()
            .ok_or(StoreError::AuthorityRefused("rotation_conflict"))?;
        if input.generation != Some(intent.current_map) || !input.recover_only {
            return Err(StoreError::AuthorityRefused("generation_mismatch"));
        }
        let proof = input
            .recovery_proof
            .as_deref()
            .ok_or(StoreError::BadRecoveryProof)?;
        if proof.len() != 64
            || !proof
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(StoreError::BadRecoveryProof);
        }
        let derived = hex::encode(&sha256::sha256(
            &hex::decode(proof).map_err(|_| StoreError::BadRecoveryProof)?,
        ));
        if !obsync_core::ct::eq(derived.as_bytes(), intent.recovery_verifier.as_bytes()) {
            return Err(StoreError::BadRecoveryProof);
        }
        // A resume ID that minted a retired grant can never disclose a newer
        // credential; it is recorded in the device's server-only association.
        if let Some(existing) = self.resume_association(&index, &resume_id) {
            if state.resume_id.as_deref() != Some(&resume_id) || existing != state.coordinator {
                return Err(StoreError::AuthorityRefused("resume_superseded"));
            }
            let record = index
                .devices
                .get(&existing)
                .ok_or(StoreError::UnknownDevice)?
                .record
                .clone();
            if record.name != input.device_name
                || record.platform != input.platform
                || record.app_version != input.app_version
            {
                return Err(StoreError::AuthorityRefused("rotation_conflict"));
            }
            active(&index, existing)?;
            drop(index);
            journal.ensure_floor_marker()?;
            return Ok(SetupOutcome {
                device: record,
                recovered: true,
                armed_at: None,
            });
        }
        let account_id = index.account_id().ok_or(StoreError::NotSetUp)?;
        let record = super::new_device_record(
            NewDevice {
                account_id,
                name: input.device_name,
                platform: input.platform,
                app_version: input.app_version,
                secret: input.secret,
                state: DeviceState::Active,
            },
            now,
        )?;
        let wrapped = self.wrap(record.device_id.as_bytes(), &input.secret);
        state.coordinator = record.device_id;
        state.resume_id = Some(resume_id);
        self.commit(&mut journal, index, |_| {
            vec![Frame::RotationTransfer {
                state,
                record: record.clone(),
                wrapped,
            }]
        })?;
        Ok(SetupOutcome {
            device: record,
            recovered: true,
            armed_at: None,
        })
    }

    fn resume_association(&self, index: &super::index::Index, resume_id: &str) -> Option<DeviceId> {
        index
            .devices
            .iter()
            .find(|(_, d)| d.resume_id.as_deref() == Some(resume_id))
            .map(|(id, _)| *id)
    }

    pub(crate) fn verify_rotation_files(&self, state: &RotationState) -> Result<(), StoreError> {
        let inventory = rotation_root(self, &state.intent).join("inventory");
        if fs::metadata(&inventory)?.len()
            != state
                .inventory_heads
                .checked_mul(ROW_BYTES)
                .ok_or_else(|| StoreError::Corrupt("inventory length overflow".into()))?
            || file_hash(&inventory)? != state.inventory_hash
        {
            return Err(StoreError::Corrupt("rotation inventory mismatch".into()));
        }
        let mut source = File::open(&inventory)?;
        let mut consumed = 0u64;
        let root = rotation_root(self, &state.intent);
        let mut last = None;
        for page in 0..state.catalog_pages {
            let path = root.join(format!("catalog-{page}"));
            if fs::metadata(&path)?.len() > CATALOG_BYTES as u64 {
                return Err(StoreError::Corrupt("catalog file too large".into()));
            }
            let bytes = fs::read(path)?;
            let value = obsync_core::json::parse(&bytes)
                .map_err(|_| StoreError::Corrupt("bad catalog file".into()))?;
            let entries = catalog_parse(&value)?;
            unique_destinations(&root, page, &entries)?;
            if catalog_value(&entries).to_json().as_bytes() != bytes {
                return Err(StoreError::Corrupt("noncanonical catalog".into()));
            }
            for (f, v, _, _) in entries {
                if consumed >= state.inventory_heads || source_at(&mut source, consumed)? != (f, v)
                {
                    return Err(StoreError::Corrupt("catalog inventory mismatch".into()));
                }
                consumed += 1;
                last = Some((f, v));
            }
        }
        if consumed != state.catalog_heads || last != state.catalog_last {
            return Err(StoreError::Corrupt("catalog progress mismatch".into()));
        }
        Ok(())
    }
}

impl super::Store {
    pub fn request_scope(&self, device: DeviceId) -> Option<Grant> {
        self.index().authority.grants.get(&device).cloned()
    }
    pub fn check_request_scope(
        &self,
        device: DeviceId,
        scope: &Option<Grant>,
    ) -> Result<(), StoreError> {
        let index = self.index();
        active(&index, device)?;
        if index.authority.grants.get(&device) != scope.as_ref() {
            return Err(StoreError::AuthorityRefused("grant_changed"));
        }
        Ok(())
    }
    pub fn current_generation(&self) -> Option<FileId> {
        self.index().authority.generation
    }
    /// Request admission after HMAC verification; publication rechecks separately.
    pub fn authorize_request(
        &self,
        device: DeviceId,
        method: &str,
        path: &str,
    ) -> Result<(), StoreError> {
        let index = self.index();
        active(&index, device)?;
        if let Some(rotation) = index.authority.pending() {
            let coordinator = device == rotation.coordinator;
            let coordination = path == "/v1/rotation/capabilities"
                || path == "/v1/rotation/prepare"
                || path == format!("/v1/rotation/{}", rotation.intent.operation)
                || path.starts_with(&format!("/v1/rotation/{}/", rotation.intent.operation));
            let reseed = path.starts_with("/v1/chunks/")
                || (method == "GET" && path.starts_with("/v1/files/"))
                || (method == "POST"
                    && path.starts_with("/v1/files/")
                    && path.ends_with("/versions"))
                || (method == "GET" && path == "/v1/account");
            if !coordinator || !(coordination || reseed) {
                return Err(StoreError::AuthorityRefused("rotation_pending"));
            }
        }
        Ok(())
    }
    pub(super) fn chunk_writer(
        &self,
        device: Option<DeviceId>,
        scope: &Option<Grant>,
    ) -> Result<Option<std::sync::MutexGuard<'_, super::journal::Journal>>, StoreError> {
        if device.is_none() {
            return Ok(None);
        }
        let journal = self.journal();
        if let Some(device) = device {
            let index = self.index();
            active(&index, device)?;
            if index.authority.grants.get(&device) != scope.as_ref() {
                return Err(StoreError::AuthorityRefused("grant_changed"));
            }
            if let Some(r) = index.authority.pending()
                && r.coordinator != device
            {
                return Err(StoreError::AuthorityRefused("rotation_pending"));
            }
            if index.authority.floor2() && !journal.floor_ready() {
                return Err(StoreError::AuthorityRefused("floor_activation_pending"));
            }
        }
        Ok(Some(journal))
    }
}

fn read_catalog(path: &Path) -> Result<Vec<CatalogEntry>, StoreError> {
    if fs::metadata(path)?.len() > CATALOG_BYTES as u64 {
        return Err(StoreError::Corrupt("catalog file too large".into()));
    }
    let bytes = fs::read(path)?;
    let value = obsync_core::json::parse(&bytes)
        .map_err(|_| StoreError::Corrupt("invalid catalog JSON".into()))?;
    let entries = catalog_parse(&value)?;
    if catalog_value(&entries).to_json().as_bytes() != bytes {
        return Err(StoreError::Corrupt("noncanonical catalog".into()));
    }
    Ok(entries)
}
fn unique_destinations(
    root: &Path,
    pages: u64,
    entries: &[CatalogEntry],
) -> Result<(), StoreError> {
    let mut new = std::collections::BTreeSet::new();
    for (_, _, f, v) in entries {
        if !new.insert((*f, *v)) {
            return Err(StoreError::AuthorityRefused("catalog_conflict"));
        }
    }
    // Memory stays bounded by this one page; prior pages are streamed once.
    for page in 0..pages {
        for (_, _, f, v) in read_catalog(&root.join(format!("catalog-{page}")))? {
            if new.contains(&(f, v)) {
                return Err(StoreError::AuthorityRefused("catalog_conflict"));
            }
        }
    }
    Ok(())
}

impl super::Store {
    fn ordinary_scope(
        index: &super::index::Index,
        device: DeviceId,
        scope: &Option<Grant>,
    ) -> Result<Option<FileId>, StoreError> {
        active(index, device)?;
        if index.authority.grants.get(&device) != scope.as_ref() {
            return Err(StoreError::AuthorityRefused("grant_changed"));
        }
        if index.authority.pending().is_some()
            || scope.as_ref().is_some_and(|g| g.operation.is_some())
        {
            return Err(StoreError::AuthorityRefused("rotation_pending"));
        }
        Ok(scope.as_ref().map(|g| g.generation))
    }
    pub fn changes_scoped(
        &self,
        device: DeviceId,
        scope: &Option<Grant>,
        since: Seq,
        limit: usize,
    ) -> Result<super::Changes, StoreError> {
        let index = self.index();
        let generation = Self::ordinary_scope(&index, device, scope)?;
        index.changes_generation(since, limit.max(1), generation)
    }
    pub fn files_page_scoped(
        &self,
        device: DeviceId,
        scope: &Option<Grant>,
        after: Option<&FileId>,
        limit: usize,
    ) -> Result<(Vec<super::FileSummary>, Option<FileId>), StoreError> {
        let index = self.index();
        let generation = Self::ordinary_scope(&index, device, scope)?;
        Ok(index.files_page_generation(after, limit.max(1), generation))
    }
}

fn tuple_id<T: std::str::FromStr>(value: &Value, width: usize) -> Result<T, StoreError> {
    value
        .as_str()
        .filter(|s| {
            s.len() == width
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| StoreError::Corrupt("invalid catalog identifier".into()))
}
