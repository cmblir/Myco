// chipMode is the chip-state derivation behind the Topbar activity system:
// 0 running → no chip, exactly 1 → that activity's own chip, 2+ → the
// collapsed count chip. Standing states (suggested links, MCP) never reach it
// by construction — callers pass RUNNING activities only — so the count here
// IS the badge number.

import { describe, expect, it } from "vitest";
import {
  buildRunning,
  chipMode,
  distillFraction,
  harvestFraction,
} from "./ActivityChip";
import type { RunningActivity, RunningSources } from "./ActivityChip";
import { STRINGS } from "../lib/i18n";

const t = STRINGS.en;

/** Nothing running anywhere — the state the app spends most of its life in,
 * and the shape every store's untouched default produces. */
const IDLE: RunningSources = {
  ask: { busy: false, startedAt: null },
  harvest: { total: 0, done: 0, phase: null },
  ingest: { running: false, startedAt: null },
  lintRunning: false,
  distill: { running: false, step: null },
  reflectRunning: false,
  progress: null,
  applyingCount: 0,
  reindex: { stage: "idle", done: 0, total: 0 },
  now: 60_000,
};

const ask: RunningActivity = { icon: "ask", label: "Ask", detail: "0:12" };
const distill: RunningActivity = {
  icon: "distill",
  label: "Distilling…",
  detail: "the core pass",
};
const reflect: RunningActivity = {
  // Reflect borrows the distill icon — the set has no reflect art.
  icon: "distill",
  label: "Reflect running…",
  detail: "",
};
const indexing: RunningActivity = {
  icon: "indexing",
  label: "Indexing…",
  detail: "218/302",
};

describe("chipMode", () => {
  it("renders no chip at all for zero running activities", () => {
    expect(chipMode([])).toEqual({ kind: "none" });
  });

  it("gives a single running activity its own chip", () => {
    expect(chipMode([indexing])).toEqual({ kind: "single", activity: indexing });
  });

  it("collapses two runners into a count chip led by the first (priority) icon", () => {
    expect(chipMode([ask, indexing])).toEqual({
      kind: "multi",
      count: 2,
      icon: "ask",
    });
  });

  it("counts all three when everything runs at once", () => {
    expect(chipMode([ask, distill, indexing])).toEqual({
      kind: "multi",
      count: 3,
      icon: "ask",
    });
  });

  // Reflect is a running activity like any other: alone it gets its own chip,
  // and it counts toward the collapsed badge.
  it("gives a lone running reflect its own chip", () => {
    expect(chipMode([reflect])).toEqual({ kind: "single", activity: reflect });
  });

  it("counts a running reflect in the collapsed badge", () => {
    expect(chipMode([distill, reflect])).toEqual({
      kind: "multi",
      count: 2,
      icon: "distill",
    });
    expect(chipMode([ask, distill, reflect, indexing])).toEqual({
      kind: "multi",
      count: 4,
      icon: "ask",
    });
  });
});

// The chip ring fills one notch per chain phase, in run order; an unknown or
// idle step reads as "just started" rather than throwing the ring off.
describe("distillFraction", () => {
  it("walks 0 → <1 across the chain in run order", () => {
    expect(distillFraction("run")).toBe(0);
    expect(distillFraction("digest")).toBeCloseTo(1 / 7);
    expect(distillFraction("resurface")).toBeCloseTo(6 / 7);
    expect(distillFraction("resurface")).toBeLessThan(1);
  });

  it("treats idle as the start", () => {
    expect(distillFraction(null)).toBe(0);
  });
});

// A harvest run only has a number to show once it is past the copy phase.
describe("harvestFraction", () => {
  it("is indeterminate while copying — nothing has been ingested yet", () => {
    expect(
      harvestFraction({ total: 20, done: 0, phase: "copying" }),
    ).toBeUndefined();
  });

  it("is done/total while ingesting", () => {
    expect(harvestFraction({ total: 20, done: 3, phase: "ingesting" })).toBeCloseTo(
      0.15,
    );
    expect(harvestFraction({ total: 20, done: 20, phase: "ingesting" })).toBe(1);
  });

  it("never divides by zero, and never exceeds 1", () => {
    expect(
      harvestFraction({ total: 0, done: 0, phase: "ingesting" }),
    ).toBeUndefined();
    expect(harvestFraction({ total: 2, done: 5, phase: "ingesting" })).toBe(1);
  });

  it("is indeterminate when no run is in flight", () => {
    expect(harvestFraction({ total: 0, done: 0, phase: null })).toBeUndefined();
  });
});

// buildRunning is the single source of live activity in the whole shell: the
// Topbar's own pills cover finished runs only, so whatever this returns IS
// what the bar shows as busy.
describe("buildRunning", () => {
  it("reports nothing when nothing runs — the untouched-store case", () => {
    expect(buildRunning(IDLE, t)).toEqual([]);
  });

  it("surfaces a harvest run with its progress and a real fraction", () => {
    const [activity, ...rest] = buildRunning(
      { ...IDLE, harvest: { total: 20, done: 7, phase: "ingesting" } },
      t,
    );
    expect(rest).toEqual([]);
    expect(activity).toEqual({
      icon: "distill",
      label: t.tb_harvest_running,
      detail: "7/20",
      fraction: 0.35,
    });
  });

  it("names the copy phase instead of showing a number that cannot move", () => {
    const [activity] = buildRunning(
      { ...IDLE, harvest: { total: 20, done: 0, phase: "copying" } },
      t,
    );
    expect(activity.detail).toBe(t.tb_harvest_copying);
    expect(activity.fraction).toBeUndefined();
  });

  it("shows ingest's elapsed time, the ticker the old Topbar pill carried", () => {
    const [activity] = buildRunning(
      { ...IDLE, ingest: { running: true, startedAt: 60_000 - 75_000 } },
      t,
    );
    expect(activity.label).toBe(t.nav_ingest);
    expect(activity.detail).toBe("1:15");
  });

  it("orders every runner by urgency: waiting-on-a-human first, unwatched last", () => {
    const all = buildRunning(
      {
        ask: { busy: true, startedAt: 0 },
        harvest: { total: 20, done: 7, phase: "ingesting" },
        ingest: { running: true, startedAt: 0 },
        lintRunning: true,
        distill: { running: true, step: "maps" },
        reflectRunning: true,
        progress: { key: "links", label: "Linking", done: 2, total: 4 },
        applyingCount: 3,
        reindex: { stage: "indexing", done: 218, total: 302 },
        now: 60_000,
      },
      t,
    );
    expect(all.map((a) => a.label)).toEqual([
      t.nav_query,
      t.tb_harvest_running,
      t.nav_ingest,
      t.tb_lint,
      t.set_distill_running,
      t.rf_running_label,
      "Linking",
      t.tb_activity_applying,
      t.s_embeddings_indexing,
    ]);
    // The collapsed chip counts all of them and wears the leader's icon.
    expect(chipMode(all)).toEqual({ kind: "multi", count: 9, icon: "ask" });
  });

  it("keeps the ordering that predates harvest/ingest/lint joining", () => {
    const some = buildRunning(
      {
        ...IDLE,
        ask: { busy: true, startedAt: 0 },
        distill: { running: true, step: "run" },
        reflectRunning: true,
        reindex: { stage: "loading-model", done: 0, total: 0 },
      },
      t,
    );
    expect(some.map((a) => a.icon)).toEqual([
      "ask",
      "distill",
      "distill",
      "indexing",
    ]);
  });
});
