//! QA-only shared ordinary flow; no native IO, role issuance or publication.

use super::{ordinary_synthesis_steps, ActivityFlowFailure, Request};
use crate::local_llm::GenerationSchema;
use crate::local_synthesis::Evidence;
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::SourceSet;
use serde_json::{json, Value};

/// Run the exact production algorithm with explicit synthetic bindings. The
/// host must separately authenticate real openings, roles and original bytes.
pub fn run(
    request: &Request,
    evidence: &[Evidence],
    sources: &SourceSet,
    current_origin: &AgentVaultSession,
    token_count: impl Fn(&str, &str) -> Result<usize, String>,
    generate: impl FnMut(&str, &str, i32, u32, GenerationSchema) -> Result<String, String>,
) -> Result<Value, ActivityFlowFailure> {
    let answer = ordinary_synthesis_steps(
        request,
        evidence,
        sources,
        current_origin,
        token_count,
        generate,
    )?;
    Ok(
        json!({"answer":answer.answer,"usedSources":answer.used_sources,
        "selectedChunks":answer.selected_chunks,"answerReceipt":answer.receipt,
        "native_io_authenticated":false,"product_role_authorized":false,
        "semantic_accepted":false,"production_accepted":false}),
    )
}
