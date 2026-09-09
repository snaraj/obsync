//! The `obsyncd` command line: `serve` (the default), `check`, `export`, and
//! `version`.
//!
//! Configuration is environment only (`docs/architecture.md` 9), so the
//! command line stays this small on purpose: one verb per operating task and
//! no flag that could weaken a security behavior.
#![forbid(unsafe_code)]

pub mod check;
pub mod export;
pub mod serve;

use std::path::PathBuf;

use crate::config::Config;
use crate::log::{Log, Val};
use crate::storage::{StoreError, error_fields};
use crate::types::DomainId;

/// What `obsyncd help` prints, on standard error.
pub const USAGE: &str = "\
Usage:
  obsyncd [serve]    serve the sync API, dashboard, and plugin bundle
  obsyncd check      verify every stored chunk and journal frame
  obsyncd export --domain <32hex> --key <64hex> --out <dir>
  obsyncd version

Configuration is environment only; docs/architecture.md lists every variable.";

/// Run one subcommand. Returns the process exit code.
///
/// Standard output carries exactly one thing, the version line; everything
/// else is a structured log line on standard error.
pub fn run(args: &[String]) -> i32 {
    match args.first().map(String::as_str) {
        None | Some("serve") => serve::run(),
        Some("version") => {
            println!("obsyncd {}", env!("CARGO_PKG_VERSION"));
            0
        }
        Some("help" | "--help" | "-h") => {
            eprintln!("{USAGE}");
            0
        }
        Some("check") => with_config(|cfg| {
            let log = Log::new(cfg.log_level);
            report(check::run(&cfg, &log), "check", &log)
        }),
        Some("export") => match ExportArgs::parse(&args[1..]) {
            Ok(a) => with_config(|cfg| {
                let log = Log::new(cfg.log_level);
                report(export::run(&cfg, &a.domain, &a.key, &a.out), "export", &log)
            }),
            Err(e) => {
                eprintln!("obsyncd export: {e}\n{USAGE}");
                2
            }
        },
        Some(other) => {
            eprintln!(
                "obsyncd: unknown subcommand: {}\n{USAGE}",
                word_class(other)
            );
            2
        }
    }
}

/// Parse the environment once for a subcommand that needs it.
fn with_config(job: impl FnOnce(Config) -> i32) -> i32 {
    match Config::from_env() {
        Ok(cfg) => job(cfg),
        Err(e) => {
            eprintln!("obsyncd: configuration: {e}");
            2
        }
    }
}

/// Print a report, or state the refusal and its code, and give the exit code.
fn report<T: Report>(outcome: Result<T, StoreError>, job: &'static str, log: &Log) -> i32 {
    match outcome {
        Ok(report) => {
            report.print();
            0
        }
        Err(e) => {
            let mut fields = vec![("job", Val::word(job)), ("decision", Val::word(e.code()))];
            fields.extend(error_fields(&e));
            log.error("cli_failed", &fields);
            eprintln!("obsyncd {job}: {e}");
            1
        }
    }
}

/// What a subcommand's report can do: print itself for an operator.
trait Report {
    /// Print the counts on standard output.
    fn print(&self);
}

impl Report for check::CheckReport {
    fn print(&self) {
        check::CheckReport::print(self);
    }
}

impl Report for export::ExportReport {
    fn print(&self) {
        export::ExportReport::print(self);
    }
}

/// An unrecognized subcommand, reduced to a class rather than echoed: a
/// process argument is untrusted text and this goes to a terminal.
fn word_class(arg: &str) -> &'static str {
    if arg.starts_with('-') {
        "not a flag this command takes"
    } else {
        "no such subcommand"
    }
}

/// `export --domain <hex> --key <hex> --out <dir>`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExportArgs {
    /// Which domain to reconstruct.
    pub domain: DomainId,
    /// The operator-supplied domain key. Never logged, never stored.
    pub key: [u8; 32],
    /// Where the plaintext is written.
    pub out: PathBuf,
}

