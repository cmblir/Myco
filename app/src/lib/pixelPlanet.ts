// pixel-planet — reusable retro-pixel planet/sprite shading, shared by the
// near-field planet layer and the graph node sprites (see planetLayer.ts and
// the sigma/three node renderers). Ported from Deep-Fold's "Pixel Planets"
// (MIT) WebGL2 modules verified in the scratchpad harness — this file is the
// ONE place that owns the archetype→look mapping so both consumers read the
// same node the same way at different zoom levels.
//
// Deliberately NOT a three.js material: the exports are plain data (archetype
// picker, colour ramp) and plain GLSL text. Each consumer concatenates the
// GLSL chunk into its own fragment shader (three.js injects `#version`/
// `precision`/`in`/`out`, so none of that appears here) and declares its own
// `uniform vec3 colors[5];` — the exact shape rampFor() returns — before the
// pasted text. Helper function names are prefixed (`pxs_`/`pxp_`) so both
// chunks can coexist in one shader (e.g. a near/far LOD cross-fade) without
// colliding with each other or with unrelated `rand`/`noise`/`fbm` helpers
// other layers in this app already define (planetLayer.ts, galaxyImposterLayer.ts).
import { seededUnit } from "./graphData";

/** The archetypes a node can render as, ordered; index is stable (shader-side switch). */
export const PIXEL_ARCHETYPES = [
  "rock",
  "ocean",
  "ice",
  "ember",
  "gas",
  "dead",
  "hub",
] as const;
export type PixelArchetype = (typeof PIXEL_ARCHETYPES)[number];

/** 5-entry ramp, rim → lit → mid → shadow → void side, each [r,g,b] 0..1. */
export type PixelRamp = [number, number, number][];

const NON_HUB_ARCHETYPES = PIXEL_ARCHETYPES.filter(
  (a): a is Exclude<PixelArchetype, "hub"> => a !== "hub",
);

// Salt picks an independent seededUnit() stream so archetype assignment
// doesn't correlate with any other per-id draw (layout, size jitter, ...).
const ARCHETYPE_SALT = 61;

/** Pick an archetype deterministically from a node's own facts. */
export function archetypeFor(
  id: string,
  degree: number,
  isHub: boolean,
): PixelArchetype {
  if (isHub) return "hub";
  const r = seededUnit(id, ARCHETYPE_SALT);
  // Super-connected nodes skew hot, echoing planetLayer.ts's planetFamily()
  // rule ("deg >= 14 → molten") so the two LOD layers agree on WHY a node
  // looks the way it does, not just that they happen to share a palette.
  if (degree >= 14) return r < 0.5 ? "ember" : "gas";
  const idx = Math.floor(r * NON_HUB_ARCHETYPES.length);
  return NON_HUB_ARCHETYPES[Math.min(idx, NON_HUB_ARCHETYPES.length - 1)];
}

// --- ramp -------------------------------------------------------------

// HSL (h degrees, s/l 0..1) → RGB 0..1 — the same formula graphData.ts's
// hslToHex() uses, kept local so a ramp stays plain float triples (no
// hex-string round trip) for a GLSL uniform to consume directly.
function hslToRgb01(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return [r + m, g + m, b + m];
}

// Shortest signed hue delta (degrees, -180..180) from `h` toward `target`.
function hueDelta(h: number, target: number): number {
  return ((target - h + 540) % 360) - 180;
}

// A community can nudge an archetype's hue only this far — enough that a
// community still "reads as one colour family" per the brief, not so much
// that two archetypes converge on the same hue and stop being distinguishable.
const MAX_HUE_ROTATE_DEG = 42;

// Light theme reads on white/paper instead of the near-black void these
// ramps were tuned for — same move as graphData.ts's shadeHex() lightBg
// branch: darker AND more saturated, so nodes stay legible instead of
// washing out. Hue is untouched (the brief: theme adjusts value, not hue).
const LIGHT_THEME_LIGHTNESS_SCALE = 0.78;
const LIGHT_THEME_SAT_BOOST = 1.15;

// Each archetype's characteristic (hue, saturation, 5-stop lightness curve),
// rim-lit brightest → shadow-rim darkest — the same shape NodeSingle.js's
// PALETTES (Slate/Ion/Ember/Verdant/Amethyst) already use. One hue per
// archetype (not a hue-drifting ramp like some Deep-Fold source ramps use)
// keeps rotation toward a community hue a single, predictable operation.
const ARCHETYPE_TONE: Record<
  PixelArchetype,
  { hue: number; sat: number; light: [number, number, number, number, number] }
