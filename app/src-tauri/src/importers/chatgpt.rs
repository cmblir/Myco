//! Parse a ChatGPT `conversations.json` export into normalized conversations.
//!
//! The export is a JSON array. Each conversation stores its messages as a
//! `mapping` of node-id → node (a tree, because edits and regenerations branch
//! it) plus a `current_node` pointing at the leaf of the ACTIVE branch. So the
//! real conversation is the path from `current_node` up to the root — walking
//! any other branch would replay a message the user discarded. Abandoned
//! branches are dropped on purpose.

use super::{Conversation, Role, Source, Turn, TurnMetadata};
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
    message: Option<serde_json::Value>,
    #[serde(default)]
    parent: Option<String>,
}

/// Parse the whole export. Returns one [`Conversation`] per array element that
/// has any real text, newest first (the order the export already uses).
pub fn parse(json: &str) -> Result<Vec<Conversation>, String> {
    let raw: Vec<RawConversation> =
        serde_json::from_str(json).map_err(|e| format!("not a ChatGPT export: {e}"))?;
    Ok(raw.into_iter().filter_map(convert).collect())
}

fn convert(raw: RawConversation) -> Option<Conversation> {
    let id = raw.conversation_id.or(raw.id).filter(|s| !s.is_empty())?;

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
        if let Some(turn) = node
            .message
            .as_ref()
            .and_then(|message| message_to_turn(message, &node_id, node.parent.as_deref()))
        {
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

fn message_to_turn(
    msg: &serde_json::Value,
    node_id: &str,
    parent_id: Option<&str>,
) -> Option<Turn> {
    let original_role = msg.pointer("/author/role")?.as_str()?;
    let role = match original_role {
        "user" => Role::User,
        "assistant" => Role::Assistant,
        "system" => Role::System,
        "tool" => Role::Tool,
        _ => return None,
    };
    let text = msg
        .pointer("/content/parts")?
        .as_array()?
        .iter()
        .filter_map(|p| p.as_str())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    if text.is_empty() {
        return None;
    }
    Some(Turn {
        role,
        text,
        metadata: TurnMetadata {
            message_id: msg.get("id").and_then(|id| id.as_str()).filter(|id| !id.is_empty())
                .or_else(|| (!node_id.is_empty()).then_some(node_id)).map(str::to_string),
            parent_id: parent_id.map(str::to_string),
            timestamp: msg.get("create_time").and_then(|time| time.as_f64()).and_then(message_timestamp),
            original_role: Some(original_role.to_string()),
            // Preserve the parsed message and its observed mapping coordinates.
            // JSON is reserialized; this is not the original export's bytes.
            original_record: Some(serde_json::json!({"mapping_node_id": node_id, "parent_id": parent_id, "message": msg}).to_string()),
            ..Default::default()
        },
    })
}

/// Convert only an observed message epoch to UTC; never borrow the conversation
/// creation time or the import clock for a message with an unknown timestamp.
fn message_timestamp(epoch: f64) -> Option<String> {
    if !epoch.is_finite() || !(-62_167_219_200.0..253_402_300_800.0).contains(&epoch) {
        return None;
    }
    let mut seconds = epoch.floor() as i64;
    let mut nanos = ((epoch - epoch.floor()) * 1_000_000_000.0).round() as u32;
    if nanos == 1_000_000_000 {
        seconds += 1;
        nanos = 0;
    }
    let (year, month, day, hour, minute, second) = crate::distill::civil_datetime(seconds);
    let fraction = if nanos == 0 {
        String::new()
    } else {
        format!(".{nanos:09}").trim_end_matches('0').to_string()
    };
    let timestamp =
        format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}{fraction}Z");
    super::parse_iso8601(&timestamp).map(|_| timestamp)
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
        assert_eq!(c.turns[0].metadata.message_id.as_deref(), Some("n1"));
        assert_eq!(c.turns[0].metadata.parent_id.as_deref(), Some("n0"));
        assert!(
            c.turns.iter().all(|turn| turn.metadata.timestamp.is_none()),
            "a conversation date is not a per-message timestamp"
        );
    }

    #[test]
    fn to_inbox_doc_is_a_readable_transcript_with_provenance() {
        let c = &parse(FIXTURE).unwrap()[0];
        let doc = c.to_inbox_doc();
        assert!(doc.contains("source: chatgpt"));
        assert!(doc.contains("conversation_id: \"conv-abc\""));
        assert_eq!(crate::judge::frontmatter_key(&doc), "chatgpt:conv-abc");
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

    #[test]
    fn preserves_observed_message_epochs_ids_and_original_records_on_the_active_branch() {
        let mut source: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        source[0]["mapping"]["n1"]["message"]["id"] = serde_json::json!("message-user");
        source[0]["mapping"]["n1"]["message"]["create_time"] = serde_json::json!(1_700_000_000.125);
        source[0]["mapping"]["n3"]["message"]["id"] = serde_json::json!("message-assistant");
        source[0]["mapping"]["n3"]["message"]["create_time"] = serde_json::json!(1_700_086_400);
        source[0]["mapping"]["n1"]["message"]["provider_extra"] =
            serde_json::json!({"synthetic": true});
        let conversations = parse(&source.to_string()).unwrap();
        let conversation = &conversations[0];
        let first = &conversation.turns[0].metadata;
        assert_eq!(first.message_id.as_deref(), Some("message-user"));
        assert_eq!(first.parent_id.as_deref(), Some("n0"));
        assert_eq!(first.original_role.as_deref(), Some("user"));
        assert_eq!(first.timestamp.as_deref(), Some("2023-11-14T22:13:20.125Z"));
        assert_eq!(
            conversation.turns[1].metadata.timestamp.as_deref(),
            Some("2023-11-15T22:13:20Z")
        );
        let retained: serde_json::Value =
            serde_json::from_str(first.original_record.as_deref().unwrap()).unwrap();
        assert_eq!(retained["mapping_node_id"], "n1");
        assert_eq!(retained["message"], source[0]["mapping"]["n1"]["message"]);
        let rendered = conversation.to_inbox_doc();
        assert!(rendered.contains("last_activity: 1700086400"));
        assert!(!rendered.contains("provider_extra"));
        assert!(!rendered.contains("DISCARDED"));
    }

    #[test]
    fn message_epoch_conversion_handles_pre_epoch_fraction_and_invalid_ranges() {
        assert_eq!(
            message_timestamp(0.0).as_deref(),
            Some("1970-01-01T00:00:00Z")
        );
        assert_eq!(
            message_timestamp(-0.25).as_deref(),
            Some("1969-12-31T23:59:59.75Z")
        );
        assert!(message_timestamp(f64::NAN).is_none());
        assert!(message_timestamp(f64::INFINITY).is_none());
        assert!(message_timestamp(253_402_300_800.0).is_none());
    }

    #[test]
    fn retained_unknown_message_fields_are_secret_scanned_before_publication() {
        let mut source: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        source[0]["mapping"]["n1"]["message"]["content"]["parts"] = serde_json::json!([
            "Synthetic ordinary prose about a careful design decision. ".repeat(30)
        ]);
        source[0]["mapping"]["n1"]["message"]["provider_extra"] =
            serde_json::json!({"synthetic_token": "sk-abcdefghijklmnopqrstuvwxyz012345"});
        let export = source.to_string();
        let conversation = &parse(&export).unwrap()[0];
        assert!(!conversation.to_inbox_doc().contains("sk-"));
        let plan = super::super::plan_import(
            "conversations.json",
            &export,
            &super::super::ledger::Ledger::default(),
        )
        .unwrap();
        assert!(plan.docs.is_empty());
        assert_eq!(plan.quarantined.len(), 1);
    }
}
