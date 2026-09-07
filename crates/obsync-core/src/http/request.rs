//! Request parsing: the first hostile surface in the process.
//!
//! Every refusal here is a status, and the connection closes after it. The
//! rules that look strict are the request-smuggling ones: exactly one space
//! between the three parts of the request line, CRLF endings only, no obsolete
//! line folding, one `Host`, one `Content-Length`, and never both a length and
//! a transfer encoding.

use std::io;
use std::net::SocketAddr;

use super::body::{Body, Framing};
use super::response::is_token_byte;
use super::{ConnReader, Limits, LineEnd, is_timeout, read_line};

/// Longest request line accepted, before the header budget applies.
const MAX_REQUEST_LINE: usize = 8 * 1024;

/// Most header lines accepted in one request.
const MAX_HEADER_COUNT: usize = 128;

/// Longest method token accepted.
const MAX_METHOD: usize = 32;

/// One request, as the handler sees it.
pub struct Request {
    /// The method, exactly as sent.
    pub method: String,
    /// The request target, exactly as sent, which is what the request
    /// signature covers (`docs/protocol.md`, "Authentication").
    pub target: String,
    /// The percent-decoded path, with no query. Always starts with `/`, never
    /// contains a `.` or `..` segment, a NUL, or a slash that arrived as
    /// `%2F`: each of those is refused with 400 instead.
    pub path: String,
    /// Percent-decoded query parameters in the order sent. `+` is a literal
    /// plus, not a space: this is a path-style query, not a form body.
    pub query: Vec<(String, String)>,
    /// The request headers, in the order sent.
    pub headers: Headers,
    /// The request body, streamed from the connection.
    pub body: Body,
    /// The address the connection came from. Behind a terminator this is the
    /// terminator; the caller decides what to trust (AGENTS.md,
    /// "Deployment-provider contract").
    pub peer: SocketAddr,
}

