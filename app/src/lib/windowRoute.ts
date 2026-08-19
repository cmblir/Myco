// Which surface this webview is: the main app window, or the tray popover
// window Rust opens with `index.html?window=tray`. The tray window renders
// ONLY the activity panel — none of App.tsx mounts there, so no scheduler
// (auto-ingest/reindex/reflect/import, schedule timer, tray sender) can
// double-run in the second JS context.

export function isTrayPanelWindow(search: string): boolean {
  return new URLSearchParams(search).get("window") === "tray";
}
