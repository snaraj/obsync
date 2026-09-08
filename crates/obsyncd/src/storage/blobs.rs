//! Ciphertext chunks on disk: layout, durable writes, mirrors, integrity.
//!
//! The durability rules are docs/storage.md, "Durability rules" 1: stream to
//! a temp file while hashing, verify the sid and the length, `fsync` the
//! file, `rename` it into place, `fsync` the directory. Only then may the
//! caller acknowledge. A crash therefore leaves either a complete chunk or a
//! temp file that startup removes. None of this is configurable
//! (AGENTS.md requirement 4).
#![forbid(unsafe_code)]

use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use obsync_core::sha256::Sha256;

use crate::storage::types::StoreError;
use crate::types::{Sid, UnixMs};

#[cfg(test)]
use crate::storage::Fault;
#[cfg(test)]
use std::sync::Mutex;

/// Copy buffer. Large enough to keep the disk busy, small enough that a
/// mobile-sized chunk never needs a second allocation strategy.
const BUF: usize = 64 * 1024;
/// Chunk files: readable by the server's user only.
const FILE_MODE: u32 = 0o600;
/// Chunk directories: the same, plus traversal.
const DIR_MODE: u32 = 0o700;

/// One chunk as the volume holds it: its id, its length, and when it landed.
pub(crate) type Chunk = (Sid, u64, UnixMs);

/// The blob volume and its mirrors.
pub(crate) struct Blobs {
    root: PathBuf,
    mirrors: Vec<PathBuf>,
    #[cfg(test)]
    fault: Mutex<Fault>,
}

impl Blobs {
    /// Create the layout on every volume and remove temp leftovers.
    ///
    /// Returns how many leftovers were removed, which the caller logs: a
    /// non-zero count is the visible trace of a crash mid-upload
    /// (requirement 12).
    pub(crate) fn open(root: &Path, mirrors: &[PathBuf]) -> Result<(Blobs, u64), StoreError> {
        let blobs = Blobs {
            root: root.to_path_buf(),
            mirrors: mirrors.to_vec(),
            #[cfg(test)]
            fault: Mutex::new(Fault::None),
        };
        let mut removed = 0;
        for volume in blobs.volumes() {
            make_dir(&volume.join("v1"))?;
            let tmp = volume.join("v1/tmp");
            make_dir(&tmp)?;
            for entry in fs::read_dir(&tmp)? {
                let path = entry?.path();
                if path.is_file() {
                    fs::remove_file(&path)?;
                    removed += 1;
                }
            }
        }
        Ok((blobs, removed))
    }

    fn volumes(&self) -> Vec<PathBuf> {
        let mut all = vec![self.root.clone()];
        all.extend(self.mirrors.iter().cloned());
        all
    }

    /// Where a chunk lives: `<volume>/v1/<sid[0..2]>/<sid[2..4]>/<sid>`.
    fn chunk_path(volume: &Path, sid: &Sid) -> PathBuf {
        let name = sid.to_string();
        volume
            .join("v1")
            .join(&name[0..2])
            .join(&name[2..4])
            .join(&name)
    }

    /// The chunk's path on the primary volume.
    pub(crate) fn path(&self, sid: &Sid) -> PathBuf {
        Blobs::chunk_path(&self.root, sid)
    }

