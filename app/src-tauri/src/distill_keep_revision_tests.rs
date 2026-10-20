use super::*;
use std::sync::mpsc;
use std::time::Duration;

const REL: &str = "_inbox/quarantine/note.md";
const CONTENT: &str = "Synthetic owner-reviewed note.\n";

struct Fixture {
    directory: tempfile::TempDir,
    content: PathBuf,
    sidecar: PathBuf,
    verdict: String,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let content = directory.path().join(REL);
        std::fs::create_dir_all(content.parent().unwrap()).unwrap();
        let sidecar = sidecar_path(&content);
        let verdict = serde_json::json!({
            "tier": "quarantine", "from": "_inbox/note.md", "expires": now_secs() + 1000,
            "source_sha256": admission::sha256(CONTENT.as_bytes()), "vector": [0.25, 0.75],
        })
        .to_string();
        std::fs::write(&content, CONTENT).unwrap();
        std::fs::write(&sidecar, &verdict).unwrap();
        Self {
            directory,
            content,
            sidecar,
            verdict,
        }
    }
}

#[test]
fn changed_verdict_after_read_is_not_overwritten_by_keep() {
    let fixture = Fixture::new();
    let newer = serde_json::json!({"expires": now_secs() + 30 * 86_400, "reason": "Synthetic later decision"}).to_string();
    let result = extend_quarantine_impl(
        fixture.directory.path(),
        &[REL.into()],
        7,
        || {},
        |path| {
            if crate::vault::try_lock_file_mutation()?.is_some() {
                return Err("Keep read does not hold its writer".into());
            }
            // External writers do not participate in the native writer lock.
            std::fs::write(path, &newer).map_err(|error| error.to_string())
        },
    );
    assert!(result.unwrap_err().contains("write conflict"));
    assert_eq!(std::fs::read_to_string(&fixture.sidecar).unwrap(), newer);
    assert_eq!(std::fs::read_to_string(&fixture.content).unwrap(), CONTENT);
}

#[test]
fn payload_removed_after_read_leaves_the_verdict_unchanged() {
    let fixture = Fixture::new();
    let result = extend_quarantine_impl(
        fixture.directory.path(),
        &[REL.into()],
        7,
        || {},
        |_| std::fs::remove_file(&fixture.content).map_err(|error| error.to_string()),
    );
    assert!(result.unwrap_err().contains("payload is missing"));
    assert_eq!(
        std::fs::read_to_string(&fixture.sidecar).unwrap(),
        fixture.verdict
    );
}

#[cfg(unix)]
#[test]
fn linked_verdict_after_read_preserves_both_original_and_foreign_bytes() {
    let fixture = Fixture::new();
    let outside = tempfile::tempdir().unwrap();
    let target = outside.path().join("foreign.json");
    let retained = fixture.sidecar.with_extension("retained");
    std::fs::write(&target, "Synthetic foreign evidence").unwrap();
    let result = extend_quarantine_impl(
        fixture.directory.path(),
        &[REL.into()],
        7,
        || {},
        |path| {
            std::fs::rename(path, &retained).map_err(|error| error.to_string())?;
            std::os::unix::fs::symlink(&target, path).map_err(|error| error.to_string())
        },
    );
    assert!(result.unwrap_err().contains("symbolic link"));
    assert_eq!(
        std::fs::read_to_string(target).unwrap(),
        "Synthetic foreign evidence"
    );
    assert_eq!(std::fs::read_to_string(retained).unwrap(), fixture.verdict);
}

#[test]
fn invalid_utf8_is_a_read_error_and_retains_the_original_bytes() {
    let fixture = Fixture::new();
    std::fs::write(&fixture.sidecar, [0xff, 0xfe]).unwrap();
    let result = extend_quarantine(fixture.directory.path(), &[REL.into()], 7);
    assert!(result.unwrap_err().contains("read Keep verdict"));
    assert_eq!(std::fs::read(&fixture.sidecar).unwrap(), [0xff, 0xfe]);
}

#[test]
fn explicit_keep_accepts_a_live_legacy_object_without_deletion_authority() {
    let fixture = Fixture::new();
    let legacy = serde_json::json!({"expires": now_secs() + 1000, "vector": [0.25, 0.75], "legacy_field": {"retained": true}});
    std::fs::write(&fixture.sidecar, legacy.to_string()).unwrap();
    assert_eq!(
        extend_quarantine(fixture.directory.path(), &[REL.into()], 7).unwrap(),
        1
    );
    let mut expected = legacy.clone();
    expected["expires"] = (legacy["expires"].as_i64().unwrap() + 7 * 86_400).into();
    let current: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&fixture.sidecar).unwrap()).unwrap();
    assert_eq!(current, expected);
    assert!(
        current.get("source_sha256").is_none(),
        "Keep grants no automatic deletion authority"
    );
}

