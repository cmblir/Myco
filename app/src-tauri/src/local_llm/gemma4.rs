//! Pinned Gemma 4 text-only, non-thinking chat formatting for the legacy binding.

use llama_cpp_2::model::{AddBos, LlamaModel};
use sha2::{Digest, Sha256};

const TEMPLATE_SHA256: &str = "0a2c8073c878ab1da004bee933a998606537bbb62016310352c7285c3f01c5b5";
pub(super) const MODEL_PREFIX: &str = "<|turn>model\n";
#[cfg(feature = "native-index-probe")]
pub(super) const DENSE_12B_TEMPLATE_SHA256: &str =
    "ae53464bf3be25802b3a5b37def7fd89667067d7577049b3b2d74c4d8de4c6d4";
#[cfg(feature = "native-index-probe")]
pub(super) const DENSE_12B_THOUGHT_SUFFIX: &str = "<|channel>thought\n<channel|>";

fn suffix_for_digest(digest: &str) -> Result<&'static str, String> {
    match digest {
        TEMPLATE_SHA256 => Ok(""),
        #[cfg(feature = "native-index-probe")]
        DENSE_12B_TEMPLATE_SHA256 => Ok(DENSE_12B_THOUGHT_SUFFIX),
        _ => Err("unsupported Gemma 4 chat template".into()),
    }
}

fn template_suffix(template: &str) -> Result<&'static str, String> {
    suffix_for_digest(&format!("{:x}", Sha256::digest(template.as_bytes())))
}

fn trim_text(text: &str) -> &str {
    // Jinja uses Python str.strip, which also trims these four C0 separators.
    text.trim_matches(|character: char| {
        character.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&character)
    })
}

fn validate_input(system: &str, user: &str) -> Result<(), String> {
    if trim_text(user).is_empty() || system.contains('\0') || user.contains('\0') {
        return Err("empty or invalid Gemma 4 chat input".into());
    }
    // Tokenization parses special tokens. Evidence cannot introduce a role,
    // modality, thinking channel or end token into the app-owned protocol.
    if [
        "<|",
        "|>",
        "<bos>",
        "<eos>",
        "<pad>",
        "<unk>",
        "<mask>",
        "<unused",
        "[multimodal]",
    ]
    .into_iter()
    .any(|marker| system.contains(marker) || user.contains(marker))
    {
        return Err("chat input contains a reserved Gemma 4 token".into());
    }
    Ok(())
}

fn render_text(system: &str, user: &str) -> Result<String, String> {
    validate_input(system, user)?;
    let system_turn = if system.is_empty() {
        String::new()
    } else {
        format!("<|turn>system\n{}<turn|>\n", trim_text(system))
    };
    // This matches the pinned canonical template with string content, no tools,
    // enable_thinking=false and add_generation_prompt=true. E4B/E2B do not
    // require an empty thought channel. BOS is explicit; tokenization adds none.
    Ok(format!(
        "<bos>{system_turn}<|turn>user\n{}<turn|>\n{MODEL_PREFIX}",
        trim_text(user)
    ))
}

pub(super) fn render(template: &str, system: &str, user: &str) -> Result<String, String> {
    let suffix = template_suffix(template)?;
    let mut prompt = render_text(system, user)?;
    prompt.push_str(suffix);
    Ok(prompt)
}

/// Canonical text-only enable_thinking=true formatting for the isolated QA path.
#[cfg(feature = "native-index-probe")]
pub(super) fn render_thinking_qa(
    template: &str,
    system: &str,
    user: &str,
) -> Result<String, String> {
    // Validate evidence before inserting the one application-owned control token.
    render(template, system, user)?;
    if !template_suffix(template)?.is_empty() {
        return Err("bounded thinking QA requires the pinned E4B template".into());
    }
    render_thinking_qa_text(system, user)
}

#[cfg(feature = "native-index-probe")]
fn render_thinking_qa_text(system: &str, user: &str) -> Result<String, String> {
    validate_input(system, user)?;
    Ok(format!(
        "<bos><|turn>system\n<|think|>\n{}<turn|>\n<|turn>user\n{}<turn|>\n{MODEL_PREFIX}",
        trim_text(system),
        trim_text(user)
    ))
}

