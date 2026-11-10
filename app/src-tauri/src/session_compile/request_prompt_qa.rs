//! Frozen request-extraction comparison; native binding is not meaning approval.

use super::{compiler, sources, SourceBinding};
use crate::importers::wikify::source_revision;
use crate::local_llm::{GenerationSchema, WikiClaimsSamplerQaProfile};
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::{ActorRole, CompilationOriginal, SourceSet};
use serde_json::{json, Value};

const RECEIPT: &str = include_str!("../../../docs/research/2026-11-10-native-compiler-v9.json");
const RECEIPT_SHA256: &str = "87ed58240cefa34a2c256765aacefbed25126fbaf917536ecd6c237546591d52";
const MODEL_ID: &str = "qwen3.5-4b-q4_k_m";
const PACKET_INDEX: usize = 1;
const SPAN_ID: &str = "Q-54a71ed85fd0aa800597cf3bee4220b3";
const REQUEST_RULE: &str = "A user request is requested, not completed.";
const REQUEST_GUIDANCE: &str = "A concrete task request in an original span must not be discarded merely because it is imperative or has no completion evidence. Preserve its requested action and object with speechAct=request and status=requested. If the performer is not identified in the original, use actor {role:unknown,basis:unknown,subjectSpanId:null}; do not invent a recipient or later result. Standing rules and metadata alone are not concrete task requests or performed work.";

struct PreparedRequest {
    packet: SourceSet,
    origin: AgentVaultSession,
    user: String,
    baseline_system: String,
    candidate_system: String,
    prompt_tokens: [usize; 2],
    original_sha256: String,
    plan_revision: String,
    production_system_matches: bool,
}

fn require(condition: bool, message: &str) -> Result<(), String> {
    condition.then_some(()).ok_or_else(|| message.into())
}

fn text_field<'a>(record: &'a Value, field: &str) -> Result<&'a str, String> {
    record[field]
        .as_str()
        .ok_or_else(|| format!("request QA receipt lacks string {field}"))
}

fn record<'a>(receipt: &'a Value, phase: &str, call: Option<u64>) -> Result<&'a Value, String> {
    let records = receipt["records"]
        .as_array()
        .ok_or("request QA receipt lacks records")?;
    let mut matching = records
        .iter()
        .filter(|record| record["phase"] == phase && record["call"].as_u64() == call);
    let found = matching.next().ok_or("request QA record is missing")?;
    require(matching.next().is_none(), "request QA record is duplicated")?;
    Ok(found)
}

fn frozen_receipt(bytes: &str) -> Result<Value, String> {
    require(
        source_revision(bytes) == RECEIPT_SHA256,
        "request QA receipt bytes changed",
    )?;
    serde_json::from_str(bytes).map_err(|error| format!("request QA receipt JSON: {error}"))
}

fn sampler_parameters() -> Result<Value, String> {
    let value =
        serde_json::to_value(WikiClaimsSamplerQaProfile::ExistingGroundedV1.qa_parameters())
            .map_err(|error| error.to_string())?;
    require(
        value
            == json!({"profile":"existingGroundedV1",
            "order":["grammar","penalties","top_k","top_p","temperature","dist"],
            "penaltyLastN":256,"repeatPenalty":1.0_f32,"frequencyPenalty":0.0_f32,
            "presencePenalty":1.5_f32,"topK":20,"topP":0.8_f32,"minKeep":1,
            "temperature":0.7_f32,"seed":42}),
        "request QA sampler parameters changed",
    )?;
    Ok(value)
}

