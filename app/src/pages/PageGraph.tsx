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
import GraphGaps from "../components/GraphGaps";
import {
  DEFAULT_GRAPH_SETTINGS,
  loadGraphSettings,
  saveGraphSettings,
  type GraphSettings,
} from "../lib/graphSettings";
import {
  buildGraph,
  collectFolders,
  collectTags,
  computeAllowed,
  countAllNodes,
  flattenMarkdown,
  shortestPath,
  stem,
  type VaultGraph,
} from "../lib/graphData";
import { analyzeGaps, gapCount } from "../lib/graphGaps";
import { createSim, type GraphSim, type SimNode } from "../lib/graphSim";
import { readTheme } from "../lib/graphTheme";
import { GraphScene, type SceneStyleState } from "../lib/graphScene";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { useIngestStore } from "../stores/ingestStore";
import { ipc } from "../lib/ipc";
import type { Adjacency } from "../lib/ipc";

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

  const [settings, setSettings] = useState<GraphSettings>(() =>
    loadGraphSettings(),
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Clicked node → open the inspector panel (instead of navigating away).
  const [selected, setSelected] = useState<string | null>(null);
  // Search-to-focus query (toolbar) — jumps the camera to a node by name.
  const [find, setFind] = useState("");
  // Shortest-path: a pinned start node + the computed path to the selected node.
  const [pathAnchor, setPathAnchor] = useState<string | null>(null);
  const [path, setPath] = useState<string[] | null>(null);
  // Gap-analysis panel (orphans / missing / under-cited / disconnected …).
  const [gapsOpen, setGapsOpen] = useState(false);
  const [tlPlaying, setTlPlaying] = useState(false);
  // Bumped on webglcontextrestored to force a clean scene rebuild (WKWebView
  // drops the GL context on backgrounding; three.js does not auto-restore the
  // composer/render targets, so we tear down and rebuild a fresh GraphScene).
  const [glEpoch, setGlEpoch] = useState(0);
  const [counts, setCounts] = useState<{ nodes: number; edges: number }>({
    nodes: 0,
    edges: 0,
  });
  settingsRef.current = settings;

  // Compose hover + ingest state into the scene's style and push it.
  const pushStyle = useRef(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const state: SceneStyleState = {
      hoveredNode: hoverRef.current.node,
      neighbors: hoverRef.current.neighbors,
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

  // Gap report over the live graph. counts/glEpoch change on every rebuild /
  // live-ingest growth / context restore, so it re-derives when the graph does.
  const gapReport = useMemo(() => {
    const g = graphRef.current;
    return g && g.order > 0 ? analyzeGaps(g) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [counts, glEpoch]);

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
    const theme = readTheme();

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
    });
    graphRef.current = graph;
    setCounts({ nodes: graph.order, edges: graph.size });
    if (graph.order === 0) return;

    // Reset transient style for the fresh scene.
    hoverRef.current = { node: null, neighbors: null };
    setSelected(null);
    setPathAnchor(null);
    setPath(null);

    let killed = false;
    let userTookOver = false;

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
      onNodeClick: (id) => {
        if (!killed) setSelected(id);
      },
      onNodeHover: (id) => {
        if (id) highlight(id);
        else clearHighlight();
      },
      onDragStart: (id) => {
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
      onContextRestored: () => setGlEpoch((n) => n + 1),
    });
    sceneRef.current = scene;
    scene.start();

    // DEV-ONLY: expose the scene/graph so a screenshot harness can drive it.
    if (import.meta.env.DEV) {
      (window as unknown as { __graphDev?: unknown }).__graphDev = {
        scene,
        graph,
        rect: () => container.getBoundingClientRect(),
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
    const finalFit = (): void => {
      window.clearInterval(fitTimer);
      if (killed) return;
      if (!userTookOver) sceneRef.current?.fit();
      container.classList.add("graph-ready");
    };
    const revealSafety = window.setTimeout(finalFit, 12000);
    sim.onSettle(() => {
      window.clearTimeout(revealSafety);
      finalFit();
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
    glEpoch,
  ]);

  // Force sliders — re-tune the running sim in place (no rebuild), then ease.
  useEffect(() => {
    simRef.current?.update(settings);
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
    settings.brightness,
  ]);

  // Theme toggle — recolour the scene. Re-read AFTER the app's theme effect has
  // flipped --bg (rAF + a slow-start safety timeout).
  useEffect(() => {
    const apply = (): void => sceneRef.current?.applyTheme(readTheme());
    const raf = requestAnimationFrame(apply);
    const safety = window.setTimeout(apply, 300);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(safety);
    };
  }, [uiTheme]);

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
      const theme = readTheme();
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
        });
      }
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
  const startTimelapse = (): void => {
    const scene = sceneRef.current;
    const sim = simRef.current;
    const graph = graphRef.current;
    if (!scene || !sim || !graph || graph.order === 0) return;

    const present = new Set(graph.nodes());
    const order = tlOrderRef.current.filter((p) => present.has(p));
    const seen = new Set(order);
    graph.forEachNode((n) => {
      if (!seen.has(n)) order.push(n);
    });

    graph.forEachNode((n) => graph.setNodeAttribute(n, "hidden", true));
    sim.timelapseReset();
    scene.refreshStyle(); // `hidden` changed → full write (per-tick path is pos-only)
    setTlPlaying(true);

    let next = 0;
    const start = performance.now();
    const step = (): void => {
      const sc = sceneRef.current;
      const sm = simRef.current;
      const g = graphRef.current;
      if (!sc || !sm || !g) {
        tlRafRef.current = null;
        return;
      }
      const now = performance.now() - start;
      const want = Math.min(
        order.length,
        Math.ceil((now / REVEAL_MS) * order.length),
      );
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
        tlRafRef.current = null;
        setTlPlaying(false);
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
    }
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

  // Shortest-path highlight: when a start node is pinned and another node is
  // selected, BFS the path and light it up through the hover-highlight machinery
  // (anchor as "hovered", the whole path as its "neighbours").
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
      setPath(null);
      return;
    }
    const p = shortestPath(g, pathAnchor, selected);
    setPath(p);
    if (p && p.length > 1) {
      hoverRef.current = { node: pathAnchor, neighbors: new Set(p) };
      pushStyle();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathAnchor, selected]);

  const totalNodes = countAllNodes(adjacency);

  return (
    <div className="workspace workspace-wide">
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
            onClick={tlPlaying ? pauseTimelapse : startTimelapse}
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
          <ZoomButtons sceneRef={sceneRef} />
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
        </div>
        <div className="graph-body">
          <div className="graph-canvas-wrap">
            <div ref={containerRef} className="graph-canvas" />
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
                onSetAnchor={(id) => setPathAnchor(id)}
                onClearAnchor={() => {
                  setPathAnchor(null);
                  setPath(null);
                  hoverRef.current = { node: null, neighbors: null };
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
          />
        </div>
      </div>
    </div>
  );
}

function ZoomButtons({
  sceneRef,
}: {
  sceneRef: React.MutableRefObject<GraphScene | null>;
}): JSX.Element {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      <button
        type="button"
        className="graph-toolbar__btn"
        onClick={() => sceneRef.current?.zoomOut()}
        aria-label="Zoom out"
      >
        −
      </button>
      <button
        type="button"
        className="graph-toolbar__btn"
        onClick={() => sceneRef.current?.fit()}
        aria-label="Fit"
      >
        fit
      </button>
      <button
        type="button"
        className="graph-toolbar__btn"
        onClick={() => sceneRef.current?.zoomIn()}
        aria-label="Zoom in"
      >
        +
      </button>
    </div>
  );
}
