//! obsyncd: the blind sync server behind `docs/protocol.md`.
//!
//! Module list is fixed by AGENTS.md "Package layout"; a new module is a
//! contract change. Every file carries `#![forbid(unsafe_code)]` except
//! `signal`, the one permitted FFI surface (AGENTS.md requirement 5), which is
//! why the forbid is per file and not at this crate root.
#![deny(missing_docs)]

pub mod api;
pub mod cli;
pub mod config;
pub mod dashboard;
pub mod log;
pub mod plugin_dist;
pub mod signal;
pub mod storage;
pub mod types;
