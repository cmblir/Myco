//! Opt-in actual cached-model witness at the native execution boundary.
//! This is not the Wry adapter, installed acceptance or independent meaning gold.

use super::*;
use crate::local_llm::GenerationSchema;
use crate::role_authorization::{self, RoleId, RoleSelectionRequest};
use crate::session_compile::{self, sources};

#[test]
#[ignore = "requires pinned cached model environment and MYCO_QA_GENERATION=1; actual generation"]
fn cached_model_runs_native_source_bound_compilation() {
    assert_eq!(std::env::var("MYCO_QA_GENERATION").as_deref(), Ok("1"));
    let id = std::env::var("MYCO_SESSION_PACKET_MODEL_ID").expect("model ID is required");
    let dir = std::env::var_os("MYCO_SESSION_PACKET_MODEL_DIR")
        .expect("existing model directory is required");
    let manifest = crate::local_model::manifest_for(Some(&id)).unwrap();
    let path = crate::local_model::resolve_verified_artifact(std::path::Path::new(&dir), manifest)
        .unwrap();
    let mut host = crate::local_llm::LocalLlm::load_embed_host().unwrap();
    host.ensure_chat_model(&path).unwrap();
    let flag = AtomicBool::new(false);
    let mut completed = false;
    let mut terminal_error = None;
    with_isolated_data("compiler-cached-native-generation", |_| {
        let (dir, vault, origin, source) = fixture();
        let original = session_compile::checked_source(dir.path(), &source).unwrap();
        let current = role_authorization::capture_role_at(
            &origin,
            RoleId::Compilation,
            RoleUsage::Foreground,
        )
        .unwrap();
        role_authorization::select_role(RoleSelectionRequest {
            role: RoleId::Compilation,
            provider_id: "builtin-local".into(),
            model_id: id.clone(),
            effort: "(default)".into(),
            expected_authorization_revision: current.authorization_revision,
        })
        .unwrap();
        let context =
            session_compile::begin(&vault, &origin, source, RoleUsage::Foreground).unwrap();
        let selected = selected_manifest(&vault, &context).unwrap();
        assert_eq!(selected.id, manifest.id);
        assert_eq!(selected.revision, manifest.revision);
        assert_eq!(selected.sha256, manifest.sha256);
        let plan = sources::prepare(&context.source, &original, &origin, "en", |system, user| {
            host.chat_token_count(system, user)
        })
        .unwrap();
        println!(
            "{}",
            json!({"phase":"native_compiler_original","model":manifest,"original":original,
                "context":context,"plan":plan,"modelInference":false,"generationRequested":true,"semanticAccepted":false,
                "productionAccepted":false,"boundary":"native execution/source-grant/checkpoint/publisher; not Wry/with_model/installed"})
        );
        let mut calls = 0;
        let mut observed_inference = false;
        let mut outcomes = Vec::new();
        // A fresh attempt can visit each fixture packet once. Rejections/errors
        // are retained rather than retried until a more favorable output appears.
        for packet_index in 0..plan.windows.len() {
            let result = step_with_decode(
                &vault,
                &context,
                "en",
                &flag,
                |system, user| host.chat_token_count(system, user),
                |system, user, output, window, schema, decode| {
                    calls += 1;
                    let schema = match schema {
                        CompilerSchema::Claims => GenerationSchema::WikiClaimsV1,
                        CompilerSchema::Compilation => GenerationSchema::SessionStructureV1,
                        CompilerSchema::Review => GenerationSchema::SessionReviewV1,
                    };
                    let grammar_sha256 = match (schema, decode) {
                        (GenerationSchema::SessionReviewV1, Some(contract)) => {
                            contract.grammar_sha256()
                        }
                        (
                            GenerationSchema::WikiClaimsV1 | GenerationSchema::SessionStructureV1,
                            None,
                        ) => schema.qa_grammar_sha256(),
                        _ => {
                            return Err(
                                "compiler decode contract does not match generation stage".into()
                            )
                        }
                    };
                    println!(
                        "{}",
                        json!({"phase":"native_compiler_generation_input","packetIndex":packet_index,
                            "call":calls,"schema":format!("{schema:?}"),"grammarSha256":grammar_sha256,
                            "system":system,"user":user,"systemSha256":source_revision(system),
                            "userSha256":source_revision(user),"promptTokens":host.chat_token_count(system,user)?,
                            "outputTokens":output,"contextTokens":window,"model":manifest})
                    );
                    let attempt = if let Some(contract) = decode {
                        host.generate_session_review_cancellable_measured(
                            system, user, output, window, contract, &flag,
                        )
                    } else {
                        host.generate_structured_cancellable_measured(
                            system, user, output, window, schema, &flag,
                        )
                    };
                    let telemetry = attempt.telemetry().clone();
                    let inferred = telemetry
                        .prefill_completed_tokens
                        .is_some_and(|count| count > 0)
                        || telemetry.sampled_tokens.is_some_and(|count| count > 0);
                    observed_inference |= inferred;
                    let result = attempt.into_result();
                    // Observe actual raw output before any native JSON or review
                    // rejection, including calls that never reach a checkpoint.
                    println!(
                        "{}",
                        json!({"phase":"native_compiler_generation_result","packetIndex":packet_index,
                            "call":calls,"result":result,"telemetry":telemetry,
                            "modelInference":inferred,"semanticAccepted":false,"productionAccepted":false})
                    );
                    result
                },
            );
            match result {
                Ok(outcome) => {
                    let terminal =
                        matches!(outcome.state, WorkState::Completed | WorkState::Partial);
                    completed = outcome.state == WorkState::Completed;
                    outcomes.push(serde_json::to_value(outcome).unwrap());
                    if terminal {
                        break;
                    }
                }
                Err(error) => {
                    terminal_error = Some(error);
                    break;
                }
            }
        }
        let preserved = session_compile::checked_source(dir.path(), &context.source).unwrap();
        let summary = match std::fs::read_to_string(dir.path().join(&context.summary_path)) {
            Ok(content) => json!({"content":content}),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => json!({"absent":true}),
            Err(error) => panic!("read synthetic published summary: {error}"),
        };
        println!(
            "{}",
            json!({"phase":"native_compiler_terminal","calls":calls,"outcomes":outcomes,
                "error":terminal_error,"nativeCompleted":completed,
                "pending":Pending::try_load(dir.path()).unwrap(),"summary":summary,
                "originalBeforeSha256":source_revision(&original),
                "originalAfterSha256":source_revision(&preserved),"originalPreserved":original==preserved,
                "modelInference":observed_inference,"semanticAccepted":false,"productionAccepted":false})
        );
        grants().lock().unwrap().remove(&context.attempt_id);
        assert_eq!(original, preserved);
    });
    assert!(
        completed,
        "actual native compiler did not complete: {terminal_error:?}"
    );
}
