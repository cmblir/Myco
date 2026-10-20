use super::*;
use crate::original_contract::{hash, model, sampler};
use myco_lib::local_model::{GEMMA_CANDIDATE, MODEL};
use myco_lib::wiki_claims::{ActorRole, SourceDocument, SpanInput};
use serde_json::{json, Value};

const PAGE: &str = "sessions/2026-10/synthetic-native-synthetic-dev-actor-event-date.md";
const ORIGINAL: &str = include_str!("../../eval/local-wiki-native-activity-development-v1/corpus/sessions/2026-10/synthetic-native-synthetic-dev-actor-event-date.fixture");

fn key(prefix: &str, identity: &str) -> String {
    format!("{prefix}-{}", &hash(identity.as_bytes())[..32])
}

fn source() -> SourceDocument {
    let start = ORIGINAL.find("The maintainer repaired").unwrap();
    let middle = ORIGINAL.find("**Assistant:**\n").unwrap();
    let last = middle + "**Assistant:**\n".len();
    SourceDocument::bind(
        key("S", PAGE),
        PAGE.into(),
        PAGE.into(),
        ORIGINAL,
        Some("2026-10-04T09:00:00Z".into()),
        vec![
            SpanInput {
                id: key("Q", &format!("{PAGE}:{start}:{middle}")),
                start,
                end: middle,
                turn_id: key("T", "D3A"),
                speaker: ActorRole::User,
                turn_time: Some("2026-10-03T10:00:00Z".into()),
            },
            SpanInput {
                id: key("Q", &format!("{PAGE}:{last}:{}", ORIGINAL.len())),
                start: last,
                end: ORIGINAL.len(),
                turn_id: key("T", "D3B"),
                speaker: ActorRole::Assistant,
                turn_time: Some("2026-10-04T08:00:00Z".into()),
            },
        ],
    )
    .unwrap()
}

fn user() -> Value {
    let source = serde_json::to_value(source()).unwrap();
    let spans = source["spans"].as_array().unwrap();
    json!({
        "question":"내가 최근에 한 일들에 대해서 정리해줘",
        "language":"ko",
        "activityPeriod":{"start":"2026-10-01","end":"2026-10-04",
            "startEpoch":1790780400i64,"endEpoch":1791126000i64},
        "allowedSpanIds":spans.iter().map(|span|span["id"].clone()).collect::<Vec<_>>(),
        "originalSpans":spans,
        "independentVerificationReceipts":[],
    })
}

fn packet(id: &str) -> Value {
    let system = "Exact retained SYSTEM\n";
    let user = user().to_string();
    json!({
        "version":1,"dataScope":"synthetic-native-activity-development",
        "source":{"recordSha256":"a".repeat(64),"buildReceiptSha256":"b".repeat(64),
            "sourceReceiptSha256":"c".repeat(64),"observationOrdinal":2,
            "requestId":"native-activity-recent_work-answer"},
        "model":model(id).unwrap(),"runtime":execution_runtime().runtime,"sampler":sampler(),
        "system":system,"systemSha256":hash(system.as_bytes()),
        "user":user,"userSha256":hash(user.as_bytes()),
        "contextTokens":4096,"originalOutputTokens":768,"originalPromptTokens":2213,
        "originalSchema":"wikiClaimsV1","originalLoopStop":"outputBudget",
    })
}

fn parse_value(value: &Value, id: &str) -> Result<ParsedPackage, String> {
    let bytes = serde_json::to_vec(value).unwrap();
    let original = serde_json::from_value(value["runtime"].clone()).unwrap();
    parse_package(&bytes, &hash(&bytes), id, &original)
}

fn with_user(mut value: Value, user: Value) -> Value {
    let text = user.to_string();
    value["userSha256"] = json!(hash(text.as_bytes()));
    value["user"] = json!(text);
    value
}

