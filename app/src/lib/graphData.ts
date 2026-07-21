// Renderer-agnostic graph data: link/tag/folder filters + graphology graph
// construction. Ported from the cytoscape PageGraph; identical filter
// semantics, but emits a graphology Graph instead of cytoscape elements so
// sigma.js can render it.
import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import type { Adjacency, FileNode } from "./ipc";

// Field-star colour for orphans / tiny clusters. On the dark void a soft cool
// blue-white reads clearly; on a light (white-skin) background that would vanish
// into the paper, so light mode uses a dark cool grey instead.
export function fieldStar(lightBg: boolean): string {
  return lightBg ? "#5a6478" : "#9aa6c2";
}

// Cosmic palette as HUE DEGREES so per-cluster shades and the light-vs-dark
// background variants all derive from one source (blue / teal / amber / purple /
// pink / orange). The first galaxies take these curated hues; beyond that,
// golden-angle hues so no two galaxies collide.
const PALETTE_HUES = [212, 163, 40, 262, 338, 20];

// The Gephi/sigma.js palette: a full-spectrum wheel at high saturation — the
// vivid categorical look of the classic hairball, where each community is an
// unmistakable pure hue (red / orange / yellow / green / cyan / blue / violet /
// magenta), not the calm cosmic pastels. Used only for the "vivid" mode (sigma
// skin). Beyond these, golden-angle keeps later clusters distinct.
const VIVID_HUES = [0, 32, 52, 120, 168, 200, 264, 300, 16, 90, 320, 224];

function goldenHueDeg(rank: number): number {
  return (rank * 137.508) % 360; // golden angle — well-spread hues
}

// A cluster's colour: its galaxy's base hue, shaded by `t` ∈ [-0.5, 0.5] (the
// cluster's position within the galaxy) so same-galaxy clusters read as one hue
// family in different shades. Light backgrounds get darker, more saturated
// colours so the nodes stand out on paper instead of washing out. `vivid` is the
// Gephi board look: near-full saturation, mid lightness — pure categorical
// colour on the charcoal board (the pastels read as washed there).
function shadeHex(hueDeg: number, t: number, lightBg: boolean, vivid = false): string {
  const sat = vivid ? 0.92 : lightBg ? 0.72 : 0.62;
  const baseL = vivid ? 0.56 : lightBg ? 0.4 : 0.68;
  const spread = vivid ? 0.12 : lightBg ? 0.2 : 0.22;
  const l = Math.min(0.85, Math.max(0.16, baseL + t * spread));
  return hslToHex(((hueDeg % 360) + 360) % 360, sat, l);
}

// Map each sized cluster index → its OWN distinct hex colour. Every cluster —
// even sub-clusters of the same galaxy — gets a separate hue (curated palette
// first, then golden-angle) so each legend row and each on-screen clump reads as
// its own group. Light backgrounds get the dark, saturated variant so nodes
// stand out on paper instead of washing out. `vivid` swaps in the Gephi wheel.
export function communityPalette(
  clusters: number[],
  lightBg: boolean,
  vivid = false,
): Map<number, string> {
  const hues = vivid ? VIVID_HUES : PALETTE_HUES;
  const out = new Map<number, string>();
  clusters.forEach((c, i) => {
    const hue = i < hues.length ? hues[i] : goldenHueDeg(i);
    out.set(c, shadeHex(hue, 0, lightBg, vivid));
  });
  return out;
}

export function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] :
    h < 120 ? [x, c, 0] :
    h < 180 ? [0, c, x] :
    h < 240 ? [0, x, c] :
    h < 300 ? [x, 0, c] : [c, 0, x];
  const to = (v: number): string =>
    Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

// Two-level grouping for the folder-galaxies layout:
//   galaxy  = top-level folder under the vault root (spatial + legend parent)
//   community (cluster) = the coloured/legend/force sub-unit within a galaxy
export interface FolderGrouping {
  community: Record<string, number>; // cluster idx; -1 = field star / orphan
  galaxy: Record<string, number>; // galaxy idx; -1 = field star / orphan
  clusterKeyOf: Map<number, string>; // cluster idx → its key (sub-folder path or flat tag)
  galaxyKeyOf: Map<number, string>; // galaxy idx → top-level folder key
  galaxyOfCluster: Map<number, number>; // cluster idx → galaxy idx
}

