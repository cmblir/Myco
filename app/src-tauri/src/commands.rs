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

pub(crate) fn require_root(state: &tauri::State<VaultRoot>) -> Result<PathBuf, String> {
    state.get().ok_or_else(|| "no vault is open".to_string())
}

/// Lazily-loaded local model host. `None` until the first local_* command;
/// model weights must not tax startup or RAM when the feature is unused. Arc
/// so inference can run on a blocking thread. Since the Gemma GGUF left the
/// bundle this usually hosts only the embedder (bge-m3); a chat GGUF present
/// on disk (dev tree / older install) is still picked up.
#[derive(Default, Clone)]
pub struct LocalLlmState(Arc<Mutex<Option<LocalLlm>>>);

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

/// Drop the local model after 10 idle minutes. The weights are ~400 MB of RAM
/// that a memory-pressed machine feels immediately (measured: launching the
/// app pushed a 16 MB-free machine into a swap storm); the cost of coming
/// back is one lazy reload on the next embed/search, announced on
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
    Ok(meta)
}

#[tauri::command]
pub fn ensure_default_vault() -> Result<String, String> {
    vault::ensure_default_vault()
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
pub(crate) fn voice_markdown(transcript: &str, captured_at: i64, related: &[String]) -> String {
    let first = transcript
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    let title: String = if first.is_empty() {
        "Voice note".to_string()
    } else {
        first.chars().take(80).collect()
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
    /// Wiki stems the transcript echoes (dense lookup, best-effort — empty on
    /// any lookup failure). The note's frontmatter carries the same list.
    pub related: Vec<String>,
}

/// Cosine floor for a "related page" suggestion on a voice note — the same
/// measured relevance floor Ask uses to reject irrelevant hits (chat.ts
/// RELEVANCE_FLOOR, e5-small-ko abstention probe). Below it a suggestion is
/// noise, and a wrong "related" line teaches the user to ignore the feature.
const VOICE_RELATED_FLOOR: f32 = 0.42;
/// How many related stems a voice note carries at most.
const VOICE_RELATED_K: usize = 3;

/// Blocking transcription half of `save_voice_capture`: temp audio file
/// (cli_agent.rs's `myco-<purpose>-<pid>-<nanos>` pattern) → whisper →
/// transcript. Writes nothing to the vault. The whisper check runs FIRST so
/// a missing CLI writes nothing at all, and the temp file is deleted on
/// every path (success and transcription failure).
fn transcribe_voice_core(app: &tauri::AppHandle, bytes: &[u8]) -> Result<String, String> {
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
    let transcribed = crate::whisper::transcribe(app, &tmp.to_string_lossy());
    let _ = std::fs::remove_file(&tmp);
    transcribed
}

/// Blocking write half: `_inbox/voice-<date>.md` carrying the transcript and
/// the related stems.
fn write_voice_note(
    root: &std::path::Path,
    transcript: &str,
    related: &[String],
) -> Result<VoiceSaved, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let rel = voice_inbox_rel(root, now);
    let path = crate::myco_pro::safe_join(root, &rel)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create _inbox: {e}"))?;
    }
    std::fs::write(&path, voice_markdown(transcript, now, related))
        .map_err(|e| format!("write voice note: {e}"))?;
    crate::inflow_log::record(root, "voice", "capture");
    Ok(VoiceSaved {
        rel,
        related: related.to_vec(),
    })
}

