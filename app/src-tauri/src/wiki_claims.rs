//! Original-source binding for model-proposed activity claims.
//! Hashes, spans and shape checks do not establish semantic entailment.

use crate::retrieval::Scope;
use crate::vault_session::AgentVaultSession;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Component, Path};

#[path = "wiki_claims/schema.rs"]
mod schema;
pub use schema::*;
#[path = "wiki_claims/source_input_view.rs"]
pub(crate) mod source_input_view;
#[path = "wiki_claims/source_set.rs"]
mod source_set;
pub(crate) use source_set::CompilationOriginal;
#[cfg(feature = "native-index-probe")]
#[path = "wiki_claims/compact_qa.rs"]
pub mod compact_qa;
#[cfg(feature = "native-index-probe")]
#[path = "wiki_claims/focus_claims_qa.rs"]
pub mod focus_claims_qa;
#[cfg(feature = "native-index-probe")]
#[path = "wiki_claims/focus_claims_qa_grammar.rs"]
mod focus_claims_qa_grammar;
#[cfg(feature = "native-index-probe")]
#[path = "wiki_claims/quoted_qa.rs"]
pub mod quoted_qa;
#[cfg(feature = "native-index-probe")]
#[path = "wiki_claims/source_interpretation_qa.rs"]
pub mod source_interpretation_qa;
#[path = "wiki_claims/windows.rs"]
mod windows;

const MAX_SOURCES: usize = 64;
const MAX_SOURCE_BYTES: usize = 512 * 1024;
const MAX_TOTAL_BYTES: usize = 8 * 1024 * 1024;
const MAX_SPANS: usize = 512;
const MAX_CLAIMS: usize = 16;
const MAX_SUPPORTS: usize = 8;
const MAX_OUTPUT_BYTES: usize = 32 * 1024;

