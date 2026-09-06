// Graph theme — the canvas palette, read from the live CSS variables so the
// Survey follows the ONE app theme (the graph-only skins are gone).
import { hexToRgb01 } from "./graphData";

export interface GraphTheme {
  /** Light background → dark, saturated node palette (see graphData). */
  lightBg: boolean;
  bg: string;
  ink: string;
  ink3: string;
  /** --ink-4: the "recede" colour every question dims toward. */
  dim: string;
  live: string;
  warn: string;
  ok: string;
  /** Fallback dim node colour for nodes outside a sized community. */
  starDim: string;
  /** Edge colour for graphData's edge attrs (rgba); the canvas uses edgeRgb. */
  edge: string;
  /** "r,g,b" of the edge ink — alpha is per edge. */
  edgeRgb: string;
  /** Canvas vignette: centre and edge colours of the radial ground. */
  canvasCenter: string;
  canvasEdge: string;
  /** Glow multiplier — softer on paper. */
  glowK: number;
  font: string;
}

// Decide light/dark from the ACTUAL rendered --bg, not data-theme: the
// attribute can read stale in the window between mount and the app's theme
// effect, which would paint invisible (dark-on-dark) nodes.
function isDarkBackground(cs: CSSStyleDeclaration): boolean {
  const bg = cs.getPropertyValue("--bg").trim();
  const m = /^#([0-9a-f]{6})$/i.exec(bg) ?? /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(bg);
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

/** A CSS variable as #rrggbb, or the fallback when it is unset or not hex. */
function hexVar(cs: CSSStyleDeclaration, name: string, fallback: string): string {
  const v = cs.getPropertyValue(name).trim();
  return hexToRgb01(v) ? v : fallback;
}

export function readTheme(): GraphTheme {
  const cs = getComputedStyle(document.documentElement);
  const dark = isDarkBackground(cs);
  return {
    lightBg: !dark,
    bg: cs.getPropertyValue("--bg").trim() || (dark ? "#191919" : "#ffffff"),
    ink: hexVar(cs, "--ink", dark ? "#e8e6e1" : "#181715"),
    ink3: hexVar(cs, "--ink-3", dark ? "#9b9a93" : "#6f6e69"),
    dim: hexVar(cs, "--ink-4", dark ? "#8a8983" : "#6b6a64"),
    live: hexVar(cs, "--live", dark ? "#a78bfa" : "#7e22ce"),
    warn: hexVar(cs, "--warn", dark ? "#e0a458" : "#9a6a1f"),
    ok: hexVar(cs, "--ok", dark ? "#7ee0a6" : "#16a34a"),
    starDim: dark ? "#565b64" : "#9aa0a8",
    edge: dark ? "rgba(255,255,255,0.10)" : "rgba(24,23,21,0.10)",
    edgeRgb: dark ? "255,255,255" : "24,23,21",
    canvasCenter: dark ? "#1c1c22" : "#ffffff",
    canvasEdge: dark ? "#0b0b0e" : "#e9e7e2",
    glowK: dark ? 1 : 0.6,
    font: getComputedStyle(document.body).fontFamily || "system-ui, sans-serif",
  };
}
