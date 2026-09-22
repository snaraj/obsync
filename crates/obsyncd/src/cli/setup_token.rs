//! `obsyncd setup-token`: print the standing setup token, and nothing else.
//!
//! The shipped image is distroless: no shell, no `tar`. Until this verb the
//! first-boot credential was therefore the one fact an operator could not ask
//! the server for — it was read from OUTSIDE the container, by a node-side
//! read of the volume, a throwaway pod mounting the journal claim read-only,
//! or `docker cp … | tar -xO` (issue #73). `kubectl exec deploy/obsync --
//! obsyncd setup-token` and `docker compose exec obsync obsyncd setup-token`
//! need none of that: exec runs this binary directly, and a missing shell is
//! only a problem for a command that needs one.
//!
//! What it refuses to do is as much of the design as what it does:
//!
//! - **One source, one reader.** The token is read off the journal volume
//!   through the measured handle a start reads it on (`storage::posture`), so
//!   a link, a wrong type, a foreign owner, a mode that will not correct, or
//!   a file that does not hold 64 hex characters refuses here exactly as it
//!   refuses a start. There is no second reader of this file to disagree with
//!   the first about what stands there.
//! - **No store, so no journal lock.** `check` and `export` replay the
//!   journal and therefore refuse with `journal_locked` while `serve` holds
//!   it. A verb whose whole purpose is a read from inside a container that is
//!   SERVING would be refused every time it was needed, so this one opens no
//!   store: the journal has nothing to say about the credential file beside
//!   it.
//! - **Standard output carries the token alone**, newline terminated, so the
//!   command pipes into a secret store or a clipboard. Every diagnostic,
//!   including the refusal, is on standard error, and a refused run prints
//!   nothing at all on standard output.
//! - **Nothing logs the token**, not even a prefix a reader of logs would not
//!   have to guess: one `event=setup_token decision=printed|refused` line per
//!   run states the decision, its reason, and its duration, and no more
//!   (requirement 6, requirement 12).
//!
//! The token is not spent by setup — it remains the dashboard's recovery
//! sign-in for the life of the server (`docs/architecture.md` 4.5) — so this
//! verb answers for as long as the file stands, and refuses once it does not:
//! a volume no server has booted on, or a token deleted to rotate it with no
//! start since (`docs/recovery.md`).
#![forbid(unsafe_code)]

use obsync_core::hex;

use crate::config::Config;
use crate::log::{Log, Val};
use crate::storage::{PathClass, Posture, StoreError, error_fields};

/// The token standing on the journal volume, or `None` when none does.
///
/// # Errors
/// The posture refusal a start would make on these volumes, the I/O the
/// volume returned, or [`StoreError::Corrupt`] for a file that is not a
/// token.
fn standing(cfg: &Config, log: &Log) -> Result<Option<String>, StoreError> {
    let posture = Posture::enforce(&cfg.storage(), log)?;
    let path = PathClass::SetupToken.path(&cfg.journal_dir);
    let Some(mut credential) = posture.open_credential(PathClass::SetupToken, &path, log)? else {
        return Ok(None);
    };
    let text = credential.read_to_string()?;
    let token = text.trim();
    // The shape a start requires, refused for the same reason: a file that is
    // not a token is not a token to print either, and printing what stands
    // there anyway is how a truncated read reaches a terminal as a
    // credential.
    hex::decode_array::<32>(token).map_err(|_| {
        StoreError::Corrupt("the stored setup token is not 64 hex characters".to_string())
    })?;
    Ok(Some(token.to_string()))
}

