//! obsyncd entry point. Subcommands: serve, check, export, bench (docs/architecture.md).
#![forbid(unsafe_code)]

fn main() {
    println!("obsyncd {}", env!("CARGO_PKG_VERSION"));
}
