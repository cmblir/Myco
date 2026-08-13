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
    #[serde(default)]
    pub dormancy_decay: bool,
    /// Phase B: minimum age (days) before a `sessions/` day is offered to
    /// `digestable_session_days`.
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

/// `line` with a leading ATX heading marker stripped, if it actually has
/// one: 1-6 `#` characters followed by a space or nothing else on the line —
/// the CommonMark ATX heading rule. Anything else starting with `#` (a
/// hashtag, "#1 issue", 7+ `#`s) is not a heading and comes back unchanged;
/// stripping any leading `#` run unconditionally turned "#hashtag trending"
/// into "hashtag trending".
fn strip_atx_heading(line: &str) -> &str {
    let hashes = line.bytes().take_while(|&b| b == b'#').count();
    let is_heading =
        (1..=6).contains(&hashes) && matches!(line.as_bytes().get(hashes), None | Some(b' '));
    if is_heading {
        line[hashes..].trim_start()
    } else {
        line
    }
}

/// First non-empty line of `content`'s BODY (frontmatter stripped, via the
/// same `gray_matter` parse `proposal_frontmatter` uses — not hand-rolled),
/// with a leading ATX heading marker (`strip_atx_heading`) trimmed off,
/// capped at 120 chars. A real `_inbox/` import always opens with a YAML
/// frontmatter block (`importers::Conversation::to_inbox_doc`) followed by
/// `# <title>` — without stripping both, a summary-tier digest line read
/// "- --- — `path` (low confidence)" instead of the title. `None` only when
/// the body has no non-empty line at all (unreadable/empty file).
fn first_summary_line(content: &str) -> Option<String> {
    let body = gray_matter::Matter::<gray_matter::engine::YAML>::new()
        .parse::<gray_matter::Pod>(content)
        .map(|p| p.content)
        .unwrap_or_else(|_| content.to_string());
    let line = body.lines().find(|l| !l.trim().is_empty())?.trim();
    let line = strip_atx_heading(line);
    Some(truncate_chars(line, 120))
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
/// `.myco/` (not one of these trees at all), `_inbox/quarantine/`,
/// `raw/archive/`, or `sessions/archive/` (Phase B's digested-session
/// archive — an archived session must never be re-scored, same reason
/// `raw/archive/` is excluded).
fn collect_candidates(root: &Path) -> Vec<Candidate> {
    let mut out = Vec::new();
    walk_inflow(
        root,
        crate::commands::DEST_INBOX,
        &[QUARANTINE_DIR],
        &mut out,
    );
    walk_inflow(root, "raw", &[RAW_ARCHIVE_DIR], &mut out);
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

/// "Gate OFF until the vault has ≥50 wiki pages (or first map); profile.md
/// serves as ontology until then." —
/// `app/docs/specs/2026-08-13-ontology-distill-design.md`, "Admission gate".
const GATE_MIN_WIKI_PAGES: usize = 50;

/// Score new inflow against the ontology: walk `_inbox/`, `raw/`, `sessions/`
/// oldest-mtime-first, skip anything not yet mature (`cfg.maturation_hours`)
/// or already scored at its current content hash, reject junk transcripts
/// without spending an embedding, batch-embed the rest and run them through
/// `ontology::admit`, then act on the verdict: quarantine moves the file into
/// `_inbox/quarantine/` with a verdict sidecar — recorded into `manifest`
/// (the file move as a `moves` entry, the sidecar as a `created` entry,
/// `save_manifest`d after each, same incremental discipline as every other
/// pass in `run`) so undo can reverse it — reject adds a `rejected_ttl`
/// ledger entry (the file stays put — see that field's own doc comment:
/// nothing sweeps it yet), full/summary are only recorded (Phase B consumes
/// them). Every scored item — whatever its tier — is recorded in the ledger
/// so an unchanged file is never re-scored.
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
fn scan(
    root: &Path,
    o: &Ontology,
    cfg: &DistillConfig,
    budget: usize,
    embed: &dyn Fn(Vec<String>) -> Result<Vec<Vec<f32>>, String>,
    manifest: &mut RunManifest,
) -> Result<ScanOutcome, String> {
    if o.wiki_pages < GATE_MIN_WIKI_PAGES {
        eprintln!(
            "distill gate off: {} wiki pages < {GATE_MIN_WIKI_PAGES}",
            o.wiki_pages
        );
        return Ok(ScanOutcome::default());
    }

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
                manifest.moves.push(MoveEntry {
                    from: item.rel.clone(),
                    to: rel_string(root, &target),
                });
                save_manifest(root, manifest)?;
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
                manifest.created.push(rel_string(root, &sidecar));
                save_manifest(root, manifest)?;
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
fn slugify(s: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
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

/// Section header a summary-tier digest line lands under in `daily/<day>.md`
/// — appended at most once per file (`append_daily_summary_line` checks for
/// it before adding it again).
const DAILY_SUMMARY_HEADER: &str = "## Distill summary (auto)";

/// Ensure `daily/<day>.md` exists (seeded with `# <day>\n` if it doesn't) and
/// carries `DAILY_SUMMARY_HEADER`, then append `line`. Returns whether THIS
/// call is what created the file from nothing — the one signal `run`'s
/// summary-tier step needs to decide whether the file belongs in its undo
/// manifest: appending to a file that already existed before this run must
/// never let `undo` delete the whole thing, only a file this run itself
/// originated may be deleted wholesale on undo.
fn append_daily_summary_line(root: &Path, day: &str, line: &str) -> Result<bool, String> {
    let dir = root.join("daily");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create daily dir: {e}"))?;
    let path = dir.join(format!("{day}.md"));
    let created = !path.exists();
    let mut content = if created {
        format!("# {day}\n")
    } else {
        std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?
    };
    if !content.contains(DAILY_SUMMARY_HEADER) {
        if !content.ends_with('\n') {
            content.push('\n');
        }
        content.push('\n');
        content.push_str(DAILY_SUMMARY_HEADER);
        content.push_str("\n\n");
    }
    content.push_str(line);
    content.push('\n');
    std::fs::write(&path, content).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(created)
}

/// Parse a proposal file's YAML frontmatter into its raw `Pod` map, or `None`
/// if it isn't `type: distill-proposal` frontmatter at all. Shared by every
/// reader of the proposal lifecycle (pending check, dedup check, apply) so
/// the frontmatter shape lives in one place.
fn proposal_frontmatter(content: &str) -> Option<HashMap<String, gray_matter::Pod>> {
    let gray_matter::Pod::Hash(map) = gray_matter::Matter::<gray_matter::engine::YAML>::new()
        .parse(content)
        .ok()?
        .data?
    else {
        return None;
    };
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
}

/// Read `_inbox/quarantine/<stem>.verdict.json` for a quarantined item given
/// its content file's rel path (e.g. `_inbox/quarantine/a.md`) — `None` if the
/// sidecar is missing, unparseable, or carries no vector.
fn read_sidecar(root: &Path, content_rel: &str) -> Option<SidecarInfo> {
    let content_path = root.join(content_rel);
    let stem = content_path.file_stem().and_then(|s| s.to_str())?;
    let sidecar_path = content_path.with_file_name(format!("{stem}.verdict.json"));
    let raw = std::fs::read_to_string(&sidecar_path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let vector: Vec<f32> = v
        .get("vector")?
        .as_array()?
        .iter()
        .filter_map(|x| x.as_f64().map(|f| f as f32))
        .collect();
    Some(SidecarInfo {
        vector,
        nearest_cluster: v
            .get("nearest_cluster")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        s_knn: v.get("s_knn").and_then(|x| x.as_f64()).unwrap_or(0.0) as f32,
    })
}

/// Every currently-quarantined item's rel path + embedding vector, sorted by
/// path — the deterministic order `emerging_clusters` groups over.
fn quarantine_vectors(root: &Path) -> Vec<(String, Vec<f32>)> {
    let quarantine_dir = root.join(crate::commands::DEST_INBOX).join(QUARANTINE_DIR);
    let mut out: Vec<(String, Vec<f32>)> = crate::vault::vault_entries(&quarantine_dir)
        .into_iter()
        .filter(|(_, kind)| kind.is_file())
        .filter_map(|(entry, _)| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let stem = name.strip_suffix(".verdict.json")?;
            let content_rel = format!("{}/{QUARANTINE_DIR}/{stem}.md", crate::commands::DEST_INBOX);
            if !root.join(&content_rel).exists() {
                return None;
            }
            let info = read_sidecar(root, &content_rel)?;
            Some((content_rel, info.vector))
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
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
pub fn emerging_clusters(root: &Path, min_size: usize, min_sim: f32) -> Vec<Vec<String>> {
    let items = quarantine_vectors(root);
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
            if crate::embeddings::cosine(&items[i].1, &items[j].1) >= min_sim {
                let (ri, rj) = (find(&mut parent, i), find(&mut parent, j));
                if ri != rj {
                    parent[ri.max(rj)] = ri.min(rj);
                }
            }
        }
    }

    let mut groups: HashMap<usize, Vec<String>> = HashMap::new();
    for (i, item) in items.into_iter().enumerate() {
        groups.entry(find(&mut parent, i)).or_default().push(item.0);
    }
    let mut out: Vec<Vec<String>> = groups
        .into_values()
        .filter(|g| g.len() >= min_size)
        .collect();
    out.sort_by(|a, b| a[0].cmp(&b[0])); // by first (already sorted) member
    out
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
fn label_cluster(root: &Path, members: &[String]) -> String {
    fn tokens(s: &str) -> impl Iterator<Item = String> + '_ {
        s.split(|c: char| !c.is_alphanumeric())
            .map(str::to_lowercase)
            .filter(|t| t.len() >= 3 && !LABEL_STOPWORDS.contains(&t.as_str()))
    }

    let mut counts: HashMap<String, usize> = HashMap::new();
    for m in members {
        let mut seen = std::collections::HashSet::new();
        if let Some(stem) = Path::new(m).file_stem().and_then(|s| s.to_str()) {
            seen.extend(tokens(stem));
        }
        if let Ok(content) = std::fs::read_to_string(root.join(m)) {
            if let Some(first_line) = content.lines().find(|l| !l.trim().is_empty()) {
                seen.extend(tokens(first_line));
            }
        }
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

/// True if a PENDING `summary-batch` proposal already names this exact file
/// — the same de-dup `pending_admit_cluster_exists` gives `admit-cluster`,
/// narrowed to a single file: unlike an emerging cluster, a summary-tier item
/// gets its own proposal, mirroring the raw archive pass's per-file
/// `archive-batch` proposals rather than grouping many files into one.
fn pending_summary_batch_exists(root: &Path, rel: &str) -> bool {
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
            let is_summary_batch =
                matches!(map.get("action"), Some(gray_matter::Pod::String(s)) if s == "summary-batch");
            is_summary_batch && proposal_payload_files(&map) == [rel.to_string()]
        })
}

/// Emerging-cluster + proposal pass (run() step ⑥): quarantined items whose
/// pairwise similarity clusters into a group of at least `EMERGING_MIN_SIZE`
/// are proposed as a new topic, unless a pending `admit-cluster` proposal for
/// the exact same file set already exists. Returns the number of proposals
/// written; `save_manifest`s after each one, same as every other pass.
fn propose_emerging_clusters(root: &Path, manifest: &mut RunManifest) -> Result<usize, String> {
    let mut written = 0usize;
    for files in emerging_clusters(root, EMERGING_MIN_SIZE, EMERGING_MIN_SIM) {
        if pending_admit_cluster_exists(root, &files) {
            continue;
        }
        let infos: Vec<SidecarInfo> = files.iter().filter_map(|f| read_sidecar(root, f)).collect();

        let mut sum = 0.0f32;
        let mut pairs = 0u32;
        for i in 0..infos.len() {
            for j in (i + 1)..infos.len() {
                sum += crate::embeddings::cosine(&infos[i].vector, &infos[j].vector);
                pairs += 1;
            }
        }
        let mean_sim = if pairs > 0 { sum / pairs as f32 } else { 0.0 };

        let label = label_cluster(root, &files);
        let mut body = format!(
            "{} quarantined items cluster together (mean similarity {mean_sim:.2}). Admit as a \
             new topic?\n\n",
            files.len()
        );
        for (f, info) in files.iter().zip(&infos) {
            body += &format!(
                "- [[{f}]] — nearest '{}' {:.2}\n",
                info.nearest_cluster, info.s_knn
            );
        }

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
}

impl ApplyOutcome {
    fn summary(&self) -> String {
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

/// Move a quarantined item's content file back to `_inbox/`, delete its
/// verdict sidecar, and drop its scan-ledger entry so the next `scan` scores
/// it fresh against the (hopefully now-wider) ontology. Ledger compaction
/// would eventually drop the entry anyway (its key stops existing the moment
/// the file moves — see `compact_ledger`), but dropping it here rather than
/// waiting for the next scan keeps the ledger accurate immediately, not just
/// eventually.
fn apply_admit_cluster(root: &Path, files: &[String]) -> Result<ApplyOutcome, String> {
    let inbox_dir = root.join(crate::commands::DEST_INBOX);
    std::fs::create_dir_all(&inbox_dir).map_err(|e| format!("create _inbox dir: {e}"))?;
    let mut outcome = ApplyOutcome {
        moved: 0,
        skipped: 0,
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
        let sidecar_path = content_path.with_file_name(format!(
            "{}.verdict.json",
            content_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("item")
        ));
        let dest = free_path(&inbox_dir.join(file_name));
        std::fs::rename(&content_path, &dest).map_err(|e| format!("move {f} to _inbox: {e}"))?;
        let _ = std::fs::remove_file(&sidecar_path); // best-effort; a missing sidecar isn't fatal
        outcome.moved += 1;
    }
    drop_ledger_entries(root, files)?;
    Ok(outcome)
}

/// Same move `run()`'s conservative archive pass would have made: top-level
/// `raw/<file>.md` -> `raw/archive/<YYYY-MM>/<file>.md`, month from the
/// file's own mtime. Reuses `month_bucket`/`free_path`, the same helpers that
/// pass uses, rather than re-deriving the bucket/collision logic here.
fn apply_archive_batch(root: &Path, files: &[String]) -> Result<ApplyOutcome, String> {
    let mut outcome = ApplyOutcome {
        moved: 0,
        skipped: 0,
    };
    for f in files {
        let from_path = confine_payload_file(root, f, is_raw_top_level_payload_path, "raw/")?;
        if !from_path.exists() {
            outcome.skipped += 1;
            continue;
        }
        let mtime = mtime_secs(&from_path).unwrap_or_else(now_secs);
        let file_name = from_path
            .file_name()
            .ok_or_else(|| format!("bad proposal file path: {f}"))?;
        let archive_dir = root.join("raw/archive").join(month_bucket(mtime));
        std::fs::create_dir_all(&archive_dir).map_err(|e| format!("create archive dir: {e}"))?;
        let to_path = free_path(&archive_dir.join(file_name));
        std::fs::rename(&from_path, &to_path).map_err(|e| format!("archive move: {e}"))?;
        outcome.moved += 1;
    }
    Ok(outcome)
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
) -> Result<ApplyOutcome, String> {
    let slug = proposal_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("proposal");
    let trash_dir = dir(root).join("trash").join(slug);
    std::fs::create_dir_all(&trash_dir).map_err(|e| format!("create trash dir: {e}"))?;
    let mut outcome = ApplyOutcome {
        moved: 0,
        skipped: 0,
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
        let sidecar_path = content_path.with_file_name(format!(
            "{}.verdict.json",
            content_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("item")
        ));
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

/// Best-effort removal of `rels`' scan-ledger entries (`scored`/
/// `rejected_ttl`), regardless of which embed model the ledger on disk is
/// currently stamped for — an `apply_proposal` call has no ontology/model
/// context of its own, and the entries being dropped are being dropped
/// because their file just moved, not because the model changed. A missing
/// or corrupt ledger is a no-op: nothing to drop, and the next `scan` starts
/// one fresh anyway.
fn drop_ledger_entries(root: &Path, rels: &[String]) -> Result<(), String> {
    let Ok(raw) = std::fs::read_to_string(state_path(root)) else {
        return Ok(());
    };
    let Ok(mut state) = serde_json::from_str::<DistillState>(&raw) else {
        return Ok(());
    };
    let mut changed = false;
    for r in rels {
        changed |= state.scored.remove(r).is_some();
        changed |= state.rejected_ttl.remove(r).is_some();
    }
    if changed {
        state_save(root, &state)?;
    }
    Ok(())
}

/// Execute a proposal's action and flip its `status` to `done`. The frontend
/// (Task 9) flips `pending` -> `approved`/`dismissed` itself by rewriting the
/// file directly; this is the one lifecycle step that actually touches the
/// filesystem beyond that flip, so it is the one exposed as a command.
///
/// - `admit-cluster` -> `apply_admit_cluster`
/// - `archive-batch` -> `apply_archive_batch`
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
        "archive-batch" => apply_archive_batch(root, &files)?,
        "delete-batch" => apply_delete_batch(root, &files, &path)?,
        other => return Err(format!("proposal {rel_path} has unknown action `{other}`")),
    };

    set_proposal_status(&path, &raw, "done")?;
    Ok(outcome.summary())
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
/// 3. The undo manifest (`.myco/distill-runs/<id>.json`) is created and
///    persisted — empty, but on disk — BEFORE anything else moves a file, so
///    even a crash on the very first move leaves a valid (empty) manifest
///    rather than no manifest at all. `save_manifest` persists it again
///    after every single successful move, trash, and proposal write from
///    here on (including inside `scan` itself — see its own doc comment on
///    quarantine moves), not once at the end: a mid-run I/O failure never
///    loses the record of what already happened, only what would have
///    happened next.
/// 4. `scan` new inflow against that ontology (Task 4) — quarantine moves
///    are recorded into this same manifest as they happen.
/// 5. Archive pass: a top-level `raw/<slug>.md` that is mature and already
///    has a `wiki/source-<slug>.md` is "already represented" — move it to
///    `raw/archive/YYYY-MM/` (month from the file's own mtime). At
///    `Intensity::Conservative` this is a proposal instead of a move.
/// 6. TTL pass: quarantine sidecars past their `expires` move (file +
///    sidecar) to `.myco/trash/<run-id>/` at Standard/Aggressive, or propose
///    at Conservative. Trash dirs whose entire retention window has elapsed
///    are purged regardless of this run's intensity.
/// 7. Emerging-cluster + proposal pass (Task 7): quarantined items whose
///    pairwise similarity clusters into a group are proposed as a new topic
///    (`propose_emerging_clusters`), and any proposal already resolved
///    (approved/dismissed/done) is archived out of the pending feedback inbox
///    (`archive_resolved_proposals`).
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

    let mut manifest = RunManifest {
        id: id.clone(),
        started_at: now,
        ..Default::default()
    };
    // Persist immediately — before `scan` runs, not after — so a quarantine
    // move `scan` makes is never undo-blind: the manifest `scan` threads
    // through and saves into already exists on disk when that move happens.
    save_manifest(root, &manifest)?;

    let scan_outcome = scan(
        root,
        &ontology,
        cfg,
        cfg.run_budget_items,
        embed,
        &mut manifest,
    )?;

    let conservative = matches!(cfg.intensity, Intensity::Conservative);
    let maturation_secs = cfg.maturation_hours as i64 * 3600;
    let mut archived = 0usize;
    let mut proposals = 0usize;

    // ③.5 Summary-tier execution (Phase B, Task 1): a `scan` verdict of
    // Tier::Summary is "too thin to admit, too topical to ignore" — record
    // one low-confidence line in today's daily note and move the file out of
    // the active inflow trees, the same cold-tier destination (`raw/archive/`)
    // the "already represented" pass just below uses. Runs BEFORE that pass,
    // not after: a raw/ item that is BOTH summary-tier AND already has a
    // `wiki/source-<stem>.md` page must get its daily line here first — the
    // archive pass below would otherwise move it under the "already
    // represented" reason first, and this step would never see it again
    // (its ledger entry, keyed by the pre-move path, is gone the moment the
    // file moves).
    //
    // `sessions/` summary items are deliberately excluded: a per-session
    // daily line would be one line per work log, not the day-level digest
    // Phase B actually wants — see `digestable_session_days`/
    // `archive_digested_sessions` below, the per-day path for those instead.
    let summary_state = state_load(root, &ontology.model);
    let mut summary_entries: Vec<String> = summary_state
        .scored
        .iter()
        .filter(|(_, e)| e.tier == "summary")
        .map(|(rel, _)| rel.clone())
        .filter(|rel| {
            is_raw_top_level_payload_path(rel)
                || rel.starts_with(&format!("{}/", crate::commands::DEST_INBOX))
        })
        .collect();
    summary_entries.sort();

    let today = {
        let (y, m, d, ..) = civil_datetime(now);
        format!("{y:04}-{m:02}-{d:02}")
    };

    for rel in summary_entries {
        let path = root.join(&rel);
        if !path.exists() {
            continue; // already moved/gone since scan recorded it
        }
        let Some(mtime) = mtime_secs(&path) else {
            continue;
        };
        let Some(first_line) = std::fs::read_to_string(&path)
            .ok()
            .and_then(|c| first_summary_line(&c))
        else {
            continue; // unreadable/empty — nothing to digest
        };
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("item.md")
            .to_string();
        let month = month_bucket(mtime);

        if conservative {
            if pending_summary_batch_exists(root, &rel) {
                continue;
            }
            let proposal_rel = write_proposal(
                root,
                "summary-batch",
                &format!("Digest summary item {file_name}?"),
                &format!(
                    "`{rel}` scored summary-tier (low confidence). Standard/Aggressive \
                     intensity would append one line to `daily/{today}.md` and move it to \
                     `raw/archive/{month}/{file_name}`."
                ),
                &serde_json::json!({ "files": [rel.clone()] }),
            )?;
            manifest.created.push(proposal_rel);
            save_manifest(root, &manifest)?;
            proposals += 1;
        } else {
            let line = format!("- {first_line} — `{rel}` (low confidence)");
            // ponytail: no idempotency guard on the appended text itself — a
            // run that crashes between this append and the move below would
            // re-append the same line on retry (the item is still tier
            // "summary" until the move happens). Upgrade if that proves to
            // matter in practice; every other pass in `run` accepts the same
            // duplicate-on-retry ceiling (see `write_proposal`'s doc comment).
            let day_created = append_daily_summary_line(root, &today, &line)?;
            if day_created {
                manifest.created.push(format!("daily/{today}.md"));
                save_manifest(root, &manifest)?;
            }

            let archive_dir = root.join("raw/archive").join(&month);
            std::fs::create_dir_all(&archive_dir)
                .map_err(|e| format!("create archive dir: {e}"))?;
            let to_path = free_path(&archive_dir.join(&file_name));
            std::fs::rename(&path, &to_path).map_err(|e| format!("archive summary item: {e}"))?;
            manifest.moves.push(MoveEntry {
                from: rel.clone(),
                to: rel_string(root, &to_path),
            });
            save_manifest(root, &manifest)?;
            archived += 1;
        }
    }

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
                "archive-batch",
                &format!("Archive raw/{file_name}?"),
                &format!(
                    "`{source_page}` already represents this source. Standard/Aggressive \
                     intensity would move it to `raw/archive/{month}/{file_name}`."
                ),
                &serde_json::json!({ "files": [from_rel.clone()] }),
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

    // ⑤ TTL pass: quarantine sidecars past their expiry. A future
    // never-clustered check could additionally gate this — no sidecar
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
                "delete-batch",
                &format!("Delete expired quarantine item {stem}.md?"),
                &format!(
                    "Quarantine TTL expired at unix {expires}. Standard/Aggressive intensity \
                     would move `{content_rel}` and its sidecar to `.myco/trash/{id}/`."
                ),
                &serde_json::json!({ "files": [content_rel.clone()] }),
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

    // ⑥ Emerging-cluster + proposal pass (Task 7, design spec: "≥5
    // quarantined items with pairwise similarity above threshold -> 'new
    // topic forming' proposal"), plus archiving any proposal the lifecycle
    // already resolved. Both `save_manifest` after their own pushes, same as
    // every pass above.
    proposals += propose_emerging_clusters(root, &mut manifest)?;
    archive_resolved_proposals(root, &mut manifest)?;

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

/// Cheap vault-wide status for the settings tab / MCP `distill_status`: no
/// scoring, just a fs walk against the ledger already on disk.
pub fn status(root: &Path) -> DistillStatus {
    let store = crate::vector_index::VectorStore::path_for(&root.to_string_lossy())
        .map(|p| crate::vector_index::VectorStore::load(&p))
        .unwrap_or_default();
    let state = state_load(root, &store.model);
    DistillStatus {
        backlog: backlog_count(root, &state),
        pending_proposals: awaiting_resolution_count(root),
        last_run: state.last_run,
        last_backlogs: state.last_backlogs.clone(),
        gate_active: crate::commands::wiki_titles(root).len() >= GATE_MIN_WIKI_PAGES,
        last_run_id: newest_run_id(root),
    }
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
    pub bytes: u64,
}

/// `YYYY-MM-DD` for a swept session: extends `commands::session_bucket`'s
/// "prefer a date already in the stem" idea to day granularity — a plain
/// `YYYYMMDD` run of digits rather than `YYYY-MM`, since importers name files
/// after the full conversation date, not just its month. Falls back to the
/// file's own mtime (UTC) when the stem carries no such run.
fn session_day(stem: &str, mtime: i64) -> String {
    if let Some(pos) = stem.find(|c: char| c.is_ascii_digit()) {
        let tail = &stem[pos..];
        let b = tail.as_bytes();
        if b.len() >= 8 && b[0..8].iter().all(u8::is_ascii_digit) {
            let y: u16 = tail[0..4].parse().unwrap_or(0);
            let m: u8 = tail[4..6].parse().unwrap_or(0);
            let d: u8 = tail[6..8].parse().unwrap_or(0);
            if (1970..=2999).contains(&y) && (1..=12).contains(&m) && (1..=31).contains(&d) {
                return format!("{y:04}-{m:02}-{d:02}");
            }
        }
    }
    let (y, m, d, ..) = civil_datetime(mtime);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Groups mature, gate-scored `sessions/**/*.md` (excluding
/// `sessions/archive/`, via `walk_inflow`'s own exclusion — same walk
/// `collect_candidates` uses for this tree) by day, oldest day first. "Mature"
/// is the same `maturation_hours` gate `scan` uses; "gate-scored" means a
/// ledger entry exists at all (tier doesn't matter — an unscored file has no
/// verdict to digest around yet, but an already-summary/full/quarantine-tier
/// session log is still a work log worth digesting).
pub fn digestable_session_days(root: &Path) -> Vec<DigestDay> {
    let cfg = config_load(root);
    let maturation_secs = cfg.maturation_hours as i64 * 3600;
    let now = now_secs();

    let store = crate::vector_index::VectorStore::path_for(&root.to_string_lossy())
        .map(|p| crate::vector_index::VectorStore::load(&p))
        .unwrap_or_default();
    let state = state_load(root, &store.model);

    let mut candidates = Vec::new();
    walk_inflow(
        root,
        crate::commands::DEST_SESSIONS,
        &[RAW_ARCHIVE_DIR],
        &mut candidates,
    );

    let mut by_day: HashMap<String, (Vec<String>, u64)> = HashMap::new();
    for c in candidates {
        if now - c.mtime < maturation_secs {
            continue;
        }
        if !state.scored.contains_key(&c.rel) {
            continue;
        }
        let stem = c.path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        let day = session_day(stem, c.mtime);
        let bytes = std::fs::metadata(&c.path).map(|m| m.len()).unwrap_or(0);
        let entry = by_day.entry(day).or_insert_with(|| (Vec::new(), 0));
        entry.0.push(c.rel);
        entry.1 += bytes;
    }

    let mut days: Vec<DigestDay> = by_day
        .into_iter()
        .map(|(day, (mut files, bytes))| {
            files.sort();
            DigestDay { day, files, bytes }
        })
        .collect();
    days.sort_by(|a, b| a.day.cmp(&b.day));
    days
}

/// Moves each of `files` (already-digested `sessions/...` items) into
/// `sessions/archive/<YYYY-MM>/`, bucketed by `day`'s own month rather than
/// each file's individual mtime — every file in one call came from the same
/// `DigestDay`, so they share one bucket. Writes a fresh `RunManifest` (id
/// `digest-<unix-seconds>`), saved incrementally after each move —
/// `undo(root, id)` reverses it with zero new code, the same manifest shape
/// every other pass in `run` already produces. `files` is IPC input, so each
/// entry is confined to `sessions/...` and rejected if already under
/// `sessions/archive/` before it is ever joined onto `root`
/// (`confine_payload_file`, the same pattern `apply_proposal`'s passes use
/// for their own payload files).
pub fn archive_digested_sessions(
    root: &Path,
    day: &str,
    files: &[String],
) -> Result<String, String> {
    // Same digit-run + dash shape check `session_day`/`session_bucket` use —
    // `day` is IPC input, so this must reject a non-numeric day string
    // outright rather than let it become a junk `sessions/archive/<junk>/`
    // directory.
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
    let month = &day[..7];

    let now = now_secs();
    let id = free_manifest_id(root, &format!("digest-{now}"));
    let mut manifest = RunManifest {
        id: id.clone(),
        started_at: now,
        ..Default::default()
    };
    save_manifest(root, &manifest)?;

    let archive_dir = root
        .join(crate::commands::DEST_SESSIONS)
        .join(RAW_ARCHIVE_DIR)
        .join(month);
    std::fs::create_dir_all(&archive_dir)
        .map_err(|e| format!("create session archive dir: {e}"))?;

    for f in files {
        let from_path = confine_payload_file(root, f, is_session_payload_path, "sessions/")?;
        if !from_path.exists() {
            continue; // already moved/gone — idempotent, same as the apply_* passes
        }
        let from_rel = rel_string(root, &from_path);
        let file_name = from_path
            .file_name()
            .ok_or_else(|| format!("bad session path: {f}"))?;
        let to_path = free_path(&archive_dir.join(file_name));
        std::fs::rename(&from_path, &to_path).map_err(|e| format!("archive session move: {e}"))?;
        manifest.moves.push(MoveEntry {
            from: from_rel,
            to: rel_string(root, &to_path),
        });
        save_manifest(root, &manifest)?;
    }
    Ok(id)
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

    const PROSE: &str = "This is a normal note about quantization techniques and how they reduce model size while preserving accuracy across a range of benchmarks and downstream tasks in real deployments, and it keeps going a little further so the byte count clears the junk-heuristic floor.";

    /// Write a quarantined item's content file + verdict sidecar directly
    /// (bypassing `scan`) — the Task 7 clustering/proposal tests need control
    /// over the sidecar's `vector` field, which `scan`'s own embed closure
    /// does not expose per-file. `expires` is far in the future so the TTL
    /// pass never sweeps these away out from under a same-run cluster test.
    fn write_quarantine_item(dir: &Path, stem: &str, vector: Vec<f32>) {
        std::fs::write(dir.join(format!("{stem}.md")), format!("{PROSE} ({stem})")).unwrap();
        let sidecar = serde_json::json!({
            "tier": "quarantine",
            "s_knn": 0.2,
            "nearest_cluster": "topic",
            "reason": "test",
            "expires": now_secs() + 1_000_000,
            "vector": vector,
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
        let out = scan(root, &o, &cfg, 10, &embed, &mut manifest).unwrap();
        assert_eq!(out, ScanOutcome::default());
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
        let out = scan(root, &o, &cfg, 10, &embed, &mut manifest).unwrap();
        assert_eq!(out.scored, 2, "a.md and c.md are mature and unscored");
        assert_eq!(out.skipped_immature, 1, "b.md is under the maturation gate");

        let out2 = scan(root, &o, &cfg, 10, &embed, &mut manifest).unwrap();
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

        let mut manifest = test_manifest();
        let out = scan(root, &o, &cfg, 10, &embed, &mut manifest).unwrap();
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
        let out = scan(root, &o, &cfg, 10, &embed, &mut manifest).unwrap();
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

        // The move and the sidecar creation are both undo-tracked.
        assert_eq!(manifest.moves.len(), 1);
        assert_eq!(manifest.moves[0].from, "_inbox/c.md");
        assert_eq!(manifest.moves[0].to, "_inbox/quarantine/c.md");
        assert_eq!(manifest.created, vec!["_inbox/quarantine/c.verdict.json"]);
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

        let mut manifest = test_manifest();
        let out = scan(root, &o, &cfg, 10, &embed, &mut manifest).unwrap();
        assert_eq!(out.quarantined, 1);
        assert!(
            !root.join("raw/paper.md").exists(),
            "raw/ source must be moved, never left behind after quarantine"
        );
        assert!(root.join("_inbox/quarantine/paper.md").exists());
        assert!(root.join("_inbox/quarantine/paper.verdict.json").exists());
        assert_eq!(manifest.moves[0].from, "raw/paper.md");
    }

    /// Critical 2 fix: `scan`'s quarantine move used to be undo-blind (the
    /// manifest didn't exist yet when `scan` ran inside `run`). Proves the
    /// move AND the sidecar creation both land in the manifest `scan` is
    /// handed, and that `undo` reverses both — the file returns to its
    /// origin, the quarantine copy and sidecar are gone.
    #[test]
    fn undo_restores_a_quarantined_file_and_removes_its_sidecar() {
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
        let out = scan(root, &o, &cfg, 10, &embed, &mut manifest).unwrap();
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
        assert_eq!(reversed, 2, "1 file move + 1 sidecar deletion");
        assert!(
            root.join("_inbox/c.md").exists(),
            "file must be restored to its origin"
        );
        assert!(!root.join("_inbox/quarantine/c.md").exists());
        assert!(!root.join("_inbox/quarantine/c.verdict.json").exists());
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
        let out = scan(root, &o, &cfg, 10, &embed, &mut manifest).unwrap();
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
        let out2 = scan(root, &o, &cfg, 10, &embed, &mut manifest).unwrap();
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
            model: String::new(),
            built_at: 0,
            wiki_pages: GATE_MIN_WIKI_PAGES,
            clusters: vec![
                cluster(0, "topic-a", vec![1.0, 0.0, 0.0]),
                cluster(1, "topic-b", vec![0.0, 1.0, 0.0]),
            ],
            entities: Vec::new(),
        }
    }

    /// cosine 0.4 to cluster 0's centroid `[1,0,0]`, 0.0 to cluster 1's
    /// `[0,1,0]` — clears `t_summary` (0.30) but not `t_full` (0.50) against
    /// cluster 0 under `GatePreset::Normal`, and cluster 0 is the nearest
    /// either way (0.4 > 0.0).
    fn summary_tier_embed(texts: Vec<String>) -> Result<Vec<Vec<f32>>, String> {
        Ok(texts
            .iter()
            .map(|_| vec![0.4_f32, 0.0, (1.0 - 0.16_f32).sqrt()])
            .collect())
    }

    #[test]
    fn strip_atx_heading_only_strips_real_headings() {
        assert_eq!(strip_atx_heading("#hashtag trending"), "#hashtag trending");
        assert_eq!(strip_atx_heading("#1 issue"), "#1 issue");
        assert_eq!(strip_atx_heading("## Real heading"), "Real heading");
        assert_eq!(strip_atx_heading("# Title"), "Title");
    }

    #[test]
    fn summary_tier_items_get_a_daily_line_and_archive() {
        crate::settings::test_support::with_isolated_data("distill-summary-tier", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            seed_wiki_pages(root, GATE_MIN_WIKI_PAGES);
            std::fs::create_dir_all(root.join("_inbox")).unwrap();
            // Real shape of an imported _inbox doc (importers::Conversation::
            // to_inbox_doc): YAML frontmatter, then `# <title>` — the digest
            // line must skip both, not literally quote "---".
            std::fs::write(
                root.join("_inbox/note.md"),
                format!("---\nsource: test\n---\n\n# Heading text\n\n{PROSE}"),
            )
            .unwrap();
            set_mtime(&root.join("_inbox/note.md"), old_mtime());
            crate::ontology::save(root, &ontology_two_clusters()).unwrap();

            let cfg = DistillConfig::default(); // Standard intensity
            let report = run(root, &cfg, &summary_tier_embed).unwrap();
            assert_eq!(report.scan.summaries, 1);
            assert_eq!(report.proposals, 0);

            let (y, m, d, ..) = civil_datetime(now_secs());
            let today = format!("{y:04}-{m:02}-{d:02}");
            let daily =
                std::fs::read_to_string(root.join("daily").join(format!("{today}.md"))).unwrap();
            assert!(daily.contains("## Distill summary (auto)"));
            assert!(daily.contains("(low confidence)"));
            assert!(daily.contains("_inbox/note.md"));
            assert!(
                daily.contains("Heading text"),
                "digest line must skip frontmatter + heading marker, got: {daily}"
            );
            assert!(
                !daily.contains("---"),
                "digest line must not literally quote the frontmatter delimiter: {daily}"
            );

            assert!(
                !root.join("_inbox/note.md").exists(),
                "digested item must move out of _inbox/"
            );
            let month_dirs: Vec<_> = std::fs::read_dir(root.join("raw/archive"))
                .unwrap()
                .flatten()
                .collect();
            assert_eq!(month_dirs.len(), 1);
            let moved = std::fs::read_dir(month_dirs[0].path())
                .unwrap()
                .flatten()
                .next()
                .unwrap();
            assert_eq!(moved.file_name(), "note.md");

            let manifest_raw = std::fs::read_to_string(manifest_path(root, &report.id)).unwrap();
            assert!(manifest_raw.contains("_inbox/note.md"));
        });

        // Conservative: the file stays put and a summary-batch proposal
        // appears instead.
        crate::settings::test_support::with_isolated_data(
            "distill-summary-tier-conservative",
            |_data| {
                let dir = tempfile::tempdir().unwrap();
                let root = dir.path();
                seed_wiki_pages(root, GATE_MIN_WIKI_PAGES);
                std::fs::create_dir_all(root.join("_inbox")).unwrap();
                std::fs::write(root.join("_inbox/note.md"), PROSE).unwrap();
                set_mtime(&root.join("_inbox/note.md"), old_mtime());
                crate::ontology::save(root, &ontology_two_clusters()).unwrap();

                let cfg = DistillConfig {
                    intensity: Intensity::Conservative,
                    ..Default::default()
                };
                let report = run(root, &cfg, &summary_tier_embed).unwrap();
                assert_eq!(report.scan.summaries, 1);
                assert_eq!(report.proposals, 1);
                assert!(
                    root.join("_inbox/note.md").exists(),
                    "conservative intensity must not move the file"
                );

                let feedback: Vec<_> = std::fs::read_dir(root.join("work/feedback"))
                    .unwrap()
                    .flatten()
                    .collect();
                assert_eq!(feedback.len(), 1);
                let content = std::fs::read_to_string(feedback[0].path()).unwrap();
                assert!(content.contains("action: summary-batch"));
            },
        );
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
            let mut state = DistillState::default();
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
                    },
                );
            }
            state_save(root, &state).unwrap();

            let days = digestable_session_days(root);
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
        let id = archive_digested_sessions(root, "2026-08-10", &files).unwrap();

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
        assert!(archive_digested_sessions(root, "2026-08-10", &bad).is_err());

        // Untrusted day: right shape (10 chars, dashes at 4/7) but non-numeric
        // must be rejected too, not land a junk `sessions/archive/<day>/` dir.
        assert!(archive_digested_sessions(root, "abcd-ef-gh", &files).is_err());
        assert!(!root.join("sessions/archive/abcd-ef").exists());
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
            seed_wiki_pages(root, GATE_MIN_WIKI_PAGES); // keep the cold-start gate active
            std::fs::write(root.join("_inbox/a.md"), PROSE).unwrap();
            std::fs::write(root.join("_inbox/b.md"), PROSE).unwrap();
            set_mtime(&root.join("_inbox/a.md"), old_mtime());
            set_mtime(&root.join("_inbox/b.md"), old_mtime());

            let cfg = DistillConfig::default();

            let before = status(root);
            assert_eq!(before.backlog, 2, "two unscored, mature inflow items");
            assert!(before.gate_active, "50 wiki pages meets the gate threshold");
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

    // -----------------------------------------------------------------------
    // Task 7: emerging-cluster detection + proposal lifecycle.
    // -----------------------------------------------------------------------

    #[test]
    fn emerging_clusters_ignores_dissimilar_and_undersized_groups() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
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

        let groups = emerging_clusters(root, 5, 0.9);
        assert_eq!(groups.len(), 1, "only the 5-item group clears min_size");
        assert_eq!(groups[0].len(), 5);
        for i in 0..5 {
            assert!(groups[0].contains(&format!("_inbox/quarantine/sim{i}.md")));
        }
    }

    #[test]
    fn five_similar_quarantined_items_produce_one_proposal() {
        crate::settings::test_support::with_isolated_data("distill-emerging-cluster", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
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

        for kind in ["admit-cluster", "archive-batch", "delete-batch"] {
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

    #[test]
    fn archive_batch_and_delete_batch_apply_the_same_move_semantics_as_run() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("raw")).unwrap();
        std::fs::write(root.join("raw/paper.md"), PROSE).unwrap();
        set_mtime(&root.join("raw/paper.md"), old_mtime());
        let mtime = mtime_secs(&root.join("raw/paper.md")).unwrap();

        let archive_rel = write_proposal(
            root,
            "archive-batch",
            "Archive raw/paper.md?",
            "body",
            &serde_json::json!({ "files": ["raw/paper.md"] }),
        )
        .unwrap();
        apply_proposal(root, &archive_rel).unwrap();
        assert!(!root.join("raw/paper.md").exists());
        let month = month_bucket(mtime);
        assert!(root.join(format!("raw/archive/{month}/paper.md")).exists());

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

                let rel = write_proposal(
                    root,
                    "archive-batch",
                    "Archive raw/x.md?",
                    "body",
                    &serde_json::json!({ "files": ["raw/x.md"] }),
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
}
