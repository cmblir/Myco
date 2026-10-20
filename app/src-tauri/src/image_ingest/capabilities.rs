//! Exact image-input routes checked against official model cards on 2026-10-11.
//! Adapter support does not establish account access, pricing or answer quality.

pub(super) fn supports(provider: &str, model: &str) -> bool {
    match provider {
        // https://developers.openai.com/api/docs/models/gpt-5.4-mini
        // https://developers.openai.com/api/docs/models/gpt-5.4-nano
        "openai-api" => matches!(
            model,
            "gpt-5.4-mini" | "gpt-5.4-mini-2026-03-17" | "gpt-5.4-nano" | "gpt-5.4-nano-2026-03-17"
        ),
        // https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash
        // https://ai.google.dev/gemini-api/docs/models/gemini-2.5-pro
        // https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-lite
        "google-api" => matches!(
            model,
            "gemini-2.5-flash" | "gemini-2.5-pro" | "gemini-2.5-flash-lite"
        ),
        // https://platform.claude.com/docs/en/models/overview
        // https://platform.claude.com/docs/en/models/haiku-4-5/overview
        // https://platform.claude.com/docs/en/models/sonnet-4-6/overview
        // https://platform.claude.com/docs/en/models/opus-4-8/overview
        "anthropic-api" => matches!(
            model,
            "claude-haiku-5-5"
                | "claude-sonnet-5-5"
                | "claude-opus-5-5"
                | "claude-fable-5-1"
                | "claude-haiku-4-5"
                | "claude-haiku-4-5-20251001"
                | "claude-sonnet-4-6"
                | "claude-opus-4-8"
        ),
        _ => false,
    }
}
