//! Route resolution: every route of `docs/protocol.md` and nothing else.
#![forbid(unsafe_code)]

use super::{Route, demands_credential, resolve};

const SID: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ID: &str = "0123456789abcdef0123456789abcdef";

fn route(method: &str, path: &str) -> Route {
    resolve(method, path)
        .unwrap_or_else(|| panic!("{method} {path} must resolve"))
        .0
}

fn class(method: &str, path: &str) -> &'static str {
    resolve(method, path)
        .unwrap_or_else(|| panic!("{method} {path} must resolve"))
        .1
}

#[test]
fn health_endpoints_resolve() {
    assert_eq!(route("GET", "/livez"), Route::Livez);
    assert_eq!(route("GET", "/readyz"), Route::Readyz);
}

#[test]
fn setup_and_account_resolve() {
    assert_eq!(route("POST", "/v1/setup"), Route::Setup);
    assert_eq!(route("GET", "/v1/account"), Route::Account);
}

#[test]
fn every_pairing_route_resolves_with_its_id() {
    assert_eq!(route("POST", "/v1/pairing"), Route::PairingCreate);
    assert_eq!(
        route("POST", &format!("/v1/pairing/{ID}/claim")),
        Route::PairingClaim(ID.to_string())
    );
    assert_eq!(
        route("GET", &format!("/v1/pairing/{ID}")),
        Route::PairingState(ID.to_string())
    );
    assert_eq!(
        route("POST", &format!("/v1/pairing/{ID}/approve")),
        Route::PairingApprove(ID.to_string())
    );
    assert_eq!(
        route("POST", &format!("/v1/pairing/{ID}/reject")),
        Route::PairingReject(ID.to_string())
    );
    assert_eq!(
        route("GET", &format!("/v1/pairing/{ID}/envelope")),
        Route::PairingEnvelope(ID.to_string())
    );
}

#[test]
fn heartbeat_is_not_read_as_a_device_id() {
    assert_eq!(route("POST", "/v1/devices/heartbeat"), Route::Heartbeat);
    assert_eq!(
        class("POST", "/v1/devices/heartbeat"),
        "/v1/devices/heartbeat"
    );
    assert_eq!(
        route("POST", &format!("/v1/devices/{ID}/revoke")),
        Route::DeviceRevoke(ID.to_string())
    );
    assert_eq!(
        route("PATCH", &format!("/v1/devices/{ID}")),
        Route::DevicePatch(ID.to_string())
    );
    assert_eq!(route("GET", "/v1/devices"), Route::Devices);
}

#[test]
fn chunk_routes_resolve_and_keep_exists_and_get_distinct_from_a_sid() {
    assert_eq!(route("POST", "/v1/chunks/exists"), Route::ChunksExists);
    assert_eq!(route("POST", "/v1/chunks/get"), Route::ChunksGet);
    assert_eq!(
        route("PUT", &format!("/v1/chunks/{SID}")),
        Route::ChunkPut(SID.to_string())
    );
    assert_eq!(
        route("GET", &format!("/v1/chunks/{SID}")),
        Route::ChunkGet(SID.to_string())
    );
}

#[test]
fn file_and_version_routes_resolve() {
    assert_eq!(route("GET", "/v1/files"), Route::FilesPage);
    assert_eq!(
        route("POST", &format!("/v1/files/{ID}/versions")),
        Route::VersionPost(ID.to_string())
    );
    assert_eq!(
        route("GET", &format!("/v1/files/{ID}")),
        Route::FileGet(ID.to_string())
    );
    assert_eq!(
        route("GET", &format!("/v1/files/{ID}/versions/{SID}")),
        Route::VersionGet(ID.to_string(), SID.to_string())
    );
}

#[test]
fn feed_domain_and_admin_routes_resolve() {
    assert_eq!(route("GET", "/v1/changes"), Route::Changes);
    assert_eq!(route("POST", "/v1/dashboard/login-link"), Route::LoginLink);
    assert_eq!(route("GET", "/login"), Route::Login);
    assert_eq!(route("POST", "/v1/admin/logout"), Route::Logout);
    assert_eq!(route("GET", "/v1/admin/overview"), Route::AdminOverview);
    assert_eq!(route("GET", "/v1/admin/devices"), Route::AdminDevices);
    assert_eq!(
        route("POST", &format!("/v1/admin/devices/{ID}/revoke")),
        Route::AdminRevoke(ID.to_string())
    );
    assert_eq!(route("GET", "/v1/admin/storage"), Route::AdminStorage);
    assert_eq!(route("POST", "/v1/admin/gc/run"), Route::AdminGcRun);
    assert_eq!(route("POST", "/v1/admin/scrub/run"), Route::AdminScrubRun);
    assert_eq!(route("GET", "/v1/admin/logs"), Route::AdminLogs);
}

#[test]
fn plugin_and_dashboard_routes_resolve() {
    assert_eq!(route("GET", "/v1/plugin/manifest"), Route::PluginManifest);
    assert!(resolve("GET", "/v1/plugin/bundle").is_none());
    assert!(resolve("GET", "/v1/plugin/styles").is_none());
    assert_eq!(
        route("GET", "/"),
        Route::DashboardFile("index.html".to_string())
    );
    for name in ["index.html", "app.css", "app.js", "lib.js"] {
        assert_eq!(
            route("GET", &format!("/{name}")),
            Route::DashboardFile(name.to_string())
        );
    }
}

