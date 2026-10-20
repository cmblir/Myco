//! Bounded same-scope candidates from fresh indexed original source bytes.
//! Lexical overlap and source bindings are not same-task semantic acceptance.

#[path = "resolution_contract.rs"]
mod contract;
pub use contract::*;

use super::{original_activity_inputs_with_limits, Limits};
use crate::embeddings::{chunk_page, content_hash};
use crate::local_synthesis::Evidence;
use crate::retrieval::{Bm25Hit, Bm25Index, Scope};
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::{CheckedClaims, SourceSet, SourceSpan};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::path::{Component, Path};
use std::sync::atomic::{AtomicBool, Ordering};

const MAX_KEYS: usize = 6;
const MAX_CANDIDATES: usize = 48;
const MAX_PAGES: usize = 12;
const MAX_SPANS: usize = 12;
const FILE_BYTES: usize = 512 * 1024;
const TOTAL_BYTES: usize = 2 * 1024 * 1024;

pub(crate) struct ResolutionRead<'a> {
    pub root: &'a Path,
    pub index: &'a Bm25Index,
    pub origin: &'a AgentVaultSession,
    pub scope: Scope,
    pub paths: Option<&'a [String]>,
    pub window: &'a ResolutionWindow,
    pub task_keys: &'a [ResolutionTaskKey],
    pub initial: &'a SourceSet,
    pub include_archived: bool,
}

pub struct ResolutionSources {
    pub evidence: Vec<Evidence>,
    pub originals: SourceSet,
    pub declarations: Vec<AdditionalSourceDeclaration>,
    pub coverage: ResolutionCoverage,
    pub revisions: BTreeMap<String, String>,
}

fn key_id(anchor: &SourceSpan, start: usize, end: usize) -> String {
    let identity = format!("{}:{start}:{end}", anchor.id());
    format!(
        "K-{}",
        &format!("{:x}", Sha256::digest(identity.as_bytes()))[..24]
    )
}

/// Native lexical windows propose candidates, never a canonical task identity.
fn native_windows(text: &str) -> Vec<(usize, usize)> {
    let boundaries: Vec<_> = text
        .char_indices()
        .map(|(offset, _)| offset)
        .chain(std::iter::once(text.len()))
        .collect();
    let count = boundaries.len() - 1;
    if count == 0 {
        return Vec::new();
    }
    let mut words = BTreeMap::<String, (usize, usize, usize, bool, usize)>::new();
    let mut start = None;
    for (offset, ch) in text
        .char_indices()
        .chain(std::iter::once((text.len(), ' ')))
    {
        if ch.is_alphanumeric() || matches!(ch, '_' | '-') {
            start.get_or_insert(offset);
        } else if let Some(begin) = start.take() {
            let word = &text[begin..offset];
            if crate::retrieval::tokenize(word).is_empty() {
                continue;
            }
            let normalized = crate::norm::nfc(word).to_lowercase();
            words
                .entry(normalized)
                .and_modify(|word| word.0 += 1)
                .or_insert((
                    1,
                    begin,
                    offset,
                    word.contains(['_', '-']),
                    word.chars().count(),
                ));
        }
    }
    let mut words: Vec<_> = words.into_values().collect();
    words.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| b.3.cmp(&a.3))
            .then_with(|| b.4.cmp(&a.4))
            .then_with(|| a.1.cmp(&b.1))
    });
    let mut ranges = Vec::new();
    if let Some((_, begin, end, _, _)) = words.first() {
        let middle = boundaries.binary_search(begin).unwrap_or(0);
        let word_end = boundaries.binary_search(end).unwrap_or(middle);
        let mut first = middle.saturating_sub(128);
        let last = (first + 256).min(count).max(word_end.min(middle + 256));
        first = last.saturating_sub(256);
        ranges.push((boundaries[first], boundaries[last]));
    }
    ranges.push((0, boundaries[count.min(256)]));
    ranges.push((boundaries[count.saturating_sub(256)], text.len()));
    let mut seen = HashSet::new();
    ranges
        .into_iter()
        .filter_map(|(begin, end)| {
            let original = &text[begin..end];
            let phrase = original.trim();
            let start = begin + original.len() - original.trim_start().len();
            let range = (start, start + phrase.len());
            (!phrase.is_empty()
                && !crate::retrieval::tokenize(phrase).is_empty()
                && seen.insert(range))
            .then_some(range)
        })
        .collect()
}

