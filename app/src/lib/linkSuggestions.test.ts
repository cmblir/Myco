import { describe, expect, it } from "vitest";
import type { Adjacency } from "./ipc";
import { appendWikilink, pairKey, suggestLinks } from "./linkSuggestions";

const A = "/v/alpha.md";
const B = "/v/beta.md";
const C = "/v/gamma.md";

const adj: Adjacency = {
  forward: { [A]: [B] },
  backward: { [B]: [A] },
  unresolved: {},
  tags: {},
};

describe("suggestLinks", () => {
  it("keeps only unlinked, non-dismissed pairs, ranked by score", () => {
    const out = suggestLinks(
      adj,
      [
        { source: A, target: B, score: 0.95 }, // already linked → dropped
        { source: A, target: C, score: 0.7 },
        { source: C, target: A, score: 0.6 }, // duplicate pair → deduped
        { source: B, target: C, score: 0.8 },
      ],
      new Set(),
    );
    expect(out.map((s) => s.key)).toEqual([pairKey(B, C), pairKey(A, C)]);
    expect(out[0].score).toBeCloseTo(0.8);
  });

  it("honors dismissals and the max cap", () => {
    const dismissed = new Set([pairKey(B, C)]);
    const out = suggestLinks(
      adj,
      [
        { source: B, target: C, score: 0.9 },
        { source: A, target: C, score: 0.7 },
      ],
      dismissed,
      1,
    );
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe(pairKey(A, C));
  });
});

describe("appendWikilink", () => {
  it("creates a Related section when absent", () => {
    const out = appendWikilink("# Alpha\n\nBody.\n", "/v/beta.md");
    expect(out).toContain("## Related");
    expect(out).toContain("- [[beta]]");
  });

  it("appends under an existing Related section", () => {
    const src = "# Alpha\n\n## Related\n\n- [[gamma]]\n";
    const out = appendWikilink(src, "/v/beta.md");
    expect(out.indexOf("- [[beta]]")).toBeGreaterThan(out.indexOf("## Related"));
    expect(out).toContain("- [[gamma]]");
    // only one Related section
    expect(out.match(/## Related/g)).toHaveLength(1);
  });

  it("is a no-op when the link already exists", () => {
    const src = "# Alpha\n\nSee [[beta]].\n";
    expect(appendWikilink(src, "/v/beta.md")).toBe(src);
  });
});
