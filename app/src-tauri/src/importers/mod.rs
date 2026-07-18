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
pub mod claude_web;
pub mod codex;
pub mod ledger;
pub mod secrets_scan;

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

#[cfg(test)]
mod dispatch_tests {
    use super::*;

    #[test]
    fn routes_a_chatgpt_array_to_the_chatgpt_parser() {
        let json = r#"[{"conversation_id":"c1","current_node":"a",
          "mapping":{"a":{"message":{"author":{"role":"user"},"content":{"parts":["hi"]}},"parent":null}}}]"#;
        let convs = detect_and_parse("conversations.json", json).unwrap();
        assert_eq!(convs.len(), 1);
        assert_eq!(convs[0].source, Source::ChatGpt);
    }

    #[test]
    fn routes_a_claude_code_session_by_its_line_shape() {
        let jsonl = "{\"type\":\"user\",\"sessionId\":\"s\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}";
        let convs = detect_and_parse("2202078e.jsonl", jsonl).unwrap();
        assert_eq!(convs.len(), 1);
        assert_eq!(convs[0].source, Source::ClaudeCode);
    }

    #[test]
    fn routes_a_claude_ai_export_by_its_chat_messages_key() {
        // Same top-level [ as ChatGPT, but chat_messages disambiguates it.
        let json = r#"[{"uuid":"c1","name":"t","chat_messages":[{"sender":"human","text":"hi"}]}]"#;
        let convs = detect_and_parse("conversations.json", json).unwrap();
        assert_eq!(convs.len(), 1);
        assert_eq!(convs[0].source, Source::Claude);
    }

    #[test]
    fn routes_a_codex_rollout_by_its_payload_key() {
        let jsonl = "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"hi\"}]}}";
        let convs = detect_and_parse("rollout-x.jsonl", jsonl).unwrap();
        assert_eq!(convs.len(), 1);
        assert_eq!(convs[0].source, Source::Codex);
    }

    #[test]
    fn an_unrecognized_shape_is_an_error() {
        assert!(detect_and_parse("x.txt", "just some prose").is_err());
        assert!(detect_and_parse("x.json", "{\"random\":\"object\"}").is_err());
    }

    #[test]
    fn detection_is_by_content_not_filename() {
        // A ChatGPT export saved under a Claude-ish name still parses as ChatGPT.
        let json = r#"[{"conversation_id":"c1","current_node":"a",
          "mapping":{"a":{"message":{"author":{"role":"user"},"content":{"parts":["hi"]}},"parent":null}}}]"#;
        assert_eq!(
            detect_and_parse("claude-conversations.json", json).unwrap()[0].source,
            Source::ChatGpt
        );
    }

    #[test]
    fn plan_import_writes_clean_docs() {
        let jsonl = "{\"type\":\"user\",\"sessionId\":\"s1\",\"message\":{\"role\":\"user\",\"content\":\"how does attention work\"}}";
        let plan = plan_import("s1.jsonl", jsonl, &ledger::Ledger::default()).unwrap();
        assert_eq!(plan.source, "claude-code");
        assert_eq!(plan.docs.len(), 1);
        assert_eq!(plan.docs[0].stem, "claude-code-s1");
        assert_eq!(plan.docs[0].key, "claude-code:s1");
        assert!(plan.docs[0].body.contains("how does attention work"));
        assert!(plan.quarantined.is_empty());
        assert_eq!(plan.skipped, 0);
    }

    #[test]
    fn plan_import_quarantines_a_conversation_with_a_secret() {
        // A prompt that pasted an API key must never reach _inbox/.
        let jsonl = "{\"type\":\"user\",\"sessionId\":\"leak\",\"message\":{\"role\":\"user\",\"content\":\"my key is sk-abcdefghijklmnopqrstuvwxyz012345 fix it\"}}";
        let plan = plan_import("leak.jsonl", jsonl, &ledger::Ledger::default()).unwrap();
        assert!(plan.docs.is_empty(), "must not write a doc with a secret");
        assert_eq!(plan.quarantined.len(), 1);
        assert!(plan.quarantined[0]
            .secrets
            .contains(&"OpenAI/Anthropic-style API key"));
    }

    #[test]
    fn plan_import_errors_on_an_unknown_format() {
        assert!(plan_import("x.txt", "not an export", &ledger::Ledger::default()).is_err());
    }

    #[test]
    fn plan_import_skips_a_conversation_already_in_the_ledger() {
        let jsonl = "{\"type\":\"user\",\"sessionId\":\"s1\",\"message\":{\"role\":\"user\",\"content\":\"how does attention work\"}}";
        // First import records the ledger.
        let empty = ledger::Ledger::default();
        let first = plan_import("s1.jsonl", jsonl, &empty).unwrap();
        let mut led = ledger::Ledger::default();
        for d in &first.docs {
            led.record(d.key.clone(), d.fingerprint.clone());
        }
        // Re-import of the identical export is a no-op: nothing written, one skip.
        let second = plan_import("s1.jsonl", jsonl, &led).unwrap();
        assert!(second.docs.is_empty());
        assert_eq!(second.skipped, 1);
    }

    #[test]
    fn plan_import_reimports_a_changed_conversation() {
        let led = {
            let jsonl = "{\"type\":\"user\",\"sessionId\":\"s1\",\"message\":{\"role\":\"user\",\"content\":\"original\"}}";
            let first = plan_import("s1.jsonl", jsonl, &ledger::Ledger::default()).unwrap();
            let mut l = ledger::Ledger::default();
            for d in &first.docs {
                l.record(d.key.clone(), d.fingerprint.clone());
            }
            l
        };
        // The session grew — same id, new content → imports again as an update.
        let grown = "{\"type\":\"user\",\"sessionId\":\"s1\",\"message\":{\"role\":\"user\",\"content\":\"original then more\"}}";
        let plan = plan_import("s1.jsonl", grown, &led).unwrap();
        assert_eq!(plan.docs.len(), 1);
        assert_eq!(plan.skipped, 0);
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

/// Detect a supported export/session format from its CONTENT (not its name —
/// ChatGPT and Claude both call the file `conversations.json`) and parse it.
///
/// Returns every conversation the file holds: a ChatGPT export is one file with
/// many; a CLI session is one file with one. `filename` is used only for the
/// fallback id when a session carries none. An unrecognized shape is an error,
/// not a silent empty result.
pub fn detect_and_parse(filename: &str, content: &str) -> Result<Vec<Conversation>, String> {
    let stem = std::path::Path::new(filename)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| filename.to_string());

    match sniff(content) {
        Some(Kind::ChatGpt) => chatgpt::parse(content),
        Some(Kind::ClaudeWeb) => claude_web::parse(content),
        Some(Kind::Codex) => Ok(codex::parse(content, &stem).into_iter().collect()),
        Some(Kind::ClaudeCode) => Ok(claude_code::parse(content, &stem).into_iter().collect()),
        None => Err("unrecognized export format".to_string()),
    }
}

