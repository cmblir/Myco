// Production-helper witnesses for current wiki metadata and exact section coverage.
// Controlled vectors are source-contract fixtures, not semantic model acceptance.

use super::*;

const SOURCE: &str = "wiki/topic.md";
const BODY: &str = "## Repeated\nSynthetic current source paragraph.\n\n## Repeated\nSynthetic current source paragraph.\n";

fn content(kind: &str, status: &str) -> String {
    format!(
        "---\ntitle: Synthetic current topic\ntype: {kind}\nstatus: {status}\ncluster: topic\n---\n\n{BODY}"
    )
}

fn write_source(root: &Path, page: &str, value: &str) {
    let path = root.join(page);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, value).unwrap();
}

fn insert_source(store: &mut VectorStore, page: &str, value: &str) {
    let stem = Path::new(page).file_stem().unwrap().to_str().unwrap();
    let entries = crate::embeddings::chunk_page(value)
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
    store.upsert_page_sections(page, stem, entries).unwrap();
}

fn labelled_store() -> VectorStore {
    let mut store = VectorStore::default();
    store.ensure_signature(
        "builtin-local:synthetic-current-encoder",
        "synthetic-current-sections-v1",
    );
    store
}

fn fixture() -> (tempfile::TempDir, VectorStore) {
    let directory = tempfile::tempdir().unwrap();
    let value = content("concept", "active");
    write_source(directory.path(), SOURCE, &value);
    let mut store = labelled_store();
    insert_source(&mut store, SOURCE, &value);
    assert_eq!(store.records.len(), 2);
    (directory, store)
}

fn assert_bad_typed_field(field: &str, replacement: &str) {
    let directory = tempfile::tempdir().unwrap();
    let value = content("map", "active");
    let original = match field {
        "type" => "type: map",
        "status" => "status: active",
        "title" => "title: Synthetic current topic",
        "cluster" => "cluster: topic",
        _ => unreachable!(),
    };
    let value = value.replace(original, replacement);
    write_source(directory.path(), SOURCE, &value);
    let path = directory.path().join(SOURCE);
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    assert!(
        read(directory.path()).is_err(),
        "present malformed {field} metadata became a missing ordinary-note default"
    );
    assert!(
        settled_map(&value).is_err(),
        "present malformed {field} metadata silently lost its map meaning"
    );
    assert_eq!(std::fs::read(&path).unwrap(), value.as_bytes());
    assert_eq!(
        std::fs::metadata(&path).unwrap().modified().unwrap(),
        modified
    );
}

#[test]
fn knowledge_nonstring_type_is_an_explicit_error() {
    assert_bad_typed_field("type", "type: [map]");
}

#[test]
fn knowledge_nonstring_status_is_an_explicit_error() {
    assert_bad_typed_field("status", "status: [disputed]");
}

#[test]
fn knowledge_nonstring_title_is_an_explicit_error() {
    assert_bad_typed_field("title", "title: [Synthetic, current, topic]");
}

#[test]
fn knowledge_nonstring_cluster_is_an_explicit_error() {
    assert_bad_typed_field("cluster", "cluster: [topic]");
}

#[test]
fn knowledge_ordinary_draft_is_eligible_and_inactive_pages_are_excluded() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let mut store = labelled_store();
    for (page, kind, status) in [
        ("wiki/draft-note.md", "concept", "draft"),
        ("wiki/disputed-note.md", "concept", "disputed"),
        ("wiki/superseded-note.md", "concept", "superseded"),
        ("wiki/maps/draft-map.md", "map", "draft"),
        ("wiki/maps/settled-map.md", "map", "active"),
    ] {
        let value = content(kind, status);
        write_source(root, page, &value);
        insert_source(&mut store, page, &value);
    }
    let snapshot = read(root).unwrap();
    assert_eq!(snapshot.pages.len(), 5);
    let selected: Vec<_> = snapshot
        .pages
        .iter()
        .filter(|page| page.eligible)
        .map(|page| page.path.as_str())
        .collect();
    assert_eq!(
        selected,
        vec!["wiki/draft-note.md", "wiki/maps/settled-map.md"]
    );
    let covered = snapshot.covered_store(&store).unwrap();
    let selected_records: BTreeSet<_> = covered
        .records
        .iter()
        .map(|record| record.page.as_str())
        .collect();
    assert_eq!(selected_records, selected.into_iter().collect());
    assert_eq!(snapshot.titles().unwrap().len(), 2);
    assert_eq!(
        store.records.len(),
        10,
        "projection must not remove search records"
    );
}

