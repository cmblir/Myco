// Graph skins (independent of the app theme) — the fixed palettes and the
// per-skin ambience gates. DOM-free (graphTheme.ts pulls sigma, which needs a
// browser) so this stays unit-testable in the node vitest environment.
// "auto" is resolved in graphTheme.makeTheme via readTheme(); the fixed skins
// pin a palette so the graph can stay a black void / white paper / starry
// galaxy no matter which app theme is active. Palettes mirror readTheme's
// dark/light values so every downstream dark-vs-light branch (blending, bloom,
// edge neutrals) behaves identically — only the background + ambience differ.
import type { GraphTheme } from "./graphTheme";
import type { GraphSkinKey } from "./graphSettings";

const SKIN_DARK_BASE: Omit<GraphTheme, "bg"> = {
  ink: "#e6e8eb",
  node: "#c8c8c8",
  starDim: "#565b64",
  gxCore: "#ffe9c4",
  gxArm: "#cdd7f0",
  gxHalo: "#5d6c92",
  edge: "rgba(170,185,215,0.10)",
  edgeHi: "rgba(190,205,240,0.9)",
  accent: "#7aa7ff",
};

const SKIN_THEMES: Record<Exclude<GraphSkinKey, "auto">, GraphTheme> = {
  // True-black void: the dark look with the starfield/nebula stripped (see
  // skinAmbience) and the background pinned to #000000.
  black: { ...SKIN_DARK_BASE, bg: "#000000", sceneBg: "#000000" },
  // Clean paper: the light palette without the depth-cue star shells.
  white: {
    bg: "#ffffff",
    sceneBg: "#ffffff",
    ink: "#111418",
    node: "#3a3f47",
    starDim: "#9aa0a8",
    gxCore: "#7a5a1f",
    gxArm: "#3a4664",
    gxHalo: "#8a93ac",
    edge: "rgba(40,50,70,0.10)",
    edgeHi: "rgba(30,40,60,0.8)",
    accent: "#3b82f6",
  },
  // Deep space: dark palette + the full ambience (3 star shells, nebula).
  galaxy: { ...SKIN_DARK_BASE, bg: "#05060d", sceneBg: "#05060d" },
  // Cosmic web (the dark-matter-simulation look): near-black indigo void,
  // tiny stars for nodes, and the EDGES as the protagonist — thin violet
  // filaments that brighten where they overlap (additive accumulation).
  // Warm core hue for hubs mirrors the IllustrisTNG blue-filament /
  // orange-cluster palette.
  web: {
    ...SKIN_DARK_BASE,
    bg: "#02040c",
    sceneBg: "#02040c",
    node: "#dfe4ff",
    starDim: "#4a5578",
    gxCore: "#ffb86b",
    gxArm: "#93a4e8",
    gxHalo: "#4a5a8f",
    edge: "rgba(120,135,235,0.16)",
    edgeHi: "rgba(190,205,255,0.95)",
    accent: "#8a93ff",
  },
};

// Resolve a FIXED skin to a fresh palette copy (scene code mutates themes).
export function skinTheme(skin: Exclude<GraphSkinKey, "auto">): GraphTheme {
  return { ...SKIN_THEMES[skin] };
}

// Perceived-luminance test on the theme background. The graph picks its node
// palette (dark void vs. dark-on-paper) from THIS, not from the app theme, so a
// white skin always gets the dark, saturated stars that read on paper. Non-hex
// backgrounds fall back to "dark" (the default void).
export function isLightBackground(theme: GraphTheme): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(theme.bg.trim());
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150; // Rec.601 luma, 0..255
}

// Which ambient background layers a skin shows. `dark` matters only for
// "auto", where the layers keep their theme-derived behaviour. Meteors are a
// galaxy-skin signature — the other skins stay calm.
export interface SkinAmbience {
  starfield: boolean;
  nebula: boolean;
  meteors: boolean;
}

export function skinAmbience(skin: GraphSkinKey, dark: boolean): SkinAmbience {
  switch (skin) {
    case "black":
      return { starfield: false, nebula: false, meteors: false };
    case "white":
      return { starfield: false, nebula: false, meteors: false };
    case "galaxy":
      return { starfield: true, nebula: true, meteors: true };
    case "web":
      // The web IS the picture — keep a faint star depth cue, drop the nebula
      // wash and meteors so nothing competes with the filament accumulation.
      return { starfield: true, nebula: false, meteors: false };
    default:
      // Auto skin: starfield on both themes, nebula dark-only — and meteors on
      // dark too. First-run users land here and never find the skin picker;
      // shooting stars are near-free (one LineSegments draw, ≤3 trails) and
      // they're the difference between "static chart" and "alive sky".
      return { starfield: true, nebula: dark, meteors: dark };
  }
}
