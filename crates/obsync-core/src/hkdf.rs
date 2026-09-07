//! HKDF-SHA-256 (RFC 5869): extract-then-expand key derivation.
//!
//! The server derives exactly one kind of value with it today: the one-time
//! pad that wraps a device secret at rest, `HKDF(server_key,
//! "obsync/v1/wrap", device_id)` (`docs/architecture.md`, section 3.6). The
//! device side derives domain, manifest and chunk keys with WebCrypto's
//! HKDF over the same construction, so the two implementations must agree
//! byte for byte; that is what the RFC 5869 vectors below pin.
//!
//! Security notes. The output is key material. It is returned as a `Vec`
//! that the caller owns and this crate makes no zeroization claim it cannot
//! enforce without `unsafe`. Nothing here branches on a key byte.

use crate::hmac::{HmacSha256, hmac_sha256};

/// One SHA-256 output block.
const HASH_LEN: usize = 32;

/// RFC 5869's ceiling: the expand counter is one octet, so at most 255
/// blocks can be produced from one PRK.
const MAX_OUT: usize = 255 * HASH_LEN;

/// Derive `out_len` bytes from `ikm` (RFC 5869 sections 2.2 and 2.3:
/// extract with `salt` as the HMAC key, then expand with `info`).
///
/// An empty `salt` is the RFC's own default (it becomes `HashLen` zero
/// bytes, which is what an empty HMAC key already pads to) and an empty
/// `info` is legal.
///
/// # Panics
///
/// Panics if `out_len` exceeds `255 * 32 = 8160` bytes. That is a caller
/// bug, not an input: every derivation in obsync asks for 32 bytes, and the
/// limit is a property of the construction rather than a policy that could
/// be relaxed later.
pub fn hkdf_sha256(ikm: &[u8], salt: &[u8], info: &[u8], out_len: usize) -> Vec<u8> {
    assert!(
        out_len <= MAX_OUT,
        "HKDF-SHA-256 yields at most {MAX_OUT} bytes, asked for {out_len}"
    );

    // Extract: the salt is the HMAC key, the input keying material the
    // message. Swapping the two is the classic HKDF bug, so it is pinned by
    // the PRK assertions in the tests below.
    let prk = hmac_sha256(salt, ikm);

    let mut out = Vec::with_capacity(out_len);
    let mut previous = [0u8; HASH_LEN];
    let blocks = out_len.div_ceil(HASH_LEN);
    for counter in 1..=blocks {
        let mut mac = HmacSha256::new(&prk);
        if counter > 1 {
            mac.update(&previous);
        }
        mac.update(info);
        mac.update(&[counter as u8]);
        previous = mac.finalize();
        let take = (out_len - out.len()).min(HASH_LEN);
        out.extend_from_slice(&previous[..take]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hex;

    fn unhex(text: &str) -> Vec<u8> {
        hex::decode(text).expect("test vector is hex")
    }

    /// The PRK the extract step must produce, exposed for the tests only:
    /// RFC 5869 publishes it per case and a wrong extract with a right
    /// expand still produces plausible-looking output.
    fn prk_of(ikm: &[u8], salt: &[u8]) -> [u8; 32] {
        crate::hmac::hmac_sha256(salt, ikm)
    }

    #[test]
    fn rfc5869_test_case_1() {
        let ikm = unhex("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b");
        let salt = unhex("000102030405060708090a0b0c");
        let info = unhex("f0f1f2f3f4f5f6f7f8f9");
        assert_eq!(
            hex::encode(&prk_of(&ikm, &salt)),
            "077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5"
        );
        assert_eq!(
            hex::encode(&hkdf_sha256(&ikm, &salt, &info, 42)),
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
        );
    }

    #[test]
    fn rfc5869_test_case_2() {
        // The long-input case: 80-byte IKM, salt and info, 82 bytes out, so
        // the expand loop runs three chained blocks.
        let ikm: Vec<u8> = (0x00u8..0x50).collect();
        let salt: Vec<u8> = (0x60u8..0xb0).collect();
        let info: Vec<u8> = (0xb0u8..=0xff).collect();
        assert_eq!(
            hex::encode(&prk_of(&ikm, &salt)),
            "06a6b88c5853361a06104c9ceb35b45cef760014904671014a193f40c15fc244"
        );
        assert_eq!(
            hex::encode(&hkdf_sha256(&ikm, &salt, &info, 82)),
            "b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c\
             59045a99cac7827271cb41c65e590e09da3275600c2f09b8367793a9aca3db71\
             cc30c58179ec3e87c14c01d5c1f3434f1d87"
        );
    }

    #[test]
    fn rfc5869_test_case_3() {
        // Zero-length salt and info: the case obsync's own wrap derivation
        // is closest to.
        let ikm = unhex("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b");
        assert_eq!(
            hex::encode(&prk_of(&ikm, b"")),
            "19ef24a32c717b167f33a91d6f648bdf96596776afdb6377ac434c1c293ccb04"
        );
        assert_eq!(
            hex::encode(&hkdf_sha256(&ikm, b"", b"", 42)),
            "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8"
        );
    }

    #[test]
    fn output_length_is_exact_and_a_prefix() {
        // Asking for fewer bytes must return the prefix of a longer ask, or
        // the block chaining is wrong.
        let full = hkdf_sha256(b"ikm", b"salt", b"info", 96);
        for len in [0usize, 1, 31, 32, 33, 64, 95, 96] {
            let out = hkdf_sha256(b"ikm", b"salt", b"info", len);
            assert_eq!(out.len(), len);
            assert_eq!(out[..], full[..len], "prefix differs at len {len}");
        }
    }

    #[test]
    fn info_and_salt_separate_the_outputs() {
        let a = hkdf_sha256(b"ikm", b"salt", b"obsync/v1/wrap", 32);
        assert_ne!(a, hkdf_sha256(b"ikm", b"salt", b"obsync/v1/chunk", 32));
        assert_ne!(a, hkdf_sha256(b"ikm", b"pepper", b"obsync/v1/wrap", 32));
        assert_ne!(a, hkdf_sha256(b"ikn", b"salt", b"obsync/v1/wrap", 32));
    }

    /// The obsync key ladder, against the device's own fixtures.
    ///
    /// Every constant is copied from `plugin/test/fixtures/crypto.json`,
    /// which WebCrypto produced (`plugin/test/fixtures/generate.mjs`). They
    /// are sentinels, not keys: the vault root key is the bytes 00..1f. If
    /// the two implementations ever disagree about a derivation, this says
    /// which one.
    #[test]
    fn the_obsync_key_ladder_matches_the_device_fixtures() {
        // `fixtures.vrk`.
        let vrk = unhex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
        // `fixtures.domains`: two domains, because the manifest key is
        // per domain (docs/architecture.md 5.1 item 2) and one domain cannot
        // show that a derivation is scoped.
        let domains = [
            (
                "0123456789abcdef0123456789abcdef",
                "2bd601764fb316a2f879e4f1800451f4c45793662f912bb8833fb2752a4d9cb2",
                "f4b619032eb0e359ee58e62be58d89de09519b4900f1962b41b38326af98c8be",
            ),
            (
                "9876543210abcdef9876543210abcdef",
                "1e62c3f2592eb4c5baecebf072c62a2b1fda02ff43498762388efc0081f71843",
                "b3413fa6a04e8d753711247b7b8273253d25212f2a08366678d5528aead8df7a",
            ),
        ];
        for (domain_id, domain_key, manifest_key) in domains {
            // `K_d = HKDF(VRK, "obsync/v1/domain", utf8(domain_id))`.
            let derived = hkdf_sha256(&vrk, b"obsync/v1/domain", domain_id.as_bytes(), 32);
            assert_eq!(hex::encode(&derived), domain_key, "domain key {domain_id}");
            // `K_m,d = HKDF(K_d, "obsync/v1/manifest", utf8(domain_id))`.
            assert_eq!(
                hex::encode(&hkdf_sha256(
                    &derived,
                    b"obsync/v1/manifest",
                    domain_id.as_bytes(),
                    32
                )),
                manifest_key,
                "manifest key {domain_id}"
            );
        }
        assert_ne!(domains[0].2, domains[1].2, "two domains, two manifest keys");

        // The derivation v0.1.0 replaced. A holder of THIS key could read
        // every filename in the vault, which is why it is gone; it must match
        // no domain's manifest key.
        let vault_wide = hex::encode(&hkdf_sha256(&vrk, b"obsync/v1/manifest", b"", 32));
        for (id, _, manifest_key) in domains {
            assert_ne!(vault_wide, manifest_key, "the retired key survives in {id}");
        }

        // `K_map = HKDF(VRK, "obsync/v1/domainmap", "")` and the reserved
        // identifiers `HMAC(K_map, "obsync/v1/domain-map")` splits into.
        let map_key = hkdf_sha256(&vrk, b"obsync/v1/domainmap", b"", 32);
        assert_eq!(
            hex::encode(&map_key),
            "4c6b13640dd3457fb76a915ae4bf6015c8d008c9f47d8b63f6d6d452bd2ae3cf"
        );
        let ids = hmac_sha256(&map_key, b"obsync/v1/domain-map");
        assert_eq!(hex::encode(&ids[..16]), "ea593f6cc8f60f4411b8d92e18e86870");
        assert_eq!(hex::encode(&ids[16..]), "7d350c7c44b09468d62b64d44acee182");
    }

    #[test]
    fn the_maximum_output_is_produced() {
        assert_eq!(
            hkdf_sha256(b"ikm", b"salt", b"info", MAX_OUT).len(),
            MAX_OUT
        );
    }

    #[test]
    #[should_panic(expected = "yields at most")]
    fn refuses_more_than_255_blocks() {
        hkdf_sha256(b"ikm", b"salt", b"info", MAX_OUT + 1);
    }
}
