//! `obsyncd recovery reset plan|apply`: show, then forget, the account's
//! recovery key.
//!
//! The server cannot tell a recovery verifier the vault key produced from one
//! it did not, so the first one any device credential registers stands, and a
//! device holding the real key meets `409 recovery_mismatch` and warns its
//! person (`docs/recovery.md`, "Another device set a different recovery
//! key"). This verb is the way back: `plan` says what stands and what a reset
//! would change, and changes nothing; `apply` clears the verifier, rotates the
//! setup token, and arms one re-enrolment. The first verifier registered
//! afterwards becomes the account's and spends the arm: a device that still
//! syncs registers its own, or the owner recovers with the new token and the
//! recovery phrase (`api::setup::create`). The server has nothing to check
//! that phrase against, so the authority is this offline step and the token
//! only it hands out; the proof only chooses the verifier, which the operator
//! can clear again.
//!
//! What it refuses to be is as much of the design as what it does:
//!
//! - **The operator's, never a device's.** It runs against the server's own
//!   volumes; there is no route for it. A device credential cannot reach it.
//! - **One writer.** Both steps open the store the way `check` does, so they
//!   take the journal lock and refuse with `journal_locked` while `serve`
//!   holds it. The reset is one account frame, carrying the arm, appended and
//!   fsynced by the same code a serving store uses, and the next start
//!   replays it.
//! - **The old token dies first.** `apply` removes the standing setup token,
//!   durably, before it writes the arm, so the next start mints a new one and
//!   a token captured earlier never meets an armed account. A removal that
//!   fails refuses the step with nothing armed.
//! - **Nothing secret in any output.** The verifier, or anything derived from
//!   it, is never printed or logged; only whether one stands, and when it was
//!   registered.
//! - **One stable machine form.** `--output json` prints one JSON object on
//!   standard output, refusals included, and nothing else; `human` (the
//!   default) prints sentences, and a refusal goes to standard error.
//! - **Exit status.** `0` the step did what was asked (a plan, a reset, or a
//!   reset with nothing to clear), `1` refused (the reason is in the output
//!   and the log line), `2` the command or the configuration is malformed.
//! - **One decision line**, `event=recovery_reset mode=plan|apply
//!   decision=planned|cleared|unchanged|refused`, with its duration and, on a
//!   refusal, its reason.
#![forbid(unsafe_code)]

use obsync_core::json::{Value, obj};

use crate::config::Config;
use crate::log::{Log, Val};
use crate::storage::{
    PathClass, Posture, RECOVERY_HOLD_MS, Store, StoreError, error_fields,
    load_or_create_server_key,
};
use crate::types::UnixMs;

/// The JSON result's version; a change a reader must notice raises it.
const SCHEMA_VERSION: i64 = 1;

/// Which step was asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Say what stands and what a reset would change; change nothing.
    Plan,
    /// Clear the verifier, rotate the setup token, arm one re-enrolment.
    Apply,
}

/// How the result is written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Output {
    /// Sentences for a person.
    Human,
    /// One JSON object.
    Json,
}

/// The words after `recovery`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Args {
    /// Plan or apply.
    pub mode: Mode,
    /// Human or JSON.
    pub output: Output,
}

impl Args {
    /// `reset plan|apply [--output human|json]`. The refusal never echoes an
    /// argument: a process argument is untrusted text bound for a terminal.
    ///
    /// # Errors
    /// A human message naming what is missing or not understood.
    pub fn parse(args: &[String]) -> Result<Self, String> {
        let words: Vec<&str> = args.iter().map(String::as_str).collect();
        let mode = match words.get(..2) {
            Some(["reset", "plan"]) => Mode::Plan,
            Some(["reset", "apply"]) => Mode::Apply,
            _ => {
                return Err("expected reset plan (see the change) or reset apply (make it)".into());
            }
        };
        let output = match &words[2..] {
            [] | ["--output", "human"] => Output::Human,
            ["--output", "json"] => Output::Json,
            _ => return Err("the one option is --output human|json".into()),
        };
        Ok(Args { mode, output })
    }
}

