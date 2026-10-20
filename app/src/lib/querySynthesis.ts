// Selected generation failures remain typed errors. Explicit extractive Ask
// is separate; rejected source evidence requires a fresh search.
import { ipc, type ActivityAdditionalSource, type ActivityResolutionRequest, type ActivitySource, type AgentVaultSession, type AskScope, type LocalSynthesisResult } from "./ipc";
import type { Lang } from "./i18n";
import { BUILTIN_MODEL, isBuiltinChatModel } from "./providers";
import { extractWikilinks } from "./askHistory";
import { displayName } from "./displayName";
import { log } from "./log";
import { useVaultStore } from "../stores/vaultStore";
import { checkedResolutionSources } from "./queryResolution";
import type { RoleSnapshot } from "./modelRoles";
import { checkedAskRole, isQueryAuthorizationError, QueryAuthorizationError } from "./queryRole";

const FALLBACK_REASONS = [
  "status_timeout", "model_unavailable", "prompt_unavailable", "generation_failed",
  "answer_rejected", "answer_incomplete", "time_budget", "response_rejected", "status_failed", "synthesis_failed",
  "index_stale", "retrieval_failed",
] as const;
export type LocalSynthesisFallbackReason = typeof FALLBACK_REASONS[number];

const REVIEW_FAILURES = ["review_rejected", "review_uncertain", "review_missing", "review_invalid",
  "review_not_fit", "review_unavailable", "review_stopped"] as const;
type SynthesisReviewFailure = typeof REVIEW_FAILURES[number];
export function isSynthesisReviewFailure(code: unknown): code is SynthesisReviewFailure {
  return REVIEW_FAILURES.some(reason => reason === code);
}

interface SynthesisOptions {
  modelId?: string;
  activityOverview?: boolean;
  question: string;
  previousQuestion?: string;
  lang: Lang;
  hits: readonly ActivitySource[];
  expectedVault: string;
  origin?: AgentVaultSession;
  roleSnapshot?: RoleSnapshot;
  scope: AskScope;
  range?: { start: string; end: string };
  resolution?: ActivityResolutionRequest;
  paths?: string[];
  signal?: AbortSignal;
  onThinking?: (stems: string[]) => void;
  onFallback?: (reason: LocalSynthesisFallbackReason) => void;
}

const citationPath = (page: string): string => page.replace(/\.md$/i, "");

/** Native source rejection must never fall back to the rejected retrieval quotes. */
export class LocalSynthesisSourceError extends Error {
  constructor(readonly reason: "source_verification_failed" | "source_changed_during_generation") {
    super("local synthesis sources could not be verified");
    this.name = "LocalSynthesisSourceError";
  }
}

/** A selected generator's failure cannot authorize a quote-only successful answer. */
export class LocalSynthesisError extends Error {
  constructor(readonly code: LocalSynthesisFallbackReason) {
    super("local synthesis could not produce a reviewed answer");
    this.name = "LocalSynthesisError";
  }
}

export type ActivitySynthesisFailure = LocalSynthesisFallbackReason | "activity_insufficient_evidence" |
  "claim_extraction_failed" | "activity_receipt_invalid" | SynthesisReviewFailure;

/** Activity failure is not a successful quote-only summary. Native detail stays private. */
export class ActivitySynthesisError extends Error {
  constructor(readonly code: ActivitySynthesisFailure) {
    super("local activity synthesis could not be completed");
    this.name = "ActivitySynthesisError";
  }
}

function validPeriodCounts(value: unknown, total: number): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const counts = value as Record<string, unknown>;
  const categories = [counts.inPeriodSpans, counts.outsidePeriodSpans, counts.uncertainSpans];
  if (!categories.every((count): count is number => typeof count === "number" && Number.isSafeInteger(count) && count >= 0))
    return false;
  const sum = categories.reduce((sum, count) => sum + count, 0);
  return Number.isSafeInteger(sum) && sum === total;
}

