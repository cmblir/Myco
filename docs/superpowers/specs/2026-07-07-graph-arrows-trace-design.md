# Graph Arrows Fix + Interactive Path Trace — Design

Date: 2026-07-07
Scope: `app/` galaxy graph (`src/lib/graphScene.ts`, `src/lib/graphSettings.ts`,
`src/pages/PageGraph.tsx`, `src/components/GraphControls.tsx`)

## Problem

1. **Arrows look wrong.** Directional link arrows render as large white cones
   (`ConeGeometry(2.2, 7, 10)` at `graphScene.ts:667`) in one shared bright
   `edgeHi` colour with `AdditiveBlending` — so every arrow is a big white glowing
   cone roughly the size of a node. They should be (a) much smaller than the
   planets, (b) coloured like the SOURCE node the arrow departs from, and (c)
   size-adjustable.
2. **No animated path tracing.** A static shortest-path highlight exists
   (Cmd/Ctrl-click anchor → select → `shortestPath` → filament layer), but there
   is no way to pick a start node and watch the route to an end node animate.

## Goals

- Arrows: small (well under node radius), coloured by source node, with a size
  slider in the graph display controls.
- A dedicated **Trace mode**: toggle on → click start node → click end node →
  the shortest path animates (sequential hop lighting + a moving pulse) from
  start to end. Plain-click focus/inspector behaviour is untouched.

## Non-goals

- Changing the force simulation, node sizing, or community colouring.
- Directed-graph semantics (the graphology graph stays undirected; arrow
  direction continues to follow edge insertion order).
- Persisting trace state across reloads (it's an interaction, not a setting).
  The arrow-size slider IS persisted (it's a display setting).

## A. Arrows

### A1. Shrink the cone (`graphScene.ts:667`)
Replace `new THREE.ConeGeometry(2.2, 7, 10)` with a small base cone, e.g.
`new THREE.ConeGeometry(0.5, 1.6, 8)`. For reference a leaf node's world radius is
`size * NODE_RADIUS ≈ 0.85 * 3.4 ≈ 2.9`, so a 0.5-radius / 1.6-tall cone is clearly
sub-planet. Final numbers tuned visually; the slider (A3) scales from here.

### A2. Colour by source node (per-instance)
Today one `MeshBasicMaterial.color = edgeHi` paints all arrows. Change to
per-instance colours:
- Give the arrows `InstancedMesh` an instance-colour buffer (`setColorAt` /
  `instanceColor`); set the material base colour to white so instance colours
  show true.
- In `writeArrows()` (`graphScene.ts:931-970`), for each edge read the source
  node colour via `this.graph.getNodeAttributes(source).color` (the loop already
  has the source node `s`) and `setColorAt(i, color)`; flag
  `instanceColor.needsUpdate = true` after the loop.
- Switch the arrow material from `AdditiveBlending` to `NormalBlending` (with
  `transparent`, opacity ~0.9) so coloured arrows read as their hue instead of
  blowing out to white. This mirrors the filament layer, which already paints
  strands with source/target node colours (`graphScene.ts:1265-1266`).
- Theme-change recolour (`graphScene.ts:1475`) no longer forces `edgeHi`; instead
  re-run the per-instance colouring (call `writeArrows()`), since node colours
  can shift with theme.

### A3. Arrow-size slider
- Add `arrowSize: number` to `GraphSettings` (`graphSettings.ts:10`) with a small
  default (`0.35`) and back-fill it in the versioned loader (`graphSettings.ts`
  back-fill block) so existing persisted settings gain the field.
- In `writeArrows()`, multiply the per-instance scale by `settings.arrowSize`
  (kept independent of `linkThickness`, which controls line width).
- Add a slider to `GraphControls.tsx` next to the Arrows toggle (range ~0.1–1.5,
  step 0.05), disabled when `settings.arrows` is off. Label via new i18n key.
- Add `settings.arrowSize` to the display-slider effect deps
  (`PageGraph.tsx:557-563`) so dragging restyles live.

## B. Trace mode

### B1. Toggle
- Add `traceMode: boolean` React state in `PageGraph` (not persisted).
- Add a Trace toggle control in `GraphControls.tsx`. Turning it off clears any
  in-progress trace (anchor/selection/path/animation).

### B2. Start → end selection (reuse existing path machinery)
- When `traceMode` is on, intercept `handleNodeClick` (`PageGraph.tsx:258`):
  - No start yet → set start (`pathAnchor`) and DO NOT push a focus frame / open
    the inspector.
  - Start set, different node clicked → set end (`selected`), which drives the
    existing shortest-path effect (`PageGraph.tsx:859-881`) → `pathRef` →
    `pushStyle()`.
  - Clicking the same node or empty space → reset the trace start.
- Plain (non-trace) clicks keep today's focus + inspector behaviour untouched.

### B3. Animated traversal (pulse)
- Extend the scene with a trace animation over the path node sequence
  (positions already available in the scene).
- New scene method `setTrace(pathNodes: string[] | null)`: stores the ordered
  path and (re)starts the animation; `null` stops and hides the pulse.
  `PageGraph` calls it from the path effect alongside `pushStyle`.
- Animation, driven in the existing render loop (tick):
  - A single small bright pulse marker (a dedicated `THREE.Points` of size 1, or a
    tiny sphere) interpolates along consecutive path-node segments at constant
    speed, looping start→end while the trace is active.
  - Path hops light sequentially as the pulse passes / progressively; reuse the
    filament "isPath" brightening (`refreshFilamentTargets`,
    `graphScene.ts:1210-1232`) as the lit baseline, with the pulse as the moving
    accent on top.
  - Pulse colour: the start node's colour (consistent with A2's source-colour
    theme), or white if unavailable.
- Cleanup: dispose/hide the pulse object on `setTrace(null)`, trace toggle-off,
  graph rebuild, and GL restore.

## i18n
Add keys in `src/lib/i18n.ts` for all three locales (`en`/`ko`/`ja`):
- `gr_arrow_size` — arrow-size slider label (e.g. "Arrow size" / "화살표 크기" /
  "矢印サイズ").
- `gr_trace` — Trace toggle label (e.g. "Trace path" / "경로 추적" / "経路トレース").

## Error handling
- `writeArrows` per-instance colour: if a source node has no `color` attr, fall
  back to the previous shared highlight colour — never throw in the render loop.
- Trace: if `shortestPath` returns null (disconnected), clear the trace and show
  nothing (existing effect already nulls `pathRef` on invalid pairs).
- Pulse animation must no-op safely when `pathNodes` has < 2 entries.

## Testing / verification
Playwright against the dev mock graph (`?mock=1`), same harness as
`scripts/capture-shots.mjs`:
1. Arrows: enable arrows + set a mid arrow-size; screenshot; assert arrows render
   small and not uniformly white (sample instance colours differ from pure white).
2. Trace: toggle Trace on; click two connected nodes; assert a path is set
   (filament/path state present) and the pulse object exists/animates (assert the
   scene reports an active trace); screenshot the lit path.
3. Toggle Trace off → assert path + pulse cleared.
4. Regression: with Trace off, a plain node click still opens the inspector /
   pushes focus (unchanged).
5. `tsc -b`, `eslint`, `vitest run` all clean (no NEW warnings vs main).

Manual visual pass for the glow/colour aesthetics and animation smoothness, since
those don't assert well headlessly.
