//! Model-free boundary controls, fixed before the first root-owned execution.

use super::*;
use crate::wiki_claims::{ActorRole, SourceDocument, SpanInput};
use serde_json::{json, Value};

fn origin() -> AgentVaultSession {
    AgentVaultSession {
        vault_path: "/synthetic/source-interpretation-qa".into(),
        opening_token: "synthetic-native-opening".into(),
    }
}

fn sources(bodies: &[(&str, ActorRole)]) -> SourceSet {
    let documents = bodies
        .iter()
        .enumerate()
        .map(|(ordinal, (body, speaker))| {
            let prefix = "Native prefix: 가\n";
            let original = format!("{prefix}{body}");
            let turn = format!("T{ordinal}");
            SourceDocument::bind(
                format!("S{ordinal}"),
                format!("sessions/synthetic-{ordinal}.md"),
                format!("sessions/synthetic-{ordinal}.md"),
                &original,
                Some("2024-06-15".into()),
                vec![SpanInput {
                    id: format!("Q{ordinal}"),
                    start: prefix.len(),
                    end: original.len(),
                    turn_id: turn.clone(),
                    speaker: *speaker,
                    turn_time: Some("2024-06-14T09:00:00Z".into()),
                }],
            )
            .unwrap()
            .with_turn_phases(&[(turn, Some("analysis".into()))])
            .unwrap()
        })
        .collect();
    SourceSet::new(origin(), Scope::Sessions, documents, vec![]).unwrap()
}

fn two_units() -> SourceSet {
    sources(&[
        (
            "Please prepare the synthetic release. Completion was not recorded for this session.",
            ActorRole::User,
        ),
        (
            "I prepared a plan on 2024-06-13. Its target was not implemented.",
            ActorRole::Assistant,
        ),
    ])
}

fn proposal(span: &SourceSpan, focus: &str) -> Value {
    json!({
        "focusQuote": focus, "supportSpanIds": [span.id()],
        "actor": {"role": span.speaker(), "basis": "speaker", "subjectSpanId": null},
        "eventTime": {"value": null, "basis": "unknown", "precision": "unknown",
            "uncertainty": "unknown", "supportSpanId": null},
        "speechAct": "report", "status": "unknown",
        "assertionKind": "uncertain", "verificationId": null,
    })
}

fn output(sources: &SourceSet) -> Value {
    json!({"version": VERSION, "units": sources.spans().map(|span| {
        json!({"relevance": "relevant", "interpretations": [proposal(span, span.text())]})
    }).collect::<Vec<_>>()})
}

fn prepared(sources: &SourceSet) -> PreparedQa {
    prepare(sources, &origin(), Scope::Sessions).unwrap()
}

fn bound(prepared: &PreparedQa, output: &Value) -> Value {
    serde_json::to_value(
        prepared
            .validate(&output.to_string(), &origin(), Scope::Sessions)
            .unwrap(),
    )
    .unwrap()
}

fn reject(prepared: &PreparedQa, output: &Value, expected: &str) {
    let error = prepared
        .validate(&output.to_string(), &origin(), Scope::Sessions)
        .unwrap_err();
    assert!(error.contains(expected), "unexpected refusal: {error}");
}

#[test]
fn preserves_complete_original_metadata_order_and_exact_focus_coordinates() {
    let sources = two_units();
    let prepared = prepared(&sources);
    let input: Value = serde_json::from_str(prepared.user()).unwrap();
    let originals = sources
        .spans()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(input["originalSpans"], json!(originals));
    assert_eq!(input["independentVerificationReceipts"], json!([]));
    assert_eq!(input["version"], "NativeSourceInterpretationQaInputV1");
    assert_eq!(prepared.count().units(), 2);
    assert_eq!(prepared.system(), prompt::SYSTEM);
    assert_eq!(prepared.count().grammar(), grammar::grammar(2));
    let count_copy = prepared.count();
    assert_eq!(count_copy.units(), prepared.count().units());
    let bound = bound(&prepared, &output(&sources));
    assert_eq!(bound["inputSha256"], sha256(prepared.user().as_bytes()));
    for (ordinal, span) in sources.spans().enumerate() {
        let unit = &bound["units"][ordinal];
        assert_eq!(unit["original"], originals[ordinal]);
        assert_eq!(unit["interpretations"][0]["focus"]["start"], span.start());
        assert_eq!(unit["interpretations"][0]["focus"]["end"], span.end());
        assert_eq!(
            unit["interpretations"][0]["focus"]["sha256"],
            span.span_sha256()
        );
        assert_eq!(unit["original"]["sourcePhase"], "analysis");
        assert_eq!(unit["original"]["recordTime"], "2024-06-15");
        assert_eq!(unit["original"]["turnTime"], "2024-06-14T09:00:00Z");
        assert_eq!(unit["original"]["sourceRevision"], span.source_revision());
    }
    assert_eq!(bound["bindingChecked"], true);
    assert_eq!(bound["semanticReviewRequired"], true);
    for flag in [
        "nativeIoAuthenticated",
        "semanticAccepted",
        "productionAccepted",
    ] {
        assert_eq!(bound[flag], false);
    }
    assert!(bound.get("claims").is_none());
    assert!(bound["units"][0]["interpretations"][0]
        .get("action")
        .is_none());
}

