import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  coupleMyceliumPatch,
  DEFAULT_GRAPH_SETTINGS,
  LAYOUT_RECOMMENDED,
  loadGraphSettings,
  matchMyceliumBg,
  normalizeMyceliumPair,
  MYCELIUM_BG_PRESETS,
  myceliumBranchPct,
  myceliumMaxNodes,
  saveGraphSettings,
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

// The mycelium view is a separate renderer mounted when skin === "mycelium",
// while the layout chips only set `layout` — coupleMyceliumPatch keeps the
// pair in lockstep so the drawer's selected state always matches the canvas
// (the "천구 별자리 selected, hyphae rendered" bug).
describe("coupleMyceliumPatch", () => {
  const at = (skin: (typeof DEFAULT_GRAPH_SETTINGS)["skin"], layout: (typeof DEFAULT_GRAPH_SETTINGS)["layout"]) => ({ skin, layout });

  it("leaving via a non-mycelium layout also flips the skin off mycelium", () => {
    expect(coupleMyceliumPatch(at("mycelium", "mycelium"), { layout: "celestial" }))
      .toEqual({ layout: "celestial", skin: DEFAULT_GRAPH_SETTINGS.skin });
  });

  it("picking the mycelium layout under another skin enters the mycelium view", () => {
    expect(coupleMyceliumPatch(at("auto", "galaxy"), { layout: "mycelium" }))
      .toEqual({ layout: "mycelium", skin: "mycelium" });
  });

  it("picking the mycelium skin under another layout brings the layout along", () => {
    expect(coupleMyceliumPatch(at("white", "celestial"), { skin: "mycelium" }))
      .toEqual({ skin: "mycelium", layout: "mycelium" });
  });

  it("leaving via a non-mycelium skin lands the layout on the default", () => {
    expect(coupleMyceliumPatch(at("mycelium", "mycelium"), { skin: "black" }))
      .toEqual({ skin: "black", layout: DEFAULT_GRAPH_SETTINGS.layout });
  });

  it("passes through patches that already set both keys (vibes/saved looks)", () => {
    const vibe = VIBE_PRESETS.mycelium;
    expect(coupleMyceliumPatch(at("auto", "galaxy"), vibe)).toBe(vibe);
    const back = VIBE_PRESETS.living;
    expect(coupleMyceliumPatch(at("mycelium", "mycelium"), back)).toBe(back);
  });

  it("leaves unrelated single-key patches untouched", () => {
    expect(coupleMyceliumPatch(at("mycelium", "mycelium"), { nodeSize: 2 }))
      .toEqual({ nodeSize: 2 });
    expect(coupleMyceliumPatch(at("auto", "galaxy"), { skin: "white" }))
      .toEqual({ skin: "white" });
    expect(coupleMyceliumPatch(at("auto", "galaxy"), { layout: "atlas" }))
      .toEqual({ layout: "atlas" });
  });
});

// Background presets are background+ink TRIPLES: strand colour is community
// hue blended toward myceliumHyphaColor (staticLayouts' HYPHA_MIX), so a
// light substrate needs dark inks or the mat vanishes. Luminance-gap guard
// below is the testable form of that rule.
describe("mycelium background presets", () => {
  // Rec. 709 luma on gamma values — crude but monotone, all this needs.
  const luma = (hex: string): number => {
    const n = parseInt(hex.slice(1), 16);
    return (
      (0.2126 * ((n >> 16) & 0xff) + 0.7152 * ((n >> 8) & 0xff) + 0.0722 * (n & 0xff)) / 255
    );
  };

  it("the loam preset IS the default triple (default preset stays default)", () => {
    expect(MYCELIUM_BG_PRESETS.loam).toEqual({
      myceliumBackground: DEFAULT_GRAPH_SETTINGS.myceliumBackground,
      myceliumHyphaColor: DEFAULT_GRAPH_SETTINGS.myceliumHyphaColor,
      myceliumNodeColor: DEFAULT_GRAPH_SETTINGS.myceliumNodeColor,
    });
  });

  it("every preset keeps both inks legible against its own background", () => {
    for (const [name, p] of Object.entries(MYCELIUM_BG_PRESETS)) {
      const bg = luma(p.myceliumBackground);
      for (const ink of [p.myceliumHyphaColor, p.myceliumNodeColor]) {
        expect(
          Math.abs(luma(ink) - bg),
          `${name}: ink ${ink} too close to background ${p.myceliumBackground}`,
        ).toBeGreaterThan(0.3);
      }
    }
  });

  it("matchMyceliumBg finds each preset by background (case-insensitive) and null for custom", () => {
    for (const key of Object.keys(MYCELIUM_BG_PRESETS) as (keyof typeof MYCELIUM_BG_PRESETS)[]) {
      const s = {
        ...DEFAULT_GRAPH_SETTINGS,
        myceliumBackground: MYCELIUM_BG_PRESETS[key].myceliumBackground.toUpperCase(),
      };
      expect(matchMyceliumBg(s)).toBe(key);
    }
    expect(
      matchMyceliumBg({ ...DEFAULT_GRAPH_SETTINGS, myceliumBackground: "#123456" }),
    ).toBeNull();
  });
});

