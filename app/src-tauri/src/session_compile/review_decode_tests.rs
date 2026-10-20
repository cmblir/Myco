//! Synthetic native binding controls, not source-meaning or model acceptance.

use super::*;
use crate::session_compile::{
    compiler, materializer, review, schema, sources, structure, SourceBinding,
};
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::CompilationOriginal;
use serde_json::{json, Value};

struct Fixture {
    plan: sources::PacketPlan,
    packet: SourceSet,
    claims: Vec<NativeClaim>,
    compilation: MaterializedSessionV1,
}

fn fixture(count: usize, entity_count: usize, action: &str) -> Fixture {
    let raw = "---\nsource: codex\nconversation_id: synthetic-review-decode\ncreated: 2026-10-01\n---\n**User:**\nPlease request the synthetic report.\n";
    fixture_for_source(raw, count, entity_count, action, "en")
}

fn fixture_for_source(
    raw: &str,
    count: usize,
    entity_count: usize,
    action: &str,
    lang: &str,
) -> Fixture {
    let origin = AgentVaultSession {
        vault_path: "/synthetic/review-decode".into(),
        opening_token: "synthetic-review-decode-opening".into(),
    };
    let binding = SourceBinding {
        key: "codex:synthetic-review-decode".into(),
        raw_path: "raw/conversations/codex/synthetic-review-decode.md".into(),
        source_revision: source_revision(raw),
    };
    let plan = sources::prepare(&binding, raw, &origin, lang, |_, _| Ok(800)).unwrap();
    assert_eq!(plan.windows.len(), 1);
    let original = CompilationOriginal::verify(raw, &binding.source_revision).unwrap();
    let packet = plan.packet(0, &original, &origin).unwrap();
    let span = packet.spans().next().unwrap().id();
    let extraction = json!({"outcome":if count==0{"insufficient_evidence"}else{"claims"},
        "claims":(0..count).map(|_| json!({
            "action":action,"anchorSpanId":span,"supportSpanIds":[span],
            "actor":{"role":"user","basis":"speaker","subjectSpanId":null},
            "eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},
            "speechAct":"request","status":"requested","verificationId":null
        })).collect::<Vec<_>>()}).to_string();
    let claims = compiler::bind_claims(&packet, &extraction, &origin, 0).unwrap();
    let proposal = json!({"version":"SessionStructureV1",
        "title":if count==0{""}else{"Synthetic request"},
        "titleClaimIds":claims.first().map(|claim|vec![claim.id.clone()]).unwrap_or_default(),
        "entities":(0..entity_count).map(|index|json!({
            "kind":"topic","name":format!("Synthetic topic {index}"),"claimIds":[claims[0].id]
        })).collect::<Vec<_>>()});
    let structure = structure::validate(&proposal.to_string(), &claims).unwrap();
    let compilation = materializer::materialize(structure, &claims, lang).unwrap();
    Fixture {
        plan,
        packet,
        claims,
        compilation,
    }
}

pub(crate) fn fixture_contract(count: usize, entity_count: usize) -> SessionReviewDecode {
    let fixture = fixture(count, entity_count, "request the synthetic report");
    SessionReviewDecode::issue(
        &fixture.plan,
        "en",
        &fixture.packet,
        &fixture.claims,
        &fixture.compilation,
    )
    .unwrap()
}

