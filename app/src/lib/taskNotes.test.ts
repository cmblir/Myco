import { describe, expect, it } from "vitest";
import { readTaskNotes, setTaskNotes } from "./taskNotes";

const DOC = [
  "# note",
  "- [ ] plain task",
  "- [ ] task with notes",
  "  first detail line",
  "  second detail line",
  "- [x] done task",
  "prose after",
].join("\n");

describe("readTaskNotes", () => {
  it("reads the indented block under the task, dedented", () => {
    expect(readTaskNotes(DOC, 3)).toBe("first detail line\nsecond detail line");
  });

  it("a task without a block reads as empty, not null", () => {
    expect(readTaskNotes(DOC, 2)).toBe("");
  });

  it("stale line (not a checkbox) is null — the caller must rescan", () => {
    expect(readTaskNotes(DOC, 1)).toBeNull();
    expect(readTaskNotes(DOC, 99)).toBeNull();
  });

  it("stops at blank lines, nested checkboxes, and dedents", () => {
    const doc = [
      "- [ ] parent",
      "  a note",
      "  - [ ] nested subtask",
      "  after subtask",
    ].join("\n");
    // The nested checkbox ends the block: a subtask is a task, not prose.
    expect(readTaskNotes(doc, 1)).toBe("a note");
    const blank = ["- [ ] t", "  a", "", "  orphan"].join("\n");
    expect(readTaskNotes(blank, 1)).toBe("a");
  });

  it("hand-written tab indentation reads back clean", () => {
    const doc = ["- [ ] t", "\ttabbed note"].join("\n");
    expect(readTaskNotes(doc, 1)).toBe("tabbed note");
  });
});

describe("setTaskNotes", () => {
  it("adds a block under a bare task, indented past the bullet", () => {
    const out = setTaskNotes(DOC, 2, "why: OTP 프로바이더 비교\nnext: 담당 확인");
    expect(out).toContain(
      "- [ ] plain task\n  why: OTP 프로바이더 비교\n  next: 담당 확인\n- [ ] task with notes",
    );
  });

  it("replaces an existing block and leaves the rest byte-identical", () => {
    const out = setTaskNotes(DOC, 3, "rewritten")!;
    expect(out).toContain("- [ ] task with notes\n  rewritten\n- [x] done task");
    expect(out).toContain("# note\n- [ ] plain task\n");
    expect(out).toContain("prose after");
    expect(out).not.toContain("first detail line");
  });

  it("empty notes remove the block", () => {
    const out = setTaskNotes(DOC, 3, "")!;
    expect(out).toContain("- [ ] task with notes\n- [x] done task");
  });

  it("a nested task's notes indent past ITS indent", () => {
    const doc = ["- [ ] parent", "  - [ ] child"].join("\n");
    expect(setTaskNotes(doc, 2, "detail")).toBe(
      ["- [ ] parent", "  - [ ] child", "    detail"].join("\n"),
    );
  });

  it("interior blank lines are collapsed so the block cannot self-truncate", () => {
    const out = setTaskNotes(DOC, 2, "a\n\nb")!;
    expect(readTaskNotes(out, 2)).toBe("a\nb");
  });

  it("stale line is null and writes nothing", () => {
    expect(setTaskNotes(DOC, 1, "x")).toBeNull();
  });

  it("round-trips: what was written reads back", () => {
    const out = setTaskNotes(DOC, 2, "라인 1\n라인 2")!;
    expect(readTaskNotes(out, 2)).toBe("라인 1\n라인 2");
  });
});