// Persistence round-trip — node env has no localStorage, so stand in a
// minimal one (same pattern as budget.test.ts).
describe("graph settings persistence", () => {
  class MemoryStorage {
    private store = new Map<string, string>();
    getItem(key: string): string | null {
      return this.store.has(key) ? (this.store.get(key) as string) : null;
    }
    setItem(key: string, value: string): void {
      this.store.set(key, value);
    }
    removeItem(key: string): void {
      this.store.delete(key);
    }
    clear(): void {
      this.store.clear();
    }
  }

  beforeEach(() => {
    (globalThis as { localStorage: unknown }).localStorage = new MemoryStorage();
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("round-trips myceliumBackground with the other mycelium colours", () => {
    saveGraphSettings({
      ...DEFAULT_GRAPH_SETTINGS,
      myceliumBackground: "#123456",
      myceliumHyphaColor: "#654321",
    });
    const loaded = loadGraphSettings();
    expect(loaded.myceliumBackground).toBe("#123456");
    expect(loaded.myceliumHyphaColor).toBe("#654321");
  });

  it("back-fills myceliumBackground on a persisted blob predating the field", () => {
    saveGraphSettings({ ...DEFAULT_GRAPH_SETTINGS });
    // Simulate the pre-field blob: strip the new field from what was stored.
    const raw = localStorage.getItem("myco.graph.settings.v26");
    expect(raw).toBeTruthy();
    const blob = JSON.parse(raw as string) as Record<string, unknown>;
    delete blob.myceliumBackground;
    localStorage.setItem("myco.graph.settings.v26", JSON.stringify(blob));
    expect(loadGraphSettings().myceliumBackground).toBe(
      DEFAULT_GRAPH_SETTINGS.myceliumBackground,
    );
  });
});

// A blob persisted before the skin/layout coupling existed (or written by a
// two-key vibe/look patch) can hold an inconsistent pair. The renderer is
// keyed on the skin, so the skin states what the user actually saw.
describe("normalizeMyceliumPair", () => {
  class MemoryStorage {
    private store = new Map<string, string>();
    getItem(key: string): string | null {
      return this.store.has(key) ? (this.store.get(key) as string) : null;
    }
    setItem(key: string, value: string): void {
      this.store.set(key, value);
    }
    removeItem(key: string): void {
      this.store.delete(key);
    }
    clear(): void {
      this.store.clear();
    }
  }
  beforeEach(() => {
    (globalThis as { localStorage: unknown }).localStorage = new MemoryStorage();
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("repairs a stored mycelium-skin + non-mycelium-layout pair on load", () => {
    saveGraphSettings({
      ...DEFAULT_GRAPH_SETTINGS,
      skin: "mycelium",
      layout: "galaxy",
    });
    const loaded = loadGraphSettings();
    expect(loaded.skin).toBe("mycelium");
    expect(loaded.layout).toBe("mycelium");
  });

  it("repairs a stored mycelium-layout + non-mycelium-skin pair on load", () => {
    saveGraphSettings({
      ...DEFAULT_GRAPH_SETTINGS,
      skin: "black",
      layout: "mycelium",
    });
    const loaded = loadGraphSettings();
    expect(loaded.skin).toBe("black");
    expect(loaded.layout).toBe(DEFAULT_GRAPH_SETTINGS.layout);
  });

  it("leaves a consistent pair untouched", () => {
    expect(
      normalizeMyceliumPair({ skin: "mycelium", layout: "mycelium" }),
    ).toEqual({ skin: "mycelium", layout: "mycelium" });
    expect(normalizeMyceliumPair({ skin: "auto", layout: "celestial" })).toEqual(
      { skin: "auto", layout: "celestial" },
    );
  });
});