impl Request {
    /// The first value of a query parameter.
    pub fn query_param(&self, name: &str) -> Option<&str> {
        self.query
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

/// Request headers, in the order they arrived.
pub struct Headers(Vec<(String, String)>);

impl Headers {
    /// Wrap a list of headers, for callers building a request in a test.
    pub fn from_pairs(pairs: Vec<(String, String)>) -> Headers {
        Headers(pairs)
    }

    /// The first value of a header, matched case-insensitively.
    pub fn get(&self, name: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    /// Every value of a header, in order. Used where more than one occurrence
    /// is a refusal rather than a list.
    pub fn all(&self, name: &str) -> Vec<&str> {
        self.0
            .iter()
            .filter(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
            .collect()
    }

    /// Every header, in order.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.0
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
    }
}

/// The HTTP version of one request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Version {
    /// HTTP/1.0: the connection always closes after the response.
    Http10,
    /// HTTP/1.1.
    Http11,
}

/// Everything read before the body.
pub(crate) struct Head {
    pub(crate) method: String,
    pub(crate) target: String,
    pub(crate) path: String,
    pub(crate) query: Vec<(String, String)>,
    pub(crate) headers: Headers,
    pub(crate) keep_alive: bool,
    pub(crate) expect_continue: bool,
    pub(crate) framing: Framing,
}

/// Why a request could not be read.
#[derive(Debug)]
pub(crate) enum ParseError {
    /// The connection ended before a request started: no response is owed.
    Closed,
    /// Refuse with this status, then close.
    Status(u16),
    /// The connection failed.
    Io(io::Error),
}

/// Read one request head. The caller has already decided that bytes are
/// available and has set the header timeout on the connection.
pub(crate) fn read_head(reader: &mut ConnReader, limits: &Limits) -> Result<Head, ParseError> {
    let mut line: Vec<u8> = Vec::with_capacity(256);
    let request_line_cap = MAX_REQUEST_LINE.min(limits.max_header_bytes);
    match read_line(reader, &mut line, request_line_cap) {
        Ok(LineEnd::Complete) => {}
        Ok(LineEnd::TooLong) => return Err(ParseError::Status(431)),
        Ok(LineEnd::BareLf) => return Err(ParseError::Status(400)),
        Ok(LineEnd::Eof) => {
            return Err(if line.is_empty() {
                ParseError::Closed
            } else {
                ParseError::Status(400)
            });
        }
        Err(err) => return Err(from_io(err)),
    }
    let mut used = line.len() + 2;
    let (method, target, version) = parse_request_line(&line)?;

    let mut headers: Vec<(String, String)> = Vec::new();
    loop {
        match read_line(reader, &mut line, limits.max_header_bytes) {
            Ok(LineEnd::Complete) => {}
            Ok(LineEnd::TooLong) => return Err(ParseError::Status(431)),
            Ok(LineEnd::BareLf) => return Err(ParseError::Status(400)),
            Ok(LineEnd::Eof) => return Err(ParseError::Status(400)),
            Err(err) => return Err(from_io(err)),
        }
        used += line.len() + 2;
        if used > limits.max_header_bytes {
            return Err(ParseError::Status(431));
        }
        if line.is_empty() {
            break;
        }
        if headers.len() >= MAX_HEADER_COUNT {
            return Err(ParseError::Status(431));
        }
        headers.push(parse_header_line(&line)?);
    }

    let headers = Headers(headers);
    let framing = framing_of(&headers, version)?;
    let keep_alive = version == Version::Http11 && !connection_has_close(&headers);
    let expect_continue = expect_continue(&headers, version)?;
    check_host(&headers, version)?;
    let (path, query) = split_target(&target).map_err(ParseError::Status)?;

    Ok(Head {
        method,
        target,
        path,
        query,
        headers,
        keep_alive,
        expect_continue,
        framing,
    })
}

fn from_io(err: io::Error) -> ParseError {
    if is_timeout(&err) {
        // The connection was accepted and then starved: that is the slowloris
        // shape, and 408 is what it is owed.
        ParseError::Status(408)
    } else {
        ParseError::Io(err)
    }
}

fn parse_request_line(line: &[u8]) -> Result<(String, String, Version), ParseError> {
    let text = match std::str::from_utf8(line) {
        Ok(text) => text,
        Err(_) => return Err(ParseError::Status(400)),
    };
    let mut parts = text.split(' ');
    let (Some(method), Some(target), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(ParseError::Status(400));
    };
    if method.is_empty() || method.len() > MAX_METHOD || !method.bytes().all(is_token_byte) {
        return Err(ParseError::Status(400));
    }
    if target.is_empty()
        || target.len() > MAX_REQUEST_LINE
        || target.bytes().any(|byte| byte < 0x20 || byte == 0x7f)
    {
        return Err(ParseError::Status(400));
    }
    let version = match version {
        "HTTP/1.1" => Version::Http11,
        "HTTP/1.0" => Version::Http10,
        other if other.starts_with("HTTP/") => return Err(ParseError::Status(505)),
        _ => return Err(ParseError::Status(400)),
    };
    Ok((method.to_string(), target.to_string(), version))
}

fn parse_header_line(line: &[u8]) -> Result<(String, String), ParseError> {
    let text = match std::str::from_utf8(line) {
        Ok(text) => text,
        Err(_) => return Err(ParseError::Status(400)),
    };
    let (name, value) = match text.split_once(':') {
        Some(split) => split,
        None => return Err(ParseError::Status(400)),
    };
    // One token check refuses three smuggling levers at once: an empty name,
    // whitespace before the colon (which convinces one proxy that a header is
    // a different one), and obsolete line folding, whose continuation line
    // starts with a space or a tab and so has no token for a name.
    if name.is_empty() || !name.bytes().all(is_token_byte) {
        return Err(ParseError::Status(400));
    }
    let value = value.trim_matches([' ', '\t']);
    if value
        .bytes()
        .any(|byte| (byte < 0x20 && byte != b'\t') || byte == 0x7f)
    {
        return Err(ParseError::Status(400));
    }
    Ok((name.to_string(), value.to_string()))
}

fn framing_of(headers: &Headers, version: Version) -> Result<Framing, ParseError> {
    let lengths = headers.all("content-length");
    let encodings = headers.all("transfer-encoding");
    if lengths.len() > 1 || encodings.len() > 1 {
        return Err(ParseError::Status(400));
    }
    if !encodings.is_empty() {
        if !lengths.is_empty() {
            // Two framings in one request is the classic desync.
            return Err(ParseError::Status(400));
        }
        if version == Version::Http10 {
            return Err(ParseError::Status(400));
        }
        for encoding in &encodings {
            if !encoding.trim().eq_ignore_ascii_case("chunked") {
                return Err(ParseError::Status(501));
            }
        }
        return Ok(Framing::Chunked);
    }
    match lengths.first() {
        None => Ok(Framing::None),
        Some(raw) => match parse_content_length(raw) {
            Some(len) => Ok(Framing::Length(len)),
            None => Err(ParseError::Status(400)),
        },
    }
}

fn parse_content_length(raw: &str) -> Option<u64> {
    if raw.is_empty() || raw.len() > 19 || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    raw.parse::<u64>().ok()
}

fn connection_has_close(headers: &Headers) -> bool {
    headers.all("connection").iter().any(|value| {
        value
            .split(',')
            .any(|token| token.trim().eq_ignore_ascii_case("close"))
    })
}

fn expect_continue(headers: &Headers, version: Version) -> Result<bool, ParseError> {
    match headers.get("expect") {
        None => Ok(false),
        Some(value) if value.eq_ignore_ascii_case("100-continue") => Ok(version == Version::Http11),
        Some(_) => Err(ParseError::Status(417)),
    }
}

fn check_host(headers: &Headers, version: Version) -> Result<(), ParseError> {
    let hosts = headers.all("host").len();
    let ok = match version {
        Version::Http11 => hosts == 1,
        Version::Http10 => hosts <= 1,
    };
    if ok {
        Ok(())
    } else {
        Err(ParseError::Status(400))
    }
}

/// Split a target into a decoded path and decoded query parameters.
///
/// Only origin form is accepted. Absolute form (`http://host/p`), authority
/// form (`host:443`), and `*` are refused: this server is one origin behind a
/// terminator, and accepting a target that names a different one is how a
/// cache is taught to answer for somebody else.
fn split_target(target: &str) -> Result<(String, Vec<(String, String)>), u16> {
    if !target.starts_with('/') {
        return Err(400);
    }
    let (raw_path, raw_query) = match target.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (target, None),
    };
    // The decoded path still starts with `/`: the target did, and `%2F` is
    // refused rather than decoded, so no escape can move the first slash.
    let path = percent_decode(raw_path, true).ok_or(400u16)?;
    if path
        .split('/')
        .any(|segment| segment == "." || segment == "..")
    {
        return Err(400);
    }
    let mut query = Vec::new();
    if let Some(raw) = raw_query {
        for pair in raw.split('&') {
            if pair.is_empty() {
                continue;
            }
            let (name, value) = match pair.split_once('=') {
                Some(split) => split,
                None => (pair, ""),
            };
            query.push((
                percent_decode(name, false).ok_or(400u16)?,
                percent_decode(value, false).ok_or(400u16)?,
            ));
        }
    }
    Ok((path, query))
}

/// Percent-decode one component. `None` means refuse the request.
///
/// One scan over the result refuses every control character, NUL included: a
/// NUL truncates a path for anything downstream that still speaks C, and a CR
/// or LF is what a log-injection or a downstream re-parse needs. In the path,
/// `%2F` is refused rather than decoded, because a decoded slash is either a
/// path separator the caller did not mean or a separator the caller must
/// remember is not one; refusing removes the question. `+` is left alone, so
/// it is a literal plus.
fn percent_decode(text: &str, refuse_encoded_slash: bool) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' => {
                let high = hex_value(*bytes.get(index + 1)?)?;
                let low = hex_value(*bytes.get(index + 2)?)?;
                let decoded = high * 16 + low;
                if refuse_encoded_slash && decoded == b'/' {
                    return None;
                }
                out.push(decoded);
                index += 3;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    let decoded = String::from_utf8(out).ok()?;
    if decoded.bytes().any(|byte| byte < 0x20 || byte == 0x7f) {
        return None;
    }
    Some(decoded)
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::super::BUFFER_BYTES;
    use super::*;
    use std::io::{BufReader, Cursor, Read};

