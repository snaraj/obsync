//! Metadata for the plugin bundle the server ships with, read once at start
//! (`docs/architecture.md` 6.3).
//!
//! The three files come from `OBSYNC_PLUGIN_DIR` and are hashed once for
//! `GET /v1/plugin/manifest`; only metadata is retained. A deployment without
//! the directory serves `404` and says so in one log line at start
//! (requirement 12).
#![forbid(unsafe_code)]

use std::path::Path;

use obsync_core::hex;
use obsync_core::json::{Value, parse};
use obsync_core::sha256::sha256;

use crate::log::{Log, Val};

/// File names the bundle is made of.
pub const MANIFEST_FILE: &str = "manifest.json";
/// The compiled plugin.
pub const BUNDLE_FILE: &str = "main.js";
/// The plugin stylesheet.
pub const STYLES_FILE: &str = "styles.css";

/// Release metadata, or nothing when the directory is absent or incomplete.
pub struct PluginDist {
    /// `manifest.json`, parsed, with the two hashes added.
    manifest: Option<Value>,
}

impl Default for PluginDist {
    fn default() -> Self {
        Self::unavailable()
    }
}

impl PluginDist {
    /// A server with no plugin metadata to serve.
    pub fn unavailable() -> Self {
        Self { manifest: None }
    }

    /// Read the three files, hash the two assets, and fold the hashes into the
    /// manifest. Any missing or unreadable file leaves the whole distribution
    /// unavailable and logs why.
    pub fn load(dir: &Path, log: &Log) -> Self {
        let manifest_raw = match std::fs::read(dir.join(MANIFEST_FILE)) {
            Ok(v) => v,
            Err(e) => return Self::missing(log, MANIFEST_FILE, Val::io(&e)),
        };
        let bundle = match std::fs::read(dir.join(BUNDLE_FILE)) {
            Ok(v) => v,
            Err(e) => return Self::missing(log, BUNDLE_FILE, Val::io(&e)),
        };
        let styles = match std::fs::read(dir.join(STYLES_FILE)) {
            Ok(v) => v,
            Err(e) => return Self::missing(log, STYLES_FILE, Val::io(&e)),
        };

        let bundle_sha256 = hex::encode(&sha256(&bundle));
        let styles_sha256 = hex::encode(&sha256(&styles));
        let Ok(Value::Object(mut fields)) = parse(&manifest_raw) else {
            return Self::missing(log, MANIFEST_FILE, Val::word("not a JSON object"));
        };
        fields.retain(|(k, _)| k != "bundle_sha256" && k != "styles_sha256");
        fields.push((
            "bundle_sha256".to_string(),
            Value::Str(bundle_sha256.clone()),
        ));
        fields.push((
            "styles_sha256".to_string(),
            Value::Str(styles_sha256.clone()),
        ));

        log.info(
            "plugin_loaded",
            &[
                ("bundle_bytes", Val::bytes(bundle.len() as u64)),
                ("styles_bytes", Val::bytes(styles.len() as u64)),
            ],
        );
        Self {
            manifest: Some(Value::Object(fields)),
        }
    }

    fn missing(log: &Log, file: &'static str, reason: Val) -> Self {
        log.warn(
            "plugin_unavailable",
            &[
                ("file", Val::word(file)),
                ("reason", reason),
                ("decision", Val::word("plugin_unavailable")),
            ],
        );
        Self::unavailable()
    }

    /// The manifest with `bundle_sha256` and `styles_sha256` folded in.
    pub fn manifest(&self) -> Option<&Value> {
        self.manifest.as_ref()
    }

    /// Whether the server has plugin metadata to serve.
    pub fn is_available(&self) -> bool {
        self.manifest.is_some()
    }
}
