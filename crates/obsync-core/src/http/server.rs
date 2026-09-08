//! The listener and the per-connection loop.
//!
//! One connection is one thread. That is the shape the protocol asks for: the
//! change feed long-polls for up to 55 seconds, so connections are mostly idle
//! and `max_connections` (256 by default) bounds both threads and memory.

use std::io::{self, BufRead, BufReader, BufWriter, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use super::body::Body;
use super::request::{ParseError, Request, read_head};
use super::response::{Response, write_response};
use super::{BUFFER_BYTES, ConnReader, Limits, is_timeout};

/// What the server calls for every request. The handler may read the body and
/// must return a response; a panic inside it costs the connection, not the
/// process.
pub type Handler = Arc<dyn Fn(&mut Request) -> Response + Send + Sync + 'static>;

/// Where the server reports what it could not put into a response. Library
/// code writes nothing to stderr; the caller decides what logging means
/// (AGENTS.md requirement 12).
type ErrorSink = Arc<dyn Fn(&str) + Send + Sync>;

/// How often the accept loop looks at the shutdown flag.
const ACCEPT_POLL: Duration = Duration::from_millis(50);

/// How often a connection waiting for its next request looks at it.
const IDLE_POLL: Duration = Duration::from_millis(100);

/// How much of an unread request body is drained before the connection is
/// closed instead. A handler that refuses a body early should not have to read
/// a chunk upload to keep the connection.
const MAX_DRAIN_BYTES: u64 = 1024 * 1024;

/// A bound listener.
pub struct Server {
    listener: TcpListener,
    addr: SocketAddr,
    limits: Limits,
    sink: ErrorSink,
}

impl Server {
    /// Bind a listener. Nothing is served until [`Server::serve`] is called.
    pub fn bind(addr: &str, limits: Limits) -> io::Result<Server> {
        let listener = TcpListener::bind(addr)?;
        let addr = listener.local_addr()?;
        Ok(Server {
            listener,
            addr,
            limits,
            sink: Arc::new(|_message: &str| {}),
        })
    }

    /// The address actually bound, which is how a caller learns the port after
    /// binding to port 0.
    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    /// Supply a sink for failures that never reach a client: a connection that
    /// dies mid-response, a handler panic, an accept error.
    pub fn set_error_sink(&mut self, sink: Arc<dyn Fn(&str) + Send + Sync>) {
        self.sink = sink;
    }

    /// Serve until `shutdown` is set, then stop accepting, wait up to
    /// `drain_timeout` for connections in flight, and return. Blocks the
    /// calling thread.
    pub fn serve(self, handler: Handler, shutdown: Arc<AtomicBool>, drain_timeout: Duration) {
        let Server {
            listener,
            limits,
            sink,
            ..
        } = self;
        if let Err(err) = listener.set_nonblocking(true) {
            (*sink)(&format!("http: listener would not poll: {err}"));
            return;
        }
        let active = Arc::new(AtomicUsize::new(0));
        while !shutdown.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((stream, peer)) => {
                    if let Err(err) = stream.set_nonblocking(false) {
                        (*sink)(&format!("http: connection stayed non-blocking: {err}"));
                        continue;
                    }
                    let guard = ActiveGuard::new(&active);
                    if active.load(Ordering::SeqCst) > limits.max_connections {
                        drop(guard);
                        refuse_overload(stream, &sink);
                        continue;
                    }
                    let handler = Arc::clone(&handler);
                    let limits = limits.clone();
                    let thread_sink = Arc::clone(&sink);
                    let thread_shutdown = Arc::clone(&shutdown);
                    let spawned = thread::Builder::new()
                        .name("obsync-http".to_string())
                        .spawn(move || {
                            let _guard = guard;
                            serve_connection(
                                stream,
                                peer,
                                &handler,
                                &limits,
                                &thread_sink,
                                &thread_shutdown,
                            );
                        });
                    if let Err(err) = spawned {
                        (*sink)(&format!("http: no thread for a connection: {err}"));
                    }
                }
                Err(err) if err.kind() == io::ErrorKind::WouldBlock => thread::sleep(ACCEPT_POLL),
                Err(err) if err.kind() == io::ErrorKind::Interrupted => {}
                Err(err) => {
                    (*sink)(&format!("http: accept failed: {err}"));
                    thread::sleep(ACCEPT_POLL);
                }
            }
        }
        let deadline = Instant::now() + drain_timeout;
        while active.load(Ordering::SeqCst) > 0 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
    }
}

