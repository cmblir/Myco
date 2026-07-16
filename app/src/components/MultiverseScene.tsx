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
import { UniverseBubbleLayer } from "../lib/universeBubbleLayer";

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
    // Per-node labels are pushed out of reach for the same reason ghosts are
    // hidden below: at multiverse framing a note's title is unreadable noise,
    // and there are thousands of them. Fly into a bubble and the normal graph
    // takes over with its own labels. (The community names that surface at this
    // distance are turned off separately — see setClusterLabelsVisible.)
    const settings = {
      ...DEFAULT_GRAPH_SETTINGS,
      layout: "galaxy" as const,
      textFadeThreshold: 3,
    };
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
    let entering = false; // guards against re-triggering mid-flight
    let bubbles: UniverseBubbleLayer | null = null;
    // Enter a universe: guard, then switch the active vault. Idempotent.
    const enter = (slug: string): void => {
      if (killed || entering || !slug) return;
      entering = true;
      enterRef.current(slug);
    };
    // Multiverse scene ignores hover/drag/void/context. Clicking a star flies
    // the camera INTO its bubble and enters on arrival (a shortcut); the main
    // gesture is just zooming in — the proximity watcher below enters whichever
    // bubble the camera dollies into. One shared no-op satisfies the rest.
    const noop = (): void => undefined;
    const scene = new GraphScene(container, graph, theme, settings, {
      onNodeClick: (id) => {
        if (killed || entering) return;
        const slug = universeOfNode(graph, id);
        if (!slug) return;
        const b = bubbles?.centres().find((c) => c.slug === slug);
        if (b) {
          entering = true;
          scene.flyInto(b.centre, b.radius, () => {
            if (!killed) enterRef.current(slug);
          });
        } else {
          enter(slug);
        }
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
    // Community names are a single-vault affordance: pull back and the clusters
    // name themselves. One tier up they are the wrong nouns — a cluster topic
    // from inside a bubble sits at screen-fixed size and drowns out the bubble's
    // own name, which is the only label that means anything out here.
    scene.setClusterLabelsVisible(false);
    // Wrap each universe in its glowing bubble sphere (the multiverse form),
    // labelled with the project title.
    const titles = new Map(universes.map((u) => [u.slug, u.title ?? u.slug]));
    bubbles = new UniverseBubbleLayer(graph, graph.nodes(), { titles });
    scene.addOverlay(bubbles.group);
    scene.start();
    // Static layout: positions are final, so sync them into the buffers and
    // frame the whole field immediately (no cinematic worker-settle flight).
    scene.syncPositions();
    scene.layoutSettled();
    scene.fit();
    container.classList.add("graph-ready");

    // Zoom-to-enter: point the orbit pivot at whichever bubble is nearest the
    // camera as the user scrolls IN, so a dolly pulls the camera toward (and
    // into) that universe; once the camera is inside the bubble, open it — no
    // click needed. Wheel-driven so it never fires from the initial fit.
    type BubbleCentre = ReturnType<UniverseBubbleLayer["centres"]>[number];
    const nearestBubble = (): BubbleCentre | null => {
      if (!bubbles) return null;
      const cam = scene.getCameraPosition();
      let best: BubbleCentre | null = null;
      let bestD = Infinity;
      for (const b of bubbles.centres()) {
        const d = cam.distanceTo(b.centre);
        if (d < bestD) {
          bestD = d;
          best = b;
        }
      }
      return best;
    };
    const onWheel = (e: WheelEvent): void => {
      if (killed || entering || e.deltaY >= 0) return; // only on zoom IN
      const b = nearestBubble();
      if (b) scene.setOrbitTarget(b.centre);
    };
    container.addEventListener("wheel", onWheel, { passive: true });

    const ENTER_FACTOR = 0.72; // camera within 72% of the radius = "inside"
    let armed = false;
    const armTimer = window.setTimeout(() => {
      armed = true;
    }, 1200);
    let raf = requestAnimationFrame(function tick() {
      if (killed) return;
      raf = requestAnimationFrame(tick);
      if (!armed || entering) return;
      const b = nearestBubble();
      if (b && scene.getCameraPosition().distanceTo(b.centre) < b.radius * ENTER_FACTOR) {
        enter(b.slug);
      }
    });

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
      cancelAnimationFrame(raf);
      window.clearTimeout(armTimer);
      container.removeEventListener("wheel", onWheel);
      bubbles?.dispose();
      scene.dispose();
      sceneRef.current = null;
      container.classList.remove("graph-ready");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return <div ref={containerRef} className="graph-canvas mv-scene" />;
}
