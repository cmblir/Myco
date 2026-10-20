import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { ipc } from "./ipc";

beforeEach(() => { invoke.mockReset().mockResolvedValue(undefined); });

describe("dashboard save identity", () => {
  it("sends a captured vaultPath across the IPC boundary", async () => {
    await ipc.saveDashboard("overview-layout", "{}", "/synthetic/vault-a");
    expect(invoke).toHaveBeenCalledWith("save_dashboard", { name: "overview-layout", content: "{}", vaultPath: "/synthetic/vault-a" });
  });

  it("preserves the existing dashboard writer's optional argument", async () => {
    await ipc.saveDashboard("overview", "{}");
    expect(invoke).toHaveBeenCalledWith("save_dashboard", { name: "overview", content: "{}", vaultPath: undefined });
  });
});
