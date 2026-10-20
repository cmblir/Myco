// Past records into the note being written (roadmap stage 1): what `/recall`,
// `/onthisday`, the `[[` completion and the insert-at-cursor buttons put in
// the file. Only retrieved text, verbatim, with its source (decision Q8): a
// quote is quoteBody's pick of the chunk's own lines, never a summary. Pure
// (vitest, node); the pickers, the editor and the reader dispatch these.

import { isolateHistory } from "@codemirror/commands";
import { ensureSyntaxTree, language } from "@codemirror/language";
import {
  StateEffect,
  type EditorState,
  type Transaction,
} from "@codemirror/state";
import { retrieveChunks } from "./chat";
import { DAILY_RE } from "./dailyNote";
import { blockUnit } from "./editorBlockOps";
import {
  ancestors,
  fmEnd,
  hasText,
  inCode,
  inFrontmatter,
  prefixEnd,
} from "./editorMarks";
import { fenceAfter, groupByPage, quoteBody } from "./extractive";
import type { Lang } from "./i18n";
import type { AskScope, NearMiss, ScoredChunk } from "./ipc";
import { chunkBody, recallExcerpt, recallTarget } from "./recallText";
import { parseTimeQuery, type DateRange } from "./timeQuery";

// The quote's text lives in recallText (no CodeMirror, for the Ask page).
export {
  chunkSection,
  noteHeadings,
  quoteBlock,
  recallExcerpt,
  recallTarget,
} from "./recallText";

/** Whether insertion succeeded: the editor shows retry advice on `false`. */
export const blockInsertionResult = StateEffect.define<boolean>();

/** The dispatchable edit: one undo step, the caret at the insert's end. */
function insertTr(
  state: EditorState,
  from: number,
  to: number,
  insert: string,
  anchor: number,
): Transaction {
  return state.update({
    changes: { from, to, insert },
    selection: { anchor },
    scrollIntoView: true,
    userEvent: "input.complete",
    effects: blockInsertionResult.of(true),
    annotations: isolateHistory.of("full"),
  });
}

/** `block` as a block of its own at `pos`: in that line's place when it is
 *  empty — nothing past its marks, so an empty bullet or heading becomes the
 *  block (Notion) — else below the block the line belongs to (a whole fence
 *  or list item), kept a blank line away from the text around it. Never in
 *  frontmatter, and never inside a quote or a top-level list item: it goes
 *  below the whole of it. If parsing stays busy, keeps the text and caret
 *  unchanged and emits retry advice. */
export function insertBlockTr(
  state: EditorState,
  pos: number,
  block: string,
): Transaction {
  const { doc } = state;
  // A timed-out lookup can miss the outer container while a later one
  // finds its child. Complete one tree before reading any boundaries;
  // keep large notes responsive and ask for a retry if parsing stays busy.
  if (
    state.facet(language) &&
    !ensureSyntaxTree(state, doc.length, 50) &&
    !ensureSyntaxTree(state, doc.length, 50)
  )
    return state.update({ effects: blockInsertionResult.of(false) });
  const at = inFrontmatter(state, pos) ? Math.min(fmEnd(state), doc.length) : pos;
  const line = doc.lineAt(at);
  const textAt = (n: number): boolean =>
    n >= 1 && n <= doc.lines && hasText(doc.line(n).text);
  // At column 0 inside a quote (a callout) or a nested list, the block would
  // end that container, and its lines after the block would leave it.
  const outer = ancestors(state, line.to)
    .filter((n) => n.name === "Blockquote" || n.name === "ListItem")
    .pop();
  const outerEnd = outer ? doc.lineAt(outer.to).to : line.to;
  if (
    outerEnd === line.to &&
    !hasText(doc.sliceString(prefixEnd(state, line), line.to)) &&
    !inCode(state, at)
  ) {
    const above = textAt(line.number - 1) ? "\n" : "";
    const below = textAt(line.number + 1) ? "\n" : "";
    return insertTr(
      state,
      line.from,
      line.to,
      above + block + below,
      line.from + above.length + block.length,
    );
  }
  const unit = blockUnit(state, at);
  const end = Math.max(unit ? doc.line(unit.last).to : line.to, outerEnd);
  const below = textAt(doc.lineAt(end).number + 1) ? "\n" : "";
  return insertTr(state, end, end, "\n\n" + block + below, end + 2 + block.length);
}