> = {
  rock: { hue: 28, sat: 0.3, light: [0.82, 0.6, 0.4, 0.24, 0.12] },
  ocean: { hue: 205, sat: 0.55, light: [0.88, 0.62, 0.4, 0.22, 0.1] },
  ice: { hue: 195, sat: 0.18, light: [0.97, 0.85, 0.65, 0.42, 0.2] },
  ember: { hue: 14, sat: 0.75, light: [0.85, 0.55, 0.3, 0.15, 0.07] },
  gas: { hue: 34, sat: 0.42, light: [0.84, 0.64, 0.44, 0.26, 0.13] },
  dead: { hue: 230, sat: 0.08, light: [0.74, 0.54, 0.36, 0.22, 0.11] },
  hub: { hue: 46, sat: 0.45, light: [0.97, 0.82, 0.62, 0.4, 0.2] },
};

/** Derive the 5-entry ramp for an archetype, tinted toward a community hue. */
export function rampFor(
  a: PixelArchetype,
  hue: number,
  dark: boolean,
): PixelRamp {
  const tone = ARCHETYPE_TONE[a];
  const delta = Math.max(
    -MAX_HUE_ROTATE_DEG,
    Math.min(MAX_HUE_ROTATE_DEG, hueDelta(tone.hue, hue)),
  );
  const h = (tone.hue + delta + 360) % 360;
  const s = dark ? tone.sat : Math.min(1, tone.sat * LIGHT_THEME_SAT_BOOST);
  return tone.light.map((l) =>
    hslToRgb01(
      h,
      s,
      dark ? l : Math.max(0.04, l * LIGHT_THEME_LIGHTNESS_SCALE),
    ),
  );
}

// --- GLSL: node sprite (16x16, graph node icon LOD) --------------------

/**
 * GLSL chunk: the shared sprite core (quantise → archetype pattern → ramp index).
 * Consumers paste this into their own fragment shader, declare
 * `uniform vec3 colors[5];` (rampFor()'s output), and call
 * `vec2 pixel_sprite(vec2 uv, int variant, float t, float seed)` → (rampIndex, alpha).
 *
 * Ported from Deep-Fold's "Pixel Planets" (MIT) — https://github.com/Deep-Fold/PixelPlanets.
 * Reused verbatim in maths from res://Planets/*: the value-noise rand/noise
 * hash (Rivered.gdshader et al.) and the "quantise uv, then pick a colour
 * from a small indexed ramp" structure every one of those shaders is built
 * on. The archetype silhouettes/patterns and the 1px rim lighting are NOT a
 * Deep-Fold port — Deep-Fold's planets are 100px sprites and their
 * texture-driven look dissolves at 16px, so this variant logic was designed
 * from scratch for this size (see NodeSingle.js in the source harness).
 *
 * `variant` order matches PIXEL_ARCHETYPES: 0 rock, 1 ocean, 2 ice, 3 ember,
 * 4 gas, 5 dead, 6 hub. `uv` is a plain 0..1 quad coordinate; `seed` is a
 * per-instance random float (source NodeSingle.js read this from a global
 * `seed` uniform via hash21() closure — an explicit parameter here instead,
 * so one shader can draw many differently-seeded sprites in one draw call).
 */
