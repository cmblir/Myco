import { describe, expect, it } from "vitest";
import {
  PIXEL_ARCHETYPES,
  PIXEL_PLANET_GLSL,
  PIXEL_SPRITE_GLSL,
  archetypeFor,
  rampFor,
  type PixelArchetype,
} from "./pixelPlanet";

describe("archetypeFor", () => {
  it("is deterministic — same id/degree/isHub always gives the same archetype", () => {
    for (const id of [
      "note-a",
      "note-b",
      "a-much-longer-id-with-slashes/path",
    ]) {
      const first = archetypeFor(id, 5, false);
      for (let i = 0; i < 5; i++)
        expect(archetypeFor(id, 5, false)).toBe(first);
    }
  });

  it("always gives hubs the hub archetype, regardless of degree", () => {
    expect(archetypeFor("any-id", 0, true)).toBe("hub");
    expect(archetypeFor("any-id", 40, true)).toBe("hub");
  });

  it("never gives a non-hub node the hub archetype", () => {
    for (let i = 0; i < 500; i++) {
      expect(archetypeFor(`node-${i}`, i % 20, false)).not.toBe("hub");
    }
  });

  it("spreads reasonably over 500 synthetic ids (no archetype above 40%)", () => {
    const counts = new Map<PixelArchetype, number>();
    const n = 500;
    for (let i = 0; i < n; i++) {
      const id = `node-${i}`;
      const degree = i % 20;
      const isHub = i % 37 === 0; // rare, like real hub density
      const a = archetypeFor(id, degree, isHub);
      counts.set(a, (counts.get(a) ?? 0) + 1);
    }
    for (const a of PIXEL_ARCHETYPES) {
      const frac = (counts.get(a) ?? 0) / n;
      expect(frac).toBeLessThan(0.4);
    }
    // every archetype should show up at least once across 500 ids
    expect(counts.size).toBe(PIXEL_ARCHETYPES.length);
  });
});

describe("rampFor", () => {
  it("returns 5 entries, each an [r,g,b] triple in 0..1", () => {
    for (const a of PIXEL_ARCHETYPES) {
      const ramp = rampFor(a, 120, true);
      expect(ramp).toHaveLength(5);
      for (const [r, g, b] of ramp) {
        for (const c of [r, g, b]) {
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("is stable for the same (archetype, hue, dark)", () => {
    const a = rampFor("ocean", 200, true);
    const b = rampFor("ocean", 200, true);
    expect(b).toEqual(a);
  });

  it("produces measurably different ramps for different hues", () => {
    const a = rampFor("rock", 20, true);
    const b = rampFor("rock", 260, true);
    const dist = a.reduce(
      (sum, [r, g, bl], i) =>
        sum +
        Math.abs(r - b[i][0]) +
        Math.abs(g - b[i][1]) +
        Math.abs(bl - b[i][2]),
      0,
    );
    expect(dist).toBeGreaterThan(0.3);
  });

  it("adjusts value (not hue) between dark and light theme", () => {
    const dark = rampFor("gas", 90, true);
    const light = rampFor("gas", 90, false);
    // light theme should read darker overall (sum of channels drops)
    const sum = (ramp: typeof dark) =>
      ramp.reduce((s, [r, g, b]) => s + r + g + b, 0);
    expect(sum(light)).toBeLessThan(sum(dark));
  });
});

// The vitest environment is plain node — no WebGL2 context to really compile
// against (see vitest.config.ts). These assert the structural invariants that
// would break a paste-into-three.js-ShaderMaterial compile; the actual GL
// compile is checked separately by a Playwright script under the scratchpad
// (real headless Chromium + WebGL2), not committed to this repo.
describe("GLSL chunks are three.js-paste-safe", () => {
  const chunks: [string, string][] = [
    ["PIXEL_SPRITE_GLSL", PIXEL_SPRITE_GLSL],
    ["PIXEL_PLANET_GLSL", PIXEL_PLANET_GLSL],
  ];

  it.each(chunks)("%s has balanced braces/parens", (_name, src) => {
    expect((src.match(/{/g) ?? []).length).toBe((src.match(/}/g) ?? []).length);
    expect((src.match(/\(/g) ?? []).length).toBe(
      (src.match(/\)/g) ?? []).length,
    );
  });

  it.each(chunks)(
    "%s has no #version/precision/in/out tokens three.js already injects",
    (_name, src) => {
      expect(src).not.toMatch(/#version/);
      expect(src).not.toMatch(/(^|\n)\s*precision\s/);
      expect(src).not.toMatch(/(^|\n)\s*in\s+\w/);
      expect(src).not.toMatch(/(^|\n)\s*out\s+\w/);
    },
  );

  it("PIXEL_SPRITE_GLSL declares pixel_sprite(vec2, int, float, float) -> vec2", () => {
    expect(PIXEL_SPRITE_GLSL).toMatch(
      /vec2\s+pixel_sprite\s*\(\s*vec2\s+\w+,\s*int\s+\w+,\s*float\s+\w+,\s*float\s+\w+\s*\)/,
    );
  });

  it("PIXEL_PLANET_GLSL declares pixel_planet(vec2, int, float, float) -> vec4", () => {
    expect(PIXEL_PLANET_GLSL).toMatch(
      /vec4\s+pixel_planet\s*\(\s*vec2\s+\w+,\s*int\s+\w+,\s*float\s+\w+,\s*float\s+\w+\s*\)/,
    );
  });

  it("PIXEL_PLANET_GLSL expects a `colors` ramp in scope rather than declaring its own", () => {
    expect(PIXEL_PLANET_GLSL).not.toMatch(/uniform\s+vec3\s+colors/);
    expect(PIXEL_PLANET_GLSL).toMatch(/\bcolors\[/);
  });
});
