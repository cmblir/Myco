//! Reuse the lossless original grouping for fresh correction-aware drafts.
use super::*;
use crate::local_synthesis::original_groups_qa::{decode, QaWireFormat};

fn grouped_writer_input(
    candidate: bool,
    review: bool,
    system: &str,
    user: &str,
) -> Result<(String, String), String> {
    let (mut system, mut user) = writer_input(true, review, system, user)?;
    if candidate && !review {
        QaWireFormat::SourceDocumentGroupsQaV1.apply_draft(&mut system, &mut user)?;
    }
    Ok((system, user))
}

#[test]
fn grouped_writer_preserves_complete_previous_actual_packets() {
    let receipt: Value = serde_json::from_str(include_str!(
        "../../../docs/research/2026-11-11-selected-note-writer-review.json"
    ))
    .unwrap();
    let mut drafts = 0;
    for input in receipt["records"].as_array().unwrap().iter().filter(|r| {
        r["phase"] == "selected_note_input" && r["arm"] == "baseline" && r["stage"] == "draft"
    }) {
        let system = input["system"].as_str().unwrap();
        let user = input["user"].as_str().unwrap();
        let baseline = grouped_writer_input(false, false, system, user).unwrap();
        let candidate = grouped_writer_input(true, false, system, user).unwrap();
        let original: Value = serde_json::from_str(&baseline.1).unwrap();
        let mut restored: Value = serde_json::from_str(&candidate.1).unwrap();
        for source in restored["sources"].as_array_mut().unwrap() {
            source["originalSpans"] = decode(&source["originalSpans"].to_string()).unwrap();
        }
        assert_eq!(restored, original);
        let prior_candidate = receipt["records"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| {
                r["phase"] == "selected_note_input"
                    && r["arm"] == "preserve-correction"
                    && r["stage"] == "draft"
                    && r["case"] == input["case"]
            })
            .unwrap();
        assert_eq!(baseline.0, prior_candidate["system"]);
        assert_eq!(baseline.1, prior_candidate["user"]);
        drafts += 1;
    }
    assert_eq!(drafts, 2);
}

#[test]
#[ignore = "requires cached 4B weights and MYCO_QA_GENERATION=1; up to eight actual calls"]
fn cached_model_compares_grouped_writer() {
    run_writer_comparison("grouped-correction-writer", grouped_writer_input);
}
