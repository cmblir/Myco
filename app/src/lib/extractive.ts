// Extractive Ask answer (builtin-local provider): render what retrieval found
// instead of asking the 1B model to paraphrase it. Retrieval is the measured
// strength of the stack (hit@1 82.3%, src-tauri/eval/BASELINE.md); 1B
// synthesis on top of it only added echo loops and confabulation. Pure
// function — all IO stays with the caller.

import type { ScoredChunk } from "./ipc";

export interface ExtractiveOptions {
  /** Max distinct pages to render (rank order). */
  maxPages?: number;
  /** Max quoted characters per page; excess is cut at the limit with "…". */
  perPageChars?: number;
}

export function formatExtractiveAnswer(
  hits: ScoredChunk[],
  opts: ExtractiveOptions = {},
): string {
  const maxPages = opts.maxPages ?? 5;
  const perPageChars = opts.perPageChars ?? 700;

  // Group by page, preserving the ranked order of first appearance.
  const order: string[] = [];
  const byPage = new Map<string, { stem: string; texts: string[] }>();
  for (const h of hits) {
    if (!h.text) continue;
    let entry = byPage.get(h.page);
    if (!entry) {
      if (order.length >= maxPages) continue;
      entry = { stem: h.stem, texts: [] };
      byPage.set(h.page, entry);
      order.push(h.page);
    }
    entry.texts.push(h.text);
  }

  const sections: string[] = [];
  for (const page of order) {
    const { stem, texts } = byPage.get(page)!;
    let body = texts.join("\n\n");
    if (body.length > perPageChars) {
      body = `${body.slice(0, perPageChars).trimEnd()}…`;
    }
    const quoted = body
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    sections.push(`**[[${stem}]]**\n\n${quoted}`);
  }
  return sections.join("\n\n");
}
