//! End-to-end tests: a real server on `127.0.0.1:0`, a real store on a
//! temporary volume, and a hand-written signing client over `std::net`.
//!
//! No test asserts against an internal call: every one of them speaks the wire
//! protocol of `docs/protocol.md`, so a refactor that keeps the contract keeps
//! the suite green and a change to the contract is caught here.
#![forbid(unsafe_code)]

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use obsync_core::hex;
use obsync_core::http::{Limits, Server};
use obsync_core::json::{Value, parse};
use obsync_core::{hmac, sha256};

use crate::api::auth::{Clock, FakeClock};
use crate::api::{App, handler};
use crate::config::{Config, Edge};
use crate::dashboard::Dashboard;
use crate::log::{Log, LogLevel};
use crate::plugin_dist::PluginDist;
use crate::storage::{Posture, Store, load_or_create_server_key};

/// The frozen wall clock every test signs against.
const NOW: u64 = 1_757_200_000;

/// A unique temporary directory per harness.
static COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_dir(tag: &str) -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("obsync-api-{}-{tag}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    // Its own resolved form: the posture pass refuses a configured volume
    // directory that is not (`/var` is a link on macOS).
    std::fs::canonicalize(&dir).expect("temp dir resolves")
}

/// A running server with its store, its client, and its cleanup.
struct Harness {
    dir: PathBuf,
    app: Arc<App>,
    clock: Arc<FakeClock>,
    shutdown: Arc<AtomicBool>,
    addr: SocketAddr,
    server: Option<JoinHandle<()>>,
}

/// How a harness is set up.
#[derive(Default)]
struct Setup {
    edge_mode: bool,
    dashboard: bool,
    plugin: bool,
    /// Accumulate the structured log in memory instead of writing it to
    /// stderr, so a test can read the decision line a refusal owes
    /// (requirement 12). Off by default: every other test measures behavior
    /// through the wire, and a buffer nobody reads is just memory.
    capture_log: bool,
}

impl Harness {
    fn start(tag: &str) -> Self {
        Self::start_with(tag, Setup::default())
    }

    fn start_with(tag: &str, setup: Setup) -> Self {
        let dir = temp_dir(tag);
        let blobs = dir.join("blobs");
        let journal = dir.join("journal");
        let dashboard_dir = dir.join("dashboard");
        let plugin_dir = dir.join("plugin");
        for d in [&blobs, &journal] {
            std::fs::create_dir_all(d).expect("volume");
        }
        if setup.dashboard {
            std::fs::create_dir_all(&dashboard_dir).expect("dashboard dir");
            for (name, body) in [
                ("index.html", "<!doctype html><title>obsync</title>"),
                ("app.css", ":root{color-scheme:dark}"),
                ("app.js", "export const boot=()=>{};"),
                ("lib.js", "export const fmt=(n)=>n;"),
            ] {
                std::fs::write(dashboard_dir.join(name), body).expect("dashboard fixture");
            }
        }
        if setup.plugin {
            std::fs::create_dir_all(&plugin_dir).expect("plugin dir");
            std::fs::write(
                plugin_dir.join("manifest.json"),
                br#"{"id":"obsync","version":"0.1.0"}"#,
            )
            .expect("manifest fixture");
            std::fs::write(plugin_dir.join("main.js"), b"export default {};").expect("bundle");
            std::fs::write(plugin_dir.join("styles.css"), b".obsync{}").expect("styles");
        }

        let edge = if setup.edge_mode {
            Edge::requiring_headers()
        } else {
            Edge::None
        };
        let pairs: Vec<(String, String)> = [
            ("OBSYNC_BLOBS_DIR", blobs.display().to_string()),
            ("OBSYNC_JOURNAL_DIR", journal.display().to_string()),
            ("OBSYNC_BLOBS_CAPACITY", "64MiB".to_string()),
            ("OBSYNC_JOURNAL_CAPACITY", "16MiB".to_string()),
            // A test volume is tiny, so the shipped 2 GiB watermark would
            // refuse the first byte. The threshold itself is exercised by the
            // storage lane's own tests.
            ("OBSYNC_FREE_WATERMARK", "1%,64KiB".to_string()),
            ("OBSYNC_DASHBOARD_DIR", dashboard_dir.display().to_string()),
            ("OBSYNC_PLUGIN_DIR", plugin_dir.display().to_string()),
            ("OBSYNC_EDGE", edge.as_word().to_string()),
            ("OBSYNC_SERVER_KEY", "aa".repeat(32)),
            ("OBSYNC_PUBLIC_URL", "http://127.0.0.1".to_string()),
            ("OBSYNC_LOG", "error".to_string()),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        let cfg = Config::from_pairs(&pairs).expect("configuration");
        let log = if setup.capture_log {
            Log::buffered(LogLevel::Debug)
        } else {
            Log::new(cfg.log_level)
        };
        let storage = cfg.storage();
        let posture = Posture::enforce(&storage, &log).expect("volume posture");
        let server_key =
            load_or_create_server_key(&storage.journal_dir, cfg.server_key, &posture, &log)
                .expect("server key");
        let store = Store::open(&storage, server_key, &posture, log.clone()).expect("store");

        let dashboard = if setup.dashboard {
            Dashboard::load(&dashboard_dir, &log)
        } else {
            Dashboard::unavailable()
        };
        let plugin = if setup.plugin {
            PluginDist::load(&plugin_dir, &log)
        } else {
            PluginDist::unavailable()
        };

        let shutdown = Arc::new(AtomicBool::new(false));
        let clock = Arc::new(FakeClock::new(NOW));
        let app = Arc::new(
            App::new(
                cfg,
                store,
                dashboard,
                plugin,
                Arc::clone(&shutdown),
                Some("5e".repeat(32)),
                Arc::clone(&clock) as Arc<dyn Clock>,
            )
            .expect("the application state opens"),
        );

        let server = Server::bind("127.0.0.1:0", Limits::default()).expect("bind");
        let addr = server.local_addr();
        let serve_app = Arc::clone(&app);
        let serve_shutdown = Arc::clone(&shutdown);
        let handle = std::thread::spawn(move || {
            server.serve(
                handler(serve_app),
                serve_shutdown,
                Duration::from_millis(200),
            );
        });

        Self {
            dir,
            app,
            clock,
            shutdown,
            addr,
            server: Some(handle),
        }
    }

    /// Everything the structured log has written, for a `capture_log`
    /// harness. Empty otherwise.
    fn captured(&self) -> String {
        self.app.log.captured()
    }

    /// Create the account and return the first device's credential.
    fn setup_account(&self) -> Cred {
        let body = format!(
            r#"{{"setup_token":"{}","account_name":"vault","device":{{"name":"laptop","platform":"macos","app_version":"0.1.0"}}}}"#,
            "5e".repeat(32)
        );
        let res = Req::post("/v1/setup").body(&body).send(self.addr);
        assert_eq!(res.status, 201, "setup: {}", res.text());
        let v = res.json();
        Cred::from_json(&v)
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        // Wake the acceptor so it notices the flag. The thread is dropped
        // rather than joined: a test must fail on its own assertion, never by
        // hanging in cleanup on a server that did not stop.
        let _ = TcpStream::connect(self.addr);
        drop(self.server.take());
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// A device credential the test client signs with.
#[derive(Clone)]
struct Cred {
    id: String,
    secret: [u8; 32],
}

impl Cred {
    fn from_json(v: &Value) -> Self {
        let id = v
            .get("device_id")
            .and_then(Value::as_str)
            .expect("device_id")
            .to_string();
        let secret_hex = v
            .get("device_secret")
            .and_then(Value::as_str)
            .expect("device_secret")
            .to_string();
        Self {
            id,
            secret: hex::decode_array::<32>(&secret_hex).expect("secret hex"),
        }
    }
}

/// Fresh nonces without a random source.
static NONCE: AtomicU64 = AtomicU64::new(1);

fn nonce() -> String {
    format!("{:032x}", NONCE.fetch_add(1, Ordering::SeqCst))
}

/// One request under construction.
struct Req {
    method: String,
    target: String,
    body: Vec<u8>,
    headers: Vec<(String, String)>,
}

impl Req {
    fn new(method: &str, target: &str) -> Self {
        Self {
            method: method.to_string(),
            target: target.to_string(),
            body: Vec::new(),
            headers: Vec::new(),
        }
    }

    fn get(target: &str) -> Self {
        Self::new("GET", target)
    }

    fn post(target: &str) -> Self {
        Self::new("POST", target)
    }

    fn body(mut self, body: &str) -> Self {
        self.body = body.as_bytes().to_vec();
        self
    }

    fn raw_body(mut self, body: &[u8]) -> Self {
        self.body = body.to_vec();
        self
    }

    fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_string(), value.to_string()));
        self
    }

    /// Sign with the body hash the protocol asks for.
    fn sign(self, cred: &Cred, ts: u64) -> Self {
        let hash = hex::encode(&sha256::sha256(&self.body));
        self.sign_with(cred, ts, &nonce(), &hash)
    }

    /// Sign with an explicit timestamp, nonce, and body hash.
    fn sign_with(mut self, cred: &Cred, ts: u64, nonce: &str, body_hash: &str) -> Self {
        let canonical = crate::api::auth::canonical(
            &self.method,
            &self.target,
            &ts.to_string(),
            nonce,
            body_hash,
        );
        let sig = hex::encode(&hmac::hmac_sha256(&cred.secret, canonical.as_bytes()));
        self.headers
            .push(("X-Obsync-Device".to_string(), cred.id.clone()));
        self.headers
            .push(("X-Obsync-Ts".to_string(), ts.to_string()));
        self.headers
            .push(("X-Obsync-Nonce".to_string(), nonce.to_string()));
        self.headers.push(("X-Obsync-Sig".to_string(), sig));
        self
    }

    fn send(self, addr: SocketAddr) -> Res {
        let mut stream = TcpStream::connect(addr).expect("connect");
        stream
            .set_read_timeout(Some(Duration::from_secs(30)))
            .expect("read timeout");
        let mut head = format!(
            "{} {} HTTP/1.1\r\nHost: 127.0.0.1\r\n",
            self.method, self.target
        );
        for (name, value) in &self.headers {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        head.push_str(&format!("Content-Length: {}\r\n", self.body.len()));
        head.push_str("Connection: close\r\n\r\n");
        stream.write_all(head.as_bytes()).expect("write head");
        stream.write_all(&self.body).expect("write body");
        stream.flush().expect("flush");

        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).expect("read response");
        Res::parse(&raw)
    }
}

