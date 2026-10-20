import { beforeEach, describe, expect, it, vi } from "vitest";
import { complete } from "./chat";
import { ipc, type AgentVaultSession, type MycoSettings } from "./ipc";
import { roleFixture, selectedRolesFixture } from "./modelRoles.testSupport";

/** This transport fixture represents explicit choices for each exercised role. */
function selectRoutes(provider: string): void {
  const roles = selectedRolesFixture({ ask: { providerId: provider, modelId: "synthetic" }, compilation: { providerId: provider, modelId: "synthetic" }, organization: { providerId: provider, modelId: "synthetic" } });
  vi.spyOn(ipc, "getSettings").mockResolvedValue({ model_roles: roles } as MycoSettings);
  vi.spyOn(ipc, "captureModelRole").mockImplementation(async (boundOrigin, role, usage) => {
    const choice = roles.roles[role];
    return roleFixture(role, choice.providerId, choice.modelId, boundOrigin, usage, choice.effort);
  });
}

const origin: AgentVaultSession = { vaultPath: "/synthetic", openingToken: "opening-1" };
const output = { stdout: "synthetic answer", stderr: "", status: 0 };

describe("external CLI operation boundary", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(ipc, "agentVaultSession").mockResolvedValue(origin);
    vi.spyOn(ipc, "getDistillConfig").mockRejectedValue(new Error("no synthetic profile"));
    vi.spyOn(ipc, "claudeRun").mockResolvedValue(output);
    vi.spyOn(ipc, "agentRun").mockResolvedValue(output);
    vi.spyOn(ipc, "claudeRunStream").mockResolvedValue(output);
    vi.spyOn(ipc, "semanticSearch").mockResolvedValue({ hits: [], floor: 0.5, below_floor: [] });
  });

  it.each(["anthropic-cli", "codex-cli", "gemini-cli"])("%s sends read-only scope for Ask and generation", async (provider) => {
    selectRoutes(provider);
    for (const task of ["query", "generate"] as const) {
      await complete({ task, cwd: origin.vaultPath, messages: [{ role: "user", content: "synthetic question" }] });
    }
    const execution = { capability: "read-only", origin };
    const calls = provider === "anthropic-cli" ? vi.mocked(ipc.claudeRun).mock.calls : vi.mocked(ipc.agentRun).mock.calls;
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.at(-1)).toEqual(execution);
  });

  it("ingest requests staged publication rather than a read-only or unrestricted tool route", async () => {
    selectRoutes("anthropic-cli");
    await complete({ task: "ingest", cwd: origin.vaultPath, messages: [{ role: "user", content: "synthetic source" }] });
    expect(vi.mocked(ipc.claudeRun).mock.calls[0].at(-1)).toEqual({ capability: "staged-write", origin });
  });

  it("preserves the caller's native opening instead of silently replacing it", async () => {
    selectRoutes("anthropic-cli");
    vi.mocked(ipc.agentVaultSession).mockResolvedValue({ ...origin, openingToken: "opening-2" });
    await complete({ task: "generate", origin, cwd: origin.vaultPath, messages: [{ role: "user", content: "synthetic reflection" }] });
    expect(ipc.agentVaultSession).not.toHaveBeenCalled();
    expect(vi.mocked(ipc.claudeRun).mock.calls[0].at(-1)).toEqual({ capability: "read-only", origin });
  });

  it("refuses another vault before profile/retrieval/provider calls", async () => {
    selectRoutes("codex-cli");
    await expect(complete({ task: "query", cwd: "/another-synthetic", messages: [] })).rejects.toThrow("active vault changed");
    expect(ipc.getDistillConfig).not.toHaveBeenCalled();
    expect(ipc.agentRun).not.toHaveBeenCalled();
  });

  it("surfaces the native unavailable error without switching to another model", async () => {
    selectRoutes("anthropic-cli");
    vi.mocked(ipc.claudeRun).mockRejectedValue(new Error("CLI_EXECUTION_UNAVAILABLE: synthetic boundary"));
    const local = vi.spyOn(ipc, "localQuery");
    const cloud = vi.spyOn(ipc, "chatComplete");
    await expect(complete({ task: "query", cwd: origin.vaultPath, messages: [] })).rejects.toThrow("CLI_EXECUTION_UNAVAILABLE");
    expect(local).not.toHaveBeenCalled();
    expect(cloud).not.toHaveBeenCalled();
    expect(ipc.agentRun).not.toHaveBeenCalled();
  });

  it("passes the same read-only origin to a cancellable run", async () => {
    selectRoutes("anthropic-cli");
    await complete({ task: "query", cwd: origin.vaultPath, messages: [], signal: new AbortController().signal });
    expect(vi.mocked(ipc.claudeRunStream).mock.calls[0].at(-1)).toEqual({ capability: "read-only", origin });
  });

  it("captures the native opening before retrieving evidence and never refreshes it mid-run", async () => {
    selectRoutes("anthropic-cli");
    vi.spyOn(ipc, "embeddingsStatus").mockResolvedValue({ indexed_pages: 0, model: "" });
    vi.spyOn(ipc, "readVaultContext").mockImplementation(async () => {
      vi.mocked(ipc.agentVaultSession).mockResolvedValue({ ...origin, openingToken: "opening-2" });
      return "synthetic selected evidence";
    });
    await complete({ task: "query", cwd: origin.vaultPath, messages: [{ role: "user", content: "synthetic question" }], onStage: () => undefined });
    expect(ipc.agentVaultSession).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ipc.claudeRun).mock.calls[0].at(-1)).toEqual({ capability: "read-only", origin });
    expect(vi.mocked(ipc.claudeRun).mock.calls[0][0]).not.toContain("use Read/Grep");
  });
});
