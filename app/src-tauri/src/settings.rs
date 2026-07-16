// Persisted user settings — written to ~/Library/Application Support/dev.cmblir.memex/
// (or platform equivalent). Stores non-secret data only: connection flags
// (true/false), selected provider + model per task, language. API keys live
// in the OS keychain (see secrets.rs).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub providers: ProviderFlags,
    #[serde(default = "default_query_provider")]
    pub query_provider: String,
    #[serde(default = "default_query_model")]
    pub query_model: String,
    #[serde(default = "default_ingest_provider")]
    pub ingest_provider: String,
    #[serde(default = "default_ingest_model")]
    pub ingest_model: String,
    /// Memex Pro proxy base URL (the subscription ingest endpoint). Empty until
    /// the user configures it; the license key lives in the keychain.
    #[serde(default)]
    pub memex_pro_url: String,
    /// The Memex Pro account email the app is logged in as (for display only;
    /// the access key lives in the keychain). Empty when logged out.
    #[serde(default)]
    pub memex_pro_email: String,
    /// While the app is open, periodically ingest pending `_inbox/` sources.
    #[serde(default)]
    pub auto_ingest_enabled: bool,
    #[serde(default = "default_auto_ingest_interval")]
    pub auto_ingest_interval_min: u32,
    /// While the app is open, periodically run a read-only reflect pass that
    /// proposes wiki improvements (see reflectStore.ts). Writes nothing.
    #[serde(default)]
    pub auto_reflect_enabled: bool,
    #[serde(default = "default_auto_reflect_interval")]
    pub auto_reflect_interval_min: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            providers: ProviderFlags::default(),
            query_provider: default_query_provider(),
            query_model: default_query_model(),
            ingest_provider: default_ingest_provider(),
            ingest_model: default_ingest_model(),
            memex_pro_url: String::new(),
            memex_pro_email: String::new(),
            auto_ingest_enabled: false,
            auto_ingest_interval_min: default_auto_ingest_interval(),
            auto_reflect_enabled: false,
            auto_reflect_interval_min: default_auto_reflect_interval(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderFlags {
    // anthropic_cli defaults to true: it's the app's primary path and was
    // implicitly always-on before flags existed for CLIs, so existing
    // installs keep working after upgrade.
    #[serde(default = "default_true")]
    pub anthropic_cli: bool,
    #[serde(default)]
    pub gemini_cli: bool,
    #[serde(default)]
    pub codex_cli: bool,
    #[serde(default)]
    pub anthropic_api: bool,
    #[serde(default)]
    pub openai_api: bool,
    #[serde(default)]
    pub google_api: bool,
    #[serde(default)]
    pub ollama: bool,
    #[serde(default)]
    pub openrouter: bool,
    #[serde(default)]
    pub memex_pro: bool,
    // Embedded model ships inside the app — zero setup, so on by default.
    #[serde(default = "default_true")]
    pub builtin_local: bool,
}

impl Default for ProviderFlags {
    fn default() -> Self {
        Self {
            anthropic_cli: true,
            gemini_cli: false,
            codex_cli: false,
            anthropic_api: false,
            openai_api: false,
            google_api: false,
            ollama: false,
            openrouter: false,
            memex_pro: false,
            builtin_local: true,
        }
    }
}

fn default_true() -> bool {
    true
}

fn default_query_provider() -> String {
    "anthropic-cli".to_string()
}
fn default_query_model() -> String {
    // CLI alias (the default provider is the claude CLI). Sonnet balances quality
    // and cost for answering; ingest defaults to the cheaper Haiku below.
    "sonnet".to_string()
}
fn default_ingest_provider() -> String {
    "anthropic-cli".to_string()
}
fn default_ingest_model() -> String {
    // Cheapest CLI alias — ingest is high-volume, so default to Haiku.
    "haiku".to_string()
}
fn default_auto_ingest_interval() -> u32 {
    60
}
fn default_auto_reflect_interval() -> u32 {
    // Reflect is a heavier full-vault pass than a single inbox ingest, so it
    // defaults to a longer cadence.
    180
}

pub fn settings_dir() -> Result<PathBuf, String> {
    let base = if let Ok(p) = std::env::var("MEMEX_DATA_DIR") {
        PathBuf::from(p)
    } else if cfg!(target_os = "macos") {
        let home = std::env::var_os("HOME").ok_or_else(|| "no HOME".to_string())?;
        PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("dev.cmblir.memex")
    } else if cfg!(target_os = "windows") {
        let appdata = std::env::var_os("APPDATA").ok_or_else(|| "no APPDATA".to_string())?;
        PathBuf::from(appdata).join("Memex")
    } else {
        let home = std::env::var_os("HOME").ok_or_else(|| "no HOME".to_string())?;
        PathBuf::from(home).join(".config").join("memex")
    };
    std::fs::create_dir_all(&base).map_err(|e| format!("create settings dir: {e}"))?;
    Ok(base)
}

pub fn load() -> Settings {
    let path = match settings_dir() {
        Ok(p) => p.join("settings.json"),
        Err(_) => return Settings::default(),
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Settings::default(),
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

// Atomic + durable write: stage into a temp file in the same dir, fsync it,
// then rename over the target. A crash mid-write leaves the target either fully
// old or fully new — never a truncated/corrupt file. Mirrors vault::write_file.
pub(crate) fn atomic_write(target: &std::path::Path, content: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let dir = target
        .parent()
        .ok_or_else(|| format!("no parent dir for {}", target.display()))?;
    let mut tmp = tempfile::Builder::new()
        .prefix(".memex-tmp-")
        .tempfile_in(dir)
        .map_err(|e| format!("tempfile create failed: {e}"))?;
    tmp.write_all(content)
        .map_err(|e| format!("tempfile write failed: {e}"))?;
    tmp.as_file_mut()
        .sync_all()
        .map_err(|e| format!("tempfile sync failed: {e}"))?;
    tmp.persist(target)
        .map_err(|e| format!("rename failed: {}", e.error))?;
    Ok(())
}

pub fn save(settings: &Settings) -> Result<(), String> {
    let path = settings_dir()?.join("settings.json");
    let raw = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    atomic_write(&path, raw.as_bytes()).map_err(|e| format!("write settings: {e}"))
}

/// Record the vault the app currently has open into a marker file the bundled
/// MCP server reads (project_registry.py `_active_vault`). The stdio MCP server
/// has no live IPC link back to the app, so this file is how it follows the
/// user's current vault selection instead of writing into the source-repo root.
pub fn set_active_vault(path: &str) -> Result<(), String> {
    let f = settings_dir()?.join("active-vault");
    atomic_write(&f, path.as_bytes()).map_err(|e| format!("write active-vault: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Serialise tests that mutate the data dir env var.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn with_isolated_data<F: FnOnce(&PathBuf)>(name: &str, f: F) {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir =
            std::env::temp_dir().join(format!("memex-settings-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let prev = std::env::var("MEMEX_DATA_DIR").ok();
        unsafe {
            std::env::set_var("MEMEX_DATA_DIR", &dir);
        }
        f(&dir);
        if let Some(v) = prev {
            unsafe {
                std::env::set_var("MEMEX_DATA_DIR", v);
            }
        } else {
            unsafe {
                std::env::remove_var("MEMEX_DATA_DIR");
            }
        }
    }

    #[test]
    fn defaults_use_claude_cli() {
        let s = Settings::default();
        assert_eq!(s.query_provider, "anthropic-cli");
        assert_eq!(s.ingest_provider, "anthropic-cli");
        assert!(s.providers.anthropic_cli); // primary path stays on
        assert!(!s.providers.gemini_cli);
        assert!(!s.providers.codex_cli);
        assert!(!s.providers.anthropic_api);
        assert!(!s.providers.openai_api);
        assert!(!s.providers.google_api);
        assert!(!s.providers.ollama);
        assert!(!s.providers.openrouter);
    }

    #[test]
    fn legacy_settings_json_keeps_claude_cli_enabled() {
        with_isolated_data("legacy-flags", |dir| {
            // Pre-CLI-flags settings.json — anthropic_cli absent must
            // default to true so upgrades don't break the working setup.
            std::fs::write(
                dir.join("settings.json"),
                r#"{ "providers": { "ollama": true } }"#,
            )
            .unwrap();
            let s = load();
            assert!(s.providers.anthropic_cli);
            assert!(!s.providers.gemini_cli);
            assert!(s.providers.ollama);
        });
    }

    #[test]
    fn load_returns_default_when_missing() {
        with_isolated_data("load-missing", |_dir| {
            let s = load();
            assert_eq!(s.query_provider, "anthropic-cli");
        });
    }

    #[test]
    fn save_then_load_roundtrips() {
        with_isolated_data("roundtrip", |dir| {
            let s = Settings {
                query_provider: "openai-api".into(),
                query_model: "gpt-4o-mini".into(),
                providers: ProviderFlags {
                    openai_api: true,
                    ..ProviderFlags::default()
                },
                ..Settings::default()
            };
            save(&s).unwrap();
            // The atomic write must land the real file (not just a leftover
            // temp) at the target path before returning.
            assert!(dir.join("settings.json").exists());
            let back = load();
            assert_eq!(back.query_provider, "openai-api");
            assert_eq!(back.query_model, "gpt-4o-mini");
            assert!(back.providers.openai_api);
        });
    }

    #[test]
    fn save_replaces_atomically_leaving_no_temp_files() {
        with_isolated_data("atomic", |dir| {
            // Save twice; the second save must overwrite the first in place via
            // rename, and the staging temp file must not be left behind.
            save(&Settings::default()).unwrap();
            let s = Settings {
                query_provider: "ollama".into(),
                ..Settings::default()
            };
            save(&s).unwrap();

            assert_eq!(load().query_provider, "ollama");

            let leftovers: Vec<_> = std::fs::read_dir(dir)
                .unwrap()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_name().to_string_lossy().starts_with(".memex-tmp-"))
                .collect();
            assert!(
                leftovers.is_empty(),
                "atomic write left a temp file behind: {leftovers:?}"
            );
        });
    }

    #[test]
    fn set_active_vault_writes_marker_durably() {
        with_isolated_data("active-vault", |dir| {
            set_active_vault("/some/vault/path").unwrap();
            let marker = dir.join("active-vault");
            assert!(marker.exists());
            assert_eq!(
                std::fs::read_to_string(&marker).unwrap(),
                "/some/vault/path"
            );
            // Overwriting an existing marker must replace it cleanly.
            set_active_vault("/another/vault").unwrap();
            assert_eq!(std::fs::read_to_string(&marker).unwrap(), "/another/vault");
        });
    }

    #[test]
    fn load_tolerates_partial_json() {
        with_isolated_data("partial", |dir| {
            // Write a stub with only some fields — defaults should fill the rest.
            std::fs::write(
                dir.join("settings.json"),
                r#"{ "providers": { "ollama": true } }"#,
            )
            .unwrap();
            let s = load();
            assert!(s.providers.ollama);
            assert_eq!(s.query_provider, "anthropic-cli"); // default
        });
    }
}
