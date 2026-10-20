//! Explicit QA selection boundaries; no model or product authority is issued.
use super::*;

#[test]
fn named_focus_requires_selected_activity_focus_and_preserves_model_defaults() {
    let mut selected = source_focus_config();
    selected.activity_questions = true;
    selected.source_focus_claims = true;
    selected.named_source_focus_claims = true;
    assert_eq!(
        selected.activity_manifest().unwrap().id,
        crate::local_model::MODEL.id
    );
    assert!(!selected.reviewed_activity_correction && !selected.compact_claims);
    for (activity, focus, compact) in [
        (false, false, false),
        (false, true, false),
        (true, false, false),
        (true, true, true),
    ] {
        let mut invalid = source_focus_config();
        invalid.activity_questions = activity;
        invalid.source_focus_claims = focus;
        invalid.compact_claims = compact;
        invalid.named_source_focus_claims = true;
        assert_eq!(
            invalid.activity_manifest().unwrap_err(),
            "named source focus requires source focus activity QA mode"
        );
    }
}

#[test]
fn invalid_named_focus_returns_before_native_profile_or_environment_preparation() {
    crate::settings::test_support::with_isolated_data("native-ask-named-focus-reject", |_| {
        let before = std::env::var_os("MYCO_DATA_DIR");
        let mut invalid = source_focus_config();
        invalid.named_source_focus_claims = true;
        assert_eq!(run(invalid), 1);
        assert_eq!(std::env::var_os("MYCO_DATA_DIR"), before);
    });
}
