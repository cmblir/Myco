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
  textFadeThreshold: number; // zoom level at which labels appear (0.1..3)
  nodeSize: number; // multiplier 0.5..3
  linkThickness: number; // 0.3..3
  brightness: number; // 0.2..2.5 — scene exposure + bloom strength (light intensity)

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
  textFadeThreshold: 1.1,
  nodeSize: 1,
  linkThickness: 1,
  brightness: 0.85, // exposure headroom: the void stays black, only emitters survive
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
  // communities into coloured nuclei. 0.5 = distinct lobes that stay packed +
  // threaded as one galaxy (the cap + cohesion keep them from flying apart).
  clusterForce: 0.5,
};

// v25: calm-cosmic-web calibration (exposure 0.85, filaments off, bloom
// threshold-first). Bumping the key drops stale persisted slider positions so
// the recalibrated defaults apply instead of the old firework-era ones.
const KEY = "memex.graph.settings.v25";

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
