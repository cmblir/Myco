// Seeded deep-sky bake — every vault gets its OWN sky. A one-time CPU fbm
// render onto an equirect canvas (two dim hue-clouds derived from the vault
// seed, domain-lite value noise), used as scene.background on the deep-space
// skins. Zero per-frame cost: the texture is baked once per vault/theme and
// swapped in when ready. Deliberately DIM (a wash, not wallpaper) so the
// starfield, nebula sprites and the graph itself keep the stage.

import * as THREE from "three";

/** Deterministic 0..1 hash from a string seed + salt (FNV-1a mix). */
export function seedUnit(seed: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** Deterministic value-noise lattice from an integer pair + seed. */
function lattice(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (((h ^ (h >>> 16)) >>> 0) % 100000) / 100000;
}

/** Smooth 2D value noise, tiling horizontally with period `px` cells. */
export function valueNoise(x: number, y: number, px: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const wrap = (v: number): number => ((v % px) + px) % px;
  const a = lattice(wrap(ix), iy, seed);
  const b = lattice(wrap(ix + 1), iy, seed);
  const c = lattice(wrap(ix), iy + 1, seed);
  const d = lattice(wrap(ix + 1), iy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** 4-octave fbm over the tiling value noise. Returns 0..1-ish. */
export function fbm(x: number, y: number, px: number, seed: number): number {
  let v = 0;
  let amp = 0.5;
  let fx = x;
  let fy = y;
  let period = px;
  for (let o = 0; o < 4; o++) {
    v += valueNoise(fx, fy, period, seed + o * 101) * amp;
    amp *= 0.5;
    fx *= 2;
    fy *= 2;
    period *= 2;
  }
  return v;
}

/**
 * Bake the seeded sky to an equirect texture. Returns null when no 2D canvas
 * is available (headless tests) — callers treat that as "keep the flat bg".
 * ~768×384 × 4 octaves ≈ a couple hundred ms; call it off the critical path.
 */
export function bakeSeededSky(seed: string, dark: boolean): THREE.Texture | null {
  const W = 768;
  const H = 384;
  const cv = typeof document !== "undefined" ? document.createElement("canvas") : null;
  const ctx = cv?.getContext("2d") ?? null;
  if (!cv || !ctx) return null;
  cv.width = W;
  cv.height = H;
  const img = ctx.createImageData(W, H);
  const data = img.data;

  // Two cloud hues from the seed — analogous-ish split so the sky reads as one
  // atmosphere, not a rainbow. Base near-black matches the deep-space skins.
  const hueA = seedUnit(seed, 1) * 360;
  const hueB = (hueA + 90 + seedUnit(seed, 2) * 120) % 360;
  const seedI = Math.floor(seedUnit(seed, 3) * 1e6);
  const toRgb = (h: number, s: number, l: number): [number, number, number] => {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = h / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    const [r, g, b] =
      hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x]
      : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
    const m = l - c / 2;
    return [r + m, g + m, b + m];
  };
  const [ar, ag, ab] = toRgb(hueA, 0.55, 0.5);
  const [br, bg, bb] = toRgb(hueB, 0.5, 0.5);
  // Base floor mirrors the dark scene bg; light theme gets a paper-safe wash.
  const base = dark ? 5 : 244;
  const gain = dark ? 46 : 8; // max wash above base — a whisper, not wallpaper

  const CELLS = 6; // noise cells across the equirect width (tiles horizontally)
  for (let y = 0; y < H; y++) {
    // Fade the wash toward the poles so the equirect pinch never shows.
    const pole = Math.sin((y / H) * Math.PI);
    for (let x = 0; x < W; x++) {
      const nx = (x / W) * CELLS;
      const ny = (y / H) * (CELLS / 2);
      // Domain-lite warp: offset one field by another for cloudy filaments.
      const w = fbm(nx + 3.7, ny + 1.3, CELLS, seedI + 977);
      const na = fbm(nx + w * 0.9, ny, CELLS, seedI);
      const nb = fbm(nx - w * 0.7, ny + 2.1, CELLS, seedI + 499);
      // Sharpen: only the upper end of the noise becomes visible cloud.
      const ca = Math.max(0, na - 0.55) * 2.2 * pole;
      const cb = Math.max(0, nb - 0.58) * 2.0 * pole;
      const o = (y * W + x) * 4;
      data[o] = Math.min(255, base + gain * (ca * ar + cb * br));
      data[o + 1] = Math.min(255, base + gain * (ca * ag + cb * bg));
      data[o + 2] = Math.min(255, base + gain * (ca * ab + cb * bb));
      data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
