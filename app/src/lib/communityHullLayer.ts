// Community hulls — the Gephi signature for atlas mode: a soft translucent
// filled blob behind each community's nodes, tinted its hue, so the flat map
// reads as coloured territories (like Gephi's convex-hull community fills, but
// rounded). Built as one THREE.Mesh of triangulated convex-hull fans, rebuilt
// when the (static) atlas layout changes.
//
// NORMAL blending only, and only the biggest communities get a fill: the
// first cut drew ALL 71 hulls additively — in the dense middle of a 10k map
// a dozen fills overlapped and stacked to a giant white puck that buried the
// layout. Normal blending converges toward the tint instead of white, and
// capping the count keeps territories readable as territories.
import * as THREE from "three";
import type { VaultGraph } from "./graphData";

// Only the biggest communities read as "territories" — a fill for every tiny
// topic just shingles the map. Gephi maps typically shade a handful too.
const MAX_HULLS = 12;

// 2D convex hull (monotonic chain) — pure, unit-tested. Returns hull points
// CCW; fewer than 3 unique points returns them as-is.
export function convexHull(
  pts: { x: number; y: number }[],
): { x: number; y: number }[] {
  const uniq = Array.from(
    new Map(pts.map((p) => [`${p.x.toFixed(2)},${p.y.toFixed(2)}`, p])).values(),
  ).sort((a, b) => a.x - b.x || a.y - b.y);
  if (uniq.length < 3) return uniq;
  const cross = (o: typeof uniq[0], a: typeof uniq[0], b: typeof uniq[0]): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: typeof uniq = [];
  for (const p of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: typeof uniq = [];
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

export class CommunityHullLayer {
  readonly mesh: THREE.Mesh;
  private geom: THREE.BufferGeometry;
  private mat: THREE.MeshBasicMaterial;
  private graph: VaultGraph;

  constructor(graph: VaultGraph, dark: boolean) {
    this.graph = graph;
    this.geom = new THREE.BufferGeometry();
    this.mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: dark ? 0.08 : 0.12,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geom, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -2; // behind everything (territory fill under stars)
    this.mesh.visible = false;
    this.rebuild();
  }

  setDark(dark: boolean): void {
    this.mat.opacity = dark ? 0.08 : 0.12;
    this.mat.needsUpdate = true;
  }

  setVisible(on: boolean): void {
    this.mesh.visible = on;
    if (on) this.rebuild();
  }

  // Triangulate each community's expanded convex hull into a fan around its
  // centroid, coloured by the community hue. Flat (z from the node plane).
  rebuild(): void {
    const byCm = new Map<number, { x: number; y: number }[]>();
    const hue = new Map<number, string>();
    let z = 0;
    let zn = 0;
    this.graph.forEachNode((_id, a) => {
      if (a.community < 0 || a.hidden) return;
      let arr = byCm.get(a.community);
      if (!arr) byCm.set(a.community, (arr = []));
      arr.push({ x: a.x, y: a.y });
      if (a.isHub || !hue.has(a.community)) hue.set(a.community, a.color);
      z += a.z;
      zn++;
    });
    const planeZ = zn > 0 ? z / zn : 0;
    const pos: number[] = [];
    const col: number[] = [];
    const c = new THREE.Color();
    // Biggest communities only (see MAX_HULLS rationale in the header).
    const chosen = [...byCm.entries()]
      .filter(([, pts]) => pts.length >= 3)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, MAX_HULLS);
    for (const [cm, pts] of chosen) {
      const hull = convexHull(pts);
      if (hull.length < 3) continue;
      // Centroid + slight outward expansion so the fill hugs a bit past nodes.
      let hx = 0;
      let hy = 0;
      for (const p of hull) {
        hx += p.x;
        hy += p.y;
      }
      hx /= hull.length;
      hy /= hull.length;
      const grow = 1.06;
      c.set(hue.get(cm) ?? "#8fa6d8");
      for (let i = 0; i < hull.length; i++) {
        const a1 = hull[i];
        const b1 = hull[(i + 1) % hull.length];
        // triangle: centroid, a, b (expanded)
        pos.push(hx, hy, planeZ);
        pos.push(hx + (a1.x - hx) * grow, hy + (a1.y - hy) * grow, planeZ);
        pos.push(hx + (b1.x - hx) * grow, hy + (b1.y - hy) * grow, planeZ);
        // brighter at centroid, fade to hull edge (via vertex colour)
        col.push(c.r, c.g, c.b);
        col.push(c.r * 0.35, c.g * 0.35, c.b * 0.35);
        col.push(c.r * 0.35, c.g * 0.35, c.b * 0.35);
      }
    }
    this.geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
    this.geom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(col), 3));
    this.geom.attributes.position.needsUpdate = true;
    this.geom.attributes.color.needsUpdate = true;
  }

  dispose(): void {
    this.geom.dispose();
    this.mat.dispose();
  }
}
