# Graph visual rules

The reference for every change to how the Graph page draws. A new look, a new
layer, or a retune of an existing look reads this first and clears the
[new look checklist](#new-look-checklist) before it ships.

- **Pinned in code:** `app/src/lib/graphVisualRules.test.ts` holds the rules
  marked *pinned* below (rule ids match).
- **Checked by eye:** `app/scripts/graph-look-shots.mjs` renders the
  screenshot set every rule was measured from. The rules that need a GPU
  (glow, tone, motion) are checked there.
- Every value below was read from the code or measured from that set on
  2026-10-01 (Woven's, R13 and the motion and sky rows that changed with it
  on 2026-10-02). Where the code holds a value as a private constant, the
  table names the module and the constant; "export" means it is importable.

## How the set was measured

- `?mock=1` vault (68 nodes, 99 links), Vite dev server, headless Chromium on
  ANGLE Metal (Apple M3), viewport 1280×900, app language `en`.
- All 12 looks the picker offers (`GraphControls` `vibeMeta`), each in the
  light and the dark app theme. Each look is seeded as
  `DEFAULT_GRAPH_SETTINGS ⊕ VIBE_PRESETS[key]` with both rails folded, loaded
  fresh, and drawn from its own default `fit()`, the framing a user lands on.
  The shot is taken 7 s after `.graph-canvas.graph-ready`. The canvas is
  960×609 CSS px.
- Two questions: the default *Where is it empty* (connected notes recede) and
  *What clumps together* (every note in its cluster colour).
- Run: `MYCO_TEST_URL=http://127.0.0.1:5173 MYCO_SCREENSHOTS=<dir> [QUESTION=clusters] node scripts/graph-look-shots.mjs`.
  It writes `<look>-<theme>.png`, `<look>-<theme>-canvas.png` and `stats.md`.
- `stats.md` is measured on a second clip of the same frame with the note
  labels and cluster names hidden, so it counts what the look draws, not the
  label text (cluster names alone carried most of Woven's hue spread). The
  saved shots keep the labels for the eye.

## Looks on offer

Everything except `mycelium` is drawn by `GraphScene` (`lib/graphScene.ts`).
`ribbon` (Woven) is too, except that its links are the routed strands of
`WovenGraphLayer` (`lib/wovenGraphLayer.ts`) inside GraphScene's own scene;
`mycelium` has its own renderer (`lib/myceliumScene.ts`).
Values are `VIBE_PRESETS` (`lib/graphSettings.ts`, export).

| key | picker name (en / ko) | skin | layout | nodeSize | linkThickness | textFadeThreshold | brightness | ambientMotion | cinematic |
|---|---|---|---|---|---|---|---|---|---|
| default | Living galaxy / 살아있는 은하 | auto | galaxy | 1 | 1 | 1.1 | 0.9 | on | on |
| living | Spiral galaxy / 나선 은하 | galaxy | spiral | 0.8 | 0.45 | 2.2 | 0.95 | on | on |
| sigma | Sigma board / 시그마 보드 | sigma | atlas | 0.75 | 0.5 | 1.4 | 0.9 | off | off |
| cosmicweb | Cosmic web / 우주 그물 | web | galaxy | 0.55 | 0.8 | 2.3 | 0.9 | on | on |
| neural | Neural / 신경계 | black | synapse3d | 0.65 | 0.65 | 2 | 0.9 | on | off |
| planetarium | Planetarium / 플라네타륨 | galaxy | celestial | 0.7 | 0.4 | 2 | 0.9 | on | off |
| paper | Paper atlas / 종이 지도 | white | atlas | 0.8 | 0.45 | 1.5 | 0.9 | off | off |
| chronicle | Chronicle / 연대기 | white | strata | 1 | 0.7 | 1.3 | 0.9 | off | off |
| nebula | Meaning nebula / 의미 성운 | galaxy | semantic | 0.65 | 0.35 | 2.4 | 1.05 | on | on |
| walrus | Walrus tree / 월러스 트리 | black | walrus | 0.8 | 1.15 | 1.8 | 0.9 | off | off |
| mycelium | Mycelium / 균사 | mycelium | mycelium | 0.8 | 0.8 | 1.8 | 1 | off | off |
| ribbon | Woven / 직조 | auto | ribbon | 0.8 | 1 | 1.1 | 0.9 | on | on |

Only `default` and `ribbon` (skin `auto`) follow the app theme. Every other
look pins a skin: its light and dark shots have the same ground (measured),
and differ only where the auto-rotate happened to be when the shot was taken.
Woven's preset is the default look's (`DEFAULT_LOOK`) with its own layout,
`linkDistance` 70, nodeSize 0.8 (its camera frames the web closer, so its
notes land at the default look's screen size) and no folder galaxies or
bundle arcs (see [Known exceptions](#known-exceptions)); its cosmic events run
as the default look's do.

## Shared tokens

### Palette

| token | value | where |
|---|---|---|
| cluster hues, in rank order | 212°, 163°, 40°, 262°, 338°, 20°, then golden angle 137.508° × rank | `graphData.ts` · `PALETTE_HUES` (private), `communityPalette` (export) |
| cluster colour on a dark ground | HSL(hue, 0.62, 0.68) → `#7baae0 #7be0c3 #e0be7b #a07be0 #e07ba0 #e09d7b` | `graphData.ts` · `shadeHex` (private) |
| cluster colour on a light ground | HSL(hue, 0.72, 0.40) → `#1d61af #1daf86 #af7e1d #521daf #af1d52 #af4e1d` | same |
| vivid wheel (sigma skin only) | hues 0, 32, 52, 120, 168, 200, 264, 300, 16, 90, 320, 224 at HSL(·, 0.92, 0.56) | `graphData.ts` · `VIVID_HUES` (private) |
| field star (no cluster, or a cluster under 3 notes) | `#9aa6c2` dark / `#5a6478` light | `graphData.ts` · `fieldStar` (export) |
| per-note colour | cluster colour × star-temperature tint by degree, written to the node attribute `color` | `graphData.ts` · `colorByCommunity` (private), `recolorGraph` (export) |
| disputed / superseded | 55 % toward `#ff9e3d` | `graphData.ts` · `buildGraph`, `recolorGraph` |
| question encoding | owns colour, size and alpha while a question is active (e.g. receded notes: alpha 0.22, 55 % toward `--ink-4`) | `graphEncoding.ts` · `encodeNode` (export) |
| skin grounds and inks | black `#000000`, white `#ffffff`, galaxy `#05060d`, web `#02040c`, sigma `#1c1c21`, mycelium `#0b0a08`; auto reads `--bg` / `--ink` | `graphSkins.ts` · `skinTheme` (export), `graphTheme.ts` · `makeTheme`, `readTheme` (export) |

Edges, cluster labels, bundles, hover filaments and the minimap all read the
same node `color`, so the legend key, the label colour and the note colour
agree in every GraphScene look.

### Note size

| token | value | where |
|---|---|---|
| base size | `(0.85 + 2.5 · (log2(1+deg) / log2(1+maxDeg))^1.25) · nodeSize · jitter`, jitter ±18 %; range 0.70–3.95 × nodeSize | `graphData.ts` · `buildGraph` (node attribute `size`) |
| encoding multiplier | `clamp(radius / 6, 0.45, 2.2)` | `graphScene.ts` · `ENC_BASE_R` (private), `writeNodes` |
| world sprite diameter | `size · NODE_RADIUS 3.4 · GLOW_SCALE 2.8` | `layoutConfig.ts` · `NODE_RADIUS`, `GLOW_SCALE` (export) |
| visible body | glow star core edge at 0.375 of the sprite; paper disc 0.60; sigma disc 0.86; pixel sprite fills the quad | `graphScene.ts` · `NODE_FRAG` |
| hub swell | `× (1 + intensity · 0.35)` | `layoutConfig.ts` · `INTENSITY_SIZE_COEF` (export) |
| star class | main 1, dwarf 0.72, giant 1.5, neutron 0.55 | `layoutConfig.ts` · `STAR_KIND_SCALE` (export) |
| skin scale | sigma 1.15, web 0.34 | `layoutConfig.ts` · `SIGMA_SKIN_NODE_SCALE`, `WEB_SKIN_NODE_SCALE` (export) |
| light ground | glow dots × 1.85, pixel sprites × 1.1 | `layoutConfig.ts` · `LIGHT_BG_SIZE_MUL`, `LIGHT_BG_PIXEL_SIZE_MUL` (export) |
| screen clamp | 1.3 px (dark) / 3.2 px (light) to 180 px, device pixels | `graphScene.ts` · `NODE_VERT` |
| pixel sprite threshold | 14 CSS px; smaller sprites draw a flat dot | `graphScene.ts` · `PIXEL_SPRITE_MIN_PX` (private) |
| slider | nodeSize 0.5–3 | `graphSettings.ts` · `GraphSettings.nodeSize` |

### Glow, bloom and tone

| token | value | where |
|---|---|---|
| what blooms | notes only (plus click flashes, the supernova and the trace comet): selective bloom on layer 1 | `graphScene.ts` · `BLOOM_LAYER` (private) |
| bloom strength | 0.45 dark, 0.25 light, 0.12 sigma, 0.14 mycelium skin | `graphScene.ts` · `baseBloom` |
| bloom radius / threshold | 0.7 / 1.9 dark, 1.05 light (linear HDR, half-float target) | `graphScene.ts` · constructor |
| bloom resolution | half the device ratio when the ratio is ≥ 2 | `graphScene.ts` · `bloomPr` |
| note HDR intensity | `min(1.7, 0.22 + (deg/maxDeg)^1.8 · 1.5)`, + up to 0.3 for cited pages, cap 1.8 | `graphData.ts` · `buildGraph` |
| per-sprite clamp | colour ≤ 3.0 before tone mapping | `graphScene.ts` · `NODE_FRAG` |
| tone mapping | AgX on a dark ground; none on light, sigma and mycelium | `graphScene.ts` · `lookToneMapping` |
| exposure | the Glow slider (`brightness` 0.4–1.6); never below 1 on light, sigma, mycelium | `graphScene.ts` · `lookExposure` |
| cinematic finish | FXAA + vignette 0.26, grain 0.045, chromatic aberration 0.0012; depth of field 0.7 on dark 3D only | `graphScene.ts` · `attachFinishing`, `dofAmpFor` |
| light-ground aura | analytic halo inside the sprite instead of bloom | `graphScene.ts` · `u_halo` |

### Lines

| token | value | where |
|---|---|---|
| link colour | each end takes its note's `color`, pulled 50 % toward the neutral (`#8b93a8` dark, `#2c3446` light); 12 % with community tint or synapse; web 85 % toward `#6f7ce0`; sigma 5 % then saturation × 1.5 | `layoutConfig.ts` · `EDGE_GREY_MIX`, `EDGE_NEUTRAL_DARK_HEX`, `EDGE_NEUTRAL_LIGHT_HEX` (export); `graphScene.ts` · `EDGE_NEUTRAL_WEB`, `EDGE_GREY_MIX_WEB`, `EDGE_GREY_MIX_SIGMA` (private), `writeEdges` |
| link light | per-end brightness 0.22 dark, 0.9 light, 0.6 web, 1.0 sigma; material opacity 0.2 dark, 0.42 light, 0.16 web, 0.5 sigma, × linkThickness | `layoutConfig.ts` · `EDGE_BASE_DARK`, `EDGE_BASE_LIGHT`, `EDGE_OPACITY_DARK`, `EDGE_OPACITY_LIGHT` (export); `graphScene.ts` · `EDGE_BASE_WEB`, `EDGE_BASE_SIGMA`, `EDGE_OPACITY_WEB`, `EDGE_OPACITY_SIGMA` (private) |
| Woven strands | the link colour, light and every link state above, handed over by the scene for its skin, theme and Link colour (`GraphScene.linkInk`: neutral, pull, per-end light, opacity, blending, sigma's saturation); 1 px `LineBasicMaterial`, additive on dark, normal on light and sigma; the state in vertex alpha (≤ 1), tapering from × 0.45 at each note to × 1 mid-strand (`0.45 + 0.55 · sin πt`); material opacity the links' own × linkThickness; a traced path lights at the hover value 1.15; past 900 strands the resting and dimmed light × √(900 / strands), because a corridor stacks every strand it carries (hover and path stay full); below 900 the light × √(900 / strands), at most × 3 (`SPARSE_GAIN`), because a small vault's few strands at the shared light all but vanish (68 notes: 99 strands, × 3), and every state keeps its ratio to rest; on a dark ground that lift is the material colour (additive light into the half-float target keeps values above 1), on paper it stacks the ink (`1 − (1 − opacity)^lift`), so the Link thickness slider runs its whole range on both. Until 2026-10-02 the dark strands ran at 3 × the link light (`STRAND_GAIN`) at linkThickness 0.55, and read as bright cables beside the default look | `wovenGraphLayer.ts` · `WovenGraphLayer.setInk`, `sync`, `BUNDLE_FULL_STRANDS`, `SPARSE_GAIN` (private) |
| blending | additive on a dark ground, normal on light and on sigma | `graphScene.ts` · constructor |
| link shape | split at the midpoint: ends × 0.45, middle × 1; midpoint sags 5 % of the length (sigma × 2.6) | `layoutConfig.ts` · `EDGE_END_FADE` (export); `graphScene.ts` · `EDGE_SAG`, `EDGE_SAG_BOOST_SIGMA` (private) |
| long-link fade | full below 2.5 × linkDistance, floor 0.25 above 8 × linkDistance | `graphScene.ts` · `EDGE_LEN_FADE_*` (private) |
| width | the link mesh is 1 px (`LineBasicMaterial`); hover/path filaments 2 px additive (`LineMaterial`, ≤ 200 strands, brightness 0.7, path 1.0); bundles 1.5 / 3 / 5 px at opacity 0.05 / 0.08 / 0.12 (× 1.4 on light) | `graphScene.ts` · `FILAMENT_*`, `edgeBundleLayer.ts` · `TIER_WIDTH`, `TIER_OPACITY` (private) |
| edge flow | a light band rides each link at amplitude 0.55 when edgeFlow is on (not on sigma, not with arrows); on a Woven strand the same band on the same clock scales the strand's own colour (× up to ≈ 5 on dark, deeper ink on light), because its light is its vertex alpha | `graphScene.ts` · `flowAmpFor`, `patchEdgeFlow`; `wovenGraphLayer.ts` · `flowWith` |
| moving marks | pulses, the click wave's sparks, the idle firing, the trace comet and the arrows ride the link as drawn: Woven's along its strand (`LinkRoute`, `WovenGraphLayer.pointAlong`), every other look's along the chord | `pulseLayer.ts` · `LinkRoute`; `waveLayer.ts`, `tracePulse.ts`, `graphScene.ts` · `animateArrows` |
| slider | linkThickness 0.3–3 | `graphSettings.ts` |

### Ground and backdrop

| token | value | where |
|---|---|---|
| scene background | the skin's `sceneBg`; auto: `#05060d` on dark, `--bg` on light | `graphScene.ts` · constructor, `graphSkins.ts` · `skinTheme` |
| fog | `FogExp2`, density re-derived from the framed distance | `graphScene.ts` · `fit` |
| CSS backdrop | radial glow `rgba(120,150,220,0.06)` + vignette to `rgba(0,0,0,0.45)` over `--bg`; mycelium `#0b0a08` | `styles.css` · `.graph-canvas-wrap` |
| ambient layers per skin | starfield / nebula / meteors: auto (on / dark only / dark only), galaxy (on/on/on), web (on/off/off), black, white, sigma, mycelium (off) | `graphSkins.ts` · `skinAmbience` (export) |
| starfield | three shells: dark 900 / 1100 / 1400 points, 1.6 / 1.4 / 1.0 px, opacity 0.3 / 0.2 / 0.14; light 700 / 900 / 1100, 1.5 / 1.1 / 0.8 px, 0.24 / 0.16 / 0.1; × 2.2 on dense and flat layouts | `graphScene.ts` · `buildStarfield` |
| measured grounds (canvas mode colour) | default `#0a0d13` dark / `#fefefe` light; living, nebula `#020202`; neural, walrus `#000000`; sigma `#1c1c21`; paper, chronicle `#ffffff`; mycelium `#0d0a12`; ribbon the default look's (its stats read `#171b25` on dark, because its frame is wide and the cluster clouds cover most of it; `#000000` from a pinned black skin until 2026-10-02, a private `#0b0c12` until 2026-10-01) | screenshot set, `stats.md` |
| cluster clouds | one tinted cloud (opacity 0.12) on each of the 8 biggest clusters of ≥ 6 notes, plus one cool back-halo, where the skin has a nebula (not on flat layouts, spiral or celestial); re-placed every 12th position sync and whenever a layout comes to rest (`layoutSettled`). Until 2026-10-02 a baked layout, which syncs once, kept them on the pre-layout centroids when reached from the picker or rebuilt by a slider: on Woven one grey haze mid-frame, 680 world units off its clusters | `nebulaLayer.ts` · `MAX_COMMUNITY_SPRITES`, `MIN_MEMBERS`, `COMMUNITY_OPACITY` (private); `graphScene.ts` · `nebulaWanted`, `syncPositions`, `layoutSettled` |
| baked deep sky | PageGraph bakes a seeded nebula backdrop for the galaxy skin and auto on a dark ground; the scene shows it only on those (`deepSky`). Until 2026-10-02 a live skin or theme switch kept it, so white, black, web, sigma and a light auto ground drew the dark sky | `skyTexture.ts` · `bakeSeededSky`, `graphScene.ts` · `deepSky`, `setSkyTexture`, `applyTheme` |

### Labels

| token | value | where |
|---|---|---|
| note label | `var(--font-sans)` 11 px / 500 / line-height 1, colour `theme.ink`, opaque `theme.bg` text backing; bounded by the canvas and open inspector, with ellipsis for titles wider than the available strip (November 11 repair) | `styles.css` · `.graph-label-3d`, `graphScene.ts` · `ensureLabel` / `updateLabels` |
| mycelium note label | same typography | `styles.css` · `.myc-hub-label` |
| cluster name | `var(--font-sans)` 12.5 px / 600, letter-spacing 0.02em, in the cluster's hub colour, opacity 0.85, 480 ms fade; light ground: `brightness(0.45) saturate(1.6)` | `styles.css` · `.graph-cluster-label`, `clusterLabels.ts` |
| cluster names show | top 6 clusters of ≥ 3 notes, while camera distance > 0.6 × framed distance | `clusterLabels.ts` · `MAX_LABELS`, `MIN_MEMBERS`, `SHOW_RATIO` (private) |
| note label budget | 12 hubs at the framed distance, growing to 64 as you zoom in (`12 · (1/ratio)^1.3`) | `graphScene.ts` · `LABEL_MIN`, `LABEL_MAX` (private) |
| note label size gate | rendered radius > `max(1, 5 + (textFadeThreshold − 1.1) · 6)` px; the hovered note, the selection and its neighbours skip the gate; while hovering with nothing selected only the hovered note labels | `graphScene.ts` · `updateLabels` |
| declutter | greedy screen boxes, cluster names first; 6.4 px per latin character, 15 px rows (cluster 7.2 / 20) | `graphScene.ts` · `NODE_LABEL_*`, `CLUSTER_LABEL_*` (private) |
| during orbit | note labels hide, back 150 ms after the gesture | `graphScene.ts` · `LOD_RESTORE_MS` (private) |

### Hover, focus, selection, search

| state | notes | links | where |
|---|---|---|---|
| hover | hovered note and neighbours keep colour, alpha and bloom; the rest alpha 0.15, no bloom; hovered note eases to × 1.3 in 150 ms | incident links at per-end brightness 1.15 (rest state 0.22) plus 2 px filaments in the endpoints' colours; the rest 0.05 | `graphScene.ts` · `writeNodes`, `writeEdges`, `HOVER_POP_*` (private); `layoutConfig.ts` · `EDGE_HI`, `EDGE_DIM` (export) |
| focus (legend, 1-/2-hop) | non-members alpha 0.08, no bloom; held until popped | links leaving the set 0.03 | `graphScene.ts` · `FOCUS_NODE_DIM` (private); `layoutConfig.ts` · `FOCUS_EDGE_DIM` (export) |
| selection | keeps its colour; ring 5 (white on dark, near-black on light), sprite × 1.35, anamorphic streak when cinematic; click burst unless off | — | `graphScene.ts` · `NODE_VERT`, `NODE_FRAG`, `graphEncoding.ts` · `RING_SELECTED` |
| search (Find a note) | hits colour × 1.35 and pulse in phase `1 + 0.22 · sin(4t)` on the ambient clock; misses colour × 0.45, alpha × 0.5. Ring 6 exists in `graphEncoding.ts` but PageGraph passes the encoding an empty search, so it is not drawn | — | `graphScene.ts` · `setSearchHits`, `NODE_VERT`, `NODE_FRAG` |
| question rings | gap dashed amber (1), unresolved dotted grey (2), mapless dashed amber (3), fresh solid green (4) | — | `graphEncoding.ts` · `Ring` (export), `graphScene.ts` · `pxs_ring` |

### Motion

| token | value | where |
|---|---|---|
| one switch | all idle motion runs only while `ambientOn()` = not reduced motion and `ambientMotion` | `graphScene.ts` · `ambientOn` |
| auto-rotate | speed 0.12, resumes 8 s after the last orbit or zoom, never on flat layouts (atlas, synapse, strata). Woven sways instead, back and forth over ± 0.08 rad about its web's normal at that turn speed (a 40 s period), because a turn would swing its edge-to-edge frame off the screen | `graphScene.ts` · `ROTATE_IDLE_MS` (private), `autoRotateWanted`, `WOVEN_SWAY`, `swayTick` |
| star breathing | size × (1 + 0.025 · sin(0.6t)); neutron stars 0.07 at 3.4 | `graphScene.ts` · `NODE_VERT` |
| curl drift | 2.2 world units, 0 on flat layouts and Woven (its strands end exactly on the notes the GPU would drift off them) | `graphScene.ts` · `u_driftAmp` |
| galaxy swirl | 0.05 rad/s per folder galaxy; orphan moons 2π / 60 s. Woven has no swirl (its strands are routed for the rest positions); its unlinked notes' fan turns about its centre at the moon rate | `graphScene.ts` · `SWIRL_SPEED`, `MOON_SPEED` (private), `turnUnlinkedFan` |
| intro | stars condense in over ≤ 4 s, once per visit (the live-sim looks; a baked layout lands framed) | `graphScene.ts` · `playCondensation` |
| timelapse | notes appear in edit order over 18 s ÷ the speed slider; the live-sim looks fly them in, a baked layout (Woven, walrus, spiral …) shows each in place, its links once both ends are in | `PageGraph.tsx` · `startTimelapse`, `REVEAL_MS` |
| camera | focus flight 750 ms, galaxy flight 950 ms, easeInOutCubic; orbit damping 0.08 | `graphScene.ts` · `focusNode`, `startCamTween` |
| render loop | continuous `requestAnimationFrame`, every frame | `graphScene.ts` · `start` |

### Reduced motion

`prefers-reduced-motion: reduce` is read when the scene is built
(`graphScene.ts` · constructor). Under it: no auto-rotate, the `u_time`
clock stops (breathing, drift, grain, edge flow, nebula freeze in place), no
intro, no birth animation, no click burst or wave, no hover pop, camera
flights and orbit retargets jump, and `.graph-cluster-label` loses its
transition (`styles.css`). The picture stays complete; only motion goes.

## Rules

Each rule says *must* or *must not*, why, and how it is held.

- **R1. A look's preset must stay inside the shared envelope**: nodeSize
  0.55–1, linkThickness 0.35–1.15, textFadeThreshold 1.1–2.4, brightness
  0.9–1.05 (the range the shipped looks measure). *Why:* the looks are one
  product; a look outside the range reads as a different app at first sight.
  *Pinned.*
- **R2. A note's colour must be its node `color` attribute (or the question
  encoding's colour), and must not be tinted toward a look's own ink.** *Why:*
  the legend, cluster names, minimap and links all key off that colour; a
  re-tinted note no longer matches its legend row. *Pinned for a look's own
  layer:* it must draw no note marks of its own (mesh, points, sprites,
  lines other than its strands), so its notes are GraphScene's shared sprites.
- **R3. A link must carry its endpoints' hue** (pulled toward the shared
  neutral), and must not be one flat ink for every link. *Why:* intra-cluster
  links are how a cluster reads as one shape. *Pinned for a look's own
  layer*: each strand's ends within 30° of their note's hue, and its body
  (the middle vertex, the brightest part) within 30° of the blend of its own
  two ends.
- **R4. On a dark ground, links must be additive, thin, low-alpha light**
  (values under [Lines](#lines)); on a light ground normal blending. Wide or
  opaque strands must not hide notes. *Why:* additive summing lets density
  paint itself and keeps the notes the brightest thing. *Blending pinned for
  a look's own layer*; width and alpha by eye.
- **R5. The ground must come from the skin** (`skinTheme` / `makeTheme`), and a
  look must not paint a private background. *Why:* skins and the app theme
  are the user's choice; a fixed ground breaks both. *Pinned for a look's own
  layer:* it must not be or hold a `THREE.Scene` (the thing that carries a
  background).
- **R6. Note size must follow the shared chain**: node `size` × encoding
  multiplier × `NODE_RADIUS` × `GLOW_SCALE`, with the visible body 0.375–1 of
  that sprite. *Why:* the hub-to-leaf hierarchy (≈ 3.9 ×) and the Node size
  slider must mean the same thing in every look. *Pinned for a look's own
  layer* with R2: no note marks of its own.
- **R7. Hover, focus, selection and search must use the states under [Hover,
  focus, selection, search](#hover-focus-selection-search)**: dim the rest,
  ring the subject, lift its links; they must not replace a note's colour with
  one flat state colour. *Why:* the note stays findable as itself, and the
  ring is the channel that does not depend on colour. *Pinned for a look's own
  layer,* each state on its own: hover lifts the hovered note's lines above
  twice everything outside its neighbourhood, a held focus sinks the lines
  leaving it below their own rest light, a traced path lifts its lines above
  their own rest light; and under all three at once every line keeps its
  notes' hue.
- **R8. Note labels must share one typography**: `.graph-label-3d` 11 px / 500
  / line-height 1 in `var(--font-sans)`, the mycelium label the same, cluster
  names 12.5 px / 600. A look must use the scene's label layer and its budget,
  size gate and declutter, not its own. *Why:* a note's name looks the same in
  every look. *Typography pinned (CSS).*
- **R9. A look must render through the scene's composer**, so it gets the
  selective bloom, tone mapping, exposure and finishing under [Glow, bloom and
  tone](#glow-bloom-and-tone). Only notes may bloom. *Why:* glow is the
  family's signature; a look rendered straight to the screen has none and
  reads flat. *By eye* (needs WebGL).
- **R10. Idle motion must sit behind `ambientOn()`**, and explicit accents
  (click burst, hover pop, flights) must check reduced motion. The render loop
  must stay continuous; it must not become idle-when-static. *Why:* the moving
  galaxy is the requested look, and one switch must silence all of it. *By
  eye and code review.*
- **R11. Under reduced motion the picture must be complete and still** (see
  [Reduced motion](#reduced-motion)). *Why:* motion is decoration; the map is
  the content. *By eye* (Playwright `reducedMotion: "reduce"`).
- **R12. Sky layers must come from `skinAmbience`**; a look must not add its
  own starfield, nebula or sky. *Why:* the skin decides how much space there
  is. *By code review.*
- **R13. Every look must honour every shared control.** A motion or
  appearance control the drawer offers the default look must be offered on
  every look and change what it draws the same way (its skin, sky, colours,
  sizes, link light, glow, labels, effects and every idle motion), and its
  moving marks must ride its links as they are drawn. A look goes without a
  control only where the control truly cannot apply, and then the drawer says
  why in its place (`graphControlSupport`, e.g. Woven's bundle arcs). *Why:*
  the controls are one product; a look that silently ignores half of them
  reads as broken, and Woven did until 2026-10-02 (21 hidden controls, pulses
  and minimap forced off, a pinned black skin). *Pinned:*
  `wovenControls.test.ts` builds the real GraphScene for Woven in node and
  fails on any shared control that leaves the frame unchanged, or a moving
  mark off its strand; `GraphControls.test.ts` holds Woven's drawer to the
  default look's.

## New look checklist

1. Add the preset to `VIBE_PRESETS` and the card to `vibeMeta`; add the key to
   `PICKER` in `scripts/graph-look-shots.mjs`. Every new user-visible string
   gets en/ko/ja.
2. `npx vitest run src/lib/graphVisualRules.test.ts` passes. A look that adds
   its own layer to GraphScene (as Woven adds its strands) is added to that
   test's layer probe and must pass R2–R7 there.
3. Run `scripts/graph-look-shots.mjs` for both questions and look at the new
   look next to `default`, `living` and the look closest to it, light and dark:
   - same palette hues as the legend; links visibly in their cluster colours (R2, R3);
   - notes are the brightest marks, links are faint light, nothing opaque covers a note (R4);
   - the ground is the skin's; on `auto` it follows the app theme (R5);
   - hubs clearly larger than leaves, sizes in the same range as `default` (R6);
   - note labels and cluster names in the shared type and colour (R8);
   - glow around hubs on a dark ground, none on paper (R9).
   Compare its `stats.md` row with its neighbours' (the stats are measured
   with labels hidden): ink saturation and hue bins far below the galaxy
   looks mean the palette was lost.
4. Hover a hub, click it, then search a name: the states under R7 appear,
   and they match `default`.
5. Reload with `prefers-reduced-motion: reduce`: nothing moves, nothing is
   missing (R10, R11).
6. Every shared control changes the new look (R13): add it to a
   `wovenControls.test.ts`-style sweep if it draws through a layer of its
   own, and to `GraphControls.test.ts` if its drawer differs.
7. `npm run lint && npx tsc -b && npx vitest run` green.

## Known exceptions

- **The render loop runs continuously** (`GraphScene.start`). It drives the
  auto-rotate, breathing and edge signals the owner asked for. Do not make it
  idle when static; only reduced motion is still.
- **Mycelium has its own renderer** (`myceliumScene.ts`, `MyceliumView.tsx`):
  no composer, no bloom, no tone mapping, a substrate ground instead of a sky
  (the look's own `#0d0a13`; the default loam `#0b0a08` swaps to paper
  `#efe8db` on the light theme, `myceliumInk`), notes one flat
  `myceliumNodeColor` so they stand out of hyphae that carry the cluster hue
  blended 30 % toward the hypha ink (55 % for a dark ink). Its labels keep R8's typography. Four attempts to draw it as a
  GraphScene skin failed; the separate renderer is the design.
- **Sigma** is the only look with the vivid wheel, flat discs, normal blending,
  saturation × 1.45, bloom 0.12 and no tone mapping: a data-viz board, not a sky.
- **Cosmic web** draws notes in one ink (`monoFor`), at 0.34 × size; the
  filament density field is the picture.
- **Paper and Chronicle** (white skin): no tone mapping, no bloom mix, the
  light palette, size × 1.85, the analytic aura.
- **Flat layouts** (atlas, synapse, strata) lock the camera top-down: no
  auto-rotate, no drift, no depth of field, starfield × 2.2.
- **Spiral and Celestial** draw no nebula; spiral draws no cluster names.
- **Terrain and City** exist in `VIBE_PRESETS` but are not in the picker.
  `SculptedGraphLayer` draws them with private grounds (`#eee9df`, `#0a1220`)
  and lit boxes. Before either is offered again it must pass the layer probe,
  which means its notes become GraphScene's sprites.
- **Woven** (`ribbon`) routes each real link once along a strand, in two
  levels (`wovenLayout.ts`, in a worker). A fan is a clump of links (Louvain
  on the links alone, resolution 0.65, so a vault makes a few big fans), and
  every link between two fans runs in one corridor, then fans out to each
  note. Inside a fan each cluster the graph colours sits whole as its own
  sub-fan, in the fan that holds most of its notes, so its notes, its name
  and its legend row stay one region. Grouping the fans by colour alone
  (2026-10-01) gave a 2,000-note vault ~20 small fans in one round blob,
  each pair with its own thin corridor: a hairball instead of bundles. A
  fan no corridor reaches (an unlinked component, the unlinked notes) is
  pulled toward the web (`forceX`/`forceY` 0.06), so it sits at the rim
  instead of in a corner where the frame would have to reach for it. The
  fans a corridor reaches are held toward the x axis harder (`forceY` 0.25),
  and the picture is then turned so its long axis runs across the screen: a
  web that settled round or upright was framed by its height, with empty
  bands either side. The notes are world-sized (R6) and the camera frames the
  whole web, so the layout's frame sets their screen size: the frame's world
  half-height is `FRAME_HELD` 0.835 × `radius` (Layout size × 26) ×
  min(1, max(∛(frame / 13,200), (frame / 900)²)), with the frame (the notes'
  half-height, the width taken at 1.6 : 1) in layout units, where a
  sunflower step is 16. A small web's frame grows as the cube root of its
  own, because the default look's landing frame hardly grows below a few
  hundred notes; that lands the 68- and the 250-note vault at the default
  look's note size. A big web's frame is held where the 2,000-note bundles
  were tuned (held to `radius`, that vault framed at ≈ 0.84 of it), and
  between the two it eases as the frame squared. Until 2026-10-01 every
  vault was stretched to `radius` (a 68-note vault drew its notes at a third
  of the default look's size), then briefly kept one scale up to 1,100
  layout units (a 250-note vault at 0.6 of it). Each fan's gap grows with the fan and
  its charge with its area (`FAN_UNIT`, the 2,000-note vault's fan size, where
  the old 80 and −900 hold), and linked fans sit side by side, so a small
  vault's fans settle as close as a big one's. Its strands replace the
  straight links and light as they do (see [Lines](#lines)); the pulses, the
  click wave, the idle firing, the trace comet and the arrows ride them, and
  the 2 px hover and path filaments follow their curves
  (`WovenGraphLayer.strand`, `pointAlong`). It takes every shared control
  (R13) and the default look's preset, with what follows from a baked,
  bundled web: no bundle arcs, on any path to it, the Layout chip's
  included (its strands are its bundles; the drawer says so where the toggle
  sits, and `GraphScene.bundlesWanted` keeps the scene to it); no
  link-density atmosphere, which washed each
  corridor of the 2,000-note vault into one milky band that hid its strands
  (the cluster clouds and the sky stay); an idle orbit that sways ± 0.08 rad
  instead of turning, notes that do not curl-drift (so no strand end leaves
  its note) and an unlinked fan that turns instead of being captured (see
  [Motion](#motion)); and, like every baked layout, no folder galaxies,
  forces or condensation intro. Cosmic events draw only their own FX and
  move no note, so every 3D look, Woven and the other baked ones included,
  offers them on a dark ground. The camera is z-up and frames
  every note and strand vertex between the folded rails' tabs
  (`fitSculpted`; framed to the full width, a rim cluster's name slid under
  a tab); the minimap inset is not reserved, so at 1024 × 700 a rim note can
  sit under it. Its notes are the default look's pixel notes (`pixelNodes`:
  as glow stars only a core 0.375 of each sprite showed, so with the landing
  question dimming them its leaves read as 1–3 px points beside the default
  look's ~10 px discs). Until 2026-10-02 it pinned skin `black`, kept ambient
  motion, the cinematic finish, recency glow, the minimap and every effect
  off, hid 21 drawer controls (`graphControlSupport` · `composition`),
  forced its pulses and minimap off, skipped the spaceship and the MYCO
  cameo, and drew its strands at 3 × the link light.
- **Performance mode** (> 5,000 notes): one star shell, no nebula, no pulses,
  single-pass bloom in which links bloom too.

## Reference measurements

The screenshot set's `stats.md` for both questions (*Where is it empty* /
*What clumps together*), dark app theme, measured with the note labels and
cluster names hidden (see [How the set was measured](#how-the-set-was-measured)).
Ink = pixels at least 45 (sum of RGB differences) off the ground; saturation
and chroma are means over ink; hue bins = 30° bins holding ≥ 3 % of the
coloured ink. These are coarse: they confirm what the eye sees, the probe in
the test is the exact check. They also move a little between loads, because
the colour clusters come from a Louvain pass in random order with
`Math.random` (`graphData.ts` · `colorByCommunity`, `buildGraph`).

Woven's rows were re-measured on 2026-10-02, after it took the default
look's preset and every shared control (R13): its ground is the app's, so
its dark row now sits beside the default look's instead of the pinned black
skin's 4.03 / 5.57 % ink, saturation 0.26 / 0.21, chroma 24 / 30, hue bins
5 / 4 (its stats' ground reads `#171b25`: its frame is wide and the cluster
clouds cover most of it). Every other row was re-measured on 2026-10-01 with
labels hidden. The table before
it counted label text as ink: the cluster names alone gave Woven 5 / 5 hue
bins while its drawn notes and strands held 1 / 2 (measured in review on the
same frames), grey because every note
sat at the fog floor (now fixed: both fit paths derive the fog). Woven before
the 2026-10-01 rework, measured with labels: ground `#0b0c12`, ink
0.71 / 2.06 %, saturation 0.19 / 0.29, chroma 18 / 29, hue bins 3 / 5, the
clumps colour being amber cube frames around the notes. By eye, with labels
hidden: in *What clumps together* Woven's notes carry their cluster colours
and its strands their notes' hue, and the gaps panel's dotted violet bridge
hints add straight chords; in *Where is it empty* the linked notes recede (the
question's encoding), so the colour is the strands' and the question rings'.
Its ink saturation is close to the galaxy looks'; its hue bins stay below
Spiral galaxy's and its ink area below the default look's, because its
ground is a bare black skin and its strands are 1 px light. The 2026-10-01
small-vault fix (one world scale, fans side by side, sparse strands lifted)
took the row from 1.72 / 2.24 % ink, saturation 0.36 / 0.36, chroma 16 / 25,
hue bins 2 / 4, and Woven's median note sprite on this vault from 2.8–4.0
to 10.7–11.9 CSS px over five loads (default 9.7; the colour clusters, and
so the fans, change from load to load). Its second pass the same day (pixel
notes, the frame law, the web laid wide; see [Known
exceptions](#known-exceptions)) took the row from 2.8 / 5.85 % ink,
saturation 0.25 / 0.28, chroma 21 / 27, hue bins 3 / 3. Over five unseeded
loads at 1280 × 900 the median note sprite is 9.7–9.9 CSS px on this vault
(default 9.65–9.74) and 11.2–11.8 on the 250-note synthetic vault (default
11.8–12.5, where one scale drew 7.1–8.2), and the 2,000-note vault keeps
3.2–3.4 at a camera distance of 3,264–3,351 (3,273–3,308 before).

| look | ground | ink % (empty / clumps) | ink saturation (empty / clumps) | ink chroma (empty / clumps) | hue bins (empty / clumps) |
|---|---|---|---|---|---|
| default | `#0a0d13` | 17.88 / 18.18 | 0.29 / 0.27 | 16 / 17 | 8 / 3 |
| living | `#020202` | 1.11 / 1.5 | 0.3 / 0.29 | 26 / 24 | 7 / 7 |
| sigma | `#1c1c21` | 1.82 / 2.49 | 0.58 / 0.55 | 57 / 67 | 8 / 5 |
| cosmicweb | `#010203` | 0.76 / 1.09 | 0.36 / 0.24 | 20 / 15 | 2 / 2 |
| neural | `#000000` | 1.12 / 1.85 | 0.37 / 0.33 | 30 / 32 | 7 / 6 |
| planetarium | `#010101` | 1.32 / 1.75 | 0.28 / 0.29 | 28 / 31 | 7 / 7 |
| paper | `#ffffff` | 1.9 / 2.88 | 0.01 / 0.03 | 2 / 5 | 0 / 1 |
| chronicle | `#ffffff` | 3.77 / 4.15 | 0.01 / 0.03 | 3 / 5 | 2 / 2 |
| nebula | `#020202` | 9.17 / 10.45 | 0.42 / 0.2 | 21 / 11 | 7 / 7 |
| walrus | `#000000` | 1.32 / 1.84 | 0.53 / 0.48 | 36 / 38 | 3 / 3 |
| mycelium | `#0d0a12` | 12.35 / 12.69 | 0.14 / 0.14 | 11 / 23 | 5 / 5 |
| ribbon | `#171b25` | 16.98 / 18.4 | 0.46 / 0.42 | 15 / 17 | 8 / 5 |
| default, light theme | `#fefefe` | 1.88 / 3.52 | 0.04 / 0.11 | 9 / 24 | 6 / 2 |
| ribbon, light theme | `#fefefe` | 3.41 / 6.35 | 0.04 / 0.08 | 9 / 18 | 7 / 2 |
