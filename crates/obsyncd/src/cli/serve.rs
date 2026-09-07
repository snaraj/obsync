//! `obsyncd serve`: open the store, start the background work, and serve the
//! API, the dashboard, and the plugin bundle until a signal arrives.
//!
//! Every ceiling the HTTP server enforces is a constant here
//! (`docs/protocol.md`, "Limits and headers"); only the connection count is
//! configuration, because it is a capacity choice and not a security one.
#![forbid(unsafe_code)]

use std::io::Write;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::thread::{JoinHandle, sleep};
use std::time::{Duration, Instant};

use obsync_core::hex;
use obsync_core::http::{Limits, Server};

use crate::api::{self, App};
use crate::config::Config;
use crate::dashboard::Dashboard;
use crate::log::{Log, Val};
use crate::plugin_dist::PluginDist;
use crate::storage::{PathClass, Posture, Store, StoreError, load_or_create_server_key};
use crate::types::UnixMs;
use crate::{api::rand, signal};

/// Request headers are refused above this size.
pub const MAX_HEADER_BYTES: usize = 16 * 1024;
/// A connection has this long to send its request headers.
pub const HEADER_TIMEOUT: Duration = Duration::from_secs(10);
/// An idle connection is closed after this long; a long-poll is excepted up to
/// its own `wait`.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// A body slower than this is a slowloris and is dropped.
pub const MIN_BODY_RATE: u64 = 64 * 1024;
/// In-flight requests get this long to finish after a signal.
pub const DRAIN: Duration = Duration::from_secs(20);
/// Garbage collection runs on this period (`docs/storage.md`).
pub const GC_PERIOD: Duration = Duration::from_secs(3600);
/// The budget a collection is measured against (requirement 12).
pub const GC_BUDGET: Duration = Duration::from_secs(600);
/// One scrub step re-hashes at most this many bytes before sleeping.
pub const SCRUB_STEP_BYTES: u64 = 16 * 1024 * 1024;
/// The index snapshot period.
pub const SNAPSHOT_PERIOD: Duration = Duration::from_secs(600);
/// The nonce, pairing, and session sweep period.
pub const SWEEP_PERIOD: Duration = Duration::from_secs(60);
/// How often a background thread wakes to check for shutdown or a request.
pub const TICK: Duration = Duration::from_secs(1);
/// A setup token is 32 random bytes as hex.
pub const TOKEN_HEX_LEN: usize = 64;

/// Run the server. Returns the process exit code.
pub fn run() -> i32 {
    let cfg = match Config::from_env() {
        Ok(cfg) => cfg,
        Err(e) => {
            eprintln!("obsyncd: configuration: {e}");
            return 2;
        }
    };
    let log = Log::new(cfg.log_level);
    cfg.log_startup(&log);
    let shutdown = signal::install();

    let storage = cfg.storage();
    // Before anything is read or written through them: what the volumes are,
    // who owns them, and what they let other users do.
    let posture = match Posture::enforce(&storage, &log) {
        Ok(posture) => posture,
        Err(e) => return fatal(&log, "posture_failed", &e),
    };
    let server_key =
        match load_or_create_server_key(&storage.journal_dir, cfg.server_key, &posture, &log) {
            Ok(key) => key,
            Err(e) => return fatal(&log, "server_key_failed", &e),
        };
    let store = match Store::open(&storage, server_key, log.clone()) {
        Ok(store) => store,
        Err(e) => return fatal(&log, "store_open_failed", &e),
    };

    let setup_token = match setup_token(&cfg, &store, &posture, &log) {
        Ok(token) => token,
        Err(e) => return fatal(&log, "setup_token_failed", &e),
    };

    let limits = Limits {
        max_header_bytes: MAX_HEADER_BYTES,
        header_timeout: HEADER_TIMEOUT,
        idle_timeout: IDLE_TIMEOUT,
        min_body_rate_bytes_per_sec: MIN_BODY_RATE,
        max_connections: cfg.max_connections,
    };
    let mut server = match Server::bind(&cfg.listen.to_string(), limits) {
        Ok(server) => server,
        Err(e) => {
            log.error(
                "listen_failed",
                &[("decision", Val::word("exit")), ("io", Val::io(&e))],
            );
            return 1;
        }
    };
    let sink_log = log.clone();
    server.set_error_sink(Arc::new(move |_| {
        sink_log.warn("http_refused", &[("decision", Val::word("parser_refusal"))]);
    }));

    let dashboard = Dashboard::load(&cfg.dashboard_dir, &log);
    let plugin = PluginDist::load(&cfg.plugin_dir, &log);
    let app = Arc::new(App::new(
        cfg,
        store,
        log.clone(),
        dashboard,
        plugin,
        Arc::clone(&shutdown),
        setup_token,
    ));

    log.info(
        "serve_start",
        &[
            ("version", Val::word(env!("CARGO_PKG_VERSION"))),
            (
                "max_connections",
                Val::count(app.cfg.max_connections as u64),
            ),
            ("drain_ms", Val::ms(DRAIN.as_millis() as u64)),
        ],
    );

    let workers = background(&app);
    server.serve(api::handler(Arc::clone(&app)), Arc::clone(&shutdown), DRAIN);

    shutdown.store(true, Ordering::SeqCst);
    for worker in workers {
        let _ = worker.join();
    }
    match app.store.snapshot() {
        Ok(()) => log.info("shutdown_snapshot", &[("decision", Val::word("ok"))]),
        Err(e) => log.error("shutdown_snapshot", &[("decision", Val::word(e.code()))]),
    }
    log.info("serve_stop", &[("decision", Val::word("clean"))]);
    0
}

