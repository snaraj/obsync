//! The request body: framing, the size the client declared, and the rate floor
//! that stops a connection from being held open for free.

use std::io::{self, BufReader, Cursor, Read};
use std::time::{Duration, Instant};

use super::{BUFFER_BYTES, ConnReader, LineEnd, is_timeout, read_line};

/// How the client framed the body.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Framing {
    /// No body: neither `Content-Length` nor `Transfer-Encoding`.
    None,
    /// Exactly this many bytes.
    Length(u64),
    /// `Transfer-Encoding: chunked`.
    Chunked,
}

/// Applies a read timeout to the connection under this body.
pub(crate) type TimeoutSetter = Box<dyn Fn(Duration) -> io::Result<()> + Send>;

/// Burst the rate floor tolerates before it starts to bind. Without it a
/// healthy connection with one slow round trip would be cut off; with it the
/// floor still holds over any window longer than a second.
const RATE_GRACE: Duration = Duration::from_secs(1);

/// Longest chunk-size line accepted. A chunk size is at most sixteen hex
/// digits; the rest of the budget is for one short extension.
const MAX_CHUNK_LINE: usize = 64;

/// Longest trailer section accepted before the connection is refused.
const MAX_TRAILER_BYTES: usize = 8192;

/// The body of one request, streamed from the connection.
///
/// Reading enforces three things: a `Content-Length` body is exactly that
/// long, a chunked body is well formed, and either arrives no slower than
/// `min_body_rate_bytes_per_sec` (`docs/protocol.md`, "Limits and headers").
/// The rate is enforced as an allowance: at any moment the body may have taken
/// `bytes / rate` seconds plus one second of burst, which is the same floor as
/// a per-8-KiB deadline without cutting off a connection that stalls once.
pub struct Body {
    reader: Option<ConnReader>,
    framing: Framing,
    remaining: u64,
    chunk_remaining: u64,
    finished: bool,
    started: Instant,
    read_total: u64,
    min_rate: u64,
    set_timeout: Option<TimeoutSetter>,
    line: Vec<u8>,
}

impl Body {
    /// A body with nothing in it, for a request that carried none and for
    /// tests of handlers that do not read one.
    pub fn empty() -> Body {
        Body::new(None, Framing::None, 0, None)
    }

    /// A body already in memory, for testing a handler without a socket.
    pub fn from_bytes(bytes: Vec<u8>) -> Body {
        let len = bytes.len() as u64;
        let reader = BufReader::with_capacity(BUFFER_BYTES, boxed(bytes));
        Body::new(Some(reader), Framing::Length(len), 0, None)
    }

    pub(crate) fn from_connection(
        reader: ConnReader,
        framing: Framing,
        min_rate: u64,
        set_timeout: TimeoutSetter,
    ) -> Body {
        Body::new(Some(reader), framing, min_rate, Some(set_timeout))
    }

    fn new(
        reader: Option<ConnReader>,
        framing: Framing,
        min_rate: u64,
        set_timeout: Option<TimeoutSetter>,
    ) -> Body {
        Body {
            reader,
            framing,
            remaining: match framing {
                Framing::Length(len) => len,
                _ => 0,
            },
            chunk_remaining: 0,
            finished: false,
            started: Instant::now(),
            read_total: 0,
            min_rate,
            set_timeout,
            line: Vec::new(),
        }
    }

    /// The length the client declared, or `None` for a chunked body whose
    /// length is not known until it ends. A request with no body declares 0.
    pub fn declared_len(&self) -> Option<u64> {
        match self.framing {
            Framing::None => Some(0),
            Framing::Length(len) => Some(len),
            Framing::Chunked => None,
        }
    }

    /// Whether the body is chunked.
    pub fn is_chunked(&self) -> bool {
        self.framing == Framing::Chunked
    }

    /// Read the whole body, refusing anything longer than `max`. A declared
    /// length over `max` is refused before a byte is read.
    pub fn read_to_vec(&mut self, max: usize) -> io::Result<Vec<u8>> {
        if let Some(len) = self.declared_len()
            && len > max as u64
        {
            return Err(too_large());
        }
        let mut out = Vec::new();
        let mut buffer = [0u8; BUFFER_BYTES];
        loop {
            let count = self.read(&mut buffer)?;
            if count == 0 {
                return Ok(out);
            }
            if out.len() + count > max {
                return Err(too_large());
            }
            out.extend_from_slice(&buffer[..count]);
        }
    }

    /// Whether the whole body has been consumed.
    pub(crate) fn is_complete(&self) -> bool {
        match self.framing {
            Framing::None => true,
            Framing::Length(_) => self.remaining == 0,
            Framing::Chunked => self.finished,
        }
    }

