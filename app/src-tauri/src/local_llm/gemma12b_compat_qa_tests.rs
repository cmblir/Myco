//! Separate cached-vocabulary and Metal-load gates; neither performs inference.

use super::*;
use crate::local_model::GEMMA12B_CANDIDATE;
use llama_cpp_2::token::{data::LlamaTokenData, data_array::LlamaTokenDataArray, LlamaToken};

fn verified_explicit_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute()
        || path.file_name() != Some(std::ffi::OsStr::new(GEMMA12B_CANDIDATE.file))
    {
        return Err("Gemma 12B QA requires the explicit pinned artifact path".into());
    }
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() != GEMMA12B_CANDIDATE.bytes {
        return Err("Gemma 12B QA requires the regular, exact-size artifact".into());
    }
    let canonical = path.canonicalize().map_err(|error| error.to_string())?;
    if canonical != path {
        return Err("Gemma 12B QA requires its canonical artifact path".into());
    }
    // Deliberately rehash before each distinct load gate, without a cache hit.
    if embed_model_fingerprint(path)? != GEMMA12B_CANDIDATE.sha256 {
        return Err("Gemma 12B QA artifact SHA-256 mismatch".into());
    }
    Ok(canonical)
}

fn pinned_path_from_environment() -> PathBuf {
    let path = std::env::var_os("MYCO_CHAT_MODEL_PATH")
        .expect("set MYCO_CHAT_MODEL_PATH explicitly; no model path fallback is allowed");
    verified_explicit_path(Path::new(&path))
        .expect("verify the exact Gemma 12B artifact before load")
}

