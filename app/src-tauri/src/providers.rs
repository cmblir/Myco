// Provider adapters — one chat_complete signature, five backends. Each
// adapter converts our common message format into the provider's wire
// format and parses the response back. We deliberately do NOT stream in
// this first cut; the frontend can poll-display the final response.
//
// Provider identifiers (must match the frontend Settings panel):
//   anthropic-cli   → claude CLI shell-out (handled separately)
//   anthropic-api   → /v1/messages
//   openai-api      → /v1/chat/completions
//   google-api      → generativelanguage.googleapis.com
//   ollama          → http://localhost:11434/api/chat
//   openrouter      → openrouter.ai /api/v1/chat/completions

use serde::{Deserialize, Serialize};
use std::time::Duration;

const DEFAULT_TIMEOUT_SECS: u64 = 180;

// Hard cap on any response body we will buffer into memory. A hostile or buggy
// endpoint could otherwise stream an unbounded body and OOM the app. 32 MB is
// far larger than any legitimate chat completion or model-list payload.
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;

// Transient-failure retry policy for the chat completion path. We retry only on
// a reqwest send error or a retryable status (429/5xx); 4xx auth/validation
// errors are returned immediately. Backoff is fixed: 300ms, then 900ms.
const RETRY_BACKOFFS_MS: [u64; 2] = [300, 900];

// Read a response body with an enforced size cap. We stream chunk-by-chunk so a
// hostile endpoint cannot force us to allocate more than `max` bytes before we
// bail out, regardless of (or in the absence of) a Content-Length header.
async fn read_capped(resp: reqwest::Response, max: usize) -> Result<Vec<u8>, String> {
    // Fail fast when the server advertises an over-large body up front.
    if let Some(len) = resp.content_length() {
        if len as usize > max {
            return Err(format!(
                "response body too large: {len} bytes exceeds {max} byte cap"
            ));
        }
    }
    let mut resp = resp;
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        if buf.len() + chunk.len() > max {
            return Err(format!("response body too large: exceeds {max} byte cap"));
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

// True for transient HTTP statuses worth retrying on the chat path. Excludes all
// other 4xx (auth/validation) so we never burn retries on a bad API key.
fn is_retryable_status(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 429 | 500 | 502 | 503 | 504)
}

// Send a pre-built request with a tiny retry-with-backoff for transient
// failures. The `build` closure produces a fresh RequestBuilder for each attempt
// (RequestBuilder is single-use, so we cannot clone the request body across
// retries cheaply without rebuilding). We retry on send errors and on retryable
// statuses; on the final attempt we return whatever we have.
async fn send_with_retry(
    build: impl Fn() -> reqwest::RequestBuilder,
) -> Result<reqwest::Response, reqwest::Error> {
    // One attempt per configured backoff (sleeping after a transient failure),
    // then a final attempt whose result is returned as-is.
    for &backoff_ms in RETRY_BACKOFFS_MS.iter() {
        match build().send().await {
            // A non-retryable status (success or a 4xx) is the answer — return it.
            Ok(resp) if !is_retryable_status(resp.status()) => return Ok(resp),
            // Retryable status or send error → back off and try again.
            Ok(_) | Err(_) => {
                tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
            }
        }
    }
    // Final attempt: return whatever we get (success, retryable status, or error).
    build().send().await
}

// Resolve a base URL from an env override, but only honor a SAFE override and
// fall back to the hardcoded default otherwise. An https override is accepted
// for any host; a plaintext http override is accepted ONLY for a loopback host
// (the local Ollama daemon and the wiremock test server). This blocks both the
// SSRF-shaped hazard of a non-http scheme (file://, gopher://, …) and the
// cleartext-exfiltration hazard of `http://attacker/...` carrying an API key.
fn http_url_or(default_url: &str, env_key: &str) -> String {
    match std::env::var(env_key) {
        Ok(value) if override_allowed(&value) => value,
        _ => default_url.to_string(),
    }
}

// https anywhere; plaintext http only to a loopback host. Keyed vendor endpoints
// must therefore stay https, while the legitimate local-only endpoints
// (Ollama at 127.0.0.1, the wiremock test server) keep working.
fn override_allowed(value: &str) -> bool {
    if let Some(rest) = value.strip_prefix("https://") {
        return !rest.is_empty();
    }
    if let Some(rest) = value.strip_prefix("http://") {
        let host = rest.split(['/', ':']).next().unwrap_or("");
        return matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]");
    }
    false
}

