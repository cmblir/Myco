import { describe, expect, it } from "vitest";
import type { Adjacency, FileNode } from "./ipc";
import {
  buildGraph,
  collectFolders,
  communityPalette,
  computeAllowed,
  countAllNodes,
  fieldStar,
  flattenMarkdown,
  folderGroups,
  inFolder,
  seededUnit,
  shortestPath,
  stem,
} from "./graphData";

// --- Colour test helpers (parse #rrggbb → HSL-ish metrics) ---
function toRgb01(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}
function lightness(hex: string): number {
  const { r, g, b } = toRgb01(hex);
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
}
function hueOf(hex: string): number {
  const { r, g, b } = toRgb01(hex);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  if (d === 0) return 0;
  let h: number;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return ((h * 60) % 360 + 360) % 360;
}
function hueDist(a: string, b: string): number {
  const d = Math.abs(hueOf(a) - hueOf(b)) % 360;
  return Math.min(d, 360 - d);
}

const ROOT = "/vault";
const emptyFilters = {
  tagFilter: null as string | null,
  folderFilter: null as string | null,
  vaultRoot: ROOT,
  search: "",
  existingOnly: false,
  showOrphans: true,
};

function adj(partial: Partial<Adjacency>): Adjacency {
  return {
    forward: {},
    backward: {},
    unresolved: {},
    tags: {},
    ...partial,
  };
}

describe("stem", () => {
  it("strips directory and extension", () => {
    expect(stem("/vault/sub/note.md")).toBe("note");
    expect(stem("note.md")).toBe("note");
    expect(stem("note")).toBe("note");
  });

  it("keeps interior dots, ignores leading dot", () => {
    expect(stem("a.b.md")).toBe("a.b");
    expect(stem("/x/.hidden")).toBe(".hidden");
  });
});

describe("inFolder", () => {
  it("matches direct and tolerates trailing slash on root", () => {
    expect(inFolder("/vault", "/vault/sub/x.md", "sub")).toBe(true);
    expect(inFolder("/vault/", "/vault/sub/x.md", "sub")).toBe(true);
  });

  it("rejects files outside the folder or root", () => {
    expect(inFolder("/vault", "/vault/x.md", "sub")).toBe(false);
    expect(inFolder("/vault", "/other/sub/x.md", "sub")).toBe(false);
  });
});

describe("computeAllowed", () => {
  const a = "/vault/a.md";
  const b = "/vault/b.md";
  const orphan = "/vault/orphan.md";

  it("keeps orphans when showOrphans is true", () => {
    const out = computeAllowed(
      adj({ forward: { [a]: [b] } }),
      [a, b, orphan],
      emptyFilters,
    );
    expect(out).toEqual(new Set([a, b, orphan]));
  });

  it("drops edge-less nodes when showOrphans is false", () => {
    const out = computeAllowed(
      adj({ forward: { [a]: [b] } }),
      [a, b, orphan],
      { ...emptyFilters, showOrphans: false },
    );
    expect(out).toEqual(new Set([a, b]));
  });

  it("existingOnly drops unresolved ghost targets", () => {
    const out = computeAllowed(
      adj({ forward: { [a]: ["ghost"] } }),
      [a],
      { ...emptyFilters, existingOnly: true },
    );
    expect(out).toEqual(new Set([a]));
  });

  it("search filters by stem substring", () => {
    const out = computeAllowed(adj({}), [a, b], {
      ...emptyFilters,
      search: "a",
    });
    expect(out).toEqual(new Set([a]));
  });

  it("tagFilter keeps only tagged nodes", () => {
    const out = computeAllowed(adj({ tags: { [a]: ["x"] } }), [a, b], {
      ...emptyFilters,
      tagFilter: "x",
    });
    expect(out).toEqual(new Set([a]));
  });
});

