//! Structured single-line logging to stderr (AGENTS.md requirement 12).
//!
//! One line per decision: `ts=<unix_ms> level=<l> event=<name> k=v ...`,
//! values quoted when they contain a space, `=` or `"`.
//!
//! The blind-server requirement (AGENTS.md requirement 6) is met by
//! construction, not by review: a field value can only be built through a
//! [`Val`] constructor, and the only free-text constructor takes a
//! `&'static str`. A vault path, a key, or a plaintext chunk is runtime data
//! and can never be a `&'static str` literal in this binary, so no log line
//! can carry one. Device identifiers are truncated to their first eight hex
//! characters, which is enough to correlate and not enough to enumerate.
#![forbid(unsafe_code)]

use std::fmt;
use std::io::{self, Write};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::types::{
    AccountId, DeviceId, DomainId, FileId, Seq, Sid, UnixMs, VersionId, hex_string,
};

/// Verbosity, ordered least to most verbose (`OBSYNC_LOG`).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Default)]
pub enum LogLevel {
    /// Refusals and faults only.
    Error,
    /// Refusals, faults, and warnings.
    Warn,
    /// The default: decisions, summaries, and lifecycle.
    #[default]
    Info,
    /// Everything, including per-step detail.
    Debug,
}

impl LogLevel {
    /// Parse `error`, `warn`, `info` or `debug`.
    pub fn parse(s: &str) -> Option<LogLevel> {
        match s {
            "error" => Some(LogLevel::Error),
            "warn" => Some(LogLevel::Warn),
            "info" => Some(LogLevel::Info),
            "debug" => Some(LogLevel::Debug),
            _ => None,
        }
    }

    /// The word this level prints as.
    pub const fn as_str(self) -> &'static str {
        match self {
            LogLevel::Error => "error",
            LogLevel::Warn => "warn",
            LogLevel::Info => "info",
            LogLevel::Debug => "debug",
        }
    }
}

impl fmt::Display for LogLevel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A log field value. Only the constructors below can build one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Val(String);

impl Val {
    /// A chunk storage id (a hash of ciphertext; server-visible by design).
    pub fn sid(sid: &Sid) -> Val {
        Val(sid.to_string())
    }

    /// A device id, truncated to its first eight hex characters.
    pub fn device(id: &DeviceId) -> Val {
        Val(hex_string(&id.as_bytes()[..4]))
    }

    /// A file id.
    pub fn file(id: &FileId) -> Val {
        Val(id.to_string())
    }

    /// A version id.
    pub fn version(id: &VersionId) -> Val {
        Val(id.to_string())
    }

    /// A domain id.
    pub fn domain(id: &DomainId) -> Val {
        Val(id.to_string())
    }

    /// An account id.
    pub fn account(id: &AccountId) -> Val {
        Val(id.to_string())
    }

    /// A journal sequence number.
    pub fn seq(seq: Seq) -> Val {
        Val(seq.to_string())
    }

    /// A unix millisecond timestamp.
    pub fn ts(ts: UnixMs) -> Val {
        Val(ts.to_string())
    }

    /// A byte count.
    pub fn bytes(n: u64) -> Val {
        Val(n.to_string())
    }

    /// A duration in milliseconds.
    pub fn ms(n: u64) -> Val {
        Val(n.to_string())
    }

    /// A plain count.
    pub fn count(n: u64) -> Val {
        Val(n.to_string())
    }

    /// An HTTP status code.
    pub fn status(code: u16) -> Val {
        Val(code.to_string())
    }

    /// A boolean.
    pub fn flag(b: bool) -> Val {
        Val(if b { "true" } else { "false" }.to_string())
    }

    /// A compile-time word: a decision, a refusal code, a role, an event kind.
    ///
    /// `&'static str` is the whole guard: runtime data cannot be one.
    pub fn word(w: &'static str) -> Val {
        Val(w.to_string())
    }

    /// The kind of an I/O error, never its message (a message can carry a path).
    pub fn io(e: &io::Error) -> Val {
        Val(format!("{:?}", e.kind()))
    }

    /// The rendered value, for tests.
    #[cfg(test)]
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

/// Where lines go. `Buffer` exists so tests can read what was written.
enum Sink {
    Stderr,
    #[cfg(test)]
    Buffer(String),
}

struct Inner {
    level: LogLevel,
    sink: Mutex<Sink>,
}

/// A cloneable handle to the process log.
#[derive(Clone)]
pub struct Log {
    inner: Arc<Inner>,
}

impl fmt::Debug for Log {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Log({})", self.inner.level)
    }
}

impl Log {
    /// A log writing to stderr at `level`.
    pub fn new(level: LogLevel) -> Log {
        Log {
            inner: Arc::new(Inner {
                level,
                sink: Mutex::new(Sink::Stderr),
            }),
        }
    }

