import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { LAST_VAULT_KEY, useVaultStore } from "./vaultStore";

const savedPath = "/synthetic/external-notes";
const defaultPath = "/synthetic/Documents/myco";
const storage = new Map<string, string>();

beforeEach(() => {
  vi.restoreAllMocks();
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  useVaultStore.setState({ currentVault: null, isLoading: false, isOpeningVault: false, error: null });
  vi.spyOn(ipc, "ensureDefaultVault").mockResolvedValue(defaultPath);
  vi.spyOn(ipc, "openVault").mockImplementation(async (path) => ({
    path,
    name: "Synthetic",
  }));
  vi.spyOn(ipc, "listFiles").mockResolvedValue([]);
  vi.spyOn(ipc, "buildLinkGraph").mockResolvedValue({
    forward: {},
    backward: {},
    unresolved: {},
    tags: {},
  });
  vi.spyOn(ipc, "readFile").mockResolvedValue({
    path: "favorites.json",
    raw: "[]",
    content: "[]",
    frontmatter: null,
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("vault startup permission scope", () => {
  it("restores the saved vault without accessing Documents", async () => {
    storage.set(LAST_VAULT_KEY, savedPath);
    await useVaultStore.getState().restoreVault();
    expect(ipc.ensureDefaultVault).not.toHaveBeenCalled();
    expect(ipc.openVault).toHaveBeenCalledTimes(1);
    expect(ipc.openVault).toHaveBeenCalledWith(savedPath);
    expect(useVaultStore.getState().currentVault?.path).toBe(savedPath);
  });

  it("keeps a failed saved path for explicit retry instead of opening another folder", async () => {
    storage.set(LAST_VAULT_KEY, savedPath);
    vi.mocked(ipc.openVault).mockRejectedValueOnce(
      new Error("Synthetic permission denied"),
    );
    await useVaultStore.getState().restoreVault();
    expect(ipc.ensureDefaultVault).not.toHaveBeenCalled();
    expect(useVaultStore.getState().error).toBe("Synthetic permission denied");
    expect(storage.get(LAST_VAULT_KEY)).toBe(savedPath);
    await useVaultStore.getState().restoreVault();
    expect(useVaultStore.getState().currentVault?.path).toBe(savedPath);
    expect(useVaultStore.getState().error).toBeNull();
  });

  it("seeds the default folder only on first launch", async () => {
    await useVaultStore.getState().restoreVault();
    expect(ipc.ensureDefaultVault).toHaveBeenCalledTimes(1);
    expect(ipc.openVault).toHaveBeenCalledTimes(1);
    expect(ipc.openVault).toHaveBeenCalledWith(defaultPath);
  });

  it("surfaces first-launch folder errors without unhandled rejection", async () => {
    vi.mocked(ipc.ensureDefaultVault).mockRejectedValue(
      new Error("Synthetic Documents denied"),
    );
    await useVaultStore.getState().restoreVault();
    expect(useVaultStore.getState().error).toBe("Synthetic Documents denied");
    expect(useVaultStore.getState().isLoading).toBe(false);
    expect(ipc.openVault).not.toHaveBeenCalled();
  });

  it("uses an explicit preview path without probing the saved or default folder", async () => {
    storage.set(LAST_VAULT_KEY, savedPath);
    await useVaultStore.getState().restoreVault("/synthetic/preview");
    expect(ipc.openVault).toHaveBeenCalledTimes(1);
    expect(ipc.openVault).toHaveBeenCalledWith("/synthetic/preview");
    expect(ipc.ensureDefaultVault).not.toHaveBeenCalled();
  });

  it("does not re-open or seed an already opened vault", async () => {
    useVaultStore.setState({
      currentVault: { path: savedPath, name: "Synthetic" },
    });
    await useVaultStore.getState().restoreVault();
    expect(ipc.openVault).not.toHaveBeenCalled();
    expect(ipc.ensureDefaultVault).not.toHaveBeenCalled();
  });

  it("does not replace a user-selected vault when first-launch seeding finishes late", async () => {
    let finish!: (path: string) => void;
    vi.mocked(ipc.ensureDefaultVault).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const restoring = useVaultStore.getState().restoreVault();
    await useVaultStore.getState().openVault(savedPath);
    finish(defaultPath);
    await restoring;
    expect(ipc.openVault).toHaveBeenCalledTimes(1);
    expect(ipc.openVault).toHaveBeenCalledWith(savedPath);
    expect(useVaultStore.getState().currentVault?.path).toBe(savedPath);
  });

  it("marks first-launch preparation as vault opening until its accepted root is ready", async () => {
    const previous = useVaultStore.getState().vaultToken;
    let finish!: (path: string) => void;
    vi.mocked(ipc.ensureDefaultVault).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = useVaultStore.getState().restoreVault();
    const during = useVaultStore.getState();
    finish(defaultPath);
    await pending;
    expect(during.isOpeningVault).toBe(true);
    expect(during.vaultToken).not.toBe(previous);
    expect(useVaultStore.getState().vaultToken).not.toBe(during.vaultToken);
    expect(useVaultStore.getState()).toMatchObject({ currentVault: { path: defaultPath }, isOpeningVault: false });
  });

  it("ends first-launch opening when default-folder preparation fails", async () => {
    vi.mocked(ipc.ensureDefaultVault).mockRejectedValueOnce(new Error("Synthetic default preparation failure"));
    await useVaultStore.getState().restoreVault();
    expect(useVaultStore.getState()).toMatchObject({
      currentVault: null, isOpeningVault: false, isLoading: false, error: "Synthetic default preparation failure",
    });
  });
});
