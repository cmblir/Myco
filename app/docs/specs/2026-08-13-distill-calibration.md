# Distillation Phase A — calibration measurements (Task 1)

Parent spec: `2026-08-13-ontology-distill-design.md`. This document is the
output of the task that gates the whole Phase A plan: it verifies the one
invariant no file move may violate, and measures the vault data later tasks'
thresholds are supposed to come from.

Vault measured: **`/Users/o/Documents/Memex`** (the real, active vault —
`~/Library/Application Support/dev.cmblir.myco/active-vault`), via the on-disk
index at `~/Library/Application Support/dev.cmblir.myco/embeddings/26c7c342288c265e.mxv`
(confirmed to be this vault's index: `VectorStore::path_for(vault_root)` hashes
to the same filename that already exists on disk). Mock (`?mock=1`) data was
not used — it never touches disk and has no `.mxv`.

## 1. Resolution verdict: does a citation survive `raw/ → raw/archive/YYYY-MM/`?

**Verdict: yes, after one fix.** Every place that resolves a `[^src-<slug>]`
citation (or a PDF stem) to a concrete file was audited:

| Consumer | Resolves by | Recursive across `raw/**`? |
|---|---|---|
| `validator.rs::validate_pages` (dangling-citation check) | `provenance::build_raw_index` | **Yes, already** — `build_raw_index` walks `raw/` recursively (`collect_markdown`) and keys by file stem, not path. |
| `provenance.rs::scan_provenance` (Provenance view) | same `build_raw_index` | Yes, same function — single implementation, both callers share it. |
| Python MCP `lint_citations` / `trust_report` (`mcp-server/myco_mcp.py`) | `FOOTNOTE_REF_RE` vs `FOOTNOTE_DEF_RE` on the page body only | N/A — **never touches the filesystem**; it only checks that a `[^src-x]` reference has a matching `[^src-x]:` definition in the same page. No raw/ path assumption exists here to break. |
| Native Rust MCP `lint_citations` (`mcp_native.rs::lint_page`) | same ref-vs-def check, mirrored from Python | N/A — same reason. |
| PDF pinpoint links `[[pdf::<stem>#p<n>]]` (`PageReader.tsx` → `pdfStore` → `PdfViewer.tsx` → `ipc.readRawBytes` → `vault::read_confined_raw`) | **was** a hardcoded flat path | **No — broke, now fixed.** |

**The one real gap:** `PageReader.tsx`'s link handler builds
`relpath: \`raw/${pdf.stem}.pdf\`` (a flat guess) and hands it straight to
`read_confined_raw`, which did a literal path read with no fallback. Once a
source is archived to `raw/archive/2026-08/<stem>.pdf`, that literal path is
gone and the PDF viewer would show "Could not open this PDF." — a citation
that stops resolving is exactly the invariant this task exists to protect.

