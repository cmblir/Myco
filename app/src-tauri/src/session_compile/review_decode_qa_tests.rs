//! Synthetic binding/decoder controls, not actual-model meaning evidence.

use super::*;
use crate::session_compile::{compiler, review, schema, sources, SourceBinding};
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::CompilationOriginal;
use serde_json::{json, Value};

pub(crate) fn fixture_contract(count: usize, entity_count: usize) -> SessionReviewDecodeQa {
    let raw = "---\nsource: codex\nconversation_id: synthetic-review-qa\ncreated: 2026-10-01\n---\n**User:**\nPlease request the synthetic report.\n";
    let origin = AgentVaultSession {
        vault_path: "/synthetic/review-qa".into(),
        opening_token: "synthetic-review-opening".into(),
    };
    let binding = SourceBinding {
        key: "codex:synthetic-review-qa".into(),
        raw_path: "raw/conversations/codex/synthetic-review-qa.md".into(),
        source_revision: source_revision(raw),
    };
    let plan = sources::prepare(&binding, raw, &origin, "en", |_, _| Ok(800)).unwrap();
    let original = CompilationOriginal::verify(raw, &binding.source_revision).unwrap();
    let packet = plan.packet(0, &original, &origin).unwrap();
    let span = packet.spans().next().unwrap().id();
    let extraction = json!({"outcome":if count==0{"insufficient_evidence"}else{"claims"},
        "claims":(0..count).map(|_| json!({
            "action":"request the synthetic report","anchorSpanId":span,"supportSpanIds":[span],
            "actor":{"role":"user","basis":"speaker","subjectSpanId":null},
            "eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},
            "speechAct":"request","status":"requested","verificationId":null
        })).collect::<Vec<_>>()}).to_string();
    let claims = compiler::bind_claims(&packet, &extraction, &origin, 0).unwrap();
    let compilation = json!({"version":"SessionCompilationV1", "title":if count==0{""}else{"Synthetic request"},
        "titleClaimIds":claims.first().map(|claim|vec![claim.id.clone()]).unwrap_or_default(),
        "entities":(0..entity_count).map(|index|json!({"kind":"topic","name":format!("Synthetic topic {index}"),
            "claimIds":[claims[0].id]})).collect::<Vec<_>>(),
        "summaries":claims.iter().map(|claim|json!({"claimId":claim.id,"text":"The user asks for a report request."})).collect::<Vec<_>>()
    }).to_string();
    SessionReviewDecodeQa::issue(&plan, 0, &original, &origin, &extraction, &compilation).unwrap()
}

pub(crate) fn output(
    contract: &SessionReviewDecodeQa,
    disposition: &str,
    coverage: &str,
    missing: bool,
    reason: &str,
) -> String {
    let input: Value = serde_json::from_str(contract.user()).unwrap();
    let decisions = |group: &str| {
        format!(
            "[{}]",
            input[group]
                .as_array()
                .unwrap()
                .iter()
                .map(|id| {
                    format!(
                        r#"{{"id":{},"disposition":{},"reason":{}}}"#,
                        id,
                        serde_json::to_string(disposition).unwrap(),
                        serde_json::to_string(reason).unwrap()
                    )
                })
                .collect::<Vec<_>>()
                .join(",")
        )
    };
    // Preserve the native grammar's field order for vocabulary controls.
    format!(
        r#"{{"version":"SessionReviewV1","claims":{},"expressions":{},"missingSpanIds":{},"sourceCoverage":{}}}"#,
        decisions("requiredClaimIds"),
        decisions("requiredExpressionIds"),
        if missing {
            json!([input["originalSpans"][0]["id"]]).to_string()
        } else {
            "[]".into()
        },
        serde_json::to_string(coverage).unwrap()
    )
}

