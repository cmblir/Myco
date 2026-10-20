//! Lossless wire/projection regressions; synthetic inputs do not grade a model.
use super::*;

pub(super) const TYPES: [(&str, &str, &str, &str); 18] = [
    (
        "reported_occurrence_status_unknown",
        "asserted_occurrence",
        "report",
        "unknown",
    ),
    (
        "reported_in_progress",
        "asserted_occurrence",
        "report",
        "in_progress",
    ),
    (
        "reported_completion",
        "asserted_occurrence",
        "report",
        "reported_completed",
    ),
    (
        "reported_failure",
        "asserted_occurrence",
        "report",
        "reported_failed",
    ),
    (
        "reported_cancellation",
        "asserted_occurrence",
        "report",
        "reported_cancelled",
    ),
    (
        "reported_rollback",
        "asserted_occurrence",
        "report",
        "reported_rolled_back",
    ),
    (
        "retraction_status_unknown",
        "asserted_occurrence",
        "retraction",
        "unknown",
    ),
    (
        "retracted_occurrence",
        "asserted_occurrence",
        "retraction",
        "retracted",
    ),
    (
        "retracted_cancellation",
        "asserted_occurrence",
        "retraction",
        "reported_cancelled",
    ),
    (
        "retracted_rollback",
        "asserted_occurrence",
        "retraction",
        "reported_rolled_back",
    ),
    (
        "actor_nonperformance",
        "explicit_nonoccurrence",
        "report",
        "unknown",
    ),
    (
        "requested_status_unknown",
        "intention",
        "request",
        "unknown",
    ),
    ("requested_work", "intention", "request", "requested"),
    ("planned_status_unknown", "intention", "plan", "unknown"),
    ("planned_work", "intention", "plan", "planned"),
    (
        "record_or_verification_limit",
        "record_or_verification_limit",
        "report",
        "unknown",
    ),
    ("unresolved_statement", "uncertain", "unknown", "unknown"),
    ("unresolved_question", "uncertain", "question", "unknown"),
];

fn typed_output(tag: &str) -> Value {
    let mut raw = output("The maintainer repaired the synthetic archive on 2026-10-01.");
    raw["version"] = json!("NativeActivityTypesQaV2");
    let interpretation = raw["units"][0]["interpretations"][0]
        .as_object_mut()
        .unwrap();
    for field in ["assertionKind", "speechAct", "status"] {
        interpretation.remove(field);
    }
    interpretation.insert("activityType".into(), json!(tag));
    raw
}

#[test]
fn activity_actor_ordinal_preserves_captured_subject_reference() {
    let focus = "The maintainer repaired the synthetic archive.";
    let documents = [
        ("Q-ACTIVITY", focus, ActorRole::User),
        (
            "Q-SUBJECT",
            "The referenced maintainer is a third-party source actor.",
            ActorRole::Source,
        ),
    ]
    .into_iter()
    .enumerate()
    .map(|(index, (id, text, speaker))| {
        let path = format!("sessions/actor-reference-{index}.md");
        SourceDocument::bind(
            format!("S-ACTOR-{index}"),
            path.clone(),
            path,
            text,
            Some("2026-10-04".into()),
            vec![SpanInput {
                id: id.into(),
                start: 0,
                end: text.len(),
                turn_id: format!("T{index}"),
                speaker,
                turn_time: None,
            }],
        )
        .unwrap()
    })
    .collect();
    let packet = SourceSet::new(origin(), Scope::Sessions, documents, vec![]).unwrap();
    let anchor_id = packet.spans().next().unwrap().id().to_owned();
    let subject_id = packet.spans().nth(1).unwrap().id().to_owned();
    assert_ne!(anchor_id, subject_id);
    let context = ask_context("actor-ordinal-role");
    let prepared = prepare(&packet, &context);
    let raw = json!({"version":"NativeActivityTypesQaV2","units":[
        {"unitOrdinal":0,"relevance":"relevant","interpretations":[{
            "focusQuote":focus,"supportSpanIds":[anchor_id,subject_id],
            "actor":{"role":"source","basis":"explicit_subject","subjectOrdinal":1},
            "eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},
            "activityType":"reported_completion","verificationId":null
        }]},
        {"unitOrdinal":1,"relevance":"not_relevant","interpretations":[]}
    ]}).to_string();
    let projection = prepared.expand(&raw).unwrap();
    projection.verify_model_result(&raw).unwrap();
    let checked = packet
        .validate(projection.canonical(), &origin(), Scope::Sessions)
        .unwrap();
    assert_eq!(checked.claims.len(), 1);
    let claim = &checked.claims[0];
    assert_eq!(claim.proposal.action, focus);
    assert_eq!(claim.proposal.actor.role, ActorRole::Source);
    assert_eq!(
        claim.proposal.actor.basis,
        crate::wiki_claims::ActorBasis::ExplicitSubject
    );
    assert_eq!(
        claim.proposal.actor.subject_span_id.as_deref(),
        Some(subject_id.as_str())
    );
    assert_eq!(claim.proposal.support_span_ids, vec![anchor_id, subject_id]);
    assert!(claim.semantic_review_required);
    assert!(!projection.semantic_accepted);
}

