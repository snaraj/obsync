//! A writer for the `multipart/mixed` response of `POST /v1/chunks/get`
//! (`docs/protocol.md`, "Chunks"): one part per requested chunk, in request
//! order, so a proxied hop carries one round trip instead of sixty-four.

/// Longest boundary RFC 2046 allows.
const MAX_BOUNDARY: usize = 70;

/// Boundary used when the caller's is empty after sanitizing.
const FALLBACK_BOUNDARY: &str = "obsync";

/// Builds a `multipart/mixed` body in memory.
///
/// The parts are chunk ciphertext, capped at 8 MiB each and 64 per request by
/// the protocol, so the whole body is bounded and buffering it is cheaper than
/// streaming it.
pub struct MultipartWriter {
    boundary: String,
    body: Vec<u8>,
}

impl MultipartWriter {
    /// Start a body. Characters RFC 2046 does not allow in a boundary are
    /// dropped and the result is truncated to 70 characters, because a
    /// boundary that does not match its `Content-Type` is unparseable and a
    /// caller-supplied one must never be able to inject a part separator.
    pub fn new(boundary: &str) -> MultipartWriter {
        let mut sanitized: String = boundary
            .chars()
            .filter(|character| is_boundary_char(*character))
            .take(MAX_BOUNDARY)
            .collect();
        if sanitized.is_empty() {
            sanitized.push_str(FALLBACK_BOUNDARY);
        }
        MultipartWriter {
            boundary: sanitized,
            body: Vec::new(),
        }
    }

    /// Append one part. A header whose name or value could break the framing
    /// is dropped, on the same rule as response headers.
    pub fn part(&mut self, headers: &[(&str, &str)], body: &[u8]) {
        self.body.extend_from_slice(b"--");
        self.body.extend_from_slice(self.boundary.as_bytes());
        self.body.extend_from_slice(b"\r\n");
        for (name, value) in headers {
            if !header_is_safe(name, value) {
                continue;
            }
            self.body.extend_from_slice(name.as_bytes());
            self.body.extend_from_slice(b": ");
            self.body.extend_from_slice(value.as_bytes());
            self.body.extend_from_slice(b"\r\n");
        }
        self.body.extend_from_slice(b"\r\n");
        self.body.extend_from_slice(body);
        self.body.extend_from_slice(b"\r\n");
    }

    /// Close the body with the final boundary and hand it over.
    pub fn finish(mut self) -> Vec<u8> {
        self.body.extend_from_slice(b"--");
        self.body.extend_from_slice(self.boundary.as_bytes());
        self.body.extend_from_slice(b"--\r\n");
        self.body
    }

    /// The `Content-Type` this body must be served with.
    pub fn content_type(&self) -> String {
        format!("multipart/mixed; boundary={}", self.boundary)
    }
}

fn is_boundary_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || "'()+_,-./:=?".contains(character)
}

fn header_is_safe(name: &str, value: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(super::response::is_token_byte)
        && value
            .bytes()
            .all(|byte| byte != b'\r' && byte != b'\n' && byte != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(bytes: Vec<u8>) -> String {
        String::from_utf8(bytes).expect("utf-8")
    }

    #[test]
    fn one_part_is_framed_by_its_boundary() {
        let mut writer = MultipartWriter::new("obsync-1");
        writer.part(&[("X-Obsync-Sid", "ab"), ("Content-Length", "2")], b"hi");
        assert_eq!(
            text(writer.finish()),
            "--obsync-1\r\nX-Obsync-Sid: ab\r\nContent-Length: 2\r\n\r\nhi\r\n--obsync-1--\r\n"
        );
    }

    #[test]
    fn parts_keep_request_order_and_an_empty_part_is_legal() {
        let mut writer = MultipartWriter::new("b");
        writer.part(&[("X-Obsync-Sid", "one")], b"1");
        writer.part(&[("X-Obsync-Sid", "two"), ("X-Obsync-Missing", "1")], b"");
        let body = text(writer.finish());
        let first = body.find("one").expect("first part");
        let second = body.find("two").expect("second part");
        assert!(first < second);
        assert!(body.contains("X-Obsync-Missing: 1\r\n\r\n\r\n"));
        assert_eq!(body.matches("--b\r\n").count(), 2);
        assert!(body.ends_with("--b--\r\n"));
    }

    #[test]
    fn content_type_names_the_boundary_actually_used() {
        let writer = MultipartWriter::new("chunk-boundary");
        assert_eq!(
            writer.content_type(),
            "multipart/mixed; boundary=chunk-boundary"
        );
        assert!(text(writer.finish()).contains("--chunk-boundary--"));
    }

    #[test]
    fn a_hostile_boundary_cannot_inject_framing() {
        let writer = MultipartWriter::new("a\r\n--evil\r\n");
        assert_eq!(writer.content_type(), "multipart/mixed; boundary=a--evil");
        let long = MultipartWriter::new(&"x".repeat(200));
        assert_eq!(long.boundary.len(), MAX_BOUNDARY);
        let empty = MultipartWriter::new("\r\n\t");
        assert_eq!(empty.content_type(), "multipart/mixed; boundary=obsync");
    }

    #[test]
    fn a_hostile_part_header_is_dropped() {
        let mut writer = MultipartWriter::new("b");
        writer.part(
            &[
                ("X-Obsync-Sid", "ok"),
                ("X-Evil", "v\r\n--b\r\nX-Obsync-Sid: forged"),
                ("Bad Name", "v"),
            ],
            b"",
        );
        let body = text(writer.finish());
        assert!(!body.contains("forged"));
        assert!(!body.contains("Bad Name"));
        assert_eq!(body.matches("--b\r\n").count(), 1);
    }
}