function validActivityReceipt(reply: LocalSynthesisResult, options: SynthesisOptions): boolean {
  const receipt = reply.activity_receipt;
  if (!receipt || !options.range || receipt.activityPeriod?.start !== options.range.start ||
      receipt.activityPeriod.end !== options.range.end || receipt.scope !== options.scope ||
      ![receipt.activityPeriod.startEpoch, receipt.activityPeriod.endEpoch].every(epoch => epoch === null || Number.isSafeInteger(epoch)) ||
      receipt.claimSourceAndStructureChecked !== true || receipt.semanticReviewRequired !== true ||
      !Number.isSafeInteger(receipt.automatedClaimReviews) || receipt.automatedClaimReviews <= 0 ||
      receipt.automatedClaimReviews !== receipt.extractionBatches ||
      typeof receipt.automatedAnswerReviewInputRevision !== "string" ||
      !/^[a-f0-9]{64}$/.test(receipt.automatedAnswerReviewInputRevision) ||
      typeof receipt.originalInputsIncomplete !== "boolean" ||
      receipt.independentVerificationReceipts !== 0) return false;
  const counts = [receipt.eligibleOriginalSpans, receipt.boundedWindows, receipt.processedWindows, receipt.omittedWindows,
    receipt.extractionBatches, receipt.proposedClaims, receipt.selectedClaims, receipt.omittedClaims, receipt.answerOriginalSpans];
  return counts.every(count => Number.isSafeInteger(count) && count >= 0) &&
    receipt.eligibleOriginalSpans > 0 && receipt.processedWindows > 0 && receipt.extractionBatches > 0 &&
    receipt.selectedClaims > 0 && receipt.answerOriginalSpans > 0 &&
    receipt.boundedWindows <= 512 &&
    receipt.processedWindows + receipt.omittedWindows === receipt.boundedWindows &&
    receipt.selectedClaims + receipt.omittedClaims === receipt.proposedClaims &&
    receipt.answerOriginalSpans <= receipt.boundedWindows &&
    validPeriodCounts(receipt.originalPeriodCounts, receipt.eligibleOriginalSpans) &&
    validPeriodCounts(receipt.answerPeriodCounts, receipt.answerOriginalSpans);
}

/** Enforce the returned citation boundary as well as native source validation. */
function validReply(reply: LocalSynthesisResult, hits: readonly { page: string }[], model: string): boolean {
  if (!reply || reply.fallback_reason || !reply.answer?.trim() || reply.model_id !== model ||
      !reply.used_sources?.length) return false;
  const allowed = new Set(hits.map(hit => citationPath(hit.page)));
  const used = new Set(reply.used_sources.map(citationPath));
  const cited = extractWikilinks(reply.answer);
  const citedPaths = new Set(cited.map(citationPath));
  return [...used].every(page => allowed.has(page) && citedPaths.has(page)) && cited.length > 0 &&
    cited.every(page => allowed.has(citationPath(page)) && used.has(citationPath(page)));
}

