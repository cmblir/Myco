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
            ("AWS access key", Regex::new(r"\bAKIA[0-9A-Z]{16}\b").unwrap()),
            (
                "OpenAI/Anthropic-style API key",
                Regex::new(r"\bsk-[A-Za-z0-9_-]{20,}\b").unwrap(),
            ),
            (
                "GitHub token",
                Regex::new(r"\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b")
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

#[cfg(test)]
mod tests {
    use super::scan;

    #[test]
    fn flags_the_common_key_shapes() {
        assert!(scan("key: AKIAIOSFODNN7EXAMPLE here").contains(&"AWS access key"));
        assert!(scan("sk-abcdefghijklmnopqrstuvwxyz012345").contains(&"OpenAI/Anthropic-style API key"));
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
}
