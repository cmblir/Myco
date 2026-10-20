// Where myco stops next while it roams (docs/specs/2026-10-02-mascot-roam.md,
// decision 4): a pure, seeded planner over the roam window's own px.

import { describe, expect, it } from "vitest";
import { ROAM_MYCO_PX } from "./roam";
import {
  FLEE_PX,
  POINTER_CLEAR_PX,
  ROAM_EDGE,
  nextStop,
  tooClose,
} from "./roamPlan";
import type { Pt } from "./roamPlan";

// devMock's 14" MacBook Pro under its menu bar, Dock hidden.
const place = { width: 1512, height: 945, notch_left: 617 };
const from: Pt = { x: 640, y: 136 };
const seeds = Array.from({ length: 400 }, (_, i) => i * 7919 + 1);
/** myco's middle, which the pointer rules measure from. */
const middle = (p: Pt) => ({ x: p.x, y: p.y - ROAM_MYCO_PX / 2 });
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

describe("nextStop", () => {
  it("keeps myco whole inside the window, so never over the menu bar above it", () => {
    for (const size of [place, { ...place, width: 800, height: 500 }]) {
      for (const seed of seeds) {
        const p = nextStop(size, from, null, seed);
        expect(p.x - ROAM_MYCO_PX / 2).toBeGreaterThanOrEqual(ROAM_EDGE);
        expect(p.x + ROAM_MYCO_PX / 2).toBeLessThanOrEqual(size.width - ROAM_EDGE);
        expect(p.y - ROAM_MYCO_PX).toBeGreaterThanOrEqual(ROAM_EDGE);
        expect(p.y).toBeLessThanOrEqual(size.height - ROAM_EDGE);
      }
    }
  });

  it("favours the lower part of the screen and its sides", () => {
    const stops = seeds.map((s) => nextStop(place, from, null, s));
    const low = stops.filter((p) => p.y > place.height / 2).length;
    const sides = stops.filter(
      (p) => p.x < place.width / 3 || p.x > (place.width * 2) / 3,
    ).length;
    expect(low / stops.length).toBeGreaterThan(0.75);
    expect(sides / stops.length).toBeGreaterThan(0.6);
    // Favoured, not confined: the middle and the upper part still get some.
    expect(low).toBeLessThan(stops.length);
    expect(sides).toBeLessThan(stops.length);
  });

  it("stops at least 200 px from the pointer", () => {
    for (const pointer of [
      { x: 756, y: 600 },
      { x: 40, y: 900 },
      { x: 1480, y: 880 },
    ]) {
      for (const seed of seeds) {
        const p = nextStop(place, from, pointer, seed);
        expect(dist(middle(p), pointer)).toBeGreaterThanOrEqual(POINTER_CLEAR_PX);
      }
    }
  });

  it("plans around a pointer in the travel corridor, rather than turning after a near landing", () => {
    const start = { x: 300, y: 800 };
    for (const seed of seeds.slice(0, 50)) {
      const first = nextStop(place, start, null, seed);
      if (dist(start, first) < 2 * POINTER_CLEAR_PX) continue;
      const pointer = middle({ x: (start.x + first.x) / 2, y: (start.y + first.y) / 2 });
      const stop = nextStop(place, start, pointer, seed);
      for (let step = 0; step <= 100; step++) {
        const share = step / 100;
        const ground = middle({
          x: start.x + (stop.x - start.x) * share,
          y: start.y + (stop.y - start.y) * share,
        });
        expect(dist(ground, pointer), `seed ${seed}, step ${step}`).toBeGreaterThanOrEqual(FLEE_PX);
      }
    }
  });

  it("moves on: a stop is a real hop or more away", () => {
    for (const seed of seeds) {
      expect(dist(nextStop(place, from, null, seed), from)).toBeGreaterThanOrEqual(160);
    }
  });

  it("in a window too small to clear the pointer, still stops inside it, as far as it can", () => {
    const tiny = { width: 260, height: 220, notch_left: 0 };
    const pointer = { x: 130, y: 110 };
    for (const seed of seeds.slice(0, 50)) {
      const p = nextStop(tiny, { x: 130, y: 200 }, pointer, seed);
      expect(p.x - ROAM_MYCO_PX / 2).toBeGreaterThanOrEqual(ROAM_EDGE);
      expect(p.x + ROAM_MYCO_PX / 2).toBeLessThanOrEqual(tiny.width - ROAM_EDGE);
      expect(p.y).toBeLessThanOrEqual(tiny.height - ROAM_EDGE);
      expect(dist(middle(p), pointer)).toBeGreaterThan(60);
    }
  });

  it("is seeded: the same seed plans the same stop, another seed another", () => {
    expect(nextStop(place, from, null, 42)).toEqual(nextStop(place, from, null, 42));
    const distinct = new Set(seeds.map((s) => JSON.stringify(nextStop(place, from, null, s))));
    expect(distinct.size).toBeGreaterThan(seeds.length * 0.9);
  });
});

describe("tooClose", () => {
  const at: Pt = { x: 300, y: 800 };
  it("flees a pointer within 120 px of myco's middle, and only then", () => {
    expect(tooClose(at, null)).toBe(false);
    expect(tooClose(at, middle(at))).toBe(true);
    expect(tooClose(at, { x: 300 + FLEE_PX - 1, y: 768 })).toBe(true);
    expect(tooClose(at, { x: 300 + FLEE_PX + 1, y: 768 })).toBe(false);
  });
});
