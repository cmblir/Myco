// Topbar activity system — the right-side chip + popover that replaced the
// old BusyJobsChip. Zero running activities → no chip at all; exactly one →
// its own chip (breathing icon + name + live number); two or more → one
// collapsed "활동 N" chip. Standing states (suggested links pending, MCP
// server) never count toward the badge — they only appear inside the popover.
//
// The popover renders through the same portal + viewport-clamp mechanism as
// the Topbar model popover (computeModelPopPos) — anchoring it inside
// .topbar would clip it, see the ModelChip comment there.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { JSX } from "react";
import type { Strings } from "../lib/i18n";
import { ipc } from "../lib/ipc";
import { formatTicker } from "../lib/time";
import { requestDistillStop } from "../lib/distill";
import { pendingLinkCount } from "../lib/linkSuggestions";
import { computeModelPopPos } from "./Topbar";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { useQueryStore } from "../stores/queryStore";
import { useReindexStore } from "../stores/reindexStore";
import { useDistillRunStore } from "../stores/distillRunStore";
import type { DistillRunStep } from "../stores/distillRunStore";
import { useLinkSuggestStore } from "../stores/linkSuggestStore";
import askPng from "../assets/activity/ask.png";
import distillPng from "../assets/activity/distill.png";
import indexingPng from "../assets/activity/indexing.png";
import linkPng from "../assets/activity/link.png";
import mcpPng from "../assets/activity/mcp.png";
import stopPng from "../assets/activity/stop.png";

export type ActivityIconName =
  | "ask"
  | "distill"
  | "indexing"
  | "link"
  | "mcp"
  | "stop";

const ICON_SRC: Record<ActivityIconName, string> = {
  ask: askPng,
  distill: distillPng,
  indexing: indexingPng,
  link: linkPng,
  mcp: mcpPng,
  stop: stopPng,
};

/** The one component every activity image goes through. The PNGs bake a dark
 * ground in, so a circle mask (border-radius) hides the square on light
 * surfaces. `active` = the breathing drop-shadow glow (CSS), nothing else. */
export function ActivityIcon({
  name,
  size = 18,
  active = false,
}: {
  name: ActivityIconName;
  size?: number;
  active?: boolean;
}): JSX.Element {
  return (
    <img
      src={ICON_SRC[name]}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      className={"activity-icon" + (active ? " is-active" : "")}
    />
  );
}

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
  if (step === "ingest") return t.set_distill_step_ingest ?? "the full-tier ingest";
  if (step === "maps") return t.set_distill_step_maps ?? "the map drafts";
  return t.set_distill_step_run ?? "the core pass";
}

export default function ActivityChip({ t }: { t: Strings }): JSX.Element | null {
  const askBusy = useQueryStore((s) => s.busy);
  const askStartedAt = useQueryStore((s) => s.startedAt);
  const turns = useQueryStore((s) => s.turns);
  const distillRunning = useDistillRunStore((s) => s.running);
  const distillStep = useDistillRunStore((s) => s.step);
  const reindexStage = useReindexStore((s) => s.stage);
  const reindexDone = useReindexStore((s) => s.done);
  const reindexTotal = useReindexStore((s) => s.total);
  const adjacency = useVaultStore((s) => s.adjacency);
  const vaultPath = useVaultStore((s) => s.currentVault?.path);
  const sem = useLinkSuggestStore((s) => s.sem);
  const dismissed = useLinkSuggestStore((s) => s.dismissed);
  const refreshSem = useLinkSuggestStore((s) => s.refresh);
  const setRoute = useUIStore((s) => s.setRoute);

  const reindexBusy =
    reindexStage === "loading-model" || reindexStage === "indexing";
  const anyBusy = askBusy || distillRunning || reindexBusy;

  const [open, setOpen] = useState(false);
  const [popPos, setPopPos] = useState<ReturnType<typeof computeModelPopPos> | null>(
    null,
  );
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // MCP server state, probed when the popover opens (it is global and
  // auto-started; no store holds it — same source the Settings MCP tab reads).
  const [mcpRunning, setMcpRunning] = useState<boolean | null>(null);
  // Same latch the Settings distill tab keeps: "stop already requested".
  const [stopping, setStopping] = useState(false);

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
    return () => {
      alive = false;
    };
  }, [open]);

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
  // user is actively waiting on it — then distill, then reindex.
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

  const jump = (route: "query" | "overview" | "settings"): void => {
    setOpen(false);
    setRoute(route);
  };

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
              <div className="muted" style={{ fontSize: 12 }}>
                {t.tb_activity_running ?? "Running"}
              </div>
              {askBusy ? (
                <button className="activity-row" onClick={() => jump("query")}>
                  <ActivityIcon name="ask" active />
                  <span className="activity-row-main">
                    <b>{t.nav_query}</b>
                    {askQuestion ? (
                      <span className="activity-row-sub">{askQuestion}</span>
                    ) : null}
                  </span>
                  <span className="activity-num">
                    {askStartedAt ? formatTicker(now - askStartedAt) : ""}
                  </span>
                </button>
              ) : null}
              {distillRunning ? (
                <div className="activity-row">
                  <ActivityIcon name="distill" active />
                  <span className="activity-row-main">
                    <b>{t.set_distill_running ?? "Distilling…"}</b>
                    <span className="activity-row-sub">
                      {stepLabel(distillStep, t)}
                    </span>
                  </span>
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
                </div>
              ) : null}
              {reindexBusy ? (
                <div className="activity-row">
                  <ActivityIcon name="indexing" active />
                  <span className="activity-row-main">
                    <b>{t.s_embeddings_indexing ?? "Indexing…"}</b>
                    {reindexStage === "indexing" ? (
                      <progress value={reindexDone} max={reindexTotal || 1} />
                    ) : (
                      <span className="activity-row-sub">
                        {t.s_embeddings_loading_model ?? "Loading model…"}
                      </span>
                    )}
                  </span>
                  {reindexStage === "indexing" ? (
                    <span className="activity-num">
                      {reindexDone}/{reindexTotal}
                    </span>
                  ) : null}
                </div>
              ) : null}
              <div className="activity-standing">
                <button className="activity-row" onClick={() => jump("overview")}>
                  <ActivityIcon name="link" />
                  <span className="activity-row-main">
                    {(t.tb_activity_links ?? "{n} suggested links").replace(
                      "{n}",
                      String(pending),
                    )}
                  </span>
                </button>
                <button className="activity-row" onClick={() => jump("settings")}>
                  <ActivityIcon name="mcp" />
                  <span className="activity-row-main">
                    {mcpRunning === null
                      ? "…"
                      : mcpRunning
                        ? (t.tb_activity_mcp_on ?? "MCP server running")
                        : (t.tb_activity_mcp_off ?? "MCP server off")}
                  </span>
                  <span
                    className={"dot" + (mcpRunning ? " is-ready" : "")}
                  ></span>
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
