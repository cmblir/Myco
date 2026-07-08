# Graph Spaceship Mode + Vivid Cluster Colours + Arrow Size — Design

Date: 2026-07-08
Scope: `app/` galaxy graph — `src/lib/graphScene.ts`, `src/lib/graphSettings.ts`,
`src/lib/nebulaLayer.ts`, `src/lib/dustLayer.ts` (new), `src/pages/PageGraph.tsx`,
`src/components/GraphControls.tsx`, `src/lib/i18n.ts`.

## Goals

1. Arrow size: bigger range, default 1 (was 0.35).
2. Community colours read more vividly out of the box (stronger nebula clouds).
3. A "spaceship" free-fly mode to roam the 3D universe, with: 6DOF flight,
   docking onto a node, dust motes orbiting nodes, and the existing gas clouds
   visible while flying.

## A. Arrow size

- `GraphSettings.arrowSize` default `0.35` → `1`.
- `GraphControls` arrow-size slider `max` `1.5` → `3` (min 0.1, step 0.05).

## B. Vivid cluster colours (default)

The colored gas is the `NebulaLayer`; its sprite opacity is very faint today.
- `nebulaLayer.ts`: `COMMUNITY_OPACITY` `0.05` → `0.12`, `HALO_OPACITY` `0.05` →
  `0.10`.
- `GraphSettings.brightness` default `0.85` → `0.9` (slight exposure lift; still
  slider-adjustable, range unchanged).
- Unchanged: nebula only renders in the dark theme and below the perf-LOD node
  cap (large vaults keep it off for perf). Colours there still come from nodes.

## C. Spaceship mode

Transient (not persisted): a fly camera the user toggles on to roam.

### C1. Free-fly (FlyControls)
- Import `FlyControls` from `three/examples/jsm/controls/FlyControls.js` (mirrors
  the OrbitControls import).
- `GraphScene.setFlyMode(on)`:
  - ON: construct FlyControls on the camera + canvas — `movementSpeed` scaled to
    the scene (~600), `rollSpeed ≈ 0.6`, `dragToLook = true` (hold-drag to steer,
    no pointer-lock). Set `controls.enabled = false` (OrbitControls off),
    `autoRotate = false`, and suppress node-drag / hover-pick while flying.
  - OFF: `flyControls.dispose()` (releases its key listeners), re-enable
    OrbitControls with `controls.target` re-derived from the current camera
    heading so the orbit pivot is sensible, keep the camera where it is.
- Render loop: when fly mode is on, `flyControls.update(dt)` instead of
  `controls.update()`.
- Shift = boost: a keydown/keyup listener multiplies `movementSpeed` (×3) while
  Shift is held.
- FlyControls brings its own WASD/RF/QE/arrow key handling; we do not hand-roll
  movement. Its listeners exist only while the controls object exists (created on
  enter, disposed on exit) so keys never leak into the search box.

### C2. Docking onto a node ("안착")
- In fly mode, a plain click (pointer-up with no drag) raycasts the node under the
  cursor. If hit: ease the camera to a close stand-off point facing that node and
  hold a slow orbit around it (docked) — reuse the existing camera-ease used by
  `focusNode`/`fit`. Docking temporarily pauses FlyControls input.
- Undock: click empty space, or press F/Esc → resume free-fly from the docked
  position.
- A small on-canvas hint ("Docked: <node>" / controls legend) via PageGraph state.

### C3. Dust motes orbiting nodes
- New `src/lib/dustLayer.ts`: one `THREE.Points` cloud of a capped pool
  (`MAX_MOTES ≈ 3000`). Motes are distributed across the largest nodes (weighted
  by node size), each assigned an orbit radius (a small multiple of the node's
  radius), an angle and a slow angular speed, plus a phase for twinkle.
  `update(dt)` advances each mote around its node (reads live node position) and
  writes position + a dim, node-coloured, size-varying point. Additive, tiny
  `gl_PointSize`.
- Visible only in fly mode (the up-close view where motes read); hidden and not
  updated otherwise. Constructed with the scene, re-seeded on rebuild.

### C4. Gas clouds while flying
- The nebula (boosted in B) is scene-level and already renders every frame, so it
  is visible while flying — no extra work. Flying into a cloud gives volume.

### C5. Entry / exit + UI
- `PageGraph` `flyMode` React state (like `traceMode`), passed to
  `scene.setFlyMode`.
- `GraphControls`: a "Spaceship" toggle in the Display section.
- Window `keydown`: `F` toggles fly mode, `Esc` exits (docked → fly → off).
  Ignored while a text input/textarea is focused (search box) so typing "f" works.
- Fly mode force-clears any active Trace (they own the same camera/interaction).

## i18n
Add for en/ko/ja: `gr_spaceship` ("Spaceship" / "우주선 비행" / "宇宙船"),
`gr_spaceship_hint` (controls summary, e.g. "WASD fly · drag to steer · click a
node to dock · Esc exit").

## Error handling
- FlyControls dispose must be idempotent + null-guarded (double toggle, unmount,
  GL restore). On GL restore / rebuild, drop fly mode cleanly.
- Dust `update` no-ops when hidden or pool empty; never throws in the loop.
- Docking ease must abort safely if the target node disappears (rebuild).

## Testing / verification
Playwright on the mock graph (`?mock=1`):
1. `Spaceship` toggle present; toggling sets the mode (assert a scene flag /
   controls state) and back off without error.
2. Arrow-size slider max is 3; setting it larger renders bigger arrows.
3. Nebula: screenshot with defaults shows coloured clouds (sample non-black,
   non-white coloured pixels present).
4. Dust layer object exists and is visible only in fly mode.
5. Regression: `tsc -b`, `eslint`, `vitest run` clean; existing 60 tests pass.

Fly navigation, docking feel, and mote/cloud aesthetics are confirmed live (they
don't assert well headlessly) — the harness verifies wiring + toggles + no
crash, and unit-tests the dust orbit math where extractable.
