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
import { buildMatAdjacency, buildMyceliumMat, matPath } from "../lib/staticLayouts";
import type { VaultGraph } from "../lib/graphData";
import { useUIStore } from "../stores/uiStore";

const GROW_SECS = 3.2;
// World radius of the grown mat. Independent of the hidden GraphScene's
// linkDistance-derived scale — this renderer never reads the force-layout
// settings.
//
// MEASURED, not assumed: fit() always reframes to the mat's own bounding
// sphere (see myceliumScene.ts), and that reframe scales camera distance
// proportionally to sphere radius — so scaling TARGET_RADIUS alone is a
// projective no-op on the rendered image. Confirmed at 1244 notes: the
// on-canvas mat-pixel fraction was IDENTICAL (0.1211) at radius 900 and at
// radius 1800 with fit()'s old 1.25 padding unchanged. The lever that
// actually changes on-screen size is fit()'s padding constant, tightened
// below (1.25 -> 1.05: fraction 0.1211 -> ~0.13). Still bumped here (2x)
// because it is not a PURE no-op: hyphae linewidth and septa point size are
// fixed screen-space px (see setMat/setSepta), so more world space per strand
// gives near/far clipping and pointer-pick tolerances more headroom at this
// scale, and keeps this renderer's own notion of "big" in step with fit()'s.
const TARGET_RADIUS = 1800;
// Always-on labels are capped to the busiest notes: a real vault runs ~1244
// notes, and a label per note is unreadable clutter (and, before growth
// finishes, a wall of text over an still-forming mat). 20 keeps the layer
// legible while still naming the notes most worth orienting by.
const HUB_LABEL_CAP = 20;

