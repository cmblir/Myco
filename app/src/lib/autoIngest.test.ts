// Mocked frontend transport only; native snapshot and model authority have separate gates.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InboxEntry,
  InboxSourceSnapshot,
  SessionCompileContext,
  SessionCompileStepResult,
} from "./ipc";
import { roleFixture } from "./modelRoles.testSupport";
import { WorkflowOperationError } from "./workflowOutcome";

const listInboxEntries = vi.fn();
const agentVaultSession = vi.fn();
const inboxSourceSnapshot = vi.fn();
const archiveInboxSourceChecked = vi.fn();
const releaseInboxSource = vi.fn();
const scanTextSecrets = vi.fn();
const getSettings = vi.fn();
const judgeSource = vi.fn();
const readFile = vi.fn();
const describeImage = vi.fn();
const transcribeMedia = vi.fn();
const readExternalText = vi.fn();
const derivedRawCopy = vi.fn();
vi.mock("./ipc", () => ({
  ipc: {
    listInboxEntries: (...args: unknown[]) => listInboxEntries(...args),
    agentVaultSession: (...args: unknown[]) => agentVaultSession(...args),
    inboxSourceSnapshot: (...args: unknown[]) => inboxSourceSnapshot(...args),
    archiveInboxSourceChecked: (...args: unknown[]) =>
      archiveInboxSourceChecked(...args),
    releaseInboxSource: (...args: unknown[]) => releaseInboxSource(...args),
    scanTextSecrets: (...args: unknown[]) => scanTextSecrets(...args),
    getSettings: (...args: unknown[]) => getSettings(...args),
    judgeSource: (...args: unknown[]) => judgeSource(...args),
    readFile: (...args: unknown[]) => readFile(...args),
    describeImage: (...args: unknown[]) => describeImage(...args),
    transcribeMedia: (...args: unknown[]) => transcribeMedia(...args),
    readExternalText: (...args: unknown[]) => readExternalText(...args),
    derivedRawCopy: (...args: unknown[]) => derivedRawCopy(...args),
  },
}));
const startIngest = vi.fn();
const startInboxCompilation = vi.fn();
const bumpInboxRev = vi.fn();
const ingestState = {
  stage: "idle",
  startIngest,
  startInboxCompilation,
  bumpInboxRev,
};
vi.mock("../stores/ingestStore", () => ({
  useIngestStore: { getState: () => ingestState },
}));
let ui = {
  currentVault: { path: "/v" },
  vaultToken: "synthetic-ui-opening",
  isOpeningVault: false,
};
vi.mock("../stores/vaultStore", () => ({
  useVaultStore: { getState: () => ui },
}));
import { pendingInboxRows, runInboxPass } from "./autoIngest";
import { tryLock, unlock } from "./vaultLock";

const NOW = new Date(2026, 7, 19, 14, 0); // local 2026-08-19 14:00
const secs = (d: Date): number => Math.floor(d.getTime() / 1000);

function entry(name: string, mtime: number): InboxEntry {
  const dot = name.lastIndexOf(".");
  return {
    name,
    rel: `_inbox/${name}`,
    ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : "",
    bytes: 1,
    mtime,
  };
}

describe("pendingInboxRows", () => {
  it("sorts newest first, flags today, and derives path/kind per entry", () => {
    const today = secs(new Date(2026, 7, 19, 9, 30));
    const yesterday = secs(new Date(2026, 7, 18, 23, 50));
    const rows = pendingInboxRows(
      [entry("old.md", yesterday), entry("paper.pdf", today)],
      "/v",
      NOW,
    );
    expect(rows.map((r) => r.name)).toEqual(["paper.pdf", "old.md"]);
    expect(rows.map((r) => r.today)).toEqual([true, false]);
    expect(rows[0]).toMatchObject({
      path: "/v/_inbox/paper.pdf",
      ext: "pdf",
      kind: "extract",
    });
    expect(rows[1].kind).toBe("md");
  });

  it("puts files with no known mtime last, with mtime null and today false", () => {
    const rows = pendingInboxRows(
      [entry("unknown.epub", 0), entry("known.md", secs(NOW))],
      "/v",
      NOW,
    );
    expect(rows[0].name).toBe("known.md");
    expect(rows[1]).toMatchObject({
      name: "unknown.epub",
      mtime: null,
      today: false,
      kind: "unsupported",
    });
  });

  it("returns [] for an empty inbox", () => {
    expect(pendingInboxRows([], "/v", NOW)).toEqual([]);
  });
});

