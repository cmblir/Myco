use super::*;

const ORIGINAL: &str = "Synthetic expired scratch text.\n";
const NEWER: &str = "Synthetic human revision that must stay in place.\n";
const RAW: &str = "Synthetic immutable original evidence.\n";

struct Fixture {
    directory: tempfile::TempDir,
    content: PathBuf,
    sidecar: PathBuf,
    verdict: String,
}

impl Fixture {
    fn new(revision: Option<&str>, origin: &str) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        std::fs::create_dir_all(root.join("_inbox/quarantine")).unwrap();
        std::fs::create_dir(root.join("raw")).unwrap();
        std::fs::write(root.join("raw/original.md"), RAW).unwrap();
        let content = root.join("_inbox/quarantine/note.md");
        let sidecar = sidecar_path(&content);
        std::fs::write(&content, ORIGINAL).unwrap();
        let mut value = serde_json::json!({
            "tier": "quarantine", "from": origin,
            "expires": now_secs() - 1000, "vector": [],
        });
        if let Some(revision) = revision {
            value["source_sha256"] = revision.into();
        }
        let verdict = value.to_string();
        std::fs::write(&sidecar, &verdict).unwrap();
        Self {
            directory,
            content,
            sidecar,
            verdict,
        }
    }

    fn run(&self) -> Result<RunReport, String> {
        run_without_embeddings(self.directory.path(), &DistillConfig::default())
    }

    fn assert_retained(&self, result: Result<RunReport, String>, content: &str) {
        assert_eq!(
            std::fs::read_to_string(&self.content).ok().as_deref(),
            Some(content),
            "recoverable expiry must preserve the current source"
        );
        assert_eq!(
            std::fs::read_to_string(&self.sidecar).unwrap(),
            self.verdict
        );
        let error = result.expect_err("unverified expiry must not complete");
        assert!(error.contains("retained"), "{error}");
        for entry in std::fs::read_dir(self.directory.path().join(".myco/distill-runs")).unwrap() {
            let manifest: RunManifest =
                serde_json::from_slice(&std::fs::read(entry.unwrap().path()).unwrap()).unwrap();
            assert!(manifest.trashed.is_empty());
            assert!(manifest.deleted.is_empty());
        }
        assert_eq!(
            std::fs::read_to_string(self.directory.path().join("raw/original.md")).unwrap(),
            RAW
        );
    }
}

fn with_recoverable_policy(name: &str, test: impl FnOnce()) {
    crate::settings::test_support::with_isolated_data(name, |_| {
        crate::settings::save(&crate::settings::Settings {
            permanent_delete: false,
            ..crate::settings::Settings::default()
        })
        .unwrap();
        let _hooks = Hooks;
        test();
    });
}

struct Hooks;
impl Drop for Hooks {
    fn drop(&mut self) {
        PREPARED_HOOK.with(|slot| *slot.borrow_mut() = None);
        COMMIT_HOOK.with(|slot| *slot.borrow_mut() = None);
    }
}

fn prepared(hook: impl Fn() -> Result<(), String> + 'static) {
    PREPARED_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}

fn commit(hook: impl Fn(CommitCheckpoint, &Path) -> Result<(), String> + 'static) {
    COMMIT_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}

fn recorded_manifest(root: &Path) -> RunManifest {
    let entries: Vec<_> = std::fs::read_dir(root.join(".myco/distill-runs"))
        .unwrap()
        .collect();
    assert_eq!(entries.len(), 1);
    serde_json::from_slice(&std::fs::read(entries[0].as_ref().unwrap().path()).unwrap()).unwrap()
}

#[test]
fn native_save_after_preparation_keeps_the_newer_source_in_place() {
    with_recoverable_policy("ttl-recoverable-save-seam", || {
        let revision = admission::sha256(ORIGINAL.as_bytes());
        let fixture = Fixture::new(Some(&revision), "_inbox/note.md");
        let content = fixture.content.clone();
        prepared(move || {
            let guard =
                crate::vault::try_lock_file_mutation()?.expect("preparation released writer");
            drop(guard);
            crate::vault::write_file_if_unchanged(
                &content.to_string_lossy(),
                NEWER,
                Some(&revision),
            )
        });
        fixture.assert_retained(fixture.run(), NEWER);
    });
}