export const PIXEL_SPRITE_GLSL = /* glsl */ `
// A node sprite is always a 16x16 logical grid — legibility at this size
// comes from silhouette + 3 values, not texture, so the grid is fixed rather
// than a caller-supplied pixel density (see NodeSingle.js's port notes).
const float PXS_GRID = 16.0;
// Fixed key light (not a physical light source): every sprite/planet this
// app draws shares one light direction so hundreds of instances read as one
// consistent scene instead of each pointing a random way.
const vec2 PXS_LIGHT_ORIGIN = vec2(0.39, 0.39);

float pxs_hash21(vec2 p, float seed) {
	return fract(sin(dot(p, vec2(12.9898, 78.233))) * 15.5453 * seed);
}

float pxs_vnoise(vec2 coord, float seed) {
	vec2 i = floor(coord);
	vec2 f = fract(coord);
	float a = pxs_hash21(i, seed);
	float b = pxs_hash21(i + vec2(1.0, 0.0), seed);
	float c = pxs_hash21(i + vec2(0.0, 1.0), seed);
	float d = pxs_hash21(i + vec2(1.0, 1.0), seed);
	vec2 cubic = f * f * (3.0 - 2.0 * f);
	return mix(a, b, cubic.x) + (c - a) * cubic.y * (1.0 - cubic.x) + (d - b) * cubic.x * cubic.y;
}

// px  : integer pixel coordinate inside the 16x16 sprite, y up
// out : vec2(ramp index 0..4, alpha)
// ramp: 0 highlight / lit rim, 1 light, 2 mid, 3 dark, 4 shadow rim
vec2 pixel_sprite(vec2 uv, int variant, float t, float seed) {
	vec2 px = floor(uv * PXS_GRID);
	vec2 d0 = (px + 0.5 - 8.0) / 7.5;   // -1..1 across the sprite
	vec2 d = d0;
	float ps = 1.0 / 7.5;               // one pixel, in d units

	// --- silhouette: the first thing you read at this size ---
	if (variant == 4) { d.y *= 1.22; }              // gas giant: oblate, wider than tall
	if (variant == 5) { d *= 1.42; ps *= 1.42; }    // dead: a small cinder
	if (variant == 6) { d *= 1.62; ps *= 1.62; }    // hub: small core, big ring

	float len = length(d);
	float ang = atan(d.y, d.x);

	float rl = 1.0;
	if (variant == 0) rl = 0.88 + 0.13 * pxs_hash21(vec2(floor(ang * 1.2732), 0.0), seed); // rock: 8 chunky sectors
	if (variant == 2) rl = 0.93 + 0.09 * cos(ang * 4.0 + 0.7);                              // ice: faceted
	if (variant == 5) rl = 0.86 + 0.16 * pxs_hash21(vec2(floor(ang * 0.9549), 3.0), seed);  // dead: 6 rough sectors

	float body = step(len, rl);

	// --- lighting: three hard zones, terminator bowed by the sphere ---
	vec2 lo = vec2(PXS_LIGHT_ORIGIN.x, 1.0 - PXS_LIGHT_ORIGIN.y); // uv is y-up here, Godot's uv is y-down
	vec2 L = normalize(vec2(0.5) - lo);                            // light -> centre, so dot() > 0 is the dark side
	float sh = dot(d / max(len, 0.0001), L);
	float shade = sh * 0.62 + len * 0.42;
	int zone = shade < 0.02 ? 1 : (shade < 0.45 ? 2 : 3);
	int idx = zone;

	// --- surface, wrapped onto the sphere and scrolled by time ---
	float z = sqrt(max(0.0, 1.0 - min(len * len, 1.0)));
	vec2 sp = d / (z + 1.0);

	// Index 0 is reserved for the lit rim (plus ice caps and ember glow) — spending it
	// on ordinary surface pixels is what turned every archetype into the same white blob.
	if (variant == 0) {              // rock: mid-value, lumpy, a couple of dark craters
		float n = pxs_vnoise(sp * 4.2 + vec2(t * 0.06, 0.0), seed);
		if (n > 0.62) idx = min(zone + 2, 4);
	} else if (variant == 1) {       // ocean: dark water, a few mid-value islands
		float n = pxs_vnoise(sp * 4.2 + vec2(t * 0.07, 0.0), seed);
		idx = n > 0.60 ? zone : min(zone + 2, 4);
	} else if (variant == 2) {       // ice: brightest body, white caps, dark equator
		idx = max(zone - 1, 1);
		if (abs(d.y) < 0.13) idx = zone + 1;
		if (abs(d.y) > 0.50) idx = 0;
		if (pxs_vnoise(sp * 4.5 + vec2(t * 0.04, 0.0), seed) > 0.72) idx = zone + 1;
	} else if (variant == 3) {       // ember: near-black crust, glowing fissure
		idx = zone + 1;
		float n = pxs_vnoise(sp * 3.0 + vec2(t * 0.08, 0.0), seed);
		float fis = abs(d.y + 0.38 * (n - 0.5));
		float pulse = 0.09 + 0.035 * sin(t * 1.2);
		if (fis < pulse + 0.13) idx = 1;                   // 1px halo sells it as heat
		if (fis < pulse) idx = 0;                           // core of the crack, ignores the terminator
		if (n > 0.74) idx = 0;
	} else if (variant == 4) {       // gas: horizontal bands
		float y = d.y + 0.10 * pxs_vnoise(sp * 2.0 + vec2(t * 0.09, 0.0), seed);
		float b = sin((y * 3.1 + 0.4) * 3.14159);
		idx = clamp(zone + (b > 0.15 ? -1 : (b < -0.35 ? 1 : 0)), 1, 4);
	} else if (variant == 5) {       // dead: flat, low contrast, pitted
		idx = max(zone + 1, 2);
		if (pxs_vnoise(sp * 3.8 + vec2(t * 0.02, 0.0), seed) > 0.66) idx = 4;
	} else if (variant == 6) {       // hub: bright core
		idx = max(zone - 1, 1);
	}

	// --- 1px lit rim / 1px dark rim: short arcs, not half-rings ---
	float edge = step(rl - ps * 1.05, len) * body;
	if (edge > 0.5 && sh < -0.45 && variant != 3) idx = 0; // an ember world's only bright thing is its crack
	if (edge > 0.5 && sh > 0.45) idx = 4;

	float a = body;

	// hub's ring: exactly one pixel row per column (nearest row to a tilted line),
	// drawn only outside the core so it reads as a ring seen near edge-on.
	if (variant == 6) {
		float tilt = -0.30 * sin(t * 0.25);
		if (abs(d0.y - tilt * d0.x) < 0.0668 && abs(d0.x) < 1.0 && len > rl) {
			a = 1.0;
			idx = abs(d0.x) > 0.85 ? 2 : 0;
		}
	}

	return vec2(float(clamp(idx, 0, 4)), a);
}
`;

