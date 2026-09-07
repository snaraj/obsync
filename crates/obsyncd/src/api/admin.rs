//! The dashboard session and the admin API (`docs/protocol.md`, "Dashboard
//! (admin) API"; `docs/architecture.md` 4.5).
//!
//! Sessions are `HttpOnly`, `SameSite=Strict` cookies; every mutation carries
//! a double-submit CSRF header that must equal the CSRF cookie AND the value
//! minted with the session. None of that is configurable (AGENTS.md
//! "Security invariants").
#![forbid(unsafe_code)]

use std::collections::HashMap;

use obsync_core::ct;
use obsync_core::http::{Request, Response};
use obsync_core::json::{Value, obj};

use crate::types::Seq;

use super::edge::ClientInfo;
use super::render::{self, n, s};
use super::{ApiError, App, auth, domains, rand};

/// Cookie carrying the dashboard session.
pub const SESSION_COOKIE: &str = "obsync_session";
/// Cookie carrying the CSRF value, readable by the dashboard's own script.
pub const CSRF_COOKIE: &str = "obsync_csrf";
/// Header a mutation must echo the CSRF cookie in.
pub const CSRF_HEADER: &str = "x-obsync-csrf";
/// How long a dashboard session lives.
pub const SESSION_TTL_SECS: u64 = 12 * 3600;
/// How long a one-time login link lives (`docs/protocol.md`).
pub const LOGIN_LINK_TTL_SECS: u64 = 300;
/// Most log lines one `GET /v1/admin/logs` call returns.
pub const LOGS_MAX_LIMIT: u64 = 512;

/// One signed-in dashboard session.
#[derive(Clone, Debug)]
pub struct Session {
    /// The CSRF value minted with the session.
    pub csrf: String,
    /// Unix seconds at which the session stops being accepted.
    pub expires: u64,
}

/// Sessions and outstanding one-time login links, in memory only.
pub struct SessionTable {
    sessions: HashMap<String, Session>,
    links: HashMap<String, u64>,
}

impl Default for SessionTable {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionTable {
    /// An empty table.
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            links: HashMap::new(),
        }
    }

    /// Mint a one-time login link token.
    pub fn add_link(&mut self, token: &str, now: u64) -> u64 {
        let expires = now + LOGIN_LINK_TTL_SECS;
        self.links.insert(token.to_string(), expires);
        expires
    }

    /// Consume a login link token, once.
    pub fn take_link(&mut self, token: &str, now: u64) -> bool {
        match self.links.remove(token) {
            Some(expires) => expires > now,
            None => false,
        }
    }

    /// Open a session, returning its cookie value and CSRF value.
    pub fn open(&mut self, session: &str, csrf: &str, now: u64) {
        self.sessions.insert(
            session.to_string(),
            Session {
                csrf: csrf.to_string(),
                expires: now + SESSION_TTL_SECS,
            },
        );
    }

    /// The live session behind a cookie value.
    pub fn get(&self, session: &str, now: u64) -> Option<&Session> {
        self.sessions.get(session).filter(|s| s.expires > now)
    }

    /// Close a session.
    pub fn close(&mut self, session: &str) {
        self.sessions.remove(session);
    }

    /// Drop expired sessions and links, returning how many went.
    pub fn sweep(&mut self, now: u64) -> usize {
        let before = self.sessions.len() + self.links.len();
        self.sessions.retain(|_, s| s.expires > now);
        self.links.retain(|_, expires| *expires > now);
        before - (self.sessions.len() + self.links.len())
    }
}

/// `Set-Cookie` for the session: `HttpOnly` so no script can read it, and
/// `SameSite=Strict` so no cross-site navigation carries it.
pub fn session_cookie(token: &str) -> String {
    format!(
        "{SESSION_COOKIE}={token}; Path=/; Max-Age={SESSION_TTL_SECS}; HttpOnly; SameSite=Strict"
    )
}

/// `Set-Cookie` for the CSRF value. Deliberately readable by the dashboard's
/// own script: the double-submit check needs it in a header.
pub fn csrf_cookie(token: &str) -> String {
    format!("{CSRF_COOKIE}={token}; Path=/; Max-Age={SESSION_TTL_SECS}; SameSite=Strict")
}

