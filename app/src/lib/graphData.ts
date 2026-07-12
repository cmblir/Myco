// Renderer-agnostic graph data: link/tag/folder filters + graphology graph
// construction. Ported from the cytoscape PageGraph; identical filter
// semantics, but emits a graphology Graph instead of cytoscape elements so
// sigma.js can render it.
import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import type { Adjacency, FileNode } from "./ipc";

// Field-star colour for orphans / tiny groups — a soft cool blue-white that's
// clearly visible on the dark void (the dim theme grey was nearly invisible),
// but still calmer than the saturated community hues so hubs keep their weight.
const FIELD_STAR = "#9aa6c2";

// Cosmic palette — soft-bright hues on black so each connected community reads
// as its own coloured star cluster / nebula region within the galaxy.
// Colour budget (calm-cosmic-web spec A5): ≤6 saturated hues at once. Only the
// 6 largest communities earn a hue; every other community goes neutral field-
// star grey + kelvin variation — the Millennium-render grammar (most matter is
// neutral, a few regions coloured). The in-canvas legend explains the 6.
const PALETTE = [
  "#6fb3ff",
  "#5fe0c0",
  "#ffd27a",
  "#b58cff",
  "#ff9ec4",
  "#ff9e6d",
];

// Group nodes by their parent folder (relative to the vault root) — the
// "folder galaxies" layout unit. Ghost nodes adopt their first real
// neighbour's folder. Returns a louvain-shaped Record (unassigned → -1), or
// null when fewer than two folders have ≥3 members (a flat vault) — callers
// then fall back to Louvain communities.
export function folderGroups(
  ids: string[],
  vaultRoot: string,
  neighborsOf: (id: string) => string[],
): Record<string, number> | null {
  const root = vaultRoot.replace(/[\\/]+$/, "");
  const keyOf = (id: string): string | null => {
    if (id.startsWith("ghost:")) return null;
    let rel = root && id.startsWith(root) ? id.slice(root.length) : id;
    rel = rel.replace(/^[\\/]+/, "");
    const parts = rel.split(/[\\/]/);
    parts.pop(); // file name
    return parts.length > 0 ? parts.join("/") : ".";
  };
  const keys = new Map<string, string>();
  for (const id of ids) {
    const k = keyOf(id);
    if (k != null) keys.set(id, k);
  }
  // Ghosts sit in whatever folder first links to them.
  for (const id of ids) {
    if (keys.has(id)) continue;
    for (const nb of neighborsOf(id)) {
      const k = keys.get(nb);
      if (k != null) {
        keys.set(id, k);
        break;
      }
    }
  }
  const sizes = new Map<string, number>();
  for (const k of keys.values()) sizes.set(k, (sizes.get(k) ?? 0) + 1);
  const sized = [...sizes.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
  if (sized.length < 2) return null;
  const idx = new Map(sized.map((k, i) => [k, i]));
  const out: Record<string, number> = {};
  for (const id of ids) {
    const k = keys.get(id);
    out[id] = (k != null ? idx.get(k) : undefined) ?? -1;
  }
  return out;
}

// Colour nodes by group: folder galaxies when `override` is given, otherwise
// connected community (Louvain). Each group of 3+ nodes gets a distinct
// palette hue (tinted by star temperature); orphans and tiny groups stay dim
// field stars. Also records the community id and the highest-degree node per
// group (the galaxy core "hub") so the layout can clump each group into a
// galaxy and the renderer can bloom its core.
function colorByCommunity(
  graph: VaultGraph,
  maxDeg: number,
  override?: Record<string, number> | null,
): void {
  let comm: Record<string, number>;
  if (override) {
    comm = override;
  } else {
    try {
      comm = louvain(graph) as Record<string, number>;
    } catch {
      // Edgeless graph — no communities. Keep dim but ensure fields are defined.
      graph.forEachNode((id) => {
        graph.setNodeAttribute(id, "community", -1);
        graph.setNodeAttribute(id, "isHub", false);
      });
      return;
    }
  }
  const size = new Map<number, number>();
  for (const id in comm) {
    // Folder overrides mark unassigned nodes -1 — they must not rank.
    if (comm[id] >= 0) size.set(comm[id], (size.get(comm[id]) ?? 0) + 1);
  }
  const ranked = [...size.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .map(([c]) => c);
  const colorOf = new Map<number, string>();
  // No wrap-around: communities ranked past the palette stay hue-less and fall
  // through to the neutral FIELD_STAR base below (they keep their community id
  // for clustering — only the colour goes neutral).
  ranked.slice(0, PALETTE.length).forEach((c, i) => colorOf.set(c, PALETTE[i]));
  const sized = new Set(ranked);
  // Highest-degree node of each sized community = its galaxy core.
  const hubOf = new Map<number, { id: string; deg: number }>();
  graph.forEachNode((id) => {
    const c = comm[id];
    if (!sized.has(c)) return;
    const deg = graph.degree(id);
    const cur = hubOf.get(c);
    if (!cur || deg > cur.deg) hubOf.set(c, { id, deg });
  });
  const hubIds = new Set([...hubOf.values()].map((h) => h.id));
  graph.forEachNode((id) => {
    const c = comm[id];
    const dn = maxDeg > 0 ? graph.degree(id) / maxDeg : 0;
    const isHub = hubIds.has(id);
    const palette = colorOf.get(c);
    // Community stars get the temperature ramp tinted by their hue; orphans /
    // tiny (<3) groups become visible cool field stars (FIELD_STAR + a little
    // per-star temperature variety) instead of the near-invisible dim grey.
    graph.setNodeAttribute(
      id,
      "color",
      tintColor(palette ?? FIELD_STAR, dn, id),
    );
    graph.setNodeAttribute(id, "community", sized.has(c) ? c : -1);
    graph.setNodeAttribute(id, "isHub", isHub);
    // NO per-hub size/intensity floor: flooring every community core to the same
    // size + brightness is exactly what made all clusters look identical. A core
    // blazes ONLY if its GLOBAL degree earns it (power-law pass above). `isHub`
    // remains a grouping/label flag and the cluster-force anchor.
  });
}

export interface AllowFilterOpts {
  tagFilter: string | null;
  folderFilter: string | null;
  vaultRoot: string;
  search: string;
  existingOnly: boolean;
  showOrphans: boolean;
}

export function stem(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export function inFolder(root: string, path: string, folder: string): boolean {
  const trimmed = root.replace(/[\\/]+$/, "");
  if (!path.startsWith(trimmed)) return false;
  const rel = path.slice(trimmed.length).replace(/^[\\/]+/, "");
  return rel.startsWith(`${folder}/`) || rel.startsWith(`${folder}\\`);
}

// Flatten the recursive vault tree into every .md path — including link-less
// files, so orphans render like they do in Obsidian.
export function flattenMarkdown(tree: FileNode[]): string[] {
  const out: string[] = [];
  const walk = (nodes: FileNode[]): void => {
    for (const n of nodes) {
      if (n.kind === "directory") walk(n.children);
      else if (n.path.toLowerCase().endsWith(".md")) out.push(n.path);
    }
  };
  walk(tree);
  return out;
}

export function collectTags(map: Record<string, string[]>): string[] {
  const set = new Set<string>();
  for (const arr of Object.values(map)) for (const t of arr) set.add(t);
  return Array.from(set).sort();
}

export function collectFolders(
  root: string,
  adjacency: Adjacency | null,
): string[] {
  if (!adjacency || !root) return [];
  const trimmed = root.replace(/[\\/]+$/, "");
  const set = new Set<string>();
  const paths = new Set<string>();
  for (const p of Object.keys(adjacency.forward)) paths.add(p);
  for (const arr of Object.values(adjacency.forward)) {
    for (const p of arr) paths.add(p);
  }
  for (const p of Object.keys(adjacency.tags)) paths.add(p);
  for (const p of paths) {
    if (!p.startsWith(trimmed)) continue;
    const rel = p.slice(trimmed.length).replace(/^[\\/]+/, "");
    const idx = rel.indexOf("/");
    if (idx > 0) set.add(rel.slice(0, idx));
  }
  return Array.from(set).sort();
}

export function countAllNodes(adjacency: Adjacency | null): number {
  if (!adjacency) return 0;
  const set = new Set<string>();
  for (const p of Object.keys(adjacency.forward)) set.add(p);
  for (const arr of Object.values(adjacency.forward)) {
    for (const p of arr) set.add(p);
  }
  for (const p of Object.keys(adjacency.tags)) set.add(p);
  return set.size;
}

// The set of node ids that survive the active filters. Two passes: filters
// that don't depend on the surviving subgraph first (tag/folder/search/
// existingOnly), then optionally drop edge-less nodes when orphans are hidden.
export function computeAllowed(
  adjacency: Adjacency,
  allFiles: string[],
  o: AllowFilterOpts,
): Set<string> {
  const all = new Set<string>();
  for (const p of allFiles) all.add(p);
  for (const p of Object.keys(adjacency.forward)) all.add(p);
  for (const targets of Object.values(adjacency.forward)) {
    for (const p of targets) all.add(p);
  }
  for (const p of Object.keys(adjacency.tags)) all.add(p);

  const resolved = new Set<string>(allFiles);
  for (const p of Object.keys(adjacency.forward)) resolved.add(p);
  const needle = o.search.trim().toLowerCase();

  const candidates = new Set<string>();
  for (const p of all) {
    if (o.tagFilter && !(adjacency.tags[p] ?? []).includes(o.tagFilter)) continue;
    if (o.folderFilter && !inFolder(o.vaultRoot, p, o.folderFilter)) continue;
    if (o.existingOnly && !resolved.has(p)) continue;
    if (needle && !stem(p).toLowerCase().includes(needle)) continue;
    candidates.add(p);
  }
  if (o.showOrphans) return candidates;

  const degree = new Map<string, number>();
  for (const [s, ts] of Object.entries(adjacency.forward)) {
    if (!candidates.has(s)) continue;
    for (const t of ts) {
      if (!candidates.has(t)) continue;
      degree.set(s, (degree.get(s) ?? 0) + 1);
      degree.set(t, (degree.get(t) ?? 0) + 1);
    }
  }
  return new Set([...candidates].filter((p) => (degree.get(p) ?? 0) > 0));
}

export interface BuildGraphOpts {
  nodeSize: number; // GraphSettings.nodeSize multiplier
  // Fallback dim colour for nodes outside any sized community. Community hues
  // (colorByCommunity) override it for the rest.
  starDim: string;
  edgeColor: string; // rgba w/ alpha — sigma honors it
  // Render unresolved [[links]] (targets with no file) as dim "ghost" nodes,
  // like Obsidian. Off when existingOnly hides non-existent files.
  showGhosts: boolean;
  // Optional embedding-similarity edges (absolute page paths) to overlay; only
  // pairs whose endpoints both exist and aren't already wikilinked are added.
  semanticEdges?: { source: string; target: string; score: number }[];
  // Folder galaxies (multi-galaxy layout): group nodes by parent folder under
  // vaultRoot instead of Louvain communities. Needs vaultRoot to relativise.
  folderGalaxies?: boolean;
  vaultRoot?: string;
}


// FNV-1a hash of a string → uint32. Math.random is unavailable in some
// sandboxed contexts and would make runs non-reproducible, so all
// pseudo-randomness (seed positions, per-star jitter, temperature) hashes the
// id instead. Deterministic: same vault → same galaxy on every reload.
function hash32(id: string): number {
  let h = 2166136261;
  for (let k = 0; k < id.length; k++) {
    h ^= id.charCodeAt(k);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Deterministic 0..1 stream from (id, salt) — salt picks an independent stream
// so size-jitter, temperature and timelapse spawn don't correlate.
export function seededUnit(id: string, salt = 0): number {
  return (hash32(`${id}:${salt}`) % 100000) / 100000;
}

// Deterministic pseudo-random scatter for seed positions on a SPHERE SHELL —
// the 3D analogue of the old ring scatter. Nodes must NOT start at 0,0,0 or the
// sim explodes; the shell also gives the d3-force-3d layout an immediate
// volumetric spread to relax from.
function seededXYZ(id: string, i: number): { x: number; y: number; z: number } {
  const h = hash32(id);
  const a = (h % 1000) / 1000;
  const b = ((h * 2654435761) % 1000) / 1000;
  const c = ((h * 40503) % 997) / 997;
  const r = 300 + a * 300;
  const theta = b * Math.PI * 2 + i * 0.0001; // azimuth
  const phi = Math.acos(2 * c - 1); // polar angle — uniform over the sphere
  const sinPhi = Math.sin(phi);
  return {
    x: Math.cos(theta) * r * sinPhi,
    y: Math.sin(theta) * r * sinPhi,
    z: Math.cos(phi) * r,
  };
}

// --- Star temperature (deterministic Kelvin→RGB, Tanner-Helland approx) ---
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// Map a node's degree-normalised rank to a stellar colour temperature: faint
// field stars run warm (~3800K), bright hub cores blue-white (~10000K), with a
// little per-star jitter. Returned RGB is normalised so the brightest channel
// is 1 (a tint multiplier, not a darkener).
function kelvinTint(dn: number, id: string): { r: number; g: number; b: number } {
  // Stellar colour-temperature ramp on a steepened rank: the mass of faint
  // field stars sits amber (~3400K) and only the few mega-hubs reach hot
  // blue-white (~11000K). pow(dn,0.5) spreads the ramp across the body so colour
  // variety is visible, not binary. Deterministic ±300K jitter (salt 2).
  const t = Math.pow(dn, 0.5);
  const k = (3400 + t * 7600 + (seededUnit(id, 2) - 0.5) * 600) / 100;
  let r: number;
  let g: number;
  let b: number;
  if (k <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(k) - 161.1195681661;
  } else {
    r = 329.698727446 * Math.pow(k - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(k - 60, -0.0755148492);
  }
  if (k >= 66) b = 255;
  else if (k <= 19) b = 0;
  else b = 138.5177312231 * Math.log(k - 10) - 305.0447927307;
  const cr = clamp(r, 0, 255);
  const cg = clamp(g, 0, 255);
  const cb = clamp(b, 0, 255);
  const mx = Math.max(cr, cg, cb) || 1;
  return { r: cr / mx, g: cg / mx, b: cb / mx };
}

function hexToRgb01(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number): string =>
    clamp(Math.round(v * 255), 0, 255).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

// Blend two #rrggbb colours: t=0 → a, t=1 → b. Used for the disputed warning tint.
function mixHex(a: string, b: string, t: number): string {
  const ca = hexToRgb01(a);
  const cb = hexToRgb01(b);
  if (!ca || !cb) return a;
  return rgbToHex(
    ca.r + (cb.r - ca.r) * t,
    ca.g + (cb.g - ca.g) * t,
    ca.b + (cb.b - ca.b) * t,
  );
}

// Multiply a star's temperature tint into its community hue, keeping the hue
// dominant (so communities stay distinguishable). Non-hex colours (the dim
// field-star fallback) pass through untouched.
function tintColor(hue: string, dn: number, id: string): string {
  const h = hexToRgb01(hue);
  if (!h) return hue;
  // Community HUE leads, so clusters stay visibly different colours (blue /
  // green / amber / …) instead of a monochrome field. Temperature is only a
  // subtle tint (~25%) that adds per-star variety and nudges the hottest cores
  // slightly whiter — degree-keyed temperature alone collapses to one colour
  // because almost every node is low-degree.
  const t = kelvinTint(dn, id);
  const tw = 0.25;
  return rgbToHex(
    h.r * (1 - tw) + h.r * t.r * tw,
    h.g * (1 - tw) + h.g * t.g * tw,
    h.b * (1 - tw) + h.b * t.b * tw,
  );
}

export interface GraphNodeAttrs {
  label: string;
  x: number;
  y: number;
  z: number;
  deg: number;
  size: number;
  color: string;
  community: number; // Louvain community id (≥3 nodes); -1 = field star / orphan
  isHub: boolean; // highest-degree node of its community → galaxy core
  intensity: number; // HDR brightness boost (>1 only for top hubs) for bloom
  hidden?: boolean;
  // Phase 2 — wiki frontmatter encoded into the star's appearance.
  baseAlpha?: number; // confidence → brightness (1 = full; <1 dims low-confidence)
  nodeType?: string; // frontmatter `type` (concept/entity/technique/...)
  confidence?: string;
  status?: string;
  sourceCount?: number;
}
export interface GraphEdgeAttrs {
  color: string;
  size: number;
  kind?: "semantic"; // embedding-similarity overlay edge (dim); absent = wikilink
}
export type VaultGraph = Graph<GraphNodeAttrs, GraphEdgeAttrs>;

export function buildGraph(
  adjacency: Adjacency,
  allowed: Set<string>,
  o: BuildGraphOpts,
): VaultGraph {
  const g: VaultGraph = new Graph({ multi: false, type: "undirected" });

  const ensure = (id: string): void => {
    if (g.hasNode(id)) return;
    const i = g.order;
    const { x, y, z } = seededXYZ(id, i);
    g.addNode(id, {
      label: stem(id),
      x,
      y,
      z,
      deg: 0,
      size: 2, // real size + colour set once degree is known
      color: o.starDim,
      community: -1, // set by colorByCommunity once Louvain runs
      isHub: false,
      intensity: 0,
    });
  };

  for (const [source, targets] of Object.entries(adjacency.forward)) {
    if (!allowed.has(source)) continue;
    ensure(source);
    for (const target of targets) {
      if (!allowed.has(target)) continue;
      ensure(target);
      // Auto edge key (paths can contain spaces, so a manual key would clash).
      // Undirected: hasEdge(s,t) === hasEdge(t,s).
      if (!g.hasEdge(source, target)) {
        g.addEdge(source, target, { color: o.edgeColor, size: 0.6 });
      }
    }
  }
  for (const p of allowed) ensure(p); // isolated/orphan nodes

  // Ghost nodes: [[wikilinks]] to files that don't exist. Obsidian draws these
  // (dimmed) so the graph reflects link INTENT, not only resolved files —
  // without them a vault full of links to not-yet-created notes looks sparse.
  // Keyed by lowercased target so the same missing name from many pages merges
  // into one node; the `ghost:` prefix can't collide with real file-path ids.
  if (o.showGhosts) {
    for (const [source, targets] of Object.entries(adjacency.unresolved)) {
      if (!allowed.has(source)) continue;
      ensure(source);
      for (const t of targets) {
        const gid = `ghost:${t.toLowerCase()}`;
        if (!g.hasNode(gid)) {
          const i = g.order;
          const { x, y, z } = seededXYZ(gid, i);
          g.addNode(gid, {
            label: t,
            x,
            y,
            z,
            deg: 0,
            size: 2,
            color: o.starDim,
            community: -1,
            isHub: false,
            intensity: 0,
          });
        }
        if (!g.hasEdge(source, gid)) {
          g.addEdge(source, gid, { color: o.edgeColor, size: 0.6 });
        }
      }
    }
  }

  // Neural-mesh node treatment: nodes read like neurons — fairly uniform, all
  // faintly lit, sitting ON a dense colored edge mesh that carries the visual
  // weight. Degree gives a gentle hierarchy, NOT a few giant blazing cores.
  let maxDeg = 0;
  g.forEachNode((id) => {
    maxDeg = Math.max(maxDeg, g.degree(id));
  });
  g.forEachNode((id) => {
    const deg = g.degree(id);
    const dn = maxDeg > 0 ? deg / maxDeg : 0;
    const jit = 1 + (seededUnit(id, 1) - 0.5) * 0.36; // ±18% per-star size jitter
    g.setNodeAttribute(id, "deg", deg);
    // Log-degree size scale (calm-cosmic-web spec A6): hub ≈ 2.9× leaf (was
    // ~3.5×). Log compresses the top so a super-hub (an index/MOC linking
    // everything) never balloons over the mesh, while low degrees still step
    // visibly. maxDeg 0 (edgeless vault) would be 0/0 → plain base size.
    const logSize =
      maxDeg > 0 ? 0.85 + (1.6 * Math.log2(1 + deg)) / Math.log2(1 + maxDeg) : 0.85;
    g.setNodeAttribute(id, "size", logSize * o.nodeSize * jit);
    // HDR intensity with a HARD CAP and a steep exponent: only the top ~10% of
    // hubs cross the bloom gate; everything else carries a faint baseline glow.
    // Brightness beyond that is earned by DENSITY (many faint stars overlapping
    // in a nucleus), not by individual HDR — additive overlap sums past any
    // per-sprite cap, so per-sprite HDR stays low (calm-cosmic-web spec).
    g.setNodeAttribute(id, "intensity", Math.min(1.7, 0.22 + Math.pow(dn, 1.8) * 1.5));
  });
  // Colour by community hue + star temperature; store community id + hub flag
  // (needs the degree normalisation above, so it runs AFTER the size pass).
  // Folder galaxies: group by parent folder when the vault has real folder
  // structure; a flat vault falls back to Louvain (null override) — the sim's
  // anchor ring still spreads those communities into separate galaxies.
  const groups =
    o.folderGalaxies && o.vaultRoot
      ? folderGroups(g.nodes(), o.vaultRoot, (id) => g.neighbors(id))
      : null;
  colorByCommunity(g, maxDeg, groups);

  // --- Phase 2: encode wiki frontmatter into the star's appearance ---
  // confidence → brightness (low = fainter star), source_count → extra glow
  // (well-cited pages bloom a touch more), disputed/superseded → a warning amber
  // tint over the community hue so contested pages stand out. Runs after colour +
  // intensity are set so it modulates them. Nodes without meta keep their values.
  const meta = adjacency.meta ?? {};
  g.forEachNode((id) => {
    const m = meta[id];
    if (!m) return;
    if (m.confidence) {
      const a =
        m.confidence === "low" ? 0.55 : m.confidence === "medium" ? 0.8 : 1;
      g.setNodeAttribute(id, "baseAlpha", a);
      g.setNodeAttribute(id, "confidence", m.confidence);
    }
    if (m.sourceCount != null && m.sourceCount > 0) {
      const boost = Math.min(0.3, m.sourceCount * 0.05);
      const cur = g.getNodeAttribute(id, "intensity");
      g.setNodeAttribute(id, "intensity", Math.min(1.8, cur + boost));
      g.setNodeAttribute(id, "sourceCount", m.sourceCount);
    }
    if (m.status) {
      g.setNodeAttribute(id, "status", m.status);
      if (m.status === "disputed" || m.status === "superseded") {
        const c = g.getNodeAttribute(id, "color");
        g.setNodeAttribute(id, "color", mixHex(c, "#ff9e3d", 0.55));
      }
    }
    if (m.type) g.setNodeAttribute(id, "nodeType", m.type);
  });

  // Semantic-similarity overlay edges (dim). Only between existing nodes not
  // already joined by a wikilink, so the overlay adds signal, not duplicates.
  if (o.semanticEdges) {
    for (const e of o.semanticEdges) {
      if (
        g.hasNode(e.source) &&
        g.hasNode(e.target) &&
        !g.hasEdge(e.source, e.target)
      ) {
        g.addEdge(e.source, e.target, {
          color: "rgba(150,130,220,0.28)",
          size: 0.4,
          kind: "semantic",
        });
      }
    }
  }
  return g;
}

// Unweighted shortest path between two nodes (BFS) on the undirected graph.
// Returns the inclusive id sequence [a, …, b], [a] when a === b, or null when
// the nodes are missing or disconnected. Used by the graph's path-highlight.
export function shortestPath(
  g: VaultGraph,
  a: string,
  b: string,
): string[] | null {
  if (!g.hasNode(a) || !g.hasNode(b)) return null;
  if (a === b) return [a];
  const prev = new Map<string, string>();
  const seen = new Set<string>([a]);
  const queue: string[] = [a];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    if (cur === b) break;
    for (const n of g.neighbors(cur)) {
      if (seen.has(n)) continue;
      seen.add(n);
      prev.set(n, cur);
      queue.push(n);
    }
  }
  if (!seen.has(b)) return null;
  const path: string[] = [b];
  let cur = b;
  while (cur !== a) {
    const p = prev.get(cur);
    if (p == null) return null;
    path.push(p);
    cur = p;
  }
  path.reverse();
  return path;
}
