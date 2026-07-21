// Graph view settings — persisted to localStorage so the user's slider
// positions survive reloads. Mirrors Obsidian's graph settings panel:
// Filters / Display / Forces. Field names and value ranges follow the
// `obsidian-typings` `GraphPluginInstanceOptions` interface so behaviour
// matches the real Obsidian sliders unit-for-unit. References:
//   - github.com/Fevol/obsidian-typings
//   - github.com/ElsaTam/obsidian-extended-graph (default values)
//   - github.com/ycnmhd/obsidian-graph-presets (slider ranges)

// Kept here (not graphTheme.ts) so this module stays DOM-free and testable.
export type GraphSkinKey = "auto" | "black" | "white" | "galaxy" | "web" | "sigma";

export interface GraphSettings {
  // Filters
  search: string;
  showOrphans: boolean;
  existingOnly: boolean;
  tagFilter: string | null;
  folderFilter: string | null;

  // Display
  // Graph-only color mode, independent of the app theme. "auto" follows the
  // app theme (the pre-skin behaviour); the fixed skins pin the palette.
  skin: GraphSkinKey;
  // Multi-galaxy layout: group notes by folder (falling back to Louvain
  // communities on flat vaults) and pull each group to its own anchor on a
  // wide ring, with a slow per-galaxy idle rotation — several living galaxies
  // instead of one central mass.
  folderGalaxies: boolean;
  // Layout engine. "galaxy" = the 3D force sim (default); "atlas" = a static
  // 2D ForceAtlas2 map with translucent per-community territory fills (Gephi
  // look); "synapse" = a static 2D nervous-system map — communities flung far
  // apart as separate bright cores (ganglia) joined by long glowing nerve-fibre
  // bridges; "synapse3d" = the same nervous-system RENDERING (nerve fibres +
  // rapid firing) but over the live 3D force sim, so you can orbit and fly
  // through it.
  // "spiral" = a static log-spiral galaxy (the cosmic-refs Andromeda/M101
  // form): communities along the arms, biggest at the core. "strata" = a
  // static 2D time chart: x = last-modified (oldest left), y = community band.
  layout: "galaxy" | "atlas" | "synapse" | "synapse3d" | "spiral" | "strata" | "semantic" | "celestial" | "radial";
  // Multiverse mode: instead of this one vault, show EVERY registered project
  // as its own glowing universe-bubble in one shared cosmos. Fly into a bubble
  // to switch the active vault (which turns this back off, landing you in that
  // project's normal graph). Only meaningful when a project registry exists
  // above the vault; otherwise the toggle shows a single bubble.
  multiverse: boolean;
  // Background appearance in 3D (galaxy / synapse3d). "stars" = the classic
  // multi-shell parallax field; "dense" = a fuller star field on every side;
  // "grid" = a dark dotted grid backdrop (the big-data-viz look); "void" = an
  // (almost) empty black sky. 2D layouts always use the full field.
  skyStyle: "stars" | "dense" | "grid" | "void";
  // Node colouring. "community" = folder/cluster hues; "white" = monochrome
  // starlight; "black" = monochrome ink (the only visible mono on the white
  // skin); "auto" = theme-appropriate mono until the vault grows past
  // monoBelow nodes, then community hues kick in.
  nodeColor: "community" | "white" | "black" | "auto";
  monoBelow: number; // "auto": node count below this → mono; at/above → colour
  // Node colour depth — a gamma on the star colour. 1 = as-is; >1 darkens /
  // deepens (raise it so community colours read on the white skin, where pale
  // hues otherwise vanish); <1 lightens. Applies to community + black inks.
  nodeColorDepth: number;
  // Edge colouring. "grey" = neutral connective tissue (signal lives in the
  // stars); "community" = full community-hue edges — dense clusters read as
  // coloured translucent webs/veils (the classic Gephi hairball look). The
  // nervous-system nerve-fibre edge look lives in the "synapse" LAYOUT, not
  // here.
  edgeTint: "grey" | "community";
  arrows: boolean;
  arrowSize: number; // arrowhead cone scale, 0.1..1.5 — kept well under node size
  semanticEdges: boolean; // overlay embedding-similarity edges (dim, dashed)
  // Bundled inter-community strands (GRAPH-01): collapse all links between the
  // same two topic clusters into one weight-tiered glowing arc, so the vault's
  // topic-to-topic structure survives the per-cluster separation.
  edgeBundles: boolean;
  textFadeThreshold: number; // zoom level at which labels appear (0.1..3)
  nodeSize: number; // multiplier 0.5..3
  linkThickness: number; // 0.3..3
  brightness: number; // "Glow" slider, 0.4..1.6 — scene exposure (light intensity)
  // One switch for ALL idle motion (auto-rotate, edge pulses, star breathing) —
  // the spec's motion budget gives ambience a single opt-out instead of three.
  ambientMotion: boolean;
  // Recency glow: recently edited notes burn a touch hotter, untouched ones
  // cool — the vault reads as a map of the owner's current attention.
  recencyGlow: boolean;
  // Galaxy chart minimap: a corner inset of the whole graph with a marker for
  // the camera — the antidote to getting lost in free 3D flight.
  minimap: boolean;
  // Cinematic finish: FXAA + film grain + vignette + a whisper of chromatic
  // aberration, plus anamorphic streaks on the brightest cores. The "shot on
  // a camera" grade over the raw render.
  cinematic: boolean;
  // Edge flow pulses: a narrow light band rides each link source → target on
  // the ambient clock — citation direction as ambient motion. Auto-muted when
  // the flying-arrow fleet is on (one directional signal at a time).
  edgeFlow: boolean;
  // Mascot cameo: MYCO (the planet mushroom) drifts into the graph on a rare
  // timer with a one-line feature tip. The graph cosmos is a play space, so a
  // gentle guide reads as welcome, not a Clippy nag; still opt-out here, and it
  // never appears under reduced motion.
  mascotCameo: boolean;
  // Cosmic events (black hole / wormhole) on the dark skin — a separate opt-out
  // from ambientMotion because they're the most attention-grabbing FX.
  cosmicEvents: boolean;
  // How often cosmic events fire — a multiplier on the idle cadence (0.25 =
  // quarter as often, 3 = 3× as often). 1 = the default ~40–120 s rhythm.
  cosmicFrequency: number;
  // Click burst: the supernova detonation + neural wave when a node is
  // selected. The "팡팡 터지는" accent — opt out for a calmer graph.
  clickBurst: boolean;
  // Spontaneous neural firings — signals that periodically ripple the mesh
  // (and travel the fibres in synapse mode). Opt out for a still graph.
  neuralFiring: boolean;
  // Near-field LOD planets — when the camera is close, the nodes nearest it
  // resolve into small procedural planet spheres (rocky/gas/ice/ringed), tinted
  // by community hue; far nodes stay cheap star points. Dark 3D layouts only,
  // perf-gated. Off by default (novelty + fragment-cost sensitive).
  nearFieldPlanets: boolean;
  // Timelapse playback speed multiplier (0.25×..4×). Read live each frame, so
  // dragging the slider mid-replay speeds the assembly up or down in place.
  tlSpeed: number;