#[test]
fn knowledge_repeated_text_keeps_every_current_section_occurrence() {
    let (directory, mut store) = fixture();
    let value = content("concept", "active");
    let chunks = crate::embeddings::chunk_page(&value);
    assert_eq!(chunks.len(), 2);
    assert_eq!(chunks[0], chunks[1]);
    assert_eq!(store.records[0].hash, store.records[1].hash);
    // Record storage order is not a section omission or duplicate occurrence.
    store.records.reverse();
    let snapshot = read(directory.path()).unwrap();
    let covered = snapshot.covered_store(&store).unwrap();
    assert_eq!(covered.records.len(), 2);
    assert!(has_current_chunks(&covered, SOURCE, &value));
}

#[test]
fn knowledge_duplicate_section_ordinals_do_not_match_complete_body() {
    let (directory, mut store) = fixture();
    store.records[1].section = 0;
    store.records[1].id = format!("{SOURCE}#0");
    assert!(read(directory.path())
        .unwrap()
        .covered_store(&store)
        .is_err());
}

#[test]
fn knowledge_missing_tail_section_does_not_match_complete_body() {
    let (directory, mut store) = fixture();
    store.records.pop();
    assert!(read(directory.path())
        .unwrap()
        .covered_store(&store)
        .is_err());
}

#[test]
fn knowledge_extra_section_does_not_match_complete_body() {
    let (directory, mut store) = fixture();
    let mut extra = store.records[0].clone();
    extra.section = 2;
    extra.id = format!("{SOURCE}#2");
    store.records.push(extra);
    assert!(read(directory.path())
        .unwrap()
        .covered_store(&store)
        .is_err());
}

#[test]
fn knowledge_inactive_projection_cannot_hide_malformed_vectors() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let mut store = labelled_store();
    for (page, status) in [(SOURCE, "active"), ("wiki/disputed.md", "disputed")] {
        let value = content("concept", status);
        write_source(root, page, &value);
        insert_source(&mut store, page, &value);
    }
    let snapshot = read(root).unwrap();
    assert!(snapshot.covered_store(&store).is_ok());
    let bad = store
        .records
        .iter_mut()
        .find(|record| record.page == "wiki/disputed.md")
        .unwrap();
    bad.vector[0] = f32::NAN;
    assert!(
        snapshot.covered_store(&store).is_err(),
        "filtering inactive pages concealed malformed persisted geometry"
    );
}

#[test]
fn knowledge_complete_inventory_detects_added_deleted_and_path_replaced_sources() {
    let (directory, store) = fixture();
    let root = directory.path();
    let baseline = read(root).unwrap();
    assert!(baseline.covered_store(&store).is_ok());
    write_source(root, "wiki/additional.md", &content("concept", "active"));
    let added = read(root).unwrap();
    assert_ne!(added.signature, baseline.signature);
    assert!(added.covered_store(&store).is_err());
    std::fs::remove_file(root.join("wiki/additional.md")).unwrap();
    std::fs::create_dir_all(root.join("wiki/replacement")).unwrap();
    std::fs::rename(root.join(SOURCE), root.join("wiki/replacement/topic.md")).unwrap();
    let replaced = read(root).unwrap();
    assert_eq!(replaced.pages.len(), baseline.pages.len());
    assert_eq!(replaced.titles().unwrap(), baseline.titles().unwrap());
    assert_ne!(replaced.signature, baseline.signature);
    assert!(replaced.covered_store(&store).is_err());
    std::fs::remove_file(root.join("wiki/replacement/topic.md")).unwrap();
    let removed = read(root).unwrap();
    assert!(removed.pages.is_empty());
    assert!(removed.covered_store(&store).is_err());
}

