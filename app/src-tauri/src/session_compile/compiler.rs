//! Resumable session compilation using the production tokenizer/generator.
//! Persistent cursor data does not restore this native runtime's review grants.

use super::materializer::{self, MaterializedSessionV1};
use super::review::{self, NativeReview};
use super::review_decode::SessionReviewDecode;
use super::schema::{self, NativeClaim};
use super::sources::{self, PacketPlan, CONTEXT_TOKENS, MAX_INPUT_TOKENS, OUTPUT_TOKENS};
use super::state::{CheckState, CompilerBatch, CompilerProgress, ProcessingChecks};
use super::structure;
use crate::importers::wikify::source_revision;
use crate::retrieval::Scope;
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::{CheckedClaims, CompilationOriginal, SourceSet};
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CompilerSchema {
    Claims,
    Compilation,
    Review,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompiledPacket {
    pub index: usize,
    pub claims: Vec<NativeClaim>,
    pub compilation: MaterializedSessionV1,
}

/// Issued by an in-memory run after all exact original packets were checked and
/// separately reviewed. This type is intentionally not Deserialize.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeCompilation {
    attempt_id: String,
    compile_signature: String,
    source_revision: String,
    plan_revision: String,
    packets: Vec<CompiledPacket>,
    reviews: Vec<NativeReview>,
    eligible_windows: usize,
    independent_verification_receipts: usize,
    release_ground_truth: bool,
    language: String,
}

