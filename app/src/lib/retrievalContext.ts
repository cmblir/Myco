import type { ScoredChunk } from "./ipc";

/** A path citation stays unambiguous when several notes share a filename. */
export function chunkCitation(hit: Pick<ScoredChunk, "page" | "stem">): string {
  const target = hit.page.replace(/\.md$/i, "").replace(/[[\]|\r\n]/g, "");
  const label = hit.stem.replace(/[[\]|\r\n]/g, "");
  return `[[${target}|${label}]]`;
}

/** Fit ranked source passages into a strict character budget. Give each
 * distinct source a first chance before spending the tail on repeated chunks. */
export function buildRetrievalContext(
  hits: ScoredChunk[],
  budget: number,
): { ctx: string; stems: string[] } {
  if (!Number.isFinite(budget) || budget <= 0) return { ctx: "", stems: [] };
  const limit = Math.floor(budget);
  const first: ScoredChunk[] = [];
  const rest: ScoredChunk[] = [];
  const pages = new Set<string>();
  for (const hit of hits) {
    if (!hit.text.trim()) continue;
    if (pages.has(hit.page)) rest.push(hit);
    else {
      pages.add(hit.page);
      first.push(hit);
    }
  }
  const allowance = Math.max(
    0,
    Math.floor(limit / Math.min(first.length || 1, 4)),
  );
  const parts: string[] = [];
  const stems: string[] = [];
  let used = 0;
  for (const hit of [...first, ...rest]) {
    const sep = parts.length ? "\n\n" : "";
    const header = `===== ${chunkCitation(hit)} =====\nsource_path: ${hit.page}\nsection: ${hit.section}\n`;
    const room = Math.min(limit - used - sep.length, allowance);
    if (room <= header.length + 1) continue;
    const textRoom = room - header.length;
    const passage =
      hit.text.length <= textRoom
        ? hit.text
        : `${hit.text.slice(0, textRoom - 1).trimEnd()}…`;
    const block = `${sep}${header}${passage}`;
    parts.push(block);
    used += block.length;
    if (!stems.includes(hit.stem)) stems.push(hit.stem);
  }
  return { ctx: parts.join(""), stems };
}
