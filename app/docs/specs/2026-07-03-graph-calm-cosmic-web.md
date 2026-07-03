# Graph Visual & UX Overhaul — "Calm Cosmic Web"

- **Date:** 2026-07-03
- **Status:** approved (design), Phase 0 pending visual A/B verification
- **Extends:** [[2026-06-27-cosmic-web-graph]] (keeps its architecture; fixes its look)
- **Trigger:** real-vault screenshot review — the graph reads as **fireworks**
  (blown-white hub cores, equal-length colored spokes radiating from every
  cluster, flat depth, everything glowing at once), the opposite of the calm
  cosmic-web target.

> Design stance: brightness is *earned by density*, 80–90 % of the frame is dark
> void, and edges are connective tissue — never light sources.
> Reference anchors: cosmos.gl defaults (restraint), GitHub Globe (constraint
> aesthetics), Millennium-simulation renders (density→luminance), Obsidian
> graph (interaction economy).

## Diagnosis — the five-layer firework stack (verified against source)

Each layer has its own cap/threshold, but **no cap accounts for additive
blending summing luminance across overlapping primitives.**

1. **Filament overlay is the direct starburst** (`graphScene.ts` —
   `SHOW_FILAMENTS`, `FILAMENT_BASE 0.9`, 2.4 px, cap 1200, additive,
   `depthTest:false`). In a hub-and-spoke community essentially *every* edge is
   hub-incident, so the whole cluster renders as bright fat spokes. N spokes
   geometrically converge within a few px of the hub core: five overlaps ≈
   luminance 4.5 (3× the 1.6 bloom threshold); a 40-degree hub ≈ 36.
   UnrealBloom flares the region into a white disc; ACES desaturates it fully.
   White core + equal-length colored spokes = literal firework.
2. **Uniform `linkDistance 45` → equal-radius shell** (`graphSettings.ts`
   defaults; worker applies one distance to all intra-community links, and
   hub–leaf strength is constant — verify the exact worker formula during
   implementation). All leaves settle on one sphere shell around their hub;
   range-capped repulsion spaces them evenly on it → perfect dandelion
   geometry, which the filaments then paint as the brightest thing on screen.
   `clusterForce 0.5` compresses nuclei, making spokes read even more radial.
3. **Node HDR stack** (`graphData.ts`, `NODE_FRAG`): intensity
   `min(2.2, 0.35+pow(dn,1.4)*2.2)` + up to +0.5 from `source_count` (cap 2.4);
   fragment boost `base + base*core*(0.25 + v_int*1.4)` → hubs peak ≈ base×4.6,
   plus a white mix up to 0.45. Nodes are additive with `depthTest:false`, so a
   `clusterForce`-compressed nucleus exceeds the bloom threshold even without
   filaments. The code comment "field stars peak ~1.16 < threshold 1.6" is a
   *single-sprite* premise — two overlapping field stars (≈2.3) already break it.
4. **No luminance budget:** 12 saturated hues at once (above the 5–7
   recommended ceiling), starfield shells at 0.5/0.34/0.22 opacity (brighter
   than the dim edges — hierarchy inverted), 520 additive pulses, nebula
   sprites, ±7 % breathing, auto-rotate 0.35 — all on simultaneously.
5. **Depth cues missing:** `FogExp2 0.00005` is a no-op at scene scale; the
   node shader's fixed `u_fogNear 200 / u_fogFar 2600` ignores vault size;
   additive + `depthTest:false` removes occlusion ordering → flat.

## Design principles (all phases)

| Principle | Rule |
|---|---|
| **Luminance budget** | Only node cores may cross the bloom threshold. Edges, starfield, nebula, pulses must be structurally unable to. |
| **Void budget** | 80–90 % of the frame stays dark; light concentrates in cluster nuclei. |
| **Hierarchy** | Edges never brighter than nodes (exception: focused subgraph). |
| **Color budget** | ≤ 6 saturated hues at once; secondary elements desaturated. |
| **Motion budget** | State changes fade (no hard pops); idle motion slow and subtle. |
| **Encoding budget** | size=links, hue=community, dim=confidence, amber=disputed — nothing more, all explained by an in-canvas legend. |

## Phase 0 — today (constants only; commit after screenshot A/B)

