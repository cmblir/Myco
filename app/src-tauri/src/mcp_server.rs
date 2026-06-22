// memex MCP server registration helpers. The MCP server itself
// (mcp-server/memex_mcp.py) is stdio and unchanged; this module makes it easy
// to register with local Claude clients from the app.
//
// The server scripts are BUNDLED into the app (Tauri resources), so they are
// found regardless of where the user's vault lives (the old "walk up from the
// vault" scheme failed whenever the vault sat outside the source repo — e.g.
// the default ~/Documents/Memex). Because the bundled script is read-only and
// no longer sits next to the vault, two things follow:
//   - the Python venv is created in the writable app-data dir, not in resources;
//   - the registration passes the vault path via the MEMEX_PROJECT_ROOT env var,
//     which memex_mcp.py / project_registry.py read to locate the vault data.

use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, serde::Serialize)]
pub struct McpRegInfo {
    /// The bundled mcp-server/memex_mcp.py exists in the app resources.
    pub found: bool,
    /// The app-data venv python exists (Install has been run).
    pub installed: bool,
    pub python: Option<String>,
    pub script: Option<String>,
    /// `claude mcp add --scope user memex --env MEMEX_PROJECT_ROOT=… -- "<py>" "<script>"`.
    pub command: Option<String>,
    /// JSON snippet for claude_desktop_config.json.
    pub desktop_json: Option<String>,
}

struct Paths {
    script: PathBuf,
    requirements: PathBuf,
    venv_dir: PathBuf,
    python: PathBuf,
}

/// Bundled script (read-only resources) + the writable app-data venv.
fn paths(app: &AppHandle) -> Option<Paths> {
    let res = app.path().resource_dir().ok()?;
    let venv_dir = app.path().app_data_dir().ok()?.join("mcp-venv");
    let python = venv_dir.join(if cfg!(windows) {
        "Scripts/python.exe"
    } else {
        "bin/python"
    });
    Some(Paths {
        script: res.join("mcp-server/memex_mcp.py"),
        requirements: res.join("mcp-server/requirements.txt"),
        venv_dir,
        python,
    })
}

/// (major, minor) of the interpreter at `path`, parsed from `--version`.
/// `python --version` prints "Python 3.12.7" (to stdout on 3.4+, stderr on 2.x).
fn py_minor(path: &str) -> Option<(u32, u32)> {
    let out = Command::new(path).arg("--version").output().ok()?;
    let s = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let ver = s.split_whitespace().find(|t| {
        t.split('.')
            .next()
            .and_then(|a| a.parse::<u32>().ok())
            .is_some()
    })?;
    let mut it = ver.split('.');
    let major = it.next()?.parse::<u32>().ok()?;
    let minor = it.next()?.parse::<u32>().ok()?;
    Some((major, minor))
}

fn is_310_plus(path: &str) -> bool {
    py_minor(path).is_some_and(|(a, b)| a > 3 || (a == 3 && b >= 10))
}

