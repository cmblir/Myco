import { afterEach, describe, expect, it, vi } from "vitest";
import { isTrayActionEnvelope, isTrayActionRequest, requestAgendaAction, type TrayActionResult } from "./notchAction";

afterEach(() => vi.useRealTimers());
describe("notch action acknowledgements", () => {
  it("rejects malformed action envelopes at the window boundary", () => {
    for (const payload of [null, undefined, [], {}, { action: "harvest-run" }, { action: 1, requestId: "r" }, { action: "", requestId: "r" }]) expect(isTrayActionRequest(payload)).toBe(false);
    expect(isTrayActionRequest({ action: "harvest-run", requestId: "synthetic-request" })).toBe(true);
  });
  it("accepts a scoped native menu envelope without an acknowledgement id", () => {
    expect(isTrayActionEnvelope({ action: "distill", scope: { vaultPath: "/synthetic", vaultToken: "open-1" } })).toBe(true);
    expect(isTrayActionRequest({ action: "distill", scope: { vaultPath: "/synthetic", vaultToken: "open-1" } })).toBe(false);
    for (const scope of [null, {}, { vaultPath: "/synthetic" }, { vaultPath: "/synthetic", vaultToken: "" }, { vaultPath: 1, vaultToken: "open-1" }]) {
      expect(isTrayActionEnvelope({ action: "distill", scope })).toBe(false);
    }
  });
  it("sends the scope captured before the asynchronous listener subscription", async () => {
    const scope = { vaultPath: "/synthetic-a", vaultToken: "open-a" };
    let receive!: (reply: TrayActionResult) => void;
    const emit = vi.fn(async (request) => receive({ requestId: request.requestId, ok: true }));
    expect(await requestAgendaAction("harvest-run", {
      listen: async (cb) => { receive = cb; return () => undefined; },
      emit,
    }, 100, scope)).toBe(true);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ action: "harvest-run", scope }));
  });
  it.each([true, false])("returns only the matching writer result (%s)", async (ok) => {
    let receive!: (reply: TrayActionResult) => void;
    const unlisten = vi.fn();
    let settled = false;
    const action = requestAgendaAction("links-accept-all", {
      listen: async (cb) => { receive = cb; return unlisten; },
      emit: async (request) => {
        receive({ requestId: "different-request", ok: true });
        await Promise.resolve();
        expect(settled).toBe(false);
        receive({ requestId: request.requestId, ok });
      },
    }).then((result) => { settled = true; return result; });
    expect(await action).toBe(ok);
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("keeps a lost request retryable and unsubscribes", async () => {
    vi.useFakeTimers();
    const unlisten = vi.fn();
    const action = requestAgendaAction("harvest-run", {
      listen: async () => unlisten,
      emit: async () => undefined,
    }, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await action).toBe(false);
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("cleans up when delivery itself fails", async () => {
    const unlisten = vi.fn();
    await expect(requestAgendaAction("harvest-run", {
      listen: async () => unlisten,
      emit: async () => { throw new Error("event unavailable"); },
    })).rejects.toThrow("event unavailable");
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
