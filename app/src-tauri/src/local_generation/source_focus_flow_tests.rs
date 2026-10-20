//! Synthetic original IO plus mock transport; not model or native-role approval.

use crate::activity_recall::{ResolutionMode, ResolutionRead, ResolutionRequest};
use crate::embeddings::chunk_page;
use crate::local_generation::activity_flow::{
    activity_synthesis_steps, activity_synthesis_steps_with_resolution_mode_observed,
    activity_synthesis_steps_with_source_focus_qa,
};
use crate::local_generation::{checked_evidence, CheckedEvidence, Request};
use crate::local_llm::GenerationSchema;
use crate::local_synthesis::Evidence;
use crate::native_ask_probe::{FocusTokenBudgetQa, FocusTokenPhaseQa};
use crate::retrieval::{Bm25Index, Scope};
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::focus_claims_qa::PreparedFocusQa;
use crate::wiki_claims::ClaimProposal;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cell::{Cell, RefCell};
use std::sync::atomic::AtomicBool;

const PAGE: &str = "sessions/synthetic.md";
const REQUEST_FOCUS: &str = "Please add a synthetic export button.";
const PREPARATION_FOCUS: &str = "I prepared the synthetic export draft;";
const LIMIT_FOCUS: &str = "actual verification is not recorded.";
const ANSWER: &str = "사용자가 합성 내보내기 버튼 추가를 요청했고, 어시스턴트는 초안을 준비했다고 보고했습니다. 실제 검증 결과는 기록되지 않았습니다.";

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn fixture() -> (tempfile::TempDir, Request, CheckedEvidence, Bm25Index) {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("sessions")).unwrap();
    let body = format!("---\nturn_metadata: [{{timestamp: '2026-10-03T08:00:00Z', message_id: synthetic-request}}, {{timestamp: '2026-10-04T08:00:00Z', message_id: synthetic-report}}]\n---\n\n**User:**\n\n{REQUEST_FOCUS}\n\n**Assistant:**\n\n{PREPARATION_FOCUS} {LIMIT_FOCUS}\n");
    std::fs::write(dir.path().join(PAGE), &body).unwrap();
    let chunks = chunk_page(&body);
    let mut index = Bm25Index::new();
    index.upsert_page(PAGE, "Synthetic export", &chunks);
    let origin = AgentVaultSession {
        vault_path: dir
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        opening_token: "synthetic-focus-opening".into(),
    };
    // This shape is deliberately synthetic, not a registry-issued execution grant.
    let role = serde_json::from_value(json!({"snapshotId":"synthetic-focus-role","origin":origin,
        "role":"ask","usage":"foreground","authorizationRevision":"synthetic",
        "routeSignature":{"role":"ask","providerId":"builtin-local","modelId":"qwen3.5-4b-q4_k_m",
            "effort":"none","executionLocation":"in-process","artifactRevision":"synthetic",
            "artifactSha256":"0".repeat(64),"runtimeContract":"synthetic-helper-only",
            "signature":"synthetic-shape-only"}}))
    .unwrap();
    let request = Request {
        model_id: None,
        role_snapshot: Some(role),
        request_id: "synthetic-focus-flow".into(),
        question: "최근 한 일을 정리해줘".into(),
        previous_question: Some("Unrelated old question".into()),
        lang: "ko".into(),
        hits: chunks
            .iter()
            .enumerate()
            .map(|(section, text)| Evidence {
                page: PAGE.into(),
                stem: "Synthetic export".into(),
                section,
                text: text.clone(),
                title: None,
                compiled: None,
            })
            .collect(),
        expected_vault: origin.vault_path.clone(),
        origin: Some(origin),
        scope: Scope::Sessions,
        range: Some(crate::commands::DateRange {
            start: "2026-10-03".into(),
            end: "2026-10-04".into(),
            start_epoch: None,
            end_epoch: None,
        }),
        paths: None,
        max_tokens: Some(768),
        activity_overview: true,
        resolution: None,
    };
    let checked = checked_evidence(dir.path(), &index, &request).unwrap();
    (dir, request, checked, index)
}

