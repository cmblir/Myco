// TS mirror types for distillation config. Fields match the Rust serde output
// (snake_case from the #[serde(rename_all)] directives).

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { ipc } from "./ipc";
import { getActiveModel } from "./chat";
import { STRINGS } from "./i18n";
import type { Lang, Strings } from "./i18n";
import { useUIStore } from "../stores/uiStore";
import { runSessionDigest } from "./sessionDigest";
import type { DigestOutcome } from "./sessionDigest";
import { runMonthlyRollup, runWeeklyRollup } from "./rollup";
import type { RollupOutcome } from "./rollup";
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
import { toPick, useResurfaceStore } from "../stores/resurfaceStore";
import { stripFrontmatter } from "./markdown";

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

// ROADMAP P2 — archive lifecycle (src-tauri/src/archive_pack.rs). Only the
// two cold trees the app writes: `raw/` is immutable and has no tree name.
export type ArchiveTree = "sessions" | "daily" | "weekly";

/** One `sessions/archive/<YYYY-MM>` or `daily/archive/<YYYY-Www>` bucket. */
export interface BucketUsage {
  tree: ArchiveTree;
  bucket: string;
  /** Loose files in the directory, or entries inside the zip. */
  files: number;
  /** Bytes on disk — the loose files' sum, or the zip's own size. */
  bytes: number;
  packed: boolean;
}

/** Unique React key for one archive bucket row. `${tree}/${bucket}` alone can
 *  collide: a restore that fails partway (see the Rust `archive_pack::restore`
 *  doc comment on its resumable contract) can leave a bucket as BOTH a loose
 *  directory and its untouched zip at once, so `archive_usage` returns two
 *  rows for the same tree+bucket — `packed` is the data field that actually
 *  tells them apart. */
export function archiveBucketKey(b: BucketUsage): string {
  return `${b.tree}/${b.bucket}/${b.packed}`;
}

export interface PackReport {
  buckets: number;
  files: number;
  /** Loose bytes removed minus zip bytes written. */
  reclaimed: number;
  /** `"<tree>/<bucket>: <error>"` — those buckets kept their originals. */
  failed: string[];
}