    /// Take the connection back so the next request on it can be read.
    pub(crate) fn take_reader(&mut self) -> Option<ConnReader> {
        self.reader.take()
    }

    /// How long the body is allowed to have taken by now.
    fn allowance(&self) -> Duration {
        Duration::from_secs_f64(self.read_total as f64 / self.min_rate as f64) + RATE_GRACE
    }

    /// Bound the next blocking read by what is left of the allowance, so a
    /// sender that stops entirely fails on the rate floor rather than on the
    /// idle timeout.
    fn arm_deadline(&mut self) -> io::Result<()> {
        if self.min_rate == 0 {
            return Ok(());
        }
        let allowance = self.allowance();
        let elapsed = self.started.elapsed();
        if elapsed >= allowance {
            return Err(too_slow());
        }
        if let Some(set_timeout) = &self.set_timeout {
            set_timeout((allowance - elapsed).max(Duration::from_millis(1)))?;
        }
        Ok(())
    }

    fn check_rate(&self) -> io::Result<()> {
        if self.min_rate == 0 || self.started.elapsed() <= self.allowance() {
            return Ok(());
        }
        Err(too_slow())
    }

    fn timed_read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() || self.reader.is_none() {
            return Ok(0);
        }
        self.arm_deadline()?;
        let count = {
            let reader = match self.reader.as_mut() {
                Some(reader) => reader,
                None => return Ok(0),
            };
            loop {
                match reader.read(out) {
                    Ok(count) => break count,
                    Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
                    Err(err) if is_timeout(&err) => return Err(too_slow()),
                    Err(err) => return Err(err),
                }
            }
        };
        self.read_total += count as u64;
        self.check_rate()?;
        Ok(count)
    }

    fn read_line_from_body(&mut self, cap: usize) -> io::Result<LineEnd> {
        self.arm_deadline()?;
        let mut line = std::mem::take(&mut self.line);
        let outcome = match self.reader.as_mut() {
            Some(reader) => read_line(reader, &mut line, cap),
            None => Ok(LineEnd::Eof),
        };
        self.line = line;
        match outcome {
            Ok(end) => Ok(end),
            Err(err) if is_timeout(&err) => Err(too_slow()),
            Err(err) => Err(err),
        }
    }

    fn read_length(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.remaining == 0 {
            return Ok(0);
        }
        let want = (out.len() as u64).min(self.remaining) as usize;
        let count = self.timed_read(&mut out[..want])?;
        if count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "body shorter than its Content-Length",
            ));
        }
        self.remaining -= count as u64;
        Ok(count)
    }

    fn read_chunked(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.finished {
            return Ok(0);
        }
        if self.chunk_remaining == 0 {
            let size = self.next_chunk_size()?;
            if size == 0 {
                self.skip_trailers()?;
                self.finished = true;
                return Ok(0);
            }
            self.chunk_remaining = size;
        }
        let want = (out.len() as u64).min(self.chunk_remaining) as usize;
        let count = self.timed_read(&mut out[..want])?;
        if count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "chunked body ended inside a chunk",
            ));
        }
        self.chunk_remaining -= count as u64;
        if self.chunk_remaining == 0 {
            self.expect_empty_line()?;
        }
        Ok(count)
    }

    fn next_chunk_size(&mut self) -> io::Result<u64> {
        // Every chunk after the first is preceded by the CRLF that ended the
        // one before it, which `read_chunked` has already consumed.
        match self.read_line_from_body(MAX_CHUNK_LINE)? {
            LineEnd::Complete => parse_chunk_size(&self.line),
            LineEnd::TooLong => Err(bad_chunk("chunk size line too long")),
            LineEnd::BareLf => Err(bad_chunk("chunk size line without CRLF")),
            LineEnd::Eof => Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "chunked body ended before its last chunk",
            )),
        }
    }

    fn expect_empty_line(&mut self) -> io::Result<()> {
        match self.read_line_from_body(MAX_CHUNK_LINE)? {
            LineEnd::Complete if self.line.is_empty() => Ok(()),
            LineEnd::Eof => Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "chunked body ended after a chunk",
            )),
            _ => Err(bad_chunk("chunk not followed by CRLF")),
        }
    }

    fn skip_trailers(&mut self) -> io::Result<()> {
        let mut used = 0usize;
        loop {
            match self.read_line_from_body(MAX_TRAILER_BYTES)? {
                LineEnd::Complete if self.line.is_empty() => return Ok(()),
                LineEnd::Complete => {
                    used += self.line.len() + 2;
                    if used > MAX_TRAILER_BYTES {
                        return Err(bad_chunk("trailer section too long"));
                    }
                }
                LineEnd::TooLong => return Err(bad_chunk("trailer line too long")),
                LineEnd::BareLf => return Err(bad_chunk("trailer line without CRLF")),
                // A sender that closes right after the last chunk has still
                // delivered the whole body.
                LineEnd::Eof => return Ok(()),
            }
        }
    }
}

