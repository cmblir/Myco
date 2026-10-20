// An icon drawn past its 0..24 viewBox is clipped by the <svg> box: the gear
// once ran to x = -1, so the sidebar's settings button showed it with its left
// teeth cut off (owner screenshot, 2026-10-04). The source is parsed here
// rather than rendered, because the paths are plain literals.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(__dirname, "icons.tsx"), "utf8");
// Only the 24-unit <Icon> set; the logo and provider glyphs live below it.
const iconBlock = source.slice(
  source.indexOf("const paths"),
  source.indexOf("export function MycoMark"),
);

const ARGS: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

/** Every vertex a path's commands land on, in absolute coordinates. */
function vertices(d: string): [number, number][] {
  const tokens = d.match(/[A-Za-z]|-?(?:\d*\.\d+|\d+)/g) ?? [];
  const out: [number, number][] = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let cmd = "";
  let i = 0;
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++];
    const lower = cmd.toLowerCase();
    if (lower === "z") {
      [x, y] = [startX, startY];
      continue;
    }
    const args = tokens.slice(i, i + ARGS[lower]).map(Number);
    i += ARGS[lower];
    const rel = cmd === lower;
    // ponytail: endpoints only — an arc's bulge or a curve's overshoot past
    // its vertices is not measured; add a curve bound if an icon needs it.
    if (lower === "h") x = rel ? x + args[0] : args[0];
    else if (lower === "v") y = rel ? y + args[0] : args[0];
    else {
      const [ex, ey] = args.slice(-2);
      [x, y] = rel ? [x + ex, y + ey] : [ex, ey];
    }
    if (lower === "m") {
      [startX, startY] = [x, y];
      cmd = rel ? "l" : "L"; // extra pairs after a move are lines
    }
    out.push([x, y]);
  }
  return out;
}

describe("the 24-unit icon set", () => {
  it("parses a path's vertices, relative and absolute", () => {
    expect(vertices("M1 2h3v-1L0 0z")).toEqual([
      [1, 2],
      [4, 2],
      [4, 1],
      [0, 0],
    ]);
  });

  it("keeps every path vertex inside the 0..24 viewBox", () => {
    const outside: string[] = [];
    for (const [, d] of iconBlock.matchAll(/\bd="([^"]+)"/g))
      for (const [px, py] of vertices(d))
        if (px < 0 || px > 24 || py < 0 || py > 24) outside.push(`(${px}, ${py}) in ${d}`);
    expect(outside).toEqual([]);
  });
});
