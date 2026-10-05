#![forbid(unsafe_code)]

use crate::{
    Error, Result,
    args::Args,
    context::{self, Plan, State},
    custody::{self, Custody},
};
use obsync_core::{
    json::{self, Value},
    sha256::sha256,
};
use std::{
    fs::{self, File, TryLockError},
    io::{Seek, SeekFrom, Write},
    path::PathBuf,
    time::Instant,
};

const MAGIC: &[u8] = b"OBSYNC-CONTEXT-1\n";
const LOCK: &str = "contexts.lock";
const SLOTS: [&str; 2] = ["contexts.0", "contexts.1"];
const MAX_FILE: usize = context::MAX_STATE + MAGIC.len() + 4 + 32;
enum Slot {
    Empty,
    Partial,
    Complete(State),
}
struct Read {
    state: State,
    partial: Option<usize>,
}
pub struct Store {
    pub path: PathBuf,
    pub target: String,
    custody: Custody,
    default_path: bool,
}
fn corrupt() -> Error {
    Error::new(
        "invalid_config",
        "Context snapshots have an invalid checksum, sequence or closed schema; recovery cannot discard committed state.",
        4,
    )
}
fn recover_required() -> Error {
    Error::new(
        "recovery_required",
        "An interrupted snapshot requires 'obsync config recover' before reading or applying.",
        10,
    )
}
fn busy() -> Error {
    Error::new(
        "config_busy",
        "Another configuration operation holds the lock; retry the same plan.",
        5,
    )
}
impl Store {
    pub fn finish(&mut self) -> Result<()> {
        self.custody.finish()
    }
    pub fn new(args: &Args, deadline: Instant) -> Result<Self> {
        let path = if let Some(path) = args.get("config-dir") {
            custody::exact(path, false)?
        } else {
            default_path()?
        };
        let target = context::digest(path.to_str().unwrap().as_bytes());
        Ok(Self {
            path,
            target,
            custody: Custody::new(deadline, args)?,
            default_path: !args.has("config-dir"),
        })
    }
    fn inventory(&mut self) -> Result<()> {
        for item in fs::read_dir(&self.path).map_err(custody::io_error)?.take(7) {
            let name = item.map_err(custody::io_error)?.file_name();
            #[cfg(windows)]
            if [LOCK, SLOTS[0], SLOTS[1]]
                .iter()
                .any(|base| name == format!("{base}.obsync-create").as_str())
            {
                let file = self.custody.file(&self.path.join(&name), false)?;
                if file.metadata().map_err(custody::io_error)?.len() != 0 {
                    return Err(corrupt());
                }
                continue;
            }
            if ![LOCK, SLOTS[0], SLOTS[1]].iter().any(|n| name == *n) {
                return Err(Error::new(
                    "unknown_config_entry",
                    "Configuration contains an unrecognized entry; no automatic conversion or cleanup is performed.",
                    4,
                ));
            }
        }
        Ok(())
    }
    fn lock(&mut self, write: bool, create: bool) -> Result<Option<File>> {
        if create && self.default_path {
            // Reads and planning never create storage. On the first confirmed
            // write, create only missing default parents with private custody.
            let mut missing = Vec::new();
            for at in self
                .path
                .parent()
                .ok_or_else(custody::unsafe_path)?
                .ancestors()
            {
                if custody::present(at)?.is_some() {
                    break;
                }
                missing.push(at.to_owned());
            }
            for at in missing.iter().rev() {
                self.custody.directory(at, true)?;
            }
        }
        if !self.custody.directory(&self.path, create)? {
            return Ok(None);
        }
        self.inventory()?;
        let lockpath = self.path.join(LOCK);
        if custody::present(&lockpath)?.is_none() {
            for name in SLOTS {
                if custody::present(&self.path.join(name))?.is_some() {
                    return Err(corrupt());
                }
            }
            if !create {
                return Ok(None);
            }
            self.custody.create_file(&lockpath)?;
        }
        let lock = self.custody.file(&lockpath, write)?;
        if lock.metadata().map_err(custody::io_error)?.len() != 0 {
            return Err(corrupt());
        }
        let result = if write {
            lock.try_lock()
        } else {
            lock.try_lock_shared()
        };
        result.map_err(|error| match error {
            TryLockError::WouldBlock => busy(),
            TryLockError::Error(_) => custody::unsafe_path(),
        })?;
        // A newly created lock may have come from a concurrent initializer.
        if create {
            lock.sync_all().map_err(custody::io_error)?;
            self.custody.sync_parent(&lockpath)?;
        }
        self.inventory()?;
        Ok(Some(lock))
    }
    fn slot(&mut self, index: usize) -> Result<Slot> {
        let path = self.path.join(SLOTS[index]);
        if custody::present(&path)?.is_none() {
            return Ok(Slot::Empty);
        }
        let mut file = self.custody.file(&path, false)?;
        let bytes = custody::bounded(&mut file, MAX_FILE)?;
        if bytes.is_empty() {
            return Ok(Slot::Empty);
        }
        if bytes.len() < MAGIC.len() + 4 {
            if !MAGIC.starts_with(&bytes[..bytes.len().min(MAGIC.len())]) {
                return Err(corrupt());
            }
            return Ok(Slot::Partial);
        }
        if !bytes.starts_with(MAGIC) {
            return Err(corrupt());
        }
        let length =
            u32::from_be_bytes(bytes[MAGIC.len()..MAGIC.len() + 4].try_into().unwrap()) as usize;
        if length == 0 || length > context::MAX_STATE {
            return Err(corrupt());
        }
        let end = MAGIC.len() + 4 + length;
        if bytes.len() < end + 32 {
            return Ok(Slot::Partial);
        }
        if bytes.len() != end + 32 || sha256(&bytes[..end]).as_slice() != &bytes[end..] {
            return Err(corrupt());
        }
        let value = json::parse(&bytes[MAGIC.len() + 4..end]).map_err(|_| corrupt())?;
        let state = State::parse(&value).map_err(|_| corrupt())?;
        if state.revision == 0
            || state.revision % 2 != index as u64
            || state.json().to_json().as_bytes() != &bytes[MAGIC.len() + 4..end]
        {
            return Err(corrupt());
        }
        Ok(Slot::Complete(state))
    }
    fn read_locked(&mut self) -> Result<Read> {
        let slots = [self.slot(0)?, self.slot(1)?];
        let mut complete = slots
            .iter()
            .filter_map(|s| {
                if let Slot::Complete(state) = s {
                    Some(state)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        complete.sort_by_key(|s| s.revision);
        if complete.len() == 2 && complete[0].revision + 1 != complete[1].revision {
            return Err(corrupt());
        }
        let state = complete.last().map_or_else(State::empty, |s| (*s).clone());
        let partial = slots
            .iter()
            .enumerate()
            .filter_map(|(i, s)| matches!(s, Slot::Partial).then_some(i))
            .collect::<Vec<_>>();
        if partial.len() > 1
            || partial
                .first()
                .is_some_and(|i| *i as u64 == (state.revision % 2))
        {
            return Err(corrupt());
        }
        if complete.is_empty() && !matches!(slots[0], Slot::Empty) {
            return Err(corrupt());
        }
        Ok(Read {
            state,
            partial: partial.first().copied(),
        })
    }
    pub fn read(&mut self) -> Result<(State, bool)> {
        let Some(_lock) = self.lock(false, false)? else {
            return Ok((State::empty(), false));
        };
        let read = self.read_locked()?;
        if read.partial.is_some() {
            return Err(recover_required());
        }
        Ok((read.state, true))
    }
    pub fn apply(&mut self, plan: &Plan) -> Result<Value> {
        // Reject a stale/invalid plan before creating any new configuration.
        let (before, _) = self.read()?;
        plan.apply(&before)?;
        let _lock = self.lock(true, true)?.ok_or_else(corrupt)?;
        let read = self.read_locked()?;
        if read.partial.is_some() {
            return Err(recover_required());
        }
        let (next, receipt, replayed) = plan.apply(&read.state)?;
        if replayed {
            let file = self
                .custody
                .file(&self.path.join(SLOTS[(next.revision % 2) as usize]), true)?;
            file.sync_all().map_err(custody::io_error)?;
            self.custody.sync_parent(&self.path.join(LOCK))?;
        } else {
            let path = self.path.join(SLOTS[(next.revision % 2) as usize]);
            if custody::present(&path)?.is_none() {
                self.custody.create_file(&path)?;
            }
            let mut file = self.custody.file(&path, true)?;
            let data = next.json().to_json();
            let mut body = MAGIC.to_vec();
            body.extend((data.len() as u32).to_be_bytes());
            body.extend(data.as_bytes());
            plan.live()?;
            self.custody.check_time()?;
            let commit = (|| -> Result<()> {
                // The other slot remains the last complete state throughout.
                // The seal is appended only after the full body is flushed.
                file.set_len(0).map_err(custody::io_error)?;
                // Persist removal of the previous seal before any body bytes
                // can reach disk; an old full length/seal must not survive a
                // partially persisted overwrite after power loss.
                file.sync_all().map_err(custody::io_error)?;
                file.seek(SeekFrom::Start(0)).map_err(custody::io_error)?;
                file.write_all(&body).map_err(custody::io_error)?;
                file.sync_all().map_err(custody::io_error)?;
                plan.live()?;
                self.custody.check_time()?;
                file.write_all(&sha256(&body)).map_err(custody::io_error)?;
                file.sync_all().map_err(custody::io_error)?;
                self.custody.sync_parent(&path)?;
                self.custody.check_time()?;
                let observed = self.read_locked()?;
                if observed.partial.is_some() || observed.state.json() != next.json() {
                    return Err(corrupt());
                }
                Ok(())
            })();
            if commit.is_err() {
                return Err(Error::new(
                    "write_unknown",
                    "A snapshot write was attempted but completion is unconfirmed; recover if required, then retry the same unexpired plan.",
                    7,
                ));
            }
        }
        let mut pairs = receipt.as_object().unwrap().to_vec();
        pairs.push(("replayed".into(), Value::Bool(replayed)));
        Ok(Value::Object(pairs))
    }
    pub fn recover(&mut self) -> Result<State> {
        #[cfg(windows)]
        {
            // An interrupted first publication can leave only the exact empty
            // lock companion. Finish that publication before acquiring its lock.
            if self.custody.directory(&self.path, false)? {
                self.inventory()?;
                let lock = self.path.join(LOCK);
                if custody::present(&lock)?.is_none()
                    && custody::present(&self.path.join(format!("{LOCK}.obsync-create")))?.is_some()
                {
                    self.custody.create_file(&lock)?;
                }
            }
        }
        let Some(_lock) = self.lock(true, false)? else {
            return Err(Error::new(
                "context_missing",
                "There is no local configuration to recover.",
                6,
            ));
        };
        let read = self.read_locked()?;
        if let Some(index) = read.partial {
            let file = self.custody.file(&self.path.join(SLOTS[index]), true)?;
            file.set_len(0).map_err(custody::io_error)?;
            file.sync_all().map_err(custody::io_error)?;
        }
        for name in SLOTS {
            let path = self.path.join(name);
            if custody::present(&path)?.is_some() {
                self.custody
                    .file(&path, true)?
                    .sync_all()
                    .map_err(custody::io_error)?;
            }
        }
        self.custody.sync_parent(&self.path.join(LOCK))?;
        #[cfg(windows)]
        for name in [LOCK, SLOTS[0], SLOTS[1]] {
            let path = self.path.join(format!("{name}.obsync-create"));
            if custody::present(&path)?.is_some() {
                let file = self.custody.file(&path, false)?;
                if file.metadata().map_err(custody::io_error)?.len() != 0 {
                    return Err(corrupt());
                }
                drop(file);
                fs::remove_file(&path).map_err(custody::io_error)?;
            }
        }
        let after = self.read_locked()?;
        if after.partial.is_some() || after.state.json() != read.state.json() {
            return Err(corrupt());
        }
        Ok(after.state)
    }
}

fn default_path() -> Result<PathBuf> {
    let variable = |key| {
        std::env::var(key).map_err(|_| Error::input(
        "The default settings folder is unavailable. Supply --config-dir with an absolute private directory.",
    ))
    };
    #[cfg(target_os = "macos")]
    let base = custody::exact(&variable("HOME")?, false)?.join("Library/Application Support");
    #[cfg(target_os = "linux")]
    let base = match std::env::var_os("XDG_CONFIG_HOME") {
        Some(value) => custody::exact(value.to_str().ok_or_else(custody::unsafe_path)?, false)?,
        None => custody::exact(&variable("HOME")?, false)?.join(".config"),
    };
    #[cfg(windows)]
    let base = custody::exact(&variable("APPDATA")?, false)?;
    custody::exact(
        base.join("obsync")
            .to_str()
            .ok_or_else(custody::unsafe_path)?,
        false,
    )
}