describe("flattenMarkdown / countAllNodes / collectFolders", () => {
  const tree: FileNode[] = [
    { kind: "file", name: "a.md", path: "/vault/a.md" },
    { kind: "file", name: "img.png", path: "/vault/img.png" },
    {
      kind: "directory",
      name: "sub",
      path: "/vault/sub",
      children: [{ kind: "file", name: "c.md", path: "/vault/sub/c.md" }],
    },
  ];

  it("flattenMarkdown returns only .md paths, recursively", () => {
    expect(flattenMarkdown(tree)).toEqual(["/vault/a.md", "/vault/sub/c.md"]);
  });

  it("countAllNodes unions sources, targets, and tagged paths", () => {
    const a = adj({ forward: { "/vault/a.md": ["/vault/b.md"] }, tags: { "/vault/c.md": ["t"] } });
    expect(countAllNodes(a)).toBe(3);
    expect(countAllNodes(null)).toBe(0);
  });

  it("collectFolders lists top-level subfolders under the root", () => {
    const a = adj({ forward: { "/vault/sub/c.md": [], "/vault/top.md": [] } });
    expect(collectFolders(ROOT, a)).toEqual(["sub"]);
  });
});

describe("shortestPath", () => {
  const opts = {
    nodeSize: 1,
    starDim: "#000000",
    edgeColor: "#000000",
    showGhosts: false,
  };
  const a = "/vault/a.md";
  const b = "/vault/b.md";
  const c = "/vault/c.md";
  const d = "/vault/d.md";

  it("finds an unweighted path and handles a === b", () => {
    const g = buildGraph(
      adj({ forward: { [a]: [b], [b]: [c] } }),
      new Set([a, b, c]),
      opts,
    );
    expect(shortestPath(g, a, c)).toEqual([a, b, c]);
    expect(shortestPath(g, a, a)).toEqual([a]);
  });

  it("returns null for disconnected or missing nodes", () => {
    const g = buildGraph(
      adj({ forward: { [a]: [b] } }),
      new Set([a, b, d]),
      opts,
    );
    expect(shortestPath(g, a, d)).toBeNull();
    expect(shortestPath(g, a, "/vault/nope.md")).toBeNull();
  });
});

