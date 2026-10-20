//! Complete source-input shape and token-fit checks, not generation quality.

use super::*;
use crate::session_compile::{review, sources, SourceBinding};
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::{CompilationOriginal, SourceSet};
use serde_json::{json, Value};

fn fixture(
    body: &str,
) -> (
    sources::PacketPlan,
    SourceSet,
    Vec<NativeClaim>,
    SessionCompilationV1,
) {
    let raw = format!("---\nsource: codex\nconversation_id: source-once-synthetic\ncreated: 2026-10-01\n---\n**User:**\n{body}\n");
    let source = SourceBinding {
        key: "codex:source-once-synthetic".into(),
        raw_path: "raw/conversations/codex/source-once-synthetic.md".into(),
        source_revision: crate::importers::wikify::source_revision(&raw),
    };
    let origin = AgentVaultSession {
        vault_path: "/synthetic/source-once".into(),
        opening_token: "source-once-opening".into(),
    };
    let plan = sources::prepare(&source, &raw, &origin, "en", |_, _| Ok(800)).unwrap();
    assert_eq!(plan.windows.len(), 1);
    let original = CompilationOriginal::verify(&raw, &source.source_revision).unwrap();
    let packet = plan.packet(0, &original, &origin).unwrap();
    let span = packet.spans().next().unwrap().id();
    let proposal = |action: &str, status: &str| {
        json!({
            "action":action,"anchorSpanId":span,"supportSpanIds":[span],
            "actor":{"role":"user","basis":"speaker","subjectSpanId":null},
            "eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},
            "speechAct":"report","status":status,"verificationId":null
        })
    };
    let checked = packet
        .validate(
            &json!({"outcome":"claims","claims":[
                proposal("I folded the synthetic paper lantern", "reported_completed"),
                proposal("I have not hung the synthetic paper lantern", "unknown")
            ]})
            .to_string(),
            &origin,
            crate::retrieval::Scope::All,
        )
        .unwrap();
    let claims: Vec<_> = checked
        .claims
        .into_iter()
        .enumerate()
        .map(|(index, claim)| NativeClaim {
            id: format!("claim-{index}"),
            claim,
        })
        .collect();
    let compilation = validate(
        &json!({"version":"SessionCompilationV1",
            "title":"Synthetic paper lantern","titleClaimIds":["claim-0"],"entities":[],
            "summaries":[{"claimId":"claim-0","text":"The user reports folding the lantern."},
                {"claimId":"claim-1","text":"The user reports that the lantern has not been hung."}]
        })
        .to_string(),
        &claims,
    )
    .unwrap();
    (plan, packet, claims, compilation)
}

fn review_input(
    plan: &sources::PacketPlan,
    packet: &SourceSet,
    claims: &[NativeClaim],
    compilation: &SessionCompilationV1,
) -> (String, String) {
    let mut input = None;
    let error = review::run(
        plan,
        0,
        "synthetic-signature",
        "en",
        packet,
        claims,
        compilation,
        |system, user| {
            input = Some((system.to_owned(), user.to_owned()));
            Ok(800)
        },
        |_, _, _, _, _| Err("synthetic stop after exact input capture".into()),
    )
    .unwrap_err();
    assert_eq!(error, "synthetic stop after exact input capture");
    input.unwrap()
}

fn assert_once(input: &Value, packet: &SourceSet, claims: &[NativeClaim]) {
    assert_eq!(
        input["originalSpans"],
        json!(packet.spans().collect::<Vec<_>>())
    );
    let projected = input["claims"].as_array().unwrap();
    assert_eq!(projected.len(), claims.len());
    for (item, claim) in projected.iter().zip(claims) {
        assert_eq!(
            item,
            &json!({"id":claim.id,"proposal":claim.claim.proposal})
        );
    }
}

#[test]
fn compilation_transmits_each_exact_original_once_and_keeps_native_provenance() {
    let (_, packet, claims, _) =
        fixture("I folded the synthetic paper lantern. I have not hung it.");
    let before = serde_json::to_value(&claims).unwrap();
    let input: Value = serde_json::from_str(&payload("en", &claims).unwrap()).unwrap();
    assert_once(&input, &packet, &claims);
    assert_eq!(serde_json::to_value(&claims).unwrap(), before);
    assert_eq!(claims[0].claim.provenance, claims[1].claim.provenance);
}

#[test]
fn separate_review_transmits_full_packet_once_without_repeated_claim_provenance() {
    let (plan, packet, claims, compilation) =
        fixture("I folded the synthetic paper lantern. I have not hung it.");
    let before = serde_json::to_value(&claims).unwrap();
    let (_, user) = review_input(&plan, &packet, &claims, &compilation);
    let input: Value = serde_json::from_str(&user).unwrap();
    assert_once(&input, &packet, &claims);
    assert_eq!(input["requiredClaimIds"], json!(["claim-0", "claim-1"]));
    assert_eq!(serde_json::to_value(&claims).unwrap(), before);
}

