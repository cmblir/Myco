import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyFilters,
  nextFloor,
  toPick,
  unixDay,
  useResurfaceStore,
} from "./resurfaceStore";
import type { ResurfacePick } from "./resurfaceStore";

const pick = (page: string, score: number): ResurfacePick => ({
  page,
  stem: page.split("/").pop()!.replace(".md", ""),
  score,
  snippet: "snippet",
  lastOpen: null,
});

const TODAY = 20_000; // arbitrary unix-day for the pure-fn cases

describe("applyFilters", () => {
  it("excludes ignored pages", () => {
    const cands = [pick("wiki/a.md", 0.9), pick("wiki/b.md", 0.8)];
    expect(applyFilters(cands, new Set(["wiki/a.md"]), {}, TODAY, 2)).toEqual([
      cands[1],
    ]);
  });

  it("excludes pages snoozed until a future day", () => {
    const cands = [pick("wiki/a.md", 0.9), pick("wiki/b.md", 0.8)];
    expect(
      applyFilters(cands, new Set(), { "wiki/a.md": TODAY + 3 }, TODAY, 2),
    ).toEqual([cands[1]]);
  });

  it("lets an expired snooze become eligible again", () => {
    const cands = [pick("wiki/a.md", 0.9)];
    expect(
      applyFilters(cands, new Set(), { "wiki/a.md": TODAY }, TODAY, 2),
    ).toEqual(cands);
  });

  it("caps at 2 keeping the highest scores, ordered by score", () => {
    const cands = [
      pick("wiki/low.md", 0.71),
      pick("wiki/top.md", 0.93),
      pick("wiki/mid.md", 0.82),
    ];
    expect(applyFilters(cands, new Set(), {}, TODAY, 2)).toEqual([
      cands[1],
      cands[2],
    ]);
  });
});

describe("nextFloor", () => {
  it("is a no-op under 10 shown, whatever the rate", () => {
    expect(nextFloor(0.7, 9, 0)).toBe(0.7);
    expect(nextFloor(0.7, 0, 0)).toBe(0.7);
  });

  it("raises by 0.03 when the accept rate falls under 0.2", () => {
    expect(nextFloor(0.7, 10, 1)).toBe(0.73);
  });

  it("clamps the raise at 0.85", () => {
    expect(nextFloor(0.84, 20, 0)).toBe(0.85);
    expect(nextFloor(0.85, 20, 0)).toBe(0.85);
  });

  it("cuts by 0.02 when the accept rate exceeds 0.5", () => {
    expect(nextFloor(0.7, 10, 6)).toBe(0.68);
  });

  it("clamps the cut at 0.60", () => {
    expect(nextFloor(0.61, 20, 15)).toBe(0.6);
    expect(nextFloor(0.6, 20, 15)).toBe(0.6);
  });

  it("leaves a mid-band accept rate alone", () => {
    expect(nextFloor(0.7, 10, 3)).toBe(0.7); // 0.3 — between 0.2 and 0.5
  });
});

describe("toPick", () => {
  it("maps the IPC row's snake_case last_open to lastOpen", () => {
    expect(
      toPick({
        page: "wiki/a.md",
        stem: "a",
        score: 0.9,
        snippet: "s",
        last_open: 123,
      }),
    ).toEqual({ page: "wiki/a.md", stem: "a", score: 0.9, snippet: "s", lastOpen: 123 });
  });
});

describe("store actions (persistence)", () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    storage = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    });
    useResurfaceStore.setState({ picks: [], computedAt: null, floor: 0.7 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refreshFrom filters, caps at 2 and records the shown count", () => {
    useResurfaceStore
      .getState()
      .refreshFrom([
        pick("wiki/a.md", 0.9),
        pick("wiki/b.md", 0.8),
        pick("wiki/c.md", 0.7),
      ]);

    const s = useResurfaceStore.getState();
    expect(s.picks.map((p) => p.page)).toEqual(["wiki/a.md", "wiki/b.md"]);
    expect(s.computedAt).not.toBeNull();
    expect(JSON.parse(storage.get("myco.resurface.stats.v1")!)).toEqual({
      shown: 2,
      accepted: 0,
    });
  });

  it("ignore persists the page and keeps it out of later refreshes", () => {
    useResurfaceStore.getState().refreshFrom([pick("wiki/a.md", 0.9)]);
    useResurfaceStore.getState().ignore("wiki/a.md");

    expect(useResurfaceStore.getState().picks).toEqual([]);
    expect(JSON.parse(storage.get("myco.resurface.ignored.v1")!)).toEqual([
      "wiki/a.md",
    ]);

    useResurfaceStore.getState().refreshFrom([pick("wiki/a.md", 0.9)]);
    expect(useResurfaceStore.getState().picks).toEqual([]);
  });

  it("snooze persists today+7 and keeps the page out until then", () => {
    useResurfaceStore.getState().refreshFrom([pick("wiki/a.md", 0.9)]);
    useResurfaceStore.getState().snooze("wiki/a.md");

    expect(useResurfaceStore.getState().picks).toEqual([]);
    expect(JSON.parse(storage.get("myco.resurface.snoozed.v1")!)).toEqual({
      "wiki/a.md": unixDay() + 7,
    });

    useResurfaceStore.getState().refreshFrom([pick("wiki/a.md", 0.9)]);
    expect(useResurfaceStore.getState().picks).toEqual([]);
  });

  it("open counts an accept only for a currently-shown pick", () => {
    useResurfaceStore.getState().refreshFrom([pick("wiki/a.md", 0.9)]);

    useResurfaceStore.getState().open("wiki/other.md"); // never shown
    useResurfaceStore.getState().open("wiki/a.md");

    expect(JSON.parse(storage.get("myco.resurface.stats.v1")!)).toEqual({
      shown: 1,
      accepted: 1,
    });
  });

  it("refreshFrom self-tunes the floor from the accumulated window, then resets it", () => {
    // A full window of shows with zero accepts, persisted by earlier sessions.
    storage.set(
      "myco.resurface.stats.v1",
      JSON.stringify({ shown: 10, accepted: 0 }),
    );

    useResurfaceStore.getState().refreshFrom([pick("wiki/a.md", 0.9)]);

    expect(useResurfaceStore.getState().floor).toBe(0.73);
    expect(storage.get("myco.resurface.floor.v1")).toBe("0.73");
    // New window: only this refresh's own show remains.
    expect(JSON.parse(storage.get("myco.resurface.stats.v1")!)).toEqual({
      shown: 1,
      accepted: 0,
    });
  });
});
