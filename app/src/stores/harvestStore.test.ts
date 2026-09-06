import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc, type HarvestCandidates } from "../lib/ipc";
import { useHarvestStore } from "./harvestStore";

const result: HarvestCandidates = {
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
});
