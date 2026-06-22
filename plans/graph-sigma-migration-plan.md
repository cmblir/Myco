# Graph sigma.js Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Graph view renderer (cytoscape + experimental WebGL) with sigma.js v3, keeping the d3-force layout, so the graph matches Obsidian's look (faint edges, hub-first label fade, airy clusters).

**Architecture:** graphology `Graph` is the data model; `d3-force` (npm) runs the layout and writes node x/y into the graph each tick; sigma.js renders. PageGraph.tsx becomes a slim React shell wiring four focused modules.

**Tech Stack:** sigma ^3.0.3, graphology, d3-force, @sigma/utils, React, TypeScript, Tauri.

**Spec:** `plans/graph-sigma-migration.md`

**Verification model (no TDD):** This app has no test runner (package.json: only dev/build/lint/format). Each task verifies with (a) `npx tsc -b` clean, (b) `npm run lint` clean, and (c) where visual, a screenshot of the running app on the real 1798-node vault. Visual procedure documented once in "Visual Verification Procedure" below; later tasks reference it.

**Commits:** One commit per task. Identity = repo user (`yoo`), NO Claude attribution (CLAUDE.md §4.2). Commit only after the task's verification passes.

---

## Visual Verification Procedure (referenced by visual tasks)

The dev app's WKWebView restores a small default vault, so force the big vault via the dev `?vault=` escape hatch (App.tsx:103):

1. Edit `app/src-tauri/tauri.conf.json` `devUrl` → `"http://localhost:5173/?vault=/Users/o/Documents/Obsidian%20Vault"`. (Revert to `"http://localhost:5173"` at end of session.)
2. `cd /Users/o/karpathy/app && nohup npm run tauri dev > /tmp/memex-dev.log 2>&1 &` (background). Wait for `Running \`target/debug/memex\`` in the log (~8–15s; Rust is cached). HMR picks up frontend edits without restart.
3. Move window on-screen + capture:
   ```bash
   osascript -e 'tell application "System Events" to tell (first process whose name is "memex") to set {position, size} of front window to {80, 70, 1280, 800}'
   sleep 1; screencapture -x -R80,70,1280,800 /tmp/shot.png
   ```
   Read `/tmp/shot.png`. Toolbar buttons (screen coords, window at 80,70): play≈(1108,358), −≈(1162,358), fit≈(1209,358), +≈(1256,358), gear≈(1303,358). Click via `cliclick c:X,Y`.
4. Compare against Obsidian's reference (faint edges, no overview labels, airy dandelions).

---

## Task 0: Dependencies

**Files:** Modify `app/package.json` (via npm).

- [ ] **Step 1: Install runtime + dev deps**

```bash
cd /Users/o/karpathy/app
npm install sigma graphology d3-force @sigma/utils
npm install -D graphology-types @types/d3-force
```

- [ ] **Step 2: Verify versions** — `node -e "const p=require('./package.json');console.log(p.dependencies.sigma, p.dependencies.graphology, p.dependencies['d3-force'])"` → sigma ^3.x present.

- [ ] **Step 3: Commit**

```bash
git add app/package.json app/package-lock.json
git commit -m "build(memex): add sigma.js + graphology + d3-force for graph migration"
```

---

## Task 1: Data layer — `lib/graphData.ts`

**Files:**
- Create: `app/src/lib/graphData.ts`
- Reference (port from): `app/src/pages/PageGraph.tsx` (computeAllowed, buildElements, collectTags, collectFolders, flattenMarkdown, inFolder, stem, countAllNodes)

Renderer-agnostic. Build a graphology `Graph` instead of cytoscape elements. Node attributes: `label, deg, size, unresolved, color?, x, y` (x/y seeded random; sim overwrites). Initial x/y must be a random scatter (NOT 0,0) so the sim doesn't explode.

- [ ] **Step 1: Write the module**