#[test]
fn activity_type_wire_expands_all_eighteen_triples_without_changing_proposals() {
    let packet = sources(BODY);
    let context = ask_context("role-A");
    let prepared = prepare(&packet, &context);
    for (tag, kind, speech, status) in TYPES {
        let raw = typed_output(tag).to_string();
        let projection = prepared.expand(&raw).unwrap();
        let canonical: Value = serde_json::from_str(projection.canonical()).unwrap();
        let claim = &canonical["claims"][0];
        assert_eq!(claim["speechAct"], speech, "{tag}");
        assert_eq!(claim["status"], status, "{tag}");
        assert_eq!(
            claim["action"],
            "The maintainer repaired the synthetic archive on 2026-10-01."
        );
        let checked = packet
            .validate(projection.canonical(), &origin(), Scope::Sessions)
            .unwrap();
        let sidecar = projection
            .model_review_value(&packet, &checked, context.payload())
            .unwrap();
        assert_eq!(sidecar["claims"][0]["assertionKind"], kind, "{tag}");
        assert_eq!(sidecar["semanticAccepted"], false);
        projection.verify_model_result(&raw).unwrap();
    }
}

#[test]
fn activity_type_wire_rejects_nested_duplicates_extras_and_missing_nullable_keys() {
    let packet = sources(BODY);
    let context = ask_context("role-A");
    let prepared = prepare(&packet, &context);
    let valid = typed_output("reported_completion");
    prepared.expand(&valid.to_string()).unwrap();
    for parent in [
        "",
        "/units/0",
        "/units/0/interpretations/0",
        "/units/0/interpretations/0/actor",
        "/units/0/interpretations/0/eventTime",
    ] {
        let object = valid.pointer(parent).unwrap();
        let object_raw = object.to_string();
        for (key, value) in object.as_object().unwrap() {
            let mut missing = valid.clone();
            missing
                .pointer_mut(parent)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .remove(key);
            assert!(
                prepared.expand(&missing.to_string()).is_err(),
                "missing {parent}/{key}"
            );
            let member = format!("{}:{value}", serde_json::to_string(key).unwrap());
            let duplicated = object_raw.replacen(&member, &format!("{member},{member}"), 1);
            let raw = valid.to_string().replacen(&object_raw, &duplicated, 1);
            let error = prepared.expand(&raw).err().unwrap();
            assert!(error.contains("duplicate field"), "{parent}/{key}: {error}");
        }
        let mut extra = valid.clone();
        extra
            .pointer_mut(parent)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("futureField".into(), json!(null));
        assert!(
            prepared.expand(&extra.to_string()).is_err(),
            "extra {parent}"
        );
    }
    for field in ["assertionKind", "speechAct", "status", "futureField"] {
        let mut extra = valid.clone();
        extra["units"][0]["interpretations"][0][field] = json!("unknown");
        assert!(
            prepared.expand(&extra.to_string()).is_err(),
            "extra {field}"
        );
    }
    let mut legacy_version = valid.clone();
    legacy_version["version"] = json!("NativeSourceInterpretationOrdinalQaV3");
    assert!(prepared.expand(&legacy_version.to_string()).is_err());
    let mut verification = valid;
    verification["units"][0]["interpretations"][0]["verificationId"] = json!("not-a-receipt");
    assert!(prepared
        .expand(&verification.to_string())
        .err()
        .unwrap()
        .contains("verification"));
}

