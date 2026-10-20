// Later on the last reunion pick removes the row that held focus; focus must
// land on something nearby, not <body>. Plain objects stand in for the DOM
// (node env, as the other component tests run).
import { describe, expect, it } from "vitest";
import { refocusAfterLater } from "./MorningBand";

function focusable(): { focused: number; focus: () => void } {
  const el = { focused: 0, focus: () => void (el.focused += 1) };
  return el;
}

const doc = (toggle: unknown): Document =>
  ({ querySelector: () => toggle }) as unknown as Document;

describe("refocusAfterLater", () => {
  it("moves focus to the rail's remaining button while the rail stays", () => {
    const review = focusable();
    const toggle = focusable();
    const rail = { isConnected: true, querySelector: () => review } as unknown as Element;
    refocusAfterLater(rail, doc(toggle));
    expect(review.focused).toBe(1);
    expect(toggle.focused).toBe(0);
  });

  it("falls back to Home's management toggle once the rail is gone", () => {
    const toggle = focusable();
    const rail = { isConnected: false, querySelector: () => null } as unknown as Element;
    refocusAfterLater(rail, doc(toggle));
    refocusAfterLater(null, doc(toggle));
    expect(toggle.focused).toBe(2);
  });
});
