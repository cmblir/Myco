//! Rebind compiled-page coordinate hints to current imported originals.
//! Public summary/ownership markers confer neither meaning nor publication authority.

use super::{ActivitySourceInputs, Limits, OriginalSelectionTime};
use crate::embeddings::chunk_page;
use crate::wiki_claims::{ActorRole, SourceDocument, SpanInput};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs::{File, Metadata};
use std::io::Read;
use std::path::{Component, Path};

const RESERVED: &str = "myco:session-compilation";
const START: &str = "<!-- myco:session-compilation:v1 ";
const END: &str = "<!-- /myco:session-compilation -->";
const CLAIM_RESERVED: &str = "myco:claim-metadata";
const CLAIM: &str = "<!-- myco:claim-metadata ";
const MAX_HINTS: usize = 512;
const MAX_COMMENT_BYTES: usize = 64 * 1024;
const UNAVAILABLE: &str = "compiled_source_lineage_unavailable";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Marker {
    session_key: String,
    source_revision: String,
    compile_signature: String,
    artifact_revision: String,
    nonce: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClaimHint {
    #[serde(rename = "actor")]
    _actor: serde_json::Value,
    #[serde(rename = "eventTime")]
    _event_time: serde_json::Value,
    #[serde(rename = "speechAct")]
    _speech_act: serde_json::Value,
    #[serde(rename = "status")]
    _status: serde_json::Value,
    #[serde(rename = "independentVerification")]
    _independent_verification: bool,
    source_spans: Vec<SpanHint>,
}

#[derive(Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpanHint {
    id: String,
    source_id: String,
    source_path: String,
    selection_path: String,
    source_revision: String,
    start: usize,
    end: usize,
    sha256: String,
    turn_id: String,
    speaker: ActorRole,
    record_time: Option<String>,
    turn_time: Option<String>,
    source_phase: Option<String>,
}

fn error(reason: &str) -> String {
    format!("{UNAVAILABLE}: {reason}")
}

fn sha(text: &[u8]) -> String {
    format!("{:x}", Sha256::digest(text))
}

fn native_id(prefix: &str, identity: &str) -> String {
    format!("{prefix}-{}", &sha(identity.as_bytes())[..32])
}

fn hex(value: &str, size: usize) -> bool {
    value.len() == size
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn normal_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 1024
        && !path.contains(['[', ']', '|'])
        && !path.chars().any(char::is_control)
        && Path::new(path)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}

fn regular(metadata: &Metadata) -> bool {
    if !metadata.is_file() || crate::vault::is_dataless(metadata) {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return false;
        }
    }
    true
}

fn same_file(a: &Metadata, b: &Metadata) -> bool {
    let (Ok(a_modified), Ok(b_modified)) = (a.modified(), b.modified()) else {
        return false;
    };
    if !regular(a) || !regular(b) || a.len() != b.len() || a_modified != b_modified {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if (a.dev(), a.ino(), a.ctime(), a.ctime_nsec())
            != (b.dev(), b.ino(), b.ctime(), b.ctime_nsec())
        {
            return false;
        }
    }
    true
}

/// Charge every byte, including a growth sentinel, and retain file custody.
/// No archive substitution, symlink following, or legacy ledger backfill occurs.
pub(super) fn read_bound(
    root: &Path,
    relative: &str,
    file_limit: usize,
    total_limit: usize,
    bytes_read: &mut usize,
) -> Result<String, String> {
    if !normal_path(relative) {
        return Err(error("invalid source path"));
    }
    let named = root.join(relative);
    let path = crate::vault::confine_delete_path(root, &named.to_string_lossy())
        .map_err(|_| error("source path custody unavailable"))?;
    let before =
        std::fs::symlink_metadata(&path).map_err(|_| error("source missing or unreadable"))?;
    let bound = file_limit.min(total_limit.saturating_sub(*bytes_read).saturating_sub(1));
    if !regular(&before) || before.len() > bound as u64 {
        return Err(error(
            "source exceeds native read budget or regular-file custody",
        ));
    }
    let mut file = File::open(&path).map_err(|_| error("source unavailable"))?;
    let opened = file
        .metadata()
        .map_err(|_| error("source identity unavailable"))?;
    if !same_file(&before, &opened) {
        return Err(error("source identity changed before read"));
    }
    let mut bytes = Vec::new();
    let read = (&mut file)
        .take(bound.saturating_add(1) as u64)
        .read_to_end(&mut bytes);
    *bytes_read = bytes_read.saturating_add(bytes.len());
    read.map_err(|_| error("source read failed"))?;
    if bytes.len() > bound || bytes.len() as u64 != before.len() {
        return Err(error("source grew or changed during bounded read"));
    }
    let after = file
        .metadata()
        .map_err(|_| error("source identity unavailable"))?;
    let confined = crate::vault::confine_delete_path(root, &named.to_string_lossy())
        .map_err(|_| error("source custody changed during read"))?;
    let current =
        std::fs::symlink_metadata(confined).map_err(|_| error("source identity unavailable"))?;
    if !same_file(&opened, &after) || !same_file(&opened, &current) {
        return Err(error("source identity changed during read"));
    }
    String::from_utf8(bytes).map_err(|_| error("source is not UTF-8"))
}

