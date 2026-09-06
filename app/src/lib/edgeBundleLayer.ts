// Bundled inter-community strands (backlog GRAPH-01) — the render half of
// edgeBundles.ts. All raw links between the same two topic clusters collapse
// into ONE glowing arc between the cluster centroids, weight-tiered by link
// count, bowing outward through the void. Individual cross-cluster edges stay
// as the existing near-invisible threads; this layer shows the aggregate
// STRUCTURE the per-cluster packing pushed apart.
//
// Fat lines are screen-space: LineMaterial linewidth is per-material, so the
// strands are batched into three width tiers (thin/medium/thick) — three draw
// calls total, whatever the strand count (aggregateBundles caps it anyway).
// Rebuilt only when the layout settles (cluster centroids are rotation-stable
// under the idle swirl, so per-frame updates would be pure waste).
import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { VaultGraph } from "./graphData";
import {
  aggregateBundles,
  bundleArc,
  bundleTier,
  type BundleSpec,
} from "./edgeBundles";

const ARC_SEGMENTS = 24;
const TIER_WIDTH = [1.5, 3, 5]; // px per tier
// Deliberately QUIET (additive): the strands must whisper structure behind the
// stars — at 0.16+ they wove a bright cocoon around the clusters and re-created
// the very "one glowing mass" impression the separated layout exists to kill.
const TIER_OPACITY = [0.05, 0.08, 0.12];
// Backbone: each topic keeps only its heaviest relations (see edgeBundles.ts).
const MAX_PER_COMMUNITY = 3;
const MIN_LINKS = 4;
const MAX_BUNDLES = 80;

export class EdgeBundleLayer {
  readonly group: THREE.Group;
  private geoms: LineSegmentsGeometry[] = [];
  private mats: LineMaterial[] = [];
  private lines: LineSegments2[] = [];
  private graph: VaultGraph;
  // Bundle topology (which pairs, how heavy) only changes when the graph's
  // EDGES change — not when the layout settles. Cached so the settle-cadence
  // rebuild skips the O(edges) rescan and only re-reads centroids/hues (O(V)).
  private cachedSpecs: BundleSpec[] | null = null;

  constructor(graph: VaultGraph, dark: boolean, w: number, h: number) {
    this.graph = graph;
    this.group = new THREE.Group();
    this.group.renderOrder = -1; // under nodes, over hull fills
    for (let tier = 0; tier < 3; tier++) {
      const geom = new LineSegmentsGeometry();
      const mat = new LineMaterial({
        linewidth: TIER_WIDTH[tier],
        vertexColors: true,
        transparent: true,
        opacity: TIER_OPACITY[tier] * (dark ? 1 : 1.4),
        blending: dark ? THREE.AdditiveBlending : THREE.NormalBlending,
        depthWrite: false,
      });
      mat.resolution.set(w, h);
      const line = new LineSegments2(geom, mat);
      line.frustumCulled = false;
      line.visible = false;
      this.geoms.push(geom);
      this.mats.push(mat);
      this.lines.push(line);
      this.group.add(line);
    }
  }

  setDark(dark: boolean): void {
    for (let tier = 0; tier < 3; tier++) {
      this.mats[tier].opacity = TIER_OPACITY[tier] * (dark ? 1 : 1.4);
      this.mats[tier].blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
      this.mats[tier].needsUpdate = true;
    }
  }

  /** Screen-space lines need the drawing-buffer size (call from onResize). */
  setSize(w: number, h: number): void {
    for (const m of this.mats) m.resolution.set(w, h);
  }

  setVisible(on: boolean): void {
    this.group.visible = on;
  }

  /** Call when the graph's edge set changes (filter rebuild, live ingest) —
   * the next rebuild() re-aggregates instead of reusing the cached topology. */
  markTopologyDirty(): void {
    this.cachedSpecs = null;
  }

