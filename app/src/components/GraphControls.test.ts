import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import GraphControls, { drawerKey, graphControlSupport } from "./GraphControls";
import {
  DEFAULT_GRAPH_SETTINGS,
  VIBE_PRESETS,
  type GraphSettings,
} from "../lib/graphSettings";
import { STRINGS } from "../lib/i18n";

vi.mock("../stores/uiStore", () => ({
  useUIStore: (select: (state: { lang: "en" }) => unknown) =>
    select({ lang: "en" }),
}));

describe("graph control availability", () => {
  it.each([
    "atlas",
    "synapse",
    "spiral",
    "strata",
    "semantic",
    "celestial",
    "radial",
    "walrus",
    "terrain",
    "ribbon",
    "city",
  ] as const)(
    "does not offer simulation forces for the static %s arrangement",
    (layout) =>
      expect(
        graphControlSupport({ ...DEFAULT_GRAPH_SETTINGS, layout }).forces,
      ).toBe(false),
  );

  it.each(["galaxy", "synapse3d"] as const)(
    "keeps forces for the live %s arrangement",
    (layout) => {
      expect(
        graphControlSupport({ ...DEFAULT_GRAPH_SETTINGS, layout }).forces,
      ).toBe(true);
    },
  );

  it("does not offer sky, glow, pixels or flights on the Sigma board", () => {
    const support = graphControlSupport({
      ...DEFAULT_GRAPH_SETTINGS,
      ...VIBE_PRESETS.sigma,
    });
    expect([
      support.sky,
      support.glow,
      support.pixels,
      support.flow,
      support.planets,
      support.fly,
    ]).toEqual(Array(6).fill(false));
  });

  it("does not offer dark-space effects on paper or an auto light background", () => {
    for (const skin of ["auto", "white"] as const) {
      const support = graphControlSupport(
        { ...DEFAULT_GRAPH_SETTINGS, skin },
        true,
      );
      expect([support.glow, support.cosmic, support.planets]).toEqual([
        false,
        false,
        false,
      ]);
    }
  });

  it.each([false, true])(
    "offers Woven every control the default look offers, on a light ground too (%s), bar the bundle arcs its strands are",
    (light) => {
      const woven = graphControlSupport({ ...DEFAULT_GRAPH_SETTINGS, ...VIBE_PRESETS.ribbon }, light);
      const galaxy = graphControlSupport({ ...DEFAULT_GRAPH_SETTINGS, ...VIBE_PRESETS.default }, light);
      // Forces belong to the live-sim looks (walrus and every other baked
      // layout go without them too).
      expect(woven).toEqual({ ...galaxy, forces: false, bundles: false });
    },
  );

  // Cosmic events only draw their own FX near the clusters (cosmicEvents.ts
  // never moves a note), so a baked 3D look takes them like the default look.
  it.each(["spiral", "semantic", "celestial", "radial", "walrus", "ribbon"] as const)(
    "offers cosmic events on the baked 3D %s arrangement",
    (layout) => {
      expect(graphControlSupport({ ...DEFAULT_GRAPH_SETTINGS, layout }).cosmic).toBe(true);
    },
  );

  it.each(["terrain", "city"] as const)(
    "keeps %s controls focused on its shape and readable notes",
    (layout) => {
      const support = graphControlSupport({ ...DEFAULT_GRAPH_SETTINGS, layout });
      expect([
        support.forces,
        support.sky,
        support.glow,
        support.pixels,
        support.flow,
        support.cosmic,
        support.planets,
        support.fly,
      ]).toEqual(Array(8).fill(false));
      expect(support.ambient).toBe(true);
    },
  );

  it("keeps the web as points and avoids duplicate direction effects", () => {
    expect(
      graphControlSupport({ ...DEFAULT_GRAPH_SETTINGS, skin: "web" }).planets,
    ).toBe(false);
    expect(
      graphControlSupport({ ...DEFAULT_GRAPH_SETTINGS, arrows: true }).flow,
    ).toBe(false);
  });

  it("offers no idle orbit for a flat mycelium mat", () => {
    const support = graphControlSupport({
      ...DEFAULT_GRAPH_SETTINGS,
      ...VIBE_PRESETS.mycelium,
      myceliumDim: "2d",
    });
    expect([
      support.forces,
      support.ambient,
      support.sky,
      support.glow,
      support.pixels,
      support.fly,
    ]).toEqual(Array(6).fill(false));
  });
});

