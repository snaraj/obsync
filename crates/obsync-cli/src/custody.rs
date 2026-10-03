#![forbid(unsafe_code)]

use crate::{Error, Result};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
#[cfg(windows)]
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::{
    collections::BTreeMap,
    fs::{self, File, Metadata, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    time::Instant,
};

pub fn unsafe_path() -> Error {
    Error::new(
        "unsafe_config",
        "The path, ownership, permissions or file identity could not establish private custody.",
        4,
    )
}
pub fn io_error(_: std::io::Error) -> Error {
    Error::new(
        "local_io",
        "The local file operation failed; no private path was recorded.",
        9,
    )
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Stamp {
    pub dev: u64,
    pub ino: u64,
    pub links: u64,
    pub uid: u32,
    pub mode: u32,
    pub changed: (i64, i64),
    pub length: u64,
    pub directory: bool,
}
impl Stamp {
    pub fn same(&self, other: &Self) -> bool {
        self.dev == other.dev
            && self.ino == other.ino
            && self.uid == other.uid
            && self.mode == other.mode
            && self.directory == other.directory
            && (self.directory || self.links == other.links)
    }
}
#[cfg(unix)]
fn stamp(m: &Metadata) -> Stamp {
    Stamp {
        dev: m.dev(),
        ino: m.ino(),
        links: m.nlink(),
        uid: m.uid(),
        mode: m.mode(),
        changed: (m.ctime(), m.ctime_nsec()),
        length: m.len(),
        directory: m.is_dir(),
    }
}
pub fn identity(file: &File) -> Result<Stamp> {
    let m = file.metadata().map_err(io_error)?;
    #[cfg(unix)]
    {
        Ok(stamp(&m))
    }
    #[cfg(windows)]
    {
        let id = crate::windows_identity::identity(file).map_err(|_| unsafe_path())?;
        Ok(Stamp {
            dev: id.volume.into(),
            ino: id.index,
            links: id.links.into(),
            uid: 0,
            mode: id.attributes,
            changed: (m.last_write_time() as i64, 0),
            length: m.len(),
            directory: m.is_dir(),
        })
    }
}
pub fn exact(path: &str, root_allowed: bool) -> Result<PathBuf> {
    if path.is_empty()
        || path.len() > 4096
        || path.chars().any(char::is_control)
        || !Path::new(path).is_absolute()
    {
        return Err(unsafe_path());
    }
    #[cfg(unix)]
    {
        if path != "/"
            && path[1..]
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == "..")
        {
            return Err(unsafe_path());
        }
        if path == "/" && !root_allowed {
            return Err(unsafe_path());
        }
    }
    #[cfg(windows)]
    {
        if path.len() > 240
            || path.len() < 3
            || !path.as_bytes()[0].is_ascii_uppercase()
            || !path[1..].starts_with(":\\")
            || path[3..].chars().any(|c| r#"/:<>"|?*"#.contains(c))
        {
            return Err(unsafe_path());
        }
        if path.len() == 3 {
            if !root_allowed {
                return Err(unsafe_path());
            }
        } else {
            for part in path[3..].split('\\') {
                let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
                if part.is_empty()
                    || part == "."
                    || part == ".."
                    || part.ends_with([' ', '.'])
                    || ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
                    || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                        && stem.len() == 4
                        && (b'1'..=b'9').contains(&stem.as_bytes()[3]))
                {
                    return Err(unsafe_path());
                }
            }
        }
    }
    Ok(PathBuf::from(path))
}

#[cfg(all(test, windows))]
mod windows_paths {
    use super::exact;

    #[test]
    fn nested_paths_keep_their_separators_and_refuse_aliases() {
        for path in [r"C:\Users\lab\state", r"D:\private package\obsync.exe"] {
            assert_eq!(exact(path, false).unwrap().to_str(), Some(path));
        }
        assert!(exact(r"C:\", true).is_ok());
        for path in [
            r"C:\",
            r"c:\Users\lab",
            r"\\server\share",
            r"\\?\C:\lab",
            r"C:\lab\\state",
            r"C:\lab\.\state",
            r"C:\lab\..\state",
            r"C:\lab\state\",
            r"C:\lab\state.",
            r"C:\lab\state ",
            r"C:\lab\file:stream",
            r"C:\lab/state",
            r"C:\lab\CON.txt",
            r"C:\lab\LPT1",
            r"C:\lab\state?",
            r#"C:\lab\state""#,
        ] {
            assert!(exact(path, false).is_err(), "accepted {path:?}");
        }
    }
}
pub fn present(path: &Path) -> Result<Option<Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(m) => Ok(Some(m)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(unsafe_path()),
    }
}
fn options(write: bool, directory: bool) -> OpenOptions {
    let mut o = OpenOptions::new();
    o.read(true).write(write);
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    o.custom_flags(0x20000 | 0x800 | if directory { 0x10000 } else { 0 });
    // Linux arm64's UAPI retains the ARM O_NOFOLLOW/O_DIRECTORY values;
    // these differ from asm-generic/x86_64. Native VM checks pin both paths.
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    o.custom_flags(0x8000 | 0x800 | if directory { 0x4000 } else { 0 });
    #[cfg(target_os = "macos")]
    o.custom_flags(0x100 | 4 | if directory { 0x100000 } else { 0 });
    #[cfg(windows)]
    o.custom_flags(0x200000 | if directory { 0x2000000 } else { 0 })
        .share_mode(3);
    o
}
pub fn open(path: &Path, write: bool, directory: bool) -> Result<File> {
    let before = present(path)?.ok_or_else(unsafe_path)?;
    if before.file_type().is_symlink()
        || (if directory {
            !before.is_dir()
        } else {
            !before.is_file()
        })
    {
        return Err(unsafe_path());
    }
    #[cfg(windows)]
    if before.file_attributes() & 0x400 != 0 {
        return Err(unsafe_path());
    }
    let file = options(write, directory).open(path).map_err(|_| {
        Error::new(
            "native_open_failed",
            if directory {
                "A guarded directory could not be opened on this platform."
            } else {
                "A guarded file could not be opened on this platform."
            },
            4,
        )
    })?;
    let actual = identity(&file)?;
    if actual.directory != directory || (!directory && actual.links != 1) {
        return Err(unsafe_path());
    }
    #[cfg(unix)]
    if !actual.same(&stamp(&before)) {
        return Err(unsafe_path());
    }
    #[cfg(windows)]
    {
        if actual.mode & 0x400 != 0 {
            return Err(unsafe_path());
        }
        let named = options(false, directory)
            .open(path)
            .map_err(|_| unsafe_path())?;
        if !actual.same(&identity(&named)?) {
            return Err(unsafe_path());
        }
    }
    Ok(file)
}
pub fn bounded(file: &mut File, maximum: usize) -> Result<Vec<u8>> {
    let before = identity(file)?;
    if before.length > maximum as u64 {
        return Err(Error::input("The input exceeds its byte budget."));
    }
    let mut bytes = Vec::new();
    file.take((maximum + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() > maximum || before != identity(file)? {
        return Err(unsafe_path());
    }
    Ok(bytes)
}

pub struct Custody {
    pub deadline: Instant,
    #[cfg(unix)]
    uid: u32,
    cache: BTreeMap<PathBuf, Stamp>,
    #[cfg(target_os = "macos")]
    interpreter: Option<Stamp>,
    #[cfg(windows)]
    windows: crate::windows::Windows,
}
impl Custody {
    pub fn new(deadline: Instant, args: &crate::args::Args) -> Result<Self> {
        if !cfg!(any(
            all(
                target_os = "linux",
                any(target_arch = "aarch64", target_arch = "x86_64")
            ),
            all(
                target_os = "macos",
                any(target_arch = "aarch64", target_arch = "x86_64")
            ),
            all(windows, target_arch = "x86_64")
        )) {
            return Err(Error::unsupported(
                "Native custody is unavailable for this OS and architecture.",
            ));
        }
        #[cfg(not(windows))]
        let _ = args;
        Ok(Self {
            deadline,
            #[cfg(unix)]
            uid: crate::posix_identity::user().map_err(|_| unsafe_path())?,
            cache: BTreeMap::new(),
            #[cfg(target_os = "macos")]
            interpreter: None,
            #[cfg(windows)]
            windows: crate::windows::Windows::new(args, deadline)?,
        })
    }
    pub fn check_time(&self) -> Result<()> {
        if Instant::now() >= self.deadline {
            Err(Error::new(
                "deadline_exceeded",
                "The local operation exceeded its five-second deadline.",
                7,
            ))
        } else {
            Ok(())
        }
    }
    pub fn file(&mut self, path: &Path, write: bool) -> Result<File> {
        self.private_file(path, write, false)
    }
    pub fn private_file(&mut self, path: &Path, write: bool, executable: bool) -> Result<File> {
        self.directory(path.parent().ok_or_else(unsafe_path)?, false)?;
        let file = open(path, write, false)?;
        let before = identity(&file)?;
        #[cfg(unix)]
        if before.uid != self.uid || before.mode & 0o7777 != if executable { 0o700 } else { 0o600 }
        {
            return Err(unsafe_path());
        }
        #[cfg(windows)]
        {
            let _ = executable;
            self.windows.inspect(path, self.deadline)?;
        }
        if before != identity(&file)? {
            return Err(unsafe_path());
        }
        Ok(file)
    }
    pub fn directory(&mut self, path: &Path, create: bool) -> Result<bool> {
        self.check_time()?;
        let mut ancestors = path.ancestors().collect::<Vec<_>>();
        ancestors.reverse();
        for at in ancestors {
            let leaf = at == path;
            if present(at)?.is_none() {
                if !create {
                    return Ok(false);
                }
                if !leaf {
                    return Err(Error::new(
                        "config_parent_missing",
                        "The configuration parent must already exist.",
                        4,
                    ));
                }
                #[cfg(unix)]
                match fs::DirBuilder::new().mode(0o700).create(at) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(e) => return Err(io_error(e)),
                }
                #[cfg(windows)]
                self.windows.mkdir(at, self.deadline)?;
            }
            let held = open(at, false, true)?;
            let current = identity(&held)?;
            #[cfg(unix)]
            {
                if leaf {
                    if current.uid != self.uid || current.mode & 0o7777 != 0o700 {
                        return Err(unsafe_path());
                    }
                } else if (current.uid != 0 && current.uid != self.uid)
                    || (current.mode & 0o022 != 0
                        && !(current.uid == 0 && current.mode & 0o1000 != 0))
                {
                    return Err(unsafe_path());
                }
            }
            #[cfg(target_os = "macos")]
            if self.cache.get(at) != Some(&current) {
                self.macos(at, &held, &current)?;
            }
            #[cfg(windows)]
            if leaf {
                self.windows.inspect(at, self.deadline)?;
            }
            if !current.same(&identity(&held)?) {
                return Err(unsafe_path());
            }
            self.cache.insert(at.into(), identity(&held)?);
        }
        if create {
            self.sync_parent(path)?;
        }
        Ok(true)
    }
    pub fn create_file(&mut self, path: &Path) -> Result<()> {
        self.create_private_file(path, false)
    }
    pub fn create_private_file(&mut self, path: &Path, executable: bool) -> Result<()> {
        self.directory(path.parent().ok_or_else(unsafe_path)?, false)?;
        #[cfg(unix)]
        {
            let file = match options(true, false)
                .create_new(true)
                .mode(if executable { 0o700 } else { 0o600 })
                .open(path)
            {
                Ok(file) => file,
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    self.private_file(path, true, executable)?
                }
                Err(e) => return Err(io_error(e)),
            };
            file.sync_all().map_err(io_error)?;
            self.sync_parent(path)?;
        }
        #[cfg(windows)]
        {
            let _ = executable;
            self.windows.create(path, self.deadline)?;
        }
        Ok(())
    }
    pub fn publish_directory(&mut self, from: &Path, to: &Path) -> Result<()> {
        self.check_time()?;
        if from.parent() != to.parent() || present(to)?.is_some() {
            return Err(unsafe_path());
        }
        self.directory(from, false)?;
        #[cfg(unix)]
        {
            open(from, false, true)?.sync_all().map_err(io_error)?;
            fs::rename(from, to).map_err(io_error)?;
            self.sync_parent(to)?;
        }
        #[cfg(windows)]
        self.windows.publish(from, to, self.deadline)?;
        self.directory(to, false)?;
        Ok(())
    }
    pub fn sync_parent(&self, path: &Path) -> Result<()> {
        #[cfg(unix)]
        open(path.parent().ok_or_else(unsafe_path)?, false, true)?
            .sync_all()
            .map_err(io_error)?;
        // Windows creates private files/directories using the existing approved
        // WRITE_THROUGH publication helper; Rust sync_all flushes file contents.
        #[cfg(windows)]
        let _ = path;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    fn macos(&mut self, path: &Path, held: &File, first: &Stamp) -> Result<()> {
        use std::process::{Command, Stdio};
        let command = |executable: &str| {
            let mut c = Command::new(executable);
            c.env_clear().env("LC_ALL", "C").current_dir("/");
            c
        };
        if self.interpreter.is_none() {
            for p in [
                "/",
                "/usr",
                "/usr/bin",
                "/usr/bin/codesign",
                "/usr/bin/osascript",
            ] {
                let m = present(Path::new(p))?.ok_or_else(unsafe_path)?;
                if m.file_type().is_symlink()
                    || m.uid() != 0
                    || m.mode() & 0o022 != 0
                    || (if p.ends_with("codesign") || p.ends_with("osascript") {
                        !m.is_file()
                    } else {
                        !m.is_dir()
                    })
                {
                    return Err(unsafe_path());
                }
            }
            let before = stamp(&fs::symlink_metadata("/usr/bin/osascript").map_err(io_error)?);
            let mut c = command("/usr/bin/codesign");
            c.args([
                "--verify",
                "--strict",
                "-R",
                "=anchor apple",
                "/usr/bin/osascript",
            ])
            .stdin(Stdio::null());
            if !crate::process::capture(c, None, self.deadline)?.is_empty()
                || before != stamp(&fs::symlink_metadata("/usr/bin/osascript").map_err(io_error)?)
            {
                return Err(unsafe_path());
            }
            self.interpreter = Some(before);
        }
        if self.interpreter.as_ref()
            != Some(&stamp(
                &fs::symlink_metadata("/usr/bin/osascript").map_err(io_error)?,
            ))
        {
            return Err(unsafe_path());
        }
        let source = format!(
            "const ARM64={};\n{}",
            cfg!(target_arch = "aarch64"),
            include_str!("macos-acl.js")
        );
        let mut before = first.clone();
        loop {
            self.check_time()?;
            let mut c = command("/usr/bin/osascript");
            c.args([
                "-l",
                "JavaScript",
                "-e",
                &source,
                &before.dev.to_string(),
                &before.ino.to_string(),
            ])
            .stdin(Stdio::from(held.try_clone().map_err(io_error)?));
            let raw = crate::process::capture(c, None, self.deadline)?;
            let result = obsync_core::json::parse(&raw).map_err(|_| unsafe_path())?;
            let after = identity(held)?;
            let named = stamp(&fs::symlink_metadata(path).map_err(io_error)?);
            let changed = result
                .get("reason")
                .and_then(obsync_core::json::Value::as_str)
                == Some("changed");
            if !before.same(&after) || !before.same(&named) {
                return Err(unsafe_path());
            }
            if changed || before.changed != after.changed || before.changed != named.changed {
                if before.changed == after.changed && before.changed == named.changed {
                    return Err(unsafe_path());
                }
                before = after;
                continue;
            }
            crate::context::closed(&result, &["v", "ok", "kind", "entries", "errno"])
                .map_err(|_| unsafe_path())?;
            let kind = crate::context::text(&result, "kind").map_err(|_| unsafe_path())?;
            let count = crate::context::number(&result, "entries").map_err(|_| unsafe_path())?;
            if result.get("v").and_then(obsync_core::json::Value::as_u64) != Some(1)
                || result.get("ok").and_then(obsync_core::json::Value::as_bool) != Some(true)
                || !result
                    .get("errno")
                    .is_some_and(obsync_core::json::Value::is_null)
                || !(if kind == "deny_only" {
                    (1..=128).contains(&count)
                } else {
                    ["absent", "empty"].contains(&kind) && count == 0
                })
            {
                return Err(unsafe_path());
            }
            return Ok(());
        }
    }
}