  // Forces — names and ranges mirror Obsidian's `ForceOptions`.
  centerForce: number; // 0..1 — center pull strength (Obsidian: centerStrength)
  repelForce: number; // 0..20 — node repulsion (Obsidian: repelStrength)
  linkForce: number; // 0..1 — link spring stiffness (Obsidian: linkStrength)
  linkDistance: number; // 30..500 — ideal edge length (Obsidian: linkDistance)
  clusterForce: number; // 0..1 — per-community clump tightness (galaxy clustering)
}

// Defaults are slider values (matching Obsidian's panel) — they are
// scaled inside runLayout() to the actual d3-force numbers Obsidian
// uses internally. The mapping there is:
//   manyBodyStrength = -repelForce  × 100
//   xStrength/yStrength =  centerForce × 0.1   (linear, not log)
//   linkStrength = linkForce / sqrt(min(deg(a), deg(b)))   (per link)
// That scaling is what produces discrete dandelion clusters on
// vaults of any size; an 800-node tree with the old linear mapping
// crushed every cluster into a single hairball.
export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
  search: "",
  showOrphans: true,
  existingOnly: false,
  tagFilter: null,
  folderFilter: null,
  skin: "auto",
  folderGalaxies: true,
  layout: "galaxy",
  multiverse: false,
  skyStyle: "stars",
  arrows: false,
  arrowSize: 1, // arrowhead/flying-ship scale (bumped from 0.35 on request)
  semanticEdges: false,
  edgeBundles: true,
  textFadeThreshold: 1.1,
  nodeSize: 1,
  linkThickness: 1,
  brightness: 0.9, // exposure headroom: the void stays black, only emitters survive
  ambientMotion: true,
  recencyGlow: true,
  minimap: true,
  cinematic: true,
  edgeFlow: true,
  mascotCameo: true,
  cosmicEvents: true,
  cosmicFrequency: 1,
  clickBurst: true,
  neuralFiring: true,
  nearFieldPlanets: false,
  tlSpeed: 1,
  nodeColor: "community",
  monoBelow: 200,
  nodeColorDepth: 1,
  edgeTint: "grey",
  // GALAXY/BRAIN defaults: range-capped LOCAL repulsion (no global outward
  // pressure → no firework spikes) + firm centre gravity collapse the vault into
  // ONE cohesive luminous mass, while community clustering contracts each Louvain
  // group into a tight coloured nucleus (a galaxy star-cluster / brain lobe).
  // Short links keep nuclei compact; the few inter-lobe links thread them into a
  // single interwoven web instead of separate exploding dandelions.
  centerForce: 0.5, // → firm uniform gravity packs the lobes into one galaxy
  repelForce: 9, // → per-node charge ≈ -81, range-capped to LOCAL neighbours
  linkForce: 0.45, // → soft springs (strong springs reel nodes into clumps)
  linkDistance: 45, // → short edges → compact nuclei, not a wide spoke-ring
  // mesh↔galaxy knob: 0 = homogeneous Obsidian-style web; >0 contracts Louvain
  // communities into coloured nuclei. 0.35 = distinct lobes threaded as one
  // galaxy; 0.5 compressed the nuclei so hard the spokes read purely radial —
  // half the starburst look (calm-cosmic-web spec A3).
  clusterForce: 0.35,
};

