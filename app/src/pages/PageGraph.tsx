// Graph page — a 3D "universe" force-directed graph of the vault. d3-force-3d
// (lib/graphSim) runs the same Obsidian-style layout the 2D view used — now in
// three dimensions — and lib/graphScene renders it with three.js: glowing star
// nodes, faint filament edges, a starfield, depth fog and UnrealBloom, with
// OrbitControls for real z-axis orbit and idle auto-rotate. This file stays a
// thin React orchestrator: build/settle, drag, hover, timelapse, live-ingest
// glow and WebGL context-loss recovery — all driving the imperative GraphScene
// API instead of sigma.

import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import GraphControls from "../components/GraphControls";
import GraphInspector from "../components/GraphInspector";
import ShipHud from "../components/ShipHud";
import GraphGaps from "../components/GraphGaps";
import GraphHelp from "../components/GraphHelp";
import GraphLegend from "../components/GraphLegend";
import {
  DEFAULT_GRAPH_SETTINGS,
  loadGraphSettings,
  saveGraphSettings,
  type GraphSettings,
} from "../lib/graphSettings";
import {
  buildGraph,
  buildLegend,
  collectFolders,
  collectTags,
  computeAllowed,
  countAllNodes,
  flattenMarkdown,
  type LegendGalaxy,
  recolorGraph,
  shortestPath,
  starKindOf,
  stem,
  type VaultGraph,
} from "../lib/graphData";
import { analyzeGaps, gapCount } from "../lib/graphGaps";
import { createSim, type GraphSim, type SimNode } from "../lib/graphSim";
import { applyAtlasLayout } from "../lib/atlasLayout";
import { ATLAS_RADIUS_MUL } from "../lib/layoutConfig";
import type { LayoutMetrics } from "../lib/layoutMetrics";
import { makeTheme } from "../lib/graphTheme";
import { isLightBackground } from "../lib/graphSkins";
import { GraphScene, type SceneStyleState } from "../lib/graphScene";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { useIngestStore } from "../stores/ingestStore";
import { ipc } from "../lib/ipc";
import type { Adjacency, SemEdge } from "../lib/ipc";

// Live-ingest node tints — pages the in-flight run wrote glow gold, pages it
// only read glow ice blue. Both sit inside the cosmic palette so they read as
// "hot" stars rather than UI chrome.
const PULSE_MS = 900;

interface IngestGlow {
  /** absolute node id → was it written (vs only read) */
  tint: Map<string, boolean>;
  pulseId: string | null;
  pulseScale: number;
}

// Focus stack (spec B3 — "focus modes with an exit"): every isolation is a
// frame the user can pop back out of with Esc / a void-click / a breadcrumb.
// Node clicks push 1-hop frames (double-click upgrades to 2-hop); a legend
// swatch pushes a community frame.
interface FocusFrame {
  kind: "node" | "community";
  /** breadcrumb text — note stem or community label */
  label: string;
  members: Set<string>;
  /** node frames: the focused node */
  id?: string;
  hops?: 1 | 2;
  /** community frames: the Louvain community id */
  cm?: number;
}

// Double-click window for upgrading a node frame to 2 hops.
const DBL_MS = 350;

// Members of the n-hop neighbourhood around a node (inclusive).
function hopSet(g: VaultGraph, id: string, hops: 1 | 2): Set<string> {
  const members = new Set<string>([id]);
  for (const n of g.neighbors(id)) members.add(n);
  if (hops === 2) {
    for (const n of [...members]) {
      for (const m of g.neighbors(n)) members.add(m);
    }
  }
  return members;
}

