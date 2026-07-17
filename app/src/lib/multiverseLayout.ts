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
  galaxyAnchorsByFootprint,
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
// spreads universes far enough apart that their subclouds don't overlap. It has
// to clear not just the footprint math but the fixed ~300–600 world-unit seed
// scatter every universe's local nodes start with (seededXYZ in graphData) —
// which the node-count-driven footprint doesn't see — so a small universe
// (a handful of notes) still lands far from its neighbours. 18 keeps even two
// 3-node universes from overlapping while big vaults sit proportionally farther
// out. Exported so imposter/LOD sizing stays in sync.
export const UNIVERSE_SCALE = 18;

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

/// The rendered radius of a universe's bubble, given the greatest distance from
/// its centroid to any of its stars.
///
/// Lives here, in the pure-math layout module, rather than in the layer that
/// draws it: the packing has to reserve room for the bubble the user actually
/// sees, and when the two were derived separately they disagreed by 99x. The
/// renderer imports this; so does the packing.
///
/// The 1.18 gives the star cloud a little breathing room inside the membrane,
/// and the floor keeps a two-note universe a real bubble rather than a speck.
export const BUBBLE_MIN_RADIUS = 60;
export function bubbleRadius(maxDistanceFromCentre: number): number {
  return Math.max(BUBBLE_MIN_RADIUS, maxDistanceFromCentre * 1.18);
}

/// How much room to give a universe whose cloud measures `radius`.
///
/// The packer lets footprints approach to 0.72 × their sum, so two universes of
/// radius R land ~1.44 × PAD × R apart, centre to centre. 4.2 puts that at ~6 R
/// — roughly two clear bubble-diameters of void between membranes.
///
/// Tuned by looking, not by taste: the packer aims each universe in a seeded
/// random direction, so at close spacing two bubbles that are properly separated
/// in 3D still land on top of each other in PROJECTION from the default camera,
/// and the field reads as one lumpy blob with colliding labels. ~6 R is where
/// three bubbles stay visually distinct while the whole field still frames at a
/// readable size (each bubble ~15% of the view).
const UNIVERSE_PAD = 4.2;

/// Universe centres packed by each cloud's MEASURED radius.
///
/// `universeAnchorsBySize` predicts a footprint from node count, which is what
/// galaxies inside one vault do — their stars really do spread as the count
/// grows. Universe clouds do not: the multiverse seeds every one of them onto
/// the same fixed shell, so a 9,984-note vault and a 16-note vault both render
/// as a ball of radius ~700 (the big one is denser, not wider).
///
/// Packing them by count therefore reserved room nobody occupies — measured on
/// the real three-vault setup, the 10k vault claimed a footprint of 70,361 for
/// a bubble of 713, i.e. 99x, which shoved the other vaults ~74,000 away. At
/// that spread no camera distance shows two bubbles at a readable size: frame
/// them both and each is ~1% of the view; approach one and the rest are dots.
///
/// So pack by what is actually there. The caller measures each cloud from the
/// node positions it just built (the same max-distance-from-centroid the bubble
/// layer uses to size the membrane), and the packing follows the render instead
/// of predicting it.
export function universeAnchorsByRadius(
  universes: { slug: string; radius: number }[],
): UniverseAnchor[] {
  const foots = universes.map((u) => Math.max(1, u.radius) * UNIVERSE_PAD);
  const anchors = galaxyAnchorsByFootprint(foots);
  return universes.map((u, i) => ({ slug: u.slug, ...anchors[i] }));
}

// Per-universe disc tilt (unit normal) — the spin axis of a universe's whole
// field, so neighbouring universes don't all lie in the same plane. Reuses the
// galaxy tilt seeded from the tier index; a distinct salt keeps universe tilts
// from correlating with the galaxy tilts one tier down.
export function universeNormal(index: number): GalaxyAnchor {
  return galaxyNormal(index * 7919 + 104729);
}

// A universe's fixed identity hue (0..360), hashed from its slug so it is
// stable across reloads and independent of how many other projects exist or
// their order (a golden-angle-over-list scheme would reshuffle every hue when a
// project is added/removed). Identity, not geometry, but kept here so all
// per-universe derivations live in one place. FNV-1a over the slug.
export function universeHue(slug: string): number {
  let h = 2166136261;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
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

// Minimal graph shape layoutMultiverse needs — a structural subset of the
// graphology VaultGraph, so this stays testable without a real Graph instance.
export interface PositionableGraph {
  forEachNode(
    cb: (id: string, attrs: { x: number; y: number; z: number; universe?: string }) => void,
  ): void;
  setNodeAttribute(id: string, name: "x" | "y" | "z", value: number): void;
}

// Separate a merged multiverse graph into far-apart universe subclouds. Each
// universe's nodes keep the RELATIVE positions they already have (from their
// own local layout — buildMultiverseGraph's seeded scatter, or a per-universe
// atlas pass the caller ran first) and are translated as a rigid group so that
// universe's centroid lands on its anchor. Mutates x/y/z in place; deterministic
// (no randomness of its own). Nodes whose `universe` has no anchor are left
// untouched. Returns the slugs it placed.
export function layoutMultiverse(
  graph: PositionableGraph,
  anchors: UniverseAnchor[],
): string[] {
  const anchorBySlug = new Map(anchors.map((a) => [a.slug, a]));
  // Per-universe centroid of the current local positions.
  const acc = new Map<string, { x: number; y: number; z: number; n: number }>();
  graph.forEachNode((_id, a) => {
    const slug = a.universe ?? "";
    if (!anchorBySlug.has(slug)) return;
    const c = acc.get(slug) ?? { x: 0, y: 0, z: 0, n: 0 };
    c.x += a.x;
    c.y += a.y;
    c.z += a.z;
    c.n += 1;
    acc.set(slug, c);
  });
  const centroid = new Map<string, GalaxyAnchor>();
  for (const [slug, c] of acc) {
    centroid.set(slug, { x: c.x / c.n, y: c.y / c.n, z: c.z / c.n });
  }
  // Rigidly shift each universe so its centroid sits on its anchor.
  graph.forEachNode((id, a) => {
    const slug = a.universe ?? "";
    const anchor = anchorBySlug.get(slug);
    const c = centroid.get(slug);
    if (!anchor || !c) return;
    graph.setNodeAttribute(id, "x", a.x - c.x + anchor.x);
    graph.setNodeAttribute(id, "y", a.y - c.y + anchor.y);
    graph.setNodeAttribute(id, "z", a.z - c.z + anchor.z);
  });
  return [...centroid.keys()];
}
