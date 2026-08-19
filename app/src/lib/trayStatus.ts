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
import type { InflowStats, TrayRunningRow, TrayStatusPayload } from "./ipc";
import { STRINGS } from "./i18n";
import type { Strings } from "./i18n";
import { inflowLines } from "./inflow";
import { pendingLinkCount } from "./linkSuggestions";
import { runDistillGuarded } from "./distill";
import { stepLabel } from "../components/ActivityChip";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { useQueryStore } from "../stores/queryStore";
import { useReindexStore } from "../stores/reindexStore";
import { useDistillRunStore } from "../stores/distillRunStore";
import type { DistillRunStep } from "../stores/distillRunStore";
import { useLinkSuggestStore } from "../stores/linkSuggestStore";

/** Emitted by Rust when a tray menu action row is clicked. */
export const TRAY_ACTION_EVENT = "myco://tray-action";

/** Everything the payload is derived from, decoupled from the stores so the
 * pure builders below are unit-testable. */
export interface TraySnapshot {
  askBusy: boolean;
  distillRunning: boolean;
  distillStep: DistillRunStep | null;
  reindexStage: "idle" | "loading-model" | "indexing" | "done" | "error";
  reindexDone: number;
  reindexTotal: number;
  pendingLinks: number;
  mcpRunning: boolean;
  /** Today's inflow, or null before/without a probe — hides the section. */
  inflow: InflowStats | null;
}

/** Icon-side title: nothing when idle, the reindex percent when indexing is
 * the only runner (the one activity with a meaningful %), the running count
 * for 2+. A single distill/ask runner shows no number — its "number" is a
 * step name / elapsed time, too long for the menu bar. */
export function trayTitle(s: TraySnapshot): string | null {
  const reindexBusy =
    s.reindexStage === "loading-model" || s.reindexStage === "indexing";
  const count =
    (s.askBusy ? 1 : 0) + (s.distillRunning ? 1 : 0) + (reindexBusy ? 1 : 0);
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
export function buildTrayStatus(s: TraySnapshot, t: Strings): TrayStatusPayload {
  const running: TrayRunningRow[] = [];
  if (s.askBusy) running.push({ kind: "ask", text: t.nav_query });
  if (s.distillRunning) {
    running.push({
      kind: "distill",
      text: `${t.set_distill_running ?? "Distilling…"} — ${stepLabel(s.distillStep, t)}`,
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
  const lines = s.inflow ? inflowLines(s.inflow, t) : null;
  return {
    running,
    runningHeader: t.tray_hdr_running ?? "Now working on",
    waitingHeader: t.tray_hdr_waiting ?? "Waiting",
    title: trayTitle(s),
    suggested: (t.tb_activity_links ?? "{n} suggested links").replace(
      "{n}",
      String(s.pendingLinks),
    ),
    mcp: s.mcpRunning
      ? (t.tb_activity_mcp_on ?? "MCP server running")
      : (t.tb_activity_mcp_off ?? "MCP server off"),
    inflow:
      lines && s.inflow
        ? {
            ...lines,
            hourlyFiles: s.inflow.hourlyFiles,
            hourlyMcp: s.inflow.hourlyMcp,
          }
        : null,
    ask: t.quick_ask,
    distill: t.set_distill_run_now ?? "Distill now",
    open: t.tray_open ?? "Open myco",
    quit: t.tray_quit ?? "Quit myco",
  };
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

/** Wire the tray: store subscriptions → debounced update_tray_status calls,
 * plus the menu-action listener. Returns a cleanup. Call once from App. */
export function initTrayIntegration(): () => void {
  const sender = new TraySender((p) => {
    void ipc
      .updateTrayStatus(p)
      .then(() => {
        probeMcp();
        if (Date.now() - inflowProbedAt >= INFLOW_PROBE_MIN_MS) probeInflow();
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
          reindexStage: reindex.stage,
          reindexDone: reindex.done,
          reindexTotal: reindex.total,
          pendingLinks,
          mcpRunning,
          inflow: inflowStats,
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
    useVaultStore.subscribe(recompute),
    useLinkSuggestStore.subscribe(recompute),
  ];

  // Tray menu actions: route jumps and the guarded distill entry. Rust has
  // already shown/focused the window before emitting.
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  void listen<string>(TRAY_ACTION_EVENT, (e) => {
    const action = e.payload;
    if (action === "overview" || action === "settings" || action === "query") {
      useUIStore.getState().setRoute(action);
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
