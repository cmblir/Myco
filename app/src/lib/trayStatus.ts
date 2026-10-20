// Frontend half of the macOS menu bar tray: watches the same stores the
// Topbar ActivityChip renders from, and pushes a pre-translated snapshot to
// Rust (tray::update_tray_status) whenever the aggregate state changes.
//
// The Rust side stores strings only — every label here is translated with the
// app's own lang setting before it crosses the IPC boundary. Sends are
// debounced (trailing 300 ms) and progress ticks are throttled to at most one
// send per second, so a reindex over hundreds of pages never floods the menu.

import { emit, listen } from "@tauri-apps/api/event";
import { ipc } from "./ipc";
import type {
  InflowStats,
  NotchAgendaPayload,
  NotchAgendaRow,
  TrayPanelPayload,
  TrayRunningRow,
  TrayStatusPayload,
} from "./ipc";
import { STRINGS } from "./i18n";
import type { Strings } from "./i18n";
import { inflowLines } from "./inflow";
import { getLastSweepAt, getLastSweepReceipt } from "./autoImport";
import type { WorkflowStatus } from "./workflowOutcome";
import { buildDigest } from "./taskNotify";
import {
  pendingLinkCount,
  suggestLinks,
} from "./linkSuggestions";
import { applyLinkSuggestions } from "./linkActions";
import type { LinkSuggestion } from "./linkSuggestions";
import { runInboxPass } from "./autoIngest";
import { harvestSelected } from "./harvest";
import { isTrayActionEnvelope, isVaultTrayAction, TRAY_ACTION_RESULT_EVENT, vaultActionScopeKey, type TrayActionEnvelope, type VaultActionScope } from "./notchAction";
import { stem } from "./graphData";
import { notchAgenda } from "./notchAgenda";
import type { AgendaItem, NotchAgenda } from "./notchAgenda";
import { runDistillGuarded } from "./distill";
import {
  MAP_ROW_CAP,
  mapRowContent,
  stepLabel,
} from "../components/ActivityChip";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { useQueryStore } from "../stores/queryStore";
import { useReindexStore } from "../stores/reindexStore";
import { useDistillRunStore } from "../stores/distillRunStore";
import type { DistillRunStep } from "../stores/distillRunStore";
import { useHarvestStore } from "../stores/harvestStore";
import type { HarvestRun, RunOutcome } from "../stores/harvestStore";
import { useNoticeStore } from "../stores/noticeStore";
import type { NoticeProgress } from "../stores/noticeStore";
import { useLinkSuggestStore } from "../stores/linkSuggestStore";
import { useReflectStore } from "../stores/reflectStore";
import type { ReflectStage } from "../stores/reflectStore";
import {
  useDistillStore,
  pendingMapProposals,
  settingsNeedWriter,
} from "../stores/distillStore";
import type { ProposalMeta } from "../stores/distillStore";
import { useSettingsStore } from "../stores/settingsStore";

/** Emitted by Rust when a tray menu action row is clicked. */
export const TRAY_ACTION_EVENT = "myco://tray-action";

/** Everything the payload is derived from, decoupled from the stores so the
 * pure builders below are unit-testable. */
export interface TraySnapshot {
  actionScope?: VaultActionScope | null;
  askBusy: boolean;
  distillRunning: boolean;
  distillStep: DistillRunStep | null;
  reflectRunning: boolean;
  /** Unseen reflect findings; 0 hides the standing row (a standing state, so
   *  it never counts toward the tray title). */
  /** Reflect findings currently listed. A STANDING count like pendingLinks —
   *  not gated on `seen`: the panel lives on Overview, so a seen-gate hid the
   *  row the instant the app landed there and the tray never showed it. */
  reflectFindings: number;
  reindexStage: "idle" | "loading-model" | "indexing" | "done" | "error";
  reindexDone: number;
  reindexTotal: number;
  pendingLinks: number;
  /** Pending map proposals awaiting a decision — the tray panel's approvable
   *  rows (a standing state, never part of the tray title). */
  mapProposals: ProposalMeta[];
  /** Proposal applies in flight (draft-map = a minutes-long query-model call).
   *  A RUNNING state: counted in the title, shown as a running row, and the
   *  notch lip narrates it like any other runner. */
  applyingProposals: number;
  /** No role can write a map (`settingsNeedWriter`), which the rows say out
   *  loud: an approve then writes nothing. */
  mapsNeedWriter: boolean;
  mcpRunning: boolean;
  /** Today's inflow, or null before/without a probe — hides the section. */
  inflow: InflowStats | null;
  /** Last session-sweep completion (ms epoch) for the sessions sub-line. */
  sweepAt: number | null;
  sweepStatus?: WorkflowStatus;
  /** Auto-import interval (minutes) when enabled; null when off. */
  autoImportMin: number | null;
  /** Open tasks due today / overdue (throttled scan; 0/0 before a probe). */
  dueToday: number;
  overdue: number;
  /** Decisions waiting, for the notch (lib/notchAgenda). A STANDING state,
   *  like pendingLinks: never part of the tray title. */
  agenda: NotchAgenda;
  /** A harvest batch in flight (harvestStore's run slice). */
  harvest: HarvestRun;
  /** The chip's determinate job slot (noticeStore): a link "accept all". */
  progress: NoticeProgress | null;
  /** Kinds whose last run failed (`failedKinds`). */
  failed: TrayRunningRow["kind"][];
}

