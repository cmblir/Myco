// The tray popover window's entire UI. This is a SECOND webview with its own
// JS context — no zustand store here is the main window's, so state comes
// from the same source the native tray menu renders: the last TrayStatus the
// main window pushed to Rust (get_tray_status + the myco://tray-status push).
// Every label arrives pre-translated in that payload; this file owns no
// strings of its own.
//
// Quick actions route through the tray_panel_action command, i.e. the same
// Rust handler as the native menu rows — one entry point for open/quit/
// query/distill from both surfaces (resident-mode semantics included).
//
// Layout (tray v3, owner-approved mockup): mascot header with a status
// subtitle → at most ONE "now" card for the thing that needs a decision →
// two glass tiles (waiting counts, today's inflow with the 24h chart folded
// into a disclosure) → two action buttons → open/quit.

import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { ActivityIcon } from "./ActivityPanel";
import type { ActivityIconName } from "./ActivityPanel";
import MascotClip from "./MascotClip";
import { ipc } from "../lib/ipc";
import type { TrayPanelPayload, TrayStatusPayload } from "../lib/ipc";
import { bumpedKeys, pickNowCard } from "../lib/trayStatus";

/** Pushed by Rust on every update_tray_status call. */
export const TRAY_STATUS_EVENT = "myco://tray-status";

const TOAST_MS = 3000;
const TOAST_OUT_MS = 250;

/** Dev-only sample for visual QA in a plain browser (?window=tray&trayMock=1)
 * — there is no Tauri backend to serve the real payload there. */
const MOCK_STATUS: TrayStatusPayload = {
  running: [],
  runningHeader: "지금 하는 일",
  waitingHeader: "대기",
  title: null,
  suggested: "제안된 링크 4개",
  reflect: "Reflect 제안 8개",
  quarantine: "",
  proposals: [
    {
      path: "work/feedback/2026-08-12-map-anthropic.md",
      label: "anthropic",
      sub: "토픽 맵 작성 · 노트 9개",
    },
  ],
  proposalsMore: "",
  proposalApprove: "승인",
  proposalReject: "무시",
  proposalNote: "",
  mcp: "MCP 서버 실행 중",
  inflow: {
    header: "오늘 들어온 것",
    sessions: "세션 수집",
    sessionsSub: "마지막 수집 12:40 · 자동 30분",
    sessionsCount: "+4",
    mcp: "MCP 도구 호출",
    mcpSub: "최다: search · 앱 실행 이후",
    mcpCount: "17회",
    inbox: "_inbox 도착",
    inboxSub: "clipper 2 · 출처 미표기 1",
    inboxCount: "+3",
    inboxView: "보기 →",
    sparkCaption: "최근 24시간 · 보라 = 세션/inbox · 파랑 = MCP 호출",
    summary: "오늘: 세션 +4 · MCP 17회 · 인박스 +3",
    hourlyFiles: [
      0, 0, 0, 0, 0, 0, 0, 1, 0, 2, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0,
    ],
    hourlyMcp: [
      0, 0, 0, 0, 0, 0, 0, 0, 2, 4, 3, 0, 0, 2, 3, 1, 2, 0, 0, 0, 0, 0, 0, 0,
    ],
  },
  greeting: "1건이 기다려요",
  panel: {
    mcpRunning: true,
    counts: {
      links: 4,
      reflect: 8,
      overdue: 1,
      dueToday: 0,
      files: 7,
      mcpCalls: 17,
    },
    labels: {
      waiting: "기다리는 것",
      today: "오늘",
      links: "제안된 링크",
      reflect: "Reflect 제안",
      tasks: "할 일",
      tasksDue: "오늘 0",
      tasksOverdue: "지연 1",
      sessions: "세션 · inbox",
      mcpCalls: "MCP 도구 호출",
      last24: "최근 24시간",
      hourly: "시간별",
      nowEyebrow: "승인 대기",
      toastApproved: "{name} 승인됨",
      view: "보기 →",
    },
  },
  ask: "위키에 질문",
  distill: "지금 증류",
  open: "myco 열기",
  quit: "종료",
};

type Mood = "ok" | "warn" | null;
type Reaction = "nod" | "wiggle" | null;

/** Right-aligned mono count in a glass badge. Remounting on `bumpSeq` replays
 * the bump keyframe without a timer (the CSS runs once per mount). */