// Endpoints. Production URLs that can be overridden via env for tests.
fn url_anthropic() -> String {
    http_url_or(
        "https://api.anthropic.com/v1/messages",
        "MEMEX_ANTHROPIC_URL",
    )
}
fn url_openai() -> String {
    http_url_or(
        "https://api.openai.com/v1/chat/completions",
        "MEMEX_OPENAI_URL",
    )
}
fn url_openai_models() -> String {
    http_url_or(
        "https://api.openai.com/v1/models",
        "MEMEX_OPENAI_MODELS_URL",
    )
}
fn url_openrouter() -> String {
    http_url_or(
        "https://openrouter.ai/api/v1/chat/completions",
        "MEMEX_OPENROUTER_URL",
    )
}
fn url_openrouter_models() -> String {
    http_url_or(
        "https://openrouter.ai/api/v1/models",
        "MEMEX_OPENROUTER_MODELS_URL",
    )
}
fn url_google(model: &str) -> String {
    let base = http_url_or(
        "https://generativelanguage.googleapis.com/v1beta/models",
        "MEMEX_GOOGLE_URL",
    );
    format!("{base}/{model}:generateContent")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String, // "system" | "user" | "assistant"
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRequest {
    pub provider_id: String,
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatResponse {
    pub provider_id: String,
    pub model: String,
    pub content: String,
    pub usage: Option<TokenUsage>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TokenUsage {
    pub input_tokens: u32,
    pub output_tokens: u32,
}

pub async fn chat_complete(
    req: ChatRequest,
    api_key: Option<String>,
) -> Result<ChatResponse, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(DEFAULT_TIMEOUT_SECS))
        // Vendor chat POSTs never legitimately 3xx-redirect; following one could
        // resend the x-api-key / x-goog-api-key custom header (not on reqwest's
        // cross-host strip-list) to another host. Refuse to follow redirects.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    match req.provider_id.as_str() {
        "anthropic-api" => call_anthropic(&client, req, api_key).await,
        "openai-api" | "openrouter" => call_openai_compatible(&client, req, api_key).await,
        "google-api" => call_google(&client, req, api_key).await,
        "ollama" => call_ollama(&client, req).await,
        other => Err(format!("unsupported provider: {other}")),
    }
}

pub async fn list_models(
    provider_id: &str,
    api_key: Option<String>,
) -> Result<Vec<String>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    match provider_id {
        "ollama" => list_ollama_models(&client).await,
        "openai-api" => list_openai_models(&client, api_key).await,
        // The Claude CLI takes a model alias (or full id) via --model. Offer the
        // aliases so high-volume ingest can run on the cheap "haiku" model; the
        // CLI resolves each alias to its latest version.
        "anthropic-cli" => Ok(vec!["haiku".into(), "sonnet".into(), "opus".into()]),
        "anthropic-api" => Ok(vec![
            "claude-opus-4-8".into(),
            "claude-sonnet-4-6".into(),
            "claude-haiku-4-5".into(),
        ]),
        "google-api" => Ok(vec![
            "gemini-2.5-pro".into(),
            "gemini-2.5-flash".into(),
            "gemini-2.5-flash-lite".into(),
        ]),
        "openrouter" => list_openrouter_models(&client).await,
        _ => Ok(Vec::new()),
    }
}

// ---------- Anthropic /v1/messages ----------

