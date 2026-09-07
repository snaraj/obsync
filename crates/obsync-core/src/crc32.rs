//! CRC-32 (IEEE 802.3), the journal frame checksum.
//!
//! Every journal frame is `u32 len | u32 crc32 | payload` and replay stops
//! at the first torn or CRC-failing frame (`docs/storage.md`, "Journal").
//! The parameters are the ubiquitous ones: reflected input and output,
//! polynomial `0xedb88320` (the reflection of `0x04c11db7`), initial value
//! and final xor `0xffffffff`. The check value for `"123456789"` is
//! `0xcbf43926`.
//!
//! Security notes. CRC-32 detects torn writes and bit rot, never tampering:
//! it is trivially forgeable and is used nowhere near an authentication or
//! integrity decision. Chunk integrity is SHA-256 over the ciphertext
//! (`sid`), and request integrity is HMAC-SHA-256.

/// Reflected polynomial: the reflection of the IEEE 802.3 `0x04c11db7`.
const POLY: u32 = 0xedb8_8320;

/// Byte-at-a-time table, built at compile time so no allocation, no lazy
/// initialisation and no `build.rs` are involved.
const TABLE: [u32; 256] = build_table();

const fn build_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut crc = i as u32;
        let mut bit = 0;
        while bit < 8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ POLY
            } else {
                crc >> 1
            };
            bit += 1;
        }
        table[i] = crc;
        i += 1;
    }
    table
}

/// Streaming CRC-32 state, for a frame whose payload is written in pieces.
#[derive(Clone)]
pub struct Crc32 {
    /// The running value before the final xor.
    state: u32,
}

impl Crc32 {
    /// A fresh checksum over the empty message.
    pub fn new() -> Self {
        Self { state: !0 }
    }

    /// Absorb the next slice. How a message is split across calls never
    /// changes the checksum.
    pub fn update(&mut self, data: &[u8]) {
        let mut crc = self.state;
        for b in data {
            crc = TABLE[usize::from((crc as u8) ^ b)] ^ (crc >> 8);
        }
        self.state = crc;
    }

    /// The checksum. The state is consumed so a finalized value can never be
    /// updated further.
    pub fn finalize(self) -> u32 {
        !self.state
    }
}

impl Default for Crc32 {
    fn default() -> Self {
        Self::new()
    }
}

/// CRC-32 of one contiguous message.
pub fn crc32(data: &[u8]) -> u32 {
    let mut c = Crc32::new();
    c.update(data);
    c.finalize()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_value() {
        // The standard CRC catalogue check value for CRC-32/ISO-HDLC.
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
    }

    #[test]
    fn empty_and_short_messages() {
        assert_eq!(crc32(b""), 0);
        assert_eq!(crc32(b"a"), 0xe8b7_be43);
        assert_eq!(crc32(b"abc"), 0x3524_41c2);
        assert_eq!(crc32(&[0u8; 32]), 0x190a_55ad);
    }

    #[test]
    fn streaming_equals_one_shot() {
        let mut state = 0xc0de_c0de_u64;
        for len in [0usize, 1, 7, 8, 9, 255, 256, 1023, 4096] {
            let data: Vec<u8> = (0..len)
                .map(|_| {
                    state = state
                        .wrapping_mul(6364136223846793005)
                        .wrapping_add(1442695040888963407);
                    (state >> 33) as u8
                })
                .collect();
            let want = crc32(&data);
            let mut c = Crc32::new();
            let mut at = 0;
            let mut piece = 1;
            while at < data.len() {
                let end = (at + piece).min(data.len());
                c.update(&data[at..end]);
                at = end;
                piece = piece % 13 + 1;
            }
            assert_eq!(c.finalize(), want, "split checksum differs at len {len}");
        }
    }

    #[test]
    fn detects_every_single_bit_flip_in_a_frame_header() {
        // A torn journal frame must not replay: flipping any one bit of a
        // 64-byte payload has to change the checksum.
        let payload = [0x5au8; 64];
        let want = crc32(&payload);
        for byte in 0..payload.len() {
            for bit in 0..8 {
                let mut torn = payload;
                torn[byte] ^= 1 << bit;
                assert_ne!(crc32(&torn), want, "missed bit {bit} of byte {byte}");
            }
        }
    }

    #[test]
    fn default_matches_new() {
        assert_eq!(Crc32::default().finalize(), Crc32::new().finalize());
    }
}
