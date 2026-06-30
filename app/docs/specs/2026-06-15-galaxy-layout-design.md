# Galaxy Layout — Design Spec

- **Date:** 2026-06-15
- **Status:** superseded
- **Superseded by:** [[2026-06-27-cosmic-web-graph]]
- **Scope:** Replace the force-directed 3D graph layout with a deterministic
  procedural spiral-galaxy placement, so the universe graph actually reads as a
  galaxy (flat disk, bright bulge core, log-spiral arms, sparse halo).

> [!warning] Superseded — never implemented
> This procedural-spiral direction was approved but never built (no
> `galaxyLayout.ts` exists; `createSim` remained force-based). It was reversed on
> 2026-06-27: a node+edge graph is intrinsically cosmic-web-shaped, so the
> force layout is kept and only the rendering is improved. See
> [[2026-06-27-cosmic-web-graph]]. `graphSim.ts` is the canonical layout and must
> NOT be deleted. Retained below for historical context only.

## Problem

The current 3D view (`graphScene.ts` + `graphSim.ts`) runs a `d3-force-3d`
simulation with uniform Barnes-Hut repulsion and **equal** center gravity on all
three axes (`forceX`/`forceY`/`forceZ` at the same strength,
`graphSim.ts:44-48`). That settles into a roughly **spherical blob**, never a
disk and never spiral arms. The face-on camera (`graphScene.ts:195`,
`position.set(0,0,900)`) flattens the sphere into a round splat. No per-node
date/time attribute exists (the `2023.07`-style labels are just hub filenames),
so a time-driven spiral cannot generalize.

## Decisions (locked)

1. **Galaxy form:** procedural spiral (most galaxy-like). Node position is
   computed analytically from per-node metrics — it is decorative and no longer
   encodes force relationships.
2. **Sim coexistence:** full replacement. The physics sim is removed; the galaxy
   layout is computed once (static). Timelapse and live-ingest are reinterpreted
   (see below); drag moves only the dragged star with no propagation.
3. **Arm layout:** **communities are beads on a few arms.** 2–4 log-spiral arms;
   each Louvain community is laid down as one local clump (hub + its leaves
   together) along an arm. Big communities sit inner (near the bulge), small ones
   outer. This keeps edges short instead of stretching across the galaxy.

## Architecture

Drop-in replacement that preserves the `GraphSim` interface so `PageGraph.tsx`
call sites barely change.

```
graphData.ts      → store Louvain community id per node (currently only color)
galaxyLayout.ts   → NEW. createGalaxy(graph, s, onTick): GraphSim.
                    Computes x/y/z once; implements the GraphSim interface.
PageGraph.tsx     → swap import: createSim → createGalaxy (one line)
graphScene.ts     → camera tilt + stronger core bloom
graphSettings.ts  → replace the "Forces" slider group with a "Galaxy" group
GraphControls.tsx → render the Galaxy sliders instead of the Forces sliders
```

### Module: `galaxyLayout.ts`

Public function `createGalaxy(graph, s, onTick)` returns an object implementing
the existing `GraphSim` interface (`nodes`, `sim`, `reheat`, `update`,
`timelapseReset`, `timelapseReveal`, `timelapseSettle`, `liveAdd`, `stop`). It is
NOT a physics sim — `sim` is a thin shim (or the field is dropped if PageGraph
does not read it directly; verify during planning).

All randomness is **deterministic**: seed from a hash of the node id, reusing the
existing `seededXYZ` hashing pattern in `graphData.ts`. `Math.random` is
unavailable in the sandbox and would break reproducibility.

## Layout math

Inputs: the graphology graph (each node has `deg`, `size`, and a `community` id
after the graphData change), plus `GraphSettings` (`armCount`, `spiralTightness`,
`diskThickness`, `coreSize`). The overall galaxy radius is NOT a slider — it is
derived from node count (a constant scale factor × √nodeCount) so the disk
auto-sizes to the vault and the camera framing stays stable.

1. **Group by community.** Reuse Louvain (already run in
   `colorByCommunity`). Sort communities by size descending → `rank`.
