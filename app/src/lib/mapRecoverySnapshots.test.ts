import { beforeEach, expect, it, vi } from "vitest";
const { agentVaultSession, retainedMapSnapshots, active } = vi.hoisted(() => ({
  agentVaultSession: vi.fn(),
  retainedMapSnapshots: vi.fn(),
  active: {
    currentVault: { path: "/synthetic" },
    vaultToken: "ui-1",
    isOpeningVault: false,
  },
}));
vi.mock("./ipc", () => ({
  ipc: { agentVaultSession, retainedMapSnapshots },
}));
vi.mock("../stores/vaultStore", () => ({
  useVaultStore: { getState: () => active },
}));
import { readMapRecovery } from "./mapRecoverySnapshots";
const record = {
  path: "wiki/maps/synthetic.md",
  records: [
    {
      recordId: `${"a".repeat(64)}.${"b".repeat(32)}.json`,
      evidence: "publicationUnknown",
      before: "Before",
      after: "After",
    },
  ],
};
beforeEach(() => {
  active.vaultToken = "ui-1";
  active.isOpeningVault = false;
  vi.resetAllMocks();
  agentVaultSession.mockResolvedValue({
    vaultPath: "/synthetic",
    openingToken: "native-1",
  });
  retainedMapSnapshots.mockResolvedValue(record);
});
it("reads snapshots, empty results and recoverable errors without write calls", async () => {
  const observed = vi.fn();
  await readMapRecovery("/synthetic", "ui-1", "synthetic", observed).finished;
  expect(observed).toHaveBeenLastCalledWith({
    phase: "ready",
    snapshots: record,
  });
  retainedMapSnapshots.mockResolvedValueOnce({ ...record, records: [] });
  await readMapRecovery("/synthetic", "ui-1", "synthetic", observed).finished;
  expect(observed).toHaveBeenLastCalledWith({
    phase: "ready",
    snapshots: { ...record, records: [] },
  });
  retainedMapSnapshots.mockRejectedValueOnce(
    new Error("Synthetic read failure"),
  );
  await readMapRecovery("/synthetic", "ui-1", "synthetic", observed).finished;
  expect(observed).toHaveBeenLastCalledWith({
    phase: "error",
    error: "Error: Synthetic read failure",
  });
});
it.each(["cancel", "reopen", "opening"])(
  "drops late history after %s",
  async (change) => {
    let resolve!: (value: typeof record) => void;
    retainedMapSnapshots.mockReturnValue(
      new Promise((ok) => {
        resolve = ok;
      }),
    );
    const observed = vi.fn();
    const request = readMapRecovery(
      "/synthetic",
      "ui-1",
      "synthetic",
      observed,
    );
    await Promise.resolve();
    if (change === "cancel") request.cancel();
    if (change === "reopen") active.vaultToken = "ui-2";
    if (change === "opening") active.isOpeningVault = true;
    resolve(record);
    await request.finished;
    expect(observed.mock.calls).toEqual([[{ phase: "loading" }]]);
  },
);
it("rejects an unexpected native opening or another map's response", async () => {
  const observed = vi.fn();
  agentVaultSession.mockResolvedValueOnce({
    vaultPath: "/other",
    openingToken: "native-2",
  });
  await readMapRecovery("/synthetic", "ui-1", "synthetic", observed).finished;
  expect(retainedMapSnapshots).not.toHaveBeenCalled();
  retainedMapSnapshots.mockResolvedValueOnce({
    ...record,
    path: "wiki/maps/other.md",
  });
  await readMapRecovery("/synthetic", "ui-1", "synthetic", observed).finished;
  expect(observed).toHaveBeenLastCalledWith({
    phase: "error",
    error: expect.stringContaining("selected map"),
  });
});

it.each([
  { ...record, records: [record.records[0], record.records[0]] },
  { ...record, records: [{ ...record.records[0], evidence: "published" }] },
  { ...record, records: [{ ...record.records[0], evidence: "invalidRecord" }] },
  { ...record, records: [{ ...record.records[0], after: null }] },
  { ...record, records: [{ ...record.records[0], recordId: "../outside" }] },
])("rejects malformed or overclaimed native snapshots", async (invalid) => {
  retainedMapSnapshots.mockResolvedValueOnce(invalid);
  const observed = vi.fn();
  await readMapRecovery("/synthetic", "ui-1", "synthetic", observed).finished;
  expect(observed).toHaveBeenLastCalledWith({
    phase: "error",
    error: expect.stringContaining("selected map"),
  });
});
it("drops a late error after cancellation", async () => {
  let reject!: (reason: Error) => void;
  retainedMapSnapshots.mockReturnValue(
    new Promise((_, fail) => {
      reject = fail;
    }),
  );
  const observed = vi.fn();
  const request = readMapRecovery("/synthetic", "ui-1", "synthetic", observed);
  await Promise.resolve();
  request.cancel();
  reject(new Error("Synthetic late error"));
  await request.finished;
  expect(observed.mock.calls).toEqual([[{ phase: "loading" }]]);
});