```ts
// Renderer-agnostic graph data: filters + graphology graph construction.
// Ported from the cytoscape PageGraph; identical filter semantics.
import Graph from "graphology";
import type { Adjacency, FileNode } from "./ipc";

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

export function collectFolders(root: string, adjacency: Adjacency | null): string[] {
  if (!adjacency || !root) return [];
  const trimmed = root.replace(/[\\/]+$/, "");
  const set = new Set<string>();
  const paths = new Set<string>();
  for (const p of Object.keys(adjacency.forward)) paths.add(p);
  for (const arr of Object.values(adjacency.forward)) for (const p of arr) paths.add(p);
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
  for (const arr of Object.values(adjacency.forward)) for (const p of arr) set.add(p);
  for (const p of Object.keys(adjacency.tags)) set.add(p);
  return set.size;
}

export function computeAllowed(
  adjacency: Adjacency,
  allFiles: string[],
  o: AllowFilterOpts,
): Set<string> {
  const all = new Set<string>();
  for (const p of allFiles) all.add(p);
  for (const p of Object.keys(adjacency.forward)) all.add(p);
  for (const targets of Object.values(adjacency.forward)) for (const p of targets) all.add(p);
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
  nodeSize: number;       // GraphSettings.nodeSize multiplier
  resolvedColor: string;  // theme node color
  unresolvedColor: string;
  edgeColor: string;      // rgba with alpha — sigma honors it
}

// Deterministic pseudo-random scatter (no Math.random — keeps runs reproducible
// and avoids the sandbox Math.random ban concern). Seed from string hash.
function seededXY(id: string, i: number): { x: number; y: number } {
  let h = 2166136261;
  for (let k = 0; k < id.length; k++) { h ^= id.charCodeAt(k); h = Math.imul(h, 16777619); }
  const a = ((h >>> 0) % 1000) / 1000;
  const b = (((h >>> 0) * 2654435761) % 1000) / 1000;
  const r = 300 + a * 300;
  const theta = b * Math.PI * 2 + i * 0.0001;
  return { x: Math.cos(theta) * r, y: Math.sin(theta) * r };
}

export function buildGraph(
  adjacency: Adjacency,
  allowed: Set<string>,
  allFiles: string[],
  o: BuildGraphOpts,
): Graph {
  const g = new Graph({ multi: false, type: "undirected" });
  const resolved = new Set<string>(allFiles);
  for (const p of Object.keys(adjacency.forward)) resolved.add(p);

  const ensure = (id: string): void => {
    if (g.hasNode(id)) return;
    const i = g.order;
    const { x, y } = seededXY(id, i);
    g.addNode(id, {
      label: stem(id),
      x, y,
      deg: 0,
      size: 2, // set after degree known
      unresolved: resolved.has(id) ? 0 : 1,
      color: resolved.has(id) ? o.resolvedColor : o.unresolvedColor,
    });
  };

  for (const [source, targets] of Object.entries(adjacency.forward)) {
    if (!allowed.has(source)) continue;
    ensure(source);
    for (const target of targets) {
      if (!allowed.has(target)) continue;
      ensure(target);
      const key = `${source} ${target}`;
      if (!g.hasEdge(source, target) && !g.hasEdge(target, source)) {
        g.addEdgeWithKey(key, source, target, { color: o.edgeColor, size: 0.6 });
      }
    }
  }
  for (const p of allowed) ensure(p); // isolated/orphan nodes

  // Degree-driven size: leaves ~2px, hubs swell. sqrt keeps hubs from dominating.
  g.forEachNode((id) => {
    const deg = g.degree(id);
    const base = Math.max(2, Math.min(14, 2 + Math.sqrt(deg) * 2.2));
    g.setNodeAttribute(id, "deg", deg);
    g.setNodeAttribute(id, "size", base * o.nodeSize);
  });
  return g;
}
```

- [ ] **Step 2: Typecheck** — `cd app && npx tsc -b` → No errors.
- [ ] **Step 3: Commit** — `git add app/src/lib/graphData.ts && git commit -m "feat(memex): add renderer-agnostic graph data layer (graphology)"`

---

## Task 2: Simulation layer — `lib/graphSim.ts`

**Files:** Create `app/src/lib/graphSim.ts`. Port the force mapping from PageGraph `buildForceOpts`/`runLayout` (REPEL_SCALE 20, CENTER_SCALE 0.4, degree-normalized linkStrength, uncapped manyBody, collide).

- [ ] **Step 1: Write the module**

