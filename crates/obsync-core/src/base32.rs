//! Base32 (RFC 4648 section 6): lowercase and unpadded on the way out,
//! forgiving of case and optional padding on the way in.
//!
//! One value in obsync is base32: the pairing code a user reads off one
//! device and types into another, `base32(pairing_id || enroll_token || PS)`
//! (`docs/architecture.md`, section 4.2). That is why the alphabet is base32
//! rather than base64 — no case confusion between `l` and `I`, no `0`/`O`,
//! no characters a URL or a chat client would mangle — and why encoding
//! omits the `=` padding, which only adds characters for a person to type.
//! Decoding accepts either case and accepts padding, because the code may
//! arrive from a QR reader or a password manager that added it.
//!
//! Security notes. A pairing code carries a secret (`PS`), so the decoder is
//! strict about everything except case and padding: an invalid character,
//! an impossible length, or trailing bits that the decoded bytes do not use
//! are all refusals. Case folding is over ASCII only and cannot merge two
//! distinct symbols.

/// RFC 4648's base32 alphabet, in the lowercase form this module emits.
const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

/// Why a base32 string could not be decoded.
#[derive(Debug, PartialEq, Eq)]
pub enum Base32Error {
    /// A symbol count that no byte string encodes to. Base32 groups are 8
    /// symbols, and a partial group is 2, 4, 5 or 7 symbols; anything else
    /// is truncated or padded input.
    BadLength {
        /// Symbols in the input, not counting trailing padding.
        len: usize,
    },
    /// The character at this byte index is not in the alphabet.
    InvalidChar {
        /// Byte index into the input string.
        index: usize,
    },
    /// Padding that does not fill the final group to 8 symbols.
    BadPadding {
        /// Length of the whole input, padding included.
        len: usize,
    },
    /// The final symbol carries bits the decoded bytes do not use, so the
    /// same bytes have a second encoding.
    NonCanonical {
        /// Byte index of the character carrying the stray bits.
        index: usize,
    },
}

/// One base32 character, either case, to its 5-bit value.
fn value(c: u8) -> Option<u8> {
    match c {
        b'a'..=b'z' => Some(c - b'a'),
        b'A'..=b'Z' => Some(c - b'A'),
        b'2'..=b'7' => Some(c - b'2' + 26),
        _ => None,
    }
}

/// Encode bytes as lowercase base32 with no padding.
pub fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(5) * 8);
    let mut acc: u16 = 0;
    let mut bits: u32 = 0;
    for b in bytes {
        acc = (acc << 8) | u16::from(*b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[usize::from((acc >> bits) & 0x1f)] as char);
        }
    }
    if bits > 0 {
        out.push(ALPHABET[usize::from((acc << (5 - bits)) & 0x1f)] as char);
    }
    out
}