    /// A log that accumulates lines in memory, for tests.
    #[cfg(test)]
    pub(crate) fn buffered(level: LogLevel) -> Log {
        Log {
            inner: Arc::new(Inner {
                level,
                sink: Mutex::new(Sink::Buffer(String::new())),
            }),
        }
    }

    /// Everything written so far, for tests.
    #[cfg(test)]
    pub(crate) fn captured(&self) -> String {
        match &*self.inner.sink.lock().expect("log sink") {
            Sink::Stderr => String::new(),
            Sink::Buffer(s) => s.clone(),
        }
    }

    /// The configured verbosity.
    pub fn level(&self) -> LogLevel {
        self.inner.level
    }

    /// Log a refusal or a fault.
    pub fn error(&self, event: &'static str, fields: &[(&'static str, Val)]) {
        self.emit(LogLevel::Error, event, fields);
    }

    /// Log a recoverable problem.
    pub fn warn(&self, event: &'static str, fields: &[(&'static str, Val)]) {
        self.emit(LogLevel::Warn, event, fields);
    }

    /// Log a decision.
    pub fn info(&self, event: &'static str, fields: &[(&'static str, Val)]) {
        self.emit(LogLevel::Info, event, fields);
    }

    /// Log per-step detail.
    pub fn debug(&self, event: &'static str, fields: &[(&'static str, Val)]) {
        self.emit(LogLevel::Debug, event, fields);
    }

    /// Announce a long-running job with the budget it is measured against.
    pub fn start(&self, job: &'static str, budget: u64) -> Started {
        self.info(
            "start",
            &[("job", Val::word(job)), ("budget", Val::bytes(budget))],
        );
        Started {
            job,
            budget,
            at: Instant::now(),
        }
    }

    /// Time one request or step; `Timed::done` emits the line.
    pub fn timed(&self, event: &'static str) -> Timed {
        Timed {
            log: self.clone(),
            event,
            at: Instant::now(),
            finished: false,
        }
    }

    fn emit(&self, level: LogLevel, event: &'static str, fields: &[(&'static str, Val)]) {
        if level > self.inner.level {
            return;
        }
        let mut line = String::with_capacity(48 + fields.len() * 20);
        line.push_str("ts=");
        line.push_str(&now_ms().to_string());
        line.push_str(" level=");
        line.push_str(level.as_str());
        line.push_str(" event=");
        line.push_str(event);
        for (key, value) in fields {
            line.push(' ');
            line.push_str(key);
            line.push('=');
            push_value(&mut line, &value.0);
        }
        line.push('\n');
        let mut sink = self.inner.sink.lock().expect("log sink");
        match &mut *sink {
            Sink::Stderr => {
                let _ = io::stderr().write_all(line.as_bytes());
            }
            #[cfg(test)]
            Sink::Buffer(buf) => buf.push_str(&line),
        }
    }
}

