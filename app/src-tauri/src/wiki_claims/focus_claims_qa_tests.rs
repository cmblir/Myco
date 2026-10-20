//! Synthetic binding checks; no model meaning or publication is graded here.

use super::*;
use crate::commands::DateRange;
use crate::retrieval::Scope;
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::{SourceDocument, SpanInput};
use serde_json::json;

#[path = "focus_claims_correction_qa_tests.rs"]
mod correction_tests;

const FIRST: &str = "Please repair the archive. I have not repaired the archive on 2026-10-01. The maintainer repaired the archive on 2026-10-01. I cancelled the rollout. I reopened the investigation. I did not deploy.";
const SECOND: &str = "I finished drafting the archive repair plan. The archive has not been repaired. I cannot confirm whether the maintainer executed the repair. 지금은 초안만 작성했습니다.  exact spaced focus  ";

fn origin() -> AgentVaultSession {
    AgentVaultSession {
        vault_path: "/synthetic/source-focus-qa".into(),
        opening_token: "source-focus-opening".into(),
    }
}

fn source_set(first: &str, second: &str, reversed: bool) -> SourceSet {
    let prefix = "선행 원문\n";
    let original = format!("{prefix}{first}\n{second}");
    let second_start = prefix.len() + first.len() + 1;
    let mut spans = vec![
        SpanInput {
            id: "Q-FIRST".into(),
            start: prefix.len(),
            end: prefix.len() + first.len(),
            turn_id: "T-FIRST".into(),
            speaker: ActorRole::User,
            turn_time: Some("2026-10-03T08:00:00Z".into()),
        },
        SpanInput {
            id: "Q-SECOND".into(),
            start: second_start,
            end: original.len(),
            turn_id: "T-SECOND".into(),
            speaker: ActorRole::Assistant,
            turn_time: Some("2026-10-04T09:00:00Z".into()),
        },
    ];
    if reversed {
        spans.reverse();
    }
    let document = SourceDocument::bind(
        "S-FOCUS".into(),
        "sessions/focus-original.md".into(),
        "sessions/focus-original.md".into(),
        &original,
        Some("2026-10-02".into()),
        spans,
    )
    .unwrap()
    .with_turn_phases(&[
        ("T-FIRST".into(), Some("final".into())),
        ("T-SECOND".into(), Some("final".into())),
    ])
    .unwrap();
    SourceSet::new(origin(), Scope::Sessions, vec![document], vec![]).unwrap()
}

fn period() -> DateRange {
    DateRange {
        start: "2026-10-01".into(),
        end: "2026-10-04".into(),
        start_epoch: crate::importers::parse_iso8601("2026-09-30T15:00:00Z"),
        end_epoch: crate::importers::parse_iso8601("2026-10-04T15:00:00Z"),
    }
}

fn input(sources: &SourceSet) -> String {
    let spans = sources.spans().collect::<Vec<_>>();
    crate::local_synthesis::claim_prompt::payload(
        "Summarize recent activity",
        "en",
        &period(),
        &spans,
    )
    .unwrap()
}

fn prepared() -> (SourceSet, PreparedFocusQa) {
    let sources = source_set(FIRST, SECOND, false);
    let prepared = PreparedFocusQa::prepare(&input(&sources)).unwrap();
    (sources, prepared)
}

fn claim(anchor: usize, focus: &str, kind: &str, speech: &str, status: &str) -> Value {
    json!([
        anchor,
        focus,
        kind,
        [anchor],
        [
            if anchor == 0 { "user" } else { "assistant" },
            "speaker",
            null
        ],
        [null, "unknown", "unknown", "unknown", null],
        speech,
        status,
        null
    ])
}

fn output(prepared: &PreparedFocusQa, claims: Vec<Value>) -> Value {
    json!({"version":VERSION,"packetSha256":prepared.decoder().packet_sha256(),
        "outcome":if claims.is_empty() {"insufficient_evidence"} else {"claims"},"claims":claims})
}