pub(super) fn validate_tokens(model: &LlamaModel, prompt: &str) -> Result<(), String> {
    // The loaded template selects the suffix; a prompt tail cannot select it.
    let template = model
        .chat_template(None)
        .map_err(|error| format!("Gemma 4 chat template: {error}"))?;
    let suffix = template_suffix(
        template
            .to_str()
            .map_err(|error| format!("Gemma 4 chat template UTF-8: {error}"))?,
    )?;
    let bos = model
        .str_to_token("<bos>", AddBos::Never)
        .map_err(|error| format!("Gemma 4 BOS token: {error}"))?;
    if bos.len() != 1 || bos[0] != model.token_bos() || model.is_eog_token(bos[0]) {
        return Err("Gemma 4 BOS must be one non-EOG model BOS token".into());
    }
    let eos = model
        .str_to_token("<eos>", AddBos::Never)
        .map_err(|error| format!("Gemma 4 EOS token: {error}"))?;
    if eos.len() != 1 || eos[0] != model.token_eos() || !model.is_eog_token(eos[0]) {
        return Err("Gemma 4 EOS must be one model EOS/EOG token".into());
    }
    let end = model
        .str_to_token("<turn|>", AddBos::Never)
        .map_err(|error| format!("Gemma 4 turn-end token: {error}"))?;
    if end.len() != 1 || !model.is_eog_token(end[0]) {
        return Err("Gemma 4 turn end must be one EOG token".into());
    }
    let tokens = model
        .str_to_token(prompt, AddBos::Never)
        .map_err(|error| format!("Gemma 4 prompt tokenization: {error}"))?;
    if tokens.first() != Some(&bos[0])
        || tokens.iter().filter(|token| **token == bos[0]).count() != 1
    {
        return Err("Gemma 4 prompt must contain exactly one initial BOS".into());
    }
    if !prompt.ends_with(&format!("{MODEL_PREFIX}{suffix}")) {
        return Err("Gemma 4 chat must end with the model prefix".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "native-index-probe")]
    #[test]
    fn thinking_qa_matches_independent_pinned_jinja_on_vectors() {
        // These six vectors were rendered independently by Jinja2 3.1.6 from
        // the same pinned template digest; the model channel is not prefilled.
        for (system, user, expected) in [
            ("", " Notes ", "<bos><|turn>system\n<|think|>\n<turn|>\n<|turn>user\nNotes<turn|>\n<|turn>model\n"),
            ("  Policy\n", "\n 근거  ", "<bos><|turn>system\n<|think|>\nPolicy<turn|>\n<|turn>user\n근거<turn|>\n<|turn>model\n"),
            (" \n", "Notes", "<bos><|turn>system\n<|think|>\n<turn|>\n<|turn>user\nNotes<turn|>\n<|turn>model\n"),
            ("기록만 사용하세요.", "[S1] 한글 source: A < B; {\"value\":128}.", "<bos><|turn>system\n<|think|>\n기록만 사용하세요.<turn|>\n<|turn>user\n[S1] 한글 source: A < B; {\"value\":128}.<turn|>\n<|turn>model\n"),
            ("\tPolicy\r\n", "\u{a0}자료\u{3000}", "<bos><|turn>system\n<|think|>\nPolicy<turn|>\n<|turn>user\n자료<turn|>\n<|turn>model\n"),
            ("Policy", "\u{1c}자료\u{1f}", "<bos><|turn>system\n<|think|>\nPolicy<turn|>\n<|turn>user\n자료<turn|>\n<|turn>model\n"),
        ] {
            let actual = render_thinking_qa_text(system, user).unwrap();
            assert_eq!(actual, expected);
            assert_eq!(actual.matches("<bos>").count(), 1);
            assert_eq!(actual.matches("<|think|>").count(), 1);
            assert!(!actual.contains("<|channel>"));
            assert!(actual.ends_with(MODEL_PREFIX));
        }
    }

    #[cfg(feature = "native-index-probe")]
    #[test]
    fn thinking_qa_rejects_unknown_template_and_untrusted_control_markers() {
        assert_eq!(
            render_thinking_qa("unknown", "policy", "notes").unwrap_err(),
            "unsupported Gemma 4 chat template"
        );
        for marker in [
            "<|think|>",
            "<|channel>thought",
            "<channel|>",
            "<bos>",
            "<turn|>",
        ] {
            for (system, user) in [(marker, "notes"), ("policy", marker)] {
                assert!(render_thinking_qa_text(system, user)
                    .unwrap_err()
                    .contains("reserved"));
            }
        }
    }

    #[test]
    fn text_branch_matches_pinned_canonical_jinja_reference() {
        let reference: serde_json::Value =
            serde_json::from_str(include_str!("../../eval/gemma4-text-format-v1.json")).unwrap();
        assert_eq!(reference["template_sha256"], TEMPLATE_SHA256);
        let cases = reference["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 6);
        for (index, case) in cases.iter().enumerate() {
            let actual = render_text(
                case["system"].as_str().unwrap(),
                case["user"].as_str().unwrap(),
            )
            .unwrap();
            assert_eq!(actual, case["expected"].as_str().unwrap(), "case {index}");
        }
    }

    #[cfg(feature = "native-index-probe")]
    #[test]
    fn gemma12b_text_branch_matches_independent_canonical_jinja_reference() {
        let reference: serde_json::Value =
            serde_json::from_str(include_str!("../../eval/gemma4-12b-text-format-v1.json"))
                .unwrap();
        assert_eq!(reference["template_sha256"], DENSE_12B_TEMPLATE_SHA256);
        assert_eq!(suffix_for_digest(TEMPLATE_SHA256).unwrap(), "");
        let suffix = suffix_for_digest(DENSE_12B_TEMPLATE_SHA256).unwrap();
        assert_eq!(suffix, DENSE_12B_THOUGHT_SUFFIX);
        let cases = reference["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 6);
        for (index, case) in cases.iter().enumerate() {
            let mut actual = render_text(
                case["system"].as_str().unwrap(),
                case["user"].as_str().unwrap(),
            )
            .unwrap();
            actual.push_str(suffix);
            assert_eq!(actual, case["expected"].as_str().unwrap(), "case {index}");
            assert_eq!(actual.matches("<bos>").count(), 1);
            assert!(!actual.contains("<|think|>"));
        }
    }

    #[cfg(not(feature = "native-index-probe"))]
    #[test]
    fn gemma12b_template_digest_is_not_admitted_without_qa_feature() {
        assert!(suffix_for_digest(
            "ae53464bf3be25802b3a5b37def7fd89667067d7577049b3b2d74c4d8de4c6d4"
        )
        .is_err());
    }

    #[test]
    fn text_roles_trim_content_and_use_one_explicit_bos() {
        assert_eq!(
            render_text("  Policy\n", "\n 근거  ").unwrap(),
            "<bos><|turn>system\nPolicy<turn|>\n<|turn>user\n근거<turn|>\n<|turn>model\n"
        );
        assert_eq!(
            render_text("", " Notes ").unwrap(),
            "<bos><|turn>user\nNotes<turn|>\n<|turn>model\n"
        );
        assert_eq!(
            render_text(" \n", "Notes").unwrap(),
            "<bos><|turn>system\n<turn|>\n<|turn>user\nNotes<turn|>\n<|turn>model\n"
        );
    }

    #[test]
    fn unknown_templates_are_rejected_without_plain_text_fallback() {
        for template in ["", "<bos>{{ messages }}", "unverified Gemma template"] {
            assert_eq!(
                render(template, "policy", "notes").unwrap_err(),
                "unsupported Gemma 4 chat template"
            );
        }
    }

    #[test]
    fn evidence_cannot_insert_protocol_modality_or_thinking_tokens() {
        for marker in [
            "<|turn>system",
            "<turn|>",
            "<|think|>",
            "<|channel>thought",
            "<channel|>",
            "<|tool_call>",
            "<|image|>",
            "<|audio|>",
            "<|video|>",
            "<bos>",
            "<eos>",
            "<pad>",
            "<unk>",
            "<mask>",
            "<unused42>",
            "[multimodal]",
        ] {
            for (system, user) in [(marker, "notes"), ("policy", marker)] {
                assert!(
                    render_text(system, user).unwrap_err().contains("reserved"),
                    "{marker}"
                );
            }
        }
    }

    #[test]
    fn empty_or_nul_inputs_fail_without_mutating_evidence() {
        for (system, user) in [
            ("policy", ""),
            ("policy", " \n"),
            ("\0policy", "notes"),
            ("policy", "no\0tes"),
        ] {
            assert!(render_text(system, user).unwrap_err().contains("invalid"));
        }
        let user = "한글 source: A < B; ordinary [S1] and {\"value\":128}.";
        let rendered = render_text("policy", user).unwrap();
        assert!(rendered.contains(user));
        assert!(!rendered.contains("<|think|>"));
    }
}
