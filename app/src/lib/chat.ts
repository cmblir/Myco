// Unified chat entry-point. Reads the selected provider/model from settings
// and dispatches to either the Claude CLI (anthropic-cli) or the HTTP
// provider stack. Returns the assistant's text content.
//
// External CLI runs require an explicit native capability and source opening.
// Current unconfined runners are unavailable until their host/settings/MCP/
// child boundary is proven. HTTP/local routes inline bounded evidence.

import {
  ipc,
  type AskScope,
  type ClaudeResult,
  type AgentVaultSession,
  type CliExecutionRequest,
  type SearchScope,
  type MycoSettings,
  type NearMiss,
  type ScoredChunk,
  type SemanticSearchResult,
  type TierWeights,
} from "./ipc";
import { hitTier, sourceTier } from "./extractive";
import { BUILTIN_EMBED_MODEL, isBuiltinChatModel } from "./providers";
import { effectiveRole, type RoleId, type RoleSnapshot, type RoleUsage } from "./modelRoles";
import { getBudgetThreshold, overBudget, recordUsage } from "./budget";
import { log } from "./log";
import { loadProfile, injectionText } from "./profile";
import { buildRetrievalContext } from "./retrievalContext";

export interface SimpleMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/// What the app is actually doing while an Ask waits.
///
/// Streaming was measured and killed — prefill dominates, so tokens would start
/// appearing ~100 ms earlier and no sooner (see examples/bench_local_llm.rs).
/// That leaves honest staged status as the thing worth showing, because the
/// waits ARE long and they are not one undifferentiated lump: a cold model load
/// alone measured 11.7 s, and prefill over a full context ~2.7 s.
/// Two stages, because two is what is actually observable. A "reading the
/// pages" stage was tried and removed: retrieval's file reads take tens of
/// milliseconds, so it existed for a blink and told nobody anything. What is
/// left matches the measured shape of the wait — a query embedding (~460 ms),
/// then the model (prefill ~0.67 ms/token, plus up to 11.7 s of cold weight
/// load).
export type AskStage =
  /// Embedding the question and searching the index.
  | { kind: "retrieving" }
  /// The model is running. `stems` are the pages retrieval actually chose —
  /// empty when there was no index, or when retrieval found nothing. `stale`
  /// is set (never `false`, only present or absent — see `isIndexStale`) when
  /// the index predates a bundled embed-model swap and the whole-vault
  /// fallback was used instead: the UI should say so, not silently fall back.
  /// `retrievalFailed` is set the same way when an IPC call in retrieval
  /// (embeddings_status or semantic_search) *rejected* — as opposed to
  /// legitimately reporting an empty index or an empty hit list, neither of
  /// which is a failure. The whole-vault fallback still runs either way;
  /// this only makes the failure visible instead of indistinguishable from
  /// "found nothing".
  | { kind: "thinking"; stems: string[]; stale?: boolean; retrievalFailed?: boolean };

export interface CompleteArgs {
  /** Compatibility task names never inherit another feature's external selection. */
  task: "query" | "ingest" | "generate";
  featureRole?: RoleId;
  usage?: RoleUsage;
  /** Reuse one native grant for the whole job; never recapture after revocation. */
  roleSnapshot?: RoleSnapshot;
  messages: SimpleMessage[];
  cwd: string;
  /** Preserve a caller's source opening when it already captured one. */
  origin?: AgentVaultSession;
  /// Called as the run moves between stages. The non-tool provider path always
  /// reports these. The CLI query path now reports too, but only when this is
  /// passed — that's how interactive Ask (the only caller of task:"query" that
  /// passes it) opts in, and how study.ts/digests.ts/audioOverview.ts (which
  /// don't) opt out of both the stage reports and the CLI retrieval injection
  /// below. Stage reporting never grants a CLI access to filesystem tools.
  onStage?: (stage: AskStage) => void;
  /// Ask scope and tier priors for the retrieval block — interactive Ask's
  /// segment and sliders; the other task:"query" callers leave the backend
  /// defaults (wiki, DEFAULT_TIER_WEIGHTS).
  scope?: AskScope;
  tierWeights?: TierWeights;
  /// "Ask this note" (UX S37): retrieval keeps only these vault-relative
  /// pages, and nothing falls back to the whole vault.
  paths?: string[];
  /** The same date window and retrieval question apply to every provider. */
  range?: { start: string; end: string };
  retrievalQuery?: string;
  /// Ask's ■ (UX S36). Checked once retrieval is done, before the model is
  /// called: a stopped question never reaches a provider. Optional external
  /// runners currently fail before spawn; HTTP calls cannot be recalled and
  /// the caller drops late results.
  signal?: AbortSignal;
}

