import { describe, expect, it } from "vitest";
import { formatExtractiveAnswer } from "./extractive";
import type { ScoredChunk } from "./ipc";

const chunk = (over: Partial<ScoredChunk>): ScoredChunk => ({
  page: "wiki/bpe.md",
  stem: "bpe",
  section: 0,
  text: "BPE merges frequent pairs.",
  score: 0.9,
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

  it("returns empty string for no hits / text-less hits", () => {
    expect(formatExtractiveAnswer([])).toBe("");
    expect(formatExtractiveAnswer([chunk({ text: "" })])).toBe("");
  });
});
