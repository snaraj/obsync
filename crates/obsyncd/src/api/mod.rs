//! The obsync HTTP surface: route resolution, per-request logging, response
//! hardening, and the shared state every handler reads.
//!
//! `docs/protocol.md` is the contract and every route below names the section
//! it implements. Nothing in this tree decrypts content, and no log line or
//! response carries a clear vault path or vault key material (AGENTS.md
//! requirement 6). Every limit and window here is a constant: none of them is
//! reachable from configuration (AGENTS.md requirement 4).
#![forbid(unsafe_code)]

pub mod admin;
pub mod auth;
pub mod changes;
pub mod chunks;
pub mod devices;
pub mod domains;
pub mod edge;
pub mod files;
pub mod pairing;
pub mod plugin;
pub mod rand;
pub mod render;
pub mod setup;

#[cfg(test)]
mod router_test;
#[cfg(test)]
mod server_test;

use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use obsync_core::http::{Handler, Request, Response, ResponseBody};
use obsync_core::json::obj;

use crate::config::Config;
use crate::dashboard::Dashboard;
use crate::log::Log;
use crate::plugin_dist::PluginDist;
use crate::storage::Store;
use crate::storage::types::StoreError;
use crate::types::AccountId;

use self::auth::{Clock, SystemClock};
use self::edge::ClientInfo;
use self::pairing::PairingTable;
use self::render::s;

/// JSON request bodies are refused above this size (`docs/protocol.md`,
/// "Limits and headers").
pub const JSON_BODY_LIMIT: u64 = 4 * 1024 * 1024;
/// Chunk upload bodies are refused above this size.
pub const CHUNK_BODY_LIMIT: u64 = 8 * 1024 * 1024;
/// `POST /v1/chunks/exists` accepts at most this many sids.
pub const EXISTS_MAX_SIDS: usize = 4096;
/// `POST /v1/chunks/get` accepts at most this many sids.
pub const MULTIPART_MAX_SIDS: usize = 64;
/// A batched multipart fetch is refused above this assembled size; the client
/// falls back to `GET /v1/chunks/{sid}`, which streams.
pub const MULTIPART_MAX_TOTAL_BYTES: u64 = 32 * 1024 * 1024;
/// Longest long-poll a change-feed request may ask for, in seconds.
pub const CHANGES_MAX_WAIT_SECS: u64 = 55;
/// Most changes returned by one feed request.
pub const CHANGES_MAX_LIMIT: u64 = 1000;
/// Content-Security-Policy for dashboard (HTML, CSS, JavaScript) responses.
pub const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
/// Decision lines kept in memory for `GET /v1/admin/logs`.
pub const RECENT_LOG_LINES: usize = 512;
/// A device's `sign_in` seen event is journaled at most this often.
pub const SIGN_IN_RECORD_INTERVAL_SECS: u64 = 900;
/// How long a readiness probe result is reused before the volumes are
/// re-probed; bounds the file churn an unauthenticated prober can cause.
pub const READY_CACHE_SECS: u64 = 5;

/// A refusal: the status, the wire code, and the human detail. The code is
/// also the `decision` field of the request log line (requirement 12).
#[derive(Clone, Debug)]
pub struct ApiError {
    /// HTTP status to answer with.
    pub status: u16,
    /// `snake_case` wire code, also the logged decision.
    pub code: &'static str,
    /// Human-readable detail; never carries key material or a vault path.
    pub detail: String,
    /// Extra body fields a refusal carries, such as the `missing` sid list of
    /// `409 missing_chunks`.
    pub fields: Vec<(String, obsync_core::json::Value)>,
}

impl ApiError {
    /// A refusal with an explicit status and code.
    pub fn new(status: u16, code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            status,
            code,
            detail: detail.into(),
            fields: Vec::new(),
        }
    }

    /// Add one field to the refusal body.
    #[must_use]
    pub fn with_field(mut self, name: &str, value: obsync_core::json::Value) -> Self {
        self.fields.push((name.to_string(), value));
        self
    }

    /// `400 bad_request`.
    pub fn bad_request(detail: impl Into<String>) -> Self {
        Self::new(400, "bad_request", detail)
    }

    /// `404 not_found`.
    pub fn not_found(detail: impl Into<String>) -> Self {
        Self::new(404, "not_found", detail)
    }

    /// The wire body: `{"error","detail"}` plus any extra fields
    /// (`docs/protocol.md`).
    pub fn to_response(&self) -> Response {
        let mut fields = vec![
            ("error".to_string(), s(self.code)),
            ("detail".to_string(), s(&self.detail)),
        ];
        fields.extend(self.fields.iter().cloned());
        Response::json(self.status, &obsync_core::json::Value::Object(fields))
    }
}

