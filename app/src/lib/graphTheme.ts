// Graph theme colours, read from the live CSS variables / rendered background.
import type { GraphSkinKey } from "./graphSettings";
import { skinTheme } from "./graphSkins";

export interface GraphTheme {
  bg: string;
  // Exact scene-background override. When set, GraphScene paints this verbatim
  // instead of its soft near-black default — the "black" skin needs a true
  // #000000 void and "galaxy" pins the deep-space blue regardless of app theme.
  sceneBg?: string;
  node: string;
  // Fallback dim star colour for nodes outside a sized community.
  starDim: string;
  // Galaxy radius tiers: warm glowing core → blue-white arms → dim halo.
  gxCore: string;
  gxArm: string;
  gxHalo: string;
  ink: string;
  edge: string; // rgba w/ alpha — sigma honours the alpha channel (unlike cytoscape WebGL)
  edgeHi: string;
  accent: string;
}

// Decide light/dark from the ACTUAL rendered --bg, not data-theme: the
// attribute can read stale in the window between mount and the app's theme
// effect, which would paint invisible (dark-on-dark) nodes.
function isDarkBackground(cs: CSSStyleDeclaration): boolean {
  const bg = cs.getPropertyValue("--bg").trim();
  const m =
    /^#([0-9a-f]{6})$/i.exec(bg) ??
    /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(bg);
  if (!m) return true;
  let r: number, g: number, b: number;
  if (m[0].startsWith("#")) {
    const h = m[1];
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
  } else {
    r = +m[1];
    g = +m[2];
    b = +m[3];
  }
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}

export function readTheme(): GraphTheme {
  const cs = getComputedStyle(document.documentElement);
  const dark = isDarkBackground(cs);
  return {
    bg: cs.getPropertyValue("--bg").trim() || (dark ? "#0f1115" : "#fafaf9"),
    ink: cs.getPropertyValue("--ink").trim() || (dark ? "#e6e8eb" : "#111418"),
    node: dark ? "#c8c8c8" : "#3a3f47",
    starDim: dark ? "#565b64" : "#9aa0a8",
    gxCore: dark ? "#ffe9c4" : "#7a5a1f",
    gxArm: dark ? "#cdd7f0" : "#3a4664",
    gxHalo: dark ? "#5d6c92" : "#8a93ac",
    // Cosmic-web filaments: very faint, so the weave reads as a soft glow
    // rather than tangled wires. Alpha is honoured by sigma.
    edge: dark ? "rgba(170,185,215,0.10)" : "rgba(40,50,70,0.10)",
    edgeHi: dark ? "rgba(190,205,240,0.9)" : "rgba(30,40,60,0.8)",
    accent:
      cs.getPropertyValue("--accent").trim() || (dark ? "#7aa7ff" : "#3b82f6"),
  };
}

// Resolve the active skin to a palette. "auto" reads the live CSS variables;
// fixed skins return their pinned palette (see graphSkins.ts — DOM-free).
export function makeTheme(skin: GraphSkinKey): GraphTheme {
  return skin === "auto" ? readTheme() : skinTheme(skin);
}

