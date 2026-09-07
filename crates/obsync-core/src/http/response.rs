//! Responses and the one place that writes them to the wire.

use std::fmt::Write as _;
use std::io::{self, Read, Write};

use super::BUFFER_BYTES;
use crate::json::Value;

/// A response, built by a handler and written by the server.
pub struct Response {
    /// Status code. The reason phrase comes from a fixed table.
    pub status: u16,
    /// Headers in the order they will be written. `Content-Length`,
    /// `Connection`, and `Transfer-Encoding` are owned by the server and are
    /// dropped from this list when the response is written.
    pub headers: Vec<(String, String)>,
    /// The body.
    pub body: ResponseBody,
}

/// Where a response body comes from.
pub enum ResponseBody {
    /// No body. `Content-Length: 0`.
    Empty,
    /// A body already in memory.
    Bytes(Vec<u8>),
    /// A body streamed from a reader. The length must be known in advance
    /// because this server never sends a chunked response.
    Stream {
        /// Source of the body bytes.
        reader: Box<dyn Read + Send>,
        /// Exactly how many bytes `reader` will produce.
        len: u64,
    },
}

impl Response {
    /// A response with no body.
    pub fn empty(status: u16) -> Response {
        Response {
            status,
            headers: Vec::new(),
            body: ResponseBody::Empty,
        }
    }

    /// A response with an in-memory body and an explicit content type.
    pub fn bytes(status: u16, content_type: &str, body: Vec<u8>) -> Response {
        Response::empty(status)
            .header("Content-Type", content_type)
            .with_body(ResponseBody::Bytes(body))
    }

    /// A `text/plain; charset=utf-8` response.
    pub fn text(status: u16, body: &str) -> Response {
        Response::bytes(
            status,
            "text/plain; charset=utf-8",
            body.as_bytes().to_vec(),
        )
    }

    /// An `application/json` response carrying the canonical serialization of
    /// `value` (`crate::json`).
    pub fn json(status: u16, value: &Value) -> Response {
        Response::bytes(status, "application/json", value.to_json().into_bytes())
    }

    /// A streamed response of exactly `len` bytes. If `reader` ends early the
    /// write fails and the connection closes, because the client has already
    /// been promised `len` bytes.
    pub fn stream(
        status: u16,
        content_type: &str,
        reader: Box<dyn Read + Send>,
        len: u64,
    ) -> Response {
        Response::empty(status)
            .header("Content-Type", content_type)
            .with_body(ResponseBody::Stream { reader, len })
    }

    /// Append one header. Duplicates are kept: several `Set-Cookie` or
    /// `X-Obsync-*` headers are legitimate.
    pub fn header(mut self, name: &str, value: &str) -> Response {
        self.headers.push((name.to_string(), value.to_string()));
        self
    }

    /// Close the connection after this response.
    pub fn close(self) -> Response {
        self.header("Connection", "close")
    }

    fn with_body(mut self, body: ResponseBody) -> Response {
        self.body = body;
        self
    }

    /// Whether the handler asked for the connection to close.
    pub(crate) fn wants_close(&self) -> bool {
        self.headers.iter().any(|(name, value)| {
            name.eq_ignore_ascii_case("connection")
                && value
                    .split(',')
                    .any(|token| token.trim().eq_ignore_ascii_case("close"))
        })
    }

    /// The `Content-Length` this response will carry.
    pub(crate) fn content_length(&self) -> u64 {
        match &self.body {
            ResponseBody::Empty => 0,
            ResponseBody::Bytes(bytes) => bytes.len() as u64,
            ResponseBody::Stream { len, .. } => *len,
        }
    }
}

/// Write one response. `head_only` suppresses the body for a HEAD request
/// without changing the headers; `close` adds `Connection: close`.
pub(crate) fn write_response(
    writer: &mut impl Write,
    response: Response,
    head_only: bool,
    close: bool,
) -> io::Result<()> {
    let length = response.content_length();
    let mut head = String::with_capacity(256);
    let _ = write!(
        head,
        "HTTP/1.1 {} {}\r\n",
        response.status,
        reason(response.status)
    );
    for (name, value) in &response.headers {
        // The server owns framing; a handler cannot set it, and a header that
        // would break framing never reaches the wire.
        if is_framing_header(name) || !header_is_safe(name, value) {
            continue;
        }
        let _ = write!(head, "{name}: {value}\r\n");
    }
    let _ = write!(head, "Content-Length: {length}\r\n");
    if close {
        head.push_str("Connection: close\r\n");
    }
    head.push_str("\r\n");
    writer.write_all(head.as_bytes())?;
    if head_only {
        return writer.flush();
    }
    match response.body {
        ResponseBody::Empty => {}
        ResponseBody::Bytes(bytes) => writer.write_all(&bytes)?,
        ResponseBody::Stream { reader, len } => copy_exact(reader, writer, len)?,
    }
    writer.flush()
}

fn copy_exact(
    mut reader: Box<dyn Read + Send>,
    writer: &mut impl Write,
    len: u64,
) -> io::Result<()> {
    let mut buffer = [0u8; BUFFER_BYTES];
    let mut remaining = len;
    while remaining > 0 {
        let want = remaining.min(buffer.len() as u64) as usize;
        let count = match reader.read(&mut buffer[..want]) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "response body ended before its Content-Length",
                ));
            }
            Ok(count) => count,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(err),
        };
        writer.write_all(&buffer[..count])?;
        remaining -= count as u64;
    }
    Ok(())
}

fn is_framing_header(name: &str) -> bool {
    name.eq_ignore_ascii_case("content-length")
        || name.eq_ignore_ascii_case("connection")
        || name.eq_ignore_ascii_case("transfer-encoding")
}

