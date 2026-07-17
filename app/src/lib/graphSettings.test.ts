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
const FA2_STATIC = ["atlas", "synapse"] as const;
const SIM_ONLY_FORCES = ["centerForce", "repelForce", "linkForce", "clusterForce"] as const;

describe("LAYOUT_RECOMMENDED", () => {
  it("does not let a static-FA2 layout write a worker-sim-only force into shared state", () => {
    for (const layout of FA2_STATIC) {
      const rec = LAYOUT_RECOMMENDED[layout] as Record<string, unknown>;
      for (const force of SIM_ONLY_FORCES) {
        expect(
          force in rec,
          `${layout} Recommend must not set ${force}: it is inert for FA2 and pollutes the shared value the sim layouts read`,
        ).toBe(false);
      }
    }
  });

  it("still sets linkDistance for atlas — the one force field FA2 does read", () => {
    expect(LAYOUT_RECOMMENDED.atlas.linkDistance).toBeGreaterThan(0);
  });
});