pub(crate) fn output(
    contract: &SessionReviewDecode,
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
    // The decoder tests consume this fixed grammar field order.
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
fn issuer_binds_exact_native_payload_and_private_canonical_view() {
    for (count, entities, expressions) in [(0, 0, 0), (1, 1, 3), (16, 8, 25)] {
        let fixture = fixture(count, entities, "request the synthetic report");
        let contract = SessionReviewDecode::issue(
            &fixture.plan,
            "en",
            &fixture.packet,
            &fixture.claims,
            &fixture.compilation,
        )
        .unwrap();
        assert_eq!(contract.system(), review::SYSTEM);
        assert_eq!(
            contract.user(),
            review::payload(
                &fixture.plan,
                "en",
                &fixture.packet,
                &fixture.claims,
                fixture.compilation.as_view(),
            )
            .unwrap()
        );
        let input: Value = serde_json::from_str(contract.user()).unwrap();
        assert_eq!(input["compilation"], json!(fixture.compilation));
        assert_eq!(
            input["compilation"]["version"],
            "CanonicalSessionMaterializationV1"
        );
        assert_eq!(
            input["originalSpans"],
            json!(fixture.packet.spans().collect::<Vec<_>>())
        );
        assert_eq!(
            input["claims"],
            json!(schema::claim_inputs(&fixture.claims))
        );
        assert_eq!(input["requiredClaimIds"].as_array().unwrap().len(), count);
        assert_eq!(
            input["requiredExpressionIds"].as_array().unwrap().len(),
            expressions
        );
        assert_eq!(
            contract.grammar_sha256(),
            source_revision(contract.grammar())
        );
        assert!(contract.matches_input(contract.system(), contract.user()));
    }
}

#[test]
fn canonical_rows_over_legacy_summary_limit_are_not_reinterpreted() {
    let action = "x".repeat(512);
    let fixture = fixture(1, 0, &action);
    let contract = SessionReviewDecode::issue(
        &fixture.plan,
        "en",
        &fixture.packet,
        &fixture.claims,
        &fixture.compilation,
    )
    .unwrap();
    assert!(
        fixture.compilation.as_view().summaries[0]
            .text
            .chars()
            .count()
            > 512
    );
    let input: Value = serde_json::from_str(contract.user()).unwrap();
    assert_eq!(input["claims"][0]["proposal"]["action"], action);
    assert_eq!(input["compilation"], json!(fixture.compilation));
    assert!(schema::validate(&input["compilation"].to_string(), &fixture.claims).is_err());
}

#[test]
fn input_binding_rejects_whitespace_language_claim_and_view_changes() {
    let fixture = fixture(1, 1, "request the synthetic report");
    let contract = SessionReviewDecode::issue(
        &fixture.plan,
        "en",
        &fixture.packet,
        &fixture.claims,
        &fixture.compilation,
    )
    .unwrap();
    assert!(!contract.matches_input(&format!("{} ", contract.system()), contract.user()));
    assert!(!contract.matches_input(contract.system(), &format!("{} ", contract.user())));
    let mut input: Value = serde_json::from_str(contract.user()).unwrap();
    input["language"] = json!("ko");
    assert!(!contract.matches_input(contract.system(), &input.to_string()));
    input = serde_json::from_str(contract.user()).unwrap();
    input["claims"][0]["proposal"]["action"] = json!("produce the synthetic report");
    assert!(!contract.matches_input(contract.system(), &input.to_string()));
    input = serde_json::from_str(contract.user()).unwrap();
    input["compilation"]["summaries"][0]["text"] = json!("Changed app row");
    assert!(!contract.matches_input(contract.system(), &input.to_string()));
    let raw = "---\nsource: codex\nconversation_id: synthetic-review-decode\ncreated: 2026-10-01\n---\n**User:**\nPlease request the synthetic report.\n";
    let translated_fixture = fixture_for_source(raw, 1, 1, "request the synthetic report", "ko");
    let translated = SessionReviewDecode::issue(
        &translated_fixture.plan,
        "ko",
        &translated_fixture.packet,
        &translated_fixture.claims,
        &translated_fixture.compilation,
    )
    .unwrap();
    assert_eq!(translated.grammar_sha256(), contract.grammar_sha256());
    assert!(!contract.matches_input(translated.system(), translated.user()));
    assert!(translated.matches_input(translated.system(), translated.user()));
}

#[test]
fn issuer_rejects_other_valid_materializations_and_changed_claim_order() {
    let original = fixture(2, 1, "request the synthetic report");
    let different = fixture(2, 1, "send the synthetic report");
    let empty = fixture(0, 0, "request the synthetic report");
    for compilation in [&different.compilation, &empty.compilation] {
        assert!(SessionReviewDecode::issue(
            &original.plan,
            "en",
            &original.packet,
            &original.claims,
            compilation,
        )
        .is_err());
    }
    let mut reversed = original.claims.clone();
    reversed.reverse();
    assert!(SessionReviewDecode::issue(
        &original.plan,
        "en",
        &original.packet,
        &reversed,
        &original.compilation,
    )
    .is_err());
    let mut foreign = original.claims.clone();
    foreign[0].id = "C-valid-but-foreign".into();
    assert!(SessionReviewDecode::issue(
        &original.plan,
        "en",
        &original.packet,
        &foreign,
        &original.compilation,
    )
    .is_err());
}

#[test]
fn issuer_rejects_mismatched_plan_language_packet_and_native_provenance() {
    let original = fixture(1, 1, "request the synthetic report");
    assert!(SessionReviewDecode::issue(
        &original.plan,
        "ko",
        &original.packet,
        &original.claims,
        &original.compilation,
    )
    .is_err());
    let raw = "---\nsource: codex\nconversation_id: synthetic-review-decode\ncreated: 2026-10-01\n---\n**User:**\nPlease send the synthetic report.\n";
    let different = fixture_for_source(raw, 1, 1, "send the synthetic report", "en");
    assert!(SessionReviewDecode::issue(
        &original.plan,
        "en",
        &different.packet,
        &different.claims,
        &different.compilation,
    )
    .is_err());
    assert!(SessionReviewDecode::issue(
        &original.plan,
        "en",
        &original.packet,
        &different.claims,
        &different.compilation,
    )
    .is_err());
    let mut wrong_path = original.plan.clone();
    wrong_path.source.raw_path = "raw/conversations/codex/other-synthetic.md".into();
    assert!(SessionReviewDecode::issue(
        &wrong_path,
        "en",
        &original.packet,
        &original.claims,
        &original.compilation,
    )
    .is_err());
    let mut wrong_window = original.plan.clone();
    wrong_window.windows[0].id = "Q-valid-but-foreign".into();
    assert!(SessionReviewDecode::issue(
        &wrong_window,
        "en",
        &original.packet,
        &original.claims,
        &original.compilation,
    )
    .is_err());
    // Empty proposals still require their exact native packet; absence of
    // claim provenance cannot weaken the plan/packet identity check.
    let empty = fixture(0, 0, "request the synthetic report");
    let different_empty = fixture_for_source(raw, 0, 0, "send the synthetic report", "en");
    assert!(SessionReviewDecode::issue(
        &empty.plan,
        "en",
        &different_empty.packet,
        &different_empty.claims,
        &different_empty.compilation,
    )
    .is_err());
}

#[test]
fn grammar_groups_use_only_exact_ordered_native_ids() {
    let contract = fixture_contract(16, 8);
    let input: Value = serde_json::from_str(contract.user()).unwrap();
    let lines = contract.grammar().lines().collect::<Vec<_>>();
    assert_eq!(
        lines
            .iter()
            .filter(|line| line.starts_with("claims-"))
            .count(),
        16
    );
    assert_eq!(
        lines
            .iter()
            .filter(|line| line.starts_with("expressions-"))
            .count(),
        25
    );
    for (group, input_group) in [
        ("claims", "requiredClaimIds"),
        ("expressions", "requiredExpressionIds"),
    ] {
        for (index, id) in input[input_group].as_array().unwrap().iter().enumerate() {
            let terminal = serde_json::to_string(&id.to_string()).unwrap();
            let rule = lines
                .iter()
                .find(|line| line.starts_with(&format!("{group}-{index} ::=")))
                .unwrap();
            assert!(rule.contains(&terminal));
        }
    }
    let span = input["originalSpans"][0]["id"].as_str().unwrap();
    assert_eq!(contract.grammar().matches(span).count(), 1);
    assert!(lines.iter().any(|line| line.starts_with("span-id ::=")));
    assert!(!contract.grammar().contains("Q-foreign"));
    assert!(!contract.grammar().contains("request the synthetic report"));
    let empty = fixture_contract(0, 0);
    assert!(empty.grammar().contains("claims ::= \"[\" ws  \"]\""));
    assert!(empty.grammar().contains("expressions ::= \"[\" ws  \"]\""));
    assert!(!empty.grammar().contains("claims-0"));
    assert!(!empty.grammar().contains("expressions-0"));
}

#[test]
fn grammar_retains_rejection_uncertainty_and_original_coverage() {
    let contract = fixture_contract(1, 1);
    for disposition in ["supported", "unsupported", "uncertain"] {
        assert!(contract.grammar().contains(disposition));
    }
    for coverage in ["covered", "missing", "uncertain"] {
        assert!(contract.grammar().contains(coverage));
    }
    assert!(contract.grammar().contains("tail ::= empty"));
    assert!(contract.grammar().contains("| missing"));
    let rejected: Value = serde_json::from_str(&output(
        &contract,
        "unsupported",
        "missing",
        true,
        "Synthetic rejection, not meaning gold.",
    ))
    .unwrap();
    assert_eq!(rejected["claims"][0]["disposition"], "unsupported");
    assert_eq!(rejected["expressions"][0]["disposition"], "unsupported");
    assert_eq!(rejected["missingSpanIds"].as_array().unwrap().len(), 1);
    assert_eq!(rejected["sourceCoverage"], "missing");
}

#[test]
fn legacy_qa_grammar_keeps_its_complete_frozen_bytes() {
    let expected = r#"root ::= "{\"version\":\"SessionReviewV1\",\"claims\":" ws claims ",\"expressions\":" ws expressions ",\"missingSpanIds\":" ws tail "}" ws
tail ::= empty ",\"sourceCoverage\":" ws "\"covered\"" | missing ",\"sourceCoverage\":" ws other-coverage
empty ::= "[" ws "]"
missing ::= "[" ws (span-id)? "]"
other-coverage ::= "\"missing\"" | "\"uncertain\""
disposition ::= "\"supported\"" | "\"unsupported\"" | "\"uncertain\""
reason ::= "\"" char{1,128} "\""
char ::= [^"\\\x00-\x1F] | "\\" (["\\/bfnrt] | "u" [0-9a-fA-F]{4})
ws ::= [ \t\n\r]{0,8}
span-id ::= "\"Q-synthetic\""
claims ::= "[" ws claims-0 "]"
claims-0 ::= "{\"id\":" ws "\"C-synthetic\"" ",\"disposition\":" ws disposition ",\"reason\":" ws reason "}"
expressions ::= "[" ws expressions-0 "]"
expressions-0 ::= "{\"id\":" ws "\"title\"" ",\"disposition\":" ws disposition ",\"reason\":" ws reason "}"
"#;
    let ids = (
        ["C-synthetic".into()],
        ["title".into()],
        ["Q-synthetic".into()],
    );
    assert_eq!(grammar(&ids.0, &ids.1, &ids.2).unwrap(), expected);
    let native = native_grammar(&ids.0, &ids.1, &ids.2).unwrap();
    assert_eq!(
        native.replace(NATIVE_REASON_RULES, LEGACY_REASON_RULES),
        expected
    );
    assert_ne!(source_revision(&native), source_revision(expected));
}

