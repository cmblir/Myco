import { describe, expect, it } from "vitest";
import { formatExtractiveAnswer } from "./extractive";
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

  it("returns empty string for no hits / text-less hits", () => {
    expect(formatExtractiveAnswer([])).toBe("");
    expect(formatExtractiveAnswer([chunk({ text: "" })])).toBe("");
  });
});
