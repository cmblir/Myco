import { describe, expect, it } from "vitest";
import {
  computeStats,
  defaultWidgets,
  newWidget,
  taskStatusCounts,
  weeklyActivity,
  weekStartMs,
} from "./dashboard";
import type { Adjacency, TaskItem } from "./ipc";

// 2026-08-31 is a Monday, 12:00 local.
const NOW = new Date(2026, 7, 31, 12).getTime();
const DAY = 86_400_000;

describe("weeklyActivity", () => {
  it("buckets mtimes into trailing Monday weeks, zero-filled", () => {
    const secsOf = (ms: number): number => Math.floor(ms / 1000);
    const buckets = weeklyActivity(
      [
        secsOf(NOW), // this week
        secsOf(NOW - 7 * DAY), // last week
        secsOf(NOW - 7 * DAY + DAY), // last week too
        secsOf(NOW - 30 * 7 * DAY), // far outside the window
      ],
      4,
      NOW,
    );
    expect(buckets).toHaveLength(4);
    expect(buckets.map((b) => b.count)).toEqual([0, 0, 2, 1]);
    // Buckets start on local-midnight Mondays, oldest first.
    expect(buckets[3].startMs).toBe(weekStartMs(NOW));
    expect(new Date(buckets[0].startMs).getDay()).toBe(1);
  });

  it("a Sunday belongs to the Monday-started week before it", () => {
    const sunday = new Date(2026, 7, 30, 23).getTime();
    expect(weekStartMs(sunday)).toBe(new Date(2026, 7, 24).getTime());
  });
});

const task = (over: Partial<TaskItem>): TaskItem => ({
  page: "wiki/a.md",
  stem: "a",
  line: 1,
  text: "t",
  done: false,
  status: "todo",
  ...over,
});

describe("taskStatusCounts", () => {
  it("counts every status in actionable-first order", () => {
    const counts = taskStatusCounts([
      task({}),
      task({ status: "doing" }),
      task({ status: "done", done: true }),
      task({ status: "done", done: true }),
    ]);
    expect(counts.map((c) => `${c.status}:${c.count}`)).toEqual([
      "todo:1",
      "doing:1",
      "blocked:0",
      "done:2",
    ]);
  });
});

describe("computeStats", () => {
  it("counts pages, open tasks, unsourced, and this week's wiki edits", () => {
    const adj: Adjacency = {
      forward: {},
      backward: {},
      unresolved: {},
      tags: {},
      meta: {
        "wiki/a.md": { sourceCount: 0 },
        "wiki/b.md": { sourceCount: 2 },
      },
    } as unknown as Adjacency;
    const files = ["wiki/a.md", "wiki/b.md"];
    const mtimes = new Map<string, number>([
      ["wiki/a.md", Math.floor(NOW / 1000)],
      ["wiki/b.md", Math.floor((NOW - 30 * DAY) / 1000)],
      // A session edited today is activity but not a wiki edit.
      ["sessions/x.md", Math.floor(NOW / 1000)],
    ]);
    const s = computeStats(
      adj,
      files,
      [task({}), task({ status: "done", done: true })],
      mtimes,
      NOW,
    );
    expect(s).toEqual({
      pages: 2,
      openTasks: 1,
      unsourced: 1,
      editedThisWeek: 1,
    });
  });
});

describe("widgets", () => {
  it("newWidget never reuses an existing id and carries kind defaults", () => {
    const board = defaultWidgets();
    const w = newWidget("distribution", board);
    expect(board.some((x) => x.id === w.id)).toBe(false);
    expect(w).toMatchObject({ kind: "distribution", dim: "types" });
  });
});
