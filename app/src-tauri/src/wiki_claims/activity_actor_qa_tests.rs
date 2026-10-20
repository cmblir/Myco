//! Synthetic actor-reference equivalence, never source-meaning or model-quality proof.
use super::*;
use crate::wiki_claims::{ActorBasis, ProposedActor};

const ROLES: [ActorRole; 6] = [
    ActorRole::User,
    ActorRole::Assistant,
    ActorRole::System,
    ActorRole::Tool,
    ActorRole::Source,
    ActorRole::Unknown,
];

fn packet(speakers: &[ActorRole], ids: &[&str]) -> SourceSet {
    let documents = speakers
        .iter()
        .zip(ids)
        .enumerate()
        .map(|(index, (speaker, id))| {
            let text = format!("The synthetic maintainer repaired archive {index}.");
            let path = format!("sessions/actor-{index}.md");
            SourceDocument::bind(
                format!("S-ACTOR-{index}"),
                path.clone(),
                path,
                &text,
                Some("2026-10-04".into()),
                vec![SpanInput {
                    id: (*id).into(),
                    start: 0,
                    end: text.len(),
                    turn_id: format!("T{index}"),
                    speaker: *speaker,
                    turn_time: None,
                }],
            )
            .unwrap()
        })
        .collect();
    SourceSet::new(origin(), Scope::Sessions, documents, vec![]).unwrap()
}

fn reply(packet: &SourceSet, actor: Value, supports: &[String]) -> Value {
    let units = packet.spans().enumerate().map(|(ordinal, span)| {
        if ordinal == 0 {
            json!({"unitOrdinal":ordinal,"relevance":"relevant","interpretations":[{
                "focusQuote":span.text(),"supportSpanIds":supports,"actor":actor,
                "eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},
                "activityType":"reported_completion","verificationId":null
            }]})
        } else {
            json!({"unitOrdinal":ordinal,"relevance":"not_relevant","interpretations":[]})
        }
    }).collect::<Vec<_>>();
    json!({"version":"NativeActivityTypesQaV2","units":units})
}

#[test]
fn activity_actor_all_six_speakers_match_native_actor_acceptance() {
    let context = ask_context("actor-equivalence");
    let mut examined = 0;
    for speaker in ROLES {
        let packet = packet(&[speaker, ActorRole::Source], &["Q-ANCHOR", "Q-SUBJECT"]);
        let prepared = prepare(&packet, &context);
        let ids = packet
            .spans()
            .map(|span| span.id().to_owned())
            .collect::<Vec<_>>();
        for supports in [ids[..1].to_vec(), ids.clone()] {
            let mut admitted = 0;
            for basis in [
                ActorBasis::Speaker,
                ActorBasis::Unknown,
                ActorBasis::ExplicitSubject,
            ] {
                for role in ROLES {
                    for subject in [None, Some(0), Some(1)] {
                        let actor = json!({"role":role,"basis":basis,"subjectOrdinal":subject});
                        let raw = reply(&packet, actor, &supports);
                        let native = json!({"outcome":"claims","claims":[{
                            "action":packet.spans().next().unwrap().text(),"anchorSpanId":ids[0],"supportSpanIds":supports,
                            "actor":ProposedActor { role, basis, subject_span_id:subject.map(|ordinal| ids[ordinal].clone()) },
                            "eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},
                            "speechAct":"report","status":"reported_completed","verificationId":null
                        }]}).to_string();
                        let expected = packet.validate(&native, &origin(), Scope::Sessions).is_ok();
                        let actual = prepared.expand(&raw.to_string());
                        assert_eq!(
                            actual.is_ok(),
                            expected,
                            "{speaker:?}/{basis:?}/{role:?}/{subject:?}/{supports:?}"
                        );
                        if let Ok(projection) = actual {
                            let checked = packet
                                .validate(projection.canonical(), &origin(), Scope::Sessions)
                                .unwrap();
                            assert_eq!(
                                serde_json::to_value(&checked.claims[0].proposal.actor).unwrap(),
                                serde_json::to_value(ProposedActor {
                                    role,
                                    basis,
                                    subject_span_id: subject.map(|ordinal| ids[ordinal].clone())
                                })
                                .unwrap()
                            );
                            assert!(checked.claims[0].semantic_review_required);
                            admitted += 1;
                        }
                        examined += 1;
                    }
                }
            }
            assert_eq!(admitted, 5 * supports.len() + 2);
        }
    }
    assert_eq!(examined, 648);
}

