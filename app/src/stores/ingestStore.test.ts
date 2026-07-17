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
vi.mock("../lib/log", () => ({ log: vi.fn().mockResolvedValue(undefined) }));

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