#[test]
fn retains_tail_beyond_512_and_does_not_project_focus_into_legacy_action() {
    let body = format!(
        "{}\nCompletion was not recorded for this session.",
        "가나다 synthetic detail. ".repeat(80)
    );
    let sources = sources(&[(&body, ActorRole::User)]);
    let prepared = prepared(&sources);
    let span = sources.spans().next().unwrap();
    assert!(span.text().chars().count() > 512);
    let mut output = output(&sources);
    let focus = "Completion was not recorded for this session.";
    output["units"][0]["interpretations"][0]["focusQuote"] = json!(focus);
    let bound = bound(&prepared, &output);
    let unit = &bound["units"][0];
    assert_eq!(unit["original"]["text"], body);
    assert!(prepared
        .user()
        .contains("Completion was not recorded for this session."));
    let start = span.start() + span.text().find(focus).unwrap();
    assert!(start - span.start() > 512);
    assert_eq!(unit["interpretations"][0]["focus"]["start"], start);
    assert_eq!(
        unit["interpretations"][0]["focus"]["end"],
        start + focus.len()
    );
    assert_eq!(
        unit["interpretations"][0]["focus"]["sha256"],
        sha256(focus.as_bytes())
    );
    assert!(unit["interpretations"][0].get("action").is_none());
}

#[test]
fn allows_full_focus_over_512_up_to_2048_scalars_without_truncation() {
    for length in [513, 2048] {
        let body = "가".repeat(length);
        let sources = sources(&[(&body, ActorRole::Unknown)]);
        let bound = bound(&prepared(&sources), &output(&sources));
        assert_eq!(bound["units"][0]["original"]["text"], body);
        assert_eq!(bound["units"][0]["interpretations"][0]["focusQuote"], body);
    }
    let body = "가".repeat(2049);
    let sources = sources(&[(&body, ActorRole::Unknown)]);
    reject(
        &prepared(&sources),
        &output(&sources),
        "focus or support bounds",
    );
}

#[test]
fn original_size_does_not_inherit_focus_limit() {
    let body = format!("{} Tail condition remains unknown.", "x".repeat(3000));
    let sources = sources(&[(&body, ActorRole::Unknown)]);
    let mut output = output(&sources);
    output["units"][0]["interpretations"][0]["focusQuote"] =
        json!("Tail condition remains unknown.");
    let bound = bound(&prepared(&sources), &output);
    assert_eq!(bound["units"][0]["original"]["text"], body);
}

#[test]
fn requires_one_to_16_captured_units_and_accepts_exact_16_interpretations() {
    let empty = SourceSet::new(origin(), Scope::Sessions, vec![], vec![]).unwrap();
    assert!(prepare(&empty, &origin(), Scope::Sessions)
        .err()
        .unwrap()
        .contains("1 to 16"));
    let bodies = (0..17)
        .map(|index| format!("Synthetic original {index}."))
        .collect::<Vec<_>>();
    let entries = bodies
        .iter()
        .map(|body| (body.as_str(), ActorRole::Unknown))
        .collect::<Vec<_>>();
    let excessive = sources(&entries);
    assert!(prepare(&excessive, &origin(), Scope::Sessions)
        .err()
        .unwrap()
        .contains("1 to 16"));
    let maximum = sources(&entries[..16]);
    let prepared = prepared(&maximum);
    let result = prepared
        .validate(&output(&maximum).to_string(), &origin(), Scope::Sessions)
        .unwrap();
    assert_eq!(prepared.count().units(), 16);
    assert_eq!(result.units().len(), 16);
    assert!(result
        .units()
        .iter()
        .all(|unit| unit.interpretations().len() == 1));
}