/** The running-row kinds whose last run ended in a failure, off each job's
 *  own store. Each clears when its job starts again; `linksFailed` is the
 *  tray's own latch over noticeStore (see initTrayIntegration). */
export function failedKinds(s: {
  harvest: RunOutcome;
  distill: RunOutcome;
  reflect: ReflectStage;
  reindex: TraySnapshot["reindexStage"];
  linksFailed: boolean;
}): TrayRunningRow["kind"][] {
  const out: TrayRunningRow["kind"][] = [];
  if (s.harvest === "error") out.push("ingest");
  // ponytail: "distill" rows also carry proposal applies, which report no
  // failure here; a failed chain marks them until the next chain starts.
  if (s.distill === "error") out.push("distill");
  if (s.reflect === "error") out.push("reflect");
  if (s.reindex === "error") out.push("index");
  if (s.linksFailed) out.push("links");
  return out;
}

/** Icon-side title: nothing when idle, the reindex percent when indexing is
 * the only runner (the one activity with a meaningful %), the running count
 * for 2+. A single distill/ask runner shows no number — its "number" is a
 * step name / elapsed time, too long for the menu bar. */
export function trayTitle(s: TraySnapshot): string | null {
  const reindexBusy =
    s.reindexStage === "loading-model" || s.reindexStage === "indexing";
  const count =
    (s.askBusy ? 1 : 0) +
    (s.distillRunning ? 1 : 0) +
    (s.reflectRunning ? 1 : 0) +
    (s.applyingProposals > 0 ? 1 : 0) +
    (reindexBusy ? 1 : 0) +
    (s.harvest.phase !== null ? 1 : 0) +
    (s.progress ? 1 : 0);
  if (count === 0) return null;
  if (count >= 2) return String(count);
  if (s.reindexStage === "indexing" && s.reindexTotal > 0) {
    return `${Math.round((s.reindexDone / s.reindexTotal) * 100)}%`;
  }
  return null;
}

/** Full pre-translated payload, mirroring the in-app popover's rows.
 * Reindex progress stays text ("218/302") — native menus can't draw the
 * popover's progress bar, a deliberate platform difference. */
