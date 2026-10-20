// One ingest run at a time — the guard has to actually hold.
//
// startIngest reads `stage`, decides "not running", and only publishes
// "writing-raw" later. If anything awaits in between, a second caller reads the
// stale idle stage and starts a SECOND `claude` agent against the same vault:
// interleaved edits to the same wiki pages, doubled log.md entries, double token
// spend, and — because cancelIngest only knows the newest runId — an orphaned
// run the UI cannot stop.
//
// The window is not a timing fluke. `listen()` is async, so awaiting it always
// yields a microtask; two callers in the same tick both pass the guard however
// fast the IPC is. autoIngest.runInboxPass has two callers (the clip-saved
// event and the interval tick) that reach here through identical IPCs.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { listenMock } = vi.hoisted(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  });
  return { listenMock: vi.fn().mockResolvedValue(() => undefined) };
});
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

vi.mock("./vaultStore", () => ({
  useVaultStore: {
    getState: () => ({
      currentVault: { path: "/v", name: "v" },
      vaultToken: "synthetic-ui-opening",
      isOpeningVault: false,
      // One session summary on disk, for the transcript-candidate test below.
      fileTree: [
        {
          kind: "file",
          name: "source-claude-code-aaa.md",
          path: "/v/wiki/source-claude-code-aaa.md",
        },
      ],
      refreshTree: vi.fn().mockResolvedValue(undefined),
      refreshLinkGraph: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

vi.mock("../lib/chat", () => ({ complete: vi.fn().mockResolvedValue("done") }));
// Shaped like the real `log` object ({ info/warn/error }), not a bare
// function — persistRunTranscript's failure path calls `log.warn(...)`.
vi.mock("../lib/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ipc } from "../lib/ipc";
import type { InboxSourceSnapshot, SessionCompileContext, SessionCompileFailure, SessionCompileStepResult } from "../lib/ipc";
import { complete } from "../lib/chat";
import { sha256 } from "../lib/tidyRun";
import {
  useIngestStore,
  INGEST_PROMPT,
  applyStreamEvent,
  isShortNote,
  refusalLine,
  runElapsedMs,
  runIngestProvider,
} from "./ingestStore";
import { useUIStore } from "./uiStore";
import { useVaultStore } from "./vaultStore";
import { notice } from "../lib/notice";
import { STRINGS } from "../lib/i18n";
import { BUILTIN_CHAT_MODEL } from "../lib/providers";
import { roleFixture, selectedRolesFixture } from "../lib/modelRoles.testSupport";
import { runInboxPass } from "../lib/autoIngest";

// Synthetic issued DTOs only; real native permission/transport gates are separate.
function compilationFixture(providerId: string, modelId: string, automaticExternalAllowed = false) {
  const roles = selectedRolesFixture({ compilation: { providerId, modelId } });
  roles.roles.compilation.automaticExternalAllowed = automaticExternalAllowed;
  vi.spyOn(ipc, "agentVaultSession").mockImplementation(async () => {
    const vault = useVaultStore.getState();
    return { vaultPath: vault.currentVault?.path ?? "", openingToken: `native-${vault.vaultToken ?? "synthetic"}` };
  });
  vi.spyOn(ipc, "captureModelRole").mockImplementation(async (origin, role, usage) => {
    const pick = roles.roles[role];
    if (usage === "automatic" && pick.selection === "explicit-external" && !pick.automaticExternalAllowed) {
      throw new Error("automatic external role use is not authorized");
    }
    return roleFixture(role, pick.providerId, pick.modelId, origin, usage, pick.effort);
  });
  return roles;
}

// The real store action consumes mocked native receipts; no model/native acceptance is claimed.
describe("native-bound inbox compilation action", () => {
  const origin = { vaultPath: "/v", openingToken: "synthetic-native-opening" };
  const revision = "a".repeat(64);
  const snapshot: InboxSourceSnapshot = { snapshotId: "synthetic-snapshot", origin,
    inboxRel: "_inbox/one.md", sourceRevision: revision, text: "Exact synthetic original.\n" };
  const context: SessionCompileContext = { jobId: "synthetic-job", attemptId: "synthetic-attempt", origin,
    source: { key: "codex:synthetic", rawPath: "raw/conversations/codex/synthetic.md", sourceRevision: revision },
    roleSnapshot: roleFixture("compilation", "builtin-local", "synthetic-local-model", origin, "automatic"),
    compileSignature: "synthetic-signature", summaryPath: "wiki/source-synthetic.md", indexPath: "wiki/index.md",
    logPath: "wiki/log.md", reportPath: "ingest-reports/synthetic.md" };
  const completed: SessionCompileStepResult = { attemptId: context.attemptId, sourceRevision: revision,
    state: "completed", step: null, nextPacket: 1, eligibleWindows: 1,
    publication: { ok: true, state: "completed", attemptId: context.attemptId } };
  const options = { usage: "automatic" as const, expectedVaultToken: "synthetic-ui-opening" };
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(finish => { resolve = finish; });
    return { promise, resolve };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    useIngestStore.setState({ stage: "idle", runId: null, workflowStatus: null,
      changedPages: [], reportPath: null, sourceChunksPending: 0 });
    vi.spyOn(ipc, "inboxCompileBegin").mockResolvedValue(context);
    vi.spyOn(ipc, "sessionCompileStep").mockResolvedValue(completed);
    vi.spyOn(ipc, "sessionCompileStop").mockResolvedValue(undefined);
    vi.spyOn(ipc, "cancelLocalSynthesis").mockResolvedValue(true);
  });

  it("publishes store success only from actual native completion without generic writes or mtimes", async () => {
    const write = vi.spyOn(ipc, "writeFile");
    const mtimes = vi.spyOn(ipc, "fileMtimes");
    const recapture = vi.spyOn(ipc, "agentVaultSession");
    const result = await useIngestStore.getState().startInboxCompilation(snapshot, options);
    expect(result).toEqual({ context, result: completed });
    expect(ipc.inboxCompileBegin).toHaveBeenCalledWith(snapshot, "automatic");
    expect(ipc.sessionCompileStep).toHaveBeenCalledWith(context, expect.stringMatching(/^session-compile-/), useUIStore.getState().lang);
    expect(useIngestStore.getState()).toMatchObject({ stage: "done", workflowStatus: "success",
      sourceText: snapshot.text, sourceChunksPending: 0, changedPages: [context.summaryPath],
      reportPath: null });
    expect(useIngestStore.getState().changedPages).not.toContain(context.indexPath);
    expect(useIngestStore.getState().changedPages).not.toContain(context.logPath);
    expect(write).not.toHaveBeenCalled(); expect(mtimes).not.toHaveBeenCalled(); expect(recapture).not.toHaveBeenCalled();
  });

  it.each(["revision", "origin", "role", "usage"])("rejects an issued context with changed %s before native generation", async invalid => {
    const issued = { ...context, source: { ...context.source }, origin: { ...origin }, roleSnapshot: { ...context.roleSnapshot } };
    if (invalid === "revision") issued.source.sourceRevision = "b".repeat(64);
    if (invalid === "origin") issued.origin.openingToken = "synthetic-other-opening";
    if (invalid === "role") issued.roleSnapshot.role = "ask";
    if (invalid === "usage") issued.roleSnapshot.usage = "foreground";
    vi.mocked(ipc.inboxCompileBegin).mockResolvedValueOnce(issued);
    await expect(useIngestStore.getState().startInboxCompilation(snapshot, options)).rejects.toThrow("originating source/opening/role");
    expect(ipc.sessionCompileStep).not.toHaveBeenCalled();
    expect(useIngestStore.getState()).toMatchObject({ stage: "error", changedPages: [], reportPath: null });
  });

  it("retains a review-rejected whole-source result as partial even when pending packets are zero", async () => {
    const partial: SessionCompileStepResult = { ...completed, state: "partial", publication: null,
      step: { packetIndex: 0, processedWindows: 1, eligibleWindows: 1, omittedWindows: 0,
        reviewAccepted: false, nativeReviewRevision: "b".repeat(64), sourceSchemaChecked: true, allPacketsSeen: true } };
    vi.mocked(ipc.sessionCompileStep).mockResolvedValueOnce(partial);
    expect(await useIngestStore.getState().startInboxCompilation(snapshot, options)).toEqual({ context, result: partial });
    expect(useIngestStore.getState()).toMatchObject({ workflowStatus: "partial", sourceChunksPending: 0,
      changedPages: [], reportPath: null, sourceText: snapshot.text });
  });

  it("does not treat an inconsistent completed publication as store success", async () => {
    vi.mocked(ipc.sessionCompileStep).mockResolvedValueOnce({ ...completed, publication: { ok: false,
      state: "completed", attemptId: context.attemptId } });
    await expect(useIngestStore.getState().startInboxCompilation(snapshot, options)).rejects.toThrow("completed publication");
    expect(useIngestStore.getState()).toMatchObject({ stage: "error", changedPages: [], reportPath: null });
  });

  it("keeps unsupported original admission pending before native generation", async () => {
    vi.mocked(ipc.inboxCompileBegin).mockRejectedValueOnce(new Error("inbox original lacks exact admitted imported lineage; source remains pending"));
    await expect(useIngestStore.getState().startInboxCompilation(snapshot, options)).rejects.toMatchObject({
      status: "pending", code: "unavailable", message: expect.stringContaining("Source admission unavailable"),
    });
    expect(useIngestStore.getState()).toMatchObject({ workflowStatus: "pending", sourceText: snapshot.text,
      changedPages: [], reportPath: null, workflowIssues: [expect.objectContaining({ status: "pending", code: "unavailable" })] });
    expect(ipc.sessionCompileStep).not.toHaveBeenCalled();
  });

  it("keeps a selected external compiler pending without rerouting or external execution", async () => {
    const external = { ...context, roleSnapshot: roleFixture("compilation", "synthetic-external",
      "synthetic-remote-model", origin, "automatic") };
    vi.mocked(ipc.inboxCompileBegin).mockResolvedValueOnce(external);
    const cli = vi.spyOn(ipc, "claudeRunStream");
    const remote = vi.mocked(complete); remote.mockClear();
    await expect(useIngestStore.getState().startInboxCompilation(snapshot, options)).rejects.toMatchObject({
      status: "pending", code: "unavailable",
    });
    expect(useIngestStore.getState()).toMatchObject({ workflowStatus: "pending", sourceText: snapshot.text,
      changedPages: [], reportPath: null });
    expect(ipc.sessionCompileStep).not.toHaveBeenCalled();
    expect(cli).not.toHaveBeenCalled(); expect(remote).not.toHaveBeenCalled();
  });

  it("does not reinterpret a native compiler authority rejection as completion", async () => {
    vi.mocked(ipc.sessionCompileStep).mockRejectedValueOnce(new Error("Synthetic compiler authority unavailable"));
    await expect(useIngestStore.getState().startInboxCompilation(snapshot, options)).rejects.toThrow("authority unavailable");
    expect(useIngestStore.getState()).toMatchObject({ workflowStatus: "failed", changedPages: [], reportPath: null });
  });

  it("claims the run synchronously before begin so two inbox callers cannot race", async () => {
    const begin = deferred<SessionCompileContext>();
    vi.mocked(ipc.inboxCompileBegin).mockReturnValueOnce(begin.promise);
    const first = useIngestStore.getState().startInboxCompilation(snapshot, options);
    await expect(useIngestStore.getState().startInboxCompilation(snapshot, options)).rejects.toThrow("already active");
    begin.resolve(context);
    await first;
    expect(ipc.inboxCompileBegin).toHaveBeenCalledTimes(1);
    expect(ipc.sessionCompileStep).toHaveBeenCalledTimes(1);
  });

  it.each(["begin", "step"])("rejects same-path reopening while %s is pending without publishing old UI pages", async boundary => {
    let current = useVaultStore.getState();
    vi.spyOn(useVaultStore, "getState").mockImplementation(() => current);
    const entered = deferred<void>();
    const gate = deferred<SessionCompileContext | SessionCompileStepResult>();
    if (boundary === "begin") vi.mocked(ipc.inboxCompileBegin).mockImplementationOnce(async () => {
      entered.resolve(); return await gate.promise as SessionCompileContext;
    });
    else vi.mocked(ipc.sessionCompileStep).mockImplementationOnce(async () => {
      entered.resolve(); return await gate.promise as SessionCompileStepResult;
    });
    const result = useIngestStore.getState().startInboxCompilation(snapshot, options);
    const rejection = expect(result).rejects.toThrow("opening");
    await entered.promise;
    current = { ...current, vaultToken: "synthetic-reopened" };
    gate.resolve(boundary === "begin" ? context : completed);
    await rejection;
    expect(useIngestStore.getState()).toMatchObject({ stage: "cancelled", changedPages: [], reportPath: null });
    if (boundary === "begin") expect(ipc.sessionCompileStep).not.toHaveBeenCalled();
  });

  it("an old native completion cannot replace a newer run's state", async () => {
    const entered = deferred<void>(); const late = deferred<SessionCompileStepResult>();
    vi.mocked(ipc.sessionCompileStep).mockImplementationOnce(() => { entered.resolve(); return late.promise; });
    const result = useIngestStore.getState().startInboxCompilation(snapshot, options);
    const rejection = expect(result).rejects.toThrow("opening");
    await entered.promise;
    useIngestStore.setState({ runId: "synthetic-new-run", stage: "claude", changedPages: ["wiki/new-run.md"],
      reportPath: "/v/ingest-reports/new-run.md", log: "New run remains active" });
    const newer = useIngestStore.getState();
    late.resolve(completed);
    await rejection;
    expect(useIngestStore.getState()).toEqual(newer);
  });

  it("user cancellation waits for native Stop and preserves the exact source", async () => {
    const entered = deferred<void>(); const step = deferred<SessionCompileStepResult>(); const stop = deferred<void>();
    vi.mocked(ipc.sessionCompileStep).mockImplementationOnce(() => { entered.resolve(); return step.promise; });
    vi.mocked(ipc.sessionCompileStop).mockReturnValueOnce(stop.promise);
    const result = useIngestStore.getState().startInboxCompilation(snapshot, options);
    const rejection = expect(result).rejects.toThrow("stopped");
    await entered.promise;
    await useIngestStore.getState().cancelIngest();
    expect(ipc.sessionCompileStop).toHaveBeenCalledWith(context, "stopped");
    expect(useIngestStore.getState().changedPages).toEqual([]);
    stop.resolve(); step.resolve(completed);
    await rejection;
    expect(useIngestStore.getState()).toMatchObject({ stage: "cancelled", sourceText: snapshot.text, reportPath: null });
  });

  it("keeps manual native Stop finalization failure failed after cancellation", async () => {
    const entered = deferred<void>();
    const step = deferred<SessionCompileStepResult>();
    vi.mocked(ipc.sessionCompileStep).mockImplementationOnce(() => {
      entered.resolve();
      return step.promise;
    });
    vi.mocked(ipc.sessionCompileStop).mockRejectedValueOnce(new Error("Synthetic native Stop journal unavailable"));
    const result = useIngestStore.getState().startInboxCompilation(snapshot, options);
    const rejection = expect(result).rejects.toThrow("Native compiler Stop could not be confirmed");
    await entered.promise;
    useIngestStore.getState().cancelIngest();
    await rejection;
    expect(ipc.sessionCompileStop).toHaveBeenCalledTimes(1);
    expect(ipc.sessionCompileStop).toHaveBeenCalledWith(context, "stopped");
    expect(useIngestStore.getState()).toMatchObject({
      stage: "error", workflowStatus: "failed", sourceText: snapshot.text, changedPages: [], reportPath: null,
      workflowIssues: [expect.objectContaining({ status: "failed", code: "operation_failed",
        error: expect.stringContaining("Synthetic native Stop journal unavailable") })],
      log: expect.stringContaining("Native compiler Stop could not be confirmed"),
    });
    step.resolve(completed);
  });

  it("keeps manual confirmed native failure failed when cancellation follows listener teardown", async () => {
    vi.mocked(ipc.sessionCompileStep).mockImplementationOnce(async (issued, requestId) => {
      const failure: SessionCompileFailure = {
        version: "SessionCompileFailureV1", message: "Synthetic confirmed processing failure",
        outcome: { attemptId: issued.attemptId, sourceRevision: issued.source.sourceRevision,
          compileSignature: issued.compileSignature, origin: issued.origin,
          roleSnapshotId: issued.roleSnapshot.snapshotId, requestId,
          state: "failed", reason: "processing_failed" },
        finalizationError: null,
      };
      throw failure;
    });
    const originalRemove = AbortSignal.prototype.removeEventListener;
    let lateAbort = false;
    // Inject the late user action at the real adapter lifecycle boundary after
    // its native result was selected and its abort listener has been detached.
    const removeSpy = vi.spyOn(AbortSignal.prototype, "removeEventListener").mockImplementation(function (
      this: AbortSignal, type: string, listener: EventListenerOrEventListenerObject,
      listenerOptions?: EventListenerOptions | boolean,
    ) {
      originalRemove.call(this, type, listener, listenerOptions);
      if (type === "abort" && !lateAbort) {
        lateAbort = true;
        useIngestStore.getState().cancelIngest();
      }
    });
    try {
      await expect(useIngestStore.getState().startInboxCompilation(snapshot, options)).rejects.toMatchObject({
        status: "failed", code: "operation_failed", message: "Synthetic confirmed processing failure",
      });
      expect(lateAbort).toBe(true);
      expect(ipc.sessionCompileStep).toHaveBeenCalledTimes(1);
      expect(ipc.sessionCompileStop).not.toHaveBeenCalled();
      expect(ipc.cancelLocalSynthesis).not.toHaveBeenCalled();
      expect(useIngestStore.getState()).toMatchObject({
        stage: "error", workflowStatus: "failed", sourceText: snapshot.text, changedPages: [], reportPath: null,
        workflowIssues: [expect.objectContaining({ status: "failed", code: "operation_failed",
          error: expect.stringContaining("Synthetic confirmed processing failure") })],
      });
    } finally {
      removeSpy.mockRestore();
    }
  });

});

// Phase B, Task 6: INGEST_PROMPT's new 5th param weights linking/tagging
// toward the user's profile interests. Pure function, no ipc involved.
describe("INGEST_PROMPT profile interests grounding", () => {
  it("carries the canonical session key while preserving an existing summary path", () => {
    const prompt = INGEST_PROMPT("conversations/codex/synthetic.r1", "Search improvements", [], [], "", "kept", "wiki/sessions/source-kept.md", "codex:synthetic");
    expect(prompt).toContain("`wiki/sessions/source-kept.md`");
    expect(prompt).toContain('session_key: "codex:synthetic"');
    expect(prompt).toContain("Preserve human annotations");
    expect(INGEST_PROMPT("ordinary", "Ordinary note")).not.toContain("session_key:");
  });

  it("keeps the pre-Task-6 shape when profileInterests is omitted (default '')", () => {
    const prompt = INGEST_PROMPT("my-slug", "My Title");
    expect(prompt).not.toContain("User interests");
    expect(prompt).toContain(
      'New source has been added at `raw/my-slug.md` (title: "My Title")',
    );
  });

  it("adds one grounding line when profileInterests is non-empty", () => {
    const prompt = INGEST_PROMPT("my-slug", "My Title", [], [], "rust, vector search");
    expect(prompt).toContain(
      "User interests (weight linking/tagging toward these): rust, vector search",
    );
  });
});

describe("startIngest concurrency", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(ipc, "findRawCopy").mockResolvedValue(null);
    vi.spyOn(ipc, "availableRawPath").mockImplementation(async slug => `raw/${slug}.md`);
    vi.spyOn(ipc, "judgeSource").mockResolvedValue({ verdict: "harvest", reason: "synthetic admission", rule: "judge::pass" });
    vi.spyOn(ipc, "scanTextSecrets").mockResolvedValue({ secrets: [], pii: [] });
    listenMock.mockClear();
    useIngestStore.setState({ stage: "idle", runId: null });

    vi.spyOn(ipc, "getSettings").mockResolvedValue({
      ingest_provider: "anthropic-cli",
      ingest_model: "",
      model_roles: compilationFixture("anthropic-cli", ""),
      query_provider: "builtin-local",
      query_model: "gemma-3-1b",
    } as never);
    vi.spyOn(ipc, "createFolder").mockResolvedValue(undefined as never);
    vi.spyOn(ipc, "writeFile").mockResolvedValue(undefined as never);
    vi.spyOn(ipc, "fileMtimes").mockResolvedValue([]);
    vi.spyOn(ipc, "readVaultContext").mockResolvedValue("");
    vi.spyOn(ipc, "buildLinkGraph").mockResolvedValue({
      nodes: [],
      edges: [],
    } as never);
  });

  it.each(["findRawCopy", "availableRawPath"] as const)("retains pending input when %s is unavailable", async dependency => {
    vi.spyOn(ipc, "findRawCopy").mockResolvedValue(null);
    vi.spyOn(ipc, "availableRawPath").mockResolvedValue("raw/t.md");
    vi.spyOn(ipc, dependency).mockRejectedValue(new Error(`synthetic ${dependency} unavailable`));
    const run = vi.spyOn(ipc, "claudeRunStream").mockResolvedValue({ stdout: "ok", stderr: "", status: 0 } as never);
    await useIngestStore.getState().startIngest("t", "synthetic retained source", { headless: true });
    expect(useIngestStore.getState().workflowStatus).toBe("pending");
    expect(useIngestStore.getState().sourceText).toBe("synthetic retained source");
    expect(ipc.writeFile).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("does not lower the paste guard when settings cannot be read", async () => {
    vi.spyOn(ipc, "getSettings").mockRejectedValue(new Error("synthetic settings unavailable"));
    const run = vi.spyOn(ipc, "claudeRunStream");
    await useIngestStore.getState().startIngest("t", "synthetic retained source", { headless: true });
    expect(useIngestStore.getState().workflowStatus).toBe("pending");
    expect(ipc.judgeSource).not.toHaveBeenCalled();
    expect(ipc.writeFile).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("fails before writing when raw folder creation is denied", async () => {
    compilationFixture("anthropic-cli", "", true);
    vi.spyOn(ipc, "findRawCopy").mockResolvedValue(null);
    vi.spyOn(ipc, "createFolder").mockRejectedValue(new Error("synthetic permission denied"));
    const run = vi.spyOn(ipc, "claudeRunStream").mockResolvedValue({ stdout: "ok", stderr: "", status: 0 } as never);
    await useIngestStore.getState().startIngest("t", "synthetic retained source", { headless: true });
    expect(useIngestStore.getState().workflowStatus).toBe("failed");
    expect(useIngestStore.getState().log).toContain("synthetic permission denied");
    expect(ipc.writeFile).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps an external automatic compilation pending without automatic consent", async () => {
    const run = vi.spyOn(ipc, "claudeRunStream");
    vi.mocked(complete).mockClear();
    await useIngestStore.getState().startIngest("t", "synthetic retained source", { headless: true });
    expect(useIngestStore.getState().workflowStatus).toBe("pending");
    expect(useIngestStore.getState().sourceText).toBe("synthetic retained source");
    expect(useIngestStore.getState().log).toContain("automatic external role use is not authorized");
    expect(ipc.writeFile).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("starts exactly one run when two callers race the same tick", async () => {
    const run = vi
      .spyOn(ipc, "claudeRunStream")
      .mockResolvedValue({ stdout: "ok", stderr: "", status: 0 } as never);

    // Both callers reach startIngest before either has published a stage —
    // exactly what two runInboxPass triggers landing together look like.
    await Promise.all([
      useIngestStore.getState().startIngest("t", "b"),
      useIngestStore.getState().startIngest("t", "b"),
    ]);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("holds even when listen() resolves instantly", async () => {
    // Not a slow-IPC problem: an await on an already-resolved promise still
    // yields. The guard must not straddle one.
    listenMock.mockImplementation(() => Promise.resolve(() => undefined));
    const run = vi
      .spyOn(ipc, "claudeRunStream")
      .mockResolvedValue({ stdout: "ok", stderr: "", status: 0 } as never);

    await Promise.all([
      useIngestStore.getState().startIngest("t", "b"),
      useIngestStore.getState().startIngest("t", "b"),
    ]);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("lets a second run start once the first has finished", async () => {
    const run = vi
      .spyOn(ipc, "claudeRunStream")
      .mockResolvedValue({ stdout: "ok", stderr: "", status: 0 } as never);

    await useIngestStore.getState().startIngest("t", "b");
    await useIngestStore.getState().startIngest("t", "b");

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("refuses a scheduled source when its vault is no longer active", async () => {
    await expect(useIngestStore.getState().startIngest("t", "b", {
      headless: true,
      expectedVaultPath: "/different-vault",
    })).rejects.toThrow("active vault changed");
    expect(ipc.writeFile).not.toHaveBeenCalled();
    expect(useIngestStore.getState().stage).toBe("idle");
  });
});

describe("runIngestProvider originating grants", () => {
  const origin = { vaultPath: "/v", openingToken: "native-original" };
  const request = { provider: "ollama", modelId: "synthetic-model", vaultPath: "/v",
    prompt: "synthetic source-bound instruction", slug: "synthetic", title: "Synthetic", body: "Synthetic original source" };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(complete).mockReset().mockResolvedValue("synthetic result");
    vi.spyOn(ipc, "agentVaultSession");
    vi.spyOn(ipc, "captureModelRole");
  });

  it("retains the original automatic grant through provider execution without recapture", async () => {
    const roleSnapshot = roleFixture("compilation", "ollama", "synthetic-model", origin, "automatic");
    await runIngestProvider({ ...request, origin, roleSnapshot, usage: "automatic" });
    expect(ipc.agentVaultSession).not.toHaveBeenCalled();
    expect(ipc.captureModelRole).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      featureRole: "compilation", origin, roleSnapshot, usage: "automatic",
    }));
  });

  it("refuses automatic execution without the original grant before any admission or provider call", async () => {
    await expect(runIngestProvider({ ...request, usage: "automatic" })).rejects.toThrow("originating native role grant");
    expect(ipc.agentVaultSession).not.toHaveBeenCalled();
    expect(ipc.captureModelRole).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("refuses a supplied grant from another opening instead of acquiring a replacement", async () => {
    const roleSnapshot = roleFixture("compilation", "ollama", "synthetic-model", { ...origin, openingToken: "native-reopened" });
    await expect(runIngestProvider({ ...request, origin, roleSnapshot })).rejects.toThrow("originating native role grant");
    expect(ipc.agentVaultSession).not.toHaveBeenCalled();
    expect(ipc.captureModelRole).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("passes the original grant to unavailable subscription execution without implying support", async () => {
    const roleSnapshot = roleFixture("compilation", "myco-pro", "synthetic-pro", origin);
    const subscription = vi.spyOn(ipc, "mycoProIngest").mockRejectedValue(new Error("capability_unavailable: staged checked publication executor required"));
    await expect(runIngestProvider({ ...request, provider: "myco-pro", modelId: "synthetic-pro", origin, roleSnapshot })).rejects.toThrow("capability_unavailable");
    expect(subscription).toHaveBeenCalledWith(request.slug, request.title, request.body, origin, roleSnapshot);
    expect(ipc.agentVaultSession).not.toHaveBeenCalled();
    expect(ipc.captureModelRole).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
});

// Phase B, Task 6: startIngest's own wiring of the profile-interests
// grounding line (INGEST_PROMPT's pure-function behavior is covered above).
describe("startIngest profile interests wiring", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(ipc, "findRawCopy").mockResolvedValue(null);
    vi.spyOn(ipc, "availableRawPath").mockImplementation(async slug => `raw/${slug}.md`);
    vi.spyOn(ipc, "judgeSource").mockResolvedValue({ verdict: "harvest", reason: "synthetic admission", rule: "judge::pass" });
    vi.spyOn(ipc, "scanTextSecrets").mockResolvedValue({ secrets: [], pii: [] });
    listenMock.mockClear();
    useIngestStore.setState({ stage: "idle", runId: null });

    vi.spyOn(ipc, "getSettings").mockResolvedValue({
      ingest_provider: "anthropic-cli",
      ingest_model: "",
      model_roles: compilationFixture("anthropic-cli", ""),
      query_provider: "builtin-local",
      query_model: "gemma-3-1b",
    } as never);
    vi.spyOn(ipc, "createFolder").mockResolvedValue(undefined as never);
    vi.spyOn(ipc, "writeFile").mockResolvedValue(undefined as never);
    vi.spyOn(ipc, "fileMtimes").mockResolvedValue([]);
    vi.spyOn(ipc, "readVaultContext").mockResolvedValue("");
    vi.spyOn(ipc, "buildLinkGraph").mockResolvedValue({
      nodes: [],
      edges: [],
    } as never);
  });

  const PROFILE_MD =
    "## Role\nBackend engineer\n\n## Goals\n- Ship it\n\n" +
    "## Interests\n- rust\n- vector search\n\n## Working style\nConcise\n";

  it("passes profile interests into the ingest prompt when the toggle is on and a profile exists", async () => {
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue({
      profile_injection: true,
    } as never);
    vi.spyOn(ipc, "readFile").mockResolvedValue({ raw: PROFILE_MD } as never);
    const run = vi
      .spyOn(ipc, "claudeRunStream")
      .mockResolvedValue({ stdout: "ok", stderr: "", status: 0 } as never);

    await useIngestStore.getState().startIngest("t", "b");

    const [, prompt] = run.mock.calls[0];
    expect(prompt).toContain(
      "User interests (weight linking/tagging toward these): rust, vector search",
    );
  });

  it("omits the interests line when there is no profile", async () => {
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue({
      profile_injection: true,
    } as never);
    vi.spyOn(ipc, "readFile").mockRejectedValue(new Error("not found"));
    const run = vi
      .spyOn(ipc, "claudeRunStream")
      .mockResolvedValue({ stdout: "ok", stderr: "", status: 0 } as never);

    await useIngestStore.getState().startIngest("t", "b");

    const [, prompt] = run.mock.calls[0];
    expect(prompt).not.toContain("User interests");
  });

  it("omits the interests line when the toggle is off, even with a profile on disk", async () => {
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue({
      profile_injection: false,
    } as never);
    const readFile = vi
      .spyOn(ipc, "readFile")
      .mockResolvedValue({ raw: PROFILE_MD } as never);
    const run = vi
      .spyOn(ipc, "claudeRunStream")
      .mockResolvedValue({ stdout: "ok", stderr: "", status: 0 } as never);

    await useIngestStore.getState().startIngest("t", "b");

    const [, prompt] = run.mock.calls[0];
    expect(prompt).not.toContain("User interests");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("fails closed (omits the interests line) when the distill config can't be read", async () => {
    vi.spyOn(ipc, "getDistillConfig").mockRejectedValue(new Error("io error"));
    vi.spyOn(ipc, "readFile").mockResolvedValue({ raw: PROFILE_MD } as never);
    const run = vi
      .spyOn(ipc, "claudeRunStream")
      .mockResolvedValue({ stdout: "ok", stderr: "", status: 0 } as never);

    await useIngestStore.getState().startIngest("t", "b");

    const [, prompt] = run.mock.calls[0];
    expect(prompt).not.toContain("User interests");
  });
});

// Phase 1f: the deterministic validator replaced the old mtime-only gate.
// These cover the new branch — validator errors block, warnings don't.
describe("ingest validation gate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(ipc, "findRawCopy").mockResolvedValue(null);
    vi.spyOn(ipc, "availableRawPath").mockImplementation(async slug => `raw/${slug}.md`);
    vi.spyOn(ipc, "judgeSource").mockResolvedValue({ verdict: "harvest", reason: "synthetic admission", rule: "judge::pass" });
    vi.spyOn(ipc, "scanTextSecrets").mockResolvedValue({ secrets: [], pii: [] });
    listenMock.mockClear();
    useIngestStore.setState({ stage: "idle", runId: null });

    vi.spyOn(ipc, "getSettings").mockResolvedValue({
      ingest_provider: "anthropic-cli",
      ingest_model: "",
      model_roles: compilationFixture("anthropic-cli", ""),
      query_provider: "builtin-local",
      query_model: "gemma-3-1b",
    } as never);
    vi.spyOn(ipc, "createFolder").mockResolvedValue(undefined as never);
    vi.spyOn(ipc, "writeFile").mockResolvedValue(undefined as never);
    vi.spyOn(ipc, "readVaultContext").mockResolvedValue("");
    vi.spyOn(ipc, "buildLinkGraph").mockResolvedValue({
      nodes: [],
      edges: [],
    } as never);
    vi.spyOn(ipc, "claudeRunStream").mockResolvedValue({
      stdout: "ok",
      stderr: "",
      status: 0,
    } as never);
  });

  it("blocks on validator errors instead of reaching done", async () => {
    // wikiBefore snapshot (empty) then afterMtimes showing one wiki page
    // changed, so the run has something to validate.
    vi.spyOn(ipc, "fileMtimes")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([["/v/wiki/foo.md", 1]]);
    const validate = vi.spyOn(ipc, "validateIngest").mockResolvedValue({
      errors: [
        { page: "wiki/foo.md", kind: "dangling_citation", detail: "no raw/bar.md" },
      ],
      warnings: [],
    });

    await useIngestStore.getState().startIngest("t", "b");

    // Vault-relative, not the absolute fileMtimes path — validate_pages (Rust)
    // requires `rel.starts_with("wiki/")` and silently skips anything else.
    expect(validate).toHaveBeenCalledWith("/v", ["wiki/foo.md"]);
    expect(useIngestStore.getState().stage).toBe("error");
    expect(useIngestStore.getState().log).toContain("wiki/foo.md");
    expect(useIngestStore.getState().log).toContain("no raw/bar.md");
  });

  it("keeps provider writes retryable when the validator IPC is unavailable", async () => {
    vi.spyOn(ipc, "fileMtimes").mockResolvedValueOnce([]).mockResolvedValueOnce([["/v/wiki/foo.md", 1]]);
    vi.spyOn(ipc, "validateIngest").mockRejectedValue(new Error("synthetic validator unavailable"));
    await useIngestStore.getState().startIngest("t", "b");
    expect(useIngestStore.getState().stage).toBe("error");
    expect(useIngestStore.getState().log).toContain("synthetic validator unavailable");
    expect(useIngestStore.getState().workflowStatus).toBe("pending");
    expect(useIngestStore.getState().workflowIssues[0]).toMatchObject({ code: "unavailable", retryable: true });
    expect(useIngestStore.getState().changedPages).not.toContain("wiki/foo.md");
  });

  it("reaches done and surfaces warnings when the validator only warns", async () => {
    vi.spyOn(ipc, "fileMtimes")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([["/v/wiki/foo.md", 1]]);
    vi.spyOn(ipc, "validateIngest").mockResolvedValue({
      errors: [],
      warnings: [
        { page: "wiki/foo.md", kind: "unresolved_wikilink", detail: "[[bar]] not found" },
      ],
    });

    await useIngestStore.getState().startIngest("t", "b");

    expect(useIngestStore.getState().stage).toBe("done");
    expect(useIngestStore.getState().log).toContain("[[bar]] not found");
  });

  it("lists the pages on disk at done, not the streamed tool input", async () => {
    // claude.rs cuts a tool event's detail at 160 chars; a long vault path +
    // page name arrives as a path that does not exist.
    const real = `wiki/${"rotary-position-embeddings-and-context-window-".repeat(4)}extension.md`;
    vi.mocked(ipc.claudeRunStream).mockImplementation((async (runId: string) => {
      applyStreamEvent({
        run_id: runId,
        kind: "tool",
        tool: "Write",
        detail: `/v/${real}`.slice(0, 160),
        text: null,
      });
      return { stdout: "ok", stderr: "", status: 0 };
    }) as never);
    vi.spyOn(ipc, "fileMtimes")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([[`/v/${real}`, 1]]);
    vi.spyOn(ipc, "validateIngest").mockResolvedValue({ errors: [], warnings: [] });

    await useIngestStore.getState().startIngest("t", "b");

    expect(useIngestStore.getState().stage).toBe("done");
    expect(useIngestStore.getState().touched[0].path).not.toBe(real);
    expect(useIngestStore.getState().changedPages).toEqual([real]);
  });

  it("fails as before (no-changes) when no wiki page changed, without calling the validator", async () => {
    vi.spyOn(ipc, "fileMtimes").mockResolvedValue([]);
    const validate = vi.spyOn(ipc, "validateIngest");

    await useIngestStore.getState().startIngest("t", "b");

    expect(validate).not.toHaveBeenCalled();
    expect(useIngestStore.getState().stage).toBe("error");
  });
});

// Judgement stage (Sieve): junk is refused BEFORE it becomes files. A `drop`
// verdict never reaches raw/, the planner or the agent; an all-NOOP plan ends
// the run with nothing written (no raw/, no wiki, no report); a normal source
// still flows through raw/ → agent → done.
describe("startIngest judgement stage", () => {
  const NOOP_PLAN = JSON.stringify([
    { subject: "already covered", decision: "NOOP", target: "attention", reason: "present" },
    { subject: "also covered", decision: "NOOP", target: "embeddings", reason: "present" },
  ]);

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(ipc, "findRawCopy").mockResolvedValue(null);
    vi.spyOn(ipc, "availableRawPath").mockImplementation(async slug => `raw/${slug}.md`);
    vi.spyOn(ipc, "judgeSource").mockResolvedValue({ verdict: "harvest", reason: "synthetic admission", rule: "judge::pass" });
    vi.spyOn(ipc, "scanTextSecrets").mockResolvedValue({ secrets: [], pii: [] });
    listenMock.mockClear();
    vi.mocked(complete).mockReset().mockResolvedValue("done");
    useIngestStore.setState({ stage: "idle", runId: null, refusal: null });

    vi.spyOn(ipc, "getSettings").mockResolvedValue({
      ingest_provider: "anthropic-cli",
      ingest_model: "",
      model_roles: compilationFixture("anthropic-cli", ""),
      query_provider: "builtin-local",
      query_model: "gemma-3-1b",
    } as never);
    vi.spyOn(ipc, "createFolder").mockResolvedValue(undefined as never);
    vi.spyOn(ipc, "writeFile").mockResolvedValue(undefined as never);
    vi.spyOn(ipc, "readVaultContext").mockResolvedValue("");
    vi.spyOn(ipc, "wikifyCandidates").mockResolvedValue([]);
    vi.spyOn(ipc, "recordNoop").mockResolvedValue(undefined);
    vi.spyOn(ipc, "buildLinkGraph").mockResolvedValue({
      nodes: [],
      edges: [],
    } as never);
    vi.spyOn(ipc, "fileMtimes")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([["/v/wiki/foo.md", 1]]);
    vi.spyOn(ipc, "validateIngest").mockResolvedValue({ errors: [], warnings: [] });
  });

  it("a 5-byte source never reaches the model and writes nothing", async () => {
    const judge = vi.spyOn(ipc, "judgeSource").mockResolvedValue({
      verdict: "drop",
      reason: "5 B < 200 B",
      rule: "junk_reason::min_bytes",
    });
    const write = vi.spyOn(ipc, "writeFile");
    const run = vi.spyOn(ipc, "claudeRunStream");
    const noop = vi.spyOn(ipc, "recordNoop");

    await useIngestStore.getState().startIngest("test", "hello");

    // Byte count, not char count — the judge sees the UTF-8 size Rust would.
    expect(judge).toHaveBeenCalledWith("hello", 5);
    expect(write).not.toHaveBeenCalled();
    expect(vi.mocked(complete)).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(noop).toHaveBeenCalledWith("raw/test.md", "drop: 5 B < 200 B");
    expect(useIngestStore.getState().stage).toBe("refused");
    expect(useIngestStore.getState().refusal).toEqual({
      verdict: "drop",
      reason: "5 B < 200 B",
      rule: "junk_reason::min_bytes",
    });
  });

  it("an all-NOOP plan writes nothing — no raw/, no agent, one noop record", async () => {
    vi.spyOn(ipc, "judgeSource").mockResolvedValue({
      verdict: "harvest",
      reason: "prose",
      rule: "judge::pass",
    });
    vi.mocked(complete).mockResolvedValue(NOOP_PLAN);
    const write = vi.spyOn(ipc, "writeFile");
    const run = vi.spyOn(ipc, "claudeRunStream");
    const noop = vi.spyOn(ipc, "recordNoop");

    await useIngestStore.getState().startIngest("covered", "a".repeat(400));

    expect(vi.mocked(complete)).toHaveBeenCalledTimes(1); // the planner only
    expect(write).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(noop).toHaveBeenCalledTimes(1);
    expect(useIngestStore.getState().stage).toBe("refused");
    expect(useIngestStore.getState().refusal?.verdict).toBe("noop");
    expect(useIngestStore.getState().plan).toHaveLength(2); // shown as telemetry
  });

  it("does not discard an unread tail when the prefix planner returns only NOOP", async () => {
    compilationFixture("anthropic-cli", "", true);
    vi.spyOn(ipc, "judgeSource").mockResolvedValue({ verdict: "harvest", reason: "prose", rule: "judge::pass" });
    vi.mocked(complete).mockResolvedValue(NOOP_PLAN);
    const write = vi.spyOn(ipc, "writeFile");
    const run = vi.spyOn(ipc, "claudeRunStream").mockResolvedValue({ stdout: "ok", stderr: "", status: 0 } as never);
    const noop = vi.spyOn(ipc, "recordNoop");
    const body = "Existing content. ".repeat(400) + "\nA new decision: use SYN-4719 for the release.";
    await useIngestStore.getState().startIngest("tail", body, { headless: true });
    expect(write.mock.calls[0][1]).toContain("SYN-4719");
    expect(run).toHaveBeenCalledTimes(1);
    expect(noop).not.toHaveBeenCalled();
    expect(useIngestStore.getState().stage).toBe("done");
  });

  it("a normal source still flows: raw/ written after the judge, agent runs, done", async () => {
    vi.spyOn(ipc, "judgeSource").mockResolvedValue({
      verdict: "harvest",
      reason: "prose",
      rule: "judge::pass",
    });
    const write = vi.spyOn(ipc, "writeFile");
    const run = vi
      .spyOn(ipc, "claudeRunStream")
      .mockResolvedValue({ stdout: "ok", stderr: "", status: 0 } as never);
    const noop = vi.spyOn(ipc, "recordNoop");

    await useIngestStore.getState().startIngest("t", "a real source body");

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toBe("/v/raw/t.md");
    expect(run).toHaveBeenCalledTimes(1);
    expect(noop).not.toHaveBeenCalled();
    expect(useIngestStore.getState().stage).toBe("done");
    expect(useIngestStore.getState().refusal).toBeNull();
  });

  it("cancelling at the plan gate ends at cancelled, with nothing written", async () => {
    vi.spyOn(ipc, "judgeSource").mockResolvedValue({
      verdict: "harvest",
      reason: "prose",
      rule: "judge::pass",
    });
    vi.mocked(complete).mockResolvedValue(
      JSON.stringify([{ subject: "new topic", decision: "ADD", target: null, reason: "" }]),
    );
    const write = vi.spyOn(ipc, "writeFile");
    const run = vi.spyOn(ipc, "claudeRunStream");

    const done = useIngestStore.getState().startIngest("t", "a".repeat(400));
    await vi.waitFor(() => expect(useIngestStore.getState().stage).toBe("plan-gate"));
    useIngestStore.getState().cancelIngest();
    await done;

    // Not "idle": the page needs a terminal state to show the cancelled card.
    expect(useIngestStore.getState().stage).toBe("cancelled");
    // The rail reads steps 3-5 as never reached, not "waiting"/"idle".
    expect(useIngestStore.getState().cancelledAt).toBe("gate");
    expect(write).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("a cancel mid-run records that the run got past the gate", async () => {
    vi.spyOn(ipc, "judgeSource").mockResolvedValue({
      verdict: "harvest",
      reason: "prose",
      rule: "judge::pass",
    });
    vi.mocked(complete).mockResolvedValue(
      JSON.stringify([{ subject: "new topic", decision: "ADD", target: null, reason: "" }]),
    );
    vi.spyOn(ipc, "availableRawPath").mockResolvedValue("raw/t.md");
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue({ profile_injection: false } as never);
    vi.spyOn(ipc, "claudeRunStream").mockRejectedValue(new Error("cancelled"));

    const done = useIngestStore.getState().startIngest("t", "a".repeat(400));
    await vi.waitFor(() => expect(useIngestStore.getState().stage).toBe("plan-gate"));
    useIngestStore.getState().skipPlanGate();
    await done;

    expect(useIngestStore.getState().stage).toBe("cancelled");
    expect(useIngestStore.getState().cancelledAt).toBe("run");
    // A new run starts clean.
    useIngestStore.getState().reset();
    expect(useIngestStore.getState().cancelledAt).toBeNull();
  });

  // UX S14: the bar's 고를 차례 ticks on whether the gate was shown, not on a
  // plan existing — a headless run has a plan and nobody was asked.
  it("records that the gate was shown, even when the user applies nothing", async () => {
    vi.spyOn(ipc, "judgeSource").mockResolvedValue({
      verdict: "harvest",
      reason: "prose",
      rule: "judge::pass",
    });
    vi.mocked(complete).mockResolvedValue(
      JSON.stringify([{ subject: "new topic", decision: "ADD", target: null, reason: "" }]),
    );

    const done = useIngestStore.getState().startIngest("t", "a".repeat(400));
    await vi.waitFor(() => expect(useIngestStore.getState().stage).toBe("plan-gate"));
    expect(useIngestStore.getState().gated).toBe(true);
    useIngestStore.getState().resolvePlanGate([false]);
    await done;

    expect(useIngestStore.getState().stage).toBe("refused");
    expect(useIngestStore.getState().refusal?.rule).toBe("planGate::none_selected");
    expect(useIngestStore.getState().gated).toBe(true);
  });

  // UX S35: the clock kept counting while the run waited on the user, which
  // read as loading. It stands still at the gate; choosing is not run time.
  it("the elapsed clock stands still while the plan gate waits", async () => {
    vi.spyOn(ipc, "judgeSource").mockResolvedValue({
      verdict: "harvest",
      reason: "prose",
      rule: "judge::pass",
    });
    vi.mocked(complete).mockResolvedValue(
      JSON.stringify([{ subject: "new topic", decision: "ADD", target: null, reason: "" }]),
    );
    vi.spyOn(ipc, "availableRawPath").mockResolvedValue("raw/t.md");
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue({ profile_injection: false } as never);
    vi.spyOn(ipc, "claudeRunStream").mockResolvedValue({ stdout: "ok", stderr: "", status: 0 } as never);
    let clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);

    const done = useIngestStore.getState().startIngest("t", "a".repeat(400));
    clock += 3_000; // judging and planning
    await vi.waitFor(() => expect(useIngestStore.getState().stage).toBe("plan-gate"));
    const atGate = runElapsedMs(useIngestStore.getState(), clock);
    clock += 60_000; // the user reads the plan for a minute
    expect(runElapsedMs(useIngestStore.getState(), clock)).toBe(atGate);
    useIngestStore.getState().skipPlanGate();
    await done;

    expect(useIngestStore.getState().stage).toBe("done");
    expect(runElapsedMs(useIngestStore.getState(), clock + 99_000)).toBe(atGate);
  });

  // Once the user has chosen, the page must stop saying it waits for a
  // choice, and the clock resumes from the held value — not 0:00 while the
  // raw copy is still being written.
  it("after the choice the run is live again and the clock resumes from the gate", async () => {
    vi.spyOn(ipc, "judgeSource").mockResolvedValue({
      verdict: "harvest",
      reason: "prose",
      rule: "judge::pass",
    });
    vi.mocked(complete).mockResolvedValue(
      JSON.stringify([{ subject: "new topic", decision: "ADD", target: null, reason: "" }]),
    );
    let release: (v: null) => void = () => undefined;
    const raw = vi
      .spyOn(ipc, "findRawCopy")
      .mockImplementation(() => new Promise((res) => (release = res)) as never);
    vi.spyOn(ipc, "availableRawPath").mockResolvedValue("raw/t.md");
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue({ profile_injection: false } as never);
    let clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);

    const done = useIngestStore.getState().startIngest("t", "a".repeat(400));
    clock += 3_000;
    await vi.waitFor(() => expect(useIngestStore.getState().stage).toBe("plan-gate"));
    const atGate = runElapsedMs(useIngestStore.getState(), clock);
    clock += 60_000;
    useIngestStore.getState().skipPlanGate();
    await vi.waitFor(() => expect(raw).toHaveBeenCalled());

    expect(useIngestStore.getState().stage).toBe("writing-raw");
    expect(runElapsedMs(useIngestStore.getState(), clock + 500)).toBe(atGate + 500);
    release(null);
    await done;
  });

  it("a cancel at the gate keeps the time it had when the gate opened", async () => {
    vi.spyOn(ipc, "judgeSource").mockResolvedValue({
      verdict: "harvest",
      reason: "prose",
      rule: "judge::pass",
    });
    vi.mocked(complete).mockResolvedValue(
      JSON.stringify([{ subject: "new topic", decision: "ADD", target: null, reason: "" }]),
    );
    let clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);

    const done = useIngestStore.getState().startIngest("t", "a".repeat(400));
    clock += 2_000;
    await vi.waitFor(() => expect(useIngestStore.getState().stage).toBe("plan-gate"));
    const atGate = runElapsedMs(useIngestStore.getState(), clock);
    clock += 30_000;
    useIngestStore.getState().cancelIngest();
    await done;

    expect(useIngestStore.getState().stage).toBe("cancelled");
    expect(runElapsedMs(useIngestStore.getState(), clock)).toBe(atGate);
  });

  it("a headless run with a plan never shows the gate", async () => {
    compilationFixture("anthropic-cli", "", true);
    vi.spyOn(ipc, "judgeSource").mockResolvedValue({
      verdict: "harvest",
      reason: "prose",
      rule: "judge::pass",
    });
    vi.mocked(complete).mockResolvedValue(
      JSON.stringify([{ subject: "new topic", decision: "ADD", target: null, reason: "" }]),
    );
    vi.spyOn(ipc, "availableRawPath").mockResolvedValue("raw/t.md");
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue({ profile_injection: false } as never);
    vi.spyOn(ipc, "claudeRunStream").mockResolvedValue({ stdout: "ok", stderr: "", status: 0 } as never);
    // A previous run's gate must not carry over into this one.
    useIngestStore.setState({ gated: true });

    await useIngestStore.getState().startIngest("t", "a".repeat(400), { headless: true });

    expect(useIngestStore.getState().stage).toBe("done");
    expect(useIngestStore.getState().plan).toHaveLength(1);
    expect(useIngestStore.getState().gated).toBe(false);
  });

  it("keeps the input pending when the judge itself is unavailable", async () => {
    vi.spyOn(ipc, "judgeSource").mockRejectedValue(new Error("no such command"));
    const run = vi
      .spyOn(ipc, "claudeRunStream")
      .mockResolvedValue({ stdout: "ok", stderr: "", status: 0 } as never);

    await useIngestStore.getState().startIngest("t", "a real source body");

    expect(run).not.toHaveBeenCalled();
    expect(ipc.writeFile).not.toHaveBeenCalled();
    expect(useIngestStore.getState().sourceText).toBe("a real source body");
    expect(useIngestStore.getState().workflowStatus).toBe("pending");
    expect(useIngestStore.getState().log).toContain("no such command");
    expect(useIngestStore.getState().stage).toBe("error");
  });
});

// Feed-render perf: the panel re-rendered 500 rows per stream event because
// every event handed subscribers new array identities. Rows are now keyed by
// `seq`, and `touched` must keep its identity when nothing about it changed.
describe("applyStreamEvent identity + seq", () => {
  const ev = (
    kind: "text" | "tool",
    over: { tool?: string; detail?: string; text?: string } = {},
  ) => ({
    run_id: "r",
    kind,
    tool: over.tool ?? null,
    detail: over.detail ?? null,
    text: over.text ?? null,
  });

  beforeEach(() => {
    // Write events schedule the debounced live rescan through `window`, which
    // the node test env does not provide.
    vi.stubGlobal("window", {
      setTimeout: () => 0,
      clearTimeout: () => undefined,
    });
    useIngestStore.setState({ events: [], touched: [], readCount: 0, writeCount: 0 });
  });

  it("gives every event a strictly increasing seq", () => {
    applyStreamEvent(ev("text", { text: "a" }));
    applyStreamEvent(ev("text", { text: "b" }));
    const { events } = useIngestStore.getState();
    expect(events).toHaveLength(2);
    expect(events[1].seq).toBeGreaterThan(events[0].seq);
  });

  it("keeps the touched array identity when the same page is read twice", () => {
    applyStreamEvent(ev("tool", { tool: "Read", detail: "wiki/a.md" }));
    const first = useIngestStore.getState().touched;
    applyStreamEvent(ev("tool", { tool: "Read", detail: "wiki/a.md" }));
    expect(useIngestStore.getState().touched).toBe(first);
    expect(useIngestStore.getState().readCount).toBe(2);
  });

  it("replaces it only when a page flips read → written", () => {
    applyStreamEvent(ev("tool", { tool: "Read", detail: "wiki/a.md" }));
    const first = useIngestStore.getState().touched;
    applyStreamEvent(ev("tool", { tool: "Write", detail: "wiki/a.md" }));
    const second = useIngestStore.getState().touched;
    expect(second).not.toBe(first);
    expect(second[0].write).toBe(true);
  });

  it("keeps identity when a plain text event arrives", () => {
    applyStreamEvent(ev("tool", { tool: "Read", detail: "wiki/a.md" }));
    const first = useIngestStore.getState().touched;
    applyStreamEvent(ev("text", { text: "thinking" }));
    expect(useIngestStore.getState().touched).toBe(first);
  });
});

// Built-in (offline) ingest — the provider with no chat model at all. It must
// write a real ingest (the same file set the LLM path writes) and must do it
// with ZERO model calls, because that is exactly what the run's own report
// tells the user. If either ever stops holding, Settings' "Built-in (offline)"
// ingest option is a button that can only fail, which is how it came to be
// removed in the first place.
describe("builtin-local offline ingest", () => {
  let files: Record<string, string>;

  const rels = (): string[] =>
    Object.keys(files)
      .map((p) => p.replace("/v/", ""))
      .sort();

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(ipc, "findRawCopy").mockResolvedValue(null);
    vi.spyOn(ipc, "availableRawPath").mockImplementation(async slug => `raw/${slug}.md`);
    vi.spyOn(ipc, "judgeSource").mockResolvedValue({ verdict: "harvest", reason: "synthetic admission", rule: "judge::pass" });
    vi.spyOn(ipc, "scanTextSecrets").mockResolvedValue({ secrets: [], pii: [] });
    vi.mocked(complete).mockClear();
    listenMock.mockClear();
    files = {};
    useIngestStore.setState({ stage: "idle", runId: null, judged: [] });

    vi.spyOn(ipc, "getSettings").mockResolvedValue({
      ingest_provider: "builtin-local",
      ingest_model: "extractive-ingest",
      model_roles: compilationFixture("builtin-local", "extractive-ingest"),
      // A query provider that CAN generate: the planner must still be skipped,
      // or the run would make a model call its own report denies making.
      query_provider: "anthropic-cli",
      query_model: "haiku",
    } as never);
    vi.spyOn(ipc, "judgeSource").mockResolvedValue({
      verdict: "harvest",
      reason: "",
      rule: "",
    } as never);
    vi.spyOn(ipc, "availableRawPath").mockResolvedValue("raw/my-source.md");
    vi.spyOn(ipc, "createFolder").mockResolvedValue(undefined as never);
    vi.spyOn(ipc, "wikifyCandidates").mockResolvedValue([
      { page: "wiki/rrf.md", stem: "rrf", score: 0.6 },
    ]);
    vi.spyOn(ipc, "writeFile").mockImplementation((async (p: string, c: string) => {
      files[p] = c;
    }) as never);
    vi.spyOn(ipc, "writeFileIfUnchanged").mockImplementation(async (p, c, expected) => {
      const actual = p in files ? await sha256(files[p]) : null;
      if (expected !== actual) throw new Error("write conflict: file changed before save");
      await ipc.writeFile(p, c);
      return null;
    });
    vi.spyOn(ipc, "readFile").mockImplementation((async (p: string) => {
      if (!(p in files)) throw new Error("ENOENT");
      return { raw: files[p] };
    }) as never);
    vi.spyOn(ipc, "fileMtimes").mockImplementation(async () =>
      Object.keys(files).map((p) => [p, 1] as [string, number]),
    );
    vi.spyOn(ipc, "validateIngest").mockResolvedValue({
      errors: [],
      warnings: [],
    } as never);
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue({
      profile_injection: false,
    } as never);
    vi.spyOn(ipc, "buildLinkGraph").mockResolvedValue({ nodes: [], edges: [] } as never);
    vi.spyOn(ipc, "recordNoop").mockResolvedValue(undefined as never);
  });

  const SOURCE =
    "Hybrid retrieval fuses a dense vector arm with a lexical arm, and the " +
    "fusion recovers queries neither arm answers alone.";

  it("uses the native local Compilation route despite a legacy external provider", async () => {
    vi.mocked(ipc.getSettings).mockResolvedValue({
      ingest_provider: "anthropic-cli", ingest_model: "legacy-external",
      model_roles: compilationFixture("builtin-local", "extractive-ingest"),
    } as never);
    const stream = vi.spyOn(ipc, "claudeRunStream").mockResolvedValue({ stdout: "synthetic unsupported route", stderr: "", status: 0 });
    await useIngestStore.getState().startIngest("My source", SOURCE);
    expect(stream).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(useIngestStore.getState().stage).toBe("done");
    expect(files["/v/raw/my-source.md"]).toContain(SOURCE);
  });

  it("never calls the completion API — not for the plan, not for the write", async () => {
    await useIngestStore.getState().startIngest("My source", SOURCE);
    expect(complete).not.toHaveBeenCalled();
    expect(useIngestStore.getState().stage).toBe("done");
  });

  it("stops a selected local preview without writing later notes even when native succeeds late", async () => {
    vi.mocked(ipc.getSettings).mockResolvedValue({ ingest_provider: "builtin-local", ingest_model: BUILTIN_CHAT_MODEL,
      model_roles: compilationFixture("builtin-local", BUILTIN_CHAT_MODEL),
      query_provider: "builtin-local", query_model: "extractive-retrieval" } as never);
    let finish!: (reply: Awaited<ReturnType<typeof ipc.localTransform>>) => void;
    const transform = vi.spyOn(ipc, "localTransform").mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const cancel = vi.spyOn(ipc, "cancelLocalSynthesis").mockResolvedValue(true);
    const cliCancel = vi.spyOn(ipc, "claudeCancel").mockResolvedValue(true);
    const pending = useIngestStore.getState().startIngest("My source", SOURCE);
    await vi.waitFor(() => expect(transform).toHaveBeenCalledOnce());
    const request = transform.mock.calls[0][0];
    useIngestStore.getState().cancelIngest();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith(request.requestId));
    await pending;
    expect(useIngestStore.getState().stage).toBe("cancelled");
    expect(useIngestStore.getState().cancelledAt).toBe("run");
    expect(rels()).toEqual(["raw/my-source.md"]);
    finish({ answer: "The source records hybrid retrieval. [[raw/my-source]]", model_id: BUILTIN_CHAT_MODEL,
      used_sources: ["raw/my-source.md"], selected_chunks: 1 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(rels()).toEqual(["raw/my-source.md"]);
    expect(cliCancel).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it.each(["refreshTree", "refreshLinkGraph", "fileMtimes", "validateIngest"] as const)(
    "preserves a reset while %s is verifying a completed local ingest", async boundary => {
      await verifyPostIngestTransition(boundary, "reset");
    },
  );

  it.each(["refreshTree", "refreshLinkGraph", "fileMtimes", "validateIngest"] as const)(
    "preserves a newer run while %s settles for a completed local ingest", async boundary => {
      await verifyPostIngestTransition(boundary, "new-run");
    },
  );

  it.each(["refreshTree", "refreshLinkGraph", "fileMtimes", "validateIngest"] as const)(
    "does not publish old-vault success after a switch during %s", async boundary => {
      await verifyPostIngestTransition(boundary, "vault-switch");
    },
  );

  it.each(["refreshTree", "refreshLinkGraph", "fileMtimes", "validateIngest"] as const)(
    "does not publish success from an earlier opening of the same vault during %s", async boundary => {
      await verifyPostIngestTransition(boundary, "vault-reopen");
    },
  );

  async function verifyPostIngestTransition(
    boundary: "refreshTree" | "refreshLinkGraph" | "fileMtimes" | "validateIngest",
    transition: "reset" | "new-run" | "vault-switch" | "vault-reopen",
  ): Promise<void> {
    vi.mocked(ipc.getSettings).mockResolvedValue({ ingest_provider: "builtin-local", ingest_model: BUILTIN_CHAT_MODEL,
      model_roles: compilationFixture("builtin-local", BUILTIN_CHAT_MODEL),
      query_provider: "builtin-local", query_model: "extractive-retrieval" } as never);
    vi.spyOn(ipc, "localTransform").mockResolvedValue({
      answer: "The source records hybrid retrieval. [[raw/my-source]]", model_id: BUILTIN_CHAT_MODEL,
      used_sources: ["raw/my-source.md"], selected_chunks: 1,
    });
    const origin = { ...useVaultStore.getState(), vaultToken: "synthetic-origin", isOpeningVault: false };
    let currentVaultState = origin;
    vi.spyOn(useVaultStore, "getState").mockImplementation(() => currentVaultState);
    let release!: () => void;
    let isWaiting = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    const pause = async (): Promise<void> => { isWaiting = true; await held; };
    if (boundary === "refreshTree" || boundary === "refreshLinkGraph") {
      vi.mocked(origin[boundary]).mockImplementation(async () => {
        if (useIngestStore.getState().stage === "indexing") await pause();
      });
    } else if (boundary === "fileMtimes") {
      vi.mocked(ipc.fileMtimes).mockImplementation(async () => {
        if (useIngestStore.getState().stage === "indexing") await pause();
        return Object.keys(files).map(path => [path, 1] as [string, number]);
      });
    } else {
      vi.mocked(ipc.validateIngest).mockImplementation(async () => {
        await pause();
        return { errors: [], warnings: [] };
      });
    }
    const pending = useIngestStore.getState().startIngest("My source", SOURCE);
    await vi.waitFor(() => expect(isWaiting).toBe(true));
    const writtenBeforeTransition = { ...files };
    expect(rels()).toContain("wiki/source-my-source.md");
    if (transition === "vault-switch" || transition === "vault-reopen") {
      currentVaultState = { ...origin, vaultToken: "synthetic-next",
        currentVault: { ...origin.currentVault!, path: transition === "vault-switch" ? "/synthetic-next-vault" : "/v" } };
    } else {
      useIngestStore.getState().reset();
      if (transition === "new-run") useIngestStore.setState({
        runId: "synthetic-new-run", stage: "claude", log: "New run remains active",
        changedPages: ["wiki/synthetic-new.md"], reportPath: "/v/ingest-reports/synthetic-new.md",
      });
    }
    const expectedState = useIngestStore.getState();
    release();
    await pending;
    expect(files).toEqual(writtenBeforeTransition);
    if (transition === "vault-switch" || transition === "vault-reopen") {
      expect(useIngestStore.getState().stage).toBe("cancelled");
      expect(useIngestStore.getState().changedPages).toEqual([]);
      expect(useIngestStore.getState().reportPath).toBeNull();
      expect(useIngestStore.getState().judged).toEqual([]);
    } else {
      expect(useIngestStore.getState()).toEqual(expectedState);
    }
  }

  it("verifies repeated local passes even when filesystem mtimes share the same second", async () => {
    vi.spyOn(ipc, "findRawCopy").mockImplementation(async () =>
      "/v/raw/my-source.md" in files ? { path: "raw/my-source.md" } as never : null,
    );
    await useIngestStore.getState().startIngest("My source", SOURCE, { headless: true });
    await useIngestStore.getState().startIngest("My source", SOURCE, { headless: true });
    expect(useIngestStore.getState().stage).toBe("done");
    expect(useIngestStore.getState().changedPages).toContain("wiki/source-my-source.md");
    expect(rels().filter((path) => path.startsWith("raw/"))).toEqual(["raw/my-source.md"]);
  });

  it("writes exactly the file set the CLI path writes", async () => {
    await useIngestStore.getState().startIngest("My source", SOURCE);
    const written = rels();
    expect(written.filter((p) => !p.startsWith("ingest-reports/"))).toEqual([
      "raw/my-source.md",
      "wiki/index.md",
      "wiki/log.md",
      "wiki/source-my-source.md",
    ]);
    const reports = written.filter((p) => p.startsWith("ingest-reports/"));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatch(
      /^ingest-reports\/\d{4}-\d{2}-\d{2}-\d{6}-my-source\.md$/,
    );
  });

  it("opens the report it wrote and cites the raw source on every claim", async () => {
    await useIngestStore.getState().startIngest("My source", SOURCE);
    expect(useIngestStore.getState().reportPath).toMatch(
      /^\/v\/ingest-reports\/.*-my-source\.md$/,
    );

    const page = files["/v/wiki/source-my-source.md"];
    expect(page).toContain("type: source-summary");
    expect(page).toContain("confidence: low");
    const claims = page
      .split("\n")
      .filter((l) => l.startsWith("- ") && !l.startsWith("- [["));
    expect(claims.length).toBeGreaterThan(0);
    for (const line of claims) expect(line.endsWith("[^src-my-source]")).toBe(true);
    // The embedder's candidate, linked the way accepting a link suggestion does.
    expect(page).toContain("## Related");
    expect(page).toContain("- [[rrf]]");
  });

  it("lists the wiki pages it changed at done, with no tool stream at all", async () => {
    // The success card's "N pages updated" links. Offline, myco Pro and the
    // HTTP providers stream no tool events, so a streamed list stays empty.
    await useIngestStore.getState().startIngest("My source", SOURCE);
    expect(useIngestStore.getState().stage).toBe("done");
    // Wiki pages only — the report has its own button, raw/ is the source.
    expect([...useIngestStore.getState().changedPages].sort()).toEqual([
      "wiki/index.md",
      "wiki/log.md",
      "wiki/source-my-source.md",
    ]);
  });

  it("links a transcript candidate through the summary the vault has", async () => {
    vi.mocked(ipc.wikifyCandidates).mockResolvedValue([
      { page: "sessions/2026-09/claude-code-aaa.md", stem: "claude-code-aaa", score: 0.9 },
      { page: "sessions/2026-09/codex-bbb.md", stem: "codex-bbb", score: 0.8 },
    ]);
    await useIngestStore.getState().startIngest("My source", SOURCE);
    const page = files["/v/wiki/source-my-source.md"];
    expect(page).toContain("- [[source-claude-code-aaa]]");
    expect(page).not.toContain("[[claude-code-aaa]]");
    expect(page).not.toContain("codex-bbb");
  });

  it("writes nothing at all when the judge drops the source", async () => {
    vi.mocked(ipc.judgeSource).mockResolvedValue({
      verdict: "drop",
      reason: "no actionable content",
      rule: "judge::junk",
    } as never);

    await useIngestStore.getState().startIngest("My source", SOURCE);

    expect(files).toEqual({});
    expect(complete).not.toHaveBeenCalled();
    expect(useIngestStore.getState().stage).toBe("refused");
    expect(useIngestStore.getState().refusal?.verdict).toBe("drop");
  });
});

// raw/ is immutable, so every copy an ingest writes is permanent. A source
// whose model call failed stayed in _inbox/ and the next pass wrote
// raw/<slug>-2.md, -3.md, … — one real session left 19 copies. Spec
// 2026-10-02-raw-hygiene, decision 1: one raw copy per source body.
describe("one raw copy per source body", () => {
  let files: Record<string, string>;
  let tick: number;

  const rawFiles = (): string[] =>
    Object.keys(files)
      .filter((p) => p.startsWith("/v/raw/"))
      .map((p) => p.slice(3))
      .sort();

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(ipc, "findRawCopy").mockResolvedValue(null);
    vi.spyOn(ipc, "availableRawPath").mockImplementation(async slug => `raw/${slug}.md`);
    vi.spyOn(ipc, "judgeSource").mockResolvedValue({ verdict: "harvest", reason: "synthetic admission", rule: "judge::pass" });
    vi.spyOn(ipc, "scanTextSecrets").mockResolvedValue({ secrets: [], pii: [] });
    vi.mocked(complete).mockReset().mockResolvedValue("done");
    listenMock.mockClear();
    files = {};
    tick = 0;
    useIngestStore.setState({ stage: "idle", runId: null, judged: [] });

    vi.spyOn(ipc, "getSettings").mockResolvedValue({
      ingest_provider: "anthropic-cli",
      ingest_model: "",
      model_roles: compilationFixture("anthropic-cli", ""),
      query_provider: "builtin-local",
      query_model: "gemma-3-1b",
    } as never);
    vi.spyOn(ipc, "judgeSource").mockResolvedValue({
      verdict: "harvest",
      reason: "",
      rule: "",
    } as never);
    vi.spyOn(ipc, "createFolder").mockResolvedValue(undefined as never);
    vi.spyOn(ipc, "wikifyCandidates").mockResolvedValue([]);
    vi.spyOn(ipc, "getDistillConfig").mockResolvedValue({
      profile_injection: false,
    } as never);
    vi.spyOn(ipc, "validateIngest").mockResolvedValue({ errors: [], warnings: [] });
    vi.spyOn(ipc, "buildLinkGraph").mockResolvedValue({ nodes: [], edges: [] } as never);
    // A wiki page that moves on every look, so a run that gets past the
    // model counts as having changed the wiki.
    vi.spyOn(ipc, "fileMtimes").mockImplementation(async () => [
      ["/v/wiki/foo.md", ++tick],
    ]);
    // The backend's raw/ commands, over an in-memory vault: the -2/-3 suffix
    // rule (vault::available_raw_path) and the byte match (find_raw_copy),
    // with whether another raw copy has the hit's stem.
    vi.spyOn(ipc, "availableRawPath").mockImplementation(async (stem: string) => {
      for (let n = 1; ; n++) {
        const rel = n === 1 ? `raw/${stem}.md` : `raw/${stem}-${n}.md`;
        if (!(`/v/${rel}` in files)) return rel;
      }
    });
    vi.spyOn(ipc, "findRawCopy").mockImplementation(async (content: string) => {
      const copies = Object.keys(files)
        .sort()
        .filter((p) => /^\/v\/raw\/(archive\/.+|[^/]+)\.md$/.test(p));
      const hit = copies.find((p) => files[p] === content);
      if (!hit) return null;
      const stemOf = (p: string): string => p.split("/").pop()!.replace(/\.md$/, "");
      const shared = copies.some((p) => p !== hit && stemOf(p) === stemOf(hit));
      return { path: hit.slice(3), shared };
    });
    vi.spyOn(ipc, "writeFile").mockImplementation((async (p: string, c: string) => {
      if (p.startsWith("/v/raw/") && p in files) throw new Error("refused: raw/ is immutable");
      files[p] = c;
    }) as never);
    vi.spyOn(ipc, "writeFileIfUnchanged").mockImplementation(async (p, c, expected) => {
      const actual = p in files ? await sha256(files[p]) : null;
      if (expected !== actual) throw new Error("write conflict: file changed before save");
      await ipc.writeFile(p, c);
      return null;
    });
  });

  const BODY = "a real source body that the model keeps failing on";
  const failed = { stdout: "", stderr: "provider overloaded", status: 1 };
  const ok = { stdout: "ok", stderr: "", status: 0 };

  it("an ingest that fails twice and then succeeds leaves exactly one raw file", async () => {
    compilationFixture("anthropic-cli", "", true);
    const run = vi
      .spyOn(ipc, "claudeRunStream")
      .mockResolvedValueOnce(failed as never)
      .mockResolvedValueOnce(failed as never)
      .mockResolvedValueOnce(ok as never);

    // The inbox pass retries the same source while it stays in _inbox/.
    for (let i = 0; i < 3; i++) {
      await useIngestStore.getState().startIngest("t", BODY, { headless: true });
    }

    expect(useIngestStore.getState().stage).toBe("done");
    expect(rawFiles()).toEqual(["raw/t.md"]);
    // Every attempt pointed the model at that one copy.
    expect(run).toHaveBeenCalledTimes(3);
    for (const [, prompt] of run.mock.calls) {
      expect(prompt).toContain("New source has been added at `raw/t.md`");
    }
  });

  it("an untitled source run again after a failure reuses its one raw file", async () => {
    // The title field is optional; an empty one used to become
    // `untitled-<clock>`, which went into the payload and made every attempt
    // a body no raw file matched.
    vi.spyOn(ipc, "claudeRunStream")
      .mockResolvedValueOnce(failed as never)
      .mockResolvedValueOnce(ok as never);

    await useIngestStore.getState().startIngest("", BODY);
    expect(useIngestStore.getState().stage).toBe("error");
    await useIngestStore.getState().startIngest("", BODY);

    expect(useIngestStore.getState().stage).toBe("done");
    expect(rawFiles()).toHaveLength(1);
    expect(rawFiles()[0]).toMatch(/^raw\/untitled-[0-9a-f]{8}\.md$/);
    // Another untitled body is still its own source.
    await useIngestStore.getState().startIngest("", `${BODY}, edited`);
    expect(rawFiles()).toHaveLength(2);
  });

  it("two different bodies under one title still get a file each", async () => {
    compilationFixture("anthropic-cli", "", true);
    vi.spyOn(ipc, "claudeRunStream").mockResolvedValue(ok as never);

    await useIngestStore.getState().startIngest("t", BODY, { headless: true });
    await useIngestStore.getState().startIngest("t", `${BODY}, edited`, { headless: true });

    expect(rawFiles()).toEqual(["raw/t-2.md", "raw/t.md"]);
  });

  it("reuses the copy distill already moved to raw/archive/", async () => {
    compilationFixture("anthropic-cli", "", true);
    const run = vi.spyOn(ipc, "claudeRunStream").mockResolvedValue(ok as never);
    await useIngestStore.getState().startIngest("t", BODY, { headless: true });
    // distill's archive pass: raw/t.md -> raw/archive/<month>/t.md.
    files["/v/raw/archive/2026-09/t.md"] = files["/v/raw/t.md"];
    delete files["/v/raw/t.md"];
    const write = vi.mocked(ipc.writeFile);
    write.mockClear();

    await useIngestStore.getState().startIngest("t", BODY, { headless: true });

    expect(useIngestStore.getState().stage).toBe("done");
    expect(rawFiles()).toEqual(["raw/archive/2026-09/t.md"]);
    expect(write).not.toHaveBeenCalled();
    // The model reads the copy where it is; the summary page keeps the
    // file's own stem, which is what [^src-t] citations resolve by.
    const prompt = run.mock.calls[1][1];
    expect(prompt).toContain("New source has been added at `raw/archive/2026-09/t.md`");
    expect(prompt).toContain("`wiki/source-t.md`");
    expect(prompt).not.toContain("source-archive");
  });

  it("an offline run over an archived copy names that copy as its source", async () => {
    vi.spyOn(ipc, "getSettings").mockResolvedValue({
      ingest_provider: "builtin-local",
      ingest_model: "",
      model_roles: compilationFixture("builtin-local", "extractive-ingest"),
      query_provider: "builtin-local",
      query_model: "gemma-3-1b",
    } as never);
    vi.spyOn(ipc, "readFile").mockImplementation((async (p: string) => {
      if (p in files) return { raw: files[p] };
      throw new Error("ENOENT");
    }) as never);
    const A = "Alpha sentence one is right here. Alpha sentence two is here too.";
    files["/v/raw/archive/2026-09/t.md"] = `# t\n\n${A}\n`;

    await useIngestStore.getState().startIngest("t", A, { headless: true });

    expect(useIngestStore.getState().stage).toBe("done");
    expect(rawFiles()).toEqual(["raw/archive/2026-09/t.md"]);
    // There is no raw/t.md: the report and the summary page must name the
    // file the passages were quoted from.
    const report = Object.keys(files).find((p) => p.startsWith("/v/ingest-reports/"))!;
    expect(files[report]).toContain("- source: `raw/archive/2026-09/t.md`");
    expect(files["/v/wiki/source-t.md"]).toContain("`raw/archive/2026-09/t.md`");
    expect(files["/v/wiki/source-t.md"]).toContain("[^src-t]");
  });

  it("keeps an inbox image pending across retries without unbound extraction or writes", async () => {
    compilationFixture("anthropic-cli", "", true);
    const pending = { name: "shot.png", rel: "_inbox/shot.png", ext: "png", bytes: 3, mtime: 1 };
    vi.spyOn(ipc, "listInboxEntries").mockResolvedValue([pending]);
    const archive = vi.spyOn(ipc, "archiveInboxSourceChecked");
    const legacyArchive = vi.spyOn(ipc, "archiveInboxSource");
    const describe = vi.spyOn(ipc, "describeImage");
    const marker = vi.spyOn(ipc, "derivedRawCopy");
    const run = vi.spyOn(ipc, "claudeRunStream");
    files["/v/_inbox/shot.png"] = "Synthetic unchanged image bytes";

    for (let i = 0; i < 3; i++) expect(await runInboxPass("/v")).toMatchObject({
      ingested: false, held: 1, pendingReason: expect.any(String),
    });

    expect(useIngestStore.getState().stage).toBe("idle");
    expect(rawFiles()).toEqual([]);
    expect(files).toEqual({ "/v/_inbox/shot.png": "Synthetic unchanged image bytes" });
    expect(describe).not.toHaveBeenCalled();
    expect(marker).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
    expect(legacyArchive).not.toHaveBeenCalled();
  });

  it("keeps only the original when another raw copy has the reused one's name", async () => {
    compilationFixture("anthropic-cli", "", true);
    // A vault from before raw names checked raw/archive/: Alpha was archived
    // as t, then Beta got raw/t.md and wiki/source-t.md. Re-ingesting Alpha
    // must not write over Beta's summary, nor file a second Alpha.
    const run = vi.spyOn(ipc, "claudeRunStream").mockResolvedValue(ok as never);
    files["/v/raw/archive/2026-09/t.md"] = `# t\n\n${BODY}\n`;
    files["/v/raw/t.md"] = "# t\n\nBeta, another body filed under the same title.\n";
    files["/v/wiki/source-t.md"] = "summary of the BETA body\n";
    const write = vi.mocked(ipc.writeFile);
    write.mockClear();

    await useIngestStore.getState().startIngest("t", BODY, { headless: true });

    const st = useIngestStore.getState();
    expect(st.stage).toBe("refused");
    expect(st.refusal).toMatchObject({ verdict: "log", rule: "raw::name_shared" });
    expect(st.refusal?.reason).toContain("raw/archive/2026-09/t.md");
    expect(run).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(files["/v/wiki/source-t.md"]).toBe("summary of the BETA body\n");
  });
});

describe("runElapsedMs", () => {
  const base = { startedAt: 1_000, finishedAt: null, gateAt: null };

  it("counts up while the run works and freezes at its end", () => {
    expect(runElapsedMs({ ...base, stage: "claude" }, 5_000)).toBe(4_000);
    expect(runElapsedMs({ ...base, stage: "done", finishedAt: 3_000 }, 9_000)).toBe(2_000);
  });

  it("stops at the moment the gate opened", () => {
    expect(runElapsedMs({ ...base, stage: "plan-gate", gateAt: 2_500 }, 90_000)).toBe(1_500);
  });

  it("is zero before any run", () => {
    expect(runElapsedMs({ stage: "idle", startedAt: null, finishedAt: null, gateAt: null }, 5)).toBe(0);
  });
});

// UX S35: "짧은 메모" was refused as if it had no content. A short body the
// junk floor turned away is offered a note instead.
describe("isShortNote", () => {
  const junk = { verdict: "drop" as const, reason: "junk heuristic: 13 bytes (< 200)", rule: "junk_reason" };

  it("is a short body the junk floor dropped", () => {
    expect(isShortNote(junk, "짧은 메모")).toBe(true);
    // The dev mock names the same rule with a suffix.
    expect(isShortNote({ ...junk, rule: "junk_reason::min_bytes" }, "short")).toBe(true);
  });

  it("is not an empty body, a long noisy one, or another rule", () => {
    expect(isShortNote(junk, "   ")).toBe(false);
    expect(isShortNote(junk, "a".repeat(200))).toBe(false);
    expect(isShortNote({ ...junk, rule: "duplicate" }, "short")).toBe(false);
    expect(isShortNote({ ...junk, verdict: "noop" }, "short")).toBe(false);
  });

  it("counts UTF-8 bytes, as the judge does", () => {
    // 67 Hangul syllables are 201 bytes: over the floor.
    expect(isShortNote(junk, "가".repeat(67))).toBe(false);
    expect(isShortNote(junk, "가".repeat(66))).toBe(true);
  });
});

// Spec 2026-10-03-paste-guard: pasted text and YouTube transcripts reach raw/
// through startIngest, so it runs the link import's secret/PII check first.
describe("startIngest source check", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(ipc, "findRawCopy").mockResolvedValue(null);
    vi.spyOn(ipc, "availableRawPath").mockImplementation(async slug => `raw/${slug}.md`);
    vi.spyOn(ipc, "judgeSource").mockResolvedValue({ verdict: "harvest", reason: "synthetic admission", rule: "judge::pass" });
    listenMock.mockClear();
    vi.mocked(complete).mockReset().mockResolvedValue("done");
    useUIStore.setState({ lang: "en" });
    useIngestStore.setState({ stage: "idle", runId: null, refusal: null });
    vi.spyOn(ipc, "getSettings").mockResolvedValue({
      ingest_provider: "anthropic-cli",
      ingest_model: "",
      model_roles: compilationFixture("anthropic-cli", ""),
      query_provider: "builtin-local",
      query_model: "gemma-3-1b",
      pii_quarantine_enabled: false,
    } as never);
    vi.spyOn(ipc, "createFolder").mockResolvedValue(undefined as never);
    vi.spyOn(ipc, "writeFile").mockResolvedValue(undefined as never);
    vi.spyOn(ipc, "readVaultContext").mockResolvedValue("");
    vi.spyOn(ipc, "wikifyCandidates").mockResolvedValue([]);
    vi.spyOn(ipc, "recordNoop").mockResolvedValue(undefined);
    vi.spyOn(ipc, "buildLinkGraph").mockResolvedValue({ nodes: [], edges: [] } as never);
    vi.spyOn(ipc, "fileMtimes")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([["/v/wiki/foo.md", 1]]);
    vi.spyOn(ipc, "validateIngest").mockResolvedValue({ errors: [], warnings: [] });
    vi.spyOn(ipc, "judgeSource").mockResolvedValue({
      verdict: "harvest",
      reason: "prose",
      rule: "judge::pass",
    });
    vi.spyOn(ipc, "claudeRunStream").mockResolvedValue({
      stdout: "ok",
      stderr: "",
      status: 0,
    } as never);
  });

  /** Nothing reached disk, the judge or a model, and nothing was logged. */
  function expectNothingWritten(): void {
    expect(ipc.writeFile).not.toHaveBeenCalled();
    expect(ipc.judgeSource).not.toHaveBeenCalled();
    expect(vi.mocked(complete)).not.toHaveBeenCalled();
    expect(ipc.claudeRunStream).not.toHaveBeenCalled();
    // The noop log is on disk and carries the slug — a title can hold the key.
    expect(ipc.recordNoop).not.toHaveBeenCalled();
  }

  it("refuses a secret before raw/, without echoing it, title included", async () => {
    const scan = vi
      .spyOn(ipc, "scanTextSecrets")
      .mockImplementation(async (text) => ({
        secrets: text.includes("sk-FAKE") ? ["OpenAI/Anthropic-style API key"] : [],
        pii: [],
      }));

    await useIngestStore.getState().startIngest("key sk-FAKE", "a harmless pasted body");

    expect(scan.mock.calls[0][0]).toContain("a harmless pasted body");
    expectNothingWritten();
    const st = useIngestStore.getState();
    expect(st.stage).toBe("refused");
    expect(st.refusal).toEqual({
      verdict: "drop",
      reason: STRINGS.en.ing_guard_secret,
      rule: "guard::secret",
    });
    expect(st.refusal?.reason).not.toContain("sk-FAKE");
    // The verdict row shows the name: a title slug would print the key.
    expect(st.judged[0].name.toLowerCase()).not.toContain("sk-fake");
    expect(st.log.toLowerCase()).not.toContain("sk-fake");
  });

  it("refuses PII under quarantine", async () => {
    vi.mocked(ipc.getSettings).mockResolvedValue({
      ingest_provider: "anthropic-cli",
      model_roles: compilationFixture("anthropic-cli", ""),
      pii_quarantine_enabled: true,
    } as never);
    vi.spyOn(ipc, "scanTextSecrets").mockResolvedValue({ secrets: [], pii: ["Email address"] });

    await useIngestStore.getState().startIngest("t", "a pasted body");

    expectNothingWritten();
    expect(useIngestStore.getState().refusal?.rule).toBe("guard::pii");
  });

  it("warns about PII otherwise and carries on", async () => {
    vi.spyOn(ipc, "scanTextSecrets").mockResolvedValue({ secrets: [], pii: ["Email address"] });
    const warn = vi.spyOn(notice, "warn");

    await useIngestStore.getState().startIngest("t", "a pasted body");

    expect(warn).toHaveBeenCalledWith(STRINGS.en.ing_guard_pii_warn);
    expect(ipc.writeFile).toHaveBeenCalledTimes(1);
    expect(useIngestStore.getState().stage).toBe("done");
  });

  it("fails closed when the scan fails", async () => {
    vi.spyOn(ipc, "scanTextSecrets").mockRejectedValue(new Error("scan down"));

    await useIngestStore.getState().startIngest("t", "a pasted body");

    expectNothingWritten();
    expect(useIngestStore.getState().refusal?.rule).toBe("guard::scan");
  });

  it("lets a clean source through without a warning", async () => {
    vi.spyOn(ipc, "scanTextSecrets").mockResolvedValue({ secrets: [], pii: [] });
    const warn = vi.spyOn(notice, "warn");

    await useIngestStore.getState().startIngest("t", "a pasted body");

    expect(warn).not.toHaveBeenCalled();
    expect(useIngestStore.getState().stage).toBe("done");
  });
});

describe("refusalLine", () => {
  const s = STRINGS.en;

  it("shows a guard refusal's own message alone", () => {
    const r = { verdict: "drop" as const, reason: s.ing_guard_secret, rule: "guard::secret" };
    expect(refusalLine(r, s)).toBe(s.ing_guard_secret);
  });

  it("frames a judge refusal with its verdict title", () => {
    const drop = { verdict: "drop" as const, reason: "dup", rule: "duplicate" };
    expect(refusalLine(drop, s)).toBe(s.ing_refused_title.replace("{reason}", "dup"));
    const kept = { verdict: "log" as const, reason: "x", rule: "judge::log" };
    expect(refusalLine(kept, s)).toBe(s.ing_logged_title.replace("{reason}", "x"));
  });
});
