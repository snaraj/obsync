//! Shutdown signals. The single permitted FFI surface (AGENTS.md req. 5).
//!
//! This is the ONLY file in the workspace without `#![forbid(unsafe_code)]`,
//! because POSIX signal delivery has no standard-library equivalent and the
//! standard library is the whole dependency budget. The surface is one
//! declaration, `signal(2)`, and one handler.
//!
//! Why this is safe:
//!
//! * `signal(2)` is async-signal-safe and takes a plain function pointer; the
//!   handler is passed as `usize` so no function-pointer type has to cross the
//!   boundary and no lifetime is implied.
//! * The handler does exactly one thing: an atomic store of `true`. It
//!   allocates nothing, locks nothing, calls nothing re-entrant, and cannot
//!   panic. `OnceLock::get` is an acquire load of an atomic plus a pointer
//!   read; the flag it reaches is published before the handler is installed,
//!   so the handler never observes an uninitialised cell.
//! * Nothing else in this file, or in the workspace, is `unsafe`.
//!
//! Everything else about shutdown (draining, refusing new work, readiness)
//! reads the returned flag from safe code.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Once, OnceLock};

/// `SIGINT`, the interrupt signal.
const SIGINT: i32 = 2;
/// `SIGTERM`, the termination signal Kubernetes sends first.
const SIGTERM: i32 = 15;
/// `SIG_ERR`, what `signal(2)` returns when it refuses.
const SIG_ERR: usize = usize::MAX;

unsafe extern "C" {
    fn signal(signum: i32, handler: usize) -> usize;
}

static FLAG: OnceLock<Arc<AtomicBool>> = OnceLock::new();
static INSTALLED: Once = Once::new();

extern "C" fn on_signal(_signum: i32) {
    if let Some(flag) = FLAG.get() {
        flag.store(true, Ordering::SeqCst);
    }
}

/// Install the `SIGTERM`/`SIGINT` handlers and return the shutdown flag.
///
/// Idempotent: every call returns the same flag and installs the handlers at
/// most once. The flag is published before the handlers are installed, so a
/// signal arriving during installation is never lost.
pub fn install() -> Arc<AtomicBool> {
    let flag = FLAG
        .get_or_init(|| Arc::new(AtomicBool::new(false)))
        .clone();
    INSTALLED.call_once(|| {
        for signum in [SIGTERM, SIGINT] {
            // SAFETY: the module docs above. `on_signal as usize` is a plain
            // code address; the handler only stores to an atomic.
            let handler = on_signal as *const () as usize;
            // SAFETY: the module docs above. `handler` is a plain code
            // address; the handler it names only stores to an atomic.
            let previous = unsafe { signal(signum, handler) };
            debug_assert_ne!(previous, SIG_ERR, "signal handler refused");
        }
    });
    flag
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::thread::sleep;
    use std::time::{Duration, Instant};

    #[test]
    fn install_is_idempotent_and_delivers_sigterm() {
        let first = install();
        let second = install();
        assert!(Arc::ptr_eq(&first, &second), "install must return one flag");
        assert!(!first.load(Ordering::SeqCst), "flag starts clear");

        // Real delivery: without a working handler this signal ends the test
        // process, so a silent no-op cannot pass.
        //
        // The signal is sent through the shell's own `kill` builtin rather
        // than a `kill(1)` binary. POSIX requires every shell to provide it,
        // while the binary lives in a package the slim image the release
        // Dockerfile tests in does not install; asking for it there is how
        // this test used to fail inside the image and pass on a laptop.
        let pid = std::process::id();
        let status = Command::new("sh")
            .args(["-c", &format!("kill -s TERM {pid}")])
            .status()
            .expect("the shell runs");
        assert!(status.success(), "kill -s TERM failed");

        let deadline = Instant::now() + Duration::from_secs(5);
        while !first.load(Ordering::SeqCst) && Instant::now() < deadline {
            sleep(Duration::from_millis(5));
        }
        assert!(first.load(Ordering::SeqCst), "SIGTERM must set the flag");
        assert!(second.load(Ordering::SeqCst), "both handles see it");
        first.store(false, Ordering::SeqCst);
    }
}
