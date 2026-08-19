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

import { useEffect, useState } from "react";
import type { JSX } from "react";
import ActivityPanel from "./ActivityPanel";
import type { ActivityIconName, PanelRow, PanelSection } from "./ActivityPanel";
import { ipc } from "../lib/ipc";
import type { TrayStatusPayload } from "../lib/ipc";

/** Pushed by Rust on every update_tray_status call. */
export const TRAY_STATUS_EVENT = "myco://tray-status";

const KIND_ICON: Record<string, ActivityIconName> = {
  ask: "ask",
  distill: "distill",
  index: "indexing",
};

/** Dev-only sample for visual QA in a plain browser (?window=tray&trayMock=1)
 * — there is no Tauri backend to serve the real payload there. */
const MOCK_STATUS: TrayStatusPayload = {
  running: [
    { kind: "distill", text: "증류 중 — 코어 패스" },
    { kind: "index", text: "재색인 218/302" },
  ],
  runningHeader: "지금 하는 일",
  waitingHeader: "대기",
  title: "2",
  suggested: "제안된 링크 6개",
  mcp: "MCP 서버 실행 중",
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

  const act = (action: string): void => {
    void ipc.trayPanelAction(action).catch(() => {
      /* plain-browser dev: no Tauri backend */
    });
  };

  const s = status;
  if (!s) return <div className="tray-panel" />;

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
  if (s.mcp) {
    waiting.push({
      key: "mcp",
      icon: "mcp",
      main: s.mcp,
      onClick: () => act("settings"),
    });
  }

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
    { key: "actions", rows: actions },
  ];

  return (
    <div className="tray-panel">
      <ActivityPanel sections={sections} />
    </div>
  );
}