fn registration(id: &str, packet_sha: &str) -> Value {
    json!({
        "version":1,"treatment":"quote-first-contract","originalPacketSha256":packet_sha,
        "originalInputProvenanceReceiptSha256":"a".repeat(64),
        "originalRuntime":execution_runtime().runtime,"executionRuntime":execution_runtime(),
        "executionSourceReceiptSha256":"b".repeat(64),
        "executionBuildReceiptSha256":"c".repeat(64),"executionBinarySha256":"d".repeat(64),
        "approvedSourceDeltaReceiptSha256":"e".repeat(64),
        "arms":ARMS,"armIds":["synthetic-baseline","synthetic-quoted"],
        "outputTokens":1536,"contextTokens":4096,"modelId":id,
    })
}

fn parse_registration_value(
    value: &Value,
    packet_sha: &str,
    id: &str,
) -> Result<Registration, String> {
    let bytes = serde_json::to_vec(value).unwrap();
    parse_registration(&bytes, &hash(&bytes), packet_sha, id)
}

fn interpretation_registration(id: &str, packet_sha: &str) -> Value {
    let mut value = registration(id, packet_sha);
    value["treatment"] = json!("quoted-occurrence-time-system");
    value["arms"] = json!(["quoted_control", "quoted_interpretation"]);
    value["executionRuntime"]["candidateSystemSha256"] = json!(hash(
        myco_lib::wiki_claims::quoted_qa::occurrence_time_qa_system().as_bytes()
    ));
    value
}

#[test]
fn interpretation_registration_admits_both_models_with_the_same_quoted_contract() {
    for id in [MODEL.id, GEMMA_CANDIDATE.id] {
        let packet_sha = "f".repeat(64);
        let value = interpretation_registration(id, &packet_sha);
        let parsed = parse_registration_value(&value, &packet_sha, id)
            .expect("registered interpretation pair");
        assert_eq!(parsed.arms, ["quoted_control", "quoted_interpretation"]);
        assert_eq!(
            parsed.execution_runtime.quote_grammar_sha256,
            execution_runtime().quote_grammar_sha256
        );
        assert_ne!(
            parsed.execution_runtime.candidate_system_sha256,
            execution_runtime().candidate_system_sha256
        );
    }
}

#[test]
fn interpretation_registration_rejects_crossed_pairs_and_unregistered_systems() {
    let packet_sha = "f".repeat(64);
    for (key, replacement) in [
        ("treatment", json!("unregistered-interpretation")),
        ("arms", json!(["baseline", "quoted"])),
        ("arms", json!(["quoted_interpretation", "quoted_control"])),
        ("arms", json!(["quoted_control", "unregistered"])),
    ] {
        let mut value = interpretation_registration(MODEL.id, &packet_sha);
        value[key] = replacement;
        assert!(parse_registration_value(&value, &packet_sha, MODEL.id).is_err());
    }
    for replacement in [
        json!(execution_runtime().candidate_system_sha256),
        json!("a".repeat(64)),
        Value::Null,
    ] {
        let mut value = interpretation_registration(MODEL.id, &packet_sha);
        value["executionRuntime"]["candidateSystemSha256"] = replacement;
        assert!(parse_registration_value(&value, &packet_sha, MODEL.id).is_err());
    }
    let mut value = registration(MODEL.id, &packet_sha);
    value["arms"] = json!(["quoted_control", "quoted_interpretation"]);
    assert!(parse_registration_value(&value, &packet_sha, MODEL.id).is_err());
}