| File | Change |
|---|---|
| `graphScene.ts` | `SHOW_FILAMENTS true → false` (single biggest cause; infra kept for the Phase 3 focus layer) |
| `graphScene.ts` | Bloom (dark): strength 0.9→0.45, radius 0.4→0.7, threshold 1.6→1.9 — **both** constructor and `applyTheme` (duplicated constants; extract to one helper) |
| `graphData.ts` | intensity `min(2.2, 0.35+pow(dn,1.4)*2.2)` → `min(1.7, 0.22+pow(dn,1.8)*1.5)`; source_count boost `min(0.5, sc*0.08)`→`min(0.3, sc*0.05)`, cap 2.4→1.8 |
| `graphScene.ts` | `NODE_FRAG` core boost `(0.25+v_int*1.4)` → `(0.2+v_int*0.9)`; white mix cap 0.45→0.28 (ACES already rolls highlights white — keep hubs *hot in their own hue*) |
| `graphSettings.ts` | default brightness 1→0.85; persisted KEY v24→v25 |
| `graphScene.ts` | `EDGE_BASE 0.32→0.22`; point-size clamp 340→180; starfield (dark) opacities 0.5/0.34/0.22→0.3/0.2/0.12, near shell size 2.0→1.6; autoRotate 0.35→0.12; breathing ±7 %→±2.5 % @0.6 Hz; fog density (dark) 0.00005→0.00012 |
| `graphSim.worker.ts` | intra-community link distance × deterministic per-edge jitter `(0.7 + 0.6·seededUnit(edge))` — one line, breaks the equal-radius shell, reload-stable |
| `pulseLayer.ts` | `MAX_PULSES 520→140`; pulse size clamp 22→14 |

## Track A — visual

- **A1 Bloom discipline.** Phase 0 recalibration (threshold-first tuning
  order). Phase 1: pre-tonemap luminance clamp in `NODE_FRAG`
  (`col = min(col, vec3(3.0))`) — the only structural defence against additive
  N-overlap. Phase 3: **selective bloom** (two composers + darkenNonBloomed;
  nodes on layer 1, edges/labels/starfield on layer 0) so edges become
  structurally bloom-proof; keep ACESFilmic + OutputPass order.
- **A2 Edge hierarchy.** Default edges: thin, `EDGE_BASE 0.22`, color = 50 %
  mix toward neutral `#8b93a8` (structure is grey; signal is nodes). Phase 1:
  split each edge at its midpoint (2 segments) → endpoint alpha fade
  (ends ×0.45, mid ×1.0, Holten-style) + a deterministic ~5 % perpendicular
  sag so spoke bundles read organic; add length-based alpha falloff
  (cosmos.gl `linkVisibilityDistanceRange` port). Hot-path cost: +6 floats per
  edge in `writePositions`/`applyPositions` — **profile at 10 k before/after**.
  Phase 3: filaments reborn as a **focus-only layer** — hover/selection
  incidents (width 2.0, base 0.7, cap 200) and `shortestPath()` results.
  Filaments read as filaments because they are *rare and faint*.
- **A3 Starburst dissolution (layout).** Phase 0 jitter; Phase 1: degree-based
  distance `dist ×= (1 + 0.18·log2(1+min(degS,degT)))` (hub–hub bridges long,
  leaf links short) and default `clusterForce 0.5→0.35` (v25).
- **A4 Depth.** Phase 1: dynamic fade — on `fit()`, set
  `u_fogNear = 0.35·framedDist`, `u_fogFar = 1.7·framedDist`,
  `fog.density = 0.55/framedDist` (ratio-stable across vault sizes; fog color
  == background exactly); add z-desaturation in `NODE_FRAG`
  (`mix(luma(col), col, 0.4+0.6·v_fade)`); `v_fade` floor 0.25→0.18. Phase 3:
  replace the 4 global nebula sprites with one large back-halo gradient sprite
  (GitHub-Globe back-glow pattern).
- **A5 Color discipline.** `PALETTE` 12→6 (`#6fb3ff #5fe0c0 #ffd27a #b58cff
  #ff9ec4 #ff9e6d`); only the 6 largest communities get hues, the rest go
  neutral `#9aa6c2` + kelvin variation (Millennium grammar: most matter is
  neutral, few regions colored). Keep kelvin tint 25 %, confidence dim, and
  disputed amber — legend (B1) must explain them.
- **A6 Node size/brightness redistribution.** Size → log scale
  `(0.85 + 1.6·log2(1+deg)/log2(1+maxDeg))` (hub ≈ 2.9× leaf, was 3.5×);
  brightness comes from *density of many faint stars*, not individual HDR
  (Bruno-Simon galaxy principle: low per-particle alpha × high count). Move the
  source_count boost from intensity to **size +8 %** (Phase 2) — the luminance
  channel is over-subscribed.
