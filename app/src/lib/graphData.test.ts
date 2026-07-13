import { describe, expect, it } from "vitest";
import type { Adjacency, FileNode } from "./ipc";
import {
  buildGraph,
  collectFolders,
  computeAllowed,
  countAllNodes,
  flattenMarkdown,
  inFolder,
  seededUnit,
  shortestPath,
  stem,
} from "./graphData";

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