#[test]
fn rejects_omitted_extra_and_reordered_unit_rows() {
    let sources = two_units();
    let prepared = prepared(&sources);
    let mut omitted = output(&sources);
    omitted["units"].as_array_mut().unwrap().pop();
    reject(&prepared, &omitted, "exact unit count");
    let mut extra = output(&sources);
    let repeated = extra["units"][0].clone();
    extra["units"].as_array_mut().unwrap().push(repeated);
    reject(&prepared, &extra, "exact unit count");
    let mut reordered = output(&sources);
    reordered["units"].as_array_mut().unwrap().swap(0, 1);
    reject(&prepared, &reordered, "focus or support bounds");
}

#[test]
fn relevance_requires_nonempty_relevant_and_empty_other_rows() {
    let sources = two_units();
    let prepared = prepared(&sources);
    let mut empty_relevant = output(&sources);
    empty_relevant["units"][0]["interpretations"] = json!([]);
    reject(&prepared, &empty_relevant, "relevance and interpretations");
    for relevance in ["not_relevant", "uncertain"] {
        let mut nonempty = output(&sources);
        nonempty["units"][0]["relevance"] = json!(relevance);
        reject(&prepared, &nonempty, "relevance and interpretations");
        nonempty["units"][0]["interpretations"] = json!([]);
        let result = prepared
            .validate(&nonempty.to_string(), &origin(), Scope::Sessions)
            .unwrap();
        assert_eq!(
            result.units()[0].original().text(),
            sources.spans().next().unwrap().text()
        );
        assert!(result.units()[0].interpretations().is_empty());
        assert_ne!(result.units()[0].relevance(), RelevanceQa::Relevant);
    }
}

#[test]
fn rejects_17_interpretations_before_binding_or_duplicate_processing() {
    let sources = two_units();
    let mut output = output(&sources);
    let interpretation = output["units"][0]["interpretations"][0].clone();
    output["units"][0]["interpretations"] = json!(vec![interpretation; 16]);
    reject(&prepared(&sources), &output, "16 total interpretations");
}

#[test]
fn rejects_forged_unit_metadata_and_legacy_action_fields_at_each_level() {
    let sources = two_units();
    let prepared = prepared(&sources);
    let mut outer = output(&sources);
    outer["semanticAccepted"] = json!(true);
    reject(&prepared, &outer, "invalid source interpretation QA JSON");
    for key in [
        "unitId",
        "start",
        "end",
        "sha256",
        "sourceRevision",
        "speaker",
        "turnTime",
        "original",
        "text",
    ] {
        let mut output = output(&sources);
        output["units"][0][key] = json!("forged");
        reject(&prepared, &output, "invalid source interpretation QA JSON");
    }
    for key in [
        "unitId",
        "anchorSpanId",
        "action",
        "start",
        "end",
        "sha256",
        "sourcePath",
        "speaker",
        "turnTime",
    ] {
        let mut output = output(&sources);
        output["units"][0]["interpretations"][0][key] = json!("forged");
        reject(&prepared, &output, "invalid source interpretation QA JSON");
    }
    for key in ["actor", "eventTime"] {
        let mut output = output(&sources);
        output["units"][0]["interpretations"][0][key]["extra"] = json!(true);
        reject(&prepared, &output, "invalid source interpretation QA JSON");
    }
}

#[test]
fn rejects_missing_wrong_versions_malformed_json_and_raw_output_overflow() {
    let sources = two_units();
    let prepared = prepared(&sources);
    let mut missing = output(&sources);
    missing.as_object_mut().unwrap().remove("version");
    reject(&prepared, &missing, "invalid source interpretation QA JSON");
    let mut wrong = output(&sources);
    wrong["version"] = json!("WikiQuotedClaimsQaV1");
    reject(&prepared, &wrong, "version or exact unit count");
    for malformed in ["", "{", "[]", "null", "{}"] {
        assert!(prepared
            .validate(malformed, &origin(), Scope::Sessions)
            .is_err());
    }
    let oversized = format!(
        "{}{}",
        output(&sources),
        " ".repeat(super::super::MAX_OUTPUT_BYTES)
    );
    assert!(prepared
        .validate(&oversized, &origin(), Scope::Sessions)
        .unwrap_err()
        .contains("output exceeds bounds"));
}

