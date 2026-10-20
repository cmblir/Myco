import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { flashField, flashLinesEffect } from "./readerFlash";

const state = () =>
  EditorState.create({ doc: "a\nb\nc\nd", extensions: [flashField] });

describe("readerFlash", () => {
  it("decorates every line of the range, and only those", () => {
    const s = state().update({ effects: flashLinesEffect.of({ from: 2, to: 3 }) }).state;
    const lines: number[] = [];
    s.field(flashField).between(0, s.doc.length, (from) => {
      lines.push(s.doc.lineAt(from).number);
    });
    expect(lines).toEqual([2, 3]);
  });

  it("clears on the null effect and clamps a range past the document", () => {
    let s = state().update({ effects: flashLinesEffect.of({ from: 3, to: 9 }) }).state;
    expect(s.field(flashField).size).toBe(2);
    s = s.update({ effects: flashLinesEffect.of(null) }).state;
    expect(s.field(flashField).size).toBe(0);
  });

  it("follows an edit above the flashed lines", () => {
    let s = state().update({ effects: flashLinesEffect.of({ from: 4, to: 4 }) }).state;
    s = s.update({ changes: { from: 0, insert: "x\n" } }).state;
    const at: number[] = [];
    s.field(flashField).between(0, s.doc.length, (from) => {
      at.push(s.doc.lineAt(from).number);
    });
    expect(at).toEqual([5]);
  });
});
