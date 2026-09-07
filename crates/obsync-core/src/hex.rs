//! Lowercase hexadecimal (RFC 4648 section 8, "base16"), encode and decode.
//!
//! The wire protocol is hex almost everywhere: device ids, nonces,
//! signatures, storage ids and version ids are all lowercase
//! hex (`docs/protocol.md`, "Authentication" and "Chunks"). Encoding emits
//! lowercase only; decoding accepts either case, because an operator pasting
//! a key from another tool should not be defeated by capitalisation.
//!
//! Security notes. Decoding is not constant-time: it reports the index of
//! the first invalid character, which is exactly the diagnostic an operator
//! needs and reveals nothing that the caller did not already send. Secret
//! material compared after decoding is compared with [`crate::ct::eq`],
//! never with `==`.

/// Why a hex string could not be decoded.
#[derive(Debug, PartialEq, Eq)]
pub enum HexError {
    /// The input had an odd number of characters, so some byte is half
    /// written.
    OddLength,
    /// The character at this byte index of the input is not `[0-9a-fA-F]`.
    InvalidChar {
        /// Byte index into the input string.
        index: usize,
    },
    /// A fixed-width decode saw the wrong number of bytes. Both counts are
    /// decoded bytes, not input characters.
    WrongLength {
        /// Bytes the caller asked for.
        expected: usize,
        /// Bytes the input would decode to.
        actual: usize,
    },
}

/// The 16 lowercase digits, indexed by nibble value.
const DIGITS: [u8; 16] = *b"0123456789abcdef";

/// One hex character to its nibble value, or `None` if it is not hex.
fn nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// Encode bytes as lowercase hex. Output is exactly `2 * bytes.len()` ASCII
/// characters.
pub fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[usize::from(b >> 4)] as char);
        out.push(DIGITS[usize::from(b & 0x0f)] as char);
    }
    out
}

/// Decode hex of either case into bytes.
pub fn decode(text: &str) -> Result<Vec<u8>, HexError> {
    let src = text.as_bytes();
    if !src.len().is_multiple_of(2) {
        return Err(HexError::OddLength);
    }
    let mut out = Vec::with_capacity(src.len() / 2);
    let (pairs, _) = src.as_chunks::<2>();
    for (i, pair) in pairs.iter().enumerate() {
        out.push(byte_at(pair, i * 2)?);
    }
    Ok(out)
}

/// Decode hex of either case into exactly `N` bytes.
///
/// Fixed-width fields (a 32-hex device id, a 64-hex sid) use this so a short
/// or long value is refused before it reaches any comparison, and so no
/// allocation happens on the refusal path.
pub fn decode_array<const N: usize>(text: &str) -> Result<[u8; N], HexError> {
    let src = text.as_bytes();
    if !src.len().is_multiple_of(2) {
        return Err(HexError::OddLength);
    }
    if src.len() != N * 2 {
        return Err(HexError::WrongLength {
            expected: N,
            actual: src.len() / 2,
        });
    }
    let mut out = [0u8; N];
    let (pairs, _) = src.as_chunks::<2>();
    for (i, (slot, pair)) in out.iter_mut().zip(pairs.iter()).enumerate() {
        *slot = byte_at(pair, i * 2)?;
    }
    Ok(out)
}

/// One byte from a two-character pair whose first character sits at `index`
/// in the input.
fn byte_at(pair: &[u8; 2], index: usize) -> Result<u8, HexError> {
    let hi = nibble(pair[0]).ok_or(HexError::InvalidChar { index })?;
    let lo = nibble(pair[1]).ok_or(HexError::InvalidChar { index: index + 1 })?;
    Ok(hi << 4 | lo)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc4648_section_10_base16() {
        // RFC 4648 section 10 lists BASE16 in uppercase; obsync emits the
        // lowercase form the protocol requires.
        assert_eq!(encode(b""), "");
        assert_eq!(encode(b"f"), "66");
        assert_eq!(encode(b"fo"), "666f");
        assert_eq!(encode(b"foo"), "666f6f");
        assert_eq!(encode(b"foob"), "666f6f62");
        assert_eq!(encode(b"fooba"), "666f6f6261");
        assert_eq!(encode(b"foobar"), "666f6f626172");
    }

    #[test]
    fn decode_accepts_either_case() {
        assert_eq!(decode("666F6F626172"), Ok(b"foobar".to_vec()));
        assert_eq!(decode("666f6f626172"), Ok(b"foobar".to_vec()));
        assert!(decode("66 6f").is_err(), "whitespace is not hex");
    }

    #[test]
    fn round_trip_every_length_to_64() {
        let mut state = 0x4ec0_de5e_ed01_u64;
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
            assert_eq!(text.len(), len * 2);
            assert!(
                text.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            );
            assert_eq!(decode(&text), Ok(data.clone()), "round trip at len {len}");
            assert_eq!(decode(&text.to_ascii_uppercase()), Ok(data));
        }
    }

    #[test]
    fn rejects_odd_length() {
        assert_eq!(decode("a"), Err(HexError::OddLength));
        assert_eq!(decode("abc"), Err(HexError::OddLength));
        assert_eq!(decode_array::<1>("abc"), Err(HexError::OddLength));
    }

    #[test]
    fn rejects_non_hex_with_its_index() {
        assert_eq!(decode("0g"), Err(HexError::InvalidChar { index: 1 }));
        assert_eq!(decode("g0"), Err(HexError::InvalidChar { index: 0 }));
        assert_eq!(decode("00zz"), Err(HexError::InvalidChar { index: 2 }));
        assert_eq!(decode("0011223z"), Err(HexError::InvalidChar { index: 7 }));
        // Non-ASCII input must not panic on a byte boundary either.
        assert!(decode("00é0").is_err());
    }

    #[test]
    fn decode_array_is_exact() {
        assert_eq!(decode_array::<3>("666f6f"), Ok([0x66, 0x6f, 0x6f]));
        assert_eq!(
            decode_array::<4>("666f6f"),
            Err(HexError::WrongLength {
                expected: 4,
                actual: 3
            })
        );
        assert_eq!(
            decode_array::<2>("666f6f"),
            Err(HexError::WrongLength {
                expected: 2,
                actual: 3
            })
        );
        assert_eq!(decode_array::<0>(""), Ok([]));
        assert_eq!(
            decode_array::<32>("zz").unwrap_err(),
            HexError::WrongLength {
                expected: 32,
                actual: 1
            },
            "length is checked before content, so no allocation happens"
        );
    }
}