/** `text` (a `[[link]]`) at the caret, replacing a selection, spaced off the
 *  words beside it. In frontmatter it goes to the body as its own block. */
export function insertInlineTr(state: EditorState, text: string): Transaction {
  const { from, to } = state.selection.main;
  if (inFrontmatter(state, from)) return insertBlockTr(state, from, text);
  const word = (c: string): boolean => c !== "" && !/\s/.test(c);
  const insert =
    (word(state.sliceDoc(from - 1, from)) ? " " : "") +
    text +
    (word(state.sliceDoc(to, to + 1)) ? " " : "");
  return insertTr(state, from, to, insert, from + insert.length);
}

/** `doc` with `block` as its last block — Preview has no caret. */
export function appendBlock(doc: string, block: string): string {
  const gap =
    doc === "" || doc.endsWith("\n\n") ? "" : doc.endsWith("\n") ? "\n" : "\n\n";
  return doc + gap + block + "\n";
}

/** Stems of past years' daily notes for `now`'s month-day, newest first:
 *  `daily/YYYY-MM-DD.md` and the archived ones under `daily/archive/`. File
 *  names only, so archived days count too (decision Q7). */
export function onThisDay(
  paths: readonly string[],
  root: string,
  now: Date,
): string[] {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const md = `${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  // Both sides in `/`: a Windows root keeps its `\` otherwise.
  const prefix = root.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  const out = new Set<string>();
  for (const p of paths) {
    const abs = p.replace(/\\/g, "/");
    const rel = abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
    const m = DAILY_RE.exec(rel);
    if (m && `${m[2]}-${m[3]}` === md && +m[1] < now.getFullYear())
      out.add(`${m[1]}-${md}`);
  }
  return [...out].sort().reverse();
}

/** `- [[stem]]` lines. */
export function linkList(stems: readonly string[]): string {
  return stems.map((s) => `- [[${s}]]`).join("\n");
}

export interface RecallRow {
  hit: ScoredChunk;
  /** `stem#Section` — what the quote's link and an embed point at. */
  target: string;
  /** The lines a quote of this hit carries (recallExcerpt). */
  excerpt: string;
}

/** What the `/recall` picker shows for one query. */
export type RecallView =
  | { kind: "hits"; rows: RecallRow[]; range: DateRange | null }
  /** Nothing cleared the floor: the closest rejects, shown, not insertable. */
  | { kind: "none"; near: NearMiss[]; floor: number; range: DateRange | null }
  | { kind: "stale" }
  | { kind: "failed" }
  | { kind: "no-index" };

/** Search past records the way Ask does — floor-judged by similarity, with a
 *  time phrase ("지난주") turned into a date window. */
export async function recallSearch(
  query: string,
  scope: AskScope,
  now: Date,
  lang: Lang,
  retrieve: typeof retrieveChunks = retrieveChunks,
): Promise<RecallView> {
  const { range, cleaned } = parseTimeQuery(query, now, lang);
  // A bare time phrase leaves nothing to embed: search the words as typed.
  const text = cleaned || query;
  const r = await retrieve(text, 8, undefined, range ?? undefined, scope);
  if (r.stale) return { kind: "stale" };
  if (r.retrievalFailed) return { kind: "failed" };
  // Past stale and failed, unknown pages means retrieveChunks found no index.
  if (!r.indexedPages) return { kind: "no-index" };
  const rows = r.hits.flatMap((hit) => {
    const excerpt = recallExcerpt(hit, text);
    return excerpt ? [{ hit, target: recallTarget(hit), excerpt }] : [];
  });
  return rows.length
    ? { kind: "hits", rows, range }
    : { kind: "none", near: r.nearMisses, floor: r.floor, range };
}

