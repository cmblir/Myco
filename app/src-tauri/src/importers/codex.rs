//! Parse a Codex CLI session (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`)
//! into a normalized conversation.
//!
//! Each line is `{type, payload, timestamp}`. The conversation lives in
//! `response_item` lines whose `payload.type == "message"`; `session_meta`
//! carries the id. Codex's roles don't map cleanly. `assistant` is the substance
//! (the model narrating what it did) and is kept. `user` holds real prompts but
//! also auto-injected `<environment_context>` blocks — kept, minus those context
//! blocks. `developer` is the harness's permissions/sandbox boilerplate (and,
//! occasionally, a wrapped objective) and is dropped as noise. `reasoning` and
//! `function_call` are tool/internal traffic and never reach the transcript. The
//! ingest model can tolerate what remains.

use super::{Conversation, Role, Source, Turn};
use serde::Deserialize;

#[derive(Deserialize)]
struct Line {
    #[serde(rename = "type", default)]
    kind: Option<String>,
    #[serde(default)]
    payload: Option<serde_json::Value>,
    #[serde(default)]
    timestamp: Option<String>,
}

/// Parse a whole rollout file into one conversation, or None if nothing spoken
/// survives. `fallback_id` (e.g. the filename) is used when session_meta has no id.
pub fn parse(jsonl: &str, fallback_id: &str) -> Option<Conversation> {
    let mut turns = Vec::new();
    let mut id: Option<String> = None;
    let mut first_ts: Option<String> = None;

    for raw in jsonl.lines() {
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }
        let Ok(line) = serde_json::from_str::<Line>(raw) else {
            continue;
        };
        if first_ts.is_none() {
            first_ts = line.timestamp.clone();
        }
        let Some(payload) = &line.payload else { continue };

        if line.kind.as_deref() == Some("session_meta") {
            if id.is_none() {
                id = payload
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
            }
            continue;
        }
        if line.kind.as_deref() != Some("response_item") {
            continue;
        }
        if payload.get("type").and_then(|t| t.as_str()) != Some("message") {
            continue; // reasoning / function_call / …
        }
        let role = match payload.get("role").and_then(|r| r.as_str()) {
            Some("assistant") => Role::Assistant,
            Some("user") => Role::User,
            _ => continue, // developer + anything else is harness noise
        };
        let text = message_text(payload);
        if text.is_empty() || is_injected_context(&text) {
            continue;
        }
        turns.push(Turn { role, text });
    }

    if turns.is_empty() {
        return None;
    }
    Some(Conversation {
        id: id.filter(|s| !s.is_empty()).unwrap_or_else(|| fallback_id.to_string()),
        source: Source::Codex,
        title: title_from(&turns),
        created: first_ts.as_deref().and_then(super::parse_iso8601),
        turns,
    })
}

/// Join the text of a message's content blocks (`input_text` / `output_text`).
fn message_text(payload: &serde_json::Value) -> String {
    let Some(blocks) = payload.get("content").and_then(|c| c.as_array()) else {
        return String::new();
    };
    blocks
        .iter()
        .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// Codex injects a `<environment_context>` block as a user message at the start
/// of a turn. It is machine boilerplate, not something the user said.
fn is_injected_context(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with("<environment_context>") || t.starts_with("<permissions")
}

fn title_from(turns: &[Turn]) -> String {
    turns
        .iter()
        .find(|t| t.role == Role::User)
        .or_else(|| turns.first())
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
        .unwrap_or_else(|| "Codex session".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Mirrors the real shape: session_meta with an id; a developer boilerplate
    // message (dropped); an injected environment_context user message (dropped);
    // a real user prompt; an assistant reply; a reasoning item (dropped).
    const FIXTURE: &str = r#"
{"type":"session_meta","timestamp":"2026-05-18T23:59:51.000Z","payload":{"id":"sess-cdx","cwd":"/x"}}
{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"<permissions instructions>..."}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>\n <cwd>/x</cwd>\n</environment_context>"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Port the app to Codex."}]}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Checking the project structure first."}]}}
{"type":"response_item","payload":{"type":"reasoning","summary":"internal","content":[{"type":"text","text":"secret thoughts"}]}}
"#;

    #[test]
    fn keeps_real_turns_and_drops_developer_context_and_reasoning() {
        let c = parse(FIXTURE, "file-stem").unwrap();
        assert_eq!(c.id, "sess-cdx");
        assert_eq!(c.source, Source::Codex);
        // real user prompt + assistant reply; developer, environment_context and
        // reasoning are all gone.
        assert_eq!(c.turns.len(), 2);
        assert_eq!(c.turns[0].role, Role::User);
        assert_eq!(c.turns[0].text, "Port the app to Codex.");
        assert_eq!(c.turns[1].role, Role::Assistant);
        assert_eq!(c.turns[1].text, "Checking the project structure first.");
        assert!(!c.turns.iter().any(|t| t.text.contains("permissions")));
        assert!(!c.turns.iter().any(|t| t.text.contains("environment_context")));
        assert!(!c.turns.iter().any(|t| t.text.contains("secret thoughts")));
    }

    #[test]
    fn titles_from_the_first_real_prompt() {
        assert_eq!(parse(FIXTURE, "s").unwrap().title, "Port the app to Codex.");
    }

    #[test]
    fn falls_back_to_the_file_stem_without_session_meta() {
        let json = r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}"#;
        assert_eq!(parse(json, "rollout-xyz").unwrap().id, "rollout-xyz");
    }

    #[test]
    fn a_session_with_only_noise_yields_nothing() {
        let json = r#"
{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"boilerplate"}]}}
{"type":"response_item","payload":{"type":"reasoning","content":[{"type":"text","text":"x"}]}}
"#;
        assert!(parse(json, "s").is_none());
    }

    #[test]
    fn malformed_lines_are_skipped() {
        let json = "junk\n{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"kept\"}]}}";
        let c = parse(json, "s").unwrap();
        assert_eq!(c.turns.len(), 1);
        assert_eq!(c.turns[0].text, "kept");
    }
}
