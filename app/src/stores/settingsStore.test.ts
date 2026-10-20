import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "./settingsStore";
import { ipc } from "../lib/ipc";
import type { MycoSettings } from "../lib/ipc";
import { selectedRolesFixture } from "../lib/modelRoles.testSupport";

// Legacy model display fields still persist through the general settings queue.
// These mocked receipts do not grant native role selection or CLI execution.
const BASE = {
  providers: {
    anthropic_cli: true,
    gemini_cli: true,
    codex_cli: true,
    anthropic_api: false,
    openai_api: false,
    google_api: false,
    ollama: false,
    openrouter: false,
    myco_pro: false,
    builtin_local: true,
  },
  query_provider: "anthropic-cli",
  query_model: "sonnet",
  ingest_provider: "anthropic-cli",
  ingest_model: "haiku",
  query_effort: "(default)",
  ingest_effort: "(default)",
} as unknown as MycoSettings;

describe("settingsStore.update — model selection persistence", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useSettingsStore.setState({ settings: BASE, loading: false, error: null });
  });

  it.each([
    ["gemini-cli", "gemini-2.5-pro"],
    ["codex-cli", "gpt-5.6-sol"],
  ])("picking %s / %s persists to settings", async (provider, model) => {
    const setSettings = vi
      .spyOn(ipc, "setSettings")
      .mockImplementation(async (settings) => settings);

    await useSettingsStore
      .getState()
      .update({ query_provider: provider, query_model: model });

    expect(useSettingsStore.getState().settings?.query_provider).toBe(provider);
    expect(useSettingsStore.getState().settings?.query_model).toBe(model);
    expect(setSettings).toHaveBeenCalledWith(
      expect.objectContaining({ query_provider: provider, query_model: model }),
    );
  });

  // Legacy effort display fields retain the same persistence contract.
  it.each([
    ["query_effort", "xhigh"],
    ["ingest_effort", "low"],
  ])("picking %s = %s persists to settings", async (key, level) => {
    const setSettings = vi
      .spyOn(ipc, "setSettings")
      .mockImplementation(async (settings) => settings);

    await useSettingsStore.getState().update({ [key]: level });

    expect(
      useSettingsStore.getState().settings?.[key as keyof MycoSettings],
    ).toBe(level);
    expect(setSettings).toHaveBeenCalledWith(
      expect.objectContaining({ [key]: level }),
    );
  });
});

describe("settingsStore.setNotchEnabled", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useSettingsStore.setState({
      settings: { ...BASE, notch_enabled: true },
      notchPending: false,
      notchError: null,
    });
  });

  it("keeps the native flag optimistic and uses only the notch command", async () => {
    let finish!: () => void;
    const updateNotch = vi.spyOn(ipc, "updateNotchEnabled").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(null);
        }),
    );
    const saveAll = vi
      .spyOn(ipc, "setSettings")
      .mockImplementation(async (settings) => settings);
    const changing = useSettingsStore.getState().setNotchEnabled(false);
    expect(useSettingsStore.getState().settings?.notch_enabled).toBe(false);
    expect(useSettingsStore.getState().notchPending).toBe(true);
    await useSettingsStore.getState().setNotchEnabled(true);
    expect(updateNotch).toHaveBeenCalledTimes(1);
    finish();
    await changing;
    expect(useSettingsStore.getState().notchPending).toBe(false);
    expect(useSettingsStore.getState().notchError).toBeNull();
    expect(saveAll).not.toHaveBeenCalled();
  });

  it("rolls back only the notch flag on failure and allows a retry", async () => {
    let fail!: (reason: Error) => void;
    vi.spyOn(ipc, "updateNotchEnabled")
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject;
          }),
      )
      .mockResolvedValue(null);
    const changing = useSettingsStore.getState().setNotchEnabled(false);
    useSettingsStore.setState((state) => ({
      settings: { ...state.settings!, query_model: "synthetic-new-model" },
    }));
    fail(new Error("Synthetic settings write failure"));
    await changing;
    expect(useSettingsStore.getState().settings?.notch_enabled).toBe(true);
    expect(useSettingsStore.getState().settings?.query_model).toBe(
      "synthetic-new-model",
    );
    expect(useSettingsStore.getState().notchError).toBe(
      "Synthetic settings write failure",
    );
    expect(useSettingsStore.getState().notchPending).toBe(false);
    await useSettingsStore.getState().setNotchEnabled(false);
    expect(useSettingsStore.getState().settings?.notch_enabled).toBe(false);
    expect(useSettingsStore.getState().notchError).toBeNull();
  });
});

