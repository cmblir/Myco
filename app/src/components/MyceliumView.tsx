// Mounts the standalone mycelium renderer.
//
// This deliberately does NOT go through GraphScene. That renderer is built for
// deep space — starfield, nebula, bloom, fog, AgX, a post-processing chain —
// and four attempts to make the mat look right by switching those off one at a
// time all ended with the same blue sky showing through. MyceliumScene owns its
// renderer and has no post-processing at all, so there is nothing to switch off.
import { useEffect, useRef } from "react";
import type { JSX } from "react";
import { MyceliumScene, type MatBucket, type Septum } from "../lib/myceliumScene";
import { applyMyceliumLayout } from "../lib/staticLayouts";
import type { VaultGraph } from "../lib/graphData";
import { useUIStore } from "../stores/uiStore";
import type { RouteId } from "../stores/uiStore";

export default function MyceliumView({
  graph,
  vaultPath,
}: {
  graph: VaultGraph | null;
  vaultPath: string;
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

    const buckets = applyMyceliumLayout(graph, { targetRadius: 900 }) as MatBucket[];
    scene.setMat(buckets);

    let maxDeg = 1;
    graph.forEachNode((_id, attrs) => {
      maxDeg = Math.max(maxDeg, (attrs.deg as number) ?? 1);
    });
    const septa: Septum[] = [];
    graph.forEachNode((id, attrs) => {
      septa.push({
        id,
        x: (attrs.x as number) ?? 0,
        y: (attrs.y as number) ?? 0,
        z: (attrs.z as number) ?? 0,
        weight: Math.min(1, ((attrs.deg as number) ?? 1) / maxDeg),
        color: (attrs.color as string) ?? "#d8cfbc",
      });
    });
    scene.setSepta(septa);

    scene.fit();
    scene.startGrowth(
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 3.2,
    );
    scene.start();

    const onVisible = (): void => {
      if (document.hidden) scene.stop();
      else scene.start();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      scene.dispose();
    };
  }, [graph, vaultPath, setRoute]);

  return <div className="myc-view" ref={host} />;
}