fn args() -> Vec<String> {
    [
        "--model-dir",
        "/synthetic/models",
        "--model-id",
        MODEL.id,
        "--packet",
        "/synthetic/packet.json",
        "--packet-sha256",
        &"a".repeat(64),
        "--registration",
        "/synthetic/registration.json",
        "--registration-sha256",
        &"b".repeat(64),
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

#[test]
fn closed_cli_requires_every_registered_argument_and_preserves_paths() {
    let parsed = options(args()).expect("valid closed quote replay CLI");
    assert_eq!(parsed.model_dir, PathBuf::from("/synthetic/models"));
    assert_eq!(parsed.model_id, MODEL.id);
    assert_eq!(parsed.packet_path, PathBuf::from("/synthetic/packet.json"));
    assert_eq!(parsed.packet_sha256, "a".repeat(64));
    assert_eq!(
        parsed.registration_path,
        PathBuf::from("/synthetic/registration.json")
    );
    assert_eq!(parsed.registration_sha256, "b".repeat(64));
    for index in (0..args().len()).step_by(2) {
        let mut missing = args();
        missing.drain(index..index + 2);
        assert!(options(missing).is_err());
    }
}

#[test]
fn closed_cli_rejects_overrides_duplicates_and_implicit_models() {
    for flag in [
        "--system",
        "--sampler",
        "--gold",
        "--output-tokens",
        "--profile",
    ] {
        let mut changed = args();
        changed.extend([flag.into(), "changed".into()]);
        assert!(options(changed).is_err());
    }
    let mut duplicate = args();
    duplicate.extend(["--model-id".into(), MODEL.id.into()]);
    assert!(options(duplicate).is_err());
    for id in ["", "qwen", "gemma", "qwen3.5-2b-q4_k_m"] {
        let mut changed = args();
        changed[3] = id.into();
        assert!(options(changed).is_err());
    }
}

#[test]
fn registration_admits_both_pinned_models_without_relabeling_original_runtime() {
    for id in [MODEL.id, GEMMA_CANDIDATE.id] {
        let packet_sha = "f".repeat(64);
        let mut value = registration(id, &packet_sha);
        value["originalRuntime"]["decoderSourceSha256"] = json!("9".repeat(64));
        let parsed = parse_registration_value(&value, &packet_sha, id).unwrap();
        assert_eq!(
            parsed.original_runtime.decoder_source_sha256,
            "9".repeat(64)
        );
        assert_ne!(parsed.original_runtime, parsed.execution_runtime.runtime);
        assert_eq!(parsed.arm_ids, ["synthetic-baseline", "synthetic-quoted"]);
    }
}

#[test]
fn registration_rejects_wrong_treatment_budgets_arms_model_receipts_and_extra_keys() {
    let packet_sha = "f".repeat(64);
    for (field, changed) in [
        ("version", json!(2)),
        ("treatment", json!("presence-only")),
        ("originalPacketSha256", json!("a".repeat(64))),
        ("outputTokens", json!(768)),
        ("contextTokens", json!(2048)),
        ("arms", json!(["quoted", "baseline"])),
        ("armIds", json!(["same", "same"])),
        ("modelId", json!(GEMMA_CANDIDATE.id)),
        ("executionBinarySha256", json!("invalid")),
        ("gold", json!([])),
    ] {
        let mut value = registration(MODEL.id, &packet_sha);
        value[field] = changed;
        assert!(
            parse_registration_value(&value, &packet_sha, MODEL.id).is_err(),
            "accepted {field}"
        );
    }
}

#[test]
fn registration_rejects_all_changed_compiled_pins_and_incompatible_history() {
    let packet_sha = "f".repeat(64);
    for field in [
        "telemetrySourceSha256",
        "samplerSourceSha256",
        "quoteModuleSha256",
        "quoteGrammarSha256",
        "candidateSystemSha256",
    ] {
        let mut value = registration(MODEL.id, &packet_sha);
        value["executionRuntime"][field] = json!("f".repeat(64));
        assert!(
            parse_registration_value(&value, &packet_sha, MODEL.id).is_err(),
            "accepted {field}"
        );
    }
    for field in [
        "cargoLockSha256",
        "gemmaTemplateSourceSha256",
        "grammarSha256",
    ] {
        let mut value = registration(MODEL.id, &packet_sha);
        value["originalRuntime"][field] = json!("f".repeat(64));
        assert!(parse_registration_value(&value, &packet_sha, MODEL.id).is_err());
    }
}

#[test]
fn package_preserves_every_compiled_original_span_field_and_exact_messages() {
    for id in [MODEL.id, GEMMA_CANDIDATE.id] {
        let value = packet(id);
        let parsed = parse_value(&value, id).unwrap();
        assert_eq!(parsed.packet.system, value["system"].as_str().unwrap());
        assert_eq!(parsed.packet.user, value["user"].as_str().unwrap());
        assert_eq!(parsed.scope, Scope::Sessions);
        assert_eq!(parsed.origin.vault_path, "/synthetic/quoted-packet-qa");
        let original = user()["originalSpans"].as_array().unwrap().clone();
        let bound: Vec<_> = parsed
            .sources
            .spans()
            .map(|span| serde_json::to_value(span).unwrap())
            .collect();
        assert_eq!(bound, original);
        assert!(parsed
            .sources
            .validate(
                r#"{"outcome":"insufficient_evidence","claims":[]}"#,
                &parsed.origin,
                parsed.scope
            )
            .is_ok());
    }
}

#[test]
fn package_rejects_every_replaced_original_binding_even_when_outer_hashes_match() {
    for (field, changed) in [
        ("id", json!("forged")),
        ("sourceId", json!("forged")),
        ("sourcePath", json!("sessions/private.md")),
        ("selectionPath", json!("wiki/private.md")),
        ("sourceRevision", json!("f".repeat(64))),
        ("sha256", json!("f".repeat(64))),
        ("start", json!(390)),
        ("end", json!(525)),
        ("text", json!("Changed source")),
        ("turnId", json!("T-forged")),
        ("speaker", json!("assistant")),
        ("turnTime", json!("2026-10-01T10:00:00Z")),
        ("recordTime", json!("2026-10-03T10:00:00Z")),
        ("sourcePhase", json!("final")),
        ("gold", json!(true)),
    ] {
        let mut input = user();
        input["originalSpans"][0][field] = changed;
        assert!(
            parse_value(&with_user(packet(MODEL.id), input), MODEL.id).is_err(),
            "accepted {field}"
        );
    }
}

#[test]
fn package_rejects_unselected_duplicate_or_empty_originals_and_verification_injection() {
    for kind in [
        "different-allowed",
        "duplicate-allowed",
        "duplicate-span",
        "empty",
        "receipt",
    ] {
        let mut input = user();
        match kind {
            "different-allowed" => input["allowedSpanIds"][0] = json!("Q-unselected"),
            "duplicate-allowed" => input["allowedSpanIds"][1] = input["allowedSpanIds"][0].clone(),
            "duplicate-span" => input["originalSpans"][1] = input["originalSpans"][0].clone(),
            "empty" => {
                input["allowedSpanIds"] = json!([]);
                input["originalSpans"] = json!([]);
            }
            "receipt" => input["independentVerificationReceipts"] = json!([{"id":"invented"}]),
            _ => unreachable!(),
        }
        assert!(
            parse_value(&with_user(packet(MODEL.id), input), MODEL.id).is_err(),
            "accepted {kind}"
        );
    }
}

#[test]
fn package_rejects_unknown_or_missing_user_and_period_fields_and_duplicate_json_keys() {
    for kind in [
        "gold",
        "missing-language",
        "period-extra",
        "period-missing",
        "period-invalid",
    ] {
        let mut input = user();
        match kind {
            "gold" => input["gold"] = json!([]),
            "missing-language" => {
                input.as_object_mut().unwrap().remove("language");
            }
            "period-extra" => input["activityPeriod"]["timeZone"] = json!("UTC"),
            "period-missing" => {
                input["activityPeriod"]
                    .as_object_mut()
                    .unwrap()
                    .remove("startEpoch");
            }
            "period-invalid" => input["activityPeriod"]["start"] = json!("2026-02-30"),
            _ => unreachable!(),
        }
        assert!(
            parse_value(&with_user(packet(MODEL.id), input), MODEL.id).is_err(),
            "accepted {kind}"
        );
    }
    let mut value = packet(MODEL.id);
    let text = value["user"].as_str().unwrap().replacen(
        "\"language\":\"ko\"",
        "\"language\":\"ko\",\"language\":\"ko\"",
        1,
    );
    value["userSha256"] = json!(hash(text.as_bytes()));
    value["user"] = json!(text);
    assert!(parse_value(&value, MODEL.id).is_err());
}

#[test]
fn file_admission_checks_registered_regular_bytes_before_source_admission() {
    let directory = tempfile::tempdir().unwrap();
    let packet_bytes = serde_json::to_vec(&packet(MODEL.id)).unwrap();
    let packet_sha = hash(&packet_bytes);
    let registration_bytes = serde_json::to_vec(&registration(MODEL.id, &packet_sha)).unwrap();
    let registration_sha = hash(&registration_bytes);
    let packet_path = directory.path().join("packet.json");
    let registration_path = directory.path().join("registration.json");
    std::fs::write(&packet_path, &packet_bytes).unwrap();
    std::fs::write(&registration_path, &registration_bytes).unwrap();
    assert!(read(
        &registration_path,
        &registration_sha,
        &packet_path,
        &packet_sha,
        MODEL.id
    )
    .is_ok());
    assert!(read(
        &registration_path,
        &"a".repeat(64),
        &packet_path,
        &packet_sha,
        MODEL.id
    )
    .is_err());
    std::fs::write(&packet_path, b"changed").unwrap();
    assert!(read(
        &registration_path,
        &registration_sha,
        &packet_path,
        &packet_sha,
        MODEL.id
    )
    .is_err());
}

#[test]
fn projected_sources_exclude_unprovided_siblings_in_the_same_original_document() {
    let (page, original) = CORPUS[3];
    let issued = serde_json::to_value(bind_qa_original(page, original).unwrap()).unwrap();
    let all = issued["spans"].as_array().unwrap();
    assert_eq!(all.len(), 3);
    let mut input = user();
    input["originalSpans"] = json!(&all[1..]);
    input["allowedSpanIds"] = json!(all[1..]
        .iter()
        .map(|span| span["id"].clone())
        .collect::<Vec<_>>());
    let package = parse_value(
        &with_user(packet(GEMMA_CANDIDATE.id), input.clone()),
        GEMMA_CANDIDATE.id,
    )
    .unwrap();
    let bound: Vec<_> = package
        .sources
        .spans()
        .map(|span| serde_json::to_value(span).unwrap())
        .collect();
    assert_eq!(bound, all[1..]);
    assert_eq!(bound, input["originalSpans"].as_array().unwrap().clone());
    for (id, admitted) in [(&all[0]["id"], false), (&all[1]["id"], true)] {
        let proposal = json!({"outcome":"claims","claims":[{
            "action":"Synthetic source-bound proposal","anchorSpanId":id,"supportSpanIds":[id],
            "actor":{"role":"user","basis":"speaker","subjectSpanId":null},
            "eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},
            "speechAct":"report","status":"unknown","verificationId":null,
        }]}).to_string();
        let checked = package
            .sources
            .validate(&proposal, &package.origin, package.scope);
        assert_eq!(checked.is_ok(), admitted);
        if let Ok(checked) = checked {
            assert!(checked.claims[0].semantic_review_required);
        }
    }
}

#[test]
fn each_compiled_parent_can_supply_only_its_selected_native_span() {
    let spans: Vec<_> = CORPUS
        .iter()
        .map(|&(page, original)| {
            serde_json::to_value(bind_qa_original(page, original).unwrap()).unwrap()["spans"][0]
                .clone()
        })
        .collect();
    let mut input = user();
    input["originalSpans"] = json!(spans);
    input["allowedSpanIds"] = json!(spans
        .iter()
        .map(|span| span["id"].clone())
        .collect::<Vec<_>>());
    let package = parse_value(&with_user(packet(MODEL.id), input), MODEL.id).unwrap();
    let bound: Vec<_> = package
        .sources
        .spans()
        .map(|span| serde_json::to_value(span).unwrap())
        .collect();
    assert_eq!(bound, spans);
    assert_eq!(bound.len(), 4);
}

#[test]
fn missing_nullable_metadata_and_nested_duplicate_keys_are_rejected() {
    for field in ["recordTime", "turnTime", "sourcePhase"] {
        let mut input = user();
        input["originalSpans"][0]
            .as_object_mut()
            .unwrap()
            .remove(field);
        assert!(
            parse_value(&with_user(packet(MODEL.id), input), MODEL.id).is_err(),
            "accepted missing {field}"
        );
    }
    let mut value = packet(MODEL.id);
    let text = value["user"].as_str().unwrap().replacen(
        "\"sourcePhase\":null",
        "\"sourcePhase\":null,\"sourcePhase\":null",
        1,
    );
    value["userSha256"] = json!(hash(text.as_bytes()));
    value["user"] = json!(text);
    assert!(parse_value(&value, MODEL.id).is_err());
}

const RETAINED_QWEN: &[u8] =
    include_bytes!("../../eval/local-wiki-quoted-packets-v1/qwen-original.json");
const RETAINED_GEMMA: &[u8] =
    include_bytes!("../../eval/local-wiki-quoted-packets-v1/gemma-original.json");

fn retained_package(bytes: &[u8], id: &str, digest: &str) -> ParsedPackage {
    assert_eq!(hash(bytes), digest);
    let packet: Value = serde_json::from_slice(bytes).unwrap();
    let runtime = serde_json::from_value(packet["runtime"].clone()).unwrap();
    parse_package(bytes, digest, id, &runtime).unwrap()
}

#[test]
fn retained_qwen_packet_preserves_complete_native_window_identity() {
    let package = retained_package(
        RETAINED_QWEN,
        MODEL.id,
        "f0ce8f6c35a9da65e2d5ce340626cab2f1cf63e7cf2a485c1be250f80436e991",
    );
    let ids: Vec<_> = package.sources.spans().map(|span| span.id()).collect();
    assert_eq!(
        ids,
        [
            "Q-b3340210f58a5a91ae2c8aa3363b01d5",
            "Q-0bc7530526850d3c2c33304e644ae5f1"
        ]
    );
}

#[test]
fn retained_gemma_packet_preserves_complete_native_window_identity() {
    let package = retained_package(
        RETAINED_GEMMA,
        GEMMA_CANDIDATE.id,
        "726a92b559d9eda0a18cbfcd5bbbe1b89193b9c9f2bfcbf19537faf6c01d33c1",
    );
    let ids: Vec<_> = package.sources.spans().map(|span| span.id()).collect();
    assert_eq!(
        ids,
        [
            "Q-c0152243d013f9f98a074274fbcd1651",
            "Q-61498e1dda6e59ca6f6aad355dad99c1"
        ]
    );
}

#[test]
fn retained_whole_windows_reject_partial_nested_and_metadata_mutations() {
    let packet: Value = serde_json::from_slice(RETAINED_QWEN).unwrap();
    let original: Value = serde_json::from_str(packet["user"].as_str().unwrap()).unwrap();
    for field in ["id", "start", "sourcePhase", "turnTime", "speaker"] {
        let mut input = original.clone();
        let span = &mut input["originalSpans"][0];
        match field {
            "id" => {
                span["id"] = json!(key(
                    "Q",
                    &format!("{}:389:526", span["id"].as_str().unwrap())
                ));
                input["allowedSpanIds"][0] = input["originalSpans"][0]["id"].clone();
            }
            "start" => span["start"] = json!(390),
            "sourcePhase" => span["sourcePhase"] = json!("analysis"),
            "turnTime" => span["turnTime"] = json!("2026-10-04T08:00:00Z"),
            "speaker" => span["speaker"] = json!("assistant"),
            _ => unreachable!(),
        }
        assert!(
            parse_value(&with_user(packet.clone(), input), MODEL.id).is_err(),
            "accepted {field}"
        );
    }
}

#[test]
fn retained_raw_and_whole_window_aliases_cannot_repeat_one_original_turn() {
    let mut input = user();
    let mut alias = input["originalSpans"][0].clone();
    alias["id"] = json!("Q-b3340210f58a5a91ae2c8aa3363b01d5");
    input["allowedSpanIds"]
        .as_array_mut()
        .unwrap()
        .push(alias["id"].clone());
    input["originalSpans"].as_array_mut().unwrap().push(alias);
    let error = parse_value(&with_user(packet(MODEL.id), input), MODEL.id)
        .err()
        .unwrap();
    assert_eq!(
        error,
        "quoted original selection contains duplicate native aliases"
    );
}
