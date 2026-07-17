import { describe, expect, it } from "vitest";
import {
  UNIVERSE_SCALE,
  layoutMultiverse,
  translateByAnchor,
  universeAnchorsBySize,
  universeFootprint,
  universeHue,
  universeNormal,
  type PositionableGraph,
  type UniverseAnchor,
  type UniverseInput,
  universeAnchorsByRadius,
  bubbleRadius,
  BUBBLE_MIN_RADIUS,
} from "./multiverseLayout";

// A tiny in-memory PositionableGraph for layoutMultiverse tests — no graphology.
function fakeGraph(
  nodes: { id: string; x: number; y: number; z: number; universe?: string }[],
): PositionableGraph & { get: (id: string) => { x: number; y: number; z: number } } {
  const map = new Map(nodes.map((n) => [n.id, { ...n }]));
  return {
    forEachNode(cb) {
      for (const n of map.values()) cb(n.id, n);
    },
    setNodeAttribute(id, name, value) {
      (map.get(id)! as unknown as Record<string, number>)[name] = value;
    },
    get(id) {
      return map.get(id)!;
    },
  };
}

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

describe("universeHue", () => {
  it("is deterministic and in [0,360)", () => {
    const h = universeHue("karpathy-llm");
    expect(universeHue("karpathy-llm")).toBe(h);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
  });
  it("differs for different slugs and ignores list membership", () => {
    expect(universeHue("alpha")).not.toBe(universeHue("beta"));
    // Not derived from position/order — same slug always same hue.
    expect(universeHue("reading-log")).toBe(universeHue("reading-log"));
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

describe("layoutMultiverse", () => {
  const anchors: UniverseAnchor[] = [
    { slug: "a", x: 0, y: 0, z: 0 },
    { slug: "b", x: 1000, y: 0, z: 0 },
  ];

  it("re-centres each universe's centroid onto its anchor, preserving relative shape", () => {
    // Universe a: two nodes around local (10,0,0); universe b: around (0,0,0).
    const g = fakeGraph([
      { id: "a1", x: 5, y: 0, z: 0, universe: "a" },
      { id: "a2", x: 15, y: 0, z: 0, universe: "a" },
      { id: "b1", x: -3, y: 4, z: 0, universe: "b" },
      { id: "b2", x: 3, y: -4, z: 0, universe: "b" },
    ]);
    const placed = layoutMultiverse(g, anchors);
    expect(placed.sort()).toEqual(["a", "b"]);
    // a's centroid was (10,0,0) → anchor (0,0,0): nodes shift by -10 on x.
    expect(g.get("a1")).toMatchObject({ x: -5, y: 0, z: 0 });
    expect(g.get("a2")).toMatchObject({ x: 5, y: 0, z: 0 });
    // Relative spacing within a preserved (still 10 apart).
    expect(g.get("a2").x - g.get("a1").x).toBe(10);
    // b's centroid was (0,0,0) → anchor (1000,0,0): nodes shift +1000 on x only.
    expect(g.get("b1")).toMatchObject({ x: 997, y: 4, z: 0 });
    expect(g.get("b2")).toMatchObject({ x: 1003, y: -4, z: 0 });
  });

  it("separates universes so their node clouds don't overlap", () => {
    const g = fakeGraph([
      { id: "a1", x: 0, y: 0, z: 0, universe: "a" },
      { id: "b1", x: 0, y: 0, z: 0, universe: "b" },
    ]);
    layoutMultiverse(g, anchors);
    const d = Math.abs(g.get("a1").x - g.get("b1").x);
    expect(d).toBe(1000);
  });

  it("leaves nodes with no matching anchor untouched", () => {
    const g = fakeGraph([{ id: "x", x: 7, y: 8, z: 9, universe: "unknown" }]);
    layoutMultiverse(g, anchors);
    expect(g.get("x")).toMatchObject({ x: 7, y: 8, z: 9 });
  });
});

describe("universeAnchorsByRadius", () => {
  it("packs by measured radius, so a huge vault no longer exiles the others", () => {
    // The real three-vault setup. Every universe's cloud is seeded onto the same
    // fixed shell, so they all render at ~700 regardless of note count — the old
    // count-driven packing gave the 10k vault a 70,361 footprint for its 713
    // bubble and pushed the others ~74,000 away, where no camera distance shows
    // two bubbles at a readable size.
    const anchors = universeAnchorsByRadius([
      { slug: "Memex", radius: 705 },
      { slug: "ObsidianVault", radius: 676 },
      { slug: "demo-10k", radius: 713 },
    ]);
    const by = new Map(anchors.map((a) => [a.slug, a]));
    const dist = (a: string, b: string): number =>
      Math.hypot(by.get(a)!.x - by.get(b)!.x, by.get(a)!.y - by.get(b)!.y, by.get(a)!.z - by.get(b)!.z);

    // Nothing overlaps...
    expect(dist("Memex", "demo-10k")).toBeGreaterThan(705 + 713);
    expect(dist("Memex", "ObsidianVault")).toBeGreaterThan(705 + 676);
    // ...and the whole field stays within a few bubble-diameters, so they frame
    // together. The old packing put this above 70,000.
    const extent = Math.max(
      dist("Memex", "demo-10k"),
      dist("Memex", "ObsidianVault"),
      dist("ObsidianVault", "demo-10k"),
    );
    expect(extent).toBeLessThan(12_000);
  });

  it("ignores note count entirely — only the rendered radius matters", () => {
    // Two universes of equal radius must be packed identically no matter how
    // many notes are inside them; that is the whole correction.
    const a = universeAnchorsByRadius([
      { slug: "tiny", radius: 700 },
      { slug: "huge", radius: 700 },
    ]);
    expect(Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y, a[0].z - a[1].z)).toBeGreaterThan(1400);
  });

  it("is deterministic across calls", () => {
    const input = [
      { slug: "a", radius: 700 },
      { slug: "b", radius: 120 },
      { slug: "c", radius: 900 },
    ];
    expect(universeAnchorsByRadius(input)).toEqual(universeAnchorsByRadius(input));
  });

  it("gives a lone universe the origin", () => {
    expect(universeAnchorsByRadius([{ slug: "only", radius: 700 }])).toEqual([
      { slug: "only", x: 0, y: 0, z: 0 },
    ]);
  });
});

describe("bubbleRadius", () => {
  it("pads the cloud and floors a tiny universe", () => {
    expect(bubbleRadius(1000)).toBeCloseTo(1180);
    // A one-note universe has zero extent but must still be a real bubble —
    // and the packing must reserve room for that same floor, which is why the
    // renderer and the layout share this function.
    expect(bubbleRadius(0)).toBe(BUBBLE_MIN_RADIUS);
  });
});
