//! Synthetic deletion tests use the production root-injected command helpers
//! and isolated persisted settings. They do not exercise Tauri or OS UI.

use super::{confirmed_deletion_targets, delete_path_at};
use crate::settings::{self, test_support::with_isolated_data, Settings};
use std::path::PathBuf;

const SOURCE: &str = "Original synthetic note; preserve these bytes.\n";
const CORRUPT_SETTINGS: &str = "{\"permanent_delete\": false, broken";

fn note_fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let note = root.join("synthetic.md");
    std::fs::write(&note, SOURCE).unwrap();
    (directory, root, note)
}

#[test]
fn deletion_mutation_corrupt_confirmed_policy_preserves_note() {
    with_isolated_data("delete-corrupt-confirmed", |data| {
        let settings_path = data.join("settings.json");
        std::fs::write(&settings_path, CORRUPT_SETTINGS).unwrap();
        let (_directory, root, note) = note_fixture();
        let path = note.to_string_lossy().into_owned();

        // Some(false) must not agree with display-only fallback defaults and
        // accidentally turn unavailable policy into a recoverable deletion.
        let error = delete_path_at(&root, path.clone(), Some(false)).unwrap_err();
        assert!(error.contains("parse settings"), "{error}");
        let error = confirmed_deletion_targets(&root, &[path], Some(false)).unwrap_err();
        assert!(error.contains("parse settings"), "{error}");
        assert_eq!(std::fs::read_to_string(note).unwrap(), SOURCE);
        assert_eq!(
            std::fs::read_to_string(settings_path).unwrap(),
            CORRUPT_SETTINGS
        );
    });
}

#[test]
fn deletion_mutation_corrupt_legacy_policy_preserves_note() {
    with_isolated_data("delete-corrupt-legacy", |data| {
        let settings_path = data.join("settings.json");
        std::fs::write(&settings_path, CORRUPT_SETTINGS).unwrap();
        let (_directory, root, note) = note_fixture();
        let path = note.to_string_lossy().into_owned();

        // Omitting the confirmation snapshot retains a readable persisted
        // policy; it does not authorize a default after a failed settings read.
        let error = delete_path_at(&root, path.clone(), None).unwrap_err();
        assert!(error.contains("parse settings"), "{error}");
        let error = confirmed_deletion_targets(&root, &[path], None).unwrap_err();
        assert!(error.contains("parse settings"), "{error}");
        assert_eq!(std::fs::read_to_string(note).unwrap(), SOURCE);
        assert_eq!(
            std::fs::read_to_string(settings_path).unwrap(),
            CORRUPT_SETTINGS
        );
    });
}

#[test]
fn deletion_mutation_unreadable_policy_preserves_note() {
    with_isolated_data("delete-unreadable-policy", |data| {
        let settings_path = data.join("settings.json");
        // A directory at the file path produces a real read I/O error without
        // relying on permission bits that privileged test users can bypass.
        std::fs::create_dir(&settings_path).unwrap();
        let (_directory, root, note) = note_fixture();
        let path = note.to_string_lossy().into_owned();

        for confirmation in [Some(false), None] {
            let error = delete_path_at(&root, path.clone(), confirmation).unwrap_err();
            assert!(error.contains("read settings"), "{error}");
            let error =
                confirmed_deletion_targets(&root, std::slice::from_ref(&path), confirmation)
                    .unwrap_err();
            assert!(error.contains("read settings"), "{error}");
            assert_eq!(std::fs::read_to_string(&note).unwrap(), SOURCE);
            assert!(settings_path.is_dir());
        }
    });
}

#[test]
fn deletion_mutation_confirmed_permanent_policy_deletes_note() {
    with_isolated_data("delete-confirmed-permanent", |data| {
        let persisted = Settings {
            permanent_delete: true,
            ..Settings::default()
        };
        std::fs::write(
            data.join("settings.json"),
            serde_json::to_string(&persisted).unwrap(),
        )
        .unwrap();
        assert!(settings::read_checked().unwrap().permanent_delete);
        let (_directory, root, note) = note_fixture();
        let path = note.to_string_lossy().into_owned();

        let error = delete_path_at(&root, path.clone(), Some(false)).unwrap_err();
        assert!(error.contains("policy changed"), "{error}");
        assert_eq!(std::fs::read_to_string(&note).unwrap(), SOURCE);
        let (targets, permanent) =
            confirmed_deletion_targets(&root, std::slice::from_ref(&path), Some(true)).unwrap();
        assert!(permanent);
        assert_eq!(targets, vec![note.clone()]);

        delete_path_at(&root, path, Some(true)).unwrap();
        assert!(!note.exists());
        assert!(settings::read_checked().unwrap().permanent_delete);
    });
}
