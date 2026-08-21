# 2026 Q4 — Trust, Recall, Resurface (quarterly roadmap design)

Status: approved by owner 2026-08-21 (overall shape, plus the three decision
points recorded in "Decisions" below).

## Context

myco's P0–P1 backlog is exhausted: import pipeline, retrieval stack, the 7-feature
wave, and the distill metabolism (daily → weekly → monthly, v0.4.0) have all
shipped. The owner set this quarter's success criteria explicitly:

- **(a) Own daily-use quality** — recall and distillation feel noticeably better in
  everyday use.
- **(b) Completeness / trustworthiness** — a state the owner can confidently
  recommend to a stranger.

Explicitly *not* the metric this quarter: subscribers, downloads, stars.

Owner-named daily frictions: **recall** (Ask/search quality), **resurface** (the app
never brings sleeping knowledge back), **trust** (hard to see, verify, and undo what
auto-edits did; hard to find wrongly-cooked pages).

The plan below was produced from a 2026-08 competitive research pass (three
reports: PKM feature landscape, open-core monetization, always-on/memory market)
followed by a four-lens design exercise (daily-driver, strategist, lazy-engineer,
trust-auditor), each plan adversarially reviewed against the actual codebase, then
synthesized. Every size estimate below was verified against the repo by at least
one reviewer.

Research findings this plan leans on (evidence in the research digest, not
restated here):

1. The winning agent-write shape is *visible gates*: word-level diff preview, plan
   mode, reversible run log (Claudian: 1.85M downloads in 8 months). Fully
   autonomous vault maintenance is nearly unadopted.
2. Provenance ("did I write this or did the AI?") is the best-articulated
   unanswered complaint in the category; the only shipped answer anywhere is
   Heptabase's "Created by AI" filter.
3. Resurfacing demand is proven with a de-facto public spec (Ask HN 2026-01-30,
   235 pts): local-only, cited evidence snippets, pull-based, ≤2 items/day,
   auditable. Push-shaped attempts died (ChatGPT Pulse).
