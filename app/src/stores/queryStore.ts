// Ask chat state, lifted out of PageQuery so an in-flight answer survives
// navigating to other pages (same pattern as lintStore/ingestStore). The
// Topbar shows a chip while an answer runs and after it finishes until the
// user revisits the Query page.

import { create } from "zustand";
import { complete, retrieveChunks, type AskStage } from "../lib/chat";
import { formatExtractiveAnswer } from "../lib/extractive";
import { ipc } from "../lib/ipc";
import {
  formatActivityAnswer,
  formatRecentFilesAnswer,
  isActivityQuery,
} from "../lib/queryIntent";
import { BUILTIN_EMBED_MODEL } from "../lib/providers";
import { log } from "../lib/log";

/** Mirrors `intent::VAULT_FILES` on the Rust side. */
const VAULT_FILES_INTENT = "vault-files";
import type { Lang } from "../lib/i18n";
import { useVaultStore } from "./vaultStore";

export interface ChatTurn {
  q: string;
  a: string;
  error?: string;
  /// The embedding index predated a bundled embed-model swap, so this answer
  /// used the whole-vault fallback instead of semantic retrieval — surfaced
  /// so the fallback stays visible instead of a silent quality drop.
  stale?: boolean;
  /// An IPC call inside retrieval (embeddings_status/semantic_search)
  /// actually rejected, so this answer used the whole-vault fallback instead
  /// — distinct from a legitimately empty index/hit list, which is not a
  /// failure and must not set this.
  retrievalFailed?: boolean;
  /// Answer is retrieved passages rendered verbatim (builtin-local path) —
  /// no model synthesis. For a synthesized answer the user picks an AI
  /// provider under Model settings.
  extractive?: boolean;
  /// Extractive turn that produced no passages (stale index, retrieval
  /// failure, or a legitimately empty hit list) — suppresses the "From your
  /// notes" label, since there is nothing to attribute to the notes.
  extractiveEmpty?: boolean;
}

export const SYSTEM_PREAMBLE = `You are myco, the wiki maintainer for the user's local markdown vault.
The current working directory is the vault root. Use Read/Grep/Glob tools to
look up answers from the wiki (\`wiki/\` if it exists) before reaching for
\`raw/\` sources. Answer in the user's language. When you state a fact that
comes from a vault file, cite it inline as [[page-stem]].`;

/** Localized copy ask() bakes into turns. Passed per call from the page's `t`
 * so the store itself stays i18n-free (stores outlive language switches). */
export interface AskCopy {
  extractiveStale: string;
  extractiveFailed: string;
  extractiveEmpty: string;
  emptyResponse: string;
}

interface QueryState {
  turns: ChatTurn[];
  busy: boolean;
  stage: AskStage | null;
  startedAt: number | null;
  /** false after an answer lands until the user revisits the Query page. */
  seen: boolean;
  ask: (question: string, lang: Lang, copy: AskCopy) => Promise<void>;
  markSeen: () => void;
  clear: () => void;
}

/** The answer for a question whose intent is NOT page content, or `null` when
 * the question is an ordinary content question after all (so the caller shows
 * its "nothing found" copy). Never throws: a classification or mtime failure
 * just means no meta answer, which the caller already handles. */
async function metaAnswer(
  question: string,
  vaultPath: string,
  lang: Lang,
): Promise<string | null> {
  try {
    const verdict = await ipc.classifyIntent(
      question,
      "builtin-local",
      BUILTIN_EMBED_MODEL,
    );
    if (verdict?.intent !== VAULT_FILES_INTENT) return null;
    const entries = await ipc.fileMtimes(vaultPath);
    return formatRecentFilesAnswer(entries, lang);
  } catch (err) {
    log.warn("query.intent_classify_failed", { error: String(err) });
    return null;
  }
}

