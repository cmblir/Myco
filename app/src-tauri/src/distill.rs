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
}
