//! Pure packet and byte-budget controls; no model or semantic acceptance.

use super::*;
use crate::wiki_claims::focus_claims_qa::{PreparedFocusQa, VERSION};

const QUESTION: &str = "Summarize my work.";

fn focus_fixture() -> (DateRange, Vec<Evidence>, SourceSet, Extraction) {
    let (range, evidence, sources, mut extraction) = fixture();
    let spans = sources.spans().collect::<Vec<_>>();
    let user =
        crate::local_synthesis::claim_prompt::payload(QUESTION, "en", &range, &spans).unwrap();
    let prepared = PreparedFocusQa::prepare(&user).unwrap();
    let raw = json!({"version":VERSION,"packetSha256":prepared.decoder().packet_sha256(),
        "outcome":"claims","claims":[
            [0,"Synthetic export was requested.","intention",[0],
                ["user","speaker",null],[null,"unknown","unknown","unknown",null],"request","requested",null],
            [1,"Synthetic export draft was reported complete.","asserted_occurrence",[1],
                ["assistant","speaker",null],[null,"unknown","unknown","unknown",null],"report","reported_completed",null]
        ]}).to_string();
    let projection = prepared.expand(&raw).unwrap();
    let origin = AgentVaultSession {
        vault_path: "/synthetic/vault".into(),
        opening_token: "7".into(),
    };
    extraction.claims = sources
        .validate(projection.canonical(), &origin, Scope::Sessions)
        .unwrap();
    extraction.focus_claim_count = extraction.claims.claims.len();
    extraction.focus_projections = vec![projection];
    (range, evidence, sources, extraction)
}

#[test]
fn answer_packet_keeps_full_private_witnesses_and_exact_original_native_fields() {
    let (range, evidence, sources, extraction) = focus_fixture();
    let prepared = prepare_answer(
        QUESTION,
        "en",
        &range,
        &evidence,
        &sources,
        &extraction,
        |_, _| Ok(true),
    )
    .unwrap();
    let proof = prepared.focus_answer.as_ref().unwrap();
    proof
        .verify_prompt(QUESTION, "en", &prepared.prompt.user, &sources)
        .unwrap();
    let packet: Value = serde_json::from_str(&prepared.prompt.user).unwrap();
    assert_eq!(
        packet["sourceFocusInterpretations"],
        json!([
            {"selectedProposalOrdinal":0,"assertionKind":"intention"},
            {"selectedProposalOrdinal":1,"assertionKind":"asserted_occurrence"}
        ])
    );
    assert_eq!(
        packet["sourceFocusInterpretationRevision"],
        proof.revision()
    );
    assert!(packet.get("sourceFocusInterpretationRevisions").is_none());
    assert_eq!(
        packet["claimProposals"],
        json!(extraction
            .claims
            .claims
            .iter()
            .map(|claim| &claim.proposal)
            .collect::<Vec<_>>())
    );
    let originals = json!(sources.spans().collect::<Vec<_>>());
    let model_originals = packet["sources"][0]["originalSpans"].as_array().unwrap();
    for (model, native) in model_originals.iter().zip(originals.as_array().unwrap()) {
        for field in [
            "id",
            "text",
            "speaker",
            "turnId",
            "turnTime",
            "recordTime",
            "sourcePhase",
        ] {
            assert_eq!(model[field], native[field]);
        }
        assert_eq!(model.as_object().unwrap().len(), 7);
        for field in [
            "sourceId",
            "sourceRevision",
            "sourcePath",
            "selectionPath",
            "start",
            "end",
            "sha256",
        ] {
            assert!(model.get(field).is_none());
        }
    }
    assert_eq!(model_originals.len(), originals.as_array().unwrap().len());
    assert!(packet.get("automatedClaimReviewInputRevisions").is_none());
    for (ordinal, witness) in proof.full_witnesses().iter().enumerate() {
        let proposal = &extraction.claims.claims[ordinal].proposal;
        let original = originals
            .as_array()
            .unwrap()
            .iter()
            .find(|span| span["id"] == witness["anchorSpanId"])
            .unwrap();
        let start = witness["start"].as_u64().unwrap() - original["start"].as_u64().unwrap();
        let end = witness["end"].as_u64().unwrap() - original["start"].as_u64().unwrap();
        assert_eq!(
            &original["text"].as_str().unwrap()[start as usize..end as usize],
            proposal.action
        );
        assert_eq!(witness["sourceRevision"], original["sourceRevision"]);
        assert_eq!(witness["selectedProposalOrdinal"], ordinal);
        assert_eq!(
            witness["focusSha256"],
            crate::importers::wikify::source_revision(&proposal.action)
        );
        assert_eq!(
            witness["proposalSha256"],
            crate::importers::wikify::source_revision(&serde_json::to_string(proposal).unwrap())
        );
        for digest in ["proposalSha256", "focusSha256"] {
            assert_eq!(witness[digest].as_str().unwrap().len(), 64);
            assert!(packet["sourceFocusInterpretations"][ordinal]
                .get(digest)
                .is_none());
        }
    }
    assert_eq!(proof.full_witnesses().len(), 2);
    assert_eq!(prepared.selected_originals.len(), 2);
}

#[test]
fn byte_mock_fit_uses_the_compact_packet_without_removing_any_original_or_claim() {
    let (range, evidence, sources, extraction) = focus_fixture();
    let prepared = prepare_answer(
        QUESTION,
        "en",
        &range,
        &evidence,
        &sources,
        &extraction,
        |_, _| Ok(true),
    )
    .unwrap();
    let proof = prepared.focus_answer.as_ref().unwrap();
    let mut legacy: Value = serde_json::from_str(&prepared.prompt.user).unwrap();
    legacy["sources"][0]["originalSpans"] = json!(sources.spans().collect::<Vec<_>>());
    legacy["automatedClaimReviewInputRevisions"] = json!(extraction.review_input_revisions());
    legacy["sourceFocusInterpretations"] = json!(proof.full_witnesses());
    legacy
        .as_object_mut()
        .unwrap()
        .remove("sourceFocusInterpretationRevision");
    legacy["sourceFocusInterpretationRevisions"] =
        json!([extraction.focus_projections[0].revision()]);
    let old_bytes = prepared.prompt.system.len() + legacy.to_string().len();
    let new_bytes = prepared.prompt.system.len() + prepared.prompt.user.len();
    assert!(new_bytes < old_bytes);
    let byte_budget = new_bytes + (old_bytes - new_bytes) / 2;
    assert!(old_bytes > byte_budget);
    let compact = prepare_answer(
        QUESTION,
        "en",
        &range,
        &evidence,
        &sources,
        &extraction,
        |system, user| Ok(system.len() + user.len() <= byte_budget),
    )
    .unwrap();
    assert_eq!(compact.prompt.user, prepared.prompt.user);
    assert_eq!(
        (
            compact.selected_claims,
            compact.omitted_claims,
            compact.original_spans
        ),
        (2, 0, 2)
    );
    assert!(prepare_answer(
        QUESTION,
        "en",
        &range,
        &evidence,
        &sources,
        &extraction,
        |_, user| Ok(!user.contains("draft was reported complete")),
    )
    .err()
    .is_some_and(|error| error.starts_with("review_not_fit:")));
}
