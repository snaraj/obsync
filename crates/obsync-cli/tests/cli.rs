#![forbid(unsafe_code)]

use obsync_core::json::{self, Value};
use std::process::{Command, Output};

fn invoke(args: &[&str]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_obsync"));
    command.args(args).env_clear();
    if let Some(path) = std::env::var_os("LLVM_PROFILE_FILE") {
        command.env("LLVM_PROFILE_FILE", path);
    }
    command.output().unwrap()
}
fn document(args: &[&str], code: i32) -> Value {
    let output = invoke(args);
    assert_eq!(
        output.status.code(),
        Some(code),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    assert!(output.stdout.len() <= 65536);
    let value = json::parse(&output.stdout).expect("exactly one valid JSON value");
    assert_eq!(value.get("schema_version"), Some(&Value::Int(1)));
    value
}

#[test]
fn fresh_process_help_is_readable_without_runtime_or_configuration() {
    for args in [vec![], vec!["help"], vec!["--help"], vec!["-h"]] {
        let output = invoke(&args);
        assert!(output.status.success());
        assert!(output.stderr.is_empty());
        let text = String::from_utf8(output.stdout).unwrap();
        assert!(text.contains("Usage:\n  obsync COMMAND"));
        assert!(text.contains("context list"));
        assert!(!text.contains("config get-contexts"));
        assert!(!text.contains('\u{1b}'));
        assert!(!text.starts_with('{'));
    }
}

#[test]
fn command_help_and_help_command_agree() {
    for words in [
        vec!["config", "use-context"],
        vec!["config", "set-context"],
        vec!["apply"],
        vec!["version"],
        vec!["config"],
    ] {
        let mut suffix = words.clone();
        suffix.push("--help");
        let mut prefix = vec!["help"];
        prefix.extend(words);
        let a = invoke(&suffix);
        let b = invoke(&prefix);
        assert!(a.status.success());
        assert!(b.status.success());
        assert_eq!(a.stdout, b.stdout);
        assert!(String::from_utf8(a.stdout).unwrap().contains("Usage:"));
    }
}

#[test]
fn explicit_machine_stream_survives_usage_errors() {
    for args in [
        vec!["nonsense", "-o", "json"],
        vec!["version", "--unknown", "--output=json"],
        vec!["version", "-o", "json", "--output", "json"],
        vec!["version", "extra", "-o=json"],
    ] {
        let value = document(&args, 2);
        assert_eq!(value.get("state").and_then(Value::as_str), Some("refused"));
        assert_eq!(
            value.get("error").unwrap().get("exit_code"),
            Some(&Value::Int(2))
        );
    }
}

#[test]
fn human_errors_use_stderr_without_echoing_arguments() {
    let output = invoke(&["unrecognized-fixture-value"]);
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    let error = String::from_utf8(output.stderr).unwrap();
    assert!(error.starts_with("error:"));
    assert!(!error.contains("unrecognized-fixture-value"));
    #[cfg(unix)]
    for (args, error_stream) in [(&["version"][..], false), (&["unknown-fixture"][..], true)] {
        use std::os::{fd::OwnedFd, unix::net::UnixStream};
        let (writer, reader) = UnixStream::pair().unwrap();
        drop(reader);
        let mut command = Command::new(env!("CARGO_BIN_EXE_obsync"));
        command.args(args).env_clear();
        let stream = std::process::Stdio::from(OwnedFd::from(writer));
        if error_stream {
            command.stderr(stream);
        } else {
            command.stdout(stream);
        }
        let output = command.output().unwrap();
        assert_eq!(output.status.code(), Some(9));
        assert!(output.stdout.is_empty() && output.stderr.is_empty());
    }
}

#[test]
fn version_aliases_and_global_flag_positions_match() {
    for args in [
        vec!["--version", "-o", "json"],
        vec!["-o=json", "version"],
        vec!["version", "--output=jsonl"],
    ] {
        let value = document(&args, 0);
        let data = value.get("data").unwrap();
        assert_eq!(
            data.get("version").and_then(Value::as_str),
            Some(env!("CARGO_PKG_VERSION"))
        );
        assert_eq!(
            data.get("runtime").and_then(Value::as_str),
            Some("native Rust")
        );
    }
}

#[test]
fn search_explain_and_capabilities_describe_the_same_catalog() {
    document(&["cli", "search", &"a".repeat(256), "-o", "json"], 0);
    document(&["cli", "search", &"a".repeat(257), "-o", "json"], 2);
    let result = document(&["cli", "search", "context", "-o", "json"], 0);
    let items = result
        .get("data")
        .unwrap()
        .get("items")
        .unwrap()
        .as_array()
        .unwrap();
    assert!(!items.is_empty());
    let caps = document(&["capabilities", "-o", "json"], 0);
    let entries = caps
        .get("data")
        .unwrap()
        .get("operations")
        .unwrap()
        .as_array()
        .unwrap();
    for entry in entries {
        for field in [
            "operation",
            "command",
            "summary",
            "input_schema",
            "effect",
            "availability",
            "repeatability",
            "completion",
            "verification",
            "errors",
        ] {
            assert!(
                entry.get(field).is_some(),
                "missing public command field {field}"
            );
        }
    }
    for item in items {
        let id = item.get("operation").unwrap().as_str().unwrap();
        let schema = document(&["explain", id, "-o", "json"], 0);
        assert_eq!(
            schema.get("data").unwrap().get("command"),
            item.get("command")
        );
        assert!(
            entries
                .iter()
                .any(|entry| entry.get("operation") == item.get("operation"))
        );
        assert!(schema.get("data").unwrap().get("output_schema").is_some());
    }
}

#[test]
fn deferred_workflows_refuse_without_loading_any_configuration() {
    for args in [
        vec!["get", "devices"],
        vec!["auth", "login"],
        vec!["export", "open"],
        vec!["setup"],
        vec!["mcp", "serve"],
    ] {
        let mut args = args;
        args.extend(["--config-dir", "/no-such-fixture", "-o", "json"]);
        let result = document(&args, 6);
        assert_eq!(
            result.get("verification").unwrap().get("server_contacted"),
            Some(&Value::Bool(false))
        );
    }
}

#[test]
fn shell_metacharacters_are_data_and_never_evaluated() {
    let result = document(&["cli", "search", "$(fixture);`fixture`", "-o", "json"], 0);
    assert_eq!(
        result.get("data").unwrap().get("items"),
        Some(&Value::Array(vec![]))
    );
}

#[test]
fn unsupported_flags_and_missing_values_refuse() {
    for args in [
        vec!["version", "--output", "yaml"],
        vec!["version", "--help=true"],
        vec!["version", "--filename", "fixture"],
        vec!["cli", "search"],
        vec!["version", "--output"],
        vec!["version", "--config-dir", ""],
        vec!["version", "--config-dir", "-synthetic"],
        vec!["help", "--server", "https://example.invalid"],
        vec!["config", "--server", "https://example.invalid"],
        vec!["version", "--server", "https://example.invalid", "--help"],
        vec!["help", "unknown-fixture-topic"],
        vec!["get", "contexts"],
    ] {
        assert_eq!(invoke(&args).status.code(), Some(2));
    }
}

#[test]
fn positional_flag_text_cannot_change_output_or_choose_an_ambiguous_schema() {
    let output = invoke(&["cli", "search", "--output", "human", "--", "-o=json"]);
    assert!(output.status.success());
    assert!(!output.stdout.starts_with(b"{"));
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .contains("No matching operations.")
    );
    let malformed = invoke(&["version", "--unknown", "--", "-o=json"]);
    assert_eq!(malformed.status.code(), Some(2));
    assert!(malformed.stdout.is_empty());
    assert!(
        String::from_utf8(malformed.stderr)
            .unwrap()
            .starts_with("error:")
    );
    document(&["schema", "config", "-o", "json"], 2);
    let output = invoke(&["config", "use-context", "lab", "--help"]);
    assert!(output.status.success());
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .contains("Select a saved server.")
    );
}

