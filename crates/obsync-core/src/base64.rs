//! Base64 (RFC 4648 section 4): the standard alphabet, always padded.
//!
//! Ciphertext travels through JSON as base64: the encrypted manifest
//! (`manifest_ct`) on every version append and the pairing envelope
//! (`docs/protocol.md`, "Files and versions" and "Pairing"). The device side
//! produces these with the browser's own base64, so this decoder has to
//! accept exactly what RFC 4648 defines and nothing more.
//!
//! Security notes. Decoding is strict on purpose. A permissive decoder that
//! ignores whitespace, accepts the URL-safe alphabet, or drops the trailing
//! bits of a final group gives two different byte strings the same encoding,
//! and a value that can be re-encoded differently is a value that can be
//! smuggled past a signature computed over its text form. Non-canonical
//! trailing bits are a refusal here, not a rounding.

/// The standard alphabet (RFC 4648 section 4). Not the URL-safe one: the
/// values that reach this decoder are JSON string fields, never path
/// segments.
const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Why a base64 string could not be decoded.
#[derive(Debug, PartialEq, Eq)]
pub enum Base64Error {
    /// The input length is not a multiple of 4, so it is not padded base64.
    BadLength {
        /// Length of the input in characters.
        len: usize,
    },
    /// The character at this byte index is not in the standard alphabet.
    InvalidChar {
        /// Byte index into the input string.
        index: usize,
    },
    /// Padding appears where it cannot: before the final group, in the
    /// middle of a group, or more than twice.
    BadPadding {
        /// Byte index of the first offending `=`.
        index: usize,
    },
    /// The final group carries bits that the decoded bytes do not use, so
    /// the same bytes have a second encoding.
    NonCanonical {
        /// Byte index of the character carrying the stray bits.
        index: usize,
    },
}

/// One base64 character to its 6-bit value, or `None` if it is not in the
/// alphabet.
fn value(c: u8) -> Option<u8> {
    match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// Push the top `count` sextets of a 24-bit group.
fn push_group(out: &mut String, group: u32, count: u32) {
    for i in 0..count {
        let sextet = (group >> (18 - 6 * i)) & 0x3f;
        out.push(ALPHABET[sextet as usize] as char);
    }
}

/// Encode bytes as padded base64.
pub fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let (triples, rest) = bytes.as_chunks::<3>();
    for t in triples {
        push_group(
            &mut out,
            (u32::from(t[0]) << 16) | (u32::from(t[1]) << 8) | u32::from(t[2]),
            4,
        );
    }
    match rest {
        [a] => {
            push_group(&mut out, u32::from(*a) << 16, 2);
            out.push_str("==");
        }
        [a, b] => {
            push_group(&mut out, (u32::from(*a) << 16) | (u32::from(*b) << 8), 3);
            out.push('=');
        }
        _ => {}
    }
    out
}

