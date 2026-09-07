//! Volume-root and credential-file posture: type, owner, and mode, decided
//! on every start and by `obsyncd check`.
//!
//! A restored snapshot, a `tar -x`, a `docker cp`, or a bind mount can hand
//! the server volumes it did not create. Trusting what is already there is
//! how the standing dashboard recovery login and the wrapping material that
//! opens every stored device credential end up world-readable while the
//! startup line still claims 0600. The volumes are therefore measured, not
//! assumed, before a single byte is read or written through them.
//!
//! Fail-closed (AGENTS.md requirement 4). What cannot be corrected refuses
//! the start: a symlink is never followed, a wrong file type is never used,
//! and a foreign owner is never accepted, because this process cannot
//! `chown` and whoever does own the file can widen it again the moment the
//! pass looks away. What can be corrected is corrected and then RE-READ off
//! the volume: a mode that was set is not a mode that stuck. Every decision
//! is one structured line (requirement 12), and no line carries a filesystem
//! location or any file content.
//!
//! Standard library only (requirement 5): `symlink_metadata`,
//! `set_permissions`, `MetadataExt`, `PermissionsExt`.
#![forbid(unsafe_code)]

use std::fs::{self, DirBuilder, OpenOptions, Permissions};
use std::io;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use crate::config::StorageConfig;
use crate::log::{Log, Val};

use super::StoreError;

/// The permission bits a decision is made on.
const MODE_MASK: u32 = 0o777;
/// A credential file: its owner reads and writes it, nobody else sees it.
const FILE_MODE: u32 = 0o600;
/// A volume root: its owner enters it, nobody else may even traverse it.
const DIR_MODE: u32 = 0o700;
/// The versioned root each volume keeps its data under.
const ROOT_DIR: &str = "v1";
/// The file the pass creates to learn which user this process runs as.
const PROBE: &str = ".posture-probe";

/// What the pass is looking at. The label reaches the log; the location
/// never does.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PathClass {
    /// The wrapping material on the journal volume, which opens every stored
    /// device credential.
    ServerKey,
    /// The first-boot credential, which is also the standing dashboard
    /// recovery login (`docs/architecture.md` 4.5).
    SetupToken,
    /// A chunk volume's root: the primary and one per mirror.
    BlobsRoot,
    /// The journal volume's root, which holds both files above.
    JournalRoot,
}

impl PathClass {
    /// The word this class logs and reports as.
    pub const fn label(self) -> &'static str {
        match self {
            PathClass::ServerKey => "server_key",
            PathClass::SetupToken => "setup_token",
            PathClass::BlobsRoot => "blobs_root",
            PathClass::JournalRoot => "journal_root",
        }
    }

    /// Whether this class must be a directory.
    const fn is_dir(self) -> bool {
        matches!(self, PathClass::BlobsRoot | PathClass::JournalRoot)
    }

    /// The one mode this class may rest at.
    pub const fn required_mode(self) -> u32 {
        if self.is_dir() { DIR_MODE } else { FILE_MODE }
    }

    /// Where this class lives on its volume.
    ///
    /// One definition for the pass and for the code that creates the file,
    /// so a check and a creation can never disagree about which file is
    /// meant.
    pub fn path(self, volume_dir: &Path) -> PathBuf {
        let root = volume_dir.join(ROOT_DIR);
        match self {
            PathClass::ServerKey => root.join("server.key"),
            PathClass::SetupToken => root.join("setup-token"),
            PathClass::BlobsRoot | PathClass::JournalRoot => root,
        }
    }
}

/// What one path was found to be, after the pass had its way with it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Decision {
    /// Already at the required mode.
    Ok {
        /// The mode read off the volume.
        mode: u32,
    },
    /// Not at the required mode, corrected, and re-read at it.
    Repaired {
        /// The mode the volume arrived with.
        from: u32,
        /// The mode the re-read found.
        to: u32,
    },
    /// Not there. First boot creates it at the required mode.
    Absent,
}

impl Decision {
    /// The word this decision logs and reports as.
    pub const fn word(self) -> &'static str {
        match self {
            Decision::Ok { .. } => "ok",
            Decision::Repaired { .. } => "repaired",
            Decision::Absent => "absent",
        }
    }

    /// The mode the volume now holds, or `None` when the path is not there.
    pub const fn mode(self) -> Option<u32> {
        match self {
            Decision::Ok { mode } => Some(mode),
            Decision::Repaired { to, .. } => Some(to),
            Decision::Absent => None,
        }
    }
}

/// One class's result, for `obsyncd check`'s report.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Outcome {
    /// Which class this line is about.
    pub class: PathClass,
    /// What the pass decided.
    pub decision: Decision,
}

