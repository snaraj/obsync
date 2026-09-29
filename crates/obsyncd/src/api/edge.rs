//! Where the client address and country come from.
//!
//! PROVIDER NEUTRALITY: this file names no provider. It asks
//! `Edge::requires_edge_headers` for the behaviour and spells only the wire
//! header names, which are provider-neutral tokens; `config.rs` is the one
//! file that knows which provider the setting selects, and `doctrine_test`
//! pins that.
//!
//! TRUST IS BOUND TO THE PEER, in every mode. A header naming a client is a
//! claim, and only a peer inside `OBSYNC_TRUSTED_PROXY_CIDRS` may make one:
//! the edge-header mode refuses a request carrying the edge's headers from
//! any other peer, and `none` mode ignores forwarded headers from one. Every
//! field of a list header is read, in arrival order, as one list (RFC 9110
//! 5.3), because a proxy that ADDS a field rather than appending to the
//! client's would otherwise leave the client's own field first.
#![forbid(unsafe_code)]

use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;

use obsync_core::http::Request;

use crate::config::{Cidr, Config, Edge};

use super::ApiError;

/// Header carrying the address the edge accepted the connection from.
pub const EDGE_CONNECTING_ADDRESS: &str = "cf-connecting-ip";
/// Header carrying the edge's own request identifier.
pub const EDGE_REQUEST_ID: &str = "cf-ray";
/// Header carrying the two-letter country the edge resolved.
pub const EDGE_COUNTRY: &str = "cf-ipcountry";

/// Standard forwarded-address header, trusted only from a configured proxy.
pub const FORWARDED_FOR: &str = "x-forwarded-for";
/// The RFC 7239 forwarded header, trusted only from a configured proxy.
pub const FORWARDED: &str = "forwarded";

/// The line saying a trusted proxy sent a forwarding header in more than one
/// field goes out at most this often. Such a proxy does it on every request,
/// and one line a minute states that as well as one a request would.
pub const JOINED_LOG_INTERVAL_SECS: u64 = 60;

/// What the server may say about who sent a request. Never persisted for an
/// unauthenticated request and never part of a signed canonical string.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ClientInfo {
    /// Client address, when one is trustworthy.
    pub address: Option<String>,
    /// Two-letter country from the edge, when it supplied one.
    pub country: Option<String>,
    /// Why forwarded headers that arrived were not believed, for the log.
    pub ignored: Option<&'static str>,
    /// The `X-Forwarded-For` and `Forwarded` fields a trusted proxy sent,
    /// when either header came in more than one, for the log: a proxy that
    /// adds its own field rather than appending to the client's.
    pub joined: Option<(usize, usize)>,
}

impl ClientInfo {
    /// Nothing known: the health endpoints, which are probed from the
    /// orchestrator and never traverse the edge.
    pub fn unknown() -> Self {
        Self::default()
    }

    /// The address for a log line, which never carries an empty field.
    pub fn address_word(&self) -> &str {
        self.address.as_deref().unwrap_or("-")
    }
}

/// Every line of each header this file reads, in arrival order.
#[derive(Clone, Debug, Default)]
pub struct Forwarding<'a> {
    /// `EDGE_CONNECTING_ADDRESS` lines.
    pub connecting: Vec<&'a str>,
    /// `EDGE_REQUEST_ID` lines.
    pub request_id: Vec<&'a str>,
    /// `EDGE_COUNTRY` lines.
    pub country: Vec<&'a str>,
    /// `FORWARDED_FOR` lines.
    pub forwarded_for: Vec<&'a str>,
    /// `FORWARDED` lines.
    pub forwarded: Vec<&'a str>,
}

impl<'a> Forwarding<'a> {
    fn of(req: &'a Request) -> Self {
        Self {
            connecting: req.headers.all(EDGE_CONNECTING_ADDRESS),
            request_id: req.headers.all(EDGE_REQUEST_ID),
            country: req.headers.all(EDGE_COUNTRY),
            forwarded_for: req.headers.all(FORWARDED_FOR),
            forwarded: req.headers.all(FORWARDED),
        }
    }
}

