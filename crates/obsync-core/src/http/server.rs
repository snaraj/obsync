//! The listener and the per-connection loop.
//!
//! One connection is one thread. That is the shape the protocol asks for: the
//! change feed long-polls for up to 55 seconds, so connections are mostly idle
//! and `max_connections` (256 by default) bounds both threads and memory.

use std::io::{self, BufRead, BufReader, BufWriter, Read, Write};
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream};
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
type ErrorSink = Arc<dyn Fn(Report) + Send + Sync>;

/// One thing the server could not put into a response. Words, a status and
/// an I/O kind only: never an error's message, which can carry an address.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Report {
    /// What happened, a fixed word: `parser_refusal` and `header_timeout`
    /// for a request refused before any handler ran, `peer_closed` for a
    /// peer that closed or reset its connection, and a word per failure of
    /// the server's own (`accept_failed`, `handler_panic`, ...).
    pub decision: &'static str,
    /// The status the refusal was answered with, when there was one.
    pub status: Option<u16>,
    /// The I/O kind behind it, when there was one.
    pub io: Option<io::ErrorKind>,
}

impl Report {
    fn new(decision: &'static str) -> Report {
        Report {
            decision,
            status: None,
            io: None,
        }
    }

    fn io(decision: &'static str, err: &io::Error) -> Report {
        Report {
            io: Some(err.kind()),
            ..Report::new(decision)
        }
    }

    /// A failure on an open connection: the peer ending it is `peer_closed`,
    /// anything else keeps `decision`. A proxy resets idle keep-alives as a
    /// matter of course, and a client can leave at any moment (#212).
    fn connection(decision: &'static str, err: &io::Error) -> Report {
        let closed = matches!(
            err.kind(),
            io::ErrorKind::ConnectionReset
                | io::ErrorKind::ConnectionAborted
                | io::ErrorKind::BrokenPipe
                | io::ErrorKind::NotConnected
        );
        Report::io(if closed { "peer_closed" } else { decision }, err)
    }

    /// Whether this is an ordinary end of a connection rather than a
    /// refusal or a failure: the caller logs it at debug, if at all.
    pub fn ordinary(&self) -> bool {
        self.decision == "peer_closed"
    }
}

/// How often the shutdown waker looks at the flag. The accept itself blocks,
/// so this bounds how long a stop takes to begin, never how long a new
/// connection waits.
const SHUTDOWN_POLL: Duration = Duration::from_millis(100);

/// How long the accept loop pauses after a failed accept (a full descriptor
/// table, say), so the failure is not retried in a hot loop.
const ACCEPT_BACKOFF: Duration = Duration::from_millis(50);

/// How often a connection waiting for its next request looks at the shutdown
/// flag. Bytes arriving wake the wait at once; this only bounds how long an
/// idle keep-alive takes to notice a stop.
const IDLE_POLL: Duration = Duration::from_secs(1);

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
            sink: Arc::new(|_report: Report| {}),
        })
    }

    /// The address actually bound, which is how a caller learns the port after
    /// binding to port 0.
    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    /// Supply a sink for failures that never reach a client: a connection that
    /// dies mid-response, a handler panic, an accept error.
    pub fn set_error_sink(&mut self, sink: Arc<dyn Fn(Report) + Send + Sync>) {
        self.sink = sink;
    }

    /// Serve until `shutdown` is set, then stop accepting, wait up to
    /// `drain_timeout` for connections in flight, and return. Blocks the
    /// calling thread.
    ///
    /// The accept BLOCKS, so a connection is taken the moment it arrives
    /// rather than at the next look at a flag. What wakes it for a stop is a
    /// connection to itself, which [`wake_on_shutdown`] makes once the flag
    /// is set.
    pub fn serve(self, handler: Handler, shutdown: Arc<AtomicBool>, drain_timeout: Duration) {
        let Server {
            listener,
            addr,
            limits,
            sink,
        } = self;
        let stopped = Arc::new(AtomicBool::new(false));
        let waker = wake_on_shutdown(addr, Arc::clone(&shutdown), Arc::clone(&stopped));
        if let Err(err) = &waker {
            (*sink)(Report::io("no_waker_thread", err));
        }
        let active = Arc::new(AtomicUsize::new(0));
        while !shutdown.load(Ordering::Relaxed) {
            match listener.accept() {
                // The waker's own connection, or one that raced the stop.
                Ok(_) if shutdown.load(Ordering::Relaxed) => break,
                Ok((stream, peer)) => {
                    // Responses leave in more than one write (a head, then a
                    // streamed body), and Nagle would hold the last one back
                    // for the peer's delayed acknowledgement.
                    if let Err(err) = stream.set_nodelay(true) {
                        (*sink)(Report::io("nodelay_failed", &err));
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
                        (*sink)(Report::io("no_connection_thread", &err));
                    }
                }
                Err(err) if err.kind() == io::ErrorKind::Interrupted => {}
                Err(err) => {
                    (*sink)(Report::io("accept_failed", &err));
                    thread::sleep(ACCEPT_BACKOFF);
                }
            }
        }
        stopped.store(true, Ordering::SeqCst);
        if let Ok(waker) = waker {
            let _ = waker.join();
        }
        let deadline = Instant::now() + drain_timeout;
        while active.load(Ordering::SeqCst) > 0 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
    }
}

