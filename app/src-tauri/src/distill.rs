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

use crate::ontology::{admit, Ontology, Tier, Verdict, FIELD_CLUSTER_ID};
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

/// `<root>/profile.md`'s `## Interests` bullets, via a plain string scan —
/// profile.md is markdown with no YAML frontmatter (see `app/src/lib/
/// profile.ts::parseProfile`, the TS mirror of this same section format), so
/// a `gray_matter` parse does not apply here. Missing file or missing/empty
/// section -> empty (the caller's zero-cost, no-lift path).
fn read_profile_interests(root: &Path) -> Vec<String> {
    let Ok(content) = std::fs::read_to_string(root.join("profile.md")) else {
        return Vec::new();
    };
    let mut interests = Vec::new();
    let mut in_interests = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            in_interests = trimmed.eq_ignore_ascii_case("## interests");
            continue;
        }
        if !in_interests {
            continue;
        }
        let Some(item) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
        else {
            continue;
        };
        let item = item.trim();
        if !item.is_empty() {
            interests.push(item.to_string());
        }
    }
    interests
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
    profile_vecs: &[Vec<f32>],
    manifest: &mut RunManifest,
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
                admit(o, &vector, &item.content, &cfg.gate_preset, profile_vecs)
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
    /// Wiki page count `gate_active` was computed from (Defect D) — the same
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

/// The one write path into `.myco/distill-runs/<id>.json` for TS-side steps
/// that run outside Rust — session-digest's daily-file create, full-tier
/// ingest's `_inbox/` archive + `raw/` create, draftMap's map-file create.
/// Without this, those writes were invisible to `undo`: Rust's own
/// archive/trash/proposal passes already call `save_manifest` after every
/// step, but nothing let the TS chain add to the SAME manifest afterward, so
/// "undo this run" never reversed the LLM steps that actually ran.
///
/// Creates-or-extends: a manifest already on disk under `id` (an earlier
/// Rust-side pass, or an earlier TS append this same run) is read back and
/// appended to; otherwise a fresh one is started with `started_at` set to
/// now (this call's own instant is the closest available stand-in for "when
/// the run this write belongs to began" — good enough for undo's "modified
/// since the run" check, since nothing in the manifest predates it).
///
/// Every `from`/`to`/`created` path is confined via `myco_pro::safe_join`
/// before anything is written — the same guard every other payload path in
/// this file goes through (`confine_payload_file`). `undo` later joins
/// manifest paths straight onto `root` and moves/deletes through them, so an
/// unconfined string here (this command's whole purpose is accepting
/// externally-supplied paths) would be a path-traversal write into an
/// arbitrary undo entry, not merely a bad bookkeeping row.
pub(crate) fn append_distill_manifest(
    root: &Path,
    id: &str,
    moves: Vec<MoveEntry>,
    created: Vec<String>,
) -> Result<(), String> {
    if !valid_manifest_id(id) {
        return Err(format!("bad manifest id `{id}`"));
    }
    for m in &moves {
        crate::myco_pro::safe_join(root, &m.from)?;
        crate::myco_pro::safe_join(root, &m.to)?;
    }
    for c in &created {
        crate::myco_pro::safe_join(root, c)?;
    }
    let mut manifest = std::fs::read_to_string(manifest_path(root, id))
        .ok()
        .and_then(|raw| serde_json::from_str::<RunManifest>(&raw).ok())
        .unwrap_or_else(|| RunManifest {
            id: id.to_string(),
            started_at: now_secs(),
            ..Default::default()
        });
    manifest.moves.extend(moves);
    manifest.created.extend(created);
    save_manifest(root, &manifest)
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
    /// Unix seconds the TTL sweep becomes eligible to trash this; 0 if unknown.
    pub expires: i64,
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

/// "Keep N more days": push each item's sidecar `expires` out by `days` from
/// whichever is later, now or its current expiry, so extending a not-yet-
/// expired item adds to its remaining time instead of shortening it. Only the
/// `expires` key is rewritten — the vector and verdict fields are left exactly
/// as scanned. Returns how many sidecars were actually rewritten (a missing or
/// unparseable sidecar is skipped, not an error: the item stays listed and the
/// TTL sweep already ignores it for the same reason).
pub fn extend_quarantine(root: &Path, files: &[String], days: u32) -> Result<usize, String> {
    let now = now_secs();
    let mut extended = 0usize;
    for f in files {
        let content_path =
            confine_payload_file(root, f, is_quarantine_payload_path, "_inbox/quarantine/")?;
        let path = sidecar_path(&content_path);
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(mut sidecar) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let Some(map) = sidecar.as_object_mut() else {
            continue;
        };
        let current = map.get("expires").and_then(|v| v.as_i64()).unwrap_or(0);
        let base = current.max(now);
        map.insert(
            "expires".into(),
            serde_json::json!(base + days as i64 * 86_400),
        );
        let out = serde_json::to_string_pretty(&sidecar)
            .map_err(|e| format!("serialize verdict: {e}"))?;
        std::fs::write(&path, out).map_err(|e| format!("write verdict sidecar: {e}"))?;
        extended += 1;
    }
    Ok(extended)
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
    let raw = std::fs::read_to_string(sidecar_path(&content_path)).ok()?;
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
        let dest = free_path(&inbox_dir.join(file_name));
        std::fs::rename(&content_path, &dest).map_err(|e| format!("move {f} to _inbox: {e}"))?;
        // best-effort; a missing sidecar isn't fatal
        let _ = std::fs::remove_file(sidecar_path(&content_path));
        outcome.moved += 1;
    }
    drop_ledger_entries(root, files)?;
    Ok(outcome)
}