/// Rotate pages before spending a bounded candidate budget on another chunk.
fn diversify_hits(hits: Vec<Bm25Hit>) -> Vec<Bm25Hit> {
    let mut pages = Vec::<(String, Vec<Bm25Hit>)>::new();
    for hit in hits {
        if let Some((_, group)) = pages.iter_mut().find(|(page, _)| page == &hit.page) {
            group.push(hit);
        } else {
            pages.push((hit.page.clone(), vec![hit]));
        }
    }
    let mut result = Vec::new();
    for ordinal in 0..pages
        .iter()
        .map(|(_, group)| group.len())
        .max()
        .unwrap_or(0)
    {
        result.extend(
            pages
                .iter()
                .filter_map(|(_, group)| group.get(ordinal))
                .cloned(),
        );
    }
    result
}

/// App-issued phrases use exact original windows, never a model action string.
pub(crate) fn task_keys(claims: &CheckedClaims) -> Result<(Vec<ResolutionTaskKey>, bool), String> {
    let mut anchors = Vec::new();
    let mut seen = HashSet::new();
    let mut omitted = false;
    for claim in &claims.claims {
        if !claim.structure_checked || !claim.semantic_review_required {
            return Err("resolution task key lacks source/structure checks".into());
        }
        let anchor = claim
            .provenance
            .iter()
            .find(|span| span.id() == claim.proposal.anchor_span_id)
            .ok_or("resolution task key lacks its original anchor")?;
        if !seen.insert(anchor.id()) {
            continue;
        }
        if anchors.len() == MAX_KEYS {
            omitted = true;
            continue;
        }
        omitted |= anchor.text().chars().count() > 256;
        let ranges = native_windows(anchor.text());
        omitted |= ranges.is_empty();
        anchors.push((anchor, ranges));
    }
    let mut keys = Vec::new();
    let rounds = anchors
        .iter()
        .map(|(_, ranges)| ranges.len())
        .max()
        .unwrap_or(0);
    for ordinal in 0..rounds {
        for (anchor, ranges) in &anchors {
            let Some(&(start, end)) = ranges.get(ordinal) else {
                continue;
            };
            if keys.len() == MAX_KEYS {
                omitted = true;
                continue;
            }
            let phrase = &anchor.text()[start..end];
            let phrase_start = anchor.start() + start;
            let phrase_end = anchor.start() + end;
            keys.push(ResolutionTaskKey {
                id: key_id(anchor, phrase_start, phrase_end),
                anchor_span_id: anchor.id().into(),
                exact_phrase: phrase.into(),
                phrase_start,
                phrase_end,
                phrase_sha256: format!("{:x}", Sha256::digest(phrase.as_bytes())),
                source_revision: anchor.source_revision().into(),
                span_sha256: anchor.span_sha256().into(),
                speaker: anchor.speaker(),
                turn_time: anchor.turn_time().map(str::to_owned),
                source_phase: anchor.source_phase().map(str::to_owned),
                original: (*anchor).clone(),
            });
        }
    }
    Ok((keys, omitted))
}

fn frozen_key(key: &ResolutionTaskKey, initial: &SourceSet) -> bool {
    let Some(original) = initial.spans().find(|span| span.id() == key.anchor_span_id) else {
        return false;
    };
    let Some(start) = key.phrase_start.checked_sub(original.start()) else {
        return false;
    };
    let Some(end) = key.phrase_end.checked_sub(original.start()) else {
        return false;
    };
    *original == key.original
        && original.text().get(start..end) == Some(key.exact_phrase.as_str())
        && key.source_revision == original.source_revision()
        && key.span_sha256 == original.span_sha256()
        && key.phrase_sha256 == format!("{:x}", Sha256::digest(key.exact_phrase.as_bytes()))
        && key.speaker == original.speaker()
        && key.turn_time.as_deref() == original.turn_time()
        && key.source_phase.as_deref() == original.source_phase()
        && native_windows(original.text()).contains(&(start, end))
        && key.id == key_id(original, key.phrase_start, key.phrase_end)
}

fn keeps(page: &str, scope: Scope, paths: Option<&[String]>, include_archived: bool) -> bool {
    scope.keeps(page)
        && paths.map_or(true, |paths| paths.iter().any(|path| path == page))
        && !crate::vector_index::is_cold_for(page, include_archived)
        && page.len() <= 1024
        && !page.contains(['[', ']', '|'])
        && !page.chars().any(char::is_control)
        && Path::new(page)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}

