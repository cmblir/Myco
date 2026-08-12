//! Environment-variable names are a user-facing contract: they are documented
//! in the READMEs and already exported from shell profiles, dev scripts, and CI
//! configs. The rebrand renames them `MEMEX_*` -> `MYCO_*`, so every read goes
//! through here and accepts either spelling.
//!
//! `MYCO_*` wins when both are set, so an operator can override a legacy value
//! without unsetting it first. `settings.rs` resolves `MYCO_DATA_DIR` on its own
//! (it must also mirror Python's blank-value handling) — this is for the rest.

/// Read `name` (a `MYCO_*` variable), falling back to the pre-rename `MEMEX_*`
/// spelling. Returns `None` when neither is set.
pub fn var(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .or_else(|| std::env::var(legacy_name(name)).ok())
}

/// The pre-rename spelling of a `MYCO_*` variable. Anything not carrying the
/// prefix is returned unchanged, so a caller that passes an unrelated name gets
/// a plain lookup rather than a silently wrong one.
fn legacy_name(name: &str) -> String {
    match name.strip_prefix("MYCO_") {
        Some(rest) => format!("MEMEX_{rest}"),
        None => name.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_name_only_rewrites_the_prefix() {
        assert_eq!(legacy_name("MYCO_CLAUDE_PATH"), "MEMEX_CLAUDE_PATH");
        assert_eq!(
            legacy_name("MYCO_OPENAI_MODELS_URL"),
            "MEMEX_OPENAI_MODELS_URL"
        );
        assert_eq!(legacy_name("PATH"), "PATH");
        // Not a prefix match — must not become "MEMEX_SOMETHING".
        assert_eq!(legacy_name("NOT_MYCO_THING"), "NOT_MYCO_THING");
    }

    #[test]
    fn the_new_spelling_wins_and_the_old_one_is_still_honoured() {
        // Serialised against the other env-mutating tests in this crate.
        let _guard = crate::settings::test_support::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let (new, old) = ("MYCO_ENV_TEST_ONLY", "MEMEX_ENV_TEST_ONLY");
        unsafe {
            std::env::remove_var(new);
            std::env::remove_var(old);
        }
        assert_eq!(var(new), None);

        unsafe { std::env::set_var(old, "legacy") };
        assert_eq!(var(new).as_deref(), Some("legacy"));

        unsafe { std::env::set_var(new, "current") };
        assert_eq!(var(new).as_deref(), Some("current"));

        unsafe {
            std::env::remove_var(new);
            std::env::remove_var(old);
        }
    }
}
