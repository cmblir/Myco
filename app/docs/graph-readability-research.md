# Graph readability research and implementation

2026-09-21. Scope: preserve the thirteen existing visual identities while making
individual notes and actual relationships easier to read. The user explicitly
chose to retain terrain, ribbon and city rather than replace them with identical
force-directed layouts.

## Evidence and Jev

The TypeSafe skill and live API, Choice and citation-check documentation were
read. Jev evaluates supplied evidence; it does not retrieve web sources or inspect
screenshots. Only public-source summaries and implementation facts were sent;
no vault contents or credentials were included in the request artifact.

- [Sigma appearance documentation](https://www.sigmajs.org/docs/advanced/customization/):
  neighborhood emphasis and labels support graph exploration.
- [yFiles edge routing](https://www.yfiles.com/resources/how-to/automatic-drawing-of-links-in-graphs-and-networks):
  node positions can remain fixed while edge routes change to improve readability.
- [TypeSafe HTTP API](https://docs.typesafe.ai/api): typed questions over supplied state.

The actual response model was `jev-1.13.0` through `jev-latest`. It selected the
node/relationship-first proposal and individual-edge focus over immediate bundling
(both Choice confidence 1.0). These are judgments over a small supplied candidate
set, not measured usability or visual quality. Its Noul answers were 0.61 for city
occlusion and 0.26 for label prioritization. The latter did not support our label
hypothesis; source inspection and regression tests, rather than model agreement,
determine the implementation. Request and raw response are saved under
`output/graph-readability/2026-09-21/` at the repository root.

## Findings and changes

1. The sculpted renderer reduced ordinary edge opacity towards zero as edge count
   grew. Retain density scaling but give individual edges a visible floor. Draw
   their strokes above surfaces; selected real edges receive a separate overlay.
   This intentionally trades physical depth occlusion for relationship tracing.
2. Intra-district city links descended to near ground level. Route them above
   their endpoint rooftops, with higher routes between districts. This is not a
   full obstacle-avoiding router; other buildings can still overlap in projection.
3. Sculpted notes competed with surface materials. Lift terrain/ribbon tiles,
   retain more community color, reduce terrain relief and city height, and make
   ribbon material quieter. Preserve the existing minimum relief and spacing tests.
4. Selection now prioritizes the selected note and a bounded set of neighboring
   names in the common renderer, including notes below the overview size gate.
   Existing labels that fail a later visibility/collision gate are hidden again.
   Light backgrounds receive light label halos. Sculpted label offsets use tile
   width rather than the unrelated star-glow diameter.
5. Mycelium has a separate renderer: its label candidates now follow the focused
   neighborhood, and selection remains highlighted after the pointer leaves.
   Its actual hyphal routes remain intact.

| Looks | Readability treatment | Identity preserved |
| --- | --- | --- |
| Spiral galaxy, cosmic web, neural, planetarium, meaning nebula | Selected-neighborhood labels with bounded collision handling | Existing stellar, filament and atmosphere treatments |
| Sigma, paper atlas, chronicle, Walrus tree | Same selection labels; readable light-background halos | Technical, paper, temporal and tree arrangements |
| Mycelium | Focused neighborhood names and persistent selection emphasis | Grown mat and routes along actual hyphae |
| Terrain | Raised colored tiles, lighter contour emphasis, legible edge overlay | Relief and contour map |
| Ribbon | Raised tiles, quieter surface, visible relationships across folds | Open folded strip |
| City | Lower towers, rooftop routes and selection overlay | Districts, streets and degree-based skyline |

No relationship is invented or deleted. Hidden endpoints do not contribute focus
strokes. Existing search, path, encoding, picking and framing semantics remain
covered by the sculpted tests. The app has no new TypeSafe runtime dependency.

## Validation

- Full unit suite: 181 files, 1,962 tests passed. After the final label-threshold
  adjustment, the focused renderer/label suite passed 46 tests, including one
  additional test proving the sculpted label slider remains effective.
- Final production build (`tsc -b && vite build`): passed.
- ESLint: zero errors; two existing hook-dependency warnings in `notchDriver.ts`.
- All thirteen looks: synthetic 2,500 notes and 7,381 relationships preserved;
  finite coordinates and no browser errors. The same 250-note interaction pass
  verified selected names in twelve GraphScene looks and persistent selected
  label candidates after hover leaves in the separate Mycelium renderer.
- Terrain/Ribbon/City: verified actual picking, Inspector selection, real node and
  edge identities, and reduced-motion camera stability at 250 and 2,500 notes.
  Final dense measurements were 60.4 / 60.2 / 54.2 fps on Apple M3 Metal. These
  are browser snapshots under shared host load, not native performance guarantees.
- Full overview profiling sampled one occluded terrain tile that correctly did
  not pick through its opaque surface; the dedicated picking checks search for
  an actually visible tile and passed.
- Evidence: `final/250`, `final/2500`, `all-looks-2500`, and `interaction` beneath
  `output/graph-readability/2026-09-21/`. Screenshots use synthetic notes only.
- No native app installation, release packaging, commit or push was performed.