fn read_source(
    root: &Path,
    page: &str,
    remaining: usize,
    bytes_read: &mut usize,
) -> Result<String, String> {
    super::compiled_sources::read_bound(
        root,
        page,
        FILE_BYTES,
        bytes_read.saturating_add(remaining),
        bytes_read,
    )
}

/// The metadata cutoff selects records; it never fills a claim's eventTime.
/// Day-only record dates need their entire uncertainty interval inside as-of.
fn eligible_time(span: &SourceSpan, window: &ResolutionWindow) -> Result<bool, &'static str> {
    let (start, end) = super::period_context::record_interval(span).ok_or("undated")?;
    if start >= window.end_epoch {
        return Err("after_as_of");
    }
    if end > window.end_epoch {
        return Err("undated");
    }
    Ok(end > window.start_epoch)
}

fn declaration(
    page: &str,
    citation_revision: &str,
    title: Option<String>,
    stem: String,
    set: &SourceSet,
    origin: &AgentVaultSession,
    scope: Scope,
) -> AdditionalSourceDeclaration {
    let mut lineage: BTreeMap<(String, String), Vec<OriginalSpanDeclaration>> = BTreeMap::new();
    for span in set.spans().filter(|span| span.selection_path() == page) {
        lineage
            .entry((span.source_path().into(), span.source_revision().into()))
            .or_default()
            .push(OriginalSpanDeclaration {
                id: span.id().into(),
                start: span.start(),
                end: span.end(),
                sha256: span.span_sha256().into(),
                speaker: span.speaker(),
                turn_time: span.turn_time().map(str::to_owned),
                record_time: span.record_time().map(str::to_owned),
                source_phase: span.source_phase().map(str::to_owned),
            });
    }
    AdditionalSourceDeclaration {
        citation_page: page.into(),
        citation_revision: citation_revision.into(),
        title,
        stem,
        origin: origin.clone(),
        scope,
        lineage: lineage
            .into_iter()
            .map(
                |((source_path, source_revision), spans)| OriginalLineageDeclaration {
                    source_path,
                    source_revision,
                    spans,
                },
            )
            .collect(),
    }
}