// --- GLSL: near-field planet body ---------------------------------------

/**
 * GLSL chunk: the full near-field planet body (bands/clouds/terminator/dither).
 * Consumers paste this into their own fragment shader, declare
 * `uniform vec3 colors[5];` (rampFor()'s output), and call
 * `vec4 pixel_planet(vec2 uv, int family, float t, float seed)`.
 *
 * `family` uses the same order as PIXEL_ARCHETYPES (0 rock .. 6 hub). `uv` is
 * a plain 0..1 quad coordinate (these are billboard shaders, same as the
 * source modules — spherify() below FAKES the 3D sphere look via UV
 * distortion rather than shading a real mesh normal).
 *
 * Assembled from several ported Deep-Fold "Pixel Planets" (MIT) techniques,
 * collapsed into one function so a single family id switches pattern instead
 * of one .tscn per planet type — the noise/fbm/dither/spherify maths itself
 * is untouched, only the composition (which techniques feed which of this
 * module's 5 ramp stops) is new:
 *   - the zone/posterize terrain (light-distance + fbm, dithered at each
 *     threshold) is PlanetUnder.gdshader's technique — LandMasses' water
 *     layer, IceWorld's land layer, NoAtmosphere's ground layer, DryTerran
 *     and LavaWorld's land layer all run this exact formula with different
 *     constants
 *   - craters are NoAtmosphere's / LavaWorld's Craters.gdshader (identical
 *     code in both source files)
 *   - ocean's land mask is LandMasses' PlanetLandmass.gdshader land_cutoff test
 *   - ice's cold patches reuse IceWorld's lake_cutoff fbm test
 *   - ember's glowing veins are LavaWorld's Rivers.gdshader river_cutoff test
 *   - gas bands/turbulence are GasPlanetLayers' GasLayers.gdshader, verbatim
 *   - hub has no Deep-Fold source (NodeSingle.js's own header calls that
 *     archetype new, app-specific) — it reuses the tilted-ring-line idea
 *     already used in pixel_sprite's hub branch above, at this resolution
 * Original author: Deep-Fold — https://github.com/Deep-Fold/PixelPlanets (MIT).
 */
