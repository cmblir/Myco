# Graph Subsystem Analysis & Ranked Proposals

_Generated 2026-07-13 via parallel multi-agent review (5 dimensions → synthesis), verified against source._

I've verified enough. Key corrections to the findings: the swirlTick O(n) centroid recompute-per-frame is real (lines 1620-1634, rebuilt every call, no caching). `applyPositions` (1832) already length-clamps so the liveAdd "stale index" write is bounded but the stale-attribute-cache issue is real. `syncBack` (686) is already bounded. `nodeColor`/`monoBelow` are live, not dead. Here is my ranked proposal.

---

# Memex Graph Subsystem — Ranked Improvement Proposal

I de-duplicated the 47 findings (they collapse to ~22 distinct items), verified the load-bearing claims against the actual code, and dropped or corrected several that were factually wrong. **Corrections up front, because they change the ranking:**

- **`nodeColor`/`monoBelow` are NOT dead code.** The "unused settings" finding (debt) is wrong — they're read at `graphScene.ts:216-219` (`monoFor`). Do not delete them.
- **`syncBack` truncation "bug" is already guarded.** `graphSim.worker.ts:686` loop condition is `i < ns.length && i*3+2 < p.length` — the buffer read cannot overrun. The "high impact correctness" rating is overblown; it's a cosmetic hardening at most.
- **`applyPositions` already clamps** (`graphScene.ts:1832`, `pos.subarray(0, nArr.length)`), so the liveAdd "writes to wrong index / overruns" framing is wrong. The *real* liveAdd bug is different (stale degree/size caches — see C1).
- The five separate "extract a class" architecture findings (renderer/interaction/postprocessor/FXregistry/callback-inversion) are all real but are **the same debt** viewed from five angles. I merged them and ranked the whole cluster honestly as one large, deferrable effort.

The organizing principle you asked for — **stop the recurring layout churn** — points to one root cause: layout parameters are hardcoded across the worker AND the scene independently, with no shared source of truth and no way to see what the sim actually settled to. That is why every tuning pass ("dandelion field", "distinct puffs", "don't fake galaxies") required editing 3+ files and eyeballing the result. Fixing that (A1) is the single highest-leverage move and I've ranked it first among architecture despite the effort.

---

## (1) Correctness fixes

### C1 — liveAdd leaves node degree/size/colour caches stale · impact: high · effort: medium
When a new edge connects an existing node, that node's degree changes in the sim but the scene's size/intensity/colour attributes aren't recomputed until a full rebuild — hubs render at the wrong size mid-ingest. (Merged: "Live-ingest degree tracking" + "Liveadd position race" — the position race itself is a non-issue since `applyPositions` clamps, but the *attribute* staleness is genuine.)
**First step:** In the `liveAdd` path (`PageGraph.tsx:894-895`), after `sim.liveAdd`, collect the set of touched existing node ids and call a scoped `scene.refreshStyleFor(ids)` before `scene.rebuild()`. Write a failing test: add an edge to a deg-1 node, assert its rendered size attribute grows.

### C2 — `nodeColor='auto'` monochrome threshold never re-evaluates on ingest · impact: medium · effort: small
`monoFor` (`graphScene.ts:216-219`) computes `u_mono` from `nodeCount < monoBelow` only at init/theme change. A vault that grows past `monoBelow` via live-ingest keeps the stale uniform — new nodes coloured, old ones mono (or vice-versa).
**First step:** In `rebuild()` (`graphScene.ts:1873`), recompute `u_mono` via `monoFor(this.settings, this.nodeIds.length)` and assign to `nodeMat.uniforms.u_mono`.

### C3 — greedy galaxy packing can silently fail to place a cluster · impact: medium · effort: small
`galaxyAnchorsBySize` has a hardcoded 400-iteration cap (`galaxyLayout.ts`); on pathological inputs (100+ clusters, or 1 huge + many tiny) it can return a bad/origin position with no signal — clusters pile at the center.
**First step:** Add a fallback: if the loop exhausts iterations, place the anchor on an outward ray at `maxRadius * 1.5` and `console.warn` with the cluster id. Add a unit test with synthetic `{1 huge, 80 tiny}` counts.

