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

/// Lazily-loaded local model host. `None` until the first local_* command;
/// model weights must not tax startup or RAM when the feature is unused. Arc
/// so inference can run on a blocking thread. Since the Gemma GGUF left the
/// bundle this usually hosts only the embedder (bge-m3); a chat GGUF present
/// on disk (dev tree / older install) is still picked up.
#[derive(Default, Clone)]
pub struct LocalLlmState(Arc<Mutex<Option<LocalLlm>>>);

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
/// the ~418 MB embed model) only to hit [`CHAT_MODEL_MISSING`] at the end: no
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
/// The first call through here pays for the 769 MB of weights: measured at 873 ms
/// against a warm page cache and 11.7 s genuinely cold (`cargo run --example
/// bench_local_llm --release`). That is far too long to leave unexplained, so it
/// is announced on `local-model-load` — every later call finds the model already
/// in the cell and emits nothing.
// `&mut LocalLlm` (rather than `&LocalLlm`) so the embed path below can call
// `ensure_embed_model`, which lazily loads the second (embed) model into the
// same cell; the pre-existing `&self`-only callers (classify, generate) still
// work unchanged through a `&mut` reference.
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
    // Missing chat GGUF is normal now (not bundled): host the embedder only.
    // Chat consumers (classify/generate) then error per-call with a clear
    // "not bundled" message instead of failing every local_* command here.
    let path = local_model_path(&app).ok();
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
            let loaded = match &path {
                Some(p) => LocalLlm::load(p),
                None => LocalLlm::load_embed_host(),
            };
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
/// vault context; factual accuracy is limited at 1B (paid tiers for ingest).
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
    #[allow(unused_variables)] app: tauri::AppHandle,
    state: tauri::State<VaultRoot>,
    path: String,
) -> Result<VaultMeta, String> {
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
    state.set(PathBuf::from(&meta.path));
    // Rebind the background index updater to the newly-opened vault, so it
    // watches the right wiki/ and catches up a fresh/stale index.
    if let Some(u) = crate::INDEX_UPDATER.get() {
        u.rebind(PathBuf::from(&meta.path));
    }
    // Record the active vault so the native MCP server follows the app's
    // current selection (best-effort: a marker write failure must not block
    // opening the vault). The native server re-reads this marker per call, so
    // no restart is needed — the next tool call sees the new vault.
    let _ = settings::set_active_vault(&path);
    // M3: this vault's background digests may still be installed under the
    // pre-rename LaunchAgent label. Re-install them under the new label (the old
    // agent is booted out and deleted only once the new one is loaded, so
    // digests neither fire twice nor stop firing).
    // Skipped when python3 or the digest runner can't be resolved — better to
    // leave the old agent working than to remove it with no replacement.
    //
    // DEFERRED (I5): `locate_bin` shells out to a LOGIN shell to find python3,
    // which costs a shell startup on EVERY open_vault even for the overwhelming
    // majority of vaults that have no legacy plist at all. Reorder later so the
    // cheap check (does any legacy plist exist for this vault's schedules?) runs
    // first and the binary is only resolved when there is work to do.
    #[cfg(target_os = "macos")]
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
    Ok(meta)
}

