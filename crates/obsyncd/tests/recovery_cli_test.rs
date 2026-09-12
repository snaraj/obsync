//! Process-level recovery verdicts on fresh, disposable ciphertext fixtures.
#![forbid(unsafe_code)]

#[cfg(test)]
mod tests {

    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    use obsync_core::sha256::sha256;
    use obsyncd::config::Config;
    use obsyncd::log::{Log, LogLevel};
    use obsyncd::storage::types::{DeviceState, NewDevice, NewVersion};
    use obsyncd::storage::{Posture, Store};
    use obsyncd::types::{DomainId, FileId, Sid, VersionId};

    struct Fixture(PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).expect("remove owned fixture");
        }
    }

    #[test]
    fn check_and_export_processes_refuse_lost_ciphertext() {
        let path = std::env::temp_dir().join(format!(
            "obsync-cli-recovery-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir(&path).expect("exclusive fixture");
        let fixture = Fixture(fs::canonicalize(path).expect("canonical fixture"));
        let cfg = Config {
            blobs_dir: fixture.0.join("blobs"),
            journal_dir: fixture.0.join("journal"),
            server_key: Some([9; 32]),
            ..Config::default()
        };
        let storage = cfg.storage();
        let log = Log::new(LogLevel::Error);
        let posture = Posture::enforce(&storage, &log).expect("posture");
        let store = Store::open(&storage, [9; 32], &posture, log).expect("store");
        let account = store.setup("sentinel account").expect("account");
        let device = store
            .create_device(NewDevice {
                account_id: account,
                name: "sentinel".into(),
                platform: "linux".into(),
                app_version: "0.1.0".into(),
                secret: [3; 32],
                state: DeviceState::Active,
            })
            .expect("device")
            .device_id;
        let body = b"sentinel ciphertext";
        let sid = Sid::new(sha256(body));
        store
            .put_chunk(&account, &sid, body.len() as u64, &mut &body[..])
            .expect("chunk");
        let file = FileId::new([1; 16]);
        let domain = DomainId::new([2; 16]);
        let manifest = b"sentinel manifest";
        // Protocol version id: file bytes, sorted parents (empty), manifest,
        // then ordered ciphertext SIDs. No content key is needed by the server.
        let mut version_bytes = file.as_bytes().to_vec();
        version_bytes.extend_from_slice(manifest);
        version_bytes.extend_from_slice(sid.as_bytes());
        store
            .append_version(NewVersion {
                account_id: account,
                file_id: file,
                domain_id: domain,
                version_id: VersionId::new(sha256(&version_bytes)),
                parents: vec![],
                sids: vec![sid],
                bytes: body.len() as u64,
                manifest_ct: manifest.to_vec(),
                manifest_nonce: [1; 12],
                device_id: device,
                deleted: false,
            })
            .expect("version");
        drop(store);

        for complete in [true, false] {
            if !complete {
                let hex = sid.to_string();
                fs::remove_file(
                    cfg.blobs_dir
                        .join("v1")
                        .join(&hex[..2])
                        .join(&hex[2..4])
                        .join(&hex),
                )
                .expect("remove only fixture ciphertext");
            }
            for verb in ["check", "export"] {
                let mut command = Command::new(env!("CARGO_BIN_EXE_obsyncd"));
                command
                    .env_clear()
                    .env("OBSYNC_BLOBS_DIR", &cfg.blobs_dir)
                    .env("OBSYNC_JOURNAL_DIR", &cfg.journal_dir)
                    .env("OBSYNC_BLOBS_CAPACITY", cfg.blobs_capacity.to_string())
                    .env("OBSYNC_JOURNAL_CAPACITY", cfg.journal_capacity.to_string())
                    .env("OBSYNC_SERVER_KEY", "09".repeat(32))
                    .arg(verb);
                if verb == "export" {
                    command
                        .args([
                            "--domain",
                            &domain.to_string(),
                            "--key",
                            &"00".repeat(32),
                            "--out",
                        ])
                        .arg(fixture.0.join(format!("export-{complete}")));
                }
                let output = command.output().expect("CLI completes");
                let stdout = String::from_utf8(output.stdout).expect("report");
                let stderr = String::from_utf8(output.stderr).expect("diagnostics");
                assert_eq!(
                    output.status.code(),
                    Some(i32::from(!complete)),
                    "{verb}: {stdout}\n{stderr}"
                );
                assert_eq!(
                    stdout
                        .lines()
                        .filter(|line| line.starts_with("result:"))
                        .collect::<Vec<_>>(),
                    vec![if complete {
                        "result: ok"
                    } else {
                        "result: FAILED"
                    }]
                );
                let counter = if verb == "check" {
                    "chunks failed:   "
                } else {
                    "missing chunks: "
                };
                assert!(
                    stdout.contains(&format!("{counter}{}", usize::from(!complete))),
                    "{stdout}"
                );
                assert_eq!(
                    stderr.contains("decision=integrity_failed"),
                    !complete,
                    "{stderr}"
                );
                let summaries: Vec<_> = stderr
                    .lines()
                    .filter(|line| line.contains(&format!("event=summary job={verb} ")))
                    .collect();
                assert_eq!(summaries.len(), 1, "{stderr}");
                assert!(
                    summaries[0].contains(if complete {
                        "decision=ok"
                    } else {
                        "decision=failed"
                    }),
                    "{stderr}"
                );
                if verb == "export" {
                    assert!(summaries[0].contains("payload=ciphertext"));
                }
                assert!(
                    !stderr.contains(&fixture.0.display().to_string()),
                    "no local path in diagnostics"
                );
            }
        }
    }
}