/** Throws once `signal` is aborted. Not `throwIfAborted`: Safari 15.4+, and
 *  the app still runs on macOS 10.15. */
function stopIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("stopped");
}

// How much vault markdown to inline (in bytes/chars) for non-tool providers.
const VAULT_CONTEXT_BUDGET = 80_000;
// Reserve a small context budget for an explicitly supplied local chat model.
// The default offline Ask path quotes retrieved evidence without generation.
const LOCAL_CONTEXT_BUDGET = 6_000;

// Mirrors local_llm.rs's CHAT_MODEL_MISSING — the message generate() throws
// on the Rust side for this provider. Kept in sync so the fast-fail below and
// the (unreachable in practice, but still correct) slow-fail path read the
// same to a caller.
const CHAT_MODEL_MISSING =
  "no local chat model is bundled: install and select a verified local generation model in Settings → Model";

/** Register cancellation before requesting optional external execution. Native
 *  blocked runners never spawn; future supported runners must also handle the
 *  cancel-before-spawn race and reap their entire child process tree. */
async function killableClaudeRun(
  prompt: string,
  cwd: string,
  model: string,
  effort: string,
  signal: AbortSignal,
  execution: CliExecutionRequest,
): Promise<ClaudeResult> {
  // Unique among this device's runs is enough; not crypto.randomUUID, which
  // is Safari 15.4+ like throwIfAborted above.
  const runId = `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const kill = (): void => void ipc.claudeCancel(runId);
  signal.addEventListener("abort", kill, { once: true });
  try {
    stopIfAborted(signal);
    return await ipc.claudeRunStream(
      runId, prompt, cwd, model || undefined, effort, execution,
    );
  } finally {
    signal.removeEventListener("abort", kill);
  }
}

/** Complete with the selected route and explicitly bounded native execution. */
export async function complete(args: CompleteArgs): Promise<string> {
  stopIfAborted(args.signal);
  const featureRole = args.featureRole ?? (args.task === "query" ? "ask" : args.task === "ingest" ? "compilation" : "organization");
  const usage = args.usage ?? "foreground";
  const origin = args.origin ?? args.roleSnapshot?.origin ?? Object.freeze(await ipc.agentVaultSession());
  if (origin.vaultPath !== args.cwd || !origin.openingToken) throw new Error("the active vault changed before model execution");
  const snapshot = args.roleSnapshot ?? await ipc.captureModelRole(origin, featureRole, usage);
  if (snapshot.role !== featureRole || snapshot.usage !== usage || snapshot.origin.vaultPath !== origin.vaultPath || snapshot.origin.openingToken !== origin.openingToken) {
    throw new Error("native feature grant does not match this job");
  }
  const provider = snapshot.routeSignature.providerId;
  const model = snapshot.routeSignature.modelId;
  const effort = snapshot.routeSignature.effort;

  const isCli =
    provider === "anthropic-cli" ||
    provider === "gemini-cli" ||
    provider === "codex-cli";
  let execution: CliExecutionRequest | null = null;
  if (isCli) {
    stopIfAborted(args.signal);
    if (origin.vaultPath !== args.cwd) {
      throw new Error("the active vault changed before external CLI execution");
    }
    execution = {
      capability: args.task === "ingest" ? "staged-write" : "read-only",
      origin,
    };
  }

  // Profile personalisation (Phase B, Task 6): read once per complete() call,
  // gated to task:"query" only — ingest gets its own weighting (INGEST_PROMPT's
  // `profileInterests` param) rather than a prepended paragraph, and every
  // query-task caller (interactive Ask, digests/study/audioOverview, and the
  // ingest planning call, which is also task:"query") benefits equally, unlike
  // the retrieval block below which is further gated on `onStage`.
  // Disclosed, not overlooked: the master spec frames the profile paragraph as
  // Ask/Agent-only, but `complete()` has no distinct task type for "the
  // ingest-planning call" vs. interactive Ask — both are `task:"query"`. The
  // ingest-planning call getting the full paragraph too is an accepted
  // architectural consequence of that, not a separate decision to relitigate.
  const profileCfg =
    args.task === "query"
      ? await ipc.getDistillConfig(args.cwd).catch(() => null)
      : null;
  const profile = profileCfg?.profile_injection
    ? await loadProfile(args.cwd)
    : null;
  const profileSuffix = profile
    ? `\n\nUser profile: ${injectionText(profile)}`
    : "";

  if (isCli) {
    if (!execution) throw new Error("missing native CLI execution scope");
    // CLIs accept a single prompt; flatten system+user turns.
    const system = args.messages.find((m) => m.role === "system");
    const userTurns = args.messages
      .filter((m) => m.role !== "system")
      .map((m) =>
        m.role === "assistant" ? `Assistant: ${m.content}` : m.content,
      )
      .join("\n\n");

    // Interactive Ask supplies retrieved evidence. Generators already supply
    // their context and output schema; they must not gain filesystem tools.
    let retrievalBlock = "";
    if (args.task === "query" && args.onStage) {
      const question = args.retrievalQuery ?? lastUserContent(args.messages);
      const { ctx, stems, stale, retrievalFailed } = question
        ? await semanticContext(
            question,
            VAULT_CONTEXT_BUDGET,
            args.onStage,
            args.scope,
            args.tierWeights,
            args.paths,
            args.range,
          )
        : { ctx: "", stems: [], stale: false, retrievalFailed: false };
      if (ctx.trim()) {
        retrievalBlock =
          `## Relevant wiki context (local semantic search; answer from this supplied evidence)\n\n${ctx}\n\n`;
      }
      args.onStage?.({
        kind: "thinking",
        stems,
        ...(stale ? { stale: true } : {}),
        ...(retrievalFailed ? { retrievalFailed: true } : {}),
      });
    }

    // Profile paragraph lands AFTER the retrieval block, before the user's
    // actual turns — mirrors the non-CLI branch's rule (below) that the
    // "answer ONLY from below" retrieval instruction must stay first; here
    // there is no such instruction to protect, but the ordering is kept
    // identical across both branches for one predictable contract.
    stopIfAborted(args.signal);
    const profileBlock = profileSuffix ? `${profileSuffix.trim()}\n\n` : "";
    const prompt = system
      ? `${system.content}\n\n${retrievalBlock}${profileBlock}${userTurns}`
      : `${retrievalBlock}${profileBlock}${userTurns}`;
    const res =
      provider !== "anthropic-cli"
        ? await ipc.agentRun(provider, model, prompt, args.cwd, effort, execution)
        : args.signal
          ? await killableClaudeRun(prompt, args.cwd, model, effort, args.signal, execution)
          : await ipc.claudeRun(prompt, args.cwd, model || undefined, effort, execution);
    if (res.status !== 0) {
      throw new Error(res.stderr.trim() || `${provider} exit ${res.status}`);
    }
    return res.stdout.trim();
  }

  // Non-tool provider. Ingest genuinely needs to write files into the vault,
  // which these providers cannot do — fail loudly instead of pretending.
  //
  // builtin-local is excluded: it writes the pages itself, extractively, in
  // runIngestProvider's offline branch, so an ingest for it never reaches
  // here at all. (If one ever did, the CHAT_MODEL_MISSING fast-fail below
  // still catches it — no silent pass.)
  if (args.task === "ingest" && provider !== "builtin-local") {
    throw new Error(
      `Ingest writes new pages into your vault, which needs a provider that can ` +
        `write them — Claude Code, Gemini or Codex (CLI), myco Pro, or ` +
        `Built-in (offline), which quotes and cites your source with no model ` +
        `call. The selected provider "${provider}" is text-only. Pick one of ` +
        `those for Ingest under Settings → Model, or connect one under ` +
        `Settings → Connections.`,
    );
  }

  // Read-only task (query / lint): inline the vault content so the model can
  // actually answer from it. An empty healthy search remains empty evidence.
  const isBuiltin = provider === "builtin-local";
  // No chat GGUF has shipped since Ask went extractive (see BUILTIN_MODEL's
  // doc comment) — generate() below always throws CHAT_MODEL_MISSING for this
  // provider. Failing here, before retrieval, means a doomed call skips the
  // embedding model load instead of paying for it and then throwing
  // anyway. reflectStore's scheduler triggers this task automatically a few
  // seconds after every launch, so without this check that load happened on
  // every launch too.
  if (isBuiltin) {
    if (!isBuiltinChatModel(model)) throw new Error(CHAT_MODEL_MISSING);
    const status = await ipc.localChatStatus(model);
    if (status.state !== "ready") throw new Error(status.reason ?? "local_model_preparation_required: install the selected model explicitly in Settings");
  }
  let messages = args.messages;
  // Pages retrieval chose, carried to the `thinking` stage: the model call is
  // the long wait, and "these are the notes it is answering from" is what a
  // user wants to see during it.
  let stems: string[] = [];
  // Set when the index predates a bundled embed-model swap: retrieval was
  // skipped and the whole-vault fallback used instead. Carried to the
  // `thinking` stage so the Ask UI can say "reindex needed" instead of just
  // quietly answering worse.
  let stale = false;
  // Set when an IPC call inside retrieval actually rejected (as opposed to
  // legitimately reporting an empty index or empty hit list). Carried to the
  // `thinking` stage so the failure is visible instead of looking identical
  // to "found nothing" — see semanticContext's doc comment.
  let retrievalFailed = false;
  // Audio and Study supply their selected source text. Instruction-only
  // generators such as Reflect and Lint still need retrieved vault evidence.
  const hasSuppliedSources =
    args.task === "generate" &&
    (featureRole === "audio" || featureRole === "study");
  if (!hasSuppliedSources) {
    try {
      const budget = isBuiltin ? LOCAL_CONTEXT_BUDGET : VAULT_CONTEXT_BUDGET;
      // Prefer semantic top-K retrieval (only the most relevant pages) when an
      // embedding index exists. The compatibility fallback is restricted to
      // unscoped queries without a date range and an unavailable index.
      const question = args.retrievalQuery ?? lastUserContent(args.messages);
      const retrieved = question
        ? await semanticContext(
            question,
            budget,
            args.onStage,
            args.scope,
            args.tierWeights,
            args.paths,
            args.range,
          )
        : {
            ctx: "",
            stems: [],
            stale: false,
            retrievalFailed: false,
            indexedPages: null,
          };
      stems = retrieved.stems;
      stale = retrieved.stale;
      retrievalFailed = retrieved.retrievalFailed;
      let ctx = retrieved.ctx;
      // An Ask over one note never widens to the whole vault.
      if (
        !ctx.trim() &&
        !args.paths &&
        !args.range &&
        args.scope !== "sessions" &&
        (retrieved.stale ||
          retrieved.retrievalFailed ||
          retrieved.indexedPages === null)
      ) {
        ctx = await ipc.readVaultContext(args.cwd, budget);
      }
      messages = withVaultContext(
        messages,
        ctx.trim()
          ? ctx
          : "No matching source passages were retrieved for this question and scope.",
      );
    } catch (err) {
      log.warn("complete.vault_context_failed", { error: String(err) });
      retrievalFailed = true;
      messages = withVaultContext(
        messages,
        "Source retrieval failed. Do not infer a vault answer without evidence.",
      );
    }
  }
  // Profile paragraph is appended AFTER the retrieval merge above, never
  // before — withVaultContext's "answer ONLY from the content below" line
  // must stay the first thing in the system message, or the model could read
  // the profile paragraph as itself being part of "the content below".
  if (profileSuffix) {
    messages = appendSystemSuffix(messages, profileSuffix);
  }
  // Retrieval is done; everything after this is the model. On the builtin path
  // that means a possible one-time weight load (11.7 s cold) and then prefill,
  // which is the bulk of the wait — so this is the stage a user actually sits
  // through, and the retrieved pages stay on screen underneath it.
  args.onStage?.({
    kind: "thinking",
    stems,
    ...(stale ? { stale: true } : {}),
    ...(retrievalFailed ? { retrievalFailed: true } : {}),
  });

  stopIfAborted(args.signal);

  // Compatibility path for an explicitly supplied local chat model. No chat
  // model is bundled; normal offline Ask is handled extractively upstream.
  if (isBuiltin) {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const user = messages
      .filter((m) => m.role !== "system")
      .map((m) => m.content)
      .join("\n\n");
    // Keep optional local generation bounded to a short paragraph.
    const requestId = `text-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const cancel = () => void ipc.cancelLocalSynthesis(requestId).catch(() => log.warn("text.cancel_failed"));
    args.signal?.addEventListener("abort", cancel, { once: true });
    let out: string;
    try {
      stopIfAborted(args.signal);
      out = await ipc.localQuery(system ? `${system}\n\n${user}` : user, 320, origin, snapshot, requestId);
      stopIfAborted(args.signal);
    } finally { args.signal?.removeEventListener("abort", cancel); }
    return out.trim();
  }

  // Paid HTTP provider: stop before spending if this month's estimated cost has
  // already crossed the configured threshold. CLI/builtin paths returned above
  // (they're free/local) and are never guarded.
  if (overBudget()) {
    throw new Error(
      `Monthly usage budget of $${getBudgetThreshold().toFixed(2)} reached. ` +
        `Raise the threshold in settings or wait for the next cycle before ` +
        `running more paid requests.`,
    );
  }
  const res = await ipc.chatComplete({
    provider_id: provider,
    model,
    messages,
  }, origin, snapshot);
  // Thread the token usage into the cumulative tracker (null for providers that
  // don't report it, e.g. ollama).
  if (res.usage) {
    recordUsage(model, res.usage.input_tokens, res.usage.output_tokens);
  }
  return res.content.trim();
}

/** Last user message text — the retrieval query. */
function lastUserContent(messages: SimpleMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return "";
}

/** The id a freshly built builtin-local index is tagged with — `store.model`
 * on the Rust side is `"{provider}:{model}"` (see `embeddings_status`). */
const CURRENT_BUILTIN_INDEX_ID = `builtin-local:${BUILTIN_EMBED_MODEL}`;

/** Whether an existing embedding index was built under a bundled embed model
 * that has since been swapped out (e.g. the gemma-3-1b -> bge-m3 migration) —
 * its vectors live in a different space than a fresh query embedding, so
 * the backend skips dense retrieval and keeps the independent lexical arm.
 * Distinct from "never indexed"
 * (`indexed_pages === 0`), which needs no reindex nudge. Only builtin-local
 * indexes can go stale this way (mirrors `builtin_index_is_stale` in
 * commands.rs) — an ollama-tagged index is never flagged. */
export function isIndexStale(
  status: { indexed_pages: number; model: string } | null | undefined,
): boolean {
  if (!status || status.indexed_pages === 0) return false;
  const [provider] = status.model.split(":");
  if (provider !== "builtin-local" && provider !== "") return false;
  return status.model !== CURRENT_BUILTIN_INDEX_ID;
}

/** Retrieval half of semanticContext, exported for the extractive Ask path.
 * Missing or stale dense vectors still allow verified lexical evidence.
 * `stale` means a retired dense index with no accepted lexical answer;
 * `retrievalFailed` means an IPC call rejected, never a healthy empty result.
 * `onRetrieving` fires immediately before the actual hybrid search IPC. */
export interface RetrievedChunks {
  /** Hits at or above `floor` (lexical-only hits included — see isRelevant). */
  hits: ScoredChunk[];
  /** Hits that fell under `floor`, best first — the abstention card's
   *  near-misses. Empty when nothing was rejected. */
  nearMisses: NearMiss[];
  /** The dense-cosine floor `hits` cleared. */
  floor: number;
  /** Pages in the dense index; zero does not describe lexical coverage. */
  indexedPages: number | null;
  stale: boolean;
  retrievalFailed: boolean;
}

export async function retrieveChunks(
  question: string,
  k = 12,
  onRetrieving?: () => void,
  /** Inclusive YYYY-MM-DD window (time-aware Ask) — threaded through to
   * semantic_search's dated-tier filter. */
  range?: { start: string; end: string },
  scope?: SearchScope,
  tierWeights?: TierWeights,
  /** "Ask this note": only these vault-relative pages (semantic_search's `paths`). */
  paths?: string[],
): Promise<RetrievedChunks> {
  const none: RetrievedChunks = {
    hits: [],
    nearMisses: [],
    floor: RELEVANCE_FLOOR,
    indexedPages: null,
    stale: false,
    retrievalFailed: false,
  };
  const status = await ipc.embeddingsStatus().catch(() => {
    log.warn("retrieve_chunks.embeddings_status_failed", { code: "embeddings_status_failed" });
    return null;
  });
  if (status === null) return { ...none, retrievalFailed: true };
  const staleDense = isIndexStale(status);
  const denseUnavailable = status.indexed_pages === 0 || staleDense;
  onRetrieving?.();
  let searchRejected = false;
  const res = await ipc
    .semanticSearch(
      question,
      k,
      "builtin-local",
      BUILTIN_EMBED_MODEL,
      range,
      scope,
      tierWeights,
      paths,
    )
    .catch(() => {
      log.warn("retrieve_chunks.semantic_search_failed", { code: "semantic_search_failed" });
      searchRejected = true;
      return null;
    });
  if (searchRejected || res === null) return { ...none, retrievalFailed: true };
  // A backend from before the envelope returns the bare hit list — degrade
  // to "nothing rejected server-side", never to a TypeError on `.hits`.
  const found: SemanticSearchResult = Array.isArray(res)
    ? { hits: res, floor: RELEVANCE_FLOOR, below_floor: [] }
    : res;
  // The stricter of the two floors: the backend's applied one and the
  // measured constant here. Judging and displaying use the same number.
  const floor = Math.max(found.floor, RELEVANCE_FLOOR);
  // The native hybrid path independently skips incompatible dense vectors.
  // Require exact source verification here too when the status says they
  // cannot support an answer, including replies from an older backend.
  const relevant = (hit: ScoredChunk): boolean =>
    isRelevant(hit, floor) && (!denseUnavailable || hit.exact_match === true);
  const hits = found.hits.filter(relevant);
  const rejected: NearMiss[] = found.hits
    .filter((h) => !relevant(h))
    .map((h) => ({
      page: h.page,
      tier: h.tier ?? hitTier(sourceTier(h.page)),
      score_final: h.score_final ?? h.score,
      similarity: h.similarity,
    }));
  return {
    hits,
    nearMisses: [...found.below_floor, ...rejected],
    floor,
    indexedPages: status.indexed_pages,
    stale: staleDense && hits.length === 0,
    retrievalFailed: false,
  };
}

/** Dense-cosine floor a chunk must clear to count as an answer at all.
 *
 * Measured, not guessed — and RE-measured for every embed-model swap, because
 * the floor lives in that model's cosine geometry. Current calibration
 * (`examples/abstention_probe.rs` over the bilingual eval corpus, 71 pages,
 * e5-small-ko — the 2026-08 swap):
 *
 *   queries answerable from the corpus   n=62  top-1 cosine 0.412 … 0.749 (median 0.601)
 *   off-corpus queries                   n=15  top-1 cosine 0.200 … 0.415
 *
 * Unlike bge-m3 (whose ranges left an empty 0.49–0.54 gap and put the floor at
 * 0.50), these ranges TOUCH: the weakest answerable query (RLAIF, an
 * acronym-only query at 0.412) sits just under the strongest off-corpus one
 * (postgresql tuning, 0.415). 0.42 takes the least-bad trade — 0/15 off-corpus
 * pass, 1/62 answerable rejected, and that one is exactly the acronym shape
 * the BM25 lexical arm retrieves by exact term anyway.
 *
 * Retrieval never used to reject anything — top-k always came back, so an
 * off-vault question was answered with the least-bad chunks in the vault, shown
 * with the same confidence as a real hit. Filtering here rather than in the
 * formatter means BOTH consumers benefit: the extractive answer abstains, and
 * the CLI/API path stops spending prompt tokens on the weak tail. */
export const RELEVANCE_FLOOR = 0.42;

/** A lexical-only hit has no dense cosine (`similarity: null`); it earned its
 * place through exact-term overlap, which is its own relevance evidence, so it
 * is kept rather than rejected for lacking a score. `== null` deliberately
 * covers `undefined` too: a backend that predates the field must degrade to the
 * old unfiltered behaviour, not silently reject every hit. */
function isRelevant(hit: ScoredChunk, floor: number): boolean {
  return hit.exact_match === true || (hit.similarity != null && hit.similarity >= floor);
}

/** Hybrid retrieval: rank dense and verified lexical source chunks, then
 * inline their PASSAGE TEXT (bounded by `budget`) under one
 * citeable [[stem]] header per page — not the whole page body, which is what
 * this used to re-read from disk. Chunks are already ranked by the index, so
 * later chunks of a page just append under its existing header rather than
 * repeating it. Returns "" when no accepted evidence exists. The backend
 * skips incompatible dense vectors while lexical retrieval remains available.
 * `stale` is true only when a retired dense index has no lexical answer,
 * preserving the existing reindex notice without hiding verified sources.
 *
 * `retrievalFailed` is true when `embeddings_status` or `semantic_search`
 * actually REJECTED (network/IPC error, panic, etc.) — not when they resolved
 * to a legitimately empty result (`indexed_pages === 0`, or an empty hit
 * list). Those two are normal outcomes and must never set this flag, or every
 * fresh, never-indexed vault would look like a failure. A rejection is caught
 * here (never left to blow up the caller — the whole-vault fallback must
 * still run), but it is logged and threaded back so the caller can surface it
 * instead of it being silently indistinguishable from "found nothing". */
async function semanticContext(
  question: string,
  budget: number,
  onStage?: (stage: AskStage) => void,
  scope?: AskScope,
  tierWeights?: TierWeights,
  paths?: string[],
  range?: { start: string; end: string },
): Promise<{ ctx: string; stems: string[]; stale: boolean; retrievalFailed: boolean; indexedPages: number | null }> {
  const r = await retrieveChunks(
    question,
    12,
    () => onStage?.({ kind: "retrieving" }),
    range,
    scope,
    tierWeights,
    paths,
  );
  if (r.stale || r.retrievalFailed || r.hits.length === 0) {
    return { ctx: "", stems: [], stale: r.stale, retrievalFailed: r.retrievalFailed, indexedPages: r.indexedPages };
  }
  return { ...buildRetrievalContext(r.hits, budget), stale: false, retrievalFailed: false, indexedPages: r.indexedPages };
}

// Merge the vault content into the single system message (providers like
// Anthropic and Google only honour the first system message, so we must not
// add a second one). If there is no system message, prepend one.
function withVaultContext(
  messages: SimpleMessage[],
  ctx: string,
): SimpleMessage[] {
  const block =
    `Below is the current content of the user's myco vault (markdown files). ` +
    `Answer the question using ONLY the content below. Do NOT use outside ` +
    `knowledge, and do NOT invent pages, files, facts, or events. If the answer ` +
    `is not present in the content below, reply that you could not find it in ` +
    `the wiki (in the user's language) — do not guess. Cite pages you use as ` +
    `[[vault-relative/path|page-stem]], preserving the source_path shown below. ` +
    `A dated statement is evidence for that date, not proof of the current state. ` +
    `If sources disagree, state the dates and disagreement instead of silently choosing.\n\n${ctx}`;
  const sysIdx = messages.findIndex((m) => m.role === "system");
  if (sysIdx >= 0) {
    return messages.map((m, i) =>
      i === sysIdx ? { ...m, content: `${m.content}\n\n${block}` } : m,
    );
  }
  return [{ role: "system", content: block }, ...messages];
}