/// Print the token, state the decision on standard error, and return the
/// process exit code: `0` printed, `1` refused.
pub fn run(cfg: &Config, log: &Log) -> i32 {
    let timed = log.timed("setup_token");
    match standing(cfg, log) {
        Ok(Some(token)) => {
            println!("{token}");
            timed.done(&[("decision", Val::word("printed"))]);
            0
        }
        Ok(None) => {
            eprintln!(
                "obsyncd setup-token: no setup token stands on the journal volume. \
                 A server that has never started on these volumes has not minted \
                 one yet, and a token deleted to rotate it is minted again by the \
                 next start (docs/recovery.md)."
            );
            timed.refused(&[
                ("decision", Val::word("refused")),
                ("reason", Val::word("absent")),
            ]);
            1
        }
        Err(e) => {
            eprintln!("obsyncd setup-token: {e}");
            let mut fields = vec![
                ("decision", Val::word("refused")),
                ("reason", Val::word(e.code())),
            ];
            fields.extend(error_fields(&e));
            timed.refused(&fields);
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    use crate::cli::testutil::config;
    use crate::cli::{check, serve};
    use crate::log::LogLevel;
    use crate::storage::testutil::TempDir;
    use crate::storage::{Store, load_or_create_server_key};

    /// The one decision line this verb logs, whatever else the posture pass
    /// and the store said on the way. Matched with the trailing space, so
    /// `event=setup_token_ready` — the START line, from a different verb —
    /// can never stand in for it.
    fn decisions(captured: &str) -> Vec<String> {
        captured
            .lines()
            .filter(|line| line.contains("event=setup_token "))
            .map(str::to_string)
            .collect()
    }

    /// Mint a token the way a start mints one: the same function, on the same
    /// volumes, through the same measured handle. The store comes back with
    /// it, still holding the journal, because a start holds the journal for
    /// as long as it serves.
    fn minted_by_a_start(cfg: &Config, log: &Log) -> (String, Store) {
        let storage = cfg.storage();
        let posture = Posture::enforce(&storage, log).expect("volume posture");
        let key = load_or_create_server_key(&storage.journal_dir, cfg.server_key, &posture, log)
            .expect("server key");
        let store = Store::open(&storage, key, &posture, log.clone()).expect("store");
        let token = serve::setup_token(cfg, &store, &posture, log).expect("the token is minted");
        (token.expect("a start always has a token"), store)
    }

    /// What a `kubectl exec` into a SERVING pod gets: the token that start
    /// minted, read from the file it wrote, while that start still holds the
    /// journal. `check` on the same volumes at the same moment refuses with
    /// `journal_locked`, which is both the contrast and the proof that the
    /// journal really is held while this verb answers.
    #[test]
    fn the_token_a_start_minted_is_the_token_this_verb_prints() {
        let dir = TempDir::new("setup-token-printed");
        let cfg = config(&dir);
        let mint = Log::buffered(LogLevel::Debug);
        let (minted, _serving) = minted_by_a_start(&cfg, &mint);

        let log = Log::buffered(LogLevel::Debug);
        assert_eq!(
            check::run(&cfg, &log)
                .expect_err("a replaying verb refuses while a start holds the journal")
                .code(),
            "journal_locked",
            "the fixture holds the journal this verb never asks for"
        );

        let log = Log::buffered(LogLevel::Debug);
        assert_eq!(
            standing(&cfg, &log).expect("the volume answers"),
            Some(minted.clone()),
            "the verb reads the file the start wrote"
        );

        let log = Log::buffered(LogLevel::Debug);
        assert_eq!(run(&cfg, &log), 0, "a token that stands is printed");
        let lines = decisions(&log.captured());
        assert_eq!(lines.len(), 1, "one decision line per run: {lines:?}");
        assert!(lines[0].contains("decision=printed"), "{}", lines[0]);
        assert!(lines[0].contains("duration_ms="), "{}", lines[0]);
        let captured = log.captured();
        assert!(!captured.contains(&minted), "the token reached the log");
        assert!(
            !captured.contains(&minted[..16]),
            "a prefix of the token reached the log: {captured}"
        );
    }

    /// The journal volume is not there at all: the shape of a wrong
    /// `OBSYNC_JOURNAL_DIR`, or a first run against volumes no server has
    /// booted on. The posture pass completes the layout exactly as `check`
    /// leaves it, and the verb refuses because there is nothing to print.
    #[test]
    fn a_volume_no_server_has_booted_on_refuses_as_absent() {
        let dir = TempDir::new("setup-token-missing");
        let cfg = config(&dir);
        assert!(
            !cfg.journal_dir.exists(),
            "the fixture starts with no journal volume"
        );

        let log = Log::buffered(LogLevel::Debug);
        assert_eq!(
            standing(&cfg, &log).expect("the volume answers"),
            None,
            "no token stands, so there is nothing to print"
        );
        let log = Log::buffered(LogLevel::Debug);
        assert_eq!(run(&cfg, &log), 1, "a refusal exits non-zero");
        let lines = decisions(&log.captured());
        assert_eq!(lines.len(), 1, "one decision line per run: {lines:?}");
        assert!(
            lines[0].contains("decision=refused") && lines[0].contains("reason=absent"),
            "{}",
            lines[0]
        );
    }

    /// A token deleted to rotate it (`docs/recovery.md`) stands until the
    /// next start mints another. Between the two there is nothing to print,
    /// and printing what used to be there is exactly the failure this refuses.
    #[test]
    fn a_token_deleted_to_rotate_it_refuses_until_the_next_start() {
        let dir = TempDir::new("setup-token-rotated");
        let cfg = config(&dir);
        let (minted, _serving) = minted_by_a_start(&cfg, &Log::buffered(LogLevel::Error));
        let path = PathClass::SetupToken.path(&cfg.journal_dir);
        fs::remove_file(&path).expect("the operator deletes the token");

        let log = Log::buffered(LogLevel::Debug);
        assert_eq!(run(&cfg, &log), 1, "a refusal exits non-zero");
        let lines = decisions(&log.captured());
        assert_eq!(lines.len(), 1, "one decision line per run: {lines:?}");
        assert!(lines[0].contains("reason=absent"), "{}", lines[0]);
        assert!(
            !log.captured().contains(&minted),
            "the deleted token reached the log"
        );
    }

    /// A file that is not a token refuses rather than reaching a terminal as
    /// one: the same refusal a start makes on the same file (`docs/storage.md`,
    /// "Volume posture", step 6).
    #[test]
    fn a_file_that_is_not_a_token_refuses_instead_of_printing_it() {
        let dir = TempDir::new("setup-token-corrupt");
        let cfg = config(&dir);
        let (_minted, _serving) = minted_by_a_start(&cfg, &Log::buffered(LogLevel::Error));
        let path = PathClass::SetupToken.path(&cfg.journal_dir);
        fs::write(&path, "sentinel-not-a-token\n").expect("the file is truncated");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("credential mode");

        let log = Log::buffered(LogLevel::Debug);
        let err = standing(&cfg, &log).expect_err("the verb refuses");
        assert_eq!(err.code(), "corrupt", "{err}");
        let log = Log::buffered(LogLevel::Debug);
        assert_eq!(run(&cfg, &log), 1, "a refusal exits non-zero");
        let lines = decisions(&log.captured());
        assert_eq!(lines.len(), 1, "one decision line per run: {lines:?}");
        assert!(lines[0].contains("reason=corrupt"), "{}", lines[0]);
    }

    /// A posture a start would refuse is refused here too, with the code the
    /// start would have exited on: this verb is not a way around the pass.
    #[test]
    fn a_volume_a_start_would_refuse_is_refused_here_too() {
        let dir = TempDir::new("setup-token-posture");
        let cfg = config(&dir);
        fs::create_dir_all(PathClass::SetupToken.path(&cfg.journal_dir))
            .expect("a directory takes the name");

        let log = Log::buffered(LogLevel::Debug);
        let err = standing(&cfg, &log).expect_err("the verb refuses");
        assert_eq!(err.code(), "unsafe_posture", "{err}");
        let log = Log::buffered(LogLevel::Debug);
        assert_eq!(run(&cfg, &log), 1, "a refusal exits non-zero");
        let lines = decisions(&log.captured());
        assert_eq!(lines.len(), 1, "one decision line per run: {lines:?}");
        assert!(lines[0].contains("reason=unsafe_posture"), "{}", lines[0]);
    }
}
