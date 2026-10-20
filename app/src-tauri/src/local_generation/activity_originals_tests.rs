//! Native source-admission regressions using synthetic on-disk transcripts.

use super::*;
use crate::wiki_claims::ActorRole;

fn omit_withdrawal_hint(
    source: &mut crate::activity_recall::compiled_source_tests::Fixture,
    index: &mut Bm25Index,
    request: &mut Request,
) {
    let lines: Vec<_> = source.summary.lines().collect();
    let prefix = "<!-- myco:claim-metadata ";
    let (metadata_line, coordinate) = lines
        .iter()
        .enumerate()
        .filter_map(|(line, text)| {
            let metadata = text.trim().strip_prefix(prefix)?.strip_suffix(" -->")?;
            let value: serde_json::Value = serde_json::from_str(metadata).unwrap();
            let coordinate = &value["sourceSpans"][0];
            let start = coordinate["start"].as_u64().unwrap() as usize;
            let end = coordinate["end"].as_u64().unwrap() as usize;
            source.original[start..end]
                .contains("Withdraw the earlier completion")
                .then(|| (line, coordinate.clone()))
        })
        .next()
        .expect("fixture must have an actual later withdrawal hint");
    assert!(lines[metadata_line - 1].starts_with("- Generated claim:"));
    let footnote = format!("[^mx-{}]:", coordinate["id"].as_str().unwrap());
    source.summary = lines
        .iter()
        .enumerate()
        .filter(|(line, text)| {
            *line != metadata_line && *line != metadata_line - 1 && !text.starts_with(&footnote)
        })
        .map(|(_, text)| *text)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    assert_eq!(source.summary.matches(prefix).count(), 2);
    reindex_summary(source, index, request);
}

fn reindex_summary(
    source: &crate::activity_recall::compiled_source_tests::Fixture,
    index: &mut Bm25Index,
    request: &mut Request,
) {
    std::fs::write(source.root.join(&source.page), &source.summary).unwrap();
    let chunks = crate::embeddings::chunk_page(&source.summary);
    index.upsert_page(&source.page, "Synthetic compiled source", &chunks);
    request.paths = Some(vec![source.page.clone()]);
    request.hits = chunks
        .iter()
        .enumerate()
        .filter(|(_, text)| text.contains("<!-- myco:claim-metadata "))
        .map(|(section, text)| Evidence {
            page: source.page.clone(),
            stem: "Synthetic compiled source".into(),
            section,
            text: text.clone(),
            title: None,
            compiled: None,
        })
        .collect();
}

fn selected_originals(
    source: &crate::activity_recall::compiled_source_tests::Fixture,
    request: &Request,
) -> crate::wiki_claims::SourceSet {
    let chunks = crate::embeddings::chunk_page(&source.summary);
    let bound = crate::activity_recall::original_activity_inputs(
        &source.root,
        &source.page,
        &source.summary,
        &chunks,
        &request
            .hits
            .iter()
            .map(|hit| hit.section)
            .collect::<Vec<_>>(),
        &mut 0,
        false,
    )
    .unwrap();
    crate::wiki_claims::SourceSet::new(
        request.origin.clone().unwrap(),
        request.scope,
        bound.documents,
        vec![],
    )
    .unwrap()
}

