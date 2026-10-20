//! App-owned prompts, closed-citation shape checks and literal transcripts.

use super::{DialogueTurn, Draft, Speaker};
use std::collections::BTreeSet;

const PROMPT_HEADS: &str = include_str!("../../../src/lib/mycoPromptHeads.json");

pub(super) fn system() -> Result<String, String> {
    let heads: serde_json::Value = serde_json::from_str(PROMPT_HEADS)
        .map_err(|error| format!("audio prompt heads: {error}"))?;
    let head = heads
        .get("audioOverview")
        .and_then(serde_json::Value::as_str)
        .ok_or("audio prompt head is missing")?;
    Ok(format!("{head} You turn wiki notes into a lively, accurate two-host spoken dialogue (Host A interviews Guest B). Every claim must come ONLY from the provided notes — no invention. Attach the page the claim came from to that turn's cites (copy the [[stem]] header or a [^src-*] token). Keep it conversational and about 12–20 turns. Reply with ONLY a JSON array of {{\"speaker\":\"A\"|\"B\",\"text\":string,\"cites\":string[]}}."))
}

/// Membership proves that a citation was included, not that it entails a claim.
pub(super) fn parse(raw: &str, allowed: &BTreeSet<String>) -> Result<Vec<DialogueTurn>, String> {
    if raw.len() > 256 * 1024 {
        return Err("audio dialogue exceeds the bounded output size".into());
    }
    let turns: Vec<DialogueTurn> = serde_json::from_str(raw.trim())
        .map_err(|error| format!("invalid audio dialogue JSON: {error}"))?;
    if turns.is_empty() || turns.len() > 32 {
        return Err("audio dialogue requires 1–32 turns".into());
    }
    for turn in &turns {
        if turn.text.trim().is_empty()
            || turn.text.len() > 8192
            || turn
                .text
                .chars()
                .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
            || turn.cites.len() > 32
            || turn.cites.iter().any(|cite| !allowed.contains(cite))
        {
            return Err("audio dialogue contains invalid text or an unincluded citation".into());
        }
    }
    Ok(turns)
}

pub(super) fn slug(title: &str) -> String {
    let mut slug = String::new();
    let mut separator = false;
    for character in title.trim().chars() {
        if character.is_ascii_alphanumeric() {
            if separator && !slug.is_empty() {
                slug.push('-');
            }
            slug.push(character.to_ascii_lowercase());
            separator = false;
        } else {
            separator = true;
        }
        if slug.len() >= 120 {
            break;
        }
    }
    if slug.is_empty() {
        "overview".into()
    } else {
        slug
    }
}

fn literal(text: &str) -> String {
    let mut escaped = String::new();
    for character in text.chars() {
        if matches!(
            character,
            '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>' | '#' | '!' | '|' | '~'
        ) {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

pub(super) fn transcript(draft: &Draft, date_iso: &str) -> String {
    let mut lines = vec![
        format!("# Audio Overview — {}", literal(&draft.title)), String::new(),
        format!("> Generated {date_iso} · two-host deep dive"), String::new(),
        format!("> Draft based on {} of {} selected notes. Review it against the sources before relying on it.", draft.coverage.included_pages.len(), draft.coverage.selected_pages.len()),
        String::new(), "## Sources".into(),
    ];
    for path in &draft.source_pages {
        if let Some(stem) = std::path::Path::new(path)
            .file_stem()
            .and_then(|stem| stem.to_str())
        {
            lines.push(format!("- [[{stem}]]"));
        }
    }
    lines.extend([String::new(), "## Transcript".into(), String::new()]);
    for turn in &draft.turns {
        let host = match turn.speaker {
            Speaker::A => "Host",
            Speaker::B => "Guest",
        };
        let cites = if turn.cites.is_empty() {
            String::new()
        } else {
            format!(" {}", turn.cites.join(" "))
        };
        lines.push(format!("**{host}:** {}{cites}", literal(&turn.text)));
        lines.push(String::new());
    }
    lines.join("\n")
}
