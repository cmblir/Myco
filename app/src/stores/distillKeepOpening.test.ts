import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import type { AgentVaultSession } from "../lib/ipc";
import { useDistillStore, withQuarantineLock } from "./distillStore";
import { useVaultStore } from "./vaultStore";

// These tests exercise store orchestration with deferred IPC. Native mutation
// and writer/opening concurrency have separate real-file regression tests.
const originalRefresh = useDistillStore.getState().refresh;
const origin = { vaultPath: "/v", openingToken: "synthetic-native-a" };
const path = "_inbox/quarantine/note.md";
const refresh = vi.fn<() => Promise<void>>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

function reopen() {
  useVaultStore.setState({ vaultToken: "synthetic-ui-b", isOpeningVault: true });
  useVaultStore.setState({ isOpeningVault: false });
}

beforeEach(() => {
  vi.restoreAllMocks();
  refresh.mockReset().mockResolvedValue(undefined);
  useVaultStore.setState({ currentVault: { path: "/v", name: "v" }, vaultToken: "synthetic-ui-a", isOpeningVault: false });
  useDistillStore.setState({ error: null, quarantineBusy: new Set(), refresh });
  vi.spyOn(ipc, "agentVaultSession").mockResolvedValue(origin);
  vi.spyOn(ipc, "extendQuarantine").mockResolvedValue(1);
});

afterEach(() => {
  useDistillStore.setState({ refresh: originalRefresh });
  vi.restoreAllMocks();
});

it("captures and forwards the original native opening for Keep", async () => {
  await useDistillStore.getState().keepQuarantine(path, 7);
  expect(ipc.agentVaultSession).toHaveBeenCalledTimes(1);
  expect(ipc.extendQuarantine).toHaveBeenCalledWith("/v", [path], 7, origin);
  expect(refresh).toHaveBeenCalledTimes(1);
});

it("dispatches no Keep or capture while a vault is opening", async () => {
  useVaultStore.setState({ isOpeningVault: true });
  await useDistillStore.getState().keepQuarantine(path, 7);
  expect(ipc.agentVaultSession).not.toHaveBeenCalled();
  expect(ipc.extendQuarantine).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
});

it("stops a pending capture after the same vault path is reopened", async () => {
  const captured = deferred<AgentVaultSession>();
  vi.mocked(ipc.agentVaultSession).mockReturnValue(captured.promise);
  const pending = useDistillStore.getState().keepQuarantine(path, 7);
  reopen();
  useDistillStore.setState({ error: "current-opening-message" });
  captured.resolve(origin);
  await pending;
  expect(ipc.agentVaultSession).toHaveBeenCalledTimes(1);
  expect(ipc.extendQuarantine).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  expect(useDistillStore.getState().error).toBe("current-opening-message");
});

it("ignores a late capture failure after reopening", async () => {
  const captured = deferred<AgentVaultSession>();
  vi.mocked(ipc.agentVaultSession).mockReturnValue(captured.promise);
  const pending = useDistillStore.getState().keepQuarantine(path, 7);
  reopen();
  useDistillStore.setState({ error: "current-opening-message" });
  captured.reject(new Error("old-capture-failed"));
  await pending;
  expect(ipc.agentVaultSession).toHaveBeenCalledTimes(1);
  expect(ipc.extendQuarantine).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  expect(useDistillStore.getState().error).toBe("current-opening-message");
});

it.each([
  { vaultPath: "/other", openingToken: "synthetic-native-other" },
  { vaultPath: "/v", openingToken: "" },
])("rejects an invalid captured origin before Keep: %j", async (invalid) => {
  vi.mocked(ipc.agentVaultSession).mockResolvedValue(invalid);
  await useDistillStore.getState().keepQuarantine(path, 7);
  expect(ipc.extendQuarantine).not.toHaveBeenCalled();
  expect(useDistillStore.getState().error).toContain("opening");
});

it.each(["success", "failure"])("ignores an old Keep %s after reopening", async (outcome) => {
  const extended = deferred<number>();
  vi.mocked(ipc.extendQuarantine).mockReturnValue(extended.promise);
  const pending = useDistillStore.getState().keepQuarantine(path, 7);
  await vi.waitFor(() => expect(ipc.extendQuarantine).toHaveBeenCalledTimes(1));
  reopen();
  useDistillStore.setState({ error: "new-opening-message" });
  if (outcome === "success") extended.resolve(1);
  else extended.reject(new Error("old-opening-error"));
  await pending;
  expect(refresh).not.toHaveBeenCalled();
  expect(useDistillStore.getState().error).toBe("new-opening-message");
});

it("preserves a current Keep failure after its refresh clears errors", async () => {
  vi.mocked(ipc.extendQuarantine).mockRejectedValue(new Error("synthetic-extension-failed"));
  refresh.mockImplementation(async () => { useDistillStore.setState({ error: null }); });
  await useDistillStore.getState().keepQuarantine(path, 7);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(useDistillStore.getState().error).toContain("synthetic-extension-failed");
});

it("does not reapply an old failure if reopening occurs during refresh", async () => {
  const refreshed = deferred<void>();
  refresh.mockReturnValue(refreshed.promise);
  vi.mocked(ipc.extendQuarantine).mockRejectedValue(new Error("old-opening-error"));
  const pending = useDistillStore.getState().keepQuarantine(path, 7);
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  reopen();
  useDistillStore.setState({ error: "new-opening-message" });
  refreshed.resolve(undefined);
  await pending;
  expect(useDistillStore.getState().error).toBe("new-opening-message");
});

it("clears old busy keys on reopening and retains the new opening's same key", async () => {
  const oldAction = deferred<void>();
  const newAction = deferred<void>();
  const oldPending = withQuarantineLock(path, () => oldAction.promise);
  expect(useDistillStore.getState().quarantineBusy.has(path)).toBe(true);
  reopen();
  const cleared = useDistillStore.getState().quarantineBusy.size;
  const newCall = vi.fn(() => newAction.promise);
  const newPending = withQuarantineLock(path, newCall);
  oldAction.resolve(undefined);
  await oldPending;
  const stillBusy = useDistillStore.getState().quarantineBusy.has(path);
  newAction.resolve(undefined);
  await newPending;
  expect(cleared).toBe(0);
  expect(newCall).toHaveBeenCalledTimes(1);
  expect(stillBusy).toBe(true);
  expect(useDistillStore.getState().quarantineBusy.size).toBe(0);
});

it("does not start a quarantine action during vault opening", async () => {
  useVaultStore.setState({ isOpeningVault: true });
  const action = vi.fn(async () => undefined);
  await withQuarantineLock(path, action);
  expect(action).not.toHaveBeenCalled();
  expect(useDistillStore.getState().quarantineBusy.size).toBe(0);
});

it("retains the action rejection when its opening became stale", async () => {
  const action = deferred<void>();
  const pending = withQuarantineLock(path, () => action.promise);
  const rejection = expect(pending).rejects.toThrow("synthetic-action-failed");
  reopen();
  action.reject(new Error("synthetic-action-failed"));
  await rejection;
  expect(useDistillStore.getState().quarantineBusy.size).toBe(0);
});