fn comment<T: serde::de::DeserializeOwned>(text: &str, prefix: &str) -> Result<(T, usize), String> {
    let rest = text
        .strip_prefix(prefix)
        .ok_or_else(|| error("invalid reserved marker"))?;
    let end = rest
        .find(" -->")
        .filter(|end| *end <= MAX_COMMENT_BYTES)
        .ok_or_else(|| error("reserved marker is truncated or exceeds bounds"))?;
    let value =
        serde_json::from_str(&rest[..end]).map_err(|_| error("reserved marker JSON is invalid"))?;
    Ok((value, prefix.len() + end + " -->".len()))
}

/// Match indexed chunks by heading-section ordinal and consecutive native
/// byte ranges. Repeated text cannot select an earlier occurrence in a page.
fn chunk_ranges(content: &str, chunks: &[String]) -> Result<Vec<(usize, usize)>, String> {
    let normalized = crate::norm::nfc(content);
    let parsed = gray_matter::Matter::<gray_matter::engine::YAML>::new()
        .parse::<gray_matter::Pod>(&normalized)
        .map_err(|_| error("compiled frontmatter invalid"))?;
    let body = parsed.content;
    let header_end = super::frontmatter_header(&normalized).map_or(0, str::len);
    let tail = &normalized[header_end..];
    let body_start = header_end + tail.len() - tail.trim_start_matches('\n').len();
    if normalized[body_start..].trim_end_matches('\n') != body {
        return Err(error("compiled body coordinates ambiguous"));
    }
    let mut sections = Vec::new();
    let mut section_start = 0;
    let mut offset = 0;
    for line in body.split_inclusive('\n') {
        if (line.starts_with('#') || crate::embeddings::is_transcript_turn_header(line))
            && !body[section_start..offset].trim().is_empty()
        {
            sections.push((section_start, offset));
            section_start = offset;
        }
        offset += line.len();
    }
    if !body[section_start..].trim().is_empty() {
        sections.push((section_start, body.len()));
    }
    let mut ranges = Vec::new();
    for (start, end) in sections {
        let text = &body[start..end];
        let section_chunks = chunk_page(text);
        let mut cursor = 0;
        for chunk in section_chunks {
            if chunks.get(ranges.len()) != Some(&chunk) {
                return Err(error("compiled indexed section identity changed"));
            }
            let rest = &text[cursor..];
            let offset = rest
                .find(&chunk)
                .ok_or_else(|| error("compiled chunk byte mapping unavailable"))?;
            if !rest[..offset].trim().is_empty() {
                return Err(error("compiled chunk byte mapping ambiguous"));
            }
            let begin = cursor + offset;
            let finish = begin + chunk.len();
            ranges.push((body_start + start + begin, body_start + start + finish));
            cursor = finish;
        }
        if !text[cursor..].trim().is_empty() {
            return Err(error("compiled chunk mapping omits body bytes"));
        }
    }
    if ranges.len() != chunks.len() {
        return Err(error("compiled indexed chunk count changed"));
    }
    Ok(ranges)
}