#[test]
fn activity_actor_ordinals_reject_bad_types_ranges_legacy_and_nullable_omissions() {
    let packet = packet(
        &[ActorRole::User, ActorRole::Source],
        &["Q-ANCHOR", "Q-SUBJECT"],
    );
    let context = ask_context("actor-strict-wire");
    let prepared = prepare(&packet, &context);
    let supports = vec!["Q-ANCHOR".into(), "Q-SUBJECT".into()];
    let valid = reply(
        &packet,
        json!({"role":"source","basis":"explicit_subject","subjectOrdinal":1}),
        &supports,
    );
    prepared.expand(&valid.to_string()).unwrap();
    for value in [
        json!("null"),
        json!("1"),
        json!(-1),
        json!(1.0),
        json!(true),
        json!({}),
        json!([]),
        json!(2),
        json!(usize::MAX),
    ] {
        let mut wrong = valid.clone();
        wrong["units"][0]["interpretations"][0]["actor"]["subjectOrdinal"] = value.clone();
        assert!(prepared.expand(&wrong.to_string()).is_err(), "{value}");
    }
    for actor in [
        json!({"role":"source","basis":"explicit_subject"}),
        json!({"role":"source","basis":"explicit_subject","subjectSpanId":"Q-SUBJECT"}),
        json!({"role":"source","basis":"explicit_subject","subjectOrdinal":1,"subjectSpanId":"null"}),
        json!({"role":"source","basis":"explicit_subject","subjectOrdinal":null}),
        json!({"role":"user","basis":"speaker","subjectOrdinal":0}),
        json!({"role":"unknown","basis":"unknown","subjectOrdinal":0}),
    ] {
        let mut wrong = valid.clone();
        wrong["units"][0]["interpretations"][0]["actor"] = actor;
        assert!(prepared.expand(&wrong.to_string()).is_err());
    }
    let duplicate = valid.to_string().replace(
        "\"subjectOrdinal\":1",
        "\"subjectOrdinal\":1,\"subjectOrdinal\":1",
    );
    assert!(prepared
        .expand(&duplicate)
        .err()
        .unwrap()
        .contains("duplicate field"));
    let mut old_wire = valid.clone();
    old_wire["version"] = json!("NativeActivityTypesQaV1");
    assert!(prepared.expand(&old_wire.to_string()).is_err());
    let mut missing_support = valid;
    missing_support["units"][0]["interpretations"][0]["supportSpanIds"] = json!(["Q-ANCHOR"]);
    let error = prepared.expand(&missing_support.to_string()).err().unwrap();
    assert!(
        error.contains("claim actor"),
        "cross-span membership still reaches native actor guard: {error}"
    );
}

#[test]
fn activity_actor_literal_null_source_id_is_not_a_null_or_string_special_case() {
    let packet = packet(&[ActorRole::User, ActorRole::Source], &["Q-ANCHOR", "null"]);
    let context = ask_context("literal-id-null");
    let prepared = prepare(&packet, &context);
    let raw = reply(
        &packet,
        json!({"role":"source","basis":"explicit_subject","subjectOrdinal":1}),
        &["Q-ANCHOR".into(), "null".into()],
    )
    .to_string();
    let projection = prepared.expand(&raw).unwrap();
    let checked = packet
        .validate(projection.canonical(), &origin(), Scope::Sessions)
        .unwrap();
    assert_eq!(
        checked.claims[0].proposal.actor.subject_span_id.as_deref(),
        Some("null")
    );
    assert_eq!(
        checked.claims[0].proposal.support_span_ids,
        vec!["Q-ANCHOR", "null"]
    );
    projection.verify_model_result(&raw).unwrap();
}

