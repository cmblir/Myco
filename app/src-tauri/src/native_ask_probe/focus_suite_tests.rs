//! Pure direct-suite controls; no model, native app or private-vault execution.

use super::*;

fn origin() -> AgentVaultSession {
    AgentVaultSession {
        vault_path: "/synthetic/source-focus-suite".into(),
        opening_token: "synthetic-focus-opening".into(),
    }
}

#[test]
fn all_four_cases_reuse_frozen_complete_originals_without_gold_injection() {
    let cases = fixture().unwrap();
    let mut originals = 0;
    for case in &cases {
        let (sources, prepared, mapping) = prepare_case(case, &origin()).unwrap();
        let input: Value = serde_json::from_str(prepared.original_user()).unwrap();
        let augmented: Value = serde_json::from_str(prepared.user()).unwrap();
        assert_eq!(input["question"], case["question"]);
        assert_eq!(input["language"], case["language"]);
        assert_eq!(input["independentVerificationReceipts"], json!([]));
        for field in ["gold", "requiredFacts", "expectedClaims", "source"] {
            assert!(input.get(field).is_none());
            assert!(augmented.get(field).is_none());
        }
        assert_eq!(augmented["originalSpans"], input["originalSpans"]);
        assert_eq!(
            augmented["recordPeriodContext"],
            input["recordPeriodContext"]
        );
        assert_eq!(
            prepared.decoder().packet_sha256(),
            sha(prepared.original_user().as_bytes())
        );
        let expected = case["source"]["turns"].as_array().unwrap();
        assert_eq!(sources.spans().count(), expected.len());
        assert_eq!(prepared.decoder().span_count(), expected.len());
        originals += expected.len();
        for ((span, turn), mapped) in sources
            .spans()
            .zip(expected)
            .zip(mapping.as_array().unwrap())
        {
            assert_eq!(span.text(), turn["text"].as_str().unwrap());
            assert_eq!(span.start() as u64, turn["start"].as_u64().unwrap());
            assert_eq!(span.end() as u64, turn["end"].as_u64().unwrap());
            assert_eq!(span.span_sha256(), turn["sha256"].as_str().unwrap());
            assert_eq!(
                span.source_revision(),
                case["source"]["sha256"].as_str().unwrap()
            );
            assert_eq!(
                serde_json::to_value(span.speaker()).unwrap(),
                turn["speaker"]
            );
            assert_eq!(span.turn_time(), turn["turnTime"].as_str());
            assert_eq!(span.source_phase(), turn["sourcePhase"].as_str());
            assert_eq!(span.id(), mapped["spanId"].as_str().unwrap());
        }
    }
    assert_eq!((cases.len(), originals), (4, 9));
    assert_eq!(cases[3]["source"]["turns"].as_array().unwrap().len(), 3);
}

#[test]
fn absent_host_records_every_case_once_without_decoder_or_semantic_success() {
    let mut counts = Counts::default();
    for case in fixture().unwrap() {
        let observed = observe_case(
            &case,
            &origin(),
            None,
            Some("synthetic host unavailable"),
            &MODEL,
            false,
            &mut counts,
        );
        assert_eq!(observed["attemptOrdinal"], 1);
        assert_eq!(observed["retryCount"], 0);
        assert_eq!(observed["model"]["id"], MODEL.id);
        assert_eq!(observed["modelIdExplicit"], false);
        assert_eq!(observed["failureStage"], "model_setup");
        assert_eq!(observed["error"], "synthetic host unavailable");
        assert_eq!(observed["decoderAttemptStarted"], false);
        assert_eq!(observed["decoderAttemptObserved"], false);
        assert_eq!(observed["nativeStructureValid"], false);
        assert_eq!(observed["completePositiveExtraction"], false);
        assert_eq!(observed["sourceSetValidation"]["status"], "not_run");
        assert_eq!(observed["automatedSemanticReview"], "not_run");
        assert_eq!(observed["answerGeneration"], "not_run");
        assert_eq!(observed["finalAnswerReview"], "not_run");
        for field in [
            "nativeIoAuthenticated",
            "productRoleAuthorized",
            "semanticAccepted",
            "productionAccepted",
            "installedAcceptance",
            "modelAdoption",
        ] {
            assert_eq!(observed[field], false);
        }
        assert!(observed.get("originalUserSha256").is_some());
        assert!(observed.get("grammarSha256").is_some());
        assert!(observed.get("rawSourceFocus").is_none());
        assert!(observed.get("expandedNative").is_none());
    }
    assert_eq!(
        (
            counts.observed,
            counts.attempts_started,
            counts.attempts_observed
        ),
        (4, 0, 0)
    );
    assert_eq!(
        (
            counts.native_structure_valid,
            counts.complete_positive_cases
        ),
        (0, 0)
    );
    assert_eq!(counts.failures.len(), 4);
    assert!(!counts.host_created && !counts.host_drop_completed);
}

