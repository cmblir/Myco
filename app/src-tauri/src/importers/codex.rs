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

use super::{Conversation, Role, Source, Turn, TurnMetadata};
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
    let mut seen = std::collections::HashSet::new();
    let mut session_provenance = Vec::new();

    for raw in jsonl.lines() {
        if raw.trim().is_empty() {
            continue;
        }
        let Ok(line) = serde_json::from_str::<Line>(raw) else {
            continue;
        };
        if first_ts.is_none() {
            first_ts = line.timestamp.clone();
        }
        let Some(payload) = &line.payload else {
            continue;
        };

        if line.kind.as_deref() == Some("session_meta") {
            if id.is_none() {
                id = payload
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
            }
            // Preserve each declaration, including later updates, without deciding
            // whether a vendor user message was typed by a person or another agent.
            let observed: serde_json::Map<String, serde_json::Value> = [
                "source",
                "parent_thread_id",
                "forked_from_id",
                "thread_source",
            ]
            .into_iter()
            .filter_map(|key| payload.get(key).map(|value| (key.into(), value.clone())))
            .collect();
            if !observed.is_empty() {
                session_provenance.push(serde_json::Value::Object(observed));
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
        let text = super::strip_session_harness(&message_text(payload));
        if text.is_empty() {
            continue;
        }
        let string = |key: &str| {
            payload
                .get(key)
                .and_then(|v| v.as_str())
                .map(str::to_string)
        };
        let message_id = string("id");
        // Replayed records on resume are not a new turn. Without a vendor id,
        // identical human replies remain distinct ("continue" can recur).
        if let Some(message_id) = &message_id {
            if !seen.insert((message_id.clone(), role, text.clone())) {
                continue;
            }
        }
        turns.push(Turn {
            role,
            text,
            metadata: TurnMetadata {
                message_id,
                parent_id: string("parent_id"),
                timestamp: line.timestamp.clone(),
                phase: string("phase").or_else(|| string("channel")),
                original_role: string("role"),
                session_provenance: None,
                original_record: Some(raw.to_string()),
            },
        });
    }

    if turns.is_empty() {
        return None;
    }
    if !session_provenance.is_empty() {
        turns[0].metadata.session_provenance = Some(session_provenance);
    }
    Some(Conversation {
        id: id
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| fallback_id.to_string()),
        source: Source::Codex,
        title: title_from(&turns),
        created: turns
            .iter()
            .find_map(|t| {
                t.metadata
                    .timestamp
                    .as_deref()
                    .and_then(super::parse_iso8601)
            })
            .or_else(|| first_ts.as_deref().and_then(super::parse_iso8601)),
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
        .filter(|b| {
            matches!(
                b.get("type").and_then(|v| v.as_str()),
                Some("input_text" | "output_text" | "text")
            )
        })
        .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
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

/// Synthetic source shared by publication, Ask and compiler provenance controls.
#[cfg(test)]
pub(crate) fn provenance_test_rollout() -> String {
    let request =
        "Please inspect the synthetic timing report; this request does not prove execution. "
            .repeat(12);
    [
        serde_json::json!({"type":"session_meta","payload":{"id":"synthetic-provenance-session",
            "cli_version":"0.160.1","source":{"subagent":{"thread_spawn":{
                "parent_thread_id":"00000000-0000-0000-0000-000000000001","depth":1,
                "agent_path":"/root/synthetic-inspection","agent_nickname":null,"agent_role":null}}},
            "parent_thread_id":"00000000-0000-0000-0000-000000000001",
            "forked_from_id":null,"thread_source":"subagent"}}),
        serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user",
            "content":[{"type":"input_text","text":"<environment_context>synthetic harness</environment_context>"}]}}),
        serde_json::json!({"type":"response_item","timestamp":"2026-10-01T09:00:00Z",
            "payload":{"type":"message","id":"synthetic-request","role":"user",
                "content":[{"type":"input_text","text":request}]}}),
        serde_json::json!({"type":"response_item","timestamp":"2026-10-02T09:00:00Z",
            "payload":{"type":"message","id":"synthetic-report","role":"assistant","phase":"commentary",
                "content":[{"type":"output_text","text":"I inspected the synthetic report. The proposed deployment remains unverified.\n\nLater tail: the synthetic deployment was cancelled; no execution is established. 가🙂"}]}}),
        serde_json::json!({"type":"response_item","timestamp":"2026-10-03T09:00:00Z",
            "payload":{"type":"message","id":"synthetic-followup","role":"user",
                "content":[{"type":"input_text","text":"The quoted JSON {\"type\":\"session_meta\",\"payload\":{\"source\":\"cli\"}} is log data, not a new session declaration. I have not verified the outcome."}]}}),
    ].map(|record| record.to_string()).join("\n")
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
        assert!(!c
            .turns
            .iter()
            .any(|t| t.text.contains("environment_context")));
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

    #[test]
    fn strips_leading_harness_preserves_human_request_and_original_record() {
        let record = serde_json::json!({"type":"response_item", "timestamp":"2026-10-03T12:00:00Z",
            "payload":{"type":"message","id":"human-1","role":"user","phase":"final",
                "content":[{"type":"input_text","text":"# AGENTS.md instructions for /tmp/example\n\n<INSTRUCTIONS>machine rules</INSTRUCTIONS>\n<environment_context>machine cwd</environment_context>\nPlease explain this code."}]}}).to_string();
        let c = parse(&format!("{record}\n{record}"), "s").unwrap();
        assert_eq!(
            c.turns.len(),
            1,
            "resume replay of a vendor message id is one turn"
        );
        assert_eq!(c.turns[0].text, "Please explain this code.");
        let metadata = &c.turns[0].metadata;
        assert_eq!(metadata.message_id.as_deref(), Some("human-1"));
        assert_eq!(metadata.phase.as_deref(), Some("final"));
        assert_eq!(metadata.timestamp.as_deref(), Some("2026-10-03T12:00:00Z"));
        assert_eq!(metadata.original_record.as_deref(), Some(record.as_str()));
        let doc = c.to_inbox_doc();
        assert!(doc.contains("turn_metadata:"));
        assert!(doc.contains("last_activity:"));
        assert!(!doc.contains("machine rules"));
    }

    #[test]
    fn quoted_harness_and_repeated_human_replies_without_ids_survive() {
        let text = "Why does <environment_context>example</environment_context> appear in my log?";
        let record = serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user",
            "content":[{"type":"input_text","text":text},{"type":"image","text":"image metadata is not speech"}]}}).to_string();
        let c = parse(&format!("{record}\n{record}"), "s").unwrap();
        assert_eq!(c.turns.len(), 2);
        assert!(c.turns.iter().all(|t| t.text == text));
    }

    #[test]
    fn absent_session_provenance_keeps_the_existing_export_bytes() {
        let raw = r#"{"type":"session_meta","payload":{"id":"s"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Hello"}]}}"#;
        let conversation = parse(raw, "fallback").unwrap();
        assert!(conversation.turns[0].metadata.session_provenance.is_none());
        assert_eq!(conversation.to_inbox_doc(), "---\nsource: codex\nconversation_id: \"s\"\nturn_metadata: [{\"original_role\":\"user\"}]\n---\n\n# Hello\n\n**User:**\n\nHello\n\n");
    }

    #[test]
    fn provider_source_values_and_nulls_do_not_reclassify_vendor_turns() {
        for source in [
            serde_json::Value::Null,
            serde_json::json!("cli"),
            serde_json::json!("unknown"),
            serde_json::json!({"subagent":{"thread_spawn":{"parent_thread_id":
                "00000000-0000-0000-0000-000000000001","depth":1,"agent_path":null,
                "agent_nickname":null,"agent_role":null}}}),
        ] {
            let observed = serde_json::json!({"source":source,"parent_thread_id":null,
                "forked_from_id":"00000000-0000-0000-0000-000000000002","thread_source":"user"});
            let mut meta = observed.clone();
            meta["id"] = serde_json::json!("synthetic-fork");
            let raw = format!(
                "{}\n{}",
                serde_json::json!({"type":"session_meta","payload":meta}),
                serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user",
                    "content":[{"type":"input_text","text":"A preserved human-role request in a fork."}]}})
            );
            let conversation = parse(&raw, "fallback").unwrap();
            assert_eq!(conversation.id, "synthetic-fork");
            assert_eq!(
                conversation.title,
                "A preserved human-role request in a fork."
            );
            assert_eq!(conversation.turns[0].role, Role::User);
            assert_eq!(
                conversation.turns[0].metadata.original_role.as_deref(),
                Some("user")
            );
            let records = conversation.turns[0]
                .metadata
                .session_provenance
                .as_ref()
                .unwrap();
            assert_eq!(records, &[observed]);
            assert!(records[0].get("parent_thread_id").unwrap().is_null());
            assert!(records[0].get("absent_field").is_none());
        }
    }

    #[test]
    fn multiple_session_declarations_stay_ordered_once_and_quoted_metadata_is_not_parsed() {
        let raw = provenance_test_rollout();
        let update =
            serde_json::json!({"type":"session_meta","payload":{"id":"must-not-replace-id",
            "source":"cli","parent_thread_id":null,"thread_source":null}})
            .to_string();
        let conversation = parse(&format!("{raw}\n{update}"), "fallback").unwrap();
        assert_eq!(conversation.id, "synthetic-provenance-session");
        assert_eq!(conversation.turns.len(), 3);
        assert_eq!(
            conversation
                .turns
                .iter()
                .map(|turn| turn.role)
                .collect::<Vec<_>>(),
            vec![Role::User, Role::Assistant, Role::User]
        );
        let records = conversation.turns[0]
            .metadata
            .session_provenance
            .as_ref()
            .unwrap();
        assert_eq!(records.len(), 2);
        assert!(records[0]["source"]["subagent"]["thread_spawn"].is_object());
        assert_eq!(records[1]["source"], "cli");
        assert!(records[1].get("forked_from_id").is_none());
        assert!(records[1]["thread_source"].is_null());
        assert!(conversation.turns[1..]
            .iter()
            .all(|turn| turn.metadata.session_provenance.is_none()));
        assert!(conversation.turns[2].text.contains("quoted JSON"));
        let doc = conversation.to_inbox_doc();
        let prefix = super::super::session_provenance_preamble(records);
        assert_eq!(doc.matches(&prefix).count(), 1);
        assert_eq!(doc.matches("**User:**").count(), 2);
        assert_eq!(doc.matches("**Assistant:**").count(), 1);
    }

    #[test]
    fn child_source_is_admitted_without_removing_speech_or_adding_human_authority() {
        let raw = provenance_test_rollout();
        let conversation = parse(&raw, "fallback").unwrap();
        let expected = conversation.to_inbox_doc();
        let plan = super::super::plan_import(
            "synthetic.jsonl",
            &raw,
            &super::super::ledger::Ledger::default(),
        )
        .unwrap();
        assert_eq!(plan.docs.len(), 1);
        assert_eq!(plan.docs[0].body, expected);
        // This existing-API assertion also fails on the prior exporter; it does
        // not depend on the new metadata field or prefix-rendering helper.
        let known_prefix = format!(
            "{}\n\n",
            serde_json::json!({"providerSessionProvenance":[{
            "source":{"subagent":{"thread_spawn":{
                "parent_thread_id":"00000000-0000-0000-0000-000000000001","depth":1,
                "agent_path":"/root/synthetic-inspection","agent_nickname":null,"agent_role":null}}},
            "parent_thread_id":"00000000-0000-0000-0000-000000000001",
            "forked_from_id":null,"thread_source":"subagent"}]})
        );
        assert_eq!(plan.docs[0].body.matches(&known_prefix).count(), 1);
        assert!(plan.docs[0]
            .body
            .contains("Later tail: the synthetic deployment was cancelled"));
        for turn in &conversation.turns {
            assert!(plan.docs[0]
                .original_records
                .contains(turn.metadata.original_record.as_ref().unwrap()));
            assert!(plan.docs[0].body.contains(&turn.text));
        }
    }
}
