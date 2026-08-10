// Mounts the standalone mycelium renderer.
//
// This deliberately does NOT go through GraphScene. That renderer is built for
// deep space — starfield, nebula, bloom, fog, AgX, a post-processing chain —
// and four attempts to make the mat look right by switching those off one at a
// time all ended with the same blue sky showing through. MyceliumScene owns its
// renderer and has no post-processing at all, so there is nothing to switch off.
//
// The picture itself: buildMyceliumMat GROWS a real fungal mat (tip growth +
// branching + anastomosis — a shape the wikilink graph could never produce)
// and then EMBEDS the note graph into it, so a link between two notes is a
// path along real hyphae, never a drawn chord. See staticLayouts.ts for the
// growth + embedding; this component just feeds the result to the renderer.
import { useEffect, useRef } from "react";
import type { JSX } from "react";
import { MyceliumScene, type Septum } from "../lib/myceliumScene";
import { buildMyceliumMat } from "../lib/staticLayouts";
import type { VaultGraph } from "../lib/graphData";
import { useUIStore } from "../stores/uiStore";
import type { RouteId } from "../stores/uiStore";

const GROW_SECS = 3.2;
// World radius of the grown mat. Independent of the hidden GraphScene's
// linkDistance-derived scale — this renderer never reads the force-layout
// settings.
const TARGET_RADIUS = 900;
// Always-on labels are capped to the busiest notes: a real vault runs ~1244
// notes, and a label per note is unreadable clutter (and, before growth
// finishes, a wall of text over an still-forming mat). 20 keeps the layer
// legible while still naming the notes most worth orienting by.
const HUB_LABEL_CAP = 20;

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
  // Hover label: a plain DOM element positioned at the cursor rather than a
  // CSS2DRenderer layer — one node, updated on pointer move, is cheap and
  // avoids pulling a whole label-renderer into a scene that otherwise has
  // none of that machinery.
  const labelRef = useRef<HTMLDivElement | null>(null);
  // Always-on hub labels — a fixed small set of DOM spans, repositioned every
  // frame by the scene's onFrame (see below). Created imperatively like the
  // hover label above, not React state: their count is capped (HUB_LABEL_CAP)
  // and they move every frame, so state-driven re-renders would be wasted work.
  const hubHostRef = useRef<HTMLDivElement | null>(null);
  const setRoute = useUIStore((s) => s.setRoute);

  useEffect(() => {
    const el = host.current;
    const label = labelRef.current;
    const hubHost = hubHostRef.current;
    if (!el || !graph || graph.order === 0) return;

    // The busiest notes by link count — same "hubs first" convention as the
    // static layouts (applyRadialLayout etc). A span per id, created once;
    // onFrame only ever toggles their visibility/position.
    const hubIds = graph
      .nodes()
      .slice()
      .sort((a, b) => (graph.getNodeAttribute(b, "deg") ?? 0) - (graph.getNodeAttribute(a, "deg") ?? 0))
      .slice(0, HUB_LABEL_CAP);
    const hubEls = new Map<string, HTMLSpanElement>();
    if (hubHost) {
      hubHost.replaceChildren();
      for (const id of hubIds) {
        const span = document.createElement("span");
        span.className = "myc-hub-label";
        span.textContent = graph.getNodeAttribute(id, "label") ?? id;
        hubHost.appendChild(span);
        hubEls.set(id, span);
      }
    }

    const scene = new MyceliumScene(el, {
      onPick: (id) => {
        // The graph keys nodes by vault-relative path; the page route reads an
        // ABSOLUTE one (it hands it to readFile), so rejoin the root.
        const abs = id.startsWith(vaultPath) ? id : `${vaultPath}/${id}`;
        setRoute(`page:${abs}` as RouteId);
      },
      onHover: (id) => {
        if (!label) return;
        if (id) {
          label.textContent = graph.getNodeAttribute(id, "label") ?? id;
          label.style.display = "block";
        } else {
          label.style.display = "none";
        }
      },
      onFrame: (labels) => {
        const shown = new Set(labels.map((l) => l.id));
        for (const [id, span] of hubEls) {
          if (!shown.has(id)) span.style.display = "none";
        }
        for (const l of labels) {
          const span = hubEls.get(l.id);
          if (!span) continue;
          span.style.display = "block";
          // Offset off the dot itself, or the text sits directly on top of
          // the point it's naming instead of beside it.
          span.style.transform = `translate(${l.x + 6}px, ${l.y - 6}px)`;
        }
      },
    });
    scene.setLabelIds(hubIds);
    // The label follows the raw cursor, not the septum's projected position —
    // the pick radius is only 14px, so the cursor is already right on the dot,
    // and this avoids re-projecting a point every pointer move just to place
    // some text next to it.
    const onPointerMove = (e: PointerEvent): void => {
      if (!label) return;
      const rect = el.getBoundingClientRect();
      label.style.transform = `translate(${e.clientX - rect.left + 14}px, ${e.clientY - rect.top + 14}px)`;
    };
    el.addEventListener("pointermove", onPointerMove);

    const { buckets, matIndexOf, mat } = buildMyceliumMat(graph, { targetRadius: TARGET_RADIUS });
    // The 2D toggle flattens the grown mat itself (not just the notes) —
    // otherwise hyphae would draw in 3D under notes pinned to z=0.
    if (flat) {
      for (const b of buckets) for (let k = 2; k < b.positions.length; k += 3) b.positions[k] = 0;
    }

    let maxDeg = 1;
    graph.forEachNode((_id, attrs) => {
      maxDeg = Math.max(maxDeg, (attrs.deg as number) ?? 1);
    });
    const lastIdx = Math.max(1, mat.length - 1);
    const septa: Septum[] = [];
    graph.forEachNode((id, attrs) => {
      const idx = matIndexOf.get(id);
      if (idx == null) return;
      const h = mat[idx];
      septa.push({
        id,
        x: h.x,
        y: h.y,
        z: flat ? 0 : h.z,
        birth: idx / lastIdx,
        weight: Math.min(1, ((attrs.deg as number) ?? 1) / maxDeg),
        color: (attrs.color as string) ?? "#d8cfbc",
      });
    });

    scene.setMat(buckets);
    scene.setSepta(septa);
    scene.setPlanar(flat);
    scene.fit();
    if (fitRef) fitRef.current = () => scene.fit();

    scene.startGrowth(
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : GROW_SECS,
    );
    scene.start();

    // DEV-ONLY: expose enough for a screenshot/measurement harness to prove
    // hyphae are the grown mat (never a note-to-note chord) and growth
    // actually animates over time — mirrors PageGraph.tsx's __graphDev.
    if (import.meta.env.DEV) {
      (window as unknown as { __myceliumDev?: unknown }).__myceliumDev = {
        scene,
        mountedAt: performance.now(),
        nodeIds: graph.nodes(),
        edges: graph.edges().map((e) => graph.extremities(e)),
        matIndexOf,
        mat,
        // The exact geometry buckets fed to the renderer — lets the harness
        // confirm a drawn segment's own endpoints, not just re-derive them.
        buckets: buckets.map((b) => ({ width: b.width, positions: Array.from(b.positions) })),
      };
    }

    const onVisible = (): void => {
      if (document.hidden) scene.stop();
      else scene.start();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      el.removeEventListener("pointermove", onPointerMove);
      if (fitRef) fitRef.current = null;
      scene.dispose();
    };
  }, [graph, vaultPath, flat, setRoute, fitRef]);

  return (
    <div className="myc-view" ref={host}>
      <div ref={labelRef} className="myc-hover-label" />
      <div ref={hubHostRef} className="myc-hub-labels" />
    </div>
  );
}
