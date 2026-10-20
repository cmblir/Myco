import { beforeEach, describe, expect, it, vi } from "vitest";

const { listenMock } = vi.hoisted(() => ({
  listenMock: vi.fn().mockResolvedValue(() => undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));
vi.mock("../lib/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Only the LLM call is stubbed (distillStore/reflectStore idiom). The local
// pass never reaches it — that is the whole point of the branch under test.
const complete = vi.fn();
vi.mock("../lib/chat", () => ({
  complete: (...a: unknown[]) => complete(...a),
}));

const captureModelRole = vi.fn();
const lintLocal = vi.fn();
const buildLinkGraph = vi.fn();
const agentVaultSession = vi.fn();
const claudeRunStream = vi.fn();
vi.mock("../lib/ipc", () => ({
  ipc: {
    captureModelRole: (...a: unknown[]) => captureModelRole(...a),
    lintLocal: (...a: unknown[]) => lintLocal(...a),
    buildLinkGraph: (...a: unknown[]) => buildLinkGraph(...a),
    agentVaultSession: (...a: unknown[]) => agentVaultSession(...a),
    claudeRunStream: (...a: unknown[]) => claudeRunStream(...a),
  },
}));

import { useLintStore } from "./lintStore";
import { useUIStore } from "./uiStore";
import { useVaultStore } from "./vaultStore";
import { roleFixture, syntheticOrigin } from "../lib/modelRoles.testSupport";

const emptyGraph = { forward: {}, backward: {}, unresolved: {}, tags: {} };
const cleanReport = { critical: [], warning: [], info: [] };

describe("useLintStore.runLint", () => {
  beforeEach(() => {
    complete.mockReset();
    captureModelRole.mockReset();
    lintLocal.mockReset();
    buildLinkGraph.mockReset();
    agentVaultSession.mockReset().mockResolvedValue(syntheticOrigin);
    claudeRunStream.mockReset();
    useUIStore.setState({ lang: "en" });
    useVaultStore.setState({
      currentVault: { path: "/v", name: "v" },
      fileTree: [
        {
          kind: "directory",
          name: "wiki",
          path: "/v/wiki",
          children: [
            { kind: "file", name: "a.md", path: "/v/wiki/a.md" },
            { kind: "file", name: "b.md", path: "/v/wiki/b.md" },
          ],
        },
        // Machine-written: must never reach the linter.
        {
          kind: "directory",
          name: "daily",
          path: "/v/daily",
          children: [
            { kind: "file", name: "2026-08-01.md", path: "/v/daily/2026-08-01.md" },
          ],
        },
      ],
    });
    useLintStore.setState({
      stage: "idle",
      report: null,
      progress: "",
      startedAt: null,
      finishedAt: null,
      seen: true,
    });
  });

  it("builtin-local: renders the local report and never calls complete()", async () => {
    captureModelRole.mockResolvedValue(roleFixture("lint", "builtin-local", "extractive-retrieval"));
    lintLocal.mockResolvedValue({
      critical: [
        {
          page: "wiki/a.md",
          kind: "dangling_citation",
          detail: "[^src-ghost] has no raw/ghost.md",
        },
      ],
      warning: [],
      info: [],
    });
    buildLinkGraph.mockResolvedValue(emptyGraph);

    await useLintStore.getState().runLint();

    expect(complete).not.toHaveBeenCalled();
    // Only the knowledge pages are linted — daily/ is filtered by the shared
    // classifier before the IPC call, not inside Rust.
    expect(lintLocal).toHaveBeenCalledWith("/v", ["wiki/a.md", "wiki/b.md"]);
    const s = useLintStore.getState();
    expect(s.stage).toBe("done");
    expect(s.report).toContain("Wiki lint — local pass");
    expect(s.report).toContain("wiki/a.md");
  });

  it("connected provider: unchanged LLM path (complete() with LINT_PROMPT)", async () => {
    captureModelRole.mockResolvedValue(roleFixture("lint", "openai-api", "synthetic"));
    complete.mockResolvedValue("## Critical\n- something");

    await useLintStore.getState().runLint();

    expect(lintLocal).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
    const arg = complete.mock.calls[0][0] as {
      task: string;
      cwd: string;
      messages: { role: string; content: string }[];
    };
    expect(arg.task).toBe("generate");
    expect(arg.cwd).toBe("/v");
    expect(arg.messages[0].content).toContain("Run the wiki lint checklist");
    expect(useLintStore.getState().report).toBe("## Critical\n- something");
  });

  it("a clean vault still renders a report, not an empty string", async () => {
    useVaultStore.setState({ fileTree: [] });
    captureModelRole.mockResolvedValue(roleFixture("lint", "builtin-local", "extractive-retrieval"));
    lintLocal.mockResolvedValue(cleanReport);
    buildLinkGraph.mockResolvedValue(emptyGraph);

    await useLintStore.getState().runLint();

    expect(useLintStore.getState().report).toContain("No issues found.");
  });

  it("streaming lint requests read-only execution and surfaces native unavailability", async () => {
    const roleSnapshot = roleFixture("lint", "anthropic-cli", "synthetic", syntheticOrigin, "foreground", "high");
    captureModelRole.mockResolvedValue(roleSnapshot);
    const origin = { vaultPath: "/v", openingToken: "synthetic-opening" };
    agentVaultSession.mockResolvedValue(origin);
    claudeRunStream.mockRejectedValue(new Error("CLI_EXECUTION_UNAVAILABLE: synthetic boundary"));
    await useLintStore.getState().runLint();
    expect(claudeRunStream.mock.calls[0].at(-1)).toEqual({ capability: "read-only", origin, roleSnapshot });
    expect(agentVaultSession).toHaveBeenCalledOnce();
    expect(useLintStore.getState().stage).toBe("error");
    expect(useLintStore.getState().report).toContain("CLI_EXECUTION_UNAVAILABLE");
    expect(complete).not.toHaveBeenCalled();
  });
});
