//! Candidate criteria are fixed before the first root-owned execution.

use super::*;
use crate::wiki_claims::{ActorRole, SourceDocument, SourceSpan, SpanInput};
use serde_json::{json, Value};

const VARIANTS: [CandidateQa; 2] = [CandidateQa::FacetsV2, CandidateQa::OrdinalV3];
const ORIGINAL: &str = "---\nsource: codex\nconversation_id: synthetic-native\ncreated: 2026-10-01\n---\n# Synthetic conversation\n\n**User:**\nPlease request the synthetic report.\n\n**Assistant:**\nI plan to draft the synthetic report; no completion is recorded.\n";
const QWEN_V1_RAW: &str = r#"{"version":"NativeSourceInterpretationQaV1","units":[{"relevance":"relevant","interpretations":[{"focusQuote":"Please request the synthetic report.","supportSpanIds":["Q-54a71ed85fd0aa800597cf3bee4220b3"],"actor":{"role":"user","basis":"speaker","subjectSpanId":null},"eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},"speechAct":"request","status":"requested","assertionKind":"intention","verificationId":null},{"focusQuote":"I plan to draft the synthetic report; no completion is recorded.","supportSpanIds":["Q-fb114fbef5c587a1fc962906aa3f2492"],"actor":{"role":"assistant","basis":"speaker","subjectSpanId":null},"eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},"speechAct":"plan","status":"planned","assertionKind":"intention","verificationId":null}]},{"relevance":"not_relevant","interpretations":[]},{"relevance":"not_relevant","interpretations":[]}]}"#;
const GEMMA_V1_RAW: &str = r#"{"version":"NativeSourceInterpretationQaV1","units":[{"relevance": "not_relevant","interpretations":[]},{"relevance": "relevant","interpretations":[{"focusQuote": "Please request the synthetic report.","supportSpanIds":["Q-54a71ed85fd0aa800597cf3bee4220b3"],"actor":{"role":"user","basis":"speaker","subjectSpanId":null},"eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},"speechAct":"request","status":"requested","assertionKind":"intention","verificationId":null}]},{"relevance": "relevant","interpretations":[{"focusQuote": "I plan to draft the synthetic report; no completion is recorded.","supportSpanIds":["Q-fb114fbef5c587a1fc962906aa3f2492"],"actor":{"role":"assistant","basis":"speaker","subjectSpanId":null},"eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},"speechAct":"plan","status":"planned","assertionKind":"intention","verificationId":null}]}]}"#;

fn origin() -> AgentVaultSession {
    AgentVaultSession {
        vault_path: "/synthetic/source-interpretation-qa".into(),
        opening_token: "synthetic-native-opening".into(),
    }
}

fn fixture() -> SourceSet {
    assert_eq!(ORIGINAL.len(), 230);
    assert_eq!(
        sha256(ORIGINAL.as_bytes()),
        "f95f310d45a6347224480fac2b57e2a134aa5c477bfbc29afbeef3805f356400"
    );
    let spans = [
        (
            "Q-3b058f9db9ff27c4d37df69142ae0d89",
            76,
            102,
            "T-preamble",
            ActorRole::Unknown,
        ),
        (
            "Q-54a71ed85fd0aa800597cf3bee4220b3",
            112,
            150,
            "T0",
            ActorRole::User,
        ),
        (
            "Q-fb114fbef5c587a1fc962906aa3f2492",
            165,
            230,
            "T1",
            ActorRole::Assistant,
        ),
    ]
    .into_iter()
    .map(|(id, start, end, turn_id, speaker)| SpanInput {
        id: id.into(),
        start,
        end,
        turn_id: turn_id.into(),
        speaker,
        turn_time: None,
    })
    .collect();
    let path = "raw/conversations/codex/synthetic-native.md";
    let document = SourceDocument::bind(
        "S-f95f310d45a6347224480fac2b57e2a1".into(),
        path.into(),
        path.into(),
        ORIGINAL,
        Some("2026-10-01".into()),
        spans,
    )
    .unwrap();
    SourceSet::new(origin(), Scope::All, vec![document], vec![]).unwrap()
}

