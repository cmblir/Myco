use super::*;
use crate::local_synthesis::{prepare, Evidence};

fn prompt() -> Prompt {
    prepare(
        "Synthetic question?",
        None,
        "en",
        &[Evidence {
            page: "sessions/review.md".into(),
            stem: "Synthetic source".into(),
            section: 0,
            text: "Synthetic product S10 has an unknown outcome.".into(),
            title: None,
            compiled: None,
        }],
        |_, _| Ok(true),
    )
    .unwrap()
}
#[test]
fn frozen_draft_preserves_canonical_mapping_and_removes_model_labels_from_review_prose() {
    let mut prompt = prompt();
    let raw = r#"{"answer":"Check [[S1|FAKE_COMPLETION]] and the product S10.","sources":["S1"]}"#;
    let draft = validate_answer_draft(raw, &prompt, "en").unwrap();
    let payload = draft.review_payload();
    assert!(!payload["proseWithoutModelLinkLabels"]
        .as_str()
        .unwrap()
        .contains("FAKE_COMPLETION"));
    assert!(payload["modelAnswer"]
        .as_str()
        .unwrap()
        .contains("FAKE_COMPLETION"));
    assert!(draft.binds_prompt(&prompt, "en"));
    prompt.evidence[0].stem = "Changed title".into();
    assert!(!draft.binds_prompt(&prompt, "en"));
    let (rendered, paths) = draft.into_rendered();
    assert_eq!(rendered,"Check [[sessions/review|Synthetic source]] and the product S10.\n\n[[sessions/review|Synthetic source]]");
    assert_eq!(paths, vec!["sessions/review.md"]);
}
#[test]
fn draft_preserves_existing_eof_language_echo_and_namespace_rejections() {
    let prompt = prompt();
    for raw in ["", r#"{"answer":"Incomplete"#] {
        assert_eq!(
            validate_answer_draft(raw, &prompt, "en").unwrap_err(),
            INCOMPLETE_ANSWER
        );
    }
    for answer in [
        "[[S1|Model words]]",
        "Synthetic question? [[S1|Fake extra words]]",
        "Check [[S9]].",
        "Check ![[S1]].",
        "Check [[S1|label|extra]].",
    ] {
        let raw = json!({"answer":answer,"sources":["S1"]}).to_string();
        assert!(
            validate_answer_draft(&raw, &prompt, "en").is_err(),
            "{answer}"
        );
    }
}
#[test]
fn wrapper_and_draft_rendering_remain_identical_for_declared_ids_and_literal_identifiers() {
    let prompt = prompt();
    for answer in [
        "Check S1 and S10.",
        "Check [S1] and AS1.",
        "Check [[S1|Untrusted label]].",
    ] {
        let raw = json!({"answer":answer,"sources":["S1"]}).to_string();
        assert_eq!(
            crate::local_synthesis::validate_answer(&raw, &prompt, "en").unwrap(),
            validate_answer_draft(&raw, &prompt, "en")
                .unwrap()
                .into_rendered()
        );
    }
    let first = validate_answer_draft(
        r#"{"answer":"Check the source.","sources":["S1"]}"#,
        &prompt,
        "en",
    )
    .unwrap();
    let changed = validate_answer_draft(
        r#"{"answer":"Check the original source.","sources":["S1"]}"#,
        &prompt,
        "en",
    )
    .unwrap();
    assert_ne!(first.revision().unwrap(), changed.revision().unwrap());
    assert_ne!(first.input_revision(), changed.input_revision());
}
