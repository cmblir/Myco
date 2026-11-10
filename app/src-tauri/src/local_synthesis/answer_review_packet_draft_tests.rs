//! Explicit synthetic packet comparison. No model, live vault grant, or semantic proof.
use super::*;
use crate::retrieval::Scope;
use crate::role_authorization::RoleSnapshot;
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::{ActorRole, SourceDocument, SourceSet, SpanInput};
use serde_json::{json, Value};
use std::path::PathBuf;

fn sorted_json(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort();
            let mut result = serde_json::Map::new();
            for key in keys {
                result.insert(key.clone(), sorted_json(&object[key]));
            }
            Value::Object(result)
        }
        Value::Array(array) => Value::Array(array.iter().map(sorted_json).collect()),
        _ => value.clone(),
    }
}

#[test]
#[ignore = "requires explicit synthetic packet fixture/output paths; never runs model inference"]
fn synthetic_review_packet_draft_matches_native_dto_and_parser() {
    assert!(!Scope::All.keeps("raw/synthetic-review/example/01.md"));
    assert!(Scope::All.keeps("raw/conversations/synthetic-review/example/01.md"));
    let root = PathBuf::from(std::env::var_os("MYCO_REVIEW_PACKET_DRAFT").expect("fixture path"));
    let output = PathBuf::from(std::env::var_os("MYCO_REVIEW_PACKET_OUTPUT").expect("output path"));
    assert!(!output.exists(), "never overwrite previous comparison");
    let axis_path =
        PathBuf::from(std::env::var_os("MYCO_REVIEW_AXIS_TARGETS").expect("approved axes path"));
    let axis_raw = std::fs::read_to_string(axis_path).unwrap();
    assert_eq!(
        source_revision(&axis_raw),
        std::env::var("MYCO_REVIEW_AXIS_SHA256").expect("approved axes hash")
    );
    let approved: Vec<Value> = serde_json::from_str(&axis_raw).unwrap();
    let read = |name: &str| std::fs::read_to_string(root.join(name)).unwrap();
    let packets: Vec<Value> = read("inputs.jsonl")
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    let targets: Vec<Value> = read("targets.jsonl")
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    let index: Vec<Value> = serde_json::from_str(&read("sidecar-index.json")).unwrap();
    let originals: Value = serde_json::from_str(&read("synthetic-originals.json")).unwrap();
    assert_eq!(packets.len(), 32);
    assert_eq!(approved.len(), packets.len());
    assert_eq!(targets.len(), packets.len());
    assert_eq!(index.len(), packets.len());
    let origin = AgentVaultSession {
        vault_path: "/synthetic/review-packet-draft".into(),
        opening_token: "synthetic-not-live-opening".into(),
    };
    let role: RoleSnapshot = serde_json::from_value(json!({
        "snapshotId":"synthetic-packet-role","origin":origin,"role":"ask","usage":"foreground",
        "authorizationRevision":"synthetic-only","routeSignature":{"role":"ask","providerId":"builtin-local",
        "modelId":crate::local_model::MODEL.id,"effort":"(default)","executionLocation":"in-process",
        "artifactRevision":null,"artifactSha256":null,"runtimeContract":"synthetic-only","signature":"not-native-issued"}
    })).unwrap();
    let mut results = Vec::new();
    let mut native_inputs = Vec::new();
    for (i, packet) in packets.iter().enumerate() {
        let expected: Value =
            serde_json::from_str(packet["messages"][1]["content"].as_str().unwrap()).unwrap();
        let seed = &approved[i]["semantic_seed"];
        assert_eq!(index[i]["case_id"], approved[i]["id"]);
        assert_eq!(index[i]["family"], seed["family"]);
        assert_eq!(targets[i], approved[i]["proposed_verdict"]);
        assert_eq!(
            source_revision(packet["messages"][1]["content"].as_str().unwrap()),
            index[i]["user_sha256"].as_str().unwrap()
        );
        assert_eq!(
            source_revision(&sorted_json(&targets[i]).to_string()),
            index[i]["target_sha256"].as_str().unwrap()
        );
        assert_eq!(expected["context"]["question"], seed["question"]);
        assert_eq!(
            expected["answer"]["proseWithoutModelLinkLabels"],
            seed["candidate_answer"]
        );
        let family = seed["family"].as_str().unwrap();
        assert_eq!(index[i]["ordinal"].as_u64(), Some(i as u64));
        let docs = originals[family].as_array().unwrap();
        let mut bound = Vec::new();
        let mut evidence = Vec::new();
        let seed_spans = seed["original_spans"].as_array().unwrap();
        assert_eq!(docs.len(), seed_spans.len());
        let mut source_map = serde_json::Map::new();
        for (ordinal, (doc, seed_span)) in docs.iter().zip(seed_spans).enumerate() {
            let n = ordinal + 1;
            let path = doc["path"].as_str().unwrap();
            assert_eq!(
                path,
                format!("raw/conversations/synthetic-review/{family}/{n:02}.md")
            );
            assert_eq!(doc["sourceId"], format!("D{n}"));
            let raw = doc["raw"].as_str().unwrap();
            assert_eq!(source_revision(raw), doc["sha256"].as_str().unwrap());
            assert_eq!(raw.len(), doc["utf8Bytes"].as_u64().unwrap() as usize);
            assert!(raw.starts_with("---\n"));
            let body_start = raw.find("\n---\n").unwrap() + 5;
            let dates = raw[..body_start]
                .lines()
                .filter_map(|line| line.strip_prefix("created: "))
                .collect::<Vec<_>>();
            assert_eq!(dates.len(), 1);
            let date: String = serde_json::from_str(dates[0]).unwrap();
            assert_eq!(date, seed_span["date"].as_str().unwrap());
            let body = format!(
                "기록 일자: {}\n발언자: {}\n발언 내용: {}\n",
                date,
                seed_span["speaker"].as_str().unwrap(),
                seed_span["text"].as_str().unwrap()
            );
            assert_eq!(&raw[body_start..], body);
            let span_id = seed_span["id"].as_str().unwrap();
            source_map.insert(span_id.into(), json!(format!("S{n}")));
            let inputs = vec![SpanInput {
                id: span_id.into(),
                start: body_start,
                end: raw.len(),
                turn_id: format!("T{n}"),
                speaker: ActorRole::Source,
                turn_time: Some(date.clone()),
            }];
            bound.push(
                SourceDocument::bind(
                    format!("D{n}"),
                    path.into(),
                    path.into(),
                    raw,
                    Some(date),
                    inputs,
                )
                .unwrap(),
            );
            evidence.push(Evidence {
                page: path.into(),
                stem: family.into(),
                section: 0,
                text: body,
                title: None,
                compiled: None,
            });
        }
        assert_eq!(Value::Object(source_map.clone()), index[i]["source_map"]);
        let selected = approved[i]["answer_evidence_span_refs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|id| source_map[id.as_str().unwrap()].clone())
            .collect::<Vec<_>>();
        assert_eq!(json!(selected), expected["answer"]["sourceIds"]);
        let sources = SourceSet::new(origin.clone(), Scope::All, bound, vec![]).unwrap();
        assert_eq!(
            json!(sources.spans().collect::<Vec<_>>()),
            expected["originalSpans"]
        );
        let question = expected["context"]["question"].as_str().unwrap();
        let paths = evidence.iter().map(|e| e.page.clone()).collect::<Vec<_>>();
        let context = AskReviewContext::for_question(
            &origin,
            &role,
            &format!("synthetic-packet-{i}"),
            question,
            None,
            "ko",
            Scope::All,
            None,
            Some(&paths),
        )
        .unwrap();
        let prompt = prepare(question, None, "ko", &evidence, |_, _| Ok(true)).unwrap();
        let raw = json!({"answer":expected["answer"]["proseWithoutModelLinkLabels"],"sources":expected["answer"]["sourceIds"]}).to_string();
        let draft =
            crate::local_synthesis::answer_draft::validate_answer_draft(&raw, &prompt, "ko")
                .unwrap();
        let exported = diagnostic_input(&context, &sources, &prompt, &draft).unwrap();
        assert_eq!(exported["system"], packet["messages"][0]["content"]);
        let actual: Value = serde_json::from_str(exported["user"].as_str().unwrap()).unwrap();
        let mut normalized_actual = actual.clone();
        let mut normalized_expected = expected.clone();
        // These Python draft fingerprints are deliberately NOT native-issued bindings.
        for key in ["contextRevision", "answerInputRevision"] {
            assert!(normalized_actual[key]
                .as_str()
                .is_some_and(|v| v.len() == 64));
            normalized_actual.as_object_mut().unwrap().remove(key);
            normalized_expected.as_object_mut().unwrap().remove(key);
        }
        assert_eq!(
            normalized_actual, normalized_expected,
            "case {i}: substantive DTO drift"
        );
        let observed = run(
            &context,
            &sources,
            &prompt,
            &draft,
            |_, _| Ok(1),
            |system, user, _, _| {
                assert_eq!(system, exported["system"].as_str().unwrap());
                assert_eq!(user, exported["user"].as_str().unwrap());
                Ok(targets[i].to_string()) // fixed reviewed target, NEVER generated/model-quality evidence
            },
        )
        .unwrap();
        let target = &targets[i];
        let expected_accept = target["answerDisposition"] == "supported"
            && target["taskResponse"] == "adequate"
            && target["sourceCoverage"] == "covered"
            && target["missingSpanIds"].as_array().unwrap().is_empty();
        assert_eq!(observed.require_accepted().is_ok(), expected_accept);
        assert!(observed.binds(&context, &sources, &prompt, &draft));
        native_inputs.push(json!({"messages":[{"role":"system","content":exported["system"]},{"role":"user","content":exported["user"]}]}));
        results.push(json!({"ordinal":i,"sourceSpansEqual":true,"nonBindingFieldsEqual":true,
            "nativeParserAcceptedTarget":true,"nativeGateMatchesTarget":true,"modelExecuted":false,"semanticQualityMeasured":false}));
    }
    std::fs::create_dir(&output).unwrap();
    std::fs::write(output.join("result.json"), serde_json::to_vec_pretty(&json!({"status":"synthetic_native_dto_parser_comparison_passed",
        "cases":results,"nativeIoAuthenticated":false,"modelExecuted":false,"nativeTokenizerCalled":false,"gbnfExercised":false,
        "limitations":["Synthetic DTO origin only, not live app authority","Fixed target parser/gate plumbing, not semantic model performance","Two draft fingerprint fields deliberately normalized; native output exported separately"]})).unwrap()).unwrap();
    std::fs::write(
        output.join("native-inputs.jsonl"),
        native_inputs
            .iter()
            .map(|v| format!("{v}\n"))
            .collect::<String>(),
    )
    .unwrap();
}
