//! Exact original turn bindings for activity claim proposals.

use super::{frontmatter_header, metadata, CuratedQuote};
use crate::embeddings::{chunk_page, is_transcript_turn_header};
use crate::wiki_claims::{ActorRole, SourceDocument, SpanInput};
use sha2::{Digest, Sha256};

pub(crate) struct OriginalTurn {
    pub(crate) header_start: usize,
    pub(crate) body_start: usize,
    pub(crate) end: usize,
    pub(crate) id: String,
    pub(crate) speaker: ActorRole,
    pub(crate) timestamp: Option<String>,
    pub(crate) phase: Option<String>,
}

fn key(prefix: &str, identity: &str) -> String {
    let hash = format!("{:x}", Sha256::digest(identity.as_bytes()));
    format!("{prefix}-{}", &hash[..32])
}

fn document_start(source: &str) -> usize {
    source
        .strip_prefix("# ")
        .and_then(|_| source.split_once("\n\n"))
        .filter(|(_, rest)| rest.starts_with("---\n"))
        .map_or(0, |(_, rest)| source.len() - rest.len())
}

pub(crate) fn original_turns(source: &str) -> Result<Vec<OriginalTurn>, String> {
    let document = document_start(source);
    let doc = &source[document..];
    let body_start = document + frontmatter_header(doc).map_or(0, str::len);
    let value = metadata(doc);
    let turn_metadata = value.as_ref().and_then(|value| value.get("turn_metadata"));
    let mut headers = Vec::new();
    let mut cursor = body_start;
    for line in source[body_start..].split_inclusive('\n') {
        if is_transcript_turn_header(line) {
            let speaker = match line.trim() {
                "**User:**" => ActorRole::User,
                "**Assistant:**" => ActorRole::Assistant,
                "**System:**" => ActorRole::System,
                "**Tool:**" => ActorRole::Tool,
                _ => return Err("unsupported original transcript role".into()),
            };
            headers.push((cursor, cursor + line.len(), speaker));
        }
        cursor += line.len();
    }
    let turn_metadata = match turn_metadata {
        Some(value) => Some(
            value
                .as_array()
                .filter(|values| values.len() == headers.len())
                .ok_or("original transcript metadata does not match its turns")?,
        ),
        None => None,
    };
    headers
        .iter()
        .enumerate()
        .map(|(ordinal, &(header_start, start, speaker))| {
            let value = turn_metadata.and_then(|values| values.get(ordinal));
            if let Some(role) = value
                .and_then(|value| value.get("original_role"))
                .filter(|role| !role.is_null())
            {
                let original_role = match role.as_str().map(str::to_ascii_lowercase).as_deref() {
                    Some("user" | "human") => ActorRole::User,
                    Some("assistant") => ActorRole::Assistant,
                    Some("system") => ActorRole::System,
                    Some("tool") => ActorRole::Tool,
                    _ => return Err("unsupported original transcript role metadata".into()),
                };
                if original_role != speaker {
                    return Err(
                        "original transcript role metadata conflicts with its header".into(),
                    );
                }
            }
            let timestamp = match value
                .and_then(|value| value.get("timestamp"))
                .filter(|time| !time.is_null())
            {
                Some(time) => Some(
                    time.as_str()
                        .filter(|time| crate::importers::parse_iso8601(time).is_some())
                        .ok_or("invalid original transcript turn timestamp")?
                        .to_owned(),
                ),
                None => None,
            };
            let phase = match value
                .and_then(|value| value.get("phase").or_else(|| value.get("channel")))
                .filter(|phase| !phase.is_null())
            {
                Some(phase) => Some(
                    phase
                        .as_str()
                        .filter(|phase| {
                            !phase.is_empty()
                                && phase.chars().count() <= 64
                                && !phase.chars().any(char::is_control)
                        })
                        .ok_or("invalid original transcript phase metadata")?
                        .to_owned(),
                ),
                None => None,
            };
            let message_id = value
                .and_then(|value| value.get("message_id"))
                .and_then(serde_json::Value::as_str)
                .filter(|id| !id.is_empty());
            Ok(OriginalTurn {
                header_start,
                body_start: start,
                end: headers
                    .get(ordinal + 1)
                    .map_or(source.len(), |header| header.0),
                id: message_id.map_or_else(|| format!("T{ordinal}"), |id| key("T", id)),
                speaker,
                timestamp,
                phase,
            })
        })
        .collect()
}