```ts
// d3-force simulation over a graphology graph. Mirrors the Obsidian force
// mapping the cytoscape port used: uncapped Barnes-Hut repulsion, long links,
// gentle center gravity, and per-link degree normalization (the dandelion).
import {
  forceSimulation, forceLink, forceManyBody, forceX, forceY, forceCollide,
  type Simulation,
} from "d3-force";
import type Graph from "graphology";
import type { GraphSettings } from "./graphSettings";

export interface SimNode { id: string; x: number; y: number; size: number; deg: number;
  fx?: number | null; fy?: number | null; }
interface SimLink { source: SimNode | string; target: SimNode | string; }

const REPEL_SCALE = 20;   // slider 10 → manyBody -200 (uncapped)
const CENTER_SCALE = 0.4; // slider 0.5 → x/y strength 0.2

export interface GraphSim {
  nodes: SimNode[];
  sim: Simulation<SimNode, SimLink>;
  reheat(alpha: number): void;
  stop(): void;
}

export function createSim(
  graph: Graph,
  s: GraphSettings,
  onTick: (nodes: SimNode[]) => void,
): GraphSim {
  const nodes: SimNode[] = graph.mapNodes((id, a) => ({
    id, x: a.x, y: a.y, size: a.size, deg: a.deg,
  }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const links: SimLink[] = graph.mapEdges((_e, _a, src, tgt) => ({
    source: byId.get(src)!, target: byId.get(tgt)!,
  }));

  const linkStrength = (l: SimLink): number => {
    const sN = typeof l.source === "object" ? l.source.deg : 1;
    const tN = typeof l.target === "object" ? l.target.deg : 1;
    return s.linkForce / (1 + Math.min(sN, tN));
  };

  const sim = forceSimulation<SimNode, SimLink>(nodes)
    .force("link", forceLink<SimNode, SimLink>(links).id((d) => d.id)
      .distance(s.linkDistance).strength(linkStrength).iterations(1))
    .force("charge", forceManyBody<SimNode>()
      .strength(-s.repelForce * REPEL_SCALE).theta(0.9).distanceMin(1)) // distanceMax = Infinity (default)
    .force("x", forceX<SimNode>(0).strength(Math.max(0.005, s.centerForce * CENTER_SCALE)))
    .force("y", forceY<SimNode>(0).strength(Math.max(0.005, s.centerForce * CENTER_SCALE)))
    .force("collide", forceCollide<SimNode>((n) => n.size / 2 + 6).strength(1).iterations(1))
    .alpha(1).alphaDecay(0.035).alphaMin(0.004).velocityDecay(0.5);

  sim.on("tick", () => onTick(nodes));

  return {
    nodes,
    sim,
    reheat(alpha) { sim.alpha(alpha).alphaTarget(0).restart(); },
    stop() { sim.stop(); },
  };
}
```

- [ ] **Step 2: Typecheck** — `npx tsc -b` → No errors (adjust d3-force generic types if needed).
- [ ] **Step 3: Commit** — `git commit -am "feat(memex): add d3-force simulation layer (Obsidian force mapping)"`

---

## Task 3: Theme layer — `lib/graphTheme.ts`

**Files:** Create `app/src/lib/graphTheme.ts`. Port `isDarkBackground`/`readThemeColors`; add `buildSigmaSettings`.

- [ ] **Step 1: Write the module**

