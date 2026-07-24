import { beforeEach, describe, expect, it, vi } from "vitest";
import { complete, isIndexStale, type AskStage } from "./chat";
import { ipc } from "./ipc";
import { BUILTIN_EMBED_MODEL } from "./providers";

// The id a healthy (non-stale) index is tagged with today — matches
// `CURRENT_BUILTIN_INDEX_ID` in chat.ts.
const CURRENT_INDEX_MODEL = `builtin-local:${BUILTIN_EMBED_MODEL}`;

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
      model: CURRENT_INDEX_MODEL,
    });
    vi.spyOn(ipc, "semanticSearch").mockResolvedValue([
      { page: "wiki/attention-mechanism.md", stem: "attention-mechanism", section: 0, text: "attention body", score: 0.9 },
      { page: "wiki/embeddings.md", stem: "embeddings", section: 0, text: "embeddings body", score: 0.8 },
    ]);
    const readFile = vi.spyOn(ipc, "readFile");

    const { seen, onStage } = stages();
    await complete({
      task: "query",
      cwd: VAULT,
      messages: [{ role: "user", content: "what is attention?" }],
      onStage,
    });
    expect(readFile).not.toHaveBeenCalled();

    expect(seen.map((s) => s.kind)).toEqual(["retrieving", "thinking"]);
    // The real hits, not a sample of the vault.
    expect(seen[1]).toEqual({
      kind: "thinking",
      stems: ["attention-mechanism", "embeddings"],
    });
  });

  it("dedupes a page's stem when its hits are not adjacent in rank order", async () => {
    // semantic_search returns hits ranked by SCORE, not grouped by page, so
    // the same page can resurface after another page's hit (A, B, A). The
    // citation header may legitimately repeat for that page, but the stem
    // list feeding the page count/list must only name it once.
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 51,
      model: CURRENT_INDEX_MODEL,
    });
    vi.spyOn(ipc, "semanticSearch").mockResolvedValue([
      { page: "wiki/a.md", stem: "a", section: 0, text: "AAA one", score: 0.9 },
      { page: "wiki/b.md", stem: "b", section: 0, text: "BBB", score: 0.85 },
      { page: "wiki/a.md", stem: "a", section: 1, text: "AAA two", score: 0.8 },
    ]);

    const { seen, onStage } = stages();
    await complete({
      task: "query",
      cwd: VAULT,
      messages: [{ role: "user", content: "what is AAA?" }],
      onStage,
    });

    expect(seen.map((s) => s.kind)).toEqual(["retrieving", "thinking"]);
    expect(seen[1]).toEqual({
      kind: "thinking",
      stems: ["a", "b"],
    });
  });

  it("reports only the pages that fit the budget, not every hit", async () => {
    // The context is bounded; pages past the budget are never shown to the
    // model, so naming them in the UI would be another fiction.
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 51,
      model: CURRENT_INDEX_MODEL,
    });
    // Each chunk's passage is a third of the builtin budget, so only a few can fit.
    vi.spyOn(ipc, "semanticSearch").mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => ({
        page: `wiki/p${i}.md`,
        stem: `p${i}`,
        section: 0,
        text: "x".repeat(2_500),
        score: 1 - i / 12,
      })),
    );

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
      model: CURRENT_INDEX_MODEL,
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

  it("inlines retrieved chunk passages, grouped by page, not whole files", async () => {
    const chunks = [
      { page: "wiki/a.md", stem: "a", section: 0, text: "AAA passage one", score: 0.9 },
      { page: "wiki/a.md", stem: "a", section: 2, text: "AAA passage two", score: 0.8 },
      { page: "wiki/b.md", stem: "b", section: 0, text: "BBB passage", score: 0.7 },
    ];
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 51,
      model: CURRENT_INDEX_MODEL,
    });
    vi.spyOn(ipc, "semanticSearch").mockResolvedValue(chunks);
    const readFile = vi.spyOn(ipc, "readFile");
    let seenPrompt = "";
    vi.spyOn(ipc, "localQuery").mockImplementation(async (prompt: string) => {
      seenPrompt = prompt;
      return "an answer";
    });

    const { onStage } = stages();
    await complete({
      task: "query",
      cwd: VAULT,
      messages: [{ role: "user", content: "what is AAA?" }],
      onStage,
    });

    expect(readFile).not.toHaveBeenCalled();
    expect(seenPrompt).toContain("AAA passage one");
    expect(seenPrompt).toContain("AAA passage two");
    expect(seenPrompt).toContain("BBB passage");
    expect(seenPrompt).toContain("[[a]]");
    expect(seenPrompt).toContain("[[b]]");
  });

  it("signals stale and skips retrieval when the index predates a bundled embed-model swap", async () => {
    // The bge-m3 swap (Task 4) leaves a pre-existing index tagged with the
    // retired model id — cosining a fresh query against it would be
    // meaningless, so retrieval must not even be attempted.
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 51,
      model: "builtin-local:gemma-3-1b",
    });
    const search = vi.spyOn(ipc, "semanticSearch");
    const fallback = vi.spyOn(ipc, "readVaultContext").mockResolvedValue("whole vault");

    const { seen, onStage } = stages();
    const out = await complete({
      task: "query",
      cwd: VAULT,
      messages: [{ role: "user", content: "q" }],
      onStage,
    });

    expect(search).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalled(); // the fallback must still run
    expect(seen).toEqual([{ kind: "thinking", stems: [], stale: true }]);
    expect(out).toBe("an answer");
  });
});