fn focus_reply(packet: &Value) -> String {
    let claims = json!([
        [
            0,
            REQUEST_FOCUS,
            "intention",
            [0],
            ["user", "speaker", null],
            [null, "unknown", "unknown", "unknown", null],
            "request",
            "requested",
            null
        ],
        [
            1,
            PREPARATION_FOCUS,
            "asserted_occurrence",
            [1],
            ["assistant", "speaker", null],
            [null, "unknown", "unknown", "unknown", null],
            "report",
            "reported_completed",
            null
        ],
        [
            1,
            LIMIT_FOCUS,
            "record_or_verification_limit",
            [1],
            ["unknown", "unknown", null],
            [null, "unknown", "unknown", "unknown", null],
            "report",
            "unknown",
            null
        ],
    ]);
    format!("{{\"version\":\"WikiSourceFocusClaimsQaV1\",\"packetSha256\":\"{}\",\"outcome\":\"claims\",\"claims\":{claims}}}", packet["packetSha256"].as_str().unwrap())
}

fn legacy_reply(packet: &Value, later: bool) -> String {
    let spans = packet[if later {
        "laterOriginalSpans"
    } else {
        "originalSpans"
    }]
    .as_array()
    .unwrap();
    let claims = spans.iter().map(|span| {
        let is_user = span["speaker"] == "user";
        let supports = if later { json!([packet["taskKeys"][0]["anchorSpanId"],span["id"]]) }
            else { json!([span["id"]]) };
        json!({"action":span["text"],"anchorSpanId":span["id"],"supportSpanIds":supports,
            "actor":{"role":span["speaker"],"basis":"speaker","subjectSpanId":null},
            "eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},
            "speechAct":if later {"retraction"} else if is_user {"request"} else {"report"},
            "status":if later {"retracted"} else if is_user {"requested"} else {"reported_completed"},"verificationId":null})
    }).collect::<Vec<_>>();
    json!({"outcome":"claims","claims":claims}).to_string()
}

// These fixed verdicts exercise transport and receipt binding only.
fn review_reply(schema: GenerationSchema, packet: &Value, disposition: &str) -> String {
    if let GenerationSchema::WikiClaimReviewV1(decisions) = schema {
        let ids = packet["requiredClaimIds"].as_array().unwrap();
        assert_eq!(decisions.count(), ids.len());
        return json!({"version":"WikiClaimReviewV1","claims":ids.iter().map(|id|
            json!({"id":id,"disposition":disposition,"reason":"Synthetic transport verdict."})).collect::<Vec<_>>(),
            "missingSpanIds":[],"sourceCoverage":"covered"}).to_string();
    }
    assert_eq!(schema, GenerationSchema::AskAnswerReviewV1);
    json!({"version":"AskAnswerReviewV1","answerDisposition":disposition,"taskResponse":"adequate",
        "sourceCoverage":"covered","missingSpanIds":[],"reason":"Synthetic transport verdict."})
    .to_string()
}

fn count_exact(
    measured: &RefCell<Vec<(String, String)>>,
    system: &str,
    user: &str,
) -> Result<usize, String> {
    measured.borrow_mut().push((system.into(), user.into()));
    Ok(1800)
}

fn assert_measured(measured: &RefCell<Vec<(String, String)>>, system: &str, user: &str) {
    assert!(measured
        .borrow()
        .iter()
        .any(|(old_system, old_user)| old_system == system && old_user == user));
}

fn assert_focus_capture(system: &str, user: &str, schema: GenerationSchema) -> Value {
    let packet: Value = serde_json::from_str(user).unwrap();
    let mut original = packet.clone();
    original.as_object_mut().unwrap().remove("packetSha256");
    original
        .as_object_mut()
        .unwrap()
        .remove("spanOrdinalDictionary");
    let prepared = PreparedFocusQa::prepare(&original.to_string()).unwrap();
    let GenerationSchema::WikiSourceFocusClaimsQaV1(decoder) = schema else {
        panic!("focus extraction schema required");
    };
    assert_eq!(decoder, prepared.decoder());
    assert_eq!(system, prepared.system());
    assert_eq!(user, prepared.user());
    assert_eq!(
        decoder.packet_sha256(),
        sha(prepared.original_user().as_bytes())
    );
    assert_eq!(packet["originalSpans"].as_array().unwrap().len(), 2);
    assert_eq!(packet["originalSpans"][0]["speaker"], "user");
    assert_eq!(packet["originalSpans"][1]["speaker"], "assistant");
    packet
}

