// Multi-galaxy layout geometry — pure math shared by the sim worker (anchor +
// disc forces), the scene (per-galaxy spin axes) and tests. When "folder
// galaxies" is on, each node group (folder, or Louvain community on flat
// vaults) is pulled toward its own anchor on a wide shell and flattened into a
// tilted disc, so the vault reads as several separate spiral-ish galaxies.

export interface GalaxyAnchor {
  x: number;
  y: number;
  z: number;
}

// Mirrors the worker's ORBIT_BASE/ORBIT_GROW so a group's internal ring size
// feeds the spacing math (groups must not overlap their neighbours).
export const GALAXY_ORBIT_BASE = 0.35;
export const GALAXY_ORBIT_GROW = 0.07;

// Deterministic 0..1 per index (Numerical Recipes LCG + xorshift mix) — keeps
// the "random" galaxy placement/tilt identical across reloads.
export function galaxySeed(n: number, salt = 0): number {
  let x = ((n + 1) * 1664525 + 1013904223 + salt * 374761393) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519) >>> 0;
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}

// Radius of the anchor shell: grows with the number of galaxies and with the
// largest group's own orbit radius. Deliberately VAST — each folder should sit
// in its own pocket of void, an entirely different galaxy you fly to, not a
// neighbouring clump.
export function galaxyRingRadius(
  count: number,
  linkDistance: number,
  maxGroup: number,
): number {
  // Each top-level folder is its OWN galaxy in its own pocket of deep space —
  // you should have to zoom out to see them all at once. The shell radius is
  // therefore several times the largest galaxy's own radius, so neighbours sit
  // far across the void rather than merging into one mass.
  const groupR =
    linkDistance * (GALAXY_ORBIT_BASE + GALAXY_ORBIT_GROW * Math.sqrt(Math.max(1, maxGroup)));
  // Wide void between galaxies so each folder is a clearly separate island in
  // space (no imposter discs to shrink into any more — the real node clusters
  // are always shown, so generous separation just reads as "zoom out to survey
  // the whole vault").
  return linkDistance * (5 + 3.5 * Math.sqrt(Math.max(1, count))) + groupR * 5;
}

// Anchor points for `count` galaxies: a fibonacci-sphere distribution
// (flattened on y, like a galaxy cluster) so the groups separate from ANY
// camera angle, with a seeded per-galaxy radius wobble so the cluster reads
// as randomly scattered rather than sitting on a perfect shell.
export function galaxyAnchors(
  count: number,
  linkDistance: number,
  maxGroup: number,
): GalaxyAnchor[] {
  if (count <= 0) return [];
  if (count === 1) return [{ x: 0, y: 0, z: 0 }];
  const r = galaxyRingRadius(count, linkDistance, maxGroup);
  const golden = Math.PI * (3 - Math.sqrt(5)); // ≈ 2.39996
  const out: GalaxyAnchor[] = [];
  for (let g = 0; g < count; g++) {
    const y = 1 - (2 * (g + 0.5)) / count; // -1..1 band
    const rh = Math.sqrt(Math.max(0, 1 - y * y));
    const angle = golden * g;
    const wobble = 0.85 + 0.35 * galaxySeed(g, 7); // 0.85×..1.2× shell radius
    out.push({
      x: Math.cos(angle) * rh * r * wobble,
      y: y * r * 0.55 * wobble, // oblate: flatter than a sphere
      z: Math.sin(angle) * rh * r * wobble,
    });
  }
  return out;
}

// A galaxy's own disc radius — how much room its stars occupy. Scales strongly
// with node count so a big folder (e.g. a 2k-note galaxy with ~100 topic
// clusters) occupies a WIDE field with its clusters spread into separate lobes,
// not a cramped ball. Small galaxies stay compact.
export function galaxyFootprint(count: number, linkDistance: number): number {
  // A galaxy's disc radius — big enough that its (now-tight) cluster puffs spread
  // across a filled circle with dark GAPS between them (the dandelion-field
  // look), not crowd into one diffuse mass. Galaxy separation is the shell radius
  // on top of this.
  return linkDistance * (0.6 + 0.32 * Math.sqrt(Math.max(1, count)));
}