```ts
// Theme colors (from CSS vars / rendered bg) + sigma Settings builder.
import type { Settings } from "sigma/settings";
import type { GraphSettings } from "./graphSettings";

export interface GraphTheme {
  bg: string; node: string; nodeUnresolved: string; ink: string;
  edge: string;      // rgba w/ alpha — sigma honors it
  edgeHi: string; accent: string;
}

function isDarkBackground(cs: CSSStyleDeclaration): boolean {
  const bg = cs.getPropertyValue("--bg").trim();
  const m = /^#([0-9a-f]{6})$/i.exec(bg) ?? /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(bg);
  if (!m) return true;
  let r: number, g: number, b: number;
  if (m[0].startsWith("#")) { const h = m[1]; r = parseInt(h.slice(0,2),16); g = parseInt(h.slice(2,4),16); b = parseInt(h.slice(4,6),16); }
  else { r = +m[1]; g = +m[2]; b = +m[3]; }
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}

export function readTheme(): GraphTheme {
  const cs = getComputedStyle(document.documentElement);
  const dark = isDarkBackground(cs);
  return {
    bg: cs.getPropertyValue("--bg").trim() || (dark ? "#0f1115" : "#fafaf9"),
    ink: cs.getPropertyValue("--ink").trim() || (dark ? "#e6e8eb" : "#111418"),
    node: dark ? "#c8c8c8" : "#3a3f47",
    nodeUnresolved: dark ? "#6e7079" : "#9aa0a8",
    edge: dark ? "rgba(220,224,230,0.18)" : "rgba(30,35,45,0.14)",
    edgeHi: dark ? "rgba(220,224,230,0.95)" : "rgba(30,35,45,0.85)",
    accent: cs.getPropertyValue("--accent").trim() || (dark ? "#7aa7ff" : "#3b82f6"),
  };
}

// textFadeThreshold slider (0.1..3) → labelRenderedSizeThreshold. Higher slider
// = labels appear later (more zoom). Map so the whole-graph fit shows none.
export function buildSigmaSettings(theme: GraphTheme, s: GraphSettings): Partial<Settings> {
  return {
    // edges
    defaultEdgeColor: theme.edge,
    defaultEdgeType: "line",
    minEdgeThickness: 0.4,
    // labels (Obsidian: none at overview, hub-first on zoom)
    renderLabels: true,
    labelColor: { color: theme.ink },
    labelDensity: 0.6,
    labelGridCellSize: 130,
    labelRenderedSizeThreshold: 6 + (s.textFadeThreshold - 1.1) * 6,
    labelFont: getComputedStyle(document.documentElement).getPropertyValue("--font-sans").trim() || "Inter, sans-serif",
    // nodes
    defaultNodeColor: theme.node,
    zIndex: true,
  };
}
```

- [ ] **Step 2: Typecheck** — `npx tsc -b`. If `sigma/settings` path differs, use `import type { Settings } from "sigma"`.
- [ ] **Step 3: Commit** — `git commit -am "feat(memex): add graph theme + sigma settings builder"`

---

## Task 4: Render core — replace PageGraph (first paint, no interactions yet)

**Files:** Modify `app/src/pages/PageGraph.tsx` (rewrite the engine; keep the toolbar/drawer JSX shell and counts). Keep cytoscape imports out.

This is the **make-or-break visual task.** Render: build graph (graphData) → create Sigma → run sim writing positions → auto-fit → fade-in. No hover/drag/timelapse/filters yet (added in later tasks) — but keep the existing toolbar + GraphControls JSX rendering (handlers can be temporary no-ops/console for now where a later task wires them).

- [ ] **Step 1: Replace the mount effect** with sigma lifecycle:

```ts
import Sigma from "sigma";
import { fitViewportToNodes } from "@sigma/utils";
import { buildGraph, computeAllowed, collectTags, collectFolders, flattenMarkdown, countAllNodes } from "../lib/graphData";
import { createSim, type GraphSim } from "../lib/graphSim";
import { readTheme, buildSigmaSettings } from "../lib/graphTheme";

// in component:
const sigmaRef = useRef<Sigma | null>(null);
const simRef = useRef<GraphSim | null>(null);

useEffect(() => {
  const container = containerRef.current;
  if (!container || !adjacency) return;
  const theme = readTheme();
  const allowed = computeAllowed(adjacency, allFiles, {
    tagFilter: settings.tagFilter, folderFilter: settings.folderFilter,
    vaultRoot: currentVault?.path ?? "", search: settings.search,
    existingOnly: settings.existingOnly, showOrphans: settings.showOrphans,
  });
  const graph = buildGraph(adjacency, allowed, allFiles, {
    nodeSize: settings.nodeSize, resolvedColor: theme.node,
    unresolvedColor: theme.nodeUnresolved, edgeColor: theme.edge,
  });
  const renderer = new Sigma(graph, container, buildSigmaSettings(theme, settings));
  sigmaRef.current = renderer;
  setCounts({ nodes: graph.order, edges: graph.size });

  // layout: write positions per tick; fit once on settle
  let settled = false;
  const sim = createSim(graph, settings, (nodes) => {
    for (const n of nodes) graph.mergeNodeAttributes(n.id, { x: n.x, y: n.y });
    renderer.refresh({ skipIndexation: true });
  });
  simRef.current = sim;
  sim.sim.on("end", () => {
    if (settled) return; settled = true;
    renderer.refresh(); // re-grid labels
    if (graph.order >= 2) void fitViewportToNodes(renderer, graph.nodes(), { animate: false });
    container.classList.add("graph-ready");
  });

  return () => { sim.stop(); renderer.kill(); sigmaRef.current = null; simRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [adjacency, allFiles, currentVault?.path, settings.tagFilter, settings.folderFilter,
    settings.search, settings.existingOnly, settings.showOrphans, settings.nodeSize]);
```

