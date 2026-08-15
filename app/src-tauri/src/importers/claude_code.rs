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
//!
//! The CLI also injects its own control text INTO `user` messages that survive
//! that filter — a caveat, a `/command` invocation, its stdout — none of which
//! the user typed. A message that is nothing but that control text is dropped
//! (see `strip_injected`) before anything is counted or titled from it; a
//! message with real prose in it is kept verbatim.

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
/// image) contributes nothing. A message that is purely injected CLI wrappers
/// (`<local-command-caveat>` etc — see `strip_injected`) comes back empty, so
/// it never reaches the 800-char threshold or the title.
fn spoken_text(content: &serde_json::Value) -> String {
    if let Some(s) = content.as_str() {
        return strip_injected(s.trim());
    }
    let Some(blocks) = content.as_array() else {
        return String::new();
    };
    let joined = blocks
        .iter()
        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
        .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("\n");
    strip_injected(joined.trim())
}

/// Wrapper elements the CLI injects into a `user` message alongside (or
/// instead of) anything the user actually typed: the caveat that precedes a
/// batch of slash-command output, the `/command` invocation itself, its
/// stdout, and a `<system-reminder>` nudge. Confirmed from this machine's own
/// `~/.claude/projects/**/*.jsonl` — each shows up as a whole message on its
/// own (e.g. `<local-command-caveat>Caveat: The messages below were generated
/// by the user while running local commands...</local-command-caveat>`), which
/// is how the caveat blob ends up as a session's title. Handled generically in
/// case a future CLI version ever mixes one into a message with real text.
const INJECTED_TAGS: &[&str] = &[
    "local-command-caveat",
    "command-name",
    "command-message",
    "command-args",
    "local-command-stdout",
    "system-reminder",
];

/// All-or-nothing: `""` when `text` is nothing BUT `INJECTED_TAGS` blocks (and
/// whitespace), otherwise `text` trimmed and byte-for-byte unchanged.
///
/// On every real `~/.claude/projects/**/*.jsonl` sampled, an injected block is
/// the entire content of its user message (sometimes several concatenated) —
/// never mixed into prose. Partial stripping would therefore buy nothing real
/// while gutting any message that legitimately *quotes* these tag names, which
/// is exactly what a user debugging this CLI's output writes; a gutted message
/// can even empty out and drop, silently changing which turn titles the doc.
/// So the removal only decides whether the message was pure control text.
///
/// The tags are flat in every sample seen — no nesting — so a plain substring
/// search per tag is enough; nothing here calls for an XML parser over a fixed,
/// known set of wrapper names.
fn strip_injected(text: &str) -> String {
    let mut s = text.to_string();
    for tag in INJECTED_TAGS {
        let open = format!("<{tag}>");
        let close = format!("</{tag}>");
        while let Some(start) = s.find(&open) {
            let Some(rel_end) = s[start..].find(&close) else {
                break;
            };
            let end = start + rel_end + close.len();
            s.replace_range(start..end, "");
        }
    }
    if s.trim().is_empty() {
        String::new()
    } else {
        text.trim().to_string()
    }
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
    fn strip_injected_removes_every_known_wrapper_shape() {
        // Each shape as captured verbatim from a real `~/.claude/projects/**/*.jsonl`.
        assert_eq!(
            strip_injected("<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>"),
            ""
        );
        assert_eq!(
            strip_injected("<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>"),
            ""
        );
        assert_eq!(
            strip_injected("<local-command-stdout>Set model to \x1b[1mOpus 5\x1b[22m and saved as your default for new sessions</local-command-stdout>"),
            ""
        );
        assert_eq!(
            strip_injected(
                "<system-reminder>You used a single tool call this turn.</system-reminder>"
            ),
            ""
        );
    }

    #[test]
    fn strip_injected_leaves_a_message_that_also_holds_prose_completely_unchanged() {
        // All-or-nothing: real prose alongside a wrapper means the message was
        // never pure control text, so it is kept byte-for-byte rather than
        // partially gutted.
        let text = "<system-reminder>housekeeping</system-reminder>\n\nWhat does attention do?";
        assert_eq!(strip_injected(text), text);
    }

    #[test]
    fn strip_injected_preserves_prose_that_quotes_the_tag_names() {
        // myco's own users debug this exact CLI output, so a message ABOUT the
        // wrappers is entirely plausible — and must survive byte-for-byte.
        let prose = "Why is <system-reminder>foo</system-reminder> eating my text? \
                     I only see <command-name>/clear</command-name> in the log.";
        assert_eq!(strip_injected(prose), prose);

        let fenced = "Repro:\n\n```\n<local-command-stdout>Set model to Opus 5</local-command-stdout>\n```\n\nThat whole turn vanished.";
        assert_eq!(strip_injected(fenced), fenced);
    }

    #[test]
    fn strip_injected_drops_several_concatenated_wrapper_blocks() {
        // The observed multi-block shape: still nothing but control text.
        let text = "<local-command-caveat>Caveat: ...</local-command-caveat>\n\n<command-name>/model</command-name>\n<command-args></command-args>";
        assert_eq!(strip_injected(text), "");
    }

    #[test]
    fn strip_injected_is_a_no_op_on_ordinary_text() {
        assert_eq!(
            strip_injected("How does attention work?"),
            "How does attention work?"
        );
    }

    #[test]
    fn a_message_that_is_only_injected_text_is_dropped_and_does_not_title_the_session() {
        // The caveat and the /model command-block precede the real prompt, exactly
        // as a real session opens after a slash command. Neither must survive as a
        // turn, and the title must come from the real question, not the caveat.
        let jsonl = concat!(
            r#"{"type":"user","sessionId":"sess-2","timestamp":"2026-07-18T09:00:00.000Z","message":{"role":"user","content":"<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>"}}"#,
            "\n",
            r#"{"type":"user","sessionId":"sess-2","message":{"role":"user","content":"<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>"}}"#,
            "\n",
            r#"{"type":"user","sessionId":"sess-2","message":{"role":"user","content":"<local-command-stdout>Set model to Opus 5</local-command-stdout>"}}"#,
            "\n",
            r#"{"type":"user","sessionId":"sess-2","message":{"role":"user","content":"How does attention work?"}}"#,
            "\n",
            r#"{"type":"assistant","sessionId":"sess-2","message":{"role":"assistant","content":[{"type":"text","text":"It weights tokens by relevance."}]}}"#,
        );
        let c = parse(jsonl, "file-stem").unwrap();
        assert_eq!(
            c.turns.len(),
            2,
            "the three injected-only messages must be dropped"
        );
        assert_eq!(c.turns[0].text, "How does attention work?");
        assert_eq!(c.title, "How does attention work?");
    }

    #[test]
    fn malformed_lines_are_skipped_not_fatal() {
        let json = "not json\n{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"real\"}}\n{bad";
        let c = parse(json, "s").unwrap();
        assert_eq!(c.turns.len(), 1);
        assert_eq!(c.turns[0].text, "real");
    }
}
