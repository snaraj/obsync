//! Where the client address and country come from.
//!
//! PROVIDER NEUTRALITY: this file is the ONE place under `crates/` that spells
//! the edge's wire header names, so `TestProviderNeutrality` can allowlist it.
//! Everything else refers to `Edge::Cloudflare` and to the three constants
//! below by their generic names. The edge is selected only by `OBSYNC_EDGE`
//! parsing in `config.rs`; no other code names a provider.
#![forbid(unsafe_code)]

use std::net::IpAddr;

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

/// The configured mode as the dashboard displays it. The two names live here,
/// beside the header names, so this file stays the one allowlisted place.
pub fn mode_name(edge: Edge) -> &'static str {
    match edge {
        Edge::None => "none",
        Edge::Cloudflare => "cloudflare",
    }
}

/// What the server may say about who sent a request. Never persisted for an
/// unauthenticated request and never part of a signed canonical string.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClientInfo {
    /// Client address as text, or `-` when nothing trustworthy is known.
    pub address: String,
    /// Two-letter country from the edge, when it supplied one.
    pub country: Option<String>,
}

impl ClientInfo {
    /// The placeholder used for the health endpoints, which are probed from
    /// the orchestrator and never traverse the edge.
    pub fn unknown() -> Self {
        Self {
            address: "-".to_string(),
            country: None,
        }
    }
}

/// Derive the client address and country for one request, refusing with
/// `421 edge_required` when the deployment sits behind an edge and the edge's
/// headers are absent (`docs/protocol.md`, "Authentication").
pub fn derive(cfg: &Config, req: &Request) -> Result<ClientInfo, ApiError> {
    derive_parts(
        cfg.edge,
        &cfg.trusted_proxy_cidrs,
        req.peer.ip(),
        req.headers.get(EDGE_CONNECTING_ADDRESS),
        req.headers.get(EDGE_REQUEST_ID),
        req.headers.get(EDGE_COUNTRY),
        req.headers.get(FORWARDED_FOR),
    )
}

/// The whole decision, free of the HTTP types, so both modes and every hop
/// case are unit-testable.
pub fn derive_parts(
    edge: Edge,
    trusted: &[Cidr],
    peer: IpAddr,
    connecting: Option<&str>,
    request_id: Option<&str>,
    country: Option<&str>,
    forwarded: Option<&str>,
) -> Result<ClientInfo, ApiError> {
    match edge {
        Edge::Cloudflare => {
            let address = connecting
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .and_then(|v| v.parse::<IpAddr>().ok())
                .ok_or_else(|| {
                    ApiError::new(
                        421,
                        "edge_required",
                        "edge connecting-address header missing",
                    )
                })?;
            let id_present = request_id.map(str::trim).is_some_and(|v| !v.is_empty());
            if !id_present {
                return Err(ApiError::new(
                    421,
                    "edge_required",
                    "edge request-id header missing",
                ));
            }
            Ok(ClientInfo {
                address: address.to_string(),
                country: sane_country(country),
            })
        }
        Edge::None => {
            if trusted.iter().any(|c| c.contains(&peer))
                && let Some(addr) = last_untrusted_hop(forwarded, trusted)
            {
                return Ok(ClientInfo {
                    address: addr,
                    country: None,
                });
            }
            Ok(ClientInfo {
                address: peer.to_string(),
                country: None,
            })
        }
    }
}

/// The rightmost `X-Forwarded-For` entry that is not itself a trusted proxy:
/// the last hop this deployment has no reason to trust.
fn last_untrusted_hop(forwarded: Option<&str>, trusted: &[Cidr]) -> Option<String> {
    let raw = forwarded?;
    for hop in raw.split(',').rev() {
        let hop = hop.trim();
        let Ok(ip) = hop.parse::<IpAddr>() else {
            continue;
        };
        if !trusted.iter().any(|c| c.contains(&ip)) {
            return Some(ip.to_string());
        }
    }
    None
}

/// Two ASCII alphanumerics, uppercased, or nothing. A header value never
/// reaches a record or a log line unsanitized.
fn sane_country(v: Option<&str>) -> Option<String> {
    let v = v?.trim();
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
        v.parse().expect("test cidr")
    }

    #[test]
    fn none_mode_uses_the_peer_address() {
        let c = derive_parts(Edge::None, &[], ip("203.0.113.9"), None, None, None, None)
            .expect("derives");
        assert_eq!(c.address, "203.0.113.9");
        assert_eq!(c.country, None);
    }

    #[test]
    fn none_mode_ignores_forwarded_from_an_untrusted_peer() {
        let c = derive_parts(
            Edge::None,
            &[cidr("10.0.0.0/8")],
            ip("203.0.113.9"),
            None,
            None,
            None,
            Some("198.51.100.4"),
        )
        .expect("derives");
        assert_eq!(c.address, "203.0.113.9");
    }

    #[test]
    fn none_mode_takes_the_last_untrusted_hop_from_a_trusted_proxy() {
        let c = derive_parts(
            Edge::None,
            &[cidr("10.0.0.0/8")],
            ip("10.1.2.3"),
            None,
            None,
            None,
            Some("198.51.100.4, 203.0.113.7, 10.9.9.9"),
        )
        .expect("derives");
        assert_eq!(c.address, "203.0.113.7");
    }

    #[test]
    fn none_mode_falls_back_to_the_peer_when_every_hop_is_trusted() {
        let c = derive_parts(
            Edge::None,
            &[cidr("10.0.0.0/8")],
            ip("10.1.2.3"),
            None,
            None,
            None,
            Some("10.4.4.4, 10.9.9.9"),
        )
        .expect("derives");
        assert_eq!(c.address, "10.1.2.3");
    }

    #[test]
    fn edge_mode_requires_the_connecting_address() {
        let e = derive_parts(
            Edge::Cloudflare,
            &[],
            ip("10.1.2.3"),
            None,
            Some("req-1"),
            Some("US"),
            None,
        )
        .expect_err("refuses");
        assert_eq!(e.status, 421);
        assert_eq!(e.code, "edge_required");
    }

    #[test]
    fn edge_mode_requires_the_request_id() {
        let e = derive_parts(
            Edge::Cloudflare,
            &[],
            ip("10.1.2.3"),
            Some("198.51.100.4"),
            None,
            Some("US"),
            None,
        )
        .expect_err("refuses");
        assert_eq!(e.status, 421);
        assert_eq!(e.code, "edge_required");
    }

    #[test]
    fn edge_mode_refuses_an_unparseable_connecting_address() {
        let e = derive_parts(
            Edge::Cloudflare,
            &[],
            ip("10.1.2.3"),
            Some("not-an-address"),
            Some("req-1"),
            None,
            None,
        )
        .expect_err("refuses");
        assert_eq!(e.code, "edge_required");
    }

    #[test]
    fn edge_mode_reports_the_edge_address_and_country() {
        let c = derive_parts(
            Edge::Cloudflare,
            &[],
            ip("10.1.2.3"),
            Some("198.51.100.4"),
            Some("req-1"),
            Some("us"),
            Some("192.0.2.1"),
        )
        .expect("derives");
        assert_eq!(c.address, "198.51.100.4");
        assert_eq!(c.country.as_deref(), Some("US"));
    }

    #[test]
    fn a_nonsense_country_is_dropped() {
        assert_eq!(sane_country(Some("United States")), None);
        assert_eq!(sane_country(Some("")), None);
        assert_eq!(sane_country(Some("u\n")), None);
        assert_eq!(sane_country(Some("t1")).as_deref(), Some("T1"));
    }
}
