// THE NO-OVERLAP INVARIANT.
//
// "행성 노드는 겹치지 않게끔 해줘. 모든 뷰에서 겹치기 금지." — planet nodes must
// not overlap. A node is drawn as a sprite of radius renderedRadius(size); two
// of them overlap when their centres are closer than r_i + r_j. The app-wide
// contract adds NODE_MARGIN of clear void on top, so each body reads as its
// own disc rather than one just touching its neighbour.
//
// The Survey has ONE layout now (the worker force sim), and it owes the
// invariant through separateLayout — the same deterministic post-process the
// deleted static layouts used to run. That is what is exercised here; the
// per-layout suite went with the layouts.
import { describe, expect, it } from "vitest";
import {
  separateLayout,
  type SizedPoint,
} from "./layoutSeparation";

describe("separateLayout", () => {
  it("resolves a pathological pile — 500 bodies at the exact same point", () => {
    const pts: SizedPoint[] = Array.from({ length: 500 }, () => ({
      x: 0,
      y: 0,
      z: 0,
      size: 1,
    }));
    expect(separateLayout(pts).overlaps).toBe(0);
  });

  it("is deterministic — the same input lays out identically twice", () => {
    const seed = (): SizedPoint[] =>
      Array.from({ length: 400 }, (_, i) => ({
        x: Math.cos(i) * 40,
        y: Math.sin(i * 1.3) * 40,
        z: Math.cos(i * 0.7) * 40,
        size: 0.85 + ((i * 37) % 100) / 100,
      }));
    const a = seed();
    const b = seed();
    separateLayout(a);
    separateLayout(b);
    expect(a).toEqual(b);
  });

  it("leaves an already-valid layout alone (scale 1, no drift)", () => {
    const pts: SizedPoint[] = Array.from({ length: 100 }, (_, i) => ({
      x: i * 200,
      y: 0,
      z: 0,
      size: 1,
    }));
    const before = pts.map((p) => ({ ...p }));
    expect(separateLayout(pts).scale).toBe(1);
    expect(pts).toEqual(before);
  });

  it("dims: 2 never lifts a flat map out of its plane", () => {
    const pts: SizedPoint[] = Array.from({ length: 300 }, (_, i) => ({
      x: (i % 20) * 2,
      y: Math.floor(i / 20) * 2,
      z: 0,
      size: 1,
    }));
    expect(separateLayout(pts, { dims: 2 }).overlaps).toBe(0);
    expect(Math.max(...pts.map((p) => Math.abs(p.z)))).toBe(0);
  });
});
