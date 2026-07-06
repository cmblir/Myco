// Reflect run state (FEAT-06). "Reflect" is a read-only LLM pass that proposes
// concrete wiki improvements (orphans to link, stale pages, missing
// cross-references). Lifted into a store — like lintStore — so a run survives
// navigating between pages, and so the scheduler (autoReflect.ts) and any
// manual trigger share one source of truth.
//
// Unlike lint, reflect never streams: it uses the blocking complete({task:
// "query", …}) path, which works with any provider, and parses the model's
// bulleted output into a list of suggestions. It NEVER modifies files.

import { create } from "zustand";
import { complete } from "../lib/chat";
import { useVaultStore } from "./vaultStore";

const REFLECT_PROMPT = `You are reviewing a personal knowledge wiki (markdown files in the current directory). Read the vault and propose concrete, actionable improvements.

Focus on:
- Orphan pages that no other page links to (suggest which existing pages should link to them).
- Stale pages (status: active but not updated recently) worth revisiting.
- Missing cross-references: concepts/entities mentioned in prose that have their own page but aren't linked with [[wikilinks]].

Output a SHORT bulleted list (one "- " item per line, at most 8 items). Each item names a specific file and a one-line action. This is read-only analysis — do NOT create, edit, or delete any files.`;

export type ReflectStage = "idle" | "running" | "done" | "error";

interface ReflectState {
  stage: ReflectStage;
  /** Parsed bullet items from the last successful run. */
  suggestions: string[];
  /** Raw model output (or an error message when stage === "error"). */
  report: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** false after a run finishes until the user acknowledges the panel. */
  seen: boolean;
  runReflect: () => Promise<void>;
  markSeen: () => void;
  dismiss: () => void;
}

export const useReflectStore = create<ReflectState>((set, get) => ({
  stage: "idle",
  suggestions: [],
  report: null,
  startedAt: null,
  finishedAt: null,
  seen: true,

  async runReflect() {
    const vault = useVaultStore.getState().currentVault;
    if (!vault || get().stage === "running") return;
    set({
      stage: "running",
      report: null,
      startedAt: Date.now(),
      finishedAt: null,
      seen: true,
    });
    try {
      const out = await complete({
        task: "query",
        cwd: vault.path,
        messages: [{ role: "user", content: REFLECT_PROMPT }],
      });
      set({
        stage: "done",
        report: out || "(no output)",
        suggestions: parseSuggestions(out),
        finishedAt: Date.now(),
        seen: false,
      });
    } catch (err) {
      set({
        stage: "error",
        report: `ERROR: ${String(err)}`,
        suggestions: [],
        finishedAt: Date.now(),
        seen: false,
      });
    }
  },

  markSeen: () => set({ seen: true }),

  dismiss: () =>
    set({
      stage: "idle",
      suggestions: [],
      report: null,
      startedAt: null,
      finishedAt: null,
      seen: true,
    }),
}));

// Extract bullet items from the model's markdown. Accepts "-", "*", "•" and
// numbered ("1.", "1)") markers; falls back to non-empty lines if nothing
// matched so a run never silently yields an empty list from valid prose.
export function parseSuggestions(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const bullets = lines
    .map((l) => {
      const m = l.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
      return m ? m[1].trim() : null;
    })
    .filter((l): l is string => !!l);
  if (bullets.length > 0) return bullets;
  return lines.map((l) => l.trim()).filter((l) => l.length > 0);
}
