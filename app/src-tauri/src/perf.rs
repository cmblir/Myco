//! Opt-in timing for hot commands, enabled with `MEMEX_PERF=1`.
//!
//! `benches/vector_store.rs` measures the vector store in isolation on synthetic
//! data. That is the right place to compare two implementations, but it cannot
//! answer "where did this user's 900 ms actually go on their real vault" — the
//! split between reading the index, running the model, and scanning is only
//! visible in the app. These probes report that split.
//!
//! Timing is always collected: `Instant::now()` costs tens of nanoseconds next to
//! work measured in milliseconds, so gating the probes themselves would buy
//! nothing and leave two code paths to keep in step. Only formatting and writing
//! the line is gated.
//!
//! Output is one line per command on stderr, structured for grepping:
//!
//! ```text
//! [memex-perf] semantic_search load_store_ms=0.31 embed_query_ms=182.44 scan_ms=11.98 total_ms=194.79 records=10000
//! ```

use std::sync::OnceLock;
use std::time::Duration;

/// Read once — the flag is a developer's launch decision, not something that
/// changes under a running app.
pub fn enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var("MEMEX_PERF").is_ok_and(|v| v == "1"))
}

/// Milliseconds, for building a field value from an elapsed `Duration`.
pub fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1e3
}

/// Render one line. Split out from `log` so the output shape is testable without
/// depending on a process-global env var (`enabled` latches on first read, which
/// a parallel test suite cannot drive deterministically).
///
/// Fields are `(name, value)` in the order the command reached them, so the line
/// reads as the shape of the work. `*_ms` fields are milliseconds to 2dp; bare
/// counts (records, pages) print as integers.
fn format_line(command: &str, fields: &[(&str, f64)]) -> String {
    let body: Vec<String> = fields
        .iter()
        .map(|(k, v)| {
            if k.ends_with("_ms") {
                format!("{k}={v:.2}")
            } else {
                format!("{k}={v:.0}")
            }
        })
        .collect();
    format!("[memex-perf] {command} {}", body.join(" "))
}

/// Emit one `[memex-perf]` line on stderr. No-op unless `MEMEX_PERF=1`.
pub fn log(command: &str, fields: &[(&str, f64)]) {
    if !enabled() {
        return;
    }
    eprintln!("{}", format_line(command, fields));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ms_converts_duration() {
        assert!((ms(Duration::from_micros(1500)) - 1.5).abs() < 1e-9);
        assert_eq!(ms(Duration::ZERO), 0.0);
    }

    #[test]
    fn format_line_renders_times_and_counts_distinctly() {
        let line = format_line(
            "semantic_search",
            &[
                ("load_store_ms", 0.3125),
                ("embed_query_ms", 182.4444),
                ("scan_ms", 11.98),
                ("total_ms", 194.79),
                ("records", 10_000.0),
            ],
        );
        assert_eq!(
            line,
            "[memex-perf] semantic_search load_store_ms=0.31 embed_query_ms=182.44 \
             scan_ms=11.98 total_ms=194.79 records=10000"
        );
    }

    #[test]
    fn format_line_keeps_field_order() {
        // The line is read left-to-right as the shape of the work, so the order
        // the command reported its stages in must survive.
        let line = format_line("x", &[("b_ms", 2.0), ("a_ms", 1.0)]);
        assert_eq!(line, "[memex-perf] x b_ms=2.00 a_ms=1.00");
    }

    #[test]
    fn log_is_inert_when_disabled() {
        // The suite runs without MEMEX_PERF: a disabled probe must cost nothing
        // and never fail a command.
        log("noop", &[("total_ms", 1.0)]);
    }
}
