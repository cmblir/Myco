import { describe, expect, it } from "vitest";
import { hitPassesFilters, parseSearchQuery } from "./searchQuery";

describe("parseSearchQuery", () => {
  it("extracts quoted phrases, path:, tag:, and leftover terms", () => {
    const p = parseSearchQuery('"connection reset" path:sessions/ tag:rust deadlock');
    expect(p.phrases).toEqual(["connection reset"]);
    expect(p.path).toBe("sessions/");
    expect(p.tags).toEqual(["rust"]);
    expect(p.terms).toBe("deadlock");
  });
  it("passes a plain query through untouched", () => {
    const p = parseSearchQuery("plain query");
    expect(p).toEqual({ phrases: [], path: null, tags: [], terms: "plain query" });
  });
  it("treats an unclosed quote as plain text", () => {
    const p = parseSearchQuery('start "unclosed');
    expect(p.phrases).toEqual([]);
    expect(p.terms).toBe("start unclosed");
  });
});

describe("hitPassesFilters", () => {
  const tags = { "/v/wiki/rust-notes.md": ["rust", "async"] };
  it("filters by path prefix relative to the vault", () => {
    const p = parseSearchQuery("x path:wiki/");
    expect(hitPassesFilters("/v/wiki/rust-notes.md", "/v", p, tags)).toBe(true);
    expect(hitPassesFilters("/v/sessions/a.md", "/v", p, tags)).toBe(false);
  });
  it("filters by tag", () => {
    const p = parseSearchQuery("x tag:rust");
    expect(hitPassesFilters("/v/wiki/rust-notes.md", "/v", p, tags)).toBe(true);
    expect(hitPassesFilters("/v/wiki/other.md", "/v", p, tags)).toBe(false);
  });
});
