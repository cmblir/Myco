import { describe, expect, it } from "vitest";
import {
  appendTaskLine,
  monthGrid,
  parseIsoDate,
  serializeTaskText,
  setLineDue,
  setLineFields,
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
      start: "",
      scheduled: "",
      due: "2026-08-10",
      doneAt: "",
      recur: "",
      estimate: "",
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
    expect(parseTaskMeta("just do it")).toEqual({
      title: "just do it",
      start: "",
      scheduled: "",
      due: "",
      doneAt: "",
      recur: "",
      estimate: "",
      priority: 0,
    });
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

describe("setLineDue", () => {
  const doc = ["- [ ] alpha", "- [/] beta @2026-08-10", "- [x] gamma @2026-08-12T14:00", "prose"].join("\n");

  it("adds a due date to a task that had none", () => {
    expect(setLineDue(doc, 1, "2026-08-09")?.split("\n")[0]).toBe("- [ ] alpha @2026-08-09");
  });

  it("replaces an existing one rather than stacking markers", () => {
    const once = setLineDue(doc, 2, "2026-08-20");
    const twice = setLineDue(once!, 2, "2026-08-21");
    expect(twice?.split("\n")[1]).toBe("- [/] beta @2026-08-21");
  });

  it("drops a time when the day changes, instead of keeping the old hour", () => {
    expect(setLineDue(doc, 3, "2026-08-20")?.split("\n")[2]).toBe("- [x] gamma @2026-08-20");
  });

  it("removes the due date when given an empty string", () => {
    expect(setLineDue(doc, 2, "")?.split("\n")[1]).toBe("- [/] beta");
  });

  it("refuses a line that is not a checkbox", () => {
    expect(setLineDue(doc, 4, "2026-08-09")).toBeNull();
    expect(setLineDue(doc, 99, "2026-08-09")).toBeNull();
  });

  it("leaves every other line untouched", () => {
    const out = setLineDue(doc, 1, "2026-08-09");
    expect(out?.split("\n").slice(1)).toEqual(doc.split("\n").slice(1));
  });
});

describe("monthGrid", () => {
  const iso = (d: Date): string => today(d);

  it("starts on the Monday on or before the 1st", () => {
    // 2026-08-01 is a Saturday, so the grid opens on Mon 2026-07-27.
    const g = monthGrid(new Date(2026, 7, 1));
    expect(iso(g[0])).toBe("2026-07-27");
    expect(g[0].getDay()).toBe(1);
  });

  it("covers the whole month in whole weeks", () => {
    const g = monthGrid(new Date(2026, 7, 1));
    expect(g.length % 7).toBe(0);
    expect(g.map(iso)).toContain("2026-08-31");
  });

  it("uses five rows when six are not needed", () => {
    // 2026-02 starts Sunday and has 28 days: it still needs six rows here
    // (Mon-first pushes the 1st into the leading week), so assert the rule
    // rather than a magic number — no trailing week that is all next month.
    for (const m of [0, 1, 3, 8]) {
      const g = monthGrid(new Date(2026, m, 1));
      const lastWeek = g.slice(-7);
      expect(lastWeek.some((d) => d.getMonth() === m)).toBe(true);
    }
  });

  it("honours a Sunday week start (weekStart = 0)", () => {
    // 2026-08-01 is a Saturday, so a Sunday-first grid opens on Sun 2026-07-26.
    const g = monthGrid(new Date(2026, 7, 1), 0);
    expect(iso(g[0])).toBe("2026-07-26");
    expect(g[0].getDay()).toBe(0);
    expect(g.length % 7).toBe(0);
  });

  it("includes Feb 29 in a leap year and stops at Feb 28 otherwise", () => {
    expect(monthGrid(new Date(2024, 1, 1)).map(iso)).toContain("2024-02-29");
    const g25 = monthGrid(new Date(2025, 1, 1)).map(iso);
    expect(g25).toContain("2025-02-28");
    expect(g25).not.toContain("2025-02-29");
  });

  it("covers both boundaries of a month that starts and ends mid-week", () => {
    const g = monthGrid(new Date(2026, 8, 1)); // Sep 2026: Tue 1st – Wed 30th
    const days = g.map(iso);
    expect(days).toContain("2026-09-01");
    expect(days).toContain("2026-09-30");
    expect(g[0].getDay()).toBe(1);
    expect(g[g.length - 1].getDay()).toBe(0);
  });
});

describe("parseIsoDate / today round-trip", () => {
  it("round-trips a picked day exactly", () => {
    for (const day of ["2026-08-19", "2024-02-29", "2026-01-01", "2026-12-31"]) {
      const d = parseIsoDate(day);
      expect(d).not.toBeNull();
      expect(today(d as Date)).toBe(day);
    }
  });

  it("parses with local components, not Date.parse's UTC midnight", () => {
    // In any zone west of UTC, Date.parse("2026-08-19") lands on the 18th
    // locally. Component construction must not: local midnight, same day.
    const d = parseIsoDate("2026-08-19") as Date;
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 7, 19]);
    expect(d.getHours()).toBe(0);
  });

  it("rejects non-dates", () => {
    expect(parseIsoDate("")).toBeNull();
    expect(parseIsoDate("tomorrow")).toBeNull();
  });
});

