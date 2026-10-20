import { ipc, type LocalSynthesisResult, type MycoSettings, type SessionCompileContext } from "./ipc";
import type { AgentVaultSession } from "./ipc";
import type { RoleSnapshot } from "./modelRoles";
import type { Lang, Strings } from "./i18n";
import { isBuiltinChatModel } from "./providers";
import { extractWikilinks } from "./askHistory";
import { log } from "./log";
import { fingerprint, type EvidenceChunk } from "./sessionEvidence";
import { WorkflowOperationError, workflowIssue, type WorkflowIssue } from "./workflowOutcome";

export interface LocalTransformPreview {
  text: string | null;
  modelId: string;
  selectedChunks: number;
  totalChunks: number;
  /** A rejected or unavailable preview never certifies source completion. */
  failure?: WorkflowIssue;
}

export class LocalTransformSourceError extends Error {
  constructor(readonly reason: "source_verification_failed" | "source_changed_during_generation") {
    super(`local transform sources could not be verified: ${reason}`);
    this.name = "LocalTransformSourceError";
  }
}

interface TransformOptions {
  batch: readonly EvidenceChunk[];
  origin?: AgentVaultSession;
  roleSnapshot?: RoleSnapshot;
  vaultPath: string;
  kind: "ingest" | "organize";
  modelId?: string;
  lang?: Lang;
  signal?: AbortSignal;
  originals?: ReadonlyMap<string, string>;
  sessionCompile?: SessionCompileContext;
}

const citationPath = (page: string): string => page.replace(/\.md$/i, "");

/** Role-specific selection is opt-in; quote-only and other providers stay unchanged. */
export function selectedLocalTransformModel(provider: string, model: string): string | undefined {
  return provider === "builtin-local" && isBuiltinChatModel(model) ? model : undefined;
}

/** Organization owns its route; it never inherits Ask or Compilation consent. */
export function selectedLocalOrganizeModel(route: { provider: string; model: string },
  _settings?: Pick<MycoSettings, "ingest_provider" | "ingest_model"> | null): string | undefined {
  return selectedLocalTransformModel(route.provider, route.model);
}
export async function getLocalOrganizeModel(route: { provider: string; model: string }): Promise<string | undefined> {
  return selectedLocalOrganizeModel(route);
}

/** Describe the requested model and its bounded preview independently of quote coverage. */
export function localTransformNote(preview: LocalTransformPreview, t: Strings): string {
  const template = preview.text ? t.local_transform_note : t.local_transform_fallback_note;
  return template.replace("{selected}", String(preview.selectedChunks))
    .replace("{total}", String(preview.totalChunks)).replace("{model}", () => preview.modelId);
}

/** Selected generation must succeed before its source can receive coverage. */
export function requireLocalTransformPreview(preview: LocalTransformPreview | null): asserts preview is LocalTransformPreview & { text: string } {
  if (preview?.text && !preview.failure) return;
  const failure = preview?.failure;
  throw new WorkflowOperationError(failure?.status ?? "pending", failure?.code ?? "unavailable",
    failure?.error ?? "Selected local preview is unavailable; source remains pending");
}

function validReply(reply: LocalSynthesisResult, batch: readonly EvidenceChunk[], modelId: string): boolean {
  if (!reply || reply.fallback_reason || typeof reply.answer !== "string" || !reply.answer.trim() ||
      reply.answer.length > 6000 || reply.model_id !== modelId || !Array.isArray(reply.used_sources) ||
      !reply.used_sources.length || reply.used_sources.some(page => typeof page !== "string") ||
      typeof reply.selected_chunks !== "number" || !Number.isInteger(reply.selected_chunks) ||
      reply.selected_chunks < 1 || reply.selected_chunks > batch.length) return false;
  const allowed = new Set(batch.map(chunk => citationPath(chunk.source)));
  const used = new Set(reply.used_sources.map(citationPath));
  const cited = extractWikilinks(reply.answer).map(citationPath);
  return cited.length > 0 && [...used].every(page => allowed.has(page) && cited.includes(page)) &&
    cited.every(page => allowed.has(page) && used.has(page));
}

