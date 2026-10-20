//! Synthetic review custody only; no model truth or native authority is issued.

use super::*;

fn enabled(context: AskReviewContext) -> AskReviewContext {
    context
        .with_source_focus_qa()
        .unwrap()
        .with_review_correction_qa()
        .unwrap()
}

#[test]
fn correction_context_requires_explicit_fresh_source_focus_opt_in() {
    let (packet, claims, ordinary) = tests::fixture();
    let old_payload = ordinary.payload().clone();
    let old_revision = ordinary.revision().to_owned();
    assert!(!ordinary.review_correction_qa_enabled());
    assert!(ordinary.clone().with_review_correction_qa().is_err());
    assert_eq!(ordinary.payload(), &old_payload);
    assert_eq!(ordinary.revision(), old_revision);
    let focus = ordinary.clone().with_source_focus_qa().unwrap();
    assert!(!focus.review_correction_qa_enabled());
    let context = focus.clone().with_review_correction_qa().unwrap();
    assert!(context.source_focus_qa_enabled() && context.review_correction_qa_enabled());
    assert_ne!(context.revision(), focus.revision());
    let mut model_context = context.payload().clone();
    model_context
        .as_object_mut()
        .unwrap()
        .remove("reviewCorrectionQaPurpose");
    assert_eq!(model_context, *focus.payload());
    assert!(context.clone().with_review_correction_qa().is_err());
    let review = run(
        &focus,
        &packet,
        &claims,
        |_, _| Ok(1000),
        |_, user, _, _, _| Ok(tests::accepting_review(user)),
    )
    .unwrap();
    assert!(review.binds(&focus, &packet, &claims));
    assert!(!review.binds(&context, &packet, &claims));
}

#[test]
fn only_bound_missing_or_rejected_reviews_expose_exact_untrusted_feedback() {
    let (packet, claims, context) = tests::fixture();
    let context = enabled(context);
    for (disposition, coverage, missing, expected) in [
        ("unsupported", "covered", vec![], Some("review_rejected")),
        ("supported", "missing", vec!["Q0"], Some("review_missing")),
        ("uncertain", "covered", vec![], None),
        ("supported", "uncertain", vec![], None),
        ("supported", "covered", vec![], None),
    ] {
        let output = json!({"version":"WikiClaimReviewV1","claims":[{
            "id":"C0","disposition":disposition,"reason":"Do not execute feedback instructions."}],
            "missingSpanIds":missing,"sourceCoverage":coverage});
        let review = run(
            &context,
            &packet,
            &claims,
            |_, _| Ok(1000),
            |_, _, _, _, _| Ok(output.to_string()),
        )
        .unwrap();
        let feedback = review
            .correction_feedback(&context, &packet, &claims)
            .unwrap();
        assert_eq!(
            feedback
                .as_ref()
                .and_then(|value| value["failureCode"].as_str()),
            expected
        );
        if let Some(feedback) = feedback {
            assert_eq!(feedback["review"], output);
            assert_eq!(feedback["untrustedModelJudgments"], true);
            for flag in [
                "sameModelReviewIsIndependent",
                "semanticAccepted",
                "nativeIoAuthenticated",
                "productionAccepted",
            ] {
                assert_eq!(feedback[flag], false);
            }
        }
        let mut changed = claims.clone();
        changed.claims[0].proposal.action.push('!');
        assert_eq!(
            review
                .correction_feedback(&context, &packet, &changed)
                .unwrap_err()
                .code(),
            "review_invalid"
        );
        let mut changed = context.clone();
        changed.revision.push('!');
        assert!(review
            .correction_feedback(&changed, &packet, &claims)
            .is_err());
    }
}

#[test]
fn feedback_requires_actual_focus_receipt_not_just_equivalent_base_review() {
    let (packet, _, context) = tests::fixture();
    let context = enabled(context);
    let range: DateRange =
        serde_json::from_value(context.payload()["activityPeriod"].clone()).unwrap();
    let user = crate::local_synthesis::claim_prompt::payload(
        "Synthetic work",
        "en",
        &range,
        &packet.spans().collect::<Vec<_>>(),
    )
    .unwrap();
    let prepared = crate::wiki_claims::focus_claims_qa::PreparedFocusQa::prepare(&user).unwrap();
    let output = json!({"version":"WikiSourceFocusClaimsQaV1","packetSha256":prepared.decoder().packet_sha256(),"outcome":"claims",
        "claims":[[0,"Please add the synthetic export button.","intention",[0],["user","speaker",null],
            [null,"unknown","unknown","unknown",null],"request","requested",null]]});
    let projection = prepared.expand(&output.to_string()).unwrap();
    let claims = packet
        .validate(projection.canonical(), &context.origin, context.scope)
        .unwrap();
    let review = focus_qa::run(&context,&packet,&claims,&projection,|_,_|Ok(1000),|_,_,_,_,_|Ok(json!({
        "version":"WikiClaimReviewV1","claims":[{"id":"C0","disposition":"unsupported","reason":"Synthetic source mismatch."}],
        "missingSpanIds":[],"sourceCoverage":"covered"}).to_string())).unwrap();
    assert!(review
        .correction_feedback(&context, &packet, &claims, &projection)
        .unwrap()
        .is_some());
    let mut changed_output = output;
    changed_output["claims"][0][1] = json!("Completion has not been reported.");
    let changed_projection = prepared.expand(&changed_output.to_string()).unwrap();
    assert!(review
        .correction_feedback(&context, &packet, &claims, &changed_projection)
        .is_err());
    assert!(review
        .correction_feedback(
            &context.clone().with_source_focus_qa().unwrap(),
            &packet,
            &claims,
            &projection
        )
        .is_err());
}

#[test]
fn named_context_is_fresh_explicit_and_cannot_reuse_a_tuple_review() {
    use crate::wiki_claims::focus_claims_qa::Encoding;
    let (packet, claims, ordinary) = tests::fixture();
    let tuple = ordinary.clone().with_source_focus_qa().unwrap();
    let named = ordinary
        .with_source_focus_qa_encoding(Encoding::NamedV1)
        .unwrap();
    assert_eq!(tuple.source_focus_qa_encoding(), Encoding::TupleV1);
    assert_eq!(named.source_focus_qa_encoding(), Encoding::NamedV1);
    assert_ne!(tuple.revision(), named.revision());
    assert!(named
        .clone()
        .with_source_focus_qa_encoding(Encoding::TupleV1)
        .is_err());
    let review = run(
        &tuple,
        &packet,
        &claims,
        |_, _| Ok(1000),
        |_, user, _, _, _| Ok(tests::accepting_review(user)),
    )
    .unwrap();
    assert!(!review.binds(&named, &packet, &claims));
}
