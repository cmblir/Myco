// Ollama setup helper. Beyond the plain HTTP adapter in providers.rs, we
// surface a richer status to drive the Settings → Connections card so the
// user can tell whether the binary is installed, whether the daemon is
// reachable, and which models (if any) are pulled.

use serde::Serialize;
use std::process::Command;
use std::time::Duration;

#[derive(Debug, Clone, Serialize)]
pub struct OllamaModel {
    pub name: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct OllamaStatus {
    pub binary_installed: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub daemon_running: bool,
    pub endpoint: String,
    pub models: Vec<OllamaModel>,
    pub error: Option<String>,
}

fn endpoint() -> String {
    std::env::var("MEMEX_OLLAMA_URL").unwrap_or_else(|_| "http://localhost:11434".to_string())
}

/// Parse the body of a `GET /api/tags` 200 into the model list.
///
/// Kept pure so it is testable without a live daemon, and — the point of this
/// function — so a body that is NOT the expected JSON becomes an Err rather than
/// silently decoding to an empty model list. A 200 with an unreadable body means
/// "the daemon answered but I cannot tell what it has", which is a different fact
/// from "the daemon has no models", and the user is told which.
fn parse_tags(body: &str) -> Result<Vec<OllamaModel>, String> {
    let json: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("unreadable /api/tags response: {e}"))?;
    let arr = json
        .get("models")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "unexpected /api/tags shape: no \"models\" array".to_string())?;
    Ok(arr
        .iter()
        .filter_map(|item| {
            let name = item.get("name").and_then(|v| v.as_str())?;
            let size = item.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
            Some(OllamaModel {
                name: name.to_string(),
                size,
            })
        })
        .collect())
}

fn locate_binary() -> (bool, Option<String>) {
    // Cross-platform resolution (env override, where/which, well-known dirs,
    // login shell) — shared with the claude/gemini/codex CLIs so Windows finds
    // `ollama.exe` via `where` instead of the unix-only `/usr/bin/which`.
    if let Some(p) = crate::claude::locate_bin("ollama", "MEMEX_OLLAMA_PATH") {
        return (true, Some(p));
    }
    // macOS app-bundle fallback (Ollama.app ships the binary outside PATH).
    for candidate in ["/Applications/Ollama.app/Contents/Resources/ollama"] {
        if std::path::Path::new(candidate).exists() {
            return (true, Some(candidate.to_string()));
        }
    }
    (false, None)
}

fn get_version(path: &str) -> Option<String> {
    let out = Command::new(path).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

pub async fn check() -> OllamaStatus {
    let (installed, path) = locate_binary();
    let version = path.as_deref().and_then(get_version);
    let url = endpoint();
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(900))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return OllamaStatus {
                binary_installed: installed,
                binary_path: path,
                version,
                daemon_running: false,
                endpoint: url,
                models: Vec::new(),
                error: Some(format!("http client: {e}")),
            };
        }
    };
    let tags_url = format!("{}/api/tags", url.trim_end_matches('/'));
    let (running, models, error) = match client.get(&tags_url).send().await {
        Ok(resp) if resp.status().is_success() => match resp.text().await {
            // The daemon answered 200. If the body doesn't parse, say so —
            // reporting "running, zero models" would tell the user to pull a
            // model they may already have.
            Ok(body) => match parse_tags(&body) {
                Ok(models) => (true, models, None),
                Err(e) => (true, Vec::new(), Some(e)),
            },
            Err(e) => (true, Vec::new(), Some(format!("reading /api/tags body: {e}"))),
        },
        Ok(resp) => (
            false,
            Vec::new(),
            Some(format!("daemon HTTP {}", resp.status())),
        ),
        Err(e) => (false, Vec::new(), Some(format!("daemon unreachable: {e}"))),
    };
    OllamaStatus {
        binary_installed: installed,
        binary_path: path,
        version,
        daemon_running: running,
        endpoint: url,
        models,
        error,
    }
}

/// Returns the platform-specific URL the user should visit to install Ollama.
pub fn install_url() -> &'static str {
    "https://ollama.com/download"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_url_is_https() {
        let url = install_url();
        assert!(url.starts_with("https://"), "install URL must be https");
        assert!(url.contains("ollama.com"));
    }

    #[test]
    fn endpoint_defaults_to_localhost() {
        // Snapshot then restore so we don't pollute env for other tests.
        let prev = std::env::var("MEMEX_OLLAMA_URL").ok();
        // SAFETY: tests are single-threaded by default for env mutation.
        unsafe {
            std::env::remove_var("MEMEX_OLLAMA_URL");
        }
        let url = endpoint();
        assert_eq!(url, "http://localhost:11434");
        if let Some(v) = prev {
            unsafe {
                std::env::set_var("MEMEX_OLLAMA_URL", v);
            }
        }
    }

    #[test]
    fn parse_tags_reads_the_model_list() {
        let body = r#"{"models":[
            {"name":"llama3:8b","size":4700000000},
            {"name":"gemma:2b","size":1600000000}
        ]}"#;
        let models = parse_tags(body).expect("well-formed body");
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].name, "llama3:8b");
        assert_eq!(models[0].size, 4_700_000_000);
        // A missing size is tolerated (0), a missing name drops the entry.
        assert_eq!(parse_tags(r#"{"models":[{"name":"x"}]}"#).unwrap()[0].size, 0);
    }

    #[test]
    fn parse_tags_errors_on_a_bad_body_instead_of_reporting_zero_models() {
        // This is the whole bug: a 200 with an unreadable body used to decode to
        // an empty Vec and report success, indistinguishable from an empty
        // install. Both of these must be Err, not Ok(empty).
        assert!(parse_tags("<html>502 Bad Gateway</html>").is_err());
        assert!(parse_tags("").is_err());
        // Valid JSON, wrong shape (no "models" array) is also an error, not zero.
        assert!(parse_tags(r#"{"error":"model runner not started"}"#).is_err());
    }

    #[test]
    fn parse_tags_reads_an_empty_but_valid_model_list() {
        // A genuinely empty install: valid JSON, empty array. This one IS Ok.
        assert_eq!(parse_tags(r#"{"models":[]}"#).unwrap().len(), 0);
    }

    #[test]
    fn endpoint_respects_env_override() {
        let prev = std::env::var("MEMEX_OLLAMA_URL").ok();
        unsafe {
            std::env::set_var("MEMEX_OLLAMA_URL", "http://example.test:1234");
        }
        let url = endpoint();
        assert_eq!(url, "http://example.test:1234");
        if let Some(v) = prev {
            unsafe {
                std::env::set_var("MEMEX_OLLAMA_URL", v);
            }
        } else {
            unsafe {
                std::env::remove_var("MEMEX_OLLAMA_URL");
            }
        }
    }
}