/// Caller authenticates the native opening before this read and again after
/// inference. This helper enforces filesystem confinement and original SHA/span
/// binding, but deliberately does not establish semantic subject identity.
pub(crate) fn read(
    request: ResolutionRead<'_>,
    cancelled: &AtomicBool,
) -> Result<ResolutionSources, String> {
    let root = request
        .root
        .canonicalize()
        .map_err(|_| "resolution vault unavailable")?;
    if Path::new(&request.origin.vault_path) != root || request.origin.opening_token.is_empty() {
        return Err("resolution opening origin does not match its vault".into());
    }
    request.initial.validate(
        r#"{"outcome":"insufficient_evidence","claims":[]}"#,
        request.origin,
        request.scope,
    )?;
    if request.task_keys.len() > MAX_KEYS
        || request
            .task_keys
            .iter()
            .any(|key| !frozen_key(key, request.initial))
    {
        return Err("resolution key is not bound to the frozen initial original".into());
    }
    let mut coverage = ResolutionCoverage {
        incomplete: request.index.is_empty()
            || request
                .task_keys
                .iter()
                .any(|key| key.original.text().char_indices().nth(256).is_some()),
        ..Default::default()
    };
    // Final source sections have their own bounded channel, so repeated early
    // chatter cannot consume every later-state candidate before fresh reads.
    let page_sections: BTreeMap<_, _> = request
        .index
        .page_names()
        .filter(|page| keeps(page, request.scope, request.paths, request.include_archived))
        .filter_map(|page| {
            request
                .index
                .page_hashes(page)
                .map(|hashes| (page, hashes.len()))
        })
        .collect();
    let mut queues = Vec::new();
    let mut available = HashSet::new();
    for key in request.task_keys {
        if cancelled.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        for tail_only in [false, true] {
            let candidates = request.index.search_where(
                &key.exact_phrase,
                MAX_CANDIDATES + 1,
                |page, section| {
                    keeps(page, request.scope, request.paths, request.include_archived)
                        && (!tail_only
                            || page_sections
                                .get(page)
                                .is_some_and(|count| section >= count.saturating_sub(2)))
                },
            );
            coverage.incomplete |= candidates.len() > MAX_CANDIDATES;
            available.extend(candidates.iter().map(|hit| (hit.page.clone(), hit.section)));
            queues.push(diversify_hits(candidates));
        }
    }
    let mut hits = Vec::new();
    let mut selected = HashSet::new();
    let rounds = queues.iter().map(Vec::len).max().unwrap_or(0);
    'rounds: for ordinal in 0..rounds {
        for queue in &queues {
            let Some(hit) = queue.get(ordinal) else {
                continue;
            };
            if selected.insert((hit.page.clone(), hit.section)) {
                hits.push(hit.clone());
                if hits.len() == MAX_CANDIDATES {
                    break 'rounds;
                }
            }
        }
    }
    coverage.incomplete |= available.len() > hits.len();
    coverage.candidate_chunks = hits.len();
    let mut pages = Vec::<(String, Vec<usize>)>::new();
    for hit in hits {
        if let Some((_, sections)) = pages.iter_mut().find(|(page, _)| page == &hit.page) {
            sections.push(hit.section);
        } else {
            pages.push((hit.page, vec![hit.section]));
        }
    }
    coverage.incomplete |= pages.len() > MAX_PAGES;
    let mut evidence = Vec::new();
    let mut documents = Vec::new();
    let mut revisions = BTreeMap::new();
    let mut declarations = Vec::new();
    let mut admitted_spans = 0;
    for (page, sections) in pages.into_iter().take(MAX_PAGES) {
        if cancelled.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        if coverage.read_bytes >= TOTAL_BYTES || admitted_spans >= MAX_SPANS {
            coverage.incomplete = true;
            break;
        }
        let confined = crate::vault::confine_path(&root, &root.join(&page).to_string_lossy())?;
        let resolved = confined
            .strip_prefix(&root)
            .ok()
            .and_then(Path::to_str)
            .ok_or("resolution path identity unavailable")?;
        if !keeps(
            resolved,
            request.scope,
            request.paths,
            request.include_archived,
        ) {
            return Err("resolved resolution source is outside scope".into());
        }
        let remaining = TOTAL_BYTES.saturating_sub(coverage.read_bytes);
        let source = match read_source(&root, &page, remaining, &mut coverage.read_bytes) {
            Ok(source) => source,
            Err(reason) => {
                coverage.incomplete = true;
                coverage.issues.push(ResolutionIssue {
                    citation_page: page.clone(),
                    code: if reason.contains("budget") {
                        "read_budget"
                    } else {
                        "source_unavailable"
                    },
                });
                continue;
            }
        };
        coverage.scanned_pages += 1;
        let chunks = chunk_page(&source);
        let hashes: Vec<_> = chunks.iter().map(|chunk| content_hash(chunk)).collect();
        if request.index.page_hashes(&page).as_ref() != Some(&hashes) {
            coverage.incomplete = true;
            coverage.issues.push(ResolutionIssue {
                citation_page: page.clone(),
                code: "index_stale",
            });
            continue;
        }
        let mut read_bytes = coverage.read_bytes;
        let bound = match original_activity_inputs_with_limits(
            &root,
            &page,
            &source,
            &chunks,
            &sections,
            &mut read_bytes,
            request.include_archived,
            Limits {
                total_bytes: TOTAL_BYTES.saturating_sub(1),
                file_bytes: FILE_BYTES,
                ..Limits::default()
            },
        ) {
            Ok(bound) => bound,
            Err(_reason) => {
                coverage.read_bytes = read_bytes;
                coverage.incomplete = true;
                coverage.issues.push(ResolutionIssue {
                    citation_page: page.clone(),
                    code: "original_proof_unavailable",
                });
                continue;
            }
        };
        coverage.read_bytes = read_bytes;
        coverage.incomplete |= bound.incomplete;
        let guard_revisions = bound.guard_revisions;
        let candidate = SourceSet::new(
            request.origin.clone(),
            request.scope,
            bound.documents,
            vec![],
        )?;
        let mut allowed = HashSet::new();
        // Prefer later exact original coordinates within a page's bounded
        // packet. This does not infer eventTime or same-task identity.
        let mut span_order: Vec<_> = candidate.spans().collect();
        span_order.sort_by(|a, b| {
            b.end()
                .cmp(&a.end())
                .then_with(|| a.source_path().cmp(b.source_path()))
                .then_with(|| a.id().cmp(b.id()))
        });
        for span in span_order {
            if request
                .initial
                .spans()
                .any(|old| old.same_original_turn(span))
            {
                continue;
            }
            match eligible_time(span, request.window) {
                Ok(true) if admitted_spans < MAX_SPANS => {
                    allowed.insert(span.id().to_owned());
                    admitted_spans += 1;
                }
                Ok(true) => coverage.incomplete = true,
                Ok(false) => {}
                Err("after_as_of") => {
                    coverage.excluded_after_as_of_spans += 1;
                }
                Err(_) => {
                    coverage.undated_spans += 1;
                    coverage.incomplete = true;
                    if !coverage.issues.iter().any(|issue| {
                        issue.citation_page == page && issue.code == "record_time_uncertain"
                    }) {
                        coverage.issues.push(ResolutionIssue {
                            citation_page: page.clone(),
                            code: "record_time_uncertain",
                        });
                    }
                }
            }
        }
        let candidate = candidate.retained(|span| allowed.contains(span.id()))?;
        if candidate.spans().next().is_none() {
            continue;
        }
        let revision = format!("{:x}", Sha256::digest(source.as_bytes()));
        revisions.insert(page.clone(), revision.clone());
        for (path, revision) in guard_revisions {
            if revisions
                .insert(path, revision.clone())
                .is_some_and(|old| old != revision)
            {
                return Err("resolution imported lineage changed between candidates".into());
            }
        }
        for span in candidate.spans() {
            if revisions
                .insert(span.source_path().into(), span.source_revision().into())
                .is_some_and(|old| old != span.source_revision())
            {
                return Err("resolution original source changed between candidates".into());
            }
        }
        let stem = Path::new(&page)
            .file_stem()
            .and_then(|stem| stem.to_str())
            .ok_or("resolution source stem unavailable")?
            .to_owned();
        let title =
            super::source_title(&source).filter(|title| !title.chars().any(char::is_control));
        declarations.push(declaration(
            &page,
            &revision,
            title.clone(),
            stem.clone(),
            &candidate,
            request.origin,
            request.scope,
        ));
        evidence.push(Evidence {
            page: page.clone(),
            stem,
            title,
            section: sections[0],
            text: chunks[sections[0]].clone(),
            compiled: None,
        });
        documents.extend(candidate.documents().iter().cloned());
        coverage.admitted_pages += 1;
    }
    let originals = SourceSet::new(request.origin.clone(), request.scope, documents, vec![])?;
    coverage.original_spans = originals.spans().count();
    Ok(ResolutionSources {
        evidence,
        originals,
        declarations,
        coverage,
        revisions,
    })
}

