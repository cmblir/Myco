import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canGenerate,
  complete,
  isIndexStale,
  retrieveChunks,
  roleFor,
  RELEVANCE_FLOOR,
  type AskStage,
} from "./chat";
import { ipc, type ScoredChunk } from "./ipc";
import { BUILTIN_CHAT_MODEL, BUILTIN_EMBED_MODEL } from "./providers";
import { roleFixture, selectedRolesFixture } from "./modelRoles.testSupport";
import { log } from "./log";

// The id a healthy (non-stale) index is tagged with today — matches
// `CURRENT_BUILTIN_INDEX_ID` in chat.ts.
const CURRENT_INDEX_MODEL = `builtin-local:${BUILTIN_EMBED_MODEL}`;

/** `semantic_search`'s envelope around a bare hit list — nothing rejected
 * server-side, the measured floor. */
const found = (hits: ScoredChunk[]) => ({
  hits,
  floor: RELEVANCE_FLOOR,
  below_floor: [],
});

// The Ask wait used to be theatre: a random shuffle of vault stems pulsing under
// a static "searching the wiki…", while the code that actually chose the pages
// said nothing. Streaming was measured and killed (prefill dominates), so honest
// staging is what is left — and the stages have to be true, or this is the same
// lie with more steps.

const VAULT = "/v";
const SETTINGS = {
  query_provider: "builtin-local",
  query_model: BUILTIN_CHAT_MODEL,
  ingest_provider: "anthropic-cli",
  ingest_model: "",
  model_roles: selectedRolesFixture({ ask: { providerId: "builtin-local", modelId: BUILTIN_CHAT_MODEL }, compilation: { providerId: "anthropic-cli", modelId: "haiku" } }),
} as never;

function mockCapturedRoles(): void {
  vi.spyOn(ipc, "captureModelRole").mockImplementation(async (origin, role, usage) => {
    const selected = roleFor(role, await ipc.getSettings());
    return roleFixture(role, selected.provider, selected.model, origin, usage, selected.effort);
  });
  vi.spyOn(ipc, "localChatStatus").mockImplementation(async (model) => ({ model_id: model ?? BUILTIN_CHAT_MODEL, state: "ready", bytes: 0 }));
}

function stages(): { seen: AskStage[]; onStage: (s: AskStage) => void } {
  const seen: AskStage[] = [];
  return { seen, onStage: (s) => seen.push(s) };
}

describe("complete() selected-source generation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(ipc, "localChatStatus").mockResolvedValue({
      model_id: BUILTIN_CHAT_MODEL,
      state: "ready",
      bytes: 0,
    });
  });

  it.each(["audio", "study"] as const)(
    "keeps supplied %s source messages without searching or reading another vault context",
    async (role) => {
      const origin = {
        vaultPath: VAULT,
        openingToken: "synthetic-generated-opening",
      };
      const snapshot = roleFixture(
        role,
        "builtin-local",
        BUILTIN_CHAT_MODEL,
        origin,
      );
      const supplied = [
        {
          role: "system" as const,
          content:
            "Return a synthetic cited JSON artifact from the supplied text.",
        },
        {
          role: "user" as const,
          content: "Selected fictional mosaic source: blue tiles only.",
        },
      ];
      const status = vi
        .spyOn(ipc, "embeddingsStatus")
        .mockRejectedValue(new Error("no index should be inspected"));
      const search = vi.spyOn(ipc, "semanticSearch");
      const context = vi
        .spyOn(ipc, "readVaultContext")
        .mockResolvedValue("Unselected synthetic red tiles.");
      const read = vi.spyOn(ipc, "readFile");
      const opening = vi.spyOn(ipc, "agentVaultSession");
      const capture = vi.spyOn(ipc, "captureModelRole");
      const generate = vi
        .spyOn(ipc, "localQuery")
        .mockResolvedValue("synthetic generation");
      const { seen, onStage } = stages();
      expect(
        await complete({
          task: "generate",
          featureRole: role,
          cwd: VAULT,
          origin,
          roleSnapshot: snapshot,
          paths: role === "audio" ? ["wiki/mosaic.md"] : [],
          messages: supplied,
          onStage,
        }),
      ).toBe("synthetic generation");
      expect(status).not.toHaveBeenCalled();
      expect(search).not.toHaveBeenCalled();
      expect(context).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(opening).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();
      expect(generate).toHaveBeenCalledWith(
        supplied.map((message) => message.content).join("\n\n"),
        320,
        origin,
        snapshot,
        expect.any(String),
      );
      expect(seen).toEqual([{ kind: "thinking", stems: [] }]);
    },
  );

  it.each(["reflect", "lint"] as const)(
    "retrieves source passages for instruction-only %s generation",
    async (role) => {
      const origin = {
        vaultPath: VAULT,
        openingToken: "synthetic-generated-opening",
      };
      const snapshot = roleFixture(
        role,
        "builtin-local",
        BUILTIN_CHAT_MODEL,
        origin,
      );
      vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
        indexed_pages: 1,
        model: CURRENT_INDEX_MODEL,
      });
      const search = vi.spyOn(ipc, "semanticSearch").mockResolvedValue(
        found([
          {
            page: "wiki/mosaic.md",
            stem: "mosaic",
            section: 0,
            text: "The synthetic mosaic has blue tiles and one missing source citation.",
            score: 0.9,
            similarity: 0.7,
          },
        ]),
      );
      const context = vi.spyOn(ipc, "readVaultContext");
      const generate = vi
        .spyOn(ipc, "localQuery")
        .mockResolvedValue("synthetic findings");
      const instruction =
        "Inspect the vault and propose source-grounded improvements.";
      const { seen, onStage } = stages();

      expect(
        await complete({
          task: "generate",
          featureRole: role,
          cwd: VAULT,
          origin,
          roleSnapshot: snapshot,
          messages: [{ role: "user", content: instruction }],
          onStage,
        }),
      ).toBe("synthetic findings");

      expect(search).toHaveBeenCalledOnce();
      expect(context).not.toHaveBeenCalled();
      expect(generate).toHaveBeenCalledWith(
        expect.stringContaining(
          "The synthetic mosaic has blue tiles and one missing source citation.",
        ),
        320,
        origin,
        snapshot,
        expect.any(String),
      );
      expect(generate.mock.calls[0][0]).toContain(instruction);
      expect(seen).toEqual([
        { kind: "retrieving" },
        { kind: "thinking", stems: ["mosaic"] },
      ]);
    },
  );
});

