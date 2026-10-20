use super::*;
use contract::{CompleteSource, FlatOriginal, NativeCapture, Packet, SourcePins, PROSE_SYSTEM};
use myco_lib::local_llm::WikiClaimsSamplerQaProfile;
use myco_lib::retrieval::Scope;
use myco_lib::wiki_claims::quoted_qa::AgentVaultSession;
use myco_lib::wiki_claims::source_interpretation_qa::{prepare_candidate, CandidateQa};
use myco_lib::wiki_claims::{ActorRole, SourceDocument, SourceSet, SpanInput};
use std::cell::RefCell;

fn fixture() -> (Packet, Vec<u8>) {
    let raw = "Synthetic first original.\nSynthetic second original.";
    let origin = AgentVaultSession {
        vault_path: "/synthetic/reading".into(),
        opening_token: "opaque-old-opening".into(),
    };
    let doc = SourceDocument::bind(
        "S1".into(),
        "sessions/reading.md".into(),
        "sessions/reading.md".into(),
        raw,
        None,
        [
            ("Q1", 0, 26, ActorRole::User),
            ("Q2", 26, raw.len(), ActorRole::Assistant),
        ]
        .into_iter()
        .map(|(id, start, end, speaker)| SpanInput {
            id: id.into(),
            start,
            end,
            turn_id: format!("T{id}"),
            speaker,
            turn_time: None,
        })
        .collect(),
    )
    .unwrap();
    let sources = SourceSet::new(origin.clone(), Scope::All, vec![doc], vec![]).unwrap();
    let flat = serde_json::to_value(sources.spans().collect::<Vec<_>>()).unwrap();
    let originals=flat.as_array().unwrap().iter().enumerate().map(|(i,s)|json!({"unitOrdinal":i,"original":{
        "id":s["id"],"speaker":s["speaker"],"text":s["text"],
        "sourceContext":{"turnId":s["turnId"],"turnTime":s["turnTime"],"sourcePhase":s["sourcePhase"],"recordTime":s["recordTime"]},
        "provenance":{"sourceId":s["sourceId"],"sourcePath":s["sourcePath"],"selectionPath":s["selectionPath"],"sourceRevision":s["sourceRevision"],"start":s["start"],"end":s["end"],"sha256":s["sha256"]}}})).collect::<Vec<_>>();
    let user=json!({"version":"NativeSourceInterpretationOrdinalActivityQaInputV2","question":"Synthetic question", "language":"en",
        "originalSpans":originals,"activityPeriod":{},"recordPeriodContext":{},"independentVerificationReceipts":[]}).to_string();
    let system = "  Synthetic activity policy NativeSourceInterpretationOrdinalActivityQaInputV2\n";
    let capture=json!({"probe":"native_ask","controlModel":MODEL.id,"qaOrdinalActivity":true,
        "generationObservations":[{"ordinal":1,"telemetry":null},{"ordinal":2,"requestId":"native-activity-recent_work-answer",
            "system":system,"systemSha256":hash(system.as_bytes()),"user":user,"userSha256":hash(user.as_bytes()),
            "telemetry":{"schema":"nativeSourceInterpretationOrdinalQaV3","profile":"existingGroundedV1","promptTokens":2000,
            "requestedContextTokens":4096,"requestedOutputTokens":768,"loopStop":"eog","terminal":"returnedText"}}],
        "records":[{"case":"capture_native_opening","value":origin},{"case":"activity_question_terminal","questionId":"recent_work",
            "error":"native activity claim_extraction_failed: synthetic test failure"}]}).to_string().into_bytes();
    let decoder = prepare_candidate(&sources, &origin, Scope::All, CandidateQa::OrdinalV3)
        .unwrap()
        .count();
    (
        Packet {
            version: 1,
            data_scope: "synthetic-native-activity-development".into(),
            source: SourcePins {
                capture_path: "/synthetic/capture.json".into(),
                capture_sha256: hash(&capture),
                observation_ordinal: 2,
                request_id: "native-activity-recent_work-answer".into(),
            },
            model: serde_json::to_value(MODEL).unwrap(),
            grammar_sha256: GenerationSchema::NativeSourceInterpretationCandidateQa(decoder)
                .qa_grammar_sha256(),
            typed_sampler: serde_json::to_value(
                WikiClaimsSamplerQaProfile::ExistingGroundedV1.qa_parameters(),
            )
            .unwrap(),
            prose_sampler: serde_json::to_value(LocalLlm::source_reading_qa_sampler_parameters())
                .unwrap(),
            system: system.into(),
            system_sha256: hash(system.as_bytes()),
            user: user.clone(),
            user_sha256: hash(user.as_bytes()),
            prose_system: PROSE_SYSTEM.into(),
            prose_system_sha256: hash(PROSE_SYSTEM.as_bytes()),
            context_tokens: 4096,
            output_tokens: 768,
            original_prompt_tokens: 2000,
            native_capture: NativeCapture {
                origin,
                scope: Scope::All,
                documents: vec![CompleteSource {
                    source_id: "S1".into(),
                    source_path: "sessions/reading.md".into(),
                    selection_path: "sessions/reading.md".into(),
                    raw: raw.into(),
                    record_time: None,
                }],
                original_spans: serde_json::from_value::<Vec<FlatOriginal>>(flat).unwrap(),
            },
        },
        capture,
    )
}

