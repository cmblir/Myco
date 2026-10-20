//! Recheck an admitted Ask stage before and after inference, including errors.

use std::sync::atomic::{AtomicBool, Ordering};

pub(super) fn run<T>(
    cancelled: &AtomicBool,
    mut check: impl FnMut() -> Result<(), String>,
    generate: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    if cancelled.load(Ordering::Acquire) {
        return Err("local generation cancelled".into());
    }
    check()?;
    if cancelled.load(Ordering::Acquire) {
        return Err("local generation cancelled".into());
    }
    let result = generate();
    // Source and authority changes take precedence even on a failed model call.
    let checked = check();
    checked?;
    if cancelled.load(Ordering::Acquire) {
        return Err("local generation cancelled".into());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn cancelled_stage_does_not_read_or_generate() {
        let result: Result<(), _> = run(
            &AtomicBool::new(true),
            || panic!("cancelled stage must not read"),
            || panic!("cancelled stage must not generate"),
        );
        assert_eq!(result.unwrap_err(), "local generation cancelled");
    }

    #[test]
    fn authority_failure_prevents_model_call() {
        let result: Result<(), _> = run(
            &AtomicBool::new(false),
            || Err("Ask execution authority changed".into()),
            || panic!("revoked stage must not generate"),
        );
        assert_eq!(result.unwrap_err(), "Ask execution authority changed");
    }

    #[test]
    fn failed_generation_still_rechecks_and_changed_source_wins() {
        let checks = Cell::new(0);
        let result: Result<(), _> = run(
            &AtomicBool::new(false),
            || {
                checks.set(checks.get() + 1);
                if checks.get() == 2 {
                    Err("source changed after failed inference".into())
                } else {
                    Ok(())
                }
            },
            || Err("model allocation failed".into()),
        );
        assert_eq!(checks.get(), 2);
        assert_eq!(result.unwrap_err(), "source changed after failed inference");
    }

    #[test]
    fn cancelled_success_is_discarded_after_source_recheck() {
        let flag = AtomicBool::new(false);
        let checks = Cell::new(0);
        let result = run(
            &flag,
            || {
                checks.set(checks.get() + 1);
                Ok(())
            },
            || {
                flag.store(true, Ordering::Release);
                Ok("late answer")
            },
        );
        assert_eq!(checks.get(), 2);
        assert_eq!(result.unwrap_err(), "local generation cancelled");
    }

    #[test]
    fn unchanged_stage_preserves_original_generation_error() {
        let checks = Cell::new(0);
        let result: Result<(), _> = run(
            &AtomicBool::new(false),
            || {
                checks.set(checks.get() + 1);
                Ok(())
            },
            || Err("model unavailable".into()),
        );
        assert_eq!(checks.get(), 2);
        assert_eq!(result.unwrap_err(), "model unavailable");
    }
}
