//! Synthetic custody checks, not model comprehension or semantic approval.

use super::*;

fn feedback() -> Value {
    json!({"failureCode":"review_missing", "review":{
        "version":"WikiClaimReviewV1","claims":[],
        "missingSpanIds":["Q-FIRST","Q-SECOND"],"sourceCoverage":"missing"},
        "untrustedModelJudgments":true,"sameModelReviewIsIndependent":false,
        "semanticAccepted":false,"nativeIoAuthenticated":false,"productionAccepted":false})
}

fn corrected() -> (SourceSet, PreparedFocusQa, String) {
    let (sources, base) = prepared();
    let previous = output(&base, vec![]).to_string();
    let correction =
        PreparedFocusQa::prepare_correction(base.original_user(), &previous, &feedback()).unwrap();
    (sources, correction, previous)
}

#[test]
fn correction_keeps_all_original_bytes_and_binds_actual_system_user() {
    let (sources, corrected, previous) = corrected();
    let base = PreparedFocusQa::prepare(&input(&sources)).unwrap();
    let original: Value = serde_json::from_str(base.original_user()).unwrap();
    let mut augmented: Value = serde_json::from_str(corrected.original_user()).unwrap();
    let sidecar = augmented
        .as_object_mut()
        .unwrap()
        .remove(correction::FIELD)
        .unwrap();
    assert_eq!(augmented, original);
    assert_eq!(sidecar["previousModelResult"], previous);
    assert_eq!(sidecar["automatedReviewFeedback"], feedback());
    assert_eq!(sidecar["semanticApproval"], false);
    assert!(corrected.system().starts_with(base.system()));
    assert!(corrected.system().contains("Return a complete replacement"));
    assert!(corrected
        .system()
        .contains("Review feedback can be mistaken"));
    assert!(corrected.system().contains("same-model review"));
    assert_eq!(
        corrected.decoder().span_count(),
        base.decoder().span_count()
    );
    assert_ne!(
        corrected.decoder().packet_sha256(),
        base.decoder().packet_sha256()
    );
    assert_eq!(
        corrected.decoder().packet_sha256(),
        sha256(corrected.original_user().as_bytes())
    );
    let projection = corrected.expand(&sample(&corrected).to_string()).unwrap();
    let base_projection = base.expand(&sample(&base).to_string()).unwrap();
    assert_eq!(projection.canonical(), base_projection.canonical());
    assert_ne!(projection.revision(), base_projection.revision());
    assert!(projection.verify_binding().is_ok());
    let claims = sources
        .validate(projection.canonical(), &origin(), Scope::Sessions)
        .unwrap();
    projection
        .review_value(&sources, &claims, &original)
        .unwrap();
    let diagnostic = serde_json::to_value(&projection).unwrap();
    assert_eq!(diagnostic["semanticAccepted"], false);
    assert_eq!(diagnostic["nativeIoAuthenticated"], false);
    assert!(diagnostic.get("previousModelResult").is_none());
    assert!(diagnostic.get("correction").is_none());
}

#[test]
fn changed_actual_prompt_and_lost_or_replayed_private_proof_fail() {
    let (_, mut prepared, _) = corrected();
    let raw = sample(&prepared).to_string();
    let system = prepared.system.clone();
    prepared.system.push(' ');
    assert!(prepared.expand(&raw).is_err());
    prepared.system = system;
    let user = prepared.user.clone();
    prepared.user.push(' ');
    assert!(prepared.expand(&raw).is_err());
    prepared.user = user;
    let mut projection = prepared.expand(&raw).unwrap();
    projection.correction = None;
    assert!(projection.verify_binding().is_err());
    let mut projection = prepared.expand(&raw).unwrap();
    let original = PreparedFocusQa::prepare(&input(&source_set(FIRST, SECOND, false))).unwrap();
    let other = PreparedFocusQa::prepare_correction(
        original.original_user(),
        "different prior raw",
        &feedback(),
    )
    .unwrap();
    projection.correction = other.correction.clone();
    assert!(projection.verify_binding().is_err());
    assert!(other.expand(&raw).is_err());
}

#[test]
fn previous_output_and_feedback_changes_are_bound_without_native_repairs() {
    let (_, prepared, previous) = corrected();
    let raw = sample(&prepared).to_string();
    let base = PreparedFocusQa::prepare(&input(&source_set(FIRST, SECOND, false))).unwrap();
    let mut revised_feedback = feedback();
    revised_feedback["review"]["missingSpanIds"] = json!(["Q-FIRST"]);
    for changed in [
        PreparedFocusQa::prepare_correction(
            base.original_user(),
            &(previous.clone() + " "),
            &feedback(),
        )
        .unwrap(),
        PreparedFocusQa::prepare_correction(base.original_user(), &previous, &revised_feedback)
            .unwrap(),
    ] {
        assert_ne!(changed.decoder(), prepared.decoder());
        assert!(changed.expand(&raw).is_err());
        let current = changed.expand(&sample(&changed).to_string()).unwrap();
        let old = prepared.expand(&raw).unwrap();
        assert_eq!(current.canonical(), old.canonical());
        assert_ne!(current.revision(), old.revision());
    }
}

