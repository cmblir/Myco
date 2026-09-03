import { describe, expect, it } from "vitest";
import {
  HISTORY_CAP,
  pushRoute,
  replaceCurrent,
  sanitizeHistory,
  step,
  type NavHistory,
} from "./navHistory";

const start: NavHistory = { entries: ["overview"], idx: 0 };

describe("navHistory", () => {
  it("push appends and moves idx; pushing the current route is a no-op", () => {
    const h = pushRoute(pushRoute(start, "query"), "graph");
    expect(h).toEqual({ entries: ["overview", "query", "graph"], idx: 2 });
    expect(pushRoute(h, "graph")).toBe(h);
  });

  it("push after back truncates the forward entries", () => {
    const h = pushRoute(pushRoute(start, "query"), "graph");
    const back = step(h, -1);
    expect(back).toEqual({ entries: h.entries, idx: 1 });
    expect(pushRoute(back as NavHistory, "tasks")).toEqual({
      entries: ["overview", "query", "tasks"],
      idx: 2,
    });
  });

  it("keeps the newest HISTORY_CAP entries", () => {
    let h = start;
    for (let i = 0; i < HISTORY_CAP; i++) h = pushRoute(h, `page:/v/${i}.md`);
    expect(h.entries).toHaveLength(HISTORY_CAP);
    expect(h.idx).toBe(HISTORY_CAP - 1);
    expect(h.entries[0]).toBe("page:/v/0.md"); // "overview" fell off
    expect(h.entries[HISTORY_CAP - 1]).toBe(`page:/v/${HISTORY_CAP - 1}.md`);
  });

  it("step returns null out of range", () => {
    expect(step(start, -1)).toBeNull();
    expect(step(start, 1)).toBeNull();
    const h = pushRoute(start, "query");
    expect(step(h, 1)).toBeNull();
    expect(step(step(h, -1) as NavHistory, 1)).toEqual({ entries: h.entries, idx: 1 });
  });

  it("replaceCurrent swaps the entry at idx without growing", () => {
    const h = step(pushRoute(pushRoute(start, "query"), "graph"), -1) as NavHistory;
    expect(replaceCurrent(h, "tasks")).toEqual({
      entries: ["overview", "tasks", "graph"],
      idx: 1,
    });
  });

  it("sanitizeHistory trusts a stack only when the route sits at idx", () => {
    expect(sanitizeHistory(undefined, "query")).toEqual({ entries: ["query"], idx: 0 });
    expect(
      sanitizeHistory({ entries: ["overview", "graph"], idx: 1 }, "query"),
    ).toEqual({ entries: ["query"], idx: 0 });
    expect(sanitizeHistory({ entries: ["overview"], idx: 5 }, "overview")).toEqual({
      entries: ["overview"],
      idx: 0,
    });
    const ok: NavHistory = { entries: ["overview", "query"], idx: 1 };
    expect(sanitizeHistory(ok, "query")).toEqual(ok);
  });
});
