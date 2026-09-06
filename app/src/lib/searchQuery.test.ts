import { describe, expect, it } from "vitest";
import { hasOperators, hitPassesFilters, parseSearchQuery } from "./searchQuery";

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
    expect(p).toEqual({ phrases: [], path: null, tags: [], meta: [], terms: "plain query" });
    expect(hasOperators(p)).toBe(false);
  });
  it("reads the frontmatter facets as operators", () => {
    const p = parseSearchQuery("type:Concept confidence:low");
    expect(p.meta).toEqual([
      ["type", "concept"],
      ["confidence", "low"],
    ]);
    expect(p.terms).toBe("");
    expect(hasOperators(p)).toBe(true);
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
  it("filters by frontmatter facets, every operator must hold", () => {
    const meta = {
      "/v/wiki/rust-notes.md": { type: "concept", status: "disputed" },
      "/v/wiki/other.md": { type: "concept" },
    };
    const p = parseSearchQuery("type:concept status:disputed");
    expect(hitPassesFilters("/v/wiki/rust-notes.md", "/v", p, tags, meta)).toBe(true);
    expect(hitPassesFilters("/v/wiki/other.md", "/v", p, tags, meta)).toBe(false);
    // No meta at all (older backend, plain note) fails closed on a facet query.
    expect(hitPassesFilters("/v/sessions/a.md", "/v", p, tags, meta)).toBe(false);
  });
});