4. Lexical exact-match search is the commonly under-invested half of retrieval
   (Mem's most common complaint).
5. Anti-goals: push notifications, cloud-required features, uncited synthesis,
   chat-RAG centerpiece. Payment/pricing code stays off-repo (hard rule).

## Decisions (owner-approved)

1. **Git bootstrap is opt-in.** One-click banner in onboarding and Morning Report;
   never silently `git init` a user vault. Consequence: on installs that decline,
   the run log degrades to manifest-level (file lists, no content diffs), and the
   README's durability claims must be worded conditionally.
2. **The new-surface (axis ③) slice is voice quick-capture** (global shortcut →
   record → whisper → `_inbox`), funded from W3–6 slack. Typed pages are deferred.
3. **Contradiction handling stops at structural v1** this quarter (surface
   already-marked disputed/superseded links as a review queue). Semantic
   claim-conflict detection is next quarter; an empty structural queue week after
   week is the signal that semantic detection is needed.
4. Overall shape approved: **Trust (W1–6) → Resurface (W7–10) → Recommendable
   (W11–12)**, with felt daily-use improvements landing inside W1–2.

## Key codebase facts the plan depends on (reviewer-verified)

- The owner's real vault has **no git repository**, and the app never runs
  `git init` anywhere. Without item 1, every diff/authorship/audit feature is a
  demo-vault-only promise. `distill.rs::git_commit_run` already commits *if* a repo
  exists, but does not stage `wiki/`.
- CJK bigram tokenization already exists and is tested (`retrieval.rs:40`,
  `tokenize_cjk_emits_bigrams`) — lexical work item excludes it.
- `undo_distill_run` exists (`commands.rs`) and a last-run undo button already
  ships in `PageSettings.tsx`; only the arbitrary-run surface is missing.
- `PageOverview.tsx` already renders DistillCard / VaultPulse / RecentNotes /
  ReflectPanel — the Morning Report is a rearrangement, not a new page.
- `trust_report` and `lint_citations` exist in `mcp_native.rs` with **zero** app
  surface.
- `importers/secrets_scan.rs` exists and the import path already quarantines;
  redaction work is gap-sealing (MCP servers ×2, clipper promotion, automation),
  not a new scanner.
- `examples/retrieval_eval.rs` (recall@k / MRR / nDCG) exists; the miss log feeds
  its EvalSet format.
- There is no diff renderer anywhere in `app/src` and no diff dependency in
  `package.json` — the word-diff component is ~100 lines of LCS, written in-repo.
- `AgentPanel.tsx` per-call confirm currently shows a 40-char `argSummary()` — tool
  name without content ("consent theater").
- `RunManifest` stores paths only; content diffs come from `git show` (hence
  item 1).

## The quarter

Sizes: S ≤1d, M 2–4d, L 1–2wk. Axes: ① productization ② core intelligence
③ new surfaces ④ stabilization/trust. Budget: 56d ≈ 11.2 weeks against a 60d
window (slack ~4d).

### W1–2 — Foundations + immediately felt wins (9d)

**1. Vault git bootstrap + authorship convention — M 2d · ④ (foundation for ②)**
Opt-in "initialize vault history" in settings/onboarding: `git init` +
`.gitignore` (`.myco/` etc.). Stage `wiki/` in `GIT_COMMIT_PATHS`. Agent commits
get a dedicated `--author`; human edits are committed on save (debounced) with the
user's identity. From this point authorship is separable, forward-only.
*Success:* on the real vault, one distill run + one manual edit produce two
distinct authors in `git log`.

**2. Morning Report rearrangement + suspect-pages row — M 2d · ④②**
Reframe `PageOverview.tsx` as "since you were last here": last-run outcome,
pending proposal count, and a "N suspect pages" row wired to `trust_report` /
`lint_citations`. *Success:* owner opens the app in the morning and reaches the
full picture (overnight changes + suspect pages) in 0–1 clicks.

**3. Run list + arbitrary-run undo — S 1d · ④**
List `.myco/distill-runs/<id>.json` and call `undo_distill_run` per row.
*Success:* revert a past run from the UI; file restoration verified by diff.

**4. Lexical exact-match search — M 2d · ②**
Quoted-phrase = substring filter in the BM25 path plus a fallback scan for
punctuation-heavy strings the tokenizer drops; `path:` / `tag:` operators in
Spotlight/PageQuery. *Success:* 10 exactly-remembered strings (Korean, English,
error strings) all land top-3; quoted search returns exact hits only.

**5. Recall miss log + eval harness injection — M 2d · ②④**
Shortcut on Ask/search results records query + expected page to
`.myco/eval/misses.jsonl`; inject into `retrieval_eval`'s EvalSet and re-run.
*Success:* ≥10 misses collected in two weeks; every retrieval change thereafter is
judged by recall numbers, not anecdote.

### W3–6 — Trust core (16d + voice slice, window 20d)

**6. Unified run log + word-level diff — L 7d · ②④①**
Spine: undo manifests + `ingest-reports/` (works without git); git enriches with
content diffs where available. ActivityPanel/PageHistory drill-in per run: file
list → word-diff → WHY-report link → Undo. Diff renderer: in-repo ~100-line LCS.
*Success:* "what did the agent change yesterday, and why" answered inside the
panel in under 30 seconds; one real run reverted in one click, byte-identical.

**7. Plan-then-execute — M 4d · ②**
(a) AgentPanel per-call confirm renders before/after with the item-6 diff
component; `create_page` shows full text. (b) `ingestPlan.ts`'s
ADD/UPDATE/MERGE/NOOP plan gains per-item checkboxes gating the manual ingest
path (headless `autoIngest.ts` bypasses). *Success:* three agent edits all show a
diff first; a rejected file is untouched; unchecking an ADD prevents that page.

**8. Time-aware Ask — M 5d · ②**
Relative-date parsing ("last week", "in August") → date-range filter +
recency-aware rerank tie-break, reusing session/digest filename date conventions.
Not an `intent.rs` extension (intent runs only on retrieval abstain).
*Success:* "what did I decide about X this week?" cites only that window's
sessions/digests; time-anchored misses disappear from the miss log.

**9. Voice quick-capture (owner-selected ③ slice) — M 3d · ③**
Global shortcut → record → transcribe via the installed whisper CLI
(`whisper.rs`) → land in `_inbox/` for the normal ingest path. Degrades to a
visible "install whisper" message. *Success:* a spoken note reaches the wiki via
the standard pipeline with zero extra clicks at capture time.

### W7–10 — Resurface + safety boundary (19d, window 20d)

**10. Sleeping-note resurfacing engine (context echo) — L 8d · ②③**
Single trigger: embed the day's digest/inflow, find dormant pages
(last-opened > N days, default 30, settings knob) via `vector_index`, emit 1–2 as a new `resurface` proposal
kind through distill's existing `write_proposal` pipeline (kind-enum lifecycle
extension included). Hosted by distill's idle-gated in-app trigger (not
`schedules.rs`, which is the launchd module). Surfaced as ActivityChip proposal
rows: title + why-shown similarity snippet (reusing extractive quotes) +
open/snooze/ignore. New last-opened tracking; local accept/ignore counters.
FSRS-decay page picking is cut (would be a new per-page review subsystem).
*Success:* over two weeks, "forgotten but relevant now" clicks ≥2/week; if the
ignore rate exceeds 80% (counter), raise the similarity floor (one knob).

