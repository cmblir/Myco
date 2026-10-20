import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FullTierOutcome } from "./fullTierIngest";
import { WorkflowOperationError } from "./workflowOutcome";

const fullTierIngest = vi.fn();
vi.mock("./fullTierIngest", () => ({
  runFullTierIngest: (...args: unknown[]) => fullTierIngest(...args),
}));

const ingestState = { stage: "idle" };
vi.mock("../stores/ingestStore", () => ({
  useIngestStore: { getState: () => ingestState },
}));

const refreshTree = vi.fn();
const settingsState = { settings: { auto_ingest_enabled: true } };
const getSettings = vi.fn();
const agentVaultSession = vi.fn();
vi.mock("../stores/settingsStore", () => ({
  useSettingsStore: { getState: () => settingsState },
}));
vi.mock("./ipc", () => ({ ipc: { getSettings: (...args: unknown[]) => getSettings(...args), agentVaultSession: (...args: unknown[]) => agentVaultSession(...args) } }));
const vaultState: {
  currentVault: { path: string } | null;
  vaultToken: string;
  isOpeningVault: boolean;
  refreshTree: typeof refreshTree;
} = { currentVault: null, vaultToken: "synthetic-ui-opening-1", isOpeningVault: false, refreshTree };
vi.mock("../stores/vaultStore", () => ({
  useVaultStore: { getState: () => vaultState },
}));

import { runSessionPass, stopSessionPass, useSessionCompilerDisplay } from "./sessionIngest";
import { tryLock, unlock } from "./vaultLock";

const VAULT = "/synthetic-session-vault";
const OTHER_VAULT = "/synthetic-other-vault";
const SUCCESS: FullTierOutcome = { ingested: 1, skipped: null, errors: [] };

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

beforeEach(() => {
  fullTierIngest.mockReset();
  fullTierIngest.mockResolvedValue(SUCCESS);
  refreshTree.mockReset();
  refreshTree.mockResolvedValue(undefined);
  ingestState.stage = "idle";
  vaultState.currentVault = { path: VAULT };
  vaultState.vaultToken = "synthetic-ui-opening-1";vaultState.isOpeningVault = false;
  agentVaultSession.mockReset();
  agentVaultSession.mockResolvedValue({vaultPath:VAULT,openingToken:"synthetic-native-opening-1"});
  settingsState.settings.auto_ingest_enabled = true;
  getSettings.mockReset();
  getSettings.mockResolvedValue({ auto_ingest_enabled: true });
  useSessionCompilerDisplay.setState({ run: null });
});

afterEach(() => {
  unlock(VAULT);
  unlock(OTHER_VAULT);
});

