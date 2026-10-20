import { wovenInput, type WovenLayout } from "../lib/wovenLayout";
import { GRAPH_LOOK_COPY } from "../lib/graphLookCopy";
// Graph page — a 3D "universe" force-directed graph of the vault. d3-force-3d
// (lib/graphSim) runs the same Obsidian-style layout the 2D view used — now in
// three dimensions — and lib/graphScene renders it with three.js: glowing star
// nodes, faint filament edges, a starfield, depth fog and UnrealBloom, with
// OrbitControls for real z-axis orbit and idle auto-rotate. This file stays a
// thin React orchestrator: build/settle, drag, hover, timelapse, live-ingest
// glow and WebGL context-loss recovery — all driving the imperative GraphScene
// API instead of sigma.

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import AppPage from "../components/AppPage";
import { Button, IconButton, PHONE_QUERY, Segment, Sheet, useMediaQuery } from "../components/ui";
import GraphControls from "../components/GraphControls";
import GraphInspector from "../components/GraphInspector";
import ShipHud from "../components/ShipHud";
import GraphGaps, { gapGroups, gapStem, type GapAction } from "../components/GraphGaps";
import { displayName } from "../lib/displayName";
import { useTidyStore } from "../stores/tidyStore";
import GraphQuestions, {
  honestyDetails,
  honestyNote,
  type BuildStat,
  type SurveyCounts,
} from "../components/GraphQuestions";
import GraphHelp from "../components/GraphHelp";
import GraphMoreMenu from "../components/GraphMoreMenu";
import GraphLegend, { legendCount } from "../components/GraphLegend";
import { RailTab } from "../components/GraphRailToggle";
import {
  gestureHintDue,
  markGestureHintSeen,
  railKey,
  railsFoldInPane,
  type GraphRail,
} from "../lib/graphRails";
import {
  coupleMyceliumPatch,
  normalizeMyceliumPair,
  DEFAULT_GRAPH_SETTINGS,
  loadGraphSettings,
  matchMyceliumBg,
  myceliumBranchPct,
  myceliumInk,
  myceliumMaxNodes,
  saveGraphSettings,
  type GraphSettings,
} from "../lib/graphSettings";
import {
  buildGraph,
  buildLegend,
  findRank,
  collectFolders,
  collectTags,
  computeAllowed,
  countAllNodes,
  flattenMarkdown,
  isNonKnowledgePath,
  type LegendGalaxy,
  recolorGraph,
  seededUnit,
  shortestPath,
  starKindOf,
  stem,
  type VaultGraph,
} from "../lib/graphData";
import { analyzeGaps, clusterBridges, gapCount, type ClusterBridge } from "../lib/graphGaps";
import { clearFilters } from "../lib/graphFilters";
import { canvasLabel, escTarget, pickFocuses, pushNodeFrame, type FocusFrame } from "../lib/graphFocus";
import { pickBannerShown, relandAfterRebuild, settingsToSave, type ArrivalQuestion } from "../lib/graphLink";
import {
  encodeNode,
  hopsFrom,
  type EncNode,
  type EncState,
  type Encoding,
} from "../lib/graphEncoding";
import { isSamplePath } from "../lib/graphSample";
import { notice } from "../lib/notice";
import { setQueryPrefill } from "../lib/queryPrefill";
import { createSim, type GraphSim, type SimNode } from "../lib/graphSim";
import { createStaticDrag } from "../lib/staticDrag";
import { applyAtlasLayout } from "../lib/atlasLayout";
import { separateGraphLayout } from "../lib/layoutSeparation";
import { applySculptedLayout, isSculptedLayout } from "../lib/sculptedLayouts";
import { bakeSeededSky } from "../lib/skyTexture";
import {
  applyCelestialLayout,
  applyRadialLayout,
  applySpiralLayout,
  applyWalrusLayout,
  applyStrataLayout,
} from "../lib/staticLayouts";
import { ATLAS_RADIUS_MUL } from "../lib/layoutConfig";
import type { LayoutMetrics } from "../lib/layoutMetrics";
import { makeTheme, readTheme } from "../lib/graphTheme";
import { isLightBackground } from "../lib/graphSkins";
import { GraphScene, type SceneStyleState } from "../lib/graphScene";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { useIngestStore } from "../stores/ingestStore";
import { useMultiverseStore } from "../stores/multiverseStore";
import MultiverseScene from "../components/MultiverseScene";
import MascotCameo from "../components/MascotCameo";
import MyceliumView from "../components/MyceliumView";
import type { SceneUniverse } from "../lib/multiverseScene";
import { ipc } from "../lib/ipc";
import type { Adjacency, SemEdge } from "../lib/ipc";
import { isComposingKey } from "../lib/ime";

// Live-ingest node tints — pages the in-flight run wrote glow gold, pages it
// only read glow ice blue. Both sit inside the cosmic palette so they read as
// "hot" stars rather than UI chrome.
const PULSE_MS = 900;

// Frontmatter type of a map/overview page — a cluster with one has guidance,
// so the "무엇이 뭉쳐 있나" question rings the clusters that have none.
const MAP_TYPE = "overview";

// Charts and solid surfaces use their own geometry, without spaceship or planet effects.
const SURFACE_LAYOUTS = new Set<GraphSettings["layout"]>(["atlas", "synapse", "strata", "terrain", "city"]);