enum Kind {
    ChatGpt,
    ClaudeWeb,
    ClaudeCode,
    Codex,
}

/// Decide the format from the bytes. A top-level `[` is a web export — ChatGPT or
/// Claude.ai, told apart by whether its elements carry `chat_messages`. A stream
/// of JSON objects is a CLI session, told apart by the keys its lines carry
/// (`payload` = Codex, `sessionId`/`isSidechain`/message roles = Claude Code).
/// Peeks a handful of lines so a leading blank or metadata line doesn't throw it
/// off.
fn sniff(content: &str) -> Option<Kind> {
    if content.trim_start().starts_with('[') {
        // Both are JSON arrays; the key that separates them appears at the top of
        // the first element. Scan a bounded prefix rather than parse the whole
        // file (a ChatGPT export can be huge, and chatgpt::parse re-parses it).
        // Byte-level so a 64 KB cut inside a multibyte char can't panic.
        let needle = b"\"chat_messages\"";
        let hay = &content.as_bytes()[..content.len().min(64 * 1024)];
        if hay.windows(needle.len()).any(|w| w == needle) {
            return Some(Kind::ClaudeWeb);
        }
        return Some(Kind::ChatGpt);
    }
    for line in content.lines().filter(|l| !l.trim().is_empty()).take(8) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("payload").is_some() {
            return Some(Kind::Codex);
        }
        if v.get("sessionId").is_some() || v.get("isSidechain").is_some() {
            return Some(Kind::ClaudeCode);
        }
        if let Some(t) = v.get("type").and_then(|t| t.as_str()) {
            if t == "user" || t == "assistant" {
                return Some(Kind::ClaudeCode);
            }
        }
    }
    None
}

/// A source doc ready to write to `_inbox/`: its stem (no extension) and body,
/// plus the ledger key and fingerprint the command records once it is written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboxDoc {
    pub stem: String,
    pub body: String,
    pub key: String,
    pub fingerprint: String,
}

/// A conversation held back from import because its text matched a secret shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Quarantined {
    pub title: String,
    pub secrets: Vec<&'static str>,
}

/// The plan for importing one export file: the clean docs to write, the
/// conversations quarantined for containing secrets, and how many were skipped
/// as already-imported. Pure — no IO — so the whole parse → dedup → scan → render
/// decision is testable; the command only writes the docs and records the ledger.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportPlan {
    pub source: String,
    pub docs: Vec<InboxDoc>,
    pub quarantined: Vec<Quarantined>,
    /// Conversations already imported unchanged (present in the ledger).
    pub skipped: usize,
}

/// Parse an export, then split its conversations into clean docs (ready for
/// `_inbox/`), quarantined ones, and already-imported skips. A conversation whose
/// rendered doc matches any secret pattern is never written — a leaked key in a
/// committed source is permanent. One already in `ledger` with the same content
/// is skipped so re-importing an export is idempotent.
pub fn plan_import(filename: &str, content: &str, ledger: &ledger::Ledger) -> Result<ImportPlan, String> {
    let convs = detect_and_parse(filename, content)?;
    let source = convs
        .first()
        .map(|c| c.source.slug().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let mut docs = Vec::new();
    let mut quarantined = Vec::new();
    let mut skipped = 0;
    for c in convs {
        let body = c.to_inbox_doc();
        let key = format!("{}:{}", c.source.slug(), c.id);
        let fp = ledger::fingerprint(&body);
        if ledger.seen(&key, &fp) {
            skipped += 1;
            continue;
        }
        let hits = secrets_scan::scan(&body);
        if hits.is_empty() {
            docs.push(InboxDoc {
                stem: c.doc_stem(),
                body,
                key,
                fingerprint: fp,
            });
        } else {
            // Not recorded: a quarantined conversation is re-checked next time,
            // in case the user removed the secret at the source.
            quarantined.push(Quarantined { title: c.title, secrets: hits });
        }
    }
    Ok(ImportPlan {
        source,
        docs,
        quarantined,
        skipped,
    })
}

/// Keep only characters that are safe and stable in a filename.
fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect()
}