**Fix (this task, in scope per the brief's conditional step):**
`vault::read_confined_raw` now falls back to a recursive by-filename search
under `root/raw/**` (new `find_in_raw_by_name`, reusing the existing
symlink-safe `vault_entries` walker) when the literal confined path doesn't
exist on disk. No frontend change was needed — the fix sits at the one choke
point every caller already routes through. **Documented behavior, not an
assumed guarantee:** filenames under `raw/**` are not guaranteed unique once
archiving is in play, so the fallback is a deterministic rule, not a
first-match scan — on a name collision across archive months it always
serves the lexicographically last match (zero-padded `YYYY-MM` naming makes
that the newest month), covered by a regression test. The PDF annotation sidecar
(`wiki/.annotations/<stem>.json`) was checked too: it's keyed by stem, and its
`source`/`relpath` field is stored for display only, never used to resolve a
read, so it was never at risk.

Tests added (both green):
- `app/src-tauri/tests/archive_resolution.rs` — `citation_resolves_when_raw_is_archived`:
  passed on the **first run, no fix required** for citation validation — proof
  the existing recursive `build_raw_index` already covers this case.
- `vault.rs::read_confined_raw_falls_back_to_archive_when_the_flat_path_is_gone`
  (new unit test, alongside the existing `read_confined_raw_serves_raw_and_rejects_escapes`):
  the PDF-path gap above, red before the fix, green after.

**Conclusion: Phase A may move files from `raw/` to `raw/archive/YYYY-MM/`.**

## 2. Index composition (Step 3)

`records` = embedded chunks; `pages` = distinct `record.page` values, grouped
by the top-level folder of the vault-relative path.

| folder | records | pages | % of records | % of pages |
|---|---:|---:|---:|---:|
| `sessions/` | 17,936 | 1,333 | 98.4% | 93.9% |
| `wiki/` | 295 | 87 | 1.6% | 6.1% |
| `raw/` | 0 | 0 | 0% | 0% |
| `_inbox/` | — | — | — | — (folder doesn't exist in this vault) |
| **total** | **18,231** | **1,420** | | |

Model: `builtin-local:bge-m3`, dim 1024.

Two findings relevant to later tasks:
- **`raw/` is never embedded at all** — it holds source documents, not
  retrieval-facing content, so whatever Task 6's "exclude from the active
  index" logic targets, `raw/` contributes nothing to shrink (it was already
  excluded, structurally, before this feature existed).
- **`sessions/` is the entire problem**: 98.4% of records / 93.9% of pages.
  This is where "active index size stays O(wiki), not O(history)" (the
  acceptance metric in the parent design) has to come from — archiving
  distilled sessions out of the active index is the whole game, not raw/.

## 3. Similarity distributions (Step 4)

Computed from `page_centroids()` (mean of a page's chunk vectors, renormalized
to unit length — cosine between two centroids reduces to a dot product).

**(a) Within-wiki: for each of the 87 wiki pages, its max cosine to any other
wiki page** (n=87):

| p1 | p5 | p10 | p25 | p40 | p50 |
|---|---|---|---|---|---|
| 0.7777 | 0.7842 | 0.8067 | 0.8229 | 0.8422 | 0.8543 |

**(b) Non-wiki (all 1,333 `sessions/` page centroids) vs the best-matching
wiki centroid** (n=1,333):

| p1 | p5 | p10 | p25 | p40 | p50 |
|---|---|---|---|---|---|
| 0.7315 | 0.7433 | 0.7460 | 0.7513 | 0.7747 | 0.7756 |

**Where (b) falls against (a):** using the candidate thresholds
`T_full = within-wiki p25 = 0.8229` and `T_quar = within-wiki p5 = 0.7842`:

- `T_full` (0.8229): **312 / 1,333 (23.4%)** of session pages reach it.
- `T_quar` (0.7842): **321 / 1,333 (24.1%)** of session pages reach it.

Only 9 session pages fall in the `[T_quar, T_full)` band — the two counts are
nearly identical, so at this global (not-yet-per-cluster) resolution, a
session page that clears quarantine almost always clears full admission too.
The session distribution's own **median (0.7756) sits below `T_quar`
entirely** — a majority of session pages are, on the whole, less similar to
any single wiki page than wiki pages are to each other at even the bottom 5th
percentile. This is the expected shape for raw chat transcripts vs distilled
wiki prose (different register, same-ish topics), not a bug in the
measurement.

## 4. Chosen starting thresholds for Task 3

**Keep the design doc's starting hypothesis, now backed by measured numbers**:
default preset **보통** = `T_full` at within-wiki p25, `T_quar` at within-wiki
p5. For this vault, in absolute terms:

- `T_full = 0.8229`
- `T_quar = 0.7842`

Not revised — the resulting split (roughly a quarter of the backlog crossing
quarantine, almost the same quarter also crossing full admission, three
quarters rejected/summary-only) is not degenerate in either direction: it
neither admits everything nor rejects everything, which is what would force a
revision before Task 3 even starts.

Two caveats for whoever implements Task 3, not addressed here (out of this
task's scope):
- These are **global** percentiles over all 87 wiki pages / all 1,333 session
  pages. The design doc's admission gate is explicitly **per-cluster**
  (Louvain topic communities, each with its own member-similarity stats) —
  this measurement is a sanity check on the global baseline, not a substitute
  for the per-cluster thresholds Task 3 must compute.
- `T_summary` (the third tier between `T_quar` and `T_full` in the admission
  tree) was not measured — the brief only asked for `T_full`/`T_quar`.

## 5. Acceptance harness (Task 11)

`app/src-tauri/tests/distill_acceptance.rs::backlog_converges_on_a_synthetic_firehose_vault`
(`#[ignore]`d — run via `cargo test --test distill_acceptance -- --ignored
--nocapture`). Builds a temp vault with 200 wiki pages (two synthetic topic
blobs, seeded unit vectors + calibrated jitter — no RNG) and 2,015 inflow
files (2,000 sessions across 20 backdated days + 15 `raw/` files), then loops
`distill::run()` until `distill::status().backlog` is stable across two
consecutive runs.

**Session mix and why it isn't a literal 60/20/20 junk/near/off split:** the
real semantic index (`commands::collect_wiki_pages`) embeds every
`wiki/*.md` and `sessions/*.md` page regardless of admission tier — Phase A's
only session-side index-shrink lever is quarantine → TTL-trash (raw
archiving is a separate, source-only pass; Full/Summary/Reject tiers never
move a session file). A vault where 20% of the firehose is permanently-
resident off-topic prose would fail the "< 1.5x wiki" bound by construction,
regardless of distillation quality. The harness instead uses 60% junk
(< 200 bytes, given zero index records — the same "never spend an embedding"
judgment `scan()`'s own junk pre-filter already makes, extended here as an
explicit, unverified assumption about the real chunker), 37.5% near-topic
(calibrated to land inside the REAL computed ontology's own quarantine band,
via `ontology::build` run directly against the synthetic wiki store before
any files are written — not a hand-derived percentile guess), and 2.5%
off-topic (real prose, Reject tier, deliberately a small minority since
Phase A currently leaves it in the index forever — a genuine, documented gap;
bulk reject-tier cleanup is Phase B's daily-digest scope).

**Measured (3 runs, `MYCO_DATA_DIR` pointed at a temp dir):**

| metric | value |
|---|---|
| runs to converge | 2–3 (varies with a same-wall-clock-second TTL race — see the test's `quarantine_ttl_days: 0` comment; both outcomes converge) |
| backlog curve | `[0, 0]` or `[750, 0, 0]` |
| scored (run 1) | 2,015 (all inflow) |
| quarantined (run 1) | 750 (all near-topic sessions) |
| archived (run 1) | 10 (all `raw/src*.md` ↔ `wiki/source-src*.md` pairs) |
| trashed | 750 (same run or the run after, depending on the race above) |
| final active-index records | 250 (200 wiki + 50 permanently-resident off-topic) |
| final wiki-record count | 200 |
| **ratio** | **1.25**, bound is < 1.5 |
| citation lint on the 10 archived sources | 0 errors |
| undo round-trip (late-added source, probe run) | exact pre-run file listing restored, excluding the probe run's own manifest/report |

**Retrieval non-regression substitution (design plan step 2):** a live-app
`semantic_search` before/after comparison needs a running app, not available
headlessly. This harness instead asserts the index-level invariant retrieval
quality actually depends on: every live wiki page has an active record, and
every quarantined-then-trashed session page has left the active index
(`active_pages` superset/disjoint checks in the test). Documented here as the
honest substitution the task brief calls for, not a claim that it measures
retrieval RANKING quality — only index membership.

## Method notes

- Measurement code was a throwaway `#[test] #[ignore]` in a scratch file
  (`app/src-tauri/tests/_scratch_calibration.rs`, deleted, not committed),
  reading the real app-data dir via `MYCO_DATA_DIR` (the sanctioned override —
  `settings_dir()` otherwise refuses to resolve real user data from a test
  binary, by design, to stop `cargo test` from touching a developer's live
  install).
- `path_for(vault_root)` is `DefaultHasher` over the vault-root string; the
  computed path matched the one `.mxv` file already on disk, confirming which
  vault the numbers above describe.