export default function PageGraph({ t }: { t: Strings }): JSX.Element {
  const adjacency = useVaultStore((s) => s.adjacency);
  const fileTree = useVaultStore((s) => s.fileTree);
  const currentVault = useVaultStore((s) => s.currentVault);
  const setRoute = useUIStore((s) => s.setRoute);
  const uiTheme = useUIStore((s) => s.theme);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<GraphScene | null>(null);
  const simRef = useRef<GraphSim | null>(null);
  const graphRef = useRef<VaultGraph | null>(null);
  const settingsRef = useRef<GraphSettings>(DEFAULT_GRAPH_SETTINGS);
  const tlRafRef = useRef<number | null>(null);
  // Markdown paths sorted oldest→newest by mtime — the order nodes pop in
  // during the timelapse.
  const tlOrderRef = useRef<string[]>([]);
  // Hover neighbourhood + live-ingest glow are composed into one SceneStyleState
  // and pushed to the scene. Refs (not state) so handlers never rebuild the scene.
  const hoverRef = useRef<{ node: string | null; neighbors: Set<string> | null }>(
    { node: null, neighbors: null },
  );
  const ingestGlowRef = useRef<IngestGlow>({
    tint: new Map(),
    pulseId: null,
    pulseScale: 1,
  });
  const pulseRafRef = useRef<number | null>(null);
  // Focus stack — state drives the breadcrumbs; the ref feeds pushStyle (a
  // stable closure) with the top frame's member set.
  const [focusStack, setFocusStack] = useState<FocusFrame[]>([]);
  const focusRef = useRef<Set<string> | null>(null);
  const lastClickRef = useRef<{ id: string; at: number } | null>(null);

  const [settings, setSettings] = useState<GraphSettings>(() =>
    loadGraphSettings(),
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Clicked node → open the inspector panel (instead of navigating away).
  const [selected, setSelected] = useState<string | null>(null);
  // Search-to-focus query (toolbar) — jumps the camera to a node by name.
  const [find, setFind] = useState("");
  // Shortest-path: a pinned start node + the computed path to the selected node.
  // Refs shadow the state so the scene's stable click closure reads current
  // values (spec B3 Cmd-click path mode); pushStyle reads pathRef for the
  // filament layer.
  const [pathAnchor, setPathAnchor] = useState<string | null>(null);
  const [path, setPath] = useState<string[] | null>(null);
  const pathAnchorRef = useRef<string | null>(null);
  const pathRef = useRef<string[] | null>(null);
  const setAnchor = (v: string | null): void => {
    pathAnchorRef.current = v;
    setPathAnchor(v);
  };
  // Trace mode (spec): while on, a plain click picks the path start then end
  // (no focus frame), and the route animates. Ref mirrors state for the
  // once-created click handler closure.
  const [traceMode, setTraceMode] = useState(false);
  const traceModeRef = useRef(false);
  const toggleTrace = (on: boolean): void => {
    traceModeRef.current = on;
    setTraceMode(on);
    // Leaving trace mode clears any in-progress route + the comet.
    if (!on) {
      setAnchor(null);
      pathRef.current = null;
      setPath(null);
      setSelected(null);
      sceneRef.current?.setTrace(null);
    }
  };
  // Spaceship free-fly mode (transient). Ref mirrors state for the window
  // keydown closure. Toggling clears any active trace (they share the camera).
  const [flyMode, setFlyMode] = useState(false);
  const flyModeRef = useRef(false);
  // Semantic-similarity overlay edges, fetched on demand. A ref (read at build
  // time) + a glEpoch bump avoids a build-deps ordering race with the fetch.
  const semEdgesRef = useRef<SemEdge[]>([]);
  const toggleFly = (on: boolean): void => {
    flyModeRef.current = on;
    setFlyMode(on);
    sceneRef.current?.setFlyMode(on);
    if (on && traceModeRef.current) toggleTrace(false);
  };
  // HUD speed readout, polled at a low rate while flying.
  const [shipSpeed, setShipSpeed] = useState(0);
  // Cosmic-scale band (star/system/galaxy/cluster) shown briefly on change.
  const [cosmicScale, setCosmicScale] = useState<string | null>(null);
  const scaleHideRef = useRef<number | null>(null);
  // Gap-analysis panel (orphans / missing / under-cited / disconnected …).
  const [gapsOpen, setGapsOpen] = useState(false);
  // Gesture cheat-sheet popover ("?" toolbar button).
  const [helpOpen, setHelpOpen] = useState(false);
  const [tlPlaying, setTlPlaying] = useState(false);
  // Bumped on webglcontextrestored to force a clean scene rebuild (WKWebView
  // drops the GL context on backgrounding; three.js does not auto-restore the
  // composer/render targets, so we tear down and rebuild a fresh GraphScene).
  const [glEpoch, setGlEpoch] = useState(0);
  // Error state (spec B5): the GL context died and the browser has not (yet)
  // restored it — show a toast with a manual rebuild escape hatch.
  const [ctxLost, setCtxLost] = useState(false);
  const [counts, setCounts] = useState<{ nodes: number; edges: number }>({
    nodes: 0,
    edges: 0,
  });
  settingsRef.current = settings;

  // The idle galaxy swirl rotates the RENDERED layout on the main thread; the
  // worker's node copies don't see it. Before anything reheats the sim (drag,
  // force sliders, live growth) push the current positions across so nodes
  // don't snap back to their pre-swirl spots.
  const syncSwirl = useRef(() => {
    const sc = sceneRef.current;
    const sm = simRef.current;
    // Galaxy swirl AND orphan-moon orbits both move rendered positions.
    if (sc && sm) sm.syncBack(sc.snapshotPositions());
  }).current;

  // Compose hover + ingest state into the scene's style and push it.
  const pushStyle = useRef(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const state: SceneStyleState = {
      hoveredNode: hoverRef.current.node,
      neighbors: hoverRef.current.neighbors,
      focus: focusRef.current,
      pathNodes: pathRef.current,
      tints: ingestGlowRef.current.tint,
      pulseId: ingestGlowRef.current.pulseId,
      pulseScale: ingestGlowRef.current.pulseScale,
    };
    scene.setStyleState(state);
  }).current;

  useEffect(() => {
    saveGraphSettings(settings);
  }, [settings]);

  const tags = useMemo(() => collectTags(adjacency?.tags ?? {}), [adjacency]);
  const folders = useMemo(
    () => collectFolders(currentVault?.path ?? "", adjacency),
    [adjacency, currentVault?.path],
  );
  // Every markdown file — including link-less ones, which render as Obsidian's
  // free-floating "orphan" stars.
  const allFiles = useMemo(() => flattenMarkdown(fileTree), [fileTree]);

  // Dark vs. light node palette follows the RESOLVED graph background (not the
  // app theme), so the white skin always gets dark, saturated stars. Memoised to
  // a boolean so the graph rebuilds only when the light/dark actually flips.
  const lightBg = useMemo(
    () => isLightBackground(makeTheme(settings.skin)),
    // uiTheme IS a real dependency: the "auto" skin resolves its background from
    // the DOM (--bg), which flips with the app theme — a read the linter can't see.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings.skin, uiTheme],
  );

  // Gap report over the live graph. counts/glEpoch change on every rebuild /
  // live-ingest growth / context restore, so it re-derives when the graph does.
  const gapReport = useMemo(() => {
    const g = graphRef.current;
    return g && g.order > 0 ? analyzeGaps(g) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [counts, glEpoch]);

  // Legend: two-level galaxy → cluster hierarchy. Galaxy = top-level folder
  // (header); clusters = the coloured sub-groups within it (folder or Louvain
  // topic). Re-derives with the graph (counts proxies rebuilds).
  const legendGalaxies = useMemo<LegendGalaxy[]>(() => {
    const g = graphRef.current;
    if (!g || g.order === 0) return [];
    const rows: {
      id: string;
      community: number;
      galaxy: number;
      color: string;
      deg: number;
    }[] = [];
    g.forEachNode((id, a) => {
      rows.push({
        id,
        community: a.community,
        galaxy: a.galaxy,
        color: a.color,
        deg: a.deg,
      });
    });
    return buildLegend(rows, currentVault?.path ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [counts, glEpoch, currentVault?.path]);

  // --- Focus stack operations. stackRef is the source of truth (the scene's
  // callbacks are stable closures, so React state alone would go stale);
  // applyStack is the single writer keeping ref, UI state and scene in sync.
  // Refs updated via applyStack only. ---
  const stackRef = useRef<FocusFrame[]>([]);
  const applyStack = useRef((next: FocusFrame[]) => {
    stackRef.current = next;
    focusRef.current =
      next.length > 0 ? next[next.length - 1].members : null;
    setFocusStack(next);
    pushStyle();
  }).current;
  // Pop one level; retarget the inspector at the frame that becomes top.
  const popFrame = useRef(() => {
    const prev = stackRef.current;
    if (prev.length === 0) return false;
    const next = prev.slice(0, -1);
    applyStack(next);
    const top = next[next.length - 1];
    setSelected(top?.kind === "node" ? (top.id ?? null) : null);
    return true;
  }).current;
  // Breadcrumb click — truncate the stack to that frame.
  const popTo = (index: number): void => {
    const next = stackRef.current.slice(0, index + 1);
    applyStack(next);
    const top = next[next.length - 1];
    setSelected(top?.kind === "node" ? (top.id ?? null) : null);
  };

  // Node click. Cmd/Ctrl-click drives shortest-path mode (spec B3): the first
  // marks the start anchor, the next picks the end (the path useEffect then
  // computes it and lights the filament layer); re-Cmd-clicking the anchor
  // releases it. A plain click pushes a focus frame + opens the inspector; a
  // second plain click on the same node within DBL_MS upgrades 1-hop → 2-hop.
  const handleNodeClick = useRef((id: string, additive: boolean) => {
    const g = graphRef.current;
    if (!g || !g.hasNode(id)) return;
    // Spaceship mode: a click just opens the node's info in the ship HUD — no
    // focus frame, no trace, no camera jump (the pilot keeps flying).
    if (flyModeRef.current) {
      setSelected(id);
      return;
    }
    // Trace mode turns a plain click into path start/end picking (same flow as
    // Cmd/Ctrl-click), suppressing the focus-frame push.
    if (additive || traceModeRef.current) {
      const anchor = pathAnchorRef.current;
      if (anchor == null || anchor === id) {
        // set the start anchor, or release it if it's the same node
        setAnchor(anchor === id ? null : id);
        if (anchor === id) {
          pathRef.current = null;
          setPath(null);
          pushStyle();
        }
      } else {
        setSelected(id); // end node → path useEffect resolves the route
      }
      return;
    }
    // A plain click abandons any in-progress path.
    if (pathAnchorRef.current != null || pathRef.current != null) {
      setAnchor(null);
      pathRef.current = null;
      setPath(null);
    }
    const now = performance.now();
    const dbl =
      lastClickRef.current?.id === id && now - lastClickRef.current.at < DBL_MS;
    lastClickRef.current = { id, at: now };
    setSelected(id);
    // Selection impulse: supernova + neural activation ripple from the star.
    sceneRef.current?.impulse(id);
    const prev = stackRef.current;
    const top = prev[prev.length - 1];
    if (top?.kind === "node" && top.id === id) {
      if (dbl && top.hops === 1) {
        applyStack([
          ...prev.slice(0, -1),
          { kind: "node", id, hops: 2, label: stem(id), members: hopSet(g, id, 2) },
        ]);
      }
      return; // same node again (no upgrade) — keep the frame as-is
    }
    applyStack([
      ...prev,
      { kind: "node", id, hops: 1, label: stem(id), members: hopSet(g, id, 1) },
    ]);
  }).current;

  // Community isolation (legend swatch click) = a community focus frame.
  // Clicking the active swatch again releases it.
  const isolated =
    focusStack.length > 0 && focusStack[focusStack.length - 1].kind === "community"
      ? (focusStack[focusStack.length - 1].cm ?? null)
      : null;
  const isolateCommunity = (cm: number | null): void => {
    if (cm == null) {
      if (isolated != null) popFrame();
      return;
    }
    const g = graphRef.current;
    if (!g) return;
    const members = new Set<string>();
    g.forEachNode((id, a) => {
      if (a.community === cm) members.add(id);
    });
    if (members.size === 0) return;
    const label =
      legendGalaxies
        .flatMap((gg) => gg.clusters)
        .find((c) => c.cm === cm)?.label ?? `#${cm}`;
    applyStack([
      ...stackRef.current,
      { kind: "community", cm, label, members },
    ]);
  };

  // Esc pops one focus level (ignored while typing in an input).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (popFrame()) e.stopPropagation();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [popFrame]);

  // Fetch mtimes whenever the vault changes — drives the timelapse reveal order
  // (oldest file first, so the graph grows in creation order).
  useEffect(() => {
    if (!currentVault?.path) return;
    let cancelled = false;
    ipc
      .fileMtimes(currentVault.path)
      .then((rows) => {
        if (cancelled) return;
        tlOrderRef.current = [...rows]
          .sort((a, b) => a[1] - b[1])
          .map((r) => r[0]);
      })
      .catch(() => {
        /* mtime unavailable — timelapse just won't order by age */
      });
    return () => {
      cancelled = true;
    };
  }, [currentVault?.path]);

  // Build + render + settle. Re-runs when the underlying graph or any FILTER
  // changes. Each run tears the old scene/sim down and creates a fresh one.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !adjacency) return;
    const s = settingsRef.current;
    const theme = makeTheme(s.skin);

    const allowed = computeAllowed(adjacency, allFiles, {
      tagFilter: s.tagFilter,
      folderFilter: s.folderFilter,
      vaultRoot: currentVault?.path ?? "",
      search: s.search,
      existingOnly: s.existingOnly,
      showOrphans: s.showOrphans,
    });
    const graph: VaultGraph = buildGraph(adjacency, allowed, {
      nodeSize: s.nodeSize,
      starDim: theme.starDim,
      edgeColor: theme.edge,
      // existingOnly hides non-existent files → also hide ghost link targets.
      showGhosts: !s.existingOnly,
      semanticEdges: s.semanticEdges ? semEdgesRef.current : undefined,
      folderGalaxies: s.folderGalaxies,
      vaultRoot: currentVault?.path ?? "",
      lightBg,
    });
    graphRef.current = graph;
    setCounts({ nodes: graph.order, edges: graph.size });
    if (graph.order === 0) return;

    // Reset transient style for the fresh scene.
    hoverRef.current = { node: null, neighbors: null };
    setSelected(null);
    setAnchor(null);
    pathRef.current = null;
    setPath(null);
    applyStack([]);
    lastClickRef.current = null;

    let killed = false;
    let userTookOver = false;
    // The first settled frame arrives as a camera FLIGHT (eased fit); later
    // settles just re-frame instantly.
    let introPlayed = false;

    const highlight = (node: string): void => {
      const neighbors = new Set(graph.neighbors(node));
      neighbors.add(node);
      hoverRef.current = { node, neighbors };
      pushStyle();
    };
    const clearHighlight = (): void => {
      hoverRef.current = { node: null, neighbors: null };
      pushStyle();
    };

    let draggedSim: SimNode | undefined;

    const scene = new GraphScene(container, graph, theme, s, {
      onNodeClick: (id, additive) => {
        if (!killed) handleNodeClick(id, additive);
      },
      onVoidClick: () => {
        if (killed) return;
        // In spaceship mode a void click just closes the HUD; otherwise it's the
        // focus-stack "step out" gesture.
        if (flyModeRef.current) setSelected(null);
        else popFrame();
      },
      onNodeHover: (id) => {
        if (id) highlight(id);
        else clearHighlight();
      },
      onDragStart: (id) => {
        syncSwirl(); // adopt swirled positions before the pin + reheat
        draggedSim = simRef.current?.nodes.find((n) => n.id === id);
        highlight(id);
        if (draggedSim) {
          // Pin the node in the worker (it owns the mutable sim node now).
          simRef.current?.setFixed(id, draggedSim.x, draggedSim.y, draggedSim.z);
        }
        simRef.current?.reheat(0.2); // lighter reheat → shorter post-drag settle
      },
      onDrag: (id, x, y, z) => {
        simRef.current?.setFixed(id, x, y, z);
        // Render the dragged node at the cursor immediately — the worker tick
        // confirming the pin arrives a frame or two later, so apply locally for
        // zero-latency drag feedback.
        graph.mergeNodeAttributes(id, { x, y, z });
        sceneRef.current?.syncPositions();
      },
      onDragEnd: () => {
        if (draggedSim) simRef.current?.releaseFixed(draggedSim.id);
        draggedSim = undefined;
        clearHighlight();
        // Reheat so the released star and its neighbours ease back to rest.
        simRef.current?.reheat(0.2); // lighter reheat → shorter post-drag settle
      },
      onContextLost: () => {
        if (!killed) setCtxLost(true);
      },
      onContextRestored: () => {
        setCtxLost(false);
        setGlEpoch((n) => n + 1);
      },
    });
    sceneRef.current = scene;
    scene.setScaleListener((sc) => {
      const label = { cluster: "Galaxy cluster", galaxy: "Galaxy", system: "Star system", star: "Star" }[sc];
      setCosmicScale(label);
      if (scaleHideRef.current != null) window.clearTimeout(scaleHideRef.current);
      scaleHideRef.current = window.setTimeout(() => setCosmicScale(null), 2200);
    });
    scene.start();

    // DEV-ONLY: expose the scene/graph so a screenshot harness can drive it.
    if (import.meta.env.DEV) {
      (window as unknown as { __graphDev?: unknown }).__graphDev = {
        scene,
        graph,
        rect: () => container.getBoundingClientRect(),
      };
    }

    // Static 2D ForceAtlas2 layouts (no worker sim): "atlas" = compact Gephi
    // territory map (+ hull fills); "synapse" = communities flung far apart
    // as bright cores joined by nerve-fibre bridges. Both run the same sliced
    // FA2 pipeline; only the force tuning + edge rendering differ. Everything
    // downstream guards on simRef being null.
    if (s.layout === "atlas" || s.layout === "synapse") {
      // FA2 runs in event-loop slices (see atlasLayout.ts freeze postmortem):
      // the map visibly unfolds as it converges, the UI stays interactive the
      // whole time, and unmount/layout-switch aborts mid-run. NEVER run it
      // synchronously — a 10k vault wedged the WebKit renderer for minutes
      // and the persisted layout choice re-froze every app launch.
      let atlasTookOver = false;
      const atlasTakeOver = (): void => {
        atlasTookOver = true;
      };
      container.addEventListener("wheel", atlasTakeOver, { passive: true, once: true });
      container.addEventListener("pointerdown", atlasTakeOver, { once: true });
      let slices = 0;
      void applyAtlasLayout(graph, {
        variant: s.layout === "synapse" ? "synapse" : "atlas",
        // Synapse spreads wider, so give it more world room to frame into.
        targetRadius: s.linkDistance * ATLAS_RADIUS_MUL * (s.layout === "synapse" ? 1.6 : 1),
        shouldAbort: () => killed,
        onProgress: () => {
          if (killed) return;
          // Live preview: show the map forming instead of a frozen loader.
          sceneRef.current?.syncPositions();
          container.classList.add("graph-ready");
          if (!atlasTookOver && (slices = (slices + 1) % 8) === 0) {
            sceneRef.current?.fit();
          }
        },
      }).then((completed) => {
        if (killed || !completed) return;
        sceneRef.current?.syncPositions();
        sceneRef.current?.layoutSettled(); // bundled strands over the static map
        if (!atlasTookOver) {
          sceneRef.current?.fit(undefined, introPlayed ? 0 : 2600);
          introPlayed = true;
        }
        container.classList.add("graph-ready");
      });
      return () => {
        killed = true;
        container.removeEventListener("wheel", atlasTakeOver);
        container.removeEventListener("pointerdown", atlasTakeOver);
        if (tlRafRef.current != null) {
          cancelAnimationFrame(tlRafRef.current);
          tlRafRef.current = null;
        }
        setTlPlaying(false);
        scene.dispose();
        sceneRef.current = null;
        graphRef.current = null;
        container.classList.remove("graph-ready");
      };
    }

    // The sim runs in a worker; each tick posts a position array (node order)
    // that the scene applies directly to its buffers (and mirrors back into the
    // graph for hover/fit/nebula). The main thread never runs the force stack.
    const sim = createSim(graph, s, (positions) =>
      sceneRef.current?.applyPositions(positions),
    );
    simRef.current = sim;

    // A user drag/zoom hands the camera over so the settle re-fit doesn't fight
    // manual orbit.
    const takeOver = (): void => {
      userTookOver = true;
    };
    container.addEventListener("wheel", takeOver, { passive: true, once: true });
    container.addEventListener("pointerdown", takeOver, { once: true });

    // Track the layout with the camera as it settles — the seeded sphere is
    // large, so without re-fitting the cluster shrinks to a speck while the
    // camera stays far. Stops once the user orbits or the sim settles.
    const fitTimer = window.setInterval(() => {
      if (!killed && !userTookOver) sceneRef.current?.fit();
    }, 450);
    const revealTimer = window.setTimeout(() => {
      if (!killed) container.classList.add("graph-ready");
    }, 300);
    const finalFit = (metrics?: LayoutMetrics): void => {
      window.clearInterval(fitTimer);
      if (killed) return;
      // Frame from the worker's measured settled extent when available (A1);
      // the no-metrics safety path falls back to the scene's own scan.
      if (!userTookOver) {
        // First settle: cinematic eased arrival onto the framed galaxy.
        // Later settles (drag/slider) re-frame instantly as before.
        sceneRef.current?.fit(metrics, introPlayed ? 0 : 2600);
        introPlayed = true;
      }
      container.classList.add("graph-ready");
    };
    const revealSafety = window.setTimeout(finalFit, 12000);
    sim.onSettle((metrics) => {
      window.clearTimeout(revealSafety);
      if (killed) return;
      // Every settle (initial, post-drag, post-slider) refreshes the bundled
      // strands so the arcs track wherever the clusters ended up.
      sceneRef.current?.layoutSettled();
      finalFit(metrics);
    });

    return () => {
      killed = true;
      window.clearInterval(fitTimer);
      window.clearTimeout(revealTimer);
      window.clearTimeout(revealSafety);
      // Tear down any in-flight timelapse before scene/sim die.
      if (tlRafRef.current != null) {
        cancelAnimationFrame(tlRafRef.current);
        tlRafRef.current = null;
      }
      setTlPlaying(false);
      container.removeEventListener("wheel", takeOver);
      container.removeEventListener("pointerdown", takeOver);
      sim.stop();
      scene.dispose();
      sceneRef.current = null;
      simRef.current = null;
      graphRef.current = null;
      container.classList.remove("graph-ready");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    adjacency,
    allFiles,
    currentVault?.path,
    settings.tagFilter,
    settings.folderFilter,
    settings.search,
    settings.existingOnly,
    settings.showOrphans,
    settings.nodeSize,
    settings.folderGalaxies,
    settings.layout,
    glEpoch,
    // NOTE: lightBg is intentionally NOT here — a light/dark flip recolours the
    // existing graph in place (see the theme effect) instead of rebuilding the
    // whole sim, which would reflow the layout and jitter on every skin switch.
  ]);

  // Force sliders — re-tune the running sim in place (no rebuild), then ease.
  useEffect(() => {
    if (!simRef.current) return;
    syncSwirl(); // the update reheats — adopt swirled positions first
    simRef.current.update(settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    settings.centerForce,
    settings.repelForce,
    settings.linkForce,
    settings.linkDistance,
    settings.clusterForce,
  ]);

  // Display sliders — restyle without rebuilding the graph/sim.
  useEffect(() => {
    sceneRef.current?.applySettings(settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    settings.linkThickness,
    settings.textFadeThreshold,
    settings.arrows,
    settings.arrowSize,
    settings.brightness,
    settings.ambientMotion,
    settings.nodeColor,
    settings.monoBelow,
    settings.nodeColorDepth,
    settings.edgeBundles,
    settings.edgeTint,
  ]);

  // Theme/skin toggle — recolour the scene. Re-read AFTER the app's theme
  // effect has flipped --bg (rAF + a slow-start safety timeout). A skin change
  // rides the same path: sync the scene's settings first (the starfield/nebula
  // gates read settings.skin), then apply the resolved palette.
  useEffect(() => {
    const apply = (): void => {
      const sc = sceneRef.current;
      if (!sc) return;
      // Recolour the graph in place for the resolved light/dark background, then
      // applyTheme's writeNodes pushes the new colours — no sim rebuild/jitter.
      const g = graphRef.current;
      if (g) recolorGraph(g, isLightBackground(makeTheme(settingsRef.current.skin)));
      sc.applySettings(settingsRef.current);
      sc.applyTheme(makeTheme(settingsRef.current.skin));
    };
    const raf = requestAnimationFrame(apply);
    const safety = window.setTimeout(apply, 300);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(safety);
    };
  }, [uiTheme, settings.skin]);

  // Spaceship keyboard: F toggles fly mode, Esc exits. Ignored while typing in an
  // input so the search box still accepts "f"/Escape. Registered once; reads live
  // state via refs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = document.activeElement as HTMLElement | null;
      const typing =
        !!el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable);
      if (typing) return;
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        toggleFly(!flyModeRef.current);
      } else if (e.key === "Escape" && flyModeRef.current) {
        e.preventDefault();
        toggleFly(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-apply fly mode after a scene rebuild (GL restore / data change) so the
  // fresh scene resumes flying instead of snapping back to orbit.
  useEffect(() => {
    if (flyModeRef.current) sceneRef.current?.setFlyMode(true);
  }, [glEpoch]);

  // HUD speed: poll the ship a few times a second while flying (cheap read;
  // state churn stays out of the render loop).
  useEffect(() => {
    if (!flyMode) return;
    const timer = window.setInterval(() => {
      setShipSpeed(sceneRef.current?.shipSpeed() ?? 0);
    }, 150);
    return () => window.clearInterval(timer);
  }, [flyMode]);

  // Semantic overlay edges: fetch (or clear) when the toggle flips, then force a
  // graph rebuild so buildGraph picks them up from the ref.
  useEffect(() => {
    let killed = false;
    if (!settings.semanticEdges) {
      semEdgesRef.current = [];
      setGlEpoch((e) => e + 1);
      return;
    }
    ipc
      .semanticEdges(4)
      .then((edges) => {
        if (killed) return;
        semEdgesRef.current = edges;
        setGlEpoch((e) => e + 1);
      })
      .catch(() => {
        if (!killed) semEdgesRef.current = [];
      });
    return () => {
      killed = true;
    };
  }, [settings.semanticEdges]);

  // Live-ingest glow — mirror ingestStore's touched files into the style ref
  // and pulse the newest touch. Subscribes once; every change is a cheap scene
  // restyle (no graph/sim rebuild). Tints survive the run ending so the user
  // can see what changed; they clear when the store resets.
  useEffect(() => {
    const glow = ingestGlowRef.current;

    const startPulse = (id: string): void => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      if (pulseRafRef.current != null) cancelAnimationFrame(pulseRafRef.current);
      const start = performance.now();
      const tick = (): void => {
        const p = (performance.now() - start) / PULSE_MS;
        if (p >= 1 || !sceneRef.current) {
          glow.pulseId = null;
          glow.pulseScale = 1;
          pulseRafRef.current = null;
          pushStyle();
          return;
        }
        glow.pulseId = id;
        // Swell up and ease back: 1 → ~2.6 → 1.
        glow.pulseScale = 1 + 1.6 * Math.sin(Math.PI * p);
        pushStyle();
        pulseRafRef.current = requestAnimationFrame(tick);
      };
      pulseRafRef.current = requestAnimationFrame(tick);
    };

    const sync = (
      touched: { path: string; write: boolean }[],
      ingestVault: string | null,
      pulse: boolean,
    ): void => {
      const vault = useVaultStore.getState().currentVault?.path;
      if (!vault || !ingestVault || ingestVault !== vault) return;
      let newest: string | null = null;
      const next = new Map<string, boolean>();
      for (const f of touched) {
        const abs = `${vault}/${f.path}`;
        next.set(abs, f.write);
        if (glow.tint.get(abs) !== f.write) newest = abs;
      }
      glow.tint = next;
      if (pulse && newest) startPulse(newest);
      pushStyle();
    };

    // --- Live growth: pages the ingest writes appear in the galaxy as it runs.
    // DIFF the rescanned link graph against the rendered one, inject only new
    // nodes/edges (graph.addNode + sim.liveAdd), then rebuild the scene buffers
    // so the newcomers render. The settled layout never tears down. ---
    const liveGrow = (adj: Adjacency): void => {
      const sim = simRef.current;
      const g = graphRef.current;
      const scene = sceneRef.current;
      const vault = useVaultStore.getState().currentVault?.path;
      const ing = useIngestStore.getState();
      if (!sim || !g || !scene || !vault || ing.vaultPath !== vault) return;
      const s = settingsRef.current;
      const theme = makeTheme(s.skin);
      const files = flattenMarkdown(useVaultStore.getState().fileTree);
      const allowed = computeAllowed(adj, files, {
        tagFilter: s.tagFilter,
        folderFilter: s.folderFilter,
        vaultRoot: vault,
        search: s.search,
        existingOnly: s.existingOnly,
        showOrphans: s.showOrphans,
      });

      const newEdges: [string, string][] = [];
      const newIdSet = new Set<string>();
      for (const [src, targets] of Object.entries(adj.forward)) {
        if (!allowed.has(src)) continue;
        for (const tgt of targets) {
          if (!allowed.has(tgt)) continue;
          const srcKnown = g.hasNode(src);
          const tgtKnown = g.hasNode(tgt);
          if (srcKnown && tgtKnown && g.hasEdge(src, tgt)) continue;
          if (!srcKnown) newIdSet.add(src);
          if (!tgtKnown) newIdSet.add(tgt);
          newEdges.push([src, tgt]);
        }
      }
      if (newIdSet.size === 0 && newEdges.length === 0) return;

      // Position each new node beside its first positioned endpoint so it buds
      // off the cluster instead of streaking in from the far field.
      const placed = new Map<string, { x: number; y: number; z: number }>();
      const posOf = (id: string): { x: number; y: number; z: number } | null => {
        if (g.hasNode(id))
          return {
            x: g.getNodeAttribute(id, "x"),
            y: g.getNodeAttribute(id, "y"),
            z: g.getNodeAttribute(id, "z"),
          };
        return placed.get(id) ?? null;
      };
      const jitter = (): number => (Math.random() - 0.5) * 40;
      for (const id of newIdSet) {
        let near: { x: number; y: number; z: number } | null = null;
        for (const [a, b] of newEdges) {
          if (a === id) near = posOf(b);
          else if (b === id) near = posOf(a);
          if (near) break;
        }
        placed.set(id, {
          x: (near?.x ?? 0) + jitter(),
          y: (near?.y ?? 0) + jitter(),
          z: (near?.z ?? 0) + jitter(),
        });
      }
      for (const id of newIdSet) {
        const p = placed.get(id)!;
        g.addNode(id, {
          label: stem(id),
          x: p.x,
          y: p.y,
          z: p.z,
          deg: 0,
          size: Math.max(1, s.nodeSize),
          color: theme.starDim,
          community: -1, // field star until the next colorByCommunity rebuild
          galaxy: -1, // assigned on the next folderGroups rebuild
          isHub: false,
          intensity: 0,
        });
      }
      const addedEdges: [string, string][] = [];
      for (const [a, b] of newEdges) {
        if (!g.hasNode(a) || !g.hasNode(b) || g.hasEdge(a, b)) continue;
        g.addEdge(a, b, { color: theme.edge, size: 0.6 * s.linkThickness });
        addedEdges.push([a, b]);
      }
      // Degree-derived size for the newcomers only — existing stars keep theirs
      // until the end-of-run rebuild recomputes everything.
      for (const id of newIdSet) {
        const deg = g.degree(id);
        g.mergeNodeAttributes(id, {
          deg,
          size: Math.max(1, Math.min(5, 1 + Math.sqrt(deg) * 0.7)) * s.nodeSize,
          starKind: starKindOf(id, deg, 0),
        });
      }
      syncSwirl(); // liveAdd reheats — adopt swirled positions first
      sim.liveAdd([...newIdSet], addedEdges);
      scene.rebuild();
      pushStyle();
      setCounts({ nodes: g.order, edges: g.size });
    };

    // Adopt any already-running (or just-finished) ingest on mount.
    const st = useIngestStore.getState();
    sync(st.touched, st.vaultPath, false);
    if (st.liveAdjacency) liveGrow(st.liveAdjacency);

    const unsub = useIngestStore.subscribe((s, prev) => {
      if (s.stage === "idle" && prev.stage !== "idle") {
        glow.tint = new Map();
        glow.pulseId = null;
        pushStyle();
        return;
      }
      if (s.touched !== prev.touched) sync(s.touched, s.vaultPath, true);
      if (s.liveAdjacency && s.liveAdjacency !== prev.liveAdjacency)
        liveGrow(s.liveAdjacency);
    });
    return () => {
      unsub();
      if (pulseRafRef.current != null) cancelAnimationFrame(pulseRafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Timelapse — replay the vault's growth in creation order with LIVE physics.
  // The sim is reset to empty, then nodes are revealed oldest-first; each spawns
  // at the galactic centre and the running d3-force-3d flings it outward,
  // physically shoving the placed stars aside. The galaxy assembles in real time.
  const REVEAL_MS = 18000;
  // --- timelapse WebM recorder: captureStream on the WebGL canvas while the
  // replay runs, download on finish. The vault-growing-into-a-galaxy clip is
  // the single most shareable thing the app produces — one click, no tooling.
  const tlRecorderRef = useRef<MediaRecorder | null>(null);
  const stopTlRecorder = (): void => {
    const rec = tlRecorderRef.current;
    tlRecorderRef.current = null;
    if (rec && rec.state !== "inactive") rec.stop();
  };
  const startTlRecorder = (): void => {
    const canvas = sceneRef.current?.canvas;
    if (!canvas || typeof MediaRecorder === "undefined") return;
    try {
      const stream = canvas.captureStream(30);
      const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find(
        (m) => MediaRecorder.isTypeSupported(m),
      );
      const rec = new MediaRecorder(stream, {
        mimeType: mime,
        videoBitsPerSecond: 8_000_000,
      });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      rec.onstop = () => {
        if (chunks.length === 0) return;
        const url = URL.createObjectURL(new Blob(chunks, { type: "video/webm" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = "memex-timelapse.webm";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      };
      rec.start(500);
      tlRecorderRef.current = rec;
    } catch {
      tlRecorderRef.current = null; // recording is best-effort sugar
    }
  };

  const startTimelapse = (record = false): void => {
    const scene = sceneRef.current;
    const sim = simRef.current;
    const graph = graphRef.current;
    if (!scene || !sim || !graph || graph.order === 0) return;
    scene.setCinematicOrbit(true); // recordings read as a produced shot
    if (record) startTlRecorder();

    const present = new Set(graph.nodes());
    const order = tlOrderRef.current.filter((p) => present.has(p));
    const seen = new Set(order);
    graph.forEachNode((n) => {
      if (!seen.has(n)) order.push(n);
    });

    graph.forEachNode((n) => graph.setNodeAttribute(n, "hidden", true));
    sim.timelapseReset();
    scene.refreshStyle(); // `hidden` changed → full write (per-tick path is pos-only)
    // Blank the bundled strands too — every node is hidden, so the rebuild
    // empties all tiers; without this up to 80 stale arcs float over the empty
    // sky for the whole replay (no settle fires until the end restores them).
    scene.layoutSettled();
    setTlPlaying(true);

    let next = 0;
    // Progress accumulates per-frame scaled by the LIVE speed setting, so the
    // slider works mid-replay (an elapsed-time mapping would jump).
    let progress = 0;
    let last = performance.now();
    const step = (): void => {
      const sc = sceneRef.current;
      const sm = simRef.current;
      const g = graphRef.current;
      if (!sc || !sm || !g) {
        tlRafRef.current = null;
        return;
      }
      const now = performance.now();
      progress += ((now - last) * (settingsRef.current.tlSpeed || 1)) / REVEAL_MS;
      last = now;
      const want = Math.min(order.length, Math.ceil(progress * order.length));
      if (want > next) {
        const batch = order.slice(next, want);
        for (const id of batch) g.setNodeAttribute(id, "hidden", false);
        sm.timelapseReveal(batch); // spawns at centre + keeps the sim hot
        sc.refreshStyle(); // newly-revealed nodes/edges need their alpha/colour
        next = want;
      }
      if (next < order.length) {
        tlRafRef.current = requestAnimationFrame(step);
      } else {
        sm.timelapseSettle();
        // Finale: the year-of-notes replay ends on a bang — a supernova at the
        // last (newest) star revealed. No-op under OS reduced motion.
        if (order.length > 0) sc.supernovaAt(order[order.length - 1]);
        tlRafRef.current = null;
        setTlPlaying(false);
        sc.setCinematicOrbit(false);
        // Let the final settle breathe on camera before the clip ends.
        window.setTimeout(stopTlRecorder, 2500);
      }
    };
    tlRafRef.current = requestAnimationFrame(step);
  };

  // Pause — reveal everything that's left at once, then let the live sim settle.
  const pauseTimelapse = (): void => {
    if (tlRafRef.current != null) {
      cancelAnimationFrame(tlRafRef.current);
      tlRafRef.current = null;
    }
    const scene = sceneRef.current;
    const sim = simRef.current;
    const graph = graphRef.current;
    if (scene && sim && graph) {
      graph.forEachNode((n) => graph.setNodeAttribute(n, "hidden", false));
      sim.timelapseReveal(graph.nodes());
      sim.timelapseSettle();
      scene.refreshStyle(); // un-hid everything → full write to restore alpha/colour
      scene.setCinematicOrbit(false);
    }
    stopTlRecorder();
    setTlPlaying(false);
  };

  useEffect(() => {
    return () => {
      if (tlRafRef.current != null) cancelAnimationFrame(tlRafRef.current);
    };
  }, []);

  // Search-to-focus: fly the camera to the best-matching node and open its
  // inspector. Distinct from the drawer's filter search (which subsets the
  // graph); this leaves the graph intact and just frames + selects a star.
  const focusFind = (q: string): void => {
    const g = graphRef.current;
    const scene = sceneRef.current;
    const needle = q.trim().toLowerCase();
    if (!g || !scene || !needle) return;
    let best: string | null = null;
    let bestScore = 0;
    let bestLen = Infinity;
    g.forEachNode((id) => {
      const s = stem(id).toLowerCase();
      const score =
        s === needle ? 3 : s.startsWith(needle) ? 2 : s.includes(needle) ? 1 : 0;
      if (score === 0) return;
      if (score > bestScore || (score === bestScore && s.length < bestLen)) {
        best = id;
        bestScore = score;
        bestLen = s.length;
      }
    });
    if (best) {
      setSelected(best);
      scene.focusNode(best);
    }
  };

  // Shortest-path: when a start node is pinned and another is selected, BFS the
  // route and light it on the filament layer (spec B3) via pathRef → pushStyle.
  useEffect(() => {
    const g = graphRef.current;
    if (
      !g ||
      !pathAnchor ||
      !selected ||
      pathAnchor === selected ||
      !g.hasNode(pathAnchor) ||
      !g.hasNode(selected)
    ) {
      if (pathRef.current) {
        pathRef.current = null;
        setPath(null);
        pushStyle();
        sceneRef.current?.setTrace(null);
      }
      return;
    }
    const p = shortestPath(g, pathAnchor, selected);
    pathRef.current = p;
    setPath(p);
    pushStyle();
    // Animate the traversal comet along the resolved route (null path = clear).
    sceneRef.current?.setTrace(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathAnchor, selected]);

  const totalNodes = countAllNodes(adjacency);

  // Node info for the spaceship HUD (title, colour, link count, neighbours).
  const flyNode = useMemo(() => {
    if (!flyMode || !selected) return null;
    const g = graphRef.current;
    if (!g || !g.hasNode(selected)) return null;
    const a = g.getNodeAttributes(selected);
    return {
      id: selected,
      title: stem(selected),
      color: a.color ?? "#9aa6c2",
      degree: g.degree(selected),
      neighbors: g.neighbors(selected).slice(0, 10).map(stem),
    };
  }, [flyMode, selected]);

  return (
    <div
      className={`workspace workspace-wide${flyMode ? " graph-fullscreen" : ""}`}
    >
      <header className="page-head">
        <div className="page-eyebrow">{t.nav_graph}</div>
        <h1 className="page-title">{t.gr_title}</h1>
        <p className="page-lede">{t.gr_lede}</p>
      </header>
      <div className="graph-shell">
        <div className="graph-toolbar">
          <span className="graph-stat">
            {counts.nodes}/{totalNodes} {t.gr_node_count}
          </span>
          <span className="graph-stat">
            {counts.edges} {t.gr_edge_count}
          </span>
          {focusStack.length > 0 ? (
            <nav
              className="graph-crumbs"
              aria-label={t.gr_focus_trail ?? "Focus trail"}
            >
              {focusStack.map((f, i) => (
                <button
                  key={`${f.kind}-${f.id ?? f.cm}-${i}`}
                  type="button"
                  className={`graph-chip${
                    i === focusStack.length - 1 ? " graph-chip--active" : ""
                  }`}
                  title={
                    i === focusStack.length - 1
                      ? (t.gr_focus_esc ?? "Esc / click the void to step out")
                      : undefined
                  }
                  onClick={() => popTo(i)}
                >
                  {f.label}
                  {f.kind === "node" && f.hops === 2 ? " ⁺²" : ""}
                </button>
              ))}
              <button
                type="button"
                className="graph-chip graph-chip--exit"
                onClick={() => popFrame()}
                aria-label={t.gr_focus_esc ?? "Step out (Esc)"}
                title={t.gr_focus_esc ?? "Step out (Esc)"}
              >
                ×
              </button>
            </nav>
          ) : null}
          <input
            className="graph-find"
            type="search"
            value={find}
            placeholder={t.gr_find_ph ?? "Find a note…"}
            aria-label={t.gr_find_ph ?? "Find a note"}
            onChange={(e) => setFind(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") focusFind(find);
            }}
          />
          <div className="graph-toolbar__spacer" />
          <button
            type="button"
            className="graph-toolbar__btn"
            onClick={() => (tlPlaying ? pauseTimelapse() : startTimelapse())}
            aria-pressed={tlPlaying}
            aria-label={
              tlPlaying
                ? (t.gr_timelapse_pause ?? "Pause timelapse")
                : (t.gr_timelapse_play ?? "Play timelapse")
            }
            title={
              tlPlaying
                ? (t.gr_timelapse_pause ?? "Pause timelapse")
                : (t.gr_timelapse_play ?? "Play timelapse")
            }
          >
            {tlPlaying ? (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                <rect x="2" y="2" width="3" height="8" />
                <rect x="7" y="2" width="3" height="8" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                <path d="M3 2 L10 6 L3 10 Z" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="graph-toolbar__btn"
            onClick={() => startTimelapse(true)}
            disabled={tlPlaying}
            aria-label={t.gr_timelapse_record ?? "Record timelapse (WebM)"}
            title={t.gr_timelapse_record ?? "Record timelapse (WebM)"}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <circle cx="6" cy="6" r="4" />
            </svg>
          </button>
          {/* Spaceship mode was only reachable via an undocumented F keypress —
              the most demo-able feature deserves a visible door. */}
          <button
            type="button"
            className="graph-toolbar__btn"
            onClick={() => toggleFly(!flyModeRef.current)}
            aria-pressed={flyMode}
            aria-label={t.gr_fly_btn ?? "Spaceship mode (F)"}
            title={t.gr_fly_btn ?? "Spaceship mode (F)"}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
              <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
              <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
              <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
            </svg>
          </button>
          <ZoomButtons sceneRef={sceneRef} t={t} />
          <button
            type="button"
            className="graph-toolbar__btn graph-toolbar__btn--badged"
            onClick={() => setGapsOpen((v) => !v)}
            aria-pressed={gapsOpen}
            aria-label={t.gr_gaps_btn ?? "Gap analysis"}
            title={t.gr_gaps_btn ?? "Gap analysis"}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            {gapReport && gapCount(gapReport) > 0 ? (
              <span className="graph-toolbar__badge">{gapCount(gapReport)}</span>
            ) : null}
          </button>
          <button
            type="button"
            className="graph-toolbar__btn"
            onClick={() => setDrawerOpen((v) => !v)}
            aria-pressed={drawerOpen}
            aria-label={t.gr_settings ?? "Graph settings"}
            title={t.gr_settings ?? "Graph settings"}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" />
              <path
                d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          {/* Gesture cheat-sheet — click/double-click/Cmd-click/Esc/F/drag were
              previously undocumented; the "?" is their one visible door. */}
          <button
            type="button"
            className="graph-toolbar__btn"
            onClick={() => setHelpOpen((v) => !v)}
            aria-pressed={helpOpen}
            aria-label={t.gr_help_btn ?? "Gestures & keys"}
            title={t.gr_help_btn ?? "Gestures & keys"}
          >
            ?
          </button>
        </div>
        <div className="graph-body">
          <div className="graph-canvas-wrap">
            <div ref={containerRef} className="graph-canvas" />
            {/* Loading state: visible until .graph-ready lands on the canvas
                (adjacent-sibling CSS — no extra React state). */}
            {counts.nodes > 0 ? (
              <p className="muted graph-loading-tip" aria-hidden="true">
                {t.gr_loading ?? "aligning constellations…"}
              </p>
            ) : null}
            {ctxLost ? (
              <div className="graph-toast" role="alert">
                <span>{t.gr_ctx_lost ?? "Graphics context was lost."}</span>
                <button
                  type="button"
                  className="graph-toolbar__btn"
                  onClick={() => {
                    setCtxLost(false);
                    setGlEpoch((n) => n + 1);
                  }}
                >
                  {t.gr_retry ?? "Rebuild"}
                </button>
              </div>
            ) : null}
            {cosmicScale ? (
              <div className="graph-scale-badge" aria-live="polite">
                {t[`gr_scale_${cosmicScale === "Galaxy cluster" ? "cluster" : cosmicScale === "Galaxy" ? "galaxy" : cosmicScale === "Star system" ? "system" : "star"}` as keyof Strings] ?? cosmicScale}
              </div>
            ) : null}
            {counts.nodes > 5000 ? (
              <p className="muted graph-perf-banner">
                {t.gr_perf_mode ??
                  "Performance mode — ambient layers off for large graphs"}
              </p>
            ) : null}
            {totalNodes === 0 ? (
              <p className="muted graph-empty">
                {t.gr_empty_pre ??
                  "No wikilinks found in the vault yet. Add some "}
                <code style={{ fontFamily: "var(--font-mono)" }}>
                  [[wikilinks]]
                </code>
                {t.gr_empty_post ?? " to see the graph grow."}
              </p>
            ) : null}
            {selected && adjacency ? (
              <GraphInspector
                t={t}
                nodeId={selected}
                adjacency={adjacency}
                graph={graphRef.current}
                pathAnchor={pathAnchor}
                path={path}
                onSetAnchor={(id) => setAnchor(id)}
                onClearAnchor={() => {
                  setAnchor(null);
                  pathRef.current = null;
                  setPath(null);
                  pushStyle();
                }}
                onSelect={(id) => {
                  setSelected(id);
                  sceneRef.current?.focusNode(id);
                }}
                onOpen={(id) => setRoute(`page:${id}`)}
                onClose={() => setSelected(null)}
              />
            ) : null}
            <GraphLegend
              t={t}
              galaxies={legendGalaxies}
              isolated={isolated}
              onIsolate={isolateCommunity}
            />
            {gapsOpen && gapReport ? (
              <GraphGaps
                t={t}
                report={gapReport}
                onSelect={(id) => {
                  setSelected(id);
                  sceneRef.current?.focusNode(id);
                }}
                onClose={() => setGapsOpen(false)}
              />
            ) : null}
            {helpOpen ? (
              <GraphHelp t={t} onClose={() => setHelpOpen(false)} />
            ) : null}
          </div>
          <GraphControls
            t={t}
            open={drawerOpen}
            onToggle={() => setDrawerOpen((v) => !v)}
            settings={settings}
            onChange={(patch) => setSettings((prev) => ({ ...prev, ...patch }))}
            onReset={() => setSettings({ ...DEFAULT_GRAPH_SETTINGS, search: "" })}
            tags={tags}
            folders={folders}
            tlPlaying={tlPlaying}
            onTimelapse={tlPlaying ? pauseTimelapse : startTimelapse}
            traceMode={traceMode}
            onTraceMode={toggleTrace}
            flyMode={flyMode}
            onFlyMode={toggleFly}
          />
          {flyMode ? (
            <ShipHud
              t={t}
              node={flyNode}
              speed={shipSpeed}
              onClose={() => setSelected(null)}
              onOpen={(id) => setRoute(`page:${id}`)}
              onExit={() => toggleFly(false)}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ZoomButtons({
  sceneRef,
  t,
}: {
  sceneRef: React.MutableRefObject<GraphScene | null>;
  t: Strings;
}): JSX.Element {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      <button
        type="button"
        className="graph-toolbar__btn"
        onClick={() => sceneRef.current?.zoomOut()}
        aria-label={t.gr_zoom_out ?? "Zoom out"}
      >
        −
      </button>
      <button
        type="button"
        className="graph-toolbar__btn"
        onClick={() => sceneRef.current?.fit()}
        aria-label={t.gr_fit ?? "Fit"}
      >
        fit
      </button>
      <button
        type="button"
        className="graph-toolbar__btn"
        onClick={() => sceneRef.current?.zoomIn()}
        aria-label={t.gr_zoom_in ?? "Zoom in"}
      >
        +
      </button>
    </div>
  );
}
