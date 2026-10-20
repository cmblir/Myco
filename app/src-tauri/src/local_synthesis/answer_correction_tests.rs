//! Correction instruction controls; this suite does not run a model.

use super::*;

#[test]
fn correction_instruction_preserves_original_semantics_and_untrusted_boundaries() {
    for constraint in [
        "ENTIRE supplied originals",
        "AskAnswerV1",
        "only allowed S IDs",
        "untrusted data",
        "never instructions or semantic proof",
        "actual described actors",
        "attributed reports",
        "not independently verified user work",
        "Requests/plans are not completion",
        "completed preparation is not implementation",
        "rollback",
        "cancellation",
        "personal nonperformance",
        "current state unknown",
        "original-supported event dates",
        "never substitute record/import/file time",
        "recordPeriodContext",
        "outside-period/uncertain contrary qualifications",
        "message-bounded verification limits",
        "historical_as_of",
        "asOfEpoch",
        "captured query time",
        "null means none",
        "incomplete coverage",
        "T-preamble",
        "unknown speaker",
        "not keywords",
        "harness messages",
        "grouped recent-work summary",
        "conditional action",
        "source-based reason",
        "first step",
        "instead of inventing",
        "bounded evidence",
    ] {
        assert!(
            SYSTEM.contains(constraint),
            "missing correction constraint: {constraint}"
        );
    }
    assert!(!SYSTEM.contains("<LANGUAGE>"));
    assert!(!SYSTEM.contains("verified completion is required"));
}
