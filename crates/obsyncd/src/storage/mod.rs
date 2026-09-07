//! The storage engine: blobs, mirrors, journal, index, GC and scrub.
//!
//! `docs/storage.md` is the contract this module implements. The engine owns
//! every durability rule: temp-write, fsync, rename, directory fsync before
//! any acknowledgement; sid verification on every write and every scrub;
//! refusal below the free-space watermark. None of that is configurable
//! (AGENTS.md requirement 4).
#![forbid(unsafe_code)]

pub mod types;

pub use self::types::{
    AccountRecord, AppendOutcome, Change, Changes, DevicePolicy, DeviceRecord, DomainRecord,
    FileRecord, FileSummary, GcSummary, NewDevice, NewVersion, PutOutcome, ScrubSummary, SeenEvent,
    SeenKind, StoreError, VersionRecord, VolumeStatus,
};
