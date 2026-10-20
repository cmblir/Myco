//! Bounded, timestamp-grounded excerpts from indexed original transcripts.

use crate::commands::DateRange;
use crate::embeddings::{chunk_page, content_hash, is_transcript_turn_header};
use crate::retrieval::{Bm25Index, Scope};
use serde::{Deserialize, Serialize};
use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::fs::File;
use std::io::Read;
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct TemporalEvent {
    pub page: String,
    pub stem: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub section: usize,
    pub text: String,
    pub role: String,
    pub timestamp: i64,
}

#[derive(Debug, Serialize)]
pub struct TemporalRecallResult {
    pub events: Vec<TemporalEvent>,
    pub indexed_pages: usize,
    pub scanned_pages: usize,
    pub matched_events: usize,
    pub incomplete: bool,
}

#[derive(Clone, Copy)]
struct Limits {
    candidates: usize,
    pages: usize,
    file_bytes: usize,
    total_bytes: usize,
    events: usize,
    per_page_events: usize,
    excerpt_chars: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            candidates: 256,
            pages: 64,
            file_bytes: 512 * 1024,
            total_bytes: 8 * 1024 * 1024,
            events: 48,
            per_page_events: 12,
            excerpt_chars: 4096,
        }
    }
}

#[derive(Deserialize)]
struct TurnDate {
    timestamp: Option<String>,
}

struct ReadPage {
    page: String,
    source_revision: Option<String>,
    projection: Option<(String, String)>,
    body_revision: String,
    dates: Vec<Option<i64>>,
    matched: usize,
    events: Vec<TemporalEvent>,
}

/// Inspect only indexed originals; timestamps describe messages, not completed work.
/// `indexed_pages` counts the whole index; `scanned_pages` counts successfully read
/// originals within the requested scope. Neither count describes the whole vault.
pub(crate) fn recall(
    root: &Path,
    index: &Bm25Index,
    range: &DateRange,
    scope: Scope,
    paths: Option<&[String]>,
    include_archived: bool,
) -> TemporalRecallResult {
    recall_with_limits(
        root,
        index,
        range,
        scope,
        paths,
        include_archived,
        Limits::default(),
    )
}

fn is_original(page: &str) -> bool {
    page.starts_with("sessions/") || page.starts_with("raw/conversations/")
}

fn bounds(range: &DateRange) -> Option<(i64, i64)> {
    let (start, end) = match (range.start_epoch, range.end_epoch) {
        (Some(start), Some(end)) => (start, end),
        (None, None) => (
            crate::importers::parse_iso8601(&format!("{}T00:00:00Z", range.start))?,
            crate::importers::parse_iso8601(&format!("{}T00:00:00Z", range.end))?
                .checked_add(86_400)?,
        ),
        _ => return None,
    };
    (start < end).then_some((start, end))
}

fn event_order(a: &TemporalEvent, b: &TemporalEvent) -> std::cmp::Ordering {
    a.timestamp
        .cmp(&b.timestamp)
        .then_with(|| a.page.cmp(&b.page))
        .then_with(|| a.section.cmp(&b.section))
}

