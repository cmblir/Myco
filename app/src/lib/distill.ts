// TS mirror types for distillation config. Fields match the Rust serde output
// (snake_case from the #[serde(rename_all)] directives).

import { ipc } from "./ipc";
import { getActiveModel } from "./chat";
import type { Lang } from "./i18n";
import { runSessionDigest } from "./sessionDigest";
import type { DigestOutcome } from "./sessionDigest";
import { runFullTierIngest } from "./fullTierIngest";
import type { FullTierOutcome } from "./fullTierIngest";
import { draftMap } from "./maps";
import {
  feedbackFileNodes,
  parseProposal,
  rewriteStatus,
  toRelative,
} from "../stores/distillStore";
import { useVaultStore } from "../stores/vaultStore";
import { useReindexStore } from "../stores/reindexStore";
import { useDistillRunStore } from "../stores/distillRunStore";

export type Intensity = "conservative" | "standard" | "aggressive";
export type GatePreset = "strict" | "normal" | "loose";

export interface DistillConfig {
  enabled: boolean;
  count_trigger: number;
  intensity: Intensity;
  gate_preset: GatePreset;
  quarantine_ttl_days: number;
  run_budget_items: number;
  idle_minutes: number;
  maturation_hours: number;
  dormancy_decay: boolean;
  // Phase B (LLM layer) groundwork.
  llm_digest_days: number;
  llm_ingest_budget: number;
  profile_injection: boolean;
}

// scan()'s return summary — folded into RunReport below (Task 4/6, Phase A;
// the standalone build_ontology/distill_scan commands were dead code, never
// called outside run(), and were removed).
export interface ScanOutcome {
  scored: number;
  quarantined: number;
  rejected: number;
  summaries: number;
  full: number;
  skipped_immature: number;
  // Defect D fix — set when scan() no-op'd because the cold-start gate is
  // off: the wiki page count that fell short of GATE_MIN_WIKI_PAGES.
  gate_wiki_pages: number | null;
}

// Task 6 — distill_run's return summary.
export interface RunReport {
  id: string;
  scan: ScanOutcome;
  archived: number;
  trashed: number;
  proposals: number;
  backlog_after: number;
}

// Task 6 — distill_status's return summary.
export interface DistillStatus {
  backlog: number;
  pending_proposals: number;
  last_run: number | null;
  last_backlogs: number[];
  // Critical 1 fix — false below the cold-start threshold (50 wiki pages):
  // scan() is a no-op on every candidate while this is false.
  gate_active: boolean;
  // Important 3 fix — the most recently started run's id (undoDistillRun's
  // `id` argument), or null if no run has happened yet.
  last_run_id: string | null;
  // Defect D fix — wiki page count gate_active was computed from, so the UI
  // can show "N/50" instead of a bare on/off flag.
  wiki_pages: number;
  // Defect G fix — _inbox/quarantine/ items awaiting human review.
  quarantined: number;
}

// Mirrors distill.rs's GATE_MIN_WIKI_PAGES (Defect D) — the cold-start gate
// threshold DistillStatus.wiki_pages/gate_active are compared against.
export const GATE_MIN_WIKI_PAGES = 50;

// Defect G fix — where quarantined items actually live, for the UI message.
export const QUARANTINE_DIR = "_inbox/quarantine";

// Phase B, Task 1 — digestableSessionDays's return: one day's worth of
// sessions/ files ready for the LLM digest step.
export interface DigestDay {
  day: string; // YYYY-MM-DD
  files: string[]; // vault-relative rel paths
  // Defect C fix — every file here is already named by a daily/*.md digest
  // marker, so its digest text is durable and only the archive move failed:
  // runSessionDigest must skip the LLM call and retry only the archive step.
  already_digested: boolean;
}

// Task 8 — direction of `last_backlogs` (oldest → newest, per Rust's
// push+drain in distill.rs) for the Settings distill tab's status line.
// Compares the oldest and newest samples rather than fitting a slope: the
// window is short (last 10 runs) and callers only need a coarse signal.
export function backlogTrend(last: number[]): "shrinking" | "growing" | "flat" {
  if (last.length < 2) return "flat";
  const oldest = last[0];
  const newest = last[last.length - 1];
  if (newest < oldest) return "shrinking";
  if (newest > oldest) return "growing";
  return "flat";
}