fn sample(prepared: &PreparedFocusQa) -> Value {
    let mut third_party = claim(
        0,
        "The maintainer repaired the archive on 2026-10-01.",
        "asserted_occurrence",
        "report",
        "reported_completed",
    );
    third_party[4] = json!(["source", "explicit_subject", 0]);
    third_party[5] = json!(["2026-10-01", "explicit", "day", "specified", 0]);
    let mut nonperformance = claim(
        0,
        "I have not repaired the archive on 2026-10-01.",
        "explicit_nonoccurrence",
        "report",
        "unknown",
    );
    nonperformance[5] = json!(["2026-10-01", "explicit", "day", "specified", 0]);
    output(
        prepared,
        vec![
            claim(
                0,
                "Please repair the archive.",
                "intention",
                "request",
                "requested",
            ),
            nonperformance,
            third_party,
            claim(
                0,
                "I cancelled the rollout.",
                "asserted_occurrence",
                "report",
                "reported_cancelled",
            ),
            claim(
                0,
                "I reopened the investigation.",
                "asserted_occurrence",
                "report",
                "reported_completed",
            ),
            claim(
                0,
                "I did not deploy.",
                "explicit_nonoccurrence",
                "report",
                "unknown",
            ),
            claim(
                1,
                "I finished drafting the archive repair plan.",
                "asserted_occurrence",
                "report",
                "reported_completed",
            ),
            claim(
                1,
                "The archive has not been repaired.",
                "explicit_nonoccurrence",
                "report",
                "unknown",
            ),
            claim(
                1,
                "I cannot confirm whether the maintainer executed the repair.",
                "record_or_verification_limit",
                "report",
                "unknown",
            ),
        ],
    )
}

fn checked_projection(sources: &SourceSet, projection: &FocusProjectionQa) -> CheckedClaims {
    sources
        .validate(projection.canonical(), &origin(), Scope::Sessions)
        .unwrap()
}

#[test]
fn complete_originals_and_declared_fields_survive_without_authority() {
    let (sources, prepared) = prepared();
    let original: Value = serde_json::from_str(prepared.original_user()).unwrap();
    let mut augmented: Value = serde_json::from_str(prepared.user()).unwrap();
    assert_eq!(augmented["originalSpans"], original["originalSpans"]);
    assert_eq!(
        augmented["spanOrdinalDictionary"],
        json!([{"ordinal":0,"spanId":"Q-FIRST"},{"ordinal":1,"spanId":"Q-SECOND"}])
    );
    assert_eq!(
        augmented["packetSha256"],
        sha256(prepared.original_user().as_bytes())
    );
    augmented
        .as_object_mut()
        .unwrap()
        .remove("spanOrdinalDictionary");
    augmented.as_object_mut().unwrap().remove("packetSha256");
    assert_eq!(augmented, original);
    assert!(prepared
        .system()
        .ends_with(crate::activity_recall::period_context::INSTRUCTIONS));
    assert!(!prepared.system().contains(FIRST));
    let projection = prepared.expand(&sample(&prepared).to_string()).unwrap();
    let checked = checked_projection(&sources, &projection);
    assert_eq!(checked.claims.len(), 9);
    let claims = &checked.claims;
    assert_eq!(claims[0].proposal.action, "Please repair the archive.");
    assert_eq!(
        claims[0].proposal.speech_act,
        crate::wiki_claims::SpeechAct::Request
    );
    assert_eq!(
        claims[1].proposal.status,
        crate::wiki_claims::ClaimStatus::Unknown
    );
    assert_eq!(claims[2].proposal.actor.role, ActorRole::Source);
    assert_eq!(
        claims[2].proposal.actor.subject_span_id.as_deref(),
        Some("Q-FIRST")
    );
    assert_eq!(
        claims[2].proposal.event_time.value.as_deref(),
        Some("2026-10-01")
    );
    assert_eq!(
        claims[3].proposal.status,
        crate::wiki_claims::ClaimStatus::ReportedCancelled
    );
    assert_eq!(
        claims[4].proposal.status,
        crate::wiki_claims::ClaimStatus::ReportedCompleted
    );
    assert_eq!(
        claims[6].proposal.action,
        "I finished drafting the archive repair plan."
    );
    assert!(claims.iter().all(|claim| claim.structure_checked
        && claim.semantic_review_required
        && claim.proposal.verification_id.is_none()));
    let sidecar = projection
        .review_value(&sources, &checked, &original)
        .unwrap();
    assert_eq!(sidecar["semanticAccepted"], false);
    assert_eq!(sidecar["nativeIoAuthenticated"], false);
    assert_eq!(sidecar["productionAccepted"], false);
    assert_eq!(sidecar["semanticReviewRequired"], true);
    assert!(sidecar.get("originalSpans").is_none() && sidecar.get("canonical").is_none());
    assert_eq!(projection.revision().len(), 64);
}

