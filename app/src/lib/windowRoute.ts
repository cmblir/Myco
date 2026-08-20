// Which surface this webview is: the main app window, the tray popover window
// Rust opens with `index.html?window=tray`, or the global-shortcut spotlight
// (`index.html?window=spotlight`). Both secondary windows render ONE component
// — none of App.tsx mounts there, so no scheduler (auto-ingest/reindex/reflect/
// import, schedule timer, tray sender) can double-run in a second JS context.

export function isTrayPanelWindow(search: string): boolean {
  return new URLSearchParams(search).get("window") === "tray";
}

export function isSpotlightWindow(search: string): boolean {
  return new URLSearchParams(search).get("window") === "spotlight";
}
