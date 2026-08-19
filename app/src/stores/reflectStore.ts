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
import { complete, getActiveModel } from "../lib/chat";
import { flattenMarkdown, isNonKnowledgePath } from "../lib/graphData";
import { isMalformedLinkName } from "../lib/graphGaps";
import { STRINGS } from "../lib/i18n";
import { ipc } from "../lib/ipc";
import { mmrSelect } from "../lib/sessionDigest";
import { useUIStore } from "./uiStore";
import { useVaultStore } from "./vaultStore";

// Extractive findings are OUR prose, not a model's, so they follow the UI
// language — read off uiStore directly, the ingestStore idiom for store-side
// user-facing text.
function t(): (typeof STRINGS)["en"] {
  return STRINGS[useUIStore.getState().lang] ?? STRINGS.en;
}

const REFLECT_PROMPT = `You are reviewing a personal knowledge wiki (markdown files in the current directory). Read the vault and propose concrete, actionable improvements.

Focus on:
- Orphan pages that no other page links to (suggest which existing pages should link to them).
- Stale pages (status: active but not updated recently) worth revisiting.
- Missing cross-references: concepts/entities mentioned in prose that have their own page but aren't linked with [[wikilinks]].

Output a SHORT bulleted list (one "- " item per line, at most 8 items). Each item names a specific file and a one-line action. This is read-only analysis — do NOT create, edit, or delete any files.`;

export type ReflectStage = "idle" | "running" | "done" | "error";

interface ReflectState {
  stage: ReflectStage;
  /** How the last run produced its suggestions: an LLM pass, or (builtin-local,
   *  which has no generative model) mechanical link-graph facts — see
   *  extractiveReflect. The panel labels extractive results so quoted facts
   *  are never mistaken for model judgment. */
  mode: "llm" | "extractive";
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
  mode: "llm",
  suggestions: [],
  report: null,
  startedAt: null,
  finishedAt: null,
  seen: true,

  async runReflect() {
    const vault = useVaultStore.getState().currentVault;
    if (!vault || get().stage === "running") return;
    // builtin-local has no chat model to generate with (see chat.ts's
    // CHAT_MODEL_MISSING) — it used to flip the panel into "blocked" here.
    // It now reflects extractively instead (same move as sessionDigest's
    // extractive digest): the link graph already knows the mechanical
    // findings, no generation needed.
    const { provider } = await getActiveModel("query");
    const extractive = provider === "builtin-local";
    set({
      stage: "running",
      mode: extractive ? "extractive" : "llm",
      report: null,
      startedAt: Date.now(),
      finishedAt: null,
      seen: true,
    });
    try {
      let out: string;
      let suggestions: string[];
      if (extractive) {
        suggestions = await extractiveReflect(vault.path);
        out = suggestions.join("\n");
      } else {
        out = await complete({
          task: "query",
          cwd: vault.path,
          messages: [{ role: "user", content: REFLECT_PROMPT }],
        });
        suggestions = parseSuggestions(out);
      }
      set({
        stage: "done",
        report: out || "(no output)",
        suggestions,
        finishedAt: Date.now(),
        seen: false,
      });
    } catch (err) {
      set({
        stage: "error",
        // err is an Error thrown by complete()/the provider — String(err) on an
        // Error already yields "Error: <message>", so prefixing another "ERROR:"
        // doubled it. Use the bare message instead.
        report: err instanceof Error ? err.message : String(err),
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
      mode: "llm",
      suggestions: [],
      report: null,
      startedAt: null,
      finishedAt: null,
      seen: true,
    }),
}));

// Matches REFLECT_PROMPT's "at most 8 items".
const MAX_SUGGESTIONS = 8;

// Root-ish stems nothing is expected to link TO — flagging them as orphans
// would be the same noise on every run.
const ORPHAN_EXEMPT = new Set(["index", "home", "readme"]);

/** Extractive reflect for builtin-local (no generative model): the
 * REFLECT_PROMPT findings that are mechanical facts of the link graph —
 * orphan pages and unresolved [[wikilinks]] — read from ipc.buildLinkGraph.
 * Staleness and prose-mention cross-references need judgment over page
 * content, so they are honestly out of scope here. When the graph yields
 * more than MAX_SUGGESTIONS candidates, the bundled embedder plus
 * centroid+MMR (mmrSelect, shared with the session digest) picks a diverse
 * top 8 — deterministic given the same vault, like the extractive digest.
 *
 * Two things the first version got wrong, both measured on the real vault
 * (180 .md → 19 candidates, only ONE of them actionable):
 *
 *  - It read orphan candidacy off `graph.forward`'s KEYS. Rust only records a
 *    key for a page with at least one RESOLVED outgoing link, so the pages
 *    with no links at all — the most orphaned pages there are, 81 of them —
 *    were the ones it could never see. Candidacy now comes from the vault's
 *    markdown files (flattenMarkdown, the same source the graph view uses for
 *    orphan nodes), unioned with the graph keys in case the tree isn't loaded.
 *  - It applied no knowledge filter, so ingest-reports/, daily/ (five
 *    identical `[[TASK_DONE]]` ghosts) and wiki/log.md crowded out the real
 *    findings — 12 of the 19. isNonKnowledgePath is the graph view's own
 *    filter for exactly this, imported rather than restated. */
export async function extractiveReflect(vaultPath: string): Promise<string[]> {
  const graph = await ipc.buildLinkGraph(vaultPath);
  const rel = (p: string): string =>
    p.startsWith(`${vaultPath}/`) ? p.slice(vaultPath.length + 1) : p;
  const pages = new Set([
    ...flattenMarkdown(useVaultStore.getState().fileTree),
    ...Object.keys(graph.forward),
  ]);
  const candidates: string[] = [];
  for (const page of [...pages].sort()) {
    if (isNonKnowledgePath(vaultPath, page)) continue;
    const stem = (page.split("/").pop() ?? page).replace(/\.md$/i, "").toLowerCase();
    if (ORPHAN_EXEMPT.has(stem)) continue;
    if ((graph.backward[page] ?? []).length === 0) {
      candidates.push(t().rf_item_orphan.replace("{page}", rel(page)));
    }
  }
  for (const page of Object.keys(graph.unresolved).sort()) {
    if (isNonKnowledgePath(vaultPath, page)) continue;
    for (const target of [...graph.unresolved[page]].sort()) {
      // A template placeholder ("source-<slug>") or dots-only name is not a
      // page anyone can create — the gap panel already buckets those away
      // from real missing pages, and reflect must not offer them either.
      if (isMalformedLinkName(target)) continue;
      candidates.push(
        t()
          .rf_item_unresolved.replace("{page}", rel(page))
          .replace("{target}", target),
      );
    }
  }
  if (candidates.length <= MAX_SUGGESTIONS) return candidates;
  const vectors = await ipc.embedLocalTexts(candidates);
  return mmrSelect(vectors, MAX_SUGGESTIONS).map((i) => candidates[i]);
}

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
