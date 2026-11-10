use super::*;
use crate::map_custody::MapCreationStore;
use crate::settings::test_support::with_isolated_data;
use std::path::PathBuf;

const RELATIVE: &str = "wiki/maps/synthetic.md";

fn create(data: &Path) -> (PathBuf, CompilerPinDirectory, String, String) {
    let root = data.join("vault");
    std::fs::create_dir_all(root.join("wiki/maps")).unwrap();
    let root = root.canonicalize().unwrap();
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../src/lib/mapContent.fixture.json")).unwrap();
    let baseline = fixture["content"].as_str().unwrap().to_owned();
    let store = MapCreationStore::open(&root, RELATIVE).unwrap();
    crate::vault::with_root_mutation(&root, |_, guard| {
        let written = store.write(guard, root.join(RELATIVE).to_str().unwrap(), &baseline)?;
        store.record(guard, &written, &baseline)?;
        Ok(())
    })
    .unwrap();
    drop(store);
    let directory = crate::vault::open_compiler_pin_directory(
        &data.join("map-creation-custody").canonicalize().unwrap(),
    )
    .unwrap();
    let leaf = std::fs::read_dir(directory.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .find(|leaf| leaf.ends_with(".json"))
        .unwrap();
    (root, directory, leaf, baseline)
}

fn read(
    root: &Path,
    directory: &CompilerPinDirectory,
    leaf: &str,
) -> Result<CreationContent, String> {
    crate::vault::with_root_mutation(root, |canonical, guard| {
        read_creation(directory, leaf, canonical, RELATIVE, guard)
    })
}

fn discover(root: &Path, directory: &CompilerPinDirectory) -> Result<CreationContent, String> {
    crate::vault::with_root_mutation(root, |canonical, guard| {
        discover_creation(directory, canonical, RELATIVE, guard)
    })
}

#[test]
fn recovery_displays_stable_snapshots_without_granting_publication_status() {
    with_isolated_data("map-recovery-snapshots", |data| {
        let (root, directory, leaf, baseline) = create(data);
        let rows = recovery::inspect(&directory, &root, RELATIVE).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].evidence,
            crate::map_recovery::Evidence::CurrentObject
        );
        assert_eq!(rows[0].after.as_deref(), Some(baseline.as_str()));
        assert!(rows[0].before.is_none());
        // Removing only the synthetic canonical link does not delete custody.
        std::fs::remove_file(root.join(RELATIVE)).unwrap();
        let rows = recovery::inspect(&directory, &root, RELATIVE).unwrap();
        assert_eq!(
            rows[0].evidence,
            crate::map_recovery::Evidence::PublicationUnknown
        );
        assert_eq!(rows[0].after.as_deref(), Some(baseline.as_str()));
        std::fs::write(directory.path().join(leaf), "{truncated").unwrap();
        let rows = recovery::inspect(&directory, &root, RELATIVE).unwrap();
        assert_eq!(
            rows[0].evidence,
            crate::map_recovery::Evidence::InvalidRecord
        );
        assert!(rows[0].before.is_none() && rows[0].after.is_none());
    });
}

#[test]
fn recovery_rejects_changes_after_scan_and_stale_vault_openings() {
    with_isolated_data("map-recovery-races", |data| {
        let (root, directory, leaf, _) = create(data);
        let error = recovery::inspect_at(&directory, &root, RELATIVE, || {
            std::fs::write(directory.path().join(&leaf), "{}").map_err(|e| e.to_string())
        })
        .unwrap_err();
        assert!(error.contains("readback differs"));
        let state = crate::vault_session::VaultRoot::default();
        let generation = state.begin_open().unwrap();
        state.finish_open(generation, root.clone(), || ()).unwrap();
        let origin = state.snapshot().unwrap();
        let generation = state.begin_open().unwrap();
        state.finish_open(generation, root, || ()).unwrap();
        assert!(crate::map_recovery::inspect(&state, &origin, "synthetic").is_err());
    });
}

