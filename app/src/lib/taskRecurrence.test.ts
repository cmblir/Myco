import { describe, expect, it } from "vitest";
import {
  nextOccurrence,
  parseRecurrence,
  setLineStatusWithRecurrence,
} from "./taskRecurrence";
import { parseTaskMeta } from "./taskLine";

describe("parseRecurrence", () => {
  it("reads the bare units as one interval", () => {
    expect(parseRecurrence("every day")).toEqual({ unit: "day", count: 1 });
    expect(parseRecurrence("every week")).toEqual({ unit: "week", count: 1 });
    expect(parseRecurrence("every month")).toEqual({ unit: "month", count: 1 });
    expect(parseRecurrence("every year")).toEqual({ unit: "year", count: 1 });
  });
  it("reads every N units, plural or not", () => {
    expect(parseRecurrence("every 2 weeks")).toEqual({ unit: "week", count: 2 });
    expect(parseRecurrence("  EVERY 3 Months ")).toEqual({ unit: "month", count: 3 });
  });
  it("rejects rules it cannot honour rather than guessing", () => {
    for (const rule of [
      "",
      "weekly",
      "every weekday",
      "on the 3rd Monday",
      "every 0 days",
      "every -1 week",
      "every 2",
    ]) {
      expect(parseRecurrence(rule), rule).toBeNull();
    }
  });
});

const meta = (text: string) => parseTaskMeta(text);

describe("nextOccurrence", () => {
  it("advances every date the task carries", () => {
    const next = nextOccurrence(
      meta("리뷰 🛫 2026-08-24 ⏳ 2026-08-25 📅 2026-08-28 🔁 every week"),
    );
    expect(next).toMatchObject({
      start: "2026-08-31",
      scheduled: "2026-09-01",
      due: "2026-09-04",
    });
  });
  it("keeps a due time and clears the done date", () => {
    const next = nextOccurrence(meta("스탠드업 📅 2026-08-24T09:30 ✅ 2026-08-24 🔁 every day"));
    expect(next?.due).toBe("2026-08-25T09:30");
    expect(next?.doneAt).toBe("");
  });
  it("clamps a month step to the last valid day", () => {
    expect(nextOccurrence(meta("월말 정산 📅 2026-01-31 🔁 every month"))?.due).toBe(
      "2026-02-28",
    );
    expect(nextOccurrence(meta("분기 점검 📅 2026-08-31 🔁 every 6 months"))?.due).toBe(
      "2027-02-28",
    );
  });
  it("clamps a leap day to Feb 28 in a common year", () => {
    expect(nextOccurrence(meta("윤일 📅 2028-02-29 🔁 every year"))?.due).toBe("2029-02-28");
  });
  it("crosses a month and a year boundary by days", () => {
    expect(nextOccurrence(meta("연말 📅 2026-12-30 🔁 every 3 days"))?.due).toBe("2027-01-02");
  });
  it("is inert without a rule, without a readable rule, or without dates", () => {
    expect(nextOccurrence(meta("규칙 없음 📅 2026-08-24"))).toBeNull();
    expect(nextOccurrence(meta("이상한 규칙 📅 2026-08-24 🔁 every weekday"))).toBeNull();
    expect(nextOccurrence(meta("날짜 없음 🔁 every week"))).toBeNull();
  });
});

describe("setLineStatusWithRecurrence", () => {
  const doc = [
    "# day",
    "- [ ] 스탠드업 📅 2026-08-24 🔁 every day",
    "- [ ] 규칙 없는 일 📅 2026-08-24",
    "- [x] 끝난 일 ✅ 2026-08-20",
    "prose",
  ].join("\n");

  it("stamps the done date and inserts the next occurrence above", () => {
    const out = setLineStatusWithRecurrence(doc, 2, "done", "2026-08-24")?.split("\n");
    expect(out?.slice(1, 3)).toEqual([
      "- [ ] 스탠드업 📅 2026-08-25 🔁 every day",
      "- [x] 스탠드업 📅 2026-08-24 🔁 every day ✅ 2026-08-24",
    ]);
    // Everything after the pair is untouched, just shifted down one line.
    expect(out?.slice(3)).toEqual(doc.split("\n").slice(2));
  });

  it("stamps a non-recurring task without inserting anything", () => {
    const out = setLineStatusWithRecurrence(doc, 3, "done", "2026-08-24")?.split("\n");
    expect(out).toHaveLength(5);
    expect(out?.[2]).toBe("- [x] 규칙 없는 일 📅 2026-08-24 ✅ 2026-08-24");
  });

  it("clears the done date when a task leaves done", () => {
    const out = setLineStatusWithRecurrence(doc, 4, "doing", "2026-08-24")?.split("\n");
    expect(out?.[3]).toBe("- [/] 끝난 일");
  });

  it("keeps the indentation and bullet of the task it repeats", () => {
    const nested = "  * [ ] 주간 회고 📅 2026-08-24 🔁 every week";
    const out = setLineStatusWithRecurrence(nested, 1, "done", "2026-08-24")?.split("\n");
    expect(out).toEqual([
      "  * [ ] 주간 회고 📅 2026-08-31 🔁 every week",
      "  * [x] 주간 회고 📅 2026-08-24 🔁 every week ✅ 2026-08-24",
    ]);
  });

  it("refuses a line that is not a checkbox", () => {
    expect(setLineStatusWithRecurrence(doc, 5, "done", "2026-08-24")).toBeNull();
    expect(setLineStatusWithRecurrence(doc, 99, "done", "2026-08-24")).toBeNull();
  });
});
