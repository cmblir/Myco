// Tauri IPC command surface. Each function is a thin adapter that delegates
// to a domain module (vault, parser, index). Keep this file free of business
// logic so the same modules remain unit-testable without Tauri runtime.

use crate::claude::{self, CliResult, CliStatus};
use crate::cli_agent;
use crate::git_log::{self, Commit};
use crate::index::{self, Adjacency};
use crate::local_llm::LocalLlm;
use crate::mcp_server::{self, McpRegInfo};
use crate::ollama::{self, OllamaStatus};
use crate::provenance::{self, ProvenanceRow};
use crate::providers::{self, ChatRequest, ChatResponse};
use crate::registry;
use crate::secrets;
use crate::settings::{self, Settings};
use crate::vault::{self, FileContent, FileNode, SearchHit, VaultMeta};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::Manager;

/// Canonical root of the currently-open vault. Set on `open_vault` and used to
/// confine every filesystem command, so the frontend cannot read/write/delete
/// outside the vault. `None` until a vault is opened — fs commands fail closed.
#[derive(Default)]
pub struct VaultRoot(Mutex<Option<PathBuf>>);

impl VaultRoot {
    fn set(&self, root: PathBuf) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(root);
    }
    fn get(&self) -> Option<PathBuf> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    /// Read-only view for non-command callers (the deep-link clip handler).
    pub fn current(&self) -> Option<PathBuf> {
        self.get()
    }
}

fn require_root(state: &tauri::State<VaultRoot>) -> Result<PathBuf, String> {
    state.get().ok_or_else(|| "no vault is open".to_string())
}

/// Lazily-loaded embedded model (bundled Gemma 3 1B GGUF). `None` until the
/// first local_* command; the 769 MB weights must not tax startup or RAM when
/// the feature is unused. Arc so inference can run on a blocking thread.
#[derive(Default, Clone)]
pub struct LocalLlmState(Arc<Mutex<Option<LocalLlm>>>);

/// Bundled model path: the packaged resource dir, falling back to the source
/// tree in dev (`cargo tauri dev` may run before resources are staged).
fn local_model_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    const REL: &str = "models/gemma-3-1b-it-q4_k_m.gguf";
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join(REL);
        if p.is_file() {
            return Ok(p);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(REL);
    if dev.is_file() {
        return Ok(dev);
    }
    Err("bundled model not found (models/gemma-3-1b-it-q4_k_m.gguf)".into())
}

/// Run `f` against the lazily-loaded local model on a blocking thread —
/// inference takes seconds and must not stall the async runtime.
async fn with_local_llm<T, F>(
    app: tauri::AppHandle,
    state: tauri::State<'_, LocalLlmState>,
    f: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&LocalLlm) -> Result<T, String> + Send + 'static,
{
    let cell = state.0.clone();
    let path = local_model_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = cell.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            *guard = Some(LocalLlm::load(&path)?);
        }
        f(guard.as_ref().expect("just loaded"))
    })
    .await
    .map_err(|e| format!("local model task failed: {e}"))?
}

/// Classify a note into a wiki page type with the embedded model. Offline,
/// no key; output is post-validated against the type enum.
#[tauri::command]
pub async fn local_classify(
    app: tauri::AppHandle,
    state: tauri::State<'_, LocalLlmState>,
    note: String,
) -> Result<String, String> {
    with_local_llm(app, state, move |llm| llm.classify(&note)).await
}

/// Light free-form generation with the embedded model. The caller inlines any
/// vault context; factual accuracy is limited at 0.5B (paid tiers for ingest).
#[tauri::command]
pub async fn local_query(
    app: tauri::AppHandle,
    state: tauri::State<'_, LocalLlmState>,
    prompt: String,
    max_tokens: Option<i32>,
) -> Result<String, String> {
    with_local_llm(app, state, move |llm| {
        llm.generate(&prompt, max_tokens.unwrap_or(256))
    })
    .await
}

