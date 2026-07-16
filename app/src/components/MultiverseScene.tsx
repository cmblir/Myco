// 3D multiverse scene — mounts the assembled, spatially-separated universe graph
// into the existing GraphScene as a STATIC layout (no worker sim, like the atlas
// path). Positions come pre-baked from assembleMultiverse; we build the scene,
// fit the camera to the whole field, and let GraphScene's cosmic-LOD render the
// far universes as imposter discs and the near one as stars. Clicking a node
// enters that node's universe.
//
// Deliberately a SEPARATE component from PageGraph so the multiverse scene never
// shares PageGraph's adjacency-keyed rebuild / worker wiring.

import { useEffect, useRef } from "react";
import type { JSX } from "react";
import { GraphScene } from "../lib/graphScene";
import { DEFAULT_GRAPH_SETTINGS } from "../lib/graphSettings";
import { makeTheme } from "../lib/graphTheme";
import { assembleMultiverse, universeOfNode, type SceneUniverse } from "../lib/multiverseScene";

export interface MultiverseSceneProps {
  universes: SceneUniverse[];
  // Called when the user clicks a star — resolves to that node's universe slug
  // so the page can enter it. Empty slug (untagged node) is ignored by the page.
  onEnterUniverse: (slug: string) => void;
}

export default function MultiverseScene({
  universes,
  onEnterUniverse,
}: MultiverseSceneProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<GraphScene | null>(null);
  // Keep the latest enter callback reachable from the scene without rebuilding
  // the scene when it changes (mirrors PageGraph's ref pattern for handlers).
  const enterRef = useRef(onEnterUniverse);
  enterRef.current = onEnterUniverse;

  // A stable key over the universe set + each one's adjacency identity, so the
  // scene rebuilds only when the actual multiverse content changes — not on
  // every render (loadAll replaces the adjacency objects when content changes).
  const key = universes.map((u) => u.slug).join("|") + "#" + universes.length;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || universes.length === 0) return;

    // Galaxy layout = the 3D cosmic renderer. We DON'T start a worker sim; the
    // node positions are pre-baked by assembleMultiverse and stay put, so the
    // scene renders the static field (far universes → imposter discs via LOD).
    const settings = { ...DEFAULT_GRAPH_SETTINGS, layout: "galaxy" as const };
    const theme = makeTheme(settings.skin);
    const { graph } = assembleMultiverse(
      universes,
      {
        nodeSize: settings.nodeSize,
        starDim: theme.starDim,
        edgeColor: theme.edge,
        showGhosts: false, // ghosts add noise across a whole multiverse; hide them
        folderGalaxies: true,
      },
      settings.linkDistance,
    );
    if (graph.order === 0) return;

    let killed = false;
    // Multiverse scene ignores hover/drag/void/context — only clicking a star to
    // enter its universe matters. One shared no-op keeps the interface satisfied.
    const noop = (): void => undefined;
    const scene = new GraphScene(container, graph, theme, settings, {
      onNodeClick: (id) => {
        if (killed) return;
        const slug = universeOfNode(graph, id);
        if (slug) enterRef.current(slug);
      },
      onNodeHover: noop,
      onDragStart: noop,
      onDrag: noop,
      onDragEnd: noop,
      onVoidClick: noop,
      onContextLost: noop,
      onContextRestored: noop,
    });
    sceneRef.current = scene;
    scene.start();
    // Static layout: positions are final, so sync them into the buffers and
    // frame the whole field immediately (no cinematic worker-settle flight).
    scene.syncPositions();
    scene.layoutSettled();
    scene.fit();
    container.classList.add("graph-ready");

    // DEV: expose for the screenshot harness (same shape as PageGraph).
    if (import.meta.env.DEV) {
      (window as unknown as { __mvDev?: unknown }).__mvDev = {
        scene,
        graph,
        rect: () => container.getBoundingClientRect(),
      };
    }

    return () => {
      killed = true;
      scene.dispose();
      sceneRef.current = null;
      container.classList.remove("graph-ready");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return <div ref={containerRef} className="graph-canvas mv-scene" />;
}
