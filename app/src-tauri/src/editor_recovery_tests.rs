//! Synthetic native checkpoints, conflicts and actual process restart; no IPC or private data.

use super::*;

const ORIGINAL: &str =
    "---\ntitle: Synthetic original\n---\nFull original A, including metadata.\n";
const DRAFT: &str = "---\ntitle: Synthetic draft\n---\nUnsaved draft D. 한글\n";
const NEWER: &str = "---\ntitle: Synthetic replacement\n---\nHuman replacement B must survive.\n";

fn open(state: &VaultRoot, root: &Path) -> AgentVaultSession {
    let generation = state.begin_open().unwrap();
    state
        .finish_open(generation, root.canonicalize().unwrap(), || ())
        .unwrap();
    state.snapshot().unwrap()
}

fn fixture() -> (tempfile::TempDir, VaultRoot, AgentVaultSession, PathBuf) {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path().canonicalize().unwrap();
    std::fs::create_dir(root.join("wiki")).unwrap();
    let path = root.join("wiki/note.md");
    std::fs::write(&path, ORIGINAL).unwrap();
    let state = VaultRoot::default();
    let origin = open(&state, &root);
    (vault, state, origin, path)
}

fn checkpoint(state: &VaultRoot, path: &Path, origin: &AgentVaultSession) -> RecoveryDraft {
    let receipt = crate::editor_io::read(state, &path.to_string_lossy(), origin).unwrap();
    assert_eq!(receipt.file.raw, ORIGINAL);
    stage(
        state,
        &path.to_string_lossy(),
        &receipt.revision,
        DRAFT,
        origin,
        None,
    )
    .unwrap()
}

fn journal_path(data: &Path) -> PathBuf {
    let entries: Vec<_> = std::fs::read_dir(data.join("editor-recovery"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(entries.len(), 1);
    entries[0].clone()
}

#[test]
fn registered_baseline_requires_exact_native_receipt_hash() {
    let (_vault, state, origin, path) = fixture();
    assert!(register_written(
        &path.to_string_lossy(),
        ORIGINAL,
        &hash(DRAFT.as_bytes()),
        &origin
    )
    .is_err());
    let receipt = crate::editor_io::read(&state, &path.to_string_lossy(), &origin).unwrap();
    assert_eq!(receipt.revision, hash(ORIGINAL.as_bytes()));
    assert!(register_written(&path.to_string_lossy(), DRAFT, &receipt.revision, &origin).is_err());
    assert_eq!(std::fs::read_to_string(path).unwrap(), ORIGINAL);
}

#[cfg(unix)]
#[test]
fn checkpoint_uses_registered_full_a_without_refreshing_to_external_b() {
    crate::settings::test_support::with_isolated_data("editor-recovery-baseline", |data| {
        let (_vault, state, origin, path) = fixture();
        let read = crate::editor_io::read(&state, &path.to_string_lossy(), &origin).unwrap();
        std::fs::write(&path, NEWER).unwrap();
        let saved = stage(
            &state,
            &path.to_string_lossy(),
            &read.revision,
            DRAFT,
            &origin,
            None,
        )
        .unwrap();
        assert_eq!(saved.baseline_raw, ORIGINAL);
        assert_eq!(saved.baseline_revision, hash(ORIGINAL.as_bytes()));
        assert_eq!(saved.draft_raw, DRAFT);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), NEWER);
        let loaded = load(&state, &path.to_string_lossy(), &origin)
            .unwrap()
            .unwrap();
        assert_eq!(loaded.revision, saved.revision);
        assert_eq!(loaded.origin.opening_token, origin.opening_token);
        use std::os::unix::fs::MetadataExt;
        assert_eq!(
            std::fs::metadata(data.join("editor-recovery"))
                .unwrap()
                .mode()
                & 0o777,
            0o700
        );
        let metadata = std::fs::symlink_metadata(journal_path(data)).unwrap();
        assert_eq!(metadata.mode() & 0o777, 0o600);
        assert_eq!(metadata.nlink(), 1);
    });
}