/// A >=3.10 interpreter is not enough: it must also be able to bootstrap pip in
/// a venv. Some Homebrew pythons are broken (e.g. a libexpat mismatch makes
/// `pyexpat` fail to load, which breaks ensurepip → no pip in the venv). Probe
/// the exact modules that bootstrap needs so we skip such interpreters.
fn python_usable(path: &str) -> bool {
    if !is_310_plus(path) {
        return false;
    }
    Command::new(path)
        .args(["-c", "import pyexpat, ensurepip"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Locate a Python >= 3.10 (required by the `mcp` package). GUI apps launched
/// from Finder get launchd's minimal PATH, so the default `python3` is usually
/// /usr/bin/python3 (3.9 on older macOS) — too old. We probe version-specific
/// names first (Homebrew installs python3.1x), each resolved via the same
/// PATH/login-shell logic as the other CLIs, and verify the reported version.
fn find_python_310() -> Option<String> {
    if let Ok(p) = std::env::var("MEMEX_PYTHON_PATH") {
        if !p.is_empty() && python_usable(&p) {
            return Some(p);
        }
    }
    for name in [
        "python3.13",
        "python3.12",
        "python3.11",
        "python3.10",
        "python3",
        "python",
    ] {
        // Pass an unset env var so locate_bin skips the override and does its
        // which / well-known-dir / login-shell search for this exact name.
        if let Some(path) = crate::claude::locate_bin(name, "MEMEX_PYTHON_PATH_UNUSED") {
            if python_usable(&path) {
                return Some(path);
            }
        }
    }
    None
}

fn not_found() -> McpRegInfo {
    McpRegInfo {
        found: false,
        installed: false,
        python: None,
        script: None,
        command: None,
        desktop_json: None,
    }
}

fn desktop_json(python: &str, script: &str, vault: &str) -> String {
    // Build via serde_json so a path containing a quote or backslash is escaped
    // correctly instead of producing malformed JSON the user would paste.
    let value = serde_json::json!({
        "mcpServers": {
            "memex": {
                "command": python,
                "args": [script],
                "env": { "MEMEX_PROJECT_ROOT": vault }
            }
        }
    });
    serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_string())
}

/// Registration info for exposing `vault_path` via the bundled MCP server.
pub fn registration_info(app: &AppHandle, vault_path: &str) -> McpRegInfo {
    let Some(p) = paths(app) else {
        return not_found();
    };
    if !p.script.is_file() {
        return not_found(); // bundle is missing the server (build problem)
    }
    let installed = p.python.is_file();
    let py = p.python.to_string_lossy().into_owned();
    let sc = p.script.to_string_lossy().into_owned();
    let command = format!(
        "claude mcp add --scope user memex --env MEMEX_PROJECT_ROOT=\"{vault_path}\" -- \"{py}\" \"{sc}\""
    );
    McpRegInfo {
        found: true,
        installed,
        desktop_json: Some(desktop_json(&py, &sc, vault_path)),
        python: Some(py),
        script: Some(sc),
        command: Some(command),
    }
}

/// Create the app-data venv and install the MCP server's deps. Blocking.
pub fn install(app: &AppHandle) -> Result<String, String> {
    let p = paths(app).ok_or("could not resolve app resource/data dirs")?;
    if !p.script.is_file() {
        return Err("bundled mcp-server is missing from the app resources".into());
    }
    if let Some(parent) = p.venv_dir.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create app-data dir: {e}"))?;
    }
    let py3 = find_python_310().ok_or(
        "Python 3.10+ is required (the mcp package needs it) but none was found. \
         Install it (e.g. `brew install python`) or set MEMEX_PYTHON_PATH.",
    )?;
    // 1) create the venv in the writable app-data dir.
    let out = Command::new(&py3)
        .arg("-m")
        .arg("venv")
        .arg(&p.venv_dir)
        .env("PATH", crate::claude::augmented_path(&py3))
        .output()
        .map_err(|e| format!("spawn python venv failed: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "venv creation failed:\n{}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    // 2) install requirements into the venv (best-effort pip upgrade first).
    let _ = Command::new(&p.python)
        .args(["-m", "pip", "install", "--upgrade", "pip"])
        .output();
    let out = Command::new(&p.python)
        .args(["-m", "pip", "install", "-r"])
        .arg(&p.requirements)
        .output()
        .map_err(|e| format!("spawn pip failed: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "pip install failed:\n{}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok("MCP server installed.".to_string())
}

/// Run `claude mcp add …` (user scope) for `vault_path`. Requires the claude CLI.
pub fn register(app: &AppHandle, vault_path: &str) -> Result<String, String> {
    let info = registration_info(app, vault_path);
    if !info.installed {
        return Err("MCP server not installed yet — run Install first".into());
    }
    let (py, sc) = (info.python.unwrap(), info.script.unwrap());
    let claude = crate::claude::locate_bin("claude", "MEMEX_CLAUDE_PATH")
        .ok_or("claude CLI not found on PATH")?;
    let out = Command::new(&claude)
        .args(["mcp", "add", "--scope", "user", "memex", "--env"])
        .arg(format!("MEMEX_PROJECT_ROOT={vault_path}"))
        .arg("--")
        .arg(&py)
        .arg(&sc)
        .env("PATH", crate::claude::augmented_path(&claude))
        .output()
        .map_err(|e| format!("spawn claude failed: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "claude mcp add failed:\n{}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_json_embeds_paths_and_vault_env() {
        let j = desktop_json(
            "/v/bin/python",
            "/r/mcp-server/memex_mcp.py",
            "/Users/me/Vault",
        );
        assert!(j.contains("\"command\": \"/v/bin/python\""));
        assert!(j.contains("/r/mcp-server/memex_mcp.py"));
        assert!(j.contains("\"MEMEX_PROJECT_ROOT\": \"/Users/me/Vault\""));
    }
}
