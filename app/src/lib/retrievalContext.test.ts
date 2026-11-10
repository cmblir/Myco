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

describe("related transcript context", () => {
  const anchor = hit("raw/conversations/old.md", "Planned work.", 2);
  const passage = {
    page: "raw/conversations/new.md", stem: "new", section: 7,
    text: "Work completed; verification remains.", source_revision: "sha256:fixture",
    role: "assistant", timestamp: 1790899200, message_id: "message-7",
    relation: "later_revision_tail", anchor_page: anchor.page, anchor_section: 2,
  };
  it("includes actual source identity and complete qualifiers for accepted anchors", () => {
    const {ctx} = buildRetrievalContext([anchor], 5000, {passages:[passage], incomplete:true, scanned_pages:2});
    expect(ctx).toContain(passage.text);
    expect(ctx).toContain("speaker: assistant");
    expect(ctx).toContain("source_revision: sha256:fixture");
    const shown = /message_time: (\S+)/.exec(ctx)?.[1] ?? "";
    expect(Date.parse(shown)).toBe(Date.parse("2026-10-02T00:00:00.000Z"));
    expect(shown).toMatch(/[+-]\d{2}:\d{2}$/);
    expect(ctx).toContain("partial");
  });
  it("excludes unanchored context and never cuts an oversized qualifier", () => {
    const {ctx} = buildRetrievalContext([anchor], 1000, {passages:[
      {...passage, anchor_section:99, text:"UNRELATED"},
      {...passage, text:"OVERSIZED " + "body ".repeat(3000) + " NOT COMPLETED"},
    ], incomplete:false, scanned_pages:2});
    expect(ctx).not.toContain("UNRELATED");
    expect(ctx).not.toContain("OVERSIZED");
    expect(ctx.length).toBeLessThanOrEqual(1000);
  });
});


describe("chronological context presentation", () => {
  const anchor = hit("raw/conversations/thread.md", "Request.", 1);
  const passage = (section: number, timestamp: number, text: string) => ({
    ...anchor, section, timestamp, text, source_revision: "revision",
    role: "assistant", message_id: `message-${section}`, relation: "recent_exchange",
    anchor_page: anchor.page, anchor_section: anchor.section,
  });
  it("presents a later correction after an earlier completion without changing either text", () => {
    const earlier = passage(2, 100, "Reported complete.");
    const correction = passage(3, 200, "Correction: not verified; reopen the task.");
    const {ctx} = buildRetrievalContext([anchor], 5000, {
      passages: [correction, earlier], incomplete: false, scanned_pages: 1,
    });
    expect(ctx.indexOf(earlier.text)).toBeLessThan(ctx.indexOf(correction.text));
    expect(ctx).toContain(correction.text);
    expect(ctx).toContain(earlier.text);
  });
  it("selects high-priority latest evidence before chronological ordering under a tight budget", () => {
    const correction = passage(3, 200, "Correction: reopened.");
    const earlier = passage(2, 100, "Earlier plan. ".repeat(40));
    const {ctx} = buildRetrievalContext([anchor], 1100, {
      passages: [correction, earlier], incomplete: false, scanned_pages: 1,
    });
    expect(ctx).toContain(correction.text);
    expect(ctx).not.toContain(earlier.text);
    expect(ctx.length).toBeLessThanOrEqual(1100);
  });
  it("keeps equal-time ordering and does not invent a date for unknown timestamps", () => {
    const records = [passage(2, NaN, "Undated."), passage(3, 200, "First."), passage(4, 200, "Second.")];
    const {ctx} = buildRetrievalContext([anchor], 5000, {
      passages: records, incomplete: false, scanned_pages: 1,
    });
    expect(ctx).toContain("message_time: unknown");
    expect(ctx.indexOf("First.")).toBeLessThan(ctx.indexOf("Second."));
  });
});
