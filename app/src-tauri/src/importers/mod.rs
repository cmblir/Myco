//! Conversation importers.
//!
//! Vendor exports (ChatGPT, Claude, Claude Code, Codex) are parsed into ONE
//! normalized [`Conversation`] shape, then serialized to a plain-markdown source
//! doc that the existing ingest pipeline consumes from `_inbox/`. The parsers
//! live only here, in Rust — the app ships the binary, and the headless daemon
//! already delegates hard parsing to it (`--extract-text`), so there is a single
//! implementation and nothing to drift against.
//!
//! This module is pure: it turns bytes into `Conversation`s and `Conversation`s
//! into markdown. It performs no IO and knows nothing about the vault; the
//! caller writes the docs.

pub mod chatgpt;
pub mod claude_code;
pub mod codex;

/// Parse an ISO-8601 timestamp (`2026-07-18T12:34:56.789Z`) to unix seconds,
/// reading the fixed-width fields so no chrono dependency is needed. Shared by
/// the JSONL session parsers.
pub(crate) fn parse_iso8601(ts: &str) -> Option<i64> {
    let b = ts.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[10] != b'T' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| ts.get(r)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, s) = (num(11..13)?, num(14..16)?, num(17..19)?);
    Some(days_from_civil(y, mo, d) * 86400 + h * 3600 + mi * 60 + s)
}

/// Days since the Unix epoch for a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

#[cfg(test)]
mod time_tests {
    use super::parse_iso8601;

    #[test]
    fn parses_known_epochs() {
        assert_eq!(parse_iso8601("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso8601("2026-07-18T09:00:00.000Z"), Some(1_784_365_200));
        assert_eq!(parse_iso8601("garbage"), None);
    }
}

/// Which tool an exported conversation came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    ChatGpt,
    Claude,
    ClaudeCode,
    Codex,
}

impl Source {
    /// Stable slug used in filenames and the `source:` frontmatter.
    pub fn slug(self) -> &'static str {
        match self {
            Source::ChatGpt => "chatgpt",
            Source::Claude => "claude",
            Source::ClaudeCode => "claude-code",
            Source::Codex => "codex",
        }
    }
}

/// Who authored a turn. Vendor role names are normalized onto these.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
    System,
    Tool,
}

impl Role {
    fn label(self) -> &'static str {
        match self {
            Role::User => "User",
            Role::Assistant => "Assistant",
            Role::System => "System",
            Role::Tool => "Tool",
        }
    }
}

/// One message in a conversation, after normalization.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Turn {
    pub role: Role,
    pub text: String,
}

/// A single conversation, independent of which vendor it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conversation {
    /// The vendor's stable id (conversation UUID / session id). Used to key the
    /// dedup ledger and to name the source doc, so re-importing is idempotent.
    pub id: String,
    pub source: Source,
    pub title: String,
    /// Creation time, unix seconds, when the export records one.
    pub created: Option<i64>,
    pub turns: Vec<Turn>,
}

impl Conversation {
    /// A stable, filesystem-safe basename (no extension) for the source doc.
    /// `<source>-<id>` — the id is the vendor's, so it does not depend on the
    /// title and cannot collide across a re-export.
    pub fn doc_stem(&self) -> String {
        format!("{}-{}", self.source.slug(), sanitize(&self.id))
    }

    /// Render the conversation as a plain-markdown source doc for `_inbox/`.
    ///
    /// A readable transcript, not a data dump: the ingest model reads this the
    /// same way it reads any dropped source. Frontmatter carries the provenance
    /// the wiki's citation contract wants (source, id, and the date if known).
    pub fn to_inbox_doc(&self) -> String {
        let mut out = String::new();
        out.push_str("---\n");
        out.push_str(&format!("source: {}\n", self.source.slug()));
        out.push_str(&format!("conversation_id: {}\n", self.id));
        if let Some(ts) = self.created {
            out.push_str(&format!("created: {ts}\n"));
        }
        out.push_str("---\n\n");
        out.push_str(&format!("# {}\n\n", self.title.trim()));
        for turn in &self.turns {
            out.push_str(&format!("**{}:**\n\n{}\n\n", turn.role.label(), turn.text.trim()));
        }
        out
    }
}

/// Keep only characters that are safe and stable in a filename.
fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect()
}