interface IngestGlow {
  /** absolute node id → was it written (vs only read) */
  tint: Map<string, boolean>;
  pulseId: string | null;
  pulseScale: number;
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

// The inspector's footprint on the canvas's right edge: `.graph-inspector`'s
// 290px width plus its 12px inset (styles.css).
const INSPECTOR_COVER_PX = 302;

export default function PageGraph({ t }: { t: Strings }): JSX.Element {
  const adjacency = useVaultStore((s) => s.adjacency);
  const fileTree = useVaultStore((s) => s.fileTree);
  const currentVault = useVaultStore((s) => s.currentVault);
  const openVault = useVaultStore((s) => s.openVault);
  const setRoute = useUIStore((s) => s.setRoute);
  const lang = useUIStore((s) => s.lang);
  const uiTheme = useUIStore((s) => s.theme);
  const graphFocus = useUIStore((s) => s.graphFocus);
  const setGraphFocus = useUIStore((s) => s.setGraphFocus);
  // Multiverse: the registered projects + their loaded graphs (kept in a store
  // separate from the single vault). Only read when the multiverse toggle is on.
  const mvOrder = useMultiverseStore((s) => s.order);
  const mvUniverses = useMultiverseStore((s) => s.universes);
  const mvLoadAll = useMultiverseStore((s) => s.loadAll);
  const mvLoading = useMultiverseStore((s) => s.isLoading);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<GraphScene | null>(null);
  const simRef = useRef<GraphSim | null>(null);
  // The mycelium view is a separate renderer (MyceliumView) the toolbar's Fit
  // and timelapse buttons don't otherwise reach — it stashes its own fit()
  // and startGrowth() here.
  const myceliumFitRef = useRef<(() => void) | null>(null);
  const myceliumGrowthRef = useRef<(() => void) | null>(null);
  // Fly-to-a-note for the mycelium renderer — search (Enter), the inspector's
  // link rows and gap analysis all call it alongside sceneRef.focusNode (the
  // hidden GraphScene's flight is a no-op on screen under the mycelium skin).
  const myceliumFocusRef = useRef<((id: string) => void) | null>(null);
  // Mycelium "force" sliders (linkDistance/clusterForce, repurposed as mat
  // density / branch density — see graphSettings.ts's myceliumMaxNodes/
  // myceliumBranchPct) rebuild the grown mat, ~80ms at 1244 notes. Debounced
  // so dragging the slider doesn't rebuild on every pixel of travel.
  const [myceliumForceDeb, setMyceliumForceDeb] = useState({
    linkDistance: DEFAULT_GRAPH_SETTINGS.linkDistance,
    clusterForce: DEFAULT_GRAPH_SETTINGS.clusterForce,
  });
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
  const [layoutScale, setLayoutScale] = useState({
    layout: settings.layout,
    distance: settings.linkDistance,
  });
  const usesStaticScale = !["galaxy", "synapse3d", "mycelium"].includes(settings.layout);
  // Static layouts read their scale only when positions are generated. Debounce
  // slider drags, but apply a newly selected look immediately at its own scale.
  const staticLayoutScale = usesStaticScale
    ? layoutScale.layout === settings.layout
      ? layoutScale.distance
      : settings.linkDistance
    : null;
  useEffect(() => {
    if (!usesStaticScale) return;
    const id = window.setTimeout(() => {
      setLayoutScale({ layout: settings.layout, distance: settings.linkDistance });
    }, 250);
    return () => window.clearTimeout(id);
  }, [settings.layout, settings.linkDistance, usesStaticScale]);
  useEffect(() => {
    const id = window.setTimeout(() => {
      setMyceliumForceDeb({
        linkDistance: settings.linkDistance,
        clusterForce: settings.clusterForce,
      });
    }, 250);
    return () => window.clearTimeout(id);
  }, [settings.linkDistance, settings.clusterForce]);
  // Transient "drilled into one universe" view-state — NOT persisted. Entering a
  // bubble shows that vault's single-vault graph while leaving the SAVED
  // Multiverse preference on (it used to be silently turned off on enter, which
  // mutated a stored setting behind the user's back). `showMultiverse` gates the
  // scene; `settings.multiverse` remains the preference the toggle reflects.
  const [enteredUniverse, setEnteredUniverse] = useState(false);
  const enteredUniverseRef = useRef(false);
  enteredUniverseRef.current = enteredUniverse;
  // Condensation intro plays once per Graph-page visit (not per rebuild).
  const introPlayedRef = useRef(false);
  // Semantic layout picked but no embedding index — the view fell back to the
  // spiral and this drives the "reindex first" hint.
  const [semanticMissing, setSemanticMissing] = useState(false);
  const showMultiverse = settings.multiverse && !enteredUniverse;
  const [drawerOpen, setDrawerOpen] = useState(false);
  // The toolbar's More button, which holds Graph settings. Closing the drawer
  // from inside it (its ×, its own Esc) would drop focus to <body> along with
  // the drawer, so focus comes here.
  const gearRef = useRef<HTMLButtonElement | null>(null);
  const toggleDrawer = (): void => {
    if (drawerOpen && document.activeElement?.closest("aside.graph-drawer")) gearRef.current?.focus();
    setDrawerOpen((v) => !v);
  };

  // Multiverse mode: warm every project's graph when the toggle turns on, and
  // expose the loaded ones to the scene. Kept minimal — the normal single-vault
  // path is untouched when `multiverse` is off.
  useEffect(() => {
    if (settings.multiverse) void mvLoadAll();
  }, [settings.multiverse, mvLoadAll]);
  // The universes to render: every registered project whose graph has loaded,
  // PLUS the currently-open vault itself (deduped by root). Including the open
  // vault means the multiverse is never empty — a standalone vault with no
  // project registry above it still shows as one bubble instead of a blank
  // scene (the "nothing renders" bug).
  const sceneUniverses = useMemo<SceneUniverse[]>(() => {
    const norm = (p: string): string => p.replace(/[\\/]+$/, "");
    const out: SceneUniverse[] = [];
    const seen = new Set<string>();
    for (const slug of mvOrder) {
      const u = mvUniverses[slug];
      if (u && u.adjacency) {
        out.push({ slug: u.info.slug, root: u.info.root, adjacency: u.adjacency, title: u.info.title });
        seen.add(norm(u.info.root));
      }
    }
    if (currentVault && adjacency && !seen.has(norm(currentVault.path))) {
      out.push({
        slug: currentVault.path, // path is unique; hue/label derive from it/name
        root: currentVault.path,
        adjacency,
        title: currentVault.name,
      });
    }
    return out;
  }, [mvOrder, mvUniverses, currentVault, adjacency]);
  // Fly-into-universe: switch the active vault to that project, then drop into
  // its normal single-vault graph. This flips the TRANSIENT view-state only —
  // the saved Multiverse preference stays on, so re-asserting it (the toggle, or
  // Reset) pops back to the bubble field. The current-vault bubble isn't a
  // registered project (no store entry) — clicking it just drops into the vault
  // you're already in.
  async function enterUniverse(slug: string): Promise<void> {
    const u = mvUniverses[slug];
    // Opening the vault sets the confinement root, the active-vault marker and
    // restarts the MCP server — everything a switch needs, for both registered
    // projects and sibling vaults. (The registry `active` pointer isn't updated
    // here; the marker is what the MCP server follows.)
    if (u) await openVault(u.info.root);
    setEnteredUniverse(true);
  }
  // Clicked node → open the inspector panel (instead of navigating away).
  const [selected, setSelected] = useState<string | null>(null);
  // The selection as of now rather than as of the last render. A scene can
  // report ready, and land a deep link, between a rebuild's commit and its
  // effect, whose closure still holds the older `selected`; the effect reads
  // this instead. Mirrored every render and written at once by showNode.
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;
  // Search-to-focus query (toolbar) — jumps the camera to a node by name.
  const [find, setFind] = useState("");
  const findRef = useRef<HTMLInputElement | null>(null);
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
    if (on && (settingsRef.current.skin === "mycelium" || SURFACE_LAYOUTS.has(settingsRef.current.layout))) return;
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
  // Scene-rebuild counter (the "씬 재빌드 N회 · x ms" chip). Only a corpus
  // change may move it — a question, the size channel or the find box restyle.
  const [build, setBuild] = useState<BuildStat>({ builds: 0, ms: 0 });
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
  const [wovenError, setWovenError] = useState(false);
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

  // A deep link's question shows for that visit without replacing the one the
  // user saved (settingsToSave); cleared once the question changes.
  const arrivalQRef = useRef<ArrivalQuestion | null>(null);
  useEffect(() => {
    const next = settingsToSave(settings, arrivalQRef.current);
    arrivalQRef.current = next.arrival;
    saveGraphSettings(next.save);
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

  // The APP theme, which is a different question from lightBg above: that one
  // resolves the SKIN's background, and the mycelium skin pins a dark loam
  // whatever the app is doing. The mycelium substrate needs the app's answer —
  // see myceliumInk.
  const lightApp = useMemo(
    () => isLightBackground(readTheme()),
    // readTheme() reads --bg off the DOM, a dependency the rule cannot see.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [uiTheme],
  );
  const mycInk = myceliumInk(settings, lightApp);

  // Gap report over the live graph. counts/glEpoch change on every rebuild /
  // live-ingest growth / context restore, so it re-derives when the graph does.
  const gapReport = useMemo(() => {
    const g = graphRef.current;
    return g && g.order > 0 ? analyzeGaps(g) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [counts, glEpoch]);

  // ── the question layer ────────────────────────────────────────────────────
  // Everything the four questions read, derived once per built graph (counts is
  // the render-visible rebuild signal, glEpoch the context-loss one). The
  // scene's own coordinates are untouched: a question only restyles.
  const derived = useMemo<Derived | null>(() => {
    const g = graphRef.current;
    if (!g || g.order === 0 || !adjacency) return null;
    return derive(g, adjacency, currentVault?.path ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [counts, glEpoch, adjacency, currentVault?.path]);

  // Session transcripts are structurally excluded from the graph (graphData's
  // NON_KNOWLEDGE_FOLDERS) — the honesty line has to say so rather than let the
  // node count imply the vault is that small.
  const sessionCount = useMemo(
    () => allFiles.filter((f) => isNonKnowledgePath(currentVault?.path ?? "", f)).length,
    [allFiles, currentVault?.path],
  );

  const hops = useMemo(() => {
    const g = graphRef.current;
    if (settings.question !== "neighbors" || !selected || !g || !g.hasNode(selected)) return null;
    return hopsFrom(selected, 2, (id) => (g.hasNode(id) ? g.neighbors(id) : []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derived, selected, settings.question]);

  // (node, question, state) → {color, radius, alpha, ring}, as ONE map so a
  // renderer stays a lookup per node. Search is deliberately NOT part of it:
  // the scene already owns that channel (setSearchHits → u_searchOn), and
  // dimming twice would erase the misses entirely.
  //
  // Held as a memo rather than pushed straight at the scene from an effect,
  // because BOTH renderers need it: the starfield takes it through
  // GraphScene.setEncoding below, and the mycelium skin — which mounts its own
  // canvas over the (hidden) starfield and knows nothing about GraphScene —
  // takes the very same map as a prop. Before this, picking a question under
  // the mycelium skin visibly did nothing at all.
  const encoding = useMemo<ReadonlyMap<string, Encoding> | null>(() => {
    if (!derived) return null;
    const cs = getComputedStyle(document.documentElement);
    const state: EncState = {
      sizeBy: settings.sizeBy,
      maxBacklinks: derived.maxBacklinks,
      hops,
      mapless: derived.mapless,
      search: "",
      selected,
      dimColor: cs.getPropertyValue("--ink-4").trim() || "#6b6a64",
      liveColor: cs.getPropertyValue("--live").trim() || "#a78bfa",
    };
    const enc = new Map<string, Encoding>();
    for (const [id, n] of derived.nodes) enc.set(id, encodeNode(n, settings.question, state));
    return enc;
    // uiTheme is a real dep: --ink-4 / --live are read off the DOM here, so a
    // theme flip must re-encode even though nothing else in the list moved.
    // The rule can't see a getComputedStyle read, hence the disable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derived, hops, selected, settings.question, settings.sizeBy, uiTheme]);
  const encodingRef = useRef(encoding);
  encodingRef.current = encoding;

  useEffect(() => {
    if (encoding) sceneRef.current?.setEncoding(encoding);
  }, [encoding]);

  // Deep link (lib/graphLink): arrive at a question, optionally at a note. The
  // note waits in arrivalRef until a laid-out scene can take it: selecting it
  // here on mount was undone by the build's own selection reset, and there was
  // no scene yet to fly to, so the reader's "그래프에서 보기" landed on nothing.
  const arrivalRef = useRef<string | null>(null);
  // The same wait as render state: it hides the "pick a note" banner.
  const [arriving, setArriving] = useState(false);
  // The note the user arrived from; the inspector keeps the way back to it.
  const [origin, setOrigin] = useState<string | null>(null);
  const landRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!graphFocus) return;
    const { q, path: target } = graphFocus;
    arrivalQRef.current = {
      shown: q,
      before: arrivalQRef.current?.before ?? settingsRef.current.question,
    };
    setSettings((prev) => ({ ...prev, question: q }));
    if (target) {
      arrivalRef.current = target;
      setArriving(true);
      setOrigin(target);
      // Already laid out (the graph was open in the split pane): land now. The
      // user asked for this note, so the drawer yields to its inspector.
      if (containerRef.current?.classList.contains("graph-ready")) {
        setDrawerOpen(false);
        landRef.current?.();
      }
    }
    setGraphFocus(null);
  }, [graphFocus, setGraphFocus]);

  // The three exits a gap row and the inspector both offer.
  const act = (action: GapAction, id: string): void => {
    const name = gapStem(id);
    if (action === "open") {
      if (id.startsWith("ghost:")) notice.warn(t.gr_insp_unresolved);
      else setRoute(`page:${id}`);
      return;
    }
    if (action === "link") {
      setQueryPrefill(t.gr_link_question.split("{a}").join(name));
      setRoute("query");
      return;
    }
    // A wiki gap is not a session, so it cannot join the sessions→wiki harvest
    // queue. It is a WANTED topic: the same recall-miss log the Ask abstention
    // card writes, so the next ingest knows what was missing.
    const vault = currentVault?.path;
    if (!vault) return;
    void ipc
      .recordRecallMiss(vault, name)
      .then(() => notice.ok(t.gr_want_done.split("{n}").join(name)))
      .catch((e: unknown) => notice.warn(String(e)));
  };

  // Select a note, make it the focus and fly to it: the same selection + focus
  // frame a canvas click makes, so the breadcrumb names the note the inspector
  // shows and Esc steps back out of it.
  const showNode = (id: string, withNeighbours = false): void => {
    selectedRef.current = id;
    setSelected(id);
    focusOn(id);
    sceneRef.current?.focusNode(
      id,
      withNeighbours ? { neighbours: true, coverRightPx: INSPECTOR_COVER_PX } : {},
    );
    myceliumFocusRef.current?.(id);
  };
  // A pick from the gaps list, the find box or an inspector link means "show
  // me this note", so the drawer yields. A deep link landing is not a pick and
  // leaves the drawer alone (landRef).
  const selectNode = (id: string): void => {
    setDrawerOpen(false);
    showNode(id);
  };

  // Called once the layout has positions (the build's ready points); a
  // no-op unless a deep link is waiting. Reassigned every render so the
  // build effect's closure reads the current strings.
  landRef.current = (): void => {
    const id = arrivalRef.current;
    const g = graphRef.current;
    if (!id || !g) return;
    arrivalRef.current = null;
    setArriving(false);
    // Arriving from a note means "show me where it sits": its neighbours too.
    if (g.hasNode(id)) showNode(id, true);
    else notice.warn(t.gr_not_in_graph);
  };

  const surveyCounts: SurveyCounts = {
    total: 0,
    sample: 0,
    own: 0,
    unresolved: 0,
    orphans: 0,
    noBacklink: 0,
    clusters: 0,
    maplessClusters: 0,
    fresh30d: 0,
    cited: 0,
    ...derived?.counts,
    gaps: (gapReport ? gapCount(gapReport) : 0) + (derived?.noBacklink.length ?? 0),
    neighbors: hops ? hops.size - 1 : null,
    sessions: sessionCount,
  };

  // Research bridges (cluster-level gaps) need the semantic-similarity pairs —
  // fetched lazily the first time the gap panel opens, independent of the
  // semantic-edges display toggle.
  const [bridgeSem, setBridgeSem] = useState<SemEdge[] | null>(null);
  const clustersQ = settings.question === "clusters";
  useEffect(() => {
    if (!clustersQ || bridgeSem !== null) return;
    let killed = false;
    ipc
      .semanticEdges(4)
      .then((edges) => {
        if (!killed) setBridgeSem(edges);
      })
      .catch(() => {
        if (!killed) setBridgeSem([]);
      });
    return () => {
      killed = true;
    };
  }, [clustersQ, bridgeSem]);

  const bridges = useMemo(() => {
    const g = graphRef.current;
    if (!clustersQ || !g || g.order === 0 || !bridgeSem?.length) return [];
    return clusterBridges(g, bridgeSem);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clustersQ, bridgeSem, counts, glEpoch]);

  // Dashed 3D hint lines between the bridged cluster centroids while the
  // panel is open.
  useEffect(() => {
    sceneRef.current?.setBridgeHints(
      clustersQ ? bridges.map((b) => [b.a, b.b] as [number, number]) : [],
    );
  }, [bridges, clustersQ]);

  // "Ask about this gap" → draft a research question and hop to the Ask page.
  function askBridge(b: ClusterBridge): void {
    const tpl =
      t.gr_bridge_question ??
      'My notes about "{a}" and "{b}" are semantically related but not yet linked. What connects these two topics? Suggest the bridging ideas or notes I should write.';
    setQueryPrefill(tpl.replace("{a}", stem(b.aHub)).replace("{b}", stem(b.bHub)));
    setRoute("query");
  }

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
      label: string;
    }[] = [];
    g.forEachNode((id, a) => {
      rows.push({
        id,
        community: a.community,
        galaxy: a.galaxy,
        color: a.color,
        deg: a.deg,
        label: a.label,
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
    // The inspector and the settings drawer share the stage's right edge; a
    // node pick means "show me this note", so the drawer yields.
    setDrawerOpen(false);
    // Selection impulse: supernova + neural activation ripple from the star.
    sceneRef.current?.impulse(id);
    focusOn(id, dbl);
  }).current;
  // The mycelium look's canvas pick takes the same path as a GraphScene one: a
  // septum is a node click, empty substrate is the void click that steps out.
  // Stable, because MyceliumView rebuilds its scene when onSelect changes.
  const onMyceliumPick = useRef((id: string | null) => {
    if (id) handleNodeClick(id, false);
    else popFrame();
  }).current;
  // Push (or, on a double click, widen) the note's focus frame — unless a
  // path is being traced or the ship is flying (pickFocuses).
  function focusOn(id: string, widen = false): void {
    const g = graphRef.current;
    if (!g || !g.hasNode(id)) return;
    if (!pickFocuses({ trace: traceModeRef.current, fly: flyModeRef.current })) return;
    const next = pushNodeFrame(stackRef.current, id, (hops) => hopSet(g, id, hops), widen);
    if (next !== stackRef.current) applyStack(next);
  }

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

  // Esc closes the top thing (escTarget): the drawer, the help, a frameless
  // inspector, then one focus level. Ignored while typing in an input (the
  // drawer spends an Esc pressed inside it on closing itself, drawerKey), and
  // in fly mode, whose own handler below spends Esc on landing (and marks it
  // defaultPrevented — this listener re-registers with its deps, so it may
  // run second).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.defaultPrevented || flyModeRef.current) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const target = escTarget({ drawer: drawerOpen, help: helpOpen, selected, stack: stackRef.current });
      if (target === "drawer") setDrawerOpen(false);
      else if (target === "help") setHelpOpen(false);
      else if (target === "inspector") setSelected(null);
      else if (target === "frame") popFrame();
      else return;
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [popFrame, drawerOpen, helpOpen, selected]);

  // Fold or unfold a rail (its head chevron, its edge tab, `[` / `]`). The
  // control holding focus — the chevron, the tab, a row inside the rail —
  // unmounts with the fold, so focus goes to the control that replaces it
  // rather than dropping to <body>; a key pressed elsewhere leaves focus be.
  const railFocusRef = useRef<GraphRail | null>(null);
  // What the user collapsed inside each rail. A folded rail unmounts, so this
  // lives here and comes back with it.
  const [gapsClosed, setGapsClosed] = useState<Record<string, boolean>>({});
  const [legendOverride, setLegendOverride] = useState<Map<number, boolean>>(() => new Map());
  // In a split pane too narrow for both rails (UX S42) they start folded, and
  // a fold there is the pane's own: the saved state is the full page's. null
  // = not in such a pane.
  const [paneRails, setPaneRails] = useState<Record<GraphRail, boolean> | null>(null);
  useEffect(() => {
    const pane = containerRef.current?.closest(".workspace-pane");
    if (!pane || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const narrow = railsFoldInPane(entries[0]?.contentRect.width ?? null);
      setPaneRails((prev) => (narrow ? (prev ?? { gaps: false, legend: false }) : null));
    });
    ro.observe(pane);
    return () => ro.disconnect();
  }, []);
  // A phone (UX S53): the stage takes the screen between the bars, the find,
  // question and size controls fold behind one button above it, and the two
  // rails become the two tabs of one sheet.
  const phone = useMediaQuery(PHONE_QUERY);
  const touch = useMediaQuery("(any-pointer: coarse)");
  const [toolsOpen, setToolsOpen] = useState(false);
  const [railSheet, setRailSheet] = useState<GraphRail | null>(null);
  // Drag, pinch and tap a star: said once, on a touch screen's first visit.
  const [gestureHint, setGestureHint] = useState(false);
  useEffect(() => {
    if (!touch || !gestureHintDue(globalThis.localStorage ?? null)) return;
    markGestureHintSeen(globalThis.localStorage ?? null);
    setGestureHint(true);
  }, [touch]);
  const gapsRailOpen = paneRails ? paneRails.gaps : settings.gapsRailOpen;
  const legendRailOpen = paneRails ? paneRails.legend : settings.legendRailOpen;
  const inNarrowPane = paneRails !== null;
  const toggleRail = useCallback(
    (rail: GraphRail): void => {
      const side = rail === "gaps" ? ".u-page__rail:not(.u-page__rail--right)" : ".u-page__rail--right";
      if (document.activeElement?.closest(`[data-rail-toggle="${rail}"], ${side}`)) {
        railFocusRef.current = rail;
      }
      if (inNarrowPane) {
        setPaneRails((prev) => (prev ? { ...prev, [rail]: !prev[rail] } : prev));
        return;
      }
      setSettings((prev) =>
        rail === "gaps"
          ? { ...prev, gapsRailOpen: !prev.gapsRailOpen }
          : { ...prev, legendRailOpen: !prev.legendRailOpen },
      );
    },
    [inNarrowPane],
  );
  useEffect(() => {
    const rail = railFocusRef.current;
    if (!rail) return;
    railFocusRef.current = null;
    document.querySelector<HTMLElement>(`[data-rail-toggle="${rail}"]`)?.focus();
  }, [gapsRailOpen, legendRailOpen]);
  // `[` / `]` — not while flying or over the multiverse field, which hide both
  // rails, so a press there would change what the user cannot see.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const rail = railKey(e);
      if (!rail || e.defaultPrevented || flyModeRef.current) return;
      if (settingsRef.current.multiverse && !enteredUniverseRef.current) return;
      e.preventDefault();
      toggleRail(rail);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleRail]);

  // Fetch mtimes whenever the vault changes — drives the timelapse reveal order
  // (oldest file first, so the graph grows in creation order) AND the recency
  // glow (per-node age). Stored as state so the build picks the ages up.
  const [mtimes, setMtimes] = useState<Map<string, number> | null>(null);
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
        // Normalise to ms (the backend reports epoch seconds).
        setMtimes(new Map(rows.map(([p, m]) => [p, m < 1e12 ? m * 1000 : m])));
      })
      .catch(() => {
        /* mtime unavailable — timelapse just won't order by age */
      });
    return () => {
      cancelled = true;
    };
  }, [currentVault?.path]);
  // The mtimes the last scene was built with, so a build knows whether it is
  // the one their arrival caused (relandAfterRebuild).
  const builtMtimesRef = useRef(mtimes);