/// Decode padded base64. Whitespace, line breaks and the URL-safe alphabet
/// are all refusals.
pub fn decode(text: &str) -> Result<Vec<u8>, Base64Error> {
    let src = text.as_bytes();
    if !src.len().is_multiple_of(4) {
        return Err(Base64Error::BadLength { len: src.len() });
    }
    let (groups, _) = src.as_chunks::<4>();
    let mut out = Vec::with_capacity(groups.len() * 3);

    for (gi, group) in groups.iter().enumerate() {
        let base = gi * 4;
        let last = gi + 1 == groups.len();

        // Padding is legal only as a one- or two-character suffix of the
        // final group.
        let pad = match group.iter().position(|c| *c == b'=') {
            None => 0,
            Some(at) => {
                let pad = 4 - at;
                if !last || pad > 2 || group[at..].iter().any(|c| *c != b'=') {
                    return Err(Base64Error::BadPadding { index: base + at });
                }
                pad
            }
        };

        let mut acc: u32 = 0;
        for (i, c) in group.iter().take(4 - pad).enumerate() {
            let sextet = value(*c).ok_or(Base64Error::InvalidChar { index: base + i })?;
            acc = (acc << 6) | u32::from(sextet);
        }
        // Left-align to a full 24-bit group; the padded-away sextets become
        // zeros, and any bit the decoded bytes do not carry must already be
        // zero or the encoding is not canonical.
        acc <<= 6 * pad;
        let bytes = acc.to_be_bytes();
        if pad == 1 && bytes[3] != 0 {
            return Err(Base64Error::NonCanonical { index: base + 2 });
        }
        if pad == 2 && bytes[2] != 0 {
            return Err(Base64Error::NonCanonical { index: base + 1 });
        }

        out.push(bytes[1]);
        if pad < 2 {
            out.push(bytes[2]);
        }
        if pad == 0 {
            out.push(bytes[3]);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 4648 section 10.
    const RFC4648: &[(&[u8], &str)] = &[
        (b"", ""),
        (b"f", "Zg=="),
        (b"fo", "Zm8="),
        (b"foo", "Zm9v"),
        (b"foob", "Zm9vYg=="),
        (b"fooba", "Zm9vYmE="),
        (b"foobar", "Zm9vYmFy"),
    ];

    #[test]
    fn rfc4648_section_10_vectors() {
        for (bytes, text) in RFC4648 {
            assert_eq!(encode(bytes), *text);
            assert_eq!(decode(text), Ok(bytes.to_vec()));
        }
    }

    #[test]
    fn the_whole_alphabet_round_trips() {
        // Pack the sextets 0..64 into 48 bytes: encoding them must produce
        // the alphabet itself, in order, which pins every symbol's value.
        let mut all = Vec::with_capacity(48);
        for quad in (0u32..64).collect::<Vec<u32>>().chunks(4) {
            let group = (quad[0] << 18) | (quad[1] << 12) | (quad[2] << 6) | quad[3];
            all.extend_from_slice(&group.to_be_bytes()[1..]);
        }
        let text = encode(&all);
        assert_eq!(text.as_bytes(), ALPHABET.as_slice());
        assert_eq!(decode(&text), Ok(all));
        assert_eq!(encode(&[0xff, 0xff, 0xff]), "////");
        assert_eq!(encode(&[0xfb, 0xff, 0xbf]), "+/+/");
    }

    #[test]
    fn round_trip_every_length_to_64() {
        let mut state = 0xb64_5eed_u64;
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
            assert_eq!(text.len(), len.div_ceil(3) * 4, "length at {len}");
            assert_eq!(decode(&text), Ok(data), "round trip at len {len}");
        }
    }

    #[test]
    fn rejects_a_length_that_is_not_a_group() {
        assert_eq!(decode("Zg="), Err(Base64Error::BadLength { len: 3 }));
        assert_eq!(decode("Zm9vYmFy="), Err(Base64Error::BadLength { len: 9 }));
        assert_eq!(decode("Z"), Err(Base64Error::BadLength { len: 1 }));
    }

    #[test]
    fn rejects_characters_outside_the_alphabet() {
        assert_eq!(decode("Zg-="), Err(Base64Error::InvalidChar { index: 2 }));
        assert_eq!(decode("Zm9-"), Err(Base64Error::InvalidChar { index: 3 }));
        assert_eq!(decode("Zm 9"), Err(Base64Error::InvalidChar { index: 2 }));
        // The URL-safe alphabet is a different encoding, not a variant.
        assert_eq!(decode("Zm9_"), Err(Base64Error::InvalidChar { index: 3 }));
        assert_eq!(decode("\nZm9v"), Err(Base64Error::BadLength { len: 5 }));
    }

    #[test]
    fn rejects_misplaced_padding() {
        // Padding before the final group.
        assert_eq!(
            decode("Zg==Zg=="),
            Err(Base64Error::BadPadding { index: 2 })
        );
        // Three or four padding characters.
        assert_eq!(decode("Z==="), Err(Base64Error::BadPadding { index: 1 }));
        assert_eq!(decode("===="), Err(Base64Error::BadPadding { index: 0 }));
        // Padding inside the group rather than as a suffix.
        assert_eq!(decode("Z=g="), Err(Base64Error::BadPadding { index: 1 }));
    }

    #[test]
    fn rejects_non_canonical_trailing_bits() {
        // "Zg==" is the canonical encoding of b"f"; "Zh==" carries four bits
        // the single decoded byte does not use.
        assert_eq!(decode("Zg=="), Ok(b"f".to_vec()));
        assert_eq!(decode("Zh=="), Err(Base64Error::NonCanonical { index: 1 }));
        // "Zm8=" is canonical for b"fo"; "Zm9=" carries two stray bits.
        assert_eq!(decode("Zm8="), Ok(b"fo".to_vec()));
        assert_eq!(decode("Zm9="), Err(Base64Error::NonCanonical { index: 2 }));
        // Every alternative final symbol must be refused, or a value has two
        // encodings and a signature over its text form is forgeable.
        let mut accepted = 0;
        let mut refused = 0;
        for c in ALPHABET.iter() {
            let text = format!("Zm{}=", *c as char);
            match decode(&text) {
                Ok(bytes) => {
                    assert_eq!(bytes[0], b'f');
                    accepted += 1;
                }
                Err(Base64Error::NonCanonical { index: 2 }) => refused += 1,
                other => panic!("unexpected verdict for {text}: {other:?}"),
            }
        }
        assert_eq!(
            (accepted, refused),
            (16, 48),
            "exactly the symbols whose low two bits are zero are canonical"
        );
    }
}
