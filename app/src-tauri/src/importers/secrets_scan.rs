//! Detect credential-shaped strings in text before it is written into the vault.
//!
//! Ported from the MCP server's `scan_secrets` (SEC-03) so the app's import path
//! has the same guard the agent path already has. Importing a thousand session
//! transcripts unattended into a git-committed tree is the one irreversible
//! failure in this feature: a leaked key in `raw/` is history. So a conversation
//! whose text matches any of these patterns is quarantined, not written to
//! `_inbox/` where auto-ingest would commit it.
//!
//! Pattern-based, so it is best-effort — it catches the common vendor key
//! shapes, not every possible secret.

use regex::Regex;
use std::sync::OnceLock;

fn patterns() -> &'static [(&'static str, Regex)] {
    static P: OnceLock<Vec<(&'static str, Regex)>> = OnceLock::new();
    P.get_or_init(|| {
        vec![
            (
                "AWS access key",
                Regex::new(r"\bAKIA[0-9A-Z]{16}\b").unwrap(),
            ),
            (
                "OpenAI/Anthropic-style API key",
                Regex::new(r"\bsk-[A-Za-z0-9_-]{20,}\b").unwrap(),
            ),
            (
                "GitHub token",
                Regex::new(
                    r"\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b",
                )
                .unwrap(),
            ),
            (
                "Slack token",
                Regex::new(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b").unwrap(),
            ),
            (
                "Google API key",
                Regex::new(r"\bAIza[0-9A-Za-z_-]{35}\b").unwrap(),
            ),
            (
                "Private key block",
                Regex::new(r"-----BEGIN [A-Z ]*PRIVATE KEY-----").unwrap(),
            ),
        ]
    })
}

/// Names of the secret patterns found in `text`. Empty means clean.
pub fn scan(text: &str) -> Vec<&'static str> {
    patterns()
        .iter()
        .filter(|(_, re)| re.is_match(text))
        .map(|(name, _)| *name)
        .collect()
}

// PII patterns (Q4 item 13) — a softer tier than credentials: written with a
// warning by default, refused/quarantined when `pii_quarantine_enabled` is on.
// Kept in sync with automation/autoingest.py (PII_PATTERNS) — the last
// remaining copy now that the Python MCP server is retired.
fn pii_patterns() -> &'static [(&'static str, Regex)] {
    static P: OnceLock<Vec<(&'static str, Regex)>> = OnceLock::new();
    P.get_or_init(|| {
        vec![
            (
                "Email address",
                Regex::new(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b").unwrap(),
            ),
            (
                // 01[016789] + 4 + 4 digits, separators -, ., space, or none.
                "KR phone number",
                Regex::new(r"\b01[016789][-. ]?\d{4}[-. ]?\d{4}\b").unwrap(),
            ),
            (
                // dddddd-ddddddd with era digit 1-4 leading the tail; the
                // mandatory dash + fixed widths keep plain dates from matching.
                "KR resident registration number",
                Regex::new(r"\b\d{6}-[1-4]\d{6}\b").unwrap(),
            ),
        ]
    })
}

/// Names of the PII patterns found in `text`. Empty means clean.
pub fn scan_pii(text: &str) -> Vec<&'static str> {
    pii_patterns()
        .iter()
        .filter(|(_, re)| re.is_match(text))
        .map(|(name, _)| *name)
        .collect()
}

/// Scan-before-write gate for every Rust path into raw/ (Q4 item 13; the MCP
/// tools and distill's summary-tier move): secrets always refuse; PII refuses
/// when quarantine mode is on, otherwise
/// `Ok(Some(warning))` — the write proceeds and the warning is attached as
/// `pii_warning`. Refusal strings kept in sync with automation/autoingest.py
/// (quarantine move). The verdict is pinned to auto-ingest's `shouldPromote`
/// (redaction.ts) by the shared fixture `src/lib/redactionCases.json`.
pub(crate) fn raw_source_guard(
    content: &str,
    pii_quarantine: bool,
) -> Result<Option<String>, String> {
    let secrets = scan(content);
    if !secrets.is_empty() {
        return Err(format!(
            "refused: possible secrets ({}) — redact and re-add. Nothing was written.",
            secrets.join(", ")
        ));
    }
    let pii = scan_pii(content);
    if pii.is_empty() {
        return Ok(None);
    }
    if pii_quarantine {
        return Err(format!(
            "refused: possible PII ({}) — redact and re-add. Nothing was written.",
            pii.join(", ")
        ));
    }
    Ok(Some(format!(
        "possible PII detected: {} — raw/ is immutable and committed to git; \
         redact and re-add if unintended.",
        pii.join(", ")
    )))
}

#[cfg(test)]
mod tests {
    use super::scan;

    #[test]
    fn flags_the_common_key_shapes() {
        assert!(scan("key: AKIAIOSFODNN7EXAMPLE here").contains(&"AWS access key"));
        assert!(
            scan("sk-abcdefghijklmnopqrstuvwxyz012345").contains(&"OpenAI/Anthropic-style API key")
        );
        assert!(scan("ghp_0123456789012345678901234567890123456789").contains(&"GitHub token"));
        assert!(scan("xoxb-0123456789-abcdef").contains(&"Slack token"));
        assert!(scan("AIzaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").contains(&"Google API key"));
        assert!(scan("-----BEGIN RSA PRIVATE KEY-----").contains(&"Private key block"));
    }

    #[test]
    fn ordinary_prose_and_code_are_clean() {
        assert!(scan("Let's talk about attention mechanisms and sk (without a dash).").is_empty());
        assert!(scan("The function sk_test is fine; so is ghp without an underscore.").is_empty());
        assert!(scan("").is_empty());
    }

    #[test]
    fn reports_every_distinct_secret_present() {
        let text = "AKIAIOSFODNN7EXAMPLE and sk-abcdefghijklmnopqrstuvwxyz012345";
        let hits = scan(text);
        assert!(hits.contains(&"AWS access key"));
        assert!(hits.contains(&"OpenAI/Anthropic-style API key"));
    }

    #[test]
    fn scan_pii_matches_email_phone_rrn_and_ignores_dates() {
        use super::scan_pii;
        assert!(scan_pii("contact me at test.user@example.co.kr please").contains(&"Email address"));
        assert!(scan_pii("call 010-1234-5678 tomorrow").contains(&"KR phone number"));
        assert!(scan_pii("call 010.1234.5678").contains(&"KR phone number"));
        assert!(scan_pii("call 01112345678").contains(&"KR phone number"));
        // Obviously synthetic RRN-shaped value — never a real person's number.
        assert!(scan_pii("rrn 000000-3000000 on file").contains(&"KR resident registration number"));
        // Plain dates, versions, and prose must stay clean.
        assert!(scan_pii("meeting on 2026-08-23 at 10:00").is_empty());
        assert!(scan_pii("shipped 20260823 as release 1.2.3").is_empty());
        assert!(scan_pii("").is_empty());
    }

    // Auto-ingest decides TS-side (redaction.ts `shouldPromote`, fed this
    // scan); the Rust raw/ entry paths decide with `raw_source_guard`. The
    // same fixture drives redaction.test.ts, so the two cannot drift apart.
    #[test]
    fn the_promotion_rule_matches_the_shared_fixture() {
        use super::{raw_source_guard, scan_pii};
        let cases: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../../../src/lib/redactionCases.json")).unwrap();
        assert!(!cases.is_empty());
        let names = |v: &serde_json::Value| -> Vec<String> {
            v.as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_str().unwrap().to_string())
                .collect()
        };
        for c in &cases {
            let name = c["name"].as_str().unwrap();
            let text = c["text"].as_str().unwrap();
            assert_eq!(scan(text), names(&c["secrets"]), "{name}");
            assert_eq!(scan_pii(text), names(&c["pii"]), "{name}");
            for (pii_quarantine, key) in [(false, "promote_warn"), (true, "promote_quarantine")] {
                assert_eq!(
                    raw_source_guard(text, pii_quarantine).is_ok(),
                    c[key].as_bool().unwrap(),
                    "{name} / {key}"
                );
            }
        }
    }
}