export function buildTrayStatus(
  s: TraySnapshot,
  t: Strings,
): TrayStatusPayload {
  const running: TrayRunningRow[] = [];
  if (s.askBusy) running.push({ kind: "ask", text: t.nav_query });
  if (s.distillRunning) {
    running.push({
      kind: "distill",
      text: `${t.set_distill_running ?? "Distilling…"} — ${stepLabel(s.distillStep, t)}`,
    });
  }
  if (s.reflectRunning) {
    running.push({
      kind: "reflect",
      text: t.rf_running_label ?? "Reflect running…",
    });
  }
  if (s.applyingProposals > 0) {
    running.push({
      kind: "distill",
      text:
        (t.tb_activity_applying ?? "Applying proposal…") +
        (s.applyingProposals > 1 ? ` ×${s.applyingProposals}` : ""),
    });
  }
  if (s.reindexStage === "loading-model") {
    running.push({
      kind: "index",
      text: t.s_embeddings_loading_model ?? "Loading model…",
    });
  } else if (s.reindexStage === "indexing") {
    running.push({
      kind: "index",
      text: `${t.s_embeddings_indexing ?? "Indexing…"} ${s.reindexDone}/${s.reindexTotal}`,
    });
  }
  // The steps ride the text as "11/20", which the notch reads for its bar
  // and for the count beside myco while it roams.
  if (s.harvest.phase !== null) {
    running.push({
      kind: "ingest",
      text:
        s.harvest.phase === "copying"
          ? `${t.tb_harvest_running} · ${t.tb_harvest_copying}`
          : `${t.tb_harvest_running} ${s.harvest.done}/${s.harvest.total}`,
    });
  }
  if (s.progress) {
    // The slot's one job today is a link "accept all" (noticeStore).
    running.push({
      kind: "links",
      text: `${s.progress.label} ${s.progress.done}/${s.progress.total}`,
    });
  }
  const lines = s.inflow
    ? inflowLines(s.inflow, t, {
        sweepAt: s.sweepAt,
        sweepStatus: s.sweepStatus,
        autoImportMin: s.autoImportMin,
      })
    : null;
  return {
    running,
    failed: s.failed,
    title: trayTitle(s),
    suggested: (t.tb_activity_links ?? "{n} suggested links").replace(
      "{n}",
      String(s.pendingLinks),
    ),
    proposals: s.mapProposals
      .slice(0, MAP_ROW_CAP)
      .map((p) => mapRowContent(p, t)),
    proposalApprove: t.pf_approve ?? "Approve",
    proposalReject: t.pf_dismiss ?? "Dismiss",
    proposalNote: s.mapsNeedWriter
      ? (t.pf_map_needs_writer ?? "Writing a topic map needs a model that can write")
      : "",
    inflow:
      lines && s.inflow
        ? {
            ...lines,
            hourlyFiles: s.inflow.hourlyFiles,
            hourlyMcp: s.inflow.hourlyMcp,
          }
        : null,
    greeting: traySubtitle(s, t),
    panel: trayPanel(s, t),
    ask: t.quick_ask,
    distill: t.set_distill_run_now ?? "Distill now",
    open: t.tray_open ?? "Open myco",
    quit: t.tray_quit ?? "Quit myco",
  };
}

/** The one-line status under the mascot's name (tray v3). Three states,
 * priority order: a distill in flight, decisions waiting (pending proposals
 * + overdue tasks — the things the now-card can surface), nothing. */
export function traySubtitle(s: TraySnapshot, t: Strings): string {
  if (s.distillRunning)
    return (t.tray_sub_distilling ?? "Distilling · {step}").replace(
      "{step}",
      stepLabel(s.distillStep, t),
    );
  const waiting = s.mapProposals.length + s.overdue;
  if (waiting > 0)
    return (t.tray_sub_waiting_n ?? "{n} waiting for you").replace(
      "{n}",
      String(waiting),
    );
  return t.tray_sub_clear ?? "Nothing waiting";
}

/** One agenda item → the notch's row, translated and routed. The action
 * strings are the ones `applyTrayAction` below already parses, so the notch
 * never learns a second way to approve a proposal. */
/** A pair label has to fit a notch. Every ingested source is `source-<tool>-
 *  <uuid>`, so the prefix carries nothing and the tail is a hash: keep the
 *  head of the identifying part and elide the middle, so BOTH sides of the
 *  pair survive instead of the first one eating the line. */
function shortStem(path: string): string {
  const raw = stem(path).replace(/^source-/, "");
  return raw.length <= 16 ? raw : `${raw.slice(0, 13)}…`;
}

export function agendaRow(item: AgendaItem, t: Strings): NotchAgendaRow {
  if (item.kind === "proposal") {
    const row = mapRowContent(item.proposal, t);
    return {
      id: item.id,
      label: row.label,
      sub: row.sub,
      primaryLabel: t.pf_approve,
      primaryAction: `proposal-approve:${item.id}`,
      secondaryLabel: t.pf_dismiss,
      secondaryAction: `proposal-reject:${item.id}`,
    };
  }
  if (item.kind === "links") {
    return {
      id: item.id,
      label: t.notch_agenda_links_title.replace("{n}", String(item.count)),
      sub: t.ls_title,
      primaryLabel: t.notch_agenda_links_all,
      primaryAction: "links-accept-all",
      secondaryLabel: t.ls_dismiss,
      secondaryAction: "links-dismiss-all",
    };
  }
  if (item.kind === "link") {
    return {
      id: item.id,
      // Language-neutral, like the notch's other filename rows: the row IS
      // the pair, and "a ↔ b" needs no sentence around it.
      label: `${shortStem(item.link.source)} ↔ ${shortStem(item.link.target)}`,
      sub: t.ls_title,
      primaryLabel: t.ls_accept,
      primaryAction: `links-accept:${item.id}`,
      secondaryLabel: t.ls_dismiss,
      secondaryAction: `links-dismiss:${item.id}`,
    };
  }
  return {
    id: item.id,
    label: t.notch_agenda_harvest_title,
    sub: t.notch_agenda_harvest_sub.replace("{n}", String(item.count)),
    primaryLabel: t.notch_agenda_harvest.replace("{n}", String(item.count)),
    primaryAction: "harvest-run",
    // A queue is not a yes/no: there is nothing to say no to, and "dismiss
    // the whole queue" is a decision the notch has no business offering.
    secondaryLabel: "",
    secondaryAction: "",
  };
}

