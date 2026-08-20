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

import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import ActivityPanel, { buildInflowRows } from "./ActivityPanel";
import type { ActivityIconName, PanelRow, PanelSection } from "./ActivityPanel";
import { ipc } from "../lib/ipc";
import type { TrayStatusPayload } from "../lib/ipc";

/** Pushed by Rust on every update_tray_status call. */
export const TRAY_STATUS_EVENT = "myco://tray-status";

const KIND_ICON: Record<string, ActivityIconName> = {
  ask: "ask",
  distill: "distill",
  // Reflect has no icon of its own — it borrows distill's, as in the topbar
  // popover (ActivityChip): same whole-vault pass, read-only.
  reflect: "distill",
  index: "indexing",
};

/** Dev-only sample for visual QA in a plain browser (?window=tray&trayMock=1)
 * — there is no Tauri backend to serve the real payload there. */
const MOCK_STATUS: TrayStatusPayload = {
  running: [
    { kind: "distill", text: "증류 중 — 코어 패스" },
    { kind: "reflect", text: "Reflect 분석 중…" },
    { kind: "index", text: "재색인 218/302" },
  ],
  runningHeader: "지금 하는 일",
  waitingHeader: "대기",
  title: "3",
  suggested: "제안된 링크 6개",
  reflect: "Reflect 제안 8개",
  quarantine: "검토 대기 2건",
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
    inboxCount: "+3",
    inboxView: "보기 →",
    sparkCaption: "최근 24시간 · 보라 = 세션/inbox · 파랑 = MCP 호출",
    summary: "오늘: 세션 +4 · MCP 17회 · 인박스 +3",
    hourlyFiles: [0, 0, 0, 0, 0, 0, 0, 1, 0, 2, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0],
    hourlyMcp: [0, 0, 0, 0, 0, 0, 0, 0, 2, 4, 3, 0, 0, 2, 3, 1, 2, 0, 0, 0, 0, 0, 0, 0],
  },
  ask: "위키에 질문하기",
  distill: "지금 증류",
  open: "myco 열기",
  quit: "종료",
};

export default function TrayPanel(): JSX.Element {
  const [status, setStatus] = useState<TrayStatusPayload | null>(() =>
    import.meta.env.DEV &&
    new URLSearchParams(location.search).has("trayMock")
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
        listen<TrayStatusPayload>(TRAY_STATUS_EVENT, (e) => setStatus(e.payload)),
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

  // Fit the OS window to the card: rows come and go with activity, and a
  // fixed-height transparent window drew a ghost outline below the card.
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

  const act = (action: string): void => {
    void ipc.trayPanelAction(action).catch(() => {
      /* plain-browser dev: no Tauri backend */
    });
  };

  const s = status;
  if (!s) return <div className="tray-panel" ref={cardRef} />;

  const running: PanelRow[] = s.running
    .filter((r) => r.text !== "")
    .map((r, i) => ({
      key: `run-${i}`,
      icon: KIND_ICON[r.kind],
      iconActive: true,
      main: r.text,
    }));

  const waiting: PanelRow[] = [];
  if (s.suggested) {
    waiting.push({
      key: "links",
      icon: "link",
      main: s.suggested,
      onClick: () => act("overview"),
    });
  }
  if (s.reflect) {
    waiting.push({
      key: "reflect",
      icon: "distill",
      main: s.reflect,
      onClick: () => act("overview"),
    });
  }
  if (s.quarantine) {
    waiting.push({
      key: "quarantine",
      icon: "distill",
      main: s.quarantine,
      onClick: () => act("quarantine"),
    });
  }
  if (s.mcp) {
    waiting.push({
      key: "mcp",
      icon: "mcp",
      main: s.mcp,
      onClick: () => act("settings"),
    });
  }

  // Today's inflow — Rust sends null (and no rows render) when nothing
  // arrived today, so the section disappears exactly like the others. The
  // rows themselves come from the shared builder so this panel and the
  // in-app popover stay pixel-identical in structure.
  const inflow: PanelRow[] = s.inflow
    ? buildInflowRows({
        sessions: {
          label: s.inflow.sessions,
          sub: s.inflow.sessionsSub,
          count: s.inflow.sessionsCount,
        },
        mcp: {
          label: s.inflow.mcp,
          sub: s.inflow.mcpSub,
          count: s.inflow.mcpCount,
        },
        inbox: {
          label: s.inflow.inbox,
          sub: "",
          count: s.inflow.inboxCount,
        },
        inboxView: s.inflow.inboxView,
        onInboxView: () => act("ingest"),
        sparkCaption: s.inflow.sparkCaption,
        hourlyFiles: s.inflow.hourlyFiles,
        hourlyMcp: s.inflow.hourlyMcp,
      })
    : [];

  const actions: PanelRow[] = [];
  if (s.ask) {
    actions.push({ key: "ask", icon: "ask", main: s.ask, onClick: () => act("query") });
  }
  if (s.distill) {
    actions.push({
      key: "distill",
      icon: "distill",
      main: s.distill,
      onClick: () => act("distill"),
    });
  }
  if (s.open) {
    actions.push({ key: "open", main: s.open, onClick: () => act("open") });
  }
  if (s.quit) {
    actions.push({ key: "quit", main: s.quit, onClick: () => act("quit") });
  }

  const sections: PanelSection[] = [
    { key: "running", header: s.runningHeader, rows: running },
    { key: "waiting", header: s.waitingHeader, rows: waiting },
    { key: "inflow", header: s.inflow?.header, rows: inflow },
    { key: "actions", rows: actions },
  ];

  return (
    <div className="tray-panel" ref={cardRef}>
      <ActivityPanel sections={sections} />
    </div>
  );
}
