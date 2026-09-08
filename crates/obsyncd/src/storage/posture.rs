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
//! Every decision is made on an open handle, never on a name. Whoever can
//! write the directory above a name can point it at something else between
//! one look and the next; a handle stays what it was. The name is looked at
//! once without following a link, opened, and the handle must be the inode
//! that look saw; from there every fact is read off the handle. The two
//! credential files are read through the handle they were measured on
//! ([`Posture::open_credential`]), and a file this server has just written
//! is measured on the handle it was written through ([`Posture::adopt`]), so
//! no name is consulted again after a measurement.
//!
//! The directories above a root are measured too. `Journal` and `Blobs`
//! work by name below their roots, and a name is only as good as the
//! directories that hold it: whoever can rename `v1` away can put another
//! tree under the name after the pass. So every directory from the
//! filesystem root down to each configured volume directory must be owned
//! by root or by this server and must let nobody else rename what it
//! holds, and the configured path must be its own resolved form, so that
//! no link anywhere in it can be re-pointed later ([`Posture::enforce`],
//! the `*_mount` classes). A store cannot be opened without a completed
//! pass in hand.
//!
//! Fail-closed (AGENTS.md requirement 4). What cannot be corrected refuses
//! the start: a link is never followed, a wrong file type is never used,
//! and a foreign owner is never accepted, because this process cannot
//! `chown` and whoever does own the file can widen it again the moment the
//! pass looks away. What can be corrected is corrected and then RE-READ off
//! the volume: a mode that was set is not a mode that stuck. Every decision
//! is one structured line (requirement 12), and no line carries a filesystem
//! location or any file content.
//!
//! Standard library only (requirement 5): `symlink_metadata`, `OpenOptions`
//! with the platform's `O_NONBLOCK`, `File::metadata`, `File::set_permissions`,
//! `MetadataExt`, `PermissionsExt`.
#![forbid(unsafe_code)]

use std::cell::RefCell;
use std::fs::{self, DirBuilder, File, OpenOptions, Permissions};
use std::io::{self, Read, Seek, SeekFrom};
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

/// `O_NONBLOCK` from `<fcntl.h>`: a fifo standing under a name answers the
/// open at once instead of waiting for a writer. This is the one flag the
/// pass needs, and the one whose value every Linux architecture Rust targets
/// shares (`asm-generic/fcntl.h`; arm64 and x86-64 alike). Nothing here
/// relies on `O_NOFOLLOW`, whose value differs between architectures: a link
/// is refused by the look at the name, and a name re-pointed between that
/// look and the open is refused because the handle is not the inode the
/// look saw.
#[cfg(target_os = "linux")]
const NONBLOCK: i32 = 0o4_000;
#[cfg(target_os = "macos")]
const NONBLOCK: i32 = 0x0004;
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
compile_error!("storage::posture needs this platform's O_NONBLOCK value in NONBLOCK");

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
    /// The directory `OBSYNC_JOURNAL_DIR` names, and every directory above
    /// it: who may rename the journal root away.
    JournalMount,
    /// The same for `OBSYNC_BLOBS_DIR` and for each mirror.
    BlobsMount,
}

