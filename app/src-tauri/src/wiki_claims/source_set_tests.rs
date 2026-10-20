use super::*;
use crate::retrieval::Scope;
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::{ActorRole, SpanInput};

fn document(text: &str, id: &str, start: usize, end: usize) -> SourceDocument {
    SourceDocument::bind(
        "S1".into(),
        "sessions/synthetic.md".into(),
        "sessions/synthetic.md".into(),
        text,
        None,
        vec![SpanInput {
            id: id.into(),
            start,
            end,
            turn_id: "T1".into(),
            speaker: ActorRole::Assistant,
            turn_time: Some("2026-10-03T08:00:00Z".into()),
        }],
    )
    .unwrap()
}
fn set(document: SourceDocument, opening: &str) -> SourceSet {
    SourceSet::new(
        AgentVaultSession {
            vault_path: "/synthetic/vault".into(),
            opening_token: opening.into(),
        },
        Scope::Sessions,
        vec![document],
        vec![],
    )
    .unwrap()
}

#[test]
fn exact_source_merge_is_idempotent_and_keeps_selected_original_byte_proof() {
    let original = "request; later rejection";
    let first = set(document(original, "Q1", 0, 8), "17");
    let later = set(document(original, "Q2", 9, original.len()), "17");
    let merged = first.merged(&later).unwrap();
    assert_eq!(merged.spans().count(), 2);
    assert_eq!(merged.merged(&later).unwrap().spans().count(), 2);
    let survivor = merged.retained(|span| span.id() == "Q2").unwrap();
    assert_eq!(
        survivor.spans().next().unwrap(),
        later.spans().next().unwrap()
    );
}

#[test]
fn changed_source_revision_or_reused_span_id_never_overwrites_frozen_provenance() {
    let first = set(document("request; rejection", "Q1", 0, 8), "17");
    let changed = set(document("request; completion", "Q2", 9, 19), "17");
    assert!(first.merged(&changed).unwrap_err().contains("revision"));
    let reused = set(document("request; rejection", "Q1", 9, 18), "17");
    assert!(first.merged(&reused).unwrap_err().contains("span identity"));
}

#[test]
fn different_native_opening_cannot_merge_even_the_same_source_bytes() {
    let first = set(document("synthetic original", "Q1", 0, 18), "17");
    let other = set(document("synthetic original", "Q1", 0, 18), "18");
    assert!(first.merged(&other).is_err());
}

#[test]
fn original_phase_survives_windows_retention_and_merge_without_semantic_upgrade() {
    let source = document("synthetic coordination message", "Q1", 0, 30)
        .with_turn_phases(&[("T1".into(), Some("analysis".into()))])
        .unwrap();
    let original = set(source, "17");
    let windows = original
        .windowed(|span| Ok(vec![span.text()[..10].into(), span.text()[10..].into()]))
        .unwrap();
    assert!(windows
        .spans()
        .all(|span| span.source_phase() == Some("analysis")
            && span.speaker() == ActorRole::Assistant));
    assert!(windows
        .merged(&windows)
        .unwrap()
        .spans()
        .all(|span| span.source_phase() == Some("analysis")));
}

#[test]
fn compiler_packet_keeps_full_large_original_sha_and_late_byte_coordinates() {
    let original = "x".repeat(600 * 1024) + "\nLate synthetic retraction.";
    let start = 600 * 1024;
    let inputs = || {
        vec![SpanInput {
            id: "Q_tail".into(),
            start,
            end: original.len(),
            turn_id: "T_tail".into(),
            speaker: ActorRole::User,
            turn_time: None,
        }]
    };
    assert!(SourceDocument::bind(
        "S1".into(),
        "sessions/large.md".into(),
        "sessions/large.md".into(),
        &original,
        None,
        inputs()
    )
    .is_err());
    let revision = crate::importers::wikify::source_revision(&original);
    let verified = CompilationOriginal::verify(&original, &revision).unwrap();
    let document = SourceDocument::bind_compilation_packet(
        "S1".into(),
        "raw/conversations/codex/large.md".into(),
        &verified,
        &revision,
        None,
        inputs(),
    )
    .unwrap();
    let span = &document.spans[0];
    assert_eq!(span.start(), start);
    assert_eq!(span.source_revision(), revision);
    assert_eq!(span.text(), &original[start..]);
    assert_ne!(
        span.source_revision(),
        crate::importers::wikify::source_revision(span.text())
    );
    assert!(SourceDocument::bind_compilation_packet(
        "S1".into(),
        "raw/conversations/codex/large.md".into(),
        &verified,
        &"a".repeat(64),
        None,
        inputs()
    )
    .is_err());
    assert!(CompilationOriginal::verify(&original, &"a".repeat(64)).is_err());
}

#[test]
fn compiler_packet_rejects_large_selection_and_invalid_boundaries() {
    let original = "가".repeat(200 * 1024);
    let revision = crate::importers::wikify::source_revision(&original);
    let verified = CompilationOriginal::verify(&original, &revision).unwrap();
    for (start, end) in [(0, original.len()), (1, 3)] {
        assert!(SourceDocument::bind_compilation_packet(
            "S1".into(),
            "raw/conversations/codex/large.md".into(),
            &verified,
            &revision,
            None,
            vec![SpanInput {
                id: "Q1".into(),
                start,
                end,
                turn_id: "T1".into(),
                speaker: ActorRole::Unknown,
                turn_time: None
            }]
        )
        .is_err());
    }
}