/// Log a fatal storage refusal by its code and exit non-zero.
fn fatal(log: &Log, event: &'static str, e: &StoreError) -> i32 {
    log.error(
        event,
        &[
            ("decision", Val::word("exit")),
            ("refusal", Val::word(e.code())),
        ],
    );
    1
}

/// Start the four background threads: collection, scrub, sweep, and snapshot.
fn background(app: &Arc<App>) -> Vec<JoinHandle<()>> {
    vec![
        spawn(
            app,
            "gc",
            GC_PERIOD,
            |app| app.take_gc_request(),
            |app| {
                let started = app.log.start("gc_cycle", GC_BUDGET.as_millis() as u64);
                let at = Instant::now();
                app.set_gc_running(true);
                let summary = app.store.gc_run(UnixMs(app.clock.unix_ms()));
                app.set_gc_running(false);
                let over = at.elapsed() > GC_BUDGET;
                started.summary(
                    &app.log,
                    &[
                        ("chunks_collected", Val::count(summary.chunks_collected)),
                        ("bytes_collected", Val::bytes(summary.bytes_collected)),
                        ("chunks_retained", Val::count(summary.chunks_retained)),
                        ("budget_ms", Val::ms(GC_BUDGET.as_millis() as u64)),
                        (
                            "decision",
                            Val::word(if over { "over_budget" } else { "ok" }),
                        ),
                    ],
                );
            },
        ),
        scrub_thread(app),
        spawn(
            app,
            "sweep",
            SWEEP_PERIOD,
            |_| false,
            |app| {
                let now = app.clock.unix_secs();
                let (nonces, pairings, sessions) = app.sweep(now);
                if nonces + pairings + sessions > 0 {
                    app.log.debug(
                        "swept",
                        &[
                            ("nonces", Val::count(nonces as u64)),
                            ("pairings", Val::count(pairings as u64)),
                            ("sessions", Val::count(sessions as u64)),
                        ],
                    );
                }
            },
        ),
        spawn(
            app,
            "snapshot",
            SNAPSHOT_PERIOD,
            |_| false,
            |app| {
                if let Err(e) = app.store.snapshot() {
                    app.log.error(
                        "snapshot_failed",
                        &[
                            ("decision", Val::word("retry_next_period")),
                            ("refusal", Val::word(e.code())),
                        ],
                    );
                }
            },
        ),
    ]
}

/// A thread that runs `job` every `period`, or as soon as `asked` says the
/// dashboard requested it, and stops within one tick of a shutdown.
fn spawn(
    app: &Arc<App>,
    name: &'static str,
    period: Duration,
    asked: fn(&Arc<App>) -> bool,
    job: fn(&Arc<App>),
) -> JoinHandle<()> {
    let app = Arc::clone(app);
    std::thread::Builder::new()
        .name(format!("obsync-{name}"))
        .spawn(move || {
            let mut last = Instant::now();
            while !app.shutdown.load(Ordering::SeqCst) {
                sleep(TICK);
                if !asked(&app) && last.elapsed() < period {
                    continue;
                }
                last = Instant::now();
                job(&app);
            }
        })
        .expect("spawn background thread")
}

/// The scrub thread: fixed-size steps paced to the configured byte rate, so a
/// Pi spends a known fraction of its disk on integrity
/// (`docs/storage.md`, "Integrity").
fn scrub_thread(app: &Arc<App>) -> JoinHandle<()> {
    let app = Arc::clone(app);
    std::thread::Builder::new()
        .name("obsync-scrub".to_string())
        .spawn(move || {
            let rate = app.cfg.scrub_rate_bytes_per_sec.max(1);
            let pause = Duration::from_secs_f64(SCRUB_STEP_BYTES as f64 / rate as f64);
            while !app.shutdown.load(Ordering::SeqCst) {
                let asked = app.take_scrub_request();
                app.set_scrub_running(true);
                let summary = app.store.scrub_step(SCRUB_STEP_BYTES);
                app.set_scrub_running(false);
                if summary.mismatches > 0 {
                    app.log.error(
                        "scrub_mismatch",
                        &[
                            ("decision", Val::word("quarantined")),
                            ("mismatches", Val::count(summary.mismatches)),
                            ("quarantined", Val::count(summary.quarantined.len() as u64)),
                        ],
                    );
                }
                if asked {
                    continue;
                }
                nap(&app, pause);
            }
        })
        .expect("spawn scrub thread")
}

