// Native witnesses for settled-map anchors and current organization sources.
// Controlled vectors isolate admission contracts; they do not certify model quality.

use super::*;
use std::collections::{BTreeMap, BTreeSet};

const ANCHOR_PATH: &str = "wiki/maps/settled.md";
const COVERAGE_MEMBER: &str = "wiki/member-00/topic.md";
const COVERAGE_INFLOW: &str = "_inbox/held.md";

fn anchor_content(kind: &str, status: Option<&str>) -> String {
    let status = status.map_or(String::new(), |value| format!("status: {value}\n"));
    format!(
        "---\ntitle: Synthetic topic map\ntype: {kind}\ncluster: topic\ncreated: 2026-01-01\nconfidence: medium\n{status}---\n\n{PROSE} AAAAA\n"
    )
}

fn insert_current_page(
    store: &mut crate::vector_index::VectorStore,
    page: &str,
    content: &str,
    vector: &[f32],
) {
    let stem = Path::new(page).file_stem().unwrap().to_str().unwrap();
    let chunks = crate::embeddings::chunk_page(content);
    assert!(!chunks.is_empty());
    let entries = chunks
        .iter()
        .enumerate()
        .map(|(section, chunk)| {
            (
                section,
                crate::embeddings::content_hash(chunk),
                vector.to_vec(),
            )
        })
        .collect();
    store.upsert_page_sections(page, stem, entries).unwrap();
}

fn anchor_fixture(content: &str) -> (tempfile::TempDir, crate::vector_index::VectorStore) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    std::fs::create_dir_all(root.join("wiki/maps")).unwrap();
    std::fs::write(root.join(ANCHOR_PATH), content).unwrap();
    let mut store = crate::vector_index::VectorStore::default();
    store.ensure_signature(
        "builtin-local:synthetic-current-encoder",
        "synthetic-current-chunk-policy-v1",
    );
    insert_current_page(&mut store, ANCHOR_PATH, content, &[0.6, 0.8]);
    (directory, store)
}

#[derive(Debug, PartialEq)]
struct AnchorSnapshot {
    directories: BTreeSet<String>,
    files: BTreeMap<String, (Vec<u8>, std::time::SystemTime)>,
}

