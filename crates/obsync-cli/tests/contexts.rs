#![forbid(unsafe_code)]
#![cfg(unix)]

use obsync_core::{
    hex,
    json::{self, Value},
    sha256::sha256,
};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    os::unix::fs::{DirBuilderExt, PermissionsExt, symlink},
    path::PathBuf,
    process::{Command, Output},
    sync::atomic::{AtomicU64, Ordering},
};

struct Lab {
    root: PathBuf,
    config: PathBuf,
}
impl Lab {
    fn new() -> Self {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "obsync-context-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        Self {
            config: root.join("config"),
            root,
        }
    }
    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_obsync"));
        command
            .args(args)
            .args(["--config-dir", self.config.to_str().unwrap()])
            .env_clear();
        // Preserve only the compiler's coverage destination for real child processes.
        if let Some(path) = std::env::var_os("LLVM_PROFILE_FILE") {
            command.env("LLVM_PROFILE_FILE", path);
        }
        command
    }
    fn raw(&self, args: &[&str]) -> Output {
        self.command(args).output().unwrap()
    }
    fn run(&self, args: &[&str], code: i32) -> Value {
        let mut command = self.command(args);
        command.args(["-o", "json"]);
        let result = command.output().unwrap();
        assert_eq!(
            result.status.code(),
            Some(code),
            "{}",
            String::from_utf8_lossy(&result.stdout)
        );
        assert!(result.stderr.is_empty());
        assert!(result.stdout.len() <= 65536);
        json::parse(&result.stdout).unwrap()
    }
    fn plan(&self, command: &[&str]) -> Value {
        let result = self.run(command, 0);
        assert_eq!(result.get("state").and_then(Value::as_str), Some("planned"));
        result.get("data").unwrap().get("plan").unwrap().clone()
    }
    fn plan_file(&self, plan: &Value) -> PathBuf {
        let path = self.root.join("plan.json");
        fs::write(&path, plan.to_json()).unwrap();
        path
    }
    fn apply(&self, plan: &Value, code: i32) -> Value {
        let path = self.plan_file(plan);
        self.run(
            &[
                "apply",
                "-f",
                path.to_str().unwrap(),
                "--expect-digest",
                plan.get("digest").unwrap().as_str().unwrap(),
            ],
            code,
        )
    }
    fn add(&self, name: &str) -> Value {
        let p = self.plan(&[
            "config",
            "set-context",
            name,
            "--server",
            "https://example.invalid",
        ]);
        self.apply(&p, 0);
        p
    }
    fn bytes(&self) -> BTreeMap<String, Vec<u8>> {
        if !self.config.exists() {
            return BTreeMap::new();
        }
        fs::read_dir(&self.config)
            .unwrap()
            .map(|e| {
                let p = e.unwrap().path();
                (
                    p.file_name().unwrap().to_string_lossy().into_owned(),
                    fs::read(&p).unwrap(),
                )
            })
            .collect()
    }
    fn disk_state(&self) -> Value {
        let mut states = Vec::new();
        for n in [0, 1] {
            let p = self.config.join(format!("contexts.{n}"));
            if !p.exists() {
                continue;
            }
            let b = fs::read(p).unwrap();
            if b.is_empty() {
                continue;
            }
            assert!(b.starts_with(b"OBSYNC-CONTEXT-1\n"));
            let start = b"OBSYNC-CONTEXT-1\n".len();
            let length = u32::from_be_bytes(b[start..start + 4].try_into().unwrap()) as usize;
            let end = start + 4 + length;
            assert_eq!(b.len(), end + 32);
            assert_eq!(sha256(&b[..end]).as_slice(), &b[end..]);
            states.push(json::parse(&b[start + 4..end]).unwrap());
        }
        states
            .into_iter()
            .max_by_key(|s| s.get("revision").unwrap().as_u64().unwrap())
            .unwrap()
    }
}
impl Drop for Lab {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn data(v: &Value) -> &Value {
    v.get("data").unwrap()
}
fn replace(v: &mut Value, key: &str, new: Value) {
    if let Value::Object(p) = v {
        *p.iter_mut().find(|(k, _)| k == key).unwrap() = (key.into(), new);
    }
}
fn rehash(plan: &mut Value) {
    let pairs = plan
        .as_object()
        .unwrap()
        .iter()
        .filter(|(k, _)| k != "digest")
        .cloned()
        .collect();
    let digest = hex::encode(&sha256(Value::Object(pairs).to_json().as_bytes()));
    replace(plan, "digest", Value::Str(digest));
}

#[test]
fn public_context_journey_has_durable_receipts_and_readable_human_output() {
    let lab = Lab::new();
    assert!(
        data(&lab.run(&["get", "contexts"], 0))
            .get("items")
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty()
    );
    let plan = lab.plan(&[
        "config",
        "set-context",
        "lab",
        "--server",
        "https://EXAMPLE.invalid:443/",
    ]);
    assert!(!lab.config.exists(), "planning must not create storage");
    assert_eq!(
        plan.get("parameters")
            .unwrap()
            .get("origin")
            .unwrap()
            .as_str(),
        Some("https://example.invalid")
    );
    lab.apply(&plan, 0);
    let snapshot = lab.bytes();
    assert_eq!(
        data(&lab.apply(&plan, 0)).get("replayed"),
        Some(&Value::Bool(true))
    );
    assert_eq!(lab.bytes(), snapshot);
    let state = lab.disk_state();
    assert_eq!(state.get("revision"), Some(&Value::Int(1)));
    assert_eq!(state.get("receipts").unwrap().as_array().unwrap().len(), 1);
    let plan = lab.plan(&["config", "use-context", "lab"]);
    lab.apply(&plan, 0);
    let out = lab.raw(&["config", "current-context"]);
    assert!(out.status.success());
    assert_eq!(out.stdout, b"lab\n");
    let out = lab.raw(&["get", "contexts"]);
    let text = String::from_utf8(out.stdout).unwrap();
    assert!(
        text.contains("CURRENT")
            && text.contains("*        lab")
            && text.contains("https://example.invalid")
    );
    assert!(text.lines().all(|l| l.len() <= 80));
    let before = lab.bytes();
    lab.run(&["doctor"], 0);
    lab.run(&["config", "recover"], 0);
    assert_eq!(before, lab.bytes());
    let plan = lab.plan(&["config", "delete-context", "lab"]);
    lab.apply(&plan, 0);
    let state = lab.disk_state();
    assert_eq!(state.get("revision"), Some(&Value::Int(3)));
    assert_eq!(state.get("current"), Some(&Value::Null));
    assert!(
        state
            .get("contexts")
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty()
    );
    lab.run(&["config", "current-context"], 6);
}

#[test]
fn changed_stale_expired_and_wrong_target_plans_leave_storage_unchanged() {
    let lab = Lab::new();
    let a = lab.plan(&[
        "config",
        "set-context",
        "first",
        "--server",
        "https://example.invalid",
    ]);
    let b = lab.plan(&[
        "config",
        "set-context",
        "second",
        "--server",
        "https://example.invalid",
    ]);
    let mut changed = a.clone();
    replace(&mut changed, "id", Value::Str("f".repeat(32)));
    lab.apply(&changed, 5);
    assert!(!lab.config.exists());
    let mut foreign = a.clone();
    replace(&mut foreign, "config_target", Value::Str("f".repeat(64)));
    rehash(&mut foreign);
    lab.apply(&foreign, 2);
    assert!(!lab.config.exists());
    lab.apply(&a, 0);
    let before = lab.bytes();
    lab.apply(&b, 5);
    assert_eq!(before, lab.bytes());
    let mut expired = a.clone();
    replace(&mut expired, "created_at", Value::Int(0));
    replace(&mut expired, "expires_at", Value::Int(300000));
    rehash(&mut expired);
    lab.apply(&expired, 5);
    assert_eq!(before, lab.bytes());
    lab.run(
        &[
            "config",
            "set-context",
            "first",
            "--server",
            "https://different.invalid",
        ],
        5,
    );
    assert_eq!(before, lab.bytes());
}

#[test]
fn malformed_origins_and_names_are_refused_before_any_configuration_write() {
    let lab = Lab::new();
    for origin in [
        "http://example.invalid",
        "https://user:secret@example.invalid",
        "https://example.invalid/path",
        "https://example.invalid?token=fixture",
        "https://example.invalid/#x",
        "https://127.1",
        "https://0177.0.0.1",
        "https://0x7f000001",
        "https://example.1",
        "https://[0:0:0:0:0:0:0:1]",
        "https://example.invalid:0443",
        "https://example.invalid:65536",
        "https://example.invalid//",
        "https://-example.invalid",
    ] {
        lab.run(&["config", "set-context", "lab", "--server", origin], 2);
    }
    for name in ["A", "../fixture", "-name", "with space"] {
        lab.run(
            &[
                "config",
                "set-context",
                name,
                "--server",
                "https://example.invalid",
            ],
            2,
        );
    }
    for origin in [
        "https://[::1]",
        "https://[::ffff:c000:201]",
        "https://127.0.0.1:8443",
    ] {
        lab.plan(&["config", "set-context", "lab", "--server", origin]);
    }
    assert!(!lab.config.exists());
}

#[test]
fn privacy_links_and_unknown_entries_refuse_with_unchanged_file_bytes() {
    let lab = Lab::new();
    lab.add("lab");
    let before = lab.bytes();
    let slot = lab.config.join("contexts.1");
    fs::set_permissions(&slot, fs::Permissions::from_mode(0o640)).unwrap();
    lab.run(&["doctor"], 4);
    assert_eq!(before, lab.bytes());
    fs::set_permissions(&slot, fs::Permissions::from_mode(0o600)).unwrap();
    let link = lab.root.join("hardlink");
    fs::hard_link(&slot, &link).unwrap();
    lab.run(&["doctor"], 4);
    assert_eq!(before, lab.bytes());
    fs::remove_file(link).unwrap();
    fs::write(lab.config.join("unknown"), b"fixture").unwrap();
    let unknown = lab.bytes();
    lab.run(&["config", "recover"], 4);
    assert_eq!(unknown, lab.bytes());
    fs::remove_file(lab.config.join("unknown")).unwrap();
    let real = lab.root.join("actual");
    fs::rename(&lab.config, &real).unwrap();
    symlink(&real, &lab.config).unwrap();
    lab.run(&["doctor"], 4);
    fs::remove_file(&lab.config).unwrap();
    fs::rename(real, &lab.config).unwrap();
    assert_eq!(before, lab.bytes());
}

#[test]
fn constructed_interrupted_body_requires_recovery_and_retains_the_previous_receipt() {
    let lab = Lab::new();
    let add = lab.add("lab");
    let previous = lab.disk_state();
    let use_plan = lab.plan(&["config", "use-context", "lab"]);
    lab.apply(&use_plan, 0);
    let slot = lab.config.join("contexts.0");
    let bytes = fs::read(&slot).unwrap();
    // Model the exact on-disk body-before-seal boundary, without a product hook.
    fs::write(&slot, &bytes[..bytes.len() - 32]).unwrap();
    File::open(&slot).unwrap().sync_all().unwrap();
    let before = lab.bytes();
    lab.run(&["doctor"], 10);
    assert_eq!(before, lab.bytes());
    let result = lab.run(&["config", "recover"], 0);
    assert_eq!(data(&result).get("revision"), Some(&Value::Int(1)));
    assert_eq!(lab.disk_state(), previous);
    assert_eq!(
        data(&lab.apply(&add, 0)).get("replayed"),
        Some(&Value::Bool(true))
    );
    lab.apply(&use_plan, 0);
    assert_eq!(lab.disk_state().get("revision"), Some(&Value::Int(2)));
}

#[test]
fn corrupt_sealed_record_is_never_discarded_by_doctor_or_recovery() {
    let lab = Lab::new();
    lab.add("lab");
    let plan = lab.plan(&["config", "use-context", "lab"]);
    lab.apply(&plan, 0);
    let slot = lab.config.join("contexts.0");
    let mut bytes = fs::read(&slot).unwrap();
    let last = bytes.len() - 1;
    bytes[last] ^= 1;
    fs::write(&slot, bytes).unwrap();
    let before = lab.bytes();
    lab.run(&["doctor"], 4);
    lab.run(&["config", "recover"], 4);
    assert_eq!(before, lab.bytes());
}

#[test]
fn actual_os_lock_and_competing_processes_preserve_single_application() {
    let lab = Lab::new();
    lab.add("lab");
    let plan = lab.plan(&["config", "use-context", "lab"]);
    let before = lab.bytes();
    let lock = File::options()
        .read(true)
        .write(true)
        .open(lab.config.join("contexts.lock"))
        .unwrap();
    lock.try_lock().unwrap();
    lab.run(&["doctor"], 5);
    lab.apply(&plan, 5);
    assert_eq!(before, lab.bytes());
    drop(lock);
    let path = lab.plan_file(&plan);
    let args = [
        "apply",
        "-f",
        path.to_str().unwrap(),
        "--expect-digest",
        plan.get("digest").unwrap().as_str().unwrap(),
        "-o",
        "json",
    ];
    let mut a = lab.command(&args);
    let mut b = lab.command(&args);
    let a = a
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let b = b
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    for child in [a, b] {
        let out = child.wait_with_output().unwrap();
        assert!(
            [Some(0), Some(5)].contains(&out.status.code()),
            "{}",
            String::from_utf8_lossy(&out.stdout)
        );
        assert!(out.stderr.is_empty());
        json::parse(&out.stdout).unwrap();
    }
    assert_eq!(
        data(&lab.apply(&plan, 0)).get("replayed"),
        Some(&Value::Bool(true))
    );
    let state = lab.disk_state();
    assert_eq!(state.get("revision"), Some(&Value::Int(2)));
    assert_eq!(state.get("receipts").unwrap().as_array().unwrap().len(), 2);
}
