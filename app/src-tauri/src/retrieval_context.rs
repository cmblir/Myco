//! Source-verified context around accepted transcript evidence, across revisions.
use crate::{
    commands::{DateRange, ScoredChunk},
    embeddings,
    local_synthesis::guided_question::GuidedIntent,
    retrieval::{Bm25Index, Scope},
    retrieval_revisions::{transcript_chunks, TranscriptChunk},
};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

#[derive(Clone, Debug, Serialize)]
pub struct RelatedPassage {
    pub page: String,
    pub stem: String,
    pub section: usize,
    pub text: String,
    pub source_revision: String,
    pub role: String,
    pub timestamp: i64,
    pub message_id: String,
    pub relation: String,
    pub anchor_page: String,
    pub anchor_section: usize,
}
#[derive(Clone, Debug, Default, Serialize)]
pub struct RelatedContext {
    pub passages: Vec<RelatedPassage>,
    pub incomplete: bool,
    pub scanned_pages: usize,
    /// Verified source identities balance revisions as one conversation; no text is deduplicated here.
    pub source_groups: std::collections::BTreeMap<String, String>,
}
struct Source {
    page: String,
    identity: (String, String),
    revision: String,
    chunks: Vec<String>,
    events: Vec<TranscriptChunk>,
}
fn identity(content: &str) -> Option<(String, String)> {
    let parsed = gray_matter::Matter::<gray_matter::engine::YAML>::new()
        .parse::<serde_json::Value>(content)
        .ok()?;
    let data = parsed.data?;
    Some((
        data.get("source")?.as_str()?.to_owned(),
        data.get("conversation_id")?.as_str()?.to_owned(),
    ))
}
fn source(page: &str, content: &str, index: &Bm25Index) -> Option<Source> {
    let chunks = embeddings::chunk_page(content);
    let hashes: Vec<_> = chunks.iter().map(|c| embeddings::content_hash(c)).collect();
    if index.page_hashes(page).as_ref() != Some(&hashes) {
        return None;
    }
    Some(Source {
        page: page.into(),
        identity: identity(content)?,
        revision: crate::importers::wikify::source_revision(content),
        events: transcript_chunks(page, content, &chunks)?,
        chunks,
    })
}
fn passage(
    src: &Source,
    event: &TranscriptChunk,
    relation: &str,
    anchor: (&str, usize),
) -> RelatedPassage {
    RelatedPassage {
        page: src.page.clone(),
        stem: Path::new(&src.page)
            .file_stem()
            .unwrap()
            .to_string_lossy()
            .into(),
        section: event.section,
        text: src.chunks[event.section].clone(),
        source_revision: src.revision.clone(),
        role: event.role.clone(),
        timestamp: event.timestamp,
        message_id: event.message_id.clone(),
        relation: relation.into(),
        anchor_page: anchor.0.into(),
        anchor_section: anchor.1,
    }
}
fn bounds(range: Option<&DateRange>) -> Option<(i64, i64)> {
    let Some(r) = range else {
        return Some((i64::MIN, i64::MAX));
    };
    match (r.start_epoch, r.end_epoch) {
        (Some(a), Some(b)) if a < b => Some((a, b)),
        (None, None) => {
            let a = crate::importers::parse_iso8601(&format!("{}T00:00:00Z", r.start))?;
            let b = crate::importers::parse_iso8601(&format!("{}T00:00:00Z", r.end))?
                .checked_add(86400)?;
            (a < b).then_some((a, b))
        }
        _ => None,
    }
}
/// Only callers' already accepted hits may anchor context. Related passages
/// carry a relationship, never an invented cosine or independent relevance claim.
// ponytail: no caller since the round4 retrieval path; kept until it is
// confirmed unneeded, then delete it.
#[allow(dead_code)]
pub(crate) fn retrieve(
    root: &Path,
    index: &Bm25Index,
    anchors: &[ScoredChunk],
    range: Option<&DateRange>,
    scope: Scope,
    paths: Option<&[String]>,
    query: &str,
) -> RelatedContext {
    retrieve_with_cutoff(root, index, anchors, range, scope, paths, query, None, None)
}

