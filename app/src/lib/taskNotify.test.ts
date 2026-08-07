import { describe, expect, it } from "vitest";
import { alarmId, buildDigest, digestIsDue, dueAlarms } from "./taskNotify";
import type { TaskItem } from "./ipc";

const task = (text: string, over: Partial<TaskItem> = {}): TaskItem => ({
  page: "daily/2026-08-07.md",
  stem: "2026-08-07",
  line: 3,
  text,
  done: false,
  status: "todo",
  ...over,
});

// Local wall-clock: due dates are written the way the user reads a calendar.
const NOW = new Date(2026, 7, 7, 9, 30); // 2026-08-07 09:30

describe("buildDigest", () => {
  it("counts overdue and due-today separately", () => {
    const d = buildDigest(
      [
        task("late one @2026-08-01"),
        task("late two @2026-08-06"),
        task("today @2026-08-07"),
        task("later @2026-08-20"),
      ],
      NOW,
    );
    expect(d).toEqual({ overdue: 2, dueToday: 1 });
  });

  it("counts a task due later TODAY as today, not overdue", () => {
    expect(buildDigest([task("this afternoon @2026-08-07T14:00")], NOW)).toEqual({
      overdue: 0,
      dueToday: 1,
    });
  });

  it("ignores finished tasks and tasks with no due date", () => {
    const d = buildDigest(
      [task("done @2026-08-01", { done: true, status: "done" }), task("no date")],
      NOW,
    );
    expect(d).toBeNull();
  });

  it("says nothing when nothing is due — no empty notification", () => {
    expect(buildDigest([task("later @2026-08-20")], NOW)).toBeNull();
  });
});

describe("digestIsDue", () => {
  it("waits for the chosen hour, so a morning digest never lands the night before", () => {
    expect(digestIsDue(new Date(2026, 7, 7, 8, 59), "", 9)).toBe(false);
    expect(digestIsDue(new Date(2026, 7, 7, 9, 0), "", 9)).toBe(true);
  });

  it("fires once per day", () => {
    expect(digestIsDue(NOW, "2026-08-07", 9)).toBe(false);
    expect(digestIsDue(NOW, "2026-08-06", 9)).toBe(true);
  });
});

describe("dueAlarms", () => {
  const empty = new Set<string>();

  it("fires for a task whose due TIME has passed", () => {
    const t = task("standup @2026-08-07T09:00");
    expect(dueAlarms([t], NOW, empty).map((x) => x.text)).toEqual([t.text]);
  });

  it("stays quiet before the time", () => {
    expect(dueAlarms([task("later @2026-08-07T18:00")], NOW, empty)).toEqual([]);
  });

  it("never fires for a date without a time — that is the digest's job", () => {
    expect(dueAlarms([task("someday @2026-08-01")], NOW, empty)).toEqual([]);
  });

  it("does not renotify what was already sent", () => {
    const t = task("standup @2026-08-07T09:00");
    expect(dueAlarms([t], NOW, new Set([alarmId(t)]))).toEqual([]);
  });

  it("ignores finished tasks", () => {
    const t = task("standup @2026-08-07T09:00", { done: true, status: "done" });
    expect(dueAlarms([t], NOW, empty)).toEqual([]);
  });

  it("ignores an unparseable date rather than firing constantly", () => {
    expect(dueAlarms([task("bad @2026-13-45T99:99")], NOW, empty)).toEqual([]);
  });

  it("keys the alarm by task AND due, so rescheduling notifies again", () => {
    const before = alarmId(task("x @2026-08-07T09:00"));
    const after = alarmId(task("x @2026-08-08T09:00"));
    expect(before).not.toBe(after);
  });
});