#[test]
fn actual_keep_command_after_preparation_preserves_the_extended_pair() {
    with_recoverable_policy("ttl-recoverable-keep-seam", || {
        let mut fixture = Fixture::new(
            Some(&admission::sha256(ORIGINAL.as_bytes())),
            "_inbox/note.md",
        );
        let root = fixture.directory.path().to_path_buf();
        prepared(move || {
            assert_eq!(
                extend_quarantine(&root, &["_inbox/quarantine/note.md".into()], 7)?,
                1
            );
            Ok(())
        });
        let result = fixture.run();
        fixture.verdict = std::fs::read_to_string(&fixture.sidecar).unwrap();
        let current: serde_json::Value = serde_json::from_str(&fixture.verdict).unwrap();
        assert!(current["expires"].as_i64().unwrap() > now_secs());
        assert_eq!(
            current["source_sha256"],
            admission::sha256(ORIGINAL.as_bytes())
        );
        fixture.assert_retained(result, ORIGINAL);
    });
}

#[test]
fn changed_deletion_policy_refuses_recoverable_commit() {
    with_recoverable_policy("ttl-recoverable-policy-seam", || {
        let fixture = Fixture::new(
            Some(&admission::sha256(ORIGINAL.as_bytes())),
            "_inbox/note.md",
        );
        prepared(|| {
            let mut settings = crate::settings::read_checked()?;
            settings.permanent_delete = true;
            crate::settings::save(&settings)
        });
        fixture.assert_retained(fixture.run(), ORIGINAL);
    });
}

#[cfg(unix)]
#[test]
fn identical_native_replacement_is_not_the_observed_source() {
    with_recoverable_policy("ttl-recoverable-identical-seam", || {
        let revision = admission::sha256(ORIGINAL.as_bytes());
        let fixture = Fixture::new(Some(&revision), "_inbox/note.md");
        let content = fixture.content.clone();
        prepared(move || {
            crate::vault::write_file_if_unchanged(
                &content.to_string_lossy(),
                ORIGINAL,
                Some(&revision),
            )
        });
        fixture.assert_retained(fixture.run(), ORIGINAL);
    });
}

#[test]
fn occupied_destination_at_link_seam_is_never_overwritten() {
    with_recoverable_policy("ttl-recoverable-destination-seam", || {
        let fixture = Fixture::new(
            Some(&admission::sha256(ORIGINAL.as_bytes())),
            "_inbox/note.md",
        );
        commit(|phase, destination| {
            if phase == CommitCheckpoint::BeforeTrashLink {
                assert!(
                    crate::vault::try_lock_file_mutation()?.is_none(),
                    "commit owns writer"
                );
                // Model an uncooperative writer occupying the selected name.
                std::fs::write(destination, NEWER).map_err(|error| error.to_string())?;
            }
            Ok(())
        });
        let result = fixture.run();
        let manifest = recorded_manifest(fixture.directory.path());
        assert_eq!(
            std::fs::read_to_string(
                fixture
                    .directory
                    .path()
                    .join(".myco/trash")
                    .join(&manifest.id)
                    .join("note.md")
            )
            .unwrap(),
            NEWER
        );
        fixture.assert_retained(result, ORIGINAL);
    });
}

