import { describe, expect, it } from "vitest";
import { escapeHtml, matchWikilinkAt } from "./wikilinks";

describe("matchWikilinkAt", () => {
  it("matches a bare target anchored at pos", () => {
    expect(matchWikilinkAt("[[transformer]]", 0)).toEqual({
      target: "transformer",
      display: "transformer",
      end: 15,
    });
  });

  it("matches at a non-zero offset and reports the end past ]]", () => {
    const src = "see [[a]] here";
    expect(matchWikilinkAt(src, 4)).toEqual({
      target: "a",
      display: "a",
      end: 9,
    });
  });

  it("uses the first | for target, keeps later text in display, and trims", () => {
    // Documented case: `[[x|y|z]]` -> target x, display `y|z` (whitespace trimmed).
    expect(matchWikilinkAt("[[ x | y|z ]]", 0)).toEqual({
      target: "x",
      display: "y|z",
      end: 13,
    });
  });

  it("rejects a stray ] in the inner, agreeing with the Rust parser", () => {
    // The markdown scanner used to accept this via indexOf("]]"); it must not.
    expect(matchWikilinkAt("[[a]b]]", 0)).toBeNull();
  });

  it("returns null for an unclosed [[", () => {
    expect(matchWikilinkAt("[[unclosed", 0)).toBeNull();
  });

  it("returns null when no link starts at pos", () => {
    expect(matchWikilinkAt("see [[a]]", 0)).toBeNull();
  });

  it("returns null for an empty or whitespace-only target", () => {
    expect(matchWikilinkAt("[[]]", 0)).toBeNull();
    expect(matchWikilinkAt("[[   ]]", 0)).toBeNull();
  });

  it("returns null for a newline inside the inner", () => {
    expect(matchWikilinkAt("[[a\nb]]", 0)).toBeNull();
  });
});

describe("escapeHtml", () => {
  it("escapes all five entities", () => {
    expect(escapeHtml(`<a href="x" data-y='z'>&`)).toBe(
      "&lt;a href=&quot;x&quot; data-y=&#39;z&#39;&gt;&amp;",
    );
  });
});
