use super::*;
use std::collections::{BTreeMap, BTreeSet};

fn additional_fixture() -> (tempfile::TempDir, Ontology, RunManifest) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    seed_wiki_pages(root, GATE_MIN_WIKI_PAGES);
    save_synthetic_ontology(root, tiny_ontology());
    let ontology: Ontology =
        serde_json::from_slice(&std::fs::read(dir(root).join("ontology.json")).unwrap()).unwrap();
    std::fs::create_dir_all(root.join("_inbox")).unwrap();
    std::fs::write(root.join("_inbox/held.md"), format!("{PROSE} AAAAA")).unwrap();
    set_mtime(&root.join("_inbox/held.md"), old_mtime());
    std::fs::create_dir_all(root.join("raw")).unwrap();
    std::fs::write(root.join("raw/reference.md"), b"synthetic retained source").unwrap();
    let state = DistillState {
        model: ontology.model.clone(),
        embedding: ontology.embedding.clone(),
        last_run: Some(123),
        last_backlogs: vec![5, 4],
        agent_turns: vec![42],
        ..Default::default()
    };
    state_save(root, &state).unwrap();
    config_save(root, &DistillConfig::default()).unwrap();
    (directory, ontology, test_manifest())
}

#[derive(Debug, PartialEq)]
struct AdditionalSnapshot {
    directories: BTreeSet<String>,
    files: BTreeMap<String, (Vec<u8>, std::time::SystemTime)>,
}

fn additional_snapshot(root: &Path) -> AdditionalSnapshot {
    fn walk(root: &Path, directory: &Path, snapshot: &mut AdditionalSnapshot) {
        for entry in std::fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            let relative = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            let metadata = std::fs::symlink_metadata(&path).unwrap();
            if metadata.is_dir() {
                snapshot.directories.insert(relative);
                walk(root, &path, snapshot);
            } else {
                let bytes = if metadata.file_type().is_symlink() {
                    std::fs::read_link(&path)
                        .unwrap()
                        .to_string_lossy()
                        .as_bytes()
                        .to_vec()
                } else {
                    std::fs::read(&path).unwrap()
                };
                snapshot
                    .files
                    .insert(relative, (bytes, metadata.modified().unwrap()));
            }
        }
    }
    let mut snapshot = AdditionalSnapshot {
        directories: BTreeSet::new(),
        files: BTreeMap::new(),
    };
    walk(root, root, &mut snapshot);
    snapshot
}

fn additional_replace_same_stamp(path: &Path, replacement: &str) {
    let metadata = std::fs::metadata(path).unwrap();
    assert_eq!(metadata.len(), replacement.len() as u64);
    let modified = metadata.modified().unwrap();
    std::fs::write(path, replacement).unwrap();
    set_mtime(path, modified);
}

fn additional_scan(
    root: &Path,
    ontology: &Ontology,
    embed: &EmbedVectors<'_>,
    manifest: &mut RunManifest,
) -> Result<ScanOutcome, String> {
    scan(
        root,
        ontology,
        &DistillConfig::default(),
        20,
        embed,
        &[],
        manifest,
    )
}

fn additional_reject_profile(make_profile: impl FnOnce(&Path)) {
    let (directory, ontology, mut manifest) = additional_fixture();
    let root = directory.path();
    make_profile(&root.join("profile.md"));
    let before = additional_snapshot(root);
    let manifest_before = serde_json::to_vec(&manifest).unwrap();
    let producer = |_: Vec<String>| -> Result<Vec<Vec<f32>>, String> {
        panic!("invalid profile must fail before producer work")
    };
    assert!(additional_scan(root, &ontology, &producer, &mut manifest).is_err());
    assert_eq!(serde_json::to_vec(&manifest).unwrap(), manifest_before);
    assert_eq!(additional_snapshot(root), before);
}

#[test]
fn additional_invalid_utf8_profile_does_not_become_empty_interests() {
    crate::settings::test_support::with_isolated_data("distill-additional-profile-utf8", |_data| {
        additional_reject_profile(|path| std::fs::write(path, b"## Interests\n- \xff\n").unwrap());
    });
}

#[test]
fn additional_nonregular_profile_does_not_become_empty_interests() {
    crate::settings::test_support::with_isolated_data(
        "distill-additional-profile-directory",
        |_data| {
            additional_reject_profile(|path| std::fs::create_dir(path).unwrap());
        },
    );
}

#[cfg(unix)]
#[test]
fn additional_linked_profile_is_not_followed_as_admission_context() {
    crate::settings::test_support::with_isolated_data(
        "distill-additional-profile-linked",
        |_data| {
            let outside = tempfile::tempdir().unwrap();
            let target = outside.path().join("synthetic-profile.md");
            std::fs::write(&target, b"## Interests\n- synthetic topic\n").unwrap();
            let before = std::fs::read(&target).unwrap();
            additional_reject_profile(|path| std::os::unix::fs::symlink(&target, path).unwrap());
            assert_eq!(std::fs::read(&target).unwrap(), before);
        },
    );
}