describe("complete() ask stages", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockCapturedRoles();
    vi.spyOn(ipc, "agentVaultSession").mockResolvedValue({ vaultPath: VAULT, openingToken: "synthetic-opening" });
    vi.spyOn(ipc, "getSettings").mockResolvedValue(SETTINGS);
    vi.spyOn(ipc, "localQuery").mockResolvedValue("an answer");
    vi.spyOn(ipc, "readVaultContext").mockResolvedValue("");
    vi.spyOn(ipc, "semanticSearch").mockResolvedValue(found([]));
    // Existing tests exercise the generate path, so default to "available" —
    // the fast-fail itself gets its own test below.
    vi.spyOn(ipc, "localChatModelAvailable").mockResolvedValue(true);
  });

  it("reports the pages retrieval actually chose", async () => {
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 51,
      model: CURRENT_INDEX_MODEL,
    });
    vi.spyOn(ipc, "semanticSearch").mockResolvedValue(found([
      { page: "wiki/attention-mechanism.md", stem: "attention-mechanism", section: 0, text: "attention body", score: 0.9, similarity: 0.7 },
      { page: "wiki/embeddings.md", stem: "embeddings", section: 0, text: "embeddings body", score: 0.8, similarity: 0.7 },
    ]));
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
    vi.spyOn(ipc, "semanticSearch").mockResolvedValue(found([
      { page: "wiki/a.md", stem: "a", section: 0, text: "AAA one", score: 0.9, similarity: 0.7 },
      { page: "wiki/b.md", stem: "b", section: 0, text: "BBB", score: 0.85, similarity: 0.7 },
      { page: "wiki/a.md", stem: "a", section: 1, text: "AAA two", score: 0.8, similarity: 0.7 },
    ]));

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
    vi.spyOn(ipc, "semanticSearch").mockResolvedValue(found(
      Array.from({ length: 12 }, (_, i) => ({
        page: `wiki/p${i}.md`,
        stem: `p${i}`,
        section: 0,
        text: "x".repeat(2_500),
        score: 1 - i / 12,
        // Above RELEVANCE_FLOOR, so it is the BUDGET that truncates here —
        // which is what this test is about.
        similarity: 0.7,
      })),
    ));

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

  it("names no pages when dense and lexical retrieval find nothing", async () => {
    // A fresh dense index still searches the lexical arm; an empty result
    // names no source and never claims an IPC failure.
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({ indexed_pages: 0, model: "" });
    const search = vi.spyOn(ipc, "semanticSearch");

    const { seen, onStage } = stages();
    await complete({
      task: "query",
      cwd: VAULT,
      messages: [{ role: "user", content: "q" }],
      onStage,
    });
    expect(search).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ kind: "retrieving" }, { kind: "thinking", stems: [] }]);
  });

  it.each([0, 10])("uses verified lexical context with %i dense pages without a whole-vault dump", async (indexedPages) => {
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: indexedPages,
      model: indexedPages === 0 ? "" : "builtin-local:gemma-3-1b",
    });
    vi.spyOn(ipc, "semanticSearch").mockResolvedValue(found([
      { page: "wiki/id.md", stem: "id", section: 0, text: "SYN-4719 was accepted.", score: 0.02, similarity: null, exact_match: true },
    ]));
    const fallback = vi.spyOn(ipc, "readVaultContext").mockResolvedValue("unrelated whole vault");
    const query = vi.spyOn(ipc, "localQuery");
    const { seen, onStage } = stages();
    await complete({ task: "query", cwd: VAULT, messages: [{ role: "user", content: "SYN-4719" }], onStage });
    expect(seen).toEqual([{ kind: "retrieving" }, { kind: "thinking", stems: ["id"] }]);
    expect(fallback).not.toHaveBeenCalled();
    expect(query.mock.calls[0][0]).toContain("SYN-4719 was accepted.");
    expect(query.mock.calls[0][0]).not.toContain("unrelated whole vault");
  });

  it("names no pages when retrieval finds nothing", async () => {
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 51,
      model: CURRENT_INDEX_MODEL,
    });
    vi.spyOn(ipc, "semanticSearch").mockResolvedValue(found([]));

    const { seen, onStage } = stages();
    await complete({
      task: "query",
      cwd: VAULT,
      messages: [{ role: "user", content: "q" }],
      onStage,
    });
    expect(seen).toEqual([{ kind: "retrieving" }, { kind: "thinking", stems: [] }]);
  });

  it("still reaches the model when retrieval throws, and marks the failure as visible, not empty", async () => {
    // Before this fix, a rejected embeddings_status call was swallowed into
    // `null` and treated exactly like "no index exists" — indistinguishable
    // from a legitimately empty vault. This is the regression test for that:
    // the fallback must still run (so the user gets an answer), but the
    // failure must now be flagged and logged rather than silently hidden.
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    vi.spyOn(ipc, "embeddingsStatus").mockRejectedValue(new Error("index gone"));
    const { seen, onStage } = stages();
    const out = await complete({
      task: "query",
      cwd: VAULT,
      messages: [{ role: "user", content: "q" }],
      onStage,
    });
    expect(out).toBe("an answer");
    expect(seen).toEqual([
      { kind: "thinking", stems: [], retrievalFailed: true },
    ]);
    expect(warn).toHaveBeenCalledWith(
      "retrieve_chunks.embeddings_status_failed",
      { code: "embeddings_status_failed" },
    );
  });

  it("flags retrievalFailed and logs when semantic_search rejects (not an empty hit list)", async () => {
    // A rejected semantic_search must be distinguishable from "retrieval ran
    // and legitimately found nothing" — the false-negative this bug caused.
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 51,
      model: CURRENT_INDEX_MODEL,
    });
    vi.spyOn(ipc, "semanticSearch").mockRejectedValue(new Error("search backend down"));

    const { seen, onStage } = stages();
    const out = await complete({
      task: "query",
      cwd: VAULT,
      messages: [{ role: "user", content: "q" }],
      onStage,
    });

    expect(out).toBe("an answer");
    expect(seen).toEqual([
      { kind: "retrieving" },
      { kind: "thinking", stems: [], retrievalFailed: true },
    ]);
    expect(warn).toHaveBeenCalledWith(
      "retrieve_chunks.semantic_search_failed",
      { code: "semantic_search_failed" },
    );
  });

  it("does NOT flag retrievalFailed for a legitimately never-indexed vault (false-positive guard)", async () => {
    // indexed_pages === 0 is a normal, expected state (fresh vault) — it must
    // never be conflated with a failed IPC call, or every fresh vault would
    // show a spurious failure notice.
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({ indexed_pages: 0, model: "" });
    const search = vi.spyOn(ipc, "semanticSearch");

    const { seen, onStage } = stages();
    await complete({
      task: "query",
      cwd: VAULT,
      messages: [{ role: "user", content: "q" }],
      onStage,
    });

    expect(search).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ kind: "retrieving" }, { kind: "thinking", stems: [] }]);
  });

  it("does NOT flag retrievalFailed when semantic_search legitimately resolves to no hits", async () => {
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 51,
      model: CURRENT_INDEX_MODEL,
    });
    vi.spyOn(ipc, "semanticSearch").mockResolvedValue(found([]));

    const { seen, onStage } = stages();
    await complete({
      task: "query",
      cwd: VAULT,
      messages: [{ role: "user", content: "q" }],
      onStage,
    });

    expect(seen).toEqual([{ kind: "retrieving" }, { kind: "thinking", stems: [] }]);
  });

  it("does not replace a healthy empty search with unfiltered vault content", async () => {
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({ indexed_pages: 3, model: CURRENT_INDEX_MODEL });
    vi.spyOn(ipc, "semanticSearch").mockResolvedValue(found([]));
    const fallback = vi.spyOn(ipc, "readVaultContext").mockResolvedValue("Unrelated private notes.");
    const generate = vi.spyOn(ipc, "localQuery").mockResolvedValue("No evidence.");
    await complete({ task: "query", cwd: VAULT, messages: [{ role: "user", content: "unknown fact" }] });
    expect(fallback).not.toHaveBeenCalled();
    expect(generate.mock.calls[0][0]).toContain("No matching source passages");
    expect(generate.mock.calls[0][0]).not.toContain("Unrelated private notes.");
  });

  it("uses the supplied retrieval question and date window instead of the raw follow-up", async () => {
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({ indexed_pages: 3, model: CURRENT_INDEX_MODEL });
    const search = vi.spyOn(ipc, "semanticSearch").mockResolvedValue(found([]));
    const fallback = vi.spyOn(ipc, "readVaultContext");
    const range = { start: "2026-08-01", end: "2026-08-05" };
    await complete({ task: "query", cwd: VAULT, range, scope: "all", retrievalQuery: "caching decision why",
      messages: [{ role: "user", content: "why last week?" }] });
    expect(search.mock.calls[0][0]).toBe("caching decision why");
    expect(search.mock.calls[0][4]).toEqual(range);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("a stale index still sets `stale`, not `retrievalFailed` (they are distinct signals)", async () => {
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 51,
      model: "builtin-local:gemma-3-1b",
    });
    const search = vi.spyOn(ipc, "semanticSearch");
    vi.spyOn(ipc, "readVaultContext").mockResolvedValue("whole vault");

    const { seen, onStage } = stages();
    await complete({
      task: "query",
      cwd: VAULT,
      messages: [{ role: "user", content: "q" }],
      onStage,
    });

    expect(search).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ kind: "retrieving" }, { kind: "thinking", stems: [], stale: true }]);
  });

  it("an Ask over one note searches only its pages and never falls back to the whole vault", async () => {
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 51,
      model: CURRENT_INDEX_MODEL,
    });
    const search = vi.spyOn(ipc, "semanticSearch").mockResolvedValue(found([]));
    const fallback = vi.spyOn(ipc, "readVaultContext").mockResolvedValue("whole vault");
    await complete({
      task: "query",
      cwd: VAULT,
      messages: [{ role: "user", content: "q" }],
      paths: ["wiki/a.md"],
    });
    expect(search.mock.calls[0][7]).toEqual(["wiki/a.md"]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("works without an onStage callback", async () => {
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({ indexed_pages: 0, model: "" });
    await expect(
      complete({ task: "query", cwd: VAULT, messages: [{ role: "user", content: "q" }] }),
    ).resolves.toBe("an answer");
  });

  it("inlines retrieved chunk passages, grouped by page, not whole files", async () => {
    const chunks = [
      { page: "wiki/a.md", stem: "a", section: 0, text: "AAA passage one", score: 0.9, similarity: 0.7 },
      { page: "wiki/a.md", stem: "a", section: 2, text: "AAA passage two", score: 0.8, similarity: 0.7 },
      { page: "wiki/b.md", stem: "b", section: 0, text: "BBB passage", score: 0.7, similarity: 0.7 },
    ];
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 51,
      model: CURRENT_INDEX_MODEL,
    });
    vi.spyOn(ipc, "semanticSearch").mockResolvedValue(found(chunks));
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
    expect(seenPrompt).toContain("[[wiki/a|a]]");
    expect(seenPrompt).toContain("[[wiki/b|b]]");
  });

  it("keeps ranked evidence ahead of a lower-ranked map", async () => {
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 51,
      model: CURRENT_INDEX_MODEL,
    });
    vi.spyOn(ipc, "semanticSearch").mockResolvedValue(found([
      { page: "wiki/a.md", stem: "a", section: 0, text: "AAA passage", score: 0.9, similarity: 0.7 },
      { page: "wiki/maps/m.md", stem: "m", section: 0, text: "MAP passage", score: 0.8, similarity: 0.7 },
      { page: "wiki/b.md", stem: "b", section: 0, text: "BBB passage", score: 0.7, similarity: 0.7 },
    ]));
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

    expect(seenPrompt.indexOf("[[wiki/maps/m|m]]")).toBeGreaterThanOrEqual(0);
    expect(seenPrompt.indexOf("[[wiki/a|a]]")).toBeLessThan(seenPrompt.indexOf("[[wiki/maps/m|m]]"));
    expect(seenPrompt.indexOf("[[wiki/maps/m|m]]")).toBeLessThan(seenPrompt.indexOf("[[wiki/b|b]]"));
  });

  it("signals stale after lexical search finds no evidence for a retired dense index", async () => {
    // The backend skips incompatible dense vectors but searches the lexical
    // arm. No accepted source leaves the existing reindex warning visible.
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

    expect(search).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalled(); // the fallback must still run
    expect(seen).toEqual([{ kind: "retrieving" }, { kind: "thinking", stems: [], stale: true }]);
    expect(out).toBe("an answer");
  });

  it("skips retrieval entirely when the selected local model requires preparation", async () => {
    vi.spyOn(ipc, "localChatStatus").mockResolvedValue({ model_id: BUILTIN_CHAT_MODEL, state: "missing", bytes: 0 });
    const status = vi.spyOn(ipc, "embeddingsStatus");
    const search = vi.spyOn(ipc, "semanticSearch");
    const localQuery = vi.spyOn(ipc, "localQuery");

    const completion = complete({
      task: "query",
      cwd: VAULT,
      messages: [{ role: "user", content: "q" }],
    });
    await expect(completion).rejects.toThrow("local_model_preparation_required");
    await expect(completion).rejects.toThrow("install the selected model explicitly");

    expect(status).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(localQuery).not.toHaveBeenCalled();
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
    model_roles: selectedRolesFixture({ ask: { providerId: "anthropic-cli", modelId: "sonnet" }, compilation: { providerId: "anthropic-cli", modelId: "haiku" }, organization: { providerId: "anthropic-cli", modelId: "sonnet" } }),
  } as never;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockCapturedRoles();
    vi.spyOn(ipc, "agentVaultSession").mockResolvedValue({ vaultPath: VAULT, openingToken: "synthetic-opening" });
    vi.spyOn(ipc, "getSettings").mockResolvedValue(CLI_SETTINGS);
  });

  it("injects retrieved passage text into the CLI query prompt when the index has hits", async () => {
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 51,
      model: CURRENT_INDEX_MODEL,
    });
    vi.spyOn(ipc, "semanticSearch").mockResolvedValue(found([
      { page: "wiki/attention-mechanism.md", stem: "attention-mechanism", section: 0, text: "attention body passage", score: 0.9, similarity: 0.7 },
    ]));
    const claudeRun = vi
      .spyOn(ipc, "claudeRun")
      .mockResolvedValue({ stdout: "an answer", stderr: "", status: 0 });

    const { seen, onStage } = stages();
    const out = await complete({
      task: "query",
      cwd: VAULT,
      messages: [
        { role: "system", content: "You are myco." },
        { role: "user", content: "what is attention?" },
      ],
      onStage,
    });

    expect(out).toBe("an answer");
    expect(claudeRun).toHaveBeenCalledTimes(1);
    const [prompt] = claudeRun.mock.calls[0];
    expect(prompt).toContain("Relevant wiki context");
    expect(prompt).toContain("attention body passage");
    expect(prompt).toContain("[[wiki/attention-mechanism|attention-mechanism]]");
    // Retrieval block must land between the system content and the user turn.
    expect(prompt.indexOf("You are myco.")).toBeLessThan(
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

  it("does not inject retrieval when the caller passes no onStage (study/digests/audioOverview)", async () => {
    // These share task:"query" + query_provider with interactive Ask but never
    // pass onStage — they also demand strict-JSON-only output, so retrieval's
    // prose block ("use Read/Grep for anything more") must not reach them even
    // when the index is healthy and has real hits.
    const status = vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 51,
      model: CURRENT_INDEX_MODEL,
    });
    const search = vi.spyOn(ipc, "semanticSearch").mockResolvedValue(found([
      { page: "wiki/attention-mechanism.md", stem: "attention-mechanism", section: 0, text: "attention body passage", score: 0.9, similarity: 0.7 },
    ]));
    const claudeRun = vi
      .spyOn(ipc, "claudeRun")
      .mockResolvedValue({ stdout: "[]", stderr: "", status: 0 });

    const out = await complete({
      task: "query",
      cwd: VAULT,
      messages: [
        { role: "system", content: "Reply with ONLY a JSON array, no prose." },
        { role: "user", content: "generate 5 flashcards about attention" },
      ],
      // no onStage — this is how study.ts/digests.ts/audioOverview.ts call complete()
    });

    expect(out).toBe("[]");
    expect(status).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(claudeRun).toHaveBeenCalledTimes(1);
    const [prompt] = claudeRun.mock.calls[0];
    expect(prompt).not.toContain("Relevant wiki context");
    expect(prompt).toBe(
      "Reply with ONLY a JSON array, no prose.\n\ngenerate 5 flashcards about attention",
    );
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

describe("complete() profile injection (Phase B, Task 6)", () => {
  // profile.md content that parses to a non-blank Profile (see profile.ts's
  // parseProfile). Builtin-local keeps the fixture focused on the injection
  // itself — retrieval short-circuits to "" via readVaultContext so the only
  // thing under test is whether/where the profile paragraph lands.
  const PROFILE_MD =
    "## Role\nBackend engineer\n\n## Goals\n- Ship it\n\n" +
    "## Interests\n- rust\n- vector search\n\n## Working style\nConcise\n";

  beforeEach(() => {
    vi.restoreAllMocks();
    mockCapturedRoles();
    vi.spyOn(ipc, "agentVaultSession").mockResolvedValue({ vaultPath: VAULT, openingToken: "synthetic-opening" });
    vi.spyOn(ipc, "getSettings").mockResolvedValue(SETTINGS);
    vi.spyOn(ipc, "localChatModelAvailable").mockResolvedValue(true);
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({ indexed_pages: 0, model: "" });
    vi.spyOn(ipc, "semanticSearch").mockResolvedValue(found([]));
    vi.spyOn(ipc, "readVaultContext").mockResolvedValue("");
  });

  async function askAndCapturePrompt(): Promise<string> {
    let seenPrompt = "";
    vi.spyOn(ipc, "localQuery").mockImplementation(async (prompt: string) => {
      seenPrompt = prompt;
      return "an answer";
    });
    await complete({
      task: "query",
      cwd: VAULT,
      messages: [{ role: "user", content: "what should I read next?" }],
    });
    return seenPrompt;
  }

  it("prepends the profile paragraph when the toggle is on and a profile exists", async () => {
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue({ profile_injection: true } as never);
    vi.spyOn(ipc, "readFile").mockResolvedValue({ raw: PROFILE_MD } as never);

    const prompt = await askAndCapturePrompt();
    expect(prompt).toContain("User profile:");
    expect(prompt).toContain("Backend engineer");
    expect(prompt).toContain("rust, vector search");
  });

  it("omits the profile paragraph when the toggle is off, even with a profile on disk", async () => {
    const readFile = vi.spyOn(ipc, "readFile").mockResolvedValue({ raw: PROFILE_MD } as never);
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue({ profile_injection: false } as never);

    const prompt = await askAndCapturePrompt();
    expect(prompt).not.toContain("User profile:");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("omits the profile paragraph when the toggle is on but there is no profile", async () => {
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue({ profile_injection: true } as never);
    vi.spyOn(ipc, "readFile").mockRejectedValue(new Error("not found"));

    const prompt = await askAndCapturePrompt();
    expect(prompt).not.toContain("User profile:");
  });

  it('never injects the profile paragraph for task:"ingest"', async () => {
    // Ingest gets its own weighting (INGEST_PROMPT's profileInterests param)
    // instead of a prepended paragraph. This suite's settings route ingest
    // through the CLI branch (ingest_provider: "anthropic-cli"), so it is
    // checked there — the toggle is never even consulted for this task.
    const getDistillConfig = vi.spyOn(ipc, "getDistillConfig");
    vi.spyOn(ipc, "readFile").mockResolvedValue({ raw: PROFILE_MD } as never);
    let seenPrompt = "";
    vi.spyOn(ipc, "claudeRun").mockImplementation(async (prompt: string) => {
      seenPrompt = prompt;
      return { stdout: "ingested", stderr: "", status: 0 };
    });

    await complete({
      task: "ingest",
      cwd: VAULT,
      messages: [{ role: "user", content: "ingest raw/foo.txt" }],
    });

    expect(getDistillConfig).not.toHaveBeenCalled();
    expect(seenPrompt).not.toContain("User profile:");
  });
});

// Decisions 1 and 3 of the 2026-10-02 machine-session spec tell myco's own CLI
// runs apart by how the prompt opens (mycoPromptHeads.json; each sender's side
// is pinned in mycoPromptHeads.test.ts). So whatever complete() adds to a CLI
// prompt, retrieval or the profile paragraph, must come after the sender's
// first message. task:"query" is only ever sent with a system message (Ask),
// so its user-only shape is left out.
describe("complete() CLI prompt opens with the sender's first message", () => {
  const PROFILE_MD = "## Role\nBackend engineer\n\n## Interests\n- rust\n";
  const cases = (["anthropic-cli", "gemini-cli", "codex-cli"] as const).flatMap((provider) =>
    (["query", "generate", "ingest"] as const).flatMap((task) =>
      [true, false].flatMap((profile) =>
        [true, false]
          .filter((system) => system || task !== "query")
          .map((system) => ({ provider, task, profile, system })),
      ),
    ),
  );

  it.each(cases)(
    "$provider $task profile=$profile system=$system",
    async ({ provider, task, profile, system }) => {
      vi.restoreAllMocks();
    mockCapturedRoles();
    vi.spyOn(ipc, "agentVaultSession").mockResolvedValue({ vaultPath: VAULT, openingToken: "synthetic-opening" });
      vi.spyOn(ipc, "getSettings").mockResolvedValue({
        query_provider: provider,
        query_model: "",
        ingest_provider: provider,
        ingest_model: "",
        model_roles: selectedRolesFixture({ ask: { providerId: provider, modelId: "synthetic-explicit" }, compilation: { providerId: provider, modelId: "synthetic-explicit" }, organization: { providerId: provider, modelId: "synthetic-explicit" } }),
      } as never);
      vi.spyOn(ipc, "getDistillConfig").mockResolvedValue({ profile_injection: profile } as never);
      vi.spyOn(ipc, "readFile").mockResolvedValue({ raw: PROFILE_MD } as never);
      vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
        indexed_pages: 51,
        model: CURRENT_INDEX_MODEL,
      });
      vi.spyOn(ipc, "semanticSearch").mockResolvedValue(found([
        { page: "wiki/a.md", stem: "a", section: 0, text: "a body", score: 0.9, similarity: 0.7 },
      ]));
      const ok = { stdout: "done", stderr: "", status: 0 };
      const claudeRun = vi.spyOn(ipc, "claudeRun").mockResolvedValue(ok);
      const agentRun = vi.spyOn(ipc, "agentRun").mockResolvedValue(ok);

      const first = system ? "You are myco's digest writer. Write it." : "Plan the ingest.";
      await complete({
        task,
        cwd: VAULT,
        messages: [
          ...(system ? [{ role: "system" as const, content: first }] : []),
          { role: "user", content: system ? "the day's logs" : first },
        ],
        // Ask passes onStage, which turns retrieval on.
        onStage: () => undefined,
      });

      const prompt =
        provider === "anthropic-cli" ? claudeRun.mock.calls[0][0] : agentRun.mock.calls[0][2];
      expect(prompt.startsWith(first)).toBe(true);
      // The additions did happen, so it is their place that is checked.
      if (task === "query") expect(prompt).toContain("Relevant wiki context");
      if (task === "query" && profile) expect(prompt).toContain("User profile:");
    },
  );
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

describe("retrieveChunks", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockCapturedRoles();
    vi.spyOn(ipc, "agentVaultSession").mockResolvedValue({ vaultPath: VAULT, openingToken: "synthetic-opening" });
  });

  const lexicalStatuses = [
    { indexed_pages: 0, model: "" },
    { indexed_pages: 10, model: "builtin-local:gemma-3-1b" },
  ];

  it.each(lexicalStatuses)("searches verified lexical evidence with dense status %j", async (status) => {
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue(status);
    const hit: ScoredChunk = { page: "sessions/id.md", stem: "id", section: 0, text: "SYN-4719 was accepted.", score: 0.02, similarity: null, exact_match: true };
    const search = vi.spyOn(ipc, "semanticSearch").mockResolvedValue(found([hit]));
    const retrieving = vi.fn();
    const range = { start: "2026-08-21", end: "2026-08-21" };
    const weights = { note: 1, map: 1, digest: 1, rollup: 1, session: 1, source: 1 };
    const r = await retrieveChunks("SYN-4719", 6, retrieving, range, "sessions", weights, ["sessions/id.md"]);
    expect(search).toHaveBeenCalledWith("SYN-4719", 6, "builtin-local", BUILTIN_EMBED_MODEL, range, "sessions", weights, ["sessions/id.md"]);
    expect(retrieving).toHaveBeenCalledTimes(1);
    expect(r.hits).toEqual([hit]);
    expect(r.indexedPages).toBe(status.indexed_pages);
    expect(r.stale).toBe(false);
    expect(r.retrievalFailed).toBe(false);
  });

  it.each(lexicalStatuses)("rejects unverified lexical and unavailable dense evidence with status %j", async (status) => {
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue(status);
    const search = vi.spyOn(ipc, "semanticSearch").mockResolvedValue(found([
      { page: "wiki/noise.md", stem: "noise", section: 0, text: "A generic idea.", score: 0.02, similarity: null, exact_match: false },
      { page: "wiki/retired.md", stem: "retired", section: 0, text: "Unverified old dense result.", score: 0.01, similarity: 0.9, exact_match: false },
    ]));
    const r = await retrieveChunks("SYN-4719");
    expect(search).toHaveBeenCalledTimes(1);
    expect(r.hits).toEqual([]);
    expect(r.nearMisses.map((hit) => hit.page)).toEqual(["wiki/noise.md", "wiki/retired.md"]);
    expect(r.stale).toBe(status.indexed_pages > 0);
    expect(r.retrievalFailed).toBe(false);
  });

  it.each(lexicalStatuses)("reports lexical search errors with dense status %j", async (status) => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue(status);
    vi.spyOn(ipc, "semanticSearch").mockRejectedValue(new Error("lexical backend unavailable"));
    const r = await retrieveChunks("SYN-4719");
    expect(r.retrievalFailed).toBe(true);
    expect(r.stale).toBe(false);
    expect(r.hits).toEqual([]);
    expect(warn).toHaveBeenCalledWith("retrieve_chunks.semantic_search_failed", { code: "semantic_search_failed" });
  });

  it("reports a status IPC failure without pretending to search", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    vi.spyOn(ipc, "embeddingsStatus").mockRejectedValue(new Error("status unavailable"));
    const search = vi.spyOn(ipc, "semanticSearch").mockResolvedValue(found([]));
    const retrieving = vi.fn();
    const r = await retrieveChunks("SYN-4719", 12, retrieving);
    expect(search).not.toHaveBeenCalled();
    expect(retrieving).not.toHaveBeenCalled();
    expect(r.retrievalFailed).toBe(true);
    expect(r.stale).toBe(false);
    expect(warn).toHaveBeenCalledWith("retrieve_chunks.embeddings_status_failed", { code: "embeddings_status_failed" });
  });

  it("returns hits from a healthy index", async () => {
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 10,
      model: `builtin-local:${BUILTIN_EMBED_MODEL}`,
    });
    vi.spyOn(ipc, "semanticSearch").mockResolvedValue(found([
      { page: "wiki/bpe.md", stem: "bpe", section: 0, text: "BPE merges pairs.", score: 0.9, similarity: 0.7 },
    ]));
    const r = await retrieveChunks("what is bpe", 12);
    expect(r.hits).toHaveLength(1);
    expect(r.stale).toBe(false);
    expect(r.retrievalFailed).toBe(false);
  });

  it("flags a stale index only after lexical search has no accepted evidence", async () => {
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 10,
      model: "builtin-local:gemma-3-1b", // pre-swap model id
    });
    const search = vi.spyOn(ipc, "semanticSearch").mockResolvedValue(found([]));
    const r = await retrieveChunks("q");
    expect(r.stale).toBe(true);
    expect(r.hits).toEqual([]);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("flags retrievalFailed when semantic_search rejects", async () => {
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 10,
      model: `builtin-local:${BUILTIN_EMBED_MODEL}`,
    });
    vi.spyOn(ipc, "semanticSearch").mockRejectedValue(new Error("ipc down"));
    const r = await retrieveChunks("q");
    expect(r.retrievalFailed).toBe(true);
    expect(r.hits).toEqual([]);
  });

  it("returns empty (not failed) for a never-indexed vault", async () => {
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 0,
      model: "",
    });
    vi.spyOn(ipc, "semanticSearch").mockResolvedValue(found([]));
    const r = await retrieveChunks("q");
    expect(r).toEqual({
      hits: [],
      nearMisses: [],
      floor: RELEVANCE_FLOOR,
      indexedPages: 0,
      stale: false,
      retrievalFailed: false,
    });
  });

  it("drops hits below the measured relevance floor", async () => {
    // Retrieval always returns top-k, so an off-vault question used to be
    // answered with the least-bad chunks in the vault at full confidence. The
    // floor is what makes "nothing here answers this" expressible.
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 10,
      model: `builtin-local:${BUILTIN_EMBED_MODEL}`,
    });
    vi.spyOn(ipc, "semanticSearch").mockResolvedValue(found([
      { page: "wiki/a.md", stem: "a", section: 0, text: "strong", score: 0.9, similarity: 0.62 },
      { page: "wiki/b.md", stem: "b", section: 0, text: "borderline", score: 0.8, similarity: RELEVANCE_FLOOR },
      {
        page: "wiki/c.md",
        stem: "c",
        section: 0,
        text: "weak",
        score: 0.7,
        similarity: RELEVANCE_FLOOR - 0.01,
      },
    ]));
    const r = await retrieveChunks("q");
    expect(r.hits.map((h) => h.stem)).toEqual(["a", "b"]); // floor is inclusive
    expect(r.retrievalFailed).toBe(false);
    // The rejected hit is kept as a near-miss WITH its cosine, so the
    // abstention card can place it against the floor.
    expect(r.nearMisses).toEqual([
      { page: "wiki/c.md", tier: "note", score_final: 0.7, similarity: RELEVANCE_FLOOR - 0.01 },
    ]);
    expect(r.floor).toBe(RELEVANCE_FLOOR);
    expect(r.indexedPages).toBe(10);
  });

  it("merges the backend's below_floor with the hits it rejects itself", async () => {
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 10,
      model: `builtin-local:${BUILTIN_EMBED_MODEL}`,
    });
    vi.spyOn(ipc, "semanticSearch").mockResolvedValue({
      hits: [
        { page: "wiki/a.md", stem: "a", section: 0, text: "weak", score: 0.9, similarity: 0.3 },
      ],
      // A backend applying a stricter floor than the measured constant wins.
      floor: 0.5,
      below_floor: [{ page: "sessions/s.md", tier: "session", score_final: 0.4 }],
    });
    const r = await retrieveChunks("q");
    expect(r.hits).toEqual([]);
    expect(r.floor).toBe(0.5);
    expect(r.nearMisses.map((m) => m.page)).toEqual(["sessions/s.md", "wiki/a.md"]);
  });

  it("degrades to no server-side rejects when the backend returns a bare list", async () => {
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 10,
      model: `builtin-local:${BUILTIN_EMBED_MODEL}`,
    });
    vi.spyOn(ipc, "semanticSearch").mockResolvedValue([
      { page: "wiki/a.md", stem: "a", section: 0, text: "strong", score: 0.9, similarity: 0.7 },
    ] as unknown as Awaited<ReturnType<typeof ipc.semanticSearch>>);
    const r = await retrieveChunks("q");
    expect(r.hits.map((h) => h.stem)).toEqual(["a"]);
    expect(r.nearMisses).toEqual([]);
    expect(r.floor).toBe(RELEVANCE_FLOOR);
  });

  it("threads scope, tier weights and note paths through to semantic_search", async () => {
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 10,
      model: `builtin-local:${BUILTIN_EMBED_MODEL}`,
    });
    const search = vi.spyOn(ipc, "semanticSearch").mockResolvedValue(found([]));
    const weights = { note: 1, map: 1, digest: 1, rollup: 1, session: 1, source: 1 };
    await retrieveChunks("q", 12, undefined, undefined, "sessions", weights, ["wiki/a.md"]);
    expect(search).toHaveBeenCalledWith(
      "q",
      12,
      "builtin-local",
      BUILTIN_EMBED_MODEL,
      undefined,
      "sessions",
      weights,
      ["wiki/a.md"],
    );
  });

  it("returns nothing for an off-vault question instead of the least-bad chunks", async () => {
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 10,
      model: `builtin-local:${BUILTIN_EMBED_MODEL}`,
    });
    // Cosines in the measured off-corpus range (0.305–0.491).
    vi.spyOn(ipc, "semanticSearch").mockResolvedValue(found([
      { page: "wiki/a.md", stem: "a", section: 0, text: "unrelated", score: 0.9, similarity: 0.41 },
      { page: "wiki/b.md", stem: "b", section: 0, text: "unrelated", score: 0.8, similarity: 0.33 },
    ]));
    const r = await retrieveChunks("김치찌개 레시피");
    expect(r.hits).toEqual([]);
    // Not a failure and not a stale index — the vault genuinely has no answer.
    expect(r.stale).toBe(false);
    expect(r.retrievalFailed).toBe(false);
  });

  it("keeps a verified exact lexical hit without a dense cosine", async () => {
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({
      indexed_pages: 10,
      model: `builtin-local:${BUILTIN_EMBED_MODEL}`,
    });
    vi.spyOn(ipc, "semanticSearch").mockResolvedValue(found([
      { page: "wiki/bpe.md", stem: "bpe", section: 0, text: "BPE", score: 0.9, similarity: null, exact_match: true },
    ]));
    const r = await retrieveChunks("BPE");
    expect(r.hits.map((h) => h.stem)).toEqual(["bpe"]);
  });

  it("rejects an unverified lexical coincidence and accepts a low-cosine exact ID", async () => {
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({ indexed_pages: 10, model: CURRENT_INDEX_MODEL });
    vi.spyOn(ipc, "semanticSearch").mockResolvedValue(found([
      { page: "wiki/noise.md", stem: "noise", section: 0, text: "ID", score: 0.02, similarity: null },
      { page: "sessions/id.md", stem: "id", section: 0, text: "SYN-4719", score: 0.015, similarity: 0.31, exact_match: true },
    ]));
    const r = await retrieveChunks("SYN-4719");
    expect(r.hits.map((h) => h.page)).toEqual(["sessions/id.md"]);
    expect(r.nearMisses.map((h) => h.page)).toEqual(["wiki/noise.md"]);
  });
});

