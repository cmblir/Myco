# One-Click memex MCP Registration (stdio) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Settings "MCP Server" panel that installs the Python MCP server's venv and shows the exact `claude mcp add memex -- …` command + Claude Desktop config for this machine, so the existing stdio `memex` MCP server is trivial to register with Claude Code / Desktop.

**Architecture:** No app-hosted server and no change to `memex_mcp.py` (it stays stdio). A new Rust module `mcp_server.rs` resolves the repo root from the current vault path, derives the venv-python + script paths, builds the registration command + Desktop JSON, and can run `install.sh` / `claude mcp add`. Three Tauri IPC commands expose this to a new React Settings tab.

**Tech Stack:** Rust (Tauri 2), React + TypeScript, existing `claude.rs` helpers (`locate_bin`, `augmented_path`), `navigator.clipboard` for copy.

---

## File Structure

- **Create** `app/src-tauri/src/mcp_server.rs` — repo-root resolution, registration-info assembly, `install`, `register`. Pure logic + thin subprocess wrappers. Unit-tested.
- **Modify** `app/src-tauri/src/lib.rs` — declare `pub mod mcp_server;`, register 3 IPC handlers.
- **Modify** `app/src-tauri/src/commands.rs` — 3 thin `#[tauri::command]` adapters.
- **Modify** `app/src/lib/ipc.ts` — `McpRegInfo` type + 3 wrappers.
- **Modify** `app/src/lib/i18n.ts` — MCP strings in `Strings` interface + en/ko/ja.
- **Modify** `app/src/pages/PageSettings.tsx` — add `"mcp"` tab + `SettingsMcp` component.

---

## Task 1: Rust `mcp_server.rs` — path resolution + registration info (TDD)

**Files:**
- Create: `app/src-tauri/src/mcp_server.rs`
- Modify: `app/src-tauri/src/lib.rs:5` (module declaration only, this task)

- [ ] **Step 1: Declare the module so tests compile**

In `app/src-tauri/src/lib.rs`, add after line `pub mod cli_agent;`:

```rust
pub mod mcp_server;
```

- [ ] **Step 2: Write the module with failing tests first**

Create `app/src-tauri/src/mcp_server.rs`:

