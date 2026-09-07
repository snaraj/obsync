//! Identifier newtypes shared by the storage engine and the API.
//!
//! Every identifier is a fixed-size byte array that prints as lowercase hex
//! (`docs/protocol.md`, "Hex is lowercase") and parses through
//! `obsync_core::hex`, which refuses a wrong length, so an identifier of the
//! wrong shape cannot reach the store.
#![forbid(unsafe_code)]

use std::fmt;
use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};

use obsync_core::hex;

/// A hex identifier failed to parse: wrong length, or a non-hex character.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParseIdError {
    /// The number of hex characters the identifier requires.
    pub expected_chars: usize,
}

impl fmt::Display for ParseIdError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "expected {} hex characters", self.expected_chars)
    }
}

impl std::error::Error for ParseIdError {}

macro_rules! id_type {
    ($(#[$meta:meta])* $name:ident, $len:literal) => {
        $(#[$meta])*
        #[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name([u8; $len]);

        impl $name {
            /// Length in bytes.
            pub const LEN: usize = $len;

            /// Wrap raw bytes.
            pub const fn new(bytes: [u8; $len]) -> Self {
                Self(bytes)
            }

            /// The raw bytes.
            pub const fn as_bytes(&self) -> &[u8; $len] {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&hex::encode(&self.0))
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&hex::encode(&self.0))
            }
        }

        impl FromStr for $name {
            type Err = ParseIdError;

            fn from_str(s: &str) -> Result<Self, Self::Err> {
                hex::decode_array::<$len>(s)
                    .map(Self)
                    .map_err(|_| ParseIdError { expected_chars: $len * 2 })
            }
        }
    };
}

id_type!(
    /// Storage id of a ciphertext chunk: `SHA-256(ciphertext)`.
    Sid,
    32
);
id_type!(
    /// Opaque file identifier chosen by the device that created the file.
    FileId,
    16
);
id_type!(
    /// Version identifier: `SHA-256(file_id || parents || manifest_ct || sids)`.
    VersionId,
    32
);
id_type!(
    /// Device identifier issued by the server at pairing.
    DeviceId,
    16
);
id_type!(
    /// Domain (key-scoping unit) identifier chosen by a device.
    DomainId,
    16
);
id_type!(
    /// Account identifier issued by the server at setup.
    AccountId,
    16
);

/// Journal sequence number: the position of a frame in the append-only journal.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug, Default)]
pub struct Seq(pub u64);

impl Seq {
    /// The sequence that follows this one.
    pub const fn next(self) -> Seq {
        Seq(self.0 + 1)
    }
}

impl fmt::Display for Seq {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// A unix timestamp in milliseconds (`docs/protocol.md`: times are unix ms).
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug, Default)]
pub struct UnixMs(pub u64);

impl UnixMs {
    /// The current wall-clock time.
    pub fn now() -> UnixMs {
        UnixMs(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
                .unwrap_or(0),
        )
    }

    /// Milliseconds elapsed from `self` to `later`, saturating at zero.
    pub const fn until(self, later: UnixMs) -> u64 {
        later.0.saturating_sub(self.0)
    }
}

impl fmt::Display for UnixMs {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_round_trip() {
        let text = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
        let sid: Sid = text.parse().expect("valid sid");
        assert_eq!(sid.as_bytes()[0], 0x00);
        assert_eq!(sid.as_bytes()[31], 0xff);
        assert_eq!(sid.to_string(), text);
        assert_eq!(format!("{sid:?}"), text);
    }

    #[test]
    fn wrong_length_rejected() {
        assert_eq!(
            "00".parse::<Sid>(),
            Err(ParseIdError { expected_chars: 64 })
        );
        assert_eq!(
            "00112233445566778899aabbccddee".parse::<FileId>(),
            Err(ParseIdError { expected_chars: 32 })
        );
        assert_eq!(
            "00112233445566778899aabbccddeeff00".parse::<FileId>(),
            Err(ParseIdError { expected_chars: 32 })
        );
    }

    #[test]
    fn non_hex_rejected_and_case_canonicalised() {
        assert!(
            "00112233445566778899aabbccddeegg"
                .parse::<FileId>()
                .is_err()
        );
        // Either case decodes; an identifier always re-emits lowercase, so
        // one file id has exactly one spelling on the wire.
        let upper: FileId = "00112233445566778899AABBCCDDEEFF"
            .parse()
            .expect("uppercase decodes");
        assert_eq!(upper.to_string(), "00112233445566778899aabbccddeeff");
        assert!(
            "00112233445566778899aabbccddeeff00"
                .parse::<FileId>()
                .is_err()
        );
    }

    #[test]
    fn ordering_is_byte_order() {
        let a = FileId::new([0u8; 16]);
        let b = FileId::new([1u8; 16]);
        assert!(a < b);
        assert_eq!(Seq(4).next(), Seq(5));
        assert_eq!(UnixMs(10).until(UnixMs(25)), 15);
        assert_eq!(UnixMs(30).until(UnixMs(25)), 0);
    }

    #[test]
    fn parse_error_names_the_length() {
        assert_eq!(
            ParseIdError { expected_chars: 64 }.to_string(),
            "expected 64 hex characters"
        );
    }
}