fn anchor_snapshot(root: &Path) -> AnchorSnapshot {
    fn walk(root: &Path, directory: &Path, snapshot: &mut AnchorSnapshot) {
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
    let mut snapshot = AnchorSnapshot {
        directories: BTreeSet::new(),
        files: BTreeMap::new(),
    };
    walk(root, root, &mut snapshot);
    snapshot
}

fn assert_anchor_excluded(kind: &str, status: Option<&str>) {
    let (directory, store) = anchor_fixture(&anchor_content(kind, status));
    let root = directory.path();
    let before = anchor_snapshot(root);
    assert!(
        map_anchors_from_store(root, &store).unwrap().is_empty(),
        "a nonsettled or nonmap page acquired topic-anchor authority"
    );
    assert_eq!(anchor_snapshot(root), before);
}

#[test]
fn anchor_active_map_with_exact_current_chunks_remains_eligible() {
    let (directory, store) = anchor_fixture(&anchor_content("map", Some("active")));
    let root = directory.path();
    let before = anchor_snapshot(root);
    let expected = store.page_centroids().unwrap()[0].1.clone();
    assert_eq!(
        map_anchors_from_store(root, &store).unwrap(),
        vec![("topic".to_string(), expected)]
    );
    assert_eq!(anchor_snapshot(root), before);
}

#[test]
fn anchor_draft_map_is_not_a_settled_anchor() {
    assert_anchor_excluded("map", Some("draft"));
}

#[test]
fn anchor_missing_map_status_does_not_infer_review() {
    assert_anchor_excluded("map", None);
}

#[test]
fn anchor_disputed_map_is_not_a_settled_anchor() {
    assert_anchor_excluded("map", Some("disputed"));
}

#[test]
fn anchor_superseded_map_is_not_a_settled_anchor() {
    assert_anchor_excluded("map", Some("superseded"));
}

#[test]
fn anchor_concept_inside_maps_directory_does_not_gain_map_authority() {
    assert_anchor_excluded("concept", Some("active"));
}

#[test]
fn anchor_approved_generation_proposal_does_not_settle_its_draft() {
    let (directory, store) = anchor_fixture(&anchor_content("map", Some("draft")));
    let root = directory.path();
    std::fs::create_dir_all(root.join("work/feedback")).unwrap();
    std::fs::write(
        root.join("work/feedback/draft-map.md"),
        "---\ntype: distill-proposal\naction: draft-map\nstatus: approved\npayload:\n  cluster: topic\n  members: []\n---\n\nSynthetic consent to generate a draft.\n",
    )
    .unwrap();
    let before = anchor_snapshot(root);
    assert!(map_anchors_from_store(root, &store).unwrap().is_empty());
    assert_eq!(anchor_snapshot(root), before);
}

#[test]
fn anchor_current_body_must_match_its_published_chunk_vectors() {
    let content = anchor_content("map", Some("active"));
    let (directory, store) = anchor_fixture(&content);
    let root = directory.path();
    assert_eq!(map_anchors_from_store(root, &store).unwrap().len(), 1);
    let replacement = content.replace("AAAAA", "BBBBB");
    let path = root.join(ANCHOR_PATH);
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    std::fs::write(&path, &replacement).unwrap();
    set_mtime(&path, modified);
    assert_ne!(
        crate::embeddings::chunk_page(&content),
        crate::embeddings::chunk_page(&replacement)
    );
    let before = anchor_snapshot(root);
    match map_anchors_from_store(root, &store) {
        Ok(anchors) => assert!(
            anchors.is_empty(),
            "stale map vectors anchored changed body"
        ),
        Err(_) => {}
    }
    assert_eq!(anchor_snapshot(root), before);
}

fn assert_anchor_source_error(mutate: impl FnOnce(&Path)) {
    let (directory, store) = anchor_fixture(&anchor_content("map", Some("active")));
    let root = directory.path();
    mutate(&root.join(ANCHOR_PATH));
    let before = anchor_snapshot(root);
    assert!(
        map_anchors_from_store(root, &store).is_err(),
        "existing anchor source failure was silently treated as absence"
    );
    assert_eq!(anchor_snapshot(root), before);
}

#[test]
fn anchor_nonregular_current_source_is_an_error() {
    assert_anchor_source_error(|path| {
        std::fs::remove_file(path).unwrap();
        std::fs::create_dir(path).unwrap();
    });
}

#[test]
fn anchor_invalid_utf8_current_source_is_an_error() {
    assert_anchor_source_error(|path| std::fs::write(path, b"---\ntype: map\n---\n\xff").unwrap());
}

#[cfg(unix)]
#[test]
fn anchor_linked_current_source_is_not_followed() {
    let outside = tempfile::tempdir().unwrap();
    let target = outside.path().join("synthetic-map.md");
    let body = anchor_content("map", Some("active"));
    std::fs::write(&target, &body).unwrap();
    assert_anchor_source_error(|path| {
        std::fs::remove_file(path).unwrap();
        std::os::unix::fs::symlink(&target, path).unwrap();
    });
    assert_eq!(std::fs::read(&target).unwrap(), body.as_bytes());
}

#[cfg(unix)]
#[test]
fn anchor_unreadable_current_source_is_not_absence() {
    use std::os::unix::fs::PermissionsExt;
    let (directory, store) = anchor_fixture(&anchor_content("map", Some("active")));
    let root = directory.path();
    let path = root.join(ANCHOR_PATH);
    let before = anchor_snapshot(root);
    let permissions = std::fs::metadata(&path).unwrap().permissions();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
    let read_denied = std::fs::read(&path).is_err();
    let result = map_anchors_from_store(root, &store);
    std::fs::set_permissions(&path, permissions).unwrap();
    assert!(
        read_denied,
        "permission-denied witness requires an ordinary user"
    );
    assert!(result.is_err(), "unreadable map silently became no anchor");
    assert_eq!(anchor_snapshot(root), before);
}

fn coverage_content() -> String {
    format!(
        "---\ntitle: Synthetic current topic\ntype: concept\ncreated: 2026-01-01\nconfidence: medium\nstatus: active\n---\n\n{PROSE} AAAAA\n"
    )
}

/// Every current nonempty wiki page has all actual sections in the published store.
/// Shared stems/titles make path-only replacement independent of directory order.
fn coverage_fixture(score: bool) -> (tempfile::TempDir, Ontology) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let mut store = crate::vector_index::VectorStore::default();
    store.ensure_signature(
        "builtin-local:synthetic-current-encoder",
        "synthetic-current-chunk-policy-v1",
    );
    let content = coverage_content();
    for index in 0..GATE_MIN_WIKI_PAGES {
        let relative = format!("wiki/member-{index:02}/topic.md");
        let path = root.join(&relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &content).unwrap();
        set_mtime(&path, old_mtime());
        insert_current_page(&mut store, &relative, &content, &[1.0, 0.0]);
    }
    let index_path =
        crate::vector_index::VectorStore::path_for(&root.canonicalize().unwrap().to_string_lossy())
            .unwrap();
    store.save(&index_path).unwrap();
    let titles = crate::commands::wiki_titles(root);
    let anchors = map_anchors_from_store(root, &store).unwrap();
    let ontology = crate::ontology::build(&store, &titles, &anchors).unwrap();
    assert_eq!(ontology.wiki_pages, GATE_MIN_WIKI_PAGES);
    assert_eq!(ontology.clusters.len(), 1);
    assert_eq!(ontology.clusters[0].members.len(), GATE_MIN_WIKI_PAGES);
    crate::ontology::save(root, &ontology).unwrap();
    config_save(root, &DistillConfig::default()).unwrap();
    std::fs::create_dir_all(root.join("_inbox")).unwrap();
    std::fs::write(root.join(COVERAGE_INFLOW), PROSE).unwrap();
    set_mtime(&root.join(COVERAGE_INFLOW), old_mtime());
    std::fs::create_dir_all(root.join("raw")).unwrap();
    std::fs::write(
        root.join("raw/reference.md"),
        "synthetic owner-maintained original",
    )
    .unwrap();
    std::fs::create_dir_all(root.join("kept")).unwrap();
    std::fs::write(root.join("kept/reference.md"), "synthetic owner-kept note").unwrap();
    std::fs::write(
        dir(root).join("distill-kept.json"),
        serde_json::to_vec(&vec!["kept/reference.md"]).unwrap(),
    )
    .unwrap();
    state_save(
        root,
        &DistillState {
            model: ontology.model.clone(),
            last_run: Some(123),
            last_backlogs: vec![5, 4],
            agent_turns: vec![42],
            ..Default::default()
        },
    )
    .unwrap();
    if score {
        let mut manifest = test_manifest();
        let producer = |texts: Vec<String>| Ok(texts.iter().map(|_| vec![1.0, 0.0]).collect());
        let inputs = admission::capture(root, &ontology, &DistillConfig::default()).unwrap();
        assert_eq!(
            scan_with_inputs(
                root,
                &ontology,
                &DistillConfig::default(),
                20,
                &producer,
                &[],
                &mut manifest,
                &inputs,
                true,
            )
            .unwrap()
            .full,
            1
        );
        assert_eq!(full_tier_items(root).unwrap(), vec![COVERAGE_INFLOW]);
        assert!(test_current_decision_signature(root).unwrap().is_some());
    }
    (directory, ontology)
}

