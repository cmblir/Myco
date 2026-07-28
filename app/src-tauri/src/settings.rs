// Persisted user settings — written to ~/Library/Application Support/dev.cmblir.myco/
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
    /// While the app is open, re-embed changed pages once the vault has been
    /// quiet for a moment, so semantic search / related notes / graph similarity
    /// edges keep describing the vault as it is. Maintains an existing index
    /// only — the first build stays a deliberate action in Settings, since it
    /// loads the bundled model and embeds every page.
    #[serde(default)]
    pub auto_reindex_enabled: bool,
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
            auto_reindex_enabled: false,
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

// ---- app-data directory (M1: memex → myco) -------------------------------
//
// The per-platform directory names. `LEGACY_DIR_NAMES` is what installs made
// before the myco rename wrote to, and is only ever read for the one-time move
// below. NOTE: `mcp-server/project_registry.py::_app_data_dir()` is a hand-
// copied mirror of this resolution (the stdio MCP server reads the
// `active-vault` marker the app writes here). Any change to the names, the env
// overrides, or the migration rule MUST be made in both places, or the MCP
// server silently stops following the app's vault.
struct DirNames {
    macos: &'static str,
    windows: &'static str,
    linux: &'static str,
}

const DIR_NAMES: DirNames = DirNames {
    macos: "dev.cmblir.myco",
    windows: "myco",
    linux: "myco",
};

const LEGACY_DIR_NAMES: DirNames = DirNames {
    macos: "dev.cmblir.memex",
    windows: "Memex",
    linux: "memex",
};

/// Resolve the data dir for a given OS name (`std::env::consts::OS` values), so
/// all three platform layouts stay unit-testable from any one of them.
fn data_dir_on(
    os: &str,
    home: Option<&std::ffi::OsStr>,
    appdata: Option<&std::ffi::OsStr>,
    names: &DirNames,
) -> Result<PathBuf, String> {
    match os {
        "macos" => {
            let home = home.ok_or_else(|| "no HOME".to_string())?;
            Ok(PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join(names.macos))
        }
        "windows" => {
            let appdata = appdata.ok_or_else(|| "no APPDATA".to_string())?;
            Ok(PathBuf::from(appdata).join(names.windows))
        }
        _ => {
            let home = home.ok_or_else(|| "no HOME".to_string())?;
            Ok(PathBuf::from(home).join(".config").join(names.linux))
        }
    }
}

/// Explicit override, preferring the new spelling. `MEMEX_DATA_DIR` is still
/// honoured (unchanged behaviour) so existing scripts and dev setups that
/// export the old name keep working.
fn data_dir_override() -> Option<PathBuf> {
    std::env::var_os("MYCO_DATA_DIR")
        .or_else(|| std::env::var_os("MEMEX_DATA_DIR"))
        .map(PathBuf::from)
}

/// One-time move of the pre-rename data dir onto the new path. Returns the
/// directory that should actually be used.
///
/// Rules, in order of importance:
///  - If the new dir already exists, the migration has already run (or the user
///    is a fresh install): never touch the old dir again. This is what makes a
///    second launch a no-op.
///  - If the old dir is absent there is nothing to move.
///  - If the move FAILS (cross-device rename, permissions, a racing process),
///    we return the OLD directory and keep using it. Silently starting from an
///    empty new dir would strand the user's settings.json, active-vault marker,
///    mcp-token and embeddings/ indexes — losing that state is far worse than
///    running under the old path name forever.
fn migrate_data_dir(old: &std::path::Path, new: &std::path::Path) -> PathBuf {
    if new.exists() || !old.exists() {
        return new.to_path_buf();
    }
    // The parent must exist for the rename (e.g. ~/.config on Linux). Best
    // effort: a failure here just falls through to the rename's own error.
    if let Some(parent) = new.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::rename(old, new) {
        Ok(()) => new.to_path_buf(),
        Err(e) => {
            // A concurrent process (e.g. the bundled MCP server, which mirrors
            // this rule) may have won the race and already moved it.
            if new.exists() {
                return new.to_path_buf();
            }
            eprintln!(
                "data dir migration failed ({} -> {}): {e}; continuing to use the old directory",
                old.display(),
                new.display()
            );
            old.to_path_buf()
        }
    }
}