fn assert_selected_witnesses(packet: &Value) {
    let proposals = packet["claimProposals"].as_array().unwrap();
    let witnesses = packet["sourceFocusInterpretations"].as_array().unwrap();
    assert_eq!(
        packet["sourceFocusInterpretations"],
        json!([
            {"selectedProposalOrdinal":0,"assertionKind":"intention"},
            {"selectedProposalOrdinal":1,"assertionKind":"asserted_occurrence"},
            {"selectedProposalOrdinal":2,"assertionKind":"record_or_verification_limit"}
        ])
    );
    for (witness, expected_action) in
        witnesses
            .iter()
            .zip([REQUEST_FOCUS, PREPARATION_FOCUS, LIMIT_FOCUS])
    {
        assert_eq!(witness.as_object().unwrap().len(), 2);
        let selected = witness["selectedProposalOrdinal"].as_u64().unwrap() as usize;
        let proposal: ClaimProposal = serde_json::from_value(proposals[selected].clone()).unwrap();
        assert_eq!(proposal.action, expected_action);
        let span = packet["sources"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|source| source["originalSpans"].as_array().unwrap())
            .find(|span| span["id"] == proposal.anchor_span_id)
            .unwrap();
        assert_eq!(
            span["text"]
                .as_str()
                .unwrap()
                .matches(expected_action)
                .count(),
            1
        );
        assert_eq!(span.as_object().unwrap().len(), 7);
        for field in [
            "id",
            "text",
            "speaker",
            "turnId",
            "turnTime",
            "recordTime",
            "sourcePhase",
        ] {
            assert!(span.get(field).is_some());
        }
        assert_eq!(
            proposals[selected]["eventTime"],
            json!({"value":null,"basis":"unknown",
            "precision":"unknown","uncertainty":"unknown","supportSpanId":null})
        );
    }
    assert_eq!(proposals[0]["speechAct"], "request");
    assert_eq!(proposals[0]["status"], "requested");
    assert_eq!(proposals[1]["actor"]["role"], "assistant");
    assert_eq!(proposals[1]["status"], "reported_completed");
    assert_eq!(proposals[2]["status"], "unknown");
    assert_eq!(
        packet["sourceFocusInterpretationRevision"]
            .as_str()
            .unwrap()
            .len(),
        64
    );
    assert!(packet.get("sourceFocusInterpretationRevisions").is_none());
}

