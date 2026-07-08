# Immersive Spaceship Mode + Graph Layout Fixes — Design

Date: 2026-07-08
Scope: `app/` graph — `src/lib/graphScene.ts`, `src/lib/shipController.ts` (new),
`src/lib/nebulaLayer.ts`, `src/pages/PageGraph.tsx`,
`src/components/GraphControls.tsx`, `src/components/ShipHud.tsx` (new),
`src/styles.css`, `src/lib/i18n.ts`.

Supersedes the previous FlyControls-based "Spaceship" toggle
(2026-07-08-graph-spaceship-design.md).

## Problems

1. The graph page overflows its scroll container, so a right-side scrollbar
   appears; arrow keys scroll it (worse while flying, where arrows also steer).
2. On large vaults (perf-LOD, e.g. the 10k demo) the community gas clouds don't
   render at all — nebula is gated behind `!perfLod`, so colours look absent.
3. The current fly mode is a bare first-person camera. The intended experience is
   immersive: enter the universe fullscreen, a spaceship model in front, fly it
   third-person (Google-Earth/game feel), click a node to see its info beside the
   ship.

## Part 1 — Layout fixes

### 1a. No scrollbar, fit the viewport
- The graph page (`.workspace-wide` holding `.graph-shell`) should fill the
  viewport height and not overflow `main`. Make the graph page a flex column with
  a fixed header and a `.graph-body` that flexes to fill remaining height, and
  ensure the page container itself doesn't exceed `100vh` (no vertical scroll).
  Replace the brittle `height: calc(100vh - 280px)` with flex fill + a `min-height`
  floor. Confirm no page scrollbar at common window sizes.

### 1b. Arrow keys don't scroll
- While in spaceship mode, `preventDefault()` on Arrow keys, Space, and
  Page/Home/End in the keydown handler so the browser never scrolls the page from
  flight input.

## Part 2 — Nebula on large vaults
- `nebulaLayer` is only 8 community sprites + 1 halo — negligible regardless of
  node count. Drop the `!perfLod` gate: enabled = `dark && SHOW_NEBULA` at
  construction (matching `applyTheme`, which already omits perfLod). Colored gas
  clouds then render on the 10k vault too.

## Part 3 — Immersive spaceship mode

Replaces the FlyControls toggle. Transient (not persisted).

### 3a. Fullscreen overlay
- Entering spaceship mode adds an app-fullscreen class so the graph canvas covers
  the sidebar, header, and settings panel (fixed, inset 0, top z-index). Esc /
  toggle-off exits back to the normal graph view. Implemented in-app (a CSS class
  on a top-level graph container + `position: fixed; inset: 0`), not the OS
  Fullscreen API.

### 3b. Procedural ship + third-person chase (`shipController.ts`)
- A new `ShipController` owns:
  - A procedural stylized ship `THREE.Group` (fuselage cone + two wings + a glowing
    engine sprite/point), built from primitives — no external asset. Added to the
    scene; a subtle idle bob.
  - A chase rig: the ship has a position + orientation quaternion (heading). Each
    frame the camera sits at `ship.position + offset` (behind + slightly above),
    rotated by the ship's quaternion, looking ahead of the ship. So the ship stays
    centred-in-front and the world (nodes) flows past — the Google-Earth/game feel.
  - Controls: `W/S` thrust fwd/back, `A/D` strafe, `R/F` (or `Space`/`Shift-Space`)
    up/down, `Q/E` roll, mouse drag = yaw/pitch the heading, `Shift` = boost.
    `movementSpeed` scaled to the graph extent.
  - `enable()/disable()`, `update(dt)`, `dispose()`. Its key/pointer listeners
    live only while enabled (created on enter, removed on exit) so nothing leaks
    into the search box or normal orbit.
- While active: OrbitControls disabled, autoRotate off, hover/node-drag suppressed
  (as the old fly mode did). Dust motes shown; nebula + edges give depth.

### 3c. Node info beside the ship (`ShipHud.tsx`)
- A HUD panel pinned to one side of the fullscreen overlay. Clicking a node (a
  stationary click; drags steer) raycasts it and opens the panel with that node's
  info — reuse the data `GraphInspector` shows (title, kind, link count,
  neighbours, snippet). Close button + click-empty clears it. The panel is the
  replacement for the earlier "dock/orbit" idea.
- A small controls legend (WASD/mouse/Esc) shown in a corner of the overlay.

### 3d. Entry / exit + UI
- `PageGraph` `flyMode` React state drives `scene.setFlyMode(on)` and the overlay
  class. `GraphControls` keeps the "Spaceship" toggle (its hint updated). `F`
  toggles, `Esc` exits (ignored while typing in an input). Selecting a node in
  fly mode routes to `ShipHud` state instead of the normal inspector/focus.
- Fly mode clears any active Trace (shared camera).

## i18n
Update `gr_spaceship_hint`; add HUD strings if needed (reuse existing inspector
labels where possible), en/ko/ja.

## Error handling
- ShipController dispose idempotent + null-guarded (double toggle, unmount, GL
  restore). Drop fly mode cleanly on GL rebuild; ship re-created with the fresh
  scene when re-entering.
- Ship mesh + dust disposed on scene dispose.
- Node-info raycast tolerant of a missing/removed node (rebuild) — clear the HUD.

## Testing / verification
Playwright on the mock graph (`?mock=1`) + the 10k stress mock (`?mock=1&stress=…`
if available):
1. No page scrollbar in the normal graph view (documentElement scroll height ≤
   client height); arrow keys don't scroll.
2. Nebula: on a large (perf-LOD) graph, coloured cloud sprites are present
   (assert the nebula group has visible sprites / sample coloured pixels).
3. Spaceship: toggle → fullscreen overlay covers the chrome; a ship mesh exists in
   the scene; `W` moves the view; clicking a node opens the HUD info panel with
   its title; `Esc` exits and restores the normal layout.
4. `tsc -b`, `eslint`, `vitest run` clean; existing 63 tests pass; add unit tests
   for any extractable ShipController math (e.g. chase-cam offset, thrust
   integration).

Flight feel, ship look, and cloud aesthetics confirmed live.
