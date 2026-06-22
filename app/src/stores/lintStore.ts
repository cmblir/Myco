// Lint run state, lifted out of PageProvenance so a running lint survives
// navigating to other pages (same pattern as ingestStore). The Topbar shows
// a chip while it runs and after it finishes until the user revisits the
// Provenance page.

import { create } from "zustand";
import { complete } from "../lib/chat";
import { useVaultStore } from "./vaultStore";

const LINT_PROMPT = `Run the wiki lint checklist from CLAUDE.md against the current vault:

Structure: frontmatter present, type field valid, status superseded → superseded_by exists, status disputed → ## Disputed section present.

Citation: inline [^src-*] citations on factual claims, source_count matches actual citations, dangling [^src-*] references, definitions of src-* point to existing source-summary pages.

Connection: orphan pages (no [[wikilinks]] pointing in), missing cross-references for entities/concepts mentioned but not linked, body mentions of concepts that don't have their own page.

Freshness: status: active pages with last_updated > 30 days, source_count: 1 pages making general claims ("대체로", "일반적으로", "in general"), confidence: high pages with source_count < 2.

Output as a Markdown report (sections Critical/Warning/Info) with concrete file paths and one-line fix suggestions. Do not modify files.`;

export type LintStage = "idle" | "running" | "done" | "error";

interface LintState {
  stage: LintStage;
  report: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** false after a run finishes until the user revisits Provenance. */
  seen: boolean;
  runLint: () => Promise<void>;
  markSeen: () => void;
  dismiss: () => void;
}

export const useLintStore = create<LintState>((set, get) => ({
  stage: "idle",
  report: null,
  startedAt: null,
  finishedAt: null,
  seen: true,

  async runLint() {
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
        messages: [{ role: "user", content: LINT_PROMPT }],
      });
      set({
        stage: "done",
        report: out || "(no output)",
        finishedAt: Date.now(),
        seen: false,
      });
    } catch (err) {
      set({
        stage: "error",
        report: `ERROR: ${String(err)}`,
        finishedAt: Date.now(),
        seen: false,
      });
    }
  },

  markSeen: () => set({ seen: true }),

  dismiss: () =>
    set({
      stage: "idle",
      report: null,
      startedAt: null,
      finishedAt: null,
      seen: true,
    }),
}));
