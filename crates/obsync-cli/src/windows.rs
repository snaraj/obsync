#![forbid(unsafe_code)]

use crate::{Error, Result, args::Args, context, custody};
use obsync_core::json::{self, Value, obj};
use std::{
    fs::{File, OpenOptions},
    os::windows::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Instant,
};

pub struct Windows {
    executable: PathBuf,
    held: File,
    identity: crate::windows_identity::Identity,
    command: String,
}
pub fn setup() -> Result<Value> {
    // Quote only compiled, fixed helper code for CreateProcessW, then encode
    // that argument string as a PowerShell literal. No request input is code.
    let mut quoted = String::from("\"");
    let mut backslashes = 0;
    for ch in include_str!("../../../cli/windows-files.ps1").chars() {
        if ch == '\\' {
            backslashes += 1;
            continue;
        }
        quoted.extend(std::iter::repeat_n(
            '\\',
            if ch == '"' {
                2 * backslashes + 1
            } else {
                backslashes
            },
        ));
        quoted.push(ch);
        backslashes = 0;
    }
    quoted.extend(std::iter::repeat_n('\\', 2 * backslashes));
    quoted.push('"');
    let arguments = format!("-NoLogo -NoProfile -NonInteractive -Command {quoted}");
    if arguments.encode_utf16().count() > 30000 {
        return Err(custody::unsafe_path());
    }
    let script = include_str!("windows-setup.ps1").replace(
        "__HELPER_ARGUMENTS__",
        &format!("'{}'", arguments.replace('\'', "''")),
    );
    Ok(obj(vec![
        ("script", crate::s(script)),
        (
            "instruction",
            crate::s(
                "Run the fixed script in an independently trusted OS PowerShell 5.1 session. Retain its receipt path and digest.",
            ),
        ),
        ("configuration_changed", Value::Bool(false)),
    ]))
}
impl Windows {
    pub fn new(args: &Args, _deadline: Instant) -> Result<Self> {
        let path = args.get("windows-trust").ok_or_else(|| {
            Error::new(
                "trusted_powershell_required",
                "Supply the independently trusted OS PowerShell receipt and its digest.",
                4,
            )
        })?;
        let expected = args.get("windows-trust-sha256").ok_or_else(|| {
            Error::input("Supply --windows-trust-sha256 with the receipt digest.")
        })?;
        let path = custody::exact(path, false)?;
        let mut file = custody::open(&path, false, false)?;
        let raw = custody::bounded(&mut file, 16384)?;
        if context::digest(&raw) != expected {
            return Err(Error::new(
                "windows_trust_digest",
                "The Windows trust receipt differs from its supplied digest; repeat trusted setup.",
                4,
            ));
        }
        let receipt = json::parse(&raw).map_err(|_| custody::unsafe_path())?;
        context::closed(&receipt, &["schema_version", "directory", "powershell"])?;
        if context::number(&receipt, "schema_version")? != 1 {
            return Err(custody::unsafe_path());
        }
        let directory = custody::exact(context::text(&receipt, "directory")?, false)?;
        if directory.join("powershell.json") != path {
            return Err(Error::new(
                "windows_trust_directory",
                "The Windows trust receipt is outside its recorded directory; repeat trusted setup.",
                4,
            ));
        }
        let code = context::field(&receipt, "powershell")?;
        context::closed(code, &["path", "sha256"])?;
        let executable = custody::exact(context::text(code, "path")?, false)?;
        let spelling = executable.to_str().unwrap();
        if !spelling.ends_with("\\System32\\WindowsPowerShell\\v1.0\\powershell.exe") {
            return Err(Error::new(
                "windows_trust_path",
                "The Windows trust receipt does not name the expected OS PowerShell path.",
                4,
            ));
        }
        // This explicitly trusted OS executable may have component-store links.
        // Hold it without write/delete sharing through every helper invocation.
        let mut held = OpenOptions::new()
            .read(true)
            .custom_flags(0x200000)
            .share_mode(1)
            .open(&executable)
            .map_err(|_| custody::unsafe_path())?;
        let identity =
            crate::windows_identity::identity(&held).map_err(|_| custody::unsafe_path())?;
        if identity.attributes & 0x410 != 0
            || !held.metadata().map_err(custody::io_error)?.is_file()
            || context::digest(&custody::bounded(&mut held, 32 * 1024 * 1024)?)
                != context::text(code, "sha256")?
        {
            return Err(Error::new(
                "windows_trust_executable",
                "The trusted OS PowerShell executable failed its file type or digest check; repeat trusted setup.",
                4,
            ));
        }
        let source = include_str!("../../../cli/windows-files.ps1");
        // -EncodedCommand expands this fixed helper beyond CreateProcessW's
        // 32767-character limit. Pass the literal script as one quoted argument.
        // Even doubling every character for quoting leaves room for the fixed
        // flags and the bounded executable path. No request data is interpolated.
        if source.encode_utf16().count() > 15000 {
            return Err(Error::new(
                "native_helper_budget",
                "The fixed OS helper exceeds its command-line budget.",
                4,
            ));
        }
        Ok(Self {
            executable,
            held,
            identity,
            command: source.into(),
        })
    }
    fn call(
        &self,
        op: &str,
        path: &Path,
        destination: Option<&Path>,
        deadline: Instant,
    ) -> Result<()> {
        custody::exact(path.to_str().ok_or_else(custody::unsafe_path)?, false)?;
        let executable = self.executable.to_str().unwrap();
        let system = executable
            .strip_suffix("\\WindowsPowerShell\\v1.0\\powershell.exe")
            .ok_or_else(custody::unsafe_path)?;
        let root = system
            .strip_suffix("\\System32")
            .ok_or_else(custody::unsafe_path)?;
        if crate::windows_identity::identity(&self.held).map_err(|_| custody::unsafe_path())?
            != self.identity
        {
            return Err(custody::unsafe_path());
        }
        let request = obj(vec![
            ("v", Value::Int(1)),
            ("op", crate::s(op)),
            ("path", crate::s(path.to_str().unwrap())),
            (
                "destination",
                crate::s(destination.and_then(Path::to_str).unwrap_or("")),
            ),
        ])
        .to_json();
        let mut command = Command::new(&self.executable);
        command
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &self.command,
            ])
            .env_clear()
            .env("SystemRoot", root)
            .env(
                "PSModulePath",
                format!("{system}\\WindowsPowerShell\\v1.0\\Modules"),
            )
            .current_dir(system)
            .stdin(Stdio::piped());
        let output = crate::process::capture(command, Some(request.into_bytes()), deadline)?;
        if output != b"{\"v\":1,\"ok\":true}\r\n" && output != b"{\"v\":1,\"ok\":true}\n" {
            return Err(Error::new(
                "native_helper_response",
                "The fixed OS helper returned an unexpected custody receipt.",
                4,
            ));
        }
        Ok(())
    }
    pub fn inspect(&self, path: &Path, deadline: Instant) -> Result<()> {
        self.call("inspect", path, None, deadline)
    }
    pub fn publish(&self, from: &Path, to: &Path, deadline: Instant) -> Result<()> {
        self.call("publish", from, Some(to), deadline)
    }
    pub fn mkdir(&self, path: &Path, deadline: Instant) -> Result<()> {
        self.call("mkdir", path, None, deadline)
    }
    pub fn create(&self, path: &Path, deadline: Instant) -> Result<()> {
        if custody::present(path)?.is_some() {
            self.inspect(path, deadline)?;
            return Ok(());
        }
        let stage = PathBuf::from(format!(
            "{}.obsync-create",
            path.to_str().ok_or_else(custody::unsafe_path)?
        ));
        if custody::present(&stage)?.is_none() {
            self.call("create", &stage, None, deadline)?;
        }
        self.inspect(&stage, deadline)?;
        let file = custody::open(&stage, false, false)?;
        if file.metadata().map_err(custody::io_error)?.len() != 0 {
            return Err(custody::unsafe_path());
        }
        drop(file);
        self.call("publish", &stage, Some(path), deadline)
    }
}