#[test]
fn focus_pipeline_measures_actual_inputs_and_carries_compact_mapping_to_final_review() {
    let (_dir, request, checked, _index) = fixture();
    let measured = RefCell::new(Vec::new());
    let mut schemas = Vec::new();
    let mut review_input = None;
    let mut answer_input = None;
    let mut final_input = None;
    let mut answer_raw = None;
    let reply = activity_synthesis_steps_with_source_focus_qa(&request,&checked.evidence,checked.originals.as_ref().unwrap(),request.origin.as_ref().unwrap(),
        |system,user|count_exact(&measured,system,user),|system,user,output,context,schema| {
            assert_measured(&measured,system,user); assert_eq!((output,context),(768,4096)); schemas.push(schema);
            let packet: Value = serde_json::from_str(user).unwrap();
            match schema {
                GenerationSchema::WikiSourceFocusClaimsQaV1(_) => Ok(focus_reply(&assert_focus_capture(system,user,schema))),
                GenerationSchema::WikiClaimReviewV1(_) => {
                    let sidecar = &packet["sourceFocusInterpretations"];
                    assert_eq!(sidecar["claims"],json!([
                        {"id":"C0","assertionKind":"intention"},
                        {"id":"C1","assertionKind":"asserted_occurrence"},
                        {"id":"C2","assertionKind":"record_or_verification_limit"}
                    ]));
                    for (entry,id) in sidecar["claims"].as_array().unwrap().iter().zip(packet["requiredClaimIds"].as_array().unwrap()) {
                        assert_eq!(&entry["id"],id);
                        assert!(packet["claims"].as_array().unwrap().iter().any(|claim|claim["id"]==entry["id"]));
                    }
                    assert!(sidecar.get("witnesses").is_none());
                    assert!(sidecar.get("interpretationRevision").is_none());
                    assert_eq!(user.matches(packet["interpretationRevision"].as_str().unwrap()).count(),1);
                    for field in ["semanticAccepted","nativeIoAuthenticated","productionAccepted"] { assert_eq!(sidecar[field],false); }
                    assert!(system.contains("Source-focus QA representation: each proposal.action is its exact retained focus quotation"));
                    review_input = Some((user.to_owned(),packet.clone()));
                    Ok(review_reply(schema,&packet,"supported"))
                }
                GenerationSchema::AskAnswerV1 => {
                    assert_selected_witnesses(&packet);
                    answer_input = Some(packet.clone());
                    let raw = json!({"answer":ANSWER,"sources":["S1"]}).to_string(); answer_raw=Some(raw.clone()); Ok(raw)
                }
                GenerationSchema::AskAnswerReviewV1 => { final_input=Some((user.to_owned(),packet.clone())); Ok(review_reply(schema,&packet,"supported")) }
                _ => panic!("unexpected focus-flow schema"),
            }
        },|_,_|panic!("no resolution requested"),|_|panic!("no resolution recheck requested")).unwrap();
    assert_eq!(schemas.len(), 4);
    assert!(matches!(
        schemas[0],
        GenerationSchema::WikiSourceFocusClaimsQaV1(_)
    ));
    assert_eq!(
        schemas[1],
        GenerationSchema::WikiClaimReviewV1(crate::local_llm::ReviewDecisions::new(3).unwrap())
    );
    assert_eq!(
        &schemas[2..],
        &[
            GenerationSchema::AskAnswerV1,
            GenerationSchema::AskAnswerReviewV1
        ]
    );
    let (_review_user, review) = review_input.unwrap();
    let answer = answer_input.unwrap();
    let (final_user, final_review) = final_input.unwrap();
    assert!(answer.get("automatedClaimReviewInputRevisions").is_none());
    assert_eq!(review["interpretationRevision"].as_str().unwrap().len(), 64);
    assert_eq!(
        answer["sourceFocusInterpretationRevision"]
            .as_str()
            .unwrap()
            .len(),
        64
    );
    for field in [
        "sourceFocusInterpretations",
        "sourceFocusRepresentation",
        "sourceFocusInterpretationRevision",
        "claimProposals",
    ] {
        assert_eq!(final_review[field], answer[field]);
    }
    assert_eq!(
        final_review["answerInputRevision"],
        sha(answer_raw.unwrap().as_bytes())
    );
    assert_eq!(
        reply.receipt.automated_answer_review_input_revision,
        sha(final_user.as_bytes())
    );
    assert_eq!(
        (
            reply.receipt.processed_windows,
            reply.receipt.omitted_windows,
            reply.receipt.automated_claim_reviews
        ),
        (2, 0, 1)
    );
    assert_eq!(reply.receipt.proposed_claims, 3);
    assert_eq!(reply.receipt.selected_claims, 3);
    assert_eq!(reply.used_sources, vec![PAGE]);
    assert!(reply.receipt.semantic_review_required);
}

#[test]
fn rejected_focus_review_stops_before_processing_receipt_and_answer() {
    for (disposition, code) in [
        ("unsupported", "review_rejected"),
        ("uncertain", "review_uncertain"),
    ] {
        let (_dir, request, checked, _index) = fixture();
        let mut calls = Vec::new();
        let failure = activity_synthesis_steps_with_source_focus_qa(
            &request,
            &checked.evidence,
            checked.originals.as_ref().unwrap(),
            request.origin.as_ref().unwrap(),
            |_, _| Ok(1000),
            |_, user, _, _, schema| {
                calls.push(schema);
                let packet: Value = serde_json::from_str(user).unwrap();
                if matches!(schema, GenerationSchema::WikiSourceFocusClaimsQaV1(_)) {
                    return Ok(focus_reply(&packet));
                }
                assert!(matches!(schema, GenerationSchema::WikiClaimReviewV1(_)));
                Ok(review_reply(schema, &packet, disposition))
            },
            |_, _| panic!("rejected extraction cannot resolve"),
            |_| panic!("rejected extraction cannot recheck later sources"),
        )
        .unwrap_err();
        assert_eq!(failure.code, code);
        assert_eq!(calls.len(), 2);
        assert!(calls.iter().all(|schema| !matches!(
            schema,
            GenerationSchema::AskAnswerV1 | GenerationSchema::AskAnswerReviewV1
        )));
    }
}