describe("complete() CLI query retrieval (retrieval 1b)", () => {
  // CLI providers (anthropic-cli/gemini-cli/codex-cli) used to grep the vault
  // cwd blind on every query. These cover the new bge-m3 retrieval injection
  // into the flattened CLI prompt — ingest must stay untouched (it already
  // has real tool access and writes files; injecting stale search context
  // into that flow was never the ask).
  const CLI_SETTINGS = {
    query_provider: "anthropic-cli",
    query_model: "sonnet",
    ingest_provider: "anthropic-cli",
    ingest_model: "haiku",
  } as never;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(ipc, "getSettings").mockResolvedValue(CLI_SETTINGS);
  });

  it("injects retrieved passage text into the CLI query prompt when the index has hits", async () => {
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 51,
      model: CURRENT_INDEX_MODEL,
    });
    vi.spyOn(ipc, "semanticSearch").mockResolvedValue([
      { page: "wiki/attention-mechanism.md", stem: "attention-mechanism", section: 0, text: "attention body passage", score: 0.9 },
    ]);
    const claudeRun = vi
      .spyOn(ipc, "claudeRun")
      .mockResolvedValue({ stdout: "an answer", stderr: "", status: 0 });

    const { seen, onStage } = stages();
    const out = await complete({
      task: "query",
      cwd: VAULT,
      messages: [
        { role: "system", content: "You are Memex." },
        { role: "user", content: "what is attention?" },
      ],
      onStage,
    });

    expect(out).toBe("an answer");
    expect(claudeRun).toHaveBeenCalledTimes(1);
    const [prompt] = claudeRun.mock.calls[0];
    expect(prompt).toContain("Relevant wiki context");
    expect(prompt).toContain("attention body passage");
    expect(prompt).toContain("[[attention-mechanism]]");
    // Retrieval block must land between the system content and the user turn.
    expect(prompt.indexOf("You are Memex.")).toBeLessThan(
      prompt.indexOf("Relevant wiki context"),
    );
    expect(prompt.indexOf("Relevant wiki context")).toBeLessThan(
      prompt.indexOf("what is attention?"),
    );
    expect(seen).toEqual([
      { kind: "retrieving" },
      { kind: "thinking", stems: ["attention-mechanism"] },
    ]);
  });

  it("falls back to a plain flattened prompt when retrieval finds nothing", async () => {
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({ indexed_pages: 0, model: "" });
    const search = vi.spyOn(ipc, "semanticSearch");
    const claudeRun = vi
      .spyOn(ipc, "claudeRun")
      .mockResolvedValue({ stdout: "an answer", stderr: "", status: 0 });

    const out = await complete({
      task: "query",
      cwd: VAULT,
      messages: [{ role: "user", content: "what is attention?" }],
    });

    expect(out).toBe("an answer");
    expect(search).not.toHaveBeenCalled();
    const [prompt] = claudeRun.mock.calls[0];
    expect(prompt).not.toContain("Relevant wiki context");
    expect(prompt).toBe("what is attention?");
  });

  it("does not inject retrieval into the CLI ingest prompt", async () => {
    const status = vi.spyOn(ipc, "embeddingsStatus");
    const search = vi.spyOn(ipc, "semanticSearch");
    const claudeRun = vi
      .spyOn(ipc, "claudeRun")
      .mockResolvedValue({ stdout: "ingested", stderr: "", status: 0 });

    const { seen, onStage } = stages();
    const out = await complete({
      task: "ingest",
      cwd: VAULT,
      messages: [
        { role: "system", content: "Ingest instructions." },
        { role: "user", content: "ingest raw/foo.txt" },
      ],
      onStage,
    });

    expect(out).toBe("ingested");
    expect(status).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
    const [prompt] = claudeRun.mock.calls[0];
    expect(prompt).toBe("Ingest instructions.\n\ningest raw/foo.txt");
  });
});

describe("isIndexStale", () => {
  it("flags an index whose model no longer matches the current builtin embed id", () => {
    expect(
      isIndexStale({ indexed_pages: 12, model: "builtin-local:gemma-3-1b" }),
    ).toBe(true);
  });

  it("does not flag an index that matches the current builtin embed id", () => {
    expect(isIndexStale({ indexed_pages: 12, model: CURRENT_INDEX_MODEL })).toBe(
      false,
    );
  });

  it("does not flag a never-indexed vault, even with no model recorded", () => {
    expect(isIndexStale({ indexed_pages: 0, model: "" })).toBe(false);
    expect(isIndexStale(null)).toBe(false);
    expect(isIndexStale(undefined)).toBe(false);
  });

  it("does not flag an ollama-tagged index (only builtin-local can go stale)", () => {
    expect(
      isIndexStale({ indexed_pages: 5, model: "ollama:nomic-embed-text" }),
    ).toBe(false);
  });
});
