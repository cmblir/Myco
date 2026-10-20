//! Bounded immediate-predecessor cleanup, never a history scan or raw-file grant.
use super::*;
use crate::vault::{
    capture_compiler_retired_file_locked, read_compiler_retired_file_pin_locked,
    unlink_compiler_retired_file_pin_locked, RecordedFileIdentity,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(in crate::session_compile) enum RetirementState {
    Complete,
    Pending,
    Retained,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(in crate::session_compile) enum RetirementReason {
    Cutoff,
    CaptureFailed,
    UniqueHumanBytes,
    ResidueChanged,
    ReappearedBelowCursor,
    SuccessorChanged,
    CleanupIo,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::session_compile) struct RetirementDiagnostic {
    pub state: RetirementState,
    pub step: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<RetirementReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic_persistence_error: Option<String>,
}
impl RetirementDiagnostic {
    pub(in crate::session_compile) fn complete() -> Self {
        Self {
            state: RetirementState::Complete,
            step: 3,
            reason: None,
            detail: None,
            diagnostic_persistence_error: None,
        }
    }
    pub(in crate::session_compile) fn is_complete(&self) -> bool {
        self.state == RetirementState::Complete
    }
    pub(in crate::session_compile) fn is_failed(&self) -> bool {
        self.state == RetirementState::Failed
    }
    pub(in crate::session_compile) fn message(&self) -> String {
        let detail = self.detail.clone().unwrap_or_else(|| {
            format!(
                "compiler custody retirement {:?} at step {} ({:?})",
                self.state, self.step, self.reason
            )
        });
        match &self.diagnostic_persistence_error {
            Some(error) => format!("{detail}; retirement diagnostic persistence: {error}"),
            None => detail,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Snapshot {
    device: u64,
    inode: u64,
    changed_seconds: i64,
    changed_nanoseconds: i64,
    bytes: u64,
}
impl Snapshot {
    fn native(identity: &RecordedFileIdentity, bytes: usize) -> Result<Self, String> {
        let mut value = serde_json::to_value(identity).map_err(|error| error.to_string())?;
        value
            .as_object_mut()
            .ok_or("retired native identity is not an object")?
            .insert("bytes".into(), serde_json::json!(bytes));
        serde_json::from_value(value)
            .map_err(|error| format!("capture retired native identity: {error}"))
    }
    fn valid(&self) -> bool {
        self.bytes <= MAX_RECORD_BYTES
            && self.changed_nanoseconds >= 0
            && self.changed_nanoseconds < 1_000_000_000
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RetiredLeaf {
    leaf: String,
    sha256: String,
    snapshot: Option<Snapshot>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Preservation {
    contract: String,
    consumed_prior_sha256: String,
    successor_baseline_sha256: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RetirementDescriptor {
    version: u8,
    generation: String,
    record: RetiredLeaf,
    baseline: RetiredLeaf,
    anchor: RetiredLeaf,
    preservation: Preservation,
    capture_failure: Option<RetirementReason>,
    capture_errors: Vec<CaptureError>,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum CaptureTarget {
    Anchor,
    Baseline,
    Record,
}
#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum CapturePhase {
    Capture,
    Read,
    Identity,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaptureError {
    target: CaptureTarget,
    phase: CapturePhase,
    detail: String,
}

fn capture_detail(error: String, store: &Store) -> String {
    // Native errors contain no source body; remove trusted path prefixes before
    // retaining bounded OS/phase context in the private diagnostic.
    error
        .replace(&store.scope.vault, "<vault>")
        .replace(
            &store.directory.path().to_string_lossy().to_string(),
            "<custody>",
        )
        .chars()
        .take(512)
        .collect()
}

impl RetirementDescriptor {
    fn leaves(&self) -> [&RetiredLeaf; 3] {
        [&self.anchor, &self.baseline, &self.record]
    }
}

pub(super) fn validate_head(head: &Head) -> Result<(), String> {
    if !generation(&head.generation) || !hash(&head.record_sha256) {
        return Err("compiler custody head is invalid".into());
    }
    match head.version {
        1 if head.retirement_step.is_none()
            && head.retirement_state.is_none()
            && head.retirement_reason.is_none() =>
        {
            Ok(())
        }
        2 if head.retirement_step.is_some_and(|step| step <= 3)
            && head.retirement_state.is_some()
            && ((head.retirement_state == Some(RetirementState::Complete)
                && head.retirement_step == Some(3)
                && head.retirement_reason.is_none())
                || (head.retirement_state != Some(RetirementState::Complete)
                    && head.retirement_reason.is_some())) =>
        {
            Ok(())
        }
        _ => Err("compiler custody retirement cursor is invalid".into()),
    }
}

pub(super) fn validate_descriptor(record: &Record, head: &Head, key: &str) -> Result<(), String> {
    if record.version != head.version {
        return Err("compiler custody record/head versions disagree".into());
    }
    let Some(descriptor) = &record.retirement else {
        if record.version == 1
            || (record.predecessor.is_none()
                && head.retirement_state == Some(RetirementState::Complete))
        {
            return Ok(());
        }
        return Err("compiler custody predecessor lacks its bounded retirement descriptor".into());
    };
    if record.version != 2
        || descriptor.version != 1
        || !generation(&descriptor.generation)
        || descriptor.generation == record.generation
        || record.predecessor.as_deref() != Some(descriptor.record.sha256.as_str())
        || descriptor.preservation.contract != "refreshed-content-v1"
        || !hash(&descriptor.preservation.consumed_prior_sha256)
        || descriptor.preservation.successor_baseline_sha256 != record.baseline_sha256
        || descriptor.anchor.sha256 != descriptor.preservation.consumed_prior_sha256
        || descriptor.record.leaf != format!("{key}.{}.record.json", descriptor.generation)
        || descriptor.baseline.leaf != format!("{key}.{}.baseline.txt", descriptor.generation)
        || descriptor.anchor.leaf != format!("{key}.{}.anchor", descriptor.generation)
        || descriptor.leaves().iter().any(|leaf| {
            !hash(&leaf.sha256)
                || leaf
                    .snapshot
                    .as_ref()
                    .is_some_and(|snapshot| !snapshot.valid())
        })
        || (descriptor.capture_failure.is_none()
            && descriptor
                .leaves()
                .iter()
                .any(|leaf| leaf.snapshot.is_none()))
        || descriptor
            .capture_failure
            .is_some_and(|reason| reason != RetirementReason::CaptureFailed)
        || descriptor.capture_errors.len() > 3
        || (descriptor.capture_failure.is_some() == descriptor.capture_errors.is_empty())
        || descriptor
            .capture_errors
            .iter()
            .any(|error| error.detail.is_empty() || error.detail.chars().count() > 512)
    {
        return Err("compiler custody retirement descriptor is invalid".into());
    }
    Ok(())
}

pub(super) fn capture_descriptor(
    guard: &MutexGuard<'_, ()>,
    store: &Store,
    successor: &RecordedWriteReceipt,
    witness: Option<&PreservedPriorImage>,
) -> Result<Option<RetirementDescriptor>, String> {
    let Some(old) = &store.active else {
        return Ok(None);
    };
    let witness = witness.ok_or("native predecessor preservation witness is missing")?;
    if witness.successor_sha256 != successor.revision {
        return Err("native successor image differs from preservation witness".into());
    }
    let mut capture_errors = Vec::new();
    let mut capture = |leaf: String, sha256: String, target: CaptureTarget| {
        let captured: Result<Option<crate::vault::CompilerRetiredFilePin>, String> =
            capture_compiler_retired_file_locked(guard, &store.directory, &leaf);
        let observed = match captured {
            Ok(Some(pin)) => read_compiler_retired_file_pin_locked(guard, &pin)
                .and_then(|(text, _, identity)| Snapshot::native(&identity, text.len()))
                .map_err(|error| (CapturePhase::Read, error)),
            Ok(None) => Err((
                CapturePhase::Capture,
                "retired predecessor file is missing at native capture".into(),
            )),
            Err(error) => Err((CapturePhase::Capture, error)),
        };
        let observed = observed.and_then(|snapshot| {
            if matches!(target, CaptureTarget::Anchor)
                && (snapshot.device, snapshot.inode)
                    != (old.issued_identity.device, old.issued_identity.inode)
            {
                Err((
                    CapturePhase::Identity,
                    "retired predecessor anchor identity mismatch".into(),
                ))
            } else {
                Ok(snapshot)
            }
        });
        let snapshot = match observed {
            Ok(snapshot) => Some(snapshot),
            Err((phase, error)) => {
                capture_errors.push(CaptureError {
                    target,
                    phase,
                    detail: capture_detail(error, store),
                });
                None
            }
        };
        RetiredLeaf {
            leaf,
            sha256,
            snapshot,
        }
    };
    let anchor = capture(
        old.anchor_leaf.clone(),
        witness.consumed_prior_sha256.clone(),
        CaptureTarget::Anchor,
    );
    let baseline = capture(
        format!("{}.{}.baseline.txt", store.key, old.generation),
        old.baseline_sha256.clone(),
        CaptureTarget::Baseline,
    );
    let record = capture(
        format!("{}.{}.record.json", store.key, old.generation),
        store
            .record_sha256
            .clone()
            .ok_or("active predecessor record hash is missing")?,
        CaptureTarget::Record,
    );
    Ok(Some(RetirementDescriptor {
        version: 1,
        generation: old.generation.clone(),
        record,
        baseline,
        anchor,
        preservation: Preservation {
            contract: "refreshed-content-v1".into(),
            consumed_prior_sha256: witness.consumed_prior_sha256.clone(),
            successor_baseline_sha256: successor.revision.clone(),
        },
        capture_failure: (!capture_errors.is_empty()).then_some(RetirementReason::CaptureFailed),
        capture_errors,
    }))
}

#[cfg(test)]
pub(in crate::session_compile) static ACTION_BUDGET: Mutex<Option<usize>> = Mutex::new(None);
#[cfg(test)]
#[allow(clippy::type_complexity)]
pub(in crate::session_compile) static AFTER_UNLINK: Mutex<
    Option<Box<dyn FnOnce(&Path) -> Result<(), String> + Send>>,
> = Mutex::new(None);
#[cfg(test)]
#[allow(clippy::type_complexity)]
pub(in crate::session_compile) static AFTER_HEAD_PERSIST: Mutex<
    Option<Box<dyn FnOnce() -> Result<(), String> + Send>>,
> = Mutex::new(None);

pub(super) fn action_budget() -> usize {
    #[cfg(test)]
    if let Some(budget) = ACTION_BUDGET.lock().unwrap().take() {
        return budget.min(3);
    }
    3
}

impl Store {
    pub(super) fn write_head_locked(
        &mut self,
        guard: &MutexGuard<'_, ()>,
        head: &Head,
    ) -> Result<(), String> {
        validate_head(head)?;
        let leaf = format!("{}.head.json", self.key);
        let current = read_record(&self.directory, &leaf)?;
        if current.as_deref().map(source_revision) != self.head_sha256 {
            return Err("compiler custody head changed before cursor acknowledgement".into());
        }
        let text = serde_json::to_string(head).map_err(|error| error.to_string())?;
        if current.as_deref() != Some(text.as_str()) {
            crate::vault::write_file_if_unchanged_recorded_locked(
                guard,
                self.directory
                    .path()
                    .join(&leaf)
                    .to_str()
                    .ok_or("compiler custody head path is not UTF-8")?,
                &text,
                self.head_sha256.as_deref(),
            )?;
            self.directory.sync()?;
            #[cfg(test)]
            if let Some(hook) = AFTER_HEAD_PERSIST
                .lock()
                .map_err(|_| "compiler head test hook poisoned")?
                .take()
            {
                hook()?;
            }
            if read_record(&self.directory, &leaf)?.as_deref() != Some(text.as_str()) {
                return Err("compiler custody cursor acknowledgement differs".into());
            }
        }
        self.head_sha256 = Some(source_revision(&text));
        self.head = Some(head.clone());
        Ok(())
    }

    fn validate_active_locked(&self, guard: &MutexGuard<'_, ()>) -> Result<Option<String>, String> {
        let Some(record) = &self.active else {
            return Ok(None);
        };
        let head = self
            .head
            .as_ref()
            .ok_or("active compiler custody head is missing")?;
        if read_record(&self.directory, &format!("{}.head.json", self.key))?
            .as_deref()
            .map(source_revision)
            != self.head_sha256
            || head.generation != record.generation
            || Some(&head.record_sha256) != self.record_sha256.as_ref()
        {
            return Err("current compiler custody head changed during retirement".into());
        }
        let text = read_record(
            &self.directory,
            &format!("{}.{}.record.json", self.key, record.generation),
        )?
        .ok_or("current compiler custody record is missing")?;
        if Some(source_revision(&text)) != self.record_sha256 {
            return Err("current compiler custody record changed during retirement".into());
        }
        let baseline = read_record(
            &self.directory,
            &format!("{}.{}.baseline.txt", self.key, record.generation),
        )?
        .ok_or("current compiler custody baseline is missing")?;
        if source_revision(&baseline) != record.baseline_sha256 {
            return Err("current compiler custody baseline changed during retirement".into());
        }
        validate_baseline(&baseline, record)?;
        let canonical = Path::new(&self.scope.vault).join(&self.scope.path);
        let pin = crate::vault::reopen_compiler_prior_file_pin(
            &canonical,
            &self.directory,
            &record.anchor_leaf,
        )?;
        let (current, sha) = crate::vault::read_compiler_prior_file_pin_locked(guard, &pin)?;
        super::super::range(&current, &record.ownership)?;
        let metadata = super::super::super::parse(&current)?.0;
        if metadata["session_key"].as_str() != Some(self.scope.session_key.as_str())
            || record
                .ownership
                .owned_fields
                .iter()
                .any(|(key, value)| metadata.get(key) != Some(value))
        {
            return Err("current compiler custody provenance changed during retirement".into());
        }
        Ok(Some(sha))
    }

    fn note_retirement(
        &mut self,
        guard: &MutexGuard<'_, ()>,
        diagnostic: RetirementDiagnostic,
    ) -> Result<RetirementDiagnostic, String> {
        let mut head = self
            .head
            .clone()
            .ok_or("compiler custody diagnostic lacks its committed head")?;
        head.version = 2;
        head.retirement_step = Some(diagnostic.step);
        head.retirement_state = Some(diagnostic.state);
        head.retirement_reason = diagnostic.reason;
        if let Err(error) = self.write_head_locked(guard, &head) {
            // An uncertain diagnostic acknowledgement is not an uncertain native
            // compilation. Accept only the previous or attempted exact head,
            // then independently revalidate the still-current native image.
            let recheck = (|| -> Result<(), String> {
                let observed = read_record(&self.directory, &format!("{}.head.json", self.key))?
                    .ok_or_else(|| {
                        format!(
                            "{}; retirement acknowledgement failed: {error}; current head missing",
                            diagnostic.message()
                        )
                    })?;
                let observed_sha = source_revision(&observed);
                let attempted =
                    serde_json::to_string(&head).map_err(|encode| encode.to_string())?;
                if Some(&observed_sha) != self.head_sha256.as_ref()
                    && observed_sha != source_revision(&attempted)
                {
                    return Err(format!(
                        "{}; retirement acknowledgement failed: {error}; current head changed",
                        diagnostic.message()
                    ));
                }
                let confirmed: Head = serde_json::from_str(&observed).map_err(|decode| {
                    format!("{error}; decode current retirement head: {decode}")
                })?;
                validate_head(&confirmed)?;
                let record = self
                    .active
                    .as_ref()
                    .ok_or("retirement acknowledgement lacks current record")?;
                validate_descriptor(record, &confirmed, &self.key)?;
                if confirmed.generation != record.generation
                    || Some(&confirmed.record_sha256) != self.record_sha256.as_ref()
                {
                    return Err(format!("{error}; retirement acknowledgement points outside the live native generation"));
                }
                self.head_sha256 = Some(observed_sha);
                self.head = Some(confirmed);
                self.validate_active_locked(guard).map_err(|invalid| {
                    format!("{error}; current retirement image validation failed: {invalid}")
                })?;
                Ok(())
            })();
            if let Err(invalid) = recheck {
                return Err(format!("{}; retirement acknowledgement failed: {error}; current image recheck failed: {invalid}", diagnostic.message()));
            }
            return Ok(RetirementDiagnostic {
                state: RetirementState::Failed,
                step: self
                    .head
                    .as_ref()
                    .and_then(|head| head.retirement_step)
                    .ok_or("rechecked retirement cursor is missing")?,
                reason: Some(RetirementReason::CleanupIo),
                detail: Some(diagnostic.message()),
                diagnostic_persistence_error: Some(error),
            });
        }
        Ok(diagnostic)
    }

    fn check_acknowledged_absence(
        &mut self,
        guard: &MutexGuard<'_, ()>,
        descriptor: &RetirementDescriptor,
        step: u8,
    ) -> Result<Option<RetirementDiagnostic>, String> {
        for leaf in descriptor.leaves().iter().take(step as usize) {
            match capture_compiler_retired_file_locked(guard, &self.directory, &leaf.leaf) {
                Ok(None) => (),
                Ok(Some(_)) => return self
                    .note_retirement(
                        guard,
                        RetirementDiagnostic {
                            state: RetirementState::Retained,
                            step,
                            reason: Some(RetirementReason::ReappearedBelowCursor),
                            detail: Some(
                                "acknowledged retired leaf reappeared; it was not deleted again"
                                    .into(),
                            ),
                            diagnostic_persistence_error: None,
                        },
                    )
                    .map(Some),
                Err(error) => {
                    return self
                        .note_retirement(
                            guard,
                            RetirementDiagnostic {
                                state: RetirementState::Failed,
                                step,
                                reason: Some(RetirementReason::CleanupIo),
                                detail: Some(error),
                                diagnostic_persistence_error: None,
                            },
                        )
                        .map(Some)
                }
            }
        }
        Ok(None)
    }

    pub(in crate::session_compile) fn maintain_retirement_locked(
        &mut self,
        guard: &MutexGuard<'_, ()>,
        action_budget: usize,
    ) -> Result<RetirementDiagnostic, String> {
        let current_sha = self.validate_active_locked(guard)?;
        let Some(record) = self.active.clone() else {
            return Ok(RetirementDiagnostic::complete());
        };
        let head = self
            .head
            .clone()
            .ok_or("compiler custody head is missing")?;
        validate_descriptor(&record, &head, &self.key)?;
        let Some(descriptor) = record.retirement else {
            return Ok(RetirementDiagnostic::complete());
        };
        let mut step = head
            .retirement_step
            .ok_or("compiler custody cursor is missing")?;
        if descriptor.capture_failure.is_some() {
            return self.note_retirement(guard, RetirementDiagnostic { state: RetirementState::Failed, step,
                reason: Some(RetirementReason::CaptureFailed), detail: Some(format!("native predecessor capture failed; all remaining custody files retained: {}", serde_json::to_string(&descriptor.capture_errors).map_err(|error| error.to_string())?)), diagnostic_persistence_error: None });
        }
        if let Some(diagnostic) = self.check_acknowledged_absence(guard, &descriptor, step)? {
            return Ok(diagnostic);
        }
        if step == 3 {
            return self.note_retirement(guard, RetirementDiagnostic::complete());
        }
        if current_sha.as_deref()
            != Some(descriptor.preservation.successor_baseline_sha256.as_str())
        {
            return self.note_retirement(
                guard,
                RetirementDiagnostic {
                    state: RetirementState::Retained,
                    step,
                    reason: Some(RetirementReason::SuccessorChanged),
                    detail: Some(
                        "successor image changed before predecessor retirement; files retained"
                            .into(),
                    ),
                    diagnostic_persistence_error: None,
                },
            );
        }
        for _ in 0..action_budget.min(3) {
            if let Some(diagnostic) = self.check_acknowledged_absence(guard, &descriptor, step)? {
                return Ok(diagnostic);
            }
            if self.validate_active_locked(guard)?.as_deref()
                != Some(descriptor.preservation.successor_baseline_sha256.as_str())
            {
                return Err("current native successor changed during retirement".into());
            }
            let leaf = descriptor.leaves()[step as usize];
            let pin = match capture_compiler_retired_file_locked(guard, &self.directory, &leaf.leaf)
            {
                Ok(pin) => pin,
                Err(error) => {
                    return self.note_retirement(
                        guard,
                        RetirementDiagnostic {
                            state: RetirementState::Failed,
                            step,
                            reason: Some(RetirementReason::CleanupIo),
                            detail: Some(error),
                            diagnostic_persistence_error: None,
                        },
                    )
                }
            };
            if let Some(pin) = pin {
                let (text, sha, identity) = match read_compiler_retired_file_pin_locked(guard, &pin)
                {
                    Ok(observed) => observed,
                    Err(error) => {
                        return self.note_retirement(
                            guard,
                            RetirementDiagnostic {
                                state: RetirementState::Failed,
                                step,
                                reason: Some(RetirementReason::CleanupIo),
                                detail: Some(error),
                                diagnostic_persistence_error: None,
                            },
                        )
                    }
                };
                if leaf.snapshot.as_ref() != Some(&Snapshot::native(&identity, text.len())?)
                    || sha != leaf.sha256
                {
                    return self.note_retirement(
                        guard,
                        RetirementDiagnostic {
                            state: RetirementState::Retained,
                            step,
                            reason: Some(if step == 0 && sha != leaf.sha256 {
                                RetirementReason::UniqueHumanBytes
                            } else {
                                RetirementReason::ResidueChanged
                            }),
                            detail: Some(
                                "predecessor bytes or native identity changed; files retained"
                                    .into(),
                            ),
                            diagnostic_persistence_error: None,
                        },
                    );
                }
                if let Err(error) =
                    unlink_compiler_retired_file_pin_locked(guard, &pin, &leaf.sha256)
                {
                    return self.note_retirement(
                        guard,
                        RetirementDiagnostic {
                            state: RetirementState::Failed,
                            step,
                            reason: Some(RetirementReason::CleanupIo),
                            detail: Some(error),
                            diagnostic_persistence_error: None,
                        },
                    );
                }
                #[cfg(test)]
                if let Some(hook) = AFTER_UNLINK
                    .lock()
                    .map_err(|_| "compiler retirement test hook poisoned")?
                    .take()
                {
                    if let Err(error) = hook(&self.directory.path().join(&leaf.leaf)) {
                        return self.note_retirement(
                            guard,
                            RetirementDiagnostic {
                                state: RetirementState::Failed,
                                step,
                                reason: Some(RetirementReason::CleanupIo),
                                detail: Some(error),
                                diagnostic_persistence_error: None,
                            },
                        );
                    }
                }
            } else if let Err(error) = self.directory.sync() {
                return self.note_retirement(
                    guard,
                    RetirementDiagnostic {
                        state: RetirementState::Failed,
                        step,
                        reason: Some(RetirementReason::CleanupIo),
                        detail: Some(error),
                        diagnostic_persistence_error: None,
                    },
                );
            }
            step += 1;
            let diagnostic = if step == 3 {
                RetirementDiagnostic::complete()
            } else {
                RetirementDiagnostic {
                    state: RetirementState::Pending,
                    step,
                    reason: Some(RetirementReason::Cutoff),
                    detail: None,
                    diagnostic_persistence_error: None,
                }
            };
            let acknowledged = self.note_retirement(guard, diagnostic)?;
            if acknowledged.is_failed() || step == 3 {
                return Ok(acknowledged);
            }
        }
        self.note_retirement(
            guard,
            RetirementDiagnostic {
                state: RetirementState::Pending,
                step,
                reason: Some(RetirementReason::Cutoff),
                detail: None,
                diagnostic_persistence_error: None,
            },
        )
    }
}