/// Derive the client address and country for one request, refusing with
/// `421 edge_required` when the deployment sits behind an edge and the
/// request did not come through it (`docs/protocol.md`, "Authentication").
///
/// # Errors
/// `421 edge_required`.
pub fn derive(cfg: &Config, req: &Request) -> Result<ClientInfo, ApiError> {
    derive_parts(
        cfg.edge,
        &cfg.trusted_proxy_cidrs,
        req.peer.ip(),
        &Forwarding::of(req),
    )
}

/// The whole decision, free of the HTTP types, so both modes and every hop
/// case are unit-testable.
///
/// # Errors
/// `421 edge_required` when the edge's headers are required and either the
/// peer is not a trusted proxy or a header is absent, blank or repeated.
pub fn derive_parts(
    edge: Edge,
    trusted: &[Cidr],
    peer: IpAddr,
    headers: &Forwarding,
) -> Result<ClientInfo, ApiError> {
    // A dual-stack listener reports an IPv4 peer as `::ffff:a.b.c.d`, which
    // no IPv4 block contains.
    let peer = peer.to_canonical();
    let from_proxy = inside(trusted, peer);
    if edge.requires_edge_headers() {
        let refuse = |detail| ApiError::new(421, "edge_required", detail);
        if !from_proxy {
            return Err(refuse(
                "edge headers from a peer outside the trusted proxy networks",
            ));
        }
        let address = single(&headers.connecting)
            .and_then(node_ip)
            .ok_or_else(|| refuse("edge connecting-address header missing"))?;
        if single(&headers.request_id).is_none() {
            return Err(refuse("edge request-id header missing"));
        }
        return Ok(ClientInfo {
            address: Some(address.to_string()),
            country: single(&headers.country).and_then(sane_country),
            ignored: None,
            joined: None,
        });
    }
    let offered = !headers.forwarded_for.is_empty() || !headers.forwarded.is_empty();
    // Counted only where the fields are read: from a trusted proxy.
    let fields = (headers.forwarded_for.len(), headers.forwarded.len());
    let joined = (from_proxy && (fields.0 > 1 || fields.1 > 1)).then_some(fields);
    let (address, ignored) = match (offered, from_proxy) {
        (false, _) => (peer, None),
        (true, false) => (peer, Some("untrusted_peer")),
        (true, true) => match forwarded_client(headers, trusted) {
            Ok(client) => (client.unwrap_or(peer), None),
            Err(reason) => (peer, Some(reason)),
        },
    };
    Ok(ClientInfo {
        address: Some(address.to_string()),
        country: None,
        ignored,
        joined,
    })
}

/// When the joined-fields line last went out, and the requests it has not
/// counted yet.
#[derive(Debug, Default)]
pub struct JoinedLog(Mutex<(Option<u64>, u64)>);

impl JoinedLog {
    /// Count one request at `now`, in unix seconds. `Some(n)` when the line
    /// is due, `n` being the requests since the last one, this one included.
    /// A clock that steps a whole interval either way lets the next line out
    /// rather than holding it until the clock catches up.
    pub fn due(&self, now: u64) -> Option<u64> {
        let mut state = self.0.lock().expect("joined log");
        let (logged_at, unlogged) = &mut *state;
        *unlogged += 1;
        if logged_at.is_some_and(|at| at.abs_diff(now) < JOINED_LOG_INTERVAL_SECS) {
            return None;
        }
        *logged_at = Some(now);
        Some(std::mem::take(unlogged))
    }
}

fn inside(trusted: &[Cidr], ip: IpAddr) -> bool {
    trusted.iter().any(|c| c.contains(&ip))
}

/// Exactly one non-blank line. A repeated single-valued header is two
/// claims, and the server believes neither.
fn single<'a>(lines: &[&'a str]) -> Option<&'a str> {
    match lines {
        [line] => Some(line.trim()).filter(|v| !v.is_empty()),
        _ => None,
    }
}