/// The three facts a decision is made on, read without following a symlink.
///
/// A struct rather than a `Metadata` so the re-read after a correction can be
/// driven by a test: a filesystem that accepts `chmod` and ignores it is not
/// reproducible in a hermetic test, and the branch that catches one is
/// exactly the branch worth pinning.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Facts {
    kind: Kind,
    uid: u32,
    mode: u32,
}

/// What sits at a location.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    /// A link. Never followed, never repaired.
    Link,
    /// A directory.
    Dir,
    /// A regular file.
    File,
    /// A socket, a device, a fifo: nothing this server stores.
    Other,
}

/// Read the facts off the volume. `symlink_metadata` does not follow a link,
/// so a link is reported as one instead of as whatever it points at.
fn read_facts(path: &Path) -> io::Result<Facts> {
    let meta = fs::symlink_metadata(path)?;
    let file_type = meta.file_type();
    let kind = if file_type.is_symlink() {
        Kind::Link
    } else if file_type.is_dir() {
        Kind::Dir
    } else if file_type.is_file() {
        Kind::File
    } else {
        Kind::Other
    };
    Ok(Facts {
        kind,
        uid: meta.uid(),
        mode: meta.mode() & MODE_MASK,
    })
}

/// A completed posture pass, holding the user id every path is measured
/// against.
///
/// Owning one is the proof that the pass ran: the functions that read or
/// create a credential file take a reference to it, so there is no way to
/// reach one of those files on a volume whose posture was never decided.
#[derive(Debug)]
pub struct Posture {
    uid: u32,
    outcomes: Vec<Outcome>,
}

impl Posture {
    /// Decide the posture of both volume roots, every mirror root, and both
    /// credential files, creating a root that is not there at 0700.
    ///
    /// # Errors
    /// The first class that cannot be made safe, after its refusal line.
    pub fn enforce(cfg: &StorageConfig, log: &Log) -> Result<Posture, StoreError> {
        let journal_root = PathClass::JournalRoot.path(&cfg.journal_dir);
        make_root(&journal_root)?;
        // The probe below creates a file, so what is standing here has to be
        // a directory this process owns before it runs.
        kind_of(PathClass::JournalRoot, read_facts(&journal_root)?, log)?;
        let mut posture = Posture {
            uid: effective_uid(&journal_root)?,
            outcomes: Vec::new(),
        };
        let mut roots = vec![PathClass::BlobsRoot.path(&cfg.blobs_dir)];
        roots.extend(
            cfg.mirrors
                .iter()
                .map(|mirror| PathClass::BlobsRoot.path(&mirror.path)),
        );
        for root in roots {
            make_root(&root)?;
            posture.record(PathClass::BlobsRoot, &root, log)?;
        }
        posture.record(PathClass::JournalRoot, &journal_root, log)?;
        for class in [PathClass::ServerKey, PathClass::SetupToken] {
            let path = class.path(&cfg.journal_dir);
            posture.record(class, &path, log)?;
        }
        Ok(posture)
    }

    /// What the pass decided, one line per class, for `obsyncd check`.
    pub fn outcomes(&self) -> &[Outcome] {
        &self.outcomes
    }

    /// Decide one path and return the mode the volume now holds.
    ///
    /// The caller that just created a credential file uses this to verify
    /// what it created, so the mode a startup line claims is the mode that
    /// was read back and never a constant.
    ///
    /// # Errors
    /// A refusal when the path is unsafe, or when it is not there at all:
    /// a credential file that vanished between being written and being
    /// measured is not a state this server carries on from.
    pub fn verify_present(
        &self,
        class: PathClass,
        path: &Path,
        log: &Log,
    ) -> Result<u32, StoreError> {
        match self.verify(class, path, log)?.mode() {
            Some(mode) => Ok(mode),
            None => Err(refuse(class, "absent_after_write", log)),
        }
    }

    /// Decide one path: refuse what cannot be corrected, correct what can.
    ///
    /// # Errors
    /// A refusal when the path is a link, the wrong type, owned by another
    /// user, or holds a mode that will not change.
    pub fn verify(&self, class: PathClass, path: &Path, log: &Log) -> Result<Decision, StoreError> {
        self.verify_facts(class, path, log, &read_facts)
    }

    fn record(&mut self, class: PathClass, path: &Path, log: &Log) -> Result<(), StoreError> {
        let decision = self.verify(class, path, log)?;
        self.outcomes.push(Outcome { class, decision });
        Ok(())
    }