impl PathClass {
    /// The word this class logs and reports as.
    pub const fn label(self) -> &'static str {
        match self {
            PathClass::ServerKey => "server_key",
            PathClass::SetupToken => "setup_token",
            PathClass::BlobsRoot => "blobs_root",
            PathClass::JournalRoot => "journal_root",
            PathClass::JournalMount => "journal_mount",
            PathClass::BlobsMount => "blobs_mount",
        }
    }

    /// Whether this class must be a directory.
    const fn is_dir(self) -> bool {
        !matches!(self, PathClass::ServerKey | PathClass::SetupToken)
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
            PathClass::JournalMount | PathClass::BlobsMount => volume_dir.to_path_buf(),
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

/// The facts a decision is made on, and the inode they are about.
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
    /// Device and inode: which file these facts are about.
    id: (u64, u64),
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

fn facts_of(meta: &fs::Metadata) -> Facts {
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
    Facts {
        kind,
        uid: meta.uid(),
        mode: meta.mode() & MODE_MASK,
        id: (meta.dev(), meta.ino()),
    }
}

/// Read the facts off an open handle. Nothing reached through a handle is a
/// link: a link under the name was refused by the look that preceded the
/// open, and a handle that is not the inode that look saw is refused too.
fn handle_facts(file: &File) -> io::Result<Facts> {
    Ok(facts_of(&file.metadata()?))
}

/// The one look at a name, without following a link. It decides what may be
/// opened at all; every fact after it is read off the handle, and the handle
/// must be the inode this look saw.
fn read_facts(path: &Path) -> io::Result<Facts> {
    Ok(facts_of(&fs::symlink_metadata(path)?))
}

/// Open a name for measuring: read-only, never waiting on a fifo.
fn open_handle(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(NONBLOCK)
        .open(path)
}

/// A handle the pass has finished with: measured, corrected if it had to be,
/// and re-read at the mode its class requires.
#[derive(Debug)]
struct Settled {
    file: File,
    mode: u32,
    /// The mode the volume arrived with, when a correction was made.
    from: Option<u32>,
}

impl Settled {
    const fn decision(&self) -> Decision {
        match self.from {
            None => Decision::Ok { mode: self.mode },
            Some(from) => Decision::Repaired {
                from,
                to: self.mode,
            },
        }
    }
}

/// A credential file, held open on the handle its posture was decided on.
///
/// Reading through it consults no name again: a root renamed aside after the
/// pass, and another file put under the same name, are simply not what this
/// handle is.
#[derive(Debug)]
pub struct Credential {
    file: File,
    mode: u32,
}

impl Credential {
    /// The mode read back off the volume, for the startup line.
    pub const fn mode(&self) -> u32 {
        self.mode
    }

    /// The whole file, from its start, through the measured handle.
    pub fn read_to_string(&mut self) -> io::Result<String> {
        self.file.seek(SeekFrom::Start(0))?;
        let mut text = String::new();
        self.file.read_to_string(&mut text)?;
        Ok(text)
    }
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
    /// Which inode each credential class was opened on, so two classes
    /// resolving to one file are refused.
    opened: RefCell<Vec<(PathClass, (u64, u64))>>,
}

impl Posture {
    /// Decide the posture of every configured volume directory, both volume
    /// roots, every mirror root, and both credential files, creating what is
    /// not there at 0700.
    ///
    /// Nothing is written through a configured path before that path has
    /// been validated (absolute, normal, free of links) and the directories
    /// that exist on it have been judged. On Linux, the shipped platform,
    /// that holds without exception: the user this process runs as is read
    /// off `/proc/self`, and validation and judging are reads. Elsewhere
    /// (development only) the user is learned from a uniquely named probe
    /// file in the deepest directory that already exists on the validated
    /// journal path, removed at once, and that is the one write before the
    /// judging.
    ///
    /// # Errors
    /// The first class that cannot be made safe, after its refusal line.
    pub fn enforce(cfg: &StorageConfig, log: &Log) -> Result<Posture, StoreError> {
        let mut volumes: Vec<(PathClass, &Path)> = vec![
            (PathClass::JournalMount, cfg.journal_dir.as_path()),
            (PathClass::BlobsMount, cfg.blobs_dir.as_path()),
        ];
        volumes.extend(
            cfg.mirrors
                .iter()
                .map(|mirror| (PathClass::BlobsMount, mirror.path.as_path())),
        );
        // 1. Every path, before a byte is written through any of them.
        let mut existing = Vec::with_capacity(volumes.len());
        for (class, dir) in &volumes {
            existing.push(validate_path(*class, dir, log)?);
        }
        // 2. Who this process is.
        let uid = process_user(PathClass::JournalMount, &existing[0], log)?;
        let mut posture = Posture {
            uid,
            outcomes: Vec::new(),
            opened: RefCell::new(Vec::new()),
        };
        // 3. What exists is judged before anything is created under it.
        for ((class, dir), deepest) in volumes.iter().zip(&existing) {
            posture.judge_existing(*class, dir, deepest, log)?;
        }
        // 4. Only now is the layout completed, and each whole chain reported.
        for (class, dir) in &volumes {
            make_root(dir)?;
            posture.mount(*class, dir, log)?;
        }
        let journal_root = PathClass::JournalRoot.path(&cfg.journal_dir);
        make_root(&journal_root)?;
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

    /// Open a credential file on a measured handle, or `None` when it is not
    /// there and first boot has to create it.
    ///
    /// # Errors
    /// A refusal when the name is a link, the wrong type, owned by another
    /// user, holds a mode that will not change, or resolves to the inode
    /// another credential class already opened.
    pub fn open_credential(
        &self,
        class: PathClass,
        path: &Path,
        log: &Log,
    ) -> Result<Option<Credential>, StoreError> {
        let Some(settled) = self.verify_facts(class, path, log, &handle_facts)? else {
            return Ok(None);
        };
        self.claim(class, &settled.file, log)?;
        Ok(Some(Credential {
            file: settled.file,
            mode: settled.mode,
        }))
    }

    /// Create a credential file that is not there: exclusively, at the mode
    /// its class requires, open for the write and for the read-back after it.
    ///
    /// # Errors
    /// The open, including `AlreadyExists` when something took the name.
    pub fn create(class: PathClass, path: &Path) -> io::Result<File> {
        OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(class.required_mode())
            .open(path)
    }

    /// Measure a credential file this server has just written, on the handle
    /// it was written through: the mode a startup line then states is the
    /// mode the volume gave the file, read back, never the constant it was
    /// asked for.
    ///
    /// # Errors
    /// As [`Posture::open_credential`].
    pub fn adopt(&self, class: PathClass, file: File, log: &Log) -> Result<Credential, StoreError> {
        let settled = self.settle(class, file, None, None, log, &handle_facts)?;
        self.claim(class, &settled.file, log)?;
        Ok(Credential {
            file: settled.file,
            mode: settled.mode,
        })
    }

    /// Decide one path: refuse what cannot be corrected, correct what can.
    ///
    /// # Errors
    /// A refusal when the path is a link, the wrong type, owned by another
    /// user, or holds a mode that will not change.
    pub fn verify(&self, class: PathClass, path: &Path, log: &Log) -> Result<Decision, StoreError> {
        Ok(self
            .verify_facts(class, path, log, &handle_facts)?
            .map_or(Decision::Absent, |settled| settled.decision()))
    }

    fn record(&mut self, class: PathClass, path: &Path, log: &Log) -> Result<(), StoreError> {
        let decision = self.verify(class, path, log)?;
        self.outcomes.push(Outcome { class, decision });
        Ok(())
    }

    /// Report who may rename the root a configured volume directory holds:
    /// every directory from that one up to the filesystem root, on a path
    /// that is its own resolved form, once the layout is complete.
    ///
    /// # Errors
    /// A refusal naming the reason and how many directories up it was found.
    fn mount(&mut self, class: PathClass, dir: &Path, log: &Log) -> Result<(), StoreError> {
        // The configured path must be its own resolved form: absolute, no
        // `.` or `..`, and no link anywhere in it. `validate_path` refused
        // any link before a byte was written; this is the same fact read
        // back off the completed layout, so what is judged, and what the
        // store then works under by name, is the resolved directory and
        // nothing that could resolve differently later.
        let real = fs::canonicalize(dir).map_err(|_| refuse_at(class, "unresolvable", 0, log))?;
        if real != dir {
            return Err(refuse_at(class, "not_canonical", 0, log));
        }
        let holders =
            walk(&real).map_err(|(reason, depth)| refuse_at(class, reason, depth, log))?;
        let mode = judge(&holders, self.uid)
            .map_err(|(reason, depth)| refuse_at(class, reason, depth, log))?;
        self.outcomes.push(Outcome {
            class,
            decision: Decision::Ok { mode },
        });
        Ok(())
    }

    /// Judge the directories that already exist on a validated volume path,
    /// before anything is created beneath them, and require that the
    /// deepest of them can be written by this server when there is
    /// something left to create.
    ///
    /// A chain that would be refused once complete is refused now, so a
    /// refused start leaves nothing behind. And a volume presented by a
    /// storage class as a root-owned directory holding no root of the
    /// server's is refused as `unwritable` with the reason stated, rather
    /// than failing on the first `mkdir`: the server takes ownership of
    /// nothing, and the operator prepares the directory for it
    /// (`docs/storage.md`, "Volume posture").
    fn judge_existing(
        &self,
        class: PathClass,
        dir: &Path,
        deepest: &Path,
        log: &Log,
    ) -> Result<(), StoreError> {
        let holders =
            walk(deepest).map_err(|(reason, depth)| refuse_at(class, reason, depth, log))?;
        // Depths are counted from the configured directory, so a refusal
        // says the same thing whether or not the tail existed yet.
        let offset = u32::try_from(
            dir.ancestors()
                .count()
                .saturating_sub(deepest.ancestors().count()),
        )
        .unwrap_or(u32::MAX);
        let holders: Vec<Holder> = holders
            .into_iter()
            .map(|h| Holder {
                depth: h.depth.saturating_add(offset),
                ..h
            })
            .collect();
        judge(&holders, self.uid)
            .map_err(|(reason, depth)| refuse_at(class, reason, depth, log))?;
        let root = dir.join(ROOT_DIR);
        let complete = deepest == dir && fs::symlink_metadata(&root).is_ok();
        if !complete {
            let first = holders
                .first()
                .ok_or_else(|| refuse_at(class, "unresolvable", 0, log))?;
            if first.uid != self.uid || first.mode & 0o200 == 0 {
                return Err(refuse_at(class, "unwritable", first.depth, log));
            }
        }
        Ok(())
    }

    /// Look at the name once, reach a handle for it, then decide on the
    /// handle.
    ///
    /// The look, which does not follow a link, refuses a link, a type the
    /// server never stores, and a foreign owner before anything is opened.
    /// The one case it leaves standing that cannot be opened — a file of this
    /// user's at a mode that shuts its own user out — is corrected by name so
    /// that a handle can be reached at all. Nothing decided below rests on
    /// the look except which inode it saw: the handle must be that inode, and
    /// it is measured again.
    fn verify_facts(
        &self,
        class: PathClass,
        path: &Path,
        log: &Log,
        read: &dyn Fn(&File) -> io::Result<Facts>,
    ) -> Result<Option<Settled>, StoreError> {
        let named = match read_facts(path) {
            Ok(facts) => facts,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        self.shape(class, named, log)?;
        let (file, arrived) = match open_handle(path) {
            Ok(file) => (file, None),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(_) => {
                fs::set_permissions(path, Permissions::from_mode(class.required_mode()))
                    .map_err(|_| refuse(class, "repair_refused", log))?;
                let file = open_handle(path).map_err(|_| refuse(class, "reopen_refused", log))?;
                (file, Some(named.mode))
            }
        };
        self.settle(class, file, Some(named.id), arrived, log, read)
            .map(Some)
    }

    /// The pass itself, on a handle, over a reader a test can replace.
    /// `named` is the inode the look at the name saw, when there was a look.
    fn settle(
        &self,
        class: PathClass,
        file: File,
        named: Option<(u64, u64)>,
        arrived: Option<u32>,
        log: &Log,
        read: &dyn Fn(&File) -> io::Result<Facts>,
    ) -> Result<Settled, StoreError> {
        let facts = read(&file)?;
        if named.is_some_and(|id| id != facts.id) {
            // The name was re-pointed between the look and the open: a link
            // planted there, or another file under the name. What was opened
            // is not what was looked at, so it is not decided on.
            return Err(refuse(class, "swapped", log));
        }
        self.shape(class, facts, log)?;
        let want = class.required_mode();
        let (from, after) = if facts.mode == want {
            match arrived {
                None => {
                    return Ok(Settled {
                        file,
                        mode: facts.mode,
                        from: None,
                    });
                }
                Some(from) => (from, facts),
            }
        } else {
            file.set_permissions(Permissions::from_mode(want))
                .map_err(|_| refuse(class, "repair_refused", log))?;
            // Re-read. A read-only volume and a filesystem that ignores
            // permission bits both end here rather than in a line claiming
            // a mode nobody looked at.
            let after = read(&file).map_err(|_| refuse(class, "reread_refused", log))?;
            self.shape(class, after, log)?;
            if after.mode != want {
                return Err(refuse(class, "mode_not_applied", log));
            }
            (arrived.unwrap_or(facts.mode), after)
        };
        log.info(
            "posture",
            &[
                ("path_class", Val::word(class.label())),
                ("decision", Val::word("repaired")),
                ("from", Val::mode(from)),
                ("to", Val::mode(after.mode)),
            ],
        );
        Ok(Settled {
            file,
            mode: after.mode,
            from: Some(from),
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

    /// Remember which inode a credential class resolved to, and refuse
    /// another class resolving to the same one: a hard link can put one file
    /// under two of this server's names, and the recovery login is not the
    /// wrapping material.
    fn claim(&self, class: PathClass, file: &File, log: &Log) -> Result<(), StoreError> {
        let id = handle_facts(file)?.id;
        let mut opened = self.opened.borrow_mut();
        if opened
            .iter()
            .any(|(other, seen)| *other != class && *seen == id)
        {
            return Err(refuse(class, "shared_inode", log));
        }
        opened.push((class, id));
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
            opened: RefCell::new(Vec::new()),
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

/// One refusal line for a mount class, with how many directories up from
/// the configured one the reason was found (0 is that directory itself).
/// A count is not a location.
fn refuse_at(class: PathClass, reason: &'static str, depth: u32, log: &Log) -> StoreError {
    log.error(
        "posture",
        &[
            ("path_class", Val::word(class.label())),
            ("decision", Val::word("refused")),
            ("reason", Val::word(reason)),
            ("depth", Val::count(u64::from(depth))),
        ],
    );
    StoreError::Posture {
        class: class.label(),
        reason,
    }
}

/// One directory on the way from a configured volume directory up to the
/// filesystem root, as the rename decision sees it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Holder {
    /// How many names up from the configured directory this is.
    depth: u32,
    kind: Kind,
    uid: u32,
    /// Permission and sticky bits.
    mode: u32,
}

fn holder_of(depth: u32, meta: &fs::Metadata) -> Holder {
    let facts = facts_of(meta);
    Holder {
        depth,
        kind: facts.kind,
        uid: facts.uid,
        mode: meta.mode() & 0o7777,
    }
}

/// Read every directory from a resolved volume directory up to the
/// filesystem root. A `walk` reads; [`judge`] decides.
fn walk(dir: &Path) -> Result<Vec<Holder>, (&'static str, u32)> {
    let mut holders = Vec::new();
    for (depth, name) in dir.ancestors().enumerate() {
        let depth = u32::try_from(depth).unwrap_or(u32::MAX);
        let meta = fs::symlink_metadata(name).map_err(|_| ("unreadable", depth))?;
        holders.push(holder_of(depth, &meta));
    }
    Ok(holders)
}

/// Decide whether anyone but root and this server can rename what these
/// holders hold, and return the permission bits of the first holder: the
/// configured directory once the layout is complete, or the deepest
/// directory that exists before it is.
///
/// A directory hands rename authority over its entries to whoever may
/// write it: its owner (who can also widen it), so the owner must be root
/// or this server; everyone, when others may write it; and every member of
/// its group, when the group may write it. A group number says nothing
/// about who is in the group — `fsGroup` exists to share one — so group
/// write is refused as world write is. The sticky bit narrows rename to
/// the entry's owner, the directory's owner, and root, and both of those
/// are already root or this server, so a sticky directory holds its
/// entries safely whatever its write bits say.
fn judge(holders: &[Holder], uid: u32) -> Result<u32, (&'static str, u32)> {
    for h in holders {
        if h.kind != Kind::Dir {
            return Err(("not_a_directory", h.depth));
        }
        if h.uid != 0 && h.uid != uid {
            return Err(("foreign_owner", h.depth));
        }
        let sticky = h.mode & 0o1000 != 0;
        if !sticky {
            if h.mode & 0o002 != 0 {
                return Err(("writable_by_others", h.depth));
            }
            if h.mode & 0o020 != 0 {
                return Err(("writable_by_group", h.depth));
            }
        }
    }
    holders
        .first()
        .map(|h| h.mode & MODE_MASK)
        .ok_or(("unresolvable", 0))
}

/// Validate a configured volume path before anything is written through
/// it: absolute, made only of plain names, and free of links down to the
/// last name that exists. Returns the deepest directory that exists on it,
/// which is where the tail (if any) will be created and where the probe
/// may write.
///
/// A link is re-pointed by its owner, and a link inside another link's
/// target is one no walk of the written path would see, so no link is
/// followed at all: a path with one is refused as `not_canonical` before
/// the pass has touched anything behind it.
fn validate_path(class: PathClass, dir: &Path, log: &Log) -> Result<PathBuf, StoreError> {
    use std::path::Component;
    let normal = dir.is_absolute()
        && dir
            .components()
            .all(|c| matches!(c, Component::RootDir | Component::Normal(_)));
    if !normal {
        return Err(refuse_at(class, "not_canonical", 0, log));
    }
    let names: Vec<&Path> = dir.ancestors().collect();
    let total = names.len();
    let mut deepest = PathBuf::from("/");
    // From the filesystem root down, so a link is met before anything
    // below it is looked at.
    for (index, name) in names.iter().rev().enumerate() {
        let depth = u32::try_from(total - 1 - index).unwrap_or(u32::MAX);
        match fs::symlink_metadata(name) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(refuse_at(class, "not_canonical", depth, log));
            }
            Ok(meta) if !meta.file_type().is_dir() => {
                return Err(refuse_at(class, "not_a_directory", depth, log));
            }
            Ok(_) => deepest = name.to_path_buf(),
            Err(e) if e.kind() == io::ErrorKind::NotFound => break,
            Err(_) => return Err(refuse_at(class, "unreadable", depth, log)),
        }
    }
    Ok(deepest)
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

/// The user this process runs as, without writing anything: `/proc/self`
/// resolves to this process's own directory, which the kernel owns by the
/// process's effective user.
///
/// `geteuid` is a foreign call, and requirement 5 allows exactly one file to
/// make those. Reading `/proc/self` costs no write, so on the shipped
/// platform nothing is created or removed through a configured path before
/// the directories on it have been judged.
#[cfg(target_os = "linux")]
fn process_user(class: PathClass, _dir: &Path, log: &Log) -> Result<u32, StoreError> {
    let meta = fs::metadata("/proc/self").map_err(|_| refuse_at(class, "user_unknown", 0, log))?;
    Ok(meta.uid())
}

/// The user this process runs as, learned from the filesystem on a system
/// without `/proc`: it creates a file in `dir` and asks who owns it.
///
/// Development only; the shipped platform is Linux and reads `/proc/self`.
/// The probe is uniquely named, so nothing that already stands under a
/// probe's name is ever touched, and it is the one write before the chain
/// is judged. A probe a crash leaves behind is an empty file of this user's
/// under `.posture-probe-`, harmless, and never swept: a sweep is a
/// removal by name, and removals by name are what this pass refuses to
/// make before its judgment.
#[cfg(not(target_os = "linux"))]
fn process_user(class: PathClass, dir: &Path, log: &Log) -> Result<u32, StoreError> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let probe = dir.join(format!("{PROBE}-{}-{nanos}", std::process::id()));
    let file = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(FILE_MODE)
        .open(&probe)
    {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::PermissionDenied => {
            return Err(refuse_at(class, "unwritable", 0, log));
        }
        Err(e) => return Err(e.into()),
    };
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
    use std::os::unix::fs::symlink;
    use std::process::Command;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    /// A volume as a restore or a bind mount hands a file over.
    const WEAK_FILE: u32 = 0o644;
    /// The token a start left on the volume.
    const STANDING: &str = "abababababababababababababababababababababababababababababababab";
    /// The token whoever swapped the root would like read instead.
    const PLANTED: &str = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";

    /// A reader that answers with what the test says is there, so the branch
    /// that catches a correction the filesystem ignored can be proven. A
    /// filesystem that accepts `chmod` and drops it is not something a
    /// hermetic test can mount.
    fn scripted(answers: Vec<io::Result<Facts>>) -> impl Fn(&File) -> io::Result<Facts> {
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
        Facts {
            kind,
            uid,
            mode,
            id: (0, 0),
        }
    }

    /// Facts about a real file, as a scripted reader would answer about it:
    /// the inode is the file's own, so the identity check passes and only
    /// what the script says about kind, owner, and mode is under test.
    fn facts_about(path: &Path, kind: Kind, mode: u32) -> Facts {
        let real = read_facts(path).expect("the fixture is there");
        Facts {
            kind,
            uid: real.uid,
            mode,
            id: real.id,
        }
    }

    /// A pass that expects the user this test runs as.
    fn as_owner(path: &Path) -> Posture {
        Posture::expecting(read_facts(path).expect("the fixture is there").uid)
    }

    /// A real file at a weak mode, so the correction itself succeeds and only
    /// the answer about what it achieved is under test.
    fn weak_file(dir: &TempDir) -> PathBuf {
        let path = dir.path().join("credential");
        fs::write(&path, "sentinel").expect("the fixture is written");
        fs::set_permissions(&path, Permissions::from_mode(WEAK_FILE)).expect("the mode is set");
        path
    }

    /// A journal volume as a start leaves it: the root at 0700 and the
    /// standing token at 0600. Returns the mount point and a pass that
    /// expects the user this test runs as, learned the way the pass learns
    /// it: from a file it owns.
    fn journal(dir: &TempDir) -> (PathBuf, Posture) {
        let mount = dir.path().join("journal");
        let root = PathClass::JournalRoot.path(&mount);
        DirBuilder::new()
            .recursive(true)
            .mode(DIR_MODE)
            .create(&root)
            .expect("the root");
        let token = PathClass::SetupToken.path(&mount);
        fs::write(&token, STANDING).expect("the token");
        fs::set_permissions(&token, Permissions::from_mode(FILE_MODE)).expect("0600");
        let uid = fs::symlink_metadata(&token).expect("the token").uid();
        (mount, Posture::expecting(uid))
    }

    /// The reviewer's schedule: whoever can write the mount point renames
    /// the measured root aside and puts a root of their own under the same
    /// name, so that a read by name after the measurement reads theirs.
    fn swap_root(mount: &Path, planted: &str) {
        let root = PathClass::JournalRoot.path(mount);
        fs::rename(&root, mount.join("v1.aside")).expect("the root is renamed aside");
        fs::create_dir(&root).expect("another root takes the name");
        fs::write(PathClass::SetupToken.path(mount), planted).expect("another token");
    }

    #[test]
    fn a_credential_is_read_through_the_handle_it_was_measured_on_and_not_by_name() {
        let dir = TempDir::new("posture-handle");
        let (mount, posture) = journal(&dir);
        let log = Log::buffered(LogLevel::Debug);
        let token = PathClass::SetupToken.path(&mount);
        let mut standing = posture
            .open_credential(PathClass::SetupToken, &token, &log)
            .expect("measured")
            .expect("there");
        assert_eq!(standing.mode(), FILE_MODE);

        swap_root(&mount, PLANTED);
        // By name, the planted token is what stands there now.
        assert_eq!(fs::read_to_string(&token).expect("planted").trim(), PLANTED);

        assert_eq!(
            standing.read_to_string().expect("read").trim(),
            STANDING,
            "the handle is the file that was measured, whatever the name says now"
        );
    }

    #[test]
    fn a_fifo_under_a_credential_name_is_refused_without_waiting_for_a_writer() {
        let dir = TempDir::new("posture-fifo");
        let (mount, posture) = journal(&dir);
        let token = PathClass::SetupToken.path(&mount);
        fs::remove_file(&token).expect("the standing token goes");
        let made = Command::new("mkfifo")
            .arg(&token)
            .status()
            .expect("mkfifo runs");
        assert!(made.success(), "mkfifo made the fifo");

        // A fifo with no writer blocks an ordinary open forever. The open
        // the pass uses must answer, because a fifo planted after the look
        // at the name reaches it; a test that hangs is a test that failed.
        let (done, answered) = mpsc::channel();
        let path = token.clone();
        thread::spawn(move || {
            let opened = open_handle(&path).and_then(|file| handle_facts(&file));
            done.send(opened.map(|facts| facts.kind).map_err(|e| e.to_string()))
                .expect("the answer is sent");
        });
        let kind = answered
            .recv_timeout(Duration::from_secs(10))
            .expect("the open answered instead of waiting for a writer")
            .expect("a fifo opens for reading without a writer");
        assert_eq!(kind, Kind::Other, "and the handle says what it is");

        // A fifo already standing there is refused by the look at the name,
        // before any open.
        let log = Log::buffered(LogLevel::Debug);
        let err = posture
            .open_credential(PathClass::SetupToken, &token, &log)
            .expect_err("a fifo is not a credential file");
        assert!(
            matches!(
                err,
                StoreError::Posture {
                    class: "setup_token",
                    reason: "not_a_regular_file"
                }
            ),
            "{err}"
        );
    }

    #[test]
    fn a_handle_whose_owner_is_not_the_one_the_look_saw_refuses() {
        let dir = TempDir::new("posture-reowned");
        let path = weak_file(&dir);
        let log = Log::buffered(LogLevel::Debug);
        // The same inode the look saw, answering with another owner: what
        // a `chown` between the look and the open would leave. The handle
        // is decided on, not the look.
        let mut reowned = facts_about(&path, Kind::File, 0o600);
        reowned.uid ^= 1;
        let reader = scripted(vec![Ok(reowned)]);
        let err = as_owner(&path)
            .verify_facts(PathClass::SetupToken, &path, &log, &reader)
            .expect_err("a handle another user owns is refused whatever the look said");
        assert!(
            matches!(
                err,
                StoreError::Posture {
                    class: "setup_token",
                    reason: "foreign_owner"
                }
            ),
            "{err}"
        );
    }

    #[test]
    fn a_link_under_a_credential_name_is_never_followed() {
        let dir = TempDir::new("posture-link");
        let (mount, posture) = journal(&dir);
        let log = Log::buffered(LogLevel::Debug);
        let token = PathClass::SetupToken.path(&mount);
        // The link points at a file that would pass on its own: it is the
        // link that is refused, not what it points at.
        let target = mount.join("elsewhere");
        fs::write(&target, STANDING).expect("the target");
        fs::set_permissions(&target, Permissions::from_mode(FILE_MODE)).expect("0600");
        fs::remove_file(&token).expect("the standing token goes");
        symlink(&target, &token).expect("a link takes the name");

        let err = posture
            .open_credential(PathClass::SetupToken, &token, &log)
            .expect_err("a link is never followed");
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
    fn two_credential_classes_resolving_to_one_inode_refuse() {
        let dir = TempDir::new("posture-hardlink");
        let (mount, posture) = journal(&dir);
        let log = Log::buffered(LogLevel::Debug);
        let token = PathClass::SetupToken.path(&mount);
        let key = PathClass::ServerKey.path(&mount);
        // One file under both names: the recovery login would read as the
        // wrapping material.
        fs::hard_link(&token, &key).expect("a second name for the token");

        posture
            .open_credential(PathClass::ServerKey, &key, &log)
            .expect("the first class opens")
            .expect("there");
        // The same class again is the same file, and that is fine.
        posture
            .open_credential(PathClass::ServerKey, &key, &log)
            .expect("the same class opens again")
            .expect("there");
        let err = posture
            .open_credential(PathClass::SetupToken, &token, &log)
            .expect_err("another class on the same inode is refused");
        assert!(
            matches!(
                err,
                StoreError::Posture {
                    class: "setup_token",
                    reason: "shared_inode"
                }
            ),
            "{err}"
        );
        assert!(
            log.captured().contains(
                "event=posture path_class=setup_token decision=refused reason=shared_inode"
            ),
            "{}",
            log.captured()
        );
    }

    #[test]
    fn a_credential_its_own_user_cannot_open_is_corrected_by_name_and_then_measured_on_the_handle()
    {
        let dir = TempDir::new("posture-shut");
        let (mount, posture) = journal(&dir);
        let log = Log::buffered(LogLevel::Debug);
        let token = PathClass::SetupToken.path(&mount);
        fs::set_permissions(&token, Permissions::from_mode(0o000))
            .expect("a mode that shuts everyone out");

        let mut standing = posture
            .open_credential(PathClass::SetupToken, &token, &log)
            .expect("corrected")
            .expect("there");
        assert_eq!(standing.mode(), FILE_MODE);
        assert_eq!(
            standing.read_to_string().expect("readable now").trim(),
            STANDING
        );
        assert!(
            log.captured().contains(
                "event=posture path_class=setup_token decision=repaired from=0000 to=0600"
            ),
            "{}",
            log.captured()
        );
    }

    #[test]
    fn a_credential_is_never_created_through_a_name_that_already_resolves() {
        let dir = TempDir::new("posture-create");
        let (mount, _) = journal(&dir);
        let token = PathClass::SetupToken.path(&mount);
        fs::remove_file(&token).expect("the standing token goes");
        // Between "not there" and "create", a dangling link takes the name,
        // pointing where whoever planted it can read. An open that followed
        // it would write the minted token there.
        let elsewhere = mount.join("elsewhere");
        symlink(&elsewhere, &token).expect("a dangling link takes the name");

        let err = Posture::create(PathClass::SetupToken, &token)
            .expect_err("a name that already resolves is not created through");
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists, "{err}");
        assert!(
            fs::symlink_metadata(&elsewhere).is_err(),
            "nothing was written where the link pointed"
        );
    }

    #[test]
    fn a_file_just_written_is_measured_on_its_handle_and_not_on_the_mode_it_asked_for() {
        let dir = TempDir::new("posture-adopt");
        let (mount, posture) = journal(&dir);
        let log = Log::buffered(LogLevel::Debug);
        let key = PathClass::ServerKey.path(&mount);
        // The volume gave the new file a wider mode than it was asked for, as
        // a permissive umask or a filesystem of its own opinions would.
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(WEAK_FILE)
            .open(&key)
            .expect("the file is created wide");

        let written = posture
            .adopt(PathClass::ServerKey, file, &log)
            .expect("measured on the handle");
        assert_eq!(
            written.mode(),
            FILE_MODE,
            "the mode stated is the mode read back"
        );
        assert_eq!(read_facts(&key).expect("on disk").mode, FILE_MODE);
        assert!(
            log.captured().contains(
                "event=posture path_class=server_key decision=repaired from=0644 to=0600"
            ),
            "{}",
            log.captured()
        );
    }

    fn holder(depth: u32, uid: u32, mode: u32) -> Holder {
        Holder {
            depth,
            kind: Kind::Dir,
            uid,
            mode,
        }
    }

    /// The rename decision, one holder at a time. `ME` is uid 1000; the
    /// entry below each holder is root's or this server's, which is what
    /// the sticky bit relies on.
    #[test]
    fn who_may_rename_what_a_directory_holds() {
        const ME: u32 = 1000;
        let chain = |h: Holder| judge(&[h, holder(1, 0, 0o755)], ME);
        assert_eq!(chain(holder(0, 1000, 0o700)), Ok(0o700));
        assert_eq!(chain(holder(0, 0, 0o755)), Ok(0o755), "root's, closed");
        assert_eq!(
            chain(holder(0, 0, 0o1777)),
            Ok(0o1777 & MODE_MASK),
            "sticky: only the entry's owner, the directory's owner, or root"
        );
        assert_eq!(
            chain(holder(0, 1000, 0o1775)),
            Ok(0o1775 & MODE_MASK),
            "sticky holds whatever the group may write"
        );
        assert_eq!(
            chain(holder(0, 4242, 0o755)),
            Err(("foreign_owner", 0)),
            "its owner can widen it and rename what it holds"
        );
        assert_eq!(
            chain(holder(0, 4242, 0o1755)),
            Err(("foreign_owner", 0)),
            "sticky does not help when the directory's owner is the stranger"
        );
        assert_eq!(chain(holder(0, 0, 0o777)), Err(("writable_by_others", 0)));
        assert_eq!(
            chain(holder(0, 1000, 0o702)),
            Err(("writable_by_others", 0))
        );
        assert_eq!(
            chain(holder(0, 1000, 0o775)),
            Err(("writable_by_group", 0)),
            "a group number says nothing about who is in the group, this server's own included"
        );
        assert_eq!(
            chain(holder(0, 0, 0o2775)),
            Err(("writable_by_group", 0)),
            "setgid changes nothing"
        );
        // Above the configured directory, the same rules, and the depth says
        // how far up.
        assert_eq!(
            judge(&[holder(0, 1000, 0o700), holder(1, 4242, 0o755)], ME),
            Err(("foreign_owner", 1))
        );
        assert_eq!(
            judge(
                &[
                    holder(0, 1000, 0o700),
                    holder(1, 0, 0o777),
                    holder(2, 0, 0o755)
                ],
                ME
            ),
            Err(("writable_by_others", 1))
        );
        assert_eq!(
            judge(&[holder(0, 1000, 0o700), holder(1, 0, 0o775)], ME),
            Err(("writable_by_group", 1))
        );
        // Something that is not a directory cannot hold a root.
        let mut file = holder(0, 1000, 0o600);
        file.kind = Kind::File;
        assert_eq!(judge(&[file], ME), Err(("not_a_directory", 0)));
        assert_eq!(judge(&[], ME), Err(("unresolvable", 0)), "nothing was read");
    }

    /// The reviewer's round-10 schedule needed one thing: a directory above
    /// the root that another account could write. That directory is refused
    /// before any root is trusted by name.
    #[test]
    fn a_volume_directory_another_account_could_rename_refuses_the_start() {
        let dir = TempDir::new("posture-mount");
        let cfg = crate::cli::testutil::config(&dir).storage();
        fs::create_dir_all(&cfg.journal_dir).expect("the journal directory");
        fs::create_dir_all(&cfg.blobs_dir).expect("the blobs directory");
        let mirror = dir.path().join("mirror");
        fs::create_dir_all(&mirror).expect("the mirror directory");
        let mut cfg = cfg;
        cfg.mirrors.push(crate::config::MirrorVolume {
            path: mirror.clone(),
            label: "mirror".to_string(),
        });

        for (path, class, mode, reason) in [
            (
                &cfg.journal_dir,
                "journal_mount",
                0o777,
                "writable_by_others",
            ),
            (&cfg.blobs_dir, "blobs_mount", 0o777, "writable_by_others"),
            (&mirror, "blobs_mount", 0o777, "writable_by_others"),
            // The group this test runs in: a group number says nothing
            // about who else is in it.
            (
                &cfg.journal_dir,
                "journal_mount",
                0o775,
                "writable_by_group",
            ),
        ] {
            fs::set_permissions(path, Permissions::from_mode(mode)).expect("others may write it");
            let log = Log::buffered(LogLevel::Debug);
            let err = Posture::enforce(&cfg, &log)
                .expect_err("a directory others may write holds a root others may rename");
            assert!(
                matches!(err, StoreError::Posture { class: c, reason: r } if c == class && r == reason),
                "{class} {mode:o}: {err}"
            );
            assert!(
                log.captured().contains(&format!(
                    "event=posture path_class={class} decision=refused reason={reason} depth=0"
                )),
                "{}",
                log.captured()
            );
            fs::set_permissions(path, Permissions::from_mode(0o700)).expect("closed again");
        }

        // Closed, closed and readable, or sticky: each holds its root safely,
        // and the pass reports every mount with the mode it was read at.
        for mode in [0o700, 0o755, 0o1777] {
            fs::set_permissions(&cfg.journal_dir, Permissions::from_mode(mode)).expect("the mode");
            let log = Log::buffered(LogLevel::Debug);
            let posture = Posture::enforce(&cfg, &log).expect("a directory nobody else can write");
            let mounts: Vec<(&str, Decision)> = posture
                .outcomes()
                .iter()
                .filter(|o| matches!(o.class, PathClass::JournalMount | PathClass::BlobsMount))
                .map(|o| (o.class.label(), o.decision))
                .collect();
            assert_eq!(
                mounts,
                vec![
                    (
                        "journal_mount",
                        Decision::Ok {
                            mode: mode & MODE_MASK
                        }
                    ),
                    ("blobs_mount", Decision::Ok { mode: 0o700 }),
                    ("blobs_mount", Decision::Ok { mode: 0o700 }),
                ],
                "{mode:o}"
            );
        }
    }

    /// The round-11 schedule: a link of the server's own on the configured
    /// path, whose target passes through a second link owned by someone
    /// else; the pass accepts the resolved journal, the inner link is
    /// re-pointed at another journal, the store opens on it, the original
    /// is restored, a snapshot writes the substituted index into it. The
    /// schedule needed a configured path that resolves through a link. A
    /// configured path that is not its own resolved form is refused before
    /// anything is judged, whoever owns the links in it.
    #[test]
    fn a_configured_directory_that_is_not_its_own_resolved_form_is_refused_before_anything_is_judged()
     {
        let dir = TempDir::new("posture-canonical");
        let real = dir.path().join("real");
        let target = dir.path().join("target");
        fs::create_dir_all(target.join("journal")).expect("the journal behind the links");
        fs::create_dir_all(&real).expect("the outer target");
        // real/inner -> target: the inner link, the one a walk of the
        // written path never sees.
        symlink(&target, real.join("inner")).expect("the inner link");
        // link -> real: the outer link, on the configured path itself.
        let link = dir.path().join("link");
        symlink(&real, &link).expect("the outer link");

        let mut cfg = crate::cli::testutil::config(&dir).storage();
        cfg.journal_dir = link.join("inner").join("journal");
        let log = Log::buffered(LogLevel::Debug);
        let err = Posture::enforce(&cfg, &log)
            .expect_err("a path that resolves through links is not what it says");
        assert!(
            matches!(
                err,
                StoreError::Posture {
                    class: "journal_mount",
                    reason: "not_canonical"
                }
            ),
            "{err}"
        );
        // The walk goes from the filesystem root down, so the outer link, two
        // names up from the configured directory, is the one it meets first.
        assert!(
            log.captured().contains(
                "event=posture path_class=journal_mount decision=refused reason=not_canonical depth=2"
            ),
            "{}",
            log.captured()
        );

        // The same journal, named by its resolved path, is accepted: it is
        // the naming that was refused, not the directory.
        cfg.journal_dir = fs::canonicalize(target.join("journal")).expect("resolves");
        let log = Log::buffered(LogLevel::Debug);
        Posture::enforce(&cfg, &log).expect("its own resolved form");
    }

    /// The round-12 probe: a journal configured through a link, whose target
    /// already holds a root and a probe file. The refusal must come before a
    /// byte is written or removed behind the link.
    #[test]
    fn a_refused_path_leaves_what_stands_behind_it_untouched() {
        let dir = TempDir::new("posture-untouched");
        let target = dir.path().join("target");
        let target_root = target.join("journal").join(ROOT_DIR);
        fs::create_dir_all(&target_root).expect("the target's root");
        let planted = target_root.join(PROBE);
        fs::write(&planted, "planted").expect("a file under the probe's own name");
        let link = dir.path().join("link");
        symlink(&target, &link).expect("the link");
        let before: Vec<String> = fs::read_dir(&target_root)
            .expect("readable")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();

        let mut cfg = crate::cli::testutil::config(&dir).storage();
        cfg.journal_dir = link.join("journal");
        let log = Log::buffered(LogLevel::Debug);
        let err = Posture::enforce(&cfg, &log).expect_err("a path through a link is refused");
        assert!(
            matches!(
                err,
                StoreError::Posture {
                    class: "journal_mount",
                    reason: "not_canonical"
                }
            ),
            "{err}"
        );
        assert_eq!(
            fs::read_to_string(&planted).expect("still there"),
            "planted",
            "nothing under the probe's name was removed"
        );
        let after: Vec<String> = fs::read_dir(&target_root)
            .expect("readable")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(after, before, "nothing was created behind the link either");
        assert!(
            !cfg.blobs_dir.exists(),
            "the blobs directory was not created before the journal path was refused"
        );
    }

    /// A chain that would be refused once complete is refused before
    /// anything is created under it, so a refused start leaves nothing.
    #[test]
    fn a_refused_chain_creates_nothing_beneath_it() {
        let dir = TempDir::new("posture-residue");
        let parent = dir.path().join("open");
        fs::create_dir(&parent).expect("the parent");
        fs::set_permissions(&parent, Permissions::from_mode(0o777)).expect("anyone may write it");
        let mut cfg = crate::cli::testutil::config(&dir).storage();
        cfg.journal_dir = parent.join("journal");
        let log = Log::buffered(LogLevel::Debug);
        let err = Posture::enforce(&cfg, &log).expect_err("a parent anyone may write");
        assert!(
            matches!(
                err,
                StoreError::Posture {
                    class: "journal_mount",
                    reason: "writable_by_others"
                }
            ),
            "{err}"
        );
        assert!(
            log.captured().contains("reason=writable_by_others depth=1"),
            "the refusal names the parent, one up from the configured directory: {}",
            log.captured()
        );
        assert!(!cfg.journal_dir.exists(), "the tail was never created");
        let left: Vec<_> = fs::read_dir(&parent).expect("readable").flatten().collect();
        assert!(left.is_empty(), "no probe was left behind either");
        fs::set_permissions(&parent, Permissions::from_mode(0o700)).expect("closed for cleanup");
    }

    /// A volume a storage class presents as a directory this server cannot
    /// write, holding no root of the server's: refused with the reason,
    /// not on the first `mkdir`.
    #[test]
    fn a_volume_directory_this_server_cannot_write_and_that_holds_no_root_is_refused_as_unwritable()
    {
        let dir = TempDir::new("posture-unwritable");
        let mut cfg = crate::cli::testutil::config(&dir).storage();
        fs::create_dir(&cfg.journal_dir).expect("the mount point");
        fs::set_permissions(&cfg.journal_dir, Permissions::from_mode(0o500))
            .expect("closed to its owner");
        let log = Log::buffered(LogLevel::Debug);
        let err = Posture::enforce(&cfg, &log).expect_err("nothing can be created here");
        assert!(
            matches!(
                err,
                StoreError::Posture {
                    class: "journal_mount",
                    reason: "unwritable"
                }
            ),
            "{err}"
        );
        assert!(
            log.captured().contains(
                "event=posture path_class=journal_mount decision=refused reason=unwritable depth=0"
            ),
            "{}",
            log.captured()
        );
        fs::set_permissions(&cfg.journal_dir, Permissions::from_mode(0o700)).expect("open again");
        cfg.mirrors.clear();
        Posture::enforce(&cfg, &Log::buffered(LogLevel::Debug))
            .expect("prepared for the server, it starts");

        // The blobs directory has no probe to fail first: only the judgment
        // of what exists can refuse it.
        fs::remove_dir_all(&cfg.blobs_dir).expect("start over");
        fs::create_dir(&cfg.blobs_dir).expect("the blobs mount point");
        fs::set_permissions(&cfg.blobs_dir, Permissions::from_mode(0o500))
            .expect("closed to its owner");
        let log = Log::buffered(LogLevel::Debug);
        let err = Posture::enforce(&cfg, &log).expect_err("nothing can be created here either");
        assert!(
            matches!(
                err,
                StoreError::Posture {
                    class: "blobs_mount",
                    reason: "unwritable"
                }
            ),
            "{err}"
        );
        assert!(
            !cfg.blobs_dir.join(ROOT_DIR).exists(),
            "and no root was attempted under it"
        );
        fs::set_permissions(&cfg.blobs_dir, Permissions::from_mode(0o700))
            .expect("open for cleanup");
    }

    /// The round-13 probe: a file of this user's under the probe prefix,
    /// standing in a world-writable ancestor of a journal directory that
    /// does not exist yet. The refusal must leave it exactly as it was.
    #[test]
    fn a_file_under_the_probe_prefix_survives_a_refused_start() {
        let dir = TempDir::new("posture-survivor");
        let open = dir.path().join("open");
        fs::create_dir(&open).expect("the world-writable ancestor");
        let survivor = open.join(format!("{PROBE}-must-survive"));
        fs::write(&survivor, "keep").expect("a file of this user's under the prefix");
        fs::set_permissions(&open, Permissions::from_mode(0o777)).expect("anyone may write it");
        let mut cfg = crate::cli::testutil::config(&dir).storage();
        cfg.journal_dir = open.join("journal");
        let log = Log::buffered(LogLevel::Debug);
        let err = Posture::enforce(&cfg, &log).expect_err("a parent anyone may write");
        assert!(
            matches!(
                err,
                StoreError::Posture {
                    class: "journal_mount",
                    reason: "writable_by_others"
                }
            ),
            "{err}"
        );
        assert_eq!(
            fs::read_to_string(&survivor).expect("still there"),
            "keep",
            "nothing under the probe prefix was removed by a refused start"
        );
        let left: Vec<String> = fs::read_dir(&open)
            .expect("readable")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            left,
            vec![format!("{PROBE}-must-survive")],
            "and nothing else was left behind"
        );
        fs::set_permissions(&open, Permissions::from_mode(0o700)).expect("closed for cleanup");
    }

    /// On the shipped platform the user is read, never written for: a
    /// directory this process cannot write still yields it, untouched.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_user_is_learned_without_writing_anything() {
        let dir = TempDir::new("posture-proc");
        let closed = dir.path().join("closed");
        fs::create_dir(&closed).expect("a directory");
        fs::set_permissions(&closed, Permissions::from_mode(0o500)).expect("closed to its owner");
        let log = Log::buffered(LogLevel::Debug);
        let uid =
            process_user(PathClass::JournalMount, &closed, &log).expect("read off /proc/self");
        assert_eq!(
            uid,
            fs::symlink_metadata(&closed).expect("the directory").uid()
        );
        assert!(
            fs::read_dir(&closed).expect("readable").next().is_none(),
            "nothing was written to learn it"
        );
        assert!(
            !log.captured().contains("decision=refused"),
            "{}",
            log.captured()
        );
        fs::set_permissions(&closed, Permissions::from_mode(0o700)).expect("open for cleanup");
    }

    #[test]
    fn a_configured_directory_written_with_dots_is_refused_as_not_its_own_resolved_form() {
        let dir = TempDir::new("posture-dots");
        let mut cfg = crate::cli::testutil::config(&dir).storage();
        cfg.journal_dir = dir.path().join("journal").join("..").join("journal");
        let log = Log::buffered(LogLevel::Debug);
        let err = Posture::enforce(&cfg, &log).expect_err("`..` is not a resolved form");
        assert!(
            !dir.path().join("journal").exists() && !cfg.blobs_dir.exists(),
            "refused before anything was created through the dotted path"
        );
        assert!(
            matches!(
                err,
                StoreError::Posture {
                    class: "journal_mount",
                    reason: "not_canonical"
                }
            ),
            "{err}"
        );
    }

    #[test]
    fn a_correction_the_volume_ignores_refuses_rather_than_reporting_success() {
        let dir = TempDir::new("posture-ignored");
        let path = weak_file(&dir);
        let log = Log::buffered(LogLevel::Debug);
        let posture = as_owner(&path);
        let reader = scripted(vec![
            Ok(facts_about(&path, Kind::File, WEAK_FILE)),
            // The re-read: the volume kept the mode it arrived with.
            Ok(facts_about(&path, Kind::File, WEAK_FILE)),
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
            Ok(facts_about(&path, Kind::File, WEAK_FILE)),
            // Between the correction and the re-read, the handle answers as
            // something else.
            Ok(facts_about(&path, Kind::Link, 0o600)),
        ]);
        let err = as_owner(&path)
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
    fn a_handle_that_is_not_the_inode_the_name_had_refuses() {
        let dir = TempDir::new("posture-repointed");
        let path = weak_file(&dir);
        let log = Log::buffered(LogLevel::Debug);
        // The look saw one inode; what the open reached answers as another,
        // as it would if the name were re-pointed in between.
        let mut other = facts_about(&path, Kind::File, 0o600);
        other.id = (other.id.0, other.id.1 ^ 1);
        let reader = scripted(vec![Ok(other)]);
        let err = as_owner(&path)
            .verify_facts(PathClass::ServerKey, &path, &log, &reader)
            .expect_err("what was opened is not what was looked at");
        assert!(
            matches!(
                err,
                StoreError::Posture {
                    class: "server_key",
                    reason: "swapped"
                }
            ),
            "{err}"
        );
        assert!(
            log.captured()
                .contains("event=posture path_class=server_key decision=refused reason=swapped"),
            "{}",
            log.captured()
        );
    }

    #[test]
    fn a_volume_that_stops_answering_after_the_correction_refuses() {
        let dir = TempDir::new("posture-silent");
        let path = weak_file(&dir);
        let log = Log::buffered(LogLevel::Debug);
        let reader = scripted(vec![
            Ok(facts_about(&path, Kind::File, WEAK_FILE)),
            Err(io::Error::from(io::ErrorKind::PermissionDenied)),
        ]);
        let err = as_owner(&path)
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
