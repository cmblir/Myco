// Mounts the standalone mycelium renderer.
//
// This deliberately does NOT go through GraphScene. That renderer is built for
// deep space — starfield, nebula, bloom, fog, AgX, a post-processing chain —
// and four attempts to make the mat look right by switching those off one at a
// time all ended with the same blue sky showing through. MyceliumScene owns its
// renderer and has no post-processing at all, so there is nothing to switch off.
//
// The picture itself: every hypha IS a real wikilink edge (buildHyphaMat reads
// the graph's own edges), and every note SPREADS from a tight starting cluster
// out to a radial layout (BFS shells from the busiest hub — real graph
// structure, not a decorative growth) as the mat grows in. Positions are
// computed on a COPY of the graph so this view never mutates the shared one
// that the (hidden, invisible-while-mycelium-is-active) GraphScene also holds.
import { useEffect, useRef } from "react";
import type { JSX } from "react";
import { MyceliumScene, type Septum } from "../lib/myceliumScene";
import { applyRadialLayout, buildHyphaMat, clusterStart } from "../lib/staticLayouts";
import type { VaultGraph } from "../lib/graphData";
import { useUIStore } from "../stores/uiStore";
import type { RouteId } from "../stores/uiStore";

const GROW_SECS = 3.2;
// Final layout radius. Independent of the hidden GraphScene's linkDistance-
// derived scale — this renderer never reads the force-layout settings.
const TARGET_RADIUS = 900;
// The tight cluster every note starts from before spreading to its real spot.
const CLUSTER_RADIUS = 40;

export default function MyceliumView({
  graph,
  vaultPath,
  flat,
  fitRef,
}: {
  graph: VaultGraph | null;
  vaultPath: string;
  /** 2D: layout flattened to z=0, camera locked front-on. 3D: free orbit. */
  flat: boolean;
  /** Exposes this instance's fit() to the page's toolbar Fit button. */
  fitRef?: React.MutableRefObject<(() => void) | null>;
}): JSX.Element {
  const host = useRef<HTMLDivElement | null>(null);
  const setRoute = useUIStore((s) => s.setRoute);

  useEffect(() => {
    const el = host.current;
    if (!el || !graph || graph.order === 0) return;

    const scene = new MyceliumScene(el, {
      onPick: (id) => {
        // The graph keys nodes by vault-relative path; the page route reads an
        // ABSOLUTE one (it hands it to readFile), so rejoin the root.
        const abs = id.startsWith(vaultPath) ? id : `${vaultPath}/${id}`;
        setRoute(`page:${abs}` as RouteId);
      },
    });

    // Final layout: radial shells from the busiest hub, computed on a COPY —
    // this view must never write into the graph object the hidden GraphScene
    // (and the rest of the page) also holds.
    const laid = graph.copy() as VaultGraph;
    applyRadialLayout(laid, { targetRadius: TARGET_RADIUS });
    if (flat) laid.forEachNode((id) => laid.setNodeAttribute(id, "z", 0));
    const finalOf = (id: string): { x: number; y: number; z: number } => ({
      x: laid.getNodeAttribute(id, "x"),
      y: laid.getNodeAttribute(id, "y"),
      z: laid.getNodeAttribute(id, "z"),
    });
    const startOf = (id: string): { x: number; y: number; z: number } => {
      const c = clusterStart(id, CLUSTER_RADIUS);
      return flat ? { x: c.x, y: c.y, z: 0 } : c;
    };

    const finalBuckets = buildHyphaMat(graph, finalOf);
    const startBuckets = buildHyphaMat(graph, startOf);
    scene.setMat(finalBuckets, startBuckets);

    let maxDeg = 1;
    graph.forEachNode((_id, attrs) => {
      maxDeg = Math.max(maxDeg, (attrs.deg as number) ?? 1);
    });
    const septa: Septum[] = [];
    graph.forEachNode((id, attrs) => {
      const f = finalOf(id);
      const s = startOf(id);
      septa.push({
        id,
        x: f.x,
        y: f.y,
        z: f.z,
        sx: s.x,
        sy: s.y,
        sz: s.z,
        weight: Math.min(1, ((attrs.deg as number) ?? 1) / maxDeg),
        color: (attrs.color as string) ?? "#d8cfbc",
      });
    });
    scene.setSepta(septa);
    scene.setPlanar(flat);
    scene.fit();
    if (fitRef) fitRef.current = () => scene.fit();

    scene.startGrowth(
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : GROW_SECS,
    );
    scene.start();

    const onVisible = (): void => {
      if (document.hidden) scene.stop();
      else scene.start();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      if (fitRef) fitRef.current = null;
      scene.dispose();
    };
  }, [graph, vaultPath, flat, setRoute, fitRef]);

  return <div className="myc-view" ref={host} />;
}
