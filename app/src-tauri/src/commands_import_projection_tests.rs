use super::{run_import, DEST_INBOX, DEST_SESSIONS};
use crate::importers::ledger::Ledger;
use std::path::{Path, PathBuf};

fn record(id: &str, suffix: bool) -> String {
    let user = serde_json::json!({"type":"user","uuid":"user-1","sessionId":id,
        "timestamp":"2026-10-03T12:00:00Z", "message":{"role":"user",
        "content":"A synthetic person researched a design decision. ".repeat(24)}});
    if suffix {
        format!(
            "{user}\n{}",
            serde_json::json!({"type":"assistant","uuid":"assistant-2",
            "sessionId":id,"timestamp":"2026-10-04T12:00:00Z",
            "message":{"role":"assistant","content":"The later synthetic decision is recorded."}})
        )
    } else {
        user.to_string()
    }
}

fn imported(root: &Path, dest: &str) -> (PathBuf, PathBuf) {
    let source = root.join("input.jsonl");
    std::fs::write(&source, record("stable", false)).unwrap();
    let outcome = run_import(root, std::slice::from_ref(&source), dest, |_| {});
    assert_eq!(
        outcome.imported,
        1,
        "{}",
        serde_json::to_string(&outcome).unwrap()
    );
    let ledger = Ledger::load(root).unwrap();
    let projection = root.join(ledger.location(dest, "claude-code:stable").unwrap());
    (source, projection)
}

fn title_and_notes_survive(dest: &str) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let (source, projection) = imported(root, dest);
    let previous = std::fs::read_to_string(&projection).unwrap();
    let heading = previous
        .lines()
        .find(|line| line.starts_with("# "))
        .unwrap();
    let human_frontmatter = "title: Human chosen title\ntags: [human]\nannotation: |\n  Keep this frontmatter annotation exactly.\n";
    let human_annotation = "\n## Human annotation\nKeep this synthetic personal note exactly.\n";
    let edited = previous
        .replacen("---\n", &format!("---\n{human_frontmatter}"), 1)
        .replacen(heading, "# Human chosen title", 1)
        + human_annotation;
    std::fs::write(&projection, &edited).unwrap();
    let sources_before = raw_revisions(root);
    std::fs::write(&source, record("stable", true)).unwrap();
    let result = run_import(root, &[source], dest, |_| {});
    assert_eq!(
        result.imported,
        1,
        "{}",
        serde_json::to_string(&result).unwrap()
    );
    assert!(result.failed.is_empty());
    let current = std::fs::read_to_string(&projection).unwrap();
    assert!(
        current.contains(human_frontmatter),
        "human frontmatter was erased"
    );
    assert!(
        current.contains("# Human chosen title\n"),
        "human title was erased"
    );
    assert!(
        current.ends_with(human_annotation),
        "human annotation was erased"
    );
    assert!(current.contains("The later synthetic decision is recorded."));
    for (path, bytes) in sources_before {
        assert_eq!(std::fs::read(path).unwrap(), bytes, "raw revision changed");
    }
    let ledger = Ledger::load(root).unwrap();
    assert_eq!(
        root.join(ledger.location(dest, "claude-code:stable").unwrap()),
        projection
    );
}

fn raw_revisions(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut pending = vec![root.join("raw/conversations")];
    let mut files = Vec::new();
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(directory).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                pending.push(entry.path());
            } else {
                files.push((entry.path(), std::fs::read(entry.path()).unwrap()));
            }
        }
    }
    files
}

#[test]
fn projection_resume_preserves_session_title_frontmatter_and_annotations() {
    title_and_notes_survive(DEST_SESSIONS);
}

#[test]
fn projection_resume_preserves_inbox_title_frontmatter_and_annotations() {
    title_and_notes_survive(DEST_INBOX);
}