```rust
// memex MCP server registration helpers. The MCP server itself
// (mcp-server/memex_mcp.py) is stdio and unchanged; this module makes it easy
// to register with local Claude clients from the app: it resolves the repo
// root from the current vault, derives the venv python + script paths, builds
// the `claude mcp add` command and the Claude Desktop config JSON, and can run
// install.sh / `claude mcp add` on request. Nothing here hosts a server.

use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, serde::Serialize)]
pub struct McpRegInfo {
    /// mcp-server/memex_mcp.py was located by walking up from the vault.
    pub found: bool,
    /// Both the venv python and the script exist (install.sh has been run).
    pub installed: bool,
    pub python: Option<String>,
    pub script: Option<String>,
    /// `claude mcp add --scope user memex -- "<python>" "<script>"`.
    pub command: Option<String>,
    /// JSON snippet for claude_desktop_config.json.
    pub desktop_json: Option<String>,
}

/// Walk up from `vault_path` until a directory contains
/// `mcp-server/memex_mcp.py`; that directory is the repo root.
fn find_repo_root(vault_path: &str) -> Option<PathBuf> {
    let mut dir: &Path = Path::new(vault_path);
    loop {
        if dir.join("mcp-server/memex_mcp.py").is_file() {
            return Some(dir.to_path_buf());
        }
        dir = dir.parent()?;
    }
}

fn desktop_json(python: &str, script: &str) -> String {
    format!(
        "{{\n  \"mcpServers\": {{\n    \"memex\": {{\n      \"command\": \"{python}\",\n      \"args\": [\"{script}\"]\n    }}\n  }}\n}}"
    )
}

/// Assemble registration info for the repo that owns `vault_path`.
pub fn registration_info(vault_path: &str) -> McpRegInfo {
    let Some(root) = find_repo_root(vault_path) else {
        return McpRegInfo {
            found: false,
            installed: false,
            python: None,
            script: None,
            command: None,
            desktop_json: None,
        };
    };
    let script = root.join("mcp-server/memex_mcp.py");
    let python = root.join("mcp-server/.venv/bin/python");
    let installed = script.is_file() && python.is_file();
    let py = python.to_string_lossy().into_owned();
    let sc = script.to_string_lossy().into_owned();
    let command = format!("claude mcp add --scope user memex -- \"{py}\" \"{sc}\"");
    McpRegInfo {
        found: true,
        installed,
        desktop_json: Some(desktop_json(&py, &sc)),
        python: Some(py),
        script: Some(sc),
        command: Some(command),
    }
}

/// Run mcp-server/install.sh (creates the venv + installs deps). Blocking.
pub fn install(vault_path: &str) -> Result<String, String> {
    let root = find_repo_root(vault_path).ok_or("mcp-server/ not found near vault")?;
    let script = root.join("mcp-server/install.sh");
    if !script.is_file() {
        return Err(format!("install.sh not found at {}", script.display()));
    }
    let py = crate::claude::locate_bin("python3", "MEMEX_PYTHON_PATH")
        .ok_or("python3 not found on PATH")?;
    let out = Command::new("bash")
        .arg(&script)
        .current_dir(&root)
        .env("PYTHON", &py)
        .env("PATH", crate::claude::augmented_path(&py))
        .output()
        .map_err(|e| format!("spawn bash failed: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "install.sh failed (exit {}):\n{}",
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Run `claude mcp add …` for the user. Requires the claude CLI. Blocking.
pub fn register(vault_path: &str) -> Result<String, String> {
    let info = registration_info(vault_path);
    if !info.installed {
        return Err("MCP server not installed yet — run Install first".into());
    }
    let (py, sc) = (info.python.unwrap(), info.script.unwrap());
    let claude = crate::claude::locate_bin("claude", "MEMEX_CLAUDE_PATH")
        .ok_or("claude CLI not found on PATH")?;
    let out = Command::new(&claude)
        .args(["mcp", "add", "--scope", "user", "memex", "--", &py, &sc])
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
    fn find_repo_root_ascends_to_mcp_server_dir() {
        let base = std::env::temp_dir().join("memex-mcp-test-root");
        let _ = std::fs::remove_dir_all(&base);
        let mcp = base.join("mcp-server");
        std::fs::create_dir_all(&mcp).unwrap();
        std::fs::write(mcp.join("memex_mcp.py"), "# stub").unwrap();
        let nested = base.join("projects").join("p").join("wiki");
        std::fs::create_dir_all(&nested).unwrap();
        assert_eq!(find_repo_root(nested.to_str().unwrap()), Some(base.clone()));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn registration_info_not_found_without_mcp_server() {
        let base = std::env::temp_dir().join("memex-mcp-test-none");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let info = registration_info(base.to_str().unwrap());
        assert!(!info.found);
        assert!(!info.installed);
        assert!(info.command.is_none());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn registration_info_builds_command_and_detects_venv() {
        let base = std::env::temp_dir().join("memex-mcp-test-info");
        let _ = std::fs::remove_dir_all(&base);
        let bin = base.join("mcp-server").join(".venv").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(base.join("mcp-server").join("memex_mcp.py"), "# stub").unwrap();
        // venv python absent → found but not installed
        let info = registration_info(base.to_str().unwrap());
        assert!(info.found);
        assert!(!info.installed);
        let cmd = info.command.clone().unwrap();
        assert!(cmd.contains("claude mcp add --scope user memex --"));
        assert!(cmd.contains("mcp-server/memex_mcp.py"));
        // create the venv python → installed
        std::fs::write(bin.join("python"), "#!/bin/sh\n").unwrap();
        assert!(registration_info(base.to_str().unwrap()).installed);
        let _ = std::fs::remove_dir_all(&base);
    }
}
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `cd app/src-tauri && cargo test mcp_server -- --nocapture`
Expected: PASS — `find_repo_root_ascends_to_mcp_server_dir`, `registration_info_not_found_without_mcp_server`, `registration_info_builds_command_and_detects_venv` (3 passed).

- [ ] **Step 4: Commit**

```bash
git add app/src-tauri/src/mcp_server.rs app/src-tauri/src/lib.rs
git commit -m "feat(memex): mcp_server module — registration info + install/register helpers"
```

---

## Task 2: Tauri IPC commands

**Files:**
- Modify: `app/src-tauri/src/commands.rs` (add import + 3 commands)
- Modify: `app/src-tauri/src/lib.rs` (register 3 handlers)

- [ ] **Step 1: Add the import**

In `app/src-tauri/src/commands.rs`, after `use crate::index::{self, Adjacency};` add:

```rust
use crate::mcp_server::{self, McpRegInfo};
```

- [ ] **Step 2: Add the three command adapters**

Append to `app/src-tauri/src/commands.rs` (before the final newline):

```rust
#[tauri::command]
pub fn mcp_registration_info(vault_path: String) -> McpRegInfo {
    mcp_server::registration_info(&vault_path)
}

