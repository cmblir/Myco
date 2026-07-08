// Graph view settings — persisted to localStorage so the user's slider
// positions survive reloads. Mirrors Obsidian's graph settings panel:
// Filters / Display / Forces. Field names and value ranges follow the
// `obsidian-typings` `GraphPluginInstanceOptions` interface so behaviour
// matches the real Obsidian sliders unit-for-unit. References:
//   - github.com/Fevol/obsidian-typings
//   - github.com/ElsaTam/obsidian-extended-graph (default values)
//   - github.com/ycnmhd/obsidian-graph-presets (slider ranges)

export interface GraphSettings {
  // Filters
  search: string;
  showOrphans: boolean;
  existingOnly: boolean;
  tagFilter: string | null;
  folderFilter: string | null;

  // Display
  arrows: boolean;
  arrowSize: number; // arrowhead cone scale, 0.1..1.5 — kept well under node size
  textFadeThreshold: number; // zoom level at which labels appear (0.1..3)
  nodeSize: number; // multiplier 0.5..3
  linkThickness: number; // 0.3..3
  brightness: number; // "Glow" slider, 0.4..1.6 — scene exposure (light intensity)
  // One switch for ALL idle motion (auto-rotate, edge pulses, star breathing) —
  // the spec's motion budget gives ambience a single opt-out instead of three.
  ambientMotion: boolean;

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
  arrows: false,
  arrowSize: 1, // arrowhead/flying-ship scale (bumped from 0.35 on request)
  textFadeThreshold: 1.1,
  nodeSize: 1,
  linkThickness: 1,
  brightness: 0.9, // exposure headroom: the void stays black, only emitters survive
  ambientMotion: true,
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