    fn parse(raw: &str) -> Result<Head, ParseError> {
        parse_with(raw, &Limits::default())
    }

    fn parse_with(raw: &str, limits: &Limits) -> Result<Head, ParseError> {
        let mut reader: ConnReader = BufReader::with_capacity(
            BUFFER_BYTES,
            Box::new(Cursor::new(raw.as_bytes().to_vec())) as Box<dyn Read + Send>,
        );
        read_head(&mut reader, limits)
    }

    fn accepted(raw: &str) -> Head {
        match parse(raw) {
            Ok(head) => head,
            Err(err) => panic!("expected accept, refused with {err:?}: {raw:?}"),
        }
    }

    fn status(raw: &str) -> u16 {
        match parse(raw) {
            Ok(head) => panic!("expected refusal, parsed {} {}", head.method, head.target),
            Err(ParseError::Status(status)) => status,
            Err(other) => panic!("expected a status, got {other:?}"),
        }
    }

    const GET: &str = "GET /v1/changes?since=7 HTTP/1.1\r\nHost: h\r\n\r\n";

    #[test]
    fn a_well_formed_request_keeps_its_target_and_decodes_its_parts() {
        let head = accepted(GET);
        assert_eq!(head.method, "GET");
        assert_eq!(head.target, "/v1/changes?since=7");
        assert_eq!(head.path, "/v1/changes");
        assert_eq!(head.query, vec![("since".to_string(), "7".to_string())]);
        assert!(head.keep_alive);
        assert!(!head.expect_continue);
        assert_eq!(head.framing, Framing::None);
        assert_eq!(head.headers.get("host"), Some("h"));
        assert_eq!(head.headers.get("HOST"), Some("h"));
        assert_eq!(head.headers.get("missing"), None);
    }

