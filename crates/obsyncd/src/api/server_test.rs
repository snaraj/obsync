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
use crate::config::Config;
use crate::dashboard::Dashboard;
use crate::log::Log;
use crate::plugin_dist::PluginDist;
use crate::storage::Store;

/// The frozen wall clock every test signs against.
const NOW: u64 = 1_757_200_000;

/// A unique temporary directory per harness.
static COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_dir(tag: &str) -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("obsync-api-{}-{tag}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
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

        let pairs: Vec<(String, String)> = [
            ("OBSYNC_BLOBS_DIR", blobs.display().to_string()),
            ("OBSYNC_JOURNAL_DIR", journal.display().to_string()),
            ("OBSYNC_DASHBOARD_DIR", dashboard_dir.display().to_string()),
            ("OBSYNC_PLUGIN_DIR", plugin_dir.display().to_string()),
            (
                "OBSYNC_EDGE",
                if setup.edge_mode {
                    "cloudflare"
                } else {
                    "none"
                }
                .to_string(),
            ),
            ("OBSYNC_SERVER_KEY", "aa".repeat(32)),
            ("OBSYNC_PUBLIC_URL", "http://127.0.0.1".to_string()),
            ("OBSYNC_LOG", "error".to_string()),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        let cfg = Config::from_pairs(&pairs).expect("configuration");
        let log = Log::new(cfg.log_level);
        let store = Store::open(&cfg.storage(), cfg.server_key, log.clone()).expect("store");

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
                log,
                dashboard,
                plugin,
                Arc::clone(&shutdown),
                Some("5e".repeat(32)),
            )
            .with_clock(Arc::clone(&clock) as Arc<dyn Clock>),
        );

        let server = Server::bind("127.0.0.1:0", Limits::default()).expect("bind");
        let addr = server.local_addr().expect("local addr");
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

    /// Create the account and return the first device's credential.
    fn setup_account(&self) -> Cred {
        let body = format!(
            r#"{{"setup_token":"{}","account_name":"vault","name":"laptop","platform":"macos","app_version":"0.1.0"}}"#,
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
    assert!(
        res.header("x-obsync-seq").is_some(),
        "every response carries the journal head"
    );

    let res = Req::get("/readyz").send(h.addr);
    assert_eq!(res.status, 200, "{}", res.text());
    assert_eq!(res.json().get("ready").and_then(Value::as_bool), Some(true));
}

#[test]
fn readyz_is_false_while_shutting_down() {
    let h = Harness::start("shutdown");
    assert_eq!(Req::get("/readyz").send(h.addr).status, 200);
    h.shutdown.store(true, Ordering::SeqCst);
    let res = Req::get("/readyz").send(h.addr);
    assert_eq!(res.status, 503, "{}", res.text());
    assert_eq!(res.code(), "not_ready");
    h.shutdown.store(false, Ordering::SeqCst);
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
            r#"{{"setup_token":"{}","account_name":"other"}}"#,
            "5e".repeat(32)
        ))
        .send(h.addr);
    assert_eq!(again.status, 409);
    assert_eq!(again.code(), "already_set_up");
}

