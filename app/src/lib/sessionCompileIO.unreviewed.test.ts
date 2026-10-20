// Registered RED for confirmed unreviewed native failures.
// Mocked IPC proves frontend classification only, not native persistence or model quality.
import { describe, expect, it, vi } from "vitest";
import {
  runNativeSessionCompile,
  type NativeSessionCompilerTransport,
} from "./sessionCompileIO";
import type { SessionCompileContext, SessionCompileStepResult } from "./ipc";
import { roleFixture } from "./modelRoles.testSupport";
import {
  WorkflowOperationError,
  workflowIssue,
  workflowStatus,
} from "./workflowOutcome";

const origin = {
  vaultPath: "/synthetic-unreviewed-vault",
  openingToken: "synthetic-opening:1",
};
const context: SessionCompileContext = {
  jobId: "synthetic-unreviewed-job",
  attemptId: "synthetic-unreviewed-attempt",
  compileSignature: "synthetic-v5-compiler",
  origin,
  source: {
    key: "codex:synthetic-unreviewed",
    rawPath: "raw/conversations/codex/synthetic-unreviewed.md",
    sourceRevision: "a".repeat(64),
  },
  roleSnapshot: roleFixture(
    "compilation",
    "builtin-local",
    "qwen3.5-2b-q4_k_m",
    origin,
  ),
  summaryPath: "wiki/source-synthetic-unreviewed.md",
  indexPath: "wiki/index.md",
  logPath: "wiki/log.md",
  reportPath: "ingest-reports/synthetic-unreviewed.md",
};
const failureMessage =
  "Synthetic semantic review was unavailable; native partial was saved";

function compilerTransport() {
  return {
    sessionCompileStep: vi
      .fn<NativeSessionCompilerTransport["sessionCompileStep"]>()
      .mockRejectedValue(
        new Error("Unexpected extra synthetic packet request"),
      ),
    sessionCompileStop: vi
      .fn<NativeSessionCompilerTransport["sessionCompileStop"]>()
      .mockResolvedValue(undefined),
    cancelLocalSynthesis: vi
      .fn<NativeSessionCompilerTransport["cancelLocalSynthesis"]>()
      .mockResolvedValue(false),
  };
}

// Deliberately raw wire JSON: malformed bindings are independent of DTO typing.
// Runtime admission must confirm the exact owner and saved state/reason.
function confirmedUnreviewed(issued: SessionCompileContext, requestId: string) {
  return {
    version: "SessionCompileFailureV1",
    message: failureMessage,
    outcome: {
      attemptId: issued.attemptId,
      sourceRevision: issued.source.sourceRevision,
      compileSignature: issued.compileSignature,
      origin: { ...issued.origin },
      roleSnapshotId: issued.roleSnapshot.snapshotId,
      requestId: requestId as string | null,
      state: "partial",
      reason: "semantic_review_unavailable",
    },
    finalizationError: null as string | null,
  };
}

function expectNoMutation(
  wire: ReturnType<typeof compilerTransport>,
  calls = 1,
) {
  expect(wire.sessionCompileStep).toHaveBeenCalledTimes(calls);
  expect(wire.sessionCompileStop).not.toHaveBeenCalled();
  expect(wire.cancelLocalSynthesis).not.toHaveBeenCalled();
}

