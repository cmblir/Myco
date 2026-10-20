//! Exact whole-session coverage; packet coordinates are owned by the app.

use super::state::SourceBinding;
use crate::importers::wikify::source_revision;
use crate::retrieval::Scope;
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::source_input_view::{original_input, OriginalInputView};
use crate::wiki_claims::{ActorRole, CompilationOriginal, SourceDocument, SourceSet, SpanInput};
use serde::{Deserialize, Serialize};

pub(super) const CONTEXT_TOKENS: u32 = 4096;
pub(super) const OUTPUT_TOKENS: i32 = 768;
// Bound each complete prompt, including its instructions and chat template.
// Compilation and review must independently fit their generated inputs.
pub(super) const MAX_INPUT_TOKENS: usize = CONTEXT_TOKENS as usize - OUTPUT_TOKENS as usize - 8;
const MAX_WINDOW_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OriginalWindow {
    pub id: String,
    pub start: usize,
    pub end: usize,
    pub turn_id: String,
    pub speaker: ActorRole,
    pub turn_time: Option<String>,
    pub phase: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PacketPlan {
    pub source: SourceBinding,
    pub revision: String,
    pub windows: Vec<OriginalWindow>,
    pub eligible_bytes: usize,
    pub record_time: Option<String>,
    pub derived_source: bool,
    pub language: String,
}

fn source_body(original: &str) -> Result<(usize, serde_json::Value), String> {
    let parsed = gray_matter::Matter::<gray_matter::engine::YAML>::new()
        .parse::<serde_json::Value>(original)
        .map_err(|_| "invalid compiler source metadata")?;
    let rest = original
        .strip_prefix("---\n")
        .ok_or("compiler source lacks frontmatter")?;
    let closing = rest
        .find("\n---\n")
        .ok_or("unterminated compiler source frontmatter")?;
    Ok((
        4 + closing + 5,
        parsed.data.ok_or("compiler source lacks metadata")?,
    ))
}

fn window_id(source: &SourceBinding, start: usize, end: usize) -> String {
    format!(
        "Q-{}",
        &source_revision(&format!("{}:{start}:{end}", source.source_revision))[..32]
    )
}

/// The host has checked lineage and native authority. Tokenization uses the
/// selected compiler model; no Ask period or made-up date filters this source.
pub(crate) fn prepare(
    source: &SourceBinding,
    original: &str,
    origin: &AgentVaultSession,
    lang: &str,
    mut token_count: impl FnMut(&str, &str) -> Result<usize, String>,
) -> Result<PacketPlan, String> {
    if !matches!(lang, "ko" | "en" | "ja")
        || original.len() > 128 * 1024 * 1024
        || source_revision(original) != source.source_revision
    {
        return Err("compiler plan requires its exact original and supported language".into());
    }
    let verified = CompilationOriginal::verify(original, &source.source_revision)?;
    let (body_start, metadata) = source_body(original)?;
    let mut turns = crate::activity_recall::compilation_original_turns(original)?;
    let first = turns
        .first()
        .map_or(original.len(), |turn| turn.header_start);
    if body_start < first {
        turns.insert(
            0,
            crate::activity_recall::CompilationOriginalTurn {
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
    let record_time = ["created", "last_updated"].into_iter().find_map(|key| {
        metadata[key]
            .as_str()
            .filter(|time| {
                if time.len() == 10 {
                    crate::importers::parse_iso8601(&format!("{time}T00:00:00Z")).is_some()
                } else {
                    crate::importers::parse_iso8601(time).is_some()
                }
            })
            .map(str::to_string)
    });
    let derived_source = metadata
        .get("derived_from")
        .is_some_and(|value| !value.is_null());
    let mut plan = PacketPlan {
        source: source.clone(),
        revision: String::new(),
        windows: vec![],
        eligible_bytes: 0,
        record_time,
        derived_source,
        language: lang.into(),
    };
    let system = crate::local_synthesis::claim_prompt::extraction_reading_system();
    for turn in turns {
        if turn.body_start == turn.end {
            continue;
        }
        let text = original
            .get(turn.body_start..turn.end)
            .ok_or("original turn boundaries changed")?;
        let boundaries: Vec<_> = text
            .char_indices()
            .map(|(offset, _)| offset)
            .chain(std::iter::once(text.len()))
            .collect();
        let mut cursor = 0;
        while cursor + 1 < boundaries.len() {
            let mut low = cursor + 1;
            let mut high = boundaries
                .partition_point(|offset| *offset <= boundaries[cursor] + MAX_WINDOW_BYTES)
                - 1;
            let mut best = None;
            while low <= high {
                let end = (low + high) / 2;
                let window = OriginalWindow {
                    id: window_id(
                        source,
                        turn.body_start + boundaries[cursor],
                        turn.body_start + boundaries[end],
                    ),
                    start: turn.body_start + boundaries[cursor],
                    end: turn.body_start + boundaries[end],
                    turn_id: turn.id.clone(),
                    speaker: turn.speaker,
                    turn_time: turn.timestamp.clone(),
                    phase: turn.phase.clone(),
                };
                let candidate = packet_set(&plan, &window, &verified, origin)?;
                let user = extraction_payload(&plan, &candidate, lang)?;
                if token_count(&system, &user)? <= MAX_INPUT_TOKENS {
                    best = Some((end, window));
                    low = end + 1;
                } else {
                    high = end - 1;
                }
            }
            let (end, window) =
                best.ok_or("compiler source metadata cannot fit selected model context")?;
            plan.eligible_bytes += window.end - window.start;
            plan.windows.push(window);
            cursor = end;
        }
    }
    if plan.windows.is_empty() {
        return Err("compiler source has no eligible original body".into());
    }
    plan.revision = source_revision(
        &serde_json::to_string(&serde_json::json!({
            "source": plan.source, "windows": plan.windows, "recordTime": plan.record_time,
            "derivedSource": plan.derived_source, "contextTokens": CONTEXT_TOKENS,
            "maxInputTokens": MAX_INPUT_TOKENS, "language": lang,
        }))
        .map_err(|error| error.to_string())?,
    );
    Ok(plan)
}

fn packet_set(
    plan: &PacketPlan,
    window: &OriginalWindow,
    original: &CompilationOriginal<'_>,
    origin: &AgentVaultSession,
) -> Result<SourceSet, String> {
    let document = SourceDocument::bind_compilation_packet(
        format!("S-{}", &plan.source.source_revision[..32]),
        plan.source.raw_path.clone(),
        original,
        &plan.source.source_revision,
        plan.record_time.clone(),
        vec![SpanInput {
            id: window.id.clone(),
            start: window.start,
            end: window.end,
            turn_id: window.turn_id.clone(),
            speaker: window.speaker,
            turn_time: window.turn_time.clone(),
        }],
    )?
    .with_turn_phases(&[(window.turn_id.clone(), window.phase.clone())])?;
    SourceSet::new(origin.clone(), Scope::All, vec![document], vec![])
}

impl PacketPlan {
    pub(crate) fn packet(
        &self,
        index: usize,
        original: &CompilationOriginal<'_>,
        origin: &AgentVaultSession,
    ) -> Result<SourceSet, String> {
        packet_set(
            self,
            self.windows
                .get(index)
                .ok_or("compiler packet cursor exceeds source plan")?,
            original,
            origin,
        )
    }
    pub(crate) fn packet_revision(&self, index: usize) -> Result<String, String> {
        Ok(source_revision(
            &serde_json::to_string(
                self.windows
                    .get(index)
                    .ok_or("compiler packet cursor exceeds source plan")?,
            )
            .map_err(|error| error.to_string())?,
        ))
    }
}

pub(super) fn extraction_payload(
    plan: &PacketPlan,
    packet: &SourceSet,
    lang: &str,
) -> Result<String, String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ExtractionInput<'a> {
        task: &'static str,
        language: &'a str,
        session_key: &'a str,
        original_spans: Vec<OriginalInputView<'a>>,
        source_revision: &'a str,
        derived_source: bool,
        allowed_span_ids: Vec<&'a str>,
        independent_verification_receipts: &'a [serde_json::Value],
    }

    let originals = packet
        .spans()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("serialize compiler originals: {error}"))?;
    let original_spans = originals
        .iter()
        .map(original_input)
        .collect::<Result<Vec<_>, _>>()?;
    // Serialize the borrowed reading view directly; Value would sort its members.
    serde_json::to_string(&ExtractionInput {
        task: "Compile every activity-bearing original in this session packet; retain chronology and retractions. No date filtering.",
        language: lang,
        session_key: &plan.source.key,
        original_spans,
        source_revision: &plan.source.source_revision,
        derived_source: plan.derived_source,
        allowed_span_ids: packet.spans().map(|span| span.id()).collect(),
        independent_verification_receipts: &[],
    })
    .map_err(|error| format!("serialize compiler source packet: {error}"))
}

#[cfg(test)]
#[path = "sources_tests.rs"]
mod tests;
