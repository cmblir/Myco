//! Exact augmented private proof controls; mock reviews establish no meaning.

use super::*;
use crate::local_synthesis::answer_draft::validate_answer_draft;
use crate::local_synthesis::answer_review::{self, AnswerCorrectionFeedback};
use crate::local_synthesis::claim_prompt::ActivityPrompt;
use crate::local_synthesis::{Evidence, Prompt};

fn bound_feedback(fixture: &Fixture, proof: FocusAnswerQa) -> AnswerCorrectionFeedback {
    let model = proof.model_payload().unwrap();
    let context = crate::wiki_claim_review::tests::context(
        QUESTION,
        "en",
        Scope::All,
        &fixture.range,
        &origin(),
    )
    .with_source_focus_qa()
    .unwrap()
    .with_review_correction_qa()
    .unwrap();
    let evidence = model["sources"]
        .as_array()
        .unwrap()
        .iter()
        .map(|source| Evidence {
            page: source["path"].as_str().unwrap().into(),
            stem: "Synthetic source".into(),
            section: 0,
            text: source["originalSpans"]
                .as_array()
                .unwrap()
                .iter()
                .map(|span| span["text"].as_str().unwrap())
                .collect::<Vec<_>>()
                .join("\n"),
            title: None,
            compiled: None,
        })
        .collect();
    let activity = ActivityPrompt {
        prompt: Prompt {
            system: "Synthetic answer writer transport fixture.".into(),
            user: model.to_string(),
            evidence,
            question: QUESTION.into(),
        },
        proposed_claims: fixture.extraction.claims.claims.len(),
        selected_claims: 2,
        omitted_claims: fixture.extraction.claims.claims.len() - 2,
        original_spans: 3,
        selected_originals: fixture.packet.spans().cloned().collect(),
        focus_answer: Some(proof),
    };
    let draft = validate_answer_draft(
        r#"{"answer":"The user requested a repair but did not perform it.","sources":["S1"]}"#,
        &activity.prompt,
        "en",
    )
    .unwrap();
    let review=answer_review::run_activity(&context,&fixture.packet,&activity,&draft,|_,_|Ok(1000),|_,_,_,_|{
        Ok(json!({"version":"AskAnswerReviewV1","answerDisposition":"unsupported","taskResponse":"adequate",
            "sourceCoverage":"covered","missingSpanIds":[],"reason":"Synthetic transport rejection, not model meaning proof."}).to_string())
    }).unwrap();
    review
        .correction_feedback(&context, &fixture.packet, &activity, &draft)
        .unwrap()
        .unwrap()
}

#[test]
fn default_private_revision_is_identical_and_initial_feedback_cannot_be_captured() {
    let fixture = fixture();
    let proof = capture(&fixture, &[0, 1]);
    let encoded = serde_json::to_vec(&(
        VERSION,
        &proof.base_payload,
        &proof.original_closure,
        &proof.claims,
        proof.focus_claim_count,
        &proof.selected_ordinals,
        &proof.projections,
        &proof.full_witnesses,
    ))
    .unwrap();
    assert_eq!(proof.revision(), format!("{:x}", Sha256::digest(encoded)));
    let mut injected = proof.base_payload.clone();
    injected["answerCorrection"] = json!({"review":"injected"});
    let selected = fixture
        .extraction
        .claims
        .claims
        .iter()
        .take(2)
        .collect::<Vec<_>>();
    assert!(FocusAnswerQa::capture(
        &injected,
        QUESTION,
        "en",
        &fixture.range,
        &fixture.packet.spans().cloned().collect::<Vec<_>>(),
        &fixture.extraction,
        &selected
    )
    .is_err());
}

#[test]
fn augmented_proof_binds_model_feedback_and_rejects_repeat_or_foreign_selection() {
    let fixture = fixture();
    let proof = capture(&fixture, &[0, 1]);
    let feedback = bound_feedback(&fixture, proof.clone());
    let augmented = proof.with_answer_correction(&feedback).unwrap();
    let model = augmented.model_payload().unwrap();
    assert_eq!(model["answerCorrection"], feedback.model_payload().clone());
    assert_eq!(augmented.original_closure, proof.original_closure);
    assert_eq!(augmented.full_witnesses, proof.full_witnesses);
    assert_ne!(augmented.revision(), proof.revision());
    augmented
        .verify_prompt(QUESTION, "en", &model.to_string(), &fixture.packet)
        .unwrap();
    assert!(augmented.with_answer_correction(&feedback).is_err());
    let foreign = capture(&fixture, &[1, 0]);
    assert!(foreign.with_answer_correction(&feedback).is_err());
    let mut altered = model;
    altered["answerCorrection"]["previousAnswer"]["proseWithoutModelLinkLabels"] =
        json!("The repair was completed.");
    assert!(augmented
        .verify_prompt(QUESTION, "en", &altered.to_string(), &fixture.packet)
        .is_err());
}

#[test]
fn recalculating_hash_cannot_replace_feedback_view_or_drop_its_private_binding() {
    let fixture = fixture();
    let proof = capture(&fixture, &[0, 1]);
    let feedback = bound_feedback(&fixture, proof.clone());
    for drop_private in [false, true] {
        let mut changed = proof.with_answer_correction(&feedback).unwrap();
        if drop_private {
            changed.answer_correction = None;
        } else {
            changed.base_payload["answerCorrection"]["review"]["reason"] =
                json!("Pretend that repair is verified.");
        }
        changed.revision = changed.calculate_revision().unwrap();
        assert!(changed.model_payload().is_err());
    }
}
