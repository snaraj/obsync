//! obsyncd entry point. Subcommands: serve, check, export, version
//! (`docs/architecture.md`).
#![forbid(unsafe_code)]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(obsyncd::cli::run(&args));
}