#[test]
fn malformed_or_replayed_focus_output_never_reaches_review_or_answer() {
    for replay in [false, true] {
        let (_dir, request, checked, _index) = fixture();
        let mut calls = 0;
        let failure = activity_synthesis_steps_with_source_focus_qa(
            &request,
            &checked.evidence,
            checked.originals.as_ref().unwrap(),
            request.origin.as_ref().unwrap(),
            |_, _| Ok(1000),
            |_, user, _, _, schema| {
                calls += 1;
                assert!(matches!(
                    schema,
                    GenerationSchema::WikiSourceFocusClaimsQaV1(_)
                ));
                let packet: Value = serde_json::from_str(user).unwrap();
                let raw = focus_reply(&packet);
                Ok(if replay {
                    raw.replace(packet["packetSha256"].as_str().unwrap(), &"0".repeat(64))
                } else {
                    raw.replace(REQUEST_FOCUS, "Unsupported fabricated synthetic quote.")
                })
            },
            |_, _| panic!("invalid projection cannot resolve"),
            |_| panic!("invalid projection cannot recheck later sources"),
        )
        .unwrap_err();
        assert_eq!(failure.code, "claim_extraction_failed");
        assert_eq!(calls, 1);
    }
}

#[test]
fn qa_off_uses_reading_extraction_and_no_focus_sidecars() {
    let (_dir, request, checked, _index) = fixture();
    let mut calls = Vec::new();
    let reply = activity_synthesis_steps(
        &request,
        &checked.evidence,
        checked.originals.as_ref().unwrap(),
        request.origin.as_ref().unwrap(),
        |_, _| Ok(1000),
        |system, user, _, _, schema| {
            calls.push(schema);
            let packet: Value = serde_json::from_str(user).unwrap();
            assert!(packet.get("sourceFocusInterpretations").is_none());
            assert!(packet.get("interpretationRevision").is_none());
            match schema {
                GenerationSchema::WikiClaimsV1 => {
                    assert_eq!(
                        system,
                        crate::local_synthesis::claim_prompt::activity_reading_system()
                    );
                    for original in packet["originalSpans"].as_array().unwrap() {
                        assert_eq!(original.as_object().unwrap().len(), 5);
                        assert!(original["sourceContext"].is_object());
                        assert!(original["provenance"].is_object());
                    }
                    Ok(legacy_reply(&packet, false))
                }
                GenerationSchema::WikiClaimReviewV1(_) | GenerationSchema::AskAnswerReviewV1 => {
                    Ok(review_reply(schema, &packet, "supported"))
                }
                GenerationSchema::AskAnswerV1 => {
                    Ok(json!({"answer":ANSWER,"sources":["S1"]}).to_string())
                }
                _ => panic!("QA-off path dispatched QA schema"),
            }
        },
    )
    .unwrap();
    assert_eq!(calls[0], GenerationSchema::WikiClaimsV1);
    assert_eq!(calls.len(), 4);
    assert_eq!(reply.receipt.automated_claim_reviews, 1);
}