#[cfg(unix)]
#[test]
fn journal_revision_cas_preserves_newer_draft_and_rejects_stale_retirement() {
    crate::settings::test_support::with_isolated_data("editor-recovery-cas", |_| {
        let (_vault, state, origin, path) = fixture();
        assert!(stage(
            &state,
            &path.to_string_lossy(),
            &hash(ORIGINAL.as_bytes()),
            DRAFT,
            &origin,
            None
        )
        .is_err());
        let first = checkpoint(&state, &path, &origin);
        assert!(stage(
            &state,
            &path.to_string_lossy(),
            &first.baseline_revision,
            NEWER,
            &origin,
            None
        )
        .is_err());
        let second = stage(
            &state,
            &path.to_string_lossy(),
            &first.baseline_revision,
            NEWER,
            &origin,
            Some(&first.revision),
        )
        .unwrap();
        assert_ne!(first.revision, second.revision);
        assert!(stage(
            &state,
            &path.to_string_lossy(),
            &first.baseline_revision,
            DRAFT,
            &origin,
            Some(&first.revision)
        )
        .is_err());
        assert!(retire(&state, &path.to_string_lossy(), &origin, &first.revision).is_err());
        let loaded = load(&state, &path.to_string_lossy(), &origin)
            .unwrap()
            .unwrap();
        assert_eq!(loaded.draft_raw, NEWER);
        assert_eq!(loaded.baseline_raw, ORIGINAL);
        retire(&state, &path.to_string_lossy(), &origin, &second.revision).unwrap();
        assert!(load(&state, &path.to_string_lossy(), &origin)
            .unwrap()
            .is_none());
        assert_eq!(std::fs::read_to_string(path).unwrap(), ORIGINAL);
    });
}

#[cfg(unix)]
#[test]
fn accepted_write_does_not_silently_advance_a_pending_baseline() {
    crate::settings::test_support::with_isolated_data("editor-recovery-accepted", |_| {
        let (_vault, state, origin, path) = fixture();
        let saved = checkpoint(&state, &path, &origin);
        let accepted = crate::editor_io::write(
            &state,
            &path.to_string_lossy(),
            DRAFT,
            &saved.baseline_revision,
            &origin,
        )
        .unwrap();
        let pending = load(&state, &path.to_string_lossy(), &origin)
            .unwrap()
            .unwrap();
        assert_eq!(pending.baseline_raw, ORIGINAL);
        assert!(stage(
            &state,
            &path.to_string_lossy(),
            &accepted.revision,
            NEWER,
            &origin,
            Some(&saved.revision)
        )
        .is_err());
        retire(&state, &path.to_string_lossy(), &origin, &saved.revision).unwrap();
        let next = stage(
            &state,
            &path.to_string_lossy(),
            &accepted.revision,
            NEWER,
            &origin,
            None,
        )
        .unwrap();
        assert_eq!(next.baseline_raw, DRAFT);
        assert_eq!(next.draft_raw, NEWER);
        assert_eq!(std::fs::read_to_string(path).unwrap(), DRAFT);
    });
}

#[cfg(unix)]
#[test]
fn persisted_write_with_failed_receipt_preserves_checkpoint_and_human_replacement() {
    crate::settings::test_support::with_isolated_data("editor-recovery-partial", |_| {
        let (_vault, state, origin, path) = fixture();
        let saved = checkpoint(&state, &path, &origin);
        let result = crate::editor_io::write_impl(
            &state,
            &path.to_string_lossy(),
            DRAFT,
            &saved.baseline_revision,
            &origin,
            || {},
            |persisted| {
                assert_eq!(std::fs::read_to_string(persisted).unwrap(), DRAFT);
                std::fs::remove_file(persisted).unwrap();
                std::fs::write(persisted, NEWER).unwrap();
                Err("synthetic receipt checkpoint failure after human replacement".into())
            },
        );
        assert!(result
            .unwrap_err()
            .contains("write persisted but receipt checkpoint failed"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), NEWER);
        let loaded = load(&state, &path.to_string_lossy(), &origin)
            .unwrap()
            .unwrap();
        assert_eq!(loaded.baseline_raw, ORIGINAL);
        assert_eq!(loaded.draft_raw, DRAFT);
        assert_eq!(loaded.revision, saved.revision);
    });
}