#[cfg(unix)]
#[test]
fn dangling_trash_destination_is_preserved_without_moving_the_source() {
    with_recoverable_policy("ttl-recoverable-dangling-destination", || {
        let fixture = Fixture::new(
            Some(&admission::sha256(ORIGINAL.as_bytes())),
            "_inbox/note.md",
        );
        let root = fixture.directory.path().to_path_buf();
        prepared(move || {
            let manifest = recorded_manifest(&root);
            let trash = root.join(".myco/trash").join(manifest.id);
            std::fs::create_dir_all(&trash).map_err(|error| error.to_string())?;
            std::os::unix::fs::symlink("missing.md", trash.join("note.md"))
                .map_err(|error| error.to_string())
        });
        let result = fixture.run();
        let manifest = recorded_manifest(fixture.directory.path());
        let destination = fixture
            .directory
            .path()
            .join(".myco/trash")
            .join(manifest.id)
            .join("note.md");
        assert_eq!(
            std::fs::read_link(destination).unwrap(),
            Path::new("missing.md")
        );
        fixture.assert_retained(result, ORIGINAL);
    });
}

#[test]
fn changed_destination_after_link_retains_both_names_for_manual_review() {
    with_recoverable_policy("ttl-recoverable-linked-conflict", || {
        let fixture = Fixture::new(
            Some(&admission::sha256(ORIGINAL.as_bytes())),
            "_inbox/note.md",
        );
        commit(|phase, destination| {
            if phase == CommitCheckpoint::TrashLinked {
                std::fs::rename(destination, destination.with_extension("retained"))
                    .map_err(|error| error.to_string())?;
                std::fs::write(destination, NEWER).map_err(|error| error.to_string())?;
            }
            Ok(())
        });
        let result = fixture.run();
        let manifest = recorded_manifest(fixture.directory.path());
        let trash = fixture
            .directory
            .path()
            .join(".myco/trash")
            .join(manifest.id);
        assert_eq!(
            std::fs::read_to_string(trash.join("note.md")).unwrap(),
            NEWER
        );
        assert_eq!(
            std::fs::read_to_string(trash.join("note.retained")).unwrap(),
            ORIGINAL
        );
        let error = result.as_ref().unwrap_err();
        assert!(
            error.contains("additional copy") && error.contains("note.md"),
            "{error}"
        );
        fixture.assert_retained(result, ORIGINAL);
    });
}

#[test]
fn second_source_conflict_records_only_the_actual_first_move() {
    with_recoverable_policy("ttl-recoverable-partial-commit", || {
        let fixture = Fixture::new(
            Some(&admission::sha256(ORIGINAL.as_bytes())),
            "_inbox/note.md",
        );
        commit(|phase, sidecar| {
            if phase == CommitCheckpoint::ContentTrashed {
                std::fs::rename(sidecar, sidecar.with_extension("retained"))
                    .map_err(|error| error.to_string())?;
                std::fs::create_dir(sidecar).map_err(|error| error.to_string())?;
            }
            Ok(())
        });
        let error = fixture.run().unwrap_err();
        assert!(error.contains("recoverable expiry incomplete"), "{error}");
        assert!(!fixture.content.exists());
        assert!(fixture.sidecar.is_dir());
        assert_eq!(
            std::fs::read_to_string(fixture.sidecar.with_extension("retained")).unwrap(),
            fixture.verdict
        );
        let manifest = recorded_manifest(fixture.directory.path());
        assert_eq!(manifest.trashed.len(), 1);
        assert_eq!(manifest.trashed[0].from, "_inbox/quarantine/note.md");
        assert_eq!(
            std::fs::read_to_string(fixture.directory.path().join(&manifest.trashed[0].to))
                .unwrap(),
            ORIGINAL
        );
        assert!(manifest.deleted.is_empty());
        assert!(state_load_checked(
            fixture.directory.path(),
            &current_store(fixture.directory.path()).unwrap().model
        )
        .unwrap()
        .last_run
        .is_none());
    });
}