export default function MyceliumView({
  graph,
  onSelect,
  flat,
  nodeColor,
  hyphaColor,
  background,
  gridGround,
  nodeSizeScale,
  linkThicknessScale,
  textFadeThreshold,
  ambientMotion,
  growSpeed,
  maxNodes,
  branchPct,
  fitRef,
  startGrowthRef,
  focusRef,
}: {
  graph: VaultGraph | null;
  /** Node click → selection (the page opens the SAME GraphInspector panel the
   *  main graph uses — z-index 5, over this view's z-index 2 canvas). A click
   *  on empty substrate passes null = deselect, like clicking the void. Must
   *  be referentially stable (PageGraph passes setSelected) — it sits in the
   *  build effect's dependency list. */
  onSelect: (id: string | null) => void;
  /** 2D: layout flattened to z=0, camera locked front-on. 3D: free orbit. */
  flat: boolean;
  /** Flat septa colour — independent of hyphaColor so a node never has to
   *  share a hue with the strand it sits on to be locatable (see
   *  graphSettings.ts's myceliumNodeColor). */
  nodeColor: string;
  /** Flat hyphae colour (graphSettings.ts's myceliumHyphaColor). */
  hyphaColor: string;
  /** Substrate colour (graphSettings.ts's myceliumBackground) — live scene
   *  background update, no rebuild. */
  background: string;
  /** The "grid" background preset is active (matchMyceliumBg === "grid") —
   *  draws the faint drafting grid, live like the colour (no rebuild). */
  gridGround: boolean;
  /** "Node size" slider — septa point-size multiplier, live (no rebuild). */
  nodeSizeScale: number;
  /** "Link thickness" slider — hypha linewidth multiplier, live (no rebuild). */
  linkThicknessScale: number;
  /** "Text fade threshold" slider — hub-label visibility distance, live. */
  textFadeThreshold: number;
  /** "Ambient motion" toggle — slow 3D auto-orbit; no-op in 2D/reduced-motion. */
  ambientMotion: boolean;
  /** "Timelapse speed" slider — scales the grow-in duration. */
  growSpeed: number;
  /** "Link distance" slider, mapped (graphSettings.ts's myceliumMaxNodes) —
   *  mat density. Rebuilds the mat, so the caller debounces this. */
  maxNodes: number;
  /** "Cluster force" slider, mapped (graphSettings.ts's myceliumBranchPct) —
   *  branch density. Rebuilds the mat, so the caller debounces this. */
  branchPct: number;
  /** Exposes this instance's fit() to the page's toolbar Fit button. */
  fitRef?: React.MutableRefObject<(() => void) | null>;
  /** Exposes this instance's startGrowth() to the page's toolbar timelapse
   *  button — the on-demand replay, independent of the auto-play-once rule
   *  below (see useUIStore's myceliumGrown). */
  startGrowthRef?: React.MutableRefObject<(() => void) | null>;
  /** Exposes fly-to-a-note: the search box (Enter), the inspector's link rows
   *  and gap analysis all call this — the mycelium counterpart of
   *  GraphScene.focusNode. Also lights the note + its neighbours (the same
   *  highlight hover draws) so the target is findable after arrival. */
  focusRef?: React.MutableRefObject<((id: string) => void) | null>;
}): JSX.Element {
  const host = useRef<HTMLDivElement | null>(null);
  // Handle to the live scene, for the small prop-driven effects below that
  // must NOT rebuild the mat (size/width/fade/motion are uniform or
  // OrbitControls updates, not geometry). Separate from the heavy build
  // effect's own local `scene` so those effects don't have to re-run it.
  const sceneRef = useRef<MyceliumScene | null>(null);
  // Read inside startGrowth callbacks instead of a dependency, so dragging
  // the timelapse-speed slider never re-triggers the (expensive) build effect.
  const growSpeedRef = useRef(growSpeed);
  growSpeedRef.current = growSpeed;
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

    const { buckets, matIndexOf, mat } = buildMyceliumMat(graph, {
      targetRadius: TARGET_RADIUS,
      dim: flat ? "2d" : "3d",
      hyphaColor,
      maxNodes,
      branchPct,
    });
    // The 2D toggle flattens the grown mat itself (not just the notes) —
    // otherwise hyphae would draw in 3D under notes pinned to z=0.
    if (flat) {
      for (const b of buckets) for (let k = 2; k < b.positions.length; k += 3) b.positions[k] = 0;
    }
    // Mat adjacency for the neighbour-highlight's path search — built once
    // and reused on every hover, not rebuilt per hover event.
    const matAdj = buildMatAdjacency(mat);
    // Non-null capture: applyHighlight below is a hoisted function declaration,
    // so the effect's early-return null check doesn't narrow `graph` inside it.
    const g = graph;

    // Light a note + its wikilink neighbours along real hyphal routes (matPath
    // BFS over the mat — never a note-to-note chord), or clear with null.
    // Shared by hover and by focusRef (search / inspector fly-to), so an
    // arrived-at note is lit the same way a hovered one is.
    function applyHighlight(id: string | null): void {
      if (!id) {
        scene.setHighlight(null, [], new Float32Array());
        return;
      }
      const neighborIds = g.neighbors(id);
      const fromIdx = matIndexOf.get(id);
      const segPts: number[] = [];
      if (fromIdx != null) {
        for (const nid of neighborIds) {
          const toIdx = matIndexOf.get(nid);
          const path = toIdx != null ? matPath(matAdj, fromIdx, toIdx) : null;
          if (!path) continue;
          for (let i = 0; i + 1 < path.length; i++) {
            const a = mat[path[i]];
            const b = mat[path[i + 1]];
            segPts.push(a.x, a.y, flat ? 0 : a.z, b.x, b.y, flat ? 0 : b.z);
          }
        }
      }
      scene.setHighlight(id, neighborIds, new Float32Array(segPts));
    }

    const scene = new MyceliumScene(el, {
      // Selection, not navigation: parity with the main graph, where a click
      // opens the GraphInspector (PageGraph renders it over this canvas) and
      // opening the page is the inspector's own action. null = clicked empty
      // substrate = deselect.
      onPick: (id) => onSelect(id),
      onHover: (id) => {
        if (label) {
          if (id) {
            label.textContent = graph.getNodeAttribute(id, "label") ?? id;
            label.style.display = "block";
            // Depth cue: a note at the back of the volume shouldn't read as
            // if it were right in front of the camera — see depthOpacity.
            label.style.opacity = String(scene.depthOpacity(id));
          } else {
            label.style.display = "none";
          }
        }
        applyHighlight(id);
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
          // Depth cue (see MyceliumScene.depthT): a hub at the back of the
          // volume fades instead of reading as if it were up front.
          span.style.opacity = String(l.opacity);
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
        // Flat, independent of the note's own community tint — see the
        // nodeColor prop doc for why (Part 1 legibility fix).
        color: nodeColor,
      });
    });

    scene.setMat(buckets);
    scene.setSepta(septa);
    scene.setPlanar(flat);
    // Seed the live-adjustable knobs at their CURRENT slider values — this
    // effect reruns on every flat/color/density change and rebuilds the
    // scene from scratch, so without this a rebuild would silently reset
    // "Node size"/"Link thickness"/"Text fade"/"Ambient motion" to defaults
    // until the user nudged the slider again.
    scene.setGround(background, gridGround);
    scene.setSizeScale(nodeSizeScale);
    scene.setWidthScale(linkThicknessScale);
    scene.setLabelFadeThreshold(textFadeThreshold);
    scene.fit();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scene.setAutoRotate(ambientMotion && !flat && !reduced);
    sceneRef.current = scene;
    if (fitRef) fitRef.current = () => scene.fit();
    if (startGrowthRef) {
      startGrowthRef.current = () => scene.startGrowth(GROW_SECS / growSpeedRef.current);
    }
    if (focusRef) {
      focusRef.current = (id) => {
        applyHighlight(id);
        scene.focusNode(id);
      };
    }

    // Grow-in plays automatically only the FIRST time this view has ever
    // mounted (persisted — see useUIStore's myceliumGrown), same as the other
    // graph layouts' one-shot intro. Every mount after that shows the fully
    // grown mat instantly; the toolbar timelapse button (wired to
    // startGrowthRef above) replays it on demand regardless of this flag.
    const grownBefore = useUIStore.getState().myceliumGrown;
    scene.startGrowth(reduced || grownBefore ? 0 : GROW_SECS / growSpeedRef.current);
    // Marking "seen" is DEFERRED, not immediate: switching to the mycelium
    // skin flips settings.skin a render before the graph-build effect (keyed
    // on settings.layout) catches up, so this view can mount once against
    // the previous layout's still-valid graph and immediately remount again
    // against the freshly-rebuilt one once that effect runs. Writing the flag
    // synchronously let that first, throwaway mount spend the one-shot flag,
    // so the mount the user actually SAW never animated. Cancelling the write
    // on cleanup means only a mount that survives gets to spend it.
    // ponytail: a fixed delay, not an exact "did a replacement mount happen"
    // signal — 500ms is generous headroom over a same-tick React re-render,
    // upgrade to tracking the build effect's own completion if this ever
    // proves too short in practice.
    let markGrownTimer: number | null = null;
    if (!grownBefore) {
      markGrownTimer = window.setTimeout(() => useUIStore.getState().setMyceliumGrown(true), 500);
    }
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
        // `colors` rides alongside so the harness can verify cluster colouring
        // (distinct-colour count, region contiguity) against the ACTUAL
        // per-vertex data, not just re-sampled screenshot pixels.
        buckets: buckets.map((b) => ({
          width: b.width,
          positions: Array.from(b.positions),
          colors: Array.from(b.colors),
        })),
      };
    }

    const onVisible = (): void => {
      if (document.hidden) scene.stop();
      else scene.start();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (markGrownTimer != null) window.clearTimeout(markGrownTimer);
      document.removeEventListener("visibilitychange", onVisible);
      el.removeEventListener("pointermove", onPointerMove);
      if (fitRef) fitRef.current = null;
      if (startGrowthRef) startGrowthRef.current = null;
      if (focusRef) focusRef.current = null;
      sceneRef.current = null;
      scene.dispose();
    };
    // background/nodeSizeScale/linkThicknessScale/textFadeThreshold/
    // ambientMotion are deliberately absent: they're live uniform/scene/
    // OrbitControls updates (see
    // the effects below), not geometry, so they must not trigger a rebuild.
    // maxNodes/branchPct DO belong here — they reshape the grown mat, and the
    // caller (PageGraph) debounces them before they ever reach this prop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, onSelect, flat, nodeColor, hyphaColor, maxNodes, branchPct, fitRef, startGrowthRef, focusRef]);

  // Live updates for the knobs the build effect intentionally excludes above.
  useEffect(() => {
    sceneRef.current?.setGround(background, gridGround);
  }, [background, gridGround]);
  useEffect(() => {
    sceneRef.current?.setSizeScale(nodeSizeScale);
  }, [nodeSizeScale]);
  useEffect(() => {
    sceneRef.current?.setWidthScale(linkThicknessScale);
  }, [linkThicknessScale]);
  useEffect(() => {
    sceneRef.current?.setLabelFadeThreshold(textFadeThreshold);
  }, [textFadeThreshold]);
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    sceneRef.current?.setAutoRotate(ambientMotion && !flat && !reduced);
  }, [ambientMotion, flat]);

  return (
    <div className="myc-view" ref={host}>
      <div ref={labelRef} className="myc-hover-label" />
      <div ref={hubHostRef} className="myc-hub-labels" />
    </div>
  );
}