    #[test]
    fn query_parsing_decodes_but_does_not_treat_plus_as_a_space() {
        let head = accepted("GET /p?a=one+two&b=%20x&flag&c=%2Fslash HTTP/1.1\r\nHost: h\r\n\r\n");
        assert_eq!(head.query[0], ("a".to_string(), "one+two".to_string()));
        assert_eq!(head.query[1], ("b".to_string(), " x".to_string()));
        assert_eq!(head.query[2], ("flag".to_string(), String::new()));
        // A slash is fine inside a query value; only the path refuses it.
        assert_eq!(head.query[3], ("c".to_string(), "/slash".to_string()));
    }

    #[test]
    fn headers_keep_order_and_report_every_occurrence() {
        let head = accepted("GET / HTTP/1.1\r\nHost: h\r\nX-A: 1\r\nX-A: 2\r\nX-B: 3\r\n\r\n");
        assert_eq!(head.headers.all("x-a"), vec!["1", "2"]);
        assert_eq!(head.headers.get("x-a"), Some("1"));
        let names: Vec<&str> = head.headers.iter().map(|(name, _)| name).collect();
        assert_eq!(names, vec!["Host", "X-A", "X-A", "X-B"]);
    }

    #[test]
    fn header_values_are_trimmed_of_optional_whitespace_only() {
        let head = accepted("GET / HTTP/1.1\r\nHost:  h \r\nX-A:\t v\t\r\nX-B:\r\n\r\n");
        assert_eq!(head.headers.get("host"), Some("h"));
        assert_eq!(head.headers.get("x-a"), Some("v"));
        assert_eq!(head.headers.get("x-b"), Some(""));
    }

    #[test]
    fn keep_alive_follows_the_version_and_the_connection_header() {
        assert!(accepted(GET).keep_alive);
        assert!(!accepted("GET / HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n").keep_alive);
        assert!(
            !accepted("GET / HTTP/1.1\r\nHost: h\r\nConnection: keep-alive, close\r\n\r\n")
                .keep_alive
        );
        // HTTP/1.0 always closes, whatever it asks for.
        assert!(!accepted("GET / HTTP/1.0\r\n\r\n").keep_alive);
        assert!(!accepted("GET / HTTP/1.0\r\nConnection: keep-alive\r\n\r\n").keep_alive);
    }