export interface RestoreReport {
  files: number;
  bytes: number;
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

// rollupableBuckets's return: one settled bucket's source files ready for the
// rollup step — an ISO week of daily/ notes (ROADMAP P1), or a month of
// weekly/ rollups one layer further up.
export interface RollupBucket {
  bucket: string; // YYYY-Www (weekly layer) or YYYY-MM (monthly layer)
  files: string[]; // vault-relative rel paths under daily/ or weekly/
  // Every file here is already named by a rollup marker in the layer above,
  // so its rollup text is durable and only the archive move failed: the run
  // must skip the provider call and retry only the archive step.
  already_rolled: boolean;
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

// ROADMAP P1 — the weekly rollup's outcome, keyed by vault path. Same
// module-level map idiom as lastDigestOutcome directly above.
export const lastWeeklyOutcome = new Map<string, RollupOutcome>();

// The monthly rollup's outcome (weekly/ -> monthly/), same idiom again. Kept
// separate from the weekly map rather than summed: the two layers report
// different units, and the Settings tab shows each on its own line.
export const lastMonthlyOutcome = new Map<string, RollupOutcome>();

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

// Q4 item 10 — the resurface hook's outcome, same module-level map idiom as
// lastDigestOutcome above. `shown` is the pick count that survived the
// store's ignore/snooze filter — what the popover actually shows.
export interface ResurfaceOutcome {
  shown: number;
}
export const lastResurfaceOutcome = new Map<string, ResurfaceOutcome>();

/** Whether the Overview card's "steps waiting — connect a provider" note
 * should show: only full-tier ingest and draft maps still need a provider
 * (the session digest runs extractively on builtin-local), so only their
 * no-provider skips feed it. */
export function llmStepsWaiting(
  full: FullTierOutcome | undefined,
  maps: MapDraftOutcome | undefined,
): boolean {
  return full?.skipped === "no-provider" || maps?.skipped === "no-provider";
}

/** "Shrinking" must be observed, not hoped: true only when the pending count
 * actually decreased since the previous observation (null = none yet). */
export function pendingShrank(prev: number | null, now: number): boolean {
  return prev !== null && now < prev;
}

/** Overview card's inline outcome line for a finished manual run — an
 * empty-backlog run resolves in under a second, too fast for the topbar
 * activity chip to communicate anything, so the card itself says what
 * happened. A run that moved nothing says so instead of showing zeros. */
export function formatRunOutcome(
  report: RunReport,
  daysDigested: number,
  weeksRolledUp: number,
  t: Strings,
  monthsRolledUp = 0,
): string {
  const worked =
    report.archived > 0 ||
    report.trashed > 0 ||
    report.proposals > 0 ||
    daysDigested > 0 ||
    weeksRolledUp > 0 ||
    monthsRolledUp > 0;
  if (!worked) {
    return t.ov_distill_done_none ?? "Distill finished — nothing to process";
  }
  return (
    t.ov_distill_done ??
    "Distill finished — archived {a} · {d} days digested · {w} weeks rolled up · {p} proposals"
  )
    .replace("{a}", String(report.archived))
    .replace("{d}", String(daysDigested))
    .replace("{w}", String(weeksRolledUp))
    .replace("{p}", String(report.proposals))
    // A month rolls up about once a month, so its count is an appended clause
    // rather than a fourth fixed slot: a permanent "0 monthly rollups" would
    // be noise on every other run of the year.
    .concat(
      monthsRolledUp > 0
        ? (t.ov_distill_done_months ?? " · {m} monthly rollups").replace(
            "{m}",
            String(monthsRolledUp),
          )
        : "",
    );
}

// Fallback llm_ingest_budget when getDistillConfig is unavailable — mirrors
// the Rust-side default, same idiom as fullTierIngest.ts's own copy.
const DEFAULT_INGEST_BUDGET = 3;

// Cooperative stop for the LLM chain (Settings 증류 tab's Stop button).
// Checked BETWEEN steps only, never mid-LLM-call: an in-flight call always
// finishes, so every step's own idempotency/undo story stays intact and the
// vault is never left mid-step.
const stopRequested = new Set<string>();

/** The step the last run's chain stopped after ("run" = the Rust core pass;
 * the chain never starts a later step once the flag is seen), or null when it
 * ran to the end — same module-level map idiom as lastDigestOutcome above. */
export type DistillStopPoint =
  | "run"
  | "digest"
  | "weekly"
  | "monthly"
  | "ingest"
  | "maps"; // a step exists AFTER maps now (resurface), so a stop can land here
export const lastStopPoint = new Map<string, DistillStopPoint | null>();

/** Ask an in-flight distill chain for `vault` to stop before its next step.
 * A no-op when nothing is running — the flag would otherwise leak into the
 * next run. */
export function requestDistillStop(vault: string): void {
  if (inFlight.has(vault)) stopRequested.add(vault);
}

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
  // Collect the approved proposals BEFORE the provider check — "waiting for
  // a provider" with nothing approved is a lie the Overview card would
  // faithfully repeat (same ordering as runFullTierIngest).
  const tree = await ipc.listFiles(vaultPath).catch(() => []);
  const approved: { path: string; raw: string; cluster: string; members: string[] }[] = [];
  for (const f of feedbackFileNodes(tree)) {
    const file = await ipc.readFile(f.path).catch(() => null);
    if (!file) continue;
    const parsed = parseProposal(toRelative(vaultPath, f.path), file.raw);
    if (parsed?.action !== "draft-map" || parsed.status !== "approved") continue;
    if (!parsed.cluster || !parsed.members) continue;
    approved.push({ path: f.path, raw: file.raw, cluster: parsed.cluster, members: parsed.members });
  }
  if (approved.length === 0) return { drafted: 0, skipped: null };

  const { provider } = await getActiveModel("query");
  if (provider === "builtin-local") {
    return { drafted: 0, skipped: "no-provider" };
  }

