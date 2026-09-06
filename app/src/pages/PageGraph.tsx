// Survey — the vault measured, not decorated. One 2D force layout (the worker
// sim), one canvas renderer, and four questions that change only the ENCODING
// of the same coordinates, so their answers are comparable. The left column
// lists the gaps with actions; the right one inspects a note and offers the
// three exits. What used to be here — 13 layouts, three.js + bloom + 20
// ambient layers, spaceship flight, multiverse, timelapse, skins, ~30
// controls — answered no question and is gone.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import GraphControls, { type BuildStat, type SurveyCounts } from "../components/GraphControls";
import GraphGaps, { displayName, gapGroups, type GapAction } from "../components/GraphGaps";
import GraphInspector from "../components/GraphInspector";
import {
  buildGraph,
  computeAllowed,
  countAllNodes,
  flattenMarkdown,
  isNonKnowledgePath,
  stem,
  type VaultGraph,
} from "../lib/graphData";
import { GraphCanvas, type Hull } from "../lib/graphCanvas";
import {
  encodeNode,
  hopsFrom,
  type EncNode,
  type EncState,
  type Question,
} from "../lib/graphEncoding";
import { analyzeGaps, clusterBridges, gapCount } from "../lib/graphGaps";
import { isSamplePath } from "../lib/graphSample";
import {
  corpusKey,
  loadGraphSettings,
  saveGraphSettings,
  type GraphSettings,
} from "../lib/graphSettings";
import { createSim, type GraphSim } from "../lib/graphSim";
import { clusterLabels, upgradeClusterTopics, type ClusterLabel } from "../lib/clusterLabels";
import { readTheme, type GraphTheme } from "../lib/graphTheme";
import { setQueryPrefill } from "../lib/queryPrefill";
import { notice } from "../lib/notice";
import { ipc } from "../lib/ipc";
import type { SemEdge } from "../lib/ipc";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";

/** Frontmatter type of a map/overview page — a cluster with one has guidance. */
const MAP_TYPE = "overview";
const GHOST = "ghost:";

interface Derived {
  graph: VaultGraph;
  /** Encoding inputs per node id (backlinks/cites/age/colour/community). */
  nodes: Map<string, EncNode>;
  labels: ClusterLabel[];
  mapless: Set<number>;
  counts: SurveyCounts;
  noBacklink: string[];
  maxBacklinks: number;
}