#[test]
fn source_focus_initial_mode_keeps_later_resolution_in_legacy_schema() {
    let (dir, mut request, checked, mut index) = fixture();
    let later_page = "sessions/later.md";
    let later="---\nturn_metadata: [{timestamp: '2026-10-06T08:00:00Z', original_role: user, phase: final}]\n---\n\n**User:**\n\nThe synthetic export button result is rejected; I retract that completion.\n";
    std::fs::write(dir.path().join(later_page), later).unwrap();
    index.upsert_page(later_page, "Synthetic later state", &chunk_page(later));
    let captured = crate::importers::parse_iso8601("2026-10-08T12:00:00Z").unwrap();
    request.resolution = Some(ResolutionRequest {
        mode: ResolutionMode::CurrentState,
        as_of_epoch: captured,
        captured_query_epoch: captured,
    });
    let measured = RefCell::new(Vec::new());
    let mut schemas = Vec::new();
    let mut later_calls = 0;
    let mut rechecks = 0;
    let reply=activity_synthesis_steps_with_source_focus_qa(&request,&checked.evidence,checked.originals.as_ref().unwrap(),request.origin.as_ref().unwrap(),|system,user|count_exact(&measured,system,user),
        |system,user,_,_,schema| { assert_measured(&measured,system,user); schemas.push(schema); let packet:Value=serde_json::from_str(user).unwrap();
            match schema {
                GenerationSchema::WikiSourceFocusClaimsQaV1(_)=>Ok(focus_reply(&assert_focus_capture(system,user,schema))),
                GenerationSchema::WikiClaimsV1=> { later_calls+=1; assert!(packet["laterOriginalSpans"].is_array()); assert!(packet.get("packetSha256").is_none()); Ok(legacy_reply(&packet,true)) }
                GenerationSchema::WikiClaimReviewV1(_)|GenerationSchema::AskAnswerReviewV1=>Ok(review_reply(schema,&packet,"supported")),
                GenerationSchema::AskAnswerV1=> { assert_selected_witnesses(&packet); assert_eq!(packet["claimProposals"].as_array().unwrap().len(),4);
                    let sources=packet["sources"].as_array().unwrap().iter().map(|source|source["id"].clone()).collect::<Vec<_>>();
                    Ok(json!({"answer":"사용자의 버튼 추가 요청과 어시스턴트의 초안 준비 보고 이후, 사용자가 결과를 철회했습니다. 실제 검증 결과는 기록되지 않았습니다.","sources":sources}).to_string()) }
                _=>panic!("unexpected resolution schema"),
            }
        },|initial,keys| { let range=request.range.as_ref().unwrap(); let resolution=request.resolution.as_ref().unwrap(); let window=resolution.checked_window(range,captured)?;
            crate::activity_recall::read_resolution(ResolutionRead {root:dir.path(),index:&index,origin:request.origin.as_ref().unwrap(),scope:request.scope,
                paths:None,window:&window,task_keys:keys,initial,include_archived:false},&AtomicBool::new(false)) },
        |sources| { rechecks+=1; crate::activity_recall::recheck_resolution(std::path::Path::new(&request.origin.as_ref().unwrap().vault_path),&sources.revisions,&AtomicBool::new(false)) }).unwrap();
    assert_eq!(later_calls, 1);
    assert_eq!(rechecks, 1);
    assert_eq!(schemas.len(), 6);
    assert!(matches!(
        schemas[0],
        GenerationSchema::WikiSourceFocusClaimsQaV1(_)
    ));
    assert_eq!(schemas[2], GenerationSchema::WikiClaimsV1);
    assert_eq!(reply.receipt.processed_windows, 3);
    assert_eq!(reply.receipt.automated_claim_reviews, 2);
    assert_eq!(reply.receipt.resolution_coverage.unwrap().original_spans, 1);
}

#[test]
fn focus_observer_reports_candidate_final_and_review_actual_inputs_without_deduplicating() {
    let (_dir, mut request, checked, _index) = fixture();
    request.max_tokens = Some(256);
    let measured = RefCell::new(Vec::new());
    let events = RefCell::new(Vec::new());
    let observer = |phase: FocusTokenPhaseQa,
                    system: &str,
                    user: &str,
                    counted: &Result<usize, String>,
                    budget: FocusTokenBudgetQa| {
        assert_measured(&measured, system, user);
        assert_eq!(counted, &Ok(1800));
        events.borrow_mut().push((
            serde_json::to_value(phase).unwrap(),
            system.to_owned(),
            user.to_owned(),
            budget,
        ));
    };
    activity_synthesis_steps_with_resolution_mode_observed(
        &request,
        &checked.evidence,
        checked.originals.as_ref().unwrap(),
        request.origin.as_ref().unwrap(),
        |system, user| count_exact(&measured, system, user),
        |system, user, output, _, schema| {
            assert_measured(&measured, system, user);
            let packet: Value = serde_json::from_str(user).unwrap();
            match schema {
                GenerationSchema::WikiSourceFocusClaimsQaV1(_) => Ok(focus_reply(&packet)),
                GenerationSchema::WikiClaimReviewV1(_) | GenerationSchema::AskAnswerReviewV1 => {
                    Ok(review_reply(schema, &packet, "supported"))
                }
                GenerationSchema::AskAnswerV1 => {
                    assert_eq!(output, 256);
                    Ok(json!({"answer":ANSWER,"sources":["S1"]}).to_string())
                }
                _ => panic!("unexpected observer test schema"),
            }
        },
        |_, _| panic!("no resolution requested"),
        |_| panic!("no recheck requested"),
        true,
        false,
        false,
        false,
        Some(&observer),
    )
    .unwrap();
    let events = events.into_inner();
    assert_eq!(
        events
            .iter()
            .map(|event| event.0.clone())
            .collect::<Vec<_>>(),
        json!([
            "answer_group_candidate",
            "answer_draft_final",
            "final_answer_review"
        ])
        .as_array()
        .unwrap()
        .clone()
    );
    assert_eq!((&events[0].1, &events[0].2), (&events[1].1, &events[1].2));
    assert_ne!(events[1].2, events[2].2);
    for (ordinal, event) in events.iter().enumerate() {
        assert_eq!(
            (
                event.3.context_tokens,
                event.3.output_tokens,
                event.3.reserve
            ),
            (4096, if ordinal == 2 { 768 } else { 256 }, 8)
        );
        let payload: Value = serde_json::from_str(&event.2).unwrap();
        assert_eq!(
            payload["sourceFocusInterpretationRevision"]
                .as_str()
                .unwrap()
                .len(),
            64
        );
    }
}

