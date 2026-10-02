//! SHA-256 (FIPS 180-4, section 6.2), streaming and one-shot.
//!
//! The server hashes chunk ciphertext to derive the storage id `sid`
//! (`docs/architecture.md`, section 3.2) and hashes request bodies for the
//! HMAC request signature (section 3.5), so this is the hottest primitive in
//! the process: an upload is hashed once while it streams to disk and again
//! on every scrub pass.
//!
//! Security notes. A digest of a public value is not a secret, so this
//! implementation makes no constant-time claim beyond the one it inherits:
//! the round function is straight-line arithmetic on `u32` words with no
//! table lookup and no branch on message content, so its timing depends on
//! the message length alone. The 64-byte block buffer is not zeroized on
//! drop: it holds ciphertext or a public request body, never key material
//! (`hmac` keeps key material in its own state), and a zeroization that no
//! `unsafe` may enforce against a copying allocator is a claim this crate
//! declines to make.

/// Round constants: the first 32 bits of the fractional parts of the cube
/// roots of the first 64 primes (FIPS 180-4, section 4.2.2).
const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/// Initial hash value: the fractional parts of the square roots of the first
/// eight primes (FIPS 180-4, section 5.3.3).
const H0: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

/// One 64-byte block through the FIPS 180-4 compression function.
///
/// Shaped for the scalar pipeline, the only one this crate may use (no SIMD
/// or SHA instructions without `unsafe`, AGENTS.md requirement 5). The
/// message schedule is a rolling window of 16 words, each computed as the
/// round that needs it arrives, instead of 64 words filled before the first
/// round. The rounds run eight to a turn with the eight working variables'
/// ROLES rotated in the source rather than their values moved along, so a
/// round writes two registers where it wrote eight. `Ch` and `Maj` take their
/// equivalent two- and three-operation forms. Same arithmetic, same digests:
/// the vectors and the differential test below pin it, and it runs about
/// 1.6x the previous loop (`sha256_throughput`, `docs/benchmarks.md`).
/// Nothing allocates, and every index is masked or exact, so none is checked.
#[inline(always)]
fn compress(state: &mut [u32; 8], block: &[u8; 64]) {
    let mut w = [0u32; 16];
    let (words, _) = block.as_chunks::<4>();
    for (word, bytes) in w.iter_mut().zip(words.iter()) {
        *word = u32::from_be_bytes(*bytes);
    }
    // W[t] for t >= 16, written over W[t - 16], its slot in the window.
    macro_rules! schedule {
        ($t:expr) => {{
            let x = w[($t + 1) & 15];
            let y = w[($t + 14) & 15];
            let s0 = x.rotate_right(7) ^ x.rotate_right(18) ^ (x >> 3);
            let s1 = y.rotate_right(17) ^ y.rotate_right(19) ^ (y >> 10);
            w[$t & 15] = w[$t & 15]
                .wrapping_add(s0)
                .wrapping_add(w[($t + 9) & 15])
                .wrapping_add(s1);
            w[$t & 15]
        }};
    }
    // One round, FIPS 180-4 6.2.2 step 3, naming the variables by their
    // role in THIS round: only `d` (becoming the next `e`) and `h` (becoming
    // the next `a`) are written.
    macro_rules! round {
        ($a:ident, $b:ident, $c:ident, $d:ident, $e:ident, $f:ident, $g:ident, $h:ident, $k:expr, $w:expr) => {
            let t1 = $h
                .wrapping_add($e.rotate_right(6) ^ $e.rotate_right(11) ^ $e.rotate_right(25))
                .wrapping_add($g ^ ($e & ($f ^ $g)))
                .wrapping_add($k.wrapping_add($w));
            let t2 = ($a.rotate_right(2) ^ $a.rotate_right(13) ^ $a.rotate_right(22))
                .wrapping_add(($a & $b) | ($c & ($a | $b)));
            $d = $d.wrapping_add(t1);
            $h = t1.wrapping_add(t2);
        };
    }
    let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = *state;
    macro_rules! eight {
        ($k:expr, $w:ident, $t:expr) => {
            round!(a, b, c, d, e, f, g, h, $k[0], $w!($t));
            round!(h, a, b, c, d, e, f, g, $k[1], $w!($t + 1));
            round!(g, h, a, b, c, d, e, f, $k[2], $w!($t + 2));
            round!(f, g, h, a, b, c, d, e, $k[3], $w!($t + 3));
            round!(e, f, g, h, a, b, c, d, $k[4], $w!($t + 4));
            round!(d, e, f, g, h, a, b, c, $k[5], $w!($t + 5));
            round!(c, d, e, f, g, h, a, b, $k[6], $w!($t + 6));
            round!(b, c, d, e, f, g, h, a, $k[7], $w!($t + 7));
        };
    }
    // The first sixteen rounds read the block's own words.
    macro_rules! loaded {
        ($t:expr) => {
            w[$t & 15]
        };
    }

    let (ks, _) = K.as_chunks::<8>();
    for (turn, k) in ks.iter().enumerate() {
        let t = turn * 8;
        if turn < 2 {
            eight!(k, loaded, t);
        } else {
            eight!(k, schedule, t);
        }
    }
    for (word, add) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
        *word = word.wrapping_add(add);
    }
}

