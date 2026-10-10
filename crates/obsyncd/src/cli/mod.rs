//! The `obsyncd` command line: `serve` (the default), `check`, `setup-token`,
//! `recovery reset`, `export`, and `version`.
//!
//! Configuration is environment only (`docs/architecture.md` 9), so the
//! command line stays this small on purpose: one verb per operating task and
//! no flag that could weaken a security behavior.
#![forbid(unsafe_code)]

pub mod check;
pub mod export;
pub mod recovery;
pub mod serve;
pub mod setup_token;

use std::path::PathBuf;

use crate::config::Config;
use crate::log::{Log, Val};
use crate::storage::{StoreError, error_fields};
use crate::types::DomainId;

/// What `obsyncd help` prints, on standard error.
pub const USAGE: &str = "\
Usage:
  obsyncd [serve]        serve the sync API, dashboard, and plugin bundle
  obsyncd check          verify every stored chunk and journal frame
  obsyncd setup-token    print the standing setup token, and nothing else
  obsyncd recovery reset plan|apply [--output human|json]
                         show, then clear, the account's recovery key
  obsyncd export --domain <32hex> --out <dir>
                         export ciphertext only; no content key is accepted
  obsyncd version

Configuration is environment only; docs/architecture.md lists every variable.";

/// Run one subcommand. Returns the process exit code.
///
/// Standard output carries the version or an operator report; structured
/// diagnostics go to standard error.
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
        // Not through `report`: this verb's standard output is the credential
        // and nothing else, so it prints and decides for itself.
        Some("setup-token") => with_config(|cfg| {
            let log = Log::new(cfg.log_level);
            setup_token::run(&cfg, &log)
        }),
        // Not through `report`: plan and apply each print their own result,
        // in the form asked for, refusals included.
        Some("recovery") => match recovery::Args::parse(&args[1..]) {
            Ok(a) => with_config(|cfg| {
                let log = Log::new(cfg.log_level);
                recovery::run(&cfg, &log, a)
            }),
            Err(e) => {
                eprintln!("obsyncd recovery: {e}\n{USAGE}");
                2
            }
        },
        Some("export") => match ExportArgs::parse(&args[1..]) {
            Ok(a) => with_config(|cfg| {
                let log = Log::new(cfg.log_level);
                report(export::run(&cfg, &a.domain, &a.out), "export", &log)
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
            if report.ok() {
                0
            } else {
                log.error(
                    "cli_failed",
                    &[
                        ("job", Val::word(job)),
                        ("decision", Val::word("integrity_failed")),
                    ],
                );
                1
            }
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
    /// A completed traversal can still report incomplete or corrupt data.
    fn ok(&self) -> bool;
    /// Print the counts on standard output.
    fn print(&self);
}

impl Report for check::CheckReport {
    fn ok(&self) -> bool {
        check::CheckReport::ok(self)
    }
    fn print(&self) {
        check::CheckReport::print(self);
    }
}

impl Report for export::ExportReport {
    fn ok(&self) -> bool {
        export::ExportReport::ok(self)
    }
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

/// Ciphertext export has no content-key input, including files and stdin.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExportArgs {
    /// Which domain's ciphertext to export.
    pub domain: DomainId,
    /// Where the encrypted records are written.
    pub out: PathBuf,
}

impl ExportArgs {
    /// Parse the two flags in any order without reading content keys.
    ///
    /// # Errors
    /// A fixed message for missing, duplicate, unknown or malformed flags.
    /// Never echo arguments: an obsolete caller may have supplied a key.
    pub fn parse(args: &[String]) -> Result<Self, String> {
        let mut domain = None;
        let mut out = None;
        let mut i = 0;
        while i < args.len() {
            let flag = args[i].as_str();
            if matches!(flag, "--key" | "--key-file") {
                return Err("content keys are refused; export writes ciphertext only".into());
            }
            if !matches!(flag, "--domain" | "--out") {
                return Err("unknown export flag".into());
            }
            let value = args
                .get(i + 1)
                .filter(|value| !value.is_empty() && !value.starts_with("--"))
                .ok_or("export flag needs a value")?;
            match flag {
                "--domain" if domain.is_none() => domain = Some(value),
                "--out" if out.is_none() => out = Some(PathBuf::from(value)),
                _ => return Err("duplicate export flag".into()),
            }
            i += 2;
        }
        Ok(Self {
            domain: domain
                .ok_or("--domain is required")?
                .parse()
                .map_err(|_| "--domain must be 32 hex characters")?,
            out: out.ok_or("--out is required")?,
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

    /// Every verb the dispatch answers is a verb `obsyncd help` names.
    ///
    /// Read off this file's own source rather than a list typed twice: a verb
    /// the dispatch takes and the help never mentions is a verb an operator
    /// cannot discover, and `setup-token` exists for the operator who has no
    /// other way to ask — no shell in the image to read the file with
    /// (issue #73).
    #[test]
    fn every_verb_the_dispatch_answers_is_named_in_the_usage() {
        // The dispatch is everything above the first helper, so the scan
        // never reads this test module's own text.
        let dispatch = include_str!("mod.rs")
            .split("fn with_config")
            .next()
            .expect("the dispatch stands above the helpers");
        let needle = "Some(\"";
        let verbs: Vec<&str> = dispatch
            .match_indices(needle)
            .map(|(at, _)| {
                let rest = &dispatch[at + needle.len()..];
                &rest[..rest.find('"').expect("a closed string literal")]
            })
            .filter(|verb| *verb != "help")
            .collect();
        assert!(
            verbs.len() >= 4,
            "the dispatch scan read no match arms: {verbs:?}"
        );
        for verb in verbs {
            assert!(
                USAGE.contains(verb),
                "the dispatch answers {verb:?} and the usage never names it"
            );
        }
        assert_eq!(
            run(&args(&["setup-tokens"])),
            2,
            "a near miss is not a verb, and the refusal reprints the usage"
        );
    }

    #[test]
    fn recovery_reports_drive_exit_status_and_failure_log() {
        for (bad_chunks, bad_frames) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
            let value = check::CheckReport {
                posture: Vec::new(),
                chunks: 2,
                bytes: 8,
                bad_chunks: vec![crate::types::Sid::new([0; 32]); bad_chunks],
                segments: 1,
                frames: 3,
                bad_frames,
            };
            let log = Log::buffered(LogLevel::Info);
            let failed = bad_chunks != 0 || bad_frames != 0;
            assert_eq!(report(Ok(value), "check", &log), i32::from(failed));
            let lines = log.captured();
            if failed {
                assert!(
                    lines.contains("event=cli_failed job=check decision=integrity_failed"),
                    "{lines}"
                );
                assert_eq!(lines.lines().count(), 1);
            } else {
                assert!(lines.is_empty());
            }
        }
        for missing in [0, 1] {
            let value = export::ExportReport {
                files: 1,
                versions: 1,
                chunks: 1,
                bytes: 4,
                missing: vec![crate::types::Sid::new([0; 32]); missing],
            };
            let log = Log::buffered(LogLevel::Info);
            assert_eq!(report(Ok(value), "export", &log), i32::from(missing != 0));
            if missing != 0 {
                assert!(
                    log.captured()
                        .contains("job=export decision=integrity_failed")
                );
            } else {
                assert!(log.captured().is_empty());
            }
        }
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
    fn export_arguments_parse_without_a_key_in_any_order() {
        let a = ExportArgs::parse(&args(&["--out", "/tmp/out", "--domain", &"cd".repeat(16)]))
            .expect("ciphertext export needs no content key");
        assert_eq!(a.out, PathBuf::from("/tmp/out"));
        assert_eq!(a.domain.to_string(), "cd".repeat(16));
    }

    #[test]
    fn export_refuses_key_inputs_without_echoing_or_reading_them() {
        for flag in ["--key", "--key-file"] {
            for value in ["SENTINEL-content-key", "-", "/nonexistent/private-key"] {
                let failure = ExportArgs::parse(&args(&[flag, value]))
                    .expect_err("server interfaces never accept content keys");
                assert_eq!(
                    failure,
                    "content keys are refused; export writes ciphertext only"
                );
                assert!(!failure.contains(value));
                let invocation = args(&[
                    "--domain",
                    &"cd".repeat(16),
                    "--out",
                    "/tmp/out",
                    flag,
                    value,
                ]);
                ExportArgs::parse(&invocation)
                    .expect_err("server interfaces never accept content keys");
            }
            assert!(ExportArgs::parse(&args(&[flag])).is_err());
        }
        assert_eq!(
            ExportArgs::parse(&args(&["SENTINEL-private-value"])).expect_err("unknown input"),
            "unknown export flag"
        );
        assert!(!USAGE.contains("--key"));
    }

    #[test]
    fn export_arguments_refuse_what_is_missing_or_malformed() {
        for flags in [
            args(&[]),
            args(&["--out", "/tmp"]),
            args(&["--domain"]),
            args(&["--domain", "zz", "--out", "/tmp"]),
            args(&["--domain", &"cd".repeat(16)]),
            args(&["--domain", &"cd".repeat(16), "--out", ""]),
            args(&[
                "--out",
                "/tmp",
                "--out",
                "/tmp/other",
                "--domain",
                &"cd".repeat(16),
            ]),
            args(&[
                "--domain",
                &"cd".repeat(16),
                "--domain",
                &"ef".repeat(16),
                "--out",
                "/tmp",
            ]),
            args(&["--nope", "1"]),
        ] {
            assert!(ExportArgs::parse(&flags).is_err());
        }
    }
}
