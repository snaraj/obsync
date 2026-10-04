#![forbid(unsafe_code)]

use crate::{Error, Result};
use std::{
    io::{Read, Write},
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

/// Only fixed OS helper programs call this; no shell or user-selected command.
pub fn capture(mut command: Command, input: Option<Vec<u8>>, deadline: Instant) -> Result<Vec<u8>> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    if input.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = command.spawn().map_err(|_| {
        Error::new(
            "native_helper_refused",
            "The fixed OS helper could not start.",
            4,
        )
    })?;
    let exceeded = Arc::new(AtomicBool::new(false));
    let reader = |mut stream: Box<dyn Read + Send>| {
        let exceeded = exceeded.clone();
        thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = stream.by_ref().take(1025).read_to_end(&mut bytes);
            if bytes.len() > 1024 {
                exceeded.store(true, Ordering::SeqCst);
            }
            result.map(|_| bytes)
        })
    };
    let out = reader(Box::new(child.stdout.take().unwrap()));
    let err = reader(Box::new(child.stderr.take().unwrap()));
    let writer = input.map(|bytes| {
        let mut stdin = child.stdin.take().unwrap();
        thread::spawn(move || stdin.write_all(&bytes))
    });
    let status = loop {
        if exceeded.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(2)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let output = out.join().ok().and_then(std::result::Result::ok);
    let errors = err.join().ok().and_then(std::result::Result::ok);
    let written = writer.is_none_or(|w| w.join().is_ok_and(|r| r.is_ok()));
    if exceeded.load(Ordering::SeqCst) {
        return Err(Error::new(
            "native_helper_output_limit",
            "The fixed OS helper exceeded its 1024-byte output limit and was stopped.",
            4,
        ));
    }
    let Some(status) = status else {
        return Err(Error::new(
            "deadline_exceeded",
            "The fixed OS helper exceeded the operation deadline.",
            7,
        ));
    };
    if !status.success()
        || !written
        || errors.as_ref().is_none_or(|v| !v.is_empty())
        || output.as_ref().is_none_or(|v| v.len() > 1024)
    {
        return Err(Error::new(
            "native_helper_refused",
            "The fixed OS helper could not establish custody.",
            4,
        ));
    }
    Ok(output.unwrap())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn real_helpers_enforce_exit_stream_input_and_time_budgets() {
        let command = |program: &str, args: &[&str]| {
            let mut c = Command::new(program);
            c.args(args).env_clear().stdin(Stdio::null());
            c
        };
        let deadline = || Instant::now() + Duration::from_secs(2);
        let bytes = vec![b'x'; 1024];
        assert_eq!(
            capture(command("/bin/cat", &[]), Some(bytes.clone()), deadline()).unwrap(),
            bytes
        );
        for (name, child, input) in [
            ("exit", command("/bin/sh", &["-c", "exit 4"]), None),
            (
                "stderr",
                command("/bin/sh", &["-c", "printf fixture >&2"]),
                None,
            ),
            (
                "closed input",
                command("/usr/bin/true", &[]),
                Some(vec![b'x'; 1024 * 1024]),
            ),
        ] {
            let error = capture(child, input, deadline()).expect_err(name);
            assert_eq!(error.code, "native_helper_refused", "{name}");
            assert_eq!(error.exit, 4, "{name}");
        }
        for child in [
            command("/usr/bin/printf", &["%s", &"x".repeat(1025)]),
            command("/bin/sh", &["-c", "printf '%01025d' 0; exec /bin/sleep 3"]),
            command("/usr/bin/head", &["-c", "1048576", "/dev/zero"]),
            command(
                "/bin/sh",
                &["-c", "exec /usr/bin/head -c 1048576 /dev/zero >&2"],
            ),
        ] {
            let started = Instant::now();
            let error = capture(child, None, deadline()).unwrap_err();
            assert_eq!(error.code, "native_helper_output_limit");
            assert_eq!(error.exit, 4);
            assert!(started.elapsed() < Duration::from_secs(1));
        }
        let error = capture(
            command("/bin/sleep", &["1"]),
            None,
            Instant::now() + Duration::from_millis(25),
        )
        .unwrap_err();
        assert_eq!(error.code, "deadline_exceeded");
        assert_eq!(error.exit, 7);
    }
}
