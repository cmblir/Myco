//! Exact model content projection with full native proofs retained privately.

use super::*;

#[test]
fn model_span_fields_are_exact_and_full_proofs_and_review_hashes_remain_private() {
    let fixture = fixture();
    let captured = capture(&fixture, &[0, 1, 2, 3, 4, 5, 6, 7]);
    let payload = captured.model_payload().unwrap();
    let originals = captured.model_original_spans().unwrap();
    assert_eq!(originals.len(), captured.original_closure.len());
    for (model, native) in originals.iter().zip(&captured.original_closure) {
        let full = serde_json::to_value(native).unwrap();
        assert_eq!(model.as_object().unwrap().len(), 7);
        for field in MODEL_SPAN_FIELDS {
            assert_eq!(model[field], full[field], "{field}");
            assert_eq!(
                model[field].to_string().as_bytes(),
                full[field].to_string().as_bytes()
            );
        }
        for field in PROOF_SPAN_FIELDS {
            assert!(full.get(field).is_some());
            assert!(model.get(field).is_none());
        }
        let grouped = payload["sources"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|source| source["originalSpans"].as_array().unwrap())
            .find(|span| span["id"] == model["id"])
            .unwrap();
        assert_eq!(grouped, model);
    }
    assert_eq!(
        captured.base_payload["sources"][0]["originalSpans"][0]["sourceRevision"]
            .as_str()
            .unwrap()
            .len(),
        64
    );
    assert_eq!(
        captured.base_payload["sources"][0]["originalSpans"][0]["start"],
        "선행 원문\n".len()
    );
    assert_eq!(
        captured.base_payload["automatedClaimReviewInputRevisions"],
        json!(["11".repeat(32), "22".repeat(32)])
    );
    let mut private_change = captured.clone();
    private_change.base_payload["automatedClaimReviewInputRevisions"][0] = json!("33".repeat(32));
    assert!(private_change.model_payload().is_err());
    assert!(private_change.model_original_spans().is_err());
    let mut old_full_layout = payload.clone();
    old_full_layout["sources"] = captured.base_payload["sources"].clone();
    old_full_layout["automatedClaimReviewInputRevisions"] =
        captured.base_payload["automatedClaimReviewInputRevisions"].clone();
    // This compares serialized bytes only, not real tokens or runtime fit.
    assert!(payload.to_string().len() < old_full_layout.to_string().len());
}

#[test]
fn projected_unknown_speaker_null_times_phase_and_preamble_bytes_are_preserved() {
    let mut fixture = fixture();
    let text = "  Preamble without a known speaker; date 2026-10-02.\n";
    let preamble = SourceDocument::bind(
        "S-PREAMBLE".into(),
        "wiki/preamble.md".into(),
        "wiki/preamble.md".into(),
        text,
        None,
        vec![SpanInput {
            id: "Q-PREAMBLE".into(),
            start: 0,
            end: text.len(),
            turn_id: "T-preamble".into(),
            speaker: ActorRole::Unknown,
            turn_time: None,
        }],
    )
    .unwrap();
    let mut documents = fixture.packet.documents().to_vec();
    documents.push(preamble);
    fixture.packet = SourceSet::new(origin(), Scope::All, documents, vec![]).unwrap();
    let captured = capture(&fixture, &[0, 1]);
    let global = captured.model_original_spans().unwrap();
    let preamble = global.last().unwrap();
    assert_eq!(preamble["id"], "Q-PREAMBLE");
    assert_eq!(preamble["speaker"], "unknown");
    assert_eq!(preamble["turnId"], "T-preamble");
    assert_eq!(
        preamble["text"].as_str().unwrap().as_bytes(),
        text.as_bytes()
    );
    assert!(preamble["turnTime"].is_null());
    assert!(preamble["recordTime"].is_null());
    assert!(preamble["sourcePhase"].is_null());
    assert_eq!(global[0]["sourcePhase"], "final");
    assert_eq!(global[0]["turnTime"], "2026-10-03T08:00:00Z");
    assert_eq!(global[0]["recordTime"], "2026-10-04T09:00:00Z");
    assert!(global[0]["text"].as_str().unwrap().contains("2026-10-01"));
    let rendered = captured.model_payload().unwrap().to_string();
    captured
        .verify_prompt(QUESTION, "en", &rendered, &fixture.packet)
        .unwrap();
}

#[test]
fn projected_model_rejects_reintroduced_proof_fields_and_missing_content_fields() {
    let fixture = fixture();
    let captured = capture(&fixture, &[0, 1]);
    for field in PROOF_SPAN_FIELDS {
        let mut changed = captured.model_payload().unwrap();
        changed["sources"][0]["originalSpans"][0][field] =
            captured.base_payload["sources"][0]["originalSpans"][0][field].clone();
        assert!(
            captured
                .verify_prompt(QUESTION, "en", &changed.to_string(), &fixture.packet)
                .is_err(),
            "{field}"
        );
    }
    let mut changed = captured.model_payload().unwrap();
    changed["automatedClaimReviewInputRevisions"] =
        captured.base_payload["automatedClaimReviewInputRevisions"].clone();
    assert!(captured
        .verify_prompt(QUESTION, "en", &changed.to_string(), &fixture.packet)
        .is_err());
    let native = serde_json::to_value(&captured.original_closure[0]).unwrap();
    for field in MODEL_SPAN_FIELDS {
        let mut missing = native.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert!(model_span(&missing).is_err(), "{field}");
        let mut changed = captured.model_payload().unwrap();
        changed["sources"][0]["originalSpans"][0]
            .as_object_mut()
            .unwrap()
            .remove(field);
        assert!(
            captured
                .verify_prompt(QUESTION, "en", &changed.to_string(), &fixture.packet)
                .is_err(),
            "{field}"
        );
    }
    assert!(model_span(&Value::Null).is_err());
}
