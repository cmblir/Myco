import { describe, expect, it } from "vitest";
import {
  encodeNode,
  hopsFrom,
  nodeRadius,
  RING_FRESH,
  RING_GAP,
  RING_MAPLESS,
  RING_NONE,
  RING_SEARCH_HIT,
  RING_SELECTED,
  RING_UNRESOLVED,
  type EncNode,
  type EncState,
} from "./graphEncoding";

const DIM = "#8a8983";
const LIVE = "#a78bfa";
const BLUE = "#5ba2ff";

function node(p: Partial<EncNode> = {}): EncNode {
  return {
    id: "/v/wiki/a.md",
    label: "a",
    ghost: false,
    deg: 2,
    backlinks: 1,
    cites: 0,
    ageDays: 138,
    color: BLUE,
    community: 0,
    ...p,
  };
}
function state(p: Partial<EncState> = {}): EncState {
  return {
    sizeBy: "backlinks",
    maxBacklinks: 4,
    hops: null,
    mapless: new Set<number>(),
    search: "",
    selected: null,
    dimColor: DIM,
    liveColor: LIVE,
    ...p,
  };
}

describe("orphans", () => {
  it("rings ghosts, orphans and no-backlink notes; connected notes recede", () => {
    expect(encodeNode(node({ ghost: true, deg: 1 }), "orphans", state()).ring).toBe(
      RING_UNRESOLVED,
    );
    const orphan = encodeNode(node({ deg: 0, backlinks: 0 }), "orphans", state());
    expect(orphan.ring).toBe(RING_GAP);
    expect(orphan.alpha).toBe(1);
    expect(orphan.color).toBe(BLUE);
    expect(encodeNode(node({ deg: 3, backlinks: 0 }), "orphans", state()).ring).toBe(RING_GAP);
    const linked = encodeNode(node(), "orphans", state());
    expect(linked.ring).toBe(RING_NONE);
    expect(linked.alpha).toBeCloseTo(0.22);
    expect(linked.color).not.toBe(BLUE);
  });
});

describe("clusters", () => {
  it("rings members of map-less clusters only, keeps cluster colour", () => {
    const s = state({ mapless: new Set([7]) });
    const mapless = encodeNode(node({ community: 7 }), "clusters", s);
    expect(mapless.ring).toBe(RING_MAPLESS);
    expect(mapless.color).toBe(BLUE);
    expect(mapless.alpha).toBe(1);
    expect(encodeNode(node({ community: 0 }), "clusters", s).ring).toBe(RING_NONE);
    expect(encodeNode(node({ ghost: true, community: 7 }), "clusters", s)).toMatchObject({
      ring: RING_NONE,
      alpha: 0.3,
    });
  });
});

describe("time", () => {
  it("single freshness ramp: ≤30d lit + ringed, ≤90d half, older recedes to dim", () => {
    const fresh = encodeNode(node({ ageDays: 3 }), "time", state());
    expect(fresh.ring).toBe(RING_FRESH);
    expect(fresh.alpha).toBe(1);
    const mid = encodeNode(node({ ageDays: 60 }), "time", state());
    expect(mid.ring).toBe(RING_NONE);
    expect(mid.alpha).toBeCloseTo(0.62);
    const old = encodeNode(node({ ageDays: 9999 }), "time", state());
    expect(old.alpha).toBeCloseTo(0.24);
    expect(old.color).toBe(DIM);
    expect(encodeNode(node({ ageDays: 0 }), "time", state()).color).toBe(LIVE);
  });
});

describe("neighbors", () => {
  it("hop 0 ringed, hop 1 lit, hop 2 dimmed, the rest nearly invisible", () => {
    const s = state({ hops: new Map([["a", 0], ["b", 1], ["c", 2]]) });
    expect(encodeNode(node({ id: "a" }), "neighbors", s)).toMatchObject({
      ring: RING_SELECTED,
      alpha: 1,
    });
    expect(encodeNode(node({ id: "b" }), "neighbors", s)).toMatchObject({
      ring: RING_NONE,
      alpha: 1,
    });
    expect(encodeNode(node({ id: "c" }), "neighbors", s).alpha).toBeCloseTo(0.42);
    expect(encodeNode(node({ id: "d" }), "neighbors", s).alpha).toBeCloseTo(0.09);
  });
  it("with no subject selected nothing is dimmed", () => {
    expect(encodeNode(node(), "neighbors", state()).alpha).toBe(1);
  });
});

describe("search + selection layer", () => {
  it("search is styling only: misses fade, hits light up with ring 6", () => {
    const s = state({ search: "zzz" });
    expect(encodeNode(node({ deg: 0, backlinks: 0 }), "orphans", s).alpha).toBeLessThanOrEqual(
      0.08,
    );
    const hit = encodeNode(node({ label: "Zzz note" }), "orphans", s);
    expect(hit.alpha).toBe(1);
    expect(hit.ring).toBe(RING_SEARCH_HIT);
    // the path never matches — only the note name does
    expect(encodeNode(node({ id: "/v/zzz/a.md" }), "orphans", s).alpha).toBeLessThanOrEqual(0.08);
    // an existing ring is kept over the search ring
    expect(encodeNode(node({ label: "zzz", deg: 0, backlinks: 0 }), "orphans", s).ring).toBe(
      RING_GAP,
    );
  });
  it("selection always wins the ring channel", () => {
    const s = state({ selected: "/v/wiki/a.md" });
    expect(encodeNode(node({ deg: 0, backlinks: 0 }), "orphans", s).ring).toBe(RING_SELECTED);
    expect(encodeNode(node({ ageDays: 1 }), "time", s).ring).toBe(RING_SELECTED);
  });
});

describe("size", () => {
  it("backlinks: sqrt ramp normalised to the corpus max; cites: linear; ghosts fixed", () => {
    expect(nodeRadius(node({ backlinks: 0 }), state())).toBe(3);
    expect(nodeRadius(node({ backlinks: 4 }), state({ maxBacklinks: 4 }))).toBe(13);
    expect(nodeRadius(node({ backlinks: 1 }), state({ maxBacklinks: 4 }))).toBeCloseTo(8);
    expect(nodeRadius(node({ cites: 2 }), state({ sizeBy: "cites" }))).toBeCloseTo(9.8);
    expect(nodeRadius(node({ ghost: true, backlinks: 9 }), state())).toBe(3.5);
  });
});

describe("hopsFrom", () => {
  it("BFS distances capped at max", () => {
    const adj: Record<string, string[]> = { a: ["b"], b: ["a", "c"], c: ["b", "d"], d: ["c"] };
    const h = hopsFrom("a", 2, (id) => adj[id] ?? []);
    expect([...h.entries()]).toEqual([["a", 0], ["b", 1], ["c", 2]]);
  });
});
