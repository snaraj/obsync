//! The decision-log rings: what an unauthenticated caller can push out.
//!
//! The ring behind `GET /v1/admin/logs` is what the dashboard's Logs page
//! shows. One ring shared with unauthenticated traffic was one an
//! unauthenticated caller could empty, so there are two and each evicts only
//! itself.
#![forbid(unsafe_code)]

use super::{LogLine, RECENT_LOG_LINES, RECENT_PUBLIC_LOG_LINES, Recent};

fn line(ts: u64, path_class: &'static str) -> LogLine {
    LogLine {
        ts,
        method: "GET",
        path_class,
        device: None,
        status: 200,
        bytes: 0,
        duration_ms: 0,
        decision: "ok",
    }
}

#[test]
fn a_flood_of_public_lines_evicts_only_public_lines() {
    let mut r = Recent::default();
    r.push(line(1, "/v1/admin/overview"), true);
    for i in 0..(RECENT_PUBLIC_LOG_LINES * 3) {
        r.push(line(2 + i as u64, "/livez"), false);
    }
    assert_eq!(
        r.public.len(),
        RECENT_PUBLIC_LOG_LINES,
        "the public ring is capped"
    );
    assert_eq!(
        r.credentialed.len(),
        1,
        "and the credentialed one is untouched by all of it"
    );
    assert_eq!(r.credentialed[0].path_class, "/v1/admin/overview");
}

#[test]
fn each_ring_evicts_its_own_oldest_line_first() {
    let mut r = Recent::default();
    for i in 0..(RECENT_LOG_LINES + 5) {
        r.push(line(i as u64, "/v1/changes"), true);
    }
    assert_eq!(r.credentialed.len(), RECENT_LOG_LINES);
    assert_eq!(
        r.credentialed[0].ts, 5,
        "the five oldest went, newest first is preserved"
    );
    assert_eq!(
        r.credentialed[RECENT_LOG_LINES - 1].ts,
        (RECENT_LOG_LINES + 4) as u64
    );

    for i in 0..(RECENT_PUBLIC_LOG_LINES + 3) {
        r.push(line(i as u64, "/livez"), false);
    }
    assert_eq!(r.public.len(), RECENT_PUBLIC_LOG_LINES);
    assert_eq!(r.public[0].ts, 3);
}