/// Historical results include verified accepted originals as well as adjacent
/// turns, so callers never need to promote an untyped hit into dated evidence.
/// An explicit selected-question intent decides the state-first ordering;
/// the retrieval query alone may be a bare subject with no such cue.
#[allow(clippy::too_many_arguments)]
pub(crate) fn retrieve_with_cutoff(
    root: &Path,
    index: &Bm25Index,
    anchors: &[ScoredChunk],
    range: Option<&DateRange>,
    scope: Scope,
    paths: Option<&[String]>,
    query: &str,
    as_of_end: Option<i64>,
    intent: Option<&GuidedIntent>,
) -> RelatedContext {
    let mut result = RelatedContext::default();
    let Ok(canonical_root) = root.canonicalize() else {
        result.incomplete = true;
        return result;
    };
    let root = canonical_root.as_path();
    let Some((start, mut end)) = bounds(range) else {
        result.incomplete = true;
        return result;
    };
    if let Some(cutoff) = as_of_end {
        end = end.min(cutoff);
    }
    if start >= end {
        return result;
    }
    let keeps = |page: &str| {
        page.starts_with("raw/conversations/")
            && scope.keeps(page)
            && !crate::vector_index::is_cold(page)
            && paths.is_none_or(|paths| paths.iter().any(|p| p == page))
    };
    let read = |page: &str| -> Option<String> {
        let path = crate::vault::confine_path(root, &root.join(page).to_string_lossy()).ok()?;
        if std::fs::metadata(&path).ok()?.len() > 2 * 1024 * 1024 {
            return None;
        }
        std::fs::read_to_string(path).ok()
    };
    // Four conversation groups; multiple anchors in one group share its budget.
    type Group = ((String, String), Vec<(String, usize, String)>);
    let mut groups: Vec<Group> = Vec::new();
    let mut sources = HashMap::new();
    for anchor in anchors.iter().filter(|a| keeps(&a.page)) {
        if !sources.contains_key(&anchor.page) {
            let loaded = read(&anchor.page).and_then(|text| source(&anchor.page, &text, index));
            sources.insert(anchor.page.clone(), loaded);
        }
        let Some(Some(src)) = sources.get(&anchor.page) else {
            result.incomplete = true;
            continue;
        };
        if src.chunks.get(anchor.section) != Some(&anchor.text) {
            result.incomplete = true;
            continue;
        }
        let Some(event) = src
            .events
            .iter()
            .find(|e| e.section == anchor.section && start <= e.timestamp && e.timestamp < end)
        else {
            continue;
        };
        // Every verified historical original keeps its own dated proof. The
        // group and neighbor-slot caps below bound optional context only; they
        // must never turn an accepted anchor into date-unverified evidence.
        if as_of_end.is_some() {
            result.passages.push(passage(
                src,
                event,
                "accepted_original",
                (anchor.page.as_str(), anchor.section),
            ));
        }
        let group = groups.iter().position(|(id, _)| id == &src.identity);
        let i = match group {
            Some(i) => i,
            None if groups.len() < 4 => {
                groups.push((src.identity.clone(), Vec::new()));
                groups.len() - 1
            }
            None => {
                result.incomplete = true;
                continue;
            }
        };
        if groups[i].1.len() < 2 {
            groups[i]
                .1
                .push((anchor.page.clone(), anchor.section, event.key.clone()));
        } else {
            result.incomplete = true;
        }
    }
    if groups.is_empty() {
        return result;
    }
    // Scan the indexed corpus, not guessed filenames or filesystem modification times.
    let mut pages: Vec<_> = index.page_names().filter(|p| keeps(p)).collect();
    pages.sort_unstable();
    let mut bytes = 0;
    for page in pages {
        if result.scanned_pages >= 2048 || bytes >= 64 * 1024 * 1024 {
            result.incomplete = true;
            break;
        }
        result.scanned_pages += 1;
        if sources.contains_key(page) {
            continue;
        }
        let Some(content) = read(page) else {
            result.incomplete = true;
            continue;
        };
        bytes += content.len();
        if !identity(&content).is_some_and(|id| groups.iter().any(|(wanted, _)| wanted == &id)) {
            continue;
        }
        let loaded = source(page, &content, index);
        if loaded.is_none() {
            result.incomplete = true;
        }
        sources.insert(page.into(), loaded);
    }
    let query = query.to_lowercase();
    let state_query = matches!(
        intent,
        Some(GuidedIntent::Progress | GuidedIntent::Remaining)
    ) || [
        "남은",
        "어디까지",
        "현재 상태",
        "진행 상황",
        "remaining",
        "status",
        "progress",
    ]
    .iter()
    .any(|word| query.contains(word));
    let mut used_chars = 0;
    for (id, anchors) in groups {
        // Shared full-prefix message keys prove lineage. A matching conversation
        // ID alone cannot connect an edited earlier branch to an accepted anchor.
        let mut candidates: HashMap<String, (RelatedPassage, bool, usize)> = HashMap::new();
        let mut ordered: Vec<_> = sources
            .values()
            .flatten()
            .filter(|s| s.identity == id)
            .collect();
        ordered.sort_by(|a, b| a.page.cmp(&b.page));
        for src in ordered {
            for (anchor_page, anchor_section, key) in &anchors {
                let Some(anchor) = src.events.iter().find(|e| &e.key == key) else {
                    continue;
                };
                let mut latest: Vec<_> = src
                    .events
                    .iter()
                    .filter(|e| start <= e.timestamp && e.timestamp < end)
                    .map(|e| (e.timestamp, e.turn))
                    .collect();
                latest.sort_unstable();
                latest.dedup();
                let tail: HashSet<_> = latest.iter().rev().take(4).map(|(_, t)| *t).collect();
                // A run of progress messages must not hide the previous answer.
                // Keep the last two user-led exchanges, including their boundary
                // answer; selection still obeys timestamp and character budgets.
                let mut user_turns: Vec<_> = src
                    .events
                    .iter()
                    .filter(|e| e.role == "user" && start <= e.timestamp && e.timestamp < end)
                    .map(|e| e.turn)
                    .collect();
                user_turns.sort_unstable();
                user_turns.dedup();
                let exchange_start = user_turns
                    .iter()
                    .rev()
                    .take(2)
                    .next_back()
                    .map(|t| t.saturating_sub(1));
                for event in src
                    .events
                    .iter()
                    .filter(|e| start <= e.timestamp && e.timestamp < end)
                {
                    let distance = event.turn.abs_diff(anchor.turn);
                    let near = distance <= 2;
                    if !near
                        && !tail.contains(&event.turn)
                        && !exchange_start.is_some_and(|first| event.turn >= first)
                    {
                        continue;
                    }
                    // Accepted originals are already in the result (free questions
                    // hold the untyped hit; historical ones its proof above).
                    if anchors.iter().any(|(_, _, key)| key == &event.key) {
                        continue;
                    }
                    let passage = passage(
                        src,
                        event,
                        if near {
                            "adjacent_turn"
                        } else {
                            "recent_exchange"
                        },
                        (anchor_page.as_str(), *anchor_section),
                    );
                    let entry = candidates.entry(event.key.clone()).or_insert((
                        passage.clone(),
                        near,
                        distance,
                    ));
                    if near && (!entry.1 || distance < entry.2) {
                        *entry = (passage, near, distance);
                    }
                }
            }
        }
        let mut candidates: Vec<_> = candidates.into_values().collect();
        candidates.sort_by(|a, b| {
            if state_query {
                b.0.timestamp
                    .cmp(&a.0.timestamp)
                    .then_with(|| a.0.section.cmp(&b.0.section))
            } else {
                b.1.cmp(&a.1)
                    .then_with(|| a.2.cmp(&b.2))
                    .then_with(|| b.0.timestamp.cmp(&a.0.timestamp))
                    .then_with(|| a.0.page.cmp(&b.0.page))
                    .then_with(|| a.0.section.cmp(&b.0.section))
            }
        });
        if candidates.len() > 8 {
            result.incomplete = true;
        }
        // Preserve the relevance/state priority between turns, but give every
        // distinct recorded utterance a first slot before returning for its
        // later chunks. Otherwise a single long assistant proposal can evict
        // the adjacent user's correction from this bounded context entirely.
        // Keep source page identity: edits/branches with the same message ID
        // must not be silently merged by this presentation budget.
        let mut turns: Vec<Vec<RelatedPassage>> = Vec::new();
        let mut turn_slots: HashMap<(String, String), usize> = HashMap::new();
        for (passage, _, _) in candidates {
            let identity = (passage.page.clone(), passage.message_id.clone());
            let next = turns.len();
            let slot = *turn_slots.entry(identity).or_insert_with(|| {
                turns.push(Vec::new());
                next
            });
            turns[slot].push(passage);
        }
        let mut balanced = Vec::new();
        for depth in 0..turns.iter().map(Vec::len).max().unwrap_or(0) {
            for turn in &turns {
                if let Some(passage) = turn.get(depth) {
                    balanced.push(passage.clone());
                }
            }
        }
        for passage in balanced.into_iter().take(8) {
            let length = passage.text.chars().count();
            // Never cut the qualifier off an excerpt to meet a budget.
            if used_chars + length > 24000 {
                result.incomplete = true;
                continue;
            }
            used_chars += length;
            result.passages.push(passage);
        }
    }
    for page in anchors
        .iter()
        .map(|hit| hit.page.as_str())
        .chain(result.passages.iter().map(|hit| hit.page.as_str()))
    {
        if let Some(Some(src)) = sources.get(page) {
            result.source_groups.insert(
                page.into(),
                serde_json::to_string(&src.identity).expect("identity tuple serializes"),
            );
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn doc(turns: &[(&str, &str, &str)]) -> String {
        let metadata: Vec<_> = turns.iter().map(|(id,time,_)| serde_json::json!({"message_id":id,"timestamp":time,"original_role":"user"})).collect();
        let mut body = format!(
            "---\nsource: fixture\nconversation_id: one\nturn_metadata: {}\n---\n",
            serde_json::to_string(&metadata).unwrap()
        );
        for (_, _, text) in turns {
            body.push_str(&format!("**User:**\n\n{text}\n\n"));
        }
        body
    }
    fn add(root: &Path, index: &mut Bm25Index, page: &str, body: &str) -> ScoredChunk {
        let path = root.join(page);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
        let chunks = embeddings::chunk_page(body);
        index.upsert_page(page, page, &chunks);
        ScoredChunk {
            page: page.into(),
            stem: page.into(),
            section: 0,
            text: chunks[0].clone(),
            score: 1.0,
            score_rrf: 1.0,
            score_final: 1.0,
            tier: crate::retrieval::Tier::Source,
            prior: 1.0,
            rank_change: 0,
            similarity: Some(0.6),
            exact_match: false,
        }
    }
    #[test]
    fn related_revision_finds_later_state_and_preserves_actual_source_identity() {
        let dir = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        let first = ("a", "2026-10-01T00:00:00Z", "Please ship Alpha.");
        let anchor = add(
            dir.path(),
            &mut index,
            "raw/conversations/old.md",
            &doc(&[first]),
        );
        add(
            dir.path(),
            &mut index,
            "raw/conversations/arbitrary-new-name.md",
            &doc(&[
                first,
                ("b", "2026-10-02T00:00:00Z", "Alpha shipped; audit remains."),
            ]),
        );
        let result = retrieve(
            dir.path(),
            &index,
            &[anchor],
            None,
            Scope::All,
            None,
            "remaining status",
        );
        assert_eq!(result.passages.len(), 1);
        let p = &result.passages[0];
        assert!(p.text.contains("audit remains"));
        assert_eq!(p.role, "user");
        assert_eq!(
            result.source_groups.get(&p.page),
            result.source_groups.get(&p.anchor_page)
        );
        assert!(result.source_groups.contains_key(&p.page));
        assert_eq!(p.anchor_page, "raw/conversations/old.md");
        assert_eq!(p.message_id, "b");
        assert!(!p.source_revision.is_empty());
    }
    #[test]
    fn date_scope_explicit_paths_and_edited_ancestry_do_not_leak_context() {
        let dir = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        let first = ("a", "2026-10-01T00:00:00Z", "Please ship Alpha.");
        let anchor = add(
            dir.path(),
            &mut index,
            "raw/conversations/old.md",
            &doc(&[first]),
        );
        add(
            dir.path(),
            &mut index,
            "raw/conversations/new.md",
            &doc(&[first, ("b", "2026-10-02T00:00:00Z", "Alpha shipped.")]),
        );
        add(
            dir.path(),
            &mut index,
            "raw/conversations/edited.md",
            &doc(&[
                ("a", first.1, "Do not ship Alpha."),
                ("b", first.1, "Different branch."),
            ]),
        );
        let range = DateRange {
            start: "2026-10-01".into(),
            end: "2026-10-01".into(),
            start_epoch: None,
            end_epoch: None,
        };
        assert!(retrieve(
            dir.path(),
            &index,
            std::slice::from_ref(&anchor),
            Some(&range),
            Scope::All,
            None,
            "status"
        )
        .passages
        .is_empty());
        assert!(retrieve(
            dir.path(),
            &index,
            std::slice::from_ref(&anchor),
            None,
            Scope::Wiki,
            None,
            "status"
        )
        .passages
        .is_empty());
        assert!(retrieve(
            dir.path(),
            &index,
            std::slice::from_ref(&anchor),
            None,
            Scope::All,
            Some(std::slice::from_ref(&anchor.page)),
            "status"
        )
        .passages
        .is_empty());
        std::fs::write(
            dir.path().join("raw/conversations/new.md"),
            doc(&[first, ("b", first.1, "Unindexed change.")]),
        )
        .unwrap();
        let stale = retrieve(
            dir.path(),
            &index,
            &[anchor],
            None,
            Scope::All,
            None,
            "status",
        );
        assert!(stale.passages.is_empty());
        assert!(stale.incomplete);
    }
    #[test]
    fn progress_messages_do_not_hide_the_previous_exchange_answer() {
        let dir = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        let messages = [
            ("a", "user", "Ship Alpha."),
            ("b", "assistant", "Alpha shipped; audit remains."),
            ("c", "user", "Review the system."),
            ("d", "assistant", "Review started."),
            ("e", "assistant", "Checking storage."),
            ("f", "assistant", "Checking search."),
            ("g", "assistant", "Checking summaries."),
        ];
        let make = |items: &[(&str, &str, &str)]| {
            let meta:Vec<_>=items.iter().enumerate().map(|(i,(id,role,_))|serde_json::json!({"message_id":id,"original_role":role,"timestamp":format!("2026-10-01T00:00:{i:02}Z")})).collect();
            let mut body = format!(
                "---\nsource: fixture\nconversation_id: one\nturn_metadata: {}\n---\n",
                serde_json::to_string(&meta).unwrap()
            );
            for (_, role, text) in items {
                body.push_str(&format!(
                    "**{}:**\n\n{text}\n\n",
                    if *role == "user" { "User" } else { "Assistant" }
                ));
            }
            body
        };
        let anchor = add(
            dir.path(),
            &mut index,
            "raw/conversations/old.md",
            &make(&messages[..1]),
        );
        add(
            dir.path(),
            &mut index,
            "raw/conversations/new.md",
            &make(&messages),
        );
        let r = retrieve(
            dir.path(),
            &index,
            &[anchor],
            None,
            Scope::All,
            None,
            "remaining status",
        );
        assert!(r
            .passages
            .iter()
            .any(|p| p.text.contains("Alpha shipped; audit remains.")));
        assert!(r
            .passages
            .iter()
            .any(|p| p.text.contains("Review the system.")));
        assert!(r
            .passages
            .iter()
            .any(|p| p.text.contains("Checking summaries.")));
    }

    #[test]
    fn long_assistant_turn_cannot_displace_the_users_adjacent_correction() {
        let dir = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        let long = (0..20)
            .map(|i| {
                format!(
                    "Option {i}: {}",
                    "Build a game with interactive stages. ".repeat(30)
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        let messages = [
            ("request", "user", "Explain the project direction."),
            ("proposal", "assistant", long.as_str()),
            (
                "correction",
                "user",
                "No. Keep the documentary direction; the game idea was a misunderstanding.",
            ),
            ("ack", "assistant", "Acknowledged: documentary, not a game."),
        ];
        let meta:Vec<_>=messages.iter().enumerate().map(|(i,(id,role,_))|serde_json::json!({"message_id":id,"original_role":role,"timestamp":format!("2026-10-01T00:00:{i:02}Z")})).collect();
        let mut body = format!(
            "---\nsource: fixture\nconversation_id: one\nturn_metadata: {}\n---\n",
            serde_json::to_string(&meta).unwrap()
        );
        for (_, role, text) in messages {
            body.push_str(&format!(
                "**{}:**\n\n{text}\n\n",
                if role == "user" { "User" } else { "Assistant" }
            ));
        }
        let page = "raw/conversations/multi-chunk.md";
        let template = add(dir.path(), &mut index, page, &body);
        let chunks = embeddings::chunk_page(&body);
        let events = transcript_chunks(page, &body, &chunks).unwrap();
        assert!(events.iter().filter(|e| e.message_id == "proposal").count() > 8);
        let anchors: Vec<_> = ["ack", "proposal"]
            .iter()
            .map(|id| {
                let section = events.iter().find(|e| e.message_id == *id).unwrap().section;
                ScoredChunk {
                    section,
                    text: chunks[section].clone(),
                    ..template.clone()
                }
            })
            .collect();
        let r = retrieve(
            dir.path(),
            &index,
            &anchors,
            None,
            Scope::All,
            None,
            "Why was this direction chosen?",
        );
        assert!(
            r.passages
                .iter()
                .any(|p| p.message_id == "correction" && p.text.contains("misunderstanding")),
            "user correction must survive a long adjacent assistant turn"
        );
        assert!(r.passages.len() <= 8);
        assert!(r.incomplete);
    }

    #[test]
    fn no_anchor_no_context_and_budget_omission_is_explicit() {
        let dir = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        assert!(
            retrieve(dir.path(), &index, &[], None, Scope::All, None, "status")
                .passages
                .is_empty()
        );
        let first = ("a", "2026-10-01T00:00:00Z", "Please ship Alpha.");
        let mut turns = vec![first];
        let texts: Vec<String> = (0..20)
            .map(|i| format!("Long evidence {i}. {}", "Keep the qualifier. ".repeat(100)))
            .collect();
        let ids: Vec<String> = (0..20).map(|i| format!("id{i}")).collect();
        for i in 0..20 {
            turns.push((&ids[i], "2026-10-02T00:00:00Z", &texts[i]));
        }
        let anchor = add(
            dir.path(),
            &mut index,
            "raw/conversations/full.md",
            &doc(&turns),
        );
        let r = retrieve(
            dir.path(),
            &index,
            &[anchor],
            None,
            Scope::All,
            None,
            "status",
        );
        assert!(r.incomplete);
        assert!(r.passages.len() <= 8);
        assert!(
            r.passages
                .iter()
                .map(|p| p.text.chars().count())
                .sum::<usize>()
                <= 24000
        );
    }
    #[test]
    fn historical_context_returns_verified_anchor_and_no_later_turn() {
        let dir = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        let body = doc(&[
            ("earlier", "2026-09-01T00:00:00Z", "EARLIER_ORIGINAL"),
            ("anchor", "2026-10-08T12:00:00Z", "ACCEPTED_ORIGINAL"),
            ("later", "2026-10-09T00:00:00Z", "FUTURE_TURN"),
        ]);
        let page = "raw/conversations/historical.md";
        let template = add(dir.path(), &mut index, page, &body);
        let chunks = embeddings::chunk_page(&body);
        let event = transcript_chunks(page, &body, &chunks)
            .unwrap()
            .into_iter()
            .find(|e| e.message_id == "anchor")
            .unwrap();
        let anchor = ScoredChunk {
            section: event.section,
            text: chunks[event.section].clone(),
            ..template
        };
        let cutoff = crate::importers::parse_iso8601("2026-10-09T00:00:00Z").unwrap();
        let found = retrieve_with_cutoff(
            dir.path(),
            &index,
            &[anchor],
            None,
            Scope::All,
            None,
            "status",
            Some(cutoff),
            None,
        );
        assert!(found.passages.iter().any(|p| p.message_id == "anchor"
            && p.relation == "accepted_original"
            && p.role == "user"));
        assert!(found.passages.iter().any(|p| p.message_id == "earlier"));
        assert!(found
            .passages
            .iter()
            .all(|p| p.timestamp < cutoff && !p.text.contains("FUTURE_TURN")));
    }

    #[test]
    fn explicit_progress_intent_orders_latest_state_ahead_of_adjacent_turns() {
        // Twelve dated turns, anchors at turns 0 and 5, and a subject-only
        // query with no state keyword: ten context candidates for eight slots.
        let dir = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        let ids: Vec<String> = (0..12).map(|i| format!("t{i}")).collect();
        let times: Vec<String> = (0..12)
            .map(|i| format!("2026-10-01T00:00:{i:02}Z"))
            .collect();
        let texts: Vec<String> = (0..12).map(|i| format!("Topic statement {i}.")).collect();
        let turns: Vec<(&str, &str, &str)> = (0..12)
            .map(|i| (ids[i].as_str(), times[i].as_str(), texts[i].as_str()))
            .collect();
        let page = "raw/conversations/progress.md";
        let body = doc(&turns);
        let template = add(dir.path(), &mut index, page, &body);
        let chunks = embeddings::chunk_page(&body);
        let events = transcript_chunks(page, &body, &chunks).unwrap();
        let anchors: Vec<_> = [0usize, 5]
            .iter()
            .map(|t| {
                let e = events.iter().find(|e| e.turn == *t).unwrap();
                ScoredChunk {
                    section: e.section,
                    text: chunks[e.section].clone(),
                    ..template.clone()
                }
            })
            .collect();
        let texts_of = |intent: Option<&GuidedIntent>| {
            retrieve_with_cutoff(
                dir.path(),
                &index,
                &anchors,
                None,
                Scope::All,
                None,
                "topic subject",
                None,
                intent,
            )
            .passages
            .iter()
            .map(|p| p.text.clone())
            .collect::<Vec<_>>()
        };
        // Without the intent, anchor distance ranks the slots and the two
        // latest turns fall out; the explicit progress intent keeps them.
        let adjacent = texts_of(None);
        assert!(
            adjacent.iter().any(|t| t.contains("statement 1."))
                && !adjacent.iter().any(|t| t.contains("statement 11."))
        );
        let latest = texts_of(Some(&GuidedIntent::Progress));
        assert!(
            latest.iter().any(|t| t.contains("statement 11."))
                && latest.iter().any(|t| t.contains("statement 10."))
        );
        assert!(!latest.iter().any(|t| t.contains("statement 1.")));
        // Decision and recall keep the adjacent-turn ordering.
        assert_eq!(texts_of(Some(&GuidedIntent::Decision)), adjacent);
    }

    #[test]
    fn every_verified_historical_anchor_keeps_its_proof_beyond_group_and_slot_caps() {
        // Six conversations x three accepted originals: more than the four
        // context groups and the two anchors each group may expand.
        let dir = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        let mut anchors = Vec::new();
        for c in 0..6 {
            let ids: Vec<String> = (0..3).map(|t| format!("c{c}t{t}")).collect();
            let texts: Vec<String> = (0..3)
                .map(|t| format!("Conversation {c} original statement {t}."))
                .collect();
            let turns: Vec<(&str, &str, &str)> = (0..3)
                .map(|t| (ids[t].as_str(), "2026-10-01T00:00:00Z", texts[t].as_str()))
                .collect();
            let page = format!("raw/conversations/c{c}.md");
            let body = doc(&turns).replace(
                "conversation_id: one",
                &format!("conversation_id: conv-{c}"),
            );
            let template = add(dir.path(), &mut index, &page, &body);
            let chunks = embeddings::chunk_page(&body);
            for e in transcript_chunks(&page, &body, &chunks).unwrap() {
                anchors.push(ScoredChunk {
                    section: e.section,
                    text: chunks[e.section].clone(),
                    ..template.clone()
                });
            }
        }
        assert_eq!(anchors.len(), 18);
        let cutoff = crate::importers::parse_iso8601("2026-10-02T00:00:00Z").unwrap();
        let found = retrieve_with_cutoff(
            dir.path(),
            &index,
            &anchors,
            None,
            Scope::All,
            None,
            "subject only",
            Some(cutoff),
            None,
        );
        for anchor in &anchors {
            assert!(
                found.passages.iter().any(|p| p.page == anchor.page
                    && p.section == anchor.section
                    && p.relation == "accepted_original"
                    && p.anchor_page == anchor.page
                    && p.anchor_section == anchor.section),
                "missing proof for {}#{}",
                anchor.page,
                anchor.section
            );
        }
        // Neighboring context beyond the caps is still omitted, and said so.
        assert!(found.incomplete);
    }

    /// Read-only diagnostic over a real vault and its published lexical index.
    /// MYCO_GUIDED_PROBE=<cases.json> cargo test --lib real_vault_guided_anchors_keep_their_proofs -- --ignored --nocapture
    /// The JSON lists {vault, cases:[{name,intent,subject,as_of_end_epoch,anchors:[{page,section,textSha256}]}]}.
    #[test]
    #[ignore]
    fn real_vault_guided_anchors_keep_their_proofs() {
        use sha2::Digest;
        let Ok(spec) = std::env::var("MYCO_GUIDED_PROBE") else {
            return;
        };
        let spec: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(spec).unwrap()).unwrap();
        let root = std::path::PathBuf::from(spec["vault"].as_str().unwrap());
        let pair = tauri::async_runtime::block_on(crate::index_publication::snapshot(root.clone()))
            .unwrap();
        let index = &pair.lexical;
        let mut report = Vec::new();
        for case in spec["cases"].as_array().unwrap() {
            let intent: GuidedIntent = serde_json::from_value(case["intent"].clone()).unwrap();
            let end = case["as_of_end_epoch"].as_i64().unwrap();
            let (mut anchors, mut text_mismatch, mut stale_index) = (Vec::new(), 0usize, 0usize);
            for a in case["anchors"].as_array().unwrap() {
                let page = a["page"].as_str().unwrap();
                let section = a["section"].as_u64().unwrap() as usize;
                let content = std::fs::read_to_string(root.join(page)).unwrap();
                let chunks = embeddings::chunk_page(&content);
                let hashes: Vec<_> = chunks.iter().map(|c| embeddings::content_hash(c)).collect();
                if index.page_hashes(page).as_deref() != Some(hashes.as_slice()) {
                    stale_index += 1;
                }
                let text = chunks[section].clone();
                if format!("{:x}", sha2::Sha256::digest(text.as_bytes()))
                    != a["textSha256"].as_str().unwrap()
                {
                    text_mismatch += 1;
                }
                anchors.push(ScoredChunk {
                    page: page.into(),
                    stem: Path::new(page)
                        .file_stem()
                        .unwrap()
                        .to_string_lossy()
                        .into(),
                    section,
                    text,
                    score: 1.0,
                    score_rrf: 1.0,
                    score_final: 1.0,
                    tier: crate::retrieval::Tier::Source,
                    prior: 1.0,
                    rank_change: 0,
                    similarity: Some(0.6),
                    exact_match: false,
                });
            }
            let subject = case["subject"].as_str().unwrap();
            let before = retrieve_with_cutoff(
                &root,
                index,
                &anchors,
                None,
                Scope::All,
                None,
                subject,
                Some(end),
                None,
            );
            let after = retrieve_with_cutoff(
                &root,
                index,
                &anchors,
                None,
                Scope::All,
                None,
                subject,
                Some(end),
                Some(&intent),
            );
            let proven = |r: &RelatedContext| {
                anchors
                    .iter()
                    .filter(|a| {
                        r.passages.iter().any(|p| {
                            p.page == a.page
                                && p.section == a.section
                                && p.relation == "accepted_original"
                        })
                    })
                    .count()
            };
            let context = |r: &RelatedContext| {
                r.passages
                    .iter()
                    .filter(|p| p.relation != "accepted_original")
                    .map(|p| {
                        format!(
                            "{}#{} {} {} t={}",
                            &p.stem[p.stem.len().saturating_sub(16)..],
                            p.section,
                            p.relation,
                            p.role,
                            p.timestamp
                        )
                    })
                    .collect::<Vec<_>>()
            };
            report.push(serde_json::json!({ "case": case["name"], "intent": case["intent"], "anchors": anchors.len(), "text_sha_mismatch": text_mismatch,
                "stale_index_pages": stale_index, "baseline_unverified": case["baseline_unverified"],
                "proven_without_intent": proven(&before), "proven_with_intent": proven(&after),
                "passages_with_intent": after.passages.len(), "incomplete": after.incomplete,
                "context_without_intent": context(&before), "context_with_intent": context(&after) }));
            assert_eq!(
                proven(&after),
                anchors.len() - stale_index,
                "{}: every indexed anchor must carry its proof",
                case["name"]
            );
        }
        println!(
            "GUIDED_PROBE_REPORT {}",
            serde_json::to_string_pretty(&report).unwrap()
        );
    }

    #[test]
    fn historical_anchor_proof_survives_many_recent_turns_and_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        let long = (0..12)
            .map(|i| {
                format!(
                    "Original paragraph {i}. {}",
                    "Preserve this original statement. ".repeat(35)
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        let mut messages = vec![("original".to_string(), "user".to_string(), long)];
        for i in 0..16 {
            messages.push((
                format!("tail{i}"),
                if i % 8 == 0 { "user" } else { "assistant" }.into(),
                format!("Later status message {i}."),
            ));
        }
        let metadata:Vec<_>=messages.iter().enumerate().map(|(i,(id,role,_))|serde_json::json!({
            "message_id":id,"original_role":role,"timestamp":format!("2026-10-08T00:00:{i:02}Z")
        })).collect();
        let mut body = format!(
            "---\nsource: fixture\nconversation_id: long-history\nturn_metadata: {}\n---\n",
            serde_json::to_string(&metadata).unwrap()
        );
        for (_, role, text) in &messages {
            body.push_str(&format!(
                "**{}:**\n\n{text}\n\n",
                if role == "user" { "User" } else { "Assistant" }
            ));
        }
        let page = "raw/conversations/long-history.md";
        let template = add(dir.path(), &mut index, page, &body);
        let chunks = embeddings::chunk_page(&body);
        let events = transcript_chunks(page, &body, &chunks).unwrap();
        let selected: Vec<_> = events
            .iter()
            .filter(|e| e.message_id == "original")
            .take(2)
            .collect();
        assert_eq!(selected.len(), 2);
        let anchors: Vec<_> = selected
            .iter()
            .map(|e| ScoredChunk {
                section: e.section,
                text: chunks[e.section].clone(),
                ..template.clone()
            })
            .collect();
        let cutoff = crate::importers::parse_iso8601("2026-10-09T00:00:00Z").unwrap();
        let found = retrieve_with_cutoff(
            dir.path(),
            &index,
            &anchors,
            None,
            Scope::All,
            None,
            "progress status",
            Some(cutoff),
            None,
        );
        assert!(found.incomplete);
        assert!(
            found
                .passages
                .iter()
                .filter(|p| p.relation != "accepted_original")
                .count()
                <= 8
        );
        for anchor in anchors {
            assert!(found.passages.iter().any(|p| p.page == anchor.page
                && p.section == anchor.section
                && p.relation == "accepted_original"));
        }
    }
}
