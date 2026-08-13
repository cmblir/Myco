# Ontology-Gated Distillation — Design Spec

Raw data accumulates without bound (sessions ~1000/day on the real vault); the
MCP/auto-collect flow only ever adds. This feature gives the vault a
metabolism: an ontology-aware gate at the door, periodic distillation of what
got in, and a lifecycle that retires what has been absorbed — with the user
tuning how aggressive all of it is.

Inspired by the Yarchi/DataChaz "AI second brain" pattern (interview-driven
CLAUDE.md personalisation, Inputs/Process/Outputs/Feedback workflow), adapted
to myco's existing raw/wiki architecture.

## Principles (bind every task)

- **The vault is the only source of truth.** `.myco/ontology.json` and every
  other artifact is a recomputable cache, invalidated by embedding-model id.
- **Raw content is never edited or silently deleted.** "Cleanup" = state
  transition (move to `raw/archive/YYYY-MM/`) recorded in an undo manifest.
  Deletion happens only via quarantine-TTL expiry (per intensity) or explicit
  user approval.
- **Citation/link resolution must be recursive across `raw/**`** including
  `archive/` — verify before shipping any move code; `[^src-*]`, PDF pinpoint
  links, lint and trust_report must survive archiving.
- **Every automated decision is explainable in one sentence** shown to the
  user ("nearest topic 'quantization' similarity 0.31 < admission p25 0.45,
  1 known entity → quarantine").
- **MCP server stays no-LLM** (stdlib only): detection, counts, proposals,
  profile writing. LLM steps (wiki integration, maps drafting) run in the app.
- **Heavy work runs at idle** (app open, user inactive ≥10 min), never at
  launch; pauses on user input. Items modified <24h ago are untouchable
  (maturation gate: avoids concurrent-edit races and half-formed thoughts).
- **Self-reinforcement guard**: sessions contain agent output. Session-derived
  facts get low `confidence`; maps draw only on pages passing maturity
  signals (citation coverage, stability period, no open contradictions);
  wiki-citing-wiki must carry the original raw citations through.
- **Measured, not guessed**: admission thresholds are calibrated percentiles
  of the actual vault's similarity distributions, measured during
  implementation — the p25/p5 values below are starting hypotheses.

## Vault schema additions

```
vault/
├── raw/archive/YYYY-MM/     retired sources (moved, never edited)
├── sessions/                existing; distilled → monthly archive
├── wiki/maps/               3rd-stage distillation: topic maps (MOCs),
│                            frontmatter type: map
├── work/feedback/           proposal inbox. type: distill-proposal,
│                            status: pending|approved|dismissed
│                            (processed proposals auto-archived by the engine)
├── _inbox/quarantine/       gate-quarantined items + verdict sidecar
├── daily/                   receives session daily-digest lines and
│                            "summary-only" one-liners
├── profile.md               interview output: role, goals, interests, style.
│                            Header notes it is sent to configured providers;
│                            injection can be toggled off.
└── .myco/
    ├── distill.json         per-vault settings (shared by app + MCP)
    └── ontology.json        derived cache (see below)
```

Knowledge layer never moves files between maturity stages; maturity appears
as NEW synthesis pages (maps). Only the work/quarantine/archive flows move
files. Wikilinks are stem-resolved, so moves are link-safe.

## The ontology (3-layer derived cache)

1. **Topic layer** — Louvain communities over the wiki graph (existing) with
   per-cluster: label, embedding centroid, member count, member-similarity
   stats (mean, std, p5, p25), last-touched date, override counter.
   Once a cluster has an approved map, the map's embedding replaces the
   statistical centroid (human-approved summary > mean).
2. **Entity layer** — wiki page titles + aliases (lexical dictionary).
3. **Identity layer** — profile.md interest vectors; acts as the provisional
   ontology below the cold-start threshold.

Health metrics per snapshot: coverage (% wiki pages within p95 of a cluster),
drift vs previous snapshot. Silhouette degradation → split proposal; centroids
too close → merge proposal (both no-LLM, both proposal-only).

## Admission gate (decision tree, not a blended score)

Signals: `S_knn` (max cosine vs top-8 wiki pages), `S_entity` (count of known
entities mentioned), `S_profile` (max cosine vs profile interests).
Thresholds are per-cluster percentiles of that cluster's own member
similarities — dense and sparse topics each get a fair door.

```
S_entity ≥ 2                    → at least SUMMARY tier; FULL if S_knn passes
S_knn ≥ T_full   (~p25)         → FULL INGEST (existing pipeline)
S_knn ≥ T_summary or S_profile  → SUMMARY ONLY (one line in daily/, no wiki)
S_knn ≥ T_quar   (~p5)          → QUARANTINE (TTL 30d, verdict sidecar)
else                            → REJECT (TTL ledger)
```

- Presets 엄격/보통/느슨 shift the percentiles; default 보통.
- Gate OFF until the vault has ≥50 wiki pages (or first map); profile.md
  serves as ontology until then.
- Emerging-cluster detection: ≥5 quarantined items with pairwise similarity
  above threshold → "new topic ○○ forming — admit?" proposal.
- Self-tuning: per-cluster override counter; >20% user overrides widens that
  cluster's radius locally.
- Explicit user action beats the gate: a manually dragged source warns
  ("distant from current knowledge base — add as new topic?") instead of
  blocking. The gate hard-filters only automatic inflow (sessions, _inbox,
  MCP add_raw_source).
- Partial admission (v2): borderline docs get only in-ontology facts
  extracted.
- Dormancy decay (v2, default-OFF toggle), cross-vault routing (v2).

## Automation loop

**Event path (cheap, immediate):** watcher sees a new item → embed (~130ms
local) → gate verdict → pending queue + badge update. Nothing else.

**Idle batch (the distill run):** app open + idle ≥10 min + (backlog ≥50 or
weekly schedule due — OR condition). Implemented as new Schedules types
(reuse the existing scheduler; no parallel cron infra):

1. Recompute ontology cache if wiki changed.
2. Process queue oldest-first within run budget (default: 1 session
   daily-digest LLM call + 50 raw items per run). Sessions are NEVER
   distilled per-item: one batched daily-digest call extracts
   decisions/facts into daily/, wiki updates only where a fact touches an
   existing concept.
3. Execute tiers (full → existing ingest; summary → daily/ line;
   quarantine → move + sidecar; reject → TTL ledger).
4. Emerging-cluster check → proposals.
5. Detection pass (map candidates, contradictions, orphans; profile
   interests weight priority) → proposals in work/feedback/.
6. Execute approved proposals (LLM steps queue if no provider connected —
   default builtin-local install still gets the full no-LLM core).
7. Archive distilled sources: move to raw/archive/ AND drop from the active
   embedding index. Archived items live in a cold tier, searched only on
   explicit "include archive". **Goal: active index size stays O(wiki), not
   O(history)** — this is the real cleanup payoff (Ask speed + precision).
8. TTL sweep: expired quarantine items that never clustered — auto-delete at
   표준/적극, propose-only at 보수.
9. Write run report to ingest-reports/distill-<ts>.md containing a complete
   undo manifest (every move path, every created page). An "undo this run"
   button reverses it mechanically. Git commit per run when the vault is a
   repo.
10. Badge shows backlog TREND (shrinking/growing), never the raw count.

## Intensity (auto vs approval boundary)

| | 보수 | 표준 (default) | 적극 |
|---|---|---|---|
| classify/detect | auto | auto | auto |
| source-* pages, archive moves | propose | auto | auto |
| concept-page edits, maps, merges | propose | propose | auto (drafts) |
| quarantine-TTL deletion | propose | auto | auto (+ immediate reject-delete) |

One preset slider + advanced overrides (graph-settings Advanced pattern).
The engine may auto-CREATE pages it owns (source-*, map drafts flagged as
drafts) but never auto-EDITS existing non-engine pages beyond proposals.

## Settings (설정 → 증류 tab; stored in .myco/distill.json)

auto-distill ON; count trigger 50; weekly schedule; intensity 표준; gate
preset 보통; quarantine TTL 30d; run budget 50 items + 1 digest call; idle
threshold 10 min; maturation 24h; dormancy decay OFF; profile injection ON;
model = ingest model (spend counts toward the existing monthly budget).
Phase A's Settings tab exposes a control for every field above except
dormancy decay: that field persists (default OFF) but has no UI control
yet, since its actual decay behaviour is v2 (see Phases below) — a toggle
for a behaviour that doesn't exist yet would mislead, not help.

## Surfacing (why reflect reports died: nothing surfaced)

- Sidebar "피드백" item with pending-count badge (Study due-badge pattern).
- Overview card: backlog trend · pending proposals · last run · [지금 증류].
- Proposal view renders work/feedback/ files with [승인]/[무시] wired to the
  existing agent write-confirm flow.

## MCP additions (no-LLM)

- `distill_status` — backlog counts, pending proposals, last run; other tools
  append a one-line hint when triggers are exceeded.
- `distill_report` — run the detection pass, write proposals. **Deviation
  (Phase A):** ships read-only (counts + listing only, no writes) — the MCP
  server stays stdlib-only per this doc's own binding principle above, and a
  second clustering/proposal-writing implementation in Python would drift
  from the Rust engine's; write-back is deferred.
- `setup_profile` — returns the interview question set; accepts collected
  answers; writes/updates profile.md. (App-side entry: Ask preset
  "프로필 설정/갱신". Onboarding wizard step is v2.)

## Personalisation injection

- Ask/Agent: profile.md + relevant maps at the top of system context;
  maps-first retrieval, drill down into member pages (token budget win).
- Ingest: profile interests weight linking/tagging.
- Retrieval changes must re-run the existing measurement harness; the
  measured floors (relevance 0.50, intent 0.65) and wiki-slot share must not
  regress.

## Acceptance metrics

1. Active-index item count converges (stays O(wiki)) on a synthetic
   1000-sessions/day vault.
2. Backlog trend reaches 0 within budget on the same vault.
3. Weekly distill LLM spend ≤ configured budget; sessions cost exactly
   1 call/day.
4. No retrieval regression (harness above).
5. Every archive move survives lint_citations / trust_report / PDF pinpoint
   resolution.
6. Undo of a full run restores the exact prior file layout.

## Phases

- **Phase A (no-LLM core, works on a default install):** lifecycle engine,
  gate + quarantine + TTL, archive + cold index tier, run reports + undo,
  Schedules integration, settings tab, sidebar/Overview surfacing,
  MCP distill_status/distill_report, calibration measurements.
- **Phase B (LLM layer):** session daily-digest, full-ingest tier execution,
  maps drafting via agent confirm flow, setup_profile + Ask entry point,
  profile/maps injection into Ask/Agent + ingest weighting.
- **v2 parking lot:** partial admission (extraction), dormancy decay,
  cross-vault routing, onboarding wizard interview step, typed relations,
  work/inbox|doing|done, frontmatter maturity writeback.