/// Decode base32 of either case, with or without padding.
pub fn decode(text: &str) -> Result<Vec<u8>, Base32Error> {
    let src = text.as_bytes();
    let pad = src.iter().rev().take_while(|c| **c == b'=').count();
    let data_len = src.len() - pad;

    // Padding, when present, fills the final group to exactly 8 symbols.
    // Padding elsewhere in the string is not stripped here and fails below
    // as an invalid character.
    if pad > 0 && (pad > 6 || data_len % 8 + pad != 8) {
        return Err(Base32Error::BadPadding { len: src.len() });
    }
    if !matches!(data_len % 8, 0 | 2 | 4 | 5 | 7) {
        return Err(Base32Error::BadLength { len: data_len });
    }

    let mut out = Vec::with_capacity(data_len * 5 / 8);
    let mut acc: u16 = 0;
    let mut bits: u32 = 0;
    for (i, c) in src[..data_len].iter().enumerate() {
        let quintet = value(*c).ok_or(Base32Error::InvalidChar { index: i })?;
        acc = (acc << 5) | u16::from(quintet);
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    // The accepted lengths leave 0, 1, 2, 3 or 4 bits over, never a whole
    // unused symbol, and every leftover bit must be zero.
    if bits > 0 && acc & ((1 << bits) - 1) != 0 {
        return Err(Base32Error::NonCanonical {
            index: data_len - 1,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 4648 section 10, in this module's unpadded lowercase form beside
    /// the RFC's own padded uppercase text.
    const RFC4648: &[(&[u8], &str, &str)] = &[
        (b"", "", ""),
        (b"f", "my", "MY======"),
        (b"fo", "mzxq", "MZXQ===="),
        (b"foo", "mzxw6", "MZXW6==="),
        (b"foob", "mzxw6yq", "MZXW6YQ="),
        (b"fooba", "mzxw6ytb", "MZXW6YTB"),
        (b"foobar", "mzxw6ytboi", "MZXW6YTBOI======"),
    ];

    #[test]
    fn rfc4648_section_10_vectors() {
        for (bytes, lower, rfc) in RFC4648 {
            assert_eq!(encode(bytes), *lower, "encoding is lowercase, unpadded");
            assert_eq!(decode(lower), Ok(bytes.to_vec()));
            assert_eq!(decode(rfc), Ok(bytes.to_vec()), "the RFC's padded form");
            assert_eq!(
                decode(&lower.to_ascii_uppercase()),
                Ok(bytes.to_vec()),
                "unpadded uppercase"
            );
        }
    }

    #[test]
    fn the_whole_alphabet_round_trips() {
        // Pack the quintets 0..32 into 20 bytes: encoding them must produce
        // the alphabet itself, in order.
        let mut all = Vec::with_capacity(20);
        let mut acc: u64 = 0;
        for (i, q) in (0u64..32).enumerate() {
            acc = (acc << 5) | q;
            if (i + 1) % 8 == 0 {
                all.extend_from_slice(&acc.to_be_bytes()[3..]);
                acc = 0;
            }
        }
        assert_eq!(encode(&all).as_bytes(), ALPHABET.as_slice());
        assert_eq!(decode(&encode(&all)), Ok(all));
    }

    #[test]
    fn round_trip_every_length_to_64() {
        let mut state = 0xb32_5eed_u64;
        for len in 0..=64usize {
            let data: Vec<u8> = (0..len)
                .map(|_| {
                    state = state
                        .wrapping_mul(6364136223846793005)
                        .wrapping_add(1442695040888963407);
                    (state >> 33) as u8
                })
                .collect();
            let text = encode(&data);
            assert_eq!(text.len(), (len * 8).div_ceil(5), "length at {len}");
            assert!(
                text.bytes()
                    .all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b))
            );
            assert_eq!(decode(&text), Ok(data.clone()), "round trip at len {len}");
            assert_eq!(decode(&text.to_ascii_uppercase()), Ok(data));
        }
    }

    #[test]
    fn rejects_impossible_lengths() {
        // 1, 3 and 6 symbols are the counts no byte string encodes to.
        assert_eq!(decode("m"), Err(Base32Error::BadLength { len: 1 }));
        assert_eq!(decode("mzx"), Err(Base32Error::BadLength { len: 3 }));
        assert_eq!(decode("mzxw6y"), Err(Base32Error::BadLength { len: 6 }));
        assert_eq!(
            decode("mzxw6ytboim"),
            Err(Base32Error::BadLength { len: 11 })
        );
    }

    #[test]
    fn rejects_characters_outside_the_alphabet() {
        assert_eq!(decode("m0"), Err(Base32Error::InvalidChar { index: 1 }));
        assert_eq!(decode("m1"), Err(Base32Error::InvalidChar { index: 1 }));
        assert_eq!(decode("m8"), Err(Base32Error::InvalidChar { index: 1 }));
        assert_eq!(decode("m y"), Err(Base32Error::BadLength { len: 3 }));
        assert_eq!(decode("m=y"), Err(Base32Error::BadLength { len: 3 }));
        assert_eq!(
            decode("mzxw=6yq"),
            Err(Base32Error::InvalidChar { index: 4 }),
            "padding inside the string is an invalid character, not padding"
        );
    }

    #[test]
    fn rejects_padding_that_does_not_fill_the_group() {
        assert_eq!(decode("my====="), Err(Base32Error::BadPadding { len: 7 }));
        assert_eq!(decode("my======="), Err(Base32Error::BadPadding { len: 9 }));
        assert_eq!(decode("mzxw6ytb="), Err(Base32Error::BadPadding { len: 9 }));
        assert_eq!(decode("========"), Err(Base32Error::BadPadding { len: 8 }));
    }

    #[test]
    fn rejects_non_canonical_trailing_bits() {
        // "my" is the canonical encoding of b"f"; the second symbol carries
        // two bits the decoded byte does not use.
        assert_eq!(decode("my"), Ok(b"f".to_vec()));
        assert_eq!(decode("mz"), Err(Base32Error::NonCanonical { index: 1 }));
        let mut accepted = 0;
        let mut refused = 0;
        for c in ALPHABET.iter() {
            let text = format!("m{}", *c as char);
            match decode(&text) {
                Ok(bytes) => {
                    assert_eq!(bytes.len(), 1);
                    accepted += 1;
                }
                Err(Base32Error::NonCanonical { index: 1 }) => refused += 1,
                other => panic!("unexpected verdict for {text}: {other:?}"),
            }
        }
        assert_eq!(
            (accepted, refused),
            (8, 24),
            "exactly the symbols whose low two bits are zero are canonical"
        );
    }
}
