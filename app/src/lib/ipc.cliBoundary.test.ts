import { beforeEach, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { ipc, type CliExecutionRequest } from "./ipc";

beforeEach(() => invoke.mockClear());

it("serializes the capability and native opening on all public CLI commands", async () => {
  const execution: CliExecutionRequest = {
    capability: "read-only",
    origin: { vaultPath: "/synthetic", openingToken: "synthetic-opening" },
  };
  await ipc.claudeRun("question", "/synthetic", "model", "high", execution);
  await ipc.claudeRunStream("run", "question", "/synthetic", "model", "high", execution);
  await ipc.agentRun("codex-cli", "model", "question", "/synthetic", "high", execution);
  expect(invoke.mock.calls.map((call) => call[0])).toEqual(["claude_run", "claude_run_stream", "agent_run"]);
  for (const call of invoke.mock.calls) expect(call[1]).toMatchObject({ cwd: "/synthetic", execution });
});

it("does not invent an implicit execution capability for legacy writers", async () => {
  await ipc.claudeRun("legacy source", "/synthetic");
  expect(invoke).toHaveBeenCalledWith("claude_run", expect.objectContaining({ execution: undefined }));
});