describe("roleFor", () => {
  const settings = {
    query_provider: "builtin-local",
    query_model: "extractive-retrieval",
    query_effort: "low",
    ingest_provider: "anthropic-cli",
    ingest_model: "haiku",
    ingest_effort: "medium",
    model_roles: selectedRolesFixture({ ask: { providerId: "builtin-local", modelId: "extractive-retrieval", effort: "low" }, compilation: { providerId: "anthropic-cli", modelId: "haiku", effort: "medium" } }),
  } as unknown as Parameters<typeof roleFor>[1];

  it("leaves interactive Ask on the query role even when it cannot generate", () => {
    // Extractive Ask is a deliberate setting, not a degraded state.
    expect(roleFor("query", settings).provider).toBe("builtin-local");
  });

  it("keeps organization local when Ask is quote-only and compilation explicitly external", () => {
    const r = roleFor("generate", settings);
    expect(r.provider).toBe("builtin-local");
    expect(r.model).toBe(BUILTIN_CHAT_MODEL);
    expect(r.effort).toBe("(default)");
  });

  it("does not inherit a changed legacy external Ask display value for organization", () => {
    const s = { ...settings, query_provider: "anthropic-api", query_model: "sonnet" };
    expect(roleFor("generate", s).provider).toBe("builtin-local");
    expect(roleFor("generate", s).model).toBe(BUILTIN_CHAT_MODEL);
  });

  it("uses only an explicit organization choice and rejects missing native role settings", () => {
    const s = { ...settings, model_roles: selectedRolesFixture({ organization: { providerId: "anthropic-api", modelId: "synthetic-selected" } }) };
    expect(roleFor("generate", s).provider).toBe("anthropic-api");
    expect(roleFor("generate", s).model).toBe("synthetic-selected");
    expect(() => roleFor("generate", { ...settings, model_roles: undefined })).toThrow("native feature selections are unavailable");
  });

  it("ingest always takes the ingest role", () => {
    expect(roleFor("ingest", settings).provider).toBe("anthropic-cli");
  });

  it("canGenerate: only the extractive built-in (and unset) cannot", () => {
    expect(canGenerate("builtin-local")).toBe(false);
    expect(canGenerate("")).toBe(false);
    expect(canGenerate("ollama")).toBe(true);
    expect(canGenerate("anthropic-cli")).toBe(true);
  });
});