impl NativeCompilation {
    pub(crate) fn checks(&self) -> ProcessingChecks {
        ProcessingChecks {
            original_source: CheckState::Passed,
            source_schema: CheckState::Passed,
            semantic_review: CheckState::Passed,
            eligible_units: self.eligible_windows,
            processed_units: self.packets.len(),
            omitted_units: self.eligible_windows - self.packets.len(),
        }
    }
    pub(crate) fn attempt_id(&self) -> &str {
        &self.attempt_id
    }
    pub(crate) fn signature(&self) -> &str {
        &self.compile_signature
    }
    pub(crate) fn source_revision(&self) -> &str {
        &self.source_revision
    }
    pub(crate) fn packets(&self) -> &[CompiledPacket] {
        &self.packets
    }
    pub(crate) fn language(&self) -> &str {
        &self.language
    }
    pub(crate) fn revision(&self) -> Result<String, String> {
        Ok(source_revision(
            &serde_json::to_string(self).map_err(|error| error.to_string())?,
        ))
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StepReceipt {
    pub packet_index: usize,
    pub processed_windows: usize,
    pub eligible_windows: usize,
    pub omitted_windows: usize,
    pub review_accepted: bool,
    pub native_review_revision: String,
    pub source_schema_checked: bool,
    pub all_packets_seen: bool,
}

/// The host stores this only in its private attempt registry, takes it out
/// before inference, then rechecks opening -> role -> queue before checkpoint.
#[derive(Default)]
pub(crate) struct CompilerRun {
    attempt_id: String,
    compile_signature: String,
    plan_revision: Option<String>,
    packets: BTreeMap<usize, CompiledPacket>,
    reviews: BTreeMap<usize, NativeReview>,
    origin: Option<AgentVaultSession>,
    unavailable_stage: Option<UnavailableStage>,
}

struct UnavailableStage {
    input_progress_revision: String,
    batch: CompilerBatch,
}

impl CompilerRun {
    pub(crate) fn new(attempt_id: &str, compile_signature: &str) -> Self {
        Self {
            attempt_id: attempt_id.into(),
            compile_signature: compile_signature.into(),
            ..Self::default()
        }
    }

    fn validate_progress(
        &self,
        plan: &PacketPlan,
        progress: &CompilerProgress,
    ) -> Result<(), String> {
        if self.attempt_id.is_empty()
            || self.compile_signature.is_empty()
            || progress.version != 1
            || progress.source_revision != plan.source.source_revision
            || progress.compile_signature != self.compile_signature
            || progress.plan_revision != plan.revision
            || progress.language != plan.language
            || progress.next_packet != progress.batches.len()
            || progress.next_packet > plan.windows.len()
            || progress.unreviewed_batch.as_ref().is_some_and(|batch| {
                batch.index != progress.next_packet
                    || batch.review_output.is_some()
                    || progress.next_packet >= plan.windows.len()
            })
            || self
                .plan_revision
                .as_deref()
                .is_some_and(|revision| revision != plan.revision)
        {
            return Err("compiler progress source, signature, plan or cursor changed".into());
        }
        for (index, batch) in progress.batches.iter().enumerate().chain(
            progress
                .unreviewed_batch
                .iter()
                .map(|batch| (progress.next_packet, batch)),
        ) {
            if batch.index != index
                || batch.packet_revision != plan.packet_revision(index)?
                || batch.extraction_output.len() > 32 * 1024
                || batch.compilation_output.len() > 32 * 1024
                || batch
                    .review_output
                    .as_ref()
                    .is_some_and(|output| output.len() > 32 * 1024)
            {
                return Err(
                    "compiler progress contains an unbound or reordered source packet".into(),
                );
            }
        }
        Ok(())
    }

    pub(crate) fn initial_progress(&self, plan: &PacketPlan) -> CompilerProgress {
        CompilerProgress {
            version: 1,
            source_revision: plan.source.source_revision.clone(),
            compile_signature: self.compile_signature.clone(),
            plan_revision: plan.revision.clone(),
            next_packet: 0,
            batches: vec![],
            unreviewed_batch: None,
            language: plan.language.clone(),
        }
    }

    /// At most one packet is extracted/compiled/reviewed per call. There is no
    /// fixed session batch ceiling; callers checkpoint then continue to the tail.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn step_with_decode(
        &mut self,
        plan: &PacketPlan,
        original: &CompilationOriginal<'_>,
        origin: &AgentVaultSession,
        lang: &str,
        progress: &mut CompilerProgress,
        mut token_count: impl FnMut(&str, &str) -> Result<usize, String>,
        mut generate: impl FnMut(
            &str,
            &str,
            i32,
            u32,
            CompilerSchema,
            Option<&SessionReviewDecode>,
        ) -> Result<String, String>,
    ) -> Result<StepReceipt, String> {
        self.unavailable_stage = None;
        self.validate_progress(plan, progress)?;
        let input_progress_revision =
            source_revision(&serde_json::to_string(progress).map_err(|error| error.to_string())?);
        if !matches!(lang, "ko" | "en" | "ja") || lang != plan.language {
            return Err("unsupported or changed compiler language".into());
        }
        if self.origin.as_ref().is_some_and(|bound| {
            bound.vault_path != origin.vault_path || bound.opening_token != origin.opening_token
        }) {
            return Err("native compiler run belongs to a different opening".into());
        }
        // Never trust persisted next_packet to skip the fresh attempt's reviews.
        let index = (0..progress.batches.len())
            .find(|index| !self.reviews.contains_key(index))
            .unwrap_or(progress.next_packet);
        if index >= plan.windows.len() {
            return Err("all compiler packets were already visited".into());
        }
        let packet = plan.packet(index, original, origin)?;
        let stored = progress.batches.get(index).or_else(|| {
            progress
                .unreviewed_batch
                .as_ref()
                .filter(|batch| batch.index == index)
        });
        let (claims, batch) = if let Some(stored) = stored {
            let claims = bind_claims(&packet, &stored.extraction_output, origin, index)?;
            (claims, stored.clone())
        } else {
            let user = sources::extraction_payload(plan, &packet, lang)?;
            let system = crate::local_synthesis::claim_prompt::extraction_reading_system();
            fits(&system, &user, &mut token_count)?;
            let extraction_output = generate(
                &system,
                &user,
                OUTPUT_TOKENS,
                CONTEXT_TOKENS,
                CompilerSchema::Claims,
                None,
            )?;
            let claims = bind_claims(&packet, &extraction_output, origin, index)?;
            let compilation_output = if claims.is_empty() {
                // Empty structure has no model decisions; full source coverage
                // still requires the separate review below.
                structure::empty_output()?
            } else {
                let user = schema::payload(lang, &claims)?;
                fits(structure::SYSTEM, &user, &mut token_count)?;
                generate(
                    structure::SYSTEM,
                    &user,
                    OUTPUT_TOKENS,
                    CONTEXT_TOKENS,
                    CompilerSchema::Compilation,
                    None,
                )?
            };
            let batch = CompilerBatch {
                index,
                packet_revision: plan.packet_revision(index)?,
                extraction_output,
                compilation_output,
                review_output: None,
            };
            (claims, batch)
        };
        let structure = structure::validate(&batch.compilation_output, &claims)?;
        let compilation = materializer::materialize(structure, &claims, lang)?;
        self.plan_revision = Some(plan.revision.clone());
        self.origin = Some(origin.clone());
        let verdict = match review::run_typed(
            plan,
            index,
            &self.compile_signature,
            lang,
            &packet,
            &claims,
            &compilation,
            &mut token_count,
            &mut generate,
        ) {
            Ok(verdict) => verdict,
            Err(review::ReviewFailure::Unavailable(message)) => {
                self.unavailable_stage = Some(UnavailableStage {
                    input_progress_revision,
                    batch,
                });
                return Err(message);
            }
            Err(review::ReviewFailure::InvalidOutput(message)) => return Err(message),
        };
        let mut batch = batch;
        batch.review_output = Some(verdict.durable_output().into());
        if index == progress.batches.len() {
            progress.batches.push(batch);
            progress.unreviewed_batch = None;
        } else {
            progress.batches[index] = batch;
        }
        progress.next_packet = progress.batches.len();
        let review_accepted = verdict.accepted();
        let native_review_revision = verdict.output_revision().into();
        self.packets.insert(
            index,
            CompiledPacket {
                index,
                claims,
                compilation,
            },
        );
        self.reviews.insert(index, verdict);
        Ok(StepReceipt {
            packet_index: index,
            processed_windows: self.packets.len(),
            eligible_windows: plan.windows.len(),
            omitted_windows: plan.windows.len() - self.packets.len(),
            review_accepted,
            native_review_revision,
            source_schema_checked: true,
            all_packets_seen: self.packets.len() == plan.windows.len(),
        })
    }

    /// Existing synthetic callbacks prove native validation independently of
    /// constrained decoding. Only production callbacks receive the contract.
    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn step(
        &mut self,
        plan: &PacketPlan,
        original: &CompilationOriginal<'_>,
        origin: &AgentVaultSession,
        lang: &str,
        progress: &mut CompilerProgress,
        token_count: impl FnMut(&str, &str) -> Result<usize, String>,
        mut generate: impl FnMut(&str, &str, i32, u32, CompilerSchema) -> Result<String, String>,
    ) -> Result<StepReceipt, String> {
        self.step_with_decode(
            plan,
            original,
            origin,
            lang,
            progress,
            token_count,
            |system, user, output, context, schema, _| {
                generate(system, user, output, context, schema)
            },
        )
    }

    /// A runtime-issued review failure exposes only a checkpoint copy. The
    /// caller's progress remains unchanged until the host confirms persistence.
    pub(super) fn unavailable_checkpoint(
        &self,
        plan: &PacketPlan,
        progress: &CompilerProgress,
    ) -> Result<Option<CompilerProgress>, String> {
        let Some(stage) = &self.unavailable_stage else {
            return Ok(None);
        };
        self.validate_progress(plan, progress)?;
        let revision =
            source_revision(&serde_json::to_string(progress).map_err(|error| error.to_string())?);
        if revision != stage.input_progress_revision
            || stage.batch.packet_revision != plan.packet_revision(stage.batch.index)?
        {
            return Err("unavailable compiler draft belongs to different progress".into());
        }
        let mut checkpoint = progress.clone();
        if stage.batch.index == progress.batches.len() {
            checkpoint.unreviewed_batch = Some(stage.batch.clone());
        }
        self.validate_progress(plan, &checkpoint)?;
        Ok(Some(checkpoint))
    }

    /// Unreviewed raw data counts as a valid draft, never a processed packet.
    pub(super) fn unavailable_checks(&self, plan: &PacketPlan) -> Option<ProcessingChecks> {
        let stage = self.unavailable_stage.as_ref()?;
        if self.plan_revision.as_deref() != Some(plan.revision.as_str())
            || stage.batch.packet_revision != plan.packet_revision(stage.batch.index).ok()?
        {
            return None;
        }
        Some(ProcessingChecks {
            original_source: CheckState::Passed,
            source_schema: CheckState::Passed,
            semantic_review: CheckState::Unavailable,
            eligible_units: plan.windows.len(),
            processed_units: self.reviews.len(),
            omitted_units: plan.windows.len().checked_sub(self.reviews.len())?,
        })
    }

    /// Model-generated review is necessary here but not release ground truth.
    /// The Goal's held-out source-reviewed quality gate remains separate.
    pub(crate) fn completed(
        &self,
        plan: &PacketPlan,
        progress: &CompilerProgress,
    ) -> Result<Option<NativeCompilation>, String> {
        self.validate_progress(plan, progress)?;
        if progress.unreviewed_batch.is_some()
            || progress.next_packet != plan.windows.len()
            || self.packets.len() != plan.windows.len()
            || self.reviews.len() != plan.windows.len()
        {
            return Ok(None);
        }
        for index in 0..plan.windows.len() {
            let packet = self
                .packets
                .get(&index)
                .ok_or("native compiler packet is missing")?;
            let verdict = self
                .reviews
                .get(&index)
                .ok_or("native compiler review is missing")?;
            let revision = source_revision(
                &serde_json::to_string(packet.compilation.as_view())
                    .map_err(|error| error.to_string())?,
            );
            if !verdict.binds(
                &plan.source.source_revision,
                &self.compile_signature,
                &plan.packet_revision(index)?,
                &revision,
            ) || !verdict.accepted()
            {
                return Ok(None);
            }
        }
        Ok(Some(NativeCompilation {
            attempt_id: self.attempt_id.clone(),
            compile_signature: self.compile_signature.clone(),
            source_revision: plan.source.source_revision.clone(),
            plan_revision: plan.revision.clone(),
            packets: self.packets.values().cloned().collect(),
            reviews: self.reviews.values().cloned().collect(),
            eligible_windows: plan.windows.len(),
            independent_verification_receipts: 0,
            release_ground_truth: false,
            language: plan.language.clone(),
        }))
    }
}

fn fits(
    system: &str,
    user: &str,
    token_count: &mut impl FnMut(&str, &str) -> Result<usize, String>,
) -> Result<(), String> {
    if token_count(system, user)? > MAX_INPUT_TOKENS {
        return Err(
            "compiler stage requires a smaller exact-source packet; remains partial".into(),
        );
    }
    Ok(())
}

pub(super) fn bind_claims(
    packet: &SourceSet,
    output: &str,
    origin: &AgentVaultSession,
    index: usize,
) -> Result<Vec<NativeClaim>, String> {
    let CheckedClaims { claims, .. } = packet.validate(output, origin, Scope::All)?;
    claims
        .into_iter()
        .enumerate()
        .map(|(ordinal, claim)| {
            let revision = source_revision(
                &serde_json::to_string(&claim.proposal).map_err(|error| error.to_string())?,
            );
            Ok(NativeClaim {
                id: format!("C-{index}-{ordinal}-{}", &revision[..16]),
                claim,
            })
        })
        .collect()
}

#[cfg(test)]
#[path = "compiler_tests.rs"]
mod tests;
#[cfg(test)]
pub(super) use tests::model as fixture_model;
#[cfg(test)]
#[path = "compiler_unreviewed_tests.rs"]
mod unreviewed_tests;