#[cfg(unix)]
#[test]
fn knowledge_linked_markdown_and_directory_are_explicit_errors() {
    let outside = tempfile::tempdir().unwrap();
    let target = outside.path().join("synthetic-source.md");
    let original = content("concept", "active");
    std::fs::write(&target, &original).unwrap();
    for (name, destination) in [
        ("linked.md", target.as_path()),
        ("linked-directory", outside.path()),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        write_source(root, SOURCE, &content("concept", "active"));
        let path = root.join("wiki").join(name);
        std::os::unix::fs::symlink(destination, &path).unwrap();
        assert!(
            read(root).is_err(),
            "linked source/subtree became partial success"
        );
        assert!(std::fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink());
    }
    assert_eq!(std::fs::read(&target).unwrap(), original.as_bytes());
}

#[test]
fn knowledge_uses_the_publishers_hidden_target_and_node_modules_policy() {
    let (directory, store) = fixture();
    let root = directory.path();
    let baseline = read(root).unwrap();
    for page in [
        "wiki/target/generated.md",
        "wiki/node_modules/pkg/README.md",
        "wiki/.cache/hidden.md",
    ] {
        write_source(root, page, &content("concept", "active"));
    }
    let snapshot = read(root).unwrap();
    let paths: Vec<_> = snapshot
        .pages
        .iter()
        .map(|page| page.path.as_str())
        .collect();
    assert_eq!(
        paths,
        vec![SOURCE],
        "organization scanned sources the publisher skips"
    );
    assert_eq!(snapshot.signature, baseline.signature);
    assert!(snapshot.covered_store(&store).is_ok());
}

#[cfg(unix)]
#[test]
fn knowledge_nonmarkdown_attachment_link_preserves_index_scan_compatibility() {
    let (directory, store) = fixture();
    let root = directory.path();
    let baseline = read(root).unwrap();
    let outside = tempfile::tempdir().unwrap();
    let target = outside.path().join("synthetic-image.png");
    let bytes = b"synthetic attachment bytes, never wiki evidence";
    std::fs::write(&target, bytes).unwrap();
    let link = root.join("wiki/attachment.png");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let snapshot = read(root).unwrap();
    assert_eq!(snapshot.pages.len(), 1);
    assert_eq!(snapshot.signature, baseline.signature);
    assert!(snapshot.covered_store(&store).is_ok());
    assert!(std::fs::symlink_metadata(link)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(std::fs::read(target).unwrap(), bytes);
}

#[test]
fn knowledge_status_gate_count_matches_the_actual_eligible_wiki_inventory() {
    crate::settings::test_support::with_isolated_data("knowledge-status-eligible-count", |_data| {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let mut store = labelled_store();
        let eligible_count = super::super::GATE_MIN_WIKI_PAGES - 1;
        for index in 0..eligible_count {
            let page = format!("wiki/draft-note-{index:02}.md");
            let value = content("concept", "draft");
            write_source(root, &page, &value);
            insert_source(&mut store, &page, &value);
        }
        for (page, kind, status) in [
            ("wiki/disputed.md", "concept", "disputed"),
            ("wiki/superseded.md", "concept", "superseded"),
            ("wiki/maps/draft.md", "map", "draft"),
        ] {
            let value = content(kind, status);
            write_source(root, page, &value);
            insert_source(&mut store, page, &value);
        }
        let snapshot = read(root).unwrap();
        let covered = snapshot.covered_store(&store).unwrap();
        let titles = snapshot.titles().unwrap();
        assert_eq!(snapshot.pages.len(), eligible_count + 3);
        assert_eq!(titles.len(), eligible_count);
        let index_path =
            VectorStore::path_for(&root.canonicalize().unwrap().to_string_lossy()).unwrap();
        store.save(&index_path).unwrap();
        crate::ontology::save(
            root,
            &crate::ontology::build(&covered, &titles, &[]).unwrap(),
        )
        .unwrap();
        let status = super::super::status(root);
        assert_eq!(
            status.wiki_pages, eligible_count,
            "status count disagrees with run gate"
        );
        assert!(
            !status.gate_active,
            "inactive pages falsely opened the cold-start gate"
        );
        assert_eq!(store.indexed_pages(), eligible_count + 3);
    });
}
