import type { RelatedContext, ScoredChunk } from "./ipc";

/** A path citation stays unambiguous when several notes share a filename. */
export function chunkCitation(hit: Pick<ScoredChunk, "page" | "stem">): string {
  const target = hit.page.replace(/\.md$/i, "").replace(/[[\]|\r\n]/g, "");
  const label = hit.stem.replace(/[[\]|\r\n]/g, "");
  return `[[${target}|${label}]]`;
}

/** A transcript turn time in the viewer's local zone with an explicit offset
 * (e.g. 2026-10-08T00:23:22+09:00). UTC "Z" text put late-night turns on the
 * previous calendar day, and models copied that date into answers. */
export function localMessageTime(seconds: number): string {
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(seconds) || Number.isNaN(date.getTime())) return "unknown";
  const pad = (n: number) => String(n).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

/** Fit ranked source passages into a strict character budget. Give each
 * distinct source a first chance before spending the tail on repeated chunks. */
export function buildRetrievalContext(
  hits: ScoredChunk[],
  budget: number,
  related?: RelatedContext,
): { ctx: string; stems: string[] } {
  if (!Number.isFinite(budget) || budget <= 0) return { ctx: "", stems: [] };
  if (related?.passages.length) {
    const anchorKeys = new Set(hits.map(h => `${h.page}#${h.section}`));
    const passages = related.passages.filter(p => anchorKeys.has(`${p.anchor_page}#${p.anchor_section}`));
    const limit = Math.floor(budget);
    const base = buildRetrievalContext(hits, Math.floor(limit * 0.4));
    const notice = `\n\nRelated source context (bounded, partial selection${related.incomplete ? "; retrieval also omitted passages" : ""}; omitted passages may change the conclusion). These are recorded statements, not independently verified completion.\n`;
    let ctx = base.ctx;
    const stems = [...base.stems];
    if (ctx.length + notice.length <= limit) ctx += notice;
    const selected: { block: string; timestamp: number; stem: string; order: number }[] = [];
    let used = ctx.length;
    for (const [order, p] of passages.entries()) {
      const block = `\n===== ${chunkCitation(p)} =====\nsource_path: ${p.page}\nsection: ${p.section}\nsource_revision: ${p.source_revision}\nspeaker: ${p.role}\nmessage_id: ${p.message_id}\nmessage_time: ${localMessageTime(p.timestamp)}\nrelation: ${p.relation}; anchor: ${p.anchor_page}#${p.anchor_section}\n${p.text}\n`;
      // Keep complete passages: truncation can remove a correction or qualifier.
      if (used + block.length > limit) continue;
      used += block.length;
      selected.push({ block, timestamp: p.timestamp, stem: p.stem, order });
    }
    // Select by retrieval priority BEFORE ordering: chronological presentation
    // must not spend a tight budget on old plans at the expense of corrections.
    // Unknown times retain their relative order, ahead of dated statements;
    // never substitute file modification/capture time for a message timestamp.
    selected.sort((a, b) => {
      const at = Number.isFinite(a.timestamp) ? a.timestamp : -Infinity;
      const bt = Number.isFinite(b.timestamp) ? b.timestamp : -Infinity;
      return (at === bt ? 0 : at < bt ? -1 : 1) || a.order - b.order;
    });
    for (const p of selected) {
      ctx += p.block;
      if (!stems.includes(p.stem)) stems.push(p.stem);
    }
    return { ctx, stems };
  }
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