- [ ] **Step 2: Remove cytoscape-specific code** from PageGraph (makeStyle, runLayout, robustFit, applyLabelVisibility, createCy, ensureLayoutRegistered, ZoomButtons cy logic — replaced later). Keep: toolbar JSX, counts state, GraphControls render, tags/folders/allFiles memos.
- [ ] **Step 3: Typecheck + lint** — `npx tsc -b && npm run lint`.
- [ ] **Step 4: VISUAL CHECKPOINT** — run Visual Verification Procedure. Confirm: edges faint, NO labels at overview, hubs larger, clusters visible. **Iterate here** on `labelRenderedSizeThreshold`, `minEdgeThickness`, edge alpha, node `size` formula, `itemSizesReference`/`zoomToSizeRatioFunction`, force `centerForce` for airiness. Capture before/after.
- [ ] **Step 5: Commit** — `git commit -am "feat(memex): render graph with sigma.js (first paint)"`

---

## Task 5: Hover highlight (reducers)

**Files:** Modify `app/src/pages/PageGraph.tsx`.

- [ ] **Step 1: Add hover state + reducers** (after sigma creation):

```ts
let hovered: string | undefined;
let neighbors: Set<string> | undefined;
renderer.on("enterNode", ({ node }) => {
  hovered = node; neighbors = new Set(graph.neighbors(node)); neighbors.add(node);
  renderer.refresh({ skipIndexation: true });
});
renderer.on("leaveNode", () => { hovered = undefined; neighbors = undefined; renderer.refresh({ skipIndexation: true }); });
renderer.setSetting("nodeReducer", (n, data) => {
  if (!neighbors) return data;
  if (neighbors.has(n)) return n === hovered ? { ...data, highlighted: true, forceLabel: true } : { ...data, forceLabel: true };
  return { ...data, color: theme.nodeUnresolved, label: "" };
});
renderer.setSetting("edgeReducer", (e, data) => {
  if (!hovered) return data;
  const [a, b] = graph.extremities(e);
  return a === hovered || b === hovered ? { ...data, color: theme.edgeHi, zIndex: 1 } : { ...data, color: theme.edge, hidden: false };
});
renderer.on("clickNode", ({ node }) => setRoute(`page:${node}`));
```

- [ ] **Step 2: Typecheck + lint.**
- [ ] **Step 3: VISUAL CHECKPOINT** — hover a hub: neighborhood brightens, rest dims, labels appear on neighbors; click opens the page.
- [ ] **Step 4: Commit** — `git commit -am "feat(memex): graph hover-highlight + click-to-open (sigma reducers)"`

---

## Task 6: Node drag (tow neighbors via d3 reheat)

**Files:** Modify `app/src/pages/PageGraph.tsx`.

- [ ] **Step 1: Add drag handlers**:

```ts
let dragged: string | null = null;
renderer.on("downNode", ({ node }) => {
  dragged = node;
  if (!renderer.getCustomBBox()) renderer.setCustomBBox(renderer.getBBox()); // freeze camera
  const sn = simRef.current!.nodes.find((n) => n.id === node);
  if (sn) { sn.fx = sn.x; sn.fy = sn.y; }
  simRef.current!.reheat(0.3);
});
renderer.on("moveBody", ({ event }) => {
  if (!dragged) return;
  const p = renderer.viewportToGraph(event);
  graph.mergeNodeAttributes(dragged, { x: p.x, y: p.y });
  const sn = simRef.current!.nodes.find((n) => n.id === dragged);
  if (sn) { sn.fx = p.x; sn.fy = p.y; }
  event.preventSigmaDefault(); event.original.preventDefault(); event.original.stopPropagation();
});
const endDrag = (): void => {
  if (dragged) { const sn = simRef.current!.nodes.find((n) => n.id === dragged); if (sn) { sn.fx = null; sn.fy = null; } }
  dragged = null; renderer.setCustomBBox(null); simRef.current!.sim.alphaTarget(0);
};
renderer.on("upNode", endDrag); renderer.on("upStage", endDrag);
```