    /// Stream `body` into place, verifying the sid and the length as it goes.
    ///
    /// Refuses before anything is published: a body that does not hash to
    /// `sid`, or whose length is not `declared_len`, leaves no file behind.
    pub(crate) fn write(
        &self,
        sid: &Sid,
        declared_len: u64,
        body: &mut dyn Read,
    ) -> Result<(), StoreError> {
        let tmp = self.root.join("v1/tmp").join(tmp_name());
        let mut file = create(&tmp)?;
        let outcome = hash_stream(body, Some(&mut file))
            .and_then(|(digest, total)| check(sid, declared_len, digest, total));
        if let Err(e) = outcome {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
        // A crash here leaves an unsynced temp file: startup removes it and
        // the chunk is simply absent, so the client re-uploads.
        #[cfg(test)]
        self.tripped(Fault::ChunkBeforeFsync)?;
        file.sync_all()?;
        drop(file);
        // A crash here leaves a synced temp file with no name in the tree:
        // startup removes it, same outcome.
        #[cfg(test)]
        self.tripped(Fault::ChunkBeforeRename)?;
        publish(&tmp, &Blobs::chunk_path(&self.root, sid))?;
        for mirror in &self.mirrors {
            self.mirror_copy(mirror, sid)?;
        }
        Ok(())
    }

    /// Read a body the store already holds, verifying it and keeping nothing.
    ///
    /// An upload of a chunk that is already stored still has to be read off
    /// the connection, and reading it costs nothing extra to verify: a forged
    /// body is refused with the same `sid_mismatch` as a first upload rather
    /// than being quietly accepted because the sid happened to be known.
    pub(crate) fn drain(
        &self,
        sid: &Sid,
        declared_len: u64,
        body: &mut dyn Read,
    ) -> Result<(), StoreError> {
        let (digest, total) = hash_stream(body, None)?;
        check(sid, declared_len, digest, total)
    }

    /// Copy a published chunk onto one mirror with the same durability rules.
    fn mirror_copy(&self, mirror: &Path, sid: &Sid) -> Result<(), StoreError> {
        let source = Blobs::chunk_path(&self.root, sid);
        let tmp = mirror.join("v1/tmp").join(tmp_name());
        let mut input = File::open(&source)?;
        let mut output = create(&tmp)?;
        io::copy(&mut input, &mut output)?;
        output.sync_all()?;
        drop(output);
        publish(&tmp, &Blobs::chunk_path(mirror, sid))
    }

    /// Open a chunk for reading, with its length.
    pub(crate) fn open_chunk(&self, sid: &Sid) -> Result<(File, u64), StoreError> {
        let file = File::open(self.path(sid))?;
        let len = file.metadata()?.len();
        Ok((file, len))
    }

    /// Every chunk on the primary volume, with the count of strays beside it.
    ///
    /// The blob volume, not the journal, is the record of which chunks exist:
    /// a chunk is a file, so a chunk that a crash lost is simply missing and
    /// the client re-uploads it.
    pub(crate) fn scan(&self) -> Result<(Vec<Chunk>, u64), StoreError> {
        let mut found = Vec::new();
        let mut strays = 0;
        let v1 = self.root.join("v1");
        for outer in read_dir_sorted(&v1)? {
            if outer.file_name().is_some_and(|n| n == "tmp") || !outer.is_dir() {
                continue;
            }
            for inner in read_dir_sorted(&outer)? {
                if !inner.is_dir() {
                    strays += 1;
                    continue;
                }
                for file in read_dir_sorted(&inner)? {
                    match file
                        .file_name()
                        .and_then(|n| n.to_str())
                        .and_then(|n| n.parse::<Sid>().ok())
                    {
                        Some(sid) => {
                            let meta = file.metadata()?;
                            found.push((sid, meta.len(), modified(&meta)));
                        }
                        None => strays += 1,
                    }
                }
            }
        }
        Ok((found, strays))
    }

    /// Re-hash a stored chunk. `None` when it is not on the volume.
    pub(crate) fn verify(&self, volume: &Path, sid: &Sid) -> Result<Option<bool>, StoreError> {
        let path = Blobs::chunk_path(volume, sid);
        let mut file = match File::open(&path) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(StoreError::Io(e)),
        };
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; BUF];
        loop {
            match file.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => hasher.update(&buf[..n]),
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(StoreError::Io(e)),
            }
        }
        Ok(Some(Sid::new(hasher.finalize()) == *sid))
    }

    /// Re-hash the primary copy.
    pub(crate) fn verify_primary(&self, sid: &Sid) -> Result<Option<bool>, StoreError> {
        self.verify(&self.root, sid)
    }

    /// Replace a bad primary copy from the first mirror that hashes correctly.
    ///
    /// Returns whether a repair happened.
    pub(crate) fn repair_from_mirror(&self, sid: &Sid) -> Result<bool, StoreError> {
        for mirror in &self.mirrors {
            if self.verify(mirror, sid)? != Some(true) {
                continue;
            }
            let source = Blobs::chunk_path(mirror, sid);
            let tmp = self.root.join("v1/tmp").join(tmp_name());
            let mut input = File::open(&source)?;
            let mut output = create(&tmp)?;
            io::copy(&mut input, &mut output)?;
            output.sync_all()?;
            drop(output);
            publish(&tmp, &Blobs::chunk_path(&self.root, sid))?;
            return Ok(true);
        }
        Ok(false)
    }

    /// Move a bad primary copy into `quarantine`, leaving the mirrors alone.
    pub(crate) fn quarantine(&self, sid: &Sid, quarantine: &Path) -> Result<(), StoreError> {
        make_dir(quarantine)?;
        let target = quarantine.join(sid.to_string());
        fs::rename(self.path(sid), &target)?;
        fsync_dir(quarantine)?;
        fsync_parent(&self.path(sid))?;
        Ok(())
    }

    /// Delete a chunk from the primary volume and every mirror.
    pub(crate) fn remove(&self, sid: &Sid) -> Result<(), StoreError> {
        for volume in self.volumes() {
            let path = Blobs::chunk_path(&volume, sid);
            match fs::remove_file(&path) {
                Ok(()) => fsync_parent(&path)?,
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(StoreError::Io(e)),
            }
        }
        Ok(())
    }

    /// Arm a crash point for the next write. Tests only.
    #[cfg(test)]
    pub(crate) fn set_fault(&self, fault: Fault) {
        *self.fault.lock().expect("fault lock") = fault;
    }

    #[cfg(test)]
    fn tripped(&self, at: Fault) -> Result<(), StoreError> {
        if *self.fault.lock().expect("fault lock") == at {
            return Err(StoreError::Io(io::Error::new(
                io::ErrorKind::Interrupted,
                "injected crash",
            )));
        }
        Ok(())
    }
}

