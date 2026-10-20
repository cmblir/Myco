//! Synthetic source/projection custody only; no actual model semantics are graded.
use super::*;
use crate::commands::DateRange;
use crate::wiki_claim_review::AskReviewContext;
use crate::wiki_claims::{ActorRole, SourceDocument, SpanInput};

#[path = "activity_actor_qa_tests.rs"]
mod activity_actor_tests;
#[path = "activity_types_qa_contract_tests.rs"]
mod activity_type_contract_tests;

const BODY: &str = "The maintainer repaired the synthetic archive on 2026-10-01. I did not verify that repair. This message contains no later result.";
fn origin() -> AgentVaultSession {
    AgentVaultSession {
        vault_path: "/synthetic/ordinal-activity".into(),
        opening_token: "synthetic-ordinal-opening".into(),
    }
}
fn period() -> DateRange {
    DateRange {
        start: "2026-10-01".into(),
        end: "2026-10-04".into(),
        start_epoch: None,
        end_epoch: None,
    }
}
fn sources(body: &str) -> SourceSet {
    let text = format!("선행\n{body}");
    let document = SourceDocument::bind(
        "S-ORDINAL".into(),
        "sessions/ordinal.md".into(),
        "sessions/ordinal.md".into(),
        &text,
        Some("2026-10-04".into()),
        vec![SpanInput {
            id: "Q-ORIGINAL".into(),
            start: "선행\n".len(),
            end: text.len(),
            turn_id: "T0".into(),
            speaker: ActorRole::User,
            turn_time: Some("2026-10-03T08:00:00Z".into()),
        }],
    )
    .unwrap();
    SourceSet::new(origin(), Scope::Sessions, vec![document], vec![]).unwrap()
}
fn ask_context(snapshot: &str) -> AskReviewContext {
    let role = serde_json::from_value(json!({"snapshotId":snapshot,"origin":origin(),
        "role":"ask","usage":"foreground","authorizationRevision":"synthetic",
        "routeSignature":{"role":"ask","providerId":"builtin-local","modelId":"qwen3.5-4b-q4_k_m",
        "effort":"none","executionLocation":"in-process","artifactRevision":"synthetic",
        "artifactSha256":"0".repeat(64),"runtimeContract":"synthetic-only","signature":"synthetic-only"}})).unwrap();
    AskReviewContext::new(
        &origin(),
        &role,
        "synthetic-ordinal-request",
        "Summarize recent work",
        "en",
        Scope::Sessions,
        &period(),
        None,
        None,
    )
    .unwrap()
    .with_source_focus_qa()
    .unwrap()
    .with_ordinal_activity_qa()
    .unwrap()
}
fn input(packet: &SourceSet) -> String {
    crate::local_synthesis::claim_prompt::payload(
        "Summarize recent work",
        "en",
        &period(),
        &packet.spans().collect::<Vec<_>>(),
    )
    .unwrap()
}
fn prepare(packet: &SourceSet, context: &AskReviewContext) -> PreparedOrdinalActivityQa {
    PreparedOrdinalActivityQa::prepare(
        &input(packet),
        packet,
        &origin(),
        Scope::Sessions,
        context.payload(),
        context.revision(),
    )
    .unwrap()
}
fn output(focus: &str) -> Value {
    json!({"version":"NativeActivityTypesQaV2","units":[{"unitOrdinal":0,"relevance":"relevant","interpretations":[{
        "focusQuote":focus,"supportSpanIds":["Q-ORIGINAL"],"actor":{"role":"source","basis":"explicit_subject","subjectOrdinal":0},
        "eventTime":{"value":"2026-10-01","basis":"explicit","precision":"day","uncertainty":"specified","supportSpanId":"Q-ORIGINAL"},
        "activityType":"reported_completion","verificationId":null}]}]})
}