pub fn settings_dir() -> Result<PathBuf, String> {
    let base = match data_dir_override() {
        // An explicit override names the directory to use verbatim — no
        // migration, since the operator has already said where the data lives.
        Some(p) => p,
        None => {
            let os = std::env::consts::OS;
            let home = std::env::var_os("HOME");
            let appdata = std::env::var_os("APPDATA");
            let new = data_dir_on(os, home.as_deref(), appdata.as_deref(), &DIR_NAMES)?;
            let old = data_dir_on(os, home.as_deref(), appdata.as_deref(), &LEGACY_DIR_NAMES)?;
            migrate_data_dir(&old, &new)
        }
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

/// Read the persisted active-vault marker (None if never set / unreadable).
/// Used by the deep-link clip handler when a clip arrives before any vault
/// has been opened in this app session.
pub fn active_vault() -> Option<String> {
    let f = settings_dir().ok()?.join("active-vault");
    let raw = std::fs::read_to_string(f).ok()?;
    let t = raw.trim();
    if t.is_empty() { None } else { Some(t.to_string()) }
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
        let prev_myco = std::env::var("MYCO_DATA_DIR").ok();
        let prev_memex = std::env::var("MEMEX_DATA_DIR").ok();
        unsafe {
            std::env::set_var("MYCO_DATA_DIR", &dir);
            std::env::remove_var("MEMEX_DATA_DIR");
        }
        f(&dir);
        unsafe {
            restore_var("MYCO_DATA_DIR", prev_myco);
            restore_var("MEMEX_DATA_DIR", prev_memex);
        }
    }

    unsafe fn restore_var(name: &str, prev: Option<String>) {
        unsafe {
            match prev {
                Some(v) => std::env::set_var(name, v),
                None => std::env::remove_var(name),
            }
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("myco-m1-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
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

    // ---- M1: data-dir naming, env overrides, one-time migration ----------

    fn os_str(s: &str) -> std::ffi::OsString {
        std::ffi::OsString::from(s)
    }

    #[test]
    fn data_dir_names_per_platform() {
        let home = os_str("/home/u");
        let appdata = os_str("C:\\Users\\u\\AppData\\Roaming");
        assert_eq!(
            data_dir_on("macos", Some(&home), None, &DIR_NAMES).unwrap(),
            PathBuf::from("/home/u/Library/Application Support/dev.cmblir.myco")
        );
        assert_eq!(
            data_dir_on("windows", None, Some(&appdata), &DIR_NAMES).unwrap(),
            PathBuf::from("C:\\Users\\u\\AppData\\Roaming").join("myco")
        );
        assert_eq!(
            data_dir_on("linux", Some(&home), None, &DIR_NAMES).unwrap(),
            PathBuf::from("/home/u/.config/myco")
        );
    }

    #[test]
    fn legacy_data_dir_names_per_platform() {
        // The migration source must keep naming the pre-rename directories
        // exactly, or an upgrading user's state is never found.
        let home = os_str("/home/u");
        let appdata = os_str("C:\\Users\\u\\AppData\\Roaming");
        assert_eq!(
            data_dir_on("macos", Some(&home), None, &LEGACY_DIR_NAMES).unwrap(),
            PathBuf::from("/home/u/Library/Application Support/dev.cmblir.memex")
        );
        assert_eq!(
            data_dir_on("windows", None, Some(&appdata), &LEGACY_DIR_NAMES).unwrap(),
            PathBuf::from("C:\\Users\\u\\AppData\\Roaming").join("Memex")
        );
        assert_eq!(
            data_dir_on("linux", Some(&home), None, &LEGACY_DIR_NAMES).unwrap(),
            PathBuf::from("/home/u/.config/memex")
        );
    }

    #[test]
    fn data_dir_reports_missing_env() {
        assert!(data_dir_on("macos", None, None, &DIR_NAMES).is_err());
        assert!(data_dir_on("windows", None, None, &DIR_NAMES).is_err());
        assert!(data_dir_on("linux", None, None, &DIR_NAMES).is_err());
    }

    #[test]
    fn override_prefers_myco_but_accepts_memex() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev_myco = std::env::var("MYCO_DATA_DIR").ok();
        let prev_memex = std::env::var("MEMEX_DATA_DIR").ok();

        unsafe {
            std::env::set_var("MYCO_DATA_DIR", "/tmp/new-spelling");
            std::env::set_var("MEMEX_DATA_DIR", "/tmp/old-spelling");
        }
        assert_eq!(data_dir_override(), Some(PathBuf::from("/tmp/new-spelling")));

        // Old spelling alone still works — dev setups and scripts export it.
        unsafe {
            std::env::remove_var("MYCO_DATA_DIR");
        }
        assert_eq!(data_dir_override(), Some(PathBuf::from("/tmp/old-spelling")));

        unsafe {
            std::env::remove_var("MEMEX_DATA_DIR");
        }
        assert_eq!(data_dir_override(), None);

        unsafe {
            restore_var("MYCO_DATA_DIR", prev_myco);
            restore_var("MEMEX_DATA_DIR", prev_memex);
        }
    }

    #[test]
    fn migration_moves_old_dir_once_and_is_idempotent() {
        let base = temp_dir("move");
        let old = base.join("old");
        let new = base.join("new");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("settings.json"), "{}").unwrap();
        std::fs::write(old.join("mcp-token"), "tok").unwrap();

        assert_eq!(migrate_data_dir(&old, &new), new);
        assert!(!old.exists(), "old dir must be gone after the move");
        assert_eq!(
            std::fs::read_to_string(new.join("mcp-token")).unwrap(),
            "tok"
        );

        // Second run: nothing left to do, and it must not recreate//touch old.
        assert_eq!(migrate_data_dir(&old, &new), new);
        assert!(!old.exists());
        assert_eq!(
            std::fs::read_to_string(new.join("settings.json")).unwrap(),
            "{}"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn migration_skips_when_new_dir_already_exists() {
        // A user who already migrated (or re-created state under the new name)
        // must keep the NEW state; the old dir is left untouched, never merged.
        let base = temp_dir("both");
        let old = base.join("old");
        let new = base.join("new");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(old.join("settings.json"), "OLD").unwrap();
        std::fs::write(new.join("settings.json"), "NEW").unwrap();

        assert_eq!(migrate_data_dir(&old, &new), new);
        assert_eq!(
            std::fs::read_to_string(new.join("settings.json")).unwrap(),
            "NEW"
        );
        assert_eq!(
            std::fs::read_to_string(old.join("settings.json")).unwrap(),
            "OLD",
            "old dir must be left intact as a fallback copy"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn migration_is_noop_for_fresh_install() {
        let base = temp_dir("fresh");
        let old = base.join("old");
        let new = base.join("new");
        assert_eq!(migrate_data_dir(&old, &new), new);
        assert!(!old.exists());
        assert!(!new.exists(), "migration must not create the dir itself");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn migration_falls_back_to_old_dir_when_move_fails() {
        // Simulate an unmovable old dir by making the new path's parent a FILE,
        // so rename() cannot succeed. Losing settings/keys/indexes is worse than
        // staying on the old path, so the old dir must be returned.
        let base = temp_dir("fallback");
        let old = base.join("old");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("settings.json"), "OLD").unwrap();
        let blocker = base.join("blocker");
        std::fs::write(&blocker, "not a dir").unwrap();
        let new = blocker.join("new");

        assert_eq!(migrate_data_dir(&old, &new), old);
        assert_eq!(
            std::fs::read_to_string(old.join("settings.json")).unwrap(),
            "OLD"
        );
        let _ = std::fs::remove_dir_all(&base);
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
