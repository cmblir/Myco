import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc, type HarvestCandidates } from "../lib/ipc";
import { useHarvestStore } from "./harvestStore";
import { useVaultStore } from "./vaultStore";

const result: HarvestCandidates = {
  read_status: "complete",
  read_issues: [],
  items: [],
  excluded: { duplicate: 0, boilerplate: 0, too_small: 0, too_large: 0, already_harvested: 0 },
  total_scanned: 0,
  distinct_bodies: 0,
  eligible: 0,
};

describe("harvestStore", () => {
  beforeEach(() => {
    useHarvestStore.setState({ data: null, error: null, loading: false, scannedPath: null });
    vi.restoreAllMocks();
  });

  it("fetches once per vault and serves the cache afterwards", async () => {
    const spy = vi.spyOn(ipc, "harvestCandidates").mockResolvedValue(result);
    await useHarvestStore.getState().load("/v");
    await useHarvestStore.getState().load("/v");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(useHarvestStore.getState().data).toBe(result);
  });

  it("refetches on a vault switch and on force", async () => {
    const spy = vi.spyOn(ipc, "harvestCandidates").mockResolvedValue(result);
    await useHarvestStore.getState().load("/a");
    await useHarvestStore.getState().load("/b");
    await useHarvestStore.getState().load("/b", true);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(useHarvestStore.getState().scannedPath).toBe("/b");
  });

  it("keeps the error and clears data when the command fails", async () => {
    vi.spyOn(ipc, "harvestCandidates").mockRejectedValue(new Error("boom"));
    await useHarvestStore.getState().load("/v");
    const s = useHarvestStore.getState();
    expect(s.data).toBeNull();
    expect(s.error).toContain("boom");
    expect(s.loading).toBe(false);
  });

  it("starts the new vault scan even while the old vault is loading", async () => {
    let resolveOld!: (value: HarvestCandidates) => void;
    const old = new Promise<HarvestCandidates>((resolve) => { resolveOld = resolve; });
    const next = { ...result, eligible: 2 };
    const spy = vi.spyOn(ipc, "harvestCandidates")
      .mockReturnValueOnce(old).mockResolvedValueOnce(next);
    const first = useHarvestStore.getState().load("/a");
    await useHarvestStore.getState().load("/b");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(useHarvestStore.getState().scannedPath).toBe("/b");
    resolveOld(result);
    await first;
    expect(useHarvestStore.getState().data).toBe(next);
    expect(useHarvestStore.getState().scannedPath).toBe("/b");
  });

  it("clears the previous vault's candidates while the next scan is pending", async () => {
    vi.spyOn(ipc, "harvestCandidates").mockResolvedValueOnce(result)
      .mockImplementationOnce(() => new Promise(() => undefined));
    await useHarvestStore.getState().load("/a");
    void useHarvestStore.getState().load("/b");
    expect(useHarvestStore.getState().data).toBeNull();
    expect(useHarvestStore.getState().scannedPath).toBe("/b");
  });

  it("clears candidates and rejects a late scan after reopening the same vault", async () => {
    useVaultStore.setState({ vaultToken: "harvest-open-1" });
    let answer!: (value: HarvestCandidates) => void;
    vi.spyOn(ipc, "harvestCandidates").mockResolvedValueOnce(result)
      .mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    await useHarvestStore.getState().load("/v");
    const pending = useHarvestStore.getState().load("/v", true);
    useVaultStore.setState({ vaultToken: "harvest-open-2" });
    expect(useHarvestStore.getState().data).toBeNull();
    answer({ ...result, eligible: 9 });
    await pending;
    expect(useHarvestStore.getState().data).toBeNull();
    expect(useHarvestStore.getState().loading).toBe(false);
  });

  it("does not attach an old scan failure to the next vault opening", async () => {
    useVaultStore.setState({ vaultToken: "harvest-read-old" });
    let rejectOld!: (reason: Error) => void;
    vi.spyOn(ipc, "harvestCandidates")
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }))
      .mockResolvedValueOnce(result);
    const old = useHarvestStore.getState().load("/a");
    useVaultStore.setState({ vaultToken: "harvest-read-new" });
    await useHarvestStore.getState().load("/b");
    rejectOld(new Error("Synthetic old opening scan failure"));
    await old;
    expect(useHarvestStore.getState().scannedPath).toBe("/b");
    expect(useHarvestStore.getState().data).toBe(result);
    expect(useHarvestStore.getState().error).toBeNull();
    expect(useHarvestStore.getState().loading).toBe(false);
  });
});