describe("runSessionPass", () => {
  it("remembers at most three burst wakeups and runs their budget-one passes sequentially", async () => {
    const pending = deferred<FullTierOutcome>();
    fullTierIngest.mockReturnValueOnce(pending.promise);
    const owner = runSessionPass(VAULT);
    await Promise.resolve();
    expect(await Promise.all(Array.from({ length: 8 }, () => runSessionPass(VAULT))))
      .toEqual(Array(8).fill(null));
    expect(fullTierIngest).toHaveBeenCalledTimes(1);
    pending.resolve(SUCCESS);
    expect(await owner).toEqual({ ingested: 4, skipped: null, errors: [] });
    expect(fullTierIngest).toHaveBeenCalledTimes(4);
    expect(fullTierIngest.mock.calls.every(args => args[0] === VAULT && args[1].pendingOnly === true)).toBe(true);
    expect(fullTierIngest.mock.calls.every(args => args[1].usage === "automatic" &&
      args[1].origin.openingToken === "synthetic-native-opening-1")).toBe(true);
    expect(getSettings).toHaveBeenCalledTimes(3);
    expect(tryLock(VAULT)).toBe(true);
  });

  it("does not start a pass for an inactive vault or disabled automatic ingest", async () => {
    vaultState.currentVault = { path: OTHER_VAULT };
    expect(await runSessionPass(VAULT)).toBeNull();
    vaultState.currentVault = { path: VAULT };
    settingsState.settings.auto_ingest_enabled = false;
    expect(await runSessionPass(VAULT)).toBeNull();
    expect(fullTierIngest).not.toHaveBeenCalled();
  });

  it("keeps the followup cap even when updates continue arriving during every pass", async () => {
    fullTierIngest.mockImplementation(async () => {
      for (let i = 0; i < 4; i++) expect(await runSessionPass(VAULT)).toBeNull();
      return SUCCESS;
    });
    expect(await runSessionPass(VAULT)).toEqual({ ingested: 4, skipped: null, errors: [] });
    expect(fullTierIngest).toHaveBeenCalledTimes(4);
    expect(tryLock(VAULT)).toBe(true);
  });

  it("rechecks the active vault after reading persisted settings for a queued pass", async () => {
    const pending = deferred<FullTierOutcome>();
    const settings = deferred<{ auto_ingest_enabled: boolean }>();
    const settingsStarted = deferred<void>();
    fullTierIngest.mockReturnValueOnce(pending.promise);
    getSettings.mockImplementationOnce(() => {
      settingsStarted.resolve(undefined);
      return settings.promise;
    });
    const owner = runSessionPass(VAULT);
    await Promise.resolve();
    expect(await runSessionPass(VAULT)).toBeNull();
    pending.resolve(SUCCESS);
    await settingsStarted.promise;
    vaultState.currentVault = { path: OTHER_VAULT };
    settings.resolve({ auto_ingest_enabled: true });
    expect(await owner).toBe(SUCCESS);
    expect(fullTierIngest).toHaveBeenCalledTimes(1);
    expect(tryLock(VAULT)).toBe(true);
  });

  it("propagates a queued provider failure and clears unused wakeups for a later request", async () => {
    const pending = deferred<FullTierOutcome>();
    const failure = new Error("Synthetic queued provider failure");
    fullTierIngest.mockReturnValueOnce(pending.promise).mockRejectedValueOnce(failure);
    const owner = runSessionPass(VAULT);
    await Promise.resolve();
    await Promise.all(Array.from({ length: 3 }, () => runSessionPass(VAULT)));
    pending.resolve(SUCCESS);
    await expect(owner).rejects.toBe(failure);
    expect(fullTierIngest).toHaveBeenCalledTimes(2);
    expect(tryLock(VAULT)).toBe(true);
    unlock(VAULT);
    expect(await runSessionPass(VAULT)).toBe(SUCCESS);
    expect(fullTierIngest).toHaveBeenCalledTimes(3);
  });

  it("stops remembered work after a failed outcome while preserving earlier success and errors", async () => {
    const pending = deferred<FullTierOutcome>();
    fullTierIngest.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ ingested: 0, skipped: null,
      errors: ["Synthetic queued validation failure"] });
    const owner = runSessionPass(VAULT);
    await Promise.resolve();
    await Promise.all(Array.from({ length: 3 }, () => runSessionPass(VAULT)));
    pending.resolve(SUCCESS);
    expect(await owner).toEqual({ ingested: 1, skipped: null, errors: ["Synthetic queued validation failure"] });
    expect(fullTierIngest).toHaveBeenCalledTimes(2);
    expect(refreshTree).toHaveBeenCalledTimes(1);
    expect(tryLock(VAULT)).toBe(true);
  });

  it.each(["vault", "closed", "setting", "persisted-setting", "stage"])(
    "drops remembered wakeups after %s changes",
    async change => {
      const pending = deferred<FullTierOutcome>();
      fullTierIngest.mockReturnValueOnce(pending.promise);
      const owner = runSessionPass(VAULT);
    await Promise.resolve();
      expect(await runSessionPass(VAULT)).toBeNull();
      if (change === "vault") vaultState.currentVault = { path: OTHER_VAULT };
      if (change === "closed") vaultState.currentVault = null;
      if (change === "setting") settingsState.settings.auto_ingest_enabled = false;
      if (change === "persisted-setting") getSettings.mockResolvedValue({ auto_ingest_enabled: false });
      if (change === "stage") ingestState.stage = "claude";
      pending.resolve(SUCCESS);
      expect(await owner).toBe(SUCCESS);
      expect(fullTierIngest).toHaveBeenCalledTimes(1);
      expect(tryLock(VAULT)).toBe(true);
    },
  );

  it.each(["writing-raw", "plan-gate", "claude", "indexing"])(
    "does not start a session provider while interactive ingest is %s",
    async (stage) => {
      ingestState.stage = stage;

      expect(await runSessionPass(VAULT)).toBeNull();
      expect(fullTierIngest).not.toHaveBeenCalled();
      expect(refreshTree).not.toHaveBeenCalled();
      expect(tryLock(VAULT)).toBe(true);
    },
  );

  it("skips a shared vault lock without releasing the other owner's lock", async () => {
    expect(tryLock(VAULT)).toBe(true);

    expect(await runSessionPass(VAULT)).toBeNull();
    expect(fullTierIngest).not.toHaveBeenCalled();
    expect(refreshTree).not.toHaveBeenCalled();
    expect(tryLock(VAULT)).toBe(false);

    unlock(VAULT);
    expect(await runSessionPass(VAULT)).toBe(SUCCESS);
  });

  it("uses one existing pending-session pipeline and refreshes the matching vault", async () => {
    expect(await runSessionPass(VAULT)).toBe(SUCCESS);

    expect(fullTierIngest).toHaveBeenCalledTimes(1);
    expect(fullTierIngest).toHaveBeenCalledWith(VAULT, expect.objectContaining({ pendingOnly: true,
      origin: {vaultPath:VAULT,openingToken:"synthetic-native-opening-1"},signal:expect.any(AbortSignal),
      onSessionStarted:expect.any(Function),onSessionProgress:expect.any(Function) }));
    expect(refreshTree).toHaveBeenCalledTimes(1);
    expect(tryLock(VAULT)).toBe(true);
  });

  it("starts only one provider at a time for a concurrent burst and keeps its lock until completion", async () => {
    const pending = deferred<FullTierOutcome>();
    fullTierIngest.mockReturnValueOnce(pending.promise);
    const owner = runSessionPass(VAULT);
    await Promise.resolve();

    expect(await Promise.all(Array.from({ length: 5 }, () => runSessionPass(VAULT))))
      .toEqual([null, null, null, null, null]);
    expect(fullTierIngest).toHaveBeenCalledTimes(1);
    expect(tryLock(VAULT)).toBe(false);
    expect(refreshTree).not.toHaveBeenCalled();

    pending.resolve(SUCCESS);
    expect(await owner).toEqual({ ingested: 4, skipped: null, errors: [] });
    expect(refreshTree).toHaveBeenCalledTimes(4);
    expect(tryLock(VAULT)).toBe(true);
  });

  it("propagates a provider failure and releases the lock for a later retry", async () => {
    const failure = new Error("Synthetic selected provider unavailable");
    fullTierIngest.mockRejectedValueOnce(failure);

    await expect(runSessionPass(VAULT)).rejects.toBe(failure);
    expect(refreshTree).not.toHaveBeenCalled();
    expect(tryLock(VAULT)).toBe(true);

    unlock(VAULT);
    expect(await runSessionPass(VAULT)).toBe(SUCCESS);
    expect(fullTierIngest).toHaveBeenCalledTimes(2);
    expect(refreshTree).toHaveBeenCalledTimes(1);
  });

  it("retries a resolved failed pass with a new signal and attempt while clearing the old display error", async () => {
    const failure: FullTierOutcome = { ingested: 0, skipped: null, sourcesPending: 1,
      status: "failed", errors: ["Synthetic owned failure; native finalization could not be confirmed"] };
    fullTierIngest.mockImplementationOnce(async (_vault, options) => {
      options.onSessionStarted({ attemptId: "synthetic-expired-runtime-attempt", source: { key: "codex:synthetic" },
        roleSnapshot: { routeSignature: { modelId: "qwen3.5-2b-q4_k_m" } } });
      return failure;
    });

    expect(await runSessionPass(VAULT)).toBe(failure);
    const firstOptions = fullTierIngest.mock.calls[0][1];
    expect(useSessionCompilerDisplay.getState().run).toMatchObject({
      attemptId: "synthetic-expired-runtime-attempt", status: "failed", stopping: false,
      error: failure.errors[0], preparationRequired: false,
    });
    expect(stopSessionPass(VAULT, vaultState.vaultToken)).toBe(false);
    expect(tryLock(VAULT)).toBe(true);
    unlock(VAULT);

    const retried = deferred<FullTierOutcome>();
    fullTierIngest.mockReturnValueOnce(retried.promise);
    const retry = runSessionPass(VAULT);
    await Promise.resolve();
    const retryOptions = fullTierIngest.mock.calls[1][1];
    expect(retryOptions.signal).not.toBe(firstOptions.signal);
    expect(retryOptions.signal.aborted).toBe(false);
    expect(retryOptions).toMatchObject({ pendingOnly: true, usage: "automatic",
      origin: { vaultPath: VAULT, openingToken: "synthetic-native-opening-1" } });
    expect(useSessionCompilerDisplay.getState().run).toMatchObject({
      vaultToken: vaultState.vaultToken, status: "running", attemptId: null,
      stopping: false, error: null, processedWindows: null, eligibleWindows: null,
    });
    retryOptions.onSessionStarted({ attemptId: "synthetic-fresh-runtime-attempt", source: { key: "codex:synthetic" },
      roleSnapshot: { routeSignature: { modelId: "qwen3.5-2b-q4_k_m" } } });
    expect(useSessionCompilerDisplay.getState().run?.attemptId).toBe("synthetic-fresh-runtime-attempt");
    const pending: FullTierOutcome = { ingested: 0, skipped: null, errors: [], sourcesPending: 1, status: "pending" };
    retried.resolve(pending);

    expect(await retry).toBe(pending);
    expect(fullTierIngest).toHaveBeenCalledTimes(2);
    expect(useSessionCompilerDisplay.getState().run).toMatchObject({
      attemptId: "synthetic-fresh-runtime-attempt", status: "pending", stopping: false,
      error: null, preparationRequired: false,
    });
    expect(stopSessionPass(VAULT, vaultState.vaultToken)).toBe(false);
    expect(refreshTree).not.toHaveBeenCalled();
    expect(tryLock(VAULT)).toBe(true);
  });

  it.each<FullTierOutcome>([
    { ingested: 0, skipped: "nothing", errors: [] },
    { ingested: 0, skipped: "no-provider", errors: [] },
    { ingested: 0, skipped: null, errors: [], sourcesPending: 1 },
    { ingested: 0, skipped: null, errors: ["Synthetic source could not be organized"] },
  ])("preserves a non-success outcome without refreshing the tree: %j", async (outcome) => {
    fullTierIngest.mockResolvedValueOnce(outcome);

    expect(await runSessionPass(VAULT)).toBe(outcome);
    expect(refreshTree).not.toHaveBeenCalled();
    expect(tryLock(VAULT)).toBe(true);
  });

  it("preserves reported errors even when some session work succeeds", async () => {
    const outcome: FullTierOutcome = {
      ingested: 1,
      skipped: null,
      errors: ["Synthetic second source validation failed"],
      sourcesPending: 1,
    };
    fullTierIngest.mockResolvedValueOnce(outcome);

    expect(await runSessionPass(VAULT)).toBe(outcome);
    expect(refreshTree).toHaveBeenCalledTimes(1);
  });

  it.each([{ path: OTHER_VAULT }, null])(
    "does not refresh a swapped or closed vault after the provider finishes: %j",
    async (currentVault) => {
      const pending = deferred<FullTierOutcome>();
      fullTierIngest.mockReturnValueOnce(pending.promise);
      const owner = runSessionPass(VAULT);
    await Promise.resolve();
      vaultState.currentVault = currentVault;

      pending.resolve(SUCCESS);
      expect(await owner).toBe(SUCCESS);
      expect(refreshTree).not.toHaveBeenCalled();
      expect(tryLock(VAULT)).toBe(true);
    },
  );

  it("holds the lock while refreshing and checks a remembered wakeup only afterward", async () => {
    const refreshing = deferred<void>();
    const refreshStarted = deferred<void>();
    refreshTree.mockImplementationOnce(() => {
      refreshStarted.resolve(undefined);
      return refreshing.promise;
    });
    fullTierIngest.mockResolvedValueOnce(SUCCESS).mockResolvedValueOnce({ ingested: 0, skipped: "nothing", errors: [] });
    const owner = runSessionPass(VAULT);
    await Promise.resolve();
    await refreshStarted.promise;

    expect(await runSessionPass(VAULT)).toBeNull();
    expect(fullTierIngest).toHaveBeenCalledTimes(1);
    expect(tryLock(VAULT)).toBe(false);

    refreshing.resolve(undefined);
    expect(await owner).toEqual(SUCCESS);
    expect(fullTierIngest).toHaveBeenCalledTimes(2);
    expect(refreshTree).toHaveBeenCalledTimes(1);
    expect(tryLock(VAULT)).toBe(true);
  });

  it("propagates a refresh failure and still releases the vault lock", async () => {
    const failure = new Error("Synthetic tree refresh failed");
    refreshTree.mockRejectedValueOnce(failure);

    await expect(runSessionPass(VAULT)).rejects.toBe(failure);
    expect(fullTierIngest).toHaveBeenCalledTimes(1);
    expect(tryLock(VAULT)).toBe(true);
  });
  it("same-path reopening drops old wakeups and suppresses old tree refresh", async () => {
    const pending=deferred<FullTierOutcome>();fullTierIngest.mockReturnValueOnce(pending.promise);
    const owner=runSessionPass(VAULT);await Promise.resolve();
    await runSessionPass(VAULT);
    vaultState.vaultToken="synthetic-ui-opening-2";
    pending.resolve(SUCCESS);await owner;
    expect(fullTierIngest).toHaveBeenCalledTimes(1);expect(refreshTree).not.toHaveBeenCalled();
    expect(fullTierIngest).toHaveBeenCalledWith(VAULT,expect.objectContaining({pendingOnly:true,
      origin:{vaultPath:VAULT,openingToken:"synthetic-native-opening-1"},signal:expect.any(AbortSignal)}));
  });
  it("a native capture racing same-path reopen never dispatches an old pass", async () => {
    const captured=deferred<{vaultPath:string;openingToken:string}>();agentVaultSession.mockReturnValueOnce(captured.promise);
    const owner=runSessionPass(VAULT);vaultState.vaultToken="synthetic-ui-opening-2";
    captured.resolve({vaultPath:VAULT,openingToken:"synthetic-native-opening-1"});
    expect(await owner).toBeNull();expect(fullTierIngest).not.toHaveBeenCalled();
  });

  it("refreshes confirmed partial artifacts without incrementing compiler completion", async () => {
    const outcome:FullTierOutcome={ingested:0,publishedSources:1,sourcesPending:1,skipped:null,errors:[],status:"partial"};
    fullTierIngest.mockResolvedValueOnce(outcome);
    expect(await runSessionPass(VAULT)).toBe(outcome);expect(refreshTree).toHaveBeenCalledTimes(1);
  });

  it("shows actual native packet counters and uses the owning request signal for Stop", async () => {
    const pending=deferred<FullTierOutcome>();fullTierIngest.mockReturnValueOnce(pending.promise);
    const owner=runSessionPass(VAULT);await Promise.resolve();
    const options=fullTierIngest.mock.calls[0][1];
    options.onSessionStarted({attemptId:"synthetic-attempt",source:{key:"codex:synthetic"},
      roleSnapshot:{routeSignature:{modelId:"qwen3.5-2b-q4_k_m"}}});
    options.onSessionProgress({}, {eligibleWindows:31,step:{processedWindows:2}});
    expect(useSessionCompilerDisplay.getState().run).toMatchObject({attemptId:"synthetic-attempt",
      processedWindows:2,eligibleWindows:31,status:"running",stopping:false});
    expect(stopSessionPass(VAULT,"another-ui-opening")).toBe(false);
    expect(options.signal.aborted).toBe(false);
    expect(stopSessionPass(VAULT,vaultState.vaultToken)).toBe(true);
    expect(options.signal.aborted).toBe(true);
    expect(useSessionCompilerDisplay.getState().run).toMatchObject({status:"running",stopping:true});
    pending.resolve({ingested:0,skipped:null,errors:[],sourcesPending:1,status:"stopped"});
    await owner;
    expect(useSessionCompilerDisplay.getState().run).toMatchObject({status:"stopped",stopping:false});
    expect(refreshTree).not.toHaveBeenCalled();
  });

  it("native Stop failure stays failed rather than claiming a stopped attempt", async () => {
    const pending=deferred<FullTierOutcome>();fullTierIngest.mockReturnValueOnce(pending.promise);
    const owner=runSessionPass(VAULT);await Promise.resolve();
    stopSessionPass(VAULT,vaultState.vaultToken);
    pending.resolve({ingested:0,skipped:null,errors:["Native compiler Stop could not be confirmed"],sourcesPending:1,status:"failed"});
    await owner;
    expect(useSessionCompilerDisplay.getState().run).toMatchObject({status:"failed",stopping:false,
      error:"Native compiler Stop could not be confirmed"});
  });

  it.each([
    ["pending", "model_missing"], ["stopped", "cancelled"], ["failed", "operation_failed"],
  ] as const)("keeps a typed %s rejection in the compiler display", async (status, code) => {
    const failure = new WorkflowOperationError(status, code, "Synthetic confirmed native outcome");
    fullTierIngest.mockRejectedValueOnce(failure);
    await expect(runSessionPass(VAULT)).rejects.toBe(failure);
    expect(useSessionCompilerDisplay.getState().run).toMatchObject({status,stopping:false,
      error:expect.stringContaining("Synthetic confirmed native outcome"),
      preparationRequired:status === "pending"});
    expect(useSessionCompilerDisplay.getState().run?.finishedAt).not.toBeNull();
    expect(refreshTree).not.toHaveBeenCalled();
    expect(tryLock(VAULT)).toBe(true);
  });

  it("old same-path opening telemetry cannot paint a new opening", async () => {
    const pending=deferred<FullTierOutcome>();fullTierIngest.mockReturnValueOnce(pending.promise);
    const owner=runSessionPass(VAULT);await Promise.resolve();
    const options=fullTierIngest.mock.calls[0][1];
    vaultState.vaultToken="synthetic-ui-opening-2";
    options.onSessionProgress({}, {eligibleWindows:99,step:{processedWindows:99}});
    expect(useSessionCompilerDisplay.getState().run?.processedWindows).toBeNull();
    pending.resolve(SUCCESS);await owner;
    expect(useSessionCompilerDisplay.getState().run?.finishedAt).toBeNull();
    expect(refreshTree).not.toHaveBeenCalled();
  });

});
