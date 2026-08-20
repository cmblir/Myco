// The tray-panel gate: main.tsx renders TrayPanel instead of App when this
// returns true, which is what keeps App's schedulers out of the tray window.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isSpotlightWindow, isTrayPanelWindow } from "./windowRoute";

describe("isTrayPanelWindow", () => {
  it("matches the ?window=tray query Rust opens the panel with", () => {
    expect(isTrayPanelWindow("?window=tray")).toBe(true);
    expect(isTrayPanelWindow("?trayMock=1&window=tray")).toBe(true);
  });

  it("stays false for the main window and lookalikes", () => {
    expect(isTrayPanelWindow("")).toBe(false);
    expect(isTrayPanelWindow("?mock=1")).toBe(false);
    expect(isTrayPanelWindow("?window=main")).toBe(false);
    expect(isTrayPanelWindow("?windows=tray")).toBe(false);
  });
});

describe("isSpotlightWindow", () => {
  it("matches the ?window=spotlight query Rust opens the spotlight with", () => {
    expect(isSpotlightWindow("?window=spotlight")).toBe(true);
    expect(isSpotlightWindow("?window=spotlight&mock=1")).toBe(true);
  });

  it("stays false for the main and tray windows", () => {
    expect(isSpotlightWindow("")).toBe(false);
    expect(isSpotlightWindow("?window=tray")).toBe(false);
    expect(isSpotlightWindow("?mock=1")).toBe(false);
  });

  // The two gates must be mutually exclusive: main.tsx checks them in
  // sequence, so a search string matching both would render the wrong surface.
  it("never overlaps with the tray gate", () => {
    for (const s of ["?window=tray", "?window=spotlight", "?window=main", ""]) {
      expect(isSpotlightWindow(s) && isTrayPanelWindow(s)).toBe(false);
    }
  });
});

// The gate is only worth anything if main.tsx still returns before rendering
// App: App is what starts the auto-ingest/reindex/reflect/import schedulers and
// the tray sender, and a third JS context running them would double every
// timer. Rendering the real component tree here would need jsdom + the React
// plugin (this suite is deliberately node-only), so this asserts the one
// property that matters — bootstrap order — against the source itself.
describe("main.tsx bootstrap order", () => {
  const source = readFileSync(
    new URL("../main.tsx", import.meta.url),
    "utf8",
  );

  it("returns from both secondary-window branches before rendering App", () => {
    const trayGate = source.indexOf("isTrayPanelWindow(location.search)");
    const spotlightGate = source.indexOf("isSpotlightWindow(location.search)");
    const appRender = source.indexOf("<App />");
    expect(trayGate).toBeGreaterThan(-1);
    expect(spotlightGate).toBeGreaterThan(-1);
    expect(appRender).toBeGreaterThan(spotlightGate);
    // Each gated branch must end in a bare `return;` — falling through would
    // mount App in the tray/spotlight window on top of its own component.
    for (const gate of [trayGate, spotlightGate]) {
      const branch = source.slice(gate, appRender);
      expect(branch).toContain("return;");
    }
  });
});
