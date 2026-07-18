//! Parse a Claude.ai web export (`conversations.json` from Settings → Privacy →
//! Export) into normalized conversations.
//!
//! Like the ChatGPT export it is a JSON array, but the shape differs: each
//! element has `uuid`, `name`, `created_at`, and `chat_messages`, and each
//! message has a `sender` ("human" / "assistant") plus text — either a flat
//! `text` string (older exports) or a `content` array of `{type:"text", text}`
//! blocks (newer ones). Both are handled.
//!
//! NOTE: verified against the documented format and the fixtures below, NOT
//! against a real user export — none was available when this was written. It is
//! tolerant (every field optional, both text shapes) but should be checked on a
//! real export before being relied on. Detection is by content, so a file that
//! does not match this shape is simply routed elsewhere, never mis-parsed here.

use super::{Conversation, Role, Source, Turn};
use serde::Deserialize;

#[derive(Deserialize)]
struct RawConversation {
    #[serde(default)]
    uuid: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    chat_messages: Vec<RawMessage>,
}

#[derive(Deserialize)]
struct RawMessage {
    #[serde(default)]
    sender: Option<String>,
    /// Older exports: the whole message as one string.
    #[serde(default)]
    text: Option<String>,
    /// Newer exports: structured content blocks.
    #[serde(default)]
    content: Vec<ContentBlock>,
}

#[derive(Deserialize)]
struct ContentBlock {
    #[serde(default)]
    text: Option<String>,
}

/// True when the parsed JSON array looks like a Claude.ai export (its elements
/// carry `chat_messages`), so the dispatcher can tell it from a ChatGPT array.
pub fn looks_like(value: &serde_json::Value) -> bool {
    value
        .as_array()
        .and_then(|a| a.first())
        .is_some_and(|first| first.get("chat_messages").is_some())
}

pub fn parse(json: &str) -> Result<Vec<Conversation>, String> {
    let raw: Vec<RawConversation> =
        serde_json::from_str(json).map_err(|e| format!("not a Claude.ai export: {e}"))?;
    Ok(raw.into_iter().filter_map(convert).collect())
}

fn convert(raw: RawConversation) -> Option<Conversation> {
    let id = raw.uuid.filter(|s| !s.is_empty())?;
    let turns: Vec<Turn> = raw
        .chat_messages
        .iter()
        .filter_map(message_to_turn)
        .collect();
    if turns.is_empty() {
        return None;
    }
    Some(Conversation {
        id,
        source: Source::Claude,
        title: raw
            .name
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| "Untitled conversation".to_string()),
        created: raw.created_at.as_deref().and_then(super::parse_iso8601),
        turns,
    })
}

fn message_to_turn(msg: &RawMessage) -> Option<Turn> {
    let role = match msg.sender.as_deref() {
        Some("human") | Some("user") => Role::User,
        Some("assistant") => Role::Assistant,
        _ => return None,
    };
    // Prefer the structured content blocks; fall back to the flat text field.
    let from_blocks = msg
        .content
        .iter()
        .filter_map(|b| b.text.as_deref())
        .collect::<Vec<_>>()
        .join("\n");
    let text = if from_blocks.trim().is_empty() {
        msg.text.clone().unwrap_or_default()
    } else {
        from_blocks
    };
    let text = text.trim().to_string();
    if text.is_empty() {
        return None;
    }
    Some(Turn { role, text })
}

#[cfg(test)]
mod tests {
    use super::*;

    // The newer shape (content blocks) and the older shape (flat text) in one
    // export, per the documented format.
    const FIXTURE: &str = r#"[
      {
        "uuid": "conv-1",
        "name": "On attention",
        "created_at": "2026-01-02T03:04:05Z",
        "chat_messages": [
          { "sender": "human", "content": [{"type": "text", "text": "What is attention?"}] },
          { "sender": "assistant", "content": [{"type": "text", "text": "Weighting tokens by relevance."}] },
          { "sender": "human", "text": "Older messages store text flat." }
        ]
      }
    ]"#;

    #[test]
    fn parses_both_content_and_flat_text_shapes() {
        let convs = parse(FIXTURE).unwrap();
        assert_eq!(convs.len(), 1);
        let c = &convs[0];
        assert_eq!(c.id, "conv-1");
        assert_eq!(c.source, Source::Claude);
        assert_eq!(c.title, "On attention");
        assert_eq!(c.created, Some(1_767_323_045));
        assert_eq!(c.turns.len(), 3);
        assert_eq!(c.turns[0].role, Role::User);
        assert_eq!(c.turns[0].text, "What is attention?");
        assert_eq!(c.turns[1].role, Role::Assistant);
        assert_eq!(c.turns[2].text, "Older messages store text flat.");
    }

    #[test]
    fn looks_like_distinguishes_from_a_chatgpt_array() {
        let claude: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        assert!(looks_like(&claude));
        // A ChatGPT element has `mapping`/`current_node`, not `chat_messages`.
        let chatgpt: serde_json::Value =
            serde_json::from_str(r#"[{"mapping":{},"current_node":"a"}]"#).unwrap();
        assert!(!looks_like(&chatgpt));
        assert!(!looks_like(&serde_json::json!([])));
    }

    #[test]
    fn drops_id_less_or_empty_conversations() {
        assert_eq!(parse(r#"[{"chat_messages":[{"sender":"human","text":"hi"}]}]"#).unwrap().len(), 0);
        assert_eq!(parse(r#"[{"uuid":"x","chat_messages":[]}]"#).unwrap().len(), 0);
    }

    #[test]
    fn a_non_array_body_errors() {
        assert!(parse("{\"not\":\"array\"}").is_err());
    }
}