impl Read for Body {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        match self.framing {
            Framing::None => Ok(0),
            Framing::Length(_) => self.read_length(out),
            Framing::Chunked => self.read_chunked(out),
        }
    }
}

fn boxed(bytes: Vec<u8>) -> Box<dyn Read + Send> {
    Box::new(Cursor::new(bytes))
}

fn parse_chunk_size(line: &[u8]) -> io::Result<u64> {
    let digits = match line.iter().position(|&byte| byte == b';') {
        Some(index) => &line[..index],
        None => line,
    };
    if digits.is_empty() || digits.len() > 16 {
        return Err(bad_chunk("chunk size is not one to sixteen hex digits"));
    }
    let mut size = 0u64;
    for byte in digits {
        let digit = match byte {
            b'0'..=b'9' => byte - b'0',
            b'a'..=b'f' => byte - b'a' + 10,
            b'A'..=b'F' => byte - b'A' + 10,
            _ => return Err(bad_chunk("chunk size is not hexadecimal")),
        };
        size = size * 16 + u64::from(digit);
    }
    Ok(size)
}

fn bad_chunk(detail: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, detail)
}

fn too_large() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "body larger than allowed")
}

fn too_slow() -> io::Error {
    io::Error::new(
        io::ErrorKind::TimedOut,
        "body slower than the minimum read rate",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection(bytes: &[u8], framing: Framing) -> Body {
        let reader = BufReader::with_capacity(BUFFER_BYTES, boxed(bytes.to_vec()));
        Body::new(Some(reader), framing, 0, None)
    }

    fn read_all(body: &mut Body) -> io::Result<Vec<u8>> {
        let mut out = Vec::new();
        body.read_to_end(&mut out)?;
        Ok(out)
    }

    #[test]
    fn an_empty_body_reads_nothing_and_is_already_complete() {
        let mut body = Body::empty();
        assert_eq!(body.declared_len(), Some(0));
        assert!(!body.is_chunked());
        assert!(body.is_complete());
        assert_eq!(read_all(&mut body).ok(), Some(Vec::new()));
    }

    #[test]
    fn a_length_body_reads_exactly_its_declaration() {
        let mut body = connection(b"hello world", Framing::Length(5));
        assert_eq!(body.declared_len(), Some(5));
        assert!(!body.is_complete());
        assert_eq!(read_all(&mut body).ok(), Some(b"hello".to_vec()));
        assert!(body.is_complete());
    }

    #[test]
    fn a_short_length_body_fails_rather_than_returning_less() {
        let mut body = connection(b"hi", Framing::Length(8));
        assert_eq!(
            read_all(&mut body).map_err(|err| err.kind()),
            Err(io::ErrorKind::UnexpectedEof)
        );
    }

    #[test]
    fn from_bytes_gives_a_body_a_handler_test_can_use() {
        let mut body = Body::from_bytes(b"payload".to_vec());
        assert_eq!(body.declared_len(), Some(7));
        assert_eq!(body.read_to_vec(64).ok(), Some(b"payload".to_vec()));
    }

    #[test]
    fn read_to_vec_refuses_a_declared_length_over_the_cap_without_reading() {
        let mut body = connection(b"0123456789", Framing::Length(10));
        assert_eq!(
            body.read_to_vec(4).map_err(|err| err.kind()),
            Err(io::ErrorKind::InvalidData)
        );
        // Nothing was read, so the refusal costs one comparison.
        assert_eq!(body.remaining, 10);
    }

    #[test]
    fn read_to_vec_refuses_a_chunked_body_that_grows_past_the_cap() {
        let mut body = connection(b"4\r\nabcd\r\n4\r\nefgh\r\n0\r\n\r\n", Framing::Chunked);
        assert_eq!(body.declared_len(), None);
        assert!(body.is_chunked());
        assert_eq!(
            body.read_to_vec(5).map_err(|err| err.kind()),
            Err(io::ErrorKind::InvalidData)
        );
    }

    #[test]
    fn a_chunked_body_reassembles_its_chunks() {
        let mut body = connection(b"4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n", Framing::Chunked);
        assert_eq!(read_all(&mut body).ok(), Some(b"Wikipedia".to_vec()));
        assert!(body.is_complete());
    }

    #[test]
    fn chunk_extensions_and_uppercase_hex_are_accepted() {
        let mut body = connection(b"A;name=value\r\n0123456789\r\n0\r\n\r\n", Framing::Chunked);
        assert_eq!(read_all(&mut body).ok(), Some(b"0123456789".to_vec()));
    }

    #[test]
    fn trailers_after_the_last_chunk_are_read_and_dropped() {
        let mut body = connection(b"2\r\nok\r\n0\r\nX-Trailer: v\r\n\r\n", Framing::Chunked);
        assert_eq!(read_all(&mut body).ok(), Some(b"ok".to_vec()));
        assert!(body.is_complete());
    }

    #[test]
    fn a_bad_chunk_size_is_refused() {
        for hostile in [
            &b"zz\r\nab\r\n0\r\n\r\n"[..],
            &b"-1\r\nab\r\n0\r\n\r\n"[..],
            &b"0x2\r\nab\r\n0\r\n\r\n"[..],
            &b"\r\nab\r\n"[..],
            &b"11111111111111111\r\nab\r\n"[..],
        ] {
            let mut body = connection(hostile, Framing::Chunked);
            assert_eq!(
                read_all(&mut body).map_err(|err| err.kind()),
                Err(io::ErrorKind::InvalidData),
                "accepted a bad chunk size: {hostile:?}"
            );
        }
    }

    #[test]
    fn an_overlong_chunk_size_line_is_refused_before_it_is_buffered() {
        let mut line = b"4;".to_vec();
        line.extend(std::iter::repeat_n(b'x', 4096));
        line.extend_from_slice(b"\r\nabcd\r\n0\r\n\r\n");
        let mut body = connection(&line, Framing::Chunked);
        assert_eq!(
            read_all(&mut body).map_err(|err| err.kind()),
            Err(io::ErrorKind::InvalidData)
        );
    }

    #[test]
    fn a_chunk_not_followed_by_crlf_is_refused() {
        // The separator line here is well formed but not empty, so accepting
        // it would parse a whole body rather than fail on the next size line.
        let mut body = connection(b"2\r\nokXX\r\n0\r\n\r\n", Framing::Chunked);
        assert_eq!(
            read_all(&mut body).map_err(|err| err.kind()),
            Err(io::ErrorKind::InvalidData)
        );
    }

    #[test]
    fn a_truncated_chunked_body_is_refused() {
        let mut body = connection(b"8\r\nshort", Framing::Chunked);
        assert_eq!(
            read_all(&mut body).map_err(|err| err.kind()),
            Err(io::ErrorKind::UnexpectedEof)
        );
    }

    #[test]
    fn the_rate_floor_binds_once_the_allowance_runs_out() {
        let mut body = connection(b"0123456789", Framing::Length(10));
        body.min_rate = 1024 * 1024;
        // Nothing read yet, so the allowance is the grace period alone.
        body.started = Instant::now() - Duration::from_millis(500);
        assert!(body.check_rate().is_ok());
        body.started = Instant::now() - Duration::from_millis(1500);
        assert_eq!(
            body.check_rate().map_err(|err| err.kind()),
            Err(io::ErrorKind::TimedOut)
        );
        // Bytes bought time: 1 MiB at 1 MiB/s is a second on top of the grace.
        body.read_total = 1024 * 1024;
        assert!(body.check_rate().is_ok());
    }

    #[test]
    fn arming_the_deadline_reports_the_time_left_and_then_refuses() {
        let seen: std::sync::Arc<std::sync::Mutex<Vec<Duration>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorder = seen.clone();
        let reader = BufReader::with_capacity(BUFFER_BYTES, boxed(b"data".to_vec()));
        let mut body = Body::from_connection(
            reader,
            Framing::Length(4),
            1024,
            Box::new(move |timeout| {
                if let Ok(mut log) = recorder.lock() {
                    log.push(timeout);
                }
                Ok(())
            }),
        );
        assert_eq!(read_all(&mut body).ok(), Some(b"data".to_vec()));
        let log = seen.lock().expect("lock");
        assert!(!log.is_empty(), "the deadline was never armed");
        assert!(log.iter().all(|timeout| *timeout <= RATE_GRACE));
        assert!(log.iter().all(|timeout| *timeout > Duration::ZERO));
    }

    #[test]
    fn a_read_timeout_from_the_socket_is_reported_as_a_rate_failure() {
        struct Stalled;
        impl Read for Stalled {
            fn read(&mut self, _out: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::new(io::ErrorKind::WouldBlock, "stalled"))
            }
        }
        let reader =
            BufReader::with_capacity(BUFFER_BYTES, Box::new(Stalled) as Box<dyn Read + Send>);
        let mut body = Body::new(Some(reader), Framing::Length(8), 1024, None);
        assert_eq!(
            read_all(&mut body).map_err(|err| err.kind()),
            Err(io::ErrorKind::TimedOut)
        );
    }
}