#[cfg(unix)]
#[test]
fn old_opening_never_authorizes_restored_data_or_stale_retirement() {
    crate::settings::test_support::with_isolated_data("editor-recovery-reopen", |_| {
        let (_vault, state, origin, path) = fixture();
        let saved = checkpoint(&state, &path, &origin);
        let current = open(&state, Path::new(&origin.vault_path));
        for result in [
            load(&state, &path.to_string_lossy(), &origin).map(|_| ()),
            retire(&state, &path.to_string_lossy(), &origin, &saved.revision),
        ] {
            assert!(result.unwrap_err().contains("active vault changed"));
        }
        let restored = load(&state, &path.to_string_lossy(), &current)
            .unwrap()
            .unwrap();
        assert_eq!(restored.origin.opening_token, origin.opening_token);
        assert!(stage(
            &state,
            &path.to_string_lossy(),
            &saved.baseline_revision,
            NEWER,
            &current,
            Some(&saved.revision)
        )
        .is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), ORIGINAL);
    });
}

#[cfg(unix)]
#[test]
fn raw_outside_and_symlink_paths_cannot_create_or_access_a_journal() {
    crate::settings::test_support::with_isolated_data("editor-recovery-confine", |_| {
        use std::os::unix::fs::symlink;
        let (_vault, state, origin, path) = fixture();
        let root = Path::new(&origin.vault_path);
        std::fs::create_dir(root.join("raw")).unwrap();
        std::fs::write(root.join("raw/source.md"), ORIGINAL).unwrap();
        let outside = tempfile::tempdir().unwrap();
        let escaped = outside.path().join("outside.md");
        std::fs::write(&escaped, NEWER).unwrap();
        symlink(&escaped, root.join("wiki/link.md")).unwrap();
        for forbidden in [
            root.join("raw/source.md"),
            escaped.clone(),
            root.join("wiki/link.md"),
        ] {
            let rendered = forbidden.to_string_lossy();
            assert!(stage(
                &state,
                &rendered,
                &hash(ORIGINAL.as_bytes()),
                DRAFT,
                &origin,
                None
            )
            .is_err());
            assert!(load(&state, &rendered, &origin).is_err());
            assert!(retire(
                &state,
                &rendered,
                &origin,
                "00000000000000000000000000000000"
            )
            .is_err());
        }
        assert_eq!(std::fs::read_to_string(escaped).unwrap(), NEWER);
        assert_eq!(std::fs::read_to_string(path).unwrap(), ORIGINAL);
    });
}

#[cfg(unix)]
#[test]
fn corrupt_or_unknown_journal_payload_is_not_absence_and_is_never_overwritten() {
    crate::settings::test_support::with_isolated_data("editor-recovery-corrupt", |data| {
        let (_vault, state, origin, path) = fixture();
        let saved = checkpoint(&state, &path, &origin);
        let journal = journal_path(data);
        let actual = std::fs::read(&journal).unwrap();
        for mutation in ["version", "baseline", "draft", "unknown"] {
            let mut payload: serde_json::Value = serde_json::from_slice(&actual).unwrap();
            match mutation {
                "version" => payload["version"] = 99.into(),
                "baseline" => payload["recovery"]["baselineRaw"] = NEWER.into(),
                "draft" => payload["recovery"]["draftRaw"] = NEWER.into(),
                _ => payload["inventedAuthority"] = true.into(),
            }
            let corrupt = serde_json::to_vec(&payload).unwrap();
            std::fs::write(&journal, &corrupt).unwrap();
            assert!(load(&state, &path.to_string_lossy(), &origin).is_err());
            assert!(stage(
                &state,
                &path.to_string_lossy(),
                &saved.baseline_revision,
                NEWER,
                &origin,
                Some(&saved.revision)
            )
            .is_err());
            assert!(retire(&state, &path.to_string_lossy(), &origin, &saved.revision).is_err());
            assert_eq!(std::fs::read(&journal).unwrap(), corrupt);
        }
        assert_eq!(std::fs::read_to_string(path).unwrap(), ORIGINAL);
    });
}