#[test]
fn focus_observer_keeps_fit_failed_candidates_and_cancelled_counts_before_generation() {
    for failure_stage in 0..4 {
        let (_dir, mut request, checked, _index) = fixture();
        request.max_tokens = Some(256);
        let answer_counts = Cell::new(0);
        let events = RefCell::new(Vec::new());
        let mut schemas = Vec::new();
        let observer = |phase: FocusTokenPhaseQa,
                        _: &str,
                        user: &str,
                        counted: &Result<usize, String>,
                        budget: FocusTokenBudgetQa| {
            events.borrow_mut().push((
                serde_json::to_value(phase).unwrap(),
                counted.clone(),
                budget,
                user.to_owned(),
            ));
        };
        let failure = activity_synthesis_steps_with_resolution_mode_observed(
            &request,
            &checked.evidence,
            checked.originals.as_ref().unwrap(),
            request.origin.as_ref().unwrap(),
            |_, user| {
                let payload: Value = serde_json::from_str(user).unwrap();
                if payload.get("sourceFocusInterpretationRevision").is_some() {
                    if payload.get("sources").is_some() {
                        let next = answer_counts.get() + 1;
                        answer_counts.set(next);
                        if (failure_stage == 0 && next == 1) || (failure_stage == 1 && next == 2) {
                            return Ok(4096 - 256 - 8 + 1);
                        }
                        if failure_stage == 3 && next == 2 {
                            return Err("local generation cancelled".into());
                        }
                    } else if failure_stage == 2 {
                        return Ok(3321);
                    }
                }
                Ok(1000)
            },
            |_, user, _, _, schema| {
                schemas.push(schema);
                let payload: Value = serde_json::from_str(user).unwrap();
                match schema {
                    GenerationSchema::WikiSourceFocusClaimsQaV1(_) => Ok(focus_reply(&payload)),
                    GenerationSchema::WikiClaimReviewV1(_) => {
                        Ok(review_reply(schema, &payload, "supported"))
                    }
                    GenerationSchema::AskAnswerV1 => {
                        Ok(json!({"answer":ANSWER,"sources":["S1"]}).to_string())
                    }
                    _ => panic!("failed size boundary cannot run final review"),
                }
            },
            |_, _| panic!("no resolution requested"),
            |_| panic!("no recheck requested"),
            true,
            false,
            false,
            false,
            Some(&observer),
        )
        .unwrap_err();
        assert_eq!(
            failure.code,
            if failure_stage == 2 {
                "review_not_fit"
            } else {
                "prompt_unavailable"
            }
        );
        assert_eq!(schemas.len(), if failure_stage == 2 { 3 } else { 2 });
        let events = events.into_inner();
        assert_eq!(
            events.len(),
            if failure_stage == 0 {
                1
            } else if failure_stage == 2 {
                3
            } else {
                2
            }
        );
        let last = events.last().unwrap();
        assert_eq!(
            last.0,
            if failure_stage == 0 {
                "answer_group_candidate"
            } else if failure_stage == 2 {
                "final_answer_review"
            } else {
                "answer_draft_final"
            }
        );
        if failure_stage == 3 {
            assert_eq!(last.1, Err("local generation cancelled".into()));
            assert!(failure.detail.contains("local generation cancelled"));
        } else {
            assert!(
                last.1.as_ref().unwrap()
                    > &(last.2.context_tokens as usize
                        - last.2.output_tokens as usize
                        - last.2.reserve)
            );
        }
    }
}

#[path = "review_correction_flow_tests.rs"]
mod correction_tests;

#[path = "named_focus_flow_tests.rs"]
mod named_focus_flow_tests;

#[path = "ordinal_activity_flow_tests.rs"]
mod ordinal_activity_tests;