/// Holds one connection slot for as long as the connection lives, including
/// through a panic on its thread.
struct ActiveGuard {
    active: Arc<AtomicUsize>,
}

impl ActiveGuard {
    fn new(active: &Arc<AtomicUsize>) -> ActiveGuard {
        active.fetch_add(1, Ordering::SeqCst);
        ActiveGuard {
            active: Arc::clone(active),
        }
    }
}

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::SeqCst);
    }
}

fn refuse_overload(stream: TcpStream, sink: &ErrorSink) {
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let mut writer = BufWriter::with_capacity(128, stream);
    let refusal = Response::empty(503).header("Retry-After", "1");
    if let Err(err) = write_response(&mut writer, refusal, false, true) {
        (*sink)(&format!("http: could not refuse a connection: {err}"));
    }
}

/// What happened while waiting for the next request on a connection.
enum Await {
    /// Bytes are available.
    Ready,
    /// Nothing arrived before the deadline.
    Idle,
    /// The peer closed cleanly.
    Closed,
    /// The server is shutting down.
    Stopping,
    /// The connection failed.
    Failed(io::Error),
}

fn serve_connection(
    control: TcpStream,
    peer: SocketAddr,
    handler: &Handler,
    limits: &Limits,
    sink: &ErrorSink,
    shutdown: &AtomicBool,
) {
    let (read_half, write_half, body_half) = match (
        control.try_clone(),
        control.try_clone(),
        control.try_clone(),
    ) {
        (Ok(read_half), Ok(write_half), Ok(body_half)) => (read_half, write_half, body_half),
        _ => {
            (*sink)("http: could not split a connection");
            return;
        }
    };
    let body_socket = Arc::new(body_half);
    let mut reader: ConnReader =
        BufReader::with_capacity(BUFFER_BYTES, Box::new(read_half) as Box<dyn Read + Send>);
    let mut writer = BufWriter::with_capacity(BUFFER_BYTES, write_half);
    let mut first = true;

    loop {
        let wait = if first {
            limits.header_timeout
        } else {
            limits.idle_timeout
        };
        match await_request(&mut reader, &control, wait, shutdown) {
            Await::Ready => {}
            Await::Idle => {
                // A connection that never sent its head is the slowloris
                // shape and is told so; an idle keep-alive is just closed.
                if first {
                    let _ = write_response(&mut writer, Response::empty(408), false, true);
                }
                return;
            }
            Await::Closed | Await::Stopping => return,
            Await::Failed(err) => {
                if !is_timeout(&err) {
                    (*sink)(&format!("http: connection failed while idle: {err}"));
                }
                return;
            }
        }
        first = false;
        if control
            .set_read_timeout(Some(limits.header_timeout))
            .is_err()
        {
            return;
        }

        let head = match read_head(&mut reader, limits) {
            Ok(head) => head,
            Err(ParseError::Closed) => return,
            Err(ParseError::Status(status)) => {
                let _ = write_response(&mut writer, Response::empty(status), false, true);
                return;
            }
            Err(ParseError::Io(err)) => {
                (*sink)(&format!("http: could not read a request: {err}"));
                return;
            }
        };

        if head.expect_continue && writer.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").is_err() {
            return;
        }
        if head.expect_continue && writer.flush().is_err() {
            return;
        }

        let keep_alive = head.keep_alive;
        let socket = Arc::clone(&body_socket);
        let placeholder: ConnReader =
            BufReader::with_capacity(1, Box::new(io::empty()) as Box<dyn Read + Send>);
        let body = Body::from_connection(
            std::mem::replace(&mut reader, placeholder),
            head.framing,
            limits.min_body_rate_bytes_per_sec,
            Box::new(move |timeout| socket.set_read_timeout(Some(timeout))),
        );
        let mut request = Request {
            method: head.method,
            target: head.target,
            path: head.path,
            query: head.query,
            headers: head.headers,
            body,
            peer,
        };

        let outcome = catch_unwind(AssertUnwindSafe(|| handler(&mut request)));
        let (response, panicked) = match outcome {
            Ok(response) => (response, false),
            Err(_) => {
                (*sink)("http: handler panicked; answering 500 and closing the connection");
                (Response::empty(500), true)
            }
        };

        // A body the handler did not read has to come off the wire before the
        // connection can carry another request.
        let drained = if panicked {
            false
        } else {
            drain_body(&mut request.body).unwrap_or(false)
        };
        let head_only = request.method.eq_ignore_ascii_case("HEAD");
        let recovered = request.body.take_reader();
        let close =
            panicked || !drained || !keep_alive || response.wants_close() || recovered.is_none();

        if let Err(err) = write_response(&mut writer, response, head_only, close) {
            if !is_timeout(&err) && err.kind() != io::ErrorKind::BrokenPipe {
                (*sink)(&format!("http: could not write a response: {err}"));
            }
            return;
        }
        match recovered {
            Some(connection) if !close => reader = connection,
            _ => return,
        }
    }
}