fn record_time(source: &str) -> Option<String> {
    let value = metadata(&source[document_start(source)..])?;
    ["last_updated", "created"].into_iter().find_map(|field| {
        let time = value.get(field)?.as_str()?;
        let parsed = if time.len() == 10 {
            crate::importers::parse_iso8601(&format!("{time}T00:00:00Z"))
        } else {
            crate::importers::parse_iso8601(time)
        };
        parsed.map(|_| time.to_owned())
    })
}

/// Retain every original turn for ordinary answer/review closure. The caller
/// has already admitted the selected page and re-read the exact backing revision.
pub(crate) fn bind_all_originals(
    selection_page: &str,
    source_page: &str,
    source: &str,
    expected_revision: &str,
) -> Result<SourceDocument, String> {
    if format!("{:x}", Sha256::digest(source.as_bytes())) != expected_revision {
        return Err("ordinary original revision changed during closure".into());
    }
    let document = document_start(source);
    let body_start = document + frontmatter_header(&source[document..]).map_or(0, str::len);
    if metadata(&source[document..]).is_some_and(|value| value.get("original_source").is_some()) {
        return Err("ordinary original closure cannot certify a partial source copy".into());
    }
    let mut turns = original_turns(source)?;
    let first = turns.first().map_or(source.len(), |turn| turn.header_start);
    if body_start < first && !source[body_start..first].trim().is_empty() {
        turns.insert(
            0,
            OriginalTurn {
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
    let mut inputs = Vec::new();
    let mut phases = Vec::new();
    for turn in turns {
        if source[turn.body_start..turn.end].trim().is_empty() {
            continue;
        }
        inputs.push(SpanInput {
            id: key(
                "Q",
                &format!(
                    "{selection_page}:{source_page}:{expected_revision}:{}:{}",
                    turn.body_start, turn.end
                ),
            ),
            start: turn.body_start,
            end: turn.end,
            turn_id: turn.id.clone(),
            speaker: turn.speaker,
            turn_time: turn.timestamp,
        });
        phases.push((turn.id, turn.phase));
    }
    SourceDocument::bind(
        key(
            "S",
            &format!("{selection_page}:{source_page}:{expected_revision}"),
        ),
        source_page.into(),
        selection_page.into(),
        source,
        record_time(source),
        inputs,
    )?
    .with_turn_phases(&phases)
}

/// Only an exported declaration with its exact data prefix accompanies a selection.
/// Ordinary notes or quoted JSON do not acquire an additional preamble span.
fn provider_session_prefix(
    source: &str,
    first_header: usize,
) -> Result<Option<(usize, usize)>, String> {
    let document = document_start(source);
    let doc = &source[document..];
    let value = metadata(doc);
    let Some(records) = value
        .as_ref()
        .and_then(|value| value.get("turn_metadata"))
        .and_then(serde_json::Value::as_array)
        .and_then(|values| values.first())
        .and_then(|value| value.get("session_provenance"))
    else {
        return Ok(None);
    };
    let records = records
        .as_array()
        .filter(|records| !records.is_empty())
        .ok_or("invalid provider session provenance metadata")?;
    if records.iter().any(|record| {
        record.as_object().map_or(true, |record| {
            record.is_empty()
                || record.keys().any(|key| {
                    !matches!(
                        key.as_str(),
                        "source" | "parent_thread_id" | "forked_from_id" | "thread_source"
                    )
                })
        })
    }) {
        return Err("invalid provider session provenance observation".into());
    }
    let start = document + frontmatter_header(doc).map_or(0, str::len);
    let expected = crate::importers::session_provenance_preamble(records);
    if !source
        .get(start..first_header)
        .is_some_and(|prefix| prefix.ends_with(&expected))
    {
        return Err("provider session provenance prefix differs from its metadata".into());
    }
    Ok(Some((start, first_header)))
}

/// Bind only selected original turns, by section ordinal rather than text
/// similarity. A complete selected turn keeps its later paragraphs and speaker.
pub(crate) fn bind_original_page(
    page: &str,
    source: &str,
    chunks: &[String],
    sections: &[usize],
) -> Result<SourceDocument, String> {
    if sections.is_empty()
        || sections.iter().any(|section| *section >= chunks.len())
        || chunk_page(source) != chunks
    {
        return Err("original claim source sections changed".into());
    }
    let turns = original_turns(source)?;
    let mut inputs = Vec::new();
    let mut phases = Vec::new();
    if turns.is_empty() {
        let document = document_start(source);
        let start = document + frontmatter_header(&source[document..]).map_or(0, str::len);
        if source[start..].trim().is_empty() {
            return Err("original claim source has no body".into());
        }
        inputs.push(SpanInput {
            id: key("Q", &format!("{page}:{start}:{}", source.len())),
            start,
            end: source.len(),
            turn_id: "T0".into(),
            speaker: ActorRole::Unknown,
            turn_time: None,
        });
    } else {
        let prefix = provider_session_prefix(source, turns[0].header_start)?;
        let mut section = chunk_page(&source[..turns[0].header_start]).len();
        for turn in turns {
            let turn_chunks = chunk_page(&source[turn.header_start..turn.end]);
            let next = section + turn_chunks.len();
            if chunks.get(section..next) != Some(turn_chunks.as_slice()) {
                return Err("original turn section boundaries changed".into());
            }
            if sections
                .iter()
                .any(|selected| section <= *selected && *selected < next)
                && !source[turn.body_start..turn.end].trim().is_empty()
            {
                phases.push((turn.id.clone(), turn.phase.clone()));
                inputs.push(SpanInput {
                    id: key("Q", &format!("{page}:{}:{}", turn.body_start, turn.end)),
                    start: turn.body_start,
                    end: turn.end,
                    turn_id: turn.id,
                    speaker: turn.speaker,
                    turn_time: turn.timestamp,
                });
            }
            section = next;
        }
        if section != chunks.len() || inputs.is_empty() {
            return Err("selected claim section has no original turn body".into());
        }
        if let Some((start, end)) = prefix {
            inputs.insert(
                0,
                SpanInput {
                    id: key("Q", &format!("{page}:{start}:{end}")),
                    start,
                    end,
                    turn_id: "T-preamble".into(),
                    speaker: ActorRole::Unknown,
                    turn_time: None,
                },
            );
        }
    }
    SourceDocument::bind(
        key("S", page),
        page.into(),
        page.into(),
        source,
        record_time(source),
        inputs,
    )?
    .with_turn_phases(&phases)
}

/// Called only after the curated proof's source SHA, exact span SHA, visible
/// quote and original role/time have been rechecked by curated_sections.
pub(super) fn bind_curated_quote(
    page: &str,
    source: &str,
    quote: &CuratedQuote,
) -> Result<SourceDocument, String> {
    let exact = source
        .get(quote.start..quote.end)
        .filter(|text| !text.is_empty())
        .ok_or("curated claim source span changed")?;
    if format!("{:x}", Sha256::digest(source.as_bytes())) != quote.source_sha256
        || format!("{:x}", Sha256::digest(exact.as_bytes())) != quote.quote_sha256
        || quote
            .date
            .as_deref()
            .is_some_and(|time| crate::importers::parse_iso8601(time).is_none())
    {
        return Err("curated claim source revision or timestamp changed".into());
    }
    let turns = original_turns(source)?;
    let turn = turns
        .iter()
        .find(|turn| turn.body_start <= quote.start && quote.end <= turn.end);
    let (speaker, turn_time, turn_id, source_phase) = match turn {
        Some(turn) => (
            turn.speaker,
            turn.timestamp.clone(),
            turn.id.clone(),
            turn.phase.clone(),
        ),
        None if turns.is_empty() && quote.role == "Unknown" && quote.date.is_none() => {
            (ActorRole::Unknown, None, "T0".into(), None)
        }
        None => return Err("curated claim quote has no original turn".into()),
    };
    if quote.role != format!("{speaker:?}")
        || turn_time
            .as_deref()
            .and_then(crate::importers::parse_iso8601)
            != quote
                .date
                .as_deref()
                .and_then(crate::importers::parse_iso8601)
    {
        return Err("curated claim speaker or turn time differs from the original".into());
    }
    let identity = format!("{page}:{}:{}:{}", quote.source, quote.start, quote.end);
    SourceDocument::bind(
        key("S", &identity),
        quote.source.clone(),
        page.into(),
        source,
        record_time(source),
        vec![SpanInput {
            id: key("Q", &identity),
            start: quote.start,
            end: quote.end,
            turn_id: turn_id.clone(),
            speaker,
            turn_time,
        }],
    )?
    .with_turn_phases(&[(turn_id, source_phase)])
}

#[cfg(test)]
#[path = "claim_sources_tests.rs"]
mod tests;
