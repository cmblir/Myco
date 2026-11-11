//! Real editor CAS and private map observations; no model or IPC mocks.
use super::*;

pub(super) fn save(root: &Path, content: &str) -> Result<(), String> {
    let state = crate::vault_session::VaultRoot::default();
    let generation = state.begin_open()?;
    state.finish_open(generation, root.to_path_buf(), || ())?;
    let origin = state.snapshot()?;
    let path = root.join(RELATIVE);
    let read = crate::editor_io::read(&state, path.to_str().unwrap(), &origin)?;
    crate::editor_io::write(
        &state,
        path.to_str().unwrap(),
        content,
        &read.revision,
        &origin,
    )?;
    Ok(())
}

#[test]
fn actual_editor_save_preserves_private_map_baseline_after_reopen() {
    with_isolated_data("map-editor-save", |data| {
        let (root, directory, _, baseline) = create(data);
        let annotated = format!("{baseline}\nSynthetic editor annotation.\n");
        save(&root, &annotated).unwrap();
        let found = discover(&root, &directory).unwrap();
        assert_eq!(found.baseline, baseline);
        assert_eq!(found.current, annotated);
        assert!(!found.has_owned_content_edits);
        let before = "Synthetic relationship [[wiki/synthetic.md]].\n";
        let after = "Updated synthetic relationship [[wiki/synthetic.md]].\n";
        let candidate = baseline.replace(before, after).replace(
            &format!("{:x}", Sha256::digest(before)),
            &format!("{:x}", Sha256::digest(after)),
        );
        let store = MapCreationStore::open(&root, RELATIVE).unwrap();
        let written = crate::vault::with_root_mutation(&root, |_, guard| {
            store.refresh(
                guard,
                &candidate,
                &format!("{:x}", Sha256::digest(&annotated)),
                &|| Ok(()),
            )
        })
        .unwrap();
        assert!(written.is_some());
        drop(store);
        let refreshed = discover(&root, &directory).unwrap();
        assert!(refreshed.current.contains(after));
        assert!(refreshed
            .current
            .ends_with("Synthetic editor annotation.\n"));
    });
}

#[test]
fn editor_owned_section_changes_never_become_the_generated_baseline() {
    with_isolated_data("map-editor-owned-change", |data| {
        let (root, directory, _, baseline) = create(data);
        let edited = baseline.replace("Synthetic relationship", "Human relationship edit");
        save(&root, &edited).unwrap();
        let second = format!("{edited}\nAnother human annotation.\n");
        save(&root, &second).unwrap();
        let found = discover(&root, &directory).unwrap();
        assert_eq!(found.baseline, baseline);
        assert_eq!(found.current, second);
        assert!(found.has_owned_content_edits);
        assert!(crate::vault::with_root_mutation(&root, |_, guard| {
            found.checked_prior(guard).map(|_| ())
        })
        .is_err());
        assert_eq!(
            std::fs::read_to_string(root.join(RELATIVE)).unwrap(),
            second
        );
    });
}

#[test]
fn editor_does_not_adopt_a_same_byte_replacement_or_public_map_markers() {
    with_isolated_data("map-editor-replacement", |data| {
        let (root, directory, _, baseline) = create(data);
        let replaced = root.join("replacement.md");
        std::fs::write(&replaced, &baseline).unwrap();
        std::fs::rename(replaced, root.join(RELATIVE)).unwrap();
        let entries = std::fs::read_dir(directory.path()).unwrap().count();
        let human = format!("{baseline}\nOrdinary unowned editor text.\n");
        save(&root, &human).unwrap();
        assert!(discover(&root, &directory)
            .err()
            .unwrap()
            .contains("no creation observation"));
        assert_eq!(
            std::fs::read_dir(directory.path()).unwrap().count(),
            entries
        );
        assert_eq!(std::fs::read_to_string(root.join(RELATIVE)).unwrap(), human);
    });
}