/// `Set-Cookie` that clears one cookie now.
pub fn expired_cookie(name: &str) -> String {
    format!("{name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict")
}

/// Cookie-header parsing: `name=value` pairs separated by `;`.
pub fn parse_cookies(header: &str) -> Vec<(String, String)> {
    header
        .split(';')
        .filter_map(|pair| {
            let (name, value) = pair.split_once('=')?;
            Some((name.trim().to_string(), value.trim().to_string()))
        })
        .collect()
}

/// One cookie's value.
pub fn cookie(header: Option<&str>, name: &str) -> Option<String> {
    parse_cookies(header?)
        .into_iter()
        .find(|(n, _)| n == name)
        .map(|(_, v)| v)
}

/// The CSRF decision, free of the HTTP types so it is unit-testable: the
/// header must be present and equal, in constant time, to both the cookie and
/// the value minted with the session.
///
/// # Errors
/// `403 csrf_failed` when any of the three is absent or differs.
pub fn csrf_verdict(
    session_csrf: &str,
    cookie_value: Option<&str>,
    header_value: Option<&str>,
) -> Result<(), ApiError> {
    let failed = || ApiError::new(403, "csrf_failed", "CSRF header and cookie must match");
    let cookie_value = cookie_value.ok_or_else(failed)?;
    let header_value = header_value.ok_or_else(failed)?;
    if cookie_value.is_empty() {
        return Err(failed());
    }
    if !ct::eq(cookie_value.as_bytes(), header_value.as_bytes())
        || !ct::eq(session_csrf.as_bytes(), cookie_value.as_bytes())
    {
        return Err(failed());
    }
    Ok(())
}

/// `POST /v1/dashboard/login-link` (device auth): mint a single-use, 5-minute
/// dashboard link.
///
/// # Errors
/// The device-authentication refusals, or `500 no_randomness`.
pub fn login_link(app: &App, req: &mut Request, client: &ClientInfo) -> Result<Response, ApiError> {
    auth::device(app, req, client)?;
    let token = mint(32)?;
    let now = app.clock.unix_secs();
    let expires = app.sessions.lock().expect("sessions").add_link(&token, now);
    let base = app.cfg.public_url.trim_end_matches('/').to_string();
    let url = format!("{base}/login?token={token}");
    Ok(Response::json(
        200,
        &obj(vec![("url", s(&url)), ("expires", n(expires))]),
    ))
}

/// `GET /login?token=…`: consume a login link, or the first-boot setup token
/// as the documented recovery login, and set the session.
///
/// # Errors
/// `401 bad_login_token` when the token is absent, spent, or wrong.
pub fn login(app: &App, req: &mut Request) -> Result<Response, ApiError> {
    let token = req
        .query_param("token")
        .ok_or_else(|| ApiError::new(401, "bad_login_token", "login token required"))?
        .to_string();
    let now = app.clock.unix_secs();

    let mut sessions = app.sessions.lock().expect("sessions");
    let recovery = app
        .setup_token
        .as_deref()
        .is_some_and(|expected| ct::eq(expected.as_bytes(), token.as_bytes()));
    if !sessions.take_link(&token, now) && !recovery {
        drop(sessions);
        app.log.warn(
            "dashboard_login_refused",
            &[("decision", "bad_login_token")],
        );
        return Err(ApiError::new(
            401,
            "bad_login_token",
            "login token is not valid",
        ));
    }
    let session = mint(32)?;
    let csrf = mint(32)?;
    sessions.open(&session, &csrf, now);
    drop(sessions);

    app.log.info(
        "dashboard_login",
        &[("recovery", if recovery { "true" } else { "false" })],
    );
    Ok(Response::empty(302)
        .header("Location", "/")
        .header("Set-Cookie", &session_cookie(&session))
        .header("Set-Cookie", &csrf_cookie(&csrf)))
}

/// `POST /v1/admin/logout`.
///
/// # Errors
/// `401 no_session`, `403 csrf_failed`.
pub fn logout(app: &App, req: &mut Request) -> Result<Response, ApiError> {
    let token = mutating_session(app, req)?;
    app.sessions.lock().expect("sessions").close(&token);
    Ok(Response::empty(204)
        .header("Set-Cookie", &expired_cookie(SESSION_COOKIE))
        .header("Set-Cookie", &expired_cookie(CSRF_COOKIE)))
}