  let drafted = 0;
  // One undo-manifest for ALL maps this run drafts — per-call ids fragmented
  // a multi-map run so "undo this run" only reached the last map drafted.
  const manifestId = `llm-${Math.floor(Date.now() / 1000)}`;
  for (const p of approved.slice(0, budget)) {
    try {
      await draftMap(vaultPath, p.cluster, p.members, manifestId);
      await ipc.writeFile(p.path, rewriteStatus(p.raw, "done"));
      drafted++;
    } catch (e) {
      console.error(`[distill] auto draft-map apply failed for ${p.path}:`, e);
    }
  }
  return { drafted, skipped: null };
}

/** Cold-tier prune (final-review Important 6): after a digest run archives
 * session files to `sessions/archive/` — or a weekly rollup archives daily
 * notes to `daily/archive/`, the same cold tier one layer up — the active
 * embedding index still
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
async function pruneColdTier(vault: string): Promise<void> {
  if (useVaultStore.getState().currentVault?.path !== vault) return;
  const status = await ipc.embeddingsStatus().catch(() => null);
  if (!status || status.indexed_pages === 0) return;
  // Fire-and-forget: reindexStore's own guard rejects a run already in
  // flight, and holding the distill guard window for an index maintenance
  // pass would serialize unrelated work behind it.
  void useReindexStore.getState().reindex();
}

// Local YYYY-MM-DD — daily/<day>.md's own naming. Local rather than
// toISOString(): UTC would read yesterday's note through the morning hours
// west of Greenwich (the queryIntent.ts `localDate` pitfall).
function localDay(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// OS notification permission, asked once on first use (the design's two
// notification kinds both come from the distill chain, so the latch lives
// here). null = not asked yet.
let notifyGranted: boolean | null = null;

async function osNotify(title: string, body: string): Promise<void> {
  try {
    if (notifyGranted === null) {
      notifyGranted = await isPermissionGranted();
      if (!notifyGranted) {
        notifyGranted = (await requestPermission()) === "granted";
      }
    }
    if (notifyGranted) sendNotification({ title, body });
  } catch (e) {
    // Plain-browser dev has no notification plugin; a denied/broken
    // notification must never fail the distill chain it decorates.
    console.warn("[distill] os notification failed:", e);
  }
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
  // Cleared up front so a digest step that THROWS cannot leave last run's
  // outcome behind — formatRunOutcome would attribute stale digested-day
  // counts to this run.
  lastDigestOutcome.delete(vault);
  lastWeeklyOutcome.delete(vault);
  lastMonthlyOutcome.delete(vault);
  lastResurfaceOutcome.delete(vault);
  useDistillRunStore.setState({ running: true, step: "run" });
  try {
    const report = await ipc.distillRun(vault);
    // OS notification: new quarantine items. Fired here — the layer that
    // already has the number — and only when this run actually moved
    // something into quarantine, so a quiet run stays quiet.
    if (report.scan.quarantined > 0) {
      const t = STRINGS[useUIStore.getState().lang];
      void osNotify(
        t.notif_quarantine_title ?? "New quarantine items",
        (t.notif_quarantine_body ??
          "{n} items are waiting for review in _inbox/quarantine.").replace(
          "{n}",
          String(report.scan.quarantined),
        ),
      );
    }
    // Idle is checked at entry only (by the callers' own triggers); once
    // started, the chain can only be stopped cooperatively BETWEEN steps
    // (requestDistillStop), never mid-LLM-call. Total work stays bounded by
    // the per-step budgets (llm_digest_days, llm_ingest_budget ×2).
    lastStopPoint.set(vault, null);
    if (stopRequested.has(vault)) {
      lastStopPoint.set(vault, "run");
      return report;
    }
    useDistillRunStore.setState({ step: "digest" });
    const outcome = await runSessionDigest(vault).catch((e) => {
      console.error("[distill] session digest failed", vault, e);
      return null;
    });
    if (outcome) lastDigestOutcome.set(vault, outcome);
    if (outcome && outcome.filesArchived > 0) {
      await pruneColdTier(vault).catch((e) => {
        console.error("[distill] cold-tier prune failed", vault, e);
      });
    }
    if (stopRequested.has(vault)) {
      lastStopPoint.set(vault, "digest");
      return report;
    }
    // ROADMAP P1 — the second compression layer, immediately after the first:
    // the digest step above is what just appended to daily/, so this runs on
    // the freshest possible view of it (a week whose last daily file was only
    // written this run is still held back by its own maturity gate).
    useDistillRunStore.setState({ step: "weekly" });
    const weekly = await runWeeklyRollup(vault).catch((e) => {
      console.error("[distill] weekly rollup failed", vault, e);
      return null;
    });
    if (weekly) lastWeeklyOutcome.set(vault, weekly);
    if (weekly && weekly.sourcesArchived > 0) {
      await pruneColdTier(vault).catch((e) => {
        console.error("[distill] cold-tier prune failed", vault, e);
      });
    }
    if (stopRequested.has(vault)) {
      lastStopPoint.set(vault, "weekly");
      return report;
    }
    // Third layer, immediately after the second for the same reason: the
    // weekly step above is what just appended to weekly/, so a month whose
    // last week was only written this run is still held back by that week's
    // own maturity gate.
    useDistillRunStore.setState({ step: "monthly" });
    const monthly = await runMonthlyRollup(vault).catch((e) => {
      console.error("[distill] monthly rollup failed", vault, e);
      return null;
    });
    if (monthly) lastMonthlyOutcome.set(vault, monthly);
    if (monthly && monthly.sourcesArchived > 0) {
      await pruneColdTier(vault).catch((e) => {
        console.error("[distill] cold-tier prune failed", vault, e);
      });
    }
    if (stopRequested.has(vault)) {
      lastStopPoint.set(vault, "monthly");
      return report;
    }
    useDistillRunStore.setState({ step: "ingest" });
    const fullTierOutcome = await runFullTierIngest(vault).catch((e) => {
      console.error("[distill] full-tier ingest failed", vault, e);
      return null;
    });
    if (fullTierOutcome) lastFullTierOutcome.set(vault, fullTierOutcome);
    if (stopRequested.has(vault)) {
      lastStopPoint.set(vault, "ingest");
      return report;
    }
    // Task 2 fix (settings audit): llm_ingest_budget is a SHARED per-run cap
    // over ingest + draft maps, not one full budget for each — pass maps
    // only what full-tier ingest didn't already spend. A failed fullTierOutcome
    // (caught above) means nothing is known to have been spent.
    useDistillRunStore.setState({ step: "maps" });
    const ingestCfg = await ipc.getDistillConfig(vault).catch(() => null);
    const ingestBudget = ingestCfg?.llm_ingest_budget ?? DEFAULT_INGEST_BUDGET;
    const mapBudget = Math.max(0, ingestBudget - (fullTierOutcome?.ingested ?? 0));
    const mapOutcome = await applyApprovedDraftMaps(vault, mapBudget).catch((e) => {
      console.error("[distill] draft-map auto-apply failed", vault, e);
      return null;
    });
    if (mapOutcome) lastMapDraftOutcome.set(vault, mapOutcome);
    if (stopRequested.has(vault)) {
      lastStopPoint.set(vault, "maps");
      return report;
    }
    // Q4 item 10 — resurface: echo today's daily note against dormant wiki
    // pages. Runs last because it writes nothing — it only refreshes the
    // store the Activity popover reads. No daily note today means no seed,
    // which is a quiet skip, not an error.
    useDistillRunStore.setState({ step: "resurface" });
    try {
      const daily = await ipc
        .readFile(`${vault}/daily/${localDay()}.md`)
        .catch(() => null);
      if (daily?.raw) {
        const floor = useResurfaceStore.getState().floor;
        const cands = await ipc.resurfaceCandidates(
          vault,
          stripFrontmatter(daily.raw).slice(0, 4000),
          6,
          floor,
        );
        useResurfaceStore.getState().refreshFrom(cands.map(toPick));
        lastResurfaceOutcome.set(vault, {
          shown: useResurfaceStore.getState().picks.length,
        });
      }
    } catch (e) {
      // Resurfacing must never fail the run it decorates.
      console.warn("[distill] resurface failed:", vault, e);
    }
    // OS notification: distill complete, with the run's headline counts.
    // Only when the run produced something — the idle trigger fires this
    // chain routinely, and a stream of "0 proposals" notifications would
    // train the user to disable notifications entirely. Stopped-early runs
    // (the returns above) skip it too: the user was watching the popover.
    const days = outcome?.daysDigested ?? 0;
    const weeks = weekly?.bucketsRolledUp ?? 0;
    const months = monthly?.bucketsRolledUp ?? 0;
    if (report.proposals > 0 || days > 0 || weeks > 0 || months > 0) {
      const t = STRINGS[useUIStore.getState().lang];
      void osNotify(
        t.notif_distill_done_title ?? "Distill finished",
        (t.notif_distill_done_body ??
          "{p} proposals · {d} session days digested · {w} weeks rolled up")
          .replace("{p}", String(report.proposals))
          .replace("{d}", String(days))
          .replace("{w}", String(weeks))
          // Same appended-clause rule as the Overview line above.
          .concat(
            months > 0
              ? (t.notif_distill_done_months ?? " · {m} monthly rollups").replace(
                  "{m}",
                  String(months),
                )
              : "",
          ),
      );
    }
    return report;
  } finally {
    inFlight.delete(vault);
    stopRequested.delete(vault);
    // Reflects "any vault still running", not just this one — the guard
    // itself is per-vault (inFlight), but a single boolean is all the
    // Topbar needs (see distillRunStore.ts).
    useDistillRunStore.setState(
      inFlight.size > 0 ? { running: true } : { running: false, step: null },
    );
  }
}