/// What the store held when it opened, and what this run changed.
struct Found {
    /// `None`: no verifier. `Some(None)`: one registered before registration
    /// times were kept. `Some(Some(t))`: one registered at `t`.
    registered: Option<Option<UnixMs>>,
    /// Whether this run cleared it.
    cleared: bool,
}

/// Remove the standing setup token so the next start mints another
/// (`cli::serve::setup_token`), and make the removal durable. None standing
/// is already rotated.
fn rotate_setup_token(cfg: &Config) -> Result<(), StoreError> {
    let path = PathClass::SetupToken.path(&cfg.journal_dir);
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    if let Some(dir) = path.parent() {
        std::fs::File::open(dir)?.sync_all()?;
    }
    Ok(())
}

/// Open the volumes as a start does, read the account, and in `apply` rotate
/// the setup token, then clear its verifier and arm one re-enrolment.
fn execute(cfg: &Config, log: &Log, mode: Mode) -> Result<Found, StoreError> {
    let storage = cfg.storage();
    let posture = Posture::enforce(&storage, log)?;
    let server_key =
        load_or_create_server_key(&storage.journal_dir, cfg.server_key, &posture, log)?;
    let store = Store::open(&storage, server_key, &posture, log.clone())?;
    let account = store.account().ok_or(StoreError::NotSetUp)?;
    let registered = account
        .recovery_verifier
        .as_ref()
        .map(|_| account.recovery_registered);
    let cleared = match mode {
        Mode::Plan => false,
        Mode::Apply => {
            rotate_setup_token(cfg)?;
            store.reset_recovery(UnixMs::now())?
        }
    };
    Ok(Found {
        registered,
        cleared,
    })
}

/// Run one step, write its result, and return the exit status.
pub fn run(cfg: &Config, log: &Log, args: Args) -> i32 {
    let timed = log.timed("recovery_reset");
    let mode_word = match args.mode {
        Mode::Plan => "plan",
        Mode::Apply => "apply",
    };
    let outcome = execute(cfg, log, args.mode);
    let duration = timed.elapsed_ms();
    match outcome {
        Ok(found) => {
            let decision = match (args.mode, found.cleared) {
                (Mode::Plan, _) => "planned",
                (Mode::Apply, true) => "cleared",
                (Mode::Apply, false) => "armed",
            };
            match args.output {
                Output::Human => println!("{}", human(args.mode, &found)),
                Output::Json => println!("{}", json(args.mode, Ok(&found), duration).to_json()),
            }
            timed.done(&[
                ("mode", Val::word(mode_word)),
                ("decision", Val::word(decision)),
            ]);
            0
        }
        Err(e) => {
            match args.output {
                Output::Human => eprintln!("obsyncd recovery reset: {e}. {}", next_after(&e)),
                Output::Json => println!("{}", json(args.mode, Err(&e), duration).to_json()),
            }
            let mut fields = vec![
                ("mode", Val::word(mode_word)),
                ("decision", Val::word("refused")),
                ("reason", Val::word(e.code())),
            ];
            fields.extend(error_fields(&e));
            timed.refused(&fields);
            1
        }
    }
}

/// What to do after a refusal, in one sentence.
fn next_after(e: &StoreError) -> &'static str {
    match e {
        StoreError::Locked => {
            "Stop the server first: this reads and writes the journal the running server holds."
        }
        StoreError::NotSetUp => "This server holds no account, so there is no recovery key.",
        _ => "The log line names the reason; nothing was changed.",
    }
}

/// When the last-device hold ends for a key registered at `at`.
fn hold_ends(at: UnixMs) -> UnixMs {
    UnixMs(at.0.saturating_add(RECOVERY_HOLD_MS))
}

