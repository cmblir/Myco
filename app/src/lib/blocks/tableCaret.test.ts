import { describe, expect, it } from "vitest";
import { cellKey } from "./tableCaret";

const key = (init: Partial<KeyboardEvent>) =>
  ({
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...init,
  }) as KeyboardEvent;
// The Mod keys read no DOM: the cell is never touched.
const cell = {} as HTMLElement;

describe("cellKey — Mod keys in a cell", () => {
  // A cell is a plain-text field: ⌘A selects its own text, never the
  // whole note (the browser's select-all reaches the editor's root).
  it("⌘A and Ctrl+A select the cell's text", () => {
    expect(cellKey(key({ key: "a", metaKey: true }), cell)).toBe("SelectAll");
    expect(cellKey(key({ key: "a", ctrlKey: true }), cell)).toBe("SelectAll");
    expect(cellKey(key({ key: "A", metaKey: true }), cell)).toBe("SelectAll");
  });

  it("leaves the other Mod keys, and a plain or Alt'd a, alone", () => {
    expect(cellKey(key({ key: "a" }), cell)).toBeNull();
    expect(
      cellKey(key({ key: "a", metaKey: true, altKey: true }), cell),
    ).toBeNull();
    expect(
      cellKey(key({ key: "a", metaKey: true, shiftKey: true }), cell),
    ).toBeNull();
    expect(cellKey(key({ key: "b", metaKey: true }), cell)).toBeNull();
    expect(cellKey(key({ key: "Tab", ctrlKey: true }), cell)).toBeNull();
  });
});
