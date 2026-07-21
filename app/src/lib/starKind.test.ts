import { describe, it, expect } from "vitest";
import { starKindOf } from "./graphData";

describe("starKindOf", () => {
  it("maps frontmatter types to consistent glyphs", () => {
    // Same type -> same shape, regardless of the per-id seed.
    expect(starKindOf("wiki/a.md", 3, 0.2, "source-summary")).toBe(3); // beacon
    expect(starKindOf("wiki/b.md", 1, 0.1, "source-summary")).toBe(3);
    expect(starKindOf("wiki/c.md", 2, 0.2, "entity")).toBe(2); // giant
    expect(starKindOf("wiki/d.md", 2, 0.2, "technique")).toBe(1); // dwarf
    expect(starKindOf("wiki/e.md", 2, 0.2, "concept")).toBe(0); // main
    expect(starKindOf("wiki/f.md", 2, 0.2, "analysis")).toBe(0);
  });

  it("keeps top hubs blazing main-sequence even when typed", () => {
    expect(starKindOf("wiki/hub.md", 40, 0.9, "source-summary")).toBe(0);
  });

  it("falls back to the seeded population for untyped notes", () => {
    const k = starKindOf("wiki/untyped.md", 2, 0.2);
    expect(k).toBeGreaterThanOrEqual(0);
    expect(k).toBeLessThanOrEqual(3);
    // Deterministic per id.
    expect(starKindOf("wiki/untyped.md", 2, 0.2)).toBe(k);
  });
});