#[test]
fn recovery_rejects_target_replacement_and_symlink_parents() {
    with_isolated_data("map-recovery-target-race", |data| {
        let (root, directory, _, baseline) = create(data);
        let error = recovery::inspect_at(&directory, &root, RELATIVE, || {
            let replacement = root.join("replacement.md");
            std::fs::write(&replacement, &baseline).map_err(|e| e.to_string())?;
            std::fs::rename(replacement, root.join(RELATIVE)).map_err(|e| e.to_string())
        })
        .unwrap_err();
        assert!(error.contains("changed during inspection"));
        std::fs::rename(root.join("wiki/maps"), root.join("retained-maps")).unwrap();
        std::os::unix::fs::symlink(root.join("retained-maps"), root.join("wiki/maps")).unwrap();
        assert!(recovery::inspect(&directory, &root, RELATIVE)
            .unwrap_err()
            .contains("parent is not a directory"));
    });
}

#[test]
fn recovery_isolates_vault_scope_and_hides_invalid_scope_snapshots() {
    with_isolated_data("map-recovery-scope", |data| {
        let (root, directory, leaf, _) = create(data);
        let other = data.join("other-vault");
        std::fs::create_dir_all(other.join("wiki/maps")).unwrap();
        assert!(recovery::inspect(&directory, &other, RELATIVE)
            .unwrap()
            .is_empty());
        assert!(recovery::inspect(&directory, &root, "wiki/maps/../synthetic.md").is_err());
        let path = directory.path().join(leaf);
        let mut record: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        record["scope"]["vault"] = serde_json::json!(other.to_str().unwrap());
        std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        let rows = recovery::inspect(&directory, &root, RELATIVE).unwrap();
        assert_eq!(
            rows[0].evidence,
            crate::map_recovery::Evidence::InvalidRecord
        );
        assert!(rows[0].before.is_none() && rows[0].after.is_none());
    });
}

#[test]
fn recovery_snapshot_budget_fails_without_a_partial_result() {
    with_isolated_data("map-recovery-budget", |data| {
        let (root, directory, leaf, _) = create(data);
        let prefix = leaf.split_once('.').unwrap().0;
        for generation in 0..256 {
            let name = format!("{prefix}.{generation:032x}.json");
            crate::map_custody_record::write_record(&directory, &name, b"{}").unwrap();
        }
        assert!(recovery::inspect(&directory, &root, RELATIVE)
            .unwrap_err()
            .contains("snapshot budget exceeded"));
    });
}

#[test]
fn recovery_catalog_finds_deleted_maps_without_exposing_another_vault() {
    with_isolated_data("map-catalog-deleted", |data| {
        let (root, directory, _, baseline) = create(data);
        let other = data.join("other-vault");
        std::fs::create_dir_all(other.join("wiki/maps")).unwrap();
        let other = other.canonicalize().unwrap();
        let relative = "wiki/maps/other-private-map.md";
        let store = MapCreationStore::open(&other, relative).unwrap();
        crate::vault::with_root_mutation(&other, |_, guard| {
            let written = store.write(guard, other.join(relative).to_str().unwrap(), &baseline)?;
            store.record(guard, &written, &baseline)?;
            Ok(())
        })
        .unwrap();
        std::fs::remove_file(root.join(RELATIVE)).unwrap();
        let found = catalog::discover(&directory, &root).unwrap();
        assert_eq!(found.keys, vec!["synthetic"]);
        assert!(!found.has_unidentified_records);
        let found = catalog::discover(&directory, &other).unwrap();
        assert_eq!(found.keys, vec!["other-private-map"]);
        assert!(!found.has_unidentified_records);
        let snapshots = recovery::inspect(&directory, &root, RELATIVE).unwrap();
        assert_eq!(
            snapshots[0].evidence,
            crate::map_recovery::Evidence::PublicationUnknown
        );
        assert_eq!(snapshots[0].after.as_deref(), Some(baseline.as_str()));
    });
}

#[test]
fn recovery_catalog_reports_unidentified_records_without_using_their_paths() {
    with_isolated_data("map-catalog-invalid", |data| {
        let (root, directory, leaf, _) = create(data);
        let path = directory.path().join(&leaf);
        let original = std::fs::read(&path).unwrap();
        for content in [b"{broken".to_vec(), {
            let mut record: serde_json::Value = serde_json::from_slice(&original).unwrap();
            record["scope"]["path"] = serde_json::json!("wiki/maps/../../private.md");
            serde_json::to_vec(&record).unwrap()
        }] {
            std::fs::write(&path, content).unwrap();
            let found = catalog::discover(&directory, &root).unwrap();
            assert!(found.keys.is_empty());
            assert!(found.has_unidentified_records);
        }
    });
}

