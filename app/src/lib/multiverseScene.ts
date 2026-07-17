// Multiverse scene assembly — the glue between the multiverseStore's per-universe
// adjacencies and a single, spatially-separated graphology graph the existing
// GraphScene can render statically (no worker sim, like the atlas layout path).
//
// Kept out of graphData.ts (pure graph construction) and out of the store (state
// only) so the "N universes → one placed graph" orchestration is independently
// unit-testable.

import {
  buildMultiverseGraph,
  computeAllowed,
  type BuildGraphOpts,
  type MultiverseUniverse,
  type VaultGraph,
} from "./graphData";
import type { Adjacency } from "./ipc";
import {
  layoutMultiverse,
  bubbleRadius,
  universeAnchorsByRadius,
} from "./multiverseLayout";

// One universe's inputs to the scene — the subset of the store's UniverseData
// the assembly needs (a loaded adjacency + its root for folder-galaxy grouping).
export interface SceneUniverse {
  slug: string;
  root: string;
  adjacency: Adjacency;
  /** Display title for the bubble label (optional; falls back to the slug). */
  title?: string;
}

export interface AssembledMultiverse {
  graph: VaultGraph;
  // slug → true when that universe contributed at least one node (a universe
  // whose graph filtered to empty is dropped from the anchor packing).
  placed: Set<string>;
}

// Build the placed multiverse graph from loaded per-universe adjacencies:
//   1. filter each universe (computeAllowed) against its own root,
//   2. merge into one graph (buildMultiverseGraph): per-universe galaxies,
//      universe-tagged nodes, namespaced ghosts, offset community ids,
//   3. pack universe anchors by node count and rigidly separate each subcloud
//      (layoutMultiverse) so the universes sit far apart in one field.
// The returned graph carries final world positions; the caller mounts it into a
// GraphScene and calls fit(). Universes with zero surviving nodes are skipped.
export function assembleMultiverse(
  universes: SceneUniverse[],
  o: BuildGraphOpts,
): AssembledMultiverse {
  const built: MultiverseUniverse[] = [];
  for (const u of universes) {
    const allFiles = filesOf(u.adjacency);
    const allowed = computeAllowed(u.adjacency, allFiles, {
      tagFilter: null,
      folderFilter: null,
      vaultRoot: u.root,
      search: "",
      existingOnly: false,
      showOrphans: true,
    });
    if (allowed.size === 0) continue;
    built.push({ slug: u.slug, adjacency: u.adjacency, allowed, vaultRoot: u.root });
  }

  const graph = buildMultiverseGraph(built, o);

  // Measure each universe's cloud from the positions buildMultiverseGraph just
  // produced, and pack by that. Node count is the wrong proxy here: the clouds
  // are seeded onto a fixed shell, so they do not grow with count — packing by
  // count reserved ~99x the room a big vault actually occupies and pushed the
  // others out of frame. This is the same max-distance-from-centroid the bubble
  // layer uses to size the membrane, so the spacing follows what renders.
  const radii = universeRadii(graph);
  const inputs = built
    .filter((u) => (radii.get(u.slug) ?? 0) > 0)
    .map((u) => ({ slug: u.slug, radius: radii.get(u.slug) ?? 0 }));

  const anchors = universeAnchorsByRadius(inputs);
  const placedSlugs = layoutMultiverse(graph, anchors);
  return { graph, placed: new Set(placedSlugs) };
}

/// Each universe's cloud radius: the greatest distance from its centroid to any
/// of its visible nodes.
///
/// This is deliberately the same measurement UniverseBubbleLayer makes to size
/// the membrane — the packing has to be about the thing the user sees, and the
/// last time it was about a predicted node-count footprint instead, the two
/// disagreed by 99x. Hidden nodes are excluded for the same reason: the bubble
/// does not enclose them.
function universeRadii(graph: VaultGraph): Map<string, number> {
  const sum = new Map<string, { x: number; y: number; z: number; n: number }>();
  graph.forEachNode((_id, a) => {
    const slug = a.universe ?? "";
    if (!slug || a.hidden) return;
    const e = sum.get(slug) ?? { x: 0, y: 0, z: 0, n: 0 };
    e.x += a.x;
    e.y += a.y;
    e.z += a.z;
    e.n += 1;
    sum.set(slug, e);
  });
  const centre = new Map<string, { x: number; y: number; z: number }>();
  for (const [slug, e] of sum) {
    centre.set(slug, { x: e.x / e.n, y: e.y / e.n, z: e.z / e.n });
  }
  const out = new Map<string, number>();
  graph.forEachNode((_id, a) => {
    const slug = a.universe ?? "";
    const c = centre.get(slug);
    if (!c || a.hidden) return;
    const d = Math.hypot(a.x - c.x, a.y - c.y, a.z - c.z);
    out.set(slug, Math.max(out.get(slug) ?? 0, d));
  });
  // Return the RENDERED bubble radius, not the raw cloud extent: that is the
  // sphere the packing has to leave room for (and it floors a one-note universe
  // into a real bubble rather than a point).
  for (const [slug, r] of out) out.set(slug, bubbleRadius(r));
  return out;
}

// The universe a node belongs to — the graph carries it as an attribute. Ghost
// and real nodes are both tagged by buildMultiverseGraph. Returns "" when the
// node is missing or untagged (should not happen for an assembled graph).
export function universeOfNode(graph: VaultGraph, id: string): string {
  if (!graph.hasNode(id)) return "";
  return graph.getNodeAttribute(id, "universe") ?? "";
}

// Every id referenced by an adjacency (sources, forward targets, tag holders) —
// mirrors the union computeAllowed builds its candidate set from, so a universe
// with only resolved-link nodes still contributes its files.
function filesOf(adjacency: Adjacency): string[] {
  const set = new Set<string>();
  for (const p of Object.keys(adjacency.forward)) set.add(p);
  for (const targets of Object.values(adjacency.forward)) {
    for (const p of targets) set.add(p);
  }
  for (const p of Object.keys(adjacency.tags)) set.add(p);
  return [...set];
}

// The scene's rebuild key.
//
// The scene is expensive to build, so it rebuilds only when the multiverse's
// CONTENT changes. Slugs alone cannot say that: re-entering the multiverse
// reloads every universe, and a vault edited in between comes back with the
// same slug and new content. Identity is the signal — the store commits a new
// adjacency object exactly when the graph changed (loadUniverse and
// refreshUniverse both guard on sameJSON) — so the key tracks identity, per
// universe, and the scene sees edits made while the user was inside a vault.
const adjIds = new WeakMap<object, number>();
let nextAdjId = 0;

function adjId(adjacency: object): number {
  let id = adjIds.get(adjacency);
  if (id === undefined) {
    id = ++nextAdjId;
    adjIds.set(adjacency, id);
  }
  return id;
}

export function multiverseSceneKey(universes: SceneUniverse[]): string {
  return (
    universes.map((u) => `${u.slug}:${adjId(u.adjacency)}`).join("|") +
    "#" +
    universes.length
  );
}