fn sources(bodies: &[String]) -> SourceSet {
    let documents = bodies
        .iter()
        .enumerate()
        .map(|(ordinal, body)| {
            let path = format!("sessions/candidate-{ordinal}.md");
            SourceDocument::bind(
                format!("S{ordinal}"),
                path.clone(),
                path,
                body,
                Some("2026-10-01".into()),
                vec![SpanInput {
                    id: format!("Q{ordinal}"),
                    start: 0,
                    end: body.len(),
                    turn_id: format!("T{ordinal}"),
                    speaker: ActorRole::Unknown,
                    turn_time: None,
                }],
            )
            .unwrap()
        })
        .collect();
    SourceSet::new(origin(), Scope::All, documents, vec![]).unwrap()
}

fn prepared(sources: &SourceSet, variant: CandidateQa) -> PreparedCandidateQa {
    prepare_candidate(sources, &origin(), Scope::All, variant).unwrap()
}

fn proposal(span: &SourceSpan) -> Value {
    json!({"focusQuote": span.text(), "supportSpanIds": [span.id()],
        "actor": {"role": span.speaker(), "basis": "speaker", "subjectSpanId": null},
        "eventTime": {"value": null, "basis": "unknown", "precision": "unknown",
            "uncertainty": "unknown", "supportSpanId": null},
        "speechAct": "report", "status": "unknown", "assertionKind": "uncertain",
        "verificationId": null})
}

