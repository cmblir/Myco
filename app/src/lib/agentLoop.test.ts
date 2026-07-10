import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgentToolCall, AgentTurn } from "./ipc";

const agentChat = vi.fn();
const agentToolCall = vi.fn();
vi.mock("./ipc", () => ({
  ipc: {
    agentChat: (...a: unknown[]) => agentChat(...a),
    agentToolCall: (...a: unknown[]) => agentToolCall(...a),
  },
}));
// Neutralize the budget guard so tests exercise loop logic only.
vi.mock("./budget", () => ({
  overBudget: () => false,
  recordUsage: vi.fn(),
  getBudgetThreshold: () => 20,
}));

import { runAgent } from "./agentLoop";
import type { AgentToolDescriptor } from "./ipc";

const TOOLS: AgentToolDescriptor[] = [
  { name: "search_vault", description: "", input_schema: {}, write: false },
  { name: "create_page", description: "", input_schema: {}, write: true },
];

const turn = (
  text: string,
  tool_calls: AgentToolCall[] = [],
): AgentTurn => ({ text, tool_calls, usage: null, stop: "" });

beforeEach(() => {
  agentChat.mockReset();
  agentToolCall.mockReset();
});

describe("runAgent", () => {
  it("returns immediately when the model answers with no tools", async () => {
    agentChat.mockResolvedValueOnce(turn("42"));
    const res = await runAgent({
      provider: "anthropic-api",
      model: "m",
      system: "s",
      question: "q",
      tools: TOOLS,
      allowWrite: false,
    });
    expect(res.answer).toBe("42");
    expect(res.steps).toHaveLength(0);
    expect(res.stoppedAtLimit).toBe(false);
  });

  it("dispatches a tool call then returns the final answer", async () => {
    agentChat
      .mockResolvedValueOnce(
        turn("", [{ id: "c1", name: "search_vault", input: { query: "x" } }]),
      )
      .mockResolvedValueOnce(turn("done"));
    agentToolCall.mockResolvedValueOnce({ hits: [{ path: "wiki/a.md" }] });

    const steps: string[] = [];
    const res = await runAgent({
      provider: "anthropic-api",
      model: "m",
      system: "s",
      question: "find x",
      tools: TOOLS,
      allowWrite: false,
      onStep: (s) => steps.push(s.tool),
    });
    expect(agentToolCall).toHaveBeenCalledWith("search_vault", { query: "x" }, false);
    expect(res.steps[0].result).toContain("wiki/a.md");
    expect(res.answer).toBe("done");
    expect(steps).toEqual(["search_vault"]);
  });

  it("hides write tools when allowWrite is false", async () => {
    agentChat.mockResolvedValueOnce(turn("ok"));
    await runAgent({
      provider: "anthropic-api",
      model: "m",
      system: "s",
      question: "q",
      tools: TOOLS,
      allowWrite: false,
    });
    const sentTools = agentChat.mock.calls[0][0].tools.map(
      (t: AgentToolDescriptor) => t.name,
    );
    expect(sentTools).toEqual(["search_vault"]);
  });

  it("gates a write behind confirmation; declining feeds a decline result", async () => {
    agentChat
      .mockResolvedValueOnce(
        turn("", [{ id: "w1", name: "create_page", input: { path: "wiki/n.md", content: "x" } }]),
      )
      .mockResolvedValueOnce(turn("stopped"));
    const confirmWrite = vi.fn().mockResolvedValue(false);

    const res = await runAgent({
      provider: "anthropic-api",
      model: "m",
      system: "s",
      question: "make a page",
      tools: TOOLS,
      allowWrite: true,
      confirmWrite,
    });
    expect(confirmWrite).toHaveBeenCalledOnce();
    expect(agentToolCall).not.toHaveBeenCalled(); // declined ⇒ never dispatched
    expect(res.steps[0].confirmed).toBe(false);
    expect(res.steps[0].result).toMatch(/declined/);
  });

  it("dispatches a confirmed write with allow_write=true", async () => {
    agentChat
      .mockResolvedValueOnce(
        turn("", [{ id: "w1", name: "create_page", input: { path: "wiki/n.md", content: "hi" } }]),
      )
      .mockResolvedValueOnce(turn("created"));
    agentToolCall.mockResolvedValueOnce({ written: "wiki/n.md" });

    const res = await runAgent({
      provider: "anthropic-api",
      model: "m",
      system: "s",
      question: "make a page",
      tools: TOOLS,
      allowWrite: true,
      confirmWrite: () => Promise.resolve(true),
    });
    expect(agentToolCall).toHaveBeenCalledWith(
      "create_page",
      { path: "wiki/n.md", content: "hi" },
      true,
    );
    expect(res.steps[0].confirmed).toBe(true);
    expect(res.answer).toBe("created");
  });

  it("feeds tool errors back instead of throwing", async () => {
    agentChat
      .mockResolvedValueOnce(
        turn("", [{ id: "c1", name: "search_vault", input: {} }]),
      )
      .mockResolvedValueOnce(turn("recovered"));
    agentToolCall.mockRejectedValueOnce(new Error("boom"));

    const res = await runAgent({
      provider: "anthropic-api",
      model: "m",
      system: "s",
      question: "q",
      tools: TOOLS,
      allowWrite: false,
    });
    expect(res.steps[0].error).toContain("boom");
    expect(res.answer).toBe("recovered");
  });

  it("stops at the iteration cap with a partial answer", async () => {
    // Model keeps calling tools forever; cap forces a final no-tools call.
    agentChat.mockImplementation((req: { tools: unknown[] }) =>
      Promise.resolve(
        req.tools.length === 0
          ? turn("partial")
          : turn("", [{ id: "c", name: "search_vault", input: {} }]),
      ),
    );
    agentToolCall.mockResolvedValue({ hits: [] });

    const res = await runAgent({
      provider: "anthropic-api",
      model: "m",
      system: "s",
      question: "q",
      tools: TOOLS,
      allowWrite: false,
      maxIterations: 2,
    });
    expect(res.stoppedAtLimit).toBe(true);
    expect(res.answer).toBe("partial");
  });

  it("aborts mid-run when the signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const res = await runAgent({
      provider: "anthropic-api",
      model: "m",
      system: "s",
      question: "q",
      tools: TOOLS,
      allowWrite: false,
      signal: ctrl.signal,
    });
    expect(agentChat).not.toHaveBeenCalled();
    expect(res.stoppedAtLimit).toBe(true);
  });
});
