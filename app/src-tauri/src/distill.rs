// Per-vault distillation config. Persists to `<vault>/.myco/distill.json` with
// atomic write (tmp + rename) and missing/corrupt file → defaults. Follows the
// same persistence pattern as schedules.rs.

use std::path::{Path, PathBuf};

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
    #[serde(default)]
    pub dormancy_decay: bool,
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

use crate::ontology::{admit, Ontology, Tier, Verdict};
use std::collections::HashMap;

/// One item's last-scored fingerprint, so an unchanged file is never
/// re-embedded on a later scan.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ScoredEntry {
    pub hash: u64,
    pub tier: String,
    pub at: i64,
}

/// Persisted scan state, `<vault>/.myco/distill-state.json`. `model` gates the
/// whole ledger the same way `Ontology.model` gates the cache scored against:
/// an embedding-model change makes every past score meaningless (different
/// vector geometry), so a mismatch invalidates the ledger wholesale rather
/// than being compared entry-by-entry.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct DistillState {
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub scored: HashMap<String, ScoredEntry>,
    #[serde(default)]
    pub rejected_ttl: HashMap<String, i64>,
    /// Unix seconds of the last completed `run`, for the status view.
    #[serde(default)]
    pub last_run: Option<i64>,
    /// Rolling window (capped at 10, oldest first) of the post-run backlog
    /// count each `run` appended — the trend line the badge shows instead of
    /// a raw count. Resets with the rest of the ledger on a model change,
    /// same as `scored`/`rejected_ttl`: nothing here is model-independent
    /// history worth special-casing.
    #[serde(default)]
    pub last_backlogs: Vec<usize>,
}

pub fn state_path(root: &Path) -> PathBuf {
    dir(root).join("distill-state.json")
}

/// Load the ledger, or a fresh one (stamped with `model`) if there is none yet
/// or it was scored against a different embedding model.
pub fn state_load(root: &Path, model: &str) -> DistillState {
    let fresh = || DistillState {
        model: model.to_string(),
        ..Default::default()
    };
    let Ok(raw) = std::fs::read_to_string(state_path(root)) else {
        return fresh();
    };
    let state: DistillState = serde_json::from_str(&raw).unwrap_or_else(|_| fresh());
    if state.model != model {
        return fresh();
    }
    state
}

/// Atomic write: stage to a temp file in the same dir, then rename over target.
pub fn state_save(root: &Path, s: &DistillState) -> Result<(), String> {
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
}

/// The one subdirectory of `_inbox/` that is NOT inflow (it holds this scan's
/// own output) — never walked, never re-scored.
const QUARANTINE_DIR: &str = "quarantine";
/// The one subdirectory of `raw/` that is NOT inflow (retired sources) — see
/// `app/docs/specs/2026-08-13-distill-calibration.md`.
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
fn junk_reason(content: &str) -> Option<String> {
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

fn tier_str(t: Tier) -> &'static str {
    match t {
        Tier::Full => "full",
        Tier::Summary => "summary",
        Tier::Quarantine => "quarantine",
        Tier::Reject => "reject",
    }
}

/// One candidate inflow file: its vault-relative path (forward slashes), its
/// absolute path, and its mtime (unix seconds) for the oldest-first order and
/// the maturation gate.
struct Candidate {
    rel: String,
    path: PathBuf,
    mtime: i64,
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
                out.push(Candidate { rel, path, mtime });
            }
        }
    }
    walk(&root.join(start), root, exclude_top, true, out);
}

/// Every inflow candidate across the three trees the gate watches, oldest
/// mtime first (ties broken by path for a deterministic order). Never walks
/// `.myco/` (not one of these trees at all), `_inbox/quarantine/`, or
/// `raw/archive/`.
fn collect_candidates(root: &Path) -> Vec<Candidate> {
    let mut out = Vec::new();
    walk_inflow(
        root,
        crate::commands::DEST_INBOX,
        &[QUARANTINE_DIR],
        &mut out,
    );
    walk_inflow(root, "raw", &[RAW_ARCHIVE_DIR], &mut out);
    walk_inflow(root, crate::commands::DEST_SESSIONS, &[], &mut out);
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
}

/// A candidate that passed the maturation gate and the ledger's
/// unchanged-content check — i.e. it will be scored this run.
struct Taken {
    rel: String,
    path: PathBuf,
    content: String,
    hash: u64,
    junk: Option<String>,
}