#[test]
fn exact_unicode_and_whitespace_focus_uses_native_absolute_byte_coordinates() {
    let (sources, prepared) = prepared();
    for focus in ["지금은 초안만 작성했습니다.", "  exact spaced focus  "] {
        let raw = output(
            &prepared,
            vec![claim(1, focus, "asserted_occurrence", "report", "unknown")],
        );
        let projection = prepared.expand(&raw.to_string()).unwrap();
        let checked = checked_projection(&sources, &projection);
        assert_eq!(checked.claims[0].proposal.action, focus);
        let span = sources.spans().nth(1).unwrap();
        let witness = &projection.witnesses[0];
        assert_eq!(witness.start, span.start() + SECOND.find(focus).unwrap());
        assert_eq!(witness.end - witness.start, focus.len());
        assert_eq!(witness.focus_sha256, sha256(focus.as_bytes()));
        assert_eq!(witness.source_revision, span.source_revision());
        assert_eq!(witness.anchor_span_id, "Q-SECOND");
        let value = projection
            .ordered_answer_witnesses(&[&checked.claims[0].proposal])
            .unwrap()
            .remove(0);
        assert_eq!(
            value["proposalSha256"],
            proposal_sha256(&checked.claims[0].proposal).unwrap()
        );
        assert!(value.get("text").is_none() && value.get("action").is_none());
    }
}

#[test]
fn unknown_and_third_party_fields_are_preserved_without_actor_guesses() {
    let (sources, prepared) = prepared();
    let mut unknown = claim(
        1,
        "I finished drafting the archive repair plan.",
        "asserted_occurrence",
        "report",
        "unknown",
    );
    unknown[4] = json!(["unknown", "unknown", null]);
    let projection = prepared
        .expand(&output(&prepared, vec![unknown]).to_string())
        .unwrap();
    let checked = checked_projection(&sources, &projection);
    assert_eq!(checked.claims[0].proposal.actor.role, ActorRole::Unknown);
    assert_eq!(checked.claims[0].proposal.event_time.value, None);
    assert_eq!(
        checked.claims[0].proposal.status,
        crate::wiki_claims::ClaimStatus::Unknown
    );
    assert!(!projection.semantic_accepted);
}

#[test]
fn exact_focus_with_false_kind_is_not_semantically_approved() {
    let (sources, prepared) = prepared();
    let false_judgment = claim(
        1,
        "I finished drafting the archive repair plan.",
        "explicit_nonoccurrence",
        "report",
        "unknown",
    );
    let projection = prepared
        .expand(&output(&prepared, vec![false_judgment]).to_string())
        .unwrap();
    let checked = checked_projection(&sources, &projection);
    let context: Value = serde_json::from_str(prepared.original_user()).unwrap();
    let sidecar = projection
        .review_value(&sources, &checked, &context)
        .unwrap();
    assert_eq!(
        checked.claims[0].proposal.action,
        "I finished drafting the archive repair plan."
    );
    assert_eq!(
        sidecar["witnesses"][0]["assertionKind"],
        "explicit_nonoccurrence"
    );
    assert_eq!(sidecar["semanticAccepted"], false);
    assert_eq!(sidecar["productionAccepted"], false);
    let model_sidecar = projection
        .model_review_value(&sources, &checked, &context)
        .unwrap();
    assert_eq!(
        model_sidecar["claims"],
        json!([{"id":"C0","assertionKind":"explicit_nonoccurrence"}])
    );
    assert_eq!(model_sidecar["untrustedModelJudgments"], true);
    assert_eq!(model_sidecar["semanticAccepted"], false);
    let negated = claim(
        0,
        "I have not repaired the archive on 2026-10-01.",
        "asserted_occurrence",
        "report",
        "reported_completed",
    );
    let negated_projection = prepared
        .expand(&output(&prepared, vec![negated]).to_string())
        .unwrap();
    let negated_checked = checked_projection(&sources, &negated_projection);
    let negated_model = negated_projection
        .model_review_value(&sources, &negated_checked, &context)
        .unwrap();
    assert_eq!(
        negated_checked.claims[0].proposal.status,
        crate::wiki_claims::ClaimStatus::ReportedCompleted
    );
    assert_eq!(
        negated_model["claims"],
        json!([{"id":"C0","assertionKind":"asserted_occurrence"}])
    );
    assert_eq!(negated_model["semanticAccepted"], false);
}