// v26: calm-cosmic-web Phase 1 (clusterForce 0.35, degree-based link distances,
// log node sizes). Bumping the key drops stale persisted slider positions so
// the recalibrated defaults apply instead of the old firework-era ones.
// (ambientMotion arrived later without a bump — loadGraphSettings back-fills
// missing fields from defaults, so additive fields never need one.)
const KEY = "memex.graph.settings.v26";

// Layout presets (spec B4): three curated force profiles replace slider
// twiddling for most users; the raw sliders live on under "Advanced". Each is a
// FULL force tuple so applying one always lands on a known-good layout.
export type LayoutPresetKey = "galaxy" | "loose" | "dense";
export const LAYOUT_PRESETS: Record<
  LayoutPresetKey,
  Pick<
    GraphSettings,
    "centerForce" | "repelForce" | "linkForce" | "linkDistance" | "clusterForce"
  >
> = {
  // The tuned default.
  galaxy: {
    centerForce: DEFAULT_GRAPH_SETTINGS.centerForce,
    repelForce: DEFAULT_GRAPH_SETTINGS.repelForce,
    linkForce: DEFAULT_GRAPH_SETTINGS.linkForce,
    linkDistance: DEFAULT_GRAPH_SETTINGS.linkDistance,
    clusterForce: DEFAULT_GRAPH_SETTINGS.clusterForce,
  },
  // Airy, Obsidian-ish web — clusters barely gathered, long links.
  loose: {
    centerForce: DEFAULT_GRAPH_SETTINGS.centerForce,
    repelForce: DEFAULT_GRAPH_SETTINGS.repelForce,
    linkForce: DEFAULT_GRAPH_SETTINGS.linkForce,
    linkDistance: 70,
    clusterForce: 0.15,
  },
  // Tight nuclei, short links — the pre-Phase-1 compressed look.
  dense: {
    centerForce: DEFAULT_GRAPH_SETTINGS.centerForce,
    repelForce: DEFAULT_GRAPH_SETTINGS.repelForce,
    linkForce: DEFAULT_GRAPH_SETTINGS.linkForce,
    linkDistance: 34,
    clusterForce: 0.5,
  },
};

// Recommended settings PER LAYOUT — one click lands the graph on a tuned look
// for whichever engine is active (the raw sliders + toggles that make each
// layout read its best). Applied over the current settings by the "Recommend"
// button. Only the fields that matter for the look are set; everything else is
// left as the user had it.
// Values researched from force-directed / ForceAtlas2 / Gephi / neural-viz
// practice (see plans/ recommended-settings research). Family logic: edges
// grey on all four (colour lives in nodes / hull fills / fibre brightness);
// nodeColorDepth rises with the medium (dark-3D luminous < 2D paper); the two
// sim layouts carry the force tuple, the two FA2 maps don't (forces are inert
// for them); living (galaxy/synapse/synapse3d) vs static print map (atlas).
export const LAYOUT_RECOMMENDED: Record<
  GraphSettings["layout"],
  Partial<GraphSettings>