impl From<StoreError> for ApiError {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::SidMismatch { .. } => {
                ApiError::new(422, "sid_mismatch", "body hash does not equal the sid")
            }
            StoreError::LengthMismatch { .. } => ApiError::new(
                400,
                "length_mismatch",
                "body length does not equal Content-Length",
            ),
            StoreError::VolumeFull { .. } => {
                ApiError::new(507, "volume_full", "free space is below the watermark")
            }
            StoreError::QuotaExceeded { .. } => {
                ApiError::new(507, "quota_exceeded", "account quota exceeded")
            }
            StoreError::MissingChunks(sids) => ApiError::new(
                409,
                "missing_chunks",
                "referenced chunks are not stored; upload them and repost",
            )
            .with_field(
                "missing",
                render::strs(sids.iter().map(ToString::to_string)),
            ),
            // The expected id is a hash of what the client just sent, so
            // naming it leaks nothing and lets a client correct itself.
            StoreError::VersionIdMismatch { expected, .. } => ApiError::new(
                422,
                "version_id_mismatch",
                "version_id does not equal the server recomputation",
            )
            .with_field("expected", s(&expected.to_string())),
            StoreError::SeqAhead { .. } => {
                ApiError::new(416, "seq_ahead", "since is beyond the journal head")
            }
            StoreError::UnknownDevice => ApiError::new(404, "unknown_device", "no such device"),
            StoreError::DeviceRevoked => ApiError::new(403, "device_revoked", "device is revoked"),
            StoreError::UnknownFile => ApiError::new(404, "unknown_file", "no such file"),
            StoreError::UnknownVersion => ApiError::new(404, "unknown_version", "no such version"),
            StoreError::NotSetUp => ApiError::new(409, "not_set_up", "no account exists yet"),
            StoreError::AlreadySetUp => {
                ApiError::new(409, "already_set_up", "the account already exists")
            }
            StoreError::Io(_) => ApiError::new(500, "storage_io", "storage io error"),
            StoreError::Corrupt(_) => {
                ApiError::new(500, "storage_corrupt", "storage inconsistency")
            }
        }
    }
}

/// One request as remembered for `GET /v1/admin/logs`. Exactly the fields of
/// the request log line: no vault path, no body, no key material.
#[derive(Clone, Debug)]
pub struct LogLine {
    /// Unix milliseconds.
    pub ts: u64,
    /// Request method.
    pub method: String,
    /// Route template, never a vault path.
    pub path_class: &'static str,
    /// Device id as claimed by the request, or `-`.
    pub device: String,
    /// Response status.
    pub status: u16,
    /// Response body bytes.
    pub bytes: u64,
    /// Wall time spent in the handler.
    pub duration_ms: u64,
    /// Wire code of the refusal, or `ok`.
    pub decision: String,
}

/// Cached readiness verdict (`docs/protocol.md`, "Health").
struct ReadyCache {
    checked_at: u64,
    verdict: Result<(), &'static str>,
}

/// Everything a handler may read. Constructed once by `cli::serve` and shared
/// by every connection thread.
pub struct App {
    /// Parsed environment configuration.
    pub cfg: Config,
    /// The open store; the only path to durable state.
    pub store: Store,
    /// Structured logger.
    pub log: Log,
    /// Wall-clock source; a fake clock drives the window tests.
    pub clock: Arc<dyn Clock>,
    /// Static dashboard files, read once at start.
    pub dashboard: Dashboard,
    /// Plugin bundle, read once at start.
    pub plugin: PluginDist,
    /// Set by the signal handler; makes `/readyz` false and drains.
    pub shutdown: Arc<AtomicBool>,
    /// First-boot setup token, also the dashboard recovery login.
    pub setup_token: Option<String>,
    nonces: Mutex<auth::NonceCache>,
    pairings: Mutex<PairingTable>,
    sessions: Mutex<admin::SessionTable>,
    seen: Mutex<HashMap<String, u64>>,
    recent: Mutex<VecDeque<LogLine>>,
    ready: Mutex<ReadyCache>,
    gc_requested: AtomicBool,
    scrub_requested: AtomicBool,
}

