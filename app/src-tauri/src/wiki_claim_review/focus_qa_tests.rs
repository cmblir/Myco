//! Mocked verdicts verify QA prompt/receipt custody, never actual model meaning.

use super::*;
use crate::commands::DateRange;
use crate::local_synthesis::claim_prompt;
use crate::retrieval::Scope;
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::focus_claims_qa::PreparedFocusQa;
use crate::wiki_claims::{ActorRole, SourceDocument, SpanInput};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};

fn period() -> DateRange {
    DateRange {
        start: "2026-10-01".into(),
        end: "2026-10-04".into(),
        start_epoch: None,
        end_epoch: None,
    }
}

fn packet(body: &str) -> SourceSet {
    let original = format!("선행\n{body}");
    let document = SourceDocument::bind(
        "synthetic-source".into(),
        "sessions/focus-review.md".into(),
        "sessions/focus-review.md".into(),
        &original,
        Some("2026-10-03".into()),
        vec![SpanInput {
            id: "Q0".into(),
            start: "선행\n".len(),
            end: original.len(),
            turn_id: "T0".into(),
            speaker: ActorRole::User,
            turn_time: None,
        }],
    )
    .unwrap();
    SourceSet::new(origin(), Scope::Sessions, vec![document], vec![]).unwrap()
}

fn origin() -> AgentVaultSession {
    AgentVaultSession {
        vault_path: "/synthetic/focus-review-vault".into(),
        opening_token: "synthetic-focus-opening".into(),
    }
}

fn context(question: &str, language: &str, range: &DateRange) -> AskReviewContext {
    super::super::tests::context(question, language, Scope::Sessions, range, &origin())
}

fn projection(
    sources: &SourceSet,
    context: &AskReviewContext,
    focus: &str,
    kind: &str,
) -> FocusProjectionQa {
    let user = claim_prompt::payload(
        context.payload()["question"].as_str().unwrap(),
        context.payload()["language"].as_str().unwrap(),
        &period(),
        &sources.spans().collect::<Vec<_>>(),
    )
    .unwrap();
    let prepared = PreparedFocusQa::prepare(&user).unwrap();
    let raw = json!({
        "version":"WikiSourceFocusClaimsQaV1",
        "packetSha256":prepared.decoder().packet_sha256(),
        "outcome":"claims",
        "claims":[[0,focus,kind,[0],["user","speaker",null],
            [null,"unknown","unknown","unknown",null],"report","unknown",null]],
    });
    prepared.expand(&raw.to_string()).unwrap()
}

fn fixture() -> (
    SourceSet,
    CheckedClaims,
    AskReviewContext,
    FocusProjectionQa,
) {
    let sources = packet("I did not deploy. This message contains no rollout record.");
    let context = context("Summarize synthetic deployment work", "en", &period());
    let projection = projection(
        &sources,
        &context,
        "I did not deploy.",
        "explicit_nonoccurrence",
    );
    let claims = sources
        .validate(projection.canonical(), &origin(), Scope::Sessions)
        .unwrap();
    (sources, claims, context, projection)
}

fn accepting(user: &str) -> String {
    super::super::tests::accepting_review(user)
}