// Task 9 — Overview card's "last run" label. Auto-unit (seconds/minutes/
// hours/days), unlike RecentNotes.tsx's day-only `relativeDay`: a distill run
// can fire several times an hour (idle trigger, manual button), so day
// granularity would flatten them all to "today".
//
// Settings audit item 6: `lang` (the app's own UI language, not the OS
// locale) drives the Intl locale — `undefined` let the OS locale leak
// through, producing e.g. "마지막 실행 366 days ago" on a ko UI. myco's Lang
// values ("en"/"ko"/"ja") are themselves valid BCP47 tags, so no separate
// mapping table is needed.
export function lastRunLabel(
  lastRun: number | null,
  lang: Lang,
  nowMs: number = Date.now(),
): string | null {
  if (lastRun === null) return null;
  const diffSec = Math.round(nowMs / 1000 - lastRun);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  const abs = Math.abs(diffSec);
  if (abs < 60) return rtf.format(-diffSec, "second");
  if (abs < 3600) return rtf.format(-Math.round(diffSec / 60), "minute");
  if (abs < 86_400) return rtf.format(-Math.round(diffSec / 3600), "hour");
  return rtf.format(-Math.round(diffSec / 86_400), "day");
}

// Task 8 fix (code review): three independent callers can decide to run
// distill_run around the same moment — a due "distill" schedule, the
// idle-gated backlog count trigger (scheduleTimer.ts), and the manual
// "Distill now" button (PageSettings.tsx). A run can outlive the timer's
// 5-min poll, so without a shared guard two runs could interleave file
// moves. One per-vault in-flight set, consulted and set by all three.
const inFlight = new Set<string>();

// Phase B, Task 2 — the session daily-digest's outcome, keyed by vault path.
// runDistillGuarded fires it after every successful distill_run, but RunReport
// itself gains no new field for it (callers destructure a stable shape); the
// Overview note (Task 6) instead reads this module-level map for the latest
// run. Smallest option that works — no store, no event bus.
export const lastDigestOutcome = new Map<string, DigestOutcome>();

// Phase B, Task 3 — full-tier ingest's outcome, keyed by vault path. Same
// "module-level map, no store, no event bus" idiom as lastDigestOutcome
// right above (RunReport itself gains no new field for it either).
export const lastFullTierOutcome = new Map<string, FullTierOutcome>();

// Phase B, Task 4 (final-review Important 3) — draft-map auto-apply's
// outcome, same idiom as the two maps above; the Overview card's "LLM steps
// waiting" note reads all three.
export interface MapDraftOutcome {
  drafted: number;
  skipped: "no-provider" | null;
}
export const lastMapDraftOutcome = new Map<string, MapDraftOutcome>();

// Fallback llm_ingest_budget when getDistillConfig is unavailable — mirrors
// the Rust-side default, same idiom as fullTierIngest.ts's own copy.
const DEFAULT_INGEST_BUDGET = 3;

/** Phase B, Task 4 — the Aggressive-intensity bridge: at that intensity,
 * `distill_run` writes `draft-map` proposals straight to `status: approved`
 * (the LLM draft itself always runs TS-side, never in Rust), so this applies
 * every one still sitting in that state after the run, the same way a user
 * clicking "approve" in PageFeedback would (`distillStore.apply`'s own
 * draft-map branch). Uses `vaultPath` directly via `ipc`, never the
 * `useVaultStore`/`useDistillStore` singletons — `runDistillGuarded` can run
 * for a vault the UI isn't even showing, and those stores are bound to
 * "whichever vault is currently open" (same reason `runSessionDigest`/
 * `runFullTierIngest` take an explicit vault path too). Per-proposal
 * failures are logged and skipped, not thrown: one bad cluster must not
 * block the others or the run this follows.
 *
 * Final-review Important 3: gated and capped like the other two LLM steps.
 * builtin-local can't draft (`complete`'s query path throws per proposal,
 * forever — and the Overview's "LLM steps waiting" note never showed,
 * because only digest/full-tier set a skipped flag), so it early-returns
 * `no-provider` the same way `runSessionDigest`/`runFullTierIngest` do. And
 * at Aggressive intensity every detected cluster arrives pre-approved, so one
 * run could otherwise fire an unbounded number of paid draft calls.
 *
 * `budget` is NOT `llm_ingest_budget` itself — it is the SHARE of it left
 * over after full-tier ingest already spent its part of the same per-run cap
 * (computed by `runDistillGuarded`, the only caller). Without this, a run
 * could spend `llm_ingest_budget` on ingest AND `llm_ingest_budget` on draft
 * maps — 2× the label the user set. */
async function applyApprovedDraftMaps(
  vaultPath: string,
  budget: number,
): Promise<MapDraftOutcome> {
  const { provider } = await getActiveModel("query");
  if (provider === "builtin-local") {
    return { drafted: 0, skipped: "no-provider" };
  }

  let drafted = 0;
  // One undo-manifest for ALL maps this run drafts — per-call ids fragmented
  // a multi-map run so "undo this run" only reached the last map drafted.
  const manifestId = `llm-${Math.floor(Date.now() / 1000)}`;
  const tree = await ipc.listFiles(vaultPath).catch(() => []);
  for (const f of feedbackFileNodes(tree)) {
    if (drafted >= budget) break;
    const file = await ipc.readFile(f.path).catch(() => null);
    if (!file) continue;
    const parsed = parseProposal(toRelative(vaultPath, f.path), file.raw);
    if (parsed?.action !== "draft-map" || parsed.status !== "approved") continue;
    if (!parsed.cluster || !parsed.members) continue;
    try {
      await draftMap(vaultPath, parsed.cluster, parsed.members, manifestId);
      await ipc.writeFile(f.path, rewriteStatus(file.raw, "done"));
      drafted++;
    } catch (e) {
      console.error(`[distill] auto draft-map apply failed for ${f.path}:`, e);
    }
  }
  return { drafted, skipped: null };
}