#[test]
fn the_log_class_is_a_template_and_never_carries_an_id() {
    for (method, path, expected) in [
        ("GET", format!("/v1/chunks/{SID}"), "/v1/chunks/{sid}"),
        (
            "POST",
            format!("/v1/files/{ID}/versions"),
            "/v1/files/{file_id}/versions",
        ),
        (
            "GET",
            format!("/v1/pairing/{ID}/envelope"),
            "/v1/pairing/{id}/envelope",
        ),
        (
            "POST",
            format!("/v1/devices/{ID}/revoke"),
            "/v1/devices/{id}/revoke",
        ),
    ] {
        let c = class(method, &path);
        assert_eq!(c, expected);
        assert!(!c.contains(ID), "the log class must not carry an id: {c}");
    }
}

#[test]
fn an_unknown_path_or_method_does_not_resolve() {
    assert!(resolve("GET", "/v1/nope").is_none());
    assert!(resolve("GET", "/v1/setup").is_none(), "setup is POST only");
    assert!(resolve("DELETE", "/v1/devices").is_none());
    assert!(resolve("GET", "/app.png").is_none());
    assert!(resolve("GET", "/dev/mock.html").is_none());
    assert!(resolve("TRACE", "/livez").is_none());
}

#[test]
fn nothing_outside_the_four_dashboard_files_is_served_from_the_root() {
    assert!(resolve("GET", "/../etc/passwd").is_none());
    assert!(resolve("GET", "/%2e%2e/app.css").is_none());
    assert!(resolve("GET", "/subdir/app.css").is_none());
    assert!(resolve("POST", "/app.js").is_none());
}

#[test]
fn empty_segments_are_ignored_so_a_trailing_slash_still_resolves() {
    assert_eq!(route("GET", "/v1/devices/"), Route::Devices);
    assert_eq!(route("GET", "//v1//devices"), Route::Devices);
}

/// Which routes answer without a credential decides two things at once: the
/// ring a decision line lands in, and whether the response states the
/// journal head. The list below is the unauthenticated surface
/// `docs/protocol.md` documents, and nothing else may join it silently --
/// `demands_credential` takes no wildcard, so a new route does not compile
/// until its author chooses.
#[test]
fn exactly_the_documented_unauthenticated_routes_answer_without_a_credential() {
    let public = [
        ("GET", "/livez".to_string()),
        ("GET", "/readyz".to_string()),
        ("POST", "/v1/setup".to_string()),
        ("POST", format!("/v1/pairing/{ID}/claim")),
        ("GET", "/v1/plugin/manifest".to_string()),
        ("GET", "/".to_string()),
        ("GET", "/index.html".to_string()),
        ("GET", "/app.css".to_string()),
        ("GET", "/app.js".to_string()),
        ("GET", "/lib.js".to_string()),
    ];
    for (method, path) in &public {
        assert!(
            !demands_credential(&route(method, path)),
            "{method} {path} is documented unauthenticated"
        );
    }

    // Everything else in the table demands one, the dashboard session
    // routes and `GET /login` included: a login link is a credential.
    let credentialed = [
        ("GET", "/v1/account".to_string()),
        ("POST", "/v1/pairing".to_string()),
        ("GET", format!("/v1/pairing/{ID}")),
        ("POST", format!("/v1/pairing/{ID}/approve")),
        ("POST", format!("/v1/pairing/{ID}/reject")),
        ("GET", format!("/v1/pairing/{ID}/envelope")),
        ("GET", "/v1/devices".to_string()),
        ("PATCH", format!("/v1/devices/{ID}")),
        ("POST", format!("/v1/devices/{ID}/revoke")),
        ("POST", "/v1/devices/heartbeat".to_string()),
        ("POST", "/v1/chunks/exists".to_string()),
        ("POST", "/v1/chunks/get".to_string()),
        ("PUT", format!("/v1/chunks/{SID}")),
        ("GET", format!("/v1/chunks/{SID}")),
        ("POST", format!("/v1/files/{ID}/versions")),
        ("GET", format!("/v1/files/{ID}")),
        ("GET", format!("/v1/files/{ID}/versions/{SID}")),
        ("GET", "/v1/files".to_string()),
        ("GET", "/v1/changes".to_string()),
        ("POST", "/v1/dashboard/login-link".to_string()),
        ("GET", "/login".to_string()),
        ("POST", "/v1/admin/logout".to_string()),
        ("POST", "/v1/admin/logout-all".to_string()),
        ("GET", "/v1/admin/overview".to_string()),
        ("GET", "/v1/admin/devices".to_string()),
        ("POST", format!("/v1/admin/devices/{ID}/revoke")),
        ("GET", "/v1/admin/storage".to_string()),
        ("POST", "/v1/admin/gc/run".to_string()),
        ("POST", "/v1/admin/scrub/run".to_string()),
        ("GET", "/v1/admin/logs".to_string()),
    ];
    for (method, path) in &credentialed {
        assert!(
            demands_credential(&route(method, path)),
            "{method} {path} must not answer an anonymous caller"
        );
    }
    // Every route in the table is named above exactly once, so neither list
    // can go stale while the other grows.
    assert_eq!(public.len() + credentialed.len(), 40);
}

#[test]
fn signing_out_everywhere_is_its_own_route_and_post_only() {
    assert_eq!(route("POST", "/v1/admin/logout-all"), Route::LogoutAll);
    assert_eq!(
        class("POST", "/v1/admin/logout-all"),
        "/v1/admin/logout-all"
    );
    assert!(resolve("GET", "/v1/admin/logout-all").is_none());
}
