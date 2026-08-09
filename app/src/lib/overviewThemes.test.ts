import { describe, expect, it } from "vitest";
import {
  createOverviewEngine,
  DEFAULT_OVERVIEW_THEME,
  isOverviewTheme,
  OVERVIEW_THEMES,
  type OverviewThemeKey,
} from "./overviewThemes";

// A recording stub: engines only ever talk to a 2D context, so a stub that
// counts draw calls is enough to prove each one actually paints — and it keeps
// these tests free of jsdom canvas.
// Explicit no-op: these context methods exist only so the engines can call
// them; there is nothing to record.
const noop = (): void => undefined;

function stubCtx(): { ctx: CanvasRenderingContext2D; draws: () => number; args: () => number[] } {
  let draws = 0;
  const nums: number[] = [];
  const track = (...xs: unknown[]): void => {
    for (const x of xs) if (typeof x === "number") nums.push(x);
  };
  const ctx = {
    globalAlpha: 1,
    lineWidth: 1,
    fillStyle: "",
    strokeStyle: "",
    beginPath: noop,
    closePath: noop,
    moveTo: (...a: number[]) => track(...a),
    lineTo: (...a: number[]) => track(...a),
    arc: (...a: number[]) => {
      draws++;
      track(...a);
    },
    ellipse: (...a: number[]) => {
      draws++;
      track(...a);
    },
    fill: () => {
      draws++;
    },
    stroke: () => {
      draws++;
    },
    fillRect: (...a: number[]) => track(...a),
    clearRect: noop,
    createRadialGradient: (...a: number[]) => {
      track(...a);
      return { addColorStop: noop };
    },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, draws: () => draws, args: () => nums };
}

const INPUTS = { count: 20, speed: 0.6 };

describe("overview themes", () => {
  it("names every theme after a real graph layout", () => {
    // The whole point of reusing the graph's vocabulary: a user learns one set
    // of names, not two. If a key here drifts from the layout union, the picker
    // starts showing a name the graph does not have.
    const layoutKeys = [
      "galaxy",
      "atlas",
      "synapse3d",
      "spiral",
      "strata",
      "semantic",
      "celestial",
      "radial",
      "walrus",
      "mycelium",
    ];
    for (const k of OVERVIEW_THEMES) expect(layoutKeys).toContain(k);
  });

  it("has a factory for every listed theme and no extras", () => {
    for (const k of OVERVIEW_THEMES) {
      expect(() => createOverviewEngine(k, INPUTS)).not.toThrow();
    }
    expect(new Set(OVERVIEW_THEMES).size).toBe(OVERVIEW_THEMES.length);
  });

  it("defaults to a theme that exists", () => {
    expect(OVERVIEW_THEMES).toContain(DEFAULT_OVERVIEW_THEME);
  });

  it.each(OVERVIEW_THEMES)("%s actually paints something", (key) => {
    const { ctx, draws } = stubCtx();
    const e = createOverviewEngine(key, INPUTS);
    for (let i = 0; i < 30; i++) e.step(ctx, 600, 300, 0.016);
    expect(draws()).toBeGreaterThan(0);
  });

  it.each(OVERVIEW_THEMES)("%s never emits a non-finite coordinate", (key) => {
    // A NaN reaching canvas silently drops the draw — far harder to notice than
    // a visibly wrong position.
    const { ctx, args } = stubCtx();
    const e = createOverviewEngine(key, INPUTS);
    for (let i = 0; i < 40; i++) e.step(ctx, 640, 280, 0.016);
    expect(args().every((n) => Number.isFinite(n))).toBe(true);
  });

  it.each(OVERVIEW_THEMES)("%s survives a degenerate canvas size", (key) => {
    const { ctx } = stubCtx();
    const e = createOverviewEngine(key, INPUTS);
    expect(() => {
      e.step(ctx, 1, 1, 0.016);
      e.step(ctx, 0, 0, 0.016);
    }).not.toThrow();
  });

  it.each(OVERVIEW_THEMES)("%s is deterministic for the same inputs", (key) => {
    const a = stubCtx();
    const b = stubCtx();
    const ea = createOverviewEngine(key, INPUTS);
    const eb = createOverviewEngine(key, INPUTS);
    for (let i = 0; i < 12; i++) {
      ea.step(a.ctx, 500, 250, 0.016);
      eb.step(b.ctx, 500, 250, 0.016);
    }
    expect(b.args()).toEqual(a.args());
  });

  it("scales element count with the vault, not with the theme", () => {
    // Switching the look must not change what the screen says about the vault.
    const small = stubCtx();
    const big = stubCtx();
    createOverviewEngine("galaxy", { count: 4, speed: 0.5 }).step(small.ctx, 600, 300, 0.016);
    createOverviewEngine("galaxy", { count: 28, speed: 0.5 }).step(big.ctx, 600, 300, 0.016);
    expect(big.draws()).toBeGreaterThan(small.draws());
  });

  it("marks only the growth theme as needing its own trail", () => {
    // The caller clears the canvas each frame EXCEPT for trail engines; getting
    // this wrong makes mycelium a single moving dot or smears everything else.
    for (const k of OVERVIEW_THEMES) {
      const e = createOverviewEngine(k, INPUTS);
      expect(Boolean(e.trails)).toBe(k === "mycelium");
    }
  });

  it("guards the stored value so a stale setting cannot crash the page", () => {
    expect(isOverviewTheme("galaxy")).toBe(true);
    expect(isOverviewTheme("nope")).toBe(false);
    expect(isOverviewTheme(undefined)).toBe(false);
    expect(isOverviewTheme(7 as unknown)).toBe(false);
  });
});

describe("theme key type", () => {
  it("compiles against the exported union", () => {
    const k: OverviewThemeKey = "mycelium";
    expect(OVERVIEW_THEMES).toContain(k);
  });
});
