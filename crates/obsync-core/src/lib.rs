//! obsync-core: the primitives obsyncd is built from, standard library only.
//!
//! Every module ships its known-answer tests beside it (AGENTS.md, "Testing
//! doctrine"). Module list is fixed by AGENTS.md "Package layout"; a new
//! module is a contract change.
#![forbid(unsafe_code)]
#![deny(missing_docs)]

pub mod base32;
pub mod base64;
pub mod crc32;
pub mod ct;
pub mod hex;
pub mod hkdf;
pub mod hmac;
pub mod json;
pub mod sha256;