#[tauri::command]
pub async fn mcp_install(vault_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || mcp_server::install(&vault_path))
        .await
        .map_err(|e| format!("join failed: {e}"))?
}

#[tauri::command]
pub async fn mcp_register(vault_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || mcp_server::register(&vault_path))
        .await
        .map_err(|e| format!("join failed: {e}"))?
}
```

- [ ] **Step 3: Register the handlers in lib.rs**

In `app/src-tauri/src/lib.rs`, inside `tauri::generate_handler![ … ]`, add after `commands::open_external,`:

```rust
            commands::mcp_registration_info,
            commands::mcp_install,
            commands::mcp_register,
```

- [ ] **Step 4: Verify the backend compiles**

Run: `cd app/src-tauri && cargo check --message-format short`
Expected: `Finished` with no errors.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs
git commit -m "feat(memex): IPC commands for MCP registration (info/install/register)"
```

---

## Task 3: Frontend IPC wrappers

**Files:**
- Modify: `app/src/lib/ipc.ts` (type + 3 wrappers)

- [ ] **Step 1: Add the McpRegInfo type**

In `app/src/lib/ipc.ts`, after the `ClaudeStatus` interface (around line 46), add:

```ts
export interface McpRegInfo {
  found: boolean;
  installed: boolean;
  python: string | null;
  script: string | null;
  command: string | null;
  desktop_json: string | null;
}
```

- [ ] **Step 2: Add the three wrappers**

In the `ipc` object in `app/src/lib/ipc.ts`, after the `openExternal` line, add:

```ts
  mcpRegistrationInfo: (vaultPath: string) =>
    invoke<McpRegInfo>("mcp_registration_info", { vaultPath }),
  mcpInstall: (vaultPath: string) =>
    invoke<string>("mcp_install", { vaultPath }),
  mcpRegister: (vaultPath: string) =>
    invoke<string>("mcp_register", { vaultPath }),
```

- [ ] **Step 3: Verify types**

Run: `cd app && npx tsc -b`
Expected: `No errors found` (the wrappers are unused so far; tsc still passes).

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/ipc.ts
git commit -m "feat(memex): ipc wrappers for MCP registration"
```

---

## Task 4: i18n strings (en / ko / ja)

**Files:**
- Modify: `app/src/lib/i18n.ts` (Strings interface + 3 language objects)

- [ ] **Step 1: Add keys to the `Strings` interface**

In `app/src/lib/i18n.ts`, inside `export interface Strings { … }`, add (next to the other `s_*` tab labels):

```ts
  s_mcp: string;
  mcp_lede: string;
  mcp_status_installed: string;
  mcp_status_not_installed: string;
  mcp_install_btn: string;
  mcp_installing: string;
  mcp_command_label: string;
  mcp_desktop_label: string;
  mcp_desktop_path: string;
  mcp_copy: string;
  mcp_copied: string;
  mcp_register_btn: string;
  mcp_offline_note: string;
  mcp_not_found: string;
