// The tray-panel gate: main.tsx renders TrayPanel instead of App when this
// returns true, which is what keeps App's schedulers out of the tray window.

import { describe, expect, it } from "vitest";
import { isTrayPanelWindow } from "./windowRoute";

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