fn assert_current_knowledge_withheld(root: &Path) {
    let before = anchor_snapshot(root);
    if let Ok(items) = full_tier_items(root) {
        assert!(
            items.is_empty(),
            "obsolete current wiki geometry authorized Full ingest"
        );
    }
    if let Ok(signature) = test_current_decision_signature(root) {
        assert!(
            signature.is_none(),
            "obsolete source snapshot remained authoritative"
        );
    }
    assert_eq!(anchor_snapshot(root), before);
}

#[test]
fn anchor_complete_current_source_inventory_keeps_a_valid_full_queue() {
    crate::settings::test_support::with_isolated_data("anchor-current-positive", |_data| {
        let (directory, _) = coverage_fixture(true);
        let root = directory.path();
        let before = anchor_snapshot(root);
        assert_eq!(full_tier_items(root).unwrap(), vec![COVERAGE_INFLOW]);
        assert!(test_current_decision_signature(root).unwrap().is_some());
        assert_eq!(anchor_snapshot(root), before);
    });
}

#[test]
fn anchor_unpublished_member_body_with_same_stamp_withholds_full_queue() {
    crate::settings::test_support::with_isolated_data("anchor-member-body", |_data| {
        let (directory, _) = coverage_fixture(true);
        let root = directory.path();
        let path = root.join(COVERAGE_MEMBER);
        let before = std::fs::metadata(&path).unwrap();
        let replacement = coverage_content().replace("AAAAA", "BBBBB");
        assert_eq!(replacement.len() as u64, before.len());
        std::fs::write(&path, &replacement).unwrap();
        set_mtime(&path, before.modified().unwrap());
        assert_current_knowledge_withheld(root);
    });
}