#[test]
fn additional_body_change_during_embedding_aborts_before_moves_or_scoring() {
    crate::settings::test_support::with_isolated_data(
        "distill-additional-body-during-embed",
        |_data| {
            let (directory, ontology, mut manifest) = additional_fixture();
            let root = directory.path();
            let after_edit = std::cell::RefCell::new(None);
            let producer = |texts: Vec<String>| {
                additional_replace_same_stamp(
                    &root.join("_inbox/held.md"),
                    &format!("{PROSE} BBBBB"),
                );
                *after_edit.borrow_mut() = Some(additional_snapshot(root));
                Ok(texts.iter().map(|_| vec![0.2, 0.96_f32.sqrt()]).collect())
            };
            let manifest_before = serde_json::to_vec(&manifest).unwrap();
            assert!(
                additional_scan(root, &ontology, &producer, &mut manifest).is_err(),
                "changed source was moved or scored using the prior bytes"
            );
            assert_eq!(serde_json::to_vec(&manifest).unwrap(), manifest_before);
            assert_eq!(additional_snapshot(root), after_edit.into_inner().unwrap());
            assert!(!root.join("_inbox/quarantine").exists());
        },
    );
}

#[test]
fn additional_interests_change_during_embedding_aborts_before_moves_or_scoring() {
    crate::settings::test_support::with_isolated_data(
        "distill-additional-profile-during-embed",
        |_data| {
            let (directory, ontology, mut manifest) = additional_fixture();
            let root = directory.path();
            std::fs::write(root.join("profile.md"), "## Interests\n- old-topic\n").unwrap();
            let after_edit = std::cell::RefCell::new(None);
            let producer = |texts: Vec<String>| {
                additional_replace_same_stamp(
                    &root.join("profile.md"),
                    "## Interests\n- new-topic\n",
                );
                *after_edit.borrow_mut() = Some(additional_snapshot(root));
                Ok(texts.iter().map(|_| vec![0.2, 0.96_f32.sqrt()]).collect())
            };
            let manifest_before = serde_json::to_vec(&manifest).unwrap();
            assert!(
                additional_scan(root, &ontology, &producer, &mut manifest).is_err(),
                "changed profile authorized the in-flight verdict"
            );
            assert_eq!(serde_json::to_vec(&manifest).unwrap(), manifest_before);
            assert_eq!(additional_snapshot(root), after_edit.into_inner().unwrap());
            assert!(!root.join("_inbox/quarantine").exists());
        },
    );
}

#[test]
fn additional_published_knowledge_change_during_embedding_cannot_authorize_a_move() {
    crate::settings::test_support::with_isolated_data(
        "distill-additional-store-during-embed",
        |_data| {
            let (directory, ontology, _manifest) = additional_fixture();
            let root = directory.path();
            let expected = ontology.embedding.as_ref().unwrap();
            let state_before = std::fs::read(state_path(root)).unwrap();
            let source_before = std::fs::read(root.join("_inbox/held.md")).unwrap();
            let calls = std::cell::Cell::new(0);
            let producer = |texts: Vec<String>| {
                calls.set(calls.get() + 1);
                let mut store = current_store(root).unwrap();
                store
                    .upsert_page(
                        "wiki/topic.md",
                        "new-topic-revision",
                        vec![(8, vec![0.0, 1.0])],
                    )
                    .unwrap();
                let path = crate::vector_index::VectorStore::path_for(
                    &root.canonicalize().unwrap().to_string_lossy(),
                )
                .unwrap();
                store.save(&path).unwrap();
                Ok(EmbeddedBatch {
                    space: expected.clone(),
                    vectors: texts.iter().map(|_| vec![0.2, 0.96_f32.sqrt()]).collect(),
                })
            };
            assert!(
                run_checked(root, &DistillConfig::default(), expected, &producer).is_err(),
                "old ontology authorized admission after published knowledge changed"
            );
            assert_eq!(calls.get(), 1);
            assert_eq!(std::fs::read(state_path(root)).unwrap(), state_before);
            assert_eq!(
                std::fs::read(root.join("_inbox/held.md")).unwrap(),
                source_before
            );
            assert!(!root.join("_inbox/quarantine").exists());
            assert_eq!(
                std::fs::read(root.join("raw/reference.md")).unwrap(),
                b"synthetic retained source"
            );
        },
    );
}