/** Null is reserved for explicit extractive selection or absent evidence. */
export async function tryLocalSynthesis(options: SynthesisOptions): Promise<LocalSynthesisResult | null> {
  const { question, previousQuestion, lang, expectedVault, scope, range, paths, signal, onThinking } = options;
  const roleSnapshot = checkedAskRole(options.origin, options.roleSnapshot, expectedVault, options.modelId);
  const modelId = roleSnapshot.routeSignature.modelId;
  if (roleSnapshot.routeSignature.providerId !== "builtin-local") throw new QueryAuthorizationError();
  if (modelId === BUILTIN_MODEL) return null;
  if (!isBuiltinChatModel(modelId)) throw new LocalSynthesisError("model_unavailable");
  if (options.activityOverview && (!options.origin || options.origin.vaultPath !== expectedVault ||
      typeof options.origin.openingToken !== "string" || !options.origin.openingToken ||
      options.origin.openingToken.length > 256 || !range)) throw new LocalSynthesisSourceError("source_verification_failed");
  const hits = options.hits.filter(hit => hit.text.trim());
  if (!hits.length) return null;
  if (signal?.aborted) throw new Error("stopped");
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  let requestId: string | undefined;
  let phase: "status" | "synthesis" = "status";
  const fallback = (reason: LocalSynthesisFallbackReason): never => {
    options.onFallback?.(reason);
    if (options.activityOverview) throw new ActivitySynthesisError(reason);
    throw new LocalSynthesisError(reason);
  };
  const abort = (): void => {
    if (requestId) void ipc.cancelLocalSynthesis(requestId).catch(() => log.warn("query.synthesis_cancel_failed"));
    rejectAbort(new Error("stopped"));
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    // Cold artifact verification may be slow; only an explicit Stop ends the wait.
    const status = await Promise.race([ipc.localChatStatus(modelId), aborted]);
    if (signal?.aborted) throw new Error("stopped");
    if (!status || status.state !== "ready" || status.model_id !== modelId ||
        !Number.isFinite(status.bytes) || status.bytes <= 0)
      return fallback("model_unavailable");
    // Native token budgeting may select fewer pages than retrieval returned.
    // Report a running model without guessing its actual context-page count.
    onThinking?.([]);
    if (signal?.aborted) throw new Error("stopped");
    phase = "synthesis";
    requestId = `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const reply = await Promise.race([ipc.localSynthesize({ requestId, expectedVault, question, lang,
      origin: roleSnapshot.origin, roleSnapshot,
      ...(previousQuestion ? { previousQuestion } : {}),
      scope, ...(range ? { range } : {}), ...(paths ? { paths } : {}), maxTokens: 768,
      ...(options.activityOverview ? { activityOverview: true } : {}),
      ...(options.resolution ? { resolution: options.resolution } : {}),
      hits: hits.map(({ page, stem, section, text }) => ({ page, stem, section, text })),
      modelId,
    }), aborted]);
    if (signal?.aborted) throw new Error("stopped");
    if (isQueryAuthorizationError(reply?.fallback_reason)) throw new QueryAuthorizationError();
    // A rejected or unavailable review cannot authorize prose or quote success.
    const reviewFailure = [reply?.fallback_reason, reply?.activity_failure?.code].find(isSynthesisReviewFailure);
    if (reviewFailure) throw new ActivitySynthesisError(reviewFailure);
    if (reply?.fallback_reason === "source_verification_failed" ||
        reply?.fallback_reason === "source_changed_during_generation") {
      log.warn("query.synthesis_sources_rejected", { reason: reply.fallback_reason });
      throw new LocalSynthesisSourceError(reply.fallback_reason);
    }
    if (options.activityOverview && (reply?.activity_failure?.code === "activity_insufficient_evidence" ||
        reply?.activity_failure?.code === "claim_extraction_failed"))
      throw new ActivitySynthesisError(reply.activity_failure.code);
    if (reply?.activity_failure) {
      const reason = FALLBACK_REASONS.find(reason => reason === reply.fallback_reason) ??
        FALLBACK_REASONS.find(reason => reason === reply.activity_failure?.code) ?? "response_rejected";
      return fallback(reason);
    }
    if (!reply || typeof reply.answer !== "string" || typeof reply.model_id !== "string" ||
        !Array.isArray(reply.used_sources) || reply.used_sources.some(page => typeof page !== "string") ||
        (reply.fallback_reason !== undefined && typeof reply.fallback_reason !== "string"))
      return fallback("response_rejected");
    if (reply.fallback_reason || !reply.answer.trim() || !reply.used_sources.length || reply.model_id !== status.model_id) {
      const reason = FALLBACK_REASONS.find(reason => reason === reply?.fallback_reason) ?? "response_rejected";
      return fallback(reason);
    }
    let additional: ActivityAdditionalSource[] = [];
    if (options.activityOverview) {
      if (!validActivityReceipt(reply, options)) throw new ActivitySynthesisError("activity_receipt_invalid");
      const checked = checkedResolutionSources(reply.activity_receipt!, options);
      if (!checked) throw new ActivitySynthesisError("activity_receipt_invalid");
      additional = checked;
    } else {
      // These transport fields are necessary protocol evidence, not semantic authority.
      const receipt = reply.answerReceipt;
      if (!receipt || !Number.isSafeInteger(receipt.answerOriginalSpans) || receipt.answerOriginalSpans <= 0 ||
          typeof receipt.automatedAnswerReviewInputRevision !== "string" ||
          !/^[a-f0-9]{64}$/.test(receipt.automatedAnswerReviewInputRevision))
        return fallback("response_rejected");
    }
    if (!validReply(reply, [...hits, ...additional.map(source => ({ page: source.citationPage }))], status.model_id)) {
      const reason = FALLBACK_REASONS.find(reason => reason === reply?.fallback_reason) ?? "response_rejected";
      log.warn("query.synthesis_fallback", { reason });
      return fallback(reason);
    }
    // Normalize labels only after validation, preserving each verified target.
    const vault = useVaultStore.getState();
    const titles = !vault.isOpeningVault && vault.currentVault?.path === expectedVault
      ? vault.adjacency?.meta : undefined;
    const labels = new Map(hits.map(hit => [citationPath(hit.page),
      displayName(hit.stem, (options.activityOverview ? hit.title : undefined) ??
        titles?.[`${expectedVault.replace(/\/$/, "")}/${hit.page}`]?.title)
        .replace(/[[\]|\r\n]/g, "")]));
    for (const source of additional) labels.set(citationPath(source.citationPage),
      displayName(source.stem, source.title ?? undefined).replace(/[[\]|\r\n]/g, ""));
    const answer = reply.answer.trim().replace(/\[\[([^\]\n]+?)\]\]/g, (citation: string, content: string) => {
      const target = content.split("|")[0];
      const label = labels.get(citationPath(target.trim()));
      return label ? `[[${target}|${label}]]` : citation;
    });
    return { ...reply, answer };
  } catch (error) {
    if (signal?.aborted) throw new Error("stopped");
    if (isQueryAuthorizationError(error)) throw new QueryAuthorizationError();
    if (error instanceof LocalSynthesisSourceError || error instanceof ActivitySynthesisError || error instanceof LocalSynthesisError) throw error;
    const reason = phase === "status" ? "status_failed" : "synthesis_failed";
    log.warn("query.synthesis_fallback", { reason });
    return fallback(reason);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
