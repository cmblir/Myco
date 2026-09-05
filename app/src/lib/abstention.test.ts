import { describe, expect, it } from "vitest";
import { nearMissesOf, shouldAbstain } from "./abstention";
import type { NearMiss, ScoredChunk } from "./ipc";

const chunk = (over: Partial<ScoredChunk> = {}): ScoredChunk => ({
  page: "wiki/bpe.md",
  stem: "bpe",
  section: 0,
  text: "BPE merges frequent pairs.",
  score: 0.9,
  similarity: 0.68,
  ...over,
});

describe("shouldAbstain", () => {
  it("answers when any hit clears the floor (inclusive)", () => {
    expect(shouldAbstain([chunk({ similarity: 0.42 })], 0.42)).toBe(false);
  });

  it("abstains on an empty result", () => {
    expect(shouldAbstain([], 0.42)).toBe(true);
  });

  it("abstains when every cosine is under the floor", () => {
    expect(shouldAbstain([chunk({ similarity: 0.41 })], 0.42)).toBe(true);
  });

  it("does not let a keyword-only hit stand in for evidence on its own", () => {
    expect(shouldAbstain([chunk({ similarity: null })], 0.42)).toBe(true);
    // …but it rides along once a dense hit is there.
    expect(shouldAbstain([chunk({ similarity: null }), chunk({ similarity: 0.6 })], 0.42)).toBe(
      false,
    );
  });
});

describe("nearMissesOf", () => {
  const rejected: NearMiss[] = [
    { page: "wiki/a.md", tier: "note", score_final: 0.5, similarity: 0.3 },
    { page: "sessions/s.md", tier: "session", score_final: 0.4 },
    { page: "wiki/b.md", tier: "note", score_final: 0.6, similarity: 0.4 },
  ];

  it("orders by cosine, then unknown, then keyword-only", () => {
    const misses = nearMissesOf(
      [chunk({ page: "weekly/w.md", stem: "w", similarity: null, score: 0.7 })],
      rejected,
    );
    expect(misses.map((m) => m.page)).toEqual([
      "wiki/b.md",
      "wiki/a.md",
      "sessions/s.md",
      "weekly/w.md",
    ]);
    expect(misses[3]).toEqual({
      page: "weekly/w.md",
      tier: "rollup",
      score_final: 0.7,
      similarity: null,
    });
  });

  it("dedupes by page and caps at four", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      page: `wiki/${i}.md`,
      tier: "note" as const,
      score_final: 0.1,
      similarity: 0.1 * i,
    }));
    const misses = nearMissesOf([], [...many, many[5]]);
    expect(misses).toHaveLength(4);
    expect(misses[0].page).toBe("wiki/5.md");
  });

  it("ignores dense hits (they are not misses)", () => {
    expect(nearMissesOf([chunk({ similarity: 0.7 })], [])).toEqual([]);
  });
});
