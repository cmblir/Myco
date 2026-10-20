//! Closed QA execution registration; historical inputs confer no native authority.

use crate::contract::{hash, is_digest, model, parse_original, read_bytes, Packet, RuntimePins};
use myco_lib::local_model::GEMMA_CANDIDATE;
use serde::{Deserialize, Serialize};
use std::path::Path;

pub(super) const PROFILES: [&str; 2] = ["existingGroundedV1", "existingGroundedNoPresenceQaV1"];
const FAMILY_PROFILES: [&str; 2] = ["existingGroundedV1", "gemmaInstructionFamilyQaV1"];
pub(super) const OUTPUT_TOKENS: i32 = 1536;
pub(super) const CONTEXT_TOKENS: u32 = 4096;
const MAX_REGISTRATION_BYTES: usize = 256 * 1024;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Registration {
    pub version: u8,
    pub treatment: String,
    pub original_packet_sha256: String,
    pub original_input_provenance_receipt_sha256: String,
    pub original_runtime: RuntimePins,
    pub execution_runtime: ExecutionRuntime,
    pub execution_source_receipt_sha256: String,
    pub execution_build_receipt_sha256: String,
    pub execution_binary_sha256: String,
    pub approved_source_delta_receipt_sha256: String,
    pub profiles: [String; 2],
    pub output_tokens: i32,
    pub context_tokens: u32,
    pub model_id: String,
    pub arm_ids: [String; 2],
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ExecutionRuntime {
    pub runtime: RuntimePins,
    pub telemetry_source_sha256: String,
    pub sampler_source_sha256: String,
}

pub(super) fn execution_runtime() -> ExecutionRuntime {
    ExecutionRuntime {
        runtime: crate::contract::runtime(),
        telemetry_source_sha256: hash(include_bytes!(
            "../../src/local_llm/generation_telemetry.rs"
        )),
        sampler_source_sha256: hash(include_bytes!("../../src/local_llm/grounded_sampling.rs")),
    }
}

pub(super) fn parse_registration(
    bytes: &[u8],
    expected_sha: &str,
    packet_sha: &str,
    id: &str,
) -> Result<Registration, String> {
    model(id)?;
    if bytes.is_empty()
        || bytes.len() > MAX_REGISTRATION_BYTES
        || !is_digest(expected_sha)
        || !is_digest(packet_sha)
        || hash(bytes) != expected_sha
    {
        return Err("presence execution registration differs from registered bytes or size".into());
    }
    let registration: Registration = serde_json::from_slice(bytes)
        .map_err(|error| format!("presence execution registration: {error}"))?;
    let profiles = match registration.treatment.as_str() {
        "presence-only" => PROFILES,
        "gemma-family-profile" if id == GEMMA_CANDIDATE.id => FAMILY_PROFILES,
        _ => return Err("unregistered sampler treatment or model".into()),
    };
    if registration.version != 1
        || registration.original_packet_sha256 != packet_sha
        || registration.model_id != id
        || registration.output_tokens != OUTPUT_TOKENS
        || registration.context_tokens != CONTEXT_TOKENS
        || registration.profiles[0] != profiles[0]
        || registration.profiles[1] != profiles[1]
        || registration.arm_ids[0] == registration.arm_ids[1]
        || registration
            .arm_ids
            .iter()
            .any(|arm| arm.trim().is_empty() || arm.len() > 128)
    {
        return Err(
            "presence execution registration parameters or packet binding are invalid".into(),
        );
    }
    if [
        &registration.original_packet_sha256,
        &registration.original_input_provenance_receipt_sha256,
        &registration.execution_source_receipt_sha256,
        &registration.execution_build_receipt_sha256,
        &registration.execution_binary_sha256,
        &registration.approved_source_delta_receipt_sha256,
        &registration.original_runtime.cargo_lock_sha256,
        &registration.original_runtime.decoder_source_sha256,
        &registration.original_runtime.gemma_template_source_sha256,
        &registration.original_runtime.grammar_sha256,
    ]
    .iter()
    .any(|digest| !is_digest(digest))
    {
        return Err(
            "presence execution registration receipt or historical runtime digest is invalid"
                .into(),
        );
    }
    if registration.execution_runtime != execution_runtime() {
        return Err("presence execution runtime differs from compiled sources".into());
    }
    let original = &registration.original_runtime;
    let execution = &registration.execution_runtime.runtime;
    if original.cargo_lock_sha256 != execution.cargo_lock_sha256
        || original.gemma_template_source_sha256 != execution.gemma_template_source_sha256
        || original.grammar_sha256 != execution.grammar_sha256
    {
        return Err(
            "presence original lock, template or grammar differs from execution runtime".into(),
        );
    }
    // Receipt pins identify an external registration, not native authorization.
    // Only the decoder source may differ from the retained historical runtime.
    Ok(registration)
}

pub(super) fn read(
    registration_path: &Path,
    registration_sha: &str,
    packet_path: &Path,
    packet_sha: &str,
    id: &str,
) -> Result<(Registration, Packet), String> {
    let registration_bytes = read_bytes(registration_path, registration_sha)?;
    let registration = parse_registration(&registration_bytes, registration_sha, packet_sha, id)?;
    let packet_bytes = read_bytes(packet_path, packet_sha)?;
    let packet = parse_original(
        &packet_bytes,
        packet_sha,
        id,
        &registration.original_runtime,
    )?;
    Ok((registration, packet))
}

#[cfg(test)]
#[path = "presence_tests.rs"]
mod tests;
