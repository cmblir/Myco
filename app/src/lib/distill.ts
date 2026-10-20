import type { RoleSnapshot, RoleUsage } from "./modelRoles";
// TS mirror types for distillation config. Fields match the Rust serde output
// (snake_case from the #[serde(rename_all)] directives).

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { ipc } from "./ipc";
import { tryLock, unlock } from "./vaultLock";
import { canGenerate, getActiveModel } from "./chat";
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
import { isMissingFile } from "./sessionEvidence";
import { WorkflowOperationError, workflowIssue, workflowStatus, type WorkflowProgress, type WorkflowReceipt, type WorkflowStatus } from "./workflowOutcome";

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
  trashed: number;
  deleted?: number;
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
  /** Failed buckets retain available copies; a partial unlink retains the full ZIP. */
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

// Task 8 fix (code review): independent callers can decide to run
// distill_run around the same moment (the manual "Distill now" button, the
// auto-distill toggle's pass), and a run can outlive the poll that started
// it — without a shared guard two runs could interleave file moves. The guard
// is the vault lock (vaultLock.ts), which the in-app auto-ingest pass takes
// too; this set only tracks which vaults have a distill chain running, for
// the stop request and the Topbar.
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
export interface MapDraftOutcome extends WorkflowProgress {
  drafted: number;
  skipped: "no-provider" | null;
  pending?: number;
  publishedPending?: string[];
}
export const lastMapDraftOutcome = new Map<string, MapDraftOutcome>();
export const lastWorkflowReceipt = new Map<string, WorkflowReceipt>();

/** Keep the completed native work reviewable without reporting the chain done. */
export class WorkflowRunError extends Error {
  constructor(readonly receipt: WorkflowReceipt, readonly report: RunReport | null) {
    super(receipt.issues.map(issue => `${issue.step}: ${issue.error}`).join("; ") || `Distill ${receipt.status}`);
    this.name = "WorkflowRunError";
  }
}

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