/** Generate one small preview; source rejection stops writing rather than reusing stale quotes. */
export async function tryLocalTransform(options: TransformOptions): Promise<LocalTransformPreview | null> {
  const { modelId, signal, vaultPath, kind, lang = "en" } = options;
  if (!modelId || !isBuiltinChatModel(modelId) || !options.batch.length) return null;
  if (signal?.aborted) throw new Error("stopped");
  // Normalized receipt scaffolding can leave a gap that is not one contiguous
  // original excerpt. Such chunks remain quoted evidence, never model inputs.
  const batch = options.batch.filter(chunk => chunk.text.trim() &&
    (!options.originals || options.originals.get(chunk.source)?.includes(chunk.text))).slice(0, 6);
  const preview: LocalTransformPreview = { text: null, modelId, selectedChunks: batch.length, totalChunks: options.batch.length };
  if (!batch.length) return { ...preview, failure: workflowIssue("local-transform",
    new WorkflowOperationError("pending", "no_exact_excerpt", "Local preview has no verified exact source excerpt")) };
  if (batch.some(chunk => chunk.text.length > 600)) throw new Error("Local transform evidence exceeds its chunk budget");
  if (options.originals) {
    const revisions = new Map<string, string>();
    for (const chunk of batch) {
      if (!revisions.has(chunk.source)) revisions.set(chunk.source, fingerprint(options.originals.get(chunk.source) ?? ""));
      if (revisions.get(chunk.source) !== chunk.revision) throw new LocalTransformSourceError("source_verification_failed");
    }
  }
  const origin = options.sessionCompile?.origin ?? options.origin ?? await ipc.agentVaultSession();
  const roleSnapshot = options.sessionCompile?.roleSnapshot ?? options.roleSnapshot ?? await ipc.captureModelRole(origin, kind === "ingest" ? "compilation" : "organization", "foreground");
  if (signal?.aborted) throw new Error("stopped");
  if (origin.vaultPath !== vaultPath || roleSnapshot.origin.vaultPath !== origin.vaultPath ||
      roleSnapshot.origin.openingToken !== origin.openingToken || roleSnapshot.role !== (kind === "ingest" ? "compilation" : "organization") ||
      roleSnapshot.routeSignature.providerId !== "builtin-local" || roleSnapshot.routeSignature.modelId !== modelId) {
    throw new Error("native local transform role does not match the originating preview");
  }
  const requestId = `transform-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = (): void => {
    void ipc.cancelLocalSynthesis(requestId).catch(() => log.warn("transform.cancel_failed"));
    rejectAbort(new Error("stopped"));
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const reply = await Promise.race([ipc.localTransform({ requestId, expectedVault: vaultPath, kind, lang, modelId, origin, roleSnapshot,
      sources: batch.map(chunk => ({ page: chunk.source, revision: chunk.revision, text: chunk.text })),
      ...(options.sessionCompile ? { sessionCompile: options.sessionCompile } : {}),
    }), aborted]);
    if (signal?.aborted) throw new Error("stopped");
    if (reply?.fallback_reason === "source_verification_failed" || reply?.fallback_reason === "source_changed_during_generation") {
      throw new LocalTransformSourceError(reply.fallback_reason);
    }
    if (validReply(reply, batch, modelId) && typeof reply.selected_chunks === "number") {
      preview.text = reply.answer.trim();
      preview.selectedChunks = reply.selected_chunks;
    }
    else {
      const reason = reply?.fallback_reason;
      const unavailable = reason === "model_missing" || reason === "model_unavailable" || reason === "prompt_unavailable" || reason === "time_budget";
      preview.failure = workflowIssue("local-transform", new WorkflowOperationError(unavailable ? "pending" : "failed",
        reason === "model_missing" ? "model_missing" : unavailable ? "unavailable" : !reason || reason === "answer_rejected" ? "validation_rejected" : "operation_failed",
        reason ? `Local preview rejected: ${reason}` : "Local preview failed response validation"));
      log.warn("transform.fallback", { reason: reason ?? "response_rejected" });
    }
    return preview;
  } catch (error) {
    if (signal?.aborted) throw new Error("stopped");
    if (error instanceof LocalTransformSourceError) throw error;
    if (/active vault changed|source_verification_failed|source_changed_during_generation/i.test(String(error))) {
      throw new LocalTransformSourceError("source_verification_failed");
    }
    const issue = workflowIssue("local-transform", error);
    if (issue.status === "stopped") throw new WorkflowOperationError("stopped", "cancelled", issue.error);
    preview.failure = { ...issue, code: "ipc_failed" };
    log.warn("transform.fallback", { reason: "request_failed" });
    return preview;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
