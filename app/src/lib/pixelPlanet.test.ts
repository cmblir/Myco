import { describe, expect, it } from "vitest";
import {
  PIXEL_ARCHETYPES,
  PIXEL_PLANET_GLSL,
  PIXEL_SPRITE_GLSL,
  archetypeFor,
  rampFor,
  type PixelArchetype,
} from "./pixelPlanet";

/** Rec.709 relative luminance — the same measure rampFor() preserves. */
const lum = ([r, g, b]: [number, number, number]): number =>
  0.2126 * r + 0.7152 * g + 0.0722 * b;

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

  it("keeps a stop's luminance when a community hue tints it", () => {
    // Tinting is allowed to move chroma but not the shading curve — the 5-stop
    // value ladder is what makes the pixel shading read as a lit sphere.
    for (const a of PIXEL_ARCHETYPES) {
      const base = rampFor(a, 0, true).map(lum);
      for (const hue of [90, 200, 300]) {
        rampFor(a, hue, true).forEach((stop, i) => {
          // Not exact: a stop with a channel already at 1.0 (hub's #ffc247 disc)
          // cannot be restored upward, so the final clamp costs it a little
          // brightness. Bounded well below anything visible in the value ladder.
          expect(
            Math.abs(lum(stop) - base[i]),
            `${a} @ ${hue} stop ${i}`,
          ).toBeLessThan(0.035);
        });
      }
    }
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

// Each archetype's ramp is sampled from a real body (Mars, Earth, Europa, Io,
// Jupiter, the Moon, the Sun — see ARCHETYPE_RAMP for the references), and the
// point of that work is that a viewer recognises the body. These pin the
// property that carries the recognition, and pin it for EVERY community hue:
// the previous ramp rotated wholesale toward the community hue, which is how
// Mars, Io and Jupiter all ended up the same pale pink.
describe("archetype ramps stay in their real body's colour family", () => {
  // Every hue a community can hand rampFor(), plus both themes.
  const cases: [number, boolean][] = [];
  for (let hue = 0; hue < 360; hue += 15)
    cases.push([hue, true], [hue, false]);

  function forEveryCommunity(
    a: PixelArchetype,
    assert: (ramp: ReturnType<typeof rampFor>, label: string) => void,
  ): void {
    for (const [hue, dark] of cases)
      assert(rampFor(a, hue, dark), `${a} @ hue ${hue} dark=${dark}`);
  }

  it("rock is Mars — the lit surface stops are warm red-orange", () => {
    forEveryCommunity("rock", (ramp, label) => {
      for (const i of [1, 2]) {
        const [r, g, b] = ramp[i];
        expect(r, `${label} stop ${i} red > green`).toBeGreaterThan(g);
        expect(g, `${label} stop ${i} green > blue`).toBeGreaterThan(b);
        expect(r - b, `${label} stop ${i} warm spread`).toBeGreaterThan(0.1);
      }
    });
  });

  it("ocean is Earth — the sea stop is blue, the land stop is not", () => {
    forEveryCommunity("ocean", (ramp, label) => {
      const [r, g, b] = ramp[3];
      expect(b, `${label} sea blue > red`).toBeGreaterThan(r);
      expect(b, `${label} sea blue > green`).toBeGreaterThan(g);
      const land = ramp[2];
      expect(land[1], `${label} land green > blue`).toBeGreaterThan(land[2]);
    });
  });

  it("ice is Europa — near-white plains above 0.8 luminance, tan lineae", () => {
    forEveryCommunity("ice", (ramp, label) => {
      // Light theme deliberately darkens everything, so only pin the dark ramp.
      if (label.endsWith("dark=true")) {
        expect(lum(ramp[0]), `${label} albedo`).toBeGreaterThan(0.85);
        expect(lum(ramp[1]), `${label} albedo`).toBeGreaterThan(0.8);
      }
      const [r, , b] = ramp[3];
      expect(r, `${label} lineae are tan, not blue`).toBeGreaterThan(b);
    });
  });

  it("ember is Io — the fissure stops are hot orange, the crust is dark", () => {
    forEveryCommunity("ember", (ramp, label) => {
      const [r, g, b] = ramp[1];
      expect(r, `${label} fissure red dominates`).toBeGreaterThan(0.7);
      expect(r - g, `${label} fissure is orange`).toBeGreaterThan(0.2);
      expect(g, `${label} fissure green > blue`).toBeGreaterThan(b);
      expect(lum(ramp[4]), `${label} crust bottom is near-black`).toBeLessThan(
        0.15,
      );
    });
  });

  it("gas is Jupiter — cream zone over red-brown belt, both warm", () => {
    forEveryCommunity("gas", (ramp, label) => {
      for (const i of [0, 1, 2, 3]) {
        const [r, g, b] = ramp[i];
        expect(r, `${label} stop ${i} red > green`).toBeGreaterThan(g);
        expect(g, `${label} stop ${i} green > blue`).toBeGreaterThan(b);
      }
      // The zones really are much brighter than the belts — that contrast is
      // the whole reason Jupiter reads as banded.
      expect(lum(ramp[0]) - lum(ramp[3]), `${label} zone/belt`).toBeGreaterThan(
        0.3,
      );
    });
  });

  it("dead is the Moon — every stop is near-neutral grey", () => {
    forEveryCommunity("dead", (ramp, label) => {
      ramp.forEach((stop, i) => {
        const chroma = Math.max(...stop) - Math.min(...stop);
        expect(chroma, `${label} stop ${i} chroma`).toBeLessThan(0.09);
      });
    });
  });

  it("hub is a star — white core, limb darkening down to orange", () => {
    forEveryCommunity("hub", (ramp, label) => {
      if (label.endsWith("dark=true")) {
        const [r, g, b] = ramp[0];
        expect(Math.min(r, g, b), `${label} core is white`).toBeGreaterThan(
          0.88,
        );
      }
      const limb = ramp[3];
      expect(limb[0], `${label} limb is warm`).toBeGreaterThan(limb[2]);
      expect(lum(ramp[0]), `${label} limb darkening`).toBeGreaterThan(
        lum(ramp[3]),
      );
    });
  });

  it("keeps every archetype's ramp ordered bright → dark", () => {
    for (const a of PIXEL_ARCHETYPES) {
      // ember is the exception by design: its stop 1 is an incandescent fissure
      // sitting next to a sulphur crust of near-equal luminance, so those two
      // are told apart by hue, exactly as on Io.
      const stops = rampFor(a, 210, true).map(lum);
      const pairs: [number, number][] =
        a === "ember"
          ? [
              [0, 1],
              [2, 3],
              [3, 4],
            ]
          : [
              [0, 1],
              [1, 2],
              [2, 3],
              [3, 4],
            ];
      for (const [i, j] of pairs)
        expect(stops[i], `${a} stop ${i} > ${j}`).toBeGreaterThan(stops[j]);
    }
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
