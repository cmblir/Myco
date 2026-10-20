//! Synthetic compiler-to-publisher parity. Mocked generation does not certify
//! source entailment, independent verification or actual-model acceptance.

use super::*;
use serde_json::{json, Value};

#[test]
fn reviewed_rows_publish_once_with_exact_claims_and_reversible_action() {
    with_isolated_data("materialized-publication-parity", |_| {
        const ACTION: &str = "request the synthetic report: \"<tag>& [link] *bold* _under_ `tick` \\ path\" \u{0085}\u{2028}\u{2029}🙂";
        let raw = format!("---\nsource: codex\nconversation_id: synthetic-publication\n---\n# Synthetic session\n\n**User:**\nPlease {ACTION}.\n");
        let (dir, vault, origin, source) = fixture_with_original(&raw);
        let context =
            session_compile::begin(&vault, &origin, source.clone(), RoleUsage::Foreground).unwrap();
        let plan = sources::prepare(&source, &raw, &origin, "en", |_, _| Ok(800)).unwrap();
        assert_eq!(plan.windows.len(), 2);
        assert_eq!(plan.windows[0].turn_id, "T-preamble");
        let original = CompilationOriginal::verify(&raw, &source.source_revision).unwrap();
        let mut run = compiler::CompilerRun::new(&context.attempt_id, &context.compile_signature);
        let mut progress = run.initial_progress(&plan);
        let mut reviewed = Vec::new();
        for index in 0..plan.windows.len() {
            let receipt = run
                .step(
                    &plan,
                    &original,
                    &origin,
                    "en",
                    &mut progress,
                    |_, _| Ok(800),
                    |_, user, _, _, stage| {
                        let output = compiler::fixture_model(stage, user, false)?;
                        if stage == compiler::CompilerSchema::Claims {
                            let mut claims: Value = serde_json::from_str(&output).unwrap();
                            let entries = claims["claims"].as_array().unwrap();
                            if index == 0 {
                                assert!(entries.is_empty());
                            } else {
                                assert_eq!(entries.len(), 1);
                                assert!(entries[0]["action"].as_str().unwrap().contains(ACTION));
                                claims["claims"][0]["action"] = json!(ACTION);
                            }
                            Ok(claims.to_string())
                        } else {
                            if stage == compiler::CompilerSchema::Review {
                                let input: Value = serde_json::from_str(user).unwrap();
                                reviewed.push(input["compilation"].clone());
                            }
                            Ok(output)
                        }
                    },
                )
                .unwrap();
            assert_eq!(receipt.packet_index, index);
            assert_eq!(receipt.all_packets_seen, index + 1 == plan.windows.len());
            if index + 1 < plan.windows.len() {
                assert!(run.completed(&plan, &progress).unwrap().is_none());
            }
        }
        let native = run.completed(&plan, &progress).unwrap().unwrap();
        let native_value = serde_json::to_value(&native).unwrap();
        assert_eq!(native_value["releaseGroundTruth"], false);
        assert_eq!(native_value["independentVerificationReceipts"], 0);
        assert_eq!(native.packets().len(), plan.windows.len());
        assert_eq!(reviewed.len(), plan.windows.len());
        for (packet, review) in native.packets().iter().zip(&reviewed) {
            assert_eq!(review, &serde_json::to_value(&packet.compilation).unwrap());
        }
        assert!(native.packets()[0].claims.is_empty());
        let packet = &native.packets()[1];
        assert_eq!(packet.claims.len(), 1);
        let view = packet.compilation.as_view();
        let wrapper_bytes = serde_json::to_vec(&packet.compilation).unwrap();
        let view_bytes = serde_json::to_vec(view).unwrap();
        assert_eq!(wrapper_bytes, view_bytes);
        assert_eq!(
            source_revision(std::str::from_utf8(&wrapper_bytes).unwrap()),
            source_revision(std::str::from_utf8(&view_bytes).unwrap())
        );
        assert_eq!(view.version, "CanonicalSessionMaterializationV1");
        assert_eq!(view.summaries.len(), 1);
        let row = &view.summaries[0];
        let claim = &packet.claims[0];
        assert_eq!(row.claim_id, claim.id);
        assert_eq!(claim.claim.proposal.action.as_bytes(), ACTION.as_bytes());
        let literal = row
            .text
            .split(" · ")
            .next()
            .unwrap()
            .strip_prefix("Action: ")
            .unwrap();
        assert_eq!(serde_json::from_str::<String>(literal).unwrap(), ACTION);
        assert!(!row.text.contains(['\u{0085}', '\u{2028}', '\u{2029}']));
        let body = generated_body(&native, &source.raw_path).unwrap();
        let expected_line = format!("- {} [^mx-{}]", markdown(&row.text), claim.id);
        assert_eq!(
            body.lines().filter(|line| *line == expected_line).count(),
            1
        );
        assert!(body.contains(&format!("[^mx-{}]: {}\n", claim.id, source.raw_path)));
        let metadata_line = body
            .lines()
            .find(|line| line.contains("myco:claim-metadata"))
            .unwrap();
        let metadata: Value = serde_json::from_str(
            metadata_line
                .trim()
                .strip_prefix("<!-- myco:claim-metadata ")
                .unwrap()
                .strip_suffix(" -->")
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            metadata["actor"],
            serde_json::to_value(&claim.claim.proposal.actor).unwrap()
        );
        assert_eq!(
            metadata["eventTime"],
            serde_json::to_value(&claim.claim.proposal.event_time).unwrap()
        );
        assert_eq!(
            metadata["speechAct"],
            serde_json::to_value(claim.claim.proposal.speech_act).unwrap()
        );
        assert_eq!(
            metadata["status"],
            serde_json::to_value(claim.claim.proposal.status).unwrap()
        );
        assert_eq!(metadata["independentVerification"], false);
        let proof = with_attempt(&vault, &context, |root, pending, grant| {
            publish_compiled(root, pending, grant, &native, None)
        })
        .unwrap();
        assert!(proof.publication_error().is_none());
        let persisted = std::fs::read_to_string(dir.path().join(&context.summary_path)).unwrap();
        assert!(persisted.contains(&body));
        let result = with_attempt(&vault, &context, |root, pending, grant| {
            finish_compiled(root, pending, grant, &native, &proof)
        })
        .unwrap();
        assert_eq!(result["ok"], true);
        assert_eq!(
            std::fs::read(dir.path().join(&source.raw_path)).unwrap(),
            raw.as_bytes()
        );
        // An explicitly supplied QA destination lets the root verify the real
        // renderer against these exact native-published synthetic bytes.
        if let Ok(output) = std::env::var("MYCO_MATERIALIZED_PUBLICATION_ARTIFACT") {
            std::fs::write(
                output,
                serde_json::to_vec_pretty(&json!({
                    "reviewedRows":[{"text":row.text,"claimId":claim.id,"action":ACTION}],
                    "generatedBody":body,
                    "persistedMarkdown":persisted,
                    "sourceRevision":source.source_revision,
                    "independentVerification":false,
                    "releaseGroundTruth":false
                }))
                .unwrap(),
            )
            .unwrap();
        }
    });
}
