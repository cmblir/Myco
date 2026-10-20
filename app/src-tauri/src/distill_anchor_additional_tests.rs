// Additional witnesses for the checked runner's below-gate map boundary.
// Controlled vectors prove input authority, not embedding-model quality.

use super::*;

const BELOW_GATE_MEMBER: &str = "wiki/topic-00.md";
const BELOW_GATE_INFLOW: &str = "_inbox/held.md";
const BELOW_GATE_KEPT: &str = "kept/reference.md";
const BELOW_GATE_RAW: &str = "raw/reference.md";

fn below_gate_content() -> String {
    format!(
        "---\ntitle: Synthetic below-gate topic\ntype: concept\nstatus: active\nconfidence: medium\ncreated: 2026-01-01\n---\n\n{PROSE} AAAAA\n"
    )
}

fn below_gate_fixture() -> (tempfile::TempDir, Ontology) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    std::fs::create_dir_all(root.join("wiki")).unwrap();
    let mut store = crate::vector_index::VectorStore::default();
    store.ensure_signature(
        "builtin-local:synthetic-below-gate-encoder",
        "synthetic-below-gate-chunk-policy-v1",
    );
    let page_count = MAP_MIN_MEMBERS + 2;
    assert!(page_count < GATE_MIN_WIKI_PAGES);
    let content = below_gate_content();
    for index in 0..page_count {
        let relative = format!("wiki/topic-{index:02}.md");
        let path = root.join(&relative);
        std::fs::write(&path, &content).unwrap();
        set_mtime(&path, map_mature_mtime());
        let entries = crate::embeddings::chunk_page(&content)
            .iter()
            .enumerate()
            .map(|(section, chunk)| {
                (
                    section,
                    crate::embeddings::content_hash(chunk),
                    vec![1.0, 0.0],
                )
            })
            .collect();
        store
            .upsert_page_sections(&relative, &format!("topic-{index:02}"), entries)
            .unwrap();
    }
    let snapshot = knowledge::read(root).unwrap();
    let covered = snapshot.covered_store(&store).unwrap();
    let titles = snapshot.titles().unwrap();
    assert_eq!(titles.len(), page_count);
    let ontology = crate::ontology::build(&covered, &titles, &[]).unwrap();
    assert_eq!(ontology.wiki_pages, page_count);
    assert_eq!(ontology.clusters.len(), 1);
    assert_eq!(ontology.clusters[0].members.len(), page_count);
    assert!(ontology.clusters[0]
        .members
        .iter()
        .all(|member| member_is_mature(root, member, now_secs())));
    let index_path =
        crate::vector_index::VectorStore::path_for(&root.canonicalize().unwrap().to_string_lossy())
            .unwrap();
    store.save(&index_path).unwrap();
    crate::ontology::save(root, &ontology).unwrap();
    config_save(root, &DistillConfig::default()).unwrap();
    std::fs::write(root.join("profile.md"), "## Interests\n- synthetic topic\n").unwrap();
    for (relative, body) in [
        (BELOW_GATE_INFLOW, PROSE),
        (BELOW_GATE_KEPT, "synthetic owner-kept reference"),
        (BELOW_GATE_RAW, "synthetic owner-maintained original"),
    ] {
        let path = root.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, body).unwrap();
        set_mtime(&path, old_mtime());
    }
    std::fs::write(
        dir(root).join("distill-kept.json"),
        serde_json::to_vec(&vec![BELOW_GATE_KEPT]).unwrap(),
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
    assert!(test_current_decision_signature(root).unwrap().is_some());
    (directory, ontology)
}

fn assert_below_gate_owned_inputs(root: &Path, state_before: &[u8], kept_before: &[u8]) {
    assert_eq!(std::fs::read(state_path(root)).unwrap(), state_before);
    assert_eq!(
        std::fs::read(dir(root).join("distill-kept.json")).unwrap(),
        kept_before
    );
    assert_eq!(
        std::fs::read(root.join(BELOW_GATE_INFLOW)).unwrap(),
        PROSE.as_bytes()
    );
    assert_eq!(
        std::fs::read(root.join(BELOW_GATE_KEPT)).unwrap(),
        b"synthetic owner-kept reference"
    );
    assert_eq!(
        std::fs::read(root.join(BELOW_GATE_RAW)).unwrap(),
        b"synthetic owner-maintained original"
    );
    assert!(!root.join("_inbox/quarantine").exists());
}

