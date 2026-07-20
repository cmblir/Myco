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
async fn with_local_llm<T, F>(
    app: tauri::AppHandle,
    state: tauri::State<'_, LocalLlmState>,
    f: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&LocalLlm) -> Result<T, String> + Send + 'static,
{
    use tauri::Emitter;
    let cell = state.0.clone();
    let path = local_model_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = cell.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            let _ = app.emit("local-model-load", ModelLoadEvent { loading: true, ok: false });
            let loaded = LocalLlm::load(&path);
            // Announce the end on the failure path too — a UI that only hears
            // "loading" would show a spinner forever.
            let _ = app.emit(
                "local-model-load",
                ModelLoadEvent { loading: false, ok: loaded.is_ok() },
            );
            *guard = Some(loaded?);
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
    vault::create_file(&p.to_string_lossy(), &name, &content)
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
fn run_import(
    root: &std::path::Path,
    files: &[PathBuf],
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
            let res = (|| -> Result<(usize, usize, Vec<QuarantinedConversation>, String), String> {
                let len = stamp.map(|(_, l)| l);
                if let Some(len) = len {
                    if len > MAX_BYTES {
                        return Err(format!("too large ({} MB); split it first", len / (1024 * 1024)));
                    }
                }
                let content = std::fs::read_to_string(f).map_err(|e| format!("cannot read: {e}"))?;
                apply_import(root, &mut ledger, &path_str, &content)
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
                Err(error) => failed.push(FailedImport { path: path_str, error }),
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
        Ok(run_import(&root, &[PathBuf::from(source_path)], |p| {
            use tauri::Emitter;
            let _ = app.emit("import-progress", p);
        }))
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
) -> Result<ImportOutcome, String> {
    let root = require_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let files: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
        Ok(run_import(&root, &files, |p| {
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
) -> Result<(usize, usize, Vec<QuarantinedConversation>, String), String> {
    let plan = crate::importers::plan_import(filename, content, ledger)?;
    let inbox = root.join("_inbox");
    std::fs::create_dir_all(&inbox).map_err(|e| format!("create _inbox: {e}"))?;
    let mut imported = 0;
    for doc in &plan.docs {
        std::fs::write(inbox.join(format!("{}.md", doc.stem)), &doc.body)
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

/// Import every session Memex can find on disk for one CLI tool, in one pass.
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
        let mut files = Vec::new();
        collect_jsonl(&dir, &mut files, 0);
        Ok(run_import(&root, &files, |p| {
            use tauri::Emitter;
            let _ = app.emit("import-progress", p);
        }))
    })
    .await
    .map_err(|e| format!("join failed: {e}"))?
}

/// The on-disk session directory for a CLI tool.
fn session_dir(kind: &str) -> Result<PathBuf, String> {
    let home = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .unwrap_or_default();
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
    !target.contains([
        '&', '|', '<', '>', '^', '"', '%', '(', ')', '\n', '\r',
    ])
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
use crate::perf;
use crate::vector_index::{EdgeLookup, Hit as VecHit, VectorCache, VectorStore};

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
        // Non-following walk: a symlinked directory under wiki/ must not pull
        // files from outside the vault into the embedding index.
        for (e, kind) in vault::vault_entries(dir) {
            let p = e.path();
            if kind.is_dir() {
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
    provider: String,
    model: String,
) -> Result<usize, String> {
    let t0 = std::time::Instant::now();
    let root = require_root(&vault)?;
    let index_path = VectorStore::path_for(&root.to_string_lossy())?;
    // Read through, not from the cache: this needs an owned, mutable store, and
    // embedding the pages dwarfs the read either way.
    let mut store = VectorStore::load(&index_path);
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
        let chunks = embeddings::chunk_page(content);
        let hashes: Vec<u64> = chunks.iter().map(|c| embeddings::content_hash(c)).collect();
        let unchanged = chunks.is_empty() || existing.get(rel) == Some(&hashes);
        {
            use tauri::Emitter;
            let _ = app.emit(
                "reindex-progress",
                ReindexProgress {
                    done: i + 1,
                    total,
                    page: rel.clone(),
                    embedded: !unchanged,
                },
            );
        }
        if unchanged {
            continue; // nothing to embed, or the content hashes still match
        }
        let t_embed = std::time::Instant::now();
        let vecs = embed_texts(app.clone(), llm.clone(), &provider, &model, chunks).await?;
        embed_ms += perf::ms(t_embed.elapsed());
        embedded += 1;
        let entries: Vec<(u64, Vec<f32>)> = hashes.into_iter().zip(vecs).collect();
        store.upsert_page(rel, stem, entries);
        dirty = true;

        // Checkpoint. Without this, a crash or quit during the first index of a
        // large vault threw away every embedding computed so far — the most
        // expensive work the app does, and the run most likely to be
        // interrupted because it is the longest. The partial index is valid on
        // its own: pruning is deferred to the final save, so a checkpoint only
        // ever adds pages, and the content-hash skip above lets the next run
        // resume instead of restart.
        if last_checkpoint.elapsed() >= CHECKPOINT_EVERY {
            let t_save = std::time::Instant::now();
            store.save(&index_path)?;
            save_ms += perf::ms(t_save.elapsed());
            checkpoints += 1;
            dirty = false;
            last_checkpoint = std::time::Instant::now();
        }
    }
    let pruned = store.prune(&present);
    // The final save is skippable only when nothing changed at all — no page
    // embedded since the last checkpoint, and no stale page dropped.
    if dirty || pruned > 0 || checkpoints == 0 {
        let t_save = std::time::Instant::now();
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
    Ok(indexed)
}

/// Semantic search: embed the query, return top-`k` chunk hits from the index.
// Four of the arguments are Tauri-injected state rather than things a caller
// passes; the invocable surface is (query, k, provider, model).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn semantic_search(
    app: tauri::AppHandle,
    vault: tauri::State<'_, VaultRoot>,
    llm: tauri::State<'_, LocalLlmState>,
    cache: tauri::State<'_, VectorCache>,
    query: String,
    k: usize,
    provider: String,
    model: String,
) -> Result<Vec<VecHit>, String> {
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
    let t_embed = std::time::Instant::now();
    let mut q = embed_texts(app, llm, &provider, &model, vec![query]).await?;
    let embed_ms = perf::ms(t_embed.elapsed());
    let qv = q.pop().unwrap_or_default();
    let t_scan = std::time::Instant::now();
    let hits = store.search(&qv, k.clamp(1, 50));
    perf::log(
        "semantic_search",
        &[
            ("load_store_ms", load_ms),
            ("embed_query_ms", embed_ms),
            ("scan_ms", perf::ms(t_scan.elapsed())),
            ("total_ms", perf::ms(t0.elapsed())),
            ("records", store.records.len() as f64),
        ],
    );
    Ok(hits)
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

    // Cap the chunks embedded: a long transcript would otherwise cost seconds.
    // The leading chunks capture the source's subject matter well enough to
    // retrieve its candidate pages (spread-sampling is a later refinement).
    const MAX_CHUNKS: usize = 8;
    let mut chunks = crate::embeddings::chunk_page(&source_text);
    chunks.truncate(MAX_CHUNKS);
    if chunks.is_empty() {
        return Ok(Vec::new());
    }
    let n_chunks = chunks.len();
    // One batched embed call shares a llama context across the chunks.
    let vecs = embed_texts(app, llm, &provider, &model, chunks).await?;
    // Per chunk, retrieve extra hits then keep only knowledge pages, so
    // source-summaries don't crowd out real update targets before the fold.
    let per_chunk: Vec<Vec<VecHit>> = vecs
        .iter()
        .map(|v| {
            store
                .search(v, 16)
                .into_iter()
                .filter(|h| crate::pipeline::is_knowledge_page(&h.stem))
                .collect()
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
    use super::{external_target_allowed, run_import, windows_opener_safe};
    use std::path::PathBuf;

    // A Claude Code session line (parses to one conversation via the importer).
    fn session_line(id: &str, text: &str) -> String {
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
        let outcome = run_import(root, &files, |p| progress.push(p));

        assert_eq!(outcome.imported, 2);
        assert_eq!(outcome.failed.len(), 1);
        assert_eq!(outcome.failed[0].path, missing.to_string_lossy());
        assert!(outcome.failed[0].error.contains("cannot read"));
        assert_eq!(outcome.source, "claude-code");
        // Two inbox docs written.
        let inbox = root.join("_inbox");
        let n = std::fs::read_dir(&inbox).unwrap().filter(|e| {
            e.as_ref()
                .unwrap()
                .path()
                .extension()
                .map(|x| x == "md")
                .unwrap_or(false)
        }).count();
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
    fn run_import_dedups_on_a_second_run() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let f = root.join("a.jsonl");
        std::fs::write(&f, session_line("s1", "hello there")).unwrap();
        let files = vec![f];

        let first = run_import(root, &files, |_| {});
        assert_eq!(first.imported, 1);
        assert_eq!(first.skipped, 0);
        // Same files again: unchanged, so the file is skipped without a re-read
        // and its one conversation counts as already imported.
        let second = run_import(root, &files, |_| {});
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

        let first = run_import(root, &files, |_| {});
        assert_eq!(first.imported, 1);

        // The session grew (different length → the stamp no longer matches even
        // if the mtime clock is coarse): it must be read again and re-imported
        // as an update, not skipped.
        std::fs::write(&f, session_line("s1", "hello there, a much longer continuation")).unwrap();
        let second = run_import(root, &files, |_| {});
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
        let _ = run_import(root, &files, |_| count += 1);
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
}