/// `GET /v1/admin/overview`.
///
/// # Errors
/// `401 no_session`.
pub fn overview(app: &App, req: &mut Request) -> Result<Response, ApiError> {
    session(app, req)?;
    let account = match app.store.account() {
        Some(a) => render::account(&a),
        None => Value::Null,
    };
    let head = app.store.head_seq();
    let volumes: Vec<Value> = app.store.volumes().iter().map(render::volume).collect();
    Ok(Response::json(
        200,
        &obj(vec![
            ("account", account),
            ("volumes", Value::Array(volumes)),
            (
                "activity",
                obj(vec![
                    ("head_seq", render::seq(head)),
                    ("versions_last_24h", n(versions_last_24h(app))),
                ]),
            ),
            ("gc", last_gc(app)),
            ("scrub", last_scrub(app)),
        ]),
    ))
}

/// `GET /v1/admin/devices`: the device table plus retention-bounded history.
///
/// # Errors
/// `401 no_session`.
pub fn devices(app: &App, req: &mut Request) -> Result<Response, ApiError> {
    session(app, req)?;
    let list: Vec<Value> = app
        .store
        .devices()
        .iter()
        .map(|d| {
            let history = app.store.seen_history(&d.device_id, 64);
            render::device_with_history(d, &history)
        })
        .collect();
    Ok(Response::json(
        200,
        &obj(vec![("devices", Value::Array(list))]),
    ))
}

/// `POST /v1/admin/devices/{id}/revoke`.
///
/// # Errors
/// `401 no_session`, `403 csrf_failed`, `404 unknown_device`.
pub fn revoke(app: &App, req: &mut Request, id: &str) -> Result<Response, ApiError> {
    mutating_session(app, req)?;
    let target = render::device_id(id)?;
    app.store.revoke_device(&target)?;
    app.log.warn(
        "device_revoked",
        &[("device", &target.to_string()), ("by", "dashboard")],
    );
    Ok(Response::empty(204))
}

/// `GET /v1/admin/storage`.
///
/// # Errors
/// `401 no_session`.
pub fn storage(app: &App, req: &mut Request) -> Result<Response, ApiError> {
    session(app, req)?;
    let volumes: Vec<Value> = app.store.volumes().iter().map(render::volume).collect();
    Ok(Response::json(
        200,
        &obj(vec![
            ("volumes", Value::Array(volumes)),
            ("gc", last_gc(app)),
            ("scrub", last_scrub(app)),
            (
                "retention",
                obj(vec![
                    ("days", n(app.cfg.retention_days)),
                    ("versions", n(app.cfg.retention_versions)),
                ]),
            ),
            (
                "scrub_rate_bytes_per_sec",
                n(app.cfg.scrub_rate_bytes_per_sec),
            ),
        ]),
    ))
}

/// `POST /v1/admin/gc/run`: ask the collector to run at the next tick.
///
/// # Errors
/// `401 no_session`, `403 csrf_failed`.
pub fn gc_run(app: &App, req: &mut Request) -> Result<Response, ApiError> {
    mutating_session(app, req)?;
    app.request_gc();
    Ok(Response::json(202, &obj(vec![("queued", render::b(true))])))
}

/// `POST /v1/admin/scrub/run`: ask the scrubber to start a pass now.
///
/// # Errors
/// `401 no_session`, `403 csrf_failed`.
pub fn scrub_run(app: &App, req: &mut Request) -> Result<Response, ApiError> {
    mutating_session(app, req)?;
    app.request_scrub();
    Ok(Response::json(202, &obj(vec![("queued", render::b(true))])))
}

/// `GET /v1/admin/domains`.
///
/// # Errors
/// `401 no_session`.
pub fn domains(app: &App, req: &mut Request) -> Result<Response, ApiError> {
    session(app, req)?;
    Ok(Response::json(200, &domains::domains_body(app)))
}