#[cfg(unix)]
#[test]
fn journal_symlink_nonregular_hardlink_and_unsafe_permissions_fail_closed() {
    crate::settings::test_support::with_isolated_data("editor-recovery-file-kind", |data| {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let (_vault, state, origin, path) = fixture();
        let saved = checkpoint(&state, &path, &origin);
        let journal = journal_path(data);
        let payload = std::fs::read(&journal).unwrap();
        let outside = tempfile::tempdir().unwrap();
        let other = outside.path().join("do-not-touch.json");
        std::fs::write(&other, &payload).unwrap();
        std::fs::remove_file(&journal).unwrap();
        symlink(&other, &journal).unwrap();
        assert!(load(&state, &path.to_string_lossy(), &origin).is_err());
        assert!(retire(&state, &path.to_string_lossy(), &origin, &saved.revision).is_err());
        assert_eq!(std::fs::read(&other).unwrap(), payload);
        std::fs::remove_file(&journal).unwrap();
        std::fs::create_dir(&journal).unwrap();
        assert!(load(&state, &path.to_string_lossy(), &origin).is_err());
        std::fs::remove_dir(&journal).unwrap();
        std::fs::write(&journal, &payload).unwrap();
        std::fs::set_permissions(&journal, std::fs::Permissions::from_mode(0o600)).unwrap();
        let second_link = data.join("another-link.json");
        std::fs::hard_link(&journal, &second_link).unwrap();
        assert!(load(&state, &path.to_string_lossy(), &origin).is_err());
        std::fs::remove_file(second_link).unwrap();
        std::fs::set_permissions(&journal, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(load(&state, &path.to_string_lossy(), &origin).is_err());
        std::fs::set_permissions(&journal, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            load(&state, &path.to_string_lossy(), &origin)
                .unwrap()
                .unwrap()
                .revision,
            saved.revision
        );
        std::fs::set_permissions(
            data.join("editor-recovery"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        assert!(load(&state, &path.to_string_lossy(), &origin).is_err());
    });
}

#[cfg(unix)]
#[test]
fn replacing_the_vault_directory_does_not_adopt_the_old_object_journal() {
    crate::settings::test_support::with_isolated_data("editor-recovery-object", |_| {
        let container = tempfile::tempdir().unwrap();
        let root = container.path().join("vault");
        std::fs::create_dir_all(root.join("wiki")).unwrap();
        let root = root.canonicalize().unwrap();
        let path = root.join("wiki/note.md");
        std::fs::write(&path, ORIGINAL).unwrap();
        let state = VaultRoot::default();
        let origin = open(&state, &root);
        let saved = checkpoint(&state, &path, &origin);
        let parked = root.with_file_name("parked-vault");
        std::fs::rename(&root, &parked).unwrap();
        std::fs::create_dir_all(root.join("wiki")).unwrap();
        std::fs::write(&path, NEWER).unwrap();
        assert!(load(&state, &path.to_string_lossy(), &origin)
            .unwrap()
            .is_none());
        assert!(stage(
            &state,
            &path.to_string_lossy(),
            &saved.baseline_revision,
            DRAFT,
            &origin,
            None
        )
        .is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), NEWER);
        assert_eq!(
            std::fs::read_to_string(parked.join("wiki/note.md")).unwrap(),
            ORIGINAL
        );
    });
}

#[cfg(unix)]
#[test]
#[ignore = "spawned only with an explicit synthetic vault and private data directory"]
fn synthetic_restart_child() {
    let root = PathBuf::from(
        std::env::var_os("MYCO_EDITOR_RECOVERY_VAULT").expect("synthetic vault required"),
    );
    assert!(root
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("myco-synthetic-editor-restart-"));
    assert_eq!(
        std::fs::read_to_string(root.join("synthetic.marker")).unwrap(),
        "Synthetic editor restart only"
    );
    // macOS /var is an alias of /private/var; editor IPC paths are canonical.
    let root = root.canonicalize().unwrap();
    let data = PathBuf::from(
        std::env::var_os("MYCO_DATA_DIR").expect("synthetic data directory required"),
    );
    assert!(data
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("myco-synthetic-editor-data-"));
    let state = VaultRoot::default();
    let origin = open(&state, &root);
    let path = root.join("wiki/note.md");
    let saved = if std::env::var("MYCO_EDITOR_RECOVERY_PHASE").unwrap() == "checkpoint" {
        let saved = checkpoint(&state, &path, &origin);
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, NEWER).unwrap();
        assert!(crate::editor_io::write(
            &state,
            &path.to_string_lossy(),
            DRAFT,
            &saved.baseline_revision,
            &origin
        )
        .is_err());
        saved
    } else {
        // No editor read or recovery load has happened in this new process.
        // The private journal alone must protect both the leaf and its parent.
        for operation in ["rename", "move", "delete"] {
            let mut reached_mutation = false;
            let result = state.with_origin(&origin, |active| {
                assert_no_pending_at(active, &path.to_string_lossy())?;
                reached_mutation = true;
                match operation {
                    "rename" => std::fs::rename(&path, path.with_file_name("renamed.md")),
                    "move" => std::fs::rename(&path, active.join("moved.md")),
                    _ => std::fs::remove_file(&path),
                }
                .map_err(|error| format!("synthetic path mutation: {error}"))
            });
            assert!(result.unwrap_err().contains("pending editor recovery"));
            assert!(!reached_mutation);
        }
        assert!(state
            .with_origin(&origin, |active| {
                assert_no_pending_at(active, &active.join("wiki").to_string_lossy())
            })
            .unwrap_err()
            .contains("pending editor recovery"));
        let saved = load(&state, &path.to_string_lossy(), &origin)
            .unwrap()
            .unwrap();
        assert!(!same_origin(&saved.origin, &origin));
        assert!(state.with_origin(&saved.origin, |_| Ok(())).is_err());
        assert!(crate::editor_io::write(
            &state,
            &path.to_string_lossy(),
            DRAFT,
            &saved.baseline_revision,
            &saved.origin
        )
        .is_err());
        assert!(stage(
            &state,
            &path.to_string_lossy(),
            &saved.baseline_revision,
            NEWER,
            &origin,
            Some(&saved.revision)
        )
        .is_err());
        saved
    };
    assert_eq!(saved.baseline_raw, ORIGINAL);
    assert_eq!(saved.draft_raw, DRAFT);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), NEWER);
    println!(
        "SYNTHETIC_EDITOR_RECOVERY={}",
        serde_json::json!({"pid":std::process::id(),"recovery":saved,"currentOrigin":origin,
            "unopenedPathGuardRefused":std::env::var("MYCO_EDITOR_RECOVERY_PHASE").unwrap() == "restore"})
    );
}

