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

// ================= Agent tool-calling (Feature 4) =========================
//
// A tool-calling variant of chat_complete used by the in-app agent loop. The
// frontend sends a provider-neutral message list plus tool schemas; we
// translate to each vendor's tool protocol, POST, and parse back either a
// final text answer or a list of tool calls the loop must satisfy and resend.
//
// Only HTTP providers go through here (CLI providers run their own tool loop).
// Anthropic + OpenAI-compatible (openai / openrouter) are supported; other
// providers return an explicit "unsupported" error rather than pretending.
// The request builders and response parsers are pure so they are unit-tested
// without a network or API key.

/// One tool call the model wants executed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentToolCall {
    pub id: String,
    pub name: String,
    pub input: serde_json::Value,
}

/// A provider-neutral turn in the agent transcript (what the loop sends us).
/// - user/assistant text turn: role + `content`
/// - assistant tool-call turn: role="assistant" + `tool_calls`
/// - tool result turn: role="tool" + `tool_call_id` + `content`
#[derive(Debug, Clone, Deserialize)]
pub struct AgentMessage {
    pub role: String,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub tool_calls: Option<Vec<AgentToolCall>>,
    #[serde(default)]
    pub tool_call_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentChatRequest {
    pub provider_id: String,
    pub model: String,
    #[serde(default)]
    pub system: Option<String>,
    pub messages: Vec<AgentMessage>,
    /// Tool schemas: [{ name, description, input_schema }].
    pub tools: Vec<serde_json::Value>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
}

/// The model's reply: either final `text` (when `tool_calls` is empty) or the
/// tool calls the loop must run and feed back.
#[derive(Debug, Clone, Serialize)]
pub struct AgentTurn {
    pub text: String,
    pub tool_calls: Vec<AgentToolCall>,
    pub usage: Option<TokenUsage>,
    /// Provider stop reason, passed through for the loop's telemetry.
    pub stop: String,
}

pub async fn agent_chat(
    req: AgentChatRequest,
    api_key: Option<String>,
) -> Result<AgentTurn, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(DEFAULT_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    match req.provider_id.as_str() {
        "anthropic-api" => agent_chat_anthropic(&client, req, api_key).await,
        "openai-api" | "openrouter" => agent_chat_openai(&client, req, api_key).await,
        other => Err(format!(
            "agent mode does not support provider '{other}' yet — use Claude Code (CLI), \
             the Anthropic API, or an OpenAI-compatible provider"
        )),
    }
}

// ---- Anthropic tool protocol ----

/// Build the Anthropic `/v1/messages` body (with tools) from a neutral request.
fn build_anthropic_agent_body(req: &AgentChatRequest) -> serde_json::Value {
    let messages: Vec<serde_json::Value> = req
        .messages
        .iter()
        .filter(|m| m.role != "system")
        .map(|m| match m.role.as_str() {
            "tool" => serde_json::json!({
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": m.tool_call_id.clone().unwrap_or_default(),
                    "content": m.content.clone().unwrap_or_default(),
                }],
            }),
            "assistant" if m.tool_calls.as_ref().is_some_and(|t| !t.is_empty()) => {
                let mut blocks: Vec<serde_json::Value> = Vec::new();
                if let Some(text) = m.content.as_ref().filter(|t| !t.is_empty()) {
                    blocks.push(serde_json::json!({ "type": "text", "text": text }));
                }
                for tc in m.tool_calls.as_ref().unwrap() {
                    blocks.push(serde_json::json!({
                        "type": "tool_use", "id": tc.id, "name": tc.name, "input": tc.input,
                    }));
                }
                serde_json::json!({ "role": "assistant", "content": blocks })
            }
            role => serde_json::json!({
                "role": role,
                "content": [{ "type": "text", "text": m.content.clone().unwrap_or_default() }],
            }),
        })
        .collect();
    let tools: Vec<serde_json::Value> = req
        .tools
        .iter()
        .map(|t| {
            serde_json::json!({
                "name": t.get("name").cloned().unwrap_or_default(),
                "description": t.get("description").cloned().unwrap_or_default(),
                "input_schema": t.get("input_schema").cloned().unwrap_or(serde_json::json!({"type":"object"})),
            })
        })
        .collect();
    let mut body = serde_json::json!({
        "model": req.model,
        "max_tokens": req.max_tokens.unwrap_or(4096),
        "messages": messages,
        "tools": tools,
    });
    if let Some(sys) = req.system.as_ref().filter(|s| !s.is_empty()) {
        body["system"] = serde_json::json!(sys);
    }
    body
}