/// Native turn coordinates, supplied after reading an original source.
pub struct SpanInput {
    pub id: String,
    pub start: usize,
    pub end: usize,
    pub turn_id: String,
    pub speaker: ActorRole,
    pub turn_time: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceSpan {
    id: String,
    source_id: String,
    source_path: String,
    selection_path: String,
    source_revision: String,
    start: usize,
    end: usize,
    sha256: String,
    text: String,
    turn_id: String,
    speaker: ActorRole,
    record_time: Option<String>,
    turn_time: Option<String>,
    source_phase: Option<String>,
}

impl SourceSpan {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn text(&self) -> &str {
        &self.text
    }
    pub fn selection_path(&self) -> &str {
        &self.selection_path
    }
    pub fn source_path(&self) -> &str {
        &self.source_path
    }
    pub fn source_revision(&self) -> &str {
        &self.source_revision
    }
    pub fn speaker(&self) -> ActorRole {
        self.speaker
    }
    pub fn turn_time(&self) -> Option<&str> {
        self.turn_time.as_deref()
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceDocument {
    id: String,
    path: String,
    selection_path: String,
    revision: String,
    spans: Vec<SourceSpan>,
    #[serde(skip)]
    bytes: usize,
}

impl SourceDocument {
    /// Bind byte offsets to exact UTF-8 source bytes. The caller must first
    /// establish vault confinement and any selected wiki page's raw lineage.
    pub fn bind(
        id: String,
        path: String,
        selection_path: String,
        original: &str,
        record_time: Option<String>,
        inputs: Vec<SpanInput>,
    ) -> Result<Self, String> {
        if !valid_id(&id) || !valid_path(&path) || !valid_path(&selection_path) {
            return Err("invalid claim source identity".into());
        }
        if original.is_empty()
            || original.len() > MAX_SOURCE_BYTES
            || inputs.is_empty()
            || inputs.len() > MAX_SPANS
        {
            return Err("claim source size or span count exceeds bounds".into());
        }
        if record_time.as_deref().is_some_and(|time| !valid_time(time)) {
            return Err("invalid source record time".into());
        }
        let revision = sha256(original.as_bytes());
        let mut seen = HashSet::new();
        let mut spans = Vec::new();
        for input in inputs {
            if !valid_id(&input.id)
                || !valid_id(&input.turn_id)
                || !seen.insert(input.id.clone())
                || input.start >= input.end
                || input
                    .turn_time
                    .as_deref()
                    .is_some_and(|time| !valid_time(time))
            {
                return Err("invalid claim source span metadata".into());
            }
            let text = original
                .get(input.start..input.end)
                .ok_or("claim span is outside UTF-8 source boundaries")?;
            spans.push(SourceSpan {
                id: input.id,
                source_id: id.clone(),
                source_path: path.clone(),
                selection_path: selection_path.clone(),
                source_revision: revision.clone(),
                start: input.start,
                end: input.end,
                sha256: sha256(text.as_bytes()),
                text: text.into(),
                turn_id: input.turn_id,
                speaker: input.speaker,
                record_time: record_time.clone(),
                turn_time: input.turn_time,
                source_phase: None,
            });
        }
        Ok(Self {
            id,
            path,
            selection_path,
            revision,
            spans,
            bytes: original.len(),
        })
    }
}

/// Application-only facts from a domain-specific, independently checked
/// receipt. A transcript's Tool/User/Assistant role is not such a receipt.
#[derive(Clone, Debug)]
pub struct AppVerifiedFact {
    pub id: String,
    pub canonical_statement: String,
    pub status: ClaimStatus,
    pub support_span_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSet {
    origin: AgentVaultSession,
    scope: Scope,
    sources: Vec<SourceDocument>,
    #[serde(skip)]
    verified_facts: Vec<AppVerifiedFact>,
}

impl SourceSet {
    /// Freeze original-source bindings before generation. This pure function
    /// does not read disk or authenticate the caller's current native opening.
    pub fn new(
        origin: AgentVaultSession,
        scope: Scope,
        sources: Vec<SourceDocument>,
        verified_facts: Vec<AppVerifiedFact>,
    ) -> Result<Self, String> {
        if origin.vault_path.is_empty()
            || origin.opening_token.is_empty()
            || sources.len() > MAX_SOURCES
            || verified_facts.len() > MAX_CLAIMS
            || sources.iter().map(|source| source.bytes).sum::<usize>() > MAX_TOTAL_BYTES
        {
            return Err("claim source set exceeds bounds or lacks origin".into());
        }
        let mut source_ids = HashSet::new();
        let mut span_ids = HashSet::new();
        for source in &sources {
            if !scope.keeps(&source.selection_path) || !source_ids.insert(source.id.as_str()) {
                return Err("claim source is outside scope or duplicates an identity".into());
            }
            for span in &source.spans {
                if !span_ids.insert(span.id.as_str()) || span_ids.len() > MAX_SPANS {
                    return Err("claim span identity is duplicated or exceeds bounds".into());
                }
            }
        }
        let mut fact_ids = HashSet::new();
        for fact in &verified_facts {
            if !valid_id(&fact.id)
                || !fact_ids.insert(fact.id.as_str())
                || fact.canonical_statement.is_empty()
                || fact.canonical_statement.chars().count() > 512
                || !fact.status.is_verified()
                || fact.support_span_ids.is_empty()
                || fact.support_span_ids.len() > MAX_SUPPORTS
                || fact
                    .support_span_ids
                    .iter()
                    .any(|id| !span_ids.contains(id.as_str()))
                || unique_count(&fact.support_span_ids) != fact.support_span_ids.len()
            {
                return Err("invalid application verification receipt binding".into());
            }
        }
        Ok(Self {
            origin,
            scope,
            sources,
            verified_facts,
        })
    }

    pub fn spans(&self) -> impl Iterator<Item = &SourceSpan> {
        self.sources.iter().flat_map(|source| &source.spans)
    }

    /// Parse only proposals; source identities, revisions and speaker metadata
    /// cannot be supplied or replaced by the model's JSON.
    pub fn validate(
        &self,
        output: &str,
        current_origin: &AgentVaultSession,
        current_scope: Scope,
    ) -> Result<CheckedClaims, String> {
        if self.origin.vault_path != current_origin.vault_path
            || self.origin.opening_token != current_origin.opening_token
            || self.scope != current_scope
        {
            return Err("claim evidence belongs to a different vault opening or scope".into());
        }
        if output.len() > MAX_OUTPUT_BYTES {
            return Err("claim output exceeds bounds".into());
        }
        let batch: ClaimBatch = serde_json::from_str(output)
            .map_err(|error| format!("invalid claim proposal JSON: {error}"))?;
        if batch.claims.len() > MAX_CLAIMS
            || (batch.outcome == ClaimOutcome::InsufficientEvidence) != batch.claims.is_empty()
        {
            return Err("claim outcome and claim count disagree".into());
        }
        let mut checked = Vec::new();
        for proposal in batch.claims {
            let spans = self.check_proposal(&proposal)?;
            checked.push(CheckedClaim {
                proposal,
                provenance: spans,
                structure_checked: true,
                semantic_review_required: true,
            });
        }
        Ok(CheckedClaims {
            outcome: batch.outcome,
            claims: checked,
        })
    }

    fn check_proposal(&self, proposal: &ClaimProposal) -> Result<Vec<SourceSpan>, String> {
        if proposal.action.trim().is_empty()
            || proposal.action.chars().count() > 512
            || proposal.support_span_ids.is_empty()
            || proposal.support_span_ids.len() > MAX_SUPPORTS
            || unique_count(&proposal.support_span_ids) != proposal.support_span_ids.len()
            || !proposal.support_span_ids.contains(&proposal.anchor_span_id)
        {
            return Err("claim action or support span bounds are invalid".into());
        }
        let spans: Vec<SourceSpan> = proposal
            .support_span_ids
            .iter()
            .map(|id| {
                self.spans()
                    .find(|span| &span.id == id)
                    .cloned()
                    .ok_or_else(|| "claim references an unselected original span".into())
            })
            .collect::<Result<_, String>>()?;
        let anchor = spans
            .iter()
            .find(|span| span.id == proposal.anchor_span_id)
            .ok_or("claim lacks its original anchor span")?;
        check_actor(&proposal.actor, anchor, &spans)?;
        check_time(&proposal.event_time, &spans)?;
        if !compatible_status(proposal.speech_act, proposal.status) {
            return Err("claim speech act and status disagree".into());
        }
        if proposal.status.is_verified() {
            let fact = proposal
                .verification_id
                .as_ref()
                .and_then(|id| self.verified_facts.iter().find(|fact| &fact.id == id))
                .ok_or("claim lacks an application verification receipt")?;
            let same_support = fact.support_span_ids.len() == proposal.support_span_ids.len()
                && fact
                    .support_span_ids
                    .iter()
                    .all(|id| proposal.support_span_ids.contains(id));
            if fact.canonical_statement != proposal.action
                || fact.status != proposal.status
                || !same_support
            {
                return Err("claim exceeds its application verification receipt".into());
            }
        } else if proposal.verification_id.is_some() {
            return Err("unverified claim cannot carry a verification receipt".into());
        }
        Ok(spans)
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ClaimBatch {
    outcome: ClaimOutcome,
    claims: Vec<ClaimProposal>,
}

fn unique_count(values: &[String]) -> usize {
    values.iter().collect::<HashSet<_>>().len()
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn valid_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 1024
        && !value.contains(['\\', '\0'])
        && value.ends_with(".md")
        && value
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
        && Path::new(value)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}

fn check_actor(
    actor: &ProposedActor,
    anchor: &SourceSpan,
    spans: &[SourceSpan],
) -> Result<(), String> {
    let valid = match actor.basis {
        ActorBasis::Unknown => actor.role == ActorRole::Unknown && actor.subject_span_id.is_none(),
        ActorBasis::Speaker => actor.role == anchor.speaker && actor.subject_span_id.is_none(),
        ActorBasis::ExplicitSubject => {
            actor.role != ActorRole::Unknown
                && actor
                    .subject_span_id
                    .as_ref()
                    .is_some_and(|id| spans.iter().any(|span| &span.id == id))
        }
    };
    if !valid {
        return Err("claim actor contradicts its speaker or lacks a subject span".into());
    }
    Ok(())
}

fn check_time(time: &ProposedEventTime, spans: &[SourceSpan]) -> Result<(), String> {
    if time.basis == TimeBasis::Unknown {
        return if time.value.is_none()
            && time.support_span_id.is_none()
            && time.precision == TimePrecision::Unknown
            && time.uncertainty == TimeUncertainty::Unknown
        {
            Ok(())
        } else {
            Err("unknown claim time must remain unspecified".into())
        };
    }
    let value = time.value.as_deref().ok_or("claim time lacks a value")?;
    let span = time
        .support_span_id
        .as_ref()
        .and_then(|id| spans.iter().find(|span| &span.id == id))
        .ok_or("claim time lacks an original support span")?;
    if !valid_time(value)
        || match time.precision {
            TimePrecision::Unknown => true,
            TimePrecision::Day => value.len() != 10,
            TimePrecision::Instant => value.len() == 10,
        }
    {
        return Err("claim time has invalid value or precision".into());
    }
    match time.basis {
        TimeBasis::Explicit => {
            if time.uncertainty != TimeUncertainty::Specified {
                return Err("explicit claim time has invalid uncertainty".into());
            }
            if !span.text.contains(value) {
                return Err("claim explicit date is absent from its original span".into());
            }
        }
        TimeBasis::InferredFromTurn => {
            if time.uncertainty != TimeUncertainty::Inferred {
                return Err("message-derived claim time must retain inferred uncertainty".into());
            }
            let turn_time = span
                .turn_time
                .as_deref()
                .ok_or("claim source has no turn time")?;
            let matches = match time.precision {
                TimePrecision::Day => turn_time.get(..10) == Some(value),
                TimePrecision::Instant => turn_time == value,
                TimePrecision::Unknown => false,
            };
            if !matches {
                return Err("claim time differs from its original turn time".into());
            }
        }
        TimeBasis::DateReference => {
            if time.uncertainty != TimeUncertainty::Inferred {
                return Err("resolved date reference must retain inferred uncertainty".into());
            }
        }
        TimeBasis::Unknown => unreachable!("unknown time returned above"),
    }
    Ok(())
}

fn compatible_status(act: SpeechAct, status: ClaimStatus) -> bool {
    use ClaimStatus::*;
    match act {
        SpeechAct::Unknown | SpeechAct::Question => status == Unknown,
        SpeechAct::Request => matches!(status, Unknown | Requested),
        SpeechAct::Plan => matches!(status, Unknown | Planned),
        SpeechAct::Report => matches!(
            status,
            Unknown
                | InProgress
                | ReportedCompleted
                | ReportedFailed
                | ReportedCancelled
                | ReportedRolledBack
        ),
        SpeechAct::Verification => matches!(
            status,
            Unknown | ReportedCompleted | ReportedFailed | VerifiedCompleted | VerifiedFailed
        ),
        SpeechAct::Retraction => matches!(
            status,
            Unknown | Retracted | ReportedCancelled | ReportedRolledBack
        ),
    }
}

fn valid_time(value: &str) -> bool {
    if value.len() == 10 {
        crate::importers::parse_iso8601(&format!("{value}T00:00:00Z")).is_some()
    } else {
        value.len() <= 64 && crate::importers::parse_iso8601(value).is_some()
    }
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
#[path = "wiki_claims_tests.rs"]
mod tests;