export function agendaPayload(
  agenda: NotchAgenda,
  t: Strings,
): NotchAgendaPayload {
  return {
    total: agenda.total,
    rows: agenda.rows.map((item) => agendaRow(item, t)),
  };
}

/** Numbers + labels the glass tiles render (tray v3). Kept apart from the
 * pre-formatted rows above because the tiles put the count in its own badge
 * and animate it when it grows, which a baked "6 suggested links" string
 * cannot do. Rust passes this block through untouched. */
export function trayPanel(s: TraySnapshot, t: Strings): TrayPanelPayload {
  return {
    actionScope: s.actionScope ?? null,
    mcpRunning: s.mcpRunning,
    agenda: agendaPayload(s.agenda, t),
    counts: {
      links: s.pendingLinks,
      reflect: s.reflectFindings,
      overdue: s.overdue,
      dueToday: s.dueToday,
      files: (s.inflow?.sessionsToday ?? 0) + (s.inflow?.inboxToday ?? 0),
      mcpCalls: s.inflow?.mcpCallsToday ?? 0,
    },
    labels: {
      waiting: t.tray_tile_waiting ?? "Waiting",
      today: t.tray_tile_today ?? "Today",
      links: t.tray_row_links ?? "Suggested links",
      reflect: t.tray_row_reflect ?? "Reflect suggestions",
      tasks: t.tb_activity_tasks ?? "Tasks",
      tasksDue: (t.tray_card_tasks_v ?? "{n} today").replace(
        "{n}",
        String(s.dueToday),
      ),
      tasksOverdue: (t.tray_card_tasks_sub ?? "{n} overdue").replace(
        "{n}",
        String(s.overdue),
      ),
      sessions: t.tray_row_sessions ?? "Sessions · inbox",
      mcpCalls: t.tb_inflow_mcp ?? "MCP tool calls",
      last24: t.tray_last24 ?? "Last 24 hours",
      hourly: t.tray_legend_hourly ?? "by hour",
      nowEyebrow: t.tray_now_eyebrow ?? "Awaiting approval",
      toastApproved: t.tray_toast_approved ?? "{name} approved",
      actionPending: t.st_loading,
      actionFailed: t.notch_failed,
      view: t.tb_inflow_view ?? "View →",
    },
  };
}

export type NowCardKind = "proposal" | "overdue" | "links";

/** Which single thing the now-card shows: a pending map proposal beats an
 * overdue task beats suggested links; null renders no card (no empty state
 * by design). */
export function pickNowCard(c: {
  proposals: number;
  overdue: number;
  links: number;
}): NowCardKind | null {
  if (c.proposals > 0) return "proposal";
  if (c.overdue > 0) return "overdue";
  if (c.links > 0) return "links";
  return null;
}

/** Keys whose count grew between two status pushes — those badges bump.
 * A first push (no previous) bumps nothing: the panel just appeared. */
export function bumpedKeys<K extends string>(
  prev: Record<K, number> | null,
  next: Record<K, number>,
): K[] {
  if (!prev) return [];
  return (Object.keys(next) as K[]).filter((k) => next[k] > (prev[k] ?? 0));
}

/** Trailing-debounced, rate-limited sender. `push` may be called on every
 * store tick; identical payloads are dropped, and actual sends happen at
 * most once per `minIntervalMs`, always ending on the latest payload. */
export class TraySender {
  private pending: TrayStatusPayload | null = null;
  private lastSentJson = "";
  private lastSentAt = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly send: (p: TrayStatusPayload) => void,
    private readonly debounceMs = 300,
    private readonly minIntervalMs = 1000,
  ) {}

  push(payload: TrayStatusPayload): void {
    this.pending = payload;
    if (this.timer !== null) return; // trailing: latest pending wins
    const wait = Math.max(
      this.debounceMs,
      this.lastSentAt + this.minIntervalMs - Date.now(),
    );
    this.timer = setTimeout(() => this.fire(), wait);
  }

  private fire(): void {
    this.timer = null;
    const payload = this.pending;
    this.pending = null;
    if (!payload) return;
    const json = JSON.stringify(payload);
    if (json === this.lastSentJson) return;
    this.lastSentJson = json;
    this.lastSentAt = Date.now();
    this.send(payload);
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }
}