/// One parsed response.
struct Res {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Res {
    fn parse(raw: &[u8]) -> Self {
        let split = raw
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .unwrap_or_else(|| panic!("no header terminator in {} bytes", raw.len()));
        let head = String::from_utf8_lossy(&raw[..split]).to_string();
        let body = raw[split + 4..].to_vec();
        let mut lines = head.split("\r\n");
        let status_line = lines.next().expect("status line");
        let status: u16 = status_line
            .split_whitespace()
            .nth(1)
            .and_then(|v| v.parse().ok())
            .unwrap_or_else(|| panic!("no status in {status_line:?}"));
        let headers = lines
            .filter_map(|l| l.split_once(':'))
            .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
            .collect();
        Self {
            status,
            headers,
            body,
        }
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    fn headers_all(&self, name: &str) -> Vec<&str> {
        self.headers
            .iter()
            .filter(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
            .collect()
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).to_string()
    }

    fn json(&self) -> Value {
        parse(&self.body).unwrap_or_else(|_| panic!("not JSON: {}", self.text()))
    }

    fn code(&self) -> String {
        self.json()
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    }
}

#[test]
fn health_endpoints_answer_and_every_response_is_hardened() {
    let h = Harness::start("health");
    let res = Req::get("/livez").send(h.addr);
    assert_eq!(res.status, 200);
    assert_eq!(res.text(), "ok");
    assert_eq!(res.header("cache-control"), Some("no-store"));
    assert_eq!(res.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(res.header("x-frame-options"), Some("DENY"));
    assert_eq!(res.header("referrer-policy"), Some("no-referrer"));
    // The journal head is not part of that set: it is write activity, and it
    // rides a response only when the caller proved a credential.
    assert_eq!(
        res.header("x-obsync-seq"),
        None,
        "an unauthenticated probe learns nothing about how much the owner writes"
    );

    let res = Req::get("/readyz").send(h.addr);
    assert_eq!(res.status, 200, "{}", res.text());
    assert_eq!(res.json().get("ready").and_then(Value::as_bool), Some(true));
    assert_eq!(res.header("x-obsync-seq"), None, "nor does readiness");

    // And a caller that proved one still gets it: the dashboard's footer
    // reads exactly this header.
    let cred = h.setup_account();
    let authed = Req::get("/v1/account").sign(&cred, NOW).send(h.addr);
    assert_eq!(authed.status, 200, "{}", authed.text());
    assert!(
        authed.header("x-obsync-seq").is_some(),
        "an authenticated response still carries the journal head"
    );
    assert_eq!(authed.header("cache-control"), Some("no-store"));

    // A refusal of the credential itself is not a credentialed response.
    let refused = Req::get("/v1/account").send(h.addr);
    assert_eq!(refused.status, 401);
    assert_eq!(
        refused.header("x-obsync-seq"),
        None,
        "a 401 must not answer what an authenticated read would"
    );
}

#[test]
fn readyz_tells_the_truth_about_the_volumes_and_about_shutting_down() {
    let h = Harness::start("readyz");
    assert_eq!(Req::get("/readyz").send(h.addr).status, 200);

    // A volume that stops taking writes makes readiness false over the wire.
    // The volume is stashed and a regular FILE put where it belongs, so the
    // probe's create under it fails with ENOTDIR. Permissions would not do:
    // the in-image test stage runs as root, and root ignores a mode that says
    // read-only, which is exactly how this test used to pass on a laptop and
    // fail inside the release image.
    let blobs = h.dir.join("blobs");
    let stashed = h.dir.join("blobs-stashed");
    std::fs::rename(&blobs, &stashed).expect("stash the volume");
    std::fs::write(&blobs, b"not a directory\n").expect("occupy the mount point");
    // The clock moves past the probe cache so the verdict is re-measured
    // rather than remembered.
    h.clock.set(NOW + crate::api::READY_CACHE_SECS + 1);
    let refused = Req::get("/readyz").send(h.addr);
    std::fs::remove_file(&blobs).expect("free the mount point");
    std::fs::rename(&stashed, &blobs).expect("restore");
    assert_eq!(refused.status, 503, "{}", refused.text());
    assert_eq!(refused.code(), "not_ready");
    assert_eq!(
        refused.json().get("detail").and_then(Value::as_str),
        Some("blobs volume is not writable"),
        "the refusal names the probe that failed, not the shutdown flag"
    );

    // And a shutdown makes it false immediately, before the listener stops:
    // the probe answers from the flag, not from the volumes.
    h.shutdown.store(true, Ordering::SeqCst);
    assert!(
        h.app.readiness().is_err(),
        "readiness is false the moment a shutdown starts"
    );
    h.shutdown.store(false, Ordering::SeqCst);
    h.clock.set(NOW + 2 * crate::api::READY_CACHE_SECS + 2);
    assert_eq!(
        Req::get("/readyz").send(h.addr).status,
        200,
        "and true again once the volume takes writes"
    );
}

#[test]
fn a_journal_whose_usage_is_unverified_answers_readyz_and_recovers_without_a_write() {
    // The other half of the accounting refusal, over the wire. A journal that
    // could not re-read its own usage refuses every write, so readiness must
    // say so -- and, unlike the faulted state, this one clears itself the
    // moment a survey succeeds. Readiness is where that survey is retried, so
    // an operator who fixes the volume watches the server come back on the
    // next probe instead of having to send a write to find out.
    let h = Harness::start("journal-unverified");
    assert_eq!(Req::get("/readyz").send(h.addr).status, 200);
    let cred = h.setup_account();

    // A directory where the snapshot's destination belongs refuses the
    // rename; a FILE where the quarantine directory belongs then refuses the
    // survey that would account for what the refused rename left behind.
    // Both fail, which is the case the accounting cannot recover from on its
    // own. Neither fixture is a mode: this suite runs as root inside the
    // release image, and root walks a directory whose mode forbids it.
    let index_dir = h.dir.join("journal/v1/index");
    let quarantine = h.dir.join("journal/v1/quarantine");
    let seq = h.app.store.head_seq();
    std::fs::create_dir_all(index_dir.join(format!("{seq}.snap"))).expect("block the rename");
    std::fs::write(&quarantine, b"not a directory\n").expect("block the survey");
    h.app
        .store
        .snapshot()
        .expect_err("the snapshot and its survey both fail");

    // Writes refuse with their own code, distinct from a faulted journal:
    // nothing here needs a restart.
    let refused = Req::new("PATCH", &format!("/v1/devices/{}", cred.id))
        .body(r#"{"name":"studio laptop"}"#)
        .sign(&cred, NOW)
        .send(h.addr);
    assert_eq!(refused.status, 503, "{}", refused.text());
    assert_eq!(refused.code(), "journal_unverified");

    // Readiness answers false, and names the kind that refused the survey.
    h.clock.set(NOW + crate::api::READY_CACHE_SECS + 1);
    let not_ready = Req::get("/readyz").send(h.addr);
    assert_eq!(not_ready.status, 503, "{}", not_ready.text());
    assert_eq!(not_ready.code(), "not_ready");
    assert_eq!(
        not_ready.json().get("detail").and_then(Value::as_str),
        Some("journal usage unverified; survey failed: NotADirectory"),
        "the refusal names the accounting and the kind, never a path"
    );

    // The operator fixes the volume, and NOTHING is written afterwards: the
    // probe itself re-surveys, the state clears, and readiness is true again.
    std::fs::remove_file(&quarantine).expect("free the name");
    h.clock.set(NOW + 2 * crate::api::READY_CACHE_SECS + 2);
    let ready = Req::get("/readyz").send(h.addr);
    assert_eq!(ready.status, 200, "{}", ready.text());
    assert_eq!(
        h.app.store.journal_usage_unverified(),
        None,
        "the probe is what cleared it, with no write in between"
    );
    let accepted = Req::new("PATCH", &format!("/v1/devices/{}", cred.id))
        .body(r#"{"name":"studio laptop"}"#)
        .sign(&cred, NOW)
        .send(h.addr);
    assert_eq!(accepted.status, 200, "{}", accepted.text());
}

/// A dashboard session, for the two admin views that carry `render::volume`.
///
/// Deliberately NOT shared with
/// `the_dashboard_session_needs_a_link_and_every_mutation_needs_the_csrf_header`:
/// there the cookie mechanics are the subject and their assertions belong
/// inline; here they are only the way in.
fn admin_cookie(h: &Harness, cred: &Cred) -> String {
    let token = login_token(h, cred);
    let login = Req::get(&format!("/login?token={token}")).send(h.addr);
    assert_eq!(login.status, 302, "{}", login.text());
    cookie_header(&login)
}

/// Mint one dashboard login link on `cred` and return its token, unspent.
fn login_token(h: &Harness, cred: &Cred) -> String {
    let link = Req::post("/v1/dashboard/login-link")
        .sign(cred, NOW)
        .send(h.addr);
    assert_eq!(link.status, 200, "{}", link.text());
    let url = link
        .json()
        .get("url")
        .and_then(Value::as_str)
        .expect("a login url")
        .to_string();
    url.split("token=")
        .nth(1)
        .expect("a token in the url")
        .to_string()
}

/// The `Cookie:` header a browser would send back after a response's
/// `Set-Cookie` lines: the name=value pairs, attributes dropped.
fn cookie_header(res: &Res) -> String {
    res.headers_all("set-cookie")
        .iter()
        .map(|c| c.split(';').next().expect("a cookie pair").to_string())
        .collect::<Vec<_>>()
        .join("; ")
}

/// The double-submit value out of such a header, for the `X-Obsync-Csrf`
/// header every mutation carries.
fn csrf_value(cookie_header: &str) -> String {
    cookie_header
        .split(';')
        .map(str::trim)
        .find_map(|pair| pair.strip_prefix(&format!("{}=", crate::api::admin::CSRF_COOKIE)))
        .expect("a CSRF cookie in the header")
        .to_string()
}

/// The journal volume AS THE DASHBOARD RECEIVES IT: the parsed JSON of the
/// authenticated admin view, not the Rust `VolumeStatus` behind it. The join
/// between those two is the thing under test.
fn journal_volume(h: &Harness, cookie: &str) -> Value {
    let res = Req::get("/v1/admin/storage")
        .header("Cookie", cookie)
        .send(h.addr);
    assert_eq!(res.status, 200, "{}", res.text());
    res.json()
        .get("volumes")
        .and_then(Value::as_array)
        .expect("the storage view carries volumes")
        .iter()
        .find(|v| v.get("role").and_then(Value::as_str) == Some("journal"))
        .expect("a journal volume")
        .clone()
}

#[test]
fn the_dashboard_is_told_when_the_journal_usage_figure_is_stale() {
    // The stale-usage flag is only worth having if it reaches the page, and
    // nothing proved that it did. The Store test observes the Rust
    // `VolumeStatus`; the dashboard helper test supplies its own boolean.
    // Between them sits the serializer, and replacing its value with a
    // constant `false` -- or `bytes_used` with a constant zero -- left every
    // API test green while the dashboard would show a trustworthy-looking
    // figure the server considers stale.
    //
    // So every assertion here is on the PARSED JSON of the authenticated
    // admin view, the same bytes the dashboard fetches, read three times:
    // before the failure, while unverified, and after recovery.
    let h = Harness::start_with(
        "volume-wire-unverified",
        Setup {
            dashboard: true,
            ..Setup::default()
        },
    );
    let cred = h.setup_account();
    // The only HMAC-signed request in this test is the login link, and it is
    // made HERE, before the first measurement. Every authenticated device
    // request appends to the nonce log, whose bytes the journal total
    // includes: one issued between the three observations would look exactly
    // like the survey drift this test exists to rule out.
    let cookie = admin_cookie(&h, &cred);

    // (a) Before. The key must be PRESENT and a BOOLEAN: a serializer that
    // dropped it, or emitted a string, leaves a page that silently never
    // warns, and `!= true` would pass for all three of those.
    let before = journal_volume(&h, &cookie);
    let flag = before
        .get("usage_unverified")
        .unwrap_or_else(|| panic!("the volume object must carry usage_unverified: {before:?}"));
    assert_eq!(
        flag.as_bool(),
        Some(false),
        "a fresh journal's usage is verified, and the field is a boolean: {flag:?}"
    );
    // Non-zero, so a serializer that emitted a constant zero cannot pass for
    // it here or at (c).
    let used0 = before
        .get("bytes_used")
        .and_then(Value::as_u64)
        .expect("bytes_used");
    assert!(
        used0 > 0,
        "setup journalled an account and a device, so the figure is real: {used0}"
    );

    // The snapshot directory is taken away rather than blocked, so the
    // snapshot fails BEFORE writing its temporary and leaves the volume
    // byte-for-byte alone; a file where the quarantine belongs then refuses
    // the survey that would have accounted for it. Nothing here is a mode:
    // this suite runs as root inside the release image.
    let index_dir = h.dir.join("journal/v1/index");
    let stash = h.dir.join("index-stash");
    let quarantine = h.dir.join("journal/v1/quarantine");
    std::fs::rename(&index_dir, &stash).expect("take the snapshot directory away");
    std::fs::write(&quarantine, b"not a directory\n").expect("refuse the survey");
    h.app
        .store
        .snapshot()
        .expect_err("the snapshot and its survey both fail");
    h.clock.set(NOW + crate::api::READY_CACHE_SECS + 1);
    assert_eq!(
        Req::get("/readyz").send(h.addr).status,
        503,
        "the server is refusing writes while this is true"
    );

    // (b) While unverified: the flag is true and the figure beside it is the
    // LAST GOOD one, unchanged. Those two facts belong to each other -- a
    // true flag beside a silently refreshed number would be describing a
    // state the server is not in.
    let during = journal_volume(&h, &cookie);
    assert_eq!(
        during.get("usage_unverified").and_then(Value::as_bool),
        Some(true),
        "the page is told the figure could not be re-read: {during:?}"
    );
    assert_eq!(
        during.get("bytes_used").and_then(Value::as_u64),
        Some(used0),
        "and the figure is the last one read successfully"
    );
    for key in ["bytes_total", "bytes_free", "watermark_bytes"] {
        assert!(
            during.get(key).is_some(),
            "the rest of the volume object survives the state: {key} missing from {during:?}"
        );
    }

    // Bytes the next survey must find, written where the walk counts them --
    // under the journal root, outside the quarantine and the nonce log. They
    // are what tells a fresh walk apart from the cached number.
    const SENTINEL: u64 = 4096;
    std::fs::write(
        h.dir.join("journal/v1/sentinel"),
        vec![7u8; SENTINEL as usize],
    )
    .expect("bytes the next survey must find");

    // The operator fixes the volume; readiness re-surveys with no write.
    std::fs::remove_file(&quarantine).expect("free the name");
    std::fs::rename(&stash, &index_dir).expect("put the snapshot directory back");
    h.clock.set(NOW + 2 * crate::api::READY_CACHE_SECS + 2);
    let ready = Req::get("/readyz").send(h.addr);
    assert_eq!(ready.status, 200, "{}", ready.text());

    // (c) After: the flag is false again, and the figure is what a walk of
    // the volume finds -- checked three ways, because each catches a
    // different lie.
    let after = journal_volume(&h, &cookie);
    assert_eq!(
        after.get("usage_unverified").and_then(Value::as_bool),
        Some(false),
        "a survey succeeded, so the figure is current again: {after:?}"
    );
    let used1 = after
        .get("bytes_used")
        .and_then(Value::as_u64)
        .expect("bytes_used");
    // The walk is independent of the accounting under test and of any
    // assumption about what the failed snapshot left: it is every byte under
    // the journal root, which is exactly the set the four sources cover.
    // `journal_root_bytes` is the same walk this file already uses to check
    // the nonce log's contribution.
    assert_eq!(
        used1,
        journal_root_bytes(&h.dir),
        "the served figure is what the volume really holds"
    );
    // A walk against a walk can agree while both are wrong, so the value is
    // pinned as well. Exact here because the snapshot failed before writing
    // its temporary; if that ever stops being true, this is the line that
    // says so rather than the walk quietly following along.
    assert_eq!(
        used1,
        used0 + SENTINEL,
        "which is the last good figure plus the bytes planted while nobody could look"
    );
    assert_ne!(
        used1, used0,
        "and it moved: a cached figure, or a serialized constant, would not have"
    );
}

#[test]
fn a_faulted_journal_answers_readyz_with_the_reason_to_restart() {
    let h = Harness::start("journal-faulted");
    let cred = h.setup_account();
    assert_eq!(Req::get("/readyz").send(h.addr).status, 200);

    // A full volume at the append, and a rollback the same full volume
    // refuses: the one transition after which the journal may take nothing
    // more (docs/storage.md, "Durability rules").
    h.app
        .store
        .set_fault(crate::storage::Fault::JournalRecoveryFails {
            code: 28,
            at: crate::storage::AppendPhase::Write,
            rollback: crate::storage::RollbackPhase::Truncate,
        });
    // The first journalled write of the request is the device's `sign_in`
    // event, so that is the append the volume refuses and the rollback
    // fails; the request's own append then meets the faulted journal.
    let refused = Req::new("PATCH", &format!("/v1/devices/{}", cred.id))
        .body(r#"{"name":"studio laptop"}"#)
        .sign(&cred, NOW)
        .send(h.addr);
    assert_eq!(refused.status, 503, "{}", refused.text());
    assert_eq!(refused.code(), "journal_faulted");
    h.app.store.set_fault(crate::storage::Fault::None);
    assert_eq!(
        h.app.store.journal_faulted(),
        Some(std::io::ErrorKind::StorageFull),
        "the store remembers what put it there"
    );

    // The volumes still take a probe write. Readiness is false anyway,
    // because the server can no longer acknowledge anything.
    h.clock.set(NOW + crate::api::READY_CACHE_SECS + 1);
    let not_ready = Req::get("/readyz").send(h.addr);
    assert_eq!(not_ready.status, 503, "{}", not_ready.text());
    assert_eq!(not_ready.code(), "not_ready");
    assert_eq!(
        not_ready.json().get("detail").and_then(Value::as_str),
        Some("journal faulted; restart to replay"),
        "the refusal names the transition, not a volume"
    );

    // And every later write refuses with the state rather than an I/O error.
    let after = Req::new("PATCH", &format!("/v1/devices/{}", cred.id))
        .body(r#"{"name":"studio desk"}"#)
        .sign(&cred, NOW)
        .send(h.addr);
    assert_eq!(after.status, 503, "{}", after.text());
    assert_eq!(after.code(), "journal_faulted");
}

/// Every byte the journal ROOT holds, walked independently of the server.
fn journal_root_bytes(dir: &Path) -> u64 {
    fn walk(path: &Path) -> u64 {
        let mut total = 0;
        let Ok(entries) = std::fs::read_dir(path) else {
            return 0;
        };
        for entry in entries.flatten() {
            let meta = entry.metadata().expect("metadata");
            if meta.is_dir() {
                total += walk(&entry.path());
            } else {
                total += meta.len();
            }
        }
        total
    }
    walk(&dir.join("journal/v1"))
}

#[test]
fn the_journal_volume_counts_the_nonce_log_the_api_writes() {
    // End to end, because the wiring is the part that can be missing: the
    // nonce log publishes its bytes into a handle, and only `App::new`
    // decides whether that handle is the store's. Setup has already opened
    // the segment, so nothing here re-surveys the volume and a number that
    // waited for the next roll would simply be wrong.
    let h = Harness::start("nonce-volume-accounting");
    let cred = h.setup_account();
    let used = |h: &Harness| {
        h.app
            .store
            .volumes()
            .into_iter()
            .find(|v| v.role == "journal")
            .expect("a journal volume")
            .bytes_used
    };
    let after_setup = journal_root_bytes(&h.dir);
    assert_eq!(used(&h), after_setup, "after setup");

    for n in 0..4 {
        let res = Req::new("PATCH", &format!("/v1/devices/{}", cred.id))
            .body(&format!("{{\"name\":\"laptop {n}\"}}"))
            .sign(&cred, NOW)
            .send(h.addr);
        assert_eq!(res.status, 200, "{}", res.text());
    }

    let grown = journal_root_bytes(&h.dir);
    assert!(
        grown > after_setup,
        "authenticated requests grew the journal volume: {grown} is not above {after_setup}"
    );
    assert_eq!(
        used(&h),
        grown,
        "and every one of those bytes is where the watermark reads them"
    );
}

#[test]
fn an_unknown_route_is_a_json_404() {
    let h = Harness::start("404");
    let res = Req::get("/v1/nope").send(h.addr);
    assert_eq!(res.status, 404);
    assert_eq!(res.code(), "not_found");
    assert!(
        res.json().get("detail").is_some(),
        "every error carries a detail"
    );
}

#[test]
fn setup_runs_once_and_mints_the_first_device() {
    let h = Harness::start("setup");
    let cred = h.setup_account();
    assert_eq!(cred.id.len(), 32);

    let res = Req::get("/v1/account").sign(&cred, NOW).send(h.addr);
    assert_eq!(res.status, 200, "{}", res.text());
    assert_eq!(
        res.json().get("name").and_then(Value::as_str),
        Some("vault")
    );

    let again = Req::post("/v1/setup")
        .body(&format!(
            r#"{{"setup_token":"{}","account_name":"other","device":{{"name":"second","platform":"linux","app_version":"0.1.0"}}}}"#,
            "5e".repeat(32)
        ))
        .send(h.addr);
    assert_eq!(again.status, 409);
    assert_eq!(again.code(), "already_set_up");
    assert_eq!(
        h.app.store.devices().len(),
        1,
        "a refused second setup enrols nobody"
    );
}

#[test]
fn a_wrong_setup_token_is_refused() {
    let h = Harness::start("setup-bad");
    let res = Req::post("/v1/setup")
        .body(&format!(
            r#"{{"setup_token":"{}","account_name":"vault","device":{{"name":"laptop","platform":"macos","app_version":"0.1.0"}}}}"#,
            "11".repeat(32)
        ))
        .send(h.addr);
    assert_eq!(res.status, 401);
    assert_eq!(res.code(), "bad_setup_token");
    assert!(
        h.app.store.account().is_none(),
        "a refused setup creates nothing"
    );

    let no_device = Req::post("/v1/setup")
        .body(&format!(
            r#"{{"setup_token":"{}","account_name":"vault"}}"#,
            "5e".repeat(32)
        ))
        .send(h.addr);
    assert_eq!(no_device.status, 400, "the device object is required");
    assert!(
        h.app.store.account().is_none(),
        "a body refused for its device leaves no account behind"
    );

    let bad_platform = Req::post("/v1/setup")
        .body(&format!(
            r#"{{"setup_token":"{}","account_name":"vault","device":{{"name":"laptop","platform":"toaster","app_version":"0.1.0"}}}}"#,
            "5e".repeat(32)
        ))
        .send(h.addr);
    assert_eq!(bad_platform.status, 400);
    assert!(
        h.app.store.account().is_none(),
        "the device is validated before the account is created"
    );
}

#[test]
fn every_authentication_refusal_is_the_documented_one() {
    let h = Harness::start("auth");
    let cred = h.setup_account();

    let res = Req::get("/v1/account").send(h.addr);
    assert_eq!(res.status, 401);
    assert_eq!(res.code(), "missing_auth");

    let res = Req::get("/v1/account")
        .header("X-Obsync-Device", &cred.id)
        .header("X-Obsync-Ts", &NOW.to_string())
        .header("X-Obsync-Nonce", &nonce())
        .header("X-Obsync-Sig", &"ab".repeat(32))
        .send(h.addr);
    assert_eq!(res.status, 401);
    assert_eq!(res.code(), "bad_signature");

    let res = Req::get("/v1/account").sign(&cred, NOW + 301).send(h.addr);
    assert_eq!(
        res.code(),
        "stale_timestamp",
        "301 s ahead is outside the window"
    );
    let res = Req::get("/v1/account").sign(&cred, NOW - 301).send(h.addr);
    assert_eq!(
        res.code(),
        "stale_timestamp",
        "301 s behind is outside the window"
    );
    assert_eq!(
        Req::get("/v1/account")
            .sign(&cred, NOW + 300)
            .send(h.addr)
            .status,
        200
    );
    assert_eq!(
        Req::get("/v1/account")
            .sign(&cred, NOW - 300)
            .send(h.addr)
            .status,
        200
    );

    let fixed = nonce();
    let hash = hex::encode(&sha256::sha256(b""));
    let first = Req::get("/v1/account")
        .sign_with(&cred, NOW, &fixed, &hash)
        .send(h.addr);
    assert_eq!(first.status, 200);
    let replay = Req::get("/v1/account")
        .sign_with(&cred, NOW, &fixed, &hash)
        .send(h.addr);
    assert_eq!(replay.status, 401);
    assert_eq!(replay.code(), "replayed_nonce");

    let unknown = Cred {
        id: "ff".repeat(16),
        secret: [9u8; 32],
    };
    let res = Req::get("/v1/account").sign(&unknown, NOW).send(h.addr);
    assert_eq!(
        res.code(),
        "bad_signature",
        "an unknown device is not distinguishable"
    );

    let res = Req::get("/v1/changes?since=0")
        .sign_with(&cred, NOW, &nonce(), &hex::encode(&sha256::sha256(b"")))
        .send(h.addr);
    assert_eq!(
        res.status, 200,
        "the signature covers the whole target including the query"
    );
}

#[test]
fn a_signature_over_another_target_does_not_verify() {
    let h = Harness::start("auth-target");
    let cred = h.setup_account();
    let hash = hex::encode(&sha256::sha256(b""));
    let n = nonce();
    let canonical = crate::api::auth::canonical("GET", "/v1/devices", &NOW.to_string(), &n, &hash);
    let sig = hex::encode(&hmac::hmac_sha256(&cred.secret, canonical.as_bytes()));
    let res = Req::get("/v1/account")
        .header("X-Obsync-Device", &cred.id)
        .header("X-Obsync-Ts", &NOW.to_string())
        .header("X-Obsync-Nonce", &n)
        .header("X-Obsync-Sig", &sig)
        .send(h.addr);
    assert_eq!(res.code(), "bad_signature");
}

#[test]
fn edge_mode_refuses_a_request_without_the_edge_headers_but_still_serves_health() {
    let h = Harness::start_with(
        "edge",
        Setup {
            edge_mode: true,
            ..Setup::default()
        },
    );
    assert_eq!(
        Req::get("/livez").send(h.addr).status,
        200,
        "probes do not cross the edge"
    );
    assert_eq!(Req::get("/readyz").send(h.addr).status, 200);

    let res = Req::post("/v1/setup")
        .body(r#"{"setup_token":"x","account_name":"v"}"#)
        .send(h.addr);
    assert_eq!(res.status, 421);
    assert_eq!(res.code(), "edge_required");

    let body = format!(
        r#"{{"setup_token":"{}","account_name":"vault","device":{{"name":"laptop","platform":"macos","app_version":"0.1.0"}}}}"#,
        "5e".repeat(32)
    );
    let res = Req::post("/v1/setup")
        .body(&body)
        .header("CF-Connecting-IP", "198.51.100.7")
        .header("CF-Ray", "test-ray")
        .header("CF-IPCountry", "PT")
        .send(h.addr);
    assert_eq!(res.status, 201, "{}", res.text());

    let cred = Cred::from_json(&res.json());
    let devices = Req::get("/v1/devices")
        .header("CF-Connecting-IP", "198.51.100.7")
        .header("CF-Ray", "test-ray")
        .header("CF-IPCountry", "PT")
        .sign(&cred, NOW)
        .send(h.addr);
    let v = devices.json();
    let first = &v.get("devices").and_then(Value::as_array).expect("devices")[0];
    assert_eq!(
        first.get("address").and_then(Value::as_str),
        Some("198.51.100.7")
    );
    assert_eq!(first.get("country").and_then(Value::as_str), Some("PT"));
}

#[test]
fn the_pairing_flow_runs_end_to_end() {
    let h = Harness::start("pairing");
    let creator = h.setup_account();

    let res = Req::post("/v1/pairing").sign(&creator, NOW).send(h.addr);
    assert_eq!(res.status, 201, "{}", res.text());
    let v = res.json();
    let id = v
        .get("pairing_id")
        .and_then(Value::as_str)
        .expect("pairing_id")
        .to_string();
    let token = v
        .get("enroll_token")
        .and_then(Value::as_str)
        .expect("enroll_token")
        .to_string();

    let claim_body = format!(
        r#"{{"enroll_token":"{token}","name":"phone","platform":"ios","app_version":"0.1.0"}}"#
    );
    let bad = Req::post(&format!("/v1/pairing/{id}/claim"))
        .body(&format!(
            r#"{{"enroll_token":"{}","name":"phone","platform":"ios","app_version":"0.1.0"}}"#,
            "00".repeat(32)
        ))
        .send(h.addr);
    assert_eq!(bad.status, 404, "a wrong token is an unknown pairing");

    let res = Req::post(&format!("/v1/pairing/{id}/claim"))
        .body(&claim_body)
        .send(h.addr);
    assert_eq!(res.status, 201, "{}", res.text());
    let claimant = Cred::from_json(&res.json());

    let again = Req::post(&format!("/v1/pairing/{id}/claim"))
        .body(&claim_body)
        .send(h.addr);
    assert_eq!(again.status, 409);
    assert_eq!(again.code(), "already_claimed");

    let state = Req::get(&format!("/v1/pairing/{id}"))
        .sign(&creator, NOW)
        .send(h.addr);
    assert_eq!(
        state.json().get("state").and_then(Value::as_str),
        Some("claimed")
    );

    // The claimant is PENDING: the pairing poll is not its route, and the
    // state gate answers before the creator check does.
    let wrong = Req::get(&format!("/v1/pairing/{id}"))
        .sign(&claimant, NOW)
        .send(h.addr);
    assert_eq!(wrong.status, 403);
    assert_eq!(wrong.code(), "device_pending");

    // Its own envelope IS its route, and it says "not yet" until approval,
    // which is exactly what lets the claimant poll.
    let early = Req::get(&format!("/v1/pairing/{id}/envelope"))
        .sign(&claimant, NOW)
        .send(h.addr);
    assert_eq!(early.status, 409, "{}", early.text());
    assert_eq!(early.code(), "not_approved");

    let approve = Req::post(&format!("/v1/pairing/{id}/approve"))
        .body(r#"{"envelope":"Y2lwaGVy","nonce":"0123456789abcdef01234567"}"#)
        .sign(&creator, NOW)
        .send(h.addr);
    assert_eq!(approve.status, 204, "{}", approve.text());

    // Approval activated it, so the creator-only routes now refuse it for
    // being the wrong actor rather than for being unapproved.
    let wrong = Req::get(&format!("/v1/pairing/{id}"))
        .sign(&claimant, NOW)
        .send(h.addr);
    assert_eq!(wrong.status, 403);
    assert_eq!(wrong.code(), "not_creator");

    let fetch = Req::get(&format!("/v1/pairing/{id}/envelope"))
        .sign(&claimant, NOW)
        .send(h.addr);
    assert_eq!(fetch.status, 200);
    assert_eq!(
        fetch.json().get("envelope").and_then(Value::as_str),
        Some("Y2lwaGVy")
    );

    let twice = Req::get(&format!("/v1/pairing/{id}/envelope"))
        .sign(&claimant, NOW)
        .send(h.addr);
    assert_eq!(twice.status, 410);
    assert_eq!(twice.code(), "envelope_consumed");

    let devices = Req::get("/v1/devices").sign(&creator, NOW).send(h.addr);
    let list = devices.json();
    let rows = list
        .get("devices")
        .and_then(Value::as_array)
        .expect("devices");
    assert_eq!(rows.len(), 2);
    for row in rows {
        assert_eq!(
            row.get("state").and_then(Value::as_str),
            Some("active"),
            "both devices are approved by now"
        );
        assert_eq!(row.get("revoked").and_then(Value::as_bool), Some(false));
    }
}

/// Open a pairing on `creator` and claim it, returning the pairing id and the
/// claimant's credential. The claimant is PENDING: nobody has approved it.
fn claim_pairing(h: &Harness, creator: &Cred) -> (String, Cred) {
    let v = Req::post("/v1/pairing")
        .sign(creator, NOW)
        .send(h.addr)
        .json();
    let id = v
        .get("pairing_id")
        .and_then(Value::as_str)
        .expect("pairing_id")
        .to_string();
    let token = v
        .get("enroll_token")
        .and_then(Value::as_str)
        .expect("enroll_token")
        .to_string();
    let claimed = Req::post(&format!("/v1/pairing/{id}/claim"))
        .body(&format!(
            r#"{{"enroll_token":"{token}","name":"phone","platform":"ios","app_version":"0.1.0"}}"#
        ))
        .send(h.addr);
    assert_eq!(claimed.status, 201, "{}", claimed.text());
    (id, Cred::from_json(&claimed.json()))
}

/// Approve a claimed pairing as its creator.
fn approve_pairing(h: &Harness, creator: &Cred, id: &str) {
    let approve = Req::post(&format!("/v1/pairing/{id}/approve"))
        .body(r#"{"envelope":"Y2lwaGVy","nonce":"0123456789abcdef01234567"}"#)
        .sign(creator, NOW)
        .send(h.addr);
    assert_eq!(approve.status, 204, "{}", approve.text());
}

/// How many devices the creator's `GET /v1/devices` lists.
fn device_count(h: &Harness, cred: &Cred) -> usize {
    Req::get("/v1/devices")
        .sign(cred, NOW)
        .send(h.addr)
        .json()
        .get("devices")
        .and_then(Value::as_array)
        .expect("devices")
        .len()
}

#[test]
fn an_unapproved_claimant_holds_a_secret_and_no_authority() {
    let h = Harness::start("pairing-pending");
    let creator = h.setup_account();
    let (id, claimant) = claim_pairing(&h, &creator);

    // The two escalations the claim used to buy: a dashboard session for the
    // whole account, and revoking the device that has not approved it yet.
    let link = Req::post("/v1/dashboard/login-link")
        .body("{}")
        .sign(&claimant, NOW)
        .send(h.addr);
    let revoke = Req::post(&format!("/v1/devices/{}/revoke", creator.id))
        .sign(&claimant, NOW)
        .send(h.addr);
    assert_eq!(
        (link.status, revoke.status),
        (403, 403),
        "login-link {} / revoke {}",
        link.text(),
        revoke.text()
    );
    assert_eq!(link.code(), "device_pending");
    assert_eq!(revoke.code(), "device_pending");

    // Every other authority-carrying route answers the same way; only the
    // claimant's own envelope is reachable.
    for res in [
        Req::get("/v1/account").sign(&claimant, NOW).send(h.addr),
        Req::get("/v1/devices").sign(&claimant, NOW).send(h.addr),
        Req::get("/v1/changes?since=0")
            .sign(&claimant, NOW)
            .send(h.addr),
        Req::post("/v1/devices/heartbeat")
            .body(r#"{"app_version":"0.1.0"}"#)
            .sign(&claimant, NOW)
            .send(h.addr),
        Req::post("/v1/pairing").sign(&claimant, NOW).send(h.addr),
    ] {
        assert_eq!(res.status, 403, "{}", res.text());
        assert_eq!(res.code(), "device_pending");
    }

    // The creator sees it, truthfully, as pending and not revoked.
    let rows = Req::get("/v1/devices")
        .sign(&creator, NOW)
        .send(h.addr)
        .json();
    let rows = rows.get("devices").and_then(Value::as_array).expect("rows");
    let pending = rows
        .iter()
        .find(|d| d.get("device_id").and_then(Value::as_str) == Some(claimant.id.as_str()))
        .expect("the claimant is listed");
    assert_eq!(
        pending.get("state").and_then(Value::as_str),
        Some("pending")
    );
    assert_eq!(pending.get("revoked").and_then(Value::as_bool), Some(false));
    assert_eq!(
        pending.get("last_sign_in").cloned(),
        Some(Value::Null),
        "a pending device has signed in to nothing"
    );

    // Approval, and only approval, hands it authority.
    approve_pairing(&h, &creator, &id);
    let after = Req::get("/v1/account").sign(&claimant, NOW).send(h.addr);
    assert_eq!(after.status, 200, "{}", after.text());
}

#[test]
fn a_pending_device_never_counts_as_the_second_device() {
    let h = Harness::start("pairing-last-device");
    let creator = h.setup_account();
    let (id, _) = claim_pairing(&h, &creator);

    let alone = Req::post(&format!("/v1/devices/{}/revoke", creator.id))
        .sign(&creator, NOW)
        .send(h.addr);
    assert_eq!(alone.status, 409, "{}", alone.text());
    assert_eq!(
        alone.code(),
        "last_device",
        "an unapproved claimant cannot be the device that lets the last one go"
    );

    // Approved, it counts.
    approve_pairing(&h, &creator, &id);
    let now_allowed = Req::post(&format!("/v1/devices/{}/revoke", creator.id))
        .sign(&creator, NOW)
        .send(h.addr);
    assert_eq!(now_allowed.status, 204, "{}", now_allowed.text());
}

#[test]
fn an_expired_pairing_destroys_the_device_it_claimed() {
    let h = Harness::start("pairing-expiry");
    let creator = h.setup_account();
    let (_, claimant) = claim_pairing(&h, &creator);
    assert_eq!(device_count(&h, &creator), 2, "the claim created a device");

    // The sweeper runs on its own thread in production; the harness drives it
    // directly so the test does not sleep for ten minutes.
    h.app.sweep(NOW + crate::api::pairing::PAIRING_TTL_SECS + 1);

    assert_eq!(
        device_count(&h, &creator),
        1,
        "the pending device goes with the pairing that granted it"
    );
    let after = Req::get("/v1/pairing/nope/envelope")
        .sign(&claimant, NOW)
        .send(h.addr);
    assert_eq!(
        after.status,
        401,
        "a deleted device is indistinguishable from a bad signature: {}",
        after.text()
    );
    assert_eq!(after.code(), "bad_signature");
}

#[test]
fn an_approved_device_survives_its_pairing_expiring() {
    let h = Harness::start("pairing-expiry-approved");
    let creator = h.setup_account();
    let (id, claimant) = claim_pairing(&h, &creator);
    approve_pairing(&h, &creator, &id);

    h.app.sweep(NOW + crate::api::pairing::PAIRING_TTL_SECS + 1);

    assert_eq!(device_count(&h, &creator), 2);
    let after = Req::get("/v1/account").sign(&claimant, NOW).send(h.addr);
    assert_eq!(
        after.status,
        200,
        "expiry destroys unapproved claims only: {}",
        after.text()
    );
}

#[test]
fn rejecting_a_pairing_deletes_the_claimant_device() {
    let h = Harness::start("pairing-reject");
    let creator = h.setup_account();
    let res = Req::post("/v1/pairing").sign(&creator, NOW).send(h.addr);
    let v = res.json();
    let id = v
        .get("pairing_id")
        .and_then(Value::as_str)
        .expect("id")
        .to_string();
    let token = v
        .get("enroll_token")
        .and_then(Value::as_str)
        .expect("token")
        .to_string();
    let claimed = Req::post(&format!("/v1/pairing/{id}/claim"))
        .body(&format!(
            r#"{{"enroll_token":"{token}","name":"phone","platform":"android","app_version":"0.1.0"}}"#
        ))
        .send(h.addr);
    let claimant = Cred::from_json(&claimed.json());

    let reject = Req::post(&format!("/v1/pairing/{id}/reject"))
        .sign(&creator, NOW)
        .send(h.addr);
    assert_eq!(reject.status, 204, "{}", reject.text());

    let after = Req::get("/v1/account").sign(&claimant, NOW).send(h.addr);
    assert_eq!(
        after.status,
        401,
        "a rejected device is gone: {}",
        after.text()
    );
    assert_eq!(
        after.code(),
        "bad_signature",
        "the row is deleted, so the refusal is the unknown-device one and \
         names no state an attacker could enumerate"
    );

    let devices = Req::get("/v1/devices").sign(&creator, NOW).send(h.addr);
    assert_eq!(
        devices
            .json()
            .get("devices")
            .and_then(Value::as_array)
            .expect("devices")
            .len(),
        1
    );
}

/// Issue #88: the second click on a pairing screen the creator already
/// approved used to delete the device that approval had just paired.
#[test]
fn rejecting_an_approved_pairing_is_refused_and_keeps_the_device() {
    let h = Harness::start_with(
        "pairing-reject-approved",
        Setup {
            capture_log: true,
            ..Setup::default()
        },
    );
    let creator = h.setup_account();
    let (id, claimant) = claim_pairing(&h, &creator);
    approve_pairing(&h, &creator, &id);
    assert_eq!(device_count(&h, &creator), 2, "the approval paired it");
    let seq = h.app.store.head_seq();

    let reject = Req::post(&format!("/v1/pairing/{id}/reject"))
        .sign(&creator, NOW)
        .send(h.addr);
    assert_eq!(reject.status, 409, "{}", reject.text());
    assert_eq!(reject.code(), "already_approved");
    // Measured across the reject and nothing else: an authenticated read
    // records a sign-in, which IS a frame, so the window is this one request.
    assert_eq!(
        h.app.store.head_seq(),
        seq,
        "the journal is untouched by a refusal"
    );

    // The device is still paired and still syncing.
    let after = Req::get("/v1/account").sign(&claimant, NOW).send(h.addr);
    assert_eq!(
        after.status,
        200,
        "the approved device still authenticates: {}",
        after.text()
    );
    assert_eq!(device_count(&h, &creator), 2);
    let rows = Req::get("/v1/devices")
        .sign(&creator, NOW)
        .send(h.addr)
        .json();
    let rows = rows.get("devices").and_then(Value::as_array).expect("rows");
    let row = rows
        .iter()
        .find(|d| d.get("device_id").and_then(Value::as_str) == Some(claimant.id.as_str()))
        .expect("the claimant is still listed");
    assert_eq!(row.get("state").and_then(Value::as_str), Some("active"));

    // The refusal says why, in the words an operator greps for: a device
    // that is still listed after a reject is otherwise a mystery
    // (requirement 12).
    let logged = h.captured();
    assert!(
        logged.contains("pairing_reject") && logged.contains("decision=refused"),
        "the refusal logs its decision: {logged}"
    );
    assert!(
        logged.contains("reason=already_approved"),
        "and names the state it refused for: {logged}"
    );

    // And a second reject is the same refusal: the pairing is not consumed
    // by having refused once.
    let twice = Req::post(&format!("/v1/pairing/{id}/reject"))
        .sign(&creator, NOW)
        .send(h.addr);
    assert_eq!(twice.status, 409, "{}", twice.text());
    assert_eq!(twice.code(), "already_approved");
}

/// A chunk and its sid.
fn chunk(body: &[u8]) -> (Vec<u8>, String) {
    (body.to_vec(), hex::encode(&sha256::sha256(body)))
}

#[test]
fn a_chunk_uploads_downloads_and_serves_a_range() {
    let h = Harness::start("chunks");
    let cred = h.setup_account();
    let (body, sid) = chunk(b"ciphertext-one-two-three");

    let missing = Req::post("/v1/chunks/exists")
        .body(&format!(r#"{{"sids":["{sid}"]}}"#))
        .sign(&cred, NOW)
        .send(h.addr);
    assert_eq!(missing.status, 200, "{}", missing.text());
    assert_eq!(
        missing
            .json()
            .get("missing")
            .and_then(Value::as_array)
            .expect("missing")
            .len(),
        1
    );

    let put = Req::new("PUT", &format!("/v1/chunks/{sid}"))
        .raw_body(&body)
        .sign_with(&cred, NOW, &nonce(), &sid)
        .send(h.addr);
    assert_eq!(put.status, 201, "{}", put.text());

    let again = Req::new("PUT", &format!("/v1/chunks/{sid}"))
        .raw_body(&body)
        .sign_with(&cred, NOW, &nonce(), &sid)
        .send(h.addr);
    assert_eq!(again.status, 200, "a second upload is idempotent");

    let missing = Req::post("/v1/chunks/exists")
        .body(&format!(r#"{{"sids":["{sid}"]}}"#))
        .sign(&cred, NOW)
        .send(h.addr);
    assert!(
        missing
            .json()
            .get("missing")
            .and_then(Value::as_array)
            .expect("missing")
            .is_empty(),
        "the chunk is stored now"
    );

    let get = Req::get(&format!("/v1/chunks/{sid}"))
        .sign(&cred, NOW)
        .send(h.addr);
    assert_eq!(get.status, 200);
    assert_eq!(get.body, body);

    let ranged = Req::get(&format!("/v1/chunks/{sid}"))
        .header("Range", "bytes=0-9")
        .sign(&cred, NOW)
        .send(h.addr);
    assert_eq!(ranged.status, 206, "{}", ranged.text());
    assert_eq!(ranged.body, body[..10]);
    assert_eq!(
        ranged.header("content-range"),
        Some(format!("bytes 0-9/{}", body.len()).as_str())
    );

    let unknown = Req::get(&format!("/v1/chunks/{}", "ab".repeat(32)))
        .sign(&cred, NOW)
        .send(h.addr);
    assert_eq!(unknown.status, 404);
    assert_eq!(unknown.code(), "unknown_chunk");
}

#[test]
fn maximal_ciphertext_uploads_and_one_extra_byte_is_refused() {
    let h = Harness::start("ciphertext-ceiling");
    let cred = h.setup_account();
    // Independent wire bound, not the implementation constant under test.
    let body = vec![0x51; 8 * 1024 * 1024 + 16];
    let (_, sid) = chunk(&body);
    let put = Req::new("PUT", &format!("/v1/chunks/{sid}"))
        .raw_body(&body)
        .sign_with(&cred, NOW, &nonce(), &sid)
        .send(h.addr);
    assert_eq!(put.status, 201, "{}", put.text());
    let get = Req::get(&format!("/v1/chunks/{sid}"))
        .sign(&cred, NOW)
        .send(h.addr);
    assert_eq!(get.status, 200);
    assert_eq!(get.body, body);

    let oversized = vec![0x52; body.len() + 1];
    let (_, refused_sid) = chunk(&oversized);
    let req = Req::new("PUT", &format!("/v1/chunks/{refused_sid}")).sign_with(
        &cred,
        NOW,
        &nonce(),
        &refused_sid,
    );
    let mut stream = TcpStream::connect(h.addr).expect("connect");
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .expect("timeout");
    let mut head = format!("PUT {} HTTP/1.1\r\nHost: 127.0.0.1\r\n", req.target);
    for (name, value) in req.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str(&format!(
        "Content-Length: {}\r\nConnection: close\r\n\r\n",
        oversized.len()
    ));
    // An early refusal may close the socket while the complete ordinary body
    // is still being sent. Read its decision concurrently instead of making
    // a successful client write a prerequisite for observing that decision.
    let mut writer = stream.try_clone().expect("writer");
    let send = std::thread::spawn(move || {
        writer.write_all(head.as_bytes())?;
        writer.write_all(&oversized)
    });
    let mut raw = Vec::new();
    if let Err(error) = stream.read_to_end(&mut raw) {
        // Some platforms reset after delivering the early refusal with
        // unread request bytes. The complete parsed decision is still required.
        assert_eq!(error.kind(), std::io::ErrorKind::ConnectionReset);
    }
    let _ = send.join().expect("writer joined");
    let refused = Res::parse(&raw);
    assert_eq!(refused.status, 413, "{}", refused.text());
    assert_eq!(refused.code(), "body_too_large");
    assert!(refused.text().contains("16-byte authentication tag"));
    let absent = Req::get(&format!("/v1/chunks/{refused_sid}"))
        .sign(&cred, NOW)
        .send(h.addr);
    assert_eq!(absent.status, 404, "refused bytes were not stored");
}

#[test]
fn multipart_ciphertext_budget_accepts_exactly_32_mib_and_refuses_more() {
    let h = Harness::start("multipart-ceiling");
    let cred = h.setup_account();
    for (length, expected) in [(8 * 1024 * 1024, 200), (8 * 1024 * 1024 + 16, 413)] {
        let body = vec![0x53; length];
        let (_, sid) = chunk(&body);
        let put = Req::new("PUT", &format!("/v1/chunks/{sid}"))
            .raw_body(&body)
            .sign_with(&cred, NOW, &nonce(), &sid)
            .send(h.addr);
        assert_eq!(put.status, 201, "{}", put.text());
        let res = Req::post("/v1/chunks/get")
            .body(&format!(r#"{{"sids":["{sid}","{sid}","{sid}","{sid}"]}}"#))
            .sign(&cred, NOW)
            .send(h.addr);
        assert_eq!(res.status, expected, "length={length}");
        if expected == 200 {
            assert!(res.body.len() > 32 * 1024 * 1024, "framing is additional");
        } else {
            assert_eq!(res.code(), "batch_too_large");
        }
    }
}

#[test]
fn a_body_that_does_not_hash_to_the_sid_is_refused() {
    let h = Harness::start("chunk-mismatch");
    let cred = h.setup_account();
    let (_, sid) = chunk(b"the-real-chunk");
    let put = Req::new("PUT", &format!("/v1/chunks/{sid}"))
        .raw_body(b"a-different-chunk")
        .sign_with(&cred, NOW, &nonce(), &sid)
        .send(h.addr);
    assert_eq!(put.status, 422, "{}", put.text());
    assert_eq!(put.code(), "sid_mismatch");
}

#[test]
fn a_batch_get_returns_one_part_per_sid_and_marks_what_is_missing() {
    let h = Harness::start("chunks-batch");
    let cred = h.setup_account();
    let (body, sid) = chunk(b"batched-ciphertext");
    Req::new("PUT", &format!("/v1/chunks/{sid}"))
        .raw_body(&body)
        .sign_with(&cred, NOW, &nonce(), &sid)
        .send(h.addr);

    let absent = "cd".repeat(32);
    let res = Req::post("/v1/chunks/get")
        .body(&format!(r#"{{"sids":["{sid}","{absent}"]}}"#))
        .sign(&cred, NOW)
        .send(h.addr);
    assert_eq!(res.status, 200, "{}", res.text());
    assert!(
        res.header("content-type")
            .is_some_and(|v| v.starts_with("multipart/mixed")),
        "content type is {:?}",
        res.header("content-type")
    );
    let text = String::from_utf8_lossy(&res.body).to_string();
    assert!(text.contains(&sid), "the stored sid is named in its part");
    assert!(text.contains(&absent), "the absent sid still gets a part");
    assert!(
        text.contains("X-Obsync-Missing: 1"),
        "the absent part is marked: {text}"
    );
    assert!(
        text.contains("batched-ciphertext"),
        "the stored part carries its bytes"
    );
}

/// The domain every test version names unless it is testing the field itself.
const TEST_DOMAIN: &str = "4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d";

/// Post a version, letting the server tell us the id it recomputes.
fn post_version(
    h: &Harness,
    cred: &Cred,
    file_id: &str,
    parents: &[&str],
    sids: &[&str],
    manifest: &str,
) -> Res {
    post_version_as(h, cred, file_id, parents, sids, manifest, None)
}

/// The same post, with the `accept_existing` field a 1.0.x client does not
/// send: `None` omits it exactly as that client's body does, and `Some(true)`
/// is a client that will store the `version_id` the answer names -- the only
/// client the server may answer with another version's id
/// (`docs/protocol.md`, "Files and versions").
fn post_version_as(
    h: &Harness,
    cred: &Cred,
    file_id: &str,
    parents: &[&str],
    sids: &[&str],
    manifest: &str,
    accept_existing: Option<bool>,
) -> Res {
    let parents_json = parents
        .iter()
        .map(|p| format!("\"{p}\""))
        .collect::<Vec<_>>()
        .join(",");
    let sids_json = sids
        .iter()
        .map(|s| format!("\"{s}\""))
        .collect::<Vec<_>>()
        .join(",");
    let accept = match accept_existing {
        Some(v) => format!(r#","accept_existing":{v}"#),
        None => String::new(),
    };
    let body = |version_id: &str| {
        format!(
            r#"{{"version_id":"{version_id}","parents":[{parents_json}],"sids":[{sids_json}],"bytes":18,"domain_id":"{TEST_DOMAIN}","manifest_ct":"{manifest}","manifest_nonce":"0123456789abcdef01234567","deleted":false{accept}}}"#
        )
    };
    let probe = Req::post(&format!("/v1/files/{file_id}/versions"))
        .body(&body(&"00".repeat(32)))
        .sign(cred, NOW)
        .send(h.addr);
    if probe.status != 422 {
        return probe;
    }
    let expected = probe
        .json()
        .get("expected")
        .and_then(Value::as_str)
        .expect("the mismatch names the expected id")
        .to_string();
    Req::post(&format!("/v1/files/{file_id}/versions"))
        .body(&body(&expected))
        .sign(cred, NOW)
        .send(h.addr)
}

/// Post one version with an arbitrary `domain_id`, letting the server name
/// the version id it recomputes. Returns the refusal, or the acceptance.
fn post_in_domain(h: &Harness, cred: &Cred, file_id: &str, parents: &[&str], domain: &str) -> Res {
    let parents_json = parents
        .iter()
        .map(|p| format!("\"{p}\""))
        .collect::<Vec<_>>()
        .join(",");
    let domain_field = if domain.is_empty() {
        String::new()
    } else {
        format!(r#""domain_id":"{domain}","#)
    };
    let body = |version_id: &str| {
        format!(
            r#"{{"version_id":"{version_id}","parents":[{parents_json}],"sids":[],"bytes":0,{domain_field}"manifest_ct":"bWFuaWZlc3Q=","manifest_nonce":"0123456789abcdef01234567","deleted":false}}"#
        )
    };
    let probe = Req::post(&format!("/v1/files/{file_id}/versions"))
        .body(&body(&"00".repeat(32)))
        .sign(cred, NOW)
        .send(h.addr);
    if probe.status != 422 {
        return probe;
    }
    let expected = probe
        .json()
        .get("expected")
        .and_then(Value::as_str)
        .expect("the mismatch names the expected id")
        .to_string();
    Req::post(&format!("/v1/files/{file_id}/versions"))
        .body(&body(&expected))
        .sign(cred, NOW)
        .send(h.addr)
}

/// The durable record is written by the request path itself, before the
/// response: `docs/protocol.md` promises the 600 s window across a restart,
/// and a background step could not keep it.
#[test]
fn an_authenticated_request_leaves_its_nonce_on_the_journal_volume() {
    let h = Harness::start("nonce-durable");
    let cred = h.setup_account();
    let sent = nonce();
    let empty = hex::encode(&sha256::sha256(&[]));

    let res = Req::get("/v1/account")
        .sign_with(&cred, NOW, &sent, &empty)
        .send(h.addr);
    assert_eq!(res.status, 200, "{}", res.text());

    let file = crate::storage::PathClass::JournalRoot
        .path(&h.dir.join("journal"))
        .join("nonces");
    let text = std::fs::read_to_string(&file).expect("the durable state is there");
    let expected = format!("{NOW} {} {sent}", cred.id);
    assert!(
        text.lines().any(|line| line == expected),
        "the accepted nonce is on the volume: {text}"
    );

    let again = Req::get("/v1/account")
        .sign_with(&cred, NOW, &sent, &empty)
        .send(h.addr);
    assert_eq!(again.status, 401, "{}", again.text());
    assert_eq!(again.code(), "replayed_nonce");
}

/// A version naming no parent replaces no head, so a client that never
/// reconciles accumulates one head per post. The wire says where that stops.
#[test]
fn a_file_stops_taking_heads_at_the_ceiling_and_keeps_the_ones_it_holds() {
    use crate::storage::FILE_MAX_HEADS;

    let h = Harness::start("head-ceiling");
    let cred = h.setup_account();
    let file_id = "b1".repeat(16);

    for n in 0..FILE_MAX_HEADS {
        let manifest = obsync_core::base64::encode(format!("head-{n}").as_bytes());
        let res = post_version(&h, &cred, &file_id, &[], &[], &manifest);
        assert_eq!(res.status, 201, "head {n}: {}", res.text());
    }
    let manifest = obsync_core::base64::encode(b"one-too-many");
    let over = post_version(&h, &cred, &file_id, &[], &[], &manifest);
    assert_eq!(over.status, 409, "{}", over.text());
    assert_eq!(over.code(), "too_many_heads");

    let record = Req::get(&format!("/v1/files/{file_id}"))
        .sign(&cred, NOW)
        .send(h.addr);
    assert_eq!(record.status, 200, "{}", record.text());
    let body = record.json();
    let heads = body
        .get("heads")
        .and_then(Value::as_array)
        .expect("the record states its heads");
    assert_eq!(
        heads.len(),
        FILE_MAX_HEADS,
        "the refusal took none of the heads the file already had"
    );
    assert_eq!(
        body.get("conflicted").and_then(Value::as_bool),
        Some(true),
        "and the file is still reported as conflicted"
    );
}

/// `docs/architecture.md` 5.1 item 4: the one clear field sharing added.
#[test]
fn a_version_names_its_domain_and_a_file_never_changes_it() {
    let h = Harness::start("version-domains");
    let cred = h.setup_account();
    let file_id = "cd".repeat(16);
    let other = "7e".repeat(16);

    // Required, not defaulted: a version with no domain could not be
    // authorized per domain later, and a default would be a guess.
    let absent = post_in_domain(&h, &cred, &file_id, &[], "");
    assert_eq!(absent.status, 400, "{}", absent.text());
    assert_eq!(absent.code(), "bad_request");
    let malformed = post_in_domain(&h, &cred, &file_id, &[], "not-a-domain");
    assert_eq!(malformed.status, 400, "{}", malformed.text());

    let first = post_in_domain(&h, &cred, &file_id, &[], TEST_DOMAIN);
    assert_eq!(first.status, 201, "{}", first.text());
    let head = first
        .json()
        .get("heads")
        .and_then(Value::as_array)
        .expect("heads")[0]
        .as_str()
        .expect("head")
        .to_string();

    // The file record and the change feed both state the domain in clear, so
    // a per-domain grant has something to be checked against.
    let file = Req::get(&format!("/v1/files/{file_id}"))
        .sign(&cred, NOW)
        .send(h.addr);
    let file_body = file.json();
    assert_eq!(
        file_body.get("domain_id").and_then(Value::as_str),
        Some(TEST_DOMAIN)
    );
    // The whole shape, so the domain is the ONLY clear field sharing added.
    assert_eq!(
        object_keys(&file_body),
        vec![
            "conflicted".to_string(),
            "domain_id".to_string(),
            "file_id".to_string(),
            "heads".to_string(),
            "versions".to_string(),
        ],
        "a file record is ids, graph shape and ciphertext: nothing else"
    );
    let page = Req::get("/v1/files").sign(&cred, NOW).send(h.addr);
    let page_body = page.json();
    let listed = page_body
        .get("files")
        .and_then(Value::as_array)
        .expect("files");
    assert_eq!(
        listed[0].get("domain_id").and_then(Value::as_str),
        Some(TEST_DOMAIN)
    );
    let feed = Req::get("/v1/changes?since=0&wait=0")
        .sign(&cred, NOW)
        .send(h.addr);
    let feed_body = feed.json();
    let changes = feed_body
        .get("changes")
        .and_then(Value::as_array)
        .expect("changes");
    assert_eq!(
        changes[0].get("domain_id").and_then(Value::as_str),
        Some(TEST_DOMAIN),
        "the feed carries the domain: a feed entry arrives without its file"
    );

    // A later version may not move the file into another domain.
    let moved = post_in_domain(&h, &cred, &file_id, &[head.as_str()], &other);
    assert_eq!(moved.status, 409, "{}", moved.text());
    assert_eq!(moved.code(), "domain_mismatch");
    let unchanged = Req::get(&format!("/v1/files/{file_id}"))
        .sign(&cred, NOW)
        .send(h.addr);
    assert_eq!(
        unchanged.json().get("domain_id").and_then(Value::as_str),
        Some(TEST_DOMAIN),
        "the refusal left the file where it was"
    );
}

/// Issue #114: the second device's identical merge is answered with the
/// first one's version id, in the response every 1.0.x client already reads.
#[test]
fn an_identical_version_post_is_answered_with_the_stored_id() {
    let h = Harness::start_with(
        "versions-dedupe",
        Setup {
            capture_log: true,
            ..Setup::default()
        },
    );
    let cred = h.setup_account();
    let (body, sid) = chunk(b"version-ciphertext");
    Req::new("PUT", &format!("/v1/chunks/{sid}"))
        .raw_body(&body)
        .sign_with(&cred, NOW, &nonce(), &sid)
        .send(h.addr);

    let file_id = "cd".repeat(16);
    let first = post_version_as(
        &h,
        &cred,
        &file_id,
        &[],
        &[sid.as_str()],
        "bWFuaWZlc3Qtb25l",
        Some(true),
    );
    assert_eq!(first.status, 201, "{}", first.text());
    let stored = first
        .json()
        .get("version_id")
        .and_then(Value::as_str)
        .expect("the answer names the version it stored")
        .to_string();
    let heads = first.json();
    let heads = heads.get("heads").and_then(Value::as_array).expect("heads");
    assert_eq!(
        heads[0].as_str(),
        Some(stored.as_str()),
        "and it is the head"
    );
    let seq = h.app.store.head_seq();

    // The other device's manifest, over the same parents and the same
    // chunks: another version id for one position in the graph.
    let twin = post_version_as(
        &h,
        &cred,
        &file_id,
        &[],
        &[sid.as_str()],
        "bWFuaWZlc3QtdHdv",
        Some(true),
    );
    assert_eq!(twin.status, 200, "{}", twin.text());
    let answered = twin.json();
    assert_eq!(
        answered.get("version_id").and_then(Value::as_str),
        Some(stored.as_str()),
        "the answer names the version the store holds, not the one posted"
    );
    assert_eq!(
        answered.get("conflicted").and_then(Value::as_bool),
        Some(false),
        "the file did not fork"
    );
    assert_eq!(
        answered
            .get("heads")
            .and_then(Value::as_array)
            .expect("heads")
            .len(),
        1
    );
    assert_eq!(
        h.app.store.head_seq(),
        seq,
        "no frame was appended for the twin"
    );
    let logged = h.captured();
    assert!(
        logged.contains("decision=deduplicated"),
        "the decision is in the log: {logged}"
    );

    // The file holds one version, and the id the twin posted is not it.
    let file = Req::get(&format!("/v1/files/{file_id}"))
        .sign(&cred, NOW)
        .send(h.addr)
        .json();
    let versions = file
        .get("versions")
        .and_then(Value::as_array)
        .expect("versions");
    assert_eq!(versions.len(), 1, "{versions:?}");
    assert_eq!(
        versions[0].get("version_id").and_then(Value::as_str),
        Some(stored.as_str())
    );

    // A 1.0.x body carries no `accept_existing` at all, and its post is
    // stored under the id that client computed and will keep: the same fork
    // 1.0.6 closes between the devices, and no behaviour this release
    // changed underneath it.
    let old_client = post_version_as(
        &h,
        &cred,
        &file_id,
        &[],
        &[sid.as_str()],
        "bWFuaWZlc3QtdGhyZWU=",
        None,
    );
    assert_eq!(old_client.status, 201, "{}", old_client.text());
    let answered = old_client.json();
    assert_ne!(
        answered.get("version_id").and_then(Value::as_str),
        Some(stored.as_str()),
        "a client that keeps its own id is never answered with another"
    );
    assert_eq!(
        answered.get("conflicted").and_then(Value::as_bool),
        Some(true),
        "two ids for one position is what 1.0.x does, unchanged"
    );
}

#[test]
fn a_version_posts_reposts_as_a_no_op_and_conflicts_on_a_stale_parent() {
    let h = Harness::start("versions");
    let cred = h.setup_account();
    let (body, sid) = chunk(b"version-ciphertext");
    Req::new("PUT", &format!("/v1/chunks/{sid}"))
        .raw_body(&body)
        .sign_with(&cred, NOW, &nonce(), &sid)
        .send(h.addr);

    let file_id = "ab".repeat(16);
    let first = post_version(
        &h,
        &cred,
        &file_id,
        &[],
        &[sid.as_str()],
        "bWFuaWZlc3Qtb25l",
    );
    assert_eq!(first.status, 201, "{}", first.text());
    let v = first.json();
    assert_eq!(v.get("conflicted").and_then(Value::as_bool), Some(false));
    let head = v.get("heads").and_then(Value::as_array).expect("heads")[0]
        .as_str()
        .expect("head")
        .to_string();

    let repost = post_version(
        &h,
        &cred,
        &file_id,
        &[],
        &[sid.as_str()],
        "bWFuaWZlc3Qtb25l",
    );
    assert_eq!(repost.status, 200, "reposting the same version is a no-op");

    let linear = post_version(
        &h,
        &cred,
        &file_id,
        &[head.as_str()],
        &[sid.as_str()],
        "bWFuaWZlc3QtdHdv",
    );
    assert_eq!(linear.status, 201, "{}", linear.text());
    assert_eq!(
        linear.json().get("conflicted").and_then(Value::as_bool),
        Some(false)
    );

    let stale = post_version(
        &h,
        &cred,
        &file_id,
        &[head.as_str()],
        &[sid.as_str()],
        "bWFuaWZlc3QtdGhyZWU=",
    );
    assert_eq!(stale.status, 201, "{}", stale.text());
    assert_eq!(
        stale.json().get("conflicted").and_then(Value::as_bool),
        Some(true),
        "a post against a stale parent set keeps both heads"
    );
    assert_eq!(
        stale
            .json()
            .get("heads")
            .and_then(Value::as_array)
            .expect("heads")
            .len(),
        2
    );

    let file = Req::get(&format!("/v1/files/{file_id}"))
        .sign(&cred, NOW)
        .send(h.addr);
    assert_eq!(file.status, 200);
    let file_body = file.json();
    assert_eq!(
        file_body.get("conflicted").and_then(Value::as_bool),
        Some(true)
    );
    let two_heads: Vec<String> = file_body
        .get("heads")
        .and_then(Value::as_array)
        .expect("heads")
        .iter()
        .map(|h| h.as_str().expect("head").to_string())
        .collect();
    assert_eq!(two_heads.len(), 2);

    // A merge: one version naming both heads as parents resolves the file.
    let merged = post_version(
        &h,
        &cred,
        &file_id,
        &[two_heads[0].as_str(), two_heads[1].as_str()],
        &[sid.as_str()],
        "bWFuaWZlc3QtbWVyZ2Vk",
    );
    assert_eq!(merged.status, 201, "{}", merged.text());
    let merged_body = merged.json();
    assert_eq!(
        merged_body.get("conflicted").and_then(Value::as_bool),
        Some(false),
        "a version naming every head is the new sole head"
    );
    assert_eq!(
        merged_body
            .get("heads")
            .and_then(Value::as_array)
            .expect("heads")
            .len(),
        1
    );

    let page = Req::get("/v1/files").sign(&cred, NOW).send(h.addr);
    assert_eq!(page.status, 200, "{}", page.text());
    assert_eq!(
        page.json()
            .get("files")
            .and_then(Value::as_array)
            .expect("files")
            .len(),
        1
    );
}

#[test]
fn a_version_id_the_server_does_not_recompute_is_refused_and_named() {
    let h = Harness::start("versions-mismatch");
    let cred = h.setup_account();
    let (body, sid) = chunk(b"mismatch-ciphertext");
    Req::new("PUT", &format!("/v1/chunks/{sid}"))
        .raw_body(&body)
        .sign_with(&cred, NOW, &nonce(), &sid)
        .send(h.addr);

    let file_id = "1a".repeat(16);
    let res = Req::post(&format!("/v1/files/{file_id}/versions"))
        .body(&format!(
            r#"{{"version_id":"{}","parents":[],"sids":["{sid}"],"bytes":19,"domain_id":"{TEST_DOMAIN}","manifest_ct":"bWFuaWZlc3Q=","manifest_nonce":"0123456789abcdef01234567","deleted":false}}"#,
            "00".repeat(32)
        ))
        .sign(&cred, NOW)
        .send(h.addr);
    assert_eq!(res.status, 422, "{}", res.text());
    assert_eq!(res.code(), "version_id_mismatch");
    let v = res.json();
    let expected = v
        .get("expected")
        .and_then(Value::as_str)
        .expect("the refusal names the id the server recomputed");
    assert_eq!(expected.len(), 64);
    assert_ne!(expected, "00".repeat(32));
}

#[test]
fn a_version_naming_a_chunk_the_server_lacks_is_refused_with_the_list() {
    let h = Harness::start("versions-missing");
    let cred = h.setup_account();
    let absent = "9e".repeat(32);
    let res = post_version(
        &h,
        &cred,
        &"cd".repeat(16),
        &[],
        &[absent.as_str()],
        "bWFuaWZlc3Q=",
    );
    assert_eq!(res.status, 409, "{}", res.text());
    assert_eq!(res.code(), "missing_chunks");
    let v = res.json();
    let listed = v.get("missing").and_then(Value::as_array).expect("missing");
    assert_eq!(listed[0].as_str(), Some(absent.as_str()));
}

#[test]
fn the_change_feed_long_polls_and_wakes_on_a_concurrent_post() {
    let h = Harness::start("changes");
    let cred = h.setup_account();
    let (body, sid) = chunk(b"feed-ciphertext");
    Req::new("PUT", &format!("/v1/chunks/{sid}"))
        .raw_body(&body)
        .sign_with(&cred, NOW, &nonce(), &sid)
        .send(h.addr);

    let head = Req::get("/v1/changes?since=0")
        .sign(&cred, NOW)
        .send(h.addr);
    assert_eq!(head.status, 200, "{}", head.text());
    let since = head
        .json()
        .get("head_seq")
        .and_then(Value::as_u64)
        .expect("head_seq");

    let ahead = Req::get(&format!("/v1/changes?since={}", since + 5))
        .sign(&cred, NOW)
        .send(h.addr);
    assert_eq!(ahead.status, 416, "{}", ahead.text());
    assert_eq!(ahead.code(), "seq_ahead");

    let addr = h.addr;
    let poster = Cred {
        id: cred.id.clone(),
        secret: cred.secret,
    };
    let done = Arc::new(Mutex::new(false));
    let writer_done = Arc::clone(&done);
    let writer = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        let parents_json = String::new();
        let body = |version_id: &str| {
            format!(
                r#"{{"version_id":"{version_id}","parents":[{parents_json}],"sids":["{sid}"],"bytes":15,"domain_id":"{TEST_DOMAIN}","manifest_ct":"bWFuaWZlc3Q=","manifest_nonce":"0123456789abcdef01234567","deleted":false}}"#
            )
        };
        let file = "ef".repeat(16);
        let probe = Req::post(&format!("/v1/files/{file}/versions"))
            .body(&body(&"00".repeat(32)))
            .sign(&poster, NOW)
            .send(addr);
        let expected = probe
            .json()
            .get("expected")
            .and_then(Value::as_str)
            .expect("expected id")
            .to_string();
        let posted = Req::post(&format!("/v1/files/{file}/versions"))
            .body(&body(&expected))
            .sign(&poster, NOW)
            .send(addr);
        assert_eq!(posted.status, 201, "{}", posted.text());
        *writer_done.lock().expect("done") = true;
    });

    let started = std::time::Instant::now();
    let polled = Req::get(&format!("/v1/changes?since={since}&wait=20"))
        .sign(&cred, NOW)
        .send(h.addr);
    let waited = started.elapsed();
    writer.join().expect("writer");
    assert!(*done.lock().expect("done"), "the writer posted");
    assert_eq!(polled.status, 200, "{}", polled.text());
    assert!(
        waited < Duration::from_secs(10),
        "the long poll must wake on the post, not on the timeout: {waited:?}"
    );
    let changes = polled.json();
    let list = changes
        .get("changes")
        .and_then(Value::as_array)
        .expect("changes");
    assert_eq!(list.len(), 1, "the feed carries the version that landed");
    assert!(
        list[0].get("manifest_ct").is_some(),
        "the feed carries the encrypted manifest"
    );
}

#[test]
fn a_revoked_device_is_refused_from_that_moment() {
    let h = Harness::start("revoke");
    let creator = h.setup_account();
    let res = Req::post("/v1/pairing").sign(&creator, NOW).send(h.addr);
    let v = res.json();
    let id = v
        .get("pairing_id")
        .and_then(Value::as_str)
        .expect("id")
        .to_string();
    let token = v
        .get("enroll_token")
        .and_then(Value::as_str)
        .expect("token")
        .to_string();
    let claimed = Req::post(&format!("/v1/pairing/{id}/claim"))
        .body(&format!(
            r#"{{"enroll_token":"{token}","name":"phone","platform":"ios","app_version":"0.1.0"}}"#
        ))
        .send(h.addr);
    let claimant = Cred::from_json(&claimed.json());
    let approve = Req::post(&format!("/v1/pairing/{id}/approve"))
        .body(r#"{"envelope":"Y2lwaGVy","nonce":"0123456789abcdef01234567"}"#)
        .sign(&creator, NOW)
        .send(h.addr);
    assert_eq!(approve.status, 204, "{}", approve.text());
    assert_eq!(
        Req::get("/v1/account")
            .sign(&claimant, NOW)
            .send(h.addr)
            .status,
        200
    );

    let alone = Req::post(&format!("/v1/devices/{}/revoke", creator.id))
        .sign(&creator, NOW)
        .send(h.addr);
    assert_eq!(
        alone.status, 204,
        "another device exists, so this is allowed"
    );

    let refused = Req::get("/v1/account").sign(&creator, NOW).send(h.addr);
    assert_eq!(refused.status, 403);
    assert_eq!(refused.code(), "device_revoked");

    let last = Req::post(&format!("/v1/devices/{}/revoke", claimant.id))
        .sign(&claimant, NOW)
        .send(h.addr);
    assert_eq!(last.status, 409, "{}", last.text());
    assert_eq!(last.code(), "last_device");
}

#[test]
fn a_device_reports_its_ceilings_by_heartbeat() {
    let h = Harness::start("heartbeat");
    let cred = h.setup_account();
    let res = Req::post("/v1/devices/heartbeat")
        .body(r#"{"app_version":"0.1.1","policy":{"per_file_max_bytes":536870912,"total_budget_bytes":53687091200}}"#)
        .sign(&cred, NOW)
        .send(h.addr);
    assert_eq!(res.status, 204, "{}", res.text());

    let devices = Req::get("/v1/devices").sign(&cred, NOW).send(h.addr);
    let v = devices.json();
    let first = v.get("devices").and_then(Value::as_array).expect("devices")[0].clone();
    assert_eq!(
        first.get("app_version").and_then(Value::as_str),
        Some("0.1.1")
    );
    assert_eq!(
        first
            .get("policy")
            .and_then(|p| p.get("per_file_max_bytes"))
            .and_then(Value::as_u64),
        Some(536_870_912)
    );
}

/// Every member name of a JSON object, sorted: what a response says about a
/// record, exhaustively, so a field ADDED to it is a failure and not a
/// silently accepted extra.
fn object_keys(value: &Value) -> Vec<String> {
    let mut names: Vec<String> = value
        .as_object()
        .expect("an object")
        .iter()
        .map(|(name, _)| name.clone())
        .collect();
    names.sort();
    names
}

#[test]
fn a_device_is_renamed_and_a_control_character_in_a_name_is_refused() {
    let h = Harness::start("devices-domains");
    let cred = h.setup_account();
    let renamed = Req::new("PATCH", &format!("/v1/devices/{}", cred.id))
        .body(r#"{"name":"studio laptop"}"#)
        .sign(&cred, NOW)
        .send(h.addr);
    assert_eq!(renamed.status, 200, "{}", renamed.text());
    assert_eq!(
        renamed.json().get("name").and_then(Value::as_str),
        Some("studio laptop")
    );

    let injected = Req::new("PATCH", &format!("/v1/devices/{}", cred.id))
        .body("{\"name\":\"bad\\nname\"}")
        .sign(&cred, NOW)
        .send(h.addr);
    assert_eq!(
        injected.status, 400,
        "a control character in a name is refused"
    );
}

#[test]
fn plugin_metadata_remains_public_while_byte_routes_are_absent() {
    let bare = Harness::start("plugin-none");
    let res = Req::get("/v1/plugin/manifest").send(bare.addr);
    assert_eq!(res.status, 404);
    assert_eq!(res.code(), "plugin_unavailable");
    let h = Harness::start_with(
        "plugin",
        Setup {
            plugin: true,
            ..Setup::default()
        },
    );
    let manifest = Req::get("/v1/plugin/manifest").send(h.addr);
    assert_eq!(manifest.status, 200, "{}", manifest.text());
    let v = manifest.json();
    assert_eq!(v.get("id").and_then(Value::as_str), Some("obsync"));
    assert_eq!(
        v.get("bundle_sha256").and_then(Value::as_str),
        Some(hex::encode(&sha256::sha256(b"export default {};")).as_str())
    );
    assert_eq!(
        v.get("styles_sha256").and_then(Value::as_str),
        Some(hex::encode(&sha256::sha256(b".obsync{}")).as_str())
    );
    for addr in [bare.addr, h.addr] {
        for path in ["/v1/plugin/bundle", "/v1/plugin/styles"] {
            let res = Req::get(path).send(addr);
            assert_eq!(res.status, 404, "{path}");
            assert_eq!(res.code(), "not_found", "{path}");
        }
    }
}

#[test]
fn the_dashboard_serves_its_files_with_the_strict_policy() {
    let h = Harness::start_with(
        "dashboard",
        Setup {
            dashboard: true,
            ..Setup::default()
        },
    );
    let index = Req::get("/").send(h.addr);
    assert_eq!(index.status, 200, "{}", index.text());
    assert_eq!(
        index.header("content-type"),
        Some("text/html; charset=utf-8")
    );
    let csp = index
        .header("content-security-policy")
        .expect("a CSP on every dashboard response");
    assert!(csp.contains("default-src 'self'"), "{csp}");
    assert!(csp.contains("frame-ancestors 'none'"), "{csp}");
    assert!(
        !csp.contains("unsafe-inline"),
        "no inline script is ever allowed: {csp}"
    );
    assert!(
        csp.contains("object-src 'none'"),
        "plugins and embeds are named rather than left to default-src: {csp}"
    );
    // A page that opens no window and is embedded by nobody pays nothing
    // for cross-origin isolation.
    assert_eq!(
        index.header("cross-origin-opener-policy"),
        Some("same-origin")
    );
    assert_eq!(
        index.header("cross-origin-resource-policy"),
        Some("same-origin")
    );
    assert_eq!(
        index.header("x-obsync-seq"),
        None,
        "a page request proves no credential"
    );

    assert_eq!(
        Req::get("/app.css").send(h.addr).header("content-type"),
        Some("text/css; charset=utf-8")
    );
    assert_eq!(
        Req::get("/app.js").send(h.addr).header("content-type"),
        Some("text/javascript; charset=utf-8")
    );
    assert_eq!(Req::get("/lib.js").send(h.addr).status, 200);
    assert_eq!(Req::get("/nope.js").send(h.addr).status, 404);

    let bare = Harness::start("dashboard-none");
    let res = Req::get("/").send(bare.addr);
    assert_eq!(res.status, 404);
    assert_eq!(res.code(), "dashboard_unavailable");
}

#[test]
fn the_dashboard_session_needs_a_link_and_every_mutation_needs_the_csrf_header() {
    let h = Harness::start_with(
        "admin",
        Setup {
            dashboard: true,
            ..Setup::default()
        },
    );
    let cred = h.setup_account();

    assert_eq!(Req::get("/v1/admin/overview").send(h.addr).status, 401);
    assert_eq!(Req::get("/login?token=nope").send(h.addr).status, 401);

    let link = Req::post("/v1/dashboard/login-link")
        .sign(&cred, NOW)
        .send(h.addr);
    assert_eq!(link.status, 200, "{}", link.text());
    let url = link
        .json()
        .get("url")
        .and_then(Value::as_str)
        .expect("url")
        .to_string();
    let token = url
        .split("token=")
        .nth(1)
        .expect("token in the url")
        .to_string();

    let login = Req::get(&format!("/login?token={token}")).send(h.addr);
    assert_eq!(login.status, 302);
    assert_eq!(login.header("location"), Some("/"));
    let cookies = login.headers_all("set-cookie");
    assert_eq!(cookies.len(), 2, "session and CSRF: {cookies:?}");
    let session = cookies
        .iter()
        .find(|c| c.starts_with("__Host-obsync_session="))
        .expect("session cookie")
        .to_string();
    let csrf = cookies
        .iter()
        .find(|c| c.starts_with("__Host-obsync_csrf="))
        .expect("csrf")
        .to_string();
    assert!(session.contains("HttpOnly"), "{session}");
    assert!(
        !csrf.contains("HttpOnly"),
        "the double-submit value must be readable: {csrf}"
    );
    // Both cookies are `__Host-` names, and a browser refuses one of those
    // without `Secure`, without `Path=/`, or with a `Domain`. That is what
    // stops a plaintext hop or a sibling host from planting or reading one.
    for c in [&session, &csrf] {
        assert!(c.contains("Secure"), "{c}");
        assert!(c.contains("SameSite=Strict"), "{c}");
        assert!(c.contains("Path=/"), "{c}");
        assert!(!c.contains("Domain="), "{c}");
    }

    let session_value = session.split(';').next().expect("pair").to_string();
    let csrf_value = csrf.split(';').next().expect("pair").to_string();
    let csrf_token = csrf_value.split('=').nth(1).expect("value").to_string();
    let cookie_header = format!("{session_value}; {csrf_value}");

    let spent = Req::get(&format!("/login?token={token}")).send(h.addr);
    assert_eq!(spent.status, 401, "a login link works once");

    let overview = Req::get("/v1/admin/overview")
        .header("Cookie", &cookie_header)
        .send(h.addr);
    assert_eq!(overview.status, 200, "{}", overview.text());
    let v = overview.json();
    for key in [
        "account",
        "edge",
        "public_url",
        "volumes",
        "versions",
        "activity",
        "last_gc",
        "last_scrub",
    ] {
        assert!(v.get(key).is_some(), "the overview must carry {key}");
    }
    assert_eq!(v.get("edge").and_then(Value::as_str), Some("none"));
    let hours = v
        .get("activity")
        .and_then(|a| a.get("versions_per_hour"))
        .and_then(Value::as_array)
        .expect("versions_per_hour");
    assert_eq!(hours.len(), 24, "24 hourly buckets");
    let first = hours[0].get("hour").and_then(Value::as_u64).expect("hour");
    let last = hours[23].get("hour").and_then(Value::as_u64).expect("hour");
    assert_eq!(last - first, 23 * 3600, "oldest first, one hour apart");

    let storage = Req::get("/v1/admin/storage")
        .header("Cookie", &cookie_header)
        .send(h.addr);
    assert_eq!(storage.status, 200, "{}", storage.text());
    let sv = storage.json();
    for key in [
        "volumes",
        "retention",
        "watermark",
        "gc",
        "scrub",
        "quarantine",
    ] {
        assert!(sv.get(key).is_some(), "the storage view must carry {key}");
    }
    assert_eq!(
        sv.get("gc")
            .and_then(|g| g.get("state"))
            .and_then(Value::as_str),
        Some("idle"),
        "nothing is collecting in a test server with no background threads"
    );

    let devices = Req::get("/v1/admin/devices")
        .header("Cookie", &cookie_header)
        .send(h.addr);
    assert_eq!(devices.status, 200, "{}", devices.text());

    // The domain listings are gone with the ledger they read: a domain is a
    // field on a file record now (`docs/architecture.md` 5.1 item 4), and an
    // endpoint nothing calls is surface nobody needs.
    for target in ["/v1/admin/domains", "/v1/domains"] {
        let gone = Req::get(target)
            .header("Cookie", &cookie_header)
            .send(h.addr);
        assert_eq!(gone.status, 404, "{target} still answers: {}", gone.text());
    }

    let no_csrf = Req::post("/v1/admin/gc/run")
        .header("Cookie", &cookie_header)
        .send(h.addr);
    assert_eq!(no_csrf.status, 403, "{}", no_csrf.text());
    assert_eq!(no_csrf.code(), "csrf_failed");

    let wrong_csrf = Req::post("/v1/admin/gc/run")
        .header("Cookie", &cookie_header)
        .header("X-Obsync-Csrf", "not-the-value")
        .send(h.addr);
    assert_eq!(wrong_csrf.status, 403);

    let queued = Req::post("/v1/admin/gc/run")
        .header("Cookie", &cookie_header)
        .header("X-Obsync-Csrf", &csrf_token)
        .send(h.addr);
    assert_eq!(queued.status, 202, "{}", queued.text());
    assert!(h.app.take_gc_request(), "the collector was asked to run");

    let logs = Req::get("/v1/admin/logs?limit=5")
        .header("Cookie", &cookie_header)
        .send(h.addr);
    assert_eq!(logs.status, 200, "{}", logs.text());
    let logs_json = logs.json();
    let lines = logs_json
        .get("lines")
        .and_then(Value::as_array)
        .expect("lines");
    assert!(
        !lines.is_empty(),
        "the decision log has this session's own requests"
    );
    let text = logs.text();
    assert!(
        !text.contains("5e5e5e"),
        "no credential reaches the log view: {text}"
    );

    let logout = Req::post("/v1/admin/logout")
        .header("Cookie", &cookie_header)
        .header("X-Obsync-Csrf", &csrf_token)
        .send(h.addr);
    assert_eq!(logout.status, 204, "{}", logout.text());
    for c in logout.headers_all("set-cookie") {
        assert!(c.contains("Max-Age=0"), "{c}");
        assert!(
            c.contains("Secure"),
            "a `__Host-` cookie is cleared only by a clear the browser accepts: {c}"
        );
    }
    let after = Req::get("/v1/admin/overview")
        .header("Cookie", &cookie_header)
        .send(h.addr);
    assert_eq!(after.status, 401, "the session is closed");
}

/// One session per browser is not the unit an operator can act on: the unit
/// is "every browser I ever signed in". Nothing offered that before, and a
/// session could not be ended remotely at all short of a restart.
#[test]
fn signing_out_everywhere_ends_every_session_not_only_this_one() {
    let h = Harness::start_with(
        "logout-all",
        Setup {
            dashboard: true,
            ..Setup::default()
        },
    );
    let cred = h.setup_account();
    let one = admin_cookie(&h, &cred);
    let two = admin_cookie(&h, &cred);
    assert_ne!(one, two, "two independent sessions");
    for c in [&one, &two] {
        assert_eq!(
            Req::get("/v1/admin/overview")
                .header("Cookie", c)
                .send(h.addr)
                .status,
            200
        );
    }

    // A link minted and never spent is the same key to the same dashboard:
    // the machine the operator no longer controls may be holding one.
    let unspent = login_token(&h, &cred);

    let csrf = csrf_value(&two);
    let all = Req::post("/v1/admin/logout-all")
        .header("Cookie", &two)
        .header("X-Obsync-Csrf", &csrf)
        .send(h.addr);
    assert_eq!(all.status, 204, "{}", all.text());

    let spent_after = Req::get(&format!("/login?token={unspent}")).send(h.addr);
    assert_eq!(
        (spent_after.status, spent_after.code()),
        (401, "bad_login_token".to_string()),
        "signing out everywhere burns the links nobody spent, or it handed \
         back exactly what it was pressed to take away"
    );
    for c in [&one, &two] {
        assert_eq!(
            Req::get("/v1/admin/overview")
                .header("Cookie", c)
                .send(h.addr)
                .status,
            401,
            "every session is out, the one that asked included"
        );
    }

    // It is a mutation like any other: no session, no CSRF header, no.
    assert_eq!(Req::post("/v1/admin/logout-all").send(h.addr).status, 401);
    let three = admin_cookie(&h, &cred);
    let no_csrf = Req::post("/v1/admin/logout-all")
        .header("Cookie", &three)
        .send(h.addr);
    assert_eq!(no_csrf.status, 403);
    assert_eq!(no_csrf.code(), "csrf_failed");
}

/// A session that nothing uses stops being accepted an hour in, long before
/// the twelve-hour limit; a session in use is carried by its use.
#[test]
fn a_dashboard_session_left_idle_expires_before_its_absolute_limit() {
    let h = Harness::start_with(
        "idle",
        Setup {
            dashboard: true,
            ..Setup::default()
        },
    );
    let cred = h.setup_account();
    let cookie = admin_cookie(&h, &cred);
    let idle = crate::api::admin::SESSION_IDLE_SECS;

    // Used just before the idle limit, which carries it past that limit.
    h.clock.set(NOW + idle - 1);
    assert_eq!(
        Req::get("/v1/admin/overview")
            .header("Cookie", &cookie)
            .send(h.addr)
            .status,
        200
    );
    h.clock.set(NOW + idle + 1);
    assert_eq!(
        Req::get("/v1/admin/overview")
            .header("Cookie", &cookie)
            .send(h.addr)
            .status,
        200,
        "use pushes the idle window out"
    );

    // Then left alone for one whole window.
    h.clock.set(NOW + 2 * idle + 2);
    let out = Req::get("/v1/admin/overview")
        .header("Cookie", &cookie)
        .send(h.addr);
    assert_eq!(out.status, 401, "{}", out.text());
    assert_eq!(out.code(), "no_session");
}

#[test]
fn the_setup_token_is_the_documented_recovery_login_and_the_page_is_told() {
    let h = Harness::start_with(
        "recovery",
        Setup {
            dashboard: true,
            ..Setup::default()
        },
    );
    let cred = h.setup_account();
    let login = Req::get(&format!("/login?token={}", "5e".repeat(32))).send(h.addr);
    assert_eq!(login.status, 302, "{}", login.text());
    assert_eq!(login.headers_all("set-cookie").len(), 2);

    // A standing credential with no device behind it is worth saying out
    // loud on the page it signed into.
    let cookie = cookie_header(&login);
    let overview = Req::get("/v1/admin/overview")
        .header("Cookie", &cookie)
        .send(h.addr);
    assert_eq!(overview.status, 200, "{}", overview.text());
    assert_eq!(
        overview
            .json()
            .get("session")
            .and_then(|s| s.get("recovery"))
            .and_then(Value::as_bool),
        Some(true)
    );

    // A session opened from a device's link is not one.
    let from_device = admin_cookie(&h, &cred);
    let ordinary = Req::get("/v1/admin/overview")
        .header("Cookie", &from_device)
        .send(h.addr);
    assert_eq!(
        ordinary
            .json()
            .get("session")
            .and_then(|s| s.get("recovery"))
            .and_then(Value::as_bool),
        Some(false)
    );
}

/// Removing the attempt limit rests on refusals being VISIBLE instead. That
/// has to hold on the page an operator actually reads, not only on stdout.
#[test]
fn a_refused_sign_in_is_visible_on_the_logs_page() {
    let h = Harness::start_with(
        "login-visible",
        Setup {
            dashboard: true,
            ..Setup::default()
        },
    );
    let cred = h.setup_account();
    for _ in 0..3 {
        let refused = Req::get("/login?token=deadbeef").send(h.addr);
        assert_eq!(refused.status, 401, "{}", refused.text());
        assert_eq!(refused.code(), "bad_login_token");
    }

    let cookie = admin_cookie(&h, &cred);
    let logs = Req::get("/v1/admin/logs?limit=200")
        .header("Cookie", &cookie)
        .send(h.addr);
    assert_eq!(logs.status, 200, "{}", logs.text());
    let body = logs.json();
    let lines = body.get("lines").and_then(Value::as_array).expect("lines");
    let refusals = lines
        .iter()
        .filter(|l| {
            l.get("path_class").and_then(Value::as_str) == Some("/login")
                && l.get("decision").and_then(Value::as_str) == Some("bad_login_token")
        })
        .count();
    assert_eq!(
        refusals,
        3,
        "every refusal reaches the page, each naming its decision: {}",
        logs.text()
    );
    assert!(
        !logs.text().contains("deadbeef"),
        "and none of them carries the token that was tried: {}",
        logs.text()
    );
}

/// Revocation says "its next request fails" on the page. It has to mean the
/// dashboard too: the link the device minted five minutes ago, and the
/// session that link opened.
#[test]
fn revoking_a_device_ends_the_links_and_sessions_it_minted() {
    let h = Harness::start_with(
        "revoke-sessions",
        Setup {
            dashboard: true,
            ..Setup::default()
        },
    );
    let creator = h.setup_account();
    let (id, claimant) = claim_pairing(&h, &creator);
    approve_pairing(&h, &creator, &id);

    // A session opened from the claimant's link, and a second link of its
    // own that nobody has spent yet.
    let doomed = admin_cookie(&h, &claimant);
    let unspent = login_token(&h, &claimant);
    // Plus a session from the device that survives, which must not be
    // touched by any of this.
    let kept = admin_cookie(&h, &creator);
    assert_eq!(
        Req::get("/v1/admin/overview")
            .header("Cookie", &doomed)
            .send(h.addr)
            .status,
        200
    );

    let csrf = csrf_value(&kept);
    let revoke = Req::post(&format!("/v1/admin/devices/{}/revoke", claimant.id))
        .header("Cookie", &kept)
        .header("X-Obsync-Csrf", &csrf)
        .send(h.addr);
    assert_eq!(revoke.status, 204, "{}", revoke.text());

    let after = Req::get("/v1/admin/overview")
        .header("Cookie", &doomed)
        .send(h.addr);
    assert_eq!(after.status, 401, "the session it opened is over");
    assert_eq!(after.code(), "no_session");
    let spent = Req::get(&format!("/login?token={unspent}")).send(h.addr);
    assert_eq!(
        spent.status,
        401,
        "the link it minted buys nothing: {}",
        spent.text()
    );
    assert_eq!(
        Req::get("/v1/admin/overview")
            .header("Cookie", &kept)
            .send(h.addr)
            .status,
        200,
        "and no other session is disturbed"
    );
}

/// The other revoke route reaches the dashboard the same way: a device
/// revoked from a paired device also loses its links and its sessions.
#[test]
fn revoking_a_device_from_another_device_ends_its_dashboard_hold_too() {
    let h = Harness::start_with(
        "revoke-sessions-device",
        Setup {
            dashboard: true,
            ..Setup::default()
        },
    );
    let creator = h.setup_account();
    let (id, claimant) = claim_pairing(&h, &creator);
    approve_pairing(&h, &creator, &id);

    let doomed = admin_cookie(&h, &creator);
    let unspent = login_token(&h, &creator);
    assert_eq!(
        Req::get("/v1/admin/overview")
            .header("Cookie", &doomed)
            .send(h.addr)
            .status,
        200
    );

    let revoke = Req::post(&format!("/v1/devices/{}/revoke", creator.id))
        .sign(&claimant, NOW)
        .send(h.addr);
    assert_eq!(revoke.status, 204, "{}", revoke.text());

    assert_eq!(
        Req::get("/v1/admin/overview")
            .header("Cookie", &doomed)
            .send(h.addr)
            .status,
        401,
        "the session its link opened is over"
    );
    assert_eq!(
        Req::get(&format!("/login?token={unspent}"))
            .send(h.addr)
            .status,
        401,
        "and the link it had already minted buys nothing"
    );
}

/// The dashboard's revoke had no last-device guard at all, so one click on
/// the only device ended the account: nothing re-enrols one.
#[test]
fn the_dashboard_refuses_to_revoke_the_only_active_device() {
    let h = Harness::start_with(
        "revoke-last",
        Setup {
            dashboard: true,
            ..Setup::default()
        },
    );
    let cred = h.setup_account();
    let cookie = admin_cookie(&h, &cred);
    let csrf = csrf_value(&cookie);

    let refused = Req::post(&format!("/v1/admin/devices/{}/revoke", cred.id))
        .header("Cookie", &cookie)
        .header("X-Obsync-Csrf", &csrf)
        .send(h.addr);
    assert_eq!(refused.status, 409, "{}", refused.text());
    assert_eq!(refused.code(), "last_device");
    assert_eq!(
        Req::get("/v1/account").sign(&cred, NOW).send(h.addr).status,
        200,
        "the device it refused to revoke still syncs"
    );

    // With a second active device it is allowed, which is what keeps the
    // guard from being a refusal of everything.
    let (id, claimant) = claim_pairing(&h, &cred);
    approve_pairing(&h, &cred, &id);
    let allowed = Req::post(&format!("/v1/admin/devices/{}/revoke", claimant.id))
        .header("Cookie", &cookie)
        .header("X-Obsync-Csrf", &csrf)
        .send(h.addr);
    assert_eq!(allowed.status, 204, "{}", allowed.text());
    // And the first device is the last one again.
    let last_again = Req::post(&format!("/v1/admin/devices/{}/revoke", cred.id))
        .header("Cookie", &cookie)
        .header("X-Obsync-Csrf", &csrf)
        .send(h.addr);
    assert_eq!(last_again.status, 409);
    assert_eq!(last_again.code(), "last_device");
}

/// The decision log is what the dashboard shows an operator after an
/// incident. A single ring shared with unauthenticated traffic meant anyone
/// who could reach the port could empty it with free probes.
#[test]
fn unauthenticated_probes_cannot_evict_the_authenticated_decision_log() {
    let h = Harness::start_with(
        "log-ring",
        Setup {
            dashboard: true,
            ..Setup::default()
        },
    );
    let cred = h.setup_account();
    let cookie = admin_cookie(&h, &cred);
    assert_eq!(
        Req::get("/v1/admin/storage")
            .header("Cookie", &cookie)
            .send(h.addr)
            .status,
        200
    );

    // More probes than the public ring holds, run from a few threads: the
    // acceptor polls, so a serial flood would spend its time sleeping.
    let per_worker = crate::api::RECENT_PUBLIC_LOG_LINES / 8 + 8;
    let addr = h.addr;
    let workers: Vec<_> = (0..8)
        .map(|_| {
            std::thread::spawn(move || {
                for _ in 0..per_worker {
                    assert_eq!(Req::get("/livez").send(addr).status, 200);
                }
            })
        })
        .collect();
    for w in workers {
        w.join().expect("the flood finishes");
    }

    let lines = h.app.recent_lines(None, 5_000);
    let probes = lines.iter().filter(|l| l.path_class == "/livez").count();
    assert_eq!(
        probes,
        crate::api::RECENT_PUBLIC_LOG_LINES,
        "the flood fills its own ring and stops there"
    );
    assert!(
        lines
            .iter()
            .any(|l| l.path_class == "/v1/admin/storage" && l.status == 200),
        "the authenticated read the operator is looking for is still there"
    );
    assert!(
        lines
            .iter()
            .any(|l| l.path_class == "/v1/dashboard/login-link"),
        "and so is the oldest credentialed decision on this server"
    );
    assert!(
        lines.iter().any(|l| l.path_class == "/login"),
        "the sign-in an operator has to be able to see is still shown too"
    );
}

/// Which server is this, and has anybody claimed it? Not a question an
/// unauthenticated caller gets to ask by sending a wrong token.
#[test]
fn a_wrong_setup_token_tells_a_claimed_server_from_an_unclaimed_one_to_nobody() {
    let h = Harness::start("setup-oracle");
    let wrong = format!(
        r#"{{"setup_token":"{}","account_name":"vault","device":{{"name":"laptop","platform":"macos","app_version":"0.1.0"}}}}"#,
        "11".repeat(32)
    );
    let before = Req::post("/v1/setup").body(&wrong).send(h.addr);
    assert_eq!(before.status, 401);
    assert_eq!(before.code(), "bad_setup_token");

    h.setup_account();
    let after = Req::post("/v1/setup").body(&wrong).send(h.addr);
    assert_eq!(
        (after.status, after.code()),
        (before.status, before.code()),
        "a claimed server answers a wrong token exactly as an unclaimed one does"
    );

    // The documented refusal still reaches the caller that holds the token.
    let right = Req::post("/v1/setup")
        .body(&format!(
            r#"{{"setup_token":"{}","account_name":"vault","device":{{"name":"laptop","platform":"macos","app_version":"0.1.0"}}}}"#,
            "5e".repeat(32)
        ))
        .send(h.addr);
    assert_eq!(right.status, 409);
    assert_eq!(right.code(), "already_set_up");
}

#[test]
fn the_request_log_keeps_a_route_template_and_never_a_vault_path() {
    let h = Harness::start("logs");
    let cred = h.setup_account();
    let sid = "ab".repeat(32);
    Req::get(&format!("/v1/chunks/{sid}"))
        .sign(&cred, NOW)
        .send(h.addr);
    let lines = h.app.recent_lines(None, 64);
    assert!(!lines.is_empty());
    let chunk_line = lines
        .iter()
        .find(|l| l.path_class == "/v1/chunks/{sid}")
        .expect("the chunk line");
    assert_eq!(chunk_line.decision, "unknown_chunk");
    assert_eq!(
        chunk_line.device.map(|id| id.to_string()).as_deref(),
        Some(cred.id.as_str())
    );
    assert!(chunk_line.duration_ms < 5_000);
    for line in &lines {
        assert!(
            !line.path_class.contains(&sid),
            "no id reaches the log class"
        );
    }
}

#[test]
fn a_header_value_cannot_forge_the_device_field_of_a_log_line() {
    let h = Harness::start("log-injection");
    let res = Req::get("/v1/account")
        .header("X-Obsync-Device", "not-a-device-id")
        .header("X-Obsync-Ts", &NOW.to_string())
        .header("X-Obsync-Nonce", &nonce())
        .header("X-Obsync-Sig", &"ab".repeat(32))
        .send(h.addr);
    assert_eq!(res.status, 401);
    let lines = h.app.recent_lines(None, 4);
    assert_eq!(
        lines[0].device, None,
        "a value that is not 32 hex characters is dropped"
    );
    assert!(
        h.app.recent_lines(Some("abc"), 4).is_empty(),
        "a device filter matches nothing when no line names a device"
    );
}

#[test]
fn the_clock_the_server_signs_against_is_the_one_it_is_given() {
    let h = Harness::start("clock");
    let cred = h.setup_account();
    h.clock.set(NOW + 10_000);
    let stale = Req::get("/v1/account").sign(&cred, NOW).send(h.addr);
    assert_eq!(stale.code(), "stale_timestamp");
    let fresh = Req::get("/v1/account")
        .sign(&cred, NOW + 10_000)
        .send(h.addr);
    assert_eq!(fresh.status, 200, "{}", fresh.text());
}

#[test]
fn a_temporary_volume_is_the_only_place_the_test_writes() {
    let dir = temp_dir("cleanup");
    let root = std::fs::canonicalize(std::env::temp_dir()).expect("temp root resolves");
    assert!(dir.starts_with(root));
    assert!(Path::new(&dir).is_dir());
    std::fs::remove_dir_all(&dir).expect("cleanup");
}

/// Cross-implementation vectors: the server must agree with the device.
///
/// Every constant below is copied from `plugin/test/fixtures/crypto.json` on
/// the plugin lane, which generates them with WebCrypto. They are sentinels,
/// not keys. If the two implementations ever disagree about a storage id, a
/// version id, or a request signature, one of these fails and says which.
mod fixtures {
    use super::{Harness, NOW, Req, Res, Value};
    use obsync_core::{base64, hex, hmac, sha256};

    /// `chunks[0]`, the empty plaintext.
    const EMPTY_CIPHERTEXT: &str = "ec74e5ea67d61137275881869f9c910c";
    /// `chunks[0].sid`.
    const EMPTY_SID: &str = "ead932adc0bbf82605eb060a45a087574f3d69807adb22afc8bf8e74ce0a0e7a";
    /// `chunks[1]`, a short note.
    const NOTE_CIPHERTEXT: &str =
        "953b20c79168e9dc9d7534a7e0edf0d592417844d6babe6f825733e88bc58fd3017786e53c";
    /// `chunks[1].sid`.
    const NOTE_SID: &str = "5ad111d7a6cea2721e00bd11da5705aa41c3250ee7d8282a838537fbef793489";
    /// `chunks[2].sid`; that case's ciphertext is not in the fixture.
    const BLOCK_SID: &str = "e9d4c94493314f600c42b93cd02b8b6583f601a48f73ebffa9b414e9d4140221";

    /// `manifest.file_id`.
    const FILE_ID: &str = "00112233445566778899aabbccddeeff";
    /// The domain the fixture's file is in; the server stores it in clear.
    const DOMAIN: &str = "4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d";
    /// `manifest.parents`, in the fixture's order, which is not sorted: the
    /// version id is defined over the SORTED parents, so posting them this way
    /// proves both sides sort before hashing.
    const PARENTS: [&str; 2] = [
        "2222222222222222222222222222222222222222222222222222222222222222",
        "1111111111111111111111111111111111111111111111111111111111111111",
    ];
    /// `manifest.nonce`.
    const MANIFEST_NONCE: &str = "6e4f64716e3a362133f3ce72";
    /// `manifest.version_id`, which the server must recompute exactly.
    const VERSION_ID: &str = "3fedb9beb13176dfa5f97036b3af9ae967c080f9b906de15d73be8354776efa3";
    /// `manifest.ciphertext_hex`.
    const MANIFEST_CT: &str = "955f1c043d515403a11098b8581f6924eabc13709f71844b93c44c285a6623a2700f1e325f759b3b9bab208ab5251cb1834bfb4e554981dbd7a90a08de755f97014d5a8f72be28e8d2052cbb87d2eec1505acef36c365bd925c6ad222d37b42c6c6aa2daaf28ffe72cb410d8b1df698127b3f5b87d1481d89b9fab37ef392284261ed6c968fd79561f89f7e76dce83ca05ab1345a25d616544e0303fbc0307737ff68978fdee9919f3aca45a3066786c1fe65eb8b99570dde772e938a8f0d8f62cdc26d0b0ca0feeb8c69bfff88bbc2254387400f53e929233d80bb408cc99694e64ae1d814cc18bb4e4e9804217fa14d8d2bf6684d4a89ef894139f9cdae3be8ee3fb264e71a7ef41773e388307ec9213b4a7fbf4d48227d5da4193416c5b511fdf426badf5dea45eca8fc65cfa6e37921fe75736e741b0e208cd39e7e58cf6ea55e92c788a89a3122f0901be54c3562b1125452424a29bdc2f08d965f4f7da03d67ec8607cc3be9e4cd066577f2bd9f3f3f7d31a7b041d7bacfdc7c5d8ea41c9";

    /// `signature.*`: one signed request, end to end.
    const SIG_SECRET: &str = "a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf";
    const SIG_TARGET: &str = "/v1/files/00112233445566778899aabbccddeeff/versions";
    const SIG_TS: &str = "1757200000";
    const SIG_NONCE: &str = "8d2f0a1b4c6e7f90a1b2c3d4e5f60718";
    const SIG_BODY_HASH: &str = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
    const SIG: &str = "6418a21e8d1e507aadf70f197f71a64900da961926f52f6da1a3428be844ce40";

    #[test]
    fn every_fixture_sid_is_the_sha256_of_its_ciphertext() {
        for (ciphertext, sid) in [(EMPTY_CIPHERTEXT, EMPTY_SID), (NOTE_CIPHERTEXT, NOTE_SID)] {
            let bytes = hex::decode(ciphertext).expect("fixture ciphertext");
            assert_eq!(
                hex::encode(&sha256::sha256(&bytes)),
                sid,
                "the storage id the device computed is not this server's"
            );
        }
    }

    #[test]
    fn the_fixture_request_signature_verifies_with_this_server_canonical_string() {
        let secret = hex::decode_array::<32>(SIG_SECRET).expect("fixture secret");
        let canonical =
            crate::api::auth::canonical("POST", SIG_TARGET, SIG_TS, SIG_NONCE, SIG_BODY_HASH);
        assert_eq!(
            hex::encode(&hmac::hmac_sha256(&secret, canonical.as_bytes())),
            SIG,
            "the device and the server disagree about what is signed"
        );
        assert!(crate::api::auth::verify(&secret, &canonical, SIG));
        assert!(
            !crate::api::auth::verify(&secret, &canonical.replace("POST", "PUT"), SIG),
            "and the method is inside the signature"
        );
    }

    /// Post the fixture's version with the id given, over the wire.
    fn post(h: &Harness, cred: &super::Cred, version_id: &str) -> Res {
        let parents = PARENTS
            .iter()
            .map(|p| format!("\"{p}\""))
            .collect::<Vec<_>>()
            .join(",");
        let manifest_ct = base64::encode(&hex::decode(MANIFEST_CT).expect("fixture manifest"));
        let domain = DOMAIN;
        Req::post(&format!("/v1/files/{FILE_ID}/versions"))
            .body(&format!(
                r#"{{"version_id":"{version_id}","parents":[{parents}],"sids":["{NOTE_SID}","{BLOCK_SID}"],"bytes":4117,"domain_id":"{domain}","manifest_ct":"{manifest_ct}","manifest_nonce":"{MANIFEST_NONCE}","deleted":false}}"#
            ))
            .sign(cred, NOW)
            .send(h.addr)
    }

    #[test]
    fn the_server_recomputes_the_version_id_the_device_computed() {
        let h = Harness::start("fixture-version");
        let cred = h.setup_account();

        // A deliberately wrong id: the refusal names what the server computed
        // from the same file id, parents, manifest, and sids.
        let refused = post(&h, &cred, &"00".repeat(32));
        assert_eq!(refused.status, 422, "{}", refused.text());
        assert_eq!(refused.code(), "version_id_mismatch");
        let body = refused.json();
        assert_eq!(
            body.get("expected").and_then(Value::as_str),
            Some(VERSION_ID),
            "the server's version id differs from the device's"
        );

        // With the fixture's own id the post gets past the identity check and
        // stops on the chunks, which this test never uploaded.
        let accepted = post(&h, &cred, VERSION_ID);
        assert_eq!(accepted.status, 409, "{}", accepted.text());
        assert_eq!(accepted.code(), "missing_chunks");
    }
}

/// The setup body every first-boot call sends, with the token under test.
fn setup_body(token: &str) -> String {
    format!(
        r#"{{"setup_token":"{token}","account_name":"vault","device":{{"name":"laptop","platform":"macos","app_version":"0.1.0"}}}}"#
    )
}

/// Which ring a decision landed in, read from the two rings themselves.
///
/// The header a caller receives and the ring its line lands in are ONE
/// decision, so every provenance assertion checks both: a fault that set one
/// and not the other would otherwise pass.
fn ring_of(h: &Harness, class: &str, status: u16) -> &'static str {
    let recent = h.app.recent.lock().expect("recent log");
    let holds = |ring: &std::collections::VecDeque<crate::api::LogLine>| {
        ring.iter()
            .any(|l| l.path_class == class && l.status == status)
    };
    if holds(&recent.credentialed) {
        "credentialed"
    } else if holds(&recent.public) {
        "public"
    } else {
        "absent"
    }
}

/// Credentialed means one thing: a credential verified WHILE this request was
/// answered. No route, status, or header can produce that fact, and every
/// refusal answered before a check could pass is public.
#[test]
fn only_a_verified_credential_makes_a_response_credentialed() {
    let h = Harness::start("provenance");

    // A wrong setup token proves nothing; the right one proves the
    // first-boot credential, and the `201` that follows is credentialed.
    let wrong = Req::post("/v1/setup")
        .body(&setup_body(&"11".repeat(32)))
        .send(h.addr);
    assert_eq!(wrong.status, 401);
    assert_eq!(wrong.header("x-obsync-seq"), None);
    assert_eq!(ring_of(&h, "/v1/setup", 401), "public");

    let created = Req::post("/v1/setup")
        .body(&setup_body(&"5e".repeat(32)))
        .send(h.addr);
    assert_eq!(created.status, 201, "{}", created.text());
    assert!(
        created.header("x-obsync-seq").is_some(),
        "the caller that held the setup token proved it"
    );
    assert_eq!(ring_of(&h, "/v1/setup", 201), "credentialed");
    let cred = Cred::from_json(&created.json());

    // A malformed signature header is refused before verification.
    let malformed = Req::get("/v1/account")
        .header("X-Obsync-Device", "not-hex-at-all")
        .header("X-Obsync-Ts", &NOW.to_string())
        .header("X-Obsync-Nonce", &nonce())
        .header("X-Obsync-Sig", "zz")
        .send(h.addr);
    assert_eq!(malformed.status, 401);
    assert_eq!(malformed.code(), "bad_signature");
    assert_eq!(malformed.header("x-obsync-seq"), None);
    assert_eq!(ring_of(&h, "/v1/account", 401), "public");

    // A signature that verifies, on a request the server then refuses for a
    // reason of its own: the credential still verified, so the answer is
    // credentialed. This is the case a status heuristic cannot tell from the
    // one above.
    let unknown = Req::post(&format!("/v1/devices/{}/revoke", "ab".repeat(16)))
        .sign(&cred, NOW)
        .send(h.addr);
    assert_eq!(unknown.status, 404, "{}", unknown.text());
    assert!(
        unknown.header("x-obsync-seq").is_some(),
        "a refusal AFTER the signature verified is a credentialed answer"
    );
    assert_eq!(ring_of(&h, "/v1/devices/{id}/revoke", 404), "credentialed");

    // A route nobody needs a credential for, and no credential arrived.
    let missing = Req::get("/nothing-here").send(h.addr);
    assert_eq!(missing.status, 404);
    assert_eq!(missing.header("x-obsync-seq"), None);
    assert_eq!(ring_of(&h, "/unknown", 404), "public");

    // `GET /login`: a wrong token proves nothing, a live link proves itself.
    let refused = Req::get("/login?token=deadbeef").send(h.addr);
    assert_eq!(refused.status, 401);
    assert_eq!(refused.code(), "bad_login_token");
    assert_eq!(refused.header("x-obsync-seq"), None);
    assert_eq!(ring_of(&h, "/login", 401), "public");

    let token = login_token(&h, &cred);
    let signed_in = Req::get(&format!("/login?token={token}")).send(h.addr);
    assert_eq!(signed_in.status, 302, "{}", signed_in.text());
    assert!(
        signed_in.header("x-obsync-seq").is_some(),
        "the sign-in that spent a link proved a credential"
    );
    assert_eq!(ring_of(&h, "/login", 302), "credentialed");

    // A live session with the wrong double-submit header: refused, but
    // refused to a signed-in browser, which is a credentialed decision.
    let cookie = cookie_header(&signed_in);
    let csrf_failed = Req::post("/v1/admin/logout")
        .header("Cookie", &cookie)
        .header("X-Obsync-Csrf", &"00".repeat(32))
        .send(h.addr);
    assert_eq!(csrf_failed.status, 403, "{}", csrf_failed.text());
    assert_eq!(csrf_failed.code(), "csrf_failed");
    assert!(
        csrf_failed.header("x-obsync-seq").is_some(),
        "a CSRF refusal follows a session that matched"
    );
    assert_eq!(ring_of(&h, "/v1/admin/logout", 403), "credentialed");

    // No cookie at all is not a session, on the same route.
    let no_session = Req::post("/v1/admin/logout").send(h.addr);
    assert_eq!(no_session.status, 401);
    assert_eq!(no_session.header("x-obsync-seq"), None);
    assert_eq!(ring_of(&h, "/v1/admin/logout", 401), "public");
}

/// Every route that demands a credential authenticates BEFORE it validates
/// anything, so an anonymous caller gets `401` and nothing else -- whatever
/// path segment or query it sends.
///
/// A handler that validated first answered `400`, and a `400` on such a route
/// is a refusal the log has to classify with no credential to classify it by:
/// it rode the journal head out and it sat in the 1000-line credentialed
/// ring, where a thousand malformed requests pushed out every real decision.
#[test]
fn no_credentialed_route_answers_an_anonymous_caller_before_it_authenticates() {
    let h = Harness::start("anonymous-walk");
    h.setup_account();
    let bad = "nothex";
    let query = "?since=x&wait=x&limit=x&after=x&token=x&id=x";
    let mut targets: Vec<(&str, String)> = Vec::new();
    for (method, path) in [
        ("GET", "/v1/account".to_string()),
        ("POST", "/v1/pairing".to_string()),
        ("GET", format!("/v1/pairing/{bad}")),
        ("POST", format!("/v1/pairing/{bad}/approve")),
        ("POST", format!("/v1/pairing/{bad}/reject")),
        ("GET", format!("/v1/pairing/{bad}/envelope")),
        ("GET", "/v1/devices".to_string()),
        ("PATCH", format!("/v1/devices/{bad}")),
        ("POST", format!("/v1/devices/{bad}/revoke")),
        ("POST", "/v1/devices/heartbeat".to_string()),
        ("POST", "/v1/chunks/exists".to_string()),
        ("POST", "/v1/chunks/get".to_string()),
        ("PUT", format!("/v1/chunks/{bad}")),
        ("GET", format!("/v1/chunks/{bad}")),
        ("POST", format!("/v1/files/{bad}/versions")),
        ("GET", format!("/v1/files/{bad}")),
        ("GET", format!("/v1/files/{bad}/versions/{bad}")),
        ("GET", "/v1/files".to_string()),
        ("GET", "/v1/changes".to_string()),
        ("POST", "/v1/dashboard/login-link".to_string()),
        ("GET", "/login".to_string()),
        ("POST", "/v1/admin/logout".to_string()),
        ("POST", "/v1/admin/logout-all".to_string()),
        ("GET", "/v1/admin/overview".to_string()),
        ("GET", "/v1/admin/devices".to_string()),
        ("POST", format!("/v1/admin/devices/{bad}/revoke")),
        ("GET", "/v1/admin/storage".to_string()),
        ("POST", "/v1/admin/gc/run".to_string()),
        ("POST", "/v1/admin/scrub/run".to_string()),
        ("GET", "/v1/admin/logs".to_string()),
    ] {
        targets.push((method, format!("{path}{query}")));
    }
    // The whole credentialed half of the route table, so a route added
    // without its authentication cannot slip past this walk.
    assert_eq!(targets.len(), 30);

    for (method, target) in &targets {
        let res = Req::new(method, target)
            .body("{\"not\":\"valid\"}")
            .send(h.addr);
        assert_eq!(
            res.status,
            401,
            "{method} {target} answered an anonymous caller {}: {}",
            res.status,
            res.text()
        );
        assert_eq!(
            res.header("x-obsync-seq"),
            None,
            "{method} {target} handed an anonymous caller the journal head"
        );
    }

    // And not one of those refusals reached the ring the dashboard's Logs
    // page must keep: they are all public traffic.
    let recent = h.app.recent.lock().expect("recent log");
    let unauthenticated = recent
        .credentialed
        .iter()
        .filter(|l| l.status == 401)
        .count();
    assert_eq!(
        unauthenticated, 0,
        "an anonymous refusal must never take credentialed ring space"
    );
    assert_eq!(
        recent.public.iter().filter(|l| l.status == 401).count(),
        targets.len(),
        "every one of them is in the public ring instead"
    );
}

/// A revoked or pending device id is not a credential: knowing one buys
/// neither the journal head nor a line in the credentialed ring.
///
/// Both refusals used to be answered from the state of the record, before the
/// signature was verified at all, so anyone holding a 32-hex id got a `403`
/// that the log read as proof. The pending refusal now follows the
/// signature. The revoked one cannot: revocation destroys the wrapped
/// secret, so there is nothing left to verify a signature against -- it stays
/// the documented `403 device_revoked`, classed for what it is.
#[test]
fn a_revoked_or_pending_device_id_is_not_a_credential() {
    let h = Harness::start("state-before-proof");
    let creator = h.setup_account();
    let (id, claimant) = claim_pairing(&h, &creator);

    // PENDING, with garbage where the signature goes: indistinguishable from
    // an unknown device, and no credential is claimed for it.
    let forged = Req::get("/v1/account")
        .header("X-Obsync-Device", &claimant.id)
        .header("X-Obsync-Ts", &NOW.to_string())
        .header("X-Obsync-Nonce", &nonce())
        .header("X-Obsync-Sig", &"cd".repeat(32))
        .send(h.addr);
    assert_eq!(forged.status, 401, "{}", forged.text());
    assert_eq!(forged.code(), "bad_signature");
    assert_eq!(forged.header("x-obsync-seq"), None);
    assert_eq!(ring_of(&h, "/v1/account", 401), "public");

    // PENDING, properly signed: the documented refusal, and a credentialed
    // decision, because the signature did verify.
    let pending = Req::get("/v1/account").sign(&claimant, NOW).send(h.addr);
    assert_eq!(pending.status, 403, "{}", pending.text());
    assert_eq!(pending.code(), "device_pending");
    assert!(
        pending.header("x-obsync-seq").is_some(),
        "the claimant proved possession of its secret"
    );
    assert_eq!(ring_of(&h, "/v1/account", 403), "credentialed");

    approve_pairing(&h, &creator, &id);
    let revoke = Req::post(&format!("/v1/devices/{}/revoke", claimant.id))
        .sign(&creator, NOW)
        .send(h.addr);
    assert_eq!(revoke.status, 204, "{}", revoke.text());

    // REVOKED, properly signed by the device that still holds its copy of
    // the secret: the server has none to check it with, so this refusal
    // proves nothing and is classed as public.
    let revoked = Req::get("/v1/account").sign(&claimant, NOW).send(h.addr);
    assert_eq!(revoked.status, 403, "{}", revoked.text());
    assert_eq!(revoked.code(), "device_revoked");
    assert_eq!(
        revoked.header("x-obsync-seq"),
        None,
        "a revocation destroyed the secret, so nothing verified here"
    );
    // The line is still on the Logs page -- in the public ring, where a
    // revoked device hammering the server is visible without being able to
    // push a real decision out.
    assert!(
        h.app
            .recent_lines(None, 5_000)
            .iter()
            .any(|l| l.path_class == "/v1/account" && l.status == 403),
        "the operator still sees a revoked device still trying"
    );
}