describe("calm-cosmic-web node encoding", () => {
  const opts = {
    nodeSize: 1,
    starDim: "#000000",
    edgeColor: "#000000",
    showGhosts: false,
  };

  // Channel spread of a #rrggbb colour — saturated community hues spread wide
  // (>0.25), the neutral field-star base stays narrow (<0.25) even after the
  // per-star kelvin tint.
  function spread(hex: string): number {
    const n = parseInt(hex.slice(1), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    return (Math.max(...ch) - Math.min(...ch)) / 255;
  }

  // 8 disjoint triangles → 8 Louvain communities of 3 nodes each.
  function eightCommunities(): ReturnType<typeof buildGraph> {
    const forward: Record<string, string[]> = {};
    const allowed = new Set<string>();
    for (let c = 0; c < 8; c++) {
      const ids = [0, 1, 2].map((k) => `/vault/c${c}-n${k}.md`);
      forward[ids[0]] = [ids[1], ids[2]];
      forward[ids[1]] = [ids[2]];
      for (const id of ids) allowed.add(id);
    }
    return buildGraph(adj({ forward }), allowed, opts);
  }

  it("every sized community gets its OWN distinct saturated hue", () => {
    const g = eightCommunities();
    const byComm = new Map<number, string>();
    g.forEachNode((id) => {
      const comm = g.getNodeAttribute(id, "community");
      if (comm >= 0) byComm.set(comm, g.getNodeAttribute(id, "color"));
    });
    // All 8 folders are sized (≥3) → 8 communities, each coloured (not grey).
    expect(byComm.size).toBe(8);
    for (const color of byComm.values()) {
      expect(spread(color)).toBeGreaterThan(0.1); // has hue, not neutral grey
    }
    // Hues are distinct per galaxy — no two communities share a colour.
    const hubHues = [...byComm.values()];
    expect(new Set(hubHues).size).toBe(hubHues.length);
  });

  it("node size follows the super-linear log-degree scale (hubs pop)", () => {
    const a = "/vault/a.md";
    const b = "/vault/b.md";
    const c = "/vault/c.md";
    const g = buildGraph(
      adj({ forward: { [b]: [a, c] } }),
      new Set([a, b, c]),
      opts,
    );
    const size = (id: string, deg: number, maxDeg: number): number =>
      (0.85 + 2.5 * Math.pow(Math.log2(1 + deg) / Math.log2(1 + maxDeg), 1.25)) *
      (1 + (seededUnit(id, 1) - 0.5) * 0.36);
    expect(g.getNodeAttribute(b, "size")).toBeCloseTo(size(b, 2, 2), 6);
    expect(g.getNodeAttribute(a, "size")).toBeCloseTo(size(a, 1, 2), 6);
  });

  it("edgeless graph keeps sizes finite (no 0/0 from the log scale)", () => {
    const a = "/vault/only.md";
    const g = buildGraph(adj({}), new Set([a]), opts);
    expect(Number.isFinite(g.getNodeAttribute(a, "size"))).toBe(true);
  });
});

describe("seededUnit", () => {
  it("is deterministic for the same (id, salt)", () => {
    expect(seededUnit("node-1", 0)).toBe(seededUnit("node-1", 0));
  });

  it("stays within [0, 1)", () => {
    for (const id of ["a", "b", "longer-id", "x".repeat(50)]) {
      const v = seededUnit(id, 3);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("different salts give independent streams", () => {
    expect(seededUnit("node-1", 0)).not.toBe(seededUnit("node-1", 7));
  });
});

describe("folderGroups (hierarchical galaxies)", () => {
  const noNeighbors = (): string[] => [];
  const lv = (m: Record<string, number>) => (id: string): number => m[id] ?? -1;

  it("subdivides a flat folder into clusters by link community", () => {
    // One flat galaxy "wiki" (no subfolders); Louvain splits it into 2 comms.
    const ids = [
      "/vault/wiki/a.md",
      "/vault/wiki/b.md",
      "/vault/wiki/c.md",
      "/vault/wiki/d.md",
      "/vault/wiki/e.md",
      "/vault/wiki/f.md",
    ];
    const louvain = {
      "/vault/wiki/a.md": 0,
      "/vault/wiki/b.md": 0,
      "/vault/wiki/c.md": 0,
      "/vault/wiki/d.md": 1,
      "/vault/wiki/e.md": 1,
      "/vault/wiki/f.md": 1,
    };
    const g = folderGroups(ids, "/vault", noNeighbors, lv(louvain));
    expect(g).not.toBeNull();
    // Two distinct clusters …
    expect(new Set(ids.map((id) => g!.community[id])).size).toBe(2);
    // … both belonging to the ONE "wiki" galaxy.
    expect(new Set(ids.map((id) => g!.galaxy[id])).size).toBe(1);
  });

  it("keeps subfolder clusters within one galaxy for a nested folder", () => {
    const ids = [
      "/vault/notes/sub1/a.md",
      "/vault/notes/sub1/b.md",
      "/vault/notes/sub1/c.md",
      "/vault/notes/sub2/d.md",
      "/vault/notes/sub2/e.md",
      "/vault/notes/sub2/f.md",
    ];
    // Louvain would merge them, but for a nested galaxy the subfolder wins.
    const louvain = Object.fromEntries(ids.map((id) => [id, 0]));
    const g = folderGroups(ids, "/vault", noNeighbors, lv(louvain));
    expect(g).not.toBeNull();
    expect(new Set(ids.map((id) => g!.community[id])).size).toBe(2);
    expect(new Set(ids.map((id) => g!.galaxy[id])).size).toBe(1);
    expect([...g!.clusterKeyOf.values()].sort()).toEqual([
      "notes/sub1",
      "notes/sub2",
    ]);
  });

  it("puts different top-level folders in different galaxies", () => {
    const ids = [
      "/vault/A/sub/a.md",
      "/vault/A/sub/b.md",
      "/vault/A/sub/c.md",
      "/vault/B/sub/d.md",
      "/vault/B/sub/e.md",
      "/vault/B/sub/f.md",
    ];
    const louvain = Object.fromEntries(ids.map((id) => [id, 0]));
    const g = folderGroups(ids, "/vault", noNeighbors, lv(louvain));
    expect(new Set(ids.map((id) => g!.galaxy[id])).size).toBe(2);
    expect([...g!.galaxyKeyOf.values()].sort()).toEqual(["A", "B"]);
  });

  it("folds clusters under 3 members into field stars (-1)", () => {
    const ids = [
      "/vault/wiki/a.md",
      "/vault/wiki/b.md",
      "/vault/wiki/c.md",
      "/vault/wiki/d.md",
      "/vault/wiki/e.md",
      "/vault/wiki/f.md",
      "/vault/wiki/g.md", // comm 2 …
      "/vault/wiki/h.md", // … only 2 members → folds
    ];
    const louvain = {
      "/vault/wiki/a.md": 0,
      "/vault/wiki/b.md": 0,
      "/vault/wiki/c.md": 0,
      "/vault/wiki/d.md": 1,
      "/vault/wiki/e.md": 1,
      "/vault/wiki/f.md": 1,
      "/vault/wiki/g.md": 2,
      "/vault/wiki/h.md": 2,
    };
    const g = folderGroups(ids, "/vault", noNeighbors, lv(louvain));
    expect(g).not.toBeNull();
    expect(g!.community["/vault/wiki/g.md"]).toBe(-1);
    expect(g!.galaxy["/vault/wiki/g.md"]).toBe(-1);
    // The two full clusters survive.
    expect(new Set(["a", "b", "c", "d", "e", "f"].map((n) => g!.community[`/vault/wiki/${n}.md`])).size).toBe(2);
  });

  it("maps every surviving cluster to its galaxy", () => {
    const ids = [
      "/vault/A/x/a.md",
      "/vault/A/x/b.md",
      "/vault/A/x/c.md",
      "/vault/A/y/d.md",
      "/vault/A/y/e.md",
      "/vault/A/y/f.md",
    ];
    const g = folderGroups(
      ids,
      "/vault",
      noNeighbors,
      lv(Object.fromEntries(ids.map((id) => [id, 0]))),
    )!;
    // Both clusters (A/x, A/y) map to the same single galaxy index.
    const galaxies = new Set([...g.galaxyOfCluster.values()]);
    expect(galaxies.size).toBe(1);
    expect(g.galaxyOfCluster.size).toBe(2); // two clusters mapped
  });
});

describe("communityPalette (base hue per galaxy, shades per cluster)", () => {
  it("gives same-galaxy clusters one hue family, different galaxies different hues", () => {
    // clusters 0,1 → galaxy 0; clusters 2,3 → galaxy 1
    const gOf = new Map([
      [0, 0],
      [1, 0],
      [2, 1],
      [3, 1],
    ]);
    const pal = communityPalette([0, 1, 2, 3], gOf, false);
    // Two clusters of the same galaxy stay in one hue family (close hue).
    expect(hueDist(pal.get(0)!, pal.get(1)!)).toBeLessThan(20);
    expect(hueDist(pal.get(2)!, pal.get(3)!)).toBeLessThan(20);
    // Different galaxies read as clearly different hues.
    expect(hueDist(pal.get(0)!, pal.get(2)!)).toBeGreaterThan(30);
  });

  it("varies lightness between clusters of the same galaxy (shades)", () => {
    const gOf = new Map([
      [0, 0],
      [1, 0],
    ]);
    const pal = communityPalette([0, 1], gOf, false);
    expect(lightness(pal.get(0)!)).not.toBeCloseTo(lightness(pal.get(1)!), 2);
  });

  it("produces dark colours on a light background", () => {
    const gOf = new Map([
      [0, 0],
      [1, 1],
    ]);
    const dark = communityPalette([0, 1], gOf, false);
    const light = communityPalette([0, 1], gOf, true);
    expect(lightness(light.get(0)!)).toBeLessThan(0.5);
    expect(lightness(dark.get(0)!)).toBeGreaterThan(0.55);
  });

  it("falls back to distinct per-cluster hues when there is no galaxy map", () => {
    const pal = communityPalette([0, 1, 2], null, false);
    expect(hueDist(pal.get(0)!, pal.get(1)!)).toBeGreaterThan(20);
    expect(hueDist(pal.get(1)!, pal.get(2)!)).toBeGreaterThan(20);
  });
});

describe("fieldStar (background-aware orphan colour)", () => {
  it("is dark on a light background, cool-light on the dark void", () => {
    expect(lightness(fieldStar(true))).toBeLessThan(0.6);
    expect(lightness(fieldStar(false))).toBeGreaterThan(0.55);
  });
});