#[derive(Serialize)]
struct AnthropicRequest<'a> {
    model: &'a str,
    max_tokens: u32,
    messages: Vec<AnthropicMessage<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
}

#[derive(Serialize)]
struct AnthropicMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct AnthropicResponse {
    content: Vec<AnthropicContent>,
    usage: Option<AnthropicUsage>,
}

#[derive(Deserialize)]
struct AnthropicContent {
    #[serde(rename = "type")]
    kind: String,
    text: Option<String>,
}

#[derive(Deserialize)]
struct AnthropicUsage {
    input_tokens: u32,
    output_tokens: u32,
}

async fn call_anthropic(
    client: &reqwest::Client,
    req: ChatRequest,
    api_key: Option<String>,
) -> Result<ChatResponse, String> {
    let key = api_key.ok_or_else(|| "missing Anthropic API key".to_string())?;
    let system = req
        .messages
        .iter()
        .find(|m| m.role == "system")
        .map(|m| m.content.as_str());
    let body_messages: Vec<AnthropicMessage> = req
        .messages
        .iter()
        .filter(|m| m.role != "system")
        .map(|m| AnthropicMessage {
            role: m.role.as_str(),
            content: m.content.as_str(),
        })
        .collect();
    let body = AnthropicRequest {
        model: &req.model,
        max_tokens: req.max_tokens.unwrap_or(4096),
        messages: body_messages,
        system,
        temperature: req.temperature,
    };
    let url = url_anthropic();
    let resp = send_with_retry(|| {
        client
            .post(&url)
            .header("x-api-key", &key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
    })
    .await
    .map_err(|e| format!("anthropic request: {e}"))?;
    let status = resp.status();
    let bytes = read_capped(resp, MAX_RESPONSE_BYTES).await?;
    if !status.is_success() {
        return Err(format!(
            "anthropic {}: {}",
            status,
            String::from_utf8_lossy(&bytes)
        ));
    }
    let parsed: AnthropicResponse =
        serde_json::from_slice(&bytes).map_err(|e| format!("anthropic parse: {e}"))?;
    let content = parsed
        .content
        .into_iter()
        .filter(|c| c.kind == "text")
        .filter_map(|c| c.text)
        .collect::<Vec<_>>()
        .join("");
    Ok(ChatResponse {
        provider_id: req.provider_id,
        model: req.model,
        content,
        usage: parsed.usage.map(|u| TokenUsage {
            input_tokens: u.input_tokens,
            output_tokens: u.output_tokens,
        }),
    })
}

// ---------- OpenAI-compatible /v1/chat/completions ----------

#[derive(Serialize)]
struct OpenAIRequest<'a> {
    model: &'a str,
    messages: Vec<OpenAIMessage<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
}

#[derive(Serialize)]
struct OpenAIMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct OpenAIResponse {
    choices: Vec<OpenAIChoice>,
    usage: Option<OpenAIUsage>,
}

#[derive(Deserialize)]
struct OpenAIChoice {
    message: OpenAIResponseMessage,
}

#[derive(Deserialize)]
struct OpenAIResponseMessage {
    content: Option<String>,
}

#[derive(Deserialize)]
struct OpenAIUsage {
    prompt_tokens: u32,
    completion_tokens: u32,
}

