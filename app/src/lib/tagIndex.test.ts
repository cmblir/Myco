import { describe, expect, it } from "vitest";
import { tagCandidates } from "./tagIndex";

const tags = {
  "/v/a.md": ["ml", "Rust", "ml"],
  "/v/b.md": ["rust", "ml", "yaml"],
  "/v/c.md": ["Rust", "graph"],
};

describe("tagCandidates", () => {
  it("dedupes across pages, frequency desc then alpha", () => {
    expect(tagCandidates(tags)).toEqual([
      "ml",
      "Rust",
      "graph",
      "rust",
      "yaml",
    ]);
  });

  it("filters by case-insensitive substring", () => {
    expect(tagCandidates(tags, "RU")).toEqual(["Rust", "rust"]);
    expect(tagCandidates(tags, "zz")).toEqual([]);
  });

  it("honours the limit", () => {
    expect(tagCandidates(tags, "", 2)).toEqual(["ml", "Rust"]);
    expect(tagCandidates(tags, "", Infinity)).toHaveLength(5);
  });

  it("is empty for an empty index", () => {
    expect(tagCandidates({})).toEqual([]);
  });
});