/// "Restore to the vault" from the quarantine review UI — the SAME re-admit
/// path an approved `admit-cluster` proposal takes (`apply_admit_cluster`),
/// so a one-off manual restore and a cluster admit can never drift apart.
/// Returns its `"moved N, skipped M already-processed"` summary.
pub fn readmit_quarantine(root: &Path, files: &[String]) -> Result<String, String> {
    Ok(apply_admit_cluster(root, files)?.summary())
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

/// `(cluster label, page centroid)` for every `wiki/maps/` page on disk whose
/// `cluster:` frontmatter names a real cluster — `ontology::build`'s
/// `map_anchors` parameter (Phase B, Task 4). Computed from `store`'s own
/// per-page centroids (`page_centroids`, already computed for every other
/// page) rather than re-embedding anything.
fn map_anchors_from_store(
    root: &Path,
    store: &crate::vector_index::VectorStore,
) -> Vec<(String, Vec<f32>)> {
    store
        .page_centroids()
        .into_iter()
        .filter(|(page, _)| page.starts_with("wiki/maps/"))
        .filter_map(|(page, vector)| {
            let content = std::fs::read_to_string(root.join(&page)).ok()?;
            let map = page_frontmatter(&content)?;
            match map.get("cluster") {
                Some(gray_matter::Pod::String(s)) => Some((s.clone(), vector)),
                _ => None,
            }
        })
        .collect()
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
/// 4. `scan` new inflow against that ontology (Task 4) plus the identity
///    layer — `profile.md`'s `## Interests` bullets, batch-embedded ONCE
///    here (Phase B, Task 5) and passed through to every `admit()` call —
///    quarantine moves are recorded into this same manifest as they happen.
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
/// 8. Map-candidate + proposal pass (Task 4, Phase B): a topic cluster that
///    has grown to enough mature members, with no `wiki/maps/` page yet,
///    gets a `draft-map` proposal (`propose_map_candidates`) — the LLM draft
///    itself runs TS-side.
/// 9. Write the human report (`ingest-reports/distill-<id>.md`).
/// 10. Append this run's backlog to the rolling trend, and commit if the
///     vault is a git repo.
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
        let map_anchors = map_anchors_from_store(root, &store);
        let mut o = crate::ontology::build(&store, &titles, &map_anchors);
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

    // Identity layer (Phase B, Task 5): profile.md's `## Interests` bullets,
    // batch-embedded ONCE per run (not per item, unlike the per-candidate
    // embedding below) and handed to every `admit()` call `scan` makes.
    // Missing/interest-less profile.md costs nothing — no embed call at all.
    // A failure here DEGRADES rather than fails the whole run (`unwrap_or_
    // else`, not `?`) — same "log and proceed" precedent as
    // `partition_sessions` above: personalisation is a nicety layered on
    // top of the lifecycle engine, not a precondition for it, so one flaky
    // embed-provider call must not take down scan/archive/TTL for the
    // entire run. Degrading to `Vec::new()` means simply no profile lift
    // this run (identical to no profile.md at all), never a corrupted one.
    let profile_interests = read_profile_interests(root);
    let profile_vecs: Vec<Vec<f32>> = if profile_interests.is_empty() {
        Vec::new()
    } else {
        embed(profile_interests).unwrap_or_else(|e| {
            crate::perf::log("distill_profile_embed_failed", &[]);
            eprintln!("distill profile embed failed (continuing without lift): {e}");
            Vec::new()
        })
    };

    let scan_outcome = scan(
        root,
        &ontology,
        cfg,
        cfg.run_budget_items,
        embed,
        &profile_vecs,
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
            // Idempotency: a run that crashed between a previous append and
            // the move below left this item's line in today's file already
            // (the item stays tier "summary" until the move happens) — the
            // line's own `` `<rel>` `` token marks it, so skip the append and
            // retry only the move.
            // ponytail: the dedup is bound to TODAY's file + the rel token —
            // a retry landing on a later calendar day re-appends into the new
            // day's file (yesterday's isn't checked), and a new file later
            // reusing the same rel path within one day would be skipped.
            // Upgrade to a content-bound marker (see `DIGEST_MARKER_OPEN`,
            // the session-digest fix) if either proves to matter.
            // Match the token only on a summary bullet line, so prose
            // elsewhere in the note that merely mentions the same path
            // (a user's own writing, a digest quote) can't suppress a
            // legitimate append.
            let token = format!("`{rel}`");
            let already_appended =
                std::fs::read_to_string(root.join("daily").join(format!("{today}.md")))
                    .map(|c| c.lines().any(|l| l.starts_with("- ") && l.contains(&token)))
                    .unwrap_or(false);
            if !already_appended {
                let day_created = append_daily_summary_line(root, &today, &line)?;
                if day_created {
                    manifest.created.push(format!("daily/{today}.md"));
                    save_manifest(root, &manifest)?;
                }
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
    // topic forming' proposal"). `save_manifest` after its own pushes, same
    // as every pass above.
    proposals += propose_emerging_clusters(root, &mut manifest)?;

    // ⑥.5 Map-candidate + proposal pass (Task 4, Phase B): a topic cluster
    // that has grown big and mature enough gets a `draft-map` proposal
    // instead — see `propose_map_candidates`'s own doc comment for the
    // Aggressive-intensity bridge to TS.
    proposals += propose_map_candidates(root, &ontology, cfg, &mut manifest)?;

    // Archive any proposal (of either kind above) the lifecycle already
    // resolved (approved/dismissed/done).
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
    let wiki_pages = crate::commands::wiki_titles(root).len();
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

/// Gate-admitted Full-tier ledger entries ready for the LLM ingest pipeline
/// (Phase B, Task 3) — every `scored` entry whose tier is `"full"`, still
/// sitting in `_inbox/` or `raw/`'s own top level, has no `wiki/source-
/// <stem>.md` yet, and is still present on disk — oldest file mtime first,
/// the same order `collect_candidates` fills the ledger in, so ingest drains
/// the queue in the order `scan` built it.
///
/// The `wiki/source-<stem>.md` check (same "already represented" signal the
/// raw/ archive pass itself checks — see its `source_page` lookup above) is
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
pub fn full_tier_items(root: &Path) -> Vec<String> {
    let store = crate::vector_index::VectorStore::path_for(&root.to_string_lossy())
        .map(|p| crate::vector_index::VectorStore::load(&p))
        .unwrap_or_default();
    let state = state_load(root, &store.model);
    let inbox_prefix = format!("{}/", crate::commands::DEST_INBOX);
    let mut items: Vec<(String, i64)> = state
        .scored
        .iter()
        .filter(|(rel, e)| {
            e.tier == "full"
                && (rel.starts_with(&inbox_prefix) || is_raw_top_level_payload_path(rel))
        })
        .filter(|(rel, _)| {
            let stem = Path::new(rel.as_str())
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(rel.as_str());
            !root.join(format!("wiki/source-{stem}.md")).exists()
        })
        .filter_map(|(rel, _)| {
            let meta = std::fs::metadata(root.join(rel)).ok()?;
            let mtime = meta
                .modified()
                .ok()?
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            Some((rel.clone(), mtime))
        })
        .collect();
    items.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
    items.into_iter().map(|(rel, _)| rel).collect()
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
fn content_fingerprint(bytes: &[u8]) -> String {
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
    std::fs::read(path)
        .is_ok_and(|bytes| entries.contains(&format!("{stem}:{}", content_fingerprint(&bytes))))
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
        let ready = mature && state.scored.contains_key(&c.rel);
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
///
/// `fingerprints` is the caller's per-file record of the bytes it actually
/// digested (parallel to `files`, the same values it wrote into the digest
/// marker). Each file's fingerprint is recomputed here, immediately before
/// its rename, and a mismatch LEAVES THE FILE IN `sessions/` and out of the
/// manifest: the auto-collect sweep (src/lib/autoImport.ts) runs on its own
/// timer and rewrites a resumed conversation's file in place, so bytes that
/// arrived after the caller's read are undigested and must stay where the
/// next run can see them — `walk_inflow` excludes `sessions/archive/`
/// forever. `None` is the archive-retry path, whose digest was written by an
/// earlier run and which therefore has no fingerprints of its own: the
/// digest markers on disk are the record there, checked with the same
/// `is_digested` that decided to offer the day at all.
pub fn archive_digested_sessions(
    root: &Path,
    day: &str,
    files: &[String],
    fingerprints: Option<&[String]>,
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

    if let Some(fps) = fingerprints {
        if fps.len() != files.len() {
            return Err(format!(
                "{} fingerprints for {} files",
                fps.len(),
                files.len()
            ));
        }
    }
    let recorded = match fingerprints {
        Some(_) => Default::default(),
        None => digested_session_entries(root),
    };

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

    for (i, f) in files.iter().enumerate() {
        let from_path = confine_payload_file(root, f, is_session_payload_path, "sessions/")?;
        if !from_path.exists() {
            continue; // already moved/gone — idempotent, same as the apply_* passes
        }
        let stem = from_path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        let digested = match fingerprints {
            Some(fps) => std::fs::read(&from_path).is_ok_and(|b| content_fingerprint(&b) == fps[i]),
            None => is_digested(&recorded, stem, &from_path),
        };
        if !digested {
            // Rewritten under us since it was digested. Leaving it in
            // `sessions/` costs one duplicated digest of its earlier turns on
            // the next run; archiving it loses the new ones for good.
            continue;
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
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
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
fn is_iso_week_name(bucket: &str) -> bool {
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
fn is_month_name(bucket: &str) -> bool {
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

/// Moves each of `files` (already-rolled-up `<layer.src>/...` notes) into
/// `<layer.src>/archive/<bucket>/`, the cold tier (`vector_index::is_cold`) —
/// the literal counterpart of `archive_digested_sessions`, which is where
/// every guard below comes from: `confine_payload_file` on untrusted IPC
/// paths, a fingerprint recheck immediately before each rename so a file
/// rewritten since it was read stays put, and a `digest-<unix-seconds>`
/// `RunManifest` saved after every move so `undo(root, id)` reverses it with
/// no new code.
///
/// The archive bucket is the rolled-up unit itself (an ISO week for the
/// weekly layer, a month for the monthly one) rather than
/// `archive_digested_sessions`'s fixed `YYYY-MM`: a rollup covers exactly one
/// bucket, so one directory per rollup maps 1:1 onto the
/// `<layer.out>/<bucket>.md` that replaced it — and a week can straddle two
/// months, which a month bucket would have to pick a side of anyway.
///
/// `fingerprints` is the caller's record of the bytes it actually rolled up.
/// `None` is the archive-retry path (an earlier run wrote the rollup and this
/// one only re-attempts the move), which falls back to the on-disk rollup
/// markers via the same `is_digested` that offered the bucket.
pub fn archive_rolled(
    root: &Path,
    layer: &RollupLayer,
    bucket: &str,
    files: &[String],
    fingerprints: Option<&[String]>,
) -> Result<String, String> {
    // `bucket` is IPC input and becomes a directory name — reject anything
    // that is not this layer's exact bucket shape rather than create a junk
    // archive directory.
    if !(layer.valid_bucket)(bucket) {
        return Err(format!("bad {} bucket `{bucket}`", layer.out));
    }

    if let Some(fps) = fingerprints {
        if fps.len() != files.len() {
            return Err(format!(
                "{} fingerprints for {} files",
                fps.len(),
                files.len()
            ));
        }
    }
    let recorded = match fingerprints {
        Some(_) => Default::default(),
        None => marker_entries(&root.join(layer.out), ROLLUP_MARKER_OPEN),
    };

    let now = now_secs();
    let id = free_manifest_id(root, &format!("digest-{now}"));
    let mut manifest = RunManifest {
        id: id.clone(),
        started_at: now,
        ..Default::default()
    };
    save_manifest(root, &manifest)?;

    let archive_dir = root.join(layer.src).join(RAW_ARCHIVE_DIR).join(bucket);
    std::fs::create_dir_all(&archive_dir)
        .map_err(|e| format!("create {} archive dir: {e}", layer.src))?;

    let expected = format!("{}/", layer.src);
    for (i, f) in files.iter().enumerate() {
        let from_path = confine_payload_file(root, f, layer.payload_ok, &expected)?;
        if !from_path.exists() {
            continue; // already moved/gone — idempotent, same as every other pass
        }
        let stem = from_path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        let rolled = match fingerprints {
            Some(fps) => std::fs::read(&from_path).is_ok_and(|b| content_fingerprint(&b) == fps[i]),
            None => is_digested(&recorded, stem, &from_path),
        };
        if !rolled {
            // Appended to (a later session digest) or hand-edited since it was
            // read. Leaving it in `daily/` costs one duplicated rollup of its
            // earlier bullets next run; archiving it loses the new ones.
            continue;
        }
        let from_rel = rel_string(root, &from_path);
        let file_name = from_path
            .file_name()
            .ok_or_else(|| format!("bad {} path: {f}", layer.src))?;
        let to_path = free_path(&archive_dir.join(file_name));
        std::fs::rename(&from_path, &to_path)
            .map_err(|e| format!("archive {} move: {e}", layer.src))?;
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

        // The move and the sidecar creation are both undo-tracked.
        assert_eq!(manifest.moves.len(), 1);
        assert_eq!(manifest.moves[0].from, "_inbox/c.md");
        assert_eq!(manifest.moves[0].to, "_inbox/quarantine/c.md");
        assert_eq!(manifest.created, vec!["_inbox/quarantine/c.verdict.json"]);

        // Defect G fix — DistillStatus.quarantined counts it, read-only.
        assert_eq!(status(root).quarantined, 1);
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
        let out = scan(root, &o, &cfg, 10, &embed, &[], &mut manifest).unwrap();
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
            crate::ontology::save(root, &ontology_two_clusters()).unwrap();

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

    /// Crash-retry idempotency for the summary tier: run once (append + move
    /// done), then recreate the retry state a crash between the two leaves —
    /// the daily line already written, the file still in `_inbox/` — and run
    /// again. The line must not duplicate, and the move must still complete.
    #[test]
    fn summary_tier_retry_skips_the_already_appended_line_and_still_moves() {
        crate::settings::test_support::with_isolated_data("distill-summary-retry", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            seed_wiki_pages(root, GATE_MIN_WIKI_PAGES);
            std::fs::create_dir_all(root.join("_inbox")).unwrap();
            std::fs::write(root.join("_inbox/note.md"), PROSE).unwrap();
            set_mtime(&root.join("_inbox/note.md"), old_mtime());
            crate::ontology::save(root, &ontology_two_clusters()).unwrap();

            let cfg = DistillConfig::default(); // Standard intensity
            let report = run(root, &cfg, &summary_tier_embed).unwrap();
            assert_eq!(report.archived, 1);

            // Simulate the crash-before-move retry state: the appended line is
            // durable in daily/<today>.md, but the item is back in _inbox/
            // (as if the archive rename never happened).
            let month_dir = std::fs::read_dir(root.join("raw/archive"))
                .unwrap()
                .flatten()
                .next()
                .unwrap()
                .path();
            std::fs::rename(month_dir.join("note.md"), root.join("_inbox/note.md")).unwrap();

            let report = run(root, &cfg, &summary_tier_embed).unwrap();
            assert_eq!(report.archived, 1, "the retry must still complete the move");
            assert!(!root.join("_inbox/note.md").exists());
            assert!(month_dir.join("note.md").exists());

            let (y, m, d, ..) = civil_datetime(now_secs());
            let daily = std::fs::read_to_string(
                root.join("daily").join(format!("{y:04}-{m:02}-{d:02}.md")),
            )
            .unwrap();
            assert_eq!(
                daily.matches("`_inbox/note.md`").count(),
                1,
                "retry must not re-append the same summary line: {daily}"
            );
        });
    }

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
                assert!(
                    digestable_session_days(root).is_empty(),
                    "a day with any unscored file must not be offered, even partially"
                );

                // Once c.md is scored too, the day qualifies with all three files.
                state.scored.insert(
                    "sessions/2026-08/20260810-c.md".to_string(),
                    ScoredEntry {
                        hash: 0,
                        tier: "summary".into(),
                        at: now_secs(),
                    },
                );
                state_save(root, &state).unwrap();
                let days = digestable_session_days(root);
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

        let mut state = state_load(root, "");
        state.scored.insert(
            rel.clone(),
            ScoredEntry {
                hash: 0,
                tier: "summary".into(),
                at: now_secs(),
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

            let days = digestable_session_days(root);
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
            let days = digestable_session_days(root);
            assert_eq!(days.len(), 1);
            assert!(days[0].already_digested);
            assert_eq!(days[0].files, files);

            // A failed archive attempt (a bad day string stands in for any
            // archive failure — see archive_digested_sessions's validation)
            // leaves the record where it is: in daily/, untouched.
            assert!(archive_digested_sessions(root, "not-a-day", &files, None).is_err());
            assert!(digestable_session_days(root)[0].already_digested);

            // Once the archive succeeds the files leave sessions/ and the day
            // disappears — nothing left to retry.
            archive_digested_sessions(root, "2026-08-10", &files, None).unwrap();
            assert!(digestable_session_days(root).is_empty());
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
            let day_one = digestable_session_days(root)[0].day.clone();
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

            let days = digestable_session_days(root);
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
            let days = digestable_session_days(root);
            assert_eq!(days.len(), 1);
            assert!(!days[0].already_digested);
            assert_eq!(days[0].files, vec![new.clone()]);

            // Archiving that one leaves the earlier, already-recorded file —
            // which the next run picks up as a pure archive retry.
            let new_fp = file_fingerprint(root, &new);
            archive_digested_sessions(root, "2026-08-10", &[new], Some(&[new_fp])).unwrap();
            let days = digestable_session_days(root);
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
            let day = digestable_session_days(root)[0].day.clone();
            write_daily_with_marker(root, &day, &[&first_entry]);

            let days = digestable_session_days(root);
            assert_eq!(days.len(), 1);
            assert!(
                !days[0].already_digested,
                "the grown file is not the file that was digested"
            );
            assert_eq!(days[0].files, vec![rel.clone()]);

            // …and once THIS content is recorded, the day goes back to being a
            // pure archive retry — no second LLM call.
            write_daily_with_marker(root, &day, &[&first_entry, &marker_entry(root, &rel)]);
            let days = digestable_session_days(root);
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
            let day = digestable_session_days(root)[0].day.clone();
            write_daily_with_marker(root, &day, &["claude-code-abc"]);

            let days = digestable_session_days(root);
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
            assert!(digestable_session_days(root)[0].already_digested);
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
        let id = archive_digested_sessions(root, "2026-08-10", &files, Some(&fps)).unwrap();

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
            let day = digestable_session_days(root)[0].day.clone();

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

            let id = archive_digested_sessions(root, &day, &files, Some(&fps)).unwrap();

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
            let days = digestable_session_days(root);
            assert_eq!(days.len(), 1);
            assert!(!days[0].already_digested);
            assert_eq!(days[0].files, vec![resumed]);
        });
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
            let day = digestable_session_days(root)[0].day.clone();
            // A genuine record for a DIFFERENT (already archived) file, whose
            // fingerprint happens to be this hand-placed file's name tail.
            write_daily_with_marker(root, &day, &["claude-code-abc:1a2b3c4d"]);

            let days = digestable_session_days(root);
            assert_eq!(days.len(), 1);
            assert!(
                !days[0].already_digested,
                "a `:`-bearing stem must never take the legacy bare-stem path"
            );
            assert_eq!(days[0].files, vec![rel.clone()]);

            // Its own content-bound record still works: <stem>:<fingerprint>.
            write_daily_with_marker(root, &day, &[&marker_entry(root, &rel)]);
            assert!(digestable_session_days(root)[0].already_digested);
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
    fn full_tier_items_lists_inbox_and_raw_oldest_first_and_drops_missing_or_wrong_tier() {
        crate::settings::test_support::with_isolated_data("distill-full-tier-items", |_data| {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            std::fs::create_dir_all(root.join("_inbox")).unwrap();
            std::fs::create_dir_all(root.join("raw")).unwrap();

            let full_text = format!("{PROSE} FULL marker so this note lands the full tier.");
            let quarantine_text =
                format!("{PROSE} BORDERLINE marker so this note lands the quarantine tier.");
            std::fs::write(root.join("_inbox/newer-full.md"), &full_text).unwrap();
            std::fs::write(root.join("raw/older-full.md"), &full_text).unwrap();
            std::fs::write(root.join("_inbox/quar.md"), &quarantine_text).unwrap();
            for name in [
                "_inbox/newer-full.md",
                "raw/older-full.md",
                "_inbox/quar.md",
            ] {
                set_mtime(&root.join(name), old_mtime());
            }
            // Strictly older than the other two, so it must sort first.
            set_mtime(
                &root.join("raw/older-full.md"),
                old_mtime() - std::time::Duration::from_secs(3600),
            );

            // `full_tier_items` resolves its ledger's model the same way
            // `status` does — off the on-disk VectorStore for `root`, which
            // this test never writes, so it defaults to "". The scan below
            // must ledger against that same "" or `state_load` sees a model
            // mismatch and hands back an empty (fresh) ledger instead of the
            // one just written.
            let mut o = tiny_ontology();
            o.model = String::new();
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

            let items = full_tier_items(root);
            assert_eq!(
                items,
                vec!["raw/older-full.md", "_inbox/newer-full.md"],
                "full-tier only, oldest mtime first; the quarantine-tier item is excluded"
            );

            // Phase A's later archive pass moves an ingested raw/ file away —
            // the stale ledger key must drop out rather than point nowhere.
            std::fs::remove_file(root.join("raw/older-full.md")).unwrap();
            let items2 = full_tier_items(root);
            assert_eq!(
                items2,
                vec!["_inbox/newer-full.md"],
                "a retired raw file drops out even though its ledger entry remains"
            );
        });
    }

    #[test]
    fn full_tier_items_excludes_a_nested_raw_file() {
        // `raw/` is walked recursively by `collect_candidates`, so a file at
        // e.g. `raw/sub/x.md` can score full tier same as a top-level one —
        // but `run`'s own archive pass and the ingest prompt both assume a
        // flat `raw/<slug>.md`. Listing it here would hand ingest a path it
        // can never actually act on.
        crate::settings::test_support::with_isolated_data(
            "distill-full-tier-nested-raw",
            |_data| {
                let dir = tempfile::tempdir().unwrap();
                let root = dir.path();
                std::fs::create_dir_all(root.join("raw/sub")).unwrap();

                let full_text = format!("{PROSE} FULL marker so this note lands the full tier.");
                std::fs::write(root.join("raw/sub/nested.md"), &full_text).unwrap();
                std::fs::write(root.join("raw/top.md"), &full_text).unwrap();
                for name in ["raw/sub/nested.md", "raw/top.md"] {
                    set_mtime(&root.join(name), old_mtime());
                }

                let mut o = tiny_ontology();
                o.model = String::new();
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

                let items = full_tier_items(root);
                assert_eq!(
                    items,
                    vec!["raw/top.md"],
                    "the nested raw file must not be listed"
                );
            },
        );
    }

    #[test]
    fn full_tier_items_skips_an_item_whose_source_page_already_exists() {
        // Reproduces the Conservative-intensity re-ingest loop: `run`'s raw/
        // archive pass only writes a proposal at Conservative, so an ingested
        // full-tier item's file never moves and its ledger entry never goes
        // stale — without the source-page check, it would be re-listed (and
        // re-ingested) every run until a human approves the proposal.
        crate::settings::test_support::with_isolated_data(
            "distill-full-tier-already-represented",
            |_data| {
                let dir = tempfile::tempdir().unwrap();
                let root = dir.path();
                std::fs::create_dir_all(root.join("raw")).unwrap();
                std::fs::create_dir_all(root.join("wiki")).unwrap();

                let full_text = format!("{PROSE} FULL marker so this note lands the full tier.");
                std::fs::write(root.join("raw/already-ingested.md"), &full_text).unwrap();
                std::fs::write(root.join("raw/fresh.md"), &full_text).unwrap();
                for name in ["raw/already-ingested.md", "raw/fresh.md"] {
                    set_mtime(&root.join(name), old_mtime());
                }
                // The "already represented" signal `run`'s own archive pass
                // checks (`source_page` above) — present here even though, at
                // Conservative, nothing ever moved the raw file to match it.
                std::fs::write(
                    root.join("wiki/source-already-ingested.md"),
                    "a source summary page",
                )
                .unwrap();

                let mut o = tiny_ontology();
                o.model = String::new();
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

                let items = full_tier_items(root);
                assert_eq!(
                    items,
                    vec!["raw/fresh.md"],
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
            .is_some_and(|s| s.vector == vec![1.0, 0.0]));

        // Path confinement is the same one proposal payloads get.
        assert!(extend_quarantine(root, &["wiki/index.md".to_string()], 7).is_err());
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
            "---\ntitle: \"Map: topic-a\"\ntype: map\ncluster: topic-a\ncreated: 2026-01-01\nconfidence: medium\nstatus: draft\n---\n\nbody\n",
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
            hash: 0,
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

        let anchors = map_anchors_from_store(root, &store);
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
            .unwrap();
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
                .unwrap();
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
