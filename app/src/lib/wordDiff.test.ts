import { describe, expect, it } from "vitest";
import { diffLines, diffWords } from "./wordDiff";

describe("diffWords", () => {
  it("returns one merged same seg for identical text", () => {
    expect(diffWords("같은 문장", "같은 문장")).toEqual([{ kind: "same", text: "같은 문장" }]);
  });

  it("marks exactly the replaced word, keeping unchanged words as same segs", () => {
    expect(diffWords("같은 문장에서 0.45가 좋다", "같은 문장에서 0.50이 좋다")).toEqual([
      { kind: "same", text: "같은 문장에서 " },
      { kind: "del", text: "0.45가" },
      { kind: "add", text: "0.50이" },
      { kind: "same", text: " 좋다" },
    ]);
  });

  it("treats whitespace-split tokens atomically so a Korean particle change marks narrowly", () => {
    // CJK case: no intra-token splitting — only the second token is marked.
    expect(diffWords("플로어는 0.45다", "플로어는 0.50이다")).toEqual([
      { kind: "same", text: "플로어는 " },
      { kind: "del", text: "0.45다" },
      { kind: "add", text: "0.50이다" },
    ]);
  });

  it("never marks whitespace-only tokens", () => {
    const segs = diffWords("a b", "a  b");
    expect(segs.every((s) => s.kind === "same")).toBe(true);
  });
});

describe("diffLines", () => {
  it("collapses identical inputs to a single gap marker", () => {
    expect(diffLines("one\ntwo\nthree", "one\ntwo\nthree")).toEqual([{ kind: "ctx", text: "⋯" }]);
  });

  it("renders a pure insertion as one add line with a single add seg", () => {
    expect(diffLines("", "hello")).toEqual([
      { kind: "add", segs: [{ kind: "add", text: "hello" }] },
    ]);
  });

  it("keeps context lines around an inserted line", () => {
    expect(diffLines("alpha\nomega", "alpha\nbeta\nomega")).toEqual([
      { kind: "ctx", text: "alpha" },
      { kind: "add", segs: [{ kind: "add", text: "beta" }] },
      { kind: "ctx", text: "omega" },
    ]);
  });

  it("word-marks a one-word replacement inside a line", () => {
    const before = "머리말\n임계값은 0.45가 기준이다\n꼬리말";
    const after = "머리말\n임계값은 0.50이 기준이다\n꼬리말";
    expect(diffLines(before, after)).toEqual([
      { kind: "ctx", text: "머리말" },
      {
        kind: "del",
        segs: [
          { kind: "same", text: "임계값은 " },
          { kind: "del", text: "0.45가" },
          { kind: "same", text: " 기준이다" },
        ],
      },
      {
        kind: "add",
        segs: [
          { kind: "same", text: "임계값은 " },
          { kind: "add", text: "0.50이" },
          { kind: "same", text: " 기준이다" },
        ],
      },
      { kind: "ctx", text: "꼬리말" },
    ]);
  });

  it("collapses the gap between two hunks to a ⋯ marker", () => {
    const before = ["a", "b", "OLD", "c", "d", "e", "f", "g", "h", "OLD2", "i"].join("\n");
    const after = ["a", "b", "NEW", "c", "d", "e", "f", "g", "h", "NEW2", "i"].join("\n");
    expect(diffLines(before, after)).toEqual([
      { kind: "ctx", text: "a" },
      { kind: "ctx", text: "b" },
      { kind: "del", segs: [{ kind: "del", text: "OLD" }] },
      { kind: "add", segs: [{ kind: "add", text: "NEW" }] },
      { kind: "ctx", text: "c" },
      { kind: "ctx", text: "d" },
      { kind: "ctx", text: "⋯" },
      { kind: "ctx", text: "g" },
      { kind: "ctx", text: "h" },
      { kind: "del", segs: [{ kind: "del", text: "OLD2" }] },
      { kind: "add", segs: [{ kind: "add", text: "NEW2" }] },
      { kind: "ctx", text: "i" },
    ]);
  });

  it("honors a custom context width", () => {
    const before = ["x", "OLD", "c", "d", "e", "OLD2", "y"].join("\n");
    const after = ["x", "NEW", "c", "d", "e", "NEW2", "y"].join("\n");
    const out = diffLines(before, after, 1);
    expect(out).toEqual([
      { kind: "ctx", text: "x" },
      { kind: "del", segs: [{ kind: "del", text: "OLD" }] },
      { kind: "add", segs: [{ kind: "add", text: "NEW" }] },
      { kind: "ctx", text: "c" },
      { kind: "ctx", text: "⋯" },
      { kind: "ctx", text: "e" },
      { kind: "del", segs: [{ kind: "del", text: "OLD2" }] },
      { kind: "add", segs: [{ kind: "add", text: "NEW2" }] },
      { kind: "ctx", text: "y" },
    ]);
  });

  it("falls back to whole-file del+add without word pass beyond 4000 lines", () => {
    const mk = (n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => `${tag}${i}`).join("\n");
    const out = diffLines(mk(4001, "l"), mk(4001, "l"));
    expect(out).toHaveLength(8002);
    expect(out[0]).toEqual({ kind: "del", segs: [{ kind: "del", text: "l0" }] });
    expect(out[4001]).toEqual({ kind: "add", segs: [{ kind: "add", text: "l0" }] });
    expect(out.some((l) => l.kind === "ctx")).toBe(false);
  });
});