#[allow(clippy::too_many_arguments)]
fn recall_with_limits(
    root: &Path,
    index: &Bm25Index,
    range: &DateRange,
    scope: Scope,
    paths: Option<&[String]>,
    include_archived: bool,
    limits: Limits,
) -> TemporalRecallResult {
    let mut result = TemporalRecallResult {
        events: Vec::new(),
        indexed_pages: index.indexed_pages(),
        scanned_pages: 0,
        matched_events: 0,
        incomplete: index.is_empty(),
    };
    let (Ok(root), Some(bounds)) = (root.canonicalize(), bounds(range)) else {
        result.incomplete = true;
        return result;
    };

    // Borrow all identities but retain only a bounded, deterministic candidate set.
    // Folder ordering prioritizes newer names without filtering resumed old sessions.
    let mut candidates = BinaryHeap::new();
    let mut eligible = 0usize;
    for page in index.page_names().filter(|page| {
        is_original(page)
            && scope.keeps(page)
            && !crate::vector_index::is_cold_for(page, include_archived)
            && paths.map_or(true, |paths| paths.iter().any(|path| path == page))
    }) {
        eligible += 1;
        if limits.candidates == 0 {
            continue;
        }
        candidates.push(Reverse(page));
        if candidates.len() > limits.candidates {
            candidates.pop();
        }
    }
    result.incomplete |= eligible > candidates.len();
    let mut candidates: Vec<_> = candidates.into_iter().map(|Reverse(page)| page).collect();
    candidates.sort_unstable_by(|a, b| b.cmp(a));

    let mut pages = Vec::new();
    let mut bytes_read = 0usize;
    for (attempted, page) in candidates.into_iter().enumerate() {
        if attempted >= limits.pages || bytes_read >= limits.total_bytes {
            result.incomplete = true;
            break;
        }
        if !Path::new(page)
            .components()
            .all(|part| matches!(part, std::path::Component::Normal(_)))
        {
            result.incomplete = true;
            continue;
        }
        let Ok(path) = crate::vault::confine_path(&root, &root.join(page).to_string_lossy()) else {
            result.incomplete = true;
            continue;
        };
        let Some(resolved) = path.strip_prefix(&root).ok().and_then(Path::to_str) else {
            result.incomplete = true;
            continue;
        };
        if !is_original(resolved)
            || !scope.keeps(resolved)
            || crate::vector_index::is_cold_for(resolved, include_archived)
        {
            result.incomplete = true;
            continue;
        }
        let read_limit = limits.file_bytes.min(limits.total_bytes - bytes_read);
        let Ok(metadata) = std::fs::metadata(&path) else {
            result.incomplete = true;
            continue;
        };
        if !metadata.is_file()
            || crate::vault::is_dataless(&metadata)
            || metadata.len() > read_limit as u64
        {
            result.incomplete = true;
            continue;
        }
        let Ok(file) = File::open(&path) else {
            result.incomplete = true;
            continue;
        };
        // The sentinel rejects growth after metadata() without an unbounded read.
        let mut content = Vec::new();
        let read = file
            .take(read_limit.saturating_add(1) as u64)
            .read_to_end(&mut content);
        bytes_read = bytes_read.saturating_add(content.len());
        if read.is_err() || content.len() > read_limit {
            result.incomplete = true;
            continue;
        }
        let Ok(content) = String::from_utf8(content) else {
            result.incomplete = true;
            continue;
        };
        result.scanned_pages += 1;
        if let Some(page) = read_page(
            page,
            &content,
            index,
            bounds,
            limits,
            &mut result.incomplete,
        ) {
            pages.push(page);
        }
    }

    // Suppress only a projection whose exact immutable revision, body and dates
    // were verified in this same bounded read. Repeated turns and revisions survive.
    let duplicates: Vec<bool> = pages
        .iter()
        .map(|projection| {
            scope == Scope::All
                && paths.is_none()
                && projection
                    .projection
                    .as_ref()
                    .is_some_and(|(raw_path, revision)| {
                        pages.iter().any(|raw| {
                            raw.page == *raw_path
                                && raw.source_revision.as_ref() == Some(revision)
                                && raw.body_revision == projection.body_revision
                                && raw.dates == projection.dates
                        })
                    })
        })
        .collect();
    for (page, duplicate) in pages.into_iter().zip(duplicates) {
        if duplicate {
            continue;
        }
        result.matched_events += page.matched;
        result.events.extend(page.events);
    }
    result.events.sort_unstable_by(event_order);
    if result.events.len() > limits.events {
        result.incomplete = true;
        result.events.drain(..result.events.len() - limits.events);
    }
    result
}

