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

function hexToRgb01(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// Rec.709 relative luminance — used to keep the community tint from moving a
// stop's brightness, so the 5-stop value curve (what makes the pixel shading
// read as a lit sphere) survives tinting untouched.
function luma([r, g, b]: [number, number, number]): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Light theme reads on white/paper instead of the near-black void these
// ramps were tuned for — same move as graphData.ts's shadeHex() lightBg
// branch: darker AND more saturated, so nodes stay legible instead of
// washing out. Hue is untouched (theme adjusts value, not hue).
const LIGHT_THEME_LIGHTNESS_SCALE = 0.78;
const LIGHT_THEME_SAT_BOOST = 1.15;

// Per-stop weight of the community tint, rim → lit → mid → shadow → void.
//
// Why not a hue rotation of the whole ramp (what this file did until the
// "every planet is pale pink" report): rotating all 5 stops toward the
// community hue IS the community hue — Mars, Io and Jupiter all collapsed onto
// one colour and only their value curves differed. The body's identity has to
// win. So: the two stops that carry recognition — 0 (the sunlit rim / cloud /
// polar cap / lava core) and 1 (the lit surface) — are barely touched, the mid
// and shadow stops take most of the tint (a shadow is ambient light, which
// really is whatever colour the surroundings are), and the void stop takes a
// little so the terminator does not end on a colour foreign to the community.
// Weights tuned in the archetype harness: at a flat 0.30 a green community
// still turned Mars olive and Jupiter's belts green.
const TINT_WEIGHT = [0.0, 0.08, 0.2, 0.26, 0.18];

// ...and the weight is further scaled by how much chroma the stop already has.
// A stop that is nearly neutral (lunar regolith, cloud white) has no colour
// identity to defend, but that also means a tint lands on it undiluted and
// screams — the Moon went visibly green under a green community at a weight
// that left saturated stops looking untouched. Scaling by the stop's own chroma
// makes the tint proportional to what is already there: grey bodies stay grey,
// coloured bodies bend a little.
function tintWeight(stop: number, base: [number, number, number]): number {
  const chroma = Math.max(...base) - Math.min(...base);
  return TINT_WEIGHT[stop] * (0.15 + 0.85 * chroma);
}

// Each archetype's 5-stop ramp, rim/highlight → lit → mid → shadow → void,
// sampled from what the real body actually looks like rather than invented.
// The stop *meanings* differ per archetype (see the GLSL below) because a
// 5-entry indexed ramp has to carry both the lighting zones and the two or
// three materials that make a body recognisable at 16-96px.
//
// References (checked 2026-08, not from memory):
//  - Mars: en.wikipedia.org/wiki/Mars_surface_color — "butterscotch", nanophase
//    ferric oxide dust over darker basalt; up to 50% of the iron is black
//    magnetite, which is why Mars is dusty low-contrast rather than fire-red.
//  - Earth: earthobservatory.nasa.gov/features/BlueMarble — deep blue ocean,
//    green/brown-tan land, white cloud, blue Rayleigh limb.
//  - Europa: open.edu "Icy bodies: Europa and elsewhere" + JPL PIA00275 — albedo
//    ~0.68, bluish icy plains, brown/reddish tholin-stained lineae.
//  - Io: planetary.org/articles/2629 (Jason Perry's true-colour reprocessing) —
//    NOT the vivid pizza; muted yellow/white-pink crust, red deposits round the
//    volcanic centres, grey-brown poles, black silicate paterae.
//  - Jupiter: science.nasa.gov/jupiter/jupiter-facts + JPL PIA24818 — off-white
//    ammonia-ice "zones", red-brown "belts", one much darker equatorial belt.
//  - Moon: zmescience "the real color of the moon" / NASA "Colorful Moon" —
//    near-neutral grey, bright anorthositic highlands vs dark iron-rich maria,
//    albedo 0.03..0.12, hard terminator (no atmosphere).
//  - Sun: en.wikipedia.org/wiki/Limb_darkening — the limb is ~30% of central
//    intensity and cooler/redder; the photosphere itself is white, not yellow
//    (the yellow is our atmosphere), so the core stop is white and the warmth
//    only appears outward.
const ARCHETYPE_RAMP: Record<PixelArchetype, string[]> = {
  // polar cap / bright dust · sunlit butterscotch dust · rust plain · dark
  // basaltic albedo feature (Syrtis Major) · night
  rock: ["#efe6d8", "#c9834b", "#97562f", "#5e4633", "#2b1a12"],
  // cloud white · Rayleigh limb haze · green-tan continent · deep sunlit ocean ·
  // night ocean
  ocean: ["#f4f7fb", "#a8cfe6", "#6f8a46", "#17548c", "#061a33"],
  // specular ice · bright plain · blue-white shadowed ice · tan tholin lineae ·
  // deep blue night limb
  ice: ["#fdfeff", "#e5eef7", "#bed2e3", "#9c7f68", "#3d5468"],
  // white-hot vent · incandescent orange fissure · sulphur crust · grey-brown
  // crust · black silicate patera
  ember: ["#ffe9a8", "#f2761f", "#9c8a4e", "#5a4630", "#211814"],
  // zone core cream · pale zone · ochre transition · red-brown belt · dark belt
  gas: ["#f7ead0", "#e3caa0", "#c39a63", "#96603a", "#452a1d"],
  // highland regolith highlight · highland · regolith · mare basalt · night
  dead: ["#d8d4cd", "#aaa49b", "#7b766f", "#494642", "#191817"],
  // photosphere core · granulation · warm disc · limb darkening · corona
  hub: ["#fffdf5", "#ffe9a8", "#ffc247", "#ee8a1e", "#a33d08"],
};

/**
 * Derive the 5-entry ramp for an archetype, lightly tinted toward a community
 * hue. The archetype's own identity dominates — see TINT_WEIGHT for why.
 */
export function rampFor(
  a: PixelArchetype,
  hue: number,
  dark: boolean,
): PixelRamp {
  const tint = hslToRgb01(((hue % 360) + 360) % 360, 1, 0.5);
  return ARCHETYPE_RAMP[a].map((hex, i) => {
    const base = hexToRgb01(hex);
    const w = tintWeight(i, base);
    // Mix toward the community hue, then restore the stop's original luminance
    // so tinting can only shift chroma, never the shading curve.
    const mixed = base.map((c, k) => c * (1 - w) + tint[k] * w) as [
      number,
      number,
      number,
    ];
    const my = luma(mixed);
    const k = my > 1e-4 ? luma(base) / my : 1;
    let out = mixed.map((c) => c * k) as [number, number, number];
    if (!dark) {
      // Desaturate-safe light-theme move: pivot each channel about the stop's
      // own luminance to add saturation, then darken the whole stop.
      const y = luma(out);
      out = out.map((c) =>
        Math.max(0, (y + (c - y) * LIGHT_THEME_SAT_BOOST) * LIGHT_THEME_LIGHTNESS_SCALE),
      ) as [number, number, number];
    }
    return out.map((c) => Math.min(1, c)) as [number, number, number];
  });
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

	// Each branch spends the ramp on the ONE feature that makes its real
	// referent recognisable at 16px — see ARCHETYPE_RAMP for what each stop is.
	// Index 0 is a highlight stop (cap / cloud / lava core / star core), never an
	// ordinary surface pixel: spending it on surface is what turned every
	// archetype into the same white blob.
	if (variant == 0) {              // rock — Mars: ochre dust, dark basalt, polar cap
		idx = zone;
		if (pxs_vnoise(sp * 3.6 + vec2(t * 0.05, 0.0), seed) > 0.64) idx = min(zone + 1, 3);
		if (d.y > 0.62) idx = 0;     // the cap, the one thing that says Mars at this size
	} else if (variant == 1) {       // ocean — Earth: blue sea, green land, white cloud
		idx = zone < 3 ? 3 : 4;
		if (pxs_vnoise(sp * 3.6 + vec2(t * 0.06, 0.0), seed) > 0.58) idx = zone < 3 ? 2 : 3;
		if (zone == 1 && pxs_vnoise(sp * 2.4 + vec2(-t * 0.05, 0.0), seed) > 0.62) idx = 0;
	} else if (variant == 2) {       // ice — Europa: albedo ~0.7, tan crack lineae
		idx = zone == 1 ? 1 : 2;
		if (zone == 1 && pxs_vnoise(sp * 2.2, seed) > 0.66) idx = 0;
		if (abs(fract(sp.x * 1.7 + pxs_vnoise(sp * 1.6, seed) * 2.4) - 0.5) < 0.06) idx = 3;
		if (zone == 3) idx = 4;
	} else if (variant == 3) {       // ember — Io: dark crust, glowing fissure
		idx = zone + 1;
		float n = pxs_vnoise(sp * 3.0 + vec2(t * 0.08, 0.0), seed);
		float fis = abs(d.y + 0.38 * (n - 0.5));
		float pulse = 0.09 + 0.035 * sin(t * 1.2);
		if (fis < pulse + 0.13) idx = 1;                   // 1px halo sells it as heat
		if (fis < pulse) idx = 0;                           // core of the crack, ignores the terminator
		if (n > 0.74) idx = 0;
	} else if (variant == 4) {       // gas — Jupiter: cream zones, red-brown belts
		float y = d.y + 0.10 * pxs_vnoise(sp * 2.0 + vec2(t * 0.09, 0.0), seed);
		float b = sin((y * 3.1 + 0.4) * 3.14159);
		idx = b > 0.35 ? 1 : (b > -0.2 ? 2 : 3);
		if (b > 0.85) idx = 0;                              // brightest zone core
		if (zone == 3) idx = min(idx + 1, 4);
	} else if (variant == 5) {       // dead — the Moon: neutral grey, pitted
		idx = zone;
		if (pxs_vnoise(sp * 3.8 + vec2(t * 0.02, 0.0), seed) > 0.66) idx = min(zone + 1, 4);
	} else if (variant == 6) {       // hub — a star: radial limb darkening, granulated
		float rr = len / rl;                                // self-luminous: no terminator
		idx = rr < 0.42 ? 0 : (rr < 0.68 ? 1 : (rr < 0.88 ? 2 : 3));
		if (pxs_vnoise(sp * 4.5 + vec2(t * 0.2, 0.0), seed) > 0.70) idx = max(idx - 1, 0);
	}

	// --- 1px lit rim / 1px dark rim: short arcs, not half-rings ---
	float edge = step(rl - ps * 1.05, len) * body;
	// variant 3's only bright thing is its crack; variant 6 is a star, whose
	// brightness is radial, so neither takes a directional rim.
	if (edge > 0.5 && sh < -0.45 && variant != 3 && variant != 6) idx = 0;
	if (edge > 0.5 && sh > 0.45 && variant != 6) idx = 4;

	float a = body;

	// hub's corona: a dithered halo just outside the photosphere plus the four
	// axis spikes a bright star shows. Replaces the tilted Saturn ring the hub
	// used to wear — a star does not have rings.
	if (variant == 6 && len > rl && len < rl * 1.45) {
		bool spike = abs(d.x) < ps * 0.9 || abs(d.y) < ps * 0.9;
		bool halo = mod(px.x + px.y, 2.0) < 1.0 && len < rl * 1.22;
		if (spike || halo) {
			a = 1.0;
			idx = 4;
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
		// --- gas: Jupiter — off-white ammonia "zones" alternating with red-brown
		// "belts", edges torn up by turbulence, one much darker belt and one storm
		// oval (science.nasa.gov/jupiter/jupiter-facts, JPL PIA24818). The source
		// GasLayers.gdshader fbm-of-fbm produced marbling rather than bands, so the
		// band term is an explicit latitude sine now and the fbm only warps it.
		float size = 10.107;
		float turb = 0.0;
		for (int i = 0; i < 6; i++) {
			turb += pxp_circleNoise((sp * size * 0.3) + (float(i + 1) + 10.0) + vec2(t * 0.04, 0.0), seed, size);
		}
		float lat = sp.y + 0.035 * pxp_fbm(sp * vec2(1.0, 3.0) * size + turb + vec2(-t * 0.05, 0.0), seed, size);
		// ~5 belt/zone pairs; spherify() already crowds them toward the poles, as
		// on the real planet.
		float band = sin(lat * 34.0 + seed * 6.2831853);
		idx = band > 0.35 ? 1 : (band > -0.1 ? 2 : 3);
		if (band > 0.80) idx = 0;
		// The one dark belt (Jupiter's NEB) — pinned to a seeded latitude so it
		// does not move with the band phase.
		if (abs(lat - (0.30 + 0.26 * fract(seed * 3.7))) < 0.030) idx = 4;
		// Storm oval, wider than tall like the Great Red Spot.
		vec2 storm = (sp - vec2(fract(seed * 7.3), 0.63)) * vec2(1.0, 2.4);
		if (dot(storm, storm) < 0.0042) idx = 0;
		// distance(sp, PXP_LIGHT) only spans ~0.16 (sub-solar) .. ~0.85 (far limb)
		// after spherify(), so every threshold in this function is calibrated to
		// that range, not to 0..1.
		float d_light = distance(sp, PXP_LIGHT);
		if (d_light > (dith ? 0.54 : 0.58)) idx = min(idx + 1, 4);
		if (d_light > 0.74) idx = 4;
	} else if (family == 1) {
		// --- ocean: Earth — deep blue sea, green/tan continents, white cloud
		// swirls over both, and a bright Rayleigh-scattered limb on the day side
		// (earthobservatory.nasa.gov/features/BlueMarble). The old version made
		// land BRIGHTER than the sea by two whole stops and had no cloud at all.
		float size = 5.228;
		float d_light = distance(sp, PXP_LIGHT) + pxp_fbm(sp * size + vec2(t * 0.06, 0.0), seed, size) * 0.18;
		if (dith) d_light += 0.04; // dithered terminator instead of a hard cut
		int night = int(step(0.60, d_light));
		idx = 3 + night; // ocean is the default surface — Earth is 70% water
		float lsize = 4.292;
		if (pxp_fbm(sp * lsize + vec2(t * 0.2, 0.0), seed, lsize) > 0.53) idx = 2 + night;
		// Cloud only reads on the day side; at night it is just darker ocean.
		if (night == 0 && pxp_fbm(sp * 3.1 + vec2(-t * 0.12, t * 0.02), seed, 3.1) > 0.57) idx = 0;
		if (night == 0 && d_circle > 0.455) idx = 1; // atmospheric limb
	} else if (family == 2) {
		// --- ice: Europa — albedo ~0.68, so the lit disc never leaves the top
		// three stops; identity comes from the tan tholin-stained lineae criss-
		// crossing the plains (open.edu "Icy bodies: Europa", JPL PIA00275).
		float size = 7.0;
		float d_light = distance(sp, PXP_LIGHT) + pxp_fbm(sp * size + vec2(t * 0.08, 0.0), seed, size) * 0.16;
		idx = min(pxp_zoneIdx(d_light, 4.0, dith), 2);
		// Lineae: a long straight-ish phase ramp, warped only slightly by fbm and
		// thresholded near its own midline, so they come out as the long curved
		// cracks Europa actually has rather than a contour-map scribble.
		float warp = pxp_fbm(sp * 2.0 + vec2(t * 0.03, 0.0), seed, 2.0);
		if (abs(fract(sp.x * 2.2 + warp * 3.4) - 0.5) < 0.028) idx = 3;
		if (abs(fract(sp.y * 1.8 - warp * 2.8) - 0.5) < 0.020) idx = 3;
		if (d_light > 0.70) idx = 4; // blue-white night limb
	} else if (family == 3) {
		// --- ember: Io — muted sulphur-yellow crust, grey-brown toward the poles,
		// black silicate paterae, and incandescent fissures
		// (planetary.org/articles/2629, true-colour reprocessing). The old
		// river_cutoff test at 0.46 flooded whole discs with the glow stop (a solid
		// glowing ball at seed 0.77 in the harness); a ridge test cannot flood.
		float size = 9.0;
		float d_light = distance(sp, PXP_LIGHT) + pxp_fbm(sp * size + vec2(t * 0.12, 0.0), seed, size) * 0.25;
		// pxp_zoneIdx's own 0..4 clamp would swallow a large additive bias, so the
		// crust's 2..4 sub-range is built directly instead of biasing zoneIdx.
		float crustBand = d_light * 2.4;
		if (dith && fract(crustBand) > 0.85) crustBand += 1.0;
		idx = 2 + int(clamp(floor(crustBand), 0.0, 2.0));
		if (pxp_crater(sp, seed, 4.0, t * 0.1) > 0.5) idx = 4; // black patera floors
		float fbm1 = pxp_fbm(sp * size + vec2(t * 0.2, 0.0), seed, size);
		float vein = abs(pxp_fbm(sp * 4.0 + fbm1 * 0.8, seed, 4.0) - 0.5);
		float pulse = 0.020 + 0.006 * sin(t * 1.1);
		if (vein < pulse + 0.030) idx = 1; // cooling orange margin
		if (vein < pulse) idx = 0;         // white-hot core of the fissure
	} else if (family == 6) {
		// --- hub: a star. Self-luminous, so there is no terminator at all —
		// brightness falls off RADIALLY (solar limb darkening: the limb is ~30% of
		// central intensity, en.wikipedia.org/wiki/Limb_darkening), the surface is
		// granulated, and a dithered corona rings the photosphere. The old version
		// lit a star from the side and hung a Saturn ring on it.
		float r = d_circle / 0.5;
		float gran = pxp_fbm(sp * 16.0 + vec2(t * 0.15, t * 0.09), seed, 16.0);
		float v = r * r * 4.2 + (gran - 0.5) * 2.2;
		if (dith) v += 0.18;
		idx = int(clamp(floor(v), 0.0, 3.0));
		if (r > 0.88) {
			idx = 4;
			// The corona has no edge, so it is dithered away instead of ending on a
			// hard ring — alpha is already a binary step, so half the pixels drop.
			if (r > 0.94 && !dith) alpha = 0.0;
		}
	} else {
		// --- rock (Mars) / dead (the Moon): both cratered airless-looking crust,
		// but the identity is opposite. Mars is dust: LOW contrast, a bright polar
		// cap and broad dark basaltic albedo features (Syrtis Major), craters
		// mostly buried (en.wikipedia.org/wiki/Mars_surface_color — the red is a
		// millimetres-thick veneer over half-magnetite, half-hematite iron).
		// The Moon is bare rock: high contrast, bright anorthositic highlands, dark
		// iron-rich maria, dense sharp craters, hard terminator (no atmosphere).
		bool dead = family == 5;
		float size = dead ? 7.0 : 6.0;
		float d_light = distance(sp, PXP_LIGHT) + pxp_fbm(sp * size + vec2(t * (dead ? 0.02 : 0.06), 0.0), seed, size) * (dead ? 0.10 : 0.22);
		// Mars keeps stop 0 for its polar cap alone, so its lighting starts at 1;
		// the Moon's brightest highlands genuinely do reach the top stop.
		idx = pxp_zoneIdx(d_light, dead ? 5.2 : 4.8, dith);
		if (!dead) idx = max(idx, 1);
		// Broad dark terrain: lunar maria / martian albedo features.
		if (pxp_fbm(sp * (dead ? 2.2 : 2.4) + vec2(t * 0.03, 0.0), seed, dead ? 2.2 : 2.4) > (dead ? 0.58 : 0.56)) idx = min(idx + 1, 4);
		float cr = pxp_crater(sp, seed, dead ? 6.0 : 3.0, t * (dead ? 0.02 : 0.06));
		if (cr > (dead ? 0.5 : 0.72)) idx = min(idx + 1, 4); // shadowed crater floor
		// Polar cap — Mars only; the Moon has no cap worth a stop at this size.
		// spherify() crowds sp.y toward the middle, so the visible disc only spans
		// roughly 0.27..0.73 — a cap threshold has to sit inside that.
		if (!dead && abs(sp.y - 0.5) > 0.27 && idx < 4) idx = 0;
	}

	return vec4(colors[clamp(idx, 0, 4)], alpha);
}
`;