#[test]
fn editor_recovery_displays_saved_human_text_without_relabeling_its_baseline() {
    with_isolated_data("map-editor-history", |data| {
        let (root, directory, _, baseline) = create(data);
        let human = format!("{baseline}\nSynthetic saved annotation.\n");
        save(&root, &human).unwrap();
        let rows = recovery::inspect(&directory, &root, RELATIVE).unwrap();
        let current = rows
            .iter()
            .find(|row| row.evidence == crate::map_recovery::Evidence::CurrentObject)
            .unwrap();
        assert_eq!(current.before.as_deref(), Some(baseline.as_str()));
        assert_eq!(current.after.as_deref(), Some(human.as_str()));
        assert_eq!(discover(&root, &directory).unwrap().baseline, baseline);
    });
}

#[test]
fn editor_preserves_current_bytes_when_private_custody_is_corrupt() {
    with_isolated_data("map-editor-corrupt", |data| {
        let (root, directory, leaf, baseline) = create(data);
        std::fs::write(directory.path().join(leaf), b"{truncated").unwrap();
        assert!(save(&root, &format!("{baseline}\nNew annotation.\n")).is_err());
        assert_eq!(
            std::fs::read_to_string(root.join(RELATIVE)).unwrap(),
            baseline
        );
    });
}

#[test]
#[ignore = "invoked only by the isolated editor interruption parent"]
fn synthetic_editor_checkpoint_child() {
    let data = PathBuf::from(std::env::var_os("MYCO_DATA_DIR").unwrap());
    assert_eq!(
        std::fs::read_to_string(data.join("synthetic.marker")).unwrap(),
        "Synthetic editor interruption only"
    );
    let phase = std::env::var("MYCO_EDITOR_PHASE").unwrap();
    let checkpoint = std::env::var("MYCO_EDITOR_CHECKPOINT").unwrap();
    if phase == "write" {
        let (root, _, _, baseline) = create(&data);
        crate::vault::set_compiler_checkpoint(Some(|persisted| {
            if persisted == (std::env::var("MYCO_EDITOR_CHECKPOINT").unwrap() == "persisted") {
                // Terminate this isolated process without Rust destructors or
                // a successful editor receipt, at the actual publication seam.
                std::process::exit(73);
            }
        }));
        save(
            &root,
            &format!("{baseline}\nInterrupted editor annotation.\n"),
        )
        .unwrap();
        panic!("editor checkpoint was not reached");
    }
    assert_eq!(phase, "inspect");
    let root = data.join("vault").canonicalize().unwrap();
    let directory =
        crate::vault::open_compiler_pin_directory(&data.join("map-creation-custody")).unwrap();
    let found = discover(&root, &directory).unwrap();
    let expected = if checkpoint == "persisted" {
        format!("{}\nInterrupted editor annotation.\n", found.baseline)
    } else {
        found.baseline.clone()
    };
    assert_eq!(found.current, expected);
    assert!(!found.has_owned_content_edits);
    assert_eq!(
        std::fs::read_to_string(root.join(RELATIVE)).unwrap(),
        expected
    );
}

#[test]
fn editor_restart_recovers_only_the_current_object_at_both_persist_boundaries() {
    for checkpoint in ["pinned", "persisted"] {
        let temporary = tempfile::Builder::new()
            .prefix("myco-editor-interrupt-")
            .tempdir()
            .unwrap();
        let data = temporary.path().canonicalize().unwrap();
        std::fs::write(
            data.join("synthetic.marker"),
            "Synthetic editor interruption only",
        )
        .unwrap();
        for phase in ["write", "inspect"] {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "map_creation_observation::tests::editor::synthetic_editor_checkpoint_child",
                    "--ignored",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env("MYCO_DATA_DIR", &data)
                .env_remove("MEMEX_DATA_DIR")
                .env("MYCO_EDITOR_PHASE", phase)
                .env("MYCO_EDITOR_CHECKPOINT", checkpoint)
                .output()
                .unwrap();
            if phase == "write" {
                assert_eq!(
                    output.status.code(),
                    Some(73),
                    "{}",
                    String::from_utf8_lossy(&output.stderr)
                );
            } else {
                assert!(
                    output.status.success(),
                    "{}",
                    String::from_utf8_lossy(&output.stdout)
                );
                assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
            }
        }
    }
}