  // Recompute strands from the CURRENT node attributes (community centroids +
  // per-community hub hue). Call on settle / atlas apply / filter rebuild.
  rebuild(): void {
    // Community centroid + representative hue from live node attrs.
    const cx = new Map<number, number>();
    const cy = new Map<number, number>();
    const cz = new Map<number, number>();
    const cn = new Map<number, number>();
    const hue = new Map<number, string>();
    this.graph.forEachNode((_id, a) => {
      if (a.community < 0 || a.hidden) return;
      cx.set(a.community, (cx.get(a.community) ?? 0) + a.x);
      cy.set(a.community, (cy.get(a.community) ?? 0) + a.y);
      cz.set(a.community, (cz.get(a.community) ?? 0) + a.z);
      cn.set(a.community, (cn.get(a.community) ?? 0) + 1);
      if (a.isHub || !hue.has(a.community)) hue.set(a.community, a.color);
    });
    if (!this.cachedSpecs) {
      const pairs: { a: number; b: number }[] = [];
      this.graph.forEachEdge((_e, attrs, _s, _t, sa, ta) => {
        // Strand weight = REAL vault links only. Semantic-similarity overlay
        // edges are a visual aid — counting them would grow strands between
        // topics that never cite each other and shift width tiers whenever the
        // overlay toggle flips.
        if (attrs.kind === "semantic") return;
        pairs.push({ a: sa.community, b: ta.community });
      });
      this.cachedSpecs = aggregateBundles(pairs, {
        minCount: MIN_LINKS,
        maxBundles: MAX_BUNDLES,
        maxPerCommunity: MAX_PER_COMMUNITY,
      });
    }
    const bundles = this.cachedSpecs;

    const pos: number[][] = [[], [], []];
    const col: number[][] = [[], [], []];
    const ca = new THREE.Color();
    const cb = new THREE.Color();
    for (const b of bundles) {
      const na = cn.get(b.a);
      const nb = cn.get(b.b);
      if (!na || !nb) continue; // a side is fully hidden/filtered out
      const p0 = { x: cx.get(b.a)! / na, y: cy.get(b.a)! / na, z: cz.get(b.a)! / na };
      const p1 = { x: cx.get(b.b)! / nb, y: cy.get(b.b)! / nb, z: cz.get(b.b)! / nb };
      const arc = bundleArc(p0, p1, ARC_SEGMENTS);
      const tier = bundleTier(b.count);
      ca.set(hue.get(b.a) ?? "#8fa6d8");
      cb.set(hue.get(b.b) ?? "#8fa6d8");
      // Polyline → disjoint segment pairs, colour lerped end-to-end so the
      // strand fades from one community's hue into the other's.
      for (let i = 0; i < ARC_SEGMENTS; i++) {
        const o0 = i * 3;
        const o1 = (i + 1) * 3;
        pos[tier].push(arc[o0], arc[o0 + 1], arc[o0 + 2], arc[o1], arc[o1 + 1], arc[o1 + 2]);
        const t0 = i / ARC_SEGMENTS;
        const t1 = (i + 1) / ARC_SEGMENTS;
        col[tier].push(
          ca.r + (cb.r - ca.r) * t0,
          ca.g + (cb.g - ca.g) * t0,
          ca.b + (cb.b - ca.b) * t0,
          ca.r + (cb.r - ca.r) * t1,
          ca.g + (cb.g - ca.g) * t1,
          ca.b + (cb.b - ca.b) * t1,
        );
      }
    }
    for (let tier = 0; tier < 3; tier++) {
      // LineSegmentsGeometry can't shrink in place — swap a fresh geometry in.
      const fresh = new LineSegmentsGeometry();
      if (pos[tier].length > 0) {
        fresh.setPositions(pos[tier]);
        fresh.setColors(col[tier]);
      }
      this.lines[tier].geometry = fresh;
      this.geoms[tier].dispose();
      this.geoms[tier] = fresh;
      this.lines[tier].visible = pos[tier].length > 0;
    }
  }

  dispose(): void {
    for (const g of this.geoms) g.dispose();
    for (const m of this.mats) m.dispose();
  }
}
