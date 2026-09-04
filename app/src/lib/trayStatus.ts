// Frontend half of the macOS menu bar tray: watches the same stores the
// Topbar ActivityChip renders from, and pushes a pre-translated snapshot to
// Rust (tray::update_tray_status) whenever the aggregate state changes.
//
// The Rust side stores strings only — every label here is translated with the
// app's own lang setting before it crosses the IPC boundary. Sends are
// debounced (trailing 300 ms) and progress ticks are throttled to at most one
// send per second, so a reindex over hundreds of pages never floods the menu.

import { listen } from "@tauri-apps/api/event";
import { ipc } from "./ipc";
import type {
  InflowStats,
  TrayPanelPayload,
  TrayRunningRow,
  TrayStatusPayload,
} from "./ipc";
import { STRINGS } from "./i18n";
import type { Strings } from "./i18n";
import { inflowLines } from "./inflow";
import { getLastSweepAt } from "./autoImport";
import { buildDigest } from "./taskNotify";
import { pendingLinkCount } from "./linkSuggestions";
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
import { useLinkSuggestStore } from "../stores/linkSuggestStore";
import { useReflectStore } from "../stores/reflectStore";
import { useDistillStore, pendingMapProposals } from "../stores/distillStore";
import type { ProposalMeta } from "../stores/distillStore";
import { useSettingsStore } from "../stores/settingsStore";

/** Emitted by Rust when a tray menu action row is clicked. */
export const TRAY_ACTION_EVENT = "myco://tray-action";

/** Everything the payload is derived from, decoupled from the stores so the
 * pure builders below are unit-testable. */
export interface TraySnapshot {
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
  /** Active query provider; "builtin-local" can't draft a map, which the rows
   *  say out loud instead of letting an approval sit there silently. */
  queryProvider: string;
  mcpRunning: boolean;
  /** Today's inflow, or null before/without a probe — hides the section. */
  inflow: InflowStats | null;
  /** Last session-sweep completion (ms epoch) for the sessions sub-line. */
  sweepAt: number | null;
  /** Auto-import interval (minutes) when enabled; null when off. */
  autoImportMin: number | null;
  /** Open tasks due today / overdue (throttled scan; 0/0 before a probe). */
  dueToday: number;
  overdue: number;
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
    (reindexBusy ? 1 : 0);
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
  const lines = s.inflow
    ? inflowLines(s.inflow, t, {
        sweepAt: s.sweepAt,
        autoImportMin: s.autoImportMin,
      })
    : null;
  return {
    running,
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
    proposalNote:
      s.queryProvider === "builtin-local"
        ? (t.tb_activity_map_wait ??
          "Approving is saved, but the draft needs a query model.")
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

/** Numbers + labels the glass tiles render (tray v3). Kept apart from the
 * pre-formatted rows above because the tiles put the count in its own badge
 * and animate it when it grows, which a baked "6 suggested links" string
 * cannot do. Rust passes this block through untouched. */
export function trayPanel(s: TraySnapshot, t: Strings): TrayPanelPayload {
  return {
    mcpRunning: s.mcpRunning,
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
let inflowStats: InflowStats | null = null;
let inflowProbedAt = 0;
const INFLOW_PROBE_MIN_MS = 120_000;

/** Due-task counts, same throttle story as inflow: `scan_tasks` walks the
 * vault, so it rides the send loop no more than once per window. */
let dueCounts = { dueToday: 0, overdue: 0 };
let dueProbedAt = 0;

/** Wire the tray: store subscriptions → debounced update_tray_status calls,
 * plus the menu-action listener. Returns a cleanup. Call once from App. */
export function initTrayIntegration(): () => void {
  const sender = new TraySender((p) => {
    void ipc
      .updateTrayStatus(p)
      .then(() => {
        probeMcp();
        if (Date.now() - inflowProbedAt >= INFLOW_PROBE_MIN_MS) probeInflow();
        if (Date.now() - dueProbedAt >= INFLOW_PROBE_MIN_MS) probeDue();
      })
      .catch(() => {
        /* plain-browser dev: no Tauri backend */
      });
  });

  const recompute = (): void => {
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
    sender.push(
      buildTrayStatus(
        {
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
          queryProvider: settings?.query_provider ?? "",
          mcpRunning,
          inflow: inflowStats,
          sweepAt: getLastSweepAt(),
          autoImportMin: settings?.auto_import_enabled
            ? settings.auto_import_interval_min
            : null,
          dueToday: dueCounts.dueToday,
          overdue: dueCounts.overdue,
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
    const path = useVaultStore.getState().currentVault?.path;
    if (!path) return;
    dueProbedAt = Date.now();
    void ipc
      .scanTasks(path)
      .then((tasks) => {
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
        /* plain-browser dev: no Tauri backend */
      });
  };

  const probeInflow = (): void => {
    const path = useVaultStore.getState().currentVault?.path;
    if (!path) return;
    inflowProbedAt = Date.now();
    void ipc
      .inflowStats(path)
      .then((s) => {
        if (JSON.stringify(s) !== JSON.stringify(inflowStats)) {
          inflowStats = s;
          recompute();
        }
      })
      .catch(() => {
        /* plain-browser dev: no Tauri backend */
      });
  };

  const unsubs = [
    useDistillRunStore.subscribe(recompute),
    useReindexStore.subscribe(recompute),
    useQueryStore.subscribe(recompute),
    useUIStore.subscribe(recompute),
    useVaultStore.subscribe(() => {
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
  ];

  // Tray menu actions: route jumps and the guarded distill entry. Rust has
  // already shown/focused the window before emitting.
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  void listen<string>(TRAY_ACTION_EVENT, (e) => {
    const action = e.payload;
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
    // Map-proposal decisions from the tray panel: the panel has no store of
    // its own, so it sends the vault-relative path back and the decision runs
    // through distillStore — the same writer as the popover and the Feedback
    // page, never a second one.
    const approve = action.match(/^proposal-approve:(.+)$/);
    if (approve) {
      void useDistillStore.getState().apply(approve[1]);
      return;
    }
    const reject = action.match(/^proposal-reject:(.+)$/);
    if (reject) {
      void useDistillStore.getState().dismiss(reject[1]);
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
      if (path) void runDistillGuarded(path);
    }
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