#[test]
fn anchor_unpublished_member_status_withholds_full_queue() {
    crate::settings::test_support::with_isolated_data("anchor-member-status", |_data| {
        let (directory, _) = coverage_fixture(true);
        let root = directory.path();
        let replacement = coverage_content().replace("status: active", "status: disputed");
        assert_eq!(
            crate::embeddings::chunk_page(&coverage_content()),
            crate::embeddings::chunk_page(&replacement),
            "status changes are metadata and must not require re-embedding"
        );
        std::fs::write(root.join(COVERAGE_MEMBER), replacement).unwrap();
        assert_current_knowledge_withheld(root);
    });
}

#[test]
fn anchor_same_count_same_title_path_replacement_withholds_full_queue() {
    crate::settings::test_support::with_isolated_data("anchor-member-path", |_data| {
        let (directory, _) = coverage_fixture(true);
        let root = directory.path();
        let titles = crate::commands::wiki_titles(root);
        std::fs::create_dir_all(root.join("wiki/replacement")).unwrap();
        std::fs::rename(
            root.join(COVERAGE_MEMBER),
            root.join("wiki/replacement/topic.md"),
        )
        .unwrap();
        assert_eq!(crate::commands::wiki_titles(root), titles);
        assert_current_knowledge_withheld(root);
    });
}

fn assert_unpublished_coverage_aborts_run(mutate: impl FnOnce(&Path)) {
    let (directory, ontology) = coverage_fixture(false);
    let root = directory.path();
    mutate(root);
    let before = anchor_snapshot(root);
    let calls = std::cell::Cell::new(0);
    let expected = ontology.embedding.as_ref().unwrap();
    let producer = |texts: Vec<String>| {
        calls.set(calls.get() + 1);
        Ok(EmbeddedBatch {
            space: expected.clone(),
            vectors: texts.iter().map(|_| vec![1.0, 0.0]).collect(),
        })
    };
    assert!(
        run_checked(root, &DistillConfig::default(), expected, &producer).is_err(),
        "a stale published store was rebuilt into apparently current geometry"
    );
    assert_eq!(calls.get(), 0, "source coverage must fail before inference");
    assert_eq!(anchor_snapshot(root), before);
}

#[test]
fn anchor_deleted_member_cannot_be_rebuilt_as_current_ghost_geometry() {
    crate::settings::test_support::with_isolated_data("anchor-member-deleted", |_data| {
        assert_unpublished_coverage_aborts_run(|root| {
            std::fs::remove_file(root.join(COVERAGE_MEMBER)).unwrap();
        });
    });
}