function Badge({
  children,
  tone,
  bumpSeq = 0,
}: {
  children: string;
  tone?: "z" | "up" | "warn";
  bumpSeq?: number;
}): JSX.Element {
  return (
    <span
      key={bumpSeq}
      className={
        "tray-n" + (tone ? ` is-${tone}` : "") + (bumpSeq > 0 ? " is-bump" : "")
      }
    >
      {children}
    </span>
  );
}

function TileRow({
  icon,
  iconActive,
  label,
  sub,
  badge,
  onClick,
}: {
  icon: ActivityIconName;
  iconActive?: boolean;
  label: string;
  sub?: string;
  badge: JSX.Element;
  onClick?: () => void;
}): JSX.Element {
  const body = (
    <>
      <ActivityIcon name={icon} size={28} active={iconActive ?? false} />
      <span className="tray-row-l">
        {label}
        {sub ? <small>{sub}</small> : null}
      </span>
      {badge}
    </>
  );
  return onClick ? (
    <button type="button" className="tray-row" onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="tray-row is-static">{body}</div>
  );
}

/** 24 hourly columns, files stacked under MCP calls, growing from the
 * baseline on mount (only rendered while the disclosure is open, so every
 * open remounts it). The native `title` is the value tooltip. Decorative —
 * the totals are in the rows. */
function HourBars({
  files,
  mcp,
  legendFiles,
  legendHours,
}: {
  files: number[];
  mcp: number[];
  legendFiles: string;
  legendHours: string;
}): JSX.Element {
  const max = Math.max(1, ...files.map((f, i) => f + (mcp[i] ?? 0)));
  return (
    <div className="tray-flow-body">
      <div className="tray-bars" aria-hidden="true">
        {files.map((f, i) => {
          const m = mcp[i] ?? 0;
          return (
            <div
              className="tray-bar"
              key={i}
              style={{ animationDelay: `${i * 18}ms` }}
              title={`${String(i).padStart(2, "0")}h · ${f} · MCP ${m}`}
            >
              <i className="is-mcp" style={{ height: `${(m / max) * 100}%` }} />
              <i style={{ height: `${(f / max) * 100}%` }} />
            </div>
          );
        })}
      </div>
      <div className="tray-legend">
        <span>
          <i /> {legendFiles} <i className="is-mcp" /> MCP
        </span>
        <span>{legendHours}</span>
      </div>
    </div>
  );
}