fn candidate_shape(mut value: Value, variant: CandidateQa) -> Value {
    // Construct candidate test input explicitly; production never migrates or
    // repairs a previous model result into a newly admitted contract.
    value["version"] = json!(variant.output_version());
    for (ordinal, row) in value["units"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .enumerate()
    {
        match variant {
            CandidateQa::FacetsV2 => {
                for interpretation in row["interpretations"].as_array_mut().unwrap() {
                    let kind = interpretation
                        .as_object_mut()
                        .unwrap()
                        .remove("assertionKind")
                        .unwrap();
                    interpretation["assertionKinds"] = json!([kind]);
                }
            }
            CandidateQa::OrdinalV3 => row["unitOrdinal"] = json!(ordinal),
        }
    }
    value
}

fn output(sources: &SourceSet, variant: CandidateQa) -> Value {
    candidate_shape(
        json!({"version": "NativeSourceInterpretationQaV1", "units": sources.spans().map(|span| {
        json!({"relevance": "relevant", "interpretations": [proposal(span)]})
    }).collect::<Vec<_>>()}),
        variant,
    )
}

fn bound(prepared: &PreparedCandidateQa, output: &Value) -> Value {
    serde_json::to_value(
        prepared
            .validate(&output.to_string(), &origin(), Scope::All)
            .unwrap(),
    )
    .unwrap()
}

fn reject(prepared: &PreparedCandidateQa, output: &Value, expected: &str) {
    let error = prepared
        .validate(&output.to_string(), &origin(), Scope::All)
        .unwrap_err();
    assert!(
        error.contains(expected),
        "unexpected candidate refusal: {error}"
    );
}

fn unreviewed(value: &Value) {
    assert_eq!(value["bindingChecked"], true);
    assert_eq!(value["semanticReviewRequired"], true);
    for flag in [
        "nativeIoAuthenticated",
        "semanticAccepted",
        "productionAccepted",
    ] {
        assert_eq!(value[flag], false);
    }
    assert!(value.get("claims").is_none());
}

#[test]
fn prepared_candidates_keep_all_originals_and_do_not_change_v1_bytes() {
    let sources = fixture();
    let original = prepare(&sources, &origin(), Scope::All).unwrap();
    let user = original.user().to_owned();
    let system = original.system().to_owned();
    let grammar = original.count().grammar();
    let originals = sources
        .spans()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    for variant in VARIANTS {
        let prepared = prepared(&sources, variant);
        let input: Value = serde_json::from_str(prepared.user()).unwrap();
        assert_eq!(prepared.variant(), variant);
        let count_copy = prepared.count();
        assert_eq!(count_copy.variant(), variant);
        assert_eq!(count_copy.units(), 3);
        assert_eq!(count_copy.grammar(), grammar::grammar(3, variant));
        assert_eq!(prepared.system(), prompt::system(variant));
        assert_eq!(input["version"], variant.input_version());
        assert_eq!(input["independentVerificationReceipts"], json!([]));
        for (ordinal, original) in originals.iter().enumerate() {
            let captured = match variant {
                CandidateQa::FacetsV2 => &input["originalSpans"][ordinal],
                CandidateQa::OrdinalV3 => {
                    assert_eq!(input["originalSpans"][ordinal]["unitOrdinal"], ordinal);
                    &input["originalSpans"][ordinal]["original"]
                }
            };
            assert_eq!(captured, original);
        }
        let bound = bound(&prepared, &output(&sources, variant));
        assert_eq!(bound["inputSha256"], sha256(prepared.user().as_bytes()));
        assert_eq!(bound["origin"], json!(origin()));
        assert_eq!(bound["scope"], "all");
        for (ordinal, original) in originals.iter().enumerate() {
            assert_eq!(bound["units"][ordinal]["original"], *original);
        }
        unreviewed(&bound);
    }
    let after = prepare(&sources, &origin(), Scope::All).unwrap();
    assert_eq!(after.user(), user);
    assert_eq!(after.system(), system);
    assert_eq!(after.count().grammar(), grammar);
}

#[test]
fn facets_preserve_complete_emitted_order_without_a_single_kind_projection() {
    let sources = fixture();
    let mut output = output(&sources, CandidateQa::FacetsV2);
    let facets = json!(["record_or_verification_limit", "intention"]);
    output["units"][2]["interpretations"][0]["assertionKinds"] = facets.clone();
    let result = bound(&prepared(&sources, CandidateQa::FacetsV2), &output);
    let checked = &result["units"][2]["interpretations"][0];
    assert_eq!(checked["assertionKinds"], facets);
    assert!(checked.get("assertionKind").is_none());
    assert!(checked.get("action").is_none());
    assert_eq!(
        checked["focusQuote"],
        sources.spans().nth(2).unwrap().text()
    );
    assert_eq!(checked["focus"]["start"], 165);
    assert_eq!(checked["focus"]["end"], 230);
    unreviewed(&result);
}

#[test]
fn facets_require_one_to_five_unique_known_values() {
    let sources = fixture();
    let prepared = prepared(&sources, CandidateQa::FacetsV2);
    for kinds in [
        json!([]),
        json!(["intention", "intention"]),
        json!([
            "intention",
            "intention",
            "intention",
            "intention",
            "intention",
            "intention"
        ]),
    ] {
        let mut output = output(&sources, CandidateQa::FacetsV2);
        output["units"][0]["interpretations"][0]["assertionKinds"] = kinds;
        reject(&prepared, &output, "unique assertion facets");
    }
    let mut output = output(&sources, CandidateQa::FacetsV2);
    for kinds in [json!(["invented"]), Value::Null, json!("intention")] {
        output["units"][0]["interpretations"][0]["assertionKinds"] = kinds;
        reject(
            &prepared,
            &output,
            "invalid source interpretation candidate JSON",
        );
    }
    output["units"][0]["interpretations"][0]["assertionKinds"] = json!([
        "uncertain",
        "record_or_verification_limit",
        "intention",
        "explicit_nonoccurrence",
        "asserted_occurrence"
    ]);
    let result = bound(&prepared, &output);
    assert_eq!(
        result["units"][0]["interpretations"][0]["assertionKinds"],
        output["units"][0]["interpretations"][0]["assertionKinds"]
    );
    unreviewed(&result);
}

#[test]
fn facet_duplicate_identity_ignores_support_and_kind_set_order_only() {
    let sources = fixture();
    let prepared = prepared(&sources, CandidateQa::FacetsV2);
    let mut output = output(&sources, CandidateQa::FacetsV2);
    let mut first = output["units"][1]["interpretations"][0].clone();
    let first_id = sources.spans().nth(1).unwrap().id();
    let second_id = sources.spans().nth(2).unwrap().id();
    first["supportSpanIds"] = json!([first_id, second_id]);
    first["assertionKinds"] = json!(["intention", "record_or_verification_limit"]);
    let mut duplicate = first.clone();
    duplicate["supportSpanIds"] = json!([second_id, first_id]);
    duplicate["assertionKinds"] = json!(["record_or_verification_limit", "intention"]);
    output["units"][1]["interpretations"] = json!([first.clone(), duplicate]);
    reject(&prepared, &output, "duplicated an interpretation");
    let mut distinct = first.clone();
    distinct["assertionKinds"] = json!(["intention"]);
    output["units"][1]["interpretations"] = json!([first, distinct]);
    let result = bound(&prepared, &output);
    assert_eq!(
        result["units"][1]["interpretations"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    unreviewed(&result);
}

#[test]
fn ordinal_is_required_exact_integer_and_never_reorders_rows() {
    let sources = fixture();
    let prepared = prepared(&sources, CandidateQa::OrdinalV3);
    for invalid in [Value::Null, json!(true), json!(-1), json!(0.5), json!("0")] {
        let mut output = output(&sources, CandidateQa::OrdinalV3);
        output["units"][0]["unitOrdinal"] = invalid;
        reject(
            &prepared,
            &output,
            "invalid source interpretation candidate JSON",
        );
    }
    let mut missing = output(&sources, CandidateQa::OrdinalV3);
    missing["units"][0]
        .as_object_mut()
        .unwrap()
        .remove("unitOrdinal");
    reject(
        &prepared,
        &missing,
        "invalid source interpretation candidate JSON",
    );
    let mut reordered = output(&sources, CandidateQa::OrdinalV3);
    reordered["units"].as_array_mut().unwrap().swap(0, 1);
    reject(&prepared, &reordered, "exact unit ordinal");
    for ordinal in [0, 3] {
        let mut output = output(&sources, CandidateQa::OrdinalV3);
        output["units"][1]["unitOrdinal"] = json!(ordinal);
        reject(&prepared, &output, "exact unit ordinal");
    }
    let result = bound(&prepared, &output(&sources, CandidateQa::OrdinalV3));
    for ordinal in 0..3 {
        assert_eq!(result["units"][ordinal]["unitOrdinal"], ordinal);
    }
}

#[test]
fn both_candidates_reject_the_unmodified_actual_v1_raw_receipts() {
    let sources = fixture();
    for variant in VARIANTS {
        let prepared = prepared(&sources, variant);
        for raw in [QWEN_V1_RAW, GEMMA_V1_RAW] {
            assert!(prepared.validate(raw, &origin(), Scope::All).is_err());
        }
        let v1 = prepare(&sources, &origin(), Scope::All).unwrap();
        assert!(v1
            .validate(
                &output(&sources, variant).to_string(),
                &origin(),
                Scope::All
            )
            .is_err());
    }
}

#[test]
fn known_heading_misassignment_is_not_repaired_by_facets_or_exact_ordinals() {
    let sources = fixture();
    for variant in VARIANTS {
        let prepared = prepared(&sources, variant);
        let mut output = candidate_shape(serde_json::from_str(QWEN_V1_RAW).unwrap(), variant);
        reject(&prepared, &output, "focus or support bounds");
        let heading_id = sources.spans().next().unwrap().id();
        output["units"][0]["interpretations"][0]["supportSpanIds"] =
            json!([heading_id, sources.spans().nth(1).unwrap().id()]);
        reject(&prepared, &output, "focus must occur exactly once");
    }
}

#[test]
fn intention_only_fixture_remains_unreviewed_without_added_qualification() {
    let sources = fixture();
    for variant in VARIANTS {
        let output = candidate_shape(serde_json::from_str(GEMMA_V1_RAW).unwrap(), variant);
        let result = bound(&prepared(&sources, variant), &output);
        let interpretation = &result["units"][2]["interpretations"][0];
        assert_eq!(
            interpretation["focusQuote"],
            "I plan to draft the synthetic report; no completion is recorded."
        );
        match variant {
            CandidateQa::FacetsV2 => {
                assert_eq!(interpretation["assertionKinds"], json!(["intention"]))
            }
            CandidateQa::OrdinalV3 => assert_eq!(interpretation["assertionKind"], "intention"),
        }
        unreviewed(&result);
    }
}

#[test]
fn closed_dtos_reject_mixed_contracts_forged_metadata_and_wrong_versions() {
    let sources = fixture();
    for variant in VARIANTS {
        let prepared = prepared(&sources, variant);
        let mut outer = output(&sources, variant);
        outer["semanticAccepted"] = json!(true);
        reject(
            &prepared,
            &outer,
            "invalid source interpretation candidate JSON",
        );
        for key in [
            "unitId", "original", "start", "sha256", "speaker", "turnTime",
        ] {
            let mut forged = output(&sources, variant);
            forged["units"][0][key] = json!("forged");
            reject(
                &prepared,
                &forged,
                "invalid source interpretation candidate JSON",
            );
        }
        let mut mixed = output(&sources, variant);
        match variant {
            CandidateQa::FacetsV2 => {
                mixed["units"][0]["interpretations"][0]["assertionKind"] = json!("intention")
            }
            CandidateQa::OrdinalV3 => {
                mixed["units"][0]["interpretations"][0]["assertionKinds"] = json!(["intention"])
            }
        }
        reject(
            &prepared,
            &mixed,
            "invalid source interpretation candidate JSON",
        );
        if variant == CandidateQa::FacetsV2 {
            mixed = output(&sources, variant);
            mixed["units"][0]["unitOrdinal"] = json!(0);
            reject(
                &prepared,
                &mixed,
                "invalid source interpretation candidate JSON",
            );
        }
        let mut wrong_version = output(&sources, variant);
        wrong_version["version"] = json!("NativeSourceInterpretationQaV1");
        reject(&prepared, &wrong_version, "version or exact unit count");
        for other in VARIANTS {
            if other != variant {
                assert!(prepared
                    .validate(&output(&sources, other).to_string(), &origin(), Scope::All)
                    .is_err());
            }
        }
    }
}

#[test]
fn native_actor_time_status_verification_and_required_null_guards_are_reused() {
    let sources = fixture();
    for variant in VARIANTS {
        let prepared = prepared(&sources, variant);
        let mut actor = output(&sources, variant);
        actor["units"][1]["interpretations"][0]["actor"]["role"] = json!("assistant");
        reject(&prepared, &actor, "speaker");
        let mut time = output(&sources, variant);
        time["units"][1]["interpretations"][0]["eventTime"] = json!({"value":"2026-10-01", "basis":"explicit", "precision":"day", "uncertainty":"specified", "supportSpanId": sources.spans().nth(1).unwrap().id()});
        reject(&prepared, &time, "explicit date is absent");
        let mut status = output(&sources, variant);
        status["units"][1]["interpretations"][0]["speechAct"] = json!("request");
        status["units"][1]["interpretations"][0]["status"] = json!("reported_completed");
        reject(&prepared, &status, "speech act and status");
        status["units"][1]["interpretations"][0]["status"] = json!("verified_completed");
        reject(&prepared, &status, "verification is forbidden");
        let mut receipt = output(&sources, variant);
        receipt["units"][1]["interpretations"][0]["verificationId"] = json!("FAKE");
        reject(&prepared, &receipt, "verification is forbidden");
        for (parent, field) in [
            (None, "verificationId"),
            (Some("actor"), "subjectSpanId"),
            (Some("eventTime"), "value"),
            (Some("eventTime"), "supportSpanId"),
        ] {
            let mut missing = output(&sources, variant);
            let interpretation = &mut missing["units"][1]["interpretations"][0];
            let object = match parent {
                Some(key) => &mut interpretation[key],
                None => interpretation,
            };
            object.as_object_mut().unwrap().remove(field);
            reject(
                &prepared,
                &missing,
                "invalid source interpretation candidate JSON",
            );
        }
    }
}

#[test]
fn context_changes_and_omitted_extra_rows_are_rejected() {
    let sources = fixture();
    for variant in VARIANTS {
        let prepared = prepared(&sources, variant);
        for changed in [
            AgentVaultSession {
                opening_token: "reopened".into(),
                ..origin()
            },
            AgentVaultSession {
                vault_path: "/different".into(),
                ..origin()
            },
        ] {
            assert!(prepare_candidate(&sources, &changed, Scope::All, variant).is_err());
            assert!(prepared
                .validate(&output(&sources, variant).to_string(), &changed, Scope::All)
                .is_err());
        }
        assert!(prepare_candidate(&sources, &origin(), Scope::Sessions, variant).is_err());
        assert!(prepared
            .validate(
                &output(&sources, variant).to_string(),
                &origin(),
                Scope::Sessions
            )
            .is_err());
        let mut missing = output(&sources, variant);
        missing["units"].as_array_mut().unwrap().pop();
        reject(&prepared, &missing, "exact unit count");
        let mut extra = output(&sources, variant);
        let repeated = extra["units"][0].clone();
        extra["units"].as_array_mut().unwrap().push(repeated);
        reject(&prepared, &extra, "exact unit count");
    }
}

#[test]
fn global_interpretation_cap_and_captured_unit_bounds_are_unchanged() {
    let empty = SourceSet::new(origin(), Scope::All, vec![], vec![]).unwrap();
    let bodies = (0..17)
        .map(|index| format!("Original {index}."))
        .collect::<Vec<_>>();
    let excess = sources(&bodies);
    for variant in VARIANTS {
        assert!(prepare_candidate(&empty, &origin(), Scope::All, variant).is_err());
        assert!(prepare_candidate(&excess, &origin(), Scope::All, variant).is_err());
        let maximum = sources(&bodies[..16]);
        assert_eq!(prepared(&maximum, variant).count().units(), 16);
        unreviewed(&bound(
            &prepared(&maximum, variant),
            &output(&maximum, variant),
        ));
        let fixture = fixture();
        let mut excessive = output(&fixture, variant);
        let repeated = excessive["units"][0]["interpretations"][0].clone();
        excessive["units"][0]["interpretations"] = json!(vec![repeated; 15]);
        reject(
            &prepared(&fixture, variant),
            &excessive,
            "16 total interpretations",
        );
    }
}

#[test]
fn irrelevant_rows_preserve_originals_and_relevance_still_controls_shape() {
    let sources = fixture();
    for variant in VARIANTS {
        let prepared = prepared(&sources, variant);
        let mut empty = output(&sources, variant);
        empty["units"][0]["interpretations"] = json!([]);
        reject(&prepared, &empty, "relevance and interpretations");
        for relevance in ["not_relevant", "uncertain"] {
            let mut nonempty = output(&sources, variant);
            nonempty["units"][0]["relevance"] = json!(relevance);
            reject(&prepared, &nonempty, "relevance and interpretations");
            nonempty["units"][0]["interpretations"] = json!([]);
            let result = bound(&prepared, &nonempty);
            assert_eq!(
                result["units"][0]["original"],
                json!(sources.spans().next().unwrap())
            );
            unreviewed(&result);
        }
    }
}

#[test]
fn complete_long_original_and_exact_unicode_control_focus_are_retained() {
    let body = format!(
        "{}\nNo completion recorded.\t자료 cafe\u{301} 🧵.\0",
        "가".repeat(3000)
    );
    let long_sources = sources(std::slice::from_ref(&body));
    let focus = "No completion recorded.\t자료 cafe\u{301} 🧵.\0";
    for variant in VARIANTS {
        let prepared = prepared(&long_sources, variant);
        let mut output = output(&long_sources, variant);
        output["units"][0]["interpretations"][0]["focusQuote"] = json!(focus);
        let result = bound(&prepared, &output);
        assert_eq!(result["units"][0]["original"]["text"], body);
        assert_eq!(
            result["units"][0]["interpretations"][0]["focusQuote"],
            focus
        );
        assert_eq!(
            result["units"][0]["interpretations"][0]["focus"]["start"],
            body.find(focus).unwrap()
        );
        output["units"][0]["interpretations"][0]["focusQuote"] =
            json!(focus.replace("cafe\u{301}", "café"));
        reject(&prepared, &output, "focus must occur exactly once");
    }
    for length in [513, 2048, 2049] {
        let body = "가".repeat(length);
        let sources = sources(std::slice::from_ref(&body));
        for variant in VARIANTS {
            let prepared = prepared(&sources, variant);
            let output = output(&sources, variant);
            if length == 2049 {
                reject(&prepared, &output, "focus or support bounds");
            } else {
                assert_eq!(
                    bound(&prepared, &output)["units"][0]["interpretations"][0]["focusQuote"],
                    body
                );
            }
        }
    }
}

#[test]
fn malformed_json_output_byte_cap_and_nonblank_focus_are_enforced_for_both_candidates() {
    let sources = fixture();
    for variant in VARIANTS {
        let prepared = prepared(&sources, variant);
        for raw in ["", "{", "null", "[]"] {
            let error = prepared.validate(raw, &origin(), Scope::All).unwrap_err();
            assert!(error.contains("invalid source interpretation candidate JSON"));
        }
        let oversized = " ".repeat(super::super::super::MAX_OUTPUT_BYTES + 1);
        let error = prepared
            .validate(&oversized, &origin(), Scope::All)
            .unwrap_err();
        assert!(error.contains("output exceeds bounds"));
        for focus in ["", " \t\r\n"] {
            let mut output = output(&sources, variant);
            output["units"][0]["interpretations"][0]["focusQuote"] = json!(focus);
            reject(&prepared, &output, "focus or support bounds");
        }
    }
}

#[test]
fn ambiguous_focus_and_invalid_or_foreign_supports_remain_errors() {
    let ambiguous = sources(&["aaaa".into()]);
    let bodies = (0..9)
        .map(|index| format!("Support {index}."))
        .collect::<Vec<_>>();
    let sources = sources(&bodies);
    let ids = sources
        .spans()
        .map(|span| span.id().to_owned())
        .collect::<Vec<_>>();
    for variant in VARIANTS {
        let mut repeated = output(&ambiguous, variant);
        repeated["units"][0]["interpretations"][0]["focusQuote"] = json!("aa");
        reject(
            &prepared(&ambiguous, variant),
            &repeated,
            "focus must occur exactly once",
        );
        let prepared = prepared(&sources, variant);
        let mut output = output(&sources, variant);
        output["units"][0]["interpretations"][0]["supportSpanIds"] = json!(&ids[..8]);
        unreviewed(&bound(&prepared, &output));
        for invalid in [json!([]), json!(["Q1"]), json!(["Q0", "Q0"]), json!(ids)] {
            output["units"][0]["interpretations"][0]["supportSpanIds"] = invalid;
            reject(&prepared, &output, "focus or support bounds");
        }
        output["units"][0]["interpretations"][0]["supportSpanIds"] = json!(["Q0", "FOREIGN"]);
        reject(&prepared, &output, "unselected original span");
    }
}
