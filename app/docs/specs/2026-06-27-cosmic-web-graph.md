# Cosmic-Web Graph — Design Spec

- **Date:** 2026-06-27
- **Status:** approved (design), implementation in progress
- **Supersedes:** [[2026-06-15-galaxy-layout-design]] (procedural spiral galaxy)
- **Scope:** Settle the long-running 3D-graph design churn. Keep the force-directed
  layout (node position encodes link structure) and invest effort in (a) closing
  the last cosmic-web *rendering* gaps and (b) turning the graph from read-only
  eye-candy into a developer-grade, metadata-rich instrument.

## Background: the layout churn is over

The 3D graph went through four design epochs:

0. Cytoscape.js + fcose, 2D (original MVP).
1. Planned sigma.js 2D renderer swap (kept d3-force) — superseded before completion.
2. **Shipped:** three.js 0.184 + d3-force-3d 3D "universe" with Louvain community
   clustering (`graphSettings.ts` v24 "GALAXY/BRAIN" defaults), star-temperature
   node colours, HDR bloom on hub cores, depth fog, nebula gas, edge pulses.
3. Locked procedural spiral-galaxy spec ([[2026-06-15-galaxy-layout-design]]) —
   would have *removed* the force sim and placed nodes analytically. **Never
   implemented** (no `galaxyLayout.ts` exists; `createSim` is still force-based).
4. cosmic-web rethink (`cosmic-refs/cosmic-refs.md`, untracked) — disavows the
   spiral, argues a node+edge graph is intrinsically cosmic-web-shaped, and
   recommends restoring the force layout + improving rendering.

**Diagnosis (verified against the code):** the shipped graph (epoch 2) already *is*
the cosmic-web direction epoch 4 asks for. The "spiral failed" in `cosmic-refs.md`
refers to the dev-only `bigGraph.ts` hero render, not the shipped graph. So:

- The procedural spiral spec is **superseded** (see its updated status).
- `graphSim.ts` is the canonical layout and **must not be deleted**.
- Only two cosmic-web *rendering* gaps remain (Phase 1 below).
- The real opportunity is *interaction + metadata encoding* (Phases 2–3).

## Decisions (locked)

1. **Layout:** force-directed (d3-force-3d, off-thread worker) stays. Node
   position encodes structure. No procedural placement.
2. **Aesthetic target:** cosmic web — bright galaxy-nodes, glowing filament edges,
   dark voids, depth. Reference: `cosmic-refs/cosmic-web.jpg`.
3. **Differentiator:** encode Memex's unique per-page metadata (`type`,
   `confidence`, `status`, `source_count`, citation coverage) into the
   visualization. No competitor PKM graph has this data.

## Phase 1 — cosmic-web rendering gaps (quick wins)

**Done** — `0f9d02a` (fat glowing filament overlay on hub-incident edges + the
parallax starfield enabled).

| Gap | Before | Change | File |
|-----|--------|--------|------|
| Background stars | built but disabled | enable parallax starfield | `graphScene.ts` `SHOW_STARFIELD` |
| Filament edges | dim 1px `LineBasicMaterial` (no width) | add a **fat-line glow overlay** (`LineSegments2`) for hub-incident edges, bounded by a degree cap so fat lines never blow up the frame; brighter so they catch bloom and read as luminous strands | `graphScene.ts` `SHOW_FILAMENTS` |

The thin edge mesh stays for the full graph; the fat overlay is a bounded LOD
subset (hub-incident edges, capped at `FILAMENT_MAX`). On hover, incident filaments
brighten and the rest dim, matching the existing thin-edge hover behaviour.

Refs: three.js fat lines (`LineSegments2`/`LineMaterial`), vasturiano/three-fatline.
Fat lines are heavier than 1px lines — the cap + hub-only membership is the
mitigation for the high-density-line performance issue.

## Phase 2 — metadata encoding (the "rich" payoff)

**Done** — `5c78b29`. The backend exposes per-node frontmatter
(`index.rs` `Adjacency.meta`) and the graph encodes it: confidence → star
brightness, `source_count` → glow, disputed/superseded → amber tint. Filters by
metadata are still open (future).

- Backend exposes per-node frontmatter (`type`/`confidence`/`status`/`source_count`)
  + citation coverage (`provenance.rs`) alongside the adjacency the graph already
  consumes.
- `graphData.buildGraph` maps them to visual channels:
  - `type` → a palette/shape channel distinct from the community hue
  - `confidence: low` → lower alpha; `status: disputed` → a warning ring / pulse
  - `source_count` / citation coverage → halo brightness (well-cited = brighter)
- Surface them as filters (Dataview-style: `type=concept confidence<high
  status=disputed`) in `computeAllowed`.

## Phase 3 — developer-grade interaction

- **Node inspector panel** — **done** `35bb039`. A side panel: frontmatter
  (type/confidence/status badges), connections, outlinks, backlinks, tags;
  link rows fly the camera to the target; "Open in reader" keeps navigation.
- **Search-to-focus** — **done** `4623c30`. Toolbar search flies the camera to
  the best-matching node and opens its inspector.
- **Shortest path** — **done** `0f2621b`. Pin a path start in the inspector,
  select another node → BFS path highlights via the hover machinery + lists with
  a hop count.
- **Semantic zoom** — **done** `f64bb13`. Label candidate pool grows with zoom
  (top-degree first, bounded), so more notes name themselves as you push in.
- **Gap analysis** — **open (Phase 4)**: orphans, under-cited claims, disconnected
  clusters surfaced as ingest suggestions (InfraNodus pattern, fed by Memex's own
  citation/provenance data).

## Performance ceiling (honest)

- Hot path (`applyPositions`) is positions-only and already optimized.
- `pickNode` is O(n)/frame; fine to ~10–20k nodes. Beyond that: spatial hash or
  GPU picking; the d3-force-3d layout can swap to ngraph for faster settle.
- 50k–1M nodes is a different product (GPU engine like cosmos.gl, 2D) — not a
  goal; an LLM-maintained wiki does not reach that scale.

## Success criteria

- Default dark view reads as a cosmic web: bright community cores, glowing
  filament strands between/through hubs, dark voids, a faint parallax starfield.
- Fat filaments are bounded (≤ `FILAMENT_MAX`) and never tank the frame rate.
- Hover brightens incident filaments and dims the rest; timelapse-hidden edges
  vanish.
- `tsc -b && vite build` passes; existing graph verify scripts still pass.
- No regression to the off-thread sim, drag, timelapse, or live-ingest paths.
