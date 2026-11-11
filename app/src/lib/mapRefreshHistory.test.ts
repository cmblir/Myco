import { beforeEach, expect, it, vi } from "vitest";
const { agentVaultSession, latestMapRefreshHistory, active } = vi.hoisted(
  () => ({
    agentVaultSession: vi.fn(),
    latestMapRefreshHistory: vi.fn(),
    active: {
      currentVault: { path: "/synthetic" },
      vaultToken: "ui-1",
      isOpeningVault: false,
    },
  }),
);
vi.mock("./ipc", () => ({
  ipc: { agentVaultSession, latestMapRefreshHistory },
}));
vi.mock("../stores/vaultStore", () => ({
  useVaultStore: { getState: () => active },
}));
import { readMapHistory } from "./mapRefreshHistory";
const record = {
  path: "wiki/maps/synthetic.md",
  before: "Before",
  after: "After",
  hasChangesSinceRefresh: true,
};
beforeEach(() => {
  active.vaultToken = "ui-1";
  active.isOpeningVault = false;
  vi.resetAllMocks();
  agentVaultSession.mockResolvedValue({
    vaultPath: "/synthetic",
    openingToken: "native-1",
  });
  latestMapRefreshHistory.mockResolvedValue(record);
});
it("reads exact before/after snapshots and distinguishes absent legacy history from failure", async () => {
  const observed = vi.fn();
  await readMapHistory("/synthetic", "ui-1", "synthetic", observed).finished;
  expect(observed).toHaveBeenLastCalledWith({
    phase: "ready",
    history: record,
  });
  latestMapRefreshHistory.mockResolvedValueOnce(null);
  await readMapHistory("/synthetic", "ui-1", "synthetic", observed).finished;
  expect(observed).toHaveBeenLastCalledWith({ phase: "ready", history: null });
  latestMapRefreshHistory.mockRejectedValueOnce(
    new Error("Synthetic read failure"),
  );
  await readMapHistory("/synthetic", "ui-1", "synthetic", observed).finished;
  expect(observed).toHaveBeenLastCalledWith({
    phase: "error",
    error: "Error: Synthetic read failure",
  });
});
it.each(["cancel", "reopen", "opening"])(
  "drops late history after %s",
  async (change) => {
    let resolve!: (value: typeof record) => void;
    latestMapRefreshHistory.mockReturnValue(
      new Promise((ok) => {
        resolve = ok;
      }),
    );
    const observed = vi.fn();
    const request = readMapHistory("/synthetic", "ui-1", "synthetic", observed);
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
  await readMapHistory("/synthetic", "ui-1", "synthetic", observed).finished;
  expect(latestMapRefreshHistory).not.toHaveBeenCalled();
  latestMapRefreshHistory.mockResolvedValueOnce({
    ...record,
    path: "wiki/maps/other.md",
  });
  await readMapHistory("/synthetic", "ui-1", "synthetic", observed).finished;
  expect(observed).toHaveBeenLastCalledWith({
    phase: "error",
    error: expect.stringContaining("selected map"),
  });
});