#[test]
fn same_span_id_with_different_native_bytes_cannot_be_deduplicated() {
    let (_, _, mut claims, _) =
        fixture("I folded the synthetic paper lantern. I have not hung it.");
    let original = "Changed synthetic original bytes.";
    let changed = crate::wiki_claims::SourceDocument::bind(
        "changed-source".into(),
        "raw/conversations/codex/source-once-synthetic.md".into(),
        "raw/conversations/codex/source-once-synthetic.md".into(),
        original,
        None,
        vec![crate::wiki_claims::SpanInput {
            id: claims[0].claim.provenance[0].id().into(),
            start: 0,
            end: original.len(),
            turn_id: "T0".into(),
            speaker: crate::wiki_claims::ActorRole::User,
            turn_time: None,
        }],
    )
    .unwrap();
    let changed = SourceSet::new(
        AgentVaultSession {
            vault_path: "/synthetic/source-once".into(),
            opening_token: "source-once-opening".into(),
        },
        crate::retrieval::Scope::All,
        vec![changed],
        vec![],
    )
    .unwrap();
    claims[1].claim.provenance = changed.spans().cloned().collect();
    assert_eq!(
        claims[0].claim.provenance[0].id(),
        claims[1].claim.provenance[0].id()
    );
    let error = payload("en", &claims).unwrap_err();
    assert!(
        error.contains("conflicting original span identity"),
        "{error}"
    );
}

#[test]
fn empty_compilation_proposals_do_not_invent_originals() {
    let input: Value = serde_json::from_str(&payload("en", &[]).unwrap()).unwrap();
    assert_eq!(input["originalSpans"], json!([]));
    assert_eq!(input["claims"], json!([]));
}

#[test]
fn no_claims_review_still_receives_the_entire_contrary_original() {
    let (plan, packet, _, _) = fixture("I folded the synthetic paper lantern. I have not hung it.");
    let compilation = validate(
        &json!({"version":"SessionCompilationV1","title":"",
        "titleClaimIds":[],"entities":[],"summaries":[]})
        .to_string(),
        &[],
    )
    .unwrap();
    let (_, user) = review_input(&plan, &packet, &[], &compilation);
    let input: Value = serde_json::from_str(&user).unwrap();
    assert_once(&input, &packet, &[]);
    assert_eq!(input["requiredClaimIds"], json!([]));
}

#[test]
#[ignore = "requires existing pinned MYCO_SESSION_PACKET_MODEL_ID/MYCO_SESSION_PACKET_MODEL_DIR; tokenization only"]
fn cached_tokenizer_fits_shared_originals_in_compilation_and_review() {
    let id = std::env::var("MYCO_SESSION_PACKET_MODEL_ID").expect("model ID is required");
    let dir =
        std::env::var_os("MYCO_SESSION_PACKET_MODEL_DIR").expect("model directory is required");
    let manifest = crate::local_model::manifest_for(Some(&id)).unwrap();
    let path = crate::local_model::resolve_verified_artifact(std::path::Path::new(&dir), manifest)
        .unwrap();
    let mut host = crate::local_llm::LocalLlm::load_embed_host().unwrap();
    host.ensure_chat_model(&path).unwrap();
    let body = "Synthetic coordination context retains the original wording. ".repeat(120)
        + "I folded the synthetic paper lantern. I have not hung it.";
    let (plan, packet, claims, compilation) = fixture(&body);
    let compile_input = payload("en", &claims).unwrap();
    let (review_system, review_input) = review_input(&plan, &packet, &claims, &compilation);
    let compile_tokens = host.chat_token_count(SYSTEM, &compile_input).unwrap();
    let review_tokens = host
        .chat_token_count(&review_system, &review_input)
        .unwrap();
    println!(
        "{}",
        json!({"phase":"session_shared_original_tokenizer","model":manifest,
        "sourceRevision":plan.source.source_revision,"sourceBytes":body.len(),"claims":claims.len(),
        "compilationPromptTokens":compile_tokens,"reviewPromptTokens":review_tokens,
        "compilationUserSha256":crate::importers::wikify::source_revision(&compile_input),
        "reviewUserSha256":crate::importers::wikify::source_revision(&review_input),
        "modelInference":false,"semanticAccepted":false})
    );
    assert!(
        compile_tokens <= sources::MAX_INPUT_TOKENS,
        "compile tokens: {compile_tokens}"
    );
    assert!(
        review_tokens <= sources::MAX_INPUT_TOKENS,
        "review tokens: {review_tokens}"
    );
}

fn canonical_fixture_view(
    claims: &[NativeClaim],
) -> crate::session_compile::materializer::MaterializedSessionV1 {
    let raw = json!({"version":"SessionStructureV1",
        "title":if claims.is_empty(){""}else{"Synthetic paper lantern"},
        "titleClaimIds":claims.iter().take(1).map(|claim|claim.id.clone()).collect::<Vec<_>>(),
        "entities":[]})
    .to_string();
    let validated = crate::session_compile::structure::validate(&raw, claims).unwrap();
    crate::session_compile::materializer::materialize(validated, claims, "en").unwrap()
}

