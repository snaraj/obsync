//! Process-level custody proof for `obsyncd setup-token` (issue #73).
//!
//! The verb exists so an operator with no shell in the image can ask the
//! server for the credential — `kubectl exec deploy/obsync -- obsyncd
//! setup-token`, `docker compose exec obsync obsyncd setup-token` — which
//! makes three properties of the PROCESS, not of a function: standard output
//! is the token and nothing else, so the command pipes; a run with nothing to
//! print writes nothing there at all and exits non-zero; and neither run puts
//! the token on standard error, where the log goes.
#![forbid(unsafe_code)]

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Output};
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A directory this test owns, removed with it.
    struct Fixture(PathBuf);

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).expect("remove owned fixture");
        }
    }

    impl Fixture {
        /// An exclusively created, canonical directory: `/var` is a link on
        /// macOS and the volume posture requires a path that is its own
        /// resolved form.
        fn new(name: &str) -> Fixture {
            let path = std::env::temp_dir().join(format!(
                "obsync-{name}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("clock")
                    .as_nanos()
            ));
            fs::create_dir(&path).expect("exclusive fixture");
            Fixture(fs::canonicalize(&path).expect("canonical fixture"))
        }
    }

    /// Run the verb against these volumes, with no ambient configuration.
    fn setup_token(fixture: &Path) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_obsyncd"));
        command
            .current_dir(fixture)
            .env_clear()
            .env("OBSYNC_BLOBS_DIR", fixture.join("blobs"))
            .env("OBSYNC_JOURNAL_DIR", fixture.join("journal"))
            .env("OBSYNC_BLOBS_CAPACITY", "64MiB")
            .env("OBSYNC_JOURNAL_CAPACITY", "16MiB")
            .env("OBSYNC_SERVER_KEY", "09".repeat(32))
            .arg("setup-token");
        // Preserve only the coverage collector's output destination.
        if let Some(profile) = std::env::var_os("LLVM_PROFILE_FILE") {
            command.env("LLVM_PROFILE_FILE", profile);
        }
        command.output().expect("the CLI completes")
    }

    /// Lines the verb's own decision stands on. The trailing space keeps
    /// `event=setup_token_ready`, which a START logs, out of the count.
    fn decisions(stderr: &str) -> Vec<&str> {
        stderr
            .lines()
            .filter(|line| line.contains("event=setup_token "))
            .collect()
    }

    #[test]
    fn the_verb_prints_the_token_alone_and_refuses_once_none_stands() {
        let fixture = Fixture::new("setup-token-cli");
        let root = fixture.0.join("journal").join("v1");
        fs::create_dir_all(&root).expect("the journal root a start leaves");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("root mode");
        // Assembled, never written out: a 64-character hex literal in a
        // repository file is a secret scan's business whatever it means.
        let token = "ab".repeat(32);
        let path = root.join("setup-token");
        fs::write(&path, format!("{token}\n")).expect("the token a start minted");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("credential mode");

        let printed = setup_token(&fixture.0);
        let stdout = String::from_utf8(printed.stdout).expect("report");
        let stderr = String::from_utf8(printed.stderr).expect("diagnostics");
        assert_eq!(printed.status.code(), Some(0), "{stdout}\n{stderr}");
        assert_eq!(
            stdout,
            format!("{token}\n"),
            "standard output is the token, newline terminated, and nothing else"
        );
        let lines = decisions(&stderr);
        assert_eq!(lines.len(), 1, "one decision line per run: {stderr}");
        assert!(lines[0].contains("decision=printed"), "{}", lines[0]);
        assert!(
            !stderr.contains(&token) && !stderr.contains(&token[..16]),
            "the token, or a prefix of it, reached the log: {stderr}"
        );
        assert!(
            !stderr.contains(&fixture.0.display().to_string()),
            "no local path in diagnostics: {stderr}"
        );

        // The rotation an operator performs between two starts
        // (`docs/recovery.md`): from here there is nothing to print.
        fs::remove_file(&path).expect("the token is deleted to rotate it");

        let refused = setup_token(&fixture.0);
        let stdout = String::from_utf8(refused.stdout).expect("report");
        let stderr = String::from_utf8(refused.stderr).expect("diagnostics");
        assert_eq!(refused.status.code(), Some(1), "{stdout}\n{stderr}");
        assert_eq!(
            stdout, "",
            "a refused run writes nothing where the token would have gone"
        );
        let lines = decisions(&stderr);
        assert_eq!(lines.len(), 1, "one decision line per run: {stderr}");
        assert!(
            lines[0].contains("decision=refused") && lines[0].contains("reason=absent"),
            "{}",
            lines[0]
        );
        assert!(
            stderr.contains("no setup token stands on the journal volume"),
            "the operator is told what happened, not only the machine: {stderr}"
        );
        assert!(
            !stderr.contains(&token) && !stderr.contains(&token[..16]),
            "the deleted token reached the log: {stderr}"
        );
    }
}
