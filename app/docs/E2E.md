# Memex — End-to-End & Native Test Coverage

Memex is a Tauri 2 app: a React frontend over a Rust backend, wired by IPC.
The frontend can be exercised in a plain browser, but the backend's native
behaviors (OS keychain, spawning CLI agents, MCP path resolution) only run
under the real Tauri runtime. This doc maps what is covered where, and what
must still be checked by hand.

## Coverage at a glance

| Surface | Covered by | How to run |
| --- | --- | --- |
| Frontend routes render without console/page errors | **route-smoke** (browser) | `npm run test:e2e` |
| Command palette keyboard + screen-reader semantics, 3 viewports | **cmdbar-a11y-smoke** (browser) | `npm run test:e2e:cmdbar` |
| User-facing copy follows the chosen language (en/ko/ja) | **i18n-smoke** (browser) | `npm run test:e2e:i18n` |
| Timelapse survives unmount/rebuild and releases its capture | **timelapse-smoke** (browser) | `npm run test:e2e:timelapse` |
| Frontend unit/component logic | **vitest** | `npm test` |
| Vault lifecycle (open → list → write → link graph → provenance → rename/delete) | **cargo test** (`tests/vault_lifecycle.rs`) | `cargo test` |
| HTTP provider adapters (Anthropic/OpenAI/OpenRouter/Google/Ollama), retries, size cap | **cargo test** (`tests/provider_adapters.rs`, wiremock) | `cargo test` |
| `git log` shellout | **cargo test** (`tests/git_log_real.rs`) | `cargo test` |
| CLI agent locator + spawn arg-building + spawn guards | **cargo test** (`cli_agent` in-module + `tests/native_bridges.rs`) | `cargo test` |
| Claude CLI stream-JSON parsing, PATH augmentation, binary location | **cargo test** (`claude` in-module) | `cargo test` |
| MCP registration string/JSON building + python version parsing | **cargo test** (`mcp_server` in-module) | `cargo test` |
| Keychain secret storage round-trip (real OS keychain) | **cargo test, `#[ignore]`d** (`tests/native_bridges.rs`) | `cargo test --test native_bridges -- --ignored` |
| Keychain **UI**, real CLI **ingest**, MCP **Register** button (full runtime) | **manual** | see checklist below |

### The three layers

- **route-smoke** (`app/scripts/route-smoke.mjs`): boots the frontend against
  the `?mock=1` dev server (mocked IPC) and clicks through every workspace and
  tools route, asserting each renders with no page/console error. It cannot see
  any real backend behavior — the IPC layer is stubbed.
- **cargo test** (`app/src-tauri`): 117 tests + 3 `#[ignore]`d. Exercises the
  domain modules directly, without booting the Tauri GUI. This is the tractable
  native layer and the bulk of backend coverage.
- **manual**: flows that need a live `tauri::AppHandle`, real credentials, or an
  interactive keychain — see the acceptance checklist.

## Running

```bash
# frontend
cd app
npm test                 # vitest unit/component
npm run test:e2e         # route-smoke (dev server must be on :5173)

# backend
cd app/src-tauri
cargo test               # 117 pass, 3 keychain tests skipped (ignored)
cargo test -- --ignored  # ALSO run the keychain round-trip (see caveats below)
```

## Native GUI E2E (tauri-driver): NOT supported on macOS

The obvious way to cover the full runtime — drive the packaged binary with
WebDriver via `tauri-driver` + WebdriverIO/Playwright — **does not work on
macOS**, and we deliberately do not attempt it here.

- Tauri's WebDriver support is **Linux and Windows only**. `tauri-driver`
  proxies to `WebKitWebDriver` (Linux, webkit2gtk) or Edge's `msedgedriver`
  (Windows, WebView2).
- On macOS, Tauri renders in **WKWebView**, which exposes **no WebDriver
  endpoint**. `safaridriver` drives Safari, not an embedded WKWebView, so it
  cannot attach to the Memex window.
- Verified on this machine (macOS, arm64): `tauri-driver` not installed,
  `WebKitWebDriver` absent, only `safaridriver` present.