async fn call_openai_compatible(
    client: &reqwest::Client,
    req: ChatRequest,
    api_key: Option<String>,
) -> Result<ChatResponse, String> {
    let key = api_key.ok_or_else(|| "missing API key".to_string())?;
    let url = match req.provider_id.as_str() {
        "openrouter" => url_openrouter(),
        _ => url_openai(),
    };
    let body = OpenAIRequest {
        model: &req.model,
        messages: req
            .messages
            .iter()
            .map(|m| OpenAIMessage {
                role: m.role.as_str(),
                content: m.content.as_str(),
            })
            .collect(),
        temperature: req.temperature,
        max_tokens: req.max_tokens,
    };
    let resp = send_with_retry(|| client.post(&url).bearer_auth(&key).json(&body))
        .await
        .map_err(|e| format!("request: {e}"))?;
    let status = resp.status();
    let bytes = read_capped(resp, MAX_RESPONSE_BYTES).await?;
    if !status.is_success() {
        return Err(format!(
            "{} {}: {}",
            req.provider_id,
            status,
            String::from_utf8_lossy(&bytes)
        ));
    }
    let parsed: OpenAIResponse =
        serde_json::from_slice(&bytes).map_err(|e| format!("openai parse: {e}"))?;
    let content = parsed
        .choices
        .into_iter()
        .next()
        .and_then(|c| c.message.content)
        .unwrap_or_default();
    Ok(ChatResponse {
        provider_id: req.provider_id,
        model: req.model,
        content,
        usage: parsed.usage.map(|u| TokenUsage {
            input_tokens: u.prompt_tokens,
            output_tokens: u.completion_tokens,
        }),
    })
}

async fn list_openai_models(
    client: &reqwest::Client,
    api_key: Option<String>,
) -> Result<Vec<String>, String> {
    let key = api_key.ok_or_else(|| "missing API key".to_string())?;
    let resp = client
        .get(url_openai_models())
        .bearer_auth(&key)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("openai models {}", resp.status()));
    }
    let bytes = read_capped(resp, MAX_RESPONSE_BYTES).await?;
    let json: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    if let Some(arr) = json.get("data").and_then(|v| v.as_array()) {
        for item in arr {
            if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                if is_chat_model(id) {
                    out.push(id.to_string());
                }
            }
        }
    }
    out.sort();
    Ok(out)
}

// Keep all chat-capable models from the live /v1/models list (gpt-*, o1/o3/o4
// reasoning, chatgpt-*, and future families) and only drop the obvious
// non-chat ones, rather than a stale prefix allowlist that hides new models.
fn is_chat_model(id: &str) -> bool {
    const NON_CHAT: [&str; 8] = [
        "embedding",
        "whisper",
        "tts",
        "dall-e",
        "image",
        "moderation",
        "audio",
        "realtime",
    ];
    !NON_CHAT.iter().any(|frag| id.contains(frag))
}

async fn list_openrouter_models(client: &reqwest::Client) -> Result<Vec<String>, String> {
    let resp = client
        .get(url_openrouter_models())
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("openrouter models {}", resp.status()));
    }
    let bytes = read_capped(resp, MAX_RESPONSE_BYTES).await?;
    let json: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    if let Some(arr) = json.get("data").and_then(|v| v.as_array()) {
        for item in arr {
            if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                out.push(id.to_string());
            }
        }
    }
    out.sort();
    out.truncate(80);
    Ok(out)
}

// ---------- Google Gemini ----------

#[derive(Serialize)]
struct GeminiRequest<'a> {
    contents: Vec<GeminiContent<'a>>,
    #[serde(rename = "systemInstruction", skip_serializing_if = "Option::is_none")]
    system_instruction: Option<GeminiContent<'a>>,
    #[serde(rename = "generationConfig", skip_serializing_if = "Option::is_none")]
    generation_config: Option<GeminiGenConfig>,
}

#[derive(Serialize)]
struct GeminiContent<'a> {
    role: &'a str, // "user" | "model"
    parts: Vec<GeminiPart<'a>>,
}

#[derive(Serialize)]
struct GeminiPart<'a> {
    text: &'a str,
}

#[derive(Serialize)]
struct GeminiGenConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(rename = "maxOutputTokens", skip_serializing_if = "Option::is_none")]
    max_output_tokens: Option<u32>,
}

#[derive(Deserialize)]
struct GeminiResponse {
    candidates: Option<Vec<GeminiCandidate>>,
    #[serde(rename = "usageMetadata")]
    usage_metadata: Option<GeminiUsage>,
}

#[derive(Deserialize)]
struct GeminiCandidate {
    content: Option<GeminiResponseContent>,
}

