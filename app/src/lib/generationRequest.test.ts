import { describe, expect, it, vi } from "vitest";
import type { AskExecutionEvent } from "./askExecution";
import { traceGenerationRequest } from "./generationRequest";
import { log } from "./log";

describe("traceGenerationRequest", () => {
  it("keeps requested and reported aliases separate in immutable metadata snapshots", async () => {
    const requested = { providerId: "ollama", modelId: "selected-alias" };
    const events: AskExecutionEvent[] = [];
    const reply = { model: "reported-artifact" };
    let resolve!: (value: typeof reply) => void;
    const pending = traceGenerationRequest({ requested, purpose: "answer", onExecution: event => events.push(event),
      reportedIdentity: value => ({ modelId: value.model, source: "provider_response" }) },
    () => new Promise<typeof reply>(done => { resolve = done; }));
    requested.modelId = "changed-setting";
    resolve(reply);
    await expect(pending).resolves.toBe(reply);
    expect(events.map(event => event.state)).toEqual(["submitted", "response_received"]);
    expect(events[0].id).toBe(events[1].id);
    expect(events[1]).toMatchObject({ purpose: "answer", requested: { providerId: "ollama", modelId: "selected-alias" },
      identity: { modelId: "reported-artifact", source: "provider_response" } });
    expect(events[0].identity).toBeUndefined();
    expect(events.every(event => Object.isFrozen(event) && Object.isFrozen(event.requested))).toBe(true);
    expect(Object.isFrozen(events[1].identity)).toBe(true);
  });

  it.each([undefined, null, "", " ", 1, "bad\nmodel", "bad\u0000model", "bad\u0085model", "한".repeat(171)])(
    "omits malformed reported identity without rejecting the response: %j", async modelId => {
      const onExecution = vi.fn();
      await expect(traceGenerationRequest({ requested: { providerId: "ollama", modelId: "selected" }, purpose: "answer",
        onExecution, reportedIdentity: () => ({ modelId, source: "provider_response" }) }, async () => "answer"))
        .resolves.toBe("answer");
      expect(onExecution.mock.calls[1][0]).not.toHaveProperty("identity");
    },
  );

  it("accepts only the identity source belonging to the requested route", async () => {
    const onExecution = vi.fn();
    await traceGenerationRequest({ requested: { providerId: "builtin-local", modelId: "selected" }, purpose: "answer",
      onExecution, reportedIdentity: () => ({ modelId: "reported", source: "provider_response" }) }, async () => "answer");
    expect(onExecution.mock.calls[1][0]).not.toHaveProperty("identity");
  });

  it("does not call or record an already cancelled command", async () => {
    const controller = new AbortController();
    controller.abort();
    const onExecution = vi.fn();
    const request = vi.fn(async () => "answer");
    await expect(traceGenerationRequest({ requested: { providerId: "ollama", modelId: "selected" }, purpose: "answer",
      signal: controller.signal, onExecution }, request)).rejects.toThrow("stopped");
    expect(request).not.toHaveBeenCalled();
    expect(onExecution).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"])("records cancellation once and ignores a late %s", async outcome => {
    const controller = new AbortController();
    const events: AskExecutionEvent[] = [];
    let resolve!: (value: string) => void;
    let reject!: (error: Error) => void;
    const pending = traceGenerationRequest({ requested: { providerId: "ollama", modelId: "selected" }, purpose: "answer",
      signal: controller.signal, onExecution: event => events.push(event) },
    () => new Promise<string>((done, fail) => { resolve = done; reject = fail; }));
    controller.abort();
    if (outcome === "resolve") {
      resolve("late answer");
      await expect(pending).resolves.toBe("late answer");
    } else {
      reject(new Error("late rejection"));
      await expect(pending).rejects.toThrow("late rejection");
    }
    expect(events.map(event => event.state)).toEqual(["submitted", "cancelled"]);
  });

  it.each(["synchronous", "asynchronous"])("records a %s command failure without its private payload", async mode => {
    const onExecution = vi.fn();
    const error = new Error("PRIVATE-SYNTHETIC-PAYLOAD");
    await expect(traceGenerationRequest({ requested: { providerId: "codex-cli", modelId: "selected" },
      purpose: "answer", onExecution }, () => {
      if (mode === "synchronous") throw error;
      return Promise.reject(error);
    })).rejects.toBe(error);
    expect(onExecution.mock.calls.map(([event]) => event.state)).toEqual(["submitted", "failed"]);
    expect(JSON.stringify(onExecution.mock.calls)).not.toContain("PRIVATE-SYNTHETIC-PAYLOAD");
  });

  it("keeps the original response API when recording is absent", async () => {
    const identity = vi.fn();
    await expect(traceGenerationRequest({ requested: { providerId: "ollama", modelId: "selected" }, purpose: "answer",
      reportedIdentity: identity }, async () => "answer")).resolves.toBe("answer");
    expect(identity).not.toHaveBeenCalled();
  });

  it("consumes a native rejection after a submitted observer throws", async () => {
    const unhandled = vi.fn();
    const warning = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const events: AskExecutionEvent[] = [];
    let reject!: (error: Error) => void;
    const failure = new Error("synthetic native refusal");
    const request = vi.fn(() => new Promise<string>((_resolve, fail) => { reject = fail; }));
    process.on("unhandledRejection", unhandled);
    try {
      const pending = traceGenerationRequest({ requested: { providerId: "codex-cli", modelId: "selected" },
        purpose: "answer", onExecution: event => {
          events.push(event);
          if (event.state === "submitted") throw new Error("synthetic observer failure");
        } }, request);
      const rejected = expect(pending).rejects.toBe(failure);
      reject(failure);
      await rejected;
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(request).toHaveBeenCalledOnce();
      expect(events.map(event => event.state)).toEqual(["submitted", "failed"]);
      expect(unhandled).not.toHaveBeenCalled();
      expect(warning.mock.calls).toEqual([["generation.execution_observer_failed"]]);
    } finally {
      process.removeListener("unhandledRejection", unhandled);
      warning.mockRestore();
    }
  });
});
