// The skip link (UX S28) was parked above the viewport with a transform, and
// macOS elastic overscroll pulls that strip into view: dragging Settings past
// its top showed "본문으로 건너뛰기" (owner screenshot, 2026-10-04). Clipped to
// a 1px box it has nothing to expose wherever the page bounces.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

const root = postcss.parse(readFileSync(resolve(__dirname, "styles.css"), "utf8"));

function declsOf(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  root.walkRules((rule) => {
    if (rule.selector.trim() !== selector) return;
    rule.walkDecls((decl) => {
      out[decl.prop] = decl.value;
    });
  });
  return out;
}

describe("the skip link", () => {
  it("is clipped to nothing until focused, not moved off screen", () => {
    const rest = declsOf(".skip-link");
    expect(rest).toMatchObject({
      width: "1px",
      height: "1px",
      overflow: "hidden",
      "clip-path": "inset(50%)",
    });
    expect(rest).not.toHaveProperty("transform");
  });

  it("shows only on keyboard focus", () => {
    expect(declsOf(".skip-link:focus-visible")).toMatchObject({
      width: "auto",
      height: "auto",
      "clip-path": "none",
    });
    // A plain :focus rule would also reveal it on a pointer press.
    expect(declsOf(".skip-link:focus")).toEqual({});
  });
});