function renderControls(settings: GraphSettings, open = true): string {
  const noop = vi.fn();
  return renderToStaticMarkup(
    createElement(GraphControls, {
      t: STRINGS.en,
      open,
      settings,
      onChange: noop,
      onReset: noop,
      onToggle: noop,
      tags: [],
      folders: [],
      tlPlaying: false,
      onTimelapse: noop,
      traceMode: false,
      onTraceMode: noop,
      flyMode: false,
      onFlyMode: noop,
    }),
  );
}

describe("closed drawer", () => {
  it("leaves no toggle in the canvas: the More menu is its one door", () => {
    expect(renderControls(DEFAULT_GRAPH_SETTINGS, false)).toBe("");
  });
});

describe("graph look adjustment feedback", () => {
  it.each(["ribbon"] as const)(
    "keeps the %s look selected and offers restoration after a size change",
    (key) => {
      const html = renderControls({
        ...DEFAULT_GRAPH_SETTINGS,
        ...VIBE_PRESETS[key],
        nodeSize: 1.5,
      });
      expect(html.match(/class="graph-vibe(?: graph-vibe--active)?"/g)).toHaveLength(12);
      expect(html).toContain(`data-look-adjusted="${key}"`);
      expect(html).toContain("Restore this look");
    },
  );

  it("leads with the default look, active after Reset", () => {
    const html = renderControls({ ...DEFAULT_GRAPH_SETTINGS });
    expect(html.match(/class="graph-vibe(?: graph-vibe--active)?"/)?.[0]).toBe(
      'class="graph-vibe graph-vibe--active"',
    );
    expect(html).toContain("Living galaxy");
    expect(html).not.toContain("data-look-adjusted");
  });

  it("offers Woven and hides the retired surface looks in both pickers", () => {
    const html = renderControls({ ...DEFAULT_GRAPH_SETTINGS, ...VIBE_PRESETS.ribbon });
    expect(html).toContain("Woven");
    expect(html).not.toContain("Contour terrain");
    expect(html).not.toContain("Block city");
    expect(html).not.toContain("Folded ribbon");
  });

  it("shows the current look and a restore action after its appearance is changed", () => {
    const html = renderControls({
      ...DEFAULT_GRAPH_SETTINGS,
      ...VIBE_PRESETS.living,
      brightness: 1.4,
    });
    expect(html).toContain('data-look-adjusted="living"');
    expect(html).toContain("Spiral galaxy · Adjusted");
    expect(html).toContain("Restore this look");
  });

  it("does not mark filtering or an analysis question as an appearance adjustment", () => {
    const html = renderControls({
      ...DEFAULT_GRAPH_SETTINGS,
      ...VIBE_PRESETS.living,
      search: "meeting",
      tagFilter: "work",
      folderFilter: "daily",
      question: "neighbors",
    });
    expect(html).not.toContain("data-look-adjusted");
  });
});

describe("the Panels row", () => {
  it("toggles each rail, pressed while the rail stands open", () => {
    const html = renderControls({ ...DEFAULT_GRAPH_SETTINGS, gapsRailOpen: false });
    expect(html).toContain(`${STRINGS.en.gr_panels}</span>`);
    expect(html).toContain('aria-pressed="false" data-panel="gaps"');
    expect(html).toContain('aria-pressed="true" data-panel="legend"');
  });
});

describe("drawerKey — keys pressed inside the settings drawer", () => {
  const key = (k: string, extra: Partial<{ metaKey: boolean; isComposing: boolean }> = {}) => ({
    key: k,
    metaKey: extra.metaKey ?? false,
    ctrlKey: false,
    altKey: false,
    stopPropagation: vi.fn(),
    nativeEvent: { isComposing: extra.isComposing ?? false, keyCode: extra.isComposing ? 229 : 0 } as KeyboardEvent,
  });

  it("closes the drawer on Esc, and keeps the key from the graph's own Esc", () => {
    const e = key("Escape");
    const close = vi.fn();
    drawerKey(e, close);
    expect(close).toHaveBeenCalledOnce();
    expect(e.stopPropagation).toHaveBeenCalled();
  });

  it("leaves an Esc that ends an IME composition to the input method", () => {
    const e = key("Escape", { isComposing: true });
    const close = vi.fn();
    drawerKey(e, close);
    expect(close).not.toHaveBeenCalled();
    expect(e.stopPropagation).toHaveBeenCalled();
  });

  it("keeps typed letters inside, so a field never fires the graph's F", () => {
    const e = key("f");
    const close = vi.fn();
    drawerKey(e, close);
    expect(close).not.toHaveBeenCalled();
    expect(e.stopPropagation).toHaveBeenCalled();
  });

  it("lets modifier shortcuts through to the app", () => {
    const e = key("k", { metaKey: true });
    drawerKey(e, vi.fn());
    expect(e.stopPropagation).not.toHaveBeenCalled();
  });
});