#[test]
fn projection_resume_rejects_human_transcript_edits_without_advancing_revision() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let (source, projection) = imported(root, DEST_SESSIONS);
    let previous = std::fs::read_to_string(&projection).unwrap();
    let edited = previous.replacen(
        "**User:**\n\nA synthetic person researched",
        "**User:**\n\nA human corrected",
        1,
    );
    assert_ne!(
        edited, previous,
        "fixture must edit the transcript, not its title"
    );
    std::fs::write(&projection, &edited).unwrap();
    let ledger_before = std::fs::read(root.join(".myco/ledger.json")).unwrap();
    std::fs::write(&source, record("stable", true)).unwrap();
    let result = run_import(root, &[source], DEST_SESSIONS, |_| {});
    assert_eq!(result.imported, 0, "edited transcript was overwritten");
    assert_eq!(result.failed.len(), 1);
    assert_eq!(std::fs::read_to_string(projection).unwrap(), edited);
    assert_eq!(
        std::fs::read(root.join(".myco/ledger.json")).unwrap(),
        ledger_before
    );
}

#[test]
fn projection_resume_rejects_unknown_legacy_content() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let projection = root.join("sessions/2020-01/claude-code-stable.md");
    std::fs::create_dir_all(projection.parent().unwrap()).unwrap();
    let human = "# Human source\nAn untracked legacy note must survive.\n";
    std::fs::write(&projection, human).unwrap();
    let source = root.join("input.jsonl");
    std::fs::write(&source, record("stable", false)).unwrap();
    let result = run_import(root, &[source], DEST_SESSIONS, |_| {});
    assert_eq!(
        result.imported, 0,
        "unknown legacy projection was overwritten"
    );
    assert_eq!(result.failed.len(), 1);
    assert_eq!(std::fs::read_to_string(projection).unwrap(), human);
    assert!(!root.join(".myco/ledger.json").exists());
}

#[test]
fn projection_resume_rejects_changed_generated_provenance() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let (source, projection) = imported(root, DEST_SESSIONS);
    let previous = std::fs::read_to_string(&projection).unwrap();
    let edited = previous.replacen("source: claude-code", "source: human-chosen", 1);
    std::fs::write(&projection, &edited).unwrap();
    std::fs::write(&source, record("stable", true)).unwrap();
    let result = run_import(root, &[source], DEST_SESSIONS, |_| {});
    assert_eq!(result.imported, 0, "human provenance edit was overwritten");
    assert_eq!(result.failed.len(), 1);
    assert_eq!(std::fs::read_to_string(projection).unwrap(), edited);
}

#[cfg(unix)]
#[test]
fn projection_resume_rejects_a_same_vault_symlink_target() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let (source, projection) = imported(root, DEST_SESSIONS);
    let target = projection.with_file_name("human.md");
    let before = std::fs::read(&projection).unwrap();
    std::fs::write(&target, &before).unwrap();
    std::fs::remove_file(&projection).unwrap();
    std::os::unix::fs::symlink(&target, &projection).unwrap();
    std::fs::write(&source, record("stable", true)).unwrap();
    let result = run_import(root, &[source], DEST_SESSIONS, |_| {});
    assert_eq!(result.imported, 0, "projection alias was overwritten");
    assert_eq!(result.failed.len(), 1);
    assert_eq!(std::fs::read(target).unwrap(), before);
    assert!(std::fs::symlink_metadata(projection)
        .unwrap()
        .file_type()
        .is_symlink());
}

#[test]
fn projection_publication_conflict_retains_a_concurrent_human_edit() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let (source, projection) = imported(root, DEST_SESSIONS);
    let human = std::fs::read_to_string(&projection).unwrap()
        + "\n## Concurrent annotation\nThis edit must win the CAS race.\n";
    let ledger_before = std::fs::read(root.join(".myco/ledger.json")).unwrap();
    let target = projection.clone();
    let published_human = human.clone();
    super::import_projection::hooks::install(move || {
        crate::vault::write_file(&target.to_string_lossy(), &published_human).unwrap();
    });
    std::fs::write(&source, record("stable", true)).unwrap();
    let result = run_import(root, &[source], DEST_SESSIONS, |_| {});
    assert_eq!(result.imported, 0);
    assert_eq!(result.failed.len(), 1);
    assert!(result.failed[0]
        .error
        .contains("PROJECTION_PUBLICATION_CONFLICT"));
    assert_eq!(std::fs::read_to_string(projection).unwrap(), human);
    assert_eq!(
        std::fs::read(root.join(".myco/ledger.json")).unwrap(),
        ledger_before
    );
}