  // The search box is a filter, so every keystroke used to tear the scene down
  // and rebuild it before the typed character could paint: buildGraph alone is
  // 3.1 ms on the real vault, 29.7 ms at 2k nodes and 181 ms at 10k nodes /
  // 30k edges — plus a new GraphScene and a sim restart on top. Deferring the
  // value keeps the input controlled and instant (the urgent render commits
  // first) and folds keystrokes that land while a rebuild is running into one.
  const deferredSearch = useDeferredValue(settings.search);

  // Build + render + settle. Re-runs when the underlying graph or any FILTER
  // changes. Each run tears the old scene/sim down and creates a fresh one.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !adjacency) return;
    const s = settingsRef.current;
    // Multiverse mode renders its own scene (MultiverseScene overlay); the
    // single-vault scene must not also build WHILE the field is shown. Once the
    // user enters a universe (enteredUniverse) the single-vault scene builds even
    // though the preference is still on. Re-runs when either flips (both are
    // deps), disposing this scene on the way into the field.
    if (s.multiverse && !enteredUniverseRef.current) return;
    const t0 = performance.now();
    const theme = makeTheme(s.skin);

    const allowed = computeAllowed(adjacency, allFiles, {
      tagFilter: s.tagFilter,
      folderFilter: s.folderFilter,
      vaultRoot: currentVault?.path ?? "",
      search: deferredSearch,
      existingOnly: s.existingOnly,
      showOrphans: s.showOrphans,
    });
    // "샘플 숨기기": on the owner's vault the 51 seeded first-run notes are 80%
    // of what is drawn, so the honest picture needs a switch that removes them.
    if (s.hideSample) {
      const root = currentVault?.path ?? "";
      for (const id of [...allowed]) if (isSamplePath(root, id)) allowed.delete(id);
    }
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
      vivid: s.skin === "sigma", // the Gephi board wears the vivid categorical wheel

