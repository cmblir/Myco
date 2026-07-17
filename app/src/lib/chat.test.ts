import { beforeEach, describe, expect, it, vi } from "vitest";
import { complete, type AskStage } from "./chat";
import { ipc } from "./ipc";

// The Ask wait used to be theatre: a random shuffle of vault stems pulsing under
// a static "searching the wiki…", while the code that actually chose the pages
// said nothing. Streaming was measured and killed (prefill dominates), so honest
// staging is what is left — and the stages have to be true, or this is the same
// lie with more steps.

const VAULT = "/v";
const SETTINGS = {
  query_provider: "builtin-local",
  query_model: "gemma-3-1b",
  ingest_provider: "anthropic-cli",
  ingest_model: "",
} as never;

function stages(): { seen: AskStage[]; onStage: (s: AskStage) => void } {
  const seen: AskStage[] = [];
  return { seen, onStage: (s) => seen.push(s) };
}

describe("complete() ask stages", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(ipc, "getSettings").mockResolvedValue(SETTINGS);
    vi.spyOn(ipc, "localQuery").mockResolvedValue("an answer");
    vi.spyOn(ipc, "readVaultContext").mockResolvedValue("");
  });

  it("reports the pages retrieval actually chose", async () => {
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 51,
      model: "builtin-local:gemma-3-1b",
    });
    vi.spyOn(ipc, "semanticSearch").mockResolvedValue([
      { page: "wiki/attention-mechanism.md", stem: "attention-mechanism", section: 0, score: 0.9 },
      { page: "wiki/embeddings.md", stem: "embeddings", section: 0, score: 0.8 },
    ]);
    vi.spyOn(ipc, "readFile").mockResolvedValue({
      path: "x",
      raw: "body",
      content: "body",
      frontmatter: null,
    });

    const { seen, onStage } = stages();
    await complete({
      task: "query",
      cwd: VAULT,
      messages: [{ role: "user", content: "what is attention?" }],
      onStage,
    });

    expect(seen.map((s) => s.kind)).toEqual(["retrieving", "thinking"]);
    // The real hits, not a sample of the vault.
    expect(seen[1]).toEqual({
      kind: "thinking",
      stems: ["attention-mechanism", "embeddings"],
    });
  });

  it("reports only the pages that fit the budget, not every hit", async () => {
    // The context is bounded; pages past the budget are never shown to the
    // model, so naming them in the UI would be another fiction.
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 51,
      model: "builtin-local:gemma-3-1b",
    });
    vi.spyOn(ipc, "semanticSearch").mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => ({
        page: `wiki/p${i}.md`,
        stem: `p${i}`,
        section: 0,
        score: 1 - i / 12,
      })),
    );
    // Each page is a third of the builtin budget, so only a few can fit.
    vi.spyOn(ipc, "readFile").mockResolvedValue({
      path: "x",
      raw: "x".repeat(2_500),
      content: "x".repeat(2_500),
      frontmatter: null,
    });

    const { seen, onStage } = stages();
    await complete({
      task: "query",
      cwd: VAULT,
      messages: [{ role: "user", content: "q" }],
      onStage,
    });
    const thinking = seen.find((s) => s.kind === "thinking");
    if (thinking?.kind !== "thinking") throw new Error("expected a thinking stage");
    expect(thinking.stems.length).toBeGreaterThan(0);
    expect(thinking.stems.length).toBeLessThan(12);
  });

  it("names no pages when there is no index", async () => {
    // Without an index the whole vault is concatenated instead — no page was
    // chosen, so nothing may be named.
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({ indexed_pages: 0, model: "" });
    const search = vi.spyOn(ipc, "semanticSearch");

    const { seen, onStage } = stages();
    await complete({
      task: "query",
      cwd: VAULT,
      messages: [{ role: "user", content: "q" }],
      onStage,
    });
    expect(search).not.toHaveBeenCalled();
    expect(seen).toEqual([{ kind: "thinking", stems: [] }]);
  });

  it("names no pages when retrieval finds nothing", async () => {
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 51,
      model: "builtin-local:gemma-3-1b",
    });
    vi.spyOn(ipc, "semanticSearch").mockResolvedValue([]);

    const { seen, onStage } = stages();
    await complete({
      task: "query",
      cwd: VAULT,
      messages: [{ role: "user", content: "q" }],
      onStage,
    });
    expect(seen).toEqual([{ kind: "retrieving" }, { kind: "thinking", stems: [] }]);
  });

  it("still reaches the model when retrieval throws", async () => {
    vi.spyOn(ipc, "embeddingsStatus").mockRejectedValue(new Error("index gone"));
    const { seen, onStage } = stages();
    const out = await complete({
      task: "query",
      cwd: VAULT,
      messages: [{ role: "user", content: "q" }],
      onStage,
    });
    expect(out).toBe("an answer");
    expect(seen).toEqual([{ kind: "thinking", stems: [] }]);
  });

  it("works without an onStage callback", async () => {
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({ indexed_pages: 0, model: "" });
    await expect(
      complete({ task: "query", cwd: VAULT, messages: [{ role: "user", content: "q" }] }),
    ).resolves.toBe("an answer");
  });
});
