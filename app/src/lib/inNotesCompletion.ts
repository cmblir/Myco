// `[[` section 2, "In notes" (roadmap stage 1): what the notes say, not only
// their names — Ask's retrieval, judged by the similarity floor, from 3
// characters. Applies `[[stem#Section]]`; the chunk shows beside the list.
// Kept out of Editor.tsx so vitest (node) can drive it with a fake query.

import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSection,
} from "@codemirror/autocomplete";
import { retrieveChunks } from "./chat";
import { wikilinkQueryAt } from "./editorCompletions";
import { linkApply } from "./editorFormat";
import { recallExcerpt, recallTarget } from "./editorRecall";
import type { Strings } from "./i18n";

/** `[[` typing pauses this long before "In notes" searches (each search
 *  embeds the query). */
export const IN_NOTES_DEBOUNCE_MS = 160;

/** The completion source: one search once typing pauses, never two at a
 *  time. Unsectioned file names sort above it. */
export function noteContentCompletion(
  t: Strings,
  retrieve: typeof retrieveChunks = retrieveChunks,
  wait = IN_NOTES_DEBOUNCE_MS,
) {
  const section: CompletionSection = { name: t.sl_in_notes ?? "In notes" };
  let inFlight: Promise<unknown> | null = null;
  return async (
    context: CompletionContext,
  ): Promise<CompletionResult | null> => {
    const line = context.state.doc.lineAt(context.pos);
    const m = wikilinkQueryAt(line.text.slice(0, context.pos - line.from));
    if (!m || m.note !== null || m.query.trim().length < 3) return null;
    // A debounce: a key typed before the pause aborts this query. By default
    // CodeMirror keeps a running query alive across typing, which made the
    // wait a throttle (one search per pause-length of typing).
    context.addEventListener("abort", () => undefined, { onDocChange: true });
    await new Promise((r) => setTimeout(r, wait));
    if (context.aborted) return null;
    // A search still running (an older prefix) finishes first.
    if (inFlight) await inFlight.catch(() => null);
    if (context.aborted) return null;
    const search = retrieve(m.query, 8);
    inFlight = search;
    const found = await search.catch(() => null);
    if (inFlight === search) inFlight = null;
    if (!found || context.aborted) return null;
    const seen = new Set<string>();
    const options: Completion[] = [];
    for (const h of found.hits) {
      const target = recallTarget(h);
      if (seen.has(target)) continue;
      seen.add(target);
      options.push({
        // CodeMirror puts an unfiltered result above every filtered one, so
        // these are filtered — against the query itself, which each matches
        // exactly — and the section drops them below the file names.
        label: m.query,
        displayLabel: target,
        detail:
          h.similarity == null
            ? t.q_cite_sim_none
            : `${Math.round(h.similarity * 100)}%`,
        info: recallExcerpt(h, m.query) || undefined,
        section,
        type: "text",
        apply: linkApply(`${target}]]`),
      });
    }
    return options.length ? { from: line.from + m.from, options } : null;
  };
}
