import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "./ipc";
import { defaultOverviewLayout, emptyBoard, saveBoard, saveOverviewLayout } from "./board";

vi.mock("./ipc", () => ({ ipc: { saveDashboard: vi.fn() } }));

beforeEach(() => { vi.mocked(ipc.saveDashboard).mockReset(); });

describe("saveOverviewLayout", () => {
  it("passes the captured vault identity to the native dashboard writer", async () => {
    const layout = defaultOverviewLayout();
    await saveOverviewLayout(layout, "/synthetic/vault-a");
    expect(ipc.saveDashboard).toHaveBeenCalledWith("overview-layout", JSON.stringify(layout, null, 2), "/synthetic/vault-a");
  });

  it("keeps a switched-vault rejection visible to the caller", async () => {
    vi.mocked(ipc.saveDashboard).mockRejectedValue(new Error("active vault changed"));
    await expect(saveOverviewLayout(defaultOverviewLayout(), "/synthetic/vault-a")).rejects.toThrow("active vault changed");
  });

  it("refuses to enqueue an unguarded layout write", async () => {
    await expect(saveOverviewLayout(defaultOverviewLayout(), "")).rejects.toThrow("vault path is required");
    expect(ipc.saveDashboard).not.toHaveBeenCalled();
  });
});

describe("saveBoard", () => {
  it("can guard a pending board write with its captured vault", async () => {
    const doc = emptyBoard();
    await saveBoard("overview", doc, "/synthetic/vault-a");
    expect(ipc.saveDashboard).toHaveBeenCalledWith("overview", JSON.stringify(doc, null, 2), "/synthetic/vault-a");
  });

  it("preserves legacy callers without an explicit vault", async () => {
    const doc = emptyBoard();
    await saveBoard("overview", doc);
    expect(ipc.saveDashboard).toHaveBeenCalledWith("overview", JSON.stringify(doc, null, 2), undefined);
  });
});
