//! The dashboard's static files (`docs/architecture.md` 8).
//!
//! Four files, read once at start from `OBSYNC_DASHBOARD_DIR` and served from
//! memory: nothing here joins a request path onto a directory, so no request
//! can walk out of it. Every dashboard response carries the strict
//! Content-Security-Policy of `AGENTS.md`; the dashboard serves no inline
//! script and no remote asset.
#![forbid(unsafe_code)]

use std::collections::HashMap;
use std::path::Path;

use obsync_core::http::Response;

use crate::api::{ApiError, CSP};
use crate::log::Log;

/// The files the dashboard is made of, with the content type each is served
/// as. This list is the whole of what `/` serves.
pub const FILES: [(&str, &str); 4] = [
    ("index.html", "text/html; charset=utf-8"),
    ("app.css", "text/css; charset=utf-8"),
    ("app.js", "text/javascript; charset=utf-8"),
    ("lib.js", "text/javascript; charset=utf-8"),
];

/// The loaded dashboard.
pub struct Dashboard {
    files: HashMap<String, (Vec<u8>, &'static str)>,
}

impl Default for Dashboard {
    fn default() -> Self {
        Self::unavailable()
    }
}

impl Dashboard {
    /// A server with no dashboard files.
    pub fn unavailable() -> Self {
        Self {
            files: HashMap::new(),
        }
    }

    /// Read the four files. A missing file is one log line at start and a
    /// `404` at request time, never a crash: the sync API must serve even
    /// when the dashboard assets were not mounted.
    pub fn load(dir: &Path, log: &Log) -> Self {
        let mut files = HashMap::new();
        for (name, content_type) in FILES {
            match std::fs::read(dir.join(name)) {
                Ok(bytes) => {
                    files.insert(name.to_string(), (bytes, content_type));
                }
                Err(e) => log.warn(
                    "dashboard_file_missing",
                    &[
                        ("dir", &dir.display().to_string()),
                        ("file", name),
                        ("reason", &e.to_string()),
                        ("decision", "dashboard_unavailable"),
                    ],
                ),
            }
        }
        log.info(
            "dashboard_loaded",
            &[
                ("dir", &dir.display().to_string()),
                ("files", &files.len().to_string()),
            ],
        );
        Self { files }
    }

    /// Serve one dashboard file by its exact name.
    ///
    /// # Errors
    /// `404 dashboard_unavailable` when the file was not loaded.
    pub fn serve(&self, name: &str) -> Result<Response, ApiError> {
        let (bytes, content_type) = self.files.get(name).ok_or_else(|| {
            ApiError::new(
                404,
                "dashboard_unavailable",
                "this server ships no dashboard",
            )
        })?;
        Ok(
            Response::bytes(200, content_type, bytes.clone())
                .header("Content-Security-Policy", CSP),
        )
    }

    /// How many of the four files loaded.
    pub fn len(&self) -> usize {
        self.files.len()
    }

    /// Whether nothing loaded.
    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unloaded_dashboard_refuses_every_name() {
        let d = Dashboard::unavailable();
        assert!(d.is_empty());
        let e = d.serve("index.html").expect_err("nothing loaded");
        assert_eq!(e.status, 404);
        assert_eq!(e.code, "dashboard_unavailable");
    }

    #[test]
    fn the_served_list_is_exactly_the_four_documented_files() {
        let names: Vec<&str> = FILES.iter().map(|(n, _)| *n).collect();
        assert_eq!(names, vec!["index.html", "app.css", "app.js", "lib.js"]);
    }
}