### C4 — degenerate-vault community handling is untested · impact: medium · effort: small
Edgeless / single-node / all-orphan / all-2-member-community vaults flow through `colorByCommunity` + `buildLegend` with implicit defaults. Behaviour is probably correct but unverified, and `folderGroups` returning `null` for `<2` clusters (the flat-90%-folder case) silently changes the felt layout.
**First step:** Add unit tests for the 4 degenerate inputs asserting no throw and white-monochrome fallback. Separately, get a one-line spec decision from the user: *should a flat single-folder vault with 50 Louvain topics get per-topic anchors, yes or no?* — this is currently ambiguous and drives layout churn.

*(Dropped: syncBack truncation — already guarded. Deprioritized to notes: edge hidden-status cache staleness, edge-length falloff mid-slider glitch, LOD centroid stale snap, filament ghost-edge — all real but 1-frame cosmetic glitches during interaction, impact low.)*

---

## (2) Performance

### P1 — `swirlTick` recomputes all cluster centroids every frame · impact: high · effort: medium
**Verified:** `graphScene.ts:1620-1634` allocates 4 `Map`s and does a full O(n) node iteration to sum centroids *on every frame* the galaxy spin is on, at 11k nodes = ~44k ops/frame that produce a near-identical result each time. This is the biggest gratuitous per-frame cost.
**First step:** Cache `cx/cy/cz/cn` as instance fields; recompute only when `sim.alpha()` is above a small epsilon or on a slow cadence (every ~15 frames, matching the existing `lodCents` pattern at 1697). Reuse between frames when static.

### P2 — per-frame edge geometry rebuild + buffer reallocation · impact: high · effort: medium
`writeEdgeGeometry` runs every `applyPositions` (`graphScene.ts:1844`) at O(edges) with sqrt+cross per edge; `updateFilaments` reallocates `pos/col` Float32Arrays every visible frame. At ~15-20k edges this dominates the main thread once the sim settles.
**First step:** Pre-allocate filament buffers once and reuse. Then gate the full edge rebuild behind an "any node moved > epsilon" check driven by `sim.alpha()` — when settled, skip it entirely.

### P3 — collapse the 12-layer per-frame FX update fan-out · impact: medium · effort: small
The render loop unconditionally ticks pulse/wave/nova/synapse/dust/meteor/coreGlow/cosmic/band/imposter/arrows every frame; several of those (coreGlow/band/imposter) are *disabled but still ticked* (`graphScene.ts:2349-2352`). Also `animateArrows` does 2× `graph.getNodeAttributes` Map lookups per edge per frame.
**First step:** Skip `update()`/`refresh()` for disabled layers (guard is trivial once D1 lands). In `animateArrows`, snapshot node positions into a flat array once per frame and index by edge pair instead of calling the graphology API per edge.

### P4 — runtime FPS-adaptive layer gating · impact: medium · effort: medium
`perfLod` gates ambient layers only at build time (≥5000 nodes). A 4.5k-node vault that drops to 30fps under GC/GPU contention keeps everything running.
**First step:** Add a 10-frame `dt` moving average; when avg > 20ms, fade and disable non-critical layers (pulse/meteor/synapse); re-enable after 2s under 16ms. Small, self-contained, big resilience win.

### P5 — cap worker→main tick queue to 1 pending · impact: medium · effort: small
The worker posts every tick (33ms throttle); a slow main-thread frame lets 3-4 position buffers queue up, wasting memory and delaying the flush. Only the latest matters.
**First step:** In the worker, skip posting if the previous post is unacknowledged (drop-oldest). Add an ack flag flipped on the main thread's `onTick`.

*(Merged into above / deprioritized: bloom downscale (P: small, do opportunistically with P4), `moonHosts` first-frame O(orphans×n) — precompute in constructor, trivial; `updateLabels`/`pickNode` throttling — low impact, defer.)*

---

## (3) Architecture / debt cleanup