fn review_reason_literal(
    fixture: &Fixture,
    reason_literal: &str,
    disposition: &str,
    coverage: &str,
) -> Result<review::NativeReview, review::ReviewFailure> {
    review::run_typed(
        &fixture.plan,
        0,
        "synthetic-reason-signature",
        "en",
        &fixture.packet,
        &fixture.claims,
        &fixture.compilation,
        |_, _| Ok(800),
        |_, _, _, _, schema, decode| {
            assert_eq!(schema, compiler::CompilerSchema::Review);
            // A mock can bypass decoding; native returned-output checks must
            // still reject controls rather than classify them as unavailable.
            Ok(output(
                decode.unwrap(),
                disposition,
                coverage,
                false,
                "SYNTHETIC_REASON_LITERAL",
            )
            .replace("\"SYNTHETIC_REASON_LITERAL\"", reason_literal))
        },
    )
}

#[test]
fn native_guard_rejects_controls_and_invalid_surrogates_after_json_decoding() {
    let fixture = fixture(1, 0, "request the synthetic report");
    for code in (0..=0x1f).chain(0x7f..=0x9f) {
        for literal in [
            format!("\"Synthetic {}\"", char::from_u32(code).unwrap()),
            format!(r#""Synthetic \u{code:04x}""#),
            format!(r#""Synthetic \u{code:04X}""#),
        ] {
            assert!(matches!(
                review_reason_literal(&fixture, &literal, "supported", "covered"),
                Err(review::ReviewFailure::InvalidOutput(_))
            ));
        }
    }
    for literal in [
        r#""Synthetic \b""#,
        r#""Synthetic \f""#,
        r#""Synthetic \n""#,
        r#""Synthetic \r""#,
        r#""Synthetic \t""#,
        r#""Synthetic \uD800""#,
        r#""Synthetic \uDC00""#,
        r#""Synthetic \uDC00\uD800""#,
        r#""Synthetic \uD800\uD800""#,
        r#""Synthetic \uD800\u0041""#,
        r#""Synthetic \u123""#,
        r#""Synthetic \uGGGG""#,
    ] {
        assert!(matches!(
            review_reason_literal(&fixture, literal, "supported", "covered"),
            Err(review::ReviewFailure::InvalidOutput(_))
        ));
    }
}

#[test]
fn native_guard_counts_decoded_scalars_and_keeps_noncontrol_json_escapes() {
    let fixture = fixture(1, 0, "request the synthetic report");
    for unit in ["A", "한", "🦀", r"\u0041", r"\uD83E\uDD80"] {
        for count in [128, 129] {
            let literal = format!("\"{}\"", unit.repeat(count));
            let decoded: String = serde_json::from_str(&literal).unwrap();
            assert_eq!(decoded.chars().count(), count);
            let result = review_reason_literal(&fixture, &literal, "supported", "covered");
            if count == 128 {
                assert!(result.unwrap().accepted());
            } else {
                assert!(matches!(
                    result,
                    Err(review::ReviewFailure::InvalidOutput(_))
                ));
            }
        }
    }
    for literal in [
        r#""Synthetic \" \\ \/ \u0022 \u005C \u002F""#,
        r#""Synthetic \u007e \u00a0 \uD7ff \uE000""#,
        r#""Synthetic \uD800\uDC00 \uDBFF\uDFFF""#,
        "\"Synthetic 한글 日本語 🦀\u{2028}\u{2029}\"",
    ] {
        assert!(
            review_reason_literal(&fixture, literal, "supported", "covered")
                .unwrap()
                .accepted()
        );
    }
}

#[test]
fn native_guard_keeps_whitespace_and_valid_rejection_checks_separate() {
    let fixture = fixture(1, 0, "request the synthetic report");
    for literal in [r#""""#, r#"" ""#, r#""\u00A0""#, r#""\u2028\u2029""#] {
        assert!(matches!(
            review_reason_literal(&fixture, literal, "supported", "covered"),
            Err(review::ReviewFailure::InvalidOutput(_))
        ));
    }
    for (disposition, coverage) in [
        ("unsupported", "covered"),
        ("uncertain", "covered"),
        ("supported", "uncertain"),
    ] {
        assert!(!review_reason_literal(
            &fixture,
            r#""Synthetic rejection.""#,
            disposition,
            coverage
        )
        .unwrap()
        .accepted());
    }
}

#[test]
fn shared_grammar_rejects_unsafe_unbounded_duplicate_and_cross_group_ids() {
    for builder in [grammar, native_grammar] {
        let claims = vec!["C-synthetic".into()];
        let expressions = vec!["title".into()];
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
            let invalid = vec![invalid.to_string()];
            assert!(builder(&invalid, &expressions, &spans).is_err());
            assert!(builder(&claims, &invalid, &spans).is_err());
            assert!(builder(&claims, &expressions, &invalid).is_err());
        }
        for duplicate in [claims.clone(), expressions.clone(), spans.clone()] {
            assert!(builder(&duplicate, &duplicate, &spans).is_err());
        }
        assert!(builder(
            &[claims[0].clone(), claims[0].clone()],
            &expressions,
            &spans
        )
        .is_err());
        assert!(builder(
            &claims,
            &[expressions[0].clone(), expressions[0].clone()],
            &spans
        )
        .is_err());
        assert!(builder(&claims, &expressions, &claims).is_err());
        assert!(builder(&claims, &expressions, &expressions).is_err());
        assert!(builder(&claims, &expressions, &[]).is_err());
        assert!(builder(&claims, &expressions, &["Q0".into(), "Q1".into()]).is_err());
        let too_many_claims = (0..17)
            .map(|index| format!("C-{index}"))
            .collect::<Vec<_>>();
        let too_many_expressions = (0..26)
            .map(|index| format!("E-{index}"))
            .collect::<Vec<_>>();
        assert!(builder(&too_many_claims, &expressions, &spans).is_err());
        assert!(builder(&claims, &too_many_expressions, &spans).is_err());
        assert!(builder(&["a".repeat(64)], &expressions, &spans).is_ok());
        assert!(builder(&too_many_claims[..16], &too_many_expressions[..25], &spans).is_ok());
        assert!(builder(&[], &[], &spans).is_ok());
    }
}

#[test]
fn issuer_rejects_invalid_native_id_groups_before_payload_generation() {
    let fixture = fixture(1, 1, "request the synthetic report");
    let mut claims = fixture.claims.clone();
    claims.push(claims[0].clone());
    assert!(SessionReviewDecode::issue(
        &fixture.plan,
        "en",
        &fixture.packet,
        &claims,
        &fixture.compilation,
    )
    .is_err());
    claims = fixture.claims.clone();
    claims[0].id = fixture.packet.spans().next().unwrap().id().into();
    assert!(SessionReviewDecode::issue(
        &fixture.plan,
        "en",
        &fixture.packet,
        &claims,
        &fixture.compilation,
    )
    .is_err());
    claims[0].id = "unsafe native id".into();
    assert!(SessionReviewDecode::issue(
        &fixture.plan,
        "en",
        &fixture.packet,
        &claims,
        &fixture.compilation,
    )
    .is_err());
}

#[test]
fn debug_output_contains_hashes_without_source_or_canonical_body() {
    let contract = fixture_contract(1, 1);
    let debug = format!("{contract:?}");
    assert!(debug.contains(&contract.grammar_sha256()));
    assert!(!debug.contains("Please request"));
    assert!(!debug.contains("request the synthetic report"));
    assert!(!debug.contains("/synthetic/"));
    assert!(!debug.contains("Actor:"));
}