      // Recency glow: age each note against its file mtime (absent → no glow).
      mtimes: mtimes ?? undefined,
      now: Date.now(),
    });
    graphRef.current = graph;
    setCounts({ nodes: graph.order, edges: graph.size });
    setBuild((b) => ({ builds: b.builds + 1, ms: performance.now() - t0 }));
    const mtimesArrived = mtimes !== builtMtimesRef.current;
    builtMtimesRef.current = mtimes;
    if (graph.order === 0) return;

    // The note a deep link landed on survives the rebuild the file mtimes
    // cause just after mount: it lands again once this scene is laid out
    // instead of being reset away below. No other rebuild brings it back.
    const reland = relandAfterRebuild({
      selected: selectedRef.current,
      origin,
      pending: arrivalRef.current,
      mtimesArrived,
    });
    if (reland) {
      arrivalRef.current = reland;
      setArriving(true);
    }
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
    // Elastic drag for the deterministic (static) layouts, which run no sim.
    const staticDrag = createStaticDrag(graph, () => sceneRef.current?.syncPositions());

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
        syncSwirl(); // adopt swirled positions before the pin + warm-up
        highlight(id);
        if (simRef.current) {
          // Force layouts: pin the node in the worker (it owns the mutable sim
          // node now) and hold the sim warm for the WHOLE drag — a one-shot
          // reheat cools toward 0 and re-settles within ~1s, freezing the
          // neighbourhood mid-drag (worse the bigger the vault). dragWarm keeps
          // it ticking so the neighbours keep trailing until the drag ends.
          draggedSim = simRef.current.nodes.find((n) => n.id === id);
          if (draggedSim) {
            simRef.current.setFixed(id, draggedSim.x, draggedSim.y, draggedSim.z);
          }
          simRef.current.dragWarm(true);
        } else {
          // Static (deterministic) layouts have no sim — run a local elastic
          // relaxation so the neighbourhood follows the pulled node.
          staticDrag.begin(id);
        }
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
        clearHighlight();
        if (simRef.current) {
          if (draggedSim) simRef.current.releaseFixed(draggedSim.id);
          draggedSim = undefined;
          // Release the warm hold: the sim cools from its drag alpha and eases
          // the freed star + neighbours back to rest, then posts the settle notice.
          simRef.current.dragWarm(false);
        } else {
          // Static layout: ease the pulled neighbourhood back to the baked layout.
          staticDrag.release();
        }
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
    // The layout has its positions and the camera is framed: reveal, and land
    // a waiting deep link (which needs somewhere to fly to).
    const ready = (): void => {
      container.classList.add("graph-ready");
      landRef.current?.();
    };
    // A rebuilt scene needs the current encoding even when React's encoding
    // dependencies did not change. Apply it before framing the solid notes.
    scene.setEncoding(encodingRef.current);
    // Condensation intro: stars are born condensing into place — once per
    // Graph visit, not on every filter-rebuild of the scene.
    if (!introPlayedRef.current) {
      introPlayedRef.current = true;
      scene.playCondensation();
    }
    // Seeded deep sky: every vault gets its own faint nebula backdrop, baked
    // once off the critical path. Deep-space skins only — web/sigma/black own
    // their voids, and paper stays paper.
    if (s.skin === "galaxy" || (s.skin === "auto" && !lightBg)) {
      const bakeSky = (): void => {
        if (killed) return;
        const tex = bakeSeededSky(currentVault?.path ?? "memex", true);
        if (tex && !killed && sceneRef.current === scene) {
          scene.setSkyTexture(tex);
        }
      };
      // The bake is a single ~400ms main-thread block (measured on a 1244-node
      // first load). At the old 80ms delay it landed squarely inside the
      // condensation intro and froze it; an idle slot pushes it past the frames
      // the user is actually watching. The timeout still guarantees a sky on a
      // busy main thread, and older webviews without rIC just wait it out.
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(bakeSky, { timeout: 2500 });
      } else {
        window.setTimeout(bakeSky, 2500);
      }
    }
    scene.setScaleListener((sc) => {
      const label = { cluster: "Galaxy cluster", galaxy: "Galaxy", system: "Star system", star: "Star" }[sc];
      setCosmicScale(label);
      if (scaleHideRef.current != null) window.clearTimeout(scaleHideRef.current);
      scaleHideRef.current = window.setTimeout(() => setCosmicScale(null), 2200);
    });
    // Compile the shader programs before the first frame rather than letting
    // three.js do it lazily mid-animation — profiling put the first-load
    // stutter squarely on program compilation.
    scene.warmUpShaders();
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
    // Semantic map: 2D PCA coordinates come from Rust (page embeddings never
    // cross the bridge). Notes cluster by MEANING; wikilink edges stay drawn
    // over it as the explicit structure. No index → spiral fallback + a hint.
    if (s.layout === "semantic") {
      const radius = s.linkDistance * ATLAS_RADIUS_MUL;
      const finish = (): void => {
        if (killed) return;
        sceneRef.current?.syncPositions();
        sceneRef.current?.layoutSettled();
        sceneRef.current?.fit();
        introPlayed = true;
        ready();
      };
      void ipc
        .semanticMap()
        .then((pts) => {
          if (killed) return;
          if (pts.length === 0) {
            applySpiralLayout(graph, { targetRadius: radius * 1.3 });
            setSemanticMissing(true);
          } else {
            setSemanticMissing(false);
            const at = new Map(pts.map((p) => [p.page, p]));
            graph.forEachNode((id) => {
              const p = at.get(id);
              if (p) {
                // 3D meaning-nebula: PC1/PC2 span the map, PC3 gives depth —
                // flattened to 55% so the top-down reading stays a map.
                graph.setNodeAttribute(id, "x", p.x * radius);
                graph.setNodeAttribute(id, "y", p.y * radius);
                graph.setNodeAttribute(id, "z", p.z * radius * 0.55);
              } else {
                // No embedding (ghost / not yet indexed): park on the outer
                // ring so it reads "outside the mapped meaning", not random.
                const ang = seededUnit(id, 31) * Math.PI * 2;
                graph.setNodeAttribute(id, "x", Math.cos(ang) * radius * 1.14);
                graph.setNodeAttribute(id, "y", Math.sin(ang) * radius * 1.14);
                graph.setNodeAttribute(id, "z", (seededUnit(id, 37) - 0.5) * radius * 0.2);
              }
            });
            // PCA puts near-synonymous notes on top of each other (that IS the
            // signal) and parks every unembedded ghost on ONE ring radius, so
            // the raw map violates the no-overlap invariant badly. Same shared
            // post-process every other layout uses: local push-apart, so a tied
            // pair separates just enough to read as two notes while the PC1/PC2
            // map keeps its shape.
            separateGraphLayout(graph);
          }
          finish();
        })
        .catch(() => {
          if (killed) return;
          applySpiralLayout(graph, { targetRadius: radius * 1.3 });
          setSemanticMissing(true);
          finish();
        });
      return () => {
        killed = true;
        if (tlRafRef.current != null) {
          cancelAnimationFrame(tlRafRef.current);
          tlRafRef.current = null;
        }
        stopTlRecorder();
        setTlPlaying(false);
        staticDrag.dispose();
        scene.dispose();
        sceneRef.current = null;
        graphRef.current = null;
        container.classList.remove("graph-ready");
      };
    }

    if (s.layout === "ribbon") {
      setWovenError(false);
      let worker: Worker | null = null;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const fail = (message: string) => {
        if (killed) return;
        console.error("Woven layout failed:", message);
        clearTimeout(timeout);
        worker?.terminate();
        setWovenError(true);
      };
      try {
        worker = new Worker(new URL("../lib/wovenLayout.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (event: MessageEvent<{ layout?: WovenLayout; error?: string }>) => {
          if (killed) return;
          clearTimeout(timeout);
          worker?.terminate();
          if (!event.data.layout) { fail(event.data.error ?? "Missing layout"); return; }
          const layout = event.data.layout;
          for (const [id, position] of layout.positions) graph.mergeNodeAttributes(id, position);
          scene.setWovenLayout(layout);
          scene.syncPositions();
          scene.layoutSettled();
          scene.fit();
          introPlayed = true;
          ready();
        };
        worker.onerror = (event) => fail(event.message);
        timeout = setTimeout(() => fail("Layout worker timed out"), 30000);
        worker.postMessage(wovenInput(graph, s.linkDistance * ATLAS_RADIUS_MUL));
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
      return () => {
        killed = true;
        clearTimeout(timeout);
        worker?.terminate();
        if (tlRafRef.current != null) { cancelAnimationFrame(tlRafRef.current); tlRafRef.current = null; }
        stopTlRecorder();
        setTlPlaying(false);
        staticDrag.dispose();
        scene.dispose();
        sceneRef.current = null;
        graphRef.current = null;
        container.classList.remove("graph-ready");
      };
    }

    // Pure-math static layouts (spiral galaxy / time strata): positions are a
    // deterministic O(n log n) function of the built graph — no FA2 slices, no
    // worker sim. Compute, bake, reveal in one fit. "mycelium" is a no-op here
    // on purpose: its picture comes from MyceliumView, a wholly separate
    // renderer mounted OVER this (invisible while active) canvas — see
    // myceliumScene.ts for why it owns its own layout and growth clock instead.
    if (
      s.layout === "spiral" ||
      s.layout === "strata" ||
      s.layout === "celestial" ||
      s.layout === "radial" ||
      s.layout === "walrus" ||
      s.layout === "mycelium" ||
      isSculptedLayout(s.layout)
    ) {
      const radius = s.linkDistance * ATLAS_RADIUS_MUL;
      if (isSculptedLayout(s.layout)) {
        scene.setSculptedLayout(applySculptedLayout(graph, s.layout, { targetRadius: radius }));
      } else if (s.layout === "spiral") {
        applySpiralLayout(graph, { targetRadius: radius * 1.3 });
      } else if (s.layout === "celestial") {
        applyCelestialLayout(graph, { targetRadius: radius * 1.1 });
      } else if (s.layout === "radial") {
        applyRadialLayout(graph, { targetRadius: radius * 1.2 });
      } else if (s.layout === "walrus") {
        applyWalrusLayout(graph, { targetRadius: radius * 1.25 });
      } else if (s.layout === "mycelium") {
        // No-op — see the comment above.
      } else {
        // Chronicle: bake the time-strata positions AND draw the date axis
        // under them (the axis shares the layout's time→x mapping).
        const axis = applyStrataLayout(graph, { mtimes, targetRadius: radius * 1.2 });
        scene.setTimeAxis(axis);
      }
      scene.syncPositions();
      // Walrus: draw the CAIDA boundary sphere around the baked ball (after
      // syncPositions so it reads the final node positions).
      scene.setWalrusBoundary(s.layout === "walrus");
      scene.layoutSettled();
      scene.fit();
      introPlayed = true;
      ready();
      return () => {
        killed = true;
        if (tlRafRef.current != null) {
          cancelAnimationFrame(tlRafRef.current);
          tlRafRef.current = null;
        }
        stopTlRecorder();
        setTlPlaying(false);
        staticDrag.dispose();
        scene.dispose();
        sceneRef.current = null;
        graphRef.current = null;
        container.classList.remove("graph-ready");
      };
    }

    if (s.layout === "atlas" || s.layout === "synapse") {
      // FA2 runs in event-loop slices (see atlasLayout.ts freeze postmortem):
      // the map visibly unfolds as it converges, the UI stays interactive the
      // whole time, and unmount/layout-switch aborts mid-run. NEVER run it
      // synchronously — a 10k vault wedged the WebKit renderer for minutes
      // and the persisted layout choice re-froze every app launch.
      // Hold the loader through the WHOLE FA2 formation, then reveal the
      // finished map in ONE instant fit. The old code streamed the raw FA2
      // positions and re-framed every few slices — but synapse's raw FA2
      // spread is far bigger than the final separated+normalised layout, so
      // the graph appeared to explode outward and the camera drifted far
      // ("갑자기 엄청 멀어지면서"); a mid-formation interaction could even
      // strand the camera at the huge frame. A flat 2D map has nothing to
      // gain from a forming preview, so we just show the finished result.
      void applyAtlasLayout(graph, {
        variant: s.layout === "synapse" ? "synapse" : "atlas",
        // Synapse spreads wider, so give it more world room to frame into.
        targetRadius: s.linkDistance * ATLAS_RADIUS_MUL * (s.layout === "synapse" ? 1.6 : 1),
        shouldAbort: () => killed,
      }).then((completed) => {
        if (killed || !completed) return;
        sceneRef.current?.syncPositions();
        sceneRef.current?.layoutSettled(); // bundled strands over the static map
        // Instant fit (no tween): a flat map doesn't need the cinematic
        // fly-in, and an instant snap can't be stranded by an interaction.
        sceneRef.current?.fit();
        introPlayed = true;
        ready();
      });
      return () => {
        killed = true;
        if (tlRafRef.current != null) {
          cancelAnimationFrame(tlRafRef.current);
          tlRafRef.current = null;
        }
        // The RAF drove the finish path that stops the recorder, so cancelling
        // it alone would strand the recording on the canvas about to be
        // disposed — silently, with no file.
        stopTlRecorder();
        setTlPlaying(false);
        staticDrag.dispose();
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
      ready();
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
      stopTlRecorder();
      setTlPlaying(false);
      container.removeEventListener("wheel", takeOver);
      container.removeEventListener("pointerdown", takeOver);
      sim.stop();
      staticDrag.dispose();
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
    deferredSearch,
    settings.existingOnly,
    settings.hideSample,
    settings.showOrphans,
    settings.nodeSize,
    settings.folderGalaxies,
    settings.layout,
    staticLayoutScale,
    settings.multiverse,
    enteredUniverse,
    mtimes,
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
    settings.cosmicEvents,
    settings.cosmicFrequency,
    settings.clickBurst,
    settings.neuralFiring,
    settings.nearFieldPlanets,
    settings.pixelNodes,
    settings.skyStyle,
    settings.recencyGlow,
    settings.minimap,
    settings.cinematic,
    settings.edgeFlow,
    // linkDistance drives the sim, but applySettings' closing
    // writeEdgeGeometry also derives the edge length-fade thresholds from it —
    // without this key a slider move (or a loose/dense preset) left the whole
    // web dimming against stale thresholds until an unrelated toggle fired.
    settings.linkDistance,
  ]);

  // Selection streak: mirror the inspector's subject into the scene so the
  // selected star carries its anamorphic mark (cleared on deselect).
  useEffect(() => {
    sceneRef.current?.setSelectedNode(selected);
  }, [selected]);

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
      if (g)
        recolorGraph(
          g,
          isLightBackground(makeTheme(settingsRef.current.skin)),
          settingsRef.current.skin === "sigma",
        );
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

  // Unsupported looks exit flight; a restored supported scene resumes it.
  useEffect(() => {
    if (!flyModeRef.current) return;
    if (settings.skin === "mycelium" || SURFACE_LAYOUTS.has(settings.layout)) toggleFly(false);
    else sceneRef.current?.setFlyMode(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glEpoch, settings.layout, settings.skin]);

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
      // Nothing to clear on the first run — the ref starts empty. Bumping
      // glEpoch here would tear the scene and the sim worker down and rebuild
      // them for no reason, on every mount, with the default settings.
      if (semEdgesRef.current.length === 0) return;
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
          label: displayName(stem(id)),
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
      // Birth motion: the just-added notes grow in from nothing at their spots
      // (the ingest gold-glow tint rides on top via pushStyle) — the galaxy
      // visibly sprouts what the run is writing.
      if (newIdSet.size > 0) scene.playBirth(newIdSet);
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
  // The capture stream is retained so its track can be released. Without it the
  // track stays live for the session even after a clean recording, holding the
  // canvas capture open.
  const tlStreamRef = useRef<MediaStream | null>(null);
  const stopTlRecorder = (): void => {
    const rec = tlRecorderRef.current;
    const stream = tlStreamRef.current;
    tlRecorderRef.current = null;
    tlStreamRef.current = null;
    // stop() flushes a last dataavailable and fires onstop, so an interrupted
    // recording still downloads what it captured instead of vanishing.
    if (rec && rec.state !== "inactive") rec.stop();
    for (const track of stream?.getTracks() ?? []) track.stop();
  };
  const startTlRecorder = (): void => {
    const canvas = sceneRef.current?.canvas;
    if (!canvas || typeof MediaRecorder === "undefined") return;
    try {
      const stream = canvas.captureStream(30);
      tlStreamRef.current = stream;
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
        a.download = "myco-timelapse.webm";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      };
      rec.start(500);
      tlRecorderRef.current = rec;
    } catch {
      tlRecorderRef.current = null; // recording is best-effort sugar
    }
  };

  // A baked layout (Woven, walrus, spiral...) has no sim: its notes are
  // revealed where they sit, at the same pace and speed. Mycelium grows on
  // its own clock (toggleTimelapse).
  const startTimelapse = (record = false): void => {
    const scene = sceneRef.current;
    const sim = simRef.current;
    const graph = graphRef.current;
    if (!scene || !graph || graph.order === 0 || settingsRef.current.skin === "mycelium") return;
    scene.setCinematicOrbit(true); // recordings read as a produced shot
    if (record) startTlRecorder();

    const present = new Set(graph.nodes());
    const order = tlOrderRef.current.filter((p) => present.has(p));
    const seen = new Set(order);
    graph.forEachNode((n) => {
      if (!seen.has(n)) order.push(n);
    });

    graph.forEachNode((n) => graph.setNodeAttribute(n, "hidden", true));
    sim?.timelapseReset();
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
      if (!sc || !g) {
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
        sm?.timelapseReveal(batch); // spawns at centre + keeps the sim hot
        sc.refreshStyle(); // newly-revealed nodes/edges need their alpha/colour
        next = want;
      }
      if (next < order.length) {
        tlRafRef.current = requestAnimationFrame(step);
      } else {
        sm?.timelapseSettle();
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
    if (scene && graph) {
      graph.forEachNode((n) => graph.setNodeAttribute(n, "hidden", false));
      sim?.timelapseReveal(graph.nodes());
      sim?.timelapseSettle();
      scene.refreshStyle(); // un-hid everything → full write to restore alpha/colour
      scene.setCinematicOrbit(false);
    }
    stopTlRecorder();
    setTlPlaying(false);
  };

  // Play/pause the timelapse — shared by the toolbar's ▶ button and the
  // settings drawer's footer button so neither can drift out of sync with
  // the other. Mycelium is a separate renderer with its own growth clock,
  // not the worker-sim timelapse this drives for every other layout —
  // replay is a one-shot reveal, nothing to pause.
  const toggleTimelapse = (): void => {
    if (settings.skin === "mycelium") {
      myceliumGrowthRef.current?.();
      return;
    }
    if (tlPlaying) pauseTimelapse();
    else startTimelapse();
  };

  useEffect(() => {
    return () => {
      if (tlRafRef.current != null) cancelAnimationFrame(tlRafRef.current);
      stopTlRecorder();
    };
  }, []);

  // Live search highlight: every node matching the find box pulses IN PHASE
  // while the rest recede — pre-attentive pop-out of the matched set as you
  // type, before committing to the Enter fly-to.
  const updateSearchHits = (q: string): void => {
    const g = graphRef.current;
    const scene = sceneRef.current;
    if (!scene) return;
    const needle = q.trim().toLowerCase();
    if (!g || !needle) {
      scene.setSearchHits(null);
      return;
    }
    const hits = new Set<string>();
    g.forEachNode((id, a) => {
      if (findRank(needle, [stem(id), String(a.label ?? "")]).score) hits.add(id);
    });
    scene.setSearchHits(hits);
  };

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
    // By the name the node is drawn with too, as ⌘K matches label or stem.
    g.forEachNode((id, a) => {
      const { score, len } = findRank(needle, [stem(id), String(a.label ?? "")]);
      if (score === 0) return;
      if (score > bestScore || (score === bestScore && len < bestLen)) {
        best = id;
        bestScore = score;
        bestLen = len;
      }
    });
    if (best) selectNode(best);
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
  // Folded rails show as edge tabs — never over the multiverse field, which
  // hides the rails, nor for a legend with nothing to list.
  const gapsTab = !showMultiverse && !gapsRailOpen;
  const legendTab = !showMultiverse && !legendRailOpen && legendGalaxies.length > 0;
  // Only the legend mounted: at 821–1240px it keeps the left column it shares
  // with the gaps rail there (styles.css) instead of moving to the right.
  const legendOnly =
    !showMultiverse && !gapsRailOpen && legendRailOpen && legendGalaxies.length > 0;
  // The vault has notes but the filters kept none: a built scene with zero
  // nodes, as opposed to the first render before any build (builds === 0).
  const filteredEmpty = build.builds > 0 && counts.nodes === 0 && totalNodes > 0;

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

  // The rails, as columns beside the stage or as a phone sheet's tabs
  // (where nothing folds).
  const renderGaps = (onFold?: () => void): JSX.Element => (
    <GraphGaps
      t={t}
      groups={gapReport ? gapGroups(gapReport, derived?.noBacklink ?? [], t) : []}
      total={surveyCounts.gaps}
      bridges={bridges}
      onAskBridge={askBridge}
      selected={selected}
      onSelect={selectNode}
      onAction={act}
      meta={adjacency?.meta}
      onTidy={() => useTidyStore.getState().setOpen(true)}
      onFold={onFold}
      closed={gapsClosed}
      setClosed={setGapsClosed}
    />
  );
  const renderLegend = (onFold?: () => void): JSX.Element => (
    <GraphLegend
      t={t}
      galaxies={legendGalaxies}
      isolated={isolated}
      onIsolate={isolateCommunity}
      encoding={{
        question: settings.question,
        layout: settings.layout,
        hasSubject: hops !== null,
        arriving,
      }}
      onFold={onFold}
      override={legendOverride}
      setOverride={setLegendOverride}
      details={honestyDetails(t, surveyCounts, counts.edges)}
    />
  );

  return (
    <AppPage
      wide
      className={`graph-page${flyMode ? " graph-fullscreen" : ""}${legendOnly ? " graph-page--legend-only" : ""}${phone && toolsOpen ? " is-tools-open" : ""}`}
      eyebrow={t.nav_workspace}
      title={t.gr_title}
      tools={
        <>
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
                  {f.kind === "node" && f.hops === 2 ? " \u207A\u00B2" : ""}
                </button>
              ))}
              <button
                type="button"
                className="graph-chip graph-chip--exit"
                onClick={() => popFrame()}
                aria-label={t.gr_focus_esc ?? "Step out (Esc)"}
                title={t.gr_focus_esc ?? "Step out (Esc)"}
              >
                {"\u00D7"}
              </button>
            </nav>
          ) : null}
          <input
            ref={findRef}
            className="graph-find"
            type="search"
            value={find}
            placeholder={t.gr_find_ph ?? "Find a note\u2026"}
            aria-label={t.gr_find_ph ?? "Find a note"}
            onChange={(e) => {
              setFind(e.target.value);
              updateSearchHits(e.target.value);
            }}
            onKeyDown={(e) => {
              if (isComposingKey(e)) return;
              if (e.key === "Enter") focusFind(find);
            }}
          />
          <ZoomButtons sceneRef={sceneRef} t={t} onFit={() => myceliumFitRef.current?.()} />
          <GraphMoreMenu
            t={t}
            buttonRef={gearRef}
            items={[
              {
                key: "timelapse",
                label: tlPlaying
                  ? (t.gr_timelapse_pause ?? "Pause timelapse")
                  : (t.gr_timelapse_play ?? "Play timelapse"),
                onSelect: toggleTimelapse,
              },
              {
                key: "record",
                label: t.gr_timelapse_record ?? "Record timelapse (WebM)",
                disabled: tlPlaying,
                onSelect: () => startTimelapse(true),
              },
              ...(settings.skin !== "mycelium" && !SURFACE_LAYOUTS.has(settings.layout)
                ? [
                    {
                      key: "fly",
                      label: t.gr_fly_btn ?? "Spaceship mode (F)",
                      pressed: flyMode,
                      onSelect: () => toggleFly(!flyModeRef.current),
                    },
                  ]
                : []),
              {
                key: "settings",
                label: t.gr_settings ?? "Graph settings",
                pressed: drawerOpen,
                onSelect: toggleDrawer,
              },
              {
                // Gesture cheat-sheet: click/double-click/Cmd-click/Esc/F/drag
                // were undocumented; this is their one visible door.
                key: "help",
                label: t.gr_help_btn ?? "Gestures & keys",
                pressed: helpOpen,
                onSelect: () => setHelpOpen((v) => !v),
              },
            ]}
          />
        </>
      }
      bar={
        <GraphQuestions
          t={t}
          settings={settings}
          counts={surveyCounts}
          build={build}
          onChange={(patch) => setSettings((prev) => ({ ...prev, ...patch }))}
        />
      }
      note={honestyNote(t, surveyCounts)}
      leftRail={
        // The gaps rail: the one part of this screen that produces an answer,
        // so it is a standing column, not a drawer you have to know to open.
        // Hidden while the multiverse field owns the stage; a sheet's tab on
        // a phone.
        showMultiverse || !gapsRailOpen || phone ? undefined : (
          renderGaps(() => toggleRail("gaps"))
        )
      }
      rightRail={
        // GraphLegend renders null with no galaxies; an empty rail would still
        // cost the frame a column, so the guard lives here.
        showMultiverse || !legendRailOpen || legendGalaxies.length === 0 || phone ? undefined : (
          renderLegend(() => toggleRail("legend"))
        )
      }
    >
      <div className="graph-body">
          <div
            data-graph-theme={lightBg ? "light" : "dark"}
            className={
              "graph-canvas-wrap" +
              (settings.skin === "mycelium" ? " is-mycelium" : "") +
              (legendTab ? " has-legend-tab" : "")
            }
          >
            {/* The container ALWAYS mounts: the build effect bails on a missing
                one, and it is what builds the graph, clears the loading state
                and marks .graph-ready. Removing it for the mycelium skin left
                the page stuck on "arranging constellations…" with no data.

                The mycelium view is a SEPARATE renderer — GraphScene is built
                for deep space and switching its layers off one at a time never
                stopped the sky showing through — so it mounts its own canvas
                OVER this one rather than replacing it. */}
            {/* A Tab stop with a summary, so the keyboard and a screen
                reader reach the canvas (UX S44). */}
            <div
              ref={containerRef}
              className="graph-canvas"
              tabIndex={0}
              role="group"
              aria-label={canvasLabel(t, counts.nodes, selected)}
            />
            {/* A folded rail waits on its own edge of the stage, over the
                canvas, so folding it hands the stage its whole column. */}
            {gapsTab ? (
              <RailTab
                t={t}
                rail="gaps"
                count={surveyCounts.gaps}
                onOpen={() => toggleRail("gaps")}
              />
            ) : null}
            {legendTab ? (
              <RailTab
                t={t}
                rail="legend"
                count={legendCount(legendGalaxies)}
                onOpen={() => toggleRail("legend")}
              />
            ) : null}
            {phone && !showMultiverse && !flyMode ? (
              <div className="graph-phonebar">
                <button
                  type="button"
                  className="graph-phonebar__btn"
                  aria-expanded={toolsOpen}
                  onClick={() => setToolsOpen((v) => !v)}
                >
                  <span aria-hidden="true">⚙</span> {t.gr_tools}
                </button>
                <button
                  type="button"
                  className="graph-phonebar__btn"
                  aria-haspopup="dialog"
                  onClick={() => setRailSheet("gaps")}
                >
                  {t.gr_gaps_title} · {t.gr_legend}
                </button>
              </div>
            ) : null}
            {gestureHint && !showMultiverse && counts.nodes > 0 ? (
              <div className="graph-gesture-hint" role="status">
                <p>{t.gr_gesture_hint}</p>
                <Button variant="quiet" onClick={() => setGestureHint(false)}>
                  {t.gr_gesture_ok}
                </Button>
              </div>
            ) : null}
            {settings.skin === "mycelium" && counts.nodes > 0 ? (
              // `counts` is the render-visible signal that the build finished —
              // graphRef is a ref, so reading it alone never re-renders and the
              // view mounted with a null graph and stayed empty.
              <MyceliumView
                key={`${counts.nodes}-${counts.edges}-${settings.myceliumDim}-${mycInk.myceliumNodeColor}-${mycInk.myceliumHyphaColor}`}
                graph={graphRef.current}
                onSelect={onMyceliumPick}
                selected={selected}
                flat={settings.myceliumDim === "2d"}
                nodeColor={mycInk.myceliumNodeColor}
                hyphaColor={mycInk.myceliumHyphaColor}
                background={mycInk.myceliumBackground}
                gridGround={matchMyceliumBg(settings) === "grid"}
                nodeSizeScale={settings.nodeSize}
                linkThicknessScale={settings.linkThickness}
                textFadeThreshold={settings.textFadeThreshold}
                ambientMotion={settings.ambientMotion}
                growSpeed={settings.tlSpeed}
                encoding={encoding}
                maxNodes={myceliumMaxNodes(myceliumForceDeb.linkDistance, counts.nodes)}
                branchPct={myceliumBranchPct(myceliumForceDeb.clusterForce)}
                fitRef={myceliumFitRef}
                startGrowthRef={myceliumGrowthRef}
                focusRef={myceliumFocusRef}
              />
            ) : null}
            {/* Multiverse mode: an overlay scene of every project as a
                universe-bubble, covering the (idle) single-vault canvas. Fly
                into a bubble to drop into that vault (the saved toggle stays
                on; re-assert it to come back). */}
            {showMultiverse ? (
              <>
                {sceneUniverses.length > 0 ? (
                  <MultiverseScene
                    universes={sceneUniverses}
                    onEnterUniverse={(slug) => void enterUniverse(slug)}
                  />
                ) : (
                  // No universe yet: still loading the registry/graphs, or no
                  // vault open. Never a silent black screen (5-state).
                  <div className="graph-empty" role="status" aria-live="polite">
                    {mvLoading
                      ? (t.gr_mv_loading ?? "Charting universes…")
                      : (t.gr_mv_none ?? "No vault to show yet.")}
                  </div>
                )}
                <p className="muted graph-mv-hint" aria-live="polite">
                  {t.gr_multiverse_hint ??
                    "Show every project as its own universe-bubble; fly into one to open it"}
                </p>
              </>
            ) : null}
            {/* MYCO cameo: a rare, dismissible feature-tip visit — MYCO drifts
                through the cosmos AS a planet. Belongs to the 3D dark cosmos
                only (a floating planet over a flat 2D chart or light paper is
                incongruous), and never in the multiverse field. Also never
                under the mycelium skin: it anchors to sceneRef's (hidden,
                no-op) GraphScene camera, which doesn't track what's actually
                on screen once MyceliumView owns its own camera — the toggle
                is hidden under mycelium in GraphControls for the same reason. */}
            {!showMultiverse && counts.nodes > 0 && !(settings.layout === "ribbon" && wovenError) ? (
              <MascotCameo
                active={
                  settings.mascotCameo &&
                  // Its bubble would cover the inspector's buttons.
                  !selected &&
                  !lightBg &&
                  settings.skin !== "mycelium" &&
                  !SURFACE_LAYOUTS.has(settings.layout)
                }
                sceneRef={sceneRef}
                t={t}
              />
            ) : null}
            {/* Loading state: visible until .graph-ready lands on the canvas
                (adjacent-sibling CSS — no extra React state). */}
            {!showMultiverse && counts.nodes > 0 ? (
              <p className="muted graph-loading-tip" aria-hidden="true">
                {t.gr_loading ?? "aligning constellations…"}
              </p>
            ) : null}
            {!showMultiverse && settings.layout === "ribbon" && wovenError ? (
              <div className="graph-toast" role="alert">
                <span>{GRAPH_LOOK_COPY[lang].wovenError}</span>
                <Button onClick={() => { setWovenError(false); setGlEpoch((n) => n + 1); }}>
                  {t.gr_retry}
                </Button>
              </div>
            ) : null}
            {/* The neighbours question draws nothing until it has a subject. */}
            {!showMultiverse && counts.nodes > 0 && pickBannerShown({ question: settings.question, selected, arriving }) ? (
              <div className="graph-pick" role="status">
                <span>{t.gr_q_pick}</span>
                <button type="button" className="graph-pick__find" onClick={() => findRef.current?.focus()}>
                  {t.gr_find_ph}
                </button>
              </div>
            ) : null}
            {!showMultiverse && ctxLost ? (
              <div className="graph-toast" role="alert">
                <span>{t.gr_ctx_lost ?? "Graphics context was lost."}</span>
                <Button
                  onClick={() => {
                    setCtxLost(false);
                    setGlEpoch((n) => n + 1);
                  }}
                >
                  {t.gr_retry ?? "Rebuild"}
                </Button>
              </div>
            ) : null}
            {!showMultiverse && cosmicScale ? (
              <div className="graph-scale-badge" aria-live="polite">
                {t[`gr_scale_${cosmicScale === "Galaxy cluster" ? "cluster" : cosmicScale === "Galaxy" ? "galaxy" : cosmicScale === "Star system" ? "system" : "star"}` as keyof Strings] ?? cosmicScale}
              </div>
            ) : null}
            {!showMultiverse && counts.nodes > 5000 ? (
              <p className="muted graph-perf-banner">
                {t.gr_perf_mode ??
                  "Performance mode — ambient layers off for large graphs"}
              </p>
            ) : null}
            {!showMultiverse && settings.layout === "semantic" && semanticMissing ? (
              <p className="muted graph-perf-banner" role="status">
                {t.gr_semantic_missing ??
                  "Semantic map needs the embedding index — run Reindex under Settings → Model, then reopen. Showing the spiral instead."}
              </p>
            ) : null}
            {!showMultiverse && filteredEmpty ? (
              <div className="graph-empty graph-empty--filtered" role="status">
                <p className="muted">{t.gr_filter_empty}</p>
                <Button
                  onClick={() => setSettings((prev) => ({ ...prev, ...clearFilters() }))}
                >
                  {t.gr_filter_clear}
                </Button>
              </div>
            ) : null}
            {!showMultiverse && totalNodes === 0 ? (
              <p className="muted graph-empty">
                {t.gr_empty_pre ??
                  "No wikilinks found in the vault yet. Add some "}
                <code style={{ fontFamily: "var(--font-mono)" }}>
                  [[wikilinks]]
                </code>
                {t.gr_empty_post ?? " to see the graph grow."}
              </p>
            ) : null}
            {!showMultiverse && selected && adjacency ? (
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
                onSelect={selectNode}
                onOpen={(id) => setRoute(`page:${id}`)}
                origin={origin}
                onClose={() => setSelected(null)}
                isSample={(id) => isSamplePath(currentVault?.path ?? "", id)}
                onAction={act}
                onNeighbors={(id) => {
                  setSelected(id);
                  setSettings((prev) => ({ ...prev, question: "neighbors" }));
                }}
              />
            ) : null}
            {helpOpen ? (
              <GraphHelp t={t} onClose={() => setHelpOpen(false)} />
            ) : null}
          </div>
          <GraphControls
            t={t}
            open={drawerOpen}
            onToggle={toggleDrawer}
            settings={settings}
            lightBackground={lightBg}
            onChange={(patch) => {
              // While drilled into a universe the toggle still reads ON (the
              // preference). Touching JUST the toggle means "back to the field":
              // clear the transient enter instead of turning the saved
              // preference off. Guard on a SINGLE-key {multiverse} patch — a
              // batch patch (e.g. applying a saved look) that merely happens to
              // carry the key must NOT be swallowed here.
              const keys = Object.keys(patch);
              if (
                keys.length === 1 &&
                keys[0] === "multiverse" &&
                enteredUniverse
              ) {
                setEnteredUniverse(false);
                return;
              }
              if (patch.multiverse) setEnteredUniverse(false);
              // Keep skin/layout in lockstep across the mycelium renderer
              // boundary — coupleMyceliumPatch handles single-key chips, the
              // post-merge normalize repairs two-key patches (vibes, saved
              // looks) that may carry an inconsistent stored pair.
              setSettings((prev) =>
                normalizeMyceliumPair({
                  ...prev,
                  ...coupleMyceliumPatch(prev, patch),
                }),
              );
            }}
            onReset={() => {
              setEnteredUniverse(false);
              setSettings({ ...DEFAULT_GRAPH_SETTINGS, search: "" });
            }}
            tags={tags}
            folders={folders}
            tlPlaying={tlPlaying}
            onTimelapse={toggleTimelapse}
            traceMode={traceMode}
            onTraceMode={toggleTrace}
            flyMode={flyMode}
            onFlyMode={toggleFly}
          />
        {phone && railSheet ? (
          <Sheet title={t.gr_rails_sheet} closeLabel={t.ui_close} onClose={() => setRailSheet(null)}>
            <Segment
              label={t.gr_rails_sheet}
              value={railSheet}
              onChange={setRailSheet}
              options={[
                { value: "gaps", label: t.gr_gaps_title, count: surveyCounts.gaps },
                { value: "legend", label: t.gr_legend, count: legendCount(legendGalaxies) },
              ]}
            />
            <div className="graph-railsheet">
              {railSheet === "gaps" ? (
                renderGaps()
              ) : legendGalaxies.length > 0 ? (
                renderLegend()
              ) : (
                <p className="muted">{t.gr_legend_empty}</p>
              )}
            </div>
          </Sheet>
        ) : null}
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
    </AppPage>
  );
}