/// The result for a person.
fn human(mode: Mode, found: &Found) -> String {
    let stands = match found.registered {
        None => "No recovery key is registered.".to_string(),
        Some(None) => {
            "A recovery key is registered; it predates 1.1.5, which keeps no time for it."
                .to_string()
        }
        Some(Some(at)) => format!(
            "A recovery key is registered, since {}. The account's only active device cannot be revoked before {}.",
            utc(at),
            utc(hold_ends(at))
        ),
    };
    // What arming means, the same sentence for the plan and the apply.
    let armed = "The first recovery key registered after the next start becomes the account's, whether a device that still syncs registers its own or the owner recovers with the new setup token and the recovery phrase. The server cannot check that phrase; it only sets the key, so a wrong one locks out only whoever used it, and another reset starts over. Until then the account's only active device cannot be revoked.";
    match mode {
        Mode::Plan => {
            let clears = if found.registered.is_some() {
                "clears it, "
            } else {
                ""
            };
            format!(
                "{stands}\nNothing was changed. obsyncd recovery reset apply {clears}rotates the setup token (the old one stops working) and arms one recovery. {armed}"
            )
        }
        // Said as what the reset removed, not as what stands.
        Mode::Apply => {
            let removed = match (found.cleared, found.registered) {
                (true, Some(Some(at))) => {
                    format!("The recovery key, registered {}, is cleared.", utc(at))
                }
                (true, _) => "The recovery key is cleared.".to_string(),
                (false, _) => "No recovery key was registered.".to_string(),
            };
            format!(
                "{removed}\nThe setup token is rotated: start the server and it mints a new one, which obsyncd setup-token prints; the old one no longer works.\nOne recovery is armed. {armed}"
            )
        }
    }
}

/// The result as one JSON object: the same fields on success and refusal.
fn json(mode: Mode, outcome: Result<&Found, &StoreError>, duration_ms: u64) -> Value {
    let text = |t: &str| Value::Str(t.to_string());
    let time = |t: Option<UnixMs>| t.map_or(Value::Null, |t| Value::Str(utc(t)));
    let (state, data, error, next): (&str, Value, Value, Vec<&str>) = match outcome {
        Ok(found) => {
            let registered = found.registered.flatten();
            let change = match (mode, found.registered.is_some(), found.cleared) {
                (Mode::Plan, true, _) => "clear",
                (Mode::Apply, _, true) => "cleared",
                _ => "none",
            };
            // `apply` always rotates and arms, so these name that step's
            // effect: to come in a plan, done in an apply.
            let (token, arm, next) = match mode {
                Mode::Plan => ("rotate", "arm", vec!["obsyncd recovery reset apply"]),
                Mode::Apply => (
                    "rotated",
                    "armed",
                    vec!["start the server", "obsyncd setup-token"],
                ),
            };
            (
                if mode == Mode::Plan {
                    "planned"
                } else {
                    "completed"
                },
                obj(vec![
                    (
                        "recovery_key",
                        text(if found.registered.is_some() {
                            "registered"
                        } else {
                            "absent"
                        }),
                    ),
                    ("registered_at", time(registered)),
                    ("hold_ends_at", time(registered.map(hold_ends))),
                    ("change", text(change)),
                    ("setup_token", text(token)),
                    ("re_enrolment", text(arm)),
                ]),
                Value::Null,
                next,
            )
        }
        Err(e) => (
            "refused",
            Value::Null,
            obj(vec![
                ("code", text(e.code())),
                ("message", text(&e.to_string())),
            ]),
            vec![next_after(e)],
        ),
    };
    obj(vec![
        ("schema_version", Value::Int(SCHEMA_VERSION)),
        (
            "operation",
            text(match mode {
                Mode::Plan => "recovery.reset.plan",
                Mode::Apply => "recovery.reset.apply",
            }),
        ),
        ("state", text(state)),
        ("data", data),
        ("error", error),
        (
            "next_actions",
            Value::Array(next.into_iter().map(text).collect()),
        ),
        ("observed_at", Value::Str(utc(UnixMs::now()))),
        (
            "duration_ms",
            Value::Int(i64::try_from(duration_ms).unwrap_or(i64::MAX)),
        ),
    ])
}