> = {
  // 3D galaxy — the calm cosmic web: compact luminous community nuclei threaded
  // into one galaxy by faint grey filaments. Short cohesive links + local-range
  // repulsion (spread-but-cohesive, no firework spokes); bundled inter-cluster
  // strands read as bridges; cosmic events supply the signature life. (Research
  // suggested neuralFiring off for "calm"; kept on to honour the living-galaxy
  // identity — one toggle either way.)
  galaxy: {
    ...LAYOUT_PRESETS.galaxy, // c0.5 r9 l0.45 d45 cl0.35
    folderGalaxies: true,
    edgeTint: "grey",
    edgeBundles: true,
    nodeColor: "community",
    nodeColorDepth: 1,
    cosmicEvents: true,
    cosmicFrequency: 1,
    clickBurst: true,
    neuralFiring: true,
  },
  // Atlas — the Gephi territory map: a settled print-like 2D spatialisation
  // where each community reads as a distinct filled hull. Wide world (linkDist
  // 90) opens whitespace gutters between hulls; deep colour (1.5) so pale hues
  // survive on paper; no bundles/FX (static map); folderGalaxies off (FA2 does
  // the spatial community split itself).
  atlas: {
    // linkDistance IS read by the FA2 path (it sets targetRadius); the other
    // force-tuple fields are not — atlas runs applyAtlasLayout, not the worker
    // sim. clusterForce was set here and it is inert on atlas, but the settings
    // are shared, so it wrote 0.45 into the value galaxy/synapse3d DO read: click
    // Recommend on atlas, switch back to galaxy, and its tuned 0.35 was silently
    // gone. So set only what atlas reads. (See the FA2-purity test.)
    linkDistance: 90,
    folderGalaxies: false,
    edgeTint: "grey",
    edgeBundles: false,
    nodeColor: "community",
    // Gamma touches the node DOTS only (u_colorDepth lives in NODE_FRAG; hull
    // fills sample raw a.color and never respond to it). 1.4 keeps white-skin
    // dot contrast without over-darkening the same map on the dark skin —
    // 1.5 was tuned to a claim ("keeps the fills saturated") that isn't true.
    nodeColorDepth: 1.4,
    cosmicEvents: false,
    clickBurst: false,
    neuralFiring: false,
  },
  // Synapse 2D — flat nervous system: bright ganglia cores joined by nerve-fibre
  // bridges. Bundled strands = nerve bundles; neural firing so signals travel;
  // deep colour (1.3) so the fibres read on the flat map.
  synapse: {
    linkDistance: 60,
    edgeTint: "grey",
    edgeBundles: true,
    nodeColor: "community",
    nodeColorDepth: 1.3,
    neuralFiring: true,
    clickBurst: true,
    cosmicEvents: false,
    // Both 2D maps: hulls/ganglia come from Louvain communities, not the one
    // dominant folder a real vault usually has.
    folderGalaxies: false,
  },
  // Synapse 3D — the nervous system in space: ganglia float and separate (looser
  // forces + higher repulsion + folderGalaxies), nerve-fibre bridges + firing;
  // cosmic events OFF so a wormhole never yanks the ganglia mid-read.
  synapse3d: {
    centerForce: 0.45,
    repelForce: 10,
    linkForce: 0.4,
    linkDistance: 70,
    clusterForce: 0.45,
    folderGalaxies: true,
    edgeTint: "grey",
    edgeBundles: true,
    nodeColorDepth: 1.15,
    neuralFiring: true,
    clickBurst: true,
    cosmicEvents: false,
  },
  // The static layouts never run the worker sim, so the force tuple is
  // deliberately absent (the FA2-purity rule: never write a value only OTHER
  // layouts read). cosmicEvents stay off everywhere positions are baked — a
  // wormhole would yank nodes with no sim to pull them home.
  //
  // Spiral — a 3D galactic disc whose ARMS are the topics (whole communities
  // laid contiguously along each arm). Hue is what makes an arm read as one
  // topic, so community colour is mandatory; depth 1.0 keeps the additive
  // dark-3D glow luminous (same logic as galaxy). Grey edges: the arm shape
  // already encodes topic adjacency, coloured edges would veil it. Firing off:
  // a static disc is calm; life comes from drift/twinkle + the click supernova.
  spiral: {
    folderGalaxies: false,
    edgeTint: "grey",
    edgeBundles: false,
    nodeColor: "community",
    nodeColorDepth: 1,
    neuralFiring: false,
    cosmicEvents: false,
  },
  // Strata — a print-like 2D time chart (the atlas of WHEN): x is history,
  // bands are topics. Family line for flat maps: colour lives in the node dots
  // (community, deepened 1.3 so dots read on paper), edges stay grey tissue —
  // coloured edges arcing across bands would double-encode topic AND fake
  // temporal relations. All FX off: like atlas, its affordance is a still
  // chart you can study; a supernova on a timeline is tonal noise.
  strata: {
    folderGalaxies: false,
    edgeTint: "grey",
    edgeBundles: false,
    nodeColor: "community",
    nodeColorDepth: 1.3,
    clickBurst: false,
    neuralFiring: false,
    cosmicEvents: false,
    arrows: false,
  },
  // Semantic map — a 3D meaning-nebula (top-3 principal components): position
  // IS meaning, so the similarity-edge overlay is redundant by construction;
  // wikilink edges stay (grey) as the explicit structure draped over
  // meaning-space. Community hue on the stars is the interesting read: where
  // link-communities DISAGREE with embedding neighbourhoods, the nebula shows
  // it. Dark-3D luminous depth (1.15); baked positions → FX off.
  semantic: {
    folderGalaxies: false,
    edgeTint: "grey",
    edgeBundles: false,
    semanticEdges: false,
    nodeColor: "community",
    nodeColorDepth: 1.15,
    clickBurst: true,
    neuralFiring: false,
    cosmicEvents: false,
  },
  // Celestial sphere — the vault as a planetarium: every note on one shell,
  // each topic a constellation patch, hubs at patch centres. Community hue IS
  // the constellation identity; luminous dark-3D depth; grey edges read as
  // constellation lines (intra) and chords through the void (inter). Baked →
  // FX off; firing off (a night sky is still); click supernova kept — poking
  // a star should still delight.
  celestial: {
    folderGalaxies: false,
    edgeTint: "grey",
    edgeBundles: false,
    nodeColor: "community",
    nodeColorDepth: 1,
    clickBurst: true,
    neuralFiring: false,
    cosmicEvents: false,
  },
  // Radial orbit — a solar system around the vault's heaviest hub: BFS-depth
  // shells, disconnected notes in the outermost orbit. Distance from centre is
  // the ONE encoded meaning, so edges stay grey tissue and bundles stay off
  // (arcs would fake orbital relations). Baked → FX off.
  radial: {
    folderGalaxies: false,
    edgeTint: "grey",
    edgeBundles: false,
    nodeColor: "community",
    nodeColorDepth: 1,
    clickBurst: true,
    neuralFiring: false,
    cosmicEvents: false,
  },
};