#[test]
fn recovery_catalog_rejects_changes_during_scan_and_stale_openings() {
    with_isolated_data("map-catalog-race", |data| {
        let (root, directory, leaf, _) = create(data);
        let error = catalog::discover_at(&directory, &root, || {
            std::fs::write(directory.path().join(&leaf), "{}").map_err(|e| e.to_string())
        })
        .unwrap_err();
        assert!(error.contains("readback differs"));
        let state = crate::vault_session::VaultRoot::default();
        let generation = state.begin_open().unwrap();
        state.finish_open(generation, root.clone(), || ()).unwrap();
        let origin = state.snapshot().unwrap();
        let generation = state.begin_open().unwrap();
        state.finish_open(generation, root, || ()).unwrap();
        assert!(crate::map_recovery::catalog(&state, &origin).is_err());
    });
}

#[test]
#[ignore = "invoked only by the isolated two-process discovery test"]
fn synthetic_discovery_child() {
    let data = PathBuf::from(std::env::var_os("MYCO_DATA_DIR").unwrap());
    assert_eq!(
        std::fs::read_to_string(data.join("synthetic.marker")).unwrap(),
        "Synthetic map restart only"
    );
    match std::env::var("MYCO_MAP_DISCOVERY_PHASE").unwrap().as_str() {
        "create" => {
            let (root, _, _, baseline) = create(&data);
            std::fs::write(
                root.join(RELATIVE),
                format!("{baseline}\nSynthetic restart annotation.\n"),
            )
            .unwrap();
        }
        "discover" => {
            let root = data.join("vault").canonicalize().unwrap();
            let directory = crate::vault::open_compiler_pin_directory(
                &data.join("map-creation-custody").canonicalize().unwrap(),
            )
            .unwrap();
            let found = discover(&root, &directory).unwrap();
            assert_eq!(
                found.current,
                format!("{}\nSynthetic restart annotation.\n", found.baseline)
            );
            assert_eq!(
                std::fs::read_to_string(root.join(RELATIVE)).unwrap(),
                found.current
            );
        }
        phase => panic!("unexpected synthetic discovery phase: {phase}"),
    }
}

#[test]
fn discovers_creation_in_a_new_process_after_writer_exit() {
    let data = tempfile::Builder::new()
        .prefix("myco-synthetic-map-restart-")
        .tempdir()
        .unwrap();
    std::fs::write(
        data.path().join("synthetic.marker"),
        "Synthetic map restart only",
    )
    .unwrap();
    for phase in ["create", "discover"] {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "map_creation_observation::tests::synthetic_discovery_child",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("MYCO_MAP_DISCOVERY_PHASE", phase)
            .env("MYCO_DATA_DIR", data.path())
            .env_remove("MEMEX_DATA_DIR")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{phase} child failed: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
    }
}

#[test]
fn discovers_without_generation_key_after_handles_close() {
    with_isolated_data("map-discovery-reopen", |data| {
        let (root, directory, _, baseline) = create(data);
        let annotated = format!("{baseline}\nSynthetic human annotation.\n");
        std::fs::write(root.join(RELATIVE), &annotated).unwrap();
        let found = discover(&root, &directory).unwrap();
        assert_eq!(found.baseline, baseline);
        assert_eq!(found.current, annotated);

        // Retained old generations must not prevent a new creation at this path.
        std::fs::remove_file(root.join(RELATIVE)).unwrap();
        let store = MapCreationStore::open(&root, RELATIVE).unwrap();
        crate::vault::with_root_mutation(&root, |_, guard| {
            let written = store.write(guard, root.join(RELATIVE).to_str().unwrap(), &baseline)?;
            store.record(guard, &written, &baseline)?;
            Ok(())
        })
        .unwrap();
        drop(store);
        assert_eq!(discover(&root, &directory).unwrap().current, baseline);
    });
}

#[test]
fn discovery_rejects_missing_corrupt_and_ambiguous_evidence() {
    with_isolated_data("map-discovery-invalid", |data| {
        let (root, directory, leaf, baseline) = create(data);
        let record_path = directory.path().join(&leaf);
        let bytes = std::fs::read(&record_path).unwrap();
        std::fs::write(&record_path, b"{}").unwrap();
        assert!(discover(&root, &directory).is_err());
        std::fs::write(&record_path, &bytes).unwrap();
        let other_leaf = format!(
            "{}.{}.json",
            leaf.split('.').next().unwrap(),
            "f".repeat(32)
        );
        let duplicate = directory.path().join(other_leaf);
        std::fs::copy(&record_path, &duplicate).unwrap();
        assert!(discover(&root, &directory).is_err());
        std::fs::remove_file(duplicate).unwrap();
        std::fs::remove_file(record_path).unwrap();
        assert!(discover(&root, &directory).is_err());
        assert_eq!(
            std::fs::read_to_string(root.join(RELATIVE)).unwrap(),
            baseline
        );
    });
}