/// Confine a frontend-supplied scan root/path to the open vault. The read-only
/// scanners below take a path argument (historical), so this asserts it resolves
/// to — or inside — the open vault root, matching the confinement the mutating
/// commands already enforce and the VaultRoot doc-comment's promise.
fn confine_root(state: &tauri::State<VaultRoot>, arg: &str) -> Result<String, String> {
    let root = require_root(state)?;
    let resolved = std::path::Path::new(arg)
        .canonicalize()
        .map_err(|e| format!("canonicalize failed for {arg}: {e}"))?;
    if !resolved.starts_with(&root) {
        return Err("path is outside the open vault".into());
    }
    Ok(resolved.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn open_vault(
    app: tauri::AppHandle,
    state: tauri::State<VaultRoot>,
    path: String,
) -> Result<VaultMeta, String> {
    let meta = vault::open_vault(&path)?;
    // meta.path is canonical; record it as the confinement root for fs commands.
    state.set(PathBuf::from(&meta.path));
    // Record the active vault so the bundled MCP server follows the app's
    // current selection (best-effort: a marker write failure must not block
    // opening the vault).
    let _ = settings::set_active_vault(&path);
    // The SSE MCP server resolves the vault once at startup, so restart it (if
    // running) to pick up the new active vault.
    mcp_server::restart_if_serving(&app);
    Ok(meta)
}

#[tauri::command]
pub fn ensure_default_vault() -> Result<String, String> {
    vault::ensure_default_vault()
}

#[tauri::command]
pub fn list_files(state: tauri::State<VaultRoot>, root: String) -> Result<Vec<FileNode>, String> {
    let root = confine_root(&state, &root)?;
    vault::list_files(&root)
}

#[tauri::command]
pub fn file_mtimes(
    state: tauri::State<VaultRoot>,
    root: String,
) -> Result<Vec<(String, i64)>, String> {
    let root = confine_root(&state, &root)?;
    vault::file_mtimes(&root)
}

#[tauri::command]
pub fn read_file(state: tauri::State<VaultRoot>, path: String) -> Result<FileContent, String> {
    let root = require_root(&state)?;
    let p = vault::confine_path(&root, &path)?;
    vault::read_file(&p.to_string_lossy())
}

/// Serve the raw bytes of a source file under the vault's `raw/` tree, for the
/// in-app PDF viewer (Feature 6). Path-confined to `raw/` (rejects `../` and any
/// path outside it) and size-capped, so it can neither escape the vault nor OOM
/// the app. Returns raw bytes (JS receives an ArrayBuffer) — never a file:// URL.
#[tauri::command]
pub fn read_raw_bytes(
    state: tauri::State<VaultRoot>,
    relpath: String,
) -> Result<tauri::ipc::Response, String> {
    const MAX_PDF_BYTES: u64 = 100 * 1024 * 1024;
    let root = require_root(&state)?;
    let bytes = vault::read_confined_raw(&root, &relpath, MAX_PDF_BYTES)?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Concatenate vault markdown (CLAUDE.md + wiki/ + raw/) up to `max_bytes`,
/// so non-tool LLM providers can answer queries / run lint against real vault
/// content (the Claude CLI reads files itself and does not use this).
#[tauri::command]
pub fn read_vault_context(
    state: tauri::State<VaultRoot>,
    root: String,
    max_bytes: usize,
) -> Result<String, String> {
    let root = confine_root(&state, &root)?;
    vault::read_vault_context(&root, max_bytes)
}

#[tauri::command]
pub fn write_file(
    state: tauri::State<VaultRoot>,
    path: String,
    content: String,
) -> Result<(), String> {
    let root = require_root(&state)?;
    let p = vault::confine_path(&root, &path)?;
    vault::write_file(&p.to_string_lossy(), &content)
}

/// Describe an image with a vision-capable provider (Feature 2 image ingest),
/// turning a dropped image into text the ingest pipeline can wiki-ify. Not
/// vault-confined (it's an external import, like read_external_text); size-
/// capped. The API key stays server-side (keychain).
#[tauri::command]
pub async fn describe_image(
    provider: String,
    model: String,
    path: String,
    prompt: String,
) -> Result<String, String> {
    const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
    let p = std::path::Path::new(&path);
    if !p.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let meta = std::fs::metadata(p).map_err(|e| format!("stat failed: {e}"))?;
    if meta.len() > MAX_IMAGE_BYTES {
        return Err("image is too large (limit 20 MB)".into());
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let media_type = providers::image_media_type(&ext);
    let bytes = std::fs::read(p).map_err(|e| format!("read failed: {e}"))?;
    let key = secrets::get_key(&provider)?;
    providers::describe_image(&provider, &model, &bytes, media_type, &prompt, key).await
}

/// Whether a whisper CLI is installed (gates the media-ingest affordance).
#[tauri::command]
pub fn whisper_check() -> CliStatus {
    crate::whisper::check()
}

/// Transcribe an audio/video file with an installed whisper CLI (Feature 2).
/// Runs off the async pool so the long transcription doesn't block the UI.
#[tauri::command]
pub async fn transcribe_media(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || crate::whisper::transcribe(&path))
        .await
        .map_err(|e| format!("transcription task failed: {e}"))?
}

/// Extract a dropped/picked file's text for ingest (not restricted to inside the
/// vault — it's an external import). PDF and spreadsheets (xlsx/xls/ods) are
/// parsed to text; CSV and other text-like files are read as-is. Refuses files
/// larger than 25 MB. Parsing runs in an isolated child process so a hostile file
/// that crashes the parser can't take down the app.
#[tauri::command]
pub fn read_external_text(path: String) -> Result<String, String> {
    crate::extract::extract_text_isolated(&path)
}

/// Persist a streamed Claude run transcript to `<vault>/runs/<name>` (opt-in,
/// best-effort). `vault_path` is confined to the open vault root, mirroring the
/// other write commands; `name` must be a bare file name.
#[tauri::command]
pub fn write_run_log(
    state: tauri::State<VaultRoot>,
    vault_path: String,
    name: String,
    content: String,
) -> Result<(), String> {
    let root = require_root(&state)?;
    let vault = vault::confine_parent(&root, &vault_path)?;
    vault::write_run_log(&vault, &name, &content)
}

/// Scaffold `<vault>/.obsidian/app.json` so the open vault can be opened
/// directly in Obsidian. `vault_path` is confined to the open vault root like
/// the other write commands; the write is idempotent. Returns the `.obsidian`
/// directory path.
#[tauri::command]
pub fn scaffold_obsidian_vault(
    state: tauri::State<VaultRoot>,
    vault_path: String,
) -> Result<String, String> {
    let vault = confine_root(&state, &vault_path)?;
    vault::scaffold_obsidian_vault(std::path::Path::new(&vault))
}

#[tauri::command]
pub fn create_file(
    state: tauri::State<VaultRoot>,
    parent: String,
    name: String,
) -> Result<String, String> {
    let root = require_root(&state)?;
    let p = vault::confine_parent(&root, &parent)?;
    vault::create_file(&p.to_string_lossy(), &name)
}

#[tauri::command]
pub fn create_folder(
    state: tauri::State<VaultRoot>,
    parent: String,
    name: String,
) -> Result<String, String> {
    let root = require_root(&state)?;
    let p = vault::confine_parent(&root, &parent)?;
    vault::create_folder(&p.to_string_lossy(), &name)
}

#[tauri::command]
pub fn delete_path(state: tauri::State<VaultRoot>, path: String) -> Result<(), String> {
    let root = require_root(&state)?;
    let p = vault::confine_path(&root, &path)?;
    vault::delete_path(&p.to_string_lossy())
}

#[tauri::command]
pub fn rename_path(
    state: tauri::State<VaultRoot>,
    from: String,
    to_name: String,
) -> Result<String, String> {
    let root = require_root(&state)?;
    let p = vault::confine_path(&root, &from)?;
    // Renaming a note moves its wikilink target (the file stem), orphaning every
    // inbound [[old]]. Capture the stems, then rewrite backlinks vault-wide so
    // the graph and backlinks panel stay connected.
    let is_md = p
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("md"));
    let old_stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string();
    let new_path = vault::rename_path(&p.to_string_lossy(), &to_name)?;
    if is_md {
        let new_stem = std::path::Path::new(&to_name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&to_name);
        if !old_stem.is_empty() && !old_stem.eq_ignore_ascii_case(new_stem) {
            vault::rewrite_backlinks(&root, &old_stem, new_stem);
        }
    }
    Ok(new_path)
}

#[tauri::command]
pub fn build_link_graph(state: tauri::State<VaultRoot>, root: String) -> Result<Adjacency, String> {
    let root = confine_root(&state, &root)?;
    index::build_link_graph(&root)
}

// ---- Multiverse (multi-project registry, Phase 0) ----
//
// These three commands are the only multi-root surface. They deliberately do
// NOT use `confine_root` (which pins reads to the single open vault): a slug
// is turned into a path exclusively by `registry::resolve_project_root`, which
// requires the slug to be registered in the `projects.json` found ABOVE the
// open vault and the resolved path to stay under its `projects/` dir. Reads
// only — every mutating command keeps the single-root confinement.

/// Enumerate the registered projects ("universes"). Empty when the open vault
/// is standalone (no projects.json in its ancestry) — the frontend reads that
/// as "no multiverse available".
#[tauri::command]
pub fn list_projects(
    state: tauri::State<VaultRoot>,
) -> Result<Vec<registry::ProjectInfo>, String> {
    let open = require_root(&state)?;
    Ok(registry::Registry::discover(&open)
        .map(|reg| reg.project_infos())
        .unwrap_or_default())
}

/// Read-only link graph of a REGISTERED project that need not be the open
/// vault — the multiverse view builds one adjacency per universe with this.
#[tauri::command]
pub fn build_link_graph_at(
    state: tauri::State<VaultRoot>,
    slug: String,
) -> Result<Adjacency, String> {
    let open = require_root(&state)?;
    let reg = registry::Registry::discover(&open)
        .ok_or_else(|| "no project registry above the open vault".to_string())?;
    let root = reg.resolve_project_root(&slug)?;
    index::build_link_graph(&root.to_string_lossy())
}

/// Switch the active project without the frontend teardown `open_vault`
/// implies: registry `active` pointer + confinement root + active-vault marker
/// + MCP restart. The multiverse scene stays alive and just re-frames.
#[tauri::command]
pub fn set_active_project(
    app: tauri::AppHandle,
    state: tauri::State<VaultRoot>,
    slug: String,
) -> Result<VaultMeta, String> {
    let open = require_root(&state)?;
    let reg = registry::Registry::discover(&open)
        .ok_or_else(|| "no project registry above the open vault".to_string())?;
    let root = reg.resolve_project_root(&slug)?;
    let meta = vault::open_vault(&root.to_string_lossy())?;
    // Point the registry at the new project FIRST — if this write fails,
    // nothing has switched and the command errors cleanly.
    registry::set_active(&reg.project_root, &slug)?;
    state.set(PathBuf::from(&meta.path));
    // Best-effort marker write, mirroring open_vault: the bundled MCP server
    // follows this file; a failure must not block the switch.
    let _ = settings::set_active_vault(&meta.path);
    mcp_server::restart_if_serving(&app);
    Ok(meta)
}

/// Every universe the multiverse can show: registered projects (from the
/// `projects.json` above the open vault, if any) UNION the vault-like sibling
/// directories beside the open vault. Deduped by canonical root. This is what
/// lets a user's several side-by-side vaults appear without a registry.
#[tauri::command]
pub fn list_universes(
    state: tauri::State<VaultRoot>,
) -> Result<Vec<registry::ProjectInfo>, String> {
    let open = require_root(&state)?;
    let norm = |p: &str| {
        std::path::Path::new(p)
            .canonicalize()
            .map(|c| c.to_string_lossy().into_owned())
            .unwrap_or_else(|_| p.to_string())
    };
    let mut out: Vec<registry::ProjectInfo> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    if let Some(reg) = registry::Registry::discover(&open) {
        for e in reg.project_infos() {
            if seen.insert(norm(&e.root)) {
                out.push(e);
            }
        }
    }
    for e in registry::discover_sibling_vaults(&open) {
        if seen.insert(norm(&e.root)) {
            out.push(e);
        }
    }
    Ok(out)
}

/// Read-only link graph of a universe identified by its ROOT path — validated
/// to be one of the KNOWN universes (a registered project, a discovered sibling
/// vault, or the open vault itself), so this never reads an arbitrary path.
#[tauri::command]
pub fn build_universe_graph(
    state: tauri::State<VaultRoot>,
    root: String,
) -> Result<Adjacency, String> {
    let open = require_root(&state)?;
    let canon = |p: &str| std::path::Path::new(p).canonicalize().ok();
    let target = canon(&root).ok_or_else(|| format!("universe root missing: {root}"))?;
    // Build the allow-set of known universe roots.
    let mut known: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    known.insert(open.clone());
    if let Some(reg) = registry::Registry::discover(&open) {
        for e in reg.project_infos() {
            if let Some(c) = canon(&e.root) {
                known.insert(c);
            }
        }
    }
    for e in registry::discover_sibling_vaults(&open) {
        if let Some(c) = canon(&e.root) {
            known.insert(c);
        }
    }
    if !known.contains(&target) {
        return Err("not a known universe".into());
    }
    index::build_link_graph(&target.to_string_lossy())
}

/// Case-insensitive full-text search over the open vault's .md files. Uses the
/// confined vault root (no path from the frontend), so it can't read elsewhere.
#[tauri::command]
pub fn search_vault(
    state: tauri::State<VaultRoot>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<SearchHit>, String> {
    let root = require_root(&state)?;
    Ok(vault::search_vault(&root, &query, limit.unwrap_or(50)))
}

#[tauri::command]
pub fn git_log(
    state: tauri::State<VaultRoot>,
    vault_path: String,
    limit: Option<usize>,
) -> Result<Vec<Commit>, String> {
    let vault_path = confine_root(&state, &vault_path)?;
    git_log::git_log(&vault_path, limit.unwrap_or(50))
}

#[tauri::command]
pub fn claude_check() -> CliStatus {
    claude::check()
}

#[tauri::command]
pub async fn claude_run(
    prompt: String,
    cwd: String,
    model: Option<String>,
) -> Result<CliResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        claude::run_prompt(&prompt, &cwd, model.as_deref())
    })
    .await
    .map_err(|e| format!("join failed: {e}"))?
}

