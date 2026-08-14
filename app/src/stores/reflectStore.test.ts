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

import { useReflectStore, parseSuggestions } from "./reflectStore";
import { useVaultStore } from "./vaultStore";

describe("useReflectStore.runReflect", () => {
  beforeEach(() => {
    complete.mockReset();
    getActiveModel.mockReset();
    useVaultStore.setState({ currentVault: { path: "/v", name: "v" } });
    useReflectStore.setState({
      stage: "idle",
      suggestions: [],
      report: null,
      startedAt: null,
      finishedAt: null,
      seen: true,
    });
  });

  it("builtin-local provider: blocked stage, no complete() call, no doomed model load", async () => {
    getActiveModel.mockResolvedValue({ provider: "builtin-local", model: "" });

    await useReflectStore.getState().runReflect();

    expect(complete).not.toHaveBeenCalled();
    const s = useReflectStore.getState();
    expect(s.stage).toBe("blocked");
    expect(s.report).toBeNull();
    expect(s.suggestions).toEqual([]);
    expect(s.seen).toBe(false);
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

  it("connected provider that resolves: done stage with parsed suggestions", async () => {
    getActiveModel.mockResolvedValue({ provider: "anthropic-cli", model: "sonnet" });
    complete.mockResolvedValue("- link orphan-a from index\n- revisit stale-b");

    await useReflectStore.getState().runReflect();

    const s = useReflectStore.getState();
    expect(s.stage).toBe("done");
    expect(s.suggestions).toEqual(["link orphan-a from index", "revisit stale-b"]);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("does nothing without an open vault", async () => {
    useVaultStore.setState({ currentVault: null });
    await useReflectStore.getState().runReflect();
    expect(getActiveModel).not.toHaveBeenCalled();
    expect(useReflectStore.getState().stage).toBe("idle");
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
