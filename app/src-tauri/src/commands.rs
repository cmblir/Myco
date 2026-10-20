// Tauri IPC command surface. Each function is a thin adapter that delegates
// to a domain module (vault, parser, index). Keep this file free of business
// logic so the same modules remain unit-testable without Tauri runtime.

use crate::claude::{self, CliResult, CliStatus};
use crate::cli_agent;
use crate::git_log::{self, Commit};
use crate::index::{self, Adjacency};
use crate::local_llm::LocalLlm;
use crate::ollama::{self, OllamaStatus};
use crate::provenance::{self, ProvenanceRow};
use crate::providers::{self, ChatRequest, ChatResponse};
use crate::registry;
use crate::secrets;
use crate::settings::{self, Settings};
use crate::vault::{self, FileContent, FileNode, SearchHit, VaultMeta};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

#[cfg(test)]
#[path = "commands_embedding_admission_tests.rs"]
mod embedding_admission_tests;
#[cfg(test)]
#[path = "commands_scoring_numeric_tests.rs"]
mod scoring_numeric_tests;
use tauri::Manager;

pub use crate::vault_session::{AgentVaultSession, VaultRoot};

pub(crate) fn require_root(state: &tauri::State<VaultRoot>) -> Result<PathBuf, String> {
    state.get().ok_or_else(|| "no vault is open".to_string())
}

fn check_expected_vault(root: &std::path::Path, expected: Option<&str>) -> Result<(), String> {
    if let Some(expected) = expected {
        let expected = std::path::Path::new(expected)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let actual = root.canonicalize().map_err(|e| e.to_string())?;
        if expected != actual {
            return Err("the active vault changed before the action started".into());
        }
    }
    Ok(())
}

/// Lazily-loaded local model host. `None` until the first local_* command;
/// model weights must not tax startup or RAM when the feature is unused. Arc
/// so inference can run on a blocking thread. This hosts only the Korean E5
/// embedder; optional Ask generation has a separate lazy model cell.
#[derive(Default, Clone)]
pub struct LocalLlmState(Arc<Mutex<Option<LocalLlm>>>);

#[cfg(feature = "native-index-probe")]
impl LocalLlmState {
    pub(crate) fn unload_probe_embedding(&self) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|_| "local model lock poisoned".to_string())?
            .take();
        Ok(())
    }
}

/// Seconds-since-epoch of the last `with_local_llm` call — the idle-unload
/// janitor's clock. Process-global (one model cell per process).
static LLM_LAST_USED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn now_epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Whether the janitor should drop the model: loaded, and unused for longer
/// than the idle window. Pure for the test below.
pub(crate) fn llm_should_unload(loaded: bool, last_used: u64, now: u64, idle_secs: u64) -> bool {
    loaded && last_used > 0 && now.saturating_sub(last_used) >= idle_secs
}

/// Drop the local model after 10 idle minutes to release its weights and
/// context buffers. The current GGUF is approximately 42 MB on disk, not a
/// total-process RAM budget. The cost of returning is one lazy reload on
/// the next embed/search, announced on
/// `local-model-load` like any first load. The llama BACKEND token is not
/// touched — it is process-global and deliberately leaked (see
/// `local_llm::shared_backend`).
pub fn spawn_llm_janitor(app: tauri::AppHandle) {
    const IDLE_SECS: u64 = 10 * 60;
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            let cell = app.state::<LocalLlmState>().0.clone();
            let Ok(mut guard) = cell.try_lock() else {
                continue; // in use right now — clearly not idle
            };
            let loaded = guard.is_some();
            let last = LLM_LAST_USED.load(std::sync::atomic::Ordering::Relaxed);
            if llm_should_unload(loaded, last, now_epoch_secs(), IDLE_SECS) {
                *guard = None; // frees the model weights
            }
        }
    });
}

/// Optional local chat-model path: the packaged resource dir, falling back to
/// the source tree in dev. The file is NOT bundled anymore (Ask answers
/// extractively), so a miss is normal — callers load an embed-only host then.
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

/// Whether the bundled chat GGUF exists at all — a cheap `is_file()` check, no
/// model load. Callers that need to complete a builtin-local "query" task use
/// this to fail fast instead of paying for a full retrieval pass (which loads
/// the embedding model) only to hit [`CHAT_MODEL_MISSING`] at the end: no
/// chat GGUF has shipped since Ask went extractive, so that generate call was
/// unconditionally doomed. `runReflect`'s scheduler triggers it automatically
/// a few seconds after every launch, which made the doomed load happen on
/// every launch too.
#[tauri::command]
pub fn local_chat_model_available(app: tauri::AppHandle) -> bool {
    local_model_path(&app).is_ok()
}

/// Path to the bundled purpose-built embedding model (winner of the 1a bake-off).
/// `rel` is the spec's `EmbedSpec.file`, e.g. "models/bge-m3-Q4_K_M.gguf".
fn local_embed_model_path(app: &tauri::AppHandle, rel: &str) -> Result<PathBuf, String> {
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join(rel);
        if p.is_file() {
            return Ok(p);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel);
    if dev.is_file() {
        return Ok(dev);
    }
    Err(format!("bundled embed model not found ({rel})"))
}

/// Emitted around the one-time load of the bundled weights, so the UI can say
/// what the app is doing instead of freezing. `loading` is true when the load
/// starts and false when it finishes, with `ok` reporting whether it worked.
#[derive(Clone, serde::Serialize)]
pub struct ModelLoadEvent {
    pub loading: bool,
    pub ok: bool,
}

/// Run `f` against the lazily-loaded local model on a blocking thread —
/// inference takes seconds and must not stall the async runtime.
///
/// The host starts without weights; embedding callers load only the small E5
/// model. Optional Ask generation has a separate host and idle-unload policy.
async fn with_local_llm<T, F>(
    app: tauri::AppHandle,
    state: tauri::State<'_, LocalLlmState>,
    f: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&mut LocalLlm) -> Result<T, String> + Send + 'static,
{
    use tauri::Emitter;
    let cell = state.0.clone();
    LLM_LAST_USED.store(now_epoch_secs(), std::sync::atomic::Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = cell.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            let _ = app.emit(
                "local-model-load",
                ModelLoadEvent {
                    loading: true,
                    ok: false,
                },
            );
            let loaded = LocalLlm::load_embed_host();
            // Announce the end on the failure path too — a UI that only hears
            // "loading" would show a spinner forever.
            let _ = app.emit(
                "local-model-load",
                ModelLoadEvent {
                    loading: false,
                    ok: loaded.is_ok(),
                },
            );
            *guard = Some(loaded?);
        }
        f(guard.as_mut().expect("just loaded"))
    })
    .await
    .map_err(|e| format!("local model task failed: {e}"))?
}

/// Read-only bounded text preview through the explicitly selected local role.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Flat IPC fields retain explicit opening and role authority.
pub async fn local_query(
    app: tauri::AppHandle,
    vault: tauri::State<'_, VaultRoot>,
    state: tauri::State<'_, crate::local_generation::LocalChatState>,
    prompt: String,
    max_tokens: Option<i32>,
    origin: Option<AgentVaultSession>,
    role_snapshot: Option<crate::role_authorization::RoleSnapshot>,
    request_id: Option<String>,
) -> Result<String, String> {
    let origin = origin.ok_or("local text preview requires a native opening")?;
    let snapshot = role_snapshot.ok_or("local text preview requires a feature role snapshot")?;
    authorized_role(&vault, &origin, &snapshot, snapshot.role, |_| {
        if snapshot.route_signature.provider_id != "builtin-local" {
            return Err("request_route_mismatch: this role is external".into());
        }
        crate::local_model::manifest_for(Some(&snapshot.route_signature.model_id)).map(|_| ())
    })?;
    let request_id = request_id.ok_or("local preview requires a cancellation identity")?;
    let future = crate::local_generation::generate_text(
        app,
        state.inner().clone(),
        &snapshot.route_signature.model_id,
        &request_id,
        "",
        &prompt,
        max_tokens.unwrap_or(320),
    );
    let result = await_authorized(&vault, &origin, &snapshot, snapshot.role, future).await;
    if result.is_err() {
        crate::local_generation::cancel(&request_id);
    }
    result
}

/// Inspect the separately installed Qwen weights without loading the model.
#[tauri::command]
pub async fn local_chat_status(
    model_id: Option<String>,
) -> Result<crate::local_generation::Status, String> {
    crate::local_generation::status(model_id.as_deref()).await
}

/// Download the pinned optional model only after an explicit install action.
#[tauri::command]
pub async fn download_local_chat_model(
    app: tauri::AppHandle,
    model_id: Option<String>,
) -> Result<crate::local_generation::Status, String> {
    crate::local_generation::download(app, model_id.as_deref()).await
}

#[tauri::command]
pub fn cancel_local_chat_model_download() -> bool {
    crate::local_generation::cancel_download()
}

#[tauri::command]
pub fn cancel_local_synthesis(request_id: String) -> bool {
    crate::local_generation::cancel(&request_id)
}

/// Revalidate retrieved source chunks before optional local synthesis.
#[tauri::command]
pub async fn local_synthesize(
    app: tauri::AppHandle,
    vault: tauri::State<'_, VaultRoot>,
    state: tauri::State<'_, crate::local_generation::LocalChatState>,
    bm25_cache: tauri::State<'_, crate::retrieval::Bm25Cache>,
    mut request: crate::local_generation::Request,
) -> Result<crate::local_generation::Answer, String> {
    let origin = request
        .origin
        .clone()
        .ok_or("local Ask requires a native vault opening")?;
    let snapshot = request
        .role_snapshot
        .clone()
        .ok_or("local Ask requires a native foreground role snapshot")?;
    let (root, model) = crate::local_generation::with_ask_role(
        &vault,
        &origin,
        Some(&snapshot),
        request.model_id.as_deref(),
        |root, manifest| {
            check_expected_vault(root, Some(&request.expected_vault))?;
            Ok((root.to_path_buf(), manifest.id))
        },
    )?;
    request.model_id = Some(model.into());
    let request_id = request.request_id.clone();
    #[cfg(feature = "native-index-probe")]
    let probe_app = app.clone();
    let future = async {
        let index = bm25_cache
            .get_async(crate::retrieval::Bm25Index::path_for(
                &root.to_string_lossy(),
            )?)
            .await?;
        crate::local_generation::with_ask_role(
            &vault,
            &origin,
            Some(&snapshot),
            Some(model),
            |_, _| Ok(()),
        )?;
        crate::local_generation::synthesize(app, state.inner().clone(), root, index, request).await
    };
    let result = await_authorized(
        &vault,
        &origin,
        &snapshot,
        crate::role_authorization::RoleId::Ask,
        future,
    )
    .await;
    if result.is_err() {
        crate::local_generation::cancel(&request_id);
    }
    #[cfg(feature = "native-index-probe")]
    crate::native_ask_probe::local_command_returned(&probe_app, result.is_ok());
    result
}

/// Let the selected local foreground Ask model choose a period from recorded dates.
#[tauri::command]
pub async fn local_query_plan(
    app: tauri::AppHandle,
    vault: tauri::State<'_, VaultRoot>,
    state: tauri::State<'_, crate::local_generation::LocalChatState>,
    bm25_cache: tauri::State<'_, crate::retrieval::Bm25Cache>,
    mut request: crate::local_query_plan::Request,
) -> Result<crate::local_query_plan::Plan, String> {
    let origin = request.origin.clone();
    let snapshot = request
        .role_snapshot
        .clone()
        .ok_or("Ask planning requires a native foreground role snapshot")?;
    let (root, model) = crate::local_generation::with_ask_role(
        &vault,
        &origin,
        Some(&snapshot),
        request.model_id.as_deref(),
        |root, manifest| {
            check_expected_vault(root, Some(&request.expected_vault))?;
            Ok((root.to_path_buf(), manifest.id))
        },
    )?;
    request.model_id = Some(model.into());
    let request_id = request.request_id.clone();
    #[cfg(feature = "native-index-probe")]
    let probe_app = app.clone();
    let future = async {
        let index = bm25_cache
            .get_async(crate::retrieval::Bm25Index::path_for(
                &root.to_string_lossy(),
            )?)
            .await?;
        crate::local_generation::with_ask_role(
            &vault,
            &origin,
            Some(&snapshot),
            Some(model),
            |_, _| Ok(()),
        )?;
        crate::local_generation::plan_recall(app, state.inner().clone(), root, index, request).await
    };
    let result = await_authorized(
        &vault,
        &origin,
        &snapshot,
        crate::role_authorization::RoleId::Ask,
        future,
    )
    .await;
    if result.is_err() {
        crate::local_generation::cancel(&request_id);
    }
    #[cfg(feature = "native-index-probe")]
    crate::native_ask_probe::local_command_returned(&probe_app, result.is_ok());
    result
}

/// Generate a read-only preview from revision-verified source chunks.
#[tauri::command]
pub async fn local_transform(
    app: tauri::AppHandle,
    vault: tauri::State<'_, VaultRoot>,
    state: tauri::State<'_, crate::local_generation::LocalChatState>,
    mut request: crate::local_transform::Request,
) -> Result<crate::local_generation::Answer, String> {
    use crate::role_authorization::RoleId;
    let origin = request
        .origin
        .clone()
        .ok_or("local preview requires a native opening")?;
    let snapshot = request
        .role_snapshot
        .clone()
        .ok_or("local preview requires a feature role snapshot")?;
    let role = match request.kind {
        crate::local_transform::Kind::Ingest => RoleId::Compilation,
        crate::local_transform::Kind::Organize => RoleId::Organization,
    };
    let check = |root: &std::path::Path| {
        check_expected_vault(root, Some(&request.expected_vault))?;
        if snapshot.route_signature.provider_id != "builtin-local"
            || request
                .model_id
                .as_deref()
                .is_some_and(|id| id != snapshot.route_signature.model_id)
        {
            return Err(
                "request_route_mismatch: local preview model differs from selected role".into(),
            );
        }
        if let Some(context) = &request.session_compile {
            if serde_json::to_value(&context.role_snapshot).map_err(|e| e.to_string())?
                != serde_json::to_value(&snapshot).map_err(|e| e.to_string())?
                || context.origin.vault_path != origin.vault_path
                || context.origin.opening_token != origin.opening_token
            {
                return Err("session preview grant does not match its native attempt".into());
            }
            crate::session_compile::authorize_attempt_at(root, &origin, context)?;
        }
        Ok(root.to_path_buf())
    };
    let root = authorized_role(&vault, &origin, &snapshot, role, check)?;
    request.model_id = Some(snapshot.route_signature.model_id.clone());
    let context = request.session_compile.clone();
    let answer =
        crate::local_generation::transform(app, state.inner().clone(), root, request).await?;
    authorized_role(&vault, &origin, &snapshot, role, |root| {
        if let Some(context) = &context {
            crate::session_compile::authorize_attempt_at(root, &origin, context)?;
        }
        Ok(answer)
    })
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
    let opening = state.begin_open()?;
    let meta = vault::open_vault(&path)?;
    // M6: move this vault's `.memex/` state directory to `.myco/` BEFORE anything
    // reads out of it — the launchd migration below loads schedules.json from it,
    // and the index updater rebinds against it. Best effort: a vault whose state
    // could not be moved still opens, it just keeps using the old directory.
    match crate::vault_dir::migrate(std::path::Path::new(&meta.path)) {
        Ok(true) => eprintln!(
            "vault state moved: {} -> {}",
            crate::vault_dir::LEGACY_DIR_NAME,
            crate::vault_dir::DIR_NAME
        ),
        Ok(false) => {}
        Err(e) => eprintln!("vault state migration skipped: {e}"),
    }
    // meta.path is canonical; record it as the confinement root for fs commands.
    let origin = AgentVaultSession {
        vault_path: meta.path.clone(),
        opening_token: crate::vault_session::opening_token(opening)?,
    };
    state.finish_open(opening, PathBuf::from(&meta.path), || {
        // Let the preview load this vault's images through the asset protocol —
        // the same trust boundary read_file already grants the webview.
        if let Err(e) = app.asset_protocol_scope().allow_directory(&meta.path, true) {
            eprintln!("asset scope: {e}");
        }
        // Rebind the background index updater to the newly-opened vault, so it
        // watches the right wiki/ and catches up a fresh/stale index.
        if let Some(u) = crate::INDEX_UPDATER.get() {
            u.rebind(origin);
        }
        // Keep the active marker for external automation (best-effort: marker
        // failure must not block opening). Native MCP sessions use the opening
        // snapshot instead and must reinitialize after this transition.
        let _ = settings::set_active_vault(&path);
        // M3: this vault's background digests may still be installed under the
        // pre-rename LaunchAgent label. Re-install them under the new label (the old
        // agent is booted out and deleted only once the new one is loaded, so
        // digests neither fire twice nor stop firing).
        // Skipped when python3 or the digest runner can't be resolved — better to
        // leave the old agent working than to remove it with no replacement.
        //
        // The cheap plist check gates the expensive one: `locate_bin` spawns a
        // LOGIN shell to find python3, and it used to do so on EVERY open_vault
        // even though almost no vault has a legacy plist (closes DEFERRED I5).
        #[cfg(target_os = "macos")]
        if crate::schedules::has_legacy_agents(std::path::Path::new(&meta.path)) {
            if let (Some(python), Ok(script)) = (
                claude::locate_bin("python3", "MYCO_PYTHON_PATH"),
                digest_script_path(&app),
            ) {
                for warning in crate::schedules::migrate_legacy_agents(
                    std::path::Path::new(&meta.path),
                    &python,
                    &script,
                ) {
                    eprintln!("launchd migration: {warning}");
                }
            }
        }
    })?;
    Ok(meta)
}

async fn run_file_task<T, F>(label: &'static str, task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| format!("{label} task failed: {e}"))?
}

/// Closing invalidates every captured native opening, including queued work.
#[tauri::command]
pub fn close_vault(state: tauri::State<VaultRoot>) -> Result<(), String> {
    state.close()?;
    if let Some(updater) = crate::INDEX_UPDATER.get() {
        updater.unbind();
    }
    Ok(())
}

#[tauri::command]
pub async fn ensure_default_vault() -> Result<String, String> {
    run_file_task("default vault", vault::ensure_default_vault).await
}

/// First-run offer (M10): fill a picked-but-empty vault with the demo notes.
/// Refuses when `wiki/` already has pages — seeding is for empty vaults only.
#[tauri::command]
pub fn seed_sample_vault(state: tauri::State<VaultRoot>, vault: String) -> Result<(), String> {
    let root = confine_root(&state, &vault)?;
    vault::seed_sample(std::path::Path::new(&root))
}

/// The vault's file tree.
///
/// Async: this is the other leg of the 4-second refresh poll, and the one the
/// vault fingerprint cannot short-circuit — the fingerprint covers .md files,
/// while the tree also shows folders, so gating it would stop a new empty folder
/// from ever appearing. It walks the whole vault every tick, so it belongs off
/// the event loop.
#[tauri::command]
pub async fn list_files(
    state: tauri::State<'_, VaultRoot>,
    root: String,
) -> Result<Vec<FileNode>, String> {
    let root = confine_root(&state, &root)?;
    tauri::async_runtime::spawn_blocking(move || vault::list_files(&root))
        .await
        .map_err(|e| format!("join failed: {e}"))?
}

#[tauri::command]
pub async fn file_mtimes(
    state: tauri::State<'_, VaultRoot>,
    root: String,
) -> Result<Vec<(String, i64)>, String> {
    let root = confine_root(&state, &root)?;
    tauri::async_runtime::spawn_blocking(move || vault::file_mtimes(&root))
        .await
        .map_err(|e| format!("file mtimes task failed: {e}"))?
}

#[tauri::command]
pub async fn read_file(
    state: tauri::State<'_, VaultRoot>,
    path: String,
) -> Result<FileContent, String> {
    let root = require_root(&state)?;
    run_file_task("read file", move || {
        let p = vault::confine_path(&root, &path)?;
        vault::read_file(&p.to_string_lossy())
    })
    .await
}

/// Read an editor's full raw baseline under its captured native opening.
#[tauri::command]
pub async fn read_editor_file(
    app: tauri::AppHandle,
    path: String,
    origin: AgentVaultSession,
) -> Result<crate::editor_io::ReadReceipt, String> {
    run_file_task("read editor file", move || {
        crate::editor_io::read(&app.state::<VaultRoot>(), &path, &origin)
    })
    .await
}

/// Save only the editor's first baseline and return its actual persisted revision.
#[tauri::command]
pub async fn write_editor_file(
    app: tauri::AppHandle,
    path: String,
    content: String,
    expected_sha256: String,
    origin: AgentVaultSession,
) -> Result<crate::editor_io::WriteReceipt, String> {
    run_file_task("write editor file", move || {
        crate::editor_io::write(
            &app.state::<VaultRoot>(),
            &path,
            &content,
            &expected_sha256,
            &origin,
        )
    })
    .await
}

/// Report whether this native target can bind a durable journal to its vault object.
#[tauri::command]
pub fn editor_recovery_supported() -> bool {
    // The journal key currently binds the Unix device/inode of the vault root.
    cfg!(unix)
}

/// Checkpoint an editor draft against its native full baseline before saving.
#[tauri::command]
pub async fn stage_editor_draft(
    app: tauri::AppHandle,
    path: String,
    expected_sha256: String,
    draft: String,
    origin: AgentVaultSession,
    expected_journal_revision: Option<String>,
) -> Result<crate::editor_recovery::RecoveryDraft, String> {
    run_file_task("stage editor draft", move || {
        crate::editor_recovery::stage(
            &app.state::<VaultRoot>(),
            &path,
            &expected_sha256,
            &draft,
            &origin,
            expected_journal_revision.as_deref(),
        )
    })
    .await
}

/// Discover a saved draft as recovery data, without refreshing its write origin.
#[tauri::command]
pub async fn read_editor_draft(
    app: tauri::AppHandle,
    path: String,
    origin: AgentVaultSession,
) -> Result<Option<crate::editor_recovery::RecoveryDraft>, String> {
    run_file_task("read editor draft", move || {
        crate::editor_recovery::load(&app.state::<VaultRoot>(), &path, &origin)
    })
    .await
}

/// Retire exactly the acknowledged journal revision after save or user recovery.
#[tauri::command]
pub async fn retire_editor_draft(
    app: tauri::AppHandle,
    path: String,
    origin: AgentVaultSession,
    expected_journal_revision: String,
) -> Result<(), String> {
    run_file_task("retire editor draft", move || {
        crate::editor_recovery::retire(
            &app.state::<VaultRoot>(),
            &path,
            &origin,
            &expected_journal_revision,
        )
    })
    .await
}

/// Serve the raw bytes of a source file under the vault's `raw/` tree, for the
/// in-app PDF viewer (Feature 6). Path-confined to `raw/` (rejects `../` and any
/// path outside it) and size-capped, so it can neither escape the vault nor OOM
/// the app. Returns raw bytes (JS receives an ArrayBuffer) — never a file:// URL.
#[tauri::command]
pub async fn read_raw_bytes(
    state: tauri::State<'_, VaultRoot>,
    relpath: String,
) -> Result<tauri::ipc::Response, String> {
    const MAX_PDF_BYTES: u64 = 100 * 1024 * 1024;
    let root = require_root(&state)?;
    let bytes = run_file_task("read raw bytes", move || {
        vault::read_confined_raw(&root, &relpath, MAX_PDF_BYTES)
    })
    .await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Save pasted image bytes under the vault's `assets/`. Raw-body twin of
/// read_raw_bytes: the body is the file, the name rides in `x-myco-name`.
#[tauri::command]
pub fn write_asset(
    state: tauri::State<VaultRoot>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let root = require_root(&state)?;
    let name = request
        .headers()
        .get("x-myco-name")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing x-myco-name header")?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected a raw body".into());
    };
    vault::write_asset(&root, name, bytes)
}

/// Copy a Finder-dropped image into the vault's `assets/` (drop twin of
/// write_asset: the file already has a path, so no raw body crosses IPC).
#[tauri::command]
pub fn copy_asset(
    state: tauri::State<VaultRoot>,
    name: String,
    src: String,
) -> Result<String, String> {
    let root = require_root(&state)?;
    vault::copy_asset(&root, &name, &src)
}

/// Concatenate vault markdown (CLAUDE.md + wiki/ + raw/) up to `max_bytes`,
/// so non-tool LLM providers can answer queries / run lint against real vault
/// content (the Claude CLI reads files itself and does not use this).
#[tauri::command]
pub async fn read_vault_context(
    state: tauri::State<'_, VaultRoot>,
    root: String,
    max_bytes: usize,
) -> Result<String, String> {
    let root = confine_root(&state, &root)?;
    run_file_task("read vault context", move || {
        vault::read_vault_context(&root, max_bytes)
    })
    .await
}

#[tauri::command]
pub fn write_file(
    state: tauri::State<VaultRoot>,
    path: String,
    content: String,
) -> Result<(), String> {
    let root = require_root(&state)?;
    write_file_at(&root, &path, &content)
}

fn write_file_at(root: &std::path::Path, path: &str, content: &str) -> Result<(), String> {
    let p = vault::confine_path(root, path)?;
    // raw/ is immutable: a source may be CREATED (that is how ingest files an
    // original) but never modified. Refuse a write that would overwrite an
    // existing raw/ file. agent_tools already blocks the agent from raw/ writes
    // entirely; this closes the same rule at the direct command layer.
    if vault::is_raw_path(root, &p) && p.exists() {
        return Err("refused: raw/ is immutable — an existing source cannot be overwritten".into());
    }
    if vault::is_raw_path(root, &p) {
        // Recheck absence under the writer lock so concurrent creators cannot
        // overwrite an immutable source after the check above.
        vault::write_file_if_unchanged(&p.to_string_lossy(), content, None)?;
    } else {
        vault::write_file(&p.to_string_lossy(), content)?;
    }
    if let Some(u) = crate::INDEX_UPDATER.get() {
        if let Ok(rel) = p.strip_prefix(root) {
            u.mark_dirty(root, rel.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
}

/// Save a derived note only if its exact previously read content still exists.
#[tauri::command]
pub fn write_file_if_unchanged(
    state: tauri::State<VaultRoot>,
    path: String,
    content: String,
    expected_sha256: Option<String>,
) -> Result<(), String> {
    let root = require_root(&state)?;
    write_file_if_unchanged_at_impl(
        &root,
        &path,
        &content,
        expected_sha256.as_deref(),
        #[cfg(test)]
        || {},
    )
}

fn write_file_if_unchanged_at_impl(
    root: &std::path::Path,
    path: &str,
    content: &str,
    expected_sha256: Option<&str>,
    #[cfg(test)] before_lock: impl FnOnce(),
) -> Result<(), String> {
    let receipt = vault::with_root_mutation_impl(
        root,
        |canonical_root, guard| {
            let p = vault::confine_mutation_path(canonical_root, root, path)?;
            if vault::is_raw_path(canonical_root, &p) {
                return Err(
                    "refused: raw/ is immutable — conditional writes are for derived notes".into(),
                );
            }
            vault::write_file_if_unchanged_recorded_locked(
                guard,
                &p.to_string_lossy(),
                content,
                expected_sha256,
            )
        },
        #[cfg(test)]
        before_lock,
    )?;
    if let Some(u) = crate::INDEX_UPDATER.get() {
        if let Ok(rel) = receipt.path.strip_prefix(root) {
            u.mark_dirty(root, rel.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
}

/// Describe a selected external image under its foreground Compilation grant.
#[tauri::command]
pub async fn describe_image(
    state: tauri::State<'_, VaultRoot>,
    images: tauri::State<'_, crate::image_ingest::ImageIngestState>,
    request: crate::image_ingest::DescribeImageRequest,
) -> Result<String, crate::image_ingest::Failure> {
    describe_image_authorized(&state, &images, request).await
}

/// Public bridge core shared with synthetic no-send and transport regressions.
pub(crate) async fn describe_image_authorized(
    vault: &VaultRoot,
    images: &crate::image_ingest::ImageIngestState,
    request: crate::image_ingest::DescribeImageRequest,
) -> Result<String, crate::image_ingest::Failure> {
    use crate::role_authorization::{RoleId, RoleUsage};
    let origin = request.origin.clone();
    let snapshot = request.role_snapshot.clone();
    if snapshot.role != RoleId::Compilation || snapshot.usage != RoleUsage::Foreground {
        return Err(crate::image_ingest::FailureCode::RoleAuthorizationFailed.into());
    }
    let future = crate::image_ingest::run(images, request, || {
        authorized_role(vault, &origin, &snapshot, RoleId::Compilation, |_| Ok(()))
            .map_err(crate::image_ingest::Failure::from)
    });
    await_authorized_typed(vault, &origin, &snapshot, RoleId::Compilation, future).await
}

/// Accept cancellation only for a request owned by the supplied native opening.
#[tauri::command]
pub fn cancel_image_ingest(
    state: tauri::State<VaultRoot>,
    images: tauri::State<crate::image_ingest::ImageIngestState>,
    origin: AgentVaultSession,
    request_id: String,
) -> Result<bool, crate::image_ingest::Failure> {
    cancel_image_ingest_authorized(&state, &images, &origin, &request_id)
}

pub(crate) fn cancel_image_ingest_authorized(
    vault: &VaultRoot,
    images: &crate::image_ingest::ImageIngestState,
    origin: &AgentVaultSession,
    request_id: &str,
) -> Result<bool, crate::image_ingest::Failure> {
    vault
        .with_origin(origin, |_| Ok(images.cancel(origin, request_id)))
        .map_err(crate::image_ingest::Failure::from)?
}

/// Whether a whisper CLI is installed (gates the media-ingest affordance).
#[tauri::command]
pub async fn whisper_check() -> Result<CliStatus, String> {
    run_file_task("Whisper CLI status", || Ok(crate::whisper::check())).await
}

/// Transcribe an audio/video file with the bundled whisper (or a PATH one).
/// Runs off the async pool so the long transcription doesn't block the UI.
#[tauri::command]
pub async fn transcribe_media(app: tauri::AppHandle, path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || crate::whisper::transcribe_auto(&app, &path))
        .await
        .map_err(|e| format!("transcription task failed: {e}"))?
}

// ---- voice quick-capture (W3–6 item 9) -------------------------------------

/// `_inbox/` source doc for a voice capture. Frontmatter mirrors clip.rs
/// (`source`/`title` via `yaml_str`, `created` as a unix int) so provenance
/// and distill ingest it unchanged. The title is the transcript's opening
/// words — a voice memo has no better name.
///
/// `related` is ADDITIVE on top of the clip contract: the wiki stems whose
/// content the transcript echoes (dense lookup at save time), so whichever
/// consumer picks the note up first — auto-ingest or the distill gate — gets
/// the routing hint for free. Empty = the key is omitted and the frontmatter
/// is byte-identical to the pre-related format.
/// The transcript's first non-blank line, capped at 80 chars: the voice
/// note's title and the line its receipt shows.
fn voice_first_line(transcript: &str) -> String {
    let first = transcript
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    first.chars().take(80).collect()
}

pub(crate) fn voice_markdown(transcript: &str, captured_at: i64, related: &[String]) -> String {
    let first = voice_first_line(transcript);
    let title = if first.is_empty() {
        "Voice note".to_string()
    } else {
        first
    };
    let mut related_block = String::new();
    if !related.is_empty() {
        related_block.push_str("related:\n");
        for stem in related {
            related_block.push_str(&format!("  - {}\n", crate::clip::yaml_str(stem)));
        }
    }
    format!(
        "---\nsource: voice\ntitle: {}\ncreated: {captured_at}\n{related_block}---\n\n{}\n",
        crate::clip::yaml_str(&title),
        transcript.trim_end(),
    )
}

/// First free `_inbox/voice-<YYYY-MM-DD-HHMM>.md` under `root` — a `-2`,
/// `-3`… suffix when captures land in the same minute.
pub(crate) fn voice_inbox_rel(root: &std::path::Path, now: i64) -> String {
    let (y, mo, d, hh, mi, _) = crate::distill::civil_datetime(now);
    let base = format!("_inbox/voice-{y:04}-{mo:02}-{d:02}-{hh:02}{mi:02}");
    let mut rel = format!("{base}.md");
    let mut n = 2;
    while root.join(&rel).exists() {
        rel = format!("{base}-{n}.md");
        n += 1;
    }
    rel
}

/// The recording arrives as bytes from the webview — cap it like the other
/// media commands (voice memos are tiny; anything near this is not one).
const MAX_VOICE_BYTES: usize = 50 * 1024 * 1024;

#[derive(Clone, serde::Serialize)]
pub struct VoiceSaved {
    pub rel: String,
    /// What was heard, for the receipt; "" when nothing was.
    pub first_line: String,
}

/// Cosine floor for a "related page" suggestion on a voice note — the same
/// measured relevance floor Ask uses to reject irrelevant hits (chat.ts
/// RELEVANCE_FLOOR, e5-small-ko abstention probe). Below it a suggestion is
/// noise, and a wrong "related" line teaches the user to ignore the feature.
const VOICE_RELATED_FLOOR: f32 = 0.42;
/// How many related stems a voice note carries at most.
const VOICE_RELATED_K: usize = 3;

/// Emitted by `save_voice_capture` at the start of each phase
/// (`{ stage: "transcribing" | "saving" }`) so the spotlight can name what
/// it is waiting on — whisper's own `-pp` progress only starts once the model
/// is loaded, which left a bare "…" for most of the wait.
const VOICE_STAGE_EVENT: &str = "voice-capture-stage";

fn emit_voice_stage(app: &tauri::AppHandle, stage: &str) {
    use tauri::Emitter;
    let _ = app.emit(VOICE_STAGE_EVENT, serde_json::json!({ "stage": stage }));
}

/// Blocking transcription half of `save_voice_capture`: temp audio file
/// (cli_agent.rs's `myco-<purpose>-<pid>-<nanos>` pattern) → whisper →
/// transcript. Writes nothing to the vault. The whisper check runs FIRST so
/// a missing CLI writes nothing at all, and the temp file is deleted on
/// every path (success and transcription failure). `quiet` skips whisper's
/// progress events (live-caption partials, which must not drive the meter).
fn transcribe_voice_core(
    app: &tauri::AppHandle,
    bytes: &[u8],
    quiet: bool,
) -> Result<String, String> {
    if !crate::whisper::check().installed {
        return Err("whisper-missing".to_string());
    }
    if bytes.is_empty() {
        return Err("empty recording".to_string());
    }
    if bytes.len() > MAX_VOICE_BYTES {
        return Err("recording is too large (limit 50 MB)".to_string());
    }
    let tmp = std::env::temp_dir().join(format!(
        // .wav since the webview records WAV itself (wavRecorder.ts) — the
        // bundled whisper.cpp cannot read MediaRecorder's AAC-in-MP4.
        "myco-voice-{}-{}.wav",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::write(&tmp, bytes).map_err(|e| format!("write temp audio: {e}"))?;
    let path = tmp.to_string_lossy();
    let transcribed = if quiet {
        crate::whisper::transcribe_quiet(app, &path)
    } else {
        crate::whisper::transcribe(app, &path)
    };
    let _ = std::fs::remove_file(&tmp);
    transcribed
}

/// Live captions while a voice memo records: the webview snapshots the WAV
/// so far every few seconds and asks for its plain transcript. Raw body like
/// `write_asset` (a 45 s take is ~1.4 MB — too much for a JSON number
/// array every tick). Writes nothing and needs no vault.
///
/// `spawn_blocking` like `save_voice_capture`, NOT `command(async)`: that
/// runs the sync body inline on a tokio worker, and on first voice use
/// `ensure_builtin_model`'s `block_on` inside the runtime panics — the invoke
/// promise then never settles, `startPartialLoop`'s `busy` flag stays true,
/// and captions are dead for the rest of the take.
#[tauri::command]
pub async fn transcribe_partial(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected a raw body".into());
    };
    // Copied out because the request borrows the invoke, which cannot outlive
    // this frame while the blocking half runs on another thread.
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || transcribe_voice_core(&app, &bytes, true))
        .await
        .map_err(|e| format!("join failed: {e}"))?
}

/// Blocking write half: `_inbox/voice-<date>.md` carrying the transcript;
/// `related:` is stamped afterwards by `stamp_related`.
fn write_voice_note(root: &std::path::Path, transcript: &str) -> Result<VoiceSaved, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let rel = voice_inbox_rel(root, now);
    let path = crate::myco_pro::safe_join(root, &rel)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create _inbox: {e}"))?;
    }
    std::fs::write(&path, voice_markdown(transcript, now, &[]))
        .map_err(|e| format!("write voice note: {e}"))?;
    crate::inflow_log::record(root, "voice", "capture");
    Ok(VoiceSaved {
        rel,
        first_line: voice_first_line(transcript),
    })
}

/// Replace (or add) the `related:` sequence in a voice note's frontmatter,
/// producing exactly what `voice_markdown` would have written with the same
/// stems — the block sits last, right before the closing `---`. Idempotent;
/// an empty list leaves the file untouched.
pub(crate) fn stamp_related(path: &std::path::Path, related: &[String]) -> Result<(), String> {
    if related.is_empty() {
        return Ok(());
    }
    let text = std::fs::read_to_string(path).map_err(|e| format!("read voice note: {e}"))?;
    let rest = text
        .strip_prefix("---\n")
        .ok_or("voice note has no frontmatter")?;
    let end = rest
        .find("\n---\n")
        .ok_or("voice note frontmatter is unterminated")?;
    let mut kept = String::new();
    let mut in_related = false;
    for line in rest[..end].lines() {
        if line == "related:" {
            in_related = true;
            continue;
        }
        if in_related && line.starts_with("  - ") {
            continue;
        }
        in_related = false;
        kept.push_str(line);
        kept.push('\n');
    }
    kept.push_str("related:\n");
    for stem in related {
        kept.push_str(&format!("  - {}\n", crate::clip::yaml_str(stem)));
    }
    // Atomic: a crash mid-rewrite must not truncate the just-saved memo.
    crate::settings::atomic_write(path, format!("---\n{kept}{}", &rest[end + 1..]).as_bytes())
        .map_err(|e| format!("write voice note: {e}"))
}

/// Save a spotlight voice capture into the OPEN vault's `_inbox/`. Takes no
/// vault arg: the spotlight webview has no vault open to name, so the target
/// is `require_root` — the same root every other write command confines to.
/// `Err("whisper-missing")` before anything is written when no whisper CLI is
/// on PATH; the frontend shows install copy and stays in ask mode.
///
/// Returns as soon as the transcript is on disk. The related-pages lookup
/// (`wikify_candidates`: cold embed-model load + vector store + embedding)
/// used to sit between transcription and the write and dominated the wait —
/// whisper itself does a 13 s clip in ~2 s here. It now runs in a detached
/// task that patches the note's `related:` afterwards. Advisory only: any
/// failure is logged and the memo is already safe, because a voice memo is
/// unreproducible and must never be lost to a suggestion.
#[tauri::command]
pub async fn save_voice_capture(
    app: tauri::AppHandle,
    state: tauri::State<'_, VaultRoot>,
    bytes: Vec<u8>,
) -> Result<VoiceSaved, String> {
    let root = require_root(&state)?;
    emit_voice_stage(&app, "transcribing");
    let transcribe_app = app.clone();
    let transcript = tauri::async_runtime::spawn_blocking(move || {
        transcribe_voice_core(&transcribe_app, &bytes, false)
    })
    .await
    .map_err(|e| format!("join failed: {e}"))??;
    emit_voice_stage(&app, "saving");
    let write_root = root.clone();
    let write_transcript = transcript.clone();
    let saved = tauri::async_runtime::spawn_blocking(move || {
        write_voice_note(&write_root, &write_transcript)
    })
    .await
    .map_err(|e| format!("join failed: {e}"))??;
    let note_path = crate::myco_pro::safe_join(&root, &saved.rel)?;
    tauri::async_runtime::spawn(async move {
        let related: Vec<String> = match wikify_candidates(
            app.clone(),
            app.state(),
            app.state(),
            app.state(),
            transcript,
            VOICE_RELATED_K,
        )
        .await
        {
            Ok(cands) => cands
                .into_iter()
                .filter(|c| c.score >= VOICE_RELATED_FLOOR)
                .map(|c| c.stem)
                .collect(),
            Err(e) => {
                eprintln!("voice: related lookup skipped: {e}");
                return;
            }
        };
        if let Err(e) = stamp_related(&note_path, &related) {
            eprintln!("voice: related stamp failed: {e}");
        }
    });
    Ok(saved)
}

// ---- notch quick text capture (notch S7) ------------------------------------

/// Append one `- HH:MM <text>` line to the LOCAL day's `daily/YYYY-MM-DD.md`,
/// seeding a missing file with its `# date` heading — the exact convention
/// PageTasks' addTask + taskLine::appendTaskLine established (trailing
/// whitespace collapsed to exactly one newline before the append).
/// `tz_offset_min` is the webview's local-time offset: daily notes bucket on
/// the user's calendar day (taskLine::today is local), and Rust std only
/// knows UTC. Returns what was written, for `myco://daily-captured`.
pub(crate) fn capture_note_at(
    root: &std::path::Path,
    text: &str,
    source: Option<&str>,
    now_utc: i64,
    tz_offset_min: i32,
) -> Result<Captured, String> {
    // One line only: the field is a single-line input, but IPC is a boundary —
    // collapsing all whitespace keeps a hostile payload from injecting lines.
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return Err("empty capture".into());
    }
    // Real offsets live within ±14h; anything else is a broken caller.
    if !(-16 * 60..=16 * 60).contains(&tz_offset_min) {
        return Err(format!("implausible tz offset: {tz_offset_min}"));
    }
    let local = now_utc + i64::from(tz_offset_min) * 60;
    let (y, mo, d, hh, mi, _) = crate::distill::civil_datetime(local);
    let day = format!("{y:04}-{mo:02}-{d:02}");
    let rel = format!("daily/{day}.md");
    let path = crate::myco_pro::safe_join(root, &rel)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create daily/: {e}"))?;
    }
    // NotFound seeds; any other read error must NOT fall through to a write
    // that would replace a file we could not read.
    let existing = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => format!("# {day}\n\n"),
        Err(e) => return Err(format!("read {rel}: {e}")),
    };
    let line = format!("- {hh:02}:{mi:02} {text}");
    let footnote = source
        .and_then(|s| quote_footnote(root, &text, s))
        // Once per note: a label the note already defines is left alone.
        .filter(|def| {
            let label = def.split_once(' ').map_or(def.as_str(), |(l, _)| l);
            !existing.lines().any(|l| l.starts_with(label))
        });
    let content = append_capture(existing.trim_end(), &line, footnote.as_deref());
    std::fs::write(&path, content).map_err(|e| format!("write {rel}: {e}"))?;
    Ok(Captured {
        rel,
        line,
        footnote,
    })
}

/// `body` (trimmed) with `line` appended, kept above the note's closing
/// footnote definitions so those stay at the bottom; a new `footnote` joins
/// them. The blank line before the definitions keeps them out of the list.
/// Mirrored by dailyNote.ts appendCapture.
fn append_capture(body: &str, line: &str, footnote: Option<&str>) -> String {
    let is_def = |l: &str| l.starts_with("[^") && l.contains("]:");
    let lines: Vec<&str> = body.lines().collect();
    let mut cut = lines.len();
    while cut > 0 && (is_def(lines[cut - 1]) || lines[cut - 1].trim().is_empty()) {
        cut -= 1;
    }
    while cut < lines.len() && lines[cut].trim().is_empty() {
        cut += 1;
    }
    let mut defs: Vec<&str> = if cut > 0 && cut < lines.len() && lines[cut - 1].trim().is_empty() {
        lines[cut..].to_vec()
    } else {
        cut = lines.len();
        Vec::new()
    };
    defs.extend(footnote);
    let head = lines[..cut].join("\n");
    let head = head.trim_end();
    let mut out = if head.is_empty() {
        format!("{line}\n")
    } else {
        format!("{head}\n{line}\n")
    };
    if !defs.is_empty() {
        out.push_str(&format!("\n{}\n", defs.join("\n")));
    }
    out
}

/// Default 8: the `[^src-<stem>]: raw/<rel>` definition a quote from a raw/
/// original needs, so its citation renders. None unless `source` is an existing
/// file under raw/ whose stem is a footnote label the text actually cites.
fn quote_footnote(root: &std::path::Path, text: &str, source: &str) -> Option<String> {
    if !source.starts_with("raw/") || source.chars().any(char::is_control) {
        return None;
    }
    if !crate::myco_pro::safe_join(root, source).ok()?.is_file() {
        return None;
    }
    let stem = std::path::Path::new(source).file_stem()?.to_str()?;
    let is_label = stem
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '-');
    let cite = format!("[^src-{stem}]");
    (is_label && text.contains(&cite)).then(|| format!("{cite}: {source}"))
}

/// One capture: the payload of `myco://daily-captured`.
#[derive(Clone, serde::Serialize)]
pub(crate) struct Captured {
    /// Vault-relative daily-note path.
    pub rel: String,
    /// The `- HH:MM text` line appended, without its newline.
    pub line: String,
    /// The quote's footnote definition, when this capture wrote it (Default 8).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub footnote: Option<String>,
}

/// Notch S7 quick capture (⏎ in the notch input). Vault-required like every
/// other write — the notch webview never learns the vault path. Returns the
/// path and the line written, so the caller's Open can show that line.
/// `source` is the vault-relative raw/ original a quote cites (S41), so the
/// note also gets that citation's footnote definition.
#[tauri::command]
pub fn capture_note(
    app: tauri::AppHandle,
    state: tauri::State<VaultRoot>,
    text: String,
    source: Option<String>,
    tz_offset_min: i32,
) -> Result<Captured, String> {
    let root = require_root(&state)?;
    // One quick line is the feature; a megabyte through this door is a bug or
    // an abuse of the IPC boundary. 4 KiB fits any real capture.
    if text.len() > 4096 {
        return Err("capture too long (limit 4 KiB) — use a note instead".into());
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let captured = capture_note_at(&root, &text, source.as_deref(), now, tz_offset_min)?;
    if let Some(u) = crate::INDEX_UPDATER.get() {
        u.mark_dirty(&root, captured.rel.clone());
    }
    // The note may be open in the main window (Home beside it in split view,
    // or a capture from the notch): its reader takes the line, or its next
    // autosave would write the stale buffer over it.
    use tauri::Emitter;
    let _ = app.emit("myco://daily-captured", &captured);
    Ok(captured)
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
    create_file_at(&root, &parent, &name)
}

fn create_file_at(root: &std::path::Path, parent: &str, name: &str) -> Result<String, String> {
    let p = vault::confine_parent(root, parent)?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("canonicalize creation vault: {error}"))?;
    // Seed the required frontmatter for a new wiki page so it is visible to
    // Views, gap buckets and the graph from the moment it exists; daily notes
    // and other files stay empty.
    let target = p.join(name);
    let content = if vault::should_seed_frontmatter(&canonical_root, &target) {
        let stem = name.strip_suffix(".md").unwrap_or(name);
        vault::wiki_page_stub(stem, &registry::today_utc())
    } else {
        String::new()
    };
    let created = vault::create_file_checked_at(root, parent, name, &content)?;
    if let Some(u) = crate::INDEX_UPDATER.get() {
        if let Ok(rel) = std::path::Path::new(&created).strip_prefix(&canonical_root) {
            u.mark_dirty(&canonical_root, rel.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(created)
}

#[tauri::command]
pub fn create_folder(
    state: tauri::State<VaultRoot>,
    parent: String,
    name: String,
) -> Result<String, String> {
    let root = require_root(&state)?;
    create_folder_at(&root, &parent, &name)
}

fn create_folder_at(root: &std::path::Path, parent: &str, name: &str) -> Result<String, String> {
    vault::create_folder_checked_at(root, parent, name)
}

#[tauri::command]
pub fn delete_path(
    state: tauri::State<VaultRoot>,
    path: String,
    expected_permanent: Option<bool>,
) -> Result<(), String> {
    let origin = state.snapshot()?;
    state.with_origin(&origin, |root| {
        crate::editor_recovery::assert_no_pending_at(root, &path)?;
        delete_path_at(root, path, expected_permanent)
    })
}

fn delete_path_at(
    root: &std::path::Path,
    path: String,
    expected_permanent: Option<bool>,
) -> Result<(), String> {
    vault::with_root_mutation(root, |canonical_root, guard| {
        let path = vault::confine_mutation_path(canonical_root, root, &path)?;
        let (targets, permanent) = confirmed_deletion_targets(
            canonical_root,
            &[path.to_string_lossy().into_owned()],
            expected_permanent,
        )?;
        if targets.is_empty() {
            return Err("not found: deletion target".into());
        }
        if permanent {
            vault::remove_all_locked(guard, &targets)
        } else {
            vault::delete_path_locked(guard, &targets[0].to_string_lossy())
        }
    })
}

/// Batch deletion uses the persisted policy. Recoverable mode sends every
/// path to the OS trash in one call. `delete_path`
/// per file spawned a Finder osascript for each on macOS (~80 ms and a trash
/// sound apiece: 470 for the measured 235 sessions); a list takes one. Async,
/// so Finder working through a long list does not hold the main thread.
#[tauri::command]
pub async fn trash_paths(
    app: tauri::AppHandle,
    paths: Vec<String>,
    expected_permanent: Option<bool>,
) -> Result<(), String> {
    let origin = app.state::<VaultRoot>().snapshot()?;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<VaultRoot>().with_origin(&origin, |root| {
            // Check the whole batch before the first deletion, including drafts
            // that have not yet been opened in this renderer after a restart.
            for path in &paths {
                crate::editor_recovery::assert_no_pending_at(root, path)?;
            }
            vault::with_root_mutation(root, |canonical_root, guard| {
                let paths = paths
                    .iter()
                    .map(|path| {
                        vault::confine_mutation_path(canonical_root, root, path)
                            .map(|path| path.to_string_lossy().into_owned())
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let (targets, permanent) =
                    confirmed_deletion_targets(canonical_root, &paths, expected_permanent)?;
                if permanent {
                    vault::remove_all_locked(guard, &targets)
                } else {
                    vault::trash_all_locked(guard, &targets)
                }
            })
        })
    })
    .await
    .map_err(|e| format!("join failed: {e}"))?
}

fn confirmed_deletion_targets(
    root: &std::path::Path,
    paths: &[String],
    expected_permanent: Option<bool>,
) -> Result<(Vec<PathBuf>, bool), String> {
    let permanent = settings::confirmed_deletion_policy(expected_permanent)?;
    Ok((trash_targets(root, paths)?, permanent))
}

/// `delete_path`'s checks on each of `paths` (inside the vault, never raw/),
/// dropping one already gone: a sidecar a half-written quarantine move never
/// made is no reason to stop the batch.
fn trash_targets(root: &std::path::Path, paths: &[String]) -> Result<Vec<PathBuf>, String> {
    let mut targets: Vec<PathBuf> = Vec::new();
    for path in paths {
        let p = vault::confine_delete_path(root, path)?;
        if vault::is_raw_mutation_source(root, &p) {
            return Err("refused: raw/ is immutable — a source cannot be deleted".into());
        }
        if p == root.join(".myco") || p.starts_with(root.join(".git")) {
            return Err("refused: vault state and history directories cannot be deleted".into());
        }
        if p.exists() && !targets.iter().any(|target| p.starts_with(target)) {
            targets.retain(|target| !target.starts_with(&p));
            targets.push(p);
        }
    }
    Ok(targets)
}

#[tauri::command]
pub fn rename_path(
    state: tauri::State<VaultRoot>,
    from: String,
    to_name: String,
) -> Result<String, String> {
    let origin = state.snapshot()?;
    state.with_origin(&origin, |root| {
        crate::editor_recovery::assert_no_pending_at(root, &from)?;
        // Renaming a note moves its wikilink target (the file stem), orphaning every
        // inbound [[old]]. Capture the stems, then rewrite backlinks vault-wide so
        // the graph and backlinks panel stay connected.
        let is_md = std::path::Path::new(&from)
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("md"));
        let old_stem = std::path::Path::new(&from)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        let new_path = vault::rename_path_checked_at(root, &from, &to_name)?;
        if is_md {
            let new_stem = std::path::Path::new(&to_name)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&to_name);
            if !old_stem.is_empty() && !old_stem.eq_ignore_ascii_case(new_stem) {
                vault::rewrite_backlinks(root, &old_stem, new_stem);
            }
        }
        Ok(new_path)
    })
}

/// Confinement + raw/ guard, root-injected so it is testable without a Tauri
/// State (the copy_into_inbox_at idiom). No mark_dirty, like rename_path: the
/// watcher picks up moves; wikilinks resolve by stem, so backlinks need no rewrite.
pub(crate) fn move_path_at(
    root: &std::path::Path,
    from: &str,
    to_dir: &str,
) -> Result<String, String> {
    vault::move_path_checked_at(root, from, to_dir)
}

#[tauri::command]
pub fn move_path(
    state: tauri::State<VaultRoot>,
    from: String,
    to_dir: String,
) -> Result<String, String> {
    let origin = state.snapshot()?;
    state.with_origin(&origin, |root| {
        crate::editor_recovery::assert_no_pending_at(root, &from)?;
        move_path_at(root, &from, &to_dir)
    })
}

/// `.myco/favorites.json`: validates every entry (non-empty, relative, no `..`
/// component, no `\`), dedups in order, then writes atomically.
pub(crate) fn save_favorites_at(root: &std::path::Path, paths: &[String]) -> Result<(), String> {
    let mut kept: Vec<&String> = Vec::with_capacity(paths.len());
    for p in paths {
        if p.is_empty() || p.starts_with('/') || p.contains('\\') || p.split('/').any(|c| c == "..")
        {
            return Err(format!("invalid favorite path: {p}"));
        }
        if !kept.contains(&p) {
            kept.push(p);
        }
    }
    let dir = crate::vault_dir::dir(root);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create .myco dir: {e}"))?;
    let json = serde_json::to_string(&kept).map_err(|e| e.to_string())?;
    vault::write_file(&dir.join("favorites.json").to_string_lossy(), &json)
}

#[tauri::command]
pub fn save_favorites(state: tauri::State<VaultRoot>, paths: Vec<String>) -> Result<(), String> {
    let root = require_root(&state)?;
    save_favorites_at(&root, &paths)
}

/// A free `raw/<stem>.md` path (suffixed on collision) for a new ingest source,
/// so a second source under the same title never overwrites the first's
/// immutable original.
#[tauri::command]
pub fn available_raw_path(state: tauri::State<VaultRoot>, stem: String) -> Result<String, String> {
    let root = require_root(&state)?;
    Ok(vault::available_raw_path(&root, &stem))
}

/// A raw copy ingest can reuse, and whether another raw copy has its stem
/// (then its summary page would be another body's; see `raw_stem_shared`).
#[derive(serde::Serialize)]
pub struct RawCopy {
    path: String,
    shared: bool,
}

/// The raw/ file (top level or `raw/archive/**`) whose bytes equal `content`,
/// so ingest reuses it instead of filing a second immutable copy.
#[tauri::command]
pub fn find_raw_copy(
    state: tauri::State<VaultRoot>,
    content: String,
) -> Result<Option<RawCopy>, String> {
    let root = require_root(&state)?;
    Ok(vault::find_raw_copy(&root, &content).map(|path| RawCopy {
        shared: vault::raw_stem_shared(&root, &path),
        path,
    }))
}

/// An image or recording in the vault named by its bytes (`marker`), and the
/// raw copy that already carries that marker, if one does: a retry reads its
/// first description back instead of filing a new one (vault::source_marker).
#[derive(serde::Serialize)]
pub struct DerivedRawCopy {
    marker: String,
    copy: Option<String>,
}

/// Off the main thread: a recording can be large, and hashing reads all of it.
#[tauri::command]
pub async fn derived_raw_copy(
    state: tauri::State<'_, VaultRoot>,
    path: String,
) -> Result<DerivedRawCopy, String> {
    let root = require_root(&state)?;
    let src = vault::confine_path(&root, &path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let marker = vault::source_marker(&src).map_err(|e| format!("read {path}: {e}"))?;
        let copy = vault::find_marked_raw_copy(&root, &marker);
        Ok(DerivedRawCopy { marker, copy })
    })
    .await
    .map_err(|e| format!("join failed: {e}"))?
}

/// Archive a consumed inbox source instead of deleting it.
///
/// The in-app auto-ingest pass used to `delete_path` a source once ingested,
/// while the headless daemon archives it to `_inbox/.archived/`. That divergence
/// is a data-loss risk: if a run half-fails, the delete path throws the original
/// away. This makes the app match the daemon.
#[tauri::command]
pub fn archive_inbox_source(
    state: tauri::State<VaultRoot>,
    path: String,
    complete_harvest: Option<bool>,
) -> Result<String, String> {
    let root = require_root(&state)?;
    archive_inbox_source_completion_at(&root, &path, complete_harvest.unwrap_or(false))
}

fn archive_inbox_source_completion_at(
    root: &std::path::Path,
    path: &str,
    complete_harvest: bool,
) -> Result<String, String> {
    if complete_harvest {
        return Err("harvest completion requires native source-processing and publication authority; the source remains pending".into());
    }
    archive_inbox_source_at(root, path)
}

#[tauri::command]
pub async fn inbox_source_snapshot(
    app: tauri::AppHandle,
    origin: AgentVaultSession,
    inbox_rel: String,
    expected_revision: Option<String>,
) -> Result<crate::inbox_source::Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::inbox_source::capture(
            &app.state::<VaultRoot>(),
            &origin,
            &inbox_rel,
            expected_revision.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("inbox source snapshot join failed: {error}"))?
}

#[tauri::command]
pub async fn inbox_compile_begin(
    app: tauri::AppHandle,
    snapshot: crate::inbox_source::Snapshot,
    usage: crate::role_authorization::RoleUsage,
) -> Result<crate::session_compile::SessionCompileContext, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::inbox_source::begin(&app.state::<VaultRoot>(), &snapshot, usage)
    })
    .await
    .map_err(|error| format!("inbox compile begin join failed: {error}"))?
}

#[tauri::command]
pub async fn archive_inbox_source_checked(
    app: tauri::AppHandle,
    snapshot: crate::inbox_source::Snapshot,
    context: Option<crate::session_compile::SessionCompileContext>,
) -> Result<crate::backfill::InboxArchiveReceipt, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::inbox_source::archive(&app.state::<VaultRoot>(), &snapshot, context.as_ref())
    })
    .await
    .map_err(|error| format!("checked inbox archive join failed: {error}"))?
}

#[tauri::command]
pub fn release_inbox_source(snapshot: crate::inbox_source::Snapshot) -> Result<(), String> {
    crate::inbox_source::release(&snapshot)
}

fn archive_inbox_source_at(root: &std::path::Path, path: &str) -> Result<String, String> {
    vault::archive_inbox_source_checked_at(root, path, None)
}

#[cfg(test)]
#[path = "commands_inbox_completion_tests.rs"]
mod inbox_completion_tests;

/// One file waiting in `_inbox/` — every extension, not just `.md`. The
/// markdown-only `list_files` walk hid PDFs/images/audio dropped in the inbox
/// from the in-app auto-ingest; this listing makes them visible so the pass
/// can route or at least count them.
#[derive(Clone, serde::Serialize)]
pub struct InboxEntry {
    pub name: String,
    pub rel: String,
    pub ext: String,
    pub bytes: u64,
    pub mtime: i64,
}

/// Flat `read_dir` of `_inbox/` (mcp_native::list_inbox shape): top level
/// only, dotfiles skipped (`.archived/`), directories skipped (`quarantine/`).
fn inbox_entries(root: &std::path::Path) -> Vec<InboxEntry> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(root.join("_inbox")) else {
        return out;
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let Ok(meta) = e.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let ext = std::path::Path::new(&name)
            .extension()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        out.push(InboxEntry {
            rel: format!("_inbox/{name}"),
            name,
            ext,
            bytes: meta.len(),
            mtime,
        });
    }
    out
}

/// Every file waiting in the open vault's `_inbox/`, any extension.
#[tauri::command]
pub async fn list_inbox_entries(
    state: tauri::State<'_, VaultRoot>,
    vault: String,
) -> Result<Vec<InboxEntry>, String> {
    let root = confine_root(&state, &vault)?;
    run_file_task("list inbox entries", move || {
        Ok(inbox_entries(std::path::Path::new(&root)))
    })
    .await
}

/// Byte ceiling on a single dropped file — extract.rs's `MAX_BYTES`, for the
/// same reason: everything in `_inbox/` is ingest input, and the extract stage
/// refuses anything larger anyway, so a bigger copy only parks bytes the
/// pipeline will never read.
const INBOX_COPY_MAX_BYTES: u64 = 25 * 1024 * 1024;

/// Media gets its own, much larger ceiling. The document limit exists because
/// the extract stage will not parse past it; audio and video never go through
/// that stage at all — they go to whisper, which streams a file of any length.
/// An hour of recorded meeting is ~60 MB, which the old shared 25 MB cap
/// refused outright. Now that speech recognition ships in the app (rather than
/// depending on a CLI the user may not have), that refusal has no reason left.
const INBOX_COPY_MAX_MEDIA_BYTES: u64 = 500 * 1024 * 1024;

/// Extensions routed to transcription instead of text extraction. Mirrors
/// `app/src/lib/mediaIngest.ts::isMediaFile` — a format added there without
/// being added here would be refused for size before it ever reached whisper.
const MEDIA_EXTS: &[&str] = &[
    "mp3", "m4a", "wav", "flac", "ogg", "mp4", "mov", "webm", "mkv", "aac",
];

fn is_media_name(name: &str) -> bool {
    name.rsplit_once('.')
        .map(|(_, ext)| MEDIA_EXTS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// The copy behind `copy_into_inbox`, split out so the rules are testable
/// without a Tauri runtime (the `export_bundle_write` pattern). The source may
/// live anywhere on disk — it is the file the user dropped, and it is COPIED,
/// never moved. The destination is confined to `_inbox/` (safe_join), and an
/// existing file is an error, never overwritten: collision-free naming is the
/// frontend's job (notchDrop.ts `inboxFilename`).
pub(crate) fn copy_into_inbox_at(
    root: &std::path::Path,
    src_abs: &str,
    dest_name: &str,
) -> Result<String, String> {
    let src = std::path::Path::new(src_abs);
    let meta = std::fs::metadata(src).map_err(|e| format!("unreadable source {src_abs}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("not a file: {src_abs}"));
    }
    let cap = if is_media_name(dest_name) {
        INBOX_COPY_MAX_MEDIA_BYTES
    } else {
        INBOX_COPY_MAX_BYTES
    };
    if meta.len() > cap {
        return Err(format!(
            "file too large: {} bytes (max {} MB)",
            meta.len(),
            cap / (1024 * 1024)
        ));
    }
    let dest = crate::myco_pro::safe_join(&root.join(DEST_INBOX), dest_name)?;
    if dest.exists() {
        return Err(format!("already in {DEST_INBOX}: {dest_name}"));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {DEST_INBOX}: {e}"))?;
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("canonicalize vault: {e}"))?;
    let confined = vault::confine_path(&canonical_root, &dest.to_string_lossy())?;
    if !confined.starts_with(canonical_root.join(DEST_INBOX)) {
        return Err("refused: inbox destination was redirected".into());
    }
    let parent = confined
        .parent()
        .ok_or_else(|| "no inbox parent".to_string())?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".myco-copy-")
        .tempfile_in(parent)
        .map_err(|e| format!("create inbox copy: {e}"))?;
    use std::io::Read;
    let source = std::fs::File::open(src).map_err(|e| format!("open source: {e}"))?;
    let copied = std::io::copy(&mut source.take(cap + 1), temporary.as_file_mut())
        .map_err(|e| format!("copy failed: {e}"))?;
    if copied > cap {
        return Err("source grew beyond the inbox size limit".into());
    }
    temporary
        .as_file_mut()
        .sync_all()
        .map_err(|e| format!("sync inbox copy: {e}"))?;
    temporary.persist_noclobber(&confined).map_err(|e| {
        if e.error.kind() == std::io::ErrorKind::AlreadyExists {
            format!("already in {DEST_INBOX}: {dest_name}")
        } else {
            format!("persist inbox copy: {}", e.error)
        }
    })?;
    Ok(dest.to_string_lossy().into_owned())
}

/// COPY a file dropped on the notch surface into the open vault's `_inbox/`.
#[tauri::command]
pub fn copy_into_inbox(
    state: tauri::State<VaultRoot>,
    src_abs: String,
    dest_name: String,
) -> Result<String, String> {
    let root = require_root(&state)?;
    copy_into_inbox_at(&root, &src_abs, &dest_name)
}

/// A pasted link/selection is a note the webview COMPOSED, not a file on
/// disk — 1 MB is generous for one; anything bigger is a mispaste.
const INBOX_NOTE_MAX_BYTES: usize = 1024 * 1024;

pub(crate) fn write_inbox_note_at(
    root: &std::path::Path,
    dest_name: &str,
    content: &str,
) -> Result<String, String> {
    if content.trim().is_empty() {
        return Err("empty note".into());
    }
    if content.len() > INBOX_NOTE_MAX_BYTES {
        return Err(format!(
            "note too large: {} bytes (max 1 MB)",
            content.len()
        ));
    }
    let dest = crate::myco_pro::safe_join(&root.join(DEST_INBOX), dest_name)?;
    if dest.exists() {
        return Err(format!("already in {DEST_INBOX}: {dest_name}"));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {DEST_INBOX}: {e}"))?;
    }
    std::fs::write(&dest, content).map_err(|e| format!("write failed: {e}"))?;
    Ok(dest.to_string_lossy().into_owned())
}

/// WRITE a composed markdown note (a pasted link or text selection on the
/// notch) into the open vault's `_inbox/` — copy_into_inbox's sibling, same
/// confinement (safe_join, no overwrite), for content with no file behind it.
#[tauri::command]
pub fn write_inbox_note(
    state: tauri::State<VaultRoot>,
    dest_name: String,
    content: String,
) -> Result<String, String> {
    let root = require_root(&state)?;
    write_inbox_note_at(&root, &dest_name, &content)
}

/// One conversation held back from import for containing a secret.
#[derive(serde::Serialize)]
pub struct QuarantinedConversation {
    pub title: String,
    pub secrets: Vec<String>,
}

/// A file that could not be imported (read/parse error) — kept so the UI can
/// list it and retry just these, not the whole sweep.
#[derive(serde::Serialize, Clone)]
pub struct FailedImport {
    pub path: String,
    pub error: String,
}

/// The outcome of importing one or many export files, for the UI.
#[derive(serde::Serialize)]
pub struct ImportOutcome {
    /// Detected format: chatgpt | claude-code | codex | unknown.
    pub source: String,
    /// How many source docs were written to `_inbox/`.
    pub imported: usize,
    /// Conversations already imported unchanged, per the dedup ledger.
    pub skipped: usize,
    /// Conversations skipped because their text matched a secret pattern.
    pub quarantined: Vec<QuarantinedConversation>,
    /// Files that could not be read/parsed — retryable.
    pub failed: Vec<FailedImport>,
}

/// Progress of a running import, emitted as `import-progress`. `done`/`total`
/// are FILE counts (known upfront from the file list); the tallies run up.
#[derive(serde::Serialize, Clone)]
pub struct ImportProgress {
    pub done: usize,
    pub total: usize,
    /// Basename of the file just processed.
    pub file: String,
    pub imported: usize,
    pub skipped: usize,
    pub failed: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<AgentVaultSession>,
    #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

/// A file's (mtime, len) identity for the incremental skip. `None` when the
/// metadata or mtime is unavailable — the file is then always processed (safe:
/// no skip, no stamp recorded), and an unreadable file fails later as before.
fn file_stamp(path: &std::path::Path) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime_ns = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos() as u64;
    Some((mtime_ns, meta.len()))
}

/// The one import engine: parse+scan+write each file's conversations into
/// `_inbox/`, recording the ledger once for the whole run. A file that won't
/// read/parse becomes a `FailedImport` — never fatal, never silently dropped.
/// A file that imported cleanly before and hasn't changed since is skipped
/// without being read — so re-sweeping thousands of sessions is near-instant.
/// `on_progress` is called on a throttled schedule (import does no model calls,
/// so 5,000 unthrottled events would flood the IPC bridge). Emit-free so it is
/// unit-testable; the commands wrap it to emit `import-progress`.
/// Where a rendered conversation lands.
///
/// `_inbox/` is a QUEUE whose consumer costs money: ingest calls the selected
/// provider per file, writes wiki pages and archives the source. Only something
/// the user picked belongs there.
///
/// A session sweep is not that. Sessions are work logs, valuable to SEARCH
/// ("why did I do it this way") but not worth a paid page each — so they go to
/// `sessions/`, which the embedding index reads (see `collect_wiki_pages`) and
/// the knowledge graph skips (see `index::collect_files`). Enabling the sweep by
/// default while it wrote into `_inbox/` is what queued 1,690 unwanted ingests.
pub(crate) const DEST_INBOX: &str = "_inbox";
pub(crate) const DEST_SESSIONS: &str = "sessions";

/// The `YYYY-MM` sub-directory a swept session belongs in.
///
/// Prefers a date already in the stem (importers name files after the
/// conversation), and falls back to the current month so a stem without one
/// still lands somewhere deterministic rather than at the root of `sessions/`.
pub(crate) fn session_bucket(stem: &str) -> String {
    if let Some(pos) = stem.find(|c: char| c.is_ascii_digit()) {
        let tail = &stem[pos..];
        let b = tail.as_bytes();
        // YYYY-MM… — only accept a real-looking date, never a UUID fragment.
        if b.len() >= 7
            && b[0..4].iter().all(u8::is_ascii_digit)
            && b[4] == b'-'
            && b[5..7].iter().all(u8::is_ascii_digit)
        {
            let y: u16 = tail[0..4].parse().unwrap_or(0);
            let m: u8 = tail[5..7].parse().unwrap_or(0);
            if (1970..=2999).contains(&y) && (1..=12).contains(&m) {
                return format!("{y:04}-{m:02}");
            }
        }
    }
    current_month()
}

/// `YYYY-MM` for now, in UTC. The bucket is an archive key, not a thing the
/// user reads as a local date, so UTC keeps it stable across machines.
fn current_month() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs / 86_400;
    // Civil-from-days (Howard Hinnant's algorithm) — no chrono dependency for
    // one number.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}")
}

/// Move flat `sessions/*.md` into their `YYYY-MM` bucket.
///
/// Idempotent and non-destructive: a file already inside a bucket is left
/// alone, and a name collision is skipped rather than overwritten — a session
/// archive is the one place we must not lose a file to a rename race.
///
/// Returns (moved, skipped).
pub(crate) fn partition_sessions(root: &std::path::Path) -> Result<(usize, usize), String> {
    let dir = root.join(DEST_SESSIONS);
    if !dir.is_dir() {
        return Ok((0, 0));
    }
    let mut moved = 0;
    let mut skipped = 0;
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("read sessions: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        // Only loose .md files at the top level; buckets are already correct.
        if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            skipped += 1;
            continue;
        };
        let bucket = dir.join(session_bucket(stem));
        std::fs::create_dir_all(&bucket).map_err(|e| format!("create bucket: {e}"))?;
        let target = bucket.join(format!("{stem}.md"));
        if target.exists() {
            skipped += 1;
            continue;
        }
        match std::fs::rename(&path, &target) {
            Ok(()) => moved += 1,
            Err(_) => skipped += 1,
        }
    }
    Ok((moved, skipped))
}

/// Resolve a caller-supplied destination to one of the two known directories.
///
/// `dest` reaches `apply_import` as a path segment joined onto the vault root,
/// so it is never taken on trust: anything but these two literals is refused
/// rather than sanitized, which is the only way a `../` can't be argued into.
pub(crate) fn import_dest(dest: &str) -> Result<&'static str, String> {
    match dest {
        DEST_INBOX => Ok(DEST_INBOX),
        DEST_SESSIONS => Ok(DEST_SESSIONS),
        other => Err(format!("unknown import destination: {other}")),
    }
}

/// Preserve the legacy batch-runner regression fixtures. Production native and
/// MCP imports use opening-bound admission, sharing `apply_import_plan` below.
#[cfg(test)]
pub(crate) fn run_import(
    root: &std::path::Path,
    files: &[PathBuf],
    dest: &str,
    mut on_progress: impl FnMut(ImportProgress),
) -> ImportOutcome {
    let refused = |error: String| ImportOutcome {
        source: String::new(),
        imported: 0,
        skipped: 0,
        quarantined: Vec::new(),
        failed: files
            .iter()
            .map(|path| FailedImport {
                path: path.to_string_lossy().into_owned(),
                error: error.clone(),
            })
            .collect(),
    };
    let _import_guard = match crate::importers::wikify::import_lock() {
        Ok(guard) => guard,
        Err(error) => return refused(error),
    };
    let canonical_root = match root.canonicalize() {
        Ok(root) => root,
        Err(error) => return refused(format!("import vault unavailable: {error}")),
    };
    let root = canonical_root.as_path();
    // A single oversized file should error rather than exhaust memory; applied
    // per file so one giant export can't take down a whole sweep.
    const MAX_BYTES: u64 = 512 * 1024 * 1024;
    let mut ledger = match crate::importers::ledger::Ledger::load(root) {
        Ok(ledger) => ledger,
        Err(error) => return refused(error),
    };
    let duplicates_before = ledger.duplicates();
    let total = files.len();
    let (mut imported, mut skipped) = (0usize, 0usize);
    let mut quarantined = Vec::new();
    let mut failed: Vec<FailedImport> = Vec::new();
    let mut source = String::new();
    let mut dirty = false;
    let mut legacy_locations = None;

    for (i, f) in files.iter().enumerate() {
        let path_str = f.to_string_lossy().into_owned();
        let stamp = file_stamp(f);
        // Unchanged since a clean import? Count its conversations as already
        // imported and move on without reading or re-parsing the file.
        let unchanged = stamp.and_then(|(m, l)| ledger.file_convs(&path_str, m, l));
        if let Some(convs) = unchanged {
            skipped += convs;
        } else {
            let res =
                (|| -> Result<(usize, usize, Vec<QuarantinedConversation>, String), String> {
                    let len = stamp.map(|(_, l)| l);
                    if let Some(len) = len {
                        if len > MAX_BYTES {
                            return Err(format!(
                                "too large ({} MB); split it first",
                                len / (1024 * 1024)
                            ));
                        }
                    }
                    let content =
                        std::fs::read_to_string(f).map_err(|e| format!("cannot read: {e}"))?;
                    apply_import(
                        root,
                        &mut ledger,
                        &path_str,
                        &content,
                        dest,
                        &mut legacy_locations,
                    )
                })();
            match res {
                Ok((i2, s2, q2, src)) => {
                    imported += i2;
                    skipped += s2;
                    // Only stamp files that imported with no quarantine, so a
                    // held-back secret is re-checked (and re-warned) each sweep.
                    let clean = q2.is_empty();
                    quarantined.extend(q2);
                    if clean {
                        if let Some((m, l)) = stamp {
                            ledger.record_file(path_str.clone(), m, l, i2 + s2);
                            dirty = true;
                        }
                    }
                    if source.is_empty() && !src.is_empty() {
                        source = src;
                    }
                }
                Err(error) => failed.push(FailedImport {
                    path: path_str,
                    error,
                }),
            }
        }
        if i % 32 == 0 || i + 1 == total {
            on_progress(ImportProgress {
                done: i + 1,
                total,
                file: f
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                imported,
                skipped,
                failed: failed.len(),
                origin: None,
                request_id: None,
            });
        }
    }
    if imported > 0 || dirty || ledger.duplicates() != duplicates_before {
        if let Err(error) = ledger.save(root) {
            for path in files {
                let path = path.to_string_lossy().into_owned();
                if !failed.iter().any(|failure| failure.path == path) {
                    failed.push(FailedImport {
                        path,
                        error: format!(
                            "import publication incomplete; source retained for retry: {error}"
                        ),
                    });
                }
            }
            on_progress(ImportProgress {
                done: total,
                total,
                file: String::new(),
                imported,
                skipped,
                failed: failed.len(),
                origin: None,
                request_id: None,
            });
        }
    }
    // One inflow-ledger line per batch (dest names the flavor) — this single
    // point covers conversations, session sweeps, and retries alike.
    crate::inflow_log::record_n(root, "import", dest, imported as u32);
    ImportOutcome {
        source,
        imported,
        skipped,
        quarantined,
        failed,
    }
}

/// Import an AI conversation export (ChatGPT / Claude Code / Codex) into the
/// vault's `_inbox/`, from which normal ingest turns each conversation into wiki
/// pages.
///
/// `source_path` is an EXTERNAL file the user chose (a download, a session file
/// under ~/.claude or ~/.codex) — not vault-confined; only the writes are, into
/// `_inbox/`. Each conversation becomes one `_inbox/<source>-<id>.md`; the id is
/// the vendor's, so re-importing the same export overwrites the same pending
/// file rather than duplicating. A conversation whose rendered text matches a
/// secret pattern is quarantined — reported, never written.
///
/// Async + `spawn_blocking`: a big export is parsed and many files written, and a
/// sync command body would freeze the window for the duration.
#[tauri::command]
pub async fn import_conversations(
    state: tauri::State<'_, VaultRoot>,
    app: tauri::AppHandle,
    source_path: String,
    origin: AgentVaultSession,
    request_id: String,
) -> Result<ImportOutcome, String> {
    check_import_request(&state, &origin, &request_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(import_admission::run(
            &app.state::<VaultRoot>(),
            &origin,
            &[PathBuf::from(source_path)],
            DEST_INBOX,
            || false,
            |p| emit_import_progress(&app, &origin, &request_id, p),
        ))
    })
    .await
    .map_err(|e| format!("join failed: {e}"))?
}

/// Re-import an explicit list of files — the "retry failed" path. It re-reads
/// only these files (the ledger skips the WRITE of an already-imported
/// conversation, never the parse+scan, so a whole-kind re-sweep would redo the
/// minutes-long work; this does not).
#[tauri::command]
pub async fn import_paths(
    state: tauri::State<'_, VaultRoot>,
    app: tauri::AppHandle,
    paths: Vec<String>,
    dest: String,
    origin: AgentVaultSession,
    request_id: String,
) -> Result<ImportOutcome, String> {
    check_import_request(&state, &origin, &request_id)?;
    // A retry must land where the run that failed was heading — re-queueing a
    // swept session into `_inbox/` would book it a paid ingest nobody asked for.
    let dest = import_dest(&dest)?;
    tauri::async_runtime::spawn_blocking(move || {
        let files: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
        Ok(import_admission::run(
            &app.state::<VaultRoot>(),
            &origin,
            &files,
            dest,
            || dest == DEST_SESSIONS && settings::load().auto_ingest_enabled,
            |p| emit_import_progress(&app, &origin, &request_id, p),
        ))
    })
    .await
    .map_err(|e| format!("join failed: {e}"))?
}

fn check_import_request(
    state: &VaultRoot,
    origin: &AgentVaultSession,
    request_id: &str,
) -> Result<(), String> {
    if request_id.is_empty()
        || request_id.len() > 128
        || !request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("invalid import request identity".into());
    }
    state.with_origin(origin, |_| Ok(()))
}

fn emit_import_progress(
    app: &tauri::AppHandle,
    origin: &AgentVaultSession,
    request_id: &str,
    mut progress: ImportProgress,
) {
    use tauri::Emitter;
    // Emit outside the transition lock: native listeners may close the vault.
    // The webview accepts only its exact opening and request identity.
    progress.origin = Some(origin.clone());
    progress.request_id = Some(request_id.into());
    let _ = app.emit("import-progress", progress);
}

/// Explicit MCP imports already run within their native opening binding.
pub(crate) fn run_import_admitted(
    root: &std::path::Path,
    files: &[PathBuf],
    dest: &str,
) -> ImportOutcome {
    import_admission::run_explicit(root, files, dest)
}

/// Read-only compiler queue view bound to one native opening. Legacy citation
/// reminders remain separate and cannot silently become completed compiler jobs.
#[tauri::command]
pub async fn list_wikify_pending(
    state: tauri::State<'_, VaultRoot>,
    expected_vault: String,
    origin: AgentVaultSession,
    limit: Option<usize>,
) -> Result<crate::session_compile::QueueView, String> {
    state.with_origin(&origin, |root| {
        check_expected_vault(root, Some(&expected_vault))?;
        crate::session_compile::list_at(root, &origin, limit.unwrap_or(3))
    })
}

/// Reuse a generated summary only for this admitted immutable source revision.
#[tauri::command]
pub async fn session_summary_path(
    state: tauri::State<'_, VaultRoot>,
    expected_vault: String,
    origin: AgentVaultSession,
    key: String,
    source_revision: String,
) -> Result<Option<String>, String> {
    state.with_origin(&origin, |root| {
        check_expected_vault(root, Some(&expected_vault))?;
        crate::session_compile::summary_at(root, &key, &source_revision)
    })
}

/// Native attempts, selected roles and actual publisher receipts authorize this
/// boundary. Public source hashes or quote coverage never certify compilation.
#[tauri::command]
pub fn wikify_complete_source(
    state: tauri::State<VaultRoot>,
    vault: String,
    origin: AgentVaultSession,
    raw_path: String,
    source_revision: String,
    wiki_paths: Vec<String>,
    session_compile: Option<crate::session_compile::SessionCompileContext>,
) -> Result<serde_json::Value, String> {
    state.with_origin(&origin, |root| check_expected_vault(root, Some(&vault)))?;
    let context = session_compile.ok_or("completion requires a native compiler attempt")?;
    if context.origin.vault_path != origin.vault_path
        || context.origin.opening_token != origin.opening_token
        || context.source.raw_path != raw_path
        || context.source.source_revision != source_revision
    {
        return Err("compiler completion source or native opening differs from its attempt".into());
    }
    crate::session_compile::complete(&state, &context, &wiki_paths)
}

#[tauri::command]
pub fn session_compile_begin(
    state: tauri::State<VaultRoot>,
    origin: AgentVaultSession,
    source: crate::session_compile::SourceBinding,
    usage: crate::role_authorization::RoleUsage,
) -> Result<crate::session_compile::SessionCompileContext, String> {
    crate::session_compile::begin(&state, &origin, source, usage)
}

#[tauri::command]
pub async fn session_compile_step(
    app: tauri::AppHandle,
    state: tauri::State<'_, VaultRoot>,
    local: tauri::State<'_, crate::local_generation::LocalChatState>,
    context: crate::session_compile::SessionCompileContext,
    request_id: String,
    lang: String,
) -> Result<
    crate::session_compile::execution::StepOutcome,
    crate::session_compile::failure::CompileFailure,
> {
    let future = crate::local_generation::compile_session_packet(
        app,
        local.inner().clone(),
        context.clone(),
        request_id,
        lang,
    );
    await_authorized_typed(
        &state,
        &context.origin,
        &context.role_snapshot,
        crate::role_authorization::RoleId::Compilation,
        future,
    )
    .await
}

#[tauri::command]
pub fn session_compile_read(
    state: tauri::State<VaultRoot>,
    context: crate::session_compile::SessionCompileContext,
    path: String,
) -> Result<crate::session_compile::BoundRead, String> {
    crate::session_compile::read(&state, &context, &path)
}

#[tauri::command]
pub fn session_compile_publish(
    state: tauri::State<VaultRoot>,
    context: crate::session_compile::SessionCompileContext,
    path: String,
    content: String,
    expected_revision: Option<String>,
) -> Result<serde_json::Value, String> {
    crate::session_compile::publish(
        &state,
        &context,
        &path,
        &content,
        expected_revision.as_deref(),
    )
}

#[tauri::command]
pub fn session_compile_stop(
    state: tauri::State<VaultRoot>,
    context: crate::session_compile::SessionCompileContext,
    reason: String,
) -> Result<(), String> {
    crate::session_compile::execution::cancel_current_request(&state, &context)?;
    crate::session_compile::stop(&state, &context, &reason)
}

/// Locate stable legacy projections once per import without following symlinks.
fn legacy_import_locations(
    root: &std::path::Path,
) -> Result<std::collections::BTreeMap<String, PathBuf>, String> {
    let sessions = root.join(DEST_SESSIONS);
    if !sessions.exists() {
        return Ok(std::collections::BTreeMap::new());
    }
    if std::fs::symlink_metadata(&sessions)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("import projection parent contains a symlink".into());
    }
    let mut pending = vec![sessions];
    let mut files = Vec::new();
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(dir).map_err(|e| format!("read legacy sessions: {e}"))? {
            let entry = entry.map_err(|e| format!("read legacy session entry: {e}"))?;
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            let path = entry.path();
            if kind.is_dir() {
                pending.push(path);
            } else if path.extension().is_some_and(|ext| ext == "md") {
                files.push(path);
            }
        }
    }
    files.sort_by_key(|path| {
        (
            path.starts_with(root.join("sessions/archive")),
            path.clone(),
        )
    });
    let mut locations = std::collections::BTreeMap::new();
    for path in files {
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            // Keep a symlink's identity so confinement rejects it rather than
            // silently creating a second projection in another month.
            locations.entry(stem.to_string()).or_insert(path);
        }
    }
    Ok(locations)
}

#[path = "import_projection.rs"]
mod import_projection;

/// Reuse the ownership validator over the caller's already bound original.
/// Manual compilation cannot treat edited public provenance as native lineage.
pub(crate) fn validate_manual_compiler_projection(
    _root: &std::path::Path,
    source: &crate::session_compile::SourceBinding,
    original: &str,
    projection: &str,
    fingerprint: &str,
) -> Result<(), String> {
    let name = std::path::Path::new(&source.raw_path)
        .file_stem()
        .and_then(|name| name.to_str())
        .ok_or("invalid manual compiler source name")?;
    let stem = name
        .strip_suffix(&format!("-{fingerprint}"))
        .ok_or("manual compiler source path lacks its native fingerprint")?;
    let doc = crate::importers::InboxDoc {
        stem: stem.into(),
        key: source.key.clone(),
        body: original.into(),
        fingerprint: fingerprint.into(),
        body_hash: crate::importers::ledger::body_hash(original),
        original_records: String::new(),
    };
    import_projection::validate_existing_from_original(
        &doc,
        projection,
        &source.raw_path,
        fingerprint,
    )
}

#[path = "import_admission.rs"]
pub(crate) mod import_admission;

/// Parse one file's conversations and write clean projections. The caller saves
/// the ledger after the batch; returns counts, quarantine rows and source kind.
#[allow(clippy::type_complexity)]
#[cfg(test)]
fn apply_import(
    root: &std::path::Path,
    ledger: &mut crate::importers::ledger::Ledger,
    filename: &str,
    content: &str,
    dest: &str,
    legacy_locations: &mut Option<std::collections::BTreeMap<String, PathBuf>>,
) -> Result<(usize, usize, Vec<QuarantinedConversation>, String), String> {
    let plan = crate::importers::plan_import(filename, content, ledger)?;
    apply_import_plan(root, ledger, plan, dest, legacy_locations)
}

#[allow(clippy::type_complexity)]
fn apply_import_plan(
    root: &std::path::Path,
    ledger: &mut crate::importers::ledger::Ledger,
    plan: crate::importers::ImportPlan,
    dest: &str,
    legacy_locations: &mut Option<std::collections::BTreeMap<String, PathBuf>>,
) -> Result<(usize, usize, Vec<QuarantinedConversation>, String), String> {
    let mut imported = 0;
    for doc in &plan.docs {
        // Sessions are partitioned by month. A sweep every 30 minutes had put
        // 1,029 files as flat siblings in one directory, which makes the folder
        // tree unusable, costs a full re-read of the directory on every scan,
        // and gives nothing to scope work to. A month bucket keeps each
        // directory small and lets anything that walks the vault skip whole
        // periods. `_inbox/` stays flat — it is a short-lived queue, not an
        // archive.
        let projection = if let Some(rel) = ledger.location(dest, &doc.key) {
            let path = root.join(rel);
            if !path.starts_with(root.join(dest)) {
                return Err("invalid import ledger location".into());
            }
            path
        } else if dest == DEST_SESSIONS {
            // Upgrade an old ledger by finding the existing projection once;
            // a resumed session must not get a new path in every import month.
            if legacy_locations.is_none() {
                *legacy_locations = Some(legacy_import_locations(root)?);
            }
            let existing = legacy_locations
                .as_ref()
                .ok_or("legacy session lookup is unavailable")?;
            existing.get(&doc.stem).cloned().unwrap_or_else(|| {
                root.join(dest)
                    .join(session_bucket(&doc.stem))
                    .join(format!("{}.md", doc.stem))
            })
        } else {
            root.join(dest).join(format!("{}.md", doc.stem))
        };
        let previous_location = projection.clone();
        // A continued legacy session must re-enter the active digest tree;
        // archive/ is excluded from inflow and remains the older projection.
        let projection = if dest == DEST_SESSIONS {
            projection
                .strip_prefix(root.join(dest).join("archive"))
                .map(|rel| root.join(dest).join(rel))
                .unwrap_or(projection)
        } else {
            projection
        };
        let relative = projection
            .strip_prefix(root)
            .map_err(|_| "import projection escapes vault")?;
        if relative
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err("invalid import projection path".into());
        }
        if !projection.starts_with(root.join(dest)) {
            return Err("import projection escapes its destination".into());
        }
        // confine_path requires an existing parent. Create missing directory
        // components only after rejecting every existing symlink on the way.
        let mut parent = root.to_path_buf();
        for component in relative
            .parent()
            .ok_or("import projection has no parent")?
            .components()
        {
            parent.push(component);
            if std::fs::symlink_metadata(&parent).is_ok_and(|m| m.file_type().is_symlink()) {
                return Err("import projection parent contains a symlink".into());
            }
            std::fs::create_dir_all(&parent)
                .map_err(|e| format!("create import directory: {e}"))?;
        }
        let projection = crate::vault::confine_delete_path(root, &projection.to_string_lossy())?;
        if !projection.starts_with(root.join(dest)) {
            return Err("import projection escapes its destination".into());
        }
        let current = import_projection::read_existing(&projection)?;
        let archived = if current.is_none() && previous_location != projection {
            let previous =
                crate::vault::confine_delete_path(root, &previous_location.to_string_lossy())?;
            import_projection::read_existing(&previous)?.map(|text| (previous, text))
        } else {
            None
        };
        let previous = current
            .as_deref()
            .or_else(|| archived.as_ref().map(|(_, text)| text.as_str()));
        let prepared = import_projection::prepare(
            root,
            doc,
            previous,
            ledger.entry(&doc.key).map(String::as_str),
        )?;
        if let Some(previous_raw_path) = &prepared.previous_raw_path {
            // Legacy projections may be the only copy of an earlier source.
            // Preserve its proven exact bytes before replacing owned content.
            crate::importers::wikify::append_raw(
                root,
                previous_raw_path,
                previous.ok_or("verified legacy source is unavailable")?,
            )?;
        }
        if let Some(original_path) = &prepared.original_path {
            crate::importers::wikify::append_raw(
                root,
                original_path,
                &format!("{}\n", doc.original_records),
            )?;
        }
        crate::importers::wikify::append_raw(root, &prepared.raw_path, &doc.body)?;
        #[cfg(test)]
        import_projection::hooks::before_publish();
        if let Some((path, text)) = archived {
            if import_projection::read_existing(&path)?.as_deref() != Some(text.as_str()) {
                return Err(
                    "PROJECTION_PUBLICATION_CONFLICT: archived projection changed; retry import"
                        .into(),
                );
            }
        }
        let expected = current
            .as_deref()
            .map(crate::importers::wikify::source_revision);
        crate::vault::write_file_if_unchanged(
            &projection.to_string_lossy(),
            &prepared.body,
            expected.as_deref(),
        )
        .map_err(|e| format!("PROJECTION_PUBLICATION_CONFLICT: write {}: {e}", doc.stem))?;
        // Record only after a successful write, so a failed write is retried
        // rather than silently skipped next time.
        ledger.record(doc.key.clone(), doc.fingerprint.clone());
        ledger.record_body(doc.body_hash.clone(), &doc.key);
        ledger.record_location(
            dest,
            &doc.key,
            projection
                .strip_prefix(root)
                .map_err(|_| "import path escapes vault")?
                .to_string_lossy()
                .into_owned(),
        );
        imported += 1;
    }
    // A body duplicate is "already imported" for the tally (under another
    // id); the ledger keeps the separate count of how many were refused.
    ledger.note_duplicates(plan.duplicates);
    let quarantined = plan
        .quarantined
        .into_iter()
        .map(|q| QuarantinedConversation {
            title: q.title,
            secrets: q.secrets.into_iter().map(str::to_string).collect(),
        })
        .collect();
    Ok((
        imported,
        plan.skipped + plan.duplicates,
        quarantined,
        plan.source,
    ))
}

/// Import every session myco can find on disk for one CLI tool, in one pass.
///
/// `kind` is "claude-code" (`~/.claude/projects/**/*.jsonl`) or "codex"
/// (`$CODEX_HOME`/`~/.codex/sessions/**/*.jsonl`). Reading the user's own
/// session directory is explicit — this runs on a button, never automatically.
/// The dedup ledger makes it idempotent: sweeping again imports only sessions
/// that are new or have grown. Errors on individual files are skipped, not fatal.
#[tauri::command]
pub async fn import_session_sweep(
    state: tauri::State<'_, VaultRoot>,
    app: tauri::AppHandle,
    kind: String,
    origin: AgentVaultSession,
    request_id: String,
) -> Result<ImportOutcome, String> {
    check_import_request(&state, &origin, &request_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = session_dir(&kind)?;
        if !dir.is_dir() {
            return Err(format!("no session directory at {}", dir.display()));
        }
        // Fold any loose sessions from before month-bucketing into their bucket
        // as part of the normal sweep — one archive shape, no separate chore
        // for the user to remember. Best effort: a migration that cannot move a
        // file must not stop the sweep that follows it.
        app.state::<VaultRoot>().with_origin(&origin, |root| {
            let _guard = crate::importers::wikify::import_lock()?;
            partition_sessions(root).map(|_| ())
        })?;
        let mut files = Vec::new();
        collect_jsonl(&dir, &mut files, 0);
        Ok(import_admission::run(
            &app.state::<VaultRoot>(),
            &origin,
            &files,
            DEST_SESSIONS,
            || settings::load().auto_ingest_enabled,
            |p| emit_import_progress(&app, &origin, &request_id, p),
        ))
    })
    .await
    .map_err(|e| format!("join failed: {e}"))?
}

#[cfg(feature = "native-index-probe")]
static PROBE_SESSION_ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Set isolated synthetic discovery for the native QA process only.
#[cfg(feature = "native-index-probe")]
pub(crate) fn install_probe_session_root(
    sandbox: &std::path::Path,
    directory: &std::path::Path,
) -> Result<(), String> {
    let canonical_sandbox = sandbox
        .canonicalize()
        .map_err(|error| format!("native QA sandbox: {error}"))?;
    let directory = crate::vault::confine_delete_path(sandbox, &directory.to_string_lossy())?;
    if directory == canonical_sandbox || !directory.is_dir() {
        return Err("native QA discovery must be a real sandbox child directory".into());
    }
    fn check_children(directory: &std::path::Path, depth: usize) -> Result<(), String> {
        if depth > 8 {
            return Err("native QA discovery exceeds the fixture depth limit".into());
        }
        for entry in std::fs::read_dir(directory)
            .map_err(|error| format!("inspect native QA discovery: {error}"))?
        {
            let entry = entry.map_err(|error| format!("inspect native QA child: {error}"))?;
            let kind = entry.file_type().map_err(|error| error.to_string())?;
            if kind.is_symlink() || (!kind.is_dir() && !kind.is_file()) {
                return Err("native QA discovery contains a link or nonregular object".into());
            }
            if kind.is_dir() {
                check_children(&entry.path(), depth + 1)?;
            }
        }
        Ok(())
    }
    check_children(&directory, 0)?;
    PROBE_SESSION_ROOT
        .set(directory)
        .map_err(|_| "native QA discovery was already initialized".into())
}

/// The on-disk session directory for a CLI tool.
fn session_dir(kind: &str) -> Result<PathBuf, String> {
    #[cfg(feature = "native-index-probe")]
    if let Some(directory) = PROBE_SESSION_ROOT.get() {
        return match kind {
            "claude-code" | "codex" => Ok(directory.join(kind)),
            other => Err(format!("unknown session kind: {other}")),
        };
    }
    let home =
        std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default();
    match kind {
        "claude-code" => Ok(PathBuf::from(home).join(".claude").join("projects")),
        "codex" => Ok(std::env::var("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(home).join(".codex"))
            .join("sessions")),
        other => Err(format!("unknown session kind: {other}")),
    }
}

/// Collect `*.jsonl` files under `dir`, recursively, skipping symlinks and
/// hidden/archived directories, bounded in depth and count.
fn collect_jsonl(dir: &std::path::Path, out: &mut Vec<PathBuf>, depth: u32) {
    if depth > 8 || out.len() >= 20_000 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_symlink() {
            continue; // stay on the real tree
        }
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if ft.is_dir() {
            if name.starts_with('.') {
                continue; // .archived, .git, etc.
            }
            collect_jsonl(&path, out, depth + 1);
        } else if name.ends_with(".jsonl") {
            out.push(path);
        }
    }
}

// ---- Inflow stats (activity popover "today's inflow" section) ----

/// What arrived in the vault today, for the activity popover and tray panel.
/// All "today" filters use the caller's local date (via `tz_offset_min`).
#[derive(Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InflowStats {
    /// `sessions/<month>/*.md` whose mtime falls on today — i.e. written or
    /// rewritten by a sweep today (current + previous month buckets only).
    pub sessions_today: u32,
    /// Top-level `_inbox/*` files created today (birthtime, mtime fallback).
    pub inbox_today: u32,
    /// Today's `_inbox/` arrivals split by their frontmatter `source:` value
    /// (`clipper`, `claude-code`, …). Files that carry no `source` are counted
    /// under `unknown` — every doc written before the writers stamped one, plus
    /// anything hand-dropped into the folder. Never guessed from the filename.
    pub inbox_by_source: std::collections::BTreeMap<String, u32>,
    /// MCP tool calls recorded today. The log is in-memory only, so after an
    /// app restart this counts since launch — the UI labels it as such.
    pub mcp_calls_today: u32,
    /// Most-called MCP tool today (ties break alphabetically); None when 0.
    pub mcp_top_tool: Option<String>,
    /// Per-local-hour buckets (24) of the session + inbox files counted above.
    pub hourly_files: Vec<u32>,
    /// Per-local-hour buckets (24) of the MCP calls counted above.
    pub hourly_mcp: Vec<u32>,
}

/// Epoch second of the caller's local midnight. `tz_offset_min` is JS
/// `Date.getTimezoneOffset()`: minutes to ADD to local time to reach UTC.
fn local_day_start(now: u64, tz_offset_min: i32) -> u64 {
    let local = now as i64 - i64::from(tz_offset_min) * 60;
    let start_local = local - local.rem_euclid(86_400);
    (start_local + i64::from(tz_offset_min) * 60).max(0) as u64
}

/// The caller's local hour (0–23) for an epoch second.
fn local_hour(t: u64, tz_offset_min: i32) -> usize {
    let local = t as i64 - i64::from(tz_offset_min) * 60;
    (local.rem_euclid(86_400) / 3600) as usize
}

/// The `YYYY-MM` before `month` — a sweep today can touch last month's bucket
/// when a conversation started late last month is still growing.
fn prev_month(month: &str) -> String {
    let (y, m) = month.split_once('-').unwrap_or(("1970", "01"));
    let y: u16 = y.parse().unwrap_or(1970);
    let m: u8 = m.parse().unwrap_or(1);
    if m <= 1 {
        format!("{:04}-12", y.saturating_sub(1))
    } else {
        format!("{y:04}-{:02}", m - 1)
    }
}

fn epoch_secs(t: std::time::SystemTime) -> u64 {
    t.duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Bucket for an `_inbox/` file whose frontmatter names no `source`. Kept as a
/// bare slug (not a translated label) so the frontend can localize it; the
/// backend never invents a source for a file that doesn't declare one.
pub(crate) const UNKNOWN_SOURCE: &str = "unknown";

/// The `source:` frontmatter of an `_inbox/` doc, or `None` when it has none.
///
/// Reads a bounded prefix, not the file: frontmatter is at the top and tiny,
/// while an imported conversation's body runs to megabytes and this is on the
/// popover's open path. A frontmatter block that doesn't fit the prefix reads as
/// `None` (→ `unknown`), which is the honest answer rather than a guess. The
/// value is a vault-file string headed for the UI, so it is capped too.
fn frontmatter_source(path: &std::path::Path) -> Option<String> {
    use std::io::Read;
    const PREFIX_BYTES: u64 = 4096;
    const MAX_SOURCE_CHARS: usize = 40;
    let mut buf = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(PREFIX_BYTES)
        .read_to_end(&mut buf)
        .ok()?;
    let gray_matter::Pod::Hash(map) = gray_matter::Matter::<gray_matter::engine::YAML>::new()
        .parse(&String::from_utf8_lossy(&buf))
        .ok()?
        .data?
    else {
        return None;
    };
    match map.get("source") {
        Some(gray_matter::Pod::String(s)) if !s.trim().is_empty() => {
            Some(s.trim().chars().take(MAX_SOURCE_CHARS).collect())
        }
        _ => None,
    }
}

/// Pure collector behind `inflow_stats` — deterministic given `now` and the
/// MCP call log, so it is unit-testable against a tempdir vault.
///
/// Deliberately cheap: two flat `read_dir`s over the current and previous
/// session month buckets (never `sessions/archive/`, structurally — only the
/// two month dirs are opened) and one over top-level `_inbox/` (quarantine/
/// and .archived/ are subdirectories, so files-only skips them). Only the
/// `_inbox/` files that landed TODAY are opened, and only for a 4 KB prefix,
/// to read their `source:` frontmatter.
pub(crate) fn collect_inflow(
    root: &std::path::Path,
    now: u64,
    tz_offset_min: i32,
    mcp_calls: &[(u64, String)],
) -> InflowStats {
    let day_start = local_day_start(now, tz_offset_min);
    let mut stats = InflowStats {
        hourly_files: vec![0; 24],
        hourly_mcp: vec![0; 24],
        ..InflowStats::default()
    };

    let month = current_month();
    for bucket in [month.clone(), prev_month(&month)] {
        let Ok(entries) = std::fs::read_dir(root.join(DEST_SESSIONS).join(bucket)) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let Ok(mtime) = entry.metadata().and_then(|m| m.modified()) else {
                continue;
            };
            let t = epoch_secs(mtime);
            if t >= day_start {
                stats.sessions_today += 1;
                stats.hourly_files[local_hour(t, tz_offset_min)] += 1;
            }
        }
    }

    if let Ok(entries) = std::fs::read_dir(root.join(DEST_INBOX)) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            if !path.is_file() || name.to_string_lossy().starts_with('.') {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            // Creation time where the platform has it (macOS birthtime);
            // mtime is the honest fallback, not an invention.
            let Ok(created) = meta.created().or_else(|_| meta.modified()) else {
                continue;
            };
            let t = epoch_secs(created);
            if t >= day_start {
                stats.inbox_today += 1;
                stats.hourly_files[local_hour(t, tz_offset_min)] += 1;
                let key = frontmatter_source(&path).unwrap_or_else(|| UNKNOWN_SOURCE.to_string());
                *stats.inbox_by_source.entry(key).or_insert(0) += 1;
            }
        }
    }

    let mut per_tool: std::collections::BTreeMap<&str, u32> = std::collections::BTreeMap::new();
    for (t, name) in mcp_calls {
        if *t >= day_start {
            stats.mcp_calls_today += 1;
            stats.hourly_mcp[local_hour(*t, tz_offset_min)] += 1;
            *per_tool.entry(name.as_str()).or_insert(0) += 1;
        }
    }
    // BTreeMap iteration is name-ascending, so max_by keeps the LAST maximum —
    // take strictly-greater to break ties on the alphabetically first name.
    let mut top: Option<(&str, u32)> = None;
    for (name, n) in per_tool {
        if top.map_or(true, |(_, best)| n > best) {
            top = Some((name, n));
        }
    }
    stats.mcp_top_tool = top.map(|(name, _)| name.to_string());
    stats
}

/// "Today's inflow" for the activity popover / tray panel: sessions swept in,
/// `_inbox` arrivals, MCP tool calls, plus hourly sparkbar buckets. Called
/// when the popover opens — no polling. `tz_offset_min` is the frontend's
/// `Date.getTimezoneOffset()` so "today" means the user's local date.
/// A JSON document under `.myco/<kind>/`. Names come from the user (board
/// picker, "Save view"), so they are validated as bare filenames — no
/// separators, no dot-tricks — rather than trusted into a join.
fn myco_json_path(root: &std::path::Path, kind: &str, name: &str) -> Result<PathBuf, String> {
    let name = name.trim();
    // Chars, not bytes: a 21-character Korean name is 63 bytes.
    let len = name.chars().count();
    if len == 0 || len > 60 {
        return Err("name must be 1-60 characters".into());
    }
    if name.contains(['/', '\\']) || name.contains("..") || name.starts_with('.') {
        return Err(format!("invalid name: {name}"));
    }
    Ok(root.join(".myco").join(kind).join(format!("{name}.json")))
}

/// Persist one document, creating `.myco/<kind>/` on first save — the generic
/// `write_file` refuses to create parent directories.
fn save_myco_json(
    root: &std::path::Path,
    kind: &str,
    name: &str,
    content: &str,
) -> Result<(), String> {
    let path = myco_json_path(root, kind, name)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create {kind} dir: {e}"))?;
    }
    vault::write_file(&path.to_string_lossy(), content)
}

/// Sorted `.json` stems under `.myco/<kind>/` — the file listing IS the list,
/// so backup/copy/hand-authoring all show up without ceremony. Missing dir → [].
fn list_myco_json(root: &std::path::Path, kind: &str) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(root.join(".myco").join(kind)) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) == Some("json") {
                if let Some(stem) = p.file_stem().and_then(|x| x.to_str()) {
                    out.push(stem.to_string());
                }
            }
        }
    }
    out.sort();
    out
}

/// Delete one document. The UI confirms first; the file is small, app-state
/// (not user notes), and recreatable — a direct remove, mirroring how the
/// other `.myco/` state files are managed.
fn delete_myco_json(root: &std::path::Path, kind: &str, name: &str) -> Result<(), String> {
    let path = myco_json_path(root, kind, name)?;
    std::fs::remove_file(&path).map_err(|e| format!("delete {kind}: {e}"))
}

/// Persist one board document (`.myco/dashboards/<name>.json`). Delayed saves
/// can bind their originating vault to avoid writing after a vault transition.
#[tauri::command]
pub fn save_dashboard(
    state: tauri::State<VaultRoot>,
    name: String,
    content: String,
    vault_path: Option<String>,
) -> Result<(), String> {
    save_dashboard_at(
        &require_root(&state)?,
        &name,
        &content,
        vault_path.as_deref(),
    )
}

fn save_dashboard_at(
    root: &std::path::Path,
    name: &str,
    content: &str,
    expected: Option<&str>,
) -> Result<(), String> {
    check_expected_vault(root, expected)?;
    save_myco_json(root, "dashboards", name, content)
}

/// The saved boards, by name (file stem), sorted.
#[tauri::command]
pub fn list_dashboards(state: tauri::State<VaultRoot>) -> Result<Vec<String>, String> {
    Ok(list_myco_json(&require_root(&state)?, "dashboards"))
}

#[tauri::command]
pub fn delete_dashboard(state: tauri::State<VaultRoot>, name: String) -> Result<(), String> {
    delete_myco_json(&require_root(&state)?, "dashboards", &name)
}

/// Persist one saved Views lens (`.myco/views/<name>.json`); the stem is the
/// view's name, so the vault carries its views with it.
#[tauri::command]
pub fn save_view(
    state: tauri::State<VaultRoot>,
    name: String,
    content: String,
) -> Result<(), String> {
    save_myco_json(&require_root(&state)?, "views", &name, &content)
}

#[tauri::command]
pub fn list_views(state: tauri::State<VaultRoot>) -> Result<Vec<String>, String> {
    Ok(list_myco_json(&require_root(&state)?, "views"))
}

#[tauri::command]
pub fn delete_view(state: tauri::State<VaultRoot>, name: String) -> Result<(), String> {
    delete_myco_json(&require_root(&state)?, "views", &name)
}

/// The vault's plugin manifests (`.myco/plugins/<id>/manifest.json`), read
/// only and confined to that folder (plugins.rs); the frontend validates them.
#[tauri::command]
pub async fn list_plugins(
    state: tauri::State<'_, VaultRoot>,
) -> Result<Vec<crate::plugins::PluginFile>, String> {
    let root = require_root(&state)?;
    run_file_task("list plugins", move || {
        Ok(crate::plugins::list_manifests(&root))
    })
    .await
}

/// Daily inflow by channel from the persistent ledger (`inflow_log`), for the
/// overview board's volume charts. `tz_offset_min` = JS `getTimezoneOffset()`,
/// the same convention as `inflow_stats` above.
#[tauri::command]
pub async fn inflow_daily(
    state: tauri::State<'_, VaultRoot>,
    days: u32,
    tz_offset_min: i32,
) -> Result<Vec<crate::inflow_log::InflowDay>, String> {
    let root = require_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let now = epoch_secs(std::time::SystemTime::now());
        Ok(crate::inflow_log::read_daily(
            &root,
            days,
            tz_offset_min,
            now,
        ))
    })
    .await
    .map_err(|e| format!("join failed: {e}"))?
}

#[tauri::command]
pub async fn inflow_stats(
    state: tauri::State<'_, VaultRoot>,
    root: String,
    tz_offset_min: i32,
) -> Result<InflowStats, String> {
    let root = confine_root(&state, &root)?;
    tauri::async_runtime::spawn_blocking(move || {
        let now = epoch_secs(std::time::SystemTime::now());
        Ok(collect_inflow(
            std::path::Path::new(&root),
            now,
            tz_offset_min,
            &crate::mcp_native::tool_calls_snapshot(),
        ))
    })
    .await
    .map_err(|e| format!("join failed: {e}"))?
}

/// Full link graph for the open vault.
///
/// Async + `spawn_blocking` because this is not a cheap read: it walks, reads
/// and parses every note (measured at 305 ms warm — 1.85 s cold — on a
/// 10k-note vault). A sync `#[tauri::command]` body runs inline on the platform
/// event loop, so at that size it stalls every other IPC call behind it. The
/// blocking pool is where the rest of the heavy work already goes
/// (`transcribe_media`, `claude_run`).
///
/// Prefer `vault_revision` when the caller only needs to know *whether* to
/// rebuild.
#[tauri::command]
pub async fn build_link_graph(
    state: tauri::State<'_, VaultRoot>,
    root: String,
) -> Result<Adjacency, String> {
    let root = confine_root(&state, &root)?;
    tauri::async_runtime::spawn_blocking(move || index::build_link_graph(&root))
        .await
        .map_err(|e| format!("join failed: {e}"))?
}

/// Cheap hash of the vault's markdown (path + mtime + length per .md file), so
/// a caller can skip a rebuild when nothing changed.
///
/// Measured against the work it guards: 0.5 ms vs 9 ms on a 51-note vault, and
/// 51 ms vs 1.3 s on a 10k-note vault — ~26x cheaper, because it only stats
/// where `build_link_graph` reads and parses.
#[tauri::command]
pub async fn vault_revision(
    state: tauri::State<'_, VaultRoot>,
    root: String,
) -> Result<u64, String> {
    let root = confine_root(&state, &root)?;
    tauri::async_runtime::spawn_blocking(move || vault::vault_revision(&root))
        .await
        .map_err(|e| format!("join failed: {e}"))?
}

// ---- Multiverse (multi-project registry) ----
//
// The multi-root surface (list_universes / build_universe_graph) deliberately
// does NOT use `confine_root` (which pins reads to the single open vault): a
// root is validated against the discovered registry and the sibling-vault set,
// never trusted from the frontend. Read-only — entering a universe opens it as
// the vault via `open_vault`, so there is no separate switch command.

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
/// Async for the same reason `build_link_graph` is: this reads and parses every
/// note in the target vault (305 ms warm on a 10k-note vault). The multiverse
/// loads every universe at once — on the event loop those builds serialise and
/// freeze the whole app, not just the graph, for their sum.
///
/// The allow-set is still resolved on the calling side, BEFORE the spawn: it is
/// cheap (a registry read and a sibling scan), and it is the check that stops
/// this from reading an arbitrary path — leaving it here keeps the refusal
/// immediate and impossible to skip.
#[tauri::command]
pub async fn build_universe_graph(
    state: tauri::State<'_, VaultRoot>,
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
    tauri::async_runtime::spawn_blocking(move || index::build_link_graph(&target.to_string_lossy()))
        .await
        .map_err(|e| format!("join failed: {e}"))?
}

/// Case-insensitive full-text search over the open vault's .md files. Uses the
/// confined vault root (no path from the frontend), so it can't read elsewhere.
/// `folder` keeps it to one top-level folder (a plugin's search: `wiki`).
#[tauri::command]
pub async fn search_vault(
    state: tauri::State<'_, VaultRoot>,
    query: String,
    limit: Option<usize>,
    folder: Option<String>,
) -> Result<Vec<SearchHit>, String> {
    let root = require_root(&state)?;
    let limit = limit.unwrap_or(50);
    tauri::async_runtime::spawn_blocking(move || match folder {
        Some(f) => vault::search_folder(&root, &f, &query, limit),
        None => vault::search_vault(&root, &query, limit),
    })
    .await
    .map_err(|e| format!("vault search task failed: {e}"))
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
pub async fn claude_check() -> Result<cli_agent::CliRunnerStatus, String> {
    run_file_task("Claude CLI status", || {
        Ok(cli_agent::CliRunnerStatus::new(
            claude::check(),
            "anthropic-cli",
        ))
    })
    .await
}

#[tauri::command]
pub async fn claude_run(
    state: tauri::State<'_, VaultRoot>,
    prompt: String,
    cwd: String,
    model: Option<String>,
    effort: Option<String>,
    execution: Option<cli_agent::CliExecutionRequest>,
) -> Result<CliResult, String> {
    cli_agent::require_execution(&state, execution.as_ref(), &cwd, "anthropic-cli")?;
    tauri::async_runtime::spawn_blocking(move || {
        claude::run_prompt(&prompt, &cwd, model.as_deref(), effort.as_deref())
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
    effort: Option<String>,
    execution: Option<cli_agent::CliExecutionRequest>,
) -> Result<CliResult, String> {
    use tauri::{Emitter, Manager};
    {
        let state = app
            .try_state::<VaultRoot>()
            .ok_or("native vault state is unavailable")?;
        cli_agent::require_execution(&state, execution.as_ref(), &cwd, "anthropic-cli")?;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let id = run_id.clone();
        let effort = effort.as_deref();
        claude::run_prompt_stream(
            &run_id,
            &prompt,
            &cwd,
            model.as_deref(),
            effort,
            move |event| {
                let _ = app.emit(
                    "claude-stream",
                    claude::StreamEvent {
                        run_id: id.clone(),
                        event,
                    },
                );
            },
        )
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
pub async fn agent_check(provider: String) -> cli_agent::CliRunnerStatus {
    let checked_provider = provider.clone();
    let installation =
        tauri::async_runtime::spawn_blocking(move || cli_agent::check(&checked_provider))
            .await
            .unwrap_or(CliStatus {
                installed: false,
                version: None,
                path: None,
            });
    cli_agent::CliRunnerStatus::new(installation, &provider)
}

/// Optional external execution requires a source opening and a verified runner.
#[tauri::command]
pub async fn agent_run(
    state: tauri::State<'_, VaultRoot>,
    provider: String,
    model: String,
    prompt: String,
    cwd: String,
    effort: Option<String>,
    execution: Option<cli_agent::CliExecutionRequest>,
) -> Result<CliResult, String> {
    cli_agent::require_execution(&state, execution.as_ref(), &cwd, &provider)?;
    tauri::async_runtime::spawn_blocking(move || {
        cli_agent::run_prompt(
            &provider,
            &model,
            effort.as_deref().unwrap_or_default(),
            &prompt,
            &cwd,
        )
    })
    .await
    .map_err(|e| format!("join failed: {e}"))?
}

#[tauri::command]
pub async fn scan_provenance(
    state: tauri::State<'_, VaultRoot>,
    vault_path: String,
) -> Result<Vec<ProvenanceRow>, String> {
    let vault_path = confine_root(&state, &vault_path)?;
    tauri::async_runtime::spawn_blocking(move || provenance::scan_provenance(&vault_path))
        .await
        .map_err(|e| format!("provenance scan task failed: {e}"))?
}

/// Deterministic ingest gate (Phase 1f): validate the changed pages' citations,
/// frontmatter schema, and wikilinks in Rust instead of trusting the LLM to
/// have gotten them right. Replaces the old mtime-only gate.
#[tauri::command]
pub fn validate_ingest(
    state: tauri::State<VaultRoot>,
    vault_path: String,
    changed_pages: Vec<String>,
) -> Result<crate::validator::ValidationReport, String> {
    let root = confine_root(&state, &vault_path)?;
    Ok(crate::validator::validate_pages(
        std::path::Path::new(&root),
        &changed_pages,
    ))
}

/// Deterministic wiki lint — the half of the lint checklist that needs no
/// model, so builtin-local (which bundles no chat model) can still run it.
/// `pages` are vault-relative and already filtered to knowledge pages by the
/// UI's shared classifier; link-graph findings (orphans, unresolved links) are
/// added on the UI side, which owns the malformed-placeholder filter.
#[tauri::command]
pub async fn lint_local(
    state: tauri::State<'_, VaultRoot>,
    vault_path: String,
    pages: Vec<String>,
) -> Result<crate::validator::LintReport, String> {
    let root = confine_root(&state, &vault_path)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Whole-wiki walk: off the UI thread, same as scan_tasks.
    tauri::async_runtime::spawn_blocking(move || {
        crate::validator::lint_local(std::path::Path::new(&root), &pages, now)
    })
    .await
    .map_err(|e| format!("join failed: {e}"))
}

/// Whole-wiki suspect scan for the Morning-Report card (Q4 item 2):
/// every `lint_page` problem plus declared-vs-suggested confidence mismatches.
#[tauri::command]
pub async fn suspect_pages(
    state: tauri::State<'_, VaultRoot>,
    vault: String,
) -> Result<crate::mcp_native::SuspectReport, String> {
    let root = confine_root(&state, &vault)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::mcp_native::suspect_scan(&std::path::Path::new(&root).join("wiki"))
    })
    .await
    .map_err(|e| format!("join failed: {e}"))
}

/// Collect every markdown checkbox item across the vault into one task list.
#[tauri::command]
pub async fn scan_tasks(
    state: tauri::State<'_, VaultRoot>,
    vault_path: String,
) -> Result<Vec<crate::tasks::TaskItem>, String> {
    let vault_path = confine_root(&state, &vault_path)?;
    // A full-vault walk on the UI thread froze the window for its duration, and
    // the notification timer now runs it every 5 minutes unattended.
    tauri::async_runtime::spawn_blocking(move || crate::tasks::scan_tasks(&vault_path))
        .await
        .map_err(|e| format!("join failed: {e}"))?
}

/// myco Pro ingest: send the open vault's snapshot + this source to the
/// configured proxy and apply the wiki file operations it returns (confined to
/// the vault). The proxy URL comes from settings; the license key from the
/// keychain ("myco-pro").
#[tauri::command]
pub async fn myco_pro_ingest(
    state: tauri::State<'_, VaultRoot>,
    slug: String,
    title: String,
    text: String,
    origin: Option<AgentVaultSession>,
    role_snapshot: Option<crate::role_authorization::RoleSnapshot>,
) -> Result<crate::myco_pro::MycoProResult, String> {
    let origin = origin.ok_or("subscription ingest requires a native opening")?;
    let snapshot =
        role_snapshot.ok_or("subscription ingest requires an explicit compilation snapshot")?;
    authorized_role(
        &state,
        &origin,
        &snapshot,
        crate::role_authorization::RoleId::Compilation,
        |_| {
            if snapshot.route_signature.provider_id != "myco-pro" {
                return Err("request_route_mismatch: subscription ingest is not selected".into());
            }
            let _ = (slug, title, text);
            Err("capability_unavailable: subscription ingest requires a staged checked publication executor; source remains pending".into())
        },
    )
}

/// Log in to myco Pro with the account created on the website. Fetches the
/// account's access key, stores it in the keychain, and records the email for
/// display — so the user never copies a key by hand.
#[tauri::command]
pub async fn myco_pro_login(
    email: String,
    password: String,
) -> Result<crate::myco_pro::LoginOutcome, String> {
    let url = settings::read_checked()?.myco_pro_url.trim().to_string();
    if url.is_empty() {
        return Err("Set the myco Pro service URL first (Settings → Connections)".into());
    }
    let outcome = crate::myco_pro::login(&url, &email, &password).await?;
    if let Some(key) = &outcome.license_key {
        crate::role_authorization::with_credential_change(|| {
            secrets::set_key(settings::PRO_PROVIDER_ID, key)
        })?;
    }
    // Persist the logged-in email + connection flag (the key stays in the
    // keychain). The flag gates the model picker; settings is the single source.
    let mut s = settings::read_checked()?;
    s.myco_pro_email = outcome.email.clone();
    s.providers.myco_pro = outcome.connected;
    settings::save(&s)?;
    // Don't echo the key back to the frontend; it's in the keychain.
    Ok(crate::myco_pro::LoginOutcome {
        license_key: None,
        ..outcome
    })
}

/// Log out of myco Pro: clear the stored key and email.
#[tauri::command]
pub fn myco_pro_logout() -> Result<(), String> {
    crate::role_authorization::with_credential_change(|| {
        secrets::delete_key(settings::PRO_PROVIDER_ID)
    })?;
    let mut s = settings::read_checked()?;
    s.myco_pro_email = String::new();
    s.providers.myco_pro = false;
    settings::save(&s)
}

#[tauri::command]
pub fn set_provider_key(provider_id: String, key: String) -> Result<(), String> {
    crate::role_authorization::with_credential_change(|| secrets::set_key(&provider_id, &key))
}

#[tauri::command]
pub fn delete_provider_key(provider_id: String) -> Result<(), String> {
    crate::role_authorization::with_credential_change(|| secrets::delete_key(&provider_id))
}

#[tauri::command]
pub async fn get_settings() -> Result<Settings, String> {
    run_file_task(
        "read settings",
        crate::role_authorization::settings_snapshot,
    )
    .await
}

#[tauri::command]
pub fn set_settings(value: Settings) -> Result<Settings, String> {
    settings::save(&value)?;
    crate::role_authorization::settings_snapshot()
}

/// Write the settings/looks export bundle to a user-chosen path (the native
/// save dialog is the frontend's only source of `path`).
///
/// "The dialog picks the path" is a frontend convention, not an enforced
/// property — this command is invokable from the webview like any other, so
/// it must guard itself. Two rules, both structural: the target must carry a
/// `.json` extension, and it must never land inside the open vault's
/// immutable `raw/` tree (the same predicate `write_file` refuses on). Every
/// other write command in this file is confined; this one was not.
#[tauri::command]
pub fn write_settings_export(
    state: tauri::State<VaultRoot>,
    path: String,
    contents: String,
) -> Result<(), String> {
    export_bundle_write(state.current().as_deref(), &path, &contents)
}

/// The guarded write itself, split out so the rules are unit-testable without
/// a Tauri runtime. `root` is the open vault (None before one is opened —
/// then there is no raw/ to protect and the extension rule is the whole
/// guard).
pub(crate) fn export_bundle_write(
    root: Option<&std::path::Path>,
    path: &str,
    contents: &str,
) -> Result<(), String> {
    let p = std::path::Path::new(path);
    if p.extension().and_then(|e| e.to_str()) != Some("json") {
        return Err("export target must be a .json file".into());
    }
    if let Some(root) = root {
        // Compare canonically where possible so `..` cannot walk into raw/;
        // an unwritten path has no canonical form, so probe via its parent.
        let probe = p
            .parent()
            .and_then(|d| d.canonicalize().ok())
            .map(|d| d.join(p.file_name().unwrap_or_default()))
            .unwrap_or_else(|| p.to_path_buf());
        if crate::vault::is_raw_path(root, &probe) {
            return Err("refusing to write into the immutable raw/ tree".into());
        }
    }
    settings::atomic_write(p, contents.as_bytes()).map_err(|e| format!("write export file: {e}"))
}

/// Read a settings/looks export file back in, from a path the user chose via
/// the native open dialog. Validation of the contents happens on the
/// frontend, which also owns the localStorage half of the bundle.
#[tauri::command]
pub fn read_settings_import(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("read import file: {e}"))
}

/// Capture a feature route under the current native opening. No weights are loaded.
#[tauri::command]
pub fn capture_model_role(
    state: tauri::State<VaultRoot>,
    origin: AgentVaultSession,
    role: crate::role_authorization::RoleId,
    usage: crate::role_authorization::RoleUsage,
) -> Result<crate::role_authorization::RoleSnapshot, String> {
    state.with_origin(&origin, |_| {
        crate::role_authorization::capture_role_at(&origin, role, usage)
            .map_err(|error| error.to_string())
    })
}

#[tauri::command]
pub fn select_model_role(
    request: crate::role_authorization::RoleSelectionRequest,
) -> Result<Settings, String> {
    crate::role_authorization::select_role(request)
}

#[tauri::command]
pub fn set_role_automatic_use(
    role: crate::role_authorization::RoleId,
    allowed: bool,
    expected_authorization_revision: String,
) -> Result<Settings, String> {
    crate::role_authorization::set_automatic(role, allowed, &expected_authorization_revision)
}

#[tauri::command]
pub async fn chat_complete(
    state: tauri::State<'_, VaultRoot>,
    request: ChatRequest,
    origin: Option<AgentVaultSession>,
    role_snapshot: Option<crate::role_authorization::RoleSnapshot>,
) -> Result<ChatResponse, String> {
    chat_complete_authorized(&state, request, origin, role_snapshot).await
}

/// Public bridge core, exercised with synthetic openings and loopback transport.
pub(crate) async fn chat_complete_authorized(
    vault: &VaultRoot,
    request: ChatRequest,
    origin: Option<AgentVaultSession>,
    role_snapshot: Option<crate::role_authorization::RoleSnapshot>,
) -> Result<ChatResponse, String> {
    let origin = origin.ok_or("native chat requires a vault opening")?;
    let snapshot = role_snapshot.ok_or("native chat requires a feature role snapshot")?;
    let key = authorized_role(vault, &origin, &snapshot, snapshot.role, |_| {
        if request.provider_id != snapshot.route_signature.provider_id
            || request.model != snapshot.route_signature.model_id
        {
            return Err(
                "request_route_mismatch: chat does not match native feature selection".into(),
            );
        }
        if request.provider_id == "ollama" {
            Ok(None)
        } else {
            secrets::get_key(&request.provider_id)
        }
    })?;
    await_authorized(
        vault,
        &origin,
        &snapshot,
        snapshot.role,
        providers::chat_complete(request, key),
    )
    .await
}

pub(crate) fn authorized_role<T>(
    vault: &VaultRoot,
    origin: &AgentVaultSession,
    snapshot: &crate::role_authorization::RoleSnapshot,
    role: crate::role_authorization::RoleId,
    dispatch: impl FnOnce(&std::path::Path) -> Result<T, String>,
) -> Result<T, String> {
    vault.with_origin(origin, |root| {
        crate::role_authorization::with_current_role_at(
            origin,
            snapshot,
            role,
            snapshot.usage,
            || dispatch(root),
        )
        .map_err(|error| error.to_string())
    })
}

/// Drop a revoked transport future and reject late output. Sent bytes cannot be recalled.
async fn await_authorized<T>(
    vault: &VaultRoot,
    origin: &AgentVaultSession,
    snapshot: &crate::role_authorization::RoleSnapshot,
    role: crate::role_authorization::RoleId,
    future: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    await_authorized_typed(vault, origin, snapshot, role, future).await
}

async fn await_authorized_typed<T, E: From<String>>(
    vault: &VaultRoot,
    origin: &AgentVaultSession,
    snapshot: &crate::role_authorization::RoleSnapshot,
    role: crate::role_authorization::RoleId,
    future: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, E> {
    authorized_role(vault, origin, snapshot, role, |_| Ok(()))?;
    tokio::pin!(future);
    let mut tick = tokio::time::interval(std::time::Duration::from_millis(25));
    tick.tick().await;
    loop {
        tokio::select! {
            result = &mut future => {
                let value = result?;
                return authorized_role(vault, origin, snapshot, role, |_| Ok(value)).map_err(E::from);
            }
            _ = tick.tick() => { authorized_role(vault, origin, snapshot, role, |_| Ok(()))?; }
        }
    }
}

// ---- Distillation config (Task 2, Phase A) ----

#[tauri::command]
pub fn get_distill_config(
    state: tauri::State<VaultRoot>,
    vault: String,
) -> Result<crate::distill::DistillConfig, String> {
    let root = confine_root(&state, &vault)?;
    crate::distill::config_load_checked(std::path::Path::new(&root))
}

#[tauri::command]
pub fn set_distill_config(
    state: tauri::State<VaultRoot>,
    vault: String,
    config: crate::distill::DistillConfig,
) -> Result<(), String> {
    let root = confine_root(&state, &vault)?;
    crate::distill::config_save(std::path::Path::new(&root), &config)
}

/// (stem, title) pairs for `ontology::build`'s entity dictionary. Only
/// `wiki/` pages carry a frontmatter title worth matching — session logs
/// (also walked by `collect_wiki_pages`) don't. `pub(crate)`: `distill::run`
/// (Task 6) rebuilds the ontology itself and needs this too.
pub(crate) fn wiki_titles(root: &std::path::Path) -> Vec<(String, String)> {
    collect_wiki_pages(root)
        .into_iter()
        .filter(|(rel, _, _)| rel.starts_with("wiki/"))
        .map(|(_, stem, content)| {
            let title = gray_matter::Matter::<gray_matter::engine::YAML>::new()
                .parse(&content)
                .ok()
                .and_then(|p| p.data)
                .and_then(|pod| match pod {
                    gray_matter::Pod::Hash(map) => match map.get("title") {
                        Some(gray_matter::Pod::String(s)) => Some(s.clone()),
                        _ => None,
                    },
                    _ => None,
                })
                .unwrap_or_default();
            (stem, title)
        })
        .collect()
}

/// Build the producer-bound closure `distill::run_checked` wants and run `f`
/// on a blocking-pool thread — the closure's own `block_on(embed_texts_checked(...))`
/// call cannot run on the caller's async task without panicking ("cannot
/// block the current thread from within a runtime").
async fn with_distill_embed<T: Send + 'static>(
    app: tauri::AppHandle,
    provider: String,
    model: String,
    f: impl FnOnce(
            &dyn Fn(Vec<String>) -> Result<embeddings::EmbeddedBatch, String>,
        ) -> Result<T, String>
        + Send
        + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let embed = |texts: Vec<String>| -> Result<embeddings::EmbeddedBatch, String> {
            let llm = app.state::<LocalLlmState>();
            tauri::async_runtime::block_on(embed_texts_checked(
                app.clone(),
                llm,
                &provider,
                &model,
                crate::local_llm::EmbedRole::Query,
                texts,
            ))
        };
        f(&embed)
    })
    .await
    .map_err(|e| format!("distill task join failed: {e}"))?
}

/// Idle-run orchestrator (Task 6, Phase A): partitions sessions, freshens the
/// ontology cache if the wiki moved, scores/quarantines/rejects new inflow,
/// sweeps expired quarantine past its TTL, and writes a run manifest + human
/// report — see `distill::run`'s own doc comment for the full step list. It
/// never touches `raw/`.
///
/// The checked runner reopens the index and compares its representation with
/// this pinned space before any semantic or partition side effects.
#[tauri::command]
pub async fn distill_run(
    app: tauri::AppHandle,
    vault_state: tauri::State<'_, VaultRoot>,
    cache: tauri::State<'_, VectorCache>,
    vault: String,
) -> Result<crate::distill::RunReport, String> {
    let root = confine_root(&vault_state, &vault)?;
    let root = PathBuf::from(root);
    let index_path = VectorStore::path_for(&root.to_string_lossy())?;
    let store = cache.get_async(index_path).await?;
    let cfg = crate::distill::config_load_checked(&root)?;
    if store.records.is_empty() && store.dim == 0 {
        return tauri::async_runtime::spawn_blocking(move || {
            crate::distill::run_without_embeddings(&root, &cfg)
        })
        .await
        .map_err(|error| format!("distill lifecycle task join failed: {error}"))?;
    }
    let expected = store.embedding_space()?;
    let (provider, model) = store
        .model
        .split_once(':')
        .map(|(p, m)| (p.to_string(), m.to_string()))
        .unwrap_or((store.model.clone(), String::new()));
    if builtin_index_is_stale(&provider, &model)
        || embedding_model_id(&provider, &model)? != expected.model
        || embedding_index_signature(&app, &provider, &model).await? != expected.signature
    {
        return Err(
            "distill requires an index rebuilt with the current embedding representation".into(),
        );
    }
    with_distill_embed(app, provider, model, move |embed| {
        crate::distill::run_checked(&root, &cfg, &expected, embed)
    })
    .await
}

/// Reverse generated notes with native creation authority. Legacy history and
/// moves without private native receipts remain available for manual recovery.
#[tauri::command]
pub fn undo_distill_run(
    state: tauri::State<VaultRoot>,
    publications: tauri::State<crate::distill_publication::DistillPublicationRegistry>,
    vault: String,
    id: String,
    origin: Option<AgentVaultSession>,
) -> Result<usize, String> {
    let origin = origin.ok_or("undo requires native opening and publication authority; preserve artifacts for manual recovery")?;
    undo_distill_run_dispatch(&state, &publications, &vault, &origin, &id)
}

fn undo_distill_run_dispatch(
    state: &VaultRoot,
    publications: &crate::distill_publication::DistillPublicationRegistry,
    vault: &str,
    origin: &AgentVaultSession,
    id: &str,
) -> Result<usize, String> {
    archive_origin_dispatch(state, vault, origin, |root| {
        crate::distill_publication::undo_from_history(publications, root, origin, id)
    })
}

/// Newest-first summaries of persisted run manifests — the Settings run list
/// (Q4 item 3).
#[tauri::command]
pub async fn list_distill_runs(
    state: tauri::State<'_, VaultRoot>,
    vault: String,
    limit: Option<usize>,
) -> Result<Vec<crate::distill::RunSummary>, String> {
    let root = confine_root(&state, &vault)?;
    run_file_task("list distill runs", move || {
        Ok(crate::distill::list_runs(
            std::path::Path::new(&root),
            limit.unwrap_or(20),
        ))
    })
    .await
}

/// One run's full manifest, WHY-report presence, and git commit — the run-log
/// drill-in (W3–6 item 6). See `distill::run_detail`.
#[tauri::command]
pub async fn distill_run_detail(
    state: tauri::State<'_, VaultRoot>,
    vault: String,
    id: String,
) -> Result<crate::distill::RunDetail, String> {
    let root = confine_root(&state, &vault)?;
    run_file_task("distill run detail", move || {
        crate::distill::run_detail(std::path::Path::new(&root), &id)
    })
    .await
}

/// One changed file in a run's commit, with full before/after content for
/// the word-diff renderer (W3–6 item 6).
#[derive(Clone, Debug, serde::Serialize)]
pub struct FileDiff {
    pub path: String,
    pub status: String,         // "added" | "modified" | "renamed" | "deleted"
    pub before: Option<String>, // None for added
    pub after: Option<String>,  // None for deleted
}

/// Neither side of a diff is sent to the webview above this size — the UI
/// shows "too large to diff" instead of freezing on a megabyte LCS.
const MAX_DIFF_SIDE_BYTES: usize = 256 * 1024;

/// Per-file before/after for the `distill: run <id>` commit. `Err("no-commit")`
/// when the run has no commit (history off / predates it) — callers fall back
/// to the manifest file list. Content existence per side comes from git itself
/// (`file_at` is `Ok(None)` for a path absent in that tree), so added/deleted
/// need no special-casing; a root commit has no parent and every file reads
/// as added. Renames (`R` rows) report the new path only — before is None.
pub(crate) fn run_diff_core(root: &std::path::Path, id: &str) -> Result<Vec<FileDiff>, String> {
    use crate::vault_history as vh;
    let sha = vh::commit_for_message(root, &format!("distill: run {id}"))
        .ok_or_else(|| "no-commit".to_string())?;
    let parent = vh::git(root, &["rev-parse", &format!("{sha}^")])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    vh::changed_files(root, &sha)?
        .into_iter()
        .map(|(status, rel)| {
            let mut before = match &parent {
                Some(p) => vh::file_at(root, p, &rel)?,
                None => None,
            };
            let mut after = vh::file_at(root, &sha, &rel)?;
            if before
                .as_ref()
                .is_some_and(|s| s.len() > MAX_DIFF_SIDE_BYTES)
                || after
                    .as_ref()
                    .is_some_and(|s| s.len() > MAX_DIFF_SIDE_BYTES)
            {
                before = None;
                after = None;
            }
            Ok(FileDiff {
                path: rel,
                status: match status {
                    'A' => "added",
                    'D' => "deleted",
                    'R' => "renamed",
                    _ => "modified",
                }
                .to_string(),
                before,
                after,
            })
        })
        .collect()
}

/// Async + `spawn_blocking`: one git call per changed file side.
#[tauri::command]
pub async fn distill_run_diff(
    state: tauri::State<'_, VaultRoot>,
    vault: String,
    id: String,
) -> Result<Vec<FileDiff>, String> {
    let root = confine_root(&state, &vault)?;
    tauri::async_runtime::spawn_blocking(move || run_diff_core(std::path::Path::new(&root), &id))
        .await
        .map_err(|e| format!("join failed: {e}"))?
}

// ---- vault history (Q4 item 1) --------------------------------------------

#[tauri::command]
pub fn vault_history_status(
    state: tauri::State<VaultRoot>,
    vault: String,
) -> Result<crate::vault_history::HistoryStatus, String> {
    let root = confine_root(&state, &vault)?;
    let enabled = settings::load().vault_history_enabled;
    Ok(crate::vault_history::status(
        std::path::Path::new(&root),
        enabled,
    ))
}

#[tauri::command]
pub fn init_vault_history(state: tauri::State<VaultRoot>, vault: String) -> Result<(), String> {
    let root = confine_root(&state, &vault)?;
    crate::vault_history::init(std::path::Path::new(&root))?;
    let mut s = settings::load();
    s.vault_history_enabled = true;
    settings::save(&s)
}

#[tauri::command]
pub fn commit_human_edit(
    state: tauri::State<VaultRoot>,
    vault: String,
    rel: String,
) -> Result<bool, String> {
    let root = confine_root(&state, &vault)?;
    let root = std::path::Path::new(&root);
    if !settings::load().vault_history_enabled {
        return Ok(false);
    }
    crate::myco_pro::safe_join(root, &rel)?; // reject path escape before git sees it
    let stem = std::path::Path::new(&rel)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| rel.clone());
    crate::vault_history::commit_paths(
        root,
        &[rel.as_str()],
        &format!("edit: {stem}"),
        crate::vault_history::CommitIdentity::Human,
    )
}

// ---- authorship (Q4 item 16) ----------------------------------------------

/// Line ownership of one page — the reader's authorship badge. `None` when
/// the vault has no history or the page is untracked: no history, no claim.
#[tauri::command]
pub async fn page_authorship(
    state: tauri::State<'_, VaultRoot>,
    vault: String,
    rel: String,
) -> Result<Option<crate::vault_history::PageAuthorship>, String> {
    let root = confine_root(&state, &vault)?;
    // Git can wait for filesystem access; the reader and permission UI must
    // remain responsive while it does.
    run_file_task("page authorship", move || {
        let root = std::path::Path::new(&root);
        crate::myco_pro::safe_join(root, &rel)?; // reject path escape before git sees it
        crate::vault_history::page_authorship(root, &rel)
    })
    .await
}

/// File content at one revision — the reader's per-paragraph revert reads the
/// parent of the commit that wrote the paragraph (`<sha>^`). `None` when the
/// path did not exist in that tree. `rev` reaches a git argument, so it is
/// restricted to a hex sha with at most one trailing `^`: no refs, no options,
/// no `..` ranges.
#[tauri::command]
pub fn page_at_revision(
    state: tauri::State<VaultRoot>,
    vault: String,
    rel: String,
    rev: String,
) -> Result<Option<String>, String> {
    let root = confine_root(&state, &vault)?;
    let root = std::path::Path::new(&root);
    crate::myco_pro::safe_join(root, &rel)?; // reject path escape before git sees it
    let sha = rev.strip_suffix('^').unwrap_or(&rev);
    if !(7..=40).contains(&sha.len()) || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("not a revision: {rev}"));
    }
    crate::vault_history::file_at(root, &rev, &rel)
}

/// wiki/ rel -> ever committed by the agent author — the sidebar's
/// "human only" filter. One log walk; `{}` when the vault has no history.
#[tauri::command]
pub async fn authorship_index(
    state: tauri::State<'_, VaultRoot>,
    vault: String,
) -> Result<std::collections::HashMap<String, bool>, String> {
    let root = confine_root(&state, &vault)?;
    run_file_task("authorship index", move || {
        crate::vault_history::agent_touched_index(std::path::Path::new(&root))
    })
    .await
}

// ---- recall miss log (Q4 item 5) ------------------------------------------

/// Append one recall miss to `.myco/eval/misses.jsonl` (Q4 item 5).
pub(crate) fn append_recall_miss(
    root: &std::path::Path,
    query: &str,
    expected: Option<&str>,
) -> Result<(), String> {
    let dir = root.join(".myco").join("eval");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create eval dir: {e}"))?;
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let row = serde_json::json!({ "query": query, "expected": expected, "at": at });
    let line = format!("{row}\n");
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("misses.jsonl"))
        .map_err(|e| format!("open misses.jsonl: {e}"))?;
    f.write_all(line.as_bytes())
        .map_err(|e| format!("append miss: {e}"))
}

#[tauri::command]
pub fn record_recall_miss(
    state: tauri::State<VaultRoot>,
    vault: String,
    query: String,
    expected: Option<String>,
) -> Result<(), String> {
    let root = confine_root(&state, &vault)?;
    append_recall_miss(std::path::Path::new(&root), &query, expected.as_deref())
}

// ---- redaction scan (Q4 item 13) -------------------------------------------

/// Mirrored in ipc.ts `SecretScanReport` (Q4 item 13).
#[derive(Clone, serde::Serialize)]
pub struct SecretScanReport {
    pub secrets: Vec<String>,
    pub pii: Vec<String>,
}

/// Pattern names (never the matched text) found in `text` — the TS promotion
/// paths call this before any raw/ write (Q4 item 13).
#[tauri::command]
pub fn scan_text_secrets(text: String) -> SecretScanReport {
    SecretScanReport {
        secrets: crate::importers::secrets_scan::scan(&text)
            .into_iter()
            .map(String::from)
            .collect(),
        pii: crate::importers::secrets_scan::scan_pii(&text)
            .into_iter()
            .map(String::from)
            .collect(),
    }
}

// ---- retro raw/ audit (Q4 item 14) -----------------------------------------

/// One flagged raw/ file. Mirrored in ipc.ts `RawAuditHit`.
#[derive(Clone, serde::Serialize)]
pub struct RawAuditHit {
    /// Vault-relative path under `raw/`.
    pub rel: String,
    /// Pattern NAMES only — the matched text never leaves the scan.
    pub patterns: Vec<String>,
    /// True when the file no longer exists in the worktree (found in git
    /// history only) — there is nothing left to open.
    pub in_history_only: bool,
}

/// Mirrored in ipc.ts `RawAuditReport` (Q4 item 14).
#[derive(Clone, serde::Serialize)]
pub struct RawAuditReport {
    pub files_scanned: usize,
    /// Historical raw/ blobs read back; 0 when the vault has no git repo.
    pub history_files_scanned: usize,
    pub secret_hits: Vec<RawAuditHit>,
    pub pii_hits: Vec<RawAuditHit>,
    /// True when a history cap (2000 blobs, 256 KiB/blob) cut the scan short.
    pub truncated: bool,
}

fn push_audit_hit(hits: &mut Vec<RawAuditHit>, rel: &str, patterns: Vec<&'static str>) {
    if !patterns.is_empty() {
        hits.push(RawAuditHit {
            rel: rel.to_string(),
            patterns: patterns.into_iter().map(String::from).collect(),
            in_history_only: false,
        });
    }
}

/// Scan every file currently under `raw/`. Files that don't decode as UTF-8
/// are counted but not pattern-scanned — the patterns are text shapes, and a
/// photo can't leak a key through them. Pure disk walk, no git, no writes.
pub(crate) fn audit_worktree(
    root: &std::path::Path,
) -> (usize, Vec<RawAuditHit>, Vec<RawAuditHit>) {
    let mut files = 0usize;
    let mut secret_hits = Vec::new();
    let mut pii_hits = Vec::new();
    let mut stack = vec![root.join("raw")];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue; // raw/ absent (or unreadable) => nothing to report
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            files += 1;
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            let Ok(text) = String::from_utf8(bytes) else {
                continue; // binary: counted above, not scanned
            };
            let rel = path
                .strip_prefix(root)
                .map(|r| r.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| path.to_string_lossy().into_owned());
            push_audit_hit(
                &mut secret_hits,
                &rel,
                crate::importers::secrets_scan::scan(&text),
            );
            push_audit_hit(
                &mut pii_hits,
                &rel,
                crate::importers::secrets_scan::scan_pii(&text),
            );
        }
    }
    secret_hits.sort_by(|a, b| a.rel.cmp(&b.rel));
    pii_hits.sort_by(|a, b| a.rel.cmp(&b.rel));
    (files, secret_hits, pii_hits)
}

/// History cap: at most this many blobs are read back per audit.
const AUDIT_MAX_BLOBS: usize = 2000;
/// History cap: only the first 256 KiB of each blob is scanned.
const AUDIT_BLOB_CAP: usize = 256 * 1024;

/// `(adding commit, rel)` for every raw/ file ever committed — the
/// `--diff-filter=A` arm of the audit. Deduped; a path re-added in several
/// commits is read at each adding commit (its contents may differ).
fn raw_history_pairs(root: &std::path::Path) -> Vec<(String, String)> {
    let Ok(out) = crate::vault_history::git(
        root,
        &[
            "-c",
            "core.quotepath=off",
            "log",
            "--all",
            "--diff-filter=A",
            "--format=%H",
            "--name-only",
            "--",
            "raw/",
        ],
    ) else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new(); // empty repo: git log refuses; degrade to worktree-only
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut sha = String::new();
    let mut seen = std::collections::HashSet::new();
    let mut pairs = Vec::new();
    for line in text.lines() {
        if line.len() == 40 && line.bytes().all(|b| b.is_ascii_hexdigit()) {
            sha = line.to_string();
        } else if line.starts_with("raw/")
            && !sha.is_empty()
            && seen.insert((sha.clone(), line.to_string()))
        {
            pairs.push((sha.clone(), line.to_string()));
        }
    }
    pairs
}

/// Fold one history hit into the per-rel pattern union.
fn note_history_hit(
    map: &mut std::collections::BTreeMap<String, Vec<String>>,
    rel: &str,
    names: Vec<&'static str>,
) {
    if names.is_empty() {
        return;
    }
    let entry = map.entry(rel.to_string()).or_default();
    for n in names {
        if !entry.iter().any(|e| e == n) {
            entry.push(n.to_string());
        }
    }
}

/// Merge history findings into the worktree hit list. A rel the worktree scan
/// already flagged gains any extra pattern names; a rel with no file left on
/// disk becomes an `in_history_only` hit.
fn merge_history_hits(
    root: &std::path::Path,
    hits: &mut Vec<RawAuditHit>,
    hist: std::collections::BTreeMap<String, Vec<String>>,
) {
    for (rel, patterns) in hist {
        if let Some(h) = hits.iter_mut().find(|h| h.rel == rel) {
            for p in patterns {
                if !h.patterns.contains(&p) {
                    h.patterns.push(p);
                }
            }
        } else {
            let in_history_only = !root.join(&rel).exists();
            hits.push(RawAuditHit {
                rel,
                patterns,
                in_history_only,
            });
        }
    }
    hits.sort_by(|a, b| a.rel.cmp(&b.rel));
}

/// Worktree + git-history audit of `raw/`. Read-only in the strictest sense:
/// nothing under `raw/` is written, moved, or deleted — remediation is the
/// documented `git filter-repo` procedure, run by the owner outside the app.
pub(crate) fn audit_vault(root: &std::path::Path) -> RawAuditReport {
    let (files_scanned, mut secret_hits, mut pii_hits) = audit_worktree(root);
    let mut history_files_scanned = 0usize;
    let mut truncated = false;
    let mut hist_secrets = std::collections::BTreeMap::new();
    let mut hist_pii = std::collections::BTreeMap::new();
    if root.join(".git").exists() {
        for (sha, rel) in raw_history_pairs(root) {
            if history_files_scanned == AUDIT_MAX_BLOBS {
                truncated = true;
                break;
            }
            // Blob gone or unreadable (shallow prune, odd object): skip — the
            // audit is best-effort over what git can still show.
            let Ok(Some(text)) = crate::vault_history::file_at(root, &sha, &rel) else {
                continue;
            };
            history_files_scanned += 1;
            let mut end = text.len().min(AUDIT_BLOB_CAP);
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            if end < text.len() {
                truncated = true;
            }
            let text = &text[..end];
            note_history_hit(
                &mut hist_secrets,
                &rel,
                crate::importers::secrets_scan::scan(text),
            );
            note_history_hit(
                &mut hist_pii,
                &rel,
                crate::importers::secrets_scan::scan_pii(text),
            );
        }
    }
    merge_history_hits(root, &mut secret_hits, hist_secrets);
    merge_history_hits(root, &mut pii_hits, hist_pii);
    RawAuditReport {
        files_scanned,
        history_files_scanned,
        secret_hits,
        pii_hits,
        truncated,
    }
}

/// Read-only audit of `raw/` — current files AND every raw/ blob in vault git
/// history (Q4 item 14). The app never modifies raw/; hits are reported for
/// the owner to act on outside the app.
///
/// Async + `spawn_blocking`: a full worktree walk plus up to 2000 `git show`s.
#[tauri::command]
pub async fn scan_raw_audit(
    state: tauri::State<'_, VaultRoot>,
    vault: String,
) -> Result<RawAuditReport, String> {
    let root = confine_root(&state, &vault)?;
    tauri::async_runtime::spawn_blocking(move || audit_vault(std::path::Path::new(&root)))
        .await
        .map_err(|e| format!("raw audit task failed: {e}"))
}

// ---- page-open tracking (Q4 item 10) ---------------------------------------

/// Record that the frontend opened a vault page — feeds resurface dormancy.
#[tauri::command]
pub fn record_page_open(
    state: tauri::State<VaultRoot>,
    vault: String,
    rel: String,
) -> Result<(), String> {
    let root = confine_root(&state, &vault)?;
    let root = std::path::Path::new(&root);
    crate::myco_pro::safe_join(root, &rel)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    crate::page_opens::record(root, &rel, now)
}

// ---- Ask history (UX S36) ---------------------------------------------------

/// The open vault's Ask-history log. `vault` must be that vault's root, so a
/// turn that finishes after a vault switch cannot land in the other's log.
fn ask_history_path(state: &tauri::State<VaultRoot>, vault: &str) -> Result<PathBuf, String> {
    let root = require_root(state)?;
    if confine_root(state, vault)? != root.to_string_lossy() {
        return Err("not the open vault".into());
    }
    crate::ask_history::path_for(&root.to_string_lossy())
}

/// The open vault's past Ask turns on this device, oldest first.
#[tauri::command]
pub fn ask_history_load(
    state: tauri::State<VaultRoot>,
    vault: String,
) -> Result<Vec<crate::ask_history::AskTurn>, String> {
    crate::ask_history::load(&ask_history_path(&state, &vault)?)
}

/// Append one finished Ask turn to the open vault's history.
#[tauri::command]
pub fn ask_history_append(
    state: tauri::State<VaultRoot>,
    vault: String,
    turn: crate::ask_history::AskTurn,
) -> Result<(), String> {
    crate::ask_history::append(&ask_history_path(&state, &vault)?, &turn)
}

/// Files and bytes held by every `sessions/archive/` and `daily/archive/`
/// bucket — the numbers behind the Settings → Distill storage panel. Computed
/// on demand (this command), never on render. `raw/archive/` is deliberately
/// not measured here: it is immutable, so its size is not actionable.
#[tauri::command]
pub fn archive_usage(
    state: tauri::State<VaultRoot>,
    vault: String,
    origin: AgentVaultSession,
) -> Result<Vec<crate::archive_pack::BucketUsage>, String> {
    crate::archive_pack::usage_for_origin(&state, &origin, &vault)
}

/// Pack every session/daily archive bucket older than `older_than_months`
/// into one zip each. USER-TRIGGERED ONLY — no scheduler, no distill chain,
/// no auto-run reaches this. `raw/` is never touched (see `archive_pack`'s
/// module comment and its `TREES` list).
#[tauri::command]
pub fn compress_archives(
    state: tauri::State<VaultRoot>,
    vault: String,
    origin: AgentVaultSession,
    older_than_months: u32,
) -> Result<crate::archive_pack::PackReport, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    compress_archives_core(&state, &vault, &origin, older_than_months, now)
}

fn compress_archives_core(
    state: &VaultRoot,
    vault: &str,
    origin: &AgentVaultSession,
    older_than_months: u32,
    now: i64,
) -> Result<crate::archive_pack::PackReport, String> {
    crate::archive_pack::compress_for_origin(state, origin, vault, older_than_months, now)
}

fn restore_archive_bucket_core(
    state: &VaultRoot,
    vault: &str,
    origin: &AgentVaultSession,
    tree: &str,
    bucket: &str,
) -> Result<crate::archive_pack::RestoreReport, String> {
    crate::archive_pack::restore_for_origin(state, origin, vault, tree, bucket)
}

#[cfg(test)]
#[path = "archive_compaction_admission_tests.rs"]
mod archive_compaction_admission_tests;

/// Unpack one compressed bucket back to its directory — the user-facing
/// reverse of `compress_archives`.
#[tauri::command]
pub fn restore_archive_bucket(
    state: tauri::State<VaultRoot>,
    vault: String,
    origin: AgentVaultSession,
    tree: String,
    bucket: String,
) -> Result<crate::archive_pack::RestoreReport, String> {
    restore_archive_bucket_core(&state, &vault, &origin, &tree, &bucket)
}

/// Vault-wide distillation status for the settings tab / MCP `distill_status`
/// — backlog count, pending proposals, last run, and the backlog trend.
#[tauri::command]
pub async fn distill_status(
    state: tauri::State<'_, VaultRoot>,
    vault: String,
) -> Result<crate::distill::DistillStatus, String> {
    let root = confine_root(&state, &vault)?;
    run_file_task("distill status", move || {
        Ok(crate::distill::status(std::path::Path::new(&root)))
    })
    .await
}

/// One `_inbox/quarantine/` item as the review UI needs it: the verdict
/// sidecar's fields plus a one-line body preview. `distill::quarantine_entries`
/// returns the two halves as a tuple (its `preview` is read from the content
/// file, not the sidecar); this flattens them into the single object the
/// frontend consumes.
#[derive(serde::Serialize)]
pub struct QuarantineItem {
    #[serde(flatten)]
    pub entry: crate::distill::QuarantineEntry,
    pub preview: String,
}

/// Everything sitting in `_inbox/quarantine/` awaiting human review. Read-only
/// — see `distill::quarantine_entries` for the per-field degradation contract
/// (a malformed sidecar still lists its item).
#[tauri::command]
pub async fn list_quarantine(
    state: tauri::State<'_, VaultRoot>,
    vault: String,
) -> Result<Vec<QuarantineItem>, String> {
    let root = confine_root(&state, &vault)?;
    run_file_task("list quarantine", move || {
        Ok(
            crate::distill::quarantine_entries(std::path::Path::new(&root))
                .into_iter()
                .map(|(entry, preview)| QuarantineItem { entry, preview })
                .collect(),
        )
    })
    .await
}

/// Restore quarantined items to `_inbox/` through the existing re-admit path.
/// See `distill::readmit_quarantine`.
#[tauri::command]
pub fn restore_quarantine(
    state: tauri::State<VaultRoot>,
    vault: String,
    files: Vec<String>,
) -> Result<String, String> {
    let root = confine_root(&state, &vault)?;
    crate::distill::readmit_quarantine(std::path::Path::new(&root), &files)
}

/// "Keep N more days" — push the quarantine TTL the sidecar already tracks.
/// See `distill::extend_quarantine`.
#[tauri::command]
pub fn extend_quarantine(
    state: tauri::State<VaultRoot>,
    vault: String,
    files: Vec<String>,
    days: u32,
    origin: AgentVaultSession,
) -> Result<usize, String> {
    extend_quarantine_core(&state, &vault, &origin, &files, days)
}

fn extend_quarantine_core(
    state: &VaultRoot,
    vault: &str,
    origin: &AgentVaultSession,
    files: &[String],
    days: u32,
) -> Result<usize, String> {
    state.with_origin(origin, |root| {
        check_expected_vault(root, Some(vault))?;
        crate::distill::extend_quarantine(root, files, days)
    })
}

#[cfg(test)]
#[path = "commands_keep_opening_tests.rs"]
mod keep_opening_tests;

/// Execute a pending distill proposal (Task 7, Phase A) — `admit-cluster`,
/// `archive-batch`, or `delete-batch`. The frontend flips `pending` to
/// `approved`/`dismissed` itself by rewriting the proposal file (Task 9);
/// this command does the one lifecycle step that actually touches the
/// filesystem beyond that flip, and marks the proposal `done`. See
/// `distill::apply_proposal`'s own doc comment.
#[tauri::command]
pub fn apply_distill_proposal(
    state: tauri::State<VaultRoot>,
    vault: String,
    path: String,
    expected_permanent: Option<bool>,
) -> Result<String, String> {
    let root = confine_root(&state, &vault)?;
    crate::distill::apply_proposal_confirmed(std::path::Path::new(&root), &path, expected_permanent)
}

/// `sessions/` days ready for Phase B's LLM digest step. See
/// `distill::digestable_session_days`'s own doc comment.
#[tauri::command]
pub async fn digestable_session_days(
    state: tauri::State<'_, VaultRoot>,
    vault: String,
) -> Result<Vec<crate::distill::DigestDay>, String> {
    let root = confine_root(&state, &vault)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::distill::digestable_session_days(std::path::Path::new(&root))
    })
    .await
    .map_err(|e| format!("session days task failed: {e}"))?
}

/// Publish managed output through an origin-bound CAS and native authority issuer.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Flat IPC preserves the separate native role and origin fields.
pub fn publish_distill_note(
    state: tauri::State<VaultRoot>,
    publications: tauri::State<crate::distill_publication::DistillPublicationRegistry>,
    origin: AgentVaultSession,
    operation_id: String,
    artifact: crate::distill_publication::ManagedArtifact,
    content: String,
    expected_sha256: Option<String>,
    role_snapshot: Option<crate::role_authorization::RoleSnapshot>,
) -> Result<crate::distill_publication::PublicationReceipt, String> {
    let snapshot =
        role_snapshot.ok_or("managed publication requires its generation role snapshot")?;
    let receipt = authorized_role(
        &state,
        &origin,
        &snapshot,
        crate::role_authorization::RoleId::Organization,
        |root| {
            crate::distill_publication::publish_at(
                root,
                &publications,
                &origin,
                &operation_id,
                &artifact,
                &content,
                expected_sha256.as_deref(),
            )
        },
    )?;
    if let Some(updater) = crate::INDEX_UPDATER.get() {
        updater.mark_dirty(
            std::path::Path::new(&origin.vault_path),
            receipt.path.clone(),
        );
    }
    Ok(receipt)
}

/// Move a digested day's `sessions/` files into `sessions/archive/`. See
/// `distill::archive_digested_sessions`'s own doc comment.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Flat IPC fields preserve the typed frontend contract.
pub fn archive_digested_sessions(
    state: tauri::State<VaultRoot>,
    registry: tauri::State<crate::distill_publication::DistillPublicationRegistry>,
    vault: String,
    day: String,
    files: Vec<String>,
    fingerprints: Option<Vec<String>>,
    origin: AgentVaultSession,
    manifest_id: String,
    publications: Vec<crate::distill::ArchivePublication>,
    publication_ids: Option<Vec<String>>,
) -> Result<crate::distill::ArchiveReceipt, String> {
    archive_publication_dispatch(
        &state,
        &registry,
        &vault,
        &origin,
        &manifest_id,
        publication_ids.as_deref().unwrap_or_default(),
        &publications,
        |root, proven| {
            let context = crate::distill::ArchiveContext {
                manifest_id: manifest_id.clone(),
                publications: proven,
            };
            crate::distill::archive_digested_sessions_with_context(
                root,
                &day,
                &files,
                fingerprints.as_deref(),
                Some(&context),
            )
        },
    )
}

fn archive_origin_dispatch<T>(
    state: &VaultRoot,
    vault: &str,
    origin: &AgentVaultSession,
    dispatch: impl FnOnce(&std::path::Path) -> Result<T, String>,
) -> Result<T, String> {
    if vault != origin.vault_path {
        return Err("archive vault differs from its opening identity".into());
    }
    state.with_origin(origin, dispatch)
}

#[allow(clippy::too_many_arguments)] // Shared native dispatch for the flat IPC authorization fields.
fn archive_publication_dispatch<T>(
    state: &VaultRoot,
    registry: &crate::distill_publication::DistillPublicationRegistry,
    vault: &str,
    origin: &AgentVaultSession,
    operation: &str,
    publication_ids: &[String],
    publications: &[crate::distill::ArchivePublication],
    dispatch: impl FnOnce(
        &std::path::Path,
        Vec<crate::distill::ArchivePublication>,
    ) -> Result<T, String>,
) -> Result<T, String> {
    archive_origin_dispatch(state, vault, origin, |root| {
        let proven = crate::distill_publication::validate(
            registry,
            root,
            origin,
            operation,
            publication_ids,
            publications,
        )?;
        dispatch(root, proven)
    })
}

#[cfg(test)]
#[path = "archive_command_tests.rs"]
mod archive_command_tests;

/// Settled buckets ready for a rollup step: `layer` is `"weekly"` (ISO weeks
/// of `daily/` digests, ROADMAP P1) or `"monthly"` (months of `weekly/`
/// rollups). See `distill::rollupable_buckets`'s own doc comment.
#[tauri::command]
pub fn rollupable_buckets(
    state: tauri::State<VaultRoot>,
    vault: String,
    layer: String,
) -> Result<Vec<crate::distill::RollupBucket>, String> {
    let root = confine_root(&state, &vault)?;
    let layer = crate::distill::rollup_layer(&layer)
        .ok_or_else(|| format!("unknown rollup layer `{layer}`"))?;
    Ok(crate::distill::rollupable_buckets(
        std::path::Path::new(&root),
        layer,
    ))
}

/// Move a rolled-up bucket's source notes into `<src>/archive/<bucket>/` —
/// `daily/` for the weekly layer, `weekly/` for the monthly one. See
/// `distill::archive_rolled`'s own doc comment.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Flat IPC fields preserve the typed frontend contract.
pub fn archive_rolled(
    state: tauri::State<VaultRoot>,
    registry: tauri::State<crate::distill_publication::DistillPublicationRegistry>,
    vault: String,
    layer: String,
    bucket: String,
    files: Vec<String>,
    fingerprints: Option<Vec<String>>,
    origin: AgentVaultSession,
    manifest_id: String,
    publications: Vec<crate::distill::ArchivePublication>,
    publication_ids: Option<Vec<String>>,
) -> Result<crate::distill::ArchiveReceipt, String> {
    let layer = crate::distill::rollup_layer(&layer)
        .ok_or_else(|| format!("unknown rollup layer `{layer}`"))?;
    archive_publication_dispatch(
        &state,
        &registry,
        &vault,
        &origin,
        &manifest_id,
        publication_ids.as_deref().unwrap_or_default(),
        &publications,
        |root, proven| {
            let context = crate::distill::ArchiveContext {
                manifest_id: manifest_id.clone(),
                publications: proven,
            };
            crate::distill::archive_rolled_with_context(
                root,
                layer,
                &bucket,
                &files,
                fingerprints.as_deref(),
                Some(&context),
            )
        },
    )
}

/// Gate-admitted Full-tier items ready for the LLM ingest pipeline (Phase B,
/// Task 3). Read-only. See `distill::full_tier_items`'s own doc comment.
#[tauri::command]
pub async fn full_tier_items(
    state: tauri::State<'_, VaultRoot>,
    vault: String,
) -> Result<Vec<String>, String> {
    let root = confine_root(&state, &vault)?;
    tauri::async_runtime::spawn_blocking(move || {
        // A corrupt promotion queue must surface as an error, not an empty queue.
        crate::importers::wikify::Pending::try_load(std::path::Path::new(&root))?;
        crate::distill::full_tier_items(std::path::Path::new(&root))
    })
    .await
    .map_err(|e| format!("full tier items task failed: {e}"))?
}

/// Record only native-managed publications in the shared run history. Caller
/// creation flags and observed file hashes do not grant creation or move authority.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Flat IPC fields preserve the typed publication contract.
pub fn append_distill_manifest(
    state: tauri::State<VaultRoot>,
    registry: tauri::State<crate::distill_publication::DistillPublicationRegistry>,
    vault: String,
    id: String,
    moves: Vec<crate::distill::MoveEntry>,
    created: Vec<String>,
    origin: AgentVaultSession,
    created_revisions: Vec<crate::distill::ArchivePublication>,
    publication_ids: Option<Vec<String>>,
) -> Result<(), String> {
    append_distill_manifest_dispatch(
        &state,
        &registry,
        &vault,
        &origin,
        &id,
        moves,
        created,
        created_revisions,
        publication_ids.as_deref().unwrap_or_default(),
    )
}

#[allow(clippy::too_many_arguments)] // Shared native dispatch for the flat IPC authorization fields.
fn append_distill_manifest_dispatch(
    state: &VaultRoot,
    registry: &crate::distill_publication::DistillPublicationRegistry,
    vault: &str,
    origin: &AgentVaultSession,
    id: &str,
    moves: Vec<crate::distill::MoveEntry>,
    created: Vec<String>,
    created_revisions: Vec<crate::distill::ArchivePublication>,
    publication_ids: &[String],
) -> Result<(), String> {
    if !moves.is_empty() {
        return Err("manifest moves require private native move receipts; artifacts preserved for manual recovery".into());
    }
    archive_publication_dispatch(
        state,
        registry,
        vault,
        origin,
        id,
        publication_ids,
        &created_revisions,
        |root, proven| {
            if created.iter().any(|path| {
                !proven
                    .iter()
                    .any(|proof| proof.path == *path && proof.created)
            }) {
                return Err("created note paths require native creation authority".into());
            }
            crate::distill::append_distill_manifest_checked(root, id, moves, proven)
        },
    )
}

#[cfg(test)]
#[path = "distill_publication_boundary_tests.rs"]
mod distill_publication_boundary_tests;

/// The bundled digest runner script (falls back to the repo path in dev).
/// Only the macOS launchd migration on vault open needs it.
#[cfg(target_os = "macos")]
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

// ---- In-app agent (Feature 4) ----

/// The agent tool schemas the model may call (read tools + gated write tools).
#[tauri::command]
pub fn agent_tools_schema() -> Vec<crate::agent_tools::ToolDescriptor> {
    crate::agent_tools::descriptors()
}

#[tauri::command]
pub fn agent_vault_session(state: tauri::State<VaultRoot>) -> Result<AgentVaultSession, String> {
    state.snapshot()
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
    origin: AgentVaultSession,
) -> Result<serde_json::Value, String> {
    state.with_origin(&origin, |root| {
        crate::agent_tools::dispatch(&root.to_string_lossy(), &name, &args, allow_write)
    })
}

/// Reflect applies only within the native opening that produced the finding.
#[tauri::command]
pub fn reflect_create_missing_page(
    state: tauri::State<VaultRoot>,
    origin: AgentVaultSession,
    target: String,
) -> Result<String, String> {
    state.with_origin(&origin, |root| {
        reflect_create_missing_page_at(root, &target)
    })
}

fn reflect_create_missing_page_at(root: &std::path::Path, target: &str) -> Result<String, String> {
    fn resolve(nodes: &[FileNode], root: &std::path::Path, target: &str) -> Option<String> {
        for node in nodes {
            match node {
                FileNode::File { path, name } => {
                    let relative = std::path::Path::new(path).strip_prefix(root).ok()?;
                    let key = if target.contains('/') {
                        relative.to_string_lossy().into_owned()
                    } else {
                        name.clone()
                    };
                    let key = crate::norm::nfc(&key).to_lowercase();
                    if key == target || key.strip_suffix(".md") == Some(target) {
                        return Some(path.clone());
                    }
                }
                FileNode::Directory { name, children, .. }
                    if name != "templates" && name != "cards" =>
                {
                    if let Some(path) = resolve(children, root, target) {
                        return Some(path);
                    }
                }
                _ => {}
            }
        }
        None
    }
    if target.trim().is_empty() || target.chars().any(char::is_control) {
        return Err("invalid missing page target".into());
    }
    let tree = vault::list_files(&root.to_string_lossy())?;
    let normalized = crate::norm::nfc(target).to_lowercase();
    if let Some(path) = resolve(&tree, root, &normalized) {
        return Ok(path);
    }
    let name = format!("{}.md", target.replace(['/', '\\'], "-"));
    let parent = vault::confine_parent(root, &root.join("wiki").to_string_lossy())?;
    let path = parent.join(&name);
    let confined = vault::confine_delete_path(root, &path.to_string_lossy())?;
    if vault::is_raw_path(root, &confined) {
        return Err("refused: raw/ is immutable".into());
    }
    if confined.is_file() {
        return Ok(confined.to_string_lossy().into_owned());
    }
    let content = vault::wiki_page_stub(target, &registry::today_utc());
    let created =
        vault::create_file_checked_at(root, &root.join("wiki").to_string_lossy(), &name, &content)?;
    if let Some(updater) = crate::INDEX_UPDATER.get() {
        if let Ok(rel) = path.strip_prefix(root) {
            updater.mark_dirty(root, rel.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(created)
}

/// One tool-calling turn for the in-app agent loop (HTTP providers only).
#[tauri::command]
pub async fn agent_chat(
    state: tauri::State<'_, VaultRoot>,
    request: providers::AgentChatRequest,
    origin: Option<AgentVaultSession>,
    role_snapshot: Option<crate::role_authorization::RoleSnapshot>,
) -> Result<providers::AgentTurn, String> {
    use crate::role_authorization::RoleId;
    let origin = origin.ok_or("native agent requires a vault opening")?;
    let snapshot = role_snapshot.ok_or("native agent requires its own role snapshot")?;
    let key = authorized_role(&state, &origin, &snapshot, RoleId::Agent, |_| {
        if request.provider_id != snapshot.route_signature.provider_id
            || request.model != snapshot.route_signature.model_id
        {
            return Err("request_route_mismatch: agent selection changed".into());
        }
        secrets::get_key(&request.provider_id)
    })?;
    await_authorized(
        &state,
        &origin,
        &snapshot,
        RoleId::Agent,
        providers::agent_chat(request, key),
    )
    .await
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

/// Whether `target` is safe to pass through `cmd.exe` on Windows.
///
/// The Windows branch launches via `cmd /C start`, and cmd re-parses the command
/// line with its own rules — Rust's argument quoting does not escape cmd
/// metacharacters, because it cannot know the child is a shell. So
/// `https://ok.com/&calc` opens the URL AND runs `calc`, and the scheme
/// allow-list waves it through because the scheme really is https.
///
/// The input is attacker-controlled: a link in a clipped, imported, synced or
/// ingested note reaches here on a click. markdown-it percent-encodes spaces
/// (`%20`), so a payload cannot carry arguments — but `&` survives verbatim, and
/// "run any executable already on PATH, without arguments" is enough.
///
/// Kept pure and separate from the platform branch so it is unit-testable
/// everywhere, not only on Windows.
fn windows_opener_safe(target: &str) -> bool {
    // cmd.exe's metacharacters, plus % (environment expansion) and the control
    // characters that could split the command line.
    !target.contains(['&', '|', '<', '>', '^', '"', '%', '(', ')', '\n', '\r'])
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
        // `start` runs inside cmd.exe, which would interpret metacharacters in
        // the URL as command syntax. Refusing them is the zero-dependency half
        // of the fix; routing around cmd entirely (ShellExecuteW, e.g. via
        // tauri-plugin-opener) is the other half and needs a Windows machine to
        // verify, so it is deliberately not done here.
        if !windows_opener_safe(&url) {
            return Err(format!("refused to open: {url}"));
        }
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
    } else {
        std::process::Command::new("xdg-open").arg(&url).spawn()
    };
    cmd.map(|_| ()).map_err(|e| format!("open failed: {e}"))
}

/// Native (in-process) MCP server status + one-click connect info. Replaces the
/// former Python install/serve/register flow — there is nothing to install.
#[tauri::command]
pub fn mcp_info() -> crate::mcp_native::NativeInfo {
    crate::mcp_native::info()
}

/// One-click Connect: register myco with Claude Code over HTTP, with the token.
#[tauri::command]
pub async fn mcp_connect() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(crate::mcp_native::register)
        .await
        .map_err(|e| format!("join failed: {e}"))?
}

// ---------------------------------------------------------------------------
// Semantic layer (Feature 1): embed vault pages into an on-disk vector index and
// serve semantic search / related-pages. Embedding runs offline via the bundled
// E5 encoder ("builtin-local") or the user's selected local Ollama model.
// ---------------------------------------------------------------------------

use crate::embeddings;
use crate::perf;
use crate::vector_index::{is_cold, EdgeLookup, Hit as VecHit, VectorCache, VectorStore};

pub(crate) fn embedding_model_id(provider: &str, model: &str) -> Result<String, String> {
    match provider {
        "" | "builtin-local" => Ok(format!(
            "builtin-local:{}",
            if model.is_empty() {
                crate::local_llm::BUILTIN_EMBED_MODEL
            } else {
                model
            }
        )),
        "ollama" => Ok(format!(
            "ollama:{}",
            if model.is_empty() {
                "nomic-embed-text"
            } else {
                model
            }
        )),
        _ => Err("unsupported embedding provider".into()),
    }
}

pub(crate) async fn embedding_index_signature(
    app: &tauri::AppHandle,
    provider: &str,
    model: &str,
) -> Result<String, String> {
    if provider.is_empty() || provider == "builtin-local" {
        let model = if model.is_empty() {
            crate::local_llm::BUILTIN_EMBED_MODEL
        } else {
            model
        };
        let spec =
            crate::local_llm::embed_spec_by_id(model).ok_or("unknown builtin embed model")?;
        let path = local_embed_model_path(app, spec.file)?;
        let fingerprint = tauri::async_runtime::spawn_blocking(move || {
            crate::local_llm::embed_model_fingerprint(&path)
        })
        .await
        .map_err(|e| format!("embed identity task: {e}"))??;
        Ok(builtin_embedding_signature(spec, &fingerprint))
    } else if provider == "ollama" {
        use sha2::{Digest, Sha256};
        let runtime = format!("{:x}", Sha256::digest(include_bytes!("../Cargo.lock")));
        let model = if model.is_empty() {
            "nomic-embed-text"
        } else {
            model
        };
        let digest = embeddings::ollama_model_digest("http://localhost:11434", model).await?;
        let daemon_version = embeddings::ollama_runtime_version("http://localhost:11434").await?;
        Ok(format!(
            "{}:runtime-lock={runtime}:ollama:{model}:digest={digest}:daemon={daemon_version}:l2",
            embeddings::INDEX_SIGNATURE
        ))
    } else {
        Err("unsupported embedding provider".into())
    }
}

fn builtin_embedding_signature(spec: &crate::local_llm::EmbedSpec, fingerprint: &str) -> String {
    use sha2::{Digest, Sha256};
    let runtime = format!("{:x}", Sha256::digest(include_bytes!("../Cargo.lock")));
    format!(
        "{}:runtime-lock={runtime}:{fingerprint}:{:?}:{}:{}:{}:dim={:?}",
        embeddings::INDEX_SIGNATURE,
        spec.pooling,
        spec.max_ctx,
        spec.query_prefix,
        spec.doc_prefix,
        spec.output_dim
    )
}

/// Bind local batches to the actual resident encoder and outside identity
/// observations. Ollama batches use manifest observations from the local daemon.
pub(crate) async fn embed_texts_checked(
    app: tauri::AppHandle,
    llm: tauri::State<'_, LocalLlmState>,
    provider: &str,
    model: &str,
    role: crate::local_llm::EmbedRole,
    texts: Vec<String>,
) -> Result<embeddings::EmbeddedBatch, String> {
    let count = texts.len();
    let signature = embedding_index_signature(&app, provider, model).await?;
    let (produced_signature, vectors) = if provider.is_empty() || provider == "builtin-local" {
        let selected = if model.is_empty() {
            crate::local_llm::BUILTIN_EMBED_MODEL
        } else {
            model
        };
        let spec =
            crate::local_llm::embed_spec_by_id(selected).ok_or("unknown builtin embed model")?;
        let path = local_embed_model_path(&app, spec.file)?;
        with_local_llm(app.clone(), llm, move |host| {
            host.ensure_embed_model(&path)?;
            let produced = builtin_embedding_signature(spec, host.resident_embed_fingerprint()?);
            let vectors = host.embed_spec(spec, role, &texts)?;
            Ok((produced, vectors))
        })
        .await?
    } else {
        (
            signature.clone(),
            embed_texts(app.clone(), llm, provider, model, role, texts).await?,
        )
    };
    if produced_signature != signature
        || embedding_index_signature(&app, provider, model).await? != signature
    {
        return Err("embedding model changed during batch inference".into());
    }
    let space = embeddings::EmbeddingSpace {
        model: embedding_model_id(provider, model)?,
        signature,
        dim: vectors
            .first()
            .ok_or("checked embedding batch is empty")?
            .len(),
    };
    space.validate_batch(&vectors, count)?;
    Ok(embeddings::EmbeddedBatch { space, vectors })
}

/// Embed a batch of texts with the chosen provider. `role` picks the query/doc
/// instruction prefix for asymmetric embedding models (bge-m3 ignores it — see
/// `EmbedSpec.query_prefix`/`doc_prefix`).
pub(crate) async fn embed_texts(
    app: tauri::AppHandle,
    llm: tauri::State<'_, LocalLlmState>,
    provider: &str,
    model: &str,
    role: crate::local_llm::EmbedRole,
    texts: Vec<String>,
) -> Result<Vec<Vec<f32>>, String> {
    match provider {
        "" | "builtin-local" => {
            // Pre-migration callers (an index/id still on the old bundled-Gemma
            // scheme) may pass an empty model; treat that the same as the
            // current bundled winner rather than failing the lookup.
            let model = if model.is_empty() {
                crate::local_llm::BUILTIN_EMBED_MODEL
            } else {
                model
            };
            let spec = crate::local_llm::embed_spec_by_id(model)
                .ok_or_else(|| format!("unknown builtin embed model: {model}"))?;
            let embed_path = local_embed_model_path(&app, spec.file)?;
            with_local_llm(app, llm, move |m| {
                // The resident encoder is reused only while its file identity matches.
                m.ensure_embed_model(&embed_path)?;
                m.embed_spec(spec, role, &texts)
            })
            .await
        }
        "ollama" => {
            let m = if model.is_empty() {
                "nomic-embed-text"
            } else {
                model
            };
            embeddings::embed_ollama("http://localhost:11434", m, &texts).await
        }
        other => Err(format!("unsupported embedding provider: {other}")),
    }
}

/// Embed arbitrary texts with the bundled local embedder
/// (`local_llm::BUILTIN_EMBED_MODEL`, e5-small-ko).
///
/// Exists for the extractive session digest (`sessionDigest.ts`): when the
/// query provider is builtin-local there is no generative model to summarize
/// a day's session logs, so the frontend ranks candidate quotes by embedding
/// instead — deliberately builtin-only, because it is needed exactly when no
/// external provider is connected.
#[tauri::command]
pub async fn embed_local_texts(
    app: tauri::AppHandle,
    llm: tauri::State<'_, LocalLlmState>,
    texts: Vec<String>,
) -> Result<Vec<Vec<f32>>, String> {
    embed_texts(
        app,
        llm,
        "builtin-local",
        crate::local_llm::BUILTIN_EMBED_MODEL,
        crate::local_llm::EmbedRole::Document,
        texts,
    )
    .await
}

/// Collect `wiki/**/*.md` pages as (relpath, stem, content).
///
/// This is the one walk both `reindex_embeddings` and `index_updater`'s
/// reconcile pass use, so it is also the one place that decides what the
/// active index may ever hold: `is_cold` pages (archived/quarantined/cache)
/// are dropped here, which is what keeps them out of both the embed loop and
/// the `existing`/`present` set each caller later hands to `prune` — a
/// cold-tier record can never survive the next reindex.
pub(crate) fn collect_wiki_pages(root: &std::path::Path) -> Vec<(String, String, String)> {
    collect_pages(root, crate::settings::search_archived_sessions())
}

/// Authoritative index scans must never interpret a failed read as deletion.
pub(crate) fn collect_wiki_pages_checked(
    root: &std::path::Path,
) -> Result<Vec<(String, String, String)>, String> {
    collect_pages_checked(root, crate::settings::search_archived_sessions())
}

fn collect_pages_checked(
    root: &std::path::Path,
    search_archived_sessions: bool,
) -> Result<Vec<(String, String, String)>, String> {
    fn walk(
        root: &std::path::Path,
        directory: &std::path::Path,
        search_archived_sessions: bool,
        out: &mut Vec<(String, String, String)>,
    ) -> Result<(), String> {
        for (entry, kind) in vault::vault_entries_checked(directory).map_err(|e| e.to_string())? {
            let path = entry.path();
            let rel = path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            let policy_path = if kind.is_dir() {
                format!("{rel}/")
            } else {
                rel.clone()
            };
            if crate::vector_index::is_cold_for(&policy_path, search_archived_sessions) {
                continue;
            }
            if kind.is_dir() {
                walk(root, &path, search_archived_sessions, out)?;
            } else if path.extension().and_then(|extension| extension.to_str()) == Some("md") {
                let content = std::fs::read_to_string(&path)
                    .map_err(|e| format!("read indexed page {rel}: {e}"))?;
                let stem = path
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .unwrap_or("")
                    .to_string();
                out.push((rel, stem, content));
            }
        }
        Ok(())
    }
    vault::vault_entries_checked(root).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for tree in [
        "wiki",
        DEST_SESSIONS,
        "raw/conversations",
        "daily",
        "weekly",
        "monthly",
    ] {
        let directory = root.join(tree);
        vault::confine_delete_path(root, &directory.to_string_lossy())?;
        match std::fs::symlink_metadata(&directory) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("inspect indexed tree {tree}: {error}")),
            Ok(_) => walk(root, &directory, search_archived_sessions, &mut out)?,
        }
    }
    filter_index_pages(&mut out, search_archived_sessions);
    Ok(out)
}

/// `collect_wiki_pages` with the archived-sessions flag explicit (see
/// `Settings::search_archived_sessions`; pure, so the tests never touch the
/// process-wide setting).
fn collect_pages(
    root: &std::path::Path,
    search_archived_sessions: bool,
) -> Vec<(String, String, String)> {
    fn walk(
        dir: &std::path::Path,
        root: &std::path::Path,
        out: &mut Vec<(String, String, String)>,
    ) {
        // Non-following walk: a symlinked directory under wiki/ must not pull
        // files from outside the vault into the embedding index.
        for (e, kind) in vault::vault_entries(dir) {
            let p = e.path();
            if kind.is_dir() {
                walk(&p, root, out);
            } else if p.extension().and_then(|x| x.to_str()) == Some("md") {
                if let Ok(content) = std::fs::read_to_string(&p) {
                    let rel = p
                        .strip_prefix(root)
                        .unwrap_or(&p)
                        .to_string_lossy()
                        .replace('\\', "/");
                    let stem = p
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string();
                    out.push((rel, stem, content));
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(&root.join("wiki"), root, &mut out);
    // Session logs are indexed but never graphed: they answer "why did I do it
    // this way" through Ask, which quotes them verbatim at no model cost, while
    // the knowledge graph stays the wiki (see `index::collect_files`). Turning
    // each session into a wiki page instead would spend a paid ingest per work
    // log to produce pages titled after prompt boilerplate.
    walk(&root.join(DEST_SESSIONS), root, &mut out);
    // Imported conversations remain immutable originals, searchable in All only.
    walk(&root.join("raw/conversations"), root, &mut out);
    // Distillation's own output: digests land in `daily/*.md` and are the
    // only place the knowledge that was in a now-archived session still
    // lives (see `is_cold`'s `sessions/archive/` prefix below) — walking
    // `daily/` here is what makes that knowledge searchable again instead of
    // vanishing from the index the moment its source session is archived.
    // Deliberately NOT walked by the knowledge graph (`graphData.ts`'s
    // `isNonKnowledgePath`): that stays search-only, on purpose.
    walk(&root.join("daily"), root, &mut out);
    // The second compression layer (ROADMAP P1's `archive_rolled_days`): once
    // a week's daily digests go cold under `daily/archive/`, `weekly/<week>.md`
    // is the only live page holding that knowledge — so it has to be walked
    // here for exactly the reason `daily/` is. Search-only too (see
    // `graphData.ts`'s `isNonKnowledgePath`).
    walk(&root.join("weekly"), root, &mut out);
    // Third layer, same reason again: once a month's weekly rollups go cold
    // under `weekly/archive/`, `monthly/<YYYY-MM>.md` is the only live page
    // holding that knowledge.
    walk(&root.join("monthly"), root, &mut out);
    // Cold-tier pages never belong in the active index — see this fn's doc
    // comment. Live since `is_cold` grew a `sessions/archive/` prefix (Phase
    // B's `archive_digested_sessions`): the `sessions/` walk above is no
    // longer structurally disjoint from every `is_cold` prefix, so a digested
    // session actually gets dropped here. This is the single choke point
    // every (re)indexing caller routes through, so it is where the guard
    // lives rather than duplicated at each caller.
    filter_index_pages(&mut out, search_archived_sessions);
    out
}

fn filter_index_pages(out: &mut Vec<(String, String, String)>, search_archived_sessions: bool) {
    out.retain(|(rel, _, _)| !crate::vector_index::is_cold_for(rel, search_archived_sessions));
    // Opted-in archived sessions: a transcript re-swept before its original
    // was archived exists twice with the same body (the stamps in its
    // frontmatter differ). Index each body once, the live copy winning — a
    // non-archive page is never dropped here, only an archived duplicate of
    // one. Archived transcripts use the same full lexical coverage and
    // resumable dense batches as live pages.
    if search_archived_sessions {
        let is_archived = |rel: &str| rel.starts_with("sessions/archive/");
        let mut seen: std::collections::HashSet<u64> = out
            .iter()
            .filter(|(rel, _, _)| !is_archived(rel))
            .map(|(_, _, content)| body_hash(content))
            .collect();
        out.retain(|(rel, _, content)| !is_archived(rel) || seen.insert(body_hash(content)));
    }
}

/// Hash of a page's body with the frontmatter stripped, so two copies of one
/// session that differ only in their `created:`/`source:` stamps compare
/// equal. Same `gray_matter` parse the rest of the crate uses.
// ponytail: recomputed on every reindex walk; the import ledger is growing a
// body-hash index (importers/ledger.rs) — read that instead once it lands.
fn body_hash(content: &str) -> u64 {
    let body = gray_matter::Matter::<gray_matter::engine::YAML>::new()
        .parse::<gray_matter::Pod>(content)
        .map(|p| p.content)
        .unwrap_or_else(|_| content.to_string());
    embeddings::content_hash(body.trim())
}

/// Outcome of `embed_one_page`. Split into two flags because "was the page
/// re-embedded" and "does something need saving" are NOT the same question
/// once BM25 can be upserted on its own (see `embed_one_page`'s doc comment):
/// a page can be BM25-only-updated without touching the dense store at all,
/// which must still trigger a save/checkpoint but must not count as an
/// "embedded" page in progress/perf counters.
pub(crate) struct EmbedOutcome {
    /// True only when the dense store was actually (re-)embedded.
    pub embedded: bool,
    /// True when either index was mutated — this, not `embedded`, is what
    /// callers must gate a save on.
    pub changed: bool,
}

/// Release the native worker between small batches, so an Intel 8 GB machine
/// can answer a foreground query while a long transcript catches up.
const DENSE_BATCH_CHUNKS: usize = 16;

/// What `sync_bm25_for_page` decided for one page.
pub(crate) struct PageSync {
    /// All of the page's stable lexical chunks.
    pub chunks: Vec<String>,
    /// Content hash per chunk, index-aligned with `chunks`.
    pub hashes: Vec<u64>,
    /// True when the dense store already holds exactly these hashes — only
    /// BM25 needed catching up, so no embedding is required at all.
    pub dense_current: bool,
}

/// Sync core of `embed_one_page`: decides whether either index needs
/// updating and, if so, upserts `bm25` — the one part of this decision with
/// no dependency on a live app/loaded model, split out so it is directly
/// unit-testable (see the `commands::tests` module).
///
/// Returns `None` when both indexes already reflect this page's chunks,
/// including an empty page — the caller should report
/// `EmbedOutcome { embedded: false, changed: false }`). Returns a `PageSync`
/// otherwise, having already upserted `bm25` as needed.
///
/// BM25 receives the full stable chunk list the dense side will, so
/// `(page, section)` identity stays aligned between the two indexes — which
/// RRF fusion depends on.
fn sync_bm25_for_page(
    content: &str,
    rel: &str,
    stem: &str,
    existing: &std::collections::HashMap<String, Vec<u64>>,
    bm25: &mut crate::retrieval::Bm25Index,
    _bm25_pages: &std::collections::HashSet<String>,
) -> Option<PageSync> {
    let chunks = embeddings::chunk_page(content);
    let hashes: Vec<u64> = chunks.iter().map(|c| embeddings::content_hash(c)).collect();
    let dense_current = existing
        .get(rel)
        .map_or(chunks.is_empty(), |old| old == &hashes);
    let bm25_current = bm25
        .page_hashes(rel)
        .map_or(chunks.is_empty(), |old| old == hashes);
    if dense_current && bm25_current {
        return None;
    }
    bm25.upsert_page(rel, stem, &chunks);
    Some(PageSync {
        chunks,
        hashes,
        dense_current,
    })
}

/// Indices of `new_hashes` whose text the index does not already hold for this
/// page, i.e. exactly the chunks that must be embedded.
///
/// This is the fix for the ingest stall: the old code compared the page's hash
/// *list* and, on any difference, re-embedded every chunk of the page. For an
/// append-only session transcript that meant 831 embeds to index one new
/// paragraph. Matching per chunk instead makes an append cost one embed.
///
/// Hash-set membership, not positional comparison, so an insertion or a
/// reorder in the middle of a page also reuses everything it did not change.
pub(crate) fn chunks_needing_embed(old_hashes: &[u64], new_hashes: &[u64]) -> Vec<usize> {
    let have: std::collections::HashSet<u64> = old_hashes.iter().copied().collect();
    new_hashes
        .iter()
        .enumerate()
        .filter(|(_, h)| !have.contains(h))
        .map(|(i, _)| i)
        .collect()
}

/// Bring one page's chunks up to date in both `store` (dense) and `bm25`
/// (lexical), unless BOTH already reflect this page's current content.
/// Shared by `reindex_embeddings` and the incremental index updater — this is
/// the only place that decides "does this page need (re-)indexing".
///
/// The two indexes are gated independently: `store` is current when its
/// content hashes (`existing`) match the page's freshly computed hashes;
/// `bm25` is current when its stored chunk hashes match the same content.
/// A page can need only one side updated — most notably,
/// bootstrapping a fresh/dropped `.mxb` against an already-current `.mxv`
/// (first launch after this feature ships, or a `.mxb` a user deleted) skips
/// every page's dense re-embed via the content-hash match, but BM25 must
/// still receive every page or it never gets built at all. When the dense
/// side IS stale, both indexes are changed in memory until the shared publisher
/// commits a complete generation. Empty content removes the page from both indexes.
///
/// This bootstrap only completes when the CALLER visits every page — the
/// reconcile pass in `index_updater::process_batch`, or this whole loop in
/// `reindex_embeddings`. It is not a property of this function: handed a
/// single dirty page against an empty `bm25`, it upserts that one page and
/// nothing else, which is why `index_updater::reconcile_requested` promotes a
/// batch to a reconcile when the lexical index is unbootstrapped rather than
/// letting the incremental branch persist a one-page index.
///
/// Whenever BM25 is touched, it receives the exact same `Vec<String>` chunk
/// texts computed for embedding — upserted by reference before that `Vec` is
/// moved into `embed_texts` — so `(page, section)` identity always matches
/// between the two indexes, which RRF fusion depends on. BM25 is not
/// model-gated (unlike `store`, which can be wiped/rebuilt on an embed-model
/// change): it re-derives from raw text, so upserting it here regardless of
/// which embed model ran keeps it correct across a model migration too.
// Every parameter is a distinct borrow of caller-owned state (two indexes, the
// model handles, the page's own fields). Bundling them into a struct would only
// move the same list one level down.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn embed_one_page(
    app: &tauri::AppHandle,
    llm: &tauri::State<'_, LocalLlmState>,
    provider: &str,
    model: &str,
    rel: &str,
    stem: &str,
    content: &str,
    existing: &std::collections::HashMap<String, Vec<u64>>,
    store: &mut VectorStore,
    bm25: &mut crate::retrieval::Bm25Index,
    bm25_pages: &std::collections::HashSet<String>,
    origin: &AgentVaultSession,
) -> Result<EmbedOutcome, String> {
    let Some(sync) = sync_bm25_for_page(content, rel, stem, existing, bm25, bm25_pages) else {
        return Ok(EmbedOutcome {
            embedded: false,
            changed: false,
        });
    };
    if sync.dense_current {
        return Ok(EmbedOutcome {
            embedded: false,
            changed: true,
        });
    }
    let mut by_hash = store.page_vectors(rel);
    let old_hashes: Vec<u64> = by_hash.keys().copied().collect();
    let todo = chunks_needing_embed(&old_hashes, &sync.hashes);
    let PageSync { chunks, hashes, .. } = sync;
    let rebuild = |store: &mut VectorStore, by_hash: &std::collections::HashMap<u64, Vec<f32>>| {
        let entries = hashes
            .iter()
            .enumerate()
            .filter_map(|(i, h)| by_hash.get(h).map(|v| (i, *h, v.clone())))
            .collect();
        store.upsert_page_sections(rel, stem, entries)
    };
    // Remove moved/deleted sections in the staged generation.
    rebuild(store, &by_hash)?;
    for batch in todo.chunks(DENSE_BATCH_CHUNKS) {
        app.state::<VaultRoot>().with_origin(origin, |_| Ok(()))?;
        let texts = batch.iter().map(|&i| chunks[i].clone()).collect();
        let embedded = embed_texts_checked(
            app.clone(),
            (*llm).clone(),
            provider,
            model,
            crate::local_llm::EmbedRole::Document,
            texts,
        )
        .await?;
        if embedded.space.model != store.model || embedded.space.signature != store.signature {
            return Err("index embedding batch representation changed".into());
        }
        if store.dim != 0 {
            embedded.validate(&store.embedding_space()?, batch.len())?;
        } else {
            embedded
                .space
                .validate_batch(&embedded.vectors, batch.len())?;
        }
        for (&i, v) in batch.iter().zip(embedded.vectors) {
            by_hash.insert(hashes[i], v);
        }
        rebuild(store, &by_hash)?;
        tokio::task::yield_now().await;
    }
    Ok(EmbedOutcome {
        embedded: !todo.is_empty(),
        changed: true,
    })
}

/// Per-page progress for a running reindex. `done` counts pages *considered*
/// (embedded or skipped) out of `total`, so the bar tracks the walk rather than
/// stalling through a run of unchanged pages.
#[derive(Clone, serde::Serialize)]
pub struct ReindexProgress {
    pub done: usize,
    pub total: usize,
    pub page: String,
    /// False when the page was skipped by the content-hash check — the UI can
    /// say "checking" rather than implying it re-embedded everything.
    pub embedded: bool,
}

/// (Re)build the embedding index for the open vault. Skips pages whose chunk set
/// is unchanged (content hashes match). Returns the number of indexed pages.
///
/// Emits `reindex-progress` per page. This is the slowest thing the app does —
/// embedding one chunk measures ~21 ms with the bundled e5-small-ko
/// (`examples/bench_embed`, 2026-09), so the owner's 4,451-chunk vault is about
/// a minute and a half — and it used to run behind nothing but a disabled
/// button.
#[tauri::command]
pub async fn reindex_embeddings(
    app: tauri::AppHandle,
    vault: tauri::State<'_, VaultRoot>,
    llm: tauri::State<'_, LocalLlmState>,
    cache: tauri::State<'_, VectorCache>,
    bm25_cache: tauri::State<'_, crate::retrieval::Bm25Cache>,
    provider: String,
    model: String,
) -> Result<usize, String> {
    let origin = vault.snapshot()?;
    // Both entry points use the same publisher, captured opening and pair commit.
    // The supplied states remain part of the public command signature.
    let _ = (llm, cache, bm25_cache);
    crate::index_updater::reindex(&app, &origin, &provider, &model).await
}

/// A retrieval hit carrying the matching chunk's TEXT, so callers inline the
/// passage instead of re-reading the whole page. `text` is reconstructed at
/// query time from the page (the index stores only vectors+hashes).
#[derive(Clone, Debug, serde::Serialize)]
pub struct ScoredChunk {
    pub page: String,
    pub stem: String,
    pub section: usize,
    pub text: String,
    /// The ordering score — same value as `score_final`, kept under the name
    /// callers already read. RANK-based (`rrf_fuse` x tier prior), so it is
    /// scale-free: the top hit of a perfect match and the top hit of a
    /// nonsense query score the same. Good for ordering, USELESS as a
    /// confidence measure — use `similarity`.
    pub score: f32,
    /// `rrf_fuse` score before the tier prior: `Σ 1/(RRF_K + rank)` over the
    /// dense and lexical rankings.
    pub score_rrf: f32,
    /// `score_rrf` x `prior` — what the list is ordered by.
    pub score_final: f32,
    /// Vault layer the page belongs to (`retrieval::source_tier`), the same
    /// string `sourceTier()` produces in extractive.ts.
    pub tier: crate::retrieval::Tier,
    /// The tier prior that multiplied `score_rrf` (1.0 = none).
    pub prior: f32,
    /// Position without the prior minus position with it, both in the
    /// page-capped ranking: positive = the prior moved this hit up.
    pub rank_change: i32,
    /// True dense cosine similarity between the query and this chunk, carried
    /// through fusion so callers can judge whether a hit is relevant AT ALL.
    /// `None` when the chunk was surfaced only by the lexical arm (no dense
    /// score exists for it).
    ///
    /// Measured on the bilingual eval corpus (71 pages / 142 chunks, bge-m3):
    /// queries whose answer IS in the corpus scored ≥ 0.543 at top-1 (n=45,
    /// median 0.650); off-corpus queries topped out at 0.491 (n=15, median
    /// 0.408). That gap is what `RELEVANCE_FLOOR` on the TS side sits in.
    pub similarity: Option<f32>,
    /// Verified exact phrase/identifier or substantive lexical agreement.
    pub exact_match: bool,
}

/// A hit the relevance floor rejected — shown by Ask's abstention state so
/// "nothing answers this" comes with what came closest.
#[derive(Clone, Debug, serde::Serialize)]
pub struct NearMiss {
    pub page: String,
    pub stem: String,
    pub tier: crate::retrieval::Tier,
    /// The cosine that fell short of `AskSearch::floor`.
    pub similarity: Option<f32>,
    pub score_final: f32,
}

/// What `semantic_search` returns: the hits that clear the relevance floor,
/// in final order, plus the floor itself and up to four near-misses below it.
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct AskSearch {
    pub hits: Vec<ScoredChunk>,
    /// `retrieval::RELEVANCE_FLOOR` — the cosine each hit had to clear.
    pub floor: f32,
    /// Rejected hits, best cosine first (lexical-only hits are never here:
    /// with no cosine they pass the floor, as `chat.ts::isRelevant` does).
    pub below_floor: Vec<NearMiss>,
}

/// How many near-misses the abstention state shows.
const NEAR_MISSES: usize = 4;

/// Split ranked hits at the relevance floor into the Ask response. Pure, so
/// the shape is unit-testable without a Tauri runtime.
pub(crate) fn ask_response(hits: Vec<HybridHit>) -> AskSearch {
    let floor = crate::retrieval::RELEVANCE_FLOOR;
    let mut out = AskSearch {
        floor,
        ..AskSearch::default()
    };
    for h in hits {
        match h.similarity {
            Some(sim) if sim < floor && !h.exact_match => out.below_floor.push(NearMiss {
                page: h.page,
                stem: h.stem,
                tier: h.tier,
                similarity: h.similarity,
                score_final: h.score,
            }),
            None if !h.exact_match => out.below_floor.push(NearMiss {
                page: h.page,
                stem: h.stem,
                tier: h.tier,
                similarity: None,
                score_final: h.score,
            }),
            _ => out.hits.push(ScoredChunk {
                page: h.page,
                stem: h.stem,
                section: h.section,
                text: h.text,
                score: h.score,
                score_rrf: h.score_rrf,
                score_final: h.score,
                tier: h.tier,
                prior: h.prior,
                rank_change: h.rank_change,
                similarity: h.similarity,
                exact_match: h.exact_match,
            }),
        }
    }
    out.below_floor.sort_by(|a, b| {
        b.similarity
            .unwrap_or(0.0)
            .total_cmp(&a.similarity.unwrap_or(0.0))
    });
    out.below_floor.truncate(NEAR_MISSES);
    out
}

/// The `section`-th chunk of `content` under the same `chunk_page` split the
/// index was built with. `None` if `section` is out of range (e.g. the page was
/// edited after indexing) — the caller drops such a hit.
fn chunk_text_at(content: &str, section: usize) -> Option<String> {
    crate::embeddings::chunk_page(content)
        .into_iter()
        .nth(section)
}

/// Inclusive `YYYY-MM-DD` day range a time-anchored Ask question resolved to
/// (the frontend's `timeQuery.ts` builds it; serde leaves a missing IPC arg
/// `None`, so existing callers are unaffected).
#[derive(Clone, Debug, serde::Deserialize)]
pub struct DateRange {
    pub start: String,
    pub end: String,
    /// Viewer-local civil days converted by the caller to UTC-second bounds.
    #[serde(default, rename = "startEpoch")]
    pub start_epoch: Option<i64>,
    #[serde(default, rename = "endEpoch")]
    pub end_epoch: Option<i64>,
}

/// Monday of ISO week `YYYY-Www` as `(year, month, day)`. `None` for anything
/// that isn't a real week name — wrong shape, or a week number the year does
/// not have (W00, W60, W53 in a 52-week year).
pub(crate) fn iso_week_monday(bucket: &str) -> Option<(i32, u32, u32)> {
    if !crate::distill::is_iso_week_name(bucket) {
        return None;
    }
    let y: i64 = bucket[0..4].parse().ok()?;
    let w: i64 = bucket[6..8].parse().ok()?;
    // Jan 4 is in W01 by ISO definition, which anchors week 1's Monday.
    // 1970-01-01 was a Thursday, so `+3` puts Monday at 0 — the same shift
    // `distill::iso_week` uses.
    let jan4 = crate::distill::days_from_civil(y, 1, 4);
    let monday = jan4 - (jan4 + 3).rem_euclid(7) + (w - 1) * 7;
    let (my, mm, md, ..) = crate::distill::civil_datetime(monday * 86_400);
    // Round-trip through `iso_week` (the fn that names weekly/ files): a week
    // the year doesn't have lands on a Monday belonging to a differently-named
    // week, rather than reimplementing the 52/53 rule here.
    if crate::distill::iso_week(&format!("{my:04}-{mm:02}-{md:02}")).as_deref() != Some(bucket) {
        return None;
    }
    Some((my as i32, mm, md))
}

/// True when a dated-tier page overlaps the inclusive `[start, end]` day range:
///   `daily/YYYY-MM-DD.md`  — exact day in range
///   `sessions/YYYY-MM/…`   — month overlaps (string compare on `YYYY-MM`)
///   `weekly/YYYY-Www.md`   — the ISO week's Monday..Sunday overlaps
///   `monthly/YYYY-MM.md`   — month overlaps
/// Undated pages (wiki/, raw/, archives, everything else) are `false` — a
/// time-anchored question wants the record of that window, not timeless notes.
pub(crate) fn page_in_date_range(rel: &str, range: &DateRange) -> bool {
    let (start, end) = (range.start.as_str(), range.end.as_str());
    let month_overlaps = |month: &str| {
        // The range arrives over IPC: a start/end too short to hold `YYYY-MM`
        // matches nothing instead of panicking on the slice.
        crate::distill::is_month_name(month)
            && start.get(0..7).is_some_and(|s| s <= month)
            && end.get(0..7).is_some_and(|e| month <= e)
    };
    if let Some(day) = rel
        .strip_prefix("daily/")
        .and_then(|r| r.strip_suffix(".md"))
    {
        // `iso_week` validates the civil date, so an impossible `2026-02-31`
        // (or a short `2026-08-2`, which plain string compare would let
        // through) is out; for real dates lexicographic order IS date order.
        return crate::distill::iso_week(day).is_some() && start <= day && day <= end;
    }
    if let Some(rest) = rel.strip_prefix("sessions/") {
        return rest
            .split_once('/')
            .is_some_and(|(month, _)| month_overlaps(month));
    }
    if let Some(week) = rel
        .strip_prefix("weekly/")
        .and_then(|r| r.strip_suffix(".md"))
    {
        let Some((y, m, d)) = iso_week_monday(week) else {
            return false;
        };
        let sunday_days = crate::distill::days_from_civil(i64::from(y), m, d) + 6;
        let (sy, sm, sd, ..) = crate::distill::civil_datetime(sunday_days * 86_400);
        let monday = format!("{y:04}-{m:02}-{d:02}");
        let sunday = format!("{sy:04}-{sm:02}-{sd:02}");
        return monday.as_str() <= end && start <= sunday.as_str();
    }
    if let Some(month) = rel
        .strip_prefix("monthly/")
        .and_then(|r| r.strip_suffix(".md"))
    {
        return month_overlaps(month);
    }
    false
}

/// Locate repeated headers/quotes in chunk order, rather than returning the
/// first matching line in the whole page for every section.
fn chunk_line_at(content: &str, chunks: &[String], section: usize) -> usize {
    let content = crate::norm::nfc(content);
    let mut cursor = 0;
    for (i, text) in chunks.iter().enumerate().take(section + 1) {
        let found = content[cursor..]
            .find(text)
            .map(|at| cursor + at)
            .or_else(|| {
                let first = text.lines().find(|line| !line.trim().is_empty())?;
                content[cursor..].find(first).map(|at| cursor + at)
            });
        let Some(start) = found else {
            return chunk_line(&content, text);
        };
        if i == section {
            return content[..start].bytes().filter(|b| *b == b'\n').count() + 1;
        }
        cursor = (start + text.len()).min(content.len());
        while cursor < content.len() && !content.is_char_boundary(cursor) {
            cursor += 1;
        }
    }
    1
}

fn timestamp_in_date_range(timestamp: i64, range: &DateRange) -> bool {
    match (range.start_epoch, range.end_epoch) {
        (Some(start), Some(end)) => start < end && start <= timestamp && timestamp < end,
        (None, None) => {
            // Older clients only supplied inclusive UTC calendar dates.
            let (y, m, d, ..) = crate::distill::civil_datetime(timestamp);
            let day = format!("{y:04}-{m:02}-{d:02}");
            range.start <= day && day <= range.end
        }
        _ => false,
    }
}

pub(crate) fn chunk_in_date_range(
    page: &str,
    content: &str,
    chunks: &[String],
    section: usize,
    range: &DateRange,
) -> bool {
    #[derive(serde::Deserialize, Default)]
    struct TurnDate {
        timestamp: Option<String>,
    }
    let metadata = gray_matter::Matter::<gray_matter::engine::YAML>::new()
        .parse::<serde_json::Value>(content)
        .ok()
        .and_then(|p| p.data);
    if let Some(value) = metadata.as_ref().and_then(|m| m.get("turn_metadata")) {
        // Explicit but empty or malformed metadata cannot establish an event date.
        let Ok(dates) = serde_json::from_value::<Vec<TurnDate>>(value.clone()) else {
            return false;
        };
        // A literal role header inside a message makes ordinal attribution
        // ambiguous. Reject the page instead of borrowing another turn's date.
        if content
            .lines()
            .filter(|line| embeddings::is_transcript_turn_header(line))
            .count()
            != dates.len()
        {
            return false;
        }
        let start = chunk_line_at(content, chunks, section);
        let end = chunks
            .get(section + 1)
            .map_or(usize::MAX, |_| chunk_line_at(content, chunks, section + 1));
        let mut ordinal = 0usize;
        let mut active = None;
        let mut touched = Vec::new();
        for (line, text) in content.lines().enumerate() {
            if line + 1 >= end {
                break;
            }
            if embeddings::is_transcript_turn_header(text) {
                active = dates
                    .get(ordinal)
                    .and_then(|t| t.timestamp.as_deref())
                    .and_then(crate::importers::parse_iso8601);
                ordinal += 1;
            }
            if line + 1 >= start {
                if let Some(ts) = active {
                    touched.push(ts);
                }
            }
        }
        if !touched.is_empty() {
            return touched
                .into_iter()
                .any(|ts| timestamp_in_date_range(ts, range));
        }
        // Metadata without an attributable timestamp is not exact dated evidence.
        return false;
    }
    page_in_date_range(page, range)
}

/// The sortable date string a dated-tier page derives its recency from:
/// daily → the day, weekly → its ISO Monday, sessions/monthly → the month
/// (`YYYY-MM` sorts before any full date inside that month — a month-level
/// record reads as "at least as old as" its first day). `None`: undated.
pub(crate) fn page_date(rel: &str) -> Option<String> {
    if let Some(day) = rel
        .strip_prefix("daily/")
        .and_then(|r| r.strip_suffix(".md"))
    {
        return crate::distill::iso_week(day)
            .is_some()
            .then(|| day.to_string());
    }
    if let Some(rest) = rel.strip_prefix("sessions/") {
        return rest
            .split_once('/')
            .map(|(month, _)| month)
            .filter(|m| crate::distill::is_month_name(m))
            .map(str::to_string);
    }
    if let Some(week) = rel
        .strip_prefix("weekly/")
        .and_then(|r| r.strip_suffix(".md"))
    {
        return iso_week_monday(week).map(|(y, m, d)| format!("{y:04}-{m:02}-{d:02}"));
    }
    if let Some(month) = rel
        .strip_prefix("monthly/")
        .and_then(|r| r.strip_suffix(".md"))
    {
        return crate::distill::is_month_name(month).then(|| month.to_string());
    }
    None
}

/// Recency tie-break for a range-filtered ranking: within each run of hits
/// whose fused scores tie (neighbors within f32 epsilon), the more recent page
/// wins and undated pages go to the back of the run. Runs never cross a real
/// score gap, so ranking above/below a tie is untouched; the sort is stable,
/// so equal dates keep fused order.
pub(crate) fn recency_tie_break(hits: &mut [crate::vector_index::Hit]) {
    let mut i = 0;
    while i < hits.len() {
        let mut j = i + 1;
        while j < hits.len() && (hits[j - 1].score - hits[j].score).abs() <= f32::EPSILON {
            j += 1;
        }
        if j - i > 1 {
            hits[i..j].sort_by(|a, b| match (page_date(&a.page), page_date(&b.page)) {
                (Some(da), Some(db)) => db.cmp(&da),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            });
        }
        i = j;
    }
}

/// One hybrid-retrieval hit, keeping each arm's raw score beside the fused
/// rank score. Shared by the Ask page (`semantic_search` projects it to
/// `ScoredChunk`) and the MCP `search` tool.
pub(crate) struct HybridHit {
    pub page: String,
    pub stem: String,
    pub section: usize,
    /// 1-based line in the page where the chunk starts.
    pub line: usize,
    pub text: String,
    /// The ordering score: `score_rrf` x `prior`. Rank-based, says nothing
    /// about relevance.
    pub score: f32,
    /// `rrf_fuse` score before the tier prior.
    pub score_rrf: f32,
    /// Vault layer the page belongs to (`retrieval::source_tier`).
    pub tier: crate::retrieval::Tier,
    /// The tier prior applied (1.0 = none).
    pub prior: f32,
    /// Position in the page-capped ranking WITHOUT the prior minus position
    /// WITH it: positive = the prior moved the hit up, 0 = unmoved.
    pub rank_change: i32,
    /// Dense cosine; `None` when only the lexical arm surfaced the chunk.
    pub similarity: Option<f32>,
    pub exact_match: bool,
    /// BM25 score; `None` when only the dense arm surfaced the chunk.
    pub bm25: Option<f32>,
}

pub(crate) struct HybridSearch {
    pub hits: Vec<HybridHit>,
    /// Why the dense arm did not run — no index for this vault, or one built
    /// with a retired model — in which case `hits` are lexical-only.
    pub dense_skipped: Option<&'static str>,
}

/// Resolve identity only when a nonempty index uses the selected model. The
/// lexical path does not require embedding weights or a running local daemon.
async fn dense_index_skip_reason(
    store: &VectorStore,
    selected_model: Result<String, String>,
    signature: impl std::future::Future<Output = Result<String, String>>,
) -> Result<Option<&'static str>, String> {
    if store.records.is_empty() {
        return Ok(Some(
            "no embedding index for this vault yet — BM25 (lexical) hits only",
        ));
    }
    if store.model != selected_model? || store.signature != signature.await? {
        return Ok(Some("embedding index was built with a retired model — BM25 (lexical) hits only until it is rebuilt"));
    }
    Ok(None)
}

/// The app's one retrieval path: dense (embedding) and lexical (BM25) arms
/// fused by RRF, tier-weighted, capped per page, reconstructed to chunk text.
/// `scope` drops pages from both arms BEFORE the candidate-pool cut, so a
/// narrow scope on a session-heavy vault is not starved by it; `paths`, when
/// given, narrows the same way to exactly those vault-relative pages. A missing or
/// retired-model index degrades to the lexical arm alone (`dense_skipped`)
/// rather than to nothing; callers decide what that means for them.
// Distinct borrows of caller-owned state plus the query's parts; a struct
// would only move the same list one level down (as with `embed_one_page`).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn hybrid_search(
    app: &tauri::AppHandle,
    llm: &tauri::State<'_, LocalLlmState>,
    cache: &VectorCache,
    bm25_cache: &crate::retrieval::Bm25Cache,
    root: &std::path::Path,
    query: &str,
    k: usize,
    provider: &str,
    model: &str,
    range: Option<&DateRange>,
    scope: crate::retrieval::Scope,
    paths: Option<&[String]>,
    tier_weights: &crate::retrieval::TierWeights,
) -> Result<HybridSearch, String> {
    let t0 = std::time::Instant::now();
    let pair = crate::index_publication::snapshot(root.to_path_buf()).await?;
    let store = pair.store.clone();
    let load_ms = perf::ms(t0.elapsed());
    let _ = (cache, bm25_cache);
    // Stale-index guard: after an embedding-model change (e.g. the bundled
    // model swap) the stored vectors live in a different space than the query
    // embedding — skip the dense arm instead of cosining across incompatible
    // spaces.
    let dense_skipped = dense_index_skip_reason(
        &store,
        embedding_model_id(provider, model),
        embedding_index_signature(app, provider, model),
    )
    .await?;
    let t_embed = std::time::Instant::now();
    let query_vec = match dense_skipped {
        Some(_) => None,
        None => {
            // The embed arm runs on the quote-stripped query (the phrase words
            // stay in it, so unquoted ranking behavior is unchanged).
            let (_, clean_query) = crate::retrieval::parse_phrases(query);
            let mut q = embed_texts_checked(
                app.clone(),
                (*llm).clone(),
                provider,
                model,
                crate::local_llm::EmbedRole::Query,
                vec![clean_query],
            )
            .await?;
            q.validate(&store.embedding_space()?, 1)?;
            Some(q.vectors.pop().ok_or("query embedding is missing")?)
        }
    };
    let embed_ms = perf::ms(t_embed.elapsed());
    let bm25 = pair.lexical.clone();

    let t_rank = std::time::Instant::now();
    let records = store.records.len();
    let root = root.to_path_buf();
    let query = query.to_string();
    let range = range.cloned();
    let paths = paths.map(<[String]>::to_vec);
    let tier_weights = *tier_weights;
    let hits = tauri::async_runtime::spawn_blocking(move || {
        rank_hybrid(
            &root,
            &store,
            query_vec.as_deref(),
            &bm25,
            &query,
            k,
            range.as_ref(),
            scope,
            paths.as_deref(),
            &tier_weights,
        )
    })
    .await
    .map_err(|e| format!("hybrid ranking task failed: {e}"))??;
    perf::log(
        "semantic_search",
        &[
            ("index_generation", pair.generation as f64),
            ("load_store_ms", load_ms),
            ("embed_query_ms", embed_ms),
            ("rank_ms", perf::ms(t_rank.elapsed())),
            ("total_ms", perf::ms(t0.elapsed())),
            ("records", records as f64),
            ("returned", hits.len() as f64),
        ],
    );
    Ok(HybridSearch {
        hits,
        dense_skipped,
    })
}

/// Rank one query against loaded indexes: fuse the dense and lexical arms
/// (RRF), apply the optional date window, weight by tier prior, cap chunks
/// per page, and reconstruct each surviving chunk's text from its page under
/// `root`. `query_vec` is `None` when the dense arm is unavailable.
/// Exact source-backed duplicates only; edited projection chunks remain
/// searchable. A stale or partially rebuilt lexical source never hides them.
fn source_duplicate_chunks(
    root: &std::path::Path,
    bm25: &crate::retrieval::Bm25Index,
    projection_content: &str,
    range: Option<&DateRange>,
) -> std::collections::HashSet<u64> {
    #[derive(serde::Deserialize)]
    struct SourceIdentity {
        raw_path: String,
        source_revision: String,
    }
    let read = |page: &str| {
        let path = vault::confine_path(root, &root.join(page).to_string_lossy()).ok()?;
        std::fs::read_to_string(path).ok()
    };
    let identity = gray_matter::Matter::<gray_matter::engine::YAML>::new()
        .parse::<SourceIdentity>(projection_content)
        .ok()
        .and_then(|p| p.data);
    let Some(identity) = identity else {
        return Default::default();
    };
    if !identity.raw_path.starts_with("raw/conversations/")
        || crate::vector_index::is_cold(&identity.raw_path)
    {
        return Default::default();
    }
    let Some(source) = read(&identity.raw_path) else {
        return Default::default();
    };
    if crate::importers::wikify::source_revision(&source) != identity.source_revision {
        return Default::default();
    }
    let chunks = embeddings::chunk_page(&source);
    let hashes: Vec<u64> = chunks.iter().map(|c| embeddings::content_hash(c)).collect();
    if bm25.page_hashes(&identity.raw_path).as_ref() != Some(&hashes) {
        return Default::default();
    }
    hashes
        .into_iter()
        .enumerate()
        .filter(|(section, _)| {
            range.map_or(true, |r| {
                chunk_in_date_range(&identity.raw_path, &source, &chunks, *section, r)
            })
        })
        .map(|(_, hash)| hash)
        .collect()
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn rank_hybrid(
    root: &std::path::Path,
    store: &VectorStore,
    query_vec: Option<&[f32]>,
    bm25: &crate::retrieval::Bm25Index,
    query: &str,
    k: usize,
    range: Option<&DateRange>,
    scope: crate::retrieval::Scope,
    paths: Option<&[String]>,
    tier_weights: &crate::retrieval::TierWeights,
) -> Result<Vec<HybridHit>, String> {
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let root = canonical_root.as_path();
    let (phrases, clean_query) = crate::retrieval::parse_phrases(query);
    let k = k.clamp(1, 50);
    let pool = (k * 5).clamp(20, 250);
    const PAGE_CAP: usize = 2;
    let wanted: Option<std::collections::HashSet<String>> = paths.map(|ps| {
        ps.iter()
            .map(|p| crate::norm::nfc(p).into_owned())
            .collect()
    });
    let keeps = |page: &str| {
        !crate::vector_index::is_cold(page)
            && scope.keeps(page)
            && wanted
                .as_ref()
                .map_or(true, |set| set.contains(crate::norm::nfc(page).as_ref()))
    };
    let collapse_sources = scope == crate::retrieval::Scope::All && paths.is_none();
    let mut duplicate_chunks =
        std::collections::HashMap::<String, std::collections::HashSet<u64>>::new();
    let mut snapshots: std::collections::HashMap<String, Option<(String, Vec<String>)>> =
        std::collections::HashMap::new();
    let records: std::collections::HashMap<(&str, usize), &crate::vector_index::Record> = store
        .records
        .iter()
        .map(|record| ((record.page.as_str(), record.section), record))
        .collect();
    let mut current = |page: &str, section: usize, hash: Option<u64>| {
        if !keeps(page) {
            return false;
        }
        let snapshot = snapshots.entry(page.to_string()).or_insert_with(|| {
            let path = vault::confine_path(root, &root.join(page).to_string_lossy()).ok()?;
            let content = std::fs::read_to_string(path).ok()?;
            let chunks = embeddings::chunk_page(&content);
            Some((content, chunks))
        });
        let Some((content, chunks)) = snapshot else {
            return false;
        };
        let Some(text) = chunks.get(section) else {
            return false;
        };
        hash.is_some_and(|hash| {
            hash == embeddings::content_hash(text)
                && !(collapse_sources
                    && page.starts_with("sessions/")
                    && duplicate_chunks
                        .entry(page.to_string())
                        .or_insert_with(|| source_duplicate_chunks(root, bm25, content, range))
                        .contains(&hash))
        }) && !text.trim().is_empty()
            && crate::retrieval::text_matches_phrases(text, &phrases)
            && range.map_or(true, |r| {
                chunk_in_date_range(page, content, chunks, section, r)
            })
    };
    // Validate before pool cuts. A missing/edited/phrase-filtered top result
    // cannot consume a slot that a current lower-ranked candidate can fill.
    let mut dense_pages = std::collections::HashMap::<String, usize>::new();
    let dense_hits: Vec<VecHit> = match query_vec {
        Some(qv) => store
            .search(qv, store.records.len())?
            .into_iter()
            .filter(|h| {
                if dense_pages.get(&h.page).is_some_and(|n| *n >= PAGE_CAP) {
                    return false;
                }
                if !current(
                    &h.page,
                    h.section,
                    records.get(&(h.page.as_str(), h.section)).map(|r| r.hash),
                ) {
                    return false;
                }
                let n = dense_pages.entry(h.page.clone()).or_default();
                *n += 1;
                *n <= PAGE_CAP
            })
            .take(pool)
            .collect(),
        None => Vec::new(),
    };
    let mut lexical_pages = std::collections::HashMap::<String, usize>::new();
    let lexical_hits: Vec<crate::retrieval::Bm25Hit> = bm25
        .search(&clean_query, bm25.len())
        .into_iter()
        .filter(|h| {
            if lexical_pages.get(&h.page).is_some_and(|n| *n >= PAGE_CAP) {
                return false;
            }
            if !current(&h.page, h.section, bm25.chunk_hash(&h.page, h.section)) {
                return false;
            }
            let n = lexical_pages.entry(h.page.clone()).or_default();
            *n += 1;
            *n <= PAGE_CAP
        })
        .take(pool)
        .collect();
    let bm25_by_id: std::collections::HashMap<(String, usize), f32> = lexical_hits
        .iter()
        .map(|h| ((h.page.clone(), h.section), h.score))
        .collect();
    let mut fused = crate::retrieval::rrf_fuse(&dense_hits, &lexical_hits, pool * 2);
    if range.is_some() {
        recency_tie_break(&mut fused);
    }
    let baseline: std::collections::HashMap<(String, usize), usize> =
        crate::retrieval::cap_per_page(fused.clone(), PAGE_CAP, fused.len())
            .into_iter()
            .enumerate()
            .map(|(i, h)| ((h.page, h.section), i))
            .collect();
    let rrf_by_id: std::collections::HashMap<(String, usize), f32> = fused
        .iter()
        .map(|h| ((h.page.clone(), h.section), h.score))
        .collect();
    crate::retrieval::apply_tier_prior(&mut fused, tier_weights);
    let hits = crate::retrieval::cap_per_page(fused, PAGE_CAP, k);
    let mut out = Vec::with_capacity(hits.len());
    for (pos, h) in hits.into_iter().enumerate() {
        let Some(Some((content, chunks))) = snapshots.get(&h.page) else {
            continue;
        };
        let Some(text) = chunks.get(h.section) else {
            continue;
        };
        let id = (h.page.clone(), h.section);
        // A lexical-union candidate can have a dense vector even when it was
        // outside the dense arm's pool. Preserve its real cosine, never None.
        let similarity = query_vec
            .and_then(|q| {
                records
                    .get(&(h.page.as_str(), h.section))
                    .filter(|r| r.hash == embeddings::content_hash(text))
                    .map(|r| embeddings::checked_cosine(q, &r.vector))
            })
            .transpose()?;
        let tier = crate::retrieval::source_tier(&h.page);
        out.push(HybridHit {
            line: chunk_line_at(content, chunks, h.section),
            exact_match: crate::retrieval::exact_lexical_match(query, text),
            similarity,
            bm25: bm25_by_id.get(&id).copied(),
            score_rrf: rrf_by_id.get(&id).copied().unwrap_or(h.score),
            prior: tier_weights.prior(tier),
            rank_change: baseline
                .get(&id)
                .map_or(0, |before| *before as i32 - pos as i32),
            tier,
            page: h.page,
            stem: h.stem,
            section: h.section,
            text: text.clone(),
            score: h.score,
        });
    }
    Ok(out)
}

/// 1-based line where `chunk` begins in `content`: its first non-blank line,
/// located in the NFC form of the page (`chunk_page` normalizes before it
/// splits, so the chunk's lines are NFC). 1 when it cannot be found.
// ponytail: first occurrence wins, so a heading repeated verbatim resolves to
// its earliest copy; a byte-offset walk through chunk_page would be exact.
fn chunk_line(content: &str, chunk: &str) -> usize {
    let Some(first) = chunk.lines().map(str::trim).find(|l| !l.is_empty()) else {
        return 1;
    };
    crate::norm::nfc(content)
        .lines()
        .position(|l| l.trim() == first)
        .map_or(1, |i| i + 1)
}

/// Semantic search: the hybrid retrieval above, split at the relevance floor
/// into `AskSearch` — each hit with its chunk TEXT reconstructed so callers
/// (e.g. Ask) can inline the passage instead of re-reading the whole page,
/// plus the near-misses the floor rejected so an abstention can show them.
// Four of the arguments are Tauri-injected state rather than things a caller
// passes; the invocable surface is (query, k, provider, model, range, scope,
// paths, tier_weights).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn semantic_search(
    app: tauri::AppHandle,
    vault: tauri::State<'_, VaultRoot>,
    llm: tauri::State<'_, LocalLlmState>,
    cache: tauri::State<'_, VectorCache>,
    bm25_cache: tauri::State<'_, crate::retrieval::Bm25Cache>,
    query: String,
    k: usize,
    provider: String,
    model: String,
    range: Option<DateRange>,
    // `wiki` (default) | `sessions` | `all` | `pages` — see `retrieval::Scope`.
    scope: Option<crate::retrieval::Scope>,
    // Vault-relative pages to rank against (with `scope`); omitted = no
    // path filter. "Ask this note" passes the note and its link neighbours.
    paths: Option<Vec<String>>,
    // Per-tier prior; omitted = `TierWeights::default()`, all 1.0 = off.
    tier_weights: Option<crate::retrieval::TierWeights>,
) -> Result<AskSearch, String> {
    let root = require_root(&vault)?;
    let scope = scope.unwrap_or_default();
    let weights = tier_weights.unwrap_or_else(|| {
        if matches!(
            scope,
            crate::retrieval::Scope::All | crate::retrieval::Scope::Sessions
        ) {
            crate::retrieval::TierWeights::FLAT
        } else {
            crate::retrieval::TierWeights::default()
        }
    });
    let found = hybrid_search(
        &app,
        &llm,
        &cache,
        &bm25_cache,
        &root,
        &query,
        k,
        &provider,
        &model,
        range.as_ref(),
        scope,
        paths.as_deref(),
        &weights,
    )
    .await?;
    // Verified lexical evidence remains available while dense vectors rebuild.
    Ok(ask_response(found.hits))
}

/// Read bounded original transcript events for topic-free, dated recall.
#[tauri::command]
pub async fn temporal_recall(
    vault: tauri::State<'_, VaultRoot>,
    bm25_cache: tauri::State<'_, crate::retrieval::Bm25Cache>,
    range: DateRange,
    scope: Option<crate::retrieval::Scope>,
    paths: Option<Vec<String>>,
) -> Result<crate::temporal_recall::TemporalRecallResult, String> {
    let root = require_root(&vault)?;
    let index = bm25_cache
        .get_async(crate::retrieval::Bm25Index::path_for(
            &root.to_string_lossy(),
        )?)
        .await?;
    let include_archived = crate::settings::search_archived_sessions();
    tauri::async_runtime::spawn_blocking(move || {
        crate::temporal_recall::recall(
            &root,
            &index,
            &range,
            scope.unwrap_or_default(),
            paths.as_deref(),
            include_archived,
        )
    })
    .await
    .map_err(|error| format!("temporal recall task failed: {error}"))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivityRecallRequest {
    pub expected_vault: String,
    pub origin: AgentVaultSession,
    #[serde(default)]
    pub role_snapshot: Option<crate::role_authorization::RoleSnapshot>,
    pub range: DateRange,
    pub scope: crate::retrieval::Scope,
    pub paths: Option<Vec<String>>,
}

#[cfg(test)]
fn activity_root(
    vault: &VaultRoot,
    expected_vault: &str,
    origin: &AgentVaultSession,
) -> Result<PathBuf, String> {
    vault.with_origin(origin, |root| {
        check_expected_vault(root, Some(expected_vault))?;
        Ok(root.to_path_buf())
    })
}

fn activity_read(
    vault: &VaultRoot,
    index: &crate::retrieval::Bm25Index,
    request: &ActivityRecallRequest,
    include_archived: bool,
) -> Result<crate::activity_recall::Recall, String> {
    crate::local_generation::with_ask_role(
        vault,
        &request.origin,
        request.role_snapshot.as_ref(),
        None,
        |root, _| {
            check_expected_vault(root, Some(&request.expected_vault))?;
            crate::activity_recall::recall(
                root,
                index,
                &request.range,
                request.scope,
                request.paths.as_deref(),
                include_archived,
            )
        },
    )
}

/// Collect date-grounded passages under the same foreground Ask selection.
#[tauri::command]
pub async fn activity_recall(
    app: tauri::AppHandle,
    vault: tauri::State<'_, VaultRoot>,
    bm25_cache: tauri::State<'_, crate::retrieval::Bm25Cache>,
    request: ActivityRecallRequest,
) -> Result<crate::activity_recall::Recall, String> {
    let origin = request.origin.clone();
    let snapshot = request
        .role_snapshot
        .clone()
        .ok_or("activity recall requires a native foreground Ask snapshot")?;
    let root = crate::local_generation::with_ask_role(
        &vault,
        &origin,
        Some(&snapshot),
        None,
        |root, _| {
            check_expected_vault(root, Some(&request.expected_vault))?;
            Ok(root.to_path_buf())
        },
    )?;
    let future = async {
        let index = bm25_cache
            .get_async(crate::retrieval::Bm25Index::path_for(
                &root.to_string_lossy(),
            )?)
            .await?;
        crate::local_generation::with_ask_role(&vault, &origin, Some(&snapshot), None, |_, _| {
            Ok(())
        })?;
        let include_archived = crate::settings::search_archived_sessions();
        tauri::async_runtime::spawn_blocking(move || {
            activity_read(
                &app.state::<VaultRoot>(),
                &index,
                &request,
                include_archived,
            )
        })
        .await
        .map_err(|_| "activity recall task failed".to_string())?
    };
    await_authorized(
        &vault,
        &origin,
        &snapshot,
        crate::role_authorization::RoleId::Ask,
        future,
    )
    .await
}

#[derive(serde::Serialize)]
pub struct QueryIntent {
    pub intent: String,
    pub similarity: f32,
}

/// Classify a question's INTENT by embedding it against `intent::EXEMPLARS`.
/// `None` when nothing clears `intent::INTENT_FLOOR` — the common case, and the
/// caller should carry on with its normal content answer.
///
/// Callers must only reach this when content retrieval already came up empty:
/// it costs a query embedding (~460 ms), and a question the vault can answer
/// should never pay for it. The exemplar vectors are embedded ONCE per
/// representation in a single batched call and cached for the process.
#[tauri::command]
pub async fn classify_intent(
    app: tauri::AppHandle,
    llm: tauri::State<'_, LocalLlmState>,
    query: String,
    provider: String,
    model: String,
) -> Result<Option<QueryIntent>, String> {
    use crate::embeddings::checked_cosine;
    let texts = crate::intent::exemplar_texts();
    let selected_model = embedding_model_id(&provider, &model)?;
    let selected_signature = embedding_index_signature(&app, &provider, &model).await?;
    let cached = {
        let guard = exemplar_cache().lock().unwrap_or_else(|e| e.into_inner());
        guard
            .as_ref()
            .filter(|(space, _)| {
                space.model == selected_model && space.signature == selected_signature
            })
            .cloned()
    };
    let (space, exemplar_vecs) = match cached {
        Some((space, vectors)) => {
            space.validate_batch(&vectors, texts.len())?;
            (space, vectors)
        }
        None => {
            let embedded = embed_texts_checked(
                app.clone(),
                llm.clone(),
                &provider,
                &model,
                crate::local_llm::EmbedRole::Document,
                texts.clone(),
            )
            .await?;
            if embedded.space.model != selected_model
                || embedded.space.signature != selected_signature
            {
                return Err("intent exemplar representation changed".into());
            }
            let mut guard = exemplar_cache().lock().unwrap_or_else(|e| e.into_inner());
            *guard = Some((embedded.space.clone(), embedded.vectors.clone()));
            (embedded.space, embedded.vectors)
        }
    };
    let mut q = embed_texts_checked(
        app,
        llm,
        &provider,
        &model,
        crate::local_llm::EmbedRole::Query,
        vec![query],
    )
    .await?;
    q.validate(&space, 1)?;
    let qv = q.vectors.pop().ok_or("query embedding is missing")?;
    let sims: Vec<f32> = exemplar_vecs
        .iter()
        .map(|e| checked_cosine(&qv, e))
        .collect::<Result<_, _>>()?;
    Ok(
        crate::intent::best_intent(&sims).map(|(intent, similarity)| QueryIntent {
            intent: intent.to_string(),
            similarity,
        }),
    )
}

/// Embedded exemplars, keyed by full representation so replacing weights
/// under the same model name invalidates process-local semantic reuse.
// (cache key, embedded exemplars) behind a lock — naming the tuple would not
// make the signature say more than it already does.
#[allow(clippy::type_complexity)]
fn exemplar_cache() -> &'static Mutex<Option<(embeddings::EmbeddingSpace, Vec<Vec<f32>>)>> {
    #[allow(clippy::type_complexity)]
    static CACHE: OnceLock<Mutex<Option<(embeddings::EmbeddingSpace, Vec<Vec<f32>>)>>> =
        OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Whether a `(provider, model)` pair derived from `store.model` is a
/// builtin-local index NOT tagged with the model the app currently bundles
/// (`local_llm::BUILTIN_EMBED_MODEL`) — e.g. left behind by a bundled-embed-
/// model swap (the gemma-3-1b -> bge-m3 migration), or tagged with a model
/// id that resolves to a known `EmbedSpec` but isn't bundled right now (e.g.
/// a bake-off candidate like e5-large). Either way `embed_texts` would either
/// hard-error ("unknown builtin embed model") or, worse, silently succeed
/// against a GGUF the current build doesn't ship — so both count as stale.
/// Only builtin-local is checked — "ollama" model ids are never `EmbedSpec`
/// ids at all, but `embed_texts` routes that provider straight to Ollama
/// without an `EmbedSpec` lookup, so it is never "stale" by this check.
fn builtin_index_is_stale(provider: &str, model: &str) -> bool {
    (provider == "builtin-local" || provider.is_empty())
        && model != crate::local_llm::BUILTIN_EMBED_MODEL
}

/// Existing wiki pages a new source most likely relates to — the retrieval
/// grounding for wikification (v2 phase 1). Chunks the source, embeds the chunks
/// with the SAME model the vector index was built with, retrieves per-chunk hits
/// and folds them to a ranked, deduplicated candidate list. The ingest prompt
/// injects this so the agent updates existing pages rather than duplicating.
///
/// Best-effort: an empty/absent index or a model-space mismatch returns no
/// candidates and ingest proceeds unchanged. Source-summary and structural pages
/// are excluded — they are not "update this knowledge" targets.
#[tauri::command]
pub async fn wikify_candidates(
    app: tauri::AppHandle,
    vault: tauri::State<'_, VaultRoot>,
    llm: tauri::State<'_, LocalLlmState>,
    cache: tauri::State<'_, VectorCache>,
    source_text: String,
    k: usize,
) -> Result<Vec<crate::pipeline::CandidatePage>, String> {
    let t0 = std::time::Instant::now();
    let root = require_root(&vault)?;
    let index_path = VectorStore::path_for(&root.to_string_lossy())?;
    let store = cache.get_async(index_path).await?;
    if store.records.is_empty() {
        return Ok(Vec::new()); // nothing indexed → nothing to dedup against
    }
    // Embed with the model the index was built with so cosines are meaningful;
    // `store.model` is "{provider}:{model}" (e.g. "builtin-local:").
    let (provider, model) = store
        .model
        .split_once(':')
        .map(|(p, m)| (p.to_string(), m.to_string()))
        .unwrap_or((store.model.clone(), String::new()));
    if builtin_index_is_stale(&provider, &model)
        || store.signature != embedding_index_signature(&app, &provider, &model).await?
    {
        // The index predates a bundled-embed-model swap (e.g. gemma-3-1b ->
        // bge-m3): `model` no longer resolves to a known `EmbedSpec`, so
        // `embed_texts` would hard-error. A stale index can't be meaningfully
        // deduped against anyway — the user will reindex — so degrade to "no
        // candidates" instead, same as the empty-index case above.
        perf::log(
            "wikify_candidates",
            &[("stale_index", 1.0), ("total_ms", perf::ms(t0.elapsed()))],
        );
        return Ok(Vec::new());
    }

    // Cap the chunks embedded (see `pipeline::MAX_CHUNKS`); spread-sampling is
    // a later refinement.
    use crate::pipeline::MAX_CHUNKS;
    let mut chunks = crate::embeddings::chunk_page(&source_text);
    chunks.truncate(MAX_CHUNKS);
    if chunks.is_empty() {
        return Ok(Vec::new());
    }
    let n_chunks = chunks.len();
    // One batched embed call shares a llama context across the chunks. Role is
    // Query: the incoming source's chunks are the search side, probed against
    // the already-indexed pages (embedded as Document during reindex).
    let embedded = embed_texts_checked(
        app,
        llm,
        &provider,
        &model,
        crate::local_llm::EmbedRole::Query,
        chunks,
    )
    .await?;
    embedded.validate(&store.embedding_space()?, n_chunks)?;
    let vecs = embedded.vectors;
    // Dense-only retrieval: BM25+RRF fusion was tried here (retrieval 1b) and
    // measured WORSE on `examples/wikify_eval.rs` — wikify's "query" is a whole
    // source paragraph rather than a short keyword query, so BM25 promotes
    // pages that merely share vocabulary, and RRF's rank weighting lets those
    // displace the dense-correct pages; the CJK bigram tokenizer makes this
    // worse on long Korean text. k=10 recall dropped ~15-16pp on Korean cases.
    // `semantic_search` (Ask) keeps the fusion, where it measured better — see
    // eval/BASELINE.md ("wikify" section) before re-adding a lexical arm here.
    //
    // `dense_chunk_matches` (filter → cap, no RRF) is used rather than
    // `fuse_chunk_matches(&dense, &[])`: RRF over a single arm keeps the dense
    // ORDER but overwrites every score with `1/(RRF_K + rank)`, and this path's
    // scores are read as cosine similarities downstream — `rank_candidates`
    // folds a page's chunks by max cosine, the ingest planner prompt shows
    // `(similarity 0.xx)` to the LLM, and the Ingest panel renders it. So the
    // dense-only path must carry the raw cosine through. `examples/wikify_eval.rs`
    // calls the same helper for its dense arm, keeping that column a true
    // control for this command.
    use crate::pipeline::FUSE_POOL;
    let out = tauri::async_runtime::spawn_blocking(move || {
        let per_chunk: Vec<Vec<VecHit>> = vecs
            .iter()
            .map(|v| {
                let dense = store.search(v, FUSE_POOL)?;
                Ok(crate::pipeline::dense_chunk_matches(&dense))
            })
            .collect::<Result<_, String>>()?;
        Ok::<_, String>(crate::pipeline::rank_candidates(&per_chunk, k.clamp(1, 20)))
    })
    .await
    .map_err(|e| format!("wikify ranking task failed: {e}"))??;
    perf::log(
        "wikify_candidates",
        &[
            ("chunks", n_chunks as f64),
            ("candidates", out.len() as f64),
            ("total_ms", perf::ms(t0.elapsed())),
        ],
    );
    Ok(out)
}

/// One dormant wiki page whose content echoes the day's seed text — what
/// `resurface_candidates` returns (Q4 item 10).
#[derive(Clone, serde::Serialize)]
pub struct ResurfaceCandidate {
    /// Vault-relative path, always under `wiki/`.
    pub page: String,
    pub stem: String,
    /// Cosine between the seed and the page's best chunk.
    pub score: f32,
    /// The best-matching chunk's text, trimmed to 240 chars.
    pub snippet: String,
    /// Unix secs of the last recorded open; `None` = never recorded.
    pub last_open: Option<i64>,
}

/// Pure resurface ranking: dormant `wiki/` pages by best-chunk cosine against
/// `seed`. Dormant = (last_open absent AND mtime older than `dormant_secs`)
/// OR (last_open older than `dormant_secs`) — a page with neither signal
/// cannot be shown dormant and stays out. Never `is_cold` pages (belt over
/// the wiki/ filter — cold tiers must not resurface even if a stale record
/// slips into the index), only scores `>= floor`, at most `k`.
///
/// `chunk_text` resolves a (page, section) to its chunk's TEXT — the command
/// passes the `chunk_text_at` file reader, tests pass a map, which is what
/// keeps this core free of disk I/O. A page whose best chunk no longer
/// reconstructs (file gone, stale section) is skipped, like semantic_search.
#[allow(clippy::too_many_arguments)]
pub(crate) fn resurface_core(
    store: &VectorStore,
    seed: &[f32],
    opens: &std::collections::HashMap<String, i64>,
    mtimes: &std::collections::HashMap<String, i64>,
    now: i64,
    dormant_secs: i64,
    floor: f32,
    k: usize,
    chunk_text: &dyn Fn(&str, usize) -> Option<String>,
) -> Result<Vec<ResurfaceCandidate>, String> {
    store.validate_geometry()?;
    embeddings::checked_vector_norm(seed, (store.dim != 0).then_some(store.dim))?;
    if !floor.is_finite() {
        return Err("resurface similarity floor is not finite".into());
    }
    // Best chunk per page: (cosine, section, stem).
    let mut best: std::collections::HashMap<&str, (f32, usize, &str)> =
        std::collections::HashMap::new();
    for r in &store.records {
        if !r.page.starts_with("wiki/") || is_cold(&r.page) {
            continue;
        }
        let score = embeddings::checked_cosine(seed, &r.vector)?;
        let cur = best
            .entry(r.page.as_str())
            .or_insert((score, r.section, r.stem.as_str()));
        if score > cur.0 {
            *cur = (score, r.section, r.stem.as_str());
        }
    }
    let dormant = |page: &str| match opens.get(page) {
        Some(t) => now - t > dormant_secs,
        None => mtimes.get(page).is_some_and(|m| now - m > dormant_secs),
    };
    let mut ranked: Vec<(f32, &str, usize, &str)> = best
        .into_iter()
        .filter(|(page, (score, _, _))| *score >= floor && dormant(page))
        .map(|(page, (score, section, stem))| (score, page, section, stem))
        .collect();
    ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut out = Vec::new();
    for (score, page, section, stem) in ranked {
        if out.len() == k {
            break;
        }
        let Some(text) = chunk_text(page, section) else {
            continue;
        };
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        out.push(ResurfaceCandidate {
            page: page.to_string(),
            stem: stem.to_string(),
            score,
            snippet: text.chars().take(240).collect(),
            last_open: opens.get(page).copied(),
        });
    }
    Ok(out)
}

/// Dormant wiki pages whose content echoes `seed_text` — the resurface layer
/// (Q4 item 10). Embeds the seed with the model the index was built with and
/// ranks via `resurface_core`; dormancy reads `.myco/page-opens.json` with
/// file mtime as the never-opened fallback. Best-effort like
/// `wikify_candidates`: an empty or stale index returns no candidates.
#[tauri::command]
pub async fn resurface_candidates(
    app: tauri::AppHandle,
    vault: tauri::State<'_, VaultRoot>,
    llm: tauri::State<'_, LocalLlmState>,
    cache: tauri::State<'_, VectorCache>,
    seed_text: String,
    k: usize,
    floor: f32,
) -> Result<Vec<ResurfaceCandidate>, String> {
    // Not opened (or, failing that, not modified) for 30 days => dormant.
    const DORMANT_SECS: i64 = 30 * 24 * 60 * 60;
    let root = require_root(&vault)?;
    let index_path = VectorStore::path_for(&root.to_string_lossy())?;
    let store = cache.get_async(index_path).await?;
    if store.records.is_empty() {
        return Ok(Vec::new());
    }
    // Embed with the index's own model (`store.model` is "{provider}:{model}"),
    // degrading to empty on a stale bundled model — the wikify_candidates idiom.
    let (provider, model) = store
        .model
        .split_once(':')
        .map(|(p, m)| (p.to_string(), m.to_string()))
        .unwrap_or((store.model.clone(), String::new()));
    if builtin_index_is_stale(&provider, &model)
        || store.signature != embedding_index_signature(&app, &provider, &model).await?
    {
        return Ok(Vec::new());
    }
    let mut q = embed_texts_checked(
        app,
        llm,
        &provider,
        &model,
        crate::local_llm::EmbedRole::Query,
        vec![seed_text],
    )
    .await?;
    q.validate(&store.embedding_space()?, 1)?;
    let seed = q.vectors.pop().ok_or("seed embedding is missing")?;
    let opens = crate::page_opens::load(&root);
    // `vault::file_mtimes` walks the whole vault (same walk the 4 s refresh
    // poll already pays) and returns ABSOLUTE paths under the canonicalized
    // root — strip that root and keep `wiki/`.
    let canon = root.canonicalize().unwrap_or_else(|_| root.clone());
    let mtimes: std::collections::HashMap<String, i64> =
        vault::file_mtimes(&root.to_string_lossy())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(abs, m)| {
                let rel = std::path::Path::new(&abs)
                    .strip_prefix(&canon)
                    .ok()?
                    .to_string_lossy()
                    .replace('\\', "/");
                rel.starts_with("wiki/").then_some((rel, m))
            })
            .collect();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    resurface_core(
        &store,
        &seed,
        &opens,
        &mtimes,
        now,
        DORMANT_SECS,
        floor,
        k,
        &|page, section| {
            std::fs::read_to_string(root.join(page))
                .ok()
                .and_then(|c| chunk_text_at(&c, section))
        },
    )
}

/// 2D semantic-map coordinates for every indexed page — the "semantic" graph
/// layout (notes cluster by meaning, not links). PCA runs here in Rust so the
/// 1152-dim centroids never cross the IPC bridge; only (page, x, y) does.
/// Empty when no index exists — the layout falls back and says why.
///
/// Async + `spawn_blocking`: the power iteration is ~1s on a 10k-page index.
#[tauri::command]
pub async fn semantic_map(
    vault: tauri::State<'_, VaultRoot>,
    cache: tauri::State<'_, VectorCache>,
) -> Result<Vec<crate::vector_index::SemanticPoint>, String> {
    let root = require_root(&vault)?;
    let index_path = VectorStore::path_for(&root.to_string_lossy())?;
    let store = cache.get_async(index_path).await?;
    if store.records.is_empty() {
        return Ok(Vec::new());
    }
    let t0 = std::time::Instant::now();
    let out = tauri::async_runtime::spawn_blocking(move || {
        Ok::<_, String>(crate::vector_index::semantic_map_points(
            &store.page_centroids()?,
        ))
    })
    .await
    .map_err(|e| format!("semantic map task failed: {e}"))??;
    perf::log(
        "semantic_map",
        &[
            ("pages", out.len() as f64),
            ("total_ms", perf::ms(t0.elapsed())),
        ],
    );
    Ok(out)
}

/// Pages most semantically similar to `page` (no embedding call — uses stored
/// vectors), for the Reader related-notes panel and graph similarity edges.
///
/// Async: this scans every record, best-chunk against best-chunk, which is the
/// heaviest read in the semantic layer after the edge pass. The Reader asks for
/// it on every page open, so on the event loop it would stall navigation.
#[tauri::command]
pub async fn related_pages(
    vault: tauri::State<'_, VaultRoot>,
    cache: tauri::State<'_, VectorCache>,
    page: String,
    k: usize,
) -> Result<Vec<VecHit>, String> {
    let t0 = std::time::Instant::now();
    let root = require_root(&vault)?;
    let index_path = VectorStore::path_for(&root.to_string_lossy())?;
    let store = cache.get_async(index_path).await?;
    let load_ms = perf::ms(t0.elapsed());
    let records = store.records.len();
    let t_scan = std::time::Instant::now();
    let hits = tauri::async_runtime::spawn_blocking(move || store.related(&page, k.clamp(1, 50)))
        .await
        .map_err(|e| format!("join failed: {e}"))??;
    perf::log(
        "related_pages",
        &[
            ("load_store_ms", load_ms),
            ("scan_ms", perf::ms(t_scan.elapsed())),
            ("total_ms", perf::ms(t0.elapsed())),
            ("records", records as f64),
        ],
    );
    Ok(hits)
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
///
/// Async because a cache miss runs the centroid pass, which is quadratic in
/// pages (114 ms at 300, growing with the square) — on the event loop that
/// stalls every other IPC call. The pass also runs OUTSIDE the cache's lock, so
/// a search issued while the graph is building its overlay does not queue behind
/// it: `lookup_edges` hands back shared work, which runs on the blocking pool.
/// Concurrent requests share that pass, and its cell belongs to this revision.
#[tauri::command]
pub async fn semantic_edges(
    vault: tauri::State<'_, VaultRoot>,
    cache: tauri::State<'_, VectorCache>,
    k: usize,
) -> Result<Vec<SemanticEdge>, String> {
    let t0 = std::time::Instant::now();
    let root = require_root(&vault)?;
    let index_path = VectorStore::path_for(&root.to_string_lossy())?;
    let k = k.clamp(1, 10);

    let (edges, computed) = match cache.lookup_edges_async(index_path, k).await? {
        EdgeLookup::Ready(edges) => (edges, false),
        EdgeLookup::Empty => (Arc::new(Vec::new()), false),
        EdgeLookup::Compute(work) => tauri::async_runtime::spawn_blocking(move || work.compute())
            .await
            .map_err(|e| format!("join failed: {e}"))??,
    };
    let build_ms = perf::ms(t0.elapsed());

    let abs = |rel: &str| root.join(rel).to_string_lossy().into_owned();
    let out: Vec<SemanticEdge> = edges
        .iter()
        .map(|e| SemanticEdge {
            source: abs(&e.a),
            target: abs(&e.b),
            score: e.score,
        })
        .collect();
    perf::log(
        "semantic_edges",
        &[
            // Near zero on a cache hit; the centroid pass on a miss. A slow line
            // here means a fresh index, which is what the field is for.
            ("build_edges_ms", build_ms),
            ("total_ms", perf::ms(t0.elapsed())),
            ("edges", out.len() as f64),
            ("computed", if computed { 1.0 } else { 0.0 }),
        ],
    );
    Ok(out)
}

#[derive(serde::Serialize)]
pub struct EmbeddingsStatus {
    pub indexed_pages: usize,
    pub model: String,
}

/// Index health for the Settings panel.
#[tauri::command]
pub async fn embeddings_status(
    vault: tauri::State<'_, VaultRoot>,
    cache: tauri::State<'_, VectorCache>,
) -> Result<EmbeddingsStatus, String> {
    let root = require_root(&vault)?;
    let index_path = VectorStore::path_for(&root.to_string_lossy())?;
    let store = cache.get_async(index_path).await?;
    Ok(EmbeddingsStatus {
        indexed_pages: store.indexed_pages(),
        model: store.model.clone(),
    })
}

/// Fetch a YouTube video's caption transcript as plain text (Feature 2). No key;
/// best-effort scrape of the caption track. Errors clearly when captions are
/// absent. The caller ingests the returned text like any pasted source.
#[tauri::command]
pub async fn fetch_youtube_transcript(url: String) -> Result<String, String> {
    crate::youtube::fetch_transcript(&url).await
}

/// Fetch a web article's main text as markdown (S38) behind the SSRF guard in
/// `web_fetch`. Writes nothing: like the transcript above, the caller ingests
/// the returned text, so the secret/PII scan and raw/ rules still apply.
/// Errors are the stable codes listed in `web_fetch`.
#[tauri::command]
pub async fn fetch_web_page(url: String) -> Result<crate::web_fetch::WebPage, String> {
    crate::web_fetch::fetch_page(&url).await
}

// ROADMAP P2 — crash report viewer (Settings -> About). The panic hook
// (lib.rs) already writes a post-mortem line before every release-build
// abort; these three commands are the read/report/clear surface over it.

/// Last `limit` panic entries, oldest first. Empty when nothing has ever
/// panicked.
#[tauri::command]
pub fn recent_panics(limit: usize) -> Vec<crate::crash::PanicEntry> {
    crate::crash::recent_panics(&crate::panic_log_path(), limit)
}

/// Delete the panic log so a stale crash stops showing as "the last crash".
#[tauri::command]
pub fn clear_panic_log() -> Result<(), String> {
    crate::crash::clear_log(&crate::panic_log_path())
}

/// OS name + version, for the "Copy a bug report" button. Read on demand
/// (not cached) — it is one cheap local command, not worth persisting.
#[tauri::command]
pub fn os_version() -> String {
    crate::crash::os_version()
}

#[cfg(test)]
#[path = "commands_scan_tests.rs"]
mod scan_tests;

#[cfg(test)]
#[path = "commands_import_projection_tests.rs"]
mod import_projection_tests;

#[cfg(test)]
#[path = "commands_activity_admission_tests.rs"]
mod activity_admission_tests;

#[cfg(test)]
#[path = "commands_deletion_mutation_tests.rs"]
mod deletion_mutation_tests;

#[cfg(test)]
#[path = "commands_creation_mutation_tests.rs"]
mod creation_mutation_tests;

#[cfg(test)]
#[path = "commands_editor_mutation_tests.rs"]
mod editor_mutation_tests;

#[cfg(test)]
mod tests {
    #[tokio::test(flavor = "current_thread")]
    async fn file_read_wait_does_not_block_runtime_heartbeat() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("synthetic.md");
        std::fs::write(&path, "---\ntitle: Synthetic\n---\nHello\n").unwrap();
        let gate = std::sync::Arc::new(std::sync::Mutex::new(()));
        let holder_gate = gate.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let holder = std::thread::spawn(move || {
            let _guard = holder_gate.lock().unwrap();
            ready_tx.send(()).unwrap();
            release_rx
                .recv_timeout(std::time::Duration::from_secs(1))
                .is_ok()
        });
        ready_rx.recv().unwrap();
        let root_path = root.path().canonicalize().unwrap();
        let read = super::run_file_task("read file", move || {
            let _guard = gate.lock().unwrap();
            let confined = crate::vault::confine_path(&root_path, &path.to_string_lossy())?;
            crate::vault::read_file(&confined.to_string_lossy())
        });
        let heartbeat = tokio::time::sleep(std::time::Duration::from_millis(10));
        tokio::pin!(read, heartbeat);
        let heartbeat_first = tokio::select! {
            biased;
            result = &mut read => {
                result.unwrap();
                false
            },
            _ = &mut heartbeat => true,
        };
        if heartbeat_first {
            release_tx.send(()).unwrap();
            let file = read.await.unwrap();
            assert_eq!(file.raw, "---\ntitle: Synthetic\n---\nHello\n");
            assert_eq!(file.frontmatter["title"], "Synthetic");
        }
        let released_by_heartbeat = holder.join().unwrap();
        assert!(heartbeat_first, "file read blocked the runtime heartbeat");
        assert!(
            released_by_heartbeat,
            "worker did not receive the heartbeat release"
        );
    }

    #[tokio::test]
    async fn file_worker_preserves_confinement_and_read_errors() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let path = outside.path().join("synthetic.md");
        std::fs::write(&path, "Outside\n").unwrap();
        let root_path = root.path().canonicalize().unwrap();
        let result = super::run_file_task("read file", move || {
            let confined = crate::vault::confine_path(&root_path, &path.to_string_lossy())?;
            crate::vault::read_file(&confined.to_string_lossy())
        })
        .await;
        assert!(
            result.is_err(),
            "a worker must not widen the vault boundary"
        );
        let missing = root.path().join("missing.md");
        let result = super::run_file_task("read file", move || {
            crate::vault::read_file(&missing.to_string_lossy())
        })
        .await;
        assert!(result.unwrap_err().contains("canonicalize failed"));
    }

    #[test]
    fn dashboard_save_refuses_stale_vault_before_touching_current_document() {
        let original = tempfile::tempdir().unwrap();
        let current = tempfile::tempdir().unwrap();
        super::save_dashboard_at(current.path(), "overview", "current layout", None).unwrap();
        let error = super::save_dashboard_at(
            current.path(),
            "overview",
            "old pending layout",
            Some(original.path().to_str().unwrap()),
        )
        .expect_err("a delayed save must not write to the next vault");
        assert!(error.contains("active vault changed"), "{error}");
        assert_eq!(
            std::fs::read_to_string(current.path().join(".myco/dashboards/overview.json")).unwrap(),
            "current layout"
        );
        assert!(!original.path().join(".myco").exists());
    }

    #[test]
    fn dashboard_save_accepts_matching_vault_and_legacy_callers() {
        let root = tempfile::tempdir().unwrap();
        super::save_dashboard_at(
            root.path(),
            "overview",
            "matching layout",
            Some(root.path().to_str().unwrap()),
        )
        .unwrap();
        super::save_dashboard_at(root.path(), "legacy", "legacy layout", None).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.path().join(".myco/dashboards/overview.json")).unwrap(),
            "matching layout"
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join(".myco/dashboards/legacy.json")).unwrap(),
            "legacy layout"
        );
    }

    use super::{
        append_recall_miss, ask_response, builtin_index_is_stale, capture_note_at, chunk_text_at,
        chunks_needing_embed, copy_into_inbox_at, delete_myco_json, export_bundle_write,
        external_target_allowed, import_dest, inbox_entries, is_media_name, iso_week_monday,
        list_myco_json, move_path_at, myco_json_path, page_in_date_range, read_settings_import,
        recency_tie_break, resurface_core, run_diff_core, run_import, save_favorites_at,
        save_myco_json, stamp_related, sync_bm25_for_page, trash_targets, voice_inbox_rel,
        voice_markdown, windows_opener_safe, write_inbox_note_at, write_voice_note, DateRange,
        HybridHit, DEST_INBOX, DEST_SESSIONS, INBOX_COPY_MAX_BYTES, INBOX_COPY_MAX_MEDIA_BYTES,
    };
    use crate::retrieval::{rrf_fuse, Bm25Cache, Bm25Index};
    use crate::vector_index::Hit;
    use std::collections::{HashMap, HashSet};

    /// "Trash all" sends one list to the OS trash: `delete_path`'s checks on
    /// every path, and a path already gone (a sidecar a half-written move
    /// never made) dropped rather than failing the batch.
    fn indexed_page(
        root: &std::path::Path,
        store: &mut crate::vector_index::VectorStore,
        bm25: &mut Bm25Index,
        page: &str,
        body: &str,
        vector: Vec<f32>,
    ) {
        let path = root.join(page);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
        let chunks = crate::embeddings::chunk_page(body);
        store
            .upsert_page(
                page,
                page,
                chunks
                    .iter()
                    .map(|c| (crate::embeddings::content_hash(c), vector.clone()))
                    .collect(),
            )
            .unwrap();
        bm25.upsert_page(page, page, &chunks);
    }
    fn ranked(
        root: &std::path::Path,
        store: &crate::vector_index::VectorStore,
        bm25: &Bm25Index,
        query: &str,
        k: usize,
        range: Option<&DateRange>,
    ) -> Vec<HybridHit> {
        super::rank_hybrid(
            root,
            store,
            Some(&[1.0, 0.0]),
            bm25,
            query,
            k,
            range,
            crate::retrieval::Scope::All,
            None,
            &crate::retrieval::TierWeights::FLAT,
        )
        .unwrap()
    }
    #[test]
    #[ignore = "measures bundled E5 on the public bilingual labeled corpus"]
    fn public_retrieval_e5_measurement() {
        use crate::local_llm::{embed_spec_by_id, EmbedRole, LocalLlm};
        use std::time::Instant;
        #[derive(serde::Deserialize)]
        struct Labeled {
            q: String,
            relevant: Vec<String>,
        }
        #[derive(serde::Deserialize)]
        struct EvalSet {
            queries: Vec<Labeled>,
        }
        let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let set: EvalSet = serde_json::from_str(
            &std::fs::read_to_string(manifest.join("eval/retrieval-queries.json")).unwrap(),
        )
        .unwrap();
        let mut llm = LocalLlm::load_embed_host().unwrap();
        let load_start = Instant::now();
        llm.load_embed_model(&manifest.join("models/multilingual-e5-small-ko-v2-q8_0.gguf"))
            .unwrap();
        let load_ms = load_start.elapsed().as_secs_f64() * 1000.0;
        let spec = embed_spec_by_id("e5-small-ko").unwrap();
        let dir = tempfile::tempdir().unwrap();
        let mut fixtures: Vec<(String, String)> = crate::sample_vault::SAMPLE_NOTES
            .iter()
            .filter(|(page, _)| page.starts_with("wiki/"))
            .map(|(page, body)| (page.to_string(), body.to_string()))
            .collect();
        let mut paths: Vec<_> = std::fs::read_dir(manifest.join("eval/ko-corpus"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|p| p.extension().is_some_and(|ext| ext == "md"))
            .collect();
        paths.sort();
        for path in paths {
            let stem = path.file_stem().unwrap().to_string_lossy();
            fixtures.push((
                format!("ko-corpus/{stem}.md"),
                std::fs::read_to_string(&path).unwrap(),
            ));
        }
        let mut store = crate::vector_index::VectorStore::default();
        let mut bm25 = Bm25Index::new();
        let index_start = Instant::now();
        for (page, body) in &fixtures {
            let full = dir.path().join(page);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, body).unwrap();
            let stem = std::path::Path::new(page)
                .file_stem()
                .unwrap()
                .to_string_lossy();
            let chunks = crate::embeddings::chunk_page(body);
            let mut entries = Vec::new();
            for batch in chunks.chunks(super::DENSE_BATCH_CHUNKS) {
                entries.extend(
                    batch
                        .iter()
                        .zip(llm.embed_spec(spec, EmbedRole::Document, batch).unwrap())
                        .map(|(text, v)| (crate::embeddings::content_hash(text), v)),
                );
            }
            store.upsert_page(page, &stem, entries).unwrap();
            bm25.upsert_page(page, &stem, &chunks);
        }
        let index_ms = index_start.elapsed().as_secs_f64() * 1000.0;
        let mut hit1 = 0;
        let mut hit3 = 0;
        let mut recall5 = 0.0;
        let mut reciprocal = 0.0;
        let mut grounded_hit3 = 0;
        let mut durations = Vec::new();
        for label in &set.queries {
            let start = Instant::now();
            let q = llm
                .embed_spec(spec, EmbedRole::Query, std::slice::from_ref(&label.q))
                .unwrap()
                .remove(0);
            let hits = super::rank_hybrid(
                dir.path(),
                &store,
                Some(&q),
                &bm25,
                &label.q,
                40,
                None,
                crate::retrieval::Scope::All,
                None,
                &crate::retrieval::TierWeights::FLAT,
            )
            .unwrap();
            durations.push(start.elapsed().as_secs_f64() * 1000.0);
            let mut seen = HashSet::new();
            let ranked: Vec<_> = hits
                .iter()
                .filter(|h| seen.insert(h.stem.clone()))
                .collect();
            if let Some(pos) = ranked.iter().position(|h| label.relevant.contains(&h.stem)) {
                reciprocal += 1.0 / (pos + 1) as f64;
                hit1 += usize::from(pos == 0);
                hit3 += usize::from(pos < 3);
            }
            recall5 += ranked
                .iter()
                .take(5)
                .filter(|h| label.relevant.contains(&h.stem))
                .count() as f64
                / label.relevant.len() as f64;
            let response = ask_response(hits);
            let mut seen = HashSet::new();
            if response
                .hits
                .iter()
                .filter(|h| seen.insert(h.stem.clone()))
                .take(3)
                .any(|h| label.relevant.contains(&h.stem))
            {
                grounded_hit3 += 1;
            } else {
                eprintln!(
                    "public_grounding_miss query={:?} gold={:?} near={:?}",
                    label.q,
                    label.relevant,
                    response
                        .below_floor
                        .iter()
                        .map(|h| (&h.page, h.similarity))
                        .collect::<Vec<_>>()
                );
            }
        }
        durations.sort_by(f64::total_cmp);
        let n = set.queries.len();
        eprintln!("public_retrieval public=true production_rank=true queries={n} pages={} chunks={} hit1={hit1}/{n} hit3={hit3}/{n} recall5={:.4} mrr={:.4} grounded_hit3={grounded_hit3}/{n} load_ms={load_ms:.1} index_ms={index_ms:.1} query_median_ms={:.1} query_p95_ms={:.1}",
            fixtures.len(), store.records.len(), recall5/n as f64, reciprocal/n as f64,
            durations[n/2], durations[(n*95).div_ceil(100).saturating_sub(1)]);
    }

    #[test]
    #[ignore = "measures bundled E5 against a synthetic vault only"]
    fn personal_recall_e5_measurement() {
        use crate::local_llm::{embed_spec_by_id, EmbedRole, LocalLlm};
        use std::time::Instant;
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("models/multilingual-e5-small-ko-v2-q8_0.gguf");
        let mut llm = LocalLlm::load_embed_host().unwrap();
        let load_start = Instant::now();
        llm.load_embed_model(&path).unwrap();
        let load_ms = load_start.elapsed().as_secs_f64() * 1000.0;
        let spec = embed_spec_by_id("e5-small-ko").unwrap();
        let dir = tempfile::tempdir().unwrap();
        let long: String=(0..300).map(|i| format!("# Log {i}\n\nThe synthetic request ID_{i:04} was recorded in session history.\n\n")).collect();
        let fixtures=vec![
            ("sessions/2026-05/old.md","# Earlier decision\n\nThe server port is 8000. We decided to keep the old cache format.".to_string()),
            ("sessions/2026-06/current.md","# Current decision\n\nThe server port is 9000. We changed the cache format to preserve immutable source originals.".to_string()),
            ("sessions/2026-06/long.md",long),
            ("wiki/cache.md","# Cache implementation\n\nCall client.openVault(cache_key) to reuse the local vector index. 한국어 검색은 작은 E5 모델을 사용한다.".to_string()),
            ("raw/conversations/mcp-export.md","# Imported original\n\nMCP_PROJECT_42 chose a bounded local encoder for an Intel Mac with 8 GB RAM.".to_string())
        ];
        let mut store = crate::vector_index::VectorStore::default();
        let mut bm25 = Bm25Index::new();
        let index_start = Instant::now();
        for (page, body) in &fixtures {
            let full = dir.path().join(page);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, body).unwrap();
            let chunks = crate::embeddings::chunk_page(body);
            let mut entries = Vec::new();
            for batch in chunks.chunks(super::DENSE_BATCH_CHUNKS) {
                let vectors = llm.embed_spec(spec, EmbedRole::Document, batch).unwrap();
                entries.extend(
                    batch
                        .iter()
                        .zip(vectors)
                        .map(|(text, v)| (crate::embeddings::content_hash(text), v)),
                );
            }
            store.upsert_page(page, page, entries).unwrap();
            bm25.upsert_page(page, page, &chunks);
        }
        let index_ms = index_start.elapsed().as_secs_f64() * 1000.0;
        let june = dr("2026-06-01", "2026-06-30");
        let may = dr("2026-05-01", "2026-05-31");
        let cases = [
            ("ID_0299", Some("sessions/2026-06/long.md"), None),
            ("cache_key", Some("wiki/cache.md"), None),
            (
                "MCP_PROJECT_42",
                Some("raw/conversations/mcp-export.md"),
                None,
            ),
            (
                "\"immutable source originals\"",
                Some("sessions/2026-06/current.md"),
                None,
            ),
            (
                "What server port did we decide?",
                Some("sessions/2026-06/current.md"),
                Some(&june),
            ),
            (
                "What server port did we decide?",
                Some("sessions/2026-05/old.md"),
                Some(&may),
            ),
            (
                "When was the gravitational supernova discovered?",
                None,
                None,
            ),
            ("What recipe uses saffron and lobster?", None, None),
        ];
        let mut reciprocal = 0.0;
        let mut hit1 = 0;
        let mut hit5 = 0;
        let mut false_accept = 0;
        let mut durations = Vec::new();
        for (query, gold, range) in cases {
            let begin = Instant::now();
            let q = llm
                .embed_spec(spec, EmbedRole::Query, &[query.to_string()])
                .unwrap()
                .remove(0);
            let hits = super::rank_hybrid(
                dir.path(),
                &store,
                Some(&q),
                &bm25,
                query,
                5,
                range,
                crate::retrieval::Scope::All,
                None,
                &crate::retrieval::TierWeights::FLAT,
            )
            .unwrap();
            let response = ask_response(hits);
            durations.push(begin.elapsed().as_secs_f64() * 1000.0);
            if let Some(gold) = gold {
                if let Some(position) = response.hits.iter().position(|h| h.page == gold) {
                    reciprocal += 1.0 / (position + 1) as f64;
                    hit5 += 1;
                    if position == 0 {
                        hit1 += 1;
                    }
                }
            } else if !response.hits.is_empty() {
                false_accept += 1;
            }
            eprintln!(
                "personal_case query={query:?} gold={gold:?} returned={:?}",
                response
                    .hits
                    .iter()
                    .map(|h| (&h.page, h.section, h.similarity, h.exact_match))
                    .collect::<Vec<_>>()
            );
        }
        assert!(bm25.search("ID_0299", 10).iter().any(|h| h.section == 299));
        durations.sort_by(f64::total_cmp);
        eprintln!("personal_recall synthetic=true queries=8 answerable=6 negatives=2 chunks={} hit1={}/6 recall5={}/6 mrr={:.4} false_accept={}/2 load_ms={:.1} index_ms={:.1} query_median_ms={:.1} query_p95_ms={:.1}",store.records.len(),hit1,hit5,reciprocal/6.0,false_accept,load_ms,index_ms,durations[durations.len()/2],durations[durations.len()-1]);
    }

    #[test]
    fn exact_source_revision_collapses_only_eligible_all_scope_projection() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = crate::vector_index::VectorStore::default();
        let mut bm25 = Bm25Index::new();
        let raw = "raw/conversations/fixture/current.md";
        let source = "# Source\n\nREQUEST_1234 selected a bounded encoder.";
        indexed_page(
            dir.path(),
            &mut store,
            &mut bm25,
            raw,
            source,
            vec![1.0, 0.0],
        );
        let revision = crate::importers::wikify::source_revision(source);
        let projection = "sessions/2026-06/project.md";
        let body = format!("---\nraw_path: {raw}\nsource_revision: {revision}\n---\n{source}");
        indexed_page(
            dir.path(),
            &mut store,
            &mut bm25,
            projection,
            &body,
            vec![1.0, 0.0],
        );
        let all = ranked(dir.path(), &store, &bm25, "REQUEST_1234", 5, None);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].page, raw);
        let scope = |scope, paths: Option<&[String]>, range| {
            super::rank_hybrid(
                dir.path(),
                &store,
                Some(&[1.0, 0.0]),
                &bm25,
                "REQUEST_1234",
                5,
                range,
                scope,
                paths,
                &crate::retrieval::TierWeights::FLAT,
            )
            .unwrap()
        };
        assert_eq!(
            scope(crate::retrieval::Scope::Sessions, None, None)[0].page,
            projection
        );
        let explicit = vec![projection.to_string()];
        assert_eq!(
            scope(crate::retrieval::Scope::All, Some(&explicit), None)[0].page,
            projection
        );
        // Undated originals cannot displace a projection eligible by its date.
        let june = dr("2026-06-01", "2026-06-30");
        assert_eq!(
            scope(crate::retrieval::Scope::All, None, Some(&june))[0].page,
            projection
        );
        // An old immutable revision is another source, not a duplicate.
        let old_raw = "raw/conversations/fixture/current.r2.md";
        let old_source = "# Source\n\nREQUEST_1234 originally selected another encoder.";
        indexed_page(
            dir.path(),
            &mut store,
            &mut bm25,
            old_raw,
            old_source,
            vec![1.0, 0.0],
        );
        let hits = ranked(dir.path(), &store, &bm25, "REQUEST_1234", 5, None);
        assert_eq!(hits.len(), 2);
        assert!(hits.iter().any(|h| h.page == old_raw));
        // A mismatch or stale lexical source must never hide the projection.
        std::fs::write(
            dir.path().join(raw),
            "# Edited source\nREQUEST_1234 changed.",
        )
        .unwrap();
        assert!(ranked(dir.path(), &store, &bm25, "REQUEST_1234", 5, None)
            .iter()
            .any(|h| h.page == projection));
    }

    #[test]
    fn stale_same_section_cannot_quote_replacement_text() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = crate::vector_index::VectorStore::default();
        let mut bm25 = Bm25Index::new();
        indexed_page(
            dir.path(),
            &mut store,
            &mut bm25,
            "wiki/a.md",
            "# A\nold decision",
            vec![1.0, 0.0],
        );
        std::fs::write(dir.path().join("wiki/a.md"), "# A\nunrelated replacement").unwrap();
        assert!(ranked(dir.path(), &store, &bm25, "decision", 5, None).is_empty());
    }
    #[test]
    fn date_and_phrase_filters_refill_beyond_the_old_pool() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = crate::vector_index::VectorStore::default();
        let mut bm25 = Bm25Index::new();
        for i in 0..30 {
            indexed_page(
                dir.path(),
                &mut store,
                &mut bm25,
                &format!("sessions/2026-05/old-{i}.md"),
                "# Old\nred unrelated blue",
                vec![1.0, 0.0],
            );
        }
        indexed_page(
            dir.path(),
            &mut store,
            &mut bm25,
            "sessions/2026-06/current.md",
            "# Current\nred blue exact decision",
            vec![0.8, 0.6],
        );
        let range = dr("2026-06-01", "2026-06-30");
        assert_eq!(
            ranked(dir.path(), &store, &bm25, "decision", 1, Some(&range))[0].page,
            "sessions/2026-06/current.md"
        );
        assert_eq!(
            ranked(
                dir.path(),
                &store,
                &Bm25Index::new(),
                "\"red blue\"",
                1,
                None
            )[0]
            .page,
            "sessions/2026-06/current.md"
        );
    }
    #[test]
    fn lexical_union_keeps_the_real_low_cosine_outside_dense_pool() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = crate::vector_index::VectorStore::default();
        let mut bm25 = Bm25Index::new();
        for i in 0..30 {
            indexed_page(
                dir.path(),
                &mut store,
                &mut bm25,
                &format!("wiki/z-{i}.md"),
                "# Noise\nbackground unrelated material",
                vec![1.0, 0.0],
            );
        }
        indexed_page(
            dir.path(),
            &mut store,
            &mut bm25,
            "wiki/a-target.md",
            "# Request\nrequest ID_8F27 failed",
            vec![0.1, 0.9949874],
        );
        let hits = ranked(dir.path(), &store, &bm25, "ID_8F27", 2, None);
        let target = hits.iter().find(|h| h.page == "wiki/a-target.md").unwrap();
        assert!((target.similarity.unwrap() - 0.1).abs() < 1e-5);
        assert!(target.exact_match);
    }
    #[test]
    fn resumed_session_range_uses_each_turn_timestamp() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = crate::vector_index::VectorStore::default();
        let mut bm25 = Bm25Index::new();
        let body = "---\nturn_metadata: [{\"timestamp\":\"2026-05-02T10:00:00Z\"},{\"timestamp\":\"2026-06-03T10:00:00Z\"}]\n---\n\n# Session\n\n**User:**\n\nOld decision ID_OLD1\n\n**Assistant:**\n\nCurrent decision ID_NEW2\n";
        indexed_page(
            dir.path(),
            &mut store,
            &mut bm25,
            "sessions/2026-05/resumed.md",
            body,
            vec![1.0, 0.0],
        );
        let range = dr("2026-06-01", "2026-06-30");
        let hits = ranked(dir.path(), &store, &bm25, "decision", 5, Some(&range));
        assert_eq!(hits.len(), 1);
        assert!(hits[0].text.contains("ID_NEW2"));
        assert_eq!(hits[0].line, 11);
    }
    #[test]
    fn weak_lexical_hit_is_rejected_but_verified_exact_id_is_kept() {
        let mut weak = hybrid_hit("wiki/noise.md", 0.02, None);
        weak.exact_match = false;
        assert!(ask_response(vec![weak]).hits.is_empty());
        let mut exact = hybrid_hit("wiki/id.md", 0.02, Some(0.1));
        exact.exact_match = true;
        assert_eq!(ask_response(vec![exact]).hits.len(), 1);
    }

    #[test]
    fn trash_targets_checks_every_path_and_skips_the_missing() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let q = root.join("_inbox/quarantine");
        std::fs::create_dir_all(&q).unwrap();
        std::fs::write(q.join("a.md"), "a").unwrap();
        std::fs::write(q.join("b.md"), "b").unwrap();
        std::fs::write(q.join("b.verdict.json"), "{}").unwrap();
        std::fs::create_dir_all(root.join("raw")).unwrap();
        std::fs::write(root.join("raw/s.md"), "s").unwrap();
        let abs = |rel: &str| root.join(rel).to_string_lossy().into_owned();

        let paths = [
            "_inbox/quarantine/a.md",
            "_inbox/quarantine/a.verdict.json",
            "_inbox/quarantine/b.md",
            "_inbox/quarantine/b.verdict.json",
        ]
        .map(abs);
        assert_eq!(
            trash_targets(&root, &paths).unwrap(),
            vec![q.join("a.md"), q.join("b.md"), q.join("b.verdict.json")]
        );
        assert!(trash_targets(&root, &[abs("_inbox/quarantine/a.md"), abs("raw/s.md")]).is_err());
        let outside = dir.path().parent().unwrap().join("x.md");
        assert!(trash_targets(&root, &[outside.to_string_lossy().into_owned()]).is_err());
    }
    use std::path::PathBuf;

    // ---- .myco kind-scoped JSON ---------------------------------------------

    #[test]
    fn myco_json_path_validates_bare_names() {
        let root = PathBuf::from("/v");
        let long = "x".repeat(61);
        for bad in ["", long.as_str(), "a/b", "a\\b", "..", ".hidden"] {
            assert!(myco_json_path(&root, "views", bad).is_err(), "{bad:?}");
        }
        // 21 chars = 63 bytes: the old byte cap rejected real Korean names.
        let name = "가나다라마바사아자차카타파하가나다라마바사";
        assert_eq!(name.chars().count(), 21);
        assert_eq!(
            myco_json_path(&root, "views", name).unwrap(),
            root.join(".myco/views").join(format!("{name}.json"))
        );
    }

    #[test]
    fn myco_json_round_trip_is_kind_scoped() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        save_myco_json(root, "views", "b", "{}").unwrap();
        save_myco_json(root, "views", "a", "{}").unwrap();
        assert_eq!(list_myco_json(root, "views"), ["a", "b"]);
        assert!(list_myco_json(root, "dashboards").is_empty());
        delete_myco_json(root, "views", "a").unwrap();
        assert_eq!(list_myco_json(root, "views"), ["b"]);
        assert!(delete_myco_json(root, "views", "a").is_err());
    }

    // ---- move_path / favorites ---------------------------------------------

    #[test]
    fn trash_targets_refuses_the_vault_root_without_touching_raw() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("raw")).unwrap();
        std::fs::write(root.join("raw/synthetic.md"), "immutable original\n").unwrap();
        let targets = [root.to_string_lossy().into_owned()];
        let error = super::trash_targets(&root, &targets).expect_err("the vault root contains raw");
        assert!(error.contains("raw/"), "{error}");
        assert_eq!(
            std::fs::read_to_string(root.join("raw/synthetic.md")).unwrap(),
            "immutable original\n"
        );
    }

    #[test]
    fn trash_targets_protects_state_history_and_coalesces_overlapping_targets() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(root.join("notes/note.md"), "synthetic note").unwrap();
        let abs = |rel: &str| root.join(rel).to_string_lossy().into_owned();
        assert!(trash_targets(&root, &[abs("notes/note.md"), abs(".myco")]).is_err());
        assert!(trash_targets(&root, &[abs("notes/note.md"), abs(".git/config")]).is_err());
        assert!(root.join("notes/note.md").exists());
        assert_eq!(
            trash_targets(&root, &[abs("notes/note.md"), abs("notes"), abs("notes")]).unwrap(),
            vec![root.join("notes")]
        );
    }

    #[test]
    fn deletion_confirmation_rejects_a_changed_policy_before_touching_files() {
        crate::settings::test_support::with_isolated_data("delete-policy-confirmation", |_data| {
            let mut settings = crate::settings::Settings::default();
            crate::settings::save(&settings).unwrap();
            let confirmed = settings.permanent_delete;
            settings.permanent_delete = true;
            crate::settings::save(&settings).unwrap();
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().canonicalize().unwrap();
            let file = root.join("synthetic.md");
            std::fs::write(&file, "synthetic note").unwrap();
            let path = file.to_string_lossy().into_owned();
            let single = super::delete_path_at(&root, path.clone(), Some(confirmed)).unwrap_err();
            assert!(single.contains("policy changed"), "{single}");
            let batch = super::confirmed_deletion_targets(
                &root,
                std::slice::from_ref(&path),
                Some(confirmed),
            )
            .unwrap_err();
            assert!(batch.contains("policy changed"), "{batch}");
            assert!(file.exists());
            assert!(
                super::confirmed_deletion_targets(&root, std::slice::from_ref(&path), Some(true))
                    .unwrap()
                    .1
            );
            assert!(
                super::confirmed_deletion_targets(&root, &[path], None)
                    .unwrap()
                    .1
            );

            settings.permanent_delete = false;
            crate::settings::save(&settings).unwrap();
            assert!(
                super::delete_path_at(&root, file.to_string_lossy().into_owned(), Some(true))
                    .is_err()
            );
            assert!(file.exists());
        });
    }

    #[test]
    fn archive_inbox_source_at_refuses_raw_and_preserves_original_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("raw/conversations")).unwrap();
        let source = root.join("raw/conversations/synthetic.md");
        std::fs::write(&source, "immutable source\n").unwrap();
        let error = super::archive_inbox_source_at(&root, &source.to_string_lossy())
            .expect_err("raw originals must never be archived");
        assert!(error.contains("raw/"), "{error}");
        assert_eq!(
            std::fs::read_to_string(&source).unwrap(),
            "immutable source\n"
        );
        assert!(!root.join("raw/conversations/.archived").exists());
    }

    #[test]
    fn archive_inbox_source_at_refuses_notes_and_outside_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.join("wiki")).unwrap();
        for source in [root.join("wiki/note.md"), outside.path().join("note.md")] {
            std::fs::write(&source, "keep original\n").unwrap();
            assert!(super::archive_inbox_source_at(&root, &source.to_string_lossy()).is_err());
            assert_eq!(std::fs::read_to_string(source).unwrap(), "keep original\n");
        }
    }

    #[test]
    fn archive_inbox_source_at_preserves_a_consumed_inbox_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("_inbox")).unwrap();
        let source = root.join("_inbox/synthetic.md");
        std::fs::write(&source, "consumed source\n").unwrap();
        let destination = super::archive_inbox_source_at(&root, &source.to_string_lossy()).unwrap();
        assert_eq!(
            std::path::Path::new(&destination),
            root.join("_inbox/.archived/synthetic.md")
        );
        assert!(!source.exists());
        assert_eq!(
            std::fs::read_to_string(destination).unwrap(),
            "consumed source\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn archive_inbox_source_at_refuses_symlinked_raw_sources_and_destinations() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("raw/conversations")).unwrap();
        std::fs::create_dir_all(root.join("_inbox")).unwrap();
        let original = root.join("raw/conversations/synthetic.md");
        std::fs::write(&original, "immutable source\n").unwrap();
        let alias = root.join("_inbox/alias.md");
        symlink(&original, &alias).unwrap();
        assert!(super::archive_inbox_source_at(&root, &alias.to_string_lossy()).is_err());
        let source = root.join("_inbox/synthetic.md");
        std::fs::write(&source, "new inbox source\n").unwrap();
        symlink(
            root.join("raw/conversations"),
            root.join("_inbox/.archived"),
        )
        .unwrap();
        assert!(super::archive_inbox_source_at(&root, &source.to_string_lossy()).is_err());
        assert_eq!(
            std::fs::read_to_string(source).unwrap(),
            "new inbox source\n"
        );
        assert_eq!(
            std::fs::read_to_string(original).unwrap(),
            "immutable source\n"
        );
    }

    #[test]
    fn move_path_at_refuses_raw_on_either_side() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        for d in ["raw", "wiki", "notes"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        std::fs::write(root.join("raw/a.md"), "src").unwrap();
        std::fs::write(root.join("wiki/a.md"), "note").unwrap();
        let s = |p: &str| root.join(p).display().to_string();

        let err = move_path_at(&root, &s("raw/a.md"), &s("wiki")).expect_err("out of raw/");
        assert!(err.contains("raw/"), "{err}");
        let err = move_path_at(&root, &s("wiki/a.md"), &s("raw")).expect_err("into raw/");
        assert!(err.contains("raw/"), "{err}");
        assert!(root.join("raw/a.md").is_file() && root.join("wiki/a.md").is_file());

        let moved = move_path_at(&root, &s("wiki/a.md"), &s("notes")).unwrap();
        assert_eq!(moved, s("notes/a.md"));
        assert!(root.join("notes/a.md").is_file());
        assert!(!root.join("wiki/a.md").exists());
        let moved_to_root = move_path_at(&root, &s("notes/a.md"), &root.to_string_lossy()).unwrap();
        assert_eq!(moved_to_root, s("a.md"));
        assert_eq!(std::fs::read_to_string(root.join("a.md")).unwrap(), "note");
    }

    #[test]
    fn save_favorites_at_dedups_validates_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let favs: Vec<String> = ["wiki/b.md", "wiki/a.md", "wiki/b.md"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        save_favorites_at(root, &favs).unwrap();
        let raw = std::fs::read_to_string(root.join(".myco/favorites.json")).unwrap();
        let back: Vec<String> = serde_json::from_str(&raw).unwrap();
        assert_eq!(back, ["wiki/b.md", "wiki/a.md"]);

        for bad in ["", "../x.md", "/abs/x.md", "wiki/../x.md", "wiki\\x.md"] {
            let err = save_favorites_at(root, &[bad.to_string()]).expect_err(bad);
            assert!(err.contains("invalid favorite path"), "{bad:?}: {err}");
        }
        // A rejected list leaves the file untouched.
        assert_eq!(
            std::fs::read_to_string(root.join(".myco/favorites.json")).unwrap(),
            raw
        );
    }

    // ---- settings export/import file IO ------------------------------------

    #[test]
    fn settings_export_file_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("myco-settings.json").display().to_string();
        export_bundle_write(None, &path, "{\"schemaVersion\":1}").unwrap();
        assert_eq!(read_settings_import(path).unwrap(), "{\"schemaVersion\":1}");
    }

    #[test]
    fn settings_export_refuses_the_raw_tree_and_non_json_targets() {
        // The save dialog picking the path is a frontend convention, not an
        // enforced property — the command is invokable from the webview.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("raw")).unwrap();
        let into_raw = root.join("raw/attention.json").display().to_string();
        let err =
            export_bundle_write(Some(&root), &into_raw, "{}").expect_err("raw/ must be refused");
        assert!(err.contains("raw/"), "{err}");
        assert!(!root.join("raw/attention.json").exists());

        let not_json = root.join("notes.md").display().to_string();
        assert!(export_bundle_write(Some(&root), &not_json, "{}").is_err());

        // A normal target outside raw/ still works.
        let ok = root.join("bundle.json").display().to_string();
        export_bundle_write(Some(&root), &ok, "{}").unwrap();
        assert!(root.join("bundle.json").is_file());
    }

    #[test]
    fn settings_import_missing_file_errors() {
        let err = read_settings_import("/nonexistent/myco-settings.json".to_string())
            .expect_err("missing file must error, not panic");
        assert!(!err.is_empty());
    }

    // ---- recall miss log (Q4 item 5) ---------------------------------------

    #[test]
    fn append_recall_miss_creates_dirs_and_appends_jsonl() {
        let dir = tempfile::tempdir().unwrap();
        append_recall_miss(dir.path(), "first query", Some("expected-stem")).unwrap();
        append_recall_miss(dir.path(), "second", None).unwrap();
        let raw = std::fs::read_to_string(dir.path().join(".myco/eval/misses.jsonl")).unwrap();
        let lines: Vec<&str> = raw.lines().collect();
        assert_eq!(lines.len(), 2);
        let first: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(first["query"], "first query");
        assert_eq!(first["expected"], "expected-stem");
        assert!(first["at"].as_i64().unwrap() > 0);
        let second: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        assert!(second["expected"].is_null());
    }

    // ---- inbox format unification (Q4 item 20a) ----------------------------

    #[test]
    fn list_inbox_entries_lists_all_extensions_skips_dirs_dotfiles() {
        let dir = tempfile::tempdir().unwrap();
        let inbox = dir.path().join("_inbox");
        std::fs::create_dir_all(inbox.join("quarantine")).unwrap();
        std::fs::write(inbox.join("note.md"), "hello").unwrap();
        std::fs::write(inbox.join("paper.PDF"), b"%PDF-").unwrap();
        std::fs::write(inbox.join("shot.png"), b"png").unwrap();
        std::fs::write(inbox.join(".hidden"), "x").unwrap();

        let entries = inbox_entries(dir.path());
        let mut rows: Vec<(String, String, String)> = entries
            .iter()
            .map(|e| (e.name.clone(), e.rel.clone(), e.ext.clone()))
            .collect();
        rows.sort();
        assert_eq!(
            rows,
            vec![
                ("note.md".into(), "_inbox/note.md".into(), "md".into()),
                ("paper.PDF".into(), "_inbox/paper.PDF".into(), "pdf".into()),
                ("shot.png".into(), "_inbox/shot.png".into(), "png".into()),
            ]
        );
        assert!(entries.iter().all(|e| e.bytes > 0 && e.mtime > 0));
    }

    #[test]
    fn list_inbox_entries_empty_when_inbox_missing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(inbox_entries(dir.path()).is_empty());
    }

    // ---- notch drop → _inbox copy -------------------------------------------

    #[test]
    fn copy_into_inbox_copies_confines_and_never_overwrites() {
        let vault = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let src = outside.path().join("paper.pdf");
        std::fs::write(&src, b"%PDF- dropped").unwrap();
        let src_str = src.display().to_string();

        // A source OUTSIDE the vault is the normal drop, and must work.
        let dest = copy_into_inbox_at(vault.path(), &src_str, "paper.pdf").unwrap();
        assert!(std::path::Path::new(&dest).starts_with(vault.path().join(DEST_INBOX)));
        assert_eq!(std::fs::read(&dest).unwrap(), b"%PDF- dropped");
        // COPY, not move: the user's original stays where it was.
        assert!(src.is_file());

        // Never overwrite — collision-free names are inboxFilename's job.
        let err = copy_into_inbox_at(vault.path(), &src_str, "paper.pdf")
            .expect_err("existing dest must be refused");
        assert!(err.contains("already"), "{err}");

        // Escapes are refused before any IO touches the vault.
        for bad in ["../evil.pdf", "/abs.pdf", "a/../../evil.pdf", ""] {
            assert!(
                copy_into_inbox_at(vault.path(), &src_str, bad).is_err(),
                "{bad:?} must be refused"
            );
        }
        assert!(!vault.path().join("evil.pdf").exists());

        // A missing source errors; a directory is not a file.
        assert!(copy_into_inbox_at(vault.path(), "/nonexistent/x.pdf", "x.pdf").is_err());
        assert!(copy_into_inbox_at(
            vault.path(),
            &outside.path().display().to_string(),
            "dir.pdf"
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn copy_into_inbox_refuses_redirected_inbox_directories() {
        let vault = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let source = outside.path().join("synthetic.md");
        std::fs::write(&source, "synthetic source").unwrap();
        std::os::unix::fs::symlink(outside.path(), vault.path().join(DEST_INBOX)).unwrap();
        assert!(copy_into_inbox_at(vault.path(), &source.to_string_lossy(), "copy.md").is_err());
        assert!(!outside.path().join("copy.md").exists());
    }

    #[test]
    fn expected_vault_refuses_a_switched_root() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        assert!(super::check_expected_vault(first.path(), first.path().to_str()).is_ok());
        assert!(super::check_expected_vault(first.path(), second.path().to_str()).is_err());
    }

    #[test]
    fn media_gets_a_larger_ceiling_than_documents() {
        // The document cap exists because extract.rs will not parse past it;
        // audio never reaches that stage, it goes to whisper. An hour of
        // recorded meeting (~60MB) used to be refused outright.
        assert!(is_media_name("standup.m4a"));
        assert!(
            is_media_name("Demo.MP4"),
            "extension match is case-insensitive"
        );
        assert!(!is_media_name("paper.pdf"));
        assert!(!is_media_name("no-extension"));
        const _: () = assert!(INBOX_COPY_MAX_MEDIA_BYTES > INBOX_COPY_MAX_BYTES);

        let vault = tempfile::tempdir().unwrap();
        let src = vault.path().join("meeting.m4a");
        let f = std::fs::File::create(&src).unwrap();
        f.set_len(INBOX_COPY_MAX_BYTES + 1).unwrap(); // sparse
        drop(f);
        copy_into_inbox_at(vault.path(), &src.display().to_string(), "meeting.m4a")
            .expect("a 25MB+ recording is accepted now that transcription ships");

        // A document of the same size is still refused.
        let doc = vault.path().join("big.pdf");
        let f = std::fs::File::create(&doc).unwrap();
        f.set_len(INBOX_COPY_MAX_BYTES + 1).unwrap();
        drop(f);
        assert!(copy_into_inbox_at(vault.path(), &doc.display().to_string(), "big.pdf").is_err());
    }

    #[test]
    fn copy_into_inbox_refuses_oversized_files() {
        let vault = tempfile::tempdir().unwrap();
        let src = vault.path().join("big.bin");
        // Sparse: set_len allocates no real 25MB on APFS.
        let f = std::fs::File::create(&src).unwrap();
        f.set_len(INBOX_COPY_MAX_BYTES + 1).unwrap();
        drop(f);

        let err = copy_into_inbox_at(vault.path(), &src.display().to_string(), "big.bin")
            .expect_err("oversized file must be refused");
        assert!(err.contains("too large"), "{err}");
        assert!(!vault.path().join("_inbox/big.bin").exists());
    }

    #[test]
    fn write_inbox_note_confines_and_never_overwrites() {
        let vault = tempfile::tempdir().unwrap();
        let dest = write_inbox_note_at(vault.path(), "drop-link.md", "# t\n\nSource: x\n")
            .expect("first write lands");
        assert!(dest.ends_with("drop-link.md"));
        assert_eq!(
            std::fs::read_to_string(vault.path().join("_inbox/drop-link.md")).unwrap(),
            "# t\n\nSource: x\n"
        );
        // Immutable once landed — the driver suffixes -2 instead.
        assert!(write_inbox_note_at(vault.path(), "drop-link.md", "other").is_err());
        // Same escape set as the copy sibling; nothing lands outside _inbox/.
        for bad in ["../evil.md", "/abs.md", "a/../../evil.md", ""] {
            assert!(
                write_inbox_note_at(vault.path(), bad, "x").is_err(),
                "{bad:?} must be refused"
            );
        }
        assert!(!vault.path().join("evil.md").exists());
        // Empty and oversized notes are refused before IO.
        assert!(write_inbox_note_at(vault.path(), "e.md", "  \n").is_err());
        assert!(write_inbox_note_at(vault.path(), "b.md", &"x".repeat(1024 * 1024 + 1)).is_err());
    }

    // ---- vault history (Q4 item 1) -----------------------------------------

    #[test]
    fn human_edit_commit_only_touches_the_named_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("wiki")).unwrap();
        crate::vault_history::init(root).unwrap();
        std::fs::write(root.join("wiki/a.md"), "one").unwrap();
        std::fs::write(root.join("wiki/b.md"), "two").unwrap();

        let made = crate::vault_history::commit_paths(
            root,
            &["wiki/a.md"],
            "edit: a",
            crate::vault_history::CommitIdentity::Human,
        )
        .unwrap();
        assert!(made);

        let out = std::process::Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(root)
            .output()
            .unwrap();
        let porcelain = String::from_utf8_lossy(&out.stdout);
        assert!(
            porcelain.contains("wiki/b.md"),
            "b.md stays uncommitted: {porcelain}"
        );
    }

    // ---- run diff (W3–6 item 6) --------------------------------------------

    #[test]
    fn run_diff_reports_before_and_after() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("wiki")).unwrap();
        std::fs::write(root.join("wiki/a.md"), "v1 line\n").unwrap();
        crate::vault_history::init(root).unwrap();

        std::fs::write(root.join("wiki/a.md"), "v2 line\n").unwrap();
        std::fs::write(root.join("wiki/b.md"), "brand new\n").unwrap();
        assert!(crate::vault_history::commit_paths(
            root,
            &["wiki"],
            "distill: run digest-9",
            crate::vault_history::CommitIdentity::Agent,
        )
        .unwrap());

        let diffs = run_diff_core(root, "digest-9").unwrap();
        assert_eq!(diffs.len(), 2);
        let a = diffs.iter().find(|d| d.path == "wiki/a.md").unwrap();
        assert_eq!(a.status, "modified");
        assert_eq!(a.before.as_deref(), Some("v1 line\n"));
        assert_eq!(a.after.as_deref(), Some("v2 line\n"));
        let b = diffs.iter().find(|d| d.path == "wiki/b.md").unwrap();
        assert_eq!(b.status, "added");
        assert_eq!(b.before, None);
        assert_eq!(b.after.as_deref(), Some("brand new\n"));

        // A run without a commit is a stated error, not an empty list — the
        // UI catches "no-commit" and falls back to the manifest file list.
        assert_eq!(run_diff_core(root, "digest-none").unwrap_err(), "no-commit");

        // Oversized sides are dropped, status kept ("too large to diff").
        std::fs::write(root.join("wiki/big.md"), "x".repeat(300 * 1024)).unwrap();
        assert!(crate::vault_history::commit_paths(
            root,
            &["wiki"],
            "distill: run digest-10",
            crate::vault_history::CommitIdentity::Agent,
        )
        .unwrap());
        let diffs = run_diff_core(root, "digest-10").unwrap();
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].status, "added");
        assert_eq!(diffs[0].after, None);
    }

    // ---- inflow_stats -----------------------------------------------------

    /// Write `path` then force its mtime to `secs` (epoch). Birthtime cannot
    /// be back-dated, which is why the "old file excluded" case is exercised
    /// through sessions/ (mtime-filtered), not _inbox/ (birthtime-filtered).
    fn touch_at(path: &std::path::Path, secs: u64) {
        std::fs::write(path, "x").unwrap();
        let t = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(secs);
        let f = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        f.set_times(std::fs::FileTimes::new().set_modified(t))
            .unwrap();
    }

    #[test]
    fn inflow_counts_todays_files_and_mcp_calls_only() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let old = now - 3 * 86_400;

        let bucket = root.join("sessions").join(super::current_month());
        std::fs::create_dir_all(&bucket).unwrap();
        touch_at(&bucket.join("today.md"), now);
        touch_at(&bucket.join("stale.md"), old);
        // archive/ must never be opened — a today-mtime file there stays out.
        let archive = root.join("sessions").join("archive");
        std::fs::create_dir_all(&archive).unwrap();
        touch_at(&archive.join("archived.md"), now);

        let inbox = root.join("_inbox");
        std::fs::create_dir_all(inbox.join("quarantine")).unwrap();
        touch_at(&inbox.join("clip-today.md"), now);
        touch_at(&inbox.join(".hidden.md"), now);
        touch_at(&inbox.join("quarantine").join("q.md"), now);

        let calls = vec![
            (now, "search".to_string()),
            (now, "search".to_string()),
            (now, "read_page".to_string()),
            (old, "old_tool".to_string()),
        ];
        let stats = super::collect_inflow(root, now, 0, &calls);

        assert_eq!(stats.sessions_today, 1);
        assert_eq!(stats.inbox_today, 1);
        assert_eq!(stats.mcp_calls_today, 3);
        assert_eq!(stats.mcp_top_tool.as_deref(), Some("search"));
        assert_eq!(stats.hourly_files.iter().sum::<u32>(), 2);
        assert_eq!(stats.hourly_mcp.iter().sum::<u32>(), 3);
        let h = super::local_hour(now, 0);
        assert_eq!(stats.hourly_files[h], 2);
        assert_eq!(stats.hourly_mcp[h], 3);
    }

    /// The `_inbox` per-source split comes from frontmatter only: a clipped
    /// page is `clipper`, an imported session is its importer's slug, and a
    /// file with no frontmatter (every doc written before the writers stamped
    /// one, plus hand-dropped notes) counts as `unknown` rather than being
    /// attributed to whoever happens to write most.
    #[test]
    fn inflow_splits_todays_inbox_by_frontmatter_source() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let inbox = root.join("_inbox");
        std::fs::create_dir_all(&inbox).unwrap();
        std::fs::write(
            inbox.join("clip-a.md"),
            "---\nsource: clipper\nurl: \"https://x.com/a\"\n---\n\n# A\n",
        )
        .unwrap();
        std::fs::write(
            inbox.join("clip-b.md"),
            "---\nsource: clipper\n---\n\n# B\n",
        )
        .unwrap();
        std::fs::write(
            inbox.join("session.md"),
            "---\nsource: claude-code\nconversation_id: s1\n---\n\n# S\n",
        )
        .unwrap();
        // Legacy / hand-dropped: no frontmatter at all.
        std::fs::write(inbox.join("legacy.md"), "# Just notes\n").unwrap();
        // Frontmatter without a `source` key is equally unknown.
        std::fs::write(inbox.join("titled.md"), "---\ntitle: T\n---\n\n# T\n").unwrap();

        let stats = super::collect_inflow(root, now, 0, &[]);
        assert_eq!(stats.inbox_today, 5);
        assert_eq!(
            stats.inbox_by_source,
            std::collections::BTreeMap::from([
                ("clipper".to_string(), 2),
                ("claude-code".to_string(), 1),
                ("unknown".to_string(), 2),
            ])
        );
    }

    /// A clip written by the real writer must be classified by the real reader.
    #[test]
    fn a_saved_clip_lands_in_the_clipper_bucket() {
        let dir = tempfile::tempdir().unwrap();
        let clip = crate::clip::Clip {
            title: "Attention: all you need".into(),
            url: Some("https://arxiv.org/abs/1706.03762".into()),
            selection: Some("scaled dot-product".into()),
            note: None,
        };
        crate::clip::save_clip(dir.path(), &clip).unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let stats = super::collect_inflow(dir.path(), now, 0, &[]);
        assert_eq!(stats.inbox_by_source.get("clipper"), Some(&1));
    }

    #[test]
    fn inflow_top_tool_breaks_ties_alphabetically() {
        let dir = tempfile::tempdir().unwrap();
        let now = 1_000_000_000u64;
        let calls = vec![(now, "zeta".to_string()), (now, "alpha".to_string())];
        let stats = super::collect_inflow(dir.path(), now, 0, &calls);
        assert_eq!(stats.mcp_calls_today, 2);
        assert_eq!(stats.mcp_top_tool.as_deref(), Some("alpha"));
    }

    #[test]
    fn inflow_day_rolls_over_at_the_callers_local_midnight() {
        // 16:00 UTC on epoch day 10 is 01:00 the NEXT local day in UTC+9
        // (tz_offset_min = -540, the JS getTimezoneOffset convention).
        let t = 10 * 86_400 + 16 * 3_600;
        assert_eq!(super::local_hour(t, -540), 1);
        assert_eq!(super::local_day_start(t, -540), 10 * 86_400 + 15 * 3_600);
        // 02:00 UTC on day 10 is still 21:00 the PREVIOUS local day in UTC-5.
        let t = 10 * 86_400 + 2 * 3_600;
        assert_eq!(super::local_hour(t, 300), 21);
        assert_eq!(super::local_day_start(t, 300), 9 * 86_400 + 5 * 3_600);
        // A call made "yesterday" local time is excluded from today's count.
        let now = 10 * 86_400 + 16 * 3_600; // 01:00 local, UTC+9
        let yesterday = now - 2 * 3_600; // 23:00 the previous local day
        let dir = tempfile::tempdir().unwrap();
        let stats = super::collect_inflow(
            dir.path(),
            now,
            -540,
            &[(now, "a".to_string()), (yesterday, "a".to_string())],
        );
        assert_eq!(stats.mcp_calls_today, 1);
    }

    #[test]
    fn prev_month_wraps_the_year() {
        assert_eq!(super::prev_month("2026-08"), "2026-07");
        assert_eq!(super::prev_month("2026-01"), "2025-12");
    }

    // Covers the Critical fix: BM25 must be upserted even when the DENSE
    // side is already current, or `.mxb` never bootstraps on a vault whose
    // `.mxv` is already up to date (every real vault after its first index).
    // Before the fix, the skip was gated on the dense side alone and
    // returned before ever touching `bm25` — this test fails against that
    // version (the page would not be in `bm25` at all after the call).
    #[test]
    fn sync_bm25_upserts_a_page_bm25_is_missing_even_when_dense_is_current() {
        let content = "# Attention\ntransformers use self attention to weigh tokens";
        let hashes: Vec<u64> = crate::embeddings::chunk_page(content)
            .iter()
            .map(|c| crate::embeddings::content_hash(c))
            .collect();
        let mut existing = HashMap::new();
        existing.insert("wiki/attention.md".to_string(), hashes); // dense already current
        let bm25_pages = HashSet::new(); // bm25 has never seen this page

        let mut bm25 = Bm25Index::new();
        let outcome = sync_bm25_for_page(
            content,
            "wiki/attention.md",
            "attention",
            &existing,
            &mut bm25,
            &bm25_pages,
        );

        let sync = outcome.expect("bm25 missing the page must still signal an update");
        assert!(
            sync.dense_current,
            "dense side was already current; only bm25 needed catching up"
        );
        assert!(
            bm25.search("self attention tokens", 10)
                .iter()
                .any(|h| h.page == "wiki/attention.md"),
            "the page must be searchable in bm25 immediately after sync_bm25_for_page"
        );
    }

    #[test]
    fn sync_bm25_skips_when_both_indexes_are_already_current() {
        let content = "# Attention\ntransformers use self attention to weigh tokens";
        let hashes: Vec<u64> = crate::embeddings::chunk_page(content)
            .iter()
            .map(|c| crate::embeddings::content_hash(c))
            .collect();
        let mut existing = HashMap::new();
        existing.insert("wiki/attention.md".to_string(), hashes);
        let mut bm25_pages = HashSet::new();
        bm25_pages.insert("wiki/attention.md".to_string()); // bm25 already has it too

        let mut bm25 = Bm25Index::new();
        let chunks = crate::embeddings::chunk_page(content);
        bm25.upsert_page("wiki/attention.md", "attention", &chunks);
        let before = bm25.page_hashes("wiki/attention.md");
        let outcome = sync_bm25_for_page(
            content,
            "wiki/attention.md",
            "attention",
            &existing,
            &mut bm25,
            &bm25_pages,
        );

        assert!(
            outcome.is_none(),
            "both sides already current: nothing to do, no wasted embed"
        );
        assert!(
            bm25.page_hashes("wiki/attention.md") == before,
            "must preserve the current bm25 chunks in the both-current case"
        );
    }

    // ---- the ingest-lag fix ------------------------------------------------
    // `embed_one_page` itself needs a live AppHandle and a loaded embed model,
    // so what is tested here is the decision it delegates to:
    // `chunks_needing_embed` (which chunks actually reach `embed_texts`) and
    // `sync_bm25_for_page`'s full-page coverage. The wiring between them —
    // reuse-by-hash from `VectorStore::page_vectors`, records rebuilt in chunk
    // order — is verified by inspection only.

    /// Chunk hashes for a page, exactly as `sync_bm25_for_page` computes them.
    fn hashes_of(content: &str) -> Vec<u64> {
        let chunks = crate::embeddings::chunk_page(content);
        chunks
            .iter()
            .map(|c| crate::embeddings::content_hash(c))
            .collect()
    }

    #[test]
    fn appending_to_a_page_embeds_only_the_new_chunks() {
        // The bug: an ingest agent appends one entry to an 831-chunk session
        // mirror and the old code re-embedded all 831 (8–40 s of local
        // inference, restarted by the next append). Only the appended chunks
        // may reach the embedder.
        let before =
            "# log\n\n".to_string() + &"an earlier entry in the transcript\n\n".repeat(400);
        let after = before.clone() + "a brand new entry the agent just appended\n";

        let old = hashes_of(&before);
        let new = hashes_of(&after);
        assert!(old.len() > 1, "fixture must be a multi-chunk page");

        let todo = chunks_needing_embed(&old, &new);
        assert!(
            todo.len() <= 2,
            "an append must re-embed only the tail chunk(s), got {} of {}",
            todo.len(),
            new.len()
        );
        // And every index it names is a real chunk of the new page.
        assert!(todo.iter().all(|&i| i < new.len()));
        // Everything it did NOT name is reusable, i.e. already in the index.
        let have: HashSet<u64> = old.iter().copied().collect();
        for (i, h) in new.iter().enumerate() {
            if !todo.contains(&i) {
                assert!(have.contains(h), "chunk {i} was skipped but is not stored");
            }
        }
    }

    #[test]
    fn an_unchanged_page_embeds_nothing() {
        let content = "# Attention\n\ntransformers use self attention to weigh tokens\n";
        let hashes = hashes_of(content);
        assert!(chunks_needing_embed(&hashes, &hashes).is_empty());
        // A pure reorder is free too: same texts, no new vectors needed.
        let mut reordered = hashes.clone();
        reordered.reverse();
        assert!(chunks_needing_embed(&hashes, &reordered).is_empty());
    }

    #[test]
    fn a_first_index_embeds_every_chunk() {
        let hashes = hashes_of("# A\n\nalpha body\n\n# B\n\nbeta body\n");
        assert_eq!(
            chunks_needing_embed(&[], &hashes),
            (0..hashes.len()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn a_long_page_keeps_lexical_tail_and_every_dense_job() {
        let huge: String = (0..300)
            .map(|i| format!("# entry {i}\ntranscript paragraph ID_{i:04}\n\n"))
            .collect();
        let mut bm25 = Bm25Index::new();
        let sync = sync_bm25_for_page(
            &huge,
            "sessions/2026-08/log.md",
            "log",
            &HashMap::new(),
            &mut bm25,
            &HashSet::new(),
        )
        .unwrap();
        assert_eq!(sync.chunks.len(), 300);
        assert_eq!(chunks_needing_embed(&[], &sync.hashes).len(), 300);
        assert!(bm25.search("ID_0299", 10).iter().any(|h| h.section == 299));
    }

    #[test]
    fn empty_edit_removes_old_lexical_entries_and_requires_dense_removal() {
        let mut bm25 = Bm25Index::new();
        bm25.upsert_page("wiki/a.md", "a", &["alpha body".into()]);
        let old = HashMap::from([(
            "wiki/a.md".into(),
            vec![crate::embeddings::content_hash("alpha body")],
        )]);
        let sync = sync_bm25_for_page(
            "",
            "wiki/a.md",
            "a",
            &old,
            &mut bm25,
            &HashSet::from(["wiki/a.md".into()]),
        )
        .unwrap();
        assert!(sync.chunks.is_empty() && !sync.dense_current);
        assert!(bm25.search("alpha", 10).is_empty());
    }

    #[test]
    fn chunk_text_at_indexes_sections() {
        // chunk_page splits on ATX headings; two sections here.
        let md = "# A\nalpha body text\n\n# B\nbeta body text\n";
        assert_eq!(
            chunk_text_at(md, 0).as_deref(),
            Some("# A\nalpha body text")
        );
        assert!(chunk_text_at(md, 1).unwrap().contains("beta"));
        assert_eq!(chunk_text_at(md, 9), None); // out of range → None (page changed since index)
    }

    // A Claude Code session line (parses to one conversation via the importer).
    // `text` is repeated so the spoken length clears the importer's substance
    // filter — a one-line fixture now reads as the `ping` noise that filter
    // drops, which is not what these tests are about.
    fn session_line(id: &str, text: &str) -> String {
        // Repeat by LENGTH, not a fixed count: a short seed times 60 still
        // lands under the floor, which is how these fixtures silently became
        // "noise" again.
        let text = format!("{text} ").repeat(1000 / (text.len() + 1) + 2);
        format!(
            "{{\"type\":\"user\",\"sessionId\":\"{id}\",\"message\":{{\"role\":\"user\",\"content\":\"{text}\"}}}}"
        )
    }

    #[test]
    fn run_import_counts_imported_failed_and_writes_inbox() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let sessions = root.join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();

        let good1 = sessions.join("a.jsonl");
        std::fs::write(&good1, session_line("s1", "how does attention work")).unwrap();
        let good2 = sessions.join("b.jsonl");
        std::fs::write(&good2, session_line("s2", "explain embeddings")).unwrap();
        let missing = sessions.join("gone.jsonl"); // never created → a read failure

        let mut progress = Vec::new();
        let files: Vec<PathBuf> = vec![good1, missing.clone(), good2];
        let outcome = run_import(root, &files, DEST_INBOX, |p| progress.push(p));

        assert_eq!(outcome.imported, 2);
        assert_eq!(outcome.failed.len(), 1);
        assert_eq!(outcome.failed[0].path, missing.to_string_lossy());
        assert!(outcome.failed[0].error.contains("cannot read"));
        assert_eq!(outcome.source, "claude-code");
        // Two inbox docs written.
        let inbox = root.join("_inbox");
        let n = std::fs::read_dir(&inbox)
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .path()
                    .extension()
                    .map(|x| x == "md")
                    .unwrap_or(false)
            })
            .count();
        assert_eq!(n, 2);
        // Progress reported, ending at done == total.
        assert!(!progress.is_empty());
        let last = progress.last().unwrap();
        assert_eq!(last.done, 3);
        assert_eq!(last.total, 3);
        assert_eq!(last.imported, 2);
        assert_eq!(last.failed, 1);
    }

    #[test]
    fn a_swept_session_lands_in_sessions_not_the_ingest_queue() {
        // _inbox/ books a paid ingest per file. A session sweep is not a request
        // for that, and defaulting the sweep ON while it wrote there is what
        // queued 1,690 unwanted runs.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let f = root.join("a.jsonl");
        std::fs::write(&f, session_line("s1", "why we chose the cosine floor")).unwrap();

        let out = run_import(root, &[f], DEST_SESSIONS, |_| {});
        assert_eq!(out.imported, 1);
        assert!(!root.join("_inbox").exists(), "must not queue an ingest");

        // Under sessions/, and inside a YYYY-MM bucket rather than loose at the
        // top level — a flat archive had grown to 1,029 siblings.
        let mut found = None;
        for bucket in std::fs::read_dir(root.join("sessions")).unwrap().flatten() {
            let name = bucket.file_name().to_string_lossy().into_owned();
            if bucket.path().is_dir() && name.len() == 7 && name.as_bytes()[4] == b'-' {
                let f = bucket.path().join("claude-code-s1.md");
                if f.is_file() {
                    found = Some(name);
                }
            }
        }
        assert!(found.is_some(), "session was not filed into a month bucket");
        assert!(
            !root.join("sessions/claude-code-s1.md").exists(),
            "nothing should be left loose at the archive root"
        );
    }

    #[test]
    fn import_dest_refuses_anything_but_the_two_known_dirs() {
        // `dest` is joined onto the vault root, so it is a path segment: a
        // caller-supplied value has to be refused, not sanitized.
        assert_eq!(import_dest("_inbox"), Ok(DEST_INBOX));
        assert_eq!(import_dest("sessions"), Ok(DEST_SESSIONS));
        assert!(import_dest("../../etc").is_err());
        assert!(import_dest("wiki").is_err());
        assert!(import_dest("").is_err());
    }

    #[test]
    fn run_import_dedups_on_a_second_run() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let f = root.join("a.jsonl");
        std::fs::write(&f, session_line("s1", "hello there")).unwrap();
        let files = vec![f];

        let first = run_import(root, &files, DEST_INBOX, |_| {});
        assert_eq!(first.imported, 1);
        assert_eq!(first.skipped, 0);
        // Same files again: unchanged, so the file is skipped without a re-read
        // and its one conversation counts as already imported.
        let second = run_import(root, &files, DEST_INBOX, |_| {});
        assert_eq!(second.imported, 0);
        assert_eq!(second.skipped, 1);
    }

    #[test]
    fn run_import_reprocesses_a_changed_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let f = root.join("a.jsonl");
        std::fs::write(&f, session_line("s1", "hello")).unwrap();
        let files = vec![f.clone()];

        let first = run_import(root, &files, DEST_INBOX, |_| {});
        assert_eq!(first.imported, 1);

        // The session grew (different length → the stamp no longer matches even
        // if the mtime clock is coarse): it must be read again and re-imported
        // as an update, not skipped.
        std::fs::write(
            &f,
            session_line("s1", "hello there, a much longer continuation"),
        )
        .unwrap();
        let second = run_import(root, &files, DEST_INBOX, |_| {});
        assert_eq!(second.imported, 1, "a changed session must re-import");
        assert_eq!(second.skipped, 0);
    }

    #[test]
    fn run_import_throttles_progress_events() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut files = Vec::new();
        for i in 0..100 {
            let f = root.join(format!("s{i}.jsonl"));
            std::fs::write(&f, session_line(&format!("s{i}"), "hi")).unwrap();
            files.push(f);
        }
        let mut count = 0usize;
        let _ = run_import(root, &files, DEST_INBOX, |_| count += 1);
        // 100 files, emit on i%32==0 (0,32,64,96) plus the final (99) → far fewer
        // than 100, and the last is always sent.
        assert!(count < 100, "expected throttling, got {count}");
        assert!(count >= 4);
    }

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
    fn windows_opener_rejects_cmd_metacharacters() {
        // The scheme allow-list passes every one of these — the scheme really is
        // https — so this is the only thing standing between a link in a note
        // and cmd.exe running the tail of it.
        assert!(!windows_opener_safe("https://ok.com/&calc"));
        assert!(!windows_opener_safe("https://ok.com/|calc"));
        assert!(!windows_opener_safe("https://ok.com/>out.txt"));
        assert!(!windows_opener_safe("https://ok.com/<in.txt"));
        assert!(!windows_opener_safe("https://ok.com/^calc"));
        assert!(!windows_opener_safe(r#"https://ok.com/"&calc"#));
        assert!(!windows_opener_safe("https://ok.com/%PATH%"));
        assert!(!windows_opener_safe("https://ok.com/(calc)"));
        assert!(!windows_opener_safe("https://ok.com/\ncalc"));
        assert!(!windows_opener_safe("https://ok.com/\rcalc"));
    }

    #[test]
    fn windows_opener_allows_ordinary_targets() {
        assert!(windows_opener_safe("https://example.com"));
        assert!(windows_opener_safe("https://example.com/a/b?x=1"));
        assert!(windows_opener_safe("mailto:user@example.com"));
        assert!(windows_opener_safe(r"C:\Users\me\notes.md"));
        // Percent-encoded metacharacters are inert to cmd — but '%' itself is
        // cmd's expansion sigil, so they are refused rather than decoded here.
        assert!(!windows_opener_safe("https://example.com/a%20b"));
    }

    #[test]
    fn treats_local_paths_as_not_url_allowed() {
        // Plain paths and Windows drive letters are not URL-allowed; the caller
        // validates them as filesystem paths instead.
        assert!(!external_target_allowed("/usr/local/bin"));
        assert!(!external_target_allowed("relative/path"));
        assert!(!external_target_allowed(r"C:\Users\me\file.txt"));
    }

    #[test]
    fn builtin_index_is_stale_only_accepts_the_bundled_model() {
        // A store tagged with a model a swap retired must report stale —
        // `wikify_candidates` degrades to Ok(empty) for this, rather than
        // propagating embed_texts's "unknown builtin embed model" error.
        // Both retired ids: gemma-3-1b (pre-bge-m3) and bge-m3 itself, which
        // the 2026-08 e5-small-ko bake-off retired.
        assert!(builtin_index_is_stale("builtin-local", "gemma-3-1b"));
        assert!(builtin_index_is_stale("builtin-local", "bge-m3"));
        // Whatever is bundled NOW is not stale — read the constant rather than
        // pinning a literal, so the next swap does not silently invalidate this.
        assert!(!builtin_index_is_stale(
            "builtin-local",
            crate::local_llm::BUILTIN_EMBED_MODEL
        ));
        // A known-but-unbundled EmbedSpec id (a bake-off candidate the app
        // doesn't currently ship) must ALSO report stale: pre-fix, this used
        // to pass as "fresh" because `embed_spec_by_id` resolved it, which
        // would let `wikify_candidates` proceed into `embed_texts` and hard-
        // error ("bundled embed model not found") once a second model is
        // bundled and this one no longer is. Staleness must track "is this
        // the model we bundle right now", not "is this id known at all".
        assert!(builtin_index_is_stale("builtin-local", "e5-large"));
        // A model id an ollama-provider index carries is never a builtin
        // `EmbedSpec` id, but embed_texts routes "ollama" straight to Ollama
        // without ever consulting EMBED_SPECS — never "stale" here.
        assert!(!builtin_index_is_stale("ollama", "nomic-embed-text"));
    }

    // Pins `semantic_search`'s graceful-degrade contract (Task 6): when the
    // BM25 side is empty (fresh vault, or `.mxb` not yet bootstrapped),
    // fusing must not change the dense order. This exercises the exact glue
    // `semantic_search` runs — `Bm25Cache::get` on a path with no file on
    // disk, then `Bm25Index::search`, then `rrf_fuse` — rather than
    // `semantic_search` itself, which needs a live `AppHandle` and embedding
    // model and so isn't unit-testable here (no existing test in this file
    // calls an async Tauri command directly; `rrf_fuse`'s own degrade
    // behavior is covered separately in `retrieval.rs`).
    #[test]
    fn semantic_search_glue_degrades_to_dense_order_when_bm25_is_empty() {
        let dense = vec![
            Hit {
                page: "b.md".into(),
                stem: "b".into(),
                section: 0,
                score: 0.9,
            },
            Hit {
                page: "a.md".into(),
                stem: "a".into(),
                section: 0,
                score: 0.5,
            },
            Hit {
                page: "c.md".into(),
                stem: "c".into(),
                section: 1,
                score: 0.1,
            },
        ];
        let cache = Bm25Cache::default();
        // No `.mxb` was ever written at this path — same state a fresh vault
        // (or one mid-bootstrap) is in when `semantic_search` runs.
        let bm25_path = PathBuf::from("/nonexistent/does-not-exist.mxb");
        let bm25 = cache.get(&bm25_path);
        assert!(
            bm25.is_empty(),
            "cache must not fabricate content for a missing file"
        );
        let lexical = bm25.search("self attention tokens", 50);
        assert!(lexical.is_empty());

        // Same two steps, same order as `semantic_search`: fuse wide, then cap.
        let fused = rrf_fuse(&dense, &lexical, dense.len());
        let capped = crate::retrieval::cap_per_page(fused, 2, dense.len());
        let fused_pages: Vec<&str> = capped.iter().map(|h| h.page.as_str()).collect();
        let dense_pages: Vec<&str> = dense.iter().map(|h| h.page.as_str()).collect();
        assert_eq!(
            fused_pages, dense_pages,
            "empty BM25 arm must not reorder the dense hits"
        );
    }

    fn hybrid_hit(page: &str, score: f32, similarity: Option<f32>) -> HybridHit {
        HybridHit {
            page: page.into(),
            stem: page.into(),
            section: 0,
            line: 1,
            text: "body".into(),
            score,
            score_rrf: score,
            tier: crate::retrieval::source_tier(page),
            prior: 1.0,
            rank_change: 0,
            similarity,
            exact_match: similarity.is_none(),
            bm25: None,
        }
    }

    // The Ask response splits at the floor: hits that clear it (or have no
    // cosine at all) stay in final order; the rest become at most four
    // near-misses, best cosine first, and the floor used is reported.
    #[test]
    fn ask_response_splits_at_the_floor_and_keeps_four_near_misses() {
        let floor = crate::retrieval::RELEVANCE_FLOOR;
        let hits = vec![
            hybrid_hit("wiki/a.md", 0.0328, Some(0.61)),
            hybrid_hit("wiki/b.md", 0.0320, Some(floor - 0.05)),
            hybrid_hit("sessions/2026-08/c.md", 0.0190, None),
            hybrid_hit("wiki/d.md", 0.0180, Some(floor)),
            hybrid_hit("daily/2026-08-21.md", 0.0170, Some(floor - 0.01)),
            hybrid_hit("wiki/e.md", 0.0160, Some(0.30)),
            hybrid_hit("wiki/f.md", 0.0150, Some(0.20)),
            hybrid_hit("wiki/g.md", 0.0140, Some(0.10)),
        ];
        let out = ask_response(hits);
        assert_eq!(out.floor, floor);
        assert_eq!(
            out.hits.iter().map(|h| h.page.as_str()).collect::<Vec<_>>(),
            vec!["wiki/a.md", "sessions/2026-08/c.md", "wiki/d.md"],
            "lexical-only (no cosine) and exactly-at-floor hits stay"
        );
        assert_eq!(out.hits[1].tier, crate::retrieval::Tier::Session);
        assert_eq!(out.hits[0].score_final, out.hits[0].score);
        assert_eq!(
            out.below_floor
                .iter()
                .map(|m| m.page.as_str())
                .collect::<Vec<_>>(),
            vec!["daily/2026-08-21.md", "wiki/b.md", "wiki/e.md", "wiki/f.md"],
            "best cosine first, capped at four"
        );
        assert_eq!(out.below_floor[0].tier, crate::retrieval::Tier::Digest);
        assert_eq!(out.below_floor[0].similarity, Some(floor - 0.01));
        // Wire shape: snake_case keys, tier as its lowercase name.
        let json = serde_json::to_value(&out).unwrap();
        assert_eq!(json["hits"][0]["tier"], "note");
        assert!(json["hits"][0]["score_rrf"].is_number());
        assert!(json["hits"][0]["score_final"].is_number());
        assert!(json["hits"][0]["rank_change"].is_number());
        assert!(json["hits"][0]["prior"].is_number());
        assert!(json["below_floor"][0]["score_final"].is_number());
        assert!(json["floor"].is_number());

        let empty = ask_response(Vec::new());
        assert!(empty.hits.is_empty() && empty.below_floor.is_empty());
        assert_eq!(empty.floor, floor);
    }

    // The per-page cap must not cost a distinct-page result its slot: with one
    // hit per page there is nothing to cap, and the whole list has to survive.
    // Guards against a future cap that counts slots instead of pages.
    #[test]
    fn page_cap_leaves_an_all_distinct_result_untouched() {
        let dense: Vec<Hit> = ["a.md", "b.md", "c.md", "d.md"]
            .iter()
            .enumerate()
            .map(|(i, p)| Hit {
                page: (*p).into(),
                stem: (*p).into(),
                section: 0,
                score: 1.0 - i as f32 * 0.1,
            })
            .collect();
        let fused = rrf_fuse(&dense, &[], dense.len());
        let capped = crate::retrieval::cap_per_page(fused, 2, dense.len());
        assert_eq!(
            capped.iter().map(|h| h.page.as_str()).collect::<Vec<_>>(),
            vec!["a.md", "b.md", "c.md", "d.md"],
        );
    }

    // ---- Ask date-range filter (Q4 item 8) ---------------------------------

    fn dr(start: &str, end: &str) -> DateRange {
        DateRange {
            start: start.into(),
            end: end.into(),
            start_epoch: None,
            end_epoch: None,
        }
    }

    #[test]
    fn session_local_midnight_uses_epoch_bounds() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = crate::vector_index::VectorStore::default();
        let mut bm25 = Bm25Index::new();
        let body = "---\nturn_metadata: [{\"timestamp\":\"2026-08-22T00:30:00+09:00\"}]\n---\n\n# Session\n\n**User:**\n\nLOCAL_MIDNIGHT_ID decision\n";
        indexed_page(
            dir.path(),
            &mut store,
            &mut bm25,
            "sessions/2026-08/local.md",
            body,
            vec![1.0, 0.0],
        );
        let mut range = dr("2026-08-22", "2026-08-22");
        range.start_epoch = crate::importers::parse_iso8601("2026-08-22T00:00:00+09:00");
        range.end_epoch = crate::importers::parse_iso8601("2026-08-23T00:00:00+09:00");
        assert_eq!(
            ranked(
                dir.path(),
                &store,
                &bm25,
                "LOCAL_MIDNIGHT_ID",
                5,
                Some(&range)
            )
            .len(),
            1
        );
        let mut yesterday = dr("2026-08-21", "2026-08-21");
        yesterday.start_epoch = crate::importers::parse_iso8601("2026-08-21T00:00:00+09:00");
        yesterday.end_epoch = range.start_epoch;
        assert!(ranked(
            dir.path(),
            &store,
            &bm25,
            "LOCAL_MIDNIGHT_ID",
            5,
            Some(&yesterday)
        )
        .is_empty());
    }

    #[test]
    fn session_all_imported_roles_preserve_local_event_dates() {
        let observations = [
            (
                "system",
                "SYSTEM_EVENT",
                "2026-10-01T14:30:00Z",
                "2026-10-01",
            ),
            ("user", "USER_EVENT", "2026-10-01T15:30:00Z", "2026-10-02"),
            ("tool", "TOOL_EVENT", "2026-10-02T15:30:00Z", "2026-10-03"),
            (
                "assistant",
                "ASSISTANT_EVENT",
                "2026-10-03T15:30:00Z",
                "2026-10-04",
            ),
        ];
        let mapping: serde_json::Map<String, serde_json::Value> = observations
            .iter()
            .enumerate()
            .map(|(index, (role, event, timestamp, _))| {
                (
                    format!("node-{index}"),
                    serde_json::json!({
                        "parent": index.checked_sub(1).map(|parent| format!("node-{parent}")),
                        "message": {
                            "id": format!("message-{index}"),
                            "author": {"role": role},
                            "create_time": crate::importers::parse_iso8601(timestamp).unwrap(),
                            "content": {"parts": [format!("{event} decision")]}
                        }
                    }),
                )
            })
            .collect();
        let export = serde_json::json!([{
            "conversation_id": "synthetic-multi-role-session",
            "title": "Synthetic event dates",
            "current_node": "node-3",
            "mapping": mapping
        }]);
        let conversation = crate::importers::chatgpt::parse(&export.to_string())
            .unwrap()
            .remove(0);
        let body = conversation.to_inbox_doc();
        let dir = tempfile::tempdir().unwrap();
        let mut store = crate::vector_index::VectorStore::default();
        let mut bm25 = Bm25Index::new();
        indexed_page(
            dir.path(),
            &mut store,
            &mut bm25,
            "sessions/2026-10/multi-role.md",
            &body,
            vec![1.0, 0.0],
        );
        for (_, event, timestamp, day) in observations {
            let mut range = dr(day, day);
            let local_start = crate::importers::parse_iso8601(&format!("{day}T00:00:00+09:00"));
            range.start_epoch = local_start;
            range.end_epoch = local_start.map(|start| start + 86_400);
            let hits = ranked(dir.path(), &store, &bm25, "decision", 8, Some(&range));
            assert_eq!(hits.len(), 1, "{event} at {timestamp} belongs to {day}");
            assert!(hits[0].text.contains(event), "{event}: {}", hits[0].text);
            assert_eq!(hits[0].text.matches("_EVENT").count(), 1);
        }
    }

    #[test]
    fn session_unknown_tool_timestamp_does_not_borrow_user_date() {
        let body = "---\nturn_metadata: [{\"timestamp\":\"2026-10-03T00:00:00Z\"},{},{\"timestamp\":\"2026-10-04T00:00:00Z\"}]\n---\n\n# Session\n\n**User:**\n\nUSER_EVENT decision\n\n**Tool:**\n\nUNKNOWN_TOOL_EVENT decision\n\n**Assistant:**\n\nASSISTANT_EVENT decision\n";
        let chunks = crate::embeddings::chunk_page(body);
        let range = dr("2026-10-03", "2026-10-03");
        let section = chunks
            .iter()
            .position(|chunk| chunk.contains("UNKNOWN_TOOL_EVENT"))
            .expect("tool evidence must remain in the transcript");
        assert!(!super::chunk_in_date_range(
            "sessions/2026-10/unknown-tool.md",
            body,
            &chunks,
            section,
            &range,
        ));
    }

    #[test]
    fn session_role_header_collision_does_not_shift_event_dates() {
        let body = "---\nturn_metadata: [{\"timestamp\":\"2026-10-01T12:00:00Z\"},{\"timestamp\":\"2026-10-02T12:00:00Z\"}]\n---\n\n# Synthetic collision\n\n**User:**\n\nA literal example follows.\n\n```text\n**Tool:**\n\nSYNTHETIC_HEADER_COLLISION decision\n```\n\n**Assistant:**\n\nActual assistant response.\n";
        let chunks = crate::embeddings::chunk_page(body);
        let range = dr("2026-10-02", "2026-10-02");
        assert!((0..chunks.len()).all(|section| !super::chunk_in_date_range(
            "sessions/2026-10/collision.md",
            body,
            &chunks,
            section,
            &range,
        )));
    }

    #[test]
    fn session_exact_end_and_invalid_epoch_bounds_stay_outside() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = crate::vector_index::VectorStore::default();
        let mut bm25 = Bm25Index::new();
        let body = "---\nturn_metadata: [{\"timestamp\":\"2026-08-22T00:00:00Z\"}]\n---\n\n# Session\n\n**User:**\n\nEXCLUSIVE_END_ID decision\n";
        indexed_page(
            dir.path(),
            &mut store,
            &mut bm25,
            "sessions/2026-08/end.md",
            body,
            vec![1.0, 0.0],
        );
        let timestamp = crate::importers::parse_iso8601("2026-08-22T00:00:00Z").unwrap();
        for (start, end) in [
            (Some(timestamp - 3600), Some(timestamp)),
            (Some(timestamp), None),
            (None, Some(timestamp + 3600)),
            (Some(timestamp + 3600), Some(timestamp)),
        ] {
            let mut range = dr("2026-08-22", "2026-08-22");
            range.start_epoch = start;
            range.end_epoch = end;
            assert!(ranked(
                dir.path(),
                &store,
                &bm25,
                "EXCLUSIVE_END_ID",
                5,
                Some(&range)
            )
            .is_empty());
        }
    }

    #[test]
    fn session_unknown_metadata_never_uses_legacy_month_fallback() {
        for metadata in ["[]", "null", "\"unknown\""] {
            let dir = tempfile::tempdir().unwrap();
            let mut store = crate::vector_index::VectorStore::default();
            let mut bm25 = Bm25Index::new();
            let body = format!("---\nturn_metadata: {metadata}\n---\n\n# Session\n\n**User:**\n\nUNKNOWN_DATE_ID decision\n");
            indexed_page(
                dir.path(),
                &mut store,
                &mut bm25,
                "sessions/2026-08/unknown.md",
                &body,
                vec![1.0, 0.0],
            );
            assert!(ranked(
                dir.path(),
                &store,
                &bm25,
                "UNKNOWN_DATE_ID",
                5,
                Some(&dr("2026-08-22", "2026-08-22"))
            )
            .is_empty());
        }
    }

    #[test]
    fn iso_week_monday_uses_the_jan4_anchor_and_rejects_fake_weeks() {
        // 2026-01-01 is a Thursday, so W01's Monday reaches back into 2025.
        assert_eq!(iso_week_monday("2026-W01"), Some((2025, 12, 29)));
        assert_eq!(iso_week_monday("2026-W34"), Some((2026, 8, 17)));
        // 2026 has a W53 (Jan 1 is a Thursday); its Monday is late December.
        assert_eq!(iso_week_monday("2026-W53"), Some((2026, 12, 28)));
        // 2025 has no W53 — the arithmetic lands on 2026-W01's Monday, so the
        // week name was never real.
        assert_eq!(iso_week_monday("2025-W53"), None);
        assert_eq!(iso_week_monday("2026-W00"), None);
        assert_eq!(iso_week_monday("2026-W60"), None);
        assert_eq!(iso_week_monday("2026-34"), None);
        assert_eq!(iso_week_monday("garbage"), None);
    }

    #[test]
    fn page_in_date_range_covers_the_dated_tiers_only() {
        let r = dr("2026-08-17", "2026-08-22");
        // daily/: exact day, inclusive on both ends.
        assert!(page_in_date_range("daily/2026-08-19.md", &r));
        assert!(page_in_date_range("daily/2026-08-17.md", &r));
        assert!(page_in_date_range("daily/2026-08-22.md", &r));
        assert!(!page_in_date_range("daily/2026-08-16.md", &r));
        // sessions/: month granularity — a month straddling a range boundary
        // still counts on both sides of it.
        assert!(page_in_date_range("sessions/2026-08/codex-019fdc04.md", &r));
        let straddle = dr("2026-07-28", "2026-08-02");
        assert!(page_in_date_range("sessions/2026-08/x.md", &straddle));
        assert!(page_in_date_range("sessions/2026-07/x.md", &straddle));
        assert!(!page_in_date_range("sessions/2026-06/x.md", &straddle));
        // weekly/: 2026-W34 spans Mon 08-17..Sun 08-23 — any overlap counts.
        assert!(page_in_date_range(
            "weekly/2026-W34.md",
            &dr("2026-08-20", "2026-08-22")
        ));
        assert!(page_in_date_range(
            "weekly/2026-W34.md",
            &dr("2026-08-23", "2026-08-30")
        ));
        assert!(!page_in_date_range(
            "weekly/2026-W34.md",
            &dr("2026-08-24", "2026-08-30")
        ));
        // weekly year boundary: 2026-W01 spans 2025-12-29..2026-01-04.
        assert!(page_in_date_range(
            "weekly/2026-W01.md",
            &dr("2025-12-30", "2025-12-31")
        ));
        // monthly/: month overlap, same rule as sessions.
        assert!(page_in_date_range("monthly/2026-08.md", &r));
        assert!(!page_in_date_range("monthly/2026-07.md", &r));
        // Undated pages are out while a range is active.
        assert!(!page_in_date_range("wiki/attention.md", &r));
        assert!(!page_in_date_range("raw/paper.pdf.md", &r));
        // Malformed or archived rels never pass. `2026-08-2` is the string-
        // compare trap: lexicographically inside the range, not a real day.
        assert!(!page_in_date_range("daily/2026-08-2.md", &r));
        assert!(!page_in_date_range(
            "daily/2026-02-31.md",
            &dr("2026-02-01", "2026-03-01")
        ));
        assert!(!page_in_date_range(
            "daily/archive/2026-W34/2026-08-19.md",
            &r
        ));
        assert!(!page_in_date_range("sessions/archive/2026-08/x.md", &r));
    }

    fn scored(page: &str, score: f32) -> Hit {
        Hit {
            page: page.into(),
            stem: String::new(),
            section: 0,
            score,
        }
    }

    #[test]
    fn recency_tie_break_reorders_only_score_ties_newest_first() {
        let mut hits = vec![
            scored("daily/2026-08-18.md", 0.9),
            scored("daily/2026-08-20.md", 0.9), // exact tie → newer day first
            scored("weekly/2026-W34.md", 0.9),  // tie; derives Monday 08-17 → last of the run
            scored("daily/2026-08-21.md", 0.5), // newest page but NOT tied — must not climb
            scored("wiki/attention.md", 0.5),   // tied and undated → back of its run
            scored("sessions/2026-08/x.md", 0.5), // month date sorts before any full 08 day
        ];
        recency_tie_break(&mut hits);
        let order: Vec<&str> = hits.iter().map(|h| h.page.as_str()).collect();
        assert_eq!(
            order,
            vec![
                "daily/2026-08-20.md",
                "daily/2026-08-18.md",
                "weekly/2026-W34.md",
                "daily/2026-08-21.md",
                "sessions/2026-08/x.md",
                "wiki/attention.md",
            ]
        );
    }

    #[test]
    fn winner_spec_is_wired() {
        // Task 4: bge-m3 is the bake-off winner `embed_texts` routes to for the
        // builtin-local provider — this asserts the spec it resolves is really
        // the winner (right file, right pooling) rather than a stale entry.
        let s = crate::local_llm::embed_spec_by_id("bge-m3").expect("winner spec present");
        assert_eq!(s.id, "bge-m3");
        assert_eq!(s.file, "models/bge-m3-Q4_K_M.gguf");
        assert!(matches!(
            s.pooling,
            llama_cpp_2::context::params::LlamaPoolingType::Cls
        ));
    }

    // ---- notch quick text capture (notch S7) --------------------------------

    // 1_000_000_000 = 2001-09-09 01:46:40 UTC — a fixed, human-checkable clock.
    const CAPTURE_TS: i64 = 1_000_000_000;

    #[test]
    fn capture_note_seeds_a_missing_daily_note() {
        let dir = tempfile::tempdir().unwrap();
        let captured = capture_note_at(dir.path(), "buy milk", None, CAPTURE_TS, 0).unwrap();
        assert_eq!(captured.rel, "daily/2001-09-09.md");
        let content = std::fs::read_to_string(dir.path().join(&captured.rel)).unwrap();
        // Seed heading + line, blank seed line collapsed — appendTaskLine's
        // exact trailing convention ("# day\n\n" + line → "# day\n<line>\n").
        assert_eq!(content, "# 2001-09-09\n- 01:46 buy milk\n");
        // What an open reader appends to its draft: the very line written.
        assert_eq!(captured.line, "- 01:46 buy milk");
    }

    #[test]
    fn capture_note_appends_to_an_existing_daily_note() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("daily")).unwrap();
        std::fs::write(
            dir.path().join("daily/2001-09-09.md"),
            "# 2001-09-09\n\n- 01:00 first\n",
        )
        .unwrap();
        // A newline in the payload must not become a second markdown line.
        let captured = capture_note_at(dir.path(), "second\nthought", None, CAPTURE_TS, 0).unwrap();
        assert_eq!(captured.line, "- 01:46 second thought");
        let content = std::fs::read_to_string(dir.path().join("daily/2001-09-09.md")).unwrap();
        assert_eq!(
            content,
            "# 2001-09-09\n\n- 01:00 first\n- 01:46 second thought\n"
        );
    }

    #[test]
    fn capture_note_rejects_empty_text_and_wild_offsets() {
        let dir = tempfile::tempdir().unwrap();
        assert!(capture_note_at(dir.path(), "  \n ", None, CAPTURE_TS, 0).is_err());
        assert!(capture_note_at(dir.path(), "x", None, CAPTURE_TS, 100_000).is_err());
        assert!(!dir.path().join("daily").exists(), "nothing may be written");
    }

    #[test]
    fn capture_note_buckets_on_the_local_day_not_utc() {
        let dir = tempfile::tempdir().unwrap();
        // 01:46 UTC minus two hours is 23:46 the previous LOCAL day.
        let rel = capture_note_at(dir.path(), "late note", None, CAPTURE_TS, -120)
            .unwrap()
            .rel;
        assert_eq!(rel, "daily/2001-09-08.md");
        let content = std::fs::read_to_string(dir.path().join(&rel)).unwrap();
        assert!(content.ends_with("- 23:46 late note\n"), "{content}");
    }

    #[test]
    fn capture_note_quoting_a_raw_original_leaves_its_bytes_alone() {
        // S41: a quote from raw/ goes through capture_note; the original is immutable.
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("raw")).unwrap();
        let original = b"# Clip\n\nA sentence worth keeping.\n";
        std::fs::write(dir.path().join("raw/clip.md"), original).unwrap();
        let captured = capture_note_at(
            dir.path(),
            "A sentence worth keeping. [^src-clip]",
            Some("raw/clip.md"),
            CAPTURE_TS,
            0,
        )
        .unwrap();
        assert_eq!(
            captured.line,
            "- 01:46 A sentence worth keeping. [^src-clip]"
        );
        assert_eq!(
            std::fs::read(dir.path().join("raw/clip.md")).unwrap(),
            original
        );
    }

    #[test]
    fn capture_note_writes_a_quotes_footnote_definition_once_per_note() {
        // Default 8: the `[^src-clip]` a quote cites needs its definition in the
        // same note, or it renders as plain text. A second quote from the same
        // original reuses it; later lines go above the definitions, which stay
        // at the bottom (the editor shows them where they sit).
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("raw/archive")).unwrap();
        std::fs::write(dir.path().join("raw/archive/clip.md"), "x").unwrap();
        let src = Some("raw/archive/clip.md");
        let first = capture_note_at(dir.path(), "One. [^src-clip]", src, CAPTURE_TS, 0).unwrap();
        assert_eq!(
            first.footnote.as_deref(),
            Some("[^src-clip]: raw/archive/clip.md")
        );
        let again = capture_note_at(dir.path(), "Two. [^src-clip]", src, CAPTURE_TS, 0).unwrap();
        assert_eq!(again.footnote, None);
        capture_note_at(dir.path(), "milk", None, CAPTURE_TS, 0).unwrap();
        let content = std::fs::read_to_string(dir.path().join(&first.rel)).unwrap();
        assert_eq!(
            content,
            "# 2001-09-09\n- 01:46 One. [^src-clip]\n- 01:46 Two. [^src-clip]\n- 01:46 milk\n\n\
             [^src-clip]: raw/archive/clip.md\n"
        );
    }

    #[test]
    fn capture_note_skips_a_footnote_it_cannot_stand_behind() {
        // Not under raw/, escaping the vault, missing, or not cited by the text:
        // the line is still captured, but no definition is written.
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("raw")).unwrap();
        std::fs::write(dir.path().join("raw/clip.md"), "x").unwrap();
        std::fs::write(dir.path().join("notes.md"), "x").unwrap();
        for (text, src) in [
            ("a [^src-notes]", "notes.md"),
            ("a [^src-clip]", "raw/../raw/clip.md"),
            ("a [^src-gone]", "raw/gone.md"),
            ("a [^src-other]", "raw/clip.md"),
            ("a [^src-clip]", "raw/clip.md\n[^x]: y"),
        ] {
            let c = capture_note_at(dir.path(), text, Some(src), CAPTURE_TS, 0).unwrap();
            assert_eq!(c.footnote, None, "{src}");
        }
        let content = std::fs::read_to_string(dir.path().join("daily/2001-09-09.md")).unwrap();
        assert!(!content.contains("]: "), "{content}");
    }

    // ---- voice quick-capture (W3–6 item 9) ---------------------------------

    /// The receipt shows what was heard, not only where it went (UX S39):
    /// the first spoken line comes back with the path.
    #[test]
    fn write_voice_note_returns_the_first_line() {
        let dir = tempfile::tempdir().unwrap();
        let saved = write_voice_note(dir.path(), "\n  call the dentist  \nsecond").unwrap();
        assert!(saved.rel.starts_with("_inbox/voice-"));
        assert_eq!(saved.first_line, "call the dentist");
        let empty = write_voice_note(dir.path(), "   ").unwrap();
        assert_eq!(empty.first_line, "");
    }

    /// The whole point of the frontmatter: the readers that already exist
    /// (`provenance` on source/title strings, `distill` on an integer
    /// `created`) must ingest a voice note unchanged — clip.rs's contract.
    #[test]
    fn voice_markdown_has_clip_compatible_frontmatter() {
        let md = voice_markdown(
            "floor: moves to 0.50 tomorrow\nsecond line",
            1_755_000_000,
            &[],
        );
        let parsed = gray_matter::Matter::<gray_matter::engine::YAML>::new()
            .parse(&md)
            .unwrap();
        let gray_matter::Pod::Hash(map) = parsed.data.unwrap() else {
            panic!("frontmatter is not a mapping");
        };
        assert_eq!(
            map.get("source"),
            Some(&gray_matter::Pod::String("voice".into()))
        );
        // A `:` in the transcript's opening words would have broken a bare
        // YAML scalar — the title must survive via yaml_str.
        assert_eq!(
            map.get("title"),
            Some(&gray_matter::Pod::String(
                "floor: moves to 0.50 tomorrow".into()
            ))
        );
        assert_eq!(
            map.get("created"),
            Some(&gray_matter::Pod::Integer(1_755_000_000))
        );
        assert!(md.contains("second line"), "body must carry the transcript");
    }

    /// The related stems land as a YAML sequence the same parser reads back,
    /// and an empty list leaves the frontmatter without the key at all — the
    /// clip contract byte-for-byte.
    #[test]
    fn voice_markdown_related_is_additive_yaml() {
        let related = vec!["kv-cache".to_string(), "속도: 최적화".to_string()];
        let md = voice_markdown("메모입니다", 1_755_000_000, &related);
        let parsed = gray_matter::Matter::<gray_matter::engine::YAML>::new()
            .parse(&md)
            .unwrap();
        let gray_matter::Pod::Hash(map) = parsed.data.unwrap() else {
            panic!("frontmatter is not a mapping");
        };
        let Some(gray_matter::Pod::Array(items)) = map.get("related") else {
            panic!("related is not a sequence");
        };
        assert_eq!(
            items,
            &vec![
                gray_matter::Pod::String("kv-cache".into()),
                // A `:` in a stem must survive via yaml_str, like titles do.
                gray_matter::Pod::String("속도: 최적화".into()),
            ]
        );
        assert!(!voice_markdown("메모", 1, &[]).contains("related"));
    }

    /// The background lookup patches `related:` into a note written without
    /// one; the result must equal what a synchronous write would have produced,
    /// applying twice must not stack blocks, and an empty list is a no-op.
    #[test]
    fn stamp_related_matches_voice_markdown_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("voice.md");
        let transcript = "floor: moves to 0.50 tomorrow\nsecond line";
        std::fs::write(&path, voice_markdown(transcript, 1_755_000_000, &[])).unwrap();
        let stems = vec!["kv-cache".to_string(), "속도: 최적화".to_string()];

        stamp_related(&path, &[]).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            voice_markdown(transcript, 1_755_000_000, &[])
        );

        stamp_related(&path, &stems).unwrap();
        stamp_related(&path, &stems).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            voice_markdown(transcript, 1_755_000_000, &stems)
        );

        // A later run with different stems replaces rather than appends.
        let other = vec!["attention".to_string()];
        stamp_related(&path, &other).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            voice_markdown(transcript, 1_755_000_000, &other)
        );
    }

    /// Two captures in the same minute must not clobber each other: the second
    /// gets a `-2` suffix, the third `-3`.
    #[test]
    fn voice_rel_gets_a_collision_suffix() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let now = 1_755_000_000;
        let first = voice_inbox_rel(root, now);
        assert!(
            first.starts_with("_inbox/voice-") && first.ends_with(".md"),
            "{first}"
        );
        std::fs::create_dir_all(root.join("_inbox")).unwrap();
        std::fs::write(root.join(&first), "x").unwrap();
        let second = voice_inbox_rel(root, now);
        assert_eq!(second, first.replace(".md", "-2.md"));
        std::fs::write(root.join(&second), "x").unwrap();
        assert_eq!(voice_inbox_rel(root, now), first.replace(".md", "-3.md"));
    }

    // ---- resurface_core (Q4 item 10) ---------------------------------------

    /// Hand-built in-memory store of 2-d unit vectors — `records` is pub, so
    /// no disk or embedder is needed to exercise the ranking.
    fn resurface_store(recs: &[(&str, usize, [f32; 2])]) -> crate::vector_index::VectorStore {
        crate::vector_index::VectorStore {
            signature: String::new(),
            model: "builtin-local:bge-m3".into(),
            dim: 2,
            records: recs
                .iter()
                .map(|(page, section, v)| crate::vector_index::Record {
                    id: format!("{page}#{section}"),
                    page: (*page).to_string(),
                    stem: std::path::Path::new(page)
                        .file_stem()
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    section: *section,
                    hash: 0,
                    vector: v.to_vec(),
                })
                .collect(),
        }
    }

    const SEED: [f32; 2] = [1.0, 0.0];
    const NOW: i64 = 1_000_000;
    const DORMANT: i64 = 1_000;

    /// Chunk-text lookup that answers for any (page, section).
    fn any_text(page: &str, section: usize) -> Option<String> {
        Some(format!("{page}#{section} text"))
    }

    #[test]
    fn resurface_core_ranks_dormant_wiki_pages_by_cosine() {
        let store = resurface_store(&[
            ("wiki/echo.md", 0, [1.0, 0.0]),
            ("wiki/faint.md", 0, [0.8, 0.6]),
        ]);
        // echo: never opened, mtime old enough. faint: opened, long ago.
        let opens = HashMap::from([("wiki/faint.md".to_string(), NOW - 2 * DORMANT)]);
        let mtimes = HashMap::from([("wiki/echo.md".to_string(), NOW - 2 * DORMANT)]);
        let out = resurface_core(
            &store, &SEED, &opens, &mtimes, NOW, DORMANT, 0.5, 10, &any_text,
        )
        .unwrap();
        let pages: Vec<&str> = out.iter().map(|c| c.page.as_str()).collect();
        assert_eq!(pages, ["wiki/echo.md", "wiki/faint.md"]);
        assert!(out[0].score > out[1].score);
        assert_eq!(out[0].last_open, None);
        assert_eq!(out[1].last_open, Some(NOW - 2 * DORMANT));
        assert_eq!(out[0].stem, "echo");
    }

    #[test]
    fn resurface_core_excludes_recent_non_wiki_and_cold_pages() {
        let store = resurface_store(&[
            ("wiki/fresh.md", 0, [1.0, 0.0]),            // opened just now
            ("wiki/unknown.md", 0, [1.0, 0.0]),          // no open, no mtime
            ("sessions/2026-08/log.md", 0, [1.0, 0.0]),  // non-wiki
            ("raw/archive/2026-08/x.md", 0, [1.0, 0.0]), // cold tier
        ]);
        let opens = HashMap::from([("wiki/fresh.md".to_string(), NOW - 10)]);
        let mtimes = HashMap::from([
            ("sessions/2026-08/log.md".to_string(), NOW - 2 * DORMANT),
            ("raw/archive/2026-08/x.md".to_string(), NOW - 2 * DORMANT),
        ]);
        let out = resurface_core(
            &store, &SEED, &opens, &mtimes, NOW, DORMANT, 0.5, 10, &any_text,
        )
        .unwrap();
        assert!(
            out.is_empty(),
            "{:?}",
            out.iter().map(|c| &c.page).collect::<Vec<_>>()
        );
    }

    #[test]
    fn resurface_core_floor_cuts_and_k_truncates() {
        let store = resurface_store(&[
            ("wiki/a.md", 0, [1.0, 0.0]),
            ("wiki/b.md", 0, [0.8, 0.6]),
            ("wiki/c.md", 0, [0.6, 0.8]),
        ]);
        let opens = HashMap::new();
        let mtimes: HashMap<String, i64> = ["wiki/a.md", "wiki/b.md", "wiki/c.md"]
            .iter()
            .map(|p| (p.to_string(), NOW - 2 * DORMANT))
            .collect();
        // floor 0.7 cuts c (cosine 0.6).
        let out = resurface_core(
            &store, &SEED, &opens, &mtimes, NOW, DORMANT, 0.7, 10, &any_text,
        )
        .unwrap();
        assert_eq!(
            out.iter().map(|c| c.page.as_str()).collect::<Vec<_>>(),
            ["wiki/a.md", "wiki/b.md"]
        );
        // k = 1 truncates to the best.
        let out = resurface_core(
            &store, &SEED, &opens, &mtimes, NOW, DORMANT, 0.0, 1, &any_text,
        )
        .unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].page, "wiki/a.md");
    }

    #[test]
    fn resurface_core_snippet_comes_from_the_best_chunk_trimmed_to_240() {
        let store = resurface_store(&[
            ("wiki/deep.md", 0, [0.6, 0.8]), // weaker chunk
            ("wiki/deep.md", 1, [1.0, 0.0]), // best chunk
        ]);
        let mtimes = HashMap::from([("wiki/deep.md".to_string(), NOW - 2 * DORMANT)]);
        let long = "밤".repeat(300);
        let lookup = move |_: &str, section: usize| -> Option<String> {
            match section {
                1 => Some(long.clone()),
                _ => Some("weaker chunk".to_string()),
            }
        };
        let out = resurface_core(
            &store,
            &SEED,
            &HashMap::new(),
            &mtimes,
            NOW,
            DORMANT,
            0.5,
            10,
            &lookup,
        )
        .unwrap();
        assert_eq!(out.len(), 1);
        // The snippet is the BEST chunk's text (section 1), trimmed on a char
        // boundary — 240 CHARS of Korean, not 240 bytes.
        assert_eq!(out[0].snippet.chars().count(), 240);
        assert!(out[0].snippet.starts_with('밤'));
        assert!((out[0].score - 1.0).abs() < 1e-6);
    }
}

#[cfg(test)]
mod session_bucket_tests {
    use super::*;

    #[test]
    fn a_dated_stem_lands_in_its_own_month() {
        assert_eq!(session_bucket("claude-code-2026-07-12-abc"), "2026-07");
        assert_eq!(session_bucket("codex-2025-12-31-x"), "2025-12");
    }

    #[test]
    fn a_uuid_stem_is_not_mistaken_for_a_date() {
        // `codex-019fdc04-c083-7f62` starts with digits but is not a date; a
        // naive parse would file it under year 0190.
        let b = session_bucket("codex-019fdc04-c083-7f62-8be6");
        assert_eq!(b.len(), 7);
        let year: u16 = b[0..4].parse().unwrap();
        assert!(
            (2020..=2999).contains(&year),
            "fell back to a sane month, got {b}"
        );
    }

    #[test]
    fn an_impossible_month_falls_back_rather_than_creating_a_bogus_bucket() {
        let b = session_bucket("x-2026-13-01");
        let month: u8 = b[5..7].parse().unwrap();
        assert!((1..=12).contains(&month));
    }

    #[test]
    fn partition_moves_loose_files_and_leaves_buckets_alone() {
        let tmp = std::env::temp_dir().join(format!("myco-part-{}", std::process::id()));
        let sessions = tmp.join(DEST_SESSIONS);
        std::fs::create_dir_all(sessions.join("2026-07")).unwrap();
        std::fs::write(sessions.join("a-2026-07-01.md"), "x").unwrap();
        std::fs::write(sessions.join("b-2025-01-09.md"), "y").unwrap();
        std::fs::write(sessions.join("2026-07").join("already.md"), "z").unwrap();

        let (moved, skipped) = partition_sessions(&tmp).unwrap();
        assert_eq!((moved, skipped), (2, 0));
        assert!(sessions.join("2026-07").join("a-2026-07-01.md").is_file());
        assert!(sessions.join("2025-01").join("b-2025-01-09.md").is_file());
        assert!(sessions.join("2026-07").join("already.md").is_file());

        // Idempotent: a second run has nothing loose left to move.
        assert_eq!(partition_sessions(&tmp).unwrap(), (0, 0));
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn a_name_collision_is_skipped_rather_than_overwriting_an_archived_session() {
        let tmp = std::env::temp_dir().join(format!("myco-part2-{}", std::process::id()));
        let sessions = tmp.join(DEST_SESSIONS);
        std::fs::create_dir_all(sessions.join("2026-07")).unwrap();
        std::fs::write(sessions.join("2026-07").join("dup-2026-07-02.md"), "keep").unwrap();
        std::fs::write(sessions.join("dup-2026-07-02.md"), "incoming").unwrap();

        let (moved, skipped) = partition_sessions(&tmp).unwrap();
        assert_eq!((moved, skipped), (0, 1));
        let kept =
            std::fs::read_to_string(sessions.join("2026-07").join("dup-2026-07-02.md")).unwrap();
        assert_eq!(
            kept, "keep",
            "an archived session must never be overwritten"
        );
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn collect_wiki_pages_includes_both_digest_layers_and_excludes_cold_subtrees() {
        // Defect A: distillation writes digests to `daily/*.md`, and a
        // digested session gets archived to `sessions/archive/...` (cold).
        // Both `daily/` must be walked and `sessions/archive/` must still be
        // dropped, or a digest's knowledge is unsearchable on both ends.
        // ROADMAP P1 adds the same pair one layer up: `weekly/` is walked and
        // `daily/archive/` is cold.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for sub in [
            "wiki/a.md",
            "sessions/2026-08/s.md",
            "daily/2026-08-10.md",
            "weekly/2026-W33.md",
            "sessions/archive/2026-08/old.md",
            "daily/archive/2026-W32/2026-08-03.md",
        ] {
            let p = root.join(sub);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, "# content").unwrap();
        }

        let rels: Vec<String> = collect_wiki_pages(root)
            .into_iter()
            .map(|(r, _, _)| r)
            .collect();
        assert!(rels.contains(&"wiki/a.md".to_string()));
        assert!(rels.contains(&"sessions/2026-08/s.md".to_string()));
        assert!(
            rels.contains(&"daily/2026-08-10.md".to_string()),
            "daily/ digests must be indexed: {rels:?}"
        );
        assert!(
            rels.contains(&"weekly/2026-W33.md".to_string()),
            "weekly/ rollups must be indexed: {rels:?}"
        );
        assert!(
            !rels.iter().any(|r| r.starts_with("sessions/archive/")),
            "archived (cold) sessions must stay out of the active index: {rels:?}"
        );
        assert!(
            !rels.iter().any(|r| r.starts_with("daily/archive/")),
            "rolled-up (cold) daily digests must stay out too: {rels:?}"
        );
    }

    // `search_archived_sessions`: off keeps `sessions/archive/` cold; on
    // indexes it, but a body that already exists live (or twice in the
    // archive) is indexed once, and only the archived copy is the one dropped.
    #[test]
    fn archived_sessions_are_indexed_on_opt_in_with_duplicate_bodies_once() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let body = "# Session\n\nUser: fix the flaky scheduler test\n";
        for (sub, text) in [
            ("wiki/a.md", "# content".to_string()),
            (
                "sessions/2026-08/live.md",
                format!("---\ncreated: 2026-08-20\n---\n{body}"),
            ),
            (
                "sessions/archive/2026-08/live-copy.md",
                format!("---\ncreated: 2026-08-01\nsource: codex\n---\n{body}"),
            ),
            (
                "sessions/archive/2026-07/old-a.md",
                "# Session\n\nUser: batch size diverges\n".to_string(),
            ),
            (
                "sessions/archive/2026-07/old-a-again.md",
                "---\ncreated: 2026-07-02\n---\n# Session\n\nUser: batch size diverges\n"
                    .to_string(),
            ),
            (
                "sessions/archive/2026-07/old-b.md",
                "# Session\n\nUser: warm-up schedule\n".to_string(),
            ),
            (
                "daily/archive/2026-W32/2026-08-03.md",
                "# digest".to_string(),
            ),
        ] {
            let p = root.join(sub);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, text).unwrap();
        }
        let rels = |on: bool| -> Vec<String> {
            let mut v: Vec<String> = super::collect_pages(root, on)
                .into_iter()
                .map(|(r, _, _)| r)
                .collect();
            v.sort();
            v
        };

        let off = rels(false);
        assert_eq!(
            off,
            vec!["sessions/2026-08/live.md", "wiki/a.md"],
            "flag off: archive stays cold"
        );

        let on = rels(true);
        assert_eq!(
            on,
            vec![
                "sessions/2026-08/live.md",
                "sessions/archive/2026-07/old-a.md",
                "sessions/archive/2026-07/old-b.md",
                "wiki/a.md",
            ],
            "flag on: archive indexed, live copy wins over its archived twin, \
             the archive's own twin indexed once, other cold tiers unchanged"
        );
    }

    // ---- retro raw/ audit (Q4 item 14) -------------------------------------

    #[test]
    fn audit_worktree_flags_secrets_and_pii_and_counts_binaries() {
        let dir = tempfile::tempdir().unwrap();
        let raw = dir.path().join("raw");
        std::fs::create_dir_all(raw.join("conv")).unwrap();
        std::fs::write(
            raw.join("leak.md"),
            "here is sk-abcdefghijklmnopqrstuvwxyz012345 oops",
        )
        .unwrap();
        std::fs::write(raw.join("conv/contact.md"), "mail someone@example.com").unwrap();
        // Invalid UTF-8: skipped as binary, still counted.
        std::fs::write(raw.join("photo.bin"), [0xffu8, 0xfe, 0x00, 0x9f]).unwrap();
        std::fs::write(raw.join("clean.md"), "ordinary prose only").unwrap();

        let (files, secrets, pii) = super::audit_worktree(dir.path());
        assert_eq!(files, 4, "binaries are counted even though not scanned");
        assert_eq!(secrets.len(), 1);
        assert_eq!(secrets[0].rel, "raw/leak.md");
        assert!(
            secrets[0].patterns.iter().any(|p| p.contains("API key")),
            "{:?}",
            secrets[0].patterns
        );
        assert!(!secrets[0].in_history_only);
        assert_eq!(pii.len(), 1);
        assert_eq!(pii[0].rel, "raw/conv/contact.md");
        assert!(!pii[0].in_history_only);
    }

    #[test]
    fn audit_worktree_without_raw_dir_is_clean() {
        let dir = tempfile::tempdir().unwrap();
        let (files, secrets, pii) = super::audit_worktree(dir.path());
        assert_eq!((files, secrets.len(), pii.len()), (0, 0, 0));
    }

    #[test]
    fn audit_vault_history_arm_flags_deleted_raw_secret_as_history_only() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("raw")).unwrap();
        // Fake, obviously synthetic key shapes — never real credentials.
        std::fs::write(
            root.join("raw/leak.md"),
            "sk-abcdefghijklmnopqrstuvwxyz012345\n",
        )
        .unwrap();
        std::fs::write(root.join("raw/keep.md"), "AKIAIOSFODNN7EXAMPLE stays\n").unwrap();
        crate::vault_history::init(root).unwrap();
        std::fs::remove_file(root.join("raw/leak.md")).unwrap();
        assert!(crate::vault_history::commit_paths(
            root,
            &["raw"],
            "delete leak",
            crate::vault_history::CommitIdentity::Human,
        )
        .unwrap());

        let report = super::audit_vault(root);
        assert_eq!(report.files_scanned, 1, "only keep.md is left on disk");
        assert!(
            report.history_files_scanned >= 2,
            "both raw/ adds read back: {}",
            report.history_files_scanned
        );
        assert!(!report.truncated);
        let gone = report
            .secret_hits
            .iter()
            .find(|h| h.rel == "raw/leak.md")
            .expect("deleted file surfaced via history");
        assert!(
            gone.in_history_only,
            "worktree file is gone => history-only"
        );
        let kept: Vec<_> = report
            .secret_hits
            .iter()
            .filter(|h| h.rel == "raw/keep.md")
            .collect();
        assert_eq!(kept.len(), 1, "history must not duplicate a live hit");
        assert!(!kept[0].in_history_only);
    }

    #[test]
    fn audit_vault_without_git_repo_reports_zero_history() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("raw")).unwrap();
        std::fs::write(dir.path().join("raw/a.md"), "clean prose").unwrap();
        let report = super::audit_vault(dir.path());
        assert_eq!(report.files_scanned, 1);
        assert_eq!(report.history_files_scanned, 0);
        assert!(report.secret_hits.is_empty() && report.pii_hits.is_empty());
        assert!(!report.truncated);
    }
}

#[cfg(test)]
mod llm_janitor_tests {
    use super::llm_should_unload;

    #[test]
    fn unloads_only_when_loaded_and_idle_past_the_window() {
        let idle = 600;
        assert!(llm_should_unload(true, 1_000, 1_600, idle));
        assert!(llm_should_unload(true, 1_000, 2_000, idle));
        // Not loaded — nothing to drop.
        assert!(!llm_should_unload(false, 1_000, 2_000, idle));
        // Used recently.
        assert!(!llm_should_unload(true, 1_500, 1_600, idle));
        // Never used since boot (0 sentinel): nothing was loaded through the
        // accessor, so there is nothing the janitor should race.
        assert!(!llm_should_unload(true, 0, 9_999, idle));
    }
}

// ---- Harvest (sessions/ → wiki, hand-picked) --------------------------------
// The pure scan/copy logic is `harvest.rs`; these adapters add the vault root
// and — for the queue — the embedder, to name the wiki page each candidate
// most likely belongs to.

fn harvest_clusters(
    store: &VectorStore,
    vectors: &[Vec<f32>],
    expected_count: usize,
) -> Result<Vec<Option<crate::harvest::Cluster>>, String> {
    embeddings::validate_embedding_batch(vectors, expected_count, Some(store.dim))?;
    vectors
        .iter()
        .map(|vector| {
            let hits = crate::pipeline::dense_chunk_matches(
                &store.search(vector, crate::pipeline::FUSE_POOL)?,
            );
            Ok(crate::pipeline::rank_candidates(&[hits], 1)
                .pop()
                .map(|candidate| crate::harvest::Cluster {
                    page: candidate.page,
                    score: candidate.score,
                }))
        })
        .collect()
}

/// The harvest queue for the Overview (see `harvest::scan_at`). `limit`
/// defaults to 20. `cluster` is `pipeline::rank_candidates` top-1 for the
/// candidate's leading text, embedded with the index's own model; its `score`
/// is the cosine similarity it measured, not a rank. Null when nothing is
/// indexed, the index predates the bundled embed model, or the embed fails —
/// the queue is still useful without it, so none of those fail the call.
#[tauri::command]
pub async fn harvest_candidates(
    app: tauri::AppHandle,
    vault: tauri::State<'_, VaultRoot>,
    llm: tauri::State<'_, LocalLlmState>,
    cache: tauri::State<'_, VectorCache>,
    limit: Option<u32>,
    vault_path: Option<String>,
) -> Result<crate::harvest::Queue, String> {
    let root = require_root(&vault)?;
    check_expected_vault(&root, vault_path.as_deref())?;
    let limit = limit.unwrap_or(20).clamp(1, 200) as usize;
    let scan_root = root.clone();
    let mut queue =
        tauri::async_runtime::spawn_blocking(move || crate::harvest::scan_at(&scan_root, limit))
            .await
            .map_err(|e| format!("join failed: {e}"))?;
    if queue.items.is_empty() {
        return Ok(queue);
    }
    let store = cache
        .get_async(VectorStore::path_for(&root.to_string_lossy())?)
        .await?;
    if store.records.is_empty() {
        return Ok(queue);
    }
    let (provider, model) = store
        .model
        .split_once(':')
        .map(|(p, m)| (p.to_string(), m.to_string()))
        .unwrap_or((store.model.clone(), String::new()));
    if builtin_index_is_stale(&provider, &model)
        || store.signature != embedding_index_signature(&app, &provider, &model).await?
    {
        return Ok(queue);
    }
    let texts: Vec<String> = queue.items.iter().map(|c| c.embed_text.clone()).collect();
    let embedded = match embed_texts_checked(
        app,
        llm,
        &provider,
        &model,
        crate::local_llm::EmbedRole::Query,
        texts,
    )
    .await
    {
        Ok(v) => v,
        Err(e) => {
            eprintln!("harvest_candidates: cluster lookup skipped: {e}");
            return Ok(queue);
        }
    };
    if let Err(error) = embedded.validate(&store.embedding_space()?, queue.items.len()) {
        eprintln!("harvest_candidates: cluster lookup skipped: {error}");
        return Ok(queue);
    }
    let vecs = embedded.vectors;
    tauri::async_runtime::spawn_blocking(move || {
        let clusters = match harvest_clusters(&store, &vecs, queue.items.len()) {
            Ok(clusters) => clusters,
            Err(error) => {
                eprintln!("harvest_candidates: cluster lookup skipped: {error}");
                return queue;
            }
        };
        for (item, cluster) in queue.items.iter_mut().zip(clusters) {
            item.cluster = cluster;
        }
        queue
    })
    .await
    .map_err(|e| format!("harvest ranking task failed: {e}"))
}

/// Copy the chosen sessions into `_inbox/` and take them out of the queue
/// (see `harvest::run_at`). The frontend runs the ordinary ingest afterwards.
#[tauri::command]
pub async fn harvest_run(
    app: tauri::AppHandle,
    vault: tauri::State<'_, VaultRoot>,
    paths: Vec<String>,
    vault_path: Option<String>,
    origin: AgentVaultSession,
) -> Result<crate::harvest::Run, String> {
    vault.with_origin(&origin, |root| {
        check_expected_vault(root, vault_path.as_deref())
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<VaultRoot>()
            .with_origin(&origin, |root| crate::harvest::run_at(root, &paths))
    })
    .await
    .map_err(|e| format!("join failed: {e}"))?
}

// ---- Pre-ingest judgement (see judge.rs) ------------------------------------

/// Classify a source before the ingest runs: `drop` (junk, or a body the
/// vault already has), `log` (real text outside the 8 KB–200 KB band) or
/// `harvest`. The duplicate oracle is the import ledger's body index.
#[tauri::command]
pub fn judge_source(
    vault: tauri::State<VaultRoot>,
    text: String,
    size_bytes: u64,
) -> Result<crate::judge::Judgement, String> {
    let root = require_root(&vault)?;
    let ledger = crate::importers::ledger::Ledger::load(&root)?;
    Ok(crate::judge::judge_against(&text, size_bytes, &ledger))
}

/// Leave a one-line trace of a source that was dropped or planned as NOOP in
/// `.myco/ingest-noop.jsonl` — instead of a `wiki/source-*.md`, an
/// `index.md`/`log.md` rewrite and an `ingest-reports/` file.
#[tauri::command]
pub fn record_noop(
    vault: tauri::State<VaultRoot>,
    rel: String,
    reason: String,
) -> Result<(), String> {
    let root = require_root(&vault)?;
    crate::judge::record_noop_at(&root, &rel, &reason)
}
