use super::*;

const CONTENT: &str = "Synthetic disposable quarantine scratch.\n";

struct Hooks;
impl Drop for Hooks {
    fn drop(&mut self) {
        PREPARED_HOOK.with(|hook| *hook.borrow_mut() = None);
        COMMIT_HOOK.with(|hook| *hook.borrow_mut() = None);
    }
}

fn fixture(name: &str, test: impl FnOnce(&Path, &Path, &Path, &str)) {
    crate::settings::test_support::with_isolated_data(name, |_| {
        let settings = crate::settings::Settings {
            permanent_delete: true,
            ..crate::settings::Settings::default()
        };
        crate::settings::save(&settings).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        std::fs::create_dir_all(root.join("_inbox/quarantine")).unwrap();
        std::fs::create_dir(root.join("raw")).unwrap();
        std::fs::write(root.join("raw/evidence.md"), "Synthetic immutable evidence").unwrap();
        let content = root.join("_inbox/quarantine/scratch.md");
        let sidecar = root.join("_inbox/quarantine/scratch.verdict.json");
        let verdict = serde_json::json!({
            "tier": "quarantine", "from": "_inbox/scratch.md", "expires": now_secs() - 1000,
            "source_sha256": admission::sha256(CONTENT.as_bytes()), "vector": []
        })
        .to_string();
        std::fs::write(&content, CONTENT).unwrap();
        std::fs::write(&sidecar, &verdict).unwrap();
        let _hooks = Hooks;
        test(root, &content, &sidecar, &verdict);
        assert_eq!(
            std::fs::read_to_string(root.join("raw/evidence.md")).unwrap(),
            "Synthetic immutable evidence"
        );
    });
}

fn assert_pair(content: &Path, sidecar: &Path, verdict: &str) {
    assert_eq!(std::fs::read_to_string(content).unwrap(), CONTENT);
    assert_eq!(std::fs::read_to_string(sidecar).unwrap(), verdict);
}

#[test]
fn policy_revoked_before_commit_preserves_the_complete_pair() {
    fixture("ttl-policy-revoked", |root, content, sidecar, verdict| {
        PREPARED_HOOK.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(|| {
                let mut settings = crate::settings::read_checked()?;
                settings.permanent_delete = false;
                crate::settings::save(&settings)
            }))
        });
        let error = run_without_embeddings(root, &DistillConfig::default()).unwrap_err();
        assert!(
            error.contains("policy changed") && error.contains("retained"),
            "{error}"
        );
        assert_pair(content, sidecar, verdict);
        for entry in std::fs::read_dir(root.join(".myco/distill-runs")).unwrap() {
            let manifest: RunManifest =
                serde_json::from_slice(&std::fs::read(entry.unwrap().path()).unwrap()).unwrap();
            assert!(
                manifest.deleted.is_empty(),
                "policy refusal records no deletions"
            );
        }
    });
}

#[test]
fn corrupt_policy_fails_before_expiry_mutation() {
    fixture("ttl-corrupt-policy", |root, content, sidecar, verdict| {
        std::fs::write(
            crate::settings::settings_dir()
                .unwrap()
                .join("settings.json"),
            "{",
        )
        .unwrap();
        assert!(run_without_embeddings(root, &DistillConfig::default()).is_err());
        assert_pair(content, sidecar, verdict);
    });
}

#[test]
fn second_file_conflict_records_only_the_actual_first_deletion() {
    fixture("ttl-partial-commit", |root, content, sidecar, verdict| {
        COMMIT_HOOK.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(|phase, sidecar| {
                if phase == CommitCheckpoint::ContentDeleted {
                    assert!(
                        crate::vault::try_lock_file_mutation()?.is_none(),
                        "commit owns writer"
                    );
                    // An uncooperative filesystem change at the commit seam. The
                    // original sidecar remains named, and the replacement is kept.
                    std::fs::rename(sidecar, sidecar.with_extension("retained"))
                        .map_err(|error| error.to_string())?;
                    std::fs::create_dir(sidecar).map_err(|error| error.to_string())?;
                }
                Ok(())
            }))
        });
        let error = run_without_embeddings(root, &DistillConfig::default()).unwrap_err();
        assert!(
            error.contains("expiry incomplete")
                && error.contains("deleted [_inbox/quarantine/scratch.md]"),
            "{error}"
        );
        assert!(!content.exists());
        assert!(sidecar.is_dir());
        assert_eq!(
            std::fs::read_to_string(sidecar.with_extension("retained")).unwrap(),
            verdict
        );
        let files: Vec<_> = std::fs::read_dir(root.join(".myco/distill-runs"))
            .unwrap()
            .collect();
        assert_eq!(files.len(), 1);
        let recorded: RunManifest =
            serde_json::from_slice(&std::fs::read(files[0].as_ref().unwrap().path()).unwrap())
                .unwrap();
        assert_eq!(recorded.deleted, vec!["_inbox/quarantine/scratch.md"]);
        assert!(recorded.trashed.is_empty());
        assert!(
            state_load_checked(root, &current_store(root).unwrap().model)
                .unwrap()
                .last_run
                .is_none(),
            "partial run is not completed"
        );
    });
}

