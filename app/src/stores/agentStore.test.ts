import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunOpts, AgentRunResult } from "../lib/agentLoop";
import type * as DialogStoreModule from "./dialogStore";
import { roleFixture } from "../lib/modelRoles.testSupport";

const runAgent = vi.fn();
const agentToolsSchema = vi.fn();
const agentVaultSession = vi.fn();
const captureModelRole = vi.fn();
const readFile = vi.fn();
const confirmAction = vi.fn();
vi.mock("../lib/agentLoop", () => ({ runAgent: (...args: unknown[]) => runAgent(...args) }));
vi.mock("../lib/ipc", () => ({ ipc: {
  agentToolsSchema: (...args: unknown[]) => agentToolsSchema(...args),
  agentVaultSession: (...args: unknown[]) => agentVaultSession(...args),
  captureModelRole: (...args: unknown[]) => captureModelRole(...args),
  readFile: (...args: unknown[]) => readFile(...args),
} }));
vi.mock("./dialogStore", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  confirmAction: (...args: unknown[]) => confirmAction(...args),
}));
vi.mock("../components/DiffView", () => ({ default: () => null }));

import { useAgentStore, type AgentStartOpts } from "./agentStore";
import { useVaultStore } from "./vaultStore";
import { useDialogStore } from "./dialogStore";

const START: AgentStartOpts = {
  provider: "openai-api", model: "m", vaultPath: "/a", question: "question",
  allowWrite: true,
  copy: { confirmTitle: "edit", confirmCreateTitle: "create", confirmHint: "review", diffTooLarge: "large" },
};
const RESULT: AgentRunResult = { answer: "answer", steps: [], stoppedAtLimit: false };
const TOOLS = [{ name: "create_page", description: "", input_schema: {}, write: true }];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  useDialogStore.getState().close(null);
  useAgentStore.getState().reset();
  useVaultStore.setState({ currentVault: { path: "/a", name: "a" }, vaultToken: "a1", isOpeningVault: false });
  useAgentStore.setState({ tools: TOOLS });
  runAgent.mockReset();
  runAgent.mockResolvedValue(RESULT);
  agentToolsSchema.mockReset();
  agentToolsSchema.mockResolvedValue(TOOLS);
  agentVaultSession.mockReset();
  agentVaultSession.mockResolvedValue({ vaultPath: "/a", openingToken: "native-a1" });
  captureModelRole.mockReset().mockImplementation(async origin => roleFixture("agent", "openai-api", "m", origin));
  readFile.mockReset();
  readFile.mockResolvedValue({ raw: "old" });
  confirmAction.mockReset();
  confirmAction.mockResolvedValue(true);
});

describe("Agent confirmation ownership", () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof DialogStoreModule>("./dialogStore");
    confirmAction.mockImplementation(actual.confirmAction);
    runAgent.mockImplementation(async (opts: AgentRunOpts) => {
      await opts.confirmWrite!({ id: "w1", name: "create_page", input: { path: "wiki/n.md", content: "next" } });
      return RESULT;
    });
  });

  it.each(["switch", "reopen", "cancel", "reset"])("closes and settles its approval on %s", async (kind) => {
    const pending = useAgentStore.getState().start(START);
    await vi.waitFor(() => expect(useDialogStore.getState().request).not.toBeNull());
    try {
      if (kind === "cancel" || kind === "reset") useAgentStore.getState()[kind]();
      else useVaultStore.setState({
        currentVault: { path: kind === "switch" ? "/b" : "/a", name: "next" }, vaultToken: "next",
      });
      expect(useDialogStore.getState().request).toBeNull();
    } finally {
      useDialogStore.getState().close(null);
      await pending;
    }
    expect(useAgentStore.getState().answer).toBe("");
  });

  it("settles its replaced approval without closing another caller's dialog", async () => {
    const pending = useAgentStore.getState().start(START);
    await vi.waitFor(() => expect(useDialogStore.getState().request).not.toBeNull());
    const old = useDialogStore.getState().request!;
    const next = { kind: "prompt" as const, title: "unrelated", resolve: vi.fn() };
    useDialogStore.getState().open(next);
    let settled = false;
    void pending.then(() => { settled = true; });
    try {
      useAgentStore.getState().cancel();
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 200 });
      expect(useDialogStore.getState().request).toBe(next);
      expect(next.resolve).not.toHaveBeenCalled();
    } finally {
      old.resolve(null);
      useDialogStore.getState().close(null);
      await pending;
    }
  });

  it("keeps a current approval functional and releases its cancellation listener", async () => {
    const pending = useAgentStore.getState().start(START);
    await vi.waitFor(() => expect(useDialogStore.getState().request).not.toBeNull());
    useDialogStore.getState().close("ok");
    await pending;
    expect(useAgentStore.getState().answer).toBe("answer");
    const next = { kind: "prompt" as const, title: "unrelated", resolve: vi.fn() };
    useDialogStore.getState().open(next);
    useAgentStore.getState().cancel();
    expect(useDialogStore.getState().request).toBe(next);
    expect(next.resolve).not.toHaveBeenCalled();
    useDialogStore.getState().close(null);
  });
});