#[test]
fn malformed_original_is_preserved_as_preparation_failure_before_model_setup() {
    let mut case = fixture().unwrap().remove(0);
    case["source"]["original"] = json!("A changed synthetic original");
    let mut counts = Counts::default();
    let observed = observe_case(
        &case,
        &origin(),
        None,
        Some("unused host failure"),
        &MODEL,
        false,
        &mut counts,
    );
    assert_eq!(observed["failureStage"], "source_preparation");
    assert_eq!(observed["decoderAttemptStarted"], false);
    assert_eq!(observed["decoderAttemptObserved"], false);
    assert!(observed["error"].as_str().unwrap().contains("SHA"));
    assert_eq!(
        (
            counts.observed,
            counts.attempts_started,
            counts.attempts_observed
        ),
        (1, 0, 0)
    );
    assert_eq!(counts.failures.len(), 1);
}

#[test]
fn clean_eog_empty_and_non_eog_outputs_are_not_positive_extraction_success() {
    let case = fixture().unwrap().remove(0);
    let (sources, prepared, _) = prepare_case(&case, &origin()).unwrap();
    let empty = sources
        .validate(
            r#"{"outcome":"insufficient_evidence","claims":[]}"#,
            &origin(),
            Scope::All,
        )
        .unwrap();
    assert!(
        require_positive_extraction(Some(LoopStop::Eog), Some(0), &empty)
            .unwrap_err()
            .contains("discarded")
    );

    // Exact source projection and structure only; no coverage or meaning grade.
    let raw = json!({"version":"WikiSourceFocusClaimsQaV1",
        "packetSha256":prepared.decoder().packet_sha256(),"outcome":"claims",
        "claims":[[0,"Please repair the synthetic prism exporter.","intention",[0],
            ["user","speaker",null],[null,"unknown","unknown","unknown",null],
            "request","requested",null]]});
    let projection = prepared.expand(&raw.to_string()).unwrap();
    let positive = sources
        .validate(projection.canonical(), &origin(), Scope::All)
        .unwrap();
    assert!(require_positive_extraction(Some(LoopStop::Eog), Some(0), &positive).is_ok());
    for stop in [
        None,
        Some(LoopStop::OutputBudget),
        Some(LoopStop::LegacyDialogueMarker),
        Some(LoopStop::LegacyRepetition),
    ] {
        assert!(require_positive_extraction(stop, Some(0), &positive)
            .unwrap_err()
            .contains("EOG"));
    }
    for tail in [None, Some(1), Some(2)] {
        assert!(
            require_positive_extraction(Some(LoopStop::Eog), tail, &positive)
                .unwrap_err()
                .contains("UTF-8")
        );
    }
}

#[test]
fn relative_control_path_fails_before_profile_host_or_observations() {
    let mut counts = Counts::default();
    let error = execute(PathBuf::from("relative.gguf"), &MODEL, false, &mut counts).unwrap_err();
    assert!(error.contains("absolute"));
    assert_eq!((counts.observed, counts.attempts_started), (0, 0));
    assert!(!counts.host_created && !counts.host_drop_completed);
}

