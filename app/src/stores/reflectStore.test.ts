import { beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors distillStore.test.ts's mocking of "../lib/chat": only complete()
// (the LLM call) is stubbed. getActiveModel is stubbed alongside it so tests
// can drive which provider runReflect() sees before it decides whether to
// call complete() at all.
const complete = vi.fn();
const getActiveModel = vi.fn();
vi.mock("../lib/chat", () => ({
  complete: (...a: unknown[]) => complete(...a),
  getActiveModel: (...a: unknown[]) => getActiveModel(...a),
}));

// The extractive path never calls complete(); it reads the link graph and,
// past MAX_SUGGESTIONS candidates, ranks them with the bundled embedder.
const buildLinkGraph = vi.fn();
const embedLocalTexts = vi.fn();
vi.mock("../lib/ipc", () => ({
  ipc: {
    buildLinkGraph: (...a: unknown[]) => buildLinkGraph(...a),
    embedLocalTexts: (...a: unknown[]) => embedLocalTexts(...a),
  },
}));

import { useReflectStore, parseSuggestions, extractiveReflect } from "./reflectStore";
import { useVaultStore } from "./vaultStore";

describe("useReflectStore.runReflect", () => {
  beforeEach(() => {
    complete.mockReset();
    getActiveModel.mockReset();
    buildLinkGraph.mockReset();
    embedLocalTexts.mockReset();
    useVaultStore.setState({ currentVault: { path: "/v", name: "v" } });
    useReflectStore.setState({
      stage: "idle",
      mode: "llm",
      suggestions: [],
      report: null,
      startedAt: null,
      finishedAt: null,
      seen: true,
    });
  });

  it("builtin-local provider: extractive run — done stage, no complete() call", async () => {
    getActiveModel.mockResolvedValue({ provider: "builtin-local", model: "" });
    buildLinkGraph.mockResolvedValue({
      forward: { "/v/a.md": ["/v/b.md"], "/v/b.md": [] },
      backward: { "/v/b.md": ["/v/a.md"] },
      unresolved: { "/v/b.md": ["ghost"] },
      tags: {},
    });

    await useReflectStore.getState().runReflect();

    expect(complete).not.toHaveBeenCalled();
    const s = useReflectStore.getState();
    expect(s.stage).toBe("done");
    expect(s.mode).toBe("extractive");
    expect(s.suggestions).toEqual([
      "a.md: orphan — no other page links to it; add a [[wikilink]] from a related page.",
      "b.md: links to [[ghost]], which has no page — create it or fix the link.",
    ]);
    expect(s.seen).toBe(false);
    // Few candidates: no need to pay for the embed-model load.
    expect(embedLocalTexts).not.toHaveBeenCalled();
  });

  it("connected provider that rejects: error stage with the provider's message, no double prefix", async () => {
    getActiveModel.mockResolvedValue({ provider: "anthropic-cli", model: "sonnet" });
    complete.mockRejectedValue(new Error("rate limited by provider"));

    await useReflectStore.getState().runReflect();

    const s = useReflectStore.getState();
    expect(s.stage).toBe("error");
    expect(s.report).toBe("rate limited by provider");
    expect(s.report).not.toMatch(/ERROR:/);
    expect(s.report).not.toMatch(/Error: Error:/);
  });

  it("connected provider that resolves: done stage with parsed suggestions, llm mode", async () => {
    getActiveModel.mockResolvedValue({ provider: "anthropic-cli", model: "sonnet" });
    complete.mockResolvedValue("- link orphan-a from index\n- revisit stale-b");

    await useReflectStore.getState().runReflect();

    const s = useReflectStore.getState();
    expect(s.stage).toBe("done");
    expect(s.mode).toBe("llm");
    expect(s.suggestions).toEqual(["link orphan-a from index", "revisit stale-b"]);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(buildLinkGraph).not.toHaveBeenCalled();
  });

  it("does nothing without an open vault", async () => {
    useVaultStore.setState({ currentVault: null });
    await useReflectStore.getState().runReflect();
    expect(getActiveModel).not.toHaveBeenCalled();
    expect(useReflectStore.getState().stage).toBe("idle");
  });
});

describe("extractiveReflect", () => {
  beforeEach(() => {
    buildLinkGraph.mockReset();
    embedLocalTexts.mockReset();
  });

  it("skips orphan-exempt root pages", async () => {
    buildLinkGraph.mockResolvedValue({
      forward: { "/v/index.md": [], "/v/Home.md": [], "/v/note.md": [] },
      backward: {},
      unresolved: {},
      tags: {},
    });

    expect(await extractiveReflect("/v")).toEqual([
      "note.md: orphan — no other page links to it; add a [[wikilink]] from a related page.",
    ]);
  });

  it("past 8 candidates: embeds once and MMR-selects a deterministic top 8", async () => {
    // 10 orphans → 10 candidates. Fixture embeddings: near-identical pairs so
    // MMR must diversify, with i=0 closest to the centroid direction.
    const forward: Record<string, string[]> = {};
    for (let i = 0; i < 10; i++) forward[`/v/p${String(i).padStart(2, "0")}.md`] = [];
    buildLinkGraph.mockResolvedValue({ forward, backward: {}, unresolved: {}, tags: {} });
    const vectors = Array.from({ length: 10 }, (_, i) => [
      Math.cos(i * 0.3),
      Math.sin(i * 0.3),
    ]);
    embedLocalTexts.mockResolvedValue(vectors);

    const first = await extractiveReflect("/v");
    const second = await extractiveReflect("/v");

    expect(first).toHaveLength(8);
    expect(embedLocalTexts).toHaveBeenCalledTimes(2); // once per run
    expect(embedLocalTexts.mock.calls[0][0]).toHaveLength(10);
    // Deterministic: same inputs, same picks, same order.
    expect(second).toEqual(first);
    for (const s of first) expect(s).toMatch(/^p\d\d\.md: orphan/);
  });
});

describe("parseSuggestions", () => {
  it("extracts bullet lines", () => {
    expect(parseSuggestions("- a\n- b\n* c\n1. d")).toEqual(["a", "b", "c", "d"]);
  });

  it("falls back to non-empty lines when nothing looks like a bullet", () => {
    expect(parseSuggestions("just prose\n\nmore prose")).toEqual([
      "just prose",
      "more prose",
    ]);
  });
});