/// Parse an Anthropic tool-calling response into an AgentTurn.
fn parse_anthropic_agent_turn(v: &serde_json::Value) -> AgentTurn {
    let mut text = String::new();
    let mut tool_calls = Vec::new();
    if let Some(blocks) = v.get("content").and_then(|c| c.as_array()) {
        for b in blocks {
            match b.get("type").and_then(|t| t.as_str()) {
                Some("text") => {
                    if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                        text.push_str(t);
                    }
                }
                Some("tool_use") => tool_calls.push(AgentToolCall {
                    id: b.get("id").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                    name: b.get("name").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                    input: b.get("input").cloned().unwrap_or(serde_json::json!({})),
                }),
                _ => {}
            }
        }
    }
    let usage = v.get("usage").map(|u| TokenUsage {
        input_tokens: u.get("input_tokens").and_then(|n| n.as_u64()).unwrap_or(0) as u32,
        output_tokens: u.get("output_tokens").and_then(|n| n.as_u64()).unwrap_or(0) as u32,
    });
    AgentTurn {
        text,
        tool_calls,
        usage,
        stop: v.get("stop_reason").and_then(|s| s.as_str()).unwrap_or("").to_string(),
    }
}

async fn agent_chat_anthropic(
    client: &reqwest::Client,
    req: AgentChatRequest,
    api_key: Option<String>,
) -> Result<AgentTurn, String> {
    let key = api_key.ok_or_else(|| "missing Anthropic API key".to_string())?;
    let body = build_anthropic_agent_body(&req);
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
        return Err(format!("anthropic {}: {}", status, String::from_utf8_lossy(&bytes)));
    }
    let v: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("anthropic parse: {e}"))?;
    Ok(parse_anthropic_agent_turn(&v))
}

// ---- OpenAI-compatible tool protocol ----

fn build_openai_agent_body(req: &AgentChatRequest) -> serde_json::Value {
    let mut messages: Vec<serde_json::Value> = Vec::new();
    if let Some(sys) = req.system.as_ref().filter(|s| !s.is_empty()) {
        messages.push(serde_json::json!({ "role": "system", "content": sys }));
    }
    for m in &req.messages {
        match m.role.as_str() {
            "system" => messages.push(serde_json::json!({
                "role": "system", "content": m.content.clone().unwrap_or_default()
            })),
            "tool" => messages.push(serde_json::json!({
                "role": "tool",
                "tool_call_id": m.tool_call_id.clone().unwrap_or_default(),
                "content": m.content.clone().unwrap_or_default(),
            })),
            "assistant" if m.tool_calls.as_ref().is_some_and(|t| !t.is_empty()) => {
                let calls: Vec<serde_json::Value> = m
                    .tool_calls
                    .as_ref()
                    .unwrap()
                    .iter()
                    .map(|tc| {
                        serde_json::json!({
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.name,
                                "arguments": serde_json::to_string(&tc.input).unwrap_or_else(|_| "{}".into()),
                            },
                        })
                    })
                    .collect();
                messages.push(serde_json::json!({
                    "role": "assistant",
                    "content": m.content.clone().unwrap_or_default(),
                    "tool_calls": calls,
                }));
            }
            role => messages.push(serde_json::json!({
                "role": role, "content": m.content.clone().unwrap_or_default()
            })),
        }
    }
    let tools: Vec<serde_json::Value> = req
        .tools
        .iter()
        .map(|t| {
            serde_json::json!({
                "type": "function",
                "function": {
                    "name": t.get("name").cloned().unwrap_or_default(),
                    "description": t.get("description").cloned().unwrap_or_default(),
                    "parameters": t.get("input_schema").cloned().unwrap_or(serde_json::json!({"type":"object"})),
                },
            })
        })
        .collect();
    serde_json::json!({
        "model": req.model,
        "messages": messages,
        "tools": tools,
        "max_tokens": req.max_tokens.unwrap_or(4096),
    })
}