fn changed(mut change: impl FnMut(&mut Value)) -> Result<contract::Prepared, String> {
    let (packet, capture) = fixture();
    let mut value = serde_json::to_value(packet).unwrap();
    change(&mut value);
    let packet = serde_json::from_value(value).map_err(|e| e.to_string())?;
    contract::prepare(packet, &capture)
}

#[test]
fn preserves_complete_captured_messages_and_issues_only_bound_two_unit_decoder() {
    let (packet, capture) = fixture();
    let original = packet.user.clone();
    let system = packet.system.clone();
    let original_flat = serde_json::to_value(&packet.native_capture.original_spans).unwrap();
    let prepared = contract::prepare(packet, &capture).unwrap();
    assert_eq!(prepared.packet.user.as_bytes(), original.as_bytes());
    assert_eq!(prepared.packet.system.as_bytes(), system.as_bytes());
    assert_eq!(prepared.decoder.units(), 2);
    assert_eq!(prepared.decoder.variant(), CandidateQa::OrdinalV3);
    assert_eq!(
        serde_json::to_value(prepared.sources.spans().collect::<Vec<_>>()).unwrap(),
        original_flat
    );
}

#[test]
fn rejects_message_changes_even_with_updated_message_hashes() {
    for field in ["system", "user"] {
        assert!(changed(|v| {
            let s = format!("{} ", v[field].as_str().unwrap());
            v[field] = json!(s);
            v[format!("{field}Sha256")] = json!(hash(s.as_bytes()));
        })
        .is_err());
    }
    let (mut p, capture) = fixture();
    let mut c: Value = serde_json::from_slice(&capture).unwrap();
    p.system =
        "This is source-only interpretation: NativeSourceInterpretationOrdinalActivityQaInputV2"
            .into();
    p.system_sha256 = hash(p.system.as_bytes());
    c["generationObservations"][1]["system"] = json!(p.system);
    c["generationObservations"][1]["systemSha256"] = json!(p.system_sha256);
    let capture = serde_json::to_vec(&c).unwrap();
    p.source.capture_sha256 = hash(&capture);
    assert!(contract::prepare(p, &capture).is_err());
}

#[test]
fn rejects_every_changed_native_field_raw_source_order_and_unsupported_phase() {
    for field in [
        "id",
        "sourceId",
        "sourcePath",
        "selectionPath",
        "sourceRevision",
        "sha256",
        "text",
        "turnId",
        "speaker",
        "recordTime",
        "turnTime",
        "sourcePhase",
        "start",
        "end",
    ] {
        assert!(
            changed(
                |v| v["nativeCapture"]["originalSpans"][0][field] = match field {
                    "start" | "end" => json!(999),
                    "speaker" => json!("unknown"),
                    _ => json!("changed"),
                }
            )
            .is_err(),
            "accepted {field}"
        );
    }
    assert!(changed(
        |v| v["nativeCapture"]["documents"][0]["raw"] = json!("Different full original")
    )
    .is_err());
    assert!(changed(|v| v["nativeCapture"]["originalSpans"]
        .as_array_mut()
        .unwrap()
        .reverse())
    .is_err());
    assert!(changed(|v| v["nativeCapture"]["originalSpans"][0]
        .as_object_mut()
        .unwrap()
        .remove("sourcePhase")
        .map(drop)
        .unwrap())
    .is_err());
}

