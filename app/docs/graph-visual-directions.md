# Graph visual art directions

Updated on 2026-09-18. Contour terrain, Folded ribbon, and Block city are now
implemented as separate spatial arrangements and solid renderers. The generated
approval images were concept studies, not pixel-exact implementation contracts.
Earlier material-only Aurora, Hologram, and Chrome studies were rejected because
they kept the same point-cloud composition.

## Scope

Keep the same notes, explicit relationships, selection, filters, and navigation.
Develop a recognizable visual identity for each look. Composition may change,
but a new look must not invent connections or turn notes into aggregate charts.
The previous proposals for note browsing, chord diagrams, tag intersections,
and connection tables did not address this visual request and are superseded.

Use actual note nodes to form the scene. Keep each note individually selectable.
Do not add fake galaxy nodes, a decorative central galaxy, or an independent
spiral band that substitutes for the real note composition. Light and surface
effects must support the real graph and keep labels readable.

## Art direction for the existing ten looks

These are refinement targets. The table is not a claim that every effect below
is already supported by the renderer or can be enabled with a preset value.

### Implemented refinement pass

- Spiral galaxy now uses thinner, more open arms and an inclined initial camera.
  The notes themselves make the silhouette; there are no decorative galaxy nodes.
- Spiral galaxy and Planetarium no longer share the meaning nebula's cloud and
  blurred-link atmosphere. Dark lanes and constellation strokes remain visible.
- Cosmic web's link-visibility control now updates its density shader; previously
  it changed only the hidden ordinary-line material. Its default stars and links,
  plus Neural's node cores and links, are quieter at dense vault sizes.
- The void and grid backgrounds no longer leave a residual decorative starfield.
- Planetarium uses smaller stars without the cinematic grain; Mycelium's preset
  pairs a dark violet ground with pale violet notes and muted violet threads.
  Analysis questions can still recolor notes to communicate their answers.
- Sigma, Paper atlas, Chronicle, Walrus, Terrain, Ribbon, and City keep their
  distinct geometry and existing calibrated defaults in this pass.

The synthetic scale check used 2,500 notes and 7,381 explicit links across all
13 looks on Apple M3 Metal, without opening a personal vault. It preserved every
node and finite coordinates, with no browser errors. Most looks measured about
52–60 fps, Meaning nebula 46.8 fps, and Cosmic web 24 fps (p95 83.5 ms) while the
host was under concurrent load. A separate same-scene Cosmic web check then
measured 60.19 and 60.10 fps at full resolution (p95 17.7 and 17.6 ms). Reducing
the density target to 75% or 50% did not improve that baseline, so no resolution
reduction was shipped. These are measured browser results, not native WKWebView
guarantees or an assertion that the frame budget passes everywhere.
Dense arbitrary cross-links still form a dense centre; the renderer does not
invent sparse relationships to imitate a reference image.

Actual pointer picking on a visible Ribbon tile opened the matching note's
Inspector. A projected centre behind the folded surface correctly returned no
note in the earlier one-sample probe; picking does not pass through the surface.

Actual before/after captures and measurements are under
`output/graph-look-previews/2026-09-17-refinement/` at the repository root.
Reproduce with `MYCO_TEST_URL=http://127.0.0.1:5187 node
scripts/graph-look-profile.mjs 2500` after starting the development server.

| Look | Visual identity to strengthen | Adjustment priorities |
| --- | --- | --- |
| Spiral galaxy | A thin, tilted stellar disc with recognizable spiral arms formed by actual notes | Arm definition, disc thickness, viewing angle, small star cores, restrained halos and subdued links |
| Cosmic web | Long, fine luminous filaments, small bright junctions, and large dark gaps | Filament contrast, sparse glow, depth, and a wider camera composition |
| Neural | Organic branching fibers with small luminous cell bodies | Tapered-looking strokes, restrained color, localized light pulses, and clear foreground/background separation |
| Meaning nebula | Soft, irregular colored volumes surrounding distinct note lights | Haze opacity, overlapping color depth, crisp note cores, and very quiet links |
| Planetarium | A clean night-sky chart with precise stars and delicate constellation-like strokes | Star size hierarchy, restrained halos, smooth camera movement, and readable selected labels |
| Mycelium | Matte dark fibers with violet light at tips and junctions | Organic strand texture, shallow depth, sparse breathing light, and the MYCO violet palette |
| Sigma | A precise dark technical map | Fine strokes, small points, strong selection contrast, and stable framing |
| Paper atlas | Ink-like dots and fine lines on warm paper | Muted color, restrained line weight, quiet texture, and crisp labels |
| Chronicle | Clean horizontal layers with a calm editorial appearance | Layer separation, limited depth, aligned visual rhythm, and gentle transitions |
| Walrus tree | A legible sculptural branching form | Branch silhouette, depth separation, controlled perspective, and subdued distant branches |