describe("retrieveChunks private failure logging", () => {
  beforeEach(() => vi.restoreAllMocks());

  it.each([
    ["embeddings_status", "error"], ["embeddings_status", "string"], ["embeddings_status", "object"],
    ["semantic_search", "error"], ["semantic_search", "string"], ["semantic_search", "object"],
  ] as const)("keeps %s %s failure observable without exception payload or coercion", async (stage, kind) => {
    const privateDetail = `SYN_PRIVATE_DETAIL_${stage}_${kind}`;
    const coerce = vi.fn(() => { throw new Error(privateDetail); });
    const serialize = vi.fn(() => { throw new Error(privateDetail); });
    const rejection = kind === "error" ? new Error(privateDetail)
      : kind === "string" ? privateDetail
        : { detail: privateDetail, toString: coerce, toJSON: serialize };
    // Exercise the real JSON logger; only the console sink and IPC are mocked.
    const output = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const status = vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({ indexed_pages: 10, model: CURRENT_INDEX_MODEL });
    const search = vi.spyOn(ipc, "semanticSearch").mockResolvedValue(found([]));
    if (stage === "embeddings_status") status.mockRejectedValue(rejection);
    else search.mockRejectedValue(rejection);
    const retrieving = vi.fn();
    const result = await retrieveChunks("SYN_PUBLIC_QUERY", 12, retrieving);

    expect(result).toEqual({ hits: [], nearMisses: [], floor: RELEVANCE_FLOOR,
      indexedPages: null, stale: false, retrievalFailed: true });
    expect(status).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledTimes(stage === "embeddings_status" ? 0 : 1);
    expect(retrieving).toHaveBeenCalledTimes(stage === "embeddings_status" ? 0 : 1);
    expect(coerce).not.toHaveBeenCalled();
    expect(serialize).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledTimes(1);
    const line: unknown = output.mock.calls[0][0];
    expect(typeof line).toBe("string");
    expect(line).not.toContain(privateDetail);
    expect(line).not.toContain("SYN_PUBLIC_QUERY");
    expect(JSON.parse(String(line))).toEqual({ ts: expect.any(String), level: "warn",
      event: `retrieve_chunks.${stage}_failed`, code: `${stage}_failed` });
  });

  it.each([false, true])("keeps a healthy %s result free of failure events", async (hasHit) => {
    const output = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({ indexed_pages: 10, model: CURRENT_INDEX_MODEL });
    const hit: ScoredChunk = { page: "wiki/synthetic.md", stem: "synthetic", section: 0,
      text: "SYN_PUBLIC_EVIDENCE", score: 0.9, similarity: 0.9, exact_match: true };
    const search = vi.spyOn(ipc, "semanticSearch").mockResolvedValue(found(hasHit ? [hit] : []));
    const retrieving = vi.fn();
    const result = await retrieveChunks("SYN_PUBLIC_QUERY", 12, retrieving);
    expect(result.hits).toEqual(hasHit ? [hit] : []);
    expect(result.indexedPages).toBe(10);
    expect(result.retrievalFailed).toBe(false);
    expect(result.stale).toBe(false);
    expect(search).toHaveBeenCalledTimes(1);
    expect(retrieving).toHaveBeenCalledTimes(1);
    expect(output).not.toHaveBeenCalled();
  });
});