/// When a chunk file was last written, which is when the store first held it.
///
/// Taking the age from the filesystem rather than from the process means a
/// restart does not reset the 24 h protection a newborn chunk gets, so a
/// restart cannot postpone collection indefinitely.
fn modified(meta: &fs::Metadata) -> UnixMs {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| UnixMs(u64::try_from(d.as_millis()).unwrap_or(u64::MAX)))
        .unwrap_or_else(UnixMs::now)
}

/// Read `body` to its end, hashing it and optionally writing it out.
fn hash_stream(
    body: &mut dyn Read,
    mut out: Option<&mut File>,
) -> Result<([u8; 32], u64), StoreError> {
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; BUF];
    let mut total: u64 = 0;
    loop {
        let read = match body.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(StoreError::Io(e)),
        };
        hasher.update(&buf[..read]);
        if let Some(file) = out.as_deref_mut() {
            file.write_all(&buf[..read])?;
        }
        total += read as u64;
    }
    Ok((hasher.finalize(), total))
}

/// The two refusals every body faces, in the order the protocol states them.
fn check(sid: &Sid, declared_len: u64, digest: [u8; 32], total: u64) -> Result<(), StoreError> {
    if total != declared_len {
        return Err(StoreError::LengthMismatch {
            declared: declared_len,
            actual: total,
        });
    }
    let actual = Sid::new(digest);
    if actual != *sid {
        return Err(StoreError::SidMismatch {
            expected: *sid,
            actual,
        });
    }
    Ok(())
}

/// A temp name unique across threads, processes and reboots.
fn tmp_name() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    format!("{}-{n}-{nanos}", std::process::id())
}

