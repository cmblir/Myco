//! Closed QA selection and the parameters shared by decoder and receipts.

use super::generation_telemetry::SamplerProfile;
use super::GenerationSchema;
use llama_cpp_2::{model::LlamaModel, sampling::LlamaSampler};
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GroundedSamplerStage {
    Grammar,
    Penalties,
    TopK,
    TopP,
    Temperature,
    Dist,
}

/// Read-only description; callers cannot pass parameters into a generation API.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroundedSamplerParameters {
    pub profile: SamplerProfile,
    pub order: [GroundedSamplerStage; 6],
    pub penalty_last_n: i32,
    pub repeat_penalty: f32,
    pub frequency_penalty: f32,
    pub presence_penalty: f32,
    pub top_k: i32,
    pub top_p: f32,
    pub min_keep: usize,
    pub temperature: f32,
    pub seed: u32,
}

const EXISTING_GROUNDED: GroundedSamplerParameters = GroundedSamplerParameters {
    profile: SamplerProfile::ExistingGroundedV1,
    order: [
        GroundedSamplerStage::Grammar,
        GroundedSamplerStage::Penalties,
        GroundedSamplerStage::TopK,
        GroundedSamplerStage::TopP,
        GroundedSamplerStage::Temperature,
        GroundedSamplerStage::Dist,
    ],
    penalty_last_n: 256,
    repeat_penalty: 1.0,
    frequency_penalty: 0.0,
    presence_penalty: 1.5,
    top_k: 20,
    top_p: 0.8,
    min_keep: 1,
    temperature: 0.7,
    seed: 42,
};

/// Fixed prose-reading QA chain; its values cannot configure a generation call.
#[cfg(feature = "native-index-probe")]
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceReadingQaSamplerParameters {
    pub profile: SamplerProfile,
    pub order: [GroundedSamplerStage; 5],
    pub penalty_last_n: i32,
    pub repeat_penalty: f32,
    pub frequency_penalty: f32,
    pub presence_penalty: f32,
    pub top_k: i32,
    pub top_p: f32,
    pub min_keep: usize,
    pub temperature: f32,
    pub seed: u32,
}

#[cfg(feature = "native-index-probe")]
pub(super) fn source_reading_qa_parameters() -> SourceReadingQaSamplerParameters {
    SourceReadingQaSamplerParameters {
        profile: SamplerProfile::ExistingGroundedGrammarFreeQaV1,
        order: [
            EXISTING_GROUNDED.order[1],
            EXISTING_GROUNDED.order[2],
            EXISTING_GROUNDED.order[3],
            EXISTING_GROUNDED.order[4],
            EXISTING_GROUNDED.order[5],
        ],
        penalty_last_n: EXISTING_GROUNDED.penalty_last_n,
        repeat_penalty: EXISTING_GROUNDED.repeat_penalty,
        frequency_penalty: EXISTING_GROUNDED.frequency_penalty,
        presence_penalty: EXISTING_GROUNDED.presence_penalty,
        top_k: EXISTING_GROUNDED.top_k,
        top_p: EXISTING_GROUNDED.top_p,
        min_keep: EXISTING_GROUNDED.min_keep,
        temperature: EXISTING_GROUNDED.temperature,
        seed: EXISTING_GROUNDED.seed,
    }
}

#[cfg(feature = "native-index-probe")]
const NO_PRESENCE_QA: GroundedSamplerParameters = GroundedSamplerParameters {
    profile: SamplerProfile::ExistingGroundedNoPresenceQaV1,
    presence_penalty: 0.0,
    ..EXISTING_GROUNDED
};

#[cfg(feature = "native-index-probe")]
const GEMMA_INSTRUCTION_FAMILY_QA: GroundedSamplerParameters = GroundedSamplerParameters {
    profile: SamplerProfile::GemmaInstructionFamilyQaV1,
    top_k: 64,
    top_p: 0.95,
    temperature: 1.0,
    ..EXISTING_GROUNDED
};

#[cfg(feature = "native-index-probe")]
const GEMMA12B_ORDINAL_QA: GroundedSamplerParameters = GroundedSamplerParameters {
    profile: SamplerProfile::Gemma12BOrdinalQaV1,
    top_k: 64,
    top_p: 0.95,
    temperature: 1.0,
    // Inert penalties are project QA policy, not a Google sampling instruction.
    repeat_penalty: 1.0,
    frequency_penalty: 0.0,
    presence_penalty: 0.0,
    ..EXISTING_GROUNDED
};

/// Closed QA sampling profiles; ordinary product calls keep their defaults.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg(feature = "native-index-probe")]
pub enum WikiClaimsSamplerQaProfile {
    ExistingGroundedV1,
    ExistingGroundedNoPresenceQaV1,
    GemmaInstructionFamilyQaV1,
    Gemma12BOrdinalQaV1,
}