#[test]
fn anchor_new_unindexed_member_cannot_be_silently_omitted_from_geometry() {
    crate::settings::test_support::with_isolated_data("anchor-member-added", |_data| {
        assert_unpublished_coverage_aborts_run(|root| {
            std::fs::create_dir_all(root.join("wiki/unindexed")).unwrap();
            std::fs::write(root.join("wiki/unindexed/topic.md"), coverage_content()).unwrap();
        });
    });
}

#[test]
fn anchor_invalid_utf8_member_does_not_become_partial_current_inventory() {
    crate::settings::test_support::with_isolated_data("anchor-member-utf8", |_data| {
        let (directory, _) = coverage_fixture(true);
        let root = directory.path();
        std::fs::write(
            root.join(COVERAGE_MEMBER),
            b"---\ntitle: Synthetic current topic\n---\n\xff",
        )
        .unwrap();
        let before = anchor_snapshot(root);
        assert!(
            full_tier_items(root).is_err(),
            "failed wiki read became partial success"
        );
        assert_eq!(anchor_snapshot(root), before);
    });
}

#[cfg(unix)]
#[test]
fn anchor_unreadable_member_does_not_become_partial_current_inventory() {
    use std::os::unix::fs::PermissionsExt;
    crate::settings::test_support::with_isolated_data("anchor-member-read-denied", |_data| {
        let (directory, _) = coverage_fixture(true);
        let root = directory.path();
        let path = root.join(COVERAGE_MEMBER);
        let before = anchor_snapshot(root);
        let permissions = std::fs::metadata(&path).unwrap().permissions();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        let read_denied = std::fs::read(&path).is_err();
        let result = full_tier_items(root);
        std::fs::set_permissions(&path, permissions).unwrap();
        assert!(
            read_denied,
            "permission-denied witness requires an ordinary user"
        );
        assert!(
            result.is_err(),
            "unreadable member became a partial source snapshot"
        );
        assert_eq!(anchor_snapshot(root), before);
    });
}

fn assert_late_unpublished_change_aborts(replacement: String) {
    let (directory, ontology) = coverage_fixture(false);
    let root = directory.path();
    let expected = ontology.embedding.as_ref().unwrap();
    let state_before = std::fs::read(state_path(root)).unwrap();
    let inflow_before = std::fs::read(root.join(COVERAGE_INFLOW)).unwrap();
    let calls = std::cell::Cell::new(0);
    let producer = |texts: Vec<String>| {
        calls.set(calls.get() + 1);
        std::fs::write(root.join(COVERAGE_MEMBER), &replacement).unwrap();
        Ok(EmbeddedBatch {
            space: expected.clone(),
            vectors: texts.iter().map(|_| vec![1.0, 0.0]).collect(),
        })
    };
    assert!(
        run_checked(root, &DistillConfig::default(), expected, &producer).is_err(),
        "unpublished wiki change during inference authorized an obsolete score"
    );
    assert_eq!(calls.get(), 1);
    assert_eq!(std::fs::read(state_path(root)).unwrap(), state_before);
    assert_eq!(
        std::fs::read(root.join(COVERAGE_INFLOW)).unwrap(),
        inflow_before
    );
    assert_eq!(
        std::fs::read_to_string(root.join(COVERAGE_MEMBER)).unwrap(),
        replacement
    );
    assert_eq!(
        std::fs::read(root.join("raw/reference.md")).unwrap(),
        b"synthetic owner-maintained original"
    );
    assert_eq!(
        std::fs::read(root.join("kept/reference.md")).unwrap(),
        b"synthetic owner-kept note"
    );
    assert!(!root.join("_inbox/quarantine").exists());
}

#[test]
fn anchor_late_unpublished_member_body_change_cannot_publish_a_score() {
    crate::settings::test_support::with_isolated_data("anchor-member-body-late", |_data| {
        assert_late_unpublished_change_aborts(coverage_content().replace("AAAAA", "BBBBB"));
    });
}

#[test]
fn anchor_late_unpublished_member_status_change_cannot_publish_a_score() {
    crate::settings::test_support::with_isolated_data("anchor-member-status-late", |_data| {
        assert_late_unpublished_change_aborts(
            coverage_content().replace("status: active", "status: disputed"),
        );
    });
}
