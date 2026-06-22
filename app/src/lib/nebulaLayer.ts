// Faint volumetric-looking nebula/dust layer for the 3D vault "universe".
//
// The cheapest robust gas effect: a handful (<=12) of large additive billboard
// sprites with a procedural radial-gradient texture, placed at the biggest
// community centroids (tinted by that community's star colour) plus a few
// deterministic global clouds. Rendered BEFORE the stars (renderOrder -10) and
// at very low opacity so it stays faint after tone-mapping and can't
// re-introduce the "white wash". One shared texture + per-sprite materials, so
// the whole layer is ~12 cheap draw calls.
//
// Public API mirrors the other scene helpers (construct -> add to scene ->
// update on tick/rebuild -> dispose). Centroids are recomputed from the live
// graph each update (galaxies drift as the sim runs); the call is throttled by
// the caller, and is O(nodes) which is negligible at ~1800.
import * as THREE from "three";
import { seededUnit, type VaultGraph } from "./graphData";

const MAX_COMMUNITY_SPRITES = 8; // biggest galaxies get a tinted cloud
const MIN_MEMBERS = 6; // ignore tiny communities (no visible gas)
const GLOBAL_SPRITES = 4; // faint deep-field filler clouds
const MAX_SPRITES = MAX_COMMUNITY_SPRITES + GLOBAL_SPRITES;

const COMMUNITY_OPACITY = 0.05;
const GLOBAL_OPACITY = 0.035;
const SIZE_MUL = 2.6; // sprite world-size = communityRadius * SIZE_MUL
const SIZE_MIN = 600;
const SIZE_MAX = 2600;
const GLOBAL_SIZE = 3200;
const GLOBAL_SHELL = 1400; // global clouds scattered within this radius of origin

