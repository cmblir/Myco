import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc, type MycoSettings } from "./ipc";
import { complete, roleFor } from "./chat";
import { roleFixture, roleSettingsFixture, syntheticOrigin } from "./modelRoles.testSupport";
import { BUILTIN_CHAT_MODEL } from "./providers";

beforeEach(() => vi.restoreAllMocks());
describe("feature route authority", () => {
  it("preserved external display choices never override independent local role defaults", () => {
    const settings = { query_provider: "openai-api", query_model: "synthetic-legacy", ingest_provider: "anthropic-cli", model_roles: roleSettingsFixture() } as MycoSettings;
    for (const role of ["query", "ingest", "generate", "reflect", "lint", "study", "audio", "agent"] as const) expect(roleFor(role, settings).provider).toBe("builtin-local");
    expect(() => roleFor("query", { query_provider: "openai-api" } as MycoSettings)).toThrow("native feature selections are unavailable");
  });
  it("an explicit Ask external choice grants no external selection to other features", () => {
    const roles = roleSettingsFixture();
    roles.roles.ask = { ...roles.roles.ask, providerId: "openai-api", modelId: "synthetic-selected", selection: "explicit-external" };
    const settings = { model_roles: roles } as MycoSettings;
    expect(roleFor("query", settings).provider).toBe("openai-api");
    expect(roleFor("generate", settings).provider).toBe("builtin-local");
    expect(roleFor("study", settings).model).toBe(BUILTIN_CHAT_MODEL);
  });
  it("rejects missing native consent before provider, profile and retrieval calls", async () => {
    vi.spyOn(ipc, "agentVaultSession").mockResolvedValue(syntheticOrigin);
    vi.spyOn(ipc, "captureModelRole").mockRejectedValue(new Error("route_unconfirmed"));
    const remote = vi.spyOn(ipc, "chatComplete"); const local = vi.spyOn(ipc, "localQuery");
    const reads = vi.spyOn(ipc, "readVaultContext");
    await expect(complete({ task: "generate", featureRole: "study", cwd: "/v", messages: [{ role: "user", content: "synthetic topic" }] })).rejects.toThrow("route_unconfirmed");
    expect(remote).not.toHaveBeenCalled(); expect(local).not.toHaveBeenCalled(); expect(reads).not.toHaveBeenCalled();
  });
  it("uses a captured job grant and leaves missing weights pending without recapture or cloud fallback", async () => {
    const capture = vi.spyOn(ipc, "captureModelRole"); const remote = vi.spyOn(ipc, "chatComplete"); const local = vi.spyOn(ipc, "localQuery");
    vi.spyOn(ipc, "getDistillConfig").mockRejectedValue(new Error("synthetic profile unavailable"));
    vi.spyOn(ipc, "localChatStatus").mockResolvedValue({ state: "missing", model_id: BUILTIN_CHAT_MODEL, bytes: 0 });
    const snapshot = roleFixture("organization");
    await expect(complete({ task: "generate", featureRole: "organization", roleSnapshot: snapshot, cwd: "/v", messages: [{ role: "user", content: "synthetic topic" }] })).rejects.toThrow("local_model_preparation_required");
    expect(capture).not.toHaveBeenCalled(); expect(remote).not.toHaveBeenCalled(); expect(local).not.toHaveBeenCalled();
  });
  it("foreground grant cannot be reused for an automatic operation", async () => {
    const remote = vi.spyOn(ipc, "chatComplete"); const snapshot = roleFixture("reflect", "ollama", "synthetic-selected");
    await expect(complete({ task: "generate", featureRole: "reflect", usage: "automatic", roleSnapshot: snapshot, cwd: "/v", messages: [] })).rejects.toThrow("native feature grant");
    expect(remote).not.toHaveBeenCalled();
  });
});
