// In-app agent loop (Feature 4, HTTP-provider path). Drives a tool-calling
// model through: agent_chat → parse tool_use → dispatch each tool (with a
// per-call confirmation gate for vault writes) → feed tool_result → repeat,
// until the model returns a final answer or a hard iteration/budget cap is hit.
//
// CLI providers (anthropic-cli/gemini-cli/codex-cli) tool-loop internally and
// do NOT come through here — see agentStore for the provider split. The bundled
// builtin-local model is too weak for reliable multi-step tool use and is
// rejected before a run starts.

import { ipc } from "./ipc";
import type {
  AgentMessage,
  AgentToolCall,
  AgentToolDescriptor,
} from "./ipc";
import { overBudget, recordUsage, getBudgetThreshold } from "./budget";

export interface AgentStep {
  kind: "tool";
  tool: string;
  args: Record<string, unknown>;
  /** A short summary of the tool result (or the raw error). */
  result?: string;
  error?: string;
  /** For write tools: whether the user confirmed the call. */
  confirmed?: boolean;
}

export interface AgentRunResult {
  answer: string;
  steps: AgentStep[];
  /** True when the run halted on the iteration/budget cap with a partial answer. */
  stoppedAtLimit: boolean;
}

export interface AgentRunOpts {
  provider: string;
  model: string;
  system: string;
  question: string;
  /** Prior transcript turns (for multi-turn agent chats). */
  history?: AgentMessage[];
  tools: AgentToolDescriptor[];
  /** Hard cap on model round-trips (default 8). */
  maxIterations?: number;
  /** Whether write tools are offered at all this run. */
  allowWrite: boolean;
  /** Ask the user to confirm a specific write call; false ⇒ skip it. */
  confirmWrite?: (call: AgentToolCall) => Promise<boolean>;
  onStep?: (step: AgentStep) => void;
  signal?: AbortSignal;
}

const DEFAULT_MAX_ITERATIONS = 8;

/** Truncate a tool result to a short, model-and-UI-friendly summary. */
function summarize(value: unknown, max = 600): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export async function runAgent(opts: AgentRunOpts): Promise<AgentRunResult> {
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  // Offer write tools only when write mode is on; the Rust side re-checks the
  // allow_write flag and refuses raw/ regardless.
  const tools = opts.allowWrite
    ? opts.tools
    : opts.tools.filter((t) => !t.write);
  const writeNames = new Set(tools.filter((t) => t.write).map((t) => t.name));

  const messages: AgentMessage[] = [
    ...(opts.history ?? []),
    { role: "user", content: opts.question },
  ];
  const steps: AgentStep[] = [];

  for (let iter = 0; iter < maxIterations; iter++) {
    if (opts.signal?.aborted) {
      return { answer: lastText(messages), steps, stoppedAtLimit: true };
    }
    // Paid HTTP providers only reach this loop; stop before spending if the
    // monthly budget is already crossed (mirrors chat.ts).
    if (overBudget()) {
      throw new Error(
        `Monthly usage budget of $${getBudgetThreshold().toFixed(2)} reached. ` +
          `Raise the threshold in settings or wait for the next cycle.`,
      );
    }

    const turn = await ipc.agentChat({
      provider_id: opts.provider,
      model: opts.model,
      system: opts.system,
      messages,
      tools,
    });
    if (turn.usage) {
      recordUsage(opts.model, turn.usage.input_tokens, turn.usage.output_tokens);
    }

    if (!turn.tool_calls || turn.tool_calls.length === 0) {
      return { answer: turn.text, steps, stoppedAtLimit: false };
    }

    // Record the assistant's tool-call turn so the follow-up tool_results
    // reference valid ids.
    messages.push({
      role: "assistant",
      content: turn.text || undefined,
      tool_calls: turn.tool_calls,
    });

    for (const call of turn.tool_calls) {
      if (opts.signal?.aborted) {
        return { answer: turn.text, steps, stoppedAtLimit: true };
      }
      const isWrite = writeNames.has(call.name);
      const step: AgentStep = { kind: "tool", tool: call.name, args: call.input };

      // Write tools need explicit per-call confirmation.
      if (isWrite) {
        const confirmed = opts.confirmWrite
          ? await opts.confirmWrite(call)
          : false;
        step.confirmed = confirmed;
        if (!confirmed) {
          step.result = "declined by user";
          steps.push(step);
          opts.onStep?.(step);
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: "The user declined this write. Do not retry it; continue.",
          });
          continue;
        }
      }

      try {
        const result = await ipc.agentToolCall(call.name, call.input, isWrite);
        step.result = summarize(result);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: typeof result === "string" ? result : JSON.stringify(result),
        });
      } catch (err) {
        // Feed the error back so the model can recover instead of crashing.
        step.error = String(err);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: `ERROR: ${String(err)}`,
        });
      }
      steps.push(step);
      opts.onStep?.(step);
    }
  }

  // Hit the iteration cap: ask once more for a final answer without tools so the
  // user gets a partial conclusion rather than an empty result.
  try {
    const final = await ipc.agentChat({
      provider_id: opts.provider,
      model: opts.model,
      system:
        opts.system +
        "\n\nYou have reached the tool-use limit. Give your best final answer now using what you have gathered.",
      messages,
      tools: [],
    });
    if (final.usage) {
      recordUsage(opts.model, final.usage.input_tokens, final.usage.output_tokens);
    }
    return { answer: final.text, steps, stoppedAtLimit: true };
  } catch {
    return { answer: lastText(messages), steps, stoppedAtLimit: true };
  }
}

/** Best-effort last assistant/user text, for abort/failure fallbacks. */
function lastText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i].content;
    if (c) return c;
  }
  return "";
}