#[test]
fn model_review_kinds_match_native_claim_ids_in_order_without_prompt_proof_duplicates() {
    let (sources, prepared) = prepared();
    let mut raw = sample(&prepared);
    raw["claims"].as_array_mut().unwrap().push(claim(
        1,
        "지금은 초안만 작성했습니다.",
        "uncertain",
        "question",
        "unknown",
    ));
    let projection = prepared.expand(&raw.to_string()).unwrap();
    let checked = checked_projection(&sources, &projection);
    let context: Value = serde_json::from_str(prepared.original_user()).unwrap();
    let full_before = projection
        .review_value(&sources, &checked, &context)
        .unwrap();
    let canonical_before = projection.canonical().to_owned();
    let model = projection
        .model_review_value(&sources, &checked, &context)
        .unwrap();
    assert_eq!(
        model,
        json!({"version":VERSION,"claims":[
        {"id":"C0","assertionKind":"intention"},
        {"id":"C1","assertionKind":"explicit_nonoccurrence"},
        {"id":"C2","assertionKind":"asserted_occurrence"},
        {"id":"C3","assertionKind":"asserted_occurrence"},
        {"id":"C4","assertionKind":"asserted_occurrence"},
        {"id":"C5","assertionKind":"explicit_nonoccurrence"},
        {"id":"C6","assertionKind":"asserted_occurrence"},
        {"id":"C7","assertionKind":"explicit_nonoccurrence"},
        {"id":"C8","assertionKind":"record_or_verification_limit"},
        {"id":"C9","assertionKind":"uncertain"}],
        "untrustedModelJudgments":true,"semanticReviewRequired":true,
        "semanticAccepted":false,"nativeIoAuthenticated":false,"productionAccepted":false})
    );
    assert_eq!(
        model["claims"].as_array().unwrap().len(),
        checked.claims.len()
    );
    assert!(model.get("interpretationRevision").is_none());
    assert!(model.get("witnesses").is_none() && model.get("packetSha256").is_none());
    assert_eq!(projection.canonical(), canonical_before);
    assert_eq!(
        projection
            .review_value(&sources, &checked, &context)
            .unwrap(),
        full_before
    );
    assert_eq!(
        full_before["witnesses"][2]["sourceRevision"],
        sources.spans().next().unwrap().source_revision()
    );
    assert_eq!(
        full_before["witnesses"][2]["focusSha256"],
        sha256(checked.claims[2].proposal.action.as_bytes())
    );
    assert!(full_before["witnesses"][2]["start"].is_u64());
    assert!(full_before["witnesses"][2]["end"].is_u64());
    assert_eq!(checked.claims[2].proposal.actor.role, ActorRole::Source);
    assert_eq!(
        checked.claims[2].proposal.event_time.value.as_deref(),
        Some("2026-10-01")
    );
}

#[test]
fn model_review_rejects_changed_order_cardinality_native_fields_sources_and_context() {
    let (sources, prepared) = prepared();
    let projection = prepared.expand(&sample(&prepared).to_string()).unwrap();
    let checked = checked_projection(&sources, &projection);
    let context: Value = serde_json::from_str(prepared.original_user()).unwrap();
    let mut reordered = checked.clone();
    reordered.claims.swap(0, 1);
    assert!(projection
        .model_review_value(&sources, &reordered, &context)
        .is_err());
    let mut omitted = checked.clone();
    omitted.claims.pop();
    assert!(projection
        .model_review_value(&sources, &omitted, &context)
        .is_err());
    let mut duplicated = checked.clone();
    duplicated.claims.push(checked.claims[0].clone());
    assert!(projection
        .model_review_value(&sources, &duplicated, &context)
        .is_err());
    let mut changed = checked.clone();
    changed.claims[2].proposal.actor.role = ActorRole::User;
    assert!(projection
        .model_review_value(&sources, &changed, &context)
        .is_err());
    let reordered_sources = source_set(FIRST, SECOND, true);
    assert!(projection
        .model_review_value(&reordered_sources, &checked, &context)
        .is_err());
    let changed_sources = source_set(&FIRST.replace("archive", "catalog"), SECOND, false);
    assert!(projection
        .model_review_value(&changed_sources, &checked, &context)
        .is_err());
    for (field, value) in [
        ("question", json!("What is next?")),
        ("language", json!("ko")),
        (
            "activityPeriod",
            json!({"start":"2026-10-02","end":"2026-10-04"}),
        ),
    ] {
        let mut changed_context = context.clone();
        changed_context[field] = value;
        assert!(projection
            .model_review_value(&sources, &checked, &changed_context)
            .is_err());
    }
}

