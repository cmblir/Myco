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
        Ok(resp) if resp.status().is_success() => {
            let json: serde_json::Value = resp.json().await.unwrap_or_default();
            let mut out = Vec::new();
            if let Some(arr) = json.get("models").and_then(|v| v.as_array()) {
                for item in arr {
                    if let Some(name) = item.get("name").and_then(|v| v.as_str()) {
                        let size = item.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
                        out.push(OllamaModel {
                            name: name.to_string(),
                            size,
                        });
                    }
                }
            }
            (true, out, None)
        }
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
