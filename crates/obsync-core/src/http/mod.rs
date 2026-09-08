//! A small HTTP/1.1 server, standard library only.
//!
//! Implemented: request parsing for HTTP/1.1 and HTTP/1.0 in origin form,
//! keep-alive including pipelining, `Content-Length` and `chunked` request
//! bodies, `Expect: 100-continue`, a single `Range` on a response, streamed
//! response bodies, `multipart/mixed` response bodies, and the per-connection
//! limits in [`Limits`] (header size, header timeout, idle timeout, minimum
//! body rate, connection count), with a graceful drain on shutdown.
//!
//! Deliberately absent, and not oversights:
//!
//! - **TLS.** The server speaks plain HTTP and is always deployed behind a
//!   terminator (AGENTS.md requirement 7). No TLS is implemented or linked.
//! - **HTTP/2 and HTTP/3.** One connection is one thread, and the terminator
//!   speaks whatever the client wants on the far side.
//! - **Request trailers.** Read to end the chunked framing, then dropped.
//! - **Multiple byte ranges.** A multi-range request is refused rather than
//!   answered with a partial implementation.
//! - **Chunked responses.** Every response carries a `Content-Length`, which a
//!   streamed body must therefore know in advance.
//! - **`Date`.** Framing here has no clock dependency; a terminator that wants
//!   the header adds it.
//! - **Absolute-form and authority-form targets, `*`, obsolete line folding,
//!   and bare LF line endings.** Each is a request-smuggling lever and each is
//!   refused with 400.
//!
//! Nothing in this module can be switched off: every limit is a value in
//! [`Limits`] with a floor of behaviour, never a boolean (AGENTS.md
//! requirement 4).
//!
//! Panic isolation in [`Server::serve`] uses `catch_unwind`, which needs an
//! unwinding panic strategy; under `panic = "abort"` a handler panic ends the
//! process instead of the connection.

mod body;
mod limits;
mod multipart;
mod range;
mod request;
mod response;
mod server;

pub use body::Body;
pub use limits::Limits;
pub use multipart::MultipartWriter;
pub use range::{RangeError, parse_range};
pub use request::{Headers, Request};
pub use response::{Response, ResponseBody};
pub use server::{Handler, Server};

use std::io::{self, BufRead, BufReader, Read};

/// The buffered read half of one connection. Boxing the reader keeps
/// [`Request`] free of a type parameter, which every handler would otherwise
/// have to name.
pub(crate) type ConnReader = BufReader<Box<dyn Read + Send>>;

/// Size of every connection read buffer and copy buffer.
pub(crate) const BUFFER_BYTES: usize = 8192;

/// How a line read ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LineEnd {
    /// A full CRLF-terminated line is in the buffer, without its CRLF.
    Complete,
    /// The line passed `cap` bytes before its CRLF.
    TooLong,
    /// LF arrived without the CR before it.
    BareLf,
    /// The connection ended. `Complete` is never reported for a partial line.
    Eof,
}

/// Read one CRLF-terminated line into `out`. `cap` is the most content the
/// line may carry, so at most `cap + 1` bytes are ever buffered: an overlong
/// line is refused instead of being read to its end. The CRLF is consumed and
/// not stored.
pub(crate) fn read_line(
    reader: &mut ConnReader,
    out: &mut Vec<u8>,
    cap: usize,
) -> io::Result<LineEnd> {
    out.clear();
    loop {
        let available = match reader.fill_buf() {
            Ok(available) => available,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(err),
        };
        if available.is_empty() {
            return Ok(LineEnd::Eof);
        }
        match available.iter().position(|&byte| byte == b'\n') {
            Some(index) => {
                if out.len() + index > cap + 1 {
                    return Ok(LineEnd::TooLong);
                }
                out.extend_from_slice(&available[..index]);
                reader.consume(index + 1);
                if out.last() != Some(&b'\r') {
                    return Ok(LineEnd::BareLf);
                }
                // The check above counted the CR, so content longer than
                // `cap` has already been refused.
                out.pop();
                return Ok(LineEnd::Complete);
            }
            None => {
                let taken = available.len();
                if out.len() + taken > cap + 1 {
                    return Ok(LineEnd::TooLong);
                }
                out.extend_from_slice(available);
                reader.consume(taken);
            }
        }
    }
}

/// Whether an error is a socket read or write timeout. The platform reports
/// one of two kinds depending on whether the socket is in blocking mode.
pub(crate) fn is_timeout(err: &io::Error) -> bool {
    matches!(
        err.kind(),
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn reader(bytes: &[u8]) -> ConnReader {
        BufReader::with_capacity(BUFFER_BYTES, Box::new(Cursor::new(bytes.to_vec())))
    }

    #[test]
    fn read_line_splits_on_crlf_and_keeps_the_rest() {
        let mut reader = reader(b"one\r\ntwo\r\n\r\n");
        let mut line = Vec::new();
        assert_eq!(
            read_line(&mut reader, &mut line, 64).ok(),
            Some(LineEnd::Complete)
        );
        assert_eq!(line, b"one");
        assert_eq!(
            read_line(&mut reader, &mut line, 64).ok(),
            Some(LineEnd::Complete)
        );
        assert_eq!(line, b"two");
        assert_eq!(
            read_line(&mut reader, &mut line, 64).ok(),
            Some(LineEnd::Complete)
        );
        assert!(line.is_empty());
        assert_eq!(
            read_line(&mut reader, &mut line, 64).ok(),
            Some(LineEnd::Eof)
        );
    }

    #[test]
    fn read_line_reports_a_bare_lf_and_an_overlong_line() {
        let mut line = Vec::new();
        assert_eq!(
            read_line(&mut reader(b"one\ntwo\r\n"), &mut line, 64).ok(),
            Some(LineEnd::BareLf)
        );
        assert_eq!(
            read_line(&mut reader(b"0123456789\r\n"), &mut line, 4).ok(),
            Some(LineEnd::TooLong)
        );
        // A line that ends exactly at the cap is still complete.
        assert_eq!(
            read_line(&mut reader(b"0123\r\n"), &mut line, 4).ok(),
            Some(LineEnd::Complete)
        );
    }

    #[test]
    fn read_line_reports_eof_on_an_unterminated_line() {
        let mut line = Vec::new();
        assert_eq!(
            read_line(&mut reader(b"partial"), &mut line, 64).ok(),
            Some(LineEnd::Eof)
        );
    }
}
