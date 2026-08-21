// Topbar activity system — the right-side chip + popover that replaced the
// old BusyJobsChip. Zero running activities → no chip at all; exactly one →
// its own chip (breathing icon + name + live number); two or more → one
// collapsed "활동 N" chip. Standing states (suggested links pending, MCP
// server) never count toward the badge — they only appear inside the popover.
//
// The popover renders through the same portal + viewport-clamp mechanism as
// the Topbar model popover (computeModelPopPos) — anchoring it inside
// .topbar would clip it, see the ModelChip comment there.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { JSX } from "react";
import type { Strings } from "../lib/i18n";
import { ipc } from "../lib/ipc";
import type { InflowStats, TaskItem } from "../lib/ipc";
import { formatTicker } from "../lib/time";
import { inflowLines } from "../lib/inflow";
import { getLastSweepAt } from "../lib/autoImport";
import { requestDistillStop } from "../lib/distill";
import { pendingLinkCount } from "../lib/linkSuggestions";
import { dueOpen } from "../lib/taskNotify";
import { parseTaskMeta } from "../lib/taskLine";
import { writeTaskStatus } from "../lib/taskWrite";
import { computeModelPopPos } from "./Topbar";
import ActivityPanel, {
  ActivityIcon,
  buildInflowRows,
  buildMapProposalRows,
} from "./ActivityPanel";
import type {
  ActivityIconName,
  MapProposalRowContent,
  PanelRow,
  PanelSection,
} from "./ActivityPanel";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { useQueryStore } from "../stores/queryStore";
import { useReindexStore } from "../stores/reindexStore";
import { useDistillRunStore } from "../stores/distillRunStore";
import { useDistillStore, pendingMapProposals } from "../stores/distillStore";
import type { ProposalMeta } from "../stores/distillStore";
import type { DistillRunStep } from "../stores/distillRunStore";
import { useLinkSuggestStore } from "../stores/linkSuggestStore";
import { useReflectStore } from "../stores/reflectStore";
import { useSettingsStore } from "../stores/settingsStore";

export { ActivityIcon };
export type { ActivityIconName };

export interface RunningActivity {
  icon: ActivityIconName;
  label: string;
  /** Live number/step beside the name ("218/302", the distill step, elapsed). */
  detail: string;
}

export type ActivityChipMode<T extends { icon: ActivityIconName }> =
  | { kind: "none" }
  | { kind: "single"; activity: T }
  | { kind: "multi"; count: number; icon: ActivityIconName };

/** 0 running → no chip; 1 → that activity's own chip; 2+ → the collapsed
 * count chip (icon = the highest-priority runner). Callers pass RUNNING
 * activities only — standing states never reach this. Pure; unit-tested. */
export function chipMode<T extends { icon: ActivityIconName }>(
  running: T[],
): ActivityChipMode<T> {
  if (running.length === 0) return { kind: "none" };
  if (running.length === 1) return { kind: "single", activity: running[0] };
  return { kind: "multi", count: running.length, icon: running[0].icon };
}

/** Human label for a distill chain phase — shared with the tray menu
 * (lib/trayStatus.ts) so both surfaces name the step identically. */
export function stepLabel(step: DistillRunStep | null, t: Strings): string {
  if (step === "digest") return t.set_distill_step_digest ?? "the session digest";
  if (step === "weekly") return t.set_distill_step_weekly ?? "the weekly rollup";
  if (step === "monthly") return t.set_distill_step_monthly ?? "the monthly rollup";
  if (step === "ingest") return t.set_distill_step_ingest ?? "the full-tier ingest";
  if (step === "maps") return t.set_distill_step_maps ?? "the map drafts";
  return t.set_distill_step_run ?? "the core pass";
}

/** How many pending map proposals either activity surface lists before the
 * "+N more" row takes over (both surfaces cap identically). */
export const MAP_ROW_CAP = 5;

/** The two lines of a map-proposal row: the cluster label and "Draft topic
 * map · N notes". Shared with the tray payload builder (lib/trayStatus.ts) so
 * the tray panel shows the very same text, pre-translated. */