#[test]
fn nullable_fields_are_required_in_model_output() {
    let sources = two_units();
    let prepared = prepared(&sources);
    for (parent, field) in [
        (None, "verificationId"),
        (Some("actor"), "subjectSpanId"),
        (Some("eventTime"), "value"),
        (Some("eventTime"), "supportSpanId"),
    ] {
        let mut output = output(&sources);
        let interpretation = &mut output["units"][0]["interpretations"][0];
        let object = match parent {
            Some(key) => &mut interpretation[key],
            None => interpretation,
        };
        object.as_object_mut().unwrap().remove(field);
        reject(&prepared, &output, "invalid source interpretation QA JSON");
    }
    assert_eq!(
        bound(&prepared, &output(&sources))["units"][0]["interpretations"][0]["verificationId"],
        Value::Null
    );
}

#[test]
fn rejects_unknown_relevance_assertion_kind_and_invalid_enum_fields() {
    let sources = two_units();
    let prepared = prepared(&sources);
    let mut relevance = output(&sources);
    relevance["units"][0]["relevance"] = json!("accepted");
    reject(
        &prepared,
        &relevance,
        "invalid source interpretation QA JSON",
    );
    for key in ["assertionKind", "speechAct", "status"] {
        let mut output = output(&sources);
        output["units"][0]["interpretations"][0][key] = json!("invented");
        reject(&prepared, &output, "invalid source interpretation QA JSON");
    }
}

#[test]
fn focus_must_belong_to_current_ordinal_even_when_other_unit_is_supported() {
    let sources = two_units();
    let prepared = prepared(&sources);
    let mut output = output(&sources);
    output["units"][0]["interpretations"][0]["supportSpanIds"] = json!(["Q0", "Q1"]);
    output["units"][0]["interpretations"][0]["focusQuote"] =
        json!("Its target was not implemented.");
    reject(&prepared, &output, "focus must occur exactly once");
}

#[test]
fn rejects_repeated_and_overlapping_focus_occurrences() {
    for (body, focus) in [
        ("aaaa", "aa"),
        ("A repeated fact. A repeated fact.", "A repeated fact."),
    ] {
        let sources = sources(&[(body, ActorRole::Unknown)]);
        let mut output = output(&sources);
        output["units"][0]["interpretations"][0]["focusQuote"] = json!(focus);
        reject(
            &prepared(&sources),
            &output,
            "focus must occur exactly once",
        );
    }
}

#[test]
fn preserves_combining_unicode_and_rejects_normalization_or_quote_repair() {
    let body = "Please prepare the cafe\u{301} display; its result is unknown.";
    let sources = sources(&[(body, ActorRole::User)]);
    let prepared = prepared(&sources);
    let mut output = output(&sources);
    output["units"][0]["interpretations"][0]["focusQuote"] = json!("cafe\u{301}");
    let bound = bound(&prepared, &output);
    assert_eq!(bound["units"][0]["original"]["text"], body);
    assert_eq!(
        bound["units"][0]["interpretations"][0]["focusQuote"],
        "cafe\u{301}"
    );
    for focus in ["café", "Prepare a cafe display", ""] {
        output["units"][0]["interpretations"][0]["focusQuote"] = json!(focus);
        assert!(prepared
            .validate(&output.to_string(), &origin(), Scope::Sessions)
            .is_err());
    }
}

#[test]
fn valid_json_escaped_multiline_and_control_focus_preserves_exact_original_bytes() {
    let body = "I saved \"draft\".\n\tNo release.\rA \\ path.\0\u{7f}\u{85}\u{9f} 자료 🧵.\u{2028}Tail\u{2029}";
    let sources = sources(&[(body, ActorRole::Assistant)]);
    let prepared = prepared(&sources);
    let output = output(&sources);
    let serialized = output.to_string();
    assert!(serialized.contains("\\n"));
    assert!(serialized.contains("\\t"));
    assert!(serialized.contains("\\r"));
    assert!(serialized.contains("\\u0000"));
    let bound = bound(&prepared, &output);
    let span = sources.spans().next().unwrap();
    let interpretation = &bound["units"][0]["interpretations"][0];
    assert_eq!(bound["units"][0]["original"]["text"], body);
    assert_eq!(interpretation["focusQuote"], body);
    assert_eq!(interpretation["focus"]["start"], span.start());
    assert_eq!(interpretation["focus"]["end"], span.end());
    assert_eq!(interpretation["focus"]["sha256"], sha256(body.as_bytes()));
    assert_eq!(bound["semanticAccepted"], false);
}

