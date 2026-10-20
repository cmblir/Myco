// Per-vault distillation config. Persists to `<vault>/.myco/distill.json` with
// atomic write (tmp + rename) and missing/corrupt file → defaults. Follows the
// same persistence pattern as schedules.rs.

use std::path::{Path, PathBuf};

type EmbedVectors<'a> = dyn Fn(Vec<String>) -> Result<Vec<Vec<f32>>, String> + 'a;

#[path = "distill_archive.rs"]
mod archive;
pub(crate) use archive::ArchiveContext;
pub use archive::{ArchivePublication, ArchiveReceipt};

#[path = "distill_admission.rs"]
mod admission;

#[path = "distill_knowledge.rs"]
mod knowledge;

#[path = "distill_ttl.rs"]
mod ttl;

#[cfg(test)]
#[path = "distill_archive_safety_tests.rs"]
mod archive_safety_tests;

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Intensity {
    Conservative,
    Standard,
    Aggressive,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GatePreset {
    Strict,
    Normal,
    Loose,
}

fn d_true() -> bool {
    true
}

fn d_count() -> usize {
    50
}

fn d_intensity() -> Intensity {
    Intensity::Standard
}

fn d_preset() -> GatePreset {
    GatePreset::Normal
}

fn d_ttl() -> u32 {
    30
}

fn d_budget() -> usize {
    50
}

fn d_idle() -> u32 {
    10
}

fn d_maturation() -> u32 {
    24
}

/// Phase B default: `sessions/` days become digest-eligible after this many
/// days, independent of `maturation_hours` (that gate is per-item and much
/// shorter; this one is per-day, letting a day's work logs settle before an
/// LLM call summarizes them).
fn d_digest_days() -> u32 {
    3
}

/// Phase B default: how many `_inbox/`/quarantine items one `run` will spend
/// a paid LLM ingest call on — bounds a single automatic run's LLM cost
/// independent of `run_budget_items` (the no-LLM scan's own budget).
fn d_ingest_budget() -> u32 {
    3
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct DistillConfig {
    #[serde(default = "d_true")]
    pub enabled: bool,
    #[serde(default = "d_count")]
    pub count_trigger: usize,
    #[serde(default = "d_intensity")]
    pub intensity: Intensity,
    #[serde(default = "d_preset")]
    pub gate_preset: GatePreset,
    #[serde(default = "d_ttl")]
    pub quarantine_ttl_days: u32,
    #[serde(default = "d_budget")]
    pub run_budget_items: usize,
    #[serde(default = "d_idle")]
    pub idle_minutes: u32,
    #[serde(default = "d_maturation")]
    pub maturation_hours: u32,
    // v2 (dormancy decay) — deliberately unread in Phase B; kept so configs
    // written now stay valid.
    #[serde(default)]
    pub dormancy_decay: bool,
    /// Phase B: max day-buckets digested per run (TS-side) — not a min-age
    /// gate; maturity is `maturation_hours`, the same gate `scan` uses.
    #[serde(default = "d_digest_days")]
    pub llm_digest_days: u32,
    /// Phase B: per-run cap on paid LLM ingest calls.
    #[serde(default = "d_ingest_budget")]
    pub llm_ingest_budget: u32,
    /// Phase B: whether an LLM wiki-maintenance call gets the vault's
    /// `profile.md` injected as extra context.
    #[serde(default = "d_true")]
    pub profile_injection: bool,
}

impl Default for DistillConfig {
    fn default() -> Self {
        DistillConfig {
            enabled: d_true(),
            count_trigger: d_count(),
            intensity: d_intensity(),
            gate_preset: d_preset(),
            quarantine_ttl_days: d_ttl(),
            run_budget_items: d_budget(),
            idle_minutes: d_idle(),
            maturation_hours: d_maturation(),
            dormancy_decay: false,
            llm_digest_days: d_digest_days(),
            llm_ingest_budget: d_ingest_budget(),
            profile_injection: d_true(),
        }
    }
}

fn dir(root: &Path) -> PathBuf {
    crate::vault_dir::dir(root)
}

pub fn config_path(root: &Path) -> PathBuf {
    dir(root).join("distill.json")
}

pub fn config_load(root: &Path) -> DistillConfig {
    let path = config_path(root);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return DistillConfig::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// Read decision policy without treating an existing failure as defaults.
pub fn config_load_checked(root: &Path) -> Result<DistillConfig, String> {
    let path = crate::vault::confine_delete_path(root, &config_path(root).to_string_lossy())?;
    match crate::index_publication::read_checked(&path)? {
        Some(raw) => serde_json::from_slice(&raw)
            .map_err(|_| "distill decision configuration is corrupt".into()),
        None => Ok(DistillConfig::default()),
    }
}

/// Atomic write: stage to a temp file in the same dir, then rename over target.
pub fn config_save(root: &Path, c: &DistillConfig) -> Result<(), String> {
    let d = dir(root);
    std::fs::create_dir_all(&d)
        .map_err(|e| format!("create {} dir: {e}", crate::vault_dir::DIR_NAME))?;
    let raw = serde_json::to_string_pretty(c).map_err(|e| format!("serialize: {e}"))?;
    let target = config_path(root);
    let tmp = d.join(".distill.json.tmp");
    std::fs::write(&tmp, raw.as_bytes()).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, &target).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Inflow scan (Task 4, Phase A): score new `_inbox/`, `raw/`, `sessions/`
// items against the ontology, quarantine what fits no known topic, and
// TTL-ledger straight rejects. See
// `app/docs/specs/2026-08-13-ontology-distill-design.md` ("Admission gate").
// ---------------------------------------------------------------------------

use crate::embeddings::{EmbeddedBatch, EmbeddingSpace};
use crate::ontology::{admit, Ontology, Tier, Verdict, FIELD_CLUSTER_ID};
use std::collections::HashMap;

/// Rule-only admission does not depend on an embedding representation.
#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NonsemanticOrigin {
    Machine,
    Junk,
}

/// One item's last-scored source and decision identity. Reuse requires both
/// the exact current bytes and the current admission context.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ScoredEntry {
    pub hash: u64,
    pub tier: String,
    pub at: i64,
    /// On-disk metadata used for ordering and display. It does not authorize
    /// reuse: every candidate is read and compared with `source_sha256`.
    /// Legacy entries default to zero and remain history until checked again.
    #[serde(default)]
    pub mtime: i64,
    #[serde(default)]
    pub len: u64,
    /// `GATE_RULES` when this entry was scored; 0 for one written before the
    /// field existed. A session scored under older rules is checked again.
    #[serde(default)]
    pub rules: u32,
    /// A session's first-turn census key (`machine_session::repeat_key`), so
    /// a later scan counts a repeated agent prompt without re-reading it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<u64>,
    /// The exact representation used for semantic admission. A legacy score
    /// without this stamp is retained as history, but cannot authorize a skip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedding: Option<EmbeddingSpace>,
    /// Machine/junk decisions are reusable under their explicit rule version,
    /// independently of a semantic representation change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nonsemantic: Option<NonsemanticOrigin>,
    /// Exact source bytes admitted by this score; legacy history is not stamped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_sha256: Option<String>,
    /// Semantic policy and knowledge inputs that produced this decision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision_signature: Option<String>,
}

/// Bumped when a gate rule change makes past `sessions/` scores wrong. 1:
/// the machine-session check (`machine_session`), which no session scored
/// before it has been through. 2: Codex approval reviews are agent-made.
const GATE_RULES: u32 = 2;

fn is_session(rel: &str) -> bool {
    rel.starts_with(&format!("{}/", crate::commands::DEST_SESSIONS))
}

/// A current rule-only verdict, or a semantic verdict in the pinned space.
fn is_scored(state: &DistillState, rel: &str) -> bool {
    state.scored.get(rel).is_some_and(|entry| {
        if !entry
            .source_sha256
            .as_deref()
            .is_some_and(admission::valid_digest)
        {
            return false;
        }
        if entry.nonsemantic.is_some() {
            return entry.embedding.is_none()
                && entry.decision_signature.is_none()
                && entry.rules == GATE_RULES;
        }
        entry.embedding.as_ref().is_some_and(|space| {
            Some(space) == state.embedding.as_ref()
                && entry
                    .decision_signature
                    .as_deref()
                    .is_some_and(admission::valid_digest)
                && entry.decision_signature == state.decision_signature
                && (!is_session(rel) || entry.rules == GATE_RULES)
        })
    })
}

fn has_current_semantic_score(state: &DistillState, rel: &str) -> bool {
    state.scored.get(rel).is_some_and(|entry| {
        entry.nonsemantic.is_none()
            && entry
                .source_sha256
                .as_deref()
                .is_some_and(admission::valid_digest)
            && entry
                .decision_signature
                .as_deref()
                .is_some_and(admission::valid_digest)
            && entry.decision_signature == state.decision_signature
            && entry
                .embedding
                .as_ref()
                .is_some_and(|space| Some(space) == state.embedding.as_ref())
    })
}

/// Persisted scan state, `<vault>/.myco/distill-state.json`. Representation
/// changes invalidate semantic reuse entry by entry, while lifecycle history
/// and rule-only verdicts remain intact.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct DistillState {
    #[serde(default)]
    pub model: String,
    /// Current comparison context only. Updating this does not stamp any
    /// unprocessed score as having been produced in the new representation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedding: Option<EmbeddingSpace>,
    /// Comparison context only; changing it never blesses old per-item scores.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision_signature: Option<String>,
    #[serde(default)]
    pub scored: HashMap<String, ScoredEntry>,
    /// Reject-tier items' TTL ledger — `rel path -> expiry unix seconds`,
    /// written by `scan` alongside `scored`. Nothing reads this map today:
    /// `run`'s TTL pass only sweeps `_inbox/quarantine/` sidecars past their
    /// own `expires`, never a rejected file. Kept as Phase B's planned
    /// reject-TTL sweep input.
    #[serde(default)]
    pub rejected_ttl: HashMap<String, i64>,
    /// Unix seconds of the last completed `run`, for the status view.
    #[serde(default)]
    pub last_run: Option<i64>,
    /// Rolling window (capped at 10, oldest first) of the post-run backlog
    /// count each `run` appended — the trend line the badge shows instead of
    /// a raw count. Retained across representation/model changes.
    #[serde(default)]
    pub last_backlogs: Vec<usize>,
    /// Census keys of the long first turns seen in
    /// `machine_session::REPEAT_MIN_SESSIONS`+ sessions — the agent prompts.
    /// Kept after those sessions move to quarantine, so the next copy of the
    /// same prompt is still recognised.
    #[serde(default)]
    pub agent_turns: Vec<u64>,
}

/// Paths the owner restored out of quarantine, never quarantined again (spec
/// 2026-10-02 decision 6): `<vault>/.myco/distill-kept.json`. Its own file,
/// not a `DistillState` field: `scan` holds that ledger in memory for a whole
/// run and saves it at the end, which would overwrite a restore clicked
/// meanwhile. Only `record_kept` writes it. Existing unreadable/corrupt marks
/// must fail closed rather than removing the owner's protection.
fn kept_load(root: &Path) -> Result<Vec<String>, String> {
    let path = dir(root).join("distill-kept.json");
    let path = crate::vault::confine_delete_path(root, &path.to_string_lossy())?;
    let Some(raw) = crate::index_publication::read_checked(&path)? else {
        return Ok(Vec::new());
    };
    serde_json::from_slice(&raw).map_err(|_| "distill owner-kept ledger is corrupt".into())
}

/// Add `rels` to the owner-kept marks, dropping marks whose file is gone.
/// The lock makes two restores' read-modify-writes queue instead of racing.
fn record_kept(root: &Path, rels: &[String]) -> Result<(), String> {
    static KEPT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    if rels.is_empty() {
        return Ok(());
    }
    let _held = KEPT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut kept = kept_load(root)?;
    let mut retained = Vec::with_capacity(kept.len());
    for rel in kept {
        match std::fs::symlink_metadata(root.join(&rel)) {
            Ok(_) => retained.push(rel),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("inspect distill owner-kept content path".into()),
        }
    }
    kept = retained;
    for r in rels {
        if !kept.contains(r) {
            kept.push(r.clone());
        }
    }
    std::fs::create_dir_all(dir(root))
        .map_err(|e| format!("create {} dir: {e}", crate::vault_dir::DIR_NAME))?;
    let raw = serde_json::to_string_pretty(&kept).map_err(|e| format!("serialize: {e}"))?;
    crate::settings::atomic_write(&dir(root).join("distill-kept.json"), raw.as_bytes())
}

pub fn state_path(root: &Path) -> PathBuf {
    dir(root).join("distill-state.json")
}

/// Strict admission-state read. Missing state is fresh; existing unreadable or
/// malformed state is an error and must not be replaced by a successful scan.
fn state_load_checked(root: &Path, model: &str) -> Result<DistillState, String> {
    let path = crate::vault::confine_delete_path(root, &state_path(root).to_string_lossy())?;
    let mut state: DistillState = match crate::index_publication::read_checked(&path)? {
        Some(raw) => serde_json::from_slice(&raw)
            .map_err(|_| "distill admission state is corrupt".to_string())?,
        None => DistillState::default(),
    };
    validate_state(&state)?;
    if state.model != model {
        state.embedding = None;
    }
    state.model = model.to_string();
    Ok(state)
}

fn validate_state(state: &DistillState) -> Result<(), String> {
    if state
        .decision_signature
        .as_deref()
        .is_some_and(|signature| !admission::valid_digest(signature))
    {
        return Err("distill decision context is malformed".into());
    }
    if let Some(space) = &state.embedding {
        space.validate()?;
        if state.model != space.model {
            return Err("distill admission state context model mismatch".into());
        }
    }
    for entry in state.scored.values() {
        if entry
            .source_sha256
            .as_deref()
            .is_some_and(|signature| !admission::valid_digest(signature))
            || entry
                .decision_signature
                .as_deref()
                .is_some_and(|signature| !admission::valid_digest(signature))
        {
            return Err("distill score provenance is malformed".into());
        }
        if let Some(space) = &entry.embedding {
            space.validate()?;
            if entry.nonsemantic.is_some() {
                return Err("distill admission score has conflicting origins".into());
            }
        }
        if let Some(origin) = entry.nonsemantic {
            if entry.decision_signature.is_some() {
                return Err("distill rule-only score has semantic policy provenance".into());
            }
            let valid_tier = match origin {
                NonsemanticOrigin::Machine => {
                    matches!(entry.tier.as_str(), "quarantine" | "reject")
                }
                NonsemanticOrigin::Junk => entry.tier == "reject",
            };
            if !valid_tier {
                return Err("distill nonsemantic score has an invalid tier".into());
            }
        }
    }
    Ok(())
}

/// Compatibility metadata read; callers still need an actual store-derived
/// context before treating any entry as current semantic authority.
pub fn state_load(root: &Path, model: &str) -> DistillState {
    state_load_checked(root, model).unwrap_or_else(|error| {
        eprintln!("myco: distill metadata state unavailable: {error}");
        DistillState {
            model: model.to_string(),
            ..Default::default()
        }
    })
}

fn state_for_space(
    root: &Path,
    space: Option<&EmbeddingSpace>,
    model: &str,
) -> Result<DistillState, String> {
    let mut state = state_load_checked(root, model)?;
    if let Some(space) = space {
        space.validate()?;
    }
    state.embedding = space.cloned();
    state.decision_signature = None;
    Ok(state)
}

fn state_for_inputs(
    root: &Path,
    space: Option<&EmbeddingSpace>,
    model: &str,
    inputs: Option<&admission::DecisionInputs>,
) -> Result<DistillState, String> {
    let mut state = state_for_space(root, space, model)?;
    state.decision_signature = inputs.map(|inputs| inputs.signature.clone());
    Ok(state)
}

fn is_scored_current(root: &Path, state: &DistillState, rel: &str) -> Result<bool, String> {
    if !is_scored(state, rel) {
        return Ok(false);
    }
    let sha256 = state.scored[rel]
        .source_sha256
        .as_deref()
        .ok_or("distill current score has no source revision")?;
    admission::source_matches(root, rel, sha256)
}

fn metadata_is_scored(root: &Path, state: &DistillState, rel: &str) -> bool {
    is_scored_current(root, state, rel).unwrap_or_else(|error| {
        eprintln!("myco: distill source authority unavailable: {error}");
        false
    })
}

/// Atomic write: stage to a temp file in the same dir, then rename over target.
pub fn state_save(root: &Path, s: &DistillState) -> Result<(), String> {
    validate_state(s)?;
    let d = dir(root);
    std::fs::create_dir_all(&d)
        .map_err(|e| format!("create {} dir: {e}", crate::vault_dir::DIR_NAME))?;
    let raw = serde_json::to_string_pretty(s).map_err(|e| format!("serialize: {e}"))?;
    let target = state_path(root);
    let tmp = d.join(".distill-state.json.tmp");
    std::fs::write(&tmp, raw.as_bytes()).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, &target).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

/// Outcome of one `scan` run — a breakdown of what happened to the items it
/// looked at, for the run report / settings-tab status line.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
pub struct ScanOutcome {
    pub scored: usize,
    pub quarantined: usize,
    pub rejected: usize,
    pub summaries: usize,
    pub full: usize,
    pub skipped_immature: usize,
    /// `Some(wiki_pages)` when `scan` no-op'd because the cold-start gate is
    /// off (Defect D) — `wiki_pages` is the count that fell short of
    /// `GATE_MIN_WIKI_PAGES`. `None` once the gate is active. Surfaces
    /// distill.rs's `eprintln!`-only gate message to the run report/UI.
    pub gate_wiki_pages: Option<usize>,
}

/// The one subdirectory of `_inbox/` that is NOT inflow (it holds this scan's
/// own output) — never walked, never re-scored.
const QUARANTINE_DIR: &str = "quarantine";
/// The one subdirectory of `raw/` that is NOT inflow (retired sources) — see
/// `app/docs/specs/2026-08-13-distill-calibration.md`. Also reused as
/// `sessions/`'s own archive subdirectory name (Phase B digest bookkeeping,
/// `archive_digested_sessions`) — same "cold, never re-scored" shape, same
/// literal name, no reason for a second constant.
const RAW_ARCHIVE_DIR: &str = "archive";

/// Minimum byte length before a file is even considered content — anything
/// shorter is definitionally noise (a stub, a truncated paste, a near-empty
/// tool transcript).
const JUNK_MIN_BYTES: usize = 200;

/// Share of non-empty lines that must look like raw tool/agent transcript
/// noise (JSON blobs, `tool_use`/`tool_result` records, chat-turn prefixes)
/// before the whole file is rejected without spending an embedding on it.
const JUNK_LINE_RATIO: f32 = 0.90;

/// How many texts go into one `embed` call — matches the real embedder's
/// batching (see `commands::embed_texts` callers).
const EMBED_BATCH: usize = 32;

/// How many leading characters of an item's content are embedded — enough for
/// the gate to place the item topically without paying to embed a whole
/// session transcript.
const EMBED_CHARS: usize = 2000;

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn is_tool_noise_line(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with('{')
        || t.starts_with('[')
        || t.starts_with("tool_use")
        || t.starts_with("tool_result")
        || t.starts_with("assistant:")
        || t.starts_with("user:")
}

/// `Some(reason)` if `content` is junk by the pre-filter, checked BEFORE
/// embedding so junk never costs a model call: too short, or mostly raw
/// tool/agent transcript noise rather than prose.
pub(crate) fn junk_reason(content: &str) -> Option<String> {
    if content.len() < JUNK_MIN_BYTES {
        return Some(format!(
            "junk heuristic: {} bytes (< {JUNK_MIN_BYTES})",
            content.len()
        ));
    }
    let lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.is_empty() {
        return Some("junk heuristic: no non-empty lines".to_string());
    }
    let noisy = lines.iter().filter(|l| is_tool_noise_line(l)).count();
    let ratio = noisy as f32 / lines.len() as f32;
    if ratio >= JUNK_LINE_RATIO {
        return Some(format!(
            "junk heuristic: {:.0}% tool-noise lines",
            ratio * 100.0
        ));
    }
    None
}

fn truncate_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// `<root>/profile.md`'s `## Interests` bullets, via a plain string scan —
/// profile.md is markdown with no YAML frontmatter (see `app/src/lib/
/// profile.ts::parseProfile`, the TS mirror of this same section format), so
/// a `gray_matter` parse does not apply here. Missing file or missing/empty
/// section -> empty (the caller's zero-cost, no-lift path).
#[cfg(test)]
fn read_profile_interests(root: &Path) -> Vec<String> {
    admission::read_interests(root).unwrap()
}

fn tier_str(t: Tier) -> &'static str {
    match t {
        Tier::Full => "full",
        Tier::Summary => "summary",
        Tier::Quarantine => "quarantine",
        Tier::Reject => "reject",
    }
}

/// One candidate inflow file: its vault-relative path (forward slashes), its
/// absolute path, its mtime (unix seconds) for the oldest-first order and the
/// maturation gate, and its byte length (with the mtime, the ledger's
/// unchanged stamp).
struct Candidate {
    rel: String,
    path: PathBuf,
    mtime: i64,
    len: u64,
}

/// Walk `<root>/<start>` for `.md` files, skipping dotfiles/symlinks
/// (`vault::vault_entries`) and, at `start`'s own top level only, any
/// directory named in `exclude_top` — the inflow trees' own non-inflow
/// subdirectories (`_inbox/quarantine/`, `raw/archive/`).
fn walk_inflow(root: &Path, start: &str, exclude_top: &[&str], out: &mut Vec<Candidate>) {
    fn walk(dir: &Path, root: &Path, exclude_top: &[&str], top: bool, out: &mut Vec<Candidate>) {
        for (entry, kind) in crate::vault::vault_entries(dir) {
            let path = entry.path();
            if kind.is_dir() {
                let name = entry.file_name();
                if top && exclude_top.iter().any(|e| *e == name.to_string_lossy()) {
                    continue;
                }
                walk(&path, root, exclude_top, false, out);
            } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
                let Ok(meta) = std::fs::metadata(&path) else {
                    continue;
                };
                let Ok(modified) = meta.modified() else {
                    continue;
                };
                let mtime = modified
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                let rel = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push(Candidate {
                    rel,
                    path,
                    mtime,
                    len: meta.len(),
                });
            }
        }
    }
    walk(&root.join(start), root, exclude_top, true, out);
}

/// Every inflow candidate across the two trees the gate watches, oldest
/// mtime first (ties broken by path for a deterministic order). Never walks
/// `.myco/` (not one of these trees at all), `_inbox/quarantine/`, or
/// `sessions/archive/` (Phase B's digested-session archive — an archived
/// session must never be re-scored). Never `raw/`: no run touches it (owner
/// decision 2026-10-03, B1), so it is not inflow.
fn collect_candidates(root: &Path) -> Vec<Candidate> {
    let mut out = Vec::new();
    walk_inflow(
        root,
        crate::commands::DEST_INBOX,
        &[QUARANTINE_DIR],
        &mut out,
    );
    walk_inflow(
        root,
        crate::commands::DEST_SESSIONS,
        &[RAW_ARCHIVE_DIR],
        &mut out,
    );
    out.sort_by(|a, b| a.mtime.cmp(&b.mtime).then_with(|| a.rel.cmp(&b.rel)));
    out
}

/// A free `(file, sidecar)` path pair for a quarantined item's file name,
/// suffixing `-2`, `-3`… before the extension on a collision (either path
/// already taken) so two different sources sharing a basename never clobber
/// each other or each other's sidecar.
fn free_quarantine_paths(dir: &Path, file_name: &str) -> (PathBuf, PathBuf) {
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(file_name);
    let ext = Path::new(file_name).extension().and_then(|s| s.to_str());
    let mut n = 1u32;
    loop {
        let candidate_stem = if n == 1 {
            stem.to_string()
        } else {
            format!("{stem}-{n}")
        };
        let file_path = match ext {
            Some(e) => dir.join(format!("{candidate_stem}.{e}")),
            None => dir.join(&candidate_stem),
        };
        let sidecar_path = dir.join(format!("{candidate_stem}.verdict.json"));
        if !file_path.exists() && !sidecar_path.exists() {
            return (file_path, sidecar_path);
        }
        n += 1;
    }
}

/// Verdict sidecar written next to a quarantined item — Task 7's
/// emerging-cluster detection reads these, and carries the embedding vector
/// so that pass never re-embeds.
#[derive(serde::Serialize)]
struct QuarantineSidecar<'a> {
    tier: &'a Tier,
    s_knn: f32,
    nearest_cluster: &'a str,
    reason: &'a str,
    expires: i64,
    vector: &'a [f32],
    #[serde(skip_serializing_if = "Option::is_none")]
    embedding: Option<&'a EmbeddingSpace>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_sha256: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    decision_signature: Option<&'a str>,
    /// Where the item was before the move: restore puts it back there, and
    /// the TTL sweep and trash purge treat a `sessions/` origin as the
    /// owner's to delete (spec 2026-10-02 decisions 5, 6).
    from: &'a str,
}

/// A candidate that passed the maturation gate and the ledger's
/// unchanged-content check — i.e. it will be scored this run.
struct Taken {
    rel: String,
    path: PathBuf,
    mtime: i64,
    len: u64,
    content: String,
    hash: u64,
    source_sha256: String,
    junk: Option<String>,
    /// Set for a machine-made session: quarantined, never embedded.
    machine: Option<crate::machine_session::MachineKind>,
    /// A session's first-turn census key.
    turn: Option<u64>,
}

/// "Gate OFF until the vault has ≥50 wiki pages (or first map); profile.md
/// serves as ontology until then." —
/// `app/docs/specs/2026-08-13-ontology-distill-design.md`, "Admission gate".
const GATE_MIN_WIKI_PAGES: usize = 50;

/// Score new inflow against the ontology: walk `_inbox/`, `raw/`, `sessions/`
/// oldest-mtime-first, skip anything not yet mature (`cfg.maturation_hours`)
/// or already scored at its current content hash, quarantine machine-made
/// sessions (`machine_session`; outside `budget`, never embedded), reject
/// junk transcripts without spending an embedding, batch-embed the rest and
/// run them through `ontology::admit` (whose quarantine band never moves a
/// session or a raw/ file), then act on the verdict: quarantine moves the
/// file into `_inbox/quarantine/` with a verdict sidecar — recorded into `manifest`
/// (the file move as a `moves` entry, the sidecar as a `created` entry,
/// `save_manifest`d after each, same incremental discipline as every other
/// pass in `run`) so undo can reverse it — reject adds a `rejected_ttl`
/// ledger entry (the file stays put — see that field's own doc comment:
/// nothing sweeps it yet), full/summary are only recorded (Phase B consumes
/// them). Every scored item — whatever its tier — is recorded in the ledger
/// so unchanged bytes with the same decision inputs can reuse their verdict.
///
/// Below `GATE_MIN_WIKI_PAGES` wiki pages (`o.wiki_pages` — kept equal to
/// the real on-disk count by `run`'s staleness check, since `scan` is only
/// ever handed a freshly-built-or-confirmed-current ontology), the gate is
/// off: every candidate is a no-op, not scored, quarantined, or rejected —
/// a 5-page vault must not build a field-only ontology and quarantine its
/// own inflow into TTL-trash before it has anything to gate against.
// Module-private, not `pub`: `run` (same module) is the only caller left
// now that the standalone `distill_scan` Tauri command is gone (Dead code
// cleanup) — `RunManifest` in its signature is itself module-private.
#[allow(clippy::too_many_arguments)]
#[cfg(test)]
fn scan(
    root: &Path,
    o: &Ontology,
    cfg: &DistillConfig,
    budget: usize,
    embed: &EmbedVectors<'_>,
    profile_vecs: &[Vec<f32>],
    manifest: &mut RunManifest,
) -> Result<ScanOutcome, String> {
    let inputs = admission::capture(root, o, cfg)?;
    scan_with_inputs(
        root,
        o,
        cfg,
        budget,
        embed,
        profile_vecs,
        manifest,
        &inputs,
        false,
    )
}

#[allow(clippy::too_many_arguments)]
fn scan_with_inputs(
    root: &Path,
    o: &Ontology,
    cfg: &DistillConfig,
    budget: usize,
    embed: &EmbedVectors<'_>,
    profile_vecs: &[Vec<f32>],
    manifest: &mut RunManifest,
    inputs: &admission::DecisionInputs,
    verify_published: bool,
) -> Result<ScanOutcome, String> {
    if o.wiki_pages < GATE_MIN_WIKI_PAGES {
        eprintln!(
            "distill gate off: {} wiki pages < {GATE_MIN_WIKI_PAGES}",
            o.wiki_pages
        );
        return Ok(ScanOutcome {
            gate_wiki_pages: Some(o.wiki_pages),
            ..Default::default()
        });
    }

    let space = o.embedding.as_ref();
    if let Some(space) = space {
        space.validate()?;
        if space.model != o.model {
            return Err("distill ontology representation model mismatch".into());
        }
    }
    let mut state = state_for_inputs(root, space, &o.model, Some(inputs))?;
    let now = now_secs();
    let maturation_secs = cfg.maturation_hours as i64 * 3600;

    let mut outcome = ScanOutcome::default();
    let mut taken: Vec<Taken> = Vec::new();
    // Checked current source snapshots share the budget once the census has
    // set repeated agent prompts aside. No second read chooses different bytes.
    let mut pending: Vec<Taken> = Vec::new();
    // Scored sessions whose first turn still counts toward the census; one
    // becomes a quarantine item if its prompt proves repeated.
    let mut bystanders: Vec<Taken> = Vec::new();
    let item = |c: &Candidate, turn: Option<u64>| Taken {
        rel: c.rel.clone(),
        path: c.path.clone(),
        mtime: c.mtime,
        len: c.len,
        content: String::new(),
        hash: 0,
        source_sha256: String::new(),
        junk: None,
        machine: None,
        turn,
    };
    for c in collect_candidates(root) {
        if now - c.mtime < maturation_secs {
            outcome.skipped_immature += 1;
            continue;
        }
        // A file stamp is an ordering hint, not authority over current bytes.
        let Some(source) = admission::read_source(root, &c.rel)? else {
            continue;
        };
        if let Some(e) = state.scored.get(&c.rel).filter(|e| {
            is_scored(&state, &c.rel) && e.source_sha256.as_ref() == Some(&source.sha256)
        }) {
            if e.turn.is_some() {
                let mut t = item(&c, e.turn);
                t.hash = e.hash;
                t.source_sha256 = source.sha256.clone();
                bystanders.push(t);
            }
            if e.mtime != c.mtime || e.len != c.len {
                let entry = state.scored.get_mut(&c.rel).unwrap();
                entry.mtime = c.mtime;
                entry.len = c.len;
            }
            continue;
        }
        let content =
            String::from_utf8(source.bytes).map_err(|_| "distill admission source is not UTF-8")?;
        let hash = crate::embeddings::content_hash(&content);
        // Non-session snapshots wait for the budgeted admission pass.
        if !is_session(&c.rel) {
            let mut t = item(&c, None);
            t.hash = hash;
            t.source_sha256 = source.sha256;
            t.content = content;
            pending.push(t);
            continue;
        }
        // A session is read now whatever the budget: the machine check
        // costs no embedding, so one run sets every machine session aside.
        // Existing read/path/UTF-8 failures are explicit; they cannot stand in
        // for an unchanged scored source or an absent candidate.
        let first = crate::machine_session::first_human_turn(&content);
        let machine = first.as_deref().and_then(crate::machine_session::kind_of);
        let turn = first
            .as_deref()
            .and_then(crate::machine_session::repeat_key);
        // The session's current machine check already ran. An unchanged
        // semantic fingerprint in the pinned space can retain its score while
        // adopting the newly checked machine-rule version.
        let reusable = is_scored(&state, &c.rel) || has_current_semantic_score(&state, &c.rel);
        if let Some(e) = state
            .scored
            .get_mut(&c.rel)
            .filter(|e| reusable && e.source_sha256.as_ref() == Some(&source.sha256))
        {
            // A checked source/decision receipt survives a metadata touch or
            // older machine rules. Recheck those rules without another embedding.
            e.mtime = c.mtime;
            e.len = c.len;
            if machine.is_none() {
                e.rules = GATE_RULES;
                e.turn = turn;
                if turn.is_some() {
                    let mut t = item(&c, turn);
                    t.hash = hash;
                    t.source_sha256 = source.sha256.clone();
                    bystanders.push(t);
                }
                continue;
            }
        }
        let mut t = item(&c, turn);
        t.hash = hash;
        t.source_sha256 = source.sha256;
        t.content = content;
        match machine {
            Some(_) => {
                t.machine = machine;
                taken.push(t);
            }
            None => pending.push(t),
        }
    }

    // The agent rule: a long first turn in `REPEAT_MIN_SESSIONS` sessions.
    let mut census: HashMap<u64, usize> = HashMap::new();
    for key in pending.iter().chain(&bystanders).filter_map(|t| t.turn) {
        *census.entry(key).or_default() += 1;
    }
    for (key, n) in census {
        if n >= crate::machine_session::REPEAT_MIN_SESSIONS && !state.agent_turns.contains(&key) {
            state.agent_turns.push(key);
        }
    }
    let is_agent = |t: &Taken| t.turn.is_some_and(|k| state.agent_turns.contains(&k));
    let (agents, pending): (Vec<Taken>, Vec<Taken>) = pending.into_iter().partition(is_agent);
    let late = bystanders.into_iter().filter(is_agent);
    for mut t in agents.into_iter().chain(late) {
        t.machine = Some(crate::machine_session::MachineKind::Agent);
        taken.push(t);
    }

    // The budget pass: what is left, oldest first, up to `budget` scored.
    let mut budgeted = 0usize;
    for mut t in pending {
        if budgeted >= budget {
            break; // candidates are already oldest-first; the rest wait
        }
        let reusable = is_scored(&state, &t.rel);
        if let Some(e) = state
            .scored
            .get_mut(&t.rel)
            .filter(|e| reusable && e.source_sha256.as_ref() == Some(&t.source_sha256))
        {
            // Metadata hints can be updated after exact source/decision reuse.
            e.mtime = t.mtime;
            e.len = t.len;
            continue;
        }
        t.junk = junk_reason(&t.content);
        budgeted += 1;
        taken.push(t);
    }

    // Batch-embed everything that isn't junk or machine-made — the only cost
    // this run pays.
    let to_embed: Vec<usize> = taken
        .iter()
        .enumerate()
        .filter(|(_, t)| t.junk.is_none() && t.machine.is_none())
        .map(|(i, _)| i)
        .collect();
    let mut semantic_dim = if to_embed.is_empty() {
        None
    } else {
        let space = space.ok_or("distill semantic admission requires a stamped representation")?;
        o.validate_geometry(Some(space.dim))?;
        Some(space.dim)
    };
    let mut vectors: HashMap<usize, Vec<f32>> = HashMap::new();
    for chunk in to_embed.chunks(EMBED_BATCH) {
        let texts: Vec<String> = chunk
            .iter()
            .map(|&i| truncate_chars(&taken[i].content, EMBED_CHARS))
            .collect();
        let vecs = embed(texts)?;
        crate::embeddings::validate_embedding_batch(&vecs, chunk.len(), semantic_dim)?;
        if semantic_dim.is_none() {
            semantic_dim = vecs.first().map(Vec::len);
        }
        for (&i, v) in chunk.iter().zip(vecs) {
            vectors.insert(i, v);
        }
    }

    // Optional identity vectors are checked again against the actual item
    // width when an empty ontology could not establish it before embedding.
    let profile_vecs = if to_embed.is_empty() {
        profile_vecs
    } else {
        match crate::embeddings::validate_embedding_batch(
            profile_vecs,
            profile_vecs.len(),
            semantic_dim,
        ) {
            Ok(()) => profile_vecs,
            Err(error) => {
                crate::perf::log("distill_profile_embed_failed", &[]);
                eprintln!("distill profile embed failed (continuing without lift): {error}");
                &[]
            }
        }
    };
    // Numeric failures must be discovered before any machine or semantic
    // item moves, and before the ledger or manifest records a verdict.
    let mut semantic_verdicts = HashMap::new();
    for &index in &to_embed {
        let vector = vectors
            .get(&index)
            .ok_or("distill item embedding is missing after batch validation")?;
        let verdict = admit(
            o,
            vector,
            &taken[index].content,
            &cfg.gate_preset,
            profile_vecs,
        )?;
        semantic_verdicts.insert(index, verdict);
    }

    let quarantine_dir = root.join(crate::commands::DEST_INBOX).join(QUARANTINE_DIR);
    let ttl_secs = cfg.quarantine_ttl_days as i64 * 86_400;
    // Read now, after the embedding wait, so a restore clicked during it counts.
    let kept = kept_load(root)?;

    // All prepared verdicts must still describe the observed inputs before
    // the first source move, sidecar write or score publication.
    if admission::capture(root, o, cfg)?.signature != inputs.signature {
        return Err("distill admission inputs changed before publication".into());
    }
    if verify_published {
        verify_current_inputs(root, cfg, inputs)?;
    }
    for item in &taken {
        if !admission::source_matches(root, &item.rel, &item.source_sha256)? {
            return Err("distill source changed before admission publication".into());
        }
    }

    for (i, item) in taken.into_iter().enumerate() {
        let verdict = match (&item.machine, &item.junk) {
            (Some(kind), _) => Verdict {
                tier: Tier::Quarantine,
                s_knn: 0.0,
                nearest_cluster: String::new(),
                nearest_pages: Vec::new(),
                entity_hits: Vec::new(),
                reason: format!("machine:{}", kind.slug()),
            },
            (None, Some(reason)) => Verdict {
                tier: Tier::Reject,
                s_knn: 0.0,
                nearest_cluster: String::new(),
                nearest_pages: Vec::new(),
                entity_hits: Vec::new(),
                reason: reason.clone(),
            },
            (None, None) => semantic_verdicts
                .remove(&i)
                .ok_or("distill semantic verdict is missing after admission validation")?,
        };
        // Only provenance quarantines a session (similarity could not tell
        // the owner's work from machine logs), and nothing under raw/ is ever
        // moved, whatever put it in the quarantine tier, nor is anything the
        // owner restored out of quarantine: all stay put as rejects.
        let tier = match verdict.tier {
            Tier::Quarantine if item.rel.starts_with("raw/") => Tier::Reject,
            Tier::Quarantine if is_session(&item.rel) && item.machine.is_none() => Tier::Reject,
            Tier::Quarantine if kept.contains(&item.rel) => Tier::Reject,
            t => t,
        };

        match tier {
            Tier::Quarantine => {
                // Machine sessions were intentionally not embedded; a
                // semantic quarantine must retain its validated item vector.
                let vector: &[f32] = if item.machine.is_some() {
                    &[]
                } else {
                    vectors
                        .get(&i)
                        .ok_or("distill quarantine embedding is missing after validation")?
                };
                std::fs::create_dir_all(&quarantine_dir)
                    .map_err(|e| format!("create quarantine dir: {e}"))?;
                let file_name = item
                    .path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("item.md")
                    .to_string();
                let (target, sidecar) = free_quarantine_paths(&quarantine_dir, &file_name);
                std::fs::rename(&item.path, &target)
                    .map_err(|e| format!("move to quarantine: {e}"))?;
                manifest.moves.push(MoveEntry {
                    from: item.rel.clone(),
                    to: rel_string(root, &target),
                });
                save_manifest(root, manifest)?;
                let payload = QuarantineSidecar {
                    tier: &verdict.tier,
                    s_knn: verdict.s_knn,
                    nearest_cluster: &verdict.nearest_cluster,
                    reason: &verdict.reason,
                    expires: now + ttl_secs,
                    vector,
                    embedding: if item.machine.is_some() { None } else { space },
                    source_sha256: Some(&item.source_sha256),
                    decision_signature: if item.machine.is_some() {
                        None
                    } else {
                        Some(&inputs.signature)
                    },
                    from: &item.rel,
                };
                let raw = serde_json::to_string_pretty(&payload)
                    .map_err(|e| format!("serialize verdict: {e}"))?;
                std::fs::write(&sidecar, raw).map_err(|e| format!("write verdict sidecar: {e}"))?;
                manifest.created.push(rel_string(root, &sidecar));
                save_manifest(root, manifest)?;
                outcome.quarantined += 1;
            }
            Tier::Reject => {
                // Re-admission in a new representation must not restart an
                // unchanged rejected item's original retention window.
                let same_source = state.scored.get(&item.rel).is_some_and(|entry| {
                    entry.source_sha256.as_ref() == Some(&item.source_sha256)
                        || (entry.source_sha256.is_none() && entry.hash == item.hash)
                });
                if !same_source || !state.rejected_ttl.contains_key(&item.rel) {
                    state.rejected_ttl.insert(item.rel.clone(), now + ttl_secs);
                }
                outcome.rejected += 1;
            }
            Tier::Summary => outcome.summaries += 1,
            Tier::Full => outcome.full += 1,
        }

        state.scored.insert(
            item.rel,
            ScoredEntry {
                hash: item.hash,
                tier: tier_str(tier).to_string(),
                at: now,
                mtime: item.mtime,
                len: item.len,
                rules: GATE_RULES,
                turn: item.turn,
                embedding: if item.machine.is_none() && item.junk.is_none() {
                    space.cloned()
                } else {
                    None
                },
                nonsemantic: if item.machine.is_some() {
                    Some(NonsemanticOrigin::Machine)
                } else if item.junk.is_some() {
                    Some(NonsemanticOrigin::Junk)
                } else {
                    None
                },
                source_sha256: Some(item.source_sha256),
                decision_signature: if item.machine.is_none() && item.junk.is_none() {
                    Some(inputs.signature.clone())
                } else {
                    None
                },
            },
        );
        outcome.scored += 1;
    }

    compact_ledger(root, &mut state);
    state.model = o.model.clone();
    state_save(root, &state)?;
    Ok(outcome)
}

/// Ledger entries are cache lines for files that currently exist — not a
/// permanent history. Location IS the state (the design spec explicitly
/// rejects an ever-growing ledger: "state-as-location; only a small
/// in-flight queue"). A quarantined file's entry (its key is the pre-move
/// path, which stops existing the moment it moves) or an outright-deleted
/// file's entry is pruned every scan, so the ledger stays O(current inflow)
/// rather than O(everything ever seen).
fn compact_ledger(root: &Path, state: &mut DistillState) {
    state.scored.retain(|rel, _| root.join(rel).exists());
    state.rejected_ttl.retain(|rel, _| root.join(rel).exists());
}

// ---------------------------------------------------------------------------
// Idle-run orchestrator (Task 6, Phase A): archive already-represented raw
// sources, sweep expired quarantine into `.myco/trash/`, write an undo
// manifest + human report every run, and undo one mechanically. See
// `app/docs/specs/2026-08-13-ontology-distill-design.md` ("Automation loop").
// ---------------------------------------------------------------------------

/// Fixed retention for `.myco/trash/<run-id>/` dirs once an item lands there.
/// NOT the same knob as `cfg.quarantine_ttl_days` — that one governs how long
/// an item sits in quarantine before it is even eligible for trash; this is
/// how long it sits in trash after that. Phase A hard-codes it rather than
/// exposing yet another setting.
const TRASH_RETENTION_DAYS: i64 = 30;

/// Outcome of one `run` — returned to the Tauri command layer and rendered
/// into the human report.
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct RunReport {
    pub id: String,
    pub scan: ScanOutcome,
    pub trashed: usize,
    pub deleted: usize,
    pub proposals: usize,
    pub backlog_after: usize,
}

/// Vault-wide distillation status — the settings tab / MCP `distill_status`
/// view. Cheap: no scoring, just a fs walk against the ledger already on disk.
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct DistillStatus {
    pub backlog: usize,
    /// `pending` OR `approved` proposal count — both await resolution
    /// (approved = apply pending/failed retry), see `is_awaiting_resolution_map`.
    pub pending_proposals: usize,
    pub last_run: Option<i64>,
    pub last_backlogs: Vec<usize>,
    /// `false` below `GATE_MIN_WIKI_PAGES` wiki pages — the cold-start gate
    /// is off and `scan` is a no-op on every candidate (see its own doc
    /// comment).
    pub gate_active: bool,
    /// The most recently started run's id (`undo`'s `run_id` argument), or
    /// `None` if no run has ever happened — for the settings tab's
    /// "undo this run" button.
    pub last_run_id: Option<String>,
    /// Eligible wiki count `gate_active` was computed from — the same
    /// count `scan`'s own cold-start gate compares against
    /// `GATE_MIN_WIKI_PAGES`, so the UI can show "N/50" instead of a bare
    /// on/off flag, without having to trigger a run to find out.
    pub wiki_pages: usize,
    /// `_inbox/quarantine/` items awaiting human review (Defect G) —
    /// read-only count, also folded into `backlog` above; broken out as its
    /// own field so the UI can point at them specifically instead of a
    /// combined backlog number.
    pub quarantined: usize,
}

/// `pub(crate)`: also the Tauri command param type `append_distill_manifest`
/// deserializes IPC input into (`commands.rs`), reusing this shape rather
/// than defining a second one.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub(crate) struct MoveEntry {
    pub(crate) from: String,
    pub(crate) to: String,
}

/// Files one run moved, removed, or created. Revision maps identify recorded
/// bytes; native publication receipts establish creation authority. Entries without revisions remain
/// available for manual recovery. `started_at` orders run history only.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
struct RunManifest {
    id: String,
    #[serde(default)]
    started_at: i64,
    #[serde(default)]
    moves: Vec<MoveEntry>,
    #[serde(default)]
    trashed: Vec<MoveEntry>,
    /// Files removed without a recoverable destination; undo must never claim
    /// to restore these. Missing on older manifests.
    #[serde(default)]
    deleted: Vec<String>,
    #[serde(default)]
    created: Vec<String>,
    #[serde(default)]
    created_revisions: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    move_revisions: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    archive: Option<archive::ArchiveJournal>,
}

fn manifest_path(root: &Path, id: &str) -> PathBuf {
    dir(root).join("distill-runs").join(format!("{id}.json"))
}

/// Atomically save an ordinary run manifest through the native CAS writer.
/// Archive jobs use a persisted pre-move intent in `archive`; ordinary callers
/// that do not capture byte revisions remain ineligible for automatic undo.
fn save_manifest(root: &Path, m: &RunManifest) -> Result<(), String> {
    let target = manifest_path(root, &m.id);
    let target = crate::vault::confine_delete_path(root, &target.to_string_lossy())?;
    let runs_dir = target.parent().ok_or("manifest path has no parent")?;
    std::fs::create_dir_all(runs_dir).map_err(|e| format!("create distill-runs dir: {e}"))?;
    let raw = serde_json::to_string_pretty(m).map_err(|e| format!("serialize manifest: {e}"))?;
    let previous = match std::fs::read(&target) {
        Ok(bytes) => Some(archive::sha(&bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("read manifest before save: {error}")),
    };
    crate::vault::write_file_if_unchanged(&target.to_string_lossy(), &raw, previous.as_deref())?;
    Ok(())
}

fn permanently_delete_recorded(
    root: &Path,
    paths: &[PathBuf],
    manifest: &mut RunManifest,
) -> Result<(), String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("canonicalize vault: {e}"))?;
    let targets: Vec<PathBuf> = paths
        .iter()
        .map(|p| crate::vault::confine_delete_path(root, &p.to_string_lossy()))
        .collect::<Result<_, _>>()?;
    crate::vault::validate_remove_all(&targets)?;
    for target in targets {
        crate::vault::remove_all(std::slice::from_ref(&target))?;
        manifest.deleted.push(rel_string(&canonical_root, &target));
        save_manifest(root, manifest)?;
    }
    Ok(())
}

/// `id` must be a manifest id this crate itself would have generated —
/// `digest-<unix-seconds>` (a session-digest run) or `llm-<unix-seconds>`
/// (a TS-side LLM chain run), optionally suffixed `-<n>` by
/// `free_manifest_id`'s own collision guard. `id` is untrusted IPC input
/// (`append_distill_manifest`'s caller-supplied argument) and gets joined
/// straight into a `.myco/distill-runs/<id>.json` path, so this must reject
/// anything that isn't exactly that shape rather than let a crafted id read
/// or clobber an arbitrary file under `.myco/`.
fn valid_manifest_id(id: &str) -> bool {
    let rest = match id
        .strip_prefix("digest-")
        .or_else(|| id.strip_prefix("llm-"))
    {
        Some(r) => r,
        None => return false,
    };
    let is_digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let mut segs = rest.split('-');
    is_digits(segs.next().unwrap_or(""))
        && segs.next().map_or(true, is_digits)
        && segs.next().is_none()
}

/// Read-side guard for a run id coming in over IPC (`run_detail`, and the
/// run-diff command's commit lookup).
///
/// `valid_manifest_id` alone is the WRITE guard and deliberately admits only
/// the two prefixed shapes an IPC caller may append to. Rust's own runs are
/// named by `run_id` — `YYYYMMDDTHHMMSS`, no prefix — so validating a lookup
/// with the write guard rejected every real run on a real vault while the
/// `digest-`-shaped dev fixtures sailed through. Same traversal rule, both
/// shapes.
fn valid_lookup_id(id: &str) -> bool {
    if valid_manifest_id(id) {
        return true;
    }
    let is_digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let mut segs = id.split('-');
    let stamp = segs.next().unwrap_or("");
    let (day, time) = match stamp.split_once('T') {
        Some(p) => p,
        None => return false,
    };
    day.len() == 8
        && is_digits(day)
        && time.len() == 6
        && is_digits(time)
        && segs.next().map_or(true, is_digits)
        && segs.next().is_none()
}

/// Test compatibility adapter that derives proofs from fixture bytes.
/// Public IPC requires the writing workflow's explicit publication revisions.
#[cfg(test)]
pub(crate) fn append_distill_manifest(
    root: &Path,
    id: &str,
    moves: Vec<MoveEntry>,
    created: Vec<String>,
) -> Result<(), String> {
    archive::append_legacy(root, id, moves, created)
}

/// Record exact publication bytes supplied by the writing workflow.
pub(crate) fn append_distill_manifest_checked(
    root: &Path,
    id: &str,
    moves: Vec<MoveEntry>,
    publications: Vec<ArchivePublication>,
) -> Result<(), String> {
    archive::append_checked(root, id, moves, publications)
}

/// UTC (proleptic Gregorian) `(year, month, day, hour, minute, second)` from a
/// unix timestamp — Howard Hinnant's `civil_from_days` algorithm,
/// the same one `commands::current_month` uses (that one is hardcoded to
/// "now" and stops at the month; run ids and archive-month buckets need an
/// arbitrary timestamp — a file's own mtime, not always "now" — plus
/// time-of-day, so it is re-derived here rather than shared).
pub(crate) fn civil_datetime(secs: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400); // seconds of day, always in [0, 86400)
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = if m <= 2 { y + 1 } else { y };
    let hh = (sod / 3600) as u32;
    let mm = ((sod % 3600) / 60) as u32;
    let ss = (sod % 60) as u32;
    (y, m, d, hh, mm, ss)
}

/// Compact run id: `YYYYMMDDTHHMMSS`, UTC.
fn run_id(secs: i64) -> String {
    let (y, m, d, hh, mm, ss) = civil_datetime(secs);
    format!("{y:04}{m:02}{d:02}T{hh:02}{mm:02}{ss:02}")
}

/// `base`, or the same id suffixed `-2`, `-3`… if a manifest under that exact
/// id already exists — the collision guard both `free_run_id` and
/// `archive_digested_sessions`'s own digest-run id need, factored out so
/// there is exactly one collision loop.
fn free_manifest_id(root: &Path, base: &str) -> String {
    if !manifest_path(root, base).exists() {
        return base.to_string();
    }
    let mut n = 2u32;
    loop {
        let candidate = format!("{base}-{n}");
        if !manifest_path(root, &candidate).exists() {
            return candidate;
        }
        n += 1;
    }
}

/// `run_id(now)`, or the same id suffixed `-2`, `-3`… if a run already wrote
/// a manifest under that exact second — e.g. two runs kicked off back-to-back
/// within the same wall-clock second.
fn free_run_id(root: &Path, now: i64) -> String {
    free_manifest_id(root, &run_id(now))
}

/// `path`, or the same stem suffixed `-2`, `-3`… before the extension if it
/// already exists — the collision guard the archive move, the trash move,
/// and the proposal writer all share.
fn free_path(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("item")
        .to_string();
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(str::to_string);
    let mut n = 2u32;
    loop {
        let name = match &ext {
            Some(e) => format!("{stem}-{n}.{e}"),
            None => format!("{stem}-{n}"),
        };
        let candidate = parent.join(name);
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

/// Vault-relative, forward-slashed path — the one string form every manifest
/// entry and report line uses.
fn rel_string(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn mtime_secs(path: &Path) -> Option<i64> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs() as i64)
}

/// Lowercase, dash-separated slug for a proposal filename: non-alphanumerics
/// collapse to a single `-`, capped at 60 chars (plenty to stay readable
/// without a long title ballooning the filename).
///
/// Unicode-alphanumeric (mirrors `clip_filename`), not ASCII-only: an
/// ASCII-only slug collapsed every pure-Hangul title to an empty string,
/// leaving filenames that were just a date. NFC first so the filename is
/// written in the composed form the link index keys by.
fn slugify(s: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for c in crate::norm::nfc(s).chars() {
        if c.is_alphanumeric() {
            out.extend(c.to_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_matches('-').chars().take(60).collect::<String>()
}

/// Proposal writer: `work/feedback/<date>-<slug>.md` with `type:
/// distill-proposal`, `action: <kind>` (`admit-cluster` | `archive-batch` |
/// `delete-batch`), `status: pending`, `created: <date>`, and a `payload` JSON
/// blob `apply_proposal` reads back to know what to act on — the
/// proposal-inbox format from the design spec. Returns the vault-relative
/// path written.
///
/// ponytail: no de-dup here — a caller that wants "don't repeat this exact
/// proposal" checks pending proposals itself before calling in (see
/// `pending_admit_cluster_exists`, the fix Task 7 added for `admit-cluster`).
/// `archive-batch`/`delete-batch` still get a fresh proposal every run an
/// item keeps missing its window (e.g. a Conservative-intensity TTL item) —
/// same ceiling Task 6 originally documented here, just narrowed.
fn write_proposal(
    root: &Path,
    kind: &str,
    title: &str,
    body: &str,
    payload: &serde_json::Value,
) -> Result<String, String> {
    let (y, m, d, ..) = civil_datetime(now_secs());
    let feedback_dir = root.join("work/feedback");
    std::fs::create_dir_all(&feedback_dir).map_err(|e| format!("create work/feedback dir: {e}"))?;
    let file_name = format!("{y:04}-{m:02}-{d:02}-{}.md", slugify(title));
    let path = free_path(&feedback_dir.join(file_name));
    let payload_json =
        serde_json::to_string(payload).map_err(|e| format!("serialize payload: {e}"))?;
    let content = format!(
        "---\ntype: distill-proposal\naction: {kind}\nstatus: pending\ncreated: {y:04}-{m:02}-{d:02}\npayload: {payload_json}\n---\n\n# {title}\n\n{body}\n"
    );
    std::fs::write(&path, content).map_err(|e| format!("write proposal: {e}"))?;
    Ok(rel_string(root, &path))
}

/// Parse ANY markdown file's YAML frontmatter into its raw `Pod` map — `None`
/// if there is none, or it isn't a `Hash` at the top level. Shared by every
/// frontmatter reader in this module: proposals (`proposal_frontmatter`
/// narrows further), and Phase B's map-candidate pass, which reads ordinary
/// `wiki/` pages' `status`/`confidence`/`cluster` fields, not proposals'.
fn page_frontmatter(content: &str) -> Option<HashMap<String, gray_matter::Pod>> {
    let gray_matter::Pod::Hash(map) = gray_matter::Matter::<gray_matter::engine::YAML>::new()
        .parse(content)
        .ok()?
        .data?
    else {
        return None;
    };
    Some(map)
}

/// Parse a proposal file's YAML frontmatter into its raw `Pod` map, or `None`
/// if it isn't `type: distill-proposal` frontmatter at all. Shared by every
/// reader of the proposal lifecycle (pending check, dedup check, apply) so
/// the frontmatter shape lives in one place.
fn proposal_frontmatter(content: &str) -> Option<HashMap<String, gray_matter::Pod>> {
    let map = page_frontmatter(content)?;
    let is_proposal =
        matches!(map.get("type"), Some(gray_matter::Pod::String(s)) if s == "distill-proposal");
    is_proposal.then_some(map)
}

/// No `status` other than `pending` yet — a proposal the approve/dismiss
/// lifecycle has not resolved.
fn is_pending_map(map: &HashMap<String, gray_matter::Pod>) -> bool {
    !matches!(map.get("status"), Some(gray_matter::Pod::String(s)) if s != "pending")
}

/// `status: done` or `status: dismissed` only — a proposal that has actually
/// finished its lifecycle. Deliberately excludes `approved`: that status
/// means the frontend has flagged this proposal for `apply_proposal` to act
/// on next, not that it is resolved — if the idle run swept it into the
/// archive here, a run firing in the gap between the frontend's flip and the
/// apply call would silently orphan the user's decision.
fn is_resolved_map(map: &HashMap<String, gray_matter::Pod>) -> bool {
    matches!(map.get("status"), Some(gray_matter::Pod::String(s)) if s == "done" || s == "dismissed")
}

/// `pending` OR `approved` — both await resolution: pending needs a user
/// decision, approved is flagged for `apply_proposal` but hasn't run yet (or
/// ran and failed, awaiting a retry). Deliberately wider than `is_pending_map`
/// — that one stays pending-only for `pending_admit_cluster_exists`'
/// duplicate-proposal check, which must not match an already-approved one.
fn is_awaiting_resolution_map(map: &HashMap<String, gray_matter::Pod>) -> bool {
    !matches!(map.get("status"), Some(gray_matter::Pod::String(s)) if s != "pending" && s != "approved")
}

fn is_awaiting_resolution_proposal(content: &str) -> bool {
    proposal_frontmatter(content).is_some_and(|map| is_awaiting_resolution_map(&map))
}

/// A proposal's `payload.files` array as plain strings, or empty if the
/// payload is missing/malformed — callers treat that the same as "nothing to
/// act on" rather than a hard error.
fn proposal_payload_files(map: &HashMap<String, gray_matter::Pod>) -> Vec<String> {
    let payload = map
        .get("payload")
        .cloned()
        .map(crate::vault::pod_to_json)
        .unwrap_or(serde_json::Value::Null);
    payload
        .get("files")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// A proposal's `payload.cluster` field as a plain string, or `None` if the
/// payload is missing/malformed — mirrors `proposal_payload_files`, narrowed
/// to the scalar `draft-map` payload carries instead of a `files` array.
fn proposal_payload_cluster(map: &HashMap<String, gray_matter::Pod>) -> Option<String> {
    let payload = map
        .get("payload")
        .cloned()
        .map(crate::vault::pod_to_json)
        .unwrap_or(serde_json::Value::Null);
    payload
        .get("cluster")
        .and_then(|v| v.as_str())
        .map(String::from)
}

/// A proposal's `payload.members` array as plain strings, or empty if the
/// payload is missing/malformed — mirrors `proposal_payload_files`, the
/// `draft-map` payload's list field (`payload.cluster` above is its scalar
/// one).
fn proposal_payload_members(map: &HashMap<String, gray_matter::Pod>) -> Vec<String> {
    let payload = map
        .get("payload")
        .cloned()
        .map(crate::vault::pod_to_json)
        .unwrap_or(serde_json::Value::Null);
    payload
        .get("members")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// Proposals still awaiting resolution (`pending` or `approved`) — the
/// settings-tab badge / Overview count. Feeds `DistillStatus::pending_proposals`;
/// see `is_awaiting_resolution_map` for why `approved` counts too.
fn awaiting_resolution_count(root: &Path) -> usize {
    crate::vault::vault_entries(&root.join("work/feedback"))
        .into_iter()
        .filter(|(e, kind)| {
            kind.is_file() && e.path().extension().and_then(|x| x.to_str()) == Some("md")
        })
        .filter(|(e, _)| {
            std::fs::read_to_string(e.path())
                .map(|c| is_awaiting_resolution_proposal(&c))
                .unwrap_or(false)
        })
        .count()
}

fn quarantine_item_count(root: &Path) -> usize {
    let quarantine_dir = root.join(crate::commands::DEST_INBOX).join(QUARANTINE_DIR);
    crate::vault::vault_entries(&quarantine_dir)
        .into_iter()
        .filter(|(e, kind)| {
            kind.is_file() && e.file_name().to_string_lossy().ends_with(".verdict.json")
        })
        .count()
}

/// One `_inbox/quarantine/` item for the review UI (P0 quarantine review):
/// its content file's vault-relative path plus the verdict sidecar's own
/// fields and a short body preview. Every sidecar field degrades
/// independently — a missing, unparseable, or half-written sidecar still
/// lists its item (with zeros and an empty `reason`) rather than hiding it,
/// because the file is sitting in quarantine either way and the UI is the
/// only way out of there. The sidecar's `vector` is deliberately NOT
/// included: 384 floats per item, useless to a human reviewer.
#[derive(Debug, Default, serde::Serialize)]
pub struct QuarantineEntry {
    /// Vault-relative, e.g. `_inbox/quarantine/some-note.md`.
    pub path: String,
    pub name: String,
    /// Cosine similarity to the nearest cluster at scan time; 0.0 if unknown.
    pub s_knn: f32,
    pub nearest_cluster: String,
    /// `ontology::describe`'s English sentence, verbatim — carries the
    /// threshold `s_knn` was compared against, which the sidecar has no
    /// field of its own for.
    pub reason: String,
    /// Unix seconds after which the TTL pass trashes this, or asks first
    /// (`asks_on_expiry`); 0 if unknown.
    pub expires: i64,
    /// Whether that pass makes a delete proposal rather than trashing:
    /// `expiry_asks`, read off the sidecar and the vault's intensity.
    pub asks_on_expiry: bool,
}

/// The TTL pass's choice for an expired quarantine item. Spec 2026-10-02
/// decision 5: a session is deleted only by a click, whatever the intensity,
/// and so is an item whose sidecar recorded no origin (`from`), which may be
/// one. Conservative asks about everything.
fn expiry_asks(conservative: bool, from: Option<&str>) -> bool {
    conservative || !from.is_some_and(|f| !is_session(f))
}

/// First `PREVIEW_CHARS` characters of `content`'s body (frontmatter stripped
/// with the same `gray_matter` parse `first_summary_line` uses), whitespace
/// collapsed to single spaces so a preview is one line whatever the markdown
/// did.
fn body_preview(content: &str) -> String {
    const PREVIEW_CHARS: usize = 240;
    let body = gray_matter::Matter::<gray_matter::engine::YAML>::new()
        .parse::<gray_matter::Pod>(content)
        .map(|p| p.content)
        .unwrap_or_else(|_| content.to_string());
    truncate_chars(
        &body.split_whitespace().collect::<Vec<_>>().join(" "),
        PREVIEW_CHARS,
    )
}

/// Every item currently in `_inbox/quarantine/`, newest-expiry-last, for the
/// Feedback page's quarantine tab. Read-only: walks the content files (NOT the
/// sidecars — an item whose sidecar write never landed must still be
/// reviewable) and reads each one's sidecar best-effort. `preview` is returned
/// alongside so the UI never needs a second read per item.
pub fn quarantine_entries(root: &Path) -> Vec<(QuarantineEntry, String)> {
    let quarantine_dir = root.join(crate::commands::DEST_INBOX).join(QUARANTINE_DIR);
    let conservative = matches!(config_load(root).intensity, Intensity::Conservative);
    let mut out: Vec<(QuarantineEntry, String)> = crate::vault::vault_entries(&quarantine_dir)
        .into_iter()
        .filter(|(_, kind)| kind.is_file())
        .filter_map(|(e, _)| {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.ends_with(".verdict.json") {
                return None;
            }
            let rel = format!("{}/{QUARANTINE_DIR}/{name}", crate::commands::DEST_INBOX);
            let content = std::fs::read_to_string(e.path()).unwrap_or_default();
            let sidecar = std::fs::read_to_string(sidecar_path(&e.path()))
                .ok()
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                .unwrap_or(serde_json::Value::Null);
            Some((
                QuarantineEntry {
                    path: rel,
                    name,
                    s_knn: sidecar.get("s_knn").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32,
                    nearest_cluster: sidecar
                        .get("nearest_cluster")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    reason: sidecar
                        .get("reason")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    expires: sidecar.get("expires").and_then(|v| v.as_i64()).unwrap_or(0),
                    asks_on_expiry: expiry_asks(
                        conservative,
                        sidecar.get("from").and_then(|v| v.as_str()),
                    ),
                },
                body_preview(&content),
            ))
        })
        .collect();
    out.sort_by(|a, b| {
        a.0.expires
            .cmp(&b.0.expires)
            .then_with(|| a.0.path.cmp(&b.0.path))
    });
    out
}

/// `<stem>.verdict.json` beside a quarantined item's content file — the one
/// naming rule `free_quarantine_paths` writes and every reader here follows.
fn sidecar_path(content_path: &Path) -> PathBuf {
    content_path.with_file_name(format!(
        "{}.verdict.json",
        content_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("item")
    ))
}

/// The origin a quarantined item's sidecar recorded (`from`); `None` for a
/// sidecar written before the field existed, or a missing/unreadable one.
fn sidecar_from(sidecar: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(sidecar).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("from")?.as_str().map(String::from)
}

/// Whether a `.myco/trash/` dir holds a file whose sidecar says it came from
/// `sessions/`, or names no origin at all (a sidecar from before `from`
/// existed, or none) — the purge leaves such a dir alone.
fn may_hold_session(trash_dir: &Path) -> bool {
    crate::vault::vault_entries(trash_dir)
        .into_iter()
        .any(|(e, kind)| {
            let p = e.path();
            kind.is_file()
                && p.extension().and_then(|x| x.to_str()) == Some("md")
                && sidecar_from(&sidecar_path(&p)).map_or(true, |f| is_session(&f))
        })
}

/// Immediate purge requires an exact run-manifest inventory. A legacy or
/// proposal trash folder without that record is left in place.
fn recorded_trash_files(root: &Path, trash_dir: &Path) -> Result<Option<Vec<PathBuf>>, String> {
    let Some(id) = trash_dir.file_name().and_then(|s| s.to_str()) else {
        return Ok(None);
    };
    let manifest_file = manifest_path(root, id);
    let manifest_file = crate::vault::confine_delete_path(root, &manifest_file.to_string_lossy())?;
    if !manifest_file.exists() {
        return Ok(None);
    }
    let raw =
        std::fs::read_to_string(&manifest_file).map_err(|e| format!("read trash manifest: {e}"))?;
    let recorded: RunManifest =
        serde_json::from_str(&raw).map_err(|e| format!("parse trash manifest: {e}"))?;
    if recorded.id != id {
        return Ok(None);
    }
    let prefix = format!(".myco/trash/{id}/");
    let expected: std::collections::BTreeSet<String> = recorded
        .trashed
        .iter()
        .filter_map(|entry| {
            if !is_quarantine_payload_path(&entry.from) {
                return None;
            }
            entry
                .to
                .strip_prefix(&prefix)
                .filter(|name| !name.is_empty() && !name.contains('/'))
                .map(String::from)
        })
        .collect();
    let mut actual = std::collections::BTreeSet::new();
    let mut paths = Vec::new();
    for entry in std::fs::read_dir(trash_dir).map_err(|e| format!("read app trash: {e}"))? {
        let entry = entry.map_err(|e| format!("read app trash entry: {e}"))?;
        let kind = entry
            .file_type()
            .map_err(|e| format!("inspect app trash entry: {e}"))?;
        if !kind.is_file() {
            return Ok(None);
        }
        actual.insert(entry.file_name().to_string_lossy().into_owned());
        paths.push(entry.path());
    }
    Ok((!actual.is_empty() && actual == expected).then_some(paths))
}

fn purge_trash(
    root: &Path,
    now: i64,
    permanent: bool,
    manifest: &mut RunManifest,
) -> Result<usize, String> {
    let trash_root = dir(root).join("trash");
    let trash_root = crate::vault::confine_delete_path(root, &trash_root.to_string_lossy())?;
    if !trash_root.exists() {
        return Ok(0);
    }
    let mut deleted = 0;
    for entry in std::fs::read_dir(&trash_root).map_err(|e| format!("read app trash: {e}"))? {
        let entry = entry.map_err(|e| format!("read app trash entry: {e}"))?;
        let kind = entry
            .file_type()
            .map_err(|e| format!("inspect app trash entry: {e}"))?;
        if kind.is_symlink() {
            return Err("refused: app trash contains a symbolic link".into());
        }
        if !kind.is_dir() || may_hold_session(&entry.path()) {
            continue;
        }
        let aged = mtime_secs(&entry.path())
            .is_some_and(|mtime| now - mtime > TRASH_RETENTION_DAYS * 86_400);
        if permanent {
            let Some(paths) = recorded_trash_files(root, &entry.path())? else {
                continue;
            };
            deleted += paths
                .iter()
                .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("md"))
                .count();
            permanently_delete_recorded(root, &paths, manifest)?;
            std::fs::remove_dir(entry.path())
                .map_err(|e| format!("remove empty app trash directory: {e}"))?;
        } else if aged {
            // Preserve the original retention policy, but surface failures and
            // reject a symlink anywhere in the directory before removal.
            crate::vault::remove_all(&[entry.path()])?;
        }
    }
    Ok(deleted)
}

#[cfg(test)]
thread_local! {
    static KEEP_BEFORE_LOCK_HOOK: std::cell::RefCell<Option<Box<dyn Fn()>>> = const {
        std::cell::RefCell::new(None)
    };
}

#[cfg(test)]
pub(crate) fn set_keep_before_lock_hook(hook: impl Fn() + 'static) {
    KEEP_BEFORE_LOCK_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}

/// "Keep N more days": push each item's sidecar `expires` out by `days` from
/// whichever is later, now or its current expiry, so extending a not-yet-
/// expired item adds to its remaining time instead of shortening it. Only the
/// `expires` key is rewritten; other parsed fields are preserved. The payload
/// must still exist under the cooperating writer lock. Missing sidecars and
/// malformed/non-object JSON are skipped; read errors (including invalid UTF-8)
/// and lost payloads are errors.
/// A batch error names earlier extensions; it does not roll them back.
pub fn extend_quarantine(root: &Path, files: &[String], days: u32) -> Result<usize, String> {
    extend_quarantine_impl(
        root,
        files,
        days,
        #[cfg(test)]
        || {
            KEEP_BEFORE_LOCK_HOOK.with(|slot| {
                if let Some(hook) = slot.borrow().as_ref() {
                    hook();
                }
            });
        },
        #[cfg(test)]
        |_| Ok(()),
    )
}

fn extend_quarantine_impl(
    root: &Path,
    files: &[String],
    days: u32,
    #[cfg(test)] before_lock: impl FnOnce(),
    #[cfg(test)] mut after_read: impl FnMut(&Path) -> Result<(), String>,
) -> Result<usize, String> {
    crate::vault::with_root_mutation_impl(
        root,
        |canonical_root, guard| {
            let now = now_secs();
            let mut extended = Vec::new();
            for file in files {
                let changed = extend_quarantine_item(
                    canonical_root,
                    guard,
                    file,
                    now,
                    days,
                    #[cfg(test)]
                    &mut after_read,
                )
                .map_err(|error| {
                    format!(
                        "Keep failed for {file}; extended [{}]: {error}",
                        extended.join(", ")
                    )
                })?;
                if changed {
                    extended.push(file.as_str());
                }
            }
            Ok(extended.len())
        },
        #[cfg(test)]
        before_lock,
    )
}

fn keep_regular_file(root: &Path, path: &Path) -> Result<Option<PathBuf>, String> {
    let path = crate::vault::confine_delete_path(root, &path.to_string_lossy())?;
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("inspect Keep file {}: {error}", path.display())),
    };
    if !metadata.is_file() {
        return Err(format!(
            "Keep target is not a regular file: {}",
            path.display()
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err(format!(
                "Keep target has additional hard links: {}",
                path.display()
            ));
        }
    }
    Ok(Some(path))
}

fn extend_quarantine_item(
    root: &Path,
    guard: &std::sync::MutexGuard<'_, ()>,
    file: &str,
    now: i64,
    days: u32,
    #[cfg(test)] after_read: &mut impl FnMut(&Path) -> Result<(), String>,
) -> Result<bool, String> {
    let content =
        confine_payload_file(root, file, is_quarantine_payload_path, "_inbox/quarantine/")?;
    let content =
        keep_regular_file(root, &content)?.ok_or("Keep payload is missing or already moved")?;
    let path = sidecar_path(&content);
    let Some(path) = keep_regular_file(root, &path)? else {
        return Ok(false);
    };
    let raw =
        std::fs::read_to_string(&path).map_err(|error| format!("read Keep verdict: {error}"))?;
    let Ok(mut sidecar) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Ok(false);
    };
    let Some(map) = sidecar.as_object_mut() else {
        return Ok(false);
    };
    let current = map
        .get("expires")
        .and_then(|value| value.as_i64())
        .unwrap_or(0);
    let expires = current
        .max(now)
        .checked_add(i64::from(days) * 86_400)
        .ok_or("Keep expiry would overflow")?;
    map.insert("expires".into(), expires.into());
    let out = serde_json::to_string_pretty(&sidecar)
        .map_err(|error| format!("serialize Keep verdict: {error}"))?;
    #[cfg(test)]
    after_read(&path)?;
    keep_regular_file(root, &content)?.ok_or("Keep payload is missing or already moved")?;
    keep_regular_file(root, &path)?.ok_or("Keep verdict changed while it was read")?;
    crate::vault::write_file_if_unchanged_recorded_locked(
        guard,
        &path.to_string_lossy(),
        &out,
        Some(&admission::sha256(raw.as_bytes())),
    )?;
    Ok(true)
}

/// Cheap backlog estimate: inflow candidates the ledger has not yet scored,
/// plus everything currently sitting in quarantine. A fs walk, not a
/// re-score — good enough for a trend line, not a substitute for `scan`'s own
/// count.
fn backlog_count(root: &Path, state: &DistillState) -> usize {
    let unscored = collect_candidates(root)
        .iter()
        .filter(|c| !metadata_is_scored(root, state, &c.rel))
        .count();
    unscored + quarantine_item_count(root)
}

fn backlog_count_checked(root: &Path, state: &DistillState) -> Result<usize, String> {
    let mut unscored = 0;
    for candidate in collect_candidates(root) {
        if !is_scored_current(root, state, &candidate.rel)? {
            unscored += 1;
        }
    }
    Ok(unscored + quarantine_item_count(root))
}

/// Paths `run` can touch — the only ones ever staged, so a distill commit
/// never absorbs an unrelated user edit sitting elsewhere in the vault.
/// Mirrors the `git_commit` MCP tool's approach (`mcp_native.rs`): check each
/// path's existence before staging it, rather than pass a missing pathspec to
/// git (which errors on one) or fall back to `git add -A`.
const GIT_COMMIT_PATHS: &[&str] = &[
    "raw",
    "wiki",
    crate::commands::DEST_INBOX,
    crate::commands::DEST_SESSIONS,
    "work",
    "ingest-reports",
];

/// Commit this run's changes when the vault is itself a git repo — never
/// initializes one, and never stages anything outside `GIT_COMMIT_PATHS`
/// plus `.myco` (and `.myco` only when `git ls-files` shows the vault
/// already tracks it — a vault that gitignores its own state dir must not
/// have it force-added just because this run happened to touch it). Best-
/// effort: the shared `vault_history::commit_paths` helper no-ops when
/// nothing is staged and errors on a failed add/commit, which is only
/// logged here — the commit is authored as the agent so distill's changes
/// stay distinguishable from the user's own edits.
fn git_commit_run(root: &Path, run_id: &str) {
    if !root.join(".git").exists() {
        return;
    }
    let mut paths: Vec<&str> = GIT_COMMIT_PATHS
        .iter()
        .copied()
        .filter(|p| root.join(p).exists())
        .collect();
    if root.join(".myco").exists() {
        if let Ok(o) = std::process::Command::new("git")
            .args(["ls-files", "--", ".myco"])
            .current_dir(root)
            .output()
        {
            if o.status.success() && !o.stdout.is_empty() {
                paths.push(".myco");
            }
        }
    }
    if paths.is_empty() {
        return; // nothing distill touches even exists yet
    }
    if let Err(e) = crate::vault_history::commit_paths(
        root,
        &paths,
        &format!("distill: run {run_id}"),
        crate::vault_history::CommitIdentity::Agent,
    ) {
        eprintln!("distill run {run_id}: {e}");
    }
}

#[allow(clippy::too_many_arguments)]
fn render_report(
    id: &str,
    cfg: &DistillConfig,
    ontology_rebuilt: bool,
    scan: &ScanOutcome,
    trashed: usize,
    proposals: usize,
    manifest: &RunManifest,
    backlog_after: usize,
) -> String {
    let mut s = format!("# Distill run {id}\n\n");
    s += &format!("Intensity: {:?}\n", cfg.intensity);
    s += &format!(
        "Ontology: {}\n\n",
        if ontology_rebuilt {
            "rebuilt this run"
        } else {
            "reused (wiki page count unchanged)"
        }
    );
    s += "## Scan\n\n";
    s += &format!("- scored: {}\n", scan.scored);
    s += &format!("- quarantined: {}\n", scan.quarantined);
    s += &format!("- rejected: {}\n", scan.rejected);
    s += &format!("- summaries: {}\n", scan.summaries);
    s += &format!("- full: {}\n", scan.full);
    s += &format!("- skipped (immature): {}\n\n", scan.skipped_immature);

    s += "## Moved\n\n";
    if manifest.moves.is_empty() {
        s += "(none)\n";
    } else {
        for m in &manifest.moves {
            s += &format!("- `{}` -> `{}`\n", m.from, m.to);
        }
    }
    s += "\n";

    s += "## Permanently deleted\n\n";
    if manifest.deleted.is_empty() {
        s += "(none)\n";
    } else {
        for path in &manifest.deleted {
            s += &format!("- `{path}`\n");
        }
        s += "\nThese files cannot be restored by Undo.\n";
    }
    s += "\n";

    s += &format!("## Trash ({trashed} quarantine items expired)\n\n");
    if manifest.trashed.is_empty() {
        s += "(none)\n";
    } else {
        for m in &manifest.trashed {
            s += &format!("- `{}` -> `{}`\n", m.from, m.to);
        }
    }
    s += "\n";

    s += &format!("## Proposals ({proposals} written)\n\n");
    if manifest.created.is_empty() {
        s += "(none)\n";
    } else {
        for c in &manifest.created {
            s += &format!("- `{c}`\n");
        }
    }
    s += "\n";

    s += &format!("Backlog after this run: {backlog_after}\n\n");
    s += &format!(
        "## Undo\n\nRun `undo_distill_run` with id `{id}` for operations with native undo authority. \
         Unsigned move and trash history requires manual recovery from the recorded destinations. \
         Permanently deleted files cannot be restored.\n"
    );
    s
}

// ---------------------------------------------------------------------------
// Emerging-cluster detection + proposal lifecycle (Task 7, Phase A): group
// quarantined items that look like a forming topic, propose admitting them,
// and let an approved/dismissed proposal actually be applied or archived. See
// `app/docs/specs/2026-08-13-ontology-distill-design.md` ("New topic forming").
// ---------------------------------------------------------------------------

/// Minimum cosine similarity for two quarantined items to union into the same
/// emerging-topic group. A first guess, not yet measured against a real
/// vault's quarantine pile — calibration-pending, same caveat the admission
/// gate's own thresholds carry (see `ontology.rs`).
const EMERGING_MIN_SIM: f32 = 0.55;

/// Minimum group size before an emerging cluster is worth a proposal — below
/// this it reads as coincidence, not a forming topic.
const EMERGING_MIN_SIZE: usize = 5;

/// One quarantined item's rel path and the fields of its verdict sidecar the
/// clustering/proposal pass needs.
struct SidecarInfo {
    vector: Vec<f32>,
    nearest_cluster: String,
    s_knn: f32,
    embedding: EmbeddingSpace,
    decision_signature: String,
    source_sha256: String,
    sidecar_sha256: String,
    first_line: String,
}

/// Read `_inbox/quarantine/<stem>.verdict.json` for a quarantined item given
/// its content file's rel path. Legacy unstamped and rule-only sidecars stay
/// reviewable, but provide no semantic vector. Stamped malformed input is an
/// explicit error; it is never shortened, normalized, rewritten or deleted.
fn read_sidecar(root: &Path, content_rel: &str) -> Result<Option<SidecarInfo>, String> {
    let Some(source) = admission::read_source(root, content_rel)? else {
        return Ok(None);
    };
    let content_path = root.join(content_rel);
    let content_path = crate::vault::confine_delete_path(root, &content_path.to_string_lossy())?;
    let path = sidecar_path(&content_path);
    let path = crate::vault::confine_delete_path(root, &path.to_string_lossy())?;
    let Some(raw) = crate::index_publication::read_checked(&path)? else {
        return Ok(None);
    };
    let value: serde_json::Value = serde_json::from_slice(&raw)
        .map_err(|_| "quarantine semantic sidecar is corrupt".to_string())?;
    if !value.is_object() {
        return Err("quarantine semantic sidecar is not an object".into());
    }
    let Some(stamp) = value.get("embedding").filter(|stamp| !stamp.is_null()) else {
        return Ok(None);
    };
    let embedding: EmbeddingSpace = serde_json::from_value(stamp.clone())
        .map_err(|_| "quarantine representation identity is malformed".to_string())?;
    embedding.validate()?;
    let vector: Vec<f32> = value
        .get("vector")
        .and_then(serde_json::Value::as_array)
        .ok_or("quarantine semantic vector is missing or malformed")?
        .iter()
        .map(|member| {
            member
                .as_f64()
                .map(|number| number as f32)
                .ok_or("quarantine semantic vector contains a nonnumeric member".to_string())
        })
        .collect::<Result<_, _>>()?;
    crate::embeddings::checked_vector_norm(&vector, Some(embedding.dim))?;
    let s_knn = value
        .get("s_knn")
        .and_then(serde_json::Value::as_f64)
        .ok_or("quarantine semantic score is missing or malformed")? as f32;
    if !s_knn.is_finite() {
        return Err("quarantine semantic score is nonfinite".into());
    }
    let nearest_cluster = value
        .get("nearest_cluster")
        .and_then(serde_json::Value::as_str)
        .ok_or("quarantine nearest-cluster metadata is malformed")?
        .to_string();
    let receipt = |key: &str| -> Result<Option<String>, String> {
        match value.get(key).filter(|value| !value.is_null()) {
            None => Ok(None),
            Some(value) => value
                .as_str()
                .filter(|signature| admission::valid_digest(signature))
                .map(|signature| Some(signature.to_string()))
                .ok_or_else(|| format!("quarantine {key} provenance is malformed")),
        }
    };
    let source_sha256 = receipt("source_sha256")?;
    let decision_signature = receipt("decision_signature")?;
    let (Some(source_sha256), Some(decision_signature)) = (source_sha256, decision_signature)
    else {
        return Ok(None);
    };
    if source.sha256 != source_sha256 {
        return Ok(None);
    }
    let content =
        String::from_utf8(source.bytes).map_err(|_| "quarantine semantic content is not UTF-8")?;
    let first_line = content
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
        .to_string();
    Ok(Some(SidecarInfo {
        vector,
        nearest_cluster,
        s_knn,
        embedding,
        decision_signature,
        source_sha256,
        sidecar_sha256: admission::sha256(&raw),
        first_line,
    }))
}

/// Every currently-quarantined item's rel path + embedding vector, sorted by
/// path — the deterministic order `emerging_clusters` groups over.
fn quarantine_vectors(
    root: &Path,
    expected: Option<&EmbeddingSpace>,
    decision_signature: Option<&str>,
) -> Result<Vec<(String, SidecarInfo)>, String> {
    if let Some(space) = expected {
        space.validate()?;
    }
    let quarantine_dir = root.join(crate::commands::DEST_INBOX).join(QUARANTINE_DIR);
    let quarantine_dir =
        crate::vault::confine_delete_path(root, &quarantine_dir.to_string_lossy())?;
    let entries = match crate::vault::vault_entries_checked(&quarantine_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("quarantine semantic directory is unreadable or nonregular".into()),
    };
    // The generic vault walker deliberately skips symbolic links. A semantic
    // snapshot instead rejects a linked/nonregular member so it cannot appear
    // to be a complete valid collection after omitting one.
    for entry in
        std::fs::read_dir(&quarantine_dir).map_err(|_| "read quarantine semantic directory")?
    {
        let entry = entry.map_err(|_| "read quarantine semantic entry")?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with('.') && (name.ends_with(".verdict.json") || name.ends_with(".md")) {
            let kind = entry
                .file_type()
                .map_err(|_| "inspect quarantine semantic entry")?;
            if !kind.is_file() || kind.is_symlink() {
                return Err("quarantine semantic member is not a regular file".into());
            }
        }
    }
    let mut out = Vec::new();
    for (entry, kind) in entries {
        if !kind.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(stem) = name.strip_suffix(".verdict.json") else {
            continue;
        };
        let content_rel = format!("{}/{QUARANTINE_DIR}/{stem}.md", crate::commands::DEST_INBOX);
        let Some(info) = read_sidecar(root, &content_rel)? else {
            continue;
        };
        // A valid old representation is retained pending migration, never
        // compared with the active one or used to authorize a proposal.
        if Some(&info.embedding) == expected
            && Some(info.decision_signature.as_str()) == decision_signature
        {
            out.push((content_rel, info));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

/// Greedy connected-components clustering over quarantine sidecar vectors:
/// union any pair whose cosine similarity clears `min_sim`, then keep only
/// components with at least `min_size` members. Deterministic (items are
/// walked in sorted-path order, ties in union direction always resolve
/// toward the lower index) so the same quarantine pile always groups the
/// same way.
///
/// ponytail: O(n^2) pairwise comparisons — fine at quarantine-pile sizes
/// (tens to low hundreds); an ANN index would be the upgrade if quarantine
/// ever grows into the thousands.
pub fn emerging_clusters(
    root: &Path,
    min_size: usize,
    min_sim: f32,
) -> Result<Vec<Vec<String>>, String> {
    let store = current_store(root)?;
    let space = optional_store_space(&store)?;
    let cfg = config_load_checked(root)?;
    let inputs = admission::current(root, &store, &cfg)?;
    let items = quarantine_vectors(
        root,
        space.as_ref(),
        inputs.as_ref().map(|inputs| inputs.signature.as_str()),
    )?;
    let groups = emerging_groups(&items, min_size, min_sim)?;
    Ok(groups
        .into_iter()
        .map(|group| {
            group
                .into_iter()
                .map(|index| items[index].0.clone())
                .collect()
        })
        .collect())
}

fn current_store(root: &Path) -> Result<crate::vector_index::VectorStore, String> {
    let canonical = root
        .canonicalize()
        .map_err(|_| "canonicalize distill index root")?;
    let path = crate::vector_index::VectorStore::path_for(&canonical.to_string_lossy())?;
    crate::vector_index::VectorStore::load_checked(&path)
}

#[cfg(test)]
pub(crate) fn test_current_decision_signature(root: &Path) -> Result<Option<String>, String> {
    let store = current_store(root)?;
    let cfg = config_load_checked(root)?;
    Ok(admission::current(root, &store, &cfg)?.map(|inputs| inputs.signature))
}

fn optional_store_space(
    store: &crate::vector_index::VectorStore,
) -> Result<Option<EmbeddingSpace>, String> {
    if store.dim == 0 && store.records.is_empty() {
        return Ok(None);
    }
    store.embedding_space().map(Some)
}

/// Display counts may degrade after an explicit diagnostic, but they must not
/// count stale semantic entries as current because the model name still matches.
fn metadata_state(root: &Path) -> DistillState {
    let result = current_store(root).and_then(|store| {
        let space = optional_store_space(&store)?;
        let cfg = config_load_checked(root)?;
        let inputs = admission::current(root, &store, &cfg)?;
        state_for_inputs(root, space.as_ref(), &store.model, inputs.as_ref())
    });
    result.unwrap_or_else(|error| {
        eprintln!("myco: distill metadata context unavailable: {error}");
        let mut state = state_load(root, "");
        state.embedding = None;
        state.decision_signature = None;
        state
    })
}

fn verify_current_inputs(
    root: &Path,
    cfg: &DistillConfig,
    inputs: &admission::DecisionInputs,
) -> Result<(), String> {
    let current_cfg = config_load_checked(root)?;
    if serde_json::to_value(&current_cfg).map_err(|_| "serialize current distill policy")?
        != serde_json::to_value(cfg).map_err(|_| "serialize pinned distill policy")?
    {
        return Err("distill configuration changed before publication".into());
    }
    let store = current_store(root)?;
    let current = admission::current(root, &store, &current_cfg)?;
    if current.as_ref().map(|current| current.signature.as_str()) != Some(inputs.signature.as_str())
    {
        return Err("distill published decision inputs changed before publication".into());
    }
    Ok(())
}

fn emerging_groups(
    items: &[(String, SidecarInfo)],
    min_size: usize,
    min_sim: f32,
) -> Result<Vec<Vec<usize>>, String> {
    if !min_sim.is_finite() {
        return Err("emerging-cluster similarity threshold is nonfinite".into());
    }
    let n = items.len();

    fn find(parent: &mut [usize], x: usize) -> usize {
        if parent[x] != x {
            parent[x] = find(parent, parent[x]);
        }
        parent[x]
    }

    let mut parent: Vec<usize> = (0..n).collect();
    for i in 0..n {
        for j in (i + 1)..n {
            if crate::embeddings::checked_cosine(&items[i].1.vector, &items[j].1.vector)? >= min_sim
            {
                let (ri, rj) = (find(&mut parent, i), find(&mut parent, j));
                if ri != rj {
                    parent[ri.max(rj)] = ri.min(rj);
                }
            }
        }
    }

    let mut groups: HashMap<usize, Vec<usize>> = HashMap::new();
    for i in 0..n {
        groups.entry(find(&mut parent, i)).or_default().push(i);
    }
    let mut out: Vec<Vec<usize>> = groups
        .into_values()
        .filter(|g| g.len() >= min_size)
        .collect();
    out.sort_by(|a, b| a[0].cmp(&b[0])); // by first (already sorted) member
    Ok(out)
}

/// A handful of connective words worth ignoring in `label_cluster`'s crude
/// token frequency count — not a real stopword list, just enough to keep the
/// label from landing on "this"/"with" instead of a topical word.
const LABEL_STOPWORDS: &[&str] = &[
    "the", "and", "for", "with", "this", "that", "from", "are", "was", "were", "have", "has",
    "not", "but", "its", "into",
];

/// Crude, deterministic label for a cluster of quarantined items: the most
/// frequent word (>= 3 chars, past `LABEL_STOPWORDS`) across each member's
/// file stem and the first non-empty line of its content — counted once per
/// member so one repetitive file can't dominate — tie-broken alphabetically.
/// Simple on purpose; swap for something smarter (e.g. TF-IDF against the
/// ontology's own vocabulary) if this proves too crude in practice.
fn label_cluster(items: &[(String, SidecarInfo)], members: &[usize]) -> String {
    fn tokens(s: &str) -> impl Iterator<Item = String> + '_ {
        s.split(|c: char| !c.is_alphanumeric())
            .map(str::to_lowercase)
            .filter(|t| t.len() >= 3 && !LABEL_STOPWORDS.contains(&t.as_str()))
    }

    let mut counts: HashMap<String, usize> = HashMap::new();
    for index in members {
        let (member, info) = &items[*index];
        let mut seen = std::collections::HashSet::new();
        if let Some(stem) = Path::new(member).file_stem().and_then(|s| s.to_str()) {
            seen.extend(tokens(stem));
        }
        seen.extend(tokens(&info.first_line));
        for t in seen {
            *counts.entry(t).or_insert(0) += 1;
        }
    }

    let mut pairs: Vec<(String, usize)> = counts.into_iter().collect();
    pairs.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    pairs
        .into_iter()
        .next()
        .map(|(t, _)| t)
        .unwrap_or_else(|| "new topic".to_string())
}

/// True if a PENDING `admit-cluster` proposal already names this exact
/// (sorted) file set — the no-dedup ceiling `write_proposal`'s doc comment
/// used to accept for every proposal kind is now fixable for this one,
/// because a proposal lifecycle exists to mark one resolved.
fn pending_admit_cluster_exists(root: &Path, files: &[String]) -> bool {
    let mut want = files.to_vec();
    want.sort();
    crate::vault::vault_entries(&root.join("work/feedback"))
        .into_iter()
        .filter(|(e, kind)| {
            kind.is_file() && e.path().extension().and_then(|x| x.to_str()) == Some("md")
        })
        .any(|(e, _)| {
            let Ok(content) = std::fs::read_to_string(e.path()) else {
                return false;
            };
            let Some(map) = proposal_frontmatter(&content) else {
                return false;
            };
            if !is_pending_map(&map) {
                return false;
            }
            let is_admit =
                matches!(map.get("action"), Some(gray_matter::Pod::String(s)) if s == "admit-cluster");
            if !is_admit {
                return false;
            }
            let mut existing = proposal_payload_files(&map);
            existing.sort();
            existing == want
        })
}

/// True if a PENDING `action` proposal already names exactly this one file
/// — the same de-dup `pending_admit_cluster_exists` gives `admit-cluster`,
/// narrowed to a single file: unlike an emerging cluster, a summary-tier
/// item or an expired quarantine item gets its own proposal, mirroring the
/// raw archive pass's per-file `archive-batch` proposals rather than
/// grouping many files into one.
fn pending_file_proposal_exists(root: &Path, action: &str, rel: &str) -> bool {
    crate::vault::vault_entries(&root.join("work/feedback"))
        .into_iter()
        .filter(|(e, kind)| {
            kind.is_file() && e.path().extension().and_then(|x| x.to_str()) == Some("md")
        })
        .any(|(e, _)| {
            let Ok(content) = std::fs::read_to_string(e.path()) else {
                return false;
            };
            let Some(map) = proposal_frontmatter(&content) else {
                return false;
            };
            if !is_pending_map(&map) {
                return false;
            }
            let is_action =
                matches!(map.get("action"), Some(gray_matter::Pod::String(s)) if s == action);
            is_action && proposal_payload_files(&map) == [rel.to_string()]
        })
}

/// `|a ∩ b| / min(|a|, |b|)` — min-based rather than union/Jaccard so a
/// cluster that grew or shrank a little since a proposal was written, but
/// kept its original core intact, still reads as "the same forming topic"
/// instead of being diluted by members unique to either side. `0.0` if
/// either side is empty (vacuously no overlap, not divide-by-zero).
fn overlap_ratio(a: &[String], b: &[String]) -> f32 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let b_set: std::collections::HashSet<&str> = b.iter().map(String::as_str).collect();
    let shared = a.iter().filter(|x| b_set.contains(x.as_str())).count();
    shared as f32 / a.len().min(b.len()) as f32
}

/// True if a `draft-map` proposal for this cluster is already awaiting
/// resolution (`pending` OR `approved` — see `is_awaiting_resolution_map`).
/// Approved counts too, unlike `pending_admit_cluster_exists`'s pending-only
/// check: at `Intensity::Aggressive`, `propose_map_candidates` writes
/// `draft-map` straight to `status: approved` (the TS-side post-run
/// auto-apply picks it up), so a run firing again before that apply happens
/// must still see this cluster as already spoken for.
///
/// Matched two ways: the fast path is an exact `cluster_label` match against
/// the proposal's `payload.cluster`; the fallback is `>= 50%` member overlap
/// between `cluster_members` (the CURRENT cluster being evaluated) and the
/// proposal's own `payload.members` — needed because the label is a medoid
/// stem that can drift to a different member between when the proposal was
/// written and this run, and an exact-label-only check would then miss it
/// and write a second proposal for what is substantially the same topic
/// (fix round 2; same drift-tolerance rule as the map-exists/anchor checks).
fn pending_draft_map_exists(root: &Path, cluster_label: &str, cluster_members: &[String]) -> bool {
    crate::vault::vault_entries(&root.join("work/feedback"))
        .into_iter()
        .filter(|(e, kind)| {
            kind.is_file() && e.path().extension().and_then(|x| x.to_str()) == Some("md")
        })
        .any(|(e, _)| {
            let Ok(content) = std::fs::read_to_string(e.path()) else {
                return false;
            };
            let Some(map) = proposal_frontmatter(&content) else {
                return false;
            };
            if !is_awaiting_resolution_map(&map) {
                return false;
            }
            let is_draft_map =
                matches!(map.get("action"), Some(gray_matter::Pod::String(s)) if s == "draft-map");
            if !is_draft_map {
                return false;
            }
            if proposal_payload_cluster(&map).as_deref() == Some(cluster_label) {
                return true;
            }
            overlap_ratio(&proposal_payload_members(&map), cluster_members) >= 0.5
        })
}

/// Emerging-cluster + proposal pass (run() step ⑥): quarantined items whose
/// pairwise similarity clusters into a group of at least `EMERGING_MIN_SIZE`
/// are proposed as a new topic, unless a pending `admit-cluster` proposal for
/// the exact same file set already exists. Returns the number of proposals
/// written; `save_manifest`s after each one, same as every other pass.
#[cfg(test)]
fn propose_emerging_clusters(root: &Path, manifest: &mut RunManifest) -> Result<usize, String> {
    let store = current_store(root)?;
    let space = optional_store_space(&store)?;
    let cfg = config_load_checked(root)?;
    let inputs = admission::current(root, &store, &cfg)?;
    propose_emerging_clusters_for_inputs(
        root,
        space.as_ref(),
        inputs.as_ref(),
        &cfg,
        true,
        manifest,
    )
}

fn propose_emerging_clusters_for_inputs(
    root: &Path,
    space: Option<&EmbeddingSpace>,
    inputs: Option<&admission::DecisionInputs>,
    cfg: &DistillConfig,
    verify_published: bool,
    manifest: &mut RunManifest,
) -> Result<usize, String> {
    let items = quarantine_vectors(root, space, inputs.map(|inputs| inputs.signature.as_str()))?;
    let groups = emerging_groups(&items, EMERGING_MIN_SIZE, EMERGING_MIN_SIM)?;
    // Prepare every checked group from one immutable sidecar snapshot before
    // writing the first proposal. A later input error cannot leave an earlier
    // valid group's proposal or an incrementally changed manifest behind.
    let mut prepared = Vec::new();
    for indices in groups {
        let files: Vec<String> = indices
            .iter()
            .map(|index| items[*index].0.clone())
            .collect();
        if pending_admit_cluster_exists(root, &files) {
            continue;
        }
        let mut sum = crate::embeddings::CompensatedSum::default();
        let mut pairs = 0usize;
        for i in 0..indices.len() {
            for j in (i + 1)..indices.len() {
                sum.add(f64::from(crate::embeddings::checked_cosine(
                    &items[indices[i]].1.vector,
                    &items[indices[j]].1.vector,
                )?));
                pairs += 1;
            }
        }
        let mean_sim = if pairs > 0 {
            sum.total() / pairs as f64
        } else {
            0.0
        };
        if !mean_sim.is_finite() {
            return Err("emerging-cluster mean similarity is nonfinite".into());
        }
        let label = label_cluster(&items, &indices);
        let mut body = format!(
            "{} quarantined items cluster together (mean similarity {mean_sim:.2}). Admit as a \
             new topic?\n\n",
            files.len()
        );
        for index in indices {
            let (file, info) = &items[index];
            body += &format!(
                "- [[{file}]] — nearest '{}' {:.2}\n",
                info.nearest_cluster, info.s_knn
            );
        }
        prepared.push((label, body, files));
    }
    if !prepared.is_empty() {
        if verify_published {
            verify_current_inputs(
                root,
                cfg,
                inputs.ok_or("distill proposal has no current decision context")?,
            )?;
        }
        for (rel, info) in &items {
            if !admission::source_matches(root, rel, &info.source_sha256)? {
                return Err("quarantine source changed before proposal publication".into());
            }
            let path = sidecar_path(&root.join(rel));
            let sidecar_rel = rel_string(root, &path);
            if !admission::source_matches(root, &sidecar_rel, &info.sidecar_sha256)? {
                return Err("quarantine sidecar changed before proposal publication".into());
            }
        }
    }
    let mut written = 0usize;
    for (label, body, files) in prepared {
        let rel = write_proposal(
            root,
            "admit-cluster",
            &format!("New topic forming: {label}"),
            &body,
            &serde_json::json!({ "files": files }),
        )?;
        manifest.created.push(rel);
        save_manifest(root, manifest)?;
        written += 1;
    }
    Ok(written)
}

/// Minimum members (AFTER the maturity filter below) before a topic cluster
/// is worth proposing as a map — bigger than `EMERGING_MIN_SIZE` because a
/// map is a bigger commitment than a quarantine group: a whole page, drafted
/// by a paid LLM call, once approved.
const MAP_MIN_MEMBERS: usize = 8;

/// How old (days) a member page must be before it counts toward a map
/// candidate. Spec approximation of "settled" — the design spec's own
/// wording is qualitative ("mature enough"); this hardcodes a concrete
/// number rather than exposing yet another setting, the same call
/// `TRASH_RETENTION_DAYS` makes.
const MAP_MATURITY_DAYS: i64 = 7;

/// `cluster:` frontmatter values already claimed by an existing `wiki/maps/`
/// page — a cheap scan (frontmatter only, via `page_frontmatter`, the same
/// parse every other proposal/page reader in this module shares) so a topic
/// that already has a map is never proposed again.
fn existing_map_clusters(root: &Path) -> std::collections::HashSet<String> {
    crate::vault::vault_entries(&root.join("wiki/maps"))
        .into_iter()
        .filter(|(e, kind)| {
            kind.is_file() && e.path().extension().and_then(|x| x.to_str()) == Some("md")
        })
        .filter_map(|(e, _)| {
            let content = std::fs::read_to_string(e.path()).ok()?;
            let map = page_frontmatter(&content)?;
            match map.get("cluster") {
                Some(gray_matter::Pod::String(s)) => Some(s.clone()),
                _ => None,
            }
        })
        .collect()
}

/// Whether a cluster member (a `wiki/`-relative page path) is mature enough
/// to count toward a map candidate: `status: active`, `confidence` anything
/// but `low`, and its own mtime older than `MAP_MATURITY_DAYS` — the spec's
/// approximation of "settled", not a re-derivation of `admit`'s tiers (this
/// is about a page already IN the wiki, not inflow being gated into it).
/// `false` for a missing/unreadable/frontmatter-less page rather than an
/// error: one bad member must not abort the whole cluster's evaluation.
///
/// ponytail: one `fs::read_to_string` per member, per run, with no cache —
/// bounded by cluster size (only clusters already past `MAP_MIN_MEMBERS`
/// reach here) so fine at today's scale; upgrade to a shared frontmatter
/// cache (or reuse `scan`'s content-hash ledger) if this pass ever shows up
/// in a run's wall time on a large vault.
fn member_is_mature(root: &Path, member: &str, now: i64) -> bool {
    let path = root.join(member);
    let Ok(content) = std::fs::read_to_string(&path) else {
        return false;
    };
    let Some(map) = page_frontmatter(&content) else {
        return false;
    };
    let is_active = matches!(map.get("status"), Some(gray_matter::Pod::String(s)) if s == "active");
    let not_low = !matches!(map.get("confidence"), Some(gray_matter::Pod::String(s)) if s == "low");
    if !is_active || !not_low {
        return false;
    }
    let Some(mtime) = mtime_secs(&path) else {
        return false;
    };
    now - mtime >= MAP_MATURITY_DAYS * 86_400
}

/// Map-candidate + proposal pass (Phase B, Task 4): a topic cluster that has
/// grown to at least `MAP_MIN_MEMBERS` mature members, and has no
/// `wiki/maps/` page yet, gets a `draft-map` proposal — see
/// `app/docs/specs/2026-08-13-ontology-distill-design.md` ("topic maps").
/// Excludes the synthetic "field" cluster (`FIELD_CLUSTER_ID`): it is a
/// catch-all for pages that never earned a real topic of their own, so it is
/// never a real topic worth mapping, however large it grows. The LLM draft
/// itself runs TS-side (`maps.ts::draftMap`) — this only detects and
/// proposes.
///
/// Intensity bridge: at `Intensity::Aggressive` the proposal is written
/// straight to `status: approved` (rather than the usual `pending`) so the
/// TS-side post-run auto-apply (`runDistillGuarded`) drafts it without a
/// human click — the same "Aggressive skips the human gate" shape every
/// other pass in `run` already has, just landing in TS instead of here
/// because the draft itself is an LLM call.
fn propose_map_candidates(
    root: &Path,
    o: &Ontology,
    cfg: &DistillConfig,
    manifest: &mut RunManifest,
) -> Result<usize, String> {
    let now = now_secs();
    let existing = existing_map_clusters(root);
    let aggressive = matches!(cfg.intensity, Intensity::Aggressive);
    let mut written = 0usize;

    for c in &o.clusters {
        // Matched by ANY current member's stem, not just `c.label` — labels
        // are medoid stems recomputed on every ontology rebuild, so a
        // cluster's label can drift to a different member between the map
        // being drafted and a later run (fix round 1). The original medoid
        // is, by definition, still one of this cluster's members in the
        // common drift case, so this keeps the map-exists dedup working
        // without pretending to solve drift in general.
        let has_map = c
            .members
            .iter()
            .any(|m| existing.contains(&crate::ontology::stem_of(m)));
        if c.id == FIELD_CLUSTER_ID
            || c.members.len() < MAP_MIN_MEMBERS
            || has_map
            || pending_draft_map_exists(root, &c.label, &c.members)
        {
            continue;
        }
        let kept: Vec<String> = c
            .members
            .iter()
            .filter(|m| member_is_mature(root, m, now))
            .cloned()
            .collect();
        if kept.len() < MAP_MIN_MEMBERS {
            continue;
        }

        let mut body = format!(
            "{} of the cluster's {} members are mature enough to map. Draft a topic map for \
             '{}'?\n\n",
            kept.len(),
            c.members.len(),
            c.label
        );
        for m in &kept {
            body += &format!("- [[{m}]]\n");
        }

        let rel = write_proposal(
            root,
            "draft-map",
            &format!("Map candidate: {}", c.label),
            &body,
            &serde_json::json!({ "cluster": c.label, "members": kept }),
        )?;
        if aggressive {
            let path = root.join(&rel);
            let raw = std::fs::read_to_string(&path).map_err(|e| format!("read {rel}: {e}"))?;
            set_proposal_status(&path, &raw, "approved")?;
        }
        manifest.created.push(rel);
        save_manifest(root, manifest)?;
        written += 1;
    }
    Ok(written)
}

/// Move any proposal whose lifecycle has actually finished (`status: done`
/// or `status: dismissed`) out of the pending feedback inbox into
/// `work/feedback/archive/` — housekeeping, not a new decision. A `status:
/// approved` proposal is left alone: it is awaiting `apply_proposal`, not
/// resolved (see `is_resolved_map`). Tracked in the run manifest like every
/// other move, so `undo` can put a wrongly-archived proposal back.
fn archive_resolved_proposals(root: &Path, manifest: &mut RunManifest) -> Result<usize, String> {
    let feedback_dir = root.join("work/feedback");
    let mut archived = 0usize;
    for (entry, kind) in crate::vault::vault_entries(&feedback_dir) {
        if !kind.is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Some(map) = proposal_frontmatter(&content) else {
            continue;
        };
        if !is_resolved_map(&map) {
            continue;
        }
        let archive_dir = feedback_dir.join("archive");
        std::fs::create_dir_all(&archive_dir)
            .map_err(|e| format!("create work/feedback/archive dir: {e}"))?;
        let from_rel = rel_string(root, &path);
        let to_path = free_path(&archive_dir.join(entry.file_name()));
        std::fs::rename(&path, &to_path).map_err(|e| format!("archive proposal: {e}"))?;
        manifest.moves.push(MoveEntry {
            from: from_rel,
            to: rel_string(root, &to_path),
        });
        save_manifest(root, manifest)?;
        archived += 1;
    }
    Ok(archived)
}

/// Owner decision 2026-10-03 (B1): no run touches raw/, so an `archive-batch`
/// proposal an older run left that still awaits resolution (pending, or an
/// approved one whose apply failed) is marked `done` without moving anything.
/// Runs before `archive_resolved_proposals`, which then sweeps it out of the
/// inbox the same run.
fn retire_archive_batch_proposals(root: &Path) -> Result<usize, String> {
    let mut retired = 0usize;
    for (entry, kind) in crate::vault::vault_entries(&root.join("work/feedback")) {
        let path = entry.path();
        if !kind.is_file() || path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Some(map) = proposal_frontmatter(&content) else {
            continue;
        };
        let is_archive_batch =
            matches!(map.get("action"), Some(gray_matter::Pod::String(s)) if s == "archive-batch");
        if is_archive_batch && is_awaiting_resolution_map(&map) {
            // Cleanup with nothing to apply: a file that cannot be written
            // stays pending and listed (the Feedback card shows it as
            // retired) rather than failing every run.
            if set_proposal_status(&path, &content, "done").is_ok() {
                retired += 1;
            }
        }
    }
    Ok(retired)
}

/// Rewrite a proposal file's `status:` line in place, leaving every other
/// line (including the rest of the frontmatter and the body) untouched. Only
/// touches the line inside the first `---`...`---` block — a `status:` -like
/// line in the body is never mistaken for frontmatter.
fn set_proposal_status(path: &Path, raw: &str, status: &str) -> Result<(), String> {
    let mut out = String::with_capacity(raw.len());
    let mut dashes = 0u32;
    for line in raw.lines() {
        if line.trim() == "---" {
            dashes += 1;
            out.push_str(line);
            out.push('\n');
            continue;
        }
        if dashes == 1 && line.starts_with("status:") {
            out.push_str(&format!("status: {status}\n"));
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    std::fs::write(path, out).map_err(|e| format!("write proposal status: {e}"))
}

/// How many of a proposal's payload files an `apply_*` pass actually moved
/// vs. found already gone. A source missing at its payload path is treated
/// as already-processed, not an error — a proposal action is idempotent per
/// file, so a retry after a mid-loop failure (or a proposal applied twice)
/// makes forward progress on whatever remains instead of re-failing forever
/// on the first file a previous attempt already finished.
struct ApplyOutcome {
    moved: usize,
    skipped: usize,
    deleted: Option<usize>,
}

impl ApplyOutcome {
    fn summary(&self) -> String {
        if let Some(deleted) = self.deleted {
            return format!(
                "permanently deleted {deleted}, skipped {} already-processed",
                self.skipped
            );
        }
        format!(
            "moved {}, skipped {} already-processed",
            self.moved, self.skipped
        )
    }
}

/// Proposals are user-editable markdown: a hand-edited `payload.files` entry
/// is untrusted input even though it is already vault-confined by
/// `safe_join` — without a further check, a rewritten `admit-cluster` or
/// `delete-batch` payload could point `apply_proposal` at, say,
/// `wiki/index.md` and have a live wiki page silently relocated or trashed.
/// `valid` restricts the path to the one directory shape the action is
/// actually supposed to touch; `expected` names that shape in the error.
fn confine_payload_file(
    root: &Path,
    rel: &str,
    valid: fn(&str) -> bool,
    expected: &str,
) -> Result<PathBuf, String> {
    if !valid(rel) {
        return Err(format!(
            "proposal payload path `{rel}` must be directly under `{expected}`"
        ));
    }
    crate::myco_pro::safe_join(root, rel)
}

/// `_inbox/quarantine/<name>`, no further nesting — the one shape a
/// quarantined item's content file ever has (`free_quarantine_paths`).
fn is_quarantine_payload_path(rel: &str) -> bool {
    rel.strip_prefix(&format!(
        "{}/{QUARANTINE_DIR}/",
        crate::commands::DEST_INBOX
    ))
    .is_some_and(|rest| !rest.is_empty() && !rest.contains('/'))
}

/// `raw/<name>`, no further nesting — the one shape `run()`'s own archive
/// pass ever considers (never `raw/archive/...`, never a subdirectory).
fn is_raw_top_level_payload_path(rel: &str) -> bool {
    rel.strip_prefix("raw/")
        .is_some_and(|rest| !rest.is_empty() && !rest.contains('/'))
}

/// `sessions/...`, anywhere under it except already `sessions/archive/...` —
/// the confine `archive_digested_sessions` applies to its caller-supplied
/// `files` (IPC input, untrusted like every other payload-file list here).
/// Unlike `is_quarantine_payload_path`/`is_raw_top_level_payload_path`,
/// further nesting past the prefix is fine: a session lives in its own
/// `YYYY-MM/` bucket, not flat.
fn is_session_payload_path(rel: &str) -> bool {
    let prefix = format!("{}/", crate::commands::DEST_SESSIONS);
    rel.starts_with(&prefix) && !rel.starts_with(&format!("{prefix}{RAW_ARCHIVE_DIR}/"))
}

/// Where a quarantined item may be restored to: the inflow it can have come
/// from — `sessions/` (not its archive) or `_inbox/` (not quarantine itself).
/// Never raw/: nothing under it is ever quarantined (decision 7), so a
/// sidecar naming it was edited.
fn is_restore_target(rel: &str) -> bool {
    let inbox = format!("{}/", crate::commands::DEST_INBOX);
    is_session_payload_path(rel)
        || rel
            .strip_prefix(&inbox)
            .is_some_and(|r| !r.is_empty() && !r.starts_with(&format!("{QUARANTINE_DIR}/")))
}

/// Move one quarantined item back where its sidecar says it came from
/// (spec 2026-10-02 decision 6) and delete the sidecar. A sidecar without a
/// usable origin (from before `from` existed) sends it to `_inbox/`, as
/// restore always did. `Ok(None)`: already gone from quarantine; `Ok(Some)`:
/// the vault-relative path it now has.
fn restore_one(root: &Path, f: &str) -> Result<Option<String>, String> {
    let content_path =
        confine_payload_file(root, f, is_quarantine_payload_path, "_inbox/quarantine/")?;
    if !content_path.exists() {
        return Ok(None);
    }
    let sidecar = sidecar_path(&content_path);
    let origin = sidecar_from(&sidecar)
        .filter(|o| is_restore_target(o))
        .and_then(|o| crate::myco_pro::safe_join(root, &o).ok());
    let file_name = content_path
        .file_name()
        .ok_or_else(|| format!("bad proposal file path: {f}"))?;
    let dest = free_path(
        &origin.unwrap_or_else(|| root.join(crate::commands::DEST_INBOX).join(file_name)),
    );
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("restore {f}: {e}"))?;
    }
    std::fs::rename(&content_path, &dest).map_err(|e| format!("restore {f}: {e}"))?;
    // best-effort; a missing sidecar isn't fatal
    let _ = std::fs::remove_file(sidecar);
    Ok(Some(rel_string(root, &dest)))
}

/// Restore each quarantined item (`restore_one`) and mark where each landed
/// as owner-kept (`record_kept`), so no later scan quarantines it again.
/// The marks are written even when an item partway fails, so the ones
/// already back are not set aside again.
fn apply_admit_cluster(root: &Path, files: &[String]) -> Result<ApplyOutcome, String> {
    // An unavailable owner-mark ledger cannot be repaired by restoring files
    // and then silently writing a fresh list over the lost decisions.
    kept_load(root)?;
    let mut outcome = ApplyOutcome {
        moved: 0,
        skipped: 0,
        deleted: None,
    };
    let mut kept = Vec::new();
    let mut failed = None;
    for f in files {
        match restore_one(root, f) {
            Ok(Some(dest)) => {
                kept.push(dest);
                outcome.moved += 1;
            }
            Ok(None) => outcome.skipped += 1,
            Err(e) => {
                failed = Some(e);
                break;
            }
        }
    }
    record_kept(root, &kept)?;
    match failed {
        Some(e) => Err(e),
        None => Ok(outcome),
    }
}

/// "Restore to the vault" from the quarantine review UI — the SAME re-admit
/// path an approved `admit-cluster` proposal takes (`apply_admit_cluster`),
/// so a one-off manual restore and a cluster admit can never drift apart.
/// Returns its `"moved N, skipped M already-processed"` summary.
pub fn readmit_quarantine(root: &Path, files: &[String]) -> Result<String, String> {
    Ok(apply_admit_cluster(root, files)?.summary())
}

/// Same move `run()`'s conservative TTL pass would have made, except the
/// destination is `.myco/trash/<proposal-slug>/` (the proposal's own file
/// stem) rather than `.myco/trash/<run-id>/` — an applied proposal has no run
/// id of its own to file its trash dir under. Reuses `dir()`/`free_path`, the
/// same helpers that pass uses.
fn apply_delete_batch(
    root: &Path,
    files: &[String],
    proposal_path: &Path,
    permanent: bool,
) -> Result<ApplyOutcome, String> {
    // A malformed later payload must not cause an earlier valid item to be
    // destroyed before the batch is rejected.
    let content_paths: Vec<PathBuf> = files
        .iter()
        .map(|f| {
            let path =
                confine_payload_file(root, f, is_quarantine_payload_path, "_inbox/quarantine/")?;
            crate::vault::confine_delete_path(root, &path.to_string_lossy())
        })
        .collect::<Result<_, String>>()?;
    let mut targets = Vec::new();
    for content in &content_paths {
        if content.exists() {
            if !std::fs::symlink_metadata(content)
                .map_err(|e| format!("inspect quarantine payload: {e}"))?
                .is_file()
            {
                return Err("quarantine deletion payload must be a regular file".into());
            }
            targets.push(content.clone());
            let sidecar = sidecar_path(content);
            let sidecar = crate::vault::confine_delete_path(root, &sidecar.to_string_lossy())?;
            if sidecar.exists() {
                targets.push(sidecar);
            }
        }
    }
    if permanent {
        crate::vault::validate_remove_all(&targets)?;
        let mut outcome = ApplyOutcome {
            moved: 0,
            skipped: 0,
            deleted: Some(0),
        };
        for content in content_paths {
            if !content.exists() {
                outcome.skipped += 1;
                continue;
            }
            crate::vault::remove_all(std::slice::from_ref(&content))?;
            let sidecar = sidecar_path(&content);
            if sidecar.exists() {
                crate::vault::remove_all(std::slice::from_ref(&sidecar))?;
            }
            *outcome
                .deleted
                .as_mut()
                .expect("permanent deletion outcome") += 1;
        }
        return Ok(outcome);
    }
    let slug = proposal_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("proposal");
    let trash_dir = dir(root).join("trash").join(slug);
    std::fs::create_dir_all(&trash_dir).map_err(|e| format!("create trash dir: {e}"))?;
    let mut outcome = ApplyOutcome {
        moved: 0,
        skipped: 0,
        deleted: None,
    };
    for f in files {
        let content_path =
            confine_payload_file(root, f, is_quarantine_payload_path, "_inbox/quarantine/")?;
        if !content_path.exists() {
            outcome.skipped += 1;
            continue;
        }
        let file_name = content_path
            .file_name()
            .ok_or_else(|| format!("bad proposal file path: {f}"))?;
        let sidecar_path = sidecar_path(&content_path);
        let to_content = free_path(&trash_dir.join(file_name));
        std::fs::rename(&content_path, &to_content).map_err(|e| format!("trash move: {e}"))?;
        if sidecar_path.exists() {
            let sidecar_name = sidecar_path
                .file_name()
                .ok_or_else(|| format!("bad sidecar path for {f}"))?;
            let to_sidecar = free_path(&trash_dir.join(sidecar_name));
            std::fs::rename(&sidecar_path, &to_sidecar)
                .map_err(|e| format!("trash sidecar move: {e}"))?;
        }
        outcome.moved += 1;
    }
    Ok(outcome)
}

/// Execute a proposal's action and flip its `status` to `done`. The frontend
/// (Task 9) flips `pending` -> `approved`/`dismissed` itself by rewriting the
/// file directly; this is the one lifecycle step that actually touches the
/// filesystem beyond that flip, so it is the one exposed as a command.
///
/// - `admit-cluster` -> `apply_admit_cluster`
/// - `archive-batch` -> retired: marked `done`, nothing moved (raw/ stays
///   read-only)
/// - `delete-batch` -> `apply_delete_batch`
///
/// Each is idempotent per payload file (see `ApplyOutcome`), so re-running
/// this on a proposal a previous call only partly finished (it errored
/// partway through the loop, before ever reaching the `status: done` flip
/// below) picks up exactly where that call left off, and re-running it on an
/// already-`done` proposal is a harmless no-op that reports every file
/// skipped rather than erroring on the first missing source. Returns
/// `"moved N, skipped M already-processed"`.
pub fn apply_proposal(root: &Path, rel_path: &str) -> Result<String, String> {
    apply_proposal_confirmed(root, rel_path, None)
}

pub(crate) fn apply_proposal_confirmed(
    root: &Path,
    rel_path: &str,
    expected_permanent: Option<bool>,
) -> Result<String, String> {
    let permanent = crate::settings::confirmed_deletion_policy(expected_permanent)?;
    apply_proposal_with_policy(root, rel_path, permanent)
}

fn apply_proposal_with_policy(
    root: &Path,
    rel_path: &str,
    permanent: bool,
) -> Result<String, String> {
    let path = crate::myco_pro::safe_join(root, rel_path)?;
    let raw =
        std::fs::read_to_string(&path).map_err(|e| format!("read proposal {rel_path}: {e}"))?;
    let map = proposal_frontmatter(&raw)
        .ok_or_else(|| format!("{rel_path} is not a distill-proposal"))?;
    let action = match map.get("action") {
        Some(gray_matter::Pod::String(s)) => s.clone(),
        _ => return Err(format!("proposal {rel_path} missing `action`")),
    };
    let files = proposal_payload_files(&map);

    let outcome = match action.as_str() {
        "admit-cluster" => apply_admit_cluster(root, &files)?,
        // Owner decision 2026-10-03 (B1): raw/ is never moved; a proposal an
        // older run wrote is retired (marked done below) rather than applied.
        "archive-batch" => ApplyOutcome {
            moved: 0,
            skipped: 0,
            deleted: None,
        },
        "delete-batch" => apply_delete_batch(root, &files, &path, permanent)?,
        other => return Err(format!("proposal {rel_path} has unknown action `{other}`")),
    };

    set_proposal_status(&path, &raw, "done")?;
    Ok(outcome.summary())
}

/// Settled `type: map`, `status: active` references with current published
/// chunks. Active metadata is not an independent human-approval attestation.
fn map_anchors_from_store(
    root: &Path,
    store: &crate::vector_index::VectorStore,
) -> Result<Vec<(String, Vec<f32>)>, String> {
    let mut anchors = Vec::new();
    for (page, vector) in store.page_centroids()? {
        if !page.starts_with("wiki/maps/") {
            continue;
        }
        let source = admission::read_source(root, &page)?
            .ok_or("organization map source is missing; reindex required")?;
        let content =
            String::from_utf8(source.bytes).map_err(|_| "organization map source is not UTF-8")?;
        let Some(cluster) = knowledge::settled_map(&content)? else {
            continue;
        };
        if !knowledge::has_current_chunks(store, &page, &content) {
            return Err("organization map chunks are stale; reindex required".into());
        }
        anchors.push((cluster, vector));
    }
    Ok(anchors)
}

/// Idle-run orchestrator: the periodic batch the design spec calls "the
/// distill run". In order:
///
/// 1. `partition_sessions` — fold any loose `sessions/*.md` into their month
///    bucket before anything scores them (best-effort; a failure here does
///    not stop the run).
/// 2. Ontology: reuse only the exact declared representation and complete
///    index/title/map-anchor input digest; rebuild a stale derived cache.
///    The lifecycle-only route skips ontology, profile and semantic passes.
/// 3. The undo manifest (`.myco/distill-runs/<id>.json`) is created and
///    persisted — empty, but on disk — BEFORE anything else moves a file, so
///    even a crash on the very first move leaves a valid (empty) manifest
///    rather than no manifest at all. Successful scan moves and proposal
///    writes save incrementally. TTL commits save their actual pair outcome
///    after releasing the writer; a crash or manifest-save failure in that
///    interval can leave preserved trash bytes without durable move history.
///    These ordinary manifests do not provide pre-mutation restart intent.
/// 4. `scan` new inflow against that ontology (Task 4) plus the identity
///    layer — `profile.md`'s `## Interests` bullets, batch-embedded ONCE
///    here (Phase B, Task 5) and passed through to every `admit()` call —
///    quarantine moves are recorded into this same manifest as they happen.
/// 5. (The `raw/` archive pass is gone: no run touches `raw/`, owner
///    decision 2026-10-03, B1.)
/// 6. TTL pass: quarantine sidecars past their `expires` move (file +
///    sidecar) to `.myco/trash/<run-id>/` at Standard/Aggressive, or propose
///    at Conservative — and always propose for a session, or an item of no
///    recorded origin. Trash dirs whose entire retention window has elapsed
///    are purged regardless of this run's intensity, except one that may hold
///    a session.
/// 7. Emerging-cluster + proposal pass (Task 7): quarantined items whose
///    pairwise similarity clusters into a group are proposed as a new topic
///    (`propose_emerging_clusters`), and any proposal already resolved
///    (approved/dismissed/done) is archived out of the pending feedback inbox
///    (`archive_resolved_proposals`).
/// 8. Map-candidate + proposal pass (Task 4, Phase B): a topic cluster that
///    has grown to enough mature members, with no `wiki/maps/` page yet,
///    gets a `draft-map` proposal (`propose_map_candidates`) — the LLM draft
///    itself runs TS-side.
/// 9. Write the human report (`ingest-reports/distill-<id>.md`).
/// 10. Append this run's backlog to the rolling trend, and commit if the
///     vault is a git repo.
///
/// No run changes anything under `raw/` (owner decision 2026-10-03, B1): it
/// is not inflow, so never scored or quarantined, and a summary-tier
/// `_inbox/` item, whose only destination was `raw/archive/`, stays put.
pub fn run_checked(
    root: &Path,
    cfg: &DistillConfig,
    expected: &EmbeddingSpace,
    embed: &dyn Fn(Vec<String>) -> Result<EmbeddedBatch, String>,
) -> Result<RunReport, String> {
    expected.validate()?;
    let checked = |texts: Vec<String>| {
        let count = texts.len();
        let batch = embed(texts)?;
        if &batch.space != expected {
            return Err("distill embedding batch representation changed".into());
        }
        batch.space.validate_batch(&batch.vectors, count)?;
        Ok(batch.vectors)
    };
    run_inner(root, cfg, Some(&checked), RunMode::Checked(expected))
}

/// Preserve rule-only lifecycle work when no semantic index has been prepared.
/// This route has no producer and refuses a nonempty or dimensioned index.
pub fn run_without_embeddings(root: &Path, cfg: &DistillConfig) -> Result<RunReport, String> {
    run_inner(root, cfg, None, RunMode::LifecycleOnly)
}

#[derive(Clone, Copy)]
enum RunMode<'a> {
    Synthetic,
    Checked(&'a EmbeddingSpace),
    LifecycleOnly,
}

/// Unlabelled synthetic harness entry point. Application execution must use
/// `run_checked` so every producer batch is bound to the pinned representation.
#[doc(hidden)]
pub fn run(
    root: &Path,
    cfg: &DistillConfig,
    embed: &EmbedVectors<'_>,
) -> Result<RunReport, String> {
    run_inner(root, cfg, Some(embed), RunMode::Synthetic)
}

fn run_inner(
    root: &Path,
    cfg: &DistillConfig,
    embed: Option<&EmbedVectors<'_>>,
    mode: RunMode<'_>,
) -> Result<RunReport, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("canonicalize vault: {e}"))?;
    let root = canonical_root.as_path();
    crate::vault::confine_delete_path(root, &dir(root).to_string_lossy())?;
    crate::vault::confine_delete_path(root, &dir(root).join("trash").to_string_lossy())?;
    crate::vault::confine_delete_path(root, &root.join("_inbox/quarantine").to_string_lossy())?;
    let now = now_secs();
    let id = free_run_id(root, now);

    // Validate the pinned store and state before session partitioning, cache
    // publication or creation of a mutation manifest.
    let store = current_store(root)?;
    let space = optional_store_space(&store)?;
    if let RunMode::Checked(expected) = &mode {
        if space.as_ref() != Some(*expected) {
            return Err("distill pinned representation does not match the current index".into());
        }
    }
    let lifecycle_only = matches!(mode, RunMode::LifecycleOnly);
    if lifecycle_only && (!store.records.is_empty() || store.dim != 0) {
        return Err("distill lifecycle-only mode requires a genuinely empty index".into());
    }
    state_for_space(root, space.as_ref(), &store.model)?;
    kept_load(root)?;

    // Validate current source coverage before any run mutation. The unlabelled
    // synthetic runner remains a geometry harness, not application authority.
    let current_wiki = if !lifecycle_only && space.is_some() {
        let snapshot = knowledge::read(root)?;
        let covered = snapshot.covered_store(&store)?;
        let titles = snapshot.titles()?;
        Some((snapshot, covered, titles))
    } else {
        None
    };

    if let Err(e) = crate::commands::partition_sessions(root) {
        crate::perf::log("distill_partition_sessions_failed", &[]);
        let _ = e;
    }

    let fallback_titles;
    let (semantic_store, titles) = if let Some((_, covered, titles)) = &current_wiki {
        (covered, titles)
    } else {
        fallback_titles = crate::commands::wiki_titles(root);
        (&store, &fallback_titles)
    };
    let (ontology, ontology_rebuilt) = if lifecycle_only {
        (None, false)
    } else {
        let map_anchors = map_anchors_from_store(root, semantic_store)?;
        let cached = if space.is_some() {
            crate::ontology::load_for_store(root, semantic_store, titles, &map_anchors)?
        } else {
            None
        };
        match cached {
            Some(ontology) => (Some(ontology), false),
            None => {
                let mut ontology = crate::ontology::build(semantic_store, titles, &map_anchors)?;
                crate::ontology::stamp_last_touched(root, &mut ontology);
                if let Some((snapshot, _, _)) = &current_wiki {
                    if knowledge::read(root)?.signature != snapshot.signature {
                        return Err("organization wiki changed before cache publication".into());
                    }
                }
                crate::ontology::save(root, &ontology)?;
                (Some(ontology), true)
            }
        }
    };
    let inputs = ontology
        .as_ref()
        .filter(|ontology| ontology.embedding.is_some())
        .map(|ontology| match &current_wiki {
            Some((snapshot, _, _)) => {
                if knowledge::read(root)?.signature != snapshot.signature {
                    return Err("organization wiki changed before scan".into());
                }
                admission::capture_snapshot(root, ontology, cfg, &snapshot.signature)
            }
            None => admission::capture(root, ontology, cfg),
        })
        .transpose()?;

    let mut manifest = RunManifest {
        id: id.clone(),
        started_at: now,
        ..Default::default()
    };
    // Persist immediately — before `scan` runs, not after — so a quarantine
    // move `scan` makes is never undo-blind: the manifest `scan` threads
    // through and saves into already exists on disk when that move happens.
    save_manifest(root, &manifest)?;

    // Identity layer (Phase B, Task 5): profile.md's `## Interests` bullets,
    // batch-embedded ONCE per run (not per item, unlike the per-candidate
    // embedding below) and handed to every `admit()` call `scan` makes.
    // Missing/interest-less profile.md costs nothing — no embed call at all.
    // The checked application runner requires a successful pinned producer
    // result for every requested batch, including profile interests. The
    // unlabelled synthetic harness retains its legacy no-lift failure control.
    let profile_interests = inputs
        .as_ref()
        .map(|inputs| inputs.interests.clone())
        .unwrap_or_default();
    let profile_vecs: Vec<Vec<f32>> = if profile_interests.is_empty() {
        Vec::new()
    } else {
        let expected_count = profile_interests.len();
        let expected_dim = space.as_ref().map(|space| space.dim);
        let result = embed.ok_or("distill semantic producer is missing")?(profile_interests)
            .and_then(|vectors| {
                crate::embeddings::validate_embedding_batch(
                    &vectors,
                    expected_count,
                    expected_dim,
                )?;
                Ok(vectors)
            });
        match result {
            Ok(vectors) => vectors,
            Err(error) if matches!(mode, RunMode::Checked(_)) => return Err(error),
            Err(error) => {
                crate::perf::log("distill_profile_embed_failed", &[]);
                eprintln!("distill profile embed failed (continuing without lift): {error}");
                Vec::new()
            }
        }
    };

    let scan_outcome = if let Some(ontology) = &ontology {
        if let Some(inputs) = &inputs {
            scan_with_inputs(
                root,
                ontology,
                cfg,
                cfg.run_budget_items,
                embed.ok_or("distill semantic producer is missing")?,
                &profile_vecs,
                &mut manifest,
                inputs,
                matches!(mode, RunMode::Checked(_)),
            )?
        } else if ontology.wiki_pages < GATE_MIN_WIKI_PAGES {
            ScanOutcome {
                gate_wiki_pages: Some(ontology.wiki_pages),
                ..Default::default()
            }
        } else {
            return Err("distill semantic admission requires a stamped representation".into());
        }
    } else {
        ScanOutcome {
            gate_wiki_pages: (titles.len() < GATE_MIN_WIKI_PAGES).then_some(titles.len()),
            ..Default::default()
        }
    };

    let conservative = matches!(cfg.intensity, Intensity::Conservative);
    let mut proposals = 0usize;

    // ⑤ TTL pass: quarantine sidecars past their expiry. A future
    // never-clustered check could additionally gate this — no sidecar
    // carries cluster membership yet, so every expired one qualifies today.
    let mut trashed = 0usize;
    let permanent = crate::settings::confirmed_deletion_policy(None)?;
    let mut deleted = 0usize;
    let quarantine_dir = root.join(crate::commands::DEST_INBOX).join(QUARANTINE_DIR);
    for (entry, kind) in crate::vault::vault_entries(&quarantine_dir) {
        if !kind.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(stem) = name.strip_suffix(".verdict.json") else {
            continue;
        };
        let sidecar_path = entry.path();
        let Ok(raw) = std::fs::read_to_string(&sidecar_path) else {
            continue;
        };
        let Ok(sidecar) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let Some(expires) = sidecar.get("expires").and_then(|v| v.as_i64()) else {
            continue;
        };
        if now < expires {
            continue;
        }

        let content_path = quarantine_dir.join(format!("{stem}.md"));
        crate::vault::confine_delete_path(root, &content_path.to_string_lossy())?;
        crate::vault::confine_delete_path(root, &sidecar_path.to_string_lossy())?;
        if !content_path.exists() {
            return Err(format!(
                "orphaned quarantine verdict retained for review: {}",
                sidecar_path.display()
            ));
        }
        let content_rel = format!("{}/{QUARANTINE_DIR}/{stem}.md", crate::commands::DEST_INBOX);
        let ask = expiry_asks(conservative, sidecar.get("from").and_then(|v| v.as_str()));

        if ask {
            if pending_file_proposal_exists(root, "delete-batch", &content_rel) {
                continue;
            }
            let rel = write_proposal(
                root,
                "delete-batch",
                &format!("Delete expired quarantine item {stem}.md?"),
                &if permanent {
                    format!("Quarantine TTL expired at unix {expires}. Approving permanently deletes `{content_rel}` and its sidecar. This cannot be undone.")
                } else {
                    format!("Quarantine TTL expired at unix {expires}. Approving moves `{content_rel}` and its sidecar to `.myco/trash/`.")
                },
                &serde_json::json!({ "files": [content_rel.clone()] }),
            )?;
            manifest.created.push(rel);
            save_manifest(root, &manifest)?;
            proposals += 1;
        } else if permanent {
            ttl::delete_expired(
                root,
                &content_path,
                &sidecar_path,
                &raw,
                now,
                conservative,
                &mut manifest,
            )?;
            deleted += 1;
        } else {
            ttl::trash_expired(
                root,
                &content_path,
                &sidecar_path,
                &raw,
                now,
                conservative,
                &mut manifest,
            )?;
            trashed += 1;
        }
    }

    // Purge trash dirs past their retention window, regardless of this run's
    // intensity — housekeeping on already-committed deletions, not a new one.
    // Never a dir that may hold a session (decision 5).
    deleted += purge_trash(root, now, permanent, &mut manifest)?;

    // ⑥ Emerging-cluster + proposal pass (Task 7, design spec: "≥5
    // quarantined items with pairwise similarity above threshold -> 'new
    // topic forming' proposal"). `save_manifest` after its own pushes, same
    // as every pass above.
    if !lifecycle_only {
        proposals += propose_emerging_clusters_for_inputs(
            root,
            space.as_ref(),
            inputs.as_ref(),
            cfg,
            matches!(mode, RunMode::Checked(_)),
            &mut manifest,
        )?;
    }

    // ⑥.5 Map-candidate + proposal pass (Task 4, Phase B): a topic cluster
    // that has grown big and mature enough gets a `draft-map` proposal
    // instead — see `propose_map_candidates`'s own doc comment for the
    // Aggressive-intensity bridge to TS.
    if let Some(ontology) = &ontology {
        if matches!(mode, RunMode::Checked(_)) {
            if let Some(inputs) = &inputs {
                verify_current_inputs(root, cfg, inputs)?;
            }
        }
        proposals += propose_map_candidates(root, ontology, cfg, &mut manifest)?;
    }

    // Retire the raw/ archive proposals older runs left (B1), then archive
    // any proposal the lifecycle already resolved (dismissed/done).
    retire_archive_batch_proposals(root)?;
    archive_resolved_proposals(root, &mut manifest)?;

    // ⑦ Manifest — already persisted incrementally after every successful
    // move/trash/proposal above (`save_manifest`); nothing left to write.

    // ⑨ (backlog half) Append this run's backlog to the rolling trend, so the
    // report below and the returned `RunReport` show the same number.
    let mut state = state_for_inputs(root, space.as_ref(), &store.model, inputs.as_ref())?;
    let backlog_after = backlog_count_checked(root, &state)?;
    state.last_run = Some(now);
    state.last_backlogs.push(backlog_after);
    let overflow = state.last_backlogs.len().saturating_sub(10);
    state.last_backlogs.drain(0..overflow);
    state_save(root, &state)?;

    // ⑧ Human report.
    let report_rel = format!("ingest-reports/distill-{id}.md");
    let report_path = root.join(&report_rel);
    std::fs::create_dir_all(report_path.parent().ok_or("report path has no parent")?)
        .map_err(|e| format!("create ingest-reports dir: {e}"))?;
    let report = render_report(
        &id,
        cfg,
        ontology_rebuilt,
        &scan_outcome,
        trashed,
        proposals,
        &manifest,
        backlog_after,
    );
    std::fs::write(&report_path, report).map_err(|e| format!("write report: {e}"))?;

    // ⑨ (commit half) Commit if the vault is a git repo.
    git_commit_run(root, &id);

    Ok(RunReport {
        id,
        scan: scan_outcome,
        trashed,
        deleted,
        proposals,
        backlog_after,
    })
}

/// Replay one run's manifest in reverse: restore every archived/trashed file
/// to its pre-run location, and delete every proposal file that run created.
/// Entries with unknown byte revisions, changed bytes, or occupied restore
/// destinations are preserved for manual recovery. Returns the number of
/// revision-verified entries actually reversed.
///
/// Ledger entries for a restored path's pre-run location are not explicitly
/// cleaned up here — they were already pruned by `compact_ledger` the moment
/// this run's own `scan` ran (a ledger key for a path that no longer exists
/// is dropped every scan; see that fn's doc comment), so nothing new is left
/// dangling for undo to clean up. The one case undo DOES create — a file
/// reappearing at a path with no ledger entry — self-heals on the next
/// `scan`, which just treats it as fresh, unscored inflow.
pub fn undo(root: &Path, run_id: &str) -> Result<usize, String> {
    archive::undo_checked(root, run_id)
}

/// The most recently started run's id, read by comparing each
/// `.myco/distill-runs/*.json` manifest's own `started_at`, id as tie-break.
/// Two runs kicked off within the same wall-clock second share a
/// second-granularity `started_at` — `free_run_id`'s own `-2`, `-3`… suffix
/// is exactly what orders those, and string-comparing `id` reproduces it
/// (`"...T060028"` sorts before `"...T060028-2"`, its own prefix). Filename
/// order isn't used at all: `std::fs::read_dir` makes no ordering guarantee.
fn newest_run_id(root: &Path) -> Option<String> {
    let runs_dir = dir(root).join("distill-runs");
    let mut latest: Option<(i64, String)> = None;
    for (entry, kind) in crate::vault::vault_entries(&runs_dir) {
        if !kind.is_file() || entry.path().extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        let Ok(m) = serde_json::from_str::<RunManifest>(&raw) else {
            continue;
        };
        let is_newer = match &latest {
            Some((t, id)) => (m.started_at, m.id.as_str()) > (*t, id.as_str()),
            None => true,
        };
        if is_newer {
            latest = Some((m.started_at, m.id));
        }
    }
    latest.map(|(_, id)| id)
}

/// One persisted run manifest reduced to the counts the run-list UI shows.
#[derive(Clone, Debug, serde::Serialize)]
pub struct RunSummary {
    pub id: String,
    pub started_at: i64,
    pub moves: usize,
    pub trashed: usize,
    pub deleted: usize,
    pub created: usize,
}

/// Newest-first summaries of persisted run manifests (Q4 item 3). Same
/// `(started_at, id)` ordering as `newest_run_id` — see its doc comment for
/// why id string order is the correct same-second tie-break.
pub fn list_runs(root: &Path, limit: usize) -> Vec<RunSummary> {
    let runs_dir = dir(root).join("distill-runs");
    let mut out: Vec<RunSummary> = crate::vault::vault_entries(&runs_dir)
        .into_iter()
        .filter(|(entry, kind)| {
            kind.is_file() && entry.path().extension().and_then(|e| e.to_str()) == Some("json")
        })
        .filter_map(|(entry, _)| {
            let raw = std::fs::read_to_string(entry.path()).ok()?;
            let m: RunManifest = serde_json::from_str(&raw).ok()?;
            Some(RunSummary {
                id: m.id,
                started_at: m.started_at,
                moves: m.moves.len(),
                trashed: m.trashed.len(),
                deleted: m
                    .deleted
                    .iter()
                    .filter(|p| Path::new(p).extension().and_then(|s| s.to_str()) == Some("md"))
                    .count(),
                created: m.created.len(),
            })
        })
        .collect();
    out.sort_by(|a, b| (b.started_at, &b.id).cmp(&(a.started_at, &a.id)));
    out.truncate(limit);
    out
}

/// One persisted run manifest in full — the run-log drill-in view (W3–6
/// item 6). Public DTO for the module-private `RunManifest`, plus the two
/// things the manifest itself doesn't record: whether the WHY report is on
/// disk, and which git commit (if any) this run produced.
#[derive(Clone, Debug, serde::Serialize)]
pub struct RunDetail {
    pub id: String,
    pub started_at: i64,
    pub moves: Vec<(String, String)>, // (from, to)
    pub trashed: Vec<(String, String)>,
    pub deleted: Vec<String>,
    pub created: Vec<String>,
    /// `ingest-reports/distill-<id>.md` — `Some` only when it exists.
    pub report_rel: Option<String>,
    /// Full SHA of the `distill: run <id>` commit, when history was on.
    pub commit: Option<String>,
}

/// Read one run's manifest into a [`RunDetail`]. `id` is untrusted IPC input
/// joined into a `.myco/distill-runs/` path — same `valid_manifest_id` guard
/// as `append_distill_manifest`.
pub fn run_detail(root: &Path, id: &str) -> Result<RunDetail, String> {
    if !valid_lookup_id(id) {
        return Err(format!("bad manifest id `{id}`"));
    }
    let path = manifest_path(root, id);
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("read manifest {}: {e}", path.display()))?;
    let m: RunManifest = serde_json::from_str(&raw).map_err(|e| format!("parse manifest: {e}"))?;
    let report_rel = format!("ingest-reports/distill-{id}.md");
    Ok(RunDetail {
        id: m.id,
        started_at: m.started_at,
        moves: m.moves.into_iter().map(|e| (e.from, e.to)).collect(),
        trashed: m.trashed.into_iter().map(|e| (e.from, e.to)).collect(),
        deleted: m.deleted,
        created: m.created,
        report_rel: root.join(&report_rel).exists().then_some(report_rel),
        commit: crate::vault_history::commit_for_message(root, &format!("distill: run {id}")),
    })
}

/// Cheap vault-wide status for the settings tab / MCP `distill_status`: no
/// scoring, just a fs walk against the ledger already on disk.
pub fn status(root: &Path) -> DistillStatus {
    let state = metadata_state(root);
    let wiki_pages = knowledge::read(root)
        .and_then(|snapshot| snapshot.titles().map(|titles| titles.len()))
        .unwrap_or_else(|error| {
            eprintln!("myco: distill wiki count unavailable: {error}");
            0
        });
    DistillStatus {
        backlog: backlog_count(root, &state),
        pending_proposals: awaiting_resolution_count(root),
        last_run: state.last_run,
        last_backlogs: state.last_backlogs.clone(),
        gate_active: wiki_pages >= GATE_MIN_WIKI_PAGES,
        last_run_id: newest_run_id(root),
        wiki_pages,
        quarantined: quarantine_item_count(root),
    }
}

/// A quarantine item whose TTL runs out within `report`'s seven-day window.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct ExpiringQuarantine {
    /// Vault-relative content path, e.g. `_inbox/quarantine/note.md`.
    pub path: String,
    /// Unix seconds the TTL sweep becomes eligible to trash it.
    pub expires: i64,
}

/// A proposal still awaiting the user's decision (`status` missing or
/// `pending`) — approved-but-unapplied ones are `status`'s count, not a
/// decision this list should ask for again.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct ProposalSummary {
    /// Vault-relative, e.g. `work/feedback/2026-08-12-archive.md`.
    pub path: String,
    pub action: String,
    /// The `# heading` `write_proposal` puts right after the frontmatter.
    pub title: String,
}

/// The no-LLM detection view behind the MCP `distill_report` tool: what the
/// gate has not scored yet per inflow tree, which quarantine items expire
/// soon, and which proposals still want a decision. Reads the same `.myco/`
/// state as `status`; writes nothing.
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct DistillReport {
    /// `_inbox` / `raw` / `sessions` → unscored candidate count.
    pub unscored_by_folder: std::collections::BTreeMap<String, usize>,
    /// Soonest expiry first.
    pub quarantine_expiring_soon: Vec<ExpiringQuarantine>,
    /// Filename order.
    pub proposals: Vec<ProposalSummary>,
}

const QUARANTINE_EXPIRING_WINDOW_SECS: i64 = 7 * 86_400;

pub fn report(root: &Path) -> DistillReport {
    let state = metadata_state(root);
    let trees: [(&str, &[&str]); 2] = [
        (crate::commands::DEST_INBOX, &[QUARANTINE_DIR]),
        (crate::commands::DEST_SESSIONS, &[RAW_ARCHIVE_DIR]),
    ];
    let mut unscored_by_folder = std::collections::BTreeMap::new();
    for (start, exclude) in trees {
        let mut found = Vec::new();
        walk_inflow(root, start, exclude, &mut found);
        let unscored = found
            .iter()
            .filter(|c| !metadata_is_scored(root, &state, &c.rel))
            .count();
        unscored_by_folder.insert(start.to_string(), unscored);
    }
    let now = now_secs();
    let mut quarantine_expiring_soon: Vec<ExpiringQuarantine> = quarantine_entries(root)
        .into_iter()
        .map(|(e, _)| e)
        .filter(|e| e.expires > 0 && e.expires - now <= QUARANTINE_EXPIRING_WINDOW_SECS)
        .map(|e| ExpiringQuarantine {
            path: e.path,
            expires: e.expires,
        })
        .collect();
    quarantine_expiring_soon
        .sort_by(|a, b| a.expires.cmp(&b.expires).then_with(|| a.path.cmp(&b.path)));
    let mut proposals = Vec::new();
    for (entry, kind) in crate::vault::vault_entries(&root.join("work/feedback")) {
        if !kind.is_file() || entry.path().extension().and_then(|x| x.to_str()) != Some("md") {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        let Some(map) = proposal_frontmatter(&content) else {
            continue;
        };
        if !is_pending_map(&map) {
            continue;
        }
        let action = match map.get("action") {
            Some(gray_matter::Pod::String(s)) => s.clone(),
            _ => String::new(),
        };
        let body = gray_matter::Matter::<gray_matter::engine::YAML>::new()
            .parse::<gray_matter::Pod>(&content)
            .map(|p| p.content)
            .unwrap_or_default();
        let title = body
            .lines()
            .map(str::trim)
            .find_map(|l| l.strip_prefix("# "))
            .unwrap_or("")
            .trim()
            .to_string();
        proposals.push(ProposalSummary {
            path: format!("work/feedback/{}", entry.file_name().to_string_lossy()),
            action,
            title,
        });
    }
    proposals.sort_by(|a, b| a.path.cmp(&b.path));
    DistillReport {
        unscored_by_folder,
        quarantine_expiring_soon,
        proposals,
    }
}

/// Every `source-*.md` summary under `wiki/`, at any depth, by lowercased
/// stem → vault-relative path: the "already represented" signal both the
/// raw/ archive pass and `full_tier_items` check. A summary represents its
/// source wherever it sits (Tidy's `wiki/sessions/YYYY-MM/`, a hand move),
/// the same way a link resolves it by stem, case-insensitively.
fn source_pages(root: &Path) -> HashMap<String, String> {
    fn walk(dir: &Path, root: &Path, out: &mut HashMap<String, String>) {
        for (e, kind) in crate::vault::vault_entries(dir) {
            let p = e.path();
            if kind.is_dir() {
                walk(&p, root, out);
                continue;
            }
            let Some(stem) = p.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if stem.starts_with("source-") && p.extension().and_then(|x| x.to_str()) == Some("md") {
                out.entry(stem.to_lowercase())
                    .or_insert_with(|| rel_string(root, &p));
            }
        }
    }
    let mut out = HashMap::new();
    walk(&root.join("wiki"), root, &mut out);
    out
}

/// Gate-admitted Full-tier ledger entries ready for the LLM ingest pipeline
/// (Phase B, Task 3) — every `scored` entry whose tier is `"full"`, still
/// sitting in `_inbox/` or `raw/`'s own top level, has no `source-<stem>.md`
/// under `wiki/` yet, and is still present on disk — oldest file mtime first,
/// the same order `collect_candidates` fills the ledger in, so ingest drains
/// the queue in the order `scan` built it.
///
/// The `source-<stem>.md` check (`source_pages`, the same "already
/// represented" signal the raw/ archive pass itself checks) is
/// the fix for a Conservative-intensity re-ingest loop: at Standard/
/// Aggressive, the archive pass moves an ingested item's file away the very
/// next run, so the missing-file check below would eventually drop it on its
/// own; at Conservative it only ever writes a proposal and never moves the
/// file, so without this check a full-tier item stays in the ledger forever
/// and gets re-listed — and re-ingested, re-spending the LLM budget on it —
/// every run until a human approves the proposal. Checking the source page
/// directly closes the loop at every intensity, not just the ones that
/// happen to move the file.
///
/// `raw/archive/` needs no explicit exclusion: `collect_candidates` never
/// walks it as inflow, so no ledger key can ever point there. `sessions/` is
/// excluded outright: Phase B routes it through the session digest instead
/// of ingest, even on the rare transcript `admit` happens to score Full.
pub fn full_tier_items(root: &Path) -> Result<Vec<String>, String> {
    let sources = source_pages(root);
    let store = current_store(root)?;
    let space = optional_store_space(&store)?;
    let cfg = config_load_checked(root)?;
    let inputs = admission::current(root, &store, &cfg)?;
    let state = state_for_inputs(root, space.as_ref(), &store.model, inputs.as_ref())?;
    let inbox_prefix = format!("{}/", crate::commands::DEST_INBOX);
    let mut items: Vec<(String, i64)> = Vec::new();
    for (rel, entry) in &state.scored {
        if entry.tier != "full"
            || !(rel.starts_with(&inbox_prefix) || is_raw_top_level_payload_path(rel))
        {
            continue;
        }
        let stem = Path::new(rel.as_str())
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(rel.as_str());
        if sources.contains_key(&format!("source-{stem}").to_lowercase())
            || !is_scored_current(root, &state, rel)?
        {
            continue;
        }
        let Ok(meta) = std::fs::metadata(root.join(rel)) else {
            continue;
        };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        let mtime = modified
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        items.push((rel.clone(), mtime));
    }
    // MCP conversation imports explicitly ask for wiki promotion. They are
    // immutable sources, not raw inflow to score, quarantine, or archive.
    // Include only the latest queued revision so the app's actual drain sees
    // the same work as MCP, without enabling generic raw/ distillation.
    {
        let pending = crate::importers::wikify::Pending::try_load(root)?;
        let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        for item in pending.pending {
            if !item.raw_path.starts_with("raw/conversations/") {
                continue;
            }
            let Ok(path) = crate::vault::confine_path(
                &canonical_root,
                &canonical_root.join(&item.raw_path).to_string_lossy(),
            ) else {
                continue;
            };
            let Ok(meta) = std::fs::metadata(path) else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            if !items.iter().any(|(rel, _)| rel == &item.raw_path) {
                items.push((item.raw_path, mtime));
            }
        }
    }
    items.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
    Ok(items.into_iter().map(|(rel, _)| rel).collect())
}

// ---------------------------------------------------------------------------
// Session-digest bookkeeping (Phase B, Task 1): group already-scored
// `sessions/` files by day for the LLM digest step to summarize, then move a
// digested day out of the active tree once that step is done. `run`'s own
// summary-tier step above deliberately skips `sessions/` — this is that
// tree's per-day path instead.
// ---------------------------------------------------------------------------

/// One day's worth of `sessions/` files ready for Phase B's LLM digest step.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct DigestDay {
    pub day: String,
    pub files: Vec<String>,
    /// Every file in `files` is already named by a `daily/*.md` digest marker
    /// (Defect C) — its digest text is durable, only the archive move failed.
    /// The TS caller must skip straight to (re)trying
    /// `archive_digested_sessions`, never the LLM call or a second append.
    pub already_digested: bool,
}

/// `YYYY-MM-DD` for a swept session, from the doc's own `created:` frontmatter
/// (unix seconds, written by `importers::mod::Conversation::to_inbox_doc` at
/// import time) — the conversation's actual time, not whenever the sweep last
/// wrote the file, which is wrong for a long-running or re-imported one.
///
/// Only a doc without that frontmatter falls back to a `YYYYMMDD` run of digits
/// in the stem (`commands::session_bucket`'s idea at day granularity), and then
/// to mtime. The stem guess ranks BELOW the frontmatter because importer stems
/// are `<source>-<uuid>` and a UUID's first group is sometimes eight digits that
/// read as a plausible date: `claude-code-20970910-3580-…` filed its digest
/// under `daily/2097-09-10.md`. A stem date later than the file's own mtime
/// cannot be a conversation date either, so it is rejected outright.
fn session_day(stem: &str, path: &Path, mtime: i64) -> String {
    if let Some(secs) = frontmatter_created(path) {
        let (y, m, d, ..) = civil_datetime(secs);
        return format!("{y:04}-{m:02}-{d:02}");
    }
    let (mtime_year, ..) = civil_datetime(mtime);
    if let Some(pos) = stem.find(|c: char| c.is_ascii_digit()) {
        let tail = &stem[pos..];
        let b = tail.as_bytes();
        if b.len() >= 8 && b[0..8].iter().all(u8::is_ascii_digit) {
            let y: u16 = tail[0..4].parse().unwrap_or(0);
            let m: u8 = tail[4..6].parse().unwrap_or(0);
            let d: u8 = tail[6..8].parse().unwrap_or(0);
            if (1970..=mtime_year).contains(&i64::from(y))
                && (1..=12).contains(&m)
                && (1..=31).contains(&d)
            {
                return format!("{y:04}-{m:02}-{d:02}");
            }
        }
    }
    let (y, m, d, ..) = civil_datetime(mtime);
    format!("{y:04}-{m:02}-{d:02}")
}

/// The `created:` unix-seconds frontmatter a session doc carries from import
/// (`importers::mod::Conversation::to_inbox_doc`), or `None` when the file is
/// missing, unreadable, has no frontmatter, or `created` isn't an integer.
fn frontmatter_created(path: &Path) -> Option<i64> {
    let content = std::fs::read_to_string(path).ok()?;
    match page_frontmatter(&content)?.get("created")? {
        gray_matter::Pod::Integer(n) => Some(*n),
        _ => None,
    }
}

/// The marker `appendDigest` (`src/lib/sessionDigest.ts`) writes into the SAME
/// `daily/<day>.md` write as the digest bullets it belongs to, naming the
/// session files that section covers as `<stem>:<fingerprint>`:
/// `<!-- myco:digested-sessions claude-code-abc:1a2b3c4d codex-def:99887766 -->`.
///
/// Idempotency is anchored on those FILES, not on the day string: `session_day`
/// derives a day (frontmatter `created`, else mtime), so the same file can bucket
/// into a different day on a later run — a day-keyed flag would miss, and the
/// files would be digested (and paid for) twice. Keep these two literals in
/// lockstep with the TS side.
const DIGEST_MARKER_OPEN: &str = "<!-- myco:digested-sessions ";
const DIGEST_MARKER_CLOSE: &str = "-->";

/// FNV-1a (32-bit) over a session file's bytes, as 8 lowercase hex chars.
/// Deliberately not a cryptographic hash: it only has to notice that a file
/// changed since it was digested, and it must be reproducible in four lines of
/// TypeScript (`fingerprint` in `src/lib/sessionDigest.ts` writes the marker
/// this side reads back). Keep the two implementations byte-identical — both
/// hash the file's UTF-8 bytes.
pub(crate) fn content_fingerprint(bytes: &[u8]) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for b in bytes {
        h = (h ^ *b as u32).wrapping_mul(0x0100_0193);
    }
    format!("{h:08x}")
}

/// Session file entries recorded as digested by any existing `daily/*.md`
/// marker, verbatim (`<stem>:<fingerprint>`, or a bare `<stem>` from a marker
/// written before fingerprints existed). Reads every daily note on each call —
/// there are ~one per active day and the alternative is a derived-key ledger
/// that silently drifts.
///
/// Stems, not paths: a stem survives the archive move, and importer-written
/// session stems are `[A-Za-z0-9_-]` only (`importers::sanitize`), so the
/// space-separated list is unambiguous for them. Hand-placed files are not
/// bound by that: a name with whitespace simply never matches (it gets
/// digested again, the pre-marker behaviour, never a false "already done"),
/// and a name containing `:` is disambiguated by `is_digested` — see its
/// legacy-entry rule.
fn digested_session_entries(root: &Path) -> std::collections::HashSet<String> {
    marker_entries(&root.join("daily"), DIGEST_MARKER_OPEN)
}

/// Every entry recorded by an `<open> … -->` marker in any `*.md` directly
/// inside `dir`. Shared by both compression layers: `daily/*.md` markers name
/// the sessions they digest, `weekly/*.md` markers name the daily files they
/// roll up (`ROLLUP_MARKER_OPEN`) — same format, same idempotency contract,
/// one parser.
///
/// The walk is deliberately flat, which is also what keeps the cold tier out
/// of it: `daily/archive/` is a directory, so it never matches the `.md`
/// extension check and its markers stop counting the moment a day is rolled
/// up. That is correct for the sessions those days recorded — they are already
/// under `sessions/archive/`, which `walk_inflow` never offers again.
fn marker_entries(dir: &Path, open: &str) -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        for line in text.lines() {
            if let Some(rest) = line.trim().strip_prefix(open) {
                if let Some(list) = rest.strip_suffix(DIGEST_MARKER_CLOSE) {
                    out.extend(list.split_whitespace().map(str::to_string));
                }
            }
        }
    }
    out
}

/// Whether the file at `path` is already covered by a marker in `entries` —
/// a session file by a `daily/` digest marker, or (weekly rollup, one layer
/// up) a daily file by a `weekly/` rollup marker. The rule is the same at
/// both layers, so it is one function.
///
/// A stem is the CONVERSATION id and is stable across re-imports: a
/// conversation the user kept talking in comes back with the same stem but
/// more turns (and an unchanged `created:`), so matching on the stem alone
/// archived the whole continuation without ever digesting it. The record is
/// therefore bound to the CONTENT: `<stem>:<fingerprint>` must match the
/// file's current bytes.
///
/// Accepted trade: a resumed conversation is now digested again in full, so
/// its earlier turns get summarized a second time in a later daily note.
/// Partial duplication is cheap; silently dropping the new half of a
/// conversation into cold storage is not.
///
/// A bare `<stem>` entry is a marker from before fingerprints existed and
/// matches that stem regardless of content — otherwise upgrading would re-bill
/// an LLM digest for every session already summarized. "Bare" means literally
/// free of `:`, on both sides: `file_stem` splits on the LAST dot only, so a
/// hand-placed `<stem>:<8 hex>.md` would otherwise exact-match a real
/// `<stem>:<fingerprint>` record and be archived unsummarized. A stem
/// containing `:` therefore only ever takes the fingerprint path.
fn is_digested(entries: &std::collections::HashSet<String>, stem: &str, path: &Path) -> bool {
    if !stem.contains(':') && entries.contains(stem) {
        return true;
    }
    if entries.is_empty() {
        return false; // nothing could match — skip reading the file at all
    }
    std::fs::read(path).is_ok_and(|bytes| is_recorded(entries, stem, &content_fingerprint(&bytes)))
}

/// The `is_digested` record rule over an already-computed fingerprint. The
/// archive passes use this instead of `is_digested` so the check and the
/// journal revision checks anchor to ONE read's bytes —
/// two separate reads would reopen the very race the verify closes.
fn is_recorded(entries: &std::collections::HashSet<String>, stem: &str, fp: &str) -> bool {
    (!stem.contains(':') && entries.contains(stem)) || entries.contains(&format!("{stem}:{fp}"))
}

/// Groups mature, gate-scored `sessions/**/*.md` (excluding
/// `sessions/archive/`, via `walk_inflow`'s own exclusion — same walk
/// `collect_candidates` uses for this tree) by day, oldest day first. "Mature"
/// is the same `maturation_hours` gate `scan` uses; "gate-scored" means a
/// ledger entry exists at all (tier doesn't matter — an unscored file has no
/// verdict to digest around yet, but an already-summary/full/quarantine-tier
/// session log is still a work log worth digesting).
///
/// A day is offered only once EVERY file walked for it is mature and scored —
/// not as soon as one is. `scan`'s own run budget scores at most a few dozen
/// items per pass, so a day with hundreds of session files would otherwise
/// qualify (with a growing partial file list) on nearly every scan until the
/// last straggler finally got scored, redigesting the same day's earlier
/// files repeatedly at real LLM cost. Held back entirely, a day pays for
/// exactly one digest call once it is actually complete.
pub fn digestable_session_days(root: &Path) -> Result<Vec<DigestDay>, String> {
    let cfg = config_load_checked(root)?;
    let maturation_secs = cfg.maturation_hours as i64 * 3600;
    let now = now_secs();

    let store = current_store(root)?;
    let space = optional_store_space(&store)?;
    let inputs = admission::current(root, &store, &cfg)?;
    let state = state_for_inputs(root, space.as_ref(), &store.model, inputs.as_ref())?;

    let mut candidates = Vec::new();
    walk_inflow(
        root,
        crate::commands::DEST_SESSIONS,
        &[RAW_ARCHIVE_DIR],
        &mut candidates,
    );
    let digested = digested_session_entries(root);

    struct DayEntry {
        rel: String,
        ready: bool,
        digested: bool,
    }

    // Every walked file lands in its day's bucket regardless of readiness —
    // `ready` is per-file so the day-level filter below can require ALL of
    // them, not just count how many made it in.
    let mut by_day: HashMap<String, Vec<DayEntry>> = HashMap::new();
    for c in candidates {
        let mature = now - c.mtime >= maturation_secs;
        let ready = mature && is_scored_current(root, &state, &c.rel)?;
        let stem = c.path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        let day = session_day(stem, &c.path, c.mtime);
        by_day.entry(day).or_default().push(DayEntry {
            digested: is_digested(&digested, stem, &c.path),
            rel: c.rel,
            ready,
        });
    }

    let mut days: Vec<DigestDay> = by_day
        .into_iter()
        .filter(|(_, entries)| entries.iter().all(|e| e.ready))
        .map(|(day, entries)| {
            let already_digested = entries.iter().all(|e| e.digested);
            let mut files: Vec<String> = entries
                .into_iter()
                // Fully recorded: hand back every file, the caller only has
                // the archive move left to retry. Partly recorded (a late
                // session landed on an already-digested day): hand back only
                // the NEW files, so they get their own digest section for
                // their own content; the stragglers already recorded are
                // archived by the next run's retry path.
                .filter(|e| already_digested || !e.digested)
                .map(|e| e.rel)
                .collect();
            files.sort();
            DigestDay {
                day,
                files,
                already_digested,
            }
        })
        .collect();
    days.sort_by(|a, b| a.day.cmp(&b.day));
    Ok(days)
}

/// Test-only seam for the original check/rename race regression. Production
/// archiving uses the revision journal and non-overwriting link in `archive`.
#[cfg(test)]
fn archive_one_verified_with_hook(
    from: &Path,
    to: &Path,
    expected_fp: &str,
    between: impl Fn(),
) -> Result<bool, String> {
    let unchanged = std::fs::read(from).is_ok_and(|b| content_fingerprint(&b) == expected_fp);
    if !unchanged {
        return Ok(false);
    }
    between();
    std::fs::rename(from, to).map_err(|e| format!("archive move: {e}"))?;
    let verified = std::fs::read(to).is_ok_and(|b| content_fingerprint(&b) == expected_fp);
    if !verified {
        std::fs::rename(to, from).map_err(|e| format!("archive move rollback: {e}"))?;
    }
    Ok(verified)
}

/// Archive revision-verified session sources and report actual outcomes.
/// The checked IPC path additionally binds a stable journal ID and the exact
/// published digest bytes; the compatibility helper is used by native callers.
#[cfg(test)]
pub fn archive_digested_sessions(
    root: &Path,
    day: &str,
    files: &[String],
    fingerprints: Option<&[String]>,
) -> Result<ArchiveReceipt, String> {
    archive_digested_sessions_with_context(root, day, files, fingerprints, None)
}

pub(crate) fn archive_digested_sessions_with_context(
    root: &Path,
    day: &str,
    files: &[String],
    fingerprints: Option<&[String]>,
    context: Option<&ArchiveContext>,
) -> Result<ArchiveReceipt, String> {
    let b = day.as_bytes();
    let valid_day = day.len() == 10
        && b[0..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[7] == b'-'
        && b[8..10].iter().all(u8::is_ascii_digit);
    if !valid_day {
        return Err(format!("bad day `{day}`, expected YYYY-MM-DD"));
    }
    if let Some(context) = context {
        if context
            .publications
            .iter()
            .any(|p| p.path != format!("daily/{day}.md"))
        {
            return Err("session archive publication must be its daily note".into());
        }
    }
    let recorded = if fingerprints.is_none() {
        digested_session_entries(root)
    } else {
        Default::default()
    };
    archive::archive(
        root,
        archive::ArchiveInput {
            kind: "sessions",
            bucket: day,
            archive_dir: format!("sessions/archive/{}", &day[..7]),
            files,
            fingerprints,
            recorded: &recorded,
            payload_ok: is_session_payload_path,
            context,
        },
    )
}

// ---------------------------------------------------------------------------
// Weekly rollup (ROADMAP P1): the second compression layer. `sessions/`
// compress into `daily/`, but `daily/` is a growing tree of its own, so a
// settled ISO week's daily files roll up into `weekly/<YYYY-Www>.md` and go
// cold under `daily/archive/` — the same shape one level up. Nothing here is
// re-derived: the marker is `content_fingerprint` + `marker_entries` +
// `is_digested`, the eligibility rule is `digestable_session_days`'s
// all-files-ready rule, the archive is `archive_digested_sessions`'s
// confine + fingerprint-recheck + incremental `RunManifest`.
// ---------------------------------------------------------------------------

/// One settled bucket's source files, ready for the TS rollup step: an ISO
/// week of `daily/` notes, or a month of `weekly/` rollups one layer further
/// up.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct RollupBucket {
    /// The bucket, which is also the `<out>/<bucket>.md` stem: `YYYY-Www` for
    /// the weekly layer, `YYYY-MM` for the monthly one.
    pub bucket: String,
    pub files: Vec<String>,
    /// Every file in `files` is already named by a rollup marker in the layer
    /// above — its rollup text is durable and only the archive move failed.
    /// The exact `already_digested` contract, one level up.
    pub already_rolled: bool,
}

/// The marker `appendRollup` (`src/lib/weeklyRollup.ts`) writes into the SAME
/// `weekly/<week>.md` write as its bullets, naming the daily files that
/// section covers as `<day>:<fingerprint>`:
/// `<!-- myco:rolled-up-days 2026-08-10:1a2b3c4d 2026-08-11:99887766 -->`.
///
/// Bound to the daily files' CONTENT for the same reason `DIGEST_MARKER_OPEN`
/// is: a daily note keeps its name (`YYYY-MM-DD`) while the session digest
/// appends more sections to it and the user edits it by hand, so a name-keyed
/// record would archive the grown file without ever rolling up the new half.
/// Keep the literal in lockstep with the TS side; the close delimiter is
/// `DIGEST_MARKER_CLOSE`, shared.
const ROLLUP_MARKER_OPEN: &str = "<!-- myco:rolled-up-days ";

/// Days since the Unix epoch for a civil (proleptic Gregorian) date —
/// Hinnant's `days_from_civil`, the inverse of `civil_datetime`. An ISO week
/// number is defined by day arithmetic (which Thursday the week contains),
/// not by month/day, so the round trip is unavoidable.
pub(crate) fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = i64::from(if m > 2 { m - 3 } else { m + 9 });
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `YYYY-Www` — the ISO-8601 week a `YYYY-MM-DD` daily-note stem belongs to,
/// or `None` when the stem is not a real civil date (a hand-named file in
/// `daily/`, which then simply never joins a rollup).
///
/// ISO's own rule, not "day-of-year / 7": the week's Thursday decides which
/// year the week counts against, which is what makes 2026-12-31 fall in
/// 2027-W01 and keeps a year's last and first weeks from being rolled up
/// twice under two different names.
pub(crate) fn iso_week(day: &str) -> Option<String> {
    let b = day.as_bytes();
    if day.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let y: i64 = day[0..4].parse().ok()?;
    let m: u32 = day[5..7].parse().ok()?;
    let d: u32 = day[8..10].parse().ok()?;
    let days = days_from_civil(y, m, d);
    // Rejects an impossible date (`2026-02-31`) rather than silently letting
    // it wrap into the following month's week.
    let (ry, rm, rd, ..) = civil_datetime(days * 86_400);
    if (ry, rm, rd) != (y, m, d) {
        return None;
    }
    // 1970-01-01 was a Thursday, so `+3` puts Monday at 0.
    let dow = (days + 3).rem_euclid(7);
    let thursday = days - dow + 3;
    let (wy, ..) = civil_datetime(thursday * 86_400);
    let ordinal = thursday - days_from_civil(wy, 1, 1) + 1;
    Some(format!("{wy:04}-W{:02}", (ordinal - 1) / 7 + 1))
}

/// The `YYYY-MM` a `YYYY-Www` week counts against: the month holding the
/// week's Thursday — ISO's own tiebreak, the same one `iso_week` uses to pick
/// a week's year. A week that straddles two months therefore belongs to
/// exactly one of them, so no `weekly/` file can roll up into two different
/// `monthly/` files.
fn month_of_iso_week(week: &str) -> Option<String> {
    if !is_iso_week_name(week) {
        return None;
    }
    let y: i64 = week[0..4].parse().ok()?;
    let w: i64 = week[6..8].parse().ok()?;
    let jan4 = days_from_civil(y, 1, 4);
    // 1970-01-01 was a Thursday, so `+3` puts Monday at 0 — same shift as
    // `iso_week`. Jan 4 is in W01 by definition, which anchors the rest.
    let jan4_dow = (jan4 + 3).rem_euclid(7);
    let thursday = jan4 - jan4_dow + 3 + (w - 1) * 7;
    let (ty, tm, td, ..) = civil_datetime(thursday * 86_400);
    // W53 does not exist in every year; when it doesn't, the arithmetic above
    // lands in the NEXT year's W01 and this week name was never real. Round
    // trip through `iso_week` rather than reimplementing the 52/53 rule.
    if iso_week(&format!("{ty:04}-{tm:02}-{td:02}")).as_deref() != Some(week) {
        return None;
    }
    Some(format!("{ty:04}-{tm:02}"))
}

/// `YYYY-Www`, the weekly layer's bucket shape — checked before a bucket name
/// that arrived over IPC becomes a directory under `daily/archive/`.
pub(crate) fn is_iso_week_name(bucket: &str) -> bool {
    let b = bucket.as_bytes();
    bucket.len() == 8
        && b[0..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && b[5] == b'W'
        && b[6..8].iter().all(u8::is_ascii_digit)
}

/// `YYYY-MM`, the monthly layer's bucket shape. Month is range-checked: `13`
/// is digits but not a month, and it would become a directory name that no
/// `weekly/` file can ever belong to.
pub(crate) fn is_month_name(bucket: &str) -> bool {
    let b = bucket.as_bytes();
    bucket.len() == 7
        && b[0..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && b[5..7].iter().all(u8::is_ascii_digit)
        && matches!(bucket[5..7].parse::<u32>(), Ok(1..=12))
}

/// The ISO week `now` falls in — the week still happening.
fn current_iso_week(now: i64) -> Option<String> {
    let (y, m, d, ..) = civil_datetime(now);
    iso_week(&format!("{y:04}-{m:02}-{d:02}"))
}

/// The month `now` falls in — the month still happening.
fn current_month(now: i64) -> Option<String> {
    let (y, m, ..) = civil_datetime(now);
    Some(format!("{y:04}-{m:02}"))
}

/// One compression layer of the pyramid: which tier feeds it, where its
/// rollups land, and how a source file's stem maps to a bucket. `daily/` ->
/// `weekly/<YYYY-Www>.md` and `weekly/` -> `monthly/<YYYY-MM>.md` are the
/// same algorithm over different names, so they are one function and two
/// constants instead of two copies that drift apart.
pub struct RollupLayer {
    /// Directory holding the files that roll up.
    pub src: &'static str,
    /// Directory the rollup sections — and their markers — are written to.
    pub out: &'static str,
    /// The bucket a source file's stem belongs to; `None` for a stem this
    /// layer does not understand (a hand-named file, which then simply never
    /// joins a rollup).
    bucket_of: fn(&str) -> Option<String>,
    /// The bucket a unix time falls in — the one still in progress, never
    /// offered however mature the files already in it look.
    current: fn(i64) -> Option<String>,
    /// Shape check for the IPC-supplied bucket, which becomes a directory
    /// name under `<src>/archive/`.
    valid_bucket: fn(&str) -> bool,
    /// Confine for the caller-supplied file list.
    payload_ok: fn(&str) -> bool,
}

/// `daily/` -> `weekly/` (ROADMAP P1).
pub static WEEKLY: RollupLayer = RollupLayer {
    src: "daily",
    out: "weekly",
    bucket_of: iso_week,
    current: current_iso_week,
    valid_bucket: is_iso_week_name,
    payload_ok: is_daily_payload_path,
};

/// `weekly/` -> `monthly/` — the third layer. Weekly rollups accumulate one
/// file per active week exactly the way daily digests accumulated one per
/// active day, so the pyramid needs the same step again above them.
pub static MONTHLY: RollupLayer = RollupLayer {
    src: "weekly",
    out: "monthly",
    bucket_of: month_of_iso_week,
    current: current_month,
    valid_bucket: is_month_name,
    payload_ok: is_weekly_payload_path,
};

/// The layer an IPC caller named. `None` for anything else — the command
/// turns that into an error rather than defaulting, so a typo can never
/// silently roll up (and archive) the wrong tier.
pub fn rollup_layer(name: &str) -> Option<&'static RollupLayer> {
    match name {
        "weekly" => Some(&WEEKLY),
        "monthly" => Some(&MONTHLY),
        _ => None,
    }
}

/// `daily/<name>`, no further nesting — the one shape a daily note ever has
/// (`daily/<YYYY-MM-DD>.md`), which excludes `daily/archive/...` for free.
/// The confine `archive_rolled` applies to its caller-supplied `files`,
/// same as `is_session_payload_path` one level down.
fn is_daily_payload_path(rel: &str) -> bool {
    rel.strip_prefix("daily/")
        .is_some_and(|rest| !rest.is_empty() && !rest.contains('/'))
}

/// `weekly/<name>`, no further nesting — the monthly layer's source shape and
/// the exact counterpart of `is_daily_payload_path`, which is likewise what
/// keeps `weekly/archive/...` out of a caller-supplied file list.
fn is_weekly_payload_path(rel: &str) -> bool {
    rel.strip_prefix("weekly/")
        .is_some_and(|rest| !rest.is_empty() && !rest.contains('/'))
}

/// Groups mature, not-yet-rolled `<layer.src>/*.md` by bucket, oldest first.
/// A flat `read_dir` (neither daily notes nor weekly rollups are ever
/// nested), so `<layer.src>/archive/` is skipped without an explicit
/// exclusion.
///
/// "Settled" mirrors `digestable_session_days`'s fully-scored-day rule: a
/// bucket is offered only once EVERY file in it is past `maturation_hours`,
/// not as soon as one is. A daily file is still growing while that day's
/// sessions keep arriving — the session digest appends another section per
/// run — and a weekly file grows the same way while its week's days are still
/// rolling up, so rolling up a bucket containing a fresh file would summarize
/// a half-written unit and then have to pay for the same bucket again. There
/// is no scored-ledger half to the check here: everything under `daily/` and
/// `weekly/` is distillation's own output, not inflow, so it has no gate
/// verdict to wait for.
pub fn rollupable_buckets(root: &Path, layer: &RollupLayer) -> Vec<RollupBucket> {
    let cfg = config_load(root);
    let maturation_secs = cfg.maturation_hours as i64 * 3600;
    let now = now_secs();
    let rolled = marker_entries(&root.join(layer.out), ROLLUP_MARKER_OPEN);

    struct DayEntry {
        rel: String,
        ready: bool,
        rolled: bool,
    }

    let Ok(entries) = std::fs::read_dir(root.join(layer.src)) else {
        return Vec::new();
    };
    let mut by_week: HashMap<String, Vec<DayEntry>> = HashMap::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Some(week) = (layer.bucket_of)(stem) else {
            continue;
        };
        let Some(mtime) = mtime_secs(&path) else {
            continue;
        };
        by_week.entry(week).or_default().push(DayEntry {
            ready: now - mtime >= maturation_secs,
            rolled: is_digested(&rolled, stem, &path),
            rel: rel_string(root, &path),
        });
    }

    // The bucket that is still HAPPENING is never rollable, however mature its
    // existing files look. `maturation_hours` means "this file stopped
    // growing", which at day granularity implies "that day is over" — at week
    // or month granularity it does not: on Thursday, Monday's and Tuesday's
    // notes are both 24h old while the week has three days left. Rolling it up
    // then charges once per remaining unit, appends a section per run, and
    // moves the current bucket's files to the cold tier mid-bucket.
    let current = (layer.current)(now);

    let mut weeks: Vec<RollupBucket> = by_week
        .into_iter()
        .filter(|(week, _)| Some(week.as_str()) != current.as_deref())
        .filter(|(_, entries)| entries.iter().all(|e| e.ready))
        .map(|(week, entries)| {
            let already_rolled = entries.iter().all(|e| e.rolled);
            let mut files: Vec<String> = entries
                .into_iter()
                // Same split as `digestable_session_days`: fully recorded ->
                // hand back everything, only the archive move is left to
                // retry; partly recorded (a late daily note reappeared in an
                // already-rolled week) -> hand back only the new files, which
                // get their own rollup section.
                .filter(|e| already_rolled || !e.rolled)
                .map(|e| e.rel)
                .collect();
            files.sort();
            RollupBucket {
                bucket: week,
                files,
                already_rolled,
            }
        })
        .collect();
    weeks.sort_by(|a, b| a.bucket.cmp(&b.bucket));
    weeks
}

/// Archive source notes covered by a weekly/monthly rollup, preserving a
/// recoverable SHA256-bound intent and reporting moves separately from pending.
#[cfg(test)]
pub fn archive_rolled(
    root: &Path,
    layer: &RollupLayer,
    bucket: &str,
    files: &[String],
    fingerprints: Option<&[String]>,
) -> Result<ArchiveReceipt, String> {
    archive_rolled_with_context(root, layer, bucket, files, fingerprints, None)
}

pub(crate) fn archive_rolled_with_context(
    root: &Path,
    layer: &RollupLayer,
    bucket: &str,
    files: &[String],
    fingerprints: Option<&[String]>,
    context: Option<&ArchiveContext>,
) -> Result<ArchiveReceipt, String> {
    if !(layer.valid_bucket)(bucket) {
        return Err(format!("bad {} bucket `{bucket}`", layer.out));
    }
    if let Some(context) = context {
        if context
            .publications
            .iter()
            .any(|p| p.path != format!("{}/{bucket}.md", layer.out))
        {
            return Err("rollup archive publication must be its output note".into());
        }
    }
    let recorded = if fingerprints.is_none() {
        marker_entries(&root.join(layer.out), ROLLUP_MARKER_OPEN)
    } else {
        Default::default()
    };
    archive::archive(
        root,
        archive::ArchiveInput {
            kind: layer.out,
            bucket,
            archive_dir: format!("{}/archive/{bucket}", layer.src),
            files,
            fingerprints,
            recorded: &recorded,
            payload_ok: layer.payload_ok,
            context,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    mod numeric_tests {
        include!("distill_numeric_tests.rs");
    }

    mod provenance_tests {
        include!("distill_provenance_tests.rs");
    }

    mod decision_context_tests {
        include!("distill_decision_context_tests.rs");
    }

    mod decision_context_additional_tests {
        include!("distill_decision_context_additional_tests.rs");
    }

    mod anchor_additional_tests {
        include!("distill_anchor_additional_tests.rs");
    }

    // Preserve the original RED witness source; this allowance changes style only.
    #[allow(clippy::single_match)]
    mod anchor_tests {
        include!("distill_anchor_tests.rs");
    }

    #[test]
    fn slugify_keeps_hangul_titles() {
        // The ASCII-only version collapsed pure-Hangul titles to "" and the
        // proposal filename degenerated to just its date.
        assert_eq!(slugify("한글 제목"), "한글-제목");
        assert_eq!(slugify("Mixed 한글 Title!"), "mixed-한글-title");
        // NFD input composes before slugging.
        assert_eq!(
            slugify("\u{1112}\u{1161}\u{11AB}\u{1100}\u{1173}\u{11AF}"),
            "한글"
        );
    }

    #[test]
    fn git_commit_run_stages_wiki_with_agent_author() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("wiki")).unwrap();
        crate::vault_history::init(root).unwrap();
        std::fs::write(root.join("wiki/new-page.md"), "written by distill").unwrap();

        git_commit_run(root, "digest-123");

        let out = std::process::Command::new("git")
            .args(["log", "-1", "--format=%an|%s", "--", "wiki/new-page.md"])
            .current_dir(root)
            .output()
            .unwrap();
        let line = String::from_utf8_lossy(&out.stdout);
        assert!(
            line.starts_with(crate::vault_history::AGENT_NAME),
            "agent author on distill commit, got: {line}"
        );
        assert!(line.contains("distill: run digest-123"));
    }

    fn set_mtime(path: &Path, time: std::time::SystemTime) {
        let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(time).unwrap();
    }

    fn old_mtime() -> std::time::SystemTime {
        std::time::SystemTime::now() - std::time::Duration::from_secs(48 * 3600)
    }

    /// Safely past `MAP_MATURITY_DAYS` (7) — the map-candidate maturity
    /// filter's "old enough" fixture, distinct from `old_mtime`'s 48h (which
    /// only clears the much shorter default `maturation_hours`).
    fn map_mature_mtime() -> std::time::SystemTime {
        std::time::SystemTime::now() - std::time::Duration::from_secs(8 * 86_400)
    }

    /// A throwaway manifest for tests that call `scan` directly (outside
    /// `run`, which builds its own). Its persisted `.myco/distill-runs/t.json`
    /// is incidental — these tests assert on the returned `ScanOutcome` and/or
    /// the manifest's in-memory contents, not the run orchestration `run`
    /// itself covers.
    fn test_manifest() -> RunManifest {
        RunManifest {
            id: "t".into(),
            started_at: now_secs(),
            ..Default::default()
        }
    }

    /// `n` minimal `wiki/` pages — tests that drive `run()` (which builds its
    /// own ontology straight off disk, unlike `tiny_ontology()`) need real
    /// wiki pages on disk to keep the cold-start gate active.
    fn seed_wiki_pages(root: &Path, n: usize) {
        let dir = root.join("wiki");
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..n {
            std::fs::write(dir.join(format!("seed-{i}.md")), "seed page").unwrap();
        }
    }

    /// One cluster centred on `[1.0, 0.0]` with clean, well-separated
    /// thresholds (p5=0.10, p25=0.50, p40=0.90) — same shape as
    /// `ontology::tests::admit_reason_cites_the_threshold_that_actually_decided_the_tier`,
    /// built directly here since that test module's helpers are private to it.
    fn tiny_ontology() -> Ontology {
        Ontology {
            model: "test-model".to_string(),
            embedding: Some(synthetic_space(2)),
            source_signature: "synthetic-ontology-inputs".into(),
            built_at: 0,
            // At/above GATE_MIN_WIKI_PAGES so scan()'s cold-start gate stays
            // active — these tests exercise real scoring, not the gate.
            wiki_pages: GATE_MIN_WIKI_PAGES,
            clusters: vec![crate::ontology::Cluster {
                id: 0,
                label: "topic".into(),
                members: vec!["wiki/topic.md".into()],
                centroid: vec![1.0, 0.0],
                sim_mean: 0.9,
                sim_std: 0.05,
                p5: 0.10,
                p25: 0.50,
                p40: 0.90,
                last_touched: 0,
                override_widen: 0.0,
            }],
            entities: Vec::new(),
        }
    }

    /// A one-cluster ontology whose only cluster is `id`/`label`/`members` —
    /// the map-candidate tests' fixture; the similarity fields are unused by
    /// `propose_map_candidates` (it never calls `admit`), so they're filled
    /// with placeholders rather than `tiny_ontology`'s calibrated ones.
    fn ontology_with_cluster(id: u32, label: &str, members: Vec<String>) -> Ontology {
        Ontology {
            model: "test-model".to_string(),
            embedding: Some(synthetic_space(2)),
            source_signature: "synthetic-ontology-inputs".into(),
            built_at: 0,
            wiki_pages: members.len(),
            clusters: vec![crate::ontology::Cluster {
                id,
                label: label.to_string(),
                members,
                centroid: vec![1.0, 0.0],
                sim_mean: 0.9,
                sim_std: 0.05,
                p5: 0.10,
                p25: 0.50,
                p40: 0.90,
                last_touched: 0,
                override_widen: 0.0,
            }],
            entities: Vec::new(),
        }
    }

    /// Write a `wiki/`-relative member page with the frontmatter fields
    /// `member_is_mature` reads, then stamp its mtime — the map-candidate
    /// maturity-filter tests' fixture.
    fn write_wiki_member(
        root: &Path,
        rel: &str,
        status: &str,
        confidence: &str,
        mtime: std::time::SystemTime,
    ) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            format!(
                "---\ntitle: member\ntype: concept\nstatus: {status}\nconfidence: {confidence}\ncreated: 2026-01-01\n---\n\n# member\n"
            ),
        )
        .unwrap();
        set_mtime(&path, mtime);
    }

    const PROSE: &str = "This is a normal note about quantization techniques and how they reduce model size while preserving accuracy across a range of benchmarks and downstream tasks in real deployments, and it keeps going a little further so the byte count clears the junk-heuristic floor.";

    fn synthetic_space(dim: usize) -> EmbeddingSpace {
        EmbeddingSpace {
            model: "test-model".into(),
            signature: format!("synthetic-space-{dim}"),
            dim,
        }
    }

    /// Populate actual temporary sources and every section without changing
    /// the requested fixture page count or the controlled member geometry.
    fn synthetic_current_store(
        root: &Path,
        space: &EmbeddingSpace,
        members: &[(String, Vec<f32>)],
    ) -> crate::vector_index::VectorStore {
        for (member, _) in members {
            let target = root.join(member);
            if target.exists() {
                continue;
            }
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
            let placeholder = knowledge::read(root)
                .unwrap()
                .pages
                .into_iter()
                .find(|page| {
                    (page.path.starts_with("wiki/seed-")
                        || page.path.starts_with("wiki/fixture-context-"))
                        && matches!(
                            page.content.as_str(),
                            "seed page" | "synthetic context page"
                        )
                });
            if let Some(page) = placeholder {
                std::fs::rename(root.join(page.path), &target).unwrap();
            } else {
                std::fs::write(&target, "synthetic indexed wiki member").unwrap();
            }
        }
        let mut store = crate::vector_index::VectorStore::default();
        store.ensure_signature(&space.model, &space.signature);
        let mut fallback = vec![0.0; space.dim];
        fallback[0] = 1.0;
        let fallback = members
            .first()
            .map(|(_, vector)| vector)
            .unwrap_or(&fallback);
        for page in knowledge::read(root)
            .unwrap()
            .pages
            .into_iter()
            .filter(|page| page.eligible)
        {
            let vector = members
                .iter()
                .find(|(path, _)| path == &page.path)
                .map(|(_, vector)| vector)
                .unwrap_or(fallback);
            let entries = crate::embeddings::chunk_page(&page.content)
                .iter()
                .enumerate()
                .map(|(section, chunk)| {
                    (
                        section,
                        crate::embeddings::content_hash(chunk),
                        vector.clone(),
                    )
                })
                .collect();
            store
                .upsert_page_sections(&page.path, &page.stem, entries)
                .unwrap();
        }
        store
    }

    fn seed_semantic_store(root: &Path, dim: usize) {
        let space = synthetic_space(dim);
        let mut vector = vec![0.0; dim];
        vector[0] = 1.0;
        let store = synthetic_current_store(root, &space, &[("wiki/topic.md".into(), vector)]);
        let path = crate::vector_index::VectorStore::path_for(
            &root.canonicalize().unwrap().to_string_lossy(),
        )
        .unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        store.save(&path).unwrap();
        let snapshot = knowledge::read(root).unwrap();
        let titles = snapshot.titles().unwrap();
        let anchors = map_anchors_from_store(root, &store).unwrap();
        crate::ontology::save(
            root,
            &crate::ontology::build(&store, &titles, &anchors).unwrap(),
        )
        .unwrap();
    }

    /// Bind complete actual source chunks while preserving synthetic thresholds.
    fn save_synthetic_ontology(root: &Path, mut ontology: Ontology) -> Ontology {
        let space = ontology.embedding.clone().unwrap();
        let members: Vec<_> = ontology
            .clusters
            .iter()
            .flat_map(|cluster| {
                cluster
                    .members
                    .iter()
                    .map(|member| (member.clone(), cluster.centroid.clone()))
            })
            .collect();
        let store = synthetic_current_store(root, &space, &members);
        let path = crate::vector_index::VectorStore::path_for(
            &root.canonicalize().unwrap().to_string_lossy(),
        )
        .unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        store.save(&path).unwrap();
        let titles = knowledge::read(root).unwrap().titles().unwrap();
        let anchors = map_anchors_from_store(root, &store).unwrap();
        let built = crate::ontology::build(&store, &titles, &anchors).unwrap();
        ontology.source_signature = built.source_signature;
        ontology.wiki_pages = titles.len();
        crate::ontology::save(root, &ontology).unwrap();
        ontology
    }

    fn pin_scan_ontology(root: &Path, ontology: Ontology) -> Ontology {
        let pages = crate::commands::wiki_titles(root).len();
        std::fs::create_dir_all(root.join("wiki")).unwrap();
        for index in pages..GATE_MIN_WIKI_PAGES {
            std::fs::write(
                root.join(format!("wiki/fixture-context-{index}.md")),
                "synthetic context page",
            )
            .unwrap();
        }
        save_synthetic_ontology(root, ontology)
    }

    fn source_digest_for_test(root: &Path, rel: &str) -> String {
        admission::read_source(root, rel).unwrap().unwrap().sha256
    }

    fn decision_signature_for_test(root: &Path) -> String {
        test_current_decision_signature(root).unwrap().unwrap()
    }

    /// Write a quarantined item's content file + verdict sidecar directly
    /// (bypassing `scan`) — the Task 7 clustering/proposal tests need control
    /// over the sidecar's `vector` field, which `scan`'s own embed closure
    /// does not expose per-file. `expires` is far in the future so the TTL
    /// pass never sweeps these away out from under a same-run cluster test.
    fn write_quarantine_item(dir: &Path, stem: &str, vector: Vec<f32>) {
        let body = format!("{PROSE} ({stem})");
        std::fs::write(dir.join(format!("{stem}.md")), &body).unwrap();
        let root = dir.parent().unwrap().parent().unwrap();
        let ontology =
            match crate::index_publication::read_checked(&super::dir(root).join("ontology.json"))
                .unwrap()
            {
                Some(raw) => serde_json::from_slice(&raw).unwrap(),
                None => tiny_ontology(),
            };
        let inputs = admission::capture(root, &ontology, &DistillConfig::default()).unwrap();
        let sidecar = serde_json::json!({
            "tier": "quarantine",
            "s_knn": 0.2,
            "nearest_cluster": "topic",
            "reason": "test",
            "expires": now_secs() + 1_000_000,
            "vector": vector,
            "embedding": synthetic_space(2),
            "source_sha256": admission::sha256(body.as_bytes()),
            "decision_signature": inputs.signature,
        });
        std::fs::write(
            dir.join(format!("{stem}.verdict.json")),
            serde_json::to_string_pretty(&sidecar).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn cold_start_gate_skips_scoring_below_50_wiki_pages() {
        assert!(PROSE.len() >= JUNK_MIN_BYTES);
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("_inbox")).unwrap();
        std::fs::write(root.join("_inbox/c.md"), PROSE).unwrap();
        set_mtime(&root.join("_inbox/c.md"), old_mtime());

        // A 5-page vault — below GATE_MIN_WIKI_PAGES (50).
        let mut o = tiny_ontology();
        o.wiki_pages = 5;
        let cfg = DistillConfig::default();
        // Real, non-junk prose (see other scan tests using the same PROSE
        // const) — mature, unscored, and normally embeddable — proves the
        // gate short-circuits before scoring, not that the inbox is empty.
        let embed = |_: Vec<String>| -> Result<Vec<Vec<f32>>, String> {
            panic!("cold-start gate must skip embedding entirely")
        };

        let mut manifest = test_manifest();
        let out = scan(root, &o, &cfg, 10, &embed, &[], &mut manifest).unwrap();
        // Defect D fix: the gate reason carries the actual page count now,
        // not just a silent eprintln! — everything else about a gated-off
        // scan stays a no-op.
        assert_eq!(
            out,
            ScanOutcome {
                gate_wiki_pages: Some(5),
                ..Default::default()
            }
        );
        assert!(manifest.moves.is_empty() && manifest.created.is_empty());
        assert!(
            root.join("_inbox/c.md").exists(),
            "must not move into quarantine"
        );
        assert!(!root.join("_inbox/quarantine").exists());

        let state = state_load(root, &o.model);
        assert!(
            state.scored.is_empty(),
            "nothing scored while the gate is off"
        );
        assert!(
            state.rejected_ttl.is_empty(),
            "nothing rejected while the gate is off"
        );
    }

    #[test]
    fn scan_scores_only_mature_unscored_items_within_budget() {
        assert!(PROSE.len() >= JUNK_MIN_BYTES);
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("_inbox")).unwrap();
        std::fs::create_dir_all(root.join("sessions/2026-08")).unwrap();
        std::fs::write(root.join("_inbox/a.md"), PROSE).unwrap();
        std::fs::write(root.join("_inbox/b.md"), PROSE).unwrap();
        std::fs::write(root.join("sessions/2026-08/c.md"), PROSE).unwrap();
        set_mtime(&root.join("_inbox/a.md"), old_mtime());
        set_mtime(&root.join("sessions/2026-08/c.md"), old_mtime());
        // b.md keeps the fresh mtime it was just written with.

        let o = tiny_ontology();
        let cfg = DistillConfig::default(); // maturation_hours = 24
        let embed = |texts: Vec<String>| -> Result<Vec<Vec<f32>>, String> {
            Ok(texts.iter().map(|_| vec![1.0, 0.0]).collect())
        };

        let mut manifest = test_manifest();
        let out = scan(root, &o, &cfg, 10, &embed, &[], &mut manifest).unwrap();
        assert_eq!(out.scored, 2, "a.md and c.md are mature and unscored");
        assert_eq!(out.skipped_immature, 1, "b.md is under the maturation gate");

        let out2 = scan(root, &o, &cfg, 10, &embed, &[], &mut manifest).unwrap();
        assert_eq!(out2.scored, 0, "unchanged content must not be rescored");
    }

    /// Equal metadata cannot authorize a score for different current bytes.
    #[test]
    fn scan_checks_same_stamp_replacements_and_reuses_unchanged_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("_inbox")).unwrap();
        let path = root.join("_inbox/a.md");
        std::fs::write(&path, PROSE).unwrap();
        set_mtime(&path, old_mtime());
        let stamp = std::fs::metadata(&path).unwrap().modified().unwrap();

        let o = tiny_ontology();
        let cfg = DistillConfig::default();
        let embeds = std::cell::Cell::new(0usize);
        let embed = |texts: Vec<String>| -> Result<Vec<Vec<f32>>, String> {
            embeds.set(embeds.get() + 1);
            Ok(texts.iter().map(|_| vec![1.0, 0.0]).collect())
        };
        let mut manifest = test_manifest();
        let out = scan(root, &o, &cfg, 10, &embed, &[], &mut manifest).unwrap();
        assert_eq!(out.scored, 1);
        let first_hash = state_load(root, &o.model).scored["_inbox/a.md"].hash;

        // Different bytes remain different even when both metadata fields match.
        std::fs::write(&path, "x".repeat(PROSE.len())).unwrap();
        set_mtime(&path, stamp);
        let out = scan(root, &o, &cfg, 10, &embed, &[], &mut manifest).unwrap();
        assert_eq!(out.scored, 1, "changed bytes require a new verdict");
        assert_eq!(embeds.get(), 2, "changed bytes require a new embedding");
        assert_ne!(
            state_load(root, &o.model).scored["_inbox/a.md"].hash,
            first_hash,
            "equal metadata must not hide the changed source"
        );

        // Move the mtime (still mature) and the file is read again.
        set_mtime(&path, stamp - std::time::Duration::from_secs(3600));
        let out = scan(root, &o, &cfg, 10, &embed, &[], &mut manifest).unwrap();
        assert_eq!(
            out.scored, 0,
            "unchanged bytes retain their checked verdict"
        );
        assert_eq!(embeds.get(), 2, "a metadata touch needs no model call");
        assert_ne!(
            state_load(root, &o.model).scored["_inbox/a.md"].hash,
            first_hash
        );
    }

    /// A checked source/decision receipt can predate metadata stamps. A reread
    /// updates those hints without spending another embedding.
    #[test]
    fn scan_stamps_a_pre_stamp_ledger_on_its_first_reread() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("_inbox")).unwrap();
        let path = root.join("_inbox/a.md");
        std::fs::write(&path, PROSE).unwrap();
        set_mtime(&path, old_mtime());
        let o = tiny_ontology();
        let legacy = serde_json::json!({
            "model": o.model,
            "embedding": o.embedding,
            "scored": { "_inbox/a.md": {
                "hash": crate::embeddings::content_hash(PROSE), "tier": "full", "at": 1,
                "embedding": o.embedding,
                "source_sha256": admission::sha256(PROSE.as_bytes()),
                "decision_signature": admission::capture(root, &o, &DistillConfig::default()).unwrap().signature,
            } }
        });
        std::fs::create_dir_all(state_path(root).parent().unwrap()).unwrap();
        std::fs::write(state_path(root), legacy.to_string()).unwrap();
        let loaded = &state_load(root, &o.model).scored["_inbox/a.md"];
        assert_eq!((loaded.mtime, loaded.len), (0, 0), "stamp-less entry loads");

        let cfg = DistillConfig::default();
        let embed = |_: Vec<String>| -> Result<Vec<Vec<f32>>, String> {
            panic!("unchanged content must not be re-embedded")
        };
        let mut manifest = test_manifest();
        let out = scan(root, &o, &cfg, 10, &embed, &[], &mut manifest).unwrap();
        assert_eq!(out.scored, 0, "same hash: not re-scored");
        let meta = std::fs::metadata(&path).unwrap();
        let e = &state_load(root, &o.model).scored["_inbox/a.md"];
        assert_eq!(e.len, meta.len(), "the re-read stamped the entry");
        assert_eq!(
            e.mtime,
            meta.modified()
                .unwrap()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64
        );

        // A later equal-stamp replacement invalidates the source receipt.
        std::fs::write(&path, "x".repeat(PROSE.len())).unwrap();
        set_mtime(&path, meta.modified().unwrap());
        let changed_embed = |texts: Vec<String>| Ok(texts.iter().map(|_| vec![1.0, 0.0]).collect());
        let out = scan(root, &o, &cfg, 10, &changed_embed, &[], &mut manifest).unwrap();
        assert_eq!(out.scored, 1, "stamped metadata cannot bless swapped bytes");
    }

    #[test]
    fn junk_heuristics_skip_embedding() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("_inbox")).unwrap();
        std::fs::create_dir_all(root.join("sessions/2026-08")).unwrap();

        std::fs::write(root.join("_inbox/empty.md"), "").unwrap();
        let noisy: String = (0..20)
            .map(|i| format!("{{\"type\": \"tool_use\", \"id\": {i}, \"name\": \"bash\"}}\n"))
            .collect::<String>()
            + "assistant: done.\n";
        assert!(noisy.len() >= JUNK_MIN_BYTES);
        std::fs::write(root.join("sessions/2026-08/noisy.md"), &noisy).unwrap();
        set_mtime(&root.join("_inbox/empty.md"), old_mtime());
        set_mtime(&root.join("sessions/2026-08/noisy.md"), old_mtime());

        let o = tiny_ontology();
        let cfg = DistillConfig::default();
        let embed =
            |_: Vec<String>| -> Result<Vec<Vec<f32>>, String> { panic!("must not embed junk") };

        let mut manifest = test_manifest();
        let out = scan(root, &o, &cfg, 10, &embed, &[], &mut manifest).unwrap();
        assert_eq!(out.scored, 2);
        assert_eq!(out.rejected, 2, "both junk items reject without embedding");

        let state = state_load(root, &o.model);
        let empty_entry = state.scored.get("_inbox/empty.md").unwrap();
        assert_eq!(empty_entry.tier, "reject");
        let noisy_entry = state.scored.get("sessions/2026-08/noisy.md").unwrap();
        assert_eq!(noisy_entry.tier, "reject");
        assert!(state.rejected_ttl.contains_key("_inbox/empty.md"));
        assert!(state.rejected_ttl.contains_key("sessions/2026-08/noisy.md"));
    }

    #[test]
    fn quarantine_moves_file_with_verdict_sidecar() {
        assert!(PROSE.len() >= JUNK_MIN_BYTES);
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("_inbox")).unwrap();
        std::fs::write(root.join("_inbox/c.md"), PROSE).unwrap();
        set_mtime(&root.join("_inbox/c.md"), old_mtime());

        let o = tiny_ontology();
        let cfg = DistillConfig::default(); // GatePreset::Normal: t_full=p25=0.50, t_quar=p5=0.10
                                            // cosine 0.2 from the [1.0, 0.0] centroid: >= t_quar, < t_summary (0.30) -> Quarantine.
        let borderline = vec![0.2_f32, (1.0 - 0.2_f32 * 0.2_f32).sqrt()];
        let embed = move |texts: Vec<String>| -> Result<Vec<Vec<f32>>, String> {
            Ok(texts.iter().map(|_| borderline.clone()).collect())
        };

        let mut manifest = test_manifest();
        let out = scan(root, &o, &cfg, 10, &embed, &[], &mut manifest).unwrap();
        assert_eq!(out.quarantined, 1);
        assert!(!root.join("_inbox/c.md").exists());

        let moved = root.join("_inbox/quarantine/c.md");
        assert!(moved.exists(), "file must be moved into _inbox/quarantine/");
        let sidecar_raw =
            std::fs::read_to_string(root.join("_inbox/quarantine/c.verdict.json")).unwrap();
        let sidecar: serde_json::Value = serde_json::from_str(&sidecar_raw).unwrap();
        assert_eq!(sidecar["tier"], "quarantine");
        assert!(sidecar["s_knn"].is_number());
        assert_eq!(sidecar["nearest_cluster"], "topic");
        assert!(sidecar["reason"].is_string());
        assert!(sidecar["expires"].is_number());
        assert_eq!(sidecar["vector"].as_array().unwrap().len(), 2);
        assert_eq!(sidecar["from"], "_inbox/c.md", "restore needs the origin");

        // The move and the sidecar creation are both undo-tracked.
        assert_eq!(manifest.moves.len(), 1);
        assert_eq!(manifest.moves[0].from, "_inbox/c.md");
        assert_eq!(manifest.moves[0].to, "_inbox/quarantine/c.md");
        assert_eq!(manifest.created, vec!["_inbox/quarantine/c.verdict.json"]);

        // Defect G fix — DistillStatus.quarantined counts it, read-only.
        assert_eq!(status(root).quarantined, 1);
    }

    #[test]
    fn quarantine_never_moves_a_raw_source() {
        // raw/ is immutable and not inflow (owner decision 2026-10-03, B1): a
        // raw/ item the similarity band would quarantine is never even
        // scored, so it stays where it is.
        assert!(PROSE.len() >= JUNK_MIN_BYTES);
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("raw")).unwrap();
        std::fs::write(root.join("raw/paper.md"), PROSE).unwrap();
        set_mtime(&root.join("raw/paper.md"), old_mtime());

        let o = tiny_ontology();
        let cfg = DistillConfig::default();
        let borderline = vec![0.2_f32, (1.0 - 0.2_f32 * 0.2_f32).sqrt()];
        let embed = move |texts: Vec<String>| -> Result<Vec<Vec<f32>>, String> {
            Ok(texts.iter().map(|_| borderline.clone()).collect())
        };

        let mut manifest = test_manifest();
        let out = scan(root, &o, &cfg, 10, &embed, &[], &mut manifest).unwrap();
        assert_eq!((out.scored, out.quarantined), (0, 0));
        assert_eq!(
            std::fs::read_to_string(root.join("raw/paper.md")).unwrap(),
            PROSE
        );
        assert!(!root.join("_inbox/quarantine").exists());
        assert!(manifest.moves.is_empty());
        assert!(!state_load(root, &o.model)
            .scored
            .contains_key("raw/paper.md"));
    }

    /// A synthetic imported session whose first user turn is `first`.
    fn session_doc(first: &str) -> String {
        format!(
            "---\nsource: codex\nconversation_id: x\n---\n\n# t\n\n**User:**\n\n{first}\n\n**Assistant:**\n\n{PROSE}\n"
        )
    }

    fn write_session(root: &Path, name: &str, first: &str) {
        let path = root.join("sessions/2026-08").join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, session_doc(first)).unwrap();
        set_mtime(&path, old_mtime());
    }

    fn sidecar_reason(root: &Path, stem: &str) -> String {
        let raw =
            std::fs::read_to_string(root.join(format!("_inbox/quarantine/{stem}.verdict.json")))
                .unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["vector"].as_array().unwrap().len(), 0, "never embedded");
        v["reason"].as_str().unwrap().to_string()
    }

    #[test]
    fn machine_sessions_are_quarantined_before_embedding_and_outside_the_budget() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_session(
            root,
            "myco.md",
            "You are planning how to ingest a new source into an existing wiki. Plan it.",
        );
        write_session(root, "hello.md", "User: hello\n\nAssistant:");
        write_session(
            root,
            "empty.md",
            "<environment_context>\n<cwd>/tmp</cwd>\n</environment_context>",
        );
        write_session(
            root,
            "work1.md",
            "Why does the sidebar flicker when a folder collapses?",
        );
        write_session(
            root,
            "work2.md",
            "Add a keyboard shortcut for the search box.",
        );

        let o = tiny_ontology();
        let cfg = DistillConfig::default();
        let seen = std::cell::RefCell::new(Vec::<String>::new());
        let embed = |texts: Vec<String>| -> Result<Vec<Vec<f32>>, String> {
            seen.borrow_mut().extend(texts.iter().cloned());
            Ok(texts.iter().map(|_| vec![1.0, 0.0]).collect())
        };
        let mut manifest = test_manifest();
        // Budget 1: the three machine sessions still go in this one run.
        let out = scan(root, &o, &cfg, 1, &embed, &[], &mut manifest).unwrap();
        assert_eq!(out.quarantined, 3);
        assert_eq!(
            out.scored, 4,
            "three machine sessions + one within the budget"
        );
        for (stem, kind) in [("myco", "myco"), ("hello", "hello"), ("empty", "empty")] {
            assert!(!root.join(format!("sessions/2026-08/{stem}.md")).exists());
            assert_eq!(sidecar_reason(root, stem), format!("machine:{kind}"));
        }
        let seen = seen.borrow();
        assert_eq!(
            seen.len(),
            1,
            "only the budgeted person's session is embedded"
        );
        assert!(seen[0].contains("sidebar flicker"));
        let state = state_load(root, &o.model);
        assert!(state.scored.contains_key("sessions/2026-08/work1.md"));
        assert!(
            !state.scored.contains_key("sessions/2026-08/work2.md"),
            "waits for a later run"
        );
    }

    #[test]
    fn a_long_first_turn_in_three_sessions_is_an_agent_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let task = "You just finished task t1. Summarise the transcript below in six bullets for the orchestrator. ".repeat(3);
        assert!(task.chars().count() >= crate::machine_session::REPEAT_MIN_CHARS);
        write_session(root, "a1.md", &task);
        write_session(root, "a2.md", &task);
        // Short openers repeat in real work and never count.
        for n in ["c1.md", "c2.md", "c3.md"] {
            write_session(root, n, "continue");
        }

        let o = tiny_ontology();
        let cfg = DistillConfig::default();
        let embed = |texts: Vec<String>| -> Result<Vec<Vec<f32>>, String> {
            Ok(texts.iter().map(|_| vec![1.0, 0.0]).collect())
        };
        let mut manifest = test_manifest();
        let out = scan(root, &o, &cfg, 10, &embed, &[], &mut manifest).unwrap();
        assert_eq!(out.quarantined, 0, "two copies are not a pattern yet");

        // The third copy makes it one: all three go, the two already scored
        // ones without being re-read or re-embedded.
        write_session(root, "a3.md", &task);
        let out = scan(root, &o, &cfg, 10, &embed, &[], &mut manifest).unwrap();
        assert_eq!(out.quarantined, 3);
        for stem in ["a1", "a2", "a3"] {
            assert_eq!(sidecar_reason(root, stem), "machine:agent");
        }
        for n in ["c1.md", "c2.md", "c3.md"] {
            assert!(root.join("sessions/2026-08").join(n).exists());
        }

        // A later copy is still known once the others sit in quarantine.
        write_session(root, "a4.md", &task);
        let out = scan(root, &o, &cfg, 10, &embed, &[], &mut manifest).unwrap();
        assert_eq!(out.quarantined, 1);
        assert_eq!(sidecar_reason(root, "a4"), "machine:agent");
    }

    #[test]
    fn agent_sessions_leave_the_whole_budget_to_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let task = "You just finished task t1. Summarise the transcript below in six bullets for the orchestrator. ".repeat(3);
        // Oldest first by name at equal mtimes: the three copies come first.
        for n in ["a1.md", "a2.md", "a3.md"] {
            write_session(root, n, &task);
        }
        write_session(
            root,
            "w.md",
            "Why does the sidebar flicker when a folder collapses?",
        );

        let o = tiny_ontology();
        let cfg = DistillConfig::default();
        let embedded = std::cell::Cell::new(0usize);
        let embed = |texts: Vec<String>| -> Result<Vec<Vec<f32>>, String> {
            embedded.set(embedded.get() + texts.len());
            Ok(texts.iter().map(|_| vec![1.0, 0.0]).collect())
        };
        let mut manifest = test_manifest();
        let out = scan(root, &o, &cfg, 1, &embed, &[], &mut manifest).unwrap();
        assert_eq!(out.quarantined, 3);
        assert_eq!(
            embedded.get(),
            1,
            "the person's session still gets the one slot"
        );
        assert!(state_load(root, &o.model)
            .scored
            .contains_key("sessions/2026-08/w.md"));
    }

    #[test]
    fn similarity_never_quarantines_a_session() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_session(
            root,
            "work.md",
            "Why does the sidebar flicker when a folder collapses?",
        );
        std::fs::create_dir_all(root.join("_inbox")).unwrap();
        std::fs::write(root.join("_inbox/c.md"), PROSE).unwrap();
        set_mtime(&root.join("_inbox/c.md"), old_mtime());

        let o = tiny_ontology();
        let cfg = DistillConfig::default();
        let borderline = vec![0.2_f32, (1.0 - 0.2_f32 * 0.2_f32).sqrt()]; // -> Quarantine band
        let embed = move |texts: Vec<String>| -> Result<Vec<Vec<f32>>, String> {
            Ok(texts.iter().map(|_| borderline.clone()).collect())
        };
        let mut manifest = test_manifest();
        let out = scan(root, &o, &cfg, 10, &embed, &[], &mut manifest).unwrap();
        assert_eq!((out.quarantined, out.rejected), (1, 1));
        assert!(
            root.join("sessions/2026-08/work.md").exists(),
            "a session stays put"
        );
        assert!(
            root.join("_inbox/quarantine/c.md").exists(),
            "other inflow still can go"
        );
        let state = state_load(root, &o.model);
        assert_eq!(state.scored["sessions/2026-08/work.md"].tier, "reject");
    }

    #[test]
    fn sessions_scored_under_older_rules_are_checked_again() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let myco = session_doc("You are reviewing a personal knowledge wiki (markdown files in the current directory). Go.");
        let work = session_doc("Why does the sidebar flicker when a folder collapses?");
        write_session(root, "myco.md", "You are reviewing a personal knowledge wiki (markdown files in the current directory). Go.");
        write_session(
            root,
            "work.md",
            "Why does the sidebar flicker when a folder collapses?",
        );
        std::fs::create_dir_all(root.join("_inbox")).unwrap();
        std::fs::write(root.join("_inbox/a.md"), PROSE).unwrap();
        set_mtime(&root.join("_inbox/a.md"), old_mtime());
        let o = tiny_ontology();
        // A ledger from before the machine check: no rule version anywhere.
        let signature = admission::capture(root, &o, &DistillConfig::default())
            .unwrap()
            .signature;
        let entry = |c: &str, tier: &str| serde_json::json!({ "hash": crate::embeddings::content_hash(c), "tier": tier, "at": 1, "embedding": o.embedding, "source_sha256": admission::sha256(c.as_bytes()), "decision_signature": signature });
        let legacy = serde_json::json!({
            "model": o.model,
            "embedding": o.embedding,
            "decision_signature": signature,
            "scored": {
                "sessions/2026-08/myco.md": entry(&myco, "summary"),
                "sessions/2026-08/work.md": entry(&work, "summary"),
                "_inbox/a.md": entry(PROSE, "full"),
            }
        });
        std::fs::create_dir_all(state_path(root).parent().unwrap()).unwrap();
        std::fs::write(state_path(root), legacy.to_string()).unwrap();
        assert_eq!(
            backlog_count(root, &state_load(root, &o.model)),
            2,
            "the two sessions wait for the new rules; the inbox item does not"
        );

        let cfg = DistillConfig::default();
        let embed = |_: Vec<String>| -> Result<Vec<Vec<f32>>, String> {
            panic!("a re-check is not a re-embedding")
        };
        let mut manifest = test_manifest();
        let out = scan(root, &o, &cfg, 10, &embed, &[], &mut manifest).unwrap();
        assert_eq!(out.quarantined, 1);
        assert_eq!(sidecar_reason(root, "myco"), "machine:myco");
        let state = state_load(root, &o.model);
        let kept = &state.scored["sessions/2026-08/work.md"];
        assert_eq!((kept.tier.as_str(), kept.rules), ("summary", GATE_RULES));
        assert_eq!(state.scored["_inbox/a.md"].tier, "full");
        assert_eq!(
            backlog_count(root, &state),
            1,
            "only the quarantined item is left"
        );
    }

    /// Critical 2 fix: `scan`'s quarantine move used to be undo-blind (the
    /// manifest didn't exist yet when `scan` ran inside `run`). Proves the
    /// move AND the sidecar creation both land in the manifest `scan` is
    /// handed, and that `undo` reverses both — the file returns to its
    /// origin, the quarantine copy and sidecar are gone.
    #[test]
    fn undo_preserves_unsigned_quarantine_move_and_sidecar() {
        assert!(PROSE.len() >= JUNK_MIN_BYTES);
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("_inbox")).unwrap();
        std::fs::write(root.join("_inbox/c.md"), PROSE).unwrap();
        set_mtime(&root.join("_inbox/c.md"), old_mtime());

        let o = tiny_ontology();
        let cfg = DistillConfig::default();
        let borderline = vec![0.2_f32, (1.0 - 0.2_f32 * 0.2_f32).sqrt()]; // -> Quarantine
        let embed = move |texts: Vec<String>| -> Result<Vec<Vec<f32>>, String> {
            Ok(texts.iter().map(|_| borderline.clone()).collect())
        };

        let mut manifest = test_manifest();
        manifest.id = "digest-123".into();
        let out = scan(root, &o, &cfg, 10, &embed, &[], &mut manifest).unwrap();
        assert_eq!(out.quarantined, 1);
        assert_eq!(manifest.moves.len(), 1, "quarantine move must be recorded");
        assert_eq!(
            manifest.created.len(),
            1,
            "verdict sidecar creation must be recorded"
        );
        assert!(root.join("_inbox/quarantine/c.md").exists());
        assert!(root.join("_inbox/quarantine/c.verdict.json").exists());

        let reversed = undo(root, &manifest.id).unwrap();
        assert_eq!(reversed, 0, "unsigned history requires manual recovery");
        assert!(
            !root.join("_inbox/c.md").exists(),
            "unsigned history must not infer ownership from its timestamp"
        );
        assert!(root.join("_inbox/quarantine/c.md").exists());
        assert!(root.join("_inbox/quarantine/c.verdict.json").exists());
    }

    #[test]
    fn ledger_compacts_away_entries_for_files_that_no_longer_exist() {
        // The ledger must stay O(current inflow), not O(everything ever
        // seen) — a moved (quarantined) or outright-deleted file's entry must
        // not linger forever (see `compact_ledger`).
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("_inbox")).unwrap();

        let full_text = format!("{PROSE} FULL marker so this note lands the full tier.");
        let quarantine_text =
            format!("{PROSE} BORDERLINE marker so this note lands the quarantine tier.");
        let reject_text = format!("{PROSE} FAR marker so this note lands the reject tier.");
        std::fs::write(root.join("_inbox/keep.md"), &full_text).unwrap();
        std::fs::write(root.join("_inbox/quar.md"), &quarantine_text).unwrap();
        std::fs::write(root.join("_inbox/gone.md"), &reject_text).unwrap();
        for name in ["keep.md", "quar.md", "gone.md"] {
            set_mtime(&root.join(format!("_inbox/{name}")), old_mtime());
        }

        let o = tiny_ontology();
        let cfg = DistillConfig::default();
        let embed = |texts: Vec<String>| -> Result<Vec<Vec<f32>>, String> {
            Ok(texts
                .iter()
                .map(|t| {
                    if t.contains("BORDERLINE") {
                        vec![0.2_f32, (1.0 - 0.2_f32 * 0.2_f32).sqrt()] // -> Quarantine
                    } else if t.contains("FAR") {
                        vec![0.0_f32, 1.0_f32] // orthogonal -> Reject
                    } else {
                        vec![1.0_f32, 0.0_f32] // matches centroid -> Full
                    }
                })
                .collect())
        };

        let mut manifest = test_manifest();
        let out = scan(root, &o, &cfg, 10, &embed, &[], &mut manifest).unwrap();
        assert_eq!(out.full, 1);
        assert_eq!(out.quarantined, 1);
        assert_eq!(out.rejected, 1);

        // quar.md moved away this same run — its pre-move key must already be
        // gone, not kept as a dead permanent record.
        let state = state_load(root, &o.model);
        assert!(!state.scored.contains_key("_inbox/quar.md"));
        assert!(state.scored.contains_key("_inbox/keep.md"));
        assert!(state.scored.contains_key("_inbox/gone.md"));
        assert!(state.rejected_ttl.contains_key("_inbox/gone.md"));

        // Delete a file outright (no gate involved) and rescan: its ledger
        // entries must be pruned too.
        std::fs::remove_file(root.join("_inbox/gone.md")).unwrap();
        let out2 = scan(root, &o, &cfg, 10, &embed, &[], &mut manifest).unwrap();
        assert_eq!(
            out2.scored, 0,
            "keep.md is unchanged; gone.md no longer exists to walk"
        );

        let state2 = state_load(root, &o.model);
        assert!(!state2.scored.contains_key("_inbox/gone.md"));
        assert!(!state2.rejected_ttl.contains_key("_inbox/gone.md"));
        assert!(
            state2.scored.contains_key("_inbox/keep.md"),
            "still on disk, its entry must remain"
        );
    }

    #[test]
    fn config_roundtrips_and_defaults() {
        let d = tempfile::tempdir().unwrap();
        let c = config_load(d.path()); // no file yet -> defaults
        assert!(c.enabled);
        assert_eq!(c.count_trigger, 50);
        assert_eq!(c.intensity, Intensity::Standard);
        assert_eq!(c.gate_preset, GatePreset::Normal);
        assert_eq!(c.quarantine_ttl_days, 30);
        assert_eq!(c.run_budget_items, 50);
        assert_eq!(c.idle_minutes, 10);
        assert_eq!(c.maturation_hours, 24);
        assert!(!c.dormancy_decay);
        let mut c2 = c.clone();
        c2.count_trigger = 10;
        config_save(d.path(), &c2).unwrap();
        assert_eq!(config_load(d.path()).count_trigger, 10);
    }

    // -----------------------------------------------------------------------
    // Task 6: run orchestrator. `run`/`status` reach `VectorStore::path_for`
    // (via `settings::settings_dir`), which refuses to resolve the real
    // app-data dir under `cfg(test)` — every test below must run inside
    // `with_isolated_data` or it fails on that refusal, not on the logic
    // under test.
    // -----------------------------------------------------------------------

    /// Controlled two-dimensional unit output for synthetic runner fixtures.
    fn dummy_embed(texts: Vec<String>) -> Result<Vec<Vec<f32>>, String> {
        Ok(texts.iter().map(|_| vec![1.0, 0.0]).collect())
    }

    /// Two clusters far enough apart (orthogonal centroids, plus a 3rd
    /// dimension so neither competes for the other's similarity) that a
    /// synthetic embed can land Tier::Summary against cluster 0 without
    /// cluster 1 stealing "nearest" — same threshold shape as
    /// `tiny_ontology`, just with model `""` so `run()`'s own staleness check
    /// (`ontology::load(root, &store.model)`) reuses it rather than
    /// rebuilding from the empty `VectorStore` an isolated-data test root has.
    fn ontology_two_clusters() -> Ontology {
        let cluster = |id: u32, label: &str, centroid: Vec<f32>| crate::ontology::Cluster {
            id,
            label: label.into(),
            members: vec![format!("wiki/seed-{id}.md")],
            centroid,
            sim_mean: 0.9,
            sim_std: 0.05,
            p5: 0.10,
            p25: 0.50,
            p40: 0.90,
            last_touched: 0,
            override_widen: 0.0,
        };
        Ontology {
            model: "test-model".into(),
            embedding: Some(synthetic_space(3)),
            source_signature: "synthetic-ontology-inputs".into(),
            built_at: 0,
            wiki_pages: GATE_MIN_WIKI_PAGES,
            clusters: vec![
                cluster(0, "topic-a", vec![1.0, 0.0, 0.0]),
                cluster(1, "topic-b", vec![0.0, 1.0, 0.0]),
            ],
            entities: Vec::new(),
        }
    }

    /// Owner decision 2026-10-03 (B1): no run, manual or automatic, moves,
    /// adds or changes anything under `raw/` — no archive pass for a raw
    /// file that has a `source-` page, no summary-tier move into
    /// `raw/archive/`, no quarantine move out of `raw/` — while the passes
    /// outside `raw/` (here the quarantine TTL sweep) still run.
    #[test]
    fn a_run_keeps_raw_byte_identical_and_still_sweeps_the_rest() {
        fn raw_snapshot(root: &Path) -> Vec<(String, Vec<u8>)> {
            fn walk(dir: &Path, root: &Path, out: &mut Vec<(String, Vec<u8>)>) {
                for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
                    let path = e.path();
                    if path.is_dir() {
                        walk(&path, root, out);
                    } else {
                        let rel = rel_string(root, &path);
                        out.push((rel, std::fs::read(&path).unwrap()));
                    }
                }
            }
            let mut out = Vec::new();
            walk(&root.join("raw"), root, &mut out);
            out.sort();
            out
        }
        // cosine 0.2 to cluster 0: between its p5 (0.10) and t_summary
        // (0.30), so the "Q:" item quarantines; everything else is Summary.
        let embed = |texts: Vec<String>| -> Result<Vec<Vec<f32>>, String> {
            Ok(texts
                .iter()
                .map(|t| {
                    let c = if t.starts_with("Q:") { 0.2_f32 } else { 0.4 };
                    vec![c, 0.0, (1.0 - c * c).sqrt()]
                })
                .collect())
        };

        crate::settings::test_support::with_isolated_data("distill-keeps-raw", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            // 49 seeds + source-x.md = the ontology's 50, so run()
            // keeps the saved two-cluster ontology instead of
            // rebuilding an empty one.
            seed_wiki_pages(root, GATE_MIN_WIKI_PAGES - 1);
            std::fs::write(root.join("wiki/source-x.md"), "a source summary page").unwrap();
            save_synthetic_ontology(root, ontology_two_clusters());
            std::fs::create_dir_all(root.join("raw")).unwrap();
            std::fs::create_dir_all(root.join("_inbox/quarantine")).unwrap();
            for (rel, body) in [
                ("raw/x.md", PROSE.to_string()),
                ("raw/y.md", PROSE.to_string()),
                ("raw/q.md", format!("Q: {PROSE}")),
                ("_inbox/note.md", PROSE.to_string()),
            ] {
                std::fs::write(root.join(rel), body).unwrap();
                set_mtime(&root.join(rel), old_mtime());
            }
            std::fs::write(root.join("_inbox/quarantine/old.md"), PROSE).unwrap();
            let expired = serde_json::json!({
                "tier": "quarantine",
                "s_knn": 0.2,
                "nearest_cluster": "topic-a",
                "reason": "test",
                "expires": now_secs() - 1000,
                "vector": [0.2, 0.0, 0.0],
                "from": "_inbox/old.md",
                "source_sha256": admission::sha256(PROSE.as_bytes()),
            });
            std::fs::write(
                root.join("_inbox/quarantine/old.verdict.json"),
                expired.to_string(),
            )
            .unwrap();
            let before = raw_snapshot(root);

            let cfg = DistillConfig::default(); // Standard intensity
            let report = run(root, &cfg, &embed).unwrap();
            assert_eq!(report.trashed, 1, "the TTL sweep still runs");
            assert_eq!(raw_snapshot(root), before, "raw/ must be byte-identical");
            assert!(!root.join("raw/archive").exists());
            assert_eq!(report.scan.quarantined, 0);
            assert_eq!(report.scan.scored, 1, "only _inbox/note.md is scored");
            assert!(
                root.join("_inbox/note.md").exists(),
                "a summary-tier item has nowhere to go but raw/archive/, so it stays"
            );
        });
    }

    #[test]
    fn read_profile_interests_scans_only_the_interests_bullets() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(
            root.join("profile.md"),
            "<!-- header comment -->\n\n\
             ## Role\n- not an interest\n\n\
             ## Interests\n- rust\n* async runtimes\n\nnot a bullet\n\n\
             ## Working style\n- concise\n",
        )
        .unwrap();
        assert_eq!(
            read_profile_interests(root),
            vec!["rust".to_string(), "async runtimes".to_string()]
        );
    }

    #[test]
    fn read_profile_interests_is_empty_without_a_profile_file() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_profile_interests(dir.path()).is_empty());
    }

    #[test]
    fn profile_embed_failure_degrades_instead_of_failing_the_run() {
        crate::settings::test_support::with_isolated_data("distill-profile-embed-fail", |_data| {
            assert!(PROSE.len() >= JUNK_MIN_BYTES);
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            seed_wiki_pages(root, GATE_MIN_WIKI_PAGES);
            std::fs::create_dir_all(root.join("_inbox")).unwrap();
            std::fs::write(root.join("_inbox/note.md"), PROSE).unwrap();
            set_mtime(&root.join("_inbox/note.md"), old_mtime());
            std::fs::write(root.join("profile.md"), "## Interests\n- widgets\n").unwrap();
            save_synthetic_ontology(root, ontology_two_clusters());

            let cfg = DistillConfig::default();
            // Errors ONLY on the profile-interests batch (`["widgets"]`); the
            // per-item batch below still succeeds, orthogonal to both cluster
            // centroids (Reject, same as `admit_tiers_follow_the_decision_
            // tree`'s Reject case) — so a lift (had one wrongly happened
            // despite the embed failure) would flip this to Summary and the
            // assertion below would catch it.
            let embed = |texts: Vec<String>| -> Result<Vec<Vec<f32>>, String> {
                if texts == vec!["widgets".to_string()] {
                    return Err("embed provider down".into());
                }
                Ok(texts.iter().map(|_| vec![0.0_f32, 0.0, 1.0]).collect())
            };

            let report = run(root, &cfg, &embed).unwrap(); // does not fail the run
            assert_eq!(
                report.scan.rejected, 1,
                "no lift applied: item stayed Reject, same as no profile.md at all"
            );
            assert_eq!(report.scan.summaries, 0);
        });
    }

    /// Crash-retry idempotency for the summary tier: run once (append + move
    /// done), then recreate the retry state a crash between the two leaves —
    /// the daily line already written, the file still in `_inbox/` — and run
    /// again. The line must not duplicate, and the move must still complete.

    #[test]
    fn session_day_prefers_frontmatter_created_over_mtime() {
        let dir = tempfile::tempdir().unwrap();
        // A stem with no date run (the real shape: `claude-code-<uuid>`) and a
        // mtime far from the conversation's actual `created` time — e.g. a
        // long-running session the sweep only wrote after it ended.
        let path = dir.path().join("claude-code-abc123.md");
        std::fs::write(
            &path,
            "---\nsource: claude-code\ncreated: 1755000000\n---\n\nbody\n",
        )
        .unwrap();
        // 1755000000 = 2025-08-12T12:00:00Z; mtime is a different day entirely.
        let mtime = 1_760_000_000; // 2025-10-09
        assert_eq!(
            session_day("claude-code-abc123", &path, mtime),
            "2025-08-12"
        );
    }

    #[test]
    fn session_day_falls_back_to_mtime_when_frontmatter_is_missing_or_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let mtime = 1_755_000_000; // 2025-08-12
        let (y, m, d, ..) = civil_datetime(mtime);
        let want = format!("{y:04}-{m:02}-{d:02}");

        let no_frontmatter = dir.path().join("codex-a.md");
        std::fs::write(&no_frontmatter, "just a body, no frontmatter\n").unwrap();
        assert_eq!(session_day("codex-a", &no_frontmatter, mtime), want);

        let bad_created = dir.path().join("codex-b.md");
        std::fs::write(&bad_created, "---\ncreated: not-a-number\n---\n\nbody\n").unwrap();
        assert_eq!(session_day("codex-b", &bad_created, mtime), want);

        let missing_file = dir.path().join("codex-c.md");
        assert_eq!(session_day("codex-c", &missing_file, mtime), want);
    }

    #[test]
    fn session_day_still_honors_a_date_already_in_the_stem() {
        // A stem-embedded date is used when the doc carries no `created:` of
        // its own — but it no longer outranks one that does.
        let dir = tempfile::tempdir().unwrap();
        let bare = dir.path().join("20260810-x.md");
        std::fs::write(&bare, "no frontmatter here\n").unwrap();
        // mtime is later than the stem date, so the stem date stays plausible.
        assert_eq!(
            session_day("20260810-x", &bare, 1_786_800_000),
            "2026-08-10"
        );

        let with_created = dir.path().join("20260810-y.md");
        std::fs::write(&with_created, "---\ncreated: 1755000000\n---\n\nbody\n").unwrap();
        assert_eq!(session_day("20260810-y", &with_created, 0), "2025-08-12");
    }

    #[test]
    fn session_day_ignores_a_uuid_group_that_merely_looks_like_a_date() {
        // Real vault regression: `claude-code-20970910-3580-4fb0-…` filed its
        // digest under `daily/2097-09-10.md`, because the UUID's first group is
        // eight digits that parse as a plausible date. A date after the file's
        // own mtime can never be the conversation's date.
        let dir = tempfile::tempdir().unwrap();
        let stem = "claude-code-20970910-3580-4fb0-b7b9-79179a73be43";
        let mtime = 1_786_800_000; // 2026-08-15

        let bare = dir.path().join(format!("{stem}.md"));
        std::fs::write(&bare, "no frontmatter\n").unwrap();
        assert_eq!(session_day(stem, &bare, mtime), "2026-08-15");

        let with_created = dir.path().join(format!("{stem}-b.md"));
        std::fs::write(&with_created, "---\ncreated: 1755000000\n---\n\nx\n").unwrap();
        assert_eq!(session_day(stem, &with_created, mtime), "2025-08-12");
    }

    #[test]
    fn digestable_days_group_scored_mature_sessions() {
        crate::settings::test_support::with_isolated_data("distill-digestable-days", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            std::fs::create_dir_all(root.join("sessions/2026-08")).unwrap();
            let files = ["20260810-a.md", "20260810-b.md", "20260812-c.md"];
            for f in files {
                std::fs::write(root.join(format!("sessions/2026-08/{f}")), PROSE).unwrap();
                set_mtime(&root.join(format!("sessions/2026-08/{f}")), old_mtime());
            }

            // a.md and b.md are already scored; c.md never was.
            seed_semantic_store(root, 2);
            let mut state = DistillState {
                model: "test-model".into(),
                embedding: Some(synthetic_space(2)),
                ..Default::default()
            };
            for f in [
                "sessions/2026-08/20260810-a.md",
                "sessions/2026-08/20260810-b.md",
            ] {
                state.scored.insert(
                    f.to_string(),
                    ScoredEntry {
                        hash: 0,
                        tier: "summary".into(),
                        at: now_secs(),
                        mtime: 0,
                        len: 0,
                        rules: GATE_RULES,
                        turn: None,
                        embedding: Some(synthetic_space(2)),
                        nonsemantic: None,
                        source_sha256: Some(source_digest_for_test(root, f)),
                        decision_signature: Some(decision_signature_for_test(root)),
                    },
                );
            }
            state_save(root, &state).unwrap();

            let days = digestable_session_days(root).unwrap();
            assert_eq!(days.len(), 1);
            assert_eq!(days[0].day, "2026-08-10");
            assert_eq!(
                days[0].files,
                vec![
                    "sessions/2026-08/20260810-a.md".to_string(),
                    "sessions/2026-08/20260810-b.md".to_string(),
                ]
            );
        });
    }

    #[test]
    fn digestable_days_withholds_a_day_until_every_walked_file_is_scored() {
        crate::settings::test_support::with_isolated_data(
            "distill-digestable-partial-day",
            |_data| {
                let dir = tempfile::tempdir().unwrap();
                let root = dir.path();
                std::fs::create_dir_all(root.join("sessions/2026-08")).unwrap();
                let files = ["20260810-a.md", "20260810-b.md", "20260810-c.md"];
                for f in files {
                    std::fs::write(root.join(format!("sessions/2026-08/{f}")), PROSE).unwrap();
                    set_mtime(&root.join(format!("sessions/2026-08/{f}")), old_mtime());
                }

                // a.md and b.md are scored; c.md is not — the day must not
                // qualify at all, not appear with a partial (a, b) file list.
                seed_semantic_store(root, 2);
                let mut state = DistillState {
                    model: "test-model".into(),
                    embedding: Some(synthetic_space(2)),
                    ..Default::default()
                };
                for f in [
                    "sessions/2026-08/20260810-a.md",
                    "sessions/2026-08/20260810-b.md",
                ] {
                    state.scored.insert(
                        f.to_string(),
                        ScoredEntry {
                            hash: 0,
                            tier: "summary".into(),
                            at: now_secs(),
                            mtime: 0,
                            len: 0,
                            rules: GATE_RULES,
                            turn: None,
                            embedding: Some(synthetic_space(2)),
                            nonsemantic: None,
                            source_sha256: Some(source_digest_for_test(root, f)),
                            decision_signature: Some(decision_signature_for_test(root)),
                        },
                    );
                }
                state_save(root, &state).unwrap();
                assert!(
                    digestable_session_days(root).unwrap().is_empty(),
                    "a day with any unscored file must not be offered, even partially"
                );

                // Once c.md is scored too, the day qualifies with all three files.
                state.scored.insert(
                    "sessions/2026-08/20260810-c.md".to_string(),
                    ScoredEntry {
                        hash: 0,
                        tier: "summary".into(),
                        at: now_secs(),
                        mtime: 0,
                        len: 0,
                        rules: GATE_RULES,
                        turn: None,
                        embedding: Some(synthetic_space(2)),
                        nonsemantic: None,
                        source_sha256: Some(source_digest_for_test(
                            root,
                            "sessions/2026-08/20260810-c.md",
                        )),
                        decision_signature: Some(decision_signature_for_test(root)),
                    },
                );
                state_save(root, &state).unwrap();
                let days = digestable_session_days(root).unwrap();
                assert_eq!(days.len(), 1);
                assert_eq!(
                    days[0].files,
                    vec![
                        "sessions/2026-08/20260810-a.md".to_string(),
                        "sessions/2026-08/20260810-b.md".to_string(),
                        "sessions/2026-08/20260810-c.md".to_string(),
                    ]
                );
            },
        );
    }

    /// Writes `sessions/2026-08/<name>` with `body`, matured and scored, and
    /// returns its rel path — the shape `digestable_session_days` wants.
    fn scored_session(root: &Path, name: &str, body: &str) -> String {
        let rel = format!("sessions/2026-08/{name}");
        let path = root.join(&rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, body).unwrap();
        set_mtime(&path, old_mtime());

        seed_semantic_store(root, 2);
        let space = synthetic_space(2);
        let mut state = state_for_space(root, Some(&space), &space.model).unwrap();
        state.scored.insert(
            rel.clone(),
            ScoredEntry {
                hash: 0,
                tier: "summary".into(),
                at: now_secs(),
                mtime: 0,
                len: 0,
                rules: GATE_RULES,
                turn: None,
                embedding: Some(synthetic_space(2)),
                nonsemantic: None,
                source_sha256: Some(source_digest_for_test(root, &rel)),
                decision_signature: Some(decision_signature_for_test(root)),
            },
        );
        state_save(root, &state).unwrap();
        rel
    }

    /// The fingerprint `runSessionDigest` would hand `archive_digested_sessions`
    /// for the session file currently on disk at `rel`.
    fn file_fingerprint(root: &Path, rel: &str) -> String {
        content_fingerprint(&std::fs::read(root.join(rel)).unwrap())
    }

    /// The `<stem>:<fingerprint>` marker entry `appendDigest` would record for
    /// a session file that is currently on disk at `rel`.
    fn marker_entry(root: &Path, rel: &str) -> String {
        let path = root.join(rel);
        let stem = path.file_stem().unwrap().to_str().unwrap();
        format!("{stem}:{}", file_fingerprint(root, rel))
    }

    /// The marker line `appendDigest` (src/lib/sessionDigest.ts) writes into
    /// `daily/<day>.md` in the same write as its bullets. Entries are
    /// `<stem>:<fingerprint>` (see `marker_entry`); a bare `<stem>` is the
    /// legacy pre-fingerprint format, which must keep matching.
    fn write_daily_with_marker(root: &Path, day: &str, stems: &[&str]) {
        std::fs::create_dir_all(root.join("daily")).unwrap();
        std::fs::write(
            root.join(format!("daily/{day}.md")),
            format!(
                "# {day}\n\n## Session digest (auto)\n{}{} {}\n- decided a thing\n",
                DIGEST_MARKER_OPEN,
                stems.join(" "),
                DIGEST_MARKER_CLOSE,
            ),
        )
        .unwrap();
    }

    /// Cross-language parity vectors: `fingerprint` in
    /// src/lib/sessionDigest.ts writes the markers this side reads, so the two
    /// FNV-1a implementations must agree byte for byte. Its own test asserts
    /// the same two strings hash to the same hex.
    #[test]
    fn content_fingerprint_matches_the_typescript_implementation() {
        assert_eq!(content_fingerprint(b"myco"), "b73bd5ad");
        assert_eq!(content_fingerprint("한글 세션".as_bytes()), "723f3e42");
        assert_eq!(content_fingerprint(b""), "811c9dc5");
    }

    #[test]
    fn digested_session_stems_reads_markers_and_ignores_everything_else() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert!(
            digested_session_entries(root).is_empty(),
            "no daily/ dir at all is empty, not an error"
        );

        std::fs::create_dir_all(root.join("daily")).unwrap();
        write_daily_with_marker(root, "2026-08-10", &["claude-code-a", "claude-code-b"]);
        // A second section in the same file (the late-arrival case) adds to it.
        let p = root.join("daily/2026-08-10.md");
        let mut text = std::fs::read_to_string(&p).unwrap();
        text.push_str(&format!(
            "\n_run of later_\n{}claude-code-c {}\n- another thing\n",
            DIGEST_MARKER_OPEN, DIGEST_MARKER_CLOSE
        ));
        std::fs::write(&p, text).unwrap();
        // Prose that merely mentions the marker's words, a different day's
        // file, and a non-markdown file must not confuse it.
        std::fs::write(
            root.join("daily/2026-08-11.md"),
            "# notes\nmyco:digested-sessions claude-code-NOPE\n<!-- unrelated comment -->\n",
        )
        .unwrap();
        std::fs::write(root.join("daily/notes.txt"), "claude-code-NOPE").unwrap();

        let stems = digested_session_entries(root);
        assert_eq!(stems.len(), 3, "{stems:?}");
        for s in ["claude-code-a", "claude-code-b", "claude-code-c"] {
            assert!(stems.contains(s), "missing {s} in {stems:?}");
        }
        assert!(!stems.contains("claude-code-NOPE"));
    }

    #[test]
    fn digestable_days_routes_already_recorded_files_to_archive_retry() {
        crate::settings::test_support::with_isolated_data("distill-digest-idempotent", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            let files: Vec<String> = ["20260810-a.md", "20260810-b.md"]
                .iter()
                .map(|f| scored_session(root, f, PROSE))
                .collect();

            let days = digestable_session_days(root).unwrap();
            assert_eq!(days.len(), 1);
            assert!(!days[0].already_digested, "nothing recorded yet");

            // The digest landed (marker + bullets, one write) but the archive
            // that follows it failed — the files are still in sessions/.
            let entries: Vec<String> = files.iter().map(|f| marker_entry(root, f)).collect();
            write_daily_with_marker(
                root,
                "2026-08-10",
                &entries.iter().map(String::as_str).collect::<Vec<_>>(),
            );

            // Defect C fix: the day must still be OFFERED (its files are
            // un-archived) but FLAGGED, so the caller retries only the archive
            // step and never pays for a second LLM digest.
            let days = digestable_session_days(root).unwrap();
            assert_eq!(days.len(), 1);
            assert!(days[0].already_digested);
            assert_eq!(days[0].files, files);

            // A failed archive attempt (a bad day string stands in for any
            // archive failure — see archive_digested_sessions's validation)
            // leaves the record where it is: in daily/, untouched.
            assert!(archive_digested_sessions(root, "not-a-day", &files, None).is_err());
            assert!(digestable_session_days(root).unwrap()[0].already_digested);

            // Once the archive succeeds the files leave sessions/ and the day
            // disappears — nothing left to retry.
            archive_digested_sessions(root, "2026-08-10", &files, None).unwrap();
            assert!(digestable_session_days(root).unwrap().is_empty());
        });
    }

    #[test]
    fn digestable_days_does_not_redigest_a_file_whose_derived_day_changed() {
        crate::settings::test_support::with_isolated_data("distill-digest-day-drift", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            // A stem with no date in it, so session_day derives the day —
            // from mtime while there is no frontmatter.
            let rel = scored_session(root, "claude-code-abc.md", PROSE);
            let day_one = digestable_session_days(root).unwrap()[0].day.clone();
            write_daily_with_marker(root, &day_one, &[&marker_entry(root, &rel)]);

            // Now the same UNCHANGED file derives a DIFFERENT day (a touch, a
            // sync, a restore — session_day falls back to mtime here). A
            // day-keyed flag would miss and buy a second LLM digest for
            // content already summarized; the file-level marker still matches,
            // because the content it fingerprinted did not move.
            let path = root.join(&rel);
            set_mtime(
                &path,
                old_mtime() - std::time::Duration::from_secs(5 * 86_400),
            );

            let days = digestable_session_days(root).unwrap();
            assert_eq!(days.len(), 1);
            assert_ne!(days[0].day, day_one, "the derived day must have moved");
            assert!(
                days[0].already_digested,
                "idempotency is anchored on the FILE, not on the derived day"
            );
            assert_eq!(days[0].files, vec![rel]);
        });
    }

    #[test]
    fn digestable_days_offers_only_the_new_files_of_a_partly_recorded_day() {
        crate::settings::test_support::with_isolated_data("distill-digest-late-session", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            let old = scored_session(root, "20260810-a.md", PROSE);
            write_daily_with_marker(root, "2026-08-10", &[&marker_entry(root, &old)]);
            let new = scored_session(root, "20260810-b.md", PROSE);

            // A genuinely new session for an already-digested day is new
            // knowledge: it gets its own digest section, so the day comes back
            // unflagged with ONLY the new file.
            let days = digestable_session_days(root).unwrap();
            assert_eq!(days.len(), 1);
            assert!(!days[0].already_digested);
            assert_eq!(days[0].files, vec![new.clone()]);

            // Archiving that one leaves the earlier, already-recorded file —
            // which the next run picks up as a pure archive retry.
            let new_fp = file_fingerprint(root, &new);
            archive_digested_sessions(root, "2026-08-10", &[new], Some(&[new_fp])).unwrap();
            let days = digestable_session_days(root).unwrap();
            assert_eq!(days.len(), 1);
            assert!(days[0].already_digested);
            assert_eq!(days[0].files, vec![old]);
        });
    }

    /// A stem is the conversation id, not a version of it: the sweep re-imports
    /// a conversation the user kept talking in under the SAME stem (and the
    /// same `created:`), so a stem-only record archived the whole continuation
    /// without ever digesting it. The record is bound to the content instead.
    #[test]
    fn digestable_days_redigests_a_resumed_conversation_that_kept_its_stem() {
        crate::settings::test_support::with_isolated_data("distill-digest-resumed", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            // What the first import looked like when it was digested and
            // archived — its file is gone from sessions/, only its record left.
            let first = format!("---\ncreated: 1000000000\n---\n\n{PROSE}");
            let first_entry = format!("claude-code-abc:{}", content_fingerprint(first.as_bytes()));
            // The re-import: same stem, same `created:`, more turns.
            let rel = scored_session(
                root,
                "claude-code-abc.md",
                &format!("{first}\n\nand then we also decided the other thing.\n"),
            );
            let day = digestable_session_days(root).unwrap()[0].day.clone();
            write_daily_with_marker(root, &day, &[&first_entry]);

            let days = digestable_session_days(root).unwrap();
            assert_eq!(days.len(), 1);
            assert!(
                !days[0].already_digested,
                "the grown file is not the file that was digested"
            );
            assert_eq!(days[0].files, vec![rel.clone()]);

            // …and once THIS content is recorded, the day goes back to being a
            // pure archive retry — no second LLM call.
            write_daily_with_marker(root, &day, &[&first_entry, &marker_entry(root, &rel)]);
            let days = digestable_session_days(root).unwrap();
            assert!(days[0].already_digested);
            assert_eq!(days[0].files, vec![rel]);
        });
    }

    /// Markers written before fingerprints existed are bare stems. They must
    /// keep matching on the stem alone — otherwise the upgrade re-bills an LLM
    /// digest for every session already summarized.
    #[test]
    fn digestable_days_still_honours_a_legacy_bare_stem_marker() {
        crate::settings::test_support::with_isolated_data("distill-digest-legacy", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            let rel = scored_session(root, "claude-code-abc.md", PROSE);
            let day = digestable_session_days(root).unwrap()[0].day.clone();
            write_daily_with_marker(root, &day, &["claude-code-abc"]);

            let days = digestable_session_days(root).unwrap();
            assert_eq!(days.len(), 1);
            assert!(
                days[0].already_digested,
                "bare stem, no fingerprint to check"
            );
            assert_eq!(days[0].files, vec![rel.clone()]);

            // Even after the file changes: a legacy record can't say WHICH
            // content it covered, and re-billing every old session is worse
            // than missing one continuation on the last pre-upgrade day.
            let path = root.join(&rel);
            std::fs::write(&path, format!("{PROSE}\n\nresumed later.\n")).unwrap();
            set_mtime(&path, old_mtime());
            assert!(
                digestable_session_days(root).unwrap().is_empty(),
                "changed bytes need current admission before an archive retry"
            );
            scored_session(
                root,
                "claude-code-abc.md",
                &std::fs::read_to_string(&path).unwrap(),
            );
            assert!(digestable_session_days(root).unwrap()[0].already_digested);
        });
    }

    #[test]
    fn archive_digested_sessions_moves_and_is_undoable() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("sessions/2026-08")).unwrap();
        std::fs::write(root.join("sessions/2026-08/20260810-a.md"), PROSE).unwrap();
        std::fs::write(root.join("sessions/2026-08/20260810-b.md"), PROSE).unwrap();

        let files = vec![
            "sessions/2026-08/20260810-a.md".to_string(),
            "sessions/2026-08/20260810-b.md".to_string(),
        ];
        let fps: Vec<String> = files.iter().map(|f| file_fingerprint(root, f)).collect();
        let id = archive_digested_sessions(root, "2026-08-10", &files, Some(&fps))
            .unwrap()
            .manifest_id;

        for name in ["20260810-a.md", "20260810-b.md"] {
            assert!(root
                .join(format!("sessions/archive/2026-08/{name}"))
                .exists());
            assert!(!root.join(format!("sessions/2026-08/{name}")).exists());
        }

        let undone = undo(root, &id).unwrap();
        assert_eq!(undone, 2);
        for name in ["20260810-a.md", "20260810-b.md"] {
            assert!(root.join(format!("sessions/2026-08/{name}")).exists());
            assert!(!root
                .join(format!("sessions/archive/2026-08/{name}"))
                .exists());
        }

        // Untrusted path: outside sessions/ must be rejected outright.
        let bad = vec!["wiki/index.md".to_string()];
        assert!(archive_digested_sessions(root, "2026-08-10", &bad, None).is_err());

        // Untrusted day: right shape (10 chars, dashes at 4/7) but non-numeric
        // must be rejected too, not land a junk `sessions/archive/<day>/` dir.
        assert!(archive_digested_sessions(root, "abcd-ef-gh", &files, None).is_err());
        assert!(!root.join("sessions/archive/abcd-ef").exists());
    }

    /// The auto-collect sweep (src/lib/autoImport.ts) runs on its own timer and
    /// rewrites a resumed conversation's file in place. If that lands between
    /// the digest's read and this move, the new turns would be archived into a
    /// tree `walk_inflow` excludes forever — digested never, error never.
    #[test]
    fn archive_leaves_behind_a_session_rewritten_since_it_was_digested() {
        crate::settings::test_support::with_isolated_data("distill-digest-archive-race", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            let stable = scored_session(root, "claude-code-aaa.md", PROSE);
            let resumed = scored_session(root, "claude-code-bbb.md", PROSE);
            let day = digestable_session_days(root).unwrap()[0].day.clone();

            // What the caller digested, and what it recorded for it.
            let files = vec![stable.clone(), resumed.clone()];
            let fps: Vec<String> = files.iter().map(|f| file_fingerprint(root, f)).collect();
            let entries: Vec<String> = files.iter().map(|f| marker_entry(root, f)).collect();
            write_daily_with_marker(
                root,
                &day,
                &entries.iter().map(String::as_str).collect::<Vec<_>>(),
            );

            // …and then the sweep rewrites one of them, before the archive.
            let path = root.join(&resumed);
            std::fs::write(&path, format!("{PROSE}\n\nand then we resumed.\n")).unwrap();
            set_mtime(&path, old_mtime());

            let id = archive_digested_sessions(root, &day, &files, Some(&fps))
                .unwrap()
                .manifest_id;

            assert!(root
                .join("sessions/archive")
                .join(&day[..7])
                .join("claude-code-aaa.md")
                .exists());
            assert!(!root.join(&stable).exists());
            assert!(
                root.join(&resumed).exists(),
                "the rewritten file holds undigested turns — it must stay in sessions/"
            );
            let raw = std::fs::read_to_string(manifest_path(root, &id)).unwrap();
            let manifest: RunManifest = serde_json::from_str(&raw).unwrap();
            assert_eq!(manifest.moves.len(), 1, "{:?}", manifest.moves);
            assert!(!manifest.moves[0].from.contains("bbb"));

            // The next run sees it as new content: not digested, so offered
            // for a real digest rather than a bare archive retry.
            assert!(
                digestable_session_days(root).unwrap().is_empty(),
                "the changed source is withheld until rescored"
            );
            scored_session(
                root,
                "claude-code-bbb.md",
                &std::fs::read_to_string(&path).unwrap(),
            );
            let days = digestable_session_days(root).unwrap();
            assert_eq!(days.len(), 1);
            assert!(!days[0].already_digested);
            assert_eq!(days[0].files, vec![resumed]);
        });
    }

    /// The TOCTOU inside the archive move itself: the pre-rename fingerprint
    /// re-check passes, and THEN the sweep rewrites the file (or keeps
    /// writing through an open fd) before/through the rename. The post-rename
    /// verify must catch it: rename the file straight back, report
    /// not-archived, and leave no manifest move — deferral, not loss.
    #[test]
    fn archive_defers_when_file_changes_between_check_and_rename() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("sessions/2026-08")).unwrap();
        std::fs::create_dir_all(root.join("sessions/archive/2026-08")).unwrap();
        let rel = "sessions/2026-08/20260810-a.md".to_string();
        let from = root.join(&rel);
        let to = root.join("sessions/archive/2026-08/20260810-a.md");
        std::fs::write(&from, PROSE).unwrap();
        let fp = content_fingerprint(PROSE.as_bytes());

        // The writer wins the window between the check and the rename.
        let archived = archive_one_verified_with_hook(&from, &to, &fp, || {
            std::fs::write(&from, format!("{PROSE}\n\nand then we resumed.\n")).unwrap();
        })
        .unwrap();
        assert!(!archived);
        assert!(
            from.exists(),
            "rewritten bytes must be renamed back into sessions/"
        );
        assert!(!to.exists());

        // Caller contract on a deferral: no manifest move is recorded (the
        // file still holds the rewritten bytes, so the archive defers again).
        let id = archive_digested_sessions(
            root,
            "2026-08-10",
            std::slice::from_ref(&rel),
            Some(std::slice::from_ref(&fp)),
        )
        .unwrap()
        .manifest_id;
        let raw = std::fs::read_to_string(manifest_path(root, &id)).unwrap();
        let manifest: RunManifest = serde_json::from_str(&raw).unwrap();
        assert!(manifest.moves.is_empty(), "{:?}", manifest.moves);
        assert!(from.exists());

        // Clean case: nothing intervenes, the same helper archives.
        std::fs::write(&from, PROSE).unwrap();
        assert!(archive_one_verified_with_hook(&from, &to, &fp, || {}).unwrap());
        assert!(!from.exists());
        assert!(to.exists());
    }

    /// `file_stem` splits on the LAST dot, so a hand-placed
    /// `<stem>:<8 hex>.md` yields a stem that exact-matches a real
    /// `<stem>:<fingerprint>` record. Only a `:`-free entry is legacy.
    ///
    /// Unix-only: Windows forbids `:` in a filename, so the spoof this guards
    /// against cannot be created there and the fixture write itself fails.
    #[cfg(not(windows))]
    #[test]
    fn a_stem_shaped_like_stem_colon_fingerprint_never_matches_the_legacy_branch() {
        crate::settings::test_support::with_isolated_data("distill-digest-spoof", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            let rel = scored_session(root, "claude-code-abc:1a2b3c4d.md", PROSE);
            let day = digestable_session_days(root).unwrap()[0].day.clone();
            // A genuine record for a DIFFERENT (already archived) file, whose
            // fingerprint happens to be this hand-placed file's name tail.
            write_daily_with_marker(root, &day, &["claude-code-abc:1a2b3c4d"]);

            let days = digestable_session_days(root).unwrap();
            assert_eq!(days.len(), 1);
            assert!(
                !days[0].already_digested,
                "a `:`-bearing stem must never take the legacy bare-stem path"
            );
            assert_eq!(days[0].files, vec![rel.clone()]);

            // Its own content-bound record still works: <stem>:<fingerprint>.
            write_daily_with_marker(root, &day, &[&marker_entry(root, &rel)]);
            assert!(digestable_session_days(root).unwrap()[0].already_digested);
        });
    }

    #[test]
    fn valid_manifest_id_accepts_only_the_prefixed_timestamp_shape() {
        assert!(valid_manifest_id("digest-1699999999"));
        assert!(valid_manifest_id("llm-1699999999"));
        assert!(valid_manifest_id("digest-1699999999-2")); // free_manifest_id's collision suffix
        assert!(!valid_manifest_id("digest-"));
        assert!(!valid_manifest_id("digest-abc"));
        assert!(!valid_manifest_id("digest-1699999999-2-3"));
        assert!(!valid_manifest_id("../../etc/passwd"));
        assert!(!valid_manifest_id("run-1699999999")); // not digest-/llm-
    }

    #[test]
    fn append_distill_manifest_creates_then_extends() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("raw")).unwrap();
        std::fs::create_dir_all(root.join("_inbox/.archived")).unwrap();
        for name in ["a", "b"] {
            std::fs::write(root.join(format!("raw/{name}.md")), "origin").unwrap();
            std::fs::write(
                root.join(format!("_inbox/.archived/{name}.md")),
                "archived source",
            )
            .unwrap();
        }

        append_distill_manifest(
            root,
            "llm-1699999999",
            vec![MoveEntry {
                from: "_inbox/a.md".into(),
                to: "_inbox/.archived/a.md".into(),
            }],
            vec!["raw/a.md".to_string()],
        )
        .unwrap();

        let raw = std::fs::read_to_string(manifest_path(root, "llm-1699999999")).unwrap();
        let manifest: RunManifest = serde_json::from_str(&raw).unwrap();
        assert_eq!(manifest.id, "llm-1699999999");
        assert_eq!(manifest.moves.len(), 1);
        assert_eq!(manifest.created, vec!["raw/a.md".to_string()]);

        // A second call under the same id extends rather than overwriting.
        append_distill_manifest(
            root,
            "llm-1699999999",
            vec![MoveEntry {
                from: "_inbox/b.md".into(),
                to: "_inbox/.archived/b.md".into(),
            }],
            vec!["raw/b.md".to_string()],
        )
        .unwrap();

        let raw = std::fs::read_to_string(manifest_path(root, "llm-1699999999")).unwrap();
        let manifest: RunManifest = serde_json::from_str(&raw).unwrap();
        assert_eq!(manifest.moves.len(), 2);
        assert_eq!(
            manifest.created,
            vec!["raw/a.md".to_string(), "raw/b.md".to_string()]
        );

        // Untrusted id: must be rejected outright, no file written.
        assert!(append_distill_manifest(root, "../evil", vec![], vec!["x".into()]).is_err());
        assert!(!manifest_path(root, "../evil").exists());
    }

    #[test]
    fn run_detail_reads_manifest_and_finds_report() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let manifest = RunManifest {
            id: "digest-100".into(),
            started_at: 1_755_000_000,
            moves: vec![MoveEntry {
                from: "_inbox/a.md".into(),
                to: "_inbox/.archived/a.md".into(),
            }],
            trashed: vec![MoveEntry {
                from: "_inbox/junk.md".into(),
                to: ".myco/trash/digest-100/junk.md".into(),
            }],
            deleted: Vec::new(),
            created: vec!["daily/2026-08-21.md".into()],
            ..Default::default()
        };
        save_manifest(root, &manifest).unwrap();
        std::fs::create_dir_all(root.join("ingest-reports")).unwrap();
        std::fs::write(root.join("ingest-reports/distill-digest-100.md"), "# why").unwrap();

        let d = run_detail(root, "digest-100").unwrap();
        assert_eq!(d.id, "digest-100");
        assert_eq!(d.started_at, 1_755_000_000);
        assert_eq!(
            d.moves,
            vec![(
                "_inbox/a.md".to_string(),
                "_inbox/.archived/a.md".to_string()
            )]
        );
        assert_eq!(
            d.trashed,
            vec![(
                "_inbox/junk.md".to_string(),
                ".myco/trash/digest-100/junk.md".to_string()
            )]
        );
        assert_eq!(d.created, vec!["daily/2026-08-21.md".to_string()]);

        // A run Rust itself named — `run_id`'s YYYYMMDDTHHMMSS, no prefix. This
        // is what every real vault holds; validating it with the write-side
        // guard rejected the lot while the prefixed dev fixtures passed.
        let real = RunManifest {
            id: free_run_id(root, 1_787_540_400),
            started_at: 1_787_540_400,
            created: vec!["wiki/agent-made.md".into()],
            ..Default::default()
        };
        save_manifest(root, &real).unwrap();
        let d2 = run_detail(root, &real.id).unwrap();
        assert_eq!(d2.id, real.id);
        assert_eq!(d2.created, vec!["wiki/agent-made.md".to_string()]);
        // Traversal stays refused on both shapes.
        assert!(run_detail(root, "../../etc/passwd").is_err());
        assert!(run_detail(root, "2026-08-24").is_err());
        assert_eq!(
            d.report_rel.as_deref(),
            Some("ingest-reports/distill-digest-100.md")
        );
        assert_eq!(d.commit, None, "no git repo — no commit");

        // No report on disk → None, not a dangling path.
        let bare = RunManifest {
            id: "digest-101".into(),
            started_at: 1,
            ..Default::default()
        };
        save_manifest(root, &bare).unwrap();
        assert_eq!(run_detail(root, "digest-101").unwrap().report_rel, None);

        // Untrusted id shape is rejected before any path join.
        assert!(run_detail(root, "../evil").is_err());
    }

    /// The draftMap fragmentation fix's undo half: two proposals recorded by
    /// one run under ONE shared id (the TS side now passes the same id per
    /// run) are both reversed by a single `undo` of that id.
    #[test]
    fn undo_of_one_shared_llm_manifest_reverses_every_recorded_create() {
        // `tmp`, not `dir`: the usual binding name would shadow this module's
        // `dir()` fn, called below to find `.myco/distill-runs/`.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("wiki/maps")).unwrap();
        std::fs::write(root.join("wiki/maps/a.md"), "map a").unwrap();
        std::fs::write(root.join("wiki/maps/b.md"), "map b").unwrap();

        append_distill_manifest(
            root,
            "llm-1699999999",
            vec![],
            vec!["wiki/maps/a.md".into()],
        )
        .unwrap();
        append_distill_manifest(
            root,
            "llm-1699999999",
            vec![],
            vec!["wiki/maps/b.md".into()],
        )
        .unwrap();

        // One manifest on disk, not two.
        let runs: Vec<_> = std::fs::read_dir(dir(root).join("distill-runs"))
            .unwrap()
            .flatten()
            .collect();
        assert_eq!(runs.len(), 1);

        assert_eq!(undo(root, "llm-1699999999").unwrap(), 2);
        assert!(!root.join("wiki/maps/a.md").exists());
        assert!(!root.join("wiki/maps/b.md").exists());
    }

    #[test]
    fn append_distill_manifest_rejects_a_path_escaping_the_vault() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        // A `created` entry trying to escape root.
        assert!(
            append_distill_manifest(root, "llm-1699999999", vec![], vec!["../evil".into()])
                .is_err()
        );
        assert!(!manifest_path(root, "llm-1699999999").exists());

        // A `moves` entry's `to` trying to escape root.
        assert!(append_distill_manifest(
            root,
            "llm-1699999999",
            vec![MoveEntry {
                from: "_inbox/a.md".into(),
                to: "../../etc/passwd".into(),
            }],
            vec![],
        )
        .is_err());
        assert!(!manifest_path(root, "llm-1699999999").exists());
    }

    #[test]
    fn crash_mid_run_preserves_manifest_for_completed_moves() {
        crate::settings::test_support::with_isolated_data("distill-run-crash-safety", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            std::fs::create_dir_all(root.join("_inbox/quarantine")).unwrap();
            // Scan: a machine-made session quarantined (and persisted)
            // BEFORE the TTL pass below hits its induced failure. The saved
            // ontology matches the wiki's page count, so run() keeps it.
            seed_wiki_pages(root, GATE_MIN_WIKI_PAGES);
            save_synthetic_ontology(root, ontology_two_clusters());
            write_session(
                root,
                "m.md",
                "You are planning how to ingest a new source into an existing wiki. Plan it.",
            );

            // TTL pass: an expired quarantine item whose trash move will fail.
            std::fs::write(root.join("_inbox/quarantine/q.md"), PROSE).unwrap();
            let expired = serde_json::json!({
                "tier": "quarantine",
                "s_knn": 0.2,
                "nearest_cluster": "topic",
                "reason": "test",
                "expires": now_secs() - 1000,
                "vector": [1.0, 0.0],
                "from": "_inbox/q.md",
                "source_sha256": admission::sha256(PROSE.as_bytes()),
            });
            std::fs::write(
                root.join("_inbox/quarantine/q.verdict.json"),
                serde_json::to_string_pretty(&expired).unwrap(),
            )
            .unwrap();

            // Poison `.myco/trash` as a plain FILE (not a directory), so the
            // TTL pass's `create_dir_all(&trash_dir)` fails for every id —
            // deterministic, and independent of `_inbox` read_dir order
            // (unlike colliding on one specific run id).
            std::fs::create_dir_all(root.join(".myco")).unwrap();
            std::fs::write(root.join(".myco/trash"), "not a directory").unwrap();

            let cfg = DistillConfig::default(); // Standard intensity
            let err = run(root, &cfg, &dummy_embed).unwrap_err();
            assert!(err.contains("trash dir"), "unexpected error: {err}");

            // The scan ran to completion (it precedes the TTL pass, which is
            // where the induced failure lives), so m.md must actually be
            // gone from sessions/ ...
            assert!(!root.join("sessions/2026-08/m.md").exists());
            // ... and the crash must not have erased the record of it: the
            // manifest on disk (persisted incrementally, not just at the end)
            // still names that move.
            let runs_dir = root.join(".myco/distill-runs");
            let entries: Vec<_> = std::fs::read_dir(&runs_dir).unwrap().flatten().collect();
            assert_eq!(entries.len(), 1, "exactly one manifest written");
            let raw = std::fs::read_to_string(entries[0].path()).unwrap();
            let manifest: serde_json::Value = serde_json::from_str(&raw).unwrap();
            let moves = manifest["moves"].as_array().unwrap();
            assert_eq!(moves.len(), 1);
            assert_eq!(moves[0]["from"], "sessions/2026-08/m.md");
            let to = moves[0]["to"].as_str().unwrap();
            assert!(
                root.join(to).exists(),
                "the manifest's move must match reality on disk"
            );
            // The failed-halfway TTL item must not appear at all — it never
            // got a chance to push into the manifest.
            assert!(manifest["trashed"].as_array().unwrap().is_empty());
        });
    }

    #[test]
    fn conservative_intensity_proposes_instead_of_moving() {
        crate::settings::test_support::with_isolated_data("distill-run-conservative", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            let quarantine = root.join("_inbox/quarantine");
            write_expired_item(&quarantine, "i", Some("_inbox/i.md"));

            let cfg = DistillConfig {
                intensity: Intensity::Conservative,
                ..DistillConfig::default()
            };
            let report = run(root, &cfg, &dummy_embed).unwrap();
            assert_eq!(report.trashed, 0);
            assert_eq!(report.proposals, 1);
            assert!(
                quarantine.join("i.md").exists(),
                "conservative intensity must not move the expired item"
            );

            let feedback_dir = root.join("work/feedback");
            let entries: Vec<_> = std::fs::read_dir(&feedback_dir).unwrap().collect();
            assert_eq!(entries.len(), 1);
            let content = std::fs::read_to_string(entries[0].as_ref().unwrap().path()).unwrap();
            assert!(content.contains("type: distill-proposal"));
            assert!(content.contains("status: pending"));
        });
    }

    #[test]
    fn list_runs_returns_newest_first_with_counts() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut older = test_manifest();
        older.id = "digest-100".into();
        older.started_at = 100;
        older.moves = vec![MoveEntry {
            from: "raw/a.md".into(),
            to: "raw/archive/a.md".into(),
        }];
        save_manifest(root, &older).unwrap();
        let mut newer = test_manifest();
        newer.id = "digest-200".into();
        newer.started_at = 200;
        newer.created = vec!["wiki/x.md".into(), "wiki/y.md".into()];
        save_manifest(root, &newer).unwrap();

        let runs = list_runs(root, 10);
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].id, "digest-200");
        assert_eq!(runs[0].created, 2);
        assert_eq!(runs[1].moves, 1);
        assert_eq!(list_runs(root, 1).len(), 1);
    }

    #[test]
    fn undo_preserves_unsigned_run_layout_for_manual_recovery() {
        crate::settings::test_support::with_isolated_data("distill-run-undo", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            std::fs::create_dir_all(root.join("_inbox/quarantine")).unwrap();
            std::fs::write(root.join("_inbox/quarantine/q.md"), PROSE).unwrap();
            let expired = serde_json::json!({
                "tier": "quarantine",
                "s_knn": 0.2,
                "nearest_cluster": "topic",
                "reason": "test",
                "expires": now_secs() - 1000,
                "vector": [1.0, 0.0],
                "from": "_inbox/q.md",
                "source_sha256": admission::sha256(PROSE.as_bytes()),
            });
            std::fs::write(
                root.join("_inbox/quarantine/q.verdict.json"),
                serde_json::to_string_pretty(&expired).unwrap(),
            )
            .unwrap();

            // `.myco/` (state, ontology, run manifests) and `ingest-reports/`
            // are the tool's own operational record, not the vault's CONTENT
            // layout — undo restores content, it does not erase the fact
            // that a run happened.
            fn snapshot(root: &Path) -> Vec<String> {
                fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
                    let Ok(entries) = std::fs::read_dir(dir) else {
                        return;
                    };
                    for e in entries.flatten() {
                        let path = e.path();
                        let rel = path
                            .strip_prefix(root)
                            .unwrap()
                            .to_string_lossy()
                            .replace('\\', "/");
                        if rel.starts_with(".myco") || rel.starts_with("ingest-reports") {
                            continue;
                        }
                        if path.is_dir() {
                            walk(&path, root, out);
                        } else {
                            out.push(rel);
                        }
                    }
                }
                let mut out = Vec::new();
                walk(root, root, &mut out);
                out.sort();
                out
            }

            let before = snapshot(root);

            let cfg = DistillConfig::default(); // Standard intensity
            let report = run(root, &cfg, &dummy_embed).unwrap();
            assert_eq!(report.trashed, 1);
            assert!(!root.join("_inbox/quarantine/q.md").exists());
            assert!(!root.join("_inbox/quarantine/q.verdict.json").exists());

            let after_run = snapshot(root);
            assert_ne!(before, after_run);
            let reversed = undo(root, &report.id).unwrap();
            assert_eq!(
                reversed, 0,
                "unsigned trash history requires manual recovery"
            );
            assert_eq!(after_run, snapshot(root));
            let recorded: RunManifest = serde_json::from_str(
                &std::fs::read_to_string(manifest_path(root, &report.id)).unwrap(),
            )
            .unwrap();
            for moved in recorded.trashed {
                assert!(
                    root.join(moved.to).exists(),
                    "recoverable trash bytes are preserved"
                );
            }
        });
    }

    /// An expired quarantine item as a past `scan` left it: content file and
    /// sidecar in `dir`, the sidecar naming its origin when `from` is given
    /// (one written before the field existed names none).
    fn write_expired_item(dir: &Path, stem: &str, from: Option<&str>) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(format!("{stem}.md")), PROSE).unwrap();
        let mut sidecar = serde_json::json!({
            "tier": "quarantine",
            "reason": "test",
            "expires": now_secs() - 1000,
            "vector": [],
            "source_sha256": admission::sha256(PROSE.as_bytes()),
        });
        if let Some(f) = from {
            sidecar["from"] = f.into();
        }
        std::fs::write(
            dir.join(format!("{stem}.verdict.json")),
            sidecar.to_string(),
        )
        .unwrap();
    }

    #[test]
    fn permanent_cleanup_removes_expired_items_without_an_undo_copy() {
        crate::settings::test_support::with_isolated_data("distill-permanent-cleanup", |_data| {
            let settings: crate::settings::Settings =
                serde_json::from_str(r#"{"permanent_delete":true}"#).unwrap();
            crate::settings::save(&settings).unwrap();
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            let quarantine = root.join("_inbox/quarantine");
            write_expired_item(&quarantine, "expired", Some("_inbox/expired.md"));
            write_expired_item(&quarantine, "session", Some("sessions/2026-08/session.md"));
            let trash = root.join(".myco/trash");
            write_expired_item(&trash.join("recent-run"), "old", Some("_inbox/old.md"));
            save_manifest(
                root,
                &RunManifest {
                    id: "recent-run".into(),
                    trashed: vec![
                        MoveEntry {
                            from: "_inbox/quarantine/old.md".into(),
                            to: ".myco/trash/recent-run/old.md".into(),
                        },
                        MoveEntry {
                            from: "_inbox/quarantine/old.verdict.json".into(),
                            to: ".myco/trash/recent-run/old.verdict.json".into(),
                        },
                    ],
                    ..Default::default()
                },
            )
            .unwrap();
            write_expired_item(
                &trash.join("unrecorded-run"),
                "unrecorded",
                Some("_inbox/unrecorded.md"),
            );
            write_expired_item(
                &trash.join("session-run"),
                "session",
                Some("sessions/2026-08/session.md"),
            );

            let report = run(root, &DistillConfig::default(), &dummy_embed).unwrap();
            assert!(
                !trash.join(&report.id).exists(),
                "no recoverable copy is created"
            );
            assert!(
                !trash.join("recent-run").exists(),
                "opt-in clears app-owned trash immediately"
            );
            assert!(
                trash.join("unrecorded-run/unrecorded.md").exists(),
                "unproven trash is retained"
            );
            assert!(
                trash.join("session-run/session.md").exists(),
                "automatic session cleanup remains protected"
            );
            assert!(!quarantine.join("expired.md").exists());
            assert!(!quarantine.join("expired.verdict.json").exists());
            assert!(
                quarantine.join("session.md").exists(),
                "session expiry still asks first"
            );
            let manifest = std::fs::read_to_string(manifest_path(root, &report.id)).unwrap();
            let manifest: serde_json::Value = serde_json::from_str(&manifest).unwrap();
            assert_eq!(report.deleted, 2);
            assert_eq!(manifest["deleted"].as_array().unwrap().len(), 4);
            assert_eq!(
                list_runs(root, 10)
                    .into_iter()
                    .find(|run| run.id == report.id)
                    .unwrap()
                    .deleted,
                report.deleted
            );
            assert_eq!(run_detail(root, &report.id).unwrap().deleted.len(), 4);
            assert!(manifest["deleted"]
                .as_array()
                .unwrap()
                .iter()
                .all(|path| !path.as_str().unwrap().starts_with('/')));
            assert!(manifest["trashed"].as_array().unwrap().is_empty());
            let report_text = std::fs::read_to_string(
                root.join(format!("ingest-reports/distill-{}.md", report.id)),
            )
            .unwrap();
            assert!(report_text.contains("cannot be restored"));
            undo(root, &report.id).unwrap();
            assert!(
                !quarantine.join("expired.md").exists(),
                "undo cannot restore permanent deletions"
            );
        });
    }

    #[test]
    fn permanent_delete_proposal_prevalidates_and_reports_irreversible_deletion() {
        crate::settings::test_support::with_isolated_data("distill-permanent-proposal", |_data| {
            let settings: crate::settings::Settings =
                serde_json::from_str(r#"{"permanent_delete":true}"#).unwrap();
            crate::settings::save(&settings).unwrap();
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            let quarantine = root.join("_inbox/quarantine");
            write_expired_item(&quarantine, "session", Some("sessions/2026-08/session.md"));
            let rejected = write_proposal(
                root,
                "delete-batch",
                "Invalid batch",
                "synthetic",
                &serde_json::json!({
                    "files": ["_inbox/quarantine/session.md", "raw/immutable.md"]
                }),
            )
            .unwrap();
            assert!(apply_proposal(root, &rejected).is_err());
            assert!(quarantine.join("session.md").exists());
            assert!(quarantine.join("session.verdict.json").exists());

            let approved = write_proposal(
                root,
                "delete-batch",
                "Delete session",
                "synthetic",
                &serde_json::json!({
                    "files": ["_inbox/quarantine/session.md"]
                }),
            )
            .unwrap();
            assert_eq!(
                apply_proposal(root, &approved).unwrap(),
                "permanently deleted 1, skipped 0 already-processed"
            );
            assert!(!quarantine.join("session.md").exists());
            assert!(!quarantine.join("session.verdict.json").exists());
            assert!(!root.join(".myco/trash").exists());
            assert_eq!(
                apply_proposal(root, &approved).unwrap(),
                "permanently deleted 0, skipped 1 already-processed"
            );
        });
    }

    #[test]
    fn deletion_proposal_rejects_changed_policy_and_keeps_the_confirmed_snapshot() {
        crate::settings::test_support::with_isolated_data("distill-delete-confirmation", |_data| {
            let mut settings = crate::settings::Settings::default();
            crate::settings::save(&settings).unwrap();
            let confirmed = crate::settings::confirmed_deletion_policy(Some(false)).unwrap();
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            let quarantine = root.join("_inbox/quarantine");
            write_expired_item(&quarantine, "note", Some("_inbox/note.md"));
            let proposal = write_proposal(
                root,
                "delete-batch",
                "Delete note",
                "synthetic",
                &serde_json::json!({
                    "files": ["_inbox/quarantine/note.md"]
                }),
            )
            .unwrap();
            settings.permanent_delete = true;
            crate::settings::save(&settings).unwrap();
            let error = apply_proposal_confirmed(root, &proposal, Some(false)).unwrap_err();
            assert!(error.contains("policy changed"), "{error}");
            assert!(quarantine.join("note.md").exists());
            assert!(!std::fs::read_to_string(root.join(&proposal))
                .unwrap()
                .contains("status: done"));

            // A policy change after the native check cannot promote the
            // already-confirmed recoverable operation to permanent deletion.
            assert_eq!(
                apply_proposal_with_policy(root, &proposal, confirmed).unwrap(),
                "moved 1, skipped 0 already-processed"
            );
            let slug = Path::new(&proposal).file_stem().unwrap();
            assert!(root.join(".myco/trash").join(slug).join("note.md").exists());
            assert!(root
                .join(".myco/trash")
                .join(slug)
                .join("note.verdict.json")
                .exists());
        });
    }

    #[cfg(unix)]
    #[test]
    fn permanent_cleanup_refuses_redirected_app_trash_before_deleting() {
        crate::settings::test_support::with_isolated_data(
            "distill-permanent-trash-link",
            |_data| {
                let settings: crate::settings::Settings =
                    serde_json::from_str(r#"{"permanent_delete":true}"#).unwrap();
                crate::settings::save(&settings).unwrap();
                let dir = tempfile::tempdir().unwrap();
                let root = dir.path();
                let outside = tempfile::tempdir().unwrap();
                std::fs::write(
                    outside.path().join("retained.md"),
                    "synthetic retained note",
                )
                .unwrap();
                write_expired_item(
                    &root.join("_inbox/quarantine"),
                    "expired",
                    Some("_inbox/expired.md"),
                );
                std::fs::create_dir(root.join(".myco")).unwrap();
                std::os::unix::fs::symlink(outside.path(), root.join(".myco/trash")).unwrap();
                let error = run(root, &DistillConfig::default(), &dummy_embed).unwrap_err();
                assert!(error.contains("symbolic link"), "{error}");
                assert!(outside.path().join("retained.md").exists());
                assert!(root.join("_inbox/quarantine/expired.md").exists());
            },
        );
    }

    #[test]
    fn an_expired_session_becomes_a_proposal_and_the_purge_spares_it() {
        crate::settings::test_support::with_isolated_data("distill-ttl-sessions", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            let quarantine = root.join("_inbox/quarantine");
            write_expired_item(&quarantine, "s", Some("sessions/2026-08/s.md"));
            write_expired_item(&quarantine, "i", Some("_inbox/i.md"));
            write_expired_item(&quarantine, "legacy", None);
            // Trash past runs left, all past the retention window.
            let trash = root.join(".myco/trash");
            write_expired_item(
                &trash.join("old-session"),
                "x",
                Some("sessions/2026-07/x.md"),
            );
            write_expired_item(&trash.join("old-inbox"), "y", Some("_inbox/y.md"));
            write_expired_item(&trash.join("old-legacy"), "z", None);
            let long_ago = std::time::SystemTime::now()
                - std::time::Duration::from_secs((TRASH_RETENTION_DAYS as u64 + 5) * 86_400);
            for d in ["old-session", "old-inbox", "old-legacy"] {
                std::fs::File::open(trash.join(d))
                    .unwrap()
                    .set_modified(long_ago)
                    .unwrap();
            }

            let cfg = DistillConfig::default(); // Standard: trashes on expiry
            let report = run(root, &cfg, &dummy_embed).unwrap();
            assert_eq!(report.trashed, 1, "only the item known to be from _inbox/");
            assert!(!quarantine.join("i.md").exists());
            for stem in ["s", "legacy"] {
                assert!(
                    quarantine.join(format!("{stem}.md")).exists(),
                    "{stem} waits for a click"
                );
            }
            assert_eq!(report.proposals, 2, "one delete proposal each");
            assert_eq!(
                run(root, &cfg, &dummy_embed).unwrap().proposals,
                0,
                "nothing asked twice while those wait"
            );

            assert!(!trash.join("old-inbox").exists());
            assert!(trash.join("old-session/x.md").exists());
            assert!(
                trash.join("old-legacy/z.md").exists(),
                "an unknown origin may be a session"
            );
        });
    }

    #[cfg(unix)]
    #[test]
    fn permanent_delete_proposal_refuses_a_raw_source_alias_before_deleting_the_batch() {
        crate::settings::test_support::with_isolated_data("distill-permanent-raw-alias", |_data| {
            let settings: crate::settings::Settings =
                serde_json::from_str(r#"{"permanent_delete":true}"#).unwrap();
            crate::settings::save(&settings).unwrap();
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            std::fs::create_dir_all(root.join("raw")).unwrap();
            std::fs::write(root.join("raw/original.md"), "synthetic immutable source").unwrap();
            let quarantine = root.join("_inbox/quarantine");
            write_expired_item(&quarantine, "ordinary", Some("_inbox/ordinary.md"));
            std::os::unix::fs::symlink(root.join("raw/original.md"), quarantine.join("alias.md"))
                .unwrap();
            let proposal = write_proposal(
                root,
                "delete-batch",
                "Unsafe alias",
                "synthetic",
                &serde_json::json!({
                    "files": ["_inbox/quarantine/ordinary.md", "_inbox/quarantine/alias.md"]
                }),
            )
            .unwrap();
            let error = apply_proposal(root, &proposal).unwrap_err();
            assert!(error.contains("symbolic link"), "{error}");
            assert!(quarantine.join("ordinary.md").exists());
            assert_eq!(
                std::fs::read_to_string(root.join("raw/original.md")).unwrap(),
                "synthetic immutable source"
            );
        });
    }

    /// The 격리 tab says what expiry will do, so it reads the TTL pass's own
    /// rule: an item it would only ask about must not read "may be trashed".
    #[test]
    fn quarantine_entries_say_whether_expiry_asks_or_trashes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let quarantine = root.join("_inbox/quarantine");
        write_expired_item(&quarantine, "s", Some("sessions/2026-08/s.md"));
        write_expired_item(&quarantine, "i", Some("_inbox/i.md"));
        write_expired_item(&quarantine, "legacy", None);
        let asks = |root: &Path| -> Vec<(String, bool)> {
            let mut v: Vec<_> = quarantine_entries(root)
                .into_iter()
                .map(|(e, _)| (e.name, e.asks_on_expiry))
                .collect();
            v.sort();
            v
        };
        let at = |names: [(&str, bool); 3]| names.map(|(n, a)| (n.to_string(), a)).to_vec();
        // Standard: only the item known to be from _inbox/ is trashed.
        assert_eq!(
            asks(root),
            at([("i.md", false), ("legacy.md", true), ("s.md", true)])
        );
        let cfg = DistillConfig {
            intensity: Intensity::Conservative,
            ..DistillConfig::default()
        };
        config_save(root, &cfg).unwrap();
        assert_eq!(
            asks(root),
            at([("i.md", true), ("legacy.md", true), ("s.md", true)])
        );
    }

    #[test]
    fn restore_puts_a_session_back_where_it_was_and_keeps_it_there() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_session(
            root,
            "m.md",
            "You are planning how to ingest a new source into an existing wiki. Plan it.",
        );
        let o = tiny_ontology();
        let cfg = DistillConfig::default();
        let embed = |texts: Vec<String>| -> Result<Vec<Vec<f32>>, String> {
            Ok(texts.iter().map(|_| vec![1.0, 0.0]).collect())
        };
        let mut manifest = test_manifest();
        let out = scan(root, &o, &cfg, 10, &embed, &[], &mut manifest).unwrap();
        assert_eq!(out.quarantined, 1);

        readmit_quarantine(root, &["_inbox/quarantine/m.md".to_string()]).unwrap();
        let home = root.join("sessions/2026-08/m.md");
        assert!(home.exists(), "back where it came from");
        assert!(!root.join("_inbox/m.md").exists(), "never _inbox/");
        assert!(!root.join("_inbox/quarantine/m.verdict.json").exists());

        // Later scans honour the owner's choice, whatever the embed model.
        assert!(kept_load(root)
            .unwrap()
            .contains(&"sessions/2026-08/m.md".to_string()));
        let out = scan(root, &o, &cfg, 10, &embed, &[], &mut manifest).unwrap();
        assert_eq!(out.quarantined, 0);
        assert!(home.exists());

        // A recorded origin outside the inflow trees is not followed.
        write_expired_item(&root.join("_inbox/quarantine"), "q", Some("raw/q.md"));
        readmit_quarantine(root, &["_inbox/quarantine/q.md".to_string()]).unwrap();
        assert!(!root.join("raw/q.md").exists());
        assert!(root.join("_inbox/q.md").exists());
    }

    /// A restore clicked while a run is embedding (`restore_quarantine` and
    /// `distill_run` share no lock) must outlive that run's ledger save.
    #[test]
    fn a_restore_during_a_scan_keeps_its_owner_kept_mark() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_session(
            root,
            "m.md",
            "You are planning how to ingest a new source into an existing wiki. Plan it.",
        );
        let o = tiny_ontology();
        let cfg = DistillConfig::default();
        let plain = |texts: Vec<String>| -> Result<Vec<Vec<f32>>, String> {
            Ok(texts.iter().map(|_| vec![1.0, 0.0]).collect())
        };
        let mut manifest = test_manifest();
        let out = scan(root, &o, &cfg, 10, &plain, &[], &mut manifest).unwrap();
        assert_eq!(out.quarantined, 1);

        write_session(
            root,
            "w.md",
            "Why does the sidebar flicker when a folder collapses?",
        );
        let racing = |texts: Vec<String>| -> Result<Vec<Vec<f32>>, String> {
            readmit_quarantine(root, &["_inbox/quarantine/m.md".to_string()])?;
            plain(texts)
        };
        scan(root, &o, &cfg, 10, &racing, &[], &mut manifest).unwrap();
        assert!(kept_load(root)
            .unwrap()
            .contains(&"sessions/2026-08/m.md".to_string()));

        let out = scan(root, &o, &cfg, 10, &plain, &[], &mut manifest).unwrap();
        assert_eq!(out.quarantined, 0, "the restored session stays home");
        assert!(root.join("sessions/2026-08/m.md").exists());
    }

    #[test]
    fn status_reports_backlog_trend() {
        crate::settings::test_support::with_isolated_data("distill-run-status", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            std::fs::create_dir_all(root.join("_inbox")).unwrap();
            seed_wiki_pages(root, GATE_MIN_WIKI_PAGES); // keep the cold-start gate active
            seed_semantic_store(root, 2);
            std::fs::write(root.join("_inbox/a.md"), PROSE).unwrap();
            std::fs::write(root.join("_inbox/b.md"), PROSE).unwrap();
            set_mtime(&root.join("_inbox/a.md"), old_mtime());
            set_mtime(&root.join("_inbox/b.md"), old_mtime());

            let cfg = DistillConfig::default();

            let before = status(root);
            assert_eq!(before.backlog, 2, "two unscored, mature inflow items");
            assert!(before.gate_active, "50 wiki pages meets the gate threshold");
            assert_eq!(before.wiki_pages, GATE_MIN_WIKI_PAGES, "Defect D fix");
            assert_eq!(
                before.quarantined, 0,
                "Defect G fix — nothing quarantined yet"
            );
            assert!(before.last_run.is_none());
            assert!(before.last_backlogs.is_empty());
            assert!(before.last_run_id.is_none(), "no run has happened yet");

            let report1 = run(root, &cfg, &dummy_embed).unwrap();
            assert_eq!(report1.backlog_after, 0, "scan ledgers both files this run");

            let mid = status(root);
            assert_eq!(mid.backlog, 0);
            assert!(mid.last_run.is_some());
            assert_eq!(mid.last_backlogs, vec![0]);
            assert_eq!(mid.last_run_id, Some(report1.id.clone()));

            let report2 = run(root, &cfg, &dummy_embed).unwrap();
            assert_ne!(
                report1.id, report2.id,
                "free_run_id must not collide within the same second"
            );

            let after = status(root);
            assert_eq!(after.last_backlogs, vec![0, 0]);
            assert_eq!(after.pending_proposals, 0);
            assert_eq!(
                after.last_run_id,
                Some(report2.id),
                "last_run_id tracks the most recently STARTED run, not filename order"
            );
        });
    }

    #[test]
    fn full_tier_items_lists_oldest_first_and_drops_missing_or_wrong_tier() {
        crate::settings::test_support::with_isolated_data("distill-full-tier-items", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            std::fs::create_dir_all(root.join("_inbox")).unwrap();

            let full_text = format!("{PROSE} FULL marker so this note lands the full tier.");
            let quarantine_text =
                format!("{PROSE} BORDERLINE marker so this note lands the quarantine tier.");
            std::fs::write(root.join("_inbox/newer-full.md"), &full_text).unwrap();
            std::fs::write(root.join("_inbox/older-full.md"), &full_text).unwrap();
            std::fs::write(root.join("_inbox/quar.md"), &quarantine_text).unwrap();
            for name in [
                "_inbox/newer-full.md",
                "_inbox/older-full.md",
                "_inbox/quar.md",
            ] {
                set_mtime(&root.join(name), old_mtime());
            }
            // Strictly older than the other two, so it must sort first.
            set_mtime(
                &root.join("_inbox/older-full.md"),
                old_mtime() - std::time::Duration::from_secs(3600),
            );

            // Semantic eligibility uses the exact active store representation,
            // which the controlled ontology and score fixtures also declare.
            seed_semantic_store(root, 2);
            let o = pin_scan_ontology(root, tiny_ontology());
            let cfg = DistillConfig::default();
            let embed = |texts: Vec<String>| -> Result<Vec<Vec<f32>>, String> {
                Ok(texts
                    .iter()
                    .map(|t| {
                        if t.contains("BORDERLINE") {
                            vec![0.2_f32, (1.0 - 0.2_f32 * 0.2_f32).sqrt()] // -> Quarantine
                        } else {
                            vec![1.0_f32, 0.0_f32] // matches centroid -> Full
                        }
                    })
                    .collect())
            };
            let mut manifest = test_manifest();
            let out = scan(root, &o, &cfg, 10, &embed, &[], &mut manifest).unwrap();
            assert_eq!(out.full, 2);
            assert_eq!(out.quarantined, 1);

            let items = full_tier_items(root).unwrap();
            assert_eq!(
                items,
                vec!["_inbox/older-full.md", "_inbox/newer-full.md"],
                "full-tier only, oldest mtime first; the quarantine-tier item is excluded"
            );

            // A file gone from disk — the stale ledger key must drop out
            // rather than point nowhere.
            std::fs::remove_file(root.join("_inbox/older-full.md")).unwrap();
            let items2 = full_tier_items(root).unwrap();
            assert_eq!(
                items2,
                vec!["_inbox/newer-full.md"],
                "a removed file drops out even though its ledger entry remains"
            );
        });
    }

    #[test]
    fn full_tier_items_skips_an_item_whose_source_page_moved_under_wiki() {
        // Tidy's "gather session summaries" (and any hand move) puts the
        // summary at wiki/sessions/<month>/: links still resolve it by stem,
        // so it still represents the source and must not be re-ingested.
        crate::settings::test_support::with_isolated_data(
            "distill-full-tier-moved-summary",
            |_data| {
                let dir = tempfile::tempdir().unwrap();
                let root = dir.path();
                std::fs::create_dir_all(root.join("_inbox")).unwrap();
                std::fs::create_dir_all(root.join("wiki/sessions/2026-09")).unwrap();
                let full_text = format!("{PROSE} FULL marker so this note lands the full tier.");
                std::fs::write(root.join("_inbox/already-ingested.md"), &full_text).unwrap();
                std::fs::write(root.join("_inbox/fresh.md"), &full_text).unwrap();
                for name in ["_inbox/already-ingested.md", "_inbox/fresh.md"] {
                    set_mtime(&root.join(name), old_mtime());
                }
                std::fs::write(
                    root.join("wiki/sessions/2026-09/source-already-ingested.md"),
                    "a source summary page",
                )
                .unwrap();

                seed_semantic_store(root, 2);
                let o = pin_scan_ontology(root, tiny_ontology());
                let cfg = DistillConfig::default();
                let embed = |texts: Vec<String>| -> Result<Vec<Vec<f32>>, String> {
                    Ok(texts.iter().map(|_| vec![1.0_f32, 0.0_f32]).collect())
                };
                let mut manifest = test_manifest();
                let out = scan(root, &o, &cfg, 10, &embed, &[], &mut manifest).unwrap();
                assert_eq!(out.full, 2);
                assert_eq!(full_tier_items(root).unwrap(), vec!["_inbox/fresh.md"]);
            },
        );
    }

    #[test]
    fn full_tier_items_skips_an_item_whose_source_page_already_exists() {
        // An ingested full-tier item's file never moves, so its ledger entry
        // never goes stale — without the source-page check, it would be
        // re-listed (and re-ingested) every run.
        crate::settings::test_support::with_isolated_data(
            "distill-full-tier-already-represented",
            |_data| {
                let dir = tempfile::tempdir().unwrap();
                let root = dir.path();
                std::fs::create_dir_all(root.join("_inbox")).unwrap();
                std::fs::create_dir_all(root.join("wiki")).unwrap();

                let full_text = format!("{PROSE} FULL marker so this note lands the full tier.");
                std::fs::write(root.join("_inbox/already-ingested.md"), &full_text).unwrap();
                std::fs::write(root.join("_inbox/fresh.md"), &full_text).unwrap();
                for name in ["_inbox/already-ingested.md", "_inbox/fresh.md"] {
                    set_mtime(&root.join(name), old_mtime());
                }
                // The "already represented" signal: a source page exists.
                std::fs::write(
                    root.join("wiki/source-already-ingested.md"),
                    "a source summary page",
                )
                .unwrap();

                seed_semantic_store(root, 2);
                let o = pin_scan_ontology(root, tiny_ontology());
                let cfg = DistillConfig::default();
                let embed = |texts: Vec<String>| -> Result<Vec<Vec<f32>>, String> {
                    Ok(texts.iter().map(|_| vec![1.0_f32, 0.0_f32]).collect())
                };
                let mut manifest = test_manifest();
                let out = scan(root, &o, &cfg, 10, &embed, &[], &mut manifest).unwrap();
                assert_eq!(
                    out.full, 2,
                    "both score full tier — the check is not about scoring"
                );

                let items = full_tier_items(root).unwrap();
                assert_eq!(
                    items,
                    vec!["_inbox/fresh.md"],
                    "already-ingested.md has a source page and must not be re-listed"
                );
            },
        );
    }

    // -----------------------------------------------------------------------
    // Task 7: emerging-cluster detection + proposal lifecycle.
    // -----------------------------------------------------------------------

    #[test]
    fn emerging_clusters_ignores_dissimilar_and_undersized_groups() {
        crate::settings::test_support::with_isolated_data(
            "distill-emerging-cluster-geometry",
            |_data| {
                let dir = tempfile::tempdir().unwrap();
                let root = dir.path();
                seed_semantic_store(root, 2);
                let quarantine = root.join("_inbox/quarantine");
                std::fs::create_dir_all(&quarantine).unwrap();

                // 5 similar items -> one qualifying group.
                for i in 0..5 {
                    write_quarantine_item(&quarantine, &format!("sim{i}"), vec![1.0, 0.0]);
                }
                // 4 similar-among-themselves items -> group exists but below min_size.
                for i in 0..4 {
                    write_quarantine_item(&quarantine, &format!("small{i}"), vec![0.0, 1.0]);
                }
                // A singleton, dissimilar to both groups (cosine ~0.71 < 0.9 threshold).
                write_quarantine_item(&quarantine, "lonely", vec![0.5, 0.5]);

                let groups = emerging_clusters(root, 5, 0.9).unwrap();
                assert_eq!(groups.len(), 1, "only the 5-item group clears min_size");
                assert_eq!(groups[0].len(), 5);
                for i in 0..5 {
                    assert!(groups[0].contains(&format!("_inbox/quarantine/sim{i}.md")));
                }
            },
        );
    }

    #[test]
    fn quarantine_entries_lists_verdicts_and_degrades_on_a_malformed_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let quarantine = root.join("_inbox/quarantine");
        std::fs::create_dir_all(&quarantine).unwrap();
        write_quarantine_item(&quarantine, "good", vec![1.0, 0.0]);
        // Malformed: truncated JSON, the shape a half-written sidecar has.
        std::fs::write(
            quarantine.join("broken.md"),
            "---\ntitle: b\n---\n\nBody text here.",
        )
        .unwrap();
        std::fs::write(quarantine.join("broken.verdict.json"), "{\"s_knn\": 0.4,").unwrap();
        // No sidecar at all — the move landed, the write never did.
        std::fs::write(quarantine.join("orphan.md"), PROSE).unwrap();

        let entries = quarantine_entries(root);
        assert_eq!(
            entries.len(),
            3,
            "every item lists, malformed sidecar or not"
        );
        let by_name = |n: &str| entries.iter().find(|(e, _)| e.name == n).expect("listed");

        let (good, good_preview) = by_name("good.md");
        assert_eq!(good.path, "_inbox/quarantine/good.md");
        assert_eq!(good.nearest_cluster, "topic");
        assert!((good.s_knn - 0.2).abs() < 1e-6);
        assert!(good.expires > now_secs());
        assert!(good_preview.starts_with(PROSE.split_whitespace().next().unwrap()));

        // Degraded, not dropped: zeros/empties, and the preview still comes
        // from the content file with its frontmatter stripped.
        let (broken, broken_preview) = by_name("broken.md");
        assert_eq!(broken.s_knn, 0.0);
        assert_eq!(broken.reason, "");
        assert_eq!(broken.expires, 0);
        assert_eq!(broken_preview.as_str(), "Body text here.");
        assert_eq!(by_name("orphan.md").0.expires, 0);

        // "Keep 7 more days" pushes only the sidecar that parses; the other two
        // are skipped rather than erroring the whole call.
        let files = vec![
            "_inbox/quarantine/good.md".to_string(),
            "_inbox/quarantine/broken.md".to_string(),
            "_inbox/quarantine/orphan.md".to_string(),
        ];
        let before = good.expires;
        assert_eq!(extend_quarantine(root, &files, 7).unwrap(), 1);
        let after = quarantine_entries(root)
            .into_iter()
            .find(|(e, _)| e.name == "good.md")
            .unwrap()
            .0
            .expires;
        assert_eq!(after, before + 7 * 86_400);
        // The vector survives the rewrite — the clustering pass still sees it.
        assert!(read_sidecar(root, "_inbox/quarantine/good.md")
            .unwrap()
            .is_some_and(|s| s.vector == vec![1.0, 0.0]));

        // Path confinement is the same one proposal payloads get.
        assert!(extend_quarantine(root, &["wiki/index.md".to_string()], 7).is_err());
    }

    #[test]
    fn five_similar_quarantined_items_produce_one_proposal() {
        crate::settings::test_support::with_isolated_data("distill-emerging-cluster", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            seed_semantic_store(root, 2);
            let quarantine = root.join("_inbox/quarantine");
            std::fs::create_dir_all(&quarantine).unwrap();
            for stem in ["a", "b", "c", "d", "e"] {
                write_quarantine_item(&quarantine, stem, vec![1.0, 0.0]);
            }

            let cfg = DistillConfig::default();
            let report = run(root, &cfg, &dummy_embed).unwrap();
            assert_eq!(report.proposals, 1);

            let proposal_files = |dir: &Path| -> Vec<std::fs::DirEntry> {
                std::fs::read_dir(dir)
                    .unwrap()
                    .flatten()
                    .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("md"))
                    .collect()
            };

            let entries = proposal_files(&root.join("work/feedback"));
            assert_eq!(entries.len(), 1);
            let content = std::fs::read_to_string(entries[0].path()).unwrap();
            assert!(content.contains("type: distill-proposal"));
            assert!(content.contains("action: admit-cluster"));
            assert!(content.contains("status: pending"));
            for stem in ["a", "b", "c", "d", "e"] {
                assert!(content.contains(&format!("_inbox/quarantine/{stem}.md")));
            }

            // Re-running without resolving the proposal must not duplicate it
            // — the no-dedup ceiling `write_proposal` used to have for every
            // proposal kind is fixed for `admit-cluster` specifically.
            let report2 = run(root, &cfg, &dummy_embed).unwrap();
            assert_eq!(
                report2.proposals, 0,
                "the same file set already has a pending proposal"
            );
            assert_eq!(
                proposal_files(&root.join("work/feedback")).len(),
                1,
                "still exactly one proposal file"
            );
        });
    }

    #[test]
    fn approved_admit_cluster_moves_files_back_to_inbox() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let quarantine = root.join("_inbox/quarantine");
        std::fs::create_dir_all(&quarantine).unwrap();
        write_quarantine_item(&quarantine, "a", vec![1.0, 0.0]);
        write_quarantine_item(&quarantine, "b", vec![1.0, 0.0]);

        let payload = serde_json::json!({
            "files": ["_inbox/quarantine/a.md", "_inbox/quarantine/b.md"],
        });
        let rel = write_proposal(
            root,
            "admit-cluster",
            "New topic forming: test",
            "body",
            &payload,
        )
        .unwrap();

        // Simulate the frontend's pending -> approved flip (Task 9) before
        // the apply command runs.
        let raw = std::fs::read_to_string(root.join(&rel)).unwrap();
        std::fs::write(
            root.join(&rel),
            raw.replace("status: pending", "status: approved"),
        )
        .unwrap();

        let result = apply_proposal(root, &rel).unwrap();
        assert_eq!(result, "moved 2, skipped 0 already-processed");

        assert!(root.join("_inbox/a.md").exists());
        assert!(root.join("_inbox/b.md").exists());
        assert!(!root.join("_inbox/quarantine/a.md").exists());
        assert!(!root.join("_inbox/quarantine/a.verdict.json").exists());
        assert!(!root.join("_inbox/quarantine/b.verdict.json").exists());

        let content = std::fs::read_to_string(root.join(&rel)).unwrap();
        assert!(content.contains("status: done"));
        assert!(
            content.contains("action: admit-cluster"),
            "rest of frontmatter is untouched"
        );
    }

    #[test]
    fn apply_proposal_resumes_after_a_half_applied_admit_cluster() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let quarantine = root.join("_inbox/quarantine");
        std::fs::create_dir_all(&quarantine).unwrap();
        write_quarantine_item(&quarantine, "a", vec![1.0, 0.0]);
        write_quarantine_item(&quarantine, "b", vec![1.0, 0.0]);

        let payload = serde_json::json!({
            "files": ["_inbox/quarantine/a.md", "_inbox/quarantine/b.md"],
        });
        let rel = write_proposal(
            root,
            "admit-cluster",
            "New topic forming: test",
            "body",
            &payload,
        )
        .unwrap();

        // Simulate a prior `apply_proposal` call that finished `a` (moved +
        // sidecar deleted, exactly what `apply_admit_cluster` itself does)
        // but crashed before reaching `b` or the `status: done` flip.
        std::fs::create_dir_all(root.join("_inbox")).unwrap();
        std::fs::rename(quarantine.join("a.md"), root.join("_inbox/a.md")).unwrap();
        std::fs::remove_file(quarantine.join("a.verdict.json")).unwrap();

        let result = apply_proposal(root, &rel).unwrap();
        assert_eq!(
            result, "moved 1, skipped 1 already-processed",
            "a.md is already gone from its payload path; only b.md is newly moved"
        );
        assert!(root.join("_inbox/b.md").exists());
        assert!(!quarantine.join("b.md").exists());
        let content = std::fs::read_to_string(root.join(&rel)).unwrap();
        assert!(content.contains("status: done"));

        // Applying an already-fully-done proposal again must not error —
        // every file is now "already processed".
        let result2 = apply_proposal(root, &rel).unwrap();
        assert_eq!(result2, "moved 0, skipped 2 already-processed");
    }

    #[test]
    fn apply_proposal_rejects_payload_paths_outside_the_actions_own_directory() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("wiki")).unwrap();
        std::fs::write(root.join("wiki/index.md"), "top page").unwrap();

        for kind in ["admit-cluster", "delete-batch"] {
            let rel = write_proposal(
                root,
                kind,
                &format!("{kind} escape attempt"),
                "body",
                &serde_json::json!({ "files": ["wiki/index.md"] }),
            )
            .unwrap();
            let err = apply_proposal(root, &rel).unwrap_err();
            assert!(
                err.contains("wiki/index.md"),
                "{kind}: unexpected error {err}"
            );
            assert!(
                root.join("wiki/index.md").exists(),
                "{kind} must not touch the file its payload was rejected on"
            );
        }
    }

    /// Owner decision 2026-10-03 (B1): an `archive-batch` proposal an older
    /// run left behind is retired when approved — marked done, no error, and
    /// raw/ stays put.
    #[test]
    fn an_old_archive_batch_proposal_is_retired_and_leaves_raw_alone() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("raw")).unwrap();
        std::fs::write(root.join("raw/paper.md"), PROSE).unwrap();
        let rel = write_proposal(
            root,
            "archive-batch",
            "Archive raw/paper.md?",
            "body",
            &serde_json::json!({ "files": ["raw/paper.md"] }),
        )
        .unwrap();
        assert!(apply_proposal(root, &rel).is_ok());
        assert!(std::fs::read_to_string(root.join(&rel))
            .unwrap()
            .contains("status: done"));
        assert_eq!(
            std::fs::read_to_string(root.join("raw/paper.md")).unwrap(),
            PROSE
        );
        assert!(!root.join("raw/archive").exists());
    }

    /// Follow-up to B1: the next run marks every unresolved `archive-batch`
    /// proposal done (pending, and an approved one whose apply failed)
    /// without moving anything in raw/, so it leaves the inbox.
    #[test]
    fn run_retires_old_archive_batch_proposals_without_touching_raw() {
        crate::settings::test_support::with_isolated_data(
            "distill-retire-archive-batch",
            |_data| {
                let dir = tempfile::tempdir().unwrap();
                let root = dir.path();
                std::fs::create_dir_all(root.join("_inbox")).unwrap();
                std::fs::create_dir_all(root.join("raw")).unwrap();
                std::fs::write(root.join("raw/paper.md"), PROSE).unwrap();
                let mut rels = Vec::new();
                for status in ["pending", "approved"] {
                    let rel = write_proposal(
                        root,
                        "archive-batch",
                        &format!("Archive raw/paper.md {status}"),
                        "body",
                        &serde_json::json!({ "files": ["raw/paper.md"] }),
                    )
                    .unwrap();
                    let raw = std::fs::read_to_string(root.join(&rel)).unwrap();
                    std::fs::write(
                        root.join(&rel),
                        raw.replace("status: pending", &format!("status: {status}")),
                    )
                    .unwrap();
                    rels.push(rel);
                }

                run(root, &DistillConfig::default(), &dummy_embed).unwrap();

                for rel in &rels {
                    assert!(!root.join(rel).exists(), "{rel} must leave the inbox");
                    let archived = root
                        .join("work/feedback/archive")
                        .join(Path::new(rel).file_name().unwrap());
                    assert!(std::fs::read_to_string(archived)
                        .unwrap()
                        .contains("status: done"));
                }
                assert_eq!(
                    std::fs::read_to_string(root.join("raw/paper.md")).unwrap(),
                    PROSE
                );
                assert!(!root.join("raw/archive").exists());
            },
        );
    }

    /// Retiring is cleanup: an `archive-batch` proposal the run cannot mark
    /// done (read-only file) is skipped and stays listed instead of failing
    /// the whole run on every later run too.
    #[cfg(unix)]
    #[test]
    fn run_skips_an_archive_batch_proposal_it_cannot_write() {
        use std::os::unix::fs::PermissionsExt;
        crate::settings::test_support::with_isolated_data("distill-retire-readonly", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            std::fs::create_dir_all(root.join("_inbox")).unwrap();
            std::fs::create_dir_all(root.join("raw")).unwrap();
            let rel = write_proposal(
                root,
                "archive-batch",
                "Archive raw/paper.md",
                "body",
                &serde_json::json!({ "files": ["raw/paper.md"] }),
            )
            .unwrap();
            let path = root.join(&rel);
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444)).unwrap();

            run(root, &DistillConfig::default(), &dummy_embed).unwrap();
            run(root, &DistillConfig::default(), &dummy_embed).unwrap();

            assert!(path.exists(), "the unwritable proposal stays listed");
            assert!(std::fs::read_to_string(&path)
                .unwrap()
                .contains("status: pending"));
        });
    }

    #[test]
    fn delete_batch_applies_the_same_move_semantics_as_run() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let quarantine = root.join("_inbox/quarantine");
        std::fs::create_dir_all(&quarantine).unwrap();
        write_quarantine_item(&quarantine, "old", vec![1.0, 0.0]);
        let delete_rel = write_proposal(
            root,
            "delete-batch",
            "Delete expired quarantine item old.md?",
            "body",
            &serde_json::json!({ "files": ["_inbox/quarantine/old.md"] }),
        )
        .unwrap();
        apply_proposal(root, &delete_rel).unwrap();
        assert!(!quarantine.join("old.md").exists());
        assert!(!quarantine.join("old.verdict.json").exists());
        let slug = Path::new(&delete_rel)
            .file_stem()
            .unwrap()
            .to_str()
            .unwrap();
        let trash_dir = root.join(".myco/trash").join(slug);
        assert!(trash_dir.join("old.md").exists());
        assert!(trash_dir.join("old.verdict.json").exists());
    }

    #[test]
    fn dismissed_proposals_are_archived_by_next_run() {
        crate::settings::test_support::with_isolated_data(
            "distill-dismissed-proposal-archive",
            |_data| {
                let dir = tempfile::tempdir().unwrap();
                let root = dir.path();
                std::fs::create_dir_all(root.join("_inbox")).unwrap();

                let rel = write_proposal(
                    root,
                    "archive-batch",
                    "Archive raw/x.md?",
                    "body",
                    &serde_json::json!({ "files": ["raw/x.md"] }),
                )
                .unwrap();
                let raw = std::fs::read_to_string(root.join(&rel)).unwrap();
                std::fs::write(
                    root.join(&rel),
                    raw.replace("status: pending", "status: dismissed"),
                )
                .unwrap();

                let cfg = DistillConfig::default();
                run(root, &cfg, &dummy_embed).unwrap();

                assert!(
                    !root.join(&rel).exists(),
                    "resolved proposal must leave work/feedback/"
                );
                let file_name = Path::new(&rel).file_name().unwrap();
                assert!(root.join("work/feedback/archive").join(file_name).exists());
            },
        );
    }

    #[test]
    fn run_does_not_archive_an_approved_but_unapplied_proposal() {
        crate::settings::test_support::with_isolated_data(
            "distill-approved-proposal-survives-run",
            |_data| {
                let dir = tempfile::tempdir().unwrap();
                let root = dir.path();
                std::fs::create_dir_all(root.join("_inbox")).unwrap();

                // Not `archive-batch`: a run retires those whatever their status.
                let rel = write_proposal(
                    root,
                    "delete-batch",
                    "Delete expired quarantine item x.md?",
                    "body",
                    &serde_json::json!({ "files": ["_inbox/quarantine/x.md"] }),
                )
                .unwrap();
                // Simulate the frontend's pending -> approved flip, then the
                // idle run firing before `apply_proposal` is ever called.
                let raw = std::fs::read_to_string(root.join(&rel)).unwrap();
                std::fs::write(
                    root.join(&rel),
                    raw.replace("status: pending", "status: approved"),
                )
                .unwrap();

                let cfg = DistillConfig::default();
                run(root, &cfg, &dummy_embed).unwrap();

                assert!(
                    root.join(&rel).exists(),
                    "an approved-but-unapplied proposal must not be swept into the archive"
                );
                let file_name = Path::new(&rel).file_name().unwrap();
                assert!(!root.join("work/feedback/archive").join(file_name).exists());
            },
        );
    }

    /// Ledger-triage fix 7: a stuck `approved` proposal (apply failed, or the
    /// frontend flipped it but `apply_proposal` hasn't run yet) must not drop
    /// off the badge/Overview count — only `done`/`dismissed` are resolved.
    #[test]
    fn status_pending_proposals_counts_approved_too() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("_inbox")).unwrap();

        write_proposal(
            root,
            "archive-batch",
            "Archive raw/x.md?",
            "body",
            &serde_json::json!({ "files": ["raw/x.md"] }),
        )
        .unwrap();

        let approved_rel = write_proposal(
            root,
            "admit-cluster",
            "New topic forming",
            "body",
            &serde_json::json!({ "files": [] }),
        )
        .unwrap();
        let raw = std::fs::read_to_string(root.join(&approved_rel)).unwrap();
        std::fs::write(
            root.join(&approved_rel),
            raw.replace("status: pending", "status: approved"),
        )
        .unwrap();

        let dismissed_rel = write_proposal(
            root,
            "delete-batch",
            "Old, resolved",
            "body",
            &serde_json::json!({ "files": [] }),
        )
        .unwrap();
        let raw = std::fs::read_to_string(root.join(&dismissed_rel)).unwrap();
        std::fs::write(
            root.join(&dismissed_rel),
            raw.replace("status: pending", "status: dismissed"),
        )
        .unwrap();

        assert_eq!(
            status(root).pending_proposals,
            2,
            "pending + approved count; dismissed does not"
        );
    }

    // -----------------------------------------------------------------------
    // Task 4, Phase B: map-candidate detection + proposal.
    // -----------------------------------------------------------------------

    #[test]
    fn map_candidate_proposal_respects_min_members_and_maturity() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        // 7 mature members...
        let mut members: Vec<String> = Vec::new();
        for i in 0..7 {
            let rel = format!("wiki/m{i}.md");
            write_wiki_member(root, &rel, "active", "medium", map_mature_mtime());
            members.push(rel);
        }
        // ...plus 3 disqualified ones: low confidence, non-active status, and
        // too fresh — kept lands at 7, one short of MAP_MIN_MEMBERS (8).
        write_wiki_member(root, "wiki/low.md", "active", "low", map_mature_mtime());
        members.push("wiki/low.md".into());
        write_wiki_member(
            root,
            "wiki/superseded.md",
            "superseded",
            "medium",
            map_mature_mtime(),
        );
        members.push("wiki/superseded.md".into());
        write_wiki_member(
            root,
            "wiki/fresh.md",
            "active",
            "medium",
            std::time::SystemTime::now(),
        );
        members.push("wiki/fresh.md".into());

        let o = ontology_with_cluster(0, "cluster-a", members);
        let cfg = DistillConfig::default();
        let mut manifest = test_manifest();

        let proposal_files = |dir: &Path| -> Vec<std::fs::DirEntry> {
            std::fs::read_dir(dir)
                .into_iter()
                .flatten()
                .flatten()
                .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("md"))
                .collect()
        };

        let written = propose_map_candidates(root, &o, &cfg, &mut manifest).unwrap();
        assert_eq!(written, 0, "7 mature members < MAP_MIN_MEMBERS (8)");
        assert!(proposal_files(&root.join("work/feedback")).is_empty());

        // Bring the low-confidence member up to mature — now exactly 8, the
        // "all active" case: a proposal with the full kept-member payload.
        write_wiki_member(root, "wiki/low.md", "active", "medium", map_mature_mtime());
        let written2 = propose_map_candidates(root, &o, &cfg, &mut manifest).unwrap();
        assert_eq!(written2, 1);
        let entries = proposal_files(&root.join("work/feedback"));
        assert_eq!(entries.len(), 1);
        let content = std::fs::read_to_string(entries[0].path()).unwrap();
        assert!(content.contains("action: draft-map"));
        assert!(content.contains("status: pending"));
        assert!(content.contains("cluster-a"));
        for i in 0..7 {
            assert!(content.contains(&format!("wiki/m{i}.md")));
        }
        assert!(content.contains("wiki/low.md"));
        assert!(
            !content.contains("wiki/superseded.md"),
            "the non-active member must not be in the kept payload"
        );
        assert!(
            !content.contains("wiki/fresh.md"),
            "the too-fresh member must not be in the kept payload"
        );

        // Re-running must not duplicate — dedup on the cluster label.
        let written3 = propose_map_candidates(root, &o, &cfg, &mut manifest).unwrap();
        assert_eq!(
            written3, 0,
            "a pending draft-map proposal for this cluster already exists"
        );
        assert_eq!(proposal_files(&root.join("work/feedback")).len(), 1);
    }

    #[test]
    fn field_cluster_never_becomes_a_map_candidate() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut members: Vec<String> = Vec::new();
        for i in 0..10 {
            let rel = format!("wiki/m{i}.md");
            write_wiki_member(root, &rel, "active", "medium", map_mature_mtime());
            members.push(rel);
        }
        // Real "field" clusters always carry this id (`assemble_cluster`'s
        // `force_label` path) — 10 mature members clears MAP_MIN_MEMBERS on
        // its own, so only the id check can be what stops this.
        let o = ontology_with_cluster(FIELD_CLUSTER_ID, "field", members);
        let cfg = DistillConfig::default();
        let mut manifest = test_manifest();

        let written = propose_map_candidates(root, &o, &cfg, &mut manifest).unwrap();
        assert_eq!(
            written, 0,
            "the catch-all field cluster is not a real topic"
        );
        assert!(
            !root.join("work/feedback").exists(),
            "no proposal was written at all"
        );
    }

    #[test]
    fn map_exists_check_matches_by_any_member_stem_not_just_the_current_label() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        // The cluster's label has drifted since its map was drafted — a new
        // medoid won the recompute — but the original member ("old-medoid")
        // is still one of this cluster's members.
        let mut members: Vec<String> = vec!["wiki/old-medoid.md".into()];
        for i in 0..7 {
            members.push(format!("wiki/m{i}.md"));
        }
        for m in &members {
            write_wiki_member(root, m, "active", "medium", map_mature_mtime());
        }
        let o = ontology_with_cluster(0, "new-medoid", members);

        std::fs::create_dir_all(root.join("wiki/maps")).unwrap();
        std::fs::write(
            root.join("wiki/maps/old-medoid.md"),
            "---\ntitle: \"Map: old-medoid\"\ntype: map\ncluster: old-medoid\ncreated: 2026-01-01\nconfidence: medium\nstatus: draft\n---\n\nbody\n",
        )
        .unwrap();

        let cfg = DistillConfig::default();
        let mut manifest = test_manifest();
        let written = propose_map_candidates(root, &o, &cfg, &mut manifest).unwrap();
        assert_eq!(
            written, 0,
            "the drifted label must still match via the old medoid, which is still a member"
        );
    }

    #[test]
    fn pending_draft_map_dedup_matches_by_member_overlap_when_the_label_drifted() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        // 8 mature members — the exact set a PENDING proposal (written
        // below, under an OLDER label) already names. The cluster's label
        // has since drifted to a new medoid, but its members are unchanged.
        let mut members: Vec<String> = Vec::new();
        for i in 0..8 {
            let rel = format!("wiki/m{i}.md");
            write_wiki_member(root, &rel, "active", "medium", map_mature_mtime());
            members.push(rel);
        }
        let o = ontology_with_cluster(0, "new-label", members.clone());

        write_proposal(
            root,
            "draft-map",
            "Map candidate: old-label",
            "body",
            &serde_json::json!({ "cluster": "old-label", "members": members }),
        )
        .unwrap();

        let cfg = DistillConfig::default();
        let mut manifest = test_manifest();
        let written = propose_map_candidates(root, &o, &cfg, &mut manifest).unwrap();
        assert_eq!(
            written, 0,
            "drifted label but >=50% overlapping members must not duplicate the pending proposal"
        );
    }

    #[test]
    fn map_anchors_from_store_reads_cluster_frontmatter_under_wiki_maps() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("wiki/maps")).unwrap();
        std::fs::write(
            root.join("wiki/maps/topic-a.md"),
            "---\ntitle: \"Map: topic-a\"\ntype: map\ncluster: topic-a\ncreated: 2026-01-01\nconfidence: medium\nstatus: active\n---\n\nbody\n",
        )
        .unwrap();
        // A non-map wiki page must never contribute an anchor even if it
        // happened to carry a `cluster:` field of its own.
        std::fs::write(
            root.join("wiki/other.md"),
            "---\ntitle: Other\ntype: concept\ncluster: not-an-anchor\ncreated: 2026-01-01\nconfidence: medium\nstatus: active\n---\n\nbody\n",
        )
        .unwrap();

        let mut store = crate::vector_index::VectorStore {
            dim: 2,
            ..Default::default()
        };
        store.records.push(crate::vector_index::Record {
            id: "wiki/maps/topic-a.md#0".into(),
            page: "wiki/maps/topic-a.md".into(),
            stem: "topic-a".into(),
            section: 0,
            hash: crate::embeddings::content_hash(
                &crate::embeddings::chunk_page(
                    &std::fs::read_to_string(root.join("wiki/maps/topic-a.md")).unwrap(),
                )[0],
            ),
            vector: vec![0.6, 0.8],
        });
        store.records.push(crate::vector_index::Record {
            id: "wiki/other.md#0".into(),
            page: "wiki/other.md".into(),
            stem: "other".into(),
            section: 0,
            hash: 0,
            vector: vec![1.0, 0.0],
        });

        let anchors = map_anchors_from_store(root, &store).unwrap();
        assert_eq!(anchors, vec![("topic-a".to_string(), vec![0.6, 0.8])]);
    }

    // -----------------------------------------------------------------------
    // Weekly rollup (ROADMAP P1) — the same five properties the session-digest
    // suite above asserts, one compression layer up.
    // -----------------------------------------------------------------------

    /// Writes `daily/<day>.md` with `body` and a mature mtime, and returns its
    /// rel path — the shape `rollupable_buckets` wants.
    /// A `YYYY-MM-DD` string `days` before now. Week fixtures must sit in the
    /// PAST: `rollupable_buckets` never offers the week still in progress, so a
    /// hard-coded date silently stops being rollable during its own week.
    fn days_ago(days: i64) -> String {
        let (y, m, d, ..) = civil_datetime(now_secs() - days * 86_400);
        format!("{y:04}-{m:02}-{d:02}")
    }

    fn settled_daily(root: &Path, day: &str, body: &str) -> String {
        let rel = format!("daily/{day}.md");
        let path = root.join(&rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, body).unwrap();
        set_mtime(&path, old_mtime());
        rel
    }

    /// `weekly/<week>.md` with a mature mtime — the monthly layer's source
    /// file, the exact counterpart of `settled_daily` one tier down.
    fn settled_weekly(root: &Path, week: &str, body: &str) -> String {
        let rel = format!("weekly/{week}.md");
        let path = root.join(&rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, body).unwrap();
        set_mtime(&path, old_mtime());
        rel
    }

    /// The rollup marker line `appendRollup` (src/lib/weeklyRollup.ts) writes
    /// into `weekly/<week>.md` in the same write as its bullets.
    fn write_weekly_with_marker(root: &Path, week: &str, entries: &[&str]) {
        std::fs::create_dir_all(root.join("weekly")).unwrap();
        std::fs::write(
            root.join(format!("weekly/{week}.md")),
            format!(
                "# {week}\n\n## Weekly rollup\n{}{} {}\n- decided a thing\n",
                ROLLUP_MARKER_OPEN,
                entries.join(" "),
                DIGEST_MARKER_CLOSE,
            ),
        )
        .unwrap();
    }

    #[test]
    fn iso_week_follows_the_thursday_rule_and_rejects_non_dates() {
        // Mid-week, both ends of a week, and the Monday that starts the next.
        assert_eq!(iso_week("2026-08-12").as_deref(), Some("2026-W33"));
        assert_eq!(iso_week("2026-08-10").as_deref(), Some("2026-W33")); // Monday
        assert_eq!(iso_week("2026-08-16").as_deref(), Some("2026-W33")); // Sunday
        assert_eq!(iso_week("2026-08-17").as_deref(), Some("2026-W34"));
        // Year boundaries, which is the whole reason for the Thursday rule:
        // 2027-01-01 (a Friday) still belongs to 2026-W53, and 2021-01-01
        // (also a Friday) to 2020-W53 — so a straddling week is rolled up once,
        // under one name, not twice under two.
        assert_eq!(iso_week("2026-12-31").as_deref(), Some("2026-W53"));
        assert_eq!(iso_week("2027-01-01").as_deref(), Some("2026-W53"));
        assert_eq!(iso_week("2021-01-01").as_deref(), Some("2020-W53"));
        assert_eq!(iso_week("2026-01-05").as_deref(), Some("2026-W02"));
        // Anything that is not a real civil date never joins a rollup.
        assert!(iso_week("2026-02-31").is_none());
        assert!(iso_week("2026-13-01").is_none());
        assert!(iso_week("notes").is_none());
        assert!(iso_week("2026-08-1").is_none());
    }

    #[test]
    fn rollupable_weeks_never_offers_the_week_still_in_progress() {
        crate::settings::test_support::with_isolated_data("distill-rollup-current", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            // Two settled notes dated inside the CURRENT week: mature by file
            // age, but the week has days left. Rolling it up would charge once
            // per remaining day and cold-tier this week's notes mid-week.
            let (y, m, d, ..) = civil_datetime(now_secs());
            let today = format!("{y:04}-{m:02}-{d:02}");
            let this_week = iso_week(&today).unwrap();
            settled_daily(root, &today, "# today\n- a\n");
            let weeks = rollupable_buckets(root, &WEEKLY);
            assert!(
                !weeks.iter().any(|w| w.bucket == this_week),
                "the in-progress week must never be offered: {weeks:?}"
            );
        });
    }

    #[test]
    fn rollupable_weeks_skips_a_week_with_one_immature_daily() {
        crate::settings::test_support::with_isolated_data("distill-rollup-immature", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            settled_daily(root, "2026-08-10", "# 2026-08-10\n- a\n");
            settled_daily(root, "2026-08-11", "# 2026-08-11\n- b\n");
            assert_eq!(rollupable_buckets(root, &WEEKLY).len(), 1, "both mature");

            // One fresh daily note in the same week holds the WHOLE week back —
            // the fully-scored-day rule, one layer up: that file is still being
            // appended to, and rolling it up now buys the same week twice.
            let fresh = root.join("daily/2026-08-12.md");
            std::fs::write(&fresh, "# 2026-08-12\n- c\n").unwrap();
            assert!(
                rollupable_buckets(root, &WEEKLY).is_empty(),
                "one immature daily skips the week"
            );

            // A different week is unaffected by its neighbour's straggler.
            settled_daily(root, "2026-08-03", "# 2026-08-03\n- old\n");
            let weeks = rollupable_buckets(root, &WEEKLY);
            assert_eq!(weeks.len(), 1);
            assert_eq!(weeks[0].bucket, "2026-W32");
        });
    }

    #[test]
    fn rollupable_weeks_groups_by_iso_week_oldest_first() {
        crate::settings::test_support::with_isolated_data("distill-rollup-groups", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            // Two adjacent past weeks, relative to now (see days_ago).
            let older = days_ago(21); // week A
            let older2 = days_ago(17); // same week A (21 and 17 share a week
            let newer = days_ago(14); //   only if 21 is Mon..Thu — asserted below)
            settled_daily(root, &older, "# a\n- a\n");
            settled_daily(root, &older2, "# b\n- b\n");
            settled_daily(root, &newer, "# c\n- c\n");
            let week_a = iso_week(&older).unwrap();
            let week_c = iso_week(&newer).unwrap();

            // Not a date, and not markdown — neither joins a week.
            std::fs::write(root.join("daily/notes.md"), "hand-written\n").unwrap();
            std::fs::write(root.join("daily/x.txt"), "2026-08-10\n").unwrap();

            let weeks = rollupable_buckets(root, &WEEKLY);
            // Oldest week first; every offered week is in the past.
            assert!(weeks.len() >= 2, "{weeks:?}");
            assert_eq!(weeks[0].bucket, week_a.min(iso_week(&older2).unwrap()));
            assert!(weeks.iter().any(|w| w.bucket == week_c));
            let ordered: Vec<String> = weeks.iter().map(|w| w.bucket.clone()).collect();
            let sorted = {
                let mut c = ordered.clone();
                c.sort();
                c
            };
            assert_eq!(ordered, sorted, "weeks must come oldest first");
            assert!(
                weeks
                    .iter()
                    .flat_map(|w| w.files.iter())
                    .all(|f| f.starts_with("daily/") && f.ends_with(".md")),
                "only daily markdown joins a week: {weeks:?}"
            );
        });
    }

    #[test]
    fn rollupable_weeks_routes_already_recorded_days_to_archive_retry() {
        crate::settings::test_support::with_isolated_data("distill-rollup-idempotent", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            let files: Vec<String> = ["2026-08-10", "2026-08-11"]
                .iter()
                .map(|d| settled_daily(root, d, &format!("# {d}\n- {d}\n")))
                .collect();

            let weeks = rollupable_buckets(root, &WEEKLY);
            assert_eq!(weeks.len(), 1);
            assert!(!weeks[0].already_rolled, "nothing recorded yet");

            // The rollup landed (marker + bullets, one write) but the archive
            // that follows it failed — the daily files are still in daily/.
            let entries: Vec<String> = files.iter().map(|f| marker_entry(root, f)).collect();
            write_weekly_with_marker(
                root,
                "2026-W33",
                &entries.iter().map(String::as_str).collect::<Vec<_>>(),
            );

            // Still OFFERED (nothing archived yet) but FLAGGED, so the caller
            // retries only the move and never pays for a second rollup.
            let weeks = rollupable_buckets(root, &WEEKLY);
            assert_eq!(weeks.len(), 1);
            assert!(weeks[0].already_rolled);
            assert_eq!(weeks[0].files, files);

            // A failed archive attempt leaves the record in weekly/ untouched.
            assert!(archive_rolled(root, &WEEKLY, "not-a-week", &files, None).is_err());
            assert!(rollupable_buckets(root, &WEEKLY)[0].already_rolled);

            // Once the move succeeds the days leave daily/ for the cold tier
            // and the week disappears — nothing left to roll up or retry.
            archive_rolled(root, &WEEKLY, "2026-W33", &files, None).unwrap();
            assert!(rollupable_buckets(root, &WEEKLY).is_empty());
            for f in &files {
                assert!(!root.join(f).exists(), "{f} should have moved");
                let cold = format!("daily/archive/2026-W33/{}", f.rsplit('/').next().unwrap());
                assert!(root.join(&cold).exists(), "{cold} should exist");
                assert!(
                    crate::vector_index::is_cold(&cold),
                    "{cold} must be cold so the next prune drops its records"
                );
            }
        });
    }

    #[test]
    fn rollupable_weeks_offers_only_the_new_days_of_a_partly_recorded_week() {
        crate::settings::test_support::with_isolated_data("distill-rollup-late-day", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            let old = settled_daily(root, "2026-08-10", "# a\n- a\n");
            write_weekly_with_marker(root, "2026-W33", &[&marker_entry(root, &old)]);
            let new = settled_daily(root, "2026-08-11", "# b\n- b\n");

            let weeks = rollupable_buckets(root, &WEEKLY);
            assert_eq!(weeks.len(), 1);
            assert!(!weeks[0].already_rolled);
            assert_eq!(weeks[0].files, vec![new.clone()]);
        });
    }

    #[test]
    fn rollupable_weeks_rerolls_a_daily_note_that_grew_after_it_was_recorded() {
        crate::settings::test_support::with_isolated_data("distill-rollup-grew", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            let rel = settled_daily(root, "2026-08-10", "# a\n- first section\n");
            let recorded = marker_entry(root, &rel);
            write_weekly_with_marker(root, "2026-W33", &[&recorded]);
            assert!(rollupable_buckets(root, &WEEKLY)[0].already_rolled);

            // A later session digest appended another section to the same day
            // (or the user edited it). The name is unchanged, so a name-keyed
            // record would archive the grown file with its new half never
            // rolled up; the content-bound marker misses instead.
            let path = root.join(&rel);
            std::fs::write(&path, "# a\n- first section\n- second section\n").unwrap();
            set_mtime(&path, old_mtime());
            let weeks = rollupable_buckets(root, &WEEKLY);
            assert_eq!(weeks.len(), 1);
            assert!(!weeks[0].already_rolled);

            // And the archive refuses to move it under the stale fingerprint,
            // so the new half can never be lost to the cold tier.
            archive_rolled(
                root,
                &WEEKLY,
                "2026-W33",
                std::slice::from_ref(&rel),
                Some(&[recorded.rsplit(':').next().unwrap().to_string()]),
            )
            .unwrap();
            assert!(
                root.join(&rel).exists(),
                "a changed day must stay in daily/"
            );
        });
    }

    #[test]
    fn archive_rolled_days_manifest_round_trips_through_undo() {
        crate::settings::test_support::with_isolated_data("distill-rollup-undo", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            let rel = settled_daily(root, "2026-08-10", "# a\n- a\n");
            let fp = file_fingerprint(root, &rel);
            write_weekly_with_marker(root, "2026-W33", &[&marker_entry(root, &rel)]);

            let id = archive_rolled(
                root,
                &WEEKLY,
                "2026-W33",
                std::slice::from_ref(&rel),
                Some(&[fp]),
            )
            .unwrap()
            .manifest_id;
            assert!(id.starts_with("digest-"), "{id}");
            // The TS step folds the weekly file it created into the SAME
            // manifest, exactly as the session digest does for its daily file.
            append_distill_manifest(root, &id, vec![], vec!["weekly/2026-W33.md".to_string()])
                .unwrap();
            assert!(!root.join(&rel).exists());

            assert_eq!(undo(root, &id).unwrap(), 2);
            assert!(root.join(&rel).exists(), "the daily note came back");
            assert!(
                !root.join("weekly/2026-W33.md").exists(),
                "the rollup this run created is gone"
            );
        });
    }

    // -----------------------------------------------------------------------
    // Monthly rollup — the same machinery a third time (`weekly/` ->
    // `monthly/`). Only what differs from the weekly layer is retested here:
    // the bucket mapping (a week belongs to the month of its Thursday), the
    // in-progress-month exclusion, and the confine over `weekly/`.
    // -----------------------------------------------------------------------

    #[test]
    fn a_week_belongs_to_the_month_holding_its_thursday() {
        // 2026-W40 runs Mon 2026-09-28 .. Sun 2026-10-04; its Thursday is
        // 2026-10-01, so the whole week counts against October and can never
        // be rolled up into September as well.
        assert_eq!(month_of_iso_week("2026-W40").as_deref(), Some("2026-10"));
        // 2026-W39 (Mon 09-21 .. Sun 09-27) sits wholly inside September.
        assert_eq!(month_of_iso_week("2026-W39").as_deref(), Some("2026-09"));
        // 2027-W01's Thursday is 2027-01-07 — the week that starts in the old
        // year still counts against the new one, matching `iso_week`.
        assert_eq!(month_of_iso_week("2026-W53").as_deref(), Some("2026-12"));
        // 2026 has 52 ISO weeks, so W53 of 2025 is not a real week name.
        assert_eq!(month_of_iso_week("2025-W53"), None);
        for bad in ["2026-08", "not-a-week", "2026-W0a", "2026-W1"] {
            assert_eq!(month_of_iso_week(bad), None, "{bad}");
        }
    }

    #[test]
    fn rollupable_months_never_offers_the_month_still_in_progress() {
        crate::settings::test_support::with_isolated_data("distill-monthly-current", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            // This week's rollup file, mature on disk — its month is still
            // running, so offering it would archive the current month's
            // weeklies mid-month and re-charge every remaining week.
            let this_week = iso_week(&days_ago(0)).unwrap();
            settled_weekly(root, &this_week, "# w\n- a\n");
            let (y, m, ..) = civil_datetime(now_secs());
            let this_month = format!("{y:04}-{m:02}");

            let months = rollupable_buckets(root, &MONTHLY);
            assert!(
                !months.iter().any(|b| b.bucket == this_month),
                "the month in progress must never be offered: {months:?}"
            );
        });
    }

    #[test]
    fn rollupable_months_group_weeklies_and_archive_them_under_weekly_archive() {
        crate::settings::test_support::with_isolated_data("distill-monthly-roll", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            // Two weeks of a month that is already over — a hard-coded month
            // would stop being rollable during its own month, the same trap
            // `days_ago` exists for one layer down. Days 10 and 17 are far
            // enough from either edge that each week's Thursday (within +-3
            // days) is still inside the month.
            let (cy, cm, ..) = civil_datetime(now_secs());
            let total = cy * 12 + i64::from(cm) - 1 - 2;
            let (py, pm) = (total.div_euclid(12), total.rem_euclid(12) as u32 + 1);
            let month = format!("{py:04}-{pm:02}");
            let week_a = iso_week(&format!("{month}-10")).unwrap();
            let week_b = iso_week(&format!("{month}-17")).unwrap();
            let a = settled_weekly(root, &week_a, "# w-a\n- a\n");
            let b = settled_weekly(root, &week_b, "# w-b\n- b\n");

            let months = rollupable_buckets(root, &MONTHLY);
            let august = months
                .iter()
                .find(|m| m.bucket == month)
                .unwrap_or_else(|| panic!("both weeks fall in {month}: {months:?}"));
            assert_eq!(august.files, vec![a.clone(), b.clone()]);
            assert!(!august.already_rolled);

            let fps = vec![file_fingerprint(root, &a), file_fingerprint(root, &b)];
            let id = archive_rolled(root, &MONTHLY, &month, &[a.clone(), b.clone()], Some(&fps))
                .unwrap()
                .manifest_id;
            assert!(id.starts_with("digest-"), "{id}");
            let moved = format!("weekly/archive/{month}/{week_a}.md");
            assert!(
                root.join(&moved).exists(),
                "a rolled-up weekly goes cold under weekly/archive/<month>/"
            );
            assert!(!root.join(&a).exists() && !root.join(&b).exists());
            // Cold tier, so the active index must drop it — the same rule
            // `daily/archive/` gets one layer down.
            assert!(crate::vector_index::is_cold(&moved));

            assert_eq!(undo(root, &id).unwrap(), 2);
            assert!(root.join(&a).exists() && root.join(&b).exists());
        });
    }

    #[test]
    fn archive_rolled_monthly_rejects_a_bad_bucket_or_a_path_outside_weekly() {
        crate::settings::test_support::with_isolated_data("distill-monthly-confine", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            // A month bucket, not a week one — and `2026-13` is digits that
            // are not a month.
            for bad in ["2026-W33", "2026-13", "2026-8", "not-a-month"] {
                assert!(
                    archive_rolled(root, &MONTHLY, bad, &[], None).is_err(),
                    "{bad} must be rejected as a month bucket"
                );
            }
            for bad in [
                "../outside.md",
                "wiki/note.md",
                "daily/2026-08-10.md",
                "weekly/archive/2026-08/2026-W33.md",
                "weekly/nested/2026-W33.md",
            ] {
                assert!(
                    archive_rolled(root, &MONTHLY, "2026-08", &[bad.to_string()], None).is_err(),
                    "{bad} must be rejected"
                );
            }
        });
    }

    #[test]
    fn archive_rolled_days_rejects_a_path_outside_daily() {
        crate::settings::test_support::with_isolated_data("distill-rollup-confine", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            for bad in [
                "../outside.md",
                "wiki/note.md",
                "daily/archive/2026-W33/2026-08-10.md",
                "daily/nested/2026-08-10.md",
            ] {
                assert!(
                    archive_rolled(root, &WEEKLY, "2026-W33", &[bad.to_string()], None).is_err(),
                    "{bad} must be rejected"
                );
            }
        });
    }
}