#[cfg(unix)]
#[test]
fn actual_two_process_restart_restores_full_a_and_d_with_b_intact_and_no_old_authority() {
    let vault = tempfile::Builder::new()
        .prefix("myco-synthetic-editor-restart-")
        .tempdir()
        .unwrap();
    let data = tempfile::Builder::new()
        .prefix("myco-synthetic-editor-data-")
        .tempdir()
        .unwrap();
    std::fs::create_dir(vault.path().join("wiki")).unwrap();
    std::fs::write(vault.path().join("wiki/note.md"), ORIGINAL).unwrap();
    std::fs::write(
        vault.path().join("synthetic.marker"),
        "Synthetic editor restart only",
    )
    .unwrap();
    let run = |phase: &str| {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "editor_recovery::tests::synthetic_restart_child",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("MYCO_EDITOR_RECOVERY_VAULT", vault.path())
            .env("MYCO_EDITOR_RECOVERY_PHASE", phase)
            .env("MYCO_DATA_DIR", data.path())
            .env_remove("MEMEX_DATA_DIR")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "restart child failed: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8(output.stdout).unwrap();
        let raw = stdout
            .lines()
            .find_map(|line| {
                line.split_once("SYNTHETIC_EDITOR_RECOVERY=")
                    .map(|(_, raw)| raw)
            })
            .expect("actual native child recovery record required");
        serde_json::from_str::<serde_json::Value>(raw).unwrap()
    };
    let first = run("checkpoint");
    let second = run("restore");
    assert_eq!(first["recovery"], second["recovery"]);
    assert_ne!(first["pid"], second["pid"]);
    assert_ne!(
        first["currentOrigin"]["openingToken"],
        second["currentOrigin"]["openingToken"]
    );
    assert_eq!(second["recovery"]["baselineRaw"], ORIGINAL);
    assert_eq!(second["recovery"]["draftRaw"], DRAFT);
    assert_eq!(second["unopenedPathGuardRefused"], true);
    assert_eq!(
        std::fs::read_to_string(vault.path().join("wiki/note.md")).unwrap(),
        NEWER
    );
    println!(
        "SYNTHETIC_EDITOR_RESTART_PROOF={}",
        serde_json::json!({
            "checkpointProcess":first,"restoreProcess":second,"humanFileSha256":hash(NEWER.as_bytes()),
            "oldOpeningWriteRefused":true,"nativeHelperOnly":true,"installedUi":false,"powerLossTested":false
        })
    );
}