#[test]
fn destination_change_after_unlink_keeps_the_actual_move_in_history() {
    with_recoverable_policy("ttl-recoverable-post-unlink-conflict", || {
        let fixture = Fixture::new(
            Some(&admission::sha256(ORIGINAL.as_bytes())),
            "_inbox/note.md",
        );
        let root = fixture.directory.path().to_path_buf();
        commit(move |phase, _| {
            if phase == CommitCheckpoint::ContentTrashed {
                let manifest = recorded_manifest(&root);
                let destination = root.join(".myco/trash").join(manifest.id).join("note.md");
                std::fs::rename(&destination, destination.with_extension("retained"))
                    .map_err(|error| error.to_string())?;
                std::fs::write(destination, NEWER).map_err(|error| error.to_string())?;
            }
            Ok(())
        });
        let error = fixture.run().unwrap_err();
        assert!(error.contains("recoverable expiry incomplete"), "{error}");
        assert!(!fixture.content.exists());
        assert_eq!(
            std::fs::read_to_string(&fixture.sidecar).unwrap(),
            fixture.verdict
        );
        let manifest = recorded_manifest(fixture.directory.path());
        assert_eq!(manifest.trashed.len(), 1);
        let destination = fixture.directory.path().join(&manifest.trashed[0].to);
        assert_eq!(std::fs::read_to_string(&destination).unwrap(), NEWER);
        assert_eq!(
            std::fs::read_to_string(destination.with_extension("retained")).unwrap(),
            ORIGINAL
        );
        assert!(manifest.deleted.is_empty());
        assert!(manifest.move_revisions.is_empty());
    });
}

#[cfg(unix)]
#[test]
fn unsafe_second_destination_keeps_the_first_move_in_history() {
    with_recoverable_policy("ttl-recoverable-second-destination", || {
        let fixture = Fixture::new(
            Some(&admission::sha256(ORIGINAL.as_bytes())),
            "_inbox/note.md",
        );
        let root = fixture.directory.path().to_path_buf();
        commit(move |phase, _| {
            if phase == CommitCheckpoint::ContentTrashed {
                let manifest = recorded_manifest(&root);
                let destination = root
                    .join(".myco/trash")
                    .join(manifest.id)
                    .join("note.verdict.json");
                std::os::unix::fs::symlink("missing.json", destination)
                    .map_err(|error| error.to_string())?;
            }
            Ok(())
        });
        let error = fixture.run().unwrap_err();
        assert!(!fixture.content.exists());
        assert_eq!(
            std::fs::read_to_string(&fixture.sidecar).unwrap(),
            fixture.verdict
        );
        let manifest = recorded_manifest(fixture.directory.path());
        assert_eq!(
            manifest.trashed.len(),
            1,
            "second destination refusal must retain the actual first move"
        );
        assert_eq!(manifest.trashed[0].from, "_inbox/quarantine/note.md");
        assert_eq!(
            std::fs::read_to_string(fixture.directory.path().join(&manifest.trashed[0].to))
                .unwrap(),
            ORIGINAL
        );
        let destination = fixture
            .directory
            .path()
            .join(".myco/trash")
            .join(manifest.id)
            .join("note.verdict.json");
        assert_eq!(
            std::fs::read_link(destination).unwrap(),
            Path::new("missing.json")
        );
        assert!(error.contains("recoverable expiry incomplete"), "{error}");
    });
}

