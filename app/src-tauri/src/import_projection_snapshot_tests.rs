use super::*;

fn fixture() -> (InboxDoc, PreparedProjection) {
    let body = "---\nsource: claude-code\nconversation_id: snapshot\ncreated: 1791028800000\n---\n\n# Synthetic source\n\n**User:**\n\nKeep the original synthetic request.\n".to_string();
    let doc = InboxDoc {
        stem: "claude-code-snapshot".into(),
        key: "claude-code:snapshot".into(),
        fingerprint: ledger::fingerprint(&body),
        body_hash: ledger::body_hash(&body),
        body,
        original_records: String::new(),
    };
    let prepared = prepare_with_reader(&doc, None, None, |_| {
        Err("new projection must not read a previous original".into())
    })
    .unwrap();
    (doc, prepared)
}

#[test]
fn checked_original_snapshot_accepts_owned_projection_and_preserves_human_text() {
    let (doc, prepared) = fixture();
    let raw_before = doc.body.clone();
    let projection = prepared
        .body
        .replacen("---\n", "---\ncustom: Preserve this annotation\n", 1)
        .replacen("# Synthetic source", "# Human title", 1)
        + "\n## Human annotation\nKeep this exact suffix.\n";
    let projection_before = projection.clone();
    validate_existing_from_original(&doc, &projection, &prepared.raw_path, &doc.fingerprint)
        .unwrap();
    assert_eq!(doc.body, raw_before);
    assert_eq!(projection, projection_before);
    assert!(projection.contains("custom: Preserve this annotation\n"));
    assert!(projection.contains("# Human title\n"));
    assert!(projection.ends_with("Keep this exact suffix.\n"));
}

#[test]
fn checked_original_snapshot_rejects_raw_identity_and_revision_mixing() {
    let (mut doc, prepared) = fixture();
    assert!(validate_existing_from_original(
        &doc,
        &prepared.body,
        "raw/conversations/claude-code/unselected.md",
        &doc.fingerprint,
    )
    .is_err());
    assert!(validate_existing_from_original(
        &doc,
        &prepared.body,
        &prepared.raw_path,
        "different-ledger-revision",
    )
    .is_err());
    doc.body.push_str("A different original revision.\n");
    doc.fingerprint = ledger::fingerprint(&doc.body);
    assert!(validate_existing_from_original(
        &doc,
        &prepared.body,
        &prepared.raw_path,
        &doc.fingerprint,
    )
    .is_err());

    let (mut doc, prepared) = fixture();
    doc.key = "claude-code:another-session".into();
    assert!(validate_existing_from_original(
        &doc,
        &prepared.body,
        &prepared.raw_path,
        &doc.fingerprint,
    )
    .is_err());
}

#[test]
fn checked_original_snapshot_rejects_edited_transcript_or_provenance() {
    let (doc, prepared) = fixture();
    for edited in [
        prepared.body.replacen(
            "Keep the original synthetic request.",
            "A human corrected the owned request.",
            1,
        ),
        prepared
            .body
            .replacen("source: claude-code", "source: human-chosen", 1),
    ] {
        let before = edited.clone();
        assert!(validate_existing_from_original(
            &doc,
            &edited,
            &prepared.raw_path,
            &doc.fingerprint,
        )
        .is_err());
        assert_eq!(edited, before);
    }
}

#[test]
fn checked_original_snapshot_accepts_bound_legacy_and_rejects_unbound_legacy() {
    let (doc, prepared) = fixture();
    let legacy: String = prepared
        .body
        .split_inclusive('\n')
        .filter(|line| !line.starts_with(START) && !line.starts_with(END))
        .collect();
    let annotated = legacy + "\n## Human annotation\nKeep legacy notes.\n";
    validate_existing_from_original(&doc, &annotated, &prepared.raw_path, &doc.fingerprint)
        .unwrap();
    assert!(
        validate_existing_from_original(&doc, &doc.body, &prepared.raw_path, &doc.fingerprint,)
            .is_err()
    );
}

#[test]
fn checked_original_snapshot_rejects_duplicate_markers_and_source_injection() {
    let (mut doc, prepared) = fixture();
    let duplicate = format!("{}{START}duplicate -->\n", prepared.body);
    assert!(validate_existing_from_original(
        &doc,
        &duplicate,
        &prepared.raw_path,
        &doc.fingerprint,
    )
    .is_err());
    doc.body.push_str(&format!("{START}forged -->\n"));
    doc.fingerprint = ledger::fingerprint(&doc.body);
    assert!(validate_existing_from_original(
        &doc,
        &prepared.body,
        &prepared.raw_path,
        &doc.fingerprint,
    )
    .is_err());
}

#[test]
fn codex_provider_metadata_and_data_prefix_survive_immutable_publication_and_refresh() {
    let raw = crate::importers::codex::provenance_test_rollout();
    let mut plan =
        crate::importers::plan_import("synthetic.jsonl", &raw, &ledger::Ledger::default()).unwrap();
    let doc = plan.docs.remove(0);
    let prepared = prepare_with_reader(&doc, None, None, |_| {
        panic!("new source must not read history")
    })
    .unwrap();
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    wikify::append_raw(&root, &prepared.raw_path, &doc.body).unwrap();
    let actual = std::fs::read_to_string(root.join(&prepared.raw_path)).unwrap();
    assert_eq!(actual, doc.body);
    assert!(actual.contains("session_provenance"));
    assert_eq!(actual.matches("\"providerSessionProvenance\"").count(), 1);
    let human = prepared.body.clone() + "\n## Human annotation\nPreserve this exact text.\n";
    validate_existing_from_original(&doc, &human, &prepared.raw_path, &doc.fingerprint).unwrap();
    let refreshed = prepare_with_reader(&doc, Some(&human), Some(&doc.fingerprint), |_| {
        Ok(actual.clone())
    })
    .unwrap();
    assert!(refreshed.body.ends_with("Preserve this exact text.\n"));
    assert_eq!(
        refreshed
            .body
            .matches("\"providerSessionProvenance\"")
            .count(),
        1
    );
    assert_eq!(
        std::fs::read_to_string(root.join(&prepared.raw_path)).unwrap(),
        actual
    );
    assert_eq!(refreshed.raw_path, prepared.raw_path);
}