#[test]
fn activity_type_wire_still_reaches_native_actor_date_and_source_guards() {
    let packet = sources(BODY);
    let context = ask_context("role-A");
    let prepared = prepare(&packet, &context);
    let valid = typed_output("reported_completion");
    prepared.expand(&valid.to_string()).unwrap();
    for (pointer, changed, expected) in [
        (
            "/units/0/interpretations/0/actor",
            json!({"role":"assistant","basis":"speaker","subjectOrdinal":null}),
            "claim actor",
        ),
        (
            "/units/0/interpretations/0/actor",
            json!({"role":"source","basis":"explicit_subject","subjectOrdinal":null}),
            "claim actor",
        ),
        (
            "/units/0/interpretations/0/eventTime/value",
            json!("2026-10-02"),
            "explicit date is absent",
        ),
        (
            "/units/0/interpretations/0/eventTime/value",
            json!("2026-13-99"),
            "invalid value or precision",
        ),
        (
            "/units/0/interpretations/0/eventTime",
            json!({"value":"2026-10-01","basis":"inferred_from_turn","precision":"day","uncertainty":"inferred","supportSpanId":"Q-ORIGINAL"}),
            "differs from its original turn time",
        ),
        (
            "/units/0/interpretations/0/supportSpanIds",
            json!(["Q-ABSENT"]),
            "support",
        ),
    ] {
        let mut rejected = valid.clone();
        *rejected.pointer_mut(pointer).unwrap() = changed;
        let error = prepared.expand(&rejected.to_string()).err().unwrap();
        assert!(error.contains(expected), "{pointer}: {error}");
        assert!(!error.contains("unknown field"));
    }
}