#[test]
fn manifest_failure_reports_actual_moves_and_does_not_complete_the_run() {
    with_recoverable_policy("ttl-recoverable-manifest-conflict", || {
        let fixture = Fixture::new(
            Some(&admission::sha256(ORIGINAL.as_bytes())),
            "_inbox/note.md",
        );
        commit(|phase, manifest| {
            if phase == CommitCheckpoint::BeforeTrashManifest {
                let writer = crate::vault::try_lock_file_mutation()?
                    .expect("manifest save is outside writer");
                drop(writer);
                std::fs::rename(manifest, manifest.with_extension("retained"))
                    .map_err(|error| error.to_string())?;
                std::fs::create_dir(manifest).map_err(|error| error.to_string())?;
            }
            Ok(())
        });
        let error = fixture.run().unwrap_err();
        assert!(
            error.contains("trash manifest save failed")
                && error.contains("note.md")
                && error.contains("note.verdict.json"),
            "{error}"
        );
        assert!(!fixture.content.exists() && !fixture.sidecar.exists());
        let backup = std::fs::read_dir(fixture.directory.path().join(".myco/distill-runs"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "retained")
            })
            .unwrap();
        let manifest: RunManifest =
            serde_json::from_slice(&std::fs::read(backup).unwrap()).unwrap();
        assert!(
            manifest.trashed.is_empty(),
            "failed durable save cannot invent a history record"
        );
        let trash = fixture
            .directory
            .path()
            .join(".myco/trash")
            .join(manifest.id);
        assert_eq!(
            std::fs::read_to_string(trash.join("note.md")).unwrap(),
            ORIGINAL
        );
        assert_eq!(
            std::fs::read_to_string(trash.join("note.verdict.json")).unwrap(),
            fixture.verdict
        );
        assert!(state_load_checked(
            fixture.directory.path(),
            &current_store(fixture.directory.path()).unwrap().model
        )
        .unwrap()
        .last_run
        .is_none());
    });
}

#[test]
fn modified_source_is_not_automatically_moved_to_recoverable_trash() {
    with_recoverable_policy("ttl-recoverable-human-edit", || {
        let revision = admission::sha256(ORIGINAL.as_bytes());
        let fixture = Fixture::new(Some(&revision), "_inbox/note.md");
        crate::vault::write_file_if_unchanged(
            &fixture.content.to_string_lossy(),
            NEWER,
            Some(&revision),
        )
        .unwrap();
        fixture.assert_retained(fixture.run(), NEWER);
    });
}

#[test]
fn legacy_verdict_does_not_authorize_recoverable_expiry() {
    with_recoverable_policy("ttl-recoverable-legacy", || {
        let fixture = Fixture::new(None, "_inbox/note.md");
        fixture.assert_retained(fixture.run(), ORIGINAL);
    });
}

#[test]
fn malformed_revision_does_not_authorize_recoverable_expiry() {
    with_recoverable_policy("ttl-recoverable-malformed", || {
        let fixture = Fixture::new(Some("not-a-sha256"), "_inbox/note.md");
        fixture.assert_retained(fixture.run(), ORIGINAL);
    });
}

#[test]
fn raw_origin_does_not_authorize_recoverable_expiry() {
    with_recoverable_policy("ttl-recoverable-raw-origin", || {
        let fixture = Fixture::new(
            Some(&admission::sha256(ORIGINAL.as_bytes())),
            "raw/original.md",
        );
        fixture.assert_retained(fixture.run(), ORIGINAL);
    });
}

#[test]
fn unchanged_pair_is_preserved_in_trash_with_actual_move_history() {
    with_recoverable_policy("ttl-recoverable-control", || {
        let fixture = Fixture::new(
            Some(&admission::sha256(ORIGINAL.as_bytes())),
            "_inbox/note.md",
        );
        let report = fixture.run().unwrap();
        assert_eq!(report.trashed, 1);
        assert_eq!(report.deleted, 0);
        assert!(!fixture.content.exists() && !fixture.sidecar.exists());
        let recorded: RunManifest = serde_json::from_slice(
            &std::fs::read(manifest_path(fixture.directory.path(), &report.id)).unwrap(),
        )
        .unwrap();
        assert!(recorded.deleted.is_empty());
        assert!(
            recorded.move_revisions.is_empty(),
            "observations do not create native undo authority"
        );
        assert_eq!(recorded.trashed.len(), 2);
        for moved in &recorded.trashed {
            let expected = if moved.from.ends_with(".verdict.json") {
                &fixture.verdict
            } else {
                ORIGINAL
            };
            assert_eq!(
                std::fs::read_to_string(fixture.directory.path().join(&moved.to)).unwrap(),
                expected
            );
        }
        assert_eq!(
            std::fs::read_to_string(fixture.directory.path().join("raw/original.md")).unwrap(),
            RAW
        );
    });
}
