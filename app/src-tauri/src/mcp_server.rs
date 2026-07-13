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
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// The app hosts ONE long-running SSE server for its lifetime (Obsidian style):
/// started on launch, stopped on quit, and restarted on a vault switch so it
/// re-resolves the active vault (memex_mcp resolves PROJECT_ROOT once at import).
static SSE_CHILD: Mutex<Option<Child>> = Mutex::new(None);

/// SSE bind port. Fixed to match the documented `claude mcp add --transport sse
/// memex http://localhost:22360/sse`; overridable for dev via MEMEX_MCP_PORT.
fn sse_port() -> u16 {
    std::env::var("MEMEX_MCP_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(22360)
}

pub fn sse_url() -> String {
    format!("http://localhost:{}/sse", sse_port())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct McpRegInfo {
    /// The bundled mcp-server/memex_mcp.py exists in the app resources.
    pub found: bool,
    /// The app-data venv python exists (Install has been run).
    pub installed: bool,
    /// The app-hosted SSE server is currently running.
    pub serving: bool,
    /// The SSE URL clients connect to (http://localhost:<port>/sse).
    pub url: Option<String>,
    pub python: Option<String>,
    pub script: Option<String>,
    /// `claude mcp add --transport sse memex http://localhost:22360/sse`.
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
        serving: false,
        url: None,
        python: None,
        script: None,
        command: None,
        desktop_json: None,
    }
}

/// claude_desktop_config.json snippet — a plain URL connector to the SSE server
/// (works for Claude Desktop AND claude.ai, unlike a local stdio command).
fn desktop_json(url: &str) -> String {
    let value = serde_json::json!({
        "mcpServers": { "memex": { "url": url } }
    });
    serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_string())
}

/// Registration info. The MCP server is now an app-hosted SSE server, so the
/// registration is a single URL line independent of the vault path — the
/// running server follows the app's active vault (and the app restarts it on a
/// vault switch). `vault_path` is accepted for call-signature stability.
pub fn registration_info(app: &AppHandle, _vault_path: &str) -> McpRegInfo {
    let Some(p) = paths(app) else {
        return not_found();
    };
    if !p.script.is_file() {
        return not_found(); // bundle is missing the server (build problem)
    }
    let installed = p.python.is_file();
    let url = sse_url();
    let command = format!("claude mcp add --transport sse memex {url}");
    McpRegInfo {
        found: true,
        installed,
        serving: is_serving(),
        desktop_json: Some(desktop_json(&url)),
        url: Some(url),
        python: Some(p.python.to_string_lossy().into_owned()),
        script: Some(p.script.to_string_lossy().into_owned()),
        command: Some(command),
    }
}

/// True when the app-hosted SSE child is alive.
pub fn is_serving() -> bool {
    let mut guard = SSE_CHILD.lock().unwrap();
    match guard.as_mut() {
        Some(ch) => match ch.try_wait() {
            Ok(None) => true,          // still running
            _ => {
                *guard = None; // exited or errored — clear the slot
                false
            }
        },
        None => false,
    }
}

/// Start the SSE server if it isn't already running. Idempotent. Requires that
/// Install has created the venv. The running server resolves the vault from the
/// active-vault marker the app maintains.
pub fn serve(app: &AppHandle) -> Result<String, String> {
    if is_serving() {
        return Ok(sse_url());
    }
    let p = paths(app).ok_or("could not resolve app resource/data dirs")?;
    if !p.script.is_file() {
        return Err("bundled mcp-server is missing from the app resources".into());
    }
    if !p.python.is_file() {
        return Err("MCP server not installed yet — run Install first".into());
    }
    let py = p.python.to_string_lossy().into_owned();
    let child = Command::new(&p.python)
        .arg(&p.script)
        .arg("--sse")
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(sse_port().to_string())
        .env("PATH", crate::claude::augmented_path(&py))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("spawn SSE server failed: {e}"))?;
    *SSE_CHILD.lock().unwrap() = Some(child);
    Ok(sse_url())
}

/// Kill the SSE server if running (called on quit and before a restart).
pub fn stop_sse() {
    if let Some(mut ch) = SSE_CHILD.lock().unwrap().take() {
        let _ = ch.kill();
        let _ = ch.wait();
    }
}

/// Restart the server so it re-resolves the (now different) active vault. No-op
/// when the server isn't running — the next start picks up the new vault anyway.
pub fn restart_if_serving(app: &AppHandle) {
    if is_serving() {
        stop_sse();
        let _ = serve(app);
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

/// Register the app-hosted SSE server with Claude Code (user scope). Ensures the
/// server is running, then `claude mcp add --transport sse memex <url>` (after a
/// best-effort remove so a re-register doesn't collide with a stale entry).
pub fn register(app: &AppHandle, _vault_path: &str) -> Result<String, String> {
    if !registration_info(app, "").installed {
        return Err("MCP server not installed yet — run Install first".into());
    }
    serve(app)?; // a URL connector is useless if nothing is listening
    let url = sse_url();
    let claude = crate::claude::locate_bin("claude", "MEMEX_CLAUDE_PATH")
        .ok_or("claude CLI not found on PATH")?;
    let path = crate::claude::augmented_path(&claude);
    // Best-effort remove first — `claude mcp add` errors if `memex` already
    // exists (e.g. a previous stdio registration), which would otherwise make
    // Register fail on every run after the first.
    let _ = Command::new(&claude)
        .args(["mcp", "remove", "memex"])
        .env("PATH", &path)
        .output();
    let out = Command::new(&claude)
        .args(["mcp", "add", "--transport", "sse", "memex", &url])
        .env("PATH", &path)
        .output()
        .map_err(|e| format!("spawn claude failed: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "claude mcp add failed:\n{}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(format!("Registered memex over SSE at {url}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_json_is_a_url_connector() {
        let j = desktop_json("http://localhost:22360/sse");
        let parsed: serde_json::Value = serde_json::from_str(&j).expect("must be valid JSON");
        assert_eq!(
            parsed["mcpServers"]["memex"]["url"],
            "http://localhost:22360/sse"
        );
        // No stdio command/args/env in the SSE connector form.
        assert!(parsed["mcpServers"]["memex"]["command"].is_null());
    }

    #[test]
    fn sse_url_uses_the_configured_port() {
        assert_eq!(sse_url(), format!("http://localhost:{}/sse", sse_port()));
    }

    #[test]
    fn py_minor_parses_a_present_interpreter() {
        // py_minor spawns `<path> --version` and parses "Python 3.x.y". We can't
        // assume a specific interpreter exists on every host, so we probe common
        // names and only assert the PARSE result when one is found: a real
        // python3 must report major==3. Absence is fine (None) — nothing to
        // mis-parse — so the test never flakes on a python-less host.
        for name in ["python3", "python3.13", "python3.12", "python3.11", "python3.10"] {
            if let Some((major, minor)) = py_minor(name) {
                assert_eq!(major, 3, "{name} reported an unexpected major version");
                // is_310_plus must agree with the raw (major, minor) it parses.
                assert_eq!(
                    is_310_plus(name),
                    major > 3 || (major == 3 && minor >= 10),
                    "{name}: is_310_plus disagrees with parsed version {major}.{minor}"
                );
                return;
            }
        }
        // No python on this host: py_minor correctly returned None throughout.
    }
}