/// Streaming claude run: emits a `claude-stream` event per parsed CLI event
/// so the frontend can render live progress, then resolves with the final
/// result like `claude_run`. Cancel with `claude_cancel(run_id)`.
#[tauri::command]
pub async fn claude_run_stream(
    app: tauri::AppHandle,
    run_id: String,
    prompt: String,
    cwd: String,
    model: Option<String>,
) -> Result<CliResult, String> {
    use tauri::Emitter;
    tauri::async_runtime::spawn_blocking(move || {
        let id = run_id.clone();
        claude::run_prompt_stream(&run_id, &prompt, &cwd, model.as_deref(), move |event| {
            let _ = app.emit(
                "claude-stream",
                claude::StreamEvent {
                    run_id: id.clone(),
                    event,
                },
            );
        })
    })
    .await
    .map_err(|e| format!("join failed: {e}"))?
}

#[tauri::command]
pub fn claude_cancel(run_id: String) -> bool {
    claude::cancel(&run_id)
}

/// Install status of a third-party agent CLI ("gemini-cli" / "codex-cli").
#[tauri::command]
pub async fn agent_check(provider: String) -> CliStatus {
    tauri::async_runtime::spawn_blocking(move || cli_agent::check(&provider))
        .await
        .unwrap_or(CliStatus {
            installed: false,
            version: None,
            path: None,
        })
}