fn push_value(line: &mut String, value: &str) {
    let needs_quotes = value.is_empty()
        || value
            .chars()
            .any(|c| c == ' ' || c == '=' || c == '"' || c == '\\' || c.is_control());
    if !needs_quotes {
        line.push_str(value);
        return;
    }
    line.push('"');
    for c in value.chars() {
        match c {
            '"' => line.push_str("\\\""),
            '\\' => line.push_str("\\\\"),
            '\n' => line.push_str("\\n"),
            c if c.is_control() => line.push('?'),
            c => line.push(c),
        }
    }
    line.push('"');
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// A started long-running job: the other half of the START/SUMMARY pair.
#[derive(Debug)]
pub struct Started {
    job: &'static str,
    budget: u64,
    at: Instant,
}

impl Started {
    /// Milliseconds since the job started.
    pub fn elapsed_ms(&self) -> u64 {
        u64::try_from(self.at.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    /// Emit the SUMMARY line: the job, its duration, its budget, and `fields`.
    pub fn summary(&self, log: &Log, fields: &[(&'static str, Val)]) {
        let mut all: Vec<(&'static str, Val)> = Vec::with_capacity(fields.len() + 3);
        all.push(("job", Val::word(self.job)));
        all.push(("duration_ms", Val::ms(self.elapsed_ms())));
        all.push(("budget", Val::bytes(self.budget)));
        all.extend(fields.iter().cloned());
        log.info("summary", &all);
    }
}

/// A timing guard for one request or step.
///
/// `done` emits the line. A dropped, unfinished `Timed` logs a warning: work
/// that ends by panic or early return is still visible (requirement 12).
pub struct Timed {
    log: Log,
    event: &'static str,
    at: Instant,
    finished: bool,
}

impl Timed {
    /// Milliseconds since the guard was created.
    pub fn elapsed_ms(&self) -> u64 {
        u64::try_from(self.at.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    /// Emit the line: `fields` plus `duration_ms`.
    pub fn done(mut self, fields: &[(&'static str, Val)]) {
        self.finished = true;
        let mut all: Vec<(&'static str, Val)> = Vec::with_capacity(fields.len() + 1);
        all.extend(fields.iter().cloned());
        all.push(("duration_ms", Val::ms(self.elapsed_ms())));
        self.log.info(self.event, &all);
    }
}

impl Drop for Timed {
    fn drop(&mut self) {
        if !self.finished {
            self.log.warn(
                self.event,
                &[
                    ("decision", Val::word("unfinished")),
                    ("duration_ms", Val::ms(self.elapsed_ms())),
                ],
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields_of(line: &str) -> Vec<(&str, &str)> {
        line.split(' ')
            .filter_map(|kv| kv.split_once('='))
            .collect()
    }

    #[test]
    fn line_shape_is_ts_level_event_then_fields() {
        let log = Log::buffered(LogLevel::Info);
        log.info(
            "chunk_put",
            &[
                ("bytes", Val::bytes(17)),
                ("decision", Val::word("created")),
            ],
        );
        let out = log.captured();
        let line = out.trim_end();
        let fields = fields_of(line);
        assert_eq!(fields[0].0, "ts");
        assert!(fields[0].1.parse::<u64>().expect("ts is a number") > 1_700_000_000_000);
        assert_eq!(fields[1], ("level", "info"));
        assert_eq!(fields[2], ("event", "chunk_put"));
        assert_eq!(fields[3], ("bytes", "17"));
        assert_eq!(fields[4], ("decision", "created"));
        assert!(out.ends_with('\n'));
    }

    #[test]
    fn values_with_spaces_are_quoted_and_escaped() {
        let mut line = String::new();
        push_value(&mut line, "two words");
        push_value(&mut line, "plain");
        push_value(&mut line, "a\"b\\c");
        push_value(&mut line, "");
        assert_eq!(line, "\"two words\"plain\"a\\\"b\\\\c\"\"\"");
    }

    #[test]
    fn level_filters_quieter_sinks() {
        let log = Log::buffered(LogLevel::Error);
        log.debug("d", &[]);
        log.info("i", &[]);
        log.warn("w", &[]);
        log.error("e", &[]);
        let out = log.captured();
        assert!(!out.contains("event=d"), "{out}");
        assert!(!out.contains("event=i"), "{out}");
        assert!(!out.contains("event=w"), "{out}");
        assert!(out.contains("event=e"), "{out}");
    }

    #[test]
    fn start_and_summary_carry_duration_and_budget() {
        let log = Log::buffered(LogLevel::Info);
        let job = log.start("scrub", 4_194_304);
        job.summary(&log, &[("chunks", Val::count(3))]);
        let out = log.captured();
        let mut lines = out.lines();
        let start = lines.next().expect("start line");
        assert!(start.contains("event=start"), "{start}");
        assert!(start.contains("job=scrub"), "{start}");
        assert!(start.contains("budget=4194304"), "{start}");
        let summary = lines.next().expect("summary line");
        assert!(summary.contains("event=summary"), "{summary}");
        assert!(summary.contains("job=scrub"), "{summary}");
        assert!(summary.contains("duration_ms="), "{summary}");
        assert!(summary.contains("budget=4194304"), "{summary}");
        assert!(summary.contains("chunks=3"), "{summary}");
    }

    #[test]
    fn timed_logs_once_when_finished_and_warns_when_dropped() {
        let log = Log::buffered(LogLevel::Info);
        log.timed("request").done(&[("decision", Val::word("ok"))]);
        let out = log.captured();
        assert!(out.contains("event=request"), "{out}");
        assert!(out.contains("decision=ok"), "{out}");
        assert!(out.contains("duration_ms="), "{out}");
        assert_eq!(out.lines().count(), 1, "{out}");

        let log = Log::buffered(LogLevel::Info);
        drop(log.timed("request"));
        let out = log.captured();
        assert!(out.contains("decision=unfinished"), "{out}");
    }

    #[test]
    fn device_ids_are_truncated_and_io_errors_show_only_the_kind() {
        let id = DeviceId::new([0xab; 16]);
        assert_eq!(Val::device(&id).as_str(), "abababab");
        let err = io::Error::new(io::ErrorKind::NotFound, "/data/blobs/v1/secret-path");
        assert_eq!(Val::io(&err).as_str(), "NotFound");
    }

    #[test]
    fn level_parses_the_documented_words_only() {
        assert_eq!(LogLevel::parse("debug"), Some(LogLevel::Debug));
        assert_eq!(LogLevel::parse("info"), Some(LogLevel::Info));
        assert_eq!(LogLevel::parse("warn"), Some(LogLevel::Warn));
        assert_eq!(LogLevel::parse("error"), Some(LogLevel::Error));
        assert_eq!(LogLevel::parse("trace"), None);
        assert_eq!(LogLevel::parse("INFO"), None);
        assert!(LogLevel::Error < LogLevel::Info);
    }
}
