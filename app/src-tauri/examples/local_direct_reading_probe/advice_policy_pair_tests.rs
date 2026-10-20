//! Paired diagnostic contract checks; synthetic review values do not establish model meaning.

use super::*;
use myco_lib::local_synthesis::original_groups_qa::encode;

#[test]
fn fixed_four_cases_alternate_arm_order_without_changing_the_denominator() {
    use KoAdvicePolicyQa::{ExistingControl, IntentConditionalV1};
    assert_eq!(
        CASES.map(|(_, id, _)| id),
        ["FUTURE-A-ALL", "FUTURE-A-D2", "FUTURE-A-D4", "FUTURE-A-D3"]
    );
    assert_eq!(order(0), [ExistingControl, IntentConditionalV1]);
    assert_eq!(order(1), [IntentConditionalV1, ExistingControl]);
    assert_eq!(order(2), order(0));
    assert_eq!(order(3), order(1));
    assert_eq!(
        CASES
            .iter()
            .map(|(_, _, originals)| originals * 2)
            .sum::<usize>(),
        32
    );
}

#[test]
fn prepared_real_writer_pairs_preserve_user_and_only_replace_the_registered_branch() {
    let prepared = direct_reading_qa::development::prepare_all().unwrap();
    let pairs = prepare_pairs(&prepared).unwrap();
    assert_eq!(pairs.len(), 4);
    for pair in pairs {
        verify_pair(&pair.control, &pair.treatment).unwrap();
        assert_eq!(pair.control.user, pair.treatment.user);
        let mut changed = pair.treatment.clone();
        changed.user.push(' ');
        assert!(verify_pair(&pair.control, &changed).is_err());
        let mut extra_system = pair.treatment.clone();
        extra_system.system.push_str(" extra instruction");
        assert!(verify_pair(&pair.control, &extra_system).is_err());
        let mut duplicate = pair.control.clone();
        duplicate
            .system
            .push_str(KoAdvicePolicyQa::ExistingControl.branches());
        assert!(verify_pair(&duplicate, &pair.treatment).is_err());
    }
}

fn synthetic_review(writer: &Wire, raw: &str, prose: &str) -> Value {
    let draft: Value = serde_json::from_str(&writer.user).unwrap();
    let mut originals = Vec::new();
    let sources = draft["sources"].as_array().unwrap();
    for source in sources {
        originals.extend(
            decode(&source["originalSpans"].to_string())
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .cloned(),
        );
    }
    json!({"answerInputRevision":raw,"answer":{"proseWithoutModelLinkLabels":prose,"sourceIds":["S1"]},
        "context":draft["context"],"contextRevision":draft["contextRevision"],
        "citations":sources.iter().map(|source|json!({"id":source["id"],"path":source["path"]})).collect::<Vec<_>>(),
        "originalSpans":encode(&Value::Array(originals)).unwrap(),"recordPeriodContext":{"synthetic":true},
        "independentVerificationReceipts":[]})
}

#[test]
fn review_shared_view_allows_different_actual_answers_but_rejects_source_context_and_raw_changes() {
    let prepared = direct_reading_qa::development::prepare_all().unwrap();
    let pairs = prepare_pairs(&prepared).unwrap();
    let pair = &pairs[0];
    let control = synthetic_review(&pair.control, "control raw SHA", "control answer");
    let treatment = synthetic_review(&pair.treatment, "treatment raw SHA", "different answer");
    let common = review_common(&pair.control, &control.to_string(), "control raw SHA").unwrap();
    assert_eq!(
        common,
        review_common(&pair.treatment, &treatment.to_string(), "treatment raw SHA").unwrap()
    );
    assert_eq!(
        decode(&common["originalSpans"].to_string())
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        9
    );
    assert!(review_common(&pair.control, &control.to_string(), "wrong raw SHA").is_err());
    let mut changed = control.clone();
    changed["contextRevision"] = json!("different context");
    assert!(review_common(&pair.control, &changed.to_string(), "control raw SHA").is_err());
    let mut changed = control.clone();
    changed["citations"][0]["path"] = json!("other.md");
    assert!(review_common(&pair.control, &changed.to_string(), "control raw SHA").is_err());
    let mut changed = control;
    changed["originalSpans"]["documents"][0]["originalSpans"]
        .as_array_mut()
        .unwrap()
        .pop();
    assert!(review_common(&pair.control, &changed.to_string(), "control raw SHA").is_err());
}