#[test]
fn actual_sidecar_prompt_is_measured_generated_and_bound_as_a_distinct_receipt() {
    let (packet, claims, context, projection) = fixture();
    let measured = RefCell::new(None::<(String, String)>);
    let generated = RefCell::new(None::<(String, String)>);
    let receipt = run(
        &context,
        &packet,
        &claims,
        &projection,
        |system, user| {
            *measured.borrow_mut() = Some((system.into(), user.into()));
            Ok(1000)
        },
        |system, user, output, context_tokens, decisions| {
            assert_eq!((output, context_tokens, decisions.count()), (768, 4096, 1));
            assert!(system.contains("source-focus") || system.contains("Source-focus"));
            assert!(system.contains("same-model review remains correlated"));
            let payload: Value = serde_json::from_str(user).unwrap();
            assert_eq!(payload["interpretationRevision"], projection.revision());
            assert_eq!(
                payload["sourceFocusInterpretations"],
                projection
                    .model_review_value(&packet, &claims, context.payload())
                    .unwrap()
            );
            assert_eq!(
                payload["sourceFocusInterpretations"]["claims"],
                json!([
                    {"id":"C0","assertionKind":"explicit_nonoccurrence"}
                ])
            );
            assert!(system.contains("requiredClaimIds and claims[].id"));
            assert!(payload["sourceFocusInterpretations"]
                .get("witnesses")
                .is_none());
            assert!(payload["sourceFocusInterpretations"]
                .get("interpretationRevision")
                .is_none());
            assert_eq!(user.matches(projection.revision()).count(), 1);
            assert_eq!(
                payload["originalSpans"][0]["text"],
                packet.spans().next().unwrap().text()
            );
            assert_eq!(
                payload["claims"][0]["proposal"]["action"],
                "I did not deploy."
            );
            *generated.borrow_mut() = Some((system.into(), user.into()));
            Ok(accepting(user))
        },
    )
    .unwrap();
    let actual = generated.into_inner().unwrap();
    assert_eq!(measured.into_inner().unwrap(), actual);
    assert_eq!(receipt.input_revision(), source_revision(&actual.1));
    assert_eq!(receipt.system_revision, source_revision(&actual.0));
    assert_ne!(receipt.input_revision(), receipt.base_input_revision);
    assert!(receipt.require_accepted().is_ok());
    assert!(receipt.binds(&context, &packet, &claims, &projection));
    let encoded = serde_json::to_value(&receipt).unwrap();
    assert_eq!(encoded["version"], VERSION);
    assert_eq!(encoded["sameModelReviewIsIndependent"], false);
    assert_eq!(encoded["nativeIoAuthenticated"], false);
    assert_eq!(encoded["semanticReleaseAccepted"], false);
    assert_eq!(encoded["productionAccepted"], false);
    assert!(encoded.get("baseReview").is_none());
}

