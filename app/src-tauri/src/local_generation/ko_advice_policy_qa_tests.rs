//! Source-only policy/control tests; synthetic verdicts do not prove advice quality.
use super::super::{original_prompt, Request, ORIGINAL_POLICY};
use super::*;
use crate::local_synthesis::{answer_draft, answer_review, Evidence};
use crate::retrieval::Scope;
use crate::vault_session::AgentVaultSession;
use serde_json::json;

#[test]
fn control_is_exact_noop_and_treatment_changes_only_the_single_frozen_branch() {
    for language in ["ko", "en"] {
        let mut system = "Unrelated or future instructions remain unchanged.".to_string();
        let before = system.clone();
        KoAdvicePolicyQa::ExistingControl
            .apply(language, &mut system)
            .unwrap();
        assert_eq!(system, before);
    }
    let original = format!("{CONTROL_POLICY}{ORIGINAL_POLICY}");
    let mut treatment = original.clone();
    KoAdvicePolicyQa::IntentConditionalV1
        .apply("ko", &mut treatment)
        .unwrap();
    assert_ne!(treatment, original);
    assert_eq!(treatment, original.replacen(OLD_BRANCHES, NEW_BRANCHES, 1));
    assert_eq!(treatment.replace(NEW_BRANCHES, OLD_BRANCHES), original);
    assert!(treatment.ends_with(ORIGINAL_POLICY));
    assert_eq!(KoAdvicePolicyQa::ExistingControl.branches(), OLD_BRANCHES);
    assert_eq!(
        KoAdvicePolicyQa::IntentConditionalV1.branches(),
        NEW_BRANCHES
    );
    for policy in [
        KoAdvicePolicyQa::ExistingControl,
        KoAdvicePolicyQa::IntentConditionalV1,
    ] {
        assert_eq!(serde_json::to_value(policy).unwrap(), policy.as_str());
    }
}

#[test]
fn treatment_refuses_changed_language_prefix_or_multiple_branches_without_mutation() {
    for (language, mut system) in [
        ("en", CONTROL_POLICY.to_string()),
        ("ko", format!("Changed prefix {CONTROL_POLICY}")),
        (
            "ko",
            CONTROL_POLICY.replacen(OLD_BRANCHES, "Changed policy branches.", 1),
        ),
        ("ko", format!("{CONTROL_POLICY}{OLD_BRANCHES}")),
    ] {
        let before = system.clone();
        let failure = KoAdvicePolicyQa::IntentConditionalV1
            .apply(language, &mut system)
            .unwrap_err();
        assert_eq!(failure.code, "review_invalid");
        assert_eq!(system, before);
    }
}

#[test]
fn actual_writer_policy_is_bound_before_draft_and_mandatory_review_cannot_replay_other_arm() {
    let (packet, _, _) = crate::wiki_claim_review::tests::fixture();
    let origin = AgentVaultSession {
        vault_path: "/synthetic/review-vault".into(),
        opening_token: "synthetic-opening".into(),
    };
    let range = crate::commands::DateRange {
        start: "2026-10-01".into(),
        end: "2026-10-04".into(),
        start_epoch: None,
        end_epoch: None,
    };
    let question = crate::local_generation::direct_reading_qa::QUESTIONS[1];
    let context =
        crate::wiki_claim_review::tests::context(question, "ko", Scope::Sessions, &range, &origin);
    let evidence = vec![Evidence {
        page: "sessions/review.md".into(),
        stem: "Synthetic".into(),
        section: 0,
        text: packet.spans().map(|span| span.text()).collect(),
        title: None,
        compiled: None,
    }];
    let request = Request {
        model_id: None,
        request_id: "synthetic-policy-binding".into(),
        question: question.into(),
        previous_question: None,
        lang: "ko".into(),
        hits: evidence.clone(),
        expected_vault: origin.vault_path.clone(),
        origin: Some(origin.clone()),
        role_snapshot: None,
        scope: Scope::Sessions,
        range: Some(range),
        paths: None,
        max_tokens: Some(768),
        activity_overview: true,
        resolution: None,
    };
    let control = original_prompt(&request, &evidence, &packet, &context).unwrap();
    let mut treatment = original_prompt(&request, &evidence, &packet, &context).unwrap();
    KoAdvicePolicyQa::IntentConditionalV1
        .apply("ko", &mut treatment.system)
        .unwrap();
    assert_eq!(control.user, treatment.user);
    let raw = json!({"answer":"기록된 목적이 지금도 유효하다면 작은 확인부터 시작할 수 있습니다.","sources":["S1"]}).to_string();
    let control_draft = answer_draft::validate_answer_draft(&raw, &control, "ko").unwrap();
    let treatment_draft = answer_draft::validate_answer_draft(&raw, &treatment, "ko").unwrap();
    assert_eq!(
        control_draft.input_revision(),
        treatment_draft.input_revision()
    );
    assert_ne!(
        control_draft.prompt_revision(),
        treatment_draft.prompt_revision()
    );
    assert!(!control_draft.binds_prompt(&treatment, "ko"));
    assert!(!treatment_draft.binds_prompt(&control, "ko"));
    let error = answer_review::run(
        &context,
        &packet,
        &treatment,
        &control_draft,
        |_, _| panic!("replayed draft must fail before tokenization"),
        |_, _, _, _| panic!("replayed draft must fail before mandatory review generation"),
    )
    .unwrap_err();
    assert_eq!(error.code(), "review_invalid");
    let receipt = answer_review::run(
        &context,
        &packet,
        &treatment,
        &treatment_draft,
        |_, _| Ok(500),
        |_, _, _, _| {
            Ok(
                json!({"version":"AskAnswerReviewV1","answerDisposition":"supported",
            "taskResponse":"adequate","sourceCoverage":"covered","missingSpanIds":[],
            "reason":"Synthetic binding control only, not semantic proof."})
                .to_string(),
            )
        },
    )
    .unwrap();
    assert!(receipt.binds(&context, &packet, &treatment, &treatment_draft));
    assert!(!receipt.binds(&context, &packet, &control, &control_draft));
    // The production entry still refuses the activity request; this synthetic
    // private-context test cannot substitute for a live opening or role grant.
    let refused = super::super::run(
        &request,
        &evidence,
        &packet,
        &origin,
        |_, _| panic!("ordinary activity request must not tokenize"),
        |_, _, _, _, _| panic!("ordinary activity request must not generate"),
    )
    .unwrap_err();
    assert_eq!(refused.code, "source_verification_failed");
}
