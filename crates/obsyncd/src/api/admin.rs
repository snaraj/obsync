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

use crate::log::Val;
use crate::types::{DeviceId, Seq};

use super::edge::ClientInfo;
use super::render::{self, n, s};
use super::{ApiError, App, auth, rand};

/// Cookie carrying the dashboard session. The `__Host-` prefix is a browser
/// contract and not decoration: a cookie under that name is accepted only
/// when it is `Secure`, `Path=/`, and carries no `Domain`, so no sibling host
/// and no plaintext hop can plant or shadow one
/// (`docs/security/dashboard.md`).
pub const SESSION_COOKIE: &str = "__Host-obsync_session";
/// Cookie carrying the CSRF value, readable by the dashboard's own script.
pub const CSRF_COOKIE: &str = "__Host-obsync_csrf";
/// Header a mutation must echo the CSRF cookie in.
pub const CSRF_HEADER: &str = "x-obsync-csrf";
/// How long a dashboard session lives, however busy it is.
pub const SESSION_TTL_SECS: u64 = 12 * 3600;
/// How long a dashboard session survives with no request on it. The absolute
/// limit above bounds a stolen cookie's life; this one bounds a browser left
/// open on a desk.
pub const SESSION_IDLE_SECS: u64 = 3600;
/// How long a one-time login link lives (`docs/protocol.md`).
pub const LOGIN_LINK_TTL_SECS: u64 = 300;
/// Most log lines one `GET /v1/admin/logs` call returns
/// (`docs/protocol.md`).
pub const LOGS_MAX_LIMIT: u64 = 500;
/// One signed-in dashboard session.
#[derive(Clone, Debug)]
pub struct Session {
    /// The CSRF value minted with the session.
    pub csrf: String,
    /// Unix seconds at which the session stops being accepted, however busy.
    pub expires: u64,
    /// Unix seconds at which the session stops being accepted if nothing
    /// uses it; every accepted request pushes it out again.
    pub idle_expires: u64,
    /// The device whose login link opened this session, or `None` when the
    /// standing recovery token did. Revoking that device ends the session.
    pub minted_by: Option<DeviceId>,
}

impl Session {
    /// Whether the session is still live at `now`: inside both limits.
    fn live(&self, now: u64) -> bool {
        self.expires > now && self.idle_expires > now
    }
}

/// One outstanding one-time login link.
#[derive(Clone, Copy, Debug)]
struct Link {
    expires: u64,
    minted_by: DeviceId,
}

/// Sessions and outstanding one-time login links, in memory only.
pub struct SessionTable {
    sessions: HashMap<String, Session>,
    links: HashMap<String, Link>,
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

    /// Mint a one-time login link token on behalf of `minted_by`.
    pub fn add_link(&mut self, token: &str, now: u64, minted_by: DeviceId) -> u64 {
        let expires = now + LOGIN_LINK_TTL_SECS;
        self.links
            .insert(token.to_string(), Link { expires, minted_by });
        expires
    }

    /// Consume a login link token, once, naming the device that minted it.
    pub fn take_link(&mut self, token: &str, now: u64) -> Option<DeviceId> {
        let link = self.links.remove(token)?;
        (link.expires > now).then_some(link.minted_by)
    }

    /// Open a session. `minted_by` is the device whose link opened it, or
    /// `None` for the recovery token, which belongs to no device.
    pub fn open(&mut self, session: &str, csrf: &str, now: u64, minted_by: Option<DeviceId>) {
        self.sessions.insert(
            session.to_string(),
            Session {
                csrf: csrf.to_string(),
                expires: now + SESSION_TTL_SECS,
                idle_expires: now + SESSION_IDLE_SECS,
                minted_by,
            },
        );
    }

    /// The live session behind a cookie value, read-only.
    pub fn get(&self, session: &str, now: u64) -> Option<&Session> {
        self.sessions.get(session).filter(|s| s.live(now))
    }

    /// The live session behind a cookie value, with its idle window pushed
    /// out: this is what every accepted request calls, so the idle limit
    /// measures silence and not age.
    pub fn touch(&mut self, session: &str, now: u64) -> Option<&Session> {
        let s = self.sessions.get_mut(session)?;
        if !s.live(now) {
            return None;
        }
        s.idle_expires = now + SESSION_IDLE_SECS;
        Some(s)
    }