describe("Agent vault ownership", () => {
  it.each(["switch", "reopen"])("cancels and discards a late run after a vault %s", async (kind) => {
    const done = deferred<AgentRunResult>();
    runAgent.mockReturnValueOnce(done.promise);
    const pending = useAgentStore.getState().start(START);
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledOnce());
    const opts = runAgent.mock.calls[0][0] as AgentRunOpts;
    useVaultStore.setState({
      currentVault: { path: kind === "switch" ? "/b" : "/a", name: "next" }, vaultToken: "next",
    });
    opts.onStep?.({ kind: "tool", tool: "late", args: {} });
    done.resolve(RESULT);
    await pending;
    expect(opts.signal?.aborted).toBe(true);
    expect(useAgentStore.getState().answer).toBe("");
    expect(useAgentStore.getState().steps).toEqual([]);
    expect(useAgentStore.getState().running).toBe(false);
  });

  it("blocks a stale vault option and a vault being opened", async () => {
    await useAgentStore.getState().start({ ...START, vaultPath: "/old" });
    useVaultStore.setState({ isOpeningVault: true });
    await useAgentStore.getState().start(START);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("takes the native origin before starting a loop", async () => {
    await useAgentStore.getState().start(START);
    expect(agentVaultSession).toHaveBeenCalledOnce();
    expect(runAgent.mock.calls[0][0].origin).toEqual({ vaultPath: "/a", openingToken: "native-a1" });
    expect(Object.isFrozen(runAgent.mock.calls[0][0].origin)).toBe(true);
  });

  it("does not start when the native root differs from the captured frontend root", async () => {
    agentVaultSession.mockResolvedValueOnce({ vaultPath: "/b", openingToken: "native-b1" });
    await useAgentStore.getState().start(START);
    expect(runAgent).not.toHaveBeenCalled();
    expect(useAgentStore.getState().error).toContain("active vault changed");
  });

  it("does not start if the native origin arrives after a same-path reopen", async () => {
    const origin = deferred<{ vaultPath: string; openingToken: string }>();
    agentVaultSession.mockReturnValueOnce(origin.promise);
    const pending = useAgentStore.getState().start(START);
    useVaultStore.setState({ vaultToken: "a2" });
    origin.resolve({ vaultPath: "/a", openingToken: "native-a2" });
    await pending;
    expect(runAgent).not.toHaveBeenCalled();
    expect(useAgentStore.getState().running).toBe(false);
  });

  it("reports native origin capture failures before starting a model", async () => {
    agentVaultSession.mockRejectedValueOnce(new Error("no vault is open"));
    await useAgentStore.getState().start(START);
    expect(runAgent).not.toHaveBeenCalled();
    expect(useAgentStore.getState().error).toContain("no vault is open");
  });

  it("cannot show a stale write preview after its disk read completes", async () => {
    const disk = deferred<{ raw: string }>();
    readFile.mockReturnValueOnce(disk.promise);
    let preview!: Promise<boolean>;
    runAgent.mockImplementationOnce(async (opts: AgentRunOpts) => {
      preview = opts.confirmWrite!({ id: "write", name: "create_page", input: { path: "wiki/n.md", content: "next" } });
      await preview;
      return RESULT;
    });
    const pending = useAgentStore.getState().start(START);
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledOnce());
    useVaultStore.setState({ currentVault: { path: "/b", name: "b" }, vaultToken: "b1" });
    disk.resolve({ raw: "old" });
    await pending;
    expect(await preview).toBe(false);
    expect(confirmAction).not.toHaveBeenCalled();
  });

  it("prevents duplicate starts while loading schemas", async () => {
    useAgentStore.setState({ tools: [] });
    const schema = deferred<typeof TOOLS>();
    agentToolsSchema.mockReturnValue(schema.promise);
    const first = useAgentStore.getState().start(START);
    const second = useAgentStore.getState().start(START);
    schema.resolve(TOOLS);
    await Promise.all([first, second]);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("does not start a loop or cache schemas that finish after a vault transition", async () => {
    useAgentStore.setState({ tools: [] });
    const schema = deferred<typeof TOOLS>();
    agentToolsSchema.mockReturnValueOnce(schema.promise);
    const pending = useAgentStore.getState().start(START);
    await vi.waitFor(() => expect(agentToolsSchema).toHaveBeenCalledOnce());
    useVaultStore.setState({ currentVault: { path: "/b", name: "b" }, vaultToken: "b1" });
    schema.resolve(TOOLS);
    await pending;
    expect(runAgent).not.toHaveBeenCalled();
    expect(useAgentStore.getState().tools).toEqual([]);
  });

  it("reports schema failures instead of silently running with no tools", async () => {
    useAgentStore.setState({ tools: [] });
    agentToolsSchema.mockRejectedValueOnce(new Error("schema unavailable"));
    await useAgentStore.getState().start(START);
    expect(runAgent).not.toHaveBeenCalled();
    expect(useAgentStore.getState().error).toContain("schema unavailable");
    expect(useAgentStore.getState().running).toBe(false);
  });

  it.each(["cancel", "reset"] as const)("discards results after %s", async (action) => {
    const done = deferred<AgentRunResult>();
    runAgent.mockReturnValueOnce(done.promise);
    const pending = useAgentStore.getState().start(START);
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledOnce());
    const opts = runAgent.mock.calls[0][0] as AgentRunOpts;
    useAgentStore.getState()[action]();
    done.resolve(RESULT);
    await pending;
    expect(opts.signal?.aborted).toBe(true);
    expect(useAgentStore.getState().answer).toBe("");
  });

  it("an older finally cannot disconnect the newer run's cancellation", async () => {
    const firstDone = deferred<AgentRunResult>();
    const secondDone = deferred<AgentRunResult>();
    runAgent.mockReturnValueOnce(firstDone.promise).mockReturnValueOnce(secondDone.promise);
    const first = useAgentStore.getState().start(START);
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));
    useAgentStore.getState().cancel();
    const second = useAgentStore.getState().start(START);
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(2));
    const secondOpts = runAgent.mock.calls[1][0] as AgentRunOpts;
    firstDone.resolve(RESULT);
    await first;
    expect(useAgentStore.getState().running).toBe(true);
    useAgentStore.getState().cancel();
    expect(secondOpts.signal?.aborted).toBe(true);
    secondDone.resolve(RESULT);
    await second;
  });
});
