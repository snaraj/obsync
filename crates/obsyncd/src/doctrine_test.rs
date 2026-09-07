//! Repository doctrine, pinned as tests (AGENTS.md, "Testing doctrine").
//!
//! These read the source tree, so they fail on a doctrine violation anywhere
//! under `crates/`, not only in code this file's author wrote.
//!
//! Every check is a pure function over `(path, content)` with its own fixture
//! test, so a check that could never fail is itself a failure.
//!
//! The tokens these tests hunt for are assembled at runtime rather than
//! written as literals, so this file is not exempt from its own rules.
#![forbid(unsafe_code)]

use std::fs;
use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("crates/<crate>/ has a grandparent")
        .to_path_buf()
}

fn rust_sources(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let entries = fs::read_dir(dir).unwrap_or_else(|e| panic!("read {}: {e}", dir.display()));
    for entry in entries {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            if path.file_name().is_some_and(|n| n == "target") {
                continue;
            }
            out.extend(rust_sources(&path));
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
    out.sort();
    out
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

fn relative(path: &Path, root: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .display()
        .to_string()
}

/// The FFI keyword, assembled so this file never contains the literal.
fn unsafe_token() -> String {
    format!("un{}", "safe")
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Uses of the FFI keyword as a keyword: bounded by non-identifier bytes, so
/// the `_code` lint name and identifiers that merely contain it do not count.
fn unsafe_uses(content: &str) -> usize {
    let token = unsafe_token();
    let bytes = content.as_bytes();
    let mut count = 0;
    let mut from = 0;
    while let Some(offset) = content[from..].find(&token) {
        let at = from + offset;
        let end = at + token.len();
        let before_free = at == 0 || !is_ident_byte(bytes[at - 1]);
        let after_free = end >= bytes.len() || !is_ident_byte(bytes[end]);
        if before_free && after_free {
            count += 1;
        }
        from = end;
    }
    count
}

/// Provider names no source file may carry (AGENTS.md, provider contract).
fn provider_names() -> Vec<String> {
    vec![
        format!("cloud{}", "flare"),
        format!("Cloud{}", "flare"),
        format!("cloud{}", "flared"),
    ]
}

fn provider_hits(content: &str) -> Vec<String> {
    provider_names()
        .into_iter()
        .filter(|name| content.contains(name.as_str()))
        .collect()
}

/// Assemble a token so this file never contains the literal it hunts for.
fn word(split: &str) -> String {
    split.replace('|', "")
}

/// Field names that would make the server sighted (requirement 6).
fn blind_server_field_names() -> Vec<String> {
    [
        "pa|th",
        "ke|y",
        "sec|ret",
        "plain|text",
        "pass|word",
        "con|tent",
    ]
    .iter()
    .map(|name| format!("\"{}\"", word(name)))
    .collect()
}

fn blind_server_hits(content: &str) -> Vec<String> {
    blind_server_field_names()
        .into_iter()
        .filter(|quoted| content.contains(quoted.as_str()))
        .collect()
}

/// Log helper parameters that would let a caller log a path or key as text.
fn sighted_log_params(content: &str) -> Vec<String> {
    let mut hits = Vec::new();
    for split in ["pa|th", "ke|y", "sec|ret", "to|ken", "plain|text"] {
        let name = word(split);
        for shape in [
            format!("{name}: &str"),
            format!("{name}: &'static str"),
            format!("{name}: String"),
        ] {
            if content.contains(&shape) {
                hits.push(shape);
            }
        }
    }
    hits
}

/// Dependency lines in a manifest's `[dependencies]` table.
fn dependency_lines(manifest: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut inside = false;
    for line in manifest.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            inside = line == "[dependencies]";
            continue;
        }
        if inside && !line.is_empty() && !line.starts_with('#') {
            lines.push(line.to_string());
        }
    }
    lines
}

/// Manifest tables that would pull a build-time or test-time dependency.
fn forbidden_tables(manifest: &str) -> Vec<String> {
    ["[build-dependencies]", "[dev-dependencies]", "[target."]
        .iter()
        .filter(|table| manifest.contains(**table))
        .map(|table| (*table).to_string())
        .collect()
}

#[test]
fn signal_is_the_only_unsafe_file() {
    let root = repo_root();
    let allowed = root.join("crates/obsyncd/src/signal.rs");
    for file in rust_sources(&root.join("crates")) {
        let uses = unsafe_uses(&read(&file));
        if file == allowed {
            assert!(
                uses > 0,
                "signal.rs is the declared FFI surface and must still hold it"
            );
            continue;
        }
        assert_eq!(
            uses,
            0,
            "{} must not use the keyword: signal.rs is the single FFI surface",
            relative(&file, &root)
        );
    }
}

#[test]
fn unsafe_check_flags_a_mutated_fixture() {
    let token = unsafe_token();
    assert_eq!(unsafe_uses("#![forbid(unsafe_code)]"), 0);
    assert_eq!(unsafe_uses("fn f() {}"), 0);
    assert_eq!(unsafe_uses(&format!("{token} {{ transmute() }}")), 1);
    assert_eq!(unsafe_uses(&format!("{token} extern \"C\" {{}}")), 1);
    assert_eq!(
        unsafe_uses(&format!("#![forbid({token}_code)] {token} {{}}")),
        1
    );
}

#[test]
fn manifests_declare_no_dependency_but_the_path_dependency() {
    let root = repo_root();
    let core = read(&root.join("crates/obsync-core/Cargo.toml"));
    assert_eq!(
        dependency_lines(&core),
        Vec::<String>::new(),
        "obsync-core is the primitive crate: it depends on nothing"
    );
    let server = read(&root.join("crates/obsyncd/Cargo.toml"));
    assert_eq!(
        dependency_lines(&server),
        vec!["obsync-core = { path = \"../obsync-core\" }".to_string()],
        "obsyncd depends on the workspace path dependency and nothing else"
    );
    for manifest in [&core, &server] {
        assert_eq!(
            forbidden_tables(manifest),
            Vec::<String>::new(),
            "no build, dev, or target dependency table"
        );
        assert!(!manifest.contains("build ="), "no build script");
    }
}

#[test]
fn dependency_check_flags_a_mutated_fixture() {
    let mutated = "[package]\nname = \"x\"\n\n[dependencies]\nserde = \"1\"\n";
    assert_eq!(dependency_lines(mutated), vec!["serde = \"1\"".to_string()]);
    let clean = "[package]\nname = \"x\"\n\n[dependencies]\n\n[lib]\npath = \"src/lib.rs\"\n";
    assert!(dependency_lines(clean).is_empty());
    assert_eq!(
        forbidden_tables("[dev-dependencies]\nproptest = \"1\"\n"),
        vec!["[dev-dependencies]".to_string()]
    );
}

#[test]
fn no_provider_name_outside_the_edge_setting() {
    let root = repo_root();
    let allowed = root.join("crates/obsyncd/src/config.rs");
    for file in rust_sources(&root.join("crates")) {
        let hits = provider_hits(&read(&file));
        if file == allowed {
            continue;
        }
        assert_eq!(
            hits,
            Vec::<String>::new(),
            "{} names a provider; ask Edge::requires_edge_headers instead",
            relative(&file, &root)
        );
    }
    let edge = read(&allowed);
    assert!(
        !provider_hits(&edge).is_empty(),
        "config.rs still parses the provider-selecting value"
    );
}

#[test]
fn provider_check_flags_a_mutated_fixture() {
    let name = format!("cloud{}", "flare");
    assert!(provider_hits("let edge = Edge::None;").is_empty());
    assert_eq!(provider_hits(&format!("if header == \"{name}\"")).len(), 1);
    assert_eq!(provider_hits(&format!("// {name}d tunnel")).len(), 2);
}

#[test]
fn no_field_is_named_or_shaped_like_a_key_or_a_path() {
    let root = repo_root();
    for file in rust_sources(&root.join("crates/obsyncd/src")) {
        let hits = blind_server_hits(&read(&file));
        assert_eq!(
            hits,
            Vec::<String>::new(),
            "{} carries a sighted field name: the server is blind (requirement 6)",
            relative(&file, &root)
        );
    }
}

#[test]
fn blind_server_check_flags_a_mutated_fixture() {
    assert!(blind_server_hits("obj(&[(\"sids\", sids)])").is_empty());
    assert_eq!(
        blind_server_hits("obj(&[(\"path\", p)])"),
        vec!["\"path\"".to_string()]
    );
    assert_eq!(
        blind_server_hits("log.info(\"put\", &[(\"key\", k)])"),
        vec!["\"key\"".to_string()]
    );
}

#[test]
fn log_helpers_accept_no_free_text_for_a_path_or_a_key() {
    let root = repo_root();
    let log = read(&root.join("crates/obsyncd/src/log.rs"));
    assert_eq!(
        sighted_log_params(&log),
        Vec::<String>::new(),
        "a log helper taking free text for a path or a key breaks requirement 6"
    );
    assert!(
        log.contains("pub fn word(w: &'static str)"),
        "free text stays compile-time: a runtime path can never be a &'static str"
    );
}

#[test]
fn log_helper_check_flags_a_mutated_fixture() {
    assert!(sighted_log_params("pub fn word(w: &'static str) -> Val").is_empty());
    assert_eq!(
        sighted_log_params("pub fn path(path: &str) -> Val"),
        vec!["path: &str".to_string()]
    );
    assert_eq!(
        sighted_log_params("pub fn secret(secret: String) -> Val"),
        vec!["secret: String".to_string()]
    );
}

#[test]
fn every_source_file_but_the_ffi_surface_forbids_unsafe_code() {
    let root = repo_root();
    let allowed = root.join("crates/obsyncd/src/signal.rs");
    let lint = format!("#![forbid({}_code)]", unsafe_token());
    for file in rust_sources(&root.join("crates")) {
        if file == allowed {
            continue;
        }
        let content = read(&file);
        let is_module_root = file
            .file_name()
            .is_some_and(|n| n == "lib.rs" || n == "main.rs");
        let declares = content.contains(&lint);
        assert!(
            declares || is_module_root,
            "{} must carry the forbid attribute",
            relative(&file, &root)
        );
    }
}