#[test]
fn canonical_review_keeps_full_original_and_every_native_metadata_group() {
    let (plan, packet, claims, _) =
        fixture("I folded the synthetic paper lantern. I have not hung it.");
    let native_before = serde_json::to_vec(&claims).unwrap();
    let canonical = canonical_fixture_view(&claims);
    let view = canonical.as_view();
    let (_, user) = review_input(&plan, &packet, &claims, view);
    let input: Value = serde_json::from_str(&user).unwrap();
    assert_once(&input, &packet, &claims);
    assert_eq!(input["compilation"], serde_json::to_value(view).unwrap());
    assert_eq!(
        input["compilation"]["version"],
        "CanonicalSessionMaterializationV1"
    );
    assert_eq!(input["requiredClaimIds"], json!(["claim-0", "claim-1"]));
    assert_eq!(
        input["requiredExpressionIds"],
        json!(["title", "summary-0", "summary-1"])
    );
    assert_eq!(input["independentVerificationReceipts"], json!([]));
    assert_eq!(view.summaries.len(), claims.len());
    for (row, claim) in view.summaries.iter().zip(&claims) {
        let proposal = &claim.claim.proposal;
        let anchor = claim
            .claim
            .provenance
            .iter()
            .find(|span| span.id() == proposal.anchor_span_id)
            .unwrap();
        let groups = [
            format!(
                "Action: {}",
                serde_json::to_string(&proposal.action).unwrap()
            ),
            format!("Actor: {}", serde_json::to_string(&proposal.actor).unwrap()),
            format!(
                "Original speaker: {}",
                serde_json::to_string(&anchor.speaker()).unwrap()
            ),
            format!(
                "Speech act: {}",
                serde_json::to_string(&proposal.speech_act).unwrap()
            ),
            format!(
                "Status: {}",
                serde_json::to_string(&proposal.status).unwrap()
            ),
            format!(
                "Event time: {}",
                serde_json::to_string(&proposal.event_time).unwrap()
            ),
            format!(
                "Verification record: {}",
                serde_json::to_string(&proposal.verification_id).unwrap()
            ),
        ];
        assert_eq!(row.claim_id, claim.id);
        assert_eq!(row.text, groups.join(" · "));
    }
    assert_eq!(serde_json::to_vec(&claims).unwrap(), native_before);
}

#[test]
fn canonical_empty_review_keeps_full_contrary_original_without_activity_rows() {
    let (plan, packet, _, _) = fixture("I folded the synthetic paper lantern. I have not hung it.");
    let canonical = canonical_fixture_view(&[]);
    let (_, user) = review_input(&plan, &packet, &[], canonical.as_view());
    let input: Value = serde_json::from_str(&user).unwrap();
    assert_once(&input, &packet, &[]);
    assert_eq!(
        input["compilation"],
        json!({"version":"CanonicalSessionMaterializationV1",
        "title":"","titleClaimIds":[],"entities":[],"summaries":[]})
    );
    assert_eq!(input["requiredClaimIds"], json!([]));
    assert_eq!(input["requiredExpressionIds"], json!([]));
    assert_eq!(input["independentVerificationReceipts"], json!([]));
}

#[test]
fn canonical_review_grant_binds_transparent_view_bytes_and_full_source_identity() {
    let (plan, packet, claims, _) =
        fixture("I folded the synthetic paper lantern. I have not hung it.");
    let canonical = canonical_fixture_view(&claims);
    let wrapper_bytes = serde_json::to_vec(&canonical).unwrap();
    let view_bytes = serde_json::to_vec(canonical.as_view()).unwrap();
    assert_eq!(wrapper_bytes, view_bytes);
    let revision =
        crate::importers::wikify::source_revision(std::str::from_utf8(&view_bytes).unwrap());
    let verdict = review::run(
        &plan,
        0,
        "synthetic-signature",
        "en",
        &packet,
        &claims,
        canonical.as_view(),
        |_, _| Ok(800),
        |_, user, _, _, stage| {
            assert_eq!(
                stage,
                crate::session_compile::compiler::CompilerSchema::Review
            );
            crate::session_compile::compiler::fixture_model(stage, user, false)
        },
    )
    .unwrap();
    assert!(verdict.accepted());
    assert!(verdict.binds(
        &plan.source.source_revision,
        "synthetic-signature",
        &plan.packet_revision(0).unwrap(),
        &revision
    ));
    assert!(!verdict.binds(
        &plan.source.source_revision,
        "changed-signature",
        &plan.packet_revision(0).unwrap(),
        &revision
    ));
    assert!(!verdict.binds(
        &plan.source.source_revision,
        "synthetic-signature",
        &plan.packet_revision(0).unwrap(),
        &"0".repeat(64)
    ));
}
