use super::*;
use crate::activity_recall;
use crate::commands::DateRange;
use crate::embeddings::chunk_page;
use crate::retrieval::{Bm25Index, Scope};
use serde_json::Value;
use sha2::{Digest, Sha256};

const ORIGINAL: &str = include_str!("../../eval/local-wiki-development-meaning-v1.json");
const ORIGINAL_MANIFEST: &str =
    include_str!("../../eval/local-wiki-development-meaning-v1.manifest.json");
const LEDGER: &str = include_str!("../../eval/local-wiki-development-ledger-reference-v1.json");
const LEDGER_MANIFEST: &str =
    include_str!("../../eval/local-wiki-development-ledger-reference-v1.manifest.json");

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn offset(value: &Value, field: &str) -> usize {
    usize::try_from(value[field].as_u64().unwrap()).unwrap()
}

fn container_mapping<'a>(mapping: &'a Value, page: &str) -> &'a Value {
    mapping["containers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|container| container["vaultPath"] == page)
        .unwrap()
}

#[test]
fn native_activity_schedule_covers_all_three_original_questions_and_manifest_modes() {
    assert_eq!(
        QUESTIONS,
        [
            (
                "recent_work",
                "내가 최근에 한 일들에 대해서 정리해줘",
                "historical_as_of",
            ),
            (
                "month_work",
                "내가 최근 한달동안 한 일에 대해서 알려줘",
                "historical_as_of",
            ),
            (
                "next_work",
                "내가 앞으로 어떤 작업을 하는게 좋을까?",
                "current_state",
            ),
        ]
    );
    let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
    let declared = manifest["scheduledQuestions"].as_array().unwrap();
    assert_eq!(declared.len(), QUESTIONS.len());
    for ((id, question, mode), entry) in QUESTIONS.iter().zip(declared) {
        assert_eq!(entry["id"], id.replace('_', "-"));
        assert_eq!(entry["question"], *question);
        assert_eq!(entry["scope"], "all");
        assert_eq!(entry["resolutionMode"], *mode);
    }
    assert_eq!(
        manifest["limitations"]["realMcpImportOrCompilationLineageEstablished"],
        false
    );
    assert_eq!(manifest["limitations"]["productAcceptance"], false);
    assert_eq!(manifest["limitations"]["installedAcceptance"], false);
}