### A1 — single source of truth for layout params + `layoutMetrics` readback · impact: high · effort: medium · **THIS IS THE CHURN FIX**
The recurring layout thrash comes from parameters (`REPEL_SCALE`, `CLUSTER_SCALE`, `ORBIT_BASE/GROW`, `INTER_LINK_DIST_MUL`, greedy-pack radii) being hardcoded **independently** in `graphSim.worker.ts` AND mirrored geometrically in `galaxyLayout.ts` + the scene's centroid/label code. There is no way to see what the sim *actually settled to*, so every visual tweak is edit-3-files-and-eyeball.
**First step:** (a) Define a `LayoutConfig` interface, pass it in the worker `init` message instead of hardcoding. (b) Add a `layoutMetrics` message (worker→main) reporting settled cluster centers + orbit radii. Wire `clusterLabels`/nebula to consume those instead of recomputing. This makes tuning data-driven and testable without rebuilding the vault, and eliminates the sim/render centroid divergence that makes labels drift off their clumps. Do this **before** any of the layout-feel UX features (F-series) — they all depend on it.

### A2 — remove dead disabled-galaxy layers (imposter / coreGlow / band) · impact: high · effort: large
`GalaxyImposterLayer` (~223 lines), `CoreGlowLayer` (~150), `GalacticBandLayer` (~216) are constructed, added to the scene, and *ticked every frame* (`graphScene.ts:901-910, 2349-2352`) but permanently disabled by the "don't fake galaxies" pivot. ~590 lines of dead shader code + wasted GPU. This is the single biggest debt-reduction win and also unblocks P3.
**First step:** Confirm with the user this is a permanent decision (memory says the pivot is intentional). If yes: delete the three files + imports + instantiation + tick/dispose/setNodeIds wiring. Consolidate the 4 duplicate centroid implementations (finding: `graphScene:1756`, imposter, band, `clusterLabels`) into one `computeCommunityCentroids` util *as part of the same PR* — three of the four callers disappear with the layers, and the util then serves clusterLabels + A1's metrics. **Effort is large only because of the tick/dispose plumbing — the deletion itself is safe.**

### A3 — introduce an explicit `LayerConfig` gate (instead of scattered `.visible=false`) · impact: low→medium · effort: small
Even after A2, the enable/disable decision for any future layer is sprinkled `.visible` writes. A construction-time `LayerConfig` (only instantiate + tick enabled layers) makes the "no fake galaxies" decision explicit and reversible, and is the clean mechanism P3 needs.
**First step:** Add `LayerConfig` to the scene constructor; gate instantiation and the tick loop on it. Small, and pairs naturally with A2.

### A4 — the "extract classes" refactor cluster (Renderer / Interaction / PostProcessor / FXRegistry / callback inversion) · impact: high (maintainability) · effort: large · **DEFER**
The five architecture findings all describe real coupling in the 2643-line `graphScene.ts`: rendering + interaction + FX orchestration in one file, bidirectional scene↔PageGraph callbacks, two coexisting bloom paths, `glEpoch` proxy hiding rebuild ordering. **Honest assessment:** this is a genuine multi-week refactor with high regression risk on a subsystem that has no visual test coverage. It will NOT stop the layout churn (A1 does that) and it's not blocking any feature. **Recommendation: do not start it now.** Land A1+A2+A3 first (they shrink the file ~600 lines and remove the worst coupling for free), re-measure, and only then decide if the residual justifies the risk. If pursued, the highest-value single slice is extracting `PostProcessor` (the two-bloom-path branch) — it's self-contained and testable.

