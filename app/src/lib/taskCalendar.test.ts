import { describe, expect, it } from "vitest";
import { layoutMonthBars, MAX_LANES } from "./taskCalendar";
import { monthGrid } from "./taskLine";

// 2026-08-01 is a Saturday; the Monday-start grid begins 2026-07-27, so
// 2026-08-03 (Monday) is week 1 column 0.
const days = monthGrid(new Date(2026, 7, 1));
const seg = (l: ReturnType<typeof layoutMonthBars>, key: string) =>
  l.segments
    .filter((s) => s.key === key)
    .sort((a, b) => a.weekIndex - b.weekIndex);

describe("layoutMonthBars", () => {
  it("spans a bar across its days", () => {
    const l = layoutMonthBars(
      [{ key: "a", start: "2026-08-03", due: "2026-08-05" }],
      days,
    );
    expect(seg(l, "a")).toHaveLength(1);
    expect(seg(l, "a")[0]).toMatchObject({
      span: 3,
      lane: 0,
      continuesLeft: false,
      continuesRight: false,
    });
  });

  it("continues across a week boundary as two segments", () => {
    // Friday 2026-08-07 through Monday 2026-08-10: Fri–Sun, then Mon.
    const l = layoutMonthBars(
      [{ key: "a", start: "2026-08-07", due: "2026-08-10" }],
      days,
    );
    const s = seg(l, "a");
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({
      startCol: 4,
      span: 3,
      continuesRight: true,
      continuesLeft: false,
    });
    expect(s[1]).toMatchObject({
      startCol: 0,
      span: 1,
      continuesLeft: true,
      continuesRight: false,
    });
  });

  it("puts overlapping bars in different lanes", () => {
    const l = layoutMonthBars(
      [
        { key: "a", start: "2026-08-03", due: "2026-08-06" },
        { key: "b", start: "2026-08-04", due: "2026-08-05" },
      ],
      days,
    );
    expect(seg(l, "a")[0].lane).toBe(0);
    expect(seg(l, "b")[0].lane).toBe(1);
  });

  it("reuses a lane once the earlier bar has ended", () => {
    const l = layoutMonthBars(
      [
        { key: "a", start: "2026-08-03", due: "2026-08-04" },
        { key: "b", start: "2026-08-05", due: "2026-08-06" },
      ],
      days,
    );
    expect(seg(l, "b")[0].lane).toBe(0);
  });

  it("counts what does not fit instead of dropping it", () => {
    const items = Array.from({ length: MAX_LANES + 2 }, (_, i) => ({
      key: `t${i}`,
      start: "2026-08-03",
      due: "2026-08-03",
    }));
    const l = layoutMonthBars(items, days);
    expect(l.segments.every((s) => s.lane < MAX_LANES)).toBe(true);
    expect(Object.values(l.overflow).some((n) => n === 2)).toBe(true);
  });

  it("renders a due-only task as a one-day bar and a start-only task on its start", () => {
    const l = layoutMonthBars(
      [
        { key: "due", start: "", due: "2026-08-04" },
        { key: "start", start: "2026-08-06", due: "" },
      ],
      days,
    );
    expect(seg(l, "due")[0]).toMatchObject({ span: 1 });
    expect(seg(l, "start")[0]).toMatchObject({ span: 1 });
  });

  it("falls back to the due day when start is after due — never invents a range", () => {
    const l = layoutMonthBars(
      [{ key: "a", start: "2026-08-20", due: "2026-08-04" }],
      days,
    );
    expect(seg(l, "a")).toHaveLength(1);
    expect(seg(l, "a")[0].span).toBe(1);
  });

  it("ignores a task with no dates at all", () => {
    expect(
      layoutMonthBars([{ key: "a", start: "", due: "" }], days).segments,
    ).toEqual([]);
  });

  it("clips a bar that starts before the grid", () => {
    const l = layoutMonthBars(
      [{ key: "a", start: "2026-07-20", due: "2026-07-29" }],
      days,
    );
    expect(seg(l, "a")[0]).toMatchObject({
      weekIndex: 0,
      startCol: 0,
      continuesLeft: true,
    });
  });
});

describe("layoutMonthBars — maxLanes", () => {
  it("stacks past three lanes when the caller raises the limit", () => {
    const items = [1, 2, 3, 4, 5].map((n) => ({
      key: `t${n}`,
      start: "2026-08-03",
      due: "2026-08-05",
    }));
    expect(layoutMonthBars(items, days).segments).toHaveLength(3);
    const wide = layoutMonthBars(items, days, Infinity);
    expect(wide.segments).toHaveLength(5);
    expect(wide.overflow).toEqual({});
    expect(wide.segments.map((s) => s.lane)).toEqual([0, 1, 2, 3, 4]);
  });
});