#[tauri::command]
pub fn ensure_default_vault() -> Result<String, String> {
    vault::ensure_default_vault()
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
    // raw/ is immutable: a source may be CREATED (that is how ingest files an
    // original) but never modified. Refuse a write that would overwrite an
    // existing raw/ file. agent_tools already blocks the agent from raw/ writes
    // entirely; this closes the same rule at the direct command layer.
    if vault::is_raw_path(&root, &p) && p.exists() {
        return Err("refused: raw/ is immutable — an existing source cannot be overwritten".into());
    }
    vault::write_file(&p.to_string_lossy(), &content)?;
    if let Some(u) = crate::INDEX_UPDATER.get() {
        if let Ok(rel) = p.strip_prefix(&root) {
            u.mark_dirty(rel.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
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
    // Seed the required frontmatter for a new wiki page so it is visible to
    // Views, gap buckets and the graph from the moment it exists; daily notes
    // and other files stay empty.
    let target = p.join(&name);
    let content = if vault::should_seed_frontmatter(&root, &target) {
        let stem = name.strip_suffix(".md").unwrap_or(&name);
        vault::wiki_page_stub(stem, &registry::today_utc())
    } else {
        String::new()
    };
    let created = vault::create_file(&p.to_string_lossy(), &name, &content)?;
    if let Some(u) = crate::INDEX_UPDATER.get() {
        if let Ok(rel) = target.strip_prefix(&root) {
            u.mark_dirty(rel.to_string_lossy().replace('\\', "/"));
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
    let p = vault::confine_parent(&root, &parent)?;
    vault::create_folder(&p.to_string_lossy(), &name)
}

#[tauri::command]
pub fn delete_path(state: tauri::State<VaultRoot>, path: String) -> Result<(), String> {
    let root = require_root(&state)?;
    let p = vault::confine_path(&root, &path)?;
    if vault::is_raw_path(&root, &p) {
        return Err("refused: raw/ is immutable — a source cannot be deleted".into());
    }
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
    if vault::is_raw_path(&root, &p) {
        return Err("refused: raw/ is immutable — a source cannot be renamed".into());
    }
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

/// A free `raw/<stem>.md` path (suffixed on collision) for a new ingest source,
/// so a second source under the same title never overwrites the first's
/// immutable original.
#[tauri::command]
pub fn available_raw_path(state: tauri::State<VaultRoot>, stem: String) -> Result<String, String> {
    let root = require_root(&state)?;
    Ok(vault::available_raw_path(&root, &stem))
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
) -> Result<String, String> {
    let root = require_root(&state)?;
    let p = vault::confine_path(&root, &path)?;
    vault::archive_inbox_source(&p.to_string_lossy())
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
fn import_dest(dest: &str) -> Result<&'static str, String> {
    match dest {
        DEST_INBOX => Ok(DEST_INBOX),
        DEST_SESSIONS => Ok(DEST_SESSIONS),
        other => Err(format!("unknown import destination: {other}")),
    }
}

fn run_import(
    root: &std::path::Path,
    files: &[PathBuf],
    dest: &str,
    mut on_progress: impl FnMut(ImportProgress),
) -> ImportOutcome {
    // A single oversized file should error rather than exhaust memory; applied
    // per file so one giant export can't take down a whole sweep.
    const MAX_BYTES: u64 = 512 * 1024 * 1024;
    let mut ledger = crate::importers::ledger::Ledger::load(root);
    let total = files.len();
    let (mut imported, mut skipped) = (0usize, 0usize);
    let mut quarantined = Vec::new();
    let mut failed: Vec<FailedImport> = Vec::new();
    let mut source = String::new();
    let mut dirty = false;

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
                    apply_import(root, &mut ledger, &path_str, &content, dest)
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
            });
        }
    }
    if imported > 0 || dirty {
        // Best effort: a ledger that fails to save just costs a re-import.
        let _ = ledger.save(root);
    }
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
) -> Result<ImportOutcome, String> {
    let root = require_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(run_import(
            &root,
            &[PathBuf::from(source_path)],
            DEST_INBOX,
            |p| {
                use tauri::Emitter;
                let _ = app.emit("import-progress", p);
            },
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
) -> Result<ImportOutcome, String> {
    let root = require_root(&state)?;
    // A retry must land where the run that failed was heading — re-queueing a
    // swept session into `_inbox/` would book it a paid ingest nobody asked for.
    let dest = import_dest(&dest)?;
    tauri::async_runtime::spawn_blocking(move || {
        let files: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
        Ok(run_import(&root, &files, dest, |p| {
            use tauri::Emitter;
            let _ = app.emit("import-progress", p);
        }))
    })
    .await
    .map_err(|e| format!("join failed: {e}"))?
}

/// Parse one file's conversations, write the clean ones to `_inbox/` and record
/// them in `ledger` (NOT saved — the caller batches the save). Returns
/// (imported, skipped, quarantined, detected source). Shared by the single-file
/// import and the session sweep.
#[allow(clippy::type_complexity)]
fn apply_import(
    root: &std::path::Path,
    ledger: &mut crate::importers::ledger::Ledger,
    filename: &str,
    content: &str,
    dest: &str,
) -> Result<(usize, usize, Vec<QuarantinedConversation>, String), String> {
    let plan = crate::importers::plan_import(filename, content, ledger)?;
    let mut imported = 0;
    for doc in &plan.docs {
        // Sessions are partitioned by month. A sweep every 30 minutes had put
        // 1,029 files as flat siblings in one directory, which makes the folder
        // tree unusable, costs a full re-read of the directory on every scan,
        // and gives nothing to scope work to. A month bucket keeps each
        // directory small and lets anything that walks the vault skip whole
        // periods. `_inbox/` stays flat — it is a short-lived queue, not an
        // archive.
        let out_dir = if dest == DEST_SESSIONS {
            root.join(dest).join(session_bucket(&doc.stem))
        } else {
            root.join(dest)
        };
        std::fs::create_dir_all(&out_dir)
            .map_err(|e| format!("create {}: {e}", out_dir.display()))?;
        std::fs::write(out_dir.join(format!("{}.md", doc.stem)), &doc.body)
            .map_err(|e| format!("write {}: {e}", doc.stem))?;
        // Record only after a successful write, so a failed write is retried
        // rather than silently skipped next time.
        ledger.record(doc.key.clone(), doc.fingerprint.clone());
        imported += 1;
    }
    let quarantined = plan
        .quarantined
        .into_iter()
        .map(|q| QuarantinedConversation {
            title: q.title,
            secrets: q.secrets.into_iter().map(str::to_string).collect(),
        })
        .collect();
    Ok((imported, plan.skipped, quarantined, plan.source))
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
) -> Result<ImportOutcome, String> {
    let root = require_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = session_dir(&kind)?;
        if !dir.is_dir() {
            return Err(format!("no session directory at {}", dir.display()));
        }
        // Fold any loose sessions from before month-bucketing into their bucket
        // as part of the normal sweep — one archive shape, no separate chore
        // for the user to remember. Best effort: a migration that cannot move a
        // file must not stop the sweep that follows it.
        if let Err(e) = partition_sessions(&root) {
            crate::perf::log("partition_sessions_failed", &[]);
            let _ = e;
        }
        let mut files = Vec::new();
        collect_jsonl(&dir, &mut files, 0);
        Ok(run_import(&root, &files, DEST_SESSIONS, |p| {
            use tauri::Emitter;
            let _ = app.emit("import-progress", p);
        }))
    })
    .await
    .map_err(|e| format!("join failed: {e}"))?
}

/// The on-disk session directory for a CLI tool.
fn session_dir(kind: &str) -> Result<PathBuf, String> {
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
) -> Result<crate::myco_pro::MycoProResult, String> {
    let root = require_root(&state)?;
    // VaultRoot is Send + Sync, so holding State across the await keeps the
    // future Send; we just need the owned root before the network call.
    let s = settings::load();
    let url = s.myco_pro_url.trim().to_string();
    if url.is_empty() {
        return Err("myco Pro proxy URL is not configured (Settings → Connections)".into());
    }
    let key = secrets::get_key(settings::PRO_PROVIDER_ID)?.ok_or_else(|| {
        "myco Pro is not connected — log in under Settings → Connections".to_string()
    })?;
    crate::myco_pro::ingest(&root, &url, &key, &slug, &title, &text).await
}

/// Log in to myco Pro with the account created on the website. Fetches the
/// account's access key, stores it in the keychain, and records the email for
/// display — so the user never copies a key by hand.
#[tauri::command]
pub async fn myco_pro_login(
    email: String,
    password: String,
) -> Result<crate::myco_pro::LoginOutcome, String> {
    let url = settings::load().myco_pro_url.trim().to_string();
    if url.is_empty() {
        return Err("Set the myco Pro service URL first (Settings → Connections)".into());
    }
    let outcome = crate::myco_pro::login(&url, &email, &password).await?;
    if let Some(key) = &outcome.license_key {
        secrets::set_key(settings::PRO_PROVIDER_ID, key)?;
    }
    // Persist the logged-in email + connection flag (the key stays in the
    // keychain). The flag gates the model picker; settings is the single source.
    let mut s = settings::load();
    s.myco_pro_email = outcome.email.clone();
    s.providers.myco_pro = outcome.connected;
    let _ = settings::save(&s);
    // Don't echo the key back to the frontend; it's in the keychain.
    Ok(crate::myco_pro::LoginOutcome {
        license_key: None,
        ..outcome
    })
}

/// Log out of myco Pro: clear the stored key and email.
#[tauri::command]
pub fn myco_pro_logout() -> Result<(), String> {
    let _ = secrets::delete_key(settings::PRO_PROVIDER_ID);
    let mut s = settings::load();
    s.myco_pro_email = String::new();
    s.providers.myco_pro = false;
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

// ---- Distillation config (Task 2, Phase A) ----

#[tauri::command]
pub fn get_distill_config(
    state: tauri::State<VaultRoot>,
    vault: String,
) -> Result<crate::distill::DistillConfig, String> {
    let root = confine_root(&state, &vault)?;
    Ok(crate::distill::config_load(std::path::Path::new(&root)))
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

#[derive(serde::Serialize)]
pub struct OntologySummary {
    pub clusters: usize,
    pub wiki_pages: usize,
    pub built_at: i64,
}

/// Rebuild the ontology cache (Task 3, Phase A): cluster the wiki's semantic
/// graph, compute per-cluster admission stats, and save it to
/// `<vault>/.myco/ontology.json` for the (future) admission gate to read.
#[tauri::command]
pub fn build_ontology(
    vault_state: tauri::State<VaultRoot>,
    cache: tauri::State<'_, VectorCache>,
    vault: String,
) -> Result<OntologySummary, String> {
    let root = confine_root(&vault_state, &vault)?;
    let root = std::path::Path::new(&root);
    let index_path = VectorStore::path_for(&root.to_string_lossy())?;
    let store = cache.get(&index_path);
    let titles = wiki_titles(root);
    let mut ontology = crate::ontology::build(&store, &titles);
    crate::ontology::stamp_last_touched(root, &mut ontology);
    crate::ontology::save(root, &ontology)?;
    Ok(OntologySummary {
        clusters: ontology.clusters.len(),
        wiki_pages: ontology.wiki_pages,
        built_at: ontology.built_at,
    })
}

/// Build the `embed` closure `distill::scan`/`distill::run` want (a plain
/// synchronous `Fn`, so their own tests can inject synthetic vectors) and run
/// `f` with it on a blocking-pool thread — the closure's own
/// `block_on(embed_texts(...))` call cannot run on the caller's async task
/// without panicking ("cannot block the current thread from within a
/// runtime"). Shared by `distill_scan` and `distill_run` so the bridge is
/// written once.
async fn with_distill_embed<T: Send + 'static>(
    app: tauri::AppHandle,
    provider: String,
    model: String,
    f: impl FnOnce(&dyn Fn(Vec<String>) -> Result<Vec<Vec<f32>>, String>) -> Result<T, String>
        + Send
        + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let embed = |texts: Vec<String>| -> Result<Vec<Vec<f32>>, String> {
            let llm = app.state::<LocalLlmState>();
            tauri::async_runtime::block_on(embed_texts(
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

/// Score new inflow against the ontology cache (Task 4, Phase A): walk
/// `_inbox/`, `raw/`, `sessions/`, gate each mature+unscored item through
/// `ontology::admit`, quarantine what fits no known topic, and TTL-ledger
/// straight rejects. No ontology yet (never built, or stale for the current
/// embed model) degrades to a zero outcome rather than an error — same
/// treatment as an empty/stale index elsewhere in this file.
#[tauri::command]
pub async fn distill_scan(
    app: tauri::AppHandle,
    vault_state: tauri::State<'_, VaultRoot>,
    cache: tauri::State<'_, VectorCache>,
    vault: String,
) -> Result<crate::distill::ScanOutcome, String> {
    let root = confine_root(&vault_state, &vault)?;
    let root = PathBuf::from(root);
    let index_path = VectorStore::path_for(&root.to_string_lossy())?;
    let store = cache.get(&index_path);
    let Some(ontology) = crate::ontology::load(&root, &store.model) else {
        return Ok(crate::distill::ScanOutcome::default());
    };
    // `store.model` is "{provider}:{model}" (see `wikify_candidates`).
    let (provider, model) = store
        .model
        .split_once(':')
        .map(|(p, m)| (p.to_string(), m.to_string()))
        .unwrap_or((store.model.clone(), String::new()));
    if builtin_index_is_stale(&provider, &model) {
        return Ok(crate::distill::ScanOutcome::default());
    }
    let cfg = crate::distill::config_load(&root);
    let budget = cfg.run_budget_items;

    with_distill_embed(app, provider, model, move |embed| {
        crate::distill::scan(&root, &ontology, &cfg, budget, embed)
    })
    .await
}

/// Idle-run orchestrator (Task 6, Phase A): partitions sessions, freshens the
/// ontology cache if the wiki moved, scores/quarantines/rejects new inflow,
/// archives already-represented raw sources, sweeps expired quarantine past
/// its TTL, and writes a run manifest + human report — see `distill::run`'s
/// own doc comment for the full step list.
///
/// Same builtin-local-model staleness guard as `distill_scan`: `distill::run`
/// resolves its OWN copy of the vault's `VectorStore` internally (it takes no
/// cache/state, unlike this command — see its doc comment), so this
/// duplicates one disk read against the cached copy just to pick the same
/// embed model `run` will independently load. Degrading to a zero-valued
/// report here, before `run` ever starts, keeps a stale index from failing
/// mid-run instead of not running at all.
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
    let store = cache.get(&index_path);
    let (provider, model) = store
        .model
        .split_once(':')
        .map(|(p, m)| (p.to_string(), m.to_string()))
        .unwrap_or((store.model.clone(), String::new()));
    if builtin_index_is_stale(&provider, &model) {
        return Ok(crate::distill::RunReport {
            id: String::new(),
            scan: crate::distill::ScanOutcome::default(),
            archived: 0,
            trashed: 0,
            proposals: 0,
            backlog_after: crate::distill::status(&root).backlog,
        });
    }
    let cfg = crate::distill::config_load(&root);

    with_distill_embed(app, provider, model, move |embed| {
        crate::distill::run(&root, &cfg, embed)
    })
    .await
}

/// Mechanically reverse one `distill_run` — see `distill::undo`'s own doc
/// comment. Returns the number of manifest entries actually reversed.
#[tauri::command]
pub fn undo_distill_run(
    state: tauri::State<VaultRoot>,
    vault: String,
    id: String,
) -> Result<usize, String> {
    let root = confine_root(&state, &vault)?;
    crate::distill::undo(std::path::Path::new(&root), &id)
}

/// Vault-wide distillation status for the settings tab / MCP `distill_status`
/// — backlog count, pending proposals, last run, and the backlog trend.
#[tauri::command]
pub fn distill_status(
    state: tauri::State<VaultRoot>,
    vault: String,
) -> Result<crate::distill::DistillStatus, String> {
    let root = confine_root(&state, &vault)?;
    Ok(crate::distill::status(std::path::Path::new(&root)))
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
        let python = claude::locate_bin("python3", "MYCO_PYTHON_PATH")
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
// Gemma model ("builtin-local") or an "ollama" provider; more providers later.
// ---------------------------------------------------------------------------

use crate::embeddings;
use crate::perf;
use crate::vector_index::{is_cold, EdgeLookup, Hit as VecHit, VectorCache, VectorStore};

/// Embed a batch of texts with the chosen provider. `role` picks the query/doc
/// instruction prefix for asymmetric embedding models (bge-m3 ignores it — see
/// `EmbedSpec.query_prefix`/`doc_prefix`).
async fn embed_texts(
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
                // Loads the embed model once if absent; the chat model (Gemma)
                // is already resident from `with_local_llm`'s own lazy load, so
                // this path holds both models in RAM at once (~806 MB + 438 MB).
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

/// Collect `wiki/**/*.md` pages as (relpath, stem, content).
///
/// This is the one walk both `reindex_embeddings` and `index_updater`'s
/// reconcile pass use, so it is also the one place that decides what the
/// active index may ever hold: `is_cold` pages (archived/quarantined/cache)
/// are dropped here, which is what keeps them out of both the embed loop and
/// the `existing`/`present` set each caller later hands to `prune` — a
/// cold-tier record can never survive the next reindex.
pub(crate) fn collect_wiki_pages(root: &std::path::Path) -> Vec<(String, String, String)> {
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
    // Cold-tier pages never belong in the active index — see this fn's doc
    // comment. A no-op today (both walk roots above are structurally disjoint
    // from every `is_cold` prefix), but this is the single choke point every
    // (re)indexing caller routes through, so it is where the guard lives
    // rather than duplicated at each caller.
    out.retain(|(rel, _, _)| !is_cold(rel));
    out
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

/// Sync core of `embed_one_page`: decides whether either index needs
/// updating and, if so, upserts `bm25` — the one part of this decision with
/// no dependency on a live app/loaded model, split out so it is directly
/// unit-testable (see the `commands::tests` module).
///
/// Returns `None` when nothing needs doing (no chunks, or both indexes
/// already current for this page — the caller should report
/// `EmbedOutcome { embedded: false, changed: false }`). Returns
/// `Some((chunks, hashes, dense_current))` otherwise, having already
/// upserted `bm25` as needed; `dense_current` tells the caller whether it
/// must still embed and upsert `store`, or whether BM25 alone needed
/// catching up.
fn sync_bm25_for_page(
    content: &str,
    rel: &str,
    stem: &str,
    existing: &std::collections::HashMap<String, Vec<u64>>,
    bm25: &mut crate::retrieval::Bm25Index,
    bm25_pages: &std::collections::HashSet<String>,
) -> Option<(Vec<String>, Vec<u64>, bool)> {
    let chunks = embeddings::chunk_page(content);
    if chunks.is_empty() {
        return None; // nothing to index on either side
    }
    let hashes: Vec<u64> = chunks.iter().map(|c| embeddings::content_hash(c)).collect();
    let dense_current = existing.get(rel) == Some(&hashes);
    let bm25_current = bm25_pages.contains(rel);
    if dense_current && bm25_current {
        return None; // both already reflect this content
    }
    // Past this point at least one side needs updating. Upsert BM25
    // unconditionally — cheap and idempotent — before `chunks` moves into
    // `embed_texts` (in the async caller), covering both "dense is stale"
    // (re-embed case) and "dense is current but BM25 never had this page"
    // (bootstrap case).
    bm25.upsert_page(rel, stem, &chunks);
    Some((chunks, hashes, dense_current))
}

/// Bring one page's chunks up to date in both `store` (dense) and `bm25`
/// (lexical), unless BOTH already reflect this page's current content.
/// Shared by `reindex_embeddings` and the incremental index updater — this is
/// the only place that decides "does this page need (re-)indexing".
///
/// The two indexes are gated independently: `store` is current when its
/// content hashes (`existing`) match the page's freshly computed hashes;
/// `bm25` is current when `bm25_pages` (a snapshot of `bm25.pages()`) already
/// contains this page. A page can need only one side updated — most notably,
/// bootstrapping a fresh/dropped `.mxb` against an already-current `.mxv`
/// (first launch after this feature ships, or a `.mxb` a user deleted) skips
/// every page's dense re-embed via the content-hash match, but BM25 must
/// still receive every page or it never gets built at all. When the dense
/// side IS stale, BM25 is re-upserted unconditionally alongside it (not
/// gated on `bm25_pages`) since `bm25.upsert_page` has no per-page staleness
/// signal of its own and is idempotent to call again.
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
) -> Result<EmbedOutcome, String> {
    let Some((chunks, hashes, dense_current)) =
        sync_bm25_for_page(content, rel, stem, existing, bm25, bm25_pages)
    else {
        return Ok(EmbedOutcome {
            embedded: false,
            changed: false,
        });
    };
    if dense_current {
        // Dense already matches; BM25 alone needed catching up. No re-embed.
        return Ok(EmbedOutcome {
            embedded: false,
            changed: true,
        });
    }
    let vecs = embed_texts(
        app.clone(),
        (*llm).clone(),
        provider,
        model,
        crate::local_llm::EmbedRole::Document,
        chunks,
    )
    .await?;
    let entries: Vec<(u64, Vec<f32>)> = hashes.into_iter().zip(vecs).collect();
    store.upsert_page(rel, stem, entries);
    Ok(EmbedOutcome {
        embedded: true,
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
/// embedding one chunk measures ~467 ms, so a 300-chunk vault is over two
/// minutes — and it used to run behind nothing but a disabled button.
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
    let t0 = std::time::Instant::now();
    let root = require_root(&vault)?;
    let index_path = VectorStore::path_for(&root.to_string_lossy())?;
    let bm25_path = crate::retrieval::Bm25Index::path_for(&root.to_string_lossy())?;
    // Read through, not from the cache: this needs an owned, mutable store, and
    // embedding the pages dwarfs the read either way.
    let mut store = VectorStore::load(&index_path);
    // BM25 is never model-gated (see `embed_one_page`'s doc comment): it is
    // loaded as-is and re-upserted alongside the store regardless of which
    // embed model this reindex targets.
    let mut bm25 = crate::retrieval::Bm25Index::load(&bm25_path);
    let load_ms = perf::ms(t0.elapsed());
    let model_id = format!("{provider}:{model}");
    store.ensure_model(&model_id);

    // Embedding a page costs far more than a checkpoint write, so checkpoint on
    // elapsed time rather than a page count: work lost to a crash is bounded by
    // the interval, and the write overhead stays a fixed fraction of it however
    // fast or slow the provider is. A page-count rule cannot promise either —
    // 50 pages is seconds on one vault and minutes on another.
    const CHECKPOINT_EVERY: std::time::Duration = std::time::Duration::from_secs(30);

    let pages = collect_wiki_pages(&root);
    // One pass over the records instead of a full scan per page.
    let existing = store.hashes_by_page();
    // Snapshot once, same as `existing` — a page can need only a BM25 upsert
    // (dense already current) when this snapshot doesn't contain it yet, e.g.
    // bootstrapping a fresh `.mxb` against an already-current `.mxv`.
    let bm25_pages = bm25.pages();
    let mut present = std::collections::HashSet::new();
    let mut embed_ms = 0.0;
    let mut save_ms = 0.0;
    let mut embedded = 0usize;
    let mut checkpoints = 0usize;
    let mut dirty = false;
    let mut last_checkpoint = std::time::Instant::now();
    let total = pages.len();
    for (i, (rel, stem, content)) in pages.iter().enumerate() {
        present.insert(rel.clone());
        let t_embed = std::time::Instant::now();
        let outcome = embed_one_page(
            &app,
            &llm,
            &provider,
            &model,
            rel,
            stem,
            content,
            &existing,
            &mut store,
            &mut bm25,
            &bm25_pages,
        )
        .await?;
        if outcome.embedded {
            embed_ms += perf::ms(t_embed.elapsed());
            embedded += 1;
        }
        if outcome.changed {
            dirty = true;
        }
        {
            use tauri::Emitter;
            let _ = app.emit(
                "reindex-progress",
                ReindexProgress {
                    done: i + 1,
                    total,
                    page: rel.clone(),
                    // Reports whether the DENSE side was re-embedded, not
                    // whether anything changed at all — a BM25-only catch-up
                    // must not read to the user as "re-embedded this page".
                    embedded: outcome.embedded,
                },
            );
        }
        if !outcome.changed {
            continue; // nothing changed on either side
        }

        // Checkpoint. Without this, a crash or quit during the first index of a
        // large vault threw away every embedding computed so far — the most
        // expensive work the app does, and the run most likely to be
        // interrupted because it is the longest. The partial index is valid on
        // its own: pruning is deferred to the final save, so a checkpoint only
        // ever adds pages, and the content-hash skip above lets the next run
        // resume instead of restart.
        if last_checkpoint.elapsed() >= CHECKPOINT_EVERY {
            let t_save = std::time::Instant::now();
            // `.mxb` saved BEFORE `.mxv`: a rerun's re-embed decision is
            // gated on the store's on-disk content hashes, so if `.mxv` were
            // saved first and `.mxb` then failed, a later rerun would see
            // those pages' hashes already current, skip re-embedding them,
            // and never get a chance to re-upsert BM25 for them. Saving
            // `.mxb` first means a failure here aborts (via `?`) before the
            // store checkpoint lands, so the pages stay eligible for re-embed
            // (and re-upsert into both indexes) on the next run.
            bm25.save(&bm25_path)?;
            store.save(&index_path)?;
            save_ms += perf::ms(t_save.elapsed());
            checkpoints += 1;
            dirty = false;
            last_checkpoint = std::time::Instant::now();
        }
    }
    let pruned = store.prune(&present);
    let bm25_pruned = bm25.prune(&present) > 0;
    // The final save is skippable only when nothing changed at all — no page
    // embedded since the last checkpoint, and no stale page dropped.
    if dirty || pruned > 0 || bm25_pruned || checkpoints == 0 {
        let t_save = std::time::Instant::now();
        bm25.save(&bm25_path)?; // see the checkpoint save above for why this order matters
        store.save(&index_path)?;
        save_ms += perf::ms(t_save.elapsed());
    }
    // Hand the freshly built store to the cache so the searches that follow a
    // reindex reuse it instead of re-reading what we just wrote.
    let indexed = store.indexed_pages();
    perf::log(
        "reindex_embeddings",
        &[
            ("load_store_ms", load_ms),
            ("embed_ms", embed_ms),
            // Every save this run: the checkpoints plus the final one.
            ("save_ms", save_ms),
            ("total_ms", perf::ms(t0.elapsed())),
            ("pages", pages.len() as f64),
            // Pages that actually needed embedding; the rest hit the
            // content-hash skip.
            ("embedded_pages", embedded as f64),
            ("checkpoints", checkpoints as f64),
            ("records", store.records.len() as f64),
        ],
    );
    cache.put(&index_path, store);
    bm25_cache.put(&bm25_path, bm25);
    Ok(indexed)
}

/// A retrieval hit carrying the matching chunk's TEXT, so callers inline the
/// passage instead of re-reading the whole page. `text` is reconstructed at
/// query time from the page (the index stores only vectors+hashes).
#[derive(Clone, serde::Serialize)]
pub struct ScoredChunk {
    pub page: String,
    pub stem: String,
    pub section: usize,
    pub text: String,
    /// Fusion score from `rrf_fuse` — `Σ 1/(RRF_K + rank)` over the dense and
    /// lexical rankings. RANK-based, so it is scale-free: the top hit of a
    /// perfect match and the top hit of a nonsense query score the same. Good
    /// for ordering, USELESS as a confidence measure — use `similarity`.
    pub score: f32,
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
}

/// The `section`-th chunk of `content` under the same `chunk_page` split the
/// index was built with. `None` if `section` is out of range (e.g. the page was
/// edited after indexing) — the caller drops such a hit.
fn chunk_text_at(content: &str, section: usize) -> Option<String> {
    crate::embeddings::chunk_page(content)
        .into_iter()
        .nth(section)
}

/// Semantic search: embed the query, return top-`k` chunk hits from the index,
/// with each hit's chunk TEXT reconstructed so callers (e.g. Ask) can inline the
/// passage instead of re-reading the whole page.
// Four of the arguments are Tauri-injected state rather than things a caller
// passes; the invocable surface is (query, k, provider, model).
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
) -> Result<Vec<ScoredChunk>, String> {
    let t0 = std::time::Instant::now();
    let root = require_root(&vault)?;
    let index_path = VectorStore::path_for(&root.to_string_lossy())?;
    let store = cache.get(&index_path);
    let load_ms = perf::ms(t0.elapsed());
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
    let k = k.clamp(1, 50);
    let t_embed = std::time::Instant::now();
    let mut q = embed_texts(
        app,
        llm,
        &provider,
        &model,
        crate::local_llm::EmbedRole::Query,
        vec![query.clone()],
    )
    .await?;
    let embed_ms = perf::ms(t_embed.elapsed());
    let qv = q.pop().unwrap_or_default();
    let t_scan = std::time::Instant::now();
    // Pull a candidate pool from each arm wider than `k` before fusing: RRF
    // needs enough overlap between the dense and lexical rankings to reorder
    // usefully, and a lexical-only top hit outside the dense top-k would
    // never surface if both arms were pre-truncated to k.
    let pool = (k * 5).clamp(20, 50);
    // At most this many chunks from any one page. Measured on the real vault
    // (`examples/corpus_mix_probe.rs`, 14.5k chunks): 2 raised distinct pages
    // across the query set from 87 to 95 with no query getting worse, while 1
    // was worse — it evicted a page's genuinely-relevant second chunk (the BPE
    // query dropped from 12 wiki hits to 9, backfilled with session noise).
    const PAGE_CAP: usize = 2;
    let dense_hits = store.search(&qv, pool);
    let bm25_path = crate::retrieval::Bm25Index::path_for(&root.to_string_lossy())?;
    let bm25 = bm25_cache.get(&bm25_path);
    let lexical_hits = bm25.search(&query, pool);
    // If the lexical index is empty (fresh vault, or `.mxb` not yet
    // bootstrapped), `rrf_fuse` degrades to the dense order unchanged — see
    // `rrf_fuse_empty_lexical_preserves_dense_order` in retrieval.rs.
    // Keep each candidate's DENSE COSINE before fusing: rrf_fuse replaces score
    // with a rank-based value, which orders well but says nothing about whether
    // a hit is relevant at all. Callers need the cosine to reject "nothing in
    // the vault answers this" instead of presenting the least-bad chunks.
    let dense_by_id: std::collections::HashMap<(String, usize), f32> = dense_hits
        .iter()
        .map(|h| ((h.page.clone(), h.section), h.score))
        .collect();
    // Fuse WIDER than k, then cap chunks-per-page, then cut to k. Fusing
    // straight to k and capping after would only shrink the list — the whole
    // point of the cap is to let a DISTINCT page take the slot a near-duplicate
    // would have held.
    let fused = crate::retrieval::rrf_fuse(&dense_hits, &lexical_hits, pool);
    let hits = crate::retrieval::cap_per_page(fused, PAGE_CAP, k);
    let scan_ms = perf::ms(t_scan.elapsed());
    // Reconstruct each hit's chunk TEXT from its page (the index stores only
    // vectors+hashes). No cross-hit cache: k is capped at 50 (realistically
    // <=12), pages are small markdown files, and re-reading one a second hit
    // shares is not a measurable cost — so this just calls the pure helper.
    let t_reconstruct = std::time::Instant::now();
    let mut out: Vec<ScoredChunk> = Vec::with_capacity(hits.len());
    for h in hits {
        let Ok(content) = std::fs::read_to_string(root.join(&h.page)) else {
            continue;
        };
        match chunk_text_at(&content, h.section) {
            Some(text) if !text.trim().is_empty() => out.push(ScoredChunk {
                similarity: dense_by_id.get(&(h.page.clone(), h.section)).copied(),
                page: h.page,
                stem: h.stem,
                section: h.section,
                text,
                score: h.score,
            }),
            _ => {} // missing file or stale section index → skip
        }
    }
    perf::log(
        "semantic_search",
        &[
            ("load_store_ms", load_ms),
            ("embed_query_ms", embed_ms),
            ("scan_ms", scan_ms),
            ("reconstruct_ms", perf::ms(t_reconstruct.elapsed())),
            ("total_ms", perf::ms(t0.elapsed())),
            ("records", store.records.len() as f64),
            ("returned", out.len() as f64),
        ],
    );
    Ok(out)
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
/// (provider, model) in a single batched call and cached for the process.
#[tauri::command]
pub async fn classify_intent(
    app: tauri::AppHandle,
    llm: tauri::State<'_, LocalLlmState>,
    query: String,
    provider: String,
    model: String,
) -> Result<Option<QueryIntent>, String> {
    use crate::embeddings::cosine;
    let texts = crate::intent::exemplar_texts();
    // The exemplars and the query go through one embed call each. bge-m3 is
    // prefix-free (its EmbedSpec query/doc prefixes are empty), so the roles
    // below do not change the vectors for the bundled model — they are still
    // passed correctly so a future asymmetric embedder needs no change here.
    let key = format!("{provider}:{model}");
    let cached = {
        let guard = exemplar_cache().lock().unwrap_or_else(|e| e.into_inner());
        guard
            .as_ref()
            .filter(|(k, _)| *k == key)
            .map(|(_, v)| v.clone())
    };
    let exemplar_vecs = match cached {
        Some(v) => v,
        None => {
            let v = embed_texts(
                app.clone(),
                llm.clone(),
                &provider,
                &model,
                crate::local_llm::EmbedRole::Document,
                texts.clone(),
            )
            .await?;
            let mut guard = exemplar_cache().lock().unwrap_or_else(|e| e.into_inner());
            *guard = Some((key, v.clone()));
            v
        }
    };
    let mut q = embed_texts(
        app,
        llm,
        &provider,
        &model,
        crate::local_llm::EmbedRole::Query,
        vec![query],
    )
    .await?;
    let qv = q.pop().unwrap_or_default();
    let sims: Vec<f32> = exemplar_vecs.iter().map(|e| cosine(&qv, e)).collect();
    Ok(
        crate::intent::best_intent(&sims).map(|(intent, similarity)| QueryIntent {
            intent: intent.to_string(),
            similarity,
        }),
    )
}

/// Embedded exemplars, keyed by `"{provider}:{model}"` so a model switch
/// re-embeds instead of cosining across incompatible vector spaces.
// (cache key, embedded exemplars) behind a lock — naming the tuple would not
// make the signature say more than it already does.
#[allow(clippy::type_complexity)]
fn exemplar_cache() -> &'static Mutex<Option<(String, Vec<Vec<f32>>)>> {
    #[allow(clippy::type_complexity)]
    static CACHE: OnceLock<Mutex<Option<(String, Vec<Vec<f32>>)>>> = OnceLock::new();
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
    let store = cache.get(&index_path);
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
    if builtin_index_is_stale(&provider, &model) {
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
    let vecs = embed_texts(
        app,
        llm,
        &provider,
        &model,
        crate::local_llm::EmbedRole::Query,
        chunks,
    )
    .await?;
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
    let per_chunk: Vec<Vec<VecHit>> = vecs
        .iter()
        .map(|v| {
            let dense = store.search(v, FUSE_POOL);
            crate::pipeline::dense_chunk_matches(&dense)
        })
        .collect();
    let out = crate::pipeline::rank_candidates(&per_chunk, k.clamp(1, 20));
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
    let store = cache.get(&index_path);
    if store.records.is_empty() {
        return Ok(Vec::new());
    }
    let t0 = std::time::Instant::now();
    let out = tauri::async_runtime::spawn_blocking(move || {
        crate::vector_index::semantic_map_points(&store.page_centroids())
    })
    .await
    .map_err(|e| format!("semantic map task failed: {e}"))?;
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
    let store = cache.get(&index_path);
    let load_ms = perf::ms(t0.elapsed());
    let records = store.records.len();
    let t_scan = std::time::Instant::now();
    let hits = tauri::async_runtime::spawn_blocking(move || store.related(&page, k.clamp(1, 50)))
        .await
        .map_err(|e| format!("join failed: {e}"))?;
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
/// it: `lookup_edges` hands back the store, the work happens on the blocking
/// pool, and `store_edges` files the result only if that store is still current.
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

    let (edges, computed) = match cache.lookup_edges(&index_path, k) {
        EdgeLookup::Ready(edges) => (edges, false),
        EdgeLookup::Empty => (Arc::new(Vec::new()), false),
        EdgeLookup::Compute(store) => {
            let for_pass = Arc::clone(&store);
            let built = tauri::async_runtime::spawn_blocking(move || for_pass.centroid_edges(k))
                .await
                .map_err(|e| format!("join failed: {e}"))?;
            let built = Arc::new(built);
            cache.store_edges(&index_path, k, &store, Arc::clone(&built));
            (built, true)
        }
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
pub fn embeddings_status(
    vault: tauri::State<'_, VaultRoot>,
    cache: tauri::State<'_, VectorCache>,
) -> Result<EmbeddingsStatus, String> {
    let root = require_root(&vault)?;
    let index_path = VectorStore::path_for(&root.to_string_lossy())?;
    let store = cache.get(&index_path);
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

#[cfg(test)]
mod tests {
    use super::{
        builtin_index_is_stale, chunk_text_at, external_target_allowed, import_dest, run_import,
        sync_bm25_for_page, windows_opener_safe, DEST_INBOX, DEST_SESSIONS,
    };
    use crate::retrieval::{rrf_fuse, Bm25Cache, Bm25Index};
    use crate::vector_index::Hit;
    use std::collections::{HashMap, HashSet};
    use std::path::PathBuf;

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

        let (_, _, dense_current) =
            outcome.expect("bm25 missing the page must still signal an update");
        assert!(
            dense_current,
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
            bm25.is_empty(),
            "must not have upserted anything into bm25 in the both-current case"
        );
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
        // A store still tagged with the model the bge-m3 swap retired (Task 4)
        // must report stale — `wikify_candidates` degrades to Ok(empty) for
        // this, rather than propagating embed_texts's "unknown builtin embed
        // model" error.
        assert!(builtin_index_is_stale("builtin-local", "gemma-3-1b"));
        // The current bundled winner is not stale.
        assert!(!builtin_index_is_stale("builtin-local", "bge-m3"));
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
}