// Group nodes into the galaxy/cluster hierarchy. A galaxy's clusters are
// HYBRID: the sub-folder path when the galaxy has real sub-folders, otherwise
// the node's Louvain community — so a big FLAT folder (e.g. a 10k-note wiki/)
// still splits into its topic clusters instead of one undifferentiated blob.
// Ghost nodes adopt their first real neighbour's folder. Clusters with <3
// members fold into field stars (-1). Returns null when fewer than two clusters
// survive (a truly flat/tiny vault) so callers fall back to plain Louvain.
export function folderGroups(
  ids: string[],
  vaultRoot: string,
  neighborsOf: (id: string) => string[],
  louvainOf: (id: string) => number,
): FolderGrouping | null {
  const root = vaultRoot.replace(/[\\/]+$/, "");
  // Folder-path parts of a node (relative to root, filename dropped). null=ghost.
  const partsOf = (id: string): string[] | null => {
    if (id.startsWith("ghost:")) return null;
    let rel = root && id.startsWith(root) ? id.slice(root.length) : id;
    rel = rel.replace(/^[\\/]+/, "");
    const parts = rel.split(/[\\/]/);
    parts.pop(); // file name
    return parts;
  };
  const parts = new Map<string, string[]>();
  for (const id of ids) {
    const p = partsOf(id);
    if (p) parts.set(id, p);
  }
  // Ghosts sit in whatever folder first links to them.
  for (const id of ids) {
    if (parts.has(id)) continue;
    for (const nb of neighborsOf(id)) {
      const p = parts.get(nb);
      if (p) {
        parts.set(id, p);
        break;
      }
    }
  }
  const galaxyKeyFor = (p: string[]): string => (p.length > 0 ? p[0] : ".");
  const subKeyFor = (p: string[]): string => p.join("/"); // full sub-folder path
  // Per galaxy, tally members by sub-folder path. A galaxy clusters by sub-folder
  // ONLY when its sub-folders actually split it into >=2 sized (>=3) groups. A
  // galaxy whose files all sit in ONE sub-folder (e.g. a 10k-note demo/wiki/)
  // cannot be split that way, so it is treated as flat and subdivided by Louvain
  // topic instead — the whole point of the hybrid.
  const subCounts = new Map<string, Map<string, number>>();
  for (const p of parts.values()) {
    const gk = galaxyKeyFor(p);
    let m = subCounts.get(gk);
    if (!m) subCounts.set(gk, (m = new Map()));
    const sk = subKeyFor(p);
    m.set(sk, (m.get(sk) ?? 0) + 1);
  }
  const nested = new Set<string>();
  for (const [gk, m] of subCounts) {
    let sized = 0;
    for (const c of m.values()) if (c >= 3) sized++;
    if (sized >= 2) nested.add(gk);
  }
  const clusterKeyFor = (id: string, p: string[]): string => {
    const gk = galaxyKeyFor(p);
    return nested.has(gk) ? subKeyFor(p) : `${gk}/${louvainOf(id)}`;
  };
  const clusterKey = new Map<string, string>();
  const galaxyKey = new Map<string, string>();
  for (const id of ids) {
    const p = parts.get(id);
    if (!p) continue;
    galaxyKey.set(id, galaxyKeyFor(p));
    clusterKey.set(id, clusterKeyFor(id, p));
  }
  // Size clusters; keep only those with >=3 members (stable order for colours).
  const sizes = new Map<string, number>();
  for (const k of clusterKey.values()) sizes.set(k, (sizes.get(k) ?? 0) + 1);
  const sized = [...sizes.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([k]) => k);
  if (sized.length < 2) return null;
  const clusterIdx = new Map(sized.map((k, i) => [k, i]));
  // Which galaxy owns each surviving cluster.
  const galaxyKeyOfClusterKey = new Map<string, string>();
  for (const id of ids) {
    const ck = clusterKey.get(id);
    if (ck != null && clusterIdx.has(ck) && !galaxyKeyOfClusterKey.has(ck)) {
      galaxyKeyOfClusterKey.set(ck, galaxyKey.get(id)!);
    }
  }
  const galaxyIdx = new Map<string, number>();
  for (const ck of sized) {
    const gk = galaxyKeyOfClusterKey.get(ck)!;
    if (!galaxyIdx.has(gk)) galaxyIdx.set(gk, galaxyIdx.size);
  }
  const community: Record<string, number> = {};
  const galaxy: Record<string, number> = {};
  for (const id of ids) {
    const ck = clusterKey.get(id);
    const ci = ck != null ? clusterIdx.get(ck) : undefined;
    if (ci == null) {
      community[id] = -1;
      galaxy[id] = -1;
      continue;
    }
    community[id] = ci;
    galaxy[id] = galaxyIdx.get(galaxyKeyOfClusterKey.get(ck!)!)!;
  }
  const clusterKeyOf = new Map<number, string>();
  for (const [k, i] of clusterIdx) clusterKeyOf.set(i, k);
  const galaxyKeyOf = new Map<number, string>();
  for (const [k, i] of galaxyIdx) galaxyKeyOf.set(i, k);
  const galaxyOfCluster = new Map<number, number>();
  for (const [ck, ci] of clusterIdx) {
    galaxyOfCluster.set(ci, galaxyIdx.get(galaxyKeyOfClusterKey.get(ck)!)!);
  }
  return { community, galaxy, clusterKeyOf, galaxyKeyOf, galaxyOfCluster };
}

