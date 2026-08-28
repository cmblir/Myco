// Unified chat entry-point. Reads the selected provider/model from settings
// and dispatches to either the Claude CLI (anthropic-cli) or the HTTP
// provider stack. Returns the assistant's text content.
//
// Only the Claude CLI provider can read/write vault files via tools. The HTTP
// providers are pure chat with no filesystem access, so:
//   - ingest (must WRITE wiki pages) requires a tool-capable provider.
//   - query / lint (read-only) work with any provider — for non-tool
//     providers we inline the vault content so the model has real context
//     instead of answering blind.

import { ipc, type MycoSettings, type ScoredChunk } from "./ipc";
import { BUILTIN_EMBED_MODEL } from "./providers";
import { getBudgetThreshold, overBudget, recordUsage } from "./budget";
import { log } from "./log";
import { loadProfile, injectionText } from "./profile";

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
  /**
   * Which settings role picks the provider.
   *
   * - `"query"` — interactive Ask. Honours the query role exactly, including
   *   `builtin-local`, because answering extractively from the notes is a
   *   deliberate choice there, not a degraded state.
   * - `"ingest"` — the ingest role, as before.
   * - `"generate"` — everything that must WRITE new prose (audio overview,
   *   digests, maps, study cards, reflect, lint, the ingest planner). These
   *   used to ride the query role and so died with `CHAT_MODEL_MISSING` the
   *   moment Ask was set to extractive: the owner's audio overview stopped
   *   working while a perfectly good ingest provider sat connected. Now they
   *   take the query role when it can generate and fall back to the ingest
   *   role when it cannot.
   */
  task: "query" | "ingest" | "generate";
  messages: SimpleMessage[];
  cwd: string;
  /// Called as the run moves between stages. The non-tool provider path always
  /// reports these. The CLI query path now reports too, but only when this is
  /// passed — that's how interactive Ask (the only caller of task:"query" that
  /// passes it) opts in, and how study.ts/digests.ts/audioOverview.ts (which
  /// don't) opt out of both the stage reports and the CLI retrieval injection
  /// below. The CLI's own Read/Grep inside its tool loop stays invisible to
  /// this side regardless, and must not be invented.
  onStage?: (stage: AskStage) => void;
}

// How much vault markdown to inline (in bytes/chars) for non-tool providers.
const VAULT_CONTEXT_BUDGET = 80_000;
// The embedded 0.5B model only has a 4k-token window — keep its inline slice
// small so the question (at the end) always survives backend truncation.
const LOCAL_CONTEXT_BUDGET = 6_000;

// Mirrors local_llm.rs's CHAT_MODEL_MISSING — the message generate() throws
// on the Rust side for this provider. Kept in sync so the fast-fail below and
// the (unreachable in practice, but still correct) slow-fail path read the
// same to a caller.
const CHAT_MODEL_MISSING =
  "no local chat model is bundled: Ask answers extractively from your notes; " +
  "classification and generation need a connected provider (Settings → Model)";

