//! Pure fixture and failure-path controls; no weights, app data or generation.

use super::*;

fn origin() -> AgentVaultSession {
    AgentVaultSession {
        vault_path: "/synthetic/compact-suite-only".into(),
        opening_token: "synthetic-opening".into(),
    }
}

#[test]
fn all_unchanged_sources_are_bound_without_gold_or_whole_body_prompt_injection() {
    let cases = fixture().unwrap();
    assert_eq!(cases.len(), 4);
    let mut total = 0;
    for case in &cases {
        let (sources, prepared, mapping) = prepare_case(case, &origin()).unwrap();
        let original_user: Value = serde_json::from_str(prepared.original_user()).unwrap();
        assert_eq!(original_user["question"], case["question"]);
        assert_eq!(original_user["language"], case["language"]);
        assert_eq!(original_user["independentVerificationReceipts"], json!([]));
        assert!(original_user.get("gold").is_none());
        assert!(original_user.get("requiredFacts").is_none());
        assert!(original_user.get("expectedClaims").is_none());
        assert!(original_user.get("source").is_none());
        assert_eq!(
            sources.spans().count(),
            case["source"]["turns"].as_array().unwrap().len()
        );
        total += sources.spans().count();
        for ((span, reference), map) in sources
            .spans()
            .zip(case["source"]["turns"].as_array().unwrap())
            .zip(mapping.as_array().unwrap())
        {
            assert_eq!(span.text(), reference["text"].as_str().unwrap());
            assert_eq!(span.start() as u64, reference["start"].as_u64().unwrap());
            assert_eq!(span.end() as u64, reference["end"].as_u64().unwrap());
            assert_eq!(span.span_sha256(), reference["sha256"].as_str().unwrap());
            assert_eq!(
                span.source_revision(),
                case["source"]["sha256"].as_str().unwrap()
            );
            assert_eq!(span.turn_time(), reference["turnTime"].as_str());
            assert_eq!(span.source_phase(), reference["sourcePhase"].as_str());
            assert_eq!(span.record_time(), case["source"]["recordTime"].as_str());
            assert_eq!(span.id(), map["spanId"].as_str().unwrap());
            assert_eq!(span.id().len(), 34);
        }
        let augmented: Value = serde_json::from_str(prepared.user()).unwrap();
        assert_eq!(augmented["originalSpans"], original_user["originalSpans"]);
        assert_eq!(
            prepared.decoder().packet_sha256(),
            sha(prepared.original_user().as_bytes())
        );
    }
    assert_eq!(total, 9);
    assert_eq!(cases[3]["source"]["turns"].as_array().unwrap().len(), 3);
}

#[test]
fn historical_period_is_helper_kst_midnight_with_exclusive_end() {
    let cases = fixture().unwrap();
    let range = historical_range(&cases[0]).unwrap();
    assert_eq!(
        range.start_epoch,
        crate::importers::parse_iso8601("2026-09-30T15:00:00Z")
    );
    assert_eq!(
        range.end_epoch,
        crate::importers::parse_iso8601("2026-10-04T15:00:00Z")
    );
    assert_eq!(
        range.end_epoch.unwrap() - range.start_epoch.unwrap(),
        4 * 86_400
    );
    let mut bad = cases[0].clone();
    bad["activityPeriod"]["start"] = json!("2026-10-08");
    assert!(historical_range(&bad).is_err());
    bad["activityPeriod"]["start"] = json!("2026-02-30");
    assert!(historical_range(&bad).is_err());
}

#[test]
fn mutated_original_coordinates_text_sha_or_turn_order_fail_before_preparation() {
    let case = fixture().unwrap().remove(0);
    let mut mutations = Vec::new();
    let mut body = case.clone();
    body["source"]["original"] = json!("Changed original");
    mutations.push(body);
    let mut coordinate = case.clone();
    coordinate["source"]["turns"][0]["start"] = json!(1);
    mutations.push(coordinate);
    let mut text = case.clone();
    text["source"]["turns"][0]["text"] = json!("Changed turn");
    mutations.push(text);
    let mut sha = case.clone();
    sha["source"]["turns"][0]["sha256"] = json!("0".repeat(64));
    mutations.push(sha);
    let mut order = case;
    order["source"]["turns"].as_array_mut().unwrap().swap(0, 1);
    mutations.push(order);
    for changed in mutations {
        assert!(prepare_case(&changed, &origin()).is_err());
    }
}

#[test]
fn unavailable_host_observes_each_case_once_with_no_fake_decoder_or_acceptance() {
    let cases = fixture().unwrap();
    let mut counts = Counts::default();
    for case in &cases {
        let record = observe_case(
            case,
            &origin(),
            None,
            Some("synthetic host unavailable"),
            &mut counts,
        );
        assert_eq!(record["attemptOrdinal"], 1);
        assert_eq!(record["retryCount"], 0);
        assert_eq!(record["failureStage"], "model_setup");
        assert_eq!(record["decoderAttemptStarted"], false);
        assert_eq!(record["decoderAttemptObserved"], false);
        assert_eq!(record["sourceSetValidation"]["status"], "not_run");
        assert_eq!(record["semanticAccepted"], false);
        assert_eq!(record["nativeIoAuthenticated"], false);
        assert!(record.get("originalUserSha256").is_some());
        assert!(record.get("rawCompact").is_none());
    }
    assert_eq!(counts.observed, 4);
    assert_eq!(counts.attempts_started, 0);
    assert_eq!(counts.attempts_observed, 0);
    assert_eq!(counts.native_structure_valid, 0);
    assert_eq!(counts.failures.len(), 4);
}

#[test]
fn empty_positive_source_and_non_eog_are_not_successful_extractions() {
    let case = fixture().unwrap().remove(0);
    let (sources, _, _) = prepare_case(&case, &origin()).unwrap();
    let empty = sources
        .validate(
            r#"{"outcome":"insufficient_evidence","claims":[]}"#,
            &origin(),
            Scope::All,
        )
        .unwrap();
    assert!(require_positive_extraction(Some(LoopStop::Eog), &empty)
        .unwrap_err()
        .contains("discarded"));
    for stop in [
        None,
        Some(LoopStop::OutputBudget),
        Some(LoopStop::LegacyDialogueMarker),
        Some(LoopStop::LegacyRepetition),
    ] {
        assert!(require_positive_extraction(stop, &empty)
            .unwrap_err()
            .contains("EOG"));
    }
}