/// Headless run of a third-party agent CLI with the vault as cwd.
#[tauri::command]
pub async fn agent_run(
    provider: String,
    model: String,
    prompt: String,
    cwd: String,
) -> Result<CliResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        cli_agent::run_prompt(&provider, &model, &prompt, &cwd)
    })
    .await
    .map_err(|e| format!("join failed: {e}"))?
}

#[tauri::command]
pub fn scan_provenance(
    state: tauri::State<VaultRoot>,
    vault_path: String,
) -> Result<Vec<ProvenanceRow>, String> {
    let vault_path = confine_root(&state, &vault_path)?;
    provenance::scan_provenance(&vault_path)
}

/// Memex Pro ingest: send the open vault's snapshot + this source to the
/// configured proxy and apply the wiki file operations it returns (confined to
/// the vault). The proxy URL comes from settings; the license key from the
/// keychain ("memex-pro").
#[tauri::command]
pub async fn memex_pro_ingest(
    state: tauri::State<'_, VaultRoot>,
    slug: String,
    title: String,
    text: String,
) -> Result<crate::memex_pro::MemexProResult, String> {
    let root = require_root(&state)?;
    // VaultRoot is Send + Sync, so holding State across the await keeps the
    // future Send; we just need the owned root before the network call.
    let s = settings::load();
    let url = s.memex_pro_url.trim().to_string();
    if url.is_empty() {
        return Err("Memex Pro proxy URL is not configured (Settings → Connections)".into());
    }
    let key = secrets::get_key("memex-pro")?.ok_or_else(|| {
        "Memex Pro is not connected — log in under Settings → Connections".to_string()
    })?;
    crate::memex_pro::ingest(&root, &url, &key, &slug, &title, &text).await
}