#[test]
fn rejects_raw_json_controls_and_lone_surrogates_but_preserves_a_valid_pair() {
    let body = "Emoji 😀 focus.";
    let sources = sources(&[(body, ActorRole::User)]);
    let prepared = prepared(&sources);
    let serialized = output(&sources).to_string();
    for invalid in [
        serialized.replace(body, "Raw\nJSON control."),
        serialized.replace(body, r"\uD800"),
        serialized.replace(body, r"\uDC00"),
    ] {
        assert!(prepared
            .validate(&invalid, &origin(), Scope::Sessions)
            .unwrap_err()
            .contains("invalid source interpretation QA JSON"));
    }
    let paired = serialized.replace(body, r"Emoji \uD83D\uDE00 focus.");
    let bound = serde_json::to_value(
        prepared
            .validate(&paired, &origin(), Scope::Sessions)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(bound["units"][0]["interpretations"][0]["focusQuote"], body);
    assert_eq!(bound["units"][0]["original"]["text"], body);
}

#[test]
fn same_text_in_distinct_native_units_is_not_semantically_deduplicated() {
    let text = "The synthetic draft is ready.";
    let sources = sources(&[(text, ActorRole::User), (text, ActorRole::Assistant)]);
    let result = prepared(&sources)
        .validate(&output(&sources).to_string(), &origin(), Scope::Sessions)
        .unwrap();
    assert_eq!(result.units().len(), 2);
    assert_ne!(
        result.units()[0].original().id(),
        result.units()[1].original().id()
    );
    assert_ne!(
        result.units()[0].original().speaker(),
        result.units()[1].original().speaker()
    );
    assert!(result
        .units()
        .iter()
        .all(|unit| unit.original().text() == text && unit.interpretations().len() == 1));
}

#[test]
fn rejects_duplicate_interpretations_including_reordered_support_set() {
    let sources = two_units();
    let prepared = prepared(&sources);
    let mut output = output(&sources);
    let mut interpretation = output["units"][0]["interpretations"][0].clone();
    interpretation["supportSpanIds"] = json!(["Q0", "Q1"]);
    let mut duplicate = interpretation.clone();
    duplicate["supportSpanIds"] = json!(["Q1", "Q0"]);
    for duplicate in [interpretation.clone(), duplicate] {
        output["units"][0]["interpretations"] = json!([interpretation, duplicate]);
        reject(&prepared, &output, "duplicated an interpretation");
    }
}

#[test]
fn separate_judgments_sharing_a_focus_are_preserved_without_semantic_approval() {
    let sources = two_units();
    let mut output = output(&sources);
    let first = output["units"][0]["interpretations"][0].clone();
    let mut second = first.clone();
    second["assertionKind"] = json!("record_or_verification_limit");
    output["units"][0]["interpretations"] = json!([first, second]);
    let bound = bound(&prepared(&sources), &output);
    assert_eq!(
        bound["units"][0]["interpretations"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(bound["semanticAccepted"], false);
    assert_eq!(bound["productionAccepted"], false);
}

#[test]
fn requires_unique_selected_supports_including_native_unit_and_maximum_eight() {
    let bodies = (0..9)
        .map(|index| format!("Original support {index}."))
        .collect::<Vec<_>>();
    let entries = bodies
        .iter()
        .map(|body| (body.as_str(), ActorRole::Unknown))
        .collect::<Vec<_>>();
    let sources = sources(&entries);
    let prepared = prepared(&sources);
    let mut output = output(&sources);
    let ids = (0..9).map(|index| format!("Q{index}")).collect::<Vec<_>>();
    output["units"][0]["interpretations"][0]["supportSpanIds"] = json!(&ids[..8]);
    assert!(prepared
        .validate(&output.to_string(), &origin(), Scope::Sessions)
        .is_ok());
    for supports in [json!([]), json!(["Q1"]), json!(["Q0", "Q0"]), json!(ids)] {
        output["units"][0]["interpretations"][0]["supportSpanIds"] = supports;
        reject(&prepared, &output, "focus or support bounds");
    }
    output["units"][0]["interpretations"][0]["supportSpanIds"] = json!(["Q0", "FOREIGN"]);
    reject(&prepared, &output, "unselected original span");
}

#[test]
fn reuses_native_actor_time_and_status_coupling_checks() {
    let sources = two_units();
    let prepared = prepared(&sources);
    let mut actor = output(&sources);
    actor["units"][0]["interpretations"][0]["actor"]["role"] = json!("assistant");
    reject(&prepared, &actor, "speaker");
    let mut subject = output(&sources);
    subject["units"][0]["interpretations"][0]["actor"] =
        json!({"role":"source","basis":"explicit_subject","subjectSpanId":"FOREIGN"});
    reject(&prepared, &subject, "subject span");
    let mut time = output(&sources);
    time["units"][0]["interpretations"][0]["eventTime"] = json!({"value":"2024-06-13","basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null});
    reject(&prepared, &time, "unknown claim time");
    time["units"][0]["interpretations"][0]["eventTime"] = json!({"value":"2024-06-12","basis":"explicit","precision":"day","uncertainty":"specified","supportSpanId":"Q0"});
    reject(&prepared, &time, "explicit date is absent");
    let mut status = output(&sources);
    status["units"][0]["interpretations"][0]["speechAct"] = json!("request");
    status["units"][0]["interpretations"][0]["status"] = json!("reported_completed");
    reject(&prepared, &status, "speech act and status");
}

#[test]
fn preserves_typed_explicit_actor_time_and_assertion_without_promoting_it() {
    let sources = two_units();
    let mut output = output(&sources);
    let interpretation = &mut output["units"][0]["interpretations"][0];
    interpretation["supportSpanIds"] = json!(["Q0", "Q1"]);
    interpretation["actor"] =
        json!({"role":"assistant","basis":"explicit_subject","subjectSpanId":"Q1"});
    interpretation["eventTime"] = json!({"value":"2024-06-13","basis":"explicit","precision":"day","uncertainty":"specified","supportSpanId":"Q1"});
    interpretation["assertionKind"] = json!("intention");
    let bound = bound(&prepared(&sources), &output);
    let checked = &bound["units"][0]["interpretations"][0];
    for key in [
        "focusQuote",
        "supportSpanIds",
        "actor",
        "eventTime",
        "speechAct",
        "status",
        "assertionKind",
        "verificationId",
    ] {
        assert_eq!(checked[key], output["units"][0]["interpretations"][0][key]);
    }
    assert_eq!(bound["semanticReviewRequired"], true);
    assert_eq!(bound["semanticAccepted"], false);
}

#[test]
fn forbids_verified_status_and_nonnull_verification_id() {
    let sources = two_units();
    let prepared = prepared(&sources);
    for status in ["verified_completed", "verified_failed"] {
        let mut output = output(&sources);
        output["units"][0]["interpretations"][0]["speechAct"] = json!("verification");
        output["units"][0]["interpretations"][0]["status"] = json!(status);
        reject(&prepared, &output, "verification is forbidden");
    }
    let mut output = output(&sources);
    output["units"][0]["interpretations"][0]["verificationId"] = json!("V1");
    reject(&prepared, &output, "verification is forbidden");
}

#[test]
fn rejects_changed_vault_opening_or_scope_at_capture_and_binding() {
    let sources = two_units();
    let prepared = prepared(&sources);
    for changed in [
        AgentVaultSession {
            opening_token: "other-opening".into(),
            ..origin()
        },
        AgentVaultSession {
            vault_path: "/synthetic/other-vault".into(),
            ..origin()
        },
    ] {
        assert!(prepare(&sources, &changed, Scope::Sessions).is_err());
        assert!(prepared
            .validate(&output(&sources).to_string(), &changed, Scope::Sessions)
            .unwrap_err()
            .contains("different vault opening or scope"));
    }
    assert!(prepare(&sources, &origin(), Scope::Wiki).is_err());
    assert!(prepared
        .validate(&output(&sources).to_string(), &origin(), Scope::Wiki)
        .unwrap_err()
        .contains("different vault opening or scope"));
}

#[test]
fn misleading_positive_label_over_negative_original_binds_only_structure() {
    let body = "I have not completed the target; this session contains no completion record.";
    let sources = sources(&[(body, ActorRole::Assistant)]);
    let mut output = output(&sources);
    let interpretation = &mut output["units"][0]["interpretations"][0];
    interpretation["focusQuote"] = json!("completed the target");
    interpretation["status"] = json!("reported_completed");
    interpretation["assertionKind"] = json!("asserted_occurrence");
    let bound = bound(&prepared(&sources), &output);
    assert_eq!(bound["units"][0]["original"]["text"], body);
    assert_eq!(
        bound["units"][0]["interpretations"][0]["status"],
        "reported_completed"
    );
    assert_eq!(
        bound["units"][0]["interpretations"][0]["assertionKind"],
        "asserted_occurrence"
    );
    assert_eq!(bound["bindingChecked"], true);
    assert_eq!(bound["semanticReviewRequired"], true);
    assert_eq!(bound["semanticAccepted"], false);
    assert_eq!(bound["productionAccepted"], false);
}