#[test]
fn native_activity_fixtures_preserve_frozen_sources_gold_and_exact_passages() {
    let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
    let mapping: Value = serde_json::from_str(MAPPING).unwrap();
    let original: Value = serde_json::from_str(ORIGINAL).unwrap();
    assert_eq!(
        digest(ORIGINAL.as_bytes()),
        "d697b33b60d555615a8e921158f3baeda1c003c6cac3c4a69d5cbe5d000f348c"
    );
    assert_eq!(
        digest(LEDGER.as_bytes()),
        "0fedd5fbb4a55efc444b15c2763986efd19f3555f3527abecbd8731c6ab63c36"
    );
    for (field, contents) in [
        ("sourceArtifact", ORIGINAL),
        ("sourceManifest", ORIGINAL_MANIFEST),
        ("sourceLedgerReference", LEDGER),
        ("sourceLedgerManifest", LEDGER_MANIFEST),
        ("mappingArtifact", MAPPING),
    ] {
        assert_eq!(manifest[field]["sha256"], digest(contents.as_bytes()));
        assert_eq!(offset(&manifest[field], "bytes"), contents.len());
    }
    assert_eq!(mapping["sourceArtifact"], manifest["sourceArtifact"]);
    assert_eq!(mapping["nativeParserExecuted"], false);
    assert_eq!(manifest["limitations"]["heldOut"], false);
    assert_eq!(manifest["containers"].as_array().unwrap().len(), 4);
    assert_eq!(CONTAINERS.len(), 4);
    let mut compared_turns = 0;
    for &(page, text) in CONTAINERS.iter() {
        let entry = container_mapping(&mapping, page);
        let (case_index, case) = original["cases"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .find(|(_, case)| case["id"] == entry["caseId"])
            .unwrap();
        let declared = manifest["containers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|container| container["vaultPath"] == page)
            .unwrap();
        assert_eq!(declared["sha256"], digest(text.as_bytes()));
        assert_eq!(declared["sha256"], entry["containerSha256"]);
        assert_eq!(offset(declared, "bytes"), text.len());
        assert_eq!(offset(entry, "containerBytes"), text.len());
        assert_eq!(
            declared["semanticReference"]["jsonPointer"],
            format!("/cases/{case_index}/gold")
        );
        assert_eq!(declared["originalActivityPeriod"], case["activityPeriod"]);
        assert_eq!(declared["originalSourcePath"], case["source"]["path"]);
        let original_text = case["source"]["original"].as_str().unwrap();
        assert_eq!(
            entry["originalSourceSha256"],
            digest(original_text.as_bytes())
        );
        assert_eq!(offset(entry, "originalSourceBytes"), original_text.len());
        let metadata_line = text
            .lines()
            .find_map(|line| line.strip_prefix("turn_metadata: "))
            .unwrap();
        let metadata: Value = serde_json::from_str(metadata_line).unwrap();
        let original_turns = case["source"]["turns"].as_array().unwrap();
        let mapped_turns = entry["turns"].as_array().unwrap();
        assert_eq!(mapped_turns.len(), original_turns.len());
        assert_eq!(metadata.as_array().unwrap().len(), original_turns.len());
        let mut reconstructed = String::new();
        for (ordinal, (turn, donor)) in mapped_turns.iter().zip(original_turns).enumerate() {
            let start = offset(turn, "containerPassageStart");
            let end = offset(turn, "containerPassageEnd");
            let passage = text.get(start..end).unwrap();
            assert_eq!(passage, donor["text"].as_str().unwrap());
            assert_eq!(digest(passage.as_bytes()), donor["sha256"]);
            assert_eq!(turn["originalPassageSha256"], donor["sha256"]);
            assert_eq!(turn["originalStart"], donor["start"]);
            assert_eq!(turn["originalEnd"], donor["end"]);
            assert_eq!(turn["originalTurnId"], donor["turnId"]);
            assert_eq!(turn["originalSpanId"], donor["id"]);
            assert_eq!(turn["speaker"], donor["speaker"]);
            assert_eq!(turn["turnTimestamp"], donor["turnTime"]);
            assert_eq!(turn["sourcePhase"], donor["sourcePhase"]);
            assert_eq!(metadata[ordinal]["message_id"], donor["turnId"]);
            assert_eq!(metadata[ordinal]["original_role"], donor["speaker"]);
            assert_eq!(metadata[ordinal]["timestamp"], donor["turnTime"]);
            assert_eq!(metadata[ordinal]["phase"], donor["sourcePhase"]);
            reconstructed.push_str(passage);
            if let Some(separator) = entry["originalInterTurnSeparators"].get(ordinal) {
                let separator_text = separator["text"].as_str().unwrap();
                assert_eq!(digest(separator_text.as_bytes()), separator["sha256"]);
                assert_eq!(
                    original_text
                        .get(offset(separator, "originalStart")..offset(separator, "originalEnd"))
                        .unwrap(),
                    separator_text
                );
                reconstructed.push_str(separator_text);
            }
            compared_turns += 1;
        }
        assert_eq!(reconstructed, original_text);
        assert!(!text.contains("original_source:"));
        assert!(!text.contains("source: codex"));
        assert!(!text.contains("conversation_id:"));
    }
    assert_eq!(compared_turns, 9);
}

#[test]
fn native_activity_parser_and_source_binding_match_all_nine_full_turn_bodies() {
    let mapping: Value = serde_json::from_str(MAPPING).unwrap();
    let mut parsed_turns = 0;
    for &(page, text) in CONTAINERS.iter() {
        let entry = container_mapping(&mapping, page);
        let expected = entry["turns"].as_array().unwrap();
        let turns = activity_recall::compilation_original_turns(text).unwrap();
        assert_eq!(turns.len(), expected.len());
        let chunks = chunk_page(text);
        let sections: Vec<_> = (0..chunks.len()).collect();
        let document = activity_recall::bind_original_page(page, text, &chunks, &sections).unwrap();
        let bound = serde_json::to_value(document).unwrap();
        assert_eq!(bound["id"], entry["expectedSourceDocumentId"]);
        assert_eq!(bound["path"], page);
        assert_eq!(bound["selectionPath"], page);
        assert_eq!(bound["revision"], entry["containerSha256"]);
        let spans = bound["spans"].as_array().unwrap();
        assert_eq!(spans.len(), expected.len());
        for ((turn, span), prediction) in turns.iter().zip(spans).zip(expected) {
            assert_eq!(
                turn.header_start,
                offset(prediction, "containerHeaderStart")
            );
            assert_eq!(turn.body_start, offset(prediction, "nativeBodyStart"));
            assert_eq!(turn.end, offset(prediction, "nativeBodyEnd"));
            assert!(text.is_char_boundary(turn.body_start) && text.is_char_boundary(turn.end));
            assert_eq!(turn.id, prediction["expectedNativeTurnId"]);
            assert_eq!(
                serde_json::to_value(turn.speaker).unwrap(),
                prediction["speaker"]
            );
            assert_eq!(
                serde_json::to_value(&turn.timestamp).unwrap(),
                prediction["turnTimestamp"]
            );
            assert_eq!(
                serde_json::to_value(&turn.phase).unwrap(),
                prediction["sourcePhase"]
            );
            let body = text.get(turn.body_start..turn.end).unwrap();
            assert_eq!(digest(body.as_bytes()), prediction["nativeBodySha256"]);
            assert_eq!(span["id"], prediction["expectedNativeSpanId"]);
            assert_eq!(span["turnId"], prediction["expectedNativeTurnId"]);
            assert_eq!(span["sourceId"], bound["id"]);
            assert_eq!(span["sourcePath"], page);
            assert_eq!(span["selectionPath"], page);
            assert_eq!(span["sourceRevision"], entry["containerSha256"]);
            assert_eq!(offset(span, "start"), turn.body_start);
            assert_eq!(offset(span, "end"), turn.end);
            assert_eq!(span["text"], body);
            assert_eq!(span["sha256"], prediction["nativeBodySha256"]);
            assert_eq!(span["speaker"], prediction["speaker"]);
            assert_eq!(span["turnTime"], prediction["turnTimestamp"]);
            assert_eq!(span["recordTime"], entry["recordTime"]);
            assert_eq!(span["sourcePhase"], prediction["sourcePhase"]);
            parsed_turns += 1;
        }
    }
    assert_eq!(parsed_turns, 9);
}

#[test]
fn native_activity_recall_discloses_the_d4_first_turn_omission_without_splitting_the_file() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    fixture(root).unwrap();
    let mut index = Bm25Index::new();
    for &(page, text) in CONTAINERS.iter() {
        assert_eq!(std::fs::read(root.join(page)).unwrap(), text.as_bytes());
        index.upsert_page(
            page,
            Path::new(page).file_stem().unwrap().to_str().unwrap(),
            &chunk_page(text),
        );
    }
    // This fixed parser/retrieval unit window is not a model-selected Ask period.
    let range = DateRange {
        start: "2026-10-01".into(),
        end: "2026-10-04".into(),
        start_epoch: crate::importers::parse_iso8601("2026-10-01T00:00:00+09:00"),
        end_epoch: crate::importers::parse_iso8601("2026-10-05T00:00:00+09:00"),
    };
    let recall = activity_recall::recall(root, &index, &range, Scope::All, None, false).unwrap();
    assert_eq!(recall.indexed_pages, 4);
    assert_eq!(recall.scanned_pages, 4);
    assert_eq!(recall.matched_chunks, 9);
    assert_eq!(recall.hits.len(), 8);
    assert!(
        recall.incomplete,
        "the omitted third turn must remain disclosed"
    );
    let mapping: Value = serde_json::from_str(MAPPING).unwrap();
    let &(page, text) = CONTAINERS
        .iter()
        .find(|(page, _)| page.ends_with("synthetic-dev-cancel-reopen.md"))
        .unwrap();
    let entry = container_mapping(&mapping, page);
    let chunks = chunk_page(text);
    let selected: Vec<_> = recall.hits.iter().filter(|hit| hit.page == page).collect();
    assert_eq!(selected.len(), 2);
    let sections: Vec<_> = selected.iter().map(|hit| hit.section).collect();
    assert_eq!(
        sections,
        [2, 1],
        "retain latest reopening then cancellation"
    );
    for hit in &selected {
        assert_eq!(hit.text, chunks[hit.section]);
    }
    let document = activity_recall::bind_original_page(page, text, &chunks, &sections).unwrap();
    let bound = serde_json::to_value(document).unwrap();
    let spans = bound["spans"].as_array().unwrap();
    assert_eq!(spans.len(), 2);
    for (span, turn) in spans
        .iter()
        .zip(entry["turns"].as_array().unwrap().iter().skip(1))
    {
        assert_eq!(span["id"], turn["expectedNativeSpanId"]);
        assert_eq!(span["sha256"], turn["nativeBodySha256"]);
        assert_eq!(span["speaker"], "user");
        assert_eq!(span["turnTime"], turn["turnTimestamp"]);
        assert_eq!(
            span["text"],
            &text[offset(turn, "nativeBodyStart")..offset(turn, "nativeBodyEnd")]
        );
    }
    assert!(spans
        .iter()
        .all(|span| span["turnId"] != entry["turns"][0]["expectedNativeTurnId"]));
    retained(root).unwrap();
}

#[test]
fn native_activity_protocol_gate_rejects_wrong_period_counts_and_sources() {
    // Synthetic envelopes test the QA gate, never inference or source meaning.
    let range = json!({"start":"2026-10-01","end":"2026-10-04","startEpoch":100,"endEpoch":200});
    let resolution = json!({"mode":"current_state","asOfEpoch":250,"capturedQueryEpoch":250});
    let page = CONTAINERS[0].0;
    let hits = json!([{"page":page}]);
    let answer = json!({"model_id":crate::local_model::MODEL.id,"answer":format!("합성 작업 기록 [[{}]]",page.trim_end_matches(".md")),"used_sources":[page],
        "activity_receipt":{"scope":"all","activityPeriod":range,
            "resolutionWindow":{"mode":"current_state","startEpoch":100,"endEpoch":251,"asOfEpoch":250,"capturedQueryEpoch":250},
            "eligibleOriginalSpans":1,"boundedWindows":1,"processedWindows":1,"omittedWindows":0,
            "originalPeriodCounts":{"inPeriodSpans":1,"outsidePeriodSpans":0,"uncertainSpans":0},
            "answerPeriodCounts":{"inPeriodSpans":1,"outsidePeriodSpans":0,"uncertainSpans":0},
            "extractionBatches":1,"proposedClaims":1,"selectedClaims":1,"omittedClaims":0,"answerOriginalSpans":1,
            "claimSourceAndStructureChecked":true,"semanticReviewRequired":true,"automatedClaimReviews":1,
            "automatedAnswerReviewInputRevision":"a".repeat(64),"originalInputsIncomplete":false,
            "independentVerificationReceipts":0,"additionalSources":[]}});
    positive(
        &answer,
        &range,
        &resolution,
        &hits,
        &crate::local_model::MODEL,
    )
    .unwrap();
    let historical = json!({"mode":"historical_as_of","asOfEpoch":199,"capturedQueryEpoch":250});
    let mut historical_answer = answer.clone();
    historical_answer["activity_receipt"]["resolutionWindow"] = json!({
        "mode":"historical_as_of","startEpoch":100,"endEpoch":200,
        "asOfEpoch":199,"capturedQueryEpoch":250
    });
    positive(
        &historical_answer,
        &range,
        &historical,
        &hits,
        &crate::local_model::MODEL,
    )
    .unwrap();
    assert!(positive(
        &answer,
        &range,
        &historical,
        &hits,
        &crate::local_model::MODEL
    )
    .is_err());
    let mut candidate_answer = answer.clone();
    candidate_answer["activity_receipt"]["eligibleOriginalSpans"] = json!(3);
    candidate_answer["activity_receipt"]["boundedWindows"] = json!(3);
    candidate_answer["activity_receipt"]["processedWindows"] = json!(2);
    candidate_answer["activity_receipt"]["omittedWindows"] = json!(1);
    candidate_answer["activity_receipt"]["answerOriginalSpans"] = json!(3);
    candidate_answer["activity_receipt"]["originalPeriodCounts"] =
        json!({"inPeriodSpans":1,"outsidePeriodSpans":1,"uncertainSpans":1});
    candidate_answer["activity_receipt"]["answerPeriodCounts"] =
        json!({"inPeriodSpans":1,"outsidePeriodSpans":1,"uncertainSpans":1});
    positive(
        &candidate_answer,
        &range,
        &resolution,
        &hits,
        &crate::local_model::MODEL,
    )
    .unwrap();
    let mut candidate_answer = answer.clone();
    candidate_answer["model_id"] = json!(crate::local_model::GEMMA_CANDIDATE.id);
    positive(
        &candidate_answer,
        &range,
        &resolution,
        &hits,
        &crate::local_model::GEMMA_CANDIDATE,
    )
    .unwrap();
    assert!(positive(
        &candidate_answer,
        &range,
        &resolution,
        &hits,
        &crate::local_model::MODEL
    )
    .is_err());
    assert!(positive(
        &answer,
        &range,
        &resolution,
        &hits,
        &crate::local_model::GEMMA_CANDIDATE
    )
    .is_err());
    for (pointer, replacement) in [
        ("/activity_receipt/originalPeriodCounts", Value::Null),
        (
            "/activity_receipt/answerPeriodCounts/inPeriodSpans",
            json!(-1),
        ),
        (
            "/activity_receipt/answerPeriodCounts/inPeriodSpans",
            json!(0.5),
        ),
        (
            "/activity_receipt/answerPeriodCounts/inPeriodSpans",
            json!(9_007_199_254_740_992u64),
        ),
        (
            "/activity_receipt/originalPeriodCounts/outsidePeriodSpans",
            json!(1),
        ),
        ("/activity_receipt/boundedWindows", json!(513)),
        ("/activity_receipt/scope", json!("wiki")),
        (
            "/activity_receipt/activityPeriod/start",
            json!("2026-09-01"),
        ),
        ("/activity_receipt/activityPeriod/startEpoch", json!(99)),
        (
            "/activity_receipt/resolutionWindow/mode",
            json!("historical_as_of"),
        ),
        ("/activity_receipt/resolutionWindow/asOfEpoch", json!(249)),
        ("/activity_receipt/resolutionWindow/endEpoch", json!(250)),
        (
            "/activity_receipt/automatedAnswerReviewInputRevision",
            json!("g".repeat(64)),
        ),
        ("/activity_receipt/processedWindows", json!(0)),
        ("/activity_receipt/omittedWindows", json!(2)),
        ("/activity_receipt/automatedClaimReviews", json!(2)),
        (
            "/activity_receipt/independentVerificationReceipts",
            json!(1),
        ),
        ("/used_sources/0", json!("sessions/synthetic-outside.md")),
        ("/answer", json!("합성 기록에 인용이 없습니다.")),
    ] {
        let mut malformed = answer.clone();
        *malformed.pointer_mut(pointer).unwrap() = replacement;
        assert!(
            positive(
                &malformed,
                &range,
                &resolution,
                &hits,
                &crate::local_model::MODEL
            )
            .is_err(),
            "must reject {pointer}"
        );
    }
    let mut fallback = answer.clone();
    fallback["fallback_reason"] = json!("activity_insufficient_evidence");
    assert!(positive(
        &fallback,
        &range,
        &resolution,
        &hits,
        &crate::local_model::MODEL
    )
    .is_err());
}

#[test]
fn native_activity_protocol_failure_retains_the_production_stage_detail() {
    // Reproduce the actual empty-answer failure envelopes, without inference.
    for (code, detail) in [
        (
            "claim_extraction_failed",
            "invalid claim proposal JSON: EOF while parsing a string at line 1 column 1885",
        ),
        (
            "review_rejected",
            "review_rejected: claim meaning is unsupported",
        ),
    ] {
        let answer = json!({"model_id":crate::local_model::MODEL.id,"answer":"","used_sources":[],
            "fallback_reason":code,"activity_failure":{"code":code,"detail":detail}});
        assert_eq!(
            positive(
                &answer,
                &Value::Null,
                &Value::Null,
                &Value::Null,
                &crate::local_model::MODEL
            )
            .unwrap_err(),
            format!("native activity {code}: {detail}")
        );
    }
}

#[test]
fn native_activity_status_and_role_are_bound_to_the_selected_artifact() {
    // Synthetic envelopes verify coupling, never model readiness or authority.
    let learned = ModelManifest {
        id: "synthetic-activity-package-only",
        adapter: Some(crate::local_model::LoraManifest {
            file: "synthetic-adapter.gguf",
            bytes: 28,
            sha256: "3c06d3f73e4aa0ba34e25f0bb93963eae7f0310db1aa6b2e9bcc5da1c8a8d020",
        }),
        ..crate::local_model::MODEL
    };
    for manifest in [
        &crate::local_model::MODEL,
        &crate::local_model::GEMMA_CANDIDATE,
        &learned,
    ] {
        let status = json!({"state":"ready","model_id":manifest.id,"bytes":manifest.bytes});
        ready(&status, manifest).unwrap();
        for (field, replacement) in [
            ("state", json!("missing")),
            ("model_id", json!("other-model")),
            ("bytes", json!(manifest.bytes - 1)),
        ] {
            let mut changed = status.clone();
            changed[field] = replacement;
            assert!(ready(&changed, manifest).is_err());
        }
        let grant = json!({"role":"ask","usage":"foreground","routeSignature":{
            "role":"ask","providerId":"builtin-local","modelId":manifest.id,
            "artifactRevision":manifest.revision,"artifactSha256":crate::local_model::artifact_identity(manifest),
            "executionLocation":"in-process","runtimeContract":crate::local_model::runtime_contract(manifest)}});
        selected_role(&grant, manifest).unwrap();
        if manifest.adapter.is_some() {
            let mut base_only = grant.clone();
            base_only["routeSignature"]["artifactSha256"] = json!(manifest.sha256);
            assert!(selected_role(&base_only, manifest).is_err());
            base_only["routeSignature"]["artifactSha256"] =
                json!(crate::local_model::artifact_identity(manifest));
            base_only["routeSignature"]["runtimeContract"] = json!("local-generation-v1");
            assert!(selected_role(&base_only, manifest).is_err());
        }
        for (pointer, replacement) in [
            ("/role", json!("compilation")),
            ("/usage", json!("automatic")),
            ("/routeSignature/role", json!("compilation")),
            ("/routeSignature/providerId", json!("ollama")),
            ("/routeSignature/modelId", json!("other-model")),
            ("/routeSignature/artifactRevision", json!("other-revision")),
            ("/routeSignature/artifactSha256", json!("0".repeat(64))),
            ("/routeSignature/executionLocation", json!("remote")),
            ("/routeSignature/runtimeContract", json!("other-runtime")),
        ] {
            let mut changed = grant.clone();
            *changed.pointer_mut(pointer).unwrap() = replacement;
            assert!(
                selected_role(&changed, manifest).is_err(),
                "must reject {pointer}"
            );
        }
    }
}