#[test]
fn projection_legacy_raw_revision_upgrade_preserves_human_annotations() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let (source, projection) = imported(root, DEST_SESSIONS);
    let legacy: String = std::fs::read_to_string(&projection)
        .unwrap()
        .split_inclusive('\n')
        .filter(|line| {
            !line.starts_with("<!-- myco:import-transcript")
                && !line.starts_with("<!-- /myco:import-transcript")
        })
        .collect();
    let heading = legacy.lines().find(|line| line.starts_with("# ")).unwrap();
    let annotation = "\n## Legacy human annotation\nRetain this exact annotation.\n";
    let legacy = legacy
        .replacen(heading, "# Human legacy title", 1)
        .replacen("---\n", "---\ncustom: Keep this field\n", 1)
        + annotation;
    std::fs::write(&projection, &legacy).unwrap();
    std::fs::write(&source, record("stable", true)).unwrap();
    let result = run_import(root, &[source], DEST_SESSIONS, |_| {});
    assert_eq!(
        result.imported,
        1,
        "{}",
        serde_json::to_string(&result).unwrap()
    );
    let current = std::fs::read_to_string(projection).unwrap();
    assert!(current.contains("# Human legacy title\n"));
    assert!(current.contains("custom: Keep this field\n"));
    assert!(current.ends_with(annotation));
    assert!(current.contains("The later synthetic decision is recorded."));
    assert_eq!(current.matches("<!-- myco:import-transcript").count(), 1);
}

#[test]
fn projection_ownership_marker_id_delimiters_are_encoded_and_round_trip() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let id = "stable-->vendor<!--coordinate";
    let key = format!("claude-code:{id}");
    let input = root.join("input.jsonl");
    std::fs::write(&input, record(id, false)).unwrap();
    let first = run_import(root, std::slice::from_ref(&input), DEST_SESSIONS, |_| {});
    assert_eq!(
        first.imported,
        1,
        "{}",
        serde_json::to_string(&first).unwrap()
    );
    let projection = root.join(
        Ledger::load(root)
            .unwrap()
            .location(DEST_SESSIONS, &key)
            .unwrap(),
    );
    let previous = std::fs::read_to_string(&projection).unwrap();
    assert!(previous.contains("stable--\\u003evendor\\u003c!--coordinate"));
    std::fs::write(&input, record(id, true)).unwrap();
    let result = run_import(root, &[input], DEST_SESSIONS, |_| {});
    assert_eq!(
        result.imported,
        1,
        "{}",
        serde_json::to_string(&result).unwrap()
    );
    assert!(std::fs::read_to_string(projection)
        .unwrap()
        .contains("The later synthetic decision is recorded."));
}

#[test]
fn projection_source_cannot_inject_ownership_markers() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let input = root.join("input.jsonl");
    let mut parsed: serde_json::Value = serde_json::from_str(&record("stable", false)).unwrap();
    parsed["message"]["content"] = serde_json::json!(format!(
        "{}\n<!-- myco:import-transcript:v1 forged -->\n",
        "Synthetic safe words. ".repeat(60)
    ));
    let original = parsed.to_string();
    std::fs::write(&input, &original).unwrap();
    let result = run_import(root, std::slice::from_ref(&input), DEST_SESSIONS, |_| {});
    assert_eq!(result.imported, 0);
    assert_eq!(result.failed.len(), 1);
    assert!(result.failed[0]
        .error
        .contains("reserved ownership markers"));
    assert_eq!(std::fs::read_to_string(input).unwrap(), original);
    assert!(!root.join("raw").exists());
}