- **A7 Motion restraint.** Phase 0 budgets; Phase 2: pulses only on
  **inter-community bridge edges** (meaningful "signals between regions"),
  auto-rotate pauses on interaction and resumes after 8 s idle. NOTE: pulses
  and breathing are already gated by `prefers-reduced-motion` in `start()`
  (the render loop skips both) — only new motion needs the same gate. A single
  "Ambient motion" toggle (B4) bundles pulses+rotate+breathing.

## Track B — UX

- **B1 In-canvas legend** (new `GraphLegend.tsx`, bottom-left DOM overlay):
  top-6 community swatches (color + auto-label + count; click = isolate that
  community, click again = release) + a fixed 4-line encoding key (size /
  dim / amber / neutral). Collapsed by default < 768 px.
- **B2 Cluster auto-labels at rest** (new `clusterLabels.ts`, reuse
  nebulaLayer's centroid pass): CSS2D labels at community centroids, visible
  when camera > 0.6·framedDist, cross-fading to node labels on zoom-in —
  *reverse semantic zoom: terrain names far, street names near.* Label text
  v1 = top-degree node name (free); v2 = LLM topic summary, cached, falling
  back to v1.
- **B3 Focus modes with an exit.** Hover: non-neighbors 0.5→**0.15** alpha,
  non-incident edges 0.05 (current hover is too timid). Click = 1-hop isolate
  (non-neighbors 0.08) + inspector; double-click = 2-hop; **Esc / void-click
  pops one level** (selection stack + toolbar breadcrumb chips). Cmd-click a
  second node = shortest-path mode on the filament layer.
- **B4 Controls simplification** (`GraphControls.tsx`, v25): collapse the five
  force sliders into an "Advanced" accordion; replace with 3 layout presets —
  `Galaxy` (default) / `Loose web` (cluster 0.15, dist 70) / `Dense`
  (cluster 0.5, dist 34). Rename brightness → "Glow", range 0.4–1.6 (2.5 is a
  self-harm option). One "Ambient motion" toggle.
- **B5 Five states.** loading: progressive alpha fade-in ("aligning
  constellations…"); empty: "no stars yet — ingest a note to grow the galaxy"
  + CTA; error: context-loss toast + retry; perf: > 5 000 nodes auto-LOD
  banner (starfield 3→1 shell, pulses off, nebula off); success: current view.
- **B6 Interaction LOD.** OrbitControls `start` → hide pulses/labels/arrows;
  `end` + 150 ms debounce → restore. Same during node drag. Thin edges stay
  (single draw call).

## Roadmap

| Phase | Scope | Files |
|---|---|---|
| **0** (today) | constants table above | graphScene, graphData, graphSettings, graphSim.worker, pulseLayer |
| **1** (2–3 d) | midpoint-split edges (fade+sag) + length falloff shader, degree-based distances, 6-hue palette, dynamic fog + z-desat, log node sizes, luminance clamp, clusterForce 0.35 | graphScene, graphData, graphSim.worker |
| **2** (3–4 d) | legend, cluster labels v1, focus modes + selection stack, control presets, five states, motion toggle | GraphControls, PageGraph, new GraphLegend/clusterLabels, graphSettings |
| **3** (~1 w) | selective bloom, back-halo, filament=focus/path layer, path mode, interaction LOD, LLM cluster labels | graphScene, new bloomComposite, pulseLayer, nebulaLayer |

**Per-phase exit criteria (same-vault A/B screenshots):** (1) hub cores retain
hue (not white discs); (2) no starburst silhouettes; (3) ≥ 75 % of frame in
shadow (histogram); (4) 60 fps at 10 k nodes (profiled, recorded).

## Risks

- All Phase 0 numbers are estimates from additive-luminance arithmetic —
  **do not commit without visual A/B** on a real vault.
- Layout changes (jitter, degree distances, clusterForce) move equilibria →
  users' spatial memory breaks once; KEY v25 also resets tuned sliders.
- Midpoint-split edges double edge vertices in the hot path — profile first
  (CLAUDE.md §7: no optimization/regression without measurement).
- Selective bloom doubles render passes + per-frame material swaps — adopt in
  Phase 3 only behind a perf gate.
- 12→6 hues removes color identity from small communities — legend + cluster
  labels must ship in the same or an earlier release.
- Bloom constants are duplicated (constructor + `applyTheme`); extract a
  single helper or one side will drift. Light theme needs its own calibration.
- LLM cluster labels: cost/latency/nondeterminism — always keep the
  top-degree-name fallback.
