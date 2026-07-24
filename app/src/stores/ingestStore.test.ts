// One ingest run at a time — the guard has to actually hold.
//
// startIngest reads `stage`, decides "not running", and only publishes
// "writing-raw" later. If anything awaits in between, a second caller reads the
// stale idle stage and starts a SECOND `claude` agent against the same vault:
// interleaved edits to the same wiki pages, doubled log.md entries, double token
// spend, and — because cancelIngest only knows the newest runId — an orphaned
// run the UI cannot stop.
//
// The window is not a timing fluke. `listen()` is async, so awaiting it always
// yields a microtask; two callers in the same tick both pass the guard however
// fast the IPC is. autoIngest.runInboxPass has two callers (the clip-saved
// event and the interval tick) that reach here through identical IPCs.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { listenMock } = vi.hoisted(() => ({
  listenMock: vi.fn().mockResolvedValue(() => undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

vi.mock("./vaultStore", () => ({
  useVaultStore: {
    getState: () => ({
      currentVault: { path: "/v", name: "v" },
      refreshTree: vi.fn().mockResolvedValue(undefined),
      refreshLinkGraph: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

vi.mock("../lib/chat", () => ({ complete: vi.fn().mockResolvedValue("done") }));
// Shaped like the real `log` object ({ info/warn/error }), not a bare
// function — persistRunTranscript's failure path calls `log.warn(...)`.
vi.mock("../lib/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ipc } from "../lib/ipc";
import { useIngestStore } from "./ingestStore";

describe("startIngest concurrency", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    listenMock.mockClear();
    useIngestStore.setState({ stage: "idle", runId: null });

    vi.spyOn(ipc, "getSettings").mockResolvedValue({
      ingest_provider: "anthropic-cli",
      ingest_model: "",
      query_provider: "builtin-local",
      query_model: "gemma-3-1b",
    } as never);
    vi.spyOn(ipc, "createFolder").mockResolvedValue(undefined as never);
    vi.spyOn(ipc, "writeFile").mockResolvedValue(undefined as never);
    vi.spyOn(ipc, "fileMtimes").mockResolvedValue([]);
    vi.spyOn(ipc, "readVaultContext").mockResolvedValue("");
    vi.spyOn(ipc, "buildLinkGraph").mockResolvedValue({
      nodes: [],
      edges: [],
    } as never);
  });

  it("starts exactly one run when two callers race the same tick", async () => {
    const run = vi
      .spyOn(ipc, "claudeRunStream")
      .mockResolvedValue({ stdout: "ok", stderr: "", status: 0 } as never);

    // Both callers reach startIngest before either has published a stage —
    // exactly what two runInboxPass triggers landing together look like.
    await Promise.all([
      useIngestStore.getState().startIngest("t", "b"),
      useIngestStore.getState().startIngest("t", "b"),
    ]);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("holds even when listen() resolves instantly", async () => {
    // Not a slow-IPC problem: an await on an already-resolved promise still
    // yields. The guard must not straddle one.
    listenMock.mockImplementation(() => Promise.resolve(() => undefined));
    const run = vi
      .spyOn(ipc, "claudeRunStream")
      .mockResolvedValue({ stdout: "ok", stderr: "", status: 0 } as never);

    await Promise.all([
      useIngestStore.getState().startIngest("t", "b"),
      useIngestStore.getState().startIngest("t", "b"),
    ]);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("lets a second run start once the first has finished", async () => {
    const run = vi
      .spyOn(ipc, "claudeRunStream")
      .mockResolvedValue({ stdout: "ok", stderr: "", status: 0 } as never);

    await useIngestStore.getState().startIngest("t", "b");
    await useIngestStore.getState().startIngest("t", "b");

    expect(run).toHaveBeenCalledTimes(2);
  });
});

// Phase 1f: the deterministic validator replaced the old mtime-only gate.
// These cover the new branch — validator errors block, warnings don't.
describe("ingest validation gate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    listenMock.mockClear();
    useIngestStore.setState({ stage: "idle", runId: null });

    vi.spyOn(ipc, "getSettings").mockResolvedValue({
      ingest_provider: "anthropic-cli",
      ingest_model: "",
      query_provider: "builtin-local",
      query_model: "gemma-3-1b",
    } as never);
    vi.spyOn(ipc, "createFolder").mockResolvedValue(undefined as never);
    vi.spyOn(ipc, "writeFile").mockResolvedValue(undefined as never);
    vi.spyOn(ipc, "readVaultContext").mockResolvedValue("");
    vi.spyOn(ipc, "buildLinkGraph").mockResolvedValue({
      nodes: [],
      edges: [],
    } as never);
    vi.spyOn(ipc, "claudeRunStream").mockResolvedValue({
      stdout: "ok",
      stderr: "",
      status: 0,
    } as never);
  });

  it("blocks on validator errors instead of reaching done", async () => {
    // wikiBefore snapshot (empty) then afterMtimes showing one wiki page
    // changed, so the run has something to validate.
    vi.spyOn(ipc, "fileMtimes")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([["/v/wiki/foo.md", 1]]);
    const validate = vi.spyOn(ipc, "validateIngest").mockResolvedValue({
      errors: [
        { page: "wiki/foo.md", kind: "dangling_citation", detail: "no raw/bar.md" },
      ],
      warnings: [],
    });

    await useIngestStore.getState().startIngest("t", "b");

    expect(validate).toHaveBeenCalledWith("/v", ["/v/wiki/foo.md"]);
    expect(useIngestStore.getState().stage).toBe("error");
    expect(useIngestStore.getState().log).toContain("wiki/foo.md");
    expect(useIngestStore.getState().log).toContain("no raw/bar.md");
  });

  it("reaches done and surfaces warnings when the validator only warns", async () => {
    vi.spyOn(ipc, "fileMtimes")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([["/v/wiki/foo.md", 1]]);
    vi.spyOn(ipc, "validateIngest").mockResolvedValue({
      errors: [],
      warnings: [
        { page: "wiki/foo.md", kind: "unresolved_wikilink", detail: "[[bar]] not found" },
      ],
    });

    await useIngestStore.getState().startIngest("t", "b");

    expect(useIngestStore.getState().stage).toBe("done");
    expect(useIngestStore.getState().log).toContain("[[bar]] not found");
  });

  it("fails as before (no-changes) when no wiki page changed, without calling the validator", async () => {
    vi.spyOn(ipc, "fileMtimes").mockResolvedValue([]);
    const validate = vi.spyOn(ipc, "validateIngest");

    await useIngestStore.getState().startIngest("t", "b");

    expect(validate).not.toHaveBeenCalled();
    expect(useIngestStore.getState().stage).toBe("error");
  });
});
