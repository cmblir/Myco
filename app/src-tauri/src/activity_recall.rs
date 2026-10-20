//! Bounded, date-grounded indexed passages for personal activity summaries.

use crate::commands::{chunk_in_date_range, page_date, page_in_date_range, DateRange};
use crate::embeddings::{chunk_page, content_hash, is_transcript_turn_header};
use crate::local_synthesis::Evidence;
use crate::retrieval::{Bm25Index, Scope};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::Reverse;
use std::collections::{BTreeMap, BinaryHeap};
use std::fs::File;
use std::io::Read;
use std::path::{Component, Path};

mod claim_sources;
#[cfg(test)]
#[path = "activity_recall/compiled_sources_tests.rs"]
pub(crate) mod compiled_source_tests;
mod compiled_sources;
pub(crate) use claim_sources::{bind_all_originals, bind_original_page};
pub(crate) use claim_sources::{
    original_turns as compilation_original_turns, OriginalTurn as CompilationOriginalTurn,
};
pub(crate) mod period_context;
mod resolution;
pub(crate) use resolution::{
    answer_declarations as resolution_answer_declarations, read as read_resolution,
    recheck as recheck_resolution, task_keys as resolution_task_keys, ResolutionRead,
};
pub use resolution::{
    AdditionalSourceDeclaration, OriginalLineageDeclaration, OriginalSpanDeclaration,
    ResolutionCoverage, ResolutionIssue, ResolutionMode, ResolutionRequest, ResolutionSources,
    ResolutionTaskKey, ResolutionWindow,
};
mod session_context;
pub(crate) use session_context::compiled_session;

const HEADER_BYTES: usize = 8 * 1024;
pub(crate) const CATALOG_CANDIDATES: usize = 2048;
const CURATED_START: &str = "<!-- myco:codex-session-summary:start -->";
const CURATED_END: &str = "<!-- myco:codex-session-summary:end -->";
const CURATED_PROOF: &str = "<!-- myco:codex-session-proof ";
const CURATED_QUOTE: &str = "<!-- myco:codex-quote ";

pub(crate) struct CatalogHeader {
    pub text: String,
    pub revision: String,
    pub incomplete: bool,
}

/// Stop at closed frontmatter; account and hash every consumed byte, including
/// the body prefix in the final read buffer. Never read beyond either budget.
pub(crate) fn read_catalog_header(
    reader: &mut impl Read,
    limit: usize,
    bytes_read: &mut usize,
) -> Result<CatalogHeader, String> {
    let limit = limit.min(HEADER_BYTES);
    let mut bytes = Vec::new();
    let mut digest = Sha256::new();
    let mut cursor = 0;
    let mut first = true;
    let mut opened = false;
    let mut end = None;
    let mut eof = false;
    while bytes.len() < limit && end.is_none() {
        let mut buffer = [0u8; 256];
        let capacity = buffer.len().min(limit - bytes.len());
        let count = reader
            .read(&mut buffer[..capacity])
            .map_err(|_| "recall catalog source unreadable")?;
        if count == 0 {
            eof = true;
            break;
        }
        *bytes_read += count;
        digest.update(&buffer[..count]);
        bytes.extend_from_slice(&buffer[..count]);
        while let Some(newline) = bytes[cursor..].iter().position(|byte| *byte == b'\n') {
            let line_end = cursor + newline + 1;
            let marker = std::str::from_utf8(&bytes[cursor..line_end])
                .map_err(|_| "recall catalog source unreadable")?
                .trim();
            if first {
                opened = marker == "---";
                first = false;
                if !opened {
                    end = Some(line_end);
                }
            } else if opened && marker == "---" {
                end = Some(line_end);
            }
            cursor = line_end;
            if end.is_some() {
                break;
            }
        }
    }
    if eof && end.is_none() {
        let marker = std::str::from_utf8(&bytes[cursor..])
            .map_err(|_| "recall catalog source unreadable")?
            .trim();
        if first && marker == "---" {
            opened = true;
        } else if first || (opened && marker == "---") {
            end = Some(bytes.len());
        }
    }
    let incomplete = end.is_none() && (opened || !eof);
    let text = std::str::from_utf8(&bytes[..end.unwrap_or(0)])
        .map_err(|_| "recall catalog source unreadable")?
        .to_string();
    Ok(CatalogHeader {
        text,
        revision: format!("{:x}", digest.finalize()),
        incomplete,
    })
}

/// Revalidation binds closed header bytes to the whole file's current identity.
/// Metadata is a revision guard, never evidence of a record or action date.
pub(crate) fn catalog_file_revision(
    metadata: &std::fs::Metadata,
    prefix_revision: &str,
) -> Result<String, String> {
    let modified = metadata
        .modified()
        .map_err(|_| "recall catalog source identity unavailable")?;
    let mut digest = Sha256::new();
    digest.update(prefix_revision.as_bytes());
    digest.update(metadata.len().to_le_bytes());
    digest.update(format!("{modified:?}").as_bytes());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        digest.update(metadata.dev().to_le_bytes());
        digest.update(metadata.ino().to_le_bytes());
        digest.update(metadata.ctime().to_le_bytes());
        digest.update(metadata.ctime_nsec().to_le_bytes());
    }
    Ok(format!("{:x}", digest.finalize()))
}

#[derive(Debug, Serialize)]
pub struct Recall {
    pub hits: Vec<Evidence>,
    pub indexed_pages: usize,
    pub scanned_pages: usize,
    pub matched_chunks: usize,
    pub incomplete: bool,
}

#[derive(Clone, Copy)]
struct Limits {
    candidates: usize,
    pages: usize,
    file_bytes: usize,
    total_bytes: usize,
    hits: usize,
    per_page_hits: usize,
    curated_quotes: usize,
    text_chars: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            // Existing and organized source summaries exceed 1,024 pages.
            // Header reads still share the unchanged total byte budget.
            candidates: CATALOG_CANDIDATES,
            pages: 64,
            file_bytes: 512 * 1024,
            total_bytes: 8 * 1024 * 1024,
            hits: 12,
            per_page_hits: 2,
            curated_quotes: 3,
            text_chars: 8192,
        }
    }
}

struct DatedHit {
    curated: bool,
    purpose: Option<QuotePurpose>,
    timestamp: i64,
    quote_start: Option<usize>,
    evidence: Evidence,
}

fn hit_order(a: &DatedHit, b: &DatedHit) -> std::cmp::Ordering {
    b.curated
        .cmp(&a.curated)
        .then_with(|| b.timestamp.cmp(&a.timestamp))
        .then_with(|| a.evidence.page.cmp(&b.evidence.page))
        .then_with(|| {
            b.quote_start
                .cmp(&a.quote_start)
                .then_with(|| a.evidence.section.cmp(&b.evidence.section))
        })
}

fn page_order(a: &[DatedHit], b: &[DatedHit]) -> std::cmp::Ordering {
    // Curated presentation starts with its representative work, which may be
    // older than a later result or rollback. Rank sessions by their newest hit.
    hit_order(
        a.iter()
            .min_by(|a, b| hit_order(a, b))
            .expect("nonempty page"),
        b.iter()
            .min_by(|a, b| hit_order(a, b))
            .expect("nonempty page"),
    )
}