**Conclusion:** native GUI E2E on macOS is not viable. Backend behavior is
covered by `cargo test`; full-runtime flows are covered manually (below). If
automated GUI E2E is ever needed, run it in **Linux CI**.

### Linux CI setup (if/when automated GUI E2E is added)

```bash
# 1. system deps (Debian/Ubuntu)
sudo apt-get install -y webkit2gtk-driver xvfb   # WebKitWebDriver + headless X

# 2. the WebDriver proxy
cargo install tauri-driver --locked

# 3. build the app under test
cd app && npm ci && npm run tauri build -- --debug

# 4. point a WebdriverIO/Playwright spec at tauri-driver (default :4444),
#    with tauri:options.application = path to the built debug binary, e.g.
#      app/src-tauri/target/debug/memex
#    Run the runner under xvfb-run for a headless display:
xvfb-run -a <your-webdriverio-or-playwright-runner>
```

`tauri-driver` starts the app, forwards W3C WebDriver commands to
`WebKitWebDriver`, and lets the spec select DOM nodes and assert on real
backend responses (keychain, CLI, MCP) end to end. No such runner exists in
this repo yet — this is the skeleton to build from if the need arises.

## Keychain test caveats (`#[ignore]`d)

`tests/native_bridges.rs` contains a real keychain round-trip
(`set_key → get_key → delete_key`). It is `#[ignore]`d because it:

- persists a credential in the OS keychain (uses a unique throwaway provider id
  and deletes it on success), and
- may raise an interactive unlock/allow-access prompt (macOS login keychain),
  or hard-fail where there is no secret service (headless Linux CI).

It passes on a developer macOS machine with an unlocked login keychain. Do not
add it to unattended CI without a provisioned, unlocked keychain (e.g.
`security create-keychain` + `security unlock-keychain` on macOS runners, or a
`gnome-keyring`/`dbus-launch` session on Linux).

## Manual acceptance checklist (full-runtime flows)

Run these against a dev build (`cd app && npm run tauri dev`). These need a live
`AppHandle`, real user credentials, or interactive OS prompts, so they are out
of scope for `cargo test`.

### Keychain UI (Settings → Providers)
- [ ] Enter an API key for a provider, save. No key value is printed to logs or
      console.
- [ ] Reopen Settings: the provider shows a "set / configured" state (the key is
      **not** re-displayed — it is write-only from the UI).
- [ ] Clear the key. The provider reverts to "not set"; re-clearing is a no-op
      (no error).
- [ ] Confirm the key is in the OS keychain under service `dev.cmblir.memex`
      (macOS: Keychain Access → search "memex"), not in any app file on disk.

### Real CLI ingest (Claude / Gemini / Codex)
- [ ] With the `claude` CLI installed and logged in, run an ingest on a raw/
      source. Live tool events stream into the run panel (init → tool → text →
      result).
- [ ] Ingest writes only under the vault (Read/Write/Edit/Glob/Grep allowed;
      **Bash denied** by default on untrusted content).
- [ ] Cancel a mid-flight run: the child process is killed, no orphan `claude`
      process survives.
- [ ] Repeat for `gemini-cli` and `codex-cli` if installed (agent picker). Codex
      writes stay confined to the vault (`workspace-write` sandbox).
- [ ] With a CLI **not** installed, the UI shows a "not found / install" status
      rather than hanging.

### MCP registration (Settings → MCP)
- [ ] "Install" creates the app-data venv and installs the server deps (needs
      Python ≥ 3.10 discoverable, or `MEMEX_PYTHON_PATH` set).
- [ ] The shown `claude mcp add …` command and `claude_desktop_config.json`
      snippet contain the bundled script path and the current vault as
      `MEMEX_PROJECT_ROOT`.
- [ ] "Register" runs `claude mcp add --scope user memex …` successfully (needs
      the `claude` CLI). Afterwards `claude mcp list` shows `memex`.
- [ ] The registered server resolves the correct vault even when the vault lives
      outside the source repo (bundled script + `MEMEX_PROJECT_ROOT` env).
