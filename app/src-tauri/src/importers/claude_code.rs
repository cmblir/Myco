//! Parse a Claude Code session (`~/.claude/projects/<enc>/<uuid>.jsonl`) into a
//! normalized conversation.
//!
//! Each line is a JSON object. The ones that matter are `type: "user"` and
//! `type: "assistant"`, whose `message.content` is either a plain string (a real
//! human prompt) or an array of blocks. Only the *spoken* content is kept:
//! `text` blocks, and string user content. Tool traffic (tool_use / tool_result
//! blocks, which is the bulk of a session), the model's `thinking`, images, and
//! sub-agent `isSidechain` lines are all noise for a wiki source and are
//! dropped — the ingest model wants the discussion, not the transcript of every
//! file read.

use super::{Conversation, Role, Source, Turn};
use serde::Deserialize;

#[derive(Deserialize)]
struct Line {
    #[serde(rename = "type", default)]
    kind: Option<String>,
    #[serde(default)]
    message: Option<Message>,
    #[serde(rename = "isSidechain", default)]
    is_sidechain: bool,
    #[serde(rename = "sessionId", default)]
    session_id: Option<String>,
    #[serde(default)]
    timestamp: Option<String>,
}

#[derive(Deserialize)]
struct Message {
    // role is taken from the line's `type`, which agrees with message.role; we
    // only need the content here.
    #[serde(default)]
    content: serde_json::Value,
}

/// Parse a whole session file (its raw text) into one conversation. Returns None
/// when nothing spoken survives the filtering (a pure tool-run, say). `fallback_id`
/// is used when no line carries a sessionId (e.g. derive it from the filename).
pub fn parse(jsonl: &str, fallback_id: &str) -> Option<Conversation> {
    let mut turns = Vec::new();
    let mut session_id: Option<String> = None;
    let mut first_ts: Option<String> = None;

    for raw in jsonl.lines() {
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }
        // A malformed line is skipped, not fatal — a session can be appended to
        // mid-write.
        let Ok(line) = serde_json::from_str::<Line>(raw) else {
            continue;
        };
        if session_id.is_none() {
            session_id = line.session_id.clone();
        }
        if first_ts.is_none() {
            first_ts = line.timestamp.clone();
        }
        if line.is_sidechain {
            continue; // sub-agent chatter, not the main thread
        }
        let role = match line.kind.as_deref() {
            Some("user") => Role::User,
            Some("assistant") => Role::Assistant,
            _ => continue,
        };
        let Some(msg) = &line.message else { continue };
        let text = spoken_text(&msg.content);
        if text.is_empty() {
            continue;
        }
        turns.push(Turn { role, text });
    }

    if turns.is_empty() {
        return None;
    }
    let id = session_id
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| fallback_id.to_string());
    Some(Conversation {
        id,
        source: Source::ClaudeCode,
        title: title_from(&turns),
        created: first_ts.as_deref().and_then(super::parse_iso8601),
        turns,
    })
}

/// The human-readable text of a message: a plain string as-is, or the joined
/// `text` blocks of an array. Everything else (tool_use, tool_result, thinking,
/// image) contributes nothing.
fn spoken_text(content: &serde_json::Value) -> String {
    if let Some(s) = content.as_str() {
        return s.trim().to_string();
    }
    let Some(blocks) = content.as_array() else {
        return String::new();
    };
    blocks
        .iter()
        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
        .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// A session has no title; use the first line of the first user prompt.
fn title_from(turns: &[Turn]) -> String {
    turns
        .iter()
        .find(|t| t.role == Role::User)
        .and_then(|t| t.text.lines().next())
        .map(|l| {
            let l = l.trim();
            if l.chars().count() > 72 {
                format!("{}…", l.chars().take(72).collect::<String>())
            } else {
                l.to_string()
            }
        })
        .filter(|l| !l.is_empty())
        .unwrap_or_else(|| "Claude Code session".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Mirrors the real shape: a string user prompt, an assistant line whose
    // content is blocks (text kept, thinking/tool_use dropped), a tool_result
    // "user" line (dropped — no text blocks), and a sidechain line (dropped).
    const FIXTURE: &str = r#"
{"type":"user","sessionId":"sess-1","timestamp":"2026-07-18T09:00:00.000Z","message":{"role":"user","content":"How does attention work?"}}
{"type":"assistant","sessionId":"sess-1","message":{"role":"assistant","content":[{"type":"thinking","thinking":"internal"},{"type":"text","text":"It weights tokens by relevance."},{"type":"tool_use","name":"Read","input":{}}]}}
{"type":"user","sessionId":"sess-1","message":{"role":"user","content":[{"type":"tool_result","content":"file bytes"}]}}
{"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"sub-agent noise"}]}}
{"type":"assistant","sessionId":"sess-1","message":{"role":"assistant","content":[{"type":"text","text":"Anything else?"}]}}
"#;

    #[test]
    fn keeps_only_spoken_text_and_drops_tool_and_sidechain_noise() {
        let c = parse(FIXTURE, "file-stem").unwrap();
        assert_eq!(c.id, "sess-1");
        assert_eq!(c.source, Source::ClaudeCode);
        // user prompt, assistant text, assistant text — the tool_result user
        // line and the sidechain assistant line are gone; thinking/tool_use
        // blocks within a kept line are gone too.
        assert_eq!(c.turns.len(), 3);
        assert_eq!(c.turns[0].text, "How does attention work?");
        assert_eq!(c.turns[1].text, "It weights tokens by relevance.");
        assert_eq!(c.turns[2].text, "Anything else?");
        assert!(!c.turns.iter().any(|t| t.text.contains("noise")));
        assert!(!c.turns.iter().any(|t| t.text.contains("internal")));
    }

    #[test]
    fn titles_from_the_first_prompt_and_stamps_the_time() {
        let c = parse(FIXTURE, "file-stem").unwrap();
        assert_eq!(c.title, "How does attention work?");
        // 2026-07-18T09:00:00Z
        assert_eq!(c.created, Some(1_784_365_200));
    }

    #[test]
    fn a_pure_tool_run_with_no_speech_yields_nothing() {
        let json = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"x"}]}}"#;
        assert!(parse(json, "stem").is_none());
    }

    #[test]
    fn falls_back_to_the_file_stem_when_no_session_id() {
        let json = r#"{"type":"user","message":{"role":"user","content":"hi there"}}"#;
        assert_eq!(parse(json, "abc-123").unwrap().id, "abc-123");
    }

    #[test]
    fn malformed_lines_are_skipped_not_fatal() {
        let json = "not json\n{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"real\"}}\n{bad";
        let c = parse(json, "s").unwrap();
        assert_eq!(c.turns.len(), 1);
        assert_eq!(c.turns[0].text, "real");
    }

}