describe("parseTaskMeta — scheduling fields", () => {
  it("reads the emoji set", () => {
    const m = parseTaskMeta("설계 문서 🛫 2026-08-25 ⏳ 2026-08-26 📅 2026-08-28 🔁 every week ⏱ 2d !p1");
    expect(m.title).toBe("설계 문서");
    expect(m.start).toBe("2026-08-25");
    expect(m.scheduled).toBe("2026-08-26");
    expect(m.due).toBe("2026-08-28");
    expect(m.recur).toBe("every week");
    expect(m.estimate).toBe("2d");
    expect(m.priority).toBe(1);
  });
  it("still reads the legacy @due and keeps 📅 winning when both are present", () => {
    expect(parseTaskMeta("리뷰 @2026-08-20").due).toBe("2026-08-20");
    expect(parseTaskMeta("리뷰 @2026-08-20 📅 2026-08-28").due).toBe("2026-08-28");
  });
  it("reads Tasks' priority emoji, clamping the extremes", () => {
    expect(parseTaskMeta("a 🔺").priority).toBe(1);
    expect(parseTaskMeta("a ⏫").priority).toBe(1);
    expect(parseTaskMeta("a 🔼").priority).toBe(2);
    expect(parseTaskMeta("a 🔽").priority).toBe(3);
    expect(parseTaskMeta("a ⏬").priority).toBe(3);
  });
  it("keeps unknown text — wikilinks and tags are the project, not noise", () => {
    const m = parseTaskMeta("초안 [[myco-roadmap]] #work 📅 2026-08-28");
    expect(m.title).toBe("초안 [[myco-roadmap]] #work");
  });
  it("reads a done date", () => {
    expect(parseTaskMeta("배포 ✅ 2026-08-23").doneAt).toBe("2026-08-23");
  });
});

describe("serializeTaskText", () => {
  it("writes the fixed field order", () => {
    const meta = parseTaskMeta("설계 ⏱ 2d 📅 2026-08-28 🛫 2026-08-25 !p1");
    expect(serializeTaskText(meta)).toBe("설계 🛫 2026-08-25 📅 2026-08-28 ⏱ 2d !p1");
  });
  it("round-trips: parse → serialize → parse is stable", () => {
    const line = "설계 [[proj]] 🛫 2026-08-25 ⏳ 2026-08-26 📅 2026-08-28 🔁 every 2 weeks ⏱ 90m !p2 ✅ 2026-08-29";
    const once = serializeTaskText(parseTaskMeta(line));
    expect(serializeTaskText(parseTaskMeta(once))).toBe(once);
  });
  it("migrates a legacy @due to 📅", () => {
    expect(serializeTaskText(parseTaskMeta("리뷰 @2026-08-20"))).toBe("리뷰 📅 2026-08-20");
  });
});

describe("setLineFields", () => {
  const doc = ["# note", "", "- [/] 설계 문서 📅 2026-08-28", "- not a task"].join("\n");
  it("edits only the named fields on only that line", () => {
    const next = setLineFields(doc, 3, { start: "2026-08-25", estimate: "2d" }) as string;
    expect(next.split("\n")[2]).toBe("- [/] 설계 문서 🛫 2026-08-25 📅 2026-08-28 ⏱ 2d");
    expect(next.split("\n")[3]).toBe("- not a task");
  });
  it("clears a field with an empty string", () => {
    const next = setLineFields(doc, 3, { due: "" }) as string;
    expect(next.split("\n")[2]).toBe("- [/] 설계 문서");
  });
  it("keeps the checkbox mark and indentation", () => {
    const nested = "  * [x] 배포 📅 2026-08-01";
    const next = setLineFields(nested, 1, { doneAt: "2026-08-02" }) as string;
    expect(next).toBe("  * [x] 배포 📅 2026-08-01 ✅ 2026-08-02");
  });
  it("returns null when that line is no longer a checkbox", () => {
    expect(setLineFields(doc, 4, { due: "2026-09-01" })).toBeNull();
    expect(setLineFields(doc, 99, { due: "2026-09-01" })).toBeNull();
  });
});