**11. Daily ritual card ("today's reunions") — M 3d · ②③**
Morning Report ritual section: item-10 picks + existing FSRS due cards
(`cards.ts` due state, no new store), respecting dismiss/snooze history.
Integrates with ReflectPanel so proposal surfaces don't fragment.
*Success:* owner opens a reunion item on half of days; no repeat nagging of the
same note.

**12. "From deep storage" row in Ask results — S 1d · ②**
Post-filter on the same search call: one high-similarity dormant page, labeled.
*Success:* asking about an old topic surfaces a sleeping page with the label.

**13. Redaction boundary sealing — M 3d · ④**
Reuse `secrets_scan.rs`; seal the gaps only: (a) `mcp_native.rs::add_raw_source`
write-then-warn → scan-then-quarantine, (b) same fix in `myco_mcp.py` (there are
two MCP servers), (c) clipper `_inbox` → raw promotion path, (d) port the six
patterns to `automation/autoingest.py`. PII tier (email/phone/RRN) defaults to
warn (quarantine-by-default would kill the owner's own daily imports), with an
opt-in quarantine toggle. *Success:* a fake `sk-` key injected through all four
paths is blocked before landing; `git log -p raw/` shows zero hits.

**14. Retro raw/ audit (read-only) — S 1d · ④**
`scan_raw_audit` command: both tiers over existing `raw/` + git history,
report only. Cleanup procedure is docs-only (`git filter-repo` steps) — the app
never mutates `raw/` (immutability rule). *Success:* owner's real vault audits
clean, or hits resolve via the documented procedure.

**15. Contradiction review queue v1 (structural) — M 3d · ④②**
Surface `mcp_native.rs`'s structural scan (disputed/superseded link judgments) as
an app queue: Morning Report "N contradictions" → two-click Case 1/2/3
Historical/Disputed marking through the existing write path + undo manifest.
Semantic claim-conflict detection is explicitly next quarter.
*Success:* scan findings resolve through the queue and vanish on rescan;
validator passes.

### Cross-cutting (scheduled into W3–10 slack)

**20. Ingest format unification — M 4d · ④② (owner-requested 2026-08-21)**
Manual ingest already handles pdf (native `pdf_extract`, `extract.rs:160`),
docx/pptx/xlsx (native), html/csv/json (passthrough), images (vision, API-key
providers), audio/video (installed whisper). This item closes the verified gaps
only:
(a) `_inbox` auto-ingest sees only `.md` (`vault::list_files` markdown-only
filter) — non-md files sit invisibly forever, the app's one silent failure.
Replace the listing with a real directory read routed through the existing
`sourceTextFor` dispatch; unsupported files surface as a "N unsupported" count
instead of vanishing. (M 2d)
(b) HTML lands as raw markup — add tag-strip/readability text extraction in
`extract.rs` so the model gets prose, not `<div>` soup. (S 1d)
(c) Parity one-liners: add docx/pptx/xlsb to the daemon's `EXTRACT_EXTS`
(`automation/autoingest.py:47`), add xlsm/xlsb to the browse picker
(`ipc.ts:607-637`); wire the existing-but-unwired `whisper_check` preflight into
the ingest UI (rides with item 9). (S 1d)
*Success:* a pdf, an html file, and a png dropped into `_inbox/` all either
ingest through the normal pipeline or appear in a visible unsupported count —
nothing silent; daemon ingests a docx without manual steps.

### W11–12 — Recommendable + slack (9d, window 10d)

**16. Authorship badge (forward-only) — M 3d · ②①**
On the item-1 author convention: blame aggregation → page-header badge
("% agent / % human" + last human touch) + a sidebar "human-authored" filter.
`git_log.rs` gains author/blame (currently hash/date/subject only). Applies to
history accumulated since W1; explicitly forward-only — no retroactive claims
(a retroactive badge would be 100% wrong, destroying the trust it exists to
build). *Success:* badges on 5 sample pages edited since W1 match memory; the
filter returns only purely-manual pages.

**17. First-run 60 seconds: folder → cited answer — M 3d · ①③**
Rearrange `OnboardingWizard.tsx`: pick a folder (empty → `sample_vault` demo
fallback) → incremental `autoReindex` with progress → final step *is* Ask with a
prefilled suggested question → first cited answer. *Success:* stopwatch-measured
under 60 seconds from folder pick to first cited answer on a fresh install, zero
settings visits.

**18. README repositioning + roadmap refresh — S 1d · ①④**
Lead paragraph becomes durability (MIT + plain markdown + git + immutable
`raw/` + no server, worded per decision 1), NotebookLM five-weakness comparison,
FSRS-scheduler differentiation, screenshots of the new trust surfaces (items
6/16). Refresh stale `docs/roadmap.md`. Pricing/payment stays off-repo.
*Success:* a stranger can answer "how is this different from Obsidian+Claudian"
from one paragraph + two screenshots.

**19. Debt sweep — S 2d · ④**
Atomize the digest fingerprint↔rename TOCTOU + one regression test; one headed
visual verification session for the minimap + 2026-07 galaxy work (needs the
owner's eyes — schedule on owner time); document legacy caveat-title/bare-stem
items as wontfix. *Success:* every parked-debt item either resolved or settled by
documentation.

## Explicitly not this quarter

- **Mobile** — exceeds a solo-dev quarter on its own; the durable-format story
  buys time.
- **Voice/meeting full surface** — new capture subsystem; only the thin slice
  (item 9) ships.
- **Typed pages (supertags/Bases)** — serves acquisition, touches none of the
  three frictions; revisit next quarter.
- **Semantic contradiction detection** — new machinery in the highest-risk module
  (`distill.rs`); structural v1 first (decision 3).
- **FSRS-decay page resurfacing** — new per-page review subsystem; evidence
  supports the context-echo trigger only.
- **Open-web source discovery** — recall starts with the owner's own vault.
- **Multimodal output (video/slides)** — friction-irrelevant, large surface.
- **Push-notification resurfacing** — anti-goal; Pulse died of it.
- **Pricing ladder / payments** — off-repo hard rule; the public repo carries
  README positioning only.
- **Chat-RAG centerpiece** — anti-goal.
- **epub / rtf / legacy .doc / odt parsers** — no path supports them today; new
  parser dependencies, deferred until demand shows.
- **Scanned-PDF OCR** — `extract.rs` hard-errors on image-only PDFs by design;
  OCR is a new engine dependency.
- **Vision fallback for CLI providers** — image ingest requires an API-key
  provider (`providers.rs:1360`); a local vision model is a separate bet.

## Budget

| Window | Items | Est. | Window size |
|---|---|---|---|
| W1–2 | 1(2d) 2(2d) 3(1d) 4(2d) 5(2d) | 9d | 10d |
| W3–6 | 6(7d) 7(4d) 8(5d) 9(3d) | 19d | 20d |
| W7–10 | 10(8d) 11(3d) 12(1d) 13(3d) 14(1d) 15(3d) | 19d | 20d |
| W11–12 | 16(3d) 17(3d) 18(1d) 19(2d) | 9d | 10d |
| W3–10 slack | 20(4d) — ingest format unification | 4d | — |
| **Total** | | **60d ≈ 12wk** | 60d |

Item 20 (owner-requested 2026-08-21) consumes the slack. Schedule risk is
absorbed by item 20's own scope ladder: (c) parity one-liners ship first, then
(b) HTML strip, then (a) inbox unification — if item 6's diff rendering overruns
(the largest L, flagged by all four reviews), (a) slips to next quarter before
anything else does.

Axis distribution: ② ≈ 26d, ④ ≈ 17d (the two success-criteria axes carry the
weight), ③ ≈ 8d rider, ① ≈ 5d rider.

## Verification cadence

- Per item: its success check, plus the standard gates
  (`npm run lint && npx tsc -b && npx vitest run`; `cargo fmt --check && cargo
  clippy --all-targets -- -D warnings && cargo test`).
- Any distill change: `cargo test --test distill_acceptance -- --ignored`.
- Any retrieval change: `MYCO_EMBED_SPEC=bge-m3 cargo run --example
  retrieval_eval --release` against `eval/BASELINE.md`, now including the item-5
  miss set.
- Quarter-end judgment maps to the owner's criteria: (a) miss-log recall numbers
  improved + resurface click-through sustained; (b) items 13/14/15/17/18 done =
  recommendable.