/// UTC RFC 3339, to the second, from Unix milliseconds: the civil calendar
/// from a day count (Hinnant's `civil_from_days`).
fn utc(t: UnixMs) -> String {
    let secs = t.0 / 1000;
    let (days, rem) = (
        i64::try_from(secs / 86_400).unwrap_or(i64::MAX),
        secs % 86_400,
    );
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    use obsync_core::json;

    use crate::cli::testutil::config;
    use crate::log::LogLevel;
    use crate::storage::testutil::TempDir;

    fn args(words: &[&str]) -> Vec<String> {
        words.iter().map(|w| (*w).to_string()).collect()
    }

    fn parsed(words: &[&str]) -> Args {
        Args::parse(&args(words)).expect("well formed")
    }

    /// The one decision line this verb logs, whatever the store said on the way.
    fn decisions(captured: &str) -> Vec<String> {
        captured
            .lines()
            .filter(|line| line.contains("event=recovery_reset "))
            .map(str::to_string)
            .collect()
    }

    /// The store a start opens on these volumes, with an account.
    fn serving(cfg: &Config, verifier: Option<&str>, at: UnixMs) -> Store {
        let log = Log::buffered(LogLevel::Error);
        let storage = cfg.storage();
        let posture = Posture::enforce(&storage, &log).expect("volume posture");
        let key = load_or_create_server_key(&storage.journal_dir, cfg.server_key, &posture, &log)
            .expect("server key");
        let store = Store::open(&storage, key, &posture, log).expect("store");
        store
            .setup_with_recovery("vault", verifier.map(str::to_string), at)
            .expect("setup");
        store
    }

    #[test]
    fn the_command_line_is_two_words_and_one_option_and_echoes_nothing() {
        assert_eq!(
            parsed(&["reset", "plan"]),
            Args {
                mode: Mode::Plan,
                output: Output::Human
            }
        );
        assert_eq!(
            parsed(&["reset", "apply", "--output", "json"]),
            Args {
                mode: Mode::Apply,
                output: Output::Json
            }
        );
        assert_eq!(
            parsed(&["reset", "plan", "--output", "human"]).output,
            Output::Human
        );
        for bad in [
            &[][..],
            &["reset"],
            &["reset", "now"],
            &["clear", "apply"],
            &["reset", "apply", "--output"],
            &["reset", "apply", "--output", "yaml"],
            &["reset", "apply", "--force"],
            &["reset", "apply", "--output", "json", "--output", "json"],
        ] {
            let err = Args::parse(&args(bad)).expect_err("refused");
            for word in bad
                .iter()
                .filter(|w| !["reset", "plan", "apply", "--output", "json", "human"].contains(w))
            {
                assert!(!err.contains(word), "the refusal echoed {word:?}: {err}");
            }
        }
    }

    #[test]
    fn a_plan_says_what_stands_and_changes_nothing_then_apply_clears_it_durably() {
        let dir = TempDir::new("recovery-reset-plan");
        let cfg = config(&dir);
        let bogus = "b6".repeat(32);
        let at = UnixMs(1_757_200_000_000);
        let store = serving(&cfg, Some(&bogus), at);
        let token = start_token(&cfg, &store);
        drop(store);

        let log = Log::buffered(LogLevel::Debug);
        let plan = parsed(&["reset", "plan", "--output", "json"]);
        assert_eq!(run(&cfg, &log, plan), 0, "a plan exits zero");
        assert_eq!(
            standing_token(&cfg),
            Some(token.clone()),
            "a plan rotates nothing"
        );
        let lines = decisions(&log.captured());
        assert_eq!(lines.len(), 1, "one decision line per run: {lines:?}");
        assert!(
            lines[0].contains("mode=plan decision=planned"),
            "{}",
            lines[0]
        );
        let found = execute(&cfg, &Log::buffered(LogLevel::Error), Mode::Plan).expect("plan");
        assert_eq!(found.registered, Some(Some(at)), "the plan changed nothing");
        let value = json(Mode::Plan, Ok(&found), 3);
        let data = value.get("data").expect("data");
        assert_eq!(value.get("state").and_then(Value::as_str), Some("planned"));
        assert_eq!(
            value.get("operation").and_then(Value::as_str),
            Some("recovery.reset.plan")
        );
        assert_eq!(
            data.get("recovery_key").and_then(Value::as_str),
            Some("registered")
        );
        assert_eq!(
            data.get("registered_at").and_then(Value::as_str),
            Some("2025-09-06T23:06:40Z")
        );
        assert_eq!(
            data.get("hold_ends_at").and_then(Value::as_str),
            Some("2025-09-13T23:06:40Z")
        );
        assert_eq!(data.get("change").and_then(Value::as_str), Some("clear"));
        assert_eq!(
            data.get("setup_token").and_then(Value::as_str),
            Some("rotate")
        );
        assert_eq!(
            data.get("re_enrolment").and_then(Value::as_str),
            Some("arm")
        );
        let text = human(Mode::Plan, &found);
        assert!(text.contains("since 2025-09-06T23:06:40Z"), "{text}");
        assert!(text.contains("Nothing was changed"), "{text}");
        assert!(
            text.contains("clears it, rotates the setup token"),
            "a plan states both effects: {text}"
        );
        let cleared = Found {
            registered: Some(Some(at)),
            cleared: true,
        };
        let text = human(Mode::Apply, &cleared);
        assert!(
            text.starts_with("The recovery key, registered 2025-09-06T23:06:40Z, is cleared."),
            "an apply says what it removed, not what stands: {text}"
        );

        let log = Log::buffered(LogLevel::Debug);
        assert_eq!(
            run(&cfg, &log, parsed(&["reset", "apply"])),
            0,
            "a cleared key exits zero"
        );
        let captured = log.captured();
        let lines = decisions(&captured);
        assert_eq!(lines.len(), 1, "one decision line per run: {lines:?}");
        assert!(
            lines[0].contains("mode=apply decision=cleared"),
            "{}",
            lines[0]
        );
        assert!(lines[0].contains("duration_ms="), "{}", lines[0]);
        assert!(
            !captured.contains(&bogus[..16]),
            "the verifier reached the log"
        );
        assert_eq!(standing_token(&cfg), None, "the apply rotated the token");

        // The next start replays the reset, armed, and the key's own device
        // registers again, with a time of its own, which spends the arm.
        let store = serving_again(&cfg);
        let account = store.account().expect("the account survives");
        assert_eq!(account.recovery_verifier, None);
        assert_eq!(account.recovery_registered, None);
        assert!(account.recovery_cleared.is_some(), "armed");
        assert!(
            store
                .register_recovery(&"a5".repeat(32), UnixMs(42))
                .expect("register")
        );
        let account = store.account().expect("account");
        assert_eq!(account.recovery_registered, Some(UnixMs(42)));
        assert_eq!(account.recovery_cleared, None, "spent");
    }

    fn serving_again(cfg: &Config) -> Store {
        let log = Log::buffered(LogLevel::Error);
        let storage = cfg.storage();
        let posture = Posture::enforce(&storage, &log).expect("volume posture");
        let key = load_or_create_server_key(&storage.journal_dir, cfg.server_key, &posture, &log)
            .expect("server key");
        Store::open(&storage, key, &posture, log).expect("store")
    }

    /// The token a start on these volumes serves, minted when none stands.
    fn start_token(cfg: &Config, store: &Store) -> String {
        let log = Log::buffered(LogLevel::Error);
        let posture = Posture::enforce(&cfg.storage(), &log).expect("volume posture");
        crate::cli::serve::setup_token(cfg, store, &posture, &log)
            .expect("the start reads or mints its token")
            .expect("a start always has a token")
    }

    /// What stands under the token's name, if anything.
    fn standing_token(cfg: &Config) -> Option<String> {
        std::fs::read_to_string(PathClass::SetupToken.path(&cfg.journal_dir))
            .ok()
            .map(|text| text.trim().to_string())
    }

    #[test]
    fn a_reset_with_no_key_still_rotates_the_token_and_arms_one_re_enrolment() {
        let dir = TempDir::new("recovery-reset-armed");
        let cfg = config(&dir);
        let store = serving(&cfg, None, UnixMs(1));
        let old = start_token(&cfg, &store);
        drop(store);
        let log = Log::buffered(LogLevel::Debug);
        assert_eq!(
            run(&cfg, &log, parsed(&["reset", "apply"])),
            0,
            "no key to clear is not a failure"
        );
        let captured = log.captured();
        let lines = decisions(&captured);
        assert!(lines[0].contains("decision=armed"), "{}", lines[0]);
        assert!(!captured.contains(&old[..16]), "the token reached the log");
        assert_eq!(standing_token(&cfg), None, "the old token is gone");
        let store = serving_again(&cfg);
        assert!(
            store.account().expect("account").recovery_cleared.is_some(),
            "the reset armed a re-enrolment"
        );
        assert_ne!(
            start_token(&cfg, &store),
            old,
            "the next start mints another token"
        );

        let found = Found {
            registered: None,
            cleared: false,
        };
        let value = json(Mode::Apply, Ok(&found), 0);
        assert_eq!(
            value.get("state").and_then(Value::as_str),
            Some("completed")
        );
        let data = value.get("data").expect("data");
        assert_eq!(data.get("change").and_then(Value::as_str), Some("none"));
        assert_eq!(
            data.get("setup_token").and_then(Value::as_str),
            Some("rotated")
        );
        assert_eq!(
            data.get("re_enrolment").and_then(Value::as_str),
            Some("armed")
        );
        assert_eq!(data.get("registered_at"), Some(&Value::Null));
        assert!(
            value
                .get("next_actions")
                .and_then(Value::as_array)
                .is_some_and(|next| next.contains(&Value::Str("obsyncd setup-token".into()))),
            "the apply says where the new token is"
        );
        let text = human(Mode::Apply, &found);
        assert!(
            text.starts_with("No recovery key was registered."),
            "{text}"
        );
        assert!(text.contains("The setup token is rotated"), "{text}");
        assert!(text.contains("cannot check that phrase"), "{text}");
        // A key from before 1.1.5 is registered, with no time to state.
        let legacy = Found {
            registered: Some(None),
            cleared: false,
        };
        assert!(human(Mode::Plan, &legacy).contains("predates 1.1.5"));
        assert_eq!(
            json(Mode::Plan, Ok(&legacy), 0)
                .get("data")
                .and_then(|d| d.get("hold_ends_at")),
            Some(&Value::Null)
        );
    }

    #[test]
    fn a_reset_refuses_while_the_server_holds_the_journal_and_before_setup() {
        let dir = TempDir::new("recovery-reset-refused");
        let cfg = config(&dir);
        let bogus = "b6".repeat(32);
        let held = serving(&cfg, Some(&bogus), UnixMs(1));
        let token = start_token(&cfg, &held);
        for mode in ["plan", "apply"] {
            let log = Log::buffered(LogLevel::Debug);
            assert_eq!(
                run(&cfg, &log, parsed(&["reset", mode])),
                1,
                "a refusal exits non-zero"
            );
            let lines = decisions(&log.captured());
            assert_eq!(lines.len(), 1, "one decision line per run: {lines:?}");
            assert!(
                lines[0].contains("decision=refused") && lines[0].contains("reason=journal_locked"),
                "{}",
                lines[0]
            );
        }
        assert_eq!(
            held.account().expect("account").recovery_verifier,
            Some(bogus),
            "the serving store's key is untouched"
        );
        assert_eq!(
            standing_token(&cfg),
            Some(token),
            "a refused apply leaves the serving token where it stands"
        );
        let refused = json(Mode::Apply, Err(&StoreError::Locked), 0);
        assert_eq!(
            refused.get("state").and_then(Value::as_str),
            Some("refused")
        );
        assert_eq!(
            refused
                .get("error")
                .and_then(|e| e.get("code"))
                .and_then(Value::as_str),
            Some("journal_locked")
        );
        assert_eq!(refused.get("data"), Some(&Value::Null));
        json::parse(refused.to_json().as_bytes())
            .expect("one valid JSON object, refusals included");
        drop(held);

        let empty = TempDir::new("recovery-reset-not-set-up");
        let log = Log::buffered(LogLevel::Debug);
        assert_eq!(
            run(&config(&empty), &log, parsed(&["reset", "plan"])),
            1,
            "no account"
        );
        assert!(decisions(&log.captured())[0].contains("reason=not_set_up"));
    }

    #[test]
    fn times_are_utc_rfc_3339() {
        for (ms, text) in [
            (0, "1970-01-01T00:00:00Z"),
            (951_782_400_000, "2000-02-29T00:00:00Z"),
            (1_757_200_000_999, "2025-09-06T23:06:40Z"),
            (4_107_542_399_000, "2100-02-28T23:59:59Z"),
            (253_402_300_799_000, "9999-12-31T23:59:59Z"),
        ] {
            assert_eq!(utc(UnixMs(ms)), text, "{ms}");
        }
    }
}
