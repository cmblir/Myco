// Lint run state, lifted out of PageProvenance so a running lint survives
// navigating to other pages (same pattern as ingestStore). The Topbar shows
// a chip while it runs and after it finishes until the user revisits the
// Provenance page.
//
// Stage 7: when the provider is the Claude CLI the run STREAMS — `progress`
// accumulates claude-stream text/tool events live so Provenance can show the
// report growing instead of a bare spinner. Other providers keep the blocking
// complete() path (the stream events are Claude-CLI-specific).

import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { complete } from "../lib/chat";
import { ipc, type ClaudeStreamPayload } from "../lib/ipc";
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
  /** Live output while a streaming run is in flight (Claude CLI only). */
  progress: string;
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
  progress: "",
  startedAt: null,
  finishedAt: null,
  seen: true,

  async runLint() {
    const vault = useVaultStore.getState().currentVault;
    if (!vault || get().stage === "running") return;
    set({
      stage: "running",
      report: null,
      progress: "",
      startedAt: Date.now(),
      finishedAt: null,
      seen: true,
    });
    try {
      const settings = await ipc.getSettings();
      const out =
        settings.query_provider === "anthropic-cli"
          ? await runStreaming(vault.path, settings.query_model, (chunk) =>
              set((s) => ({ progress: s.progress + chunk })),
            )
          : await complete({
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
      progress: "",
      startedAt: null,
      finishedAt: null,
      seen: true,
    }),
}));

// Streamed Claude CLI run: subscribe to claude-stream for the duration of this
// run only (unlistened in finally — same lifecycle rule as ingestStore's
// listener), append text chunks via onChunk, and return the final report.
// Falls back to the accumulated stream text if the CLI prints nothing after
// the result event.
async function runStreaming(
  cwd: string,
  model: string,
  onChunk: (text: string) => void,
): Promise<string> {
  const runId = crypto.randomUUID();
  let streamed = "";
  const unlisten = await listen<ClaudeStreamPayload>("claude-stream", (e) => {
    if (e.payload.run_id !== runId) return;
    if (e.payload.kind === "text" && e.payload.text) {
      streamed += e.payload.text;
      onChunk(e.payload.text);
    } else if (e.payload.kind === "tool" && e.payload.tool) {
      onChunk(`\n[${e.payload.tool}] ${e.payload.detail ?? ""}\n`);
    }
  });
  try {
    const res = await ipc.claudeRunStream(
      runId,
      LINT_PROMPT,
      cwd,
      model || undefined,
    );
    if (res.status !== 0) {
      throw new Error(res.stderr.trim() || `claude exit ${res.status}`);
    }
    return res.stdout.trim() || streamed.trim();
  } finally {
    unlisten();
  }
}
