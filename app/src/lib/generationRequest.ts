import type {
  AskExecutionEvent,
  AskModelIdentity,
  AskRequestedModel,
  AskRequestPurpose,
  AskRequestState,
} from "./askExecution";
import { log } from "./log";

interface GenerationRequestOptions<T> {
  requested: AskRequestedModel;
  purpose: AskRequestPurpose;
  signal?: AbortSignal;
  onExecution?: (event: AskExecutionEvent) => void;
  reportedIdentity?: (reply: T) => { modelId: unknown; source: AskModelIdentity["source"] } | undefined;
}

let requestSequence = 0;

function hasControlCharacters(value: string): boolean {
  return [...value].some(character => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

function reportedIdentity(value: unknown, providerId: string): AskModelIdentity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const identity = value as Record<string, unknown>;
  if (typeof identity.modelId !== "string" || !identity.modelId.trim() ||
      new TextEncoder().encode(identity.modelId).length > 512 || hasControlCharacters(identity.modelId) ||
      (identity.source !== "provider_response" && identity.source !== "local_manifest") ||
      (identity.source === "local_manifest") !== (providerId === "builtin-local")) return undefined;
  return { modelId: identity.modelId, source: identity.source };
}

/** Trace one app generation-command attempt. This does not count transport
 * retries, internal decoder calls, or prove that model weights ran on a GPU.
 * Wrap the generation IPC itself, after evidence, authorization and budgeting. */
export async function traceGenerationRequest<T>(
  options: GenerationRequestOptions<T>,
  request: () => Promise<T>,
): Promise<T> {
  const { purpose, signal, onExecution, reportedIdentity: identify } = options;
  if (signal?.aborted) throw new Error("stopped");
  if (!onExecution) return request();

  const requested = Object.freeze({ ...options.requested });
  const id = `generation-${Date.now().toString(36)}-${(++requestSequence).toString(36)}`;
  let finished = false;
  const emit = (state: AskRequestState, identity?: AskModelIdentity): void => {
    try {
      onExecution(Object.freeze({ id, purpose, requested, state,
        ...(identity ? { identity: Object.freeze({ ...identity }) } : {}) }));
    } catch {
      // Recording is optional. An observer cannot cancel the real command or
      // replace its outcome; the pending IPC promise must still be consumed.
      log.warn("generation.execution_observer_failed");
    }
  };
  const abort = (): void => {
    if (finished) return;
    finished = true;
    emit("cancelled");
  };

  // Invoke synchronously before publishing the submission, so an observer
  // cannot prevent the IPC attempt after it has already been recorded.
  let pending: Promise<T>;
  try { pending = request(); }
  catch (error) {
    emit("submitted");
    emit(signal?.aborted ? "cancelled" : "failed");
    throw error;
  }
  emit("submitted");
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const reply = await pending;
    if (!finished) {
      finished = true;
      // Optional provenance must not reject an otherwise usable answer.
      let identity: AskModelIdentity | undefined;
      try { identity = reportedIdentity(identify?.(reply), requested.providerId); }
      catch { /* Treat malformed optional metadata as unreported. */ }
      emit("response_received", identity);
    }
    return reply;
  } catch (error) {
    if (!finished) {
      finished = true;
      emit(signal?.aborted ? "cancelled" : "failed");
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