/** MCP server state cache. The server is global and auto-started; there is
 * no store for it (same situation as ActivityChip, which probes on popover
 * open). Probed at init and re-probed after every actual send — a cheap
 * in-process call — so a toggled server corrects the row within a tick. */
let mcpRunning = false;

/** Today's-inflow cache. Unlike `probeMcp` (a cheap in-process boolean),
 * `inflow_stats` is a real multi-directory filesystem walk — riding it on
 * EVERY send meant a ~1 Hz vault scan for the whole length of a reindex
 * (whose progress ticks change the tray title every send). Throttled hard:
 * inflow moves at file-arrival speed, not progress-tick speed. */
const INFLOW_PROBE_MIN_MS = 120_000;

/** Accept one suggested link by its pair key. The pair is re-derived from the
 * stores rather than carried in the action string: a key that is no longer
 * suggested (already linked, already dismissed, a stale notch push) must be a
 * no-op, not a write. Same three steps as Overview's ✓ — acceptSuggestion,
 * dismiss the pair, rebuild the graph — and no second wikilink writer. */
/** Every suggestion the panel would currently offer, in its own order. */
function pendingLinks(): LinkSuggestion[] {
  const { adjacency } = useVaultStore.getState();
  const { sem, dismissed } = useLinkSuggestStore.getState();
  if (!adjacency || !sem) return [];
  return suggestLinks(adjacency, sem, dismissed, Number.POSITIVE_INFINITY);
}

/** Accept the whole set through the same writer the Overview's 모두 수락 uses,
 * so a partial failure leaves the rest pending rather than half-applied. */
async function acceptAllLinks(): Promise<boolean> {
  const pending = pendingLinks();
  return applyLinkSuggestions(pending, { bulk: true });
}

async function acceptLinkByKey(key: string): Promise<boolean> {
  const { adjacency } = useVaultStore.getState();
  const { sem, dismissed } = useLinkSuggestStore.getState();
  if (!adjacency || !sem) return false;
  const pair = suggestLinks(
    adjacency,
    sem,
    dismissed,
    Number.POSITIVE_INFINITY,
  ).find((s) => s.key === key);
  if (!pair) return false;
  return applyLinkSuggestions([pair]);
}

/** Harvest every listed candidate — the notch's "N개 수확". Prepare the copies
 * in `_inbox/`, then resume their bounded evidence passes, reporting on
 * harvestStore's run slice so the Topbar's activity chip narrates it exactly
 * as it does for a run started from Overview's queue. The queue component
 * owns the selectable variant; the notch processes its current listed batch. */
function isCurrentActionScope(scope: VaultActionScope | undefined): boolean {
  const vault = useVaultStore.getState();
  return !!scope && !vault.isOpeningVault && vault.currentVault?.path === scope.vaultPath && vault.vaultToken === scope.vaultToken;
}

async function harvestListed(scope: VaultActionScope): Promise<boolean> {
  const harvest = useHarvestStore.getState();
  const root = useVaultStore.getState().currentVault?.path;
  const paths = harvest.data?.items.map((c) => c.path) ?? [];
  if (
    !root ||
    harvest.scannedPath !== root ||
    harvest.scannedToken !== scope.vaultToken ||
    paths.length === 0 ||
    harvest.run.phase !== null
  )
    return false;
  harvest.startRun(paths.length);
  let ownedRun = useHarvestStore.getState().run;
  const isCurrent = (): boolean =>
    isCurrentActionScope(scope) && useHarvestStore.getState().run === ownedRun;
  try {
    const origin = Object.freeze(await ipc.agentVaultSession());
    if (!isCurrent()) return false;
    if (origin.vaultPath !== root || !origin.openingToken)
      throw new Error(
        "The native harvest opening differs from the selected vault",
      );
    const res = await harvestSelected(root, paths, {
      origin,
      expectedVaultToken: scope.vaultToken,
      copy: ipc.harvestRun,
      pass: runInboxPass,
      isCurrentVault: (path) => path === scope.vaultPath && isCurrent(),
      onProgress: (done, total) => {
        if (isCurrent()) {
          harvest.setRun(done, total);
          ownedRun = useHarvestStore.getState().run;
        }
      },
    });
    const ok =
      res.completed > 0 &&
      res.pending === 0 &&
      res.failed.length === 0 &&
      res.skipped.length === 0 &&
      !res.cancelled;
    if (isCurrent()) {
      harvest.endRun(ok);
      ownedRun = useHarvestStore.getState().run;
    }
    return ok;
  } catch {
    if (isCurrent()) {
      harvest.endRun(false);
      ownedRun = useHarvestStore.getState().run;
    }
    return false;
  } finally {
    // Refetch so the harvested sessions leave the queue — and the notch's
    // agenda row with them.
    if (isCurrent()) await useHarvestStore.getState().load(root, true);
  }
}