#[test]
fn documented_commands_accept_help_without_accessing_targets() {
    for args in [
        vec![
            "config",
            "set-context",
            "fixture",
            "--server",
            "https://example.invalid",
            "--help",
        ],
        vec![
            "apply",
            "-f",
            "missing-fixture.json",
            "--expect-digest",
            "0000000000000000000000000000000000000000000000000000000000000000",
            "--help",
        ],
    ] {
        let output = invoke(&args);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8(output.stdout).unwrap().contains("Usage:"));
    }
}

#[test]
fn aggregate_arguments_respect_the_advertised_input_budget() {
    // Help accepts these global flags without reading paths. Their individual
    // values fit; only the aggregate argument budget must reject the command.
    let value = "a".repeat(8192);
    document(&["help", "--config-dir", &value, "-o", "json"], 0);
    document(
        &["help", "--config-dir", &"a".repeat(8193), "-o", "json"],
        2,
    );
    document(
        &[
            "help",
            "--config-dir",
            &value,
            "--windows-trust",
            &value,
            "-o",
            "json",
        ],
        2,
    );
}

#[cfg(unix)]
#[test]
fn malformed_native_argument_is_a_usage_error_not_a_panic() {
    use std::os::unix::ffi::OsStringExt;
    let output = Command::new(env!("CARGO_BIN_EXE_obsync"))
        .arg(std::ffi::OsString::from_vec(vec![0xff]))
        .args(["-o", "json"])
        .env_clear()
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stderr.is_empty());
    assert!(json::parse(&output.stdout).is_ok());
}