fn read_page(
    page: &str,
    content: &str,
    index: &Bm25Index,
    bounds: (i64, i64),
    limits: Limits,
    incomplete: &mut bool,
) -> Option<ReadPage> {
    let chunks = chunk_page(content);
    let hashes: Vec<_> = chunks.iter().map(|chunk| content_hash(chunk)).collect();
    if index.page_hashes(page).as_ref() != Some(&hashes) {
        *incomplete = true;
        return None;
    }
    let Ok(parsed) =
        gray_matter::Matter::<gray_matter::engine::YAML>::new().parse::<serde_json::Value>(content)
    else {
        *incomplete = true;
        return None;
    };
    let Some(metadata) = parsed.data else {
        *incomplete = true;
        return None;
    };
    let Some(dates) = metadata
        .get("turn_metadata")
        .and_then(|dates| serde_json::from_value::<Vec<TurnDate>>(dates.clone()).ok())
    else {
        *incomplete = true;
        return None;
    };
    let body = parsed.content;
    let mut offset = 0;
    let mut headers = Vec::new();
    for line in body.split_inclusive('\n') {
        if is_transcript_turn_header(line) {
            let role = match line.trim() {
                "**User:**" => "User",
                "**Assistant:**" => "Assistant",
                "**System:**" => "System",
                "**Tool:**" => "Tool",
                _ => unreachable!("shared transcript marker contract"),
            };
            headers.push((offset, role));
        }
        offset += line.len();
    }
    if headers.is_empty() || headers.len() != dates.len() {
        *incomplete = true;
        return None;
    }
    let dates: Vec<_> = dates
        .iter()
        .map(|date| {
            date.timestamp
                .as_deref()
                .and_then(crate::importers::parse_iso8601)
        })
        .collect();
    *incomplete |= dates.iter().any(Option::is_none);
    let title = metadata
        .get("title")
        .and_then(serde_json::Value::as_str)
        .filter(|title| !title.trim().is_empty())
        .or_else(|| {
            body.lines()
                .find(|line| !line.trim().is_empty())?
                .strip_prefix("# ")
        })
        .map(|title| title.trim().chars().take(180).collect());
    let stem = Path::new(page).file_stem()?.to_str()?.to_string();
    let mut section = chunk_page(&body[..headers[0].0]).len();
    let mut events = Vec::new();
    let mut matched = 0;
    for (ordinal, &(start, role)) in headers.iter().enumerate() {
        let end = headers
            .get(ordinal + 1)
            .map_or(body.len(), |header| header.0);
        let turn_chunks = chunk_page(&body[start..end]);
        // Mapping by re-chunking the complete turn also handles long turns and
        // embedded headings, without reusing the first identical quote's date.
        let next = section + turn_chunks.len();
        if chunks.get(section..next) != Some(turn_chunks.as_slice()) {
            *incomplete = true;
            return None;
        }
        if let Some(timestamp) = dates[ordinal].filter(|ts| bounds.0 <= *ts && *ts < bounds.1) {
            for (offset, text) in turn_chunks.into_iter().enumerate() {
                matched += 1;
                let mut excerpt: String = text.chars().take(limits.excerpt_chars).collect();
                if excerpt.len() < text.len() {
                    excerpt.push('…');
                    *incomplete = true;
                }
                events.push(TemporalEvent {
                    page: page.into(),
                    stem: stem.clone(),
                    title: title.clone(),
                    section: section + offset,
                    text: excerpt,
                    role: role.into(),
                    timestamp,
                });
                if events.len() > limits.per_page_events {
                    let oldest = events
                        .iter()
                        .enumerate()
                        .min_by(|(_, a), (_, b)| event_order(a, b))
                        .map(|(i, _)| i)
                        .expect("an over-limit set is nonempty");
                    events.remove(oldest);
                    *incomplete = true;
                }
            }
        }
        section = next;
    }
    if section != chunks.len() {
        *incomplete = true;
        return None;
    }
    events.sort_unstable_by(event_order);
    Some(ReadPage {
        page: page.into(),
        source_revision: page
            .starts_with("raw/conversations/")
            .then(|| crate::importers::wikify::source_revision(content)),
        projection: page
            .starts_with("sessions/")
            .then(|| {
                Some((
                    metadata.get("raw_path")?.as_str()?.to_string(),
                    metadata.get("source_revision")?.as_str()?.to_string(),
                ))
            })
            .flatten(),
        body_revision: crate::importers::wikify::source_revision(&crate::norm::nfc(&body)),
        dates,
        matched,
        events,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embeddings::chunk_page;
    use crate::importers::parse_iso8601;
    use serde_json::json;
    use std::fs;

    fn range() -> DateRange {
        DateRange {
            start: "2026-10-03".into(),
            end: "2026-10-03".into(),
            start_epoch: parse_iso8601("2026-10-03T00:00:00+09:00"),
            end_epoch: parse_iso8601("2026-10-04T00:00:00+09:00"),
        }
    }

    fn transcript(turns: &[(&str, Option<&str>, &str)]) -> String {
        let metadata: Vec<_> = turns
            .iter()
            .map(|(_, timestamp, _)| json!({"timestamp": timestamp}))
            .collect();
        let mut content = format!(
            "---\nsource: codex\nconversation_id: synthetic\nturn_metadata: {}\n---\n\n# Synthetic planning\n\n",
            serde_json::to_string(&metadata).unwrap()
        );
        for (role, _, text) in turns {
            content.push_str(&format!("**{role}:**\n\n{text}\n\n"));
        }
        content
    }

    fn index_file(root: &Path, index: &mut Bm25Index, page: &str, content: &str) {
        let path = root.join(page);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, content).unwrap();
        index.upsert_page(
            page,
            path.file_stem().unwrap().to_str().unwrap(),
            &chunk_page(content),
        );
    }

    #[test]
    fn empty_index_is_incomplete() {
        let root = tempfile::tempdir().unwrap();
        let result = recall(
            root.path(),
            &Bm25Index::new(),
            &range(),
            Scope::All,
            None,
            false,
        );
        assert!(result.incomplete);
        assert_eq!(result.indexed_pages, 0);
        assert_eq!(result.scanned_pages, 0);
        assert!(result.events.is_empty());
    }

    #[test]
    fn resumed_old_session_uses_original_timestamps_and_all_roles() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        let page = "sessions/2025-01/codex-SYN-a.md";
        let content = transcript(&[
            (
                "Assistant",
                Some("2026-10-03T12:00:00+09:00"),
                "Review the measured result.",
            ),
            (
                "System",
                Some("2026-10-03T08:00:00+09:00"),
                "Synthetic session instructions.",
            ),
            (
                "User",
                Some("2026-10-03T09:00:00+09:00"),
                "Investigate the synthetic queue.",
            ),
            (
                "Tool",
                Some("2026-10-03T10:00:00+09:00"),
                "Synthetic test returned three cases.",
            ),
        ]);
        index_file(root.path(), &mut index, page, &content);
        let result = recall(root.path(), &index, &range(), Scope::All, None, false);
        assert!(!result.incomplete);
        assert_eq!(result.indexed_pages, 1);
        assert_eq!(result.scanned_pages, 1);
        assert_eq!(result.matched_events, 4);
        assert_eq!(
            result
                .events
                .iter()
                .map(|e| e.role.as_str())
                .collect::<Vec<_>>(),
            ["System", "User", "Tool", "Assistant"]
        );
        assert!(result
            .events
            .windows(2)
            .all(|w| w[0].timestamp <= w[1].timestamp));
        for event in result.events {
            assert_eq!(event.page, page);
            assert_eq!(event.stem, "codex-SYN-a");
            assert_eq!(event.title.as_deref(), Some("Synthetic planning"));
            assert_eq!(chunk_page(&content)[event.section], event.text);
        }
    }

    #[test]
    fn viewer_local_bounds_are_inclusive_then_exclusive() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        index_file(
            root.path(),
            &mut index,
            "sessions/2026-10/bounds.md",
            &transcript(&[
                (
                    "User",
                    Some("2026-10-02T23:59:59+09:00"),
                    "Before local midnight.",
                ),
                ("User", Some("2026-10-02T15:00:00Z"), "At local start."),
                (
                    "Assistant",
                    Some("2026-10-03T23:59:59+09:00"),
                    "Before local end.",
                ),
                (
                    "Assistant",
                    Some("2026-10-03T15:00:00Z"),
                    "At exclusive end.",
                ),
            ]),
        );
        let result = recall(root.path(), &index, &range(), Scope::All, None, false);
        assert!(!result.incomplete);
        assert_eq!(result.events.len(), 2);
        assert!(result.events[0].text.contains("At local start"));
        assert!(result.events[1].text.contains("Before local end"));
    }

    #[test]
    fn missing_invalid_and_legacy_dates_never_borrow_file_dates() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        index_file(
            root.path(),
            &mut index,
            "sessions/2026-10/unknown.md",
            &transcript(&[
                ("User", None, "Unknown original date."),
                (
                    "Assistant",
                    Some("2026-02-31T12:00:00Z"),
                    "Impossible calendar date.",
                ),
                (
                    "Tool",
                    Some("2026-10-03T09:00:00+09:00"),
                    "Precisely dated evidence.",
                ),
            ]),
        );
        index_file(root.path(), &mut index, "sessions/2026-10/legacy.md", "---\ncreated: 1790985600\nlast_activity: 1790985600\n---\n# Legacy\n\n**User:**\n\nThe original timestamp is absent.\n");
        let result = recall(root.path(), &index, &range(), Scope::All, None, false);
        assert!(result.incomplete);
        assert_eq!(result.events.len(), 1);
        assert_eq!(result.events[0].role, "Tool");
    }

    #[test]
    fn literal_role_header_mismatch_fails_closed_for_entire_page() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        index_file(
            root.path(),
            &mut index,
            "sessions/2026-10/quoted.md",
            &transcript(&[
                (
                    "User",
                    Some("2026-10-03T09:00:00+09:00"),
                    "Quoted fixture:\n```md\n**Assistant:**\n```\nDo not transfer dates.",
                ),
                (
                    "Assistant",
                    Some("2026-10-04T09:00:00+09:00"),
                    "Outside the requested day.",
                ),
            ]),
        );
        let result = recall(root.path(), &index, &range(), Scope::All, None, false);
        assert!(result.incomplete);
        assert!(result.events.is_empty());
    }

    #[test]
    fn changed_or_missing_indexed_source_is_incomplete_not_old_evidence() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        let content = transcript(&[(
            "User",
            Some("2026-10-03T09:00:00+09:00"),
            "Previously indexed bytes.",
        )]);
        index_file(
            root.path(),
            &mut index,
            "sessions/2026-10/changed.md",
            &content,
        );
        index_file(
            root.path(),
            &mut index,
            "sessions/2026-10/missing.md",
            &content,
        );
        fs::write(
            root.path().join("sessions/2026-10/changed.md"),
            content.replace("Previously indexed", "Changed source"),
        )
        .unwrap();
        fs::remove_file(root.path().join("sessions/2026-10/missing.md")).unwrap();
        let result = recall(root.path(), &index, &range(), Scope::All, None, false);
        assert!(result.incomplete);
        assert!(result.events.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn indexed_symlink_outside_root_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let content = transcript(&[(
            "User",
            Some("2026-10-03T09:00:00+09:00"),
            "Outside synthetic source.",
        )]);
        fs::write(outside.path().join("source.md"), &content).unwrap();
        fs::create_dir_all(root.path().join("sessions/2026-10")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("source.md"),
            root.path().join("sessions/2026-10/escape.md"),
        )
        .unwrap();
        let mut index = Bm25Index::new();
        index.upsert_page(
            "sessions/2026-10/escape.md",
            "escape",
            &chunk_page(&content),
        );
        let result = recall(root.path(), &index, &range(), Scope::All, None, false);
        assert!(result.incomplete);
        assert!(result.events.is_empty());
    }

    #[test]
    fn archive_opt_in_scope_and_explicit_paths_are_preserved() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        let content = transcript(&[(
            "User",
            Some("2026-10-03T09:00:00+09:00"),
            "Synthetic scoped original.",
        )]);
        for page in [
            "sessions/2026-10/live.md",
            "sessions/archive/old.md",
            "raw/conversations/codex/source.md",
            "wiki/copied.md",
        ] {
            index_file(root.path(), &mut index, page, &content);
        }
        let live = recall(root.path(), &index, &range(), Scope::Sessions, None, false);
        assert_eq!(live.events.len(), 1);
        assert_eq!(live.events[0].page, "sessions/2026-10/live.md");
        let archived = recall(root.path(), &index, &range(), Scope::Sessions, None, true);
        assert_eq!(archived.events.len(), 2);
        let paths = vec!["raw/conversations/codex/source.md".into()];
        let restricted = recall(
            root.path(),
            &index,
            &range(),
            Scope::All,
            Some(&paths),
            false,
        );
        assert_eq!(restricted.events.len(), 1);
        assert_eq!(restricted.events[0].page, paths[0]);
        let wiki = recall(root.path(), &index, &range(), Scope::Wiki, None, false);
        assert!(wiki.events.is_empty());
        assert!(!wiki.incomplete);
    }

    #[test]
    fn complete_dated_sources_outside_range_are_honestly_empty() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        index_file(
            root.path(),
            &mut index,
            "sessions/2026-10/other-day.md",
            &transcript(&[(
                "User",
                Some("2026-10-02T09:00:00+09:00"),
                "A different dated day.",
            )]),
        );
        let result = recall(root.path(), &index, &range(), Scope::All, None, false);
        assert!(!result.incomplete);
        assert_eq!(result.scanned_pages, 1);
        assert_eq!(result.matched_events, 0);
        assert!(result.events.is_empty());
    }

    #[test]
    fn per_page_evidence_is_bounded_and_reports_truncation() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        let turns: Vec<_> = (0..20)
            .map(|_| {
                (
                    "User",
                    Some("2026-10-03T09:00:00+09:00"),
                    "Distinct original occurrence remains dated.",
                )
            })
            .collect();
        index_file(
            root.path(),
            &mut index,
            "sessions/2026-10/many.md",
            &transcript(&turns),
        );
        let result = recall(root.path(), &index, &range(), Scope::All, None, false);
        assert!(result.incomplete);
        assert_eq!(result.matched_events, 20);
        assert_eq!(result.events.len(), 12);
    }

    #[test]
    fn candidate_page_and_byte_budgets_count_excluded_reads() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        let content = transcript(&[(
            "User",
            Some("2026-10-03T09:00:00+09:00"),
            "Bounded synthetic read.",
        )]);
        for page in [
            "sessions/2026-10/a.md",
            "sessions/2026-10/b.md",
            "sessions/2026-10/c.md",
        ] {
            index_file(root.path(), &mut index, page, &content);
        }
        let selected = recall_with_limits(
            root.path(),
            &index,
            &range(),
            Scope::All,
            None,
            false,
            Limits {
                candidates: 2,
                ..Limits::default()
            },
        );
        assert!(selected.incomplete);
        assert_eq!(selected.scanned_pages, 2);
        assert_eq!(
            selected
                .events
                .iter()
                .map(|event| event.page.as_str())
                .collect::<Vec<_>>(),
            ["sessions/2026-10/b.md", "sessions/2026-10/c.md"]
        );

        let bytes = recall_with_limits(
            root.path(),
            &index,
            &range(),
            Scope::All,
            None,
            false,
            Limits {
                total_bytes: content.len(),
                ..Limits::default()
            },
        );
        assert!(bytes.incomplete);
        assert_eq!(bytes.scanned_pages, 1);
        assert_eq!(bytes.events[0].page, "sessions/2026-10/c.md");

        let oversized = recall_with_limits(
            root.path(),
            &index,
            &range(),
            Scope::All,
            None,
            false,
            Limits {
                file_bytes: content.len() - 1,
                ..Limits::default()
            },
        );
        assert!(oversized.incomplete);
        assert_eq!(oversized.scanned_pages, 0);
        assert!(oversized.events.is_empty());

        fs::remove_file(root.path().join("sessions/2026-10/c.md")).unwrap();
        let attempts = recall_with_limits(
            root.path(),
            &index,
            &range(),
            Scope::All,
            None,
            false,
            Limits {
                pages: 1,
                ..Limits::default()
            },
        );
        assert!(attempts.incomplete);
        assert_eq!(attempts.scanned_pages, 0);
        assert!(
            attempts.events.is_empty(),
            "a failed first attempt must still consume the page budget"
        );
    }

    #[test]
    fn output_and_excerpt_budgets_keep_newest_originals_and_mark_incomplete() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        for (page, timestamp) in [
            ("a", "2026-10-03T12:00:00+09:00"),
            ("b", "2026-10-03T11:00:00+09:00"),
            ("c", "2026-10-03T10:00:00+09:00"),
        ] {
            index_file(
                root.path(),
                &mut index,
                &format!("sessions/2026-10/{page}.md"),
                &transcript(&[("User", Some(timestamp), "Keep the exact original excerpt.")]),
            );
        }
        let result = recall_with_limits(
            root.path(),
            &index,
            &range(),
            Scope::All,
            None,
            false,
            Limits {
                events: 2,
                ..Limits::default()
            },
        );
        assert!(result.incomplete);
        assert_eq!(result.matched_events, 3);
        assert_eq!(
            result
                .events
                .iter()
                .map(|event| event.stem.as_str())
                .collect::<Vec<_>>(),
            ["b", "a"]
        );

        let short = recall_with_limits(
            root.path(),
            &index,
            &range(),
            Scope::All,
            None,
            false,
            Limits {
                excerpt_chars: 12,
                ..Limits::default()
            },
        );
        assert!(short.incomplete);
        assert!(short
            .events
            .iter()
            .all(|event| event.text.chars().count() <= 13 && event.text.ends_with('…')));
    }

    #[test]
    fn long_turn_and_nested_headings_keep_the_original_role_date_and_section() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        let spoken = format!(
            "{}\n\n## Synthetic tail\n\nTAIL-SYN-4242 remains in the same spoken turn.",
            "A bounded original paragraph. ".repeat(240)
        );
        let content = transcript(&[
            ("User", Some("2026-10-03T09:00:00+09:00"), &spoken),
            (
                "Assistant",
                Some("2026-10-04T09:00:00+09:00"),
                "Outside the requested day.",
            ),
        ]);
        let page = "sessions/2025-01/long.md";
        index_file(root.path(), &mut index, page, &content);
        let result = recall(root.path(), &index, &range(), Scope::All, None, false);
        assert!(!result.incomplete);
        assert!(result.events.len() > 2);
        assert!(result
            .events
            .iter()
            .any(|event| event.text.contains("TAIL-SYN-4242")));
        for event in result.events {
            assert_eq!(event.role, "User");
            assert_eq!(
                event.timestamp,
                parse_iso8601("2026-10-03T09:00:00+09:00").unwrap()
            );
            assert_eq!(event.text, chunk_page(&content)[event.section]);
        }
    }

    #[test]
    fn exact_raw_revision_projection_dedup_preserves_revisions_occurrences_and_scope() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        let content = transcript(&[
            (
                "User",
                Some("2026-10-03T09:00:00+09:00"),
                "Repeated acknowledgement.",
            ),
            (
                "User",
                Some("2026-10-03T09:00:00+09:00"),
                "Repeated acknowledgement.",
            ),
        ]);
        let raw = "raw/conversations/codex/original.md";
        let projection = "sessions/2026-10/projected.md";
        let revision = crate::importers::wikify::source_revision(&content);
        let projected = content.replacen(
            "source: codex\n",
            &format!("source: codex\nraw_path: {raw}\nsource_revision: {revision}\n"),
            1,
        );
        index_file(root.path(), &mut index, raw, &content);
        index_file(root.path(), &mut index, projection, &projected);
        let result = recall(root.path(), &index, &range(), Scope::All, None, false);
        assert!(!result.incomplete);
        assert_eq!(result.matched_events, 2);
        assert_eq!(result.events.len(), 2);
        assert!(result.events.iter().all(|event| event.page == raw));
        assert_ne!(result.events[0].section, result.events[1].section);

        let sessions = recall(root.path(), &index, &range(), Scope::Sessions, None, false);
        assert_eq!(sessions.events.len(), 2);
        assert!(sessions.events.iter().all(|event| event.page == projection));
        let paths = vec![raw.into(), projection.into()];
        let explicit = recall(
            root.path(),
            &index,
            &range(),
            Scope::All,
            Some(&paths),
            false,
        );
        assert_eq!(explicit.events.len(), 4);

        let different = projected.replacen(&revision, "different-revision", 1);
        index_file(root.path(), &mut index, projection, &different);
        let revisions = recall(root.path(), &index, &range(), Scope::All, None, false);
        assert_eq!(revisions.events.len(), 4);
        assert_eq!(revisions.matched_events, 4);
    }

    #[test]
    fn altered_projection_dates_and_unindexed_raw_never_prove_a_duplicate() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        let raw = "raw/conversations/codex/original.md";
        let content = transcript(&[(
            "User",
            Some("2026-10-03T09:00:00+09:00"),
            "Original source event.",
        )]);
        let revision = crate::importers::wikify::source_revision(&content);
        let projected = content.replacen(
            "source: codex\n",
            &format!("source: codex\nraw_path: {raw}\nsource_revision: {revision}\n"),
            1,
        );
        index_file(root.path(), &mut index, raw, &content);
        index_file(
            root.path(),
            &mut index,
            "sessions/2026-10/projection.md",
            &projected.replace("T09:00:00", "T10:00:00"),
        );
        let changed = recall(root.path(), &index, &range(), Scope::All, None, false);
        assert_eq!(changed.events.len(), 2);
        assert_ne!(changed.events[0].timestamp, changed.events[1].timestamp);

        index.upsert_page(raw, "original", &[]);
        let unindexed = recall(root.path(), &index, &range(), Scope::All, None, false);
        assert_eq!(unindexed.scanned_pages, 1);
        assert_eq!(unindexed.events.len(), 1);
        assert_eq!(unindexed.events[0].page, "sessions/2026-10/projection.md");
    }

    #[test]
    fn malformed_range_and_malformed_metadata_fail_closed() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        index_file(root.path(), &mut index, "sessions/2026-10/bad.md", "---\nturn_metadata: not-an-array\n---\n# Synthetic\n\n**User:**\n\nA date cannot be attributed.\n");
        let malformed = recall(root.path(), &index, &range(), Scope::All, None, false);
        assert!(malformed.incomplete);
        assert!(malformed.events.is_empty());

        let mut partial = range();
        partial.end_epoch = None;
        let result = recall(root.path(), &index, &partial, Scope::All, None, false);
        assert!(result.incomplete);
        assert_eq!(result.scanned_pages, 0);
        partial.start_epoch = None;
        partial.start = "2026-02-31".into();
        let result = recall(root.path(), &index, &partial, Scope::All, None, false);
        assert!(result.incomplete);
        assert_eq!(result.scanned_pages, 0);
    }

    #[cfg(unix)]
    #[test]
    fn canonical_archive_alias_still_requires_archive_opt_in() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        let content = transcript(&[(
            "User",
            Some("2026-10-03T09:00:00+09:00"),
            "Archived original evidence.",
        )]);
        index_file(
            root.path(),
            &mut index,
            "sessions/archive/source.md",
            &content,
        );
        fs::create_dir_all(root.path().join("sessions/2026-10")).unwrap();
        std::os::unix::fs::symlink(
            root.path().join("sessions/archive/source.md"),
            root.path().join("sessions/2026-10/alias.md"),
        )
        .unwrap();
        index.upsert_page("sessions/2026-10/alias.md", "alias", &chunk_page(&content));
        let paths = vec!["sessions/2026-10/alias.md".into()];
        let closed = recall(
            root.path(),
            &index,
            &range(),
            Scope::All,
            Some(&paths),
            false,
        );
        assert!(closed.incomplete);
        assert!(closed.events.is_empty());
        let open = recall(
            root.path(),
            &index,
            &range(),
            Scope::All,
            Some(&paths),
            true,
        );
        assert!(!open.incomplete);
        assert_eq!(open.events.len(), 1);
    }

    #[test]
    #[ignore = "synthetic bounded-read timing; run explicitly with --ignored --nocapture"]
    fn bounded_500_page_timing_probe() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        let content = transcript(&[(
            "User",
            Some("2026-10-03T09:00:00+09:00"),
            "Synthetic bounded read performance probe.",
        )]);
        for n in 0..500 {
            index_file(
                root.path(),
                &mut index,
                &format!("sessions/2026-10/SYN-{n:04}.md"),
                &content,
            );
        }
        let started = std::time::Instant::now();
        let result = recall(root.path(), &index, &range(), Scope::All, None, false);
        let elapsed = started.elapsed();
        assert_eq!(result.indexed_pages, 500);
        assert_eq!(result.scanned_pages, 64);
        assert_eq!(result.matched_events, 64);
        assert_eq!(result.events.len(), 48);
        assert!(result.incomplete);
        println!("temporal synthetic: indexed={} scanned={} matched={} shown={} elapsed_ms={:.3} read_cap_bytes={} max_file_bytes={} candidate_cap={} page_cap={}", result.indexed_pages, result.scanned_pages, result.matched_events, result.events.len(), elapsed.as_secs_f64() * 1000.0, Limits::default().total_bytes, Limits::default().file_bytes, Limits::default().candidates, Limits::default().pages);
    }
}
