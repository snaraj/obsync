//! The decision-log rings: what an unauthenticated caller can push out.
//!
//! The ring behind `GET /v1/admin/logs` is what the dashboard's Logs page
//! shows. One ring shared with unauthenticated traffic was one an
//! unauthenticated caller could empty, so there are two and each evicts only
//! itself.
#![forbid(unsafe_code)]

use super::{LogLine, RECENT_LOG_LINES, RECENT_PUBLIC_LOG_LINES, Recent};
use crate::types::DeviceId;

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

/// `GET /v1/admin/logs` is documented newest first, and a timestamp is a
/// millisecond: a busy server stamps several lines with the same one. A
/// stable sort over a forward walk lists the OLDEST of those first, under a
/// heading that promises the opposite.
#[test]
fn lines_stamped_in_the_same_millisecond_still_list_newest_first() {
    let mut r = Recent::default();
    r.push(line(7, "/v1/changes"), true);
    r.push(line(7, "/v1/admin/overview"), true);
    r.push(line(7, "/v1/admin/logs"), true);
    let got: Vec<&str> = r
        .newest_first(None, 10)
        .iter()
        .map(|l| l.path_class)
        .collect();
    assert_eq!(
        got,
        vec!["/v1/admin/logs", "/v1/admin/overview", "/v1/changes"],
        "arrival order reversed inside one millisecond"
    );

    // Across the two rings, the credentialed line of that millisecond leads.
    let mut r = Recent::default();
    r.push(line(7, "/livez"), false);
    r.push(line(7, "/v1/admin/overview"), true);
    let got: Vec<&str> = r
        .newest_first(None, 10)
        .iter()
        .map(|l| l.path_class)
        .collect();
    assert_eq!(got, vec!["/v1/admin/overview", "/livez"]);
}

#[test]
fn the_device_filter_reaches_both_rings_and_the_limit_caps_the_merge() {
    let mut r = Recent::default();
    let mine = DeviceId::new([0xab; 16]);
    let theirs = DeviceId::new([0xcd; 16]);
    for (ts, id, credentialed) in [
        (1u64, Some(mine), true),
        (2, Some(theirs), true),
        (3, Some(mine), false),
        (4, None, false),
    ] {
        let mut l = line(ts, "/v1/changes");
        l.device = id;
        r.push(l, credentialed);
    }
    let mine_only = r.newest_first(Some("abab"), 10);
    assert_eq!(mine_only.len(), 2, "one line from each ring");
    assert_eq!(mine_only[0].ts, 3, "newest first across the rings");
    assert_eq!(r.newest_first(None, 2).len(), 2, "the limit caps the merge");
    assert_eq!(r.newest_first(None, 2)[0].ts, 4);
}
