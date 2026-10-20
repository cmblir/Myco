import { describe, expect, it } from "vitest";
import type { Adjacency } from "./ipc";
import { newToday, rollDay, snapshot, type DayLinks } from "./dayConnections";

const V = "/v";
const adj = (
  forward: Record<string, string[]>,
  cites: Record<string, number> = {},
): Adjacency => ({
  forward: Object.fromEntries(
    Object.entries(forward).map(([k, vs]) => [`${V}/${k}`, vs.map((x) => `${V}/${x}`)]),
  ),
  backward: {},
  unresolved: {},
  tags: {},
  meta: Object.fromEntries(
    Object.entries(cites).map(([k, n]) => [`${V}/${k}`, { sourceCount: n }]),
  ),
});

describe("snapshot", () => {
  it("keeps each pair once, whichever note links to which", () => {
    const s = snapshot(adj({ "a.md": ["b.md"], "b.md": ["a.md"] }), V);
    expect(s.pairs).toEqual(["a.md\tb.md"]);
  });
});

describe("rollDay", () => {
  const yesterday = snapshot(adj({ "a.md": ["b.md"] }), V);
  const now = snapshot(adj({ "a.md": ["b.md", "c.md"] }), V);

  it("starts with nothing new: the first sight is its own baseline", () => {
    const state = rollDay(null, now, "2026-10-03");
    expect(state).toEqual({ day: "2026-10-03", base: now, last: now });
  });

  it("on a new day the baseline is the last links seen the day before", () => {
    const prev: DayLinks = { day: "2026-10-02", base: yesterday, last: yesterday };
    const state = rollDay(prev, now, "2026-10-03");
    expect(state.base).toEqual(yesterday);
    expect(state.last).toEqual(now);
  });

  it("within the same day keeps the baseline and tracks the latest", () => {
    const prev: DayLinks = { day: "2026-10-03", base: yesterday, last: yesterday };
    expect(rollDay(prev, now, "2026-10-03").base).toEqual(yesterday);
  });
});

describe("newToday", () => {
  const base = snapshot(adj({ "a.md": ["b.md"] }, { "a.md": 1 }), V);

  it("counts the pairs in today's link set that were not there yesterday", () => {
    const cur = adj({ "a.md": ["b.md", "c.md"], "d.md": ["a.md"] }, { "a.md": 3, "d.md": 2 });
    const out = newToday(base, cur, V, new Set(["a.md", "d.md"]));
    expect(out.pairs).toEqual([
      ["a.md", "c.md"],
      ["a.md", "d.md"],
    ]);
    // a.md 1 -> 3 adds two; d.md is new with two.
    expect(out.cites).toBe(4);
  });

  it("only counts links in files saved today", () => {
    const cur = adj({ "a.md": ["b.md", "c.md"] }, { "a.md": 5 });
    expect(newToday(base, cur, V, new Set())).toEqual({ pairs: [], cites: 0 });
  });

  it("does not count a removed citation as a negative", () => {
    const cur = adj({ "a.md": ["b.md"] }, { "a.md": 0 });
    expect(newToday(base, cur, V, new Set(["a.md"])).cites).toBe(0);
  });
});
