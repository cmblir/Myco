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

import { ipc, type ScoredChunk } from "./ipc";
import { BUILTIN_EMBED_MODEL } from "./providers";
import { getBudgetThreshold, overBudget, recordUsage } from "./budget";

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
  | { kind: "thinking"; stems: string[]; stale?: boolean };

export interface CompleteArgs {
  task: "query" | "ingest";
  messages: SimpleMessage[];
  cwd: string;
  /// Called as the run moves between stages. Only the non-tool provider path
  /// reports: the CLI providers do their own retrieval inside the tool loop, so
  /// this side cannot see what they read and must not invent it.
  onStage?: (stage: AskStage) => void;
}

// How much vault markdown to inline (in bytes/chars) for non-tool providers.
const VAULT_CONTEXT_BUDGET = 80_000;
// The embedded 0.5B model only has a 4k-token window — keep its inline slice
// small so the question (at the end) always survives backend truncation.
const LOCAL_CONTEXT_BUDGET = 6_000;

/** Whether the given provider can read/write vault files via tools. */
export async function complete(args: CompleteArgs): Promise<string> {
  const settings = await ipc.getSettings();
  const provider =
    args.task === "query" ? settings.query_provider : settings.ingest_provider;
  const model =
    args.task === "query" ? settings.query_model : settings.ingest_model;

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
    const prompt = system ? `${system.content}\n\n${userTurns}` : userTurns;
    const res =
      provider === "anthropic-cli"
        ? await ipc.claudeRun(prompt, args.cwd, model || undefined)
        : await ipc.agentRun(provider, model, prompt, args.cwd);
    if (res.status !== 0) {
      throw new Error(res.stderr.trim() || `${provider} exit ${res.status}`);
    }
    return res.stdout.trim();
  }

  // Non-tool provider. Ingest genuinely needs to write files into the vault,
  // which these providers cannot do — fail loudly instead of pretending.
  if (args.task === "ingest") {
    throw new Error(
      `Ingest writes new pages into your vault, which only Claude Code (CLI) can do. ` +
        `The selected provider "${provider}" has no file access. Choose Claude Code (CLI) ` +
        `for Ingest under Settings → Model, or connect it under Settings → Connections.`,
    );
  }

  // Read-only task (query / lint): inline the vault content so the model can
  // actually answer from it. If reading fails, fall back to the bare prompt.
  // The embedded model has a 4k-token context window, so its budget is far
  // smaller than the cloud providers' (excess is truncated backend-side too).
  const isBuiltin = provider === "builtin-local";
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
  try {
    const budget = isBuiltin ? LOCAL_CONTEXT_BUDGET : VAULT_CONTEXT_BUDGET;
    // Prefer semantic top-K retrieval (only the most relevant pages) when an
    // embedding index exists — far better than dumping the whole vault, and the
    // only thing that fits the builtin model's tiny window. Fall back to the
    // whole-vault concat when the index is empty, stale, or retrieval fails.
    const question = lastUserContent(args.messages);
    const retrieved = question
      ? await semanticContext(question, budget, args.onStage)
      : { ctx: "", stems: [], stale: false };
    stems = retrieved.stems;
    stale = retrieved.stale;
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
  // Retrieval is done; everything after this is the model. On the builtin path
  // that means a possible one-time weight load (11.7 s cold) and then prefill,
  // which is the bulk of the wait — so this is the stage a user actually sits
  // through, and the retrieved pages stay on screen underneath it.
  args.onStage?.({ kind: "thinking", stems, ...(stale ? { stale: true } : {}) });

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

/** Semantic retrieval: embed the question, pull the top-matching chunks from the
 * embedding index, and inline their PASSAGE TEXT (bounded by `budget`) under one
 * citeable [[stem]] header per page — not the whole page body, which is what
 * this used to re-read from disk. Chunks are already ranked by the index, so
 * later chunks of a page just append under its existing header rather than
 * repeating it. Returns "" when no index exists so the caller can fall back
 * to the whole-vault concat. `stale` is true when the index predates a bundled
 * embed-model swap — retrieval is skipped entirely rather than cosining across
 * incompatible vector spaces, and the caller must surface this, not just fall
 * back silently. */
async function semanticContext(
  question: string,
  budget: number,
  onStage?: (stage: AskStage) => void,
): Promise<{ ctx: string; stems: string[]; stale: boolean }> {
  const none = { ctx: "", stems: [], stale: false };
  const status = await ipc.embeddingsStatus().catch(() => null);
  if (!status || status.indexed_pages === 0) return none;
  if (isIndexStale(status)) {
    return { ctx: "", stems: [], stale: true };
  }
  onStage?.({ kind: "retrieving" });
  const hits = await ipc
    .semanticSearch(question, 12, "builtin-local", BUILTIN_EMBED_MODEL)
    .catch(() => [] as ScoredChunk[]);
  if (hits.length === 0) return none;
  const parts: string[] = [];
  const stems: string[] = [];
  let used = 0;
  let lastPage = "";
  for (const h of hits) {
    if (!h.text) continue;
    // One citeable header per page; later chunks of the same page just
    // append under it instead of repeating the citation.
    const header = h.page !== lastPage ? `===== [[${h.stem}]] =====\n` : "\n";
    const block = `${header}${h.text}`;
    if (used + block.length > budget && parts.length > 0) break;
    parts.push(block);
    used += block.length;
    if (h.page !== lastPage) stems.push(h.stem);
    lastPage = h.page;
  }
  // Only the pages that made the budget: the ones past it are never shown to
  // the model, so naming them would be another fiction.
  return { ctx: parts.join("\n\n"), stems, stale: false };
}

// Merge the vault content into the single system message (providers like
// Anthropic and Google only honour the first system message, so we must not
// add a second one). If there is no system message, prepend one.
function withVaultContext(
  messages: SimpleMessage[],
  ctx: string,
): SimpleMessage[] {
  const block =
    `Below is the current content of the user's Memex vault (markdown files). ` +
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

export async function getActiveModel(task: "query" | "ingest"): Promise<{
  provider: string;
  model: string;
}> {
  const s = await ipc.getSettings();
  return task === "query"
    ? { provider: s.query_provider, model: s.query_model }
    : { provider: s.ingest_provider, model: s.ingest_model };
}