// Appends `suffix` to the existing system message (or creates one, if none
// exists) — same "merge into the single system message, don't add a second"
// rule as withVaultContext, reused here for the profile paragraph so it lands
// after whatever withVaultContext already merged in.
function appendSystemSuffix(
  messages: SimpleMessage[],
  suffix: string,
): SimpleMessage[] {
  const sysIdx = messages.findIndex((m) => m.role === "system");
  if (sysIdx >= 0) {
    return messages.map((m, i) =>
      i === sysIdx ? { ...m, content: `${m.content}${suffix}` } : m,
    );
  }
  return [{ role: "system", content: suffix.trim() }, ...messages];
}

export async function getActiveModel(task: "query" | "ingest" | "generate" | RoleId): Promise<{ provider: string; model: string; effort: string }> {
  return roleFor(task, await ipc.getSettings());
}

/** Capability is separate from artifact readiness; extractive models do not generate. */
export function canGenerate(provider: string, model?: string): boolean {
  return provider === "builtin-local" ? !!model && isBuiltinChatModel(model) : provider !== "";
}

/** Native feature selections only; legacy display values never grant external use. */
export function roleFor(task: "query" | "ingest" | "generate" | RoleId, settings: MycoSettings): { provider: string; model: string; effort: string } {
  const role = task === "query" ? "ask" : task === "ingest" ? "compilation" : task === "generate" ? "organization" : task;
  const selected = effectiveRole(settings, role);
  return { provider: selected.providerId, model: selected.modelId, effort: selected.effort };
}