// ── One-click looks ("vibes") ────────────────────────────────────────────
// A vibe bundles skin + layout + that layout's recommended settings into a
// single toggle, so the whole personality of the graph changes with one tap.
// Each spreads LAYOUT_RECOMMENDED so a vibe never drifts from the per-layout
// research; the few extra overrides are the vibe's own signature.
export type VibeKey =
  | "living"
  | "sigma"
  | "cosmicweb"
  | "neural"
  | "planetarium"
  | "paper"
  | "chronicle"
  | "nebula";

export const VIBE_PRESETS: Record<VibeKey, Partial<GraphSettings>> = {
  // The default identity: the living galaxy.
  living: { skin: "auto", layout: "galaxy", ...LAYOUT_RECOMMENDED.galaxy },
  // The classic sigma.js / Gephi hairball: a flat ForceAtlas2 continent of
  // vivid community colour, curved coloured edges over a charcoal board. The
  // reference is a SPREAD 2D map (distinct colour regions joined by arcs), not
  // a collapsed galaxy ball — so it rides the atlas layout, and the community
  // hue carries both nodes and the edge veil (edgeTint: community).
  sigma: {
    skin: "sigma",
    layout: "atlas",
    ...LAYOUT_RECOMMENDED.atlas,
    edgeTint: "community",
    cosmicEvents: false,
    neuralFiring: false,
  },
  // Dark-matter simulation: filaments carry the picture.
  cosmicweb: { skin: "web", layout: "galaxy", ...LAYOUT_RECOMMENDED.galaxy, cosmicEvents: false },
  // Firing nervous system in space, on the void-black board.
  neural: { skin: "black", layout: "synapse3d", ...LAYOUT_RECOMMENDED.synapse3d },
  // Inside the star globe: constellations per topic, full deep-space dressing.
  planetarium: { skin: "galaxy", layout: "celestial", ...LAYOUT_RECOMMENDED.celestial },
  // A settled print-like territory map on paper.
  paper: { skin: "white", layout: "atlas", ...LAYOUT_RECOMMENDED.atlas },
  // The vault as readable history — time strata on paper.
  chronicle: { skin: "white", layout: "strata", ...LAYOUT_RECOMMENDED.strata },
  // The meaning-nebula: notes cluster by embedding, community stars on void.
  nebula: { skin: "black", layout: "semantic", ...LAYOUT_RECOMMENDED.semantic },
};