- [ ] **Step 2: Typecheck + lint.**
- [ ] **Step 3: VISUAL CHECKPOINT** — drag a node: it follows the cursor, neighbors tow along, releases and springs to rest; camera does not jump.
- [ ] **Step 4: Commit** — `git commit -am "feat(memex): draggable graph nodes with d3 spring-back tow"`

---

## Task 7: Camera — fit / zoom buttons

**Files:** Modify `app/src/pages/PageGraph.tsx` (ZoomButtons + fit).

- [ ] **Step 1: Wire buttons to sigma camera**:

```ts
const zoomIn = () => sigmaRef.current?.getCamera().animatedZoom({ duration: 250 });
const zoomOut = () => sigmaRef.current?.getCamera().animatedUnzoom({ duration: 250 });
const fit = () => { const r = sigmaRef.current; if (r && r.getGraph().order >= 2) void fitViewportToNodes(r, r.getGraph().nodes(), { animate: true }); };
```

Replace the old `ZoomButtons` cy-based handlers with these. Wire the existing toolbar buttons (play/timelapse stays for Task 9).

- [ ] **Step 2: Typecheck + lint.**
- [ ] **Step 3: VISUAL CHECKPOINT** — +/− zoom smoothly, fit frames the whole graph (no overshoot/clip).
- [ ] **Step 4: Commit** — `git commit -am "feat(memex): graph zoom/fit buttons via sigma camera"`

---

## Task 8: Filters + force/display sliders

**Files:** Modify `app/src/pages/PageGraph.tsx`.

Graph rebuild already keyed on filter/nodeSize settings (Task 4 deps). Add: force-slider changes re-tune the sim without rebuilding; display sliders update sigma settings.

- [ ] **Step 1: Force-slider effect** — on `centerForce/repelForce/linkForce/linkDistance` change, recreate forces on the existing sim (or rebuild sim cheaply) and `reheat(0.5)`. Simplest: tear down + `createSim` again from the current graph positions (pass current x/y as seed by reading graph attrs into nodes).
- [ ] **Step 2: Display-slider effect** — on `linkThickness/textFadeThreshold/arrows/theme` change: `renderer.setSettings(buildSigmaSettings(readTheme(), settings))`; for `linkThickness` update each edge `size`; for `arrows` set `defaultEdgeType: arrows ? "arrow" : "line"`.
- [ ] **Step 3: Typecheck + lint.**
- [ ] **Step 4: VISUAL CHECKPOINT** — toggle orphans/existingOnly, type in search, pick a tag/folder → graph rebuilds correctly; move each force slider → layout responds; link-thickness/text-fade sliders visibly change rendering.
- [ ] **Step 5: Commit** — `git commit -am "feat(memex): graph filters + force/display sliders on sigma"`

---

## Task 9: Timelapse (oldest-first reveal, physics-free)

**Files:** Modify `app/src/pages/PageGraph.tsx` (keep mtime fetch effect + tlOrderRef).

- [ ] **Step 1: Reimplement reveal on sigma** — set every node `hidden: true`, then rAF-reveal in mtime order by `graph.setNodeAttribute(id, "hidden", false)`. Edges auto-hide while an endpoint is hidden (sigma skips edges with a hidden extremity). Pause reveals all. Keep ~12s budget (`perFrame = ceil(order / (12*60))`).

```ts
const startTimelapse = () => {
  const r = sigmaRef.current; if (!r) return; const graph = r.getGraph();
  simRef.current?.stop();
  const order = [...tlOrderRef.current.filter((p) => graph.hasNode(p))];
  const seen = new Set(order); graph.forEachNode((n) => { if (!seen.has(n)) order.push(n); });
  graph.forEachNode((n) => graph.setNodeAttribute(n, "hidden", true));
  setTlPlaying(true);
  const perFrame = Math.max(1, Math.ceil(order.length / (12 * 60))); let i = 0;
  const step = () => {
    const rr = sigmaRef.current; if (!rr) { tlRafRef.current = null; return; }
    const gg = rr.getGraph();
    for (let k = 0; k < perFrame && i < order.length; k++, i++) gg.setNodeAttribute(order[i], "hidden", false);
    if (i < order.length) tlRafRef.current = requestAnimationFrame(step);
    else { tlRafRef.current = null; setTlPlaying(false); }
  };
  tlRafRef.current = requestAnimationFrame(step);
};
const pauseTimelapse = () => {
  if (tlRafRef.current != null) { cancelAnimationFrame(tlRafRef.current); tlRafRef.current = null; }
  sigmaRef.current?.getGraph().forEachNode((n) => sigmaRef.current!.getGraph().setNodeAttribute(n, "hidden", false));
  setTlPlaying(false);
};
```