#[test]
fn activity_actor_grammar_binds_every_row_speaker_and_keeps_eight_original_limit() {
    let context = ask_context("actor-grammar-capture");
    for count in [1, 2, 8] {
        let speakers = ROLES.into_iter().cycle().take(count).collect::<Vec<_>>();
        let ids = (0..count)
            .map(|ordinal| format!("Q{ordinal}"))
            .collect::<Vec<_>>();
        let id_refs = ids.iter().map(String::as_str).collect::<Vec<_>>();
        let packet = packet(&speakers, &id_refs);
        let prepared = prepare(&packet, &context);
        let grammar = prepared.decoder().grammar();
        assert_eq!(prepared.decoder().units(), count);
        for (ordinal, speaker) in speakers.iter().enumerate() {
            let row = grammar
                .lines()
                .find(|line| line.starts_with(&format!("unit-{ordinal} ::= ")))
                .unwrap();
            assert!(row.contains(&format!("ws interpretation-{ordinal} ")));
            let interpretation = grammar
                .lines()
                .find(|line| line.starts_with(&format!("interpretation-{ordinal} ::= ")))
                .unwrap();
            assert!(interpretation.contains(&format!("ws actor-{ordinal} ")));
            let actor = grammar
                .lines()
                .find(|line| line.starts_with(&format!("actor-{ordinal} ::= ")))
                .unwrap();
            let role = serde_json::to_string(&serde_json::to_string(speaker).unwrap()).unwrap();
            assert!(actor.contains(&format!("({role} ")));
            assert!(actor.contains("subjectOrdinal"));
            assert!(!actor.contains("subjectSpanId"));
        }
        let ordinals = (0..count)
            .map(|ordinal| format!("\"{ordinal}\""))
            .collect::<Vec<_>>()
            .join(" | ");
        assert!(grammar.contains(&format!("subject-ordinal ::= {ordinals}")));
        for field in [
            "time ::=",
            "day-value ::=",
            "instant-value ::=",
            "inferred-basis ::=",
            "id ::=",
        ] {
            assert_eq!(
                grammar.lines().find(|line| line.starts_with(field)),
                prepared
                    .core
                    .count()
                    .grammar()
                    .lines()
                    .find(|line| line.starts_with(field))
            );
        }
    }
    let ids = (0..16)
        .map(|ordinal| format!("Q{ordinal}"))
        .collect::<Vec<_>>();
    let id_refs = ids.iter().map(String::as_str).collect::<Vec<_>>();
    let nine = packet(&[ActorRole::User; 9], &id_refs[..9]);
    assert!(PreparedOrdinalActivityQa::inputs(
        &input(&nine),
        context.payload(),
        context.revision()
    )
    .is_err());
    let sixteen = packet(&[ActorRole::User; 16], &id_refs);
    let core = crate::wiki_claims::source_interpretation_qa::prepare_candidate(
        &sixteen,
        &origin(),
        Scope::Sessions,
        CandidateQa::OrdinalV3,
    )
    .unwrap();
    assert_eq!(core.count().units(), 16);
    assert!(core.count().grammar().contains("unit-15 ::= "));
}

#[test]
fn activity_actor_context_mapping_raw_and_canonical_tampering_cannot_rebind() {
    let packet = packet(
        &[ActorRole::User, ActorRole::Source],
        &["Q-ANCHOR", "Q-SUBJECT"],
    );
    let context = ask_context("actor-capture-binding");
    let prepared = prepare(&packet, &context);
    let raw = reply(
        &packet,
        json!({"role":"source","basis":"explicit_subject","subjectOrdinal":1}),
        &["Q-ANCHOR".into(), "Q-SUBJECT".into()],
    )
    .to_string();
    let pristine = prepared.expand(&raw).unwrap();
    let checked = packet
        .validate(pristine.canonical(), &origin(), Scope::Sessions)
        .unwrap();
    let mut old_context = context.payload().clone();
    old_context["sourceFocusQaEncoding"] = json!("ordinal_activity_v2");
    assert!(
        PreparedOrdinalActivityQa::inputs(&input(&packet), &old_context, context.revision())
            .is_err()
    );
    for mutation in 0..3 {
        let mut changed: Value = serde_json::from_str(&input(&packet)).unwrap();
        match mutation {
            0 => {
                changed["originalSpans"][1]["id"] = json!("Q-REBOUND");
                changed["allowedSpanIds"][1] = json!("Q-REBOUND");
            }
            1 => changed["originalSpans"][0]["speaker"] = json!("assistant"),
            _ => {
                changed["originalSpans"].as_array_mut().unwrap().swap(0, 1);
                changed["allowedSpanIds"].as_array_mut().unwrap().swap(0, 1);
            }
        }
        assert!(
            PreparedOrdinalActivityQa::prepare(
                &changed.to_string(),
                &packet,
                &origin(),
                Scope::Sessions,
                context.payload(),
                context.revision()
            )
            .is_err(),
            "same-count source table mutation {mutation}"
        );
    }
    for mutation in 0..4 {
        let mut changed = pristine.clone();
        match mutation {
            0 => {
                changed.model_raw = raw.replace("\"subjectOrdinal\":1", "\"subjectOrdinal\":0");
                changed.model_raw_sha256 = sha256(changed.model_raw.as_bytes());
            }
            1 => {
                changed.canonical = changed.canonical.replace(
                    "\"subjectSpanId\":\"Q-SUBJECT\"",
                    "\"subjectSpanId\":\"Q-ANCHOR\"",
                )
            }
            2 => changed.original_spans.swap(0, 1),
            _ => changed.version = "NativeSourceInterpretationOrdinalActivityQaV2",
        }
        assert!(
            changed
                .model_review_value(&packet, &checked, context.payload())
                .is_err(),
            "mutation {mutation}"
        );
    }
}
