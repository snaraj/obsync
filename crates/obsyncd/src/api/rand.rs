//! Random bytes for the tokens this API mints: pairing ids, enrollment
//! tokens, session and CSRF cookies, one-time login links, and the first-boot
//! setup token.
//!
//! The kernel CSPRNG is the only source. There is no fallback: a server that
//! cannot get randomness refuses to mint a credential rather than minting a
//! guessable one (AGENTS.md requirement 4).
#![forbid(unsafe_code)]

use std::fs::File;
use std::io::{Error, ErrorKind, Read};

use obsync_core::hex;

/// Fill `buf` from the kernel CSPRNG.
///
/// # Errors
/// When `/dev/urandom` cannot be opened or read in full.
pub fn fill(buf: &mut [u8]) -> std::io::Result<()> {
    let mut f = File::open("/dev/urandom")?;
    f.read_exact(buf)?;
    Ok(())
}

/// `n` random bytes as lowercase hex.
///
/// # Errors
/// When the kernel CSPRNG is unavailable.
pub fn hex_token(n: usize) -> std::io::Result<String> {
    if n == 0 || n > 64 {
        return Err(Error::new(
            ErrorKind::InvalidInput,
            "token size out of range",
        ));
    }
    let mut buf = vec![0u8; n];
    fill(&mut buf)?;
    Ok(hex::encode(&buf))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_hex_of_the_asked_length_and_differ() {
        let a = hex_token(16).expect("random");
        let b = hex_token(16).expect("random");
        assert_eq!(a.len(), 32);
        assert_eq!(b.len(), 32);
        assert_ne!(a, b, "two tokens from the CSPRNG must differ");
        assert!(
            a.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        );
    }

    #[test]
    fn a_zero_or_oversized_request_is_refused() {
        assert!(hex_token(0).is_err());
        assert!(hex_token(65).is_err());
    }

    #[test]
    fn fill_writes_every_byte() {
        let mut buf = [0u8; 48];
        fill(&mut buf).expect("random");
        assert!(
            buf.iter().any(|b| *b != 0),
            "48 zero bytes is not plausible"
        );
    }
}
