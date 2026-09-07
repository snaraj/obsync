//! Constant-time byte comparison.
//!
//! Every comparison of secret material goes through here: the request
//! signature against the recomputed HMAC, the enrolment token against the
//! stored one, the CSRF header against the cookie (`docs/architecture.md`,
//! sections 3.5 and 4.2). `==` on byte slices short-circuits at the first
//! differing byte, which lets a caller who can measure the reply time
//! recover a secret one byte at a time; that is the attack this module
//! exists to make impossible by construction.
//!
//! Construction, so a reviewer can check the property rather than trust it:
//! one accumulator, `|=` only, no `return` inside the loop, no `if` on any
//! byte value, no lookup indexed by data. The only branch in the module is
//! the caller's own test of the final `bool`.

/// True when both slices hold the same bytes, in time that depends on the
/// lengths alone.
///
/// Unequal lengths still iterate the full length of the shorter slice, and
/// the length difference is folded into the same accumulator rather than
/// returned early. Lengths are public — a sid is 32 bytes, a signature is
/// 32 bytes, and an attacker knows what it sent — but an early return on
/// mismatched lengths would put a data-dependent exit inside the function
/// and invite a later edit to add a second one. One exit, one accumulator,
/// one property to review.
pub fn eq(a: &[u8], b: &[u8]) -> bool {
    let mut acc = a.len() ^ b.len();
    for (x, y) in a.iter().zip(b.iter()) {
        acc |= usize::from(x ^ y);
    }
    acc == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// AGENTS.md, "Testing doctrine": constant-time comparison ships a test
    /// that proves early exit is impossible BY CONSTRUCTION. No behavioural
    /// test can see a timing leak — a function that returns early still
    /// returns the right answer — so this one reads the function's own
    /// source, embedded at compile time, and pins its shape. A future edit
    /// that adds a fast path has to delete this test to land, which is the
    /// point.
    #[test]
    fn eq_has_one_exit_one_accumulator_and_no_branch_on_data() {
        let source = include_str!("ct.rs");
        let from = source
            .find("pub fn eq(a: &[u8], b: &[u8]) -> bool {")
            .expect("eq is defined in this file");
        let body = &source[from..];
        let body = &body[..body.find("\n}\n").expect("eq's body ends here")];

        for forbidden in ["return", "break", "continue", "?", " if ", "match "] {
            assert!(
                !body.contains(forbidden),
                "eq must not contain {forbidden:?}: it would be an exit or a \
                 branch that can depend on a byte value"
            );
        }
        assert_eq!(body.matches("let mut acc").count(), 1, "one accumulator");
        assert_eq!(body.matches("acc |=").count(), 1, "accumulated with |=");
        assert_eq!(
            body.matches("acc").count(),
            3,
            "acc appears exactly three times: declared, or-ed into, tested \
             once at the end. A fourth use is a second decision"
        );
    }

    #[test]
    fn equal_slices() {
        assert!(eq(b"", b""));
        assert!(eq(b"a", b"a"));
        assert!(eq(&[0u8; 32], &[0u8; 32]));
        assert!(eq(b"obsync/v1 signature", b"obsync/v1 signature"));
    }

    #[test]
    fn differs_at_first_byte() {
        assert!(!eq(b"Xbsync", b"obsync"));
        assert!(!eq(&[1, 0, 0, 0], &[0, 0, 0, 0]));
    }

    #[test]
    fn differs_at_last_byte() {
        assert!(!eq(b"obsynX", b"obsync"));
        assert!(!eq(&[0, 0, 0, 1], &[0, 0, 0, 0]));
    }

    #[test]
    fn differs_in_length() {
        assert!(!eq(b"obsync", b"obsyn"));
        assert!(!eq(b"obsyn", b"obsync"));
        assert!(!eq(b"", b"o"));
        assert!(!eq(b"o", b""));
        // A prefix must not pass merely because every compared byte agrees.
        assert!(!eq(&[0u8; 31], &[0u8; 32]));
        // Lengths whose low byte agrees (0 and 256) must still differ: the
        // accumulator is usize-wide, not byte-wide.
        assert!(!eq(&[], &[0u8; 256]));
    }

    #[test]
    fn every_single_byte_difference_is_caught() {
        // Vacuity probe: a comparison that ignored position or value would
        // pass some of these 32 * 255 cases.
        let base = [0x5au8; 32];
        for i in 0..base.len() {
            for delta in 1..=255u8 {
                let mut other = base;
                other[i] ^= delta;
                assert!(
                    !eq(&base, &other),
                    "missed byte {i} flipped by {delta:#04x}"
                );
            }
        }
        assert!(eq(&base, &[0x5au8; 32]));
    }
}