fn assert_below_gate_change_aborts(mutate: impl Fn(&Path)) {
    let (directory, ontology) = below_gate_fixture();
    let root = directory.path();
    let state_before = std::fs::read(state_path(root)).unwrap();
    let kept_before = std::fs::read(dir(root).join("distill-kept.json")).unwrap();
    let expected = ontology.embedding.as_ref().unwrap();
    let calls = std::cell::Cell::new(0);
    let sources_after_edit = std::cell::RefCell::new(None);
    let index_after_edit = std::cell::RefCell::new(None);
    let index_path =
        crate::vector_index::VectorStore::path_for(&root.canonicalize().unwrap().to_string_lossy())
            .unwrap();
    let producer = |texts: Vec<String>| {
        calls.set(calls.get() + 1);
        assert_eq!(texts, vec!["synthetic topic".to_string()]);
        mutate(root);
        let sources: std::collections::BTreeMap<_, _> = knowledge::read(root)
            .unwrap()
            .pages
            .into_iter()
            .map(|page| (page.path, page.content))
            .collect();
        *sources_after_edit.borrow_mut() = Some(sources);
        *index_after_edit.borrow_mut() = Some(std::fs::read(&index_path).unwrap());
        Ok(EmbeddedBatch {
            space: expected.clone(),
            vectors: vec![vec![1.0, 0.0]],
        })
    };
    assert!(
        run_checked(root, &DistillConfig::default(), expected, &producer).is_err(),
        "below-gate profile inference changed authority but published an old map decision"
    );
    assert_eq!(
        calls.get(),
        1,
        "this witness must reach the profile producer"
    );
    assert_eq!(
        awaiting_resolution_count(root),
        0,
        "an obsolete map proposal was written"
    );
    assert_below_gate_owned_inputs(root, &state_before, &kept_before);
    let sources_now: std::collections::BTreeMap<_, _> = knowledge::read(root)
        .unwrap()
        .pages
        .into_iter()
        .map(|page| (page.path, page.content))
        .collect();
    assert_eq!(
        sources_now,
        sources_after_edit.into_inner().unwrap(),
        "the caller's edited sources must remain intact"
    );
    assert_eq!(
        std::fs::read(index_path).unwrap(),
        index_after_edit.into_inner().unwrap(),
        "the producer's published store edit must remain intact"
    );
    // A run/cache manifest can already exist. These controls do not assert
    // whole-job rollback or atomic compare-and-swap of publication inputs.
}

#[test]
fn anchor_below_gate_profile_body_change_cannot_publish_a_map_proposal() {
    crate::settings::test_support::with_isolated_data("anchor-below-gate-body", |_data| {
        assert_below_gate_change_aborts(|root| {
            let path = root.join(BELOW_GATE_MEMBER);
            let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
            let changed = below_gate_content().replace("AAAAA", "BBBBB");
            assert_eq!(changed.len(), below_gate_content().len());
            std::fs::write(&path, changed).unwrap();
            set_mtime(&path, modified);
        });
    });
}

#[test]
fn anchor_below_gate_profile_status_change_cannot_publish_a_map_proposal() {
    crate::settings::test_support::with_isolated_data("anchor-below-gate-status", |_data| {
        assert_below_gate_change_aborts(|root| {
            let path = root.join(BELOW_GATE_MEMBER);
            let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
            let changed = below_gate_content().replace("status: active", "status: disputed");
            assert_eq!(
                crate::embeddings::chunk_page(&changed),
                crate::embeddings::chunk_page(&below_gate_content()),
                "the witness changes eligible metadata without changing indexed body chunks"
            );
            std::fs::write(&path, changed).unwrap();
            set_mtime(&path, modified);
        });
    });
}

#[test]
fn anchor_below_gate_profile_published_store_change_cannot_publish_a_map_proposal() {
    crate::settings::test_support::with_isolated_data("anchor-below-gate-store", |_data| {
        assert_below_gate_change_aborts(|root| {
            let mut store = current_store(root).unwrap();
            let record = store
                .records
                .iter_mut()
                .find(|record| record.page == BELOW_GATE_MEMBER)
                .unwrap();
            record.vector = vec![0.0, 1.0];
            store.validate_geometry().unwrap();
            let path = crate::vector_index::VectorStore::path_for(
                &root.canonicalize().unwrap().to_string_lossy(),
            )
            .unwrap();
            store.save(&path).unwrap();
        });
    });
}

#[test]
fn anchor_below_gate_unchanged_profile_keeps_one_real_map_proposal() {
    crate::settings::test_support::with_isolated_data("anchor-below-gate-positive", |_data| {
        let (directory, ontology) = below_gate_fixture();
        let root = directory.path();
        let expected = ontology.embedding.as_ref().unwrap();
        let calls = std::cell::Cell::new(0);
        let producer = |texts: Vec<String>| {
            calls.set(calls.get() + 1);
            assert_eq!(texts, vec!["synthetic topic".to_string()]);
            Ok(EmbeddedBatch {
                space: expected.clone(),
                vectors: vec![vec![1.0, 0.0]],
            })
        };
        let report = run_checked(root, &DistillConfig::default(), expected, &producer).unwrap();
        assert_eq!(calls.get(), 1);
        assert_eq!(report.scan.gate_wiki_pages, Some(MAP_MIN_MEMBERS + 2));
        assert_eq!(report.scan.scored, 0);
        assert_eq!(report.proposals, 1);
        assert_eq!(awaiting_resolution_count(root), 1);
        let manifest = run_detail(root, &report.id).unwrap();
        let proposals: Vec<_> = manifest
            .created
            .iter()
            .filter(|path| path.starts_with("work/feedback/"))
            .collect();
        assert_eq!(proposals.len(), 1);
        let content = std::fs::read_to_string(root.join(proposals[0])).unwrap();
        let metadata = proposal_frontmatter(&content).unwrap();
        assert!(
            matches!(metadata.get("action"), Some(gray_matter::Pod::String(action)) if action == "draft-map")
        );
        assert_eq!(
            proposal_payload_members(&metadata).len(),
            MAP_MIN_MEMBERS + 2
        );
        assert_eq!(
            std::fs::read(root.join(BELOW_GATE_INFLOW)).unwrap(),
            PROSE.as_bytes()
        );
        assert_eq!(
            std::fs::read(root.join(BELOW_GATE_RAW)).unwrap(),
            b"synthetic owner-maintained original"
        );
        assert_eq!(
            std::fs::read(root.join(BELOW_GATE_KEPT)).unwrap(),
            b"synthetic owner-kept reference"
        );
    });
}
