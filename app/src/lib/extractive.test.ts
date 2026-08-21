import { describe, expect, it } from "vitest";
import {
  citationsOf,
  confidenceBand,
  formatExtractiveAnswer,
  sourceTier,
} from "./extractive";
import { isNonKnowledgePath } from "./graphData";
import type { ScoredChunk } from "./ipc";

const chunk = (over: Partial<ScoredChunk> = {}): ScoredChunk => ({
  page: "wiki/bpe.md",
  stem: "bpe",
  section: 0,
  text: "BPE merges frequent pairs.",
  score: 0.9,
  similarity: 0.68,
  ...over,
});

describe("formatExtractiveAnswer", () => {
  it("renders one [[stem]] header per page with block-quoted text", () => {
    const md = formatExtractiveAnswer([chunk({})]);
    expect(md).toContain("**[[bpe]]**");
    expect(md).toContain("> BPE merges frequent pairs.");
  });

  it("groups later chunks of the same page under one header, rank order kept", () => {
    const md = formatExtractiveAnswer([
      chunk({ text: "First passage." }),
      chunk({ page: "wiki/lora.md", stem: "lora", text: "LoRA adapts." }),
      chunk({ section: 2, text: "Second passage, same page." }),
    ]);
    // one header per page
    expect(md.match(/\*\*\[\[bpe\]\]\*\*/g)).toHaveLength(1);
    // bpe (rank 1) renders before lora (rank 2)
    expect(md.indexOf("[[bpe]]")).toBeLessThan(md.indexOf("[[lora]]"));
    expect(md).toContain("> Second passage, same page.");
  });

  it("block-quotes every line of a multi-line passage", () => {
    const md = formatExtractiveAnswer([chunk({ text: "line one\nline two" })]);
    expect(md).toContain("> line one\n> line two");
  });

  it("caps pages at maxPages", () => {
    const hits = ["a", "b", "c"].map((s) =>
      chunk({ page: `wiki/${s}.md`, stem: s, text: `about ${s}` }),
    );
    const md = formatExtractiveAnswer(hits, { maxPages: 2 });
    expect(md).toContain("[[a]]");
    expect(md).toContain("[[b]]");
    expect(md).not.toContain("[[c]]");
  });

  it("truncates a page's quoted text at perPageChars with an ellipsis", () => {
    const md = formatExtractiveAnswer([chunk({ text: "x".repeat(500) })], {
      perPageChars: 100,
    });
    expect(md).toContain("…");
    expect(md.length).toBeLessThan(300);
  });

  it("labels each page with its best chunk's real relevance", () => {
    // The percentage is the dense cosine, so it is comparable across pages —
    // unlike the rank-fusion `score`, which would look like confidence and
    // behave like noise.
    const md = formatExtractiveAnswer([
      chunk({ similarity: 0.611, text: "first" }),
      chunk({ section: 2, similarity: 0.688, text: "second, same page" }),
      chunk({ page: "wiki/lora.md", stem: "lora", similarity: 0.52, text: "LoRA" }),
    ]);
    expect(md).toContain("**[[bpe]]** · 69%"); // best of 0.611 / 0.688, not the first
    expect(md).toContain("**[[lora]]** · 52%");
  });

  it("omits the percentage for a lexical-only hit rather than inventing one", () => {
    const md = formatExtractiveAnswer([chunk({ similarity: null })]);
    expect(md).toContain("**[[bpe]]**");
    expect(md).not.toContain("%");
  });

  it("never truncates inside a fenced code block", () => {
    // A mid-fence cut leaves an unterminated ``` that swallows the rest of the
    // answer into one code block when the markdown renders.
    const body = ["prose line", "```ts", "const a = 1;", "const b = 2;", "```", "tail"].join("\n");
    const md = formatExtractiveAnswer([chunk({ text: body })], { perPageChars: 30 });
    const fences = (md.match(/```/g) ?? []).length;
    expect(fences % 2).toBe(0);
  });

  it("cuts on a line boundary rather than mid-word", () => {
    const md = formatExtractiveAnswer(
      [chunk({ text: "first line here\nsecond line here\nthird" })],
      { perPageChars: 25 },
    );
    expect(md).toContain("> first line here");
    expect(md).not.toContain("second line h…");
  });

  it("returns empty string for no hits / text-less hits", () => {
    expect(formatExtractiveAnswer([])).toBe("");
    expect(formatExtractiveAnswer([chunk({ text: "" })])).toBe("");
  });
});

describe("confidenceBand", () => {
  it("bands a cosine at the measured boundaries (0.65 / 0.55 / floor)", () => {
    expect(confidenceBand(0.72)).toBe("high");
    expect(confidenceBand(0.65)).toBe("high");
    expect(confidenceBand(0.6499)).toBe("medium");
    expect(confidenceBand(0.55)).toBe("medium");
    expect(confidenceBand(0.5499)).toBe("low");
    expect(confidenceBand(0.5)).toBe("low");
  });

  it("says 'lexical' rather than inventing a band when there is no cosine", () => {
    // A lexical-only hit carries similarity: null (chat.ts keeps it — exact
    // term overlap is its own evidence) and must not be shown a fake band.
    expect(confidenceBand(null)).toBe("lexical");
  });
});

describe("sourceTier", () => {
  it("names the vault layer a citation came from", () => {
    expect(sourceTier("wiki/bpe.md")).toBe("note");
    expect(sourceTier("daily/2026-08-19.md")).toBe("digest");
    expect(sourceTier("weekly/2026-W33.md")).toBe("rollup");
    expect(sourceTier("sessions/2026-08/codex-abc.md")).toBe("session");
    expect(sourceTier("raw/paper.md")).toBe("source");
    expect(sourceTier("_inbox/drop.md")).toBe("source");
    // A bare top-level page is still the user's own writing.
    expect(sourceTier("scratch.md")).toBe("note");
  });

  it("does not credit a machine-drafted map to the user", () => {
    // maps.ts writes these with the query model (`status: draft`), so
    // quoting one back as "your note" is a lie about authorship.
    expect(sourceTier("wiki/maps/nlp.md")).toBe("map");
    // Only the maps folder — a page merely NAMED maps.md is hand-written.
    expect(sourceTier("wiki/maps.md")).toBe("note");
  });

  it("still lets the graph treat that same map as a knowledge page", () => {
    // The two classifiers answer different questions and are meant to
    // disagree here: the map belongs in the graph, but it is not the
    // user's writing. Locked down so a later "unify them" refactor fails.
    expect(isNonKnowledgePath("/v", "/v/wiki/maps/nlp.md")).toBe(false);
    expect(sourceTier("wiki/maps/nlp.md")).not.toBe("note");
  });
});

describe("citationsOf", () => {
  it("carries each page's BEST cosine, capped like the rendered answer", () => {
    const cites = citationsOf([
      chunk({ page: "wiki/a.md", stem: "a", similarity: 0.52 }),
      chunk({ page: "wiki/a.md", stem: "a", similarity: 0.71 }),
      chunk({ page: "daily/2026-08-19.md", stem: "2026-08-19", similarity: null }),
    ]);
    expect(cites).toEqual([
      { page: "wiki/a.md", stem: "a", similarity: 0.71 },
      { page: "daily/2026-08-19.md", stem: "2026-08-19", similarity: null },
    ]);
  });

  it("describes only the pages the answer actually quotes", () => {
    const hits = Array.from({ length: 7 }, (_, i) =>
      chunk({ page: `wiki/p${i}.md`, stem: `p${i}` }),
    );
    expect(citationsOf(hits)).toHaveLength(5);
    expect(citationsOf([chunk({ text: "" })])).toEqual([]);
  });
});