/** A tray menu / panel action, expanded into store calls. Exported for the
 *  tests: the listener above is a one-liner around it. */
export async function applyTrayAction(action: string, scope?: VaultActionScope): Promise<void> {
  if (isVaultTrayAction(action) && !isCurrentActionScope(scope)) throw new Error("Vault action scope is no longer active");
  if (
    action === "overview" ||
    action === "settings" ||
    action === "query" ||
    action === "ingest" ||
    action === "tasks"
  ) {
    useUIStore.getState().setRoute(action);
    return;
  }
  // Sections of Overview, not routes: the suggested-links and reflect tiles
  // both used to send "overview", which parked the user at the page TOP with
  // the thing they clicked far below the fold (and did nothing at all when
  // Overview was already open). Route + focus the named section instead.
  if (action === "links" || action === "reflect") {
    useUIStore.getState().setRoute("overview");
    useUIStore.getState().focusSection(action);
    return;
  }
  // Map-proposal decisions from the tray panel: the panel has no store of
  // its own, so it sends the vault-relative path back and the decision runs
  // through distillStore — the same writer as the popover and the Feedback
  // page, never a second one.
  const approve = action.match(/^proposal-approve:(.+)$/);
  if (approve) {
    if (await useDistillStore.getState().apply(approve[1]) === null) throw new Error("Proposal action did not complete");
    return;
  }
  const reject = action.match(/^proposal-reject:(.+)$/);
  if (reject) {
    if (!(await useDistillStore.getState().dismiss(reject[1]))) throw new Error("Proposal dismissal did not complete");
    return;
  }
  // The notch's other two decisions, same contract as the proposal pair: the
  // secondary surface sends an identity, the main window does the write.
  const acceptLink = action.match(/^links-accept:(.+)$/);
  if (acceptLink) {
    if (!(await acceptLinkByKey(acceptLink[1]))) throw new Error("Link action did not complete");
    return;
  }
  const dismissLink = action.match(/^links-dismiss:(.+)$/);
  if (dismissLink) {
    if (useLinkSuggestStore.getState().busy || !useLinkSuggestStore.getState().dismiss([dismissLink[1]])) throw new Error("Link dismissal did not complete");
    return;
  }
  // The set as one decision — the same two writers the single-row pair uses,
  // over every pending suggestion rather than one key.
  if (action === "links-accept-all") {
    if (!(await acceptAllLinks())) throw new Error("Link action did not complete");
    return;
  }
  if (action === "links-dismiss-all") {
    if (useLinkSuggestStore.getState().busy) throw new Error("Link action is busy");
    const pending = pendingLinks();
    if (pending.length === 0 || !useLinkSuggestStore.getState().dismiss(pending.map((p) => p.key))) throw new Error("Link dismissal did not complete");
    return;
  }
  if (action === "harvest-run") {
    if (!(await harvestListed(scope!))) throw new Error("Harvest did not complete");
    return;
  }
  if (action === "proposals") {
    useUIStore.getState().setFeedbackTab("proposals");
    useUIStore.getState().setRoute("feedback");
    return;
  }
  // Not a route of its own: the quarantine list is a TAB on the Feedback
  // page, so the deep link sets both.
  if (action === "quarantine") {
    useUIStore.getState().setFeedbackTab("quarantine");
    useUIStore.getState().setRoute("feedback");
    return;
  }
  if (action === "distill") {
    const path = useVaultStore.getState().currentVault?.path;
    // Same single entry as the schedule/idle/manual triggers; the guard
    // makes a click during a run a no-op.
    if (!path || await runDistillGuarded(path) === null || useDistillRunStore.getState().outcome === "error") throw new Error("Distill did not complete");
  }
}

/** Wire the tray: store subscriptions → debounced update_tray_status calls,
 * plus the menu-action listener. Returns a cleanup. Call once from App. */
