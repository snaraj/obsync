#![forbid(unsafe_code)]

use crate::{Error, Result};
use std::{
    io::{Read, Write},
    process::{Command, Stdio},
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
    let reader = |mut stream: Box<dyn Read + Send>| {
        thread::spawn(move || {
            let mut bytes = Vec::new();
            stream
                .by_ref()
                .take(1025)
                .read_to_end(&mut bytes)
                .map(|_| bytes)
        })
    };
    let out = reader(Box::new(child.stdout.take().unwrap()));
    let err = reader(Box::new(child.stderr.take().unwrap()));
    let writer = input.map(|bytes| {
        let mut stdin = child.stdin.take().unwrap();
        thread::spawn(move || stdin.write_all(&bytes))
    });
    let status = loop {
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