export const PIXEL_PLANET_GLSL = /* glsl */ `
const float PXP_PIXELS = 96.0;
const vec2 PXP_LIGHT = vec2(0.39, 0.39);

float pxp_rand(vec2 coord, float seed, float size) {
	// land has to be tiled — tiling only works for integer values, thus round();
	// vec2(2,1) simulates the planet having another side (PlanetUnder.gdshader).
	coord = mod(coord, vec2(2.0, 1.0) * round(size));
	return fract(sin(dot(coord, vec2(12.9898, 78.233))) * 15.5453 * seed);
}

float pxp_noise(vec2 coord, float seed, float size) {
	vec2 i = floor(coord);
	vec2 f = fract(coord);
	float a = pxp_rand(i, seed, size);
	float b = pxp_rand(i + vec2(1.0, 0.0), seed, size);
	float c = pxp_rand(i + vec2(0.0, 1.0), seed, size);
	float d = pxp_rand(i + vec2(1.0, 1.0), seed, size);
	vec2 cubic = f * f * (3.0 - 2.0 * f);
	return mix(a, b, cubic.x) + (c - a) * cubic.y * (1.0 - cubic.x) + (d - b) * cubic.x * cubic.y;
}

float pxp_fbm(vec2 coord, float seed, float size) {
	float value = 0.0;
	float scale = 0.5;
	for (int i = 0; i < 4; i++) {
		value += pxp_noise(coord, seed, size) * scale;
		coord *= 2.0;
		scale *= 0.5;
	}
	return value;
}

vec2 pxp_rotate(vec2 coord, float angle) {
	coord -= 0.5;
	coord *= mat2(vec2(cos(angle), -sin(angle)), vec2(sin(angle), cos(angle)));
	return coord + 0.5;
}

vec2 pxp_spherify(vec2 uv) {
	vec2 centered = uv * 2.0 - 1.0;
	float z = sqrt(max(0.0, 1.0 - dot(centered, centered)));
	vec2 sphere = centered / (z + 1.0);
	return sphere * 0.5 + 0.5;
}

// circleNoise() is by Leukbaars, https://www.shadertoy.com/view/4tK3zR
float pxp_circleNoise(vec2 uv, float seed, float size) {
	float uv_y = floor(uv.y);
	uv.x += uv_y * 0.31;
	vec2 f = fract(uv);
	float h = pxp_rand(vec2(floor(uv.x), uv_y), seed, size);
	float m = length(f - 0.25 - (h * 0.5));
	float r = h * 0.25;
	return smoothstep(0.0, r, m * 0.75);
}

// NoAtmosphere.js / LavaWorld.js Craters.gdshader — identical in both.
float pxp_crater(vec2 uv, float seed, float size, float t) {
	float c = 1.0;
	for (int i = 0; i < 2; i++) {
		c *= pxp_circleNoise((uv * size) + (float(i + 1) + 10.0) + vec2(t, 0.0), seed, size);
	}
	return 1.0 - c;
}

// Posterizes light-distance into a 0..4 ramp index, dithering a soft
// checkerboard band at each threshold instead of a hard cut —
// PlanetUnder.gdshader's dither_border technique, just with 5 stops instead
// of 2-3.
int pxp_zoneIdx(float d_light, float scale, bool dith) {
	float band = d_light * scale;
	if (dith && fract(band) > 0.85) band += 1.0;
	return int(clamp(floor(band), 0.0, 4.0));
}

vec4 pixel_planet(vec2 uv, int family, float t, float seed) {
	vec2 pix = floor(uv * PXP_PIXELS) / PXP_PIXELS;
	bool dith = mod(pix.x + uv.y, 2.0 / PXP_PIXELS) <= 1.0 / PXP_PIXELS;
	float d_circle = distance(pix, vec2(0.5));
	float alpha = step(d_circle, 0.49999);

	// The public signature has no separate rotation input, so seed doubles as
	// a fixed per-instance tilt — two planets sharing a family still present
	// a different face.
	float rotation = seed * 6.2831853;
	vec2 sp = pxp_rotate(pix, rotation);
	sp = pxp_spherify(sp);

	int idx = 2;

	if (family == 4) {
		// --- gas: GasLayers.gdshader, band + turbulence composition, verbatim ---
		float size = 10.107;
		float band = pxp_fbm(vec2(0.0, sp.y * size * 0.892), seed, size);
		float turb = 0.0;
		for (int i = 0; i < 10; i++) {
			turb += pxp_circleNoise((sp * size * 0.3) + (float(i + 1) + 10.0) + vec2(t * 0.05, 0.0), seed, size);
		}
		float fbm1 = pxp_fbm(sp * size, seed, size);
		float fbm2 = pxp_fbm(sp * vec2(1.0, 2.0) * size + fbm1 + vec2(-t * 0.05, 0.0) + turb, seed, size);
		fbm2 *= pow(band, 2.0) * 7.0;
		float light_d = distance(sp, PXP_LIGHT);
		float light = fbm2 + light_d * 1.8;
		fbm2 += light_d - 0.3;
		fbm2 = smoothstep(-0.2, 4.0 - fbm2, light);
		if (dith) fbm2 *= 1.1;
		idx = int(clamp(floor(fbm2 * 5.0), 0.0, 4.0));
	} else if (family == 1) {
		// --- ocean: PlanetUnder water zone + PlanetLandmass land_cutoff mask ---
		float size = 5.228;
		float d_light = distance(sp, PXP_LIGHT) + pxp_fbm(sp * size + vec2(t * 0.1, 0.0), seed, size) * 0.3;
		idx = pxp_zoneIdx(d_light, 6.0, dith);
		float lsize = 4.292;
		float fbm1 = pxp_fbm(sp * lsize + vec2(t * 0.2, 0.0), seed, lsize);
		if (fbm1 > 0.62) idx = max(idx - 2, 0); // land_cutoff (0.633 in the source .tscn)
	} else if (family == 2) {
		// --- ice: PlanetUnder land zone (bright ramp) + IceWorld lake_cutout ---
		float size = 8.0;
		float d_light = distance(sp, PXP_LIGHT) + pxp_fbm(sp * size + vec2(t * 0.25, 0.0), seed, size) * 0.3;
		idx = min(pxp_zoneIdx(d_light, 4.0, dith), 3); // never reaches the darkest stop — ice stays pale
		float lake = pxp_fbm(sp * 10.0 + vec2(t * 0.2, 0.0), seed, 10.0);
		if (lake > 0.55) idx = min(idx + 2, 4); // IceWorld's lake_cutoff, darkened instead of cut out
	} else if (family == 3) {
		// --- ember: NoAtmosphere-style crust + craters + LavaWorld river veins ---
		float size = 10.0;
		float d_light = distance(sp, PXP_LIGHT) + pxp_fbm(sp * size + vec2(t * 0.2, 0.0), seed, size) * 0.3;
		// crust reads near-black but still varies with d_light — pxp_zoneIdx's
		// own 0..4 clamp would swallow a large additive bias entirely (it did,
		// until this was caught by the render-coverage check below), so the
		// crust's 2..4 sub-range is built directly instead of biasing zoneIdx.
		float crustBand = d_light * 2.2;
		if (dith && fract(crustBand) > 0.85) crustBand += 1.0;
		idx = 2 + int(clamp(floor(crustBand), 0.0, 2.0));
		if (pxp_crater(sp, seed, 3.5, t * 0.2) < 0.5) idx = min(idx + 1, 4);
		float fbm1 = pxp_fbm(sp * size + vec2(t * 0.2, 0.0), seed, size);
		float river = pxp_fbm(sp + fbm1 * 2.5, seed, size);
		if (river > 0.46) idx = 0; // river_cutoff — glowing lava vein
	} else if (family == 6) {
		// --- hub: no Deep-Fold source; same bright-core-plus-ring idea as
		// pixel_sprite's variant 6, at this function's resolution ---
		float size = 6.0;
		float d_light = distance(sp, PXP_LIGHT) + pxp_fbm(sp * size + vec2(t * 0.15, 0.0), seed, size) * 0.2;
		idx = min(pxp_zoneIdx(d_light, 3.0, dith), 2); // bright core, never reaches the dark stops
		vec2 d0 = sp * 2.0 - 1.0;
		float tilt = -0.3 * sin(t * 0.25);
		if (abs(d0.y - tilt * d0.x) < 0.05 && length(d0) > 0.55) idx = 0; // the ring
	} else {
		// --- rock / dead: shared NoAtmosphere-style crust + craters, dead flatter ---
		bool dead = family == 5;
		float size = 8.0;
		float speed = dead ? 0.4 : 0.1;
		float strength = dead ? 0.15 : 0.3;
		float d_light = distance(sp, PXP_LIGHT) + pxp_fbm(sp * size + vec2(t * speed, 0.0), seed, size) * strength;
		idx = pxp_zoneIdx(dead ? d_light + 0.2 : d_light, dead ? 4.0 : 5.0, dith);
		if (pxp_crater(sp, seed, dead ? 5.0 : 3.5, t * 0.1) < 0.5) idx = min(idx + 1, 4);
	}

	return vec4(colors[clamp(idx, 0, 4)], alpha);
}
`;