/// The client a trusted proxy vouches for. Each header names a chain of hops,
/// client first; the client is the rightmost hop that is not itself a trusted
/// proxy. Both standard headers are read, and when both arrive they must name
/// the same client: a proxy that manages one passes the other through from the
/// client untouched, so a disagreement is a forgery in the one it does not
/// manage, and neither is believed.
fn forwarded_client(
    headers: &Forwarding,
    trusted: &[Cidr],
) -> Result<Option<IpAddr>, &'static str> {
    let by_for = hops(&headers.forwarded_for, |hop| hop);
    let by_forwarded = hops(&headers.forwarded, for_parameter);
    let chain = |hops: Vec<&str>| last_untrusted_hop(&hops, trusted);
    match (
        headers.forwarded_for.is_empty(),
        headers.forwarded.is_empty(),
    ) {
        (false, true) => Ok(chain(by_for)),
        (true, false) => Ok(chain(by_forwarded)),
        _ => {
            let (a, b) = (chain(by_for), chain(by_forwarded));
            if a == b {
                Ok(a)
            } else {
                Err("forwarded_headers_disagree")
            }
        }
    }
}

/// Every hop of a list-valued header, across every field, in arrival order:
/// repeated fields are one list, as if joined by commas (RFC 9110 5.3).
/// Empty list elements are list syntax, not hops.
fn hops<'a>(lines: &[&'a str], node: fn(&'a str) -> &'a str) -> Vec<&'a str> {
    lines
        .iter()
        .flat_map(|line| line.split(','))
        .map(str::trim)
        .filter(|hop| !hop.is_empty())
        .map(node)
        .collect()
}

/// The `for=` node of one RFC 7239 element, or the empty string when the
/// element names none (which then ends the walk as an unreadable hop).
///
/// The split is deliberately naive about quoting: a node is an address, which
/// never contains `,` or `;`, and a quote-aware split would let a client's
/// unterminated quote swallow the element the proxy appended after it.
fn for_parameter(element: &str) -> &str {
    element
        .split(';')
        .filter_map(|pair| pair.split_once('='))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("for"))
        .map_or("", |(_, value)| value.trim())
}

/// The rightmost hop that is not a trusted proxy. The walk stops at the
/// first hop it cannot read: an unreadable hop cannot be shown to be a
/// trusted proxy, so nothing written to its left can be attributed to one,
/// and skipping over it would hand a client that wrote there the answer.
fn last_untrusted_hop(hops: &[&str], trusted: &[Cidr]) -> Option<IpAddr> {
    for hop in hops.iter().rev() {
        let ip = node_ip(hop)?;
        if !inside(trusted, ip) {
            return Some(ip);
        }
    }
    None
}

/// An address in any spelling a forwarding header uses: bare, quoted,
/// bracketed IPv6, or either with a port.
fn node_ip(raw: &str) -> Option<IpAddr> {
    let v = raw.trim().trim_matches('"');
    let ip = v
        .parse::<IpAddr>()
        .ok()
        .or_else(|| v.parse::<SocketAddr>().ok().map(|s| s.ip()))
        .or_else(|| v.strip_prefix('[')?.strip_suffix(']')?.parse().ok())?;
    Some(ip.to_canonical())
}

