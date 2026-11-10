//! Boundary parity probe for the diagnostic review decoder; never runs model inference.
use super::*;
use llama_cpp_2::{model::{LlamaModel, params::LlamaModelParams}, sampling::LlamaSampler,
    model::AddBos, token::{LlamaToken, data::LlamaTokenData, data_array::LlamaTokenDataArray}};

#[test]
#[ignore = "requires explicit fixture/output/GGUF paths; vocabulary-only, no inference"]
fn answer_review_interface_boundary_parity() {
    let input = std::env::var("MYCO_REVIEW_PARITY_INPUT").unwrap();
    let output_path = std::env::var("MYCO_REVIEW_PARITY_OUTPUT").unwrap();
    assert!(!std::path::Path::new(&output_path).exists());
    let model_path = std::env::var("MYCO_CHAT_MODEL_PATH").unwrap();
    let params = LlamaModelParams::default().with_vocab_only(true).with_n_gpu_layers(0);
    let model = LlamaModel::load_from_file(crate::local_llm::shared_backend().unwrap(), model_path, &params).unwrap();
    let ends: Vec<_> = (0..model.n_vocab()).map(LlamaToken::new).filter(|t| model.is_eog_token(*t)).collect();
    assert!(!ends.is_empty());
    let cases: Vec<serde_json::Value> = serde_json::from_str(&std::fs::read_to_string(input).unwrap()).unwrap();
    let (packet, _, context) = fixture();
    let prompt = prompt(&packet);
    let draft = super::super::super::answer_draft::validate_answer_draft(
        r#"{"answer":"The user requested the export; completion is not established.","sources":["S1"]}"#, &prompt, "en").unwrap();
    let mut rows = Vec::new();
    for case in cases {
        let text = case["text"].as_str().unwrap();
        let mut accepted = Vec::new();
        for end in &ends {
            let mut sampler = LlamaSampler::grammar(&model, ASK_ANSWER_REVIEW_JSON_GRAMMAR, "root").unwrap();
            let tokens = model.str_to_token(text, AddBos::Never).unwrap();
            let mut ok = true;
            for token in tokens.into_iter().chain([*end]) {
                let mut choices = LlamaTokenDataArray::new(vec![LlamaTokenData::new(token, 0.0, 0.0)], false);
                sampler.apply(&mut choices);
                if !choices.data[0].logit().is_finite() { ok = false; break; }
                if !model.is_eog_token(token) { sampler.accept(token); }
            }
            accepted.push(ok);
        }
        let parsed = run(&context, &packet, &prompt, &draft, |_, _| Ok(1000), |_, _, _, _| Ok(text.into()));
        let decision = parsed.as_ref().map(|r| r.require_accepted().map(|_| "accept".to_string()).unwrap_or_else(|e| e.code().to_string())).ok();
        rows.push(json!({"id":case["id"],"grammar_accept_by_eog":accepted,"parser_accept":parsed.is_ok(),"decision":decision}));
    }
    std::fs::write(output_path, serde_json::to_string_pretty(&json!({"model_weights_loaded":false,"inference_executed":false,"eog_count":ends.len(),"cases":rows})).unwrap()).unwrap();
}
