#![forbid(unsafe_code)]

use crate::{Error, Result};
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

fn refused() -> Error {
    Error::new(
        "native_helper_refused",
        "The fixed OS helper could not establish custody.",
        4,
    )
}
fn reason(raw: &[u8]) -> Option<&'static str> {
    use obsync_core::json::{self, Value};
    let value = json::parse(raw).ok()?;
    crate::context::closed(&value, &["v", "ok", "reason", "exception", "line"]).ok()?;
    if value.get("v").and_then(Value::as_u64) != Some(1)
        || value.get("ok").and_then(Value::as_bool) != Some(false)
        || value.get("exception").and_then(Value::as_str).is_none()
        || value.get("line").and_then(Value::as_u64).is_none()
    {
        return None;
    }
    // Only compiled identifiers may leave the process boundary. Never return
    // the helper's bytes, exception text, line, paths or an unknown reason.
    concat!(
        "acl_access ancestor_directory destination_exists directory_required file_required ",
        "local_ntfs_required os_module_required os_powershell_required owner owner_access ",
        "path_spelling private_parent publication_io publication_readback reparse_point ",
        "request_budget request_count request_framing request_shape request_spelling ",
        "same_parent_required stage_not_empty tree_budget windows_files_refused"
    )
    .split_ascii_whitespace()
    .find(|known| value.get("reason").and_then(Value::as_str) == Some(*known))
}
fn check_time(deadline: Instant) -> Result<()> {
    if Instant::now() >= deadline {
        return Err(Error::new(
            "deadline_exceeded",
            "The fixed OS helper exceeded the operation deadline.",
            7,
        ));
    }
    Ok(())
}

