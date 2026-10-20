// Agent run store (Feature 4). Owns the live state of an in-app agent run: the
// streaming step trace, final answer, and cancellation. Drives the HTTP-provider
// tool loop (agentLoop.runAgent); write tools are confirmed through the shared
// dialog. CLI/Google/Ollama/builtin providers are not tool-looped in-app yet, so
// agent mode is gated to the tool-capable HTTP providers.

import { create } from "zustand";
import { createElement } from "react";
import { runAgent, type AgentStep } from "../lib/agentLoop";
import { confirmAction, useDialogStore } from "./dialogStore";
import { buildWritePreview } from "../lib/agentDiff";
import DiffView from "../components/DiffView";
import { ipc, type AgentToolCall, type AgentToolDescriptor } from "../lib/ipc";
import type { Strings } from "../lib/i18n";
import { useVaultStore } from "./vaultStore";

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
    const { currentVault, vaultToken, isOpeningVault } = useVaultStore.getState();
    if (!currentVault || isOpeningVault || currentVault.path !== opts.vaultPath) return;
    const controller = new AbortController();
    abortController = controller;
    const isCurrent = () => {
      const state = useVaultStore.getState();
      return abortController === controller && !controller.signal.aborted && !state.isOpeningVault &&
        state.currentVault?.path === currentVault.path && state.vaultToken === vaultToken;
    };
    // Own the run before the first await, including schema loading.
    set({
      running: true,
      question: opts.question,
      steps: [],
      answer: "",
      error: null,
      stoppedAtLimit: false,
    });

    try {
      const origin = Object.freeze(await ipc.agentVaultSession());
      if (!isCurrent()) return;
      if (origin.vaultPath !== currentVault.path) {
        throw new Error("the active vault changed before the agent started");
      }
      const roleSnapshot = await ipc.captureModelRole(origin, "agent", "foreground");
      const { providerId: provider, modelId: model } = roleSnapshot.routeSignature;
      if (!agentSupported(provider)) throw new Error("Selected Agent model has no verified tool runner; choose a supported optional route explicitly in Settings");
      // Fetch the tool schemas once and cache them.
      let tools = get().tools;
      if (tools.length === 0) {
        tools = await ipc.agentToolsSchema();
        if (!isCurrent()) return;
        set({ tools });
      }
      const result = await runAgent({
        provider,
        model,
        roleSnapshot,
        system: opts.systemPrompt || DEFAULT_AGENT_PROMPT,
        question: opts.question,
        origin,
        tools,
        allowWrite: opts.allowWrite,
        signal: controller.signal,
        isCurrent,
        confirmWrite: async (call: AgentToolCall) => {
          if (!isCurrent()) return false;
          const path = String(call.input.path ?? "");
          const next = String(call.input.content ?? "");
          // Current on-disk content; missing/unreadable ⇒ treated as a create.
          const current = await ipc
            .readFile(`${origin.vaultPath}/${path}`)
            .then((f) => f.raw)
            .catch(() => null);
          if (!isCurrent()) return false;
          const preview = buildWritePreview(path, current, next);
          const confirmation = confirmAction({
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
          const request = useDialogStore.getState().request;
          const closeOwnConfirmation = () => {
            if (!request) return;
            if (useDialogStore.getState().request === request) useDialogStore.getState().close(null);
            else request.resolve(null); // a newer dialog owns the visible UI
          };
          controller.signal.addEventListener("abort", closeOwnConfirmation, { once: true });
          try {
            if (!isCurrent()) closeOwnConfirmation();
            const confirmed = await confirmation;
            return isCurrent() && confirmed;
          } finally {
            controller.signal.removeEventListener("abort", closeOwnConfirmation);
          }
        },
        onStep: (step) => {
          if (isCurrent()) set((s) => ({ steps: [...s.steps, step] }));
        },
      });
      if (!isCurrent()) return;
      set({
        answer: result.answer,
        stoppedAtLimit: result.stoppedAtLimit,
        running: false,
      });
    } catch (err) {
      if (isCurrent()) set({ error: String(err), running: false });
    } finally {
      // A cancelled run can settle after a newer run has acquired ownership.
      if (abortController === controller) abortController = null;
    }
  },

  cancel() {
    abortController?.abort();
    abortController = null;
    set({ running: false });
  },

  reset() {
    abortController?.abort();
    abortController = null;
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

useVaultStore.subscribe((state, previous) => {
  if (state.vaultToken !== previous.vaultToken || state.currentVault?.path !== previous.currentVault?.path ||
      (state.isOpeningVault && !previous.isOpeningVault)) {
    useAgentStore.getState().reset();
  }
});