/** Cold-tier prune (final-review Important 6): after a digest run archives
 * session files to `sessions/archive/`, the active embedding index still
 * holds their records until the next reindex — `reindex_embeddings` is that
 * next reindex, and it is prune-cheap here (VERIFIED by reading commands.rs):
 * `collect_wiki_pages` drops cold paths, unchanged pages hash-skip without
 * an embed call (no model load either), and `store.prune` drops the archived
 * records. Routed through reindexStore.reindex(), which already owns
 * re-entrancy and progress UI, with two guards:
 *   - only for the currently-open vault — `reindex_embeddings` runs against
 *     the CURRENT vault root, not a parameter, and the digest chain can run
 *     for a different one;
 *   - never on an empty index — that would be the FIRST build (minutes plus
 *     a 769 MB model load), which stays the Settings button's deliberate
 *     action (same rule as autoReindex's decidePoll). */
async function pruneArchivedSessions(vault: string): Promise<void> {
  if (useVaultStore.getState().currentVault?.path !== vault) return;
  const status = await ipc.embeddingsStatus().catch(() => null);
  if (!status || status.indexed_pages === 0) return;
  // Fire-and-forget: reindexStore's own guard rejects a run already in
  // flight, and holding the distill guard window for an index maintenance
  // pass would serialize unrelated work behind it.
  void useReindexStore.getState().reindex();
}

/** Runs distill_run for `vault`, unless one is already in flight for that
 * vault — in which case this resolves to null immediately and makes no ipc
 * call. All callers (schedule-due, count-trigger, manual button) must go
 * through this instead of calling ipc.distillRun directly.
 *
 * On success, also runs the session daily-digest (Phase B, Task 2), then
 * full-tier ingest (Phase B, Task 3), then the draft-map auto-apply bridge
 * (Phase B, Task 4) for the same vault, inside this same guard window — so
 * all three trigger paths get all three for free and concurrency stays
 * single-guarded. All three failures are logged, not thrown: none must ever
 * take down the distill_run result the caller is waiting on. */
export async function runDistillGuarded(vault: string): Promise<RunReport | null> {
  if (inFlight.has(vault)) return null;
  inFlight.add(vault);
  useDistillRunStore.setState({ running: true });
  try {
    const report = await ipc.distillRun(vault);
    // Idle is checked at entry only (by the callers' own triggers); the LLM
    // chain below runs to completion once started — there is no abort
    // mid-chain. Total work is bounded by the three per-step budgets
    // (llm_digest_days, llm_ingest_budget ×2), so the tail is short by
    // construction rather than interruptible.
    const outcome = await runSessionDigest(vault).catch((e) => {
      console.error("[distill] session digest failed", vault, e);
      return null;
    });
    if (outcome) lastDigestOutcome.set(vault, outcome);
    if (outcome && outcome.filesArchived > 0) {
      await pruneArchivedSessions(vault).catch((e) => {
        console.error("[distill] cold-tier prune failed", vault, e);
      });
    }
    const fullTierOutcome = await runFullTierIngest(vault).catch((e) => {
      console.error("[distill] full-tier ingest failed", vault, e);
      return null;
    });
    if (fullTierOutcome) lastFullTierOutcome.set(vault, fullTierOutcome);
    // Task 2 fix (settings audit): llm_ingest_budget is a SHARED per-run cap
    // over ingest + draft maps, not one full budget for each — pass maps
    // only what full-tier ingest didn't already spend. A failed fullTierOutcome
    // (caught above) means nothing is known to have been spent.
    const ingestCfg = await ipc.getDistillConfig(vault).catch(() => null);
    const ingestBudget = ingestCfg?.llm_ingest_budget ?? DEFAULT_INGEST_BUDGET;
    const mapBudget = Math.max(0, ingestBudget - (fullTierOutcome?.ingested ?? 0));
    const mapOutcome = await applyApprovedDraftMaps(vault, mapBudget).catch((e) => {
      console.error("[distill] draft-map auto-apply failed", vault, e);
      return null;
    });
    if (mapOutcome) lastMapDraftOutcome.set(vault, mapOutcome);
    return report;
  } finally {
    inFlight.delete(vault);
    // Reflects "any vault still running", not just this one — the guard
    // itself is per-vault (inFlight), but a single boolean is all the
    // Topbar needs (see distillRunStore.ts).
    useDistillRunStore.setState({ running: inFlight.size > 0 });
  }
}
