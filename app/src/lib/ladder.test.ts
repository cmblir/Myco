import { describe, expect, it } from "vitest";
import { DEFAULT_TIER_WEIGHTS, hitTier, tierColor } from "./extractive";
import { ladderOf, traceOf } from "./ladder";
import type { ScoredChunk, TierWeights } from "./ipc";

const chunk = (over: Partial<ScoredChunk> = {}): ScoredChunk => ({
  page: "wiki/bpe.md",
  stem: "bpe",
  section: 0,
  text: "BPE merges frequent pairs.",
  score: 0.9,
  similarity: 0.68,
  ...over,
});

const ALL_ONE: TierWeights = {
  note: 1,
  map: 1,
  digest: 1,
  rollup: 1,
  session: 1,
  source: 1,
};

describe("tierColor / hitTier", () => {
  it("maps every tier to a fixed category token", () => {
    expect(tierColor("note")).toBe("var(--c-concept)");
    expect(tierColor("map")).toBe("var(--c-overview)");
    expect(tierColor("digest")).toBe("var(--c-analysis)");
    expect(tierColor("rollup")).toBe("var(--c-analysis)");
    expect(tierColor("monthly")).toBe("var(--c-analysis)");
    expect(tierColor("session")).toBe("var(--ink-4)");
    expect(tierColor("source")).toBe("var(--c-source)");
  });

  it("folds monthly into the backend's rollup tier", () => {
    expect(hitTier("monthly")).toBe("rollup");
    expect(hitTier("note")).toBe("note");
  });
});

describe("ladderOf", () => {
  const hits = [
    // Backend order with the default priors applied: the session log's RRF
    // (0.92) beats the note's (0.9), but 0.92 × 0.6 < 0.9 × 1.0.
    chunk({ page: "wiki/bpe.md", stem: "bpe", score: 0.9 }),
    chunk({ page: "sessions/2026-08/s1.md", stem: "s1", score: 0.92, similarity: 0.7 }),
    chunk({ page: "daily/2026-08-19.md", stem: "2026-08-19", score: 0.8, similarity: 0.58 }),
  ];

  it("orders by rrf × prior and reports the move against the pure-RRF order", () => {
    const rows = ladderOf(hits, DEFAULT_TIER_WEIGHTS);
    expect(rows.map((r) => r.stem)).toEqual(["bpe", "2026-08-19", "s1"]);
    expect(rows.map((r) => r.rankChange)).toEqual([1, 1, -2]);
    expect(rows[0]).toMatchObject({ tier: "note", prior: 1, rrf: 0.9, final: 0.9 });
    expect(rows[2]).toMatchObject({ tier: "session", prior: 0.6 });
    expect(rows[2].final).toBeCloseTo(0.552);
  });

  it("with every weight at 1.00 the order is pure RRF and nothing moves", () => {
    const rows = ladderOf(hits, ALL_ONE);
    expect(rows.map((r) => r.stem)).toEqual(["s1", "bpe", "2026-08-19"]);
    expect(rows.every((r) => r.rankChange === 0)).toBe(true);
  });

  it("uses score_rrf as the base when the backend splits the scores", () => {
    const rows = ladderOf(
      [chunk({ score: 0.5, score_rrf: 0.9, score_final: 0.5, prior: 0.55 })],
      ALL_ONE,
    );
    expect(rows[0].rrf).toBe(0.9);
    expect(rows[0].final).toBe(0.9);
  });

  it("groups chunks by page, keeping the best cosine and the quoted body", () => {
    const rows = ladderOf(
      [
        chunk({ text: "first", similarity: 0.6 }),
        chunk({ section: 1, text: "second", similarity: 0.71, score: 0.7 }),
      ],
      ALL_ONE,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].similarity).toBe(0.71);
    expect(rows[0].quote).toBe("first\n\nsecond");
  });

  it("flags archived pages and skips text-less hits", () => {
    const rows = ladderOf(
      [
        chunk({ page: "sessions/archive/2026-07/old.md", stem: "old" }),
        chunk({ page: "wiki/empty.md", stem: "empty", text: "" }),
      ],
      ALL_ONE,
    );
    expect(rows.map((r) => r.stem)).toEqual(["old"]);
    expect(rows[0].archived).toBe(true);
  });
});

describe("traceOf", () => {
  it("counts arms, fusion size and rejects from one response", () => {
    const trace = traceOf(
      {
        hits: [chunk({}), chunk({ page: "wiki/x.md", stem: "x", similarity: null })],
        nearMisses: [
          { page: "wiki/y.md", tier: "note", score_final: 0.3, similarity: 0.4 },
          { page: "wiki/z.md", tier: "note", score_final: 0.2 },
        ],
        floor: 0.42,
      },
      51,
      12,
    );
    expect(trace).toEqual({
      indexedPages: 51,
      lexicalOnly: 1,
      dense: 2,
      fused: 4,
      cap: 12,
      rejected: 2,
      floor: 0.42,
    });
  });
});
