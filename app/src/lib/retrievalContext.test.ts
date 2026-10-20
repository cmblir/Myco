import { describe, expect, it } from "vitest";
import { buildRetrievalContext } from "./retrievalContext";
import type { ScoredChunk } from "./ipc";

const hit = (page: string, text: string, section = 0): ScoredChunk => ({
  page,
  stem: page.split("/").pop()!.replace(/\.md$/, ""),
  section,
  text,
  score: 0.02,
  similarity: 0.6,
});

describe("buildRetrievalContext", () => {
  it("preserves ranked evidence before a lower-ranked map", () => {
    const { ctx, stems } = buildRetrievalContext(
      [
        hit("sessions/decision.md", "Chosen setting."),
        hit("wiki/maps/overview.md", "Overview."),
      ],
      1_000,
    );
    expect(ctx.indexOf("Chosen setting.")).toBeLessThan(
      ctx.indexOf("Overview."),
    );
    expect(stems).toEqual(["decision", "overview"]);
    expect(ctx).toContain("[[sessions/decision|decision]]");
    expect(ctx).toContain("section: 0");
  });

  it("bounds the first oversized chunk and still covers another source", () => {
    const { ctx, stems } = buildRetrievalContext(
      [
        hit("wiki/large.md", "Long passage. ".repeat(3_000)),
        hit("sessions/answer.md", "The later source has the decisive fact."),
      ],
      800,
    );
    expect(ctx.length).toBeLessThanOrEqual(800);
    expect(ctx).toContain("The later source has the decisive fact.");
    expect(stems).toEqual(["large", "answer"]);
  });

  it("uses distinct path citations for duplicate stems", () => {
    const { ctx } = buildRetrievalContext(
      [
        hit("wiki/first/status.md", "First."),
        hit("wiki/second/status.md", "Second."),
      ],
      1_000,
    );
    expect(ctx).toContain("[[wiki/first/status|status]]");
    expect(ctx).toContain("[[wiki/second/status|status]]");
  });

  it("does not invent context or exceed tiny budgets", () => {
    expect(buildRetrievalContext([], 200)).toEqual({ ctx: "", stems: [] });
    expect(buildRetrievalContext([hit("wiki/a.md", "Body")], 0)).toEqual({
      ctx: "",
      stems: [],
    });
    expect(
      buildRetrievalContext([hit("wiki/a.md", "Body")], 5).ctx.length,
    ).toBeLessThanOrEqual(5);
  });
});
