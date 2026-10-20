import { describe, expect, it, vi } from "vitest";
import { focusReturnTarget } from "./returnFocus";

const el = (isConnected = true) => ({ isConnected, focus: vi.fn() });
const panelHolding = (...inside: unknown[]) => ({ contains: (n: unknown) => inside.includes(n) });

describe("focusReturnTarget — where focus goes when a panel closes", () => {
  const opener = el();
  const button = el();

  it("goes back to the control that opened the panel when the panel held focus", () => {
    expect(focusReturnTarget(panelHolding(button), button, opener)).toBe(opener);
  });

  it("leaves focus alone when the user already moved it out of the panel", () => {
    expect(focusReturnTarget(panelHolding(button), el(), opener)).toBeNull();
  });

  it("gives up when the opener left the page", () => {
    expect(focusReturnTarget(panelHolding(button), button, el(false))).toBeNull();
    expect(focusReturnTarget(panelHolding(button), button, null)).toBeNull();
  });
});