/// Save a spotlight voice capture into the OPEN vault's `_inbox/`. Takes no
/// vault arg: the spotlight webview has no vault open to name, so the target
/// is `require_root` — the same root every other write command confines to.
/// `Err("whisper-missing")` before anything is written when no whisper CLI is
/// on PATH; the frontend shows install copy and stays in ask mode.
///
/// Between transcription and the write, the transcript runs through the same
/// dense lookup ingest grounding uses (`wikify_candidates`) to stamp the
/// note with the wiki pages it echoes. Advisory only: any lookup failure —
/// stale index, cold vault, no model — degrades to an empty list, because a
/// voice memo is unreproducible and must never be lost to a suggestion.
#[tauri::command]
pub async fn save_voice_capture(
    app: tauri::AppHandle,
    state: tauri::State<'_, VaultRoot>,
    llm: tauri::State<'_, LocalLlmState>,
    cache: tauri::State<'_, VectorCache>,
    bytes: Vec<u8>,
) -> Result<VoiceSaved, String> {
    let root = require_root(&state)?;
    let transcribe_app = app.clone();
    let transcript = tauri::async_runtime::spawn_blocking(move || {
        transcribe_voice_core(&transcribe_app, &bytes)
    })
    .await
    .map_err(|e| format!("join failed: {e}"))??;
    let related: Vec<String> = match wikify_candidates(
        app,
        state,
        llm,
        cache,
        transcript.clone(),
        VOICE_RELATED_K,
    )
    .await
    {
        Ok(cands) => cands
            .into_iter()
            .filter(|c| c.score >= VOICE_RELATED_FLOOR)
            .map(|c| c.stem)
            .collect(),
        Err(_) => Vec::new(),
    };
    tauri::async_runtime::spawn_blocking(move || write_voice_note(&root, &transcript, &related))
        .await
        .map_err(|e| format!("join failed: {e}"))?
}

// ---- notch quick text capture (notch S7) ------------------------------------

/// Append one `- HH:MM <text>` line to the LOCAL day's `daily/YYYY-MM-DD.md`,
/// seeding a missing file with its `# date` heading — the exact convention
/// PageTasks' addTask + taskLine::appendTaskLine established (trailing
/// whitespace collapsed to exactly one newline before the append).
/// `tz_offset_min` is the webview's local-time offset: daily notes bucket on
/// the user's calendar day (taskLine::today is local), and Rust std only
/// knows UTC. Returns the vault-relative path that was written.
pub(crate) fn capture_note_at(
    root: &std::path::Path,
    text: &str,
    now_utc: i64,
    tz_offset_min: i32,
) -> Result<String, String> {
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
    let body = existing.trim_end();
    let content = if body.is_empty() {
        format!("{line}\n")
    } else {
        format!("{body}\n{line}\n")
    };
    std::fs::write(&path, content).map_err(|e| format!("write {rel}: {e}"))?;
    Ok(rel)
}