#[test]
fn manifest_save_failure_reports_irreversible_paths_and_does_not_complete() {
    fixture("ttl-manifest-failure", |root, content, sidecar, _| {
        COMMIT_HOOK.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(|phase, manifest| {
                if phase == CommitCheckpoint::BeforeManifest {
                    let writer = crate::vault::try_lock_file_mutation()?
                        .expect("manifest save is outside writer");
                    drop(writer);
                    std::fs::rename(manifest, manifest.with_extension("retained"))
                        .map_err(|error| error.to_string())?;
                    std::fs::create_dir(manifest).map_err(|error| error.to_string())?;
                }
                Ok(())
            }))
        });
        let error = run_without_embeddings(root, &DistillConfig::default()).unwrap_err();
        assert!(error.contains("deletion manifest save failed"), "{error}");
        assert!(
            error.contains("_inbox/quarantine/scratch.md")
                && error.contains("_inbox/quarantine/scratch.verdict.json"),
            "{error}"
        );
        assert!(!content.exists() && !sidecar.exists());
        let backup = std::fs::read_dir(root.join(".myco/distill-runs"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.extension().and_then(|extension| extension.to_str()) == Some("retained")
            })
            .unwrap();
        let recorded: RunManifest =
            serde_json::from_slice(&std::fs::read(backup).unwrap()).unwrap();
        assert!(
            recorded.deleted.is_empty(),
            "pre-delete manifest does not invent durable deletion records"
        );
        assert!(
            state_load_checked(root, &current_store(root).unwrap().model)
                .unwrap()
                .last_run
                .is_none()
        );
    });
}

#[cfg(unix)]
#[test]
fn identical_sidecar_replacement_is_preserved() {
    fixture("ttl-sidecar-replaced", |root, content, sidecar, verdict| {
        let sidecar = sidecar.to_path_buf();
        let replacement = verdict.to_string();
        let revision = admission::sha256(replacement.as_bytes());
        PREPARED_HOOK.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                crate::vault::write_file_if_unchanged(
                    &sidecar.to_string_lossy(),
                    &replacement,
                    Some(&revision),
                )
            }))
        });
        let error = run_without_embeddings(root, &DistillConfig::default()).unwrap_err();
        assert!(
            error.contains("identity changed") && error.contains("retained"),
            "{error}"
        );
        assert_pair(
            content,
            &root.join("_inbox/quarantine/scratch.verdict.json"),
            verdict,
        );
    });
}

#[cfg(unix)]
#[test]
fn payload_hardlinked_to_raw_is_not_automatic_delete_authority() {
    fixture("ttl-raw-hardlink", |root, content, sidecar, verdict| {
        let raw = root.join("raw/evidence.md");
        std::fs::remove_file(content).unwrap();
        std::fs::hard_link(&raw, content).unwrap();
        let raw_bytes = std::fs::read(&raw).unwrap();
        let mut value: serde_json::Value = serde_json::from_str(verdict).unwrap();
        value["source_sha256"] = admission::sha256(&raw_bytes).into();
        let current_verdict = value.to_string();
        std::fs::write(sidecar, &current_verdict).unwrap();
        let error = run_without_embeddings(root, &DistillConfig::default()).unwrap_err();
        assert!(error.contains("retained"), "{error}");
        assert_eq!(std::fs::read(content).unwrap(), raw_bytes);
        assert_eq!(std::fs::read_to_string(sidecar).unwrap(), current_verdict);
    });
}
