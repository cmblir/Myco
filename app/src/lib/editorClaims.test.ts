import { describe, expect, it } from "vitest";
import { claimCandidates } from "./editorClaims";

const spans = (doc: string): [number, number][] =>
  claimCandidates(doc).map((c) => [c.from, c.to]);

describe("claimCandidates", () => {
  it("flags a plain assertive paragraph and carries its text for the query", () => {
    const doc = "# Title\n\nSession chunks take 76% of the vector index today.\n";
    const [claim] = claimCandidates(doc);
    expect([claim.from, claim.to]).toEqual([3, 3]);
    expect(claim.text).toBe("Session chunks take 76% of the vector index today.");
  });

  it("treats anything the paragraph points at as cited", () => {
    // Wider than provenance.rs (which counts only `[^src-…]`): the dot asks
    // "did you point at anything", the rail's number asks "is it traceable".
    for (const cite of [
      "[^src-audit-0821]",
      "[[Citation coverage]]",
      "https://example.com/paper",
      '<cite n="1"/>',
    ]) {
      expect(spans(`Session chunks take 76% of the vector index ${cite}.\n`)).toEqual([]);
    }
  });

  it("skips structure, fences and frontmatter", () => {
    expect(spans("## A heading that is quite long indeed.\n")).toEqual([]);
    expect(spans("- A bullet long enough to pass the length gate.\n")).toEqual([]);
    expect(spans("1. A numbered item long enough to pass the gate.\n")).toEqual([]);
    expect(spans("> A quoted sentence long enough to pass the gate.\n")).toEqual([]);
    expect(spans("| a | b |\n| - | - |\n")).toEqual([]);
    expect(spans("[^src-a]: [[source-a]] and a sentence about it.\n")).toEqual([]);
    expect(spans("```\nassert(total == 76); // a long enough line.\n```\n")).toEqual([]);
    expect(spans("---\ntitle: A page about the index and its size.\n---\n")).toEqual([]);
  });

  it("prefers false negatives: fragments and unterminated lines are left alone", () => {
    expect(spans("TODO.\n")).toEqual([]); // too short
    expect(spans("a quite long line of prose with no terminator at all\n")).toEqual([]);
  });

  it("spans a whole multi-line paragraph, once", () => {
    const doc =
      "First line of the claim continues\nonto a second line and ends here.\n\n" +
      "A second, separate paragraph that also asserts something.\n";
    expect(spans(doc)).toEqual([
      [1, 2],
      [4, 4],
    ]);
  });

  it("keeps counting lines past a fence so later paragraphs are numbered right", () => {
    const doc = "```\ncode\n```\n\nA claim after the fence, long enough to count.\n";
    expect(spans(doc)).toEqual([[5, 5]]);
  });
});
