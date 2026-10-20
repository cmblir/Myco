import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { ipc } from "./ipc";

describe("semantic search date boundary", () => {
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue({ hits: [], floor: 0.42, below_floor: [] });
    vi.stubEnv("TZ", "Asia/Seoul");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("sends viewer-local midnight bounds along with the displayed dates", async () => {
    await ipc.semanticSearch("synthetic decision", 12, "builtin-local", "e5-small-ko", { start: "2026-08-22", end: "2026-08-22" });
    expect(invoke).toHaveBeenCalledWith("semantic_search", expect.objectContaining({
      range: {
        start: "2026-08-22", end: "2026-08-22",
        startEpoch: Date.parse("2026-08-22T00:00:00+09:00") / 1000,
        endEpoch: Date.parse("2026-08-23T00:00:00+09:00") / 1000,
      },
    }));
  });

  it("does not invent a date window for an undated question", async () => {
    await ipc.semanticSearch("synthetic decision", 12, "builtin-local", "e5-small-ko");
    expect(invoke).toHaveBeenCalledWith("semantic_search", expect.objectContaining({ range: undefined }));
  });

  it("rejects an invalid calendar window before invoking native search", () => {
    expect(() => ipc.semanticSearch("synthetic decision", 12, "builtin-local", "e5-small-ko", { start: "2026-02-30", end: "2026-03-01" })).toThrow("invalid query date range");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("serializes local synthesis under the same vault, scope, note and date boundary", async () => {
    await ipc.localSynthesize({ requestId: "synthetic-request", expectedVault: "/synthetic", question: "Synthetic evidence",
      lang: "ko", scope: "sessions", paths: ["sessions/synthetic.md"], hits: [], range: { start: "2026-08-22", end: "2026-08-22" } });
    expect(invoke).toHaveBeenCalledWith("local_synthesize", { request: {
      requestId: "synthetic-request", expectedVault: "/synthetic", question: "Synthetic evidence", lang: "ko",
      scope: "sessions", paths: ["sessions/synthetic.md"], hits: [], range: {
        start: "2026-08-22", end: "2026-08-22",
        startEpoch: Date.parse("2026-08-22T00:00:00+09:00") / 1000,
        endEpoch: Date.parse("2026-08-23T00:00:00+09:00") / 1000,
      },
    } });
  });

  it("rejects invalid synthesis dates before any native inference", () => {
    expect(() => ipc.localSynthesize({ requestId: "synthetic-request", expectedVault: "/synthetic", question: "Synthetic evidence",
      lang: "ko", scope: "wiki", hits: [], range: { start: "2026-02-30", end: "2026-03-01" } })).toThrow("invalid query date range");
    expect(invoke).not.toHaveBeenCalled();
  });
});
