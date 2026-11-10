//! Proof-based equivalence of imported transcript chunks across saved revisions.
//! Unknown provenance stays distinct; source files are never changed.
use sha2::{Digest, Sha256};

fn field<'a>(value: &'a serde_json::Value, name: &str) -> Option<&'a str> {
    value.get(name)?.as_str().filter(|s| !s.trim().is_empty())
}

#[derive(Clone, Debug, serde::Serialize)]
pub(crate) struct TranscriptChunk {
    pub section: usize,
    pub turn: usize,
    pub role: String,
    pub timestamp: i64,
    pub message_id: String,
    pub key: String,
}

pub(crate) fn chunk_keys(page: &str, content: &str, chunks: &[String]) -> Vec<Option<String>> {
    let mut keys = vec![None; chunks.len()];
    if let Some(events) = transcript_chunks(page, content, chunks) {
        for event in events { keys[event.section] = Some(event.key); }
    }
    keys
}

/// A key is shared only for the same conversation, message metadata, complete
/// turn and preceding conversation history. Edited context remains evidence.
pub(crate) fn transcript_chunks(page: &str, content: &str, chunks: &[String]) -> Option<Vec<TranscriptChunk>> {
    if !page.starts_with("raw/conversations/") { return None; }
    let normalized = crate::norm::nfc(content);
    let Ok(parsed) = gray_matter::Matter::<gray_matter::engine::YAML>::new()
        .parse::<serde_json::Value>(&normalized) else { return None; };
    let Some(metadata) = parsed.data else { return None; };
    let (Some(source), Some(conversation), Some(turns)) = (
        field(&metadata, "source"), field(&metadata, "conversation_id"),
        metadata.get("turn_metadata").and_then(|v| v.as_array()),
    ) else { return None; };
    let body = parsed.content;
    let mut headers = Vec::new();
    let mut offset = 0;
    for line in body.split_inclusive('\n') {
        if crate::embeddings::is_transcript_turn_header(line) {
            headers.push((offset, line.trim().trim_matches('*').trim_end_matches(':').to_ascii_lowercase()));
        }
        offset += line.len();
    }
    if headers.is_empty() || headers.len() != turns.len() { return None; }
    let mut history = Sha256::new();
    history.update(serde_json::to_vec(&(source, conversation)).unwrap());
    let mut result = Vec::new();
    let mut section = crate::embeddings::chunk_page(&body[..headers[0].0]).len();
    let mut ids = std::collections::HashSet::new();
    for (ordinal, (start, role)) in headers.iter().enumerate() {
        let turn = &turns[ordinal];
        let (Some(id), Some(timestamp), Some(original_role)) = (
            field(turn, "message_id"), field(turn, "timestamp"), field(turn, "original_role"),
        ) else { return None; };
        if !ids.insert(id) || original_role != role || crate::importers::parse_iso8601(timestamp).is_none() {
            return None;
        }
        let end = headers.get(ordinal + 1).map_or(body.len(), |h| h.0);
        let text = body[*start..end].trim();
        let turn_chunks = crate::embeddings::chunk_page(text);
        let next = section + turn_chunks.len();
        if chunks.get(section..next) != Some(turn_chunks.as_slice()) { return None; }
        // Length-delimited serialized fields avoid concatenation ambiguity.
        // The importer can add capture provenance to an existing message.
        // This annotation describes the capture, not a change to the utterance.
        // Preserve every other metadata field (including unknown ones).
        let mut semantic_metadata = turn.clone();
        let capture_only = turn.get("session_provenance").and_then(|v| v.as_array())
            .is_some_and(|records| !records.is_empty() && records.iter().all(|record| {
                record.as_object().is_some_and(|record| record.len() == 2
                    && record.get("thread_source").and_then(|v| v.as_str()) == Some("user")
                    && matches!(record.get("source").and_then(|v| v.as_str()), Some("vscode" | "cli")))
            }));
        // Parent/fork identities, agent origins and unknown provenance remain
        // part of the key. Only known interface-only annotations are ignored.
        if capture_only { semantic_metadata.as_object_mut()?.remove("session_provenance"); }
        history.update(serde_json::to_vec(&(semantic_metadata, text)).unwrap());
        let prefix = format!("{:x}", history.clone().finalize());
        for (index, chunk) in turn_chunks.iter().enumerate() {
            result.push(TranscriptChunk {
                section: section + index, turn: ordinal, role: role.clone(),
                timestamp: crate::importers::parse_iso8601(timestamp)?, message_id: id.into(),
                key: format!("{prefix}:{index}:{:x}", Sha256::digest(chunk.as_bytes())),
            });
        }
        section = next;
    }
    if section != chunks.len() { return None; }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn document(conversation: &str, turns: &[(&str, &str, &str, &str)]) -> String {
        let metadata: Vec<_> = turns.iter().map(|(id, role, time, _)| serde_json::json!({
            "message_id":id, "original_role":role, "timestamp":time
        })).collect();
        let mut result = format!("---\nsource: fixture\nconversation_id: {conversation}\nturn_metadata: {}\n---\n# Transcript\n\n", serde_json::to_string(&metadata).unwrap());
        for (_, role, _, text) in turns {
            let display = if *role == "user" { "User" } else { "Assistant" };
            result.push_str(&format!("**{display}:**\n\n{text}\n\n"));
        }
        result
    }
    fn keys(content: &str) -> Vec<Option<String>> {
        chunk_keys("raw/conversations/fixture/test.md", content, &crate::embeddings::chunk_page(content))
    }
    #[test]
    fn append_only_revisions_share_proven_chunks() {
        let first = ("1", "user", "2026-10-01T00:00:00Z", "Keep this decision.");
        let old = document("one", &[first]);
        let new = document("one", &[first, ("2", "assistant", "2026-10-01T00:01:00Z", "Completed.")]);
        assert!(keys(&old)[1].is_some());
        assert_eq!(keys(&old), keys(&new)[..keys(&old).len()]);
    }
    #[test]
    fn changed_identity_speaker_time_and_prior_context_remain_distinct() {
        let first = ("1", "user", "2026-10-01T00:00:00Z", "Plan A.");
        let last = ("2", "assistant", "2026-10-01T00:01:00Z", "Completed.");
        let original = keys(&document("one", &[first, last]));
        for other in [
            document("two", &[first, last]),
            document("one", &[("1", "user", first.2, "Plan B."), last]),
            document("one", &[first, ("2", "user", last.2, last.3)]),
            document("one", &[first, ("2", "assistant", "2026-10-02T00:01:00Z", last.3)]),
            document("one", &[first, ("3", last.1, last.2, last.3)]),
        ] { assert_ne!(original.last(), keys(&other).last()); }
    }
    #[test]
    fn ambiguous_or_missing_metadata_never_hides_chunks() {
        let doc = document("one", &[("1", "user", "2026-10-01T00:00:00Z", "Text.")]);
        for bad in [doc.replace("message_id", "unknown"), doc.replace("Text.", "**User:**\nText."), doc.replace("2026-10-01T00:00:00Z", "unknown")] {
            assert!(keys(&bad).iter().all(Option::is_none));
        }
    }
    #[test]
    fn capture_annotation_does_not_split_identical_history_but_other_metadata_does() {
        let doc = document("one", &[("1", "user", "2026-10-01T00:00:00Z", "Text.")]);
        let annotated = doc.replace("\"message_id\":", "\"session_provenance\":[{\"source\":\"vscode\",\"thread_source\":\"user\"}],\"message_id\":");
        assert_eq!(keys(&doc), keys(&annotated));
        let forked = annotated.replace("\"thread_source\":\"user\"", "\"thread_source\":\"user\",\"forked_from_id\":\"different-parent\"");
        assert_ne!(keys(&doc), keys(&forked));
        let agent = annotated.replace("\"thread_source\":\"user\"", "\"thread_source\":\"agent\"");
        assert_ne!(keys(&doc), keys(&agent));
        let changed = doc.replace("\"message_id\":", "\"phase\":\"final_answer\",\"message_id\":");
        assert_ne!(keys(&doc), keys(&changed));
    }

    #[test]
    fn edited_qualifier_in_same_turn_preserves_shared_excerpt() {
        let body = format!("{}\n\n# Status\nCompleted, awaiting confirmation.", "A repeated paragraph. ".repeat(100));
        let old = document("one", &[("1", "assistant", "2026-10-01T00:00:00Z", &body)]);
        let new = old.replace("awaiting confirmation", "confirmed");
        assert!(keys(&old).iter().skip(1).all(Option::is_some));
        assert_ne!(keys(&old)[1], keys(&new)[1]);
    }
}