/// A header name must be a token and a value must carry nothing that could
/// start a new line: that is the whole of response splitting.
fn header_is_safe(name: &str, value: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(is_token_byte)
        && value
            .bytes()
            .all(|byte| byte != b'\r' && byte != b'\n' && byte != 0)
}

pub(crate) fn is_token_byte(byte: u8) -> bool {
    matches!(byte,
        b'!' | b'#' | b'$' | b'%' | b'&' | b'\'' | b'*' | b'+' | b'-' | b'.'
        | b'^' | b'_' | b'`' | b'|' | b'~'
        | b'0'..=b'9' | b'a'..=b'z' | b'A'..=b'Z')
}

/// The reason phrases this server can send. Anything outside the table is
/// still a legal status line; the phrase is advisory.
fn reason(status: u16) -> &'static str {
    match status {
        100 => "Continue",
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        206 => "Partial Content",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        409 => "Conflict",
        410 => "Gone",
        413 => "Content Too Large",
        416 => "Range Not Satisfiable",
        417 => "Expectation Failed",
        421 => "Misdirected Request",
        422 => "Unprocessable Content",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        503 => "Service Unavailable",
        505 => "HTTP Version Not Supported",
        507 => "Insufficient Storage",
        _ => "Unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn written(response: Response, head_only: bool, close: bool) -> String {
        let mut out: Vec<u8> = Vec::new();
        write_response(&mut out, response, head_only, close).expect("write");
        String::from_utf8(out).expect("utf-8")
    }

    #[test]
    fn empty_response_carries_a_zero_length_and_no_date() {
        let text = written(Response::empty(204), false, false);
        assert_eq!(text, "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n");
        assert!(!text.contains("Date"));
    }

    #[test]
    fn text_and_json_set_their_content_type() {
        assert_eq!(
            written(Response::text(200, "hi"), false, false),
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 2\r\n\r\nhi"
        );
        let value = crate::json::obj(vec![("ready", Value::from(true))]);
        assert_eq!(
            written(Response::json(200, &value), false, false),
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 14\r\n\r\n{\"ready\":true}"
        );
    }

    #[test]
    fn head_keeps_the_headers_and_drops_the_body() {
        let text = written(Response::text(200, "body bytes"), true, false);
        assert!(text.ends_with("Content-Length: 10\r\n\r\n"));
        assert!(!text.contains("body bytes"));
    }

    #[test]
    fn close_is_written_once_and_only_by_the_server() {
        let text = written(Response::empty(200).close(), false, true);
        assert_eq!(text.matches("Connection: close").count(), 1);
        // A handler asking to close does not itself write the header.
        let text = written(Response::empty(200).close(), false, false);
        assert!(!text.contains("Connection"));
    }

    #[test]
    fn handler_headers_cannot_forge_framing_or_split_the_response() {
        let response = Response::empty(200)
            .header("Content-Length", "999")
            .header("Transfer-Encoding", "chunked")
            .header("X-Ok", "fine")
            .header("X-Split", "a\r\nX-Evil: yes")
            .header("X-Newline", "a\nb")
            .header("Bad Name", "v")
            .header("", "v");
        let text = written(response, false, false);
        assert_eq!(text.matches("Content-Length").count(), 1);
        assert!(text.contains("Content-Length: 0\r\n"));
        assert!(!text.contains("Transfer-Encoding"));
        assert!(text.contains("X-Ok: fine\r\n"));
        assert!(!text.contains("X-Evil"));
        assert!(!text.contains("X-Split"));
        assert!(!text.contains("X-Newline"));
        assert!(!text.contains("Bad Name"));
    }

    #[test]
    fn duplicate_non_framing_headers_are_kept_in_order() {
        let text = written(
            Response::empty(200)
                .header("X-Obsync-Seq", "1")
                .header("X-Obsync-Seq", "2"),
            false,
            false,
        );
        assert!(text.contains("X-Obsync-Seq: 1\r\nX-Obsync-Seq: 2\r\n"));
    }

    #[test]
    fn a_stream_writes_exactly_its_declared_length() {
        let source = Box::new(Cursor::new(b"0123456789".to_vec()));
        let text = written(
            Response::stream(206, "application/octet-stream", source, 4),
            false,
            false,
        );
        assert!(text.ends_with("Content-Length: 4\r\n\r\n0123"));
    }

    #[test]
    fn a_short_stream_is_an_error_rather_than_a_truncated_body() {
        let source = Box::new(Cursor::new(b"012".to_vec()));
        let mut out: Vec<u8> = Vec::new();
        let result = write_response(
            &mut out,
            Response::stream(200, "application/octet-stream", source, 8),
            false,
            false,
        );
        assert_eq!(
            result.map_err(|err| err.kind()),
            Err(io::ErrorKind::UnexpectedEof)
        );
    }

    #[test]
    fn unknown_statuses_still_produce_a_legal_status_line() {
        assert!(
            written(Response::empty(599), false, false).starts_with("HTTP/1.1 599 Unknown\r\n")
        );
        assert!(
            written(Response::empty(507), false, false)
                .starts_with("HTTP/1.1 507 Insufficient Storage\r\n")
        );
    }

    #[test]
    fn wants_close_reads_the_connection_token() {
        assert!(Response::empty(200).close().wants_close());
        assert!(
            Response::empty(200)
                .header("Connection", "keep-alive, close")
                .wants_close()
        );
        assert!(!Response::empty(200).wants_close());
        assert!(
            !Response::empty(200)
                .header("Connection", "keep-alive")
                .wants_close()
        );
    }
}
