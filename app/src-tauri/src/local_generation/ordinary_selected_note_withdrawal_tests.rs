//! Contrast factual support and missing explanation without changing production.
use super::*;

const WITHDRAWAL_CONTROLS: &str =
    include_str!("../../../docs/research/2026-11-11-selected-note-withdrawal-controls.json");
const DIMENSION_GUIDANCE: &str = " Judge answerDisposition only on the factual claims actually made. A source's explicit later correction supersedes its earlier statement for current-state questions; a current negation supported by that correction is not unsupported merely because the answer omits the history. Evaluate omitted relevant explanation separately in taskResponse and sourceCoverage. Conversely, a claim of withdrawal needs explicit source evidence; do not infer a correction merely from these instructions. Read the original wording and distinguish negation from the opposite positive claim.";

#[test]
fn withdrawal_contrasts_reach_review_with_their_original_revision() {
    let controls: Value = serde_json::from_str(WITHDRAWAL_CONTROLS).unwrap();
    for case in controls["cases"].as_array().unwrap() {
        let tail = case["appendToCenter"].as_str();
        let (request, evidence, sources) = selected_note_fixture_with_tail(tail);
        let mut reviews = 0;
        let _ = run(
            &request,
            &evidence,
            &sources,
            request.origin.as_ref().unwrap(),
            |_, _| Ok(100),
            |_, user, _, _, schema| match schema {
                GenerationSchema::AskAnswerV1 => {
                    Ok(json!({"answer":case["answer"],"sources":["S1"]}).to_string())
                }
                GenerationSchema::AskAnswerReviewV1 => {
                    reviews += 1;
                    let payload: Value = serde_json::from_str(user).unwrap();
                    assert_eq!(payload["originalSpans"][0]["text"], evidence[0].text);
                    assert_eq!(evidence[0].text.contains("## Correction"), tail.is_some());
                    Err("deliberate stop after verifying complete review input".into())
                }
                _ => panic!("unexpected schema"),
            },
        );
        assert_eq!(reviews, 1, "control did not reach review: {}", case["id"]);
    }
}

#[test]
#[ignore = "requires cached 4B weights and MYCO_QA_GENERATION=1; twelve actual reviewer calls"]
fn cached_model_compares_withdrawal_dimensions() {
    run_comparison(
        WITHDRAWAL_CONTROLS,
        "separate-dimensions",
        |candidate, system, user| {
            let (mut system, user) = grouped_coverage_input(true, system, user)?;
            if candidate {
                system.push_str(DIMENSION_GUIDANCE);
            }
            Ok((system, user))
        },
    );
}
