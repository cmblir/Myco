# Graph View: cytoscape → sigma.js Migration

**Status:** approved (design), implementation pending
**Goal:** Make memex's Graph view look like Obsidian's graph view (faint receding
edges, airy separated radial "dandelion" clusters, labels hidden at overview zoom
and revealed hub-first on zoom-in, degree-sized nodes), by replacing the renderer
with sigma.js while keeping the existing d3-force layout.

## Why

The current renderer is cytoscape 3.33.3 with the experimental WebGL renderer.
Three problems block the Obsidian look:

1. **Edge alpha bug (root cause of the bright "hairball").** cytoscape's WebGL
   `toWebGLColor` (webgl-util.mjs) discards the alpha channel of `line-color`, so
   `rgba(...,0.18)` edges render fully opaque. *(Worked around in the current tree
   by moving faintness to `line-opacity`; verified to fix edge brightness on the
   real 1798-node vault. This migration supersedes that workaround.)*
2. **Labels flood the overview.** Our hand-rolled 3-tier zoom→label logic still
   shows hub labels across most of the useful zoom range. Obsidian shows *no*
   labels at the whole-graph zoom and reveals them hub-first as you zoom in.
3. **Layout reads as a dense uniform disk**, not Obsidian's separated dandelions.

sigma.js addresses #1 (honors edge alpha natively — verified in v3.0.3
`colors.ts`) and #2 (label visibility is driven by a rendered-size grid →
hub-first reveal is free) and is purpose-built for large graphs (perf for #3).

## Principle: keep the layout, swap the renderer

The d3-force simulation already produces the dandelion shape via degree-normalized
link strength (`linkStrength = slider / (1 + min(deg(a),deg(b)))`). We KEEP that
simulation (port to the `d3-force` npm package) and replace only rendering with
sigma.js + graphology. ForceAtlas2 is explicitly rejected: it cannot reproduce the
d3 degree-normalized radial look (FA2's `outboundAttractionDistribution` operates
on attraction distribution, not spring rest-length).

## Architecture / file decomposition

Current `pages/PageGraph.tsx` is ~1200 lines. Split by responsibility (CLAUDE.md §5.1):

| File | Responsibility |
|---|---|
| `lib/graphData.ts` | Pure, renderer-agnostic data: `computeAllowed` (filters), build a graphology `Graph` from `adjacency` + `allFiles`, degree/size computation, `collectTags`/`collectFolders`, `stem`/`inFolder`/`flattenMarkdown`/`countAllNodes`. Ported verbatim from PageGraph where possible. |
| `lib/graphSim.ts` | d3-force wrapper: build a simulation from the graphology graph + `GraphSettings`, port `buildForceOpts` mapping (REPEL_SCALE, CENTER_SCALE, degree-normalized linkStrength, uncapped manyBody, collide). `onTick` writes positions via `graph.mergeNodeAttributes`. `reheat(alpha)` for drag. `stop()`. |
| `lib/graphTheme.ts` | `readThemeColors` (solid colors + alphas) and a `buildSigmaSettings(theme, GraphSettings)` that maps theme + display sliders to sigma settings. |
| `pages/PageGraph.tsx` | React shell only: Sigma lifecycle (`new Sigma`/`kill`), reducers (hover), node drag, camera (fit/zoom), label settings, WebGL-context-loss recovery, timelapse, toolbar, drawer wiring. Slim. |
| `components/GraphControls.tsx` | **Unchanged.** Same drawer UI. |
| `lib/graphSettings.ts` | Mostly unchanged (slider values persisted to localStorage). Mapping comments updated. Bump persisted key (`v18` → `v19`) since defaults may retune. |

cytoscape + cytoscape-d3-force removed once migration is complete (one-shot replace,
no parallel feature flag).

## Visual mapping (the Obsidian look)

**Sigma construction (vanilla, in a React `useEffect`, NOT @react-sigma):**
`new Sigma(graph, container, settings)`, cleanup `renderer.kill()`. Mutate the
graphology graph imperatively across renders; recreate Sigma only on
program/context changes.

- **Edges:** per-edge `color` = solid theme RGB + alpha (e.g. `rgba(220,224,230,0.18)`
  dark) — sigma honors alpha. Straight (`defaultEdgeType: "line"`, the default).
  `minEdgeThickness` ≈ 0.5 (down from 1.7) for hairlines. Width from `linkThickness`
  slider. Hover → brighter alpha via `edgeReducer`.
- **Nodes:** `size = max(2, 2 + sqrt(degree) * k)` scaled by `nodeSize` slider; hubs
  visibly larger. Unresolved nodes dimmer color. Color from theme (monochrome).
  Decide `itemSizesReference`/`zoomToSizeRatioFunction` by visual test (target:
  nodes grow with zoom like Obsidian → likely `"positions"` + `r=>r`, verify).
- **Labels (Obsidian-critical):** `renderLabels: true`,
  `labelRenderedSizeThreshold` (driven by `textFadeThreshold` slider; tuned so
  overview shows none), `labelGridCellSize` ≈ 120, `labelDensity` ≈ 0.7,
  `labelColor: { color: <ink> }`, `labelFont` from app font. sigma picks the
  largest-rendered-size node per grid cell above threshold → **hubs label first as
  zoom increases; nothing at overview.** Replaces our 3-tier logic entirely.
- **Background:** container shows `--bg`; sigma canvas transparent.
- **Theme changes:** `readThemeColors` → `setSettings` + `refresh` (no recreate).

## Interaction & feature parity (all ported)

- Click node → `setRoute('page:'+id)` (sigma `clickNode`).
- Hover → highlight closed neighborhood, dim the rest (`nodeReducer`/`edgeReducer`,
  `enterNode`/`leaveNode`, `refresh({ skipIndexation: true })`).
- **Node drag** → `downNode`/`moveBody`/`upNode`/`upStage`, `viewportToGraph`,
  set node x/y, pin in sim via d3 `fx/fy` + `sim.alphaTarget(0.3).restart()` to tow
  neighbors; release `fx=fy=null` + `alphaTarget(0)` on up. Freeze camera via
  `setCustomBBox(getBBox())` while dragging.
- Zoom +/- and **fit** → `camera.animatedZoom`/`animatedUnzoom`,
  `fitViewportToNodes` (`@sigma/utils`); initial auto-fit (guard < 2 nodes).
- **Timelapse** → set node `hidden: true` attribute for all, then reveal oldest-first
  by mtime via rAF (physics-free; positions already settled). Edges auto-hide when an
  endpoint is hidden.
- **Filters** (tag/folder/search/orphans/existingOnly) → rebuild the graphology graph
  via the ported `computeAllowed` + build logic.
- **Settings drawer** sliders: force sliders → re-tune d3-force (reheat); display
  sliders → `setSettings` (nodeSize, linkThickness, textFadeThreshold→threshold,
  arrows→edge type/arrow).
- **WebGL context loss (Tauri WKWebView, highest risk):** sigma has NO built-in
  recovery. Attach `webglcontextlost`(preventDefault) / `webglcontextrestored`
  (`kill()` + recreate Sigma, rebind events) on `renderer.getCanvases()`. The
  graphology graph + sim survive; only the renderer is rebuilt.
- Initial reveal fade-in (`graph-ready` class), same as now.

## Dependencies

Add: `sigma` (^3.0.3), `graphology`, `d3-force`, `@sigma/utils`.
Dev: `graphology-types`, `@types/d3-force`.
Remove (after migration): `cytoscape`, `cytoscape-d3-force`.

## Risks

1. **WKWebView WebGL context-loss recovery** — must hand-roll kill()+recreate;
   primary regression risk. Port the existing cytoscape recovery intent.
2. **Visual tuning is iterative** — node-size scaling mode, label thresholds, edge
   alpha, force airiness need on-screen verification (see below).
3. **Drag-tow feel** — matching the current "spring-back" requires correct
   `fx/fy` + `alphaTarget` handling.

## Verification

Run the real app on the 1798-node vault via the dev-only `?vault=` escape hatch
(temporarily set `devUrl` in tauri.conf.json, revert after) and screenshot with
macOS `screencapture`, cliclick for toolbar buttons. Checkpoints, in order:
edges faint → labels hidden at overview / hub-first on zoom → clusters airy →
drag tows neighbors → timelapse → filters → theme toggle → context-loss recovery.
Compare each against Obsidian's reference look.

## Out of scope

Pixel-identical node positions (impossible — different seed/order). Target is the
visual *character*, not coordinates. Obsidian-internal constants (exact node-size
formula, edge alpha, colors) are closed-source → approximated and tuned by eye.