/// Streaming SHA-256 state: feed it with [`Sha256::update`], take the digest
/// with [`Sha256::finalize`].
///
/// Streaming exists so a chunk upload is hashed as it is written to its temp
/// file and never buffered whole in memory (`docs/protocol.md`, `PUT
/// /v1/chunks/{sid}`).
#[derive(Clone)]
pub struct Sha256 {
    state: [u32; 8],
    /// Bytes not yet compressed. `len` is always `< 64` between calls.
    buf: [u8; 64],
    len: usize,
    /// Total message length in bytes. Wraps at 2^64 bytes (16 EiB), which no
    /// volume this server addresses can hold.
    total: u64,
}

impl Sha256 {
    /// A fresh hasher over the empty message.
    pub fn new() -> Self {
        Self {
            state: H0,
            buf: [0u8; 64],
            len: 0,
            total: 0,
        }
    }

    /// Absorb the next slice of the message. How a message is split across
    /// calls never changes the digest.
    pub fn update(&mut self, mut data: &[u8]) {
        self.total = self.total.wrapping_add(data.len() as u64);

        if self.len > 0 {
            let take = (64 - self.len).min(data.len());
            self.buf[self.len..self.len + take].copy_from_slice(&data[..take]);
            self.len += take;
            data = &data[take..];
            if self.len < 64 {
                // The whole slice fit in the partial block: `data` is now
                // empty, and returning here keeps `len` as the count of
                // buffered bytes rather than letting the tail path below
                // reset it to the remainder of an empty slice.
                return;
            }
            compress(&mut self.state, &self.buf);
            self.len = 0;
        }

        let (blocks, rest) = data.as_chunks::<64>();
        for block in blocks {
            compress(&mut self.state, block);
        }
        self.buf[..rest.len()].copy_from_slice(rest);
        self.len = rest.len();
    }

    /// Pad per FIPS 180-4 section 5.1.1 and return the 32-byte digest. The
    /// hasher is consumed, so a finalized state can never be updated.
    pub fn finalize(mut self) -> [u8; 32] {
        let bits = self.total.wrapping_mul(8);
        self.buf[self.len] = 0x80;
        self.len += 1;
        if self.len > 56 {
            self.buf[self.len..].fill(0);
            compress(&mut self.state, &self.buf);
            self.len = 0;
        }
        self.buf[self.len..56].fill(0);
        self.buf[56..].copy_from_slice(&bits.to_be_bytes());
        compress(&mut self.state, &self.buf);

        let mut out = [0u8; 32];
        let (slots, _) = out.as_chunks_mut::<4>();
        for (slot, word) in slots.iter_mut().zip(self.state.iter()) {
            *slot = word.to_be_bytes();
        }
        out
    }
}

impl Default for Sha256 {
    fn default() -> Self {
        Self::new()
    }
}