export function initTrayIntegration(): () => void {
  let cancelled = false;
  let inflowStats: InflowStats | null = null;
  let inflowProbedAt = 0;
  let dueCounts = { dueToday: 0, overdue: 0 };
  let dueProbedAt = 0;
  const inflowFlights = new Map<string, object>();
  const dueFlights = new Map<string, object>();
  const probeScope = (): VaultActionScope | null => {
    const vault = useVaultStore.getState();
    return vault.currentVault && !vault.isOpeningVault
      ? { vaultPath: vault.currentVault.path, vaultToken: vault.vaultToken } : null;
  };
  let probeScopeKey = vaultActionScopeKey(probeScope());
  const sender = new TraySender((p) => {
    void ipc
      .updateTrayStatus(p)
      .then(() => {
        if (cancelled) return;
        probeMcp();
        if (Date.now() - inflowProbedAt >= INFLOW_PROBE_MIN_MS) probeInflow();
        if (Date.now() - dueProbedAt >= INFLOW_PROBE_MIN_MS) probeDue();
      })
      .catch(() => {
        /* plain-browser dev: no Tauri backend */
      });
  });

  // A link batch's failure, held until the next batch starts: ActivityChip
  // resets noticeStore.lastProgressOk right after showing it, and the push
  // that carries the run's end is debounced past that reset.
  let linksFailed = false;

  const recompute = (): void => {
    if (cancelled) return;
    const notice = useNoticeStore.getState();
    if (notice.progress) linksFailed = false;
    else if (!notice.lastProgressOk) linksFailed = true;
    const distill = useDistillRunStore.getState();
    const reindex = useReindexStore.getState();
    const query = useQueryStore.getState();
    const vault = useVaultStore.getState();
    const links = useLinkSuggestStore.getState();
    const reflect = useReflectStore.getState();
    const settings = useSettingsStore.getState().settings;
    const t = STRINGS[useUIStore.getState().lang];
    const pendingLinks =
      vault.adjacency && links.sem
        ? pendingLinkCount(vault.adjacency, links.sem, links.dismissed)
        : 0;
    // The notch's agenda, from the same three stores the surfaces above read.
    // Built HERE and pushed: the notch webview is a third JS context whose
    // own copies of these stores are always empty (no App, no scheduler).
    const agenda = notchAgenda({
      proposals: useDistillStore.getState().proposals,
      adjacency: vault.adjacency,
      sem: links.sem,
      dismissed: links.dismissed,
      harvestItems: useHarvestStore.getState().scannedPath === vault.currentVault?.path && useHarvestStore.getState().scannedToken === vault.vaultToken
        ? useHarvestStore.getState().data?.items.length ?? 0 : 0,
    });
    sender.push(
      buildTrayStatus(
        {
          actionScope: vault.currentVault && !vault.isOpeningVault
            ? { vaultPath: vault.currentVault.path, vaultToken: vault.vaultToken } : null,
          askBusy: query.busy,
          distillRunning: distill.running,
          distillStep: distill.step,
          reflectRunning: reflect.stage === "running",
          reflectFindings: reflect.suggestions.length,
          reindexStage: reindex.stage,
          reindexDone: reindex.done,
          reindexTotal: reindex.total,
          pendingLinks,
          mapProposals: pendingMapProposals(
            useDistillStore.getState().proposals,
          ),
          applyingProposals: useDistillStore.getState().applying.size,
          mapsNeedWriter: settingsNeedWriter(settings),
          mcpRunning,
          inflow: inflowStats,
          sweepAt: getLastSweepAt(),
          sweepStatus: getLastSweepReceipt()?.finishedAt ? getLastSweepReceipt()?.status : undefined,
          autoImportMin: settings?.auto_import_enabled
            ? settings.auto_import_interval_min
            : null,
          dueToday: dueCounts.dueToday,
          overdue: dueCounts.overdue,
          agenda,
          harvest: useHarvestStore.getState().run,
          progress: notice.progress,
          failed: failedKinds({
            harvest: useHarvestStore.getState().outcome,
            distill: distill.outcome,
            reflect: reflect.stage,
            reindex: reindex.stage,
            linksFailed,
          }),
        },
        t,
      ),
    );
  };

  const probeMcp = (): void => {
    void ipc
      .mcpInfo()
      .then((i) => {
        if (i.running !== mcpRunning) {
          mcpRunning = i.running;
          recompute();
        }
      })
      .catch(() => {
        /* plain-browser dev: no Tauri backend */
      });
  };

  const probeDue = (): void => {
    const scope = probeScope();
    if (!scope || cancelled) return;
    const key = vaultActionScopeKey(scope);
    if (dueFlights.has(key)) return;
    const owner = {};
    dueFlights.set(key, owner);
    dueProbedAt = Date.now();
    void ipc
      .scanTasks(scope.vaultPath)
      .then((tasks) => {
        if (cancelled || !isCurrentActionScope(scope)) return;
        const digest = buildDigest(tasks);
        const next = {
          dueToday: digest?.dueToday ?? 0,
          overdue: digest?.overdue ?? 0,
        };
        if (
          next.dueToday !== dueCounts.dueToday ||
          next.overdue !== dueCounts.overdue
        ) {
          dueCounts = next;
          recompute();
        }
      })
      .catch(() => {
        if (!cancelled && isCurrentActionScope(scope)) {
          console.warn("Tray due-task read failed; a later status update can retry.");
        }
      }).finally(() => {
        if (dueFlights.get(key) === owner) dueFlights.delete(key);
      });
  };

  const probeInflow = (): void => {
    const scope = probeScope();
    if (!scope || cancelled) return;
    const key = vaultActionScopeKey(scope);
    if (inflowFlights.has(key)) return;
    const owner = {};
    inflowFlights.set(key, owner);
    inflowProbedAt = Date.now();
    void ipc
      .inflowStats(scope.vaultPath)
      .then((s) => {
        if (cancelled || !isCurrentActionScope(scope)) return;
        if (JSON.stringify(s) !== JSON.stringify(inflowStats)) {
          inflowStats = s;
          recompute();
        }
      })
      .catch(() => {
        if (!cancelled && isCurrentActionScope(scope)) {
          console.warn("Tray inflow read failed; a later status update can retry.");
        }
      }).finally(() => {
        if (inflowFlights.get(key) === owner) inflowFlights.delete(key);
      });
  };

  const unsubs = [
    useDistillRunStore.subscribe(recompute),
    useReindexStore.subscribe(recompute),
    useQueryStore.subscribe(recompute),
    useUIStore.subscribe(recompute),
    useVaultStore.subscribe(() => {
      const key = vaultActionScopeKey(probeScope());
      if (key !== probeScopeKey) {
        probeScopeKey = key;
        inflowStats = null;
        inflowProbedAt = 0;
        dueCounts = { dueToday: 0, overdue: 0 };
        dueProbedAt = 0;
      }
      // The vault opens AFTER init — the init-time probe returned early with
      // no path, so the first open must trigger the real one immediately or
      // the panel's inflow section sits empty for the whole throttle window.
      if (inflowStats === null) probeInflow();
      if (dueProbedAt === 0) probeDue();
      recompute();
    }),
    useLinkSuggestStore.subscribe(recompute),
    useReflectStore.subscribe(recompute),
    useDistillStore.subscribe(recompute),
    // The harvest queue's candidate count is the notch agenda's third source,
    // and its run slice a running row.
    useHarvestStore.subscribe(recompute),
    useNoticeStore.subscribe(recompute),
  ];

  // Tray menu actions: route jumps and the guarded distill entry. Rust has
  // already shown/focused the window before emitting.
  let unlisten: (() => void) | null = null;
  void listen<string | TrayActionEnvelope>(TRAY_ACTION_EVENT, (e) => {
    const request = e.payload;
    if (typeof request !== "string" && !isTrayActionEnvelope(request)) {
      console.error("tray: invalid action message");
      return;
    }
    const action = typeof request === "string" ? request : request.action;
    void applyTrayAction(action, typeof request === "string" ? undefined : request.scope).then(() => {
      if (isVaultTrayAction(action) && (typeof request === "string" || !isCurrentActionScope(request.scope))) throw new Error("Vault action scope changed before completion");
      if (typeof request !== "string" && request.requestId) return emit(TRAY_ACTION_RESULT_EVENT, { requestId: request.requestId, ok: true });
    }).catch(() => {
      if (typeof request !== "string" && request.requestId) void emit(TRAY_ACTION_RESULT_EVENT, { requestId: request.requestId, ok: false }).catch(() => console.error("tray: action acknowledgement failed"));
      else console.error("tray: action did not complete");
    });
  })
    .then((u) => {
      if (cancelled) u();
      else unlisten = u;
    })
    .catch(() => {
      /* plain-browser dev: no Tauri event bus */
    });

  probeMcp();
  probeInflow();
  recompute();

  return () => {
    cancelled = true;
    if (unlisten) unlisten();
    for (const u of unsubs) u();
    sender.dispose();
  };
}