#[test]
fn batch_error_reports_earlier_persisted_extensions() {
    let fixture = Fixture::new();
    let second = fixture.content.with_file_name("second.md");
    std::fs::write(&second, CONTENT).unwrap();
    std::fs::create_dir(sidecar_path(&second)).unwrap();
    let result = extend_quarantine(
        fixture.directory.path(),
        &[REL.into(), "_inbox/quarantine/second.md".into()],
        7,
    );
    let error = result.unwrap_err();
    assert!(
        error.contains(&format!("extended [{REL}]")) && error.contains("second.md"),
        "{error}"
    );
    let current: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&fixture.sidecar).unwrap()).unwrap();
    let previous: serde_json::Value = serde_json::from_str(&fixture.verdict).unwrap();
    assert_eq!(
        current["expires"].as_i64().unwrap(),
        previous["expires"].as_i64().unwrap() + 7 * 86_400
    );
    assert_eq!(std::fs::read_to_string(second).unwrap(), CONTENT);
}

#[test]
fn queued_keep_rechecks_the_payload_after_the_actual_native_writer() {
    let fixture = Fixture::new();
    let guard = crate::vault::lock_file_mutation().unwrap();
    let (queued_tx, queued_rx) = mpsc::channel();
    let root = fixture.directory.path().to_path_buf();
    let worker = std::thread::spawn(move || {
        extend_quarantine_impl(
            &root,
            &[REL.into()],
            7,
            || {
                queued_tx
                    .send(crate::vault::try_lock_file_mutation().unwrap().is_none())
                    .unwrap();
            },
            |_| Ok(()),
        )
    });
    let reached_locked_writer = queued_rx.recv_timeout(Duration::from_secs(5));
    let removal = crate::vault::remove_all_locked(&guard, std::slice::from_ref(&fixture.content));
    drop(guard);
    let result = worker.join().unwrap();
    assert!(reached_locked_writer.unwrap());
    removal.unwrap();
    assert!(result.unwrap_err().contains("payload is missing"));
    assert_eq!(
        std::fs::read_to_string(fixture.sidecar).unwrap(),
        fixture.verdict
    );
}

#[cfg(unix)]
#[test]
fn queued_keep_refuses_a_replaced_vault_directory() {
    let fixture = Fixture::new();
    let retained = tempfile::tempdir().unwrap();
    let saved_root = retained.path().join("original-vault");
    let root = fixture.directory.path().to_path_buf();
    let guard = crate::vault::lock_file_mutation().unwrap();
    let (queued_tx, queued_rx) = mpsc::channel();
    let worker_root = root.clone();
    let worker = std::thread::spawn(move || {
        extend_quarantine_impl(
            &worker_root,
            &[REL.into()],
            7,
            || {
                queued_tx.send(()).unwrap();
            },
            |_| Ok(()),
        )
    });
    let arrived = queued_rx.recv_timeout(Duration::from_secs(5));
    let replacement = (|| -> std::io::Result<()> {
        std::fs::rename(&root, &saved_root)?;
        std::fs::create_dir_all(root.join("_inbox/quarantine"))?;
        std::fs::write(root.join(REL), CONTENT)?;
        std::fs::write(sidecar_path(&root.join(REL)), &fixture.verdict)
    })();
    drop(guard);
    let result = worker.join().unwrap();
    arrived.unwrap();
    replacement.unwrap();
    assert!(result.unwrap_err().contains("vault identity changed"));
    assert_eq!(
        std::fs::read_to_string(sidecar_path(&root.join(REL))).unwrap(),
        fixture.verdict
    );
    assert_eq!(
        std::fs::read_to_string(sidecar_path(&saved_root.join(REL))).unwrap(),
        fixture.verdict
    );
}

#[test]
fn actual_keep_completed_before_permanent_commit_retains_the_complete_pair() {
    crate::settings::test_support::with_isolated_data("keep-before-permanent-commit", |_| {
        crate::settings::save(&crate::settings::Settings {
            permanent_delete: true,
            ..crate::settings::Settings::default()
        })
        .unwrap();
        let fixture = Fixture::new();
        let mut expired: serde_json::Value = serde_json::from_str(&fixture.verdict).unwrap();
        expired["expires"] = (now_secs() - 1000).into();
        std::fs::write(&fixture.sidecar, expired.to_string()).unwrap();
        struct ResetHook;
        impl Drop for ResetHook {
            fn drop(&mut self) {
                PREPARED_HOOK.with(|slot| *slot.borrow_mut() = None);
            }
        }
        let _hook = ResetHook;
        let root = fixture.directory.path().to_path_buf();
        PREPARED_HOOK.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move || {
                if extend_quarantine(&root, &[REL.into()], 7)? != 1 {
                    return Err("actual Keep did not extend the live pair".into());
                }
                Ok(())
            }))
        });
        let result = run_without_embeddings(fixture.directory.path(), &DistillConfig::default());
        assert!(result.unwrap_err().contains("retained"));
        assert_eq!(std::fs::read_to_string(&fixture.content).unwrap(), CONTENT);
        let current: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&fixture.sidecar).unwrap()).unwrap();
        assert!(current["expires"].as_i64().unwrap() > now_secs());
        assert_eq!(current["source_sha256"], expired["source_sha256"]);
        for entry in std::fs::read_dir(fixture.directory.path().join(".myco/distill-runs")).unwrap()
        {
            let manifest: RunManifest =
                serde_json::from_slice(&std::fs::read(entry.unwrap().path()).unwrap()).unwrap();
            assert!(manifest.deleted.is_empty() && manifest.trashed.is_empty());
        }
    });
}
