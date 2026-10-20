//! Explicit QA budgets cannot change model selection or unrelated flow modes.

use super::*;

fn options(args: &[&str]) -> Result<ProbeOptions, String> {
    parse_arguments(args.iter().map(|arg| (*arg).to_string()))
}

#[test]
fn explicit_control_and_treatment_admit_only_activity_flow_modes() {
    for budget in ["768", "1536"] {
        for flow in ["--activity-smoke", "--activity-positive-smoke"] {
            let selected = options(&[
                "--model-dir",
                "/synthetic",
                flow,
                "--activity-claim-output-tokens",
                budget,
            ])
            .unwrap();
            assert_eq!(selected.claim_output_tokens, Some(budget.parse().unwrap()));
            assert_eq!(selected.model.manifest.id, CANDIDATE.id);
            assert!(!selected.model.explicit);
        }
        assert!(options(&[
            "--model-dir",
            "/synthetic",
            "--activity-development-smoke",
            "/synthetic/development.manifest.json",
            "--activity-claim-output-tokens",
            budget,
        ])
        .is_ok());
    }
}

#[test]
fn unchanged_default_and_explicit_trial_never_expand_other_stage_budgets() {
    use myco_lib::local_llm::GenerationSchema;
    assert_eq!(
        options(&["--model-dir", "/synthetic"])
            .unwrap()
            .claim_output_tokens,
        None
    );
    for schema in [
        GenerationSchema::AskAnswerV1,
        GenerationSchema::AskAnswerReviewV1,
        GenerationSchema::SessionCompilationV1,
        GenerationSchema::SessionStructureV1,
        GenerationSchema::SessionReviewV1,
    ] {
        assert_eq!(
            activity_smoke::decode_budget((768, 4096), schema, Some(1536)).unwrap(),
            (768, 4096)
        );
    }
    for choice in [None, Some(768), Some(1536)] {
        assert_eq!(
            activity_smoke::decode_budget((768, 4096), GenerationSchema::WikiClaimsV1, choice)
                .unwrap(),
            (choice.unwrap_or(768), 4096)
        );
    }
}

#[test]
fn internal_trial_policy_refuses_unknown_base_or_override_budgets() {
    use myco_lib::local_llm::GenerationSchema;
    for base in [(767, 4096), (1536, 4096), (768, 2048), (768, 8192)] {
        assert!(
            activity_smoke::decode_budget(base, GenerationSchema::WikiClaimsV1, Some(1536))
                .is_err()
        );
    }
    for choice in [
        Some(-1),
        Some(0),
        Some(769),
        Some(1024),
        Some(1537),
        Some(i32::MAX),
    ] {
        assert!(
            activity_smoke::decode_budget((768, 4096), GenerationSchema::WikiClaimsV1, choice)
                .is_err()
        );
    }
}

#[test]
fn malformed_repeated_or_unrelated_budget_flags_fail_before_artifact_loading() {
    for budget in ["", "0", "-1", "769", "1024", "1537", "2048", "all"] {
        assert!(options(&[
            "--model-dir",
            "/synthetic",
            "--activity-smoke",
            "--activity-claim-output-tokens",
            budget,
        ])
        .is_err());
    }
    for tail in [
        vec!["--activity-claim-output-tokens"],
        vec!["--activity-claim-output-tokens", "1536"],
        vec!["--template-only", "--activity-claim-output-tokens", "1536"],
        vec![
            "--ordinary-smoke",
            "--activity-smoke",
            "--activity-claim-output-tokens",
            "1536",
        ],
        vec![
            "--activity-smoke",
            "--activity-contract-experiment",
            "--activity-claim-output-tokens",
            "1536",
        ],
        vec![
            "--activity-smoke",
            "--activity-claim-output-tokens",
            "1536",
            "--activity-claim-output-tokens",
            "768",
        ],
    ] {
        let mut args = vec!["--model-dir", "/synthetic"];
        args.extend(tail);
        assert!(options(&args).is_err(), "{args:?}");
    }
}