#[test]
fn review_rejects_changed_question_language_period_sources_or_ordered_claims() {
    let (sources, prepared) = prepared();
    let projection = prepared.expand(&sample(&prepared).to_string()).unwrap();
    let checked = checked_projection(&sources, &projection);
    let context: Value = serde_json::from_str(prepared.original_user()).unwrap();
    for (field, replacement) in [
        ("question", json!("What is next?")),
        ("language", json!("ko")),
        (
            "activityPeriod",
            json!({"start":"2026-10-02","end":"2026-10-04"}),
        ),
    ] {
        let mut changed = context.clone();
        changed[field] = replacement;
        assert!(projection
            .review_value(&sources, &checked, &changed)
            .is_err());
    }
    let reordered = source_set(FIRST, SECOND, true);
    assert!(projection
        .review_value(&reordered, &checked, &context)
        .is_err());
    let changed = source_set(&FIRST.replace("archive", "catalog"), SECOND, false);
    assert!(projection
        .review_value(&changed, &checked, &context)
        .is_err());
    let mut changed = checked.clone();
    changed.claims.swap(0, 1);
    assert!(projection
        .review_value(&sources, &changed, &context)
        .is_err());
    let mut changed = checked.clone();
    changed.claims[0].provenance.clear();
    assert!(projection
        .review_value(&sources, &changed, &context)
        .is_err());
    let mut changed = checked;
    changed.claims[0].semantic_review_required = false;
    assert!(projection
        .review_value(&sources, &changed, &context)
        .is_err());
}

#[test]
fn forged_period_sidecar_and_mutated_projection_fail_review_binding() {
    let (sources, prepared) = prepared();
    let context: Value = serde_json::from_str(prepared.original_user()).unwrap();
    let projection = prepared.expand(&sample(&prepared).to_string()).unwrap();
    let checked = checked_projection(&sources, &projection);
    let mut forged = context.clone();
    forged["recordPeriodContext"]["counts"]["inPeriodSpans"] = json!(900);
    let forged_prepared = PreparedFocusQa::prepare(&forged.to_string()).unwrap();
    let forged_projection = forged_prepared
        .expand(&sample(&forged_prepared).to_string())
        .unwrap();
    let forged_checked = checked_projection(&sources, &forged_projection);
    assert!(forged_projection
        .review_value(&sources, &forged_checked, &forged)
        .is_err());
    let mut modified = projection.clone();
    modified.witnesses[0].start += 1;
    assert!(modified.review_value(&sources, &checked, &context).is_err());
    let mut modified = projection;
    modified.semantic_accepted = true;
    let proposals = checked
        .claims
        .iter()
        .map(|claim| &claim.proposal)
        .collect::<Vec<_>>();
    assert!(modified.ordered_answer_witnesses(&proposals).is_err());
}

#[test]
fn answer_witnesses_require_all_initial_proposals_in_their_exact_captured_order() {
    let (sources, prepared) = prepared();
    let projection = prepared.expand(&sample(&prepared).to_string()).unwrap();
    let checked = checked_projection(&sources, &projection);
    let proposals = checked
        .claims
        .iter()
        .map(|claim| &claim.proposal)
        .collect::<Vec<_>>();
    let witnesses = projection.ordered_answer_witnesses(&proposals).unwrap();
    assert_eq!(projection.proposal_count(), 9);
    assert_eq!(witnesses.len(), 9);
    assert_eq!(witnesses[0]["anchorSpanId"], "Q-FIRST");
    assert_eq!(witnesses[6]["anchorSpanId"], "Q-SECOND");
    for (proposal, witness) in proposals.iter().zip(&witnesses) {
        assert_eq!(
            witness["proposalSha256"],
            proposal_sha256(proposal).unwrap()
        );
    }
    let mut reordered = proposals.clone();
    reordered.swap(0, 1);
    assert!(projection.ordered_answer_witnesses(&reordered).is_err());
    assert!(projection
        .ordered_answer_witnesses(&proposals[..8])
        .is_err());
    assert!(projection.ordered_answer_witnesses(&[]).is_err());
    let mut foreign = checked.claims[0].proposal.clone();
    foreign.action = "A different batch proposal".into();
    let mut mutated = proposals.clone();
    mutated[0] = &foreign;
    assert!(projection.ordered_answer_witnesses(&mutated).is_err());
    let mut duplicated = proposals;
    duplicated[1] = duplicated[0];
    assert!(projection.ordered_answer_witnesses(&duplicated).is_err());
}