2. **Assign arms.** `arm = rank % armCount`. Lay communities along their arm from
   inner to outer by `rank` (largest community innermost).
3. **Log-spiral curve.** For arm `a` of `A`: base angle `θ0 = a · 2π / A`. At
   radius `r`, `θ(r) = θ0 + b · ln(r / r0)` where `b = spiralTightness`. The
   community clump center is `(r_c·cosθ, r_c·sinθ)`.
4. **Community clump (the bead).** The highest-degree node (hub) sits at the clump
   center. Leaves scatter on a local disk of radius `∝ √(communitySize)` around
   it (seeded). Hub + leaves stay together → short edges.
5. **Disk thickness (z).** `z = seededGaussian · diskThickness`, slightly thicker
   near the center (bulge). z extent ≪ radial extent → flat disk.
6. **Central bulge.** The rank-0 (largest) community is placed at `r ≈ 0`, dense,
   so the core glows under bloom.
7. **Halo.** Orphans (`deg 0`) scatter sparsely on a wide, thin disk out to
   ~1.5× the galaxy radius. They keep their existing dim color (field stars).

## Interface reinterpretation (physics → static)

| `GraphSim` method   | New behavior                                                                                     |
|---------------------|--------------------------------------------------------------------------------------------------|
| construction        | compute all coordinates once → fire `onTick` once so the scene renders                           |
| `reheat`            | no-op (or a single recompute + render)                                                           |
| `update`            | recompute layout from changed Galaxy settings, then render                                       |
| `timelapseReveal`   | reveal nodes at their **final** galaxy coordinates in age order (mtime); arms appear to draw inner→outer via a rAF fade/grow — no physics |
| `timelapseReset`    | hide all nodes; clear the revealed set                                                           |
| `timelapseSettle`   | reveal complete — stop the rAF loop                                                              |
| `liveAdd`           | place new nodes in their community clump, then `scene.rebuild()`                                 |
| drag (in scene)     | move only the dragged star; no neighbor propagation                                              |

## Rendering (`graphScene.ts`)

- **Camera:** tilt ~25° off face-on so the disk reads with depth (e.g. raise the
  camera off the disk plane and `lookAt` origin). Keep idle auto-rotate, but
  rotate about the disk's normal axis so the spiral spins in-plane.
- **Bloom:** strengthen the core glow (`UnrealBloomPass` already present, wired to
  `brightness`); the dense rank-0 bulge should bloom brightest.
- **Colors:** keep community hues — the beads read as colored star-forming regions.

## Settings (`graphSettings.ts`)

The Forces group (`repelForce`, `centerForce`, `linkForce`, `linkDistance`) is
meaningless under static placement. Replace it with a **Galaxy** group:

- `armCount` — integer 2–4, default **2** (most recognizable spiral silhouette)
- `spiralTightness` — the `b` winding coefficient
- `diskThickness` — z spread
- `coreSize` — bulge radius

Bump the persisted settings key (`v21` → `v22`); old slider values reset.
`GraphControls.tsx` renders the new sliders in place of the Forces sliders.

## Trade-offs / impact

- Force sliders removed → persisted-settings key bump required.
- Node position no longer reflects connection structure (consequence of the
  procedural choice; agreed).
- Timelapse changes character: "explode from center" → "arms draw outward."
- `graphSim.ts` becomes dead once `galaxyLayout.ts` lands — report it; delete only
  after confirming no other importer (`App.tsx`, `IngestMiniGraph.tsx` reference
  check during planning).

## Success criteria

- The default view renders as a recognizable spiral galaxy: flat tilted disk,
  bright central bulge, 2 visible arms of colored community clumps, sparse halo.
- Layout is deterministic across runs (same vault → same galaxy).
- Timelapse plays as arms drawing outward in age order without physics jitter.
- Live-ingest places a new note into its community clump without re-shuffling the
  whole galaxy.
- Drag moves a single star; the rest of the galaxy is unaffected.
- `tsc -b && vite build` passes; the .dmg builds.