impl App {
    /// Assemble the application state. `serve` owns every argument already.
    pub fn new(
        cfg: Config,
        store: Store,
        log: Log,
        dashboard: Dashboard,
        plugin: PluginDist,
        shutdown: Arc<AtomicBool>,
        setup_token: Option<String>,
    ) -> Self {
        Self {
            cfg,
            store,
            log,
            clock: Arc::new(SystemClock),
            dashboard,
            plugin,
            shutdown,
            setup_token,
            nonces: Mutex::new(auth::NonceCache::new()),
            pairings: Mutex::new(PairingTable::new()),
            sessions: Mutex::new(admin::SessionTable::new()),
            seen: Mutex::new(HashMap::new()),
            recent: Mutex::new(VecDeque::new()),
            ready: Mutex::new(ReadyCache {
                checked_at: 0,
                verdict: Ok(()),
            }),
            gc_requested: AtomicBool::new(false),
            scrub_requested: AtomicBool::new(false),
        }
    }

    /// Ask the collector to run at its next tick, so `POST /v1/admin/gc/run`
    /// can answer `202` without holding a request open for the whole budget.
    pub fn request_gc(&self) {
        self.gc_requested.store(true, Ordering::SeqCst);
    }

    /// Whether a collection was asked for, clearing the request.
    pub fn take_gc_request(&self) -> bool {
        self.gc_requested.swap(false, Ordering::SeqCst)
    }

    /// Ask the scrubber to start a pass now.
    pub fn request_scrub(&self) {
        self.scrub_requested.store(true, Ordering::SeqCst);
    }

    /// Whether a scrub was asked for, clearing the request.
    pub fn take_scrub_request(&self) -> bool {
        self.scrub_requested.swap(false, Ordering::SeqCst)
    }

    /// Replace the clock. Tests drive the ±300 s window with a fake.
    #[must_use]
    pub fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self {
        self.clock = clock;
        self
    }

    /// The account id, or `409 not_set_up`.
    pub fn account_id(&self) -> Result<AccountId, ApiError> {
        match self.store.account() {
            Some(a) => Ok(a.account_id),
            None => Err(ApiError::new(409, "not_set_up", "no account exists yet")),
        }
    }

    /// Drop expired nonces, pairings, and sessions. Returns the three counts.
    pub fn sweep(&self, now: u64) -> (usize, usize, usize) {
        let nonces = self.nonces.lock().expect("nonce cache").sweep(now);
        let pairings = self.pairings.lock().expect("pairings").sweep(now);
        let sessions = self.sessions.lock().expect("sessions").sweep(now);
        (nonces, pairings, sessions)
    }

    /// The last decisions, newest first, optionally one device only.
    pub fn recent_lines(&self, device: Option<&str>, limit: usize) -> Vec<LogLine> {
        let recent = self.recent.lock().expect("recent log");
        recent
            .iter()
            .rev()
            .filter(|l| device.is_none_or(|d| l.device == d))
            .take(limit)
            .cloned()
            .collect()
    }