export default function PageGraph({ t }: { t: Strings }): JSX.Element {
  const adjacency = useVaultStore((s) => s.adjacency);
  const fileTree = useVaultStore((s) => s.fileTree);
  const currentVault = useVaultStore((s) => s.currentVault);
  const setRoute = useUIStore((s) => s.setRoute);
  const uiTheme = useUIStore((s) => s.theme);
  const graphFocus = useUIStore((s) => s.graphFocus);
  const setGraphFocus = useUIStore((s) => s.setGraphFocus);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<GraphCanvas | null>(null);
  const simRef = useRef<GraphSim | null>(null);
  const derivedRef = useRef<Derived | null>(null);

  const [settings, setSettings] = useState<GraphSettings>(() => loadGraphSettings());
  // Search NEVER enters the build deps — it is a style pass (see restyle).
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [derived, setDerived] = useState<Derived | null>(null);
  const [build, setBuild] = useState<BuildStat>({ builds: 0, ms: 0 });
  const [tip, setTip] = useState<{ id: string; x: number; y: number } | null>(null);
  const [semEdges, setSemEdges] = useState<SemEdge[] | null>(null);
  const [theme, setTheme] = useState<GraphTheme | null>(null);

  useEffect(() => saveGraphSettings(settings), [settings]);

  const vaultRoot = currentVault?.path ?? "";
  const allFiles = useMemo(() => flattenMarkdown(fileTree), [fileTree]);
  const sessionCount = useMemo(
    () => allFiles.filter((p) => isNonKnowledgePath(vaultRoot, p)).length,
    [allFiles, vaultRoot],
  );

  // Mtimes drive the "최근 무엇이 자랐나" ramp (absent → everything reads old).
  const [mtimes, setMtimes] = useState<Map<string, number> | null>(null);
  useEffect(() => {
    if (!vaultRoot) return;
    let cancelled = false;
    ipc
      .fileMtimes(vaultRoot)
      .then((rows) => {
        if (!cancelled) {
          setMtimes(new Map(rows.map(([p, m]) => [p, m < 1e12 ? m * 1000 : m])));
        }
      })
      .catch(() => {
        /* no mtimes — the time question just reads everything as old */
      });
    return () => {
      cancelled = true;
    };
  }, [vaultRoot]);

  // ── build: the ONLY thing that rebuilds the scene is a corpus change ──────
  const corpus = corpusKey(settings);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !adjacency) return;
    const t0 = performance.now();
    const th = readTheme();
    setTheme(th);

    const allowed = computeAllowed(adjacency, allFiles, {
      tagFilter: null,
      folderFilter: null,
      vaultRoot,
      search: "",
      existingOnly: !settings.showUnresolved,
      showOrphans: true,
    });
    if (settings.hideSample) {
      for (const id of [...allowed]) if (isSamplePath(vaultRoot, id)) allowed.delete(id);
    }
    const graph = buildGraph(adjacency, allowed, {
      nodeSize: 1,
      starDim: th.starDim,
      edgeColor: th.edge,
      showGhosts: settings.showUnresolved,
      folderGalaxies: true,
      vaultRoot,
      lightBg: th.lightBg,
      mtimes: mtimes ?? undefined,
      now: Date.now(),
    });

    const next = derive(graph, adjacency, vaultRoot, sessionCount, t);
    derivedRef.current = next;
    setDerived(next);
    setBuild((b) => ({ builds: b.builds + 1, ms: performance.now() - t0 }));
    setSelected((cur) => (cur && graph.hasNode(cur) ? cur : null));
    if (graph.order === 0) return;

    const canvas = new GraphCanvas(host, graph, th, {
      onNodeClick: (id) => setSelected(id),
      onNodeActivate: (id) => {
        if (!id.startsWith(GHOST)) setRoute(`page:${id}`);
      },
      onVoidClick: () => setSelected(null),
      onHover: (id, x, y) => setTip(id ? { id, x, y } : null),
      onDragStart: (id) => {
        const sim = simRef.current;
        if (!sim) return;
        const n = sim.nodes.find((s) => s.id === id);
        if (n) sim.setFixed(id, n.x, n.y);
        sim.dragWarm(true);
      },
      onDrag: (id, x, y) => simRef.current?.setFixed(id, x, y),
      onDragEnd: (id) => {
        simRef.current?.releaseFixed(id);
        simRef.current?.dragWarm(false);
      },
      onTakeover: () => {
        tookOverRef.current = true;
      },
    }, t.gr_canvas_aria);
    canvasRef.current = canvas;
    canvas.start();

    const sim = createSim(graph, (pos) => canvasRef.current?.applyPositions(pos));
    simRef.current = sim;
    tookOverRef.current = false;
    const fitTimer = window.setInterval(() => {
      if (!tookOverRef.current) canvasRef.current?.fit();
    }, 450);
    sim.onSettle((metrics) => {
      if (!tookOverRef.current) canvasRef.current?.fit(metrics);
    });

    // Cluster names: the top-degree member now, an LLM topic later if it comes.
    upgradeClusterTopics(next.labels, graph, (community, topic) => {
      const d = derivedRef.current;
      if (!d || d.graph !== graph) return;
      const l = d.labels.find((x) => x.community === community);
      if (l) l.text = topic;
      setDerived({ ...d, labels: [...d.labels] });
    });

    return () => {
      window.clearInterval(fitTimer);
      sim.stop();
      canvas.dispose();
      simRef.current = null;
      canvasRef.current = null;
    };
    // `search`, `question` and `sizeBy` are deliberately absent: they restyle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adjacency, allFiles, vaultRoot, corpus, mtimes, sessionCount]);

  const tookOverRef = useRef(false);

  // ── deep link: arrive at a question, optionally at a note ─────────────────
  useEffect(() => {
    if (!graphFocus) return;
    setSettings((s) => ({ ...s, question: graphFocus.q }));
    if (graphFocus.path) {
      setSelected(graphFocus.path);
      canvasRef.current?.focusNode(graphFocus.path);
    }
    setGraphFocus(null);
  }, [graphFocus, setGraphFocus]);

  // ── restyle: question / size / search / selection — no rebuild ────────────
  const hops = useMemo(() => {
    const g = derived?.graph;
    if (settings.question !== "neighbors" || !selected || !g || !g.hasNode(selected)) return null;
    return hopsFrom(selected, 2, (id) => (g.hasNode(id) ? g.neighbors(id) : []));
  }, [derived, selected, settings.question]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const d = derived;
    if (!canvas || !d || !theme) return;
    const state: EncState = {
      sizeBy: settings.sizeBy,
      maxBacklinks: d.maxBacklinks,
      hops,
      mapless: d.mapless,
      search: search.trim().toLowerCase(),
      selected,
      dimColor: theme.dim,
      liveColor: theme.live,
    };
    canvas.restyle((id) => {
      const n = d.nodes.get(id);
      return n
        ? encodeNode(n, settings.question, state)
        : { color: theme.dim, radius: 3, alpha: 0.2, ring: 0 };
    });
    canvas.setSelected(selected);
    canvas.setHulls(
      settings.question === "clusters"
        ? d.labels.map(
            (l): Hull => ({
              community: l.community,
              mapless: d.mapless.has(l.community),
              title: `${l.text}  · ${d.mapless.has(l.community) ? t.gr_cluster_nomap : t.gr_cluster_map}`,
            }),
          )
        : null,
    );
  }, [derived, hops, search, selected, settings.question, settings.sizeBy, theme, t]);

  // Research bridges (clusters question): semantic pairs, fetched once.
  useEffect(() => {
    if (settings.question !== "clusters" || semEdges !== null) return;
    let killed = false;
    ipc
      .semanticEdges(4)
      .then((e) => !killed && setSemEdges(e))
      .catch(() => !killed && setSemEdges([]));
    return () => {
      killed = true;
    };
  }, [settings.question, semEdges]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const g = derived?.graph;
    if (!canvas || !g) return;
    canvas.setBridges(
      settings.question === "clusters" && semEdges?.length
        ? clusterBridges(g, semEdges).map((b) => [b.a, b.b] as [number, number])
        : [],
    );
  }, [derived, semEdges, settings.question]);

  // Theme flip: re-read the CSS variables and restyle (no rebuild, no reflow).
  useEffect(() => {
    const apply = (): void => {
      const th = readTheme();
      setTheme(th);
      canvasRef.current?.setTheme(th);
    };
    const raf = requestAnimationFrame(apply);
    const safety = window.setTimeout(apply, 300);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(safety);
    };
  }, [uiTheme]);

  // ── the three exits ───────────────────────────────────────────────────────
  const act = useCallback(
    (action: GapAction, id: string): void => {
      const name = displayName(id);
      if (action === "open") {
        if (id.startsWith(GHOST)) notice.warn(t.gr_insp_unresolved);
        else setRoute(`page:${id}`);
        return;
      }
      if (action === "link") {
        setQueryPrefill(t.gr_link_question.split("{a}").join(name));
        setRoute("query");
        return;
      }
      // A wiki gap is not a session, so it cannot join the sessions→wiki
      // harvest queue. It is a WANTED topic: the same recall-miss log the Ask
      // abstention card writes, so the next ingest knows what was missing.
      const vault = currentVault?.path;
      if (!vault) return;
      void ipc
        .recordRecallMiss(vault, name)
        .then(() => notice.ok(t.gr_want_done.split("{n}").join(name)))
        .catch((e: unknown) => notice.warn(String(e)));
    },
    [currentVault?.path, setRoute, t],
  );

  const selectNode = useCallback((id: string): void => {
    setSelected(id);
    canvasRef.current?.focusNode(id);
  }, []);

  const counts: SurveyCounts = derived
    ? {
        ...derived.counts,
        neighbors: hops ? hops.size - 1 : null,
      }
    : {
        total: 0,
        sample: 0,
        own: 0,
        unresolved: 0,
        gaps: 0,
        orphans: 0,
        noBacklink: 0,
        clusters: 0,
        maplessClusters: 0,
        fresh30d: 0,
        neighbors: null,
        sessions: sessionCount,
        cited: 0,
      };

  const report = useMemo(
    () => (derived && derived.graph.order > 0 ? analyzeGaps(derived.graph) : null),
    [derived],
  );
  const groups = useMemo(
    () => (report ? gapGroups(report, derived?.noBacklink ?? [], t) : []),
    [report, derived, t],
  );

  const totalNodes = countAllNodes(adjacency);

  return (
    <div className="workspace workspace-wide sv">
      <header className="page-head">
        <div className="page-eyebrow">{t.nav_graph}</div>
        <h1 className="page-title">{t.gr_title}</h1>
        <p className="page-lede">{t.gr_lede}</p>
      </header>

      <GraphControls
        t={t}
        settings={settings}
        counts={counts}
        build={build}
        search={search}
        onChange={(patch) => setSettings((s) => ({ ...s, ...patch }))}
        onSearch={setSearch}
      />

      <div className="sv-work">
        <GraphGaps
          t={t}
          groups={groups}
          total={report ? gapCount(report) : 0}
          selected={selected}
          onSelect={selectNode}
          onAction={act}
        />

        <section className="sv-stage" aria-label={t.gr_title}>
          <div ref={hostRef} className="sv-canvas" />
          {totalNodes === 0 ? (
            <p className="muted sv-stage__empty">
              {t.gr_empty_pre}
              <code className="mono">[[wikilinks]]</code>
              {t.gr_empty_post}
            </p>
          ) : null}
          <span className="sv-stage__hint">{t.gr_stage_hint}</span>
          {tip && derived ? (
            <div
              className="sv-tip"
              role="status"
              style={{ left: Math.min(tip.x + 12, 600), top: tip.y + 12 }}
            >
              <b>{displayName(tip.id)}</b>
              <span className="k mono">{tipLine(tip.id, derived, t)}</span>
            </div>
          ) : null}
          <div className="sv-stage__note">
            <span>
              {counts.total} {t.gr_node_count} · {derived?.graph.size ?? 0} {t.gr_edge_count}
            </span>
            <span>{encodingLine(settings.question, t)}</span>
          </div>
        </section>

        {adjacency ? (
          <GraphInspector
            t={t}
            nodeId={selected}
            adjacency={adjacency}
            isSample={(id) => isSamplePath(vaultRoot, id)}
            onSelect={selectNode}
            onOpen={(id) => setRoute(`page:${id}`)}
            onAction={act}
            onNeighbors={(id) => {
              setSelected(id);
              setSettings((s) => ({ ...s, question: "neighbors" }));
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

/** "what the colours and sizes mean right now" — one line under the canvas. */
function encodingLine(q: Question, t: Strings): string {
  const map: Record<Question, string> = {
    orphans: t.gr_enc_orphans,
    clusters: t.gr_enc_clusters,
    time: t.gr_enc_time,
    neighbors: t.gr_enc_neighbors,
  };
  return map[q];
}

function tipLine(id: string, d: Derived, t: Strings): string {
  const n = d.nodes.get(id);
  if (!n) return "";
  if (n.ghost) return t.gr_insp_unresolved;
  return `${t.gr_insp_backlinks} ${n.backlinks} · ${t.gr_insp_cites} ${n.cites}`;
}

/** Everything the questions read, derived once per built graph. */
function derive(
  graph: VaultGraph,
  adjacency: { backward: Record<string, string[]>; meta?: Record<string, { sourceCount?: number }> },
  vaultRoot: string,
  sessions: number,
  t: Strings,
): Derived {
  void t;
  const nodes = new Map<string, EncNode>();
  const noBacklink: string[] = [];
  let maxBacklinks = 1;
  let sample = 0;
  let own = 0;
  let unresolved = 0;
  let orphans = 0;
  let fresh30d = 0;
  let cited = 0;

  graph.forEachNode((id, a) => {
    const ghost = id.startsWith(GHOST);
    const backlinks = ghost
      ? 0
      : (adjacency.backward[id] ?? []).filter((s) => graph.hasNode(s)).length;
    const cites = adjacency.meta?.[id]?.sourceCount ?? 0;
    const deg = graph.degree(id);
    if (backlinks > maxBacklinks) maxBacklinks = backlinks;
    if (ghost) unresolved++;
    else if (isSamplePath(vaultRoot, id)) sample++;
    else own++;
    if (!ghost && deg === 0) orphans++;
    if (!ghost && deg > 0 && backlinks === 0) noBacklink.push(id);
    if (!ghost && (a.age ?? 9999) <= 30) fresh30d++;
    if (cites > 0) cited++;
    nodes.set(id, {
      id,
      label: ghost ? id.slice(GHOST.length) : stem(id),
      ghost,
      deg,
      backlinks,
      cites,
      ageDays: a.age ?? 9999,
      color: a.color,
      community: a.community,
    });
  });

  const labels = clusterLabels(graph);
  const mapless = new Set<number>();
  for (const l of labels) {
    const hasMap = l.memberIds.some(
      (id) => graph.getNodeAttribute(id, "nodeType") === MAP_TYPE,
    );
    if (!hasMap) mapless.add(l.community);
  }

  const report = analyzeGaps(graph);
  return {
    graph,
    nodes,
    labels,
    mapless,
    noBacklink,
    maxBacklinks,
    counts: {
      total: graph.order,
      sample,
      own,
      unresolved,
      gaps: gapCount(report) + noBacklink.length,
      orphans,
      noBacklink: noBacklink.length,
      clusters: labels.length,
      maplessClusters: mapless.size,
      fresh30d,
      neighbors: null,
      sessions,
      cited,
    },
  };
}