// ■ on the Ask page (UX S36): a question stopped while retrieval ran must not
// go on to the model — a paid call nobody will read.
describe("complete() stopped", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockCapturedRoles();
    vi.spyOn(ipc, "agentVaultSession").mockResolvedValue({ vaultPath: VAULT, openingToken: "synthetic-opening" });
    vi.spyOn(ipc, "getDistillConfig").mockRejectedValue(new Error("no config"));
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({ indexed_pages: 0, model: "" });
    vi.spyOn(ipc, "semanticSearch").mockResolvedValue(found([]));
    vi.spyOn(ipc, "readVaultContext").mockResolvedValue("");
  });
  const stopped = (): AbortSignal => {
    const c = new AbortController();
    c.abort();
    return c.signal;
  };
  const ask = (signal: AbortSignal) =>
    complete({
      task: "query",
      cwd: VAULT,
      messages: [{ role: "user", content: "what is attention?" }],
      onStage: () => undefined,
      signal,
    });

  it("never calls an HTTP provider (Ollama)", async () => {
    vi.spyOn(ipc, "getSettings").mockResolvedValue({
      query_provider: "ollama",
      query_model: "llama3",
      model_roles: selectedRolesFixture({ ask: { providerId: "ollama", modelId: "llama3" } }),
    } as never);
    const chat = vi.spyOn(ipc, "chatComplete");
    await expect(ask(stopped())).rejects.toThrow();
    expect(chat).not.toHaveBeenCalled();
  });

  it("never runs a CLI provider", async () => {
    vi.spyOn(ipc, "getSettings").mockResolvedValue({
      query_provider: "anthropic-cli",
      query_model: "sonnet",
      model_roles: selectedRolesFixture({ ask: { providerId: "anthropic-cli", modelId: "sonnet" } }),
    } as never);
    const run = vi.spyOn(ipc, "claudeRun");
    const stream = vi.spyOn(ipc, "claudeRunStream");
    await expect(ask(stopped())).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });

  // A stop that only drops the answer would leave `claude` running on the
  // user's quota behind a card that says it stopped.
  it("■ during a Claude Code run kills that run", async () => {
    vi.spyOn(ipc, "getSettings").mockResolvedValue({
      query_provider: "anthropic-cli",
      query_model: "sonnet",
      model_roles: selectedRolesFixture({ ask: { providerId: "anthropic-cli", modelId: "sonnet" } }),
    } as never);
    const stream = vi.spyOn(ipc, "claudeRunStream").mockImplementation(() => new Promise(() => undefined));
    const cancel = vi.spyOn(ipc, "claudeCancel").mockResolvedValue(true);
    const c = new AbortController();
    void ask(c.signal).catch(() => undefined);
    await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(1));
    expect(cancel).not.toHaveBeenCalled();
    c.abort();
    expect(cancel).toHaveBeenCalledWith(stream.mock.calls[0][0]);
  });

  it("a finished Claude Code run is not cancelled by a later stop", async () => {
    vi.spyOn(ipc, "getSettings").mockResolvedValue({
      query_provider: "anthropic-cli",
      query_model: "sonnet",
      model_roles: selectedRolesFixture({ ask: { providerId: "anthropic-cli", modelId: "sonnet" } }),
    } as never);
    vi.spyOn(ipc, "claudeRunStream").mockResolvedValue({ stdout: "an answer", stderr: "", status: 0 });
    const cancel = vi.spyOn(ipc, "claudeCancel").mockResolvedValue(true);
    const c = new AbortController();
    await expect(ask(c.signal)).resolves.toBe("an answer");
    c.abort();
    expect(cancel).not.toHaveBeenCalled();
  });
});