/// Sleep in ticks so a shutdown is noticed within one second.
fn nap(app: &Arc<App>, total: Duration) {
    let mut slept = Duration::ZERO;
    while slept < total && !app.shutdown.load(Ordering::SeqCst) {
        sleep(TICK);
        slept += TICK;
    }
}

/// Read the setup token, or mint it at first boot.
///
/// The token is written to the journal volume with mode 0600 and survives
/// restarts: `docs/architecture.md` 4.5 makes it the dashboard's recovery
/// login as well as the first-boot credential. Because it stands until it is
/// used, a restored or bind-mounted volume that hands it over widely is a
/// standing way in. The file is opened on a measured handle — a link, a
/// wrong type, a foreign owner, or an inode shared with the server key is
/// refused there, and a mode is corrected there — and it is read, or
/// written and read back, through that same handle: whoever can rename the
/// journal root aside after the measurement changes what the name says, not
/// what this handle is.
///
/// The mode on the line is read back off the handle after the token is in
/// place, so the line cannot claim a protection the file does not have.
///
/// The line says where the token is, never what it is. Not even a prefix
/// reaches the log: the logger takes no free text for a credential
/// (`doctrine_test`), and a prefix in a log file is a prefix an attacker
/// reading logs does not have to guess.
fn setup_token(
    cfg: &Config,
    store: &Store,
    posture: &Posture,
    log: &Log,
) -> Result<Option<String>, StoreError> {
    let path = PathClass::SetupToken.path(&cfg.journal_dir);
    let (token, mode) = match posture.open_credential(PathClass::SetupToken, &path, log)? {
        Some(mut standing) => {
            let text = standing.read_to_string()?;
            let token = text.trim();
            // A token file that is not a token is not a first boot. It is
            // named to the operator and overwritten by nobody: whatever
            // stands under this name is left exactly as it was found.
            hex::decode_array::<32>(token).map_err(|_| {
                StoreError::Corrupt("the stored setup token is not 64 hex characters".to_string())
            })?;
            (token.to_string(), standing.mode())
        }
        None => {
            let minted = rand::hex_token(32)?;
            let mut file = Posture::create(PathClass::SetupToken, &path)?;
            file.write_all(minted.as_bytes())?;
            file.write_all(b"\n")?;
            file.sync_all()?;
            let written = posture.adopt(PathClass::SetupToken, file, log)?;
            (minted, written.mode())
        }
    };
    log.info(
        "setup_token_ready",
        &[
            ("file", Val::word("<journal volume>/v1/setup-token")),
            ("mode", Val::mode(mode)),
            (
                "state",
                Val::word(if store.account().is_none() {
                    "awaiting_setup"
                } else {
                    "recovery_login"
                }),
            ),
        ],
    );
    Ok(Some(token))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;

    use crate::cli::testutil::config;
    use crate::log::LogLevel;
    use crate::storage::testutil::TempDir;

    /// The start sequence up to the token, as `run` performs it.
    fn start(cfg: &Config, log: &Log) -> (Posture, Store) {
        let storage = cfg.storage();
        let posture = Posture::enforce(&storage, log).expect("volume posture");
        let key = load_or_create_server_key(&storage.journal_dir, cfg.server_key, &posture, log)
            .expect("server key");
        let store = Store::open(&storage, key, log.clone()).expect("store");
        (posture, store)
    }

    fn mode_of(path: &Path) -> u32 {
        fs::symlink_metadata(path)
            .expect("the path is there")
            .permissions()
            .mode()
            & 0o777
    }

    #[test]
    fn a_restored_setup_token_is_corrected_before_the_line_that_states_its_mode() {
        let dir = TempDir::new("serve-token-restored");
        let cfg = config(&dir);
        // A restore hands over the standing recovery login, readable by
        // every account on the host.
        let file = PathClass::SetupToken.path(&cfg.journal_dir);
        fs::create_dir_all(PathClass::JournalRoot.path(&cfg.journal_dir)).expect("journal root");
        let restored = "ab".repeat(32);
        fs::write(&file, &restored).expect("the token is restored");
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).expect("weak mode");

        let log = Log::buffered(LogLevel::Debug);
        let (posture, store) = start(&cfg, &log);
        let token = setup_token(&cfg, &store, &posture, &log).expect("the token is read");

        assert_eq!(
            token,
            Some(restored),
            "the standing recovery login survives a restart"
        );
        assert_eq!(mode_of(&file), 0o600, "and is no longer readable widely");
        let captured = log.captured();
        assert!(
            captured.contains(
                "event=posture path_class=setup_token decision=repaired from=0644 to=0600"
            ),
            "{captured}"
        );
        assert!(
            captured.contains(
                "event=setup_token_ready file=\"<journal volume>/v1/setup-token\" \
                               mode=0600 state=awaiting_setup"
            ),
            "{captured}"
        );
    }

    #[test]
    fn a_minted_setup_token_states_the_mode_the_volume_was_read_at() {
        let dir = TempDir::new("serve-token-minted");
        let cfg = config(&dir);
        let log = Log::buffered(LogLevel::Debug);
        let (posture, store) = start(&cfg, &log);

        let token = setup_token(&cfg, &store, &posture, &log).expect("the token is minted");
        let file = PathClass::SetupToken.path(&cfg.journal_dir);
        assert_eq!(
            token.as_ref().expect("a token").len(),
            TOKEN_HEX_LEN,
            "32 random bytes as hex"
        );
        assert_eq!(mode_of(&file), 0o600);
        assert!(
            log.captured().contains("mode=0600 state=awaiting_setup"),
            "{}",
            log.captured()
        );
        // A second start reads the same one and says nothing about repairs.
        let again = Log::buffered(LogLevel::Debug);
        let (posture, store) = start(&cfg, &again);
        assert_eq!(
            setup_token(&cfg, &store, &posture, &again).expect("read"),
            token
        );
        assert!(
            !again.captured().contains("decision=repaired"),
            "{}",
            again.captured()
        );
    }

    #[test]
    fn a_token_file_that_is_not_a_token_is_refused_and_left_exactly_as_found() {
        let dir = TempDir::new("serve-token-junk");
        let cfg = config(&dir);
        // Whatever stands under the name — a hard link to another of this
        // server's files, a half-written restore — is not a first boot.
        let file = PathClass::SetupToken.path(&cfg.journal_dir);
        fs::create_dir_all(PathClass::JournalRoot.path(&cfg.journal_dir)).expect("journal root");
        fs::write(&file, "not a token\n").expect("junk under the name");
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).expect("0600");

        let log = Log::buffered(LogLevel::Debug);
        let (posture, store) = start(&cfg, &log);
        let err = setup_token(&cfg, &store, &posture, &log)
            .expect_err("a token file that is not a token is not minted over");
        assert!(matches!(err, StoreError::Corrupt(_)), "{err}");
        assert_eq!(
            fs::read_to_string(&file).expect("still there"),
            "not a token\n",
            "nothing is written through a name that holds something else"
        );
        assert!(
            !log.captured().contains("setup_token_ready"),
            "{}",
            log.captured()
        );
    }

    /// The pass runs at the top of a start; the token is measured again where
    /// it is read, so a volume that changes underneath the start is caught.
    #[test]
    fn the_token_is_measured_where_it_is_read_not_only_where_the_pass_looked() {
        let dir = TempDir::new("serve-token-toctou");
        let cfg = config(&dir);
        let log = Log::buffered(LogLevel::Debug);
        let (posture, store) = start(&cfg, &log);

        // After the pass, and before the token is read.
        let file = PathClass::SetupToken.path(&cfg.journal_dir);
        fs::write(&file, "ab".repeat(32)).expect("a token appears");
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).expect("weak mode");

        setup_token(&cfg, &store, &posture, &log).expect("the token is read");
        assert_eq!(mode_of(&file), 0o600, "measured again where it is read");
        assert!(
            log.captured().contains("mode=0600 state=awaiting_setup"),
            "{}",
            log.captured()
        );
    }

    #[test]
    fn a_link_where_the_setup_token_belongs_stops_the_start() {
        let dir = TempDir::new("serve-token-link");
        let cfg = config(&dir);
        fs::create_dir_all(PathClass::JournalRoot.path(&cfg.journal_dir)).expect("journal root");
        let target = dir.path().join("attacker-owned");
        fs::write(&target, "ab".repeat(32)).expect("the target");
        std::os::unix::fs::symlink(&target, PathClass::SetupToken.path(&cfg.journal_dir))
            .expect("the link is planted");

        let log = Log::buffered(LogLevel::Debug);
        let err = Posture::enforce(&cfg.storage(), &log).expect_err("the start refuses");
        assert_eq!(err.code(), "unsafe_posture", "{err}");
        assert!(
            matches!(
                err,
                StoreError::Posture {
                    class: "setup_token",
                    reason: "symlink"
                }
            ),
            "{err}"
        );
    }
}