    /// Truthful readiness: the store is open, every volume takes a write, and
    /// no shutdown is in progress (AGENTS.md requirement 7).
    pub fn readiness(&self) -> Result<(), &'static str> {
        if self.shutdown.load(Ordering::SeqCst) {
            return Err("shutting down");
        }
        let now = self.clock.unix_secs();
        let mut cache = self.ready.lock().expect("ready cache");
        if cache.checked_at != 0 && now.saturating_sub(cache.checked_at) < READY_CACHE_SECS {
            return cache.verdict;
        }
        let verdict = self.probe_volumes();
        cache.checked_at = now;
        cache.verdict = verdict;
        verdict
    }

    fn probe_volumes(&self) -> Result<(), &'static str> {
        if probe_writable(&self.cfg.blobs_dir).is_err() {
            return Err("blobs volume is not writable");
        }
        if probe_writable(&self.cfg.journal_dir).is_err() {
            return Err("journal volume is not writable");
        }
        for m in &self.cfg.blobs_mirrors {
            if probe_writable(m).is_err() {
                return Err("a mirror volume is not writable");
            }
        }
        Ok(())
    }

    /// Serve one request: resolve, enforce the edge requirement, dispatch,
    /// harden the response, and log exactly one line.
    pub fn handle(&self, req: &mut Request) -> Response {
        let start = Instant::now();
        let path = req.path.clone();
        let method = req.method.clone();
        let (class, out) = match resolve(&method, &path) {
            Some((route, class)) => {
                let health = matches!(route, Route::Livez | Route::Readyz);
                let client = edge::derive(&self.cfg, req);
                match (health, client) {
                    (true, _) => (class, self.dispatch(route, req, &ClientInfo::unknown())),
                    (false, Ok(c)) => (class, self.dispatch(route, req, &c)),
                    (false, Err(e)) => (class, Err(e)),
                }
            }
            None => (
                "/unknown",
                Err(ApiError::not_found("no route for this method and path")),
            ),
        };
        let (resp, decision) = match out {
            Ok(r) => {
                let d: &str = if r.status >= 400 { "refused" } else { "ok" };
                (r, d.to_string())
            }
            Err(e) => {
                let d = e.code.to_string();
                (e.to_response(), d)
            }
        };
        self.finish(req, resp, class, decision, start)
    }

    fn dispatch(
        &self,
        route: Route,
        req: &mut Request,
        client: &ClientInfo,
    ) -> Result<Response, ApiError> {
        match route {
            Route::Livez => Ok(Response::text(200, "ok")),
            Route::Readyz => self.readyz(),
            Route::Setup => setup::create(self, req),
            Route::Account => setup::account(self, req, client),
            Route::PairingCreate => pairing::create(self, req, client),
            Route::PairingClaim(id) => pairing::claim(self, req, client, &id),
            Route::PairingState(id) => pairing::state(self, req, client, &id),
            Route::PairingApprove(id) => pairing::approve(self, req, client, &id),
            Route::PairingReject(id) => pairing::reject(self, req, client, &id),
            Route::PairingEnvelope(id) => pairing::envelope(self, req, client, &id),
            Route::Devices => devices::list(self, req, client),
            Route::DevicePatch(id) => devices::patch(self, req, client, &id),
            Route::DeviceRevoke(id) => devices::revoke(self, req, client, &id),
            Route::Heartbeat => devices::heartbeat(self, req, client),
            Route::ChunksExists => chunks::exists(self, req, client),
            Route::ChunksGet => chunks::batch_get(self, req, client),
            Route::ChunkPut(sid) => chunks::put(self, req, client, &sid),
            Route::ChunkGet(sid) => chunks::get(self, req, client, &sid),
            Route::VersionPost(file) => files::post_version(self, req, client, &file),
            Route::FileGet(file) => files::get_file(self, req, client, &file),
            Route::VersionGet(file, version) => {
                files::get_version(self, req, client, &file, &version)
            }
            Route::FilesPage => files::page(self, req, client),
            Route::Changes => changes::feed(self, req, client),
            Route::DomainsList => domains::list(self, req, client),
            Route::DomainCreate => domains::create(self, req, client),
            Route::LoginLink => admin::login_link(self, req, client),
            Route::Login => admin::login(self, req),
            Route::Logout => admin::logout(self, req),
            Route::AdminOverview => admin::overview(self, req),
            Route::AdminDevices => admin::devices(self, req),
            Route::AdminRevoke(id) => admin::revoke(self, req, &id),
            Route::AdminStorage => admin::storage(self, req),
            Route::AdminGcRun => admin::gc_run(self, req),
            Route::AdminScrubRun => admin::scrub_run(self, req),
            Route::AdminDomains => admin::domains(self, req),
            Route::AdminEscrowSet(id) => admin::escrow_set(self, req, &id),
            Route::AdminEscrowClear(id) => admin::escrow_clear(self, req, &id),
            Route::AdminLogs => admin::logs(self, req),
            Route::PluginManifest => plugin::manifest(self),
            Route::PluginBundle => plugin::bundle(self),
            Route::PluginStyles => plugin::styles(self),
            Route::DashboardFile(name) => self.dashboard.serve(&name),
        }
    }

    fn readyz(&self) -> Result<Response, ApiError> {
        let seq = self.store.head_seq();
        match self.readiness() {
            Ok(()) => Ok(Response::json(
                200,
                &obj(vec![("ready", render::b(true)), ("seq", render::seq(seq))]),
            )),
            Err(reason) => Err(ApiError::new(503, "not_ready", reason)),
        }
    }

    fn finish(
        &self,
        req: &Request,
        resp: Response,
        class: &'static str,
        decision: String,
        start: Instant,
    ) -> Response {
        let seq = self.store.head_seq();
        let status = resp.status;
        let bytes = match &resp.body {
            ResponseBody::Empty => 0,
            ResponseBody::Bytes(b) => b.len() as u64,
            ResponseBody::Stream { len, .. } => *len,
        };
        let line = LogLine {
            ts: self.clock.unix_ms(),
            method: req.method.clone(),
            path_class: class,
            device: device_field(req),
            status,
            bytes,
            duration_ms: start.elapsed().as_millis() as u64,
            decision,
        };
        self.emit(&line);
        {
            let mut recent = self.recent.lock().expect("recent log");
            if recent.len() == RECENT_LOG_LINES {
                recent.pop_front();
            }
            recent.push_back(line);
        }
        resp.header("Cache-Control", "no-store")
            .header("X-Content-Type-Options", "nosniff")
            .header("X-Frame-Options", "DENY")
            .header("Referrer-Policy", "no-referrer")
            .header("X-Obsync-Seq", &format!("{}", render::seq_u64(seq)))
    }

    fn emit(&self, line: &LogLine) {
        let status = format!("{}", line.status);
        let bytes = format!("{}", line.bytes);
        let duration = format!("{}", line.duration_ms);
        let fields: [(&str, &str); 7] = [
            ("method", line.method.as_str()),
            ("path_class", line.path_class),
            ("device", line.device.as_str()),
            ("status", status.as_str()),
            ("bytes", bytes.as_str()),
            ("duration_ms", duration.as_str()),
            ("decision", line.decision.as_str()),
        ];
        if line.status >= 500 {
            self.log.error("request", &fields);
        } else if line.status >= 400 {
            self.log.warn("request", &fields);
        } else {
            self.log.info("request", &fields);
        }
    }
}