#[test]
fn activity_type_focus_keeps_exact_utf8_and_the_512_scalar_boundary() {
    let exact = format!("{}\r\n🚀", "한".repeat(509));
    assert_eq!(exact.chars().count(), 512);
    let packet = sources(&exact);
    let context = ask_context("role-A");
    let prepared = prepare(&packet, &context);
    let mut valid = output(&exact);
    valid["units"][0]["interpretations"][0]["eventTime"] = json!({"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null});
    let projection = prepared.expand(&valid.to_string()).unwrap();
    let canonical: Value = serde_json::from_str(projection.canonical()).unwrap();
    assert_eq!(canonical["claims"][0]["action"], exact);
    let witness = &projection.witnesses[0];
    assert_eq!(witness.start, "선행\n".len());
    assert_eq!(witness.end - witness.start, exact.len());
    assert_eq!(witness.focus_sha256, sha256(exact.as_bytes()));
    let malformed = valid
        .to_string()
        .replace(&serde_json::to_string(&exact).unwrap(), r#""\uD800""#);
    assert!(prepared.expand(&malformed).is_err());
    valid["units"][0]["interpretations"][0]["focusQuote"] = json!("한");
    assert!(
        prepared.expand(&valid.to_string()).is_err(),
        "ambiguous focus cannot bind"
    );
    let grammar = prepared.decoder().grammar();
    assert!(grammar.contains("focus-64{0,7} scalar{1,64}"));
    assert!(!grammar.contains("focus-64{0,31}"));
}

#[test]
fn activity_type_schema_has_distinct_version_grammar_telemetry_and_context_binding() {
    use crate::local_llm::{generation_telemetry::TelemetrySchema, GenerationSchema};
    let packet = sources(BODY);
    let context = ask_context("role-A");
    let prepared = prepare(&packet, &context);
    let schema = GenerationSchema::NativeActivityTypesQaV2(prepared.decoder());
    let core_schema =
        GenerationSchema::NativeSourceInterpretationCandidateQa(prepared.core.count());
    assert_ne!(schema.qa_grammar_sha256(), core_schema.qa_grammar_sha256());
    assert_eq!(
        schema.qa_grammar_sha256(),
        sha256(prepared.decoder().grammar().as_bytes())
    );
    assert_eq!(
        TelemetrySchema::from(Some(schema)),
        TelemetrySchema::NativeActivityTypesQaV2
    );
    assert_eq!(
        serde_json::to_value(TelemetrySchema::from(Some(schema))).unwrap(),
        "nativeActivityTypesQaV2"
    );
    assert_eq!(schema.claim_review_decisions(), None);
    assert!(prepared
        .system()
        .contains("'this message' stays within that message"));
    assert!(!prepared
        .system()
        .contains("Activity compatibility policy (exhaustive):"));
    assert_eq!(
        context.payload()["sourceFocusQaEncoding"],
        "ordinal_activity_v3"
    );
    assert!(prepared
        .core
        .count()
        .grammar()
        .contains("NativeSourceInterpretationOrdinalQaV3"));
    assert!(prepared.core.count().grammar().contains("focus-64{0,31}"));
    assert!(prepared.core.count().grammar().contains("speechAct"));
    let raw = typed_output("reported_completion").to_string();
    let mut projection = prepared.expand(&raw).unwrap();
    let checked = packet
        .validate(projection.canonical(), &origin(), Scope::Sessions)
        .unwrap();
    let mut old_context = context.payload().clone();
    old_context["sourceFocusQaEncoding"] = json!("ordinal_activity_v2");
    assert!(projection
        .model_review_value(&packet, &checked, &old_context)
        .is_err());
    projection.version = "NativeSourceInterpretationOrdinalActivityQaV2";
    assert!(projection
        .model_review_value(&packet, &checked, context.payload())
        .is_err());
}

#[test]
fn activity_type_raw_canonical_and_exact_prompt_changes_invalidate_projection() {
    let packet = sources(BODY);
    let context = ask_context("role-A");
    let prepared = prepare(&packet, &context);
    let raw = typed_output("reported_completion").to_string();
    let pristine = prepared.expand(&raw).unwrap();
    let checked = packet
        .validate(pristine.canonical(), &origin(), Scope::Sessions)
        .unwrap();
    for mutation in 0..5 {
        let mut changed = pristine.clone();
        match mutation {
            0 => changed.generation_system.push(' '),
            1 => changed.generation_user.push(' '),
            2 => changed.canonical.push(' '),
            3 => {
                changed.model_raw = typed_output("reported_occurrence_status_unknown").to_string();
                changed.model_raw_sha256 = sha256(changed.model_raw.as_bytes());
            }
            _ => changed.revision = "0".repeat(64),
        }
        assert!(
            changed
                .model_review_value(&packet, &checked, context.payload())
                .is_err(),
            "mutation {mutation}"
        );
    }
}

#[test]
fn activity_types_preserve_semantic_distinctions_as_unaccepted_proposals() {
    // Fixed synthetic projections demonstrate no loss; a wrong legal tag still
    // needs actual full-original review and can pass structural validation.
    let cases = [
        (
            "The assistant reported completion. Its current status is unknown.",
            "The assistant reported completion.",
            "reported_completion",
        ),
        (
            "The assistant reported an occurrence. Its current status is unknown.",
            "The assistant reported an occurrence.",
            "reported_occurrence_status_unknown",
        ),
        (
            "I did not perform the migration.",
            "I did not perform the migration.",
            "actor_nonperformance",
        ),
        (
            "No migration completion is present in this message.",
            "No migration completion is present in this message.",
            "record_or_verification_limit",
        ),
        (
            "The cancellation was withdrawn. The task later reopened.",
            "The cancellation was withdrawn.",
            "retracted_cancellation",
        ),
    ];
    let context = ask_context("role-A");
    for (body, focus, tag) in cases {
        let packet = sources(body);
        let prepared = prepare(&packet, &context);
        let mut raw = output(focus);
        raw["units"][0]["interpretations"][0]["activityType"] = json!(tag);
        raw["units"][0]["interpretations"][0]["eventTime"] = json!({"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null});
        let projection = prepared.expand(&raw.to_string()).unwrap();
        let checked = packet
            .validate(projection.canonical(), &origin(), Scope::Sessions)
            .unwrap();
        assert_eq!(checked.claims[0].proposal.action, focus);
        let (_, kind, speech, status) = TYPES.iter().find(|(name, _, _, _)| *name == tag).unwrap();
        let canonical: Value = serde_json::from_str(projection.canonical()).unwrap();
        assert_eq!(canonical["claims"][0]["speechAct"], *speech);
        assert_eq!(canonical["claims"][0]["status"], *status);
        let review = projection
            .model_review_value(&packet, &checked, context.payload())
            .unwrap();
        assert_eq!(review["claims"][0]["assertionKind"], *kind);
        assert!(checked.claims[0].semantic_review_required);
        assert!(!projection.semantic_accepted);
        assert!(!projection.production_accepted);
    }
}

#[test]
#[ignore = "requires verified MYCO_CHAT_MODEL_PATH; vocabulary-only model, no context or inference"]
fn activity_type_cached_vocabulary_masks_tags_ordinals_and_scalar_bounds() {
    use llama_cpp_2::llama_backend::LlamaBackend;
    use llama_cpp_2::model::{params::LlamaModelParams, AddBos, LlamaModel};
    use llama_cpp_2::sampling::LlamaSampler;
    use llama_cpp_2::token::{data::LlamaTokenData, data_array::LlamaTokenDataArray, LlamaToken};

    let path = std::path::PathBuf::from(
        std::env::var_os("MYCO_CHAT_MODEL_PATH").expect("verified cached model"),
    );
    assert!(path.is_absolute());
    let verified = crate::local_model::resolve_verified_artifact(
        path.parent().unwrap(),
        &crate::local_model::MODEL,
    )
    .unwrap();
    assert_eq!(
        verified.canonicalize().unwrap(),
        path.canonicalize().unwrap()
    );
    let backend = LlamaBackend::init().unwrap();
    let model = LlamaModel::load_from_file(
        &backend,
        &verified,
        &LlamaModelParams::default()
            .with_vocab_only(true)
            .with_n_gpu_layers(0),
    )
    .unwrap();
    let ends: Vec<_> = (0..model.n_vocab())
        .map(LlamaToken::new)
        .filter(|token| model.is_eog_token(*token))
        .collect();
    assert!(!ends.is_empty());
    let packet = sources(BODY);
    let context = ask_context("vocabulary-only-role");
    let prepared = prepare(&packet, &context);
    let grammar = prepared.decoder().grammar();
    let raw = |tag: &str, focus: &str| {
        format!(
            r#"{{"version":"NativeActivityTypesQaV2","units":[{{"unitOrdinal":0,"relevance":"relevant","interpretations":[{{"focusQuote":{},"supportSpanIds":["Q-ORIGINAL"],"actor":{{"role":"source","basis":"explicit_subject","subjectOrdinal":0}},"eventTime":{{"value":"2026-10-01","basis":"explicit","precision":"day","uncertainty":"specified","supportSpanId":"Q-ORIGINAL"}},"activityType":{},"verificationId":null}}]}}]}}"#,
            json!(focus),
            json!(tag)
        )
    };
    let mut checks = 0;
    let mut check = |text: &str, expected: bool| {
        let mut sampler = LlamaSampler::grammar(&model, &grammar, "root").unwrap();
        let mut rejected = false;
        for token in model.str_to_token(text, AddBos::Never).unwrap() {
            let mut choices =
                LlamaTokenDataArray::new(vec![LlamaTokenData::new(token, 0.0, 0.0)], false);
            sampler.apply(&mut choices);
            if !choices.data[0].logit().is_finite() {
                rejected = true;
                break;
            }
            sampler.accept(token);
        }
        assert!(
            !expected || !rejected,
            "valid activity wire rejected: {text}"
        );
        if !rejected {
            for end in &ends {
                let mut choices =
                    LlamaTokenDataArray::new(vec![LlamaTokenData::new(*end, 0.0, 0.0)], false);
                sampler.apply(&mut choices);
                assert_eq!(
                    choices.data[0].logit().is_finite(),
                    expected,
                    "terminal EOG: {text}"
                );
            }
        }
        checks += 1;
    };
    let focus = "The maintainer repaired the synthetic archive on 2026-10-01.";
    for (tag, _, _, _) in TYPES {
        check(&raw(tag, focus), true);
    }
    for tag in [
        "unknown",
        "reported_completion ",
        "verified_completed",
        "actor_nonperformance_reported_failed",
    ] {
        check(&raw(tag, focus), false);
    }
    let valid = raw("reported_completion", focus);
    for invalid in [
        valid.replace("\"unitOrdinal\":0", "\"unitOrdinal\":1"),
        valid.replace("NativeActivityTypesQaV2", "NativeSourceInterpretationOrdinalQaV3"),
        valid.replace("\"activityType\":\"reported_completion\"", "\"speechAct\":\"report\",\"status\":\"reported_completed\",\"assertionKind\":\"asserted_occurrence\""),
        valid.replace("\"verificationId\":null", "\"verificationId\":null,\"extraField\":null"),
        valid.replace("\"activityType\":\"reported_completion\"", "\"activityType\":\"reported_completion\",\"activityType\":\"reported_completion\""),
    ] { check(&invalid, false); }
    let explicit = r#"{"role":"source","basis":"explicit_subject","subjectOrdinal":0}"#;
    for actor in [
        r#"{"role":"user","basis":"speaker","subjectOrdinal":null}"#,
        r#"{"role":"unknown","basis":"unknown","subjectOrdinal":null}"#,
    ] {
        check(&valid.replace(explicit, actor), true);
    }
    for actor in [
        r#"{"role":"source","basis":"explicit_subject","subjectOrdinal":null}"#,
        r#"{"role":"source","basis":"explicit_subject","subjectOrdinal":"null"}"#,
        r#"{"role":"source","basis":"explicit_subject","subjectOrdinal":"0"}"#,
        r#"{"role":"source","basis":"explicit_subject","subjectOrdinal":-1}"#,
        r#"{"role":"source","basis":"explicit_subject","subjectOrdinal":0.0}"#,
        r#"{"role":"source","basis":"explicit_subject","subjectOrdinal":1}"#,
        r#"{"role":"assistant","basis":"speaker","subjectOrdinal":null}"#,
        r#"{"role":"source","basis":"unknown","subjectOrdinal":null}"#,
        r#"{"role":"unknown","basis":"unknown","subjectOrdinal":0}"#,
        r#"{"role":"user","basis":"speaker","subjectOrdinal":0}"#,
        r#"{"role":"source","basis":"explicit_subject","subjectSpanId":"Q-ORIGINAL"}"#,
        r#"{"role":"source","basis":"explicit_subject"}"#,
        r#"{"role":"source","basis":"explicit_subject","subjectOrdinal":0,"subjectOrdinal":0}"#,
    ] {
        check(&valid.replace(explicit, actor), false);
    }
    check(
        &valid.replace("NativeActivityTypesQaV2", "NativeActivityTypesQaV1"),
        false,
    );
    check(
        &raw(
            "record_or_verification_limit",
            &format!("{}🧪", "가".repeat(511)),
        ),
        true,
    );
    check(
        &raw(
            "record_or_verification_limit",
            &format!("{}🧪", "가".repeat(512)),
        ),
        false,
    );
    assert_eq!(checks, 45);
    println!(
        "{}",
        json!({"phase":"activity_type_vocabulary_only","checks":checks,"modelId":crate::local_model::MODEL.id,"manifestSha256":crate::local_model::MODEL.sha256,"actualEogTokens":ends.len(),"grammarSha256":sha256(grammar.as_bytes()),"vocabOnly":true,"gpuLayers":0,"modelContextCreated":false,"forwardInference":false,"semanticAccepted":false})
    );
}