    /// Close a session.
    pub fn close(&mut self, session: &str) {
        self.sessions.remove(session);
    }

    /// Close every session AND drop every outstanding login link, returning
    /// the two counts in that order.
    ///
    /// The "sign out everywhere" action exists for a browser left signed in
    /// on a machine the operator no longer controls. A one-time link that
    /// machine still holds is the same key to the same dashboard, unspent
    /// and good for five minutes, so leaving the links behind would have
    /// handed back exactly what the button was pressed to take away.
    pub fn close_all(&mut self) -> (usize, usize) {
        let closed = self.sessions.len();
        let dropped = self.links.len();
        self.sessions.clear();
        self.links.clear();
        (closed, dropped)
    }

    /// Drop everything one device minted: the sessions opened from its links
    /// and the links it minted that nobody has spent yet. Returns the two
    /// counts, in that order.
    ///
    /// This is what makes revocation mean what the dashboard says it means.
    /// A device's five minutes before revocation used to buy a twelve-hour
    /// admin session afterwards, because a session remembered nothing about
    /// where it came from.
    pub fn close_for_device(&mut self, device: &DeviceId) -> (usize, usize) {
        let before_sessions = self.sessions.len();
        let before_links = self.links.len();
        self.sessions
            .retain(|_, s| s.minted_by.is_none_or(|id| id != *device));
        self.links.retain(|_, l| l.minted_by != *device);
        (
            before_sessions - self.sessions.len(),
            before_links - self.links.len(),
        )
    }

    /// Drop expired sessions and links, returning how many went.
    pub fn sweep(&mut self, now: u64) -> usize {
        let before = self.sessions.len() + self.links.len();
        self.sessions.retain(|_, s| s.live(now));
        self.links.retain(|_, l| l.expires > now);
        before - (self.sessions.len() + self.links.len())
    }
}

/// `Set-Cookie` for the session: `Secure` so it never rides a plaintext
/// request, `HttpOnly` so no script can read it, `SameSite=Strict` so no
/// cross-site navigation carries it, and `__Host-` so the browser enforces
/// the first and the scope (`docs/security/dashboard.md`).
pub fn session_cookie(token: &str) -> String {
    format!(
        "{SESSION_COOKIE}={token}; Path=/; Max-Age={SESSION_TTL_SECS}; Secure; HttpOnly; SameSite=Strict"
    )
}

/// `Set-Cookie` for the CSRF value. Deliberately readable by the dashboard's
/// own script: the double-submit check needs it in a header. Everything else
/// matches the session cookie.
pub fn csrf_cookie(token: &str) -> String {
    format!("{CSRF_COOKIE}={token}; Path=/; Max-Age={SESSION_TTL_SECS}; Secure; SameSite=Strict")
}

/// `Set-Cookie` that clears one cookie now. It carries the same attributes
/// the cookie was set with, because a `__Host-` name is refused without
/// them and a refused clear leaves the cookie standing.
pub fn expired_cookie(name: &str) -> String {
    format!("{name}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict")
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
    let authed = auth::device(app, req, client)?;
    let token = mint(32)?;
    let now = app.clock.unix_secs();
    let expires = app
        .sessions
        .lock()
        .expect("sessions")
        .add_link(&token, now, authed.id);
    let base = app
        .cfg
        .public_url
        .as_deref()
        .unwrap_or_default()
        .trim_end_matches('/')
        .to_string();
    let url = format!("{base}/login?token={token}");
    Ok(Response::json(
        200,
        &obj(vec![("url", s(&url)), ("expires", n(expires))]),
    ))
}