#[test]
fn a_wrong_setup_token_is_refused() {
    let h = Harness::start("setup-bad");
    let res = Req::post("/v1/setup")
        .body(&format!(
            r#"{{"setup_token":"{}","account_name":"vault"}}"#,
            "11".repeat(32)
        ))
        .send(h.addr);
    assert_eq!(res.status, 401);
    assert_eq!(res.code(), "bad_setup_token");
    assert!(
        h.app.store.account().is_none(),
        "a refused setup creates nothing"
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
        r#"{{"setup_token":"{}","account_name":"vault","name":"laptop","platform":"macos","app_version":"0.1.0"}}"#,
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

    let wrong = Req::get(&format!("/v1/pairing/{id}"))
        .sign(&claimant, NOW)
        .send(h.addr);
    assert_eq!(wrong.status, 403);
    assert_eq!(wrong.code(), "not_creator");

    let early = Req::get(&format!("/v1/pairing/{id}/envelope"))
        .sign(&claimant, NOW)
        .send(h.addr);
    assert_eq!(early.code(), "not_approved");

    let approve = Req::post(&format!("/v1/pairing/{id}/approve"))
        .body(r#"{"envelope":"Y2lwaGVy","nonce":"0123456789abcdef01234567"}"#)
        .sign(&creator, NOW)
        .send(h.addr);
    assert_eq!(approve.status, 204, "{}", approve.text());

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
    assert_eq!(
        list.get("devices")
            .and_then(Value::as_array)
            .expect("devices")
            .len(),
        2
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

/// Post a version, letting the server tell us the id it recomputes.
fn post_version(
    h: &Harness,
    cred: &Cred,
    file_id: &str,
    parents: &[&str],
    sids: &[&str],
    manifest: &str,
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
    let body = |version_id: &str| {
        format!(
            r#"{{"version_id":"{version_id}","parents":[{parents_json}],"sids":[{sids_json}],"bytes":18,"manifest_ct":"{manifest}","manifest_nonce":"0123456789abcdef01234567","deleted":false}}"#
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
    assert_eq!(
        file.json().get("conflicted").and_then(Value::as_bool),
        Some(true)
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
                r#"{{"version_id":"{version_id}","parents":[{parents_json}],"sids":["{sid}"],"bytes":15,"manifest_ct":"bWFuaWZlc3Q=","manifest_nonce":"0123456789abcdef01234567","deleted":false}}"#
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

#[test]
fn a_device_is_renamed_and_domains_are_created() {
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

    let domain = "3f".repeat(16);
    let created = Req::post("/v1/domains")
        .body(&format!(r#"{{"domain_id":"{domain}"}}"#))
        .sign(&cred, NOW)
        .send(h.addr);
    assert_eq!(created.status, 201, "{}", created.text());
    let list = Req::get("/v1/domains").sign(&cred, NOW).send(h.addr);
    assert_eq!(
        list.json()
            .get("domains")
            .and_then(Value::as_array)
            .expect("domains")
            .len(),
        1
    );
}

#[test]
fn plugin_endpoints_are_absent_without_a_bundle_and_public_with_one() {
    let bare = Harness::start("plugin-none");
    let res = Req::get("/v1/plugin/manifest").send(bare.addr);
    assert_eq!(res.status, 404);
    assert_eq!(res.code(), "plugin_unavailable");
    assert_eq!(Req::get("/v1/plugin/bundle").send(bare.addr).status, 404);
    assert_eq!(Req::get("/v1/plugin/styles").send(bare.addr).status, 404);

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
    let bundle_hash = v
        .get("bundle_sha256")
        .and_then(Value::as_str)
        .expect("bundle_sha256")
        .to_string();

    let bundle = Req::get("/v1/plugin/bundle").send(h.addr);
    assert_eq!(bundle.status, 200);
    assert_eq!(
        hex::encode(&sha256::sha256(&bundle.body)),
        bundle_hash,
        "the manifest pins it"
    );
    assert_eq!(Req::get("/v1/plugin/styles").send(h.addr).status, 200);
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
        .find(|c| c.starts_with("obsync_session="))
        .expect("session cookie")
        .to_string();
    let csrf = cookies
        .iter()
        .find(|c| c.starts_with("obsync_csrf="))
        .expect("csrf")
        .to_string();
    assert!(session.contains("HttpOnly"), "{session}");
    assert!(session.contains("SameSite=Strict"), "{session}");
    assert!(
        !csrf.contains("HttpOnly"),
        "the double-submit value must be readable: {csrf}"
    );

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
    let after = Req::get("/v1/admin/overview")
        .header("Cookie", &cookie_header)
        .send(h.addr);
    assert_eq!(after.status, 401, "the session is closed");
}

#[test]
fn the_setup_token_is_the_documented_recovery_login() {
    let h = Harness::start_with(
        "recovery",
        Setup {
            dashboard: true,
            ..Setup::default()
        },
    );
    h.setup_account();
    let login = Req::get(&format!("/login?token={}", "5e".repeat(32))).send(h.addr);
    assert_eq!(login.status, 302, "{}", login.text());
    assert_eq!(login.headers_all("set-cookie").len(), 2);
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
    assert_eq!(chunk_line.device.as_deref(), Some(cred.id.as_str()));
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
    assert!(dir.starts_with(std::env::temp_dir()));
    assert!(Path::new(&dir).is_dir());
    std::fs::remove_dir_all(&dir).expect("cleanup");
}
