import { describe, it, expect } from "vitest";
import { buildIngestPlanPrompt, parseIngestPlan } from "./ingestPlan";

describe("parseIngestPlan", () => {
  it("parses a plain JSON array of decisions", () => {
    const text = JSON.stringify([
      { subject: "sparse attention", decision: "UPDATE", target: "attention-mechanism", reason: "new variant" },
      { subject: "flash-attention", decision: "ADD", target: null, reason: "not covered" },
    ]);
    const plan = parseIngestPlan(text);
    expect(plan).toHaveLength(2);
    expect(plan[0]).toMatchObject({ decision: "UPDATE", target: "attention-mechanism" });
    expect(plan[1]).toMatchObject({ decision: "ADD", target: null });
  });

  it("tolerates ```json fences and surrounding prose", () => {
    const text = 'Here is the plan:\n```json\n[{"subject":"x","decision":"noop","target":"embeddings","reason":"covered"}]\n```\nDone.';
    const plan = parseIngestPlan(text);
    expect(plan).toHaveLength(1);
    expect(plan[0].decision).toBe("NOOP"); // case-normalized
    expect(plan[0].target).toBe("embeddings");
  });

  it("drops items with an unknown decision or empty subject", () => {
    const text = JSON.stringify([
      { subject: "ok", decision: "ADD", target: null, reason: "" },
      { subject: "", decision: "ADD", target: null, reason: "empty subject" },
      { subject: "bad", decision: "REWRITE", target: null, reason: "unknown decision" },
    ]);
    const plan = parseIngestPlan(text);
    expect(plan).toHaveLength(1);
    expect(plan[0].subject).toBe("ok");
  });

  it("normalizes a target that came as a [[wikilink]] or with .md", () => {
    const text = JSON.stringify([
      { subject: "a", decision: "MERGE", target: "[[tokenization]]", reason: "" },
      { subject: "b", decision: "UPDATE", target: "embeddings.md", reason: "" },
    ]);
    const plan = parseIngestPlan(text);
    expect(plan[0].target).toBe("tokenization");
    expect(plan[1].target).toBe("embeddings");
  });

  it("nulls the target for an ADD even if the model supplied one", () => {
    const text = JSON.stringify([{ subject: "a", decision: "ADD", target: "somewhere", reason: "" }]);
    expect(parseIngestPlan(text)[0].target).toBeNull();
  });

  it("returns an empty plan for unparseable output", () => {
    expect(parseIngestPlan("the model rambled with no JSON")).toEqual([]);
    expect(parseIngestPlan("")).toEqual([]);
  });
});

describe("buildIngestPlanPrompt", () => {
  it("includes the source and the candidate stems", () => {
    const prompt = buildIngestPlanPrompt("a source about attention", [
      { page: "wiki/attention-mechanism.md", stem: "attention-mechanism", score: 0.82 },
    ]);
    expect(prompt).toContain("a source about attention");
    expect(prompt).toContain("attention-mechanism");
    expect(prompt).toContain("JSON array");
  });

  it("notes when there are no candidate pages", () => {
    const prompt = buildIngestPlanPrompt("x", []);
    expect(prompt).toContain("no matching pages yet");
  });
});
