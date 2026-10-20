//! Synthetic observations only; no model, native window or authority issuance.
use super::*;

fn state() -> ProbeState {
    let state = ProbeState {
        activity_questions: true,
        source_focus_claims: true,
        ..ProbeState::default()
    };
    state.owned_requests.lock().unwrap().insert("owned".into());
    state
}

fn budget() -> FocusTokenBudgetQa {
    FocusTokenBudgetQa {
        context_tokens: 4096,
        output_tokens: 768,
        reserve: 8,
    }
}

fn initial() -> Value {
    json!({"interpretationRevision":"a".repeat(64),"requiredClaimIds":["C0"],
        "originalSpans":[{"text":"Synthetic original body sentinel."}],
        "claims":[{"id":"C0","proposal":{"action":"Synthetic focus sentinel."}}],
        "sourceFocusInterpretations":{"claims":[{"id":"C0","assertionKind":"intention"}]}})
}

fn compact() -> Value {
    json!({"sourceFocusRepresentation":"source_focus_quote",
        "sourceFocusInterpretationRevision":"b".repeat(64),
        "sourceFocusInterpretations":[{"selectedProposalOrdinal":0,"assertionKind":"intention"}],
        "claimProposals":[{"action":"Synthetic selected focus sentinel."}]})
}

fn answer() -> Value {
    let mut payload = compact();
    payload["sources"] = json!([
        {"originalSpans":[{"text":"Synthetic first original sentinel."}]},
        {"originalSpans":[{"text":"Synthetic second original sentinel."},{"text":"Synthetic contrary original sentinel."}]}
    ]);
    payload["coverage"] = json!({"proposedClaims":2,"selectedClaims":1,"omittedClaims":1});
    payload
}

fn final_review() -> Value {
    let mut payload = compact();
    payload["originalSpans"] = json!([{"text":"Synthetic original sentinel."}]);
    payload
}

fn correction_state() -> ProbeState {
    let mut state = state();
    state.reviewed_activity_correction = true;
    state
}

fn initial_correction() -> Value {
    json!({"packetSha256":"c".repeat(64),"allowedSpanIds":["Q0","Q1"],
        "spanOrdinalDictionary":[{"ordinal":0,"spanId":"Q0"},{"ordinal":1,"spanId":"Q1"}],
        "originalSpans":[{"id":"Q0","text":"Synthetic source body sentinel A."},
            {"id":"Q1","text":"Synthetic source body sentinel B."}],
        "initialExtractionCorrection":{"previousModelResult":"Synthetic previous raw sentinel, never current proposals.",
            "automatedReviewFeedback":{"failureCode":"review_missing",
                "review":{"version":"WikiClaimReviewV1","claims":[],"missingSpanIds":["Q1"],"sourceCoverage":"missing"},
                "untrustedModelJudgments":true,"sameModelReviewIsIndependent":false,
                "semanticAccepted":false,"nativeIoAuthenticated":false,"productionAccepted":false},
            "untrustedModelData":true,"semanticApproval":false,"correctionAttempt":1}})
}

fn answer_correction() -> Value {
    let mut payload = answer();
    payload["answerCorrection"] = json!({
        "previousAnswer":{"proseWithoutModelLinkLabels":"Synthetic old answer sentinel.","sourceIds":["S1"]},
        "review":{"version":"AskAnswerReviewV1","answerDisposition":"unsupported","taskResponse":"uncertain",
            "sourceCoverage":"missing","missingSpanIds":["Q1"],"reason":"Synthetic review sentinel."},
        "untrustedModelJudgments":true});
    payload
}

fn observe_test(
    state: &ProbeState,
    phase: FocusTokenPhaseQa,
    payload: &Value,
    counted: Result<usize, String>,
) -> Result<bool, &'static str> {
    record(
        state,
        "owned",
        phase,
        "Synthetic system sentinel.",
        &payload.to_string(),
        &counted,
        budget(),
    )
}