/// `POST /v1/admin/domains/{id}/escrow`: hand the server a domain key, which
/// is the one deliberate exception to the blind-server default and is shown in
/// red in the dashboard (`docs/architecture.md` 5).
///
/// # Errors
/// `400 bad_request`, `401 no_session`, `403 csrf_failed`.
pub fn escrow_set(app: &App, req: &mut Request, id: &str) -> Result<Response, ApiError> {
    mutating_session(app, req)?;
    let domain = render::domain_id(id)?;
    let body = render::json_body(req)?;
    let key_hex = render::field_str(&body, "key")?;
    let key = obsync_core::hex::decode_array::<32>(key_hex)
        .map_err(|_| ApiError::bad_request("key must be 64 hex characters"))?;
    app.store.set_escrow(&domain, Some(key))?;
    app.log
        .warn("domain_escrow_set", &[("domain", &domain.to_string())]);
    Ok(Response::empty(204))
}

/// `DELETE /v1/admin/domains/{id}/escrow`: drop the escrowed key and the
/// capability it gave.
///
/// # Errors
/// `400 bad_request`, `401 no_session`, `403 csrf_failed`.
pub fn escrow_clear(app: &App, req: &mut Request, id: &str) -> Result<Response, ApiError> {
    mutating_session(app, req)?;
    let domain = render::domain_id(id)?;
    app.store.set_escrow(&domain, None)?;
    app.log
        .warn("domain_escrow_cleared", &[("domain", &domain.to_string())]);
    Ok(Response::empty(204))
}

/// `GET /v1/admin/logs?device=<id>&limit=<n>`: the recent decision lines.
///
/// # Errors
/// `400 bad_request`, `401 no_session`.
pub fn logs(app: &App, req: &mut Request) -> Result<Response, ApiError> {
    let device = req.query_param("device").map(str::to_string);
    let limit = req.query_param("limit").map(str::to_string);
    session(app, req)?;
    if let Some(d) = device.as_deref()
        && !super::is_hex(d, 32)
    {
        return Err(ApiError::bad_request("device must be 32 hex characters"));
    }
    let limit = match limit.as_deref() {
        Some(v) => v
            .parse::<u64>()
            .map_err(|_| ApiError::bad_request("limit must be a number"))?,
        None => 100,
    }
    .clamp(1, LOGS_MAX_LIMIT);

    let lines: Vec<Value> = app
        .recent_lines(device.as_deref(), limit as usize)
        .iter()
        .map(|l| {
            obj(vec![
                ("ts", n(l.ts)),
                ("method", s(&l.method)),
                ("path_class", s(l.path_class)),
                ("device", s(&l.device)),
                ("status", n(u64::from(l.status))),
                ("bytes", n(l.bytes)),
                ("duration_ms", n(l.duration_ms)),
                ("decision", s(&l.decision)),
            ])
        })
        .collect();
    Ok(Response::json(
        200,
        &obj(vec![("lines", Value::Array(lines))]),
    ))
}

/// The dashboard-session check for a read.
fn session(app: &App, req: &Request) -> Result<String, ApiError> {
    let no_session = || ApiError::new(401, "no_session", "dashboard session required");
    let token = cookie(req.headers.get("cookie"), SESSION_COOKIE).ok_or_else(no_session)?;
    let now = app.clock.unix_secs();
    let sessions = app.sessions.lock().expect("sessions");
    sessions.get(&token, now).ok_or_else(no_session)?;
    Ok(token)
}

/// The dashboard-session check for a mutation: session plus double-submit
/// CSRF.
fn mutating_session(app: &App, req: &Request) -> Result<String, ApiError> {
    let token = session(app, req)?;
    let now = app.clock.unix_secs();
    let csrf = {
        let sessions = app.sessions.lock().expect("sessions");
        sessions
            .get(&token, now)
            .ok_or_else(|| ApiError::new(401, "no_session", "dashboard session required"))?
            .csrf
            .clone()
    };
    csrf_verdict(
        &csrf,
        cookie(req.headers.get("cookie"), CSRF_COOKIE).as_deref(),
        req.headers.get(CSRF_HEADER),
    )?;
    Ok(token)
}

fn last_gc(app: &App) -> Value {
    app.store.last_gc().as_ref().map_or(Value::Null, render::gc)
}

fn last_scrub(app: &App) -> Value {
    app.store
        .last_scrub()
        .as_ref()
        .map_or(Value::Null, render::scrub)
}