fn parse_openai_agent_turn(v: &serde_json::Value) -> AgentTurn {
    let msg = v.pointer("/choices/0/message");
    let text = msg
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    let mut tool_calls = Vec::new();
    if let Some(calls) = msg.and_then(|m| m.get("tool_calls")).and_then(|c| c.as_array()) {
        for c in calls {
            let fname = c.pointer("/function/name").and_then(|s| s.as_str()).unwrap_or("");
            let raw_args = c.pointer("/function/arguments").and_then(|s| s.as_str()).unwrap_or("{}");
            let input = serde_json::from_str(raw_args).unwrap_or(serde_json::json!({}));
            tool_calls.push(AgentToolCall {
                id: c.get("id").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                name: fname.to_string(),
                input,
            });
        }
    }
    let usage = v.get("usage").map(|u| TokenUsage {
        input_tokens: u.get("prompt_tokens").and_then(|n| n.as_u64()).unwrap_or(0) as u32,
        output_tokens: u.get("completion_tokens").and_then(|n| n.as_u64()).unwrap_or(0) as u32,
    });
    AgentTurn {
        text,
        tool_calls,
        usage,
        stop: v.pointer("/choices/0/finish_reason").and_then(|s| s.as_str()).unwrap_or("").to_string(),
    }
}

async fn agent_chat_openai(
    client: &reqwest::Client,
    req: AgentChatRequest,
    api_key: Option<String>,
) -> Result<AgentTurn, String> {
    let key = api_key.ok_or_else(|| "missing API key".to_string())?;
    let url = match req.provider_id.as_str() {
        "openrouter" => url_openrouter(),
        _ => url_openai(),
    };
    let body = build_openai_agent_body(&req);
    let resp = send_with_retry(|| client.post(&url).bearer_auth(&key).json(&body))
        .await
        .map_err(|e| format!("request: {e}"))?;
    let status = resp.status();
    let bytes = read_capped(resp, MAX_RESPONSE_BYTES).await?;
    if !status.is_success() {
        return Err(format!("{} {}: {}", req.provider_id, status, String::from_utf8_lossy(&bytes)));
    }
    let v: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("openai parse: {e}"))?;
    Ok(parse_openai_agent_turn(&v))
}

// ================= Vision: describe an image (Feature 2) ==================
//
// One-shot "describe this image" over the vision-capable HTTP providers, so an
// image dropped into Ingest becomes text the normal pipeline can wiki-ify. Pure
// body builders + parsers (cargo-tested without a key); the live call needs an
// API key. CLI/Ollama/builtin providers are rejected explicitly.

/// Minimal standard-base64 encoder (no external crate).
pub fn b64_encode(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

/// Guess an image media type from a file extension.
pub fn image_media_type(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "image/jpeg",
    }
}

pub fn build_anthropic_vision_body(
    model: &str,
    media_type: &str,
    data_b64: &str,
    prompt: &str,
) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "max_tokens": 1024,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "image", "source": { "type": "base64", "media_type": media_type, "data": data_b64 } },
                { "type": "text", "text": prompt },
            ],
        }],
    })
}

pub fn build_openai_vision_body(
    model: &str,
    media_type: &str,
    data_b64: &str,
    prompt: &str,
) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "max_tokens": 1024,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": prompt },
                { "type": "image_url", "image_url": { "url": format!("data:{media_type};base64,{data_b64}") } },
            ],
        }],
    })
}

pub fn build_google_vision_body(
    media_type: &str,
    data_b64: &str,
    prompt: &str,
) -> serde_json::Value {
    serde_json::json!({
        "contents": [{
            "parts": [
                { "inline_data": { "mime_type": media_type, "data": data_b64 } },
                { "text": prompt },
            ],
        }],
    })
}

