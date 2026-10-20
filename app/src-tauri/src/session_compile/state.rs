//! Durable state for source-bound session compilation. Source-citation
//! reminder receipts are independent and never authorize compiler completion.

use crate::vault_session::AgentVaultSession;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceBinding {
    pub key: String,
    pub raw_path: String,
    pub source_revision: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CompilerContract {
    pub compiler: String,
    pub schema: String,
    pub prompt: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CompileIdentity {
    pub source: SourceBinding,
    pub contract: CompilerContract,
    pub role_signature: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WorkState {
    #[default]
    Pending,
    Running,
    Partial,
    Stopped,
    Failed,
    Completed,
    Superseded,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CheckState {
    #[default]
    NotRun,
    Passed,
    Rejected,
    Unavailable,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProcessingChecks {
    pub original_source: CheckState,
    pub source_schema: CheckState,
    pub semantic_review: CheckState,
    pub eligible_units: usize,
    pub processed_units: usize,
    pub omitted_units: usize,
}

/// Durable work data, not model-processing authority. A fresh native attempt
/// rebinds and reviews every packet; these cursor fields alone cannot finish.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CompilerProgress {
    pub version: u8,
    pub source_revision: String,
    pub compile_signature: String,
    pub plan_revision: String,
    pub next_packet: usize,
    pub batches: Vec<CompilerBatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unreviewed_batch: Option<CompilerBatch>,
    #[serde(default)]
    pub language: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CompilerBatch {
    pub index: usize,
    pub packet_revision: String,
    pub extraction_output: String,
    pub compilation_output: String,
    pub review_output: Option<String>,
}

impl ProcessingChecks {
    pub(super) fn completed_compilation(&self) -> bool {
        self.original_source == CheckState::Passed
            && self.source_schema == CheckState::Passed
            && self.semantic_review == CheckState::Passed
            && self.eligible_units > 0
            && self.eligible_units == self.processed_units
            && self.omitted_units == 0
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeOutput {
    pub publication_id: String,
    pub attempt_id: String,
    pub path: String,
    pub revision: String,
    pub identity: serde_json::Value,
    pub native_created: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Attempt {
    pub id: String,
    pub origin: AgentVaultSession,
    pub role_snapshot_id: String,
    pub identity: CompileIdentity,
    pub state: WorkState,
    pub started: u64,
    pub updated: u64,
    pub reason: Option<String>,
    pub outputs: Vec<NativeOutput>,
    pub checks: ProcessingChecks,
    #[serde(default)]
    pub prepared_outputs: Vec<OutputPreparation>,
    #[serde(default)]
    pub compiler_progress: Option<CompilerProgress>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OutputPreparation {
    pub publication_id: String,
    pub path: String,
    pub content_revision: String,
    pub expected_revision: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CompilationReceipt {
    pub attempt_id: String,
    pub identity: CompileIdentity,
    pub outputs: Vec<NativeOutput>,
    pub checks: ProcessingChecks,
    pub completed: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CompilationJob {
    pub id: String,
    pub source: SourceBinding,
    pub admitted: u64,
    pub state: WorkState,
    pub reason: Option<String>,
    pub superseded_by: Option<String>,
    pub attempts: Vec<Attempt>,
    pub receipts: Vec<CompilationReceipt>,
}

fn same_origin(a: &AgentVaultSession, b: &AgentVaultSession) -> bool {
    a.vault_path == b.vault_path && a.opening_token == b.opening_token
}

impl CompilationJob {
    pub(crate) fn new(id: String, source: SourceBinding, now: u64) -> Self {
        Self {
            id,
            source,
            admitted: now,
            state: WorkState::Pending,
            reason: Some("compiler_role_revalidation_required".into()),
            superseded_by: None,
            attempts: Vec::new(),
            receipts: Vec::new(),
        }
    }

    /// The native dispatcher authenticates the current opening/role and exact
    /// original source before calling this mutation while holding queue CAS.
    pub(crate) fn begin(
        &mut self,
        id: String,
        origin: AgentVaultSession,
        role_snapshot_id: String,
        identity: CompileIdentity,
        now: u64,
    ) -> Result<(), String> {
        if self.source != identity.source
            || id.is_empty()
            || role_snapshot_id.is_empty()
            || origin.opening_token.is_empty()
            || identity.role_signature.is_empty()
        {
            return Err("compilation attempt lacks its source or native identity".into());
        }
        if self.superseded_by.is_some() {
            return Err(
                "source revision was superseded; select the current admitted revision".into(),
            );
        }
        if self.attempts.iter().any(|attempt| attempt.id == id) {
            return Err("compilation attempt identity must be new".into());
        }
        if self.attempts.iter().any(|previous| {
            previous.state == WorkState::Running
                && same_origin(&previous.origin, &origin)
                && previous.role_snapshot_id == role_snapshot_id
                && previous.identity == identity
        }) {
            return Err("this source compilation attempt is already running".into());
        }
        for previous in &mut self.attempts {
            if previous.state == WorkState::Running {
                previous.state = WorkState::Stopped;
                previous.updated = now;
                previous.reason = Some("expired_origin_or_role_requires_new_attempt".into());
            }
        }
        self.attempts.push(Attempt {
            id,
            origin,
            role_snapshot_id,
            identity,
            state: WorkState::Running,
            started: now,
            updated: now,
            reason: None,
            outputs: Vec::new(),
            checks: ProcessingChecks::default(),
            prepared_outputs: Vec::new(),
            compiler_progress: None,
        });
        self.state = WorkState::Running;
        self.reason = None;
        Ok(())
    }

    /// Private registry and role guards must already authenticate this binding.
    pub(crate) fn active(
        &mut self,
        id: &str,
        origin: &AgentVaultSession,
        role_snapshot_id: &str,
        identity: &CompileIdentity,
    ) -> Result<&mut Attempt, String> {
        if self.superseded_by.is_some() || self.source != identity.source {
            return Err("source revision no longer admits this compilation attempt".into());
        }
        let attempt = self
            .attempts
            .last_mut()
            .ok_or("no native compilation attempt is active")?;
        if attempt.id != id
            || !same_origin(&attempt.origin, origin)
            || attempt.role_snapshot_id != role_snapshot_id
            || &attempt.identity != identity
            || attempt.state != WorkState::Running
        {
            return Err("compilation attempt or native opening changed".into());
        }
        Ok(attempt)
    }

    /// Check results come from the native compiler adapter. They are never a
    /// caller-deserialized assertion and are not derived from quote coverage.
    pub(crate) fn finish(
        &mut self,
        id: &str,
        checks: ProcessingChecks,
        outputs: Vec<NativeOutput>,
        now: u64,
    ) -> Result<bool, String> {
        let attempt = self.attempts.last_mut().ok_or("no compilation attempt")?;
        if attempt.id != id || attempt.state != WorkState::Running {
            return Err("completion belongs to a different compilation attempt".into());
        }
        if outputs.iter().any(|output| output.attempt_id != id) {
            return Err("published output belongs to a different compilation attempt".into());
        }
        let complete = checks.completed_compilation() && !outputs.is_empty();
        attempt.updated = now;
        attempt.checks = checks;
        attempt.outputs = outputs;
        attempt.state = if complete {
            WorkState::Completed
        } else {
            WorkState::Partial
        };
        attempt.reason = (!complete).then(|| "native_compilation_or_review_incomplete".into());
        self.state = attempt.state;
        self.reason = attempt.reason.clone();
        if complete {
            self.receipts.push(CompilationReceipt {
                attempt_id: attempt.id.clone(),
                identity: attempt.identity.clone(),
                outputs: attempt.outputs.clone(),
                checks: attempt.checks.clone(),
                completed: now,
            });
        }
        Ok(complete)
    }

    pub(crate) fn stop(
        &mut self,
        id: &str,
        state: WorkState,
        reason: String,
        now: u64,
    ) -> Result<(), String> {
        if !matches!(
            state,
            WorkState::Pending | WorkState::Stopped | WorkState::Failed | WorkState::Partial
        ) {
            return Err("invalid retryable compilation outcome".into());
        }
        let attempt = self.attempts.last_mut().ok_or("no compilation attempt")?;
        if attempt.id != id || attempt.state != WorkState::Running {
            return Err("outcome belongs to a different compilation attempt".into());
        }
        attempt.state = state;
        attempt.reason = Some(reason.clone());
        attempt.updated = now;
        self.state = state;
        self.reason = Some(reason);
        Ok(())
    }

    pub(crate) fn supersede(&mut self, revision: String, now: u64) {
        self.superseded_by = Some(revision);
        self.state = WorkState::Superseded;
        self.reason = Some("new_immutable_source_revision_admitted".into());
        if let Some(attempt) = self
            .attempts
            .last_mut()
            .filter(|a| a.state == WorkState::Running)
        {
            attempt.state = WorkState::Stopped;
            attempt.updated = now;
            attempt.reason = Some("source_revision_superseded".into());
        }
    }
}

#[cfg(test)]
#[path = "state_tests.rs"]
mod tests;