export function mapRowContent(
  p: ProposalMeta,
  t: Strings,
): MapProposalRowContent {
  return {
    path: p.path,
    label: p.cluster ?? p.title,
    sub: `${t.pf_kind_draft_map ?? "Draft topic map"} · ${(
      t.tb_activity_map_notes ?? "{n} notes"
    ).replace("{n}", String(p.members?.length ?? 0))}`,
  };
}

export default function ActivityChip({ t }: { t: Strings }): JSX.Element | null {
  const askBusy = useQueryStore((s) => s.busy);
  const askStartedAt = useQueryStore((s) => s.startedAt);
  const turns = useQueryStore((s) => s.turns);
  const distillRunning = useDistillRunStore((s) => s.running);
  const distillStep = useDistillRunStore((s) => s.step);
  const reflectRunning = useReflectStore((s) => s.stage === "running");
  // Findings from the last reflect run — a STANDING count, like suggested
  // links: never part of the chip badge, and NOT gated on `seen` (the panel
  // lives on Overview, so a seen-gate hid the row as soon as the app landed
  // there and the tray never showed it).
  const reflectFindings = useReflectStore((s) => s.suggestions.length);
  const reindexStage = useReindexStore((s) => s.stage);
  const reindexDone = useReindexStore((s) => s.done);
  const reindexTotal = useReindexStore((s) => s.total);
  const adjacency = useVaultStore((s) => s.adjacency);
  const vaultPath = useVaultStore((s) => s.currentVault?.path);
  const sem = useLinkSuggestStore((s) => s.sem);
  const dismissed = useLinkSuggestStore((s) => s.dismissed);
  const refreshSem = useLinkSuggestStore((s) => s.refresh);
  const settings = useSettingsStore((s) => s.settings);
  const setRoute = useUIStore((s) => s.setRoute);
  const setFeedbackTab = useUIStore((s) => s.setFeedbackTab);
  // Quarantined items awaiting review — a standing count from the same
  // distill_status the Settings tab and the sidebar badge read.
  const quarantined = useDistillStore((s) => s.status?.quarantined ?? 0);
  // Pending map proposals, approvable right here (ROADMAP P0) — the same
  // store actions the Feedback page's buttons call, so there is one writer.
  const proposals = useDistillStore((s) => s.proposals);
  const approveProposal = useDistillStore((s) => s.apply);
  const rejectProposal = useDistillStore((s) => s.dismiss);

  const reindexBusy =
    reindexStage === "loading-model" || reindexStage === "indexing";
  const anyBusy = askBusy || distillRunning || reflectRunning || reindexBusy;

  const [open, setOpen] = useState(false);
  const [popPos, setPopPos] = useState<ReturnType<typeof computeModelPopPos> | null>(
    null,
  );
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // MCP server state, probed when the popover opens (it is global and
  // auto-started; no store holds it — same source the Settings MCP tab reads).
  const [mcpRunning, setMcpRunning] = useState<boolean | null>(null);
  // Today's inflow, fetched when the popover opens (no polling) — the same
  // open-probe pattern as the MCP row above.
  const [inflow, setInflow] = useState<InflowStats | null>(null);
  // Same latch the Settings distill tab keeps: "stop already requested".
  const [stopping, setStopping] = useState(false);
  // Due-today + overdue open tasks, loaded when the popover opens (and after a
  // check-off) — no store and no polling, the popover is the only consumer.
  // Tasks are a standing state: they never count toward the chip badge.
  const [dueTasks, setDueTasks] = useState<TaskItem[] | null>(null);

  const loadTasks = useCallback(async (): Promise<void> => {
    if (!vaultPath) return;
    try {
      setDueTasks(dueOpen(await ipc.scanTasks(vaultPath)));
    } catch {
      // A failed scan just hides the block — a popover is no place for errors.
      setDueTasks([]);
    }
  }, [vaultPath]);

  useEffect(() => {
    if (open) void loadTasks();
  }, [open, loadTasks]);

  /** Check a task off through the same write path as the Tasks page checkbox
   * (taskWrite.ts). Optimistic: the row leaves immediately; any failure or
   * stale line rescans, which restores it. */
  const checkOff = async (task: TaskItem): Promise<void> => {
    if (!vaultPath) return;
    setDueTasks((s) => (s ? s.filter((x) => x !== task) : s));
    try {
      if ((await writeTaskStatus(vaultPath, task, "done")) === "stale") {
        await loadTasks();
      }
    } catch {
      await loadTasks();
    }
  };

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!askBusy) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [askBusy]);

  useEffect(() => {
    if (!distillRunning) setStopping(false);
  }, [distillRunning]);

  useEffect(() => {
    if (adjacency) void refreshSem(adjacency);
  }, [adjacency, refreshSem]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    ipc
      .mcpInfo()
      .then((i) => alive && setMcpRunning(i.running))
      .catch(() => alive && setMcpRunning(false));
    if (vaultPath) {
      ipc
        .inflowStats(vaultPath)
        .then((s) => alive && setInflow(s))
        .catch(() => alive && setInflow(null));
    }
    return () => {
      alive = false;
    };
  }, [open, vaultPath]);

  // Outside-click / Escape / resize handling — same shape as ModelChip's
  // (the popover portals to <body>, so both refs must be checked).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target)) return;
      if (popRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onResize = () => {
      const r = wrapRef.current?.getBoundingClientRect();
      if (r) setPopPos(computeModelPopPos(r));
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  // The chip vanishes with the last running activity — never leave the
  // popover orphaned on screen without its anchor.
  useEffect(() => {
    if (!anyBusy) setOpen(false);
  }, [anyBusy]);

  const pending = useMemo(
    () => (adjacency && sem ? pendingLinkCount(adjacency, sem, dismissed) : 0),
    [adjacency, sem, dismissed],
  );

  // Priority (most to least urgent to surface when collapsed): Ask — the
  // user is actively waiting on it — then distill, reflect, then reindex.
  // Reflect borrows the distill icon: the set has no reflect art, and reflect
  // is distill's read-only sibling (a whole-vault background pass), where the
  // ask icon means "a human is waiting on this answer".
  const running: RunningActivity[] = [];
  if (askBusy) {
    running.push({
      icon: "ask",
      label: t.nav_query,
      detail: askStartedAt ? formatTicker(now - askStartedAt) : "",
    });
  }
  if (distillRunning) {
    running.push({
      icon: "distill",
      label: t.set_distill_running ?? "Distilling…",
      detail: stepLabel(distillStep, t),
    });
  }
  if (reflectRunning) {
    running.push({
      icon: "distill",
      label: t.rf_running_label ?? "Reflect running…",
      detail: "",
    });
  }
  if (reindexBusy) {
    running.push({
      icon: "indexing",
      label: t.s_embeddings_indexing ?? "Indexing…",
      detail:
        reindexStage === "loading-model"
          ? (t.s_embeddings_loading_model ?? "Loading model…")
          : `${reindexDone}/${reindexTotal}`,
    });
  }

  const mode = chipMode(running);
  if (mode.kind === "none") return null;

  const openPopover = (): void => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (r) setPopPos(computeModelPopPos(r));
    setOpen(true);
  };

  const askQuestion = turns[turns.length - 1]?.q.split("\n")[0] ?? "";

  const jump = (
    route: "query" | "overview" | "settings" | "tasks" | "ingest" | "feedback",
  ): void => {
    setOpen(false);
    setRoute(route);
  };

  // Popover body, expressed as the shared panel's sections (ActivityPanel is
  // the same component the tray popover window renders).
  const runningRows: PanelRow[] = [];
  if (askBusy) {
    runningRows.push({
      key: "ask",
      icon: "ask",
      iconActive: true,
      onClick: () => jump("query"),
      main: (
        <>
          <b>{t.nav_query}</b>
          {askQuestion ? (
            <span className="activity-row-sub">{askQuestion}</span>
          ) : null}
        </>
      ),
      trailing: (
        <span className="activity-num">
          {askStartedAt ? formatTicker(now - askStartedAt) : ""}
        </span>
      ),
    });
  }
  if (distillRunning) {
    runningRows.push({
      key: "distill",
      icon: "distill",
      iconActive: true,
      main: (
        <>
          <b>{t.set_distill_running ?? "Distilling…"}</b>
          <span className="activity-row-sub">{stepLabel(distillStep, t)}</span>
        </>
      ),
      trailing: (
        <button
          className="btn activity-stop"
          disabled={stopping}
          onClick={() => {
            if (vaultPath) {
              requestDistillStop(vaultPath);
              setStopping(true);
            }
          }}
        >
          <ActivityIcon name="stop" size={13} />
          {stopping
            ? (t.set_distill_stopping ?? "Stopping after the current step…")
            : (t.set_distill_stop ?? "Stop")}
        </button>
      ),
    });
  }
  if (reflectRunning) {
    runningRows.push({
      key: "reflect",
      icon: "distill",
      iconActive: true,
      onClick: () => jump("overview"),
      main: <b>{t.rf_running_label ?? "Reflect running…"}</b>,
    });
  }
  if (reindexBusy) {
    runningRows.push({
      key: "indexing",
      icon: "indexing",
      iconActive: true,
      main: (
        <>
          <b>{t.s_embeddings_indexing ?? "Indexing…"}</b>
          {reindexStage === "indexing" ? (
            <progress value={reindexDone} max={reindexTotal || 1} />
          ) : (
            <span className="activity-row-sub">
              {t.s_embeddings_loading_model ?? "Loading model…"}
            </span>
          )}
        </>
      ),
      trailing:
        reindexStage === "indexing" ? (
          <span className="activity-num">
            {reindexDone}/{reindexTotal}
          </span>
        ) : undefined,
    });
  }

  const taskRows: PanelRow[] = (dueTasks ?? []).slice(0, 5).map((task) => ({
    key: `${task.page}:${task.line}`,
    leading: (
      <button
        type="button"
        role="checkbox"
        aria-checked={false}
        aria-label={task.text}
        onClick={() => void checkOff(task)}
        style={{
          padding: 0,
          cursor: "pointer",
          width: 15,
          height: 15,
          borderRadius: 3,
          flexShrink: 0,
          border: "1.5px solid var(--ink-3)",
          background: "transparent",
        }}
      />
    ),
    main: (
      <span className="activity-row-sub">{parseTaskMeta(task.text).title}</span>
    ),
    trailing: (
      <span
        className="muted"
        style={{
          fontSize: 11,
          flexShrink: 0,
          maxWidth: "35%",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {task.stem}
      </span>
    ),
  }));
  if (dueTasks && dueTasks.length > 5) {
    taskRows.push({
      key: "tasks-more",
      onClick: () => jump("tasks"),
      main: (
        <span className="muted">
          {(t.tb_activity_tasks_more ?? "+{n} more").replace(
            "{n}",
            String(dueTasks.length - 5),
          )}
        </span>
      ),
    });
  }

  // Today's inflow — present whenever a probe succeeded (zeros render as
  // "+0"); absent only before/without a successful fetch. Rows come from the
  // shared builder so this popover and the tray panel stay structurally
  // identical.
  const lines = inflow
    ? inflowLines(inflow, t, {
        sweepAt: getLastSweepAt(),
        autoImportMin: settings?.auto_import_enabled
          ? settings.auto_import_interval_min
          : null,
      })
    : null;
  const inflowRows: PanelRow[] =
    inflow && lines
      ? buildInflowRows({
          sessions: {
            label: lines.sessions,
            sub: lines.sessionsSub,
            count: lines.sessionsCount,
          },
          mcp: { label: lines.mcp, sub: lines.mcpSub, count: lines.mcpCount },
          inbox: {
            label: lines.inbox,
            sub: lines.inboxSub,
            count: lines.inboxCount,
          },
          inboxView: lines.inboxView,
          onInboxView: () => jump("ingest"),
          sparkCaption: lines.sparkCaption,
          hourlyFiles: inflow.hourlyFiles,
          hourlyMcp: inflow.hourlyMcp,
        })
      : [];

  // Pending map proposals: approve/reject inline (the P0 the Feedback-page
  // hunt used to be), capped so a big backlog can't push the rest of the
  // panel off screen — the rest is one click away on the Feedback page.
  const maps = pendingMapProposals(proposals);
  const mapRows = buildMapProposalRows({
    items: maps.slice(0, MAP_ROW_CAP).map((p) => mapRowContent(p, t)),
    approveLabel: t.pf_approve ?? "Approve",
    rejectLabel: t.pf_dismiss ?? "Dismiss",
    onApprove: (path) => void approveProposal(path),
    onReject: (path) => void rejectProposal(path),
    more:
      maps.length > MAP_ROW_CAP
        ? (t.tb_activity_tasks_more ?? "+{n} more").replace(
            "{n}",
            String(maps.length - MAP_ROW_CAP),
          )
        : "",
    onMore: () => {
      setFeedbackTab("proposals");
      jump("feedback");
    },
    // Stated, not hidden: on builtin-local the approval lands on disk but the
    // draft-map step (applyApprovedDraftMaps) early-returns no-provider.
    note:
      settings?.query_provider === "builtin-local"
        ? (t.tb_activity_map_wait ??
          "Approving is saved, but the draft needs a query model.")
        : "",
  });

  const sections: PanelSection[] = [
    {
      key: "running",
      header: t.tb_activity_running ?? "Running",
      rows: runningRows,
    },
    { key: "tasks", header: t.tb_activity_tasks ?? "Tasks due", rows: taskRows },
    { key: "inflow", header: lines?.header, rows: inflowRows },
    {
      key: "standing",
      rows: [
        // Decisions first: these rows are the only ones with actions on them.
        ...mapRows,
        // Reflect findings nobody has looked at yet — the panel that shows
        // them lives on Overview, which is where the row goes.
        ...(reflectFindings > 0
          ? [
              {
                key: "reflect",
                icon: "distill" as ActivityIconName,
                onClick: () => jump("overview"),
                main: (t.tb_activity_reflect ?? "{n} reflect suggestions").replace(
                  "{n}",
                  String(reflectFindings),
                ),
              },
            ]
          : []),
        // Quarantined inflow nobody has reviewed yet (ROADMAP P0) — routes to
        // the Feedback page's quarantine tab, the only place to resolve them.
        ...(quarantined > 0
          ? [
              {
                key: "quarantine",
                icon: "distill" as ActivityIconName,
                onClick: () => {
                  setFeedbackTab("quarantine");
                  jump("feedback");
                },
                main: (t.tb_activity_quarantine ?? "{n} awaiting review").replace(
                  "{n}",
                  String(quarantined),
                ),
              },
            ]
          : []),
        {
          key: "links",
          icon: "link",
          onClick: () => jump("overview"),
          main: (t.tb_activity_links ?? "{n} suggested links").replace(
            "{n}",
            String(pending),
          ),
        },
        {
          key: "mcp",
          icon: "mcp",
          onClick: () => jump("settings"),
          main:
            mcpRunning === null
              ? "…"
              : mcpRunning
                ? (t.tb_activity_mcp_on ?? "MCP server running")
                : (t.tb_activity_mcp_off ?? "MCP server off"),
          trailing: (
            <span className={"dot" + (mcpRunning ? " is-ready" : "")}></span>
          ),
        },
      ],
    },
  ];

  return (
    <div className="model-chip-wrap" ref={wrapRef}>
      <button
        className="pill activity-chip"
        onClick={() => (open ? setOpen(false) : openPopover())}
        aria-label={t.tb_activity_label ?? "Background activity"}
        aria-expanded={open}
        title={running.map((r) => `${r.label} ${r.detail}`.trim()).join(" · ")}
      >
        {mode.kind === "single" ? (
          <>
            <ActivityIcon name={mode.activity.icon} size={16} active />
            <span className="pill-label">{mode.activity.label}</span>
            {mode.activity.detail ? (
              <span className="activity-num">{mode.activity.detail}</span>
            ) : null}
          </>
        ) : (
          <>
            <ActivityIcon name={mode.icon} size={16} active />
            <span className="pill-label">
              {(t.tb_activity_n ?? "Activity {n}").replace(
                "{n}",
                String(mode.count),
              )}
            </span>
          </>
        )}
      </button>
      {open && popPos
        ? createPortal(
            <div
              className="model-chip-pop activity-pop"
              ref={popRef}
              style={{
                top: popPos.top,
                left: popPos.left,
                width: popPos.width,
                maxHeight: popPos.maxHeight,
              }}
            >
              <ActivityPanel sections={sections} />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