/** Whether the given provider can read/write vault files via tools. */
export async function complete(args: CompleteArgs): Promise<string> {
  const settings = await ipc.getSettings();
  const role = roleFor(args.task, settings);
  const provider = role.provider;
  const model = role.model;
  // Reasoning effort for this role — only the CLI branch below can use it.
  const effort = role.effort;

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

  const isCli =
    provider === "anthropic-cli" ||
    provider === "gemini-cli" ||
    provider === "codex-cli";
  if (isCli) {
    // CLIs accept a single prompt; flatten system+user turns.
    const system = args.messages.find((m) => m.role === "system");
    const userTurns = args.messages
      .filter((m) => m.role !== "system")
      .map((m) =>
        m.role === "assistant" ? `Assistant: ${m.content}` : m.content,
      )
      .join("\n\n");

    // Query only (not ingest): the CLI would otherwise grep the vault cwd
    // blind. Give it the same bge-m3 semantic retrieval the non-CLI path
    // uses, at the CLI models' much larger budget — a head start, not a
    // replacement for its own Read/Grep, so an empty index/no-hits result
    // injects nothing and the CLI falls back to grepping as before.
    //
    // Also gated on `onStage`: task:"query" + one `query_provider` setting is
    // shared by FOUR features — interactive Ask (which passes `onStage`), and
    // study.ts (flashcard/quiz), digests.ts, and audioOverview.ts (which don't).
    // Those three demand strict-JSON-only output with no UI to show a stage
    // to, so injecting a retrieval block — plus its "use Read/Grep for
    // anything more" prose hint — risked malformed-JSON failures for them with
    // no signal. `onStage` is only ever passed by interactive Ask, so it
    // doubles as the discriminator for "this is the path that wants retrieval."
    let retrievalBlock = "";
    if (args.task === "query" && args.onStage) {
      const question = lastUserContent(args.messages);
      const { ctx, stems, stale, retrievalFailed } = question
        ? await semanticContext(question, VAULT_CONTEXT_BUDGET, args.onStage)
        : { ctx: "", stems: [], stale: false, retrievalFailed: false };
      if (ctx.trim()) {
        retrievalBlock =
          `## Relevant wiki context (local semantic search — start here; use Read/Grep for anything more)\n\n${ctx}\n\n`;
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
    const profileBlock = profileSuffix ? `${profileSuffix.trim()}\n\n` : "";
    const prompt = system
      ? `${system.content}\n\n${retrievalBlock}${profileBlock}${userTurns}`
      : `${retrievalBlock}${profileBlock}${userTurns}`;
    const res =
      provider === "anthropic-cli"
        ? await ipc.claudeRun(prompt, args.cwd, model || undefined, effort)
        : await ipc.agentRun(provider, model, prompt, args.cwd, effort);
    if (res.status !== 0) {
      throw new Error(res.stderr.trim() || `${provider} exit ${res.status}`);
    }
    return res.stdout.trim();
  }

  // Non-tool provider. Ingest genuinely needs to write files into the vault,
  // which these providers cannot do — fail loudly instead of pretending.
  if (args.task === "ingest") {
    throw new Error(
      `Ingest writes new pages into your vault, which needs a provider with file ` +
        `access — Claude Code, Gemini or Codex (CLI), or myco Pro. The selected ` +
        `provider "${provider}" is text-only. Pick one of those for Ingest under ` +
        `Settings → Model, or connect one under Settings → Connections.`,
    );
  }

  // Read-only task (query / lint): inline the vault content so the model can
  // actually answer from it. If reading fails, fall back to the bare prompt.
  // The embedded model has a 4k-token context window, so its budget is far
  // smaller than the cloud providers' (excess is truncated backend-side too).
  const isBuiltin = provider === "builtin-local";
  // No chat GGUF has shipped since Ask went extractive (see BUILTIN_MODEL's
  // doc comment) — generate() below always throws CHAT_MODEL_MISSING for this
  // provider. Failing here, before retrieval, means a doomed call skips the
  // ~418 MB embed-model load instead of paying for it and then throwing
  // anyway. reflectStore's scheduler triggers this task automatically a few
  // seconds after every launch, so without this check that load happened on
  // every launch too.
  if (isBuiltin && !(await ipc.localChatModelAvailable())) {
    throw new Error(CHAT_MODEL_MISSING);
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
  try {
    const budget = isBuiltin ? LOCAL_CONTEXT_BUDGET : VAULT_CONTEXT_BUDGET;
    // Prefer semantic top-K retrieval (only the most relevant pages) when an
    // embedding index exists — far better than dumping the whole vault, and the
    // only thing that fits the builtin model's tiny window. Fall back to the
    // whole-vault concat when the index is empty, stale, or retrieval fails.
    const question = lastUserContent(args.messages);
    const retrieved = question
      ? await semanticContext(question, budget, args.onStage)
      : { ctx: "", stems: [], stale: false, retrievalFailed: false };
    stems = retrieved.stems;
    stale = retrieved.stale;
    retrievalFailed = retrieved.retrievalFailed;
    let ctx = retrieved.ctx;
    if (!ctx.trim()) {
      ctx = await ipc.readVaultContext(args.cwd, budget);
    }
    if (ctx.trim()) {
      messages = withVaultContext(messages, ctx);
    }
  } catch {
    /* proceed without inlined context rather than blocking the request */
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

  // Embedded model (bundled Gemma 3 1B): in-process, offline, no key. The
  // backend applies the model's own chat template, so pass plain content —
  // no "User:/Assistant:" role markers (they made the base LM continue the
  // transcript with fake turns). Light tasks only; ingest is rejected above.
  if (isBuiltin) {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const user = messages
      .filter((m) => m.role !== "system")
      .map((m) => m.content)
      .join("\n\n");
    // 320 tokens ≈ a short paragraph — less runway for a 0.5B model to ramble.
    const out = await ipc.localQuery(system ? `${system}\n\n${user}` : user, 320);
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
  });
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
 * search would silently return nothing. Distinct from "never indexed"
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
 * Same semantics: `stale` = index predates a bundled embed-model swap (search
 * skipped); `retrievalFailed` = an IPC call REJECTED (logged, caught) — never
 * set for a legitimately empty index or empty hit list. `onRetrieving` fires
 * just before the search IPC, matching the old stage-event timing. */
export interface RetrievedChunks {
  hits: ScoredChunk[];
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
): Promise<RetrievedChunks> {
  const none: RetrievedChunks = { hits: [], stale: false, retrievalFailed: false };
  const status = await ipc.embeddingsStatus().catch((err) => {
    log.warn("retrieve_chunks.embeddings_status_failed", { error: String(err) });
    return null;
  });
  if (status === null) return { ...none, retrievalFailed: true };
  if (status.indexed_pages === 0) return none;
  if (isIndexStale(status)) return { ...none, stale: true };
  onRetrieving?.();
  let searchRejected = false;
  const hits = await ipc
    .semanticSearch(question, k, "builtin-local", BUILTIN_EMBED_MODEL, range)
    .catch((err) => {
      log.warn("retrieve_chunks.semantic_search_failed", { error: String(err) });
      searchRejected = true;
      return [] as ScoredChunk[];
    });
  if (searchRejected) return { ...none, retrievalFailed: true };
  return { hits: hits.filter(isRelevant), stale: false, retrievalFailed: false };
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
function isRelevant(hit: ScoredChunk): boolean {
  return hit.similarity == null || hit.similarity >= RELEVANCE_FLOOR;
}

/** Semantic retrieval: embed the question, pull the top-matching chunks from the
 * embedding index, and inline their PASSAGE TEXT (bounded by `budget`) under one
 * citeable [[stem]] header per page — not the whole page body, which is what
 * this used to re-read from disk. Chunks are already ranked by the index, so
 * later chunks of a page just append under its existing header rather than
 * repeating it. Returns "" when no index exists so the caller can fall back
 * to the whole-vault concat. `stale` is true when the index predates a bundled
 * embed-model swap — retrieval is skipped entirely rather than cosining across
 * incompatible vector spaces, and the caller must surface this, not just fall
 * back silently.
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
): Promise<{ ctx: string; stems: string[]; stale: boolean; retrievalFailed: boolean }> {
  const r = await retrieveChunks(question, 12, () => onStage?.({ kind: "retrieving" }));
  if (r.stale || r.retrievalFailed || r.hits.length === 0) {
    return { ctx: "", stems: [], stale: r.stale, retrievalFailed: r.retrievalFailed };
  }
  // Maps-first (Phase B, Task 6): a wiki/maps/ page summarizes its whole
  // cluster, so front-load its block(s) within the same budget — the model
  // sees the topic map before it drills into individual pages' details.
  // Stable partition: relative order within each group is preserved, and
  // `r.hits` itself (scores, ranking, which hits made the top-k cut) is
  // untouched — this only reorders which blocks get assembled first.
  const ordered = [
    ...r.hits.filter((h) => h.page.startsWith("wiki/maps/")),
    ...r.hits.filter((h) => !h.page.startsWith("wiki/maps/")),
  ];
  const parts: string[] = [];
  const stems: string[] = [];
  let used = 0;
  let lastPage = "";
  for (const h of ordered) {
    if (!h.text) continue;
    // One citeable header per page; later chunks of the same page just
    // append under it instead of repeating the citation.
    const header = h.page !== lastPage ? `===== [[${h.stem}]] =====\n` : "\n";
    const block = `${header}${h.text}`;
    if (used + block.length > budget && parts.length > 0) break;
    parts.push(block);
    used += block.length;
    if (h.page !== lastPage && !stems.includes(h.stem)) stems.push(h.stem);
    lastPage = h.page;
  }
  // Only the pages that made the budget: the ones past it are never shown to
  // the model, so naming them would be another fiction.
  return { ctx: parts.join("\n\n"), stems, stale: false, retrievalFailed: false };
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
    `[[page-stem]].\n\n${ctx}`;
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

export async function getActiveModel(
  task: "query" | "ingest" | "generate",
): Promise<{
  provider: string;
  model: string;
  effort: string;
}> {
  return roleFor(task, await ipc.getSettings());
}

/** The only provider that cannot write prose: it ships an embedder, no chat
 *  weights. Everything else — CLI bridges, API providers, Ollama — can. */
export function canGenerate(provider: string): boolean {
  return provider !== "builtin-local" && provider !== "";
}

/**
 * Settings role → provider/model/effort. Pure, so the fallback rule is
 * testable without a backend.
 *
 * `generate` prefers the query role (a user who pointed Ask at Claude wants
 * their overviews from Claude too) and falls back to the ingest role when the
 * query role is the extractive built-in. If NEITHER can generate it returns
 * the query role unchanged — `complete()` then fails with the same
 * CHAT_MODEL_MISSING it always did, which is the honest answer when no
 * generation provider is connected anywhere.
 */
export function roleFor(
  task: "query" | "ingest" | "generate",
  s: MycoSettings,
): { provider: string; model: string; effort: string } {
  const query = {
    provider: s.query_provider,
    model: s.query_model,
    effort: s.query_effort,
  };
  const ingest = {
    provider: s.ingest_provider,
    model: s.ingest_model,
    effort: s.ingest_effort,
  };
  if (task === "ingest") return ingest;
  if (task === "query") return query;
  if (canGenerate(query.provider)) return query;
  return canGenerate(ingest.provider) ? ingest : query;
}