/// Two ASCII alphanumerics, uppercased, or nothing. A header value never
/// reaches a record or a log line unsanitized.
fn sane_country(v: &str) -> Option<String> {
    let v = v.trim();
    if v.len() == 2 && v.bytes().all(|b| b.is_ascii_alphanumeric()) {
        Some(v.to_ascii_uppercase())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(v: &str) -> IpAddr {
        v.parse().expect("test address")
    }

    fn cidr(v: &str) -> Cidr {
        Cidr::parse(v).expect("test cidr")
    }

    fn address(c: &ClientInfo) -> &str {
        c.address.as_deref().expect("an address")
    }

    fn xff(v: &str) -> Forwarding<'_> {
        Forwarding {
            forwarded_for: vec![v],
            ..Forwarding::default()
        }
    }

    fn fwd(v: &str) -> Forwarding<'_> {
        Forwarding {
            forwarded: vec![v],
            ..Forwarding::default()
        }
    }

    /// Each header's fields, in arrival order.
    fn fields<'a>(forwarded_for: &[&'a str], forwarded: &[&'a str]) -> Forwarding<'a> {
        Forwarding {
            forwarded_for: forwarded_for.to_vec(),
            forwarded: forwarded.to_vec(),
            ..Forwarding::default()
        }
    }

    /// `none` mode behind a proxy at 10.1.2.3, trusting 10.0.0.0/8.
    fn proxied(h: &Forwarding) -> ClientInfo {
        derive_parts(Edge::None, &[cidr("10.0.0.0/8")], ip("10.1.2.3"), h).expect("derives")
    }

    fn edge_headers<'a>(connecting: &'a str) -> Forwarding<'a> {
        Forwarding {
            connecting: vec![connecting],
            request_id: vec!["req-1"],
            country: vec!["us"],
            ..Forwarding::default()
        }
    }

    fn edge(peer: &str, h: &Forwarding) -> Result<ClientInfo, ApiError> {
        derive_parts(
            Edge::requiring_headers(),
            &[cidr("10.0.0.0/8")],
            ip(peer),
            h,
        )
    }

    #[test]
    fn direct_mode_uses_the_peer_address() {
        let c = derive_parts(Edge::None, &[], ip("203.0.113.9"), &Forwarding::default())
            .expect("derives");
        assert_eq!(address(&c), "203.0.113.9");
        assert_eq!(c.country, None);
        assert_eq!(c.ignored, None);
    }

    #[test]
    fn direct_mode_ignores_forwarded_from_an_untrusted_peer() {
        for h in [xff("198.51.100.4"), fwd("for=198.51.100.4")] {
            let c = derive_parts(Edge::None, &[cidr("10.0.0.0/8")], ip("203.0.113.9"), &h)
                .expect("derives");
            assert_eq!(address(&c), "203.0.113.9");
            assert_eq!(c.ignored, Some("untrusted_peer"));
        }
    }

    #[test]
    fn direct_mode_takes_the_last_untrusted_hop_from_a_trusted_proxy() {
        let c = proxied(&xff("198.51.100.4, 203.0.113.7, 10.9.9.9"));
        assert_eq!(address(&c), "203.0.113.7");
        assert_eq!(c.ignored, None);
    }

    #[test]
    fn direct_mode_falls_back_to_the_peer_when_every_hop_is_trusted() {
        assert_eq!(address(&proxied(&xff("10.4.4.4, 10.9.9.9"))), "10.1.2.3");
    }

    #[test]
    fn every_line_of_a_forwarded_header_is_read_in_order() {
        // A proxy that ADDS its own line after the client's: reading only the
        // first line would believe the client's forgery.
        let h = Forwarding {
            forwarded_for: vec!["192.0.2.66", "203.0.113.7"],
            ..Forwarding::default()
        };
        assert_eq!(address(&proxied(&h)), "203.0.113.7");
        let h = Forwarding {
            forwarded: vec!["for=192.0.2.66", "for=203.0.113.7;proto=https"],
            ..Forwarding::default()
        };
        assert_eq!(address(&proxied(&h)), "203.0.113.7");
    }

    #[test]
    fn repeated_fields_are_one_list_walked_from_the_right() {
        for (h, why) in [
            (fields(&["203.0.113.7"], &[]), "one field"),
            (
                fields(&["192.0.2.66", "203.0.113.7"], &[]),
                "the proxy added its own field after the client's forgery",
            ),
            (
                fields(&["192.0.2.66, 203.0.113.7", "10.4.4.4", "10.9.9.9"], &[]),
                "a list split across fields, trusted hops to its right",
            ),
            (
                fields(&[], &["for=192.0.2.66", "for=203.0.113.7, for=10.9.9.9"]),
                "the same for Forwarded",
            ),
            (
                fields(
                    &["192.0.2.66", "203.0.113.7"],
                    &["for=192.0.2.67", "for=203.0.113.7"],
                ),
                "both headers, the proxy adding a field to each",
            ),
        ] {
            let c = proxied(&h);
            assert_eq!(address(&c), "203.0.113.7", "{why}");
            assert_eq!(c.ignored, None, "{why}");
        }
    }

    #[test]
    fn ipv6_hops_are_walked_like_ipv4_ones() {
        let trusted = [cidr("10.0.0.0/8"), cidr("fd00::/8")];
        let from =
            |h: &Forwarding| derive_parts(Edge::None, &trusted, ip("fd00::1"), h).expect("derives");
        let h = fields(&["2001:db8::66", "2001:db8::7, fd00::2"], &[]);
        assert_eq!(address(&from(&h)), "2001:db8::7");
        let h = fields(
            &[],
            &[
                "for=\"[2001:db8::66]\"",
                "for=\"[2001:db8::7]:4711\", for=\"[fd00::2]\"",
            ],
        );
        assert_eq!(address(&from(&h)), "2001:db8::7");
        assert_eq!(address(&from(&xff("fd00::3, fd00::2"))), "fd00::1");
        // An IPv6 peer outside the trusted networks is not read.
        let c = derive_parts(Edge::None, &trusted, ip("2001:db8::9"), &h).expect("derives");
        assert_eq!(address(&c), "2001:db8::9");
        assert_eq!(c.ignored, Some("untrusted_peer"));
    }

    #[test]
    fn repeated_fields_are_counted_only_where_they_are_read() {
        assert_eq!(proxied(&xff("192.0.2.66, 203.0.113.7")).joined, None);
        let h = fields(&["192.0.2.66", "203.0.113.7"], &["for=203.0.113.7"]);
        assert_eq!(proxied(&h).joined, Some((2, 1)));
        let h = fields(&["203.0.113.7"], &["for=192.0.2.66", "for=203.0.113.7"]);
        assert_eq!(proxied(&h).joined, Some((1, 2)));
        // Neither from a peer outside the trusted networks, nor in edge mode,
        // where only the edge's own headers are read.
        let h = fields(&["192.0.2.66", "203.0.113.7"], &[]);
        let c = derive_parts(Edge::None, &[cidr("10.0.0.0/8")], ip("203.0.113.9"), &h)
            .expect("derives");
        assert_eq!(c.joined, None);
        let h = Forwarding {
            forwarded_for: vec!["192.0.2.66", "203.0.113.7"],
            ..edge_headers("198.51.100.4")
        };
        assert_eq!(edge("10.1.2.3", &h).expect("derives").joined, None);
    }

    #[test]
    fn the_joined_line_is_due_once_an_interval_and_counts_the_requests_between() {
        let log = JoinedLog::default();
        assert_eq!(log.due(1_000), Some(1));
        assert_eq!(log.due(1_001), None);
        assert_eq!(log.due(1_000 + JOINED_LOG_INTERVAL_SECS - 1), None);
        assert_eq!(log.due(1_000 + JOINED_LOG_INTERVAL_SECS), Some(3));
        // A clock stepped back a whole interval lets the next line out.
        assert_eq!(log.due(999), Some(1));
    }

    #[test]
    fn the_walk_stops_at_an_unreadable_hop_rather_than_skipping_it() {
        // "unknown" is the proxy's own entry; left of it is client text.
        let c = proxied(&xff("192.0.2.66, unknown"));
        assert_eq!(address(&c), "10.1.2.3");
        let c = proxied(&fwd("for=192.0.2.66, for=_hidden"));
        assert_eq!(address(&c), "10.1.2.3");
        let c = proxied(&fwd("for=192.0.2.66, by=10.1.2.3"));
        assert_eq!(address(&c), "10.1.2.3");
    }

    #[test]
    fn rfc_7239_nodes_parse_in_every_spelling() {
        for (value, expected) in [
            ("for=192.0.2.60;proto=http;by=203.0.113.43", "192.0.2.60"),
            ("For=\"192.0.2.60:47011\"", "192.0.2.60"),
            ("for=\"[2001:db8:cafe::17]\"", "2001:db8:cafe::17"),
            ("for=\"[2001:db8:cafe::17]:4711\"", "2001:db8:cafe::17"),
            ("proto=https; for=198.51.100.17", "198.51.100.17"),
        ] {
            assert_eq!(address(&proxied(&fwd(value))), expected, "{value}");
        }
    }

    #[test]
    fn an_unterminated_quote_cannot_swallow_the_proxys_element() {
        let c = proxied(&fwd("for=\"192.0.2.66, for=203.0.113.7"));
        assert_eq!(address(&c), "203.0.113.7");
    }

    #[test]
    fn both_headers_must_name_the_same_client() {
        let agree = Forwarding {
            forwarded_for: vec!["203.0.113.7"],
            forwarded: vec!["for=203.0.113.7"],
            ..Forwarding::default()
        };
        assert_eq!(address(&proxied(&agree)), "203.0.113.7");
        // The proxy manages X-Forwarded-For and passes a forged Forwarded.
        let forged = Forwarding {
            forwarded_for: vec!["203.0.113.7"],
            forwarded: vec!["for=192.0.2.66"],
            ..Forwarding::default()
        };
        let c = proxied(&forged);
        assert_eq!(address(&c), "10.1.2.3");
        assert_eq!(c.ignored, Some("forwarded_headers_disagree"));
        // A forged header naming a trusted hop still disagrees with the
        // managed one; it cannot defer the answer to the forgery either way.
        let internal = Forwarding {
            forwarded_for: vec!["10.7.7.7"],
            forwarded: vec!["for=192.0.2.66"],
            ..Forwarding::default()
        };
        assert_eq!(address(&proxied(&internal)), "10.1.2.3");
    }

    #[test]
    fn a_mapped_ipv4_peer_and_hop_are_matched_as_ipv4() {
        let c = derive_parts(
            Edge::None,
            &[cidr("10.0.0.0/8")],
            ip("::ffff:10.1.2.3"),
            &xff("::ffff:203.0.113.7"),
        )
        .expect("derives");
        assert_eq!(address(&c), "203.0.113.7");
        let direct = derive_parts(
            Edge::None,
            &[],
            ip("::ffff:203.0.113.9"),
            &Forwarding::default(),
        )
        .expect("derives");
        assert_eq!(address(&direct), "203.0.113.9");
    }

    #[test]
    fn edge_mode_refuses_the_edge_headers_from_an_untrusted_peer() {
        let e = edge("203.0.113.9", &edge_headers("198.51.100.4")).expect_err("refuses");
        assert_eq!(e.status, 421);
        assert_eq!(e.code, "edge_required");
        let e = derive_parts(
            Edge::requiring_headers(),
            &[],
            ip("10.1.2.3"),
            &edge_headers("198.51.100.4"),
        )
        .expect_err("an empty trust list trusts no peer");
        assert_eq!(e.code, "edge_required");
    }

    #[test]
    fn edge_mode_requires_the_connecting_address() {
        let h = Forwarding {
            connecting: vec![],
            ..edge_headers("")
        };
        let e = edge("10.1.2.3", &h).expect_err("refuses");
        assert_eq!(e.status, 421);
        assert_eq!(e.code, "edge_required");
    }

    #[test]
    fn edge_mode_requires_the_request_id() {
        let h = Forwarding {
            request_id: vec![],
            ..edge_headers("198.51.100.4")
        };
        let e = edge("10.1.2.3", &h).expect_err("refuses");
        assert_eq!(e.status, 421);
        assert_eq!(e.code, "edge_required");
    }

    #[test]
    fn edge_mode_refuses_an_unparseable_or_repeated_edge_header() {
        let e = edge("10.1.2.3", &edge_headers("not-an-address")).expect_err("refuses");
        assert_eq!(e.code, "edge_required");
        let twice = Forwarding {
            connecting: vec!["192.0.2.66", "198.51.100.4"],
            ..edge_headers("")
        };
        assert_eq!(
            edge("10.1.2.3", &twice).expect_err("refuses").code,
            "edge_required"
        );
        let twice = Forwarding {
            request_id: vec!["req-1", "req-2"],
            ..edge_headers("198.51.100.4")
        };
        assert_eq!(
            edge("10.1.2.3", &twice).expect_err("refuses").code,
            "edge_required"
        );
    }

    #[test]
    fn edge_mode_reports_the_edge_address_and_country_over_any_forwarded_header() {
        let h = Forwarding {
            forwarded_for: vec!["192.0.2.1"],
            forwarded: vec!["for=192.0.2.1"],
            ..edge_headers("198.51.100.4")
        };
        let c = edge("10.1.2.3", &h).expect("derives");
        assert_eq!(address(&c), "198.51.100.4");
        assert_eq!(c.country.as_deref(), Some("US"));
    }

    #[test]
    fn a_nonsense_country_is_dropped() {
        assert_eq!(sane_country("United States"), None);
        assert_eq!(sane_country(""), None);
        assert_eq!(sane_country("u\n"), None);
        assert_eq!(sane_country("t1").as_deref(), Some("T1"));
        let twice = Forwarding {
            country: vec!["US", "FR"],
            ..edge_headers("198.51.100.4")
        };
        assert_eq!(edge("10.1.2.3", &twice).expect("derives").country, None);
    }

    #[test]
    fn an_unknown_client_logs_as_a_dash() {
        assert_eq!(ClientInfo::unknown().address_word(), "-");
        assert_eq!(ClientInfo::unknown().address, None);
    }
}
