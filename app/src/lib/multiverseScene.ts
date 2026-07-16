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
  universeAnchorsBySize,
  type UniverseInput,
} from "./multiverseLayout";

// One universe's inputs to the scene — the subset of the store's UniverseData
// the assembly needs (a loaded adjacency + its root for folder-galaxy grouping).
export interface SceneUniverse {
  slug: string;
  root: string;
  adjacency: Adjacency;
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
  linkDistance: number,
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

  // Node count per universe from the merged graph (post-filter, incl. ghosts) —
  // the honest size to pack by, matching what actually renders.
  const counts = new Map<string, number>();
  graph.forEachNode((_id, a) => {
    const slug = a.universe ?? "";
    counts.set(slug, (counts.get(slug) ?? 0) + 1);
  });
  const inputs: UniverseInput[] = built
    .filter((u) => (counts.get(u.slug) ?? 0) > 0)
    .map((u) => ({ slug: u.slug, nodeCount: counts.get(u.slug) ?? 0 }));

  const anchors = universeAnchorsBySize(inputs, linkDistance);
  const placedSlugs = layoutMultiverse(graph, anchors);
  return { graph, placed: new Set(placedSlugs) };
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