export interface LegendCluster {
  cm: number; // community (cluster) id — the isolate key
  color: string;
  label: string;
  count: number;
}
export interface LegendGalaxy {
  g: number; // galaxy id; -1 = folder galaxies off / Louvain → render headerless
  label: string; // top-level folder name ("" when g === -1)
  color: string; // base swatch (its biggest cluster's colour)
  count: number; // total member count
  clusters: LegendCluster[]; // top clusters by size (capped)
  more: number; // clusters beyond the cap, not shown
}

// Build the two-level legend (galaxy → clusters) from node summaries. Galaxies
// rank by size; within each, clusters rank by size and are capped (the rest are
// counted in `more`). A node whose galaxy is -1 (folder galaxies off / Louvain)
// lands in a single headerless galaxy so the legend still renders a flat list.
export function buildLegend(
  nodes: {
    id: string;
    community: number;
    galaxy: number;
    color: string;
    deg: number;
  }[],
  vaultRoot: string,
  opts?: { maxGalaxies?: number; maxClusters?: number },
): LegendGalaxy[] {
  const maxGalaxies = opts?.maxGalaxies ?? 8;
  const maxClusters = opts?.maxClusters ?? 6;
  const root = vaultRoot.replace(/[\\/]+$/, "");
  const topFolder = (id: string): string => {
    let rel = root && id.startsWith(root) ? id.slice(root.length) : id;
    rel = rel.replace(/^[\\/]+/, "");
    const parts = rel.split(/[\\/]/);
    return parts.length > 1 ? parts[0] : "";
  };
  interface CAcc {
    count: number;
    color: string;
    label: string;
    topDeg: number;
  }
  interface GAcc {
    count: number;
    label: string;
    clusters: Map<number, CAcc>;
  }
  const gal = new Map<number, GAcc>();
  for (const n of nodes) {
    if (n.community < 0) continue;
    let G = gal.get(n.galaxy);
    if (!G) {
      G = { count: 0, label: topFolder(n.id), clusters: new Map() };
      gal.set(n.galaxy, G);
    }
    G.count += 1;
    let c = G.clusters.get(n.community);
    if (!c) {
      c = { count: 0, color: n.color, label: stem(n.id), topDeg: -1 };
      G.clusters.set(n.community, c);
    }
    c.count += 1;
    // Legend row named + coloured after the cluster's highest-degree node (its
    // galaxy-core hub) — the demo's topic hubs (quantization, gan, …) surface.
    if (n.deg > c.topDeg) {
      c.topDeg = n.deg;
      c.label = stem(n.id);
      c.color = n.color;
    }
  }
  return [...gal.entries()]
    .map(([g, G]) => {
      const clusters = [...G.clusters.entries()]
        .map(([cm, c]) => ({ cm, color: c.color, label: c.label, count: c.count }))
        .sort((a, b) => b.count - a.count);
      const shown = clusters.slice(0, maxClusters);
      return {
        g,
        label: G.label,
        color: shown[0]?.color ?? fieldStar(false),
        count: G.count,
        clusters: shown,
        more: clusters.length - shown.length,
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, maxGalaxies);
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
  colorOpts?: { lightBg?: boolean; vivid?: boolean },
): void {
  const lightBg = colorOpts?.lightBg ?? false;
  const vivid = colorOpts?.vivid ?? false;
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
  // A distinct hue per cluster (light backgrounds get the dark variant; the
  // sigma board gets the vivid Gephi wheel).
  const colorOf = communityPalette(ranked, lightBg, vivid);
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
    // tiny (<3) groups become visible field stars (dark on light bg, cool blue-
    // white on the void) instead of the near-invisible dim grey.
    graph.setNodeAttribute(
      id,
      "color",
      tintColor(palette ?? fieldStar(lightBg), dn, id),
    );
    graph.setNodeAttribute(id, "community", sized.has(c) ? c : -1);
    graph.setNodeAttribute(id, "isHub", isHub);
    // NO per-hub size/intensity floor: flooring every community core to the same
    // size + brightness is exactly what made all clusters look identical. A core
    // blazes ONLY if its GLOBAL degree earns it (power-law pass above). `isHub`
    // remains a grouping/label flag and the cluster-force anchor.
  });
}