/// Log in to Memex Pro with the account created on the website. Fetches the
/// account's access key, stores it in the keychain, and records the email for
/// display — so the user never copies a key by hand.
#[tauri::command]
pub async fn memex_pro_login(
    email: String,
    password: String,
) -> Result<crate::memex_pro::LoginOutcome, String> {
    let url = settings::load().memex_pro_url.trim().to_string();
    if url.is_empty() {
        return Err("Set the Memex Pro service URL first (Settings → Connections)".into());
    }
    let outcome = crate::memex_pro::login(&url, &email, &password).await?;
    if let Some(key) = &outcome.license_key {
        secrets::set_key("memex-pro", key)?;
    }
    // Persist the logged-in email + connection flag (the key stays in the
    // keychain). The flag gates the model picker; settings is the single source.
    let mut s = settings::load();
    s.memex_pro_email = outcome.email.clone();
    s.providers.memex_pro = outcome.connected;
    let _ = settings::save(&s);
    // Don't echo the key back to the frontend; it's in the keychain.
    Ok(crate::memex_pro::LoginOutcome {
        license_key: None,
        ..outcome
    })
}

/// Log out of Memex Pro: clear the stored key and email.
#[tauri::command]
pub fn memex_pro_logout() -> Result<(), String> {
    let _ = secrets::delete_key("memex-pro");
    let mut s = settings::load();
    s.memex_pro_email = String::new();
    s.providers.memex_pro = false;
    settings::save(&s)
}

#[tauri::command]
pub fn set_provider_key(provider_id: String, key: String) -> Result<(), String> {
    secrets::set_key(&provider_id, &key)
}

#[tauri::command]
pub fn delete_provider_key(provider_id: String) -> Result<(), String> {
    secrets::delete_key(&provider_id)
}

#[tauri::command]
pub fn get_settings() -> Settings {
    settings::load()
}

#[tauri::command]
pub fn set_settings(value: Settings) -> Result<(), String> {
    settings::save(&value)
}

#[tauri::command]
pub async fn chat_complete(request: ChatRequest) -> Result<ChatResponse, String> {
    let key = if request.provider_id == "ollama" {
        None
    } else {
        secrets::get_key(&request.provider_id)?
    };
    providers::chat_complete(request, key).await
}

// ---- Recurring schedules (Feature 7) ----

#[tauri::command]
pub fn list_schedules(
    state: tauri::State<VaultRoot>,
    vault: String,
) -> Result<Vec<crate::schedules::Schedule>, String> {
    let root = confine_root(&state, &vault)?;
    Ok(crate::schedules::load(std::path::Path::new(&root)))
}

#[tauri::command]
pub fn upsert_schedule(
    state: tauri::State<VaultRoot>,
    vault: String,
    schedule: crate::schedules::Schedule,
) -> Result<Vec<crate::schedules::Schedule>, String> {
    let root = confine_root(&state, &vault)?;
    crate::schedules::upsert(std::path::Path::new(&root), schedule)
}

#[tauri::command]
pub fn delete_schedule(
    state: tauri::State<VaultRoot>,
    vault: String,
    id: String,
) -> Result<Vec<crate::schedules::Schedule>, String> {
    let root = confine_root(&state, &vault)?;
    crate::schedules::delete(std::path::Path::new(&root), &id)
}

/// The bundled digest runner script (falls back to the repo path in dev).
fn digest_script_path(app: &tauri::AppHandle) -> Result<String, String> {
    const REL: &str = "automation/digest.py";
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join(REL);
        if p.is_file() {
            return Ok(p.to_string_lossy().into_owned());
        }
    }
    // Dev: repo root is two levels up from src-tauri.
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(REL);
    if dev.is_file() {
        return Ok(dev.to_string_lossy().into_owned());
    }
    Err("digest runner (automation/digest.py) not found".into())
}