/// `GET /login?token=…`: consume a login link, or the first-boot setup token
/// as the documented recovery login, and set the session.
///
/// The token is 256 bits compared in constant time, and there is deliberately
/// no attempt limit in front of that compare. A limit keyed by request source
/// refuses EVERYONE at once wherever that source is a proxy this deployment
/// does not trust -- the shipped chart's own default, with no trusted CIDR --
/// which would make the recovery login the easiest thing on the server to
/// deny. Every refusal is one `warn` line that reaches the Logs page as well
/// as stdout, and no run of them can push the authenticated record off that
/// page (`docs/security/dashboard.md`).
///
/// # Errors
/// `401 bad_login_token` when the token is absent, spent, or wrong.
pub fn login(app: &App, req: &mut Request) -> Result<Response, ApiError> {
    let now = app.clock.unix_secs();
    // An absent token takes the same path as a wrong one: one refusal, and
    // nothing an unauthenticated caller can tell apart.
    let token = req.query_param("token").unwrap_or_default().to_string();

    let mut sessions = app.sessions.lock().expect("sessions");
    let recovery = app
        .setup_token
        .as_deref()
        .is_some_and(|expected| ct::eq(expected.as_bytes(), token.as_bytes()));
    let minted_by = sessions.take_link(&token, now);
    if minted_by.is_none() && !recovery {
        drop(sessions);
        app.log.warn(
            "dashboard_login_refused",
            &[("decision", Val::word("bad_login_token"))],
        );
        return Err(ApiError::new(
            401,
            "bad_login_token",
            "login token is not valid",
        ));
    }
    // A link was spent, or the recovery token matched in constant time:
    // either way this caller held a credential. Below this line the request
    // is credentialed; above it, every path is a refusal that proved
    // nothing.
    req.prove();
    let session = mint(32)?;
    let csrf = mint(32)?;
    sessions.open(&session, &csrf, now, minted_by);
    drop(sessions);

    // The recovery token is a standing credential with no device behind it,
    // so its use is a warning and not a note, and the overview says so while
    // the session lasts (`docs/recovery.md`).
    if recovery {
        app.log.warn(
            "dashboard_login",
            &[("decision", Val::word("recovery_login"))],
        );
    } else {
        app.log.info(
            "dashboard_login",
            &[
                ("decision", Val::word("link_login")),
                (
                    "device",
                    minted_by.map_or(Val::word("-"), |id| Val::device(&id)),
                ),
            ],
        );
    }
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

/// `POST /v1/admin/logout-all`: sign out every dashboard session, this one
/// included.
///
/// A session lives in this process and nowhere else, so this is the whole
/// answer to a browser left signed in somewhere the operator no longer
/// controls: it does not wait for the twelve-hour limit and it does not need
/// a restart.
///
/// # Errors
/// `401 no_session`, `403 csrf_failed`.
pub fn logout_all(app: &App, req: &mut Request) -> Result<Response, ApiError> {
    mutating_session(app, req)?;
    let (closed, dropped) = app.sessions.lock().expect("sessions").close_all();
    app.log.warn(
        "dashboard_sessions_closed",
        &[
            ("count", Val::count(closed as u64)),
            ("links_dropped", Val::count(dropped as u64)),
            ("by", Val::word("dashboard")),
        ],
    );
    Ok(Response::empty(204)
        .header("Set-Cookie", &expired_cookie(SESSION_COOKIE))
        .header("Set-Cookie", &expired_cookie(CSRF_COOKIE)))
}

/// `GET /v1/admin/overview` (`docs/protocol.md`, "Dashboard (admin) API").
///
/// # Errors
/// `401 no_session`.
pub fn overview(app: &App, req: &mut Request) -> Result<Response, ApiError> {
    let token = session(app, req)?;
    let recovery = {
        let now = app.clock.unix_secs();
        let sessions = app.sessions.lock().expect("sessions");
        sessions
            .get(&token, now)
            .is_some_and(|s| s.minted_by.is_none())
    };
    let account = match app.store.account() {
        Some(a) => render::account(&a, app.store.devices().len() as u64),
        None => Value::Null,
    };
    let volumes: Vec<Value> = app.store.volumes().iter().map(render::volume).collect();
    let public_url = render::maybe(app.cfg.public_url.as_deref(), s);
    let (versions, files) = app.store.counts();
    Ok(Response::json(
        200,
        &obj(vec![
            ("account", account),
            ("edge", s(app.cfg.edge.as_word())),
            ("public_url", public_url),
            ("volumes", Value::Array(volumes)),
            (
                "versions",
                obj(vec![("total", n(versions)), ("files", n(files))]),
            ),
            (
                "activity",
                obj(vec![("versions_per_hour", versions_per_hour(app))]),
            ),
            ("last_gc", last_gc(app)),
            ("last_scrub", last_scrub(app)),
            ("session", obj(vec![("recovery", render::b(recovery))])),
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
/// The same last-device refusal the device route has carried since it
/// shipped: one click here used to be an account nothing could ever reach
/// again, because no route re-enrols a device and `POST /v1/setup` answers
/// `409 already_set_up` forever (`docs/recovery.md`).
///
/// # Errors
/// `401 no_session`, `403 csrf_failed`, `404 unknown_device`,
/// `409 last_device`.
pub fn revoke(app: &App, req: &mut Request, id: &str) -> Result<Response, ApiError> {
    mutating_session(app, req)?;
    let target = render::device_id(id)?;
    // The same single-lock refusal the device route takes: see
    // `Store::revoke_device_unless_last`.
    app.store.revoke_device_unless_last(&target)?;
    let (sessions, links) = app
        .sessions
        .lock()
        .expect("sessions")
        .close_for_device(&target);
    app.log.warn(
        "device_revoked",
        &[
            ("device", Val::device(&target)),
            ("by", Val::word("dashboard")),
            ("sessions_closed", Val::count(sessions as u64)),
            ("links_dropped", Val::count(links as u64)),
        ],
    );
    Ok(Response::empty(204))
}

/// `GET /v1/admin/storage` (`docs/protocol.md`, "Dashboard (admin) API").
///
/// # Errors
/// `401 no_session`.
pub fn storage(app: &App, req: &mut Request) -> Result<Response, ApiError> {
    session(app, req)?;
    let volumes: Vec<Value> = app.store.volumes().iter().map(render::volume).collect();
    let last_scrub_summary = app.store.last_scrub();
    Ok(Response::json(
        200,
        &obj(vec![
            ("volumes", Value::Array(volumes)),
            (
                "retention",
                obj(vec![
                    ("days", n(u64::from(app.cfg.retention_days))),
                    ("versions", n(u64::from(app.cfg.retention_versions))),
                ]),
            ),
            (
                "watermark",
                obj(vec![("spec", s(&watermark_spec(&app.cfg.free_watermark)))]),
            ),
            (
                "gc",
                obj(vec![
                    ("state", s(job_state(app.gc_running()))),
                    ("last", last_gc(app)),
                ]),
            ),
            (
                "scrub",
                obj(vec![
                    ("state", s(job_state(app.scrub_running()))),
                    ("rate_bytes_per_sec", n(app.cfg.scrub_rate_bytes_per_sec)),
                    ("last", last_scrub(app)),
                ]),
            ),
            (
                "quarantine",
                render::quarantine(last_scrub_summary.as_ref()),
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

/// `GET /v1/admin/logs?device=<id prefix>&limit=<n>`: the recent decision
/// lines, newest first (`docs/protocol.md`).
///
/// # Errors
/// `400 bad_request`, `401 no_session`.
pub fn logs(app: &App, req: &mut Request) -> Result<Response, ApiError> {
    let device = req.query_param("device").map(str::to_string);
    let limit = req.query_param("limit").map(str::to_string);
    session(app, req)?;
    if let Some(d) = device.as_deref()
        && (d.is_empty() || d.len() > 32 || !d.bytes().all(|c| c.is_ascii_hexdigit()))
    {
        return Err(ApiError::bad_request(
            "device must be a hex device-id prefix",
        ));
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
                ("method", s(l.method)),
                ("path_class", s(l.path_class)),
                (
                    "device",
                    render::maybe(l.device.as_ref(), |id| s(&id.to_string())),
                ),
                ("status", n(u64::from(l.status))),
                ("bytes", n(l.bytes)),
                ("duration_ms", n(l.duration_ms)),
                ("decision", s(l.decision)),
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
    let mut sessions = app.sessions.lock().expect("sessions");
    // Touch, not read: the idle limit measures silence, so every accepted
    // request pushes it out and only a session nobody uses expires early.
    sessions.touch(&token, now).ok_or_else(no_session)?;
    // A live session is a credential this server minted and just matched, so
    // the response is a credentialed one from here on -- including the
    // `403 csrf_failed` that `mutating_session` may answer next, which is a
    // signed-in browser being refused, not a stranger.
    req.prove();
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

/// Whether a background job is mid-run.
fn job_state(running: bool) -> &'static str {
    if running { "running" } else { "idle" }
}

/// The watermark as the operator wrote it (`OBSYNC_FREE_WATERMARK`).
fn watermark_spec(w: &crate::config::Watermark) -> String {
    format!("{}%,{}", w.percent, w.bytes)
}

/// Versions per hour for the last 24 hours, oldest first.
///
/// The window is the tail of the change feed, capped at
/// [`super::CHANGES_MAX_LIMIT`] frames: a dashboard page load is bounded work
/// however large the vault is, and a server busier than that reports the busy
/// end of the window, which is the part the graph is for.
fn versions_per_hour(app: &App) -> Value {
    const HOURS: u64 = 24;
    let now = app.clock.unix_secs();
    let first_hour = (now / 3600).saturating_sub(HOURS - 1);
    let mut counts = [0u64; HOURS as usize];

    let head = render::seq_u64(app.store.head_seq());
    let since = Seq(head.saturating_sub(super::CHANGES_MAX_LIMIT));
    if let Ok(c) = app.store.changes(since, super::CHANGES_MAX_LIMIT as usize) {
        for change in &c.changes {
            let hour = render::ms_u64(change.version.ts) / 1000 / 3600;
            if hour >= first_hour && hour < first_hour + HOURS {
                counts[(hour - first_hour) as usize] += 1;
            }
        }
    }
    Value::Array(
        counts
            .iter()
            .enumerate()
            .map(|(i, count)| {
                obj(vec![
                    ("hour", n((first_hour + i as u64) * 3600)),
                    ("count", n(*count)),
                ])
            })
            .collect(),
    )
}

fn mint(bytes: usize) -> Result<String, ApiError> {
    rand::hex_token(bytes)
        .map_err(|_| ApiError::new(500, "no_randomness", "the system CSPRNG is unavailable"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(byte: u8) -> DeviceId {
        DeviceId::new([byte; 16])
    }

    #[test]
    fn the_session_cookie_is_host_prefixed_secure_http_only_and_same_site_strict() {
        let c = session_cookie("abc");
        assert!(c.starts_with("__Host-obsync_session=abc;"), "{c}");
        assert!(c.contains("Secure"), "{c}");
        assert!(c.contains("HttpOnly"), "{c}");
        assert!(c.contains("SameSite=Strict"), "{c}");
        assert!(c.contains("Path=/"), "{c}");
        // `__Host-` is refused by the browser with either of these, so a
        // cookie carrying one is a cookie that never arrives.
        assert!(!c.contains("Domain="), "{c}");
    }

    #[test]
    fn the_csrf_cookie_is_readable_by_script_but_otherwise_the_same() {
        let c = csrf_cookie("xyz");
        assert!(c.starts_with("__Host-obsync_csrf=xyz;"), "{c}");
        assert!(
            !c.contains("HttpOnly"),
            "the double-submit value must be readable: {c}"
        );
        assert!(c.contains("Secure"), "{c}");
        assert!(c.contains("SameSite=Strict"), "{c}");
        assert!(!c.contains("Domain="), "{c}");
    }

    #[test]
    fn a_cleared_cookie_carries_what_the_host_prefix_demands() {
        for c in [expired_cookie(SESSION_COOKIE), expired_cookie(CSRF_COOKIE)] {
            assert!(c.contains("Secure"), "{c}");
            assert!(c.contains("Path=/"), "{c}");
            assert!(c.contains("Max-Age=0"), "{c}");
            assert!(!c.contains("Domain="), "{c}");
        }
    }

    #[test]
    fn cookies_parse_into_pairs() {
        let header = "__Host-obsync_session=a; __Host-obsync_csrf=b";
        let pairs = parse_cookies(header);
        assert_eq!(pairs.len(), 2);
        assert_eq!(cookie(Some(header), CSRF_COOKIE).as_deref(), Some("b"));
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
    fn a_login_link_works_once_expires_and_names_its_device() {
        let mut t = SessionTable::new();
        t.add_link("tok", 1_000, device(1));
        assert_eq!(t.take_link("tok", 1_100), Some(device(1)), "first use");
        assert_eq!(t.take_link("tok", 1_100), None, "second use");
        t.add_link("tok2", 1_000, device(1));
        assert_eq!(
            t.take_link("tok2", 1_000 + LOGIN_LINK_TTL_SECS + 1),
            None,
            "expired"
        );
    }

    #[test]
    fn a_session_expires_absolutely_and_sweeps() {
        let mut t = SessionTable::new();
        t.open("sess", "csrf", 1_000, Some(device(1)));
        // Kept alive by use, so only the absolute limit ends it.
        for step in (0..SESSION_TTL_SECS).step_by(SESSION_IDLE_SECS as usize / 2) {
            assert!(t.touch("sess", 1_000 + step).is_some(), "at {step}");
        }
        assert!(t.get("sess", 1_000 + SESSION_TTL_SECS - 1).is_some());
        assert!(t.get("sess", 1_000 + SESSION_TTL_SECS).is_none());
        assert_eq!(t.sweep(1_000 + SESSION_TTL_SECS), 1);
        assert!(t.get("sess", 1_000).is_none());
    }

    #[test]
    fn a_session_nobody_uses_expires_on_the_idle_limit() {
        let mut t = SessionTable::new();
        t.open("sess", "csrf", 1_000, None);
        assert!(t.get("sess", 1_000 + SESSION_IDLE_SECS - 1).is_some());
        assert!(
            t.get("sess", 1_000 + SESSION_IDLE_SECS).is_none(),
            "an idle session is gone long before the absolute limit"
        );
        // And a touched one carries its silence forward from the touch.
        let mut t = SessionTable::new();
        t.open("sess", "csrf", 1_000, None);
        assert!(t.touch("sess", 1_000 + SESSION_IDLE_SECS - 1).is_some());
        assert!(t.get("sess", 1_000 + SESSION_IDLE_SECS + 1).is_some());
        assert!(t.get("sess", 1_000 + 2 * SESSION_IDLE_SECS).is_none());
    }

    #[test]
    fn closing_a_session_ends_it_and_sign_out_everywhere_ends_all_of_them() {
        let mut t = SessionTable::new();
        t.open("sess", "csrf", 1_000, Some(device(1)));
        t.close("sess");
        assert!(t.get("sess", 1_000).is_none());

        t.open("one", "csrf", 1_000, Some(device(1)));
        t.open("two", "csrf", 1_000, None);
        t.add_link("unspent", 1_000, device(1));
        assert_eq!(t.close_all(), (2, 1));
        assert!(t.get("one", 1_000).is_none());
        assert!(t.get("two", 1_000).is_none());
        assert_eq!(
            t.take_link("unspent", 1_000),
            None,
            "a link the operator never spent is not a way back in"
        );
    }

    #[test]
    fn revoking_a_device_takes_its_sessions_and_its_outstanding_links() {
        let mut t = SessionTable::new();
        t.open("from-lost", "csrf", 1_000, Some(device(1)));
        t.open("from-kept", "csrf", 1_000, Some(device(2)));
        t.open("from-recovery", "csrf", 1_000, None);
        t.add_link("lost-link", 1_000, device(1));
        t.add_link("kept-link", 1_000, device(2));

        assert_eq!(t.close_for_device(&device(1)), (1, 1));
        assert!(t.get("from-lost", 1_000).is_none(), "its session is gone");
        assert_eq!(t.take_link("lost-link", 1_000), None, "its link is gone");
        assert!(t.get("from-kept", 1_000).is_some(), "another device stands");
        assert!(
            t.get("from-recovery", 1_000).is_some(),
            "the recovery login belongs to no device"
        );
        assert_eq!(t.take_link("kept-link", 1_000), Some(device(2)));
    }
}
