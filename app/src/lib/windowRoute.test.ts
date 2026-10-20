// The tray-panel gate: main.tsx renders TrayPanel instead of App when this
// returns true, which is what keeps App's schedulers out of the tray window.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isMyco3DWindow,
  isNotchWindow,
  isRoamWindow,
  isSpotlightWindow,
  isTrayPanelWindow,
} from "./windowRoute";

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

describe("isRoamWindow", () => {
  it("matches the ?window=roam query roam.rs opens the roam panel with", () => {
    expect(isRoamWindow("?window=roam")).toBe(true);
    expect(isRoamWindow("?window=roam&roamMock=1&roamFrame=3")).toBe(true);
  });

  it("is no other window", () => {
    for (const s of ["", "?mock=1", "?window=notch", "?window=tray", "?window=spotlight"]) {
      expect(isRoamWindow(s)).toBe(false);
    }
    for (const s of ["?window=notch", "?window=tray", "?window=spotlight"]) {
      expect(isNotchWindow(s) || isTrayPanelWindow(s) || isSpotlightWindow(s)).toBe(true);
    }
  });
});

describe("isMyco3DWindow", () => {
  it("matches the ?window=myco3d preview of the 3D myco", () => {
    expect(isMyco3DWindow("?window=myco3d")).toBe(true);
    expect(isMyco3DWindow("?window=myco3d&skin=white&bg=solid")).toBe(true);
  });

  it("is no other window", () => {
    for (const s of ["", "?mock=1", "?window=notch", "?window=roam", "?window=tray"]) {
      expect(isMyco3DWindow(s)).toBe(false);
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

  it("returns from every secondary-window branch before rendering App", () => {
    const trayGate = source.indexOf("isTrayPanelWindow(location.search)");
    const spotlightGate = source.indexOf("isSpotlightWindow(location.search)");
    const roamGate = source.indexOf("isRoamWindow(location.search)");
    const myco3dGate = source.indexOf("isMyco3DWindow(location.search)");
    const appRender = source.indexOf("<App />");
    expect(trayGate).toBeGreaterThan(-1);
    expect(spotlightGate).toBeGreaterThan(-1);
    expect(roamGate).toBeGreaterThan(-1);
    expect(myco3dGate).toBeGreaterThan(-1);
    expect(appRender).toBeGreaterThan(myco3dGate);
    expect(appRender).toBeGreaterThan(spotlightGate);
    expect(appRender).toBeGreaterThan(roamGate);
    // Each gated branch must end in a bare `return;` — falling through would
    // mount App in the tray/spotlight/roam window on top of its own component.
    for (const gate of [trayGate, spotlightGate, roamGate, myco3dGate]) {
      const branch = source.slice(gate, appRender);
      expect(branch).toContain("return;");
    }
  });
});
