use super::*;
use crate::embeddings::chunk_page;
use crate::retrieval::Bm25Index;
use serde_json::{json, Value};
use sha2::Digest;

fn fixture() -> (tempfile::TempDir, Request, super::super::CheckedEvidence) {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("sessions")).unwrap();
    let text="---\nturn_metadata: [{timestamp: '2026-10-03T08:00:00Z', message_id: synthetic-request}, {timestamp: '2026-10-04T08:00:00Z', message_id: synthetic-report}]\n---\n\n**User:**\n\nPlease add a synthetic export button.\n\n**Assistant:**\n\nI prepared the synthetic export draft; actual verification is not recorded.\n";
    std::fs::write(dir.path().join("sessions/synthetic.md"), text).unwrap();
    let chunks = chunk_page(text);
    let mut index = Bm25Index::new();
    index.upsert_page("sessions/synthetic.md", "Synthetic export", &chunks);
    let origin = AgentVaultSession {
        vault_path: dir
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        opening_token: "7".into(),
    };
    let request = Request {
        model_id: None,
        // A pure helper binding, not a native registry-issued execution grant.
        role_snapshot: Some(serde_json::from_value(json!({
            "snapshotId":"synthetic-activity-role", "origin":origin,
            "role":"ask", "usage":"foreground", "authorizationRevision":"synthetic",
            "routeSignature":{"role":"ask", "providerId":"builtin-local",
                "modelId":"qwen3.5-4b-q4_k_m", "effort":"none", "executionLocation":"in-process",
                "artifactRevision":"synthetic", "artifactSha256":"0".repeat(64),
                "runtimeContract":"synthetic-helper-only", "signature":"synthetic-shape-only"}
        })).unwrap()),
        request_id: "synthetic-activity-flow".into(),
        question: "최근 한 일을 정리해줘".into(),
        previous_question: Some("Unrelated old question".into()),
        lang: "ko".into(),
        hits: chunks
            .iter()
            .enumerate()
            .map(|(section, text)| Evidence {
                page: "sessions/synthetic.md".into(),
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
    let checked = super::super::checked_evidence(dir.path(), &index, &request).unwrap();
    (dir, request, checked)
}

fn claims_from_packet(user: &str) -> String {
    let packet: Value = serde_json::from_str(user).unwrap();
    let claims:Vec<_>=packet["originalSpans"].as_array().unwrap().iter().map(|span| {
        let is_user=span["speaker"]=="user";
        json!({"action":if is_user {"Synthetic export was requested."} else {"Assistant reported a draft; final verification is unknown."},
            "anchorSpanId":span["id"],"supportSpanIds":[span["id"]],
            "actor":{"role":span["speaker"],"basis":"speaker","subjectSpanId":null},
            "eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},
            "speechAct":if is_user {"request"} else {"report"},"status":if is_user {"requested"} else {"reported_completed"},"verificationId":null})
    }).collect();
    json!({"outcome":"claims","claims":claims}).to_string()
}

// These verdicts exercise orchestration only. They do not grade model meaning.
fn review_stub(schema: GenerationSchema, user: &str) -> Option<String> {
    match schema {
        GenerationSchema::WikiClaimReviewV1(decisions) => {
            let packet: Value = serde_json::from_str(user).unwrap();
            assert_eq!(decisions.count(), packet["requiredClaimIds"].as_array().unwrap().len());
            Some(json!({"version":"WikiClaimReviewV1",
                "claims":packet["requiredClaimIds"].as_array().unwrap().iter().map(|id|
                    json!({"id":id,"disposition":"supported","reason":"Synthetic plumbing verdict."})).collect::<Vec<_>>(),
                "missingSpanIds":[],"sourceCoverage":"covered"}).to_string())
        }
        GenerationSchema::AskAnswerReviewV1 => Some(json!({"version":"AskAnswerReviewV1",
            "answerDisposition":"supported", "taskResponse":"adequate",
            "sourceCoverage":"covered", "missingSpanIds":[], "reason":"Synthetic plumbing verdict."}).to_string()),
        _ => None,
    }
}

fn assert_period_packet(system: &str, user: &str) {
    use std::collections::BTreeSet;
    assert!(system.contains(period_context::INSTRUCTIONS));
    let packet: Value = serde_json::from_str(user).unwrap();
    let mut originals = Vec::new();
    if let Some(spans) = packet["originalSpans"].as_array() {
        originals.extend(spans.iter());
    } else if let Some(spans) = packet["laterOriginalSpans"].as_array() {
        originals.extend(packet["initialOriginalSpans"].as_array().unwrap().iter());
        originals.extend(spans.iter());
    } else {
        originals.extend(
            packet["sources"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|source| source["originalSpans"].as_array().unwrap().iter()),
        );
    }
    let expected: BTreeSet<_> = originals
        .iter()
        .map(|span| span["id"].as_str().unwrap())
        .collect();
    let sidecar = &packet["recordPeriodContext"];
    assert_eq!(sidecar["version"], period_context::VERSION);
    let entries = sidecar["spans"].as_array().unwrap();
    let actual: BTreeSet<_> = entries
        .iter()
        .map(|span| span["spanId"].as_str().unwrap())
        .collect();
    assert_eq!(actual, expected);
    assert_eq!(actual.len(), entries.len());
    let counts = &sidecar["counts"];
    let total: u64 = ["inPeriodSpans", "outsidePeriodSpans", "uncertainSpans"]
        .iter()
        .map(|name| counts[name].as_u64().unwrap())
        .sum();
    assert_eq!(total as usize, expected.len());
}

#[test]
fn activity_production_flow_binds_originals_then_uses_both_closed_schemas_with_honest_receipt() {
    let (_dir, request, checked) = fixture();
    let original = checked.originals.as_ref().unwrap();
    let mut calls = Vec::new();
    let tokenized = std::cell::RefCell::new(Vec::new());
    let reply=activity_synthesis_steps(&request,&checked.evidence,original,request.origin.as_ref().unwrap(),|system,user| {
            assert_period_packet(system,user);
            tokenized.borrow_mut().push((system.to_owned(),user.to_owned()));
            Ok(1800)
        },
        |system,user,tokens,context,schema| {
            assert_period_packet(system,user);
            assert!(tokenized.borrow().iter().any(|(checked_system, checked_user)| checked_system == system && checked_user == user));
            calls.push(schema);
            assert_eq!((tokens,context),(768,4096));
            if let Some(review) = review_stub(schema, user) { return Ok(review); }
            let packet:Value=serde_json::from_str(user).unwrap();
            assert_eq!(packet["activityPeriod"]["start"],"2026-10-03");
            assert_eq!(packet["activityPeriod"]["end"],"2026-10-04");
            assert!(!user.contains("Unrelated old question"));
            match schema {
                GenerationSchema::WikiClaimsV1=>Ok(claims_from_packet(user)),
                GenerationSchema::AskAnswerV1=> {
                    assert_eq!(packet["claimProposals"][0]["status"],"requested");
                    assert_eq!(packet["claimProposals"][1]["status"],"reported_completed");
                    assert_eq!(packet["sources"][0]["originalSpans"][0]["speaker"],"user");
                    assert_eq!(packet["sources"][0]["originalSpans"][1]["speaker"],"assistant");
                    assert_eq!(packet["semanticReviewRequired"],true);
                    Ok(r#"{"answer":"내보내기 버튼을 요청했고, 어시스턴트가 초안을 준비했다고 보고했습니다. 실제 검증 결과는 기록에서 확인되지 않습니다.","sources":["S1"]}"#.into())
                }
                GenerationSchema::SessionCompilationV1
                | GenerationSchema::SessionStructureV1
                | GenerationSchema::SessionReviewV1 => {
                    panic!("activity Ask must not dispatch a session compilation schema")
                }
                GenerationSchema::WikiClaimReviewV1(_) | GenerationSchema::AskAnswerReviewV1 => unreachable!(),
                #[cfg(feature = "native-index-probe")]
                GenerationSchema::WikiClaimReviewReasonFirstQaV1(_)
                | GenerationSchema::WikiClaimFieldReviewQaV1
                | GenerationSchema::WikiClaimsCompactQaV1(_)
                | GenerationSchema::WikiSourceFocusClaimsQaV1(_)
                | GenerationSchema::WikiQuotedClaimsQaV1
                | GenerationSchema::NativeSourceInterpretationQaV1(_)
                | GenerationSchema::NativeSourceInterpretationCandidateQa(_)
                | GenerationSchema::NativeActivityTypesQaV2(_)
                | GenerationSchema::WikiSourceCoverageQaV1 => {
                    panic!("production activity Ask must not dispatch the QA-only review schema")
                }
            }
        }).unwrap();
    assert_eq!(
        calls,
        vec![
            GenerationSchema::WikiClaimsV1,
            GenerationSchema::WikiClaimReviewV1(crate::local_llm::ReviewDecisions::new(2).unwrap()),
            GenerationSchema::AskAnswerV1,
            GenerationSchema::AskAnswerReviewV1,
        ]
    );
    assert_eq!(reply.used_sources, vec!["sessions/synthetic.md"]);
    assert_eq!(
        (
            reply.receipt.eligible_original_spans,
            reply.receipt.processed_windows,
            reply.receipt.omitted_windows
        ),
        (2, 2, 0)
    );
    assert_eq!(
        (
            reply.receipt.proposed_claims,
            reply.receipt.selected_claims,
            reply.receipt.omitted_claims
        ),
        (2, 2, 0)
    );
    assert!(reply.receipt.semantic_review_required);
    assert_eq!(reply.receipt.automated_claim_reviews, 1);
    assert_eq!(
        reply.receipt.automated_answer_review_input_revision.len(),
        64
    );
    assert_eq!(reply.receipt.independent_verification_receipts, 0);
    assert_eq!(
        reply.receipt.original_period_counts,
        PeriodSpanCounts {
            in_period_spans: 2,
            outside_period_spans: 0,
            uncertain_spans: 0
        }
    );
    assert_eq!(
        reply.receipt.answer_period_counts,
        reply.receipt.original_period_counts
    );
    assert!(reply.receipt.resolution_window.is_none());
}

#[test]
fn source_reading_default_flow_retains_flat_custody_and_reuses_exact_fit_inputs() {
    let (_dir, request, checked) = fixture();
    let original = checked.originals.as_ref().unwrap();
    let captured: Vec<Value> = original
        .spans()
        .map(|span| serde_json::to_value(span).unwrap())
        .collect();
    let windows = original
        .windowed(|span| Ok(vec![span.text().to_owned()]))
        .unwrap();
    let expected: Vec<Value> = windows
        .spans()
        .map(|span| serde_json::to_value(span).unwrap())
        .collect();
    assert_eq!(captured[0]["turnTime"], "2026-10-03T08:00:00Z");
    assert_eq!(captured[1]["turnTime"], "2026-10-04T08:00:00Z");
    assert!(captured
        .iter()
        .all(|span| span["sourcePhase"].is_null() && span["recordTime"].is_null()));
    assert!(captured[1]["text"]
        .as_str()
        .unwrap()
        .contains("actual verification is not recorded"));
    let tokenized = std::cell::RefCell::new(Vec::new());
    let mut calls = Vec::new();
    // Synthetic callbacks verify presentation and orchestration, not meaning.
    let reply = activity_synthesis_steps(
        &request,
        &checked.evidence,
        original,
        request.origin.as_ref().unwrap(),
        |system, user| {
            assert_period_packet(system, user);
            let packet: Value = serde_json::from_str(user).unwrap();
            let count = if packet["allowedSpanIds"].is_array()
                && packet["originalSpans"].as_array().unwrap().len() > 1
            {
                3321usize
            } else {
                3320usize
            };
            tokenized
                .borrow_mut()
                .push((system.to_owned(), user.to_owned(), count));
            Ok(count)
        },
        |system, user, tokens, context, schema| {
            assert_period_packet(system, user);
            assert_eq!((tokens, context), (768, 4096));
            assert!(tokenized.borrow().iter().any(
                |(fit_system, fit_user, count)| fit_system == system
                    && fit_user == user
                    && *count <= 3320
            ));
            calls.push(schema);
            let packet: Value = serde_json::from_str(user).unwrap();
            match schema {
                GenerationSchema::WikiClaimsV1 => {
                    let spans = packet["originalSpans"].as_array().unwrap();
                    assert_eq!(spans.len(), 1, "over-budget pairs must become batches");
                    assert!(spans[0]["sourceContext"].is_object());
                    assert!(spans[0]["provenance"].is_object());
                    let span = &spans[0];
                    let source_context = &span["sourceContext"];
                    let provenance = &span["provenance"];
                    let restored = json!({
                        "id":span["id"], "speaker":span["speaker"], "text":span["text"],
                        "turnId":source_context["turnId"], "turnTime":source_context["turnTime"],
                        "sourcePhase":source_context["sourcePhase"], "recordTime":source_context["recordTime"],
                        "sourceId":provenance["sourceId"], "sourcePath":provenance["sourcePath"],
                        "selectionPath":provenance["selectionPath"], "sourceRevision":provenance["sourceRevision"],
                        "start":provenance["start"], "end":provenance["end"], "sha256":provenance["sha256"]
                    });
                    let native = expected
                        .iter()
                        .find(|native| native["id"] == span["id"])
                        .unwrap();
                    assert_eq!(&restored, native);
                    Ok(claims_from_packet(user))
                }
                GenerationSchema::WikiClaimReviewV1(_) => {
                    let spans = packet["originalSpans"].as_array().unwrap();
                    assert_eq!(spans.len(), 1);
                    let native = expected
                        .iter()
                        .find(|span| span["id"] == spans[0]["id"])
                        .unwrap();
                    assert_eq!(&spans[0], native);
                    assert_eq!(native.as_object().unwrap().len(), 14);
                    assert!(native.get("sourceContext").is_none());
                    Ok(review_stub(schema, user).unwrap())
                }
                GenerationSchema::AskAnswerV1 => {
                    assert_eq!(
                        packet["sources"][0]["originalSpans"],
                        Value::Array(expected.clone())
                    );
                    assert_eq!(packet["semanticReviewRequired"], true);
                    Ok(r#"{"answer":"내보내기 버튼을 요청했고, 어시스턴트가 초안 준비를 보고했습니다. 실제 검증은 기록되지 않았습니다.","sources":["S1"]}"#.into())
                }
                GenerationSchema::AskAnswerReviewV1 => {
                    assert_eq!(packet["originalSpans"], Value::Array(expected.clone()));
                    Ok(review_stub(schema, user).unwrap())
                }
                _ => panic!("default source-reading flow must retain its closed schemas"),
            }
        },
    )
    .unwrap();
    let mut fitted_sizes = std::collections::BTreeSet::new();
    for (_, user, _) in tokenized.borrow().iter() {
        let packet: Value = serde_json::from_str(user).unwrap();
        if !packet["allowedSpanIds"].is_array() {
            continue;
        }
        let spans = packet["originalSpans"].as_array().unwrap();
        fitted_sizes.insert(spans.len());
        for span in spans {
            let fields: std::collections::BTreeSet<_> = span
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect();
            assert_eq!(
                fields,
                ["id", "speaker", "text", "sourceContext", "provenance"]
                    .into_iter()
                    .collect::<std::collections::BTreeSet<_>>()
            );
            let source_context = &span["sourceContext"];
            let provenance = &span["provenance"];
            assert_eq!(
                source_context
                    .as_object()
                    .unwrap()
                    .keys()
                    .map(String::as_str)
                    .collect::<std::collections::BTreeSet<_>>(),
                ["turnId", "turnTime", "sourcePhase", "recordTime"]
                    .into_iter()
                    .collect::<std::collections::BTreeSet<_>>()
            );
            assert_eq!(
                provenance
                    .as_object()
                    .unwrap()
                    .keys()
                    .map(String::as_str)
                    .collect::<std::collections::BTreeSet<_>>(),
                [
                    "sourceId",
                    "sourcePath",
                    "selectionPath",
                    "sourceRevision",
                    "start",
                    "end",
                    "sha256",
                ]
                .into_iter()
                .collect::<std::collections::BTreeSet<_>>()
            );
            let restored = json!({
                "id":span["id"], "speaker":span["speaker"], "text":span["text"],
                "turnId":source_context["turnId"], "turnTime":source_context["turnTime"],
                "sourcePhase":source_context["sourcePhase"], "recordTime":source_context["recordTime"],
                "sourceId":provenance["sourceId"], "sourcePath":provenance["sourcePath"],
                "selectionPath":provenance["selectionPath"], "sourceRevision":provenance["sourceRevision"],
                "start":provenance["start"], "end":provenance["end"], "sha256":provenance["sha256"]
            });
            // Token fitting also visits temporary partial windows that are
            // never served. Their IDs need not be final full-window IDs.
            let id = restored["id"].as_str().unwrap();
            let suffix = id.strip_prefix("Q-").unwrap();
            assert_eq!(suffix.len(), 32);
            assert!(suffix
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
            let start = restored["start"].as_u64().unwrap();
            let end = restored["end"].as_u64().unwrap();
            assert!(start < end);
            let sources: Vec<_> = captured
                .iter()
                .filter(|source| {
                    source["sourceId"] == restored["sourceId"]
                        && source["turnId"] == restored["turnId"]
                        && source["start"].as_u64().unwrap() <= start
                        && end <= source["end"].as_u64().unwrap()
                })
                .collect();
            assert_eq!(sources.len(), 1);
            let source = sources[0];
            for key in [
                "speaker",
                "turnId",
                "turnTime",
                "sourcePhase",
                "recordTime",
                "sourceId",
                "sourcePath",
                "selectionPath",
                "sourceRevision",
            ] {
                assert_eq!(restored[key], source[key]);
            }
            let source_start = source["start"].as_u64().unwrap();
            let fragment = source["text"]
                .as_str()
                .unwrap()
                .get(
                    usize::try_from(start - source_start).unwrap()
                        ..usize::try_from(end - source_start).unwrap(),
                )
                .unwrap();
            assert_eq!(
                restored["text"].as_str().unwrap().as_bytes(),
                fragment.as_bytes()
            );
            assert_eq!(fragment.len(), usize::try_from(end - start).unwrap());
            assert_eq!(
                restored["sha256"].as_str().unwrap(),
                format!("{:x}", sha2::Sha256::digest(fragment.as_bytes()))
            );
        }
    }
    assert_eq!(
        fitted_sizes,
        [1usize, 2]
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>()
    );
    assert_eq!(
        calls,
        vec![
            GenerationSchema::WikiClaimsV1,
            GenerationSchema::WikiClaimReviewV1(crate::local_llm::ReviewDecisions::new(1).unwrap()),
            GenerationSchema::WikiClaimsV1,
            GenerationSchema::WikiClaimReviewV1(crate::local_llm::ReviewDecisions::new(1).unwrap()),
            GenerationSchema::AskAnswerV1,
            GenerationSchema::AskAnswerReviewV1,
        ]
    );
    assert_eq!(reply.receipt.extraction_batches, 2);
    assert_eq!(reply.receipt.automated_claim_reviews, 2);
    assert_eq!(reply.receipt.processed_windows, 2);
    assert_eq!(reply.receipt.omitted_windows, 0);
    assert_eq!(reply.receipt.independent_verification_receipts, 0);
    assert_eq!(
        original
            .spans()
            .map(|span| serde_json::to_value(span).unwrap())
            .collect::<Vec<_>>(),
        captured
    );
}

#[test]
fn absent_claims_are_explicit_insufficient_and_never_replaced_by_quote_success() {
    let (_dir, request, checked) = fixture();
    let mut calls = 0;
    let result = activity_synthesis_steps(
        &request,
        &checked.evidence,
        checked.originals.as_ref().unwrap(),
        request.origin.as_ref().unwrap(),
        |_, _| Ok(1000),
        |_, user, _, _, schema| {
            calls += 1;
            if let Some(review) = review_stub(schema, user) {
                return Ok(review);
            }
            assert_eq!(schema, GenerationSchema::WikiClaimsV1);
            Ok(r#"{"outcome":"insufficient_evidence","claims":[]}"#.into())
        },
    );
    assert_eq!(calls, 2);
    assert_eq!(result.unwrap_err().code, "activity_insufficient_evidence");
}

#[test]
fn extraction_failure_preserves_detail_and_prevents_answer_generation() {
    let (_dir, request, checked) = fixture();
    let result = activity_synthesis_steps(
        &request,
        &checked.evidence,
        checked.originals.as_ref().unwrap(),
        request.origin.as_ref().unwrap(),
        |_, _| Ok(1000),
        |_, _, _, _, schema| {
            assert_eq!(schema, GenerationSchema::WikiClaimsV1);
            Err("synthetic generation cancelled".into())
        },
    );
    let failure = result.unwrap_err();
    assert_eq!(failure.code, "claim_extraction_failed");
    assert_eq!(failure.detail, "synthetic generation cancelled");
}

#[test]
fn inadequate_or_unreviewed_answer_never_becomes_quote_or_count_success() {
    let (_dir, request, checked) = fixture();
    for (verdict, expected_code) in [
        (Some("inadequate"), "review_rejected"),
        (Some("uncertain"), "review_uncertain"),
        (None, "review_unavailable"),
    ] {
        let mut calls = Vec::new();
        let result = activity_synthesis_steps(
            &request,
            &checked.evidence,
            checked.originals.as_ref().unwrap(),
            request.origin.as_ref().unwrap(),
            |_, _| Ok(1000),
            |_, user, _, _, schema| {
                calls.push(schema);
                if schema == GenerationSchema::AskAnswerReviewV1 {
                    let Some(task_response) = verdict else {
                        return Err("synthetic review model unavailable".into());
                    };
                    let packet: Value = serde_json::from_str(user).unwrap();
                    assert!(packet.to_string().contains("598"));
                    return Ok(json!({"version":"AskAnswerReviewV1",
                        "answerDisposition":"supported", "taskResponse":task_response,
                        "sourceCoverage":"covered", "missingSpanIds":[],
                        "reason":"Synthetic inadequate-answer plumbing verdict."})
                    .to_string());
                }
                if let Some(review) = review_stub(schema, user) {
                    return Ok(review);
                }
                match schema {
                    GenerationSchema::WikiClaimsV1 => Ok(claims_from_packet(user)),
                    GenerationSchema::AskAnswerV1 => {
                        Ok(r#"{"answer":"현재 598개의 항목이 있습니다.","sources":["S1"]}"#.into())
                    }
                    _ => panic!("unexpected activity schema"),
                }
            },
        );
        assert_eq!(result.unwrap_err().code, expected_code);
        assert_eq!(
            calls,
            vec![
                GenerationSchema::WikiClaimsV1,
                GenerationSchema::WikiClaimReviewV1(
                    crate::local_llm::ReviewDecisions::new(2).unwrap()
                ),
                GenerationSchema::AskAnswerV1,
                GenerationSchema::AskAnswerReviewV1
            ]
        );
    }
}

#[test]
fn activity_without_captured_role_fails_before_tokenization_or_generation() {
    let (_dir, mut request, checked) = fixture();
    request.role_snapshot = None;
    let result = activity_synthesis_steps(
        &request,
        &checked.evidence,
        checked.originals.as_ref().unwrap(),
        request.origin.as_ref().unwrap(),
        |_, _| panic!("unbound role must not tokenize"),
        |_, _, _, _, _| panic!("unbound role must not generate"),
    );
    assert_eq!(result.unwrap_err().code, "source_verification_failed");
}

#[test]
fn stale_opening_or_wrong_scope_fails_before_tokenization_and_generation() {
    let (_dir, mut request, checked) = fixture();
    let stale = AgentVaultSession {
        opening_token: "8".into(),
        ..request.origin.clone().unwrap()
    };
    for current in [&stale, request.origin.as_ref().unwrap()] {
        if current.opening_token == "7" {
            request.scope = Scope::Wiki;
        }
        assert_eq!(
            activity_synthesis_steps(
                &request,
                &checked.evidence,
                checked.originals.as_ref().unwrap(),
                current,
                |_, _| panic!("unbound request must not tokenize"),
                |_, _, _, _, _| panic!("unbound request must not generate")
            )
            .unwrap_err()
            .code,
            "source_verification_failed"
        );
    }
}

fn resolution_fixture(
    mode: crate::activity_recall::ResolutionMode,
) -> (
    tempfile::TempDir,
    Request,
    super::super::CheckedEvidence,
    Bm25Index,
) {
    let (dir, mut request, checked) = fixture();
    let captured = crate::importers::parse_iso8601("2026-10-08T12:00:00Z").unwrap();
    request.resolution = Some(crate::activity_recall::ResolutionRequest {
        mode,
        as_of_epoch: if mode == crate::activity_recall::ResolutionMode::CurrentState {
            captured
        } else {
            crate::importers::parse_iso8601("2026-10-05T00:00:00Z").unwrap() - 1
        },
        captured_query_epoch: captured,
    });
    let mut index = Bm25Index::new();
    let initial = std::fs::read_to_string(dir.path().join("sessions/synthetic.md")).unwrap();
    index.upsert_page(
        "sessions/synthetic.md",
        "Synthetic export",
        &chunk_page(&initial),
    );
    for (path,date,role,body) in [
        ("sessions/later-completed.md","2026-10-05T08:00:00Z","Assistant","I reported the synthetic export button completed; independent verification is unrecorded."),
        ("sessions/later-rejected.md","2026-10-06T08:00:00Z","User","The synthetic export button result is rejected; I retract that completion."),
        ("sessions/later-resumed.md","2026-10-07T08:00:00Z","User","Please resume work on the synthetic export button after the rejection.")
    ] {
        let phase=if role=="Assistant" {"commentary"} else {"final"};
        let text=format!("---\nturn_metadata: [{{timestamp: '{date}', original_role: {}, phase: {phase}}}]\n---\n\n**{role}:**\n\n{body}\n",role.to_ascii_lowercase());
        std::fs::write(dir.path().join(path),&text).unwrap();index.upsert_page(path,"Synthetic later state",&chunk_page(&text));
    }
    (dir, request, checked, index)
}
fn later_claims(user: &str) -> String {
    let packet: Value = serde_json::from_str(user).unwrap();
    let key = &packet["taskKeys"][0]["anchorSpanId"];
    let claims:Vec<_>=packet["laterOriginalSpans"].as_array().unwrap().iter().map(|span| {
        let text=span["text"].as_str().unwrap();
        let (act,status)=if text.contains("Please resume") {("request","requested")}
            else if text.contains("retract") {("retraction","retracted")} else {("report","reported_completed")};
        json!({"action":text,"anchorSpanId":span["id"],"supportSpanIds":[key,span["id"]],
            "actor":{"role":span["speaker"],"basis":"speaker","subjectSpanId":null},
            "eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},
            "speechAct":act,"status":status,"verificationId":null})
    }).collect();
    json!({"outcome":"claims","claims":claims}).to_string()
}
fn native_resolution(
    dir: &tempfile::TempDir,
    index: &Bm25Index,
    request: &Request,
    initial: &SourceSet,
    keys: &[crate::activity_recall::ResolutionTaskKey],
) -> Result<crate::activity_recall::ResolutionSources, String> {
    let resolution = request.resolution.as_ref().unwrap();
    let range = request.range.as_ref().unwrap();
    let window = resolution.checked_window(range, resolution.captured_query_epoch)?;
    crate::activity_recall::read_resolution(
        crate::activity_recall::ResolutionRead {
            root: dir.path(),
            index,
            origin: request.origin.as_ref().unwrap(),
            scope: request.scope,
            paths: request.paths.as_deref(),
            window: &window,
            task_keys: keys,
            initial,
            include_archived: false,
        },
        &std::sync::atomic::AtomicBool::new(false),
    )
}

fn native_recheck(
    request: &Request,
    sources: &crate::activity_recall::ResolutionSources,
) -> Result<(), String> {
    // Production passes the canonical root bound to its native opening. A
    // TempDir path can be a /var alias on macOS and is not that root contract.
    crate::activity_recall::recheck_resolution(
        std::path::Path::new(&request.origin.as_ref().unwrap().vault_path),
        &sources.revisions,
        &std::sync::atomic::AtomicBool::new(false),
    )
}

#[test]
fn resolution_flow_reads_outside_initial_pages_keeps_retraction_resume_and_app_citation_lineage() {
    let (dir, request, checked, index) =
        resolution_fixture(crate::activity_recall::ResolutionMode::CurrentState);
    let mut schemas = Vec::new();
    let tokenized = std::cell::RefCell::new(Vec::new());
    let reply=activity_synthesis_steps_with_resolution(&request,&checked.evidence,checked.originals.as_ref().unwrap(),request.origin.as_ref().unwrap(),|system,user| {
            assert_period_packet(system,user);
            tokenized.borrow_mut().push((system.to_owned(),user.to_owned()));
            Ok(1800)
        },
        |system,user,_,_,schema| {
            assert_period_packet(system,user);
            assert!(tokenized.borrow().iter().any(|(checked_system, checked_user)|checked_system == system && checked_user == user));
            schemas.push(schema);
            if let Some(review) = review_stub(schema, user) { return Ok(review); }
            let packet:Value=serde_json::from_str(user).unwrap();
            if schema==GenerationSchema::WikiClaimsV1 {
                return Ok(if packet["laterOriginalSpans"].is_array() {later_claims(user)} else {claims_from_packet(user)});
            }
            assert_eq!(packet["activityPeriod"]["end"],"2026-10-04");
            assert_eq!(packet["resolutionWindow"]["mode"],"current_state");
            assert!(packet["claimProposals"].as_array().unwrap().iter().any(|claim|claim["status"]=="retracted"));
            assert!(packet["claimProposals"].as_array().unwrap().iter().any(|claim|claim["speechAct"]=="request" && claim["action"].as_str().unwrap().contains("resume")));
            assert!(packet["sources"].as_array().unwrap().iter().flat_map(|source|source["originalSpans"].as_array().unwrap()).any(|span|span["sourcePhase"]=="commentary" && span["speaker"]=="assistant"));
            let sources:Vec<_>=packet["sources"].as_array().unwrap().iter().map(|source|source["id"].clone()).collect();
            Ok(json!({"answer":"어시스턴트의 완료 보고 이후 사용자가 결과를 철회하고 작업 재개를 요청했습니다. 우선 거부된 결과를 확인하고 재개 범위를 정하는 것이 좋습니다.","sources":sources}).to_string())
        },|initial,keys|native_resolution(&dir,&index,&request,initial,keys),
        |sources|native_recheck(&request,sources)).unwrap();
    assert_eq!(
        schemas,
        vec![
            GenerationSchema::WikiClaimsV1,
            GenerationSchema::WikiClaimReviewV1(crate::local_llm::ReviewDecisions::new(2).unwrap()),
            GenerationSchema::WikiClaimsV1,
            GenerationSchema::WikiClaimReviewV1(crate::local_llm::ReviewDecisions::new(2).unwrap()),
            GenerationSchema::WikiClaimsV1,
            GenerationSchema::WikiClaimReviewV1(crate::local_llm::ReviewDecisions::new(1).unwrap()),
            GenerationSchema::AskAnswerV1,
            GenerationSchema::AskAnswerReviewV1,
        ]
    );
    assert_eq!(reply.receipt.activity_period.end, "2026-10-04");
    assert_eq!(
        reply
            .receipt
            .resolution_coverage
            .as_ref()
            .unwrap()
            .original_spans,
        3
    );
    assert_eq!(reply.receipt.additional_sources.len(), 3);
    assert_eq!(
        reply.receipt.original_period_counts,
        PeriodSpanCounts {
            in_period_spans: 2,
            outside_period_spans: 3,
            uncertain_spans: 0
        }
    );
    assert_eq!(
        reply.receipt.answer_period_counts,
        reply.receipt.original_period_counts
    );
    assert!(reply
        .receipt
        .additional_sources
        .iter()
        .all(|source| source.origin.opening_token
            == request.origin.as_ref().unwrap().opening_token
            && source.scope == request.scope));
    for declaration in &reply.receipt.additional_sources {
        assert!(reply.used_sources.contains(&declaration.citation_page));
        for lineage in &declaration.lineage {
            let raw = std::fs::read_to_string(dir.path().join(&lineage.source_path)).unwrap();
            assert_eq!(
                lineage.source_revision,
                format!("{:x}", sha2::Sha256::digest(raw.as_bytes()))
            );
            for span in &lineage.spans {
                assert_eq!(
                    span.sha256,
                    format!(
                        "{:x}",
                        sha2::Sha256::digest(&raw.as_bytes()[span.start..span.end])
                    )
                );
            }
        }
    }
    assert!(reply.receipt.semantic_review_required);
    assert_eq!(reply.receipt.independent_verification_receipts, 0);
}

#[test]
fn historical_flow_keeps_period_and_never_supplies_future_resolution_to_the_model() {
    let (dir, request, checked, index) =
        resolution_fixture(crate::activity_recall::ResolutionMode::HistoricalAsOf);
    let mut later_calls = 0;
    let reply=activity_synthesis_steps_with_resolution(&request,&checked.evidence,checked.originals.as_ref().unwrap(),request.origin.as_ref().unwrap(),|_,_|Ok(1800),
        |_,user,_,_,schema| {
            if let Some(review) = review_stub(schema, user) { return Ok(review); }
            let packet:Value=serde_json::from_str(user).unwrap();
            if schema==GenerationSchema::WikiClaimsV1 {
                if packet["laterOriginalSpans"].is_array() {later_calls+=1;}
                return Ok(claims_from_packet(user));
            }
            assert_eq!(packet["resolutionWindow"]["mode"],"historical_as_of");
            assert!(!user.contains("retract that completion"));assert!(!user.contains("Please resume work"));
            Ok(r#"{"answer":"해당 기간에 내보내기 버튼을 요청했고 어시스턴트가 초안 준비를 보고했습니다. 당시의 실제 검증 결과는 기록에서 확인되지 않습니다.","sources":["S1"]}"#.into())
        },|initial,keys|native_resolution(&dir,&index,&request,initial,keys),
        |sources|crate::activity_recall::recheck_resolution(dir.path(),&sources.revisions,&std::sync::atomic::AtomicBool::new(false))).unwrap();
    assert_eq!(later_calls, 0);
    assert!(reply.receipt.additional_sources.is_empty());
    assert_eq!(
        reply
            .receipt
            .resolution_coverage
            .as_ref()
            .unwrap()
            .excluded_after_as_of_spans,
        3
    );
}

#[test]
fn changed_later_source_is_rechecked_even_after_answer_generation_fails() {
    let (dir, request, checked, index) =
        resolution_fixture(crate::activity_recall::ResolutionMode::CurrentState);
    let rechecked = std::cell::Cell::new(false);
    let result = activity_synthesis_steps_with_resolution(
        &request,
        &checked.evidence,
        checked.originals.as_ref().unwrap(),
        request.origin.as_ref().unwrap(),
        |_, _| Ok(1800),
        |_, user, _, _, schema| {
            if let Some(review) = review_stub(schema, user) {
                return Ok(review);
            }
            if schema == GenerationSchema::WikiClaimsV1 {
                let packet: Value = serde_json::from_str(user).unwrap();
                return Ok(if packet["laterOriginalSpans"].is_array() {
                    later_claims(user)
                } else {
                    claims_from_packet(user)
                });
            }
            std::fs::write(
                dir.path().join("sessions/later-rejected.md"),
                "Synthetic changed original during failed generation.",
            )
            .unwrap();
            Err("synthetic answer generation failed".into())
        },
        |initial, keys| native_resolution(&dir, &index, &request, initial, keys),
        |sources| {
            rechecked.set(true);
            native_recheck(&request, sources)
        },
    );
    assert!(rechecked.get());
    let failure = result.unwrap_err();
    assert_eq!(failure.code, "source_changed_during_generation");
    assert_eq!(
        failure.detail,
        "resolution source changed during generation"
    );
}

#[test]
fn changed_later_source_is_rechecked_after_answer_review_failure() {
    let (dir, request, checked, index) =
        resolution_fixture(crate::activity_recall::ResolutionMode::CurrentState);
    let rechecked = std::cell::Cell::new(false);
    let result = activity_synthesis_steps_with_resolution(
        &request,
        &checked.evidence,
        checked.originals.as_ref().unwrap(),
        request.origin.as_ref().unwrap(),
        |_, _| Ok(1800),
        |_, user, _, _, schema| {
            if schema == GenerationSchema::AskAnswerReviewV1 {
                std::fs::write(
                    dir.path().join("sessions/later-rejected.md"),
                    "Synthetic changed original during failed review.",
                )
                .unwrap();
                return Err("synthetic answer review unavailable".into());
            }
            if let Some(review) = review_stub(schema, user) {
                return Ok(review);
            }
            if schema == GenerationSchema::WikiClaimsV1 {
                let packet: Value = serde_json::from_str(user).unwrap();
                return Ok(if packet["laterOriginalSpans"].is_array() {
                    later_claims(user)
                } else {
                    claims_from_packet(user)
                });
            }
            assert_eq!(schema, GenerationSchema::AskAnswerV1);
            Ok(r#"{"answer":"내보내기 버튼의 완료 보고가 있었지만 사용자가 철회했습니다. 현재 결과는 별도로 확인해야 합니다.","sources":["S1"]}"#.into())
        },
        |initial, keys| native_resolution(&dir, &index, &request, initial, keys),
        |sources| {
            rechecked.set(true);
            native_recheck(&request, sources)
        },
    );
    assert!(rechecked.get());
    let failure = result.unwrap_err();
    assert_eq!(failure.code, "source_changed_during_generation");
    assert_eq!(
        failure.detail,
        "resolution source changed during generation"
    );
}

#[test]
fn late_relation_without_initial_support_fails_without_quote_success_and_still_rechecks() {
    let (dir, request, checked, index) =
        resolution_fixture(crate::activity_recall::ResolutionMode::CurrentState);
    let rechecked = std::cell::Cell::new(false);
    let result = activity_synthesis_steps_with_resolution(
        &request,
        &checked.evidence,
        checked.originals.as_ref().unwrap(),
        request.origin.as_ref().unwrap(),
        |_, _| Ok(1800),
        |_, user, _, _, schema| {
            if let Some(review) = review_stub(schema, user) {
                return Ok(review);
            }
            assert_eq!(schema, GenerationSchema::WikiClaimsV1);
            let packet: Value = serde_json::from_str(user).unwrap();
            if !packet["laterOriginalSpans"].is_array() {
                return Ok(claims_from_packet(user));
            }
            let mut claims: Value = serde_json::from_str(&later_claims(user)).unwrap();
            for claim in claims["claims"].as_array_mut().unwrap() {
                claim["supportSpanIds"] = json!([claim["anchorSpanId"]]);
            }
            Ok(claims.to_string())
        },
        |initial, keys| native_resolution(&dir, &index, &request, initial, keys),
        |sources| {
            rechecked.set(true);
            native_recheck(&request, sources)
        },
    );
    assert!(rechecked.get());
    assert_eq!(result.unwrap_err().code, "claim_extraction_failed");
}

#[test]
fn answer_context_cannot_drop_retraction_and_keep_the_historical_request_group() {
    let (dir, request, checked, index) =
        resolution_fixture(crate::activity_recall::ResolutionMode::CurrentState);
    let result = activity_synthesis_steps_with_resolution(
        &request,
        &checked.evidence,
        checked.originals.as_ref().unwrap(),
        request.origin.as_ref().unwrap(),
        |_, user| {
            let packet: Value = serde_json::from_str(user).unwrap();
            Ok(
                if packet["claimProposals"].is_array() && user.contains("retract that completion") {
                    4000
                } else {
                    1800
                },
            )
        },
        |_, user, _, _, schema| {
            if let Some(review) = review_stub(schema, user) {
                return Ok(review);
            }
            assert_eq!(schema, GenerationSchema::WikiClaimsV1);
            let packet: Value = serde_json::from_str(user).unwrap();
            Ok(if packet["laterOriginalSpans"].is_array() {
                later_claims(user)
            } else {
                claims_from_packet(user)
            })
        },
        |initial, keys| native_resolution(&dir, &index, &request, initial, keys),
        |sources| native_recheck(&request, sources),
    );
    assert_eq!(result.unwrap_err().code, "prompt_unavailable");
}

#[test]
fn explicit_resolution_requires_native_hooks_in_the_shared_helper() {
    let (_dir, request, checked, _index) =
        resolution_fixture(crate::activity_recall::ResolutionMode::CurrentState);
    let result = activity_synthesis_steps(
        &request,
        &checked.evidence,
        checked.originals.as_ref().unwrap(),
        request.origin.as_ref().unwrap(),
        |_, _| Ok(1800),
        |_, user, _, _, schema| {
            if let Some(review) = review_stub(schema, user) {
                return Ok(review);
            }
            assert_eq!(schema, GenerationSchema::WikiClaimsV1);
            Ok(claims_from_packet(user))
        },
    );
    assert_eq!(result.unwrap_err().code, "source_verification_failed");
}

#[test]
fn after_as_of_initial_original_fails_before_tokenization_or_generation() {
    let (_dir, mut request, checked, _index) =
        resolution_fixture(crate::activity_recall::ResolutionMode::HistoricalAsOf);
    request.range.as_mut().unwrap().end = "2026-10-03".into();
    request.resolution.as_mut().unwrap().as_of_epoch =
        crate::importers::parse_iso8601("2026-10-04T00:00:00Z").unwrap() - 1;
    let result = activity_synthesis_steps_with_resolution(
        &request,
        &checked.evidence,
        checked.originals.as_ref().unwrap(),
        request.origin.as_ref().unwrap(),
        |_, _| panic!("future original must not tokenize"),
        |_, _, _, _, _| panic!("future original must not generate"),
        |_, _| panic!("future original must not retrieve resolution"),
        |_| panic!("future original must not publish"),
    );
    assert_eq!(result.unwrap_err().code, "source_verification_failed");
}

#[test]
fn date_only_initial_original_crossing_as_of_fails_before_model_work() {
    let (_dir, mut request, checked, _index) =
        resolution_fixture(crate::activity_recall::ResolutionMode::HistoricalAsOf);
    request.range.as_mut().unwrap().end = "2026-10-03".into();
    let captured = crate::importers::parse_iso8601("2026-10-03T09:30:00Z").unwrap();
    let resolution = request.resolution.as_mut().unwrap();
    resolution.as_of_epoch = captured;
    resolution.captured_query_epoch = captured;
    assert!(resolution
        .checked_window(request.range.as_ref().unwrap(), captured)
        .is_ok());
    let text = "A synthetic date-only request. Its precise time is unknown.";
    let packet = crate::wiki_claims::SourceSet::new(
        request.origin.clone().unwrap(),
        request.scope,
        vec![crate::wiki_claims::SourceDocument::bind(
            "S-date-only".into(),
            "sessions/synthetic.md".into(),
            "sessions/synthetic.md".into(),
            text,
            Some("2026-10-03".into()),
            vec![crate::wiki_claims::SpanInput {
                id: "Q-date-only".into(),
                start: 0,
                end: text.len(),
                turn_id: "T-preamble".into(),
                speaker: crate::wiki_claims::ActorRole::Unknown,
                turn_time: None,
            }],
        )
        .unwrap()],
        vec![],
    )
    .unwrap();
    let result = activity_synthesis_steps_with_resolution(
        &request,
        &checked.evidence,
        &packet,
        request.origin.as_ref().unwrap(),
        |_, _| panic!("uncertain future day must not tokenize"),
        |_, _, _, _, _| panic!("uncertain future day must not generate"),
        |_, _| panic!("uncertain future day must not retrieve resolution"),
        |_| panic!("uncertain future day must not publish"),
    );
    assert_eq!(result.unwrap_err().code, "source_verification_failed");
}

#[test]
fn initial_as_of_allows_exact_instant_and_full_day_end_but_keeps_unknown_uncertain() {
    for (cutoff, record, turn, allowed) in [
        (
            "2026-10-03T09:30:00Z",
            None,
            Some("2026-10-03T09:30:00Z"),
            true,
        ),
        (
            "2026-10-03T09:30:00Z",
            None,
            Some("2026-10-03T09:30:01Z"),
            false,
        ),
        ("2026-10-03T23:59:59Z", Some("2026-10-03"), None, true),
        ("2026-10-03T09:30:00Z", None, None, true),
    ] {
        let (_dir, mut request, checked, _index) =
            resolution_fixture(crate::activity_recall::ResolutionMode::HistoricalAsOf);
        request.range.as_mut().unwrap().end = "2026-10-03".into();
        let captured = crate::importers::parse_iso8601(cutoff).unwrap();
        let resolution = request.resolution.as_mut().unwrap();
        resolution.as_of_epoch = captured;
        resolution.captured_query_epoch = captured;
        assert!(resolution
            .checked_window(request.range.as_ref().unwrap(), captured)
            .is_ok());
        let text = "A synthetic original whose event time remains unknown.";
        let packet = SourceSet::new(
            request.origin.clone().unwrap(),
            request.scope,
            vec![crate::wiki_claims::SourceDocument::bind(
                "S-cutoff".into(),
                "sessions/cutoff.md".into(),
                "sessions/cutoff.md".into(),
                text,
                record.map(str::to_owned),
                vec![crate::wiki_claims::SpanInput {
                    id: "Q-cutoff".into(),
                    start: 0,
                    end: text.len(),
                    turn_id: "T-preamble".into(),
                    speaker: crate::wiki_claims::ActorRole::Unknown,
                    turn_time: turn.map(str::to_owned),
                }],
            )
            .unwrap()],
            vec![],
        )
        .unwrap();
        let tokenized = std::cell::Cell::new(false);
        let failure = activity_synthesis_steps_with_resolution(
            &request,
            &checked.evidence,
            &packet,
            request.origin.as_ref().unwrap(),
            |system, user| {
                tokenized.set(true);
                assert_period_packet(system, user);
                if record.is_none() && turn.is_none() {
                    let value: Value = serde_json::from_str(user).unwrap();
                    assert_eq!(value["recordPeriodContext"]["counts"]["uncertainSpans"], 1);
                }
                Err("synthetic tokenizer boundary observation".into())
            },
            |_, _, _, _, _| panic!("boundary observation must not generate"),
            |_, _| panic!("boundary observation must not resolve"),
            |_| panic!("boundary observation must not publish"),
        )
        .unwrap_err();
        assert_eq!(
            tokenized.get(),
            allowed,
            "cutoff={cutoff} record={record:?} turn={turn:?}"
        );
        assert_eq!(
            failure.code,
            if allowed {
                "prompt_unavailable"
            } else {
                "source_verification_failed"
            }
        );
    }
}