#[cfg(unix)]
#[test]
fn pending_guard_protects_unopened_note_and_parent_after_same_root_reopen() {
    crate::settings::test_support::with_isolated_data("editor-recovery-guard-unopened", |_| {
        let (_vault, state, origin, path) = fixture();
        let saved = checkpoint(&state, &path, &origin);
        std::fs::write(&path, NEWER).unwrap();
        let current = open(&state, Path::new(&origin.vault_path));
        for from in [path.as_path(), path.parent().unwrap()] {
            let mut reached_mutation = false;
            let result = state.with_origin(&current, |root| {
                assert_no_pending_at(root, &from.to_string_lossy())?;
                reached_mutation = true;
                Ok(())
            });
            assert!(result.unwrap_err().contains("pending editor recovery"));
            assert!(!reached_mutation);
        }
        let loaded = load(&state, &path.to_string_lossy(), &current)
            .unwrap()
            .unwrap();
        assert_eq!(loaded.baseline_raw, ORIGINAL);
        assert_eq!(loaded.draft_raw, DRAFT);
        assert_eq!(loaded.revision, saved.revision);
        assert_eq!(std::fs::read_to_string(path).unwrap(), NEWER);
    });
}

#[cfg(unix)]
#[test]
fn pending_guard_uses_component_ancestry_and_distinct_vault_objects() {
    crate::settings::test_support::with_isolated_data("editor-recovery-guard-ancestry", |_| {
        let (_vault, state, origin, path) = fixture();
        checkpoint(&state, &path, &origin);
        let (_other_vault, other_state, other_origin, other_path) = fixture();
        checkpoint(&other_state, &other_path, &other_origin);
        let root = Path::new(&origin.vault_path);
        assert_no_pending_at(
            root,
            &path.with_file_name("note.md-other").to_string_lossy(),
        )
        .unwrap();
        assert_no_pending_at(root, &root.join("wiki-other").to_string_lossy()).unwrap();
        assert!(assert_no_pending_at(root, &path.to_string_lossy()).is_err());
        // Old journals cannot attach to a new directory at the same path.
        let other_root = Path::new(&other_origin.vault_path);
        let parked = other_root.with_file_name(format!(
            "{}-parked",
            other_root.file_name().unwrap().to_string_lossy()
        ));
        std::fs::rename(other_root, &parked).unwrap();
        std::fs::create_dir_all(other_root.join("wiki")).unwrap();
        std::fs::write(&other_path, NEWER).unwrap();
        assert_no_pending_at(other_root, &other_path.to_string_lossy()).unwrap();
        assert_eq!(std::fs::read_to_string(&other_path).unwrap(), NEWER);
        // Return the parked directory under its tempfile owner for cleanup.
        std::fs::remove_file(&other_path).unwrap();
        std::fs::remove_dir(other_root.join("wiki")).unwrap();
        std::fs::remove_dir(other_root).unwrap();
        std::fs::rename(parked, other_root).unwrap();
    });
}

