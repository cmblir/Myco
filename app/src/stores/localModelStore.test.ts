import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import {
  ipc,
  type LocalChatModelProgress,
  type LocalChatStatus,
  type MycoSettings,
} from "../lib/ipc";
import {
  BUILTIN_CHAT_MODEL,
  BUILTIN_FAST_CHAT_MODEL,
  BUILTIN_MODEL,
} from "../lib/providers";
import {
  FAST_LOCAL_CHAT_MODEL_BYTES,
  LOCAL_CHAT_MODEL_BYTES,
  useFastLocalModelStore,
  useLocalModelStore,
} from "./localModelStore";
import { useSettingsStore } from "./settingsStore";
import type { RoleSelectionRequest } from "../lib/modelRoles";
import { selectedRolesFixture } from "../lib/modelRoles.testSupport";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const READY: LocalChatStatus = {
  model_id: BUILTIN_CHAT_MODEL,
  state: "ready",
  bytes: LOCAL_CHAT_MODEL_BYTES,
};
const MISSING: LocalChatStatus = { ...READY, state: "missing", bytes: 0 };
function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
let progress: (event: { payload: LocalChatModelProgress }) => void;
let off: ReturnType<typeof vi.fn>;
const originalUpdate = useSettingsStore.getState().update;
const originalSelectRole = useSettingsStore.getState().selectRole;
const update = vi.fn().mockResolvedValue(undefined);
const selectRole = vi.fn(async (request: RoleSelectionRequest) => {
  useSettingsStore.setState((state) => {
    const settings = state.settings!;
    const roles = settings.model_roles!.roles;
    return { settings: { ...settings, model_roles: { version: 2, roles: { ...roles, [request.role]: {
      ...roles[request.role], providerId: request.providerId, modelId: request.modelId, effort: request.effort,
      selection: request.providerId === "builtin-local" ? "explicit-local" : "explicit-external",
    } } } } };
  });
});