/// Publish declarations only for cited pages and exact app-windowed answer spans.
pub(crate) fn answer_declarations(
    declarations: &[AdditionalSourceDeclaration],
    used_sources: &[String],
    selected: &[SourceSpan],
) -> Vec<AdditionalSourceDeclaration> {
    declarations
        .iter()
        .filter(|declaration| used_sources.contains(&declaration.citation_page))
        .filter_map(|declaration| {
            let mut value = declaration.clone();
            let mut grouped = BTreeMap::<(String, String), Vec<OriginalSpanDeclaration>>::new();
            for span in selected.iter().filter(|span| {
                span.selection_path() == declaration.citation_page
                    && declaration.lineage.iter().any(|original| {
                        original.source_path == span.source_path()
                            && original.source_revision == span.source_revision()
                            && original.spans.iter().any(|admitted| {
                                admitted.start <= span.start() && span.end() <= admitted.end
                            })
                    })
            }) {
                grouped
                    .entry((span.source_path().into(), span.source_revision().into()))
                    .or_default()
                    .push(OriginalSpanDeclaration {
                        id: span.id().into(),
                        start: span.start(),
                        end: span.end(),
                        sha256: span.span_sha256().into(),
                        speaker: span.speaker(),
                        turn_time: span.turn_time().map(str::to_owned),
                        record_time: span.record_time().map(str::to_owned),
                        source_phase: span.source_phase().map(str::to_owned),
                    });
            }
            if grouped.is_empty() {
                return None;
            }
            value.lineage = grouped
                .into_iter()
                .map(
                    |((source_path, source_revision), spans)| OriginalLineageDeclaration {
                        source_path,
                        source_revision,
                        spans,
                    },
                )
                .collect();
            Some(value)
        })
        .collect()
}

/// Re-read every admitted citation and backing original with a native bound.
/// A changed source produces failure rather than publishing an obsolete answer.
pub(crate) fn recheck(
    root: &Path,
    revisions: &BTreeMap<String, String>,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    let mut bytes = 0;
    for (page, revision) in revisions {
        if cancelled.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let remaining = TOTAL_BYTES.saturating_sub(bytes);
        let source = read_source(root, page, remaining, &mut bytes)?;
        if format!("{:x}", Sha256::digest(source.as_bytes())) != *revision {
            return Err("resolution source changed during generation".into());
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "resolution_tests.rs"]
mod tests;