```

- [ ] **Step 2: Add the English values**

In the `en` object (next to `s_about: "About",`), add:

```ts
    s_mcp: "MCP Server",
    mcp_lede:
      "Expose this vault to Claude Code and Claude Desktop as MCP tools. Register once with the command below — it then works in every Claude session, even when this app is closed.",
    mcp_status_installed: "MCP server installed",
    mcp_status_not_installed: "MCP server not installed",
    mcp_install_btn: "Install MCP server",
    mcp_installing: "Installing…",
    mcp_command_label: "Register with Claude Code",
    mcp_desktop_label: "Claude Desktop config",
    mcp_desktop_path:
      "Add to ~/Library/Application Support/Claude/claude_desktop_config.json",
    mcp_copy: "Copy",
    mcp_copied: "Copied",
    mcp_register_btn: "Register to Claude Code now",
    mcp_offline_note:
      "Works even when Memex is closed — Claude launches the server itself.",
    mcp_not_found:
      "Could not find mcp-server/ near this vault. Open the Memex repo as your vault.",
```

- [ ] **Step 3: Add the Korean values**

In the `ko` object (next to `s_about: "정보",`), add:

```ts
    s_mcp: "MCP 서버",
    mcp_lede:
      "이 vault를 Claude Code·Claude Desktop에 MCP 도구로 노출합니다. 아래 명령으로 한 번만 등록하면, 이 앱이 꺼져 있어도 모든 Claude 세션에서 동작합니다.",
    mcp_status_installed: "MCP 서버 설치됨",
    mcp_status_not_installed: "MCP 서버 미설치",
    mcp_install_btn: "MCP 서버 설치",
    mcp_installing: "설치 중…",
    mcp_command_label: "Claude Code에 등록",
    mcp_desktop_label: "Claude Desktop 설정",
    mcp_desktop_path:
      "~/Library/Application Support/Claude/claude_desktop_config.json 에 추가",
    mcp_copy: "복사",
    mcp_copied: "복사됨",
    mcp_register_btn: "지금 Claude Code에 등록",
    mcp_offline_note:
      "Memex가 꺼져 있어도 동작 — Claude가 서버를 직접 띄웁니다.",
    mcp_not_found:
      "이 vault 근처에서 mcp-server/ 를 찾지 못했습니다. Memex 레포를 vault로 여세요.",
```

- [ ] **Step 4: Add the Japanese values**

In the `ja` object (next to `s_about: "情報",`), add:

```ts
    s_mcp: "MCP サーバー",
    mcp_lede:
      "この vault を Claude Code・Claude Desktop に MCP ツールとして公開します。下のコマンドで一度登録すれば、このアプリを閉じていても全ての Claude セッションで動作します。",
    mcp_status_installed: "MCP サーバー導入済み",
    mcp_status_not_installed: "MCP サーバー未導入",
    mcp_install_btn: "MCP サーバーを導入",
    mcp_installing: "導入中…",
    mcp_command_label: "Claude Code に登録",
    mcp_desktop_label: "Claude Desktop 設定",
    mcp_desktop_path:
      "~/Library/Application Support/Claude/claude_desktop_config.json に追加",
    mcp_copy: "コピー",
    mcp_copied: "コピー済み",
    mcp_register_btn: "今すぐ Claude Code に登録",
    mcp_offline_note:
      "Memex を閉じていても動作 — Claude がサーバーを自分で起動します。",
    mcp_not_found:
      "この vault 付近に mcp-server/ が見つかりません。Memex リポジトリを vault として開いてください。",
```

- [ ] **Step 5: Verify types (every Strings key must exist in all 3 objects)**

Run: `cd app && npx tsc -b`
Expected: `No errors found`. (A missing key in any language object is a TS error here.)

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/i18n.ts
git commit -m "feat(memex): i18n strings for MCP Server settings panel"
```

---

## Task 5: Settings "MCP Server" tab + panel

**Files:**
- Modify: `app/src/pages/PageSettings.tsx` (react import, tab enum, tabs array, render switch, new `SettingsMcp` component)

- [ ] **Step 1: Ensure the react + ipc imports cover what we use**

At the top of `app/src/pages/PageSettings.tsx`, confirm `useState` and `useEffect` are imported from `"react"` (they already are). Confirm `ipc` is imported from `"../lib/ipc"` and add `McpRegInfo` to that type import if `ipc.ts` types are imported by name; otherwise no import change is needed because `ipc` is used as a namespace object. (No code change if both are already present.)

