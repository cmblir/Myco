import { describe, expect, it, vi } from "vitest";
import { runNativeSessionCompile, sessionCompileIO } from "./sessionCompileIO";
import type { SessionCompileContext, SessionCompileStepResult } from "./ipc";

const context: SessionCompileContext = {
  jobId: "synthetic-job", attemptId: "synthetic-attempt", compileSignature: "synthetic-compiler",
  origin: { vaultPath: "/synthetic-vault", openingToken: "synthetic-process:1" },
  source: { key: "codex:synthetic", rawPath: "raw/conversations/codex/synthetic.md", sourceRevision: "a".repeat(64) },
  roleSnapshot: { snapshotId: "synthetic-role", origin: { vaultPath: "/synthetic-vault", openingToken: "synthetic-process:1" },
    role: "compilation", usage: "foreground", authorizationRevision: "synthetic-authorization",
    routeSignature: { role: "compilation", providerId: "builtin-local", modelId: "qwen3.5-2b-q4_k_m", effort: "(default)",
      executionLocation: "in-process", artifactRevision: null, artifactSha256: null, runtimeContract: "synthetic", signature: "synthetic-route" } },
  summaryPath: "wiki/source-synthetic.md", indexPath: "wiki/index.md", logPath: "wiki/log.md", reportPath: "ingest-reports/synthetic.md",
};
function transport() {
  return { sessionCompileRead: vi.fn().mockResolvedValue({ raw: "Synthetic existing report", revision: "b".repeat(64) }),
    sessionCompilePublish: vi.fn().mockResolvedValue({publicationId:"synthetic-publication",attemptId:context.attemptId,
      path:context.summaryPath,revision:"c".repeat(64),nativeCreated:false}) };
}

describe("sessionCompileIO (mocked transport, no native/model proof)", () => {
  it("passes the full native attempt and loaded CAS baseline without a generic writer", async () => {
    const wire=transport();const io=sessionCompileIO(context,wire);
    await io.readFile(`/synthetic-vault/${context.source.rawPath}`);
    await io.writeFileIfUnchanged(`/synthetic-vault/${context.summaryPath}`,"Synthetic append","b".repeat(64));
    expect(wire.sessionCompileRead).toHaveBeenCalledWith(context,context.source.rawPath);
    expect(wire.sessionCompilePublish).toHaveBeenCalledWith(context,context.summaryPath,"Synthetic append","b".repeat(64));
  });
  it("reports use exact loaded revisions; only ENOENT permits absence publication", async () => {
    const wire=transport();const io=sessionCompileIO(context,wire);
    await io.writeFile(`/synthetic-vault/${context.reportPath}`,"Synthetic report");
    expect(wire.sessionCompilePublish).toHaveBeenLastCalledWith(context,context.reportPath,"Synthetic report","b".repeat(64));
    wire.sessionCompileRead.mockRejectedValueOnce(new Error("No such file or directory (os error 2)"));
    await io.writeFile(`/synthetic-vault/${context.reportPath}`,"Synthetic new report");
    expect(wire.sessionCompilePublish).toHaveBeenLastCalledWith(context,context.reportPath,"Synthetic new report",null);
    wire.sessionCompileRead.mockRejectedValueOnce(new Error("Permission denied (os error 13)"));
    await expect(io.writeFile(`/synthetic-vault/${context.reportPath}`,"Forbidden replacement")).rejects.toThrow("Permission denied");
    expect(wire.sessionCompilePublish).toHaveBeenCalledTimes(2);
  });
  it("a different vault and generic directory requests are rejected before transport", async () => {
    const wire=transport();const io=sessionCompileIO(context,wire);
    expect(()=>io.readFile("/synthetic-other/wiki/human.md")).toThrow("different vault");
    await expect(io.createFolder("/synthetic-other","wiki")).rejects.toThrow();
    await expect(io.createFolder("/synthetic-vault","raw")).rejects.toThrow();
    expect(wire.sessionCompileRead).not.toHaveBeenCalled();expect(wire.sessionCompilePublish).not.toHaveBeenCalled();
  });
});

function completed(): SessionCompileStepResult {
  return { attemptId: context.attemptId, sourceRevision: context.source.sourceRevision,
    state: "completed", step: null, nextPacket: 1, eligibleWindows: 1,
    publication: { ok: true, state: "completed", attemptId: context.attemptId } };
}
function compilerTransport() {
  return { sessionCompileStep: vi.fn().mockResolvedValue(completed()),
    sessionCompileStop: vi.fn().mockResolvedValue(undefined),
    cancelLocalSynthesis: vi.fn().mockResolvedValue(true) };
}