/// One fixed helper per CLI command, with bounded, sequential request frames.
/// Every success requires finish(), including EOF, stderr and process status.
pub struct Session {
    child: Child,
    input: Option<SyncSender<Vec<u8>>>,
    output: Receiver<Vec<u8>>,
    errors: Receiver<Option<&'static str>>,
    failed: Arc<AtomicBool>,
    workers: Vec<JoinHandle<()>>,
}
impl Session {
    pub fn start(mut command: Command, deadline: Instant) -> Result<Self> {
        check_time(deadline)?;
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| refused())?;
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let mut stderr = BufReader::new(child.stderr.take().unwrap());
        let (send, requests) = mpsc::sync_channel::<Vec<u8>>(1);
        let (responses, receive) = mpsc::sync_channel(1);
        let (diagnostic, errors) = mpsc::sync_channel(1);
        let failed = Arc::new(AtomicBool::new(false));
        let state = failed.clone();
        let exchange = thread::spawn(move || {
            let run = || -> std::io::Result<()> {
                for bytes in requests {
                    stdin.write_all(&bytes)?;
                    let mut line = Vec::new();
                    stdout.by_ref().take(1025).read_until(b'\n', &mut line)?;
                    if line.len() > 1024
                        || line.last() != Some(&b'\n')
                        || responses.try_send(line).is_err()
                    {
                        return Err(std::io::ErrorKind::InvalidData.into());
                    }
                }
                // Closing input ends the protocol. Any trailing output refuses.
                drop(stdin);
                if stdout.read(&mut [0])? != 0 {
                    return Err(std::io::ErrorKind::InvalidData.into());
                }
                Ok(())
            };
            if run().is_err() {
                state.store(true, Ordering::SeqCst);
            }
        });
        let state = failed.clone();
        let error_worker = thread::spawn(move || {
            let mut first = [0];
            let received = stderr.read(&mut first);
            let code = if matches!(received, Ok(0)) {
                None
            } else {
                state.store(true, Ordering::SeqCst);
                let mut raw = first.to_vec();
                if matches!(received, Ok(1))
                    && stderr
                        .by_ref()
                        .take(1024)
                        .read_until(b'\n', &mut raw)
                        .is_ok()
                    && raw.len() <= 1024
                    && raw.last() == Some(&b'\n')
                {
                    reason(&raw)
                } else {
                    None
                }
            };
            let _ = diagnostic.send(code);
        });
        Ok(Self {
            child,
            input: Some(send),
            output: receive,
            errors,
            failed,
            workers: vec![exchange, error_worker],
        })
    }
    pub fn request(&mut self, mut bytes: Vec<u8>, deadline: Instant) -> Result<Vec<u8>> {
        check_time(deadline)?;
        if bytes.len() > 16384
            || bytes.is_empty()
            || bytes.contains(&b'\n')
            || bytes.contains(&b'\r')
        {
            return Err(refused());
        }
        if self.failed.load(Ordering::SeqCst) {
            return Err(self.failure(deadline));
        }
        bytes.push(b'\n');
        if self
            .input
            .as_ref()
            .ok_or_else(refused)?
            .try_send(bytes)
            .is_err()
        {
            return Err(self.failure(deadline));
        }
        loop {
            check_time(deadline)?;
            if self.failed.load(Ordering::SeqCst) {
                return Err(self.failure(deadline));
            }
            match self.output.recv_timeout(Duration::from_millis(2)) {
                Ok(line) => return Ok(line),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => return Err(self.failure(deadline)),
            }
        }
    }
    fn failure(&mut self, deadline: Instant) -> Error {
        self.input.take();
        loop {
            if let Err(error) = check_time(deadline) {
                return error;
            }
            match self.errors.recv_timeout(Duration::from_millis(2)) {
                Ok(Some(code)) => {
                    return Error::new(code, "The fixed OS helper refused custody.", 4);
                }
                Ok(None) | Err(mpsc::RecvTimeoutError::Disconnected) => return refused(),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    }
    pub fn finish(mut self, deadline: Instant) -> Result<()> {
        self.input.take();
        let status = loop {
            if self.failed.load(Ordering::SeqCst) {
                return Err(self.failure(deadline));
            }
            match self.child.try_wait().map_err(|_| refused())? {
                Some(status) => break status,
                None => {
                    check_time(deadline)?;
                    thread::sleep(Duration::from_millis(2));
                }
            }
        };
        self.join();
        if !status.success() || self.failed.load(Ordering::SeqCst) || self.output.try_recv().is_ok()
        {
            return Err(self.failure(deadline));
        }
        Ok(())
    }
    fn join(&mut self) {
        for worker in self.workers.drain(..) {
            if worker.join().is_err() {
                self.failed.store(true, Ordering::SeqCst);
            }
        }
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.input.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.join();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    fn command(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]).env_clear();
        command
    }
    fn deadline() -> Instant {
        Instant::now() + Duration::from_secs(2)
    }

    #[test]
    fn sequential_requests_require_clean_final_exit() {
        let mut session = Session::start(
            command("while IFS= read -r line; do printf '%s\\n' \"$line\"; done"),
            deadline(),
        )
        .unwrap();
        for input in [b"first".to_vec(), vec![b'x'; 1023], b"last".to_vec()] {
            let output = session.request(input.clone(), deadline()).unwrap();
            assert_eq!(output, [input, vec![b'\n']].concat());
        }
        session.finish(deadline()).unwrap();
        let mut session = Session::start(command("exit 0"), deadline()).unwrap();
        assert!(session.child.wait().unwrap().success());
        // A clean child that already exited has a verified result even if the
        // caller was descheduled before final collection.
        session
            .finish(Instant::now() - Duration::from_millis(1))
            .unwrap();
        for ending in ["exit 4", "printf trailing", "printf failure >&2"] {
            let script = format!(
                "IFS= read -r line; printf '%s\\n' \"$line\"; while IFS= read -r line; do :; done; {ending}"
            );
            let mut session = Session::start(command(&script), deadline()).unwrap();
            assert_eq!(
                session.request(b"ok".to_vec(), deadline()).unwrap(),
                b"ok\n"
            );
            assert_eq!(
                session.finish(deadline()).unwrap_err().code,
                "native_helper_refused",
                "{ending}"
            );
        }
    }
    #[test]
    fn actual_pipes_refuse_invalid_frames_and_obey_the_deadline() {
        for script in [
            "exit 4",
            "printf x",
            "printf 'failure' >&2",
            "IFS= read -r line; printf '%01024d\\n' 0",
        ] {
            let mut session = Session::start(command(script), deadline()).unwrap();
            assert_eq!(
                session
                    .request(b"request".to_vec(), deadline())
                    .unwrap_err()
                    .code,
                "native_helper_refused",
                "{script}"
            );
        }
        for input in [
            vec![],
            vec![b'x'; 16385],
            b"two\nlines".to_vec(),
            b"cr\r".to_vec(),
        ] {
            let mut session = Session::start(
                command("while IFS= read -r line; do printf 'ack\\n'; done"),
                deadline(),
            )
            .unwrap();
            assert_eq!(
                session.request(input, deadline()).unwrap_err().code,
                "native_helper_refused"
            );
        }
        let mut session = Session::start(command("exec /bin/sleep 1"), deadline()).unwrap();
        assert_eq!(
            session
                .request(
                    b"request".to_vec(),
                    Instant::now() + Duration::from_millis(25)
                )
                .unwrap_err()
                .exit,
            7
        );
        let id = session.child.id();
        let cleanup_started = Instant::now();
        drop(session);
        assert!(
            cleanup_started.elapsed() < Duration::from_millis(500),
            "timed-out helper cleanup exceeded its bounded margin"
        );
        let gone = Command::new("/bin/kill")
            .args(["-0", &id.to_string()])
            .output()
            .unwrap();
        assert!(!gone.status.success(), "timed-out helper remained alive");
        let mut session = Session::start(
            command("IFS= read -r line; printf 'ok\\n'; exec /bin/sleep 1"),
            deadline(),
        )
        .unwrap();
        session.request(b"request".to_vec(), deadline()).unwrap();
        assert_eq!(
            session
                .finish(Instant::now() + Duration::from_millis(25))
                .unwrap_err()
                .exit,
            7
        );
        assert_eq!(
            Session::start(command("exit 0"), Instant::now())
                .err()
                .unwrap()
                .exit,
            7
        );
    }

    #[test]
    fn helper_diagnostics_are_bounded_static_and_race_independent() {
        let complete = r#"{"v":1,"ok":false,"reason":"request_shape","exception":"InvalidOperationException","line":150}"#;
        for (raw, expected) in [
            (complete.to_owned(), "request_shape"),
            (
                complete.replace("request_shape", "synthetic_unknown"),
                "native_helper_refused",
            ),
            (
                complete.replace("\"v\":1", "\"v\":2"),
                "native_helper_refused",
            ),
            (
                complete.replace(
                    "\"line\":150",
                    "\"line\":150,\"extra\":\"synthetic-detail\"",
                ),
                "native_helper_refused",
            ),
            (
                complete.replace(
                    "InvalidOperationException",
                    &"x".repeat(1024 - complete.len() + "InvalidOperationException".len()),
                ),
                "native_helper_refused",
            ),
            ("{\"v\":1".into(), "native_helper_refused"),
            ("synthetic-detail".into(), "native_helper_refused"),
        ] {
            let script = format!("IFS= read -r line; printf '%s\\n' '{raw}' >&2; exit 4");
            let mut session = Session::start(command(&script), deadline()).unwrap();
            assert_eq!(
                session
                    .request(b"request".to_vec(), deadline())
                    .unwrap_err()
                    .code,
                expected
            );
        }
        let script = format!("IFS= read -r line; printf '%s' '{complete}' >&2; exit 4");
        let mut session = Session::start(command(&script), deadline()).unwrap();
        assert_eq!(
            session
                .request(b"request".to_vec(), deadline())
                .unwrap_err()
                .code,
            "native_helper_refused"
        );
        // stdout EOF can precede the sanitized stderr receipt; both paths must
        // preserve the known reason without exposing the helper's raw output.
        let script = format!(
            "IFS= read -r line; exec 1>&-; /bin/sleep 0.02; printf '%s\\n' '{complete}' >&2; exit 4"
        );
        let mut session = Session::start(command(&script), deadline()).unwrap();
        assert_eq!(
            session
                .request(b"request".to_vec(), deadline())
                .unwrap_err()
                .code,
            "request_shape"
        );
        let script = format!(
            "IFS= read -r line; printf 'ok\\n'; while IFS= read -r line; do :; done; printf '%s\\n' '{complete}' >&2; exit 4"
        );
        let mut session = Session::start(command(&script), deadline()).unwrap();
        session.request(b"request".to_vec(), deadline()).unwrap();
        assert_eq!(
            session.finish(deadline()).unwrap_err().code,
            "request_shape"
        );
        let mut session = Session::start(
            command("IFS= read -r line; printf '{' >&2; exec /bin/sleep 1"),
            deadline(),
        )
        .unwrap();
        assert_eq!(
            session
                .request(
                    b"request".to_vec(),
                    Instant::now() + Duration::from_millis(25)
                )
                .unwrap_err()
                .exit,
            7
        );
        let before = Instant::now();
        drop(session);
        assert!(before.elapsed() < Duration::from_millis(500));
    }
}