/// Notch S7 quick capture (⏎ in the notch input). Vault-required like every
/// other write — the notch webview never learns the vault path.
#[tauri::command]
pub fn capture_note(
    state: tauri::State<VaultRoot>,
    text: String,
    tz_offset_min: i32,
) -> Result<String, String> {
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
    let rel = capture_note_at(&root, &text, now, tz_offset_min)?;
    if let Some(u) = crate::INDEX_UPDATER.get() {
        u.mark_dirty(rel.clone());
    }
    Ok(rel)
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
pub fn list_inbox_entries(
    state: tauri::State<VaultRoot>,
    vault: String,
) -> Result<Vec<InboxEntry>, String> {
    let root = confine_root(&state, &vault)?;
    Ok(inbox_entries(std::path::Path::new(&root)))
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
    std::fs::copy(src, &dest).map_err(|e| format!("copy failed: {e}"))?;
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

/// Persist one board document (`.myco/dashboards/<name>.json`).
#[tauri::command]
pub fn save_dashboard(
    state: tauri::State<VaultRoot>,
    name: String,
    content: String,
) -> Result<(), String> {
    save_myco_json(&require_root(&state)?, "dashboards", &name, &content)
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
    effort: Option<String>,
) -> Result<CliResult, String> {
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
) -> Result<CliResult, String> {
    use tauri::Emitter;
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
    effort: Option<String>,
) -> Result<CliResult, String> {
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

/// Build the `embed` closure `distill::run` wants (a plain synchronous `Fn`,
/// so its own tests can inject synthetic vectors) and run `f` with it on a
/// blocking-pool thread — the closure's own `block_on(embed_texts(...))`
/// call cannot run on the caller's async task without panicking ("cannot
/// block the current thread from within a runtime").
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

/// Idle-run orchestrator (Task 6, Phase A): partitions sessions, freshens the
/// ontology cache if the wiki moved, scores/quarantines/rejects new inflow,
/// archives already-represented raw sources, sweeps expired quarantine past
/// its TTL, and writes a run manifest + human report — see `distill::run`'s
/// own doc comment for the full step list.
///
/// `distill::run` resolves its OWN copy of the vault's `VectorStore`
/// internally (it takes no cache/state, unlike this command — see its doc
/// comment), so this duplicates one disk read against the cached copy just
/// to pick the same embed model `run` will independently load. Degrading to
/// a zero-valued report here, before `run` ever starts, keeps a stale index
/// from failing mid-run instead of not running at all.
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

/// Newest-first summaries of persisted run manifests — the Settings run list
/// (Q4 item 3).
#[tauri::command]
pub fn list_distill_runs(
    state: tauri::State<VaultRoot>,
    vault: String,
    limit: Option<usize>,
) -> Result<Vec<crate::distill::RunSummary>, String> {
    let root = confine_root(&state, &vault)?;
    Ok(crate::distill::list_runs(
        std::path::Path::new(&root),
        limit.unwrap_or(20),
    ))
}

/// One run's full manifest, WHY-report presence, and git commit — the run-log
/// drill-in (W3–6 item 6). See `distill::run_detail`.
#[tauri::command]
pub fn distill_run_detail(
    state: tauri::State<VaultRoot>,
    vault: String,
    id: String,
) -> Result<crate::distill::RunDetail, String> {
    let root = confine_root(&state, &vault)?;
    crate::distill::run_detail(std::path::Path::new(&root), &id)
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
pub fn page_authorship(
    state: tauri::State<VaultRoot>,
    vault: String,
    rel: String,
) -> Result<Option<crate::vault_history::PageAuthorship>, String> {
    let root = confine_root(&state, &vault)?;
    let root = std::path::Path::new(&root);
    crate::myco_pro::safe_join(root, &rel)?; // reject path escape before git sees it
    crate::vault_history::page_authorship(root, &rel)
}

/// wiki/ rel -> ever committed by the agent author — the sidebar's
/// "human only" filter. One log walk; `{}` when the vault has no history.
#[tauri::command]
pub fn authorship_index(
    state: tauri::State<VaultRoot>,
    vault: String,
) -> Result<std::collections::HashMap<String, bool>, String> {
    let root = confine_root(&state, &vault)?;
    crate::vault_history::agent_touched_index(std::path::Path::new(&root))
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

/// Files and bytes held by every `sessions/archive/` and `daily/archive/`
/// bucket — the numbers behind the Settings → Distill storage panel. Computed
/// on demand (this command), never on render. `raw/archive/` is deliberately
/// not measured here: it is immutable, so its size is not actionable.
#[tauri::command]
pub fn archive_usage(
    state: tauri::State<VaultRoot>,
    vault: String,
) -> Result<Vec<crate::archive_pack::BucketUsage>, String> {
    let root = confine_root(&state, &vault)?;
    Ok(crate::archive_pack::usage(std::path::Path::new(&root)))
}

/// Pack every session/daily archive bucket older than `older_than_months`
/// into one zip each. USER-TRIGGERED ONLY — no scheduler, no distill chain,
/// no auto-run reaches this. `raw/` is never touched (see `archive_pack`'s
/// module comment and its `TREES` list).
#[tauri::command]
pub fn compress_archives(
    state: tauri::State<VaultRoot>,
    vault: String,
    older_than_months: u32,
) -> Result<crate::archive_pack::PackReport, String> {
    let root = confine_root(&state, &vault)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    Ok(crate::archive_pack::compress(
        std::path::Path::new(&root),
        older_than_months,
        now,
    ))
}

/// Unpack one compressed bucket back to its directory — the user-facing
/// reverse of `compress_archives`.
#[tauri::command]
pub fn restore_archive_bucket(
    state: tauri::State<VaultRoot>,
    vault: String,
    tree: String,
    bucket: String,
) -> Result<crate::archive_pack::RestoreReport, String> {
    let root = confine_root(&state, &vault)?;
    crate::archive_pack::restore(std::path::Path::new(&root), &tree, &bucket)
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
pub fn list_quarantine(
    state: tauri::State<VaultRoot>,
    vault: String,
) -> Result<Vec<QuarantineItem>, String> {
    let root = confine_root(&state, &vault)?;
    Ok(
        crate::distill::quarantine_entries(std::path::Path::new(&root))
            .into_iter()
            .map(|(entry, preview)| QuarantineItem { entry, preview })
            .collect(),
    )
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
) -> Result<usize, String> {
    let root = confine_root(&state, &vault)?;
    crate::distill::extend_quarantine(std::path::Path::new(&root), &files, days)
}

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
) -> Result<String, String> {
    let root = confine_root(&state, &vault)?;
    crate::distill::apply_proposal(std::path::Path::new(&root), &path)
}

/// `sessions/` days ready for Phase B's LLM digest step. See
/// `distill::digestable_session_days`'s own doc comment.
#[tauri::command]
pub fn digestable_session_days(
    state: tauri::State<VaultRoot>,
    vault: String,
) -> Result<Vec<crate::distill::DigestDay>, String> {
    let root = confine_root(&state, &vault)?;
    Ok(crate::distill::digestable_session_days(
        std::path::Path::new(&root),
    ))
}

/// Move a digested day's `sessions/` files into `sessions/archive/`. See
/// `distill::archive_digested_sessions`'s own doc comment.
#[tauri::command]
pub fn archive_digested_sessions(
    state: tauri::State<VaultRoot>,
    vault: String,
    day: String,
    files: Vec<String>,
    fingerprints: Option<Vec<String>>,
) -> Result<String, String> {
    let root = confine_root(&state, &vault)?;
    crate::distill::archive_digested_sessions(
        std::path::Path::new(&root),
        &day,
        &files,
        fingerprints.as_deref(),
    )
}

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
pub fn archive_rolled(
    state: tauri::State<VaultRoot>,
    vault: String,
    layer: String,
    bucket: String,
    files: Vec<String>,
    fingerprints: Option<Vec<String>>,
) -> Result<String, String> {
    let root = confine_root(&state, &vault)?;
    let layer = crate::distill::rollup_layer(&layer)
        .ok_or_else(|| format!("unknown rollup layer `{layer}`"))?;
    crate::distill::archive_rolled(
        std::path::Path::new(&root),
        layer,
        &bucket,
        &files,
        fingerprints.as_deref(),
    )
}

/// Gate-admitted Full-tier items ready for the LLM ingest pipeline (Phase B,
/// Task 3). Read-only. See `distill::full_tier_items`'s own doc comment.
#[tauri::command]
pub fn full_tier_items(
    state: tauri::State<VaultRoot>,
    vault: String,
) -> Result<Vec<String>, String> {
    let root = confine_root(&state, &vault)?;
    Ok(crate::distill::full_tier_items(std::path::Path::new(&root)))
}

/// TS-side distill steps (session-digest's daily-file create, full-tier
/// ingest's `_inbox/` archive + `raw/` create, draftMap's map-file create)
/// run outside Rust and would otherwise be invisible to `undo` — this is
/// their one write path into the same `.myco/distill-runs/<id>.json`
/// manifest shape Rust's own archive/trash/proposal passes already use. See
/// `distill::append_distill_manifest`'s own doc comment.
#[tauri::command]
pub fn append_distill_manifest(
    state: tauri::State<VaultRoot>,
    vault: String,
    id: String,
    moves: Vec<crate::distill::MoveEntry>,
    created: Vec<String>,
) -> Result<(), String> {
    let root = confine_root(&state, &vault)?;
    crate::distill::append_distill_manifest(std::path::Path::new(&root), &id, moves, created)
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

/// Embed arbitrary texts with the bundled local embedder (bge-m3).
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
        // Announce the page BEFORE embedding it, not only after: a large page
        // (a long session log can be hundreds of chunks) embeds for minutes,
        // and with only the post-embed emit the UI froze on the PREVIOUS
        // page's name and count the whole time — indistinguishable from a
        // hang (reported as exactly that). `done: i` keeps the bar honest;
        // the post-embed emit below still advances it to `i + 1`.
        {
            use tauri::Emitter;
            let _ = app.emit(
                "reindex-progress",
                ReindexProgress {
                    done: i,
                    total,
                    page: rel.clone(),
                    embedded: false,
                },
            );
        }
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

/// Inclusive `YYYY-MM-DD` day range a time-anchored Ask question resolved to
/// (the frontend's `timeQuery.ts` builds it; serde leaves a missing IPC arg
/// `None`, so existing callers are unaffected).
#[derive(Clone, Debug, serde::Deserialize)]
pub struct DateRange {
    pub start: String,
    pub end: String,
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

/// The sortable date string a dated-tier page derives its recency from:
/// daily → the day, weekly → its ISO Monday, sessions/monthly → the month
/// (`YYYY-MM` sorts before any full date inside that month — a month-level
/// record reads as "at least as old as" its first day). `None`: undated.
fn page_date(rel: &str) -> Option<String> {
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

/// Semantic search: embed the query, return top-`k` chunk hits from the index,
/// with each hit's chunk TEXT reconstructed so callers (e.g. Ask) can inline the
/// passage instead of re-reading the whole page.
// Four of the arguments are Tauri-injected state rather than things a caller
// passes; the invocable surface is (query, k, provider, model, range).
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
) -> Result<Vec<ScoredChunk>, String> {
    let t0 = std::time::Instant::now();
    // Quoted phrases become an exact-match filter on the reconstructed chunk
    // text; the embed/BM25 arms run on the quote-stripped query (the phrase
    // words stay in it, so unquoted ranking behavior is unchanged).
    let (phrases, clean_query) = crate::retrieval::parse_phrases(&query);
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
        vec![clean_query.clone()],
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
    let lexical_hits = bm25.search(&clean_query, pool);
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
    let mut fused = crate::retrieval::rrf_fuse(&dense_hits, &lexical_hits, pool);
    // Time-anchored question (Q4 item 8): keep only dated-tier pages that
    // overlap the asked window, then let recency break exact score ties.
    // BEFORE cap_per_page — the pool has headroom, so a surviving page can
    // take the slot a filtered-out one would have burned. No range ⇒ inert.
    if let Some(r) = &range {
        fused.retain(|h| page_in_date_range(&h.page, r));
        recency_tie_break(&mut fused);
    }
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
            Some(text)
                if !text.trim().is_empty()
                    && crate::retrieval::text_matches_phrases(&text, &phrases) =>
            {
                out.push(ScoredChunk {
                    similarity: dense_by_id.get(&(h.page.clone(), h.section)).copied(),
                    page: h.page,
                    stem: h.stem,
                    section: h.section,
                    text,
                    score: h.score,
                })
            }
            _ => {} // missing file, stale section index, or phrase miss → skip
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
) -> Vec<ResurfaceCandidate> {
    // Best chunk per page: (cosine, section, stem).
    let mut best: std::collections::HashMap<&str, (f32, usize, &str)> =
        std::collections::HashMap::new();
    for r in &store.records {
        if !r.page.starts_with("wiki/") || is_cold(&r.page) {
            continue;
        }
        let score = embeddings::cosine(seed, &r.vector);
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
    out
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
    let store = cache.get(&index_path);
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
    if builtin_index_is_stale(&provider, &model) {
        return Ok(Vec::new());
    }
    let mut q = embed_texts(
        app,
        llm,
        &provider,
        &model,
        crate::local_llm::EmbedRole::Query,
        vec![seed_text],
    )
    .await?;
    let seed = q.pop().unwrap_or_default();
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
    Ok(resurface_core(
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
    ))
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
mod tests {
    use super::{
        append_recall_miss, builtin_index_is_stale, capture_note_at, chunk_text_at,
        copy_into_inbox_at, delete_myco_json, export_bundle_write, external_target_allowed,
        import_dest, inbox_entries, is_media_name, iso_week_monday, list_myco_json, myco_json_path,
        page_in_date_range, read_settings_import, recency_tie_break, resurface_core, run_diff_core,
        run_import, save_myco_json, sync_bm25_for_page, voice_inbox_rel, voice_markdown,
        windows_opener_safe, write_inbox_note_at, DateRange, DEST_INBOX, DEST_SESSIONS,
        INBOX_COPY_MAX_BYTES, INBOX_COPY_MAX_MEDIA_BYTES,
    };
    use crate::retrieval::{rrf_fuse, Bm25Cache, Bm25Index};
    use crate::vector_index::Hit;
    use std::collections::{HashMap, HashSet};
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
        let rel = capture_note_at(dir.path(), "buy milk", CAPTURE_TS, 0).unwrap();
        assert_eq!(rel, "daily/2001-09-09.md");
        let content = std::fs::read_to_string(dir.path().join(&rel)).unwrap();
        // Seed heading + line, blank seed line collapsed — appendTaskLine's
        // exact trailing convention ("# day\n\n" + line → "# day\n<line>\n").
        assert_eq!(content, "# 2001-09-09\n- 01:46 buy milk\n");
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
        capture_note_at(dir.path(), "second\nthought", CAPTURE_TS, 0).unwrap();
        let content = std::fs::read_to_string(dir.path().join("daily/2001-09-09.md")).unwrap();
        assert_eq!(
            content,
            "# 2001-09-09\n\n- 01:00 first\n- 01:46 second thought\n"
        );
    }

    #[test]
    fn capture_note_rejects_empty_text_and_wild_offsets() {
        let dir = tempfile::tempdir().unwrap();
        assert!(capture_note_at(dir.path(), "  \n ", CAPTURE_TS, 0).is_err());
        assert!(capture_note_at(dir.path(), "x", CAPTURE_TS, 100_000).is_err());
        assert!(!dir.path().join("daily").exists(), "nothing may be written");
    }

    #[test]
    fn capture_note_buckets_on_the_local_day_not_utc() {
        let dir = tempfile::tempdir().unwrap();
        // 01:46 UTC minus two hours is 23:46 the previous LOCAL day.
        let rel = capture_note_at(dir.path(), "late note", CAPTURE_TS, -120).unwrap();
        assert_eq!(rel, "daily/2001-09-08.md");
        let content = std::fs::read_to_string(dir.path().join(&rel)).unwrap();
        assert!(content.ends_with("- 23:46 late note\n"), "{content}");
    }

    // ---- voice quick-capture (W3–6 item 9) ---------------------------------

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
        );
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
        );
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
        );
        assert_eq!(
            out.iter().map(|c| c.page.as_str()).collect::<Vec<_>>(),
            ["wiki/a.md", "wiki/b.md"]
        );
        // k = 1 truncates to the best.
        let out = resurface_core(
            &store, &SEED, &opens, &mtimes, NOW, DORMANT, 0.0, 1, &any_text,
        );
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
        );
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