### Reference anchors

- **Spiral galaxy:** ESA/Hubble describes and illustrates a disc, central region,
  and spiral arms. Use the silhouette as a composition reference; it does not
  justify adding a fabricated central object to MYCO.
  [ESA/Hubble spiral galaxies](https://esahubble.org/wordbank/spiral-galaxy/).
- **Cosmic web:** NASA's images and animation show bright knots and filamentary
  structure separated by dark regions. The proposed MYCO direction emphasizes
  that fine structure rather than a uniformly filled cloud.
  [NASA: Mapping the Cosmic Web](https://science.nasa.gov/mission/hubble/science/science-highlights/mapping-the-cosmic-web/).
- **Neural:** FlyWire's neuron renders provide a reference for organic branching
  silhouettes and fine fibers. Animated pulses in MYCO would be a visual effect,
  not a claim that notes behave like measured biological activity.
  [FlyWire gallery](https://join.flywire.ai/gallery).

## Approved spatial looks

### Surface and readability refinement — 2026-09-18

- Terrain now has distinct ridges and valleys, major/minor contours, lit chalk
  material, layered cutaway sides, a bevelled base, and quieter note colours.
- Ribbon uses an open, raised fold with changing surface normals, satin shading,
  restrained iridescence, and a thin visible edge. Smaller inlaid note tiles
  leave the surface visible instead of covering it with a pastel mosaic.
- City arranges the actual high-degree notes near each district's centre, leaves
  room for streets, and uses dark facades with window detail and a grounded base.
  Windows are material decoration, not additional data points. Building height
  remains monotonic in degree within the current graph.
- Standard lighting and filmic tone mapping preserve bright surface detail.
  Materials use Three.js's [physically based shading](https://threejs.org/docs/pages/MeshStandardMaterial.html)
  and [physical surface extensions](https://threejs.org/docs/pages/MeshPhysicalMaterial.html).
- All explicit links remain in the renderer. Per-edge transparency decreases
  with edge count to prevent accumulated lines from obscuring the surface.
  Selecting a note raises its incident-link contrast and quiets other links;
  hidden endpoints contribute no visible lines. The visibility control still
  scales the resulting opacity. City links attach to transformed rooftops.

Actual before/after screenshots and verification are recorded under
`output/graph-look-previews/2026-09-18-quality/` at the repository root. These are
renders of synthetic notes from the implemented app, not generated concept art.

### Contour terrain

Real notes appear as small tiles on a continuous relief map. Community groups
occupy distinct regions, with contour lines describing the surface. Existing
links follow the heightfield; the terrain does not add synthetic note links.
Elevation is a visual arrangement, not a claim about note importance or accuracy.

### Folded ribbon

Real notes occupy lanes across a broad folded surface. The ribbon is a stable,
deterministic layout with depth and turns; it is not a chronological axis or an
inferred relationship. Existing links connect the note tiles across the surface.

### Block city

Each note is a separate rectangular column in a community district. Base column
height follows graph degree; the selected question and size channel still affect
note emphasis. Links within a district follow low paths, while cross-district
links rise above the ground. Floors are a layout scaffold, not additional notes.

## Interaction and controls

The three looks retain note picking, selection, search, filtering, question
encoding, shortest-path emphasis, and hidden-note state during timelapse. Solid
note outlines preserve the status shape channel. Fit-to-view uses the rendered
geometry, including enlarged columns, instead of clipping the far ends of the
surface or shrinking a folded shape to fit empty bounding-box corners.

Their settings expose note size, link visibility, note-name visibility, layout
size, and idle orbit. Cosmic effects, star sprites, flying arrows, simulation
forces, and other unsupported controls are absent. Reduced motion disables idle
orbit. Keyboard input inside the drawer does not trigger graph flight shortcuts.

## Earlier visual references

The earlier light/material studies remain research references, not additional
shipped looks:

- [Dreamy particles — Dominik Fojcik](https://tympanus.net/codrops/2024/12/19/crafting-a-dreamy-particle-effect-with-three-js-and-gpgpu/)
- [Hologram — Bruno Simon](https://threejs-journey.com/lessons/hologram-shader)
- [Reflective surfaces — Three.js](https://threejs.org/examples/webgl_marchingcubes.html)

The approval criterion is a visibly different composition and geometry, at the
level of the existing Sigma, Walrus tree, and Mycelium styles. A palette or glow
change over the same arrangement does not meet it. Generated images alone do
not establish graph correctness, runtime performance, or interaction quality;
those require tests against the implemented renderer.
