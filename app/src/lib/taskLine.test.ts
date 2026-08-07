import { describe, expect, it } from "vitest";
import {
  appendTaskLine,
  buildTaskLine,
  parseTaskMeta,
  setLineStatus,
  today,
} from "./taskLine";

describe("buildTaskLine", () => {
  it("writes a plain checkbox when there is no metadata", () => {
    expect(buildTaskLine("  배포 API 수정  ")).toBe("- [ ] 배포 API 수정");
  });

  it("appends due date and priority in a form parseTaskMeta reads back", () => {
    const line = buildTaskLine("배포", "2026-08-10", 1);
    expect(line).toBe("- [ ] 배포 @2026-08-10 !p1");
    expect(parseTaskMeta(line.replace("- [ ] ", ""))).toEqual({
      title: "배포",
      due: "2026-08-10",
      priority: 1,
    });
  });

  it("ignores a priority outside 1..3 rather than writing a marker nothing reads", () => {
    expect(buildTaskLine("x", "", 0)).toBe("- [ ] x");
    expect(buildTaskLine("x", "", 9)).toBe("- [ ] x");
  });
});

describe("parseTaskMeta", () => {
  it("strips the markers from the displayed title", () => {
    expect(parseTaskMeta("리뷰 반영 @2026-08-10 !p2").title).toBe("리뷰 반영");
  });

  it("accepts a due date carrying a time, for a per-item reminder later", () => {
    expect(parseTaskMeta("마이그레이션 @2026-08-12T14:00").due).toBe("2026-08-12T14:00");
  });

  it("returns empty metadata for an ordinary task", () => {
    expect(parseTaskMeta("just do it")).toEqual({ title: "just do it", due: "", priority: 0 });
  });
});

describe("setLineStatus", () => {
  const doc = ["# note", "", "- [ ] alpha @2026-08-10", "  * [x] beta", "prose"].join("\n");

  it("flips only the mark, preserving indent, bullet and the rest of the line", () => {
    expect(setLineStatus(doc, 3, "done")?.split("\n")[2]).toBe("- [x] alpha @2026-08-10");
    expect(setLineStatus(doc, 4, "todo")?.split("\n")[3]).toBe("  * [ ] beta");
  });

  it("supports the in-progress and blocked marks", () => {
    expect(setLineStatus(doc, 3, "doing")?.split("\n")[2]).toBe("- [/] alpha @2026-08-10");
    expect(setLineStatus(doc, 3, "blocked")?.split("\n")[2]).toBe("- [-] alpha @2026-08-10");
  });

  it("refuses a line that is no longer a checkbox, so a stale scan cannot edit prose", () => {
    // The whole point: line numbers come from a scan that may predate an edit.
    expect(setLineStatus(doc, 5, "done")).toBeNull();
    expect(setLineStatus(doc, 1, "done")).toBeNull();
    expect(setLineStatus(doc, 99, "done")).toBeNull();
  });

  it("leaves every other line untouched", () => {
    const out = setLineStatus(doc, 3, "done");
    expect(out?.split("\n").filter((_, i) => i !== 2)).toEqual(
      doc.split("\n").filter((_, i) => i !== 2),
    );
  });
});

describe("appendTaskLine", () => {
  it("adds the line with exactly one trailing newline", () => {
    expect(appendTaskLine("# day\n\n", "- [ ] x")).toBe("# day\n- [ ] x\n");
  });

  it("handles an empty note without a leading blank line", () => {
    expect(appendTaskLine("", "- [ ] x")).toBe("- [ ] x\n");
  });
});

describe("today", () => {
  it("uses the local calendar day, not UTC", () => {
    // 23:30 local on the 9th is still the 9th, even where UTC has rolled over.
    expect(today(new Date(2026, 7, 9, 23, 30))).toBe("2026-08-09");
  });
});
