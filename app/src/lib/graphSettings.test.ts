import { describe, expect, it } from "vitest";
import { LAYOUT_RECOMMENDED } from "./graphSettings";

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
const STATIC_LAYOUTS = ["atlas", "synapse", "spiral", "strata", "semantic"] as const;
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

  it("gives every flat/chart layout the paper-deepened community dots", () => {
    for (const layout of ["atlas", "synapse", "strata", "semantic"] as const) {
      const rec = LAYOUT_RECOMMENDED[layout];
      expect(rec.nodeColor, `${layout}: a categorical map is unreadable mono`).toBe("community");
      expect(rec.nodeColorDepth ?? 0, `${layout}: flat maps need deepened dots`).toBeGreaterThanOrEqual(1.3);
    }
  });
});