#[test]
fn answer_context_requires_exact_request_and_ordered_originals_but_allows_later_sources() {
    let (sources, prepared) = prepared();
    let projection = prepared.expand(&sample(&prepared).to_string()).unwrap();
    let closure = sources.spans().cloned().collect::<Vec<_>>();
    let question = "Summarize recent activity";
    projection
        .verify_answer_context(question, "en", &period(), &closure)
        .unwrap();
    assert!(projection
        .verify_answer_context("What is next?", "en", &period(), &closure)
        .is_err());
    assert!(projection
        .verify_answer_context(question, "ko", &period(), &closure)
        .is_err());
    let mut changed_period = period();
    changed_period.start_epoch = changed_period.start_epoch.map(|epoch| epoch - 1);
    assert!(projection
        .verify_answer_context(question, "en", &changed_period, &closure)
        .is_err());
    let mut reordered = closure.clone();
    reordered.reverse();
    assert!(projection
        .verify_answer_context(question, "en", &period(), &reordered)
        .is_err());
    assert!(projection
        .verify_answer_context(question, "en", &period(), &closure[..1])
        .is_err());
    let mut duplicated = closure.clone();
    duplicated.insert(0, closure[0].clone());
    assert!(projection
        .verify_answer_context(question, "en", &period(), &duplicated)
        .is_err());
    let changed_sources = source_set(&FIRST.replace("archive", "catalog"), SECOND, false);
    let changed_closure = changed_sources.spans().cloned().collect::<Vec<_>>();
    assert!(projection
        .verify_answer_context(question, "en", &period(), &changed_closure)
        .is_err());
    let changed_document = sources.documents()[0]
        .clone()
        .with_turn_phases(&[("T-FIRST".into(), Some("analysis".into()))])
        .unwrap();
    let changed_metadata =
        SourceSet::new(origin(), Scope::Sessions, vec![changed_document], vec![]).unwrap();
    let changed_closure = changed_metadata.spans().cloned().collect::<Vec<_>>();
    assert_eq!(changed_closure[0].text(), closure[0].text());
    assert!(projection
        .verify_answer_context(question, "en", &period(), &changed_closure)
        .is_err());
    let later_text = "I later reviewed an unrelated synthetic task.";
    let later = SourceDocument::bind(
        "S-LATER".into(),
        "sessions/focus-later.md".into(),
        "sessions/focus-later.md".into(),
        later_text,
        Some("2026-10-05".into()),
        vec![SpanInput {
            id: "Q-LATER".into(),
            start: 0,
            end: later_text.len(),
            turn_id: "T-LATER".into(),
            speaker: ActorRole::User,
            turn_time: Some("2026-10-05T08:00:00Z".into()),
        }],
    )
    .unwrap();
    let later = SourceSet::new(origin(), Scope::Sessions, vec![later], vec![]).unwrap();
    let superset = sources
        .merged(&later)
        .unwrap()
        .spans()
        .cloned()
        .collect::<Vec<_>>();
    projection
        .verify_answer_context(question, "en", &period(), &superset)
        .unwrap();
    let mut interleaved = closure;
    interleaved.insert(1, later.spans().next().unwrap().clone());
    projection
        .verify_answer_context(question, "en", &period(), &interleaved)
        .unwrap();
    let mut original: Value = serde_json::from_str(prepared.original_user()).unwrap();
    original["originalSpans"][1] = original["originalSpans"][0].clone();
    original["allowedSpanIds"][1] = original["allowedSpanIds"][0].clone();
    assert!(PreparedFocusQa::prepare(&original.to_string()).is_err());
}

#[test]
fn insufficient_evidence_is_empty_and_does_not_approve_coverage() {
    let (sources, prepared) = prepared();
    let projection = prepared
        .expand(&output(&prepared, vec![]).to_string())
        .unwrap();
    let checked = checked_projection(&sources, &projection);
    assert!(checked.claims.is_empty());
    assert_eq!(projection.proposal_count(), 0);
    assert!(projection.ordered_answer_witnesses(&[]).unwrap().is_empty());
    assert_eq!(
        checked.outcome,
        crate::wiki_claims::ClaimOutcome::InsufficientEvidence
    );
    assert_eq!(
        serde_json::to_value(&projection).unwrap()["semanticAccepted"],
        false
    );
    let context: Value = serde_json::from_str(prepared.original_user()).unwrap();
    let model = projection
        .model_review_value(&sources, &checked, &context)
        .unwrap();
    assert_eq!(model["claims"], json!([]));
    assert_eq!(model["semanticReviewRequired"], true);
    assert_eq!(model["semanticAccepted"], false);
}

#[path = "focus_claims_qa_rejection_tests.rs"]
mod rejection;
