import forceAtlas2 from "graphology-layout-forceatlas2";
import { buildGraph, seededUnit } from "../lib/graphData";
import type { Adjacency } from "../lib/ipc";

export type Look = "terrain" | "ribbon" | "city";
export interface Point {
  x: number;
  y: number;
}
export interface PreviewNode {
  id: string;
  label: string;
  color: string;
  community: number;
  degree: number;
  positions: Record<Look, Point>;
}
export interface PreviewGraph {
  nodes: PreviewNode[];
  edges: { id: string; source: string; target: string }[];
}
export interface GraphInput {
  adjacency: Adjacency;
  allowed: string[];
}
export type GraphResult = { graph: PreviewGraph } | { error: string };

/** Compute graph-driven positions without altering note or relationship identities. */
export function buildPreviewGraph(input: GraphInput): PreviewGraph {
  const graph = buildGraph(input.adjacency, new Set(input.allowed), {
    nodeSize: 1,
    starDim: "#9da9c4",
    edgeColor: "#69758d",
    showGhosts: false,
  });
  const groups = new Map<number, string[]>();
  graph.forEachNode((id, attrs) => {
    const members = groups.get(attrs.community) ?? [];
    members.push(id);
    groups.set(attrs.community, members);
  });
  const communities = [...groups.keys()].sort((a, b) => a - b);
  graph.forEachNode((id, attrs) => {
    const angle =
      (communities.indexOf(attrs.community) / Math.max(1, communities.length)) *
      Math.PI *
      2;
    graph.mergeNodeAttributes(id, {
      x: Math.cos(angle) * 120 + (seededUnit(id, 1) - 0.5) * 80,
      y: Math.sin(angle) * 100 + (seededUnit(id, 2) - 0.5) * 80,
    });
  });
  if (graph.order > 1)
    forceAtlas2.assign(graph, {
      iterations: 220,
      settings: {
        ...forceAtlas2.inferSettings(graph),
        gravity: 0.8,
        scalingRatio: 8,
        linLogMode: true,
        slowDown: 3,
      },
    });
  const centers = new Map<number, Point>();
  for (const [community, ids] of groups) {
    centers.set(community, {
      x:
        ids.reduce((sum, id) => sum + graph.getNodeAttribute(id, "x"), 0) /
        ids.length,
      y:
        ids.reduce((sum, id) => sum + graph.getNodeAttribute(id, "y"), 0) /
        ids.length,
    });
  }
  // Adjacent bands favor actual inter-community relationships, not filename order.
  const weights = new Map<string, number>();
  graph.forEachEdge((_id, _attrs, source, target) => {
    const a = graph.getNodeAttribute(source, "community");
    const b = graph.getNodeAttribute(target, "community");
    for (const key of [`${a}:${b}`, `${b}:${a}`])
      weights.set(key, (weights.get(key) ?? 0) + 1);
  });
  const ordered: number[] = [];
  const remaining = new Set(communities);
  while (remaining.size) {
    const last = ordered[ordered.length - 1];
    const next = [...remaining].sort(
      (a, b) =>
        (weights.get(`${last}:${b}`) ?? 0) -
          (weights.get(`${last}:${a}`) ?? 0) ||
        groups.get(b)!.length - groups.get(a)!.length ||
        a - b,
    )[0];
    ordered.push(next);
    remaining.delete(next);
  }
  const palette = [
    "#b8a0ed",
    "#6ec8b7",
    "#7da9e3",
    "#d8b273",
    "#d998b4",
    "#9dba8a",
  ];
  const spans = new Map<number, number>();
  for (const [community, ids] of groups) {
    const center = centers.get(community)!;
    spans.set(
      community,
      Math.max(
        1,
        ...ids.map((id) =>
          Math.hypot(
            graph.getNodeAttribute(id, "x") - center.x,
            graph.getNodeAttribute(id, "y") - center.y,
          ),
        ),
      ),
    );
  }
  const nodes = graph.mapNodes((id, attrs): PreviewNode => {
    const center = centers.get(attrs.community)!;
    const rank = ordered.indexOf(attrs.community);
    const angle =
      (rank / Math.max(1, communities.length - 1)) * Math.PI * 1.65 -
      Math.PI * 0.85;
    return {
      id,
      label: attrs.label,
      community: attrs.community,
      degree: graph.degree(id),
      color: palette[communities.indexOf(attrs.community) % palette.length],
      positions: {
        terrain: { x: attrs.x, y: attrs.y },
        ribbon: {
          x:
            ((attrs.x - center.x) / spans.get(attrs.community)!) * 95 +
            Math.cos(angle) * 310,
          y:
            ((attrs.y - center.y) / spans.get(attrs.community)!) * 75 +
            Math.sin(angle) * 240,
        },
        city: {
          x: center.x * 1.9 + (attrs.x - center.x) * 0.72,
          y: center.y * 1.9 + (attrs.y - center.y) * 0.72,
        },
      },
    };
  });
  for (const look of ["terrain", "ribbon", "city"] as const) {
    const xs = nodes.map((n) => n.positions[look].x);
    const ys = nodes.map((n) => n.positions[look].y);
    if (!nodes.length) continue;
    const minX = Math.min(...xs),
      maxX = Math.max(...xs);
    const minY = Math.min(...ys),
      maxY = Math.max(...ys);
    const scale = Math.min(
      800 / Math.max(1, maxX - minX),
      540 / Math.max(1, maxY - minY),
    );
    for (const node of nodes)
      node.positions[look] = {
        x: 500 + (node.positions[look].x - (minX + maxX) / 2) * scale,
        y: 350 + (node.positions[look].y - (minY + maxY) / 2) * scale,
      };
  }
  return {
    nodes,
    edges: graph.mapEdges((id, _attrs, source, target) => ({
      id,
      source,
      target,
    })),
  };
}

/** Include only directly connected notes; spatial proximity is not a relationship. */
export function neighborhood(
  graph: PreviewGraph,
  id: string | null,
): Set<string> {
  const members = new Set<string>();
  if (!id) return members;
  members.add(id);
  for (const edge of graph.edges) {
    if (edge.source === id) members.add(edge.target);
    if (edge.target === id) members.add(edge.source);
  }
  return members;
}