#[cfg(unix)]
#[test]
fn only_exact_retirement_unblocks_pending_path_mutation() {
    crate::settings::test_support::with_isolated_data("editor-recovery-guard-retire", |_| {
        let (_vault, state, origin, path) = fixture();
        let first = checkpoint(&state, &path, &origin);
        let second = stage(
            &state,
            &path.to_string_lossy(),
            &first.baseline_revision,
            NEWER,
            &origin,
            Some(&first.revision),
        )
        .unwrap();
        assert!(retire(&state, &path.to_string_lossy(), &origin, &first.revision).is_err());
        assert!(
            assert_no_pending_at(Path::new(&origin.vault_path), &path.to_string_lossy()).is_err()
        );
        retire(&state, &path.to_string_lossy(), &origin, &second.revision).unwrap();
        assert_no_pending_at(Path::new(&origin.vault_path), &path.to_string_lossy()).unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), ORIGINAL);
    });
}

#[cfg(unix)]
#[test]
fn pending_guard_rejects_corrupt_unknown_and_symlink_journal_before_any_mutation() {
    crate::settings::test_support::with_isolated_data("editor-recovery-guard-corrupt", |data| {
        use std::os::unix::fs::symlink;
        let (_vault, state, origin, path) = fixture();
        checkpoint(&state, &path, &origin);
        let journal = journal_path(data);
        let original = std::fs::read(&journal).unwrap();
        let unrelated = path.with_file_name("other.md");
        std::fs::write(&unrelated, NEWER).unwrap();
        let refused = || {
            let mut reached_mutation = false;
            let result = state.with_origin(&origin, |root| {
                assert_no_pending_at(root, &unrelated.to_string_lossy())?;
                reached_mutation = true;
                std::fs::remove_file(&unrelated).map_err(|error| error.to_string())
            });
            assert!(result.is_err());
            assert!(!reached_mutation);
            assert_eq!(std::fs::read_to_string(&unrelated).unwrap(), NEWER);
        };
        std::fs::write(&journal, b"{not complete JSON").unwrap();
        refused();
        std::fs::write(&journal, &original).unwrap();
        let wrong_key = journal.with_file_name(format!("{}.json", "0".repeat(64)));
        std::fs::rename(&journal, &wrong_key).unwrap();
        refused();
        std::fs::rename(&wrong_key, &journal).unwrap();
        let unknown = journal.with_file_name("unexpected.json");
        std::fs::write(&unknown, b"{}").unwrap();
        refused();
        std::fs::remove_file(unknown).unwrap();
        let outside = tempfile::tempdir().unwrap();
        let other = outside.path().join("human.json");
        std::fs::write(&other, &original).unwrap();
        std::fs::remove_file(&journal).unwrap();
        symlink(&other, &journal).unwrap();
        refused();
        assert_eq!(std::fs::read(&other).unwrap(), original);
        assert_eq!(std::fs::read_to_string(path).unwrap(), ORIGINAL);
    });
}