/** `/ask`'s answer: one `> [!question]` callout of the vault's own words
 *  (decision Q8) — the question as its title, then up to three pages, each
 *  `**[[stem#Section]]** · similarity%` (none for a lexical-only page; the
 *  bare `[[stem]]` when its hits come from more than one section) over
 *  quoteBody's pick of its hits, ≤ 400 characters. A quoted line that starts
 *  with `>` or `#` is escaped so it stays a literal line of the callout in
 *  every reader — not in code, where both are literal already. `best` is the
 *  quoted pages' best dense cosine (null when all are lexical-only). Null
 *  when no hit has a quotable line. */
export function answerBlock(
  question: string,
  hits: readonly ScoredChunk[],
): { block: string; best: number | null } | null {
  const quotable = hits.filter((h) => chunkBody(h.text));
  const pages = groupByPage(
    quotable.map((h) => ({ ...h, text: chunkBody(h.text) })),
    3,
  );
  if (!pages.length) return null;
  const lines = [`[!question] ${question}`];
  let best: number | null = null;
  pages.forEach((g, i) => {
    // `#Section` only when all the page's hits are from that section: else
    // it would credit that section with another's lines (and percentage).
    const targets = new Set(
      quotable.filter((h) => h.page === g.page).map(recallTarget),
    );
    const link = targets.size === 1 ? [...targets][0] : g.stem;
    const pct = g.best === null ? "" : ` · ${Math.round(g.best * 100)}%`;
    if (g.best !== null && (best === null || g.best > best)) best = g.best;
    if (i) lines.push("");
    // A blank line under the link: the quote opens a block of its own, not
    // lines of the link's paragraph (a table there is no table in Live, and
    // `---` would make the paragraph a setext heading).
    lines.push(`**[[${link}]]**${pct}`, "");
    let open = "";
    for (const l of quoteBody(g.texts, 400).split("\n")) {
      const next = fenceAfter(open, l);
      // 4+ spaces in is indented code or a lazy line: literal as it is.
      lines.push(open || next ? l : l.replace(/^( {0,3})([>#])/, "$1\\$2"));
      open = next;
    }
    // A chunk can end inside a fence (the index splits at a comment's `#`):
    // close it where the page ends, as a reader does at its container's end,
    // or it would run on over the next page's link.
    if (open) lines.push(open);
  });
  const block = lines.map((l) => (hasText(l) ? `> ${l}` : ">")).join("\n");
  return { block, best };
}

/** What the `/ask` picker shows for one question. */
export type AskView =
  | {
      kind: "answer";
      block: string;
      /** The quoted pages' best dense cosine (confidenceBand); null when
       *  every one came from the lexical arm. */
      best: number | null;
      range: DateRange | null;
    }
  | Exclude<RecallView, { kind: "hits" }>;

/** Ask the vault the way the Ask page does — floor-judged by similarity, a
 *  time phrase as a date window — and answer with answerBlock. */
export async function askSearch(
  question: string,
  scope: AskScope,
  now: Date,
  lang: Lang,
  retrieve: typeof retrieveChunks = retrieveChunks,
): Promise<AskView> {
  const { range, cleaned } = parseTimeQuery(question, now, lang);
  const r = await retrieve(cleaned || question, 12, undefined, range ?? undefined, scope);
  if (r.stale) return { kind: "stale" };
  if (r.retrievalFailed) return { kind: "failed" };
  if (!r.indexedPages) return { kind: "no-index" };
  const answer = answerBlock(question, r.hits);
  if (!answer) return { kind: "none", near: r.nearMisses, floor: r.floor, range };
  return { kind: "answer", ...answer, range };
}