/// Versions journaled in the last day, from the tail of the feed.
fn versions_last_24h(app: &App) -> u64 {
    let head = render::seq_u64(app.store.head_seq());
    let since = Seq(head.saturating_sub(super::CHANGES_MAX_LIMIT));
    let cutoff = app.clock.unix_ms().saturating_sub(24 * 3600 * 1000);
    match app.store.changes(since, super::CHANGES_MAX_LIMIT as usize) {
        Ok(c) => c
            .changes
            .iter()
            .filter(|ch| render::ms_u64(ch.ts) >= cutoff)
            .count() as u64,
        Err(_) => 0,
    }
}

fn mint(bytes: usize) -> Result<String, ApiError> {
    rand::hex_token(bytes)
        .map_err(|_| ApiError::new(500, "no_randomness", "the system CSPRNG is unavailable"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_session_cookie_is_http_only_and_same_site_strict() {
        let c = session_cookie("abc");
        assert!(c.starts_with("obsync_session=abc;"));
        assert!(c.contains("HttpOnly"), "{c}");
        assert!(c.contains("SameSite=Strict"), "{c}");
        assert!(c.contains("Path=/"), "{c}");
    }

    #[test]
    fn the_csrf_cookie_is_readable_by_script_but_still_same_site_strict() {
        let c = csrf_cookie("xyz");
        assert!(c.starts_with("obsync_csrf=xyz;"));
        assert!(
            !c.contains("HttpOnly"),
            "the double-submit value must be readable: {c}"
        );
        assert!(c.contains("SameSite=Strict"), "{c}");
    }

    #[test]
    fn cookies_parse_into_pairs() {
        let pairs = parse_cookies("obsync_session=a; obsync_csrf=b");
        assert_eq!(pairs.len(), 2);
        assert_eq!(
            cookie(Some("obsync_session=a; obsync_csrf=b"), CSRF_COOKIE).as_deref(),
            Some("b")
        );
        assert_eq!(cookie(Some("nonsense"), CSRF_COOKIE), None);
        assert_eq!(cookie(None, CSRF_COOKIE), None);
    }

    #[test]
    fn csrf_requires_header_cookie_and_session_to_agree() {
        assert!(csrf_verdict("tok", Some("tok"), Some("tok")).is_ok());
        assert_eq!(
            csrf_verdict("tok", Some("tok"), None)
                .expect_err("no header")
                .code,
            "csrf_failed"
        );
        assert_eq!(
            csrf_verdict("tok", None, Some("tok"))
                .expect_err("no cookie")
                .code,
            "csrf_failed"
        );
        assert_eq!(
            csrf_verdict("tok", Some("tok"), Some("other"))
                .expect_err("mismatch")
                .status,
            403
        );
        assert_eq!(
            csrf_verdict("tok", Some("stolen"), Some("stolen"))
                .expect_err("not this session")
                .code,
            "csrf_failed"
        );
        assert_eq!(
            csrf_verdict("", Some(""), Some(""))
                .expect_err("empty")
                .code,
            "csrf_failed"
        );
    }

    #[test]
    fn a_login_link_works_once_and_expires() {
        let mut t = SessionTable::new();
        t.add_link("tok", 1_000);
        assert!(t.take_link("tok", 1_100), "first use");
        assert!(!t.take_link("tok", 1_100), "second use");
        t.add_link("tok2", 1_000);
        assert!(
            !t.take_link("tok2", 1_000 + LOGIN_LINK_TTL_SECS + 1),
            "expired"
        );
    }

    #[test]
    fn a_session_expires_and_sweeps() {
        let mut t = SessionTable::new();
        t.open("sess", "csrf", 1_000);
        assert!(t.get("sess", 1_000 + SESSION_TTL_SECS - 1).is_some());
        assert!(t.get("sess", 1_000 + SESSION_TTL_SECS).is_none());
        assert_eq!(t.sweep(1_000 + SESSION_TTL_SECS), 1);
        assert!(t.get("sess", 1_000).is_none());
    }

    #[test]
    fn closing_a_session_ends_it() {
        let mut t = SessionTable::new();
        t.open("sess", "csrf", 1_000);
        t.close("sess");
        assert!(t.get("sess", 1_000).is_none());
    }
}
