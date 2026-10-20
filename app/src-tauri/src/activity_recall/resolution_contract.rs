//! App-owned, separately bounded later-state evidence contracts.

use crate::commands::DateRange;
use crate::retrieval::Scope;
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::{ActorRole, SourceSpan};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResolutionMode {
    HistoricalAsOf,
    CurrentState,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolutionRequest {
    pub mode: ResolutionMode,
    pub as_of_epoch: i64,
    pub captured_query_epoch: i64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolutionWindow {
    pub mode: ResolutionMode,
    pub start_epoch: i64,
    pub end_epoch: i64,
    pub as_of_epoch: i64,
    pub captured_query_epoch: i64,
}

impl ResolutionRequest {
    /// Validate an explicit query snapshot; never infer current-state intent
    /// from model claims or extend a historical cutoff past its inclusive end.
    pub fn checked_window(&self, range: &DateRange, now: i64) -> Result<ResolutionWindow, String> {
        if !super::super::valid_range(range) {
            return Err("resolution activity period is invalid".into());
        }
        let (start, end) = match (range.start_epoch, range.end_epoch) {
            (Some(start), Some(end)) => (start, end),
            (None, None) => (
                crate::importers::parse_iso8601(&format!("{}T00:00:00Z", range.start))
                    .ok_or("resolution period start is invalid")?,
                crate::importers::parse_iso8601(&format!("{}T00:00:00Z", range.end))
                    .and_then(|end| end.checked_add(86_400))
                    .ok_or("resolution period end is invalid")?,
            ),
            _ => return Err("resolution period epoch bounds are incomplete".into()),
        };
        if self.captured_query_epoch < 0
            || self.captured_query_epoch > now.saturating_add(300)
            || self.as_of_epoch < start
            || self.as_of_epoch > self.captured_query_epoch
        {
            return Err("resolution query snapshot or cutoff is invalid".into());
        }
        let expected = match self.mode {
            ResolutionMode::HistoricalAsOf => end.saturating_sub(1).min(self.captured_query_epoch),
            ResolutionMode::CurrentState => self.captured_query_epoch,
        };
        if self.as_of_epoch != expected {
            return Err("resolution cutoff differs from its declared query mode".into());
        }
        Ok(ResolutionWindow {
            mode: self.mode,
            start_epoch: start,
            end_epoch: self
                .as_of_epoch
                .checked_add(1)
                .ok_or("resolution cutoff overflow")?,
            as_of_epoch: self.as_of_epoch,
            captured_query_epoch: self.captured_query_epoch,
        })
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolutionCoverage {
    pub candidate_chunks: usize,
    pub scanned_pages: usize,
    pub admitted_pages: usize,
    pub original_spans: usize,
    pub processed_windows: usize,
    pub omitted_windows: usize,
    pub excluded_after_as_of_spans: usize,
    pub undated_spans: usize,
    pub read_bytes: usize,
    pub incomplete: bool,
    pub issues: Vec<ResolutionIssue>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolutionIssue {
    pub citation_page: String,
    pub code: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginalSpanDeclaration {
    pub id: String,
    pub start: usize,
    pub end: usize,
    pub sha256: String,
    pub speaker: ActorRole,
    pub turn_time: Option<String>,
    pub record_time: Option<String>,
    pub source_phase: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginalLineageDeclaration {
    pub source_path: String,
    pub source_revision: String,
    pub spans: Vec<OriginalSpanDeclaration>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdditionalSourceDeclaration {
    pub citation_page: String,
    pub citation_revision: String,
    pub title: Option<String>,
    pub stem: String,
    pub origin: AgentVaultSession,
    pub scope: Scope,
    pub lineage: Vec<OriginalLineageDeclaration>,
}

/// Exact source phrases propose retrieval candidates, never task identity.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolutionTaskKey {
    pub id: String,
    pub anchor_span_id: String,
    pub exact_phrase: String,
    pub phrase_start: usize,
    pub phrase_end: usize,
    pub phrase_sha256: String,
    pub source_revision: String,
    pub span_sha256: String,
    pub speaker: ActorRole,
    pub turn_time: Option<String>,
    pub source_phase: Option<String>,
    #[serde(skip)]
    pub(crate) original: SourceSpan,
}