#[test]
fn ordered_kind_mapping_reduces_only_model_sidecar_and_fits_a_byte_counted_boundary() {
    let (packet, _, context, _) = fixture();
    let original = claim_prompt::payload(
        context.payload()["question"].as_str().unwrap(),
        context.payload()["language"].as_str().unwrap(),
        &period(),
        &packet.spans().collect::<Vec<_>>(),
    )
    .unwrap();
    let prepared_projection = PreparedFocusQa::prepare(&original).unwrap();
    let projection = prepared_projection
        .expand(&json!({
            "version":"WikiSourceFocusClaimsQaV1",
            "packetSha256":prepared_projection.decoder().packet_sha256(),
            "outcome":"claims",
            "claims":[
                [0,"I did not deploy.","explicit_nonoccurrence",[0],["user","speaker",null],
                    [null,"unknown","unknown","unknown",null],"report","unknown",null],
                [0,"This message contains no rollout record.","record_or_verification_limit",[0],
                    ["user","speaker",null],[null,"unknown","unknown","unknown",null],
                    "report","unknown",null]
            ]
        }).to_string())
        .unwrap();
    let claims = packet
        .validate(projection.canonical(), &origin(), Scope::Sessions)
        .unwrap();
    let prepared = PreparedInput::new(&context, &packet, &claims, &projection).unwrap();
    let actual: Value = serde_json::from_str(&prepared.user).unwrap();
    let base: Value = serde_json::from_str(&prepared.base_user).unwrap();
    assert_eq!(
        actual["sourceFocusInterpretations"]["claims"],
        json!([
            {"id":"C0","assertionKind":"explicit_nonoccurrence"},
            {"id":"C1","assertionKind":"record_or_verification_limit"}
        ])
    );
    for (entry, id) in actual["sourceFocusInterpretations"]["claims"]
        .as_array()
        .unwrap()
        .iter()
        .zip(actual["requiredClaimIds"].as_array().unwrap())
    {
        assert_eq!(&entry["id"], id);
        assert_eq!(entry.as_object().unwrap().len(), 2);
    }
    let mut stripped = actual.clone();
    stripped
        .as_object_mut()
        .unwrap()
        .remove("sourceFocusInterpretations");
    stripped
        .as_object_mut()
        .unwrap()
        .remove("interpretationRevision");
    assert_eq!(stripped, base);
    assert_eq!(actual["claims"], base["claims"]);
    assert_eq!(actual["originalSpans"], base["originalSpans"]);
    assert_eq!(
        actual["originalSpans"][0]["sourceRevision"],
        base["originalSpans"][0]["sourceRevision"]
    );
    let full_proof = projection
        .review_value(&packet, &claims, context.payload())
        .unwrap();
    assert_eq!(full_proof["witnesses"].as_array().unwrap().len(), 2);
    for (field, expected) in [
        ("untrustedModelJudgments", true),
        ("semanticReviewRequired", true),
        ("semanticAccepted", false),
        ("nativeIoAuthenticated", false),
        ("productionAccepted", false),
    ] {
        assert_eq!(actual["sourceFocusInterpretations"][field], expected);
    }
    assert_eq!(
        actual["sourceFocusInterpretations"]["version"],
        "WikiSourceFocusClaimsQaV1"
    );
    for field in [
        "witnesses",
        "packetSha256",
        "revision",
        "interpretationRevision",
    ] {
        assert!(actual["sourceFocusInterpretations"].get(field).is_none());
    }
    assert_eq!(prepared.user.matches(projection.revision()).count(), 1);
    let mut with_full_proof = actual.clone();
    with_full_proof["sourceFocusInterpretations"] = full_proof;
    let full_user = with_full_proof.to_string();
    let actual_bytes = prepared.system.len() + prepared.user.len();
    let full_bytes = prepared.system.len() + full_user.len();
    assert!(full_bytes > actual_bytes);
    const BUDGET: usize = 4096 - 768 - 8;
    // A deterministic byte-proportional mock, calibrated at this input's exact
    // budget. This proves custody/fit boundaries, not real tokenizer savings.
    let byte_tokens =
        |system: &str, user: &str| ((system.len() + user.len()) * BUDGET).div_ceil(actual_bytes);
    assert_eq!(byte_tokens(&prepared.system, &prepared.user), BUDGET);
    assert!(byte_tokens(&prepared.system, &full_user) > BUDGET);
    let calls = Cell::new((0, 0));
    let receipt = run(
        &context,
        &packet,
        &claims,
        &projection,
        |system, user| {
            assert_eq!(
                (system, user),
                (prepared.system.as_str(), prepared.user.as_str())
            );
            calls.set((calls.get().0 + 1, calls.get().1));
            Ok(byte_tokens(system, user))
        },
        |system, user, _, _, decisions| {
            assert_eq!(
                (system, user),
                (prepared.system.as_str(), prepared.user.as_str())
            );
            assert_eq!(decisions.count(), 2);
            calls.set((calls.get().0, calls.get().1 + 1));
            Ok(accepting(user))
        },
    )
    .unwrap();
    assert_eq!(calls.get(), (1, 1));
    assert!(receipt.require_accepted().is_ok());
    assert!(receipt.binds(&context, &packet, &claims, &projection));
    assert_eq!(receipt.interpretation_revision, projection.revision());
    assert_eq!(receipt.input_revision(), source_revision(&prepared.user));
    assert_eq!(receipt.system_revision, source_revision(&prepared.system));
    assert_eq!(
        receipt.base_input_revision,
        source_revision(&prepared.base_user)
    );
}

#[test]
fn changed_kind_cannot_replay_a_receipt_even_when_plain_claims_are_identical() {
    let (packet, claims, context, original) = fixture();
    let receipt = run(
        &context,
        &packet,
        &claims,
        &original,
        |_, _| Ok(1000),
        |_, user, _, _, _| Ok(accepting(user)),
    )
    .unwrap();
    // This different kind remains an unreviewed proposal, not a correct meaning.
    let changed = projection(
        &packet,
        &context,
        "I did not deploy.",
        "record_or_verification_limit",
    );
    assert_eq!(changed.canonical(), original.canonical());
    assert_ne!(changed.revision(), original.revision());
    assert!(receipt.base_review.binds(&context, &packet, &claims));
    assert!(!receipt.binds(&context, &packet, &claims, &changed));
}