/** Everything the questions read, derived once per built graph. */
interface Derived {
  nodes: Map<string, EncNode>;
  /** Communities with no map (frontmatter `type: overview`) page. */
  mapless: Set<number>;
  /** Linked notes nobody links back to — a gap the report itself misses. */
  noBacklink: string[];
  maxBacklinks: number;
  counts: Omit<SurveyCounts, "gaps" | "neighbors" | "sessions">;
}

function derive(
  graph: VaultGraph,
  adjacency: Adjacency,
  vaultRoot: string,
): Derived {
  const nodes = new Map<string, EncNode>();
  const noBacklink: string[] = [];
  const members = new Map<number, string[]>();
  const hasMap = new Set<number>();
  let maxBacklinks = 1;
  let sample = 0;
  let own = 0;
  let unresolved = 0;
  let orphans = 0;
  let fresh30d = 0;
  let cited = 0;

  graph.forEachNode((id, a) => {
    const ghost = id.startsWith("ghost:");
    const backlinks = ghost
      ? 0
      : (adjacency.backward[id] ?? []).filter((src) => graph.hasNode(src)).length;
    const cites = a.sourceCount ?? adjacency.meta?.[id]?.sourceCount ?? 0;
    const deg = graph.degree(id);
    if (backlinks > maxBacklinks) maxBacklinks = backlinks;
    if (ghost) unresolved++;
    else if (isSamplePath(vaultRoot, id)) sample++;
    else own++;
    if (!ghost && deg === 0) orphans++;
    if (!ghost && deg > 0 && backlinks === 0) noBacklink.push(id);
    if (!ghost && (a.age ?? 9999) <= 30) fresh30d++;
    if (cites > 0) cited++;
    if (a.community >= 0) {
      (members.get(a.community) ?? members.set(a.community, []).get(a.community)!).push(id);
      if (a.nodeType === MAP_TYPE) hasMap.add(a.community);
    }
    nodes.set(id, {
      id,
      label: ghost ? id.slice("ghost:".length) : stem(id),
      ghost,
      deg,
      backlinks,
      cites,
      ageDays: a.age ?? 9999,
      color: a.color,
      community: a.community,
    });
  });

  const mapless = new Set<number>();
  for (const cm of members.keys()) if (!hasMap.has(cm)) mapless.add(cm);

  return {
    nodes,
    mapless,
    noBacklink,
    maxBacklinks,
    counts: {
      total: graph.order,
      sample,
      own,
      unresolved,
      orphans,
      noBacklink: noBacklink.length,
      clusters: members.size,
      maplessClusters: mapless.size,
      fresh30d,
      cited,
    },
  };
}

function ZoomButtons({
  sceneRef,
  t,
  onFit,
}: {
  sceneRef: React.MutableRefObject<GraphScene | null>;
  t: Strings;
  /** Re-frame the mycelium view too — it's a separate renderer sceneRef can't
   *  reach, and it's the one visibly showing while the mycelium skin is on. */
  onFit?: () => void;
}): JSX.Element {
  return (
    <>
      <IconButton
        onClick={() => sceneRef.current?.zoomOut()}
        aria-label={t.gr_zoom_out ?? "Zoom out"}
      >
        −
      </IconButton>
      <IconButton
        onClick={() => {
          sceneRef.current?.fit();
          onFit?.();
        }}
        aria-label={t.gr_fit ?? "Fit"}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4" strokeLinecap="round" />
        </svg>
      </IconButton>
      <IconButton
        onClick={() => sceneRef.current?.zoomIn()}
        aria-label={t.gr_zoom_in ?? "Zoom in"}
      >
        +
      </IconButton>
    </>
  );
}
