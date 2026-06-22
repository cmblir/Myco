// Graph theme colours (read from the live CSS variables / rendered background)
// and the sigma Settings derived from theme + the user's display sliders.
import type { Settings } from "sigma/settings";
import { drawDiscNodeLabel } from "sigma/rendering";
import type { GraphSettings } from "./graphSettings";
import NodeGlowProgram from "./graphNodeGlow";

export interface GraphTheme {
  bg: string;
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

// textFadeThreshold (0.1..3, default 1.1) → labelRenderedSizeThreshold. sigma
// shows a node's label only once its RENDERED size clears the threshold, and
// picks the largest node per grid cell — so hubs label first and the overview
// shows none. Higher slider → higher threshold → labels appear later.
export function buildSigmaSettings(
  theme: GraphTheme,
  s: GraphSettings,
): Partial<Settings> {
  const sansFont =
    getComputedStyle(document.documentElement)
      .getPropertyValue("--font-sans")
      .trim() || "Inter, system-ui, sans-serif";
  return {
    // edges — faint straight hairlines
    defaultEdgeColor: theme.edge,
    defaultEdgeType: s.arrows ? "arrow" : "line",
    minEdgeThickness: 0.25,
    enableEdgeEvents: false,
    // labels — Obsidian-style hub-first zoom reveal
    renderLabels: true,
    labelColor: { color: theme.ink },
    labelDensity: 0.5,
    labelGridCellSize: 140,
    labelRenderedSizeThreshold: Math.max(
      1,
      5 + (s.textFadeThreshold - 1.1) * 6,
    ),
    labelFont: sansFont,
    labelSize: 11,
    // Hover draws the label TEXT ONLY — reuse the plain label renderer instead
    // of sigma's default node-hover, which fills a white rounded box behind it.
    defaultDrawNodeHover: drawDiscNodeLabel,
    // nodes — glowing stars (small bright core + soft halo). The glow PROGRAM
    // itself is registered only at construction (see NODE_PROGRAM_SETTINGS);
    // re-sending it through setSettings on a live renderer blanks the graph.
    defaultNodeColor: theme.node,
    zIndex: true,
  };
}

// Program classes belong ONLY in the initial Sigma constructor. buildSigmaSettings
// is also re-applied via setSettings on every slider/theme change, and re-sending
// nodeProgramClasses there re-instantiates the WebGL program and renders every
// node blank — so these settings live apart and are spread in once, at build time.
export function nodeProgramSettings(): Partial<Settings> {
  return {
    defaultNodeType: "glow",
    nodeProgramClasses: { glow: NodeGlowProgram },
  };
}
