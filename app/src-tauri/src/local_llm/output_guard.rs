//! Text termination guards shared by the actual incremental decode loop.

use super::generation_telemetry::LoopStop;
use super::GenerationSchema;

const STOP_MARKERS: [&str; 4] = ["\nUser:", "\nAssistant:", "\nQ:", "\n질문:"];

/// Return whether the decode loop must stop after assembling this text prefix.
#[cfg(test)]
pub(super) fn apply(out: &mut String, schema: Option<GenerationSchema>) -> bool {
    apply_with_reason(out, schema).is_some()
}

/// Preserve the existing cutoff while identifying its observed termination.
pub(super) fn apply_with_reason(
    out: &mut String,
    schema: Option<GenerationSchema>,
) -> Option<LoopStop> {
    // Repeated source IDs and fields are legal structured output. Text cutoffs
    // would corrupt its grammar; token budgets and cancellation bound decoding.
    if schema.is_some() {
        return None;
    }
    for marker in STOP_MARKERS {
        if let Some(index) = out.find(marker) {
            out.truncate(index);
            return Some(LoopStop::LegacyDialogueMarker);
        }
    }
    // Legacy free-form repetition guard; preserve its first-occurrence cutoff.
    if out.chars().count() > 120 {
        let tail: String = out
            .chars()
            .rev()
            .take(24)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        if !tail.trim().is_empty() && out.matches(&tail).count() >= 3 {
            if let Some(index) = out.find(&tail) {
                out.truncate(index + tail.len());
            }
            return Some(LoopStop::LegacyRepetition);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const SPAN_ID: &str = "Q-0123456789abcdef0123456789abcdef";
    const REASON: &str = "The supplied original supports the reported parser change.";

    fn decode_prefixes(input: &str, schema: Option<GenerationSchema>) -> (String, bool) {
        let mut assembled = String::new();
        for character in input.chars() {
            assembled.push(character);
            if apply(&mut assembled, schema) {
                return (assembled, true);
            }
        }
        (assembled, false)
    }

    fn document(schema: GenerationSchema) -> String {
        match schema {
            GenerationSchema::AskAnswerV1 => format!(
                r#"{{"answer":"Original one {SPAN_ID}; original two {SPAN_ID}; original three {SPAN_ID}.","sources":["S1"]}}"#
            ),
            GenerationSchema::WikiClaimsV1 => format!(
                r#"{{"outcome":"claims","claims":[{{"action":"Repair the synthetic parser","anchorSpanId":"{SPAN_ID}","supportSpanIds":["{SPAN_ID}"],"actor":{{"role":"assistant","basis":"explicit_subject","subjectSpanId":"{SPAN_ID}"}},"eventTime":{{"value":"2026-10-01","basis":"explicit","precision":"day","uncertainty":"specified","supportSpanId":"{SPAN_ID}"}},"speechAct":"report","status":"reported_completed","verificationId":null}}]}}"#
            ),
            #[cfg(feature = "native-index-probe")]
            GenerationSchema::WikiClaimsCompactQaV1(decoder) => {
                let claims: Vec<_> = (0..3)
                    .map(|index| {
                        serde_json::json!([
                            format!(
                                "Synthetic statement {index}: {SPAN_ID}; {SPAN_ID}; {SPAN_ID}."
                            ),
                            0,
                            [0],
                            ["unknown", "unknown", null],
                            [null, "unknown", "unknown", "unknown", null],
                            "report",
                            "unknown",
                            null,
                        ])
                    })
                    .collect();
                serde_json::json!({"version":"WikiClaimsCompactQaV1",
                    "packetSha256":decoder.packet_sha256(),"outcome":"claims","claims":claims})
                .to_string()
            }
            #[cfg(feature = "native-index-probe")]
            GenerationSchema::WikiSourceFocusClaimsQaV1(decoder) => {
                let claims: Vec<_> = (0..3).map(|index| {
                    let focus = format!("Synthetic nonperformance {index}: {SPAN_ID}; {SPAN_ID}; {SPAN_ID}.");
                    if decoder.wire_version() == "WikiSourceFocusClaimsNamedQaV1" {
                        serde_json::json!({"anchorOrdinal":0,"focusQuote":focus,"assertionKind":"explicit_nonoccurrence","supportOrdinals":[0],
                            "actor":{"role":"user","basis":"speaker","subjectOrdinal":null},
                            "eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","timeSupportOrdinal":null},
                            "speechAct":"report","status":"unknown","verificationId":null})
                    } else {
                        serde_json::json!([0, focus, "explicit_nonoccurrence", [0], ["user", "speaker", null],
                            [null, "unknown", "unknown", "unknown", null], "report", "unknown", null])
                    }
                }).collect();
                serde_json::json!({"version":decoder.wire_version(),
                    "packetSha256":decoder.packet_sha256(),"outcome":"claims","claims":claims})
                .to_string()
            }
            #[cfg(feature = "native-index-probe")]
            GenerationSchema::WikiQuotedClaimsQaV1 => format!(
                r#"{{"version":"WikiQuotedClaimsQaV1","outcome":"claims","claims":[{{"quote":"Not performed: {SPAN_ID}; not performed: {SPAN_ID}; not performed: {SPAN_ID}.","anchorSpanId":"{SPAN_ID}","supportSpanIds":["{SPAN_ID}"],"actor":{{"role":"user","basis":"speaker","subjectSpanId":null}},"eventTime":{{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null}},"speechAct":"report","status":"unknown","verificationId":null}}]}}"#
            ),
            #[cfg(feature = "native-index-probe")]
            GenerationSchema::NativeSourceInterpretationQaV1(count) => {
                let unit = serde_json::json!({
                    "relevance": "relevant",
                    "interpretations": [{
                        "focusQuote": format!("Not performed: {SPAN_ID}; not performed: {SPAN_ID}; not performed: {SPAN_ID}."),
                        "supportSpanIds": [SPAN_ID],
                        "actor": {"role":"user","basis":"speaker","subjectSpanId":null},
                        "eventTime": {"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},
                        "speechAct": "report",
                        "status": "unknown",
                        "assertionKind": "explicit_nonoccurrence",
                        "verificationId": null,
                    }],
                });
                serde_json::json!({
                    "version": "NativeSourceInterpretationQaV1",
                    "units": vec![unit; count.units()],
                })
                .to_string()
            }
            #[cfg(feature = "native-index-probe")]
            GenerationSchema::NativeSourceInterpretationCandidateQa(decoder) => {
                use crate::wiki_claims::source_interpretation_qa::CandidateQa;
                let units: Vec<_> = (0..decoder.units())
                    .map(|ordinal| {
                        let mut interpretation = serde_json::json!({
                            "focusQuote": format!("Not performed: {SPAN_ID}; not performed: {SPAN_ID}; not performed: {SPAN_ID}."),
                            "supportSpanIds": [SPAN_ID],
                            "actor": {"role":"user","basis":"speaker","subjectSpanId":null},
                            "eventTime": {"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},
                            "speechAct":"report", "status":"unknown", "verificationId":null,
                        });
                        match decoder.variant() {
                            CandidateQa::FacetsV2 => interpretation["assertionKinds"] =
                                serde_json::json!(["explicit_nonoccurrence"]),
                            CandidateQa::OrdinalV3 => interpretation["assertionKind"] =
                                serde_json::json!("explicit_nonoccurrence"),
                        }
                        let mut unit = serde_json::json!({
                            "relevance":"relevant", "interpretations":[interpretation],
                        });
                        if decoder.variant() == CandidateQa::OrdinalV3 {
                            unit["unitOrdinal"] = serde_json::json!(ordinal);
                        }
                        unit
                    })
                    .collect();
                serde_json::json!({"version":decoder.variant().output_version(),"units":units})
                    .to_string()
            }
            #[cfg(feature = "native-index-probe")]
            GenerationSchema::NativeActivityTypesQaV2(decoder) => {
                let units: Vec<_> = (0..decoder.units()).map(|ordinal| serde_json::json!({
                    "unitOrdinal":ordinal, "relevance":"relevant", "interpretations":[{
                        "focusQuote":format!("Not performed: {SPAN_ID}; not performed: {SPAN_ID}; not performed: {SPAN_ID}."),
                        "supportSpanIds":[SPAN_ID],
                        "actor":{"role":"user","basis":"speaker","subjectOrdinal":null},
                        "eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},
                        "activityType":"actor_nonperformance", "verificationId":null,
                    }],
                })).collect();
                serde_json::json!({"version":"NativeActivityTypesQaV2","units":units}).to_string()
            }
            GenerationSchema::WikiClaimReviewV1(_) => format!(
                r#"{{"version":"WikiClaimReviewV1","claims":[{{"id":"C0","disposition":"supported","reason":"{REASON}"}},{{"id":"C1","disposition":"supported","reason":"{REASON}"}},{{"id":"C2","disposition":"supported","reason":"{REASON}"}}],"missingSpanIds":[],"sourceCoverage":"covered"}}"#
            ),
            #[cfg(feature = "native-index-probe")]
            GenerationSchema::WikiClaimReviewReasonFirstQaV1(_) => format!(
                r#"{{"version":"WikiClaimReviewV1","claims":[{{"id":"C0","reason":"{REASON}","disposition":"supported"}},{{"id":"C1","reason":"{REASON}","disposition":"supported"}},{{"id":"C2","reason":"{REASON}","disposition":"supported"}}],"sourceCoverage":"covered","missingSpanIds":[]}}"#
            ),
            #[cfg(feature = "native-index-probe")]
            GenerationSchema::WikiClaimFieldReviewQaV1 => {
                let field = format!(
                    r#"{{"disposition":"supported","reason":"{REASON}","evidenceSpanIds":["{SPAN_ID}"]}}"#
                );
                format!(
                    r#"{{"version":"WikiClaimFieldReviewQaV1","claimId":"C0","actor":{field},"action":{field},"eventTime":{field},"speechAct":{field},"status":{field},"reason":"{REASON}"}}"#
                )
            }
            #[cfg(feature = "native-index-probe")]
            GenerationSchema::WikiSourceCoverageQaV1 => format!(
                r#"{{"version":"WikiSourceCoverageQaV1","sourceCoverage":"missing","missingSpanIds":["{SPAN_ID}-1","{SPAN_ID}-2","{SPAN_ID}-3"],"reason":"{REASON}"}}"#
            ),
            GenerationSchema::AskAnswerReviewV1 => format!(
                r#"{{"version":"AskAnswerReviewV1","answerDisposition":"uncertain","taskResponse":"uncertain","sourceCoverage":"missing","missingSpanIds":["{SPAN_ID}-1","{SPAN_ID}-2","{SPAN_ID}-3"],"reason":"Relevant original spans are missing."}}"#
            ),
            GenerationSchema::SessionCompilationV1 => format!(
                r#"{{"version":"SessionCompilationV1","title":"Synthetic parser report","titleClaimIds":["{SPAN_ID}"],"entities":[{{"kind":"artifact","name":"Synthetic parser","claimIds":["{SPAN_ID}"]}}],"summaries":[{{"claimId":"{SPAN_ID}","text":"The assistant reported a parser repair."}}]}}"#
            ),
            GenerationSchema::SessionStructureV1 => format!(
                r#"{{"version":"SessionStructureV1","title":"Synthetic parser report","titleClaimIds":["{SPAN_ID}"],"entities":[{{"kind":"artifact","name":"Synthetic parser","claimIds":["{SPAN_ID}"]}}]}}"#
            ),
            GenerationSchema::SessionReviewV1 => format!(
                r#"{{"version":"SessionReviewV1","claims":[{{"id":"C-1","disposition":"supported","reason":"{REASON}"}},{{"id":"C-2","disposition":"supported","reason":"{REASON}"}},{{"id":"C-3","disposition":"supported","reason":"{REASON}"}}],"expressions":[],"missingSpanIds":[],"sourceCoverage":"covered"}}"#
            ),
        }
    }

    fn preserves_document(schema: GenerationSchema) {
        let original = document(schema);
        let expected: Value = serde_json::from_str(&original).unwrap();
        let (actual, stopped) = decode_prefixes(&original, Some(schema));
        assert_eq!(actual, original, "structured source fields were truncated");
        assert!(
            !stopped,
            "valid structured repetition must not stop decoding"
        );
        assert_eq!(serde_json::from_str::<Value>(&actual).unwrap(), expected);
    }

    #[test]
    fn structured_ask_retains_repeated_original_references() {
        preserves_document(GenerationSchema::AskAnswerV1);
    }

    #[test]
    fn structured_claims_retain_anchor_support_actor_and_time_ids() {
        preserves_document(GenerationSchema::WikiClaimsV1);
    }

    #[test]
    #[cfg(feature = "native-index-probe")]
    fn structured_compact_claims_preserve_tuple_content_without_legacy_cutoff() {
        let user = serde_json::json!({
            "allowedSpanIds":[SPAN_ID],
            "originalSpans":[{"id":SPAN_ID,"text":"Synthetic original with no performed work."}],
            "independentVerificationReceipts":[],
        })
        .to_string();
        let packet = crate::wiki_claims::compact_qa::PreparedCompactQa::prepare(
            crate::local_synthesis::claim_prompt::extraction_system(),
            &user,
        )
        .unwrap();
        preserves_document(GenerationSchema::WikiClaimsCompactQaV1(packet.decoder()));
    }

    #[test]
    #[cfg(feature = "native-index-probe")]
    fn structured_source_focus_claims_preserve_quotations_and_metadata() {
        use crate::wiki_claims::{ActorRole, SourceDocument, SourceSet, SpanInput};
        let text = "Synthetic nonperformance with repeated original references.";
        let origin = crate::vault_session::AgentVaultSession {
            vault_path: "/synthetic/output-guard".into(),
            opening_token: "synthetic-opening".into(),
        };
        let document = SourceDocument::bind(
            "S1".into(),
            "sessions/guard.md".into(),
            "sessions/guard.md".into(),
            text,
            None,
            vec![SpanInput {
                id: SPAN_ID.into(),
                start: 0,
                end: text.len(),
                turn_id: "T1".into(),
                speaker: ActorRole::User,
                turn_time: None,
            }],
        )
        .unwrap();
        let sources = SourceSet::new(
            origin.clone(),
            crate::retrieval::Scope::All,
            vec![document],
            vec![],
        )
        .unwrap();
        let range = crate::commands::DateRange {
            start: "2026-10-01".into(),
            end: "2026-10-04".into(),
            start_epoch: None,
            end_epoch: None,
        };
        let user = crate::local_synthesis::claim_prompt::payload(
            "Summarize recent work",
            "en",
            &range,
            &sources.spans().collect::<Vec<_>>(),
        )
        .unwrap();
        use crate::wiki_claims::focus_claims_qa::{Encoding, PreparedFocusQa};
        for encoding in [Encoding::TupleV1, Encoding::NamedV1] {
            let packet = PreparedFocusQa::prepare_for(&user, encoding).unwrap();
            preserves_document(GenerationSchema::WikiSourceFocusClaimsQaV1(
                packet.decoder(),
            ));
        }
        // A synthetic capture supplies syntax only, never a review receipt.
        let mut context: Value = serde_json::from_str(&user).unwrap();
        context["sourceFocusQaEncoding"] = serde_json::json!("ordinal_activity_v3");
        let activity = crate::wiki_claims::focus_claims_qa::PreparedOrdinalActivityQa::prepare(
            &user,
            &sources,
            &origin,
            crate::retrieval::Scope::All,
            &context,
            &"0".repeat(64),
        )
        .unwrap();
        preserves_document(GenerationSchema::NativeActivityTypesQaV2(
            activity.decoder(),
        ));
    }

    #[test]
    #[cfg(feature = "native-index-probe")]
    fn structured_quoted_claims_retain_repeated_negative_source_text() {
        preserves_document(GenerationSchema::WikiQuotedClaimsQaV1);
    }

    #[test]
    fn structured_claim_review_retains_normal_repeated_reasons() {
        preserves_document(GenerationSchema::WikiClaimReviewV1(
            super::super::ReviewDecisions::new(3).unwrap(),
        ));
    }

    #[test]
    fn structured_answer_review_retains_distinct_related_source_ids() {
        preserves_document(GenerationSchema::AskAnswerReviewV1);
    }

    #[test]
    fn structured_compilation_retains_title_entity_and_summary_lineage() {
        preserves_document(GenerationSchema::SessionCompilationV1);
    }

    #[test]
    fn structured_session_structure_retains_title_and_entity_lineage() {
        preserves_document(GenerationSchema::SessionStructureV1);
    }

    #[test]
    fn structured_session_review_retains_normal_repeated_decisions() {
        preserves_document(GenerationSchema::SessionReviewV1);
    }

    #[test]
    fn free_form_stops_invented_dialogue_for_every_legacy_marker() {
        for marker in STOP_MARKERS {
            let original = format!("A grounded reply.{marker} invented continuation");
            let (actual, stopped) = decode_prefixes(&original, None);
            assert!(stopped);
            assert_eq!(actual, "A grounded reply.");
        }
    }

    #[test]
    fn free_form_stops_repeated_sentence_at_the_original_cutoff() {
        let prefix = "The original synthetic note distinguishes a request, an assistant report, and a later cancellation; nothing here independently verifies implementation. ";
        let sentence = "repeat synthetic phrase.";
        let original = format!("{prefix}{}", sentence.repeat(6));
        let (actual, stopped) = decode_prefixes(&original, None);
        assert!(stopped);
        assert_eq!(actual, format!("{prefix}{sentence}"));
    }
}
