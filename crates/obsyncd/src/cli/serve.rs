//! `obsyncd serve`: open the store, start the background work, and serve the
//! API, the dashboard, and the plugin bundle until a signal arrives.
//!
//! Every ceiling the HTTP server enforces is a constant here
//! (`docs/protocol.md`, "Limits and headers"); only the connection count is
//! configuration, because it is a capacity choice and not a security one.
#![forbid(unsafe_code)]

use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::thread::{JoinHandle, sleep};
use std::time::{Duration, Instant};

use obsync_core::http::{Limits, Server};

use crate::api::{self, App};
use crate::config::Config;
use crate::dashboard::Dashboard;
use crate::log::Log;
use crate::plugin_dist::PluginDist;
use crate::storage::Store;
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
/// The first-boot setup token, under the journal volume.
pub const SETUP_TOKEN_FILE: &str = "v1/setup-token";

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
    let shutdown = signal::install();

    let store = match Store::open(&cfg.storage(), cfg.server_key, log.clone()) {
        Ok(store) => store,
        Err(e) => {
            log.error(
                "store_open_failed",
                &[("decision", "exit"), ("error", &format!("{e:?}"))],
            );
            return 1;
        }
    };

    let setup_token = match setup_token(&cfg, &store, &log) {
        Ok(token) => token,
        Err(e) => {
            log.error(
                "setup_token_failed",
                &[("decision", "exit"), ("error", &e.to_string())],
            );
            return 1;
        }
    };

    let limits = Limits {
        max_header_bytes: MAX_HEADER_BYTES,
        header_timeout: HEADER_TIMEOUT,
        idle_timeout: IDLE_TIMEOUT,
        min_body_rate_bytes_per_sec: MIN_BODY_RATE,
        max_connections: cfg.max_connections,
    };
    let mut server = match Server::bind(&cfg.listen, limits) {
        Ok(server) => server,
        Err(e) => {
            log.error(
                "listen_failed",
                &[
                    ("listen", &cfg.listen),
                    ("decision", "exit"),
                    ("error", &e.to_string()),
                ],
            );
            return 1;
        }
    };
    let sink_log = log.clone();
    server.set_error_sink(Arc::new(move |msg: &str| {
        sink_log.warn(
            "http_refused",
            &[("decision", "parser_refusal"), ("detail", msg)],
        );
    }));

    let dashboard = Dashboard::load(&cfg.dashboard_dir, &log);
    let plugin = PluginDist::load(&cfg.plugin_dir, &log);
    let listen = server
        .local_addr()
        .map_or_else(|_| cfg.listen.clone(), |a| a.to_string());
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
            ("version", env!("CARGO_PKG_VERSION")),
            ("listen", &listen),
            ("max_connections", &app.cfg.max_connections.to_string()),
            ("drain_secs", &DRAIN.as_secs().to_string()),
        ],
    );

    let workers = background(&app);
    server.serve(api::handler(Arc::clone(&app)), Arc::clone(&shutdown), DRAIN);

    shutdown.store(true, Ordering::SeqCst);
    for worker in workers {
        let _ = worker.join();
    }
    match app.store.snapshot() {
        Ok(()) => log.info("shutdown_snapshot", &[("decision", "ok")]),
        Err(e) => log.error(
            "shutdown_snapshot",
            &[("decision", "failed"), ("error", &format!("{e:?}"))],
        ),
    }
    log.info("serve_stop", &[("decision", "clean")]);
    0
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
                let started = app.log.start("gc", GC_BUDGET);
                let at = Instant::now();
                app.set_gc_running(true);
                let summary = app.store.gc_run(UnixMs(app.clock.unix_ms()));
                app.set_gc_running(false);
                started.summary(&[
                    ("chunks_collected", &summary.chunks_collected.to_string()),
                    ("bytes_collected", &summary.bytes_collected.to_string()),
                    ("chunks_retained", &summary.chunks_retained.to_string()),
                    ("duration_ms", &at.elapsed().as_millis().to_string()),
                    ("budget_ms", &GC_BUDGET.as_millis().to_string()),
                    (
                        "decision",
                        if at.elapsed() > GC_BUDGET {
                            "over_budget"
                        } else {
                            "ok"
                        },
                    ),
                ]);
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
                            ("nonces", &nonces.to_string()),
                            ("pairings", &pairings.to_string()),
                            ("sessions", &sessions.to_string()),
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
                            ("decision", "retry_next_period"),
                            ("error", &format!("{e:?}")),
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
                            ("decision", "quarantined"),
                            ("mismatches", &summary.mismatches.to_string()),
                            ("quarantined", &summary.quarantined.to_string()),
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
/// login as well as the first-boot credential. Only its first eight
/// characters are ever logged, with the path that holds the rest.
fn setup_token(cfg: &Config, store: &Store, log: &Log) -> std::io::Result<Option<String>> {
    let path = cfg.journal_dir.join(SETUP_TOKEN_FILE);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let existing = std::fs::read_to_string(&path)
        .ok()
        .map(|v| v.trim().to_string());
    let token = match existing {
        Some(v) if v.len() == 64 => v,
        _ => {
            let minted = rand::hex_token(32)?;
            write_private(&path, &minted)?;
            minted
        }
    };
    if store.account().is_none() {
        log.info(
            "setup_token_ready",
            &[
                ("prefix", &token[..8]),
                ("file", &path.display().to_string()),
                ("hint", "the full token is in that file, mode 0600"),
            ],
        );
    } else {
        log.debug("setup_token_ready", &[("recovery_login", "available")]);
    }
    Ok(Some(token))
}

/// Write a credential file readable only by the server's own user.
fn write_private(path: &Path, contents: &str) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut f = options.open(path)?;
    f.write_all(contents.as_bytes())?;
    f.write_all(b"\n")?;
    f.sync_all()?;
    Ok(())
}
