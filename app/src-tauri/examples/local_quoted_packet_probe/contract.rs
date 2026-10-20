//! QA-only closed quote-first replay admission; never native authorization.

use crate::original_contract::{
    hash, is_digest, model, parse_original, read_bytes, Packet, RuntimePins,
};
use myco_lib::retrieval::Scope;
use myco_lib::wiki_claims::quoted_qa::{
    bind_qa_original, occurrence_time_qa_system, AgentVaultSession, QUOTED_CLAIMS_QA_JSON_GRAMMAR,
    QUOTED_CLAIMS_QA_SYSTEM,
};
use myco_lib::wiki_claims::{ActorRole, SourceDocument, SourceSet, SpanInput};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

pub(super) const ARMS: [&str; 2] = ["baseline", "quoted"];
const INTERPRETATION_ARMS: [&str; 2] = ["quoted_control", "quoted_interpretation"];
pub(super) const OUTPUT_TOKENS: i32 = 1536;
pub(super) const CONTEXT_TOKENS: u32 = 4096;
const MAX_REGISTRATION_BYTES: usize = 256 * 1024;
const CORPUS: [(&str, &str); 4] = [
    ("sessions/2026-10/synthetic-native-synthetic-dev-plan-negation.md", include_str!("../../eval/local-wiki-native-activity-development-v1/corpus/sessions/2026-10/synthetic-native-synthetic-dev-plan-negation.fixture")),
    ("sessions/2026-10/synthetic-native-synthetic-dev-decision-cause.md", include_str!("../../eval/local-wiki-native-activity-development-v1/corpus/sessions/2026-10/synthetic-native-synthetic-dev-decision-cause.fixture")),
    ("sessions/2026-10/synthetic-native-synthetic-dev-actor-event-date.md", include_str!("../../eval/local-wiki-native-activity-development-v1/corpus/sessions/2026-10/synthetic-native-synthetic-dev-actor-event-date.fixture")),
    ("sessions/2026-10/synthetic-native-synthetic-dev-cancel-reopen.md", include_str!("../../eval/local-wiki-native-activity-development-v1/corpus/sessions/2026-10/synthetic-native-synthetic-dev-cancel-reopen.fixture")),
];

pub(super) struct Options {
    pub model_dir: PathBuf,
    pub model_id: String,
    pub packet_path: PathBuf,
    pub packet_sha256: String,
    pub registration_path: PathBuf,
    pub registration_sha256: String,
}

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
    pub arms: [String; 2],
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
    pub quote_module_sha256: String,
    pub quote_grammar_sha256: String,
    pub candidate_system_sha256: String,
}

pub(super) struct ParsedPackage {
    pub packet: Packet,
    pub sources: SourceSet,
    pub origin: AgentVaultSession,
    pub scope: Scope,
}

pub(super) fn execution_runtime() -> ExecutionRuntime {
    ExecutionRuntime {
        runtime: crate::original_contract::runtime(),
        telemetry_source_sha256: crate::original_contract::hash(include_bytes!(
            "../../src/local_llm/generation_telemetry.rs"
        )),
        sampler_source_sha256: crate::original_contract::hash(include_bytes!(
            "../../src/local_llm/grounded_sampling.rs"
        )),
        quote_module_sha256: hash(include_bytes!("../../src/wiki_claims/quoted_qa.rs")),
        quote_grammar_sha256: hash(QUOTED_CLAIMS_QA_JSON_GRAMMAR.as_bytes()),
        candidate_system_sha256: hash(QUOTED_CLAIMS_QA_SYSTEM.as_bytes()),
    }
}

fn arms_for(treatment: &str) -> Result<[&str; 2], String> {
    match treatment {
        "quote-first-contract" => Ok(ARMS),
        "quoted-occurrence-time-system" => Ok(INTERPRETATION_ARMS),
        _ => Err("unregistered quoted replay treatment".into()),
    }
}

pub(super) fn execution_runtime_for(treatment: &str) -> Result<ExecutionRuntime, String> {
    arms_for(treatment)?;
    let mut runtime = execution_runtime();
    if treatment == "quoted-occurrence-time-system" {
        runtime.candidate_system_sha256 = hash(occurrence_time_qa_system().as_bytes());
    }
    Ok(runtime)
}