// Which preset (if any) the current force values correspond to — drives the
// active state on the preset chips.
export function matchPreset(s: GraphSettings): LayoutPresetKey | null {
  for (const key of Object.keys(LAYOUT_PRESETS) as LayoutPresetKey[]) {
    const p = LAYOUT_PRESETS[key];
    if (
      s.centerForce === p.centerForce &&
      s.repelForce === p.repelForce &&
      s.linkForce === p.linkForce &&
      s.linkDistance === p.linkDistance &&
      s.clusterForce === p.clusterForce
    ) {
      return key;
    }
  }
  return null;
}

export function loadGraphSettings(): GraphSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_GRAPH_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<GraphSettings>;
    return { ...DEFAULT_GRAPH_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_GRAPH_SETTINGS };
  }
}

export function saveGraphSettings(s: GraphSettings): void {
  try {
    // Don't persist the search box — it's transient.
    const { search: _ignored, ...rest } = s;
    void _ignored;
    localStorage.setItem(KEY, JSON.stringify(rest));
  } catch {
    /* quota or disabled — ignore */
  }
}

// ── User-saved looks ──────────────────────────────────────────────────────
// The eight built-in vibes are curated starting points; a saved look is the
// user's OWN tuned configuration, named and recalled with one tap. Stored
// separately from the live settings so resetting or switching looks never
// touches the saved set. The whole (non-transient) settings object is captured
// so a look restores the exact configuration, not a lossy subset.
const LOOKS_KEY = "memex.graph.savedLooks.v1";
export const MAX_SAVED_LOOKS = 24;

export interface SavedLook {
  name: string;
  settings: Partial<GraphSettings>;
}

export function loadSavedLooks(): SavedLook[] {
  try {
    const raw = localStorage.getItem(LOOKS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is SavedLook =>
        !!x &&
        typeof (x as SavedLook).name === "string" &&
        // typeof null === "object" — a null settings would pass and then throw
        // on spread when applied, so require a real object.
        !!(x as SavedLook).settings &&
        typeof (x as SavedLook).settings === "object",
    );
  } catch {
    return [];
  }
}

function writeSavedLooks(looks: SavedLook[]): SavedLook[] {
  try {
    localStorage.setItem(LOOKS_KEY, JSON.stringify(looks));
  } catch {
    /* quota or disabled — ignore */
  }
  return looks;
}

/** Save (or overwrite by trimmed name) the current settings under `name`. A
 * look is the VISUAL configuration (skin / layout / colours / effects / forces)
 * — the transient VIEW state is dropped so applying a look never yanks the mode
 * or re-applies a stale filter: `search`, the active `tagFilter`/`folderFilter`,
 * and `multiverse` mode (baking multiverse:true would bounce the user to the
 * bubble field on recall). Returns the updated list. */
export function saveLook(name: string, s: GraphSettings): SavedLook[] {
  const trimmed = name.trim();
  if (!trimmed) return loadSavedLooks();
  const {
    search: _s,
    tagFilter: _t,
    folderFilter: _f,
    multiverse: _m,
    ...settings
  } = s;
  void _s;
  void _t;
  void _f;
  void _m;
  const looks = loadSavedLooks().filter(
    (l) => l.name.toLowerCase() !== trimmed.toLowerCase(),
  );
  looks.unshift({ name: trimmed, settings });
  return writeSavedLooks(looks.slice(0, MAX_SAVED_LOOKS));
}

export function deleteLook(name: string): SavedLook[] {
  return writeSavedLooks(
    loadSavedLooks().filter(
      (l) => l.name.toLowerCase() !== name.trim().toLowerCase(),
    ),
  );
}