/** Sources with unread passages after the latest bounded distill pass. */
export function pendingEvidenceSources(vault: string): number {
  return (lastDigestOutcome.get(vault)?.filesPending ?? 0) +
    (lastWeeklyOutcome.get(vault)?.sourcesPending ?? 0) +
    (lastMonthlyOutcome.get(vault)?.sourcesPending ?? 0) +
    (lastFullTierOutcome.get(vault)?.sourcesPending ?? 0);
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
  sourcesPending = 0,
): string {
  const worked =
    report.trashed > 0 ||
    (report.deleted ?? 0) > 0 ||
    report.proposals > 0 ||
    daysDigested > 0 ||
    weeksRolledUp > 0 ||
    monthsRolledUp > 0;
  if (!worked) {
    if (sourcesPending > 0) return t.set_distill_evidence_pending.replace("{n}", String(sourcesPending));
    return t.ov_distill_done_none ?? "Distill finished — nothing to process";
  }
  return (
    t.ov_distill_done ??
    "Distill finished — {d} days digested · {w} weeks rolled up · {p} proposals"
  )
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
    ).concat((report.deleted ?? 0) > 0 ? ` · ${t.deleted_count.replace("{n}", String(report.deleted))}` : "").concat(sourcesPending > 0 ? ` · ${t.set_distill_evidence_pending.replace("{n}", String(sourcesPending))}` : "");
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
  usage: RoleUsage = "foreground",
  roleSnapshot?: RoleSnapshot,
): Promise<MapDraftOutcome> {
  // Collect the approved proposals BEFORE the provider check — "waiting for
  // a provider" with nothing approved is a lie the Overview card would
  // faithfully repeat (same ordering as runFullTierIngest).
  const tree = await ipc.listFiles(vaultPath);
  const approved: { path: string; raw: string; cluster: string; members: string[] }[] = [];
  for (const f of feedbackFileNodes(tree)) {
    const file = await ipc.readFile(f.path);
    const parsed = parseProposal(toRelative(vaultPath, f.path), file.raw);
    if (parsed?.action !== "draft-map" || parsed.status !== "approved") continue;
    if (!parsed.cluster || !parsed.members) continue;
    approved.push({ path: f.path, raw: file.raw, cluster: parsed.cluster, members: parsed.members });
  }
  if (approved.length === 0) return { drafted: 0, skipped: null };
  if (budget <= 0) return { drafted: 0, skipped: null, pending: approved.length, status: "pending" };

  // The admitted route stays fixed through generation and publication.
  const selected = roleSnapshot ? {
    provider: roleSnapshot.routeSignature.providerId,
    model: roleSnapshot.routeSignature.modelId,
  } : await getActiveModel("organization");
  if (!canGenerate(selected.provider, selected.model)) {
    return { drafted: 0, skipped: "no-provider", pending: approved.length, status: "pending",
      issues: [workflowIssue("maps", new WorkflowOperationError("pending", "unavailable", "Selected local map generation is unavailable"))] };
  }

  let drafted = 0;
  const publishedPending: string[] = [];
  const issues = [];
  // One undo-manifest for ALL maps this run drafts — per-call ids fragmented
  // a multi-map run so "undo this run" only reached the last map drafted.
  const manifestId = `llm-${Math.floor(Date.now() / 1000)}`;
  for (const p of approved.slice(0, budget)) {
    try {
      await draftMap(vaultPath, p.cluster, p.members, manifestId, undefined, usage, roleSnapshot);
      await ipc.writeFile(p.path, rewriteStatus(p.raw, "done"));
      drafted++;
    } catch (e) {
      console.error(`[distill] auto draft-map apply failed for ${p.path}:`, e);
      if (e instanceof WorkflowOperationError && "writtenPath" in e && typeof e.writtenPath === "string") publishedPending.push(e.writtenPath);
      issues.push(workflowIssue("maps", e, p.path));
      if (issues.at(-1)?.status === "stopped") break;
    }
  }
  const pending = approved.length - drafted;
  return { drafted, skipped: null, ...(pending ? { pending } : {}),
    ...(publishedPending.length ? { publishedPending } : {}),
    ...(issues.length || pending ? { status: workflowStatus(issues, drafted + publishedPending.length, pending) } : {}),
    ...(issues.length ? { issues } : {}),
  };
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
 *   - never on an empty index — that would be the FIRST build, which stays the Settings button's deliberate
 *     action (same rule as autoReindex's decidePoll). */
async function pruneColdTier(vault: string): Promise<void> {
  if (useVaultStore.getState().currentVault?.path !== vault) return;
  const status = await ipc.embeddingsStatus();
  if (!status || status.indexed_pages === 0) return;
  await useReindexStore.getState().reindex();
  const indexed = useReindexStore.getState();
  if (indexed.stage === "error") throw new Error(indexed.error ?? "Cold-tier index refresh failed");
  if (indexed.stage !== "done") throw new WorkflowOperationError("pending", "unavailable", "Cold-tier index refresh has not completed");
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

/** Run the bounded chain under the shared vault lock. Only a fully completed
 * chain resolves its native report; incomplete work keeps a typed receipt. */
export async function runDistillGuarded(vault: string, usage: RoleUsage = "foreground"): Promise<RunReport | null> {
  if (!tryLock(vault)) return null;
  inFlight.add(vault);
  lastDigestOutcome.delete(vault);
  lastWeeklyOutcome.delete(vault);
  lastMonthlyOutcome.delete(vault);
  lastFullTierOutcome.delete(vault);
  lastMapDraftOutcome.delete(vault);
  lastResurfaceOutcome.delete(vault);
  lastStopPoint.set(vault, null);
  const receipt: WorkflowReceipt = { status: "pending", steps: [], issues: [] };
  lastWorkflowReceipt.set(vault, receipt);
  useDistillRunStore.setState({ running: true, step: "run", outcome: null,
    workflowStatus: null, receipt: null, seen: true });
  let report: RunReport | null = null;
  let activeStep = "run";
  const fail = (): never => {
    receipt.status = receipt.issues.some(issue => issue.status === "stopped") ? "stopped"
      : receipt.steps.some(step => step.status === "success" || step.status === "partial") ? "partial"
      : receipt.issues.some(issue => issue.status === "failed") ? "failed" : "pending";
    throw new WorkflowRunError(receipt, report);
  };
  const stopped = (step: DistillStopPoint): void => {
    if (!stopRequested.has(vault)) return;
    lastStopPoint.set(vault, step);
    receipt.issues.push(workflowIssue(step, new WorkflowOperationError("stopped", "cancelled", "stopped")));
    fail();
  };
  const accept = async (step: DistillStopPoint, result: WorkflowProgress | null | undefined, status: WorkflowStatus, prune = false): Promise<void> => {
    if (!result) throw new Error(`${step} returned no workflow outcome`);
    const actual = result.status ?? status;
    const issues = result.issues ?? [];
    receipt.steps.push({ step, status: actual, ...(issues.length ? { issues } : {}) });
    receipt.issues.push(...issues);
    if (prune) {
      activeStep = `${step}.index`;
      await pruneColdTier(vault);
      activeStep = step;
    }
    stopped(step);
    if (actual === "success" || actual === "skipped") return;
    if (!issues.length) receipt.issues.push(workflowIssue(step,
      new WorkflowOperationError(actual === "stopped" ? "stopped" : actual === "failed" ? "failed" : "pending",
        actual === "stopped" ? "cancelled" : "incomplete", `${step} has unfinished work`)));
    fail();
  };
  try {
    report = await ipc.distillRun(vault);
    const coreWork = report.proposals + report.trashed + (report.deleted ?? 0) + report.scan.summaries + report.scan.quarantined;
    receipt.steps.push({ step: "run", status: coreWork > 0 ? "success" : "skipped" });
    if (report.scan.quarantined > 0) {
      const t = STRINGS[useUIStore.getState().lang];
      void osNotify(t.notif_quarantine_title, t.notif_quarantine_body.replace("{n}", String(report.scan.quarantined)));
    }
    stopped("run");

    activeStep = "digest";
    useDistillRunStore.setState({ step: "digest" });
    const origin = await ipc.agentVaultSession();
    if (origin.vaultPath !== vault) throw new Error("Vault changed before organization started");
    const roleSnapshot = await ipc.captureModelRole(origin, "organization", usage);
    const digest = await runSessionDigest(vault, usage, roleSnapshot);
    if (!digest) throw new Error("digest returned no workflow outcome");
    lastDigestOutcome.set(vault, digest);
    await accept("digest", digest, digest.filesPending ? "partial" : digest.skipped ? "skipped" : "success",
      digest.filesArchived > 0 || (digest.chunksProcessed ?? 0) > 0);

    activeStep = "weekly";
    useDistillRunStore.setState({ step: "weekly" });
    const weekly = await runWeeklyRollup(vault, usage, roleSnapshot);
    if (!weekly) throw new Error("weekly returned no workflow outcome");
    lastWeeklyOutcome.set(vault, weekly);
    await accept("weekly", weekly, weekly.sourcesPending ? "partial" : weekly.skipped ? "skipped" : "success",
      weekly.sourcesArchived > 0 || (weekly.chunksProcessed ?? 0) > 0);

    activeStep = "monthly";
    useDistillRunStore.setState({ step: "monthly" });
    const monthly = await runMonthlyRollup(vault, usage, roleSnapshot);
    if (!monthly) throw new Error("monthly returned no workflow outcome");
    lastMonthlyOutcome.set(vault, monthly);
    await accept("monthly", monthly, monthly.sourcesPending ? "partial" : monthly.skipped ? "skipped" : "success",
      monthly.sourcesArchived > 0 || (monthly.chunksProcessed ?? 0) > 0);

    activeStep = "ingest";
    useDistillRunStore.setState({ step: "ingest" });
    const fullTier = await runFullTierIngest(vault, { origin, usage });
    if (!fullTier) throw new Error("ingest returned no workflow outcome");
    lastFullTierOutcome.set(vault, fullTier);
    await accept("ingest", fullTier, fullTier.errors.length ? fullTier.ingested ? "partial" : "failed"
      : fullTier.sourcesPending || fullTier.skipped === "no-provider" ? "pending"
      : fullTier.skipped ? "skipped" : "success");

    activeStep = "maps";
    useDistillRunStore.setState({ step: "maps" });
    const cfg = await ipc.getDistillConfig(vault);
    const spent = fullTier.ingested + (fullTier.sourcesPending ?? 0) + fullTier.errors.length;
    const maps = await applyApprovedDraftMaps(vault, Math.max(0, (cfg?.llm_ingest_budget ?? DEFAULT_INGEST_BUDGET) - spent), usage, roleSnapshot);
    lastMapDraftOutcome.set(vault, maps);
    await accept("maps", maps, maps.pending || maps.skipped ? "pending" : maps.drafted ? "success" : "skipped");

    activeStep = "resurface";
    useDistillRunStore.setState({ step: "resurface" });
    const daily = await ipc.readFile(`${vault}/daily/${localDay()}.md`).catch(error => {
      if (isMissingFile(error)) return null;
      throw error;
    });
    if (daily?.raw) {
      const candidates = await ipc.resurfaceCandidates(vault, stripFrontmatter(daily.raw).slice(0, 4000), 6, useResurfaceStore.getState().floor);
      useResurfaceStore.getState().refreshFrom(candidates.map(toPick));
      lastResurfaceOutcome.set(vault, { shown: useResurfaceStore.getState().picks.length });
      receipt.steps.push({ step: "resurface", status: "success" });
    } else receipt.steps.push({ step: "resurface", status: "skipped" });
    receipt.status = receipt.steps.every(step => step.status === "skipped") ? "skipped" : "success";
    if (report.proposals > 0 || digest.daysDigested > 0 || weekly.bucketsRolledUp > 0 || monthly.bucketsRolledUp > 0) {
      const t = STRINGS[useUIStore.getState().lang];
      void osNotify(t.notif_distill_done_title, t.notif_distill_done_body.replace("{p}", String(report.proposals))
        .replace("{d}", String(digest.daysDigested)).replace("{w}", String(weekly.bucketsRolledUp))
        .concat(monthly.bucketsRolledUp > 0 ? t.notif_distill_done_months.replace("{m}", String(monthly.bucketsRolledUp)) : ""));
    }
    return report;
  } catch (error) {
    if (error instanceof WorkflowRunError) throw error;
    const issue = workflowIssue(activeStep, error);
    receipt.steps.push({ step: activeStep, status: issue.status, issues: [issue] });
    receipt.issues.push(issue);
    console.error("[distill] workflow incomplete", vault, error);
    return fail();
  } finally {
    inFlight.delete(vault);
    unlock(vault);
    stopRequested.delete(vault);
    lastWorkflowReceipt.set(vault, receipt);
    useDistillRunStore.setState(inFlight.size > 0 ? { running: true } : {
      running: false, step: null,
      outcome: receipt.status === "success" || receipt.status === "skipped" ? "done" : receipt.status === "stopped" ? null : "error",
      workflowStatus: receipt.status, receipt, seen: false,
    });
  }
}