describe("confirmed unreviewed partial (mocked IPC, no native/model proof)", () => {
  it("passes an exact saved Partial/reason to the workflow as pending/incomplete", async () => {
    const wire = compilerTransport();
    wire.sessionCompileStep.mockImplementation(async (issued, requestId) => {
      throw confirmedUnreviewed(issued, requestId);
    });
    const progress = vi.fn();
    const error: unknown = await runNativeSessionCompile(
      context,
      {
        lang: "ko",
        onProgress: progress,
      },
      wire,
    ).catch((rejection: unknown) => rejection);
    expect(error).toBeInstanceOf(WorkflowOperationError);
    expect(error).toMatchObject({
      status: "pending",
      code: "incomplete",
      message: failureMessage,
    });
    const issue = workflowIssue(
      "session-compile",
      error,
      context.source.rawPath,
    );
    expect(issue).toMatchObject({
      status: "pending",
      code: "incomplete",
      retryable: true,
    });
    expect(issue.error).toContain(failureMessage);
    expect(workflowStatus([issue], 0, 1)).toBe("pending");
    expect(progress).not.toHaveBeenCalled();
    expectNoMutation(wire);
  });

  it("preserves earlier packet progress without inventing completion, retry, or Stop", async () => {
    const wire = compilerTransport();
    const first: SessionCompileStepResult = {
      attemptId: context.attemptId,
      sourceRevision: context.source.sourceRevision,
      state: "running",
      nextPacket: 1,
      eligibleWindows: 2,
      publication: null,
      step: {
        packetIndex: 0,
        processedWindows: 1,
        eligibleWindows: 2,
        omittedWindows: 1,
        reviewAccepted: true,
        nativeReviewRevision: "b".repeat(64),
        sourceSchemaChecked: true,
        allPacketsSeen: false,
      },
    };
    wire.sessionCompileStep
      .mockResolvedValueOnce(first)
      .mockImplementationOnce(async (issued, requestId) => {
        throw confirmedUnreviewed(issued, requestId);
      });
    const progress = vi.fn();
    await expect(
      runNativeSessionCompile(
        context,
        { lang: "en", onProgress: progress },
        wire,
      ),
    ).rejects.toMatchObject({
      status: "pending",
      code: "incomplete",
      message: failureMessage,
    });
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith(first);
    expect(wire.sessionCompileStep.mock.calls[0][1]).not.toBe(
      wire.sessionCompileStep.mock.calls[1][1],
    );
    expectNoMutation(wire, 2);
  });

  it.each([
    "attempt",
    "source",
    "signature",
    "vault",
    "opening",
    "role",
    "request",
    "null-request",
  ])(
    "does not admit foreign or unowned %s Partial as pending",
    async (field) => {
      const wire = compilerTransport();
      wire.sessionCompileStep.mockImplementation(async (issued, requestId) => {
        const failure = confirmedUnreviewed(issued, requestId);
        if (field === "attempt") failure.outcome.attemptId = "foreign-attempt";
        if (field === "source") failure.outcome.sourceRevision = "d".repeat(64);
        if (field === "signature")
          failure.outcome.compileSignature = "foreign-compiler";
        if (field === "vault")
          failure.outcome.origin.vaultPath = "/foreign-vault";
        if (field === "opening")
          failure.outcome.origin.openingToken = "synthetic-opening:2";
        if (field === "role") failure.outcome.roleSnapshotId = "foreign-role";
        if (field === "request") failure.outcome.requestId = "foreign-request";
        if (field === "null-request") failure.outcome.requestId = null;
        throw failure;
      });
      await expect(
        runNativeSessionCompile(context, { lang: "ko" }, wire),
      ).rejects.toMatchObject({
        status: "failed",
        code: "operation_failed",
        message: failureMessage,
      });
      expectNoMutation(wire);
    },
  );

  it("retains finalization failure even when all owner fields claim a saved Partial", async () => {
    const wire = compilerTransport();
    wire.sessionCompileStep.mockImplementation(async (issued, requestId) => {
      const failure = confirmedUnreviewed(issued, requestId);
      failure.finalizationError = "Synthetic checkpoint CAS changed";
      throw failure;
    });
    const error: unknown = await runNativeSessionCompile(
      context,
      { lang: "ko" },
      wire,
    ).catch((rejection: unknown) => rejection);
    expect(error).toMatchObject({ status: "failed", code: "operation_failed" });
    expect(error).toHaveProperty(
      "message",
      expect.stringContaining(failureMessage),
    );
    expect(error).toHaveProperty(
      "message",
      expect.stringContaining("Synthetic checkpoint CAS changed"),
    );
    expectNoMutation(wire);
  });

  it.each([
    ["partial", "processing_failed"],
    ["partial", "model_preparation_unavailable"],
    ["partial", "foreign-reason"],
    ["pending", "semantic_review_unavailable"],
    ["failed", "semantic_review_unavailable"],
    ["stopped", "semantic_review_unavailable"],
    ["completed", "semantic_review_unavailable"],
  ])("refuses the wrong state/reason pair %s/%s", async (state, reason) => {
    const wire = compilerTransport();
    wire.sessionCompileStep.mockImplementation(async (issued, requestId) => {
      const failure = confirmedUnreviewed(issued, requestId);
      failure.outcome.state = state;
      failure.outcome.reason = reason;
      throw failure;
    });
    await expect(
      runNativeSessionCompile(context, { lang: "ko" }, wire),
    ).rejects.toMatchObject({
      status: "failed",
      code: "operation_failed",
      message: failureMessage,
    });
    expectNoMutation(wire);
  });

  it.each([
    "version",
    "missing-outcome",
    "invalid-finalization",
    "message-only",
  ])(
    "does not infer a saved Partial from malformed %s evidence",
    async (field) => {
      const wire = compilerTransport();
      wire.sessionCompileStep.mockImplementation(async (issued, requestId) => {
        const failure = confirmedUnreviewed(issued, requestId);
        if (field === "version")
          throw { ...failure, version: "SessionCompileFailureV2" };
        if (field === "missing-outcome") throw { ...failure, outcome: null };
        if (field === "invalid-finalization")
          throw { ...failure, finalizationError: false };
        throw new Error(failureMessage);
      });
      await expect(
        runNativeSessionCompile(context, { lang: "ko" }, wire),
      ).rejects.toMatchObject({
        status: "failed",
        code: "operation_failed",
        message: failureMessage,
      });
      expectNoMutation(wire);
    },
  );
});