/// Install or remove a launchd LaunchAgent that runs a schedule's digest while
/// the app is closed (macOS, opt-in). `on=false` removes it.
#[tauri::command]
pub fn install_background_schedule(
    app: tauri::AppHandle,
    state: tauri::State<VaultRoot>,
    vault: String,
    id: String,
    on: bool,
) -> Result<String, String> {
    let root = confine_root(&state, &vault)?;
    let root_path = std::path::Path::new(&root);
    if on {
        let sched = crate::schedules::load(root_path)
            .into_iter()
            .find(|s| s.id == id)
            .ok_or_else(|| format!("schedule not found: {id}"))?;
        let interval = crate::schedules::interval_secs(&sched.cadence);
        let python = claude::locate_bin("python3", "MEMEX_PYTHON_PATH")
            .ok_or("python3 not found on PATH (needed for background schedules)")?;
        let script = digest_script_path(&app)?;
        crate::schedules::install_background(root_path, &python, &script, &id, interval, true)
    } else {
        crate::schedules::install_background(root_path, "", "", &id, 0, false)
    }
}

// ---- In-app agent (Feature 4) ----

/// The agent tool schemas the model may call (read tools + gated write tools).
#[tauri::command]
pub fn agent_tools_schema() -> Vec<crate::agent_tools::ToolDescriptor> {
    crate::agent_tools::descriptors()
}

/// Execute one agent tool call against the open vault. `allow_write` is set by
/// the frontend only after the user confirms a write; the registry re-checks it
/// and always refuses `raw/`.
#[tauri::command]
pub fn agent_tool_call(
    state: tauri::State<VaultRoot>,
    name: String,
    args: serde_json::Value,
    allow_write: bool,
) -> Result<serde_json::Value, String> {
    let root = require_root(&state)?;
    crate::agent_tools::dispatch(&root.to_string_lossy(), &name, &args, allow_write)
}

/// One tool-calling turn for the in-app agent loop (HTTP providers only).
#[tauri::command]
pub async fn agent_chat(
    request: providers::AgentChatRequest,
) -> Result<providers::AgentTurn, String> {
    let key = secrets::get_key(&request.provider_id)?;
    providers::agent_chat(request, key).await
}

#[tauri::command]
pub async fn list_provider_models(provider_id: String) -> Result<Vec<String>, String> {
    let key = if provider_id == "ollama" {
        None
    } else {
        secrets::get_key(&provider_id)?
    };
    providers::list_models(&provider_id, key).await
}

#[tauri::command]
pub async fn ollama_status() -> OllamaStatus {
    ollama::check().await
}

#[tauri::command]
pub fn ollama_install_url() -> &'static str {
    ollama::install_url()
}

/// Whether `target` is safe to hand to the OS opener. We only permit a short
/// allow-list of URL schemes (http/https/mailto) and treat everything else as a
/// candidate local path. This blocks dangerous schemes a malicious vault link
/// could smuggle in (e.g. `javascript:`, `data:`, `ftp:`, `file://` to an
/// arbitrary target, or custom app schemes). Path existence is validated
/// separately by the caller so this stays pure and unit-testable.
fn external_target_allowed(target: &str) -> bool {
    // A bare scheme like "javascript:..." has a colon before any '/'. Detect the
    // scheme portion and reject anything not on the allow-list. Local paths
    // (no scheme, or a Windows drive letter like `C:\`) fall through to `false`
    // here and are handled as filesystem paths by the caller.
    if let Some(colon) = target.find(':') {
        let scheme = &target[..colon];
        // Windows drive letters (`C:\...`) are paths, not URL schemes. A real
        // scheme is multi-char; a single ASCII-letter "scheme" is a drive.
        let is_drive_letter = scheme.len() == 1 && scheme.chars().all(|c| c.is_ascii_alphabetic());
        if !is_drive_letter {
            return matches!(
                scheme.to_ascii_lowercase().as_str(),
                "http" | "https" | "mailto"
            );
        }
    }
    false
}

/// Opens an external URL in the user's default browser via `open` (macOS),
/// `xdg-open` (Linux), or `start` (Windows). Used by the Ollama setup card
/// to take the user to the install page.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    // Tighten what we hand to the OS opener: a vault link is attacker-controlled
    // content, so only an allow-listed URL scheme (http/https/mailto) or an
    // existing local path may be launched. Anything else (javascript:, data:,
    // ftp:, file:// to arbitrary, custom schemes) is rejected.
    if !external_target_allowed(&url) {
        // Not an allowed URL scheme — treat as a local path and require it to
        // exist, so a wrong/missing path returns an error instead of silently
        // doing nothing, and a disallowed scheme is refused outright.
        if !std::path::Path::new(&url).exists() {
            return Err(format!("refused to open: {url}"));
        }
    }
    let cmd = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(&url).spawn()
    } else if cfg!(target_os = "windows") {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
    } else {
        std::process::Command::new("xdg-open").arg(&url).spawn()
    };
    cmd.map(|_| ()).map_err(|e| format!("open failed: {e}"))
}