#[test]
fn discovery_rejects_replaced_target_and_bounded_directory_overflow() {
    with_isolated_data("map-discovery-replacement", |data| {
        let (root, directory, _, baseline) = create(data);
        let replacement = root.join("replacement.md");
        std::fs::write(&replacement, &baseline).unwrap();
        std::fs::rename(replacement, root.join(RELATIVE)).unwrap();
        assert!(discover(&root, &directory)
            .err()
            .unwrap()
            .contains("no creation observation"));
        assert_eq!(
            std::fs::read_to_string(root.join(RELATIVE)).unwrap(),
            baseline
        );
    });
    with_isolated_data("map-discovery-bounds", |data| {
        let (root, directory, _, baseline) = create(data);
        for index in 0..4096 {
            std::fs::write(directory.path().join(format!("synthetic-{index}")), b"").unwrap();
        }
        assert!(discover(&root, &directory)
            .err()
            .unwrap()
            .contains("entry budget"));
        assert_eq!(
            std::fs::read_to_string(root.join(RELATIVE)).unwrap(),
            baseline
        );
    });
}

#[test]
fn reopens_creation_evidence_after_handles_close_and_keeps_human_text_separate() {
    with_isolated_data("map-observation-reopen", |data| {
        let (root, directory, leaf, baseline) = create(data);
        let first = read(&root, &directory, &leaf).unwrap();
        assert_eq!(first.baseline, baseline);
        assert_eq!(first.current, baseline);
        let annotated = format!("{baseline}\nSynthetic human annotation.\n");
        std::fs::write(root.join(RELATIVE), &annotated).unwrap();
        let edited = read(&root, &directory, &leaf).unwrap();
        assert_eq!(edited.baseline, baseline);
        assert_eq!(edited.current, annotated);
        assert!(!edited.has_owned_content_edits);
        assert_eq!(
            std::fs::read_to_string(root.join(RELATIVE)).unwrap(),
            annotated
        );
        let owned_edit = annotated.replace("Synthetic relationship", "Human revised relationship");
        std::fs::write(root.join(RELATIVE), &owned_edit).unwrap();
        let edited = read(&root, &directory, &leaf).unwrap();
        assert!(edited.has_owned_content_edits);
        assert_eq!(edited.current, owned_edit);
    });
}

#[test]
fn rejects_schema_scope_generation_revision_and_issued_object_mismatches() {
    with_isolated_data("map-observation-invalid", |data| {
        let (root, directory, leaf, _) = create(data);
        let path = directory.path().join(&leaf);
        let original = std::fs::read(&path).unwrap();
        for case in [
            "version", "state", "scope", "anchor", "revision", "inode", "unknown", "baseline",
        ] {
            let mut record: serde_json::Value = serde_json::from_slice(&original).unwrap();
            match case {
                "version" => record["version"] = 2.into(),
                "state" => record["state"] = "published".into(),
                "scope" => record["scope"]["path"] = "wiki/maps/other.md".into(),
                "anchor" => record["anchor"] = "../synthetic.anchor".into(),
                "revision" => record["revision"] = "f".repeat(64).into(),
                "inode" => record["fileIdentity"]["inode"] = 0.into(),
                "unknown" => record["nativeCreated"] = true.into(),
                "baseline" => {
                    record["baseline"] = "unmarked synthetic map".into();
                    record["revision"] =
                        format!("{:x}", Sha256::digest(b"unmarked synthetic map")).into();
                }
                _ => unreachable!(),
            }
            std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
            assert!(read(&root, &directory, &leaf).is_err(), "{case}");
        }
        std::fs::write(&path, original).unwrap();
        read(&root, &directory, &leaf).unwrap();
        let wrong_leaf = format!("{}.{}.json", "0".repeat(64), "1".repeat(32));
        std::fs::rename(&path, directory.path().join(&wrong_leaf)).unwrap();
        assert!(read(&root, &directory, &wrong_leaf).is_err());
    });
}

