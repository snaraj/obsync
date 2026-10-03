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
        let mut stderr = child.stderr.take().unwrap();
        let (send, requests) = mpsc::sync_channel::<Vec<u8>>(1);
        let (responses, receive) = mpsc::sync_channel(1);
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
        let errors = thread::spawn(move || {
            if !matches!(stderr.read(&mut [0]), Ok(0)) {
                state.store(true, Ordering::SeqCst);
            }
        });
        Ok(Self {
            child,
            input: Some(send),
            output: receive,
            failed,
            workers: vec![exchange, errors],
        })
    }
    pub fn request(&mut self, mut bytes: Vec<u8>, deadline: Instant) -> Result<Vec<u8>> {
        check_time(deadline)?;
        if bytes.len() > 16384
            || bytes.is_empty()
            || bytes.contains(&b'\n')
            || bytes.contains(&b'\r')
            || self.failed.load(Ordering::SeqCst)
        {
            return Err(refused());
        }
        bytes.push(b'\n');
        self.input
            .as_ref()
            .ok_or_else(refused)?
            .try_send(bytes)
            .map_err(|_| refused())?;
        loop {
            check_time(deadline)?;
            if self.failed.load(Ordering::SeqCst) {
                return Err(refused());
            }
            match self.output.recv_timeout(Duration::from_millis(2)) {
                Ok(line) => return Ok(line),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => return Err(refused()),
            }
        }
    }
    pub fn finish(mut self, deadline: Instant) -> Result<()> {
        self.input.take();
        let status = loop {
            check_time(deadline)?;
            if self.failed.load(Ordering::SeqCst) {
                return Err(refused());
            }
            match self.child.try_wait().map_err(|_| refused())? {
                Some(status) => break status,
                None => thread::sleep(Duration::from_millis(2)),
            }
        };
        self.join();
        check_time(deadline)?;
        if !status.success() || self.failed.load(Ordering::SeqCst) || self.output.try_recv().is_ok()
        {
            return Err(refused());
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
}