    /// The pass itself, over a reader a test can replace.
    fn verify_facts(
        &self,
        class: PathClass,
        path: &Path,
        log: &Log,
        read: &dyn Fn(&Path) -> io::Result<Facts>,
    ) -> Result<Decision, StoreError> {
        let facts = match read(path) {
            Ok(facts) => facts,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Decision::Absent),
            Err(e) => return Err(e.into()),
        };
        self.shape(class, facts, log)?;
        let want = class.required_mode();
        if facts.mode == want {
            return Ok(Decision::Ok { mode: facts.mode });
        }
        fs::set_permissions(path, Permissions::from_mode(want))
            .map_err(|_| refuse(class, "repair_refused", log))?;
        // Re-read. A read-only volume, a filesystem that ignores permission
        // bits, and a location swapped under the pass all end here rather
        // than in a line claiming a mode nobody looked at.
        let after = read(path).map_err(|_| refuse(class, "reread_refused", log))?;
        self.shape(class, after, log)?;
        if after.mode != want {
            return Err(refuse(class, "mode_not_applied", log));
        }
        log.info(
            "posture",
            &[
                ("path_class", Val::word(class.label())),
                ("decision", Val::word("repaired")),
                ("from", Val::mode(facts.mode)),
                ("to", Val::mode(after.mode)),
            ],
        );
        Ok(Decision::Repaired {
            from: facts.mode,
            to: after.mode,
        })
    }

    /// Type and owner: neither is repairable, so both are refusals.
    fn shape(&self, class: PathClass, facts: Facts, log: &Log) -> Result<(), StoreError> {
        kind_of(class, facts, log)?;
        if facts.uid != self.uid {
            // This process cannot `chown`, and correcting the mode of a file
            // another user owns would leave them free to widen it again.
            return Err(refuse(class, "foreign_owner", log));
        }
        Ok(())
    }

    /// The user id the pass measures owners against, for tests.
    #[cfg(test)]
    pub(crate) const fn uid(&self) -> u32 {
        self.uid
    }

    /// A pass that expects another user, so the owner refusal can be proven
    /// without a second account. Faking a foreign owner needs root; naming
    /// the expected owner does not, and the comparison is the same one.
    #[cfg(test)]
    pub(crate) const fn expecting(uid: u32) -> Posture {
        Posture {
            uid,
            outcomes: Vec::new(),
        }
    }
}

/// Refuse a class this type is not: a link is never followed and a
/// substituted type is never used.
fn kind_of(class: PathClass, facts: Facts, log: &Log) -> Result<(), StoreError> {
    match (facts.kind, class.is_dir()) {
        (Kind::Link, _) => Err(refuse(class, "symlink", log)),
        (Kind::Dir, true) | (Kind::File, false) => Ok(()),
        (_, true) => Err(refuse(class, "not_a_directory", log)),
        (_, false) => Err(refuse(class, "not_a_regular_file", log)),
    }
}

/// One refusal line and the error that stops the start (requirement 12).
fn refuse(class: PathClass, reason: &'static str, log: &Log) -> StoreError {
    log.error(
        "posture",
        &[
            ("path_class", Val::word(class.label())),
            ("decision", Val::word("refused")),
            ("reason", Val::word(reason)),
        ],
    );
    StoreError::Posture {
        class: class.label(),
        reason,
    }
}

/// Create a volume root at 0700 when it is not there.
///
/// Absence is decided with `symlink_metadata`, so a link or a regular file
/// standing where a root belongs is left for the pass to refuse rather than
/// quietly built around.
fn make_root(root: &Path) -> Result<(), StoreError> {
    if fs::symlink_metadata(root).is_ok() {
        return Ok(());
    }
    DirBuilder::new()
        .recursive(true)
        .mode(DIR_MODE)
        .create(root)?;
    Ok(())
}

