//! Parse a ChatGPT `conversations.json` export into normalized conversations.
//!
//! The export is a JSON array. Each conversation stores its messages as a
//! `mapping` of node-id → node (a tree, because edits and regenerations branch
//! it) plus a `current_node` pointing at the leaf of the ACTIVE branch. So the
//! real conversation is the path from `current_node` up to the root — walking
//! any other branch would replay a message the user discarded. Abandoned
//! branches are dropped on purpose.

use super::{Conversation, Role, Source, Turn};
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Deserialize)]
struct RawConversation {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    create_time: Option<f64>,
    #[serde(default)]
    mapping: HashMap<String, RawNode>,
    #[serde(default)]
    current_node: Option<String>,
    // ChatGPT has used both keys across export versions.
    #[serde(default)]
    conversation_id: Option<String>,
    #[serde(default)]
    id: Option<String>,
}

#[derive(Deserialize)]
struct RawNode {
    #[serde(default)]
    message: Option<RawMessage>,
    #[serde(default)]
    parent: Option<String>,
}

#[derive(Deserialize)]
struct RawMessage {
    #[serde(default)]
    author: RawAuthor,
    #[serde(default)]
    content: Option<RawContent>,
}

#[derive(Deserialize, Default)]
struct RawAuthor {
    #[serde(default)]
    role: Option<String>,
}

#[derive(Deserialize)]
struct RawContent {
    // Present for text/code/multimodal. Entries are usually strings; non-string
    // parts (image pointers, etc.) are skipped.
    #[serde(default)]
    parts: Vec<serde_json::Value>,
}

/// Parse the whole export. Returns one [`Conversation`] per array element that
/// has any real text, newest first (the order the export already uses).
pub fn parse(json: &str) -> Result<Vec<Conversation>, String> {
    let raw: Vec<RawConversation> =
        serde_json::from_str(json).map_err(|e| format!("not a ChatGPT export: {e}"))?;
    Ok(raw.into_iter().filter_map(convert).collect())
}

fn convert(raw: RawConversation) -> Option<Conversation> {
    let id = raw
        .conversation_id
        .or(raw.id)
        .filter(|s| !s.is_empty())?;

    // Follow the ACTIVE branch: current_node → parent → … → root, then reverse.
    // A missing current_node (rare) yields no turns and the conversation drops.
    // The visited set both terminates a malformed parent cycle and prevents a
    // node being counted twice.
    let mut turns = Vec::new();
    let mut visited = std::collections::HashSet::new();
    let mut cursor = raw.current_node.clone();
    while let Some(node_id) = cursor {
        if !visited.insert(node_id.clone()) {
            break; // cycle
        }
        let Some(node) = raw.mapping.get(&node_id) else {
            break;
        };
        if let Some(turn) = node.message.as_ref().and_then(message_to_turn) {
            turns.push(turn);
        }
        cursor = node.parent.clone();
    }
    turns.reverse();

    if turns.is_empty() {
        return None;
    }

    Some(Conversation {
        id,
        source: Source::ChatGpt,
        title: raw
            .title
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| "Untitled conversation".to_string()),
        created: raw.create_time.map(|t| t as i64),
        turns,
    })
}

fn message_to_turn(msg: &RawMessage) -> Option<Turn> {
    let role = match msg.author.role.as_deref() {
        Some("user") => Role::User,
        Some("assistant") => Role::Assistant,
        Some("system") => Role::System,
        Some("tool") => Role::Tool,
        _ => return None,
    };
    let text = msg
        .content
        .as_ref()?
        .parts
        .iter()
        .filter_map(|p| p.as_str())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    if text.is_empty() {
        return None;
    }
    Some(Turn { role, text })
}

#[cfg(test)]
mod tests {
    use super::*;

