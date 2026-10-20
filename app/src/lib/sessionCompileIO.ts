import { ipc, type SessionCompileContext, type SessionCompileStepResult } from "./ipc";
import type { ExtractiveIngestIO } from "./extractiveIngest";
import type { Lang } from "./i18n";
import { WorkflowOperationError } from "./workflowOutcome";

export interface NativeSessionCompilerTransport {
  sessionCompileStep: typeof ipc.sessionCompileStep;
  sessionCompileStop: typeof ipc.sessionCompileStop;
  cancelLocalSynthesis: typeof ipc.cancelLocalSynthesis;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nativeFailureError(error: unknown, context: SessionCompileContext, requestId: string): Error {
  const message = record(error) && typeof error.message === "string" ? error.message : String(error);
  const finalization = record(error) && typeof error.finalizationError === "string"
    ? `; Native compiler failure finalization could not be confirmed: ${error.finalizationError}` : "";
  if (!record(error) || error.version !== "SessionCompileFailureV1" || typeof error.message !== "string" ||
      !(error.finalizationError === null || typeof error.finalizationError === "string")) {
    return new WorkflowOperationError("failed", "operation_failed", message + finalization);
  }
  const outcome = error.outcome;
  if (error.finalizationError !== null || !record(outcome) || !record(outcome.origin) ||
      typeof outcome.attemptId !== "string" || outcome.attemptId !== context.attemptId ||
      typeof outcome.sourceRevision !== "string" || !/^[a-f0-9]{64}$/.test(outcome.sourceRevision) ||
      outcome.sourceRevision !== context.source.sourceRevision ||
      typeof outcome.compileSignature !== "string" || outcome.compileSignature !== context.compileSignature ||
      typeof outcome.origin.vaultPath !== "string" || outcome.origin.vaultPath !== context.origin.vaultPath ||
      typeof outcome.origin.openingToken !== "string" || outcome.origin.openingToken !== context.origin.openingToken ||
      typeof outcome.roleSnapshotId !== "string" || outcome.roleSnapshotId !== context.roleSnapshot.snapshotId ||
      typeof outcome.requestId !== "string" || outcome.requestId !== requestId) {
    return new WorkflowOperationError("failed", "operation_failed", message + finalization);
  }
  if (outcome.state === "pending" && outcome.reason === "model_preparation_unavailable") {
    return new WorkflowOperationError("pending", "model_missing", message + finalization);
  }
  if (outcome.state === "pending" && outcome.reason === "custody_retirement_pending") {
    return new WorkflowOperationError("pending", "incomplete", message + finalization);
  }
  if (outcome.state === "partial" && outcome.reason === "semantic_review_unavailable") {
    return new WorkflowOperationError("pending", "incomplete", message + finalization);
  }
  if (outcome.state === "stopped" && outcome.reason === "cancelled") {
    return new WorkflowOperationError("stopped", "cancelled", message + finalization);
  }
  if (outcome.state === "failed" && (outcome.reason === "model_host_failed" ||
      outcome.reason === "processing_failed" || outcome.reason === "task_failed")) {
    return new WorkflowOperationError("failed", "operation_failed", message + finalization);
  }
  return new WorkflowOperationError("failed", "operation_failed", message + finalization);
}

async function requestNativePacket(context: SessionCompileContext, requestId: string, lang: Lang,
  transport: NativeSessionCompilerTransport): Promise<SessionCompileStepResult> {
  try {
    return await transport.sessionCompileStep(context, requestId, lang);
  } catch (error) {
    throw nativeFailureError(error, context, requestId);
  }
}

function checkReceipt(context: SessionCompileContext, result: SessionCompileStepResult,
  previous: SessionCompileStepResult | null): void {
  const whole = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
  if (result.attemptId !== context.attemptId || result.sourceRevision !== context.source.sourceRevision ||
      !whole(result.eligibleWindows) || !whole(result.nextPacket) || result.nextPacket > result.eligibleWindows ||
      previous && previous.eligibleWindows !== result.eligibleWindows) {
    throw new Error("native compiler receipt does not match the issued attempt/source or packet plan");
  }
  const step = result.step;
  if (step && (!whole(step.packetIndex) || !whole(step.processedWindows) || !whole(step.omittedWindows) ||
      step.eligibleWindows !== result.eligibleWindows || step.processedWindows > result.eligibleWindows ||
      step.processedWindows + step.omittedWindows !== result.eligibleWindows ||
      step.packetIndex >= result.eligibleWindows || step.processedWindows !== step.packetIndex + 1 ||
      !/^[a-f0-9]{64}$/.test(step.nativeReviewRevision) || !step.sourceSchemaChecked ||
      step.allPacketsSeen !== (step.processedWindows === result.eligibleWindows) ||
      previous?.step && (step.packetIndex <= previous.step.packetIndex ||
        step.processedWindows <= previous.step.processedWindows))) {
    throw new Error("native compiler receipt has invalid or repeated fresh packet progress");
  }
  if (result.state === "completed") {
    if (result.publication?.ok !== true || result.publication.state !== "completed" ||
        result.publication.attemptId !== context.attemptId ||
        step && (!step.allPacketsSeen || !step.reviewAccepted || step.omittedWindows !== 0)) {
      throw new Error("native compiler receipt lacks its completed publication");
    }
  } else if (!["running", "partial"].includes(result.state) || !step || result.publication !== null ||
      result.state === "running" && step.allPacketsSeen || result.state === "partial" && !step.allPacketsSeen) {
    throw new Error("native compiler receipt has an inconsistent incomplete state");
  }
}

/** Process every native packet in one captured attempt. No source text or
 * previous question crosses this transport, and no preview can mark complete. */
export async function runNativeSessionCompile(context: SessionCompileContext, options: {
  lang: Lang;
  signal?: AbortSignal;
  onProgress?: (result: SessionCompileStepResult) => void;
}, transport: NativeSessionCompilerTransport = ipc): Promise<SessionCompileStepResult> {
  if (options.signal?.aborted) {
    await transport.sessionCompileStop(context, "stopped");
    throw new WorkflowOperationError("stopped", "cancelled", "stopped");
  }
  let previous: SessionCompileStepResult | null = null;
  let requestId: string | null = null;
  let stopAction: Promise<void> | null = null;
  let rejectAbort!: (reason: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const stop = (): void => {
    if (stopAction) return;
    stopAction = (async () => {
      // The native Stop command independently cancels its bound request before
      // checkpointing stopped state; a failed local hint cannot replace it.
      if (requestId) void transport.cancelLocalSynthesis(requestId).catch(() => false);
      await transport.sessionCompileStop(context, "stopped");
    })();
    rejectAbort(new WorkflowOperationError("stopped", "cancelled", "stopped"));
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  try {
    try {
      if (context.roleSnapshot.routeSignature.providerId !== "builtin-local") {
        const message = "Selected external session compiler adapter is unavailable; source remains pending";
        try { await transport.sessionCompileStop(context, "preparation_required"); }
        catch (checkpointError) {
          throw new Error(`${message}; Native compiler preparation checkpoint could not be confirmed: ${String(checkpointError)}`);
        }
        throw new WorkflowOperationError("pending", "unavailable", message);
      }
      for (;;) {
        if (options.signal?.aborted) throw new WorkflowOperationError("stopped", "cancelled", "stopped");
        const issuedRequestId = `session-compile-${crypto.randomUUID()}`;
        requestId = issuedRequestId;
        const result = await Promise.race([
          requestNativePacket(context, issuedRequestId, options.lang, transport), aborted,
        ]);
        if (options.signal?.aborted) throw new WorkflowOperationError("stopped", "cancelled", "stopped");
        checkReceipt(context, result, previous);
        previous = result;
        options.onProgress?.(result);
        if (options.signal?.aborted) throw new WorkflowOperationError("stopped", "cancelled", "stopped");
        if (result.state !== "running") return result;
      }
    } finally {
      options.signal?.removeEventListener("abort", stop);
    }
  } catch (error) {
    if (stopAction) {
      try { await stopAction; }
      catch (stopError) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message}; Native compiler Stop could not be confirmed: ${String(stopError)}`);
      }
    }
    throw error;
  }
}

export interface SessionCompileTransport {
  sessionCompileRead: typeof ipc.sessionCompileRead;
  sessionCompilePublish: typeof ipc.sessionCompilePublish;
}

/** The native attempt owns exact paths and creates confined directories during
 * publication. This adapter never falls back to the generic file writer. */
export function sessionCompileIO(context: SessionCompileContext,
  transport: SessionCompileTransport = ipc): ExtractiveIngestIO {
  const prefix = `${context.origin.vaultPath}/`;
  const relative = (path: string): string => {
    if (!path.startsWith(prefix)) throw new Error("compiler IO belongs to a different vault");
    return path.slice(prefix.length);
  };
  return {
    readFile: path => transport.sessionCompileRead(context, relative(path)),
    writeFileIfUnchanged: (path, content, expected) =>
      transport.sessionCompilePublish(context, relative(path), content, expected),
    writeFile: async (path, content) => {
      // Reports also require an exact loaded baseline. Absence alone uses
      // null; permissions and other read failures are never rewritten empty.
      let expected: string | null;
      try { expected = (await transport.sessionCompileRead(context, relative(path))).revision; }
      catch (error) {
        if (!/\bENOENT\b|no such file or directory|\(os error 2\)/i.test(String(error))) throw error;
        expected = null;
      }
      return transport.sessionCompilePublish(context, relative(path), content, expected);
    },
    createFolder: async (parent, name) => {
      if (parent !== context.origin.vaultPath || !["wiki", "ingest-reports"].includes(name)) {
        throw new Error("compiler directory is outside its native issued output set");
      }
      // The checked native publisher creates this parent after its guards and
      // rechecks confinement. No generic mkdir is authorized by this adapter.
    },
  };
}