- [ ] **Step 2: Add the `"mcp"` tab to the enum and tabs array**

Change the tab state type (around line 109) from:

```tsx
  const [tab, setTab] = useState<
    "account" | "model" | "providers" | "lang" | "appearance" | "about"
  >("model");
```

to:

```tsx
  const [tab, setTab] = useState<
    "account" | "model" | "providers" | "mcp" | "lang" | "appearance" | "about"
  >("model");
```

Add to the `tabs` array (after the `providers` entry):

```tsx
    { id: "mcp", label: t.s_mcp, icon: "terminal" },
```

- [ ] **Step 3: Add the render branch**

After the `providers` render line (`{tab === "providers" ? <SettingsProviders t={t} /> : null}`), add:

```tsx
          {tab === "mcp" ? <SettingsMcp t={t} /> : null}
```

- [ ] **Step 4: Add the `SettingsMcp` component**

Add this component to `app/src/pages/PageSettings.tsx` (e.g. after `SettingsProviders`). `useVaultStore` is already imported in this file.

```tsx
function SettingsMcp({ t }: { t: Strings }): JSX.Element {
  const currentVault = useVaultStore((s) => s.currentVault);
  const [info, setInfo] = useState<McpRegInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!currentVault) return;
    let alive = true;
    ipc
      .mcpRegistrationInfo(currentVault.path)
      .then((i) => {
        if (alive) setInfo(i);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [currentVault, tick]);

  function copy(text: string, which: string): void {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(which);
      window.setTimeout(() => setCopied(null), 1500);
    });
  }

  async function install(): Promise<void> {
    if (!currentVault) return;
    setBusy(true);
    setError(null);
    try {
      await ipc.mcpInstall(currentVault.path);
      setTick((n) => n + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function register(): Promise<void> {
    if (!currentVault) return;
    setBusy(true);
    setError(null);
    try {
      await ipc.mcpRegister(currentVault.path);
      setTick((n) => n + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!currentVault) return <div className="muted">Loading…</div>;

  const codeBox = (text: string, which: string): JSX.Element => (
    <div
      className="card"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: 12,
        fontFamily: "monospace",
        fontSize: 12,
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
      }}
    >
      <span style={{ flex: 1 }}>{text}</span>
      <button className="btn" onClick={() => copy(text, which)}>
        {copied === which ? t.mcp_copied : t.mcp_copy}
      </button>
    </div>
  );

  return (
    <div className="col" style={{ gap: 20 }}>
      <div>
        <h2 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>{t.s_mcp}</h2>
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 14 }}>
          {t.mcp_lede}
        </p>
      </div>

      {info && !info.found ? (
        <div className="card" style={{ padding: 14, fontSize: 13 }} role="alert">
          {t.mcp_not_found}
        </div>
      ) : null}

      {info && info.found && !info.installed ? (
        <div className="col" style={{ gap: 10 }}>
          <div className="muted" style={{ fontSize: 13 }}>
            {t.mcp_status_not_installed}
          </div>
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void install()}
            style={{ alignSelf: "flex-start" }}
          >
            {busy ? t.mcp_installing : t.mcp_install_btn}
          </button>
        </div>
      ) : null}

      {info && info.installed && info.command && info.desktop_json ? (
        <div className="col" style={{ gap: 16 }}>
          <div className="muted" style={{ fontSize: 13 }}>
            ✓ {t.mcp_status_installed}
          </div>

          <div className="col" style={{ gap: 6 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>
              {t.mcp_command_label}
            </div>
            {codeBox(info.command, "cmd")}
            <button
              className="btn"
              disabled={busy}
              onClick={() => void register()}
              style={{ alignSelf: "flex-start" }}
            >
              {t.mcp_register_btn}
            </button>
          </div>

          <div className="col" style={{ gap: 6 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>
              {t.mcp_desktop_label}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              {t.mcp_desktop_path}
            </div>
            {codeBox(info.desktop_json, "desktop")}
          </div>

          <div className="muted" style={{ fontSize: 12 }}>
            {t.mcp_offline_note}
          </div>
        </div>
      ) : null}

      {error ? (
        <div style={{ color: "#dc2626", fontSize: 12, whiteSpace: "pre-wrap" }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 5: Add the `McpRegInfo` type import if needed**

If `app/src/pages/PageSettings.tsx` imports named types from `../lib/ipc` (e.g. `import { ipc, type MemexSettings } from "../lib/ipc"`), add `McpRegInfo` to that import. If it only imports `ipc`, add a type import line near the other imports:

```tsx
import type { McpRegInfo } from "../lib/ipc";
```

- [ ] **Step 6: Verify the production build**

Run: `cd app && npm run build`
Expected: `tsc -b` clean + `vite build` succeeds (`✓ built`).

- [ ] **Step 7: Lint the changed file**

Run: `cd app && ./node_modules/.bin/eslint src/pages/PageSettings.tsx src/lib/ipc.ts src/lib/i18n.ts`
Expected: 0 errors (warnings unrelated to these changes are acceptable).

- [ ] **Step 8: Commit**

```bash
git add app/src/pages/PageSettings.tsx
git commit -m "feat(memex): MCP Server settings panel — install + copy registration command"
```

---

## Task 6: Manual acceptance

No automated runner exists for the UI; verify behavior in the real app.

- [ ] **Step 1: Launch the app on this repo as the vault**

Run: `cd app && npm run tauri dev`
Open Settings → MCP Server.

- [ ] **Step 2: Install path**

If the venv is absent, the panel shows "MCP server not installed" + Install button. Click Install. Expected: `mcp-server/.venv` is created; on success the panel flips to the installed state. Verify on disk: `ls app/../mcp-server/.venv/bin/python` exists.

- [ ] **Step 3: Command correctness**

Confirm the shown command is, with absolute paths:
`claude mcp add --scope user memex -- "<repo>/mcp-server/.venv/bin/python" "<repo>/mcp-server/memex_mcp.py"`
Copy it; the button shows "Copied".

- [ ] **Step 4: Register + use**

Paste/run the command in a terminal (or click "Register to Claude Code now"). Then:
Run: `claude mcp list`
Expected: `memex` listed and connected. In a Claude Code session, ask it to call `memex` `stats` — expect page/source counts back.

- [ ] **Step 5: Offline proof**

Quit the Memex app. Start a new Claude Code session and call a `memex` tool again. Expected: still works (Claude spawns the stdio server itself).

- [ ] **Step 6: Final verification commit (docs only, if README updated)**

If you add a short "MCP Server panel" note to `app/README.md` MCP section, commit it:

```bash
git add app/README.md
git commit -m "docs(memex): note the in-app MCP Server registration panel"
```

---

## Self-Review

**Spec coverage** (against `2026-06-13-mcp-stdio-registration-design.md`):
- Install venv from app → Task 2 `mcp_install` + Task 5 Install button. ✓
- Copy `claude mcp add memex -- …` command → Task 1 `registration_info.command` + Task 5 codeBox. ✓
- Claude Desktop config snippet + path → Task 1 `desktop_json` + Task 5 + i18n `mcp_desktop_path`. ✓
- Optional Register button → Task 1 `register` + Task 5 register(). ✓
- Not-installed / not-found states, no silent failure → Task 5 branches + `error` block. ✓
- Works app-closed note → i18n `mcp_offline_note`. ✓
- No change to `memex_mcp.py`; stdio only → confirmed (no task touches it). ✓
- localhost/stdio security, existing guards unchanged → nothing exposes a socket. ✓
- v1 source-checkout limitation → `find_repo_root` walks up from the vault; `mcp_not_found` covers the miss. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; tests have real assertions. ✓

**Type consistency:** `McpRegInfo` fields (`found, installed, python, script, command, desktop_json`) are identical across Rust (`mcp_server.rs`), TS (`ipc.ts`), and usage (`SettingsMcp`). Command names (`mcp_registration_info`, `mcp_install`, `mcp_register`) match between `commands.rs`, `lib.rs` handler list, and `ipc.ts` wrappers. ✓