/// Once `shutdown` is set, connect to the listener until the accept loop
/// says it has `stopped`: a blocked accept returns only for a connection.
/// Retried rather than tried once, because one lost connect would leave the
/// process unable to stop.
fn wake_on_shutdown(
    addr: SocketAddr,
    shutdown: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
) -> io::Result<thread::JoinHandle<()>> {
    let mut target = addr;
    if target.ip().is_unspecified() {
        target.set_ip(match addr {
            SocketAddr::V4(_) => Ipv4Addr::LOCALHOST.into(),
            SocketAddr::V6(_) => Ipv6Addr::LOCALHOST.into(),
        });
    }
    thread::Builder::new()
        .name("obsync-http-waker".to_string())
        .spawn(move || {
            while !stopped.load(Ordering::SeqCst) {
                if shutdown.load(Ordering::Relaxed) {
                    let _ = TcpStream::connect_timeout(&target, SHUTDOWN_POLL);
                }
                thread::sleep(SHUTDOWN_POLL);
            }
        })
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
        (*sink)(Report::connection("overload_unanswered", &err));
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
            (*sink)(Report::new("split_failed"));
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
                    (*sink)(Report {
                        status: Some(408),
                        ..Report::new("header_timeout")
                    });
                    let _ = write_response(&mut writer, Response::empty(408), false, true);
                }
                return;
            }
            Await::Closed | Await::Stopping => return,
            // Where a proxy resetting an idle keep-alive lands: an ordinary
            // close, not a refusal (#212).
            Await::Failed(err) => {
                if !is_timeout(&err) {
                    (*sink)(Report::connection("connection_failed", &err));
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
            // The one refusal the handler never sees, so the one the server
            // itself must report (requirement 12).
            Err(ParseError::Status(status)) => {
                (*sink)(Report {
                    status: Some(status),
                    ..Report::new("parser_refusal")
                });
                let _ = write_response(&mut writer, Response::empty(status), false, true);
                return;
            }
            Err(ParseError::Io(err)) => {
                (*sink)(Report::connection("connection_failed", &err));
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
            proved: std::cell::Cell::new(false),
        };

        let outcome = catch_unwind(AssertUnwindSafe(|| handler(&mut request)));
        let (response, panicked) = match outcome {
            Ok(response) => (response, false),
            Err(_) => {
                (*sink)(Report {
                    status: Some(500),
                    ..Report::new("handler_panic")
                });
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

        // A streamed body that cannot keep its length lands here too, with
        // the kind that broke it.
        if let Err(err) = write_response(&mut writer, response, head_only, close) {
            if !is_timeout(&err) {
                (*sink)(Report::connection("write_failed", &err));
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

    /// Every report a server sends its sink, in order.
    type Reports = Arc<std::sync::Mutex<Vec<Report>>>;

    impl TestServer {
        fn start(limits: Limits, handler: Handler) -> TestServer {
            TestServer::recorded(limits, handler).0
        }

        /// A server whose sink records every report.
        fn recorded(limits: Limits, handler: Handler) -> (TestServer, Reports) {
            let reports: Reports = Arc::new(std::sync::Mutex::new(Vec::new()));
            let recorder = Arc::clone(&reports);
            let mut server = Server::bind("127.0.0.1:0", limits).expect("bind");
            server.set_error_sink(Arc::new(move |report: Report| {
                recorder.lock().expect("reports").push(report);
            }));
            let addr = server.local_addr();
            let shutdown = Arc::new(AtomicBool::new(false));
            let serve_shutdown = Arc::clone(&shutdown);
            let join = thread::spawn(move || {
                server.serve(handler, serve_shutdown, Duration::from_secs(2));
            });
            let server = TestServer {
                addr,
                shutdown,
                join: Some(join),
            };
            (server, reports)
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

    /// A new connection is taken when it arrives, not at the next look at a
    /// flag. Twenty back-to-back connections behind a 50 ms accept poll wait
    /// about a second in all; blocking, they take a few milliseconds, so the
    /// ceiling below has room for a loaded machine and none for a poll.
    #[test]
    fn a_new_connection_is_accepted_without_waiting_for_a_poll() {
        let server = TestServer::start(
            Limits::default(),
            handler_of(|_request: &mut Request| Response::text(200, "ok")),
        );
        let started = Instant::now();
        for _ in 0..20 {
            let stream = server.connect();
            let mut reader = BufReader::new(stream.try_clone().expect("clone"));
            (&stream)
                .write_all(b"GET /x HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n")
                .expect("write");
            assert_eq!(status_of(&read_response(&mut reader).0), 200);
        }
        assert!(
            started.elapsed() < Duration::from_millis(400),
            "twenty fresh connections took {:?}",
            started.elapsed()
        );
    }

    /// The accept blocks, so a stop has to wake it. Nothing connects here but
    /// the server's own waker. The serving thread is watched rather than
    /// joined, so a listener nobody wakes fails this test instead of hanging.
    #[test]
    fn a_stop_wakes_a_listener_nobody_is_connecting_to() {
        let mut server = TestServer::start(Limits::default(), echo_handler());
        thread::sleep(Duration::from_millis(50));
        let join = server.join.take().expect("serving");
        server.shutdown.store(true, Ordering::SeqCst);
        let started = Instant::now();
        while !join.is_finished() && started.elapsed() < Duration::from_secs(2) {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(join.is_finished(), "the listener was never woken");
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
                let multipart = MultipartWriter::new("obsync-chunks");
                let mut body =
                    multipart.part_head(&[("X-Obsync-Sid", "aa"), ("Content-Length", "2")]);
                body.extend_from_slice(b"hi");
                body.extend_from_slice(MultipartWriter::PART_END);
                body.extend(
                    multipart.part_head(&[("X-Obsync-Sid", "bb"), ("X-Obsync-Missing", "1")]),
                );
                body.extend_from_slice(MultipartWriter::PART_END);
                body.extend(multipart.close());
                let len = body.len() as u64;
                Response::stream(
                    200,
                    &multipart.content_type(),
                    Box::new(Cursor::new(body)),
                    len,
                )
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
        let (mut server, reported) = TestServer::recorded(
            Limits {
                idle_timeout: Duration::from_secs(2),
                ..Limits::default()
            },
            handler_of(|request: &mut Request| {
                if request.path == "/panic" {
                    panic!("sentinel panic");
                }
                Response::text(200, "alive")
            }),
        );

        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_info| {}));
        let stream = server.connect();
        let mut reader = BufReader::new(stream.try_clone().expect("clone"));
        (&stream)
            .write_all(b"GET /panic HTTP/1.1\r\nHost: h\r\n\r\n")
            .expect("write");
        let (head, _) = read_response(&mut reader);
        std::panic::set_hook(previous);
        assert_eq!(status_of(&head), 500);
        assert!(head.contains("Connection: close\r\n"));

        // The listener is still serving.
        let next = server.connect();
        let mut reader = BufReader::new(next.try_clone().expect("clone"));
        (&next)
            .write_all(b"GET /fine HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n")
            .expect("write");
        let (head, body) = read_response(&mut reader);
        assert_eq!(status_of(&head), 200);
        assert_eq!(body, b"alive");

        server.stop();
        let log = reported.lock().expect("lock");
        assert!(
            log.iter().any(|report| report.decision == "handler_panic"),
            "the panic was never reported to the sink: {log:?}"
        );
    }

    /// The reports that arrive within `wait`.
    fn reports_after(reports: &Reports, wait: Duration) -> Vec<Report> {
        let started = Instant::now();
        while reports.lock().expect("reports").is_empty() && started.elapsed() < wait {
            thread::sleep(Duration::from_millis(10));
        }
        reports.lock().expect("reports").clone()
    }

    /// #212: a peer that resets a keep-alive connection between requests,
    /// which a proxy does routinely, is an ordinary close and never a parser
    /// refusal. The client leaves its answer unread, so closing the socket
    /// resets it.
    #[test]
    fn a_peer_resetting_an_idle_keep_alive_is_an_ordinary_close() {
        let (_server, reports) = TestServer::recorded(Limits::default(), echo_handler());
        let stream = TcpStream::connect(_server.addr).expect("connect");
        (&stream)
            .write_all(b"GET /x HTTP/1.1\r\nHost: h\r\n\r\n")
            .expect("write");
        thread::sleep(Duration::from_millis(200));
        drop(stream);
        let seen = reports_after(&reports, Duration::from_secs(2));
        assert!(!seen.is_empty(), "the reset never reached the server");
        assert!(
            seen.iter().all(|report| report.ordinary()),
            "an idle reset was reported as something else: {seen:?}"
        );
        assert!(
            seen.iter()
                .all(|report| report.decision != "parser_refusal"),
            "{seen:?}"
        );
    }

    /// Where an idle reset surfaces, a reset is the peer's close; any other
    /// failure keeps the name it was reported under, with its kind.
    #[test]
    fn a_connection_failure_is_ordinary_only_when_the_peer_ended_it() {
        for kind in [
            io::ErrorKind::ConnectionReset,
            io::ErrorKind::ConnectionAborted,
            io::ErrorKind::BrokenPipe,
            io::ErrorKind::NotConnected,
        ] {
            let report = Report::connection("connection_failed", &io::Error::from(kind));
            assert_eq!(report.decision, "peer_closed", "{kind:?}");
            assert_eq!(report.io, Some(kind));
            assert!(report.ordinary());
        }
        let report = Report::connection(
            "connection_failed",
            &io::Error::from(io::ErrorKind::PermissionDenied),
        );
        assert_eq!(report.decision, "connection_failed");
        assert_eq!(report.io, Some(io::ErrorKind::PermissionDenied));
        assert!(!report.ordinary());
    }

    /// A request the parser refuses still reaches the sink, once, with the
    /// status it was answered, so a real refusal keeps its line.
    #[test]
    fn a_malformed_request_is_reported_as_a_parser_refusal() {
        let (server, reports) = TestServer::recorded(Limits::default(), echo_handler());
        let stream = server.connect();
        let mut reader = BufReader::new(stream.try_clone().expect("clone"));
        (&stream)
            .write_all(b"GET / HTTP/1.1\r\n\r\n")
            .expect("write");
        assert_eq!(status_of(&read_response(&mut reader).0), 400);
        let seen = reports_after(&reports, Duration::from_secs(2));
        assert_eq!(
            seen,
            vec![Report {
                decision: "parser_refusal",
                status: Some(400),
                io: None,
            }]
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