function nativeFailure(issued: SessionCompileContext, requestId: string) {
  return { version: "SessionCompileFailureV1", message: "Synthetic packet processing failed",
    outcome: { attemptId: issued.attemptId, sourceRevision: issued.source.sourceRevision,
      compileSignature: issued.compileSignature, origin: { ...issued.origin },
      roleSnapshotId: issued.roleSnapshot.snapshotId, requestId: requestId as string | null,
      state: "failed", reason: "processing_failed" },
    finalizationError: null as string | null };
}

describe("native session packet consumer (mocked IPC, no native/model proof)", () => {
  it("accepts completed publication retry without inventing a fresh step", async () => {
    const wire = compilerTransport();
    const progress = vi.fn();
    const result = await runNativeSessionCompile(context, { lang: "ko", onProgress: progress }, wire);
    expect(result).toEqual(completed());
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ step: null }));
    expect(wire.sessionCompileStep).toHaveBeenCalledWith(context, expect.stringMatching(/^session-compile-/), "ko");
    expect(wire.sessionCompileStop).not.toHaveBeenCalled();
  });

  it.each(["attempt", "source", "publication-attempt", "publication-ok", "publication-state"])(
    "rejects inconsistent %s completion", async field => {
      const wire = compilerTransport();
      const result = completed();
      if (field === "attempt") result.attemptId = "another-attempt";
      if (field === "source") result.sourceRevision = "d".repeat(64);
      if (field === "publication-attempt") result.publication!.attemptId = "another-attempt";
      if (field === "publication-ok") result.publication!.ok = false;
      if (field === "publication-state") result.publication!.state = "partial";
      wire.sessionCompileStep.mockResolvedValue(result);
      const progress = vi.fn();
      await expect(runNativeSessionCompile(context, { lang: "en", onProgress: progress }, wire)).rejects.toThrow("native compiler receipt");
      expect(progress).not.toHaveBeenCalled();
      expect(wire.sessionCompileStop).not.toHaveBeenCalled();
    },
  );

  it("rejects repeated fresh review progress even when a durable nextPacket stays fixed", async () => {
    const wire = compilerTransport();
    const running: SessionCompileStepResult = { ...completed(), state: "running", nextPacket: 2,
      eligibleWindows: 2, publication: null,
      step: { packetIndex: 0, processedWindows: 1, eligibleWindows: 2, omittedWindows: 1,
        reviewAccepted: true, nativeReviewRevision: "b".repeat(64), sourceSchemaChecked: true, allPacketsSeen: false } };
    wire.sessionCompileStep.mockResolvedValue(running);
    const progress = vi.fn();
    await expect(runNativeSessionCompile(context, { lang: "ja", onProgress: progress }, wire)).rejects.toThrow("repeated fresh packet progress");
    expect(wire.sessionCompileStep).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenCalledTimes(1);
    expect(wire.sessionCompileStop).not.toHaveBeenCalled();
  });

  it("waits for native Stop confirmation and does not accept late completion", async () => {
    const wire = compilerTransport();
    let finishStep!: (result: SessionCompileStepResult) => void;
    const late = new Promise<SessionCompileStepResult>(resolve => { finishStep = resolve; });
    let finishStop!: () => void;
    const stop = new Promise<void>(resolve => { finishStop = resolve; });
    wire.sessionCompileStep.mockReturnValue(late);
    wire.sessionCompileStop.mockReturnValue(stop);
    const controller = new AbortController();
    const progress = vi.fn();
    const running = runNativeSessionCompile(context, { lang: "ko", signal: controller.signal, onProgress: progress }, wire);
    const rejected = expect(running).rejects.toMatchObject({ status: "stopped", code: "cancelled" });
    let settled = false;
    running.then(() => { settled = true; }, () => { settled = true; });
    controller.abort();
    await vi.waitFor(() => expect(wire.sessionCompileStop).toHaveBeenCalledWith(context, "stopped"));
    expect(wire.cancelLocalSynthesis).toHaveBeenCalledWith(wire.sessionCompileStep.mock.calls[0][1]);
    expect(settled).toBe(false);
    finishStep(completed());
    finishStop();
    await rejected;
    expect(progress).not.toHaveBeenCalled();
  });

  it("keeps failed native Stop visible even if the local cancellation hint succeeds", async () => {
    const wire = compilerTransport();
    wire.sessionCompileStep.mockReturnValue(new Promise(() => undefined));
    wire.sessionCompileStop.mockRejectedValue(new Error("Synthetic native checkpoint unavailable"));
    const controller = new AbortController();
    const running = runNativeSessionCompile(context, { lang: "ko", signal: controller.signal }, wire);
    const rejected = expect(running).rejects.toThrow("Native compiler Stop could not be confirmed");
    controller.abort();
    await rejected;
  });

  it("native Stop is not blocked by an unresolved optional local cancellation hint", async () => {
    const wire = compilerTransport();
    wire.sessionCompileStep.mockReturnValue(new Promise(() => undefined));
    wire.cancelLocalSynthesis.mockReturnValue(new Promise(() => undefined));
    const controller = new AbortController();
    const running = runNativeSessionCompile(context, { lang: "ko", signal: controller.signal }, wire);
    const rejected = expect(running).rejects.toMatchObject({ status: "stopped", code: "cancelled" });
    controller.abort();
    await vi.waitFor(() => expect(wire.sessionCompileStop).toHaveBeenCalledWith(context, "stopped"));
    await rejected;
  });

  it("an already stopped run never starts an inference request", async () => {
    const wire = compilerTransport();
    const controller = new AbortController();
    controller.abort();
    await expect(runNativeSessionCompile(context, { lang: "ko", signal: controller.signal }, wire)).rejects.toMatchObject({ status: "stopped" });
    expect(wire.sessionCompileStep).not.toHaveBeenCalled();
    expect(wire.sessionCompileStop).toHaveBeenCalledWith(context, "stopped");
  });

  it("an explicitly selected unavailable external adapter does not dispatch locally", async () => {
    const wire = compilerTransport();
    const external = structuredClone(context);
    external.roleSnapshot.routeSignature.providerId = "anthropic-api";
    await expect(runNativeSessionCompile(external, { lang: "ko" }, wire)).rejects.toMatchObject({ status: "pending", code: "unavailable" });
    expect(wire.sessionCompileStep).not.toHaveBeenCalled();
    expect(wire.sessionCompileStop).toHaveBeenCalledWith(external, "preparation_required");
  });

  // Generic rejection is not native proof of request ownership or a saved
  // outcome. The previous preparation Stop expectations could end a healthy
  // concurrent execution and are replaced with no-mutation assertions.
  it.each(["Synthetic packet model unavailable", "Synthetic compiler request is busy", "Synthetic compiler authority refused"])(
    "does not Stop an attempt on generic rejection: %s", async message => {
    const wire = compilerTransport();
    wire.sessionCompileStep.mockRejectedValue(new Error(message));
    const progress = vi.fn();
    await expect(runNativeSessionCompile(context, { lang: "ko", onProgress: progress }, wire))
      .rejects.toThrow(message);
    expect(wire.sessionCompileStop).not.toHaveBeenCalled();
    expect(wire.cancelLocalSynthesis).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
  });

  it.each([
    ["string", "cancelled"],
    ["Error", new Error("cancelled")],
    ["AbortError", Object.assign(new Error("Synthetic transport abort"), { name: "AbortError" })],
  ])("does not confirm Stop from an unowned transport %s", async (_kind, failure) => {
    const wire = compilerTransport();
    wire.sessionCompileStep.mockRejectedValue(failure);
    const message = failure instanceof Error ? failure.message : failure;
    await expect(runNativeSessionCompile(context, { lang: "ko" }, wire)).rejects.toMatchObject({
      status: "failed", code: "operation_failed", message,
    });
    expect(wire.sessionCompileStop).not.toHaveBeenCalled();
    expect(wire.cancelLocalSynthesis).not.toHaveBeenCalled();
  });

  it("does not confirm Stop from a synchronous transport AbortError", async () => {
    const wire = compilerTransport();
    wire.sessionCompileStep.mockImplementation(() => {
      throw Object.assign(new Error("Synthetic synchronous transport abort"), { name: "AbortError" });
    });
    await expect(runNativeSessionCompile(context, { lang: "ko" }, wire)).rejects.toMatchObject({
      status: "failed", code: "operation_failed", message: "Synthetic synchronous transport abort",
    });
    expect(wire.sessionCompileStep).toHaveBeenCalledTimes(1);
    expect(wire.sessionCompileStop).not.toHaveBeenCalled();
    expect(wire.cancelLocalSynthesis).not.toHaveBeenCalled();
  });

  it.each([
    ["failed", "processing_failed", "operation_failed"],
    ["failed", "model_host_failed", "operation_failed"],
    ["failed", "task_failed", "operation_failed"],
    ["pending", "model_preparation_unavailable", "model_missing"],
    ["pending", "custody_retirement_pending", "incomplete"],
    ["stopped", "cancelled", "cancelled"],
  ])("preserves native confirmed %s/%s without a second Stop", async (state, reason, code) => {
    const wire = compilerTransport();
    wire.sessionCompileStep.mockImplementation(async (issued: SessionCompileContext, requestId: string) => {
      const failure = nativeFailure(issued, requestId);
      failure.outcome.state = state;
      failure.outcome.reason = reason;
      throw failure;
    });
    await expect(runNativeSessionCompile(context, { lang: "ko" }, wire)).rejects.toMatchObject({
      status: state, code, message: "Synthetic packet processing failed",
    });
    expect(wire.sessionCompileStep).toHaveBeenCalledTimes(1);
    expect(wire.sessionCompileStop).not.toHaveBeenCalled();
    expect(wire.cancelLocalSynthesis).not.toHaveBeenCalled();
  });

  it("retains the original and native finalization errors without claiming a saved state", async () => {
    const wire = compilerTransport();
    wire.sessionCompileStep.mockRejectedValue({ version: "SessionCompileFailureV1",
      message: "Synthetic packet model unavailable", outcome: null,
      finalizationError: "Synthetic native progress CAS changed" });
    const error = await runNativeSessionCompile(context, { lang: "ko" }, wire).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("Synthetic packet model unavailable");
    expect(error.message).toContain("Synthetic native progress CAS changed");
    expect(error).not.toHaveProperty("status", "pending");
    expect(error).not.toHaveProperty("status", "stopped");
    expect(wire.sessionCompileStop).not.toHaveBeenCalled();
  });

  it.each(["version", "message", "finalization-error", "finalization-with-outcome", "attempt", "source", "signature", "vault", "opening", "role", "request", "null-request", "state", "reason", "reason-state"])(
    "rejects an unconfirmed %s failure binding without mutating native state", async field => {
      const wire = compilerTransport();
      wire.sessionCompileStep.mockImplementation(async (issued: SessionCompileContext, requestId: string) => {
        const failure = nativeFailure(issued, requestId);
        let malformed: unknown = failure;
        if (field === "version") failure.version = "SessionCompileFailureV2";
        if (field === "message") malformed = { ...failure, message: 42 };
        if (field === "finalization-error") malformed = { ...failure, finalizationError: false };
        if (field === "finalization-with-outcome") {
          failure.finalizationError = "Synthetic native failure could not be persisted";
          failure.outcome.state = "pending";
          failure.outcome.reason = "model_preparation_unavailable";
        }
        if (field === "attempt") failure.outcome.attemptId = "foreign-attempt";
        if (field === "source") failure.outcome.sourceRevision = "d".repeat(64);
        if (field === "signature") failure.outcome.compileSignature = "foreign-compiler";
        if (field === "vault") failure.outcome.origin.vaultPath = "/foreign-vault";
        if (field === "opening") failure.outcome.origin.openingToken = "foreign-opening";
        if (field === "role") failure.outcome.roleSnapshotId = "foreign-role";
        if (field === "request") failure.outcome.requestId = "foreign-request";
        if (field === "null-request") failure.outcome.requestId = null;
        if (field === "state") failure.outcome.state = "completed";
        if (field === "reason") failure.outcome.reason = "foreign-reason";
        if (field === "reason-state") failure.outcome.state = "pending";
        throw malformed;
      });
      const error = await runNativeSessionCompile(context, { lang: "ko" }, wire).catch(error => error);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toHaveProperty("status", "pending");
      expect(error).not.toHaveProperty("status", "stopped");
      expect(error).not.toHaveProperty("code", "model_missing");
      if (field === "finalization-with-outcome") {
        expect(error.message).toContain("Synthetic native failure could not be persisted");
      }
      expect(wire.sessionCompileStop).not.toHaveBeenCalled();
    },
  );

  it("does not treat an unowned progress callback error as a native failure", async () => {
    const wire = compilerTransport();
    await expect(runNativeSessionCompile(context, { lang: "ko", onProgress: () => {
      throw new Error("Synthetic observer failed");
    } }, wire)).rejects.toThrow("Synthetic observer failed");
    expect(wire.sessionCompileStop).not.toHaveBeenCalled();
  });

  it("keeps earlier native progress when a later packet has a confirmed failure", async () => {
    const wire = compilerTransport();
    const first: SessionCompileStepResult = { ...completed(), state: "running", nextPacket: 1,
      eligibleWindows: 2, publication: null,
      step: { packetIndex: 0, processedWindows: 1, eligibleWindows: 2, omittedWindows: 1,
        reviewAccepted: true, nativeReviewRevision: "b".repeat(64), sourceSchemaChecked: true, allPacketsSeen: false } };
    wire.sessionCompileStep.mockResolvedValueOnce(first).mockImplementationOnce(async (issued: SessionCompileContext, requestId: string) => {
      throw nativeFailure(issued, requestId);
    });
    const progress = vi.fn();
    await expect(runNativeSessionCompile(context, { lang: "ko", onProgress: progress }, wire))
      .rejects.toMatchObject({ status: "failed", code: "operation_failed" });
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith(first);
    expect(wire.sessionCompileStep).toHaveBeenCalledTimes(2);
    expect(wire.sessionCompileStop).not.toHaveBeenCalled();
  });
});