#[test]
fn initial_compatibility_filter_does_not_infer_answer_or_final_review_phases() {
    assert!(initial_review_input(&initial()));
    assert!(!initial_review_input(&answer()));
    assert!(!initial_review_input(&final_review()));
    assert!(!initial_review_input(&json!({"originalSpans":[]})));
    assert!(!initial_review_input(&initial_correction()));
    assert!(!initial_review_input(&answer_correction()));
}

#[test]
fn correction_phases_record_actual_inputs_without_turning_previous_results_into_proposals() {
    let state = correction_state();
    for (phase, payload, originals, proposed, selected, mapped) in [
        (
            FocusTokenPhaseQa::InitialExtractionCorrection,
            initial_correction(),
            2,
            None,
            None,
            None,
        ),
        (
            FocusTokenPhaseQa::AnswerCorrection,
            answer_correction(),
            3,
            Some(2),
            Some(1),
            Some(1),
        ),
    ] {
        assert_eq!(observe_test(&state, phase, &payload, Ok(3321)), Ok(true));
        let rows = state.focus_review_tokens.lock().unwrap();
        let row = rows.last().unwrap();
        assert_eq!(row["phase"], json!(phase));
        assert_eq!(row["originalSpanCount"], originals);
        assert_eq!(row["proposalCount"], json!(proposed));
        assert_eq!(row["selectedClaimCount"], json!(selected));
        assert_eq!(row["mappedKinds"], json!(mapped));
        assert_eq!(row["fits"], false);
        assert_eq!(row["inputSha256"], sha(payload.to_string().as_bytes()));
        assert!(!row.to_string().contains("sentinel"));
        assert_eq!(row["nativeIoAuthenticated"], false);
        assert_eq!(row["semanticAccepted"], false);
        assert_eq!(row["productionAccepted"], false);
        if matches!(phase, FocusTokenPhaseQa::InitialExtractionCorrection) {
            assert!(row["interpretationRevision"].is_null());
            assert_eq!(row["packetSha256"], "c".repeat(64));
        }
    }
    let mut terminal = json!({});
    append_terminal(&state, &mut terminal);
    assert_eq!(
        terminal["sourceFocusTokenCounts"].as_array().unwrap().len(),
        2
    );
    assert!(terminal["sourceFocusReviewTokenCounts"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn correction_measurements_require_opt_in_and_ownership_without_enforcing_retry_authority() {
    let off = state();
    for (phase, packet) in [
        (
            FocusTokenPhaseQa::InitialExtractionCorrection,
            initial_correction(),
        ),
        (FocusTokenPhaseQa::AnswerCorrection, answer_correction()),
    ] {
        assert_eq!(observe_test(&off, phase, &packet, Ok(1)), Ok(false));
    }
    assert!(off.focus_review_tokens.lock().unwrap().is_empty());
    let state = correction_state();
    assert!(record(
        &state,
        "foreign",
        FocusTokenPhaseQa::InitialExtractionCorrection,
        "sys",
        &initial_correction().to_string(),
        &Ok(1),
        budget()
    )
    .is_err());
    for result in [Ok(3320), Ok(3321), Err("synthetic counting failed".into())] {
        assert_eq!(
            observe_test(
                &state,
                FocusTokenPhaseQa::InitialExtractionCorrection,
                &initial_correction(),
                result
            ),
            Ok(true)
        );
    }
    let rows = state.focus_review_tokens.lock().unwrap();
    assert_eq!(rows.len(), 3);
    for (index, row) in rows.iter().enumerate() {
        assert_eq!(row["seenOrdinal"], index + 1);
        assert_eq!(row["observationOrdinal"], index + 1);
        assert!(row["proposalCount"].is_null());
    }
    assert!(rows[2]["fits"].is_null());
    assert_eq!(rows[2]["tokenCount"]["Err"], "synthetic counting failed");
}

#[test]
fn malformed_correction_packets_fail_visible_without_inferred_phases_or_counts() {
    let state = correction_state();
    for (phase, payload) in [
        (FocusTokenPhaseQa::InitialExtractionCorrection, initial()),
        (FocusTokenPhaseQa::AnswerCorrection, answer()),
        (
            FocusTokenPhaseQa::InitialExtractionCorrection,
            answer_correction(),
        ),
        (FocusTokenPhaseQa::AnswerCorrection, initial_correction()),
    ] {
        assert!(observe_test(&state, phase, &payload, Ok(1)).is_err());
    }
    let mut wrong_dictionary = initial_correction();
    wrong_dictionary["spanOrdinalDictionary"][1]["spanId"] = json!("foreign");
    assert!(observe_test(
        &state,
        FocusTokenPhaseQa::InitialExtractionCorrection,
        &wrong_dictionary,
        Ok(1)
    )
    .is_err());
    let mut duplicate_original = initial_correction();
    duplicate_original["originalSpans"][1]["id"] = json!("Q0");
    assert!(observe_test(
        &state,
        FocusTokenPhaseQa::InitialExtractionCorrection,
        &duplicate_original,
        Ok(1)
    )
    .is_err());
    let mut wrong_feedback = initial_correction();
    wrong_feedback["initialExtractionCorrection"]["automatedReviewFeedback"]["semanticAccepted"] =
        json!(true);
    assert!(observe_test(
        &state,
        FocusTokenPhaseQa::InitialExtractionCorrection,
        &wrong_feedback,
        Ok(1)
    )
    .is_err());
    let mut unknown_code = initial_correction();
    unknown_code["initialExtractionCorrection"]["automatedReviewFeedback"]["failureCode"] =
        json!("review_uncertain");
    assert!(observe_test(
        &state,
        FocusTokenPhaseQa::InitialExtractionCorrection,
        &unknown_code,
        Ok(1)
    )
    .is_err());
    let mut malformed_previous = answer_correction();
    malformed_previous["answerCorrection"]["previousAnswer"]["modelAnswer"] = json!(1);
    assert!(observe_test(
        &state,
        FocusTokenPhaseQa::AnswerCorrection,
        &malformed_previous,
        Ok(1)
    )
    .is_err());
    let mut wrong_writer_count = answer_correction();
    wrong_writer_count["coverage"]["selectedClaims"] = json!(2);
    assert!(observe_test(
        &state,
        FocusTokenPhaseQa::AnswerCorrection,
        &wrong_writer_count,
        Ok(1)
    )
    .is_err());
    assert!(state.focus_review_tokens.lock().unwrap().is_empty());
}

#[test]
fn explicit_phases_record_actual_packet_counts_hashes_and_no_bodies_or_authority() {
    let state = state();
    for (phase, payload, original_count, proposed, selected) in [
        (
            FocusTokenPhaseQa::InitialClaimReview,
            initial(),
            1,
            Some(1),
            None,
        ),
        (
            FocusTokenPhaseQa::AnswerGroupCandidate,
            answer(),
            3,
            Some(2),
            Some(1),
        ),
        (
            FocusTokenPhaseQa::AnswerDraftFinal,
            answer(),
            3,
            Some(2),
            Some(1),
        ),
        (
            FocusTokenPhaseQa::FinalAnswerReview,
            final_review(),
            1,
            None,
            Some(1),
        ),
    ] {
        assert_eq!(observe_test(&state, phase, &payload, Ok(3320)), Ok(true));
        let rows = state.focus_review_tokens.lock().unwrap();
        let v = rows.last().unwrap();
        assert_eq!(v["phase"], json!(phase));
        assert_eq!(v["inputSha256"], sha(payload.to_string().as_bytes()));
        assert_eq!(v["systemSha256"], sha(b"Synthetic system sentinel."));
        assert_eq!(v["tokenCount"], json!({"Ok":3320}));
        assert_eq!(v["fits"], true);
        assert_eq!(v["originalSpanCount"], original_count);
        assert_eq!(v["proposalCount"], json!(proposed));
        assert_eq!(v["selectedClaimCount"], json!(selected));
        assert_eq!(v["mappedKinds"], 1);
        assert_eq!(
            v["interpretationRevision"],
            if matches!(phase, FocusTokenPhaseQa::InitialClaimReview) {
                "a".repeat(64)
            } else {
                "b".repeat(64)
            }
        );
        assert!(!v.to_string().contains("sentinel"));
        for flag in [
            "promptBodiesIncluded",
            "nativeIoAuthenticated",
            "semanticAccepted",
            "productionAccepted",
        ] {
            assert_eq!(v[flag], false);
        }
    }
    let mut terminal = json!({});
    append_terminal(&state, &mut terminal);
    assert_eq!(terminal["sourceFocusTokenObservationLimit"], 256);
    assert_eq!(
        terminal["sourceFocusTokenCounts"].as_array().unwrap().len(),
        4
    );
    assert_eq!(
        terminal["sourceFocusReviewTokenCounts"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        terminal["sourceFocusReviewTokenCounts"][0]["phase"],
        "initial_claim_review"
    );
    assert!(terminal["sourceFocusTokenObservationReadError"].is_null());
}

#[test]
fn identical_inputs_are_legitimate_attempts_with_result_independent_seen_ordinals() {
    let state = state();
    let payload = answer();
    for result in [
        Ok(3320),
        Ok(3321),
        Err("synthetic tokenization failure".into()),
    ] {
        assert_eq!(
            observe_test(
                &state,
                FocusTokenPhaseQa::AnswerGroupCandidate,
                &payload,
                result
            ),
            Ok(true)
        );
    }
    assert_eq!(
        observe_test(&state, FocusTokenPhaseQa::AnswerDraftFinal, &payload, Ok(1)),
        Ok(true)
    );
    assert_eq!(
        record(
            &state,
            "owned",
            FocusTokenPhaseQa::AnswerGroupCandidate,
            "Different system",
            &payload.to_string(),
            &Ok(1),
            budget()
        ),
        Ok(true)
    );
    let mut different_user = payload.clone();
    different_user["question"] = json!("Another synthetic question sentinel.");
    assert_eq!(
        observe_test(
            &state,
            FocusTokenPhaseQa::AnswerGroupCandidate,
            &different_user,
            Ok(1)
        ),
        Ok(true)
    );
    let rows = state.focus_review_tokens.lock().unwrap();
    for (index, seen) in [1, 2, 3, 1, 1, 1].into_iter().enumerate() {
        assert_eq!(rows[index]["observationOrdinal"], index + 1);
        assert_eq!(rows[index]["seenOrdinal"], seen);
    }
    assert_eq!(rows[0]["fits"], true);
    assert_eq!(rows[1]["fits"], false);
    assert!(rows[2]["fits"].is_null());
    assert_eq!(
        rows[2]["tokenCount"]["Err"],
        "synthetic tokenization failure"
    );
    assert_eq!(state.observation_errors.load(Ordering::Relaxed), 0);
}

#[test]
fn actual_output_budget_controls_fit_and_invalid_budgets_do_not_emit_rows() {
    let state = state();
    for (counted, fits) in [(3456, true), (3457, false)] {
        assert_eq!(
            record(
                &state,
                "owned",
                FocusTokenPhaseQa::AnswerDraftFinal,
                "sys",
                &answer().to_string(),
                &Ok(counted),
                FocusTokenBudgetQa {
                    context_tokens: 4096,
                    output_tokens: 632,
                    reserve: 8
                }
            ),
            Ok(true)
        );
        let rows = state.focus_review_tokens.lock().unwrap();
        assert_eq!(rows.last().unwrap()["maximumPromptTokens"], 3456);
        assert_eq!(rows.last().unwrap()["outputTokens"], 632);
        assert_eq!(rows.last().unwrap()["fits"], fits);
    }
    for invalid in [
        FocusTokenBudgetQa {
            context_tokens: 4096,
            output_tokens: 0,
            reserve: 8,
        },
        FocusTokenBudgetQa {
            context_tokens: 4096,
            output_tokens: -1,
            reserve: 8,
        },
        FocusTokenBudgetQa {
            context_tokens: 767,
            output_tokens: 768,
            reserve: 8,
        },
        FocusTokenBudgetQa {
            context_tokens: 4096,
            output_tokens: 768,
            reserve: usize::MAX,
        },
    ] {
        assert!(record(
            &state,
            "owned",
            FocusTokenPhaseQa::AnswerDraftFinal,
            "sys",
            &answer().to_string(),
            &Ok(1),
            invalid
        )
        .is_err());
    }
    assert_eq!(state.focus_review_tokens.lock().unwrap().len(), 2);
}

#[test]
fn unselected_qa_is_noop_and_exact_request_ownership_is_required() {
    for state in [
        ProbeState::default(),
        ProbeState {
            activity_questions: true,
            ..ProbeState::default()
        },
    ] {
        assert_eq!(
            record(
                &state,
                "other",
                FocusTokenPhaseQa::AnswerDraftFinal,
                "sys",
                "not JSON",
                &Ok(1),
                budget()
            ),
            Ok(false)
        );
        assert!(state.focus_review_tokens.lock().unwrap().is_empty());
    }
    let state = state();
    assert!(record(
        &state,
        "other",
        FocusTokenPhaseQa::InitialClaimReview,
        "sys",
        &initial().to_string(),
        &Ok(1),
        budget()
    )
    .unwrap_err()
    .contains("QA-owned"));
    assert!(state.focus_review_tokens.lock().unwrap().is_empty());
}

#[test]
fn explicit_phase_malformed_payload_and_inconsistent_counts_fail_without_shape_guessing() {
    let state = state();
    assert!(observe_test(
        &state,
        FocusTokenPhaseQa::AnswerDraftFinal,
        &initial(),
        Ok(1)
    )
    .is_err());
    assert!(observe_test(
        &state,
        FocusTokenPhaseQa::InitialClaimReview,
        &answer(),
        Ok(1)
    )
    .is_err());
    let mut initial_mismatch = initial();
    initial_mismatch["sourceFocusInterpretations"]["claims"][0]["id"] = json!("C1");
    assert!(observe_test(
        &state,
        FocusTokenPhaseQa::InitialClaimReview,
        &initial_mismatch,
        Ok(1)
    )
    .is_err());
    initial_mismatch["sourceFocusInterpretations"]["claims"] = json!([]);
    assert!(observe_test(
        &state,
        FocusTokenPhaseQa::InitialClaimReview,
        &initial_mismatch,
        Ok(1)
    )
    .is_err());
    let mut initial_bad_revision = initial();
    initial_bad_revision["interpretationRevision"] = json!("synthetic source body sentinel");
    assert!(observe_test(
        &state,
        FocusTokenPhaseQa::InitialClaimReview,
        &initial_bad_revision,
        Ok(1)
    )
    .is_err());
    let mut malformed = Vec::new();
    let mut missing_originals = answer();
    missing_originals["sources"][1]["originalSpans"] = Value::Null;
    malformed.push(missing_originals);
    let mut wrong_selected = answer();
    wrong_selected["coverage"]["selectedClaims"] = json!(2);
    malformed.push(wrong_selected);
    let mut wrong_proposed = answer();
    wrong_proposed["coverage"]["proposedClaims"] = json!(0);
    malformed.push(wrong_proposed);
    let mut wrong_omitted = answer();
    wrong_omitted["coverage"]["omittedClaims"] = json!(0);
    malformed.push(wrong_omitted);
    let mut duplicate_mapping = answer();
    duplicate_mapping["sourceFocusInterpretations"]
        .as_array_mut()
        .unwrap()
        .push(json!({"selectedProposalOrdinal":0,"assertionKind":"intention"}));
    malformed.push(duplicate_mapping);
    let mut unknown_mapping = answer();
    unknown_mapping["sourceFocusInterpretations"][0]["selectedProposalOrdinal"] = json!(1);
    malformed.push(unknown_mapping);
    let mut bad_kind = answer();
    bad_kind["sourceFocusInterpretations"][0]["assertionKind"] = json!("verified_completion");
    malformed.push(bad_kind);
    let mut bad_revision = answer();
    bad_revision["sourceFocusInterpretationRevision"] = json!("not a revision");
    malformed.push(bad_revision);
    for payload in malformed {
        assert!(observe_test(
            &state,
            FocusTokenPhaseQa::AnswerGroupCandidate,
            &payload,
            Ok(1)
        )
        .is_err());
    }
    assert!(state.focus_review_tokens.lock().unwrap().is_empty());
}

#[test]
fn final_review_unknown_proposed_count_stays_null_and_declared_counts_are_checked() {
    let state = state();
    assert_eq!(
        observe_test(
            &state,
            FocusTokenPhaseQa::FinalAnswerReview,
            &final_review(),
            Ok(1)
        ),
        Ok(true)
    );
    let mut declared = final_review();
    declared["coverage"] = json!({"proposedClaims":3,"selectedClaims":1});
    assert_eq!(
        observe_test(
            &state,
            FocusTokenPhaseQa::FinalAnswerReview,
            &declared,
            Ok(1)
        ),
        Ok(true)
    );
    {
        let rows = state.focus_review_tokens.lock().unwrap();
        assert!(rows[0]["proposalCount"].is_null());
        assert_eq!(rows[0]["selectedClaimCount"], 1);
        assert_eq!(rows[1]["proposalCount"], 3);
    }
    declared["coverage"]["selectedClaims"] = json!(2);
    assert!(observe_test(
        &state,
        FocusTokenPhaseQa::FinalAnswerReview,
        &declared,
        Ok(1)
    )
    .is_err());
    declared["coverage"] = json!({"proposedClaims":0});
    assert!(observe_test(
        &state,
        FocusTokenPhaseQa::FinalAnswerReview,
        &declared,
        Ok(1)
    )
    .is_err());
    declared["coverage"] = json!("not a count object");
    assert!(observe_test(
        &state,
        FocusTokenPhaseQa::FinalAnswerReview,
        &declared,
        Ok(1)
    )
    .is_err());
}

#[test]
fn bounded_capacity_rejects_extra_rows_without_erasing_prior_observations() {
    let state = state();
    for _ in 0..OBSERVATION_LIMIT {
        assert_eq!(
            observe_test(
                &state,
                FocusTokenPhaseQa::AnswerDraftFinal,
                &answer(),
                Ok(1)
            ),
            Ok(true)
        );
    }
    assert!(observe_test(
        &state,
        FocusTokenPhaseQa::AnswerDraftFinal,
        &answer(),
        Ok(1)
    )
    .unwrap_err()
    .contains("capacity"));
    let rows = state.focus_review_tokens.lock().unwrap();
    assert_eq!(rows.len(), 256);
    assert_eq!(rows[255]["observationOrdinal"], 256);
    assert_eq!(rows[255]["seenOrdinal"], 256);
}

#[test]
fn poisoned_locks_remain_visible_failures_and_terminal_does_not_fabricate_empty_success() {
    let measurement_poisoned = state();
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _guard = measurement_poisoned.focus_review_tokens.lock().unwrap();
        panic!("synthetic measurement lock poison");
    }));
    let error = observe_test(
        &measurement_poisoned,
        FocusTokenPhaseQa::AnswerDraftFinal,
        &answer(),
        Ok(1),
    )
    .unwrap_err();
    assert!(error.contains("poisoned"));
    report_error(&measurement_poisoned, error);
    assert_eq!(
        measurement_poisoned
            .observation_errors
            .load(Ordering::Relaxed),
        1
    );
    let mut terminal = json!({});
    append_terminal(&measurement_poisoned, &mut terminal);
    assert_eq!(
        measurement_poisoned
            .observation_errors
            .load(Ordering::Relaxed),
        2
    );
    assert!(terminal["sourceFocusTokenCounts"].is_null());
    assert!(terminal["sourceFocusReviewTokenCounts"].is_null());
    assert_eq!(
        terminal["sourceFocusTokenObservationReadError"],
        "measurement terminal lock poisoned"
    );
    let ownership_poisoned = state();
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _guard = ownership_poisoned.owned_requests.lock().unwrap();
        panic!("synthetic ownership lock poison");
    }));
    assert!(observe_test(
        &ownership_poisoned,
        FocusTokenPhaseQa::AnswerDraftFinal,
        &answer(),
        Ok(1)
    )
    .unwrap_err()
    .contains("ownership lock poisoned"));
}
