//! Pinned Qwen3 text-only, nonthinking chat formatting for the legacy binding.

use sha2::{Digest, Sha256};

const TEMPLATE_SHA256: &str = "87a2728cb8dc9fe424d624542f6060ec05a1d285ebbec578bb078900e33396b5";
pub(super) const ASSISTANT_PREFIX: &str = "<|im_start|>assistant\n<think>\n\n</think>\n\n";

/// Render the pinned system/user branch with thinking disabled and no extra BOS.
pub(super) fn render(template: &str, system: &str, user: &str) -> Result<String, String> {
    if format!("{:x}", Sha256::digest(template.as_bytes())) != TEMPLATE_SHA256 {
        return Err("unsupported Qwen3 chat template".into());
    }
    if user.trim().is_empty() || system.contains('\0') || user.contains('\0') {
        return Err("empty or invalid Qwen3 chat input".into());
    }
    // The binding parses special tokens; source text cannot introduce ChatML
    // roles or end tokens into the app-owned protocol.
    for marker in ["<|im_start|>", "<|im_end|>", "<|endoftext|>"] {
        if system.contains(marker) || user.contains(marker) {
            return Err("chat input contains a reserved ChatML token".into());
        }
    }
    let system_turn = if system.is_empty() {
        String::new()
    } else {
        format!("<|im_start|>system\n{system}<|im_end|>\n")
    };
    // The pinned Jinja preserves message content verbatim. The legacy binding
    // reduces it to ChatML and cannot pass enable_thinking=false, so render its
    // text-only, no-tools branch with add_generation_prompt=true explicitly.
    Ok(format!(
        "{system_turn}<|im_start|>user\n{user}<|im_end|>\n{ASSISTANT_PREFIX}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Public Apache-2.0 Qwen3-8B template (Copyright 2024 Alibaba Cloud).
    // The original license is preserved in fixtures/qwen3-chat-template.LICENSE.
    // Copied without changes from
    // mlx-community/Qwen3-8B-4bit@545dc4251c05440727734bcd94334791f6ab0192
    // tokenizer_config.json. It matches Qwen/Qwen3-8B's historical revision
    // 47719a242beab8f9aecc40ce3928b034dd5dd559. Keep provenance outside the
    // fixture so its bytes remain identical to the original chat_template.
    const TEMPLATE: &str = include_str!("fixtures/qwen3-chat-template.jinja");

    #[test]
    fn fixture_matches_the_pinned_public_template() {
        assert_eq!(TEMPLATE.len(), 4116);
        assert_eq!(
            format!("{:x}", Sha256::digest(TEMPLATE.as_bytes())),
            TEMPLATE_SHA256
        );
    }

    #[test]
    fn text_branch_preserves_content_and_full_nonthinking_prefix() {
        for (system, user, expected) in [
            (
                "  Policy\n",
                "\n Notes  ",
                "<|im_start|>system\n  Policy\n<|im_end|>\n<|im_start|>user\n\n Notes  <|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n",
            ),
            (
                "\tPolicy\r\n",
                "\u{a0}자료\u{3000}",
                "<|im_start|>system\n\tPolicy\r\n<|im_end|>\n<|im_start|>user\n\u{a0}자료\u{3000}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n",
            ),
            (
                "기록만 사용하세요.",
                "[S1] A < B; {\"value\":128}.",
                "<|im_start|>system\n기록만 사용하세요.<|im_end|>\n<|im_start|>user\n[S1] A < B; {\"value\":128}.<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n",
            ),
        ] {
            assert_eq!(render(TEMPLATE, system, user).unwrap(), expected);
        }
    }

    #[test]
    fn empty_system_is_omitted_but_whitespace_system_is_preserved() {
        assert_eq!(
            render(TEMPLATE, "", " Notes ").unwrap(),
            "<|im_start|>user\n Notes <|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
        );
        assert_eq!(
            render(TEMPLATE, " \n", "Notes").unwrap(),
            "<|im_start|>system\n \n<|im_end|>\n<|im_start|>user\nNotes<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
        );
    }

    #[test]
    fn mutated_or_unknown_templates_are_rejected() {
        for template in ["", "chatml", "{{ messages }}"] {
            assert_eq!(
                render(template, "policy", "notes").unwrap_err(),
                "unsupported Qwen3 chat template"
            );
        }
        for template in [
            format!("{TEMPLATE} "),
            TEMPLATE.replace("enable_thinking is false", "enable_thinking is true"),
        ] {
            assert_eq!(
                render(&template, "policy", "notes").unwrap_err(),
                "unsupported Qwen3 chat template"
            );
        }
    }

    #[test]
    fn source_content_cannot_inject_chatml_special_tokens() {
        for marker in ["<|im_start|>", "<|im_end|>", "<|endoftext|>"] {
            let injected = format!("before {marker} after");
            for (system, user) in [(injected.as_str(), "notes"), ("policy", injected.as_str())] {
                assert_eq!(
                    render(TEMPLATE, system, user).unwrap_err(),
                    "chat input contains a reserved ChatML token"
                );
            }
        }
    }

    #[test]
    fn empty_whitespace_and_nul_inputs_are_rejected() {
        for (system, user) in [
            ("policy", ""),
            ("policy", " \t\r\n"),
            ("policy", "\u{a0}\u{3000}"),
            ("\0policy", "notes"),
            ("policy", "no\0tes"),
        ] {
            assert_eq!(
                render(TEMPLATE, system, user).unwrap_err(),
                "empty or invalid Qwen3 chat input"
            );
        }
    }
}