#[test]
fn wrong_claims_originals_and_question_context_fail_before_tokenizer_or_generation() {
    let (packet, claims, context, projection) = fixture();
    let mut changed_claims = claims.clone();
    changed_claims.claims[0].proposal.action = "A different synthetic proposal".into();
    let changed_packet = self::packet("I did not deploy. A changed synthetic original tail.");
    let changed_question = self::context("A different synthetic question", "en", &period());
    let changed_language = self::context("Summarize synthetic deployment work", "ko", &period());
    let mut range = period();
    range.end = "2026-10-03".into();
    let changed_period = self::context("Summarize synthetic deployment work", "en", &range);
    for (current_context, current_packet, current_claims) in [
        (&context, &packet, &changed_claims),
        (&context, &changed_packet, &claims),
        (&changed_question, &packet, &claims),
        (&changed_language, &packet, &claims),
        (&changed_period, &packet, &claims),
    ] {
        let tokens = Cell::new(0);
        let generations = Cell::new(0);
        let failure = run(
            current_context,
            current_packet,
            current_claims,
            &projection,
            |_, _| {
                tokens.set(tokens.get() + 1);
                Ok(1000)
            },
            |_, user, _, _, _| {
                generations.set(generations.get() + 1);
                Ok(accepting(user))
            },
        )
        .unwrap_err();
        assert_eq!(failure.code(), "review_invalid");
        assert_eq!((tokens.get(), generations.get()), (0, 0));
    }
}

#[test]
fn unsupported_uncertain_and_missing_verdicts_keep_existing_fail_closed_codes() {
    let (packet, claims, context, projection) = fixture();
    for (disposition, coverage, missing, code) in [
        ("unsupported", "covered", vec![], "review_rejected"),
        ("uncertain", "covered", vec![], "review_uncertain"),
        ("supported", "missing", vec!["Q0"], "review_missing"),
        ("supported", "uncertain", vec![], "review_uncertain"),
    ] {
        let receipt = run(&context, &packet, &claims, &projection, |_, _| Ok(1000),
            |_, _, _, _, _| Ok(json!({"version":"WikiClaimReviewV1",
                "claims":[{"id":"C0","disposition":disposition,"reason":"Synthetic QA plumbing verdict."}],
                "missingSpanIds":missing,"sourceCoverage":coverage}).to_string())).unwrap();
        assert!(receipt.binds(&context, &packet, &claims, &projection));
        assert_eq!(receipt.require_accepted().unwrap_err().code(), code);
    }
}

#[test]
fn malformed_or_foreign_model_verdicts_do_not_issue_qa_receipts() {
    let (packet, claims, context, projection) = fixture();
    for change in 0..4 {
        let failure = run(
            &context,
            &packet,
            &claims,
            &projection,
            |_, _| Ok(1000),
            |_, user, _, _, _| {
                let mut output: Value = serde_json::from_str(&accepting(user)).unwrap();
                match change {
                    0 => output["claims"] = json!([]),
                    1 => output["claims"][0]["id"] = json!("C99"),
                    2 => output["interpretationRevision"] = json!(projection.revision()),
                    _ => output["claims"][0]["reason"] = json!(""),
                }
                Ok(output.to_string())
            },
        )
        .unwrap_err();
        assert_eq!(failure.code(), "review_invalid");
    }
}

#[test]
fn augmented_input_budget_failure_does_not_fall_back_to_the_smaller_base_prompt() {
    let (packet, claims, context, projection) = fixture();
    let token_calls = Cell::new(0);
    let generations = Cell::new(0);
    let failure = run(
        &context,
        &packet,
        &claims,
        &projection,
        |_, user| {
            token_calls.set(token_calls.get() + 1);
            let input: Value = serde_json::from_str(user).unwrap();
            assert!(input.get("sourceFocusInterpretations").is_some());
            Ok(4096 - 768 - 8 + 1)
        },
        |_, user, _, _, _| {
            generations.set(generations.get() + 1);
            Ok(accepting(user))
        },
    )
    .unwrap_err();
    assert_eq!(failure.code(), "review_not_fit");
    assert_eq!((token_calls.get(), generations.get()), (1, 0));
}

