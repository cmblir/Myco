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
        assert_eq!(
            std::fs::read_to_string(root.join(RELATIVE)).unwrap(),
            annotated
        );
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