#[cfg(feature = "native-index-probe")]
impl WikiClaimsSamplerQaProfile {
    /// Describe the closed configuration selected for this QA attempt.
    pub fn qa_parameters(self) -> GroundedSamplerParameters {
        match self {
            Self::ExistingGroundedV1 => EXISTING_GROUNDED,
            Self::ExistingGroundedNoPresenceQaV1 => NO_PRESENCE_QA,
            Self::GemmaInstructionFamilyQaV1 => GEMMA_INSTRUCTION_FAMILY_QA,
            Self::Gemma12BOrdinalQaV1 => GEMMA12B_ORDINAL_QA,
        }
    }
}

pub(super) fn penalty_sampler(parameters: &GroundedSamplerParameters) -> LlamaSampler {
    LlamaSampler::penalties(
        parameters.penalty_last_n,
        parameters.repeat_penalty,
        parameters.frequency_penalty,
        parameters.presence_penalty,
    )
}

/// The QA thought phase omits grammar and keeps every existing numeric parameter.
#[cfg(feature = "native-index-probe")]
pub(super) fn thinking_qa_sampler() -> LlamaSampler {
    LlamaSampler::chain_simple([
        penalty_sampler(&EXISTING_GROUNDED),
        LlamaSampler::top_k(EXISTING_GROUNDED.top_k),
        LlamaSampler::top_p(EXISTING_GROUNDED.top_p, EXISTING_GROUNDED.min_keep),
        LlamaSampler::temp(EXISTING_GROUNDED.temperature),
        LlamaSampler::dist(EXISTING_GROUNDED.seed),
    ])
}

pub(super) fn sampler(
    model: &LlamaModel,
    schema: GenerationSchema,
    profile: SamplerProfile,
) -> Result<LlamaSampler, String> {
    let parameters = structured_parameters(profile)?;
    chain(
        model,
        &schema.grammar(),
        &format!("local {schema:?} grammar"),
        parameters,
    )
}

pub(super) fn structured_parameters(
    profile: SamplerProfile,
) -> Result<GroundedSamplerParameters, String> {
    match profile {
        SamplerProfile::ExistingGroundedV1 => Ok(EXISTING_GROUNDED),
        #[cfg(feature = "native-index-probe")]
        SamplerProfile::ExistingGroundedNoPresenceQaV1 => Ok(NO_PRESENCE_QA),
        #[cfg(feature = "native-index-probe")]
        SamplerProfile::GemmaInstructionFamilyQaV1 => Ok(GEMMA_INSTRUCTION_FAMILY_QA),
        #[cfg(feature = "native-index-probe")]
        SamplerProfile::Gemma12BOrdinalQaV1 => Ok(GEMMA12B_ORDINAL_QA),
        #[cfg(feature = "native-index-probe")]
        SamplerProfile::ExistingGroundedGrammarFreeQaV1 => {
            Err("structured sampler rejects grammar-free QA profile".into())
        }
        SamplerProfile::ExistingFreeformV1 => {
            Err("grounded sampler requires a grounded profile".into())
        }
    }
}

pub(super) fn session_review_sampler(
    model: &LlamaModel,
    contract: &super::SessionReviewDecode,
) -> Result<LlamaSampler, String> {
    chain(
        model,
        contract.grammar(),
        "local SessionReviewV1 native decision grammar",
        EXISTING_GROUNDED,
    )
}

#[cfg(feature = "native-index-probe")]
pub(super) fn session_review_qa_sampler(
    model: &LlamaModel,
    contract: &super::SessionReviewDecodeQa,
) -> Result<LlamaSampler, String> {
    chain(
        model,
        contract.grammar(),
        "local SessionReviewCorrelatedQaV1 grammar",
        EXISTING_GROUNDED,
    )
}

fn chain(
    model: &LlamaModel,
    grammar: &str,
    error_label: &str,
    parameters: GroundedSamplerParameters,
) -> Result<LlamaSampler, String> {
    // The closed order and values also form the QA receipt; callers cannot override them.
    let mut chain = Vec::with_capacity(parameters.order.len());
    for stage in parameters.order {
        let sampler = match stage {
            GroundedSamplerStage::Grammar => LlamaSampler::grammar(model, grammar, "root")
                .map_err(|error| format!("{error_label}: {error}"))?,
            GroundedSamplerStage::Penalties => penalty_sampler(&parameters),
            GroundedSamplerStage::TopK => LlamaSampler::top_k(parameters.top_k),
            GroundedSamplerStage::TopP => {
                LlamaSampler::top_p(parameters.top_p, parameters.min_keep)
            }
            GroundedSamplerStage::Temperature => LlamaSampler::temp(parameters.temperature),
            GroundedSamplerStage::Dist => LlamaSampler::dist(parameters.seed),
        };
        chain.push(sampler);
    }
    Ok(LlamaSampler::chain_simple(chain))
}
