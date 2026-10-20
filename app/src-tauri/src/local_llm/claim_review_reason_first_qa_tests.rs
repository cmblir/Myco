use super::*;
use crate::wiki_claim_review;
use serde_json::{json, Value};
use std::sync::atomic::AtomicBool;

fn reason_first_output(ids: &[String], disposition: &str, coverage: &str, reason: &str) -> String {
    let reason = serde_json::to_string(reason).unwrap();
    let decisions = ids
        .iter()
        .map(|id| format!(r#"{{"id":"{id}","reason":{reason},"disposition":"{disposition}"}}"#))
        .collect::<Vec<_>>();
    let missing = if coverage == "missing" { r#""Q0""# } else { "" };
    format!(
        r#"{{"version":"WikiClaimReviewV1","claims":[{}],"sourceCoverage":"{coverage}","missingSpanIds":[{missing}]}}"#,
        decisions.join(",")
    )
}

#[test]
fn reason_first_qa_preserves_app_issued_decision_count_without_new_ids() {
    for count in [0, 1, 2, 16] {
        let issued = ReviewDecisions::new(count).unwrap();
        for schema in [
            GenerationSchema::WikiClaimReviewV1(issued),
            GenerationSchema::WikiClaimReviewReasonFirstQaV1(issued),
        ] {
            assert_eq!(schema.claim_review_decisions(), Some(issued));
            assert_eq!(schema.claim_review_decisions().unwrap().count(), count);
        }
    }
    assert!(ReviewDecisions::new(17).is_err());
    for schema in [
        GenerationSchema::AskAnswerV1,
        GenerationSchema::WikiClaimsV1,
        GenerationSchema::AskAnswerReviewV1,
        GenerationSchema::SessionCompilationV1,
        GenerationSchema::SessionStructureV1,
        GenerationSchema::SessionReviewV1,
    ] {
        assert_eq!(schema.claim_review_decisions(), None);
    }
}

#[test]
fn reason_first_qa_retains_review_telemetry_and_exact_existing_budget() {
    let schema = GenerationSchema::WikiClaimReviewReasonFirstQaV1(ReviewDecisions::new(2).unwrap());
    let attempt =
        Recorder::new(Some(schema), 768, 4096).finish(Err("Synthetic accounting only.".into()));
    let observed = serde_json::to_value(attempt.telemetry()).unwrap();
    assert_eq!(observed["schema"], "wikiClaimReviewV1");
    assert_eq!(observed["profile"], "existingGroundedV1");
    assert_eq!(observed["requestedOutputTokens"], 768);
    assert_eq!(observed["requestedContextTokens"], 4096);
    assert!(validate_generation_budget(3320, 768, 4096, Some(schema)).is_ok());
    assert!(validate_generation_budget(3321, 768, 4096, Some(schema)).is_err());
    assert!(validate_generation_budget(0, 768, 4096, Some(schema)).is_err());
    assert!(validate_generation_budget(1, 769, 4096, Some(schema)).is_err());
    assert!(validate_generation_budget(1, 768, 8192, Some(schema)).is_err());
}

#[test]
fn reason_first_qa_rejects_limits_and_cancellation_before_loading_weights() {
    let host = LocalLlm::load_embed_host().unwrap();
    let schema = GenerationSchema::WikiClaimReviewReasonFirstQaV1(ReviewDecisions::new(1).unwrap());
    for (output, context) in [(0, 4096), (769, 4096), (768, 8192)] {
        let error = host
            .generate_structured_cancellable(
                "Policy",
                "Synthetic original",
                output,
                context,
                schema,
                &AtomicBool::new(false),
            )
            .unwrap_err();
        assert!(error.contains("invalid generation limits"), "{error}");
        assert!(!host.chat_model_loaded());
    }
    let attempt = host.generate_structured_cancellable_measured(
        "Policy",
        "Synthetic original",
        768,
        4096,
        schema,
        &AtomicBool::new(true),
    );
    assert_eq!(
        serde_json::to_value(attempt.telemetry()).unwrap()["terminal"],
        "cancelled"
    );
    assert!(attempt.into_result().unwrap_err().contains("cancelled"));
    assert!(!host.chat_model_loaded());
}

#[test]
fn reason_first_qa_native_review_parses_same_fields_and_preserves_rejection() {
    // Mocked dispositions prove native parser/receipt plumbing, not model meaning.
    let (packet, original, context) = wiki_claim_review::tests::fixture();
    for count in [0, 1, 2, 16] {
        let mut claims = original.clone();
        claims.claims = vec![original.claims[0].clone(); count];
        claims.outcome = if count == 0 {
            crate::wiki_claims::ClaimOutcome::InsufficientEvidence
        } else {
            crate::wiki_claims::ClaimOutcome::Claims
        };
        let review = wiki_claim_review::run(
            &context,
            &packet,
            &claims,
            |_, _| Ok(1000),
            |_, user, output, tokens, issued| {
                let schema = GenerationSchema::WikiClaimReviewReasonFirstQaV1(issued);
                assert_eq!(schema.claim_review_decisions().unwrap().count(), count);
                assert_eq!((output, tokens), (768, 4096));
                let input: Value = serde_json::from_str(user).unwrap();
                let ids = input["requiredClaimIds"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|id| id.as_str().unwrap().to_owned())
                    .collect::<Vec<_>>();
                Ok(reason_first_output(
                    &ids,
                    "supported",
                    "covered",
                    "Explicitly mocked verdict.",
                ))
            },
        )
        .unwrap();
        assert!(review.require_accepted().is_ok());
        assert!(review.binds(&context, &packet, &claims));
    }
    for (disposition, coverage, code) in [
        ("unsupported", "covered", "review_rejected"),
        ("uncertain", "covered", "review_uncertain"),
        ("supported", "missing", "review_missing"),
    ] {
        let review = wiki_claim_review::run(
            &context,
            &packet,
            &original,
            |_, _| Ok(1000),
            |_, _, _, _, _| {
                Ok(reason_first_output(
                    &["C0".into()],
                    disposition,
                    coverage,
                    "Explicitly mocked verdict.",
                ))
            },
        )
        .unwrap();
        assert_eq!(review.require_accepted().unwrap_err().code(), code);
    }
}

#[test]
fn reason_first_qa_order_does_not_weaken_native_ids_reason_or_coverage_checks() {
    let (packet, claims, context) = wiki_claim_review::tests::fixture();
    for mutation in 0..7 {
        let error = wiki_claim_review::run(
            &context,
            &packet,
            &claims,
            |_, _| Ok(1000),
            |_, _, _, _, _| {
                let mut output: Value = serde_json::from_str(&reason_first_output(
                    &["C0".into()],
                    "supported",
                    "covered",
                    "Explicitly mocked verdict.",
                ))
                .unwrap();
                match mutation {
                    0 => output["claims"][0]["id"] = json!("C99"),
                    1 => output["claims"][0]["reason"] = json!(""),
                    2 => output["claims"][0]["reason"] = json!("x".repeat(129)),
                    3 => output["missingSpanIds"] = json!(["Q0"]),
                    4 => {
                        output["sourceCoverage"] = json!("missing");
                        output["missingSpanIds"] = json!(["unselected"]);
                    }
                    5 => output["claims"][0]["reason"] = json!("forged\u{0000}control"),
                    _ => output["productionAccepted"] = json!(true),
                }
                Ok(output.to_string())
            },
        )
        .unwrap_err();
        assert_eq!(error.code(), "review_invalid", "mutation {mutation}");
    }
}

#[test]
fn reason_first_qa_structured_output_keeps_repeated_reasons_and_negative_text() {
    let schema = GenerationSchema::WikiClaimReviewReasonFirstQaV1(ReviewDecisions::new(3).unwrap());
    let ids = vec!["C0".into(), "C1".into(), "C2".into()];
    let original = reason_first_output(
        &ids,
        "uncertain",
        "uncertain",
        "Completion was not verified. Repeated references do not prove completion.",
    );
    let expected: Value = serde_json::from_str(&original).unwrap();
    let mut assembled = String::new();
    for character in original.chars() {
        assembled.push(character);
        assert!(output_guard::apply_with_reason(&mut assembled, Some(schema)).is_none());
    }
    assert_eq!(assembled, original);
    assert_eq!(serde_json::from_str::<Value>(&assembled).unwrap(), expected);
}

#[test]
#[ignore = "requires verified GGUF via MYCO_CHAT_MODEL_PATH; vocabulary masking only, no inference"]
fn reason_first_qa_sampler_changes_only_field_order_and_retains_closed_bounds() {
    let path =
        PathBuf::from(std::env::var_os("MYCO_CHAT_MODEL_PATH").expect("verified GGUF is required"));
    let mut host = LocalLlm::load_embed_host().unwrap();
    host.ensure_chat_model(&path).unwrap();
    let model = host.chat_model().unwrap();
    for count in [0, 1, 2, 16] {
        let issued = ReviewDecisions::new(count).unwrap();
        let control = GenerationSchema::WikiClaimReviewV1(issued).grammar();
        let treatment = GenerationSchema::WikiClaimReviewReasonFirstQaV1(issued).grammar();
        let ids = (0..count)
            .map(|index| format!("C{index}"))
            .collect::<Vec<_>>();
        for disposition in ["supported", "unsupported", "uncertain"] {
            for coverage in ["covered", "missing", "uncertain"] {
                let reason = "Synthetic reason: \"미확인\" \\ path";
                let baseline = review_output(&ids, disposition, coverage, reason);
                let candidate = reason_first_output(&ids, disposition, coverage, reason);
                assert_eq!(
                    serde_json::from_str::<Value>(&baseline).unwrap(),
                    serde_json::from_str::<Value>(&candidate).unwrap()
                );
                assert!(vocabulary_accepts(model, &control, &baseline));
                assert!(vocabulary_accepts(model, &treatment, &candidate));
                assert!(!vocabulary_accepts(model, &control, &candidate));
                assert!(!vocabulary_accepts(model, &treatment, &baseline));
            }
        }
        if count > 0 {
            assert!(!vocabulary_accepts(
                model,
                &treatment,
                &reason_first_output(
                    &ids[..count - 1],
                    "uncertain",
                    "uncertain",
                    "Synthetic missing decision."
                )
            ));
        }
        let mut extra = ids.clone();
        extra.push(format!("C{count}"));
        assert!(!vocabulary_accepts(
            model,
            &treatment,
            &reason_first_output(
                &extra,
                "uncertain",
                "uncertain",
                "Synthetic extra decision."
            )
        ));
    }
    let treatment =
        GenerationSchema::WikiClaimReviewReasonFirstQaV1(ReviewDecisions::new(2).unwrap())
            .grammar();
    for ids in [["C0", "C0"], ["C1", "C0"], ["C0", "C2"], ["C0", "forged"]] {
        assert!(!vocabulary_accepts(
            model,
            &treatment,
            &reason_first_output(
                &ids.into_iter().map(str::to_owned).collect::<Vec<_>>(),
                "uncertain",
                "uncertain",
                "Synthetic invalid decision IDs."
            )
        ));
    }
    let single = GenerationSchema::WikiClaimReviewReasonFirstQaV1(ReviewDecisions::new(1).unwrap())
        .grammar();
    let ids = vec!["C0".to_owned()];
    assert!(vocabulary_accepts(
        model,
        &single,
        &reason_first_output(&ids, "uncertain", "uncertain", &"x".repeat(128))
    ));
    for reason in [String::new(), "x".repeat(129)] {
        assert!(!vocabulary_accepts(
            model,
            &single,
            &reason_first_output(&ids, "uncertain", "uncertain", &reason)
        ));
    }
    for (disposition, coverage) in [("accepted", "covered"), ("supported", "complete")] {
        assert!(!vocabulary_accepts(
            model,
            &single,
            &reason_first_output(&ids, disposition, coverage, "Synthetic unknown enum.")
        ));
    }
    let complete = reason_first_output(&ids, "uncertain", "uncertain", "Synthetic closure.");
    for token in (0..model.n_vocab())
        .map(llama_cpp_2::token::LlamaToken::new)
        .filter(|token| model.is_eog_token(*token))
    {
        assert!(vocabulary_accepts_terminated_by(
            model, &single, &complete, token
        ));
        assert!(!vocabulary_accepts_terminated_by(
            model,
            &single,
            complete.strip_suffix('}').unwrap(),
            token
        ));
        assert!(!vocabulary_accepts_terminated_by(
            model,
            &single,
            r#"{"version":"WikiClaimReviewV1","claims":["#,
            token
        ));
    }
}

#[test]
fn reason_first_qa_grammar_digest_binds_closed_schema_and_issued_count() {
    // A fingerprint is QA provenance only; masking and meaning need other tests.
    for count in [0, 1, 2, 16] {
        let issued = ReviewDecisions::new(count).unwrap();
        let control = GenerationSchema::WikiClaimReviewV1(issued);
        let candidate = GenerationSchema::WikiClaimReviewReasonFirstQaV1(issued);
        let control_digest = control.qa_grammar_sha256();
        let candidate_digest = candidate.qa_grammar_sha256();
        assert_ne!(control_digest, candidate_digest);
        assert_eq!(candidate.qa_grammar_sha256(), candidate_digest);
        for digest in [control_digest, candidate_digest] {
            assert_eq!(digest.len(), 64);
            assert!(digest.bytes().all(|byte| byte.is_ascii_hexdigit()));
        }
    }
    let one = GenerationSchema::WikiClaimReviewReasonFirstQaV1(ReviewDecisions::new(1).unwrap());
    let two = GenerationSchema::WikiClaimReviewReasonFirstQaV1(ReviewDecisions::new(2).unwrap());
    assert_ne!(one.qa_grammar_sha256(), two.qa_grammar_sha256());
}