#[test]
fn model_selection_whitelists_only_default_qwen_and_explicit_pinned_gemma() {
    let environment = (
        std::env::var_os("MYCO_DATA_DIR"),
        std::env::var_os("MEMEX_DATA_DIR"),
    );
    assert_eq!(selected_manifest(None).unwrap().id, MODEL.id);
    for manifest in [&MODEL, &GEMMA_CANDIDATE] {
        let selected = selected_manifest(Some(manifest.id)).unwrap();
        assert_eq!(selected.id, manifest.id);
        assert_eq!(selected.file, manifest.file);
        assert_eq!(selected.sha256, manifest.sha256);
        assert_eq!(selected.bytes, manifest.bytes);
    }
    for id in [
        "",
        "qwen",
        "gemma",
        crate::local_model::SMALL_MODEL.id,
        "gemma-4-e4b-it-qat-q4_0 ",
    ] {
        assert!(selected_manifest(Some(id))
            .unwrap_err()
            .contains("unsupported"));
    }
    assert_eq!(
        environment,
        (
            std::env::var_os("MYCO_DATA_DIR"),
            std::env::var_os("MEMEX_DATA_DIR"),
        )
    );
}

#[test]
fn wrong_manifest_size_fails_before_environment_profile_host_or_observations() {
    let directory = tempfile::tempdir().unwrap();
    let environment = (
        std::env::var_os("MYCO_DATA_DIR"),
        std::env::var_os("MEMEX_DATA_DIR"),
    );
    for (control_manifest, selected) in [(&MODEL, &GEMMA_CANDIDATE), (&GEMMA_CANDIDATE, &MODEL)] {
        let path = directory.path().join(control_manifest.file);
        // Sparse synthetic metadata only; no real weights or model execution.
        std::fs::File::create(&path)
            .unwrap()
            .set_len(control_manifest.bytes)
            .unwrap();
        let mut counts = Counts::default();
        let error = execute(path, selected, true, &mut counts).unwrap_err();
        assert!(error.contains("selected manifest"));
        assert_eq!((counts.observed, counts.attempts_started), (0, 0));
        assert!(!counts.host_created && !counts.host_drop_completed);
        assert_eq!(
            environment,
            (
                std::env::var_os("MYCO_DATA_DIR"),
                std::env::var_os("MEMEX_DATA_DIR"),
            )
        );
    }
}

#[test]
fn missing_control_fails_before_environment_profile_host_or_observations() {
    let directory = tempfile::tempdir().unwrap();
    let environment = (
        std::env::var_os("MYCO_DATA_DIR"),
        std::env::var_os("MEMEX_DATA_DIR"),
    );
    let mut counts = Counts::default();
    assert!(execute(
        directory.path().join("missing.gguf"),
        &GEMMA_CANDIDATE,
        true,
        &mut counts
    )
    .is_err());
    assert_eq!((counts.observed, counts.attempts_started), (0, 0));
    assert!(!counts.host_created && !counts.host_drop_completed);
    assert_eq!(
        environment,
        (
            std::env::var_os("MYCO_DATA_DIR"),
            std::env::var_os("MEMEX_DATA_DIR"),
        )
    );
}

#[test]
fn absent_gemma_host_records_explicit_selected_manifest_without_qwen_fallback() {
    let mut counts = Counts::default();
    for case in fixture().unwrap() {
        let observed = observe_case(
            &case,
            &origin(),
            None,
            Some("synthetic Gemma host unavailable"),
            &GEMMA_CANDIDATE,
            true,
            &mut counts,
        );
        assert_eq!(observed["model"]["id"], GEMMA_CANDIDATE.id);
        assert_eq!(observed["model"]["sha256"], GEMMA_CANDIDATE.sha256);
        assert_eq!(observed["modelIdExplicit"], true);
        assert_eq!(observed["failureStage"], "model_setup");
        assert_eq!(observed["decoderAttemptStarted"], false);
        assert_eq!(
            observed["sampler"],
            serde_json::to_value(WikiClaimsSamplerQaProfile::ExistingGroundedV1.qa_parameters())
                .unwrap()
        );
        assert_eq!(observed["contextTokens"], 4096);
        assert_eq!(observed["outputTokens"], 768);
        assert_eq!(observed["safetyReserveTokens"], 8);
        assert_eq!(observed["retryCount"], 0);
        assert_eq!(observed["semanticAccepted"], false);
        assert_eq!(observed["productRoleAuthorized"], false);
    }
    assert_eq!(
        (
            counts.observed,
            counts.attempts_started,
            counts.attempts_observed
        ),
        (4, 0, 0)
    );
    assert_eq!(counts.failures.len(), 4);
    assert!(!counts.host_created && !counts.host_drop_completed);
}