    #[test]
    fn framing_comes_from_content_length_or_chunked() {
        assert_eq!(
            accepted("PUT /c HTTP/1.1\r\nHost: h\r\nContent-Length: 9\r\n\r\n").framing,
            Framing::Length(9)
        );
        assert_eq!(
            accepted("PUT /c HTTP/1.1\r\nHost: h\r\nContent-Length: 0\r\n\r\n").framing,
            Framing::Length(0)
        );
        assert_eq!(
            accepted("PUT /c HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\n").framing,
            Framing::Chunked
        );
        assert_eq!(
            accepted("PUT /c HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: CHUNKED\r\n\r\n").framing,
            Framing::Chunked
        );
    }

    #[test]
    fn expect_continue_is_recognised_and_anything_else_is_refused() {
        let head = accepted(
            "PUT /c HTTP/1.1\r\nHost: h\r\nContent-Length: 2\r\nExpect: 100-continue\r\n\r\n",
        );
        assert!(head.expect_continue);
        // HTTP/1.0 has no 100-continue, so the body just arrives.
        assert!(
            !accepted("PUT /c HTTP/1.0\r\nContent-Length: 2\r\nExpect: 100-continue\r\n\r\n")
                .expect_continue
        );
        assert_eq!(
            status("PUT /c HTTP/1.1\r\nHost: h\r\nExpect: something-else\r\n\r\n"),
            417
        );
    }