describe("explicit local model installation", () => {
  it("pins the reviewed Qwen3.5 4B quantization and its verified artifact size", () => {
    expect(BUILTIN_CHAT_MODEL).toBe("qwen3.5-4b-q4_k_m");
    expect(LOCAL_CHAT_MODEL_BYTES).toBe(2_707_513_696);
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    off = vi.fn();
    vi.mocked(listen).mockImplementation(async (_event, handler) => {
      progress = ({ payload }) =>
        handler({ event: "local-chat-model-progress", id: 0, payload });
      return off;
    });
    vi.spyOn(ipc, "localChatStatus").mockResolvedValue(MISSING);
    vi.spyOn(ipc, "downloadLocalChatModel").mockResolvedValue(READY);
    vi.spyOn(ipc, "cancelLocalChatModelDownload").mockResolvedValue(true);
    vi.spyOn(ipc, "setSettings");
    update.mockClear();
    selectRole.mockClear();
    useSettingsStore.setState({
      settings: {
        query_provider: "anthropic-cli",
        query_model: "sonnet",
        model_roles: selectedRolesFixture({ ask: { providerId: "anthropic-cli", modelId: "sonnet" } }),
      } as MycoSettings,
      saving: false,
      update,
      selectRole,
    });
    useLocalModelStore.setState({
      stage: "checking",
      downloaded: 0,
      total: LOCAL_CHAT_MODEL_BYTES,
      pct: 0,
      cancelling: false,
      error: null,
    });
    useFastLocalModelStore.setState({
      stage: "checking",
      downloaded: 0,
      total: FAST_LOCAL_CHAT_MODEL_BYTES,
      pct: 0,
      cancelling: false,
      error: null,
    });
  });
  afterEach(() =>
    useSettingsStore.setState({ update: originalUpdate, selectRole: originalSelectRole, settings: null }),
  );

  it("checking availability never starts a download or changes the user's model", async () => {
    await useLocalModelStore.getState().checkStatus();
    expect(useLocalModelStore.getState().stage).toBe("missing");
    expect(ipc.localChatStatus).toHaveBeenCalledTimes(1);
    expect(ipc.downloadLocalChatModel).not.toHaveBeenCalled();
    expect(ipc.setSettings).not.toHaveBeenCalled();
  });

  it("installation survives panel reentry and never selects a model automatically", async () => {
    const result = pending<LocalChatStatus>();
    vi.mocked(ipc.downloadLocalChatModel).mockReturnValue(result.promise);
    const run = useLocalModelStore.getState().download();
    await vi.waitFor(() =>
      expect(ipc.downloadLocalChatModel).toHaveBeenCalledTimes(1),
    );
    await useLocalModelStore.getState().download();
    await useLocalModelStore.getState().checkStatus();
    expect(ipc.downloadLocalChatModel).toHaveBeenCalledTimes(1);
    expect(ipc.localChatStatus).not.toHaveBeenCalled();
    expect(useLocalModelStore.getState().stage).toBe("downloading");
    result.resolve(READY);
    await run;
    expect(useLocalModelStore.getState().stage).toBe("ready");
    expect(ipc.setSettings).not.toHaveBeenCalled();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it("a late passive check cannot overwrite an explicit install", async () => {
    const status = pending<LocalChatStatus>();
    const result = pending<LocalChatStatus>();
    vi.mocked(ipc.localChatStatus).mockReturnValue(status.promise);
    vi.mocked(ipc.downloadLocalChatModel).mockReturnValue(result.promise);
    const check = useLocalModelStore.getState().checkStatus();
    const run = useLocalModelStore.getState().download();
    await vi.waitFor(() =>
      expect(ipc.downloadLocalChatModel).toHaveBeenCalledTimes(1),
    );
    status.resolve(MISSING);
    await check;
    expect(useLocalModelStore.getState().stage).toBe("downloading");
    result.resolve(READY);
    await run;
    expect(useLocalModelStore.getState().stage).toBe("ready");
  });

  it("bounds monotonic progress to the pinned bytes and waits for verification at 100 percent", async () => {
    const result = pending<LocalChatStatus>();
    vi.mocked(ipc.downloadLocalChatModel).mockReturnValue(result.promise);
    const run = useLocalModelStore.getState().download();
    await vi.waitFor(() =>
      expect(ipc.downloadLocalChatModel).toHaveBeenCalledTimes(1),
    );
    const emit = (
      downloaded: number,
      total = LOCAL_CHAT_MODEL_BYTES,
      pct = 50,
    ) => progress({ payload: { downloaded, total, pct } });
    emit(LOCAL_CHAT_MODEL_BYTES / 2);
    expect(useLocalModelStore.getState().pct).toBe(50);
    for (const value of [NaN, Infinity, -1, LOCAL_CHAT_MODEL_BYTES + 1, 1])
      emit(value);
    emit(LOCAL_CHAT_MODEL_BYTES, 1);
    emit(LOCAL_CHAT_MODEL_BYTES, LOCAL_CHAT_MODEL_BYTES, NaN);
    expect(useLocalModelStore.getState().pct).toBe(50);
    emit(LOCAL_CHAT_MODEL_BYTES, LOCAL_CHAT_MODEL_BYTES, 100);
    expect(useLocalModelStore.getState().pct).toBe(100);
    expect(useLocalModelStore.getState().stage).toBe("downloading");
    result.resolve(READY);
    await run;
    expect(useLocalModelStore.getState().stage).toBe("ready");
    emit(1);
    expect(useLocalModelStore.getState().pct).toBe(100);
  });

  it("cancel stays busy until the install promise settles and temporary cleanup is complete", async () => {
    const result = pending<LocalChatStatus>();
    vi.mocked(ipc.downloadLocalChatModel).mockReturnValue(result.promise);
    const run = useLocalModelStore.getState().download();
    await vi.waitFor(() =>
      expect(ipc.downloadLocalChatModel).toHaveBeenCalledTimes(1),
    );
    await useLocalModelStore.getState().cancelDownload();
    expect(ipc.cancelLocalChatModelDownload).toHaveBeenCalledTimes(1);
    expect(useLocalModelStore.getState()).toMatchObject({
      stage: "downloading",
      cancelling: true,
    });
    await useLocalModelStore.getState().download();
    expect(ipc.downloadLocalChatModel).toHaveBeenCalledTimes(1);
    result.reject(new Error("download cancelled"));
    await run;
    expect(useLocalModelStore.getState()).toMatchObject({
      stage: "missing",
      cancelling: false,
      error: null,
    });
    expect(off).toHaveBeenCalledTimes(1);
  });

  it("cancel during listener setup prevents a later backend download from starting", async () => {
    const listener = pending<() => void>();
    vi.mocked(listen).mockReturnValue(listener.promise);
    const run = useLocalModelStore.getState().download();
    await useLocalModelStore.getState().cancelDownload();
    expect(useLocalModelStore.getState().stage).toBe("downloading");
    listener.resolve(off);
    await run;
    expect(ipc.downloadLocalChatModel).not.toHaveBeenCalled();
    expect(useLocalModelStore.getState().stage).toBe("missing");
    expect(off).toHaveBeenCalledTimes(1);
  });

  it("does not hide a backend failure after cancellation acknowledgement fails", async () => {
    const result = pending<LocalChatStatus>();
    vi.mocked(ipc.downloadLocalChatModel).mockReturnValue(result.promise);
    vi.mocked(ipc.cancelLocalChatModelDownload).mockRejectedValueOnce(
      new Error("cancel IPC failed"),
    );
    const run = useLocalModelStore.getState().download();
    await vi.waitFor(() =>
      expect(ipc.downloadLocalChatModel).toHaveBeenCalledTimes(1),
    );
    await useLocalModelStore.getState().cancelDownload();
    expect(useLocalModelStore.getState()).toMatchObject({
      stage: "downloading",
      cancelling: false,
    });
    expect(useLocalModelStore.getState().error).toContain("cancel IPC failed");
    result.reject(new Error("disk is full"));
    await run;
    expect(useLocalModelStore.getState().stage).toBe("error");
    expect(useLocalModelStore.getState().error).toContain("disk is full");
  });

  it("reports listener and backend failures and disposes installed listeners", async () => {
    vi.mocked(listen).mockRejectedValueOnce(new Error("listener unavailable"));
    await useLocalModelStore.getState().download();
    expect(useLocalModelStore.getState()).toMatchObject({ stage: "error" });
    expect(useLocalModelStore.getState().error).toContain(
      "listener unavailable",
    );
    expect(ipc.downloadLocalChatModel).not.toHaveBeenCalled();
    vi.mocked(ipc.downloadLocalChatModel).mockRejectedValueOnce(
      new Error("disk is full"),
    );
    await useLocalModelStore.getState().download();
    expect(useLocalModelStore.getState().error).toContain("disk is full");
    expect(off).toHaveBeenCalledTimes(1);
  });

  it("does not mark a wrong model or wrong size ready", async () => {
    for (const status of [
      { ...READY, bytes: 1 },
      { ...READY, model_id: "other-model" },
      {
        ...READY,
        model_id: "qwen2.5-1.5b-instruct-q4_k_m",
        bytes: 1_117_320_736,
      },
    ]) {
      vi.mocked(ipc.localChatStatus).mockResolvedValue(status);
      await useLocalModelStore.getState().checkStatus();
      expect(useLocalModelStore.getState().stage).toBe("error");
    }
  });

  it("requires ready for synthesis selection and only writes the explicit Ask choice", async () => {
    useLocalModelStore.setState({ stage: "missing" });
    await useLocalModelStore.getState().selectForAsk("generation");
    expect(update).not.toHaveBeenCalled();
    expect(selectRole).not.toHaveBeenCalled();
    useLocalModelStore.setState({ stage: "ready" });
    await useLocalModelStore.getState().selectForAsk("generation");
    expect(selectRole).toHaveBeenLastCalledWith({
      role: "ask", providerId: "builtin-local", modelId: BUILTIN_CHAT_MODEL, effort: "(default)",
    });
    useLocalModelStore.setState({ stage: "error" });
    await useLocalModelStore.getState().selectForAsk("quotes");
    expect(selectRole).toHaveBeenLastCalledWith({
      role: "ask", providerId: "builtin-local", modelId: BUILTIN_MODEL, effort: "(default)",
    });
    expect(ipc.downloadLocalChatModel).not.toHaveBeenCalled();
    useSettingsStore.setState({ saving: true });
    await useLocalModelStore.getState().selectForAsk("generation");
    await useLocalModelStore.getState().selectForIngest();
    expect(selectRole).toHaveBeenCalledTimes(2);
    expect(update).not.toHaveBeenCalled();
  });

  it("checks the pinned 2B artifact independently from an installed 4B model", async () => {
    vi.mocked(ipc.localChatStatus).mockImplementation(async (modelId) =>
      modelId === BUILTIN_FAST_CHAT_MODEL
        ? { model_id: BUILTIN_FAST_CHAT_MODEL, state: "missing", bytes: 0 }
        : READY,
    );
    await useLocalModelStore.getState().checkStatus();
    await useFastLocalModelStore.getState().checkStatus();
    expect(FAST_LOCAL_CHAT_MODEL_BYTES).toBe(1_270_808_032);
    expect(useLocalModelStore.getState().stage).toBe("ready");
    expect(useFastLocalModelStore.getState().stage).toBe("missing");
    expect(ipc.localChatStatus).toHaveBeenCalledWith(BUILTIN_CHAT_MODEL);
    expect(ipc.localChatStatus).toHaveBeenCalledWith(BUILTIN_FAST_CHAT_MODEL);
    expect(ipc.downloadLocalChatModel).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps a late 4B status check separate from a completed 2B status check", async () => {
    const delayed = pending<LocalChatStatus>();
    vi.mocked(ipc.localChatStatus).mockImplementation((modelId) =>
      modelId === BUILTIN_FAST_CHAT_MODEL
        ? Promise.resolve({
            model_id: BUILTIN_FAST_CHAT_MODEL,
            state: "ready",
            bytes: FAST_LOCAL_CHAT_MODEL_BYTES,
          })
        : delayed.promise,
    );
    const large = useLocalModelStore.getState().checkStatus();
    await useFastLocalModelStore.getState().checkStatus();
    expect(useLocalModelStore.getState().stage).toBe("checking");
    expect(useFastLocalModelStore.getState().stage).toBe("ready");
    delayed.resolve(MISSING);
    await large;
    expect(useLocalModelStore.getState().stage).toBe("missing");
    expect(useFastLocalModelStore.getState().stage).toBe("ready");
  });

  it("rejects wrong model identities and wrong sizes on the 2B card", async () => {
    for (const status of [
      READY,
      {
        model_id: BUILTIN_FAST_CHAT_MODEL,
        state: "ready" as const,
        bytes: LOCAL_CHAT_MODEL_BYTES,
      },
      {
        model_id: BUILTIN_FAST_CHAT_MODEL,
        state: "ready" as const,
        bytes: FAST_LOCAL_CHAT_MODEL_BYTES - 1,
      },
    ]) {
      vi.mocked(ipc.localChatStatus).mockResolvedValue(status);
      await useFastLocalModelStore.getState().checkStatus();
      expect(useFastLocalModelStore.getState().stage).toBe("error");
      expect(useFastLocalModelStore.getState().error).toContain(
        "expected artifact",
      );
    }
  });

  it("downloads 2B explicitly and rejects 4B progress before verification", async () => {
    const result = pending<LocalChatStatus>();
    vi.mocked(ipc.downloadLocalChatModel).mockReturnValue(result.promise);
    useFastLocalModelStore.setState({ stage: "missing" });
    const run = useFastLocalModelStore.getState().download();
    await vi.waitFor(() =>
      expect(ipc.downloadLocalChatModel).toHaveBeenCalledWith(
        BUILTIN_FAST_CHAT_MODEL,
      ),
    );
    progress({
      payload: {
        downloaded: LOCAL_CHAT_MODEL_BYTES / 2,
        total: LOCAL_CHAT_MODEL_BYTES,
        pct: 50,
      },
    });
    expect(useFastLocalModelStore.getState().pct).toBe(0);
    progress({
      payload: {
        downloaded: FAST_LOCAL_CHAT_MODEL_BYTES / 2,
        total: FAST_LOCAL_CHAT_MODEL_BYTES,
        pct: 50,
      },
    });
    expect(useFastLocalModelStore.getState()).toMatchObject({
      stage: "downloading",
      pct: 50,
      total: FAST_LOCAL_CHAT_MODEL_BYTES,
    });
    result.resolve({
      model_id: BUILTIN_FAST_CHAT_MODEL,
      state: "ready",
      bytes: FAST_LOCAL_CHAT_MODEL_BYTES,
    });
    await run;
    expect(useFastLocalModelStore.getState()).toMatchObject({
      stage: "ready",
      pct: 100,
    });
    expect(update).not.toHaveBeenCalled();
    expect(off).toHaveBeenCalledOnce();
  });

  it("claims one download lease before listener setup and ignores cancellation by the other card", async () => {
    const listener = pending<() => void>();
    vi.mocked(listen).mockReturnValue(listener.promise);
    useFastLocalModelStore.setState({ stage: "missing" });
    const owner = useLocalModelStore.getState().download();
    await useFastLocalModelStore.getState().download();
    await useFastLocalModelStore.getState().cancelDownload();
    expect(listen).toHaveBeenCalledOnce();
    expect(ipc.cancelLocalChatModelDownload).not.toHaveBeenCalled();
    expect(useFastLocalModelStore.getState().stage).toBe("missing");
    listener.resolve(off);
    await owner;
    expect(ipc.downloadLocalChatModel).toHaveBeenCalledOnce();
    expect(ipc.downloadLocalChatModel).toHaveBeenCalledWith(BUILTIN_CHAT_MODEL);
    vi.mocked(ipc.downloadLocalChatModel).mockResolvedValue({
      model_id: BUILTIN_FAST_CHAT_MODEL,
      state: "ready",
      bytes: FAST_LOCAL_CHAT_MODEL_BYTES,
    });
    await useFastLocalModelStore.getState().download();
    expect(ipc.downloadLocalChatModel).toHaveBeenCalledWith(
      BUILTIN_FAST_CHAT_MODEL,
    );
    expect(useFastLocalModelStore.getState().stage).toBe("ready");
  });

  it("selects each role explicitly without changing the other role or effort preferences", async () => {
    const preferences = {
      query_provider: "anthropic-cli",
      query_model: "sonnet",
      query_effort: "high",
      ingest_provider: "codex-cli",
      ingest_model: "gpt-5.4",
      ingest_effort: "medium",
      model_roles: selectedRolesFixture({ ask: { providerId: "anthropic-cli", modelId: "sonnet", effort: "high" }, compilation: { providerId: "codex-cli", modelId: "gpt-5.4", effort: "medium" } }),
    } as MycoSettings;
    useSettingsStore.setState({ settings: preferences });
    useFastLocalModelStore.setState({ stage: "missing" });
    await useFastLocalModelStore.getState().selectForIngest();
    expect(update).not.toHaveBeenCalled();
    expect(selectRole).not.toHaveBeenCalled();
    useFastLocalModelStore.setState({ stage: "ready" });
    await useFastLocalModelStore.getState().selectForAsk("generation");
    expect(selectRole).toHaveBeenLastCalledWith({
      role: "ask", providerId: "builtin-local", modelId: BUILTIN_FAST_CHAT_MODEL, effort: "(default)",
    });
    expect(useSettingsStore.getState().settings).toMatchObject({
      query_provider: preferences.query_provider, query_model: preferences.query_model,
      query_effort: "high", ingest_effort: "medium",
      model_roles: { roles: { ask: { providerId: "builtin-local", modelId: BUILTIN_FAST_CHAT_MODEL }, compilation: preferences.model_roles!.roles.compilation } },
    });
    await useFastLocalModelStore.getState().selectForIngest();
    expect(selectRole).toHaveBeenLastCalledWith({
      role: "compilation", providerId: "builtin-local", modelId: BUILTIN_FAST_CHAT_MODEL, effort: "(default)",
    });
    useLocalModelStore.setState({ stage: "ready" });
    await useLocalModelStore.getState().selectForIngest();
    expect(selectRole).toHaveBeenLastCalledWith({
      role: "compilation", providerId: "builtin-local", modelId: BUILTIN_CHAT_MODEL, effort: "(default)",
    });
    expect(useSettingsStore.getState().settings).toMatchObject({
      query_provider: preferences.query_provider,
      query_model: preferences.query_model,
      query_effort: "high",
      ingest_provider: preferences.ingest_provider,
      ingest_model: preferences.ingest_model,
      ingest_effort: "medium",
      model_roles: { roles: { ask: { providerId: "builtin-local", modelId: BUILTIN_FAST_CHAT_MODEL }, compilation: { providerId: "builtin-local", modelId: BUILTIN_CHAT_MODEL } } },
    });
    expect(update).not.toHaveBeenCalled();
    expect(ipc.downloadLocalChatModel).not.toHaveBeenCalled();
  });
});