#[test]
fn cancellation_and_generation_failures_remain_visible_without_a_receipt() {
    let (packet, claims, context, projection) = fixture();
    for (reason, code) in [
        ("local generation cancelled", "review_stopped"),
        ("synthetic generation unavailable", "review_unavailable"),
    ] {
        let failure = run(
            &context,
            &packet,
            &claims,
            &projection,
            |_, _| Ok(1000),
            |_, _, _, _, _| Err(reason.into()),
        )
        .unwrap_err();
        assert_eq!(failure.code(), code);
        assert!(failure.to_string().contains(reason));
    }
}

#[test]
fn actual_user_and_system_hashes_are_required_when_rebinding_the_qa_receipt() {
    let (packet, claims, context, projection) = fixture();
    let receipt = run(
        &context,
        &packet,
        &claims,
        &projection,
        |_, _| Ok(1000),
        |_, user, _, _, _| Ok(accepting(user)),
    )
    .unwrap();
    for mutation in 0..3 {
        let mut changed = receipt.clone();
        match mutation {
            0 => changed.input_revision = "0".repeat(64),
            1 => changed.system_revision = "0".repeat(64),
            _ => changed.base_input_revision = "0".repeat(64),
        }
        assert!(!changed.binds(&context, &packet, &claims, &projection));
    }
    let changed_context = self::context("Different synthetic request", "en", &period());
    assert!(!receipt.binds(&changed_context, &packet, &claims, &projection));
}

#[test]
fn ordinary_review_still_receives_only_the_unaugmented_default_prompt() {
    let (packet, claims, context, projection) = fixture();
    let expected = PreparedInput::new(&context, &packet, &claims, &projection).unwrap();
    let ordinary = super::super::run(
        &context,
        &packet,
        &claims,
        |system, user| {
            assert_eq!(system, expected.base_system);
            assert_eq!(user, expected.base_user);
            Ok(1000)
        },
        |system, user, _, _, _| {
            assert_eq!(system, expected.base_system);
            assert_eq!(user, expected.base_user);
            let input: Value = serde_json::from_str(user).unwrap();
            assert!(input.get("sourceFocusInterpretations").is_none());
            assert!(input.get("interpretationRevision").is_none());
            Ok(accepting(user))
        },
    )
    .unwrap();
    assert_eq!(
        ordinary.input_revision(),
        source_revision(&expected.base_user)
    );
}

#[test]
fn named_projection_requires_same_context_encoding_before_model_calls() {
    use crate::wiki_claims::focus_claims_qa::Encoding;
    let (sources, _, ordinary, _) = fixture();
    let raw_user = claim_prompt::payload(
        ordinary.payload()["question"].as_str().unwrap(),
        "en",
        &period(),
        &sources.spans().collect::<Vec<_>>(),
    )
    .unwrap();
    let prepared = PreparedFocusQa::prepare_for(&raw_user, Encoding::NamedV1).unwrap();
    let raw = json!({"version":"WikiSourceFocusClaimsNamedQaV1","packetSha256":prepared.decoder().packet_sha256(),"outcome":"claims","claims":[{
        "anchorOrdinal":0,"focusQuote":"I did not deploy.","assertionKind":"explicit_nonoccurrence","supportOrdinals":[0],
        "actor":{"role":"user","basis":"speaker","subjectOrdinal":null},
        "eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","timeSupportOrdinal":null},
        "speechAct":"report","status":"unknown","verificationId":null}]}).to_string();
    let projection = prepared.expand(&raw).unwrap();
    let claims = sources
        .validate(projection.canonical(), &origin(), Scope::Sessions)
        .unwrap();
    let error = run(
        &ordinary,
        &sources,
        &claims,
        &projection,
        |_, _| panic!("encoding mismatch must not tokenize"),
        |_, _, _, _, _| panic!("encoding mismatch must not generate"),
    )
    .err()
    .unwrap();
    assert_eq!(error.code(), "review_invalid");
    let named = ordinary
        .with_source_focus_qa_encoding(Encoding::NamedV1)
        .unwrap();
    let reviewed = run(
        &named,
        &sources,
        &claims,
        &projection,
        |_, _| Ok(1000),
        |_, user, _, _, _| Ok(accepting(user)),
    )
    .unwrap();
    assert!(reviewed.binds(&named, &sources, &claims, &projection));
}