#[test]
fn rejects_same_bytes_target_replacement_and_another_vault() {
    with_isolated_data("map-observation-object", |data| {
        let (root, directory, leaf, baseline) = create(data);
        let other = data.join("other-vault");
        std::fs::create_dir_all(other.join("wiki/maps")).unwrap();
        std::fs::write(other.join(RELATIVE), &baseline).unwrap();
        assert!(read(&other, &directory, &leaf).is_err());
        let untrusted_path = data.join("synthetic-other-store");
        std::fs::create_dir(&untrusted_path).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&untrusted_path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let untrusted =
            crate::vault::open_compiler_pin_directory(&untrusted_path.canonicalize().unwrap())
                .unwrap();
        assert!(read(&root, &untrusted, &leaf)
            .err()
            .unwrap()
            .contains("private app-data directory"));
        let replacement = root.join("synthetic-replacement.md");
        std::fs::write(&replacement, &baseline).unwrap();
        std::fs::rename(replacement, root.join(RELATIVE)).unwrap();
        assert!(read(&root, &directory, &leaf).is_err());
        assert_eq!(
            std::fs::read_to_string(root.join(RELATIVE)).unwrap(),
            baseline
        );
    });
}

#[test]
fn rejects_pair_replacement_between_named_anchor_check_and_reopen() {
    with_isolated_data("map-observation-pair-race", |data| {
        let (root, directory, leaf, baseline) = create(data);
        let record: serde_json::Value =
            serde_json::from_slice(&std::fs::read(directory.path().join(&leaf)).unwrap()).unwrap();
        let anchor = directory.path().join(record["anchor"].as_str().unwrap());
        let result = crate::vault::with_root_mutation(&root, |canonical, guard| {
            read_at(&directory, &leaf, canonical, RELATIVE, guard, || {
                let replacement = root.join("synthetic-pair-replacement.md");
                std::fs::write(&replacement, &baseline).unwrap();
                std::fs::remove_file(&anchor).unwrap();
                std::fs::hard_link(&replacement, &anchor).unwrap();
                std::fs::rename(replacement, root.join(RELATIVE)).unwrap();
                Ok(())
            })
        });
        assert!(
            result.is_err(),
            "reopening a matching pair must still prove the recorded object"
        );
        assert_eq!(
            std::fs::read_to_string(root.join(RELATIVE)).unwrap(),
            baseline
        );
    });
}

#[test]
fn refresh_history_requires_valid_before_image_and_preserves_legacy_records() {
    with_isolated_data("map-history-schema", |data| {
        let (root, directory, leaf, baseline) = create(data);
        let path = directory.path().join(&leaf);
        let mut record: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        record["version"] = 2.into();
        record["state"] = "refreshObserved".into();
        record.as_object_mut().unwrap().remove("previous");
        std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(read(&root, &directory, &leaf)
            .unwrap()
            .previous_content
            .is_none());
        record["version"] = 3.into();
        std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(read(&root, &directory, &leaf).is_err());
        record["previous"] = serde_json::json!({
            "revision": format!("{:x}", Sha256::digest(baseline.as_bytes())),
            "content": baseline,
        });
        std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert_eq!(
            read(&root, &directory, &leaf)
                .unwrap()
                .previous_content
                .as_deref(),
            Some(baseline.as_str())
        );
        record["previous"]["content"] = "Corrupted previous content".into();
        std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(read(&root, &directory, &leaf)
            .err()
            .unwrap()
            .contains("previous snapshot"));
        record["previous"]["revision"] =
            format!("{:x}", Sha256::digest(b"Corrupted previous content")).into();
        std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(read(&root, &directory, &leaf)
            .err()
            .unwrap()
            .contains("previous snapshot"));
        assert_eq!(
            std::fs::read_to_string(root.join(RELATIVE)).unwrap(),
            baseline
        );
    });
}

#[test]
fn partial_staging_is_not_discovered_as_a_map_observation() {
    with_isolated_data("map-partial-staging", |data| {
        let (root, directory, _, baseline) = create(data);
        let pending = directory.path().join(".map-record-synthetic.tmp");
        std::fs::write(&pending, b"{\"partial\":").unwrap();
        let observed = discover(&root, &directory).unwrap();
        assert_eq!(observed.baseline, baseline);
        assert_eq!(observed.current, baseline);
        assert_eq!(std::fs::read(pending).unwrap(), b"{\"partial\":");
    });
}
