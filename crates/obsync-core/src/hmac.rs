//! HMAC-SHA-256 (RFC 2104, keyed with SHA-256), streaming and one-shot.
//!
//! This is the server's only authentication primitive. Every device request
//! carries `X-Obsync-Sig`, an HMAC over the method, the request target, the
//! timestamp, the nonce and the body hash under that device's secret
//! (`docs/protocol.md`, "Authentication"), and device secrets rest wrapped
//! under a per-device HKDF output of the server key
//! (`docs/architecture.md`, section 3.6), which is HMAC underneath.
//!
//! Security notes. A computed tag is compared with [`crate::ct::eq`], never
//! with `==`: a byte-at-a-time comparison of a signature is a forgery oracle.
//! The block loop is straight-line arithmetic with no branch on key or
//! message bytes, so timing depends on the message length alone. Key
//! material lives in the outer pad and inside the inner hasher state for the
//! life of the value; this crate makes no zeroization claim it cannot
//! enforce without `unsafe`, and the alternative — a key that never enters
//! the process — is the design's job, not this module's.

use crate::sha256::{Sha256, sha256};

/// SHA-256's block size, the width of the HMAC pads (RFC 2104, section 2).
const BLOCK: usize = 64;

/// Streaming HMAC-SHA-256: feed it with [`HmacSha256::update`], take the tag
/// with [`HmacSha256::finalize`].
///
/// Streaming exists for the same reason as in `sha256`: a large body is
/// authenticated as it arrives, never buffered whole.
pub struct HmacSha256 {
    /// `SHA-256(K ^ ipad || message)` in progress.
    inner: Sha256,
    /// `K ^ opad`, kept for the outer hash.
    opad: [u8; BLOCK],
}

impl HmacSha256 {
    /// Start a tag under `key`. Keys of any length are accepted: a key
    /// longer than the 64-byte block is replaced by its SHA-256 digest and a
    /// shorter one is zero-padded, exactly as RFC 2104 section 2 requires.
    pub fn new(key: &[u8]) -> Self {
        let mut block = [0u8; BLOCK];
        if key.len() > BLOCK {
            block[..32].copy_from_slice(&sha256(key));
        } else {
            block[..key.len()].copy_from_slice(key);
        }

        let mut ipad = block;
        for b in ipad.iter_mut() {
            *b ^= 0x36;
        }
        let mut opad = block;
        for b in opad.iter_mut() {
            *b ^= 0x5c;
        }

        let mut inner = Sha256::new();
        inner.update(&ipad);
        Self { inner, opad }
    }

    /// Absorb the next slice of the message. How a message is split across
    /// calls never changes the tag.
    pub fn update(&mut self, data: &[u8]) {
        self.inner.update(data);
    }

    /// The 32-byte tag. The state is consumed, so a finalized tag can never
    /// be extended.
    pub fn finalize(self) -> [u8; 32] {
        let inner = self.inner.finalize();
        let mut outer = Sha256::new();
        outer.update(&self.opad);
        outer.update(&inner);
        outer.finalize()
    }
}

/// HMAC-SHA-256 over one contiguous message.
pub fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut mac = HmacSha256::new(key);
    mac.update(data);
    mac.finalize()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hex;

    /// RFC 4231 section 4, test cases 1 to 7: (key, message, expected tag).
    /// Keys and messages are built rather than pasted as hex, because a run
    /// of 131 repeated bytes is exactly where a transcription error hides;
    /// the first draft of this table was one byte short in case 3 and eight
    /// bytes long in cases 6 and 7. Case 5 is the truncated-output case,
    /// compared on its first 16 bytes, which is what HMAC-SHA-256-128 means.
    fn rfc4231() -> Vec<(Vec<u8>, Vec<u8>, &'static str)> {
        vec![
            (
                vec![0x0b; 20],
                b"Hi There".to_vec(),
                "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
            ),
            (
                b"Jefe".to_vec(),
                b"what do ya want for nothing?".to_vec(),
                "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
            ),
            (
                vec![0xaa; 20],
                vec![0xdd; 50],
                "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe",
            ),
            (
                (0x01u8..=0x19).collect(),
                vec![0xcd; 50],
                "82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b",
            ),
            (
                vec![0x0c; 20],
                b"Test With Truncation".to_vec(),
                "a3b6167473100ee06e0c796c2955552b",
            ),
            (
                vec![0xaa; 131],
                b"Test Using Larger Than Block-Size Key - Hash Key First".to_vec(),
                "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
            ),
            (
                vec![0xaa; 131],
                b"This is a test using a larger than block-size key and a larger \
                  than block-size data. The key needs to be hashed before being \
                  used by the HMAC algorithm."
                    .to_vec(),
                "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2",
            ),
        ]
    }

    #[test]
    fn rfc4231_test_cases() {
        let cases = rfc4231();
        assert_eq!(cases.len(), 7);
        for (case, (key, data, want)) in cases.iter().enumerate() {
            let tag = hmac_sha256(key, data);
            let n = want.len() / 2;
            assert_eq!(
                hex::encode(&tag[..n]),
                *want,
                "RFC 4231 test case {}",
                case + 1
            );
        }
    }

    #[test]
    fn key_at_and_around_the_block_boundary() {
        // 64 bytes is used as-is; 65 is hashed first. A key of exactly 64
        // bytes and its digest must not agree, or the branch is inverted.
        let sixty_four = vec![0xaau8; 64];
        let sixty_five = vec![0xaau8; 65];
        assert_ne!(
            hmac_sha256(&sixty_four, b"m"),
            hmac_sha256(&sixty_five, b"m")
        );
        assert_eq!(
            hmac_sha256(&sixty_five, b"m"),
            hmac_sha256(&sha256(&sixty_five), b"m"),
            "a key longer than the block equals HMAC under its digest"
        );
        // RFC 2104 zero-pads a short key, so an empty key and a key of one
        // zero byte ARE the same key. Pinned deliberately: a caller must
        // never treat key length as a distinguisher, and every secret in
        // obsync is a fixed 32 bytes for that reason.
        assert_eq!(hmac_sha256(b"", b"m"), hmac_sha256(&[0u8], b"m"));
        assert_eq!(hmac_sha256(b"", b"m"), hmac_sha256(&[0u8; 64], b"m"));
    }

    #[test]
    fn streaming_equals_one_shot() {
        let key = b"obsync/v1 device secret sentinel";
        let mut state = 0x4dac_5eed_u64;
        for len in [0usize, 1, 63, 64, 65, 127, 128, 1000] {
            let data: Vec<u8> = (0..len)
                .map(|_| {
                    state = state
                        .wrapping_mul(6364136223846793005)
                        .wrapping_add(1442695040888963407);
                    (state >> 33) as u8
                })
                .collect();
            let want = hmac_sha256(key, &data);
            let mut mac = HmacSha256::new(key);
            let mut at = 0;
            let mut piece = 1;
            while at < data.len() {
                let end = (at + piece).min(data.len());
                mac.update(&data[at..end]);
                at = end;
                piece = piece % 31 + 1;
            }
            assert_eq!(mac.finalize(), want, "split tag differs at len {len}");
        }
    }

    #[test]
    fn a_changed_key_or_message_changes_the_tag() {
        let base = hmac_sha256(b"key", b"message");
        assert_ne!(base, hmac_sha256(b"kex", b"message"));
        assert_ne!(base, hmac_sha256(b"key", b"messagf"));
        assert_ne!(base, hmac_sha256(b"key", b"message "));
    }
}