// 256px radial gradient: soft core fading to nothing with a pow falloff so the
// edge has no visible disc/ring. Alpha only (white); the sprite material colour
// carries the community tint.
function makeNebulaTexture(): THREE.Texture {
  const size = 256;
  const cv = document.createElement("canvas");
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext("2d");
  if (ctx) {
    const img = ctx.createImageData(size, size);
    const c = (size - 1) / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x - c) / c;
        const dy = (y - c) / c;
        const r = Math.min(1, Math.hypot(dx, dy));
        // pow(1-r, 2.2) — bright soft core, long faint tail, zero at the rim.
        const a = Math.pow(Math.max(0, 1 - r), 2.2) * 0.5;
        const i = (y * size + x) * 4;
        img.data[i] = 255;
        img.data[i + 1] = 255;
        img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(a * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

interface Centroid {
  x: number;
  y: number;
  z: number;
  radius: number;
  color: THREE.Color;
  members: number;
}

export class NebulaLayer {
  readonly group = new THREE.Group();
  private texture: THREE.Texture;
  private material: THREE.SpriteMaterial; // shared; clones per-sprite for tint
  private sprites: THREE.Sprite[] = [];
  private materials: THREE.SpriteMaterial[] = [];
  private graph: VaultGraph;
  private nodeIds: string[];
  private enabled: boolean;
  // Cache one THREE.Color per distinct community-tint string so update() never
  // allocates a Color per centroid per call. Centroids only read these (copied
  // into the sprite material), never mutate them, so sharing is safe.
  private colorCache = new Map<string, THREE.Color>();

  constructor(graph: VaultGraph, nodeIds: string[], dark: boolean) {
    this.graph = graph;
    this.nodeIds = nodeIds;
    this.enabled = dark; // additive haze only reads on a black void
    this.texture = makeNebulaTexture();
    this.material = new THREE.SpriteMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      fog: true,
      toneMapped: true, // tone-maps with the scene so it never out-glows the cores
    });
    this.group.renderOrder = -10; // behind stars/edges
    this.group.visible = this.enabled;
    // Pre-allocate the sprite pool once; update() repositions/recolours/hides.
    for (let i = 0; i < MAX_SPRITES; i++) {
      const mat = this.material.clone();
      const sp = new THREE.Sprite(mat);
      sp.frustumCulled = false;
      sp.visible = false;
      sp.renderOrder = -10;
      this.materials.push(mat);
      this.sprites.push(sp);
      this.group.add(sp);
    }
    this.update();
  }

  setDark(dark: boolean): void {
    this.enabled = dark;
    this.group.visible = dark;
    if (dark) this.update();
  }

  // Re-snapshot node ids after a rebuild (live-ingest growth), then refresh.
  setNodeIds(nodeIds: string[]): void {
    this.nodeIds = nodeIds;
    this.update();
  }

  // Recompute community centroids from live node positions and lay the sprites
  // over the biggest galaxies + a few deterministic global clouds. O(nodes);
  // the caller throttles how often this runs.
  update(): void {
    if (!this.enabled) return;
    const cents = this.computeCentroids();
    let s = 0;
    for (let i = 0; i < cents.length && s < MAX_COMMUNITY_SPRITES; i++, s++) {
      const c = cents[i];
      const sp = this.sprites[s];
      const mat = this.materials[s];
      const size = THREE.MathUtils.clamp(c.radius * SIZE_MUL, SIZE_MIN, SIZE_MAX);
      sp.position.set(c.x, c.y, c.z);
      sp.scale.set(size, size, 1);
      mat.color.copy(c.color);
      mat.opacity = COMMUNITY_OPACITY;
      sp.visible = true;
    }
    // Global filler clouds — deterministic positions, cool neutral tint, so the
    // deep field isn't a flat void even where no galaxy sits.
    for (let g = 0; g < GLOBAL_SPRITES && s < MAX_SPRITES; g++, s++) {
      const sp = this.sprites[s];
      const mat = this.materials[s];
      const id = `nebula-global-${g}`;
      const theta = seededUnit(id, 30) * Math.PI * 2;
      const phi = Math.acos(2 * seededUnit(id, 31) - 1);
      const r = GLOBAL_SHELL * (0.3 + 0.7 * seededUnit(id, 32));
      const sinPhi = Math.sin(phi);
      sp.position.set(
        Math.cos(theta) * r * sinPhi,
        Math.sin(theta) * r * sinPhi,
        Math.cos(phi) * r,
      );
      sp.scale.set(GLOBAL_SIZE, GLOBAL_SIZE, 1);
      mat.color.setRGB(0.42, 0.5, 0.72); // faint cool dust
      mat.opacity = GLOBAL_OPACITY;
      sp.visible = true;
    }
    // Hide any leftover sprites (fewer communities than the pool).
    for (; s < MAX_SPRITES; s++) this.sprites[s].visible = false;
  }

  // Reuse a cached THREE.Color for a given tint string instead of allocating a
  // fresh one per centroid per update.
  private tintColor(hex: string): THREE.Color {
    let c = this.colorCache.get(hex);
    if (!c) {
      c = new THREE.Color(hex);
      this.colorCache.set(hex, c);
    }
    return c;
  }

  private computeCentroids(): Centroid[] {
    // Single accumulating pass over the nodes. Per-community sums are keyed by
    // community id in one Map of mutable accumulators, so a node touches the
    // hash table once (vs. five separate Map.get/set per node before) and the
    // mean radius no longer needs a fresh O(nodes) scan per community.
    interface Acc {
      cm: number;
      sx: number;
      sy: number;
      sz: number;
      n: number;
      color: string;
      hubColor: boolean; // a hub tint has already been chosen for this community
    }
    const accs = new Map<number, Acc>();
    for (const id of this.nodeIds) {
      const a = this.graph.getNodeAttributes(id);
      if (a.community < 0 || a.hidden) continue;
      const cm = a.community;
      let acc = accs.get(cm);
      if (!acc) {
        acc = { cm, sx: 0, sy: 0, sz: 0, n: 0, color: a.color, hubColor: false };
        accs.set(cm, acc);
      }
      acc.sx += a.x;
      acc.sy += a.y;
      acc.sz += a.z;
      acc.n += 1;
      // Hub colour is the most saturated; first-seen colour is a fine tint.
      // Matches the prior `if (a.isHub || !col.has(cm)) col.set(cm, a.color)`:
      // any hub overrides (last hub wins), otherwise only the first node sets it.
      if (a.isHub) {
        acc.color = a.color;
        acc.hubColor = true;
      } else if (!acc.hubColor && acc.n === 1) {
        acc.color = a.color;
      }
    }
    // Derive each centroid once from its accumulated sums.
    const cents: Centroid[] = [];
    const byCm = new Map<number, Centroid>();
    for (const acc of accs.values()) {
      if (acc.n < MIN_MEMBERS) continue;
      const cent: Centroid = {
        x: acc.sx / acc.n,
        y: acc.sy / acc.n,
        z: acc.sz / acc.n,
        radius: 0, // filled by the radius pass below
        color: this.tintColor(acc.color ?? "#6fb3ff"),
        members: acc.n,
      };
      cents.push(cent);
      byCm.set(acc.cm, cent);
    }
    // Second single O(nodes) pass accumulates each community's mean radius using
    // its now-known centroid (looked up by community id), replacing the former
    // O(communities × nodes) nested rescan.
    const rsum = new Map<number, number>();
    for (const id of this.nodeIds) {
      const a = this.graph.getNodeAttributes(id);
      if (a.community < 0 || a.hidden) continue;
      const cent = byCm.get(a.community);
      if (!cent) continue; // community below MIN_MEMBERS
      rsum.set(
        a.community,
        (rsum.get(a.community) ?? 0) +
          Math.hypot(a.x - cent.x, a.y - cent.y, a.z - cent.z),
      );
    }
    for (const [cm, cent] of byCm) {
      // Mean radius of the community → cloud size scales with the galaxy.
      cent.radius = (rsum.get(cm) ?? 0) / cent.members;
    }
    // Biggest galaxies first.
    cents.sort((a, b) => b.members - a.members);
    return cents;
  }

  dispose(): void {
    for (const m of this.materials) m.dispose();
    this.material.dispose();
    this.texture.dispose();
    this.group.clear();
  }
}