#[test]
fn session_review_qa_binds_exact_native_payload_and_immutable_grammar() {
    for (claims, expressions) in [(0, 0), (1, 3), (1, 5), (16, 25)] {
        let entities = if claims == 0 {
            0
        } else {
            expressions - claims - 1
        };
        let contract = fixture_contract(claims, entities);
        let input: Value = serde_json::from_str(contract.user()).unwrap();
        assert_eq!(input["requiredClaimIds"].as_array().unwrap().len(), claims);
        assert_eq!(
            input["requiredExpressionIds"].as_array().unwrap().len(),
            expressions
        );
        assert_eq!(contract.system(), review::SYSTEM);
        assert!(contract.matches_input(contract.system(), contract.user()));
        assert!(!contract.matches_input(&format!("{} ", contract.system()), contract.user()));
        assert!(!contract.matches_input(contract.system(), &format!("{} ", contract.user())));
        assert_eq!(
            contract.grammar_sha256(),
            source_revision(contract.grammar())
        );
    }
}

#[test]
fn session_review_qa_rejects_unsafe_unbounded_or_overlapping_literal_ids() {
    let valid = vec!["C-0-0-synthetic".into()];
    let spans = vec!["Q-synthetic".into()];
    for invalid in [
        "",
        "quote\"",
        "slash\\",
        "line\n",
        "space id",
        "한글",
        &"a".repeat(65),
    ] {
        assert!(grammar(&[invalid.into()], &["title".into()], &spans).is_err());
    }
    let too_many_claims = (0..17)
        .map(|index| format!("C-{index}"))
        .collect::<Vec<_>>();
    let too_many_expressions = (0..26)
        .map(|index| format!("E-{index}"))
        .collect::<Vec<_>>();
    assert!(grammar(&too_many_claims, &[], &spans).is_err());
    assert!(grammar(&valid, &too_many_expressions, &spans).is_err());
    assert!(grammar(&valid, &valid, &spans).is_err());
    assert!(grammar(&valid, &[], &[]).is_err());
    assert!(grammar(&valid, &[], &["Q0".into(), "Q1".into()]).is_err());
    assert!(grammar(&["a".repeat(64)], &["title".into()], &spans).is_ok());
}

#[test]
fn session_review_qa_issuer_revalidates_extraction_and_compilation() {
    let contract = fixture_contract(1, 1);
    let input: Value = serde_json::from_str(contract.user()).unwrap();
    let raw = "---\nsource: codex\nconversation_id: synthetic-review-qa\ncreated: 2026-10-01\n---\n**User:**\nPlease request the synthetic report.\n";
    let origin = AgentVaultSession {
        vault_path: "/synthetic/review-qa".into(),
        opening_token: "synthetic-review-opening".into(),
    };
    let binding = SourceBinding {
        key: "codex:synthetic-review-qa".into(),
        raw_path: "raw/conversations/codex/synthetic-review-qa.md".into(),
        source_revision: source_revision(raw),
    };
    let plan = sources::prepare(&binding, raw, &origin, "en", |_, _| Ok(800)).unwrap();
    let original = CompilationOriginal::verify(raw, &binding.source_revision).unwrap();
    let extraction =
        json!({"outcome":"claims","claims":[input["claims"][0]["proposal"]]}).to_string();
    let compilation = input["compilation"].to_string();
    let rebuilt =
        SessionReviewDecodeQa::issue(&plan, 0, &original, &origin, &extraction, &compilation)
            .unwrap();
    assert_eq!(rebuilt.user(), contract.user());
    let mut bad: Value = serde_json::from_str(&extraction).unwrap();
    bad["claims"][0]["supportSpanIds"] = json!(["Q-foreign"]);
    assert!(SessionReviewDecodeQa::issue(
        &plan,
        0,
        &original,
        &origin,
        &bad.to_string(),
        &compilation
    )
    .is_err());
    let mut bad = input["compilation"].clone();
    bad["summaries"][0]["claimId"] = json!("C-foreign");
    assert!(SessionReviewDecodeQa::issue(
        &plan,
        0,
        &original,
        &origin,
        &extraction,
        &bad.to_string()
    )
    .is_err());
    assert!(
        SessionReviewDecodeQa::issue(&plan, 1, &original, &origin, &extraction, &compilation)
            .is_err()
    );
    assert!(CompilationOriginal::verify(
        &raw.replace("report", "revised report"),
        &binding.source_revision
    )
    .is_err());
    assert!(schema::validate(&compilation, &[]).is_err());
}
