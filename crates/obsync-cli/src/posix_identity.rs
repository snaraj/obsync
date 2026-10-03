//! Owner-approved read-only process identity. No setters or other native calls.
use std::io;

unsafe extern "C" {
    fn getuid() -> u32;
    fn geteuid() -> u32;
}

pub fn user() -> io::Result<u32> {
    // SAFETY: these argument-free POSIX functions have no pointer preconditions.
    let (real, effective) = unsafe { (getuid(), geteuid()) };
    if real == 0 || real != effective {
        return Err(io::Error::from(io::ErrorKind::PermissionDenied));
    }
    Ok(real)
}
