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

import { ipc } from "./ipc";

export interface SimpleMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompleteArgs {
  task: "query" | "ingest";
  messages: SimpleMessage[];
  cwd: string;
}

// Providers that expose Read/Write/Grep/Glob tools with the vault as cwd.
const TOOL_CAPABLE_PROVIDERS = new Set(["anthropic-cli"]);

// How much vault markdown to inline (in bytes/chars) for non-tool providers.
const VAULT_CONTEXT_BUDGET = 80_000;

/** Whether the given provider can read/write vault files via tools. */
export function providerSupportsVaultTools(provider: string): boolean {
  return TOOL_CAPABLE_PROVIDERS.has(provider);
}

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
  let messages = args.messages;
  try {
    const ctx = await ipc.readVaultContext(args.cwd, VAULT_CONTEXT_BUDGET);
    if (ctx.trim()) {
      messages = withVaultContext(messages, ctx);
    }
  } catch {
    /* proceed without inlined context rather than blocking the request */
  }

  const res = await ipc.chatComplete({
    provider_id: provider,
    model,
    messages,
  });
  return res.content.trim();
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
    `Answer using only this content and cite pages as [[page-stem]]; if the ` +
    `answer is not in the vault, say so.\n\n${ctx}`;
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