// Size-aware galaxy centres: fibonacci-sphere DIRECTIONS (flattened on y) at a
// per-galaxy DISTANCE chosen so (a) no two galaxy FOOTPRINTS overlap and (b) a
// huge galaxy sits farther out than the small ones. `counts` is indexed by
// galaxy id order; the returned anchors match that order.
export function galaxyAnchorsBySize(
  counts: number[],
  linkDistance: number,
): GalaxyAnchor[] {
  const G = counts.length;
  if (G <= 0) return [];
  if (G === 1) return [{ x: 0, y: 0, z: 0 }];
  const foots = counts.map((c) => galaxyFootprint(c, linkDistance));
  const maxFoot = Math.max(...foots);
  const sumFoot = foots.reduce((s, f) => s + f, 0);
  // Shell sized so footprints separate but the whole cluster still fits the
  // view: ~half the summed footprints plus one maxFoot pad. (Flinging galaxies
  // far apart made the fit zoom out until every node was sub-pixel.)
  // Shell radius: big enough that galaxies sit as clearly separate CIRCLES with
  // real void between them (a big central circle + smaller ones around it). Keyed
  // to the biggest footprint (so the dominant folder clears its neighbours) plus
  // a term that grows with galaxy count so many folders still fan out.
  const baseR = Math.max(linkDistance * 3, maxFoot * 1.3 + sumFoot * 0.15);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const out: GalaxyAnchor[] = [];
  for (let g = 0; g < G; g++) {
    const y = 1 - (2 * (g + 0.5)) / G; // -1..1 band
    const rh = Math.sqrt(Math.max(0, 1 - y * y));
    const angle = golden * g;
    const wobble = 0.9 + 0.2 * galaxySeed(g, 7);
    // Bigger galaxies pushed a touch farther out; still separated by footprints.
    const rg = (baseR + foots[g] * 0.4) * wobble;
    out.push({
      x: Math.cos(angle) * rh * rg,
      y: y * rg * 0.55, // oblate
      z: Math.sin(angle) * rh * rg,
    });
  }
  return out;
}

// Fan a galaxy's clusters within its footprint around the galaxy centre, so a
// multi-cluster galaxy (a flat folder split into topics) separates into lobes
// instead of piling into one ball. A single-cluster galaxy sits dead centre.
// Deterministic per (galaxyIdx, cluster position); clusters spiral out from the
// core so the biggest (index 0) sits near the centre.
export function clusterAnchors(
  center: GalaxyAnchor,
  footprint: number,
  count: number,
  galaxyIdx: number,
): GalaxyAnchor[] {
  if (count <= 1) return [{ ...center }];
  const golden = Math.PI * (3 - Math.sqrt(5));
  const phase = galaxySeed(galaxyIdx, 19) * Math.PI * 2;
  const out: GalaxyAnchor[] = [];
  for (let i = 0; i < count; i++) {
    // 3D oblate spread (fibonacci latitude), NOT a flat x-z plane — a coplanar
    // fan reads as a straight LINE when the galaxy is viewed edge-on.
    const yb = 1 - (2 * (i + 0.5)) / count; // -1..1 latitude
    const rh = Math.sqrt(Math.max(0, 1 - yb * yb));
    const angle = phase + golden * i;
    const rr = footprint * (0.35 + 0.65 * (i / (count - 1))); // spiral outward
    out.push({
      x: center.x + Math.cos(angle) * rh * rr,
      y: center.y + yb * rr * 0.6, // oblate — flatter than a sphere, still 3D
      z: center.z + Math.sin(angle) * rh * rr,
    });
  }
  return out;
}

// Per-galaxy disc normal (unit) — the spin axis. Seeded from the group id so
// worker (disc flattening) and scene (idle rotation) agree without plumbing.
// Biased toward "mostly upright with a random tilt" (|y| ≥ ~0.45) so every
// disc still reads as a galaxy from the default camera instead of edge-on.
export function galaxyNormal(group: number): GalaxyAnchor {
  const theta = galaxySeed(group, 31) * Math.PI * 2;
  // Tilt away from +Y by up to ~63° — never fully edge-on.
  const tilt = galaxySeed(group, 32) * 1.1;
  const s = Math.sin(tilt);
  return { x: Math.cos(theta) * s, y: Math.cos(tilt), z: Math.sin(theta) * s };
}

// Connectivity → size: a densely interlinked group swells into a bigger
// galaxy. Multiplies the worker's per-group orbit ring radius.
export function galaxySizeBoost(members: number, intraEdges: number): number {
  const density = intraEdges / Math.max(1, members);
  return 1 + 0.45 * Math.log2(1 + density);
}