#[test]
fn activity_type_decoder_closes_wire_fields_before_generation() {
    let packet = sources(BODY);
    let context = ask_context("role-A");
    let prepared = prepare(&packet, &context);
    let grammar = prepared.decoder().grammar();
    let interpretation = grammar
        .lines()
        .find(|line| line.starts_with("interpretation-0 ::= "))
        .unwrap();
    assert!(interpretation.contains("activityType"));
    for legacy in ["speechAct", "status", "assertionKind"] {
        assert!(
            !interpretation.contains(legacy),
            "legacy emitted field {legacy}"
        );
    }
    assert!(grammar.contains("NativeActivityTypesQaV2"));
}

#[test]
fn actual_activity_inputs_and_canonical_fields_remain_distinct_from_wire_evidence() {
    let packet = sources(BODY);
    let context = ask_context("role-A");
    let prepared = prepare(&packet, &context);
    let (system, user) =
        PreparedOrdinalActivityQa::inputs(&input(&packet), context.payload(), context.revision())
            .unwrap();
    assert_eq!(
        (prepared.system(), prepared.user()),
        (system.as_str(), user.as_str())
    );
    assert!(system.contains("at most 512 decoded Unicode scalar values"));
    assert!(!system.contains("This is source-only interpretation:"));
    assert!(system.contains(INPUT_VERSION));
    let model: Value = serde_json::from_str(&user).unwrap();
    assert_eq!(model["question"], context.payload()["question"]);
    assert_eq!(model["originalSpans"][0]["original"]["text"], BODY);
    let raw = output("The maintainer repaired the synthetic archive on 2026-10-01.").to_string();
    let projection = prepared.expand(&raw).unwrap();
    assert_eq!(projection.encoding(), None);
    projection.verify_model_result(&raw).unwrap();
    projection
        .verify_review_context(context.revision())
        .unwrap();
    let checked = packet
        .validate(projection.canonical(), &origin(), Scope::Sessions)
        .unwrap();
    assert_eq!(checked.claims[0].proposal.actor.role, ActorRole::Source);
    let sidecar = projection
        .review_value(&packet, &checked, context.payload())
        .unwrap();
    assert_eq!(sidecar["version"], VERSION);
    for flag in [
        "semanticAccepted",
        "nativeIoAuthenticated",
        "productionAccepted",
    ] {
        assert_eq!(sidecar[flag], false);
    }
    assert!(projection
        .verify_review_context(ask_context("role-B").revision())
        .is_err());
    assert!(projection.verify_model_result(&(raw + " ")).is_err());
}

#[test]
fn wrong_but_structurally_legal_actor_is_preserved_for_mandatory_review_not_repaired() {
    let packet = sources(BODY);
    let context = ask_context("role-A");
    let prepared = prepare(&packet, &context);
    let mut raw = output("The maintainer repaired the synthetic archive on 2026-10-01.");
    raw["units"][0]["interpretations"][0]["actor"] =
        json!({"role":"user","basis":"speaker","subjectOrdinal":null});
    let projection = prepared.expand(&raw.to_string()).unwrap();
    let checked = packet
        .validate(projection.canonical(), &origin(), Scope::Sessions)
        .unwrap();
    assert_eq!(checked.claims[0].proposal.actor.role, ActorRole::User);
    assert!(checked.claims[0].semantic_review_required);
    assert_eq!(
        projection
            .model_review_value(&packet, &checked, context.payload())
            .unwrap()["semanticAccepted"],
        false
    );
}