impl ExportArgs {
    /// Parse the three required flags in any order.
    ///
    /// # Errors
    /// A human message naming the first flag that is missing or malformed.
    pub fn parse(args: &[String]) -> Result<Self, String> {
        let mut domain = None;
        let mut key = None;
        let mut out = None;
        let mut i = 0;
        while i < args.len() {
            let value = args
                .get(i + 1)
                .ok_or_else(|| format!("{} needs a value", args[i]))?;
            match args[i].as_str() {
                "--domain" => domain = Some(value.clone()),
                "--key" => key = Some(value.clone()),
                "--out" => out = Some(PathBuf::from(value)),
                other => return Err(format!("unknown flag {other:?}")),
            }
            i += 2;
        }
        let domain = domain.ok_or("--domain is required")?;
        let key = key.ok_or("--key is required")?;
        let out = out.ok_or("--out is required")?;
        Ok(Self {
            domain: domain
                .parse()
                .map_err(|_| "--domain must be 32 hex characters".to_string())?,
            key: obsync_core::hex::decode_array::<32>(&key)
                .map_err(|_| "--key must be 64 hex characters".to_string())?,
            out,
        })
    }
}

/// Scaffolding the subcommand tests share: one configuration on a temp
/// volume, so `serve` and `check` are exercised through the same start.
#[cfg(test)]
pub(crate) mod testutil {
    use super::Config;
    use crate::storage::testutil::TempDir;

    /// A configuration on a temp volume, with a watermark a tiny volume can
    /// clear.
    pub(crate) fn config(dir: &TempDir) -> Config {
        let pairs: Vec<(String, String)> = [
            ("OBSYNC_BLOBS_CAPACITY", "64MiB"),
            ("OBSYNC_JOURNAL_CAPACITY", "16MiB"),
            ("OBSYNC_FREE_WATERMARK", "1%,64KiB"),
            (
                "OBSYNC_BLOBS_DIR",
                &dir.path().join("blobs").display().to_string(),
            ),
            (
                "OBSYNC_JOURNAL_DIR",
                &dir.path().join("journal").display().to_string(),
            ),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        Config::from_pairs(&pairs).expect("configuration")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    use crate::log::LogLevel;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_string()).collect()
    }

    /// `check` and `export` refuse through the same helper, so the one line
    /// an operator gets off a failed subcommand names the I/O kind too, and
    /// still no path (requirement 6, requirement 12; issue #19).
    #[test]
    fn a_refused_subcommand_names_the_io_kind_and_never_the_path() {
        let log = Log::buffered(LogLevel::Error);
        let outcome: Result<check::CheckReport, StoreError> =
            Err(StoreError::from(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "/data/journal/v1/sentinel-name",
            )));
        assert_eq!(
            report(outcome, "check", &log),
            1,
            "a refusal exits non-zero"
        );

        let captured = log.captured();
        assert_eq!(
            captured.lines().count(),
            1,
            "one line per decision: {captured}"
        );
        for field in [
            "event=cli_failed",
            "job=check",
            "decision=io_error",
            "io=PermissionDenied",
        ] {
            assert!(captured.contains(field), "{field} missing: {captured}");
        }
        for leak in ["/data", "journal/v1", "v1/sentinel-name"] {
            assert!(
                !captured.contains(leak),
                "{leak} reached the line: {captured}"
            );
        }
    }

    #[test]
    fn export_arguments_parse_in_any_order() {
        let a = ExportArgs::parse(&args(&[
            "--out",
            "/tmp/out",
            "--key",
            &"ab".repeat(32),
            "--domain",
            &"cd".repeat(16),
        ]))
        .expect("parses");
        assert_eq!(a.out, PathBuf::from("/tmp/out"));
        assert_eq!(a.key, [0xabu8; 32]);
    }

    #[test]
    fn export_arguments_refuse_what_is_missing_or_malformed() {
        assert!(
            ExportArgs::parse(&args(&["--out", "/tmp"])).is_err(),
            "no domain or key"
        );
        assert!(
            ExportArgs::parse(&args(&["--domain"])).is_err(),
            "value missing"
        );
        assert!(
            ExportArgs::parse(&args(&[
                "--domain",
                "zz",
                "--key",
                &"ab".repeat(32),
                "--out",
                "/tmp"
            ]))
            .is_err(),
            "domain is not hex"
        );
        assert!(
            ExportArgs::parse(&args(&[
                "--domain",
                &"cd".repeat(16),
                "--key",
                "ab",
                "--out",
                "/tmp"
            ]))
            .is_err(),
            "key is the wrong length"
        );
        assert!(
            ExportArgs::parse(&args(&["--nope", "1"])).is_err(),
            "unknown flag"
        );
    }
}