/// Wrap the application in the handler the HTTP server calls.
pub fn handler(app: Arc<App>) -> Handler {
    Arc::new(move |req: &mut Request| app.handle(req))
}

/// The claimed device id, reduced to 32 lowercase hex characters or `-`. No
/// header value reaches a log line unsanitized.
fn device_field(req: &Request) -> String {
    match req.headers.get("x-obsync-device") {
        Some(v) if is_hex(v, 32) => v.to_string(),
        _ => "-".to_string(),
    }
}

/// True when `v` is exactly `n` lowercase hex characters.
pub fn is_hex(v: &str, n: usize) -> bool {
    v.len() == n
        && v.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// Write, fsync, and remove a probe file: proof the volume takes a write now.
fn probe_writable(dir: &std::path::Path) -> std::io::Result<()> {
    let path = dir.join(".obsync-readyz");
    let mut f = std::fs::File::create(&path)?;
    f.write_all(b"obsync readyz probe\n")?;
    f.sync_all()?;
    drop(f);
    std::fs::remove_file(&path)
}

/// One resolved route. Captured ids are owned so the borrow of the request
/// path ends before a handler takes the request mutably.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Route {
    /// `GET /livez`
    Livez,
    /// `GET /readyz`
    Readyz,
    /// `POST /v1/setup`
    Setup,
    /// `GET /v1/account`
    Account,
    /// `POST /v1/pairing`
    PairingCreate,
    /// `POST /v1/pairing/{id}/claim`
    PairingClaim(String),
    /// `GET /v1/pairing/{id}`
    PairingState(String),
    /// `POST /v1/pairing/{id}/approve`
    PairingApprove(String),
    /// `POST /v1/pairing/{id}/reject`
    PairingReject(String),
    /// `GET /v1/pairing/{id}/envelope`
    PairingEnvelope(String),
    /// `GET /v1/devices`
    Devices,
    /// `PATCH /v1/devices/{id}`
    DevicePatch(String),
    /// `POST /v1/devices/{id}/revoke`
    DeviceRevoke(String),
    /// `POST /v1/devices/heartbeat`
    Heartbeat,
    /// `POST /v1/chunks/exists`
    ChunksExists,
    /// `POST /v1/chunks/get`
    ChunksGet,
    /// `PUT /v1/chunks/{sid}`
    ChunkPut(String),
    /// `GET /v1/chunks/{sid}`
    ChunkGet(String),
    /// `POST /v1/files/{file_id}/versions`
    VersionPost(String),
    /// `GET /v1/files/{file_id}`
    FileGet(String),
    /// `GET /v1/files/{file_id}/versions/{version_id}`
    VersionGet(String, String),
    /// `GET /v1/files`
    FilesPage,
    /// `GET /v1/changes`
    Changes,
    /// `GET /v1/domains`
    DomainsList,
    /// `POST /v1/domains`
    DomainCreate,
    /// `POST /v1/dashboard/login-link`
    LoginLink,
    /// `GET /login`
    Login,
    /// `POST /v1/admin/logout`
    Logout,
    /// `GET /v1/admin/overview`
    AdminOverview,
    /// `GET /v1/admin/devices`
    AdminDevices,
    /// `POST /v1/admin/devices/{id}/revoke`
    AdminRevoke(String),
    /// `GET /v1/admin/storage`
    AdminStorage,
    /// `POST /v1/admin/gc/run`
    AdminGcRun,
    /// `POST /v1/admin/scrub/run`
    AdminScrubRun,
    /// `GET /v1/admin/domains`
    AdminDomains,
    /// `POST /v1/admin/domains/{id}/escrow`
    AdminEscrowSet(String),
    /// `DELETE /v1/admin/domains/{id}/escrow`
    AdminEscrowClear(String),
    /// `GET /v1/admin/logs`
    AdminLogs,
    /// `GET /v1/plugin/manifest`
    PluginManifest,
    /// `GET /v1/plugin/bundle`
    PluginBundle,
    /// `GET /v1/plugin/styles`
    PluginStyles,
    /// A dashboard static file (`index.html`, `app.css`, `app.js`, `lib.js`).
    DashboardFile(String),
}