/// SHA-256 of one contiguous message.
pub fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hex;

    /// FIPS 180-4 appendix B.1 and B.2, plus the two NIST example messages.
    const VECTORS: &[(&[u8], &str)] = &[
        (
            b"",
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        ),
        (
            b"abc",
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        ),
        (
            b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
        ),
        (
            b"abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
            "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1",
        ),
    ];

    /// Deterministic byte source: a 64-bit LCG (Knuth's MMIX constants). A
    /// failing case must be reproducible from the seed printed in the test.
    fn lcg(state: &mut u64) -> u64 {
        *state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        *state
    }

    fn bytes(state: &mut u64, len: usize) -> Vec<u8> {
        (0..len).map(|_| (lcg(state) >> 33) as u8).collect()
    }

    #[test]
    fn known_answers() {
        for (message, want) in VECTORS {
            assert_eq!(
                hex::encode(&sha256(message)),
                *want,
                "digest differs for a {}-byte message",
                message.len()
            );
        }
    }

    #[test]
    fn one_million_a_streamed_in_odd_pieces() {
        // FIPS 180-4 appendix B.3: 1,000,000 repetitions of 'a'. Fed in
        // pieces of 1..=97 bytes so every buffer boundary is crossed.
        let all = vec![b'a'; 1_000_000];
        let mut h = Sha256::new();
        let mut at = 0;
        let mut piece = 1;
        while at < all.len() {
            let end = (at + piece).min(all.len());
            h.update(&all[at..end]);
            at = end;
            piece = piece % 97 + 1;
        }
        assert_eq!(
            hex::encode(&h.finalize()),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
    }

    #[test]
    fn streaming_equals_one_shot() {
        let mut seed = 0x0b5_c0de_5eed_u64;
        for len in [0usize, 1, 55, 56, 57, 63, 64, 65, 127, 128, 129, 1000, 4096] {
            let data = bytes(&mut seed, len);
            let want = sha256(&data);
            for round in 0..8 {
                let mut h = Sha256::new();
                let mut at = 0;
                while at < data.len() {
                    let take = ((lcg(&mut seed) % 70) as usize).min(data.len() - at);
                    h.update(&data[at..at + take]);
                    at += take;
                }
                assert_eq!(
                    h.finalize(),
                    want,
                    "split hashing differs at len {len}, round {round}"
                );
            }
        }
    }

    #[test]
    fn default_matches_new() {
        assert_eq!(Sha256::default().finalize(), Sha256::new().finalize());
    }

    /// Locate a host hasher. CI images carry one; a bare container may not.
    fn host_hasher() -> Option<(&'static str, &'static [&'static str])> {
        let candidates: [(&str, &[&str]); 3] = [
            ("shasum", &["-a", "256"]),
            ("sha256sum", &[]),
            ("openssl", &["dgst", "-sha256"]),
        ];
        for (prog, args) in candidates {
            let found = std::process::Command::new(prog)
                .arg("--help")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok();
            if found {
                return Some((prog, args));
            }
        }
        None
    }

    #[test]
    fn differential_against_host_tool() {
        let Some((prog, args)) = host_hasher() else {
            println!(
                "SKIP differential_against_host_tool: no shasum, sha256sum or openssl on PATH"
            );
            return;
        };

        let mut seed = 0xd1ff_e4e5_1a1e_5eed_u64;
        let dir = std::env::temp_dir();
        for case in 0..20u32 {
            let len = (lcg(&mut seed) % (1 << 20)) as usize;
            let data = bytes(&mut seed, len);
            let path = dir.join(format!("obsync-sha256-{}-{case}.bin", std::process::id()));
            std::fs::write(&path, &data).expect("write differential fixture");

            let out = std::process::Command::new(prog)
                .args(args)
                .arg(&path)
                .output()
                .expect("run the host hasher");
            std::fs::remove_file(&path).expect("remove differential fixture");
            assert!(out.status.success(), "{prog} failed on {len} bytes");

            let text = String::from_utf8_lossy(&out.stdout);
            let want = text
                .split_whitespace()
                .find(|t| t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit()))
                .unwrap_or_else(|| panic!("no digest in {prog} output: {text}"));
            assert_eq!(
                hex::encode(&sha256(&data)),
                want.to_ascii_lowercase(),
                "{prog} disagrees on {len} bytes"
            );
        }
        println!("differential_against_host_tool: 20 buffers agreed with {prog}");
    }

    #[test]
    #[ignore = "measurement, not a guard: cargo test --release -p obsync-core -- --ignored sha256_throughput --nocapture"]
    fn sha256_throughput() {
        const BYTES: usize = 256 << 20;
        let mut seed = 0x7_1eaf_c0de_u64;
        let page = bytes(&mut seed, 4096);
        let mut data = vec![0u8; BYTES];
        for slot in data.chunks_mut(4096) {
            let n = slot.len();
            slot.copy_from_slice(&page[..n]);
        }

        let start = std::time::Instant::now();
        let digest = sha256(&data);
        let elapsed = start.elapsed();
        let mb_per_s = BYTES as f64 / 1_000_000.0 / elapsed.as_secs_f64();
        println!(
            "sha256_throughput: {BYTES} bytes in {elapsed:?} = {mb_per_s:.1} MB/s (digest {})",
            hex::encode(&digest)
        );
    }
}