#[cfg(unix)]
#[test]
fn acknowledged_data_remains_readable_after_the_note_or_its_parent_disappears() {
    for remove_parent in [false, true] {
        crate::settings::test_support::with_isolated_data("editor-recovery-missing-note", |data| {
            let (_vault, old_state, old_origin, path) = fixture();
            let saved = checkpoint(&old_state, &path, &old_origin);
            let journal = journal_path(data);
            let journal_before = std::fs::read(&journal).unwrap();
            std::fs::remove_file(&path).unwrap();
            let parent = path.parent().unwrap();
            if remove_parent {
                std::fs::remove_dir(parent).unwrap();
            }
            let state = VaultRoot::default();
            let origin = open(&state, Path::new(&old_origin.vault_path));
            assert_ne!(origin.opening_token, old_origin.opening_token);
            assert!(crate::editor_io::read(&state, &path.to_string_lossy(), &origin).is_err());
            let restored = load(&state, &path.to_string_lossy(), &origin)
                .unwrap()
                .unwrap();
            assert_eq!(
                serde_json::to_value(&restored).unwrap(),
                serde_json::to_value(&saved).unwrap()
            );
            assert_eq!(restored.baseline_raw, ORIGINAL);
            assert_eq!(restored.draft_raw, DRAFT);
            assert_eq!(restored.origin.opening_token, old_origin.opening_token);
            assert!(!SNAPSHOTS
                .get()
                .unwrap()
                .lock()
                .unwrap()
                .iter()
                .any(|snapshot| same_origin(&snapshot.origin, &origin)));
            assert!(stage(
                &state,
                &path.to_string_lossy(),
                &saved.baseline_revision,
                DRAFT,
                &origin,
                Some(&saved.revision)
            )
            .is_err());
            assert!(crate::editor_io::write(
                &state,
                &path.to_string_lossy(),
                DRAFT,
                &saved.baseline_revision,
                &origin
            )
            .is_err());
            assert!(
                !path.exists(),
                "loading acknowledged recovery data must not recreate the note"
            );
            assert_eq!(
                parent.exists(),
                !remove_parent,
                "recovery data must not create missing parents"
            );
            assert_eq!(std::fs::read(journal).unwrap(), journal_before);
            assert_eq!(
                load(&state, &path.to_string_lossy(), &origin)
                    .unwrap()
                    .unwrap()
                    .revision,
                saved.revision
            );
        });
    }
}

#[cfg(unix)]
#[test]
fn invalid_utf8_current_note_does_not_hide_or_reauthorize_acknowledged_data() {
    crate::settings::test_support::with_isolated_data(
        "editor-recovery-invalid-utf8-note",
        |data| {
            let (_vault, old_state, old_origin, path) = fixture();
            let saved = checkpoint(&old_state, &path, &old_origin);
            let journal = journal_path(data);
            let journal_before = std::fs::read(&journal).unwrap();
            let unreadable = b"Synthetic invalid UTF-8 current bytes: \xff\xfe\n";
            std::fs::write(&path, unreadable).unwrap();
            let state = VaultRoot::default();
            let origin = open(&state, Path::new(&old_origin.vault_path));
            assert!(crate::editor_io::read(&state, &path.to_string_lossy(), &origin).is_err());
            let restored = load(&state, &path.to_string_lossy(), &origin)
                .unwrap()
                .unwrap();
            assert_eq!(
                serde_json::to_value(&restored).unwrap(),
                serde_json::to_value(&saved).unwrap()
            );
            assert_eq!(restored.baseline_raw, ORIGINAL);
            assert_eq!(restored.baseline_revision, hash(ORIGINAL.as_bytes()));
            assert_eq!(restored.draft_raw, DRAFT);
            assert_eq!(restored.origin.opening_token, old_origin.opening_token);
            assert!(!SNAPSHOTS
                .get()
                .unwrap()
                .lock()
                .unwrap()
                .iter()
                .any(|snapshot| same_origin(&snapshot.origin, &origin)));
            assert!(stage(
                &state,
                &path.to_string_lossy(),
                &saved.baseline_revision,
                DRAFT,
                &origin,
                Some(&saved.revision)
            )
            .is_err());
            assert!(crate::editor_io::write(
                &state,
                &path.to_string_lossy(),
                DRAFT,
                &saved.baseline_revision,
                &origin
            )
            .is_err());
            assert_eq!(std::fs::read(&path).unwrap(), unreadable);
            assert_eq!(std::fs::read(journal).unwrap(), journal_before);
        },
    );
}