#[test]
fn compiled_activity_preserves_selected_partial_turn_and_adds_full_qualification() {
    let (mut source, mut index, mut request) = tests::compiled_activity_fixture();
    let initial = selected_originals(&source, &request);
    let full = initial
        .spans()
        .find(|span| span.speaker() == ActorRole::Assistant)
        .unwrap();
    let partial = full
        .context_window(
            full.text().find("I reported").unwrap(),
            full.text()
                .find("; it was not independently verified")
                .unwrap(),
        )
        .unwrap();
    let mut coordinate = serde_json::to_value(&partial).unwrap();
    coordinate.as_object_mut().unwrap().remove("text");
    let prefix = "<!-- myco:claim-metadata ";
    let mut original_reference = None;
    let updated = source
        .summary
        .lines()
        .map(|line| {
            let Some(metadata) = line
                .trim()
                .strip_prefix(prefix)
                .and_then(|value| value.strip_suffix(" -->"))
            else {
                return line.to_owned();
            };
            let mut value: serde_json::Value = serde_json::from_str(metadata).unwrap();
            if value["sourceSpans"][0]["speaker"] == "assistant" {
                assert!(original_reference
                    .replace(value["sourceSpans"][0]["id"].as_str().unwrap().to_owned())
                    .is_none());
                value["sourceSpans"][0] = coordinate.clone();
                format!("  {prefix}{value} -->")
            } else {
                line.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let old_reference = format!("[^mx-{}]", original_reference.unwrap());
    let new_reference = format!("[^mx-{}]", partial.id());
    assert_eq!(source.summary.matches(&old_reference).count(), 2);
    source.summary = updated.replace(&old_reference, &new_reference) + "\n";
    assert!(!source.summary.contains(&old_reference));
    assert_eq!(source.summary.matches(&new_reference).count(), 2);
    reindex_summary(&source, &mut index, &mut request);
    let selected = selected_originals(&source, &request);
    let before = selected
        .spans()
        .find(|span| span.speaker() == ActorRole::Assistant)
        .unwrap();
    assert_eq!(before.text(), partial.text());
    assert!(before.end() < full.end());
    assert!(!before.text().contains("not independently verified"));
    let originals = checked_evidence(&source.root, &index, &request)
        .unwrap()
        .originals
        .unwrap();
    assert!(originals.spans().any(|after| after == before));
    assert_eq!(
        before.span_sha256(),
        crate::importers::wikify::source_revision(&source.original[before.start()..before.end()])
    );
    let added = originals
        .spans()
        .find(|span| span.same_original_turn(before) && span.id() != before.id())
        .expect("partial-turn admission must retain separate full-turn context");
    assert!(added.start() <= before.start() && added.end() > before.end());
    assert!(added.text().contains("it was not independently verified"));
    assert_eq!(added.speaker(), before.speaker());
    assert_eq!(added.turn_time(), before.turn_time());
    assert_eq!(added.record_time(), before.record_time());
    assert_eq!(added.source_phase(), before.source_phase());
    assert_eq!(added.source_revision(), before.source_revision());
    assert_eq!(
        added.span_sha256(),
        crate::importers::wikify::source_revision(&source.original[added.start()..added.end()])
    );
    assert_eq!(
        std::fs::read_to_string(source.root.join(&source.raw_path)).unwrap(),
        source.original
    );
}

#[test]
fn compiled_withdrawal_missing_from_final_answer_review_blocks_rendering() {
    use crate::local_llm::GenerationSchema;
    use serde_json::{json, Value};

    let (mut source, mut index, mut request) = tests::compiled_activity_fixture();
    omit_withdrawal_hint(&mut source, &mut index, &mut request);
    // This is a pure orchestration fixture, not a native execution grant or meaning judge.
    request.role_snapshot = Some(
        serde_json::from_value(json!({
            "snapshotId":"synthetic-original-closure-role", "origin":request.origin,
            "role":"ask", "usage":"foreground", "authorizationRevision":"synthetic",
            "routeSignature":{"role":"ask", "providerId":"builtin-local",
                "modelId":"qwen3.5-4b-q4_k_m", "effort":"none", "executionLocation":"in-process",
                "artifactRevision":"synthetic", "artifactSha256":"0".repeat(64),
                "runtimeContract":"synthetic-helper-only", "signature":"synthetic-shape-only"}
        }))
        .unwrap(),
    );
    let checked = checked_evidence(&source.root, &index, &request).unwrap();
    let mut extraction_saw_withdrawal = false;
    let mut answer_saw_withdrawal = false;
    let mut review_saw_withdrawal = false;
    let result = activity_synthesis_steps(
        &request,
        &checked.evidence,
        checked.originals.as_ref().unwrap(),
        request.origin.as_ref().unwrap(),
        |_, _| Ok(1800),
        |_, user, _, _, schema| {
            let packet: Value = serde_json::from_str(user).unwrap();
            if schema == GenerationSchema::WikiClaimsV1 {
                let claims: Vec<_> = packet["originalSpans"].as_array().unwrap().iter()
                    .filter(|span| span["speaker"] != "unknown")
                    .map(|span| {
                        let withdrawal = span["text"].as_str().unwrap().contains("Withdraw the earlier completion");
                        extraction_saw_withdrawal |= withdrawal;
                        let assistant = span["speaker"] == "assistant";
                        json!({"action":if withdrawal {"Withdraw the synthetic widget completion report"} else if assistant {"Report the synthetic widget complete without independent verification"} else {"Request the synthetic widget"},
                            "anchorSpanId":span["id"], "supportSpanIds":[span["id"]],
                            "actor":{"role":span["speaker"], "basis":"speaker", "subjectSpanId":null},
                            "eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},
                            "speechAct":if withdrawal {"retraction"} else if assistant {"report"} else {"request"},
                            "status":if withdrawal {"retracted"} else if assistant {"reported_completed"} else {"requested"}, "verificationId":null})
                    }).collect();
                return Ok(json!({"outcome":if claims.is_empty() {"insufficient_evidence"} else {"claims"},"claims":claims}).to_string());
            }
            if let GenerationSchema::WikiClaimReviewV1(decisions) = schema {
                assert_eq!(
                    decisions.count(),
                    packet["requiredClaimIds"].as_array().unwrap().len()
                );
                return Ok(json!({"version":"WikiClaimReviewV1",
                    "claims":packet["requiredClaimIds"].as_array().unwrap().iter().map(|id| json!({"id":id,"disposition":"supported","reason":"Synthetic orchestration verdict."})).collect::<Vec<_>>(),
                    "missingSpanIds":[],"sourceCoverage":"covered"}).to_string());
            }
            if schema == GenerationSchema::AskAnswerV1 {
                answer_saw_withdrawal = packet["sources"].as_array().unwrap().iter().any(|entry| {
                    entry["originalSpans"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|span| {
                            span["text"]
                                .as_str()
                                .unwrap()
                                .contains("Withdraw the earlier completion")
                        })
                });
                return Ok(json!({"answer":"The synthetic widget was requested and later reported complete. Its completion report was withdrawn after failure; current results need verification.","sources":["S1"]}).to_string());
            }
            assert_eq!(schema, GenerationSchema::AskAnswerReviewV1);
            let withdrawal = packet["originalSpans"]
                .as_array()
                .unwrap()
                .iter()
                .find(|span| {
                    span["text"]
                        .as_str()
                        .unwrap()
                        .contains("Withdraw the earlier completion")
                })
                .expect("final review must receive the withdrawal absent from generated hints");
            review_saw_withdrawal = true;
            assert_eq!(withdrawal["speaker"], "user");
            assert_eq!(withdrawal["turnTime"], "2026-10-03T10:00:00Z");
            Ok(json!({"version":"AskAnswerReviewV1","answerDisposition":"supported","taskResponse":"adequate",
                "sourceCoverage":"missing","missingSpanIds":[withdrawal["id"]],"reason":"Synthetic missing-coverage verdict."}).to_string())
        },
    );
    assert!(extraction_saw_withdrawal && answer_saw_withdrawal && review_saw_withdrawal);
    assert_eq!(result.unwrap_err().code, "review_missing");
}

#[test]
fn compiled_original_closure_added_after_as_of_fails_before_model_access() {
    let (mut source, mut index, mut request) = tests::compiled_activity_fixture();
    omit_withdrawal_hint(&mut source, &mut index, &mut request);
    let end = crate::importers::parse_iso8601("2026-10-03T09:30:00Z").unwrap();
    let period = request.range.as_mut().unwrap();
    period.start_epoch = crate::importers::parse_iso8601("2026-10-03T00:00:00Z");
    period.end_epoch = Some(end);
    request.resolution = Some(ResolutionRequest {
        mode: ResolutionMode::HistoricalAsOf,
        as_of_epoch: end - 1,
        captured_query_epoch: crate::importers::parse_iso8601("2026-10-08T12:00:00Z").unwrap(),
    });
    let checked = checked_evidence(&source.root, &index, &request).unwrap();
    let result = activity_synthesis_steps(
        &request,
        &checked.evidence,
        checked.originals.as_ref().unwrap(),
        request.origin.as_ref().unwrap(),
        |_, _| panic!("future backing context must not tokenize"),
        |_, _, _, _, _| panic!("future backing context must not generate"),
    );
    let failure = result.unwrap_err();
    assert_eq!(failure.code, "source_verification_failed");
    assert_eq!(
        failure.detail,
        "initial original exceeds the declared as-of cutoff"
    );
}

#[test]
fn ordinary_ask_keeps_a_real_omitted_hint_without_expanding_its_allowlist() {
    let (mut source, mut index, mut request) = tests::compiled_activity_fixture();
    omit_withdrawal_hint(&mut source, &mut index, &mut request);
    request.activity_overview = false;
    request.range = None;
    let checked = checked_evidence(&source.root, &index, &request).unwrap();
    let originals = checked.originals.unwrap();
    assert_eq!(
        originals
            .spans()
            .filter(|span| span.speaker() != ActorRole::Unknown)
            .count(),
        3
    );
    assert!(originals
        .spans()
        .any(|span| span.text().contains("Withdraw the earlier completion")));
    assert!(originals
        .spans()
        .all(|span| span.selection_path() == source.page));
    assert!(originals
        .spans()
        .all(|span| !span.text().contains("Generated claim:")));
    request.paths = Some(vec!["wiki/unselected-synthetic.md".into()]);
    assert!(checked_evidence(&source.root, &index, &request)
        .unwrap_err()
        .contains("outside the requested scope"));
}

#[test]
fn compiled_activity_keeps_withdrawal_outside_generated_hints() {
    let (mut source, mut index, mut request) = tests::compiled_activity_fixture();
    let selected = checked_evidence(&source.root, &index, &request)
        .unwrap()
        .originals
        .unwrap();
    let preserved: Vec<_> = selected
        .spans()
        .filter(|span| {
            span.speaker() != ActorRole::Unknown
                && !span.text().contains("Withdraw the earlier completion")
        })
        .cloned()
        .collect();
    assert_eq!(preserved.len(), 2);
    let preamble = selected
        .spans()
        .find(|span| span.speaker() == ActorRole::Unknown)
        .expect("full original context must retain native transcript metadata")
        .clone();
    assert!(preamble.text().contains("Synthetic imported transcript"));
    assert_eq!(preamble.turn_time(), None);
    omit_withdrawal_hint(&mut source, &mut index, &mut request);
    let checked = checked_evidence(&source.root, &index, &request).unwrap();
    let originals = checked.originals.unwrap();
    for before in preserved {
        assert!(originals.spans().any(|after| after == &before));
    }
    assert!(originals.spans().any(|after| after == &preamble));
    let withdrawal = originals
        .spans()
        .find(|span| span.text().contains("Withdraw the earlier completion"))
        .expect("compiled hints must not hide a later in-period original withdrawal");
    assert_eq!(withdrawal.speaker(), ActorRole::User);
    assert_eq!(withdrawal.turn_time(), Some("2026-10-03T10:00:00Z"));
    assert_eq!(withdrawal.source_phase(), Some("final"));
    assert_eq!(withdrawal.selection_path(), source.page);
    assert_eq!(withdrawal.source_path(), source.raw_path);
    assert!(originals
        .spans()
        .all(|span| !span.text().contains("Generated claim:")
            && !span.text().contains("Human annotation retained.")));
    assert_eq!(
        std::fs::read_to_string(source.root.join(&source.raw_path)).unwrap(),
        source.original
    );
    assert_eq!(request.scope, Scope::Wiki);
    assert_eq!(request.range.as_ref().unwrap().start, "2026-10-03");
    assert!(!checked.original_inputs_incomplete);
}