fn await_request(
    reader: &mut ConnReader,
    control: &TcpStream,
    wait: Duration,
    shutdown: &AtomicBool,
) -> Await {
    let deadline = Instant::now() + wait;
    loop {
        if shutdown.load(Ordering::Relaxed) {
            return Await::Stopping;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Await::Idle;
        }
        let slice = remaining.min(IDLE_POLL).max(Duration::from_millis(1));
        if let Err(err) = control.set_read_timeout(Some(slice)) {
            return Await::Failed(err);
        }
        match reader.fill_buf() {
            Ok([]) => return Await::Closed,
            Ok(_) => return Await::Ready,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => {}
            Err(err) if is_timeout(&err) => {}
            Err(err) => return Await::Failed(err),
        }
    }
}

/// Read what the handler left, up to [`MAX_DRAIN_BYTES`]. `Ok(false)` means
/// the connection cannot be reused.
fn drain_body(body: &mut Body) -> io::Result<bool> {
    if body.is_complete() {
        return Ok(true);
    }
    let mut buffer = [0u8; BUFFER_BYTES];
    let mut total = 0u64;
    loop {
        let count = body.read(&mut buffer)?;
        if count == 0 {
            return Ok(true);
        }
        total += count as u64;
        if total > MAX_DRAIN_BYTES {
            return Ok(false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::{MultipartWriter, RangeError, ResponseBody, parse_range};
    use crate::json::{Value, obj};
    use std::io::Cursor;
    use std::thread::JoinHandle;

    /// A server on a loopback port, stopped and joined when it drops.
    struct TestServer {
        addr: SocketAddr,
        shutdown: Arc<AtomicBool>,
        join: Option<JoinHandle<()>>,
    }

    impl TestServer {
        fn start(limits: Limits, handler: Handler) -> TestServer {
            let server = Server::bind("127.0.0.1:0", limits).expect("bind");
            let addr = server.local_addr();
            let shutdown = Arc::new(AtomicBool::new(false));
            let serve_shutdown = Arc::clone(&shutdown);
            let join = thread::spawn(move || {
                server.serve(handler, serve_shutdown, Duration::from_secs(2));
            });
            TestServer {
                addr,
                shutdown,
                join: Some(join),
            }
        }

        fn connect(&self) -> TcpStream {
            let stream = TcpStream::connect(self.addr).expect("connect");
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .expect("client read timeout");
            stream
        }

        fn stop(&mut self) {
            self.shutdown.store(true, Ordering::SeqCst);
            if let Some(join) = self.join.take() {
                let _ = join.join();
            }
        }
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            self.stop();
        }
    }

    fn handler_of<F>(function: F) -> Handler
    where
        F: Fn(&mut Request) -> Response + Send + Sync + 'static,
    {
        Arc::new(function)
    }

    /// Read one response: the head, then exactly `Content-Length` bytes.
    fn read_response(reader: &mut BufReader<TcpStream>) -> (String, Vec<u8>) {
        let mut head = String::new();
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).expect("read head line") == 0 {
                break;
            }
            let done = line == "\r\n";
            head.push_str(&line);
            if done {
                break;
            }
        }
        let length = head
            .lines()
            .find_map(|line| line.strip_prefix("Content-Length: "))
            .and_then(|value| value.trim().parse::<usize>().ok())
            .unwrap_or(0);
        let mut body = vec![0u8; length];
        if length > 0 {
            reader.read_exact(&mut body).expect("read body");
        }
        (head, body)
    }

    fn status_of(head: &str) -> u16 {
        head.split(' ')
            .nth(1)
            .and_then(|code| code.parse::<u16>().ok())
            .unwrap_or(0)
    }

    fn echo_handler() -> Handler {
        handler_of(
            |request: &mut Request| match request.body.read_to_vec(16 * 1024 * 1024) {
                Ok(bytes) => Response::bytes(200, "application/octet-stream", bytes),
                Err(_) => Response::text(400, "body"),
            },
        )
    }

    #[test]
    fn an_echo_handler_answers_over_a_real_socket() {
        let server = TestServer::start(Limits::default(), echo_handler());
        let stream = server.connect();
        let mut reader = BufReader::new(stream.try_clone().expect("clone"));
        (&stream)
            .write_all(b"POST /echo HTTP/1.1\r\nHost: h\r\nContent-Length: 5\r\n\r\nhello")
            .expect("write");
        let (head, body) = read_response(&mut reader);
        assert_eq!(status_of(&head), 200);
        assert_eq!(body, b"hello");
        assert!(!head.contains("Connection: close"));
        assert!(!head.contains("Date:"));
    }

    #[test]
    fn keep_alive_carries_two_pipelined_requests() {
        let server = TestServer::start(Limits::default(), echo_handler());
        let stream = server.connect();
        let mut reader = BufReader::new(stream.try_clone().expect("clone"));
        (&stream)
            .write_all(
                b"POST /a HTTP/1.1\r\nHost: h\r\nContent-Length: 3\r\n\r\none\
                  POST /b HTTP/1.1\r\nHost: h\r\nContent-Length: 3\r\n\r\ntwo",
            )
            .expect("write");
        let (first_head, first_body) = read_response(&mut reader);
        assert_eq!(status_of(&first_head), 200);
        assert_eq!(first_body, b"one");
        let (second_head, second_body) = read_response(&mut reader);
        assert_eq!(status_of(&second_head), 200);
        assert_eq!(second_body, b"two");
    }

    #[test]
    fn http_1_0_is_answered_and_closed() {
        let server = TestServer::start(Limits::default(), echo_handler());
        let stream = server.connect();
        let mut reader = BufReader::new(stream.try_clone().expect("clone"));
        (&stream)
            .write_all(b"GET /x HTTP/1.0\r\n\r\n")
            .expect("write");
        let (head, _) = read_response(&mut reader);
        assert_eq!(status_of(&head), 200);
        assert!(head.contains("Connection: close\r\n"));
        let mut rest = Vec::new();
        reader.read_to_end(&mut rest).expect("read to close");
        assert!(rest.is_empty(), "the server kept the connection open");
    }

    #[test]
    fn head_carries_the_headers_without_the_body() {
        let server = TestServer::start(
            Limits::default(),
            handler_of(|_request: &mut Request| Response::text(200, "0123456789")),
        );
        let stream = server.connect();
        let mut reader = BufReader::new(stream.try_clone().expect("clone"));
        (&stream)
            .write_all(b"HEAD /x HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n")
            .expect("write");
        let mut all = Vec::new();
        reader.read_to_end(&mut all).expect("read");
        let text = String::from_utf8(all).expect("utf-8");
        assert!(text.contains("Content-Length: 10\r\n"));
        assert!(text.ends_with("\r\n\r\n"), "a HEAD response carried a body");
    }

    #[test]
    fn expect_100_continue_is_answered_before_the_body() {
        let server = TestServer::start(Limits::default(), echo_handler());
        let stream = server.connect();
        let mut reader = BufReader::new(stream.try_clone().expect("clone"));
        (&stream)
            .write_all(
                b"POST /x HTTP/1.1\r\nHost: h\r\nContent-Length: 4\r\nExpect: 100-continue\r\n\r\n",
            )
            .expect("write headers");
        let (interim, _) = read_response(&mut reader);
        assert_eq!(status_of(&interim), 100);
        (&stream).write_all(b"body").expect("write body");
        let (head, body) = read_response(&mut reader);
        assert_eq!(status_of(&head), 200);
        assert_eq!(body, b"body");
    }

    #[test]
    fn a_nine_mebibyte_upload_streams_through() {
        let server = TestServer::start(
            Limits::default(),
            handler_of(|request: &mut Request| {
                let mut total = 0u64;
                let mut buffer = [0u8; 8192];
                loop {
                    match request.body.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(count) => total += count as u64,
                        Err(_) => return Response::text(400, "read"),
                    }
                }
                Response::json(200, &obj(vec![("bytes", Value::from(total))]))
            }),
        );
        let payload = vec![b'x'; 9 * 1024 * 1024];
        let stream = server.connect();
        let mut reader = BufReader::new(stream.try_clone().expect("clone"));
        let mut writer = stream.try_clone().expect("clone");
        let sender = thread::spawn(move || {
            writer
                .write_all(
                    format!(
                        "PUT /c HTTP/1.1\r\nHost: h\r\nContent-Length: {}\r\n\r\n",
                        payload.len()
                    )
                    .as_bytes(),
                )
                .expect("write head");
            writer.write_all(&payload).expect("write body");
        });
        let (head, body) = read_response(&mut reader);
        sender.join().expect("sender");
        assert_eq!(status_of(&head), 200);
        assert_eq!(body, b"{\"bytes\":9437184}");
    }

    #[test]
    fn a_chunked_upload_is_reassembled() {
        let server = TestServer::start(Limits::default(), echo_handler());
        let stream = server.connect();
        let mut reader = BufReader::new(stream.try_clone().expect("clone"));
        (&stream)
            .write_all(
                b"PUT /c HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\n\
                  4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n",
            )
            .expect("write");
        let (head, body) = read_response(&mut reader);
        assert_eq!(status_of(&head), 200);
        assert_eq!(body, b"Wikipedia");
    }

    #[test]
    fn a_range_request_streams_part_of_a_resource() {
        let server = TestServer::start(
            Limits::default(),
            handler_of(|request: &mut Request| {
                let payload: Vec<u8> = (0u8..=255).collect();
                let total = payload.len() as u64;
                let range = match request.headers.get("range") {
                    None => None,
                    Some(header) => match parse_range(header, total) {
                        Ok(range) => range,
                        Err(RangeError::Unsatisfiable) => {
                            return Response::empty(416)
                                .header("Content-Range", &format!("bytes */{total}"));
                        }
                        Err(_) => return Response::empty(400),
                    },
                };
                match range {
                    None => Response::bytes(200, "application/octet-stream", payload),
                    Some((first, last)) => {
                        let slice = payload[first as usize..=last as usize].to_vec();
                        let len = slice.len() as u64;
                        Response::stream(
                            206,
                            "application/octet-stream",
                            Box::new(Cursor::new(slice)),
                            len,
                        )
                        .header("Content-Range", &format!("bytes {first}-{last}/{total}"))
                    }
                }
            }),
        );
        let stream = server.connect();
        let mut reader = BufReader::new(stream.try_clone().expect("clone"));
        (&stream)
            .write_all(b"GET /c HTTP/1.1\r\nHost: h\r\nRange: bytes=10-19\r\n\r\n")
            .expect("write");
        let (head, body) = read_response(&mut reader);
        assert_eq!(status_of(&head), 206);
        assert!(head.contains("Content-Range: bytes 10-19/256\r\n"));
        assert_eq!(body, (10u8..=19).collect::<Vec<u8>>());

        (&stream)
            .write_all(b"GET /c HTTP/1.1\r\nHost: h\r\nRange: bytes=999-\r\n\r\n")
            .expect("write");
        let (head, _) = read_response(&mut reader);
        assert_eq!(status_of(&head), 416);
    }

    #[test]
    fn a_multipart_response_frames_every_part() {
        let server = TestServer::start(
            Limits::default(),
            handler_of(|_request: &mut Request| {
                let mut multipart = MultipartWriter::new("obsync-chunks");
                multipart.part(&[("X-Obsync-Sid", "aa"), ("Content-Length", "2")], b"hi");
                multipart.part(&[("X-Obsync-Sid", "bb"), ("X-Obsync-Missing", "1")], b"");
                let content_type = multipart.content_type();
                Response::bytes(200, &content_type, multipart.finish())
            }),
        );
        let stream = server.connect();
        let mut reader = BufReader::new(stream.try_clone().expect("clone"));
        (&stream)
            .write_all(b"POST /v1/chunks/get HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n")
            .expect("write");
        let (head, body) = read_response(&mut reader);
        assert_eq!(status_of(&head), 200);
        assert!(head.contains("Content-Type: multipart/mixed; boundary=obsync-chunks\r\n"));
        let body = String::from_utf8(body).expect("utf-8");
        assert!(body.starts_with("--obsync-chunks\r\nX-Obsync-Sid: aa\r\n"));
        assert!(body.contains("X-Obsync-Missing: 1\r\n"));
        assert!(body.ends_with("--obsync-chunks--\r\n"));
    }

    #[test]
    fn the_connection_ceiling_refuses_with_503_and_a_retry_after() {
        let limits = Limits {
            max_connections: 2,
            idle_timeout: Duration::from_secs(5),
            header_timeout: Duration::from_secs(5),
            ..Limits::default()
        };
        let server = TestServer::start(limits, echo_handler());
        // Two connections that have answered once and are now idle keep-alive.
        let mut held = Vec::new();
        for _ in 0..2 {
            let stream = server.connect();
            let mut reader = BufReader::new(stream.try_clone().expect("clone"));
            (&stream)
                .write_all(b"GET /x HTTP/1.1\r\nHost: h\r\n\r\n")
                .expect("write");
            assert_eq!(status_of(&read_response(&mut reader).0), 200);
            held.push((stream, reader));
        }
        let third = server.connect();
        let mut reader = BufReader::new(third.try_clone().expect("clone"));
        (&third)
            .write_all(b"GET /x HTTP/1.1\r\nHost: h\r\n\r\n")
            .expect("write");
        let (head, _) = read_response(&mut reader);
        assert_eq!(status_of(&head), 503);
        assert!(head.contains("Retry-After: 1\r\n"));
        assert!(head.contains("Connection: close\r\n"));
        // The held connections still work, so the ceiling refused rather than
        // broke.
        let (stream, reader) = &mut held[0];
        (&*stream)
            .write_all(b"GET /y HTTP/1.1\r\nHost: h\r\n\r\n")
            .expect("write");
        assert_eq!(status_of(&read_response(reader).0), 200);
    }

    #[test]
    fn a_slow_header_block_is_refused_with_408() {
        let limits = Limits {
            header_timeout: Duration::from_millis(250),
            ..Limits::default()
        };
        let server = TestServer::start(limits, echo_handler());

        // Nothing at all.
        let silent = server.connect();
        let mut reader = BufReader::new(silent.try_clone().expect("clone"));
        let started = Instant::now();
        let (head, _) = read_response(&mut reader);
        assert_eq!(status_of(&head), 408);
        assert!(started.elapsed() < Duration::from_secs(3));

        // A head that starts and then stalls.
        let dribbling = server.connect();
        let mut reader = BufReader::new(dribbling.try_clone().expect("clone"));
        (&dribbling).write_all(b"GET / HTT").expect("write");
        let (head, _) = read_response(&mut reader);
        assert_eq!(status_of(&head), 408);
    }

    #[test]
    fn a_body_slower_than_the_floor_fails_the_read() {
        let limits = Limits {
            min_body_rate_bytes_per_sec: 1024 * 1024,
            ..Limits::default()
        };
        let server = TestServer::start(
            limits,
            handler_of(
                |request: &mut Request| match request.body.read_to_vec(1 << 20) {
                    Ok(bytes) => Response::text(200, &format!("{}", bytes.len())),
                    Err(err) if err.kind() == io::ErrorKind::TimedOut => {
                        Response::text(408, "slow")
                    }
                    Err(_) => Response::text(400, "body"),
                },
            ),
        );
        let stream = server.connect();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .expect("timeout");
        let mut reader = BufReader::new(stream.try_clone().expect("clone"));
        (&stream)
            .write_all(b"PUT /c HTTP/1.1\r\nHost: h\r\nContent-Length: 100000\r\n\r\nten bytes!")
            .expect("write");
        let started = Instant::now();
        let (head, _) = read_response(&mut reader);
        assert_eq!(status_of(&head), 408);
        // The grace period is a second; anything near the idle timeout would
        // mean the floor never engaged.
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the rate floor took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn shutdown_finishes_a_response_already_in_flight() {
        let server_handler = handler_of(|_request: &mut Request| {
            thread::sleep(Duration::from_millis(400));
            Response::text(200, "finished")
        });
        let mut server = TestServer::start(Limits::default(), server_handler);
        let stream = server.connect();
        let mut reader = BufReader::new(stream.try_clone().expect("clone"));
        (&stream)
            .write_all(b"GET /slow HTTP/1.1\r\nHost: h\r\n\r\n")
            .expect("write");
        thread::sleep(Duration::from_millis(100));
        let started = Instant::now();
        server.stop();
        let (head, body) = read_response(&mut reader);
        assert_eq!(status_of(&head), 200);
        assert_eq!(body, b"finished");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "the drain waited too long"
        );
    }

    #[test]
    fn a_handler_panic_costs_the_connection_and_not_the_process() {
        let reported: Arc<std::sync::Mutex<Vec<String>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorder = Arc::clone(&reported);
        let mut server_instance = Server::bind(
            "127.0.0.1:0",
            Limits {
                idle_timeout: Duration::from_secs(2),
                ..Limits::default()
            },
        )
        .expect("bind");
        server_instance.set_error_sink(Arc::new(move |message: &str| {
            if let Ok(mut log) = recorder.lock() {
                log.push(message.to_string());
            }
        }));
        let addr = server_instance.local_addr();
        let shutdown = Arc::new(AtomicBool::new(false));
        let serve_shutdown = Arc::clone(&shutdown);
        let join = thread::spawn(move || {
            server_instance.serve(
                handler_of(|request: &mut Request| {
                    if request.path == "/panic" {
                        panic!("sentinel panic");
                    }
                    Response::text(200, "alive")
                }),
                serve_shutdown,
                Duration::from_secs(2),
            );
        });

        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_info| {}));
        let stream = TcpStream::connect(addr).expect("connect");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("timeout");
        let mut reader = BufReader::new(stream.try_clone().expect("clone"));
        (&stream)
            .write_all(b"GET /panic HTTP/1.1\r\nHost: h\r\n\r\n")
            .expect("write");
        let (head, _) = read_response(&mut reader);
        std::panic::set_hook(previous);
        assert_eq!(status_of(&head), 500);
        assert!(head.contains("Connection: close\r\n"));

        // The listener is still serving.
        let next = TcpStream::connect(addr).expect("reconnect");
        next.set_read_timeout(Some(Duration::from_secs(5)))
            .expect("timeout");
        let mut reader = BufReader::new(next.try_clone().expect("clone"));
        (&next)
            .write_all(b"GET /fine HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n")
            .expect("write");
        let (head, body) = read_response(&mut reader);
        assert_eq!(status_of(&head), 200);
        assert_eq!(body, b"alive");

        shutdown.store(true, Ordering::SeqCst);
        let _ = join.join();
        let log = reported.lock().expect("lock");
        assert!(
            log.iter().any(|message| message.contains("panicked")),
            "the panic was never reported to the sink"
        );
    }

    #[test]
    fn a_refused_request_gets_its_status_and_the_connection_closes() {
        let server = TestServer::start(Limits::default(), echo_handler());
        for (raw, expected) in [
            (&b"GET / HTTP/1.1\r\n\r\n"[..], 400u16),
            (
                &b"PUT / HTTP/1.1\r\nHost: h\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n"[..],
                400,
            ),
            (
                &b"PUT / HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: gzip\r\n\r\n"[..],
                501,
            ),
            (&b"GET /a/../b HTTP/1.1\r\nHost: h\r\n\r\n"[..], 400),
            (&b"GET / HTTP/3.0\r\nHost: h\r\n\r\n"[..], 505),
        ] {
            let stream = server.connect();
            let mut reader = BufReader::new(stream.try_clone().expect("clone"));
            (&stream).write_all(raw).expect("write");
            let (head, _) = read_response(&mut reader);
            assert_eq!(status_of(&head), expected, "for {raw:?}");
            assert!(head.contains("Connection: close\r\n"));
            let mut rest = Vec::new();
            reader.read_to_end(&mut rest).expect("read to close");
            assert!(rest.is_empty());
        }
    }

    #[test]
    fn a_body_the_handler_ignored_is_drained_so_the_connection_survives() {
        let server = TestServer::start(
            Limits::default(),
            handler_of(|_request: &mut Request| Response::text(200, "ignored")),
        );
        let stream = server.connect();
        let mut reader = BufReader::new(stream.try_clone().expect("clone"));
        (&stream)
            .write_all(b"POST /a HTTP/1.1\r\nHost: h\r\nContent-Length: 5\r\n\r\nfirst")
            .expect("write");
        let (head, _) = read_response(&mut reader);
        assert_eq!(status_of(&head), 200);
        assert!(!head.contains("Connection: close"));
        // The next request lands on the same connection, which proves the
        // first body came off the wire.
        (&stream)
            .write_all(b"POST /b HTTP/1.1\r\nHost: h\r\nContent-Length: 6\r\n\r\nsecond")
            .expect("write");
        let (head, body) = read_response(&mut reader);
        assert_eq!(status_of(&head), 200);
        assert_eq!(body, b"ignored");
    }

    #[test]
    fn an_unread_body_over_the_drain_ceiling_closes_the_connection() {
        let server = TestServer::start(
            Limits::default(),
            handler_of(|_request: &mut Request| Response::text(413, "too big")),
        );
        let payload = vec![b'x'; (MAX_DRAIN_BYTES + 1024) as usize];
        let stream = server.connect();
        let mut reader = BufReader::new(stream.try_clone().expect("clone"));
        let mut writer = stream.try_clone().expect("clone");
        let sender = thread::spawn(move || {
            let _ = writer.write_all(
                format!(
                    "PUT /c HTTP/1.1\r\nHost: h\r\nContent-Length: {}\r\n\r\n",
                    payload.len()
                )
                .as_bytes(),
            );
            let _ = writer.write_all(&payload);
        });
        let (head, _) = read_response(&mut reader);
        let _ = sender.join();
        assert_eq!(status_of(&head), 413);
        assert!(head.contains("Connection: close\r\n"));
    }

    #[test]
    fn a_stream_response_body_reaches_the_client_whole() {
        let server = TestServer::start(
            Limits::default(),
            handler_of(|_request: &mut Request| {
                let payload = vec![b'z'; 300 * 1024];
                let len = payload.len() as u64;
                Response::stream(
                    200,
                    "application/octet-stream",
                    Box::new(Cursor::new(payload)),
                    len,
                )
            }),
        );
        let stream = server.connect();
        let mut reader = BufReader::new(stream.try_clone().expect("clone"));
        (&stream)
            .write_all(b"GET /c HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n")
            .expect("write");
        let (head, body) = read_response(&mut reader);
        assert_eq!(status_of(&head), 200);
        assert_eq!(body.len(), 300 * 1024);
        assert!(body.iter().all(|byte| *byte == b'z'));
    }

    #[test]
    fn the_response_body_variants_report_their_length() {
        assert_eq!(Response::empty(204).content_length(), 0);
        assert_eq!(Response::text(200, "abc").content_length(), 3);
        let streamed = Response::stream(
            200,
            "application/octet-stream",
            Box::new(Cursor::new(Vec::new())),
            42,
        );
        assert_eq!(streamed.content_length(), 42);
        assert!(matches!(
            streamed.body,
            ResponseBody::Stream { len: 42, .. }
        ));
    }

    #[test]
    fn the_active_guard_releases_its_slot_even_on_a_panic() {
        let active = Arc::new(AtomicUsize::new(0));
        {
            let _guard = ActiveGuard::new(&active);
            assert_eq!(active.load(Ordering::SeqCst), 1);
        }
        assert_eq!(active.load(Ordering::SeqCst), 0);
        let counter = Arc::clone(&active);
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_info| {}));
        let result = catch_unwind(AssertUnwindSafe(|| {
            let _guard = ActiveGuard::new(&counter);
            panic!("sentinel");
        }));
        std::panic::set_hook(previous);
        assert!(result.is_err());
        assert_eq!(active.load(Ordering::SeqCst), 0);
    }
}