export const useQueryStore = create<QueryState>((set, get) => ({
  turns: [],
  busy: false,
  stage: null,
  startedAt: null,
  seen: true,

  async ask(question, lang, copy) {
    const vault = useVaultStore.getState().currentVault;
    if (!question.trim() || !vault || get().busy) return;
    const finishTurn = (patch: Partial<ChatTurn>) =>
      set((s) => ({
        turns: s.turns.map((turn, i) =>
          i === s.turns.length - 1 ? { ...turn, ...patch } : turn,
        ),
        seen: false,
      }));
    set((s) => ({
      turns: [...s.turns, { q: question, a: "" }],
      busy: true,
      startedAt: Date.now(),
      seen: true,
    }));

    // "What did I do recently / what changed" is a git-history question, not a
    // wiki-content one — answering it from git_log is factual, whereas sending
    // it to a model made it confabulate. Route it directly.
    if (isActivityQuery(question)) {
      try {
        const commits = await ipc.gitLog(vault.path, 20).catch(() => []);
        finishTurn({ a: formatActivityAnswer(commits, lang) });
      } finally {
        set({ busy: false });
      }
      return;
    }

    // Read the provider at call time via IPC rather than settingsStore, so an
    // ask fired before the store hydrates still routes correctly.
    const provider = await ipc
      .getSettings()
      .then((s) => s.query_provider)
      .catch(() => "");

    // builtin-local: extractive answer. Retrieval is the measured strength of
    // this stack; a small model paraphrasing on top of it produced echo loops
    // (the reported bug), so render what retrieval found verbatim.
    if (provider === "builtin-local") {
      try {
        // The stage is reported through retrieveChunks' callback, which fires
        // only once an index is known to exist. Setting it before the call
        // claimed "searching the wiki…" on a vault with NO index — a wait that
        // describes work not happening, which is the thing ask-stages-smoke
        // exists to catch.
        const r = await retrieveChunks(question, 12, () =>
          set({ stage: { kind: "retrieving" } }),
        );
        const md = formatExtractiveAnswer(r.hits);
        // Pick the body by state: a stale/failed index means retrieval never
        // ran, so those get their own honest copy instead of the generic
        // "found nothing" message (which implies retrieval ran and came up
        // empty).
        // Retrieval found nothing relevant, and the index is healthy — so this
        // may be a question page CONTENT cannot answer at all ("which notes did
        // I add today"). Classifying costs a query embedding, which is why it
        // happens HERE and not up front: a question the vault could answer never
        // pays for it.
        if (!md && !r.stale && !r.retrievalFailed) {
          const meta = await metaAnswer(question, vault.path, lang);
          if (meta) {
            finishTurn({ a: meta });
            return;
          }
        }
        const body = r.stale
          ? copy.extractiveStale
          : r.retrievalFailed
            ? copy.extractiveFailed
            : md || copy.extractiveEmpty;
        finishTurn({
          a: body,
          extractive: true,
          extractiveEmpty: !md,
          stale: r.stale,
          retrievalFailed: r.retrievalFailed,
        });
      } catch (err) {
        finishTurn({ a: "", error: String(err) });
      } finally {
        set({ busy: false, stage: null });
      }
      return;
    }

    // Set from the `thinking` stage if the index turned out stale or
    // retrieval itself failed — read once the run finishes, since the
    // `finally` clears the live stage.
    let stale = false;
    let retrievalFailed = false;
    try {
      const content = await complete({
        task: "query",
        cwd: vault.path,
        onStage: (s) => {
          set({ stage: s });
          if (s.kind === "thinking" && s.stale) stale = true;
          if (s.kind === "thinking" && s.retrievalFailed) retrievalFailed = true;
        },
        messages: [
          { role: "system", content: SYSTEM_PREAMBLE },
          // Skip turns that errored or have no answer — replaying an empty
          // assistant message makes providers (e.g. Anthropic) reject the
          // request with a 400 on the next question.
          ...get()
            .turns.slice(0, -1)
            .filter((p) => p.a && !p.error)
            .flatMap((p) => [
              { role: "user" as const, content: p.q },
              { role: "assistant" as const, content: p.a },
            ]),
          { role: "user", content: question },
        ],
      });
      finishTurn({ a: content || copy.emptyResponse, stale, retrievalFailed });
    } catch (err) {
      finishTurn({ a: "", error: String(err) });
    } finally {
      // A finished run must not leave its label or its pages behind for the
      // next one.
      set({ busy: false, stage: null });
    }
  },

  markSeen: () => set({ seen: true }),

  clear: () => set({ turns: [], busy: false, stage: null, startedAt: null, seen: true }),
}));