#[test]
fn overlong_focus_unknown_type_and_row_swap_are_rejected_without_repair() {
    let long = "한".repeat(513);
    let packet = sources(&long);
    let context = ask_context("role-A");
    let prepared = prepare(&packet, &context);
    let mut raw = output(&long);
    raw["units"][0]["interpretations"][0]["eventTime"] = json!({"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null});
    assert!(prepared
        .expand(&raw.to_string())
        .err()
        .unwrap()
        .contains("canonical action bound"));
    let packet = sources(BODY);
    let prepared = prepare(&packet, &context);
    let mut raw = output("I did not verify that repair.");
    raw["units"][0]["interpretations"][0]["activityType"] = json!("unknown_activity");
    assert!(prepared
        .expand(&raw.to_string())
        .err()
        .unwrap()
        .contains("unknown variant"));
    raw["units"][0]["interpretations"][0]["activityType"] = json!("record_or_verification_limit");
    raw["units"][0]["unitOrdinal"] = json!(1);
    assert!(prepared.expand(&raw.to_string()).is_err());
}

#[test]
fn context_source_and_projection_tampering_cannot_issue_a_review_sidecar() {
    let packet = sources(BODY);
    let context = ask_context("role-A");
    let mut changed: Value = serde_json::from_str(&input(&packet)).unwrap();
    changed["language"] = json!("ko");
    assert!(PreparedOrdinalActivityQa::inputs(
        &changed.to_string(),
        context.payload(),
        context.revision()
    )
    .is_err());
    let other = sources(&format!("{BODY} Additional synthetic content."));
    assert!(PreparedOrdinalActivityQa::prepare(
        &input(&packet),
        &other,
        &origin(),
        Scope::Sessions,
        context.payload(),
        context.revision()
    )
    .is_err());
    let prepared = prepare(&packet, &context);
    let raw = output("The maintainer repaired the synthetic archive on 2026-10-01.").to_string();
    let mut projection = prepared.expand(&raw).unwrap();
    let checked = packet
        .validate(projection.canonical(), &origin(), Scope::Sessions)
        .unwrap();
    projection.generation_user.push(' ');
    assert!(projection
        .review_value(&packet, &checked, context.payload())
        .is_err());
    assert!(context.clone().with_review_correction_qa().is_err());
}

#[test]
fn same_question_language_and_period_do_not_authorize_changed_scope_or_resolution() {
    let packet = sources(BODY);
    let context = ask_context("role-A");
    let prepared = prepare(&packet, &context);
    let raw = output("The maintainer repaired the synthetic archive on 2026-10-01.").to_string();
    let projection = prepared.expand(&raw).unwrap();
    let checked = packet
        .validate(projection.canonical(), &origin(), Scope::Sessions)
        .unwrap();
    projection
        .verify_review_context(context.revision())
        .unwrap();
    projection
        .review_value(&packet, &checked, context.payload())
        .unwrap();
    let mut changed_scope = context.payload().clone();
    changed_scope["scope"] = serde_json::to_value(Scope::All).unwrap();
    let mut changed_resolution = context.payload().clone();
    changed_resolution["resolutionWindow"] = json!({
        "mode": "historical_as_of", "startEpoch": 1790812800_i64,
        "endEpoch": 1791158400_i64, "asOfEpoch": 1791158399_i64,
        "capturedQueryEpoch": 1792108800_i64
    });
    for changed in [changed_scope, changed_resolution] {
        for field in ["question", "language", "activityPeriod"] {
            assert_eq!(changed[field], context.payload()[field]);
        }
        assert!(projection
            .review_value(&packet, &checked, &changed)
            .is_err());
    }
}

#[test]
fn served_activity_policy_matches_every_native_kind_speech_and_status_combination() {
    use crate::wiki_claims::source_interpretation_qa::AssertionKindQa;
    use crate::wiki_claims::{ClaimStatus, SpeechAct};

    let packet = sources(BODY);
    let context = ask_context("role-A");
    let prepared = prepare(&packet, &context);
    let mapping: Value = serde_json::from_str(
        prepared
            .system()
            .split_once("Activity type native mapping (exhaustive; not output fields):\n")
            .unwrap()
            .1
            .lines()
            .next()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(mapping.as_object().unwrap().len(), 18);
    for (tag, kind, speech, status) in activity_type_contract_tests::TYPES {
        assert_eq!(mapping[tag], json!([kind, speech, status]), "{tag}");
    }
    let kinds = [
        "asserted_occurrence",
        "explicit_nonoccurrence",
        "intention",
        "record_or_verification_limit",
        "uncertain",
    ];
    let speeches = [
        "unknown",
        "request",
        "plan",
        "report",
        "verification",
        "retraction",
        "question",
    ];
    let statuses = [
        "unknown",
        "requested",
        "planned",
        "in_progress",
        "reported_completed",
        "reported_failed",
        "reported_cancelled",
        "reported_rolled_back",
        "retracted",
        "verified_completed",
        "verified_failed",
    ];
    let mut allowed = 0;
    for kind in kinds {
        let parsed_kind: AssertionKindQa = serde_json::from_value(json!(kind)).unwrap();
        for speech in speeches {
            let parsed_speech: SpeechAct = serde_json::from_value(json!(speech)).unwrap();
            for status in statuses {
                let parsed_status: ClaimStatus = serde_json::from_value(json!(status)).unwrap();
                let served_tags = mapping
                    .as_object()
                    .unwrap()
                    .values()
                    .filter(|triple| **triple == json!([kind, speech, status]))
                    .count();
                let stated = served_tags == 1;
                let native = wire::compatible_kind(parsed_kind, parsed_speech, parsed_status);
                assert_eq!(stated, native, "{kind}/{speech}/{status}");
                assert_eq!(
                    served_tags,
                    usize::from(native),
                    "served bijection {kind}/{speech}/{status}"
                );
                let tags = activity_type_contract_tests::TYPES
                    .iter()
                    .filter(|(_, k, s, t)| (*k, *s, *t) == (kind, speech, status))
                    .count();
                assert_eq!(
                    tags,
                    usize::from(native),
                    "bijection {kind}/{speech}/{status}"
                );
                allowed += usize::from(stated);
            }
        }
    }
    assert_eq!(allowed, 18);
    // Exporting constraints cannot alter source data or approve judgments.
    let served: Value = serde_json::from_str(prepared.user()).unwrap();
    assert_eq!(served["originalSpans"][0]["original"]["text"], BODY);
    assert!(served.get("activityCompatibility").is_none());
    let raw = output("The maintainer repaired the synthetic archive on 2026-10-01.");
    let mut incompatible = raw.clone();
    incompatible["units"][0]["interpretations"][0]["assertionKind"] =
        json!("record_or_verification_limit");
    assert!(prepared.expand(&incompatible.to_string()).is_err());
    assert!(prepared.expand(&raw.to_string()).is_ok());
}

fn json_members(members: &[(&str, String)]) -> String {
    format!(
        "{{{}}}",
        members
            .iter()
            .map(|(key, value)| format!("{}:{value}", serde_json::to_string(key).unwrap()))
            .collect::<Vec<_>>()
            .join(",")
    )
}

#[test]
fn source_reading_member_order_preserves_every_original_value_and_relative_clock() {
    let context = ask_context("role-A");
    for count in [1, 2, 8] {
        let documents = (0..count)
            .map(|index| {
                let body = format!(
                    "Synthetic {index}: yesterday was a plan, not execution.\r\n\t\"text\":\"speaker\", 한글 \\ untouched."
                );
                let turn = if index == 0 { "T-preamble".into() } else { format!("T{index}") };
                let turn_time = match index % 3 {
                    0 => None,
                    1 => Some("2026-10-03".into()),
                    _ => Some("2026-10-03T08:00:00+09:00".into()),
                };
                SourceDocument::bind(
                    format!("S-VIEW-{index}"), format!("sessions/view-{index}.md"),
                    format!("sessions/view-{index}.md"), &body,
                    if index == 0 { None } else { Some("2026-10-04".into()) },
                    vec![SpanInput {
                        id: format!("Q-VIEW-{index}"), start: 0, end: body.len(),
                        turn_id: turn.clone(),
                        speaker: if index == 0 { ActorRole::Unknown } else { ActorRole::User },
                        turn_time,
                    }],
                ).unwrap().with_turn_phases(&[(turn, if index % 2 == 0 { None } else { Some("commentary".into()) })]).unwrap()
            })
            .collect();
        let packet = SourceSet::new(origin(), Scope::Sessions, documents, vec![]).unwrap();
        let original_user = input(&packet);
        let original: Value = serde_json::from_str(&original_user).unwrap();
        let prepared = prepare(&packet, &context);
        // The activity-only wire changes policy while retaining the input layout.
        let layout_suffix = format!("\n{INSTRUCTIONS}");
        let policy = prepared.system().strip_suffix(&layout_suffix).unwrap();
        assert_eq!(policy.matches(INPUT_VERSION).count(), 1);
        assert!(policy.contains("NativeActivityTypesQaV2"));
        assert!(policy.contains("focusQuote, supportSpanIds, actor, eventTime, activityType and verificationId, in that order."));
        assert!(!policy.contains("Use compatible speechAct/status fields:"));
        let parsed: Value = serde_json::from_str(prepared.user()).unwrap();
        let old_values = json!({
            "version":INPUT_VERSION, "question":original["question"], "language":original["language"],
            "activityPeriod":original["activityPeriod"], "recordPeriodContext":original["recordPeriodContext"],
            "originalSpans":original["originalSpans"].as_array().unwrap().iter().enumerate()
                .map(|(ordinal, span)| json!({"unitOrdinal":ordinal,"original":span})).collect::<Vec<_>>(),
            "independentVerificationReceipts":[],
        });
        let mut restored = parsed.clone();
        for row in restored["originalSpans"].as_array_mut().unwrap() {
            let reading = &row["original"];
            assert_eq!(reading.as_object().unwrap().len(), 5);
            let mut flat = serde_json::Map::new();
            for key in ["id", "speaker", "text"] {
                flat.insert(key.into(), reading[key].clone());
            }
            for group in ["sourceContext", "provenance"] {
                for (key, value) in reading[group].as_object().unwrap() {
                    assert!(flat.insert(key.clone(), value.clone()).is_none());
                }
            }
            row["original"] = Value::Object(flat);
        }
        assert_eq!(
            restored, old_values,
            "the layout cannot change any original value"
        );
        let rows = original["originalSpans"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(ordinal, span)| {
                let fields = [
                    "id",
                    "speaker",
                    "text",
                    "turnId",
                    "turnTime",
                    "sourcePhase",
                    "recordTime",
                    "sourceId",
                    "sourcePath",
                    "selectionPath",
                    "sourceRevision",
                    "start",
                    "end",
                    "sha256",
                ];
                assert_eq!(span.as_object().unwrap().len(), fields.len());
                let encode_fields = |fields: &[&str]| {
                    json_members(
                        &fields
                            .iter()
                            .map(|key| (*key, span.get(*key).unwrap().to_string()))
                            .collect::<Vec<_>>(),
                    )
                };
                let ordered = json_members(&[
                    ("id", span["id"].to_string()),
                    ("speaker", span["speaker"].to_string()),
                    ("text", span["text"].to_string()),
                    ("sourceContext", encode_fields(&fields[3..7])),
                    ("provenance", encode_fields(&fields[7..])),
                ]);
                json_members(&[("unitOrdinal", ordinal.to_string()), ("original", ordered)])
            })
            .collect::<Vec<_>>()
            .join(",");
        let expected = json_members(&[
            ("version", json!(INPUT_VERSION).to_string()),
            ("question", original["question"].to_string()),
            ("language", original["language"].to_string()),
            ("originalSpans", format!("[{rows}]")),
            ("activityPeriod", original["activityPeriod"].to_string()),
            (
                "recordPeriodContext",
                original["recordPeriodContext"].to_string(),
            ),
            ("independentVerificationReceipts", "[]".into()),
        ]);
        assert_eq!(
            prepared.user(),
            expected,
            "actual served USER must use the declared member order"
        );
        let (system, counted) = PreparedOrdinalActivityQa::inputs(
            &original_user,
            context.payload(),
            context.revision(),
        )
        .unwrap();
        assert_eq!(counted, prepared.user());
        assert_eq!(system, prepared.system());
        assert_ne!(prepared.user(), old_values.to_string());
    }
}

#[test]
fn source_reading_refuses_to_drop_added_or_missing_original_metadata() {
    let packet = sources(BODY);
    let context = ask_context("role-A");
    let original: Value = serde_json::from_str(&input(&packet)).unwrap();
    let mut variants = Vec::new();
    let mut added = original.clone();
    added["originalSpans"][0]["futureMetadata"] = json!("must not disappear");
    variants.push(added);
    for key in ["turnTime", "recordTime", "sourcePhase"] {
        let mut missing = original.clone();
        missing["originalSpans"][0]
            .as_object_mut()
            .unwrap()
            .remove(key);
        variants.push(missing);
    }
    let mut renamed = original.clone();
    renamed["originalSpans"][0]
        .as_object_mut()
        .unwrap()
        .remove("turnTime");
    renamed["originalSpans"][0]["otherClock"] = Value::Null;
    variants.push(renamed);
    for variant in variants {
        assert!(PreparedOrdinalActivityQa::inputs(
            &variant.to_string(),
            context.payload(),
            context.revision()
        )
        .is_err());
    }
}

#[test]
fn source_reading_cannot_reuse_a_legacy_sorted_generation_receipt() {
    let packet = sources(BODY);
    let context = ask_context("role-A");
    let prepared = prepare(&packet, &context);
    let raw = output("The maintainer repaired the synthetic archive on 2026-10-01.").to_string();
    let mut projection = prepared.expand(&raw).unwrap();
    let checked = packet
        .validate(projection.canonical(), &origin(), Scope::Sessions)
        .unwrap();
    let parsed: Value = serde_json::from_str(prepared.user()).unwrap();
    projection.generation_user = parsed.to_string();
    assert_ne!(projection.generation_user, prepared.user());
    assert!(projection
        .review_value(&packet, &checked, context.payload())
        .is_err());
}

#[test]
fn source_reading_separates_turn_context_without_changing_private_originals_or_claims() {
    let packet = sources(BODY);
    let context = ask_context("role-A");
    let original_user = input(&packet);
    let original: Value = serde_json::from_str(&original_user).unwrap();
    let prepared = prepare(&packet, &context);
    let model: Value = serde_json::from_str(prepared.user()).unwrap();
    let reading = &model["originalSpans"][0]["original"];
    let source_context = reading["sourceContext"]
        .as_object()
        .expect("separate source context");
    let provenance = reading["provenance"]
        .as_object()
        .expect("separate provenance");
    assert_eq!(reading.as_object().unwrap().len(), 5);
    assert_eq!(source_context.len(), 4);
    assert_eq!(provenance.len(), 7);
    let mut restored = serde_json::Map::new();
    for key in ["id", "speaker", "text"] {
        restored.insert(key.into(), reading[key].clone());
    }
    restored.extend(source_context.clone());
    restored.extend(provenance.clone());
    assert_eq!(Value::Object(restored), original["originalSpans"][0]);
    assert_eq!(prepared.capture.original_user, original_user);
    assert_eq!(
        model["version"],
        "NativeSourceInterpretationOrdinalActivityQaInputV4"
    );
    let raw = output("The maintainer repaired the synthetic archive on 2026-10-01.").to_string();
    let projection = prepared.expand(&raw).unwrap();
    let checked = packet
        .validate(projection.canonical(), &origin(), Scope::Sessions)
        .unwrap();
    assert_eq!(checked.claims[0].proposal.actor.role, ActorRole::Source);
    assert_eq!(
        checked.claims[0].proposal.event_time.value.as_deref(),
        Some("2026-10-01")
    );
}