pub async fn describe_image(
    provider_id: &str,
    model: &str,
    image_bytes: &[u8],
    media_type: &str,
    prompt: &str,
    api_key: Option<String>,
) -> Result<String, String> {
    let data = b64_encode(image_bytes);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(DEFAULT_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    match provider_id {
        "anthropic-api" => {
            let key = api_key.ok_or_else(|| "missing Anthropic API key".to_string())?;
            let body = build_anthropic_vision_body(model, media_type, &data, prompt);
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
                return Err(format!("anthropic {}: {}", status, String::from_utf8_lossy(&bytes)));
            }
            let v: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            Ok(v.get("content")
                .and_then(|c| c.as_array())
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                        .collect::<Vec<_>>()
                        .join("")
                })
                .unwrap_or_default())
        }
        "openai-api" => {
            let key = api_key.ok_or_else(|| "missing OpenAI API key".to_string())?;
            let body = build_openai_vision_body(model, media_type, &data, prompt);
            let url = url_openai();
            let resp = send_with_retry(|| client.post(&url).bearer_auth(&key).json(&body))
                .await
                .map_err(|e| format!("openai request: {e}"))?;
            let status = resp.status();
            let bytes = read_capped(resp, MAX_RESPONSE_BYTES).await?;
            if !status.is_success() {
                return Err(format!("openai {}: {}", status, String::from_utf8_lossy(&bytes)));
            }
            let v: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            Ok(v.pointer("/choices/0/message/content").and_then(|c| c.as_str()).unwrap_or("").to_string())
        }
        "google-api" => {
            let key = api_key.ok_or_else(|| "missing Google API key".to_string())?;
            let body = build_google_vision_body(media_type, &data, prompt);
            let url = url_google(model);
            let resp = send_with_retry(|| client.post(&url).header("x-goog-api-key", &key).json(&body))
                .await
                .map_err(|e| format!("gemini request: {e}"))?;
            let status = resp.status();
            let bytes = read_capped(resp, MAX_RESPONSE_BYTES).await?;
            if !status.is_success() {
                return Err(format!("gemini {}: {}", status, String::from_utf8_lossy(&bytes)));
            }
            let v: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            Ok(v.pointer("/candidates/0/content/parts")
                .and_then(|p| p.as_array())
                .map(|parts| {
                    parts
                        .iter()
                        .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                        .collect::<Vec<_>>()
                        .join("")
                })
                .unwrap_or_default())
        }
        other => Err(format!(
            "image ingest needs a vision-capable provider (Anthropic API, OpenAI API, \
             or Google AI). '{other}' can't describe images — pick one under Settings → Model."
        )),
    }
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

    use super::{
        build_anthropic_agent_body, build_openai_agent_body, parse_anthropic_agent_turn,
        parse_openai_agent_turn, AgentChatRequest, AgentMessage, AgentToolCall,
    };
    use serde_json::json;

    fn sample_req() -> AgentChatRequest {
        AgentChatRequest {
            provider_id: "anthropic-api".into(),
            model: "claude-x".into(),
            system: Some("you are an agent".into()),
            messages: vec![
                AgentMessage {
                    role: "user".into(),
                    content: Some("find X".into()),
                    tool_calls: None,
                    tool_call_id: None,
                },
                AgentMessage {
                    role: "assistant".into(),
                    content: None,
                    tool_calls: Some(vec![AgentToolCall {
                        id: "call_1".into(),
                        name: "search_vault".into(),
                        input: json!({ "query": "X" }),
                    }]),
                    tool_call_id: None,
                },
                AgentMessage {
                    role: "tool".into(),
                    content: Some("{\"hits\":[]}".into()),
                    tool_calls: None,
                    tool_call_id: Some("call_1".into()),
                },
            ],
            tools: vec![json!({
                "name": "search_vault",
                "description": "search",
                "input_schema": { "type": "object" }
            })],
            max_tokens: None,
        }
    }

    #[test]
    fn anthropic_body_maps_system_toolcalls_and_results() {
        let body = build_anthropic_agent_body(&sample_req());
        assert_eq!(body["system"], "you are an agent");
        let msgs = body["messages"].as_array().unwrap();
        // user text, assistant tool_use, tool_result-as-user
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[1]["content"][0]["type"], "tool_use");
        assert_eq!(msgs[1]["content"][0]["name"], "search_vault");
        assert_eq!(msgs[2]["role"], "user");
        assert_eq!(msgs[2]["content"][0]["type"], "tool_result");
        assert_eq!(msgs[2]["content"][0]["tool_use_id"], "call_1");
        assert_eq!(body["tools"][0]["name"], "search_vault");
    }

    #[test]
    fn openai_body_maps_system_toolcalls_and_results() {
        let mut req = sample_req();
        req.provider_id = "openai-api".into();
        let body = build_openai_agent_body(&req);
        let msgs = body["messages"].as_array().unwrap();
        // system + user + assistant(tool_calls) + tool
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[2]["tool_calls"][0]["function"]["name"], "search_vault");
        // arguments must be a JSON *string*, not an object (OpenAI protocol).
        assert!(msgs[2]["tool_calls"][0]["function"]["arguments"].is_string());
        assert_eq!(msgs[3]["role"], "tool");
        assert_eq!(msgs[3]["tool_call_id"], "call_1");
        assert_eq!(body["tools"][0]["type"], "function");
    }

    #[test]
    fn parse_anthropic_turn_extracts_text_and_tool_use() {
        let v = json!({
            "content": [
                { "type": "text", "text": "let me search" },
                { "type": "tool_use", "id": "t1", "name": "search_vault", "input": { "query": "attn" } }
            ],
            "usage": { "input_tokens": 12, "output_tokens": 5 },
            "stop_reason": "tool_use"
        });
        let turn = parse_anthropic_agent_turn(&v);
        assert_eq!(turn.text, "let me search");
        assert_eq!(turn.tool_calls.len(), 1);
        assert_eq!(turn.tool_calls[0].name, "search_vault");
        assert_eq!(turn.tool_calls[0].input["query"], "attn");
        assert_eq!(turn.usage.unwrap().input_tokens, 12);
        assert_eq!(turn.stop, "tool_use");
    }

    #[test]
    fn parse_openai_turn_extracts_toolcalls_with_stringified_args() {
        let v = json!({
            "choices": [{
                "message": {
                    "content": null,
                    "tool_calls": [{
                        "id": "c1",
                        "function": { "name": "read_page", "arguments": "{\"path\":\"wiki/a.md\"}" }
                    }]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": { "prompt_tokens": 8, "completion_tokens": 3 }
        });
        let turn = parse_openai_agent_turn(&v);
        assert_eq!(turn.tool_calls.len(), 1);
        assert_eq!(turn.tool_calls[0].name, "read_page");
        assert_eq!(turn.tool_calls[0].input["path"], "wiki/a.md");
        assert_eq!(turn.stop, "tool_calls");
    }

    #[test]
    fn parse_openai_turn_final_text_no_tools() {
        let v = json!({
            "choices": [{ "message": { "content": "the answer is 42" }, "finish_reason": "stop" }]
        });
        let turn = parse_openai_agent_turn(&v);
        assert_eq!(turn.text, "the answer is 42");
        assert!(turn.tool_calls.is_empty());
    }

    use super::{
        b64_encode, build_anthropic_vision_body, build_google_vision_body,
        build_openai_vision_body, image_media_type,
    };

    #[test]
    fn b64_encode_matches_known_vectors() {
        assert_eq!(b64_encode(b""), "");
        assert_eq!(b64_encode(b"f"), "Zg==");
        assert_eq!(b64_encode(b"fo"), "Zm8=");
        assert_eq!(b64_encode(b"foo"), "Zm9v");
        assert_eq!(b64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(b64_encode(b"hello"), "aGVsbG8=");
    }

    #[test]
    fn image_media_type_from_ext() {
        assert_eq!(image_media_type("PNG"), "image/png");
        assert_eq!(image_media_type("webp"), "image/webp");
        assert_eq!(image_media_type("jpg"), "image/jpeg");
        assert_eq!(image_media_type("jpeg"), "image/jpeg");
    }

    #[test]
    fn vision_bodies_shape_per_provider() {
        let a = build_anthropic_vision_body("m", "image/png", "AAA", "describe");
        assert_eq!(a["messages"][0]["content"][0]["type"], "image");
        assert_eq!(a["messages"][0]["content"][0]["source"]["media_type"], "image/png");
        assert_eq!(a["messages"][0]["content"][1]["text"], "describe");

        let o = build_openai_vision_body("m", "image/jpeg", "BBB", "describe");
        assert_eq!(o["messages"][0]["content"][1]["type"], "image_url");
        assert_eq!(
            o["messages"][0]["content"][1]["image_url"]["url"],
            "data:image/jpeg;base64,BBB"
        );

        let g = build_google_vision_body("image/gif", "CCC", "describe");
        assert_eq!(g["contents"][0]["parts"][0]["inline_data"]["mime_type"], "image/gif");
        assert_eq!(g["contents"][0]["parts"][1]["text"], "describe");
    }
}