function deferredSave<T = MycoSettings>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("settingsStore concurrent changes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useSettingsStore.setState({
      settings: { ...BASE, tray_resident: false, notch_enabled: true },
      loading: false,
      error: null,
      notchPending: false,
      notchError: null,
    });
  });

  it("serializes disk writes while keeping the latest changes visible", async () => {
    const first = deferredSave();
    const save = vi
      .spyOn(ipc, "setSettings")
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async (settings) => settings);
    const earlier = useSettingsStore
      .getState()
      .update({ query_model: "model-a" });
    const later = useSettingsStore
      .getState()
      .update({ query_model: "model-b" });
    expect(useSettingsStore.getState().settings?.query_model).toBe("model-b");
    expect(useSettingsStore.getState().saving).toBe(true);
    expect(useSettingsStore.getState().saved).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
    first.resolve(save.mock.calls[0][0]);
    await Promise.all([earlier, later]);
    expect(save).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ query_model: "model-b" }),
    );
    expect(useSettingsStore.getState().saving).toBe(false);
    expect(useSettingsStore.getState().saved).toBe(true);
  });

  it("does not persist or restore a failed earlier change with a later save", async () => {
    const first = deferredSave();
    const save = vi
      .spyOn(ipc, "setSettings")
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async (settings) => settings);
    const earlier = useSettingsStore.getState().update({ tray_resident: true });
    const later = useSettingsStore
      .getState()
      .update({ query_model: "model-b" });
    first.reject(new Error("Synthetic write failure"));
    await Promise.all([earlier, later]);
    expect(useSettingsStore.getState().settings).toEqual(
      expect.objectContaining({
        tray_resident: false,
        query_model: "model-b",
      }),
    );
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tray_resident: false,
        query_model: "model-b",
      }),
    );
    expect(useSettingsStore.getState().error).toBe("Synthetic write failure");
    expect(useSettingsStore.getState().saving).toBe(false);
    expect(useSettingsStore.getState().saved).toBe(false);
  });

  it("restores the last saved value when the later change to the same field fails", async () => {
    const first = deferredSave();
    const save = vi
      .spyOn(ipc, "setSettings")
      .mockImplementationOnce(() => first.promise)
      .mockRejectedValueOnce(new Error("Second write failed"));
    const earlier = useSettingsStore
      .getState()
      .update({ query_model: "model-a" });
    const later = useSettingsStore
      .getState()
      .update({ query_model: "model-b" });
    first.resolve(save.mock.calls[0][0]);
    await Promise.all([earlier, later]);
    expect(useSettingsStore.getState().settings?.query_model).toBe("model-a");
  });

  it("keeps separate provider flags independent after an earlier failure", async () => {
    const first = deferredSave();
    const save = vi
      .spyOn(ipc, "setSettings")
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async (settings) => settings);
    const earlier = useSettingsStore
      .getState()
      .setProviderConnected("openai_api", true);
    const later = useSettingsStore
      .getState()
      .setProviderConnected("ollama", true);
    const rejected = expect(earlier).rejects.toThrow("Provider write failed");
    const succeeded = expect(later).resolves.toBeUndefined();
    first.reject(new Error("Provider write failed"));
    await Promise.all([rejected, succeeded]);
    expect(useSettingsStore.getState().settings?.providers).toEqual(
      expect.objectContaining({
        openai_api: false,
        ollama: true,
      }),
    );
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        providers: expect.objectContaining({ openai_api: false, ollama: true }),
      }),
    );
  });

  it("rejects its own provider write failure without changing roles and permits a retry", async () => {
    const roles = selectedRolesFixture({ reflect: {
      providerId: "openai-api", modelId: "synthetic-retained-model",
    } });
    roles.roles.reflect.automaticExternalAllowed = true;
    const settings = { ...BASE, providers: { ...BASE.providers, openai_api: true },
      model_roles: roles, role_authorization_revision: "a".repeat(64) };
    useSettingsStore.setState({ settings });
    const failed = deferredSave();
    vi.spyOn(ipc, "setSettings")
      .mockImplementationOnce(() => failed.promise)
      .mockImplementation(async (next) => next);
    const select = vi.spyOn(ipc, "selectModelRole");
    const automatic = vi.spyOn(ipc, "setRoleAutomaticUse");
    const changing = useSettingsStore.getState().setProviderConnected("openai_api", false);
    const rejected = expect(changing).rejects.toThrow("Provider write failed");
    failed.reject(new Error("Provider write failed"));
    await rejected;
    expect(useSettingsStore.getState().settings?.providers.openai_api).toBe(true);
    expect(useSettingsStore.getState().error).toBe("Provider write failed");
    expect(useSettingsStore.getState().saving).toBe(false);
    expect(useSettingsStore.getState().saved).toBe(false);
    await useSettingsStore.getState().setProviderConnected("openai_api", false);
    const saved = useSettingsStore.getState();
    expect(saved.settings?.providers.openai_api).toBe(false);
    expect(saved.error).toBeNull();
    expect(saved.settings?.model_roles).toEqual(roles);
    expect(saved.settings?.role_authorization_revision).toBe("a".repeat(64));
    expect(select).not.toHaveBeenCalled();
    expect(automatic).not.toHaveBeenCalled();
  });

  it("does not report an unrelated queued save error as a provider failure", async () => {
    const first = deferredSave();
    const save = vi.spyOn(ipc, "setSettings")
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async (next) => next);
    const earlier = useSettingsStore.getState().update({ tray_resident: true });
    const later = useSettingsStore.getState().setProviderConnected("openai_api", true);
    const succeeded = expect(later).resolves.toBeUndefined();
    first.reject(new Error("Unrelated settings write failed"));
    await Promise.all([earlier, succeeded]);
    expect(useSettingsStore.getState().settings?.providers.openai_api).toBe(true);
    expect(useSettingsStore.getState().settings?.tray_resident).toBe(false);
    expect(useSettingsStore.getState().error).toBe("Unrelated settings write failed");
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({
      tray_resident: false,
      providers: expect.objectContaining({ openai_api: true }),
    }));
  });

  it("refuses a provider action before settings are loaded", async () => {
    useSettingsStore.setState({ settings: null });
    const save = vi.spyOn(ipc, "setSettings");
    await expect(useSettingsStore.getState().setProviderConnected("openai_api", false))
      .rejects.toThrow("Settings are not loaded");
    expect(save).not.toHaveBeenCalled();
  });

  it("waits for the native notch transaction before writing other settings", async () => {
    const notch = deferredSave<null>();
    vi.spyOn(ipc, "updateNotchEnabled").mockImplementation(() => notch.promise);
    const save = vi
      .spyOn(ipc, "setSettings")
      .mockImplementation(async (settings) => settings);
    const hiding = useSettingsStore.getState().setNotchEnabled(false);
    const changing = useSettingsStore
      .getState()
      .update({ tray_resident: true });
    expect(save).not.toHaveBeenCalled();
    notch.reject(new Error("Native toggle failed"));
    await Promise.all([hiding, changing]);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ notch_enabled: true, tray_resident: true }),
    );
    expect(useSettingsStore.getState().settings).toEqual(
      expect.objectContaining({ notch_enabled: true, tray_resident: true }),
    );
  });

  it("does not write an optimistic notch flag before its native transaction", async () => {
    const first = deferredSave();
    const save = vi
      .spyOn(ipc, "setSettings")
      .mockImplementation(() => first.promise);
    const notch = vi.spyOn(ipc, "updateNotchEnabled").mockResolvedValue(null);
    const changing = useSettingsStore
      .getState()
      .update({ tray_resident: true });
    const hiding = useSettingsStore.getState().setNotchEnabled(false);
    expect(notch).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ notch_enabled: true }),
    );
    first.reject(new Error("General write failed"));
    await Promise.all([changing, hiding]);
    expect(useSettingsStore.getState().settings).toEqual(
      expect.objectContaining({ tray_resident: false, notch_enabled: false }),
    );
    expect(notch).toHaveBeenCalledWith(false);
  });

  it("does not overwrite pending changes with an older reload response", async () => {
    let finishRead!: (settings: MycoSettings) => void;
    const disk = { ...BASE, query_model: "model-b" };
    const read = vi
      .spyOn(ipc, "getSettings")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRead = resolve;
          }),
      )
      .mockResolvedValue(disk);
    vi.spyOn(ipc, "ollamaStatus").mockResolvedValue({
      daemon_running: false,
      models: [],
    } as never);
    const write = deferredSave();
    const save = vi
      .spyOn(ipc, "setSettings")
      .mockImplementation(() => write.promise);
    const reload = useSettingsStore.getState().load();
    const changing = useSettingsStore
      .getState()
      .update({ query_model: "model-b" });
    finishRead(BASE);
    await Promise.resolve();
    expect(useSettingsStore.getState().settings?.query_model).toBe("model-b");
    expect(read).toHaveBeenCalledTimes(1);
    write.resolve(save.mock.calls[0][0]);
    await Promise.all([reload, changing]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(useSettingsStore.getState().settings?.query_model).toBe("model-b");
  });
});
