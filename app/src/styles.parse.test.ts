// The TS gates never read styles.css, so a bad merge seam (an unclosed block)
// only surfaced in `vite build`. postcss ships with vite; parsing the sheet
// once here makes the gate fail where the merge happened.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

describe("styles.css", () => {
  it("parses as CSS", () => {
    const src = readFileSync(resolve(__dirname, "styles.css"), "utf8");
    expect(() => postcss.parse(src, { from: "styles.css" })).not.toThrow();
  });
});