/// Score new inflow against the ontology: walk `_inbox/`, `raw/`, `sessions/`
/// oldest-mtime-first, skip anything not yet mature (`cfg.maturation_hours`)
/// or already scored at its current content hash, reject junk transcripts
/// without spending an embedding, batch-embed the rest and run them through
/// `ontology::admit`, then act on the verdict: quarantine moves the file into
/// `_inbox/quarantine/` with a verdict sidecar, reject adds a
/// `rejected_ttl` ledger entry (the file stays put — Task 6's run trashes
/// expired ones), full/summary are only recorded (Phase B consumes them).
/// Every scored item — whatever its tier — is recorded in the ledger so an
/// unchanged file is never re-scored.
pub fn scan(
    root: &Path,
    o: &Ontology,
    cfg: &DistillConfig,
    budget: usize,
    embed: &dyn Fn(Vec<String>) -> Result<Vec<Vec<f32>>, String>,
) -> Result<ScanOutcome, String> {
    let mut state = state_load(root, &o.model);
    let now = now_secs();
    let maturation_secs = cfg.maturation_hours as i64 * 3600;

    let mut outcome = ScanOutcome::default();
    let mut taken: Vec<Taken> = Vec::new();
    for c in collect_candidates(root) {
        if now - c.mtime < maturation_secs {
            outcome.skipped_immature += 1;
            continue;
        }
        // Unreadable (binary, or gone since the walk) — never scored, and
        // retried on the next run rather than failing the whole scan.
        let Ok(content) = std::fs::read_to_string(&c.path) else {
            continue;
        };
        let hash = crate::embeddings::content_hash(&content);
        if state.scored.get(&c.rel).is_some_and(|e| e.hash == hash) {
            continue; // unchanged since it was last scored
        }
        if taken.len() >= budget {
            break; // candidates are already oldest-first; the rest wait
        }
        let junk = junk_reason(&content);
        taken.push(Taken {
            rel: c.rel,
            path: c.path,
            content,
            hash,
            junk,
        });
    }

    // Batch-embed everything that isn't junk — the only cost this run pays.
    let to_embed: Vec<usize> = taken
        .iter()
        .enumerate()
        .filter(|(_, t)| t.junk.is_none())
        .map(|(i, _)| i)
        .collect();
    let mut vectors: HashMap<usize, Vec<f32>> = HashMap::new();
    for chunk in to_embed.chunks(EMBED_BATCH) {
        let texts: Vec<String> = chunk
            .iter()
            .map(|&i| truncate_chars(&taken[i].content, EMBED_CHARS))
            .collect();
        let vecs = embed(texts)?;
        for (&i, v) in chunk.iter().zip(vecs) {
            vectors.insert(i, v);
        }
    }

    let quarantine_dir = root.join(crate::commands::DEST_INBOX).join(QUARANTINE_DIR);
    let ttl_secs = cfg.quarantine_ttl_days as i64 * 86_400;

    for (i, item) in taken.into_iter().enumerate() {
        let verdict = match &item.junk {
            Some(reason) => Verdict {
                tier: Tier::Reject,
                s_knn: 0.0,
                nearest_cluster: String::new(),
                nearest_pages: Vec::new(),
                entity_hits: Vec::new(),
                reason: reason.clone(),
            },
            None => {
                let vector = vectors.get(&i).cloned().unwrap_or_default();
                admit(o, &vector, &item.content, &cfg.gate_preset)
            }
        };

        match verdict.tier {
            Tier::Quarantine => {
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
                let vector = vectors.get(&i).cloned().unwrap_or_default();
                let payload = QuarantineSidecar {
                    tier: &verdict.tier,
                    s_knn: verdict.s_knn,
                    nearest_cluster: &verdict.nearest_cluster,
                    reason: &verdict.reason,
                    expires: now + ttl_secs,
                    vector: &vector,
                };
                let raw = serde_json::to_string_pretty(&payload)
                    .map_err(|e| format!("serialize verdict: {e}"))?;
                std::fs::write(&sidecar, raw).map_err(|e| format!("write verdict sidecar: {e}"))?;
                outcome.quarantined += 1;
            }
            Tier::Reject => {
                state.rejected_ttl.insert(item.rel.clone(), now + ttl_secs);
                outcome.rejected += 1;
            }
            Tier::Summary => outcome.summaries += 1,
            Tier::Full => outcome.full += 1,
        }

        state.scored.insert(
            item.rel,
            ScoredEntry {
                hash: item.hash,
                tier: tier_str(verdict.tier).to_string(),
                at: now,
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
    pub archived: usize,
    pub trashed: usize,
    pub proposals: usize,
    pub backlog_after: usize,
}

/// Vault-wide distillation status — the settings tab / MCP `distill_status`
/// view. Cheap: no scoring, just a fs walk against the ledger already on disk.
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct DistillStatus {
    pub backlog: usize,
    pub pending_proposals: usize,
    pub last_run: Option<i64>,
    pub last_backlogs: Vec<usize>,
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
struct MoveEntry {
    from: String,
    to: String,
}

/// Everything one `run` moved, trashed, or created — replayed in reverse by
/// `undo`. `started_at` is this run's own unix-seconds clock reading (the
/// same instant `id` is derived from), kept as a plain field rather than
/// re-parsed out of `id` so undo's "was this touched since the run" check
/// stays a straight integer comparison.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
struct RunManifest {
    id: String,
    #[serde(default)]
    started_at: i64,
    #[serde(default)]
    moves: Vec<MoveEntry>,
    #[serde(default)]
    trashed: Vec<MoveEntry>,
    #[serde(default)]
    created: Vec<String>,
}

fn manifest_path(root: &Path, id: &str) -> PathBuf {
    dir(root).join("distill-runs").join(format!("{id}.json"))
}

/// Atomically (over)write `.myco/distill-runs/<id>.json` — same tmp+rename
/// pattern as `config_save`/`state_save`. Called after EVERY successful
/// archive move, trash move, and proposal write in `run`, not once at the
/// end: a mid-run I/O failure (the next op's `create_dir_all`/`rename`)
/// aborts `run` via `?`, and without an incremental save every op that
/// already succeeded would be recorded nowhere — invisible to `undo`, and
/// invisible to the 30-day trash purge, which would then permanently delete
/// trashed files with zero record they ever existed. The file on disk always
/// covers exactly what has actually happened so far, never less.
fn save_manifest(root: &Path, m: &RunManifest) -> Result<(), String> {
    let target = manifest_path(root, &m.id);
    let runs_dir = target.parent().ok_or("manifest path has no parent")?;
    std::fs::create_dir_all(runs_dir).map_err(|e| format!("create distill-runs dir: {e}"))?;
    let raw = serde_json::to_string_pretty(m).map_err(|e| format!("serialize manifest: {e}"))?;
    let tmp = runs_dir.join(format!(".{}.json.tmp", m.id));
    std::fs::write(&tmp, raw).map_err(|e| format!("write tmp manifest: {e}"))?;
    std::fs::rename(&tmp, &target).map_err(|e| format!("rename manifest: {e}"))?;
    Ok(())
}

/// UTC (proleptic Gregorian) `(year, month, day, hour, minute, second)` from a
/// unix timestamp — Howard Hinnant's `civil_from_days` algorithm,
/// the same one `commands::current_month` uses (that one is hardcoded to
/// "now" and stops at the month; run ids and archive-month buckets need an
/// arbitrary timestamp — a file's own mtime, not always "now" — plus
/// time-of-day, so it is re-derived here rather than shared).
fn civil_datetime(secs: i64) -> (i64, u32, u32, u32, u32, u32) {
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

/// `YYYY-MM` bucket an archived file belongs in, from its own mtime.
fn month_bucket(secs: i64) -> String {
    let (y, m, ..) = civil_datetime(secs);
    format!("{y:04}-{m:02}")
}

/// `run_id(now)`, or the same id suffixed `-2`, `-3`… if a run already wrote
/// a manifest under that exact second — e.g. two runs kicked off back-to-back
/// within the same wall-clock second.
fn free_run_id(root: &Path, now: i64) -> String {
    let base = run_id(now);
    if !manifest_path(root, &base).exists() {
        return base;
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

/// Minimal proposal writer — a seam Task 7's full proposal engine will reuse
/// (or replace): `work/feedback/<date>-<slug>.md` with `type:
/// distill-proposal`, `status: pending` frontmatter (the proposal-inbox
/// format from the design spec) and a one-paragraph body. Returns the
/// vault-relative path written.
///
/// ponytail: no de-dup against a previous proposal for the same item — an
/// item that keeps missing its window every run (e.g. a Conservative-
/// intensity TTL item) gets a fresh proposal file each run until Task 7's
/// approve/dismiss lifecycle marks one resolved.
fn write_proposal(
    root: &Path,
    now: i64,
    slug: &str,
    title: &str,
    body: &str,
) -> Result<String, String> {
    let (y, m, d, ..) = civil_datetime(now);
    let feedback_dir = root.join("work/feedback");
    std::fs::create_dir_all(&feedback_dir).map_err(|e| format!("create work/feedback dir: {e}"))?;
    let file_name = format!("{y:04}-{m:02}-{d:02}-{slug}.md");
    let path = free_path(&feedback_dir.join(file_name));
    let content =
        format!("---\ntype: distill-proposal\nstatus: pending\n---\n\n# {title}\n\n{body}\n");
    std::fs::write(&path, content).map_err(|e| format!("write proposal: {e}"))?;
    Ok(rel_string(root, &path))
}

/// `type: distill-proposal` and no `status` other than `pending` yet — a
/// proposal Task 7's future approve/dismiss lifecycle has not resolved.
fn is_pending_proposal(content: &str) -> bool {
    let Some(gray_matter::Pod::Hash(map)) = gray_matter::Matter::<gray_matter::engine::YAML>::new()
        .parse(content)
        .ok()
        .and_then(|p| p.data)
    else {
        return false;
    };
    let is_proposal =
        matches!(map.get("type"), Some(gray_matter::Pod::String(s)) if s == "distill-proposal");
    if !is_proposal {
        return false;
    }
    !matches!(map.get("status"), Some(gray_matter::Pod::String(s)) if s != "pending")
}

fn pending_proposal_count(root: &Path) -> usize {
    crate::vault::vault_entries(&root.join("work/feedback"))
        .into_iter()
        .filter(|(e, kind)| {
            kind.is_file() && e.path().extension().and_then(|x| x.to_str()) == Some("md")
        })
        .filter(|(e, _)| {
            std::fs::read_to_string(e.path())
                .map(|c| is_pending_proposal(&c))
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

/// Cheap backlog estimate: inflow candidates the ledger has not yet scored,
/// plus everything currently sitting in quarantine. A fs walk, not a
/// re-score — good enough for a trend line, not a substitute for `scan`'s own
/// count.
fn backlog_count(root: &Path, state: &DistillState) -> usize {
    let unscored = collect_candidates(root)
        .iter()
        .filter(|c| !state.scored.contains_key(&c.rel))
        .count();
    unscored + quarantine_item_count(root)
}

/// Move the file currently at `entry.to` back to `entry.from`, unless it was
/// modified since the run (the user touched it) or `entry.from` is now
/// occupied by something else — either way this entry is skipped with a
/// warning rather than silently overwriting user data. Returns whether the
/// move happened.
fn move_back(root: &Path, entry: &MoveEntry, run_id: &str, run_time: i64) -> bool {
    let to_path = root.join(&entry.to);
    let from_path = root.join(&entry.from);
    let Some(mtime) = mtime_secs(&to_path) else {
        return false; // nothing there to restore
    };
    if mtime > run_time {
        eprintln!(
            "distill undo {run_id}: skipping {} (modified since the run)",
            entry.to
        );
        return false;
    }
    if from_path.exists() {
        eprintln!(
            "distill undo {run_id}: skipping {} (original path is occupied)",
            entry.from
        );
        return false;
    }
    if let Some(parent) = from_path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return false;
        }
    }
    std::fs::rename(&to_path, &from_path).is_ok()
}

/// Paths `run` can touch — the only ones ever staged, so a distill commit
/// never absorbs an unrelated user edit sitting elsewhere in the vault.
/// Mirrors the `git_commit` MCP tool's approach (`mcp_native.rs`): check each
/// path's existence before staging it, rather than pass a missing pathspec to
/// git (which errors on one) or fall back to `git add -A`.
const GIT_COMMIT_PATHS: &[&str] = &[
    "raw",
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
/// effort: `git commit` exits non-zero when there is nothing staged (a run
/// that moved/trashed/created nothing), which is not a failure worth
/// surfacing — but a `git add` that fails on an existing, non-ignored path IS
/// unexpected, so the commit is skipped (with a warning) rather than run
/// against a possibly-incomplete stage.
fn git_commit_run(root: &Path, run_id: &str) {
    if !root.join(".git").exists() {
        return;
    }
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
    };

    let mut paths: Vec<&str> = GIT_COMMIT_PATHS
        .iter()
        .copied()
        .filter(|p| root.join(p).exists())
        .collect();
    if root.join(".myco").exists() {
        if let Ok(o) = git(&["ls-files", "--", ".myco"]) {
            if o.status.success() && !o.stdout.is_empty() {
                paths.push(".myco");
            }
        }
    }
    if paths.is_empty() {
        return; // nothing distill touches even exists yet
    }

    let mut add_args = vec!["add"];
    add_args.extend(paths);
    match git(&add_args) {
        Ok(o) if !o.status.success() => {
            eprintln!(
                "distill run {run_id}: git add failed, skipping commit: {}",
                String::from_utf8_lossy(&o.stderr).trim()
            );
            return;
        }
        Err(e) => {
            eprintln!("distill run {run_id}: git add failed, skipping commit: {e}");
            return;
        }
        _ => {}
    }

    if let Err(e) = git(&["commit", "-m", &format!("distill: run {run_id}")]) {
        eprintln!("distill run {run_id}: git commit failed: {e}");
    }
}

#[allow(clippy::too_many_arguments)]
fn render_report(
    id: &str,
    cfg: &DistillConfig,
    ontology_rebuilt: bool,
    scan: &ScanOutcome,
    archived: usize,
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

    s += &format!("## Archive ({archived} moved)\n\n");
    if manifest.moves.is_empty() {
        s += "(none)\n";
    } else {
        for m in &manifest.moves {
            s += &format!("- `{}` -> `{}`\n", m.from, m.to);
        }
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
        "## Undo\n\nRun `undo_distill_run` with id `{id}` to reverse every move, trash, and \
         proposal this run made.\n"
    );
    s
}

/// Idle-run orchestrator: the periodic batch the design spec calls "the
/// distill run". In order:
///
/// 1. `partition_sessions` — fold any loose `sessions/*.md` into their month
///    bucket before anything scores them (best-effort; a failure here does
///    not stop the run).
/// 2. Ontology: rebuild if there is none yet, or the wiki's page count moved
///    since it was built — a deliberately simple staleness check (an exact
///    "did the wiki change" would need a content hash of every page; a page
///    count catches the common case — pages added/removed — cheaply).
/// 3. `scan` new inflow against that ontology (Task 4).
/// 4. Archive pass: a top-level `raw/<slug>.md` that is mature and already
///    has a `wiki/source-<slug>.md` is "already represented" — move it to
///    `raw/archive/YYYY-MM/` (month from the file's own mtime). At
///    `Intensity::Conservative` this is a proposal instead of a move.
/// 5. TTL pass: quarantine sidecars past their `expires` move (file +
///    sidecar) to `.myco/trash/<run-id>/` at Standard/Aggressive, or propose
///    at Conservative. Trash dirs whose entire retention window has elapsed
///    are purged regardless of this run's intensity.
/// 6. Emerging-cluster + proposal pass — Task 7's job; no call here yet.
/// 7. The undo manifest (`.myco/distill-runs/<id>.json`) — NOT a single write
///    at the end: `save_manifest` persists it after every successful move,
///    trash, and proposal in steps 4-6, so a mid-run I/O failure never loses
///    the record of what already happened (only what would have happened
///    next).
/// 8. Write the human report (`ingest-reports/distill-<id>.md`).
/// 9. Append this run's backlog to the rolling trend, and commit if the
///    vault is a git repo.
pub fn run(
    root: &Path,
    cfg: &DistillConfig,
    embed: &dyn Fn(Vec<String>) -> Result<Vec<Vec<f32>>, String>,
) -> Result<RunReport, String> {
    let now = now_secs();
    let id = free_run_id(root, now);

    if let Err(e) = crate::commands::partition_sessions(root) {
        crate::perf::log("distill_partition_sessions_failed", &[]);
        let _ = e;
    }

    let index_path = crate::vector_index::VectorStore::path_for(&root.to_string_lossy())?;
    let store = crate::vector_index::VectorStore::load(&index_path);
    let current_wiki_pages = crate::commands::wiki_titles(root).len();
    let cached = crate::ontology::load(root, &store.model);
    let ontology_rebuilt = !matches!(&cached, Some(o) if o.wiki_pages == current_wiki_pages);
    let ontology = if ontology_rebuilt {
        let titles = crate::commands::wiki_titles(root);
        let mut o = crate::ontology::build(&store, &titles);
        crate::ontology::stamp_last_touched(root, &mut o);
        crate::ontology::save(root, &o)?;
        o
    } else {
        cached.expect("ontology_rebuilt is false only when `cached` is Some")
    };

    let scan_outcome = scan(root, &ontology, cfg, cfg.run_budget_items, embed)?;

    let conservative = matches!(cfg.intensity, Intensity::Conservative);
    let maturation_secs = cfg.maturation_hours as i64 * 3600;
    let mut manifest = RunManifest {
        id: id.clone(),
        started_at: now,
        ..Default::default()
    };
    // Persist immediately — the manifest exists on disk from before the
    // first op, not just after it, so even a crash on the very first move
    // leaves a valid (empty) manifest rather than no manifest at all.
    save_manifest(root, &manifest)?;
    let mut archived = 0usize;
    let mut proposals = 0usize;

    // ④ Archive pass: top-level raw/*.md only — `vault_entries` already skips
    // dotfiles/symlinks, and not recursing means `raw/archive/` (a directory,
    // not a `.md` file) is never a candidate in the first place.
    for (entry, kind) in crate::vault::vault_entries(&root.join("raw")) {
        if !kind.is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Some(mtime) = mtime_secs(&path) else {
            continue;
        };
        if now - mtime < maturation_secs {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let source_page = format!("wiki/source-{stem}.md");
        if !root.join(&source_page).exists() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let from_rel = format!("raw/{file_name}");

        if conservative {
            let month = month_bucket(mtime);
            let rel = write_proposal(
                root,
                now,
                stem,
                &format!("Archive raw/{file_name}?"),
                &format!(
                    "`{source_page}` already represents this source. Standard/Aggressive \
                     intensity would move it to `raw/archive/{month}/{file_name}`."
                ),
            )?;
            manifest.created.push(rel);
            save_manifest(root, &manifest)?;
            proposals += 1;
        } else {
            let archive_dir = root.join("raw/archive").join(month_bucket(mtime));
            std::fs::create_dir_all(&archive_dir)
                .map_err(|e| format!("create archive dir: {e}"))?;
            let to_path = free_path(&archive_dir.join(&file_name));
            std::fs::rename(&path, &to_path).map_err(|e| format!("archive move: {e}"))?;
            manifest.moves.push(MoveEntry {
                from: from_rel,
                to: rel_string(root, &to_path),
            });
            save_manifest(root, &manifest)?;
            archived += 1;
        }
    }

    // ⑤ TTL pass: quarantine sidecars past their expiry. Task 7's
    // never-clustered check would additionally gate this — no sidecar
    // carries cluster membership yet, so every expired one qualifies today.
    let mut trashed = 0usize;
    let quarantine_dir = root.join(crate::commands::DEST_INBOX).join(QUARANTINE_DIR);
    let trash_dir = dir(root).join("trash").join(&id);
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
        if !content_path.exists() {
            let _ = std::fs::remove_file(&sidecar_path); // orphaned sidecar
            continue;
        }
        let content_rel = format!("{}/{QUARANTINE_DIR}/{stem}.md", crate::commands::DEST_INBOX);
        let sidecar_rel = format!("{}/{QUARANTINE_DIR}/{name}", crate::commands::DEST_INBOX);

        if conservative {
            let rel = write_proposal(
                root,
                now,
                stem,
                &format!("Delete expired quarantine item {stem}.md?"),
                &format!(
                    "Quarantine TTL expired at unix {expires}. Standard/Aggressive intensity \
                     would move `{content_rel}` and its sidecar to `.myco/trash/{id}/`."
                ),
            )?;
            manifest.created.push(rel);
            save_manifest(root, &manifest)?;
            proposals += 1;
        } else {
            std::fs::create_dir_all(&trash_dir).map_err(|e| format!("create trash dir: {e}"))?;
            let to_content = free_path(&trash_dir.join(format!("{stem}.md")));
            std::fs::rename(&content_path, &to_content).map_err(|e| format!("trash move: {e}"))?;
            manifest.trashed.push(MoveEntry {
                from: content_rel,
                to: rel_string(root, &to_content),
            });
            save_manifest(root, &manifest)?;
            let to_sidecar = free_path(&trash_dir.join(&name));
            std::fs::rename(&sidecar_path, &to_sidecar)
                .map_err(|e| format!("trash sidecar move: {e}"))?;
            manifest.trashed.push(MoveEntry {
                from: sidecar_rel,
                to: rel_string(root, &to_sidecar),
            });
            save_manifest(root, &manifest)?;
            trashed += 1;
        }
    }

    // Purge trash dirs past their retention window, regardless of this run's
    // intensity — housekeeping on already-committed deletions, not a new one.
    let trash_root = dir(root).join("trash");
    for (entry, kind) in crate::vault::vault_entries(&trash_root) {
        if !kind.is_dir() {
            continue;
        }
        if let Some(mtime) = mtime_secs(&entry.path()) {
            if now - mtime > TRASH_RETENTION_DAYS * 86_400 {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }

    // ⑥ Emerging-cluster + proposal pass — Task 7's job (design spec:
    // "≥5 quarantined items with pairwise similarity above threshold ->
    // 'new topic forming' proposal"). Seam: Task 7 wires a
    // `detect_emerging_clusters(root, &ontology, cfg, &mut manifest)` call in
    // right here, between the TTL pass and step ⑨ below — it should call
    // `save_manifest` after its own pushes too, same as every pass above.

    // ⑦ Manifest — already persisted incrementally after every successful
    // move/trash/proposal above (`save_manifest`); nothing left to write.

    // ⑨ (backlog half) Append this run's backlog to the rolling trend, so the
    // report below and the returned `RunReport` show the same number.
    let mut state = state_load(root, &ontology.model);
    let backlog_after = backlog_count(root, &state);
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
        archived,
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
        archived,
        trashed,
        proposals,
        backlog_after,
    })
}

/// Replay one run's manifest in reverse: restore every archived/trashed file
/// to its pre-run location, and delete every proposal file that run created.
/// An entry is skipped (with a warning to stderr, not silently) when the
/// current file was modified since the run, or the restore destination is
/// now occupied by something else — undo must never clobber data the user
/// touched after the run. Returns the number of entries actually reversed.
///
/// Ledger entries for a restored path's pre-run location are not explicitly
/// cleaned up here — they were already pruned by `compact_ledger` the moment
/// this run's own `scan` ran (a ledger key for a path that no longer exists
/// is dropped every scan; see that fn's doc comment), so nothing new is left
/// dangling for undo to clean up. The one case undo DOES create — a file
/// reappearing at a path with no ledger entry — self-heals on the next
/// `scan`, which just treats it as fresh, unscored inflow.
pub fn undo(root: &Path, run_id: &str) -> Result<usize, String> {
    let path = manifest_path(root, run_id);
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("read manifest {}: {e}", path.display()))?;
    let manifest: RunManifest =
        serde_json::from_str(&raw).map_err(|e| format!("parse manifest: {e}"))?;

    let mut reversed = 0usize;
    for entry in manifest.trashed.iter().rev() {
        if move_back(root, entry, run_id, manifest.started_at) {
            reversed += 1;
        }
    }
    for entry in manifest.moves.iter().rev() {
        if move_back(root, entry, run_id, manifest.started_at) {
            reversed += 1;
        }
    }
    for rel in manifest.created.iter().rev() {
        let p = root.join(rel);
        let Some(mtime) = mtime_secs(&p) else {
            continue; // already gone — nothing to reverse
        };
        if mtime > manifest.started_at {
            eprintln!("distill undo {run_id}: skipping {rel} (modified since the run)");
            continue;
        }
        if std::fs::remove_file(&p).is_ok() {
            reversed += 1;
        }
    }
    Ok(reversed)
}

/// Cheap vault-wide status for the settings tab / MCP `distill_status`: no
/// scoring, just a fs walk against the ledger already on disk.
pub fn status(root: &Path) -> DistillStatus {
    let store = crate::vector_index::VectorStore::path_for(&root.to_string_lossy())
        .map(|p| crate::vector_index::VectorStore::load(&p))
        .unwrap_or_default();
    let state = state_load(root, &store.model);
    DistillStatus {
        backlog: backlog_count(root, &state),
        pending_proposals: pending_proposal_count(root),
        last_run: state.last_run,
        last_backlogs: state.last_backlogs.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set_mtime(path: &Path, time: std::time::SystemTime) {
        let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(time).unwrap();
    }

    fn old_mtime() -> std::time::SystemTime {
        std::time::SystemTime::now() - std::time::Duration::from_secs(48 * 3600)
    }

    /// One cluster centred on `[1.0, 0.0]` with clean, well-separated
    /// thresholds (p5=0.10, p25=0.50, p40=0.90) — same shape as
    /// `ontology::tests::admit_reason_cites_the_threshold_that_actually_decided_the_tier`,
    /// built directly here since that test module's helpers are private to it.
    fn tiny_ontology() -> Ontology {
        Ontology {
            model: "test-model".to_string(),
            built_at: 0,
            wiki_pages: 1,
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

    const PROSE: &str = "This is a normal note about quantization techniques and how they reduce model size while preserving accuracy across a range of benchmarks and downstream tasks in real deployments, and it keeps going a little further so the byte count clears the junk-heuristic floor.";

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

        let out = scan(root, &o, &cfg, 10, &embed).unwrap();
        assert_eq!(out.scored, 2, "a.md and c.md are mature and unscored");
        assert_eq!(out.skipped_immature, 1, "b.md is under the maturation gate");

        let out2 = scan(root, &o, &cfg, 10, &embed).unwrap();
        assert_eq!(out2.scored, 0, "unchanged content must not be rescored");
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

        let out = scan(root, &o, &cfg, 10, &embed).unwrap();
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

        let out = scan(root, &o, &cfg, 10, &embed).unwrap();
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
    }

    #[test]
    fn quarantine_from_raw_origin_moves_to_inbox_quarantine() {
        // raw/ is immutable to edits/deletes, but the gate's quarantine move
        // is a sanctioned transition (`app/docs/specs/2026-08-13-ontology-
        // distill-design.md`: "Cleanup = state transition ... recorded in an
        // undo manifest"), same as any other inflow tree.
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

        let out = scan(root, &o, &cfg, 10, &embed).unwrap();
        assert_eq!(out.quarantined, 1);
        assert!(
            !root.join("raw/paper.md").exists(),
            "raw/ source must be moved, never left behind after quarantine"
        );
        assert!(root.join("_inbox/quarantine/paper.md").exists());
        assert!(root.join("_inbox/quarantine/paper.verdict.json").exists());
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

        let out = scan(root, &o, &cfg, 10, &embed).unwrap();
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
        let out2 = scan(root, &o, &cfg, 10, &embed).unwrap();
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

    /// Embed closure for run() tests: the ontology these tests build is
    /// always empty (no real `VectorStore` exists at the isolated test data
    /// path), so `admit` never reaches `cosine` at all — the vector's
    /// content is irrelevant, only its presence (so `scan`'s embed batching
    /// has something to return).
    fn dummy_embed(texts: Vec<String>) -> Result<Vec<Vec<f32>>, String> {
        Ok(texts.iter().map(|_| vec![1.0]).collect())
    }

    #[test]
    fn run_archives_represented_raw_and_writes_manifest() {
        crate::settings::test_support::with_isolated_data("distill-run-archive", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            std::fs::create_dir_all(root.join("raw")).unwrap();
            std::fs::create_dir_all(root.join("wiki")).unwrap();
            std::fs::write(root.join("raw/x.md"), PROSE).unwrap();
            std::fs::write(root.join("wiki/source-x.md"), "a source summary page").unwrap();
            set_mtime(&root.join("raw/x.md"), old_mtime());

            let cfg = DistillConfig::default(); // Standard intensity
            let report = run(root, &cfg, &dummy_embed).unwrap();
            assert_eq!(report.archived, 1);
            assert_eq!(report.proposals, 0);
            assert!(
                !root.join("raw/x.md").exists(),
                "archived source must move out of raw/"
            );

            let manifest_raw = std::fs::read_to_string(manifest_path(root, &report.id)).unwrap();
            let manifest: serde_json::Value = serde_json::from_str(&manifest_raw).unwrap();
            let moves = manifest["moves"].as_array().unwrap();
            assert_eq!(moves.len(), 1);
            assert_eq!(moves[0]["from"], "raw/x.md");
            let to = moves[0]["to"].as_str().unwrap().to_string();
            assert!(
                to.starts_with("raw/archive/") && to.ends_with("/x.md"),
                "unexpected archive path: {to}"
            );
            assert!(root.join(&to).exists());

            let report_raw = std::fs::read_to_string(
                root.join(format!("ingest-reports/distill-{}.md", report.id)),
            )
            .unwrap();
            assert!(report_raw.contains(&report.id));
            assert!(report_raw.contains("1 moved"));
        });
    }

    #[test]
    fn crash_mid_run_preserves_manifest_for_completed_moves() {
        crate::settings::test_support::with_isolated_data("distill-run-crash-safety", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            std::fs::create_dir_all(root.join("raw")).unwrap();
            std::fs::create_dir_all(root.join("wiki")).unwrap();
            std::fs::create_dir_all(root.join("_inbox/quarantine")).unwrap();
            // Archive pass: one item that will complete successfully, and be
            // persisted, BEFORE the TTL pass below hits its induced failure.
            std::fs::write(root.join("raw/a.md"), PROSE).unwrap();
            std::fs::write(root.join("wiki/source-a.md"), "a source summary page").unwrap();
            set_mtime(&root.join("raw/a.md"), old_mtime());

            // TTL pass: an expired quarantine item whose trash move will fail.
            std::fs::write(root.join("_inbox/quarantine/q.md"), PROSE).unwrap();
            let expired = serde_json::json!({
                "tier": "quarantine",
                "s_knn": 0.2,
                "nearest_cluster": "topic",
                "reason": "test",
                "expires": now_secs() - 1000,
                "vector": [1.0, 0.0],
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

            // The archive pass ran to completion (it precedes the TTL pass,
            // which is where the induced failure lives), so a.md must
            // actually be gone from raw/ ...
            assert!(!root.join("raw/a.md").exists());
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
            assert_eq!(moves[0]["from"], "raw/a.md");
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
            std::fs::create_dir_all(root.join("raw")).unwrap();
            std::fs::create_dir_all(root.join("wiki")).unwrap();
            std::fs::write(root.join("raw/x.md"), PROSE).unwrap();
            std::fs::write(root.join("wiki/source-x.md"), "a source summary page").unwrap();
            set_mtime(&root.join("raw/x.md"), old_mtime());

            let cfg = DistillConfig {
                intensity: Intensity::Conservative,
                ..DistillConfig::default()
            };
            let report = run(root, &cfg, &dummy_embed).unwrap();
            assert_eq!(report.archived, 0);
            assert_eq!(report.proposals, 1);
            assert!(
                root.join("raw/x.md").exists(),
                "conservative intensity must not move the source"
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
    fn undo_restores_exact_layout() {
        crate::settings::test_support::with_isolated_data("distill-run-undo", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            std::fs::create_dir_all(root.join("raw")).unwrap();
            std::fs::create_dir_all(root.join("wiki")).unwrap();
            std::fs::create_dir_all(root.join("_inbox/quarantine")).unwrap();
            std::fs::write(root.join("raw/x.md"), PROSE).unwrap();
            std::fs::write(root.join("wiki/source-x.md"), "a source summary page").unwrap();
            set_mtime(&root.join("raw/x.md"), old_mtime());

            std::fs::write(root.join("_inbox/quarantine/q.md"), PROSE).unwrap();
            let expired = serde_json::json!({
                "tier": "quarantine",
                "s_knn": 0.2,
                "nearest_cluster": "topic",
                "reason": "test",
                "expires": now_secs() - 1000,
                "vector": [1.0, 0.0],
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
            assert_eq!(report.archived, 1);
            assert_eq!(report.trashed, 1);
            assert!(!root.join("raw/x.md").exists());
            assert!(!root.join("_inbox/quarantine/q.md").exists());
            assert!(!root.join("_inbox/quarantine/q.verdict.json").exists());

            let reversed = undo(root, &report.id).unwrap();
            assert_eq!(
                reversed, 3,
                "1 archive move + 2 trash moves (content + verdict sidecar)"
            );

            assert_eq!(before, snapshot(root));
        });
    }

    #[test]
    fn status_reports_backlog_trend() {
        crate::settings::test_support::with_isolated_data("distill-run-status", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            std::fs::create_dir_all(root.join("_inbox")).unwrap();
            std::fs::write(root.join("_inbox/a.md"), PROSE).unwrap();
            std::fs::write(root.join("_inbox/b.md"), PROSE).unwrap();
            set_mtime(&root.join("_inbox/a.md"), old_mtime());
            set_mtime(&root.join("_inbox/b.md"), old_mtime());

            let cfg = DistillConfig::default();

            let before = status(root);
            assert_eq!(before.backlog, 2, "two unscored, mature inflow items");
            assert!(before.last_run.is_none());
            assert!(before.last_backlogs.is_empty());

            let report1 = run(root, &cfg, &dummy_embed).unwrap();
            assert_eq!(report1.backlog_after, 0, "scan ledgers both files this run");

            let mid = status(root);
            assert_eq!(mid.backlog, 0);
            assert!(mid.last_run.is_some());
            assert_eq!(mid.last_backlogs, vec![0]);

            let report2 = run(root, &cfg, &dummy_embed).unwrap();
            assert_ne!(
                report1.id, report2.id,
                "free_run_id must not collide within the same second"
            );

            let after = status(root);
            assert_eq!(after.last_backlogs, vec![0, 0]);
            assert_eq!(after.pending_proposals, 0);
        });
    }
}