- [ ] **Step 2: Typecheck + lint.**
- [ ] **Step 3: VISUAL CHECKPOINT** — play: nodes appear oldest→newest, edges fill in; pause reveals all.
- [ ] **Step 4: Commit** — `git commit -am "feat(memex): graph timelapse reveal on sigma (physics-free)"`

---

## Task 10: WebGL context-loss recovery (Tauri WKWebView)

**Files:** Modify `app/src/pages/PageGraph.tsx`.

sigma has no built-in recovery. On `webglcontextrestored`, kill + recreate the renderer (graph + sim survive).

- [ ] **Step 1: Attach listeners on `renderer.getCanvases()`**; on lost → `e.preventDefault()`; on restored → store a `recreate()` that calls `renderer.kill()` then rebuilds Sigma from the same `graph` + re-runs the event-binding setup (extract bind logic into a `bindRenderer(renderer)` helper so both initial mount and recovery call it). Clean up listeners in the effect teardown.
- [ ] **Step 2: Typecheck + lint.**
- [ ] **Step 3: VERIFY** — background the app / switch spaces and return; graph still renders (best-effort; document if WKWebView doesn't fire the event in dev).
- [ ] **Step 4: Commit** — `git commit -am "fix(memex): recover graph WebGL context after WKWebView loss"`

---

## Task 11: Theme toggle

**Files:** Modify `app/src/pages/PageGraph.tsx`.

- [ ] **Step 1: On `theme` change** — `renderer.setSettings(buildSigmaSettings(readTheme(), settings))`; recolor nodes/edges via `forEachNode`/`forEachEdge` set `color`, then `refresh()`. (Re-read theme AFTER the app's theme effect; keep the existing rAF+timeout safety pattern.)
- [ ] **Step 2: Typecheck + lint.**
- [ ] **Step 3: VISUAL CHECKPOINT** — toggle light/dark: nodes/edges/labels recolor, stay visible on both backgrounds.
- [ ] **Step 4: Commit** — `git commit -am "feat(memex): graph theme-aware recolor on sigma"`

---

## Task 12: Cleanup + remove cytoscape

**Files:** `app/package.json`, `app/src/pages/PageGraph.tsx`, `app/src/lib/graphSettings.ts`, `app/src/styles.css`.

- [ ] **Step 1: Remove deps** — `npm remove cytoscape cytoscape-d3-force`. Delete any remaining cytoscape imports/dead code.
- [ ] **Step 2: Bump settings key** `v18`→`v19` in graphSettings.ts (defaults may have retuned during Task 4).
- [ ] **Step 3: Prune styles.css** of cytoscape-only rules if any; keep `.graph-canvas` fade-in.
- [ ] **Step 4: Typecheck + lint** — `npx tsc -b && npm run lint` clean.
- [ ] **Step 5: FULL VISUAL PASS** — big vault (1798) AND small vault (default): edges faint, no overview labels, hub-first reveal, airy clusters, hover/drag/fit/timelapse/filters/theme all work. Compare to Obsidian.
- [ ] **Step 6: Update README** if Graph section describes cytoscape (CLAUDE.md §4.5). Revert tauri.conf.json devUrl.
- [ ] **Step 7: Commit** — `git commit -am "refactor(memex): remove cytoscape after sigma.js migration"`

---

## Self-Review (done)

- **Spec coverage:** edges (T3,T4), labels (T3,T4), nodes (T1,T4), hover (T5), drag (T6), camera (T7), filters+sliders (T8), timelapse (T9), context-loss (T10), theme (T11), dep removal (T12). All spec sections mapped.
- **Type consistency:** `GraphSim.nodes: SimNode[]` used in T6/T8; `buildGraph`/`computeAllowed`/`buildSigmaSettings`/`readTheme`/`createSim` signatures consistent across tasks.
- **Placeholders:** none — concrete code in each code step. (T8/T10 describe extract-helper steps in prose where the mechanical edit is obvious; code given for the non-obvious parts.)
- **Risk note:** Task 4 is the visual make-or-break and expects iteration; later tasks assume its settings stabilized.