/// A layout hint before header reads, never evidence of dates or truth.
pub(crate) fn source_summary_candidate(page: &str) -> bool {
    if !page.starts_with("wiki/") {
        return false;
    }
    let Some(stem) = Path::new(page).file_stem().and_then(|stem| stem.to_str()) else {
        return false;
    };
    if stem.starts_with("source-") {
        return true;
    }
    let Some((vendor, hash)) = stem
        .strip_prefix("session-")
        .and_then(|stem| stem.rsplit_once('-'))
    else {
        return false;
    };
    !vendor.is_empty()
        && vendor.len() <= 32
        && vendor.as_bytes()[0].is_ascii_alphanumeric()
        && vendor
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && hash.len() == 16
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn metadata(content: &str) -> Option<serde_json::Value> {
    gray_matter::Matter::<gray_matter::engine::YAML>::new()
        .parse::<serde_json::Value>(content)
        .ok()?
        .data
}

/// A bounded project label from the current page, never evidence of an outcome.
pub(crate) fn source_title(content: &str) -> Option<String> {
    let value = metadata(content)?;
    ["title", "session_generated_title"]
        .into_iter()
        .find_map(|field| {
            let title = value.get(field)?.as_str()?.trim();
            (!title.is_empty() && title.chars().count() <= 256).then(|| title.to_owned())
        })
}

pub(crate) fn curated_kind(content: &str) -> Option<String> {
    let value = metadata(content)?;
    let kind = value.get("session_kind")?.as_str()?;
    matches!(kind, "work" | "process" | "empty" | "catalog").then(|| kind.into())
}

pub(crate) fn curated_activity_days(content: &str) -> Vec<String> {
    if curated_kind(content).map_or(true, |kind| kind == "catalog") {
        return Vec::new();
    }
    let mut days: Vec<_> = metadata(content)
        .and_then(|value| value.get("session_activity_days").cloned())
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| {
            let day = value.as_str()?;
            (day.len() == 10 && crate::distill::iso_week(day).is_some()).then(|| day.to_string())
        })
        .collect();
    days.sort_unstable();
    days.dedup();
    days
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QuoteMarker {
    id: String,
    role: String,
    date: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CuratedQuote {
    id: String,
    event: String,
    source: String,
    source_sha256: String,
    start: usize,
    end: usize,
    quote_sha256: String,
    role: String,
    date: Option<String>,
    purpose: QuotePurpose,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum QuotePurpose {
    Work,
    Remaining,
}

#[derive(Clone, Copy)]
struct CuratedSelection {
    start: usize,
    timestamp: Option<i64>,
    purpose: QuotePurpose,
}

/// Preserve the curated lead, latest outcome and latest follow-up. The lead
/// explains the work; retaining its later status avoids reviving superseded work.
/// Purpose and ordering are selection hints, not proof of any claim or status.
fn prioritize_quote_purposes(hits: &mut [DatedHit]) -> usize {
    let first_work = hits
        .iter()
        .filter(|hit| hit.purpose == Some(QuotePurpose::Work))
        .filter_map(|hit| hit.quote_start)
        .min();
    let latest_work = hits
        .iter()
        .find(|hit| hit.purpose == Some(QuotePurpose::Work))
        .and_then(|hit| hit.quote_start);
    let remaining = hits
        .iter()
        .find(|hit| hit.purpose == Some(QuotePurpose::Remaining))
        .and_then(|hit| hit.quote_start);
    let mut starts = Vec::new();
    for start in [first_work, latest_work, remaining].into_iter().flatten() {
        if !starts.contains(&start) {
            starts.push(start);
        }
    }
    hits.sort_by_key(|hit| {
        starts
            .iter()
            .position(|start| Some(*start) == hit.quote_start)
            .unwrap_or(starts.len())
    });
    starts.len()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CuratedProof {
    version: u8,
    kind: String,
    session_key: String,
    records: Vec<String>,
    quotes: Vec<CuratedQuote>,
}

fn marker_json<T: serde::de::DeserializeOwned>(text: &str, prefix: &str) -> Option<T> {
    let body = text.strip_prefix(prefix)?.split_once(" -->")?.0;
    serde_json::from_str(body).ok()
}

fn curated_proof(content: &str) -> Option<CuratedProof> {
    let owned = content
        .split_once(CURATED_START)?
        .1
        .split_once(CURATED_END)?
        .0;
    let proof = owned.find(CURATED_PROOF)?;
    let proof: CuratedProof = marker_json(&owned[proof..], CURATED_PROOF)?;
    (proof.version == 1
        && matches!(proof.kind.as_str(), "work" | "process" | "empty")
        && curated_kind(content).as_deref() == Some(proof.kind.as_str())
        && proof.session_key.len() <= 1024
        && !proof.session_key.is_empty()
        && !proof.records.is_empty()
        && proof.records.len() <= 2048
        && proof.quotes.len() <= 128)
        .then_some(proof)
}

fn curated_quote_section(content: &str, quote: &CuratedQuote) -> Option<String> {
    let owned = content
        .split_once(CURATED_START)?
        .1
        .split_once(CURATED_END)?
        .0;
    let mut sections = Vec::new();
    let mut current = String::new();
    for line in owned.split_inclusive('\n') {
        if line.starts_with('#') && !current.is_empty() {
            sections.push(std::mem::take(&mut current));
        }
        current.push_str(line);
    }
    sections.push(current);
    let expected_header = format!(
        "{} · {}",
        quote.date.as_deref().unwrap_or("날짜 미상"),
        quote.role
    );
    let sections: Vec<_> = sections
        .iter()
        .filter(|section| {
            section.lines().any(|line| {
                marker_json::<QuoteMarker>(line.trim(), CURATED_QUOTE).is_some_and(|marker| {
                    marker.id == quote.id && marker.role == quote.role && marker.date == quote.date
                })
            })
        })
        .collect();
    if sections.len() != 1 {
        return None;
    }
    let section = sections[0];
    if !section.lines().any(|line| line.trim() == expected_header) {
        return None;
    }
    for line in section.lines().map(str::trim_end) {
        if line.trim().is_empty()
            || line.starts_with("#### ")
            || line == expected_header
            || line.starts_with("> ")
            || line == ">"
            || marker_json::<QuoteMarker>(line, CURATED_QUOTE).is_some_and(|marker| {
                marker.id == quote.id && marker.role == quote.role && marker.date == quote.date
            })
        {
            continue;
        }
        let footnote = line
            .strip_prefix("출처: [^src-codex-")
            .and_then(|value| value.strip_suffix(']'));
        if !footnote
            .is_some_and(|id| id.len() == 16 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
        {
            return None;
        }
    }
    Some(section.clone())
}

/// Turn provenance must agree with the exact span; a quoted role label is not
/// enough to change its original speaker or create a missing timestamp.
fn quote_turn_matches(source: &str, quote: &CuratedQuote) -> bool {
    let doc = if source.starts_with("# ") {
        source
            .split_once("\n\n")
            .filter(|(_, rest)| rest.starts_with("---\n"))
            .map_or(source, |(_, rest)| rest)
    } else {
        source
    };
    let offset = source.len() - doc.len() + frontmatter_header(doc).map_or(0, str::len);
    let mut cursor = offset;
    let mut headers = Vec::new();
    for line in source[offset..].split_inclusive('\n') {
        if is_transcript_turn_header(line) {
            headers.push((
                cursor,
                cursor + line.len(),
                line.trim().trim_matches('*').trim_end_matches(':'),
            ));
        }
        cursor += line.len();
    }
    let Some((ordinal, (_, body, role))) =
        headers.iter().enumerate().find(|(ordinal, (_, body, _))| {
            quote.start >= *body
                && quote.end
                    <= headers
                        .get(ordinal + 1)
                        .map_or(source.len(), |header| header.0)
        })
    else {
        return quote.role == "Unknown" && quote.date.is_none() && headers.is_empty();
    };
    if quote.role != *role || quote.start < *body {
        return false;
    }
    let value = metadata(doc);
    let turns = value.as_ref().and_then(|value| value.get("turn_metadata"));
    if let Some(turns) = turns {
        let Some(turns) = turns
            .as_array()
            .filter(|turns| turns.len() == headers.len())
        else {
            return false;
        };
        let date = turns[ordinal]
            .get("timestamp")
            .and_then(serde_json::Value::as_str)
            .and_then(crate::importers::parse_iso8601);
        return date
            == quote
                .date
                .as_deref()
                .and_then(crate::importers::parse_iso8601);
    }
    quote.date.is_none()
}

type BoundSourceSink<'a> = dyn FnMut(&CuratedQuote, &str) -> Result<(), String> + 'a;

/// Verify bounded immutable source bytes and visible quotation blocks. A proof
/// is neither permission to use generated prose nor a complete-source receipt.
#[allow(clippy::too_many_arguments)]
fn curated_sections(
    root: &Path,
    content: &str,
    chunks: &[String],
    limits: Limits,
    bytes_read: &mut usize,
    include_archived: bool,
    incomplete: &mut bool,
    requested_sections: Option<&[usize]>,
    mut source_sink: Option<&mut BoundSourceSink<'_>>,
    mut unavailable_inputs: Option<&mut bool>,
) -> Option<Vec<Option<CuratedSelection>>> {
    let mut unavailable = || {
        if let Some(value) = unavailable_inputs.as_deref_mut() {
            *value = true;
        }
    };
    if !content.contains(CURATED_START) {
        if curated_kind(content).is_some() {
            *incomplete = true;
            unavailable();
            return Some(vec![None; chunks.len()]);
        }
        return None;
    }
    let mut selected = vec![None; chunks.len()];
    let Some(proof) = curated_proof(content) else {
        *incomplete = true;
        unavailable();
        return Some(selected);
    };
    if proof.kind != "work" {
        return Some(selected);
    }
    let mut sources = BTreeMap::new();
    let mut ids = std::collections::BTreeSet::new();
    for quote in proof.quotes {
        let Some(section_text) = curated_quote_section(content, &quote) else {
            *incomplete = true;
            unavailable();
            continue;
        };
        let quote_chunks = chunk_page(&section_text);
        let Some(start) = chunks
            .windows(quote_chunks.len())
            .position(|window| window == quote_chunks)
        else {
            *incomplete = true;
            unavailable();
            continue;
        };
        if requested_sections.is_some_and(|sections| {
            !sections
                .iter()
                .any(|section| start <= *section && *section < start + quote_chunks.len())
        }) {
            continue;
        }
        let mut verify = || -> Option<()> {
            if !ids.insert(quote.id.clone())
                || quote.id.is_empty()
                || quote.id.len() > 128
                || !quote
                    .id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
                || quote.event.is_empty()
                || quote.event.len() > 128
                || !matches!(
                    quote.role.as_str(),
                    "User" | "Assistant" | "System" | "Tool" | "Unknown"
                )
                || quote
                    .date
                    .as_deref()
                    .is_some_and(|date| crate::importers::parse_iso8601(date).is_none())
                || !(quote.source.starts_with("raw/") || quote.source.starts_with("sessions/"))
                || crate::vector_index::is_cold_for(&quote.source, include_archived)
                || !Path::new(&quote.source)
                    .components()
                    .all(|part| matches!(part, Component::Normal(_)))
            {
                return None;
            }
            if !sources.contains_key(&quote.source) {
                let path =
                    crate::vault::confine_path(root, &root.join(&quote.source).to_string_lossy())
                        .ok()?;
                let resolved = path.strip_prefix(root).ok()?.to_str()?;
                if !(resolved.starts_with("raw/") || resolved.starts_with("sessions/"))
                    || crate::vector_index::is_cold_for(resolved, include_archived)
                {
                    return None;
                }
                let metadata = std::fs::metadata(&path).ok()?;
                let budget = limits
                    .file_bytes
                    .min(limits.total_bytes.saturating_sub(*bytes_read));
                if !metadata.is_file()
                    || crate::vault::is_dataless(&metadata)
                    || metadata.len() > budget as u64
                {
                    return None;
                }
                let mut bytes = Vec::new();
                File::open(path)
                    .ok()?
                    .take(budget.saturating_add(1) as u64)
                    .read_to_end(&mut bytes)
                    .ok()?;
                *bytes_read += bytes.len();
                if bytes.len() > budget {
                    return None;
                }
                sources.insert(quote.source.clone(), String::from_utf8(bytes).ok()?);
            }
            let source = sources.get(&quote.source)?;
            let source_metadata = metadata(source);
            if source_metadata
                .as_ref()
                .is_some_and(|value| value.get("original_source").is_some())
            {
                unavailable();
            }
            *incomplete |= quote.date.is_none()
                || source_metadata
                    .as_ref()
                    .is_some_and(|value| value.get("original_source").is_some());
            use sha2::{Digest, Sha256};
            if format!("{:x}", Sha256::digest(source.as_bytes())) != quote.source_sha256
                || quote.start >= quote.end
                || !quote_turn_matches(source, &quote)
            {
                return None;
            }
            let exact = source.get(quote.start..quote.end)?;
            if format!("{:x}", Sha256::digest(exact.as_bytes())) != quote.quote_sha256 {
                return None;
            }
            let visible = section_text
                .lines()
                .filter_map(|line| {
                    line.strip_prefix("> ")
                        .or_else(|| (line == ">").then_some(""))
                })
                .collect::<Vec<_>>()
                .join("\n");
            if visible != exact {
                return None;
            }
            Some(())
        };
        if verify().is_none() {
            *incomplete = true;
            unavailable();
            continue;
        }
        if let Some(sink) = source_sink.as_mut() {
            let Some(source) = sources.get(&quote.source) else {
                *incomplete = true;
                unavailable();
                continue;
            };
            if sink(&quote, source).is_err() {
                *incomplete = true;
                unavailable();
                continue;
            }
        }
        let timestamp = quote
            .date
            .as_deref()
            .and_then(crate::importers::parse_iso8601);
        for section in &mut selected[start..start + quote_chunks.len()] {
            *section = Some(CuratedSelection {
                start,
                timestamp,
                purpose: quote.purpose,
            });
        }
    }
    Some(selected)
}

/// Recheck requested passages, or all proofs used by a bound session context.
/// Raw reads are cached per page and share the caller's existing total budget.
#[cfg(test)]
pub(crate) fn verified_activity_sections(
    root: &Path,
    content: &str,
    chunks: &[String],
    requested_sections: &[usize],
    bytes_read: &mut usize,
    include_archived: bool,
) -> Option<Vec<bool>> {
    let mut incomplete = false;
    let all_sections: Vec<_> = (0..chunks.len()).collect();
    let proof_sections = if session_context::bound_context(content).is_some() {
        all_sections.as_slice()
    } else {
        requested_sections
    };
    let curated = curated_sections(
        root,
        content,
        chunks,
        Limits::default(),
        bytes_read,
        include_archived,
        &mut incomplete,
        Some(proof_sections),
        None,
        None,
    );
    activity_passage_flags(content, chunks, requested_sections, curated)
}

fn activity_passage_flags(
    content: &str,
    chunks: &[String],
    requested_sections: &[usize],
    curated: Option<Vec<Option<CuratedSelection>>>,
) -> Option<Vec<bool>> {
    let mut quotes = source_quote_sections(content, chunks);
    if let Some(curated) = curated {
        let quotes = quotes.get_or_insert_with(|| vec![None; chunks.len()]);
        for (section, quote) in curated.into_iter().enumerate() {
            if let Some(quote) = quote {
                quotes[section] = Some(quote.start);
            }
        }
    }
    quotes.map(|quotes| {
        quotes
            .iter()
            .map(|quote| {
                quote.is_some_and(|start| {
                    !crate::local_synthesis::is_source_attribution_only(&chunks[start])
                        || (requested_sections.contains(&start)
                            && requested_sections.contains(&(start + 1))
                            && quotes.get(start + 1) == Some(&Some(start))
                            && chunks.get(start + 1).is_some_and(|body| {
                                body.trim().starts_with("- ") || body.trim().starts_with("> ")
                            }))
                })
            })
            .collect()
    })
}

pub(crate) struct ActivitySourceInputs {
    pub sections: Option<Vec<bool>>,
    pub documents: Vec<crate::wiki_claims::SourceDocument>,
    pub section_times: Option<Vec<Vec<OriginalSelectionTime>>>,
    pub guard_revisions: BTreeMap<String, String>,
    pub incomplete: bool,
    /// Missing/invalid inputs are distinct from intact originals with unknown dates.
    pub unavailable_inputs: bool,
}

pub(crate) fn read_original_bytes(
    root: &Path,
    relative: &str,
    bytes_read: &mut usize,
) -> Result<String, String> {
    compiled_sources::read_bound(root, relative, 512 * 1024, 8 * 1024 * 1024, bytes_read)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OriginalSelectionTime {
    pub(crate) turn_time: Option<String>,
    pub(crate) record_time: Option<String>,
}

fn original_time_timestamp(time: &OriginalSelectionTime) -> Option<i64> {
    let value = time.turn_time.as_deref().or(time.record_time.as_deref())?;
    if value.len() == 10 {
        crate::importers::parse_iso8601(&format!("{value}T00:00:00Z"))
    } else {
        crate::importers::parse_iso8601(value)
    }
}

/// Compiled selections use original turn/record timing, never generated dates.
/// `None` retains the ordinary-page date contract; `Some(false)` never falls back.
pub(crate) fn original_section_in_range(
    section_times: Option<&[Vec<OriginalSelectionTime>]>,
    section: usize,
    range: &DateRange,
) -> Option<bool> {
    section_times.map(|times| {
        valid_range(range)
            && times.get(section).is_some_and(|times| {
                times.iter().any(|time| {
                    let value = time.turn_time.as_deref().or(time.record_time.as_deref());
                    if value.is_some_and(|value| value.len() == 10) {
                        match (range.start_epoch, range.end_epoch) {
                            (None, None) => day_in_range(value.unwrap_or_default(), range),
                            (Some(start), Some(end)) => {
                                original_time_timestamp(time).is_some_and(|day| {
                                    start <= day && day.saturating_add(86400) <= end
                                })
                            }
                            _ => false,
                        }
                    } else {
                        original_time_timestamp(time)
                            .is_some_and(|timestamp| timestamp_in_range(timestamp, range))
                    }
                })
            })
    })
}

fn original_section_timestamp(
    times: Option<&[Vec<OriginalSelectionTime>]>,
    section: usize,
    range: &DateRange,
) -> Option<i64> {
    if original_section_in_range(times, section, range) != Some(true) {
        return None;
    }
    times?
        .get(section)?
        .iter()
        .filter_map(|time| {
            original_time_timestamp(time).filter(|timestamp| timestamp_in_range(*timestamp, range))
        })
        .max()
}

/// Bind selected curated quotations to their already-read original bytes. The
/// generated session context is not independent activity evidence.
pub(crate) fn original_activity_inputs(
    root: &Path,
    page: &str,
    content: &str,
    chunks: &[String],
    requested_sections: &[usize],
    bytes_read: &mut usize,
    include_archived: bool,
) -> Result<ActivitySourceInputs, String> {
    original_activity_inputs_with_limits(
        root,
        page,
        content,
        chunks,
        requested_sections,
        bytes_read,
        include_archived,
        Limits::default(),
    )
}

#[allow(clippy::too_many_arguments)]
fn original_activity_inputs_with_limits(
    root: &Path,
    page: &str,
    content: &str,
    chunks: &[String],
    requested_sections: &[usize],
    bytes_read: &mut usize,
    include_archived: bool,
    limits: Limits,
) -> Result<ActivitySourceInputs, String> {
    if let Some(bound) = compiled_sources::bind(
        root,
        page,
        content,
        chunks,
        requested_sections,
        bytes_read,
        include_archived,
        limits,
    )? {
        return Ok(bound);
    }
    let mut documents = Vec::new();
    let mut binding_error = None;
    let mut sink = |quote: &CuratedQuote, source: &str| match claim_sources::bind_curated_quote(
        page, source, quote,
    ) {
        Ok(document) => {
            documents.push(document);
            Ok(())
        }
        Err(error) => {
            binding_error = Some(error.clone());
            Err(error)
        }
    };
    let mut incomplete = false;
    let mut unavailable_inputs = false;
    let curated = curated_sections(
        root,
        content,
        chunks,
        limits,
        bytes_read,
        include_archived,
        &mut incomplete,
        Some(requested_sections),
        Some(&mut sink),
        Some(&mut unavailable_inputs),
    );
    if let Some(error) = binding_error {
        return Err(error);
    }
    if let Some(curated) = curated {
        let sections = activity_passage_flags(content, chunks, requested_sections, Some(curated));
        return Ok(ActivitySourceInputs {
            sections,
            documents,
            section_times: None,
            guard_revisions: BTreeMap::new(),
            incomplete,
            unavailable_inputs,
        });
    }
    if source_quote_sections(content, chunks).is_some() {
        return Err("activity summary lacks bound original span proof".into());
    }
    documents.push(bind_original_page(
        page,
        content,
        chunks,
        requested_sections,
    )?);
    Ok(ActivitySourceInputs {
        sections: None,
        documents,
        section_times: None,
        guard_revisions: BTreeMap::new(),
        incomplete,
        unavailable_inputs,
    })
}

fn is_heading_only(text: &str) -> bool {
    text.lines()
        .map(str::trim)
        .all(|line| line.is_empty() || line.starts_with('#'))
}

/// Machine layout is a selection hint, not proof of a quote's truth or timing.
/// Keep complete indexed quote chunks, including continuations, ahead of the
/// generated lead/preview and receipt/footer scaffolding.
fn source_quote_sections(content: &str, chunks: &[String]) -> Option<Vec<Option<usize>>> {
    let parsed = gray_matter::Matter::<gray_matter::engine::YAML>::new()
        .parse::<serde_json::Value>(content)
        .ok()?;
    if parsed.data.as_ref()?.get("type")?.as_str()? != "source-summary"
        || !content.contains("<!-- myco:evidence-coverage ")
    {
        return None;
    }
    let mut is_source_evidence = false;
    let mut is_quote = false;
    let mut quote_start = None;
    let sections: Vec<_> = chunks
        .iter()
        .enumerate()
        .map(|(section, chunk)| {
            let mut has_quote = false;
            for line in chunk.lines().map(str::trim) {
                if line == "### Source evidence" {
                    is_source_evidence = true;
                    is_quote = false;
                    quote_start = None;
                } else if line.starts_with('#') {
                    is_source_evidence &= line.starts_with("#### ");
                    is_quote = false;
                    quote_start = is_source_evidence.then_some(section);
                } else if line.starts_with("<!-- myco:evidence-coverage ") || line == CURATED_START
                {
                    is_source_evidence = false;
                    is_quote = false;
                } else if line.starts_with("Source: [[") {
                    is_quote = false;
                } else if is_source_evidence {
                    is_quote |= line.starts_with("- ");
                    has_quote |= (is_quote && !line.is_empty())
                        || crate::local_synthesis::is_source_attribution_only(line);
                }
            }
            // An owned lead sharing the immutable old quote chunk cannot be
            // removed without changing its citation identity. Reject that
            // mixed chunk; a trailing start marker alone remains scaffolding.
            let mixed = chunk
                .split_once(CURATED_START)
                .is_some_and(|(_, after)| !after.trim().is_empty());
            (has_quote && !mixed).then_some(quote_start.unwrap_or(section))
        })
        .collect();
    Some(sections)
}

pub(crate) fn valid_range(range: &DateRange) -> bool {
    crate::distill::iso_week(&range.start).is_some()
        && crate::distill::iso_week(&range.end).is_some()
        && range.start <= range.end
        && match (range.start_epoch, range.end_epoch) {
            (Some(start), Some(end)) => start < end,
            (None, None) => true,
            _ => false,
        }
}

/// Read complete current indexed passages without a semantic-similarity cutoff.
/// Scope, path and archive filters apply to both indexed and resolved identities.
/// Dates describe record/turn timing, never proof of a user's completed work.
pub(crate) fn recall(
    root: &Path,
    index: &Bm25Index,
    range: &DateRange,
    scope: Scope,
    paths: Option<&[String]>,
    include_archived: bool,
) -> Result<Recall, String> {
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

#[allow(clippy::too_many_arguments)]
fn recall_with_limits(
    root: &Path,
    index: &Bm25Index,
    range: &DateRange,
    scope: Scope,
    paths: Option<&[String]>,
    include_archived: bool,
    limits: Limits,
) -> Result<Recall, String> {
    if !valid_range(range) {
        return Err("activity recall date range is invalid".into());
    }
    let root = root
        .canonicalize()
        .map_err(|_| "activity recall vault is unavailable")?;
    let mut result = Recall {
        hits: Vec::new(),
        indexed_pages: index.indexed_pages(),
        scanned_pages: 0,
        matched_chunks: 0,
        incomplete: index.is_empty(),
    };
    let keeps = |page: &str| {
        scope.keeps(page)
            && !crate::vector_index::is_cold_for(page, include_archived)
            && paths.map_or(true, |paths| paths.iter().any(|path| path == page))
    };
    // Prefer overlapping dated buckets, then undated identities, then older
    // buckets. Even old folders remain candidates: a resumed transcript can
    // carry recent turn dates. Reverse path order breaks ties deterministically.
    let mut candidates = BinaryHeap::new();
    let mut eligible = 0;
    for page in index.page_names().filter(|page| keeps(page)) {
        let date = page_date(page);
        let priority = if page_in_date_range(page, range) {
            2
        } else if date.is_none() {
            1
        } else {
            0
        };
        eligible += 1;
        if limits.candidates == 0 {
            continue;
        }
        candidates.push(Reverse((
            source_summary_candidate(page),
            priority,
            date,
            page,
        )));
        if candidates.len() > limits.candidates {
            candidates.pop();
        }
    }
    result.incomplete |= eligible > candidates.len();
    let mut candidates: Vec<_> = candidates.into_iter().map(|Reverse(page)| page).collect();
    candidates.sort_unstable_by(|a, b| b.cmp(a));
    let mut bytes_read = 0;
    // Headers share the total budget, but cannot consume the capacity needed
    // for one maximum-sized complete page and its immutable source proof.
    let full_read_reserve = limits
        .file_bytes
        .saturating_mul(2)
        .min(limits.total_bytes / 4);
    let catalog_budget = limits.total_bytes - full_read_reserve;
    let mut catalog = Vec::new();
    for (_, _, _, page) in candidates {
        if bytes_read >= catalog_budget {
            result.incomplete = true;
            break;
        }
        if !Path::new(page)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
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
        if !keeps(resolved) {
            result.incomplete = true;
            continue;
        }
        let Ok(metadata) = std::fs::metadata(&path) else {
            result.incomplete = true;
            continue;
        };
        if !metadata.is_file()
            || crate::vault::is_dataless(&metadata)
            || metadata.len() > limits.file_bytes as u64
        {
            result.incomplete = true;
            continue;
        }
        let Ok(mut file) = File::open(&path) else {
            result.incomplete = true;
            continue;
        };
        let header_limit = HEADER_BYTES.min(catalog_budget - bytes_read);
        let read = match read_catalog_header(&mut file, header_limit, &mut bytes_read) {
            Ok(read) => read,
            Err(_) => {
                result.incomplete = true;
                continue;
            }
        };
        result.incomplete |= read.incomplete;
        let header = frontmatter_header(&read.text);
        let date = header
            .and_then(|header| catalog_date(header, range))
            .or_else(|| page_date(page));
        let is_in_range = if let Some(header) = header.filter(|header| has_turn_metadata(header)) {
            catalog_turn_in_range(header, range)
        } else {
            header.is_some_and(|header| {
                record_date_days(header)
                    .iter()
                    .any(|date| day_in_range(date, range))
            }) || page_in_date_range(page, range)
        };
        let kind = header.and_then(curated_kind);
        if kind.as_deref() == Some("catalog") {
            continue;
        }
        let curated_days = header.map(curated_activity_days).unwrap_or_default();
        let is_in_range = is_in_range || curated_days.iter().any(|day| day_in_range(day, range));
        let date = curated_days
            .iter()
            .filter(|day| day_in_range(day, range))
            .max()
            .cloned()
            .or(date);
        catalog.push((is_in_range, kind.as_deref() == Some("work"), date, page));
    }
    // Opaque names are not recency evidence. Inspect only bounded frontmatter
    // before spending the complete-page budget, and count those bytes too.
    catalog.sort_unstable_by(|a, b| b.cmp(a));
    let mut pages = Vec::new();
    for (attempted, (_, _, _, page)) in catalog.into_iter().enumerate() {
        if attempted >= limits.pages || bytes_read >= limits.total_bytes {
            result.incomplete = true;
            break;
        }
        // Repeat confinement and scope checks after the metadata catalog read.
        let Ok(path) = crate::vault::confine_path(&root, &root.join(page).to_string_lossy()) else {
            result.incomplete = true;
            continue;
        };
        if !path
            .strip_prefix(&root)
            .ok()
            .and_then(Path::to_str)
            .is_some_and(keeps)
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
        // The sentinel rejects growth after metadata without an unbounded read.
        let mut bytes = Vec::new();
        let read = file
            .take(read_limit.saturating_add(1) as u64)
            .read_to_end(&mut bytes);
        bytes_read += bytes.len();
        if read.is_err() || bytes.len() > read_limit {
            result.incomplete = true;
            continue;
        }
        let Ok(content) = String::from_utf8(bytes) else {
            result.incomplete = true;
            continue;
        };
        result.scanned_pages += 1;
        let chunks = chunk_page(&content);
        let hashes: Vec<_> = chunks.iter().map(|chunk| content_hash(chunk)).collect();
        if index.page_hashes(page).as_ref() != Some(&hashes) {
            result.incomplete = true;
            continue;
        }
        let compiled = match compiled_sources::bind(
            &root,
            page,
            &content,
            &chunks,
            &(0..chunks.len()).collect::<Vec<_>>(),
            &mut bytes_read,
            include_archived,
            limits,
        ) {
            Ok(bound) => bound,
            Err(_) => {
                result.incomplete = true;
                continue;
            }
        };
        if let Some(bound) = &compiled {
            result.incomplete |= bound.incomplete;
        }
        let mut dates = if let Some(bound) = &compiled {
            (0..chunks.len())
                .map(|section| {
                    original_section_timestamp(bound.section_times.as_deref(), section, range)
                })
                .collect()
        } else {
            chunk_dates(page, &content, &chunks, range, &mut result.incomplete)
                .unwrap_or_else(|| vec![None; chunks.len()])
        };
        let Some(stem) = Path::new(page).file_stem().and_then(|stem| stem.to_str()) else {
            result.incomplete = true;
            continue;
        };
        let mut hits = Vec::new();
        let curated = if compiled.is_some() {
            None
        } else {
            curated_sections(
                &root,
                &content,
                &chunks,
                limits,
                &mut bytes_read,
                include_archived,
                &mut result.incomplete,
                None,
                None,
                None,
            )
        };
        let mut source_quotes = if let Some(bound) = &compiled {
            bound.sections.as_ref().map(|sections| {
                sections
                    .iter()
                    .enumerate()
                    .map(|(section, selected)| selected.then_some(section))
                    .collect()
            })
        } else {
            source_quote_sections(&content, &chunks)
        };
        if let Some(curated) = &curated {
            let source_quotes = source_quotes.get_or_insert_with(|| vec![None; chunks.len()]);
            for (section, quote) in curated.iter().enumerate() {
                if let Some(quote) = quote {
                    source_quotes[section] = Some(quote.start);
                    if let Some(timestamp) = quote.timestamp {
                        dates[section] = Some(timestamp);
                    }
                }
            }
        }
        result.incomplete |= source_quotes
            .as_ref()
            .is_some_and(|sections| sections.iter().all(Option::is_none));
        let title = source_title(&content);
        for (section, (text, timestamp)) in chunks.iter().zip(dates).enumerate() {
            let Some(timestamp) = timestamp else {
                continue;
            };
            let in_range = compiled
                .as_ref()
                .and_then(|bound| {
                    original_section_in_range(bound.section_times.as_deref(), section, range)
                })
                .unwrap_or_else(|| chunk_date_in_range(page, &content, &chunks, section, range));
            if !in_range {
                continue;
            }
            result.matched_chunks += 1;
            // Never truncate a passage into a different indexed chunk identity.
            if text.trim().is_empty() || text.chars().count() > limits.text_chars {
                result.incomplete = true;
                continue;
            }
            // Heading boundaries are indexed identities, but a title alone
            // cannot occupy a page's activity representative ahead of its body.
            if is_heading_only(text) {
                continue;
            }
            if source_quotes
                .as_ref()
                .is_some_and(|sections| sections[section].is_none())
            {
                continue;
            }
            hits.push(DatedHit {
                curated: curated
                    .as_ref()
                    .is_some_and(|quotes| quotes[section].is_some()),
                purpose: curated
                    .as_ref()
                    .and_then(|quotes| quotes[section].map(|quote| quote.purpose)),
                timestamp,
                quote_start: source_quotes
                    .as_ref()
                    .and_then(|sections| sections[section]),
                evidence: Evidence {
                    title: title.clone(),
                    compiled: None,
                    page: page.into(),
                    stem: stem.into(),
                    section,
                    text: text.clone(),
                },
            });
        }
        hits.sort_unstable_by(hit_order);
        let prioritized = prioritize_quote_purposes(&mut hits);
        let before = hits.len();
        if hits.iter().any(|hit| hit.curated) {
            // Count complete quotations, not their embedding chunks. Otherwise
            // an attribution and its body consume both slots and erase follow-ups.
            let mut quotes = std::collections::HashSet::new();
            hits.retain(|hit| {
                let start = hit.quote_start.unwrap_or(hit.evidence.section);
                quotes.contains(&start)
                    || (quotes.len() < limits.curated_quotes.min(prioritized)
                        && quotes.insert(start))
            });
        } else {
            hits.truncate(limits.per_page_hits);
        }
        result.incomplete |= hits.len() < before;
        if !hits.is_empty() {
            pages.push(hits);
        }
    }
    // Cover distinct pages before taking another passage from any one page.
    // Each page's representative is its newest dated chunk. Generated source
    // summaries prefer later appended original quote blocks, preserving their
    // actor-bearing first chunk before continuations. Other pages retain section
    // order. The selected passages remain newest-to-oldest.
    pages.sort_unstable_by(|a, b| page_order(a, b));
    let retained: usize = pages.iter().map(Vec::len).sum();
    let mut selected = Vec::new();
    for ordinal in 0..limits.per_page_hits {
        for page in &mut pages {
            if selected.len() == limits.hits {
                break;
            }
            if !page.is_empty() {
                // Keep a curated outcome together with its selected follow-up;
                // another page must not displace a later status/remaining quote.
                // The existing global chunk and token budgets still apply.
                if page[0].curated {
                    if selected.len() + page.len() <= limits.hits {
                        selected.append(page);
                    }
                    continue;
                }
                if page[0].quote_start.is_some()
                    && crate::local_synthesis::is_source_attribution_only(&page[0].evidence.text)
                {
                    if selected.len() + 2 > limits.hits
                        || page.get(1).map_or(true, |body| {
                            body.quote_start != page[0].quote_start
                                || body.evidence.section != page[0].evidence.section + 1
                                || !(body.evidence.text.trim().starts_with("- ")
                                    || body.evidence.text.trim().starts_with("> "))
                        })
                    {
                        continue;
                    }
                    selected.push(page.remove(0));
                }
                selected.push(page.remove(0));
            }
        }
        if ordinal + 1 == limits.per_page_hits || selected.len() == limits.hits {
            break;
        }
    }
    result.incomplete |= retained > selected.len();
    selected.sort_unstable_by(hit_order);
    result.hits = selected.into_iter().map(|hit| hit.evidence).collect();
    Ok(result)
}

#[derive(Deserialize)]
struct TurnDate {
    timestamp: Option<String>,
}

fn day_in_range(day: &str, range: &DateRange) -> bool {
    range.start.as_str() <= day && day <= range.end.as_str()
}

fn frontmatter_header(content: &str) -> Option<&str> {
    let mut lines = content.split_inclusive('\n');
    let first = lines.next()?;
    if first.trim() != "---" {
        return None;
    }
    let mut end = first.len();
    for line in lines {
        end += line.len();
        if line.trim() == "---" {
            return Some(&content[..end]);
        }
    }
    None
}

/// Valid document creation/update days, not the dates of actions in the body.
/// Only the wiki schema's string dates are supported; Unix import times, file
/// modification times and arbitrary dates quoted in the body are excluded.
pub(crate) fn record_date_days(content: &str) -> Vec<String> {
    let metadata = gray_matter::Matter::<gray_matter::engine::YAML>::new()
        .parse::<serde_json::Value>(content)
        .ok()
        .and_then(|parsed| parsed.data);
    let mut days = Vec::new();
    let curated = curated_kind(content);
    if curated.as_deref() == Some("catalog") {
        return Vec::new();
    }
    let fields = if curated.is_some() {
        ["session_record_start", "session_record_end"]
    } else {
        ["created", "last_updated"]
    };
    for field in fields {
        let Some(value) = metadata
            .as_ref()
            .and_then(|metadata| metadata.get(field))
            .and_then(serde_json::Value::as_str)
        else {
            continue;
        };
        let Some(day) = value
            .get(..10)
            .filter(|day| crate::distill::iso_week(day).is_some())
        else {
            continue;
        };
        if value.len() == 10
            || (value.len() <= 64 && crate::importers::parse_iso8601(value).is_some())
        {
            days.push(day.to_string());
        }
    }
    days.sort_unstable();
    days.dedup();
    days
}

fn catalog_date(content: &str, range: &DateRange) -> Option<String> {
    if has_turn_metadata(content) {
        let dates = gray_matter::Matter::<gray_matter::engine::YAML>::new()
            .parse::<serde_json::Value>(content)
            .ok()?
            .data?
            .get("turn_metadata")?
            .clone();
        let dates = serde_json::from_value::<Vec<TurnDate>>(dates).ok()?;
        let timestamps: Vec<_> = dates
            .iter()
            .filter_map(|date| {
                date.timestamp
                    .as_deref()
                    .and_then(crate::importers::parse_iso8601)
            })
            .collect();
        let timestamp = timestamps
            .iter()
            .filter(|timestamp| timestamp_in_range(**timestamp, range))
            .max()
            .or_else(|| timestamps.iter().max())?;
        let (y, m, d, ..) = crate::distill::civil_datetime(*timestamp);
        return Some(format!("{y:04}-{m:02}-{d:02}"));
    }
    let mut days = record_date_days(content);
    days.extend(curated_activity_days(content));
    days.iter()
        .filter(|day| day_in_range(day, range))
        .max()
        .or_else(|| days.iter().max())
        .cloned()
}

fn has_turn_metadata(content: &str) -> bool {
    gray_matter::Matter::<gray_matter::engine::YAML>::new()
        .parse::<serde_json::Value>(content)
        .ok()
        .and_then(|parsed| parsed.data)
        .is_some_and(|metadata| metadata.get("turn_metadata").is_some())
}

fn timestamp_in_range(timestamp: i64, range: &DateRange) -> bool {
    match (range.start_epoch, range.end_epoch) {
        (Some(start), Some(end)) => start <= timestamp && timestamp < end,
        (None, None) => {
            let (y, m, d, ..) = crate::distill::civil_datetime(timestamp);
            day_in_range(&format!("{y:04}-{m:02}-{d:02}"), range)
        }
        _ => false,
    }
}

fn catalog_turn_in_range(content: &str, range: &DateRange) -> bool {
    let dates = gray_matter::Matter::<gray_matter::engine::YAML>::new()
        .parse::<serde_json::Value>(content)
        .ok()
        .and_then(|parsed| parsed.data)
        .and_then(|metadata| metadata.get("turn_metadata").cloned())
        .and_then(|dates| serde_json::from_value::<Vec<TurnDate>>(dates).ok());
    dates.is_some_and(|dates| {
        dates.iter().any(|date| {
            date.timestamp
                .as_deref()
                .and_then(crate::importers::parse_iso8601)
                .is_some_and(|timestamp| timestamp_in_range(timestamp, range))
        })
    })
}

/// Activity-only date validation: precise spoken turns and dated buckets retain
/// their original contract. Wiki schema dates select records, never body events.
pub(crate) fn chunk_date_in_range(
    page: &str,
    content: &str,
    chunks: &[String],
    section: usize,
    range: &DateRange,
) -> bool {
    if !valid_range(range) || section >= chunks.len() {
        return false;
    }
    if let Some(proof) = curated_proof(content) {
        for quote in proof.quotes {
            let Some(section_text) = curated_quote_section(content, &quote) else {
                continue;
            };
            let quote_chunks = chunk_page(&section_text);
            if let Some(start) = chunks
                .windows(quote_chunks.len())
                .position(|window| window == quote_chunks)
            {
                if start <= section && section < start + quote_chunks.len() {
                    return quote
                        .date
                        .as_deref()
                        .and_then(crate::importers::parse_iso8601)
                        .map_or_else(
                            || {
                                record_date_days(content)
                                    .iter()
                                    .any(|day| day_in_range(day, range))
                            },
                            |timestamp| timestamp_in_range(timestamp, range),
                        );
                }
            }
        }
    }
    let Ok(parsed) =
        gray_matter::Matter::<gray_matter::engine::YAML>::new().parse::<serde_json::Value>(content)
    else {
        return false;
    };
    if parsed
        .data
        .as_ref()
        .is_some_and(|metadata| metadata.get("turn_metadata").is_some())
        || page_date(page).is_some()
    {
        return chunk_in_date_range(page, content, chunks, section, range);
    }
    page.starts_with("wiki/")
        && record_date_days(content)
            .into_iter()
            .chain(curated_activity_days(content))
            .any(|day| day_in_range(&day, range))
}

/// Prefer exact spoken-turn dates, then dated buckets. Undated wiki schema dates
/// only establish that the record was created/updated, not when its actions occurred.
fn chunk_dates(
    page: &str,
    content: &str,
    chunks: &[String],
    range: &DateRange,
    incomplete: &mut bool,
) -> Option<Vec<Option<i64>>> {
    let Ok(parsed) =
        gray_matter::Matter::<gray_matter::engine::YAML>::new().parse::<serde_json::Value>(content)
    else {
        *incomplete = true;
        return None;
    };
    if let Some(value) = parsed.data.as_ref().and_then(|m| m.get("turn_metadata")) {
        let Ok(dates) = serde_json::from_value::<Vec<TurnDate>>(value.clone()) else {
            *incomplete = true;
            return None;
        };
        let mut offset = 0;
        let mut headers = Vec::new();
        for line in parsed.content.split_inclusive('\n') {
            if is_transcript_turn_header(line) {
                headers.push(offset);
            }
            offset += line.len();
        }
        if headers.is_empty() || headers.len() != dates.len() {
            *incomplete = true;
            return None;
        }
        let mut mapped = vec![None; chunk_page(&parsed.content[..headers[0]]).len()];
        for (ordinal, start) in headers.iter().copied().enumerate() {
            let end = headers
                .get(ordinal + 1)
                .copied()
                .unwrap_or(parsed.content.len());
            let turn_chunks = chunk_page(&parsed.content[start..end]);
            if chunks.get(mapped.len()..mapped.len() + turn_chunks.len())
                != Some(turn_chunks.as_slice())
            {
                *incomplete = true;
                return None;
            }
            let timestamp = dates[ordinal]
                .timestamp
                .as_deref()
                .and_then(crate::importers::parse_iso8601);
            *incomplete |= timestamp.is_none();
            mapped.extend(std::iter::repeat(timestamp).take(turn_chunks.len()));
        }
        if mapped.len() != chunks.len() {
            *incomplete = true;
            return None;
        }
        return Some(mapped);
    }
    let date = curated_kind(content)
        .and_then(|_| catalog_date(content, range))
        .or_else(|| page_date(page))
        .or_else(|| {
            page.starts_with("wiki/")
                .then(|| {
                    record_date_days(content)
                        .into_iter()
                        .filter(|day| day_in_range(day, range))
                        .max()
                })
                .flatten()
        })?;
    let day = if date.len() == 7 {
        format!("{date}-01")
    } else {
        date
    };
    let timestamp = crate::importers::parse_iso8601(&format!("{day}T00:00:00Z"))?;
    Some(vec![Some(timestamp); chunks.len()])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn source_title_prefers_valid_human_title_even_if_generated_title_is_invalid() {
        for generated in [
            serde_json::json!("Generated title"),
            serde_json::json!("   "),
            serde_json::json!(17),
            serde_json::json!("g".repeat(257)),
        ] {
            let content = format!(
                "---\ntitle: '  Human chosen title  '\nsession_generated_title: {generated}\n---\n"
            );
            assert_eq!(
                source_title(&content).as_deref(),
                Some("Human chosen title")
            );
        }
    }

    #[test]
    fn source_title_falls_back_when_human_title_is_missing_or_invalid() {
        for human in [
            String::new(),
            "title: '   '\n".into(),
            "title: 17\n".into(),
            format!("title: '{}'\n", "h".repeat(257)),
        ] {
            let content =
                format!("---\n{human}session_generated_title: '  Generated title  '\n---\n");
            assert_eq!(source_title(&content).as_deref(), Some("Generated title"));
        }
    }

    #[test]
    fn source_title_preserves_trimmed_unicode_character_bounds() {
        let bounded = "가".repeat(256);
        let oversized = "가".repeat(257);
        for fields in [
            String::new(),
            "title: 17\nsession_generated_title: false\n".into(),
            "title: ' '\nsession_generated_title: ' '\n".into(),
            format!("title: '{oversized}'\nsession_generated_title: '{oversized}'\n"),
        ] {
            assert_eq!(source_title(&format!("---\n{fields}---\n")), None);
        }
        for fields in [
            format!("title: ' {bounded} '\n"),
            format!("session_generated_title: ' {bounded} '\n"),
        ] {
            assert_eq!(
                source_title(&format!("---\n{fields}---\n")).as_deref(),
                Some(bounded.as_str())
            );
        }
    }

    #[test]
    fn catalog_header_accounts_for_final_buffer_body_overshoot() {
        let header = "---\ncreated: 2026-10-03\n---\n";
        let content = format!("{header}{}", "Synthetic body padding. ".repeat(100));
        let mut bytes_read = 17;
        let read = read_catalog_header(
            &mut std::io::Cursor::new(content.as_bytes()),
            HEADER_BYTES,
            &mut bytes_read,
        )
        .unwrap();
        assert_eq!(read.text, header);
        assert_eq!(bytes_read, 17 + 256);
        assert_eq!(
            read.revision,
            format!("{:x}", Sha256::digest(&content.as_bytes()[..256]))
        );
        assert!(!read.incomplete);
    }

    #[test]
    fn catalog_header_enforces_cap_and_counts_partial_utf8_and_read_errors() {
        let mut bytes_read = 0;
        let capped = read_catalog_header(
            &mut std::io::Cursor::new(b"---\npadding: \xe2\x82\xac\n---\n"),
            14,
            &mut bytes_read,
        )
        .unwrap();
        assert_eq!(bytes_read, 14);
        assert!(capped.incomplete);
        assert!(capped.text.is_empty());
        let mut bytes_read = 0;
        let oversized = format!("---\npadding: {}", "x".repeat(HEADER_BYTES * 2));
        let read = read_catalog_header(
            &mut std::io::Cursor::new(oversized.as_bytes()),
            HEADER_BYTES * 2,
            &mut bytes_read,
        )
        .unwrap();
        assert_eq!(bytes_read, HEADER_BYTES);
        assert!(read.incomplete);
        assert!(read.text.is_empty());

        struct FailingRead(bool);
        impl Read for FailingRead {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                if self.0 {
                    return Err(std::io::Error::other("synthetic read failure"));
                }
                self.0 = true;
                buffer.fill(b'x');
                buffer[..4].copy_from_slice(b"---\n");
                Ok(buffer.len())
            }
        }
        let mut bytes_read = 11;
        assert!(
            read_catalog_header(&mut FailingRead(false), HEADER_BYTES, &mut bytes_read).is_err()
        );
        assert_eq!(bytes_read, 11 + 256);
        let mut bytes_read = 0;
        assert!(read_catalog_header(
            &mut std::io::Cursor::new(b"---\n\xff\n"),
            HEADER_BYTES,
            &mut bytes_read,
        )
        .is_err());
        assert_eq!(bytes_read, 6);
    }

    #[test]
    fn catalog_header_handles_crlf_and_eof_without_hiding_unclosed_frontmatter() {
        for (content, expected, incomplete) in [
            (
                "---\r\ncreated: 2026-10-03\r\n---\r\nbody",
                "---\r\ncreated: 2026-10-03\r\n---\r\n",
                false,
            ),
            (
                "---\ncreated: 2026-10-03\n---",
                "---\ncreated: 2026-10-03\n---",
                false,
            ),
            ("---", "", true),
            ("---\ncreated: 2026-10-03", "", true),
            ("Synthetic plain body", "Synthetic plain body", false),
        ] {
            let mut bytes_read = 0;
            let read = read_catalog_header(
                &mut std::io::Cursor::new(content.as_bytes()),
                HEADER_BYTES,
                &mut bytes_read,
            )
            .unwrap();
            assert_eq!(bytes_read, content.len());
            assert_eq!(read.text, expected);
            assert_eq!(read.incomplete, incomplete, "{content:?}");
        }
    }

    fn range() -> DateRange {
        DateRange {
            start: "2026-10-03".into(),
            end: "2026-10-03".into(),
            start_epoch: crate::importers::parse_iso8601("2026-10-03T00:00:00+09:00"),
            end_epoch: crate::importers::parse_iso8601("2026-10-04T00:00:00+09:00"),
        }
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

    fn transcript() -> &'static str {
        "---\nturn_metadata: [{\"timestamp\":\"2026-10-03T00:30:00+09:00\"},{},{\"timestamp\":\"2026-10-04T00:00:00+09:00\"}]\n---\n\n# Synthetic transcript\n\n**User:**\n\nImplemented the synthetic reader.\n\n**Tool:**\n\nUnknown-time synthetic output.\n\n**Assistant:**\n\nA later synthetic report.\n"
    }

    fn curated_fixture(source: &str, quote: &str, kind: &str) -> String {
        use sha2::{Digest, Sha256};
        let start = source.find(quote).unwrap();
        let proof = serde_json::json!({
            "version":1, "kind":kind, "session_key":"codex:synthetic",
            "records":["synthetic-record"], "quotes":[{
                "id":"q-synthetic", "event":"E-synthetic", "source":"raw/synthetic.md",
                "source_sha256":format!("{:x}", Sha256::digest(source.as_bytes())),
                "start":start,"end":start+quote.len(),
                "quote_sha256":format!("{:x}", Sha256::digest(quote.as_bytes())),
                "role":"Assistant","date":"2026-10-03T12:00:00Z", "purpose":"work"
            }]
        });
        format!("---\ntype: source-summary\nsession_kind: {kind}\nsession_activity_days: [2026-10-03]\nsession_record_start: 2026-10-02\nsession_record_end: 2026-10-02\ncreated: 2026-10-02\nlast_updated: 2026-10-07\n---\n\n# Synthetic curated work\n\n<!-- myco:codex-session-summary:start -->\n\n## Session organization\n\nGenerated worker coordination and an unsupported deployment claim.\n\n#### Evidence: synthetic search outcome\n<!-- myco:codex-quote {{\"id\":\"q-synthetic\",\"role\":\"Assistant\",\"date\":\"2026-10-03T12:00:00Z\"}} -->\n2026-10-03T12:00:00Z · Assistant\n\n> {}\n\n### Verification\n<!-- myco:codex-session-proof {proof} -->\n<!-- myco:codex-session-summary:end -->\n", quote.replace('\n', "\n> "))
    }

    fn curated_source(quote: &str) -> String {
        format!("---\nsource: codex\nconversation_id: synthetic\nturn_metadata: [{{\"timestamp\":\"2026-10-03T12:00:00Z\"}}]\n---\n\n**Assistant:**\n\n{quote}\n")
    }

    #[test]
    fn compiled_session_requires_bound_visible_claims_and_current_dated_originals() {
        let quote = "Reported fixing the synthetic reader. Export validation remains.";
        let source = curated_source(quote);
        let mut content = curated_fixture(&source, quote, "work");
        content = content.replace("## Session organization", "## Session organization\n- The reader was repaired. [^src-codex-synthetic]\n- Export validation remains. [^src-codex-synthetic]");
        let proof = content
            .split_once(CURATED_PROOF)
            .unwrap()
            .1
            .split_once(" -->")
            .unwrap()
            .0;
        let context = serde_json::json!({"version":1,"proof_sha256":format!("{:x}",Sha256::digest(proof.as_bytes())),"claims":[
            {"kind":"work","text":"The reader was repaired.","quote_ids":["q-synthetic"]},
            {"kind":"remaining","text":"Export validation remains.","quote_ids":["q-synthetic"]}
        ]});
        content = content.replace(
            CURATED_END,
            &format!("<!-- myco:codex-session-context {context} -->\n{CURATED_END}"),
        );
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("raw")).unwrap();
        fs::write(root.path().join("raw/synthetic.md"), &source).unwrap();
        let root = root.path().canonicalize().unwrap();
        let verify = |content: &str, range: &DateRange| {
            let chunks = chunk_page(content);
            let mut bytes = 0;
            let verified =
                verified_activity_sections(&root, content, &chunks, &[], &mut bytes, false)
                    .unwrap();
            (
                compiled_session(content, &chunks, &verified, range, &[]),
                bytes,
            )
        };
        let (compiled, bytes) = verify(&content, &range());
        let compiled = compiled.unwrap();
        assert_eq!(compiled.work, ["The reader was repaired."]);
        assert_eq!(compiled.remaining, ["Export validation remains."]);
        assert_eq!(bytes, source.len(), "all claims share one original read");
        let chunks = chunk_page(&content);
        assert!(
            compiled_session(&content, &chunks, &vec![true; chunks.len()], &range(), &[0])
                .is_none(),
            "a passage outside the compiled proof must not be hidden"
        );
        assert!(verify(
            &content,
            &DateRange {
                start: "2026-10-07".into(),
                end: "2026-10-07".into(),
                start_epoch: None,
                end_epoch: None
            }
        )
        .0
        .is_none());
        for changed in [
            content.replacen(
                "- The reader was repaired.",
                "- Human edited the summary.",
                1,
            ),
            content.replacen(
                "\"session_key\":\"codex:synthetic\"",
                "\"session_key\":\"codex:changed\"",
                1,
            ),
            content.replacen(
                "\"quote_ids\":[\"q-synthetic\"]",
                "\"quote_ids\":[\"unknown\"]",
                1,
            ),
        ] {
            assert!(verify(&changed, &range()).0.is_none());
        }
        fs::write(
            root.join("raw/synthetic.md"),
            source.replace("fixing", "breaking"),
        )
        .unwrap();
        assert!(verify(&content, &range()).0.is_none());
    }

    #[test]
    fn curated_quotes_preserve_exact_actor_dated_work_ahead_of_generated_process_text() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        let quote =
            "Reported fixing duplicate search results and twelve passing checks. 합성 결과.";
        let source = curated_source(quote);
        index_file(root.path(), &mut index, "raw/synthetic.md", &source);
        let content = curated_fixture(&source, quote, "work");
        index_file(
            root.path(),
            &mut index,
            "wiki/source-synthetic.md",
            &content,
        );
        let result = recall(root.path(), &index, &range(), Scope::Wiki, None, false).unwrap();
        assert!(
            !result.hits.is_empty(),
            "dated curated original evidence must survive"
        );
        assert!(result.hits.iter().any(|hit| hit.text.contains(quote)));
        assert!(result
            .hits
            .iter()
            .any(|hit| hit.text.contains("· Assistant")));
        assert!(result
            .hits
            .iter()
            .all(|hit| !hit.text.contains("Generated worker")
                && !hit.text.contains("unsupported deployment")
                && !hit.text.contains("codex-session-proof")));
        for hit in result.hits {
            assert_eq!(
                index.chunk_hash(&hit.page, hit.section),
                Some(content_hash(&hit.text))
            );
        }
    }

    #[test]
    fn curated_proof_rejects_changed_source_and_forged_actor_without_lead_fallback() {
        let quote = "Reported fixing the synthetic reader.";
        let source = curated_source(quote);
        let content = curated_fixture(&source, quote, "work");
        for (source, content) in [
            (
                source.clone() + "\nChanged original revision.\n",
                content.clone(),
            ),
            (
                source.clone(),
                content
                    .replace("\"role\":\"Assistant\"", "\"role\":\"User\"")
                    .replace("· Assistant", "· User"),
            ),
            (
                source.clone(),
                content.replace("2026-10-03T12:00:00Z", "2026-10-03T13:00:00Z"),
            ),
            (
                source.clone(),
                content.replace(quote, "An unsupported deployment happened."),
            ),
            (source.clone(), content.replace(CURATED_START, "")),
        ] {
            let root = tempfile::tempdir().unwrap();
            let mut index = Bm25Index::new();
            index_file(root.path(), &mut index, "raw/synthetic.md", &source);
            index_file(
                root.path(),
                &mut index,
                "wiki/source-synthetic.md",
                &content,
            );
            let result = recall(root.path(), &index, &range(), Scope::Wiki, None, false).unwrap();
            assert!(result.hits.is_empty());
            assert!(result.incomplete);
        }
    }

    #[test]
    fn curated_process_metadata_does_not_erase_useful_older_original_quotes() {
        let quote = "Synthetic worker received another handoff.";
        let source = curated_source(quote);
        let mut content = curated_fixture(&source, quote, "process");
        let older = "\n### Source evidence\n\n#### Original user work\n2026-10-03T09:00:00Z · User\n\n- Completed the synthetic reader for the user's project.\n\nSource: [[raw/older]] · revision `12345678` · chunk `0:0-80`\n\n<!-- myco:evidence-coverage {} -->\n";
        content.insert_str(
            content
                .find("<!-- myco:codex-session-summary:start -->")
                .unwrap(),
            older,
        );
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        index_file(root.path(), &mut index, "raw/synthetic.md", &source);
        index_file(
            root.path(),
            &mut index,
            "wiki/source-synthetic.md",
            &content,
        );
        let result = recall(root.path(), &index, &range(), Scope::Wiki, None, false).unwrap();
        assert!(result
            .hits
            .iter()
            .any(|hit| hit.text.contains("Completed the synthetic reader")));
        assert!(result
            .hits
            .iter()
            .all(|hit| !hit.text.contains("worker received")
                && !hit.text.contains("Generated worker")));
    }

    #[test]
    fn appended_session_revision_remains_discoverable_after_organized_dates_refresh() {
        let quote = "Reported fixing the synthetic reader.";
        let source = curated_source(quote);
        let mut content = curated_fixture(&source, quote, "work")
            .replace(
                "session_activity_days: [2026-10-03]",
                "session_activity_days: [2026-10-03, 2026-10-07]",
            )
            .replace(
                "session_record_end: 2026-10-02",
                "session_record_end: 2026-10-06",
            );
        content.push_str("\n### Source evidence\n\n#### New synthetic request\n2026-10-07T09:00:00Z · User\n\n- Please add the synthetic source-opening button.\n\nSource: [[raw/synthetic-revision]] · revision `12345678` · chunk `0:0-47`\n\n<!-- myco:evidence-coverage {} -->\n");
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        index_file(root.path(), &mut index, "raw/synthetic.md", &source);
        index_file(
            root.path(),
            &mut index,
            "wiki/source-synthetic.md",
            &content,
        );
        let selected = DateRange {
            start: "2026-10-07".into(),
            end: "2026-10-07".into(),
            start_epoch: None,
            end_epoch: None,
        };
        let result = recall(root.path(), &index, &selected, Scope::Wiki, None, false).unwrap();
        assert!(result
            .hits
            .iter()
            .any(|hit| hit.text.contains("source-opening button")));
        assert!(result.hits.iter().all(|hit| !hit.text.contains(quote)));
    }

    #[test]
    fn curated_ownership_boundary_does_not_smuggle_prose_in_a_legacy_quote_chunk() {
        let quote = "Synthetic worker received another handoff.";
        let source = curated_source(quote);
        let mut content =
            curated_fixture(&source, quote, "process").replace("## Session organization\n\n", "");
        let older = "\n### Source evidence\n\n#### Original user work\n2026-10-03T09:00:00Z · User\n\n- Completed the synthetic reader.\n\nSource: [[raw/older]]\n\n<!-- myco:evidence-coverage {} -->\n";
        content.insert_str(content.find(CURATED_START).unwrap(), older);
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        index_file(root.path(), &mut index, "raw/synthetic.md", &source);
        index_file(
            root.path(),
            &mut index,
            "wiki/source-synthetic.md",
            &content,
        );
        let result = recall(root.path(), &index, &range(), Scope::Wiki, None, false).unwrap();
        assert!(
            result.hits.is_empty(),
            "mixed indexed chunks cannot be truncated or treated as an exact original quote"
        );
        assert!(result.incomplete);
    }

    #[test]
    fn curated_purposes_keep_a_work_outcome_and_a_remaining_item_within_two_hits() {
        check_curated_purposes(false, false);
    }

    #[test]
    fn curated_purposes_keep_remaining_work_when_attribution_has_its_own_chunk() {
        check_curated_purposes(true, false);
    }

    #[test]
    fn curated_lead_keeps_the_later_status_and_remaining_work() {
        check_curated_purposes(false, true);
        check_curated_purposes(true, true);
    }

    fn check_curated_purposes(long: bool, later_status: bool) {
        use sha2::{Digest, Sha256};
        let mut quotes = vec![
            (
                "Completed synthetic duplicate-result repair with twelve passing checks.",
                "work",
            ),
            (
                "The synthetic sorting proposal is still unimplemented.",
                "remaining",
            ),
            (
                "Manual synthetic interface verification remains to be done.",
                "remaining",
            ),
        ];
        if later_status {
            quotes.push((
                "The synthetic reader was rolled back after a later failure.",
                "work",
            ));
        }
        let quotes: Vec<_> = quotes
            .into_iter()
            .map(|(quote, purpose)| {
                let padding = if long {
                    " Synthetic detail.".repeat(65)
                } else {
                    String::new()
                };
                (format!("{quote}{padding}"), purpose)
            })
            .collect();
        let source = curated_source(
            &quotes
                .iter()
                .map(|(text, _)| text.as_str())
                .collect::<Vec<_>>()
                .join("\n\n"),
        );
        let mut proofs = Vec::new();
        let mut sections = String::new();
        for (ordinal, (quote, purpose)) in quotes.iter().enumerate() {
            let id = format!("q-synthetic-{ordinal}");
            let start = source.find(quote).unwrap();
            proofs.push(serde_json::json!({
                "id":id,"event":"E-synthetic","source":"raw/synthetic.md",
                "source_sha256":format!("{:x}",Sha256::digest(source.as_bytes())),
                "start":start,"end":start+quote.len(),
                "quote_sha256":format!("{:x}",Sha256::digest(quote.as_bytes())),
                "role":"Assistant","date":"2026-10-03T12:00:00Z","purpose":purpose
            }));
            sections.push_str(&format!("\n#### Evidence {ordinal}\n<!-- myco:codex-quote {{\"id\":\"{id}\",\"role\":\"Assistant\",\"date\":\"2026-10-03T12:00:00Z\"}} -->\n2026-10-03T12:00:00Z · Assistant\n\n> {quote}\n"));
        }
        let proof = serde_json::json!({"version":1,"kind":"work","session_key":"codex:synthetic","records":["synthetic-record"],"quotes":proofs});
        let content = format!("---\ntype: source-summary\nsession_kind: work\nsession_activity_days: [2026-10-03]\nsession_record_start: 2026-10-02\nsession_record_end: 2026-10-02\n---\n\n# Synthetic work\n\n{CURATED_START}\n\n## Work themes\nGenerated overview cannot replace original evidence.\n{sections}\n### Verification\n{CURATED_PROOF}{proof} -->\n{CURATED_END}\n");
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        index_file(root.path(), &mut index, "raw/synthetic.md", &source);
        index_file(
            root.path(),
            &mut index,
            "wiki/source-synthetic.md",
            &content,
        );
        let result = recall(root.path(), &index, &range(), Scope::Wiki, None, false).unwrap();
        let quotes_count = if later_status { 3 } else { 2 };
        assert_eq!(result.hits.len(), quotes_count * if long { 2 } else { 1 });
        if later_status {
            assert!(result
                .hits
                .iter()
                .any(|hit| hit.text.contains(&quotes[3].0)));
        }
        assert!(result
            .hits
            .iter()
            .any(|hit| hit.text.contains(&quotes[0].0)));
        assert!(result.hits.iter().any(|hit| quotes
            .iter()
            .any(|(quote, purpose)| *purpose == "remaining" && hit.text.contains(quote))));
        assert!(
            result.incomplete,
            "extra exact quotes were outside the representative limit"
        );
    }

    #[test]
    fn latest_status_ranks_a_session_even_when_its_curated_lead_is_older() {
        let hit = |page: &str, timestamp, section| DatedHit {
            curated: true,
            purpose: Some(QuotePurpose::Work),
            timestamp,
            quote_start: Some(section),
            evidence: Evidence {
                page: page.into(),
                stem: "synthetic".into(),
                section,
                text: "Synthetic work record.".into(),
                title: None,
                compiled: None,
            },
        };
        let recent = vec![hit("wiki/recent.md", 1, 0), hit("wiki/recent.md", 3, 1)];
        let older = vec![hit("wiki/older.md", 2, 0)];
        assert_eq!(page_order(&recent, &older), std::cmp::Ordering::Less);
        assert_eq!(page_order(&older, &recent), std::cmp::Ordering::Greater);
    }

    #[test]
    fn curated_selected_source_copies_and_unknown_dates_remain_partial() {
        let quote = "Reported completing the synthetic reader.";
        for is_unknown in [false, true] {
            let mut source = curated_source(quote).replacen(
                "---\n",
                "---\noriginal_source: raw/large-synthetic.md\n",
                1,
            );
            if is_unknown {
                source = source.replace(
                    "\"timestamp\":\"2026-10-03T12:00:00Z\"",
                    "\"timestamp\":null",
                );
            }
            let mut content = curated_fixture(&source, quote, "work");
            let mut date_range = range();
            if is_unknown {
                content = content
                    .replace("\"date\":\"2026-10-03T12:00:00Z\"", "\"date\":null")
                    .replace("2026-10-03T12:00:00Z · Assistant", "날짜 미상 · Assistant");
                date_range = DateRange {
                    start: "2026-10-02".into(),
                    end: "2026-10-02".into(),
                    start_epoch: None,
                    end_epoch: None,
                };
            }
            let root = tempfile::tempdir().unwrap();
            let mut index = Bm25Index::new();
            index_file(root.path(), &mut index, "raw/synthetic.md", &source);
            index_file(
                root.path(),
                &mut index,
                "wiki/source-synthetic.md",
                &content,
            );
            let result =
                recall(root.path(), &index, &date_range, Scope::Wiki, None, false).unwrap();
            assert!(result.hits.iter().any(|hit| hit.text.contains(quote)));
            assert!(
                result.incomplete,
                "selected copies and missing event dates are not complete coverage"
            );
        }
    }

    #[test]
    fn curated_source_proof_read_keeps_the_existing_file_budget() {
        let quote = "Reported completing the synthetic reader.";
        let source = curated_source(quote) + &"\nSynthetic padding.".repeat(2048);
        let content = curated_fixture(&source, quote, "work");
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        index_file(root.path(), &mut index, "raw/synthetic.md", &source);
        index_file(
            root.path(),
            &mut index,
            "wiki/source-synthetic.md",
            &content,
        );
        let result = recall_with_limits(
            root.path(),
            &index,
            &range(),
            Scope::Wiki,
            None,
            false,
            Limits {
                file_bytes: 2048,
                ..Limits::default()
            },
        )
        .unwrap();
        assert!(result.hits.is_empty());
        assert!(result.incomplete);
    }

    #[test]
    fn curated_revalidation_requires_long_quote_actor_and_body_together() {
        let quote = "Reported completing the synthetic reader. ".repeat(60);
        let quote = quote.trim_end();
        let source = curated_source(quote);
        let content = curated_fixture(&source, quote, "work");
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("raw")).unwrap();
        fs::write(root.path().join("raw/synthetic.md"), &source).unwrap();
        let chunks = chunk_page(&content);
        let header = chunks
            .iter()
            .position(|chunk| crate::local_synthesis::is_source_attribution_only(chunk))
            .unwrap();
        assert!(chunks[header + 1].starts_with("> "));
        let canonical_root = root.path().canonicalize().unwrap();
        let mut bytes = 0;
        let selected = verified_activity_sections(
            &canonical_root,
            &content,
            &chunks,
            &[header, header + 1],
            &mut bytes,
            false,
        )
        .unwrap();
        assert!(selected[header] && selected[header + 1]);
        assert_eq!(
            bytes,
            source.len(),
            "one source file is read once for the whole quote group"
        );
        for requested in [vec![header], vec![header + 1]] {
            let mut bytes = 0;
            let selected = verified_activity_sections(
                &canonical_root,
                &content,
                &chunks,
                &requested,
                &mut bytes,
                false,
            )
            .unwrap();
            assert!(
                requested.iter().all(|section| !selected[*section]),
                "separated actor and body cannot become an unattributed generated claim"
            );
        }
        let proof = content
            .split_once(CURATED_PROOF)
            .unwrap()
            .1
            .split_once(" -->")
            .unwrap()
            .0;
        let context = serde_json::json!({"version":1,"proof_sha256":format!("{:x}",Sha256::digest(proof.as_bytes())),"claims":[
            {"kind":"work","text":"Synthetic reader report.","quote_ids":["q-synthetic"]}
        ]});
        let content = content
            .replace(
                "## Session organization",
                "## Session organization\n- Synthetic reader report. [^src-codex-synthetic]",
            )
            .replace(
                CURATED_END,
                &format!("<!-- myco:codex-session-context {context} -->\n{CURATED_END}"),
            );
        assert!(session_context::bound_context(&content).is_some());
        let chunks = chunk_page(&content);
        let header = chunks
            .iter()
            .position(|chunk| crate::local_synthesis::is_source_attribution_only(chunk))
            .unwrap();
        for requested in [vec![header], vec![header + 1]] {
            let selected = verified_activity_sections(
                &canonical_root,
                &content,
                &chunks,
                &requested,
                &mut 0,
                false,
            )
            .unwrap();
            assert!(
                requested.iter().all(|section| !selected[*section]),
                "bound context does not relax attribution when compiled claims are unavailable"
            );
        }
    }

    #[test]
    fn curated_reserved_session_names_are_prioritized_before_the_candidate_cap() {
        assert!(!source_summary_candidate(
            "wiki/sources/session-codex-notes.md"
        ));
        assert!(!source_summary_candidate(
            "raw/session-codex-0123456789abcdef.md"
        ));
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        let page = "wiki/sources/session-claude-code-0123456789abcdef.md";
        index_file(
            root.path(),
            &mut index,
            page,
            "---\ncreated: 2026-10-03\n---\n\nCompleted a recent synthetic reader.",
        );
        index_file(
            root.path(),
            &mut index,
            "wiki/zz-navigation.md",
            "---\ncreated: 2026-10-03\n---\n\nSynthetic navigation inventory.",
        );
        let result = recall_with_limits(
            root.path(),
            &index,
            &range(),
            Scope::Wiki,
            None,
            false,
            Limits {
                candidates: 1,
                ..Limits::default()
            },
        )
        .unwrap();
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].page, page);
        assert!(result.incomplete);
    }

    #[test]
    fn header_census_finds_recent_work_beyond_1024_opaque_source_summaries() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        for ordinal in 0..1100 {
            index_file(
                root.path(),
                &mut index,
                &format!("wiki/source-z-old-{ordinal:04}.md"),
                "---\ncreated: 2025-01-01\n---\n\nAn older synthetic record.\n",
            );
        }
        let recent = "wiki/source-a-recent.md";
        index_file(
            root.path(),
            &mut index,
            recent,
            "---\ncreated: 2026-10-03\n---\n\nImplemented a recent synthetic reader.\n",
        );
        let result = recall_with_limits(
            root.path(),
            &index,
            &range(),
            Scope::Wiki,
            None,
            false,
            Limits {
                pages: 1,
                ..Limits::default()
            },
        )
        .unwrap();
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].page, recent);
        assert!(
            result.incomplete,
            "the complete-page limit is still disclosed"
        );
    }

    #[test]
    fn header_scale_preserves_budget_for_verified_recent_body_hits() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        let old = format!(
            "---\ncreated: 2025-01-01\n---\n\n{}",
            "Synthetic unrelated old record padding.\n".repeat(256)
        );
        assert!(old.len() > HEADER_BYTES);
        for ordinal in 0..1100 {
            index_file(
                root.path(),
                &mut index,
                &format!("wiki/source-z-old-{ordinal:04}.md"),
                &old,
            );
        }
        let quote = "Reported implementing a synthetic reader and completing twelve checks.";
        let source = curated_source(quote);
        fs::create_dir(root.path().join("raw")).unwrap();
        fs::write(root.path().join("raw/synthetic.md"), &source).unwrap();
        let recent = "wiki/source-a-recent.md";
        index_file(
            root.path(),
            &mut index,
            recent,
            &curated_fixture(&source, quote, "work"),
        );
        assert_eq!(index.indexed_pages(), 1101);
        let result = recall(root.path(), &index, &range(), Scope::Wiki, None, false).unwrap();
        assert!(
            result.scanned_pages > 0,
            "header scans must leave budget for complete pages"
        );
        assert!(
            result
                .hits
                .iter()
                .any(|hit| hit.page == recent && hit.text.contains(quote)),
            "the current indexed page and immutable source proof must both be read and verified"
        );
        assert!(result
            .hits
            .iter()
            .all(|hit| !hit.text.contains("unsupported deployment")));
        fs::write(
            root.path().join("raw/synthetic.md"),
            "Changed synthetic source.",
        )
        .unwrap();
        let changed = recall(root.path(), &index, &range(), Scope::Wiki, None, false).unwrap();
        assert!(
            !changed.hits.iter().any(|hit| hit.page == recent),
            "source revision checks remain mandatory at scale"
        );
    }

    #[test]
    fn large_header_scale_reserves_budget_for_complete_page_and_raw_proof() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        let old = format!(
            "---\ncreated: 2025-01-01\npadding: {}\n---\n\n{}",
            "x".repeat(HEADER_BYTES - 128),
            "Synthetic unrelated old record padding.\n".repeat(16),
        );
        assert!(frontmatter_header(&old).unwrap().len() < HEADER_BYTES);
        for ordinal in 0..1100 {
            index_file(
                root.path(),
                &mut index,
                &format!("wiki/source-z-old-{ordinal:04}.md"),
                &old,
            );
        }
        let quote = "Reported implementing a synthetic reader and completing twelve checks.";
        let source = curated_source(quote);
        fs::create_dir(root.path().join("raw")).unwrap();
        fs::write(root.path().join("raw/synthetic.md"), &source).unwrap();
        // This candidate is catalogued before the large unrelated headers.
        let recent = "wiki/source-zz-recent.md";
        index_file(
            root.path(),
            &mut index,
            recent,
            &curated_fixture(&source, quote, "work"),
        );
        let result = recall(root.path(), &index, &range(), Scope::Wiki, None, false).unwrap();
        assert!(result.incomplete, "bounded header census remains disclosed");
        assert!(result.hits.iter().any(|hit| hit.page == recent && hit.text.contains(quote)),
            "a catalogued recent candidate must retain budget for complete page and raw proof validation");
    }

    #[test]
    fn wiki_keeps_daily_weekly_monthly_and_exact_turn_mirrors() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        for page in [
            "daily/2026-10-03.md",
            "weekly/2026-W40.md",
            "monthly/2026-10.md",
        ] {
            index_file(
                root.path(),
                &mut index,
                page,
                "# Synthetic report\n\nImplemented a synthetic queue.\n",
            );
        }
        for page in [
            "wiki/mirror.md",
            "sessions/2026-10/original.md",
            "raw/conversations/original.md",
        ] {
            index_file(root.path(), &mut index, page, transcript());
        }
        index_file(root.path(), &mut index, "wiki/undated.md", "---\ncreated: 1790982000\nlast_activity: 1791068400\n---\n\n# Undated synthetic plan\n\nAn old plan with new import timestamps.\n");
        let result = recall(root.path(), &index, &range(), Scope::Wiki, None, false).unwrap();
        assert_eq!(result.matched_chunks, 4);
        assert_eq!(result.hits.len(), 4);
        assert!(result.hits.iter().any(|hit| hit.page == "wiki/mirror.md"));
        assert!(result
            .hits
            .iter()
            .all(|hit| !hit.page.starts_with("sessions/")
                && !hit.page.starts_with("raw/")
                && hit.page != "wiki/undated.md"));
        assert!(
            result
                .hits
                .iter()
                .all(|hit| !hit.text.contains("Unknown-time")
                    && !hit.text.contains("later synthetic"))
        );
        assert!(
            result.incomplete,
            "an undated turn must disclose missing temporal coverage"
        );
    }

    #[test]
    fn undated_body_never_borrows_source_or_import_timestamps() {
        let mut incomplete = false;
        for content in [
            "---\ncreated: 1790982000\nlast_activity: 1791068400\n---\n\n# Synthetic\n\nA plan.\n",
            "---\nsource_date: 2026-10-03\n---\n\n# Synthetic\n\nA topic.\n",
        ] {
            assert!(chunk_dates(
                "wiki/topic.md",
                content,
                &chunk_page(content),
                &range(),
                &mut incomplete
            )
            .is_none());
        }
        assert!(
            !incomplete,
            "an ordinary undated note is excluded without inventing a date"
        );
    }

    #[test]
    fn structured_record_days_validate_civil_dates_and_timestamp_types() {
        assert_eq!(
            record_date_days(
                "---\ncreated: 2026-09-01\nlast_updated: '2026-10-03T14:30:00+09:00'\n---\n"
            ),
            ["2026-09-01", "2026-10-03"]
        );
        for fields in [
            "created: 1790982000\nlast_updated: 1790982000",
            "created: 2026-02-31\nlast_updated: 2026-10-03garbage",
            "created: [2026-10-03]\nlast_updated: true",
            "source_date: 2026-10-03\nlast_activity: 1790982000",
        ] {
            assert!(record_date_days(&format!("---\n{fields}\n---\n")).is_empty());
        }
    }

    #[test]
    fn wiki_record_dates_select_records_without_rewriting_old_plans_as_completed_work() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        let content = "---\ncreated: 2025-01-01\nlast_updated: 2026-10-03\n---\n\n# Synthetic plan\n\nThe old plan proposed a connector; completion has not been confirmed.\n";
        let page = "wiki/opaque-synthetic.md";
        index_file(root.path(), &mut index, page, content);
        let chunks = chunk_page(content);
        assert!(!chunk_in_date_range(page, content, &chunks, 0, &range()));
        assert!(chunk_date_in_range(page, content, &chunks, 0, &range()));
        let result = recall(root.path(), &index, &range(), Scope::Wiki, None, false).unwrap();
        assert_eq!(result.matched_chunks, 1);
        assert_eq!(result.hits[0].text, chunks[0]);
        assert!(result.hits[0]
            .text
            .contains("completion has not been confirmed"));
        let mut outside = range();
        outside.start = "2026-09-01".into();
        outside.end = "2026-09-30".into();
        assert!(!chunk_date_in_range(page, content, &chunks, 0, &outside));
        assert!(!chunk_date_in_range(
            "raw/conversations/source.md",
            content,
            &chunks,
            0,
            &range()
        ));
    }

    #[test]
    fn explicit_unknown_turn_dates_never_fall_back_to_record_dates() {
        let content = "---\ncreated: 2026-10-03\nlast_updated: 2026-10-03\nturn_metadata: [{}]\n---\n\n**User:**\n\nA synthetic undated request.\n";
        let mut incomplete = false;
        let chunks = chunk_page(content);
        let dates = chunk_dates(
            "wiki/mirror.md",
            content,
            &chunks,
            &range(),
            &mut incomplete,
        )
        .unwrap();
        assert!(incomplete);
        assert!(dates.iter().all(Option::is_none));
        assert!(!chunk_date_in_range(
            "wiki/mirror.md",
            content,
            &chunks,
            0,
            &range()
        ));
    }

    #[test]
    fn bounded_header_catalog_prefers_real_record_recency_over_opaque_names() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        for ordinal in 0..300 {
            index_file(root.path(), &mut index, &format!("wiki/z-old-{ordinal:03}.md"), "---\ncreated: 2025-01-01\nlast_updated: 2025-01-02\n---\n\n# Synthetic old record\n\nAn unrelated older record.\n");
        }
        let page = "wiki/a-recent.md";
        index_file(root.path(), &mut index, page, "---\ncreated: 2026-10-03\nlast_updated: 2026-10-03\n---\n\n# Synthetic recent record\n\nImplemented a synthetic reader.\n");
        let result = recall_with_limits(
            root.path(),
            &index,
            &range(),
            Scope::Wiki,
            None,
            false,
            Limits {
                pages: 1,
                ..Limits::default()
            },
        )
        .unwrap();
        assert!(result.incomplete);
        assert_eq!(result.scanned_pages, 1);
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].page, page);
    }

    #[test]
    fn incomplete_header_catalog_does_not_hide_its_read_limit() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        let content = format!("---\npadding: {}\ncreated: 2026-10-03\nlast_updated: 2026-10-03\n---\n\n# Synthetic record\n\nImplemented a synthetic reader.\n", "x".repeat(HEADER_BYTES + 1));
        index_file(root.path(), &mut index, "wiki/large-header.md", &content);
        let result = recall(root.path(), &index, &range(), Scope::Wiki, None, false).unwrap();
        assert!(result.incomplete);
        assert_eq!(result.scanned_pages, 1);
        assert_eq!(result.hits.len(), 1);
    }

    #[test]
    fn resumed_old_session_uses_turn_dates_instead_of_its_folder() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        index_file(
            root.path(),
            &mut index,
            "sessions/2025-01/resumed.md",
            transcript(),
        );
        let result = recall(root.path(), &index, &range(), Scope::Sessions, None, false).unwrap();
        assert_eq!(result.matched_chunks, 1);
        assert_eq!(result.hits.len(), 1);
        assert!(result.hits[0]
            .text
            .contains("Implemented the synthetic reader"));
    }

    #[test]
    fn scope_paths_archive_and_resolved_scope_are_enforced() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        for page in [
            "wiki/mirror.md",
            "sessions/2026-10/live.md",
            "sessions/archive/2026-10/old.md",
            "daily/archive/2026-W40/2026-10-03.md",
        ] {
            index_file(root.path(), &mut index, page, transcript());
        }
        let paths = vec!["sessions/archive/2026-10/old.md".into()];
        let filtered = recall(
            root.path(),
            &index,
            &range(),
            Scope::Sessions,
            Some(&paths),
            false,
        )
        .unwrap();
        assert!(filtered.hits.is_empty());
        let opted_in = recall(
            root.path(),
            &index,
            &range(),
            Scope::Sessions,
            Some(&paths),
            true,
        )
        .unwrap();
        assert_eq!(opted_in.hits.len(), 1);
        assert_eq!(opted_in.hits[0].page, paths[0]);
        let all = recall(root.path(), &index, &range(), Scope::All, None, true).unwrap();
        assert!(all
            .hits
            .iter()
            .all(|hit| !hit.page.starts_with("daily/archive/")));
    }

    #[test]
    fn stale_missing_and_invalid_utf8_pages_are_not_evidence() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        for page in ["daily/2026-10-03.md", "wiki/missing.md", "wiki/invalid.md"] {
            index_file(root.path(), &mut index, page, transcript());
        }
        fs::write(
            root.path().join("daily/2026-10-03.md"),
            transcript().replace("Implemented", "Changed"),
        )
        .unwrap();
        fs::remove_file(root.path().join("wiki/missing.md")).unwrap();
        fs::write(root.path().join("wiki/invalid.md"), [0xff]).unwrap();
        let result = recall(root.path(), &index, &range(), Scope::All, None, false).unwrap();
        assert!(result.incomplete);
        assert_eq!(result.scanned_pages, 1);
        assert_eq!(result.matched_chunks, 0);
        assert!(result.hits.is_empty());
    }

    #[test]
    fn header_collision_and_malformed_turn_dates_reject_attribution() {
        for content in [
            transcript().replace(
                "Implemented the synthetic reader.",
                "```text\n**Tool:**\n\nLiteral marker\n```",
            ),
            transcript().replace("turn_metadata:", "turn_metadata: invalid\nignored:"),
        ] {
            let mut incomplete = false;
            assert!(chunk_dates(
                "wiki/mirror.md",
                &content,
                &chunk_page(&content),
                &range(),
                &mut incomplete
            )
            .is_none());
            assert!(incomplete);
        }
    }

    #[test]
    fn output_prioritizes_distinct_pages_and_preserves_complete_chunk_identity() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        let content = "# Synthetic first\n\nImplemented the synthetic reader.\n\n## Synthetic second\n\nTested the synthetic queue.\n\n## Synthetic third\n\nReviewed the synthetic results.\n";
        for day in ["01", "02", "03"] {
            index_file(
                root.path(),
                &mut index,
                &format!("daily/2026-10-{day}.md"),
                content,
            );
        }
        let mut selected_range = range();
        selected_range.start = "2026-10-01".into();
        selected_range.start_epoch = crate::importers::parse_iso8601("2026-10-01T00:00:00+09:00");
        let result = recall_with_limits(
            root.path(),
            &index,
            &selected_range,
            Scope::Wiki,
            None,
            false,
            Limits {
                hits: 3,
                ..Limits::default()
            },
        )
        .unwrap();
        assert_eq!(result.matched_chunks, 9);
        assert!(result.incomplete);
        assert_eq!(
            result
                .hits
                .iter()
                .map(|hit| hit.page.as_str())
                .collect::<Vec<_>>(),
            [
                "daily/2026-10-03.md",
                "daily/2026-10-02.md",
                "daily/2026-10-01.md"
            ]
        );
        for hit in result.hits {
            assert_eq!(hit.text, chunk_page(content)[hit.section]);
            assert_eq!(
                index.chunk_hash(&hit.page, hit.section),
                Some(content_hash(&hit.text))
            );
        }
    }

    #[test]
    fn heading_only_representatives_cannot_displace_all_twelve_work_passages() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        for ordinal in 0..12 {
            let page = format!("wiki/synthetic-{ordinal:02}.md");
            let content = format!(
                "---\ncreated: 2026-10-03\nlast_updated: 2026-10-03\n---\n\n# Synthetic title {ordinal}\n\n## Summary\n\nAssistant reported implementing and testing synthetic reader {ordinal}.\n"
            );
            assert_eq!(chunk_page(&content).len(), 2);
            index_file(root.path(), &mut index, &page, &content);
        }
        let result = recall(root.path(), &index, &range(), Scope::Wiki, None, false).unwrap();
        assert_eq!(result.matched_chunks, 24);
        assert_eq!(result.hits.len(), 12);
        assert!(
            result.hits.iter().all(|hit| hit.section == 1
                && hit.text.contains("Assistant reported implementing and testing")),
            "every page's representative must retain its complete work passage instead of its title alone"
        );
        for hit in result.hits {
            assert_eq!(
                index.chunk_hash(&hit.page, hit.section),
                Some(content_hash(&hit.text))
            );
        }
    }

    #[test]
    fn generated_summary_prefers_later_original_quotes_to_policy_lead_and_unverified_preview() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        let page = "wiki/synthetic-generated-summary.md";
        let evidence = "\n### Source evidence\n\n#### Synthetic standing directions\n2026-10-03T08:00:00Z · User\n\n- Always run checks before making a change; these are general operating rules.\n\nSource: [[raw/synthetic]] · revision `12345678` · chunk `0:0-90`\n\n#### Synthetic connector request\n2026-10-03T09:00:00Z · User\n\n- Please add the synthetic connector and check that it exports the synthetic report.\n\nSource: [[raw/synthetic]] · revision `12345678` · chunk `1:0-90`\n\n#### Synthetic connector result\n2026-10-03T10:00:00Z · Assistant\n\n- I implemented the synthetic connector and reported that its export checks passed.\n\nSource: [[raw/synthetic]] · revision `12345678` · chunk `2:0-90`\n";
        let receipt = serde_json::json!({
            "version": 1, "source": "raw/synthetic.md", "revision": "12345678",
            "chunks": ["0:0-90", "1:0-90", "2:0-90"], "total": 3,
            "evidenceHash": crate::distill::content_fingerprint(evidence.as_bytes()),
        });
        let content = format!(
            "---\ntype: source-summary\ncreated: 2026-10-03\nlast_updated: 2026-10-03\n---\n\n# Synthetic operating directions\n\nAlways run checks before a change. These standing rules do not report a performed task.\n\n## Local preview\n<!-- myco:local-preview {{\"model\":\"synthetic-model\",\"source\":\"raw/synthetic.md\",\"revision\":\"12345678\",\"batch_chunks\":[\"0:0-90\"]}} -->\n\nThe unverified generated preview claimed that every task was already complete.\n{evidence}\n<!-- myco:evidence-coverage {receipt} -->\n\n## Sources\n\n[^src-synthetic]: [[raw/synthetic]]\n"
        );
        index_file(root.path(), &mut index, page, &content);
        let chunks = chunk_page(&content);
        let result = recall(root.path(), &index, &range(), Scope::Wiki, None, false).unwrap();
        assert_eq!(result.matched_chunks, chunks.len());
        assert_eq!(result.hits.len(), 2);
        assert!(result
            .hits
            .iter()
            .any(|hit| hit.text.contains("Please add the synthetic connector")));
        assert!(result
            .hits
            .iter()
            .any(|hit| hit.text.contains("I implemented the synthetic connector")));
        assert!(result
            .hits
            .iter()
            .all(|hit| !hit.text.contains("standing rules")
                && !hit.text.contains("unverified generated preview")));
        for hit in result.hits {
            assert_eq!(hit.text, chunks[hit.section]);
            assert_eq!(
                index.chunk_hash(&hit.page, hit.section),
                Some(content_hash(&hit.text))
            );
        }
    }

    #[test]
    fn generated_summary_without_original_quotes_never_uses_its_preview() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        let page = "wiki/synthetic-missing-quotes.md";
        let content = "---\ntype: source-summary\ncreated: 2026-10-03\n---\n\n# Synthetic preview\n\n<!-- myco:local-preview {} -->\nAll synthetic tasks were completed, according to an unverified preview.\n\n### Source evidence\n\n<!-- myco:evidence-coverage {} -->\n";
        index_file(root.path(), &mut index, page, content);
        let result = recall(root.path(), &index, &range(), Scope::Wiki, None, false).unwrap();
        assert!(result.hits.is_empty());
        assert!(result.incomplete);
        assert_eq!(result.matched_chunks, chunk_page(content).len());
    }

    #[test]
    fn latest_long_quote_keeps_its_original_actor_in_the_first_representative() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        let page = "wiki/synthetic-long-quote.md";
        let content = format!("---\ntype: source-summary\ncreated: 2026-10-03\n---\n\n# Synthetic lead\n\nA generated preview.\n\n### Source evidence\n\n#### Older request\n2026-10-02T10:00:00Z · User\n\n- Please investigate the synthetic reader.\n\nSource: [[raw/synthetic]] · revision `12345678` · chunk `0:0-90`\n\n#### Latest result\n2026-10-03T10:00:00Z · Assistant\n\n- Implemented the synthetic reader and reported passing checks. {}\n\nSource: [[raw/synthetic]] · revision `12345678` · chunk `1:0-2000`\n\n<!-- myco:evidence-coverage {{}} -->\n", "가".repeat(2000));
        index_file(root.path(), &mut index, page, &content);
        let result = recall(root.path(), &index, &range(), Scope::Wiki, None, false).unwrap();
        assert_eq!(result.hits.len(), 2);
        assert!(result.hits[0].text.contains("· Assistant"));
        assert!(result.hits[0]
            .text
            .contains("Implemented the synthetic reader"));
        for hit in result.hits {
            assert_eq!(
                index.chunk_hash(&hit.page, hit.section),
                Some(content_hash(&hit.text))
            );
        }
    }

    #[test]
    fn separated_quote_attribution_is_recalled_together_with_its_body() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        let page = "wiki/synthetic-separated-actor.md";
        let content = format!("---\ntype: source-summary\ncreated: 2026-10-03\n---\n\n### Source evidence\n\n#### {}\n2026-10-03T10:00:00Z · Assistant\n\n- {}\n\nSource: [[raw/synthetic]] · revision `12345678` · chunk `0:0-600`\n\n<!-- myco:evidence-coverage {{}} -->\n", "합성작업의결과보고제목".repeat(8), "합성본문".repeat(150));
        index_file(root.path(), &mut index, page, &content);
        let result = recall(root.path(), &index, &range(), Scope::Wiki, None, false).unwrap();
        assert_eq!(result.hits.len(), 2);
        assert!(result.hits[0].text.contains("· Assistant"));
        assert!(result.hits[1].text.starts_with("- 합성본문"));
    }

    #[test]
    fn generated_quote_continuations_survive_without_receipt_or_footer_only_hits() {
        let content = format!(
            "---\ntype: source-summary\n---\n\n# Synthetic lead\n\nA generated preview.\n\n### Source evidence\n\n#### Synthetic result\n2026-10-03T10:00:00Z · Assistant\n\n- {}\n\nSource: [[raw/synthetic]] · revision `12345678` · chunk `0:0-900`\n\n<!-- myco:evidence-coverage {{\"synthetic\":\"{}\"}} -->\n\n## Sources\n\n[^synthetic]: [[raw/synthetic]]\n",
            "가".repeat(900),
            "receipt-padding".repeat(200),
        );
        let chunks = chunk_page(&content);
        let selected = source_quote_sections(&content, &chunks).unwrap();
        assert!(chunks
            .iter()
            .zip(&selected)
            .any(|(text, selected)| selected.is_some() && text.starts_with('가')));
        for (text, selected) in chunks.iter().zip(&selected) {
            assert_eq!(
                selected.is_some(),
                text.contains('가') || text.contains("· Assistant")
            );
        }
        assert!(chunks
            .iter()
            .zip(&selected)
            .any(|(text, selected)| selected.is_none() && text.starts_with("Source: [[")));
        assert!(chunks
            .iter()
            .zip(&selected)
            .any(|(text, selected)| selected.is_none() && text.contains("receipt-padding")));
        assert!(source_quote_sections(
            &content.replace("type: source-summary", "type: essay"),
            &chunks,
        )
        .is_none());
    }

    #[test]
    fn candidate_attempt_and_byte_limits_disclose_incomplete_coverage() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        let content = "# Synthetic\n\nImplemented a synthetic queue.\n";
        for day in ["01", "02", "03"] {
            index_file(
                root.path(),
                &mut index,
                &format!("daily/2026-10-{day}.md"),
                content,
            );
        }
        let mut selected_range = range();
        selected_range.start = "2026-10-01".into();
        for limits in [
            Limits {
                candidates: 1,
                ..Limits::default()
            },
            Limits {
                pages: 1,
                ..Limits::default()
            },
            Limits {
                total_bytes: content.len() * 4,
                ..Limits::default()
            },
        ] {
            let result = recall_with_limits(
                root.path(),
                &index,
                &selected_range,
                Scope::Wiki,
                None,
                false,
                limits,
            )
            .unwrap();
            assert!(result.incomplete);
            assert_eq!(result.scanned_pages, 1);
            assert_eq!(result.hits[0].page, "daily/2026-10-03.md");
        }
        let oversized = recall_with_limits(
            root.path(),
            &index,
            &selected_range,
            Scope::Wiki,
            None,
            false,
            Limits {
                file_bytes: content.len() - 1,
                ..Limits::default()
            },
        )
        .unwrap();
        assert!(oversized.incomplete);
        assert_eq!(oversized.scanned_pages, 0);
        fs::remove_file(root.path().join("daily/2026-10-03.md")).unwrap();
        let attempted = recall_with_limits(
            root.path(),
            &index,
            &selected_range,
            Scope::Wiki,
            None,
            false,
            Limits {
                candidates: 1,
                pages: 1,
                ..Limits::default()
            },
        )
        .unwrap();
        assert!(attempted.incomplete);
        assert_eq!(
            attempted.scanned_pages, 0,
            "failed header reads consume the bounded candidate budget"
        );
    }

    #[test]
    fn text_budget_rejects_whole_chunks_instead_of_truncating_evidence() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        index_file(
            root.path(),
            &mut index,
            "daily/2026-10-03.md",
            "# Synthetic\n\nImplemented a synthetic queue.\n",
        );
        let result = recall_with_limits(
            root.path(),
            &index,
            &range(),
            Scope::Wiki,
            None,
            false,
            Limits {
                text_chars: 8,
                ..Limits::default()
            },
        )
        .unwrap();
        assert!(result.incomplete);
        assert_eq!(result.matched_chunks, 1);
        assert!(result.hits.is_empty());
    }

    #[test]
    fn invalid_ranges_and_empty_indexes_do_not_claim_no_activity() {
        let root = tempfile::tempdir().unwrap();
        let index = Bm25Index::new();
        let empty = recall(root.path(), &index, &range(), Scope::Wiki, None, false).unwrap();
        assert!(empty.incomplete);
        let mut invalid = range();
        invalid.end = "2026-02-31".into();
        assert!(recall(root.path(), &index, &invalid, Scope::Wiki, None, false).is_err());
        invalid = range();
        invalid.end_epoch = None;
        assert!(recall(root.path(), &index, &invalid, Scope::Wiki, None, false).is_err());
    }

    #[test]
    fn invalid_indexed_paths_are_rejected_before_reading() {
        let root = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        for page in [
            "../outside.md",
            "/absolute.md",
            "wiki/../daily/2026-10-03.md",
        ] {
            index.upsert_page(page, "synthetic", &chunk_page(transcript()));
        }
        let result = recall(root.path(), &index, &range(), Scope::All, None, false).unwrap();
        assert!(result.incomplete);
        assert_eq!(result.scanned_pages, 0);
        assert!(result.hits.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_escape_the_vault_scope_or_explicit_paths() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let mut index = Bm25Index::new();
        index_file(
            root.path(),
            &mut index,
            "sessions/2026-10/inside.md",
            transcript(),
        );
        fs::write(outside.path().join("outside.md"), transcript()).unwrap();
        fs::create_dir_all(root.path().join("wiki")).unwrap();
        for (page, target) in [
            ("wiki/outside.md", outside.path().join("outside.md")),
            (
                "wiki/inside.md",
                root.path().join("sessions/2026-10/inside.md"),
            ),
        ] {
            std::os::unix::fs::symlink(target, root.path().join(page)).unwrap();
            index.upsert_page(page, "synthetic", &chunk_page(transcript()));
        }
        let wiki = recall(root.path(), &index, &range(), Scope::Wiki, None, false).unwrap();
        assert!(wiki.incomplete);
        assert!(wiki.hits.is_empty());
        let paths = vec!["wiki/inside.md".into()];
        let filtered = recall(
            root.path(),
            &index,
            &range(),
            Scope::All,
            Some(&paths),
            false,
        )
        .unwrap();
        assert!(filtered.incomplete);
        assert!(filtered.hits.is_empty());
    }
}