pub(super) fn options(arguments: impl IntoIterator<Item = String>) -> Result<Options, String> {
    let mut arguments = arguments.into_iter();
    let mut values = BTreeMap::new();
    while let Some(flag) = arguments.next() {
        if !matches!(
            flag.as_str(),
            "--model-dir"
                | "--model-id"
                | "--packet"
                | "--packet-sha256"
                | "--registration"
                | "--registration-sha256"
        ) {
            return Err(format!("unsupported quoted replay argument: {flag}"));
        }
        let value = arguments
            .next()
            .ok_or_else(|| format!("missing value for {flag}"))?;
        if value.trim().is_empty()
            || value.starts_with("--")
            || values.insert(flag.clone(), value).is_some()
        {
            return Err(format!("empty or duplicate quoted replay argument: {flag}"));
        }
    }
    let mut required = |key: &str| values.remove(key).ok_or_else(|| format!("missing {key}"));
    let model_id = required("--model-id")?;
    model(&model_id)?;
    let packet_sha256 = required("--packet-sha256")?;
    let registration_sha256 = required("--registration-sha256")?;
    if !is_digest(&packet_sha256) || !is_digest(&registration_sha256) {
        return Err("quoted replay requires lowercase packet and registration SHA256".into());
    }
    Ok(Options {
        model_dir: required("--model-dir")?.into(),
        model_id,
        packet_path: required("--packet")?.into(),
        packet_sha256,
        registration_path: required("--registration")?.into(),
        registration_sha256,
    })
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
        return Err("quoted execution registration differs from registered bytes or size".into());
    }
    let registration: Registration = serde_json::from_slice(bytes)
        .map_err(|error| format!("quoted execution registration: {error}"))?;
    let registered_arms = arms_for(&registration.treatment)?;
    if registration.version != 1
        || registration.original_packet_sha256 != packet_sha
        || registration.model_id != id
        || registration.output_tokens != OUTPUT_TOKENS
        || registration.context_tokens != CONTEXT_TOKENS
        || registration.arms != registered_arms.map(String::from)
        || registration.arm_ids[0] == registration.arm_ids[1]
        || registration
            .arm_ids
            .iter()
            .any(|arm| arm.trim().is_empty() || arm.len() > 128)
    {
        return Err(
            "quoted execution registration parameters or packet binding are invalid".into(),
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
        return Err("quoted receipt or historical runtime digest is invalid".into());
    }
    if registration.execution_runtime != execution_runtime_for(&registration.treatment)? {
        return Err("quoted execution runtime differs from compiled sources".into());
    }
    let original = &registration.original_runtime;
    let execution = &registration.execution_runtime.runtime;
    if original.cargo_lock_sha256 != execution.cargo_lock_sha256
        || original.gemma_template_source_sha256 != execution.gemma_template_source_sha256
        || original.grammar_sha256 != execution.grammar_sha256
    {
        return Err(
            "quoted original lock, template or baseline grammar differs from execution".into(),
        );
    }
    // An outer audit binds receipt contents; these pins grant no native authority.
    Ok(registration)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OriginalUser {
    question: String,
    language: String,
    activity_period: ActivityPeriod,
    allowed_span_ids: Vec<String>,
    original_spans: Vec<OriginalSpan>,
    independent_verification_receipts: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActivityPeriod {
    start: String,
    end: String,
    #[serde(deserialize_with = "required_nullable")]
    start_epoch: Option<i64>,
    #[serde(deserialize_with = "required_nullable")]
    end_epoch: Option<i64>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OriginalSpan {
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
    #[serde(deserialize_with = "required_nullable")]
    record_time: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    turn_time: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    source_phase: Option<String>,
}

fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

fn valid_day(day: &str) -> bool {
    let bytes = day.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes
            .iter()
            .enumerate()
            .any(|(index, byte)| index != 4 && index != 7 && !byte.is_ascii_digit())
    {
        return false;
    }
    let year: u32 = day[..4].parse().unwrap_or(0);
    let month: u32 = day[5..7].parse().unwrap_or(0);
    let date: u32 = day[8..].parse().unwrap_or(0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => 0,
    };
    year != 0 && date != 0 && date <= days
}

pub(super) fn parse_package(
    bytes: &[u8],
    packet_sha: &str,
    id: &str,
    original_runtime: &RuntimePins,
) -> Result<ParsedPackage, String> {
    let packet = parse_original(bytes, packet_sha, id, original_runtime)?;
    let user: OriginalUser = serde_json::from_str(&packet.user)
        .map_err(|error| format!("quoted original USER: {error}"))?;
    let range = &user.activity_period;
    if user.question.trim().is_empty()
        || user.question.chars().count() > 2000
        || !matches!(user.language.as_str(), "ko" | "en" | "ja")
        || !valid_day(&range.start)
        || !valid_day(&range.end)
        || range.start > range.end
        || !matches!(
            (range.start_epoch, range.end_epoch),
            (None, None) | (Some(_), Some(_))
        )
        || matches!((range.start_epoch,range.end_epoch),(Some(start),Some(end)) if start >= end)
        || user.original_spans.is_empty()
        || user.original_spans.len() > 512
        || user.allowed_span_ids.len() != user.original_spans.len()
        || !user.independent_verification_receipts.is_empty()
    {
        return Err("quoted USER request, period or original selection is invalid".into());
    }
    let origin = AgentVaultSession {
        vault_path: "/synthetic/quoted-packet-qa".into(),
        opening_token: "quoted-packet-qa-opening".into(),
    };
    let originals = CORPUS
        .iter()
        .map(|&(page, source)| {
            let document = bind_qa_original(page, source)?;
            // Native generation reissues IDs even for an unsplit original turn.
            let windows = SourceSet::new(
                origin.clone(),
                Scope::Sessions,
                vec![document.clone()],
                vec![],
            )?
            .windowed(|span| Ok(vec![span.text().into()]))?;
            let windowed = serde_json::to_value(windows).map_err(|error| error.to_string())?;
            let windowed = windowed["sources"]
                .as_array()
                .and_then(|sources| sources.first())
                .cloned()
                .ok_or("compiled whole original window unavailable")?;
            Ok((
                page,
                [
                    serde_json::to_value(document).map_err(|error| error.to_string())?,
                    windowed,
                ],
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let mut seen = HashSet::new();
    let mut seen_originals = HashSet::new();
    let mut parents = Vec::new();
    for (allowed, supplied) in user.allowed_span_ids.iter().zip(&user.original_spans) {
        if allowed != &supplied.id || !seen.insert(supplied.id.as_str()) {
            return Err("quoted allowed IDs differ from unique original span order".into());
        }
        if !seen_originals.insert((supplied.source_path.as_str(), supplied.start, supplied.end)) {
            return Err("quoted original selection contains duplicate native aliases".into());
        }
        let (page, native) = originals
            .iter()
            .find(|(page, _)| *page == supplied.source_path)
            .ok_or("quoted source is not a compiled synthetic original")?;
        if !parents.contains(page) {
            parents.push(*page);
        }
        let original = native
            .iter()
            .filter_map(|document| document["spans"].as_array())
            .flatten()
            .find(|span| span["id"] == supplied.id)
            .ok_or("quoted span was not issued from the compiled original")?;
        if serde_json::to_value(supplied).map_err(|error| error.to_string())? != *original {
            return Err("quoted original span bytes, coordinates or metadata changed".into());
        }
    }
    let mut documents = Vec::new();
    for page in parents {
        let source = CORPUS
            .iter()
            .find(|(path, _)| *path == page)
            .ok_or("compiled quoted parent unavailable")?
            .1;
        let selected: Vec<_> = user
            .original_spans
            .iter()
            .filter(|span| span.source_path == page)
            .collect();
        let first = selected
            .first()
            .ok_or("quoted original parent has no selected span")?;
        let document = SourceDocument::bind(
            first.source_id.clone(),
            page.into(),
            page.into(),
            source,
            first.record_time.clone(),
            selected
                .iter()
                .map(|span| SpanInput {
                    id: span.id.clone(),
                    start: span.start,
                    end: span.end,
                    turn_id: span.turn_id.clone(),
                    speaker: span.speaker,
                    turn_time: span.turn_time.clone(),
                })
                .collect(),
        )?;
        // Rebinding must preserve all metadata and exclude unprovided siblings.
        let rebound = serde_json::to_value(&document).map_err(|error| error.to_string())?;
        let expected = selected
            .iter()
            .map(serde_json::to_value)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        if rebound["spans"] != Value::Array(expected) {
            return Err("quoted selected original rebinding changed metadata".into());
        }
        documents.push(document);
    }
    let scope = Scope::Sessions;
    let sources = SourceSet::new(origin.clone(), scope, documents, vec![])?;
    Ok(ParsedPackage {
        packet,
        sources,
        origin,
        scope,
    })
}

pub(super) fn read(
    registration_path: &Path,
    registration_sha: &str,
    packet_path: &Path,
    packet_sha: &str,
    id: &str,
) -> Result<(Registration, ParsedPackage), String> {
    let registration = parse_registration(
        &read_bytes(registration_path, registration_sha)?,
        registration_sha,
        packet_sha,
        id,
    )?;
    let package = parse_package(
        &read_bytes(packet_path, packet_sha)?,
        packet_sha,
        id,
        &registration.original_runtime,
    )?;
    Ok((registration, package))
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
