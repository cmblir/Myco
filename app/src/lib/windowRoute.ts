// Which surface this webview is: the main app window, the tray popover window
// Rust opens with `index.html?window=tray`, the global-shortcut spotlight
// (`index.html?window=spotlight`), the menu-bar notch (`?window=notch`),
// the panel myco roams in while work runs (`?window=roam`), or the 3D myco
// preview (`?window=myco3d`).
// Each secondary window renders ONE component — none of App.tsx mounts there,
// so no scheduler (auto-ingest/reindex/reflect/import, schedule timer, tray
// sender) can double-run in a second JS context.

export function isTrayPanelWindow(search: string): boolean {
  return new URLSearchParams(search).get("window") === "tray";
}

export function isSpotlightWindow(search: string): boolean {
  return new URLSearchParams(search).get("window") === "spotlight";
}

export function isNotchWindow(search: string): boolean {
  return new URLSearchParams(search).get("window") === "notch";
}

export function isRoamWindow(search: string): boolean {
  return new URLSearchParams(search).get("window") === "roam";
}

export function isMyco3DWindow(search: string): boolean {
  return new URLSearchParams(search).get("window") === "myco3d";
}