#[test]
fn recursive_forged_authority_and_unbounded_correction_inputs_fail() {
    let (_, prepared, previous) = corrected();
    assert!(PreparedFocusQa::prepare(prepared.original_user()).is_err());
    assert!(
        PreparedFocusQa::prepare_correction(prepared.original_user(), &previous, &feedback())
            .is_err()
    );
    let base = input(&source_set(FIRST, SECOND, false));
    for key in [
        "semanticAccepted",
        "nativeIoAuthenticated",
        "productionAccepted",
        "sameModelReviewIsIndependent",
    ] {
        let mut forged = feedback();
        forged[key] = json!(true);
        assert!(PreparedFocusQa::prepare_correction(&base, &previous, &forged).is_err());
    }
    for code in [
        "review_uncertain",
        "review_stopped",
        "review_not_fit",
        "review_invalid",
    ] {
        let mut forged = feedback();
        forged["failureCode"] = json!(code);
        assert!(PreparedFocusQa::prepare_correction(&base, &previous, &forged).is_err());
    }
    for raw in [
        String::new(),
        "x".repeat(crate::wiki_claims::MAX_OUTPUT_BYTES + 1),
    ] {
        assert!(PreparedFocusQa::prepare_correction(&base, &raw, &feedback()).is_err());
    }
}

#[test]
fn correction_still_rejects_changed_sources_order_period_or_speaker() {
    let (sources, prepared, _) = corrected();
    let projection = prepared.expand(&sample(&prepared).to_string()).unwrap();
    projection
        .verify_answer_context(
            "Summarize recent activity",
            "en",
            &period(),
            &sources.spans().cloned().collect::<Vec<_>>(),
        )
        .unwrap();
    for changed in [
        source_set(&FIRST.replace("archive", "ledger"), SECOND, false),
        source_set(FIRST, SECOND, true),
    ] {
        assert!(projection
            .verify_answer_context(
                "Summarize recent activity",
                "en",
                &period(),
                &changed.spans().cloned().collect::<Vec<_>>()
            )
            .is_err());
    }
    let mut mutated = projection.clone();
    let mut input: Value = serde_json::from_str(&mutated.original_user).unwrap();
    input["originalSpans"][0]["speaker"] = json!("assistant");
    mutated.original_user = input.to_string();
    assert!(mutated.verify_binding().is_err());
    let mut changed_period = period();
    changed_period.end = "2026-10-05".into();
    assert!(projection
        .verify_answer_context(
            "Summarize recent activity",
            "en",
            &changed_period,
            &sources.spans().cloned().collect::<Vec<_>>()
        )
        .is_err());
}

#[test]
fn false_meaning_can_still_pass_shape_but_never_gets_semantic_approval() {
    let (sources, prepared, _) = corrected();
    let false_claim = claim(
        0,
        "I did not deploy.",
        "asserted_occurrence",
        "report",
        "reported_completed",
    );
    let projection = prepared
        .expand(&output(&prepared, vec![false_claim]).to_string())
        .unwrap();
    let claims = sources
        .validate(projection.canonical(), &origin(), Scope::Sessions)
        .unwrap();
    assert_eq!(claims.claims[0].proposal.action, "I did not deploy.");
    assert_eq!(claims.claims[0].proposal.actor.role, ActorRole::User);
    assert_eq!(
        claims.claims[0].proposal.status,
        crate::wiki_claims::ClaimStatus::ReportedCompleted
    );
    assert!(claims.claims[0].proposal.event_time.value.is_none());
    assert!(claims.claims[0].semantic_review_required);
    assert!(!projection.semantic_accepted);
    assert!(!projection.native_io_authenticated);
}

#[test]
fn ordinary_revision_is_unchanged_and_exact_previous_raw_mutations_fail() {
    let (_, prepared) = prepared();
    let raw = sample(&prepared).to_string();
    let mut projection = prepared.expand(&raw).unwrap();
    assert_eq!(
        projection.revision(),
        projection_revision(
            prepared.original_user(),
            projection.canonical(),
            &projection.witnesses
        )
        .unwrap()
    );
    projection.verify_model_result(&raw).unwrap();
    assert!(projection
        .verify_model_result(&(raw.clone() + " "))
        .is_err());
    projection.model_raw.push(' ');
    assert!(projection.verify_binding().is_err());
    let diagnostic = serde_json::to_value(&projection).unwrap();
    assert!(diagnostic.get("modelRaw").is_none());
    assert!(diagnostic.get("modelRawSha256").is_none());
}