export default function TrayPanel(): JSX.Element {
  const [status, setStatus] = useState<TrayStatusPayload | null>(() =>
    import.meta.env.DEV && new URLSearchParams(location.search).has("trayMock")
      ? MOCK_STATUS
      : null,
  );

  useEffect(() => {
    // The window itself is transparent; only the rounded panel paints.
    document.documentElement.classList.add("tray-window");
    void ipc
      .getTrayStatus()
      .then(setStatus)
      .catch(() => {
        /* plain-browser dev: no Tauri backend */
      });
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<TrayStatusPayload>(TRAY_STATUS_EVENT, (e) =>
          setStatus(e.payload),
        ),
      )
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {
        /* plain-browser dev: no Tauri event bus */
      });
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") void ipc.trayPanelAction("dismiss");
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // Fit the OS window to the card: the now-card collapses, the 24h chart
  // opens and closes — every one of those changes the height, and the
  // observer reports each layout (a fixed-height transparent window drew a
  // ghost outline below the card).
  const cardRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = cardRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let last = 0;
    const ro = new ResizeObserver(() => {
      const h = Math.ceil(el.offsetHeight);
      if (h > 0 && h !== last) {
        last = h;
        void ipc.resizeTrayPanel(h).catch(() => {
          /* plain-browser dev: no Tauri backend */
        });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
    // Mount-once: both render branches share the same root div, so the node
    // the ref points at never changes and the observer follows every layout.
  }, []);

  // Badge bumps: compare each push's counts with the previous one.
  const prevCounts = useRef<TrayPanelPayload["counts"] | null>(null);
  const [bumps, setBumps] = useState<Record<string, number>>({});
  useEffect(() => {
    const counts = status?.panel?.counts;
    if (!counts) return;
    const grew = bumpedKeys(prevCounts.current, counts);
    prevCounts.current = counts;
    if (grew.length > 0) {
      setBumps((b) => {
        const next = { ...b };
        for (const k of grew) next[k] = (next[k] ?? 0) + 1;
        return next;
      });
    }
  }, [status]);

  // Mascot reaction (CSS transform class, cleared when the keyframe ends),
  // the top glow's mood, the decided now-cards (collapsed until the next
  // push drops them), and the approve toast.
  const [reaction, setReaction] = useState<Reaction>(null);
  const [mood, setMood] = useState<Mood>(null);
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const [chartOpen, setChartOpen] = useState(false);
  useEffect(() => {
    // Drop collapsed cards once the push no longer lists their proposal.
    const live = new Set((status?.proposals ?? []).map((p) => p.path));
    setGone((g) => {
      const next = new Set([...g].filter((path) => live.has(path)));
      return next.size === g.size ? g : next;
    });
  }, [status]);
  const [toast, setToast] = useState<{ text: string; out: boolean } | null>(
    null,
  );
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const later = (fn: () => void, ms: number): void => {
    timers.current.push(setTimeout(fn, ms));
  };
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const act = (action: string): void => {
    void ipc.trayPanelAction(action).catch(() => {
      /* plain-browser dev: no Tauri backend */
    });
  };

  const decide = (path: string, label: string, approve: boolean): void => {
    // Same handlers the in-app popover uses: the action string carries the
    // proposal path back to the main window, which owns distillStore.
    act(`proposal-${approve ? "approve" : "reject"}:${path}`);
    setGone((g) => new Set(g).add(path));
    setReaction(approve ? "nod" : "wiggle");
    setMood(approve ? "ok" : "warn");
    later(() => setMood(null), approve ? 3600 : 2600);
    if (approve) {
      const text = (
        status?.panel?.labels.toastApproved ?? "{name} approved"
      ).replace("{name}", label);
      later(() => setToast({ text, out: false }), 250);
      later(() => setToast({ text, out: true }), 250 + TOAST_MS - TOAST_OUT_MS);
      later(() => setToast(null), 250 + TOAST_MS);
    }
  };

  const s = status;
  if (!s) return <div className="tray-panel" ref={cardRef} />;

  const panel = s.panel ?? null;
  const counts = panel?.counts;
  const labels = panel?.labels;
  const proposal = (s.proposals ?? [])[0];
  const now = pickNowCard({
    proposals: s.proposals?.length ?? 0,
    overdue: counts?.overdue ?? 0,
    links: counts?.links ?? 0,
  });

  const nowCard = (() => {
    if (!now || !labels) return null;
    if (now === "proposal" && proposal) {
      const sub = [proposal.sub, s.proposalNote].filter(Boolean).join(" · ");
      return (
        <div
          key={proposal.path}
          className={"tray-now" + (gone.has(proposal.path) ? " is-gone" : "")}
        >
          <ActivityIcon name="distill" size={52} />
          <span className="tray-now-k">{labels.nowEyebrow}</span>
          <span className="tray-now-t">
            {proposal.label}
            {sub ? <small>{sub}</small> : null}
          </span>
          <span className="tray-now-btns">
            <button
              type="button"
              className="tray-b is-pri"
              onClick={() => decide(proposal.path, proposal.label, true)}
            >
              {s.proposalApprove}
            </button>
            <button
              type="button"
              className="tray-b"
              onClick={() => decide(proposal.path, proposal.label, false)}
            >
              {s.proposalReject}
            </button>
          </span>
        </div>
      );
    }
    // Overdue task / suggested links: nothing to approve, one "view" action.
    const isTask = now === "overdue";
    return (
      <div className="tray-now" key={now}>
        <ActivityIcon name={isTask ? "indexing" : "link"} size={52} />
        <span className="tray-now-k">
          {isTask ? labels.tasks : labels.links}
        </span>
        <span className="tray-now-t">
          {isTask ? labels.tasksOverdue : s.suggested}
          {isTask ? <small>{labels.tasksDue}</small> : null}
        </span>
        <span className="tray-now-btns">
          <button
            type="button"
            className="tray-b"
            onClick={() => act(isTask ? "tasks" : "overview")}
          >
            {labels.view}
          </button>
        </span>
      </div>
    );
  })();

  const total24 = s.inflow
    ? s.inflow.hourlyFiles.reduce((a, b) => a + b, 0) +
      s.inflow.hourlyMcp.reduce((a, b) => a + b, 0)
    : 0;

  return (
    <div
      className={"tray-panel tray-v3" + (mood ? ` mood-${mood}` : "")}
      ref={cardRef}
    >
      <header className="tray-hd">
        <button
          type="button"
          className={"tray-myco" + (reaction ? ` is-${reaction}` : "")}
          onAnimationEnd={(e) => {
            // The ring's pulse bubbles up too; only the button's own
            // nod/wiggle keyframe clears the reaction.
            if (e.target === e.currentTarget) setReaction(null);
          }}
          onClick={() => setReaction("nod")}
          aria-label="myco"
        >
          <span className="tray-ring" />
          <MascotClip size={60} />
        </button>
        <div className="tray-hd-text">
          <strong>myco</strong>
          {/* Keyed on the text so a state change remounts the line and the
              slide-up keyframe replays — no reflow hack needed. */}
          {s.greeting ? (
            <span className="tray-sub" key={s.greeting}>
              {s.greeting}
            </span>
          ) : null}
        </div>
        <span className={"tray-pill" + (panel?.mcpRunning ? "" : " is-off")}>
          <i />
          MCP
        </span>
      </header>

      {nowCard}

      {counts && labels ? (
        <section className="tray-tile">
          <div className="tray-tile-l">{labels.waiting}</div>
          <TileRow
            icon="link"
            label={labels.links}
            onClick={() => act("overview")}
            badge={
              <Badge
                tone={counts.links === 0 ? "z" : undefined}
                bumpSeq={bumps.links}
              >
                {String(counts.links)}
              </Badge>
            }
          />
          <TileRow
            icon="distill"
            label={labels.reflect}
            onClick={() => act("overview")}
            badge={
              <Badge
                tone={counts.reflect === 0 ? "z" : undefined}
                bumpSeq={bumps.reflect}
              >
                {String(counts.reflect)}
              </Badge>
            }
          />
          {/* ponytail: indexing.png stands in for tasks — a checklist object
              in the same black-glass style still needs generating. */}
          <TileRow
            icon="indexing"
            label={labels.tasks}
            sub={labels.tasksDue}
            onClick={() => act("tasks")}
            badge={
              counts.overdue > 0 ? (
                <Badge tone="warn" bumpSeq={bumps.overdue}>
                  {labels.tasksOverdue}
                </Badge>
              ) : (
                <Badge tone={counts.dueToday === 0 ? "z" : undefined}>
                  {String(counts.dueToday)}
                </Badge>
              )
            }
          />
        </section>
      ) : null}

      {counts && labels && s.inflow ? (
        <section className="tray-tile">
          <div className="tray-tile-l">{labels.today}</div>
          <TileRow
            icon="ask"
            label={labels.sessions}
            badge={
              <Badge
                tone={counts.files > 0 ? "up" : "z"}
                bumpSeq={bumps.files}
              >
                {`+${counts.files}`}
              </Badge>
            }
          />
          <TileRow
            icon="mcp"
            iconActive={panel?.mcpRunning}
            label={labels.mcpCalls}
            badge={
              <Badge
                tone={counts.mcpCalls === 0 ? "z" : undefined}
                bumpSeq={bumps.mcpCalls}
              >
                {s.inflow.mcpCount}
              </Badge>
            }
          />
          <details
            className="tray-flow"
            onToggle={(e) => setChartOpen(e.currentTarget.open)}
          >
            <summary>
              <span>{labels.last24}</span>
              <span className="tray-flow-r">
                <Badge tone={total24 === 0 ? "z" : undefined}>
                  {String(total24)}
                </Badge>
                <span className="tray-chev">›</span>
              </span>
            </summary>
            {chartOpen ? (
              <HourBars
                files={s.inflow.hourlyFiles}
                mcp={s.inflow.hourlyMcp}
                legendFiles={labels.sessions}
                legendHours={labels.hourly}
              />
            ) : null}
          </details>
        </section>
      ) : null}

      <div className="tray-ft">
        {s.ask ? (
          <button type="button" className="tray-b" onClick={() => act("query")}>
            <ActivityIcon name="ask" size={20} />
            {s.ask}
          </button>
        ) : null}
        {s.distill ? (
          <button
            type="button"
            className="tray-b"
            onClick={() => {
              setReaction("nod");
              act("distill");
            }}
          >
            <ActivityIcon name="distill" size={20} />
            {s.distill}
          </button>
        ) : null}
      </div>
      <div className="tray-foot">
        {s.open ? (
          <button type="button" onClick={() => act("open")}>
            {s.open}
          </button>
        ) : null}
        {s.quit ? (
          <button type="button" onClick={() => act("quit")}>
            {s.quit}
          </button>
        ) : null}
      </div>

      {toast ? (
        <div
          className={"tray-toast" + (toast.out ? " is-out" : "")}
          role="status"
        >
          <ActivityIcon name="distill" size={22} />
          <span className="tray-toast-ok" aria-hidden="true">
            <svg viewBox="0 0 12 12" width="11" height="11" fill="none">
              <path
                d="M2.5 6.5l2.5 2.5 4.5-5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span>{toast.text}</span>
        </div>
      ) : null}
    </div>
  );
}