// Recolour an already-built graph in place for a light/dark background flip —
// WITHOUT rebuilding/re-settling the sim (the skin toggle would otherwise reflow
// the whole layout). Uses the community/galaxy/status already on the nodes, so
// no Louvain pass. The scene picks the new colours up via its next writeNodes
// (applyTheme calls it on the skin change).
export function recolorGraph(graph: VaultGraph, lightBg: boolean, vivid = false): void {
  let maxDeg = 0;
  graph.forEachNode((_id, a) => {
    if (a.deg > maxDeg) maxDeg = a.deg;
  });
  const size = new Map<number, number>();
  graph.forEachNode((_id, a) => {
    if (a.community >= 0) size.set(a.community, (size.get(a.community) ?? 0) + 1);
  });
  const ranked = [...size.entries()]
    .sort((x, y) => y[1] - x[1])
    .map(([c]) => c);
  const colorOf = communityPalette(ranked, lightBg, vivid);
  graph.forEachNode((id, a) => {
    const dn = maxDeg > 0 ? a.deg / maxDeg : 0;
    let color = tintColor(colorOf.get(a.community) ?? fieldStar(lightBg), dn, id);
    // Preserve the disputed/superseded amber tint (mirrors buildGraph's meta pass).
    if (a.status === "disputed" || a.status === "superseded") {
      color = mixHex(color, "#ff9e3d", 0.55);
    }
    graph.setNodeAttribute(id, "color", color);
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
  // Light (white-skin) background: pick the dark, saturated node palette so
  // stars read on paper instead of washing out.
  lightBg?: boolean;
  // Vivid (sigma board): swap the calm cosmic pastels for the Gephi full-
  // spectrum wheel at high saturation — the categorical hairball palette.
  vivid?: boolean;
  // Recency glow: absolute path → mtime (ms) and the "now" to age against.
  // When present each node gets an `age` attr (days since modified); missing
  // files read as very old so unknown never glows.
  mtimes?: Map<string, number>;
  now?: number;
  // Multiverse: stamp this slug on every node's `universe` attr, and namespace
  // ghost ids with `ghostPrefix` so the same unresolved [[link]] in two
  // projects can't merge into one cross-universe node. Both default to the
  // single-vault behaviour ("" universe, "ghost:" prefix).
  universe?: string;
  ghostPrefix?: string;
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

// Blend two #rrggbb colours: t=0 → a, t=1 → b. Used for the disputed warning tint
// and the multiverse per-vault star tint.
export function mixHex(a: string, b: string, t: number): string {
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
  community: number; // cluster id (≥3 nodes); -1 = field star / orphan
  galaxy: number; // top-level folder id (folder-galaxies layout); -1 = field / off
  // Multiverse tier: the slug of the project/vault this node belongs to.
  // Empty ("") in the single-vault graph; set by buildMultiverseGraph so the
  // scene can group/translate/frame each universe's subcloud independently.
  universe?: string;
  isHub: boolean; // highest-degree node of its community → galaxy core
  intensity: number; // HDR brightness boost (>1 only for top hubs) for bloom
  // Stellar class (shader branch): 0 main-sequence glow, 1 dwarf (small, dim,
  // sharp), 2 red giant (big soft warm halo), 3 neutron (tiny, piercing white,
  // diffraction spikes). Seeded per note so the sky isn't a wall of identical
  // glows; top hubs always stay blazing main-sequence.
  starKind?: number;
  // Days since the file was last modified (recency glow); 9999 = unknown/old.
  age?: number;
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
  // Synapse layout only: FA2 attraction weight (intra-community links pull
  // hard, inter-community weakly). Unset elsewhere → treated as 1.
  weight?: number;
}
export type VaultGraph = Graph<GraphNodeAttrs, GraphEdgeAttrs>;

// Stellar classification — deterministic per note. Top hubs stay blazing
// main-sequence stars; orphans skew toward quiet dwarfs; the rest mix so the
// sky reads like a real population instead of uniform glow.
export function starKindOf(
  id: string,
  deg: number,
  dn: number,
  nodeType?: string,
): number {
  if (dn > 0.75) return 0; // top hubs: blazing main-sequence
  // Frontmatter type → a CONSISTENT glyph (same kind of note, same shape of
  // star), a colour-blind-safe channel that survives HDR bloom better than hue.
  // Sources are piercing spiked beacons (the citable references), entities are
  // big warm presences, techniques dense small cores; concepts/analysis keep
  // the default glow. Untyped notes keep the seeded population look.
  switch (nodeType) {
    case "source-summary":
      return 3; // neutron: pinpoint + diffraction spikes
    case "entity":
      return 2; // red giant: big soft warm ball
    case "technique":
      return 1; // dwarf: small dense core
    case "concept":
    case "analysis":
      return 0; // main-sequence glow
    default:
      break;
  }
  const r = seededUnit(id, 5);
  if (deg === 0) return r < 0.6 ? 1 : 0; // orphans: mostly quiet dwarfs
  if (r < 0.5) return 0; // main sequence
  if (r < 0.7) return 1; // dwarf
  if (r < 0.88) return 2; // red giant
  return 3; // neutron star
}

export function buildGraph(
  adjacency: Adjacency,
  allowed: Set<string>,
  o: BuildGraphOpts,
): VaultGraph {
  const g: VaultGraph = new Graph({ multi: false, type: "undirected" });
  const universe = o.universe ?? "";
  const ghostPrefix = o.ghostPrefix ?? "ghost:";

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
      galaxy: -1, // set once folderGroups runs (folder-galaxies layout)
      universe,
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
        const gid = `${ghostPrefix}${t.toLowerCase()}`;
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
            galaxy: -1,
            universe,
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
    // Log-degree size scale with a super-linear top: true hubs — the entry
    // points that fan out into many children — read clearly LARGE (≈3.8× a
    // leaf), while the ^1.25 keeps mid-degree stars modest so the hierarchy
    // stays legible. maxDeg 0 (edgeless vault) would be 0/0 → plain base size.
    const logSize =
      maxDeg > 0
        ? 0.85 + 2.5 * Math.pow(Math.log2(1 + deg) / Math.log2(1 + maxDeg), 1.25)
        : 0.85;
    g.setNodeAttribute(id, "size", logSize * o.nodeSize * jit);
    // HDR intensity with a HARD CAP and a steep exponent: only the top ~10% of
    // hubs cross the bloom gate; everything else carries a faint baseline glow.
    // Brightness beyond that is earned by DENSITY (many faint stars overlapping
    // in a nucleus), not by individual HDR — additive overlap sums past any
    // per-sprite cap, so per-sprite HDR stays low (calm-cosmic-web spec).
    g.setNodeAttribute(id, "intensity", Math.min(1.7, 0.22 + Math.pow(dn, 1.8) * 1.5));
    g.setNodeAttribute(id, "starKind", starKindOf(id, deg, dn, adjacency.meta?.[id]?.type));
    // Recency: days since last modified (9999 = unknown → never glows). Ghost
    // nodes have no file and stay unknown.
    if (o.mtimes) {
      const mt = o.mtimes.get(id);
      const now = o.now ?? 0;
      g.setNodeAttribute(
        id,
        "age",
        mt !== undefined && now > 0 ? Math.max(0, (now - mt) / 86_400_000) : 9999,
      );
    }
  });
  // Colour by community hue + star temperature; store community id + hub flag
  // (needs the degree normalisation above, so it runs AFTER the size pass).
  // Folder galaxies: group by parent folder when the vault has real folder
  // structure; a flat vault falls back to Louvain (null override) — the sim's
  // anchor ring still spreads those communities into separate galaxies.
  let groups: FolderGrouping | null = null;
  if (o.folderGalaxies && o.vaultRoot) {
    // One Louvain pass, reused to subdivide flat folder galaxies.
    let lvMap: Record<string, number> = {};
    try {
      lvMap = louvain(g) as Record<string, number>;
    } catch {
      lvMap = {}; // edgeless — every node its own (missing) community → flat folds
    }
    groups = folderGroups(
      g.nodes(),
      o.vaultRoot,
      (id) => g.neighbors(id),
      (id) => lvMap[id] ?? -1,
    );
  }
  colorByCommunity(g, maxDeg, groups?.community ?? null, {
    lightBg: o.lightBg ?? false,
    vivid: o.vivid ?? false,
  });
  // Galaxy (top-level folder) attribute drives the shell anchor + legend parent.
  g.forEachNode((id) =>
    g.setNodeAttribute(id, "galaxy", groups ? (groups.galaxy[id] ?? -1) : -1),
  );

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

export interface MultiverseUniverse {
  slug: string;
  adjacency: Adjacency;
  allowed: Set<string>;
  vaultRoot: string; // that universe's own root, for its folder-galaxy grouping
}

// Per-universe stride for remapped community/galaxy ids — far larger than any
// realistic per-project cluster count, so a cluster id from universe A can
// never collide with one from universe B in the merged graph (which would make
// the scene's imposter/hull/legend grouping fuse two projects' clusters). -1
// (field star / off) is preserved as -1.
const UNIVERSE_ID_STRIDE = 1_000_000;

// Merge N per-universe link graphs into ONE graphology graph for the multiverse
// scene. Each universe is built independently by buildGraph against its OWN
// root (so its galaxies/clusters/hubs/star classes are computed relative to
// itself), then copied into the combined graph with:
//   - `universe` = slug already stamped by buildGraph,
//   - ghost ids namespaced `ghost:<slug>:<target>` (no cross-universe merge),
//   - community/galaxy ids offset by universe so clusters stay globally
//     distinct.
// Node POSITIONS stay in each universe's local (origin-centred) space; the
// scene translates each subcloud by its universe anchor (multiverseLayout).
// NOTE: colours are currently per-universe-independent (each project's palette
// restarts at the first hue) — per-universe identity hue is a scene-tier
// follow-up, not part of this structural merge.
export function buildMultiverseGraph(
  universes: MultiverseUniverse[],
  o: BuildGraphOpts,
): VaultGraph {
  const combined: VaultGraph = new Graph({ multi: false, type: "undirected" });
  universes.forEach((u, ui) => {
    const sub = buildGraph(u.adjacency, u.allowed, {
      ...o,
      // A universe always shows its internal galaxy(cluster) structure.
      folderGalaxies: true,
      vaultRoot: u.vaultRoot,
      universe: u.slug,
      ghostPrefix: `ghost:${u.slug}:`,
    });
    const remap = (v: number): number => (v < 0 ? -1 : ui * UNIVERSE_ID_STRIDE + v);
    sub.forEachNode((id, a) => {
      // Real file paths are unique per root and ghosts are slug-namespaced, so
      // ids can't collide across universes; the guard is defensive only.
      if (combined.hasNode(id)) return;
      combined.addNode(id, {
        ...a,
        community: remap(a.community),
        galaxy: remap(a.galaxy),
      });
    });
    sub.forEachEdge((_e, ea, s, t) => {
      if (combined.hasEdge(s, t)) return;
      combined.addEdge(s, t, { ...ea });
    });
  });
  return combined;
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