    /// The hostile corpus. Each case names the refusal it expects, which is
    /// what AGENTS.md, "Testing doctrine" asks of this parser.
    #[test]
    fn hostile_corpus_names_its_refusal() {
        let cases: &[(&str, &str, u16)] = &[
            (
                "both content-length and transfer-encoding",
                "PUT /c HTTP/1.1\r\nHost: h\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n",
                400,
            ),
            (
                "two content-length headers",
                "PUT /c HTTP/1.1\r\nHost: h\r\nContent-Length: 5\r\nContent-Length: 6\r\n\r\n",
                400,
            ),
            (
                "two transfer-encoding headers",
                "PUT /c HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n\r\n",
                400,
            ),
            (
                "negative content-length",
                "PUT /c HTTP/1.1\r\nHost: h\r\nContent-Length: -1\r\n\r\n",
                400,
            ),
            (
                "hex content-length",
                "PUT /c HTTP/1.1\r\nHost: h\r\nContent-Length: 0x10\r\n\r\n",
                400,
            ),
            (
                "content-length with a plus",
                "PUT /c HTTP/1.1\r\nHost: h\r\nContent-Length: +5\r\n\r\n",
                400,
            ),
            (
                "content-length with an inner space",
                "PUT /c HTTP/1.1\r\nHost: h\r\nContent-Length: 1 2\r\n\r\n",
                400,
            ),
            (
                "empty content-length",
                "PUT /c HTTP/1.1\r\nHost: h\r\nContent-Length:\r\n\r\n",
                400,
            ),
            (
                "content-length past u64",
                "PUT /c HTTP/1.1\r\nHost: h\r\nContent-Length: 99999999999999999999\r\n\r\n",
                400,
            ),
            (
                "unknown transfer-encoding",
                "PUT /c HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: gzip\r\n\r\n",
                501,
            ),
            (
                "chunked after another encoding",
                "PUT /c HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: gzip, chunked\r\n\r\n",
                501,
            ),
            (
                "chunked on HTTP/1.0",
                "PUT /c HTTP/1.0\r\nTransfer-Encoding: chunked\r\n\r\n",
                400,
            ),
            ("missing host on HTTP/1.1", "GET / HTTP/1.1\r\n\r\n", 400),
            (
                "two host headers",
                "GET / HTTP/1.1\r\nHost: a\r\nHost: b\r\n\r\n",
                400,
            ),
            (
                "absolute-form target",
                "GET http://elsewhere/p HTTP/1.1\r\nHost: h\r\n\r\n",
                400,
            ),
            (
                "authority-form target",
                "CONNECT h:443 HTTP/1.1\r\nHost: h\r\n\r\n",
                400,
            ),
            (
                "asterisk-form target",
                "OPTIONS * HTTP/1.1\r\nHost: h\r\n\r\n",
                400,
            ),
            (
                "target not starting with a slash",
                "GET p HTTP/1.1\r\nHost: h\r\n\r\n",
                400,
            ),
            (
                "encoded NUL in the path",
                "GET /a%00b HTTP/1.1\r\nHost: h\r\n\r\n",
                400,
            ),
            ("dot segment", "GET /a/./b HTTP/1.1\r\nHost: h\r\n\r\n", 400),
            (
                "dot dot segment",
                "GET /a/../b HTTP/1.1\r\nHost: h\r\n\r\n",
                400,
            ),
            (
                "trailing dot dot segment",
                "GET /a/.. HTTP/1.1\r\nHost: h\r\n\r\n",
                400,
            ),
            (
                "encoded dot dot segment",
                "GET /a/%2e%2e/b HTTP/1.1\r\nHost: h\r\n\r\n",
                400,
            ),
            (
                "encoded slash in the path",
                "GET /a%2Fb HTTP/1.1\r\nHost: h\r\n\r\n",
                400,
            ),
            (
                "lowercase encoded slash",
                "GET /a%2fb HTTP/1.1\r\nHost: h\r\n\r\n",
                400,
            ),
            (
                "truncated percent escape",
                "GET /a%2 HTTP/1.1\r\nHost: h\r\n\r\n",
                400,
            ),
            (
                "non-hex percent escape",
                "GET /a%zz HTTP/1.1\r\nHost: h\r\n\r\n",
                400,
            ),
            (
                "percent escape that is not utf-8",
                "GET /a%ff HTTP/1.1\r\nHost: h\r\n\r\n",
                400,
            ),
            (
                "encoded control character",
                "GET /a%0Ab HTTP/1.1\r\nHost: h\r\n\r\n",
                400,
            ),
            (
                "bad escape in the query",
                "GET /a?b=%zz HTTP/1.1\r\nHost: h\r\n\r\n",
                400,
            ),
            (
                "two spaces in the request line",
                "GET  / HTTP/1.1\r\nHost: h\r\n\r\n",
                400,
            ),
            ("no version", "GET /\r\nHost: h\r\n\r\n", 400),
            ("unknown version", "GET / HTTP/2.0\r\nHost: h\r\n\r\n", 505),
            (
                "unknown minor version",
                "GET / HTTP/1.2\r\nHost: h\r\n\r\n",
                505,
            ),
            ("garbage version", "GET / SPDY/1\r\nHost: h\r\n\r\n", 400),
            (
                "method with a space",
                "GE T / HTTP/1.1\r\nHost: h\r\n\r\n",
                400,
            ),
            (
                "method with a separator",
                "GET() / HTTP/1.1\r\nHost: h\r\n\r\n",
                400,
            ),
            (
                "bare LF request line",
                "GET / HTTP/1.1\nHost: h\r\n\r\n",
                400,
            ),
            (
                "bare LF header line",
                "GET / HTTP/1.1\r\nHost: h\n\r\n",
                400,
            ),
            (
                "obsolete line folding",
                "GET / HTTP/1.1\r\nHost: h\r\nX-A: one\r\n two\r\n\r\n",
                400,
            ),
            (
                "space before the colon",
                "GET / HTTP/1.1\r\nHost : h\r\n\r\n",
                400,
            ),
            (
                "empty header name",
                "GET / HTTP/1.1\r\nHost: h\r\n: v\r\n\r\n",
                400,
            ),
            (
                "header without a colon",
                "GET / HTTP/1.1\r\nHost: h\r\nX-A\r\n\r\n",
                400,
            ),
            (
                "header name with a separator",
                "GET / HTTP/1.1\r\nHost: h\r\nX A: v\r\n\r\n",
                400,
            ),
            ("truncated head", "GET / HTTP/1.1\r\nHost: h\r\n", 400),
            ("truncated request line", "GET / HTTP/1.1", 400),
        ];
        for (name, raw, expected) in cases {
            assert_eq!(status(raw), *expected, "{name}");
        }
        assert_eq!(cases.len(), 46, "hostile corpus size changed");
    }

    #[test]
    fn an_empty_connection_is_a_close_not_a_refusal() {
        assert!(matches!(parse(""), Err(ParseError::Closed)));
    }

