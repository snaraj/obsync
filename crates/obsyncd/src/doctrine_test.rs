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

/// Uses of the FFI keyword in the only grammar that can introduce it: a
/// block, a function, an `impl`, a `trait`, or an `extern` block.
///
/// The keyword must be bounded by non-identifier bytes, so the `_code` lint
/// name and identifiers containing it do not count, and it must be followed
/// by one of the five forms, so prose that names the keyword does not either.
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
        let rest = content[end..].trim_start();
        let introduces = ["{", "fn ", "impl ", "trait ", "extern "]
            .iter()
            .any(|form| rest.starts_with(form));
        if before_free && after_free && introduces {
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

/// Quoted member names ending in the key suffix, with the quotes proving the
/// name is a WIRE field rather than a Rust identifier: `"domain_key"` is a
/// field a handler could read out of a body, `let server_key` is not.
///
/// [`blind_server_field_names`] refuses the bare name; this refuses every
/// name built around it, which is how the one field this repository ever
/// accepted (a 32-byte domain key, posted deliberately) was spelled.
fn key_field_hits(content: &str) -> Vec<String> {
    let needle = format!("_{}\"", word("ke|y"));
    let bytes = content.as_bytes();
    let mut hits = Vec::new();
    let mut from = 0;
    while let Some(offset) = content[from..].find(&needle) {
        let at = from + offset;
        let mut start = at;
        while start > 0 && is_ident_byte(bytes[start - 1]) {
            start -= 1;
        }
        if start > 0 && bytes[start - 1] == b'"' {
            hits.push(content[start..at + needle.len() - 1].to_string());
        }
        from = at + needle.len();
    }
    hits
}

/// The capability v0.1 refuses to have: handing the server a content key on
/// request. Assembled at runtime so this file is not exempt from its own rule.
fn withheld_capability() -> String {
    word("esc|row")
}

/// Whether a document names that capability, in any case.
fn names_withheld_capability(content: &str) -> bool {
    content
        .to_ascii_lowercase()
        .contains(&withheld_capability())
}

/// Every text file under a product surface: the extensions this repository
/// writes, with build output and vendored declarations skipped.
///
/// A surface that is not there is empty, not a panic. This test also runs
/// inside the image build, whose context copies the workspace and nothing
/// else (`.dockerignore` excludes `docs/`, and the Dockerfile's server stage
/// copies only `crates/`), so a build context with no `dashboard/` has no
/// dashboard to be wrong about. The caller's floor on `crates/` is what stops
/// that becoming a pass on a walk that read nothing.
fn product_sources(dir: &Path) -> Vec<PathBuf> {
    const TEXT: [&str; 12] = [
        "rs", "md", "html", "css", "js", "mjs", "ts", "json", "toml", "txt", "yaml", "yml",
    ];
    const SKIP: [&str; 3] = ["target", "node_modules", "vendor"];
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return out;
    };
    for entry in entries {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            if path
                .file_name()
                .is_some_and(|n| SKIP.iter().any(|s| n == *s))
            {
                continue;
            }
            out.extend(product_sources(&path));
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| TEXT.contains(&e))
        {
            out.push(path);
        }
    }
    out.sort();
    out
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
    assert_eq!(unsafe_uses(&format!("//! prose about `{token}` keys")), 0);
    assert_eq!(unsafe_uses(&format!("fn {token}_uses() {{}}")), 0);
    assert_eq!(unsafe_uses(&format!("{token} {{ transmute() }}")), 1);
    assert_eq!(unsafe_uses(&format!("{token} extern \"C\" {{}}")), 1);
    assert_eq!(unsafe_uses(&format!("{token} fn raw() {{}}")), 1);
    assert_eq!(unsafe_uses(&format!("{token} impl Send for X {{}}")), 1);
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
fn no_handler_reads_or_writes_a_field_whose_name_ends_in_the_key_suffix() {
    let root = repo_root();
    let api = root.join("crates/obsyncd/src/api");
    let files = rust_sources(&api);
    assert!(files.len() > 5, "the API scan found no files");
    for file in files {
        assert_eq!(
            key_field_hits(&read(&file)),
            Vec::<String>::new(),
            "{} names a wire field shaped like a content key: the server is \
             blind and has no request that hands it one (requirement 6)",
            relative(&file, &root)
        );
    }
}

#[test]
fn key_field_check_flags_a_mutated_fixture() {
    let suffix = word("ke|y");
    assert!(key_field_hits("field_str(&body, \"domain_id\")").is_empty());
    assert!(
        key_field_hits(&format!("let server_{suffix} = load();")).is_empty(),
        "a Rust identifier is not a wire field"
    );
    assert!(
        key_field_hits(&format!("log.info(\"{suffix}\", &[])")).is_empty(),
        "the bare name is blind_server_hits's job, not this one"
    );
    assert_eq!(
        key_field_hits(&format!("field_str(&body, \"domain_{suffix}\")")),
        vec![format!("domain_{suffix}")]
    );
    assert_eq!(
        key_field_hits(&format!("obj(vec![(\"wrapped_{suffix}\", v)])")),
        vec![format!("wrapped_{suffix}")]
    );
}

#[test]
fn no_product_surface_names_the_capability_v0_1_refuses_to_have() {
    let root = repo_root();
    // `crates/` is present wherever this test runs, the image build included,
    // so it carries the non-vacuity floor. The other four surfaces are scanned
    // when present: see `product_sources`.
    let mut files = product_sources(&root.join("crates"));
    assert!(
        files.len() > 40,
        "the workspace scan found {} files: it is not reading the tree",
        files.len()
    );
    for surface in ["dashboard", "plugin/src", "docs"] {
        files.extend(product_sources(&root.join(surface)));
    }
    let readme = root.join("README.md");
    if readme.is_file() {
        files.push(readme);
    }
    for file in files {
        assert!(
            !names_withheld_capability(&read(&file)),
            "{} names the one capability v0.1 refuses to have. The server \
             never holds a content key, so the word describes nothing this \
             repository does; delete the mention rather than the property.",
            relative(&file, &root)
        );
    }
}

#[test]
fn withheld_capability_check_flags_a_mutated_fixture() {
    let token = withheld_capability();
    assert!(!names_withheld_capability(
        "the server holds no content key at all"
    ));
    assert!(names_withheld_capability(&format!(
        "// {token} the domain key"
    )));
    assert!(
        names_withheld_capability(&format!("// {} the domain key", token.to_uppercase())),
        "the scan is case-insensitive"
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
    for crate_dir in ["crates/obsync-core", "crates/obsyncd"] {
        let src = root.join(crate_dir).join("src");
        // A crate root that forbids the keyword covers every file under it,
        // and cannot be overridden from inside. Only a crate without that
        // blanket needs the attribute file by file, because it holds the one
        // permitted FFI surface.
        let crate_wide = read(&src.join("lib.rs")).contains(&lint);
        for file in rust_sources(&src) {
            if crate_wide || file == allowed {
                continue;
            }
            let content = read(&file);
            let is_crate_root = file
                .file_name()
                .is_some_and(|n| n == "lib.rs" || n == "main.rs");
            assert!(
                content.contains(&lint) || is_crate_root,
                "{} must carry the forbid attribute",
                relative(&file, &root)
            );
        }
    }
}
