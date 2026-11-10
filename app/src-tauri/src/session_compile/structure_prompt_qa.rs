//! Frozen structure-only prompt comparison; no product or semantic authority.

use super::{compiler, materializer, schema, sources, structure, SourceBinding};
use crate::importers::wikify::source_revision;
use crate::local_llm::{GenerationSchema, WikiClaimsSamplerQaProfile};
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::CompilationOriginal;
use serde_json::{json, Value};

const RECEIPT: &str =
    include_str!("../../../docs/research/2026-11-10-native-compiler-baseline.json");
const RECEIPT_SHA256: &str = "43e5ce1c04c3e003c5c8483bb2cd2764bfaddb1630e79b70fd4559b66faeb9b7";
const MODEL_ID: &str = "qwen3.5-4b-q4_k_m";
const PACKET_INDEX: usize = 2;
const EMPTY_GUIDANCE: &str = "No claims means empty title, titleClaimIds and entities.";
const NONEMPTY_GUIDANCE: &str = "This stage is called only when the supplied claims array is nonempty. Return a nonempty short title and at least one supplied native claim ID in titleClaimIds. Requested and planned activity can be titled without asserting completion. entities may be empty.";

struct PreparedStructure {
    claims: Vec<schema::NativeClaim>,
    user: String,
    baseline_system: String,
    candidate_system: String,
    prompt_tokens: [usize; 2],
    original_sha256: String,
    plan_revision: String,
    production_structure_system_matches: bool,
    production_extraction_system_matches: bool,
}

fn require(condition: bool, message: &str) -> Result<(), String> {
    condition.then_some(()).ok_or_else(|| message.into())
}

fn text_field<'a>(record: &'a Value, field: &str) -> Result<&'a str, String> {
    record[field]
        .as_str()
        .ok_or_else(|| format!("structure QA receipt lacks string {field}"))
}

fn record<'a>(receipt: &'a Value, phase: &str, call: Option<u64>) -> Result<&'a Value, String> {
    let records = receipt["records"]
        .as_array()
        .ok_or("structure QA receipt lacks records")?;
    let mut matching = records
        .iter()
        .filter(|record| record["phase"] == phase && record["call"].as_u64() == call);
    let found = matching.next().ok_or("structure QA record is missing")?;
    require(
        matching.next().is_none(),
        "structure QA record is duplicated",
    )?;
    Ok(found)
}

fn frozen_receipt(bytes: &str) -> Result<Value, String> {
    require(
        source_revision(bytes) == RECEIPT_SHA256,
        "structure QA receipt bytes changed",
    )?;
    serde_json::from_str(bytes).map_err(|error| format!("structure QA receipt JSON: {error}"))
}

fn sampler_parameters() -> Result<Value, String> {
    let parameters = WikiClaimsSamplerQaProfile::ExistingGroundedV1.qa_parameters();
    let value = serde_json::to_value(parameters).map_err(|error| error.to_string())?;
    require(
        value
            == json!({"profile":"existingGroundedV1",
            "order":["grammar","penalties","top_k","top_p","temperature","dist"],
            "penaltyLastN":256,"repeatPenalty":1.0_f32,"frequencyPenalty":0.0_f32,
            "presencePenalty":1.5_f32,"topK":20,"topP":0.8_f32,"minKeep":1,
            "temperature":0.7_f32,"seed":42}),
        "structure QA sampler parameters changed",
    )?;
    Ok(value)
}

fn check_input(input: &Value, system: &str, user: &str, schema: &str) -> Result<(), String> {
    let manifest = crate::local_model::manifest_for(Some(MODEL_ID))?;
    require(
        input["packetIndex"] == PACKET_INDEX
            && input["schema"] == schema
            && input["outputTokens"] == sources::OUTPUT_TOKENS
            && input["contextTokens"] == sources::CONTEXT_TOKENS
            && input["model"]
                == serde_json::to_value(manifest).map_err(|error| error.to_string())?
            && text_field(input, "system")? == system
            && text_field(input, "user")? == user
            && input["systemSha256"] == source_revision(system)
            && input["userSha256"] == source_revision(user),
        "structure QA exact recorded model, budget or messages changed",
    )
}