#[tauri::command]
pub fn mcp_registration_info(app: tauri::AppHandle, vault_path: String) -> McpRegInfo {
    mcp_server::registration_info(&app, &vault_path)
}

#[tauri::command]
pub async fn mcp_install(app: tauri::AppHandle, _vault_path: String) -> Result<String, String> {
    // vault_path is irrelevant to install (venv is vault-independent) but kept so
    // the frontend call signature is unchanged.
    tauri::async_runtime::spawn_blocking(move || mcp_server::install(&app))
        .await
        .map_err(|e| format!("join failed: {e}"))?
}

#[tauri::command]
pub async fn mcp_register(app: tauri::AppHandle, vault_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || mcp_server::register(&app, &vault_path))
        .await
        .map_err(|e| format!("join failed: {e}"))?
}

/// Start the app-hosted SSE MCP server (idempotent).
#[tauri::command]
pub async fn mcp_serve(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || mcp_server::serve(&app))
        .await
        .map_err(|e| format!("join failed: {e}"))?
}

/// Stop the app-hosted SSE MCP server.
#[tauri::command]
pub fn mcp_stop() -> Result<String, String> {
    mcp_server::stop_sse();
    Ok("MCP server stopped.".into())
}

// ---------------------------------------------------------------------------
// Semantic layer (Feature 1): embed vault pages into an on-disk vector index and
// serve semantic search / related-pages. Embedding runs offline via the bundled
// Gemma model ("builtin-local") or an "ollama" provider; more providers later.
// ---------------------------------------------------------------------------

use crate::embeddings;
use crate::vector_index::{Hit as VecHit, VectorStore};

/// Embed a batch of texts with the chosen provider.
async fn embed_texts(
    app: tauri::AppHandle,
    llm: tauri::State<'_, LocalLlmState>,
    provider: &str,
    model: &str,
    texts: Vec<String>,
) -> Result<Vec<Vec<f32>>, String> {
    match provider {
        "" | "builtin-local" => {
            with_local_llm(app, llm, move |m| m.embed(&texts)).await
        }
        "ollama" => {
            let m = if model.is_empty() { "nomic-embed-text" } else { model };
            embeddings::embed_ollama("http://localhost:11434", m, &texts).await
        }
        other => Err(format!("unsupported embedding provider: {other}")),
    }
}

