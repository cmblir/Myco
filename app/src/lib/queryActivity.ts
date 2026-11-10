// Model-selected periods and date-grounded evidence for topic-free work recall.
import { ipc, type ActivityRecallResult, type AgentVaultSession, type AskScope } from "./ipc";
import type { Lang } from "./i18n";
import { isBuiltinChatModel } from "./providers";
import { isActivityOverviewQuery } from "./recallPolicy";
import { isRepositoryHistoryQuery, isVaultFilesQuery } from "./queryIntent";
import { parseTimeQuery, queryDateRange, type DateRange } from "./timeQuery";
import { log } from "./log";
import type { RoleSnapshot } from "./modelRoles";
import { checkedAskRole, isQueryAuthorizationError } from "./queryRole";
import type { AskExecutionEvent } from "./askExecution";
import { traceGenerationRequest } from "./generationRequest";

/** Remove vague recency only; quoted, dated and topic-qualified requests keep their routes. */
export function isUndatedActivityOverview(question: string, lang: Lang, queryTime = new Date()): boolean {
  if (/["'“”「」『』`]/.test(question) || isVaultFilesQuery(question) ||
      isRepositoryHistoryQuery(question) || parseTimeQuery(question, queryTime, lang).range) return false;
  const recent = lang === "ko" ? /(?:최근|요즘)(?:에는|동안|에|엔|은|는)?/ :
    lang === "ja" ? /最近(?:の)?/ : /\b(?:recently|recent|lately)\b/i;
  if (!recent.test(question)) return false;
  const cleaned = question.replace(recent, " ").replace(/\s+/g, " ").trim();
  return isActivityOverviewQuery(cleaned) ||
    /^(?:summarize|sum up)\s+(?:my|our)\s+(?:work|activities|activity|tasks)[.!?]*$/i.test(cleaned) ||
    /^(?:私(?:たち)?が)?(?:した|やった)(?:こと|作業)(?:を)?(?:まとめて|教えて|整理して)[。？?]*$/.test(cleaned);
}

/** A topic-free request for next work needs personal task evidence, not word similarity. */
export function isNextWorkOverview(question: string): boolean {
  if (/["'“”「」『』`]/.test(question)) return false;
  const compact = question.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return /^(앞으로|다음에|다음으로|지금|이제)?(내가|나는|제가|저는|우리가)?(앞으로|다음에|다음으로|지금|이제)?(어떤|무슨)(작업|일들|일|것들|것)(을|를|부터)?(하면|하는게|하는것이)(좋을까|좋을까요|좋겠어|좋겠어요)(앞으로|다음에)?$/.test(compact) ||
    ["whatshouldiworkonnext", "whatshouldweworkonnext", "whatworkshouldidonext", "whatshouldidonext",
      "whichtaskshouldidofirst", "whatshouldifocusonnext", "次にどんな作業をすればいいですか",
      "次に何をすればいいですか", "次に何をしたらいいですか", "これからどんな作業をすればいいですか"].includes(compact);
}

interface ActivityOptions {
  question: string;
  lang: Lang;
  modelId: string;
  expectedVault: string;
  origin?: AgentVaultSession;
  roleSnapshot?: RoleSnapshot;
  queryTime?: Date;
  scope: AskScope;
  range?: DateRange;
  paths?: string[];
  signal?: AbortSignal;
  onThinking?: () => void;
  /** Validated applied period, exposed before evidence retrieval starts. */
  onRangeSelected?: (range: DateRange) => void;
  onRetrieving?: () => void;
  onExecution?: (event: AskExecutionEvent) => void;
}

/** A vague period is not permission to choose an arbitrary look-back window. */
export class ActivityPeriodRequired extends Error {
  constructor() {
    super("activity recall requires an explicit period for this provider");
    this.name = "ActivityPeriodRequired";
  }
}

export function activityPeriodClarification(lang: Lang): string {
  return {
    ko: "어느 기간의 기록을 살펴볼까요? 예: ‘이번 주’, ‘최근 7일’, ‘지난달’.",
    en: "Which period should I review? For example: this week, the last 7 days, or last month.",
    ja: "どの期間の記録を確認しますか？例：今週、過去7日間、先月。",
  }[lang];
}

const todayLocal = (now: Date): string => {
  if (!Number.isFinite(now.getTime())) throw new Error("activity query time is invalid");
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

function validateRange(range: DateRange, today: string): DateRange {
  if (!range || typeof range.start !== "string" || typeof range.end !== "string")
    throw new Error("activity period is invalid");
  queryDateRange(range);
  if (range.end > today) throw new Error("activity period is in the future");
  return { start: range.start, end: range.end };
}

function validateRecall(reply: ActivityRecallResult, paths?: string[]): ActivityRecallResult {
  const allowed = paths ? new Set(paths.map(path => path.normalize("NFC"))) : undefined;
  if (!reply || !Array.isArray(reply.hits) || reply.hits.length > 12 ||
      typeof reply.incomplete !== "boolean" ||
      ![reply.indexed_pages, reply.scanned_pages, reply.matched_chunks].every(n => Number.isSafeInteger(n) && n >= 0) ||
      reply.hits.some(hit => !hit || typeof hit.page !== "string" || !hit.page || hit.page.length > 1024 ||
        /[[\]|\r\n]/.test(hit.page) || hit.page.split("/").some(part => !part || part === "." || part === "..") ||
        typeof hit.stem !== "string" || hit.stem.length > 256 ||
        (hit.title !== undefined && (typeof hit.title !== "string" || [...hit.title].length > 256)) ||
        !Number.isSafeInteger(hit.section) || hit.section < 0 || typeof hit.text !== "string" || !hit.text.trim() || hit.text.length > 32768 ||
        (allowed && !allowed.has(hit.page.normalize("NFC")))))
    throw new Error("activity evidence is invalid");
  return reply;
}

/** Wait until completion or explicit Stop; never substitute a fixed period or similarity hits. */
export async function retrieveActivity(options: ActivityOptions): Promise<ActivityRecallResult & { range: DateRange }> {
  if (options.signal?.aborted) throw new Error("stopped");
  const { origin } = options;
  const roleSnapshot = checkedAskRole(origin, options.roleSnapshot, options.expectedVault, options.modelId);
  const isBuiltin = roleSnapshot.routeSignature.providerId === "builtin-local";
  if (isBuiltin && !isBuiltinChatModel(options.modelId))
    throw new Error("activity requires a supported selected local chat model");
  // The native local planner cannot execute another provider's selection.
  // Ask for a period instead of borrowing its model or inventing a window.
  if (!isBuiltin && !options.range) throw new ActivityPeriodRequired();
  const today = todayLocal(options.queryTime ?? new Date());
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  let requestId: string | undefined;
  const abort = (): void => {
    if (requestId) void ipc.cancelLocalSynthesis(requestId).catch(() => log.warn("query.activity_cancel_failed"));
    rejectAbort(new Error("stopped"));
  };
  const ensureLive = (): void => { if (options.signal?.aborted) throw new Error("stopped"); };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (isBuiltin) {
      options.onThinking?.();
      ensureLive();
      const status = await Promise.race([ipc.localChatStatus(options.modelId)
        .catch(() => { throw new Error("activity model status failed"); }), aborted]);
      ensureLive();
      if (!status || status.model_id !== options.modelId || status.state !== "ready" || !Number.isFinite(status.bytes) || status.bytes <= 0)
        throw new Error("activity model is not ready");
    }
    let range: DateRange;
    if (options.range) {
      range = validateRange(options.range, today);
    } else {
      requestId = `activity-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const plan = await Promise.race([traceGenerationRequest({
        requested: { providerId: roleSnapshot.routeSignature.providerId, modelId: options.modelId },
        purpose: "period_plan", signal: options.signal, onExecution: options.onExecution,
        reportedIdentity: reply => ({ modelId: reply?.model_id, source: "local_manifest" }),
      }, () => ipc.localQueryPlan({ requestId: requestId!, question: options.question,
        today, modelId: options.modelId, expectedVault: options.expectedVault, origin: roleSnapshot.origin, roleSnapshot, scope: options.scope,
        ...(options.paths ? { paths: options.paths } : {}) }))
        .catch(error => { if (isQueryAuthorizationError(error)) throw error; throw new Error("activity planning failed"); }), aborted]);
      ensureLive();
      requestId = undefined;
      if (!plan || plan.model_id !== options.modelId) throw new Error("activity planner model mismatch");
      range = validateRange(plan, today);
    }
    ensureLive();
    options.onRangeSelected?.({ ...range });
    ensureLive();
    options.onRetrieving?.();
    ensureLive();
    const evidence = await Promise.race([ipc.activityRecall({ expectedVault: options.expectedVault, origin: roleSnapshot.origin, roleSnapshot, range,
      scope: options.scope, ...(options.paths ? { paths: options.paths } : {}) })
      .catch(error => { if (isQueryAuthorizationError(error)) throw error; throw new Error("activity retrieval failed"); }), aborted]);
    ensureLive();
    return { ...validateRecall(evidence, options.paths), range };
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}