fn prepare(
    receipt: &Value,
    mut token_count: impl FnMut(&str, &str) -> Result<usize, String>,
) -> Result<PreparedStructure, String> {
    require(
        receipt["version"] == 1
            && receipt["result"]["nativeCompleted"] == false
            && receipt["result"]["originalPreserved"] == true,
        "structure QA baseline identity changed",
    )?;
    sampler_parameters()?;
    let original_record = record(receipt, "native_compiler_original", None)?;
    let extraction_input = record(receipt, "native_compiler_generation_input", Some(5))?;
    let extraction_result = record(receipt, "native_compiler_generation_result", Some(5))?;
    let structure_input = record(receipt, "native_compiler_generation_input", Some(6))?;
    let structure_result = record(receipt, "native_compiler_generation_result", Some(6))?;
    let original = text_field(original_record, "original")?;
    let source: SourceBinding =
        serde_json::from_value(original_record["context"]["source"].clone())
            .map_err(|error| format!("structure QA source binding: {error}"))?;
    let origin = AgentVaultSession {
        vault_path: "/synthetic/structure-prompt-qa".into(),
        opening_token: "synthetic-structure-prompt-qa-opening".into(),
    };
    // Recorded runtime grants are never restored. Rebuild the source and claims
    // under a synthetic QA origin using the same native checks as compilation.
    let plan = sources::prepare(&source, original, &origin, "en", &mut token_count)?;
    require(
        serde_json::to_value(&plan).map_err(|error| error.to_string())? == original_record["plan"],
        "structure QA native packet plan differs from baseline",
    )?;
    let verified = CompilationOriginal::verify(original, &source.source_revision)?;
    let packet = plan.packet(PACKET_INDEX, &verified, &origin)?;
    let extraction_system = text_field(extraction_input, "system")?;
    check_input(
        extraction_input,
        extraction_system,
        &sources::extraction_payload(&plan, &packet, "en")?,
        "WikiClaimsV1",
    )?;
    require(
        extraction_input["grammarSha256"] == GenerationSchema::WikiClaimsV1.qa_grammar_sha256(),
        "structure QA extraction grammar changed",
    )?;
    let extraction = text_field(&extraction_result["result"], "Ok")?;
    let claims = compiler::bind_claims(&packet, extraction, &origin, PACKET_INDEX)?;
    require(
        claims.len() == 1,
        "structure QA baseline must bind its one recorded claim",
    )?;
    let user = schema::payload("en", &claims)?;
    let baseline_system = text_field(structure_input, "system")?.to_owned();
    check_input(
        structure_input,
        &baseline_system,
        &user,
        "SessionStructureV1",
    )?;
    require(
        structure_input["grammarSha256"]
            == GenerationSchema::SessionStructureV1.qa_grammar_sha256()
            && structure_result["telemetry"]["profile"] == "existingGroundedV1"
            && structure_result["telemetry"]["loopStop"] == "eog",
        "structure QA recorded grammar or decoder profile changed",
    )?;
    let observed = text_field(&structure_result["result"], "Ok")?;
    require(
        structure::validate(observed, &claims).is_err(),
        "structure QA observed empty output must still be rejected",
    )?;
    require(
        baseline_system.matches(EMPTY_GUIDANCE).count() == 1,
        "structure QA baseline empty guidance changed",
    )?;
    let candidate_system = baseline_system.replace(EMPTY_GUIDANCE, NONEMPTY_GUIDANCE);
    let prompt_tokens = [
        token_count(&baseline_system, &user)?,
        token_count(&candidate_system, &user)?,
    ];
    require(
        structure_input["promptTokens"] == prompt_tokens[0]
            && prompt_tokens
                .iter()
                .all(|tokens| *tokens <= sources::MAX_INPUT_TOKENS),
        "structure QA tokenizer count changed or input exceeds fixed context",
    )?;
    Ok(PreparedStructure {
        claims,
        user,
        production_structure_system_matches: baseline_system == structure::SYSTEM,
        production_extraction_system_matches: extraction_system
            == crate::local_synthesis::claim_prompt::extraction_reading_system(),
        baseline_system,
        candidate_system,
        prompt_tokens,
        original_sha256: source.source_revision,
        plan_revision: plan.revision,
    })
}

fn judge(output: &str, claims: &[schema::NativeClaim]) -> Value {
    match structure::validate(output, claims) {
        Err(error) => json!({"structureValid":false,"structureError":error,
            "materialized":false,"materializerError":null,"materialization":null}),
        Ok(validated) => match materializer::materialize(validated, claims, "en") {
            Err(error) => json!({"structureValid":true,"structureError":null,
                "materialized":false,"materializerError":error,"materialization":null}),
            Ok(view) => json!({"structureValid":true,"structureError":null,
                "materialized":true,"materializerError":null,"materialization":view}),
        },
    }
}

#[path = "structure_prompt_qa_model_tests.rs"]
mod model_tests;
#[path = "structure_prompt_qa_tests.rs"]
mod tests;