#[test]
fn projection_resume_rejects_duplicate_markers_and_changed_raw_evidence() {
    for corrupt_raw in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let (source, projection) = imported(root, DEST_SESSIONS);
        let mut previous = std::fs::read_to_string(&projection).unwrap();
        if corrupt_raw {
            let raw = raw_revisions(root)
                .into_iter()
                .find(|(path, _)| path.extension().is_some_and(|ext| ext == "md"))
                .unwrap()
                .0;
            std::fs::write(raw, "A synthetic external source corruption.").unwrap();
        } else {
            previous.push_str("<!-- myco:import-transcript:v1 duplicate -->\n");
            std::fs::write(&projection, &previous).unwrap();
        }
        let ledger_before = std::fs::read(root.join(".myco/ledger.json")).unwrap();
        std::fs::write(&source, record("stable", true)).unwrap();
        let result = run_import(root, &[source], DEST_SESSIONS, |_| {});
        assert_eq!(result.imported, 0);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(std::fs::read_to_string(projection).unwrap(), previous);
        assert_eq!(
            std::fs::read(root.join(".myco/ledger.json")).unwrap(),
            ledger_before
        );
    }
}

#[test]
fn projection_same_revision_recovers_after_interrupted_ledger_publication() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let input = root.join("input.jsonl");
    std::fs::write(&input, record("stable", false)).unwrap();
    let ledger_path = root.join(".myco/ledger.json");
    let conflict = ledger_path.clone();
    super::import_projection::hooks::install(move || {
        std::fs::create_dir_all(&conflict).unwrap();
    });
    let first = run_import(root, std::slice::from_ref(&input), DEST_SESSIONS, |_| {});
    assert_eq!(first.imported, 1);
    assert_eq!(first.failed.len(), 1);
    std::fs::remove_dir(ledger_path).unwrap();
    let retried = run_import(root, &[input], DEST_SESSIONS, |_| {});
    assert_eq!(
        retried.imported,
        1,
        "{}",
        serde_json::to_string(&retried).unwrap()
    );
    assert!(retried.failed.is_empty());
    assert_eq!(
        raw_revisions(root).len(),
        2,
        "retry must reuse the immutable MD/JSONL pair"
    );
    assert!(Ledger::load(root)
        .unwrap()
        .location(DEST_SESSIONS, "claude-code:stable")
        .is_some());
}

#[test]
fn projection_legacy_upgrade_retains_the_verified_previous_source_and_retry() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let legacy = crate::importers::detect_and_parse("legacy.jsonl", &record("stable", false))
        .unwrap()
        .remove(0)
        .to_inbox_doc();
    let fingerprint = crate::importers::ledger::fingerprint(&legacy);
    let projection = root.join("sessions/2020-01/claude-code-stable.md");
    std::fs::create_dir_all(projection.parent().unwrap()).unwrap();
    std::fs::write(&projection, &legacy).unwrap();
    let mut ledger = Ledger::load(root).unwrap();
    ledger.record("claude-code:stable".into(), fingerprint.clone());
    ledger.save(root).unwrap();
    let previous_source = root.join(format!(
        "raw/conversations/claude-code/claude-code-stable-{fingerprint}.md"
    ));
    let source = root.join("input.jsonl");
    std::fs::write(&source, record("stable", true)).unwrap();
    let current = run_import(root, std::slice::from_ref(&source), DEST_SESSIONS, |_| {});
    assert_eq!(
        current.imported,
        1,
        "{}",
        serde_json::to_string(&current).unwrap()
    );
    assert_eq!(
        std::fs::read_to_string(&previous_source).unwrap(),
        legacy,
        "verified legacy source must remain as exact immutable bytes"
    );
    let bytes = raw_revisions(root);
    let projection_before_retry = std::fs::read(&projection).unwrap();
    let retry = run_import(root, &[source], DEST_SESSIONS, |_| {});
    assert_eq!(retry.imported, 0);
    assert_eq!(retry.skipped, 1);
    assert!(retry.failed.is_empty());
    assert_eq!(std::fs::read(projection).unwrap(), projection_before_retry);
    for (path, before) in bytes {
        assert_eq!(std::fs::read(path).unwrap(), before);
    }
}