/// The user this process runs as, learned from the filesystem: it creates a
/// file on the journal volume and asks who owns it.
///
/// `geteuid` is a foreign call, and requirement 5 allows exactly one file to
/// make those. The probe pays for itself twice over: it also proves the
/// journal volume is writable, which is the first thing any start needs.
fn effective_uid(journal_root: &Path) -> Result<u32, StoreError> {
    let probe = journal_root.join(PROBE);
    // A pass that died mid-probe leaves one behind; removing a link removes
    // the link and not what it points at.
    let _ = fs::remove_file(&probe);
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(FILE_MODE)
        .open(&probe)?;
    // From the open handle, so the answer is about the file that was created
    // and not about whatever now holds the name.
    let uid = file.metadata()?.uid();
    drop(file);
    fs::remove_file(&probe)?;
    Ok(uid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log::LogLevel;
    use crate::storage::testutil::TempDir;
    use std::cell::Cell;

    /// A volume as a restore or a bind mount hands a file over.
    const WEAK_FILE: u32 = 0o644;

    /// A reader that answers with what the test says is there, so the branch
    /// that catches a correction the filesystem ignored can be proven. A
    /// filesystem that accepts `chmod` and drops it is not something a
    /// hermetic test can mount.
    fn scripted(answers: Vec<io::Result<Facts>>) -> impl Fn(&Path) -> io::Result<Facts> {
        let at = Cell::new(0);
        move |_| {
            let index = at.get();
            at.set(index + 1);
            match answers.get(index) {
                Some(Ok(facts)) => Ok(*facts),
                Some(Err(e)) => Err(io::Error::new(e.kind(), "")),
                None => panic!("the pass read more times than the test scripted"),
            }
        }
    }

    fn facts(kind: Kind, uid: u32, mode: u32) -> Facts {
        Facts { kind, uid, mode }
    }

    /// A real file at a weak mode, so the correction itself succeeds and only
    /// the answer about what it achieved is under test.
    fn weak_file(dir: &TempDir) -> PathBuf {
        let path = dir.path().join("credential");
        fs::write(&path, "sentinel").expect("the fixture is written");
        fs::set_permissions(&path, Permissions::from_mode(WEAK_FILE)).expect("the mode is set");
        path
    }

    #[test]
    fn a_correction_the_volume_ignores_refuses_rather_than_reporting_success() {
        let dir = TempDir::new("posture-ignored");
        let path = weak_file(&dir);
        let log = Log::buffered(LogLevel::Debug);
        let posture = Posture::expecting(0);
        let reader = scripted(vec![
            Ok(facts(Kind::File, 0, WEAK_FILE)),
            // The re-read: the volume kept the mode it arrived with.
            Ok(facts(Kind::File, 0, WEAK_FILE)),
        ]);
        let err = posture
            .verify_facts(PathClass::ServerKey, &path, &log, &reader)
            .expect_err("a mode that did not change is not a mode to serve on");
        assert!(
            matches!(
                err,
                StoreError::Posture {
                    class: "server_key",
                    reason: "mode_not_applied"
                }
            ),
            "{err}"
        );
        assert!(
            log.captured().contains(
                "event=posture path_class=server_key decision=refused \
                           reason=mode_not_applied"
            ),
            "{}",
            log.captured()
        );
        // The correction itself ran: the refusal came from reading back, not
        // from a `chmod` that failed.
        assert_eq!(read_facts(&path).expect("the fixture is there").mode, 0o600);
    }

    #[test]
    fn a_location_swapped_during_the_correction_refuses() {
        let dir = TempDir::new("posture-swapped");
        let path = weak_file(&dir);
        let log = Log::buffered(LogLevel::Debug);
        let reader = scripted(vec![
            Ok(facts(Kind::File, 0, WEAK_FILE)),
            // Between the correction and the re-read, a link took the name.
            Ok(facts(Kind::Link, 0, 0o600)),
        ]);
        let err = Posture::expecting(0)
            .verify_facts(PathClass::SetupToken, &path, &log, &reader)
            .expect_err("what is measured must still be what was corrected");
        assert!(
            matches!(
                err,
                StoreError::Posture {
                    class: "setup_token",
                    reason: "symlink"
                }
            ),
            "{err}"
        );
    }

    #[test]
    fn a_volume_that_stops_answering_after_the_correction_refuses() {
        let dir = TempDir::new("posture-silent");
        let path = weak_file(&dir);
        let log = Log::buffered(LogLevel::Debug);
        let reader = scripted(vec![
            Ok(facts(Kind::File, 0, WEAK_FILE)),
            Err(io::Error::from(io::ErrorKind::PermissionDenied)),
        ]);
        let err = Posture::expecting(0)
            .verify_facts(PathClass::ServerKey, &path, &log, &reader)
            .expect_err("an unreadable file is not a verified file");
        assert!(
            matches!(
                err,
                StoreError::Posture {
                    reason: "reread_refused",
                    ..
                }
            ),
            "{err}"
        );
    }

    #[test]
    fn a_type_this_server_never_stores_refuses() {
        let log = Log::buffered(LogLevel::Debug);
        for (class, kind, reason) in [
            (PathClass::ServerKey, Kind::Other, "not_a_regular_file"),
            (PathClass::BlobsRoot, Kind::Other, "not_a_directory"),
            (PathClass::JournalRoot, Kind::File, "not_a_directory"),
            (PathClass::SetupToken, Kind::Dir, "not_a_regular_file"),
        ] {
            let err = kind_of(class, facts(kind, 0, 0o600), &log)
                .expect_err("a substituted type is never used");
            assert!(
                matches!(err, StoreError::Posture { reason: r, .. } if r == reason),
                "{class:?} {kind:?}: {err}"
            );
        }
        assert!(kind_of(PathClass::ServerKey, facts(Kind::File, 0, 0o600), &log).is_ok());
        assert!(kind_of(PathClass::BlobsRoot, facts(Kind::Dir, 0, 0o700), &log).is_ok());
    }
}