#[derive(Deserialize)]
struct GeminiResponseContent {
    parts: Option<Vec<GeminiResponsePart>>,
}

#[derive(Deserialize)]
struct GeminiResponsePart {
    text: Option<String>,
}

#[derive(Deserialize)]
struct GeminiUsage {
    #[serde(rename = "promptTokenCount", default)]
    prompt_token_count: u32,
    #[serde(rename = "candidatesTokenCount", default)]
    candidates_token_count: u32,
}

async fn call_google(
    client: &reqwest::Client,
    req: ChatRequest,
    api_key: Option<String>,
) -> Result<ChatResponse, String> {
    let key = api_key.ok_or_else(|| "missing Google API key".to_string())?;
    // Send the key via the x-goog-api-key header, NOT a `?key=` URL query param.
    // reqwest's error Display prints the failing URL verbatim, so a key in the
    // query string leaks into user-facing "gemini request: …" error strings.
    let url = url_google(&req.model);
    let system = req.messages.iter().find(|m| m.role == "system");
    let contents: Vec<GeminiContent> = req
        .messages
        .iter()
        .filter(|m| m.role != "system")
        .map(|m| GeminiContent {
            role: if m.role == "assistant" {
                "model"
            } else {
                "user"
            },
            parts: vec![GeminiPart {
                text: m.content.as_str(),
            }],
        })
        .collect();
    let body = GeminiRequest {
        contents,
        system_instruction: system.map(|s| GeminiContent {
            role: "system",
            parts: vec![GeminiPart {
                text: s.content.as_str(),
            }],
        }),
        generation_config: Some(GeminiGenConfig {
            temperature: req.temperature,
            max_output_tokens: req.max_tokens,
        }),
    };
    let resp = send_with_retry(|| client.post(&url).header("x-goog-api-key", &key).json(&body))
        .await
        .map_err(|e| format!("gemini request: {e}"))?;
    let status = resp.status();
    let bytes = read_capped(resp, MAX_RESPONSE_BYTES).await?;
    if !status.is_success() {
        return Err(format!(
            "gemini {}: {}",
            status,
            String::from_utf8_lossy(&bytes)
        ));
    }
    let parsed: GeminiResponse =
        serde_json::from_slice(&bytes).map_err(|e| format!("gemini parse: {e}"))?;
    let content = parsed
        .candidates
        .unwrap_or_default()
        .into_iter()
        .filter_map(|c| c.content)
        .flat_map(|c| c.parts.unwrap_or_default())
        .filter_map(|p| p.text)
        .collect::<Vec<_>>()
        .join("");
    Ok(ChatResponse {
        provider_id: req.provider_id,
        model: req.model,
        content,
        usage: parsed.usage_metadata.map(|u| TokenUsage {
            input_tokens: u.prompt_token_count,
            output_tokens: u.candidates_token_count,
        }),
    })
}

// ---------- Ollama (local) ----------

#[derive(Serialize)]
struct OllamaRequest<'a> {
    model: &'a str,
    messages: Vec<OllamaMessage<'a>>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    options: Option<OllamaOptions>,
}

#[derive(Serialize)]
struct OllamaMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Serialize)]
struct OllamaOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(rename = "num_predict", skip_serializing_if = "Option::is_none")]
    num_predict: Option<u32>,
}

#[derive(Deserialize)]
struct OllamaResponse {
    message: Option<OllamaResponseMessage>,
    #[serde(default)]
    prompt_eval_count: u32,
    #[serde(default)]
    eval_count: u32,
}

#[derive(Deserialize)]
struct OllamaResponseMessage {
    content: Option<String>,
}

