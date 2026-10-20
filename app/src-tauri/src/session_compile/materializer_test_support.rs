//! Synthetic native-binding fixtures. These test projection/shape, not model
//! extraction quality, original-source entailment or independent verification.

use super::super::schema::NativeClaim;
use crate::retrieval::Scope;
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::{ActorRole, AppVerifiedFact, SourceDocument, SourceSet, SpanInput};
use serde_json::{json, Value};

pub(in crate::session_compile) fn user_span_id() -> String {
    "U".repeat(64)
}

pub(in crate::session_compile) fn assistant_span_id() -> String {
    "A".repeat(64)
}

pub(in crate::session_compile) fn origin() -> AgentVaultSession {
    AgentVaultSession {
        vault_path: "/synthetic/canonical-materializer".into(),
        opening_token: "canonical-test-opening".into(),
    }
}

pub(in crate::session_compile) fn source_set(facts: Vec<AppVerifiedFact>) -> SourceSet {
    let user = "Please request the synthetic report on 2026-10-01.\n";
    let assistant =
        "I plan to draft the synthetic report on 2026-10-02; no completion is recorded.\n";
    let original = format!("{user}{assistant}");
    let document = SourceDocument::bind(
        "synthetic-source".into(),
        "raw/conversations/codex/synthetic-materializer.md".into(),
        "raw/conversations/codex/synthetic-materializer.md".into(),
        &original,
        Some("2026-10-06".into()),
        vec![
            SpanInput {
                id: user_span_id(),
                start: 0,
                end: user.len(),
                turn_id: "user-turn".into(),
                speaker: ActorRole::User,
                turn_time: Some("2026-10-01T12:00:00Z".into()),
            },
            SpanInput {
                id: assistant_span_id(),
                start: user.len(),
                end: original.len(),
                turn_id: "assistant-turn".into(),
                speaker: ActorRole::Assistant,
                turn_time: Some("2026-10-02T12:00:00Z".into()),
            },
        ],
    )
    .unwrap();
    SourceSet::new(origin(), Scope::All, vec![document], facts).unwrap()
}

pub(in crate::session_compile) fn proposal(action: &str) -> Value {
    json!({
        "action":action,
        "anchorSpanId":user_span_id(),
        "supportSpanIds":[user_span_id()],
        "actor":{"role":"user","basis":"speaker","subjectSpanId":null},
        "eventTime":{"value":null,"basis":"unknown","precision":"unknown",
            "uncertainty":"unknown","supportSpanId":null},
        "speechAct":"request",
        "status":"requested",
        "verificationId":null
    })
}

pub(in crate::session_compile) fn bound(proposals: Vec<Value>) -> Vec<NativeClaim> {
    bound_with_facts(proposals, vec![])
}

pub(in crate::session_compile) fn bound_with_facts(
    proposals: Vec<Value>,
    facts: Vec<AppVerifiedFact>,
) -> Vec<NativeClaim> {
    let sources = source_set(facts);
    proposals
        .into_iter()
        .enumerate()
        .map(|(index, proposal)| {
            // Bind separately so worst-case generic row bounds can be tested
            // without changing the production extraction batch's 32-KiB cap.
            let mut checked = sources
                .validate(
                    &json!({"outcome":"claims","claims":[proposal]}).to_string(),
                    &origin(),
                    Scope::All,
                )
                .unwrap()
                .claims;
            NativeClaim {
                id: format!("{index:064}"),
                claim: checked.remove(0),
            }
        })
        .collect()
}

pub(in crate::session_compile) fn structure(claims: &[NativeClaim]) -> Value {
    json!({
        "version":"SessionStructureV1",
        "title":if claims.is_empty(){""}else{"Synthetic report"},
        "titleClaimIds":claims.iter().take(1).map(|claim|claim.id.clone()).collect::<Vec<_>>(),
        "entities":[]
    })
}
