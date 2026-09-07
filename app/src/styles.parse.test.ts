// The TS gates never read styles.css, so a bad merge seam (an unclosed block)
// only surfaced in `vite build`. postcss ships with vite; parsing the sheet
// once here makes the gate fail where the merge happened.
//
// The other two tests are the design-vocabulary gate. Before them the sheet
// carried 10 different raw border-radius literals and 10 off-scale font-size
// literals, so every screen invented its own roundness and its own small
// text — the measured reason the app read as several apps stitched together.
// A cleanup without a gate re-scatters within a sprint, so the scale is
// enforced here rather than written down somewhere.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

// Every stylesheet the app ships, not just the big one: the shared UI layer
// (styles/ui.css) is exactly where a second vocabulary would take root, so it
// is held to the same scale. A new sheet must be added here or it escapes the
// gate — which is how the sheet under it drifted in the first place.
const SHEETS = ["styles.css", "styles/ui.css"] as const;
const sources = SHEETS.map((rel) => ({
  rel,
  css: readFileSync(resolve(__dirname, rel), "utf8"),
}));
const roots = () =>
  sources.map(({ rel, css }) => ({
    rel,
    root: postcss.parse(css, { from: rel }),
  }));

/** The radius scale: --r-sm 6 · --r-md 10 · --r-lg 16 · --r-pill 999. */
const RADIUS_SCALE = /^var\(--r-(?:sm|md|lg|pill)\)$/;
/**
 * Radii that conform to hardware, not to the scale: the tray popover matches
 * the radius window-vibrancy rounds the native NSVisualEffectView to
 * (tray.rs), and the notch panel's radius grows with its width so the card
 * reads as pushed out of the Mac's cutout. Both are measured against
 * something physical — a scale step would visibly mismatch it. Anything new
 * here needs the same kind of justification, not just a taste preference.
 */
const RADIUS_GEOMETRY = /^var\(--r-(?:tray|notch|notch-open|notch-wide)\)$/;
/** `0` for a square corner, `50%` for a circle, `inherit` to follow a parent. */
const RADIUS_KEYWORDS = new Set(["0", "50%", "inherit"]);

/** The type scale, in px. Tokens --fs-11 … --fs-42 carry the same numbers. */
const TYPE_SCALE = new Set([11, 12.5, 14, 17, 22, 30, 42]);

const location = (decl: postcss.Declaration) => {
  const selector =
    "selector" in decl.parent!
      ? (decl.parent as postcss.Rule).selector
      : `@${(decl.parent as postcss.AtRule).name}`;
  return `${decl.source?.start?.line}: ${selector.replace(/\s+/g, " ")} { ${decl.prop}: ${decl.value} }`;
};

describe("the app's stylesheets", () => {
  it("parse as CSS", () => {
    expect(() => roots()).not.toThrow();
  });

  it("take every border-radius from the scale", () => {
    const offScale: string[] = [];
    for (const { rel, root } of roots())
      root.walkDecls(/^border-(?:.+-)?radius$/, (decl) => {
      // var() never contains a space, so the corner list splits on whitespace;
      // a `var(--r-md, 8px)` fallback splits into halves and fails, which is
      // the point — a literal in a fallback is still a literal.
        const corners = decl.value.trim().split(/\s+/);
        const onScale = corners.every(
          (corner) =>
            RADIUS_KEYWORDS.has(corner) ||
            RADIUS_SCALE.test(corner) ||
            RADIUS_GEOMETRY.test(corner),
        );
        if (!onScale) offScale.push(`${rel} ${location(decl)}`);
      });
    expect(offScale, `${offScale.length} off-scale radii`).toEqual([]);
  });

  it("take every font-size from the type scale", () => {
    const offScale: string[] = [];
    // The `font` shorthand sets a size too, so it cannot be a way around the
    // scale. Its grammar puts the size first of the two possible lengths
    // (`<size>[/<line-height>]`), so the first px number is the size and a px
    // line-height after it is none of this test's business.
    for (const { rel, root } of roots())
      root.walkDecls(/^font(-size)?$/, (decl) => {
        const px = [...decl.value.matchAll(/(-?[\d.]+)px/g)].map((m) =>
          Number(m[1]),
        );
        // No px at all: a token, `inherit`, or a relative unit (rem/em/%).
        const sizes = decl.prop === "font" ? px.slice(0, 1) : px;
        if (!sizes.every((size) => TYPE_SCALE.has(size)))
          offScale.push(`${rel} ${location(decl)}`);
      });
    expect(offScale, `${offScale.length} off-scale font sizes`).toEqual([]);
  });
});