fn record_time(original: &str) -> Option<String> {
    let value = super::metadata(original)?;
    ["created", "last_updated"].into_iter().find_map(|field| {
        let time = value.get(field)?.as_str()?;
        let parsed = if time.len() == 10 {
            crate::importers::parse_iso8601(&format!("{time}T00:00:00Z"))
        } else {
            crate::importers::parse_iso8601(time)
        };
        parsed.map(|_| time.to_owned())
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn bind(
    root: &Path,
    page: &str,
    content: &str,
    chunks: &[String],
    requested: &[usize],
    bytes_read: &mut usize,
    include_archived: bool,
    limits: Limits,
) -> Result<Option<ActivitySourceInputs>, String> {
    if !content.contains(RESERVED) && !content.contains(CLAIM_RESERVED) {
        return Ok(None);
    }
    if !normal_path(page)
        || !page.starts_with("wiki/")
        || chunk_page(content) != chunks
        || requested.is_empty()
        || requested.iter().any(|section| *section >= chunks.len())
        || content.matches(RESERVED).count() != 2
        || content.matches(START).count() != 1
        || content.matches(END).count() != 1
    {
        return Err(error(
            "compiled layout is malformed or outside selected wiki scope",
        ));
    }
    let selected = crate::vault::confine_delete_path(root, &root.join(page).to_string_lossy())
        .map_err(|_| error("selected page custody unavailable"))?;
    if !std::fs::symlink_metadata(selected).is_ok_and(|metadata| regular(&metadata)) {
        return Err(error("selected page custody unavailable"));
    }
    let start = content
        .find(START)
        .ok_or_else(|| error("compiled marker missing"))?;
    let (marker, marker_len) = comment::<Marker>(&content[start..], START)?;
    let begin = start + marker_len;
    let end = content[begin..]
        .find(END)
        .map(|offset| begin + offset)
        .ok_or_else(|| error("compiled closing marker missing"))?;
    if !hex(&marker.source_revision, 64)
        || !hex(&marker.compile_signature, 64)
        || !hex(&marker.artifact_revision, 64)
        || !hex(&marker.nonce, 32)
    {
        return Err(error("compiled marker identity invalid"));
    }
    let vendor = marker
        .session_key
        .split_once(':')
        .map(|(vendor, _)| vendor)
        .filter(|vendor| matches!(*vendor, "codex" | "claude-code" | "claude" | "chatgpt"))
        .ok_or_else(|| error("unsupported imported source identity"))?;
    let canonical_page = format!(
        "wiki/source-session-{vendor}-{}.md",
        &sha(marker.session_key.as_bytes())[..16]
    );
    if page != canonical_page {
        return Err(error(
            "custom or copied summary path has no bounded native catalog proof",
        ));
    }
    let metadata = super::metadata(content).ok_or_else(|| error("compiled metadata missing"))?;
    let raw_path = metadata
        .get("raw_path")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| error("compiled raw identity missing"))?;
    if metadata
        .get("session_key")
        .and_then(serde_json::Value::as_str)
        != Some(marker.session_key.as_str())
        || metadata
            .get("session_revision")
            .and_then(serde_json::Value::as_str)
            != Some(marker.source_revision.as_str())
        || !normal_path(raw_path)
        || !raw_path.starts_with(&format!("raw/conversations/{vendor}/"))
        || Path::new(raw_path).components().count() != 4
        || !raw_path.ends_with(".md")
        || crate::vector_index::is_cold_for(raw_path, include_archived)
    {
        return Err(error("compiled session and raw identity conflict"));
    }
    let generated = &content[begin..end];
    if content[..begin].contains(CLAIM_RESERVED)
        || content[end..].contains(CLAIM_RESERVED)
        || generated.matches(CLAIM_RESERVED).count() != generated.matches(CLAIM).count()
        || generated.matches(CLAIM).count() > MAX_HINTS
    {
        return Err(error(
            "claim markers are malformed or outside generated block",
        ));
    }
    let mut hints = BTreeMap::<(usize, usize), SpanHint>::new();
    let mut statement_ranges = Vec::new();
    let mut cursor = begin;
    while let Some(offset) = content[cursor..end].find(CLAIM) {
        let at = cursor + offset;
        let (claim, length) = comment::<ClaimHint>(&content[at..end], CLAIM)?;
        if claim.source_spans.is_empty() || claim.source_spans.len() > MAX_HINTS {
            return Err(error("compiled claim has no bounded original hints"));
        }
        let statement = content[cursor..at]
            .rfind("\n- ")
            .map(|offset| cursor + offset + 1)
            .or_else(|| content[cursor..at].starts_with("- ").then_some(cursor))
            .ok_or_else(|| error("compiled claim has no associated statement"))?;
        statement_ranges.push((statement, at));
        for hint in claim.source_spans {
            if hint.source_path != raw_path
                || hint.source_revision != marker.source_revision
                || (hint.selection_path != raw_path && hint.selection_path != page)
                || hint.id.len() > 256
                || hint.source_id.len() > 256
            {
                return Err(error("compiled hints mix source or selection identities"));
            }
            let key = (hint.start, hint.end);
            if let Some(old) = hints.get(&key) {
                if old != &hint {
                    return Err(error("duplicate original coordinates conflict"));
                }
            } else {
                hints.insert(key, hint);
            }
            if hints.len() > MAX_HINTS {
                return Err(error("compiled original hints exceed native span budget"));
            }
        }
        cursor = at + length;
    }
    if hints.is_empty() {
        return Err(error("compiled summary has no original claim coordinates"));
    }
    let normalized = crate::norm::nfc(content);
    // Convert statement offsets independently; raw source offsets remain NFD.
    let mut normalized_ranges = Vec::new();
    let mut original_cursor = 0;
    let mut normalized_cursor = 0;
    for (start, end) in statement_ranges {
        // These boundaries are ASCII line/comment delimiters, so composition
        // cannot cross them. Each input byte is normalized only once here.
        normalized_cursor += crate::norm::nfc(&content[original_cursor..start]).len();
        let normalized_start = normalized_cursor;
        normalized_cursor += crate::norm::nfc(&content[start..end]).len();
        normalized_ranges.push((normalized_start, normalized_cursor));
        original_cursor = end;
    }
    let ranges = chunk_ranges(&normalized, chunks)?;
    let sections: Vec<_> = ranges
        .iter()
        .map(|(start, end)| {
            normalized_ranges
                .iter()
                .any(|(statement_start, statement_end)| {
                    start < statement_end && statement_start < end
                })
        })
        .collect();
    if !requested.iter().any(|section| sections[*section]) {
        return Ok(Some(ActivitySourceInputs {
            sections: Some(sections),
            documents: vec![],
            section_times: Some(vec![vec![]; chunks.len()]),
            guard_revisions: BTreeMap::new(),
            incomplete: false,
            unavailable_inputs: false,
        }));
    }

    let original = read_bound(
        root,
        raw_path,
        limits.file_bytes,
        limits.total_bytes,
        bytes_read,
    )?;
    if sha(original.as_bytes()) != marker.source_revision
        || crate::judge::frontmatter_key(&original) != marker.session_key
    {
        return Err(error(
            "current original full revision or session key changed",
        ));
    }
    let fingerprint = crate::importers::ledger::fingerprint(&original);
    let ledger_path = format!("{}/ledger.json", crate::vault_dir::DIR_NAME);
    let ledger_text = read_bound(
        root,
        &ledger_path,
        limits.file_bytes,
        limits.total_bytes,
        bytes_read,
    )?;
    if !serde_json::from_str::<serde_json::Value>(&ledger_text).is_ok_and(|value| value.is_object())
    {
        return Err(error("native ledger snapshot is not an object"));
    }
    let ledger = crate::importers::ledger::Ledger::parse_checked_snapshot(ledger_text.as_bytes())
        .map_err(|_| error("native ledger snapshot invalid"))?;
    if ledger.entry(&marker.session_key) != Some(&fingerprint) {
        return Err(error(
            "original revision is not currently admitted by native ledger",
        ));
    }
    let (destination, projection_path) = ledger
        .location("sessions", &marker.session_key)
        .map(|path| ("sessions", path))
        .or_else(|| {
            ledger
                .location("_inbox", &marker.session_key)
                .map(|path| ("_inbox", path))
        })
        .ok_or_else(|| error("native ledger has no current source projection"))?;
    if !normal_path(projection_path)
        || !projection_path.starts_with(&format!("{destination}/"))
        || !projection_path.ends_with(".md")
        || crate::vector_index::is_cold_for(projection_path, include_archived)
    {
        return Err(error(
            "current source projection is cold or outside native destination",
        ));
    }
    let projection = read_bound(
        root,
        projection_path,
        limits.file_bytes,
        limits.total_bytes,
        bytes_read,
    )?;
    let binding = crate::session_compile::SourceBinding {
        key: marker.session_key,
        raw_path: raw_path.into(),
        source_revision: marker.source_revision.clone(),
    };
    crate::commands::validate_manual_compiler_projection(
        root,
        &binding,
        &original,
        &projection,
        &fingerprint,
    )
    .map_err(|_| error("current imported projection no longer matches exact original"))?;
    let mut turns = super::compilation_original_turns(&original)
        .map_err(|_| error("original turn metadata invalid"))?;
    let body_start = super::frontmatter_header(&original)
        .ok_or_else(|| error("original frontmatter missing"))?
        .len();
    let first = turns
        .first()
        .map_or(original.len(), |turn| turn.header_start);
    if body_start < first {
        turns.insert(
            0,
            super::CompilationOriginalTurn {
                header_start: body_start,
                body_start,
                end: first,
                id: "T-preamble".into(),
                speaker: ActorRole::Unknown,
                timestamp: None,
                phase: None,
            },
        );
    }
    let mut turn_ids = HashSet::new();
    if turns.is_empty() || turns.iter().any(|turn| !turn_ids.insert(turn.id.as_str())) {
        return Err(error("original turn identity missing or ambiguous"));
    }
    let record_time = record_time(&original);
    let mut inputs = Vec::new();
    let mut phases = Vec::new();
    let mut times = Vec::new();
    for hint in hints.into_values() {
        let text = original
            .get(hint.start..hint.end)
            .filter(|text| !text.trim().is_empty())
            .ok_or_else(|| error("original hint exceeds UTF-8 body boundaries"))?;
        let turn = turns
            .iter()
            .find(|turn| {
                turn.body_start <= hint.start && hint.start < hint.end && hint.end <= turn.end
            })
            .ok_or_else(|| error("original hint is outside its native turn body"))?;
        if turn.speaker == ActorRole::Unknown
            && text.lines().any(|line| line.trim_start().starts_with('#'))
        {
            return Err(error("source title scaffolding is not original activity"));
        }
        if hint.turn_id != turn.id
            || hint.speaker != turn.speaker
            || hint.turn_time != turn.timestamp
            || hint.source_phase != turn.phase
            || hint.record_time != record_time
            || sha(text.as_bytes()) != hint.sha256
        {
            return Err(error(
                "original actor/time/phase/turn/span revision conflicts with hint",
            ));
        }
        inputs.push(SpanInput {
            id: native_id(
                "Q",
                &format!(
                    "{page}:{raw_path}:{}:{}:{}",
                    marker.source_revision, hint.start, hint.end
                ),
            ),
            start: hint.start,
            end: hint.end,
            turn_id: turn.id.clone(),
            speaker: turn.speaker,
            turn_time: turn.timestamp.clone(),
        });
        phases.push((turn.id.clone(), turn.phase.clone()));
        let time = OriginalSelectionTime {
            turn_time: turn.timestamp.clone(),
            record_time: record_time.clone(),
        };
        if !times.contains(&time) {
            times.push(time);
        }
    }
    let incomplete = times
        .iter()
        .any(|time| time.turn_time.is_none() && time.record_time.is_none());
    let document = SourceDocument::bind(
        native_id(
            "S",
            &format!("{page}:{raw_path}:{}", marker.source_revision),
        ),
        raw_path.into(),
        page.into(),
        &original,
        record_time,
        inputs,
    )
    .map_err(|_| error("bound original exceeds native source contract"))?
    .with_turn_phases(&phases)
    .map_err(|_| error("bound original phase invalid"))?;
    let section_times = sections
        .iter()
        .map(|selected| if *selected { times.clone() } else { vec![] })
        .collect();
    Ok(Some(ActivitySourceInputs {
        sections: Some(sections),
        documents: vec![document],
        section_times: Some(section_times),
        guard_revisions: BTreeMap::from([
            (ledger_path, sha(ledger_text.as_bytes())),
            (projection_path.into(), sha(projection.as_bytes())),
        ]),
        incomplete,
        unavailable_inputs: false,
    }))
}
