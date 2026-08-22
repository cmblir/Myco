// Agent run store (Feature 4). Owns the live state of an in-app agent run: the
// streaming step trace, final answer, and cancellation. Drives the HTTP-provider
// tool loop (agentLoop.runAgent); write tools are confirmed through the shared
// dialog. CLI/Google/Ollama/builtin providers are not tool-looped in-app yet, so
// agent mode is gated to the tool-capable HTTP providers.

import { create } from "zustand";
import { createElement } from "react";
import { runAgent, type AgentStep } from "../lib/agentLoop";
import { confirmAction } from "./dialogStore";
import { buildWritePreview } from "../lib/agentDiff";
import DiffView from "../components/DiffView";
import { ipc, type AgentToolCall, type AgentToolDescriptor } from "../lib/ipc";
import type { Strings } from "../lib/i18n";

/** HTTP providers whose API supports the tool-calling loop (see providers.rs). */
export const AGENT_PROVIDERS = new Set([
  "anthropic-api",
  "openai-api",
  "openrouter",
]);

export function agentSupported(provider: string): boolean {
  return AGENT_PROVIDERS.has(provider);
}

export const DEFAULT_AGENT_PROMPT =
  "You are myco's in-app research agent for the user's local markdown wiki. " +
  "Plan and use the provided tools to gather evidence from the vault before " +
  "answering: search, read pages, and traverse links. Cite the pages you rely " +
  "on inline as [[page-stem]]. If you cannot find something, say so rather than " +
  "guessing. Keep tool use focused — a handful of calls, not dozens.";

/** Localized copy the write-confirm dialog bakes in. Passed per run from the
 * panel's `t` so the store itself stays i18n-free (mirrors queryStore.askCopy). */
export interface AgentCopy {
  confirmTitle: string;
  confirmCreateTitle: string;
  confirmHint: string;
  diffTooLarge: string;
}

/** The AgentCopy every caller of `start()` passes, in one place. */
export function agentCopy(t: Strings): AgentCopy {
  return {
    confirmTitle: t.agent_confirm_title,
    confirmCreateTitle: t.agent_confirm_create_title,
    confirmHint: t.agent_confirm_hint,
    diffTooLarge: t.history_diff_too_large,
  };
}

export interface AgentStartOpts {
  provider: string;
  model: string;
  vaultPath: string;
  question: string;
  /** System prompt (a task-agent preset's, or DEFAULT_AGENT_PROMPT). */
  systemPrompt?: string;
  /** Offer write tools (still confirmed per call). */
  allowWrite: boolean;
  copy: AgentCopy;
}

export interface AgentState {
  running: boolean;
  question: string;
  steps: AgentStep[];
  answer: string;
  error: string | null;
  stoppedAtLimit: boolean;
  /** Cached tool schemas (fetched once). */
  tools: AgentToolDescriptor[];
  start: (opts: AgentStartOpts) => Promise<void>;
  cancel: () => void;
  reset: () => void;
}

let abortController: AbortController | null = null;

export const useAgentStore = create<AgentState>((set, get) => ({
  running: false,
  question: "",
  steps: [],
  answer: "",
  error: null,
  stoppedAtLimit: false,
  tools: [],

  async start(opts) {
    if (get().running) return;
    if (!agentSupported(opts.provider)) {
      set({
        error:
          `Agent mode needs a tool-capable provider (Anthropic API or an ` +
          `OpenAI-compatible provider). "${opts.provider}" isn't supported — ` +
          `switch it under Settings → Model.`,
        answer: "",
        steps: [],
        question: opts.question,
      });
      return;
    }

    // Fetch the tool schemas once and cache them.
    let tools = get().tools;
    if (tools.length === 0) {
      tools = await ipc.agentToolsSchema().catch(() => []);
      set({ tools });
    }

    abortController = new AbortController();
    set({
      running: true,
      question: opts.question,
      steps: [],
      answer: "",
      error: null,
      stoppedAtLimit: false,
    });

    try {
      const result = await runAgent({
        provider: opts.provider,
        model: opts.model,
        system: opts.systemPrompt || DEFAULT_AGENT_PROMPT,
        question: opts.question,
        tools,
        allowWrite: opts.allowWrite,
        signal: abortController.signal,
        confirmWrite: async (call: AgentToolCall) => {
          const path = String(call.input.path ?? "");
          const next = String(call.input.content ?? "");
          // Current on-disk content; missing/unreadable ⇒ treated as a create.
          const current = await ipc
            .readFile(`${opts.vaultPath}/${path}`)
            .then((f) => f.raw)
            .catch(() => null);
          const preview = buildWritePreview(path, current, next);
          return confirmAction({
            title:
              preview.kind === "create"
                ? opts.copy.confirmCreateTitle
                : opts.copy.confirmTitle,
            message: path,
            body: createElement(
              "div",
              null,
              preview.truncated
                ? createElement(
                    "p",
                    { className: "muted", style: { fontSize: 12.5 } },
                    opts.copy.diffTooLarge,
                  )
                : createElement(DiffView, { lines: preview.lines }),
              createElement(
                "p",
                { className: "muted", style: { fontSize: 12.5, marginTop: 8 } },
                opts.copy.confirmHint,
              ),
            ),
            danger: true,
          });
        },
        onStep: (step) => set((s) => ({ steps: [...s.steps, step] })),
      });
      set({
        answer: result.answer,
        stoppedAtLimit: result.stoppedAtLimit,
        running: false,
      });
    } catch (err) {
      set({ error: String(err), running: false });
    } finally {
      abortController = null;
    }
  },

  cancel() {
    abortController?.abort();
    set({ running: false });
  },

  reset() {
    set({
      running: false,
      question: "",
      steps: [],
      answer: "",
      error: null,
      stoppedAtLimit: false,
    });
  },
}));