fn assert_loaded_format(model: &LlamaModel) {
    assert_eq!(
        model.meta_val_str("general.architecture").unwrap(),
        "gemma4"
    );
    assert_eq!(model.n_vocab(), 262_144);
    // vocab_only skips architecture hparams; inspect their metadata, not getters.
    assert_eq!(model.meta_val_str("gemma4.block_count").unwrap(), "48");
    assert_eq!(
        model.meta_val_str("gemma4.embedding_length").unwrap(),
        "3840"
    );
    let template = model.chat_template(None).unwrap();
    let text = template.to_str().unwrap();
    assert_eq!(text.len(), 18_683);
    assert_eq!(
        format!("{:x}", Sha256::digest(text.as_bytes())),
        gemma4::DENSE_12B_TEMPLATE_SHA256
    );
    let reference: serde_json::Value =
        serde_json::from_str(include_str!("../../eval/gemma4-12b-text-format-v1.json")).unwrap();
    for case in reference["cases"].as_array().unwrap() {
        let prompt = render_chat(
            model,
            &template,
            case["system"].as_str().unwrap(),
            case["user"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(prompt, case["expected"].as_str().unwrap());
        gemma4::validate_tokens(model, &prompt).unwrap();
        let edge_tail = prompt
            .strip_suffix(gemma4::DENSE_12B_THOUGHT_SUFFIX)
            .unwrap();
        assert!(gemma4::validate_tokens(model, edge_tail).is_err());
        assert!(gemma4::validate_tokens(model, &format!("<bos>{prompt}")).is_err());
    }
    assert!(gemma4::render_thinking_qa(text, "policy", "notes").is_err());
    assert!(gemma4::render(&format!("{text}\n"), "policy", "notes").is_err());
    for marker in ["<bos>", "<turn|>", "<|channel>thought", "<channel|>"] {
        assert!(render_chat(model, &template, "policy", marker).is_err());
    }
}

fn assert_mask(model: &LlamaModel, ends: &[LlamaToken], text: &str, expected: bool) {
    let mut sampler = LlamaSampler::grammar(model, ASK_JSON_GRAMMAR, "root").unwrap();
    for token in model.str_to_token(text, AddBos::Never).unwrap() {
        let mut choices =
            LlamaTokenDataArray::new(vec![LlamaTokenData::new(token, 0.0, 0.0)], false);
        sampler.apply(&mut choices);
        if !choices.data[0].logit().is_finite() {
            assert!(!expected, "unexpected grammar rejection: {text}");
            return;
        }
        sampler.accept(token);
    }
    for end in ends {
        let mut choices =
            LlamaTokenDataArray::new(vec![LlamaTokenData::new(*end, 0.0, 0.0)], false);
        sampler.apply(&mut choices);
        assert_eq!(
            choices.data[0].logit().is_finite(),
            expected,
            "EOG admission: {text}"
        );
    }
}

#[test]
fn gemma12b_smoke_paths_fail_closed_before_model_access() {
    assert!(verified_explicit_path(Path::new(GEMMA12B_CANDIDATE.file)).is_err());
    let directory = tempfile::tempdir().unwrap();
    assert!(verified_explicit_path(&directory.path().join("other.gguf")).is_err());
    let path = directory.path().join(GEMMA12B_CANDIDATE.file);
    assert!(verified_explicit_path(&path).is_err());
    std::fs::write(&path, b"synthetic wrong-size artifact").unwrap();
    assert!(verified_explicit_path(&path).is_err());
    assert_eq!(
        std::fs::read(path).unwrap(),
        b"synthetic wrong-size artifact"
    );
}

#[test]
#[ignore = "requires explicit pinned MYCO_CHAT_MODEL_PATH; vocabulary only, no weights/context/forward"]
fn gemma12b_cached_vocabulary_only_checks_template_tokens_and_grammar() {
    let path = pinned_path_from_environment();
    let params = LlamaModelParams::default()
        .with_vocab_only(true)
        .with_n_gpu_layers(0);
    assert!(params.vocab_only());
    assert_eq!(params.n_gpu_layers(), 0);
    let model = LlamaModel::load_from_file(shared_backend().unwrap(), &path, &params).unwrap();
    assert_loaded_format(&model);
    let ends: Vec<_> = (0..model.n_vocab())
        .map(LlamaToken::new)
        .filter(|token| model.is_eog_token(*token))
        .collect();
    assert!(!ends.is_empty());
    for (text, expected) in [
        (
            r#"{"answer":"한글 synthetic answer","sources":["S1"]}"#,
            true,
        ),
        (r#"{"answer":"synthetic answer","sources":[]}"#, true),
        (r#"{"answer":"synthetic answer","sources":["S13"]}"#, false),
        (r#"{"answer":"synthetic answer","sources":["S1"]"#, false),
    ] {
        assert_mask(&model, &ends, text, expected);
    }
    drop(model);
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[test]
#[ignore = "requires explicit pinned MYCO_CHAT_MODEL_PATH; Metal model load only, no context/prefill/forward"]
fn gemma12b_metal_load_only_releases_the_actual_chat_host() {
    assert!(
        std::env::var_os("MYCO_EVAL_CPU").is_none(),
        "Metal gate must not use the CPU override"
    );
    assert_eq!(generation_model_params().n_gpu_layers(), 99);
    let path = pinned_path_from_environment();
    let mut host = LocalLlm::load_embed_host().unwrap();
    assert!(!host.chat_model_loaded() && host.embed_model.is_none());
    host.ensure_chat_model(&path).unwrap();
    assert!(host.chat_model_loaded());
    assert_eq!(host.chat_model().unwrap().n_layer(), 48);
    assert_eq!(host.chat_model().unwrap().n_embd(), 3840);
    assert_loaded_format(host.chat_model().unwrap());
    let (prompt, add_bos) = host.format_chat("policy", "synthetic notes").unwrap();
    let tokens = host
        .chat_model()
        .unwrap()
        .str_to_token(&prompt, add_bos)
        .unwrap();
    assert_eq!(
        host.chat_token_count("policy", "synthetic notes").unwrap(),
        tokens.len()
    );
    // Release the actual host's owned model, not a separate disposable handle.
    drop(host.chat.take());
    host.template = None;
    host.chat_identity = None;
    assert!(!host.chat_model_loaded());
    assert!(host.chat_model().is_err());
    assert!(host.template.is_none() && host.chat_identity.is_none() && host.embed_model.is_none());
}
