// Multi-galaxy layout geometry — pure math shared by the sim worker (anchor
// force) and tests. When "folder galaxies" is on, each node group (folder, or
// Louvain community on flat vaults) is pulled toward its own anchor on a wide
// ring, so the vault reads as several separate galaxies instead of one mass.

export interface GalaxyAnchor {
  x: number;
  y: number;
  z: number;
}

// Mirrors the worker's ORBIT_BASE/ORBIT_GROW so a group's internal ring size
// feeds the spacing math (groups must not overlap their neighbours).
export const GALAXY_ORBIT_BASE = 0.35;
export const GALAXY_ORBIT_GROW = 0.07;

// Radius of the anchor ring: grows with the number of galaxies (more room on
// the circle) and with the largest group's own orbit radius (fat galaxies need
// wider separation).
export function galaxyRingRadius(
  count: number,
  linkDistance: number,
  maxGroup: number,
): number {
  const groupR =
    linkDistance * (GALAXY_ORBIT_BASE + GALAXY_ORBIT_GROW * Math.sqrt(Math.max(1, maxGroup)));
  // Tight enough that each galaxy still reads large after fit() frames the
  // whole ring, wide enough that neighbours never merge.
  return linkDistance * (1.1 + 0.7 * Math.sqrt(Math.max(1, count))) + groupR * 1.6;
}

// Anchor points for `count` galaxies: a fibonacci-sphere distribution
// (flattened on y, like a galaxy cluster) so the groups separate from ANY
// camera angle — a flat ring read edge-on from the default camera and the
// galaxies overlapped in projection.
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
    out.push({
      x: Math.cos(angle) * rh * r,
      y: y * r * 0.55, // oblate: flatter than a sphere, deeper than a ring
      z: Math.sin(angle) * rh * r,
    });
  }
  return out;
}