    // A minimal but realistic export: a root system node (empty), a user turn,
    // an assistant turn, and — crucially — an ABANDONED branch off the user node
    // that current_node does NOT point at, which must not appear in the output.
    const FIXTURE: &str = r#"[
      {
        "title": "Attention",
        "create_time": 1700000000.0,
        "conversation_id": "conv-abc",
        "current_node": "n3",
        "mapping": {
          "n0": { "message": { "author": {"role": "system"}, "content": {"parts": [""]} }, "parent": null },
          "n1": { "message": { "author": {"role": "user"}, "content": {"parts": ["What is attention?"]} }, "parent": "n0" },
          "n2": { "message": { "author": {"role": "assistant"}, "content": {"parts": ["A DISCARDED regenerated answer."]} }, "parent": "n1" },
          "n3": { "message": { "author": {"role": "assistant"}, "content": {"parts": ["Attention weights tokens by relevance."]} }, "parent": "n1" }
        }
      }
    ]"#;

    #[test]
    fn follows_the_active_branch_and_drops_the_abandoned_one() {
        let convs = parse(FIXTURE).unwrap();
        assert_eq!(convs.len(), 1);
        let c = &convs[0];
        assert_eq!(c.id, "conv-abc");
        assert_eq!(c.title, "Attention");
        assert_eq!(c.created, Some(1_700_000_000));
        // The empty system root is dropped; the discarded n2 branch never
        // appears; user then assistant, in order.
        assert_eq!(c.turns.len(), 2);
        assert_eq!(c.turns[0].role, Role::User);
        assert_eq!(c.turns[0].text, "What is attention?");
        assert_eq!(c.turns[1].role, Role::Assistant);
        assert_eq!(c.turns[1].text, "Attention weights tokens by relevance.");
    }

    #[test]
    fn to_inbox_doc_is_a_readable_transcript_with_provenance() {
        let c = &parse(FIXTURE).unwrap()[0];
        let doc = c.to_inbox_doc();
        assert!(doc.contains("source: chatgpt"));
        assert!(doc.contains("conversation_id: conv-abc"));
        assert!(doc.contains("created: 1700000000"));
        assert!(doc.contains("# Attention"));
        assert!(doc.contains("**User:**"));
        assert!(doc.contains("What is attention?"));
        assert!(doc.contains("**Assistant:**"));
        assert!(!doc.contains("DISCARDED"));
        assert_eq!(c.doc_stem(), "chatgpt-conv-abc");
    }

    #[test]
    fn empty_and_malformed_conversations_drop_without_erroring() {
        // No current_node → no turns → dropped. An id-less conversation → dropped.
        let json = r#"[
          {"conversation_id": "empty", "mapping": {}},
          {"mapping": {"x": {"message": {"author": {"role": "user"}, "content": {"parts": ["hi"]}}}}}
        ]"#;
        assert_eq!(parse(json).unwrap().len(), 0);
    }

    #[test]
    fn a_non_array_body_is_an_error_not_a_panic() {
        assert!(parse("<html>not json</html>").is_err());
        assert!(parse("{\"not\": \"an array\"}").is_err());
    }

    #[test]
    fn non_string_parts_are_skipped_multimodal_keeps_its_text() {
        let json = r#"[{
          "conversation_id": "mm",
          "current_node": "a",
          "mapping": {
            "a": { "message": { "author": {"role": "user"},
                    "content": {"parts": [{"image": "ptr"}, "the caption text"]} }, "parent": null }
          }
        }]"#;
        let c = &parse(json).unwrap()[0];
        assert_eq!(c.turns.len(), 1);
        assert_eq!(c.turns[0].text, "the caption text");
    }

    #[test]
    fn a_cycle_in_the_mapping_terminates() {
        // Defensive: a malformed export with a parent cycle must not hang.
        let json = r#"[{
          "conversation_id": "cyc",
          "current_node": "a",
          "mapping": {
            "a": { "message": { "author": {"role": "user"}, "content": {"parts": ["x"]} }, "parent": "b" },
            "b": { "message": { "author": {"role": "assistant"}, "content": {"parts": ["y"]} }, "parent": "a" }
          }
        }]"#;
        // Terminates (each node is visited at most once) — a and b, no repeats.
        let c = &parse(json).unwrap()[0];
        assert_eq!(c.turns.len(), 2);
    }
}
