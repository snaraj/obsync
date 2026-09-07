//! The per-connection limits, all of them from `docs/protocol.md`,
//! "Limits and headers".

use std::time::Duration;

/// What one connection may cost. Every field has a refusal attached to it, so
/// a value can be tuned but the refusal cannot be removed.
#[derive(Clone, Debug)]
pub struct Limits {
    /// Total bytes of request line plus header lines. Over this, 431.
    pub max_header_bytes: usize,
    /// Time allowed to deliver the request line and headers. Over this, 408.
    pub header_timeout: Duration,
    /// Time an idle keep-alive connection may wait for its next request.
    /// Over this, the connection closes with no response.
    pub idle_timeout: Duration,
    /// Floor on the rate a request body arrives at. Under this, the body read
    /// fails and the connection closes.
    pub min_body_rate_bytes_per_sec: u64,
    /// Concurrent connections. Over this, 503 with `Retry-After: 1`.
    pub max_connections: usize,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits {
            max_header_bytes: 16 * 1024,
            header_timeout: Duration::from_secs(10),
            idle_timeout: Duration::from_secs(60),
            min_body_rate_bytes_per_sec: 64 * 1024,
            max_connections: 256,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_the_protocol_document() {
        let limits = Limits::default();
        assert_eq!(limits.max_header_bytes, 16384);
        assert_eq!(limits.header_timeout, Duration::from_secs(10));
        assert_eq!(limits.idle_timeout, Duration::from_secs(60));
        assert_eq!(limits.min_body_rate_bytes_per_sec, 65536);
        assert_eq!(limits.max_connections, 256);
    }
}
