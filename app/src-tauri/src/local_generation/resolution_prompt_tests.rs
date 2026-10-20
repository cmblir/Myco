use super::*;
use serde_json::Value;

#[test]
fn multiple_task_keys_for_one_anchor_do_not_duplicate_original_context_or_counts() {
    let (originals, claims, _) = crate::wiki_claim_review::tests::fixture();
    let (mut keys, _) = crate::activity_recall::resolution_task_keys(&claims).unwrap();
    assert!(!keys.is_empty());
    keys.push(keys[0].clone());
    let range = crate::commands::DateRange {
        start: "2026-10-03".into(),
        end: "2026-10-04".into(),
        start_epoch: None,
        end_epoch: None,
    };
    let window = ResolutionWindow {
        mode: crate::activity_recall::ResolutionMode::CurrentState,
        start_epoch: 1,
        end_epoch: 3,
        as_of_epoch: 2,
        captured_query_epoch: 2,
    };
    let packet: Value = serde_json::from_str(
        &payload("Synthetic work", "en", &range, &window, &keys, &[]).unwrap(),
    )
    .unwrap();
    assert_eq!(packet["initialOriginalSpans"].as_array().unwrap().len(), 1);
    assert_eq!(packet["allowedSpanIds"].as_array().unwrap().len(), 1);
    assert_eq!(
        packet["recordPeriodContext"]["spans"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        packet["recordPeriodContext"]["spans"][0]["spanId"],
        originals.spans().next().unwrap().id()
    );
}
