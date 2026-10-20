//! Closed replay inputs; original bytes and pins must be checked before loading.

use myco_lib::local_llm::GenerationSchema;
use myco_lib::local_model::{ModelManifest, GEMMA_CANDIDATE, MODEL};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_PACKET_BYTES: usize = 256 * 1024;
pub(super) const OUTPUT_BUDGETS: [i32; 2] = [768, 1536];

pub(super) struct Options {
    pub model_dir: PathBuf,
    pub model_id: String,
    pub packet_path: PathBuf,
    pub packet_sha256: String,
    pub execution_registration: Option<ExecutionRegistrationOptions>,
}

pub(super) struct ExecutionRegistrationOptions {
    pub path: PathBuf,
    pub sha256: String,
}

pub(super) fn options(arguments: impl IntoIterator<Item = String>) -> Result<Options, String> {
    let mut arguments = arguments.into_iter();
    let mut values = std::collections::BTreeMap::new();
    while let Some(flag) = arguments.next() {
        if !matches!(
            flag.as_str(),
            "--model-dir"
                | "--model-id"
                | "--packet"
                | "--packet-sha256"
                | "--execution-registration"
                | "--execution-registration-sha256"
        ) {
            return Err(format!("unsupported exact replay argument: {flag}"));
        }
        let value = arguments
            .next()
            .ok_or_else(|| format!("missing value for {flag}"))?;
        if value.trim().is_empty()
            || value.starts_with("--")
            || values.insert(flag.clone(), value).is_some()
        {
            return Err(format!("empty or duplicate exact replay argument: {flag}"));
        }
    }
    let mut required = |key: &str| values.remove(key).ok_or_else(|| format!("missing {key}"));
    let model_id = required("--model-id")?;
    model(&model_id)?;
    let packet_sha256 = required("--packet-sha256")?;
    if !is_digest(&packet_sha256) {
        return Err("replay packet SHA must be a registered lowercase SHA256".into());
    }
    let model_dir = PathBuf::from(required("--model-dir")?);
    let packet_path = PathBuf::from(required("--packet")?);
    let execution_registration = match (
        values.remove("--execution-registration"),
        values.remove("--execution-registration-sha256"),
    ) {
        (None, None) => None,
        (Some(path), Some(sha256)) if is_digest(&sha256) => Some(ExecutionRegistrationOptions {
            path: path.into(),
            sha256,
        }),
        _ => return Err("execution registration requires both path and lowercase SHA256".into()),
    };
    Ok(Options {
        model_dir,
        model_id,
        packet_path,
        packet_sha256,
        execution_registration,
    })
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Packet {
    pub version: u8,
    pub data_scope: String,
    pub source: SourcePins,
    pub model: ModelPins,
    pub runtime: RuntimePins,
    pub sampler: SamplerPins,
    pub system: String,
    pub system_sha256: String,
    pub user: String,
    pub user_sha256: String,
    pub context_tokens: u32,
    pub original_output_tokens: i32,
    pub original_prompt_tokens: usize,
    pub original_schema: String,
    pub original_loop_stop: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SourcePins {
    pub record_sha256: String,
    pub build_receipt_sha256: String,
    pub source_receipt_sha256: String,
    pub observation_ordinal: u32,
    pub request_id: String,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct ModelPins {
    pub id: String,
    pub repository: String,
    pub revision: String,
    pub file: String,
    pub url: String,
    pub bytes: u64,
    pub sha256: String,
    pub license: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RuntimePins {
    pub cargo_lock_sha256: String,
    pub decoder_source_sha256: String,
    pub gemma_template_source_sha256: String,
    pub grammar_sha256: String,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SamplerPins {
    pub profile: String,
    pub order: Vec<String>,
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

pub(super) fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(super) fn model(id: &str) -> Result<&'static ModelManifest, String> {
    match id {
        id if id == MODEL.id => Ok(&MODEL),
        id if id == GEMMA_CANDIDATE.id => Ok(&GEMMA_CANDIDATE),
        _ => Err("exact replay requires explicit pinned Qwen4B or Gemma model ID".into()),
    }
}

pub(super) fn runtime() -> RuntimePins {
    RuntimePins {
        cargo_lock_sha256: hash(include_bytes!("../../Cargo.lock")),
        decoder_source_sha256: hash(include_bytes!("../../src/local_llm.rs")),
        gemma_template_source_sha256: hash(include_bytes!("../../src/local_llm/gemma4.rs")),
        grammar_sha256: GenerationSchema::WikiClaimsV1.qa_grammar_sha256(),
    }
}

pub(super) fn sampler() -> SamplerPins {
    SamplerPins {
        profile: "existingGroundedV1".into(),
        order: [
            "grammar",
            "penalties",
            "top_k",
            "top_p",
            "temperature",
            "dist",
        ]
        .map(String::from)
        .to_vec(),
        penalty_last_n: 256,
        repeat_penalty: 1.0,
        frequency_penalty: 0.0,
        presence_penalty: 1.5,
        top_k: 20,
        top_p: 0.8,
        min_keep: 1,
        temperature: 0.7,
        seed: 42,
    }
}

pub(super) fn is_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(super) fn read(path: &Path, expected_sha: &str, id: &str) -> Result<Packet, String> {
    parse(&read_bytes(path, expected_sha)?, expected_sha, id)
}

pub(super) fn read_bytes(path: &Path, expected_sha: &str) -> Result<Vec<u8>, String> {
    let before = std::fs::symlink_metadata(path)
        .map_err(|error| format!("replay packet metadata: {error}"))?;
    if !before.is_file() || before.len() == 0 || before.len() > MAX_PACKET_BYTES as u64 {
        return Err("replay packet must be a bounded nonempty regular file".into());
    }
    let file = File::open(path).map_err(|error| format!("replay packet open: {error}"))?;
    let opened = file
        .metadata()
        .map_err(|error| format!("replay packet opened metadata: {error}"))?;
    if !opened.is_file() || opened.len() > MAX_PACKET_BYTES as u64 {
        return Err("replay packet opened file is invalid".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != opened.dev() || before.ino() != opened.ino() || opened.nlink() != 1 {
            return Err("replay packet identity changed or has aliases".into());
        }
    }
    let mut bytes = Vec::new();
    file.take((MAX_PACKET_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("replay packet read: {error}"))?;
    if bytes.is_empty()
        || bytes.len() > MAX_PACKET_BYTES
        || !is_digest(expected_sha)
        || hash(&bytes) != expected_sha
    {
        return Err("replay packet differs from registered bytes or size".into());
    }
    Ok(bytes)
}

pub(super) fn parse(bytes: &[u8], expected_sha: &str, id: &str) -> Result<Packet, String> {
    parse_original(bytes, expected_sha, id, &runtime())
}

pub(super) fn parse_original(
    bytes: &[u8],
    expected_sha: &str,
    id: &str,
    original_runtime: &RuntimePins,
) -> Result<Packet, String> {
    let selected = model(id)?;
    if bytes.is_empty()
        || bytes.len() > MAX_PACKET_BYTES
        || !is_digest(expected_sha)
        || hash(bytes) != expected_sha
    {
        return Err("replay packet differs from registered bytes or size".into());
    }
    let packet: Packet =
        serde_json::from_slice(bytes).map_err(|error| format!("replay packet: {error}"))?;
    let pinned: ModelPins =
        serde_json::from_value(serde_json::to_value(selected).map_err(|error| error.to_string())?)
            .map_err(|error| format!("replay pinned manifest: {error}"))?;
    if packet.model != pinned || &packet.runtime != original_runtime || packet.sampler != sampler()
    {
        return Err("replay model, runtime, grammar or sampler differs from registration".into());
    }
    if packet.version != 1
        || packet.data_scope != "synthetic-native-activity-development"
        || packet.context_tokens != 4096
        || packet.original_output_tokens != 768
        || packet.original_prompt_tokens == 0
        || packet.original_prompt_tokens > 3320
        || packet.original_schema != "wikiClaimsV1"
        || packet.original_loop_stop != "outputBudget"
        || packet.source.observation_ordinal == 0
        || packet.source.request_id.trim().is_empty()
        || packet.source.request_id.len() > 128
        || [
            &packet.source.record_sha256,
            &packet.source.build_receipt_sha256,
            &packet.source.source_receipt_sha256,
        ]
        .iter()
        .any(|digest| !is_digest(digest))
    {
        return Err("replay original observation registration is invalid".into());
    }
    if packet.system.trim().is_empty()
        || packet.system.len() > 16 * 1024
        || packet.user.trim().is_empty()
        || packet.user.len() > 128 * 1024
        || hash(packet.system.as_bytes()) != packet.system_sha256
        || hash(packet.user.as_bytes()) != packet.user_sha256
    {
        return Err("replay original message bytes or hashes changed".into());
    }
    Ok(packet)
}

pub(super) fn preflight(
    packet: &Packet,
    actual_prompt_tokens: usize,
    output_tokens: i32,
) -> Result<(), String> {
    if actual_prompt_tokens != packet.original_prompt_tokens {
        return Err("replay tokenizer/template count differs from original observation".into());
    }
    if !OUTPUT_BUDGETS.contains(&output_tokens)
        || actual_prompt_tokens
            .checked_add(output_tokens as usize)
            .and_then(|sum| sum.checked_add(8))
            .map_or(true, |sum| sum > packet.context_tokens as usize)
    {
        return Err("replay full input and output reserve do not fit".into());
    }
    Ok(())
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
