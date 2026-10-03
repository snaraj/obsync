#![forbid(unsafe_code)]

use crate::{
    Error, Result,
    args::Args,
    context,
    custody::{self, Custody},
    s,
};
use obsync_core::json::{self, Value, obj};
use std::{
    collections::BTreeMap,
    fs,
    io::{Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::Instant,
};

const MAX_PACKAGE: usize = 8 * 1024 * 1024;
const MANIFEST: &str = "package-manifest.json";
pub const BINARY: &str = if cfg!(windows) {
    "obsync.exe"
} else {
    "obsync"
};
pub fn platform() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "linux-amd64",
        ("linux", "aarch64") => "linux-arm64",
        ("macos", "aarch64") => "darwin-arm64",
        ("windows", "x86_64") => "windows-amd64",
        _ => "unsupported",
    }
}
fn conflict() -> Error {
    Error::new(
        "package_integrity",
        "The package, installation or interrupted inventory differs from the exact verified manifest; no unrelated file was removed.",
        4,
    )
}
fn inventory(path: &Path) -> Result<Vec<String>> {
    let mut names = Vec::new();
    for entry in fs::read_dir(path).map_err(custody::io_error)?.take(13) {
        let e = entry.map_err(custody::io_error)?;
        names.push(e.file_name().into_string().map_err(|_| conflict())?);
    }
    names.sort();
    Ok(names)
}
fn read(c: &mut Custody, path: &Path, executable: bool) -> Result<Vec<u8>> {
    let mut file = c.private_file(path, false, executable)?;
    custody::bounded(&mut file, MAX_PACKAGE)
}
fn verified_package(
    c: &mut Custody,
    source: &Path,
    digest: &str,
) -> Result<BTreeMap<String, Vec<u8>>> {
    if !c.directory(source, false)? {
        return Err(conflict());
    }
    let raw = read(c, &source.join(MANIFEST), false)?;
    if raw.len() > 16384 || context::digest(&raw) != digest {
        return Err(conflict());
    }
    let manifest = json::parse(&raw).map_err(|_| conflict())?;
    context::closed(
        &manifest,
        &[
            "schema_version",
            "version",
            "platform",
            "source_sha",
            "candidate",
            "files",
        ],
    )?;
    if context::number(&manifest, "schema_version")? != 2
        || context::text(&manifest, "version")? != env!("CARGO_PKG_VERSION")
        || context::text(&manifest, "platform")? != platform()
        || platform() == "unsupported"
        || !manifest
            .get("candidate")
            .is_some_and(|v| v.as_bool().is_some())
    {
        return Err(conflict());
    }
    let source_sha = context::text(&manifest, "source_sha")?;
    if source_sha.len() != 40
        || !source_sha
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || source_sha.bytes().all(|b| b == b'0')
    {
        return Err(conflict());
    }
    let mut expected = ["LICENSE", "README.md", "VERSION", BINARY];
    expected.sort();
    let entries = manifest
        .get("files")
        .and_then(Value::as_array)
        .ok_or_else(conflict)?;
    if entries.len() != expected.len() {
        return Err(conflict());
    }
    let mut files = BTreeMap::new();
    let mut total = raw.len();
    for (name, record) in expected.iter().zip(entries) {
        context::closed(record, &["name", "size", "sha256"])?;
        if context::text(record, "name")? != *name {
            return Err(conflict());
        }
        let bytes = read(c, &source.join(name), *name == BINARY)?;
        total += bytes.len();
        if bytes.is_empty()
            || total > MAX_PACKAGE
            || bytes.len() as u64 != context::number(record, "size")?
            || context::digest(&bytes) != context::text(record, "sha256")?
        {
            return Err(conflict());
        }
        files.insert((*name).to_owned(), bytes);
    }
    if files["VERSION"] != format!("{}\n", env!("CARGO_PKG_VERSION")).as_bytes() {
        return Err(conflict());
    }
    // The caller verifies publisher provenance before executing any package code.
    // Bind this running binary to the selected package too; no launcher/runtime.
    let exe = std::env::current_exe().map_err(custody::io_error)?;
    let mut held = custody::open(&exe, false, false)?;
    if custody::bounded(&mut held, MAX_PACKAGE)? != files[BINARY] {
        return Err(conflict());
    }
    files.insert(MANIFEST.into(), raw);
    if inventory(source)? != files.keys().cloned().collect::<Vec<_>>() {
        return Err(conflict());
    }
    Ok(files)
}
fn durable(c: &mut Custody, path: &Path, bytes: &[u8], executable: bool) -> Result<()> {
    if custody::present(path)?.is_none() {
        c.create_private_file(path, executable)?;
    }
    let previous = read(c, path, executable)?;
    if previous.len() > bytes.len() || previous != bytes[..previous.len()] {
        return Err(conflict());
    }
    let mut file = c.private_file(path, true, executable)?;
    // Resume a verified prefix without truncating already accepted bytes.
    file.seek(SeekFrom::Start(previous.len() as u64))
        .map_err(custody::io_error)?;
    file.write_all(&bytes[previous.len()..])
        .map_err(custody::io_error)?;
    file.sync_all().map_err(custody::io_error)?;
    c.sync_parent(path)?;
    Ok(())
}
fn inspect(
    c: &mut Custody,
    root: &Path,
    files: &BTreeMap<String, Vec<u8>>,
    partial: bool,
) -> Result<()> {
    if !c.directory(root, false)? {
        return Err(conflict());
    }
    let names = inventory(root)?;
    if !partial && names != files.keys().cloned().collect::<Vec<_>>() {
        return Err(conflict());
    }
    for name in names {
        let expected = files.get(&name).ok_or_else(conflict)?;
        if read(c, &root.join(&name), name == BINARY)? != *expected {
            return Err(conflict());
        }
    }
    Ok(())
}
fn check_pending(c: &mut Custody, root: &Path, files: &BTreeMap<String, Vec<u8>>) -> Result<()> {
    let names = inventory(root)?;
    let mut content_count = 0;
    for name in &names {
        #[cfg(windows)]
        if let Some(base) = name.strip_suffix(".obsync-create") {
            if !files.contains_key(base) || !read(c, &root.join(name), false)?.is_empty() {
                return Err(conflict());
            }
            continue;
        }
        let expected = files.get(name).ok_or_else(conflict)?;
        let actual = read(c, &root.join(name), name == BINARY)?;
        if actual.len() > expected.len() || actual != expected[..actual.len()] {
            return Err(conflict());
        }
        content_count += 1;
    }
    if content_count > 1
        && (!names.iter().any(|n| n == MANIFEST)
            || read(c, &root.join(MANIFEST), false)? != files[MANIFEST])
    {
        return Err(conflict());
    }
    // Validate every staged byte before removing exact empty creation companions.
    #[cfg(windows)]
    for name in names.iter().filter(|n| n.ends_with(".obsync-create")) {
        fs::remove_file(root.join(name)).map_err(custody::io_error)?;
    }
    Ok(())
}
fn disjoint(source: &Path, parent: &Path, reserved: &[&Path]) -> Result<()> {
    // Compare opened identities, not spelling: NTFS/APFS can resolve different
    // case (and NTFS short names) to the same directory without a symlink.
    let source_ids = source
        .ancestors()
        .map(|p| custody::identity(&custody::open(p, false, true)?))
        .collect::<Result<Vec<_>>>()?;
    let same = |a: &custody::Stamp, b: &custody::Stamp| a.dev == b.dev && a.ino == b.ino;
    for ancestor in parent.ancestors() {
        if same(
            &source_ids[0],
            &custody::identity(&custody::open(ancestor, false, true)?)?,
        ) {
            return Err(conflict());
        }
    }
    for path in reserved {
        if let Some(m) = custody::present(path)? {
            let id = custody::identity(&custody::open(path, false, m.is_dir())?)?;
            if source_ids.iter().any(|s| same(s, &id)) {
                return Err(conflict());
            }
        }
    }
    Ok(())
}
pub fn run(args: &Args, uninstall: bool, deadline: Instant) -> Result<Value> {
    args.check(1, 1, &["from", "prefix", "manifest-sha256"])?;
    let path = |key| {
        custody::exact(
            args.get(key).ok_or_else(|| {
                Error::input(
                    "Supply --from, --prefix and the independently verified --manifest-sha256.",
                )
            })?,
            false,
        )
    };
    let source = path("from")?;
    let prefix = path("prefix")?;
    let digest = args.get("manifest-sha256").ok_or_else(|| {
        Error::input("Supply --manifest-sha256 from independently verified release evidence.")
    })?;
    let parent = prefix.parent().ok_or_else(conflict)?;
    let sibling = |suffix| -> Result<PathBuf> {
        custody::exact(
            &format!("{}.{suffix}", prefix.to_str().ok_or_else(conflict)?),
            false,
        )
    };
    let pending = sibling("pending")?;
    let removing = sibling("removing")?;
    let lockpath = sibling("lock")?;
    for reserved in [&prefix, &pending, &removing, &lockpath] {
        if source.starts_with(reserved) || reserved.starts_with(&source) {
            return Err(conflict());
        }
    }
    let mut c = Custody::new(deadline, args)?;
    let files = verified_package(&mut c, &source, digest)?;
    if !c.directory(parent, false)? {
        return Err(conflict());
    }
    disjoint(&source, parent, &[&prefix, &pending, &removing, &lockpath])?;
    c.create_file(&lockpath)?;
    let mut lock = c.file(&lockpath, true)?;
    lock.try_lock().map_err(|_| {
        Error::new(
            "install_busy",
            "Another installation operation holds this target's lock; retry the same action.",
            5,
        )
    })?;
    let record = obj(vec![
        ("schema_version", Value::Int(1)),
        (
            "target_digest",
            s(context::digest(prefix.to_str().unwrap().as_bytes())),
        ),
        ("manifest_sha256", s(digest)),
    ]);
    let record = record.to_json().into_bytes();
    let previous = custody::bounded(&mut lock, 1024)?;
    if previous != record {
        // No installation effect may precede the flushed binding. A torn
        // initial record is resumable only while all three directories are absent.
        if previous.len() > record.len()
            || previous != record[..previous.len()]
            || [&prefix, &pending, &removing]
                .iter()
                .map(|p| custody::present(p))
                .collect::<Result<Vec<_>>>()?
                .iter()
                .any(Option::is_some)
        {
            return Err(conflict());
        }
        lock.write_all(&record[previous.len()..])
            .map_err(custody::io_error)?;
    }
    // A previous process may have died after writing the complete record but
    // before flushing it; retry must establish durability before effects too.
    lock.sync_all().map_err(custody::io_error)?;
    c.sync_parent(&lockpath)?;
    c.check_time()?;
    if uninstall {
        if custody::present(&pending)?.is_some() {
            return Err(conflict());
        }
        if custody::present(&prefix)?.is_some() {
            if custody::present(&removing)?.is_some() {
                return Err(conflict());
            }
            inspect(&mut c, &prefix, &files, false)?;
            c.publish_directory(&prefix, &removing)?;
        }
        if custody::present(&removing)?.is_some() {
            inspect(&mut c, &removing, &files, true)?;
            let remaining = inventory(&removing)?;
            // The durable binding is outside this tree and is never removed.
            // Reordered cleanup writes can therefore always be checked on retry.
            for name in &remaining {
                c.check_time()?;
                fs::remove_file(removing.join(name)).map_err(custody::io_error)?;
            }
            c.sync_parent(&removing.join(MANIFEST))?;
            fs::remove_dir(&removing).map_err(custody::io_error)?;
            c.sync_parent(&removing)?;
        }
    } else {
        if custody::present(&removing)?.is_some() {
            return Err(conflict());
        }
        if custody::present(&prefix)?.is_some() {
            if custody::present(&pending)?.is_some() {
                return Err(conflict());
            }
            inspect(&mut c, &prefix, &files, false)?;
        } else {
            c.directory(&pending, true)?;
            check_pending(&mut c, &pending, &files)?;
            durable(&mut c, &pending.join(MANIFEST), &files[MANIFEST], false)?;
            for (name, bytes) in &files {
                c.check_time()?;
                if name != MANIFEST {
                    durable(&mut c, &pending.join(name), bytes, name == BINARY)?;
                }
            }
            inspect(&mut c, &pending, &files, false)?;
            c.publish_directory(&pending, &prefix)?;
            inspect(&mut c, &prefix, &files, false)?;
        }
    }
    c.finish()?;
    Ok(obj(vec![
        ("manifest_sha256", s(digest)),
        ("platform", s(platform())),
        ("configuration_changed", Value::Bool(false)),
        ("lock_retained", Value::Bool(true)),
        (
            "cleanup_durable",
            if uninstall {
                Value::Bool(cfg!(unix))
            } else {
                Value::Null
            },
        ),
    ]))
}