fn prepare(
    receipt: &Value,
    mut token_count: impl FnMut(&str, &str) -> Result<usize, String>,
) -> Result<PreparedRequest, String> {
    require(
        receipt["version"] == 1
            && receipt["result"]["nativeCompleted"] == false
            && receipt["result"]["nativeState"] == "partial"
            && receipt["result"]["originalPreserved"] == true
            && sources::OUTPUT_TOKENS == 768
            && sources::CONTEXT_TOKENS == 4096,
        "request QA baseline identity or fixed budget changed",
    )?;
    sampler_parameters()?;
    let original_record = record(receipt, "native_compiler_original", None)?;
    let input = record(receipt, "native_compiler_generation_input", Some(3))?;
    let output = record(receipt, "native_compiler_generation_result", Some(3))?;
    let review = record(receipt, "native_compiler_generation_result", Some(4))?;
    let original = text_field(original_record, "original")?;
    let source: SourceBinding =
        serde_json::from_value(original_record["context"]["source"].clone())
            .map_err(|error| format!("request QA source binding: {error}"))?;
    // Recorded runtime grants are never restored; use fresh synthetic ownership.
    let origin = AgentVaultSession {
        vault_path: "/synthetic/request-prompt-qa".into(),
        opening_token: "synthetic-request-prompt-qa-opening".into(),
    };
    let plan = sources::prepare(&source, original, &origin, "en", &mut token_count)?;
    require(
        serde_json::to_value(&plan).map_err(|error| error.to_string())? == original_record["plan"],
        "request QA native packet plan differs from baseline",
    )?;
    let verified = CompilationOriginal::verify(original, &source.source_revision)?;
    let packet = plan.packet(PACKET_INDEX, &verified, &origin)?;
    let spans = packet.spans().collect::<Vec<_>>();
    require(
        spans.len() == 1
            && spans[0].id() == SPAN_ID
            && spans[0].text() == "Please request the synthetic report.\n\n"
            && spans[0].speaker() == ActorRole::User,
        "request QA original request or speaker changed",
    )?;
    let user = sources::extraction_payload(&plan, &packet, "en")?;
    let baseline_system = text_field(input, "system")?.to_owned();
    let manifest = crate::local_model::manifest_for(Some(MODEL_ID))?;
    require(
        input["packetIndex"] == PACKET_INDEX
            && input["schema"] == "WikiClaimsV1"
            && input["outputTokens"] == 768
            && input["contextTokens"] == 4096
            && input["model"]
                == serde_json::to_value(manifest).map_err(|error| error.to_string())?
            && input["grammarSha256"] == GenerationSchema::WikiClaimsV1.qa_grammar_sha256()
            && text_field(input, "user")? == user
            && input["userSha256"] == source_revision(&user)
            && input["systemSha256"] == source_revision(&baseline_system)
            && output["packetIndex"] == PACKET_INDEX
            && output["telemetry"]["profile"] == "existingGroundedV1"
            && output["telemetry"]["loopStop"] == "eog",
        "request QA exact recorded model, grammar, budget or input changed",
    )?;
    let observed = text_field(&output["result"], "Ok")?;
    require(
        compiler::bind_claims(&packet, observed, &origin, PACKET_INDEX)?.is_empty()
            && review["packetIndex"] == PACKET_INDEX
            && serde_json::from_str::<Value>(text_field(&review["result"], "Ok")?)
                .map_err(|error| error.to_string())?
                == json!({"version":"SessionReviewV1","claims":[],"expressions":[],
                    "missingSpanIds":[],"sourceCoverage":"uncertain"}),
        "request QA observed omission or uncertain review changed",
    )?;
    require(
        baseline_system.matches(REQUEST_RULE).count() == 1,
        "request QA baseline request rule changed",
    )?;
    let candidate_system =
        baseline_system.replace(REQUEST_RULE, &format!("{REQUEST_RULE} {REQUEST_GUIDANCE}"));
    let prompt_tokens = [
        token_count(&baseline_system, &user)?,
        token_count(&candidate_system, &user)?,
    ];
    require(
        input["promptTokens"] == prompt_tokens[0]
            && prompt_tokens
                .iter()
                .all(|count| *count <= sources::MAX_INPUT_TOKENS),
        "request QA tokenizer count changed or input exceeds fixed context",
    )?;
    Ok(PreparedRequest {
        packet,
        origin,
        user,
        production_system_matches: baseline_system
            == crate::local_synthesis::claim_prompt::extraction_reading_system(),
        baseline_system,
        candidate_system,
        prompt_tokens,
        original_sha256: source.source_revision,
        plan_revision: plan.revision,
    })
}

fn expected_proposal() -> Value {
    json!({"action":"Request the synthetic report","anchorSpanId":SPAN_ID,
        "supportSpanIds":[SPAN_ID],"actor":{"role":"unknown","basis":"unknown","subjectSpanId":null},
        "eventTime":{"value":null,"basis":"unknown","precision":"unknown","uncertainty":"unknown","supportSpanId":null},
        "speechAct":"request","status":"requested","verificationId":null})
}

fn normalized_action(action: &str) -> String {
    action
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_end_matches('.')
        .to_ascii_lowercase()
}

fn judge(output: &str, prepared: &PreparedRequest) -> Value {
    match compiler::bind_claims(&prepared.packet, output, &prepared.origin, PACKET_INDEX) {
        Err(error) => json!({"nativeBound":false,"nativeError":error,"claims":null,
            "frozenExpectationMatched":false,"semanticAccepted":false}),
        Ok(claims) => {
            // This narrow lexical/field regression is not a semantic evaluator.
            // Equivalent phrasings may fail; raw output remains available for review.
            let matches = claims.len() == 1 && {
                let claim = &claims[0].claim;
                let mut proposal = serde_json::to_value(&claim.proposal).expect("claim serializes");
                proposal["action"] = json!(normalized_action(&claim.proposal.action));
                let mut expected = expected_proposal();
                expected["action"] = json!(normalized_action(expected["action"].as_str().unwrap()));
                proposal == expected
                    && claim.provenance.len() == 1
                    && claim.provenance[0].speaker() == ActorRole::User
                    && claim.semantic_review_required
            };
            json!({"nativeBound":true,"nativeError":null,"claims":claims,
                "frozenExpectationMatched":matches,"semanticAccepted":false})
        }
    }
}

#[path = "request_controls_model_tests.rs"]
mod controls_model_tests;
#[path = "request_prompt_qa_model_tests.rs"]
mod model_tests;
#[path = "request_prompt_qa_tests.rs"]
mod tests;