    #[test]
    fn an_oversize_request_line_is_refused_at_431() {
        let raw = format!("GET /{} HTTP/1.1\r\nHost: h\r\n\r\n", "a".repeat(9000));
        assert_eq!(status(&raw), 431);
    }

    #[test]
    fn an_oversize_header_block_is_refused_at_431() {
        let mut raw = String::from("GET / HTTP/1.1\r\nHost: h\r\n");
        for index in 0..40 {
            raw.push_str(&format!("X-Pad-{index}: {}\r\n", "a".repeat(500)));
        }
        raw.push_str("\r\n");
        assert_eq!(status(&raw), 431);
        // One header just under the whole budget is still accepted.
        let fits = format!(
            "GET / HTTP/1.1\r\nHost: h\r\nX-Pad: {}\r\n\r\n",
            "a".repeat(15000)
        );
        assert!(parse(&fits).is_ok());
    }

    #[test]
    fn too_many_headers_are_refused_at_431() {
        let mut raw = String::from("GET / HTTP/1.1\r\nHost: h\r\n");
        for index in 0..200 {
            raw.push_str(&format!("X-{index}: v\r\n"));
        }
        raw.push_str("\r\n");
        let limits = Limits {
            max_header_bytes: 1024 * 1024,
            ..Limits::default()
        };
        assert!(matches!(
            parse_with(&raw, &limits),
            Err(ParseError::Status(431))
        ));
    }

    #[test]
    fn a_smaller_header_budget_is_honoured() {
        let limits = Limits {
            max_header_bytes: 64,
            ..Limits::default()
        };
        let raw = format!(
            "GET / HTTP/1.1\r\nHost: h\r\nX-A: {}\r\n\r\n",
            "a".repeat(200)
        );
        assert!(matches!(
            parse_with(&raw, &limits),
            Err(ParseError::Status(431))
        ));
    }

    #[test]
    fn pipelined_requests_are_read_one_at_a_time() {
        let raw = "GET /one HTTP/1.1\r\nHost: h\r\n\r\nGET /two HTTP/1.1\r\nHost: h\r\n\r\n";
        let mut reader: ConnReader = BufReader::with_capacity(
            BUFFER_BYTES,
            Box::new(Cursor::new(raw.as_bytes().to_vec())) as Box<dyn Read + Send>,
        );
        let limits = Limits::default();
        let first = read_head(&mut reader, &limits).expect("first");
        assert_eq!(first.path, "/one");
        let second = read_head(&mut reader, &limits).expect("second");
        assert_eq!(second.path, "/two");
        assert!(matches!(
            read_head(&mut reader, &limits),
            Err(ParseError::Closed)
        ));
    }

    #[test]
    fn a_read_timeout_becomes_408() {
        struct Stalled;
        impl Read for Stalled {
            fn read(&mut self, _out: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::new(io::ErrorKind::WouldBlock, "stalled"))
            }
        }
        let mut reader: ConnReader =
            BufReader::with_capacity(BUFFER_BYTES, Box::new(Stalled) as Box<dyn Read + Send>);
        assert!(matches!(
            read_head(&mut reader, &Limits::default()),
            Err(ParseError::Status(408))
        ));
    }

    #[test]
    fn query_param_reads_the_first_occurrence() {
        let head = accepted("GET /p?a=1&a=2&b=3 HTTP/1.1\r\nHost: h\r\n\r\n");
        let request = Request {
            method: head.method,
            target: head.target,
            path: head.path,
            query: head.query,
            headers: head.headers,
            body: Body::empty(),
            peer: "127.0.0.1:1".parse().expect("addr"),
        };
        assert_eq!(request.query_param("a"), Some("1"));
        assert_eq!(request.query_param("b"), Some("3"));
        assert_eq!(request.query_param("c"), None);
    }

    #[test]
    fn headers_can_be_built_by_hand_for_a_handler_test() {
        let headers = Headers::from_pairs(vec![("X-A".to_string(), "1".to_string())]);
        assert_eq!(headers.get("x-a"), Some("1"));
        assert_eq!(headers.all("x-a"), vec!["1"]);
        assert_eq!(headers.iter().count(), 1);
    }
}