/// Method plus path to a route and its log path class. `None` is a 404: this
/// table is the whole of `docs/protocol.md` and nothing else is served.
pub fn resolve(method: &str, path: &str) -> Option<(Route, &'static str)> {
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let r = match (method, segs.as_slice()) {
        ("GET", ["livez"]) => (Route::Livez, "/livez"),
        ("GET", ["readyz"]) => (Route::Readyz, "/readyz"),

        ("POST", ["v1", "setup"]) => (Route::Setup, "/v1/setup"),
        ("GET", ["v1", "account"]) => (Route::Account, "/v1/account"),

        ("POST", ["v1", "pairing"]) => (Route::PairingCreate, "/v1/pairing"),
        ("POST", ["v1", "pairing", id, "claim"]) => (
            Route::PairingClaim((*id).to_string()),
            "/v1/pairing/{id}/claim",
        ),
        ("GET", ["v1", "pairing", id]) => {
            (Route::PairingState((*id).to_string()), "/v1/pairing/{id}")
        }
        ("POST", ["v1", "pairing", id, "approve"]) => (
            Route::PairingApprove((*id).to_string()),
            "/v1/pairing/{id}/approve",
        ),
        ("POST", ["v1", "pairing", id, "reject"]) => (
            Route::PairingReject((*id).to_string()),
            "/v1/pairing/{id}/reject",
        ),
        ("GET", ["v1", "pairing", id, "envelope"]) => (
            Route::PairingEnvelope((*id).to_string()),
            "/v1/pairing/{id}/envelope",
        ),

        ("GET", ["v1", "devices"]) => (Route::Devices, "/v1/devices"),
        ("POST", ["v1", "devices", "heartbeat"]) => (Route::Heartbeat, "/v1/devices/heartbeat"),
        ("PATCH", ["v1", "devices", id]) => {
            (Route::DevicePatch((*id).to_string()), "/v1/devices/{id}")
        }
        ("POST", ["v1", "devices", id, "revoke"]) => (
            Route::DeviceRevoke((*id).to_string()),
            "/v1/devices/{id}/revoke",
        ),

        ("POST", ["v1", "chunks", "exists"]) => (Route::ChunksExists, "/v1/chunks/exists"),
        ("POST", ["v1", "chunks", "get"]) => (Route::ChunksGet, "/v1/chunks/get"),
        ("PUT", ["v1", "chunks", sid]) => (Route::ChunkPut((*sid).to_string()), "/v1/chunks/{sid}"),
        ("GET", ["v1", "chunks", sid]) => (Route::ChunkGet((*sid).to_string()), "/v1/chunks/{sid}"),

        ("GET", ["v1", "files"]) => (Route::FilesPage, "/v1/files"),
        ("POST", ["v1", "files", f, "versions"]) => (
            Route::VersionPost((*f).to_string()),
            "/v1/files/{file_id}/versions",
        ),
        ("GET", ["v1", "files", f, "versions", v]) => (
            Route::VersionGet((*f).to_string(), (*v).to_string()),
            "/v1/files/{file_id}/versions/{version_id}",
        ),
        ("GET", ["v1", "files", f]) => (Route::FileGet((*f).to_string()), "/v1/files/{file_id}"),

        ("GET", ["v1", "changes"]) => (Route::Changes, "/v1/changes"),

        ("GET", ["v1", "domains"]) => (Route::DomainsList, "/v1/domains"),
        ("POST", ["v1", "domains"]) => (Route::DomainCreate, "/v1/domains"),

        ("POST", ["v1", "dashboard", "login-link"]) => {
            (Route::LoginLink, "/v1/dashboard/login-link")
        }
        ("GET", ["login"]) => (Route::Login, "/login"),
        ("POST", ["v1", "admin", "logout"]) => (Route::Logout, "/v1/admin/logout"),
        ("GET", ["v1", "admin", "overview"]) => (Route::AdminOverview, "/v1/admin/overview"),
        ("GET", ["v1", "admin", "devices"]) => (Route::AdminDevices, "/v1/admin/devices"),
        ("POST", ["v1", "admin", "devices", id, "revoke"]) => (
            Route::AdminRevoke((*id).to_string()),
            "/v1/admin/devices/{id}/revoke",
        ),
        ("GET", ["v1", "admin", "storage"]) => (Route::AdminStorage, "/v1/admin/storage"),
        ("POST", ["v1", "admin", "gc", "run"]) => (Route::AdminGcRun, "/v1/admin/gc/run"),
        ("POST", ["v1", "admin", "scrub", "run"]) => (Route::AdminScrubRun, "/v1/admin/scrub/run"),
        ("GET", ["v1", "admin", "domains"]) => (Route::AdminDomains, "/v1/admin/domains"),
        ("POST", ["v1", "admin", "domains", id, "escrow"]) => (
            Route::AdminEscrowSet((*id).to_string()),
            "/v1/admin/domains/{id}/escrow",
        ),
        ("DELETE", ["v1", "admin", "domains", id, "escrow"]) => (
            Route::AdminEscrowClear((*id).to_string()),
            "/v1/admin/domains/{id}/escrow",
        ),
        ("GET", ["v1", "admin", "logs"]) => (Route::AdminLogs, "/v1/admin/logs"),

        ("GET", ["v1", "plugin", "manifest"]) => (Route::PluginManifest, "/v1/plugin/manifest"),
        ("GET", ["v1", "plugin", "bundle"]) => (Route::PluginBundle, "/v1/plugin/bundle"),
        ("GET", ["v1", "plugin", "styles"]) => (Route::PluginStyles, "/v1/plugin/styles"),

        ("GET", []) => (Route::DashboardFile("index.html".to_string()), "/"),
        ("GET", [name]) if matches!(*name, "index.html" | "app.css" | "app.js" | "lib.js") => (
            Route::DashboardFile((*name).to_string()),
            "/{dashboard_file}",
        ),
        _ => return None,
    };
    Some(r)
}
