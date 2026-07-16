// Universe-tier layout geometry — the top tier ABOVE galaxies. A "universe" is
// one project/vault; the multiverse view places every registered universe far
// apart in one shared 3D field. Inside a universe the existing galaxy(cluster)
// layout is untouched — this module only positions the universes relative to
// one another (their anchors) and describes each universe's spatial footprint
// so the scene/LOD/imposter tiers can size and frame them.
//
// It deliberately REUSES the galaxy packing math (galaxyAnchorsBySize), just at
// a much larger scale: a universe's node count plays the role a galaxy's node
// count plays one tier down, so the same greedy, seeded, deterministic,
// non-overlapping footprint packing gives universes an organic clumped spread
// instead of an even lattice.

import {
  galaxyAnchorsBySize,
  galaxyFootprint,
  galaxyNormal,
  type GalaxyAnchor,
} from "./galaxyLayout";

export interface UniverseInput {
  slug: string;
  nodeCount: number;
}

export interface UniverseAnchor extends GalaxyAnchor {
  slug: string;
}

// How much bigger a universe's footprint is than a single galaxy of the same
// node count. A universe contains a whole galaxy field, so its subcloud extent
// is several galaxy-radii; scaling the packing's linkDistance by this factor
// spreads universes far enough apart that their subclouds don't overlap. Tuned
// further in the scene tier; exported so imposter/LOD sizing stays in sync.
export const UNIVERSE_SCALE = 6;

// The radius a universe's whole subcloud occupies, at the given link distance.
// Mirrors galaxyFootprint one tier up (× UNIVERSE_SCALE) so imposter discs and
// LOD proximity bands can be sized from the same number the packing uses.
export function universeFootprint(
  nodeCount: number,
  linkDistance: number,
  scale: number = UNIVERSE_SCALE,
): number {
  return galaxyFootprint(Math.max(1, nodeCount), linkDistance * scale);
}

// Size-aware universe centres. Each universe's node count is fed to the galaxy
// packer at UNIVERSE_SCALE × linkDistance, so bigger universes sit farther out
// and no two footprints overlap. Anchors are returned in the SAME order as the
// input and tagged with their slug (the caller keys everything by slug, never
// by index, so a registry reorder can't mis-place a universe).
export function universeAnchorsBySize(
  universes: UniverseInput[],
  linkDistance: number,
  scale: number = UNIVERSE_SCALE,
): UniverseAnchor[] {
  const counts = universes.map((u) => Math.max(1, u.nodeCount));
  const anchors = galaxyAnchorsBySize(counts, linkDistance * scale);
  return universes.map((u, i) => ({ slug: u.slug, ...anchors[i] }));
}

// Per-universe disc tilt (unit normal) — the spin axis of a universe's whole
// field, so neighbouring universes don't all lie in the same plane. Reuses the
// galaxy tilt seeded from the tier index; a distinct salt keeps universe tilts
// from correlating with the galaxy tilts one tier down.
export function universeNormal(index: number): GalaxyAnchor {
  return galaxyNormal(index * 7919 + 104729);
}

// Offset a universe's LOCAL node position (from its own origin-centred sim) into
// multiverse space by its anchor. The per-universe sim runs at its own origin —
// this is the cheap translate that assembles the shared field without one giant
// N-vault force sim (the key performance decision in the proposal).
export function translateByAnchor(
  local: { x: number; y: number; z: number },
  anchor: GalaxyAnchor,
): { x: number; y: number; z: number } {
  return { x: local.x + anchor.x, y: local.y + anchor.y, z: local.z + anchor.z };
}
