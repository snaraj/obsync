#![forbid(unsafe_code)]
#![cfg(unix)]

use obsync_core::{
    hex,
    json::{self, Value, obj},
    sha256::sha256,
};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

struct Lab {
    root: PathBuf,
    source: PathBuf,
    prefix: PathBuf,
    digest: String,
}
impl Lab {
    fn new() -> Self {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "obsync-package-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let source = root.join("source");
        fs::DirBuilder::new().mode(0o700).create(&source).unwrap();
        let mut records = Vec::new();
        for (name, mut bytes) in [
            ("LICENSE", b"synthetic license\n".to_vec()),
            ("README.md", b"synthetic instructions\n".to_vec()),
            (
                "VERSION",
                format!("{}\n", env!("CARGO_PKG_VERSION")).into_bytes(),
            ),
            ("obsync", fs::read(env!("CARGO_BIN_EXE_obsync")).unwrap()),
        ] {
            let p = source.join(name);
            fs::write(&p, &bytes).unwrap();
            fs::set_permissions(
                &p,
                fs::Permissions::from_mode(if name == "obsync" { 0o700 } else { 0o600 }),
            )
            .unwrap();
            if name == "obsync" {
                // The release profile strips symbols. Do the same to this
                // private executable copy before hashing it: Linux DWARF can
                // exceed the unchanged 8 MiB package limit in a debug build.
                assert!(
                    Command::new("/usr/bin/strip")
                        .arg("-S")
                        .arg(&p)
                        .status()
                        .unwrap()
                        .success()
                );
                bytes = fs::read(&p).unwrap();
            }
            records.push(obj(vec![
                ("name", Value::Str(name.into())),
                ("size", Value::Int(bytes.len() as i64)),
                ("sha256", Value::Str(hex::encode(&sha256(&bytes)))),
            ]));
        }
        let platform = match (std::env::consts::OS, std::env::consts::ARCH) {
            ("macos", "aarch64") => "darwin-arm64",
            ("linux", "aarch64") => "linux-arm64",
            ("linux", "x86_64") => "linux-amd64",
            _ => panic!("unsupported test platform"),
        };
        let manifest = obj(vec![
            ("schema_version", Value::Int(2)),
            ("version", Value::Str(env!("CARGO_PKG_VERSION").into())),
            ("platform", Value::Str(platform.into())),
            ("source_sha", Value::Str("a".repeat(40))),
            ("candidate", Value::Bool(true)),
            ("files", Value::Array(records)),
        ])
        .to_json();
        fs::write(source.join("package-manifest.json"), &manifest).unwrap();
        fs::set_permissions(
            source.join("package-manifest.json"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        Self {
            prefix: root.join("installed"),
            source,
            root,
            digest: hex::encode(&sha256(manifest.as_bytes())),
        }
    }
    fn run(&self, verb: &str, code: i32) -> Value {
        self.run_from(&self.source.join("obsync"), verb, code)
    }
    fn run_from(&self, binary: &std::path::Path, verb: &str, code: i32) -> Value {
        let mut cmd = Command::new(binary);
        cmd.args([
            verb,
            "--from",
            self.source.to_str().unwrap(),
            "--prefix",
            self.prefix.to_str().unwrap(),
            "--manifest-sha256",
            &self.digest,
            "-o",
            "json",
        ])
        .env_clear();
        if let Some(p) = std::env::var_os("LLVM_PROFILE_FILE") {
            cmd.env("LLVM_PROFILE_FILE", p);
        }
        let output = cmd.output().unwrap();
        assert_eq!(
            output.status.code(),
            Some(code),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(output.stderr.is_empty());
        json::parse(&output.stdout).unwrap()
    }
    fn bytes(&self, path: &std::path::Path) -> BTreeMap<String, Vec<u8>> {
        fs::read_dir(path)
            .unwrap()
            .map(|e| {
                let p = e.unwrap().path();
                (
                    p.file_name().unwrap().to_string_lossy().into_owned(),
                    fs::read(p).unwrap(),
                )
            })
            .collect()
    }
    fn sibling(&self, suffix: &str) -> PathBuf {
        PathBuf::from(format!("{}.{suffix}", self.prefix.display()))
    }
}
impl Drop for Lab {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn native_install_repeat_upgrade_and_uninstall_preserve_external_contexts() {
    let mut lab = Lab::new();
    let config = lab.root.join("retained-context-fixture");
    fs::write(&config, b"synthetic retained state").unwrap();
    lab.run("install", 0);
    let first = lab.bytes(&lab.prefix);
    lab.run("install", 0);
    assert_eq!(first, lab.bytes(&lab.prefix));
    let v = Command::new(lab.prefix.join("obsync"))
        .arg("--version")
        .env_clear()
        .output()
        .unwrap();
    assert!(v.status.success());
    assert!(String::from_utf8_lossy(&v.stdout).contains("native Rust"));
    let old = lab.prefix.clone();
    lab.prefix = lab.root.join("second");
    lab.run("install", 0);
    assert_eq!(
        fs::read(old.join("obsync")).unwrap(),
        fs::read(lab.prefix.join("obsync")).unwrap()
    );
    lab.run("uninstall", 0);
    lab.run("uninstall", 0);
    assert!(!lab.prefix.exists());
    assert!(!lab.sibling("removing").exists());
    lab.prefix = old;
    lab.run("uninstall", 0);
    assert!(!lab.prefix.exists());
    assert_eq!(fs::read(config).unwrap(), b"synthetic retained state");
    let binding = json::parse(&fs::read(lab.sibling("lock")).unwrap()).unwrap();
    assert_eq!(
        binding.get("manifest_sha256").unwrap().as_str(),
        Some(lab.digest.as_str())
    );
    assert_eq!(
        binding.get("target_digest").unwrap().as_str(),
        Some(hex::encode(&sha256(lab.prefix.to_str().unwrap().as_bytes())).as_str())
    );
}

#[test]
fn changed_package_or_installation_refuses_before_removing_anything() {
    for changed in [&b"changed"[..], &b"Synthetic license\n"[..]] {
        let lab = Lab::new();
        // The equal-length change isolates digest verification from size.
        fs::write(lab.source.join("LICENSE"), changed).unwrap();
        lab.run("install", 4);
        assert!(!lab.prefix.exists());
        assert!(!lab.sibling("lock").exists());
    }
    let mut lab = Lab::new();
    let caller = lab.root.join("caller");
    fs::copy(lab.source.join("obsync"), &caller).unwrap();
    // Never execute the changed package member; the unchanged caller must
    // reject even a self-consistent manifest describing another executable.
    let binary = lab.source.join("obsync");
    let mut changed = fs::read(&binary).unwrap();
    changed.extend(b"synthetic fixture");
    fs::write(&binary, &changed).unwrap();
    let mut manifest =
        json::parse(&fs::read(lab.source.join("package-manifest.json")).unwrap()).unwrap();
    if let Value::Object(fields) = &mut manifest {
        let (_, Value::Array(files)) = fields.iter_mut().find(|(key, _)| key == "files").unwrap()
        else {
            panic!("files array");
        };
        let record = files
            .iter_mut()
            .find(|r| r.get("name").and_then(Value::as_str) == Some("obsync"))
            .unwrap();
        *record = obj(vec![
            ("name", Value::Str("obsync".into())),
            ("size", Value::Int(changed.len() as i64)),
            ("sha256", Value::Str(hex::encode(&sha256(&changed)))),
        ]);
    }
    let raw = manifest.to_json();
    fs::write(lab.source.join("package-manifest.json"), &raw).unwrap();
    lab.digest = hex::encode(&sha256(raw.as_bytes()));
    lab.run_from(&caller, "install", 4);
    assert!(!lab.prefix.exists());
    assert!(!lab.sibling("lock").exists());
    let lab = Lab::new();
    lab.run("install", 0);
    fs::write(lab.prefix.join("unknown"), b"retain").unwrap();
    let before = lab.bytes(&lab.prefix);
    lab.run("uninstall", 4);
    assert_eq!(before, lab.bytes(&lab.prefix));
    fs::remove_file(lab.prefix.join("unknown")).unwrap();
    fs::write(lab.prefix.join("README.md"), b"changed").unwrap();
    let before = lab.bytes(&lab.prefix);
    lab.run("uninstall", 4);
    assert_eq!(before, lab.bytes(&lab.prefix));
    fs::remove_file(lab.prefix.join("README.md")).unwrap();
    let before = lab.bytes(&lab.prefix);
    lab.run("uninstall", 4);
    assert_eq!(before, lab.bytes(&lab.prefix));
}

#[test]
fn interrupted_copy_and_partial_removal_are_bound_to_exact_content() {
    let lab = Lab::new();
    lab.run("install", 0);
    fs::remove_dir_all(&lab.prefix).unwrap();
    let pending = lab.sibling("pending");
    fs::DirBuilder::new().mode(0o700).create(&pending).unwrap();
    let raw = fs::read(lab.source.join("package-manifest.json")).unwrap();
    fs::write(pending.join("package-manifest.json"), &raw[..30]).unwrap();
    fs::set_permissions(
        pending.join("package-manifest.json"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    lab.run("install", 0);
    assert!(!pending.exists());
    let removing = lab.sibling("removing");
    fs::rename(&lab.prefix, &removing).unwrap();
    fs::remove_file(removing.join("README.md")).unwrap();
    lab.run("uninstall", 0);
    assert!(!removing.exists());
    fs::DirBuilder::new().mode(0o700).create(&pending).unwrap();
    fs::write(pending.join("package-manifest.json"), b"wrong").unwrap();
    fs::set_permissions(
        pending.join("package-manifest.json"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    let before = lab.bytes(&pending);
    lab.run("install", 4);
    assert_eq!(before, lab.bytes(&pending));
}

#[test]
fn native_install_lock_and_file_custody_are_enforced() {
    let lab = Lab::new();
    lab.run("install", 0);
    let lock = File::options()
        .read(true)
        .write(true)
        .open(lab.sibling("lock"))
        .unwrap();
    lock.lock().unwrap();
    let before = lab.bytes(&lab.prefix);
    lab.run("uninstall", 5);
    assert_eq!(before, lab.bytes(&lab.prefix));
    drop(lock);
    fs::set_permissions(lab.prefix.join("obsync"), fs::Permissions::from_mode(0o755)).unwrap();
    lab.run("uninstall", 4);
    assert!(lab.prefix.exists());
}

#[test]
fn torn_binding_resumes_only_before_effects_and_stays_bound_after_removal() {
    let lab = Lab::new();
    lab.run("install", 0);
    let record = fs::read(lab.sibling("lock")).unwrap();
    lab.run("uninstall", 0);
    fs::write(lab.sibling("lock"), &record[..30]).unwrap();
    lab.run("install", 0);
    assert_eq!(fs::read(lab.sibling("lock")).unwrap(), record);
    let before = lab.bytes(&lab.prefix);
    fs::write(lab.sibling("lock"), &record[..30]).unwrap();
    lab.run("uninstall", 4);
    assert_eq!(lab.bytes(&lab.prefix), before);
    fs::write(lab.sibling("lock"), record).unwrap();
    lab.run("uninstall", 0);
    fs::write(lab.sibling("lock"), b"different binding").unwrap();
    lab.run("install", 4);
    assert!(!lab.prefix.exists());
}

#[test]
fn source_cannot_alias_a_target_or_its_parent() {
    let mut lab = Lab::new();
    let before = lab.bytes(&lab.source);
    lab.prefix = lab.source.join("nested");
    lab.run("install", 4);
    assert_eq!(lab.bytes(&lab.source), before);
    // This branch executes on a case-insensitive native filesystem; no mock
    // claims to exercise APFS/NTFS aliasing on a case-sensitive Linux volume.
    let alias = lab.root.join("SOURCE");
    if alias.exists() {
        lab.prefix = alias.join("nested");
        lab.run("install", 4);
        assert_eq!(lab.bytes(&lab.source), before);
        lab.prefix = alias;
        lab.run("install", 4);
        assert_eq!(lab.bytes(&lab.source), before);
    }
}
