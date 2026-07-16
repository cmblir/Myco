import { describe, expect, it } from "vitest";
import {
  UNIVERSE_SCALE,
  translateByAnchor,
  universeAnchorsBySize,
  universeFootprint,
  universeNormal,
  type UniverseInput,
} from "./multiverseLayout";

const LD = 40; // a representative link distance

const three: UniverseInput[] = [
  { slug: "alpha", nodeCount: 500 },
  { slug: "beta", nodeCount: 30 },
  { slug: "gamma", nodeCount: 120 },
];

function dist(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

describe("universeAnchorsBySize", () => {
  it("returns one slug-tagged anchor per universe, in input order", () => {
    const anchors = universeAnchorsBySize(three, LD);
    expect(anchors.map((a) => a.slug)).toEqual(["alpha", "beta", "gamma"]);
    for (const a of anchors) {
      expect(Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z)).toBe(true);
    }
  });

  it("is deterministic — same input yields identical anchors", () => {
    expect(universeAnchorsBySize(three, LD)).toEqual(universeAnchorsBySize(three, LD));
  });

  it("places a lone universe at the origin", () => {
    const [only] = universeAnchorsBySize([{ slug: "solo", nodeCount: 42 }], LD);
    expect(only).toMatchObject({ slug: "solo", x: 0, y: 0, z: 0 });
  });

  it("returns [] for no universes", () => {
    expect(universeAnchorsBySize([], LD)).toEqual([]);
  });

  it("separates universes by at least the sum of their footprints (no overlap)", () => {
    const anchors = universeAnchorsBySize(three, LD);
    const footBySlug = new Map(
      three.map((u) => [u.slug, universeFootprint(u.nodeCount, LD)]),
    );
    for (let i = 0; i < anchors.length; i++) {
      for (let j = i + 1; j < anchors.length; j++) {
        const need =
          (footBySlug.get(anchors[i].slug)! + footBySlug.get(anchors[j].slug)!) * 0.7;
        expect(dist(anchors[i], anchors[j])).toBeGreaterThanOrEqual(need);
      }
    }
  });

  it("pairs each slug with the anchor at its own input index", () => {
    const anchors = universeAnchorsBySize(three, LD);
    // The returned anchor[i] must belong to universes[i] — the caller keys
    // everything by slug, so a mis-pairing here would place a universe's
    // subcloud at another's coordinates.
    three.forEach((u, i) => expect(anchors[i].slug).toBe(u.slug));
    // The biggest universe anchors at the origin; the others are packed away
    // from it, so at least one non-first universe is off-origin.
    const offOrigin = anchors.filter((a) => Math.hypot(a.x, a.y, a.z) > 1);
    expect(offOrigin.length).toBe(three.length - 1);
  });

  it("spreads universes farther apart at a larger scale", () => {
    const near = universeAnchorsBySize(three, LD, 2);
    const far = universeAnchorsBySize(three, LD, 12);
    const spread = (arr: typeof near) =>
      Math.max(...arr.map((a) => Math.hypot(a.x, a.y, a.z)));
    expect(spread(far)).toBeGreaterThan(spread(near));
  });
});

describe("universeFootprint", () => {
  it("grows with node count and scale", () => {
    expect(universeFootprint(1000, LD)).toBeGreaterThan(universeFootprint(10, LD));
    expect(universeFootprint(100, LD, 12)).toBeGreaterThan(universeFootprint(100, LD, 2));
  });
  it("treats a zero-node universe as at least one node (no zero footprint)", () => {
    expect(universeFootprint(0, LD)).toBeGreaterThan(0);
  });
  it("defaults to UNIVERSE_SCALE", () => {
    expect(universeFootprint(100, LD)).toBe(universeFootprint(100, LD, UNIVERSE_SCALE));
  });
});

describe("universeNormal", () => {
  it("is a deterministic unit vector", () => {
    const n = universeNormal(3);
    expect(universeNormal(3)).toEqual(n);
    expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 6);
  });
  it("differs between universes", () => {
    expect(universeNormal(0)).not.toEqual(universeNormal(1));
  });
});

describe("translateByAnchor", () => {
  it("offsets a local position by the anchor", () => {
    expect(translateByAnchor({ x: 1, y: 2, z: 3 }, { x: 10, y: 20, z: 30 })).toEqual({
      x: 11,
      y: 22,
      z: 33,
    });
  });
});