*(Corrected/dropped debt items: `nodeColor`/`monoBelow` are LIVE — keep. `zoomFromProximity` dead export — real, 4-line delete, trivial, fold into A2's cleanup. `cosmicScale` HUD — keep, harmless. `folderGalaxies` "only used for spin" — misleading; it does gate spin, but verify the anchor-force path before touching, part of A1.)*

---

## (4) UX / aesthetic features

These deliver the "make my vault feel like X" experience the user keeps chasing manually. **All of them are cheap once A1 lands; several are near-worthless before it** because they'd just be more hardcoded knobs.

### F1 — Aesthetic presets (skin + nodeColor + ambience bundles) · impact: high · effort: medium
Three orthogonal dials (skin, nodeColor, folderGalaxies/ambience) with no coherent mental model. Bundle them: `dark-cosmic`, `white-academic`, `mesh`. Presets as springboards, sliders still editable. Directly addresses the "white mode looks broken" (washed pastel on paper) discovery gap — a `white-academic` preset auto-sets `skin:white + nodeColor:white`.
**First step:** Define an `AestheticPreset[]` in `graphSettings.ts`; render preset chips above the existing sliders in GraphControls, reusing the existing `matchPreset()` highlight pattern.

### F2 — inter-cluster spacing + jitter controls (the "lumpy vs tidy" axis) · impact: high · effort: small (after A1) / medium (before)
`clusterForce` is a single scalar for intra-cluster tightness; there's no control for *inter*-cluster spacing (`INTER_LINK_DIST_MUL` hardcoded 1.8) or boundary sharpness (`edgeJitter` seeded but unexposed). This is exactly the axis every recent layout commit was hand-tuning.
**First step:** Once A1 exposes `LayoutConfig`, add `clusterSpacing` [0.5–2.0] → `INTER_LINK_DIST_MUL` and `clusterJitter` [0–1] → jitter spread as sliders. **Do not build this before A1** or you re-hardcode the churn.

### F3 — `ambientDetail` mode (calm / cosmic / majestic) · impact: medium · effort: small
Users can't say "full cosmic ambience on a 3k vault" or "dial down on 2k". `ambientDetail` [0/1/2] overrides the build-time perfLod gate for starfield/nebula/meteors.
**First step:** Add the setting; thread it into the existing perfLod layer-gating checks as an override. Pairs with P4's runtime monitor.

### F4 — `labelDensity` (saturation) distinct from `textFadeThreshold` (zoom reveal) · impact: medium · effort: small
Two different concerns are conflated. Add `labelDensity` [0.2–2.0] multiplying the hardcoded 0.5 sigma-density, keeping `textFadeThreshold` for zoom emergence.
**First step:** Thread `labelDensity` into `clusterLabels`/label candidate selection.

### F5 — visual-hierarchy knobs: `hubEmphasis`, `clusterColorSaturation` · impact: medium · effort: medium
Expose existing-but-hardcoded shader/color constants (hub `a_intensity` amp 0.35; `shadeHex` saturation 0.62) as sliders.
**First step:** Add uniforms + settings; thread into `NODE_VERT` and `shadeHex`.

### F6 — "Presence" display presets (minimal / balanced / luminous) · impact: medium · effort: small
Parallel to F1 but for brightness/nodeSize/linkThickness. Lower priority — mostly convenience over three existing sliders.

---

## Recommended sequence

1. **A1 (layout single-source-of-truth + metrics readback)** — stops the churn; unblocks F2/F3. Start here.
2. **P1 + P2** — the two verified per-frame hot paths; independent, ship anytime.
3. **A2 + A3 + zoomFromProximity delete** — one PR; removes ~600 lines and unblocks P3; needs user's "pivot is permanent" confirmation.
4. **C1, C2, C3, C4** — correctness batch with tests; small.
5. **P3, P4, P5** — perf resilience.
6. **F1 → F2 → F3** — the aesthetic-control payload users actually feel, now cheap.
7. **A4 (big class extraction)** — reassess after 1-6; likely still defer.

**One decision I need from the user before A1/C4:** for a flat vault where ~90% of notes sit in one folder, should each Louvain topic inside that folder become its own separated anchored clump (per-topic galaxies), or stay as one mass? Every layout commit in recent history flip-flopped on this implicitly. Pinning it down is what actually ends the churn.

**Files if you proceed:** layout SoT — `/Users/o/prj/karpathy/app/src/lib/graphSim.worker.ts`, `/Users/o/prj/karpathy/app/src/lib/galaxyLayout.ts`, `/Users/o/prj/karpathy/app/src/lib/graphSim.ts`; perf hot paths — `/Users/o/prj/karpathy/app/src/lib/graphScene.ts` (swirlTick 1619, applyPositions 1829, FX ticks ~2346); dead layers — `/Users/o/prj/karpathy/app/src/lib/{galaxyImposterLayer,coreGlowLayer,galacticBandLayer}.ts`; settings/UX — `/Users/o/prj/karpathy/app/src/lib/graphSettings.ts` + GraphControls in `/Users/o/prj/karpathy/app/src/pages/PageGraph.tsx`.