#[test]
fn additional_irrelevant_ontology_timestamps_and_profile_sections_keep_a_valid_verdict() {
    crate::settings::test_support::with_isolated_data(
        "distill-additional-relevant-context",
        |_data| {
            let (directory, mut ontology, mut manifest) = additional_fixture();
            let root = directory.path();
            std::fs::write(
                root.join("profile.md"),
                "## Interests\n- same-topic\n## Roles\n- old role\n## Goals\n- old goal\n",
            )
            .unwrap();
            let producer = |texts: Vec<String>| Ok(texts.iter().map(|_| vec![1.0, 0.0]).collect());
            assert_eq!(
                additional_scan(root, &ontology, &producer, &mut manifest)
                    .unwrap()
                    .full,
                1
            );
            ontology.built_at += 1;
            ontology.clusters[0].last_touched += 1;
            std::fs::write(
                root.join("profile.md"),
                "## Interests\n- same-topic\n## Roles\n- new role\n## Goals\n- new goal\n",
            )
            .unwrap();
            let producer = |_: Vec<String>| -> Result<Vec<Vec<f32>>, String> {
                panic!("irrelevant lifecycle fields must not invalidate semantic admission")
            };
            let outcome = additional_scan(root, &ontology, &producer, &mut manifest).unwrap();
            assert_eq!(outcome.scored, 0);
            assert_eq!(
                state_load_checked(root, &ontology.model).unwrap().scored["_inbox/held.md"].tier,
                "full"
            );
            assert_eq!(
                std::fs::read(root.join("raw/reference.md")).unwrap(),
                b"synthetic retained source"
            );
        },
    );
}

#[test]
fn additional_representation_only_legacy_score_cannot_authorize_ingest() {
    crate::settings::test_support::with_isolated_data(
        "distill-additional-legacy-ledger",
        |_data| {
            let (directory, ontology, mut manifest) = additional_fixture();
            let root = directory.path();
            let producer = |texts: Vec<String>| Ok(texts.iter().map(|_| vec![1.0, 0.0]).collect());
            assert_eq!(
                additional_scan(root, &ontology, &producer, &mut manifest)
                    .unwrap()
                    .full,
                1
            );
            assert_eq!(full_tier_items(root).unwrap(), vec!["_inbox/held.md"]);
            let mut value: serde_json::Value =
                serde_json::from_slice(&std::fs::read(state_path(root)).unwrap()).unwrap();
            let entry = value["scored"]["_inbox/held.md"].as_object_mut().unwrap();
            entry.remove("source_sha256");
            entry.remove("decision_signature");
            std::fs::write(state_path(root), serde_json::to_vec_pretty(&value).unwrap()).unwrap();
            let before = additional_snapshot(root);
            assert!(
                full_tier_items(root).unwrap().is_empty(),
                "legacy model stamp was treated as a current decision receipt"
            );
            assert_eq!(additional_snapshot(root), before);
        },
    );
}

#[test]
fn additional_nonregular_current_source_is_an_error_for_full_tier_selection() {
    crate::settings::test_support::with_isolated_data(
        "distill-additional-source-directory",
        |_data| {
            let (directory, ontology, mut manifest) = additional_fixture();
            let root = directory.path();
            let producer = |texts: Vec<String>| Ok(texts.iter().map(|_| vec![1.0, 0.0]).collect());
            assert_eq!(
                additional_scan(root, &ontology, &producer, &mut manifest)
                    .unwrap()
                    .full,
                1
            );
            std::fs::rename(root.join("_inbox/held.md"), root.join("kept-source.md")).unwrap();
            std::fs::create_dir(root.join("_inbox/held.md")).unwrap();
            let before = additional_snapshot(root);
            assert!(
                full_tier_items(root).is_err(),
                "nonregular admitted path appeared absent or selectable"
            );
            assert_eq!(additional_snapshot(root), before);
        },
    );
}

#[test]
fn additional_original_unreceipted_metadata_fixture_remains_pending() {
    crate::settings::test_support::with_isolated_data(
        "distill-additional-legacy-metadata",
        |_data| {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path();
            let mut store = crate::vector_index::VectorStore::default();
            store.ensure_signature("test-model", "space-active");
            store
                .upsert_page("wiki/topic.md", "topic", vec![(7, vec![1.0, 0.0])])
                .unwrap();
            let path = crate::vector_index::VectorStore::path_for(
                &root.canonicalize().unwrap().to_string_lossy(),
            )
            .unwrap();
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            store.save(&path).unwrap();
            let titles = crate::commands::wiki_titles(root);
            let anchors = map_anchors_from_store(root, &store).unwrap();
            crate::ontology::save(
                root,
                &crate::ontology::build(&store, &titles, &anchors).unwrap(),
            )
            .unwrap();
            std::fs::create_dir_all(root.join("_inbox")).unwrap();
            std::fs::write(root.join("_inbox/held.md"), PROSE).unwrap();
            set_mtime(&root.join("_inbox/held.md"), old_mtime());
            let space =
                serde_json::json!({"model":"test-model","signature":"space-active","dim":2});
            let state = serde_json::json!({"model":"test-model", "embedding":space, "scored":{"_inbox/held.md":{"hash":crate::embeddings::content_hash(PROSE),"tier":"full","at":1,"embedding":space}}});
            std::fs::create_dir_all(dir(root)).unwrap();
            std::fs::write(state_path(root), serde_json::to_vec(&state).unwrap()).unwrap();
            let before = additional_snapshot(root);
            assert_eq!(status(root).backlog, 1);
            assert_eq!(report(root).unscored_by_folder["_inbox"], 1);
            assert!(full_tier_items(root).unwrap().is_empty());
            assert_eq!(additional_snapshot(root), before);
        },
    );
}
