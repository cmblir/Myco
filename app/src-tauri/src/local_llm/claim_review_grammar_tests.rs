use super::*;
use llama_cpp_2::token::{data::LlamaTokenData, data_array::LlamaTokenDataArray};

#[cfg(feature = "native-index-probe")]
#[path = "claim_review_reason_first_qa_tests.rs"]
mod reason_first_qa_tests;

#[cfg(feature = "native-index-probe")]
#[path = "session_review_decode_qa_tests.rs"]
mod session_review_decode_qa_tests;

fn vocabulary_accepts(model: &LlamaModel, grammar: &str, output: &str) -> bool {
    vocabulary_accepts_terminated_by(model, grammar, output, model.token_eos())
}

fn vocabulary_accepts_terminated_by(
    model: &LlamaModel,
    grammar: &str,
    output: &str,
    end: llama_cpp_2::token::LlamaToken,
) -> bool {
    let mut sampler = LlamaSampler::grammar(model, grammar, "root").unwrap();
    let tokens = model.str_to_token(output, AddBos::Never).unwrap();
    for token in tokens.into_iter().chain([end]) {
        let mut choices =
            LlamaTokenDataArray::new(vec![LlamaTokenData::new(token, 0.0, 0.0)], false);
        sampler.apply(&mut choices);
        if !choices.data[0].logit().is_finite() {
            return false;
        }
        if !model.is_eog_token(token) {
            sampler.accept(token);
        }
    }
    true
}

#[test]
#[ignore = "requires a verified GGUF via MYCO_CHAT_MODEL_PATH; vocabulary masking only, no inference"]
fn claim_review_sampler_cannot_finish_with_a_required_decision_missing() {
    let path = PathBuf::from(
        std::env::var_os("MYCO_CHAT_MODEL_PATH").expect("MYCO_CHAT_MODEL_PATH is required"),
    );
    let mut host = LocalLlm::load_embed_host().unwrap();
    host.ensure_chat_model(&path).unwrap();
    let model = host.chat_model().unwrap();
    let output = r#"{"version":"WikiClaimReviewV1","claims":[{"id":"C0","disposition":"uncertain","reason":"Synthetic vocabulary test."}],"missingSpanIds":[],"sourceCoverage":"uncertain"}"#;
    assert!(
        !vocabulary_accepts(
            model,
            &GenerationSchema::WikiClaimReviewV1(ReviewDecisions::new(2).unwrap()).grammar(),
            output
        ),
        "a two-claim review must not finish after deciding only C0"
    );
    for count in 0..=16 {
        let schema = GenerationSchema::WikiClaimReviewV1(ReviewDecisions::new(count).unwrap());
        let ids: Vec<_> = (0..count).map(|index| format!("C{index}")).collect();
        for disposition in ["supported", "unsupported", "uncertain"] {
            for coverage in ["covered", "missing", "uncertain"] {
                let output =
                    review_output(&ids, disposition, coverage, "합성 검사: \"미확인\" \\ 경로");
                assert!(
                    vocabulary_accepts(model, &schema.grammar(), &output),
                    "count={count}, disposition={disposition}, coverage={coverage}"
                );
            }
        }
        if count > 0 {
            assert!(!vocabulary_accepts(
                model,
                &schema.grammar(),
                &review_output(
                    &ids[..count - 1],
                    "uncertain",
                    "uncertain",
                    "Synthetic incomplete review."
                )
            ));
        }
        let mut extra = ids.clone();
        extra.push(format!("C{count}"));
        assert!(!vocabulary_accepts(
            model,
            &schema.grammar(),
            &review_output(
                &extra,
                "uncertain",
                "uncertain",
                "Synthetic additional decision."
            )
        ));
    }
    let two = GenerationSchema::WikiClaimReviewV1(ReviewDecisions::new(2).unwrap()).grammar();
    for ids in [["C0", "C0"], ["C0", "C2"], ["C1", "C0"], ["C0", "forged"]] {
        let ids: Vec<_> = ids.into_iter().map(str::to_owned).collect();
        assert!(!vocabulary_accepts(
            model,
            &two,
            &review_output(&ids, "supported", "covered", "Synthetic bad ID order.")
        ));
    }
    let sixteen = GenerationSchema::WikiClaimReviewV1(ReviewDecisions::new(16).unwrap()).grammar();
    let mut ids: Vec<_> = (0..16).map(|index| format!("C{index}")).collect();
    ids.remove(10);
    assert!(!vocabulary_accepts(
        model,
        &sixteen,
        &review_output(&ids, "supported", "covered", "Synthetic missing C10.")
    ));
    let ids = vec!["C0".to_owned(), "C1".to_owned()];
    for (disposition, reason) in [
        ("accepted", "Synthetic invalid disposition."),
        ("supported", ""),
    ] {
        assert!(!vocabulary_accepts(
            model,
            &two,
            &review_output(&ids, disposition, "covered", reason)
        ));
    }
    let end_tokens: Vec<_> = (0..model.n_vocab())
        .map(llama_cpp_2::token::LlamaToken::new)
        .filter(|token| model.is_eog_token(*token))
        .collect();
    assert!(!end_tokens.is_empty());
    for count in [0, 1, 2, 16] {
        let grammar =
            GenerationSchema::WikiClaimReviewV1(ReviewDecisions::new(count).unwrap()).grammar();
        let ids: Vec<_> = (0..count).map(|index| format!("C{index}")).collect();
        let complete = review_output(
            &ids,
            "uncertain",
            "uncertain",
            "Synthetic termination check.",
        );
        let open_array = r#"{"version":"WikiClaimReviewV1","claims":["#;
        for end in &end_tokens {
            assert!(vocabulary_accepts_terminated_by(
                model, &grammar, &complete, *end
            ));
            assert!(!vocabulary_accepts_terminated_by(
                model, &grammar, open_array, *end
            ));
            assert!(!vocabulary_accepts_terminated_by(
                model,
                &grammar,
                complete.strip_suffix('}').unwrap(),
                *end
            ));
            if count >= 2 {
                let one = review_output(
                    &ids[..1],
                    "uncertain",
                    "uncertain",
                    "Synthetic first decision.",
                );
                let before_close = one.split("],\"missingSpanIds\"").next().unwrap();
                assert!(!vocabulary_accepts_terminated_by(
                    model,
                    &grammar,
                    before_close,
                    *end
                ));
            }
        }
    }
}

fn review_output(ids: &[String], disposition: &str, coverage: &str, reason: &str) -> String {
    let reason = serde_json::to_string(reason).unwrap();
    let decisions: Vec<_> = ids
        .iter()
        .map(|id| format!(r#"{{"id":"{id}","disposition":"{disposition}","reason":{reason}}}"#))
        .collect();
    let missing = if coverage == "missing" { r#""Q0""# } else { "" };
    format!(
        r#"{{"version":"WikiClaimReviewV1","claims":[{}],"missingSpanIds":[{missing}],"sourceCoverage":"{coverage}"}}"#,
        decisions.join(",")
    )
}
