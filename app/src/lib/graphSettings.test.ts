import { describe, expect, it } from "vitest";
import {
  DEFAULT_GRAPH_SETTINGS,
  LAYOUT_RECOMMENDED,
  myceliumBranchPct,
  myceliumMaxNodes,
  saveLook,
  VIBE_PRESETS,
} from "./graphSettings";

// The mycelium skin repurposes the shared linkDistance/clusterForce sliders
// (see GraphControls.tsx's isMycelium gating) onto growMycelium's own
// maxNodes/branchPct knobs. An untouched slider (the DEFAULT_GRAPH_SETTINGS
// values) must reproduce growMycelium's own defaults exactly — otherwise the
// mat's shape would silently change the moment a user switches to the
// mycelium skin, before ever touching a slider.
describe("mycelium force-slider mapping", () => {
  it("default linkDistance reproduces growMycelium's own default node multiplier (10x)", () => {
    expect(myceliumMaxNodes(DEFAULT_GRAPH_SETTINGS.linkDistance, 1244)).toBe(12440);
  });

  it("a wider link distance (more spread) yields a sparser mat", () => {
    const dense = myceliumMaxNodes(30, 1244);
    const sparse = myceliumMaxNodes(500, 1244);
    expect(sparse).toBeLessThan(dense);
  });

  it("clamps to growMycelium's own [2250, 22500] node bounds", () => {
    expect(myceliumMaxNodes(500, 1244)).toBeGreaterThanOrEqual(2250);
    expect(myceliumMaxNodes(30, 1244)).toBeLessThanOrEqual(22500);
  });

  it("default clusterForce reproduces growMycelium's own default branchPct (3.2)", () => {
    expect(myceliumBranchPct(DEFAULT_GRAPH_SETTINGS.clusterForce)).toBeCloseTo(3.2, 5);
  });

  it("branch density scales monotonically with clusterForce", () => {
    expect(myceliumBranchPct(0)).toBe(0);
    expect(myceliumBranchPct(1)).toBeGreaterThan(myceliumBranchPct(0.5));
  });
});

describe("saveLook", () => {
  it("drops transient view/mode state so a recalled look never yanks the view", () => {
    const s = {
      ...DEFAULT_GRAPH_SETTINGS,
      skin: "sigma" as const,
      layout: "atlas" as const,
      // View/mode state that must NOT be baked into a look:
      search: "tag:#x",
      tagFilter: "concept",
      folderFilter: "wiki",
      multiverse: true,
    };
    const [look] = saveLook("My look", s);
    expect(look.name).toBe("My look");
    // The visual configuration is kept…
    expect(look.settings.skin).toBe("sigma");
    expect(look.settings.layout).toBe("atlas");
    // …but every transient key is stripped (applying multiverse:true would bounce
    // the user to the bubble field; a stale tag/folder could empty the graph).
    for (const k of ["search", "tagFilter", "folderFilter", "multiverse"] as const) {
      expect(k in look.settings, `${k} must not be saved into a look`).toBe(false);
    }
  });

  it("ignores a blank name", () => {
    expect(saveLook("   ", DEFAULT_GRAPH_SETTINGS)).toEqual([]);
  });
});

// The graph settings are ONE shared object, not per-layout state. So a "Recommend"
// preset that sets a field the current layout ignores does not vanish — it
// overwrites the shared value that a DIFFERENT layout reads.
//
// atlas and synapse (2D) run applyAtlasLayout, a static ForceAtlas2 pipeline that
// reads only linkDistance (as targetRadius). The worker-sim force tuple —
// centerForce, repelForce, linkForce, clusterForce — is inert for them. atlas's
// Recommend used to set clusterForce: 0.45; invisible on atlas, but it clobbered
// the 0.35 galaxy is tuned to, so clicking Recommend on atlas and switching back
// to galaxy silently changed galaxy's look.
const STATIC_LAYOUTS = ["atlas", "synapse", "spiral", "strata", "semantic", "celestial", "radial", "walrus"] as const;
const SIM_ONLY_FORCES = ["centerForce", "repelForce", "linkForce", "clusterForce"] as const;

describe("LAYOUT_RECOMMENDED", () => {
  it("does not let a static layout write a worker-sim-only force into shared state", () => {
    for (const layout of STATIC_LAYOUTS) {
      const rec = LAYOUT_RECOMMENDED[layout] as Record<string, unknown>;
      for (const force of SIM_ONLY_FORCES) {
        expect(
          force in rec,
          `${layout} Recommend must not set ${force}: it is inert for a static layout and pollutes the shared value the sim layouts read`,
        ).toBe(false);
      }
    }
  });

  it("still sets linkDistance for atlas — the one force field FA2 does read", () => {
    expect(LAYOUT_RECOMMENDED.atlas.linkDistance).toBeGreaterThan(0);
  });

  it("keeps cosmic events off wherever positions are baked (no sim to recover)", () => {
    for (const layout of STATIC_LAYOUTS) {
      expect(
        LAYOUT_RECOMMENDED[layout].cosmicEvents,
        `${layout}: a wormhole would yank baked positions with no sim to pull them home`,
      ).toBe(false);
    }
  });

  it("every vibe is a complete look: skin + layout + that layout's recommend", () => {
    for (const [name, vibe] of Object.entries(VIBE_PRESETS)) {
      expect(vibe.skin, `${name}: a vibe must pick a skin`).toBeTruthy();
      expect(vibe.layout, `${name}: a vibe must pick a layout`).toBeTruthy();
      // Spot-check the recommend actually got spread: every layout recommend
      // sets edgeTint, so a vibe missing it forgot the spread.
      expect(vibe.edgeTint, `${name}: must spread LAYOUT_RECOMMENDED`).toBeTruthy();
    }
  });

  it("vibes on baked layouts never carry sim-only forces", () => {
    const SIM = ["centerForce", "repelForce", "linkForce", "clusterForce"];
    for (const [name, vibe] of Object.entries(VIBE_PRESETS)) {
      const layout = vibe.layout as string;
      if (layout === "galaxy" || layout === "synapse3d") continue; // sim layouts
      for (const f of SIM) {
        expect(
          f in vibe,
          `${name} (${layout}): baked layout must not write ${f}`,
        ).toBe(false);
      }
    }
  });

  it("gives every flat/chart layout the paper-deepened community dots", () => {
    for (const layout of ["atlas", "synapse", "strata"] as const) {
      const rec = LAYOUT_RECOMMENDED[layout];
      expect(rec.nodeColor, `${layout}: a categorical map is unreadable mono`).toBe("community");
      expect(rec.nodeColorDepth ?? 0, `${layout}: flat maps need deepened dots`).toBeGreaterThanOrEqual(1.3);
    }
  });
});