const origin = { vaultPath: "/v", openingToken: "synthetic-native-opening" };
const revision = "a".repeat(64);
const snapshot: InboxSourceSnapshot = {
  snapshotId: "synthetic-snapshot",
  origin,
  inboxRel: "_inbox/a.md",
  sourceRevision: revision,
  text: "Immutable synthetic original.\n",
};
const context: SessionCompileContext = {
  jobId: "synthetic-job",
  attemptId: "synthetic-attempt",
  origin,
  source: {
    key: "synthetic-inbox",
    rawPath: "raw/synthetic.md",
    sourceRevision: revision,
  },
  roleSnapshot: roleFixture(
    "compilation",
    "builtin-local",
    "synthetic-model",
    origin,
    "automatic",
  ),
  compileSignature: "synthetic-signature",
  summaryPath: "wiki/source-synthetic.md",
  indexPath: "wiki/index.md",
  logPath: "wiki/log.md",
  reportPath: "ingest-reports/synthetic.md",
};
const completed: SessionCompileStepResult = {
  attemptId: context.attemptId,
  sourceRevision: revision,
  state: "completed",
  step: null,
  eligibleWindows: 2,
  nextPacket: 2,
  publication: { ok: true, state: "completed", attemptId: context.attemptId },
};
const selected = {
  sourcePath: "/v/_inbox/a.md",
  sourceRevision: revision,
  origin,
  expectedVaultToken: "synthetic-ui-opening",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

describe("native-bound inbox pass (mocked transport)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ui = {
      currentVault: { path: "/v" },
      vaultToken: "synthetic-ui-opening",
      isOpeningVault: false,
    };
    ingestState.stage = "idle";
    listInboxEntries.mockReset().mockResolvedValue([entry("a.md", 100)]);
    agentVaultSession.mockReset().mockResolvedValue(origin);
    inboxSourceSnapshot
      .mockReset()
      .mockImplementation(async (_origin, rel) => ({
        ...snapshot,
        inboxRel: rel,
      }));
    archiveInboxSourceChecked.mockReset().mockResolvedValue({
      archivedPath: "/v/_inbox/.archived/a.md",
      sourceRevision: revision,
      harvestCompleted: true,
    });
    releaseInboxSource.mockReset().mockResolvedValue(undefined);
    getSettings.mockReset().mockResolvedValue({
      pii_quarantine_enabled: false,
      query_provider: "paid-provider",
      query_model: "paid-model",
    });
    scanTextSecrets.mockReset().mockResolvedValue({ secrets: [], pii: [] });
    judgeSource.mockReset().mockResolvedValue({
      verdict: "harvest",
      reason: "synthetic admission",
      rule: "synthetic",
    });
    startInboxCompilation
      .mockReset()
      .mockResolvedValue({ context, result: completed });
  });

  it("uses the copy's first revision, original opening and actual native completion", async () => {
    const out = await runInboxPass("/v", selected);
    expect(agentVaultSession).not.toHaveBeenCalled();
    expect(inboxSourceSnapshot).toHaveBeenCalledWith(
      origin,
      "_inbox/a.md",
      revision,
    );
    expect(startInboxCompilation).toHaveBeenCalledWith(snapshot, {
      usage: "automatic",
      expectedVaultToken: selected.expectedVaultToken,
    });
    expect(archiveInboxSourceChecked).toHaveBeenCalledWith(snapshot, context);
    expect(out).toMatchObject({
      ingested: true,
      harvestCompleted: true,
      sourcePath: selected.sourcePath,
      sourceRevision: revision,
      origin,
    });
    expect(releaseInboxSource).toHaveBeenCalledWith(snapshot);
    expect(startIngest).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(bumpInboxRev).toHaveBeenCalledTimes(1);
  });

  it("captures a native opening only once for a scheduled pass", async () => {
    await runInboxPass("/v");
    expect(agentVaultSession).toHaveBeenCalledTimes(1);
    expect(inboxSourceSnapshot).toHaveBeenCalledWith(
      origin,
      "_inbox/a.md",
      undefined,
    );
    expect(startInboxCompilation).toHaveBeenCalledWith(
      snapshot,
      expect.objectContaining({ usage: "automatic" }),
    );
  });

  it("retains foreground usage for a user-started harvest without changing the automatic default", async () => {
    await runInboxPass("/v", { ...selected, usage: "foreground" });
    expect(startInboxCompilation).toHaveBeenLastCalledWith(snapshot, {
      usage: "foreground",
      expectedVaultToken: selected.expectedVaultToken,
    });
    await runInboxPass("/v", selected);
    expect(startInboxCompilation).toHaveBeenLastCalledWith(snapshot, {
      usage: "automatic",
      expectedVaultToken: selected.expectedVaultToken,
    });
  });

  it.each(["snapshot", "scan", "compile", "archive"])(
    "does not publish old-opening success after reopening during %s",
    async (boundary) => {
      const gate = deferred<unknown>();
      const entered = deferred<void>();
      const pause = () => {
        entered.resolve();
        return gate.promise;
      };
      if (boundary === "snapshot")
        inboxSourceSnapshot.mockImplementationOnce(pause);
      if (boundary === "scan") scanTextSecrets.mockImplementationOnce(pause);
      if (boundary === "compile")
        startInboxCompilation.mockImplementationOnce(pause);
      if (boundary === "archive")
        archiveInboxSourceChecked.mockImplementationOnce(pause);
      const pass = runInboxPass("/v", selected);
      await entered.promise;
      ui = { ...ui, vaultToken: "synthetic-reopened" };
      gate.resolve(
        boundary === "snapshot"
          ? snapshot
          : boundary === "scan"
            ? { secrets: [], pii: [] }
            : boundary === "compile"
              ? { context, result: completed }
              : {
                  archivedPath: "/v/_inbox/.archived/a.md",
                  sourceRevision: revision,
                  harvestCompleted: true,
                },
      );
      expect(await pass).toMatchObject({
        ingested: false,
        error: expect.stringContaining("opening"),
      });
      expect(bumpInboxRev).not.toHaveBeenCalled();
      if (boundary !== "archive")
        expect(archiveInboxSourceChecked).not.toHaveBeenCalled();
      if (boundary === "snapshot" || boundary === "scan")
        expect(startInboxCompilation).not.toHaveBeenCalled();
      expect(releaseInboxSource).toHaveBeenCalledWith(snapshot);
    },
  );

  it("refuses an opening returned after the same path was reopened", async () => {
    const gate = deferred<typeof origin>();
    agentVaultSession.mockReturnValueOnce(gate.promise);
    const pass = runInboxPass("/v");
    ui = { ...ui, vaultToken: "synthetic-reopened" };
    gate.resolve(origin);
    expect(await pass).toMatchObject({
      ingested: false,
      error: expect.any(String),
    });
    expect(listInboxEntries).not.toHaveBeenCalled();
  });

  it("does not return old-opening success after snapshot cleanup waits through reopening", async () => {
    const entered = deferred<void>();
    const cleanup = deferred<void>();
    releaseInboxSource.mockImplementationOnce(() => {
      entered.resolve();
      return cleanup.promise;
    });
    const pass = runInboxPass("/v", selected);
    await entered.promise;
    // The old opening's archive was already received before the transition.
    expect(bumpInboxRev).toHaveBeenCalledTimes(1);
    ui = { ...ui, vaultToken: "synthetic-reopened" };
    cleanup.resolve();
    expect(await pass).toMatchObject({
      ingested: false,
      error: expect.stringContaining("opening"),
    });
    expect(bumpInboxRev).toHaveBeenCalledTimes(1);
  });

  it("rejects a changed first read before compilation or archiving", async () => {
    inboxSourceSnapshot.mockResolvedValueOnce({
      ...snapshot,
      sourceRevision: "b".repeat(64),
      text: "Changed synthetic body",
    });
    expect(await runInboxPass("/v", selected)).toMatchObject({
      ingested: false,
      error: expect.stringContaining("snapshot"),
    });
    expect(startInboxCompilation).not.toHaveBeenCalled();
    expect(archiveInboxSourceChecked).not.toHaveBeenCalled();
    expect(releaseInboxSource).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1])(
    "retains partial native compilation even with %i pending windows",
    async (pending) => {
      startInboxCompilation.mockResolvedValueOnce({
        context,
        result: {
          ...completed,
          state: "partial",
          nextPacket: completed.eligibleWindows - pending,
          publication: null,
        },
      });
      expect(await runInboxPass("/v", selected)).toMatchObject({
        ingested: false,
        harvestCompleted: false,
        pendingChunks: pending,
      });
      expect(archiveInboxSourceChecked).not.toHaveBeenCalled();
      expect(bumpInboxRev).not.toHaveBeenCalled();
      expect(releaseInboxSource).toHaveBeenCalledWith(snapshot);
    },
  );

  it("retains actual false completion instead of replacing it with stage done", async () => {
    ingestState.stage = "done";
    archiveInboxSourceChecked.mockResolvedValueOnce({
      archivedPath: "/v/_inbox/.archived/a.md",
      sourceRevision: revision,
      harvestCompleted: false,
    });
    expect(await runInboxPass("/v", selected)).toMatchObject({
      ingested: true,
      harvestCompleted: false,
    });
  });

  it("keeps unavailable source admission pending without an archive or generic fallback", async () => {
    startInboxCompilation.mockRejectedValueOnce(
      new WorkflowOperationError(
        "pending",
        "unavailable",
        "Synthetic original lacks admitted lineage; source remains pending",
      ),
    );
    expect(await runInboxPass("/v", selected)).toMatchObject({
      ingested: false,
      harvestCompleted: false,
      held: 1,
      sourceRevision: revision,
      origin,
      pendingReason: expect.stringContaining("pending"),
    });
    expect(archiveInboxSourceChecked).not.toHaveBeenCalled();
    expect(startIngest).not.toHaveBeenCalled();
    expect(bumpInboxRev).not.toHaveBeenCalled();
    expect(releaseInboxSource).toHaveBeenCalledWith(snapshot);
  });

  it("requires the archive's exact source revision", async () => {
    archiveInboxSourceChecked.mockResolvedValueOnce({
      archivedPath: "/v/_inbox/.archived/a.md",
      sourceRevision: "b".repeat(64),
      harvestCompleted: true,
    });
    expect(await runInboxPass("/v", selected)).toMatchObject({
      ingested: false,
      error: expect.any(String),
    });
    expect(bumpInboxRev).not.toHaveBeenCalled();
  });

  it("holds a flagged title and body before native compilation", async () => {
    scanTextSecrets.mockResolvedValueOnce({
      secrets: ["synthetic-secret"],
      pii: [],
    });
    expect(await runInboxPass("/v", selected)).toMatchObject({
      ingested: false,
      held: 1,
      sourcePath: selected.sourcePath,
    });
    expect(scanTextSecrets.mock.calls[0][0]).toBe(`a\n\n${snapshot.text}`);
    expect(startInboxCompilation).not.toHaveBeenCalled();
    expect(archiveInboxSourceChecked).not.toHaveBeenCalled();
  });

  it("archives an admitted refusal without claiming harvest completion", async () => {
    judgeSource.mockResolvedValueOnce({
      verdict: "drop",
      reason: "synthetic refusal",
      rule: "synthetic",
    });
    archiveInboxSourceChecked.mockResolvedValueOnce({
      archivedPath: "/v/_inbox/.archived/a.md",
      sourceRevision: revision,
      harvestCompleted: false,
    });
    expect(await runInboxPass("/v", selected)).toMatchObject({
      ingested: false,
      refused: 1,
    });
    expect(archiveInboxSourceChecked).toHaveBeenCalledWith(snapshot);
    expect(startInboxCompilation).not.toHaveBeenCalled();
  });

  it.each(["shot.png", "recording.mp3", "paper.pdf", "book.epub"])(
    "keeps %s pending without an unbound extraction or paid model call",
    async (name) => {
      listInboxEntries.mockResolvedValueOnce([entry(name, 100)]);
      const out = await runInboxPass("/v", {
        ...selected,
        sourcePath: `/v/_inbox/${name}`,
      });
      expect(out.ingested).toBe(false);
      expect(out.held + out.unsupported).toBe(1);
      expect(inboxSourceSnapshot).not.toHaveBeenCalled();
      expect(describeImage).not.toHaveBeenCalled();
      expect(transcribeMedia).not.toHaveBeenCalled();
      expect(readExternalText).not.toHaveBeenCalled();
      expect(derivedRawCopy).not.toHaveBeenCalled();
      expect(startIngest).not.toHaveBeenCalled();
      expect(archiveInboxSourceChecked).not.toHaveBeenCalled();
    },
  );

  it("selects only the requested copy and preserves an unrelated pending source", async () => {
    listInboxEntries.mockResolvedValueOnce([
      entry("other.md", 200),
      entry("a.md", 100),
    ]);
    await runInboxPass("/v", selected);
    expect(inboxSourceSnapshot).toHaveBeenCalledTimes(1);
    expect(inboxSourceSnapshot).toHaveBeenCalledWith(
      origin,
      "_inbox/a.md",
      revision,
    );
  });

  it("retains a missing target, read failure, archive failure and release failure as errors", async () => {
    listInboxEntries.mockResolvedValueOnce([entry("other.md", 200)]);
    expect(await runInboxPass("/v", selected)).toMatchObject({
      ingested: false,
      error: expect.any(String),
    });
    inboxSourceSnapshot.mockRejectedValueOnce(
      new Error("Source revision changed"),
    );
    expect(await runInboxPass("/v", selected)).toMatchObject({
      ingested: false,
      error: "Source revision changed",
    });
    archiveInboxSourceChecked.mockRejectedValueOnce(
      new Error("Archive unavailable"),
    );
    expect(await runInboxPass("/v", selected)).toMatchObject({
      ingested: false,
      error: "Archive unavailable",
    });
    releaseInboxSource.mockRejectedValueOnce(new Error("Release unavailable"));
    expect(await runInboxPass("/v", selected)).toMatchObject({
      ingested: false,
      error: expect.stringContaining("Release unavailable"),
    });
  });

  it.each([new Error("Compilation unavailable"), 0, false])(
    "retains both the original processing rejection %s and native release failure",
    async (failure) => {
      startInboxCompilation.mockRejectedValueOnce(failure);
      releaseInboxSource.mockRejectedValueOnce(
        new Error("Release unavailable"),
      );
      expect(await runInboxPass("/v", selected)).toMatchObject({
        ingested: false,
        error: `${String(failure)}; Inbox snapshot release failed: Error: Release unavailable`,
      });
      expect(releaseInboxSource).toHaveBeenCalledTimes(1);
      expect(archiveInboxSourceChecked).not.toHaveBeenCalled();
      expect(bumpInboxRev).not.toHaveBeenCalled();
    },
  );

  it("waits for native release before returning the original failure and unlocking", async () => {
    const entered = deferred<void>();
    const cleanup = deferred<void>();
    startInboxCompilation.mockRejectedValueOnce(
      new Error("Compilation unavailable"),
    );
    releaseInboxSource.mockImplementationOnce(() => {
      entered.resolve();
      return cleanup.promise;
    });
    let settled = false;
    const pass = runInboxPass("/v", selected).then((outcome) => {
      settled = true;
      return outcome;
    });
    await entered.promise;
    expect(settled).toBe(false);
    expect(tryLock("/v")).toBe(false);
    expect(archiveInboxSourceChecked).not.toHaveBeenCalled();
    cleanup.resolve();
    expect(await pass).toMatchObject({
      ingested: false,
      error: "Compilation unavailable",
    });
    expect(releaseInboxSource).toHaveBeenCalledTimes(1);
    expect(tryLock("/v")).toBe(true);
    unlock("/v");
  });

  it.each([new Error("Compilation unavailable"), 0, false])(
    "retains processing rejection %s and detects same-path reopening during native release",
    async (failure) => {
      const entered = deferred<void>();
      const cleanup = deferred<void>();
      startInboxCompilation.mockRejectedValueOnce(failure);
      releaseInboxSource.mockImplementationOnce(() => {
        entered.resolve();
        return cleanup.promise;
      });
      const pass = runInboxPass("/v", selected);
      await entered.promise;
      ui = { ...ui, vaultToken: "synthetic-reopened" };
      cleanup.resolve();
      expect(await pass).toMatchObject({
        ingested: false,
        error: `${String(failure)}; The originating vault opening is no longer active`,
      });
      expect(releaseInboxSource).toHaveBeenCalledTimes(1);
      expect(archiveInboxSourceChecked).not.toHaveBeenCalled();
      expect(bumpInboxRev).not.toHaveBeenCalled();
    },
  );

  it("retains processing, release and reopened-origin failures in the same outcome", async () => {
    const entered = deferred<void>();
    const cleanup = deferred<void>();
    startInboxCompilation.mockRejectedValueOnce(
      new Error("Compilation unavailable"),
    );
    releaseInboxSource.mockImplementationOnce(async () => {
      entered.resolve();
      await cleanup.promise;
      throw new Error("Release unavailable");
    });
    const pass = runInboxPass("/v", selected);
    await entered.promise;
    ui = { ...ui, vaultToken: "synthetic-reopened" };
    cleanup.resolve();
    expect(await pass).toMatchObject({
      ingested: false,
      error:
        "Error: Compilation unavailable; Inbox snapshot release failed: Error: Release unavailable; The originating vault opening is no longer active",
    });
    expect(releaseInboxSource).toHaveBeenCalledTimes(1);
    expect(archiveInboxSourceChecked).not.toHaveBeenCalled();
    expect(bumpInboxRev).not.toHaveBeenCalled();
  });

  it.each(["hold", "refusal", "pending", "partial", "completed"])(
    "refuses a successful pass outcome when native release fails after %s",
    async (branch) => {
      if (branch === "hold") {
        scanTextSecrets.mockResolvedValueOnce({
          secrets: ["synthetic-secret"],
          pii: [],
        });
      } else if (branch === "refusal") {
        judgeSource.mockResolvedValueOnce({
          verdict: "drop",
          reason: "Synthetic refusal",
          rule: "synthetic",
        });
        archiveInboxSourceChecked.mockResolvedValueOnce({
          archivedPath: "/v/_inbox/.archived/a.md",
          sourceRevision: revision,
          harvestCompleted: false,
        });
      } else if (branch === "pending") {
        startInboxCompilation.mockRejectedValueOnce(
          new WorkflowOperationError(
            "pending",
            "unavailable",
            "Synthetic admission unavailable",
          ),
        );
      } else if (branch === "partial") {
        startInboxCompilation.mockResolvedValueOnce({
          context,
          result: {
            ...completed,
            state: "partial",
            nextPacket: 1,
            publication: null,
          },
        });
      }
      releaseInboxSource.mockRejectedValueOnce(
        new Error("Release unavailable"),
      );
      const outcome = await runInboxPass("/v", selected);
      expect(outcome).toMatchObject({
        ingested: false,
        error: expect.stringContaining("Release unavailable"),
      });
      expect(outcome.harvestCompleted).not.toBe(true);
      if (branch === "pending")
        expect(outcome.error).toContain("Synthetic admission unavailable");
      expect(releaseInboxSource).toHaveBeenCalledTimes(1);
      expect(archiveInboxSourceChecked).toHaveBeenCalledTimes(
        branch === "refusal" || branch === "completed" ? 1 : 0,
      );
    },
  );

  it("holds the shared vault lock through compilation and cleanup", async () => {
    const gate = deferred<InboxEntry[]>();
    listInboxEntries.mockReturnValueOnce(gate.promise);
    const pass = runInboxPass("/v", selected);
    expect(tryLock("/v")).toBe(false);
    gate.resolve([]);
    await pass;
    expect(tryLock("/v")).toBe(true);
    unlock("/v");
  });

  it("does not start while a plan gate or another vault operation holds the lock", async () => {
    ingestState.stage = "plan-gate";
    expect(await runInboxPass("/v", selected)).toMatchObject({
      ingested: false,
      busy: true,
    });
    ingestState.stage = "idle";
    expect(tryLock("/v")).toBe(true);
    expect(await runInboxPass("/v", selected)).toMatchObject({
      ingested: false,
      busy: true,
    });
    unlock("/v");
    expect(listInboxEntries).not.toHaveBeenCalled();
  });

  it("does not relax quarantine on a settings failure", async () => {
    getSettings.mockRejectedValueOnce(new Error("Settings unavailable"));
    expect(await runInboxPass("/v", selected)).toMatchObject({
      ingested: false,
      error: "Settings unavailable",
    });
    expect(inboxSourceSnapshot).not.toHaveBeenCalled();
  });
});