#[test]
fn rejects_changed_fixed_metadata_and_extra_or_duplicate_packet_fields() {
    for (field, value) in [
        ("version", json!(2)),
        ("dataScope", json!("private-vault")),
        ("model", json!({})),
        ("grammarSha256", json!("0".repeat(64))),
        ("typedSampler", json!({})),
        ("proseSampler", json!({})),
        ("outputTokens", json!(1536)),
        ("contextTokens", json!(2048)),
        ("originalPromptTokens", json!(3321)),
        ("proseSystem", json!("A different task")),
        ("gold", json!(true)),
    ] {
        assert!(
            changed(|v| v[field] = value.clone()).is_err(),
            "accepted {field}"
        );
    }
    let (p, _) = fixture();
    let bytes = serde_json::to_string(&p).unwrap();
    let duplicate = bytes.replacen("\"version\":1", "\"version\":1,\"version\":1", 1);
    assert_ne!(bytes, duplicate);
    assert!(serde_json::from_str::<Packet>(&duplicate).is_err());
}

#[test]
fn rejects_nonfirst_observation_and_inconsistent_captured_failure_or_origin() {
    for field in ["ordinal", "requestId", "systemSha256"] {
        let (mut p, c) = fixture();
        let mut c: Value = serde_json::from_slice(&c).unwrap();
        c["generationObservations"][1][field] = json!("changed");
        let c = serde_json::to_vec(&c).unwrap();
        p.source.capture_sha256 = hash(&c);
        assert!(contract::prepare(p, &c).is_err());
    }
    for change in ["opening", "firstInitial", "failure"] {
        let (mut p, c) = fixture();
        let mut c: Value = serde_json::from_slice(&c).unwrap();
        match change {
            "opening" => c["records"][0]["value"]["openingToken"] = json!("different"),
            "firstInitial" => {
                c["generationObservations"][0]["telemetry"] =
                    json!({"schema":"nativeSourceInterpretationOrdinalQaV3"})
            }
            _ => c["records"][1]["error"] = json!("later final review failed"),
        };
        let c = serde_json::to_vec(&c).unwrap();
        p.source.capture_sha256 = hash(&c);
        assert!(contract::prepare(p, &c).is_err());
    }
}

fn telemetry(arm: Arm, prompt: usize) -> Value {
    json!({"schema":if arm==Arm::Typed {"nativeSourceInterpretationOrdinalQaV3"} else {"freeform"},
        "profile":if arm==Arm::Typed {"existingGroundedV1"} else {"existingGroundedGrammarFreeQaV1"},
        "promptTokens":prompt,"requestedOutputTokens":768,"requestedContextTokens":4096,
        "loopStop":"eog","terminal":"returnedText","errorCode":null,"pendingUtf8Bytes":0})
}

#[test]
fn counts_both_complete_inputs_before_two_independent_calls_even_if_typed_fails() {
    let (p, c) = fixture();
    let prepared = contract::prepare(p, &c).unwrap();
    let events = RefCell::new(Vec::new());
    let result = run_pair(
        &prepared,
        |system, user| {
            assert_eq!(user, prepared.packet.user);
            events.borrow_mut().push(format!("count:{system}"));
            Ok(if system == prepared.packet.system {
                2000
            } else {
                1000
            })
        },
        |arm, system, user| {
            assert_eq!(user, prepared.packet.user);
            assert_eq!(
                system,
                if arm == Arm::Typed {
                    &prepared.packet.system
                } else {
                    PROSE_SYSTEM
                }
            );
            events.borrow_mut().push(format!("generate:{arm:?}"));
            if arm == Arm::Typed {
                (
                    Ok(telemetry(arm, 2000)),
                    Err("synthetic native failure".into()),
                )
            } else {
                (
                    Ok(telemetry(arm, 1000)),
                    Ok("Independent final explanation.".into()),
                )
            }
        },
    );
    assert!(result.unwrap_err().contains("synthetic native failure"));
    let e = events.into_inner();
    assert_eq!(e.len(), 4);
    assert!(e[0].starts_with("count:"));
    assert!(e[1].starts_with("count:"));
    assert_eq!(&e[2..], ["generate:Typed", "generate:Prose"]);
}

