use super::*;

fn cases() -> Vec<Case> {
    let artifact = serde_json::from_str(include_str!(
        "../../eval/local-wiki-development-review-packets-v1.json"
    ))
    .unwrap();
    let corpus = serde_json::from_str(include_str!(
        "../../eval/local-wiki-development-meaning-v1.json"
    ))
    .unwrap();
    crate::review_packets::build_cases(&artifact, &corpus).unwrap()
}

fn mock_reference_observation(case: &Case) -> Value {
    // Matcher regression only: these labels are never model verdicts or grants.
    let expected = case.expected_review.as_ref().unwrap();
    json!({"automatedReviewAccepted":case.expected_verdict=="accept",
        "acceptanceFailure":{"code":"review_rejected"},"review":{"proposal":expected}})
}

#[test]
fn whole_packet_reference_gate_requires_fields_even_when_overall_verdict_rejects() {
    for case in cases()
        .iter()
        .filter(|case| case.expected_verdict == "reject")
    {
        let baseline = mock_reference_observation(case);
        assert_eq!(review_matches(case, &Ok(baseline.clone())), Some(true));
        let mut wrong_decision = baseline.clone();
        let current = wrong_decision["review"]["proposal"]["claims"][0]["disposition"]
            .as_str()
            .unwrap();
        wrong_decision["review"]["proposal"]["claims"][0]["disposition"] =
            json!(if current == "supported" {
                "unsupported"
            } else {
                "supported"
            });
        assert_eq!(verdict(&Ok(wrong_decision.clone())), "reject");
        assert_eq!(review_matches(case, &Ok(wrong_decision)), Some(false));
        let mut wrong_coverage = baseline;
        let coverage = wrong_coverage["review"]["proposal"]["sourceCoverage"]
            .as_str()
            .unwrap();
        wrong_coverage["review"]["proposal"]["sourceCoverage"] = json!(if coverage == "covered" {
            "missing"
        } else {
            "covered"
        });
        assert_eq!(verdict(&Ok(wrong_coverage.clone())), "reject");
        assert_eq!(review_matches(case, &Ok(wrong_coverage)), Some(false));
    }
}

#[test]
fn whole_packet_reference_gate_requires_missing_originals_but_allows_set_order() {
    let cases = cases();
    let case = cases
        .iter()
        .find(|case| case.id == "whole-review-D3AB-duplicate-only-comparison")
        .unwrap();
    let mut value = mock_reference_observation(case);
    value["review"]["proposal"]["missingSpanIds"] = json!(["D3B", "D3A"]);
    assert_eq!(review_matches(case, &Ok(value.clone())), Some(true));
    for missing in [json!([]), json!(["D3A"]), json!(["D3A", "unselected"])] {
        value["review"]["proposal"]["missingSpanIds"] = missing;
        assert_eq!(review_matches(case, &Ok(value.clone())), Some(false));
    }
}

#[test]
fn technical_errors_never_become_semantic_rejection_successes() {
    for code in [
        "review_rejected",
        "review_missing",
        "review_invalid",
        "review_unavailable",
    ] {
        assert_eq!(
            verdict(&Err(
                json!({"code":code,"detail":"Synthetic technical error."})
            )),
            "technical_failure"
        );
    }
    let mut value =
        json!({"automatedReviewAccepted":false,"acceptanceFailure":{"code":"review_uncertain"}});
    assert_eq!(verdict(&Ok(value.clone())), "uncertain");
    value["acceptanceFailure"]["code"] = json!("review_missing");
    assert_eq!(verdict(&Ok(value)), "reject");
}