fn create(path: &Path) -> Result<File, StoreError> {
    Ok(OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(FILE_MODE)
        .open(path)?)
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

/// `rename` into place and `fsync` the directory that now names the file.
fn publish(tmp: &Path, target: &Path) -> Result<(), StoreError> {
    if let Some(parent) = target.parent() {
        make_dir(parent)?;
    }
    fs::rename(tmp, target)?;
    fsync_parent(target)
}

fn fsync_parent(path: &Path) -> Result<(), StoreError> {
    match path.parent() {
        Some(parent) => fsync_dir(parent),
        None => Ok(()),
    }
}

/// `fsync` a directory: the rename is only durable once the directory is.
fn fsync_dir(dir: &Path) -> Result<(), StoreError> {
    match File::open(dir) {
        Ok(handle) => {
            handle.sync_all()?;
            Ok(())
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(StoreError::Io(e)),
    }
}

fn read_dir_sorted(dir: &Path) -> Result<Vec<PathBuf>, StoreError> {
    let mut paths = Vec::new();
    match fs::read_dir(dir) {
        Ok(entries) => {
            for entry in entries {
                paths.push(entry?.path());
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(paths),
        Err(e) => return Err(StoreError::Io(e)),
    }
    paths.sort();
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::testutil::TempDir;
    use obsync_core::sha256::sha256;

    fn blobs(dir: &TempDir, mirrors: &[PathBuf]) -> Blobs {
        Blobs::open(&dir.path().join("blobs"), mirrors)
            .expect("layout is created")
            .0
    }

    fn sid_of(body: &[u8]) -> Sid {
        Sid::new(sha256(body))
    }

    #[test]
    fn a_chunk_lands_sharded_and_readable() {
        let dir = TempDir::new("blobs-write");
        let store = blobs(&dir, &[]);
        let body = b"ciphertext-sentinel".to_vec();
        let sid = sid_of(&body);
        store
            .write(&sid, body.len() as u64, &mut body.as_slice())
            .expect("write lands");

        let name = sid.to_string();
        let expected = dir
            .path()
            .join("blobs/v1")
            .join(&name[0..2])
            .join(&name[2..4])
            .join(&name);
        assert!(expected.is_file(), "sharded path {expected:?}");
        let (mut file, len) = store.open_chunk(&sid).expect("chunk opens");
        assert_eq!(len, body.len() as u64);
        let mut read = Vec::new();
        file.read_to_end(&mut read).expect("chunk reads");
        assert_eq!(read, body);
        assert_eq!(store.verify_primary(&sid).expect("verify"), Some(true));
    }

    #[test]
    fn a_wrong_sid_or_length_leaves_no_file() {
        let dir = TempDir::new("blobs-refuse");
        let store = blobs(&dir, &[]);
        let body = b"ciphertext-sentinel".to_vec();
        let claimed = sid_of(b"a different chunk");

        let err = store
            .write(&claimed, body.len() as u64, &mut body.as_slice())
            .expect_err("a forged sid is refused");
        assert!(matches!(err, StoreError::SidMismatch { .. }), "{err}");
        assert!(!store.path(&claimed).exists(), "no file is published");

        let sid = sid_of(&body);
        let err = store
            .write(&sid, 999, &mut body.as_slice())
            .expect_err("a wrong length is refused");
        assert!(
            matches!(
                err,
                StoreError::LengthMismatch {
                    declared: 999,
                    actual: 19
                }
            ),
            "{err}"
        );
        assert!(!store.path(&sid).exists(), "no file is published");
        let tmp: Vec<_> = fs::read_dir(dir.path().join("blobs/v1/tmp"))
            .expect("tmp dir")
            .map(|e| e.expect("entry").path())
            .collect();
        assert!(
            tmp.is_empty(),
            "a refusal leaves no temp file either: {tmp:?}"
        );
        let (leftovers, _) = Blobs::open(&dir.path().join("blobs"), &[]).expect("reopen");
        let (chunks, strays) = leftovers.scan().expect("scan");
        assert_eq!(chunks.len(), 0, "nothing survived the refusals");
        assert_eq!(strays, 0);
    }

    #[test]
    fn a_crash_before_fsync_or_rename_leaves_only_a_temp_file() {
        for (fault, label) in [
            (Fault::ChunkBeforeFsync, "before fsync"),
            (Fault::ChunkBeforeRename, "before rename"),
        ] {
            let dir = TempDir::new("blobs-crash");
            let root = dir.path().join("blobs");
            let store = blobs(&dir, &[]);
            let body = b"ciphertext-sentinel".to_vec();
            let sid = sid_of(&body);
            store.set_fault(fault);
            let err = store
                .write(&sid, body.len() as u64, &mut body.as_slice())
                .expect_err("the injected crash surfaces");
            assert!(matches!(err, StoreError::Io(_)), "{label}: {err}");
            assert!(!store.path(&sid).exists(), "{label}: nothing is published");
            let tmp: Vec<_> = fs::read_dir(root.join("v1/tmp"))
                .expect("tmp dir")
                .map(|e| e.expect("entry").path())
                .collect();
            assert_eq!(tmp.len(), 1, "{label}: the temp file is the only residue");

            // Restart: the leftover is removed and the chunk is simply absent.
            let (reopened, removed) = Blobs::open(&root, &[]).expect("reopen");
            assert_eq!(removed, 1, "{label}: startup removes the leftover");
            let (chunks, strays) = reopened.scan().expect("scan");
            assert!(chunks.is_empty(), "{label}: no chunk survived");
            assert_eq!(strays, 0);
        }
    }

    #[test]
    fn mirrors_are_written_before_the_write_returns() {
        let dir = TempDir::new("blobs-mirror");
        let mirror = dir.path().join("mirror");
        let store = blobs(&dir, std::slice::from_ref(&mirror));
        let body = b"ciphertext-sentinel".to_vec();
        let sid = sid_of(&body);
        store
            .write(&sid, body.len() as u64, &mut body.as_slice())
            .expect("write lands");
        assert_eq!(store.verify(&mirror, &sid).expect("mirror"), Some(true));

        // Corrupt the primary; the mirror repairs it.
        fs::write(store.path(&sid), b"rot").expect("corrupt the primary");
        assert_eq!(store.verify_primary(&sid).expect("verify"), Some(false));
        assert!(store.repair_from_mirror(&sid).expect("repair"), "repaired");
        assert_eq!(store.verify_primary(&sid).expect("verify"), Some(true));

        // With no good copy anywhere, repair reports failure rather than lying.
        fs::write(store.path(&sid), b"rot").expect("corrupt the primary");
        fs::write(Blobs::chunk_path(&mirror, &sid), b"rot").expect("corrupt the mirror");
        assert!(
            !store.repair_from_mirror(&sid).expect("repair"),
            "no source"
        );
    }

    #[test]
    fn quarantine_and_remove_take_the_chunk_out_of_the_tree() {
        let dir = TempDir::new("blobs-quarantine");
        let mirror = dir.path().join("mirror");
        let store = blobs(&dir, std::slice::from_ref(&mirror));
        let body = b"ciphertext-sentinel".to_vec();
        let sid = sid_of(&body);
        store
            .write(&sid, body.len() as u64, &mut body.as_slice())
            .expect("write lands");

        let quarantine = dir.path().join("quarantine");
        store.quarantine(&sid, &quarantine).expect("quarantined");
        assert!(!store.path(&sid).exists(), "gone from the primary");
        assert!(
            quarantine.join(sid.to_string()).is_file(),
            "kept for the operator"
        );
        assert_eq!(
            store.verify(&mirror, &sid).expect("mirror"),
            Some(true),
            "the mirror copy is untouched"
        );

        store.remove(&sid).expect("removed");
        assert_eq!(store.verify(&mirror, &sid).expect("mirror"), None);
        store.remove(&sid).expect("removing twice is not an error");
    }

    #[test]
    fn scan_reports_chunks_and_counts_strays() {
        let dir = TempDir::new("blobs-scan");
        let store = blobs(&dir, &[]);
        for body in [b"one".to_vec(), b"two".to_vec(), b"three".to_vec()] {
            let sid = sid_of(&body);
            store
                .write(&sid, body.len() as u64, &mut body.as_slice())
                .expect("write lands");
        }
        let stray_dir = dir.path().join("blobs/v1/zz/zz");
        make_dir(&stray_dir).expect("stray dir");
        fs::write(stray_dir.join("not-a-sid"), b"x").expect("stray file");

        let (chunks, strays) = store.scan().expect("scan");
        assert_eq!(chunks.len(), 3);
        assert_eq!(strays, 1);
        let total: u64 = chunks.iter().map(|(_, len, _)| len).sum();
        assert_eq!(total, 3 + 3 + 5);
    }
}