#[test]
fn invalid_fit_or_changed_typed_count_prevents_both_decoder_calls() {
    for (typed, prose) in [(1999, 1000), (2000, 3321), (2000, 0)] {
        let (p, c) = fixture();
        let prepared = contract::prepare(p, &c).unwrap();
        assert!(run_pair(
            &prepared,
            |system, _| Ok(if system == prepared.packet.system {
                typed
            } else {
                prose
            }),
            |_, _, _| panic!("decoder called before complete-pair admission")
        )
        .is_err());
    }
    assert!(preflight(3320, 3320, 3320).is_ok());
}

#[test]
fn prose_is_not_json_but_wrong_profile_or_output_budget_is_not_clean_completion() {
    for changed in [None, Some("profile"), Some("loopStop")] {
        let (p, c) = fixture();
        let prepared = contract::prepare(p, &c).unwrap();
        let calls = RefCell::new(Vec::new());
        let result = run_pair(
            &prepared,
            |system, _| {
                Ok(if system == prepared.packet.system {
                    2000
                } else {
                    1000
                })
            },
            |arm, _, _| {
                calls.borrow_mut().push(arm);
                let mut t = telemetry(arm, if arm == Arm::Typed { 2000 } else { 1000 });
                if arm == Arm::Prose {
                    if let Some(field) = changed {
                        t[field] = json!(if field == "profile" {
                            "existingFreeformV1"
                        } else {
                            "outputBudget"
                        });
                    }
                }
                (
                    Ok(t),
                    Ok(if arm == Arm::Typed {
                        "{}"
                    } else {
                        "A complete independent prose explanation."
                    }
                    .into()),
                )
            },
        );
        assert_eq!(calls.into_inner(), [Arm::Typed, Arm::Prose]);
        assert_eq!(result.is_ok(), changed.is_none());
    }
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
    ]
    .map(String::from)
    .to_vec()
}

#[test]
fn requires_only_explicit_four_options_and_rejects_alias_budget_sampler_or_retry() {
    assert!(options(args()).is_ok());
    for i in [0, 2, 4, 6] {
        let mut a = args();
        a.drain(i..i + 2);
        assert!(options(a).is_err());
    }
    for flag in [
        "--model-id",
        "--packet",
        "--output-tokens",
        "--sampler",
        "--retry",
        "--prepare-only",
    ] {
        let mut a = args();
        a.extend([flag.into(), "other".into()]);
        assert!(options(a).is_err());
    }
    for id in ["qwen", "qwen3.5-2b-q4_k_m", "qwen3.5-9b-q4_k_m"] {
        let mut a = args();
        a[3] = id.into();
        assert!(options(a).is_err());
    }
    let mut a = args();
    a[1] = "relative".into();
    assert!(options(a).is_err());
    let mut a = args();
    a[7] = "A".repeat(64);
    assert!(options(a).is_err());
}

#[cfg(unix)]
#[test]
fn held_registered_reads_reject_changed_nonregular_symlink_and_hardlink_inputs() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("capture.json");
    let bytes = b"synthetic capture bytes";
    std::fs::write(&path, bytes).unwrap();
    assert_eq!(
        contract::read_registered(&path, &hash(bytes)).unwrap(),
        bytes
    );
    let alias = dir.path().join("alias.json");
    std::os::unix::fs::symlink(&path, &alias).unwrap();
    assert!(contract::read_registered(&alias, &hash(bytes)).is_err());
    let link = dir.path().join("hard.json");
    std::fs::hard_link(&path, &link).unwrap();
    assert!(contract::read_registered(&path, &hash(bytes)).is_err());
    std::fs::remove_file(link).unwrap();
    std::fs::write(&path, b"changed").unwrap();
    assert!(contract::read_registered(&path, &hash(bytes)).is_err());
    assert!(contract::read_registered(dir.path(), &hash(bytes)).is_err());
}