async fn call_ollama(client: &reqwest::Client, req: ChatRequest) -> Result<ChatResponse, String> {
    let body = OllamaRequest {
        model: &req.model,
        messages: req
            .messages
            .iter()
            .map(|m| OllamaMessage {
                role: m.role.as_str(),
                content: m.content.as_str(),
            })
            .collect(),
        stream: false,
        options: Some(OllamaOptions {
            temperature: req.temperature,
            num_predict: req.max_tokens,
        }),
    };
    let endpoint = http_url_or("http://localhost:11434", "MEMEX_OLLAMA_URL");
    let url = format!("{}/api/chat", endpoint.trim_end_matches('/'));
    let resp = send_with_retry(|| client.post(&url).json(&body))
        .await
        .map_err(|e| format!("ollama request: {e}"))?;
    let status = resp.status();
    let bytes = read_capped(resp, MAX_RESPONSE_BYTES).await?;
    if !status.is_success() {
        return Err(format!(
            "ollama {}: {}",
            status,
            String::from_utf8_lossy(&bytes)
        ));
    }
    let parsed: OllamaResponse =
        serde_json::from_slice(&bytes).map_err(|e| format!("ollama parse: {e}"))?;
    let content = parsed.message.and_then(|m| m.content).unwrap_or_default();
    Ok(ChatResponse {
        provider_id: req.provider_id,
        model: req.model,
        content,
        usage: Some(TokenUsage {
            input_tokens: parsed.prompt_eval_count,
            output_tokens: parsed.eval_count,
        }),
    })
}

async fn list_ollama_models(client: &reqwest::Client) -> Result<Vec<String>, String> {
    let endpoint = http_url_or("http://localhost:11434", "MEMEX_OLLAMA_URL");
    let url = format!("{}/api/tags", endpoint.trim_end_matches('/'));
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("ollama tags {}", resp.status()));
    }
    let bytes = read_capped(resp, MAX_RESPONSE_BYTES).await?;
    let json: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    if let Some(arr) = json.get("models").and_then(|v| v.as_array()) {
        for item in arr {
            if let Some(name) = item.get("name").and_then(|v| v.as_str()) {
                out.push(name.to_string());
            }
        }
    }
    out.sort();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::http_url_or;

    // Use a dedicated env key so this test never collides with the production
    // MEMEX_*_URL keys the wiremock tests rely on (which run in the same process).
    const KEY: &str = "MEMEX_TEST_HTTP_URL_OR";
    const DEFAULT: &str = "https://example.invalid/default";

    #[test]
    fn http_url_or_accepts_and_rejects_overrides() {
        // https override to any host is honored.
        std::env::set_var(KEY, "https://api.example.com/v1");
        assert_eq!(http_url_or(DEFAULT, KEY), "https://api.example.com/v1");

        // Plaintext http is honored ONLY for a loopback host (local Ollama /
        // wiremock test server).
        std::env::set_var(KEY, "http://127.0.0.1:8080/v1/chat");
        assert_eq!(http_url_or(DEFAULT, KEY), "http://127.0.0.1:8080/v1/chat");
        std::env::set_var(KEY, "http://localhost:11434/api");
        assert_eq!(http_url_or(DEFAULT, KEY), "http://localhost:11434/api");

        // Plaintext http to a NON-loopback host is rejected (it would leak an API
        // key in cleartext) and falls back to the default.
        std::env::set_var(KEY, "http://attacker.example.com/v1");
        assert_eq!(http_url_or(DEFAULT, KEY), DEFAULT);

        // Non-http(s) overrides are rejected and fall back to the default.
        std::env::set_var(KEY, "file:///etc/passwd");
        assert_eq!(http_url_or(DEFAULT, KEY), DEFAULT);

        std::env::set_var(KEY, "ftp://example.com/x");
        assert_eq!(http_url_or(DEFAULT, KEY), DEFAULT);

        std::env::set_var(KEY, "127.0.0.1:8080"); // no scheme
        assert_eq!(http_url_or(DEFAULT, KEY), DEFAULT);

        // A missing env var falls back to the default.
        std::env::remove_var(KEY);
        assert_eq!(http_url_or(DEFAULT, KEY), DEFAULT);
    }
}