/// Collect `wiki/**/*.md` pages as (relpath, stem, content).
fn collect_wiki_pages(root: &std::path::Path) -> Vec<(String, String, String)> {
    fn walk(dir: &std::path::Path, root: &std::path::Path, out: &mut Vec<(String, String, String)>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, root, out);
            } else if p.extension().and_then(|x| x.to_str()) == Some("md") {
                if let Ok(content) = std::fs::read_to_string(&p) {
                    let rel = p.strip_prefix(root).unwrap_or(&p).to_string_lossy().replace('\\', "/");
                    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
                    out.push((rel, stem, content));
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(&root.join("wiki"), root, &mut out);
    out
}

/// (Re)build the embedding index for the open vault. Skips pages whose chunk set
/// is unchanged (content hashes match). Returns the number of indexed pages.
#[tauri::command]
pub async fn reindex_embeddings(
    app: tauri::AppHandle,
    vault: tauri::State<'_, VaultRoot>,
    llm: tauri::State<'_, LocalLlmState>,
    provider: String,
    model: String,
) -> Result<usize, String> {
    let root = require_root(&vault)?;
    let index_path = VectorStore::path_for(&root.to_string_lossy())?;
    let mut store = VectorStore::load(&index_path);
    let model_id = format!("{provider}:{model}");
    store.ensure_model(&model_id);

    let pages = collect_wiki_pages(&root);
    let mut present = std::collections::HashSet::new();
    for (rel, stem, content) in &pages {
        present.insert(rel.clone());
        let chunks = embeddings::chunk_page(content);
        if chunks.is_empty() {
            continue;
        }
        let hashes: Vec<u64> = chunks.iter().map(|c| embeddings::content_hash(c)).collect();
        if store.hashes_for(rel) == hashes {
            continue; // unchanged — skip re-embedding
        }
        let vecs = embed_texts(app.clone(), llm.clone(), &provider, &model, chunks).await?;
        let entries: Vec<(u64, Vec<f32>)> = hashes.into_iter().zip(vecs).collect();
        store.upsert_page(rel, stem, entries);
    }
    store.prune(&present);
    store.save(&index_path)?;
    Ok(store.indexed_pages())
}

/// Semantic search: embed the query, return top-`k` chunk hits from the index.
#[tauri::command]
pub async fn semantic_search(
    app: tauri::AppHandle,
    vault: tauri::State<'_, VaultRoot>,
    llm: tauri::State<'_, LocalLlmState>,
    query: String,
    k: usize,
    provider: String,
    model: String,
) -> Result<Vec<VecHit>, String> {
    let root = require_root(&vault)?;
    let index_path = VectorStore::path_for(&root.to_string_lossy())?;
    let store = VectorStore::load(&index_path);
    if store.records.is_empty() {
        return Ok(Vec::new());
    }
    // Stale-index guard: after an embedding-model change (e.g. the bundled
    // model swap) the stored vectors live in a different space than the query
    // embedding — return empty (reads as "reindex needed") instead of cosining
    // across incompatible spaces.
    if store.model != format!("{provider}:{model}") {
        return Ok(Vec::new());
    }
    let mut q = embed_texts(app, llm, &provider, &model, vec![query]).await?;
    let qv = q.pop().unwrap_or_default();
    Ok(store.search(&qv, k.clamp(1, 50)))
}

/// Pages most semantically similar to `page` (no embedding call — uses stored
/// vectors), for the Reader related-notes panel and graph similarity edges.
#[tauri::command]
pub fn related_pages(
    vault: tauri::State<'_, VaultRoot>,
    page: String,
    k: usize,
) -> Result<Vec<VecHit>, String> {
    let root = require_root(&vault)?;
    let index_path = VectorStore::path_for(&root.to_string_lossy())?;
    let store = VectorStore::load(&index_path);
    Ok(store.related(&page, k.clamp(1, 50)))
}

#[derive(serde::Serialize)]
pub struct SemanticEdge {
    pub source: String, // absolute page path (matches graph node ids)
    pub target: String,
    pub score: f32,
}

/// Top-`k` semantic-similarity edges across the vault, for the graph's
/// "semantic links" overlay. Absolute page paths so they align with the
/// wikilink graph's node ids. Undirected pairs are de-duplicated.
#[tauri::command]
pub fn semantic_edges(
    vault: tauri::State<'_, VaultRoot>,
    k: usize,
) -> Result<Vec<SemanticEdge>, String> {
    let root = require_root(&vault)?;
    let index_path = VectorStore::path_for(&root.to_string_lossy())?;
    let store = VectorStore::load(&index_path);
    let abs = |rel: &str| root.join(rel).to_string_lossy().into_owned();
    let pages: std::collections::HashSet<String> =
        store.records.iter().map(|r| r.page.clone()).collect();
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for page in &pages {
        for hit in store.related(page, k.clamp(1, 10)) {
            // Undirected de-dup: order the pair lexically.
            let (a, b) = if page.as_str() < hit.page.as_str() {
                (page.clone(), hit.page.clone())
            } else {
                (hit.page.clone(), page.clone())
            };
            if seen.insert(format!("{a}|{b}")) {
                out.push(SemanticEdge {
                    source: abs(&a),
                    target: abs(&b),
                    score: hit.score,
                });
            }
        }
    }
    Ok(out)
}

#[derive(serde::Serialize)]
pub struct EmbeddingsStatus {
    pub indexed_pages: usize,
    pub model: String,
}

/// Index health for the Settings panel.
#[tauri::command]
pub fn embeddings_status(
    vault: tauri::State<'_, VaultRoot>,
) -> Result<EmbeddingsStatus, String> {
    let root = require_root(&vault)?;
    let index_path = VectorStore::path_for(&root.to_string_lossy())?;
    let store = VectorStore::load(&index_path);
    Ok(EmbeddingsStatus {
        indexed_pages: store.indexed_pages(),
        model: store.model,
    })
}

/// Fetch a YouTube video's caption transcript as plain text (Feature 2). No key;
/// best-effort scrape of the caption track. Errors clearly when captions are
/// absent. The caller ingests the returned text like any pasted source.
#[tauri::command]
pub async fn fetch_youtube_transcript(url: String) -> Result<String, String> {
    crate::youtube::fetch_transcript(&url).await
}

#[cfg(test)]
mod tests {
    use super::external_target_allowed;

    #[test]
    fn allows_safe_url_schemes() {
        assert!(external_target_allowed("https://example.com"));
        assert!(external_target_allowed("http://example.com"));
        assert!(external_target_allowed("mailto:user@example.com"));
    }

    #[test]
    fn scheme_match_is_case_insensitive() {
        assert!(external_target_allowed("HTTPS://example.com"));
        assert!(external_target_allowed("MailTo:user@example.com"));
    }

    #[test]
    fn rejects_dangerous_schemes() {
        assert!(!external_target_allowed("javascript:alert(1)"));
        assert!(!external_target_allowed(
            "data:text/html,<script>alert(1)</script>"
        ));
        assert!(!external_target_allowed("ftp://example.com/file"));
        assert!(!external_target_allowed("file:///etc/passwd"));
        assert!(!external_target_allowed("vscode://open?file=/etc/passwd"));
    }

    #[test]
    fn treats_local_paths_as_not_url_allowed() {
        // Plain paths and Windows drive letters are not URL-allowed; the caller
        // validates them as filesystem paths instead.
        assert!(!external_target_allowed("/usr/local/bin"));
        assert!(!external_target_allowed("relative/path"));
        assert!(!external_target_allowed(r"C:\Users\me\file.txt"));
    }
}
