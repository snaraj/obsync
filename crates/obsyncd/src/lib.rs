//! obsyncd: the blind sync server (AGENTS.md, "Purpose and architecture").
//!
//! `main.rs` is a thin entry point over this library so every module is
//! testable in-process with no network and no fixtures on disk.
//!
//! There is deliberately no crate-level `forbid(unsafe_code)`: it would make
//! the one permitted FFI surface, [`signal`], impossible to compile. Every
//! other file carries the attribute itself, and `doctrine_test` fails the
//! build if one does not.

pub mod api;
pub mod cli;
pub mod config;
pub mod dashboard;
pub mod log;
pub mod plugin_dist;
pub mod signal;
pub mod storage;
pub mod types;

#[cfg(test)]
mod doctrine_test;
